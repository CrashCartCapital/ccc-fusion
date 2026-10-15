/**
 * FNXC:CccPlanningHost 2026-10-14-22:17 (card H1):
 * The native host for a request-to-code planning run (CONTRACT-v3.4 section 2.16, D1-D3, D40, D44, D45). These cases
 * drive the real work processor, the real WorkflowTaskRuntime and graph executor, and the real stage handler against an
 * in-memory work item and an in-memory L1 ledger that keeps L1's transition rules (allowed pairs, the pending-control
 * predicate, cancellation only through completion). Every refusal is paired with a control on the same fixture.
 *
 * Non-vacuity: before H1 the processor sends a planning item down the campaign path, which fails with "workflow
 * required campaign custody is missing"; the first case asserts the stages ran and that message is absent, and the
 * campaign-custody control shows the same fixture still produces it when it is claimed under campaign custody.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  buildCccPlanningWorkflowIr,
  canonicalCccPrdJson,
  CCC_PLANNING_IR_STAGES,
  CccPlanningRefusal,
  cccPlanningTransitionAllowed,
  cccPlanningWorkflowIrHash,
  readCccRunningRuntimeDistManifest,
  registerCccRunningRuntimeDistManifest,
  type CccPlanningIrStageId,
  type CccPlanningMode,
  type CccPlanningRunCustody,
  type CccPlanningRunState,
  type CccPlanningWorkItemFence,
  type WorkflowIr,
} from "@fusion/core";
import { CccProviderRouteReceiptError } from "../pi.js";
import { processDueWorkflowWorkItem } from "../workflow-work-processor.js";
import { CCC_PLANNING_HOLD_CONTEXT_KEY, WorkflowTaskRuntime } from "../workflow-task-runtime.js";
import { createCccPlanningDescendantRegistry, createCccPlanningStageHandler } from "../ccc-planning/controller.js";
import {
  computeCccRuntimeDistManifestSha256,
  registerCccRunningRuntimeAtEngineStart,
  resolveCccRuntimeDistRoot,
} from "../ccc-planning/runtime-digest.js";
import { InProcessRuntime } from "../runtimes/in-process-runtime.js";

/*
FNXC:CccPlanningHost 2026-10-14-23:24 (W3 repair 1):
The runtime-digest module is wrapped in pass-through spies so the engine-start case can see that start() resolves its
own dist root and registers it. A source run resolves no dist and registers nothing, so the call itself is the only
observable; every other case still runs the real functions.
*/
vi.mock("../ccc-planning/runtime-digest.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ccc-planning/runtime-digest.js")>();
  return {
    ...actual,
    resolveCccRuntimeDistRoot: vi.fn(actual.resolveCccRuntimeDistRoot),
    registerCccRunningRuntimeAtEngineStart: vi.fn(actual.registerCccRunningRuntimeAtEngineStart),
  };
});
import type {
  CccPlanningArtifactPort,
  CccPlanningLedgerPort,
  CccPlanningSession,
  CccPlanningSessionFactory,
  CccPlanningStageContext,
  CccPlanningStageFn,
} from "../ccc-planning/ports.js";

const RUN_ID = "ccc-plan:0123456789abcdef01234567";
const TASK_ID = "FN-H1-PLAN";
const WORK_ITEM_ID = "wi-h1-plan";
const WORKFLOW_ID = "ccc-plan-0123456789abcdef01234567--workflow";
const LEASE_OWNER = "h1-engine";
const NOW = "2026-10-14T00:00:00.000Z";
const FAR = "2999-01-01T00:00:00.000Z";
const RUNTIME_DIGEST = "d".repeat(64);
const OTHER_DIGEST = "e".repeat(64);
/** E2-14: the K1-pinned workflow IR digests at INT-2d. H1 verifies them and never edits the IR. */
const PINNED_IR_DIGEST: Readonly<Record<CccPlanningMode, string>> = {
  build: "6e7b82c714a4f7c708c5154786d1ea3d49fa3bcc065e4fe58b394621ea2f63ba",
  spec: "1e4bd58180384c717ab70a46cd85ba927f6faa4afb4543a02f5ff8108e9bdb58",
};

type StateEvent = Readonly<{ from: CccPlanningRunState; to: CccPlanningRunState; stateCode: string | null }>;
type Unreconciled = Readonly<{ lineageId: string; attemptKey: string; dispatchedAt: string }>;
type WorkItem = {
  id: string; runId: string; taskId: string; nodeId: string; kind: "task"; state: string; attempt: number;
  leaseOwner: string | null; leaseExpiresAt: string | null; lastError: string | null; blockedReason: string | null;
  retryAfter: string | null; waitReason: string | null; irHash: string; stableWorkflowRunId: string;
  createdAt: string; updatedAt: string;
};
type TransitionPatch = {
  expectedState?: string; expectedLeaseOwner?: string | null; expectedAttempt?: number; attempt?: number;
  leaseOwner?: string | null; leaseExpiresAt?: string | null; lastError?: string | null; blockedReason?: string | null;
};

const TERMINAL_WORK_ITEM_STATES = new Set(["succeeded", "failed", "cancelled", "exhausted"]);

