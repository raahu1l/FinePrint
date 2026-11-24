
/**
 * Unit tests for fetchCommitRange and its helpers.
 * All HTTP requests are intercepted using a global fetch mock.
 */

import {
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";

// Install the fetch mock before importing the module under test.
type FetchMock = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

const mockFetch = jest.fn<FetchMock>();

global.fetch = mockFetch as unknown as typeof fetch;

global.fetch = mockFetch as unknown as typeof fetch;

import {
  fetchCommitRange,
  parseRepoUrl,
  buildFetcher,
  fetchRepoTags,
} from "../src/github/fetchCommitRange.js";
import { RateLimitError, GitHubApiError } from "../src/github/types.js";

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
    },
  ],
};

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
    expect(() => parseRepoUrl("not-a-url")).toThrow(
      /Invalid GitHub repo URL/
    );
  });

  it("throws when owner or repo segment is missing", () => {
    expect(() =>
      parseRepoUrl("https://github.com/only-owner")
    ).toThrow(/Cannot parse owner\/repo/);
  });

  it("rejects repository URLs on non-GitHub hosts", () => {
    expect(() =>
      parseRepoUrl("https://example.com/owner/repo")
    ).toThrow(/Only github.com repository URLs are supported/);
  });
});

describe("buildFetcher", () => {
  beforeEach(() => {
  mockFetch.mockReset();
});

  it("sends the required headers without a token", async () => {
    mockFetch.mockResolvedValueOnce(makeResponse({ ok: true }));

    const get = buildFetcher();
    await get("https://api.github.com/test");

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;

    expect(headers.Accept).toBe("application/vnd.github+json");
    expect(headers["User-Agent"]).toBe("fineprint/0.2");
    expect(headers.Authorization).toBeUndefined();
  });

  it("sends a Bearer token when provided", async () => {
    mockFetch.mockResolvedValueOnce(makeResponse({ ok: true }));

    const get = buildFetcher({ token: "ghp_secret" });
    await get("https://api.github.com/test");

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;

    expect(headers.Authorization).toBe("Bearer ghp_secret");
  });

  it("routes requests through the configured proxy without a browser credential", async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse([{ name: "v1.0.0" }])
    );

    await fetchRepoTags("https://github.com/owner/repo", {
      apiBase: "/.netlify/functions/github",
    });

    const [requestUrl, init] = mockFetch.mock.calls[0] as [
      string,
      RequestInit
    ];

    const headers = init.headers as Record<string, string>;

    expect(requestUrl).toContain(
      "/.netlify/functions/github?path="
    );

    expect(decodeURIComponent(requestUrl)).toContain(
      "/repos/owner/repo/tags?per_page=100"
    );

    expect(headers.Authorization).toBeUndefined();
  });

  it("caches successful responses when a cache TTL is configured", async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse([{ name: "v1.0.0" }])
    );

    const options = { cacheTtlMs: 10_000 };

    const first = await fetchRepoTags(
      "https://github.com/owner/cache-test-repo",
      options
    );

    const second = await fetchRepoTags(
      "https://github.com/owner/cache-test-repo",
      options
    );

    expect(first).toEqual(second);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("throws RateLimitError on HTTP 429", async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse({ message: "rate limit exceeded" }, 429, {
        "x-ratelimit-reset": String(
          Math.floor(Date.now() / 1000) + 3600
        ),
      })
    );

    const get = buildFetcher();

    await expect(
      get("https://api.github.com/test")
    ).rejects.toBeInstanceOf(RateLimitError);
  });

  it("detects primary rate limits from HTTP 403 responses", async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse({ message: "forbidden" }, 403, {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(
          Math.floor(Date.now() / 1000) + 1800
        ),
      })
    );

    const get = buildFetcher();

    await expect(
      get("https://api.github.com/test")
    ).rejects.toMatchObject({
      name: "RateLimitError",
      kind: "primary",
    });
  });

  it("detects secondary rate limits when primary quota remains", async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse(
        { message: "You have exceeded a secondary rate limit." },
        403,
        {
          "x-ratelimit-remaining": "42",
          "retry-after": "75",
        }
      )
    );

    const get = buildFetcher();

    await expect(
      get("https://api.github.com/test")
    ).rejects.toMatchObject({
      name: "RateLimitError",
      kind: "secondary",
      retryAfterSeconds: 75,
    });
  });

  it("does not classify invalid credentials as rate limits", async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse({ message: "Bad credentials" }, 401)
    );

    const get = buildFetcher();

    await expect(
      get("https://api.github.com/test")
    ).rejects.toMatchObject({
      name: "GitHubApiError",
      status: 401,
    });
  });

  it("includes the reset timestamp in the rate-limit error", async () => {
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
    expect(err!.message).toMatch(/Try again after/);
    expect(err!.resetAt).toBeInstanceOf(Date);
  });

  it("throws GitHubApiError on other non-200 responses", async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse({ message: "Not Found" }, 404)
    );

    const get = buildFetcher();

    await expect(
      get("https://api.github.com/test")
    ).rejects.toBeInstanceOf(GitHubApiError);
  });

  it("GitHubApiError carries status and URL", async () => {
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

describe("fetchCommitRange", () => {
  beforeEach(() => {
  mockFetch.mockReset();
});

  function setupHappyPath() {
    mockFetch.mockResolvedValueOnce(makeResponse(COMPARE_RESPONSE));
    mockFetch.mockResolvedValueOnce(makeResponse(COMMIT_A_RESPONSE));
    mockFetch.mockResolvedValueOnce(makeResponse(COMMIT_B_RESPONSE));
  }

  it("returns a CommitRangeResult with a commits array", async () => {
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

  it("does not set cappedAt when the range is within the limit", async () => {
    setupHappyPath();

    const result = await fetchCommitRange(
      "https://github.com/owner/repo",
      "v1.0.0",
      "v1.1.0"
    );

    expect(result.cappedAt).toBeUndefined();
  });

  it("returns the commit SHA and message", async () => {
    setupHappyPath();

    const { commits: [first] } = await fetchCommitRange(
      "https://github.com/owner/repo",
      "v1.0.0",
      "v1.1.0"
    );

    expect(first.sha).toBe(SHA_A);
    expect(first.message).toBe(
      "feat: add login\n\nDetailed body."
    );
  });

  it("returns file-level diff information", async () => {
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

  it("handles commits with no files", async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse({
        total_commits: 1,
        commits: [{ sha: SHA_A }],
      })
    );

    mockFetch.mockResolvedValueOnce(
      makeResponse({
        sha: SHA_A,
        commit: { message: "chore: empty" },
      })
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

describe("fetchCommitRange — large-range handling", () => {
beforeEach(() => {
  mockFetch.mockReset();
});

  it("does not throw when total_commits exceeds 250", async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse({
        total_commits: 300,
        commits: [{ sha: SHA_A }, { sha: SHA_B }],
      })
    );

    mockFetch.mockResolvedValueOnce(makeResponse(COMMIT_A_RESPONSE));
    mockFetch.mockResolvedValueOnce(makeResponse(COMMIT_B_RESPONSE));

    await expect(
      fetchCommitRange(
        "https://github.com/owner/repo",
        "v1.0.0",
        "v2.0.0"
      )
    ).resolves.toBeDefined();
  });

  it("returns cappedAt=250 when total_commits exceeds 250", async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse({
        total_commits: 300,
        commits: [{ sha: SHA_A }],
      })
    );

    mockFetch.mockResolvedValueOnce(makeResponse(COMMIT_A_RESPONSE));

    const result = await fetchCommitRange(
      "https://github.com/owner/repo",
      "v1.0.0",
      "v2.0.0"
    );

    expect(result.cappedAt).toBe(250);
  });

  it("returns the actual total commit count when capped", async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse({
        total_commits: 300,
        commits: [{ sha: SHA_A }],
      })
    );

    mockFetch.mockResolvedValueOnce(makeResponse(COMMIT_A_RESPONSE));

    const result = await fetchCommitRange(
      "https://github.com/owner/repo",
      "v1.0.0",
      "v2.0.0"
    );

    expect(result.totalCommits).toBe(300);
  });

  it("returns the commits GitHub provided when capped", async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse({
        total_commits: 999,
        commits: [{ sha: SHA_A }, { sha: SHA_B }],
      })
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

  it("does not cap a range containing exactly 250 commits", async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse({
        total_commits: 250,
        commits: [{ sha: SHA_A }],
      })
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

describe("fetchCommitRange — error cases", () => {
  beforeEach(() => {
  mockFetch.mockReset();
});

  it("surfaces RateLimitError from the compare request", async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse({}, 429, {
        "x-ratelimit-reset": "9999999999",
      })
    );

    await expect(
      fetchCommitRange(
        "https://github.com/owner/repo",
        "v1.0.0",
        "v1.1.0"
      )
    ).rejects.toBeInstanceOf(RateLimitError);
  });

  it("surfaces RateLimitError from a per-commit request", async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse({
        total_commits: 1,
        commits: [{ sha: SHA_A }],
      })
    );

    mockFetch.mockResolvedValueOnce(
      makeResponse({}, 429, {
        "x-ratelimit-reset": "9999999999",
      })
    );

    await expect(
      fetchCommitRange(
        "https://github.com/owner/repo",
        "v1.0.0",
        "v1.0.1"
      )
    ).rejects.toBeInstanceOf(RateLimitError);
  });

  it("surfaces GitHubApiError for a 404 on the compare request", async () => {
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

  it("rejects an invalid repository URL before making an HTTP request", async () => {
    await expect(
      fetchCommitRange(
        "not-a-url",
        "v1.0.0",
        "v1.1.0"
      )
    ).rejects.toThrow(/Invalid GitHub repo URL/);

    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("fetchRepoTags", () => {
  beforeEach(() => {
  mockFetch.mockReset();
});

  it("returns tag names from the API response", async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse([
        { name: "v2.0.0" },
        { name: "v1.1.0" },
        { name: "v1.0.0" },
      ])
    );

    const tags = await fetchRepoTags(
      "https://github.com/owner/repo"
    );

    expect(tags).toEqual(["v2.0.0", "v1.1.0", "v1.0.0"]);
  });

  it("calls the correct GitHub tags endpoint URL", async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse([{ name: "v1.0.0" }])
    );

    await fetchRepoTags("https://github.com/acme/widget");

    const [url] = mockFetch.mock.calls[0] as [string];

    expect(url).toBe(
      "https://api.github.com/repos/acme/widget/tags?per_page=100"
    );
  });

  it("returns an empty array when the repository has no tags", async () => {
    mockFetch.mockResolvedValueOnce(makeResponse([]));

    const tags = await fetchRepoTags(
      "https://github.com/owner/empty-repo"
    );

    expect(tags).toEqual([]);
  });

  it("accepts a full URL after input normalization", async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse([{ name: "v3.0.0" }])
    );

    const tags = await fetchRepoTags(
      "https://github.com/owner/repo"
    );

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
      makeResponse({}, 429, {
        "x-ratelimit-reset": "9999999999",
      })
    );

    await expect(
      fetchRepoTags("https://github.com/owner/repo")
    ).rejects.toBeInstanceOf(RateLimitError);
  });

  it("sends a Bearer token when provided", async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse([{ name: "v1.0.0" }])
    );

    await fetchRepoTags(
      "https://github.com/owner/repo",
      { token: "ghp_abc" }
    );

    const [, init] = mockFetch.mock.calls[0] as [
      string,
      RequestInit
    ];

    const headers = init.headers as Record<string, string>;

    expect(headers.Authorization).toBe("Bearer ghp_abc");
  });
});

