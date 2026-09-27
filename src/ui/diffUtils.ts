/**
 * src/ui/diffUtils.ts
 *
 * Pure utility functions that drive the FinePrint receipt UI:
 *   - isSmallDiff          — decides whether to show full code diff vs. summary
 *   - pickRepresentativeFile — selects the single file with the most changes
 *   - buildGitHubCompareUrl — constructs the GitHub compare URL
 *   - buildReleaseNotesDraft — generates a plain-text release-notes string
 */

import type { CommitVerdict } from "../checks/types.js";
import type { UndisclosedDiff } from "../checks/areaMismatch.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Threshold for "small" diff (total changed lines ≤ this → show inline) */
export const SMALL_DIFF_THRESHOLD = 15;

// ---------------------------------------------------------------------------
// isSmallDiff
// ---------------------------------------------------------------------------

/**
 * Returns `true` when the total changed lines (additions + deletions) in the
 * undisclosed diff is small enough to render inline.
 *
 * @param diff  The `UndisclosedDiff` object from area-mismatch check output
 */
export function isSmallDiff(diff: UndisclosedDiff): boolean {
  return diff.additions + diff.deletions <= SMALL_DIFF_THRESHOLD;
}

// ---------------------------------------------------------------------------
// pickRepresentativeFile
// ---------------------------------------------------------------------------

export interface RepresentativeFile {
  filename: string;
  additions: number;
  deletions: number;
  patch: string | null;
}

/**
 * Picks the single file with the highest total line-change count
 * (additions + deletions) from the commit's files list, restricted to
 * only the undisclosed files listed in `diff.files`.
 *
 * Returns `null` if there are no undisclosed files with diff data.
 *
 * @param allFiles  The full `CommitRecord.files` array
 * @param diff      The `UndisclosedDiff` (has `diff.files` list of filenames)
 */
export function pickRepresentativeFile(
  allFiles: Array<{ filename: string; additions: number; deletions: number; patch: string | null }>,
  diff: UndisclosedDiff
): RepresentativeFile | null {
  const undisclosedSet = new Set(diff.files);
  const candidates = allFiles.filter((f) => undisclosedSet.has(f.filename));

  if (candidates.length === 0) return null;

  return candidates.reduce((best, f) => {
    const score = f.additions + f.deletions;
    const bestScore = best.additions + best.deletions;
    return score > bestScore ? f : best;
  });
}

// ---------------------------------------------------------------------------
// buildGitHubCompareUrl
// ---------------------------------------------------------------------------

/**
 * Builds a GitHub compare URL for the given owner/repo and base/head tags.
 * If a specific filename is provided, appends it as a query parameter (used
 * to deep-link to a particular file's diff when the diff is large).
 */
export function buildGitHubCompareUrl(
  owner: string,
  repo: string,
  base: string,
  head: string,
  filename?: string
): string {
  const base64Url = `https://github.com/${owner}/${repo}/compare/${base}...${head}`;
  if (filename) {
    // GitHub does not support a ?path= filter on /compare directly, but we
    // can link to the files diff anchor by encoding the filename.
    return `${base64Url}#diff-${encodeURIComponent(filename)}`;
  }
  return base64Url;
}

// ---------------------------------------------------------------------------
// buildReleaseNotesDraft
// ---------------------------------------------------------------------------

/**
 * Generates a plain-text release-notes draft from verdict data.
 *
 * Format:
 *   ## Release: <base> → <head>
 *
 *   ### ✅ Verified (N)
 *   - <commit message>  +A -D
 *   ...
 *
 *   ### ⚠️ Adjusted (N)
 *   - <commit message>
 *     Reason: <reason>
 *   ...
 *
 *   ---
 *   N of M commits adjusted.
 */
/**
 * Extract the commit subject (first non-empty line) from a raw commit message.
 *
 * Some commits have leading blank lines or use `\r\n` line endings; a naive
 * `split("\n")[0]` on those returns `""`, causing the title to display as empty.
 * This function trims each line and skips blanks so the real subject always shows.
 * Returns `"(no commit message)"` when the message contains no non-empty lines.
 */
export function extractSubject(message: string): string {
  const subject = message
    .split("\n")
    .map((l) => l.trimEnd())
    .find((l) => l.trim() !== "");
  return subject ?? "(no commit message)";
}

export function buildReleaseNotesDraft(
  verdicts: CommitVerdict[],
  base: string,
  head: string
): string {
  const ok = verdicts.filter((v) => v.status === "ok");
  const adjusted = verdicts.filter((v) => v.status === "adjusted");
  const lines: string[] = [];

  lines.push(`## Release: ${base} → ${head}`);
  lines.push("");

  if (ok.length > 0) {
    lines.push(`### ✅ Verified (${ok.length})`);
    for (const v of ok) {
      const subject = extractSubject(v.message);
      lines.push(`- ${subject}`);
    }
    lines.push("");
  }

  if (adjusted.length > 0) {
    lines.push(`### ⚠️ Adjusted (${adjusted.length})`);
    for (const v of adjusted) {
      const subject = extractSubject(v.message);
      lines.push(`- ${subject}`);
      for (const reason of v.reasons) {
        lines.push(`  Reason: ${reason}`);
      }
    }
    lines.push("");
  }

  lines.push("---");
  lines.push(`${adjusted.length} of ${verdicts.length} commits adjusted.`);

  return lines.join("\n");
}
