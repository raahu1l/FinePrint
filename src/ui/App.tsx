import { useCallback, useEffect, useMemo, useState } from "react";
import type React from "react";
import type { CheckFinding, CommitVerdict } from "../checks/types.js";
import { runChecks } from "../checks/checkLogic.js";
import {
  fetchCommitRange,
  fetchRepoTags,
  parseRepoUrl,
} from "../github/fetchCommitRange.js";
import type { CommitFile, CommitRecord } from "../github/types.js";
import { GitHubApiError, RateLimitError } from "../github/types.js";
import {
  buildReleaseXray,
  LARGE_RELEASE_FILE_THRESHOLD,
  type ReleaseXrayModel,
  type ReleaseFinding,
  type XrayCategory,
  type XrayFile,
  type XrayFileState,
} from "./releaseXrayUtils.js";
import { extractSubject } from "./diffUtils.js";

const DEFAULT_REPO = "raahu1l/FinePrint";
const DEFAULT_BASE_TAG = "v0.1.0";
const DEFAULT_HEAD_TAG = "v0.2.0";
const DEFAULT_BASE = DEFAULT_BASE_TAG;
const DEFAULT_HEAD = DEFAULT_HEAD_TAG;
const API_BASE =
  (import.meta as { env?: { PROD?: boolean } }).env?.PROD ||
  (typeof window !== "undefined" && window.location.port === "8888")
    ? "/.netlify/functions/github"
    : "https://api.github.com";

const stateLabels: Record<XrayFileState, string> = {
  red: "Undisclosed area",
  amber: "Flagged check",
  green: "No finding",
  grey: "Excluded / unknown",
  mixed: "Mixed commit results",
  unknown: "Evidence unavailable",
};
const stateColors: Record<XrayFileState, string> = {
  red: "#ff5d70",
  amber: "#ffc857",
  green: "#46d5bd",
  grey: "#8290aa",
  mixed: "#b18cff",
  unknown: "#9ca7ba",
};

const findingTitles: Record<CheckFinding["check"], string> = {
  "area-mismatch": "Undisclosed change",
  semver: "Semver violation",
  dependency: "Dependency bump",
};

function friendlyError(error: unknown): string {
  if (error instanceof RateLimitError) return error.message;
  if (error instanceof GitHubApiError && error.status === 404) {
    return "Repository or tag not found. Check the URL and selected tags.";
  }
  return error instanceof Error ? error.message : String(error);
}

function subject(message: string): string {
  return extractSubject(message);
}

function DiffView({ patch }: { patch: string | null }) {
  if (!patch) {
    return <p className="empty-evidence">GitHub did not provide a patch for this file (it may be binary or unavailable).</p>;
  }
  return (
    <pre className="diff-view">
      {patch.split("\n").map((line, index) => (
        <span className={line.startsWith("+") ? "diff-add" : line.startsWith("-") ? "diff-remove" : "diff-context"} key={`${index}-${line}`}>
          {line}
          {"\n"}
        </span>
      ))}
    </pre>
  );
}

