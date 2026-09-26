import React, { useState, useCallback, useEffect } from "react";
import { fetchCommitRange, parseRepoUrl, fetchRepoTags } from "../github/fetchCommitRange.js";
import { OversizedRangeError } from "../github/types.js";
import { runChecks } from "../checks/checkLogic.js";
import type { CommitVerdict } from "../checks/types.js";
import type { UndisclosedDiff } from "../checks/areaMismatch.js";
import type { CommitFile } from "../github/types.js";
import {
  isSmallDiff,
  pickRepresentativeFile,
  buildGitHubCompareUrl,
  buildReleaseNotesDraft,
} from "./diffUtils.js";
import {
  buildReceiptRuns,
  computeHealthCounts,
} from "./receiptUtils.js";

// ---------------------------------------------------------------------------
// Styles (inline CSS-in-JS object map)
// ---------------------------------------------------------------------------

const MONO = '"Courier New", Courier, monospace';
const SANS = '-apple-system, "Segoe UI", system-ui, sans-serif';

const S = {
  // ── Page shell ─────────────────────────────────────────────────────────────
  page: {
    minHeight: "100vh",
    background: "#f0f0f0",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontFamily: SANS,
    padding: "32px 16px",
  } as React.CSSProperties,

  card: {
    background: "#fff",
    border: "1px solid #d0d0d0",
    width: "100%",
    maxWidth: 640,
    padding: "40px 48px",
  } as React.CSSProperties,

  // ── Input screen ───────────────────────────────────────────────────────────
  inputHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 4,
  } as React.CSSProperties,

  inputTitle: {
    fontFamily: SANS,
    fontSize: 32,
    fontWeight: 700,
    color: "#111",
    margin: 0,
  } as React.CSSProperties,

  auditBadge: {
    fontFamily: MONO,
    fontSize: 10,
    color: "#555",
    border: "1px solid #aaa",
    padding: "3px 8px",
    marginTop: 6,
    letterSpacing: "0.04em",
  } as React.CSSProperties,

  inputSubtitle: {
    fontFamily: SANS,
    fontSize: 14,
    color: "#3b82d4",
    marginTop: 2,
    marginBottom: 28,
  } as React.CSSProperties,

  label: {
    display: "block",
    fontSize: 12,
    fontWeight: 600,
    color: "#333",
    marginBottom: 6,
    letterSpacing: "0.02em",
  } as React.CSSProperties,

  textInput: {
    width: "100%",
    boxSizing: "border-box" as const,
    border: "1px solid #ccc",
    padding: "9px 12px",
    fontSize: 14,
    fontFamily: MONO,
    color: "#222",
    outline: "none",
  } as React.CSSProperties,

  hint: {
    fontSize: 12,
    color: "#3b82d4",
    marginTop: 5,
    marginBottom: 20,
  } as React.CSSProperties,

  tagRow: {
    display: "flex",
    gap: 16,
    marginBottom: 24,
  } as React.CSSProperties,

  tagGroup: {
    flex: 1,
  } as React.CSSProperties,

  select: {
    width: "100%",
    border: "1px solid #ccc",
    padding: "9px 12px",
    fontSize: 14,
    fontFamily: SANS,
    color: "#222",
    background: "#fff",
    cursor: "pointer",
    appearance: "auto" as const,
    outline: "none",
  } as React.CSSProperties,

  checkBtn: {
    display: "block",
    width: "100%",
    padding: "14px 0",
    background: "#111",
    color: "#fff",
    border: "none",
    fontFamily: SANS,
    fontSize: 13,
    fontWeight: 700,
    letterSpacing: "0.1em",
    cursor: "pointer",
    textTransform: "uppercase" as const,
  } as React.CSSProperties,

  inputFooter: {
    display: "flex",
    justifyContent: "space-between",
    marginTop: 28,
    fontFamily: MONO,
    fontSize: 10,
    color: "#3b82d4",
    letterSpacing: "0.04em",
  } as React.CSSProperties,

  errorBox: {
    background: "#fff0f0",
    border: "1px solid #f9a0a0",
    color: "#c00",
    padding: "10px 14px",
    fontSize: 13,
    marginBottom: 16,
  } as React.CSSProperties,

  // ── Receipt screen ─────────────────────────────────────────────────────────
  receiptOuter: {
    background: "#f0f0f0",
    minHeight: "100vh",
    display: "flex",
    flexDirection: "column" as const,
    alignItems: "center",
    padding: "32px 16px 0",
    fontFamily: MONO,
  } as React.CSSProperties,

  receiptCard: {
    background: "#fff",
    width: "100%",
    maxWidth: 560,
    padding: "24px 32px 0",
    border: "1px solid #d8d8d8",
    position: "relative" as const,
  } as React.CSSProperties,

  receiptMeta: {
    textAlign: "center" as const,
    fontSize: 10,
    color: "#999",
    letterSpacing: "0.08em",
    marginBottom: 8,
  } as React.CSSProperties,

  receiptVersion: {
    textAlign: "center" as const,
    fontSize: 28,
    fontWeight: 700,
    color: "#111",
    letterSpacing: "0.02em",
    marginBottom: 4,
  } as React.CSSProperties,

  receiptSub: {
    textAlign: "center" as const,
    fontSize: 11,
    color: "#777",
    letterSpacing: "0.06em",
    marginBottom: 20,
  } as React.CSSProperties,

  dashedDivider: {
    borderTop: "1px dashed #bbb",
    margin: "10px 0",
  } as React.CSSProperties,

  // ── Commit row ─────────────────────────────────────────────────────────────
  commitRow: {
    padding: "10px 0",
    borderBottom: "1px dashed #ddd",
  } as React.CSSProperties,

  commitRowTop: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
  } as React.CSSProperties,

  commitMsg: {
    fontSize: 13,
    color: "#222",
    flex: 1,
    lineHeight: 1.45,
    wordBreak: "break-word" as const,
  } as React.CSSProperties,

  commitStat: {
    fontFamily: MONO,
    fontSize: 12,
    color: "#555",
    whiteSpace: "nowrap" as const,
    marginLeft: 12,
    paddingTop: 1,
  } as React.CSSProperties,

  adjustedBadge: {
    fontWeight: 700,
    color: "#cc0000",
    marginLeft: 10,
    fontSize: 13,
  } as React.CSSProperties,

  mechanicalBadge: {
    fontWeight: 400,
    color: "#999",
    marginLeft: 10,
    fontSize: 12,
    fontStyle: "italic" as const,
  } as React.CSSProperties,

  // ── Health bar ──────────────────────────────────────────────────────────────
  healthBarWrap: {
    margin: "10px 0 6px",
  } as React.CSSProperties,

  healthBarTrack: {
    display: "flex",
    height: 6,
    width: "100%",
    background: "#e0e0e0",
    overflow: "hidden" as const,
  } as React.CSSProperties,

  healthBarCaption: {
    fontFamily: MONO,
    fontSize: 10,
    color: "#888",
    marginTop: 4,
    letterSpacing: "0.04em",
  } as React.CSSProperties,

  // ── Collapsible ok group ────────────────────────────────────────────────────
  collapseRow: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    cursor: "pointer",
    background: "none",
    border: "none",
    borderBottom: "1px dashed #ddd",
    width: "100%",
    textAlign: "left" as const,
    fontFamily: MONO,
    fontSize: 12,
    color: "#888",
    paddingTop: 8,
    paddingBottom: 8,
  } as React.CSSProperties,

  reasonLine: {
    fontSize: 12,
    color: "#555",
    marginTop: 4,
    paddingLeft: 8,
    lineHeight: 1.4,
  } as React.CSSProperties,

  reasonArrow: {
    color: "#888",
    marginRight: 4,
  } as React.CSSProperties,

  // ── Expandable diff ────────────────────────────────────────────────────────
  expandToggle: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    fontSize: 11,
    color: "#3b82d4",
    cursor: "pointer",
    userSelect: "none" as const,
    marginTop: 6,
    paddingLeft: 8,
    background: "none",
    border: "none",
    padding: 0,
    fontFamily: MONO,
  } as React.CSSProperties,

  chevron: (open: boolean): React.CSSProperties => ({
    display: "inline-block",
    transition: "transform 0.15s ease",
    transform: open ? "rotate(90deg)" : "rotate(0deg)",
    fontSize: 11,
  }),

  expandedArea: {
    marginTop: 8,
    paddingLeft: 8,
  } as React.CSSProperties,

  diffSummaryLine: {
    fontSize: 11,
    color: "#666",
    fontFamily: MONO,
    marginBottom: 6,
    background: "#f7f7f7",
    padding: "3px 8px",
    border: "1px solid #e0e0e0",
  } as React.CSSProperties,

  diffFileLabel: {
    fontSize: 11,
    color: "#777",
    fontFamily: MONO,
    marginBottom: 2,
    marginTop: 4,
  } as React.CSSProperties,

  codeBlock: {
    fontFamily: MONO,
    fontSize: 11,
    lineHeight: 1.5,
    border: "1px solid #ddd",
    background: "#fafafa",
    padding: "8px",
    overflowX: "auto" as const,
    whiteSpace: "pre" as const,
    marginBottom: 6,
  } as React.CSSProperties,

  diffLineRemoved: {
    color: "#cc0000",
    background: "#fff0f0",
    display: "block",
  } as React.CSSProperties,

  diffLineAdded: {
    color: "#008800",
    background: "#f0fff0",
    display: "block",
  } as React.CSSProperties,

  diffLineContext: {
    color: "#255",
    display: "block",
  } as React.CSSProperties,

  githubLink: {
    fontSize: 11,
    color: "#3b82d4",
    fontFamily: MONO,
    display: "inline-block",
    marginTop: 4,
    textDecoration: "underline",
  } as React.CSSProperties,

  // ── Total + footer ─────────────────────────────────────────────────────────
  totalRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "14px 0 12px",
    fontSize: 13,
    fontWeight: 700,
    color: "#111",
    letterSpacing: "0.04em",
    borderTop: "1px dashed #bbb",
    marginTop: 4,
  } as React.CSSProperties,

  totalAdjusted: {
    color: "#cc0000",
  } as React.CSSProperties,

  receiptStamp: {
    display: "flex",
    justifyContent: "space-between",
    fontSize: 9,
    color: "#aaa",
    letterSpacing: "0.06em",
    padding: "10px 0 14px",
    borderTop: "1px dashed #e0e0e0",
    marginTop: 4,
  } as React.CSSProperties,

  // Jagged bottom edge via SVG
  jaggedEdge: {
    display: "block",
    width: "100%",
  } as React.CSSProperties,

  receiptBottom: {
    display: "flex",
    justifyContent: "space-between",
    width: "100%",
    maxWidth: 560,
    padding: "12px 0 32px",
  } as React.CSSProperties,

  bottomBtn: {
    fontFamily: MONO,
    fontSize: 11,
    color: "#3b82d4",
    background: "none",
    border: "none",
    cursor: "pointer",
    letterSpacing: "0.04em",
    padding: 0,
    textDecoration: "underline",
  } as React.CSSProperties,
};

