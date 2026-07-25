#!/usr/bin/env node
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { setImmediate } from "node:timers";
import assert from "node:assert/strict";

const stopPolicySelfTest = process.argv.length === 3 && process.argv[2] === "--self-test-stop-settlement";
const runnerPolicySelfTest = process.argv.length === 3 && process.argv[2] === "--self-test-policies";
const selectedWave = process.argv.length === 4 && process.argv[2] === "--wave"
  ? Number(process.argv[3])
  : null;
if (!stopPolicySelfTest && !runnerPolicySelfTest && selectedWave !== 4 && selectedWave !== 5) {
  throw new Error("usage: node scripts/run-ccc-pg-proof.mjs --wave <4|5>");
}
if (!stopPolicySelfTest && !runnerPolicySelfTest && process.env.FUSION_PG_TEST_SKIP === "1") {
  throw new Error(`FUSION_PG_TEST_SKIP=1 disables the required Wave ${selectedWave} PostgreSQL proof before test execution`);
}

function stopWithinBudgetPolicy(lifecycle, stopTimeoutMs) {
  return new Promise((resolve, reject) => {
    let timeoutLatched = false;
    let settled = false;
    const finish = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); fn(value); };
    const stopPromise = Promise.resolve().then(() => lifecycle.stop());
    const timer = setTimeout(() => {
      timeoutLatched = true;
      const timeout = new Error("embedded PostgreSQL stop timed out");
      // FNXC:CccWave4Proof 2026-07-24-18:05: timeout is terminal at expiry.
      // Settle both owned shutdown paths before reporting so neither late
      // failure can be lost or become an unhandled rejection.
      const forcedCleanupPromise = Promise.resolve().then(() => lifecycle.terminateOwnedPostmaster());
      void Promise.allSettled([stopPromise, forcedCleanupPromise]).then(([stopResult, forcedResult]) => {
        const errors = [
          timeout,
          ...(stopResult.status === "rejected" ? [stopResult.reason] : []),
          ...(forcedResult.status === "rejected" ? [forcedResult.reason] : []),
        ];
        finish(reject, new AggregateError(errors, "embedded PostgreSQL stop timed out and shutdown settlement failed"));
      });
    }, stopTimeoutMs);
    stopPromise.then(
      () => { if (!timeoutLatched) finish(resolve); },
      (error) => { if (!timeoutLatched) finish(reject, error); },
    );
  });
}

function stopFailureText(error) {
  const errors = error instanceof AggregateError ? error.errors : [error];
  return errors.map((entry) => String(entry instanceof Error ? entry.message : entry)
    .replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, "[redacted-postgresql-url]")
    .replace(/password=[^\s&]+/gi, "password=[redacted]")).join(" | ");
}

function deferred() {
  let resolve;
  let reject;
  return { promise: new Promise((onResolve, onReject) => { resolve = onResolve; reject = onReject; }), resolve, reject };
}

async function nextTurn() {
  await new Promise((resolve) => setImmediate(resolve));
}

async function selfTestStopSettlementPolicy() {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
  const stop = deferred();
  const forced = deferred();
  let forcedCalls = 0;
  const outcome = stopWithinBudgetPolicy({
    stop: () => stop.promise,
    terminateOwnedPostmaster: () => { forcedCalls += 1; return forced.promise; },
  }, 1).then(
    () => ({ status: "resolved" }),
    (error) => ({ status: "rejected", error }),
  );
  while (forcedCalls === 0) await nextTurn();
  forced.reject(new Error(`forced cleanup password=${"unsafe"}`));
  await nextTurn();
  const lateStopError = new Error(`late stop postgresql:${"//"}unsafe:unsafe@loopback/proof`);
  stop.reject(lateStopError);
  const terminal = await outcome;
  assert.equal(terminal.status, "rejected");
  assert.ok(terminal.error instanceof AggregateError);
  assert.equal(terminal.error.errors.length, 3, "timeout must preserve both stop and forced-cleanup failures");
  const diagnostic = stopFailureText(terminal.error);
  assert.match(diagnostic, /embedded PostgreSQL stop timed out/);
  assert.match(diagnostic, /late stop \[redacted-postgresql-url\]/);
  assert.match(diagnostic, /forced cleanup password=\[redacted\]/);
  assert.doesNotMatch(diagnostic, /unsafe/);

  const lateSuccessStop = deferred();
  const lateSuccessForced = deferred();
  let lateSuccessForcedCalls = 0;
  let settledBeforeStop = false;
  const lateSuccessOutcome = stopWithinBudgetPolicy({
    stop: () => lateSuccessStop.promise,
    terminateOwnedPostmaster: () => { lateSuccessForcedCalls += 1; return lateSuccessForced.promise; },
  }, 1).then(
    () => ({ status: "resolved" }),
    (error) => ({ status: "rejected", error }),
  ).then((result) => { settledBeforeStop = true; return result; });
  while (lateSuccessForcedCalls === 0) await nextTurn();
  lateSuccessForced.resolve();
  await nextTurn();
  assert.equal(settledBeforeStop, false, "timeout must await the original stop even when forced cleanup succeeds");
  lateSuccessStop.resolve();
  assert.equal((await lateSuccessOutcome).status, "rejected", "a late successful stop cannot turn timeout into success");

  let preTimeoutForcedCalls = 0;
  await stopWithinBudgetPolicy({
    stop: async () => undefined,
    terminateOwnedPostmaster: async () => { preTimeoutForcedCalls += 1; },
  }, 10);
  assert.equal(preTimeoutForcedCalls, 0, "a successful pre-timeout stop must not force cleanup");
  await nextTurn();
  assert.deepEqual(unhandled, [], "shutdown settlement must not emit unhandled rejections");
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
  }
}

