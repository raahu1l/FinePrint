import type { CommitVerdict, CheckFinding } from "../checks/types.js";
import type { CommitFile, CommitRecord } from "../github/types.js";

export const XRAY_CATEGORIES = [
  "UI / Components",
  "Backend / API",
  "Dependencies",
  "Tests",
  "Configuration",
  "Documentation",
  "CI / Infrastructure",
  "Unknown",
  "Other",
] as const;

export type XrayCategory = (typeof XRAY_CATEGORIES)[number];
export type XrayFileState = "red" | "amber" | "green" | "grey" | "mixed" | "unknown";
export type XrayFileStatus = NonNullable<CommitFile["status"]>;

export interface XrayCommit {
  commit: CommitRecord;
  verdict: CommitVerdict;
  file: CommitFile;
}

export interface XrayFile {
  filename: string;
  previousFilenames: string[];
  category: XrayCategory;
  commits: XrayCommit[];
  additions: number;
  deletions: number;
  state: XrayFileState;
  findings: Array<CheckFinding & { commitSha: string }>;
  hasUnavailableEvidence: boolean;
  statuses: XrayFileStatus[];
}

export interface XrayCategoryGroup {
  category: XrayCategory;
  files: XrayFile[];
}

export interface ReleaseFinding extends CheckFinding {
  commitSha: string;
  commitMessage: string;
}

export interface ReleaseXrayModel {
  files: XrayFile[];
  categories: XrayCategoryGroup[];
  findingItems: ReleaseFinding[];
  uniqueFiles: number;
  findings: number;
  analyzedCommits: number;
}

export const LARGE_RELEASE_FILE_THRESHOLD = 100;

export function classifyFile(filename: string): XrayCategory {
  const path = filename.toLowerCase();
  const basename = path.split("/").pop() ?? path;
  if (
    /(^|\/)(docs?|documentation)(\/|$)/.test(path) ||
    /(^|\/)(readme|changelog|contributing)(\.[^.]+)?$/.test(basename)
  ) {
    return "Documentation";
  }
  if (/(^|\/)(test|tests|__tests__|spec)(\/|$)|\.(test|spec)\.[^.]+$/.test(path)) {
    return "Tests";
  }
  if (
    /(^|\/)(ui|components|src\/ui|src\/components)(\/|$)/.test(path) ||
    /\.(tsx|jsx)$/.test(path)
  ) {
    return "UI / Components";
  }
  if (
    /(^|\/)(api|routes|server|backend|src\/api|src\/routes)(\/|$)/.test(path) ||
    /(^|\/)(api|server)\.[^.]+$/.test(path)
  ) {
    return "Backend / API";
  }
  if (
    /(^|\/)(package(-lock)?\.json|yarn\.lock|pnpm-lock\.yaml|requirements\.txt|pipfile|gemfile(\.lock)?|go\.(mod|sum)|pom\.xml|build\.gradle(\.kts)?)$/.test(
      path
    )
  ) {
    return "Dependencies";
  }
  if (
    /(^|\/)(\.github|\.circleci|\.gitlab-ci\.yml|dockerfile|Makefile|scripts)(\/|$)/.test(
      path
    ) ||
    /^makefile$/.test(path) ||
    /(^|\/)makefile$/.test(path)
  ) {
    return "CI / Infrastructure";
  }
  if (
    /(^|\/)(config|src\/config)(\/|$)/.test(path) ||
    /\.(ya?ml|toml|ini|env|json)$/.test(path)
  ) {
    return "Configuration";
  }
  if (
    /\.(ts|tsx|js|jsx|c|cc|cpp|h|hpp|py|rs|java|rb|php|swift|kt|kts|cs|sh|sql|html|css|scss|vue|svelte|xml|properties|txt)$/.test(
      path
    )
  ) {
    return "Other";
  }
  return "Unknown";
}

