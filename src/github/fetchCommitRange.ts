
import {
  GitHubApiError,
  RateLimitError,
} from "./types.js";

import type {
  CommitFile,
  CommitRangeResult,
  CommitRecord,
  FetchOptions,
} from "./types.js";

const API_BASE = "https://api.github.com";
const MAX_COMPARE_COMMITS = 250;
const BATCH_SIZE = 4;
const MAX_RESPONSE_CACHE_ENTRIES = 1_000;

const responseCache = new Map<
  string,
  { expiresAt: number; data: unknown }
>();

/**
 * Extracts the repository owner and name from an HTTPS or SSH GitHub URL.
 */
export function parseRepoUrl(repoUrl: string): {
  owner: string;
  repo: string;
} {
  const normalized = repoUrl
    .trim()
    .replace(/^git@github\.com:/, "https://github.com/")
    .replace(/\.git$/, "");

  let parsed: URL;

  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error(`Invalid GitHub repo URL: "${repoUrl}"`);
  }

  if (
    !["github.com", "www.github.com"].includes(
      parsed.hostname.toLowerCase()
    )
  ) {
    throw new Error("Only github.com repository URLs are supported.");
  }

  const parts = parsed.pathname
    .replace(/^\//, "")
    .split("/")
    .filter(Boolean);

  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(
      `Cannot parse owner/repo from URL: "${repoUrl}". ` +
        "Expected format: https://github.com/owner/repo"
    );
  }

  return {
    owner: parts[0],
    repo: parts[1],
  };
}

interface GitHubFetcher {
  (url: string): Promise<unknown>;
}

/**
 * Routes GitHub requests through the configured server-side proxy.
 * The original API path is encoded to prevent it being interpreted as a
 * separate proxy route.
 */
function resolveApiRequestUrl(url: string, apiBase?: string): string {
  if (!apiBase || apiBase === API_BASE) {
    return url;
  }

  const upstream = new URL(url);

  if (upstream.origin !== API_BASE) {
    throw new Error("FinePrint can only proxy requests to api.github.com.");
  }

  return `${apiBase}?path=${encodeURIComponent(
    `${upstream.pathname}${upstream.search}`
  )}`;
}

/**
 * Builds a GitHub API fetcher with optional authentication, proxy routing,
 * response caching and rate-limit handling.
 */
export function buildFetcher(
  options: FetchOptions = {}
): GitHubFetcher {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "fineprint/0.2",
  };

  if (options.token) {
    headers.Authorization = `Bearer ${options.token}`;
  }

  return async (url: string): Promise<unknown> => {
    const ttl = Math.max(0, options.cacheTtlMs ?? 0);

    if (ttl > 0) {
      const cached = responseCache.get(url);

      if (cached && cached.expiresAt > Date.now()) {
        // Refresh the insertion order to maintain LRU cache behaviour.
        responseCache.delete(url);
        responseCache.set(url, cached);
        return structuredClone(cached.data);
      }

      if (cached) {
        responseCache.delete(url);
      }
    }

    const requestUrl = resolveApiRequestUrl(url, options.apiBase);
    const response = await fetch(requestUrl, { headers });

    let body: { message?: string } | undefined;

    if (!response.ok) {
      try {
        body = (await response.json()) as { message?: string };
      } catch {
        body = undefined;
      }
    }

    // GitHub uses 403 or 429 for primary and secondary rate limits.
    // A 401 or an ordinary 403 should remain an authentication or permission error.
    if (response.status === 403 || response.status === 429) {
      const remaining = response.headers.get("x-ratelimit-remaining");
      const resetHeader = response.headers.get("x-ratelimit-reset");
      const retryHeader = response.headers.get("retry-after");
      const message = body?.message ?? "";

      const isPrimary =
        remaining === "0" ||
        /API rate limit exceeded/i.test(message);

      const isSecondary =
        response.status === 429 ||
        Boolean(retryHeader) ||
        /secondary rate limit|abuse detection/i.test(message);

      if (isPrimary || isSecondary) {
        const retryAfterSeconds = retryHeader
          ? Number(retryHeader)
          : null;

        const resetEpoch = resetHeader
          ? Number(resetHeader)
          : NaN;

        const resetAt = Number.isFinite(resetEpoch)
          ? new Date(resetEpoch * 1000)
          : retryAfterSeconds !== null &&
              Number.isFinite(retryAfterSeconds)
            ? new Date(Date.now() + retryAfterSeconds * 1000)
            : isSecondary
              ? new Date(Date.now() + 60_000)
              : null;

        throw new RateLimitError(
          resetAt,
          isPrimary ? "primary" : "secondary",
          retryAfterSeconds !== null &&
            Number.isFinite(retryAfterSeconds)
            ? retryAfterSeconds
            : null
        );
      }
    }

    if (!response.ok) {
      throw new GitHubApiError(
        response.status,
        url,
        body?.message ?? response.statusText
      );
    }

    const data = await response.json();

    if (ttl > 0) {
      responseCache.set(url, {
        expiresAt: Date.now() + ttl,
        data,
      });

      if (responseCache.size > MAX_RESPONSE_CACHE_ENTRIES) {
        const oldestKey = responseCache.keys().next().value;

        if (oldestKey) {
          responseCache.delete(oldestKey);
        }
      }
    }

    return data;
  };
}

