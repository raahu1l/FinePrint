/**
 * tests/receiptUtils.test.ts
 *
 * Unit tests for the pure receipt-rendering utilities:
 *   - buildReceiptRuns: collapse logic for consecutive ok/mechanical runs
 *   - computeHealthCounts: routine vs. flagged tallying for the health bar
 */

import { buildReceiptRuns, computeHealthCounts } from "../src/ui/receiptUtils.js";
import type { CommitVerdict } from "../src/checks/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeVerdict(sha: string, status: CommitVerdict["status"]): CommitVerdict {
  return { sha, message: `msg-${sha}`, status, reasons: [] };
}

const ok = (sha: string) => makeVerdict(sha, "ok");
const adj = (sha: string) => makeVerdict(sha, "adjusted");
const mech = (sha: string) => makeVerdict(sha, "mechanical");

// ---------------------------------------------------------------------------
// buildReceiptRuns — collapse logic
// ---------------------------------------------------------------------------

describe("buildReceiptRuns — empty / trivial input", () => {
  test("empty array returns empty runs", () => {
    expect(buildReceiptRuns([])).toEqual([]);
  });

  test("single ok → single run (not grouped)", () => {
    const runs = buildReceiptRuns([ok("a")]);
    expect(runs).toHaveLength(1);
    expect(runs[0].kind).toBe("single");
  });

  test("single adjusted → single run", () => {
    const runs = buildReceiptRuns([adj("a")]);
    expect(runs).toHaveLength(1);
    expect(runs[0].kind).toBe("single");
    if (runs[0].kind === "single") {
      expect(runs[0].verdict.status).toBe("adjusted");
    }
  });
});

describe("buildReceiptRuns — ok run threshold", () => {
  test("exactly 2 consecutive ok items → two singles (below threshold)", () => {
    const runs = buildReceiptRuns([ok("a"), ok("b")]);
    expect(runs).toHaveLength(2);
    expect(runs.every((r) => r.kind === "single")).toBe(true);
  });

  test("exactly 3 consecutive ok items → one group", () => {
    const runs = buildReceiptRuns([ok("a"), ok("b"), ok("c")]);
    expect(runs).toHaveLength(1);
    expect(runs[0].kind).toBe("group");
    if (runs[0].kind === "group") {
      expect(runs[0].verdicts).toHaveLength(3);
    }
  });

  test("5 consecutive ok items → one group of 5", () => {
    const runs = buildReceiptRuns([ok("a"), ok("b"), ok("c"), ok("d"), ok("e")]);
    expect(runs).toHaveLength(1);
    expect(runs[0].kind).toBe("group");
    if (runs[0].kind === "group") {
      expect(runs[0].verdicts).toHaveLength(5);
    }
  });
});

describe("buildReceiptRuns — adjusted items always remain singles", () => {
  test("adjusted item interrupts a run, so each side stays below threshold", () => {
    // 2 ok, 1 adjusted, 2 ok → all singles (no side reaches 3)
    const runs = buildReceiptRuns([ok("a"), ok("b"), adj("c"), ok("d"), ok("e")]);
    expect(runs).toHaveLength(5);
    expect(runs.every((r) => r.kind === "single")).toBe(true);
  });

  test("adjusted item between two qualifying runs → two groups + one single", () => {
    // 3 ok, 1 adjusted, 4 ok
    const input = [ok("a"), ok("b"), ok("c"), adj("d"), ok("e"), ok("f"), ok("g"), ok("h")];
    const runs = buildReceiptRuns(input);
    expect(runs).toHaveLength(3);
    expect(runs[0].kind).toBe("group");
    expect(runs[1].kind).toBe("single");
    if (runs[1].kind === "single") expect(runs[1].verdict.sha).toBe("d");
    expect(runs[2].kind).toBe("group");
  });

  test("adjusted item is never inside a group", () => {
    const input = [ok("a"), ok("b"), ok("c"), ok("d"), adj("e"), ok("f"), ok("g"), ok("h")];
    const runs = buildReceiptRuns(input);
    // first group of 4, then adjusted single, then group of 3
    expect(runs).toHaveLength(3);
    const allVerdicts = runs.flatMap((r) =>
      r.kind === "group" ? r.verdicts : [r.verdict]
    );
    const adjustedInGroup = runs
      .filter((r) => r.kind === "group")
      .flatMap((r) => (r.kind === "group" ? r.verdicts : []))
      .filter((v) => v.status === "adjusted");
    expect(adjustedInGroup).toHaveLength(0);
  });
});