function XraySilhouette({ category }: { category: XrayCategory }) {
  if (category === "UI / Components") {
    return <svg className="object-silhouette" viewBox="0 0 84 64" aria-hidden="true"><rect x="11" y="8" width="62" height="42" rx="4" /><path d="M31 58h22M42 50v8" /><rect x="18" y="15" width="48" height="28" rx="2" /></svg>;
  }
  if (category === "Backend / API") {
    return <svg className="object-silhouette" viewBox="0 0 84 64" aria-hidden="true"><rect x="17" y="8" width="50" height="48" rx="5" /><path d="M27 20h30M27 32h30M27 44h30M24 14v36M60 14v36" /><circle cx="33" cy="26" r="2" /><circle cx="33" cy="38" r="2" /></svg>;
  }
  if (category === "Dependencies") {
    return <svg className="object-silhouette" viewBox="0 0 84 64" aria-hidden="true"><path d="M12 24l30-14 30 14-30 14z" /><path d="M12 24v24l30 14 30-14V24M42 38v24" /><path d="M24 19l30 14" /></svg>;
  }
  if (category === "Tests") {
    return <svg className="object-silhouette" viewBox="0 0 84 64" aria-hidden="true"><path d="M27 9h30M32 9v18L19 48a7 7 0 007 7h32a7 7 0 007-7L52 27V9" /><path d="M27 43h30M30 36h24" /></svg>;
  }
  if (category === "Configuration") {
    return <svg className="object-silhouette" viewBox="0 0 84 64" aria-hidden="true"><rect x="10" y="10" width="64" height="44" rx="5" /><circle cx="25" cy="27" r="5" /><circle cx="42" cy="27" r="5" /><circle cx="59" cy="27" r="5" /><path d="M22 43h40" /></svg>;
  }
  if (category === "Documentation") {
    return <svg className="object-silhouette" viewBox="0 0 84 64" aria-hidden="true"><path d="M18 8h38l10 10v38H18zM56 8v12h10" /><path d="M27 29h30M27 38h30M27 47h22" /></svg>;
  }
  if (category === "CI / Infrastructure") {
    return <svg className="object-silhouette" viewBox="0 0 84 64" aria-hidden="true"><circle cx="16" cy="32" r="7" /><circle cx="42" cy="32" r="7" /><circle cx="68" cy="32" r="7" /><path d="M23 32h12M49 32h12" /></svg>;
  }
  return <svg className="object-silhouette" viewBox="0 0 84 64" aria-hidden="true"><path d="M18 8h38l10 10v38H18zM56 8v12h10" /><path d="M27 32h30M27 41h22M27 50h26" /></svg>;
}

function XrayObject({ file, selected, onSelect }: { file: XrayFile; selected: boolean; onSelect: () => void }) {
  const color = stateColors[file.state];
  return (
    <button
      type="button"
      className={`xray-object ${selected ? "selected" : ""}`}
      style={{ "--object-color": color } as React.CSSProperties}
      onClick={onSelect}
      aria-label={`Inspect ${file.filename}, ${file.category}, ${stateLabels[file.state]}${file.statuses.length > 0 ? `, status ${file.statuses.join(", ")}` : ""}`}
    >
      <XraySilhouette category={file.category} />
      <span className="object-name">{file.filename.split("/").pop()}</span>
      {file.statuses.length > 0 && <span className="object-status">{file.statuses.join(" / ")}</span>}
    </button>
  );
}

function Scanner({ model, selectedCategory, selectedFile, onCategory, onFile }: {
  model: ReleaseXrayModel;
  selectedCategory: XrayCategory | null;
  selectedFile: XrayFile | null;
  onCategory: (category: XrayCategory | null) => void;
  onFile: (file: XrayFile) => void;
}) {
  const visible = selectedCategory
    ? model.files.filter((file) => file.category === selectedCategory)
    : model.files;
  const isLargeRelease = model.uniqueFiles >= LARGE_RELEASE_FILE_THRESHOLD;
  const selectedGroup = selectedCategory
    ? model.categories.find((group) => group.category === selectedCategory)
    : null;
  const categoryCounts = selectedGroup
    ? {
        red: selectedGroup.files.filter((file) => file.state === "red").length,
        amber: selectedGroup.files.filter((file) => file.state === "amber").length,
        unknown: selectedGroup.files.filter((file) => file.state === "unknown").length,
        other: selectedGroup.files.filter((file) => !["red", "amber", "unknown"].includes(file.state)).length,
      }
    : null;
  return (
    <section className="scanner-panel">
      <div className="scanner-toolbar">
        <div><span className="eyebrow">LIVE INSPECTION</span><h2>Release X-ray</h2></div>
        <div className="legend">{(["red", "amber", "green", "grey", "mixed", "unknown"] as XrayFileState[]).map((state) => <span key={state}><i style={{ background: stateColors[state] }} />{stateLabels[state]}</span>)}</div>
      </div>
      {selectedGroup && categoryCounts && (
        <div className="category-summary" role="status">
          <button type="button" onClick={() => onCategory(null)} aria-label="Return to all file categories">← All files</button>
          <strong>{selectedGroup.category}</strong>
          <span>{selectedGroup.files.length} files</span>
          {categoryCounts.red > 0 && <span className="category-count red">{categoryCounts.red} undisclosed</span>}
          {categoryCounts.amber > 0 && <span className="category-count amber">{categoryCounts.amber} review</span>}
          {categoryCounts.unknown > 0 && <span className="category-count unknown">{categoryCounts.unknown} unavailable</span>}
        </div>
      )}
      <div className="scanner">
        <div className="scan-line" />
        <div className="object-grid">
          {isLargeRelease && !selectedCategory
            ? model.categories.map((group) => (
                <button
                  type="button"
                  className="xray-object category-cluster"
                  key={group.category}
                  onClick={() => onCategory(group.category)}
                  aria-label={`Open ${group.category} category with ${group.files.length} files`}
                >
                  <XraySilhouette category={group.category} />
                  <span className="object-name">{group.category}</span>
                  <span className="object-status">{group.files.length} files</span>
                </button>
              ))
            : visible.map((file) => <XrayObject key={file.filename} file={file} selected={selectedFile?.filename === file.filename} onSelect={() => onFile(file)} />)}
          {visible.length === 0 && <p className="scanner-empty">No changed files in this category.</p>}
        </div>
      </div>
      <div className="category-strip">
        <button type="button" className={!selectedCategory ? "category active" : "category"} onClick={() => onCategory(null)}>All files <b>{model.uniqueFiles}</b></button>
        {model.categories.map((group) => <button type="button" className={selectedCategory === group.category ? "category active" : "category"} key={group.category} onClick={() => onCategory(group.category)}>{group.category} <b>{group.files.length}</b></button>)}
      </div>
    </section>
  );
}

