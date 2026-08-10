#!/usr/bin/env node
/**
 * ccc-omniroute-quota-advisory — standalone pre-flight advisory tool.
 *
 * Reads OmniRoute's `quota_snapshots` table (spec 2026-08-03
 * docs/plans/2026-08-03-ccc-fusion-phase3-routing-implementation-spec.md
 * §3.4, settled OQ-2) and reports, per (provider, connection_id,
 * window_key), whether the freshest snapshot is usable — never
 * fabricating a "100% remaining" default the way `/api/usage/quota`
 * currently does (report §4.1-§4.3).
 *
 * Consulted before launching a run. NOT engine/product runtime: nothing
 * under packages/core or packages/engine may import this file (spec §3.4
 * — "product (engine/runtime) code never reads OmniRoute's private DB").
 * Enforced by a repo-scan test in scripts/__tests__/ccc-omniroute-quota-advisory.test.mjs.
 *
 * Always opens the DB with node:sqlite's `readOnly: true` (verified to
 * reject writes and to fail closed on a missing file — see this repo's
 * fusion-modification-report.txt / session evidence for the self-test).
 * Never the live file with a write handle, regardless of which path is
 * passed in.
 */

import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Real default OmniRoute storage path (spec §3.2, this session's live
 * pin). Documented for operator convenience; always opened `readOnly` per
 * openReadOnly below regardless of whether this default or an explicit
 * `--db` path is used, so pointing this at the live file can never write
 * to it.
 */
export const DEFAULT_OMNIROUTE_DB_PATH = path.join(homedir(), ".omniroute-devstack", "data", "storage.sqlite");

/** Settled default (spec §3.3 OQ-7) — self-corrects via measured cadence, never silently. */
export const DEFAULT_STALENESS_THRESHOLD_MS = 30 * 60 * 1000;

/** Matches this session's own sampling methodology (spec §3.3: "last 15 ... snapshots"). */
export const CADENCE_SAMPLE_SIZE = 15;

/**
 * How many multiples of a window's own worst observed historical gap the
 * current gap must exceed before "stale" (implying "temporarily behind its
 * own normal rhythm") becomes misleading and "no-usable-signal" is the
 * honest verdict instead.
 *
 * FNXC:Phase3RoutingSlice1QuotaAdvisory 2026-08-03:
 * Calibrated against this session's one live read-only smoke run (real
 * OmniRoute quota_snapshots, copied to /tmp): a collector that has gone
 * fully silent (live example: codex/weekly, last written 2026-07-12,
 * ~5300x its own ~6min historical cadence at probe time) must not be
 * reported as merely "stale" — that implies "running a bit behind,
 * expected back soon", which is false when the gap dwarfs anything the
 * window has ever shown. 10x sits comfortably above the largest
 * legitimately-just-overdue ratio observed live (claude/session(5h) at
 * ~6.4x its own worst gap) and far below the pathological case, so a
 * genuinely-behind-but-still-plausible window doesn't get flagged as
 * unusable.
 */
export const NO_SIGNAL_GAP_MULTIPLIER = 10;

/**
 * Open a `quota_snapshots` DB read-only. This is the single choke point
 * every reader in this file goes through — R-F9's chosen mechanism is
 * `node:sqlite` (Node >=22.5 experimental / stable on the CI-pinned Node
 * "24", see .github/actions/setup-node-pnpm/action.yml and this repo's
 * local Node 24.16.0 — verified with no experimental flag needed), not a
 * new dependency or a `sqlite3` CLI shellout.
 */
export function openReadOnly(dbPath) {
  return new DatabaseSync(dbPath, { readOnly: true });
}

