/**
 * @jest-environment jsdom
 */

import React from "react";
import { jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import {
  FileDetails,
  FindingSummary,
  findingKey,
  normalizeRepositoryInput,
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
