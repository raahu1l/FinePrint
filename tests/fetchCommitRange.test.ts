/**
 * Unit tests for fetchCommitRange and its helpers.
 *
 * All HTTP is intercepted via a global fetch mock — no real network calls.
 */

import { jest } from "@jest/globals";

// ── Mock fetch before importing the module under test ─────────────────────
const mockFetch = jest.fn<typeof fetch>();
global.fetch = mockFetch as unknown as typeof fetch;

import {
  fetchCommitRange,
  parseRepoUrl,
  buildFetcher,
} from "../src/github/fetchCommitRange.js";
import { RateLimitError, GitHubApiError } from "../src/github/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {}
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: () => Promise.resolve(body),
    headers: {
      get: (key: string) => headers[key.toLowerCase()] ?? null,
    },
  } as unknown as Response;
}

/** Commit SHAs used across tests */
const SHA_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1";
const SHA_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2";

const COMPARE_RESPONSE = {
  total_commits: 2,
  commits: [{ sha: SHA_A }, { sha: SHA_B }],
};

const COMMIT_A_RESPONSE = {
  sha: SHA_A,
  commit: { message: "feat: add login\n\nDetailed body." },
  files: [
    {
      filename: "src/auth/login.ts",
      additions: 42,
      deletions: 3,
      patch: "@@ -1,3 +1,45 @@\n-old\n+new",
    },
  ],
};

const COMMIT_B_RESPONSE = {
  sha: SHA_B,
  commit: { message: "fix: handle null user" },
  files: [
    {
      filename: "src/auth/session.ts",
      additions: 5,
      deletions: 1,
      // no patch property → should become null
    },
  ],
};

// ---------------------------------------------------------------------------
// parseRepoUrl
// ---------------------------------------------------------------------------

describe("parseRepoUrl", () => {
  it("parses a standard HTTPS URL", () => {
    expect(parseRepoUrl("https://github.com/owner/my-repo")).toEqual({
      owner: "owner",
      repo: "my-repo",
    });
  });

  it("strips a trailing .git suffix", () => {
    expect(parseRepoUrl("https://github.com/owner/my-repo.git")).toEqual({
      owner: "owner",
      repo: "my-repo",
    });
  });

  it("parses SSH-style URLs", () => {
    expect(parseRepoUrl("git@github.com:owner/my-repo.git")).toEqual({
      owner: "owner",
      repo: "my-repo",
    });
  });

  it("throws on a clearly invalid URL", () => {
    expect(() => parseRepoUrl("not-a-url")).toThrow(/Invalid GitHub repo URL/);
  });

  it("throws when owner or repo segment is missing", () => {
    expect(() => parseRepoUrl("https://github.com/only-owner")).toThrow(
      /Cannot parse owner\/repo/
    );
  });
});

// ---------------------------------------------------------------------------
// buildFetcher — header behaviour
// ---------------------------------------------------------------------------

describe("buildFetcher", () => {
  beforeEach(() => mockFetch.mockReset());

  it("sends the required Accept and User-Agent headers without a token", async () => {
    mockFetch.mockResolvedValueOnce(makeResponse({ ok: true }));
    const get = buildFetcher();
    await get("https://api.github.com/test");

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Accept"]).toBe("application/vnd.github+json");
    expect(headers["User-Agent"]).toBe("fineprint/0.1");
    expect(headers["Authorization"]).toBeUndefined();
  });

  it("sends Bearer token when provided", async () => {
    mockFetch.mockResolvedValueOnce(makeResponse({ ok: true }));
    const get = buildFetcher({ token: "ghp_secret" });
    await get("https://api.github.com/test");

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer ghp_secret");
  });

  it("throws RateLimitError on HTTP 429", async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse({ message: "rate limit exceeded" }, 429, {
        "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
      })
    );
    const get = buildFetcher();
    await expect(get("https://api.github.com/test")).rejects.toBeInstanceOf(
      RateLimitError
    );
  });

  it("throws RateLimitError on HTTP 403 with x-ratelimit-remaining: 0", async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse({ message: "forbidden" }, 403, {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 1800),
      })
    );
    const get = buildFetcher();
    await expect(get("https://api.github.com/test")).rejects.toBeInstanceOf(
      RateLimitError
    );
  });

  it("RateLimitError message contains reset timestamp", async () => {
    const resetEpoch = Math.floor(Date.now() / 1000) + 3600;
    mockFetch.mockResolvedValueOnce(
      makeResponse({}, 429, {
        "x-ratelimit-reset": String(resetEpoch),
      })
    );
    const get = buildFetcher();
    let err: RateLimitError | undefined;
    try {
      await get("https://api.github.com/test");
    } catch (e) {
      err = e as RateLimitError;
    }
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err!.message).toMatch(/Rate limit resets at/);
    expect(err!.resetAt).toBeInstanceOf(Date);
  });

  it("throws GitHubApiError on other non-200 responses", async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse({ message: "Not Found" }, 404)
    );
    const get = buildFetcher();
    await expect(get("https://api.github.com/test")).rejects.toBeInstanceOf(
      GitHubApiError
    );
  });

  it("GitHubApiError carries status and url", async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse({ message: "Not Found" }, 404)
    );
    const get = buildFetcher();
    let err: GitHubApiError | undefined;
    try {
      await get("https://api.github.com/repos/x/y");
    } catch (e) {
      err = e as GitHubApiError;
    }
    expect(err!.status).toBe(404);
    expect(err!.url).toContain("repos/x/y");
  });
});