function createWorld(options: {
  mode?: CccPlanningMode; state?: CccPlanningRunState; runtimeDigest?: string; storedIr?: WorkflowIr;
  workItemIrHash?: string; unreconciled?: readonly Unreconciled[];
} = {}) {
  const mode = options.mode ?? "build";
  const pinned = buildCccPlanningWorkflowIr(mode);
  const storedIr = options.storedIr ?? pinned;
  const run = {
    state: options.state ?? "running" as CccPlanningRunState,
    stateCode: null as string | null,
    controlRequest: null as null | "pause" | "cancel",
    unreconciled: [...(options.unreconciled ?? [])] as Unreconciled[],
    committed: new Set<string>(),
    runtimeDigest: options.runtimeDigest ?? RUNTIME_DIGEST,
  };
  const stateEvents: StateEvent[] = [];
  const order: string[] = [];
  const workItem: WorkItem = {
    id: WORK_ITEM_ID, runId: RUN_ID, taskId: TASK_ID, nodeId: "preflight", kind: "task", state: "runnable", attempt: 0,
    leaseOwner: null, leaseExpiresAt: null, lastError: null, blockedReason: null, retryAfter: null, waitReason: null,
    irHash: options.workItemIrHash ?? cccPlanningWorkflowIrHash(pinned), stableWorkflowRunId: RUN_ID,
    createdAt: NOW, updatedAt: NOW,
  };
  let leaseLost = false;
  const claimable = () => workItem.state === "runnable" || workItem.state === "retrying"
    || (workItem.state === "running" && leaseLost);
  const leaseLive = () => workItem.state === "running" && !leaseLost;

  const custody = (): CccPlanningRunCustody => ({
    kind: "planning", projectId: "h1-project", runId: RUN_ID, planningTaskId: TASK_ID, revision: 1, state: run.state, mode,
    budgetProfile: "standard", deadlineAt: FAR, grantDigest: "a".repeat(64), controlSeq: 0, importId: null,
    runtimeDistManifestSha256: run.runtimeDigest,
  });
  const status = () => ({
    schema: "ccc-planning.run-status.v1", runId: RUN_ID, projectId: "h1-project", planningTaskId: TASK_ID, mode,
    state: run.state, stateCode: run.stateCode, revision: 1, controlSeq: 0,
    pendingControl: run.controlRequest === null ? null : { request: run.controlRequest, revision: 1, requestedAt: NOW },
    stages: CCC_PLANNING_IR_STAGES.filter((stageId) => mode === "build" || stageId !== "import").map((stageId) => ({
      stageId, status: run.committed.has(stageId) ? "committed" : "pending", artifactKeys: [],
    })),
    unreconciled: [...run.unreconciled],
  });
  const assertFence = (fence: CccPlanningWorkItemFence) => {
    if (!leaseLive() || fence.kind !== "planning" || fence.workItemId !== WORK_ITEM_ID || fence.runId !== RUN_ID
      || fence.originTaskId !== TASK_ID || fence.leaseOwner !== workItem.leaseOwner || fence.attempt !== workItem.attempt) {
      throw new CccPlanningRefusal("CCC_PLANNING_FENCE_STALE", "fence is not current", "fence");
    }
  };
  /** L1's move rules: allowed pairs, CAS on the source, the pending-control predicate, cancelled only by completion. */
  const move = (from: CccPlanningRunState, to: CccPlanningRunState, stateCode: string | null) => {
    if (to === "cancelled" || from === to || !cccPlanningTransitionAllowed(from, to)) {
      throw new CccPlanningRefusal("CCC_PLANNING_STATE_TRANSITION_REFUSED", `${from} -> ${to}`, "state");
    }
    if (run.state !== from) throw new CccPlanningRefusal("CCC_PLANNING_STATE_TRANSITION_REFUSED", `run is ${run.state}`, "from");
    if (run.controlRequest !== null && to !== "cancelling" && !(to === "paused" && run.controlRequest === "pause")) {
      throw new CccPlanningRefusal("CCC_PLANNING_CONTROL_PENDING", `pending ${run.controlRequest}`, "state");
    }
    run.state = to;
    run.stateCode = stateCode;
    if (to === "paused" || to === "cancelling") run.controlRequest = null;
    stateEvents.push({ from, to, stateCode });
  };
  const ledger = {
    getCccPlanningRunForTask: vi.fn(async (taskId: string) => (taskId === TASK_ID ? custody() : null)),
    inspectCccPlanningRun: vi.fn(async (runId: string) => {
      if (runId !== RUN_ID) throw new CccPlanningRefusal("CCC_PLANNING_RUN_NOT_FOUND", runId, "runId");
      return status();
    }),
    transitionCccPlanningRunState: vi.fn(async (i: { runId: string; from: CccPlanningRunState; to: CccPlanningRunState;
      stateCode: string | null; fence: CccPlanningWorkItemFence | null }) => {
      if (i.fence !== null) assertFence(i.fence);
      move(i.from, i.to, i.stateCode);
      return custody();
    }),
    completeCccPlanningCancellation: vi.fn(async (_i: { runId: string }) => {
      if (run.state === "cancelled") return { completed: true };
      if (run.state !== "cancelling" || leaseLive() || run.unreconciled.length > 0) return { completed: false };
      if (!TERMINAL_WORK_ITEM_STATES.has(workItem.state)) {
        Object.assign(workItem, { state: "cancelled", leaseOwner: null, leaseExpiresAt: null });
      }
      stateEvents.push({ from: "cancelling", to: "cancelled", stateCode: "CCC_PLANNING_CANCELLED" });
      run.state = "cancelled";
      run.stateCode = "CCC_PLANNING_CANCELLED";
      return { completed: true };
    }),
  };
  const ledgerPort = new Proxy(ledger, {
    get(target, key) {
      if (key in target) return target[key as keyof typeof target];
      return () => {
        throw new Error(`ledger.${String(key)} is not part of the H1 host path`);
      };
    },
  }) as unknown as CccPlanningLedgerPort;
  const store = {
    listDueWorkflowWorkItems: vi.fn(async () => (claimable() ? [{ ...workItem }] : [])),
    getWorkflowWorkItem: vi.fn(async () => ({ ...workItem })),
    acquireWorkflowWorkItemLease: vi.fn(async (_id: string, owner: string, opts: { expectedAttempt?: number }) => {
      if (!claimable()) return null;
      if (opts.expectedAttempt !== undefined && opts.expectedAttempt !== workItem.attempt) return null;
      Object.assign(workItem, { state: "running", leaseOwner: owner, leaseExpiresAt: FAR });
      leaseLost = false;
      return { ...workItem };
    }),
    transitionWorkflowWorkItem: vi.fn(async (_id: string, state: string, patch: TransitionPatch = {}) => {
      if ((patch.expectedState !== undefined && patch.expectedState !== workItem.state)
        || (patch.expectedLeaseOwner !== undefined && patch.expectedLeaseOwner !== workItem.leaseOwner)
        || (patch.expectedAttempt !== undefined && patch.expectedAttempt !== workItem.attempt)) {
        throw new Error(`Workflow work item ${WORK_ITEM_ID} transition precondition failed`);
      }
      if (state === "runnable") order.push("release");
      Object.assign(workItem, {
        state,
        attempt: patch.attempt ?? workItem.attempt,
        leaseOwner: patch.leaseOwner === undefined ? workItem.leaseOwner : patch.leaseOwner,
        leaseExpiresAt: patch.leaseExpiresAt === undefined ? workItem.leaseExpiresAt : patch.leaseExpiresAt,
        lastError: patch.lastError === undefined ? workItem.lastError : patch.lastError,
        blockedReason: patch.blockedReason === undefined ? workItem.blockedReason : patch.blockedReason,
      });
      return { ...workItem };
    }),
    renewWorkflowWorkItemLease: vi.fn(async (_id: string, owner: string, attempt: number) => (
      leaseLive() && workItem.leaseOwner === owner && workItem.attempt === attempt ? { ...workItem } : null
    )),
    getTask: vi.fn(async (id: string) => ({
      id, title: "planning task", description: "request-to-code planning", lineageId: RUN_ID, paused: true,
      userPaused: false, column: "todo", customFields: {}, log: [], steps: [],
    })),
    getCccCampaignContextForTask: vi.fn(async () => null),
    getCccPlanningRunForTask: (taskId: string) => ledger.getCccPlanningRunForTask(taskId),
    // FNXC:CccPlanningHost 2026-10-14-23:24: the processor's own L1 reads and moves (W3 repair 1) go to the same ledger.
    inspectCccPlanningRun: (runId: string) => ledger.inspectCccPlanningRun(runId),
    transitionCccPlanningRunState: (i: Parameters<typeof ledger.transitionCccPlanningRunState>[0]) =>
      ledger.transitionCccPlanningRunState(i),
    completeCccPlanningCancellation: async (runId: string) => {
      order.push("completeCancellation");
      return ledger.completeCccPlanningCancellation({ runId });
    },
    assertCccCampaignWorkflowLeaseFence: vi.fn(async (input: { workItemId: string; originTaskId: string;
      leaseOwner: string; attempt: number; runId: string }) => {
      if (!leaseLive() || input.workItemId !== WORK_ITEM_ID || input.originTaskId !== TASK_ID || input.runId !== RUN_ID
        || input.leaseOwner !== workItem.leaseOwner || input.attempt !== workItem.attempt) {
        throw new Error("lease fence refused");
      }
    }),
    getTaskWorkflowSelection: () => ({ workflowId: WORKFLOW_ID, stepIds: [] }),
    getWorkflowDefinition: async () => ({ id: WORKFLOW_ID, name: storedIr.name, ir: storedIr }),
    logEntry: vi.fn(async () => undefined),
  };
  return {
    run, workItem, stateEvents, order, store, ledger, ledgerPort,
    loseLease: () => { leaseLost = true; },
  };
}

type World = ReturnType<typeof createWorld>;
type StageCall = Readonly<{ stageId: CccPlanningIrStageId; fence: CccPlanningWorkItemFence; state: CccPlanningRunState }>;

/*
FNXC:CccPlanningHost 2026-10-15-00:04 (W3 repair 2, E14 item 2):
The fake stages end the run the way the real ones do: `specready` moves a running run to spec_ready through the bound
ledger under the stage's fence (PRD section 9, D53), and the host now concludes a run that is still admitted or running
when the workflow completes instead of succeeding the item behind it.
*/
function recordingStages(world: World, overrides: Partial<Record<CccPlanningIrStageId, CccPlanningStageFn>> = {}) {
  const calls: StageCall[] = [];
  const stages = Object.fromEntries(CCC_PLANNING_IR_STAGES.map((stageId) => [stageId, async (ctx: CccPlanningStageContext) => {
    calls.push({ stageId: ctx.stageId, fence: ctx.fence, state: ctx.run.state });
    const override = overrides[stageId];
    if (override) return override(ctx);
    if (stageId === "specready" && ctx.run.state === "running") {
      await ctx.ledger.transitionCccPlanningRunState({
        runId: ctx.run.runId, from: "running", to: "spec_ready", stateCode: null, fence: ctx.fence,
      });
    }
    world.run.committed.add(stageId);
    return { kind: "committed", artifactKeys: [`cccplan-r001-${stageId}-x-v01`] };
  }])) as Record<CccPlanningIrStageId, CccPlanningStageFn>;
  return { stages, calls };
}