function FileExplorer({ model, selectedCategory, selectedFile, onFile }: { model: ReleaseXrayModel; selectedCategory: XrayCategory | null; selectedFile: XrayFile | null; onFile: (file: XrayFile) => void }) {
  const files = selectedCategory ? model.files.filter((file) => file.category === selectedCategory) : model.files;
  return <div className="file-list">{files.map((file) => <button className={`file-row ${selectedFile?.filename === file.filename ? "selected" : ""}`} key={file.filename} onClick={() => onFile(file)}><span className="state-dot" style={{ background: stateColors[file.state] }} /><span className="file-path">{file.filename}</span><span className="file-stats">+{file.additions} −{file.deletions}</span></button>)}</div>;
}

export function findingKey(commitSha: string, finding: CheckFinding): string {
  return `${commitSha}-${finding.check}-${finding.explanation}`;
}

export function resolveFindingSelection(
  model: ReleaseXrayModel,
  commitSha: string,
  finding: CheckFinding
): { file: XrayFile | null; commitSha: string } {
  if (finding.affectedFilenames?.length) {
    const affected = finding.affectedFilenames;
    const file = model.files.find((candidate) =>
      candidate.commits.some((item) => item.commit.sha === commitSha) &&
      affected.some((filename) => filename === candidate.filename || candidate.previousFilenames.includes(filename))
    ) ?? model.files.find((candidate) =>
      affected.some((filename) => filename === candidate.filename || candidate.previousFilenames.includes(filename))
    ) ?? null;
    return { file, commitSha };
  }
  return { file: null, commitSha };
}

