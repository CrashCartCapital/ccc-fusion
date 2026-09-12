import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  DARWIN_LANE_JOB_NAME,
  ENGINE_SLOW_STEP_NAME,
  RED_STREAK_ALERT_THRESHOLD,
  buildIssueTitle,
  collectKnownNames,
  computeLaneExecution,
  computeRedStreak,
  computeTimingsStaleness,
  findLatestExecutionRow,
  findUnmirroredExcludes,
  jobExecuted,
  main,
  stepExecuted,
} from "../full-suite-health.mjs";

function captureStream() {
  let text = "";
  return {
    stream: { write(chunk) { text += chunk; } },
    get text() { return text; },
  };
}

function tempRoot() {
  return mkdtempSync(path.join(tmpdir(), "fusion-full-suite-health-"));
}

function writeLedger(rootDir, entries) {
  const ledgerPath = path.join(rootDir, "scripts/lib/test-quarantine.json");
  mkdirSync(path.dirname(ledgerPath), { recursive: true });
  writeFileSync(ledgerPath, `${JSON.stringify({ entries }, null, 2)}\n`, "utf8");
}

function writeTimings(rootDir, snapshot) {
  const timingsPath = path.join(rootDir, "scripts/test-timings.json");
  mkdirSync(path.dirname(timingsPath), { recursive: true });
  writeFileSync(timingsPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
}

// ---------------------------------------------------------------------------
// computeRedStreak
// ---------------------------------------------------------------------------

test("computeRedStreak counts consecutive failures from the newest run", () => {
  const runs = [
    { conclusion: "failure" },
    { conclusion: "failure" },
    { conclusion: "failure" },
    { conclusion: "success" },
    { conclusion: "failure" },
  ];
  assert.equal(computeRedStreak(runs), 3);
});

test("computeRedStreak treats cancelled runs as inconclusive, not streak-breaking", () => {
  const runs = [
    { conclusion: "failure" },
    { conclusion: "cancelled" },
    { conclusion: "failure" },
    { conclusion: "success" },
  ];
  assert.equal(computeRedStreak(runs), 2);
});

test("computeRedStreak returns 0 for an all-green history", () => {
  assert.equal(computeRedStreak([{ conclusion: "success" }, { conclusion: "success" }]), 0);
});

test("computeRedStreak returns the full length when every run is red", () => {
  const runs = Array.from({ length: 5 }, () => ({ conclusion: "failure" }));
  assert.equal(computeRedStreak(runs), 5);
});

test("computeRedStreak on an empty list is 0", () => {
  assert.equal(computeRedStreak([]), 0);
});

// ---------------------------------------------------------------------------
// stepExecuted / jobExecuted / computeLaneExecution
// ---------------------------------------------------------------------------

test("stepExecuted is true when the named step has a non-skipped conclusion", () => {
  const jobs = [{ name: "Product route + engine slow", steps: [{ name: ENGINE_SLOW_STEP_NAME, conclusion: "success" }] }];
  assert.equal(stepExecuted(jobs, ENGINE_SLOW_STEP_NAME), true);
});

test("stepExecuted is false when the named step was skipped", () => {
  const jobs = [{ name: "Product route + engine slow", steps: [{ name: ENGINE_SLOW_STEP_NAME, conclusion: "skipped" }] }];
  assert.equal(stepExecuted(jobs, ENGINE_SLOW_STEP_NAME), false);
});

test("stepExecuted is false when the step is not found in any job (renamed/removed)", () => {
  const jobs = [{ name: "Product route + engine slow", steps: [{ name: "Run serialized product-route acceptance", conclusion: "failure" }] }];
  assert.equal(stepExecuted(jobs, ENGINE_SLOW_STEP_NAME), false);
});

test("jobExecuted is true for a present, non-skipped job", () => {
  const jobs = [{ name: DARWIN_LANE_JOB_NAME, conclusion: "success" }];
  assert.equal(jobExecuted(jobs, DARWIN_LANE_JOB_NAME), true);
});

test("jobExecuted is false when the job does not exist in the run at all", () => {
  const jobs = [{ name: "test-shards", conclusion: "failure" }];
  assert.equal(jobExecuted(jobs, DARWIN_LANE_JOB_NAME), false);
});

test("jobExecuted is false when the job is present but skipped", () => {
  const jobs = [{ name: DARWIN_LANE_JOB_NAME, conclusion: "skipped" }];
  assert.equal(jobExecuted(jobs, DARWIN_LANE_JOB_NAME), false);
});

test("computeLaneExecution reports both lanes together", () => {
  const jobs = [
    { name: "Product route + engine slow", steps: [{ name: ENGINE_SLOW_STEP_NAME, conclusion: "success" }] },
    { name: DARWIN_LANE_JOB_NAME, conclusion: "skipped" },
  ];
  assert.deepEqual(computeLaneExecution(jobs), { engineSlowExecuted: true, darwinLaneExecuted: false });
});

// ---------------------------------------------------------------------------
// collectKnownNames
// ---------------------------------------------------------------------------

test("collectKnownNames collects job and step names seen anywhere across runs, regardless of conclusion", () => {
  const jobsByRun = [
    [{ name: "Product route + engine slow", steps: [{ name: ENGINE_SLOW_STEP_NAME, conclusion: "success" }] }],
    [{ name: DARWIN_LANE_JOB_NAME, conclusion: "skipped" }],
  ];
  const { jobNames, stepNames } = collectKnownNames(jobsByRun);
  assert.ok(jobNames.has(DARWIN_LANE_JOB_NAME));
  assert.ok(stepNames.has(ENGINE_SLOW_STEP_NAME));
});

test("collectKnownNames does not invent a name that never appeared in any fetched job list", () => {
  const jobsByRun = [[{ name: "test-shards", steps: [] }]];
  const { jobNames } = collectKnownNames(jobsByRun);
  assert.equal(jobNames.has(DARWIN_LANE_JOB_NAME), false);
});

test("collectKnownNames on no runs at all returns empty sets", () => {
  const { jobNames, stepNames } = collectKnownNames([]);
  assert.equal(jobNames.size, 0);
  assert.equal(stepNames.size, 0);
});

// ---------------------------------------------------------------------------
// findLatestExecutionRow
// ---------------------------------------------------------------------------

test("findLatestExecutionRow skips a cancelled latest run and falls back to the prior decisive run", () => {
  const rows = [
    { run: { id: 2, conclusion: "cancelled" }, jobsFetchFailed: false, engineSlowExecuted: false, darwinLaneExecuted: false },
    { run: { id: 1, conclusion: "success" }, jobsFetchFailed: false, engineSlowExecuted: true, darwinLaneExecuted: true },
  ];
  assert.equal(findLatestExecutionRow(rows), rows[1]);
});

test("findLatestExecutionRow skips a row whose job-list fetch failed", () => {
  const rows = [
    { run: { id: 2, conclusion: "failure" }, jobsFetchFailed: true, engineSlowExecuted: false, darwinLaneExecuted: false },
    { run: { id: 1, conclusion: "success" }, jobsFetchFailed: false, engineSlowExecuted: true, darwinLaneExecuted: true },
  ];
  assert.equal(findLatestExecutionRow(rows), rows[1]);
});

test("findLatestExecutionRow returns null when no row is decisive", () => {
  const rows = [{ run: { id: 1, conclusion: "cancelled" }, jobsFetchFailed: false }];
  assert.equal(findLatestExecutionRow(rows), null);
});

test("findLatestExecutionRow returns null on an empty list", () => {
  assert.equal(findLatestExecutionRow([]), null);
});

// ---------------------------------------------------------------------------
// computeTimingsStaleness
// ---------------------------------------------------------------------------

test("computeTimingsStaleness flags a snapshot older than the 30-day budget", () => {
  const now = new Date("2026-09-11T00:00:00.000Z");
  const result = computeTimingsStaleness({ capturedAt: "2026-06-01T00:00:00.000Z" }, now);
  assert.equal(result.stale, true);
  assert.ok(result.ageDays > 30);
});

test("computeTimingsStaleness accepts a fresh snapshot", () => {
  const now = new Date("2026-09-11T00:00:00.000Z");
  const result = computeTimingsStaleness({ capturedAt: "2026-09-01T00:00:00.000Z" }, now);
  assert.equal(result.stale, false);
  assert.equal(result.ageDays, 10);
});

test("computeTimingsStaleness treats a missing snapshot as stale", () => {
  const result = computeTimingsStaleness(null, new Date());
  assert.equal(result.stale, true);
  assert.equal(result.reason, "missing-snapshot");
});

test("computeTimingsStaleness treats an invalid capturedAt as stale", () => {
  const result = computeTimingsStaleness({ capturedAt: "not-a-date" }, new Date());
  assert.equal(result.stale, true);
  assert.equal(result.reason, "invalid-capturedAt");
});

// ---------------------------------------------------------------------------
// findUnmirroredExcludes
// ---------------------------------------------------------------------------

test("findUnmirroredExcludes flags a claimed-mirrored file absent from the ledger", () => {
  const source = {
    name: "@fusion/engine",
    prefix: "packages/engine",
    text: `
      exclude: [
        "node_modules/**",
        /*
        Quarantines this file. Mirrored in scripts/lib/test-quarantine.json.
        */
        "src/__tests__/orphaned.test.ts",
      ],
    `,
  };
  const result = findUnmirroredExcludes([source], new Set());
  assert.deepEqual(result, [{ package: "@fusion/engine", file: "packages/engine/src/__tests__/orphaned.test.ts" }]);
});

test("findUnmirroredExcludes does not flag a file the ledger actually has", () => {
  const source = {
    name: "@fusion/engine",
    prefix: "packages/engine",
    text: `
      exclude: [
        /* Mirrored in scripts/lib/test-quarantine.json. */
        "src/__tests__/tracked.test.ts",
      ],
    `,
  };
  const ledger = new Set(["packages/engine/src/__tests__/tracked.test.ts"]);
  assert.deepEqual(findUnmirroredExcludes([source], ledger), []);
});

test("findUnmirroredExcludes ignores excludes with no mirrored claim", () => {
  const source = {
    name: "@fusion/engine",
    prefix: "packages/engine",
    text: `
      exclude: [
        "src/__tests__/ccc-native-cli-public-route.real-pg.test.ts",
      ],
    `,
  };
  assert.deepEqual(findUnmirroredExcludes([source], new Set()), []);
});

test("findUnmirroredExcludes lets one preceding comment govern several consecutive entries (the real engine-slow six-file shape)", () => {
  const source = {
    name: "@fusion/engine",
    prefix: "packages/engine",
    text: `
      include: ["src/**/*.slow.test.ts"],
      /*
      Quarantines 6 engine-slow files. Mirrored in
      scripts/lib/test-quarantine.json.
      */
      exclude: [
        "src/__tests__/a.slow.test.ts",
        "src/__tests__/b.slow.test.ts",
        "src/__tests__/c.slow.test.ts",
      ],
    `,
  };
  const result = findUnmirroredExcludes([source], new Set());
  assert.deepEqual(result.map((r) => r.file).sort(), [
    "packages/engine/src/__tests__/a.slow.test.ts",
    "packages/engine/src/__tests__/b.slow.test.ts",
    "packages/engine/src/__tests__/c.slow.test.ts",
  ]);
});

test("findUnmirroredExcludes does not let a mirrored comment leak past an entry it already governed onto a later, differently-commented entry", () => {
  // Mirrors the real engine-default shape: an orphaned "mirrored" comment
  // governs only the non-test structural entry directly below it, and a
  // LATER, differently-commented real test file must not inherit that
  // stale claim just because it shares the same array.
  const source = {
    name: "@fusion/engine",
    prefix: "packages/engine",
    text: `
      exclude: [
        /*
        Old batch, fully rescued. Mirrored in scripts/lib/test-quarantine.json.
        */
        "node_modules/**",
        // Product-route acceptance owns disposable PostgreSQL; relocated below.
        "src/__tests__/ccc-native-cli-public-route.real-pg.test.ts",
      ],
    `,
  };
  assert.deepEqual(findUnmirroredExcludes([source], new Set()), []);
});

test("findUnmirroredExcludes is case-insensitive on the mirrored claim", () => {
  const source = {
    name: "@fusion/dashboard",
    prefix: "packages/dashboard",
    text: `
      exclude: [
        // Mirrored in scripts/lib/test-quarantine.json; will be DELETED when the SQLite code is removed.
        "src/__tests__/knowledge-index.test.ts",
      ],
    `,
  };
  const result = findUnmirroredExcludes([source], new Set());
  assert.deepEqual(result, [{ package: "@fusion/dashboard", file: "packages/dashboard/src/__tests__/knowledge-index.test.ts" }]);
});

// ---------------------------------------------------------------------------
// buildIssueTitle
// ---------------------------------------------------------------------------

test("buildIssueTitle joins multiple alert reasons into one state string", () => {
  assert.equal(
    buildIssueTitle(["red streak 5", "darwin lane not executing"]),
    "Full Suite health: red streak 5; darwin lane not executing",
  );
});

// ---------------------------------------------------------------------------
// main() end-to-end against a fake, injected GitHub client (no network).
// ---------------------------------------------------------------------------

function fakeGithub({ runs, jobsByRunId = {}, existingIssue = null }) {
  const calls = { createIssue: [], updateIssue: [], ensureLabel: 0, findHealthIssue: 0 };
  return {
    calls,
    async listWorkflowRuns() {
      return runs;
    },
    async listJobsForRun(runId) {
      return jobsByRunId[runId] ?? [];
    },
    async ensureLabel() {
      calls.ensureLabel += 1;
    },
    async findHealthIssue() {
      calls.findHealthIssue += 1;
      return existingIssue;
    },
    async createIssue({ title, body }) {
      calls.createIssue.push({ title, body });
      return { number: 101, url: "https://github.com/example/example/issues/101" };
    },
    async updateIssue(number, { title, body }) {
      calls.updateIssue.push({ number, title, body });
    },
  };
}

test("main() exits 0 and never touches issues when the tier is healthy", async () => {
  const rootDir = tempRoot();
  try {
    writeLedger(rootDir, []);
    writeTimings(rootDir, { capturedAt: new Date().toISOString() });
    const stdout = captureStream();
    const stderr = captureStream();
    const github = fakeGithub({
      runs: [
        { id: 1, status: "completed", conclusion: "success", createdAt: "2026-09-11T00:00:00Z", url: "u1" },
        { id: 2, status: "completed", conclusion: "success", createdAt: "2026-09-10T00:00:00Z", url: "u2" },
      ],
      jobsByRunId: {
        1: [
          { name: "Product route + engine slow", conclusion: "success", steps: [{ name: ENGINE_SLOW_STEP_NAME, conclusion: "success" }] },
          { name: DARWIN_LANE_JOB_NAME, conclusion: "success" },
        ],
      },
    });

    const code = await main({ rootDir, stdout: stdout.stream, stderr: stderr.stream, now: new Date(), github });

    assert.equal(code, 0);
    assert.equal(github.calls.createIssue.length, 0);
    assert.equal(github.calls.updateIssue.length, 0);
    assert.match(stdout.text, /healthy/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("main() exits 1 and opens a new issue on a red streak", async () => {
  const rootDir = tempRoot();
  try {
    writeLedger(rootDir, []);
    writeTimings(rootDir, { capturedAt: new Date().toISOString() });
    const stdout = captureStream();
    const stderr = captureStream();
    const failingRuns = Array.from({ length: RED_STREAK_ALERT_THRESHOLD }, (_, i) => ({
      id: i + 1,
      status: "completed",
      conclusion: "failure",
      createdAt: "2026-09-11T00:00:00Z",
      url: `u${i + 1}`,
    }));
    const github = fakeGithub({
      runs: failingRuns,
      jobsByRunId: Object.fromEntries(
        failingRuns.map((run) => [
          run.id,
          [
            { name: "Product route + engine slow", conclusion: "success", steps: [{ name: ENGINE_SLOW_STEP_NAME, conclusion: "success" }] },
            { name: DARWIN_LANE_JOB_NAME, conclusion: "success" },
          ],
        ]),
      ),
    });

    const code = await main({ rootDir, stdout: stdout.stream, stderr: stderr.stream, now: new Date(), github });

    assert.equal(code, 1);
    assert.equal(github.calls.createIssue.length, 1);
    assert.match(github.calls.createIssue[0].title, /red streak 3/);
    assert.equal(github.calls.updateIssue.length, 0);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("main() updates the existing labeled issue instead of creating a second one", async () => {
  const rootDir = tempRoot();
  try {
    writeLedger(rootDir, []);
    writeTimings(rootDir, { capturedAt: new Date().toISOString() });
    const stdout = captureStream();
    const stderr = captureStream();
    const failingRuns = Array.from({ length: RED_STREAK_ALERT_THRESHOLD }, (_, i) => ({
      id: i + 1,
      status: "completed",
      conclusion: "failure",
      createdAt: "2026-09-11T00:00:00Z",
      url: `u${i + 1}`,
    }));
    const github = fakeGithub({
      runs: failingRuns,
      jobsByRunId: {},
      existingIssue: { number: 42, title: "Full Suite health: red streak 2", body: "stale" },
    });

    const code = await main({ rootDir, stdout: stdout.stream, stderr: stderr.stream, now: new Date(), github });

    assert.equal(code, 1);
    assert.equal(github.calls.createIssue.length, 0);
    assert.equal(github.calls.updateIssue.length, 1);
    assert.equal(github.calls.updateIssue[0].number, 42);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("main() alerts when the darwin lane job is present but did not execute on the latest run, even with no red streak", async () => {
  const rootDir = tempRoot();
  try {
    writeLedger(rootDir, []);
    writeTimings(rootDir, { capturedAt: new Date().toISOString() });
    const stdout = captureStream();
    const stderr = captureStream();
    const github = fakeGithub({
      runs: [{ id: 1, status: "completed", conclusion: "success", createdAt: "2026-09-11T00:00:00Z", url: "u1" }],
      jobsByRunId: {
        1: [
          { name: "Product route + engine slow", conclusion: "success", steps: [{ name: ENGINE_SLOW_STEP_NAME, conclusion: "success" }] },
          // Present (so the lane is "known" to exist) but skipped, not executed.
          { name: DARWIN_LANE_JOB_NAME, conclusion: "skipped" },
        ],
      },
    });

    const code = await main({ rootDir, stdout: stdout.stream, stderr: stderr.stream, now: new Date(), github });

    assert.equal(code, 1);
    assert.equal(github.calls.createIssue.length, 1);
    assert.match(github.calls.createIssue[0].title, /darwin lane not executing/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("main() does not alert on the darwin lane when its job has never appeared in the run-history window (not yet landed)", async () => {
  const rootDir = tempRoot();
  try {
    writeLedger(rootDir, []);
    writeTimings(rootDir, { capturedAt: new Date().toISOString() });
    const stdout = captureStream();
    const stderr = captureStream();
    const github = fakeGithub({
      runs: [{ id: 1, status: "completed", conclusion: "success", createdAt: "2026-09-11T00:00:00Z", url: "u1" }],
      jobsByRunId: {
        // The Darwin lane job name never appears anywhere in the fetched
        // jobs -- this is the pre-PR-A state on main today. It must read as
        // "unknown, not yet landed", never as a false "not executing" alert.
        1: [{ name: "Product route + engine slow", conclusion: "success", steps: [{ name: ENGINE_SLOW_STEP_NAME, conclusion: "success" }] }],
      },
    });

    const code = await main({ rootDir, stdout: stdout.stream, stderr: stderr.stream, now: new Date(), github });

    assert.equal(code, 0);
    assert.equal(github.calls.createIssue.length, 0);
    assert.equal(github.calls.updateIssue.length, 0);
    assert.match(stdout.text, /healthy/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("main() does not false-alert when the newest completed run was cancelled -- it evaluates lane execution against the prior real run", async () => {
  const rootDir = tempRoot();
  try {
    writeLedger(rootDir, []);
    writeTimings(rootDir, { capturedAt: new Date().toISOString() });
    const stdout = captureStream();
    const stderr = captureStream();
    const github = fakeGithub({
      runs: [
        { id: 2, status: "completed", conclusion: "cancelled", createdAt: "2026-09-11T00:00:00Z", url: "u2" },
        { id: 1, status: "completed", conclusion: "success", createdAt: "2026-09-10T00:00:00Z", url: "u1" },
      ],
      jobsByRunId: {
        // Cancelled run: both lanes read as skipped/cancelled purely because
        // the run was cancelled, not because either lane stopped executing.
        2: [
          { name: "Product route + engine slow", conclusion: "cancelled", steps: [{ name: ENGINE_SLOW_STEP_NAME, conclusion: "cancelled" }] },
          { name: DARWIN_LANE_JOB_NAME, conclusion: "cancelled" },
        ],
        1: [
          { name: "Product route + engine slow", conclusion: "success", steps: [{ name: ENGINE_SLOW_STEP_NAME, conclusion: "success" }] },
          { name: DARWIN_LANE_JOB_NAME, conclusion: "success" },
        ],
      },
    });

    const code = await main({ rootDir, stdout: stdout.stream, stderr: stderr.stream, now: new Date(), github });

    assert.equal(code, 0);
    assert.equal(github.calls.createIssue.length, 0);
    assert.match(stdout.text, /healthy/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("main() does not false-alert when the newest run's job-list fetch fails -- it falls back to the prior successfully-fetched run", async () => {
  const rootDir = tempRoot();
  try {
    writeLedger(rootDir, []);
    writeTimings(rootDir, { capturedAt: new Date().toISOString() });
    const stdout = captureStream();
    const stderr = captureStream();
    const runs = [
      { id: 2, status: "completed", conclusion: "failure", createdAt: "2026-09-11T00:00:00Z", url: "u2" },
      { id: 1, status: "completed", conclusion: "success", createdAt: "2026-09-10T00:00:00Z", url: "u1" },
    ];
    const github = {
      calls: { createIssue: [], updateIssue: [] },
      async listWorkflowRuns() {
        return runs;
      },
      async listJobsForRun(runId) {
        if (runId === 2) throw new Error("simulated GitHub API 502");
        return [
          { name: "Product route + engine slow", conclusion: "success", steps: [{ name: ENGINE_SLOW_STEP_NAME, conclusion: "success" }] },
          { name: DARWIN_LANE_JOB_NAME, conclusion: "success" },
        ];
      },
      async ensureLabel() {},
      async findHealthIssue() {
        return null;
      },
      async createIssue(args) {
        this.calls.createIssue.push(args);
        return { number: 101, url: "https://github.com/example/example/issues/101" };
      },
      async updateIssue(number, args) {
        this.calls.updateIssue.push({ number, ...args });
      },
    };

    const code = await main({ rootDir, stdout: stdout.stream, stderr: stderr.stream, now: new Date(), github });

    assert.equal(code, 0);
    assert.equal(github.calls.createIssue.length, 0);
    assert.match(stderr.text, /failed to list jobs for run 2/);
    assert.match(stdout.text, /healthy/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("main() returns 2 (not 1) when no GITHUB_TOKEN is available and no client was injected", async () => {
  const rootDir = tempRoot();
  const previousToken = process.env.GITHUB_TOKEN;
  const previousGhToken = process.env.GH_TOKEN;
  try {
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    const stdout = captureStream();
    const stderr = captureStream();
    const code = await main({ rootDir, stdout: stdout.stream, stderr: stderr.stream });
    assert.equal(code, 2);
    assert.match(stderr.text, /GITHUB_TOKEN/);
  } finally {
    if (previousToken !== undefined) process.env.GITHUB_TOKEN = previousToken;
    if (previousGhToken !== undefined) process.env.GH_TOKEN = previousGhToken;
    rmSync(rootDir, { recursive: true, force: true });
  }
});
