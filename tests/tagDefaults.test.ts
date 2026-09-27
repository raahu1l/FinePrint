/**
 * Unit tests for the default tag-selection logic used by InputScreen,
 * and the pre-fill defaults that guarantee a real result on first load.
 *
 * The rule: given a tag list returned by fetchRepoTags (API order, newest
 * first), "From tag" defaults to tags[1] (second-most-recent) and "To tag"
 * defaults to tags[0] (most-recent).  No alphabetical or semver sort is
 * applied — the API order is trusted as-is.
 */

/**
 * Mirrors the default-selection logic from InputScreen so it can be tested
 * without importing React or mounting a component.
 *
 * Returns { base, head } — the same values that setBase/setHead receive.
 */
function selectDefaultTags(fetched: string[]): { base: string; head: string } {
  if (fetched.length === 0) return { base: "", head: "" };
  return {
    base: fetched.length > 1 ? fetched[1] : fetched[0],
    head: fetched[0],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("default tag selection (API order, no sort)", () => {
  it("selects index-0 as head and index-1 as base for a typical list", () => {
    // API returns newest first: v2.0.0, v1.1.0, v1.0.0
    const tags = ["v2.0.0", "v1.1.0", "v1.0.0"];
    const { base, head } = selectDefaultTags(tags);
    expect(head).toBe("v2.0.0");  // most-recent
    expect(base).toBe("v1.1.0"); // second-most-recent
  });

  it("uses API order, NOT alphabetical order", () => {
    // A version ordering that differs between API order and alphabetical:
    // alphabetical sort would give: v0.9.0, v1.10.0, v1.2.0, v1.9.0
    // but the API says newest first: v1.10.0, v1.9.0, v1.2.0, v0.9.0
    const tags = ["v1.10.0", "v1.9.0", "v1.2.0", "v0.9.0"];
    const { base, head } = selectDefaultTags(tags);
    expect(head).toBe("v1.10.0"); // index 0 in API response
    expect(base).toBe("v1.9.0"); // index 1 in API response
    // Confirm it is NOT the alphabetically-first or alphabetically-last pair.
    expect(base).not.toBe("v0.9.0");
    expect(head).not.toBe("v1.9.0");
  });

  it("uses API order for non-semver tag names (e.g. date-based tags)", () => {
    // Non-semver tags that sort differently alphabetically vs. API order.
    const tags = ["2024.03.01", "2024.02.15", "2024.01.10"];
    const { base, head } = selectDefaultTags(tags);
    expect(head).toBe("2024.03.01");
    expect(base).toBe("2024.02.15");
  });

  it("when there is only one tag, both base and head default to that tag", () => {
    const { base, head } = selectDefaultTags(["v1.0.0"]);
    expect(base).toBe("v1.0.0");
    expect(head).toBe("v1.0.0");
  });

  it("returns empty strings for an empty tag list", () => {
    const { base, head } = selectDefaultTags([]);
    expect(base).toBe("");
    expect(head).toBe("");
  });

  it("correctly picks the two most-recent adjacent releases from a longer list", () => {
    const tags = ["v3.0.0", "v2.5.0", "v2.0.0", "v1.5.0", "v1.0.0"];
    const { base, head } = selectDefaultTags(tags);
    expect(head).toBe("v3.0.0");
    expect(base).toBe("v2.5.0");
  });
});

// ---------------------------------------------------------------------------
// Default pre-fill constants — guarantee a real, fast, adjusted result
// ---------------------------------------------------------------------------

/**
 * These constants mirror what is exported/used in App.tsx's InputScreen.
 * They must point to the project's own repo and two real adjacent tags so
 * a user who clicks "Check Release" immediately (without touching anything)
 * always gets a completed receipt with at least one adjusted item.
 *
 * We import them from the source to ensure the test is coupled to the real values.
 */
import path from "path";
import { readFileSync } from "fs";

describe("default pre-fill constants in InputScreen", () => {
  // Read the actual source file and extract the constant values.
  const appSource = readFileSync(
    path.resolve("src/ui/App.tsx"),
    "utf-8"
  );

  it("DEFAULT_REPO is set to this project's own repository path", () => {
    // Must match the format "owner/repo" or "https://github.com/owner/repo"
    const match = appSource.match(/const DEFAULT_REPO\s*=\s*["']([^"']+)["']/);
    expect(match).not.toBeNull();
    const value = match![1];
    // Must be non-empty and reference a GitHub repo path
    expect(value.trim()).not.toBe("");
    expect(value).toMatch(/[\w-]+\/[\w-]+/);
  });

  it("DEFAULT_BASE_TAG is set to v0.1.0", () => {
    const match = appSource.match(/const DEFAULT_BASE_TAG\s*=\s*["']([^"']+)["']/);
    expect(match).not.toBeNull();
    expect(match![1]).toBe("v0.1.0");
  });

  it("DEFAULT_HEAD_TAG is set to v0.2.0", () => {
    const match = appSource.match(/const DEFAULT_HEAD_TAG\s*=\s*["']([^"']+)["']/);
    expect(match).not.toBeNull();
    expect(match![1]).toBe("v0.2.0");
  });

  it("DEFAULT_BASE_TAG and DEFAULT_HEAD_TAG are distinct (not the same tag)", () => {
    const baseMatch = appSource.match(/const DEFAULT_BASE_TAG\s*=\s*["']([^"']+)["']/);
    const headMatch = appSource.match(/const DEFAULT_HEAD_TAG\s*=\s*["']([^"']+)["']/);
    expect(baseMatch).not.toBeNull();
    expect(headMatch).not.toBeNull();
    expect(baseMatch![1]).not.toBe(headMatch![1]);
  });

  it("DEFAULT_BASE_TAG is a semver tag with v-prefix", () => {
    const match = appSource.match(/const DEFAULT_BASE_TAG\s*=\s*["']([^"']+)["']/);
    expect(match![1]).toMatch(/^v\d+\.\d+\.\d+$/);
  });

  it("DEFAULT_HEAD_TAG is a semver tag with v-prefix", () => {
    const match = appSource.match(/const DEFAULT_HEAD_TAG\s*=\s*["']([^"']+)["']/);
    expect(match![1]).toMatch(/^v\d+\.\d+\.\d+$/);
  });
});
