/**
 * tests/semver.test.ts
 *
 * Unit tests for parseBumpType and checkSemver.
 */

import { parseBumpType, checkSemver } from "../src/checks/semver.js";
import type { CommitRecord } from "../src/github/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCommit(
  files: Array<{ filename: string; patch?: string | null }>
): CommitRecord {
  return {
    sha: "deadbeef",
    message: "some commit",
    files: files.map((f) => ({
      filename: f.filename,
      additions: 5,
      deletions: 2,
      patch: f.patch !== undefined ? f.patch : null,
    })),
  };
}

// ---------------------------------------------------------------------------
// parseBumpType
// ---------------------------------------------------------------------------

describe("parseBumpType", () => {
  test("major bump — with v prefix", () => {
    expect(parseBumpType("v1.2.0", "v2.0.0")).toBe("major");
  });

  test("major bump — without v prefix", () => {
    expect(parseBumpType("1.0.0", "2.0.0")).toBe("major");
  });

  test("minor bump", () => {
    expect(parseBumpType("v1.2.0", "v1.3.0")).toBe("minor");
  });

  test("patch bump", () => {
    expect(parseBumpType("v1.2.0", "v1.2.1")).toBe("patch");
  });

  test("identical versions → unknown", () => {
    expect(parseBumpType("v1.0.0", "v1.0.0")).toBe("unknown");
  });

  test("non-semver string → unknown", () => {
    expect(parseBumpType("release-2024", "release-2025")).toBe("unknown");
  });

  test("two-part version → unknown", () => {
    expect(parseBumpType("1.0", "1.1")).toBe("unknown");
  });

  test("mixed: one with v, one without", () => {
    expect(parseBumpType("1.2.0", "v1.3.0")).toBe("minor");
  });
});

// ---------------------------------------------------------------------------
// checkSemver — no-flag cases
// ---------------------------------------------------------------------------

