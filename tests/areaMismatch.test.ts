/**
 * tests/areaMismatch.test.ts
 *
 * Unit tests for the area-mismatch check.
 */

import { checkAreaMismatch } from "../src/checks/areaMismatch.js";
import type { CommitRecord } from "../src/github/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
    files: files.map((f) => ({
      filename: f.filename,
      additions: f.additions ?? 5,
      deletions: f.deletions ?? 2,
      patch: f.patch !== undefined ? f.patch : "--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new",
    })),
  };
}

// ---------------------------------------------------------------------------
// Baseline: no files → never flagged
// ---------------------------------------------------------------------------

test("empty file list is not flagged", () => {
  const result = checkAreaMismatch(makeCommit("fix something", []));
  expect(result.flagged).toBe(false);
  expect(result.reasons).toHaveLength(0);
  expect(result.undisclosedDiff).toBeUndefined();
});

// ---------------------------------------------------------------------------
// Files that match no area → ignored
// ---------------------------------------------------------------------------

test("files matching no area rule are ignored", () => {
  const result = checkAreaMismatch(
    makeCommit("update readme", [{ filename: "README.md" }])
  );
  expect(result.flagged).toBe(false);
});

// ---------------------------------------------------------------------------
// Claimed and changed → not flagged
// ---------------------------------------------------------------------------

test("claimed area that is changed is not flagged", () => {
  const result = checkAreaMismatch(
    makeCommit("fix auth login bug", [{ filename: "src/auth/login.ts" }])
  );
  expect(result.flagged).toBe(false);
  expect(result.reasons).toHaveLength(0);
});

test("keyword match is case-insensitive", () => {
  const result = checkAreaMismatch(
    makeCommit("Fix AUTH issue", [{ filename: "auth/handler.ts" }])
  );
  expect(result.flagged).toBe(false);
});

test("deps alias 'dependency' claims the deps area", () => {
  const result = checkAreaMismatch(
    makeCommit("bump dependency versions", [{ filename: "package.json" }])
  );
  expect(result.flagged).toBe(false);
});

test("deps alias 'dependencies' claims the deps area", () => {
  const result = checkAreaMismatch(
    makeCommit("update dependencies", [{ filename: "go.mod" }])
  );
  expect(result.flagged).toBe(false);
});

test("tests alias 'tests' claims the test area", () => {
  const result = checkAreaMismatch(
    makeCommit("add more tests", [{ filename: "tests/foo.test.ts" }])
  );
  expect(result.flagged).toBe(false);
});

// ---------------------------------------------------------------------------
// Changed but not claimed → flagged
// ---------------------------------------------------------------------------

test("changed area not in message is flagged", () => {
  const result = checkAreaMismatch(
    makeCommit("fix login flow", [{ filename: "src/auth/login.ts" }])
  );
  // "auth" is not claimed (message says "fix login flow")
  expect(result.flagged).toBe(true);
  expect(result.reasons).toContain(
    "area changed but not mentioned in commit message: auth"
  );
});

test("undisclosedDiff is populated when flagged", () => {
  const result = checkAreaMismatch(
    makeCommit("fix login flow", [
      { filename: "src/auth/login.ts", additions: 10, deletions: 3, patch: "@@ patch @@" },
    ])
  );
  expect(result.undisclosedDiff).toBeDefined();
  expect(result.undisclosedDiff!.files).toEqual(["src/auth/login.ts"]);
  expect(result.undisclosedDiff!.additions).toBe(10);
  expect(result.undisclosedDiff!.deletions).toBe(3);
  expect(result.undisclosedDiff!.sampleSnippet).toBe("@@ patch @@");
});

test("sampleSnippet is the FIRST undisclosed file's patch", () => {
  const result = checkAreaMismatch(
    makeCommit("fix styles", [
      { filename: "src/auth/a.ts", patch: "patch-a" },
      { filename: "src/auth/b.ts", patch: "patch-b" },
    ])
  );
  expect(result.undisclosedDiff!.sampleSnippet).toBe("patch-a");
});

test("sampleSnippet is null when patch is null", () => {
  const result = checkAreaMismatch(
    makeCommit("fix styles", [{ filename: "src/auth/a.ts", patch: null }])
  );
  expect(result.undisclosedDiff!.sampleSnippet).toBeNull();
});

// ---------------------------------------------------------------------------
// Keyword must be whole word
// ---------------------------------------------------------------------------

test("substring 'authentication' does not claim auth area", () => {
  const result = checkAreaMismatch(
    makeCommit("refactor authentication module", [
      { filename: "src/auth/session.ts" },
    ])
  );
  expect(result.flagged).toBe(true);
  expect(result.reasons[0]).toContain("auth");
});

test("'[auth]' bracket syntax claims the auth area", () => {
  const result = checkAreaMismatch(
    makeCommit("[auth] fix token expiry", [{ filename: "auth/token.ts" }])
  );
  expect(result.flagged).toBe(false);
});

// ---------------------------------------------------------------------------
// Multi-area file: covered by at least one claimed area → not flagged
// ---------------------------------------------------------------------------

test("file matching two areas is not flagged when one area is claimed", () => {
  // .github/ matches both "config" and "ci" rules
  const result = checkAreaMismatch(
    makeCommit("update ci pipeline", [{ filename: ".github/workflows/ci.yml" }])
  );
  // "ci" is claimed, so the file is disclosed even though "config" is also matched
  expect(result.flagged).toBe(false);
});

// ---------------------------------------------------------------------------
// Multiple undisclosed areas in one commit
// ---------------------------------------------------------------------------

test("multiple undisclosed areas each produce a separate reason", () => {
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

test("additions and deletions are summed across all undisclosed files", () => {
  const result = checkAreaMismatch(
    makeCommit("refactor core logic", [
      { filename: "src/auth/a.ts", additions: 4, deletions: 1, patch: "p1" },
      { filename: "src/auth/b.ts", additions: 6, deletions: 2, patch: "p2" },
    ])
  );
  expect(result.undisclosedDiff!.additions).toBe(10);
  expect(result.undisclosedDiff!.deletions).toBe(3);
});

// ---------------------------------------------------------------------------
// Claimed-but-not-changed area → not flagged (one-way rule)
// ---------------------------------------------------------------------------

test("claiming an area that has no changed files does not flag anything", () => {
  const result = checkAreaMismatch(
    makeCommit("auth: add ui improvements", [{ filename: "src/ui/button.tsx" }])
  );
  // "auth" is claimed but not changed; "ui" is claimed AND changed → no flag
  expect(result.flagged).toBe(false);
});
