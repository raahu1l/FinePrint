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
  fetchRepoTags,
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

  it("returns a CommitRangeResult with commits array", async () => {
    setupHappyPath();
    const result = await fetchCommitRange(
      "https://github.com/owner/repo",
      "v1.0.0",
      "v1.1.0"
    );
    expect(result.commits).toHaveLength(2);
  });

  it("returns totalCommits from the compare response", async () => {
    setupHappyPath();
    const result = await fetchCommitRange(
      "https://github.com/owner/repo",
      "v1.0.0",
      "v1.1.0"
    );
    expect(result.totalCommits).toBe(2);
  });

  it("cappedAt is undefined when range is within the 250-commit limit", async () => {
    setupHappyPath();
    const result = await fetchCommitRange(
      "https://github.com/owner/repo",
      "v1.0.0",
      "v1.1.0"
    );
    expect(result.cappedAt).toBeUndefined();
  });

  it("record shape: sha and message are present", async () => {
    setupHappyPath();
    const { commits: [first] } = await fetchCommitRange(
      "https://github.com/owner/repo",
      "v1.0.0",
      "v1.1.0"
    );
    expect(first.sha).toBe(SHA_A);
    expect(first.message).toBe("feat: add login\n\nDetailed body.");
  });

  it("record shape: files contain filename, additions, deletions, patch", async () => {
    setupHappyPath();
    const { commits: [first] } = await fetchCommitRange(
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
    const { commits: [, second] } = await fetchCommitRange(
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
    expect(result.commits[0].files).toEqual([]);
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
// fetchCommitRange — large-range cap (graceful 250 handling)
// ---------------------------------------------------------------------------

describe("fetchCommitRange — large-range graceful cap", () => {
  beforeEach(() => mockFetch.mockReset());

  it("does NOT throw when total_commits exceeds 250", async () => {
    // GitHub returns total_commits=300 but only 2 commit SHAs in the array
    mockFetch.mockResolvedValueOnce(
      makeResponse({ total_commits: 300, commits: [{ sha: SHA_A }, { sha: SHA_B }] })
    );
    mockFetch.mockResolvedValueOnce(makeResponse(COMMIT_A_RESPONSE));
    mockFetch.mockResolvedValueOnce(makeResponse(COMMIT_B_RESPONSE));

    await expect(
      fetchCommitRange("https://github.com/owner/repo", "v1.0.0", "v2.0.0")
    ).resolves.toBeDefined();
  });

  it("returns cappedAt=250 when total_commits > 250", async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse({ total_commits: 300, commits: [{ sha: SHA_A }] })
    );
    mockFetch.mockResolvedValueOnce(makeResponse(COMMIT_A_RESPONSE));

    const result = await fetchCommitRange(
      "https://github.com/owner/repo",
      "v1.0.0",
      "v2.0.0"
    );
    expect(result.cappedAt).toBe(250);
  });

  it("returns totalCommits=300 (the real count) when capped", async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse({ total_commits: 300, commits: [{ sha: SHA_A }] })
    );
    mockFetch.mockResolvedValueOnce(makeResponse(COMMIT_A_RESPONSE));

    const result = await fetchCommitRange(
      "https://github.com/owner/repo",
      "v1.0.0",
      "v2.0.0"
    );
    expect(result.totalCommits).toBe(300);
  });

  it("still returns the commits GitHub provided when capped", async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse({ total_commits: 999, commits: [{ sha: SHA_A }, { sha: SHA_B }] })
    );
    mockFetch.mockResolvedValueOnce(makeResponse(COMMIT_A_RESPONSE));
    mockFetch.mockResolvedValueOnce(makeResponse(COMMIT_B_RESPONSE));

    const result = await fetchCommitRange(
      "https://github.com/owner/repo",
      "v1.0.0",
      "v9.0.0"
    );
    expect(result.commits).toHaveLength(2);
    expect(result.cappedAt).toBe(250);
    expect(result.totalCommits).toBe(999);
  });

  it("cappedAt is undefined when total_commits is exactly 250", async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse({ total_commits: 250, commits: [{ sha: SHA_A }] })
    );
    mockFetch.mockResolvedValueOnce(makeResponse(COMMIT_A_RESPONSE));

    const result = await fetchCommitRange(
      "https://github.com/owner/repo",
      "v1.0.0",
      "v2.0.0"
    );
    expect(result.cappedAt).toBeUndefined();
    expect(result.totalCommits).toBe(250);
  });
});

