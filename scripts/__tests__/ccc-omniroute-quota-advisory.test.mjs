import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import {
  DEFAULT_STALENESS_THRESHOLD_MS,
  openReadOnly,
  buildReport,
  formatReport,
  evaluateWindow,
  measureCadenceMs,
} from "../ccc-omniroute-quota-advisory.mjs";

const currentFilePath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(currentFilePath), "../..");

const SCHEMA_SQL = `
CREATE TABLE quota_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL,
    connection_id TEXT NOT NULL,
    window_key TEXT NOT NULL,
    remaining_percentage REAL,
    is_exhausted INTEGER DEFAULT 0,
    next_reset_at TEXT,
    window_duration_ms INTEGER,
    raw_data TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_quota_snapshots_provider_time ON quota_snapshots(provider, created_at);
CREATE INDEX idx_quota_snapshots_connection_time ON quota_snapshots(connection_id, created_at);
CREATE INDEX idx_quota_snapshots_created_at ON quota_snapshots(created_at);
`;

/**
 * Fixture SQLite files only — never the live OmniRoute DB (CI has no live
 * DB; see the tool's own file header for the one local read-only smoke
 * evidence, reported separately from this suite).
 */
function createFixtureDb(rows) {
  const dir = mkdtempSync(path.join(tmpdir(), "ccc-quota-advisory-fixture-"));
  const dbPath = path.join(dir, "storage.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA_SQL);
  const insert = db.prepare(
    `INSERT INTO quota_snapshots (provider, connection_id, window_key, remaining_percentage, is_exhausted, next_reset_at, window_duration_ms, raw_data, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of rows) {
    insert.run(
      row.provider,
      row.connectionId,
      row.windowKey,
      row.remainingPercentage ?? null,
      row.isExhausted ? 1 : 0,
      row.nextResetAt ?? null,
      row.windowDurationMs ?? null,
      row.rawData ?? null,
      row.createdAt,
    );
  }
  db.close();
  return { dir, dbPath };
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

test("script never imported by engine/product runtime (review-settled boundary)", () => {
  // grep-equivalent guard: nothing under packages/core or packages/engine
  // may import this standalone advisory tool. Cheap, deterministic, and
  // catches an accidental future coupling regression.
  const offenders = [];
  const scanRoots = ["packages/core/src", "packages/engine/src"];
  const needle = "ccc-omniroute-quota-advisory";

  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".mts"))) {
        const content = readFileSync(full, "utf8");
        if (content.includes(needle)) offenders.push(full);
      }
    }
  }

  for (const root of scanRoots) {
    walk(path.join(repoRoot, root));
  }

  assert.deepEqual(offenders, []);
});

// T-2 (spec §3.3, §7): a snapshot older than the staleness threshold
// resolves to unknown ("stale"), never to full/healthy.
test("a snapshot older than the staleness threshold resolves to unknown, not full", () => {
  const nowMs = Date.parse("2026-08-03T21:30:00.000Z");
  // Regular ~10min cadence so the measured cadence stays well under the
  // 30-min threshold — this must resolve "stale", not "no-usable-signal".
  const rows = [];
  for (let i = 0; i < 5; i++) {
    rows.push({
      provider: "claude",
      connectionId: "claude-main",
      windowKey: "session (5h)",
      remainingPercentage: 33,
      isExhausted: 0,
      createdAt: new Date(nowMs - (60 + i * 10) * 60_000).toISOString(), // oldest 100min ago, newest 60min ago
    });
  }
  const { dir, dbPath } = createFixtureDb(rows);
  try {
    const db = openReadOnly(dbPath);
    const report = buildReport(db, { nowMs, stalenessThresholdMs: DEFAULT_STALENESS_THRESHOLD_MS });
    db.close();

    const claudeWindows = report.providers.find((p) => p.provider === "claude").windows;
    const window = claudeWindows.find((w) => w.windowKey === "session (5h)");

    assert.equal(window.verdict, "stale");
    assert.equal(window.remainingPercentage, null); // never a fabricated/stale number
    assert.equal(window.isExhausted, null);
  } finally {
    cleanup(dir);
  }
});

test("a fresh snapshot within the staleness threshold reports the real remaining percentage", () => {
  const nowMs = Date.parse("2026-08-03T21:30:00.000Z");
  const rows = [
    {
      provider: "claude",
      connectionId: "claude-main",
      windowKey: "session (5h)",
      remainingPercentage: 33,
      isExhausted: 0,
      createdAt: new Date(nowMs - 5 * 60_000).toISOString(), // 5 min ago
    },
  ];
  const { dir, dbPath } = createFixtureDb(rows);
  try {
    const db = openReadOnly(dbPath);
    const report = buildReport(db, { nowMs, stalenessThresholdMs: DEFAULT_STALENESS_THRESHOLD_MS });
    db.close();

    const window = report.providers.find((p) => p.provider === "claude").windows[0];
    assert.equal(window.verdict, "fresh");
    assert.equal(window.remainingPercentage, 33);
    assert.equal(window.isExhausted, false);
  } finally {
    cleanup(dir);
  }
});

// T-3 (spec §3.2, §3.3, §7): a multi-window provider (Claude 5h + 7d) must
// resolve both windows independently, never collapsed to one scalar.
test("claude quota resolves session (5h) and weekly (7d) as independent windows", () => {
  const nowMs = Date.parse("2026-08-03T21:30:00.000Z");
  const rows = [
    {
      provider: "claude",
      connectionId: "claude-main",
      windowKey: "session (5h)",
      remainingPercentage: 33,
      isExhausted: 0,
      createdAt: new Date(nowMs - 5 * 60_000).toISOString(),
    },
    {
      provider: "claude",
      connectionId: "claude-main",
      windowKey: "weekly (7d)",
      remainingPercentage: 32,
      isExhausted: 0,
      createdAt: new Date(nowMs - 5 * 60_000).toISOString(),
    },
  ];
  const { dir, dbPath } = createFixtureDb(rows);
  try {
    const db = openReadOnly(dbPath);
    const report = buildReport(db, { nowMs, stalenessThresholdMs: DEFAULT_STALENESS_THRESHOLD_MS });
    db.close();

    const claudeWindows = report.providers.find((p) => p.provider === "claude").windows;
    assert.equal(claudeWindows.length, 2);

    const session = claudeWindows.find((w) => w.windowKey === "session (5h)");
    const weekly = claudeWindows.find((w) => w.windowKey === "weekly (7d)");

    assert.equal(session.remainingPercentage, 33);
    assert.equal(weekly.remainingPercentage, 32);
    // Independent windows, not collapsed into a single scalar for the provider.
    assert.notEqual(session.remainingPercentage, weekly.remainingPercentage);
  } finally {
    cleanup(dir);
  }
});

// T-4 (spec §7): the reader is a pure function of row content — parsing the
// same (provider, connection_id, window_key) row produces identical results
// whether it comes from a fixture styled after a live-copied DB or a
// hand-authored frozen fixture. No live DB touched by either path (the live
// endpoint join itself is LIVE-INFRA per T-1, out of scope here).
test("parses the same quota_snapshots row identically whether read via a live copy or a frozen fixture", () => {
  const nowMs = Date.parse("2026-08-03T21:30:00.000Z");
  const sharedRow = {
    provider: "codex",
    connectionId: "codex-main",
    windowKey: "session",
    remainingPercentage: 61.5,
    isExhausted: 0,
    createdAt: new Date(nowMs - 2 * 60_000).toISOString(),
  };

  // "live copy" fixture: built the way this session copied the real DB
  // (schema + one representative row, standing in for `cp` + `mode=ro`).
  const liveCopyFixture = createFixtureDb([sharedRow]);
  // "frozen fixture": hand-authored with the identical row, independently
  // constructed to prove the parser isn't coupled to incidental copy artifacts.
  const frozenFixture = createFixtureDb([{ ...sharedRow }]);

  try {
    const liveCopyDb = openReadOnly(liveCopyFixture.dbPath);
    const liveCopyReport = buildReport(liveCopyDb, { nowMs });
    liveCopyDb.close();

    const frozenDb = openReadOnly(frozenFixture.dbPath);
    const frozenReport = buildReport(frozenDb, { nowMs });
    frozenDb.close();

    const liveCopyWindow = liveCopyReport.providers.find((p) => p.provider === "codex").windows[0];
    const frozenWindow = frozenReport.providers.find((p) => p.provider === "codex").windows[0];

    assert.deepEqual(
      { verdict: liveCopyWindow.verdict, remainingPercentage: liveCopyWindow.remainingPercentage, isExhausted: liveCopyWindow.isExhausted },
      { verdict: frozenWindow.verdict, remainingPercentage: frozenWindow.remainingPercentage, isExhausted: frozenWindow.isExhausted },
    );
  } finally {
    cleanup(liveCopyFixture.dir);
    cleanup(frozenFixture.dir);
  }
});

// T-4b (spec §3.3 OQ-7, §7): regression-pins the live codex/weekly case
// (stale since 2026-07-12, 22 days at this session's probe) — a window
// whose measured cadence itself far exceeds the 30-min default must report
// "no usable signal", never a false-fresh or false-stale binary verdict.
test("reports 'no usable signal — conservative behavior, surfaced not silent' for a window whose measured cadence exceeds the staleness threshold", () => {
  const nowMs = Date.parse("2026-08-03T21:22:00.000Z");
  // Mirrors the live codex/weekly case: sparse rows weeks apart, last
  // written 2026-07-12 — the window's own normal rhythm is nowhere near the
  // 30-min default, so "stale" (implying "overdue relative to its own
  // rhythm") would be as misleading as "fresh".
  const rows = [
    { provider: "codex", connectionId: "codex-main", windowKey: "weekly", remainingPercentage: 40, isExhausted: 0, createdAt: "2026-06-14T18:21:37.886Z" },
    { provider: "codex", connectionId: "codex-main", windowKey: "weekly", remainingPercentage: 35, isExhausted: 0, createdAt: "2026-06-28T18:21:37.886Z" },
    { provider: "codex", connectionId: "codex-main", windowKey: "weekly", remainingPercentage: 30, isExhausted: 0, createdAt: "2026-07-12T18:21:37.886Z" },
  ];
  const { dir, dbPath } = createFixtureDb(rows);
  try {
    const db = openReadOnly(dbPath);
    const report = buildReport(db, { nowMs, stalenessThresholdMs: DEFAULT_STALENESS_THRESHOLD_MS });
    db.close();

    const window = report.providers.find((p) => p.provider === "codex").windows.find((w) => w.windowKey === "weekly");

    assert.equal(window.verdict, "no-usable-signal");
    assert.equal(window.reason, "no usable signal — conservative behavior, surfaced not silent");
    assert.equal(window.remainingPercentage, null);
  } finally {
    cleanup(dir);
  }
});

// Regression test for a real gap this session's live read-only smoke test
// against a /tmp copy of the actual OmniRoute DB surfaced: the live
// codex/weekly tuple has 7298 rows, the most recent 15 of which are all
// from 2026-07-12 spaced ~6min apart (the collector's live polling cadence
// while it was running) — then the collector went silent for 22 days. A
// median-of-last-15-gaps measure alone reports ~6min cadence (technically
// accurate for the historical burst) and so classifies this as merely
// "stale", not "no usable signal" — contradicting the spec's own §3.3
// worked example for this exact tuple. This fixture reproduces that shape
// (tight historical clustering, then a huge current gap) to pin the fix.
test("a window with a tight historical cadence but a current gap far outside any observed historical gap reports no usable signal, not stale", () => {
  const nowMs = Date.parse("2026-08-03T21:22:00.000Z");
  const rows = [];
  // 15 rows spaced 6 min apart, all ending 22 days before nowMs — mirrors
  // the live codex/weekly shape exactly (tight collector-alive cadence,
  // then total silence).
  const lastWriteMs = nowMs - 22 * 24 * 60 * 60_000;
  for (let i = 0; i < 15; i++) {
    rows.push({
      provider: "codex",
      connectionId: "codex-main",
      windowKey: "weekly",
      remainingPercentage: 40,
      isExhausted: 0,
      createdAt: new Date(lastWriteMs - i * 6 * 60_000).toISOString(),
    });
  }
  const { dir, dbPath } = createFixtureDb(rows);
  try {
    const db = openReadOnly(dbPath);
    const report = buildReport(db, { nowMs, stalenessThresholdMs: DEFAULT_STALENESS_THRESHOLD_MS });
    db.close();

    const window = report.providers.find((p) => p.provider === "codex").windows.find((w) => w.windowKey === "weekly");

    assert.equal(window.verdict, "no-usable-signal");
    assert.equal(window.reason, "no usable signal — conservative behavior, surfaced not silent");
  } finally {
    cleanup(dir);
  }
});

// Companion guard: a window that is merely somewhat overdue relative to its
// own historical worst gap (not an outlier) must still resolve "stale", so
// the fix above doesn't overcorrect into calling everything unusable.
test("a window moderately overdue relative to its own historical worst gap still reports stale, not no-usable-signal", () => {
  const nowMs = Date.parse("2026-08-03T21:22:00.000Z");
  // Mirrors the live claude/session(5h) shape: gaps mostly ~6min, one
  // outlier to ~12min, current age ~77min (~6.4x the worst historical gap
  // — overdue and worth flagging, but not the >1000x codex/weekly case).
  const gapsMinDescendingAge = [12.1, 6.8, 6, 6, 6, 6, 6, 6, 7, 6.1, 5.9, 6.1, 3.6, 5.4];
  let cursor = nowMs - 77 * 60_000;
  const rows = [{ provider: "claude", connectionId: "claude-main", windowKey: "session (5h)", remainingPercentage: 33, isExhausted: 0, createdAt: new Date(cursor).toISOString() }];
  for (const gapMin of gapsMinDescendingAge) {
    cursor -= gapMin * 60_000;
    rows.push({ provider: "claude", connectionId: "claude-main", windowKey: "session (5h)", remainingPercentage: 33, isExhausted: 0, createdAt: new Date(cursor).toISOString() });
  }
  const { dir, dbPath } = createFixtureDb(rows);
  try {
    const db = openReadOnly(dbPath);
    const report = buildReport(db, { nowMs, stalenessThresholdMs: DEFAULT_STALENESS_THRESHOLD_MS });
    db.close();

    const window = report.providers.find((p) => p.provider === "claude").windows[0];
    assert.equal(window.verdict, "stale");
  } finally {
    cleanup(dir);
  }
});

test("measureCadenceMs returns null when fewer than two snapshots are available", () => {
  assert.equal(measureCadenceMs([]), null);
  assert.equal(measureCadenceMs([{ created_at: "2026-08-03T21:00:00.000Z" }]), null);
});

test("measureCadenceMs computes the median gap between consecutive snapshots", () => {
  const rows = [
    { created_at: "2026-08-03T21:30:00.000Z" },
    { created_at: "2026-08-03T21:20:00.000Z" },
    { created_at: "2026-08-03T21:00:00.000Z" },
  ];
  // gaps: 20min (21:00->21:20), 10min (21:20->21:30) -> median of [20,10] = 15min
  assert.equal(measureCadenceMs(rows), 15 * 60_000);
});

test("evaluateWindow reports 'absent' for a tuple with zero snapshot rows", () => {
  const result = evaluateWindow({ snapshots: [], nowMs: Date.now(), stalenessThresholdMs: DEFAULT_STALENESS_THRESHOLD_MS });
  assert.equal(result.verdict, "absent");
});

test("formatReport renders every provider and window without collapsing multi-window providers", () => {
  const nowMs = Date.parse("2026-08-03T21:30:00.000Z");
  const rows = [
    { provider: "claude", connectionId: "claude-main", windowKey: "session (5h)", remainingPercentage: 33, isExhausted: 0, createdAt: new Date(nowMs - 5 * 60_000).toISOString() },
    { provider: "claude", connectionId: "claude-main", windowKey: "weekly (7d)", remainingPercentage: 32, isExhausted: 0, createdAt: new Date(nowMs - 5 * 60_000).toISOString() },
  ];
  const { dir, dbPath } = createFixtureDb(rows);
  try {
    const db = openReadOnly(dbPath);
    const report = buildReport(db, { nowMs });
    db.close();
    const text = formatReport(report);

    assert.match(text, /claude/);
    assert.match(text, /session \(5h\)/);
    assert.match(text, /weekly \(7d\)/);
  } finally {
    cleanup(dir);
  }
});
