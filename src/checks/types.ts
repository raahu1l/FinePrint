/**
 * src/checks/types.ts
 *
 * Shared output types for the FinePrint check-logic module.
 */

import type { UndisclosedDiff } from "./areaMismatch.js";

export type { UndisclosedDiff };

/**
 * The verdict produced for a single commit after running all checks.
 *
 * - `"ok"`         — no issues found by any check
 * - `"adjusted"`   — one or more checks flagged this commit
 * - `"mechanical"` — auto-generated commit skipped from all checks
 */
export type CommitStatus = "ok" | "adjusted" | "mechanical";

export type FindingCheck = "area-mismatch" | "semver" | "dependency";

export interface CheckFinding {
  check: FindingCheck;
  explanation: string;
  affectedFilenames?: string[];
}

/**
 * The final per-commit verdict emitted by runChecks / mergeVerdicts.
 *
 * Reasons from all checks are merged into a single `reasons` array.
 * The `undisclosedDiff` is only present when the area-mismatch check fired.
 */
export interface CommitVerdict {
  sha: string;
  message: string;
  status: CommitStatus;
  reasons: string[];
  findings?: CheckFinding[];
  undisclosedDiff?: UndisclosedDiff;
}
