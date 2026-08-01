#!/usr/bin/env node
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { setImmediate } from "node:timers";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const stopPolicySelfTest = process.argv.length === 3 && process.argv[2] === "--self-test-stop-settlement";
const runnerPolicySelfTest = process.argv.length === 3 && process.argv[2] === "--self-test-policies";
const selectedWave = process.argv.length === 4 && process.argv[2] === "--wave"
  ? Number(process.argv[3])
  : null;
if (!stopPolicySelfTest && !runnerPolicySelfTest && selectedWave !== 4 && selectedWave !== 5 && selectedWave !== 6) {
  throw new Error("usage: node scripts/run-ccc-pg-proof.mjs --wave <4|5|6>");
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
  "prd built CLI user contract > discovers and freezes a project-local PRD through the built CLI without changing source bytes",
  "prd built CLI user contract > prints and lints the optional future-PRD contract through the built CLI",
  "prd built CLI user contract > author writes the requested sidecar and validate/compile are zero-store user commands",
  "prd built CLI user contract > returns stable usage and semantic-refusal exit codes",
  "prd built CLI user contract > refuses product validation when the generated material coverage inventory is absent",
  "prd built CLI user contract > preserves a product refusal exit code after embedded PostgreSQL cleanup",
  "prd built CLI user contract > refuses a foreign admitted target through built validate and compile",
  "prd built CLI user contract > refuses a foreign admitted base through built validate and compile",
  "prd built CLI user contract > refuses author output that would overwrite admitted packet.md bytes",
  "prd built CLI user contract > refuses author output that would overwrite admitted manifest.json bytes",
  "prd built CLI user contract > refuses author output that would overwrite an unrelated existing file",
  "prd built CLI user contract > maintains an existing valid versioned sidecar",
  "prd command exit contract > returns usage exit 2 before any compiler or filesystem work",
  "prd command exit contract > discovers project-local current PRDs and freezes the operator-selected packet through engine APIs",
  "prd command exit contract > prints the optional intake template and lints implementation-changing facts without rewriting the PRD",
  "prd command exit contract > previews and imports one hash-bound product bundle through the production service seam",
  "prd command exit contract > recomputes preview identity and refuses a stale confirmation before import residue",
  "prd command exit contract > refuses product preview/import when implementation facts are not source-bound before import residue",
  "prd command exit contract > shows one redacted product status with an exact merge confirmation",
  "prd command exit contract > pauses and resumes only the exact confirmed unleased campaign status",
  "prd command exit contract > terminally stops a campaign only with a fresh digest and explicit reason",
  "prd command exit contract > previews and settles one uncertain proof before requeueing its exact work item",
  "prd command exit contract > previews and settles one non-CLI provider effect while routing CLI recovery to its native fence",
  "prd command exit contract > claims exact merge approval, lands, and settles only its parked imported work item",
  "prd command exit contract > claims exact live-execution approval and requeues only its parked imported work item",
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
  "CCC PRD import-owned PostgreSQL/filesystem unit of work > Task 6 RED: imports explicit split join topology for a dependency diamond",
  "CCC PRD import-owned PostgreSQL/filesystem unit of work > Task 6 RED: attaches each workflow transport route extension to its semantic prompt node",
  "CCC PRD import-owned PostgreSQL/filesystem unit of work > product v2 allocates durable native task ids without rewriting semantic custody",
  "CCC PRD import-owned PostgreSQL/filesystem unit of work > product v2 rolls native task allocation back with the importer transaction",
  "CCC PRD import-owned PostgreSQL/filesystem unit of work > product v2 RED: projects coding custody and a final proof barrier before human landing",
  "CCC PRD import-owned PostgreSQL/filesystem unit of work > product v2 CLI route projects stable adapter settings without persisted subscription readiness",
  "CCC PRD import-owned PostgreSQL/filesystem unit of work > product v2 activation schedules planning continuations through import and reconcile",
  "CCC PRD import-owned PostgreSQL/filesystem unit of work > product v2 refuses proof execution without one explicit integration terminal",
  "CCC PRD import-owned PostgreSQL/filesystem unit of work > Task 6 RED: refuses an unregistered workflow transport extension without persisted import state",
  "CCC PRD import-owned PostgreSQL/filesystem unit of work > Task 6 RED: refuses a dangling terminal protected-action reference before emitting workflow IR",
  "CCC PRD import-owned PostgreSQL/filesystem unit of work > Task 6 RED: emits one merge seam after one exact terminal merge action and refuses ambiguous landings",
  "CCC PRD import-owned PostgreSQL/filesystem unit of work > Task 6 RED: preserves no-merge-action workflow IR bytes",
  "CCC PRD import-owned PostgreSQL/filesystem unit of work > admits a new reviewed campaign from the same PRD with distinct native campaign and work-item identities",
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
  "CCC PRD import-owned PostgreSQL/filesystem unit of work > lets an in-flight heartbeat renew before reclaiming its just-expired projection lease",
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
  "ccc-prd admitted ccc-lab-super oracle > refuses the historical three-requirement projection as implausibly shallow",
  "ccc-prd structural sidecar > authors raw-byte custody and compiles the complete structural graph in code-unit order",
  "ccc-prd structural sidecar > refuses constrained authoring when implementation-changing facts are not source-bound",
  "ccc-prd structural sidecar > persists exact-span custody for implementation facts on the supported product route",
  "ccc-prd structural sidecar > refuses a fact value that appears in source but outside the entity cited span",
  "ccc-prd structural sidecar > refuses stale material coverage deterministically",
  "ccc-prd structural sidecar > refuses protected-action drift against durable implementation fact provenance",
  "ccc-prd structural sidecar > refuses an extracted requirement that has no task disposition",
  "ccc-prd structural sidecar > refuses a material source section and explicit source requirement omitted by extraction",
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
  "CCC PRD imported workflow execution > claims the imported runnable item through the fenced full-graph processor",
];