if (stopPolicySelfTest) {
  await selfTestStopSettlementPolicy();
  console.log("CCC proof-runner stop-settlement policy self-test passed");
  process.exit(0);
}

const expectedCoreGateNames = [
  "VAL-CROSS-001: End-to-end task lifecycle (PostgreSQL) > creates a task and reads it back",
  "VAL-CROSS-001: End-to-end task lifecycle (PostgreSQL) > moves a task through all columns",
  "VAL-CROSS-001: End-to-end task lifecycle (PostgreSQL) > archives and lists tasks",
  "VAL-CROSS-001: End-to-end task lifecycle (PostgreSQL) > updates task fields and they persist",
  "VAL-CROSS-001: End-to-end task lifecycle (PostgreSQL) > searches tasks by description",
  "VAL-CROSS-001: End-to-end task lifecycle (PostgreSQL) > deletes a task (soft-delete)",
  "handoff-to-review transactional invariant (PostgreSQL) > atomically moves column + enqueues merge queue + creates workflow work item",
  "handoff-to-review transactional invariant (PostgreSQL) > is idempotent and records the retry status in the handoff audit",
  "handoff-to-review transactional invariant (PostgreSQL) > rejects handoff of a soft-deleted task without partial writes",
  "handoff-to-review transactional invariant (PostgreSQL) > rollback of the outer handoff tx must not leave orphaned workflow work items (#12)",
];
const expectedRestartIntegrationNames = [
  "In-progress task resume after restart > resumeOrphaned() calls execute() for each in-progress task not already executing",
  "In-progress task resume after restart > resumed task reuses existing worktree — no git worktree add called",
  "In-progress task resume after restart > resumed task with step progress includes RESUMING section in agent prompt",
  "In-progress task resume after restart > resumed task does NOT re-run worktreeInitCommand",
  "In-progress task resume after restart > recovers a step whose code review approved before the engine stopped (no review replay)",
  "In-progress task resume after restart > does NOT recover a step that was reset to pending after its code review approved",
  "In-progress task resume after restart > does NOT recover a step whose code review only revised (no APPROVE)",
  "In-progress task resume after restart > recovers multiple in-progress steps that each have approved code reviews",
  "In-progress task resume after restart > resumeOrphaned() logs 'Resumed after engine restart' for each orphaned task",
  "In-progress task resume after restart > resumeOrphaned() fast-paths already-complete tasks to in-review",
  "In-progress task resume after restart > resumeOrphaned() does not block startup on completed-task recovery",
  "In-progress task resume after restart > resumeOrphaned() leaves no-progress no-fn_task_done failures for self-healing",
  "In-progress task resume after restart > recoverCompletedTask() re-enters the workflow graph (records results + owns the transition)",
  "In-progress task resume after restart > recoverCompletedTask() skips graph re-entry when enabled pre-merge gates already passed",
  "In-progress task resume after restart > recoverCompletedTask() legally re-homes a completed triage zombie before review handoff",
  "In-progress task resume after restart > recoverCompletedTask() treats passed default review rows as satisfied when enabled steps are absent",
  "In-progress task resume after restart > recoverCompletedTask() fails closed (KTD-5) when the store lacks getTaskWorkflowSelection and the task has enabled workflow steps",
  "In-progress task resume after restart > recoverCompletedTask() refuses graph re-entry when the live task has incomplete steps",
  "In-progress task resume after restart > recoverCompletedTask() yields to a scheduled workflow remediation bounce",
  "In-review merge handling after restart > aiMergeTask validates task is in 'in-review' before merging",
  "In-review merge handling after restart > aiMergeTask sets status to 'merging' during execution and clears on success",
  "In-review merge handling after restart > sequential aiMergeTask calls for multiple in-review tasks all succeed",
  "In-review merge handling after restart > aiMergeTask throws on agent failure during session.prompt and calls git reset --merge",
  "In-review merge handling after restart > aiMergeTask blocks done transition when branch is missing and ownership evidence is unproven",
  "Triage re-pick after restart > TriageProcessor.start() after restart picks up triage tasks (processing set is fresh)",
  "Triage re-pick after restart > specifyTask() skips task already in processing set (no double-specification)",
  "Scheduler after restart > schedule() moves todo tasks to in-progress when deps are satisfied",
  "Scheduler after restart > schedule() respects dependency ordering — blocked tasks stay in todo",
  "Scheduler after restart > full column coverage: restart with tasks in every column",
  "Crash scenario edge cases > agent dies mid-step — onError is called, semaphore slot released, task eligible for resume",
  "Crash scenario edge cases > engine killed during merge — git reset --merge cleanup, task stays in-review",
  "Crash scenario edge cases > concurrent resumeOrphaned() calls don't double-execute the same task",
  "Crash scenario edge cases > semaphore integrity after crash — activeCount returns to pre-execution value",
  "Worktree pool restart with recycleWorktrees=true > pool is rehydrated with idle worktrees from disk",
  "Worktree pool restart with recycleWorktrees=true > executor acquires from rehydrated pool instead of creating new worktrees",
  "Worktree pool restart with recycleWorktrees=true > worktrees assigned to in-progress tasks are preserved (not in pool)",
  "Worktree pool restart with recycleWorktrees=true > worktrees assigned to in-review tasks are preserved (not in pool)",
  "Worktree cleanup on restart with recycleWorktrees=false > orphaned worktrees are cleaned up via git worktree remove",
  "Worktree cleanup on restart with recycleWorktrees=false > worktrees assigned to in-progress tasks are preserved during cleanup",
  "Worktree cleanup on restart with recycleWorktrees=false > worktrees assigned to in-review tasks are preserved during cleanup",
  "Edge case: worktree deleted between scan and acquire > acquire returns null when rehydrated worktree was deleted from disk",
  "Engine pause/unpause cycle > executor: agents continue running on enginePaused (soft pause), complete normally",
  "Engine pause/unpause cycle > triage: agents NOT terminated on enginePaused (soft pause), session continues",
  "Engine pause/unpause cycle > scheduler resumes on unpause: schedule() runs when enginePaused goes true→false",
  "Engine pause/unpause cycle > concurrency slots freed after agent completes during enginePaused (soft pause)",
  "getTaskMergeBlocker import regression > getTaskMergeBlocker is importable from @fusion/core at runtime",
  "getTaskMergeBlocker import regression > getTaskMergeBlocker rejects non-in-review tasks",
  "getTaskMergeBlocker import regression > aiMergeTask can be loaded from merger module (getTaskMergeBlocker reachable)",
];
const expectedRestartNames = [
  "CCC Wave 4 PostgreSQL branch persistence > Wave 4 control: PostgreSQL persists uninterrupted A → {B,C} → D",
  "CCC Wave 4 PostgreSQL branch persistence > Wave 4 RED: ccc branch admission failure stops before the first branch effect",
  "CCC Wave 4 PostgreSQL branch persistence > Wave 4 RED: ccc terminal branch checkpoint failure blocks the join successor",
  "CCC Wave 4 PostgreSQL branch persistence > Wave 4 RED: PostgreSQL death during B and C resumes only unfinished branch work",
  "CCC Wave 4 PostgreSQL branch persistence > Wave 4 preservation: PostgreSQL restart after durable A resumes at the split without replaying A",
  "CCC Wave 4 PostgreSQL branch persistence > Wave 4 RED: failed PostgreSQL fixture teardown preserves a redacted diagnostic packet",
  "CCC Wave 4 PostgreSQL branch persistence > Wave 4 RED: early teardown and packet-write failures preserve the original redacted cause",
];
const expectedRetryNames = [
  "CCC Wave 4 PostgreSQL retry classification > Wave 4 RED: transient failure consumes exactly the configured total attempt count",
  "CCC Wave 4 PostgreSQL retry classification > Wave 4 RED: permanent failure is attempted once and parks manual-required",
  "CCC Wave 4 PostgreSQL retry classification > Wave 4 RED: transient exhaustion consumes three calls and parks exhausted",
  "CCC Wave 4 PostgreSQL retry classification > Wave 4 RED: consumed retrying cap fails closed without another handler call",
  "CCC Wave 4 PostgreSQL retry classification > Wave 4 RED: claimed retrying cap exhausts without dispatch through the native processor",
];
const expectedWave5CliNames = [
  "prd built CLI user contract > advertises author, validate, and compile from top-level help",
  "prd built CLI user contract > author writes the requested sidecar and validate/compile are zero-store user commands",
  "prd built CLI user contract > returns stable usage and semantic-refusal exit codes",
  "prd built CLI user contract > refuses a foreign admitted target through built validate and compile",
  "prd built CLI user contract > refuses a foreign admitted base through built validate and compile",
  "prd built CLI user contract > refuses author output that would overwrite admitted packet.md bytes",
  "prd built CLI user contract > refuses author output that would overwrite admitted manifest.json bytes",
  "prd built CLI user contract > refuses author output that would overwrite an unrelated existing file",
  "prd built CLI user contract > maintains an existing valid versioned sidecar",
  "prd command exit contract > returns usage exit 2 before any compiler or filesystem work",
];
const expectedWave5CoreContractNames = [
  "ccc-prd public schema > normalizes each protected action to a specific operator decision",
  "ccc-prd public schema > makes source-addressable refusal bundles",
  "ccc-prd sidecar public contract > publishes distinct sidecar and compiled-bundle schema versions",
  "ccc-prd sidecar public contract > compares strings by JavaScript code units",
  "ccc-prd sidecar public contract > canonicalizes nested plain objects without reordering arrays",
  "ccc-prd sidecar public contract > rejects non-finite numbers, cycles, and non-plain objects",
  "ccc-prd sidecar public contract > creates byte-custody spans without UTF-8 or UTF-16 column drift",
];
const expectedWave5CoreImportNames = [
  "CCC PRD import public surface > exports the import, inspection, and reconciliation entry points",
  "CCC PRD import public surface > uses canonical semantic content, not a fixed fixture literal, for bundle identity",
  "CCC PRD import-owned PostgreSQL/filesystem unit of work > rolls back every database entity/final-audit boundary without effects: campaign",
  "CCC PRD import-owned PostgreSQL/filesystem unit of work > rolls back every database entity/final-audit boundary without effects: task",
  "CCC PRD import-owned PostgreSQL/filesystem unit of work > rolls back every database entity/final-audit boundary without effects: dependency_edge",
  "CCC PRD import-owned PostgreSQL/filesystem unit of work > rolls back every database entity/final-audit boundary without effects: workflow",
  "CCC PRD import-owned PostgreSQL/filesystem unit of work > rolls back every database entity/final-audit boundary without effects: document",
  "CCC PRD import-owned PostgreSQL/filesystem unit of work > rolls back every database entity/final-audit boundary without effects: artifact",
  "CCC PRD import-owned PostgreSQL/filesystem unit of work > rolls back every database entity/final-audit boundary without effects: source",
  "CCC PRD import-owned PostgreSQL/filesystem unit of work > rolls back every database entity/final-audit boundary without effects: work_item",
  "CCC PRD import-owned PostgreSQL/filesystem unit of work > rolls back every database entity/final-audit boundary without effects: run_audit",
  "CCC PRD import-owned PostgreSQL/filesystem unit of work > leaves only a prepared, non-runnable state across projection boundary: after_prepared_db_commit",
  "CCC PRD import-owned PostgreSQL/filesystem unit of work > leaves only a prepared, non-runnable state across projection boundary: task_directory",
  "CCC PRD import-owned PostgreSQL/filesystem unit of work > leaves only a prepared, non-runnable state across projection boundary: task_json",
  "CCC PRD import-owned PostgreSQL/filesystem unit of work > leaves only a prepared, non-runnable state across projection boundary: prompt",
  "CCC PRD import-owned PostgreSQL/filesystem unit of work > leaves only a prepared, non-runnable state across projection boundary: artifact_bytes",
  "CCC PRD import-owned PostgreSQL/filesystem unit of work > leaves only a prepared, non-runnable state across projection boundary: canonical_projection_move",
  "CCC PRD import-owned PostgreSQL/filesystem unit of work > leaves only a prepared, non-runnable state across projection boundary: before_activation",
  "CCC PRD import-owned PostgreSQL/filesystem unit of work > recovers a lost response after the activation commit without runnable filesystem drift",
  "CCC PRD import-owned PostgreSQL/filesystem unit of work > observes every preparation writer on one actual DbTransaction with no nested or top-level writes",
  "CCC PRD import-owned PostgreSQL/filesystem unit of work > invalidates native workflow caches only after the prepared database transaction commits",
  "CCC PRD import-owned PostgreSQL/filesystem unit of work > commits exact semantic counts, projects task/document/artifact readers, and remains visible after restart",
  "CCC PRD import-owned PostgreSQL/filesystem unit of work > rebuilds missing canonical prepared files for an active import after restart",
  "CCC PRD import-owned PostgreSQL/filesystem unit of work > serializes two concurrent active repairs over one staging prefix",
  "CCC PRD import-owned PostgreSQL/filesystem unit of work > bounds active-repair lock waiting by the admitted reconciliation budget",
  "CCC PRD import-owned PostgreSQL/filesystem unit of work > bounds same-key preparation admission while the creator transaction is uncommitted",
  "CCC PRD import-owned PostgreSQL/filesystem unit of work > is sequentially and concurrently idempotent, including a lost response after commit",
  "CCC PRD import-owned PostgreSQL/filesystem unit of work > keeps a live projection claim beyond lease expiry while an identical import waits",
  "CCC PRD import-owned PostgreSQL/filesystem unit of work > keeps renewing through the activation handoff while an identical import waits",
  "CCC PRD import-owned PostgreSQL/filesystem unit of work > bounds an identical wait by the admitted bundle duration plus reconciliation overhead",
  "CCC PRD import-owned PostgreSQL/filesystem unit of work > retries one transient PostgreSQL lease-renewal failure without losing ownership",
  "CCC PRD import-owned PostgreSQL/filesystem unit of work > surfaces projection lease ownership loss as a deterministic reconciliation conflict",
  "CCC PRD import-owned PostgreSQL/filesystem unit of work > namespaces global workflow and artifact IDs so independent imports cannot collide",
  "CCC PRD import-owned PostgreSQL/filesystem unit of work > includes all three import custody tables in the shared PostgreSQL reset",
  "CCC PRD import-owned PostgreSQL/filesystem unit of work > allows failed-then-retry but refuses idempotency-key collisions on bundle, target, or base",
  "CCC PRD import-owned PostgreSQL/filesystem unit of work > refuses a symlink escape through the owned .fusion/tasks root without external writes",
  "CCC PRD import-owned PostgreSQL/filesystem unit of work > refuses a symlink escape through the owned .fusion/artifacts root without external writes",
  "CCC PRD import-owned PostgreSQL/filesystem unit of work > refuses a symlink escape through the owned .fusion/ccc-prd-import-staging root without external writes",
  "CCC PRD import-owned PostgreSQL/filesystem unit of work > refuses a dangling symlink at an existing canonical artifact path",
  "CCC PRD import-owned PostgreSQL/filesystem unit of work > refuses a byte-identical symlink at an existing canonical task directory",
];
const expectedWave5CoreMigrationNames = [
  "CCC PRD import migration registry > keeps migration 0035 immutable and registers every custody table",
  "CCC PRD import migration 0034 to 0035 > upgrades once with fresh-shape parity, forced RLS, triggers, FKs, checks, and indexes",
  "CCC PRD import migration 0035 to 0036 > marks a populated runnable 0035 import unadmitted and refuses restart reconciliation",
];
const expectedWave5EngineContractNames = [
  "ccc-prd structural compiler boundary > refuses direct Markdown compilation without the generated structural sidecar",
  "ccc-prd structural compiler boundary > validates the admitted Neo cold-review candidate but always refuses dispatch",
  "ccc-prd admitted ccc-lab-super oracle > generates the frozen sidecar from unchanged dense Markdown through the production authoring seam",
  "ccc-prd admitted ccc-lab-super oracle > compiles exact non-zero entity counts and stable real-packet identities",
  "ccc-prd structural sidecar > authors raw-byte custody and compiles the complete structural graph in code-unit order",
  "ccc-prd structural sidecar > refuses raw byte mutation deterministically",
  "ccc-prd structural sidecar > refuses stale span deterministically",
  "ccc-prd structural sidecar > refuses duplicate id deterministically",
  "ccc-prd structural sidecar > refuses unresolved decision deterministically",
  "ccc-prd structural sidecar > refuses unbounded limit deterministically",
  "ccc-prd structural sidecar > refuses foreign target deterministically",
  "ccc-prd structural sidecar > refuses foreign base deterministically",
  "ccc-prd structural sidecar > refuses unknown top-level declaration deterministically",
  "ccc-prd structural sidecar > refuses blank task title deterministically",
  "ccc-prd structural sidecar > refuses invalid authority role deterministically",
  "ccc-prd structural sidecar > refuses invalid proof confidence deterministically",
  "ccc-prd structural sidecar > refuses blank workflow title deterministically",
  "ccc-prd structural sidecar > refuses manifest, sidecar, and symlinked-ancestor escapes before reads",
  "ccc-prd structural sidecar > does not infer actions, deferred state, or loops from prose",
  "ccc-prd structural sidecar > validates with diagnostics only and never returns a bundle",
];
const expectedWave5EngineImportNames = [
  "CCC PRD imported workflow execution > claims and executes the imported runnable item through the normal engine path",
];

