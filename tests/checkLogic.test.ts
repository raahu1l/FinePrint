/**
 * tests/checkLogic.test.ts
 *
 * Unit tests for the merge logic in checkLogic.ts:
 *   - mergeVerdicts correctly combines results from all three checks
 *   - runChecks end-to-end orchestration
 *
 * Includes a dedicated test for a commit flagged by MORE THAN ONE check
 * to verify that reasons are combined (not duplicated) into one verdict.
 */

import { mergeVerdicts, runChecks, isMechanicalCommit } from "../src/checks/checkLogic.js";
import type { CommitRecord } from "../src/github/types.js";
import type { AreaMismatchResult } from "../src/checks/areaMismatch.js";
import type { SemverResult } from "../src/checks/semver.js";
import type { DepBumpResult } from "../src/checks/depBump.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_COMMIT: CommitRecord = {
  sha: "sha001",
  message: "fix something",
  files: [],
};

const OK_AREA: AreaMismatchResult = { flagged: false, reasons: [] };
const OK_SEMVER: SemverResult = { flagged: false, reasons: [] };
const OK_DEP: DepBumpResult = { flagged: false, reasons: [] };

const FLAGGED_AREA: AreaMismatchResult = {
  flagged: true,
  reasons: ["area changed but not mentioned in commit message: auth"],
  undisclosedDiff: {
    files: ["src/auth/login.ts"],
    additions: 12,
    deletions: 4,
    sampleSnippet: "@@ -1,5 +1,7 @@",
  },
};

const FLAGGED_SEMVER: SemverResult = {
  flagged: true,
  reasons: [
    "semver violation: breaking change detected in a patch bump (removed export)",
  ],
};

const FLAGGED_DEP: DepBumpResult = {
  flagged: true,
  reasons: ["dependency major-version bump: express 1.x → 2.x"],
};

// ---------------------------------------------------------------------------
// mergeVerdicts — all OK
// ---------------------------------------------------------------------------

describe("mergeVerdicts — all checks pass", () => {
  test("status is ok when no check fires", () => {
    const verdict = mergeVerdicts(BASE_COMMIT, OK_AREA, OK_SEMVER, OK_DEP);
    expect(verdict.status).toBe("ok");
    expect(verdict.reasons).toHaveLength(0);
    expect(verdict.undisclosedDiff).toBeUndefined();
  });

  test("sha and message are forwarded from the commit", () => {
    const verdict = mergeVerdicts(BASE_COMMIT, OK_AREA, OK_SEMVER, OK_DEP);
    expect(verdict.sha).toBe("sha001");
    expect(verdict.message).toBe("fix something");
  });
});

// ---------------------------------------------------------------------------
// mergeVerdicts — single check fires
// ---------------------------------------------------------------------------