export function FileDetails({
  file,
  owner,
  repo,
  initialCommitSha,
  selectedFindingKey,
  onFinding,
}: {
  file: XrayFile;
  owner: string;
  repo: string;
  initialCommitSha?: string;
  selectedFindingKey?: string;
  onFinding?: (commitSha: string, finding: CheckFinding) => void;
}) {
  const [commitSha, setCommitSha] = useState(initialCommitSha ?? file.commits[0]?.commit.sha ?? "");
  const selected = file.commits.find((item) => item.commit.sha === commitSha) ?? file.commits[0];
  useEffect(() => setCommitSha(initialCommitSha ?? file.commits[0]?.commit.sha ?? ""), [file, initialCommitSha]);
  if (!selected) return null;
  const { commit, verdict } = selected;
  return (
    <aside className="details">
      <div className="details-heading"><span className="eyebrow">FILE INSPECTION</span><h2>{file.filename}</h2><p><span className="status-pill" style={{ color: stateColors[file.state] }}>{stateLabels[file.state]}</span> · {file.category}</p></div>
      <div className="stat-grid"><span><b>+{file.additions}</b> additions</span><span><b>−{file.deletions}</b> deletions</span><span><b>{file.commits.length}</b> associated commits</span>{file.statuses.length > 0 && <span><b>{file.statuses.join(" / ")}</b> file status</span>}</div>
      {file.previousFilenames.length > 0 && <p className="muted">Renamed from {file.previousFilenames.join(", ")}</p>}
      <label className="eyebrow" htmlFor="commit-select">COMMIT EVIDENCE</label>
      <select id="commit-select" className="commit-select" value={commitSha} onChange={(event) => setCommitSha(event.target.value)}>{file.commits.map((item) => <option value={item.commit.sha} key={item.commit.sha}>{subject(item.commit.message)} · {item.commit.sha.slice(0, 7)}</option>)}</select>
      <div className="commit-card"><div className="commit-card-top"><b>{subject(commit.message)}</b><code>{commit.sha.slice(0, 7)}</code></div><p className="muted">{verdict.status === "mechanical" ? "Mechanical commit excluded from verification." : verdict.status === "ok" ? "No current verification rule flagged this commit." : "This commit needs review."}</p>{verdict.findings?.map((finding) => {
        const key = findingKey(commit.sha, finding);
        return <button
          type="button"
          className={`finding ${selectedFindingKey === key ? "selected" : ""}`}
          key={key}
          onClick={() => onFinding?.(commit.sha, finding)}
          aria-pressed={selectedFindingKey === key}
        ><strong>{finding.check}</strong><span>{finding.explanation}</span></button>;
      })}{verdict.findings?.length === 0 && <p className="muted">No finding. This is not proof that the change is safe.</p>}</div>
      <div className="evidence-heading"><span className="eyebrow">CODE EVIDENCE</span><a href={`https://github.com/${owner}/${repo}/commit/${commit.sha}`} target="_blank" rel="noreferrer">Open on GitHub ↗</a></div>
      {file.hasUnavailableEvidence && selected.file.patch === null
        ? <div><p className="empty-evidence">Evidence unavailable: GitHub did not provide a patch for this file. It may be binary or its diff content may be unavailable.</p>{verdict.findings?.length ? <p className="muted">The verification finding below remains rule-based; it is not strengthened or replaced by fabricated diff evidence.</p> : null}</div>
        : <DiffView patch={selected.file.patch} />}
    </aside>
  );
}

export function FindingSummary({
  model,
  onFinding,
}: {
  model: ReleaseXrayModel;
  onFinding: (commitSha: string, finding: CheckFinding) => void;
}) {
  if (model.findingItems.length === 0) {
    return (
      <section className="findings-section">
        <div className="section-heading"><span className="eyebrow">CHANGES REQUIRING ATTENTION</span><h2>No findings detected</h2></div>
        <p className="findings-empty">The current rule-based checks found no release discrepancy. This does not prove every change is safe.</p>
      </section>
    );
  }
  return (
    <section className="findings-section">
      <div className="section-heading"><span className="eyebrow">CHANGES REQUIRING ATTENTION</span><h2>{model.findingItems.length} finding{model.findingItems.length === 1 ? "" : "s"} to review</h2></div>
      <div className="finding-cards">
        {model.findingItems.map((finding) => {
          const affected = finding.affectedFilenames?.join(", ");
          return (
            <article className={`finding-card ${finding.check}`} key={`${finding.commitSha}-${finding.check}-${finding.explanation}`}>
              <div>
                <span className="finding-kicker">{findingTitles[finding.check]}</span>
                <h3>{finding.explanation}</h3>
                <p>{affected ? affected : "Commit-level finding; exact affected file unavailable"}</p>
                <code>{finding.commitSha.slice(0, 7)} · {subject(finding.commitMessage)}</code>
              </div>
              <button type="button" onClick={() => onFinding(finding.commitSha, finding)}>View evidence <span aria-hidden="true">→</span></button>
            </article>
          );
        })}
      </div>
    </section>
  );
}

