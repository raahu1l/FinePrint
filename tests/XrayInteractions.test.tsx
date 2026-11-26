/**
 * @jest-environment jsdom
 */

import React from "react";
import { jest } from "@jest/globals";
import { fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import {
  FileDetails,
  FindingSummary,
  findingKey,
  normalizeRepositoryInput,
  Report,
  resolveFindingFiles,
  resolveFindingSelection,
  Scanner,
} from "../src/ui/App.js";
import { buildReleaseXray } from "../src/ui/releaseXrayUtils.js";
import type { CommitRecord } from "../src/github/types.js";
import type { CommitVerdict, CheckFinding } from "../src/checks/types.js";

test("finding navigation selects the associated file and commit", () => {
  const commits: CommitRecord[] = [{
    sha: "commit-a",
    message: "change api",
    files: [{
      filename: "src/api/users.ts",
      status: "modified",
      additions: 2,
      deletions: 1,
      patch: "-old\n+new",
    }],
  }];
  const finding: CheckFinding = {
    check: "semver",
    explanation: "semver violation: function signature changed",
    affectedFilenames: ["src/api/users.ts"],
  };
  const verdict: CommitVerdict = {
    sha: "commit-a",
    message: "change api",
    status: "adjusted",
    reasons: [finding.explanation],
    findings: [finding],
  };
  const model = buildReleaseXray(commits, [verdict]);
  const file = model.files[0];

  const selection = resolveFindingSelection(model, "commit-a", finding);
  expect(selection.file?.filename).toBe("src/api/users.ts");
  expect(selection.commitSha).toBe("commit-a");

  const onFinding = jest.fn();
  render(
    <FileDetails
      file={file}
      owner="owner"
      repo="repo"
      initialCommitSha="commit-a"
      selectedFindingKey={findingKey("commit-a", finding)}
      onFinding={onFinding}
    />
  );

  const findingButton = screen.getByRole("button", {
    name: /semver.*function signature changed/i,
  });
  expect(findingButton).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(findingButton);
  expect(onFinding).toHaveBeenCalledWith("commit-a", finding);
});

test("finding summary keeps commit-level findings visible and navigable", () => {
  const commit: CommitRecord = {
    sha: "commit-b",
    message: "change behavior",
    files: [{
      filename: "src/runtime.ts",
      status: "modified",
      additions: 1,
      deletions: 1,
      patch: "-old\n+new",
    }],
  };
  const finding: CheckFinding = {
    check: "semver",
    explanation: "breaking behavior detected",
  };
  const verdict: CommitVerdict = {
    sha: "commit-b",
    message: commit.message,
    status: "adjusted",
    reasons: [finding.explanation],
    findings: [finding],
  };
  const model = buildReleaseXray([commit], [verdict]);
  const onFinding = jest.fn();

  render(
    <FindingSummary
      model={model}
      onFinding={onFinding}
      selectedFindingKey={findingKey("commit-b", finding)}
    />
  );

  expect(screen.getByText("Commit-level finding; exact affected file unavailable")).toBeInTheDocument();
  const evidenceButton = screen.getByRole("button", { name: /view evidence/i });
  expect(evidenceButton).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(evidenceButton);
  expect(onFinding).toHaveBeenCalledWith(
    "commit-b",
    expect.objectContaining(finding)
  );
});

test("finding cards remove repeated area details and keep summary counts distinct", () => {
  const commits: CommitRecord[] = [
    {
      sha: "commit-one",
      message: "update ui and docs",
      files: [
        { filename: "src/ui/App.tsx", status: "modified", additions: 1, deletions: 1, patch: "-old\n+new" },
        { filename: "tests/App.test.tsx", status: "modified", additions: 1, deletions: 0, patch: "+test" },
        { filename: "src/api/client.ts", status: "modified", additions: 1, deletions: 0, patch: "+api" },
        { filename: "docs/README.md", status: "modified", additions: 1, deletions: 0, patch: "+docs" },
      ],
    },
    {
      sha: "commit-two",
      message: "update package",
      files: [{ filename: "package.json", status: "modified", additions: 1, deletions: 1, patch: "-1\n+2" }],
    },
  ];
  const verdicts: CommitVerdict[] = [
    {
      sha: "commit-one",
      message: commits[0].message,
      status: "adjusted",
      reasons: [],
      findings: [
        {
          check: "area-mismatch",
          explanation: "area changed but not mentioned in commit message: test; area changed but not mentioned in commit message: api",
          affectedFilenames: ["tests/App.test.tsx", "src/api/client.ts", "src/ui/App.tsx"],
        },
        {
          check: "semver",
          explanation: "semver violation: function signature changed",
          affectedFilenames: ["src/api/client.ts"],
        },
      ],
    },
    {
      sha: "commit-two",
      message: commits[1].message,
      status: "adjusted",
      reasons: [],
      findings: [{
        check: "dependency",
        explanation: "dependency major bump",
        affectedFilenames: ["package.json"],
      }],
    },
  ];
  const model = buildReleaseXray(commits, verdicts);
  render(<FindingSummary model={model} onFinding={jest.fn()} />);

  expect(screen.getByRole("heading", {
    name: "2 commits · 3 findings · 2 undeclared areas · 4 affected files",
  })).toBeInTheDocument();
  expect(screen.getAllByRole("article")).toHaveLength(3);
  const cards = screen.getAllByRole("article");
  expect(cards[0]).toHaveTextContent("Other changed areas: Documentation · UI / Components");
  expect(screen.getByText(/tests\/App\.test\.tsx, src\/api\/client\.ts \+ 1 more files/)).toBeInTheDocument();
  expect(screen.getByText("Changes in Tests and Backend / API were detected but not mentioned in the commit message.")).toBeInTheDocument();
  expect(screen.queryByText(/Actual diff areas|Declared areas|area changed but not mentioned in commit message/)).not.toBeInTheDocument();
  expect(screen.getByText("A major dependency-version increase was detected.")).toBeInTheDocument();
});

test("finding file resolution stays within its commit and never chooses an unrelated file", () => {
  const first: CommitRecord = {
    sha: "commit-a",
    message: "change ui",
    files: [{ filename: "src/ui/a.tsx", status: "modified", additions: 1, deletions: 0, patch: "+a" }],
  };
  const second: CommitRecord = {
    sha: "commit-b",
    message: "change ui",
    files: [{ filename: "src/ui/b.tsx", status: "modified", additions: 1, deletions: 0, patch: "+b" }],
  };
  const finding: CheckFinding = {
    check: "area-mismatch",
    explanation: "area changed but not mentioned in commit message: ui",
    affectedFilenames: ["src/ui/b.tsx"],
  };
  const model = buildReleaseXray([first, second], [
    { sha: "commit-a", message: first.message, status: "ok", reasons: [] },
    { sha: "commit-b", message: second.message, status: "adjusted", reasons: [], findings: [finding] },
  ]);
  expect(resolveFindingFiles(model, "commit-a", finding)).toEqual([]);
  expect(resolveFindingSelection(model, "commit-a", finding).file).toBeNull();
  expect(resolveFindingSelection(model, "commit-b", finding).file?.filename).toBe("src/ui/b.tsx");
});

test("finding selection navigates between actual file patches and back without stale evidence", () => {
  const commits: CommitRecord[] = [
    {
      sha: "commit-a",
      message: "change ui",
      files: [
        { filename: "src/ui/a.tsx", status: "modified", additions: 1, deletions: 1, patch: "-old-a\n+new-a" },
        { filename: "src/ui/b.tsx", status: "modified", additions: 1, deletions: 1, patch: "-old-b\n+new-b" },
      ],
    },
    {
      sha: "commit-b",
      message: "change api",
      files: [{ filename: "src/api/c.ts", status: "modified", additions: 1, deletions: 1, patch: "-old-c\n+new-c" }],
    },
  ];
  const findingA: CheckFinding = {
    check: "area-mismatch",
    explanation: "area changed but not mentioned in commit message: ui",
    affectedFilenames: ["src/ui/a.tsx", "src/ui/b.tsx"],
  };
  const findingB: CheckFinding = {
    check: "semver",
    explanation: "semver violation: signature changed",
    affectedFilenames: ["src/api/c.ts"],
  };
  const verdicts: CommitVerdict[] = [
    { sha: "commit-a", message: commits[0].message, status: "adjusted", reasons: [], findings: [findingA] },
    { sha: "commit-b", message: commits[1].message, status: "adjusted", reasons: [], findings: [findingB] },
  ];
  const originalScroll = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = jest.fn();
  try {
    render(<Report
      data={{ owner: "owner", repo: "repo", base: "v1", head: "v2", commits, verdicts, totalCommits: 2 }}
      onReset={jest.fn()}
    />);
    const evidenceButtons = screen.getAllByRole("button", { name: /view evidence/i });
    fireEvent.click(evidenceButtons[0]);
    expect(screen.getByRole("heading", { name: "src/ui/a.tsx" })).toBeInTheDocument();
    expect(document.querySelector(".diff-view")?.textContent).toContain("-old-a\n+new-a");

    fireEvent.click(screen.getByRole("button", { name: "src/ui/b.tsx" }));
    expect(screen.getByRole("heading", { name: "src/ui/b.tsx" })).toBeInTheDocument();
    expect(document.querySelector(".diff-view")?.textContent).toContain("-old-b\n+new-b");
    expect(document.querySelector(".diff-view")?.textContent).not.toContain("-old-a\n+new-a");

    fireEvent.click(evidenceButtons[1]);
    expect(screen.getByRole("heading", { name: "src/api/c.ts" })).toBeInTheDocument();
    expect(document.querySelector(".diff-view")?.textContent).toContain("-old-c\n+new-c");
    expect(document.querySelector(".diff-view")?.textContent).not.toContain("-old-b\n+new-b");
    expect(document.getElementById("findings-overview")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to findings" })).toHaveAttribute("href", "#findings-overview");
    expect(evidenceButtons[1]).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("link", { name: "Back to findings" }));
    expect(evidenceButtons[1]).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("heading", { name: "src/api/c.ts" })).toBeInTheDocument();
  } finally {
    if (originalScroll) Element.prototype.scrollIntoView = originalScroll;
    else delete (Element.prototype as Partial<Element>).scrollIntoView;
  }
});

