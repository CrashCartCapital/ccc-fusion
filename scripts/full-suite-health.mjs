#!/usr/bin/env node
/*
FNXC:FullSuiteHealth 2026-09-11:
`.archive/full-suite-red-diagnosis-20260911.md` found Full Suite (non-blocking) red since
2026-08-11 with zero alerting: no notify/webhook/issue step in any workflow, and the
quarantine ratchet's ledger (which the diagnosis explicitly says covers flakes, not real
bugs) had been empty since 2026-08-31. This script is the heartbeat action item ("give the
tier a heartbeat"): one notification per red run (not per job), a red-streak clock, and
lane-level "did this even execute" signals for the two lanes that silently stopped running
for a month (engine-slow: a later step in the same job as product-route with no
`if: always()`, so a product-route failure skipped it silently; the macOS-only proof tier,
which has no Linux backend at all). It is deliberately read-only report generation plus at
most one tracking issue create/update — never a merge gate, never a retry, never a fix.
*/

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { TIMINGS_STALENESS_DAYS } from "./ci-test-shard.mjs";
import { DEFAULT_QUARANTINE_PATH } from "./test-velocity-baseline.mjs";

const currentFilePath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(currentFilePath), "..");

export const WORKFLOW_FILE = "full-suite.yml";
export const TARGET_BRANCH = "main";
export const RUN_HISTORY_LIMIT = 10;
export const RED_STREAK_ALERT_THRESHOLD = 3;
export const HEALTH_LABEL = "full-suite-health";
export const DEFAULT_REPO_SLUG = "CrashCartCapital/ccc-fusion";

// The step lives inside the `test-slow` job ("Product route + engine slow") in
// full-suite.yml. The Darwin lane job does not exist on main yet (it lands with
// PR-A / full-suite-workflow-dispatch, plan work package W0-darwin); this constant
// records the job `name:` the plan commits to. If PR-A ships a different display
// name, update this constant in the same PR. Until a job/step by this exact name
// has actually been observed at least once in the run-history lookback window
// (see `collectKnownNames`), `main()` treats the lane as "not yet landed" rather
// than "not executing" and never alerts on it — so this constant naming a lane
// that doesn't exist yet cannot produce a guaranteed false alert on every run.
export const ENGINE_SLOW_STEP_NAME = "Run engine-slow with non-empty-execution assertion";
export const DARWIN_LANE_JOB_NAME = "Darwin proof lane (M2 native)";

const MS_PER_DAY = 86_400_000;

const TIMINGS_SNAPSHOT_RELATIVE = "scripts/test-timings.json";

const VITEST_CONFIG_PACKAGES = [
  { name: "@fusion/core", prefix: "packages/core", configPath: "packages/core/vitest.config.ts" },
  { name: "@fusion/engine", prefix: "packages/engine", configPath: "packages/engine/vitest.config.ts" },
  { name: "@fusion/dashboard", prefix: "packages/dashboard", configPath: "packages/dashboard/vitest.config.ts" },
  { name: "@runfusion/fusion", prefix: "packages/cli", configPath: "packages/cli/vitest.config.ts" },
];

// ---------------------------------------------------------------------------
// Pure functions (RED-first covered by scripts/__tests__/full-suite-health.test.mjs).
// Every GitHub call site is injected (see createGithubClient / main's `github`
// option) so none of these — or the tests that exercise them — ever reach the
// network.
// ---------------------------------------------------------------------------

/**
 * Count the most-recent consecutive "red" (conclusion === "failure") runs.
 * `runs` must be newest-first (the GitHub Actions list-runs API's default
 * order) and pre-filtered to `status === "completed"` — this function does
 * not know about in-progress/queued runs.
 *
 * A "success" run stops the streak. Any other conclusion (cancelled,
 * timed_out, action_required, neutral, stale, skipped) is inconclusive: the
 * diagnosis explicitly separates "failed" from "cancelled" runs, so a
 * cancelled run neither extends nor breaks the streak — the scan just keeps
 * looking through it for the next real signal.
 *
 * @param {Array<{ conclusion: string|null }>} runs
 * @returns {number}
 */
