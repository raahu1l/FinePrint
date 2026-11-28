
/**
 * tests/areaMismatch.test.ts
 *
 * Unit tests for the area-mismatch check.
 */
// @ts-ignore -- Vitest is supplied by the test runner but unavailable to this type-checker.
import { checkAreaMismatch } from "../src/checks/areaMismatch.js";
import type { CommitRecord } from "../src/github/types.js";

function makeCommit(
  message: string,
  files: Array<{
    filename: string;
    additions?: number;
    deletions?: number;
    patch?: string | null;
  }>
): CommitRecord {
  return {
    sha: "abc1234",
    message,
    files: files.map((file) => ({
      filename: file.filename,
      additions: file.additions ?? 5,
      deletions: file.deletions ?? 2,
      patch:
        file.patch !== undefined
          ? file.patch
          : "--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new",
    })),
  };
}

// Empty and unknown files

test("empty file list is not flagged", () => {
  const result = checkAreaMismatch(makeCommit("fix something", []));

  expect(result.flagged).toBe(false);
  expect(result.reasons).toHaveLength(0);
  expect(result.undisclosedDiff).toBeUndefined();
});

test("files matching no area rule are ignored", () => {
  const result = checkAreaMismatch(
    makeCommit("update internal assets", [
      { filename: "assets/logo.bin" },
    ])
  );

  expect(result.flagged).toBe(false);
});

test("README changes are recognised as documentation", () => {
  const result = checkAreaMismatch(
    makeCommit("update readme", [{ filename: "README.md" }])
  );

  expect(result.flagged).toBe(false);
});

test("nested Markdown files are recognised as documentation", () => {
  const result = checkAreaMismatch(
    makeCommit("update documentation", [
      { filename: "examples/tutorial/guide.md" },
    ])
  );

  expect(result.flagged).toBe(false);
});

// Documentation aliases

const documentationMessages: string[] = [
  "doc: update the guide",
  "docs: update the guide",
  "documentation: update the guide",
  "Doc: clarify the configuration options",
  "DOC: update reference documentation",
  "Update release notes for the new version",
  "Update README with installation instructions",
  "Update changelog",
];

for (const message of documentationMessages) {
  test(`documentation message is recognised: ${message}`, () => {
    const result = checkAreaMismatch(
      makeCommit(message, [
        { filename: "doc/src/sgml/reference.sgml" },
      ])
    );

    expect(result.flagged).toBe(false);
  });
}

test("documentation changes without a documentation mention are flagged", () => {
  const result = checkAreaMismatch(
    makeCommit("fix login handling", [
      { filename: "docs/authentication.md" },
    ])
  );

  expect(result.flagged).toBe(true);
  expect(result.reasons).toContain(
    "area changed but not mentioned in commit message: docs"
  );
});

test("release-note updates are not flagged when explicitly described", () => {
  const result = checkAreaMismatch(
    makeCommit("Update release notes for version 18.1", [
      { filename: "doc/src/sgml/release-18.sgml" },
    ])
  );

  expect(result.flagged).toBe(false);
});

// Other area aliases

const areaAliasCases: Array<[string, string]> = [
  ["bump dependency versions", "package.json"],
  ["update dependencies", "go.mod"],
  ["update database migrations", "migrations/001.sql"],
  ["update testing coverage", "tests/login.test.ts"],
  ["update configuration options", "config/app.json"],
  ["update CI pipeline", ".github/workflows/ci.yml"],
];

for (const [message, filename] of areaAliasCases) {
  test(`area alias is recognised: ${message}`, () => {
    const result = checkAreaMismatch(
      makeCommit(message, [{ filename }])
    );

    expect(result.flagged).toBe(false);
  });
}

// Claimed areas

test("claimed area that is changed is not flagged", () => {
  const result = checkAreaMismatch(
    makeCommit("fix auth login bug", [
      { filename: "src/auth/login.ts" },
    ])
  );

  expect(result.flagged).toBe(false);
  expect(result.reasons).toHaveLength(0);
});

test("keyword matching is case-insensitive", () => {
  const result = checkAreaMismatch(
    makeCommit("Fix AUTH issue", [
      { filename: "auth/handler.ts" },
    ])
  );

  expect(result.flagged).toBe(false);
});

test("authentication alias claims the auth area", () => {
  const result = checkAreaMismatch(
    makeCommit("refactor authentication module", [
      { filename: "src/auth/session.ts" },
    ])
  );

  expect(result.flagged).toBe(false);
});