export function CommitEvidenceDetails({
  commit,
  verdict,
  finding,
  owner,
  repo,
}: {
  commit: CommitRecord;
  verdict: CommitVerdict;
  finding?: CheckFinding;
  owner: string;
  repo: string;
}) {
  const firstPatch = commit.files.find((file) => file.patch !== null)?.patch ?? null;
  const firstFilename = commit.files.find((file) => file.patch !== null)?.filename;
  return (
    <aside className="details commit-only-details" id="inspection-details">
      <div className="details-heading"><span className="eyebrow">COMMIT-LEVEL EVIDENCE</span><h2>{subject(commit.message)}</h2><code>{commit.sha.slice(0, 7)}</code></div>
      {finding ? <div className="finding commit-finding"><strong>{findingTitles[finding.check]}</strong><span>{finding.explanation}</span></div> : null}
      {verdict.status === "mechanical" ? <p className="muted">Mechanical commit excluded from verification.</p> : <p className="muted">{verdict.status === "ok" ? "No current verification rule flagged this commit." : "This commit needs review."}</p>}
      {commit.files.length > 0 && (
        <>
          <span className="eyebrow">ASSOCIATED FILES</span>
          <ul className="commit-file-list">{commit.files.map((file) => <li key={file.filename}>{file.filename}</li>)}</ul>
        </>
      )}
      <div className="evidence-heading"><span className="eyebrow">CODE EVIDENCE</span><a href={`https://github.com/${owner}/${repo}/commit/${commit.sha}`} target="_blank" rel="noreferrer">Open on GitHub ↗</a></div>
      {firstPatch ? <><span className="evidence-file">{firstFilename}</span><DiffView patch={firstPatch} /></> : <p className="empty-evidence">Evidence unavailable: GitHub did not provide an inspectable patch for this commit. No fake diff is shown.</p>}
    </aside>
  );
}

function VerificationChecks({ verdicts }: { verdicts: CommitVerdict[] }) {
  const checks = [
    { key: "area-mismatch", name: "Undisclosed Changes", description: "Area mismatch between the commit message and changed paths." },
    { key: "semver", name: "Semver Check", description: "Breaking-change patterns in a non-major release." },
    { key: "dependency", name: "Dependency Check", description: "Major dependency-version increases in manifests." },
  ] as const;
  return <section className="checks"><div><span className="eyebrow">VERIFICATION RULES</span><h2>What the engine found</h2></div><div className="check-grid">{checks.map((check) => { const count = verdicts.reduce((sum, verdict) => sum + (verdict.findings?.filter((finding) => finding.check === check.key).length ?? 0), 0); return <div className="check-card" key={check.key}><span className="check-count">{count}</span><h3>{check.name}</h3><p>{check.description}</p></div>; })}</div></section>;
}

export function CollapsibleOkGroup({ verdicts }: { verdicts: CommitVerdict[]; allFilesMap?: Map<string, CommitFile[]>; owner?: string; repo?: string; base?: string; head?: string }) {
  const [open, setOpen] = useState(false);
  if (!open) return <button className="routine-toggle" onClick={() => setOpen(true)}>▸ {verdicts.length} routine commits — all clear ▸</button>;
  const collapse = <button className="routine-toggle" onClick={() => setOpen(false)}>▾ collapse {verdicts.length} routine commits</button>;
  return <>{collapse}{verdicts.map((verdict) => <div className="routine-commit" key={verdict.sha}>{subject(verdict.message)}</div>)}{collapse}</>;
}