export function computeRedStreak(runs) {
  let streak = 0;
  for (const run of runs) {
    if (run.conclusion === "failure") {
      streak += 1;
      continue;
    }
    if (run.conclusion === "success") {
      break;
    }
    // inconclusive conclusion (cancelled, timed_out, action_required, neutral,
    // stale, or missing) — skip without resetting or extending the streak.
  }
  return streak;
}

/**
 * Did a named step execute (conclusion present and not "skipped") anywhere
 * across a run's jobs? Returns false when the step is not found at all —
 * that is the "job/step renamed or removed" case, and it should read the
 * same as "did not execute" rather than throw.
 *
 * @param {Array<{ steps?: Array<{ name: string, conclusion: string|null }> }>} jobs
 * @param {string} stepName
 * @returns {boolean}
 */
export function stepExecuted(jobs, stepName) {
  for (const job of jobs ?? []) {
    for (const step of job.steps ?? []) {
      if (step.name === stepName) {
        return step.conclusion != null && step.conclusion !== "skipped";
      }
    }
  }
  return false;
}

/**
 * Did a named job execute (conclusion present and not "skipped")?
 *
 * @param {Array<{ name: string, conclusion: string|null }>} jobs
 * @param {string} jobName
 * @returns {boolean}
 */
export function jobExecuted(jobs, jobName) {
  const job = (jobs ?? []).find((candidate) => candidate.name === jobName);
  if (!job) return false;
  return job.conclusion != null && job.conclusion !== "skipped";
}

/**
 * @param {Array<object>} jobs
 * @returns {{ engineSlowExecuted: boolean, darwinLaneExecuted: boolean }}
 */
export function computeLaneExecution(jobs) {
  return {
    engineSlowExecuted: stepExecuted(jobs, ENGINE_SLOW_STEP_NAME),
    darwinLaneExecuted: jobExecuted(jobs, DARWIN_LANE_JOB_NAME),
  };
}

/**
 * Collect every job name and step name that appears anywhere across a set of
 * fetched job lists, regardless of conclusion (present-but-skipped counts as
 * "seen"; entirely absent does not). This is how `main()` tells "this lane
 * doesn't exist in the workflow yet, or was renamed/removed" (never seen at
 * all across the lookback window) apart from "this lane exists but isn't
 * executing right now" (seen, just not currently running) — a lane that
 * hasn't landed yet, or whose name no longer matches, can then never produce
 * a guaranteed false "not executing" alert; see `jobExecuted`/`stepExecuted`,
 * which both collapse "absent" and "present but skipped" into the same
 * `false`, and DARWIN_LANE_JOB_NAME's own doc comment above.
 *
 * @param {Array<Array<{ name: string, steps?: Array<{ name: string }> }>>} jobsByRun one fetched job list per run
 * @returns {{ jobNames: Set<string>, stepNames: Set<string> }}
 */
export function collectKnownNames(jobsByRun) {
  const jobNames = new Set();
  const stepNames = new Set();
  for (const jobs of jobsByRun ?? []) {
    for (const job of jobs ?? []) {
      if (job?.name) jobNames.add(job.name);
      for (const step of job?.steps ?? []) {
        if (step?.name) stepNames.add(step.name);
      }
    }
  }
  return { jobNames, stepNames };
}

/**
 * The most recent lane-execution row worth alerting on: the newest run whose
 * OWN job-list fetch succeeded and whose conclusion is decisive
 * (`success`/`failure` — the same two conclusions `computeRedStreak` treats
 * as decisive; everything else, including `cancelled`, is inconclusive
 * there for the same reason it is here). GitHub Actions reports a cancelled
 * run's `status` as `"completed"` too, so without this a cancelled-latest-run
 * would read both lanes as "not executing" purely because cancelled jobs
 * read as skipped/cancelled, not because either lane actually stopped
 * running. A row whose `listJobsForRun` call failed is skipped the same
 * way: an API/setup failure must never be conflated with a real "not
 * executing" finding (see `main`'s own exit-code contract).
 *
 * @param {Array<{ run: { conclusion: string|null }, jobsFetchFailed: boolean }>} laneRows newest-first
 * @returns {object|null}
 */
