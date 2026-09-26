/**
 * tests/diffUtils.test.ts
 *
 * Tests for the pure utility functions in src/ui/diffUtils.ts:
 *   - isSmallDiff
 *   - pickRepresentativeFile
 *   - buildReleaseNotesDraft
 */

import {
  isSmallDiff,
  SMALL_DIFF_THRESHOLD,
  pickRepresentativeFile,
  buildReleaseNotesDraft,
  buildGitHubCompareUrl,
} from "../src/ui/diffUtils.js";
import type { UndisclosedDiff } from "../src/checks/areaMismatch.js";
import type { CommitVerdict } from "../src/checks/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDiff(
  additions: number,
  deletions: number,
  files: string[] = ["src/auth/token.ts"],
  sampleSnippet: string | null = null
): UndisclosedDiff {
  return { additions, deletions, files, sampleSnippet };
}

function makeFile(
  filename: string,
  additions: number,
  deletions: number,
  patch: string | null = null
) {
  return { filename, additions, deletions, patch };
}

function makeVerdict(
  sha: string,
  message: string,
  status: "ok" | "adjusted",
  reasons: string[] = [],
  undisclosedDiff?: UndisclosedDiff
): CommitVerdict {
  return { sha, message, status, reasons, undisclosedDiff };
}

// ---------------------------------------------------------------------------
// isSmallDiff
// ---------------------------------------------------------------------------