describe("buildReceiptRuns — mechanical commits treated as ok (collapsible)", () => {
  test("3 mechanical commits → collapsed into one group", () => {
    const runs = buildReceiptRuns([mech("a"), mech("b"), mech("c")]);
    expect(runs).toHaveLength(1);
    expect(runs[0].kind).toBe("group");
  });

  test("mixed ok and mechanical in a run ≥ 3 → one group", () => {
    const runs = buildReceiptRuns([ok("a"), mech("b"), ok("c")]);
    expect(runs).toHaveLength(1);
    expect(runs[0].kind).toBe("group");
    if (runs[0].kind === "group") {
      expect(runs[0].verdicts.map((v) => v.sha)).toEqual(["a", "b", "c"]);
    }
  });

  test("mechanical does not collapse when run is only 2", () => {
    const runs = buildReceiptRuns([mech("a"), mech("b")]);
    expect(runs).toHaveLength(2);
    expect(runs.every((r) => r.kind === "single")).toBe(true);
  });
});

describe("buildReceiptRuns — order preservation", () => {
  test("run order matches input order", () => {
    const input = [adj("1"), ok("2"), ok("3"), ok("4"), adj("5")];
    const runs = buildReceiptRuns(input);
    // adj single, group of 3, adj single
    expect(runs).toHaveLength(3);
    if (runs[0].kind === "single") expect(runs[0].verdict.sha).toBe("1");
    if (runs[1].kind === "group")
      expect(runs[1].verdicts.map((v) => v.sha)).toEqual(["2", "3", "4"]);
    if (runs[2].kind === "single") expect(runs[2].verdict.sha).toBe("5");
  });
});

// ---------------------------------------------------------------------------
// computeHealthCounts — health bar tallying
// ---------------------------------------------------------------------------

describe("computeHealthCounts", () => {
  test("all ok → routine = n, flagged = 0", () => {
    const verdicts = [ok("a"), ok("b"), ok("c")];
    expect(computeHealthCounts(verdicts)).toEqual({ routine: 3, flagged: 0 });
  });

  test("all adjusted → routine = 0, flagged = n", () => {
    const verdicts = [adj("a"), adj("b")];
    expect(computeHealthCounts(verdicts)).toEqual({ routine: 0, flagged: 2 });
  });

  test("mechanical commits count as routine", () => {
    const verdicts = [mech("a"), mech("b"), ok("c")];
    expect(computeHealthCounts(verdicts)).toEqual({ routine: 3, flagged: 0 });
  });

  test("mixed: ok + mechanical + adjusted counted correctly", () => {
    const verdicts = [ok("a"), mech("b"), adj("c"), ok("d"), adj("e"), mech("f")];
    // routine: a, b, d, f = 4 ; flagged: c, e = 2
    expect(computeHealthCounts(verdicts)).toEqual({ routine: 4, flagged: 2 });
  });

  test("empty array returns zeros", () => {
    expect(computeHealthCounts([])).toEqual({ routine: 0, flagged: 0 });
  });

  test("mechanical commits never inflate flagged count", () => {
    // A release with only mechanical commits (e.g. post a maven release)
    const verdicts = [
      mech("maven-prep"),
      mech("maven-next"),
      mech("merge"),
    ];
    const counts = computeHealthCounts(verdicts);
    expect(counts.flagged).toBe(0);
    expect(counts.routine).toBe(3);
  });
});
