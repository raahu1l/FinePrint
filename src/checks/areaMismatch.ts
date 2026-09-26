import type { CommitRecord } from "../github/types.js";

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

export interface UndisclosedDiff {
  /** Filenames of the undisclosed files */
  files: string[];
  /** Total additions across undisclosed files */
  additions: number;
  /** Total deletions across undisclosed files */
  deletions: number;
  /** Patch of the FIRST undisclosed file, or null if none available */
  sampleSnippet: string | null;
}

export interface AreaMismatchResult {
  flagged: boolean;
  reasons: string[];
  undisclosedDiff?: UndisclosedDiff;
}

// ---------------------------------------------------------------------------
// Area mapping
// ---------------------------------------------------------------------------

/**
 * Each entry maps an area key to either:
 *   - `prefixes`: filename must start with one of these strings
 *   - `filenames`: filename must exactly match one of these strings
 *
 * Multiple keyword aliases for the same area share the same prefixes/filenames.
 */
interface AreaRule {
  prefixes?: string[];
  filenames?: string[];
}

const AREA_RULES: Record<string, AreaRule> = {
  auth: { prefixes: ["auth/", "src/auth/"] },
  ui: { prefixes: ["ui/", "src/ui/", "components/", "src/components/"] },
  api: { prefixes: ["api/", "src/api/", "routes/", "src/routes/"] },
  db: { prefixes: ["db/", "src/db/", "database/", "migrations/"] },
  test: { prefixes: ["test/", "tests/", "__tests__/", "spec/"] },
  docs: { prefixes: ["docs/", "doc/"] },
  config: { prefixes: [".github/", "config/", "src/config/"] },
  deps: {
    filenames: [
      "package.json",
      "package-lock.json",
      "yarn.lock",
      "pnpm-lock.yaml",
      "requirements.txt",
      "pom.xml",
      "build.gradle",
      "Gemfile",
      "Gemfile.lock",
      "go.mod",
      "go.sum",
    ],
  },
  ci: { prefixes: [".github/workflows/", ".circleci/", ".gitlab-ci.yml"] },
};

/**
 * Keyword → canonical area key.
 * Aliases ("tests", "dependency", "dependencies") collapse into the same key.
 */
const KEYWORD_TO_AREA: Record<string, string> = {
  auth: "auth",
  ui: "ui",
  api: "api",
  db: "db",
  test: "test",
  tests: "test",
  docs: "docs",
  config: "config",
  deps: "deps",
  dependency: "deps",
  dependencies: "deps",
  ci: "ci",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns all area keys that a filename belongs to. */
function areasForFile(filename: string): string[] {
  const matched: string[] = [];
  for (const [area, rule] of Object.entries(AREA_RULES)) {
    if (rule.prefixes?.some((p) => filename.startsWith(p))) {
      matched.push(area);
    } else if (rule.filenames?.includes(filename)) {
      matched.push(area);
    }
  }
  return matched;
}

/** Returns all area keys claimed in a commit message (whole-word, case-insensitive). */
function claimedAreas(message: string): Set<string> {
  const claimed = new Set<string>();
  for (const keyword of Object.keys(KEYWORD_TO_AREA)) {
    // \b matches word boundaries; the 'i' flag makes it case-insensitive.
    const re = new RegExp(`\\b${keyword}\\b`, "i");
    if (re.test(message)) {
      claimed.add(KEYWORD_TO_AREA[keyword]);
    }
  }
  return claimed;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Checks whether a commit touches areas that are not mentioned in its message.
 *
 * A file is "undisclosed" when ALL of its matched areas are absent from the
 * commit message.  Files that match no area at all are silently ignored.
 */
export function checkAreaMismatch(commit: CommitRecord): AreaMismatchResult {
  const claimed = claimedAreas(commit.message);

  // Collect undisclosed files, grouped by their (first) undisclosed area key
  // so we can emit one reason string per area.
  const undisclosedByArea = new Map<string, typeof commit.files[number][]>();

  for (const file of commit.files) {
    const areas = areasForFile(file.filename);

    // Ignore files that belong to no known area.
    if (areas.length === 0) continue;

    // If at least one of the file's areas is claimed, the file is disclosed.
    if (areas.some((a) => claimed.has(a))) continue;

    // All areas for this file are undisclosed — attribute to each undisclosed area.
    for (const area of areas) {
      if (!undisclosedByArea.has(area)) undisclosedByArea.set(area, []);
      undisclosedByArea.get(area)!.push(file);
    }
  }

  if (undisclosedByArea.size === 0) {
    return { flagged: false, reasons: [] };
  }

  // Build reasons (one per undisclosed area).
  const reasons: string[] = [];
  // Deduplicate files across areas for the diff summary.
  const seenFilenames = new Set<string>();
  const undisclosedFiles: typeof commit.files[number][] = [];

  for (const [area, files] of undisclosedByArea) {
    reasons.push(`area changed but not mentioned in commit message: ${area}`);
    for (const f of files) {
      if (!seenFilenames.has(f.filename)) {
        seenFilenames.add(f.filename);
        undisclosedFiles.push(f);
      }
    }
  }

  const undisclosedDiff: UndisclosedDiff = {
    files: undisclosedFiles.map((f) => f.filename),
    additions: undisclosedFiles.reduce((s, f) => s + f.additions, 0),
    deletions: undisclosedFiles.reduce((s, f) => s + f.deletions, 0),
    sampleSnippet: undisclosedFiles[0]?.patch ?? null,
  };

  return { flagged: true, reasons, undisclosedDiff };
}
