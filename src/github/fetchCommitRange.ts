/**
 * fetchCommitRange
 * ----------------
 * Given a GitHub repo URL and two tag/branch/SHA references, returns a
 * structured list of commits (with per-file diffs) between `base` and `head`.
 *
 * Algorithm
 * ---------
 * 1. Parse `owner` and `repo` from the URL.
 * 2. GET /repos/{owner}/{repo}/compare/{base}...{head} → list of commit SHAs.
 * 3. For every SHA, GET /repos/{owner}/{repo}/commits/{sha} → message + files.
 * 4. Return a CommitRangeResult object.
 *
 * When the range spans more than 250 commits (GitHub's hard limit for the
 * compare endpoint), only the most-recent 250 are fetched and analysed.
 * The returned `cappedAt` field signals this to the caller so a banner can be
 * shown; no error is thrown.
 */

import {
  CommitFile,
  CommitRangeResult,
  CommitRecord,
  FetchOptions,
  GitHubApiError,
  RateLimitError,
} from "./types.js";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const API_BASE = "https://api.github.com";
const MAX_COMPARE_COMMITS = 250; // GitHub hard limit for the compare endpoint

/**
 * Parse `owner` and `repo` out of a GitHub URL.
 * Accepts both HTTPS (`https://github.com/owner/repo`) and
 * SSH-style (`git@github.com:owner/repo.git`) forms.
 */
export function parseRepoUrl(repoUrl: string): {
  owner: string;
  repo: string;
} {
  // Normalise SSH → HTTPS-like path segment
  const normalised = repoUrl
    .trim()
    .replace(/^git@github\.com:/, "https://github.com/")
    .replace(/\.git$/, "");

  let pathname: string;
  try {
    pathname = new URL(normalised).pathname; // "/owner/repo"
  } catch {
    throw new Error(`Invalid GitHub repo URL: "${repoUrl}"`);
  }

  const parts = pathname.replace(/^\//, "").split("/");
  if (parts.length < 2 || !parts[0] || !parts[1]) {
    throw new Error(
      `Cannot parse owner/repo from URL: "${repoUrl}". ` +
        `Expected format: https://github.com/owner/repo`
    );
  }

  return { owner: parts[0], repo: parts[1] };
}

// ---------------------------------------------------------------------------
// Low-level fetch wrapper
// ---------------------------------------------------------------------------

interface GitHubFetcher {
  (url: string): Promise<unknown>;
}

/**
 * Build a fetcher function pre-configured with the Accept header and,
 * optionally, an Authorization header.
 */
export function buildFetcher(options: FetchOptions = {}): GitHubFetcher {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "fineprint/0.1",
  };

  if (options.token) {
    headers["Authorization"] = `Bearer ${options.token}`;
  }

  return async (url: string): Promise<unknown> => {
    const res = await fetch(url, { headers });

    // Rate-limit detection: 403 with x-ratelimit-remaining: 0, or 429
    if (res.status === 429 || res.status === 403) {
      const remaining = res.headers.get("x-ratelimit-remaining");
      if (res.status === 429 || remaining === "0") {
        const resetHeader = res.headers.get("x-ratelimit-reset");
        const resetAt = resetHeader
          ? new Date(Number(resetHeader) * 1000)
          : null;
        throw new RateLimitError(resetAt);
      }
    }

    if (!res.ok) {
      let message = res.statusText;
      try {
        const body = (await res.json()) as { message?: string };
        if (body.message) message = body.message;
      } catch {
        // ignore parse errors — keep the statusText
      }
      throw new GitHubApiError(res.status, url, message);
    }

    return res.json();
  };
}

// ---------------------------------------------------------------------------
// GitHub response shape (minimal — only fields we use)
// ---------------------------------------------------------------------------

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
  }>;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch structured commit + diff data for every commit reachable from `head`
 * but not from `base` (i.e., the commits introduced in a release).
 *
 * When the range spans more than 250 commits, only the most-recent 250 are
 * fetched.  The returned `cappedAt` field is set so the caller can display a
 * banner; no error is thrown.
 *
 * @param repoUrl  Full GitHub repo URL, e.g. `https://github.com/owner/repo`
 * @param base     Tag, branch, or SHA that marks the start of the range
 * @param head     Tag, branch, or SHA that marks the end of the range
 * @param options  Optional: `{ token }` for authenticated requests
 * @returns        {@link CommitRangeResult} — commits plus optional cap metadata
 */
export async function fetchCommitRange(
  repoUrl: string,
  base: string,
  head: string,
  options: FetchOptions = {}
): Promise<CommitRangeResult> {
  const { owner, repo } = parseRepoUrl(repoUrl);
  const get = buildFetcher(options);

  // ── Step 1: compare endpoint ──────────────────────────────────────────────
  const compareUrl =
    `${API_BASE}/repos/${owner}/${repo}/compare/${base}...${head}`;

  const comparison = (await get(compareUrl)) as GhCompareResponse;

  const totalCommits = comparison.total_commits;
  // GitHub caps the commits array at 250 regardless of total_commits.
  // We use whatever the API returned — no truncation needed on our side.
  const shas = comparison.commits.map((c) => c.sha);
  const wasCapped = totalCommits > MAX_COMPARE_COMMITS;

  // ── Step 2: per-commit detail (sequential to stay within rate limits) ─────
  const records: CommitRecord[] = [];

  for (const sha of shas) {
    const commitUrl = `${API_BASE}/repos/${owner}/${repo}/commits/${sha}`;
    const detail = (await get(commitUrl)) as GhCommitResponse;

    const files: CommitFile[] = (detail.files ?? []).map((f) => ({
      filename: f.filename,
      additions: f.additions,
      deletions: f.deletions,
      patch: f.patch ?? null,
    }));

    records.push({
      sha: detail.sha,
      message: detail.commit.message,
      files,
    });
  }

  return {
    commits: records,
    totalCommits,
    ...(wasCapped ? { cappedAt: MAX_COMPARE_COMMITS } : {}),
  };
}

// ---------------------------------------------------------------------------
// fetchRepoTags
// ---------------------------------------------------------------------------

/**
 * Fetch the list of tag names for a GitHub repository.
 *
 * @param repoUrl  Full GitHub repo URL, e.g. `https://github.com/owner/repo`
 * @param options  Optional: `{ token }` for authenticated requests
 * @returns        Array of tag name strings, in the order returned by GitHub
 */
export async function fetchRepoTags(
  repoUrl: string,
  options: FetchOptions = {}
): Promise<string[]> {
  const { owner, repo } = parseRepoUrl(repoUrl);
  const get = buildFetcher(options);
  const url = `${API_BASE}/repos/${owner}/${repo}/tags?per_page=100`;
  const tags = (await get(url)) as GhTagItem[];
  return tags.map((t) => t.name);
}