test("switching findings on the same logical file selects the matching commit patch", () => {
  const filename = "src/ui/shared.tsx";
  const commits: CommitRecord[] = [
    { sha: "commit-first", message: "first change", files: [{ filename, status: "modified", additions: 1, deletions: 1, patch: "-first\n+first-new" }] },
    { sha: "commit-second", message: "second change", files: [{ filename, status: "modified", additions: 1, deletions: 1, patch: "-second\n+second-new" }] },
  ];
  const findings: CheckFinding[] = [
    { check: "area-mismatch", explanation: "area changed but not mentioned in commit message: ui", affectedFilenames: [filename] },
    { check: "semver", explanation: "semver violation: changed signature", affectedFilenames: [filename] },
  ];
  const verdicts: CommitVerdict[] = commits.map((commit, index) => ({
    sha: commit.sha,
    message: commit.message,
    status: "adjusted",
    reasons: [],
    findings: [findings[index]],
  }));
  const originalScroll = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = jest.fn();
  try {
    render(<Report
      data={{ owner: "owner", repo: "repo", base: "v1", head: "v2", commits, verdicts, totalCommits: 2 }}
      onReset={jest.fn()}
    />);
    const evidenceButtons = screen.getAllByRole("button", { name: /view evidence/i });
    fireEvent.click(evidenceButtons[0]);
    expect(document.querySelector(".diff-view")?.textContent).toContain("-first\n+first-new");
    fireEvent.click(evidenceButtons[1]);
    expect(document.querySelector(".diff-view")?.textContent).toContain("-second\n+second-new");
    expect(document.querySelector(".diff-view")?.textContent).not.toContain("-first\n+first-new");
    expect(screen.getByRole("combobox", { name: "COMMIT EVIDENCE" })).toHaveValue("commit-second");
  } finally {
    if (originalScroll) Element.prototype.scrollIntoView = originalScroll;
    else delete (Element.prototype as Partial<Element>).scrollIntoView;
  }
});