interface GhTagItem {
  name: string;
}

interface GhCompareResponse {
  commits: Array<{ sha: string }>;
  total_commits: number;
}

interface GhCommitResponse {
  sha: string;
  commit: {
    message: string;
  };
  files?: Array<{
    filename: string;
    additions: number;
    deletions: number;
    patch?: string;
    status?: CommitFile["status"];
    previous_filename?: string;
  }>;
}

/**
 * Optional settings for fetching a commit range.
 * onProgress is called after each batch with the number fetched and total.
 */
export interface FetchCommitRangeOptions extends FetchOptions {
  onProgress?: (fetched: number, total: number) => void;
}

/**
 * Fetches commit messages and file-level diffs between two Git references.
 *
 * GitHub's compare endpoint returns at most 250 commits. When a range is
 * larger, the available commits are returned and cappedAt indicates that
 * the result is incomplete.
 */
export async function fetchCommitRange(
  repoUrl: string,
  base: string,
  head: string,
  options: FetchCommitRangeOptions = {}
): Promise<CommitRangeResult> {
  const { owner, repo } = parseRepoUrl(repoUrl);
  const { onProgress } = options;
  const get = buildFetcher(options);

  const compareUrl =
    `${API_BASE}/repos/${owner}/${repo}/compare/` +
    `${encodeURIComponent(base)}...${encodeURIComponent(head)}`;

  const comparison = (await get(compareUrl)) as GhCompareResponse;

  const totalCommits = comparison.total_commits;
  const shas = comparison.commits.map((commit) => commit.sha);
  const wasCapped = totalCommits > MAX_COMPARE_COMMITS;

  const records: CommitRecord[] = new Array(shas.length);
  let fetched = 0;

  // Process small batches to reduce request bursts and secondary throttling.
  // Store results by their original index to preserve GitHub's commit order.
  for (let i = 0; i < shas.length; i += BATCH_SIZE) {
    const batchShas = shas.slice(i, i + BATCH_SIZE);

    const batchResults = await Promise.all(
      batchShas.map(async (sha, batchIndex) => {
        const commitUrl =
          `${API_BASE}/repos/${owner}/${repo}/commits/${sha}`;

        const detail = (await get(commitUrl)) as GhCommitResponse;

        const files: CommitFile[] = (detail.files ?? []).map((file) => ({
          filename: file.filename,
          additions: file.additions,
          deletions: file.deletions,
          patch: file.patch ?? null,
          status: file.status,
          previousFilename: file.previous_filename,
        }));

        return {
          index: i + batchIndex,
          record: {
            sha: detail.sha,
            message: detail.commit.message,
            files,
          },
        };
      })
    );

    for (const { index, record } of batchResults) {
      records[index] = record;
    }

    fetched += batchResults.length;
    onProgress?.(fetched, shas.length);
  }

  return {
    commits: records,
    totalCommits,
    ...(wasCapped ? { cappedAt: MAX_COMPARE_COMMITS } : {}),
  };
}

/**
 * Fetches up to 100 tag names from a GitHub repository.
 */
export async function fetchRepoTags(
  repoUrl: string,
  options: FetchOptions = {}
): Promise<string[]> {
  const { owner, repo } = parseRepoUrl(repoUrl);
  const get = buildFetcher(options);

  const url = `${API_BASE}/repos/${owner}/${repo}/tags?per_page=100`;
  const tags = (await get(url)) as GhTagItem[];

  return tags.map((tag) => tag.name);
}