function assertionName(assertion) {
  return [...(assertion.ancestorTitles ?? []), assertion.title].join(" > ");
}

function assertClosedNamedResults(expectedNames, assertions, label) {
  const expected = new Set(expectedNames);
  if (expected.size !== expectedNames.length) throw new Error(`${label}: expected-name list contains duplicates`);
  const seen = new Map();
  for (const assertion of assertions) {
    const name = assertionName(assertion);
    if (!expected.has(name)) throw new Error(`${label}: unexpected named test: ${name}`);
    seen.set(name, (seen.get(name) ?? 0) + 1);
    if (assertion.status !== "passed") throw new Error(`${label}: ${name} is ${assertion.status}`);
  }
  for (const name of expectedNames) {
    const count = seen.get(name) ?? 0;
    if (count === 0) throw new Error(`${label}: missing named test: ${name}`);
    if (count !== 1) throw new Error(`${label}: duplicate named test: ${name}`);
  }
}

function assertMachineResultInventory(command) {
  if (!command.machineResults) return;
  if (!Array.isArray(command.expectedNames) || command.expectedNames.length === 0) {
    throw new Error(`${command.id ?? "machine-result command"}: machine results require a non-empty expected-name inventory`);
  }
  if (new Set(command.expectedNames).size !== command.expectedNames.length) {
    throw new Error(`${command.id ?? "machine-result command"}: expected-name inventory contains duplicates`);
  }
}

