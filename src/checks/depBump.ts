/**
 * depBump.ts
 *
 * Check-logic module that inspects a CommitRecord for dependency manifest files
 * and flags any major-version bumps found in their patches.
 */

import type { CommitRecord } from "../github/types.js";

export interface DepBumpResult {
  flagged: boolean;
  reasons: string[];
}

/** Manifest basenames that will be inspected (compared case-insensitively). */
const MANIFEST_FILES = new Set([
  "package.json",
  "pom.xml",
  "build.gradle",
  "requirements.txt",
  "pipfile",
  "gemfile",
  "go.mod",
  "build.gradle.kts",
]);

// ---------------------------------------------------------------------------
// Regex helpers
// ---------------------------------------------------------------------------

/** package.json: `"package-name": "1.2.3"` on a diff line. */
const PKG_JSON_LINE =
  /^([-+])\s*"([\w@/.-]+)":\s*"[^"]*?(\d+)\.\d+\.\d+[^"]*"/;

/** requirements.txt: `package>=1.2` on a diff line. */
const REQS_LINE = /^([-+])([\w-]+)[>=<!~^]+.*?(\d+)\.\d+/;

/** go.mod: `module/path v1.2.3` on a diff line. */
const GOMOD_LINE = /^([-+])\s*([\w./\-]+)\s+v(\d+)\./;

/** pom.xml / build.gradle version field on a diff line (two variants). */
const GRADLE_POM_LINE =
  /^([-+]).*(?:<version>(\d+)\.\d+|version\s*[=:'"]?\s*['"]?(\d+)\.\d+)/;

// ---------------------------------------------------------------------------
// Per-format parsers
// ---------------------------------------------------------------------------

/**
 * Parse a patch using the provided line-level regex.
 * Collects {name, major} pairs for removed (-) and added (+) lines, then
 * compares same-named packages for a major-version increase.
 */
function parsePairedLines(
  lines: string[],
  lineRe: RegExp,
  nameGroup: number,
  majorGroup: number
): string[] {
  const removed = new Map<string, number>(); // name → old major
  const added = new Map<string, number>(); // name → new major

  for (const line of lines) {
    const m = lineRe.exec(line);
    if (!m) continue;
    const sign = m[1];
    const name = m[nameGroup];
    const major = parseInt(m[majorGroup], 10);
    if (sign === "-") {
      // Keep the smallest old major seen (conservative).
      if (!removed.has(name) || removed.get(name)! > major) {
        removed.set(name, major);
      }
    } else {
      // Keep the largest new major seen.
      if (!added.has(name) || added.get(name)! < major) {
        added.set(name, major);
      }
    }
  }

  const reasons: string[] = [];
  for (const [name, oldMajor] of removed) {
    const newMajor = added.get(name);
    if (newMajor !== undefined && newMajor > oldMajor) {
      reasons.push(
        `dependency major-version bump: ${name} ${oldMajor}.x → ${newMajor}.x`
      );
    }
  }
  return reasons;
}

/**
 * Parse package.json patch lines.
 * Group indices: 1=sign, 2=name, 3=major.
 */
function parsePackageJson(lines: string[]): string[] {
  return parsePairedLines(lines, PKG_JSON_LINE, 2, 3);
}

/**
 * Parse requirements.txt patch lines.
 * Group indices: 1=sign, 2=name, 3=major.
 */
function parseRequirements(lines: string[]): string[] {
  return parsePairedLines(lines, REQS_LINE, 2, 3);
}

/**
 * Parse go.mod patch lines.
 * Group indices: 1=sign, 2=module path, 3=major.
 */
function parseGoMod(lines: string[]): string[] {
  return parsePairedLines(lines, GOMOD_LINE, 2, 3);
}

/**
 * Parse pom.xml / build.gradle patch lines.
 * Because isolating the exact artifact name from generic version tags is
 * unreliable, we use the heuristic: if ANY version string in the patch
 * shows a major-version increase (removed major < added major), flag the file.
 *
 * Returns a single reason string (or empty array) using the filename.
 */
function parseGradlePom(lines: string[], filename: string): string[] {
  const removedMajors: number[] = [];
  const addedMajors: number[] = [];

  for (const line of lines) {
    const m = GRADLE_POM_LINE.exec(line);
    if (!m) continue;
    // One of the two capture groups will be defined.
    const major = parseInt(m[2] ?? m[3], 10);
    if (m[1] === "-") {
      removedMajors.push(major);
    } else {
      addedMajors.push(major);
    }
  }

  // Flag if the minimum old major is strictly less than the maximum new major.
  if (removedMajors.length > 0 && addedMajors.length > 0) {
    const minOld = Math.min(...removedMajors);
    const maxNew = Math.max(...addedMajors);
    if (maxNew > minOld) {
      return [`dependency major-version bump detected in ${filename}`];
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/**
 * Route a manifest file's patch to the correct parser based on the basename.
 */
function parseManifest(basename: string, patch: string): string[] {
  const lines = patch.split("\n");

  switch (basename) {
    case "package.json":
      return parsePackageJson(lines);

    case "requirements.txt":
    case "pipfile":
    case "gemfile":
      return parseRequirements(lines);

    case "go.mod":
      return parseGoMod(lines);

    case "pom.xml":
    case "build.gradle":
    case "build.gradle.kts":
      return parseGradlePom(lines, basename);

    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Inspect a commit for dependency-manifest changes that contain major-version
 * bumps.  Returns a {@link DepBumpResult} describing whether any were found
 * and why.
 */
export function checkDepBump(commit: CommitRecord): DepBumpResult {
  const reasons: string[] = [];

  for (const file of commit.files) {
    if (file.patch === null) continue;

    // Compare only the basename, case-insensitively.
    const basename = file.filename.split("/").pop()!.toLowerCase();
    if (!MANIFEST_FILES.has(basename)) continue;

    const fileReasons = parseManifest(basename, file.patch);
    reasons.push(...fileReasons);
  }

  return {
    flagged: reasons.length > 0,
    reasons,
  };
}
