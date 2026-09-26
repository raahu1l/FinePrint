/**
 * tests/depBump.test.ts
 *
 * Unit tests for the dependency-bump check.
 */

import { checkDepBump } from "../src/checks/depBump.js";
import type { CommitRecord } from "../src/github/types.js";

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function makeCommit(
  files: Array<{ filename: string; patch?: string | null }>
): CommitRecord {
  return {
    sha: "cafebabe",
    message: "bump deps",
    files: files.map((f) => ({
      filename: f.filename,
      additions: 2,
      deletions: 2,
      patch: f.patch !== undefined ? f.patch : null,
    })),
  };
}

// ---------------------------------------------------------------------------
// No manifest files / null patches → never flagged
// ---------------------------------------------------------------------------

test("no manifest files → not flagged", () => {
  const result = checkDepBump(makeCommit([{ filename: "src/util.ts" }]));
  expect(result.flagged).toBe(false);
  expect(result.reasons).toHaveLength(0);
});

test("manifest file with null patch → not flagged", () => {
  const result = checkDepBump(makeCommit([{ filename: "package.json", patch: null }]));
  expect(result.flagged).toBe(false);
});

// ---------------------------------------------------------------------------
// package.json — major bump
// ---------------------------------------------------------------------------

describe("package.json", () => {
  test("major version bump is flagged", () => {
    const patch = [
      ' {',
      '   "dependencies": {',
      '-    "express": "1.9.0",',
      '+    "express": "2.0.0"',
      '   }',
      ' }',
    ].join("\n");
    const result = checkDepBump(makeCommit([{ filename: "package.json", patch }]));
    expect(result.flagged).toBe(true);
    expect(result.reasons[0]).toMatch(/express.*1\.x.*2\.x/);
  });

  test("minor version bump is NOT flagged", () => {
    const patch = [
      '-    "react": "17.0.2",',
      '+    "react": "17.0.3"',
    ].join("\n");
    const result = checkDepBump(makeCommit([{ filename: "package.json", patch }]));
    expect(result.flagged).toBe(false);
  });

  test("minor major bump is NOT flagged (1.x → 1.x)", () => {
    const patch = [
      '-    "lodash": "1.0.0",',
      '+    "lodash": "1.9.9"',
    ].join("\n");
    const result = checkDepBump(makeCommit([{ filename: "package.json", patch }]));
    expect(result.flagged).toBe(false);
  });

  test("scoped package major bump is flagged", () => {
    const patch = [
      '-    "@types/node": "16.0.0",',
      '+    "@types/node": "20.0.0"',
    ].join("\n");
    const result = checkDepBump(makeCommit([{ filename: "package.json", patch }]));
    expect(result.flagged).toBe(true);
    expect(result.reasons[0]).toContain("@types/node");
  });

  test("package in nested directory (frontend/package.json) is recognised", () => {
    const patch = [
      '-    "axios": "0.27.2",',
      '+    "axios": "1.0.0"',
    ].join("\n");
    const result = checkDepBump(
      makeCommit([{ filename: "frontend/package.json", patch }])
    );
    expect(result.flagged).toBe(true);
    expect(result.reasons[0]).toContain("axios");
  });

  test("multiple major bumps in one file produce multiple reasons", () => {
    const patch = [
      '-    "express": "1.0.0",',
      '+    "express": "2.0.0",',
      '-    "react": "16.0.0",',
      '+    "react": "18.0.0"',
    ].join("\n");
    const result = checkDepBump(makeCommit([{ filename: "package.json", patch }]));
    expect(result.flagged).toBe(true);
    expect(result.reasons).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// requirements.txt — major bump
// ---------------------------------------------------------------------------

describe("requirements.txt", () => {
  test("major bump is flagged", () => {
    const patch = [
      "-Django>=1.11",
      "+Django>=2.0",
    ].join("\n");
    const result = checkDepBump(
      makeCommit([{ filename: "requirements.txt", patch }])
    );
    expect(result.flagged).toBe(true);
    expect(result.reasons[0]).toMatch(/Django.*1\.x.*2\.x/);
  });

  test("same major version is not flagged", () => {
    const patch = [
      "-Django>=2.0",
      "+Django>=2.2",
    ].join("\n");
    const result = checkDepBump(
      makeCommit([{ filename: "requirements.txt", patch }])
    );
    expect(result.flagged).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// go.mod — major bump
// ---------------------------------------------------------------------------

describe("go.mod", () => {
  test("module major bump is flagged", () => {
    const patch = [
      "-\tgithub.com/gin-gonic/gin v1.9.0",
      "+\tgithub.com/gin-gonic/gin v2.0.0",
    ].join("\n");
    const result = checkDepBump(makeCommit([{ filename: "go.mod", patch }]));
    expect(result.flagged).toBe(true);
    expect(result.reasons[0]).toMatch(/gin-gonic\/gin.*1\.x.*2\.x/);
  });

  test("patch bump in go.mod is not flagged", () => {
    const patch = [
      "-\tgithub.com/some/pkg v3.1.0",
      "+\tgithub.com/some/pkg v3.1.1",
    ].join("\n");
    const result = checkDepBump(makeCommit([{ filename: "go.mod", patch }]));
    expect(result.flagged).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// pom.xml — heuristic major bump
// ---------------------------------------------------------------------------

describe("pom.xml", () => {
  test("major version bump in <version> tag is flagged", () => {
    const patch = [
      " <dependency>",
      "-  <version>1.4.0</version>",
      "+  <version>2.0.0</version>",
      " </dependency>",
    ].join("\n");
    const result = checkDepBump(makeCommit([{ filename: "pom.xml", patch }]));
    expect(result.flagged).toBe(true);
    expect(result.reasons[0]).toMatch(/pom\.xml/);
  });

  test("same major version in pom.xml is not flagged", () => {
    const patch = [
      "-  <version>2.4.0</version>",
      "+  <version>2.5.0</version>",
    ].join("\n");
    const result = checkDepBump(makeCommit([{ filename: "pom.xml", patch }]));
    expect(result.flagged).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// build.gradle — heuristic major bump
// ---------------------------------------------------------------------------

describe("build.gradle", () => {
  test("major bump via version field is flagged", () => {
    // Use the `version = '...'` form that the heuristic regex recognises.
    const patch = [
      "-    version = '1.0.0'",
      "+    version = '2.0.0'",
    ].join("\n");
    const result = checkDepBump(makeCommit([{ filename: "build.gradle", patch }]));
    expect(result.flagged).toBe(true);
  });

  test("Groovy dependency string without 'version =' keyword is not false-flagged", () => {
    // Coordinate-only form `'group:artifact:1.0.0'` lacks the version keyword
    // so the heuristic cannot extract a major version — it should not flag.
    const patch = [
      "-implementation 'com.example:lib:1.0.0'",
      "+implementation 'com.example:lib:1.0.1'",
    ].join("\n");
    const result = checkDepBump(makeCommit([{ filename: "build.gradle", patch }]));
    expect(result.flagged).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Cross-file: multiple manifest files in one commit
// ---------------------------------------------------------------------------

test("multiple manifest files in one commit accumulate reasons", () => {
  const pkgPatch = [
    '-    "express": "1.0.0",',
    '+    "express": "2.0.0"',
  ].join("\n");
  const reqPatch = [
    "-requests>=1.0",
    "+requests>=2.0",
  ].join("\n");

  const result = checkDepBump(
    makeCommit([
      { filename: "package.json", patch: pkgPatch },
      { filename: "requirements.txt", patch: reqPatch },
    ])
  );
  expect(result.flagged).toBe(true);
  expect(result.reasons.length).toBeGreaterThanOrEqual(2);
});
