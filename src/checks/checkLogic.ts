/**
 * src/checks/checkLogic.ts
 *
 * Main entry-point for the FinePrint check-logic module.
 *
 * `runChecks` takes the `CommitRecord[]` output from `fetchCommitRange` and
 * two version tag strings, runs all three independent checks over every commit,
 * and merges the results into one `CommitVerdict[]`.
 *
 * Checks applied:
 *   1. Area-mismatch  — flags commits that silently touch undisclosed code areas
 *   2. Semver         — flags breaking changes in patch/minor version bumps
 *   3. Dependency bump — flags manifest files with major-version increases
 *
 * A commit flagged by more than one check gets a single verdict entry with all
 * reasons combined; the commit is never duplicated.
 *
 * Mechanical commits (release-plugin, merges, release-prep, etc.) are excluded
 * from all checks and receive status "mechanical".
 */

import type { CommitRecord } from "../github/types.js";
import { checkAreaMismatch } from "./areaMismatch.js";
import { checkSemver, parseBumpType, type BumpType } from "./semver.js";
import { checkDepBump } from "./depBump.js";
import type { CommitVerdict } from "./types.js";

export type { CommitVerdict, CommitStatus } from "./types.js";
export type { BumpType };

// ---------------------------------------------------------------------------
// isMechanicalCommit — detect auto-generated commits that should be skipped
// ---------------------------------------------------------------------------

/**
 * Patterns that identify auto-generated, tooling-authored commits.
 * These are never human-authored change descriptions and should be excluded
 * from all checks to avoid false positives.
 */
const MECHANICAL_PATTERNS: RegExp[] = [
  /^\[maven-release-plugin\]/,
  /^Merge branch/,
  /^(Prep|Prepare) .*release/i,
  /^Post-release/i,
  /^Update .* release notes/i,
];

/**
 * Returns `true` when `message` matches any mechanical-commit pattern.
 * Exported so it can be unit-tested independently.
 */
export function isMechanicalCommit(message: string): boolean {
  const subject = message.split("\n")[0];
  return MECHANICAL_PATTERNS.some((re) => re.test(subject));
}

// ---------------------------------------------------------------------------
// mergeVerdicts — pure merge helper (exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * Merge the results of all three checks for a single commit into one
 * `CommitVerdict`.  All reason arrays are concatenated; the `undisclosedDiff`
 * from the area-mismatch check is forwarded when present.
 *
 * When a commit is flagged solely by semver or dep checks (no area-mismatch
 * undisclosedDiff), we synthesise a diff evidence block from the triggering
 * files so the UI always has something to show in "show diff".
 *
 * This function is intentionally pure and has no I/O so it can be unit-tested
 * without mocking.
 */
export function mergeVerdicts(
  commit: CommitRecord,
  areaResult: ReturnType<typeof checkAreaMismatch>,
  semverResult: ReturnType<typeof checkSemver>,
  depResult: ReturnType<typeof checkDepBump>
): CommitVerdict {
  const reasons: string[] = [
    ...areaResult.reasons,
    ...semverResult.reasons,
    ...depResult.reasons,
  ];

  const flagged = areaResult.flagged || semverResult.flagged || depResult.flagged;

  const verdict: CommitVerdict = {
    sha: commit.sha,
    message: commit.message,
    status: flagged ? "adjusted" : "ok",
    reasons,
  };

  if (areaResult.undisclosedDiff) {
    // Area-mismatch already provides evidence — use it as-is.
    verdict.undisclosedDiff = areaResult.undisclosedDiff;
  } else if (flagged && (semverResult.flagged || depResult.flagged)) {
    // Semver or dep check fired but there is no area-mismatch evidence.
    // Synthesise a diff block from the files that have patches so the UI
    // always has a "show diff" section for every adjusted item.
    const evidenceFiles = commit.files.filter((f) => f.patch !== null);
    if (evidenceFiles.length > 0) {
      verdict.undisclosedDiff = {
        files: evidenceFiles.map((f) => f.filename),
        additions: evidenceFiles.reduce((s, f) => s + f.additions, 0),
        deletions: evidenceFiles.reduce((s, f) => s + f.deletions, 0),
        sampleSnippet: evidenceFiles[0].patch,
      };
    } else if (commit.files.length > 0) {
      // Files exist but none have patch text (e.g. binary files) — still show filenames.
      verdict.undisclosedDiff = {
        files: commit.files.map((f) => f.filename),
        additions: commit.files.reduce((s, f) => s + f.additions, 0),
        deletions: commit.files.reduce((s, f) => s + f.deletions, 0),
        sampleSnippet: null,
      };
    }
  }

  return verdict;
}

// ---------------------------------------------------------------------------
// runChecks — main public API
// ---------------------------------------------------------------------------

/**
 * Run all checks over every commit in `commits` and return one `CommitVerdict`
 * per commit.
 *
 * @param commits   Array of `CommitRecord` produced by `fetchCommitRange`
 * @param baseTag   The "from" version tag, e.g. `"v1.2.0"`
 * @param headTag   The "to" version tag, e.g. `"v1.3.0"`
 * @returns         One verdict per commit in the same order as the input array
 */
export function runChecks(
  commits: CommitRecord[],
  baseTag: string,
  headTag: string
): CommitVerdict[] {
  const bumpType = parseBumpType(baseTag, headTag);

  return commits.map((commit) => {
    // Mechanical commits are excluded from all checks — return immediately.
    if (isMechanicalCommit(commit.message)) {
      return {
        sha: commit.sha,
        message: commit.message,
        status: "mechanical",
        reasons: [],
      } satisfies CommitVerdict;
    }

    const areaResult = checkAreaMismatch(commit);
    const semverResult = checkSemver(commit, bumpType);
    const depResult = checkDepBump(commit);
    return mergeVerdicts(commit, areaResult, semverResult, depResult);
  });
}