// ---------------------------------------------------------------------------
// fetchCommitRange — happy path
// ---------------------------------------------------------------------------

describe("fetchCommitRange", () => {
  beforeEach(() => mockFetch.mockReset());

  function setupHappyPath() {
    // call 1: compare
    mockFetch.mockResolvedValueOnce(makeResponse(COMPARE_RESPONSE));
    // call 2: commit A detail
    mockFetch.mockResolvedValueOnce(makeResponse(COMMIT_A_RESPONSE));
    // call 3: commit B detail
    mockFetch.mockResolvedValueOnce(makeResponse(COMMIT_B_RESPONSE));
  }

  it("returns one CommitRecord per commit in the range", async () => {
    setupHappyPath();
    const result = await fetchCommitRange(
      "https://github.com/owner/repo",
      "v1.0.0",
      "v1.1.0"
    );
    expect(result).toHaveLength(2);
  });

  it("record shape: sha and message are present", async () => {
    setupHappyPath();
    const [first] = await fetchCommitRange(
      "https://github.com/owner/repo",
      "v1.0.0",
      "v1.1.0"
    );
    expect(first.sha).toBe(SHA_A);
    expect(first.message).toBe("feat: add login\n\nDetailed body.");
  });

  it("record shape: files contain filename, additions, deletions, patch", async () => {
    setupHappyPath();
    const [first] = await fetchCommitRange(
      "https://github.com/owner/repo",
      "v1.0.0",
      "v1.1.0"
    );
    expect(first.files).toHaveLength(1);
    expect(first.files[0]).toEqual({
      filename: "src/auth/login.ts",
      additions: 42,
      deletions: 3,
      patch: "@@ -1,3 +1,45 @@\n-old\n+new",
    });
  });

  it("sets patch to null when GitHub omits it", async () => {
    setupHappyPath();
    const [, second] = await fetchCommitRange(
      "https://github.com/owner/repo",
      "v1.0.0",
      "v1.1.0"
    );
    expect(second.files[0].patch).toBeNull();
  });

  it("handles commits with no files (empty files array)", async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse({ total_commits: 1, commits: [{ sha: SHA_A }] })
    );
    mockFetch.mockResolvedValueOnce(
      makeResponse({ sha: SHA_A, commit: { message: "chore: empty" } })
      // no files key at all
    );
    const result = await fetchCommitRange(
      "https://github.com/owner/repo",
      "v1.0.0",
      "v1.0.1"
    );
    expect(result[0].files).toEqual([]);
  });

  it("calls the compare endpoint with the correct URL", async () => {
    setupHappyPath();
    await fetchCommitRange(
      "https://github.com/owner/repo",
      "v1.0.0",
      "v1.1.0"
    );
    const [compareUrl] = mockFetch.mock.calls[0] as [string];
    expect(compareUrl).toBe(
      "https://api.github.com/repos/owner/repo/compare/v1.0.0...v1.1.0"
    );
  });

  it("calls the per-commit endpoint for each SHA", async () => {
    setupHappyPath();
    await fetchCommitRange(
      "https://github.com/owner/repo",
      "v1.0.0",
      "v1.1.0"
    );
    const [, callA, callB] = mockFetch.mock.calls as Array<[string]>;
    expect(callA[0]).toBe(
      `https://api.github.com/repos/owner/repo/commits/${SHA_A}`
    );
    expect(callB[0]).toBe(
      `https://api.github.com/repos/owner/repo/commits/${SHA_B}`
    );
  });
});

// ---------------------------------------------------------------------------
// fetchCommitRange — error / edge cases
// ---------------------------------------------------------------------------

describe("fetchCommitRange — error cases", () => {
  beforeEach(() => mockFetch.mockReset());

  it("throws with a clear message when total_commits exceeds 250", async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse({ total_commits: 300, commits: [] })
    );
    await expect(
      fetchCommitRange("https://github.com/owner/repo", "v1.0.0", "v2.0.0")
    ).rejects.toThrow(/exceeds the GitHub compare endpoint limit/);
  });

  it("surfaces RateLimitError from the compare call", async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse({}, 429, { "x-ratelimit-reset": "9999999999" })
    );
    await expect(
      fetchCommitRange("https://github.com/owner/repo", "v1.0.0", "v1.1.0")
    ).rejects.toBeInstanceOf(RateLimitError);
  });

  it("surfaces RateLimitError from a per-commit call", async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse({ total_commits: 1, commits: [{ sha: SHA_A }] })
    );
    mockFetch.mockResolvedValueOnce(
      makeResponse({}, 429, { "x-ratelimit-reset": "9999999999" })
    );
    await expect(
      fetchCommitRange("https://github.com/owner/repo", "v1.0.0", "v1.0.1")
    ).rejects.toBeInstanceOf(RateLimitError);
  });

  it("surfaces GitHubApiError for a 404 on the compare call", async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse({ message: "Not Found" }, 404)
    );
    await expect(
      fetchCommitRange(
        "https://github.com/owner/repo",
        "nonexistent-tag",
        "v1.1.0"
      )
    ).rejects.toBeInstanceOf(GitHubApiError);
  });

  it("throws on an invalid repo URL before making any HTTP call", async () => {
    await expect(
      fetchCommitRange("not-a-url", "v1.0.0", "v1.1.0")
    ).rejects.toThrow(/Invalid GitHub repo URL/);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