// ---------------------------------------------------------------------------
// JaggedEdge — SVG receipt tear
// ---------------------------------------------------------------------------

function JaggedEdge() {
  // Build a zigzag path across the full width at 560px
  const points: string[] = [];
  const step = 10;
  const count = 57; // 560 / 10 = 56 teeth
  points.push("M0,0");
  for (let i = 0; i <= count; i++) {
    const x = i * step;
    const y = i % 2 === 0 ? 10 : 0;
    points.push(`L${x},${y}`);
  }
  points.push("L560,10 L560,0 Z");

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 560 10"
      preserveAspectRatio="none"
      style={{ display: "block", width: "100%", height: 10, fill: "#f0f0f0" }}
    >
      <path d={points.join(" ")} />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// DiffPatch — renders a unified diff patch with coloured lines
// ---------------------------------------------------------------------------

function DiffPatch({ patch }: { patch: string }) {
  const lines = patch.split("\n");
  return (
    <div style={S.codeBlock}>
      {lines.map((line, i) => {
        if (line.startsWith("-")) {
          return (
            <span key={i} style={S.diffLineRemoved}>
              {line}
            </span>
          );
        }
        if (line.startsWith("+")) {
          return (
            <span key={i} style={S.diffLineAdded}>
              {line}
            </span>
          );
        }
        return (
          <span key={i} style={S.diffLineContext}>
            {line}
          </span>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ExpandableDiff
// ---------------------------------------------------------------------------

interface ExpandableDiffProps {
  diff: UndisclosedDiff;
  allFiles: CommitFile[];
  owner: string;
  repo: string;
  base: string;
  head: string;
}

function ExpandableDiff({
  diff,
  allFiles,
  owner,
  repo,
  base,
  head,
}: ExpandableDiffProps) {
  const [open, setOpen] = useState(false);
  const small = isSmallDiff(diff);
  const rep = pickRepresentativeFile(allFiles, diff);

  return (
    <div>
      <button
        style={S.expandToggle}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span style={S.chevron(open)}>▸</span>
        {open ? "hide diff" : "show diff"}
      </button>

      {open && (
        <div style={S.expandedArea}>
          {small ? (
            // Small: show inline patch of the sample snippet
            <>
              {diff.sampleSnippet ? (
                <>
                  <div style={S.diffFileLabel}>
                    // {diff.files[0] ?? "undisclosed"} (undisclosed)
                  </div>
                  <DiffPatch patch={diff.sampleSnippet} />
                </>
              ) : (
                <div style={S.diffSummaryLine}>
                  {diff.files.length} file
                  {diff.files.length !== 1 ? "s" : ""} changed, +
                  {diff.additions} −{diff.deletions} in undisclosed area
                </div>
              )}
            </>
          ) : (
            // Large: summary line + representative file snippet + GitHub link
            <>
              <div style={S.diffSummaryLine}>
                {diff.files.length} file{diff.files.length !== 1 ? "s" : ""}{" "}
                changed, +{diff.additions} −{diff.deletions} in undisclosed area
              </div>

              {rep && rep.patch && (
                <>
                  <div style={S.diffFileLabel}>
                    // {rep.filename} (undisclosed)
                  </div>
                  <DiffPatch patch={rep.patch} />
                </>
              )}

              <a
                href={buildGitHubCompareUrl(
                  owner,
                  repo,
                  base,
                  head,
                  rep?.filename
                )}
                target="_blank"
                rel="noreferrer"
                style={S.githubLink}
              >
                View full diff on GitHub →
              </a>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// HealthBar
// ---------------------------------------------------------------------------

interface HealthBarProps {
  routine: number;
  flagged: number;
}

function HealthBar({ routine, flagged }: HealthBarProps) {
  const total = routine + flagged;
  const routinePct = total === 0 ? 100 : Math.round((routine / total) * 100);
  const flaggedPct = 100 - routinePct;

  return (
    <div style={S.healthBarWrap}>
      <div style={S.healthBarTrack}>
        <div
          style={{
            width: `${routinePct}%`,
            background: flagged === 0 ? "#4caf50" : "#bdbdbd",
            transition: "width 0.2s",
          }}
        />
        {flaggedPct > 0 && (
          <div
            style={{
              width: `${flaggedPct}%`,
              background: "#cc0000",
            }}
          />
        )}
      </div>
      <div style={S.healthBarCaption}>
        {routine} routine &bull; {flagged} flagged
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CollapsibleOkGroup
// ---------------------------------------------------------------------------

interface CollapsibleOkGroupProps {
  verdicts: CommitVerdict[];
  allFilesMap: Map<string, CommitFile[]>;
  owner: string;
  repo: string;
  base: string;
  head: string;
}

function CollapsibleOkGroup({
  verdicts,
  allFilesMap,
  owner,
  repo,
  base,
  head,
}: CollapsibleOkGroupProps) {
  const [open, setOpen] = useState(false);

  if (open) {
    return (
      <>
        {verdicts.map((v) => (
          <CommitRow
            key={v.sha}
            verdict={v}
            allFiles={allFilesMap.get(v.sha) ?? []}
            owner={owner}
            repo={repo}
            base={base}
            head={head}
          />
        ))}
        <button
          style={{ ...S.collapseRow, color: "#3b82d4" }}
          onClick={() => setOpen(false)}
        >
          ▾ collapse {verdicts.length} routine commits
        </button>
      </>
    );
  }

  return (
    <button style={S.collapseRow} onClick={() => setOpen(true)}>
      <span>▸</span>
      <span>
        {verdicts.length} routine commits — all clear ▸
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// CommitRow
// ---------------------------------------------------------------------------

interface CommitRowProps {
  verdict: CommitVerdict;
  allFiles: CommitFile[];
  owner: string;
  repo: string;
  base: string;
  head: string;
}

function CommitRow({
  verdict,
  allFiles,
  owner,
  repo,
  base,
  head,
}: CommitRowProps) {
  const subject = verdict.message.split("\n")[0];
  const totalAdd = allFiles.reduce((s, f) => s + f.additions, 0);
  const totalDel = allFiles.reduce((s, f) => s + f.deletions, 0);
  const statStr = `+${totalAdd} -${totalDel}`;

  // Format reasons in the "↳ claims only X, but Y also changed — not mentioned" style
  function formatReason(reason: string): string {
    // Area mismatch reasons look like: "area changed but not mentioned in commit message: auth"
    const areaMatch = reason.match(
      /^area changed but not mentioned in commit message:\s*(.+)$/i
    );
    if (areaMatch) {
      const area = areaMatch[1];
      // Try to infer what was "claimed" from the commit message
      return `↳ claims only ${inferClaimedScope(subject)}, but ${area} also changed — not mentioned.`;
    }
    return `↳ ${reason}`;
  }

  return (
    <div style={S.commitRow}>
      <div style={S.commitRowTop}>
        <span style={S.commitMsg}>{subject}</span>
        {verdict.status === "ok" && (
          <span style={S.commitStat}>{statStr}</span>
        )}
        {verdict.status === "adjusted" && (
          <span style={S.adjustedBadge}>adjusted</span>
        )}
        {verdict.status === "mechanical" && (
          <span style={S.mechanicalBadge}>mechanical</span>
        )}
      </div>

      {verdict.status === "adjusted" && (
        <>
          {verdict.reasons.map((r, i) => (
            <div key={i} style={S.reasonLine}>
              {formatReason(r)}
            </div>
          ))}
          {verdict.undisclosedDiff && (
            <ExpandableDiff
              diff={verdict.undisclosedDiff}
              allFiles={allFiles}
              owner={owner}
              repo={repo}
              base={base}
              head={head}
            />
          )}
        </>
      )}
    </div>
  );
}

/** Heuristically extracts the scope label from a conventional commit message */
function inferClaimedScope(subject: string): string {
  const match = subject.match(/^[\w]+\(([^)]+)\)/);
  if (match) return match[1];
  const typeMatch = subject.match(/^(\w+):/);
  if (typeMatch) return typeMatch[1];
  return "the stated scope";
}

// ---------------------------------------------------------------------------
// InputScreen
// ---------------------------------------------------------------------------

interface InputScreenProps {
  onSubmit: (repoUrl: string, base: string, head: string) => void;
  loading: boolean;
  error: string | null;
}

function InputScreen({ onSubmit, loading, error }: InputScreenProps) {
  const [repoUrl, setRepoUrl] = useState("facebook/react");
  const [base, setBase] = useState("");
  const [head, setHead] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [tagsLoading, setTagsLoading] = useState(false);
  const [tagsError, setTagsError] = useState<string | null>(null);

  // Fetch tags whenever the repo URL changes (with a short debounce)
  useEffect(() => {
    const normalised = repoUrl.trim();
    if (!normalised) return;

    const url = normalised.includes("github.com")
      ? normalised
      : `https://github.com/${normalised}`;

    // Validate the URL is parseable before firing a request
    try {
      parseRepoUrl(url);
    } catch {
      return;
    }

    let cancelled = false;
    const timer = setTimeout(async () => {
      setTagsLoading(true);
      setTagsError(null);
      try {
        const token = (import.meta as { env?: { VITE_GITHUB_TOKEN?: string } })
          .env?.VITE_GITHUB_TOKEN;
        const fetched = await fetchRepoTags(url, { token });
        if (cancelled) return;
        if (fetched.length === 0) {
          setTagsError("This repository has no tags.");
          setTags([]);
          setBase("");
          setHead("");
        } else {
          setTags(fetched);
          // Default to the two most-recent adjacent tags in API order (index 0 =
          // newest, index 1 = second-newest).  Always reset both when a fresh tag
          // list arrives so stale values from a previous repo are never kept.
          setBase(fetched.length > 1 ? fetched[1] : fetched[0]);
          setHead(fetched[0]);
        }
      } catch (err) {
        if (cancelled) return;
        setTagsError(err instanceof Error ? err.message : String(err));
        setTags([]);
        setBase("");
        setHead("");
      } finally {
        if (!cancelled) setTagsLoading(false);
      }
    }, 600);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [repoUrl]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    // Normalise short "owner/repo" into a full URL
    const url = repoUrl.includes("github.com")
      ? repoUrl
      : `https://github.com/${repoUrl}`;
    onSubmit(url, base, head);
  }

  return (
    <div style={S.page}>
      <div style={S.card}>
        {/* Header */}
        <div style={S.inputHeader}>
          <div>
            <h1 style={S.inputTitle}>FinePrint</h1>
            <p style={S.inputSubtitle}>Check what a release actually changed.</p>
          </div>
          <span style={S.auditBadge}>AUDIT TOOL V1.0</span>
        </div>

        {error && <div style={S.errorBox}>{error}</div>}

        <form onSubmit={handleSubmit}>
          {/* Repo URL */}
          <label style={S.label} htmlFor="repoUrl">
            GitHub repository URL
          </label>
          <input
            id="repoUrl"
            style={S.textInput}
            type="text"
            value={repoUrl}
            onChange={(e) => setRepoUrl(e.target.value)}
            placeholder="https://github.com/owner/repo or owner/repo"
            required
            autoComplete="off"
            spellCheck={false}
          />
          <p style={S.hint}>Enter a canonical repository path or public HTTPS link</p>

          {/* Tag row */}
          {tagsError && <div style={S.errorBox}>{tagsError}</div>}
          <div style={S.tagRow}>
            <div style={S.tagGroup}>
              <label style={S.label} htmlFor="baseTag">
                From tag
              </label>
              <select
                id="baseTag"
                style={S.select}
                value={base}
                onChange={(e) => setBase(e.target.value)}
                disabled={tagsLoading || tags.length === 0}
              >
                {tagsLoading && <option value="">Loading tags…</option>}
                {!tagsLoading && tags.length === 0 && (
                  <option value="">—</option>
                )}
                {tags.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>

            <div style={S.tagGroup}>
              <label style={S.label} htmlFor="headTag">
                To tag
              </label>
              <select
                id="headTag"
                style={S.select}
                value={head}
                onChange={(e) => setHead(e.target.value)}
                disabled={tagsLoading || tags.length === 0}
              >
                {tagsLoading && <option value="">Loading tags…</option>}
                {!tagsLoading && tags.length === 0 && (
                  <option value="">—</option>
                )}
                {tags.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <button
            style={S.checkBtn}
            type="submit"
            disabled={loading || tagsLoading || tags.length === 0}
          >
            {loading ? "CHECKING…" : "CHECK RELEASE →"}
          </button>
        </form>

        {/* Footer */}
        <div style={S.inputFooter}>
          <span>SEC-AUDIT // PARSER_READY</span>
          <span>STRICT_SHA256_VERIFY</span>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ReceiptScreen
// ---------------------------------------------------------------------------

interface ReceiptData {
  owner: string;
  repo: string;
  base: string;
  head: string;
  verdicts: CommitVerdict[];
  commitFiles: Map<string, CommitFile[]>;
}

interface ReceiptScreenProps {
  data: ReceiptData;
  onReset: () => void;
}

function ReceiptScreen({ data, onReset }: ReceiptScreenProps) {
  const { owner, repo, base, head, verdicts, commitFiles } = data;
  const { routine: routineCount, flagged: adjustedCount } =
    computeHealthCounts(verdicts);
  const shortSha = verdicts[0]?.sha.slice(0, 8).toUpperCase() ?? "00000000";

  const receiptRuns = buildReceiptRuns(verdicts);

  function handleCopyRaw() {
    const draft = buildReleaseNotesDraft(verdicts, base, head);
    navigator.clipboard.writeText(draft).catch(() => {
      // fallback: show in prompt
      window.prompt("Copy release notes:", draft);
    });
  }

  return (
    <div style={S.receiptOuter}>
      {/* Receipt card */}
      <div style={S.receiptCard}>
        {/* Meta */}
        <div style={S.receiptMeta}>
          FINEPRINT RECEIPT · #{shortSha}
        </div>

        {/* Version header */}
        <div style={S.receiptVersion}>
          {base} → {head}
        </div>
        <div style={S.receiptSub}>
          {verdicts.length} items · release receipt
        </div>

        {/* Health bar */}
        <HealthBar routine={routineCount} flagged={adjustedCount} />

        <div style={S.dashedDivider} />

        {/* Commit rows (with ok-run collapsing) */}
        {receiptRuns.map((run, idx) =>
          run.kind === "group" ? (
            <CollapsibleOkGroup
              key={`group-${idx}`}
              verdicts={run.verdicts}
              allFilesMap={commitFiles}
              owner={owner}
              repo={repo}
              base={base}
              head={head}
            />
          ) : (
            <CommitRow
              key={run.verdict.sha}
              verdict={run.verdict}
              allFiles={commitFiles.get(run.verdict.sha) ?? []}
              owner={owner}
              repo={repo}
              base={base}
              head={head}
            />
          )
        )}

        {/* Total */}
        <div style={S.totalRow}>
          <span>TOTAL —</span>
          <span>
            <span style={S.totalAdjusted}>
              {adjustedCount} of {verdicts.length} adjusted
            </span>
          </span>
        </div>

        {/* Stamp */}
        <div style={S.receiptStamp}>
          <span>STAMP: SHA256 // VERIFIED</span>
          <span>REC-OK</span>
        </div>
      </div>

      {/* Jagged edge */}
      <div style={{ width: "100%", maxWidth: 560 }}>
        <JaggedEdge />
      </div>

      {/* Bottom bar */}
      <div style={S.receiptBottom}>
        <button style={S.bottomBtn} onClick={onReset}>
          ← check another release
        </button>
        <button style={S.bottomBtn} onClick={handleCopyRaw}>
          copy raw receipt
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// App — root component
// ---------------------------------------------------------------------------

type AppScreen = "input" | "loading" | "receipt";

export default function App() {
  const [screen, setScreen] = useState<AppScreen>("input");
  const [error, setError] = useState<string | null>(null);
  const [receiptData, setReceiptData] = useState<ReceiptData | null>(null);

  const handleCheck = useCallback(
    async (repoUrl: string, base: string, head: string) => {
      setError(null);
      setScreen("loading");

      try {
        const { owner, repo } = parseRepoUrl(repoUrl);

        // Fetch commit range from GitHub
        const token = (import.meta as { env?: { VITE_GITHUB_TOKEN?: string } })
          .env?.VITE_GITHUB_TOKEN;
        const commits = await fetchCommitRange(repoUrl, base, head, {
          token,
        });

        // Run checks
        const verdicts = runChecks(commits, base, head);

        // Build sha → files map for diff rendering
        const commitFiles = new Map<string, CommitFile[]>();
        for (const c of commits) {
          commitFiles.set(c.sha, c.files);
        }

        setReceiptData({ owner, repo, base, head, verdicts, commitFiles });
        setScreen("receipt");
      } catch (err) {
        // Give a friendly, non-technical message when the range is too large.
        const friendly = err instanceof OversizedRangeError
          ? "This range spans too many commits — FinePrint checks one release at a time. Try comparing two adjacent tags instead."
          : err instanceof Error ? err.message : String(err);
        setError(friendly);
        setScreen("input");
      }
    },
    []
  );

  const handleReset = useCallback(() => {
    setReceiptData(null);
    setError(null);
    setScreen("input");
  }, []);

  if (screen === "loading") {
    return (
      <div
        style={{
          ...S.page,
          fontFamily: MONO,
          fontSize: 14,
          color: "#555",
          letterSpacing: "0.06em",
        }}
      >
        FETCHING COMMITS… PLEASE WAIT
      </div>
    );
  }

  if (screen === "receipt" && receiptData) {
    return <ReceiptScreen data={receiptData} onReset={handleReset} />;
  }

  return (
    <InputScreen
      onSubmit={handleCheck}
      loading={false}
      error={error}
    />
  );
}
