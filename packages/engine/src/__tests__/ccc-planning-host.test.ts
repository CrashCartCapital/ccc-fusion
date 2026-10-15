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
import { createCccPlanningStageHandler } from "../ccc-planning/controller.js";
import {
  computeCccRuntimeDistManifestSha256,
  registerCccRunningRuntimeAtEngineStart,
} from "../ccc-planning/runtime-digest.js";
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

function recordingStages(world: World, overrides: Partial<Record<CccPlanningIrStageId, CccPlanningStageFn>> = {}) {
  const calls: StageCall[] = [];
  const stages = Object.fromEntries(CCC_PLANNING_IR_STAGES.map((stageId) => [stageId, async (ctx: CccPlanningStageContext) => {
    calls.push({ stageId: ctx.stageId, fence: ctx.fence, state: ctx.run.state });
    const override = overrides[stageId];
    if (override) return override(ctx);
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
    expect(calls.every((call) => call.state === "running")).toBe(true);
    expect(world.stateEvents).toEqual([{ from: "admitted", to: "running", stateCode: null }]);
    expect(world.workItem).toMatchObject({ state: "succeeded", attempt: 1, leaseOwner: null });
    expect(result.runtime).toMatchObject({ disposition: "completed" });
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
  });

  describe("session watchdog (D40)", () => {
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
  });

  describe("provider route refusal (verify-v2 item 42, E8-W3)", () => {
    function refusingSessions(world: World) {
      const factory: CccPlanningSessionFactory = {
        open: async () => ({
          binding: {} as CccPlanningSession["binding"],
          run: async () => {
            // The fake L1 settlement: one transition, in the refusing call's own transaction.
            world.run.state = "blocked_provider";
            world.run.stateCode = "CCC_PROVIDER_PIN_DRIFT";
            world.stateEvents.push({ from: "running", to: "blocked_provider", stateCode: "CCC_PROVIDER_PIN_DRIFT" });
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

    it("H1 RED 11b: a stage that swallows the route refusal still yields blocked with one state event", async () => {
      const world = createWorld({ state: "running" });
      const { stages, calls } = recordingStages(world, {
        preflight: async (ctx) => {
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

      expect(calls.map((call) => call.stageId)).toEqual(["preflight"]);
      expect(world.stateEvents).toHaveLength(1);
      expect(result.runtime?.context[CCC_PLANNING_HOLD_CONTEXT_KEY]).toMatchObject({ runState: "blocked_provider" });
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
});