const unusedArtifacts = new Proxy({}, {
  get: (_target, key) => () => {
    throw new Error(`artifacts.${String(key)} is not part of the H1 host path`);
  },
}) as CccPlanningArtifactPort;

function unusedSessions(): CccPlanningSessionFactory & { open: ReturnType<typeof vi.fn> } {
  return { open: vi.fn(async () => { throw new Error("no session is expected"); }) };
}

function planningRuntime(world: World, stages: Record<CccPlanningIrStageId, CccPlanningStageFn>,
  sessions: CccPlanningSessionFactory = unusedSessions()): WorkflowTaskRuntime {
  return new WorkflowTaskRuntime({
    store: world.store as never,
    primitives: {} as never,
    runCustomNode: async () => ({ outcome: "success" }),
    runCccPlanningStage: createCccPlanningStageHandler({
      stages, ledger: world.ledgerPort, artifacts: unusedArtifacts, sessions,
    }),
  });
}

function processPlanning(world: World, runtime: WorkflowTaskRuntime,
  extra: Partial<Parameters<typeof processDueWorkflowWorkItem>[3]> = {}) {
  return processDueWorkflowWorkItem(world.store as never, runtime, undefined, {
    leaseOwner: LEASE_OWNER, leaseDurationMs: 60_000, custody: "planning", ...extra,
  });
}

function openPlanningSession(ctx: CccPlanningStageContext, attempt: number): Promise<CccPlanningSession> {
  return ctx.sessions.open({
    run: ctx.run, stageId: ctx.stageId, roleId: "preflight-writer", lineageId: `${ctx.stageId}:preflight-writer`,
    nodeAttemptOrdinal: 1, phase: "planning", fence: ctx.fence, inputs: [], readSnapshot: { kind: "admitted-base" },
    preflight: true, signal: ctx.signal,
  }).then((session) => {
    void attempt;
    return session;
  });
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ccc planning host before a runtime is registered (D44)", () => {
  it("H1 RED 6b: an unregistered runtime digest parks an admitted run in blocked_prerequisite before any stage", async () => {
    expect(readCccRunningRuntimeDistManifest()).toBeNull();
    const world = createWorld({ state: "admitted" });
    const { stages, calls } = recordingStages(world);

    await processPlanning(world, planningRuntime(world, stages));

    expect(calls).toEqual([]);
    expect(world.run.state).toBe("blocked_prerequisite");
    expect(world.run.stateCode).toBe("CCC_PLANNING_RUNTIME_NOT_PERMITTED");
    expect(world.stateEvents).toEqual([
      { from: "admitted", to: "blocked_prerequisite", stateCode: "CCC_PLANNING_RUNTIME_NOT_PERMITTED" },
    ]);
    expect(world.workItem.state).toBe("held");
  });

  it("H1 runtime digest: a source run (distRoot null) registers nothing", async () => {
    await registerCccRunningRuntimeAtEngineStart({ distRoot: null });
    expect(readCccRunningRuntimeDistManifest()).toBeNull();
  });
});