describe("fetchCommitRange — batched fetching", () => {
  beforeEach(() => {
  mockFetch.mockReset();
});

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

    return {
      shas,
      compareResponse,
      commitResponses,
    };
  }

  it("preserves compare-response order for a two-commit range", async () => {
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

  it("preserves commit order across multiple batches", async () => {
    const {
      shas,
      compareResponse,
      commitResponses,
    } = buildNCommits(25);

    mockFetch.mockResolvedValueOnce(makeResponse(compareResponse));

    for (const response of commitResponses) {
      mockFetch.mockResolvedValueOnce(makeResponse(response));
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

  it("fetches commits in batches of four", async () => {
    const {
      compareResponse,
      commitResponses,
    } = buildNCommits(12);

    mockFetch.mockResolvedValueOnce(makeResponse(compareResponse));

    for (const response of commitResponses) {
      mockFetch.mockResolvedValueOnce(makeResponse(response));
    }

    await fetchCommitRange(
      "https://github.com/owner/repo",
      "v1.0.0",
      "v1.1.0"
    );

    expect(mockFetch).toHaveBeenCalledTimes(13);
  });

  it("calls onProgress after each completed batch", async () => {
    const {
      compareResponse,
      commitResponses,
    } = buildNCommits(12);

    mockFetch.mockResolvedValueOnce(makeResponse(compareResponse));

    for (const response of commitResponses) {
      mockFetch.mockResolvedValueOnce(makeResponse(response));
    }

    const progressCalls: Array<[number, number]> = [];

    await fetchCommitRange(
      "https://github.com/owner/repo",
      "v1.0.0",
      "v1.1.0",
      {
        onProgress: (fetched, total) => {
          progressCalls.push([fetched, total]);
        },
      }
    );

    expect(progressCalls).toHaveLength(3);
    expect(progressCalls[0]).toEqual([4, 12]);
    expect(progressCalls[1]).toEqual([8, 12]);
    expect(progressCalls[2]).toEqual([12, 12]);
  });

  it("calls onProgress once for a single-batch range", async () => {
    const {
      compareResponse,
      commitResponses,
    } = buildNCommits(3);

    mockFetch.mockResolvedValueOnce(makeResponse(compareResponse));

    for (const response of commitResponses) {
      mockFetch.mockResolvedValueOnce(makeResponse(response));
    }

    const progressCalls: Array<[number, number]> = [];

    await fetchCommitRange(
      "https://github.com/owner/repo",
      "v1.0.0",
      "v1.0.1",
      {
        onProgress: (fetched, total) => {
          progressCalls.push([fetched, total]);
        },
      }
    );

    expect(progressCalls).toHaveLength(1);
    expect(progressCalls[0]).toEqual([3, 3]);
  });

  it("works when onProgress is not provided", async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(COMPARE_RESPONSE));
    mockFetch.mockResolvedValueOnce(makeResponse(COMMIT_A_RESPONSE));
    mockFetch.mockResolvedValueOnce(makeResponse(COMMIT_B_RESPONSE));

    await expect(
      fetchCommitRange(
        "https://github.com/owner/repo",
        "v1.0.0",
        "v1.1.0"
      )
    ).resolves.toBeDefined();
  });
});