function InputScreen({ onSubmit, error, initialRepo, initialBase, initialHead }: { onSubmit: (repo: string, base: string, head: string) => void; error: string | null; initialRepo: string; initialBase: string; initialHead: string }) {
  const [repo, setRepo] = useState(initialRepo);
  const [base, setBase] = useState(initialBase);
  const [head, setHead] = useState(initialHead);
  const [tags, setTags] = useState<string[]>([]);
  const [loadingTags, setLoadingTags] = useState(false);
  useEffect(() => {
    if (!repo.trim()) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const url = repo.includes("github.com") ? repo : `https://github.com/${repo}`;
        parseRepoUrl(url); setLoadingTags(true);
        const fetched = await fetchRepoTags(url, { apiBase: API_BASE, cacheTtlMs: 60_000 });
        if (!cancelled) { setTags(fetched); if (fetched.length) { setHead(fetched[0]); setBase(fetched[1] ?? fetched[0]); } }
      } catch { if (!cancelled) setTags([]); } finally { if (!cancelled) setLoadingTags(false); }
    }, 350);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [repo]);
  return <main className="input-page"><div className="input-card"><div className="brand-mark">FINE<span>PRINT</span></div><span className="eyebrow">SOFTWARE RELEASE X-RAY</span><h1>Inspect what changed.</h1><p className="lead">Compare two GitHub tags and trace every changed file back to the commits and code that produced it.</p>{error && <div className="error">{error}</div>}<form onSubmit={(event) => { event.preventDefault(); onSubmit(repo.includes("github.com") ? repo : `https://github.com/${repo}`, base, head); }}><label>Repository<input value={repo} onChange={(event) => setRepo(event.target.value)} placeholder="owner/repository" required /></label><div className="tag-fields"><label>Base tag<select value={base} onChange={(event) => setBase(event.target.value)} disabled={loadingTags || !tags.length}>{tags.length ? tags.map((tag) => <option key={tag}>{tag}</option>) : <option>{base}</option>}</select></label><label>Head tag<select value={head} onChange={(event) => setHead(event.target.value)} disabled={loadingTags || !tags.length}>{tags.length ? tags.map((tag) => <option key={tag}>{tag}</option>) : <option>{head}</option>}</select></label></div><button className="primary" type="submit">{loadingTags ? "Loading tags…" : "Scan release →"}</button></form></div></main>;
}

interface ReportData { owner: string; repo: string; base: string; head: string; commits: CommitRecord[]; verdicts: CommitVerdict[]; cappedAt?: number; totalCommits: number; }