describe("mergeVerdicts — one check fires", () => {
  test("area check alone → adjusted + undisclosedDiff present", () => {
    const verdict = mergeVerdicts(BASE_COMMIT, FLAGGED_AREA, OK_SEMVER, OK_DEP);
    expect(verdict.status).toBe("adjusted");
    expect(verdict.reasons).toEqual(FLAGGED_AREA.reasons);
    expect(verdict.undisclosedDiff).toEqual(FLAGGED_AREA.undisclosedDiff);
  });

  test("semver check alone → adjusted, no undisclosedDiff", () => {
    const verdict = mergeVerdicts(BASE_COMMIT, OK_AREA, FLAGGED_SEMVER, OK_DEP);
    expect(verdict.status).toBe("adjusted");
    expect(verdict.reasons).toEqual(FLAGGED_SEMVER.reasons);
    expect(verdict.undisclosedDiff).toBeUndefined();
  });

  test("dep check alone → adjusted, no undisclosedDiff", () => {
    const verdict = mergeVerdicts(BASE_COMMIT, OK_AREA, OK_SEMVER, FLAGGED_DEP);
    expect(verdict.status).toBe("adjusted");
    expect(verdict.reasons).toEqual(FLAGGED_DEP.reasons);
    expect(verdict.undisclosedDiff).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// mergeVerdicts — multiple checks fire simultaneously
// ---------------------------------------------------------------------------

describe("mergeVerdicts — multiple checks fire (the key integration test)", () => {
  test("commit flagged by all three checks → single entry with all reasons", () => {
    const verdict = mergeVerdicts(
      BASE_COMMIT,
      FLAGGED_AREA,
      FLAGGED_SEMVER,
      FLAGGED_DEP
    );
    expect(verdict.status).toBe("adjusted");

    // All three reason strings must be present in one array — no duplicates.
    expect(verdict.reasons).toHaveLength(
      FLAGGED_AREA.reasons.length +
        FLAGGED_SEMVER.reasons.length +
        FLAGGED_DEP.reasons.length
    );
    expect(verdict.reasons).toContain(FLAGGED_AREA.reasons[0]);
    expect(verdict.reasons).toContain(FLAGGED_SEMVER.reasons[0]);
    expect(verdict.reasons).toContain(FLAGGED_DEP.reasons[0]);

    // undisclosedDiff should come from the area check.
    expect(verdict.undisclosedDiff).toEqual(FLAGGED_AREA.undisclosedDiff);
  });

  test("area + semver fire, dep does not → two reasons, no extra dep reason", () => {
    const verdict = mergeVerdicts(
      BASE_COMMIT,
      FLAGGED_AREA,
      FLAGGED_SEMVER,
      OK_DEP
    );
    expect(verdict.status).toBe("adjusted");
    expect(verdict.reasons).toHaveLength(
      FLAGGED_AREA.reasons.length + FLAGGED_SEMVER.reasons.length
    );
    expect(
      verdict.reasons.some((r) => r.includes("dependency"))
    ).toBe(false);
  });

  test("semver + dep fire, area does not → no undisclosedDiff", () => {
    const verdict = mergeVerdicts(
      BASE_COMMIT,
      OK_AREA,
      FLAGGED_SEMVER,
      FLAGGED_DEP
    );
    expect(verdict.status).toBe("adjusted");
    expect(verdict.undisclosedDiff).toBeUndefined();
    expect(verdict.reasons).toHaveLength(
      FLAGGED_SEMVER.reasons.length + FLAGGED_DEP.reasons.length
    );
  });
});

// ---------------------------------------------------------------------------
// runChecks — end-to-end orchestration
// ---------------------------------------------------------------------------

describe("runChecks", () => {
  test("empty commit array returns empty verdict array", () => {
    const verdicts = runChecks([], "v1.0.0", "v1.0.1");
    expect(verdicts).toHaveLength(0);
  });

  test("one clean commit returns a single ok verdict", () => {
    const commits: CommitRecord[] = [
      {
        sha: "aaa",
        message: "docs: update README",
        files: [{ filename: "docs/guide.md", additions: 5, deletions: 1, patch: null }],
      },
    ];
    const verdicts = runChecks(commits, "v1.0.0", "v1.0.1");
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0].status).toBe("ok");
    expect(verdicts[0].sha).toBe("aaa");
  });

  test("commit with undisclosed dep change → adjusted", () => {
    const commits: CommitRecord[] = [
      {
        sha: "bbb",
        message: "fix login bug",           // no mention of deps
        files: [
          {
            filename: "package.json",
            additions: 1,
            deletions: 1,
            patch: [
              '-    "express": "1.4.0",',
              '+    "express": "2.0.0"',
            ].join("\n"),
          },
        ],
      },
    ];
    const verdicts = runChecks(commits, "v1.0.0", "v1.0.1");
    expect(verdicts[0].status).toBe("adjusted");
    // Both area-mismatch (deps area) and dep-bump check should fire
    expect(verdicts[0].reasons.length).toBeGreaterThanOrEqual(1);
  });

  test("output preserves commit order", () => {
    const commits: CommitRecord[] = [
      { sha: "first", message: "docs: a", files: [] },
      { sha: "second", message: "docs: b", files: [] },
      { sha: "third", message: "docs: c", files: [] },
    ];
    const verdicts = runChecks(commits, "v1.0.0", "v1.0.1");
    expect(verdicts.map((v) => v.sha)).toEqual(["first", "second", "third"]);
  });

  test("verdicts from different commits are independent (no cross-contamination)", () => {
    const commits: CommitRecord[] = [
      {
        sha: "clean",
        message: "chore: tidy up",
        files: [],
      },
      {
        sha: "dirty",
        message: "fix: subtle change",
        files: [
          {
            filename: "src/auth/session.ts",
            additions: 5,
            deletions: 2,
            patch: "-export function validateSession(token: string) {\n+export function validateSession(token: string, strict: boolean) {",
          },
        ],
      },
    ];
    const verdicts = runChecks(commits, "v1.0.0", "v1.0.1");
    expect(verdicts.find((v) => v.sha === "clean")!.status).toBe("ok");
    expect(verdicts.find((v) => v.sha === "dirty")!.status).toBe("adjusted");
  });
});

// ---------------------------------------------------------------------------
// isMechanicalCommit — pattern matching
// ---------------------------------------------------------------------------

describe("isMechanicalCommit", () => {
  test.each([
    ["[maven-release-plugin] prepare release v1.2.0"],
    ["[maven-release-plugin] prepare for next development iteration"],
    ["Merge branch 'main' into feature/xyz"],
    ["Merge branch 'release/1.0'"],
    ["Prepare release v2.3.0"],
    ["Prep release 1.0.0-RC1"],
    ["Post-release version bump"],
    ["Post-release: set next development version"],
    ["Update CHANGELOG release notes"],
    ["Update v1.2.0 release notes"],
  ])("returns true for mechanical message: %s", (msg) => {
    expect(isMechanicalCommit(msg)).toBe(true);
  });

  test.each([
    ["fix: correct login redirect"],
    ["feat(auth): add OAuth support"],
    ["chore: bump dependencies"],
    ["docs: update README"],
    ["refactor: extract helper function"],
    // Should NOT match partial overlaps (pattern anchors to start of subject)
    ["chore: prepare the test suite"],
    ["notes on the release process"],
  ])("returns false for non-mechanical message: %s", (msg) => {
    expect(isMechanicalCommit(msg)).toBe(false);
  });

  test("only tests the first line of a multi-line message", () => {
    // Body contains a mechanical-looking line but subject is normal
    expect(
      isMechanicalCommit("fix: resolve NPE\n\nMerge branch 'hotfix' details")
    ).toBe(false);
    // Subject is mechanical, body is normal
    expect(
      isMechanicalCommit("[maven-release-plugin] prepare\n\nsome body text")
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runChecks — mechanical commit exclusion
// ---------------------------------------------------------------------------

describe("runChecks — mechanical commit exclusion", () => {
  /** A commit that would normally trigger area-mismatch AND dep-bump checks */
  const trickyFiles = [
    {
      filename: "package.json",
      additions: 1,
      deletions: 1,
      patch: '-  "lodash": "3.10.1",\n+  "lodash": "4.17.21"',
    },
  ];

  test.each([
    ["[maven-release-plugin] prepare release v1.0.0"],
    ["Merge branch 'main'"],
    ["Prepare release v2.0.0"],
    ["Prep release 1.0.0"],
    ["Post-release version bump"],
    ["Update v1.0.0 release notes"],
  ])("mechanical commit is always status=mechanical regardless of diff: %s", (msg) => {
    const commits: CommitRecord[] = [
      { sha: "mech01", message: msg, files: trickyFiles },
    ];
    const verdicts = runChecks(commits, "v0.9.0", "v1.0.0");
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0].status).toBe("mechanical");
    expect(verdicts[0].reasons).toHaveLength(0);
  });

  test("mechanical commits mixed with real commits: only real commits are checked", () => {
    const commits: CommitRecord[] = [
      {
        sha: "mech01",
        message: "[maven-release-plugin] prepare release v1.0.0",
        files: trickyFiles,
      },
      {
        sha: "real01",
        message: "fix: correct null check",
        files: [],
      },
      {
        sha: "mech02",
        message: "Merge branch 'release/1.0'",
        files: trickyFiles,
      },
    ];
    const verdicts = runChecks(commits, "v0.9.0", "v1.0.0");
    expect(verdicts).toHaveLength(3);
    expect(verdicts.find((v) => v.sha === "mech01")!.status).toBe("mechanical");
    expect(verdicts.find((v) => v.sha === "real01")!.status).toBe("ok");
    expect(verdicts.find((v) => v.sha === "mech02")!.status).toBe("mechanical");
  });

  test("mechanical commit preserves sha and message in verdict", () => {
    const commits: CommitRecord[] = [
      {
        sha: "abc123",
        message: "Post-release version bump\n\nBumped to 1.0.1-SNAPSHOT",
        files: [],
      },
    ];
    const verdicts = runChecks(commits, "v1.0.0", "v1.0.1");
    expect(verdicts[0].sha).toBe("abc123");
    expect(verdicts[0].message).toBe(
      "Post-release version bump\n\nBumped to 1.0.1-SNAPSHOT"
    );
  });
});
