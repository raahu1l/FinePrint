/**
 * src/ui/receiptUtils.ts
 *
 * Pure utility functions for receipt rendering.
 * Kept separate from App.tsx so they can be unit-tested without React.
 */

import type { CommitVerdict } from "../checks/types.js";

// ---------------------------------------------------------------------------
// buildReceiptRuns — collapse consecutive ok/mechanical runs of 3+
// ---------------------------------------------------------------------------

/**
 * A "single" run renders one CommitRow; a "group" run renders a
 * CollapsibleOkGroup.  Only consecutive ok/mechanical sequences of 3 or more
 * are grouped — adjusted items are always singles.
 */
export type ReceiptRun =
  | { kind: "single"; verdict: CommitVerdict }
  | { kind: "group"; verdicts: CommitVerdict[] };

/**
 * Partition `verdicts` into display runs.
 *
 * Rules:
 *  - adjusted items always appear as individual singles.
 *  - consecutive runs of ok/mechanical items with length < 3 stay as singles.
 *  - consecutive runs of ok/mechanical items with length >= 3 become a group.
 */
export function buildReceiptRuns(verdicts: CommitVerdict[]): ReceiptRun[] {
  const runs: ReceiptRun[] = [];
  let i = 0;
  while (i < verdicts.length) {
    const v = verdicts[i];
    if (v.status === "ok" || v.status === "mechanical") {
      // Collect consecutive ok/mechanical run
      let j = i + 1;
      while (
        j < verdicts.length &&
        (verdicts[j].status === "ok" || verdicts[j].status === "mechanical")
      ) {
        j++;
      }
      const run = verdicts.slice(i, j);
      if (run.length >= 3) {
        runs.push({ kind: "group", verdicts: run });
      } else {
        run.forEach((rv) => runs.push({ kind: "single", verdict: rv }));
      }
      i = j;
    } else {
      runs.push({ kind: "single", verdict: v });
      i++;
    }
  }
  return runs;
}

// ---------------------------------------------------------------------------
// computeHealthCounts — tally routine vs. flagged for the health bar
// ---------------------------------------------------------------------------

export interface HealthCounts {
  /** ok + mechanical combined */
  routine: number;
  /** adjusted */
  flagged: number;
}

/**
 * Count routine (ok/mechanical) and flagged (adjusted) verdicts.
 * Mechanical commits are routine — they were excluded from checks entirely
 * and should never inflate the flagged count.
 */
export function computeHealthCounts(verdicts: CommitVerdict[]): HealthCounts {
  let routine = 0;
  let flagged = 0;
  for (const v of verdicts) {
    if (v.status === "adjusted") {
      flagged++;
    } else {
      routine++;
    }
  }
  return { routine, flagged };
}