describe("ccc planning host with a registered runtime", () => {
  beforeAll(() => {
    registerCccRunningRuntimeDistManifest(RUNTIME_DIGEST);
  });

  it("H1 RED 1: a planning item runs the twelve stages in order under one lease", async () => {
    const world = createWorld({ state: "admitted" });
    const { stages, calls } = recordingStages(world);

    const result = await processPlanning(world, planningRuntime(world, stages));

    expect(result.runtime?.reason ?? "").not.toContain("workflow required campaign custody is missing");
    expect(calls.map((call) => call.stageId)).toEqual([...CCC_PLANNING_IR_STAGES]);
    expect(calls).toHaveLength(12);
    expect(world.store.acquireWorkflowWorkItemLease).toHaveBeenCalledTimes(1);
    const fence = { kind: "planning", workItemId: WORK_ITEM_ID, runId: RUN_ID, attempt: 1, leaseOwner: LEASE_OWNER, originTaskId: TASK_ID };
    for (const call of calls) expect(call.fence).toEqual(fence);
    // Every stage starts on a running run; the import stage starts after specready moved it to spec_ready.
    expect(calls.map((call) => call.state)).toEqual([...Array.from({ length: 11 }, () => "running"), "spec_ready"]);
    expect(world.stateEvents).toEqual([
      { from: "admitted", to: "running", stateCode: null },
      { from: "running", to: "spec_ready", stateCode: null },
    ]);
    expect(world.workItem).toMatchObject({ state: "succeeded", attempt: 1, leaseOwner: null });
    expect(result.runtime).toMatchObject({ disposition: "completed" });
  });

  /*
  FNXC:CccPlanningHost 2026-10-15-00:04 (W3 repair 2, E14 item 2):
  A workflow that completes while its run is still admitted or running would leave the run behind a succeeded item,
  where nothing moves it again. The host reads the run back under the still-live fence and concludes it (failed /
  CCC_PLANNING_INTERNAL_ERROR, or its pending control) instead. RED 1 is the control: the run reached spec_ready.
  */
  it("H1 RED 1b: a workflow that completes with its run still running concludes the run instead of succeeding behind it", async () => {
    const world = createWorld({ state: "running" });
    const { stages, calls } = recordingStages(world, {
      specready: async () => ({ kind: "committed", artifactKeys: [] }),
    });

    const result = await processPlanning(world, planningRuntime(world, stages));

    expect(calls.map((call) => call.stageId)).toEqual([...CCC_PLANNING_IR_STAGES]);
    expect(world.run).toMatchObject({ state: "failed", stateCode: "CCC_PLANNING_INTERNAL_ERROR" });
    expect(world.stateEvents).toEqual([{ from: "running", to: "failed", stateCode: "CCC_PLANNING_INTERNAL_ERROR" }]);
    expect(world.workItem).toMatchObject({ state: "failed", leaseOwner: null });
    expect(result.runtime?.disposition).toBe("failed");
  });

  it("H1 control: the same planning fixture claimed under campaign custody still fails as campaign custody missing", async () => {
    const world = createWorld({ state: "admitted" });
    const { stages, calls } = recordingStages(world);

    const result = await processPlanning(world, planningRuntime(world, stages), { custody: undefined, campaignRequired: true });

    expect(result.runtime?.reason ?? "").toContain("workflow required campaign custody is missing");
    expect(calls).toEqual([]);
    expect(world.stateEvents).toEqual([]);
  });

  it("H1 RED 2: lease loss mid-stage aborts and settles in the order cancelAll, flush, release, completeCancellation", async () => {
    vi.useFakeTimers();
    const world = createWorld({ state: "running" });
    let releaseStage: (() => void) | undefined;
    const { stages, calls } = recordingStages(world, {
      preflight: async (ctx) => {
        ctx.descendants.register({
          id: "spy-session",
          cancel: async () => {
            world.order.push("cancelAll");
            releaseStage?.();
          },
        });
        world.loseLease();
        // Ignores ctx.signal on purpose: only the registry's cancelAll lets this stage return.
        await new Promise<void>((resolve) => { releaseStage = resolve; });
        return { kind: "committed", artifactKeys: [] };
      },
    });
    const runtime = planningRuntime(world, stages);
    const flushSpy = {
      run: async (...args: Parameters<WorkflowTaskRuntime["run"]>) => {
        try {
          return await runtime.run(...args);
        } finally {
          world.order.push("flush");
        }
      },
      runWorkItem: runtime.runWorkItem.bind(runtime),
    } as unknown as WorkflowTaskRuntime;

    const processing = processPlanning(world, flushSpy, { leaseDurationMs: 30_000 });
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await processing;

    expect(world.order).toEqual(["cancelAll", "flush", "release", "completeCancellation"]);
    expect(calls.map((call) => call.stageId)).toEqual(["preflight"]);
    expect(world.run.state).toBe("running");
    expect(world.stateEvents).toEqual([]);
    expect(world.workItem).toMatchObject({ state: "runnable", leaseOwner: null });
    expect(result.runtime?.disposition).not.toBe("completed");
  });

  /*
  FNXC:CccPlanningHost 2026-10-15-00:04 (W3 repair 2, E14 item 6):
  Section 2.16 freezes "cancelAll resolves only after every handle settled". RED 2's flush step awaits the runtime,
  which hides a cancelAll that does not wait, so the registry is pinned on its own: with one handle still cancelling,
  cancelAll stays pending; a handle whose cancel rejects still counts as settled.
  */
  it("H1 RED 2b: the descendant registry's cancelAll stays pending until every handle's cancel has settled", async () => {
    const registry = createCccPlanningDescendantRegistry();
    const settled: string[] = [];
    let finishSlow: (() => void) | undefined;
    registry.register({ id: "fast", cancel: async () => { settled.push("fast"); } });
    registry.register({ id: "failing", cancel: async () => { settled.push("failing"); throw new Error("cancel refused"); } });
    registry.register({
      id: "slow",
      cancel: () => new Promise<void>((resolve) => {
        finishSlow = () => { settled.push("slow"); resolve(); };
      }),
    });
    let done = false;
    const cancelling = registry.cancelAll(new Error("h1-cancel-all")).then(() => { done = true; });
    for (let turn = 0; turn < 5; turn += 1) await new Promise<void>((resolve) => setImmediate(resolve));

    expect(settled).toEqual(["fast", "failing"]);
    expect(finishSlow).toBeTypeOf("function");
    expect(done).toBe(false);

    finishSlow!();
    await cancelling;
    expect(done).toBe(true);
    expect(settled).toEqual(["fast", "failing", "slow"]);
  });

  it("H1 RED 4: a dispatched_unknown call moves the run to unknown_effect at the next stage start and is never re-dispatched", async () => {
    const world = createWorld({
      state: "running",
      unreconciled: [{ lineageId: "intent:intent-assessor", attemptKey: "attempt-1", dispatchedAt: NOW }],
    });
    const sessions = unusedSessions();
    const { stages, calls } = recordingStages(world);
    const runtime = planningRuntime(world, stages, sessions);

    const result = await processPlanning(world, runtime);

    expect(calls).toEqual([]);
    expect(sessions.open).not.toHaveBeenCalled();
    expect(world.run.state).toBe("unknown_effect");
    expect(world.stateEvents).toEqual([
      { from: "running", to: "unknown_effect", stateCode: "CCC_PLANNING_UNRECONCILED_DISPATCH" },
    ]);
    expect(world.workItem.state).toBe("held");
    expect(result.runtime?.context[CCC_PLANNING_HOLD_CONTEXT_KEY]).toMatchObject({
      runState: "unknown_effect", code: "CCC_PLANNING_UNRECONCILED_DISPATCH",
    });

    const again = await processPlanning(world, runtime);
    expect(again.claimed).toBe(false);
    expect(calls).toEqual([]);
    expect(sessions.open).not.toHaveBeenCalled();
  });

  it("H1 RED 5: a pending pause is applied at the next stage boundary", async () => {
    const world = createWorld({ state: "running" });
    const { stages, calls } = recordingStages(world, {
      preflight: async () => {
        world.run.controlRequest = "pause";
        world.run.committed.add("preflight");
        return { kind: "committed", artifactKeys: ["cccplan-r001-preflight-x-v01"] };
      },
    });

    const result = await processPlanning(world, planningRuntime(world, stages));

    expect(calls.map((call) => call.stageId)).toEqual(["preflight"]);
    expect(world.run.state).toBe("paused");
    expect(world.run.controlRequest).toBeNull();
    expect(world.stateEvents).toEqual([{ from: "running", to: "paused", stateCode: null }]);
    expect(world.workItem).toMatchObject({ state: "held", leaseOwner: null });
    expect(world.workItem.blockedReason).toContain("paused");
    expect(result.runtime?.context[CCC_PLANNING_HOLD_CONTEXT_KEY]).toMatchObject({ runState: "paused" });
  });

  it("H1 RED 5b: a pending cancel at a stage boundary settles the run and L1 completes the cancellation", async () => {
    const world = createWorld({ state: "running" });
    const { stages, calls } = recordingStages(world, {
      preflight: async () => {
        world.run.controlRequest = "cancel";
        world.run.committed.add("preflight");
        return { kind: "committed", artifactKeys: [] };
      },
    });

    const result = await processPlanning(world, planningRuntime(world, stages));

    expect(calls.map((call) => call.stageId)).toEqual(["preflight"]);
    expect(world.stateEvents).toEqual([
      { from: "running", to: "cancelling", stateCode: null },
      { from: "cancelling", to: "cancelled", stateCode: "CCC_PLANNING_CANCELLED" },
    ]);
    expect(world.order).toEqual(["completeCancellation"]);
    expect(world.workItem).toMatchObject({ state: "cancelled", leaseOwner: null });
    expect(result.runtime).toMatchObject({ disposition: "cancelled" });
  });

  it("H1 RED 6a: a registered runtime digest different from the run's parks an admitted run before any stage", async () => {
    const world = createWorld({ state: "admitted", runtimeDigest: OTHER_DIGEST });
    const { stages, calls } = recordingStages(world);

    await processPlanning(world, planningRuntime(world, stages));

    expect(readCccRunningRuntimeDistManifest()).toBe(RUNTIME_DIGEST);
    expect(calls).toEqual([]);
    expect(world.stateEvents).toEqual([
      { from: "admitted", to: "blocked_prerequisite", stateCode: "CCC_PLANNING_RUNTIME_NOT_PERMITTED" },
    ]);
    expect(world.workItem.state).toBe("held");
  });

  it("H1 RED 7: a stored IR altered by one node config fails the run with WORKFLOW_IR_DRIFT", async () => {
    expect(cccPlanningWorkflowIrHash(buildCccPlanningWorkflowIr("build"))).toBe(PINNED_IR_DIGEST.build);
    expect(cccPlanningWorkflowIrHash(buildCccPlanningWorkflowIr("spec"))).toBe(PINNED_IR_DIGEST.spec);
    const altered = structuredClone(buildCccPlanningWorkflowIr("build"));
    const design = altered.nodes.find((node) => node.id === "design")!;
    design.config = { ...design.config, maxRetries: 1 };
    const world = createWorld({ state: "admitted", storedIr: altered });
    const { stages, calls } = recordingStages(world);

    const result = await processPlanning(world, planningRuntime(world, stages));

    expect(calls).toEqual([]);
    expect(world.run.state).toBe("failed");
    expect(world.stateEvents).toEqual([{ from: "admitted", to: "failed", stateCode: "CCC_PLANNING_WORKFLOW_IR_DRIFT" }]);
    expect(world.workItem.state).toBe("failed");
    expect(result.runtime?.disposition).toBe("failed");
  });

  it("H1 RED 7b: a work item irHash that is not the K1 digest fails the run with WORKFLOW_IR_DRIFT", async () => {
    const world = createWorld({ state: "admitted", workItemIrHash: "f".repeat(64) });
    const { stages, calls } = recordingStages(world);

    await processPlanning(world, planningRuntime(world, stages));

    expect(calls).toEqual([]);
    expect(world.stateEvents).toEqual([{ from: "admitted", to: "failed", stateCode: "CCC_PLANNING_WORKFLOW_IR_DRIFT" }]);
  });

  it("H1 RED 12: a planning node gets exactly one attempt (maxRetriesPerNode 1), never an executor retry", async () => {
    const world = createWorld({ state: "running" });
    const { stages, calls } = recordingStages(world, {
      intent: async () => {
        // The host's post-stage read fails once; an executor retry would run the intent stage a second time.
        world.ledger.inspectCccPlanningRun.mockImplementationOnce(async () => {
          throw new Error("ledger unavailable after intent");
        });
        world.run.committed.add("intent");
        return { kind: "committed", artifactKeys: [] };
      },
    });

    const result = await processPlanning(world, planningRuntime(world, stages));

    expect(calls.map((call) => call.stageId)).toEqual(["preflight", "intent"]);
    expect(result.runtime?.disposition).toBe("failed");
    expect(result.runtime?.reason ?? "").toContain("ledger unavailable after intent");
    expect(world.workItem.state).toBe("failed");
    // W3 repair 1: the item fails only after the run itself was moved to failed under the still-live fence.
    expect(world.run).toMatchObject({ state: "failed", stateCode: "CCC_PLANNING_INTERNAL_ERROR" });
    expect(world.stateEvents).toEqual([{ from: "running", to: "failed", stateCode: "CCC_PLANNING_INTERNAL_ERROR" }]);
  });

  /*
  FNXC:CccPlanningHost 2026-10-14-23:24 (W3 repair 1):
  The claim never ends with a failed or held work item behind a run that could still run (admitted, running, spec_ready,
  importing): nothing would ever move such a run again, and an operator cancel would wait forever for a stage boundary.
  A failure that is not a hold moves the run to failed first; a pending control wins over the failure; a pair the host
  may not take from a startable state fails the run instead of holding it.
  */
  it("H1 RED 12b: a runtime rejection moves the run to failed before the work item fails", async () => {
    const world = createWorld({ state: "running" });
    const rejecting = {
      run: async () => { throw new Error("runtime crashed before any stage"); },
      runWorkItem: async () => { throw new Error("runWorkItem is not part of the planning path"); },
    } as unknown as WorkflowTaskRuntime;

    const result = await processPlanning(world, rejecting);

    expect(result.runtime?.reason ?? "").toContain("runtime crashed before any stage");
    expect(world.run).toMatchObject({ state: "failed", stateCode: "CCC_PLANNING_INTERNAL_ERROR" });
    expect(world.stateEvents).toEqual([{ from: "running", to: "failed", stateCode: "CCC_PLANNING_INTERNAL_ERROR" }]);
    expect(world.workItem).toMatchObject({ state: "failed", leaseOwner: null });
  });

  it("H1 RED 12c: a host failure while a pause is pending applies the pause and holds the item, never failed", async () => {
    const world = createWorld({ state: "running" });
    const { stages, calls } = recordingStages(world, {
      intent: async () => {
        world.run.controlRequest = "pause";
        world.ledger.inspectCccPlanningRun.mockImplementationOnce(async () => {
          throw new Error("ledger unavailable after intent");
        });
        world.run.committed.add("intent");
        return { kind: "committed", artifactKeys: [] };
      },
    });

    const result = await processPlanning(world, planningRuntime(world, stages));

    expect(calls.map((call) => call.stageId)).toEqual(["preflight", "intent"]);
    expect(world.run).toMatchObject({ state: "paused", controlRequest: null });
    expect(world.stateEvents).toEqual([{ from: "running", to: "paused", stateCode: null }]);
    expect(world.workItem).toMatchObject({ state: "held", leaseOwner: null });
    expect(world.workItem.blockedReason).toContain("paused");
    expect(result.runtime?.context[CCC_PLANNING_HOLD_CONTEXT_KEY]).toMatchObject({ disposition: "held", runState: "paused" });
  });

  it("H1 RED 12d: a host failure while a cancel is pending settles the cancel and L1 completes it", async () => {
    const world = createWorld({ state: "running" });
    const { stages } = recordingStages(world, {
      intent: async () => {
        world.run.controlRequest = "cancel";
        world.ledger.inspectCccPlanningRun.mockImplementationOnce(async () => {
          throw new Error("ledger unavailable after intent");
        });
        world.run.committed.add("intent");
        return { kind: "committed", artifactKeys: [] };
      },
    });

    const result = await processPlanning(world, planningRuntime(world, stages));

    expect(world.stateEvents).toEqual([
      { from: "running", to: "cancelling", stateCode: null },
      { from: "cancelling", to: "cancelled", stateCode: "CCC_PLANNING_CANCELLED" },
    ]);
    expect(world.workItem).toMatchObject({ state: "cancelled", leaseOwner: null });
    expect(result.runtime?.disposition).toBe("cancelled");
  });

  it("H1 RED 12e: when L1 cannot be reached to fail the run, the item is released to runnable, never failed or held", async () => {
    const world = createWorld({ state: "running" });
    const { stages, calls } = recordingStages(world, {
      intent: async () => {
        // The post-stage read and the processor's own read both fail: L1 is unreachable for this claim.
        world.ledger.inspectCccPlanningRun
          .mockImplementationOnce(async () => { throw new Error("ledger unreachable (1)"); })
          .mockImplementationOnce(async () => { throw new Error("ledger unreachable (2)"); });
        world.run.committed.add("intent");
        return { kind: "committed", artifactKeys: [] };
      },
    });
    const runtime = planningRuntime(world, stages);

    const result = await processPlanning(world, runtime);

    expect(result.runtime?.disposition).toBe("failed");
    expect(world.run.state).toBe("running");
    expect(world.stateEvents).toEqual([]);
    expect(world.workItem).toMatchObject({ state: "runnable", attempt: 1, leaseOwner: null });

    // An operator cancel recorded meanwhile is applied at the next stage start of the next claim.
    world.run.controlRequest = "cancel";
    const again = await processPlanning(world, runtime);
    expect(again.claimed).toBe(true);
    expect(calls.map((call) => call.stageId)).toEqual(["preflight", "intent"]);
    expect(world.run.state).toBe("cancelled");
    expect(world.workItem.state).toBe("cancelled");
  });

  it("H1 RED 18b: a park whose pair the host may not take from a startable state fails the run instead of holding it", async () => {
    const world = createWorld({ state: "importing" });
    const { stages, calls } = recordingStages(world, {
      preflight: async () => ({ kind: "unknown-effect", attemptKeys: ["attempt-1"] }),
    });

    const result = await processPlanning(world, planningRuntime(world, stages));

    expect(calls.map((call) => call.stageId)).toEqual(["preflight"]);
    expect(cccPlanningTransitionAllowed("importing", "unknown_effect")).toBe(false);
    expect(world.run).toMatchObject({ state: "failed", stateCode: "CCC_PLANNING_INTERNAL_ERROR" });
    expect(world.workItem.state).toBe("failed");
    expect(result.runtime?.disposition).toBe("failed");
  });

  /*
  FNXC:CccPlanningHost 2026-10-15-00:04 (W3 repair 2, E14 item 1):
  The planning claim is total. A throw from the attempt bump, or a store that cannot read the planning task, is
  concluded on the run under the still-live lease; it never reaches the shared catch, which would fail the item and
  leave the run running where nothing moves it again.
  */
  it("H1 RED 12f: an attempt bump that throws concludes the run under the lease instead of failing the item behind it", async () => {
    const world = createWorld({ state: "running" });
    const { stages, calls } = recordingStages(world);
    world.store.transitionWorkflowWorkItem.mockImplementationOnce(async () => {
      throw new Error("ECONNRESET (simulated attempt bump failure)");
    });

    const result = await processPlanning(world, planningRuntime(world, stages));

    expect(calls).toEqual([]);
    expect(world.run).toMatchObject({ state: "failed", stateCode: "CCC_PLANNING_INTERNAL_ERROR" });
    expect(world.stateEvents).toEqual([{ from: "running", to: "failed", stateCode: "CCC_PLANNING_INTERNAL_ERROR" }]);
    expect(world.workItem).toMatchObject({ state: "failed", attempt: 0, leaseOwner: null });
    expect(result.runtime?.reason ?? "").toContain("ECONNRESET");
  });

  it("H1 RED 12g: a store that cannot read the planning task concludes the run instead of failing the item behind it", async () => {
    const world = createWorld({ state: "running" });
    const { stages, calls } = recordingStages(world);
    const store = { ...world.store, getTask: undefined };

    const result = await processDueWorkflowWorkItem(store as never, planningRuntime(world, stages), undefined, {
      leaseOwner: LEASE_OWNER, leaseDurationMs: 60_000, custody: "planning",
    });

    expect(calls).toEqual([]);
    expect(world.run).toMatchObject({ state: "failed", stateCode: "CCC_PLANNING_INTERNAL_ERROR" });
    expect(world.workItem).toMatchObject({ state: "failed", leaseOwner: null });
    expect(result.runtime?.reason ?? "").toContain("requires getTask");
  });

  /*
  FNXC:CccPlanningHost 2026-10-15-00:04 (W3 repair 2, E14 item 7):
  The frozen `rejected` outcome is terminal failed: a G3/G4 gate rejection must never let the run go on to import.
  */
  it("H1 RED 24: a stage that rejects fails the run with its code, one state event, and no later stage is entered", async () => {
    const world = createWorld({ state: "running" });
    const { stages, calls } = recordingStages(world, {
      design: async () => ({ kind: "rejected", code: "CCC_PLANNING_GRAPH_INADMISSIBLE" }),
    });

    const result = await processPlanning(world, planningRuntime(world, stages));

    expect(calls.map((call) => call.stageId)).toEqual(["preflight", "intent", "research", "design"]);
    expect(world.run).toMatchObject({ state: "failed", stateCode: "CCC_PLANNING_GRAPH_INADMISSIBLE" });
    expect(world.stateEvents).toEqual([{ from: "running", to: "failed", stateCode: "CCC_PLANNING_GRAPH_INADMISSIBLE" }]);
    expect(world.workItem).toMatchObject({ state: "failed", leaseOwner: null });
    expect(result.runtime?.disposition).toBe("failed");
  });

  it("H1 RED 24b: a rejection with an invalid code fails the run with CCC_PLANNING_INTERNAL_ERROR", async () => {
    const world = createWorld({ state: "running" });
    const { stages, calls } = recordingStages(world, {
      design: async () => ({ kind: "rejected", code: "graph inadmissible" }),
    });

    const result = await processPlanning(world, planningRuntime(world, stages));

    expect(calls.map((call) => call.stageId)).toEqual(["preflight", "intent", "research", "design"]);
    expect(world.run).toMatchObject({ state: "failed", stateCode: "CCC_PLANNING_INTERNAL_ERROR" });
    expect(world.stateEvents).toEqual([{ from: "running", to: "failed", stateCode: "CCC_PLANNING_INTERNAL_ERROR" }]);
    expect(world.workItem).toMatchObject({ state: "failed", leaseOwner: null });
    expect(result.runtime?.disposition).toBe("failed");
  });

  describe("session watchdog (D40)", () => {
    it("H1z watchdog: a synchronous session-open failure clears the timer and abort listener", async () => {
      vi.useFakeTimers();
      const world = createWorld({ state: "running" });
      const { stages } = recordingStages(world, { preflight: sessionStage(world, 1) });
      const before = vi.getTimerCount();
      const remove = vi.spyOn(AbortSignal.prototype, "removeEventListener");
      const factory: CccPlanningSessionFactory = { open: () => { throw new Error("synchronous open failure"); } };
      const result = await processPlanning(world, planningRuntime(world, stages, factory));
      expect(result.runtime?.disposition).toBe("failed");
      expect(vi.getTimerCount()).toBe(before);
      expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    });

    function timedSessions(durationsMs: readonly number[]) {
      const opened: Array<{ signal: AbortSignal; openedAt: number; abortedAfterMs: number | null; disposed: number }> = [];
      const factory: CccPlanningSessionFactory = {
        open: async (input) => {
          const durationMs = durationsMs[opened.length]!;
          const entry = { signal: input.signal, openedAt: Date.now(), abortedAfterMs: null as number | null, disposed: 0 };
          input.signal.addEventListener("abort", () => { entry.abortedAfterMs = Date.now() - entry.openedAt; }, { once: true });
          opened.push(entry);
          return {
            binding: {} as CccPlanningSession["binding"],
            // Ignores its signal on purpose: only the host's watchdog can end it early.
            run: async () => {
              await new Promise<void>((resolve) => setTimeout(resolve, durationMs));
              return { submitted: [], verdict: null };
            },
            dispose: async () => { entry.disposed += 1; },
          };
        },
      };
      return { factory, opened };
    }

    function sessionStage(world: World, count: number): CccPlanningStageFn {
      return async (ctx) => {
        for (let attempt = 0; attempt < count; attempt += 1) {
          const session = await openPlanningSession(ctx, attempt);
          try {
            await session.run(`attempt ${attempt}`);
          } finally {
            await session.dispose();
          }
        }
        world.run.committed.add(ctx.stageId);
        return { kind: "committed", artifactKeys: [] };
      };
    }

    it("H1 RED 8a: a stage that runs four 20-minute sessions is not killed", async () => {
      vi.useFakeTimers();
      const world = createWorld({ state: "running" });
      const { factory, opened } = timedSessions([20, 20, 20, 20].map((minutes) => minutes * 60_000));
      const { stages, calls } = recordingStages(world, { preflight: sessionStage(world, 4) });

      const processing = processPlanning(world, planningRuntime(world, stages, factory));
      await vi.advanceTimersByTimeAsync(81 * 60_000);
      const result = await processing;

      expect(opened).toHaveLength(4);
      for (const entry of opened) {
        expect(entry.abortedAfterMs).toBeNull();
        expect(entry.disposed).toBe(1);
      }
      expect(calls.map((call) => call.stageId)).toEqual([...CCC_PLANNING_IR_STAGES]);
      expect(result.runtime).toMatchObject({ disposition: "completed" });
      expect(world.workItem.state).toBe("succeeded");
    });

    it("H1 RED 8b: a single 31-minute session attempt is killed at 30 minutes", async () => {
      vi.useFakeTimers();
      const world = createWorld({ state: "running" });
      const { factory, opened } = timedSessions([31 * 60_000]);
      const { stages, calls } = recordingStages(world, { preflight: sessionStage(world, 1) });

      const processing = processPlanning(world, planningRuntime(world, stages, factory));
      await vi.advanceTimersByTimeAsync(32 * 60_000);
      const result = await processing;

      expect(opened).toHaveLength(1);
      expect(opened[0]!.abortedAfterMs).toBe(30 * 60_000);
      expect((opened[0]!.signal.reason as Error).name).toBe("CccPlanningSessionWatchdogError");
      expect(opened[0]!.disposed).toBe(1);
      expect(calls.map((call) => call.stageId)).toEqual(["preflight"]);
      expect(result.runtime?.disposition).toBe("failed");
      expect(world.workItem.state).toBe("failed");
      expect(world.run.state).toBe("failed");
      expect(world.run.stateCode).toBe("CCC_PLANNING_INTERNAL_ERROR");
    });

    /*
    FNXC:CccPlanningHost 2026-10-14-23:24 (W3 repair 1, D40):
    The watchdog covers the open of a session attempt as well as its run: an open that ignores its signal is ended at
    30 minutes, and a session that the factory hands back after the deadline is disposed, never used.
    */
    function slowOpenSessions(openMs: number) {
      const entry = { abortedAfterMs: null as number | null, opens: 0, disposed: 0, runs: 0 };
      const factory: CccPlanningSessionFactory = {
        open: async (input) => {
          const openedAt = Date.now();
          entry.opens += 1;
          input.signal.addEventListener("abort", () => { entry.abortedAfterMs = Date.now() - openedAt; }, { once: true });
          // Ignores its signal on purpose: only the host's watchdog can end the open early.
          await new Promise<void>((resolve) => setTimeout(resolve, openMs));
          return {
            binding: {} as CccPlanningSession["binding"],
            run: async () => {
              entry.runs += 1;
              return { submitted: [], verdict: null };
            },
            dispose: async () => { entry.disposed += 1; },
          };
        },
      };
      return { factory, entry };
    }

    it("H1 RED 8c: a session open that hangs past 30 minutes is killed at 30 minutes and its late session disposed", async () => {
      vi.useFakeTimers();
      const world = createWorld({ state: "running" });
      const { factory, entry } = slowOpenSessions(45 * 60_000);
      const { stages, calls } = recordingStages(world, { preflight: sessionStage(world, 1) });
      let settled = false;

      const processing = processPlanning(world, planningRuntime(world, stages, factory));
      void processing.then(() => { settled = true; }, () => { settled = true; });
      await vi.advanceTimersByTimeAsync(31 * 60_000);

      expect(entry.abortedAfterMs).toBe(30 * 60_000);
      expect(settled).toBe(true);
      const result = await processing;
      expect(calls.map((call) => call.stageId)).toEqual(["preflight"]);
      expect(result.runtime?.disposition).toBe("failed");
      expect(world.run).toMatchObject({ state: "failed", stateCode: "CCC_PLANNING_INTERNAL_ERROR" });
      expect(world.workItem.state).toBe("failed");
      expect(entry.runs).toBe(0);

      await vi.advanceTimersByTimeAsync(15 * 60_000);
      expect(entry.disposed).toBe(1);
      expect(entry.runs).toBe(0);
    });

    it("H1 RED 8d: control, a 20-minute session open is not killed and the stage runs", async () => {
      vi.useFakeTimers();
      const world = createWorld({ state: "running" });
      const { factory, entry } = slowOpenSessions(20 * 60_000);
      const { stages, calls } = recordingStages(world, { preflight: sessionStage(world, 1) });

      const processing = processPlanning(world, planningRuntime(world, stages, factory));
      await vi.advanceTimersByTimeAsync(21 * 60_000);
      const result = await processing;

      expect(entry.abortedAfterMs).toBeNull();
      expect(entry).toMatchObject({ opens: 1, runs: 1, disposed: 1 });
      expect(calls.map((call) => call.stageId)).toEqual([...CCC_PLANNING_IR_STAGES]);
      expect(result.runtime).toMatchObject({ disposition: "completed" });
      expect(world.workItem.state).toBe("succeeded");
    });
  });

  describe("provider route refusal (verify-v2 item 42, E8-W3)", () => {
    function refusingSessions(world: World) {
      const factory: CccPlanningSessionFactory = {
        open: async () => ({
          binding: {} as CccPlanningSession["binding"],
          run: async () => {
            // The fake L1 settlement: one transition, in the refusing call's own transaction.
            const from = world.run.state;
            world.run.state = "blocked_provider";
            world.run.stateCode = "CCC_PROVIDER_PIN_DRIFT";
            world.stateEvents.push({ from, to: "blocked_provider", stateCode: "CCC_PROVIDER_PIN_DRIFT" });
            throw new CccProviderRouteReceiptError("receipt-mismatch", { provider: "ccc-glm", model: "glm/glm-5.3" }, null);
          },
          dispose: async () => undefined,
        }),
      };
      return factory;
    }

    it("H1 RED 11: a session that throws CccProviderRouteReceiptError after settlement yields blocked with one state event", async () => {
      const world = createWorld({ state: "running" });
      const { stages, calls } = recordingStages(world, {
        preflight: async (ctx) => {
          const session = await openPlanningSession(ctx, 0);
          try {
            await session.run("route");
            return { kind: "committed", artifactKeys: [] };
          } finally {
            await session.dispose();
          }
        },
      });

      const result = await processPlanning(world, planningRuntime(world, stages, refusingSessions(world)));

      expect(calls.map((call) => call.stageId)).toEqual(["preflight"]);
      expect(world.stateEvents).toEqual([{ from: "running", to: "blocked_provider", stateCode: "CCC_PROVIDER_PIN_DRIFT" }]);
      expect(world.ledger.transitionCccPlanningRunState).not.toHaveBeenCalled();
      expect(world.run.state).toBe("blocked_provider");
      expect(result.runtime?.context[CCC_PLANNING_HOLD_CONTEXT_KEY]).toMatchObject({
        runState: "blocked_provider", code: "CCC_PROVIDER_PIN_DRIFT",
      });
      expect(world.workItem.state).toBe("held");
    });

    /*
    FNXC:CccPlanningHost 2026-10-15-00:04 (W3 repair 2, E14 item 5):
    The swallowing session sits in the last IR stage (specready, in a Spec run), so no later stage start can notice the
    blocked_provider run by accident: only the refusing stage's own watch can hold the item. Without it the graph
    completes and the item would succeed behind a blocked_provider run.
    */
    it("H1 RED 11b: a last stage that swallows the route refusal still yields blocked with one state event", async () => {
      const world = createWorld({ mode: "spec", state: "running" });
      const { stages, calls } = recordingStages(world, {
        specready: async (ctx) => {
          const session = await openPlanningSession(ctx, 0);
          try {
            await session.run("route").catch(() => undefined);
            return { kind: "committed", artifactKeys: [] };
          } finally {
            await session.dispose();
          }
        },
      });

      const result = await processPlanning(world, planningRuntime(world, stages, refusingSessions(world)));

      const specStages = CCC_PLANNING_IR_STAGES.filter((stageId) => stageId !== "import");
      expect(specStages.at(-1)).toBe("specready");
      expect(calls.map((call) => call.stageId)).toEqual(specStages);
      expect(world.stateEvents).toEqual([{ from: "running", to: "blocked_provider", stateCode: "CCC_PROVIDER_PIN_DRIFT" }]);
      expect(world.ledger.transitionCccPlanningRunState).not.toHaveBeenCalled();
      expect(result.runtime?.context[CCC_PLANNING_HOLD_CONTEXT_KEY]).toMatchObject({
        disposition: "held", runState: "blocked_provider", code: "CCC_PROVIDER_PIN_DRIFT",
      });
      // The hold comes from the refusing node itself.
      expect(result.runtime?.context["node:specready:outcome"]).toBe("failure");
      expect(result.runtime?.disposition).toBe("manual-required");
      expect(world.workItem.state).toBe("held");
    });
  });

  describe("runtime dist manifest digest (D44, ADR D algorithm)", () => {
    let root: string;
    beforeAll(async () => {
      root = await mkdtemp(join(tmpdir(), "ccc-h1-dist-"));
      await mkdir(join(root, "sub"), { recursive: true });
      await writeFile(join(root, "a.js"), "export const a = 1;\n");
      await writeFile(join(root, "sub", "b.js"), "export const b = 2;\n");
      await writeFile(join(root, "a.js.map"), "{}");
    });
    afterAll(async () => {
      if (root) await rm(root, { recursive: true, force: true });
    });

    it("H1 runtime digest: sha256 of canonical sorted [relPath, sha256] over dist/**/*.js", async () => {
      const expected = sha256(canonicalCccPrdJson([
        ["a.js", sha256("export const a = 1;\n")],
        ["sub/b.js", sha256("export const b = 2;\n")],
      ]));
      expect(await computeCccRuntimeDistManifestSha256(root)).toBe(expected);
      await writeFile(join(root, "sub", "b.js"), "export const b = 3;\n");
      expect(await computeCccRuntimeDistManifestSha256(root)).not.toBe(expected);
    });
  });

  /*
  FNXC:CccPlanningHost 2026-10-14-23:24 (W3 repair 1, D3, D44, verify-v2 item 35):
  The production wiring in InProcessRuntime, not only the paths it calls. The drain must offer every lease-expired
  planning item to the existing acquire path even when older lease-expired items of other kinds fill the first page
  (the FN-8470/8471 limit:20 class), and start() must register its own runtime digest and run planning recovery with
  the linked-outcome ports it was wired with.
  */
  describe("in-process runtime wiring", () => {
    type RuntimeInternals = {
      status: string;
      taskStore: unknown;
      executor: Record<string, unknown>;
      cccPlanningWorkflowRuntime?: WorkflowTaskRuntime;
      drainWorkflowContinuations: () => Promise<void>;
    };
    /** The public surface the tests drive plus the private members they seed (an intersection with the class is never). */
    type WiredRuntime = Pick<InProcessRuntime, "setCccPlanningHost" | "settleWorkflowContinuations" | "on" | "start"> & RuntimeInternals;
    function bareRuntime(config: Record<string, unknown> = {}, centralCore: unknown = {}): WiredRuntime {
      return new InProcessRuntime({
        projectId: "h1-wiring", workingDirectory: "/private/tmp/h1-wiring-unused", isolationMode: "in-process",
        maxConcurrent: 1, maxWorktrees: 1, ...config,
      } as never, centralCore as never) as unknown as WiredRuntime;
    }

    it("H1 RED 13: the drain dispatches a lease-expired planning item behind 25 older lease-expired running items under planning custody", async () => {
      const deadOwner = "h1-dead-engine";
      const world = createWorld({ state: "running" });
      Object.assign(world.workItem, { state: "running", attempt: 1, leaseOwner: deadOwner, leaseExpiresAt: NOW });
      world.loseLease();
      const { stages, calls } = recordingStages(world);
      const zombies = Array.from({ length: 25 }, (_, index) => ({
        id: `zombie-${index}`, runId: `ccc-prd:zombie-${index}`, taskId: `T-ZOMBIE-${index}`, nodeId: "n", kind: "task",
        state: "running", attempt: 1, leaseOwner: deadOwner, leaseExpiresAt: "2020-01-01T00:00:00.000Z",
        stableWorkflowRunId: `ccc-prd:zombie-${index}`, createdAt: "2020-01-01T00:00:00.000Z",
      }));
      // The due query's order (created_at FIFO): every zombie is older than the planning item.
      const listDueWorkflowWorkItems = vi.fn(async (filter: { states?: string[]; limit?: number } = {}) => {
        const expiredPlanning = world.workItem.state === "running" && world.workItem.leaseOwner === deadOwner ? [{ ...world.workItem }] : [];
        const due = [...zombies, ...expiredPlanning].filter((item) => !filter.states || filter.states.includes(item.state));
        return filter.limit === undefined ? due : due.slice(0, filter.limit);
      });
      const runtime = bareRuntime();
      runtime.setCccPlanningHost({ stages, sessions: unusedSessions() });
      runtime.status = "active";
      runtime.taskStore = { ...world.store, listDueWorkflowWorkItems, getSettings: async () => ({}), getAsyncLayer: () => null };
      const releaseExecution = vi.fn();
      const executor = { execute: vi.fn(), tryBeginAuthoritativeWorkflowExecution: vi.fn(() => releaseExecution) };
      runtime.executor = executor;
      runtime.cccPlanningWorkflowRuntime = planningRuntime(world, stages);

      await runtime.drainWorkflowContinuations();
      await runtime.settleWorkflowContinuations();

      expect(calls.map((call) => call.stageId)).toEqual([...CCC_PLANNING_IR_STAGES]);
      expect(world.store.acquireWorkflowWorkItemLease).toHaveBeenCalledTimes(1);
      expect(world.store.acquireWorkflowWorkItemLease.mock.calls[0]?.[1]).toBe("in-process-runtime:h1-wiring");
      expect(world.workItem).toMatchObject({ state: "succeeded", attempt: 1, leaseOwner: null });
      expect(executor.tryBeginAuthoritativeWorkflowExecution).toHaveBeenCalledWith(TASK_ID);
      expect(releaseExecution).toHaveBeenCalledTimes(1);
      expect(executor.execute).not.toHaveBeenCalled();
    });

    /*
    FNXC:CccPlanningHost 2026-10-15-00:04 (W3 repair 2, E14 item 3):
    Fresh planning items (admission) and every resume or answer requeue are `runnable`. Runnable continuation items of
    ordinary paused tasks are skipped by the drain and never cleared, so a first page of the oldest 20 can hide every
    planning item. Planning items are found apart from that page, as lease-expired ones already are.
    */
    async function drainWithParked(parkedCount: number) {
      const world = createWorld({ state: "admitted" });
      const { stages, calls } = recordingStages(world);
      const parked = Array.from({ length: parkedCount }, (_, index) => ({
        id: `parked-${index}`, runId: `wf-parked-${index}`, taskId: `T-PARKED-${index}`, nodeId: "n", kind: "task",
        state: "runnable", attempt: 0, leaseOwner: null, leaseExpiresAt: null, waitReason: "planning",
        stableWorkflowRunId: `wf-parked-${index}`, createdAt: "2020-01-01T00:00:00.000Z",
      }));
      // The due query's order (created_at FIFO): every parked item is older than the planning item.
      const listDueWorkflowWorkItems = vi.fn(async (filter: { states?: string[]; limit?: number } = {}) => {
        const planning = world.workItem.state === "runnable" ? [{ ...world.workItem }] : [];
        const due = [...parked, ...planning].filter((item) => !filter.states || filter.states.includes(item.state));
        return filter.limit === undefined ? due : due.slice(0, filter.limit);
      });
      const runtime = bareRuntime();
      runtime.setCccPlanningHost({ stages, sessions: unusedSessions() });
      runtime.status = "active";
      runtime.taskStore = { ...world.store, listDueWorkflowWorkItems, getSettings: async () => ({}), getAsyncLayer: () => null };
      const executor = { execute: vi.fn(), tryBeginAuthoritativeWorkflowExecution: vi.fn(() => vi.fn()) };
      runtime.executor = executor;
      runtime.cccPlanningWorkflowRuntime = planningRuntime(world, stages);
      for (let pass = 0; pass < 3; pass += 1) {
        await runtime.drainWorkflowContinuations();
        await runtime.settleWorkflowContinuations();
      }
      return { world, calls, executor };
    }

    it("H1 RED 13b: the drain dispatches a runnable planning item behind 25 older runnable items of paused tasks", async () => {
      const { world, calls, executor } = await drainWithParked(25);

      expect(calls.map((call) => call.stageId)).toEqual([...CCC_PLANNING_IR_STAGES]);
      expect(world.workItem).toMatchObject({ state: "succeeded", attempt: 1, leaseOwner: null });
      expect(world.run.state).toBe("spec_ready");
      expect(executor.execute).not.toHaveBeenCalled();
    });

    it("H1 control: a runnable planning item behind 5 older runnable items of paused tasks is dispatched", async () => {
      const { world, calls } = await drainWithParked(5);

      expect(calls.map((call) => call.stageId)).toEqual([...CCC_PLANNING_IR_STAGES]);
      expect(world.workItem).toMatchObject({ state: "succeeded", attempt: 1, leaseOwner: null });
    });

    it("H1 RED 14: start() registers its own runtime digest and runs planning recovery with the wired linked-outcome ports", async () => {
      const linkedRun = { run_id: RUN_ID, state: "building", import_id: "h1-import", planning_task_id: TASK_ID };
      const layer = {
        projectId: "h1-wiring",
        db: {
          // Campaign startup recovery runs first and finds no prior-boot campaign item.
          select: () => ({ from: () => ({ where: async () => [] }) }),
          // Planning recovery lists one linked run.
          execute: vi.fn(async () => [linkedRun]),
        },
      };
      const reconcileLinkedOutcome = vi.fn(async () => undefined);
      // start() is stopped right after the planning step: the next thing it touches is the central core.
      const stopHere = new Error("h1-stop-after-planning-start");
      const centralCore = { get backendMode(): boolean { throw stopHere; } };
      const runtime = bareRuntime({ externalTaskStore: { getAsyncLayer: () => layer }, engineInstanceId: "h1-engine-instance" }, centralCore);
      runtime.on("error", () => undefined);
      runtime.setCccPlanningHost({
        stages: recordingStages(createWorld()).stages, sessions: unusedSessions(), linkedOutcomePorts: { reconcileLinkedOutcome },
      });
      vi.mocked(resolveCccRuntimeDistRoot).mockClear();
      vi.mocked(registerCccRunningRuntimeAtEngineStart).mockClear();

      await expect(runtime.start()).rejects.toBe(stopHere);

      expect(vi.mocked(resolveCccRuntimeDistRoot)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(resolveCccRuntimeDistRoot).mock.calls[0]?.[0]).toMatch(/\/runtimes\/in-process-runtime\.(ts|js)$/u);
      const distRoot = vi.mocked(resolveCccRuntimeDistRoot).mock.results[0]?.value;
      expect(vi.mocked(registerCccRunningRuntimeAtEngineStart)).toHaveBeenCalledWith({ distRoot });
      expect(reconcileLinkedOutcome).toHaveBeenCalledTimes(1);
      expect(reconcileLinkedOutcome).toHaveBeenCalledWith(layer, RUN_ID);
    });
  });
});