/*
FNXC:CccWave4Proof 2026-07-24-12:12:
The proof runner's policy is itself a correctness boundary. Exercise the
closed-list checker against synthetic machine results so missing, extra,
duplicate, skipped, pending, and failed outcomes are rejected without parsing
human vitest output.
*/
function selfTestClosedNamePolicy() {
  const expected = ["suite > required"];
  const good = [{ ancestorTitles: ["suite"], title: "required", status: "passed" }];
  assertClosedNamedResults(expected, good, "policy-self-test");
  assertMachineResultInventory({ machineResults: true, expectedNames: expected });
  let duplicateInventoryRejected = false;
  try {
    assertMachineResultInventory({ machineResults: true, expectedNames: [...expected, ...expected] });
  } catch {
    duplicateInventoryRejected = true;
  }
  if (!duplicateInventoryRejected) throw new Error("policy-self-test: duplicate expected-name inventory was accepted");
  for (const command of [
    { machineResults: true },
    { machineResults: true, expectedNames: [] },
  ]) {
    let rejected = false;
    try {
      assertMachineResultInventory(command);
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error("policy-self-test: machine result without a closed expected-name inventory was accepted");
  }
  for (const [label, assertions] of [
    ["missing", []],
    ["extra", [...good, { ancestorTitles: ["suite"], title: "extra", status: "passed" }]],
    ["duplicate", [...good, ...good]],
    ["skipped", [{ ...good[0], status: "skipped" }]],
    ["pending", [{ ...good[0], status: "pending" }]],
    ["todo", [{ ...good[0], status: "todo" }]],
    ["failed", [{ ...good[0], status: "failed" }]],
  ]) {
    let rejected = false;
    try {
      assertClosedNamedResults(expected, assertions, `policy-self-test:${label}`);
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error(`policy-self-test:${label} was accepted`);
  }
}
selfTestClosedNamePolicy();

function assertSupervisorResult(result, commands) {
  if (result.stopError) throw new Error(`embedded PostgreSQL stop failed: ${result.stopError}`);
  if (result.interrupted) throw new Error(`supervisor interrupted by ${result.interrupted}`);
  for (const command of commands) {
    const outcome = result.results.find((entry) => entry.id === command.id);
    if (!outcome) throw new Error(`missing command result: ${command.id}`);
    if (outcome.timedOut) throw new Error(`${command.id} exceeded its bounded timeout`);
    if (outcome.spawnError) throw new Error(`${command.id} spawn rejected: ${outcome.spawnError}`);
    if (outcome.signal) throw new Error(`${command.id} terminated by ${outcome.signal}`);
    if (outcome.code !== 0) throw new Error(`${command.id} exited ${outcome.code}`);
  }
}

function selfTestSupervisorFailurePolicy() {
  const commands = [{ id: "required" }];
  const passed = { results: [{ id: "required", code: 0, timedOut: false }], stopError: null, interrupted: null };
  assertSupervisorResult(passed, commands);
  for (const result of [
    { ...passed, results: [{ id: "required", code: 1, timedOut: true }] },
    { ...passed, results: [{ id: "required", code: 1, spawnError: "injected rejection" }] },
    { ...passed, results: [{ id: "required", code: 0, timedOut: false, signal: "SIGTERM" }] },
    { ...passed, stopError: "injected stop failure" },
    { ...passed, interrupted: "SIGTERM" },
  ]) {
    let rejected = false;
    try { assertSupervisorResult(result, commands); } catch { rejected = true; }
    if (!rejected) throw new Error("policy-self-test: supervisor failure was accepted");
  }
}
selfTestSupervisorFailurePolicy();

if (runnerPolicySelfTest) {
  await selfTestStopSettlementPolicy();
  console.log("CCC proof-runner policy self-tests passed");
  process.exit(0);
}

const repoRoot = process.cwd();
const proofRoot = await mkdtemp(join(tmpdir(), `ccc-wave-${selectedWave}-proof-`));
const dataRoot = join(proofRoot, "postgres-data");
const resultRoot = join(dataRoot, "machine-results");
const reportPath = join(proofRoot, "report.json");
const manifestPath = join(proofRoot, "manifest.json");

const wave4Commands = [
  {
    id: "core-pg-gate",
    command: ["pnpm", "--filter", "@fusion/core", "test:pg-gate"],
    vitestArgs: ["--reporter=json"],
    expectedNames: expectedCoreGateNames,
    machineResults: true,
  },
  {
    id: "engine-restart-integration",
    command: ["pnpm", "--filter", "@fusion/engine", "exec", "vitest", "run", "src/__tests__/restart.integration.test.ts", "--project=engine-default", "--silent=passed-only", "--reporter=dot"],
    vitestArgs: ["--reporter=json"],
    expectedNames: expectedRestartIntegrationNames,
    machineResults: true,
  },
  {
    id: "ccc-workflow-restart-real-pg",
    command: ["pnpm", "--filter", "@fusion/engine", "exec", "vitest", "run", "src/__tests__/ccc-workflow-restart.real-pg.test.ts", "--project=engine-default", "--silent=passed-only", "--reporter=dot"],
    vitestArgs: ["--reporter=json"],
    expectedNames: expectedRestartNames,
    machineResults: true,
  },
  {
    id: "ccc-retry-classification-real-pg",
    command: ["pnpm", "--filter", "@fusion/engine", "exec", "vitest", "run", "src/__tests__/ccc-retry-classification.real-pg.test.ts", "--project=engine-default", "--silent=passed-only", "--reporter=dot"],
    vitestArgs: ["--reporter=json"],
    expectedNames: expectedRetryNames,
    machineResults: true,
  },
];
const wave5Commands = [
  {
    id: "ccc-prd-cli",
    command: ["pnpm", "--filter", "@runfusion/fusion", "exec", "vitest", "run", "src/commands/__tests__/prd.test.ts", "src/commands/__tests__/prd-built-cli.test.ts", "--silent=passed-only", "--reporter=dot"],
    vitestArgs: ["--reporter=json"],
    expectedNames: expectedWave5CliNames,
    machineResults: true,
  },
  {
    id: "ccc-prd-core-contract",
    command: ["pnpm", "--filter", "@fusion/core", "exec", "vitest", "run", "src/__tests__/ccc-prd-schema.test.ts", "src/__tests__/ccc-prd-sidecar-contract.test.ts", "--silent=passed-only", "--reporter=dot"],
    vitestArgs: ["--reporter=json"],
    expectedNames: expectedWave5CoreContractNames,
    machineResults: true,
  },
  {
    id: "ccc-prd-core-import",
    command: ["pnpm", "--filter", "@fusion/core", "exec", "vitest", "run", "src/__tests__/postgres/ccc-prd-import.pg.test.ts", "--silent=passed-only", "--reporter=dot"],
    vitestArgs: ["--reporter=json"],
    expectedNames: expectedWave5CoreImportNames,
    machineResults: true,
  },
  {
    id: "ccc-prd-core-migration",
    command: ["pnpm", "--filter", "@fusion/core", "exec", "vitest", "run", "src/__tests__/postgres/ccc-prd-import-migration.pg.test.ts", "--silent=passed-only", "--reporter=dot"],
    vitestArgs: ["--reporter=json"],
    expectedNames: expectedWave5CoreMigrationNames,
    machineResults: true,
  },
  {
    id: "ccc-prd-engine-contract",
    command: ["pnpm", "--filter", "@fusion/engine", "exec", "vitest", "run", "src/__tests__/ccc-prd-compiler.test.ts", "src/__tests__/ccc-prd-corpus.test.ts", "src/__tests__/ccc-prd-structural.test.ts", "--silent=passed-only", "--reporter=dot"],
    vitestArgs: ["--reporter=json"],
    expectedNames: expectedWave5EngineContractNames,
    machineResults: true,
  },
  {
    id: "ccc-prd-engine-import",
    command: ["pnpm", "--filter", "@fusion/engine", "exec", "vitest", "run", "src/__tests__/ccc-prd-import-execution.real-pg.test.ts", "--silent=passed-only", "--reporter=dot"],
    vitestArgs: ["--reporter=json"],
    expectedNames: expectedWave5EngineImportNames,
    machineResults: true,
  },
];
const commands = selectedWave === 5 ? wave5Commands : wave4Commands;
for (const command of commands) assertMachineResultInventory(command);

function positiveBudget(name, fallback) {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive finite millisecond budget`);
  return Math.floor(value);
}

const budgetPrefix = selectedWave === 5 ? "CCC_W5" : "CCC_W4";
const childTimeoutMs = positiveBudget(`${budgetPrefix}_CHILD_TIMEOUT_MS`, 120_000);
const childTerminateGraceMs = positiveBudget(`${budgetPrefix}_CHILD_TERMINATE_GRACE_MS`, 2_000);
const postgresStopBudgetMs = positiveBudget(`${budgetPrefix}_PG_STOP_TIMEOUT_MS`, 10_000);
const parentShutdownMarginMs = positiveBudget(`${budgetPrefix}_PARENT_SHUTDOWN_MARGIN_MS`, 3_000);
const proofDatabase = `ccc_wave${selectedWave}_proof`;

const supervisor = `
  import { EmbeddedPostgresLifecycle } from ${JSON.stringify(join(repoRoot, "packages/core/src/postgres/embedded-lifecycle.ts"))};
  import { spawn } from "node:child_process";
  import { mkdir } from "node:fs/promises";
  import { join } from "node:path";
  const lifecycleErrors = [];
  const lifecycle = new EmbeddedPostgresLifecycle({
    dataDir: process.env.CCC_PROOF_DATA_ROOT,
    database: process.env.CCC_PROOF_DATABASE,
    // The supervisor owns SIGINT/SIGTERM for this disposable proof process.
    installShutdownHooks: false,
    throwOnStopError: true,
    onError: (error) => lifecycleErrors.push(String(error)),
  });
  const commands = JSON.parse(process.env.CCC_PROOF_COMMANDS);
  const results = [];
  const timeoutMs = Number(process.env.CCC_PROOF_CHILD_TIMEOUT_MS ?? 120000);
  const terminateGraceMs = Number(process.env.CCC_PROOF_CHILD_TERMINATE_GRACE_MS ?? 2000);
  const stopTimeoutMs = Number(process.env.CCC_PROOF_PG_STOP_TIMEOUT_MS ?? 10000);
  let activeTerminate = null;
  let interrupted = null;
  const run = (cmd, args, env) => new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: process.env.CCC_PROOF_REPO_ROOT, env, stdio: ["ignore", "ignore", "ignore"] });
    let settled = false;
    let timedOut = false;
    let forcedKill = false;
    let forceTimer = null;
    const finish = (result) => { if (settled) return; settled = true; clearTimeout(timer); if (forceTimer) clearTimeout(forceTimer); activeTerminate = null; resolve(result); };
    const terminate = (signal = "SIGTERM") => {
      if (settled) return;
      child.kill(signal);
      if (signal === "SIGTERM") {
        forceTimer = setTimeout(() => { if (!settled) { forcedKill = true; child.kill("SIGKILL"); } }, terminateGraceMs);
      }
    };
    activeTerminate = terminate;
    const timer = setTimeout(() => { timedOut = true; terminate("SIGTERM"); }, timeoutMs);
    child.once("error", (error) => finish({ code: 1, signal: null, timedOut, forcedKill, spawnError: error instanceof Error ? error.message : String(error) }));
    child.once("exit", (code, signal) => finish({ code: Number(code ?? 1), signal: signal ?? null, timedOut, forcedKill }));
  });
  const onSignal = (signal) => { interrupted ??= signal; activeTerminate?.("SIGTERM"); };
  const onSigInt = () => onSignal("SIGINT");
  const onSigTerm = () => onSignal("SIGTERM");
  process.once("SIGINT", onSigInt);
  process.once("SIGTERM", onSigTerm);
  ${stopWithinBudgetPolicy.toString()}
  ${stopFailureText.toString()}
  const stopWithinBudget = () => stopWithinBudgetPolicy(lifecycle, stopTimeoutMs);
  let stopError = null;
  try {
    await lifecycle.start();
    const url = new URL(lifecycle.getConnectionUrl()); url.pathname = "/";
    await mkdir(process.env.CCC_PROOF_RESULT_ROOT, { recursive: true });
    for (const entry of commands) {
      if (interrupted) break;
      const outputFile = entry.machineResults ? join(process.env.CCC_PROOF_RESULT_ROOT, entry.id + ".json") : null;
      const args = entry.machineResults
        ? [...entry.command.slice(1), ...entry.vitestArgs, "--outputFile", outputFile]
        : entry.command.slice(1);
      const outcome = await run(entry.command[0], args, { ...process.env, FUSION_PG_TEST_URL_BASE: url.href.slice(0, -1) });
      results.push({ id: entry.id, command: entry.command, ...outcome, outputFile });
      if (interrupted || outcome.code !== 0) break;
    }
  } finally {
    process.removeListener("SIGINT", onSigInt);
    process.removeListener("SIGTERM", onSigTerm);
    try { await stopWithinBudget(); } catch (error) { stopError = stopFailureText(error); }
  }
  process.stdout.write("CCC_PROOF_SUPERVISOR_RESULT=" + JSON.stringify({ results, database: process.env.CCC_PROOF_DATABASE, stopError, lifecycleErrors, interrupted }) + "\\n");
  if (stopError || interrupted || results.some((result) => result.code !== 0) || results.length !== commands.length) process.exitCode = 1;
