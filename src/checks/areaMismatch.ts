
import type { CommitRecord } from "../github/types.js";

export interface UndisclosedDiff {
  files: string[];
  additions: number;
  deletions: number;
  sampleSnippet: string | null;
}

export interface AreaMismatchResult {
  flagged: boolean;
  reasons: string[];
  undisclosedDiff?: UndisclosedDiff;
}

interface AreaRule {
  prefixes?: string[];
  filenames?: string[];
  extensions?: string[];
}

const AREA_RULES: Record<string, AreaRule> = {
  auth: {
    prefixes: ["auth/", "src/auth/", "authentication/"],
  },
  ui: {
    prefixes: [
      "ui/",
      "src/ui/",
      "components/",
      "src/components/",
      "views/",
      "src/views/",
      "pages/",
      "src/pages/",
    ],
  },
  api: {
    prefixes: ["api/", "src/api/", "routes/", "src/routes/", "controllers/"],
  },
  db: {
    prefixes: [
      "db/",
      "src/db/",
      "database/",
      "migrations/",
      "prisma/",
      "drizzle/",
    ],
  },
  test: {
    prefixes: [
      "test/",
      "tests/",
      "__tests__/",
      "spec/",
      "specs/",
      "test-results/",
    ],
    extensions: [".test.ts", ".test.tsx", ".test.js", ".spec.ts", ".spec.js"],
  },
  docs: {
    prefixes: [
      "docs/",
      "doc/",
      "documentation/",
      "wiki/",
    ],
    filenames: [
      "README",
      "README.md",
      "README.rst",
      "CHANGELOG",
      "CHANGELOG.md",
      "CHANGES",
      "CONTRIBUTING",
      "CONTRIBUTING.md",
      "CODE_OF_CONDUCT.md",
      "LICENSE",
      "LICENSE.md",
    ],
    extensions: [
      ".md",
      ".mdx",
      ".rst",
      ".adoc",
    ],
  },
  config: {
    prefixes: [
      "config/",
      "src/config/",
    ],
    filenames: [
      ".editorconfig",
      ".prettierrc",
      ".eslintrc",
      "tsconfig.json",
      "vite.config.ts",
      "webpack.config.js",
    ],
  },
  deps: {
    filenames: [
      "package.json",
      "package-lock.json",
      "yarn.lock",
      "pnpm-lock.yaml",
      "requirements.txt",
      "requirements-dev.txt",
      "pyproject.toml",
      "poetry.lock",
      "Pipfile",
      "Pipfile.lock",
      "pom.xml",
      "build.gradle",
      "build.gradle.kts",
      "Gemfile",
      "Gemfile.lock",
      "go.mod",
      "go.sum",
      "Cargo.toml",
      "Cargo.lock",
    ],
  },
  ci: {
    prefixes: [
      ".github/workflows/",
      ".circleci/",
      ".buildkite/",
      ".gitlab/",
    ],
    filenames: [
      ".travis.yml",
      "Jenkinsfile",
      "azure-pipelines.yml",
    ],
  },
};

const KEYWORD_TO_AREA: Record<string, string> = {
  // Authentication
  auth: "auth",
  authentication: "auth",
  security: "auth",

  // UI
  ui: "ui",
  frontend: "ui",
  interface: "ui",
  component: "ui",
  components: "ui",

  // API
  api: "api",
  endpoint: "api",
  endpoints: "api",
  route: "api",
  routes: "api",

  // Database
  db: "db",
  database: "db",
  databases: "db",
  migration: "db",
  migrations: "db",
  schema: "db",

  // Tests
  test: "test",
  tests: "test",
  testing: "test",
  spec: "test",
  specs: "test",

  // Documentation
  doc: "docs",
  docs: "docs",
  documentation: "docs",
  readme: "docs",
  changelog: "docs",
  release: "docs",
  "release notes": "docs",
  guide: "docs",
  guides: "docs",

  // Configuration
  config: "config",
  configuration: "config",
  settings: "config",

  // Dependencies
  deps: "deps",
  dependency: "deps",
  dependencies: "deps",

  // CI
  ci: "ci",
  "continuous integration": "ci",
  pipeline: "ci",
  pipelines: "ci",
};

function normalizePath(filename: string): string {
  return filename.replace(/\\/g, "/").replace(/^\.\/+/, "").toLowerCase();
}

function areasForFile(filename: string): string[] {
  const normalized = normalizePath(filename);
  const basename = normalized.split("/").pop() ?? normalized;
  const matched: string[] = [];

  for (const [area, rule] of Object.entries(AREA_RULES)) {
    const prefixMatch = rule.prefixes?.some((prefix) =>
      normalized.startsWith(prefix.toLowerCase())
    );

    const filenameMatch = rule.filenames?.some(
      (name) => basename === name.toLowerCase()
    );

    const extensionMatch = rule.extensions?.some((extension) =>
      basename.endsWith(extension)
    );

    if (prefixMatch || filenameMatch || extensionMatch) {
      matched.push(area);
    }
  }

  return matched;
}

function claimedAreas(message: string): Set<string> {
  const normalized = message.toLowerCase();
  const claimed = new Set<string>();

  for (const [keyword, area] of Object.entries(KEYWORD_TO_AREA)) {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(?:^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, "i");

    if (pattern.test(normalized)) {
      claimed.add(area);
    }
  }

  return claimed;
}

export function checkAreaMismatch(commit: CommitRecord): AreaMismatchResult {
  const claimed = claimedAreas(commit.message);
  const undisclosedByArea = new Map<string, typeof commit.files[number][]>();

  for (const file of commit.files) {
    const areas = areasForFile(file.filename);

    for (const area of areas) {
      if (claimed.has(area)) {
        continue;
      }

      if (!undisclosedByArea.has(area)) {
        undisclosedByArea.set(area, []);
      }

      undisclosedByArea.get(area)!.push(file);
    }
  }

  if (undisclosedByArea.size === 0) {
    return { flagged: false, reasons: [] };
  }

  const reasons: string[] = [];
  const seenFilenames = new Set<string>();
  const undisclosedFiles: typeof commit.files[number][] = [];

  for (const [area, files] of undisclosedByArea) {
    reasons.push(`area changed but not mentioned in commit message: ${area}`);

    for (const file of files) {
      if (seenFilenames.has(file.filename)) {
        continue;
      }

      seenFilenames.add(file.filename);
      undisclosedFiles.push(file);
    }
  }

  const undisclosedDiff: UndisclosedDiff = {
    files: undisclosedFiles.map((file) => file.filename),
    additions: undisclosedFiles.reduce(
      (total, file) => total + file.additions,
      0
    ),
    deletions: undisclosedFiles.reduce(
      (total, file) => total + file.deletions,
      0
    ),
    sampleSnippet: undisclosedFiles.find((file) => file.patch)?.patch ?? null,
  };

  return {
    flagged: true,
    reasons,
    undisclosedDiff,
  };
}