describe("checkSemver — not flagged", () => {
  test("major bump is never flagged even with breaking change", () => {
    const commit = makeCommit([
      {
        filename: "src/api.ts",
        patch: "-export function doThing(a: string) {\n+export function doThing(a: string, b: number) {",
      },
    ]);
    const result = checkSemver(commit, "major");
    expect(result.flagged).toBe(false);
    expect(result.reasons).toHaveLength(0);
  });

  test("unknown bump is never flagged", () => {
    const commit = makeCommit([
      {
        filename: "src/api.ts",
        patch: "-export function doThing(a: string) {\n+export function doThing() {",
      },
    ]);
    const result = checkSemver(commit, "unknown");
    expect(result.flagged).toBe(false);
  });

  test("patch bump with no breaking changes is not flagged", () => {
    const commit = makeCommit([
      { filename: "src/util.ts", patch: "-const x = 1;\n+const x = 2;" },
    ]);
    const result = checkSemver(commit, "patch");
    expect(result.flagged).toBe(false);
  });

  test("null patch is skipped without error", () => {
    const commit = makeCommit([{ filename: "src/util.ts", patch: null }]);
    const result = checkSemver(commit, "patch");
    expect(result.flagged).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// checkSemver — removed export
// ---------------------------------------------------------------------------

describe("checkSemver — removed export", () => {
  test("removed export function in patch bump → flagged", () => {
    const commit = makeCommit([
      {
        filename: "src/api.ts",
        patch: " const x = 1;\n-export function myFn() {}\n+// removed",
      },
    ]);
    const result = checkSemver(commit, "patch");
    expect(result.flagged).toBe(true);
    expect(result.reasons[0]).toMatch(/removed export/);
  });

  test("removed export class in minor bump → flagged", () => {
    const commit = makeCommit([
      {
        filename: "src/MyClass.ts",
        patch: "-export class MyClass {}\n+// moved",
      },
    ]);
    const result = checkSemver(commit, "minor");
    expect(result.flagged).toBe(true);
    expect(result.reasons[0]).toMatch(/removed export/);
  });

  test("removed export const → flagged", () => {
    const commit = makeCommit([
      {
        filename: "src/constants.ts",
        patch: "-export const MAX_RETRIES = 5;\n+// removed",
      },
    ]);
    const result = checkSemver(commit, "patch");
    expect(result.flagged).toBe(true);
  });

  test("added export (not removed) is not a breaking change", () => {
    const commit = makeCommit([
      {
        filename: "src/api.ts",
        patch: "+export function newFn() {}",
      },
    ]);
    const result = checkSemver(commit, "patch");
    expect(result.flagged).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// checkSemver — changed function signature
// ---------------------------------------------------------------------------

describe("checkSemver — function signature change", () => {
  test("same function name with different params → flagged", () => {
    const commit = makeCommit([
      {
        filename: "src/lib.ts",
        patch: "-function compute(a: number) {\n+function compute(a: number, b: number) {",
      },
    ]);
    const result = checkSemver(commit, "patch");
    expect(result.flagged).toBe(true);
    expect(result.reasons).toContain(
      "semver violation: breaking change detected in a patch bump (function signature changed)"
    );
  });

  test("same function name with SAME params → not flagged", () => {
    const commit = makeCommit([
      {
        filename: "src/lib.ts",
        patch:
          "-function compute(a: number) {\n   return a;\n-}\n+function compute(a: number) {\n   return a * 2;\n+}",
      },
    ]);
    const result = checkSemver(commit, "patch");
    // Only flagged if signature changes; body-only change should not trigger it.
    // The removed line has params `a: number`, the added line also has `a: number` → no flag.
    expect(
      result.reasons.some((r) => r.includes("function signature changed"))
    ).toBe(false);
  });

  test("renamed function is NOT a signature change (different names)", () => {
    const commit = makeCommit([
      {
        filename: "src/lib.ts",
        patch: "-function oldName(a: number) {\n+function newName(a: number) {",
      },
    ]);
    const result = checkSemver(commit, "patch");
    expect(
      result.reasons.some((r) => r.includes("function signature changed"))
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// checkSemver — config schema change
// ---------------------------------------------------------------------------

describe("checkSemver — config schema change", () => {
  test("removed key in .yaml → flagged", () => {
    const commit = makeCommit([
      {
        filename: "config/app.yaml",
        patch: " timeout: 30\n-retries: 5\n+# removed",
      },
    ]);
    const result = checkSemver(commit, "patch");
    expect(result.flagged).toBe(true);
    expect(result.reasons).toContain(
      "semver violation: breaking change detected in a patch bump (config schema change)"
    );
  });

  test("removed key in .json (non-package) → flagged", () => {
    const commit = makeCommit([
      {
        filename: "config/settings.json",
        patch: ' "timeout": 30,\n-"retries": 5,\n+"retries": 3,',
      },
    ]);
    const result = checkSemver(commit, "minor");
    expect(result.flagged).toBe(true);
  });

  test("package.json is excluded from config schema check", () => {
    const commit = makeCommit([
      {
        filename: "package.json",
        patch: '-"scripts": {},\n+"scripts": {"build": "tsc"}',
      },
    ]);
    const result = checkSemver(commit, "patch");
    expect(
      result.reasons.some((r) => r.includes("config schema change"))
    ).toBe(false);
  });

  test("lock file is excluded from config schema check", () => {
    const commit = makeCommit([
      {
        filename: "package-lock.json",
        patch: '-"lockfileVersion": 2\n+"lockfileVersion": 3',
      },
    ]);
    const result = checkSemver(commit, "patch");
    expect(
      result.reasons.some((r) => r.includes("config schema change"))
    ).toBe(false);
  });

  test("non-config file (.ts) is not flagged as config schema change", () => {
    const commit = makeCommit([
      {
        filename: "src/config.ts",
        patch: '-"timeout": 30\n+"timeout": 60',
      },
    ]);
    const result = checkSemver(commit, "patch");
    expect(
      result.reasons.some((r) => r.includes("config schema change"))
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// checkSemver — multiple violation types in one commit
// ---------------------------------------------------------------------------

test("commit can produce multiple reason strings for different violation types", () => {
  const commit = makeCommit([
    {
      filename: "src/api.ts",
      patch:
        "-export function myFn(a: number) {\n+export function myFn(a: number, b: string) {\n-export class MyClass {}",
    },
    {
      filename: "config/app.yaml",
      patch: "-retries: 5\n+# removed",
    },
  ]);
  const result = checkSemver(commit, "patch");
  expect(result.flagged).toBe(true);
  expect(result.reasons.some((r) => r.includes("removed export"))).toBe(true);
  expect(result.reasons.some((r) => r.includes("function signature changed"))).toBe(true);
  expect(result.reasons.some((r) => r.includes("config schema change"))).toBe(true);
});