`;

function redact(text) {
  return String(text)
    .replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, "[redacted-postgresql-url]")
    .replace(/password=[^\s&]+/gi, "password=[redacted]");
}

const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", supervisor], {
  cwd: repoRoot,
  env: {
    ...process.env,
    CCC_PROOF_DATA_ROOT: dataRoot,
    CCC_PROOF_RESULT_ROOT: resultRoot,
    CCC_PROOF_REPO_ROOT: repoRoot,
    CCC_PROOF_DATABASE: proofDatabase,
    CCC_PROOF_COMMANDS: JSON.stringify(commands),
    CCC_PROOF_CHILD_TIMEOUT_MS: String(childTimeoutMs),
    CCC_PROOF_CHILD_TERMINATE_GRACE_MS: String(childTerminateGraceMs),
    CCC_PROOF_PG_STOP_TIMEOUT_MS: String(postgresStopBudgetMs),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => { stdout += String(chunk); });
child.stderr.on("data", (chunk) => { stderr += String(chunk); });
let forwardedSignal = null;
let parentForceKillTimer = null;
const parentSignalBoundMs = childTerminateGraceMs + postgresStopBudgetMs + parentShutdownMarginMs;
const parentNormalBoundMs = commands.length * childTimeoutMs + childTerminateGraceMs + postgresStopBudgetMs + parentShutdownMarginMs;
let parentNormalTimeout = null;
const forwardSignal = (signal) => {
  forwardedSignal ??= signal;
  child.kill(signal);
  parentForceKillTimer ??= setTimeout(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  }, parentSignalBoundMs);
};
const forwardSigInt = () => forwardSignal("SIGINT");
const forwardSigTerm = () => forwardSignal("SIGTERM");
process.once("SIGINT", forwardSigInt);
process.once("SIGTERM", forwardSigTerm);
parentNormalTimeout = setTimeout(() => forwardSignal("SIGTERM"), parentNormalBoundMs);
let supervisorSpawnError = null;
const exitCode = await new Promise((resolve) => {
  child.once("error", (error) => { supervisorSpawnError = redact(error instanceof Error ? error.message : String(error)); resolve(1); });
  child.once("exit", resolve);
});
process.removeListener("SIGINT", forwardSigInt);
process.removeListener("SIGTERM", forwardSigTerm);
if (parentForceKillTimer) clearTimeout(parentForceKillTimer);
if (parentNormalTimeout) clearTimeout(parentNormalTimeout);
const supervisorLine = stdout.split("\n").find((line) => line.startsWith("CCC_PROOF_SUPERVISOR_RESULT="));
let supervisorResult = { results: [], database: proofDatabase };
let policyError;
try {
  if (supervisorSpawnError) throw new Error(`supervisor spawn rejected: ${supervisorSpawnError}`);
  if (!supervisorLine) throw new Error("supervisor did not emit machine result");
  supervisorResult = JSON.parse(supervisorLine.slice("CCC_PROOF_SUPERVISOR_RESULT=".length));
  if (forwardedSignal) throw new Error(`proof runner interrupted by ${forwardedSignal}`);
  assertSupervisorResult(supervisorResult, commands);
  for (const command of commands) {
    const result = supervisorResult.results.find((entry) => entry.id === command.id);
    if (!command.machineResults) continue;
    const json = JSON.parse(await readFile(result.outputFile, "utf8"));
    const assertions = json.testResults.flatMap((testResult) => testResult.assertionResults ?? []);
    if (json.numFailedTests !== 0 || json.numPendingTests !== 0 || json.numTodoTests !== 0 || json.numPassedTests === 0) {
      throw new Error(`${command.id}: failed, skipped, pending, todo, or empty machine result`);
    }
    assertClosedNamedResults(command.expectedNames, assertions, command.id);
  }
} catch (error) {
  policyError = redact(error instanceof Error ? error.message : String(error));
}

const passed = exitCode === 0 && policyError === undefined;
const report = {
  wave: selectedWave,
  passed,
  commands: supervisorResult.results.map(({ outputFile, ...result }) => Object.fromEntries(
    Object.entries(result).map(([key, value]) => [key, typeof value === "string" ? redact(value) : value]),
  )),
  policyError: policyError ?? null,
};
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
await writeFile(manifestPath, `${JSON.stringify({ wave: selectedWave, passed, reportPath, database: supervisorResult.database }, null, 2)}\n`);
if (passed) {
  await rm(dataRoot, { recursive: true, force: true });
  console.log(`Wave ${selectedWave} PostgreSQL proof passed; redacted report: ${reportPath}`);
} else {
  await writeFile(join(proofRoot, "supervisor.log"), redact(`${stdout}\n${stderr}`));
  console.error(`Wave ${selectedWave} PostgreSQL proof failed; preserved diagnosis: ${proofRoot}`);
  process.exitCode = 1;
}
