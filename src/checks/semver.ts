/**
 * src/checks/semver.ts
 *
 * Semver-violation detector for the FinePrint check-logic module.
 *
 * Exports:
 *   - BumpType          — union of recognised bump categories
 *   - SemverResult      — result shape returned by checkSemver
 *   - parseBumpType()   — derives a BumpType by comparing two version tag strings
 *   - checkSemver()     — flags a commit when its diff contains breaking changes
 *                         that are inconsistent with the stated bump type
 */

import type { CommitFile, CommitRecord } from "../github/types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** The kind of version bump implied by two adjacent tags. */
export type BumpType = "major" | "minor" | "patch" | "unknown";

/** Result produced by checkSemver. */
export interface SemverResult {
  /** True when the commit looks like a breaking change on a non-major bump. */
  flagged: boolean;
  /** Human-readable descriptions of each violation found. */
  reasons: string[];
}

// ---------------------------------------------------------------------------
// parseBumpType
// ---------------------------------------------------------------------------

/**
 * Compare two semver tag strings (with or without a leading "v") and return
 * the dimension that increased.  Returns "unknown" when either string cannot
 * be parsed as `major.minor.patch` or when the versions are identical.
 *
 * @example
 *   parseBumpType("v1.2.0", "v2.0.0") // "major"
 *   parseBumpType("1.2.0",  "1.3.0")  // "minor"
 *   parseBumpType("1.2.0",  "1.2.1")  // "patch"
 */
export function parseBumpType(base: string, head: string): BumpType {
  const parse = (tag: string): [number, number, number] | null => {
    // Strip optional leading "v"
    const raw = tag.startsWith("v") ? tag.slice(1) : tag;
    const parts = raw.split(".");
    if (parts.length !== 3) return null;
    const nums = parts.map(Number);
    if (nums.some((n) => !Number.isInteger(n) || Number.isNaN(n))) return null;
    return nums as [number, number, number];
  };

  const b = parse(base);
  const h = parse(head);
  if (!b || !h) return "unknown";

  const [bMaj, bMin, bPat] = b;
  const [hMaj, hMin, hPat] = h;

  if (hMaj > bMaj) return "major";
  if (hMin > bMin) return "minor";
  if (hPat > bPat) return "patch";
  return "unknown"; // identical or downgrade — cannot judge
}

// ---------------------------------------------------------------------------
// Internal pattern helpers
// ---------------------------------------------------------------------------

/**
 * Regex that matches a removed export declaration line in a unified diff.
 * Covers: export [default] function|class|const|let|var|type|interface|enum Name
 */
const REMOVED_EXPORT_RE =
  /^-\s*export\s+(default\s+)?(function|class|const|let|var|type|interface|enum)\s+\w+/;

/**
 * Regex that matches any removed function-declaration line (exported or not).
 * Captures the function name in group 1.
 */
const REMOVED_FN_RE =
  /^-\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/;

/**
 * Regex that matches any added function-declaration line (exported or not).
 * Captures the function name in group 1 and the full parameter list in group 2.
 */
const ADDED_FN_RE =
  /^\+\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/;

/**
 * Same structure for the removed variant — captures name in group 1 and
 * parameter list in group 2 so we can diff parameter lists.
 */
const REMOVED_FN_PARAMS_RE =
  /^-\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/;

/** Matches config files that may carry schema keys (.json / .yaml / .yml). */
const CONFIG_FILE_RE = /\.(json|ya?ml)$/i;

/** Lock files that should be excluded from config-schema checks. */
const LOCK_FILE_RE = /(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/i;

/** Removed key in a JSON object: `- "key":` */
const REMOVED_JSON_KEY_RE = /^-\s*"[\w-]+":\s*/;

/** Removed key in a YAML mapping: `- key:` */
const REMOVED_YAML_KEY_RE = /^-\s*[\w-]+:\s*/;

// ---------------------------------------------------------------------------
// Per-file breaking-change detectors
// ---------------------------------------------------------------------------

/** Returns true if the patch contains a removed public export declaration. */
function hasRemovedExport(patch: string): boolean {
  return patch.split("\n").some((line) => REMOVED_EXPORT_RE.test(line));
}

/**
 * Returns true if the patch shows a function whose signature changed:
 * a removed `function Name(…)` line paired with an added `function Name(…)`
 * line where the parameter lists differ.
 */
function hasChangedSignature(patch: string): boolean {
  const lines = patch.split("\n");

  // Build a map of  name → params  for removed function declarations.
  const removedSigs = new Map<string, string>();
  for (const line of lines) {
    const m = REMOVED_FN_PARAMS_RE.exec(line);
    if (m) removedSigs.set(m[1], m[2]);
  }

  if (removedSigs.size === 0) return false;

  // Check whether any added declaration shares a name but differs in params.
  for (const line of lines) {
    const m = ADDED_FN_RE.exec(line);
    if (m && removedSigs.has(m[1]) && removedSigs.get(m[1]) !== m[2]) {
      return true;
    }
  }
  return false;
}

/**
 * Returns true if this is a config file (json/yaml/yml, not a lock file or
 * package.json) whose patch shows a removed mapping key.
 */
function hasConfigSchemaChange(file: CommitFile, patch: string): boolean {
  const name = file.filename;

  if (!CONFIG_FILE_RE.test(name)) return false;
  if (LOCK_FILE_RE.test(name)) return false;
  // Exclude package.json — its "dependencies" churn is not a schema change.
  if (/(?:^|\/)package\.json$/.test(name)) return false;

  return patch
    .split("\n")
    .some(
      (line) => REMOVED_JSON_KEY_RE.test(line) || REMOVED_YAML_KEY_RE.test(line)
    );
}

// ---------------------------------------------------------------------------
// checkSemver
// ---------------------------------------------------------------------------

/**
 * Inspect every file in `commit` for breaking-change signals and flag the
 * result when those signals are incompatible with `bumpType`.
 *
 * Only "patch" and "minor" bumps can be flagged — "major" bumps are permitted
 * to contain breaking changes, and "unknown" means we lack enough information
 * to make a judgement.
 */
export function checkSemver(
  commit: CommitRecord,
  bumpType: BumpType
): SemverResult {
  // Major and unknown bumps are never flagged.
  if (bumpType === "major" || bumpType === "unknown") {
    return { flagged: false, reasons: [] };
  }

  let removedExport = false;
  let signatureChanged = false;
  let configSchemaChanged = false;

  for (const file of commit.files) {
    if (!file.patch) continue;

    if (!removedExport && hasRemovedExport(file.patch)) {
      removedExport = true;
    }
    if (!signatureChanged && hasChangedSignature(file.patch)) {
      signatureChanged = true;
    }
    if (!configSchemaChanged && hasConfigSchemaChange(file, file.patch)) {
      configSchemaChanged = true;
    }

    // Short-circuit once all three types are confirmed.
    if (removedExport && signatureChanged && configSchemaChanged) break;
  }

  const reasons: string[] = [];
  const prefix = `semver violation: breaking change detected in a ${bumpType} bump`;

  if (removedExport) reasons.push(`${prefix} (removed export)`);
  if (signatureChanged) reasons.push(`${prefix} (function signature changed)`);
  if (configSchemaChanged) reasons.push(`${prefix} (config schema change)`);

  return {
    flagged: reasons.length > 0,
    reasons,
  };
}