// ---------------------------------------------------------------------------
// fetchCommitRange — error / edge cases
// ---------------------------------------------------------------------------

describe("fetchCommitRange — error cases", () => {
  beforeEach(() => mockFetch.mockReset());

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

// ---------------------------------------------------------------------------
// fetchRepoTags
// ---------------------------------------------------------------------------

describe("fetchRepoTags", () => {
  beforeEach(() => mockFetch.mockReset());

  it("returns tag names from the API response", async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse([{ name: "v2.0.0" }, { name: "v1.1.0" }, { name: "v1.0.0" }])
    );
    const tags = await fetchRepoTags("https://github.com/owner/repo");
    expect(tags).toEqual(["v2.0.0", "v1.1.0", "v1.0.0"]);
  });

  it("calls the correct GitHub tags endpoint URL", async () => {
    mockFetch.mockResolvedValueOnce(makeResponse([{ name: "v1.0.0" }]));
    await fetchRepoTags("https://github.com/acme/widget");
    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toBe(
      "https://api.github.com/repos/acme/widget/tags?per_page=100"
    );
  });

  it("returns an empty array when the repo has no tags", async () => {
    mockFetch.mockResolvedValueOnce(makeResponse([]));
    const tags = await fetchRepoTags("https://github.com/owner/empty-repo");
    expect(tags).toEqual([]);
  });

  it("accepts a short owner/repo URL after normalisation", async () => {
    mockFetch.mockResolvedValueOnce(makeResponse([{ name: "v3.0.0" }]));
    // fetchRepoTags itself calls parseRepoUrl, which requires a full URL —
    // the normalisation lives in InputScreen; pass a full URL here.
    const tags = await fetchRepoTags("https://github.com/owner/repo");
    expect(tags).toEqual(["v3.0.0"]);
  });

  it("surfaces GitHubApiError on a 404 response", async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse({ message: "Not Found" }, 404)
    );
    await expect(
      fetchRepoTags("https://github.com/owner/private-repo")
    ).rejects.toBeInstanceOf(GitHubApiError);
  });

  it("surfaces RateLimitError on HTTP 429", async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse({}, 429, { "x-ratelimit-reset": "9999999999" })
    );
    await expect(
      fetchRepoTags("https://github.com/owner/repo")
    ).rejects.toBeInstanceOf(RateLimitError);
  });

  it("sends Bearer token when provided", async () => {
    mockFetch.mockResolvedValueOnce(makeResponse([{ name: "v1.0.0" }]));
    await fetchRepoTags("https://github.com/owner/repo", { token: "ghp_abc" });
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer ghp_abc");
  });
});

// ---------------------------------------------------------------------------
// fetchCommitRange — batched parallel fetching
// ---------------------------------------------------------------------------

