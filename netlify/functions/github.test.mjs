
import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { handler } from "./github.mjs";

const originalFetch = globalThis.fetch;
const originalToken = process.env.GITHUB_TOKEN;

beforeEach(() => {
  process.env.GITHUB_TOKEN = "test-server-token";
});

afterEach(() => {
  globalThis.fetch = originalFetch;

  if (originalToken === undefined) {
    delete process.env.GITHUB_TOKEN;
  } else {
    process.env.GITHUB_TOKEN = originalToken;
  }
});

test("rejects non-GET methods", async () => {
  let calls = 0;

  globalThis.fetch = async () => {
    calls += 1;
  };

  const result = await handler({
    httpMethod: "POST",
    queryStringParameters: {},
  });

  assert.equal(result.statusCode, 405);
  assert.equal(calls, 0);
});

test("rejects unsupported paths before contacting GitHub", async () => {
  let calls = 0;

  globalThis.fetch = async () => {
    calls += 1;
  };

  const result = await handler({
    httpMethod: "GET",
    queryStringParameters: {
      path: "/user/repos",
    },
  });

  assert.equal(result.statusCode, 400);
  assert.equal(calls, 0);
});

test("checks repository visibility and forwards public tag requests server-side", async () => {
  const requests = [];

  globalThis.fetch = async (url, init) => {
    requests.push({
      url: String(url),
      headers: init.headers,
    });

    if (
      String(url).endsWith(
        "/repos/fineprint-fixture/public-repo"
      )
    ) {
      return new Response(
        JSON.stringify({ private: false }),
        { status: 200 }
      );
    }

    return new Response(
      JSON.stringify([{ name: "v1.0.0" }]),
      { status: 200 }
    );
  };

  const result = await handler({
    httpMethod: "GET",
    queryStringParameters: {
      path: "/repos/fineprint-fixture/public-repo/tags?per_page=100",
    },
  });

  assert.equal(result.statusCode, 200);
  assert.deepEqual(
    JSON.parse(result.body),
    [{ name: "v1.0.0" }]
  );

  assert.equal(requests.length, 2);

  assert.equal(
    requests[0].headers.authorization,
    "Bearer test-server-token"
  );

  assert.equal(
    requests[1].headers.authorization,
    "Bearer test-server-token"
  );
});

test("does not forward requests for private repositories", async () => {
  const requests = [];

  globalThis.fetch = async (url) => {
    requests.push(String(url));

    return new Response(
      JSON.stringify({ private: true }),
      { status: 200 }
    );
  };

  const result = await handler({
    httpMethod: "GET",
    queryStringParameters: {
      path: "/repos/fineprint-fixture/private-repo/tags?per_page=100",
    },
  });

  assert.equal(result.statusCode, 404);
  assert.equal(requests.length, 1);
});

test("forwards GitHub rate-limit headers to the browser", async () => {
  globalThis.fetch = async (url) => {
    if (
      String(url).endsWith(
        "/repos/fineprint-fixture/limited-repo"
      )
    ) {
      return new Response(
        JSON.stringify({ private: false }),
        { status: 200 }
      );
    }

    return new Response(
      JSON.stringify({
        message: "API rate limit exceeded",
      }),
      {
        status: 403,
        headers: {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": "9999999999",
        },
      }
    );
  };

  const result = await handler({
    httpMethod: "GET",
    queryStringParameters: {
      path: "/repos/fineprint-fixture/limited-repo/tags?per_page=100",
    },
  });

  assert.equal(result.statusCode, 403);
  assert.equal(
    result.headers["x-ratelimit-remaining"],
    "0"
  );
  assert.equal(
    result.headers["x-ratelimit-reset"],
    "9999999999"
  );
});