function median(numbers) {
  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Every distinct (provider, connection_id, window_key) tuple in the table. */
export function listTuples(db) {
  return db
    .prepare(`SELECT DISTINCT provider, connection_id, window_key FROM quota_snapshots ORDER BY provider, connection_id, window_key`)
    .all();
}

/**
 * The most recent `limit` snapshots for one tuple, newest first. Bounded
 * (default CADENCE_SAMPLE_SIZE) rather than scanning the whole table —
 * this table is 97k+ rows on the live DB (spec §3.2) and only recent
 * history is needed to measure cadence.
 */
export function loadRecentSnapshots(db, provider, connectionId, windowKey, limit = CADENCE_SAMPLE_SIZE) {
  return db
    .prepare(
      `SELECT remaining_percentage, is_exhausted, next_reset_at, created_at
       FROM quota_snapshots
       WHERE provider = ? AND connection_id = ? AND window_key = ?
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(provider, connectionId, windowKey, limit);
}

/** Order-independent (sorts internally) gaps between consecutive `created_at` timestamps. */
function computeGapsMs(snapshots) {
  if (snapshots.length < 2) return [];
  const timestamps = snapshots.map((row) => Date.parse(row.created_at)).sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < timestamps.length; i++) gaps.push(timestamps[i] - timestamps[i - 1]);
  return gaps;
}

/**
 * Median gap between consecutive `created_at` timestamps, or null when
 * fewer than two snapshots exist to measure a gap from.
 */
export function measureCadenceMs(snapshots) {
  const gaps = computeGapsMs(snapshots);
  return gaps.length === 0 ? null : median(gaps);
}

/**
 * The single worst (largest) gap observed among the sampled snapshots, or
 * null when fewer than two exist. A collector that's been reliably tight
 * (e.g. every ~6min) but has now gone silent far beyond even its own worst
 * historical gap is a different failure than a window whose normal rhythm
 * is simply slower than the staleness threshold — see NO_SIGNAL_GAP_MULTIPLIER.
 */
export function measureMaxObservedGapMs(snapshots) {
  const gaps = computeGapsMs(snapshots);
  return gaps.length === 0 ? null : Math.max(...gaps);
}

/**
 * Resolve one (provider, connection_id, window_key) tuple's snapshots into
 * a verdict. `snapshots` must be newest-first (as returned by
 * loadRecentSnapshots). Three verdicts, spec §3.3:
 *
 *  - "fresh": within stalenessThresholdMs of now — real values returned.
 *  - "stale": past the threshold, but this window's own measured cadence
 *    is faster than the threshold, so "overdue" is a meaningful signal.
 *    Degrades to unknown (never a fabricated 100/healthy) per E3-style
 *    discipline.
 *  - "no-usable-signal": past the threshold AND the measured cadence
 *    itself exceeds it (or can't be measured) — the 30-minute assumption
 *    never applied to this window (e.g. codex/weekly, spec §3.3's
 *    22-days-stale live example). Surfaced explicitly rather than
 *    reported as either a false-fresh or a misleading "overdue" stale.
 */
export function evaluateWindow({ snapshots, nowMs, stalenessThresholdMs = DEFAULT_STALENESS_THRESHOLD_MS }) {
  if (snapshots.length === 0) {
    return {
      verdict: "absent",
      reason: "no snapshot rows for this (provider, connection_id, window_key)",
      remainingPercentage: null,
      isExhausted: null,
      ageMs: null,
      measuredCadenceMs: null,
      maxObservedGapMs: null,
    };
  }

  const latest = snapshots[0];
  const ageMs = nowMs - Date.parse(latest.created_at);
  const measuredCadenceMs = measureCadenceMs(snapshots);
  const maxObservedGapMs = measureMaxObservedGapMs(snapshots);

  if (ageMs <= stalenessThresholdMs) {
    return {
      verdict: "fresh",
      reason: null,
      remainingPercentage: latest.remaining_percentage,
      isExhausted: Boolean(latest.is_exhausted),
      ageMs,
      measuredCadenceMs,
      maxObservedGapMs,
    };
  }

  // Two independent reasons the 30-minute default can be meaningless here:
  // (a) this window's own normal rhythm is slower than the assumption
  //     (measuredCadenceMs, or unmeasurable with <2 samples), or
  // (b) the collector has gone silent far beyond even its own worst
  //     historical gap — a tight historical cadence does not make "stale"
  //     (implying "temporarily behind") an honest description of a gap
  //     10x+ anything this window has ever shown.
  const cadenceExceedsThreshold = measuredCadenceMs === null || measuredCadenceMs > stalenessThresholdMs;
  const ageIsHistoricalOutlier = maxObservedGapMs !== null && ageMs > maxObservedGapMs * NO_SIGNAL_GAP_MULTIPLIER;

  if (cadenceExceedsThreshold || ageIsHistoricalOutlier) {
    return {
      verdict: "no-usable-signal",
      reason: "no usable signal — conservative behavior, surfaced not silent",
      remainingPercentage: null,
      isExhausted: null,
      ageMs,
      measuredCadenceMs,
      maxObservedGapMs,
    };
  }

  return {
    verdict: "stale",
    reason: `snapshot age ${Math.round(ageMs / 60_000)}min exceeds the ${Math.round(stalenessThresholdMs / 60_000)}min staleness threshold`,
    remainingPercentage: null,
    isExhausted: null,
    ageMs,
    measuredCadenceMs,
    maxObservedGapMs,
  };
}

/**
 * Build the full advisory report: every tracked tuple, grouped by
 * provider, each window resolved independently (spec §3.3 "multi-window
 * awareness" — never collapsed to one scalar per provider).
 */
export function buildReport(db, { nowMs = Date.now(), stalenessThresholdMs = DEFAULT_STALENESS_THRESHOLD_MS } = {}) {
  const tuples = listTuples(db);
  const windows = tuples.map(({ provider, connection_id: connectionId, window_key: windowKey }) => {
    const snapshots = loadRecentSnapshots(db, provider, connectionId, windowKey);
    const evaluation = evaluateWindow({ snapshots, nowMs, stalenessThresholdMs });
    return { provider, connectionId, windowKey, ...evaluation };
  });

  const byProvider = new Map();
  for (const w of windows) {
    if (!byProvider.has(w.provider)) byProvider.set(w.provider, []);
    byProvider.get(w.provider).push(w);
  }

  return {
    generatedAtMs: nowMs,
    stalenessThresholdMs,
    providers: [...byProvider.entries()].map(([provider, providerWindows]) => ({ provider, windows: providerWindows })),
  };
}

/** Human/orchestrator-readable text rendering of a report from buildReport(). */
export function formatReport(report) {
  const lines = [];
  lines.push(`OmniRoute quota advisory — generated ${new Date(report.generatedAtMs).toISOString()}`);
  lines.push(
    `Staleness threshold: ${Math.round(report.stalenessThresholdMs / 60_000)}min default ` +
      `(measured per-window cadence overrides when the default would be meaningless — see "no-usable-signal" rows)`,
  );
  lines.push("");

  if (report.providers.length === 0) {
    lines.push("(no quota_snapshots rows found)");
    return lines.join("\n");
  }

  for (const { provider, windows } of report.providers) {
    lines.push(`${provider}:`);
    for (const w of windows) {
      const age = w.ageMs === null ? "n/a" : `${Math.round(w.ageMs / 60_000)}min old`;
      const cadence = w.measuredCadenceMs === null ? "cadence unmeasurable" : `measured cadence ~${Math.round(w.measuredCadenceMs / 60_000)}min`;
      if (w.verdict === "fresh") {
        lines.push(`  [${w.connectionId} / ${w.windowKey}] FRESH remaining=${w.remainingPercentage}% exhausted=${w.isExhausted} (${age}, ${cadence})`);
      } else {
        lines.push(`  [${w.connectionId} / ${w.windowKey}] ${w.verdict.toUpperCase()} — ${w.reason} (${age}, ${cadence})`);
      }
    }
  }
  return lines.join("\n");
}

function parseArgs(argv) {
  const args = { db: DEFAULT_OMNIROUTE_DB_PATH, json: false, stalenessThresholdMs: DEFAULT_STALENESS_THRESHOLD_MS };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--db") {
      args.db = argv[++i];
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg === "--staleness-threshold-ms") {
      args.stalenessThresholdMs = Number(argv[++i]);
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    }
  }
  // Expand a leading ~ the way a shell would — Node does not do this itself.
  if (args.db.startsWith("~")) {
    args.db = path.join(homedir(), args.db.slice(1));
  }
  return args;
}

function printUsage() {
  console.log(`Usage: node scripts/ccc-omniroute-quota-advisory.mjs [--db <path>] [--json] [--staleness-threshold-ms <ms>]

  --db <path>                   Path to a quota_snapshots SQLite DB, opened read-only.
                                 Defaults to ${DEFAULT_OMNIROUTE_DB_PATH}
                                 (documented real OmniRoute path — spec §3.2). Pass a
                                 /tmp copy for an extra safety margin; the connection
                                 itself is always opened read-only regardless.
  --json                        Emit the machine-readable report instead of text.
  --staleness-threshold-ms <ms> Override the 30-minute default staleness threshold.

Pre-flight advisory only — never imported by engine/product runtime, never a
build/CI gate. Consult before launching a run that depends on provider headroom.`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  if (!existsSync(args.db)) {
    console.error(`[ccc-omniroute-quota-advisory] no such file: ${args.db}`);
    console.error(`Pass --db <path> to a quota_snapshots SQLite DB (default: ${DEFAULT_OMNIROUTE_DB_PATH}).`);
    process.exitCode = 1;
    return;
  }

  const db = openReadOnly(args.db);
  try {
    const report = buildReport(db, { stalenessThresholdMs: args.stalenessThresholdMs });
    console.log(args.json ? JSON.stringify(report, null, 2) : formatReport(report));
  } finally {
    db.close();
  }
}

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMainModule) {
  main().catch((error) => {
    console.error("[ccc-omniroute-quota-advisory] fatal:", error);
    process.exitCode = 1;
  });
}
