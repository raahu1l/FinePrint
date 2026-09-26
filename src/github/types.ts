/** A single changed file within a commit. */
export interface CommitFile {
  filename: string;
  additions: number;
  deletions: number;
  /** The unified-diff patch for this file, if available. */
  patch: string | null;
}

/** The structured output produced for each commit in the range. */
export interface CommitRecord {
  sha: string;
  message: string;
  files: CommitFile[];
}

/** Options accepted by fetchCommitRange. */
export interface FetchOptions {
  /**
   * Personal-access token or fine-grained token for private repos
   * or to raise the rate limit to 5 000 req/hr.
   * Leave undefined for unauthenticated access to public repos.
   */
  token?: string;
}

/** Raised when GitHub returns HTTP 403/429 indicating rate limiting. */
export class RateLimitError extends Error {
  constructor(public readonly resetAt: Date | null) {
    const hint = resetAt
      ? ` Rate limit resets at ${resetAt.toISOString()}.`
      : "";
    super(`GitHub API rate limit exceeded.${hint}`);
    this.name = "RateLimitError";
  }
}

/** Raised for any non-200, non-rate-limit HTTP response from GitHub. */
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
 * Raised when the compare range spans more than 250 commits, which exceeds
 * the GitHub compare endpoint hard limit.
 */
export class OversizedRangeError extends Error {
  constructor(
    public readonly base: string,
    public readonly head: string,
    public readonly totalCommits: number
  ) {
    super(
      `Range "${base}...${head}" spans ${totalCommits} commits, ` +
        `which exceeds the GitHub compare endpoint limit of 250. ` +
        `Split the range into smaller chunks or use the commits list endpoint for large ranges.`
    );
    this.name = "OversizedRangeError";
  }
}
