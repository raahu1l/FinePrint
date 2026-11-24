
export interface CommitFile {
  filename: string;
  additions: number;
  deletions: number;
  patch: string | null;
  status?: "added" | "modified" | "removed" | "renamed" | "copied" | "changed";
  previousFilename?: string;
}

export interface CommitRecord {
  sha: string;
  message: string;
  files: CommitFile[];
}

export interface CommitRangeResult {
  commits: CommitRecord[];
  totalCommits: number;
  cappedAt?: number;
}

/**
 * Configuration for GitHub API requests.
 * apiBase routes requests through the Netlify Function.
 * cacheTtlMs controls how long successful responses are cached.
 */
export interface FetchOptions {
  apiBase?: string;
  cacheTtlMs?: number;
  token?: string;
}

/**
 * Represents GitHub primary or secondary API rate-limit responses.
 */
export class RateLimitError extends Error {
  constructor(
    public readonly resetAt: Date | null,
    public readonly kind: "primary" | "secondary" | "unknown" = "unknown",
    public readonly retryAfterSeconds: number | null = null
  ) {
    const hint = resetAt
      ? ` Try again after ${resetAt.toISOString()}.`
      : " Please wait before retrying.";

    const label =
      kind === "secondary" ? "secondary rate limit" : "rate limit";

    super(`GitHub API ${label} exceeded.${hint}`);
    this.name = "RateLimitError";
  }
}

/**
 * Represents an unsuccessful GitHub API response.
 */
export class GitHubApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
    message: string
  ) {
    super(`GitHub API error ${status} for ${url}: ${message}`);
    this.name = "GitHubApiError";
  }
}

/**
 * Represents a comparison range that exceeds the supported commit limit.
 */
export class OversizedRangeError extends Error {
  constructor(
    public readonly base: string,
    public readonly head: string,
    public readonly totalCommits: number
  ) {
    super(
      `Range "${base}...${head}" spans ${totalCommits} commits, ` +
        "which exceeds the GitHub compare endpoint limit of 250. " +
        "Split the range into smaller chunks or use the commits list endpoint for large ranges."
    );

    this.name = "OversizedRangeError";
  }
}