test("commit-level finding displays available patches and explicit missing-patch evidence", () => {
  const commit: CommitRecord = {
    sha: "commit-missing",
    message: "review commit",
    files: [
      { filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, patch: "+actual patch" },
      { filename: "assets/logo.bin", status: "added", additions: 1, deletions: 0, patch: null },
    ],
  };
  const finding: CheckFinding = { check: "dependency", explanation: "dependency version increased" };
  const verdict: CommitVerdict = {
    sha: commit.sha,
    message: commit.message,
    status: "adjusted",
    reasons: [finding.explanation],
    findings: [finding],
  };
  const originalScroll = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = jest.fn();
  try {
    render(<Report
      data={{ owner: "owner", repo: "repo", base: "v1", head: "v2", commits: [commit], verdicts: [verdict], totalCommits: 1 }}
      onReset={jest.fn()}
    />);
    fireEvent.click(screen.getByRole("button", { name: /view evidence/i }));
    expect(document.querySelectorAll(".diff-view")[0]?.textContent).toContain("+actual patch");
    expect(screen.getByText(/GitHub did not provide a patch for this file/)).toBeInTheDocument();
    expect(within(screen.getByRole("complementary")).getAllByText("assets/logo.bin").length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: "Back to findings" })).toBeInTheDocument();
  } finally {
    if (originalScroll) Element.prototype.scrollIntoView = originalScroll;
    else delete (Element.prototype as Partial<Element>).scrollIntoView;
  }
});

test("repository input accepts owner/repo and HTTPS GitHub URLs", () => {
  expect(normalizeRepositoryInput("raahu1l/FinePrint")).toEqual({
    url: "https://github.com/raahu1l/FinePrint",
    owner: "raahu1l",
    repo: "FinePrint",
  });
  expect(normalizeRepositoryInput("https://github.com/raahu1l/FinePrint")).toEqual({
    url: "https://github.com/raahu1l/FinePrint",
    owner: "raahu1l",
    repo: "FinePrint",
  });
  expect(() => normalizeRepositoryInput("http://github.com/raahu1l/FinePrint")).toThrow();
});

test("completed scanner is static and labels the scan complete", () => {
  const commit: CommitRecord = {
    sha: "commit-c",
    message: "change ui",
    files: [{
      filename: "src/ui/App.tsx",
      status: "modified",
      additions: 1,
      deletions: 0,
      patch: "+new",
    }],
  };
  const model = buildReleaseXray([commit], [{
    sha: "commit-c",
    message: "change ui",
    status: "ok",
    reasons: [],
  }]);
  render(
    <Scanner
      model={model}
      selectedCategory={null}
      selectedFile={model.files[0]}
      onCategory={jest.fn()}
      onFile={jest.fn()}
    />
  );
  expect(screen.getByText("RELEASE X-RAY · SCAN COMPLETE")).toBeInTheDocument();
  expect(document.querySelector(".scan-line")).not.toBeInTheDocument();
});
