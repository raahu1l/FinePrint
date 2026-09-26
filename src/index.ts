export { fetchCommitRange, parseRepoUrl, buildFetcher } from "./github/fetchCommitRange.js";
export type { CommitFile, CommitRecord, FetchOptions } from "./github/types.js";
export { RateLimitError, GitHubApiError } from "./github/types.js";

export { runChecks, mergeVerdicts } from "./checks/checkLogic.js";
export type { CommitVerdict, CommitStatus, BumpType } from "./checks/checkLogic.js";
export { checkAreaMismatch } from "./checks/areaMismatch.js";
export type { AreaMismatchResult, UndisclosedDiff } from "./checks/areaMismatch.js";
export { checkSemver, parseBumpType } from "./checks/semver.js";
export type { SemverResult } from "./checks/semver.js";
export { checkDepBump } from "./checks/depBump.js";
export type { DepBumpResult } from "./checks/depBump.js";