test("authorship does not accidentally claim auth", () => {
  const result = checkAreaMismatch(
    makeCommit("update authorship metadata", [
      { filename: "src/auth/session.ts" },
    ])
  );

  expect(result.flagged).toBe(true);
});

test("bracket syntax claims the auth area", () => {
  const result = checkAreaMismatch(
    makeCommit("[auth] fix token expiry", [
      { filename: "auth/token.ts" },
    ])
  );

  expect(result.flagged).toBe(false);
});

// Undisclosed areas

test("changed area not mentioned in message is flagged", () => {
  const result = checkAreaMismatch(
    makeCommit("fix login flow", [
      { filename: "src/auth/login.ts" },
    ])
  );

  expect(result.flagged).toBe(true);
  expect(result.reasons).toContain(
    "area changed but not mentioned in commit message: auth"
  );
});

test("undisclosedDiff contains affected filenames and totals", () => {
  const result = checkAreaMismatch(
    makeCommit("fix login flow", [
      {
        filename: "src/auth/login.ts",
        additions: 10,
        deletions: 3,
        patch: "@@ patch @@",
      },
    ])
  );

  expect(result.undisclosedDiff).toBeDefined();
  expect(result.undisclosedDiff!.files).toEqual([
    "src/auth/login.ts",
  ]);
  expect(result.undisclosedDiff!.additions).toBe(10);
  expect(result.undisclosedDiff!.deletions).toBe(3);
  expect(result.undisclosedDiff!.sampleSnippet).toBe("@@ patch @@");
});

test("sampleSnippet uses the first available patch", () => {
  const result = checkAreaMismatch(
    makeCommit("fix styles", [
      { filename: "src/auth/a.ts", patch: null },
      { filename: "src/auth/b.ts", patch: "patch-b" },
    ])
  );

  expect(result.undisclosedDiff!.sampleSnippet).toBe("patch-b");
});

test("sampleSnippet is null when no patches are available", () => {
  const result = checkAreaMismatch(
    makeCommit("fix styles", [
      { filename: "src/auth/a.ts", patch: null },
    ])
  );

  expect(result.undisclosedDiff!.sampleSnippet).toBeNull();
});

test("multiple undisclosed areas produce separate reasons", () => {
  const result = checkAreaMismatch(
    makeCommit("refactor core logic", [
      { filename: "src/auth/login.ts" },
      { filename: "src/ui/button.tsx" },
    ])
  );

  expect(result.flagged).toBe(true);
  expect(result.reasons).toHaveLength(2);
  expect(result.reasons).toContain(
    "area changed but not mentioned in commit message: auth"
  );
  expect(result.reasons).toContain(
    "area changed but not mentioned in commit message: ui"
  );
});

test("additions and deletions are summed across undisclosed files", () => {
  const result = checkAreaMismatch(
    makeCommit("refactor core logic", [
      {
        filename: "src/auth/a.ts",
        additions: 4,
        deletions: 1,
      },
      {
        filename: "src/auth/b.ts",
        additions: 6,
        deletions: 2,
      },
    ])
  );

  expect(result.undisclosedDiff!.additions).toBe(10);
  expect(result.undisclosedDiff!.deletions).toBe(3);
});

// Multiple areas

test("GitHub workflow changes are classified as CI", () => {
  const result = checkAreaMismatch(
    makeCommit("update ci pipeline", [
      { filename: ".github/workflows/ci.yml" },
    ])
  );

  expect(result.flagged).toBe(false);
  expect(result.reasons).toHaveLength(0);
});

test("claiming all areas of a multi-area file avoids findings", () => {
  const result = checkAreaMismatch(
    makeCommit("update config and ci pipeline", [
      { filename: ".github/workflows/ci.yml" },
    ])
  );

  expect(result.flagged).toBe(false);
});

test("claiming an unchanged area does not cause a finding", () => {
  const result = checkAreaMismatch(
    makeCommit("auth: add ui improvements", [
      { filename: "src/ui/button.tsx" },
    ])
  );

  expect(result.flagged).toBe(false);
});

// Path normalisation

test("Windows-style paths are normalised", () => {
  const result = checkAreaMismatch(
    makeCommit("update documentation", [
      { filename: "docs\\guide.md" },
    ])
  );

  expect(result.flagged).toBe(false);
});
