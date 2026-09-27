/**
 * tests/receiptUtils.test.ts
 *
 * Unit tests for the pure receipt-rendering utilities:
 *   - sortVerdictsForDisplay: adjusted-first sort order
 *   - buildReceiptRuns: collapse logic for consecutive ok/mechanical runs
 *   - computeHealthCounts: routine vs. flagged tallying for the health bar
 */

import { buildReceiptRuns, computeHealthCounts, sortVerdictsForDisplay } from "../src/ui/receiptUtils.js";
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
// sortVerdictsForDisplay — adjusted-first sort order
// ---------------------------------------------------------------------------

describe("sortVerdictsForDisplay — adjusted items appear before routine items", () => {
  test("empty array → empty array", () => {
    expect(sortVerdictsForDisplay([])).toEqual([]);
  });

  test("all adjusted → same order preserved", () => {
    const input = [adj("a"), adj("b"), adj("c")];
    const result = sortVerdictsForDisplay(input);
    expect(result.map((v) => v.sha)).toEqual(["a", "b", "c"]);
  });

  test("all ok → same order preserved", () => {
    const input = [ok("a"), ok("b"), ok("c")];
    const result = sortVerdictsForDisplay(input);
    expect(result.map((v) => v.sha)).toEqual(["a", "b", "c"]);
  });

  test("mixed: adjusted items come first in their original chronological order", () => {
    // Input: ok, adj, ok, adj, ok
    const input = [ok("1"), adj("2"), ok("3"), adj("4"), ok("5")];
    const result = sortVerdictsForDisplay(input);
    // adjusted items (2, 4) should come first, then routine (1, 3, 5)
    expect(result.map((v) => v.sha)).toEqual(["2", "4", "1", "3", "5"]);
  });

  test("adjusted items preserve their relative chronological order", () => {
    const input = [adj("z"), ok("a"), adj("m"), ok("b")];
    const result = sortVerdictsForDisplay(input);
    // z and m are adjusted; z came before m in the original list → should stay that way
    const adjustedShas = result.filter((v) => v.status === "adjusted").map((v) => v.sha);
    expect(adjustedShas).toEqual(["z", "m"]);
  });

  test("routine items preserve their relative chronological order", () => {
    const input = [adj("x"), ok("a"), mech("b"), ok("c")];
    const result = sortVerdictsForDisplay(input);
    const routineShas = result.filter((v) => v.status !== "adjusted").map((v) => v.sha);
    expect(routineShas).toEqual(["a", "b", "c"]);
  });

  test("all adjusted first + all routine last after sort → buildReceiptRuns produces all singles then one group", () => {
    // After sort: adj, adj, ok, ok, ok (routine forms a group of 3 at bottom)
    const input = [ok("1"), adj("2"), ok("3"), adj("4"), ok("5")];
    const sorted = sortVerdictsForDisplay(input);
    const runs = buildReceiptRuns(sorted);
    // Expect: single(2), single(4), group([1,3,5])
    expect(runs).toHaveLength(3);
    expect(runs[0].kind).toBe("single");
    if (runs[0].kind === "single") expect(runs[0].verdict.sha).toBe("2");
    expect(runs[1].kind).toBe("single");
    if (runs[1].kind === "single") expect(runs[1].verdict.sha).toBe("4");
    expect(runs[2].kind).toBe("group");
    if (runs[2].kind === "group") expect(runs[2].verdicts.map((v) => v.sha)).toEqual(["1", "3", "5"]);
  });

  test("mechanical commits are treated as routine and appear after adjusted", () => {
    const input = [mech("a"), adj("b"), mech("c")];
    const result = sortVerdictsForDisplay(input);
    expect(result[0].sha).toBe("b"); // adjusted first
    expect(result[1].sha).toBe("a"); // then mechanical in original order
    expect(result[2].sha).toBe("c");
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