describe("isSmallDiff", () => {
  it("returns true when total changes equal the threshold", () => {
    expect(isSmallDiff(makeDiff(10, 5))).toBe(true); // 15 == threshold
  });

  it("returns true when total changes are below the threshold", () => {
    expect(isSmallDiff(makeDiff(5, 3))).toBe(true); // 8 < 15
  });

  it("returns false when total changes exceed the threshold", () => {
    expect(isSmallDiff(makeDiff(10, 6))).toBe(false); // 16 > 15
  });

  it("returns true for a zero-change diff", () => {
    expect(isSmallDiff(makeDiff(0, 0))).toBe(true);
  });

  it("threshold constant is 15", () => {
    expect(SMALL_DIFF_THRESHOLD).toBe(15);
  });

  it("handles diff where only additions exceed threshold", () => {
    expect(isSmallDiff(makeDiff(16, 0))).toBe(false);
  });

  it("handles diff where only deletions exceed threshold", () => {
    expect(isSmallDiff(makeDiff(0, 16))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// pickRepresentativeFile
// ---------------------------------------------------------------------------

describe("pickRepresentativeFile", () => {
  it("returns the file with the highest total line count", () => {
    const allFiles = [
      makeFile("src/auth/token.ts", 5, 3),   // 8
      makeFile("src/auth/verify.ts", 20, 15), // 35 ← largest
      makeFile("src/auth/utils.ts", 2, 1),    // 3
    ];
    const diff = makeDiff(0, 0, [
      "src/auth/token.ts",
      "src/auth/verify.ts",
      "src/auth/utils.ts",
    ]);

    const result = pickRepresentativeFile(allFiles, diff);
    expect(result?.filename).toBe("src/auth/verify.ts");
  });

  it("only considers files listed in diff.files", () => {
    const allFiles = [
      makeFile("src/auth/token.ts", 100, 50), // large but NOT in undisclosed set
      makeFile("src/auth/verify.ts", 3, 2),   // small but IN undisclosed set
    ];
    const diff = makeDiff(0, 0, ["src/auth/verify.ts"]); // only this is undisclosed

    const result = pickRepresentativeFile(allFiles, diff);
    expect(result?.filename).toBe("src/auth/verify.ts");
  });

  it("returns null when no allFiles match diff.files", () => {
    const allFiles = [makeFile("src/other/file.ts", 10, 5)];
    const diff = makeDiff(0, 0, ["src/auth/token.ts"]);

    expect(pickRepresentativeFile(allFiles, diff)).toBeNull();
  });

  it("returns null when allFiles is empty", () => {
    const diff = makeDiff(0, 0, ["src/auth/token.ts"]);
    expect(pickRepresentativeFile([], diff)).toBeNull();
  });

  it("returns null when diff.files is empty", () => {
    const allFiles = [makeFile("src/auth/token.ts", 5, 3)];
    const diff = makeDiff(0, 0, []);
    expect(pickRepresentativeFile(allFiles, diff)).toBeNull();
  });

  it("breaks ties deterministically by returning the first maximum", () => {
    const allFiles = [
      makeFile("src/auth/a.ts", 10, 0), // 10
      makeFile("src/auth/b.ts", 10, 0), // 10 — same score
    ];
    const diff = makeDiff(0, 0, ["src/auth/a.ts", "src/auth/b.ts"]);
    const result = pickRepresentativeFile(allFiles, diff);
    // First file wins on tie (reduce keeps "best" on equal score)
    expect(result?.filename).toBe("src/auth/a.ts");
  });

  it("forwards the patch field from the selected file", () => {
    const patch = "@@ -1,3 +1,4 @@\n-old\n+new\n context";
    const allFiles = [makeFile("src/auth/token.ts", 10, 5, patch)];
    const diff = makeDiff(0, 0, ["src/auth/token.ts"]);

    const result = pickRepresentativeFile(allFiles, diff);
    expect(result?.patch).toBe(patch);
  });
});

// ---------------------------------------------------------------------------
// buildGitHubCompareUrl
// ---------------------------------------------------------------------------

describe("buildGitHubCompareUrl", () => {
  it("builds a basic compare URL without filename", () => {
    const url = buildGitHubCompareUrl("facebook", "react", "v18.2.0", "v18.3.1");
    expect(url).toBe(
      "https://github.com/facebook/react/compare/v18.2.0...v18.3.1"
    );
  });

  it("appends an encoded filename anchor when provided", () => {
    const url = buildGitHubCompareUrl(
      "facebook",
      "react",
      "v18.2.0",
      "v18.3.1",
      "src/auth/token.ts"
    );
    expect(url).toContain("#diff-");
    expect(url).toContain(encodeURIComponent("src/auth/token.ts"));
  });
});

// ---------------------------------------------------------------------------
// buildReleaseNotesDraft
// ---------------------------------------------------------------------------

describe("buildReleaseNotesDraft", () => {
  it("includes the release version header", () => {
    const verdicts: CommitVerdict[] = [
      makeVerdict("abc123", "fix: sanitize headers", "ok"),
    ];
    const draft = buildReleaseNotesDraft(verdicts, "v1.2.0", "v1.3.0");
    expect(draft).toContain("## Release: v1.2.0 → v1.3.0");
  });

  it("groups ok commits under the Verified section", () => {
    const verdicts: CommitVerdict[] = [
      makeVerdict("abc123", "fix: sanitize headers", "ok"),
      makeVerdict("def456", "chore: bump deps", "ok"),
    ];
    const draft = buildReleaseNotesDraft(verdicts, "v1.2.0", "v1.3.0");
    expect(draft).toContain("### ✅ Verified (2)");
    expect(draft).toContain("- fix: sanitize headers");
    expect(draft).toContain("- chore: bump deps");
  });

  it("groups adjusted commits under the Adjusted section", () => {
    const verdicts: CommitVerdict[] = [
      makeVerdict("abc123", "refactor(core): streamline session", "adjusted", [
        "area changed but not mentioned in commit message: auth",
      ]),
    ];
    const draft = buildReleaseNotesDraft(verdicts, "v1.2.0", "v1.3.0");
    expect(draft).toContain("### ⚠️ Adjusted (1)");
    expect(draft).toContain("- refactor(core): streamline session");
    expect(draft).toContain("area changed but not mentioned in commit message: auth");
  });

  it("includes reason lines indented under adjusted commits", () => {
    const reasons = [
      "area changed but not mentioned in commit message: db",
      "area changed but not mentioned in commit message: api",
    ];
    const verdicts: CommitVerdict[] = [
      makeVerdict("abc123", "feat: new endpoint", "adjusted", reasons),
    ];
    const draft = buildReleaseNotesDraft(verdicts, "v1.0.0", "v2.0.0");
    for (const r of reasons) {
      expect(draft).toContain(`  Reason: ${r}`);
    }
  });

  it("emits the summary line at the end", () => {
    const verdicts: CommitVerdict[] = [
      makeVerdict("a", "fix: one", "ok"),
      makeVerdict("b", "feat: two", "adjusted", ["reason"]),
    ];
    const draft = buildReleaseNotesDraft(verdicts, "v1.0.0", "v1.1.0");
    expect(draft).toContain("1 of 2 commits adjusted.");
  });

  it("omits the Verified section when there are no ok commits", () => {
    const verdicts: CommitVerdict[] = [
      makeVerdict("a", "feat: breaking", "adjusted", ["reason"]),
    ];
    const draft = buildReleaseNotesDraft(verdicts, "v1.0.0", "v2.0.0");
    expect(draft).not.toContain("### ✅ Verified");
  });

  it("omits the Adjusted section when there are no adjusted commits", () => {
    const verdicts: CommitVerdict[] = [
      makeVerdict("a", "fix: safe change", "ok"),
    ];
    const draft = buildReleaseNotesDraft(verdicts, "v1.0.0", "v1.0.1");
    expect(draft).not.toContain("### ⚠️ Adjusted");
  });

  it("uses only the first line of multi-line commit messages", () => {
    const msg = "fix: something\n\nThis is a longer body paragraph.\n\nFixes #123";
    const verdicts: CommitVerdict[] = [makeVerdict("a", msg, "ok")];
    const draft = buildReleaseNotesDraft(verdicts, "v1.0.0", "v1.0.1");
    expect(draft).toContain("- fix: something");
    expect(draft).not.toContain("longer body paragraph");
  });

  it("handles an empty verdicts array gracefully", () => {
    const draft = buildReleaseNotesDraft([], "v1.0.0", "v1.0.1");
    expect(draft).toContain("## Release: v1.0.0 → v1.0.1");
    expect(draft).toContain("0 of 0 commits adjusted.");
  });
});
