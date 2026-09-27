/**
 * tests/CollapsibleOkGroup.test.tsx
 *
 * Verifies that the top and bottom collapse controls in CollapsibleOkGroup are
 * functionally identical — both toggle the same open/closed state.
 *
 * @jest-environment jsdom
 */

import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { CollapsibleOkGroup } from "../src/ui/App.js";
import type { CommitVerdict } from "../src/checks/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeVerdict(sha: string): CommitVerdict {
  return { sha, message: `chore: routine ${sha}`, status: "ok", reasons: [] };
}

const THREE_VERDICTS: CommitVerdict[] = [
  makeVerdict("aaa"),
  makeVerdict("bbb"),
  makeVerdict("ccc"),
];

const EMPTY_FILES_MAP = new Map<string, import("../src/github/types.js").CommitFile[]>();

const COMMON_PROPS = {
  verdicts: THREE_VERDICTS,
  allFilesMap: EMPTY_FILES_MAP,
  owner: "owner",
  repo: "repo",
  base: "v1.0.0",
  head: "v1.1.0",
};

// ---------------------------------------------------------------------------
// Helper: the label text used by both collapse buttons
// ---------------------------------------------------------------------------

const COLLAPSE_LABEL = /▾ collapse 3 routine commits/;
const EXPAND_LABEL = /3 routine commits — all clear/;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CollapsibleOkGroup — top and bottom collapse controls", () => {
  test("initially renders the expand button, not the commit list", () => {
    render(<CollapsibleOkGroup {...COMMON_PROPS} />);

    expect(screen.getByText(EXPAND_LABEL)).toBeInTheDocument();
    expect(screen.queryByText(COLLAPSE_LABEL)).not.toBeInTheDocument();
    expect(screen.queryByText(/chore: routine/)).not.toBeInTheDocument();
  });

  test("clicking expand shows both top and bottom collapse controls", () => {
    render(<CollapsibleOkGroup {...COMMON_PROPS} />);

    fireEvent.click(screen.getByText(EXPAND_LABEL));

    const collapseButtons = screen.getAllByText(COLLAPSE_LABEL);
    expect(collapseButtons).toHaveLength(2);
  });

  test("top collapse button (index 0) collapses the group back", () => {
    render(<CollapsibleOkGroup {...COMMON_PROPS} />);

    fireEvent.click(screen.getByText(EXPAND_LABEL));
    expect(screen.getAllByText(COLLAPSE_LABEL)).toHaveLength(2);

    // Click the first (top) button
    fireEvent.click(screen.getAllByText(COLLAPSE_LABEL)[0]);

    expect(screen.getByText(EXPAND_LABEL)).toBeInTheDocument();
    expect(screen.queryByText(COLLAPSE_LABEL)).not.toBeInTheDocument();
  });

  test("bottom collapse button (index 1) collapses the group back", () => {
    render(<CollapsibleOkGroup {...COMMON_PROPS} />);

    fireEvent.click(screen.getByText(EXPAND_LABEL));
    expect(screen.getAllByText(COLLAPSE_LABEL)).toHaveLength(2);

    // Click the second (bottom) button
    fireEvent.click(screen.getAllByText(COLLAPSE_LABEL)[1]);

    expect(screen.getByText(EXPAND_LABEL)).toBeInTheDocument();
    expect(screen.queryByText(COLLAPSE_LABEL)).not.toBeInTheDocument();
  });
});