function stateForCommits(
  commits: XrayCommit[],
  findings: XrayFile["findings"],
  hasUnavailableEvidence: boolean,
  category: XrayCategory
): XrayFileState {
  if (commits.length === 0) return "grey";
  if (commits.every(({ verdict }) => verdict.status === "mechanical")) return "grey";
  if (hasUnavailableEvidence) return "unknown";
  const states = commits.map(({ verdict, file }) => {
    if (verdict.status === "mechanical") return "grey";
    if (verdict.findings?.some((finding) =>
      finding.check === "area-mismatch" &&
      finding.affectedFilenames?.some((filename) => filename === file.filename || filename === file.previousFilename)
    )) {
      return "red";
    }
    if (verdict.findings?.some((finding) =>
      (finding.check === "semver" || finding.check === "dependency") &&
      finding.affectedFilenames?.some((filename) => filename === file.filename || filename === file.previousFilename)
    )) {
      return "amber";
    }
    return "green";
  });
  const unique = [...new Set(states)];
  if (unique.length > 1) return "mixed";
  if (unique[0] === "grey") return "grey";
  if (findings.length > 0) {
    return findings.some((finding) => finding.check === "area-mismatch") ? "red" : "amber";
  }
  if (category === "Unknown") return "unknown";
  return unique[0] ?? "grey";
}

export function buildReleaseXray(
  commits: CommitRecord[],
  verdicts: CommitVerdict[]
): ReleaseXrayModel {
  const verdictBySha = new Map(verdicts.map((verdict) => [verdict.sha, verdict]));
  const filesByName = new Map<string, XrayFile>();
  const renameAliases = new Map<string, string>();
  const findingItems: ReleaseFinding[] = [];

  for (const verdict of verdicts) {
    for (const finding of verdict.findings ?? []) {
      findingItems.push({
        ...finding,
        commitSha: verdict.sha,
        commitMessage: verdict.message,
      });
    }
  }

  for (const commit of commits) {
    for (const file of commit.files) {
      if (file.previousFilename) {
        renameAliases.set(file.previousFilename, file.filename);
      }
    }
  }

  const resolveFilename = (filename: string): string => {
    let resolved = filename;
    const visited = new Set<string>();
    while (renameAliases.has(resolved) && !visited.has(resolved)) {
      visited.add(resolved);
      resolved = renameAliases.get(resolved)!;
    }
    return resolved;
  };

  for (const commit of commits) {
    const verdict = verdictBySha.get(commit.sha);
    if (!verdict) continue;
    for (const file of commit.files) {
      const logicalFilename = resolveFilename(file.filename);
      const current = filesByName.get(logicalFilename);
      const entry = current ?? {
        filename: logicalFilename,
        previousFilenames: [],
        category: classifyFile(logicalFilename),
        commits: [],
        additions: 0,
        deletions: 0,
        state: "grey" as XrayFileState,
        findings: [],
        hasUnavailableEvidence: false,
        statuses: [],
      };
      entry.commits.push({ commit, verdict, file });
      entry.additions += file.additions;
      entry.deletions += file.deletions;
      entry.hasUnavailableEvidence ||= file.patch === null;
      if (file.status && !entry.statuses.includes(file.status)) {
        entry.statuses.push(file.status);
      }
      if (file.filename !== logicalFilename && !entry.previousFilenames.includes(file.filename)) {
        entry.previousFilenames.push(file.filename);
      }
      if (file.previousFilename && !entry.previousFilenames.includes(file.previousFilename)) {
        entry.previousFilenames.push(file.previousFilename);
      }
      for (const finding of verdict.findings ?? []) {
        if (finding.affectedFilenames?.some((filename) => resolveFilename(filename) === logicalFilename)) {
          entry.findings.push({ ...finding, commitSha: commit.sha });
        }
      }
      filesByName.set(logicalFilename, entry);
    }
  }

  const files = [...filesByName.values()]
    .map((file) => ({
      ...file,
      state: stateForCommits(file.commits, file.findings, file.hasUnavailableEvidence, file.category),
    }))
    .sort((a, b) => a.filename.localeCompare(b.filename));
  const categories = XRAY_CATEGORIES.map((category) => ({
    category,
    files: files.filter((file) => file.category === category),
  })).filter((group) => group.files.length > 0);

  return {
    files,
    categories,
    findingItems,
    uniqueFiles: files.length,
    findings: verdicts.reduce((count, verdict) => count + (verdict.findings?.length ?? 0), 0),
    analyzedCommits: commits.length,
  };
}