export function findLatestExecutionRow(laneRows) {
  for (const row of laneRows ?? []) {
    if (row.jobsFetchFailed) continue;
    if (row.run.conclusion === "success" || row.run.conclusion === "failure") {
      return row;
    }
  }
  return null;
}

/**
 * Mirrors the staleness rule `ci-test-shard.mjs` already applies to the
 * timings snapshot (same constant, same "> budget" comparison), so this
 * report can never silently drift from the planner's own staleness policy.
 *
 * @param {{ capturedAt?: string }|null} snapshot
 * @param {Date} [now]
 * @returns {{ capturedAt: string|null, ageDays: number|null, stale: boolean, reason: string|null }}
 */
export function computeTimingsStaleness(snapshot, now = new Date()) {
  if (!snapshot || typeof snapshot.capturedAt !== "string") {
    return { capturedAt: null, ageDays: null, stale: true, reason: "missing-snapshot" };
  }
  const captured = new Date(snapshot.capturedAt);
  if (Number.isNaN(captured.getTime())) {
    return { capturedAt: snapshot.capturedAt, ageDays: null, stale: true, reason: "invalid-capturedAt" };
  }
  const ageDays = Math.floor((now.getTime() - captured.getTime()) / MS_PER_DAY);
  return {
    capturedAt: snapshot.capturedAt,
    ageDays,
    stale: ageDays > TIMINGS_STALENESS_DAYS,
    reason: null,
  };
}

/**
 * Find the matching `]` for the `[` at `openIndex`, skipping over string and
 * template literals and `//`/`/* *\/` comments so bracket characters inside
 * them (or inside a quoted path) never desynchronize the depth count.
 *
 * @param {string} source
 * @param {number} openIndex index of the opening "["
 * @returns {number|null} index of the matching "]", or null if unterminated
 */