const expectedWave6CampaignPgNames = [
  "CCC campaign approval lifecycle (PostgreSQL) > exposes the lifecycle through the native store and fails closed without PostgreSQL authority",
  "CCC campaign approval lifecycle (PostgreSQL) > issues, claims, consumes, and survives a normal PostgreSQL reader restart",
  "CCC campaign approval lifecycle (PostgreSQL) > keeps active action leases scoped to each sibling task when they reuse an action ID",
  "CCC campaign approval lifecycle (PostgreSQL) > refuses a nonempty legacy flat action-lease row",
  "CCC campaign approval lifecycle (PostgreSQL) > asserts exact consumed custody and refuses wrong request, token, or a remaining action lease",
  "CCC campaign approval lifecycle (PostgreSQL) > maps each protected-action kind to the matching approval policy category",
  "CCC campaign approval lifecycle (PostgreSQL) > denies issued approval and refuses claim before not-before time",
  "CCC campaign approval lifecycle (PostgreSQL) > rolls a denied transition back when its immutable campaign audit receipt collides",
  "CCC campaign approval lifecycle (PostgreSQL) > expires an issued approval, rejects claimed expiry without effect evidence, and refuses a wrong consume token",
  "CCC campaign approval lifecycle (PostgreSQL) > reconciles a claimed approval after nominal expiry, but refuses a same-token replay without its persisted lease",
  "CCC campaign approval lifecycle (PostgreSQL) > admits one exact active claimed approval before a new provider dispatch without writing lifecycle or audit state",
  "CCC campaign approval lifecycle (PostgreSQL) > refuses provider dispatch when only the persisted action lease claim time drifts",
  "CCC campaign approval lifecycle (PostgreSQL) > refuses provider dispatch when only the persisted action lease expiry drifts but remains active",
  "CCC campaign approval lifecycle (PostgreSQL) > refuses provider dispatch when only the claimed approval not-before moves into the future",
  "CCC campaign approval lifecycle (PostgreSQL) > refuses a past database-clock approval window before dispatch while preserving after-effect consume",
  "CCC campaign approval lifecycle (PostgreSQL) > refuses a wrong token, elapsed, missing, or drifted lease, and gives a restarted PostgreSQL reader the same active result",
  "CCC campaign approval lifecycle (PostgreSQL) > expires a claimed approval only after exact native proved-failed receipt evidence and no unknown dispatch",
  "CCC campaign approval lifecycle (PostgreSQL) > admits exactly one distinct concurrent claim and rejects issue drift",
  "CCC campaign native public surface > reserves the TaskStore campaign-context reader",
  "CCC campaign native public surface > Task 6 RED: canonical workflow routes require an extension identity and bind it into manifest identity",
  "CCC campaign native persistence > Task 3 RED: read-only workflow lease preflight validates every fence field with database time",
  "CCC campaign native persistence > uses a supplied transaction for a campaign-context reload",
  "CCC campaign native persistence > locks the campaign import for a transaction-scoped authority read",
  "CCC campaign native persistence > derives a full authority binding and canonical hash from persisted campaign context",
  "CCC campaign native persistence > refuses protected action target drift",
  "CCC campaign native persistence > refuses an undeclared action when protected authority is required",
  "CCC campaign native persistence > allows one action-lease winner under two concurrent claims",
  "CCC campaign native persistence > replays an identical action lease without changing its owner",
  "CCC campaign native persistence > refuses an action lease collision with a changed winning token",
  "CCC campaign native persistence > settles only the exact winning action lease",
  "CCC campaign native persistence > keeps an action lease visible after a TaskStore restart",
  "CCC campaign native persistence > refuses a persisted action lease whose protected binding has drifted",
  "CCC campaign native persistence > refuses missing exact per-task execution routes",
  "CCC campaign native persistence > refuses extra exact per-task execution routes",
  "CCC campaign native persistence > refuses duplicate exact per-task execution routes",
  "CCC campaign native persistence > refuses an idempotency replay whose provider, model, or transport binding changed",
  "CCC campaign native persistence > returns one immutable context across a sequential identical replay",
  "CCC campaign native persistence > returns one immutable context across two concurrent identical imports",
  "CCC campaign native persistence > reloads the same immutable context after a post-commit lost response",
  "CCC campaign native persistence > persists and reloads an immutable policy-complete campaign binding from custody rows after restart",
  "CCC campaign native persistence > does not accept caller task metadata as campaign context",
  "CCC campaign native persistence > refuses a canonical bundle task proof-id mutation that is not rehashed",
  "CCC campaign native persistence > refuses native task source metadata drift in proof IDs",
  "CCC campaign native persistence > refuses native task source metadata drift in bundle hash",
  "CCC campaign native persistence > fails closed with a typed refusal when persisted campaign custody is malformed",
  "CCC campaign native persistence > refuses restart custody after an admitted symlink target is retargeted",
  "CCC campaign native persistence > refuses a shifted persisted campaign window even when its duration is preserved",
  "CCC campaign native persistence > releases its projection claim when the physical root drifts immediately after claim",
  "CCC campaign native persistence > refuses reconciliation of an explicitly unadmitted legacy campaign row",
  "CCC campaign provider controller (PostgreSQL) > requires one exact active claimed approval and lease before atomic reservation",
  "CCC campaign provider controller (PostgreSQL) > admits a semantic branch against its campaign origin task's active workflow work-item fence",
  "CCC campaign provider controller (PostgreSQL) > refuses a workflow origin task and work-item fence from a different campaign without provider-attempt residue",
  "CCC campaign provider controller (PostgreSQL) > refuses a run-id-mismatch workflow work-item fence before provider-attempt writes",
  "CCC campaign provider controller (PostgreSQL) > refuses a attempt-mismatch workflow work-item fence before provider-attempt writes",
  "CCC campaign provider controller (PostgreSQL) > refuses a non-running workflow work-item fence before provider-attempt writes",
  "CCC campaign provider controller (PostgreSQL) > refuses a missing-owner workflow work-item fence before provider-attempt writes",
  "CCC campaign provider controller (PostgreSQL) > refuses a changed-owner workflow work-item fence before provider-attempt writes",
  "CCC campaign provider controller (PostgreSQL) > refuses a expired workflow work-item fence before provider-attempt writes",
  "CCC campaign provider controller (PostgreSQL) > selects the one live-execution action assigned to this task, not another task's action",
  "CCC campaign provider controller (PostgreSQL) > accepts a canonical 64-character local Git head observation",
  "CCC campaign provider controller (PostgreSQL) > refuses expired approval before any request-count or audit mutation",
  "CCC campaign provider controller (PostgreSQL) > refuses future not-before, wrong approval identity, and wrong claim token without writes",
  "CCC campaign provider controller (PostgreSQL) > refuses a missing persisted action lease without campaign writes",
  "CCC campaign provider controller (PostgreSQL) > refuses corrupted persisted route and semantic task custody without campaign writes",
  "CCC campaign provider controller (PostgreSQL) > refuses wrong actual provider route before any provider-attempt audit or request-count increment",
  "CCC campaign provider controller (PostgreSQL) > refuses wrong actual model route before any provider-attempt audit or request-count increment",
  "CCC campaign provider controller (PostgreSQL) > refuses wrong actual transport route before any provider-attempt audit or request-count increment",
  "CCC campaign provider controller (PostgreSQL) > rolls back reservation and count when begin is interrupted",
  "CCC campaign provider controller (PostgreSQL) > refuses a foreign Git target before campaign attempt writes",
  "CCC campaign provider controller (PostgreSQL) > refuses a foreign Git expected base before campaign attempt writes",
  "CCC campaign provider controller (PostgreSQL) > refuses a noncanonical Git head before campaign attempt writes",
  "CCC campaign provider controller (PostgreSQL) > refuses mixed Git object formats before campaign attempt writes",
  "CCC campaign provider controller (PostgreSQL) > holds identical lost-response replay without extra audit rows or provider permit",
  "CCC campaign provider controller (PostgreSQL) > holds terminal replay after attempted provider consumption without extra permit",
  "CCC campaign provider controller (PostgreSQL) > refuses a task without imported campaign custody instead of treating it as ordinary",
  "CCC campaign provider controller (PostgreSQL) > refuses missing, ambiguous, and wrong-kind live-execution declarations before provider-attempt writes",
  "CCC campaign provider controller (PostgreSQL) > refuses missing, foreign, or duplicate task protected-action IDs before provider-attempt writes",
];
// Wave 5 and Wave 6 execute the same importer test file. One shared closed
// inventory prevents either proof wrapper from silently drifting behind it.
const expectedWave6PrdImportPgNames = expectedWave5CoreImportNames;
const expectedWave6EngineDefaultNames = [
  "CCC campaign provider controller real-packet authority > selects the exact declared live-execution action without rewriting the unchanged sidecar",
  "CCC campaign provider controller > rechecks the immutable Git snapshot before asking core for a permit",
  "CCC campaign provider controller > does not call core when the Git recheck refuses",
  "CCC campaign provider controller > has no routeKind admission label on the engine pre-dispatch input",
  "CCC campaign provider controller > refuses an abort observed after Git recheck before core reservation",
  "CCC campaign provider controller > refuses persisted pi or cli routes for a workflow binding before lease or Git work",
  "CCC campaign provider controller > Task 6 P1 RED: refuses a persisted workflow extension mismatch before lease, Git, or provider permit work",
  "CCC campaign provider controller > refuses persisted Pi provider or model drift before lease or Git work",
  "CCC campaign provider controller > creates a frozen exact workflow binding and refuses a wrong dispatch turn or transport before core",
  "CCC campaign provider controller > preserves the actual matching Pi route into core",
  "CCC campaign provider controller > Task 6 P1 RED: refuses a reconciliation whose submitted turn is not the binding's sealed turn",
  "executor workflow-step model resolution > uses the project execution lane instead of the global default when the step has no override",
  "executor workflow-step model resolution > keeps step and task overrides ahead of execution-lane settings",
  "executor workflow-step model resolution > falls through the execution hierarchy without mixing partial pairs",
  "executor workflow-step model resolution > forces mock/scripted for workflow steps when test mode is active",
  "executor workflow-step model resolution > resolves workflow-step thinking level before task and settings defaults",
  "executor workflow-step model resolution > logs workflow-step model rows with thinking effort before override annotations",
  "executor workflow-step model resolution > settles a prompt-mode workflow step promptly when its execution signal aborts",
  "WorkflowGraphExecutor fan-out/join (U13) > Wave 4 RED: CCC frontier checkpoint failure does not traverse an authored failure effect",
  "WorkflowGraphExecutor fan-out/join (U13) > Wave 4 RED: CCC permanent node failure is classified once without authored failure traversal",
  "WorkflowGraphExecutor fan-out/join (U13) > Wave 4 RED: CCC transient node failure consumes the configured total attempt cap",
  "WorkflowGraphExecutor fan-out/join (U13) > Wave 4 RED: CCC transient terminal context carries a non-three consumed cap",
  "WorkflowGraphExecutor fan-out/join (U13) > Wave 4 RED: an aborted sibling cannot commit an async task projection from the normal handler path",
  "WorkflowGraphExecutor fan-out/join (U13) > Wave 4 RED: an aborted sibling cannot commit an async task projection from the plugin handler path",
  "WorkflowGraphExecutor fan-out/join (U13) > mode:all — both branches complete in any order, join fires once, advances to tail",
  "WorkflowGraphExecutor fan-out/join (U13) > mode:any with collect — first completion fires join; slower branch finishes without re-firing",
  "WorkflowGraphExecutor fan-out/join (U13) > mode:any with fail-fast — slower branch is aborted via signal",
  "WorkflowGraphExecutor fan-out/join (U13) > parent abort reaches a split branch and settles the join as failure",
  "WorkflowGraphExecutor fan-out/join (U13) > quorum(2) of 3 — join fires on the second completion",
  "WorkflowGraphExecutor fan-out/join (U13) > branch failure fail-fast — siblings aborted, join routes the failure edge",
  "WorkflowGraphExecutor fan-out/join (U13) > branch failure collect — all branches finish; join evaluates combined outcomes",
  "WorkflowGraphExecutor fan-out/join (U13) > Wave 4 RED: CCC persistence failure aborts a collect join before the next sibling effect",
  "WorkflowGraphExecutor fan-out/join (U13) > Wave 4 RED: CCC branches enter the split concurrently",
  "WorkflowGraphExecutor fan-out/join (U13) > crash mid-branch resume — completed branches' nodes are NOT re-run",
  "WorkflowGraphExecutor fan-out/join (U13) > card-position invariant — no column move occurs during the parallel window",
  "WorkflowGraphExecutor fan-out/join (U13) > semaphore bound — branches queue, never exceeding the limit (fake semaphore)",
  "WorkflowGraphExecutor fan-out/join (U13) > nested split resolves recursively",
  "WorkflowGraphExecutor fan-out/join (U13) > Wave 4 RED: nested CCC checkpoint failure bypasses inner and outer failure edges",
  "WorkflowGraphExecutor fan-out/join (U13) > Wave 4 RED: CCC permanent branch failure cannot be masked by a collect join",
  "WorkflowGraphExecutor fan-out/join (U13) > Wave 4 RED: exhausted CCC transient branch failure cannot be masked by a collect join",
  "WorkflowGraphExecutor fan-out/join (U13) > Wave 4 RED: a late CCC terminal checkpoint survives an ordinary fail-fast abort",
  "WorkflowGraphExecutor fan-out/join (U13) > reports live per-branch progress for the dashboard",
  "workflow malformed-verdict gate > parses structured, fenced, prose, and malformed verdict shapes at the imperative seam",
  "workflow malformed-verdict gate > keeps a blocking graph gate with a genuine REVISE verdict from passing",
  "workflow malformed-verdict gate > allows advisory malformed gates to record advisory_failure without blocking the graph",
  "workflow malformed-verdict gate > terminates a graph run as failed when a blocking gate returns REVISE",
  "workflow malformed-verdict gate > fails closed for fenced blocking CCC semantic task nodes with malformed workflow-step output",
  "workflow malformed-verdict gate > keeps generic unfenced prompt gates lenient on malformed workflow-step output",
  "workflow node-handler extensions > executes an extension-marked node and routes custom outcomes",
  "workflow node-handler extensions > preserves plugin-provided values for custom outcomes",
  "workflow node-handler extensions > degrades faulty node handlers before falling through to default handler",
  "workflow node-handler extensions > Task 4 maps resolver output to semantic task before plugin handling",
  "workflow node-handler extensions > rejects opaque host posture before plugin/default handler when provider resolution is available",
  "workflow node-handler extensions > passes through no-provider posture without provider capability and without provider-binding resolution",
  "workflow node-handler extensions > passes each scoped extension a sealed provider dispatch rooted in one resolver binding",
  "workflow node-handler extensions > refuses forged scoped-provider dispatch before raw provider preDispatch",
  "workflow node-handler extensions > delegates exact scoped-provider dispatch clones with the sealed descriptor",
  "workflow node-handler extensions > fails closed when a scoped-provider handler throws, without later scoped or default dispatch",
  "workflow node-handler extensions > fails closed before scoped or default dispatch when the provider-binding resolver seam is absent",
  "workflow node-handler extensions > fails closed when scoped-provider resolver returns undefined",
  "workflow node-handler extensions > fails closed when scoped-provider resolver returns a malformed binding",
  "processDueWorkflowWorkItem symbol lock renewal > Task 6 P1 RED: late processor registration observes an active hard-move intent and cancels before runtime",
  "processDueWorkflowWorkItem symbol lock renewal > late processor registration observes an explicit custom-column hard-cancel intent",
  "processDueWorkflowWorkItem symbol lock renewal > Task 6 P1 RED: fresh user pause returns before custody starts and cannot leak a delayed rejection",
  "processDueWorkflowWorkItem symbol lock renewal > Task 6 P1 RED: an already-aborted custody read consumes its delayed rejection",
  "processDueWorkflowWorkItem symbol lock renewal > Task 6 P2 RED: user cancellation aborts a hung best-effort summary after succeeded CAS",
  "processDueWorkflowWorkItem symbol lock renewal > Task 6 P1-A RED: user cancellation races a hung runtime task read and persists cancelled",
  "processDueWorkflowWorkItem symbol lock renewal > Task 6 P1 RED: cancellation after task-read fulfillment prevents runtime dispatch",
  "processDueWorkflowWorkItem symbol lock renewal > Task 6 P1-B RED: context-only campaign cancellation registers during classification and never runs either runtime",
  "processDueWorkflowWorkItem symbol lock renewal > Task 6 P1-A: user cancellation races a hung custody read and persists cancelled",
  "processDueWorkflowWorkItem symbol lock renewal > Task 6 P1-B RED: ordinary classification unregisters its provisional disposer before runWorkItem",
  "processDueWorkflowWorkItem symbol lock renewal > Task 6 P1 RED: null-custody ordinary work does not wait on campaign task reads",
  "processDueWorkflowWorkItem symbol lock renewal > Task 6 RED: required campaign cancellation registers before async custody, waits for cancelled CAS, and never dispatches",
  "processDueWorkflowWorkItem symbol lock renewal > Task 6 RED: a mismatched task move cannot abort an active campaign",
  "processDueWorkflowWorkItem symbol lock renewal > Task 6: a user cancellation during custody failure still persists cancelled",
  "processDueWorkflowWorkItem symbol lock renewal > Task 6: a user cancellation wins when lease loss aborted the controller first",
  "processDueWorkflowWorkItem symbol lock renewal > Task 6: a user pause observed after campaign claim prevents runtime dispatch",
  "processDueWorkflowWorkItem symbol lock renewal > persists the exact campaign blocker when full-graph execution requires a human decision",
  "processDueWorkflowWorkItem symbol lock renewal > Task 5 RED: passes an exact campaign candidate through to the lease claim",
  "processDueWorkflowWorkItem symbol lock renewal > renews a claimed mission symbol before its short admission lease can expire",
  "processDueWorkflowWorkItem symbol lock renewal > Task 3 RED: ordinary non-campaign work items do not renew workflow work-item leases",
  "processDueWorkflowWorkItem symbol lock renewal > Task 5 RED: campaign-required custody classification never falls through when recheck is missing",
  "processDueWorkflowWorkItem symbol lock renewal > Task 3 RED: an imported campaign work item fails closed when campaign custody lookup is unwired",
  "processDueWorkflowWorkItem symbol lock renewal > Wave 4 RED: rejects the public processor call when runtime and fallback terminal persistence both fail",
  "processDueWorkflowWorkItem symbol lock renewal > Wave 4 RED: rejects before claiming when native fallback terminal persistence is unavailable",
  "processDueWorkflowWorkItem symbol lock renewal > Task 3 RED: campaign processor enters the full graph instead of the addressed work-item node",
  "processDueWorkflowWorkItem symbol lock renewal > Task 3 RED: a first imported campaign claim promotes attempt zero before building its fence",
  "processDueWorkflowWorkItem symbol lock renewal > Task 3: attempt-zero promotion CAS failure never enters runtime or publishes success",
  "processDueWorkflowWorkItem symbol lock renewal > Task 3 RED: exact workflow lease renewal loss aborts the campaign run",
  "processDueWorkflowWorkItem symbol lock renewal > Task 3 RED: campaign work persists fenced failure before runtime when native work-item lease renewal is absent",
  "processDueWorkflowWorkItem symbol lock renewal > Task 3 RED: renewal loss after graph return refuses terminal success CAS",
  "processDueWorkflowWorkItem symbol lock renewal > Task 3 RED: work-item lease renewal is single-flight while runtime is active",
  "processDueWorkflowWorkItem symbol lock renewal > Task 3 RED: stale owner or attempt cannot publish campaign success",
  "processDueWorkflowWorkItem symbol lock renewal > Task 3 RED: campaign summary is written only after terminal CAS using a freshly reloaded task",
  "processDueWorkflowWorkItem symbol lock renewal > Task 3 RED: durable cancellation after runtime success is reported truthfully",
];
const expectedWave6CampaignExecProofGitNames = [
  "CCC campaign coarse pre-provider admission > refuses a task without an explicit imported-marker snapshot instead of treating absent custody as ordinary",
  "CCC campaign coarse pre-provider admission > permits an explicitly ordinary task without proof, approval, reservation, or provider effects",
  "CCC campaign coarse pre-provider admission > fails closed when an imported marker has no persisted campaign custody",
  "CCC campaign coarse pre-provider admission > fails closed when imported campaign custody lookup errors",
  "CCC campaign coarse pre-provider admission > keeps native and semantic task identities distinct and observes exact clean Git state before proof",
  "CCC campaign coarse pre-provider admission > fails closed after Git inspection for 'resolved target root mismatch' and before all later effects",
  "CCC campaign coarse pre-provider admission > fails closed after Git inspection for 'expected-base object mismatch' and before all later effects",
  "CCC campaign coarse pre-provider admission > fails closed after Git inspection for 'foreign HEAD outside the expected-bas…' and before all later effects",
  "CCC campaign coarse pre-provider admission > fails closed after Git inspection for 'empty noncanonical HEAD despite a cal…' and before all later effects",
  "CCC campaign coarse pre-provider admission > fails closed after Git inspection for 'noncanonical HEAD despite a caller-as…' and before all later effects",
  "CCC campaign coarse pre-provider admission > fails closed after Git inspection for 'dirty target repository' and before all later effects",
  "CCC campaign coarse pre-provider admission > fails closed after Git inspection for 'missing clean-state observation' and before all later effects",
  "CCC campaign coarse pre-provider admission > wraps a live-Git inspection failure as an admission refusal before proof, claim, reservation, or provider dispatch",
  "CCC campaign coarse pre-provider admission > wraps a null live-Git inspection result as an admission refusal before all later effects",
  "CCC campaign coarse pre-provider admission > uses context.route as the authority and refuses provider, model, or transport drift before all effects",
  "CCC campaign coarse pre-provider admission > derives protectedness only from the declared action and preserves the store's exact binding and lease",
  "CCC campaign coarse pre-provider admission > wraps a declared protected action target mismatch as action-drift before approval or transport effects",
  "CCC campaign coarse pre-provider admission > revalidates a protected claim's returned binding provenance before transport effects",
  "CCC campaign coarse pre-provider admission > refuses a protected claim with an empty noncanonical claim token",
  "CCC campaign coarse pre-provider admission > returns frozen protected authority snapshots that do not alias the claim fake's lease",
  "CCC campaign coarse pre-provider admission > admits proof before a protected claim and leaves reservation and provider dispatch to the transport boundary",
  "CCC campaign coarse pre-provider admission > returns a frozen unprotected authority binding whose canonical bytes cannot be mutated",
  "CCC campaign coarse pre-provider admission > returns a detached recursively frozen campaign context snapshot",
  "CCC campaign coarse pre-provider admission > passes a detached recursively frozen campaign context snapshot to proof callbacks",
  "CCC campaign coarse pre-provider admission > prevents callback-time source context mutation from changing admitted protected authority",
  "CCC campaign coarse pre-provider admission > honors abort during asynchronous proof before claim, reservation, or provider dispatch",
  "CCC campaign local Git observation > returns a frozen physical snapshot for a clean descendant checkout",
  "CCC campaign local Git observation > hashes tracked worktree blobs using the repository SHA-256 object format",
  "CCC campaign local Git observation > rejects noncanonical and missing expected base objects",
  "CCC campaign local Git observation > rejects a clean HEAD that does not descend from the expected base",
  "CCC campaign local Git observation > rejects foreign ancestry spoofed by an inherited Git graft file",
  "CCC campaign local Git observation > rejects a staged worktree",
  "CCC campaign local Git observation > rejects a unstaged worktree",
  "CCC campaign local Git observation > rejects a untracked worktree",
  "CCC campaign local Git observation > never admits dirty bytes through an ambient PATH Git that spoofs index and HEAD",
  "CCC campaign local Git observation > rejects staged index drift from modify even when worktree matches the index",
  "CCC campaign local Git observation > rejects staged index drift from add even when worktree matches the index",
  "CCC campaign local Git observation > rejects staged index drift from delete even when worktree matches the index",
  "CCC campaign local Git observation > rejects same-length tracked byte drift hidden by Git stat settings",
  "CCC campaign local Git observation > rejects a tracked FIFO without blocking for a writer",
  "CCC campaign local Git observation > rejects owner-execute drift hidden by a group-execute bit",
  "CCC campaign local Git observation > rejects a tracked regular file reached through an ignored intermediate symlink",
  "CCC campaign local Git observation > rejects an indexed symlink reached through an ignored intermediate symlink",
  "CCC campaign local Git observation > refuses tracked drift without executing a repository clean filter",
  "CCC campaign local Git observation > refuses a tracked submodule entry in the exact HEAD tree",
  "CCC campaign local Git observation > refuses hidden tracked changes under assume-unchanged",
  "CCC campaign local Git observation > refuses hidden tracked changes under skip-worktree",
  "CCC campaign local Git observation > refuses hidden tracked changes under both hidden flags",
  "CCC campaign local Git observation > binds linked worktrees to their exact physical root and git directory",
  "CCC campaign local Git observation > rejects a bare repository",
  "CCC campaign local Git observation > canonicalizes a symlink alias to the physical target root",
  "CCC campaign local Git observation > accepts a clean detached HEAD at the expected base",
  "CCC campaign local Git observation > scrubs inherited repository and config redirection",
  "CCC campaign local Git observation > ignores an invalid global Git config from ambient HOME",
  "CCC campaign local Git observation > fails closed when the trusted catalog has no absolute executable file",
  "CCC campaign local Git observation > controls the environment of the first Git process selected from the trusted catalog",
  "CCC campaign local Git observation > recheck uses the originally pinned physical Git binary after PATH changes",
  "CCC campaign local Git observation > bounds timeout and reaps a SIGTERM-ignoring selected executable tree",
  "CCC campaign local Git observation > rechecks the exact observed HEAD and refuses later descendant or dirty state",
  "CCC campaign local Git observation > recheck refuses a same-path whole-checkout replacement with identical clean Git bytes",
  "CCC campaign local Git observation > recheck refuses a same-path Git control-directory replacement",
  "CCC campaign local Git observation > honors an already-aborted signal",
  "CCC campaign local Git observation > refuses a missing promisor object without lazy-fetching or mutating the object store",
  "CCC native campaign proof admission > accepts the exact CCC lab kernel transaction declaration without executing it",
  "CCC native campaign proof admission > verifies the exact immutable binding self-check without executing a command",
  "CCC native campaign proof admission > refuses non-self-check declaration with blank positive oracle",
  "CCC native campaign proof admission > refuses non-self-check declaration with oversized positive oracle",
  "CCC native campaign proof admission > refuses non-self-check declaration with empty negative controls",
  "CCC native campaign proof admission > refuses non-self-check declaration with duplicate negative controls",
  "CCC native campaign proof admission > refuses non-self-check declaration with blank negative control",
  "CCC native campaign proof admission > refuses non-self-check declaration with oversized negative control",
  "CCC native campaign proof admission > deep-clones and freezes the proof payload while preserving the live abort signal",
  "CCC native campaign proof admission > refuses constant true command without executing a command",
  "CCC native campaign proof admission > refuses explicit exit-zero command without executing a command",
  "CCC native campaign proof admission > refuses echo-ok command without executing a command",
  "CCC native campaign proof admission > refuses shell-wrapped exit-zero command without executing a command",
  "CCC native campaign proof admission > refuses bash-wrapped true command without executing a command",
  "CCC native campaign proof admission > refuses absolute true command without executing a command",
  "CCC native campaign proof admission > refuses node explicit zero-exit command without executing a command",
  "CCC native campaign proof admission > refuses shell substitution without executing a command",
  "CCC native campaign proof admission > refuses output redirection without executing a command",
  "CCC native campaign proof admission > refuses environment assignment without executing a command",
  "CCC native campaign proof admission > refuses shell wrapper without executing a command",
  "CCC native campaign proof admission > refuses extra executable without executing a command",
  "CCC native campaign proof admission > refuses recursive removal without executing a command",
  "CCC native campaign proof admission > refuses curl executable without executing a command",
  "CCC native campaign proof admission > refuses python executable without executing a command",
  "CCC native campaign proof admission > refuses python3 executable without executing a command",
  "CCC native campaign proof admission > refuses git executable without executing a command",
  "CCC native campaign proof admission > refuses gh executable without executing a command",
  "CCC native campaign proof admission > refuses pnpm executable without executing a command",
  "CCC native campaign proof admission > refuses npm executable without executing a command",
  "CCC native campaign proof admission > refuses npx executable without executing a command",
  "CCC native campaign proof admission > refuses bun executable without executing a command",
  "CCC native campaign proof admission > refuses deno executable without executing a command",
  "CCC native campaign proof admission > refuses ruby executable without executing a command",
  "CCC native campaign proof admission > refuses perl executable without executing a command",
  "CCC native campaign proof admission > refuses java executable without executing a command",
  "CCC native campaign proof admission > refuses go executable without executing a command",
  "CCC native campaign proof admission > refuses cargo executable without executing a command",
  "CCC native campaign proof admission > refuses make executable without executing a command",
  "CCC native campaign proof admission > refuses oversized declaration without executing a command",
  "CCC native campaign proof admission > refuses generic positive oracle without executing a command",
  "CCC native campaign proof admission > refuses generic negative control without executing a command",
  "CCC native campaign proof admission > refuses duplicate requirement ids without executing a command",
  "CCC native campaign proof admission > refuses too many requirement ids without executing a command",
  "CCC native campaign proof admission > refuses oversized requirement id without executing a command",
  "CCC native campaign proof admission > refuses duplicate negative controls without executing a command",
  "CCC native campaign proof admission > refuses positive oracle repeated as a negative control without executing a command",
  "CCC native campaign proof admission > refuses stale proof-definition and admission-definition hashes",
  "CCC native campaign proof admission > refuses a stale evaluator input digest and echoes the current digest",
  "CCC native campaign proof admission > refuses a proof admission bound to a different fixed identity",
  "CCC native campaign proof admission > refuses arbitrary shell and prose declarations without executing them",
  "CCC native campaign proof admission > stops before evaluation when the invocation is already aborted",
  "CCC campaign proof workflow admission > exposes the native pre-node admission factory",
  "CCC campaign proof workflow admission > admits an exact node proof through the sealed native registry and writes a campaign receipt",
  "CCC campaign proof workflow admission > uses a distinct audit identity when the same proof is re-admitted after a later durable work-item transition",
  "CCC campaign proof workflow admission > admits every globally declared proof for the final proof-suite node",
  "CCC campaign proof workflow admission > admits a fixture with exact admission binding and sealed execution provenance",
  "CCC campaign proof workflow admission > admits distinct semantic and allocator-native task identities",
  "CCC campaign proof workflow admission > refuses before evaluator dispatch when execution origin differs from factory origin",
  "CCC campaign proof workflow admission > refuses before evaluator dispatch when execution semantic id differs from node config",
  "CCC campaign proof workflow admission > refuses before evaluator dispatch when semantic task id differs from execution semantic task",
  "CCC campaign proof workflow admission > refuses before evaluator dispatch when execution run id differs from fenced run id",
  "CCC campaign proof workflow admission > refuses before evaluator dispatch when visit identity nodeId differs from node id",
  "CCC campaign proof workflow admission > refuses before evaluator dispatch when execution visit identity is not the exact same visit identity",
  "CCC campaign proof workflow admission > refuses before evaluator dispatch when materialized visit identity drifts",
  "CCC campaign proof workflow admission > refuses missing runtime-safe admission binding before evaluator dispatch",
  "CCC campaign proof workflow admission > refuses a missing semantic task binding before loading campaign custody",
  "CCC campaign proof workflow admission > refuses duplicate task proof ids before evaluator dispatch",
  "CCC campaign proof workflow admission > audits and refuses a stale proof definition before evaluator dispatch",
  "CCC campaign proof workflow admission > audits and refuses host source drift before evaluator dispatch",
  "CCC campaign proof workflow admission > audits and refuses 'a failed outcome'",
  "CCC campaign proof workflow admission > audits and refuses 'a changed input digest'",
  "CCC campaign proof workflow admission > audits and refuses 'an incomplete result'",
  "CCC campaign proof workflow admission > audits and refuses an evaluator aborted while running",
  "CCC campaign proof workflow admission > blocks a passing evaluator when its native audit receipt cannot persist",
  "CCC campaign proof workflow admission > audits and refuses the native binding self-check before any task execution can follow",
  "CCC campaign proof workflow admission > does not require proofs for orchestration-only nodes",
];
const expectedWave6RealAcceptanceNames = [
  "Task 5 native CCC campaign Git landing > branches from merger-ai before legacy landing and binds the structured campaign marker",
  "Task 5 native CCC campaign Git landing > leaves ordinary merger behavior on the legacy branch",
  "Task 5 native CCC campaign Git landing > fails closed for imported campaign markers without persisted custody",
  "Task 5 native CCC campaign Git landing real PG/Git > refuses landing without exact passing proof receipts and preserves human approval",
  "Task 5 native CCC campaign Git landing real PG/Git > refuses a bundle-admitted source change outside every product route write root",
  "Task 5 native CCC campaign Git landing real PG/Git > refuses failed proof receipts before intent and leaves approval reusable",
  "Task 5 native CCC campaign Git landing real PG/Git > refuses dispatched-unknown proof receipts before intent and leaves approval reusable",
  "Task 5 native CCC campaign Git landing real PG/Git > refuses wrong-commit proof receipts before intent and leaves approval reusable",
  "Task 5 native CCC campaign Git landing real PG/Git > refuses wrong-tree proof receipts before intent and leaves approval reusable",
  "Task 5 native CCC campaign Git landing real PG/Git > refuses wrong-paths proof receipts before intent and leaves approval reusable",
  "Task 5 native CCC campaign Git landing real PG/Git > refuses otherwise-valid proof receipts with fake receipt work-item fence before intent and leaves approval reusable",
  "Task 5 native CCC campaign Git landing real PG/Git > refuses otherwise-valid proof receipts with stale receipt run fence before intent and leaves approval reusable",
  "Task 5 native CCC campaign Git landing real PG/Git > refuses otherwise-valid proof receipts with stale receipt attempt fence before intent and leaves approval reusable",
  "Task 5 native CCC campaign Git landing real PG/Git > refuses otherwise-valid proof receipts with incomplete imported workflow work item before intent and leaves approval reusable",
  "Task 5 native CCC campaign Git landing real PG/Git > refuses otherwise-valid proof receipts with failed imported workflow work item before intent and leaves approval reusable",
  "Task 5 native CCC campaign Git landing real PG/Git > refuses otherwise-valid proof receipts with premature succeeded imported workflow work item before intent and leaves approval reusable",
  "Task 5 native CCC campaign Git landing real PG/Git > keeps v1 landing fail-closed even with otherwise-valid synthetic proof receipts",
  "Task 5 native CCC campaign Git landing real PG/Git > refuses after deterministic objects before durable intent with ref unchanged and replayable commit identity",
  "Task 5 native CCC campaign Git landing real PG/Git > Task 5 RED: rolls back intent persistence failure before ref mutation and replays exact commit identity",
  "Task 5 native CCC campaign Git landing real PG/Git > Task 5 RED: reconciles interruption at each CAS boundary and consumes one exact approval",
  "Task 5 native CCC campaign Git landing real PG/Git > lands onto the exact clean target branch checked out at the canonical target root",
  "Task 5 native CCC campaign Git landing real PG/Git > recovers exact checked-out landing materialization without replaying an uncertain filesystem effect",
  "Task 5 native CCC campaign Git landing real PG/Git > requires manual recovery when a durable checkout receipt exists without its filesystem effect",
  "Task 5 native CCC campaign Git landing real PG/Git > refuses tracked dirty checked-out restart state without overwriting operator bytes",
  "Task 5 native CCC campaign Git landing real PG/Git > refuses untracked checked-out restart state without overwriting operator bytes",
  "Task 5 native CCC campaign Git landing real PG/Git > refuses mixed index/worktree checked-out restart state without overwriting operator bytes",
  "Task 5 native CCC campaign Git landing real PG/Git > recovers a checked-out target after CAS without repeating landing or approval",
  "Task 5 native CCC campaign Git landing real PG/Git > accepts a succeeded imported workflow work item only on durable terminal replay",
  "Task 5 native CCC campaign Git landing real PG/Git > Task 5 RED: refuses a foreign target ref race before CAS without terminal audit or approval consume",
  "Task 5 native CCC campaign Git landing real PG/Git > Task 5 RED: refuses a foreign target ref race before terminal audit or approval consume",
  "CCC campaign deterministic Git object primitives > prepares deterministic object-only squash output and replays the same commit",
  "CCC campaign deterministic Git object primitives > Task 5 RED: refuses drift dirty overlap and undeclared paths before mutation",
  "CCC campaign deterministic Git object primitives > refuses undeclared paths, bad admitted roots, symlinks, and gitlinks",
  "CCC campaign deterministic Git object primitives > refuses unsafe controlled Git environment overrides",
  "CCC campaign deterministic Git object primitives > rejects noncanonical identity and message fields before writing objects",
  "CCC campaign deterministic Git object primitives > refuses unrelated object drift before recheck or CAS",
  "CCC campaign deterministic Git object primitives > refuses packed unrelated object drift before recheck or CAS",
  "CCC campaign deterministic Git object primitives > performs exact update-ref CAS once, refuses stale CAS, and prepare accepts exact-new restart state",
  "CCC campaign deterministic Git object primitives > never executes repository hooks during checked-out prepare, materialization, or CAS",
  "CCC campaign deterministic Git object primitives > detects target checked out by a sibling worktree",
  "CCC campaign deterministic Git object primitives > refuses a target branch checked out by more than one sibling worktree",
  "Task 6 local CCC campaign acceptance (real PostgreSQL) > runs legacy v1 mixed-provider work but fails closed before Git landing without executed proof receipts",
  "Task 6 local CCC campaign acceptance (real PostgreSQL) > durably cancels an admitted scoped-provider branch through the real graph signal and never redispatches it after restart",
  "Task 5 RED: bootstraps one fixed proof host and one authoritative campaign runtime > Task 5 RED: mixed due queue preserves ordinary dispatch and claims campaign work only through the fenced processor",
  "Task 5 RED: bootstraps one fixed proof host and one authoritative campaign runtime > product v2 RED: the in-process campaign runtime prepares coding nodes before provider dispatch",
  "Task 5 RED: bootstraps one fixed proof host and one authoritative campaign runtime > product v2 RED: a restarted claim parks mutated imported IR before any graph or provider effect",
  "Task 5 RED: bootstraps one fixed proof host and one authoritative campaign runtime > keeps campaignRequired fail-closed after a real PostgreSQL claim when custody is absent",
  "Task 5 RED: bootstraps one fixed proof host and one authoritative campaign runtime > Task 6: public user cancellation durably parks a real campaign and restart cannot redispatch it",
  "Task 5 RED: bootstraps one fixed proof host and one authoritative campaign runtime > Task 6 P1 RED: a claim that lands during a public move is cancelled and cannot redispatch after restart",
  "Task 5 RED: bootstraps one fixed proof host and one authoritative campaign runtime > does not clear a rival lease when fixed proof-host bootstrap fails after selection",
  "Task 5 RED: bootstraps one fixed proof host and one authoritative campaign runtime > fails a still-unclaimed campaign item only after taking its exact bootstrap-refusal lease",
  "Task 5 RED: bootstraps one fixed proof host and one authoritative campaign runtime > Task 6 RED: recreates a real committed provider binding and holds its exact replay without another provider effect",
  "Task 5 RED: bootstraps one fixed proof host and one authoritative campaign runtime > Task 6 P1 RED: refuses a cross-wired same-task settlement before consuming its approval",
  "Task 6 real PostgreSQL: a user cancellation wins before a first-run CCC terminal result can publish work > keeps Todo/userPaused and no workflow task work across a fresh store restart",
];
const expectedWave6ProtectedActionCanonicalNames = [
  "ccc-prd protected-action canonical ordering > authors duplicate-free, canonically sorted task protected-action IDs from an unsorted proposal",
  "ccc-prd protected-action canonical ordering > refuses a hand-edited sidecar whose task protected-action IDs are not canonically sorted",
  "ccc-prd protected-action canonical ordering > refuses a hand-edited sidecar whose task protected-action IDs contain a duplicate",
  "ccc-prd protected-action canonical ordering > accepts a sidecar whose task protected-action IDs are already canonical",
  "ccc-prd protected-action canonical ordering > refuses a hand-edited sidecar whose task protected-action ID is not trimmed, even as an already-canonical single-entry list",
  "ccc-prd protected-action canonical ordering > refuses authoring a proposal whose task protected-action ID is not trimmed, even as an already-canonical single-entry list",
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

function assertMachineResultJson(json, command) {
  if (json.numFailedTests !== 0 || json.numPendingTests !== 0 || json.numTodoTests !== 0 || json.numPassedTests === 0) {
    throw new Error(`${command.id}: failed, skipped, pending, todo, or empty machine result`);
  }
  if (json.numPassedTests !== command.expectedNames.length) {
    throw new Error(`${command.id}: numPassedTests ${json.numPassedTests} does not match the closed expected-name inventory count ${command.expectedNames.length}`);
  }
  const assertions = json.testResults.flatMap((testResult) => testResult.assertionResults ?? []);
  assertClosedNamedResults(command.expectedNames, assertions, command.id);
  return assertions;
}

function assertMachineResultInventory(command) {
  if (command.machineResults !== true) {
    throw new Error(`${command.id ?? "command"}: machineResults is mandatory and must be true`);
  }
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
  for (const [label, command] of [
    ["machineResults:false", { machineResults: false, expectedNames: expected }],
    ["machineResults missing", { expectedNames: expected }],
  ]) {
    let rejected = false;
    try {
      assertMachineResultInventory(command);
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error(`policy-self-test:${label}: non-machine-result command was accepted`);
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

/*
FNXC:CccWave7MachineResultJson 2026-07-27-01:00:
The main flow's per-command machine-result validation is itself a correctness
boundary: a lying numPassedTests (miscounted or empty assertionResults while
claiming passes) must fail closed even when the closed-name checker alone
would not catch it, because assertClosedNamedResults only inspects the
assertions it is given — it cannot see whether the reporter's own summary
count agrees with them.
*/
function selfTestMachineResultJsonPolicy() {
  const command = { id: "policy-self-test", expectedNames: ["suite > required"] };
  const goodJson = {
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    numPassedTests: 1,
    testResults: [{ assertionResults: [{ ancestorTitles: ["suite"], title: "required", status: "passed" }] }],
  };
  assertMachineResultJson(goodJson, command);
  for (const [label, json] of [
    ["counter mismatch", { ...goodJson, numPassedTests: 2 }],
    ["vacuous assertionResults", { ...goodJson, testResults: [{ assertionResults: [] }] }],
    ["missing names", { ...goodJson, testResults: [{ assertionResults: [{ ancestorTitles: ["suite"], title: "other", status: "passed" }] }] }],
    ["failed tests present", { ...goodJson, numFailedTests: 1 }],
    ["pending tests present", { ...goodJson, numPendingTests: 1 }],
    ["todo tests present", { ...goodJson, numTodoTests: 1 }],
  ]) {
    let rejected = false;
    try { assertMachineResultJson(json, command); } catch { rejected = true; }
    if (!rejected) throw new Error(`policy-self-test:${label}: machine result json was accepted`);
  }
}
selfTestMachineResultJsonPolicy();

function assertSupervisorResult(result, commands) {
  if (result.stopError) throw new Error(`embedded PostgreSQL stop failed: ${result.stopError}`);
  if (result.interrupted) throw new Error(`supervisor interrupted by ${result.interrupted}`);
  if (Array.isArray(result.lifecycleErrors) && result.lifecycleErrors.length > 0) {
    throw new Error(`embedded PostgreSQL lifecycle reported errors: ${result.lifecycleErrors.join(" | ")}`);
  }
  const commandIds = new Set(commands.map((command) => command.id));
  const counts = new Map();
  for (const entry of result.results) {
    if (!commandIds.has(entry.id)) throw new Error(`unexpected command result: ${entry.id}`);
    counts.set(entry.id, (counts.get(entry.id) ?? 0) + 1);
  }
  for (const command of commands) {
    const count = counts.get(command.id) ?? 0;
    if (count === 0) throw new Error(`missing command result: ${command.id}`);
    if (count > 1) throw new Error(`duplicate command result: ${command.id}`);
  }
  for (const command of commands) {
    const outcome = result.results.find((entry) => entry.id === command.id);
    if (outcome.timedOut) throw new Error(`${command.id} exceeded its bounded timeout`);
    if (outcome.forcedKill) throw new Error(`${command.id} required a forced SIGKILL after graceful termination failed`);
    if (outcome.spawnError) throw new Error(`${command.id} spawn rejected: ${outcome.spawnError}`);
    if (outcome.signal) throw new Error(`${command.id} terminated by ${outcome.signal}`);
    if (outcome.code !== 0) throw new Error(`${command.id} exited ${outcome.code}`);
  }
}

function selfTestSupervisorFailurePolicy() {
  const commands = [{ id: "required" }];
  const passed = { results: [{ id: "required", code: 0, timedOut: false, forcedKill: false }], stopError: null, interrupted: null, lifecycleErrors: [] };
  assertSupervisorResult(passed, commands);
  for (const [label, result] of [
    ["nonzero exit", { ...passed, results: [{ id: "required", code: 1, timedOut: false, forcedKill: false }] }],
    ["timedOut", { ...passed, results: [{ id: "required", code: 1, timedOut: true }] }],
    ["spawnError", { ...passed, results: [{ id: "required", code: 1, spawnError: "injected rejection" }] }],
    ["signal", { ...passed, results: [{ id: "required", code: 0, timedOut: false, signal: "SIGTERM" }] }],
    ["stopError", { ...passed, stopError: "injected stop failure" }],
    ["interrupted", { ...passed, interrupted: "SIGTERM" }],
    ["forcedKill", { ...passed, results: [{ id: "required", code: 0, timedOut: false, forcedKill: true }] }],
    ["lifecycleErrors", { ...passed, lifecycleErrors: ["injected lifecycle error"] }],
    ["duplicate result rows", { ...passed, results: [...passed.results, { id: "required", code: 0, timedOut: false, forcedKill: false }] }],
    ["unknown result row", { ...passed, results: [...passed.results, { id: "unknown-command", code: 0, timedOut: false, forcedKill: false }] }],
    ["missing result row", { ...passed, results: [] }],
  ]) {
    let rejected = false;
    try { assertSupervisorResult(result, commands); } catch { rejected = true; }
    if (!rejected) throw new Error(`policy-self-test:${label}: supervisor failure was accepted`);
  }
}
selfTestSupervisorFailurePolicy();

const supervisorResultMarker = "CCC_PROOF_SUPERVISOR_RESULT=";
function extractSupervisorResultLine(rawStdout) {
  const lines = rawStdout.split("\n").filter((line) => line.startsWith(supervisorResultMarker));
  if (lines.length === 0) throw new Error("supervisor did not emit machine result");
  if (lines.length > 1) throw new Error(`supervisor emitted the machine-result marker ${lines.length} times; expected exactly once`);
  return lines[0];
}

/*
FNXC:CccWave7SupervisorMarker 2026-07-27-01:00:
The parent trusts the FIRST line starting with the machine-result marker.
A supervisor that (by bug or injected output) writes the marker more than
once must not silently let the parent pick the first one and move on —
exactly one marker line is the contract; more than one is a policy error.
*/
function selfTestSupervisorMarkerPolicy() {
  const line = extractSupervisorResultLine(`noise\n${supervisorResultMarker}{}\ntrailer`);
  if (line !== `${supervisorResultMarker}{}`) throw new Error("policy-self-test: marker extraction did not return the expected line");
  let rejected = false;
  try { extractSupervisorResultLine("no marker here"); } catch { rejected = true; }
  if (!rejected) throw new Error("policy-self-test:missing marker: supervisor marker policy was accepted");
  rejected = false;
  try { extractSupervisorResultLine(`${supervisorResultMarker}{}\n${supervisorResultMarker}{}`); } catch { rejected = true; }
  if (!rejected) throw new Error("policy-self-test:duplicate marker: supervisor marker policy was accepted");
}
selfTestSupervisorMarkerPolicy();

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
/*
FNXC:CccWave6Proof 2026-07-27-00:00:
Wave 6 is the consolidated Task 6 closed mapping: campaign approval/native/
provider-controller PostgreSQL persistence, the PRD importer's PostgreSQL/
filesystem unit of work, the engine-default workflow/provider-controller
contract group, campaign execution/proof/local-git, and the real-PostgreSQL/
real-Git acceptance suites. The core campaign PG group (3 files) and the PRD
importer PG file both omit --config vitest.pg.config.ts, mirroring the
already-accepted Wave 5 ccc-prd-core-import entry: probed directly against the
supervisor's embedded-PostgreSQL connection base, the plain form selects and
passes every test (69/69 core campaign PG, twice; 46/46 importer PG). The
core campaign PG group is only 3 files, so vitest's fork fan-out is bounded by
file count regardless of the CPU-derived worker cap and cannot reproduce the
DDL-oversubscription failure documented in vitest.pg.config.ts (which guards a
23-file, 6-fork scenario against one shared PostgreSQL).
*/
const wave6Commands = [
  {
    id: "ccc-campaign-pg",
    command: ["pnpm", "--filter", "@fusion/core", "exec", "vitest", "run", "src/__tests__/postgres/ccc-campaign-approval.pg.test.ts", "src/__tests__/postgres/ccc-campaign-native.pg.test.ts", "src/__tests__/postgres/ccc-campaign-provider-controller.pg.test.ts", "--silent=passed-only", "--reporter=dot"],
    vitestArgs: ["--reporter=json"],
    expectedNames: expectedWave6CampaignPgNames,
    machineResults: true,
  },
  {
    id: "ccc-prd-import-pg",
    command: ["pnpm", "--filter", "@fusion/core", "exec", "vitest", "run", "src/__tests__/postgres/ccc-prd-import.pg.test.ts", "--silent=passed-only", "--reporter=dot"],
    vitestArgs: ["--reporter=json"],
    expectedNames: expectedWave6PrdImportPgNames,
    machineResults: true,
  },
  {
    id: "engine-workflow-provider-controller",
    command: ["pnpm", "--filter", "@fusion/engine", "exec", "vitest", "run", "src/__tests__/workflow-node-handler-extensions.test.ts", "src/__tests__/workflow-malformed-verdict-gate.test.ts", "src/__tests__/executor-workflow-step-model.test.ts", "src/__tests__/workflow-graph-fanout.test.ts", "src/__tests__/workflow-work-processor.test.ts", "src/__tests__/ccc-campaign-provider-controller.test.ts", "src/__tests__/ccc-campaign-provider-controller.real-packet.test.ts", "--project=engine-default", "--silent=passed-only", "--reporter=dot"],
    vitestArgs: ["--reporter=json"],
    expectedNames: expectedWave6EngineDefaultNames,
    machineResults: true,
  },
  {
    id: "campaign-exec-proof-git",
    command: ["pnpm", "--filter", "@fusion/engine", "exec", "vitest", "run", "src/__tests__/ccc-campaign-execution.test.ts", "src/__tests__/ccc-campaign-proof-admission.test.ts", "src/__tests__/ccc-campaign-proof-workflow.test.ts", "src/__tests__/ccc-campaign-local-git.real-git.test.ts", "--project=engine-default", "--silent=passed-only", "--reporter=dot"],
    vitestArgs: ["--reporter=json"],
    expectedNames: expectedWave6CampaignExecProofGitNames,
    machineResults: true,
  },
  {
    id: "campaign-real-pg-git-acceptance",
    command: ["pnpm", "--filter", "@fusion/engine", "exec", "vitest", "run", "src/__tests__/ccc-campaign-runtime-bootstrap.real-pg.test.ts", "src/__tests__/ccc-campaign-git-integration.real-pg.test.ts", "src/__tests__/ccc-campaign-local-acceptance.real-pg.test.ts", "--project=engine-default", "--silent=passed-only", "--reporter=dot"],
    vitestArgs: ["--reporter=json"],
    expectedNames: expectedWave6RealAcceptanceNames,
    machineResults: true,
  },
  /*
  FNXC:CccWave9ProtectedActionCanonical 2026-07-27-00:00:
  Task 9 fold-in of the accepted P2-C disposition: the canonical
  protected-action-ID slice (authoring.ts/compiler.ts, committed at
  346f42876) shipped without a Wave 6 mapping entry. Added additively as a
  sixth command — the five existing Wave 6 commands and their frozen Task 6
  name arrays above are untouched.
  */
  {
    id: "ccc-prd-protected-action-canonical",
    command: ["pnpm", "--filter", "@fusion/engine", "exec", "vitest", "run", "src/__tests__/ccc-prd-protected-action-canonical.test.ts", "--project=engine-default", "--silent=passed-only", "--reporter=dot"],
    vitestArgs: ["--reporter=json"],
    expectedNames: expectedWave6ProtectedActionCanonicalNames,
    machineResults: true,
  },
];
const commands = selectedWave === 6 ? wave6Commands : selectedWave === 5 ? wave5Commands : wave4Commands;
for (const command of commands) assertMachineResultInventory(command);

function positiveBudget(name, fallback) {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive finite millisecond budget`);
  return Math.floor(value);
}

/*
FNXC:CccWave6ChildTimeout 2026-07-27-00:00:
Wave 6's real-PostgreSQL/real-Git acceptance group boots an embedded
PostgreSQL cold inside the child alongside real Git object work; the Wave 4/5
120s default has headroom on this box (group 5 alone measured well under a
minute against the disposable proof service) but embedded-PG cold boot under
contention can run slower, so the W6 default is raised to 240s. This does not
loosen the Wave 4/5 defaults or budgets.
*/
const budgetPrefix = selectedWave === 6 ? "CCC_W6" : selectedWave === 5 ? "CCC_W5" : "CCC_W4";
const childTimeoutMsDefault = selectedWave === 6 ? 240_000 : 120_000;
const childTimeoutMs = positiveBudget(`${budgetPrefix}_CHILD_TIMEOUT_MS`, childTimeoutMsDefault);
const childTerminateGraceMs = positiveBudget(`${budgetPrefix}_CHILD_TERMINATE_GRACE_MS`, 2_000);
const postgresStopBudgetMs = positiveBudget(`${budgetPrefix}_PG_STOP_TIMEOUT_MS`, 10_000);
const parentShutdownMarginMs = positiveBudget(`${budgetPrefix}_PARENT_SHUTDOWN_MARGIN_MS`, 3_000);
const proofDatabase = `ccc_wave${selectedWave}_proof`;

const supervisor = `
  import { EmbeddedPostgresLifecycle } from ${JSON.stringify(join(repoRoot, "packages/core/src/postgres/embedded-lifecycle.ts"))};
  import { spawn } from "node:child_process";
  import { writeSync } from "node:fs";
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
  const supervisorExitCode = stopError || interrupted || results.some((result) => result.code !== 0) || results.length !== commands.length ? 1 : 0;
  writeSync(1, "CCC_PROOF_SUPERVISOR_RESULT=" + JSON.stringify({ results, database: process.env.CCC_PROOF_DATABASE, stopError, lifecycleErrors, interrupted }) + "\\n");
  // embedded-postgres@15 registers a natural-beforeExit hook that can invoke
  // its async callback without a callable done under Node 24 after an
  // already-completed explicit stop. Exit explicitly only after the durable
  // supervisor result is synchronously written; PostgreSQL ownership has
  // already been settled in the finally block above.
  process.exit(supervisorExitCode);
`;

function redact(text) {
  return String(text)
    .replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, "[redacted-postgresql-url]")
    .replace(/password=[^\s&]+/gi, "password=[redacted]");
}

/*
FNXC:CccWave7GitProvenance 2026-07-27-01:30:
Provenance must attest the exact bytes the supervisor is about to test, not
whatever HEAD happens to be after the run finishes — capturing it post-hoc
with the ambient environment let a dirty-tree run silently report as if it
proved the frozen committed tree. Capture gitHead/gitTree and working-tree
cleanliness BEFORE spawning the supervisor child, using a scrubbed
PATH/HOME-only env (no inherited GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE) and a
bounded timeout so a hung git cannot block the runner. Capture failures and a
dirty tree are both recorded as explicit, honest report fields rather than
causing the proof to fail closed — developers legitimately run waves on dirty
trees; the report must just tell the truth about which tree was proved.
*/
const gitProvenanceEnv = { PATH: process.env.PATH, HOME: process.env.HOME };
function runGitProvenance(args) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", env: gitProvenanceEnv, timeout: 10_000 }).trim();
}
function captureGitRevision(ref) {
  try {
    return runGitProvenance(["rev-parse", ref]);
  } catch {
    return null;
  }
}
function captureWorkingTreeStatus() {
  try {
    const output = runGitProvenance(["status", "--porcelain", "--untracked-files=no"]);
    const dirtyPaths = output.length === 0 ? [] : output.split("\n").filter((line) => line.length > 0);
    return { workingTreeDirty: dirtyPaths.length > 0, trackedDirtyPaths: dirtyPaths.length };
  } catch {
    return { workingTreeDirty: null, trackedDirtyPaths: null };
  }
}
const preRunGitHead = captureGitRevision("HEAD");
const preRunGitTree = captureGitRevision("HEAD^{tree}");
const preRunWorkingTreeStatus = captureWorkingTreeStatus();

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
let supervisorResult = { results: [], database: proofDatabase };
let policyError;
const perCommandResults = [];
try {
  if (supervisorSpawnError) throw new Error(`supervisor spawn rejected: ${supervisorSpawnError}`);
  const supervisorLine = extractSupervisorResultLine(stdout);
  supervisorResult = JSON.parse(supervisorLine.slice(supervisorResultMarker.length));
  if (forwardedSignal) throw new Error(`proof runner interrupted by ${forwardedSignal}`);
  assertSupervisorResult(supervisorResult, commands);
  for (const command of commands) {
    // Recompute the machine-result path from the trusted resultRoot/command.id
    // instead of trusting result.outputFile from the supervisor's own JSON.
    const outputFile = join(resultRoot, `${command.id}.json`);
    const json = JSON.parse(await readFile(outputFile, "utf8"));
    assertMachineResultJson(json, command);
    perCommandResults.push({ id: command.id, passed: json.numPassedTests, expected: command.expectedNames.length });
  }
} catch (error) {
  policyError = redact(error instanceof Error ? error.message : String(error));
}

const passed = exitCode === 0 && policyError === undefined;

/*
FNXC:CccWave7ProofEvidence 2026-07-27-00:00:
Task 7 hardening: bind the report to the exact source state it proved
(gitHead/gitTree/workingTreeDirty, captured pre-run — see
FNXC:CccWave7GitProvenance) and the exact dependency manifests in effect
(manifestHashes), without adding a dependency — node:crypto covers the
latter. Manifest hashing is best-effort: a hash failure must not mask a real
policyError, so failures here are recorded as null rather than thrown.
*/
async function hashManifest(relativePath) {
  try {
    const bytes = await readFile(join(repoRoot, relativePath));
    return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  } catch {
    return null;
  }
}
const manifestHashes = {
  "package.json": await hashManifest("package.json"),
  "pnpm-workspace.yaml": await hashManifest("pnpm-workspace.yaml"),
  "pnpm-lock.yaml": await hashManifest("pnpm-lock.yaml"),
};

const report = {
  wave: selectedWave,
  passed,
  commands: supervisorResult.results.map(({ outputFile, ...result }) => Object.fromEntries(
    Object.entries(result).map(([key, value]) => [key, typeof value === "string" ? redact(value) : value]),
  )),
  policyError: policyError ?? null,
  gitHead: preRunGitHead,
  gitTree: preRunGitTree,
  workingTreeDirty: preRunWorkingTreeStatus.workingTreeDirty,
  trackedDirtyPaths: preRunWorkingTreeStatus.trackedDirtyPaths,
  manifestHashes,
  perCommand: perCommandResults,
  cleanupState: { state: passed ? "removed-on-pass" : "preserved-on-failure", proofRoot },
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