function Report({ data, onReset }: { data: ReportData; onReset: () => void }) {
  const model = useMemo(() => buildReleaseXray(data.commits, data.verdicts), [data.commits, data.verdicts]);
  const [category, setCategory] = useState<XrayCategory | null>(null);
  const [selected, setSelected] = useState<XrayFile | null>(model.files[0] ?? null);
  const [selectedCommitSha, setSelectedCommitSha] = useState<string | undefined>(model.files[0]?.commits[0]?.commit.sha);
  const [selectedFindingKey, setSelectedFindingKey] = useState<string | undefined>();
  const [commitOnlyFinding, setCommitOnlyFinding] = useState<CheckFinding | undefined>();
  const adjusted = data.verdicts.filter((verdict) => verdict.status === "adjusted").length;
  const releaseStatus = data.cappedAt
    ? "Incomplete inspection"
    : model.findings > 0
      ? "Review required"
      : "No findings detected";
  const handleFinding = (commitSha: string, finding: CheckFinding) => {
    const selection = resolveFindingSelection(model, commitSha, finding);
    setSelectedCommitSha(commitSha);
    setSelectedFindingKey(findingKey(commitSha, finding));
    if (selection.file) {
      setCategory(selection.file.category);
      setSelected(selection.file);
      setCommitOnlyFinding(undefined);
    } else {
      setCategory(null);
      setSelected(null);
      setCommitOnlyFinding(finding);
    }
    window.requestAnimationFrame(() => {
      document.getElementById("inspection-details")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  };
  const handleFile = (file: XrayFile) => {
    setSelected(file);
    setCommitOnlyFinding(undefined);
    setSelectedFindingKey(undefined);
    setSelectedCommitSha(file.commits[0]?.commit.sha);
  };
  const commitOnly = selectedCommitSha
    ? data.commits.find((commit) => commit.sha === selectedCommitSha)
    : undefined;
  const commitOnlyVerdict = selectedCommitSha
    ? data.verdicts.find((verdict) => verdict.sha === selectedCommitSha)
    : undefined;

  return (
    <main className="report-page">
      <header className="report-header">
        <div className="brand-mark">FINE<span>PRINT</span></div>
        <div className="header-actions">
          <a href={`https://github.com/${data.owner}/${data.repo}`} target="_blank" rel="noreferrer">{data.owner}/{data.repo} ↗</a>
          <button type="button" onClick={() => window.print()}>Export</button>
          <button type="button" className="primary small" onClick={onReset}>New audit</button>
        </div>
      </header>

      <section className="release-identity">
        <div>
          <span className="eyebrow">RELEASE PACKAGE</span>
          <h1>{data.base} <span>→</span> {data.head}</h1>
          <p>{data.owner}/{data.repo} · {data.verdicts.length} commits analyzed · {model.uniqueFiles} unique files</p>
        </div>
        <div className="release-status-block">
          <span className={`release-status ${data.cappedAt ? "incomplete" : model.findings > 0 ? "review" : "clear"}`}>{releaseStatus}</span>
          <div className="identity-stats"><b>{model.findings}</b><span>findings</span><b>{adjusted}</b><span>commits flagged</span></div>
        </div>
      </section>

      {data.cappedAt && <div className="cap-notice">This comparison reached the {data.cappedAt}-commit limit: {data.verdicts.length} of {data.totalCommits} commits were analyzed. The report is incomplete.</div>}

      <Scanner
        model={model}
        selectedCategory={category}
        selectedFile={selected}
        onCategory={(next) => {
          setCategory(next);
          setCommitOnlyFinding(undefined);
          setSelected(next ? model.files.find((file) => file.category === next) ?? null : model.files[0] ?? null);
          setSelectedFindingKey(undefined);
        }}
        onFile={handleFile}
      />

      <FindingSummary model={model} onFinding={handleFinding} />

      <section className="explorer" id="inspection-details">
        <div className="explorer-list">
          <span className="eyebrow">CHANGED FILES</span>
          <h2>{category ?? "Complete release"}</h2>
          <FileExplorer model={model} selectedCategory={category} selectedFile={selected} onFile={handleFile} />
        </div>
        {selected ? (
          <FileDetails file={selected} owner={data.owner} repo={data.repo} initialCommitSha={selectedCommitSha} selectedFindingKey={selectedFindingKey} onFinding={handleFinding} />
        ) : commitOnly && commitOnlyVerdict ? (
          <CommitEvidenceDetails commit={commitOnly} verdict={commitOnlyVerdict} finding={commitOnlyFinding} owner={data.owner} repo={data.repo} />
        ) : (
          <div className="details empty-state">No files changed in this release.</div>
        )}
      </section>

      <VerificationChecks verdicts={data.verdicts} />
      <section className="summary">
        <span className="eyebrow">SUMMARY</span>
        <p>{model.findings ? `FinePrint found ${model.findings} rule-based finding${model.findings === 1 ? "" : "s"} across this release. Select a finding or file to inspect the associated commit and available patch evidence.` : "No current verification rule flagged this release. That is not proof that every change is safe; it means the configured checks found no finding."}</p>
      </section>
    </main>
  );
}

export default function App() {
  const [screen, setScreen] = useState<"input" | "loading" | "report">("input");
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<ReportData | null>(null);
  const [progress, setProgress] = useState<{ fetched: number; total: number } | null>(null);
  const handleCheck = useCallback(async (repoUrl: string, base: string, head: string) => {
    setError(null); setProgress(null); setScreen("loading");
    try {
      const { owner, repo } = parseRepoUrl(repoUrl);
      const result = await fetchCommitRange(repoUrl, base, head, { apiBase: API_BASE, cacheTtlMs: 60_000, onProgress: (fetched, total) => setProgress({ fetched, total }) });
      setData({ owner, repo, base, head, commits: result.commits, verdicts: runChecks(result.commits, base, head), cappedAt: result.cappedAt, totalCommits: result.totalCommits });
      setScreen("report");
    } catch (caught) { setError(friendlyError(caught)); setScreen("input"); }
  }, []);
  if (screen === "loading") return <main className="loading-page"><div className="loading-card"><div className="brand-mark">FINE<span>PRINT</span></div><span className="eyebrow">SCANNING RELEASE PACKAGE</span><h1>{progress ? `${progress.fetched} of ${progress.total} commits` : "Preparing inspection…"}</h1><div className="loading-bar" /></div></main>;
  if (screen === "report" && data) return <Report data={data} onReset={() => { setData(null); setScreen("input"); }} />;
  return <InputScreen onSubmit={handleCheck} error={error} initialRepo={DEFAULT_REPO} initialBase={DEFAULT_BASE} initialHead={DEFAULT_HEAD} />;
}