function findMatchingBracket(source, openIndex) {
  let depth = 0;
  let i = openIndex;
  const n = source.length;
  while (i < n) {
    const ch = source[i];
    if (ch === "[") {
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === "]") {
      depth -= 1;
      i += 1;
      if (depth === 0) return i - 1;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      const end = source.indexOf("\n", i + 2);
      i = end === -1 ? n : end + 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i += 1;
      while (i < n && source[i] !== quote) {
        i += source[i] === "\\" ? 2 : 1;
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  return null;
}

/**
 * Walk backward from `index` over any unbroken run of trailing comments
 * (block or line, with only whitespace between them), so the text
 * immediately preceding an `exclude:` key — the codebase's other real
 * authoring pattern (see `engine-slow`'s array, where ONE comment above
 * `exclude: [` governs all six entries inside it) — is captured too, not
 * just comments physically inside the brackets.
 *
 * @param {string} source
 * @param {number} index
 * @returns {number}
 */
function extendBackwardOverComments(source, index) {
  let i = index;
  while (i > 0) {
    let j = i;
    while (j > 0 && /\s/.test(source[j - 1])) j -= 1;
    if (j === 0) return j;
    if (source[j - 1] === "/" && source[j - 2] === "*") {
      const start = source.lastIndexOf("/*", j - 3);
      if (start === -1) return j;
      i = start;
      continue;
    }
    const lineStart = source.lastIndexOf("\n", j - 1) + 1;
    const lineText = source.slice(lineStart, j);
    if (/^\s*\/\//.test(lineText)) {
      i = lineStart;
      continue;
    }
    return j;
  }
  return 0;
}

/**
 * Extract every `exclude: [ ... ]` array's raw text from a vitest config
 * source file, extended backward to include any comment(s) immediately
 * preceding the `exclude:` key itself.
 *
 * @param {string} source
 * @returns {string[]}
 */
export function findExcludeBlocks(source) {
  const blocks = [];
  const re = /exclude\s*:\s*\[/g;
  let match;
  while ((match = re.exec(source))) {
    const openIndex = match.index + match[0].length - 1;
    const closeIndex = findMatchingBracket(source, openIndex);
    if (closeIndex == null) break;
    const startIndex = extendBackwardOverComments(source, match.index);
    blocks.push(source.slice(startIndex, closeIndex + 1));
    re.lastIndex = closeIndex + 1;
  }
  return blocks;
}

/**
 * Split a block into an ordered stream of comment and quoted-string tokens
 * (everything else — brackets, commas, the bare `exclude`/`include` keys —
 * is structural noise for this purpose and is skipped).
 *
 * @param {string} text
 * @returns {Array<{ type: "comment"|"string", value: string }>}
 */
function tokenizeCommentsAndStrings(text) {
  const tokens = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      tokens.push({ type: "comment", value: text.slice(i, stop) });
      i = stop;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      const end = text.indexOf("\n", i + 2);
      const stop = end === -1 ? n : end;
      tokens.push({ type: "comment", value: text.slice(i, stop) });
      i = stop;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      let j = i + 1;
      while (j < n && text[j] !== quote) {
        j += text[j] === "\\" ? 2 : 1;
      }
      tokens.push({ type: "string", value: text.slice(i + 1, j) });
      i = j + 1;
      continue;
    }
    i += 1;
  }
  return tokens;
}

/**
 * Pair every quoted string in a block with the comment that "governs" it:
 * a comment (or an unbroken run of stacked comments) governs every string
 * that follows until the NEXT comment appears — not just the one string
 * physically adjacent to it. This matches how this codebase actually
 * writes quarantine comments both ways: one comment above several
 * consecutive quarantined paths (`engine-slow`'s six-file block), and one
 * comment immediately above a single path interleaved with unrelated
 * structural excludes (`engine-default`'s product-route relocation
 * comments). A string with no comment above it at all (governingComment
 * `null`) is never flagged, regardless of what other comments exist
 * elsewhere in the same array — this is what keeps orphaned/stale
 * "mirrored in ..." comments that precede zero real ledger-style file
 * paths from polluting unrelated structural entries later in the array.
 *
 * @param {string} block
 * @returns {Array<{ value: string, governingComment: string|null }>}
 */
function pairStringsWithGovernance(block) {
  const tokens = tokenizeCommentsAndStrings(block);
  const results = [];
  let group = null;
  let prevWasComment = false;
  for (const token of tokens) {
    if (token.type === "comment") {
      group = prevWasComment ? `${group}\n${token.value}` : token.value;
      prevWasComment = true;
    } else {
      results.push({ value: token.value, governingComment: group });
      prevWasComment = false;
    }
  }
  return results;
}

/**
 * The diagnosis's actual bug: an `exclude` entry whose governing comment
 * claims `Mirrored in scripts/lib/test-quarantine.json` while the ledger
 * holds no matching entry (six engine-slow files did exactly this after
 * the SQLite→PG cutover on 2026-07-13, and the ledger has been
 * `entries: []` since 2026-08-31). Report-only: never gates the exit code.
 *
 * @param {Array<{ name: string, prefix: string, text: string }>} sources
 * @param {Set<string>} ledgerFiles repo-relative paths from the quarantine ledger
 * @returns {Array<{ package: string, file: string }>}
 */
export function findUnmirroredExcludes(sources, ledgerFiles) {
  const results = [];
  const seen = new Set();
  for (const source of sources ?? []) {
    const blocks = findExcludeBlocks(source.text ?? "");
    for (const block of blocks) {
      for (const { value, governingComment } of pairStringsWithGovernance(block)) {
        if (!value.endsWith(".test.ts")) continue;
        if (!governingComment || !/mirrored in/i.test(governingComment)) continue;
        const repoRelative = `${source.prefix}/${value}`.replace(/\/+/g, "/");
        if (ledgerFiles.has(repoRelative) || ledgerFiles.has(value)) continue;
        const key = `${source.name}:${repoRelative}`;
        if (seen.has(key)) continue;
        seen.add(key);
        results.push({ package: source.name, file: repoRelative });
      }
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Local filesystem readers (not GitHub calls — these read the checked-out
// working tree the same way any other repo script does, so they need no
// injection seam beyond the ordinary `rootDir` parameter).
// ---------------------------------------------------------------------------

export function readTimingsSnapshot(rootDir) {
  const snapshotPath = path.join(rootDir, TIMINGS_SNAPSHOT_RELATIVE);
  if (!existsSync(snapshotPath)) return null;
  try {
    return JSON.parse(readFileSync(snapshotPath, "utf8"));
  } catch {
    return null;
  }
}

export function readLedgerFiles(rootDir) {
  const ledgerPath = path.join(rootDir, DEFAULT_QUARANTINE_PATH);
  if (!existsSync(ledgerPath)) return new Set();
  try {
    const json = JSON.parse(readFileSync(ledgerPath, "utf8"));
    const entries = Array.isArray(json?.entries) ? json.entries : [];
    return new Set(entries.map((entry) => entry?.file).filter((file) => typeof file === "string"));
  } catch {
    return new Set();
  }
}

export function readVitestConfigSources(rootDir) {
  const sources = [];
  for (const pkg of VITEST_CONFIG_PACKAGES) {
    const configPath = path.join(rootDir, pkg.configPath);
    if (!existsSync(configPath)) continue;
    sources.push({ name: pkg.name, prefix: pkg.prefix, text: readFileSync(configPath, "utf8") });
  }
  return sources;
}

// ---------------------------------------------------------------------------
// Report + issue rendering.
// ---------------------------------------------------------------------------

function formatRunRow(row) {
  const run = row.run;
  const unknown = run.status === "completed" && row.jobsFetchFailed;
  const engine = unknown
    ? "unknown (job fetch failed)"
    : run.status === "completed"
      ? (row.engineSlowExecuted ? "ran" : "DID NOT RUN")
      : "n/a";
  const darwin = unknown
    ? "unknown (job fetch failed)"
    : run.status === "completed"
      ? (row.darwinLaneExecuted ? "ran" : "DID NOT RUN")
      : "n/a";
  return `- ${run.createdAt ?? "unknown-date"}  run ${run.id}  ${run.conclusion ?? run.status}  engine-slow=${engine}  darwin-lane=${darwin}  ${run.url ?? ""}`;
}

export function renderReport({ laneRows, redStreak, timingsStaleness, unmirrored, now = new Date() }) {
  const lines = [
    "Full Suite (non-blocking) health report",
    `Generated ${now.toISOString()}`,
    `Red streak (consecutive failures, most recent first): ${redStreak} (alert threshold ${RED_STREAK_ALERT_THRESHOLD})`,
    "",
    `Last ${laneRows.length} completed run(s) on ${TARGET_BRANCH}:`,
    ...laneRows.map(formatRunRow),
    "",
    "Timings snapshot staleness:",
    `  capturedAt=${timingsStaleness.capturedAt ?? "missing"} ageDays=${timingsStaleness.ageDays ?? "n/a"} stale=${timingsStaleness.stale}${timingsStaleness.reason ? ` reason=${timingsStaleness.reason}` : ""}`,
    "",
    "Unmirrored quarantine excludes (claims 'Mirrored in scripts/lib/test-quarantine.json' with no matching ledger entry):",
  ];
  if (unmirrored.length === 0) {
    lines.push("  none found");
  } else {
    for (const entry of unmirrored) {
      lines.push(`  - ${entry.package}: ${entry.file}`);
    }
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

export function buildIssueTitle(alertReasons) {
  const state = alertReasons.length > 0 ? alertReasons.join("; ") : "unknown";
  return `Full Suite health: ${state}`;
}

export function buildIssueBody({ alertReasons, laneRows, redStreak, timingsStaleness, unmirrored, now = new Date() }) {
  const lines = [
    `_Auto-generated by \`scripts/full-suite-health.mjs\` via \`.github/workflows/full-suite-health.yml\` at ${now.toISOString()}. State is recomputed and this body is overwritten on every run — do not hand-edit._`,
    "",
    "## Alert reasons",
    ...alertReasons.map((reason) => `- ${reason}`),
    "",
    `## Red streak`,
    `${redStreak} consecutive failed run(s) on \`${TARGET_BRANCH}\` (alert threshold ${RED_STREAK_ALERT_THRESHOLD}).`,
    "",
    `## Recent runs (${TARGET_BRANCH}, newest first)`,
    ...laneRows.map(formatRunRow),
    "",
    "## Timings snapshot",
    `capturedAt=${timingsStaleness.capturedAt ?? "missing"}, ageDays=${timingsStaleness.ageDays ?? "n/a"}, stale=${timingsStaleness.stale}${timingsStaleness.reason ? `, reason=${timingsStaleness.reason}` : ""}`,
    "",
    "## Unmirrored quarantine excludes",
  ];
  if (unmirrored.length === 0) {
    lines.push("None found.");
  } else {
    for (const entry of unmirrored) {
      lines.push(`- \`${entry.package}\`: \`${entry.file}\``);
    }
  }
  lines.push(
    "",
    "See `docs/testing.md` (\"Red-streak clock\") for the owner/decision policy and `.archive/full-suite-red-diagnosis-20260911.md` for the investigation this heartbeat responds to.",
  );
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// GitHub client (the only network-touching surface; always injected in tests).
// ---------------------------------------------------------------------------

async function ghRequest(fetchImpl, token, method, urlPath, { body, allowStatuses = [] } = {}) {
  const res = await fetchImpl(`https://api.github.com${urlPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "ccc-fusion-full-suite-health",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok && !allowStatuses.includes(res.status)) {
    const text = await res.text().catch(() => "");
    throw new Error(`GitHub API ${method} ${urlPath} -> ${res.status} ${res.statusText}: ${text}`);
  }
  if (res.status === 204 || allowStatuses.includes(res.status)) return null;
  return res.json();
}

function normalizeRun(run) {
  return {
    id: run.id,
    status: run.status,
    conclusion: run.conclusion,
    createdAt: run.created_at,
    url: run.html_url,
    headSha: run.head_sha,
  };
}

function normalizeJob(job) {
  return {
    id: job.id,
    name: job.name,
    status: job.status,
    conclusion: job.conclusion,
    steps: (job.steps ?? []).map((step) => ({
      name: step.name,
      status: step.status,
      conclusion: step.conclusion,
    })),
  };
}

/**
 * @param {{ fetchImpl: typeof fetch, token: string, owner: string, repo: string }} options
 */
export function createGithubClient({ fetchImpl, token, owner, repo }) {
  const base = `/repos/${owner}/${repo}`;
  return {
    async listWorkflowRuns({ workflowFile, branch, perPage }) {
      const json = await ghRequest(
        fetchImpl,
        token,
        "GET",
        `${base}/actions/workflows/${workflowFile}/runs?branch=${encodeURIComponent(branch)}&per_page=${perPage}`,
      );
      return (json?.workflow_runs ?? []).map(normalizeRun);
    },
    async listJobsForRun(runId) {
      const json = await ghRequest(fetchImpl, token, "GET", `${base}/actions/runs/${runId}/jobs?per_page=100`);
      return (json?.jobs ?? []).map(normalizeJob);
    },
    async ensureLabel() {
      await ghRequest(fetchImpl, token, "POST", `${base}/labels`, {
        body: { name: HEALTH_LABEL, color: "b60205", description: "Full Suite (non-blocking) CI health signal" },
        allowStatuses: [422],
      });
    },
    async findHealthIssue() {
      const json = await ghRequest(
        fetchImpl,
        token,
        "GET",
        `${base}/issues?labels=${encodeURIComponent(HEALTH_LABEL)}&state=open&per_page=10`,
      );
      const issue = (json ?? []).find((candidate) => !candidate.pull_request);
      return issue ? { number: issue.number, title: issue.title, body: issue.body } : null;
    },
    async createIssue({ title, body }) {
      const json = await ghRequest(fetchImpl, token, "POST", `${base}/issues`, {
        body: { title, body, labels: [HEALTH_LABEL] },
      });
      return { number: json.number, url: json.html_url };
    },
    async updateIssue(number, { title, body }) {
      await ghRequest(fetchImpl, token, "PATCH", `${base}/issues/${number}`, { body: { title, body } });
    },
  };
}

// ---------------------------------------------------------------------------
// Orchestration.
// ---------------------------------------------------------------------------

/**
 * @param {object} [options]
 * @returns {Promise<number>} process exit code — 1 ONLY for a real red-streak
 *   or lane-execution alert condition; 0 when healthy; 2 for a setup/API
 *   failure that prevented the check from running at all (never conflated
 *   with the health finding itself).
 */
export async function main(options = {}) {
  const rootDir = options.rootDir ?? repoRoot;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const now = options.now ?? new Date();
  const runLimit = options.runLimit ?? RUN_HISTORY_LIMIT;

  const repoSlug = options.repoSlug ?? process.env.GITHUB_REPOSITORY ?? DEFAULT_REPO_SLUG;
  const [defaultOwner, defaultRepo] = repoSlug.split("/");
  const owner = options.owner ?? defaultOwner;
  const repo = options.repo ?? defaultRepo;

  let github = options.github;
  if (!github) {
    const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
    if (!token) {
      stderr.write("[full-suite-health] GITHUB_TOKEN (or GH_TOKEN) is required to query the GitHub API.\n");
      return 2;
    }
    github = createGithubClient({ fetchImpl: options.fetchImpl ?? fetch, token, owner, repo });
  }

  let runs;
  try {
    runs = await github.listWorkflowRuns({ workflowFile: WORKFLOW_FILE, branch: TARGET_BRANCH, perPage: runLimit });
  } catch (error) {
    stderr.write(`[full-suite-health] failed to list workflow runs: ${error.message}\n`);
    return 2;
  }

  const completedRuns = runs.filter((run) => run.status === "completed");
  const redStreak = computeRedStreak(completedRuns);

  const laneRows = [];
  const jobsByRun = [];
  for (const run of completedRuns) {
    let jobs = [];
    let jobsFetchFailed = false;
    try {
      jobs = await github.listJobsForRun(run.id);
    } catch (error) {
      jobsFetchFailed = true;
      stderr.write(`[full-suite-health] failed to list jobs for run ${run.id}: ${error.message}\n`);
    }
    jobsByRun.push(jobs);
    laneRows.push({ run, jobsFetchFailed, ...computeLaneExecution(jobs) });
  }
  const latestRow = findLatestExecutionRow(laneRows);
  const { jobNames: knownJobNames, stepNames: knownStepNames } = collectKnownNames(jobsByRun);
  const engineSlowLaneKnown = knownStepNames.has(ENGINE_SLOW_STEP_NAME);
  const darwinLaneKnown = knownJobNames.has(DARWIN_LANE_JOB_NAME);

  const timingsStaleness = computeTimingsStaleness(readTimingsSnapshot(rootDir), now);
  const ledgerFiles = readLedgerFiles(rootDir);
  const unmirrored = findUnmirroredExcludes(readVitestConfigSources(rootDir), ledgerFiles);

  stdout.write(renderReport({ laneRows, redStreak, timingsStaleness, unmirrored, now }));

  const alertReasons = [];
  if (redStreak >= RED_STREAK_ALERT_THRESHOLD) alertReasons.push(`red streak ${redStreak}`);
  // Gated on "has this job/step ever been observed in the lookback window at
  // all" so a lane that hasn't landed yet (Darwin, pre-PR-A) or was renamed
  // reads as "unknown, say nothing" rather than a guaranteed false alert.
  if (latestRow && engineSlowLaneKnown && !latestRow.engineSlowExecuted) alertReasons.push("engine-slow lane not executing");
  if (latestRow && darwinLaneKnown && !latestRow.darwinLaneExecuted) alertReasons.push("darwin lane not executing");

  if (alertReasons.length === 0) {
    stdout.write("[full-suite-health] healthy: no red-streak or lane-execution alert condition met.\n");
    return 0;
  }

  const title = buildIssueTitle(alertReasons);
  const body = buildIssueBody({ alertReasons, laneRows, redStreak, timingsStaleness, unmirrored, now });

  try {
    await github.ensureLabel();
    const existing = await github.findHealthIssue();
    if (existing) {
      await github.updateIssue(existing.number, { title, body });
      stdout.write(`[full-suite-health] updated issue #${existing.number}: ${title}\n`);
    } else {
      const created = await github.createIssue({ title, body });
      stdout.write(`[full-suite-health] opened issue #${created.number}: ${title}\n`);
    }
  } catch (error) {
    stderr.write(`[full-suite-health] failed to create/update the health issue: ${error.message}\n`);
    return 2;
  }

  return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then((code) => process.exit(code));
}
