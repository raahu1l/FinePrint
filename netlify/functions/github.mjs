
const GITHUB_API_ORIGIN = "https://api.github.com";
const USER_AGENT = "fineprint/0.2";
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})?$/;
const REPO_RE = /^[A-Za-z0-9_.-]{1,100}$/;
const SHA_RE = /^[a-f0-9]{40}$/i;
const PUBLIC_REPO_CACHE_TTL_MS = 60_000;
const MAX_PUBLIC_REPO_CACHE_ENTRIES = 2_000;

const publicRepoCache = new Map();

function json(statusCode, payload, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...extraHeaders,
    },
    body: JSON.stringify(payload),
  };
}

function isAllowedGitHubPath(pathname) {
  const parts = pathname.split("/").filter(Boolean);

  if (parts[0] !== "repos" || parts.length < 4) {
    return false;
  }

  if (!OWNER_RE.test(parts[1]) || !REPO_RE.test(parts[2])) {
    return false;
  }

  if (parts.length === 4 && parts[3] === "tags") {
    return true;
  }

  if (parts.length === 5 && parts[3] === "commits") {
    return SHA_RE.test(parts[4]);
  }

  if (parts.length === 5 && parts[3] === "compare") {
    const spec = parts[4];

    return (
      spec.includes("...") &&
      !spec.includes("..%2F") &&
      !spec.includes("..%2f")
    );
  }

  return false;
}

function forwardedRateHeaders(response) {
  const forwarded = {};

  for (const header of [
    "x-ratelimit-limit",
    "x-ratelimit-remaining",
    "x-ratelimit-reset",
    "x-ratelimit-resource",
    "retry-after",
  ]) {
    const value = response.headers.get(header);

    if (value) {
      forwarded[header] = value;
    }
  }

  return forwarded;
}

async function ensurePublicRepository(owner, repo, headers) {
  const cacheKey = `${owner.toLowerCase()}/${repo.toLowerCase()}`;
  const cachedUntil = publicRepoCache.get(cacheKey);

  if (cachedUntil && cachedUntil > Date.now()) {
    return { isPublic: true };
  }

  const response = await fetch(
    `${GITHUB_API_ORIGIN}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
    { headers }
  );

  if (!response.ok) {
    return {
      response,
      body: await response.text(),
    };
  }

  const repository = await response.json();

  if (repository.private === true) {
    return { isPublic: false };
  }

  publicRepoCache.set(
    cacheKey,
    Date.now() + PUBLIC_REPO_CACHE_TTL_MS
  );

  if (publicRepoCache.size > MAX_PUBLIC_REPO_CACHE_ENTRIES) {
    const oldestKey = publicRepoCache.keys().next().value;

    if (oldestKey) {
      publicRepoCache.delete(oldestKey);
    }
  }

  return { isPublic: true };
}

export const handler = async (event) => {
  if (event.httpMethod !== "GET") {
    return json(
      405,
      { message: "Method not allowed" },
      { allow: "GET" }
    );
  }

  const rawPath = event.queryStringParameters?.path;

  if (
    !rawPath ||
    rawPath.length > 2048 ||
    !rawPath.startsWith("/")
  ) {
    return json(400, {
      message: "A valid GitHub API path is required.",
    });
  }

  let upstream;

  try {
    upstream = new URL(rawPath, GITHUB_API_ORIGIN);
  } catch {
    return json(400, {
      message: "Invalid GitHub API path.",
    });
  }

  if (
    upstream.origin !== GITHUB_API_ORIGIN ||
    !isAllowedGitHubPath(upstream.pathname)
  ) {
    return json(400, {
      message: "This GitHub API endpoint is not supported.",
    });
  }

  // Only pagination parameters used by FinePrint are accepted.
  for (const key of upstream.searchParams.keys()) {
    if (key !== "per_page" && key !== "page") {
      return json(400, {
        message: "Unsupported GitHub API query parameter.",
      });
    }
  }

  const perPage = upstream.searchParams.get("per_page");

  if (
    perPage &&
    (!/^\d+$/.test(perPage) ||
      Number(perPage) < 1 ||
      Number(perPage) > 100)
  ) {
    return json(400, {
      message: "per_page must be between 1 and 100.",
    });
  }

  const page = upstream.searchParams.get("page");

  if (
    page &&
    (!/^\d+$/.test(page) ||
      Number(page) < 1 ||
      Number(page) > 1000)
  ) {
    return json(400, {
      message: "page must be between 1 and 1000.",
    });
  }

  const pathParts = upstream.pathname.split("/").filter(Boolean);
  const owner = pathParts[1];
  const repo = pathParts[2];

  const headers = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": USER_AGENT,
  };

  // Read the token from Netlify's server-side environment only.
  if (process.env.GITHUB_TOKEN) {
    headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  try {
    // Verify repository visibility before making the requested API call.
    const visibility = await ensurePublicRepository(
      owner,
      repo,
      headers
    );

    if (visibility.isPublic === false) {
      return json(404, {
        message: "Repository not found or not public.",
      });
    }

    if (visibility.response) {
      return {
        statusCode: visibility.response.status,
        headers: {
          "content-type":
            visibility.response.headers.get("content-type") ??
            "application/json",
          "cache-control": "no-store",
          ...forwardedRateHeaders(visibility.response),
        },
        body: visibility.body,
      };
    }

    const response = await fetch(upstream.toString(), { headers });
    const body = await response.text();

    return {
      statusCode: response.status,
      headers: {
        "content-type":
          response.headers.get("content-type") ?? "application/json",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        ...forwardedRateHeaders(response),
      },
      body,
    };
  } catch {
    return json(502, {
      message:
        "FinePrint could not reach the GitHub API. Please retry.",
    });
  }
};
