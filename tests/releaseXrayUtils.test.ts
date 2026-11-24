import {
  buildReleaseXray,
  classifyFile,
  LARGE_RELEASE_FILE_THRESHOLD,
} from "../src/ui/releaseXrayUtils.js";
import type { CommitRecord } from "../src/github/types.js";
import type { CommitVerdict } from "../src/checks/types.js";

function commit(sha: string, filename: string): CommitRecord {
  return {
    sha,
    message: `change ${filename}`,
    files: [{ filename, additions: 2, deletions: 1, patch: "@@ -1 +1 @@" }],
  };
}

function verdict(sha: string, findings: CommitVerdict["findings"] = []): CommitVerdict {
  return { sha, message: `change ${sha}`, status: findings.length ? "adjusted" : "ok", reasons: [], findings };
}

describe("release X-ray model", () => {
  test("classifies path categories deterministically", () => {
    expect(classifyFile("src/components/Button.tsx")).toBe("UI / Components");
    expect(classifyFile("package.json")).toBe("Dependencies");
    expect(classifyFile("tests/check.test.ts")).toBe("Tests");
  });

  test("deduplicates files while retaining associated commits and accumulated activity", () => {
    const first = commit("one", "src/api/users.ts");
    const second = commit("two", "src/api/users.ts");
    const model = buildReleaseXray([first, second], [verdict("one"), verdict("two")]);
    expect(model.uniqueFiles).toBe(1);
    expect(model.files[0].commits.map((item) => item.commit.sha)).toEqual(["one", "two"]);
    expect(model.files[0].additions).toBe(4);
    expect(model.files[0].deletions).toBe(2);
  });

  test("only explicitly affected findings color a file", () => {
    const changed = commit("one", "src/api/users.ts");
    const finding = {
      check: "semver" as const,
      explanation: "signature changed",
      affectedFilenames: ["src/api/users.ts"],
    };
    const model = buildReleaseXray([changed], [verdict("one", [finding])]);
    expect(model.files[0].state).toBe("amber");
    expect(model.files[0].findings[0].affectedFilenames).toEqual(["src/api/users.ts"]);
  });

  test("keeps unavailable patches as unavailable evidence", () => {
    const changed = commit("one", "assets/logo.bin");
    changed.files[0].patch = null;
    const model = buildReleaseXray([changed], [verdict("one")]);
    expect(model.files[0].hasUnavailableEvidence).toBe(true);
    expect(model.files[0].state).toBe("unknown");
  });

  test("binary files are not green without patch evidence", () => {
    const binary = commit("binary", "assets/logo.bin");
    binary.files[0].patch = null;
    binary.files[0].status = "added";
    const model = buildReleaseXray([binary], [verdict("binary")]);
    expect(model.files[0].category).toBe("Unknown");
    expect(model.files[0].state).toBe("unknown");
    expect(model.files[0].statuses).toEqual(["added"]);
  });

  test("classifies unknown binary paths separately from ordinary code", () => {
    expect(classifyFile("assets/logo.bin")).toBe("Unknown");
    expect(classifyFile("src/index.ts")).toBe("Other");
  });

  test("gives documentation priority over configuration classification", () => {
    expect(classifyFile("docs/reference/example.yaml")).toBe("Documentation");
  });

  test("classifies Makefile under CI infrastructure", () => {
    expect(classifyFile("Makefile")).toBe("CI / Infrastructure");
  });

  test("groups 100 or more files into categories without omitting files", () => {
    const commits: CommitRecord[] = [];
    const verdicts: CommitVerdict[] = [];
    for (let i = 0; i < LARGE_RELEASE_FILE_THRESHOLD; i += 1) {
      const sha = `sha-${i}`;
      commits.push(commit(sha, `src/modules/file-${i}.ts`));
      verdicts.push(verdict(sha));
    }
    const model = buildReleaseXray(commits, verdicts);
    expect(model.uniqueFiles).toBe(100);
    expect(model.files).toHaveLength(100);
    expect(model.categories.reduce((count, group) => count + group.files.length, 0)).toBe(100);
  });

  test("merges rename old and new paths across commits", () => {
    const oldCommit = commit("old", "src/auth/old.ts");
    const renameCommit: CommitRecord = {
      sha: "rename",
      message: "rename auth file",
      files: [{
        filename: "src/auth/new.ts",
        previousFilename: "src/auth/old.ts",
        status: "renamed",
        additions: 3,
        deletions: 1,
        patch: "@@ rename @@",
      }],
    };
    const model = buildReleaseXray(
      [oldCommit, renameCommit],
      [verdict("old"), verdict("rename")]
    );
    expect(model.uniqueFiles).toBe(1);
    expect(model.files[0].filename).toBe("src/auth/new.ts");
    expect(model.files[0].previousFilenames).toEqual(["src/auth/old.ts"]);
    expect(model.files[0].commits.map((item) => item.commit.sha)).toEqual(["old", "rename"]);
  });

  test("preserves added, modified and removed statuses", () => {
    const commits: CommitRecord[] = [
      { sha: "a", message: "add", files: [{ filename: "src/a.ts", status: "added", additions: 1, deletions: 0, patch: "+a" }] },
      { sha: "m", message: "modify", files: [{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 1, patch: "-a\n+a" }] },
      { sha: "d", message: "delete", files: [{ filename: "src/a.ts", status: "removed", additions: 0, deletions: 1, patch: "-a" }] },
    ];
    const model = buildReleaseXray(commits, [
      verdict("a"),
      verdict("m"),
      verdict("d"),
    ]);
    expect(model.files[0].statuses).toEqual(["added", "modified", "removed"]);
  });

  test("represents mixed commit states without hiding explicit findings", () => {
    const sameFile = "src/api/users.ts";
    const finding = {
      check: "dependency" as const,
      explanation: "dependency major bump",
      affectedFilenames: [sameFile],
    };
    const model = buildReleaseXray(
      [commit("ok", sameFile), commit("flagged", sameFile)],
      [verdict("ok"), verdict("flagged", [finding])]
    );
    expect(model.files[0].state).toBe("mixed");
    expect(model.files[0].findings).toHaveLength(1);
  });

  test("missing patch evidence takes priority over mixed commit states", () => {
    const sameFile = "src/api/users.ts";
    const finding = {
      check: "dependency" as const,
      explanation: "dependency major bump",
      affectedFilenames: [sameFile],
    };
    const missing = commit("missing", sameFile);
    missing.files[0].patch = null;
    const model = buildReleaseXray(
      [missing, commit("ok", sameFile)],
      [verdict("missing", [finding]), verdict("ok")]
    );
    expect(model.files[0].state).toBe("unknown");
    expect(model.files[0].hasUnavailableEvidence).toBe(true);
  });

  test("an explicit area finding remains red even for an unknown category", () => {
    const binary = commit("binary", "assets/logo.bin");
    binary.files[0].patch = "@@ -1 +1 @@";
    const finding = {
      check: "area-mismatch" as const,
      explanation: "unknown path omitted by commit message",
      affectedFilenames: ["assets/logo.bin"],
    };
    const model = buildReleaseXray(
      [binary],
      [verdict("binary", [finding])]
    );
    expect(model.files[0].category).toBe("Unknown");
    expect(model.files[0].state).toBe("red");
  });

  test("preserves every old path across chained renames", () => {
    const commits: CommitRecord[] = [
      commit("old-a", "src/auth/a.ts"),
      {
        sha: "rename-b",
        message: "rename to b",
        files: [{ filename: "src/auth/b.ts", previousFilename: "src/auth/a.ts", status: "renamed", additions: 0, deletions: 0, patch: "@@ rename @@" }],
      },
      {
        sha: "rename-c",
        message: "rename to c",
        files: [{ filename: "src/auth/c.ts", previousFilename: "src/auth/b.ts", status: "renamed", additions: 0, deletions: 0, patch: "@@ rename @@" }],
      },
    ];
    const model = buildReleaseXray(commits, [
      verdict("old-a"),
      verdict("rename-b"),
      verdict("rename-c"),
    ]);
    expect(model.uniqueFiles).toBe(1);
    expect(model.files[0].filename).toBe("src/auth/c.ts");
    expect(model.files[0].previousFilenames).toEqual([
      "src/auth/a.ts",
      "src/auth/b.ts",
    ]);
    expect(model.files[0].commits.map((item) => item.commit.sha)).toEqual([
      "old-a",
      "rename-b",
      "rename-c",
    ]);
  });
});
