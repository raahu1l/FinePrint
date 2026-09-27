/**
 * tests/inputDefaults.test.ts
 *
 * Tests for Fix 2: default values only apply on true first mount.
 *
 * The rule:
 *   - On first load App seeds inputRepoUrl/inputBase/inputHead from the
 *     DEFAULT_* constants.
 *   - InputScreen calls onValuesChange whenever the user changes any field,
 *     which updates App's persisted state.
 *   - When the user clicks "check another release" (handleReset), App keeps
 *     its persisted input state unchanged — it does NOT reset to defaults.
 *   - The next InputScreen mount receives the persisted values as its
 *     initialRepoUrl/initialBase/initialHead props, so the user sees what
 *     they last entered.
 *
 * We test this logic as a pure state machine without mounting React components.
 */

// ---------------------------------------------------------------------------
// Mirror of the App state + handlers (pure logic, no React)
// ---------------------------------------------------------------------------

const DEFAULT_REPO = "raahu1l/FinePrint";
const DEFAULT_BASE_TAG = "v0.1.0";
const DEFAULT_HEAD_TAG = "v0.2.0";

/**
 * Pure simulation of the App state relevant to input-value persistence.
 */
function makeAppState() {
  let inputRepoUrl = DEFAULT_REPO;
  let inputBase = DEFAULT_BASE_TAG;
  let inputHead = DEFAULT_HEAD_TAG;
  let screen: "input" | "loading" | "receipt" = "input";

  return {
    /** Called by InputScreen whenever its local values change */
    handleValuesChange(repoUrl: string, base: string, head: string) {
      inputRepoUrl = repoUrl;
      inputBase = base;
      inputHead = head;
    },
    /** Simulates submitting the form (transitions to loading/receipt) */
    handleCheck() {
      screen = "receipt";
    },
    /** Simulates "check another release" — must NOT reset input values */
    handleReset() {
      screen = "input";
      // Deliberately NOT resetting inputRepoUrl/inputBase/inputHead —
      // that is the fix.
    },
    getScreen() { return screen; },
    getInputProps() {
      return { initialRepoUrl: inputRepoUrl, initialBase: inputBase, initialHead: inputHead };
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("default values — only on first load", () => {
  it("seeds initial props from DEFAULT_* constants on first mount", () => {
    const app = makeAppState();

    const { initialRepoUrl, initialBase, initialHead } = app.getInputProps();
    expect(initialRepoUrl).toBe(DEFAULT_REPO);
    expect(initialBase).toBe(DEFAULT_BASE_TAG);
    expect(initialHead).toBe(DEFAULT_HEAD_TAG);
  });

  it("updates persisted values when InputScreen reports a change", () => {
    const app = makeAppState();

    app.handleValuesChange("https://github.com/facebook/react", "v18.2.0", "v18.3.0");

    const { initialRepoUrl, initialBase, initialHead } = app.getInputProps();
    expect(initialRepoUrl).toBe("https://github.com/facebook/react");
    expect(initialBase).toBe("v18.2.0");
    expect(initialHead).toBe("v18.3.0");
  });

  it("preserves user-entered values across a simulated 'check another release' navigation", () => {
    const app = makeAppState();

    // User changes the repo and tags
    app.handleValuesChange("https://github.com/vercel/next.js", "v14.0.0", "v14.1.0");

    // User submits and views the receipt
    app.handleCheck();
    expect(app.getScreen()).toBe("receipt");

    // User clicks "check another release"
    app.handleReset();
    expect(app.getScreen()).toBe("input");

    // The input screen should receive the user's last-entered values, not defaults
    const { initialRepoUrl, initialBase, initialHead } = app.getInputProps();
    expect(initialRepoUrl).toBe("https://github.com/vercel/next.js");
    expect(initialBase).toBe("v14.0.0");
    expect(initialHead).toBe("v14.1.0");
  });

  it("does NOT re-apply DEFAULT_* after navigating back", () => {
    const app = makeAppState();

    // Simulate a complete flow with custom values
    app.handleValuesChange("https://github.com/microsoft/typescript", "v5.3.0", "v5.4.0");
    app.handleCheck();
    app.handleReset();

    // Defaults must not reappear
    const { initialRepoUrl, initialBase, initialHead } = app.getInputProps();
    expect(initialRepoUrl).not.toBe(DEFAULT_REPO);
    expect(initialBase).not.toBe(DEFAULT_BASE_TAG);
    expect(initialHead).not.toBe(DEFAULT_HEAD_TAG);
  });

  it("preserves values across multiple successive navigation cycles", () => {
    const app = makeAppState();

    // First cycle
    app.handleValuesChange("https://github.com/owner/repo-a", "v1.0.0", "v2.0.0");
    app.handleCheck();
    app.handleReset();

    // Second cycle — user changes to a different repo
    app.handleValuesChange("https://github.com/owner/repo-b", "v3.0.0", "v4.0.0");
    app.handleCheck();
    app.handleReset();

    // Should reflect the most-recent values
    const { initialRepoUrl, initialBase, initialHead } = app.getInputProps();
    expect(initialRepoUrl).toBe("https://github.com/owner/repo-b");
    expect(initialBase).toBe("v3.0.0");
    expect(initialHead).toBe("v4.0.0");
  });

  it("only the latest onValuesChange call wins (last write wins)", () => {
    const app = makeAppState();

    app.handleValuesChange("https://github.com/a/repo", "v1.0.0", "v1.1.0");
    app.handleValuesChange("https://github.com/b/repo", "v2.0.0", "v2.1.0");
    app.handleValuesChange("https://github.com/c/repo", "v3.0.0", "v3.1.0");

    const { initialRepoUrl, initialBase, initialHead } = app.getInputProps();
    expect(initialRepoUrl).toBe("https://github.com/c/repo");
    expect(initialBase).toBe("v3.0.0");
    expect(initialHead).toBe("v3.1.0");
  });
});