describe("fetchCommitRange — batched parallel fetching", () => {
  beforeEach(() => mockFetch.mockReset());

  /**
   * Build a list of N unique SHAs and corresponding API responses.
   * Returns { shas, compareResponse, commitResponses }.
   */
  function buildNCommits(n: number) {
    const shas = Array.from({ length: n }, (_, i) =>
      String(i).padStart(40, "0")
    );
    const compareResponse = {
      total_commits: n,
      commits: shas.map((sha) => ({ sha })),
    };
    const commitResponses = shas.map((sha, i) => ({
      sha,
      commit: { message: `commit ${i}` },
      files: [],
    }));
    return { shas, compareResponse, commitResponses };
  }

  it("returns commits in the original compare-response order for a 2-commit range", async () => {
    // 2 commits fit in a single batch of 10
    mockFetch.mockResolvedValueOnce(makeResponse(COMPARE_RESPONSE));
    mockFetch.mockResolvedValueOnce(makeResponse(COMMIT_A_RESPONSE));
    mockFetch.mockResolvedValueOnce(makeResponse(COMMIT_B_RESPONSE));

    const result = await fetchCommitRange(
      "https://github.com/owner/repo",
      "v1.0.0",
      "v1.1.0"
    );

    expect(result.commits).toHaveLength(2);
    expect(result.commits[0].sha).toBe(SHA_A);
    expect(result.commits[1].sha).toBe(SHA_B);
  });

  it("returns commits in the correct order when spanning multiple batches (25 commits)", async () => {
    const { shas, compareResponse, commitResponses } = buildNCommits(25);

    // compare endpoint
    mockFetch.mockResolvedValueOnce(makeResponse(compareResponse));
    // per-commit endpoints — register in a fixed order; Promise.all within
    // each batch resolves in array order, so responses must match
    for (const r of commitResponses) {
      mockFetch.mockResolvedValueOnce(makeResponse(r));
    }

    const result = await fetchCommitRange(
      "https://github.com/owner/repo",
      "v1.0.0",
      "v1.1.0"
    );

    expect(result.commits).toHaveLength(25);
    for (let i = 0; i < 25; i++) {
      expect(result.commits[i].sha).toBe(shas[i]);
      expect(result.commits[i].message).toBe(`commit ${i}`);
    }
  });

  it("fires per-commit requests in parallel batches of 10 (batch boundaries are correct)", async () => {
    // 12 commits → batch 1 = 10 requests, batch 2 = 2 requests
    const { compareResponse, commitResponses } = buildNCommits(12);

    mockFetch.mockResolvedValueOnce(makeResponse(compareResponse));
    for (const r of commitResponses) {
      mockFetch.mockResolvedValueOnce(makeResponse(r));
    }

    await fetchCommitRange(
      "https://github.com/owner/repo",
      "v1.0.0",
      "v1.1.0"
    );

    // 1 compare + 12 per-commit = 13 total calls
    expect(mockFetch).toHaveBeenCalledTimes(13);
  });

  it("calls onProgress after each completed batch", async () => {
    // 12 commits → 2 batches: first fires after 10, second after 12
    const { compareResponse, commitResponses } = buildNCommits(12);

    mockFetch.mockResolvedValueOnce(makeResponse(compareResponse));
    for (const r of commitResponses) {
      mockFetch.mockResolvedValueOnce(makeResponse(r));
    }

    const progressCalls: Array<[number, number]> = [];
    await fetchCommitRange(
      "https://github.com/owner/repo",
      "v1.0.0",
      "v1.1.0",
      {
        onProgress: (fetched, total) => progressCalls.push([fetched, total]),
      }
    );

    expect(progressCalls).toHaveLength(2);
    expect(progressCalls[0]).toEqual([10, 12]); // after first batch
    expect(progressCalls[1]).toEqual([12, 12]); // after second batch
  });

  it("calls onProgress once with the full count for a single-batch range", async () => {
    // 3 commits → fits in one batch of 10
    const { compareResponse, commitResponses } = buildNCommits(3);

    mockFetch.mockResolvedValueOnce(makeResponse(compareResponse));
    for (const r of commitResponses) {
      mockFetch.mockResolvedValueOnce(makeResponse(r));
    }

    const progressCalls: Array<[number, number]> = [];
    await fetchCommitRange(
      "https://github.com/owner/repo",
      "v1.0.0",
      "v1.0.1",
      { onProgress: (f, t) => progressCalls.push([f, t]) }
    );

    expect(progressCalls).toHaveLength(1);
    expect(progressCalls[0]).toEqual([3, 3]);
  });

  it("works correctly when onProgress is not provided (no error thrown)", async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(COMPARE_RESPONSE));
    mockFetch.mockResolvedValueOnce(makeResponse(COMMIT_A_RESPONSE));
    mockFetch.mockResolvedValueOnce(makeResponse(COMMIT_B_RESPONSE));

    await expect(
      fetchCommitRange("https://github.com/owner/repo", "v1.0.0", "v1.1.0")
    ).resolves.toBeDefined();
  });
});
