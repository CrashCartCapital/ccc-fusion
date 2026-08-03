// @ts-nocheck
// FN-6226 surface enumeration: engine-only behavior, so desktop/mobile
// breakpoints are N/A. These tests cover legacy seams, graph runtime
// primitives, custom graph prompt/script/gate nodes under a custom workflow
// selection, builtin/default selection behavior via the legacy seam, fast /
// standard / undefined executionMode data states, and the executor tool
// injection surface (fn_review_step is deleted in both modes) vs mandatory fn_task_done.
import { describe, it, expect, vi, beforeEach } from "vitest";
const { createCccCampaignProviderAttemptBindingMock } = vi.hoisted(() => ({
  createCccCampaignProviderAttemptBindingMock: vi.fn(),
}));
import "./executor-test-helpers.js";
import { disposeTaskBeforeMove, getBuiltinWorkflow } from "@fusion/core";
import { TaskExecutor } from "../executor.js";
import { WorkflowGraphTaskRunner } from "../workflow-graph-task-runner.js";
import { FOREACH_ACTIVE_CONTEXT_KEY } from "../workflow-node-handlers.js";
import {
  AgentSemaphore,
  clearPreHeldExecutorSlotsForTests,
  hasPreHeldExecutorSlot,
  registerPreHeldExecutorSlot,
} from "../concurrency.js";
import {
  createMockStore,
  mockedCreateFnAgent,
  mockedExistsSync,
  mockedExec,
  mockedStatSync,
  resetExecutorMocks,
} from "./executor-test-helpers.js";

vi.mock("../ccc-campaign-provider-controller.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../ccc-campaign-provider-controller.js")>(),
  createCccCampaignProviderAttemptBinding: createCccCampaignProviderAttemptBindingMock,
}));

const now = "2026-06-10T00:00:00.000Z";

function task(overrides: Record<string, unknown> = {}) {
  return {
    id: "FN-6226",
    title: "Fast mode workflow task",
    description: "exercise fast mode",
    column: "in-progress",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    prompt: "# Task\n## Steps\n### Step 1\n- [ ] do it",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeExecutorForTask(liveTask = task()) {
  const store = createMockStore();
  const taskLocks = new Map<string, Promise<void>>();
  store.getTask.mockImplementation(async (id: string) => ({ ...liveTask, id }));
  store.withTaskLock = vi.fn((id: string, work: () => Promise<unknown>) => {
    const previous = taskLocks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    taskLocks.set(id, next);
    return previous.then(async () => {
      try {
        return await work();
      } finally {
        if (taskLocks.get(id) === next) taskLocks.delete(id);
        release();
      }
    });
  });
  store.readTaskForMove = vi.fn(async (id: string) => store.getTask(id));
  store.getSettings.mockResolvedValue({
    autoMerge: false,
    experimentalFeatures: { workflowGraphExecutor: true },
  });
  return { store, executor: new TaskExecutor(store, "/tmp/test") };
}

/*
FNXC:EngineTests 2026-07-19-15:05 (U10b):
Review gates are graph nodes, so one `execute()` opens several agent sessions and the FIRST one is a review
node (Plan Review), not the implementation session. The tool-injection requirement spans the whole run:
`fn_task_done` must be present SOMEWHERE (the implementation session must retain the only completion path),
and `fn_review_step` must appear on NO session in either execution mode. Union the tools across every
session instead of indexing call 0, which now inspects a review node's readonly toolset.
*/
function allSessionToolNames(): string[] {
  return mockedCreateFnAgent.mock.calls.flatMap(([opts]: any[]) =>
    ((opts?.customTools ?? []) as any[]).map((tool) => tool?.name),
  );
}

function workflowResult() {
  return { allPassed: true, results: [] };
}

describe("fast mode workflow/runtime invariants", () => {
  beforeEach(() => {
    resetExecutorMocks();
    clearPreHeldExecutorSlotsForTests();
    mockedExistsSync.mockReturnValue(true);
    createCccCampaignProviderAttemptBindingMock.mockReset();
  });

  it.each(["persisted context", "imported marker"])("Task 3 RED: public execute refuses %s before dependency and ephemeral side effects", async (caseName) => {
    const liveTask = task({
      dependencies: ["FN-BLOCKER"],
      ...(caseName === "imported marker"
        ? { lineageId: "ccc-prd:0123456789abcdef01234567:REQ-1" }
        : {}),
    });
    const store = createMockStore();
    store.getTask.mockResolvedValue(liveTask);
    store.getSettings.mockResolvedValue({ ephemeralAgentsEnabled: false });
    store.listTasks.mockResolvedValue([
      liveTask,
      task({ id: "FN-BLOCKER", column: "todo" }),
    ]);
    store.getCccCampaignContextForTask = vi.fn(async () => caseName === "persisted context"
      ? { campaignId: "CAMPAIGN-1" }
      : null);
    const semaphore = new AgentSemaphore(1);
    expect(semaphore.tryAcquire()).toBe(true);
    registerPreHeldExecutorSlot(liveTask.id);
    const executor = new TaskExecutor(store as any, "/tmp/test", { semaphore });
    const run = vi.spyOn(WorkflowGraphTaskRunner.prototype, "run");

    try {
      await executor.execute(liveTask as any);

      expect(store.listTasks).not.toHaveBeenCalled();
      expect(store.getSettings).not.toHaveBeenCalled();
      expect(store.moveTask).not.toHaveBeenCalled();
      expect(store.updateTask).not.toHaveBeenCalled();
      expect(store.logEntry).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
      expect(mockedCreateFnAgent).not.toHaveBeenCalled();
      expect(mockedExec).not.toHaveBeenCalled();
      expect(hasPreHeldExecutorSlot(liveTask.id)).toBe(false);
      expect(semaphore.activeCount).toBe(0);
      expect((executor as any).graphRouting.has(liveTask.id)).toBe(false);
    } finally {
      run.mockRestore();
    }
  });

  it("Task 3 RED: public execute releases custody refusal so a later ordinary redispatch can proceed", async () => {
    const liveTask = task();
    const { store, executor } = makeExecutorForTask(liveTask);
    store.getCccCampaignContextForTask = vi.fn()
      .mockResolvedValueOnce({ campaignId: "CAMPAIGN-1" })
      .mockResolvedValue(null);
    const run = vi.spyOn(WorkflowGraphTaskRunner.prototype, "run").mockResolvedValue({
      disposition: "completed",
      outcome: "success",
      visitedNodeIds: ["start"],
    });

    try {
      await executor.execute(liveTask as any);
      expect(run).not.toHaveBeenCalled();
      expect((executor as any).graphRouting.has(liveTask.id)).toBe(false);

      await executor.execute(liveTask as any);
      expect(run).toHaveBeenCalledTimes(1);
      expect((executor as any).graphRouting.has(liveTask.id)).toBe(false);
    } finally {
      run.mockRestore();
    }
  });

  it("Task 3 RED: a final custody recheck closes the continuation transition race", async () => {
    const liveTask = task();
    const { store, executor } = makeExecutorForTask(liveTask);
    store.getCccCampaignContextForTask = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ campaignId: "CAMPAIGN-1" });
    const continuation = {
      id: "WORK-ORDINARY-1",
      taskId: liveTask.id,
      kind: "task",
      state: "runnable",
      attempt: 1,
      runId: "ordinary-run",
      stableWorkflowRunId: "ordinary-run",
      irHash: "a".repeat(64),
    };
    store.listWorkflowWorkItemsForTask = vi.fn(async () => [continuation]);
    store.transitionWorkflowWorkItem = vi.fn(async () => continuation);
    const run = vi.spyOn(WorkflowGraphTaskRunner.prototype, "run");

    try {
      await executor.execute(liveTask as any);

      expect(store.getCccCampaignContextForTask).toHaveBeenCalledTimes(3);
      expect(store.transitionWorkflowWorkItem).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
    } finally {
      run.mockRestore();
    }
  });

  /*
  FNXC:WorkflowSelection 2026-07-14-17:06:
  The executor must pass its asynchronously resolved PostgreSQL workflow selection into the graph runner. Re-reading through the synchronous compatibility method would replace a custom graph with builtin:coding.
  */
  /*
  FNXC:EngineTests 2026-07-19-18:20 (U10b):
  Graph ownership is unconditional: the entry point is `executeWorkflowGraph` and it returns void
  because it can no longer decline a task. The requirement under test is unchanged — the async
  selection the executor resolved is what the runner sees — so only the seam name/return moved.
  */
  it("reuses the asynchronous PostgreSQL workflow selection inside the graph runner", async () => {
    const selected = { workflowId: "WF-async-custom", stepIds: ["review"] };
    const { store, executor } = makeExecutorForTask(task());
    store.getTaskWorkflowSelection = vi.fn(() => undefined);
    store.getTaskWorkflowSelectionAsync = vi.fn(async () => selected);
    store.getWorkflowDefinition = vi.fn(async () => ({
      id: selected.workflowId,
      name: "Async custom",
      ir: {
        version: "v1",
        name: "Async custom",
        nodes: [{ id: "start", kind: "start" }, { id: "end", kind: "end" }],
        edges: [{ from: "start", to: "end" }],
      },
    }));
    const run = vi.spyOn(WorkflowGraphTaskRunner.prototype, "run").mockImplementation(async function () {
      expect((this as any).deps.store.getTaskWorkflowSelection()).toEqual(selected);
      await expect((this as any).deps.store.getTaskWorkflowSelectionAsync()).resolves.toEqual(selected);
      return { disposition: "completed", outcome: "success", visitedNodeIds: ["start"] };
    });

    try {
      await expect((executor as any).executeWorkflowGraph(task())).resolves.toBeUndefined();

      expect(store.getTaskWorkflowSelectionAsync).toHaveBeenCalledWith("FN-6226");
      expect(store.getTaskWorkflowSelection).not.toHaveBeenCalled();
      expect(run).toHaveBeenCalledTimes(1);
    } finally {
      // Prototype spy: restore even on failure so it cannot leak into sibling runner tests.
      run.mockRestore();
    }
  });

  it("Task 3 RED: the generic executor defers persisted CCC campaign custody before settings or graph effects", async () => {
    const liveTask = task({ lineageId: "ccc-prd:0123456789abcdef01234567:REQ-1" });
    const { store, executor } = makeExecutorForTask(liveTask);
    store.getCccCampaignContextForTask = vi.fn(async () => ({ campaignId: "CAMPAIGN-1" }));
    const run = vi.spyOn(WorkflowGraphTaskRunner.prototype, "run");

    try {
      await (executor as any).executeWorkflowGraph(liveTask, { alreadyClaimed: true });

      expect(store.getCccCampaignContextForTask).toHaveBeenCalledWith(liveTask.id);
      expect(store.getSettings).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
    } finally {
      run.mockRestore();
    }
  });

  it("Task 3 RED: an imported campaign work item is left runnable for the native processor", async () => {
    const liveTask = task();
    const { store, executor } = makeExecutorForTask(liveTask);
    store.getCccCampaignContextForTask = vi.fn(async () => null);
    const importedWorkItem = {
      id: "WI-CCC-1",
      taskId: liveTask.id,
      kind: "task",
      state: "runnable",
      attempt: 1,
      runId: "ccc-prd:import-1",
      stableWorkflowRunId: "ccc-prd:import-1",
      irHash: "a".repeat(64),
    };
    store.listWorkflowWorkItemsForTask = vi.fn(async () => [importedWorkItem]);
    store.transitionWorkflowWorkItem = vi.fn(async () => importedWorkItem);
    const run = vi.spyOn(WorkflowGraphTaskRunner.prototype, "run");

    try {
      await (executor as any).executeWorkflowGraph(liveTask);

      expect(store.transitionWorkflowWorkItem).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
    } finally {
      run.mockRestore();
    }
  });

  it.each([
    ["unwired", undefined],
    ["missing", async () => null],
    ["error", async () => { throw new Error("custody unavailable"); }],
  ])("Task 3: imported task %s custody defers generic execution", async (_case, getCccCampaignContextForTask) => {
    const liveTask = task({ lineageId: "ccc-prd:0123456789abcdef01234567:REQ-1" });
    const { store, executor } = makeExecutorForTask(liveTask);
    if (getCccCampaignContextForTask) store.getCccCampaignContextForTask = vi.fn(getCccCampaignContextForTask);
    const run = vi.spyOn(WorkflowGraphTaskRunner.prototype, "run");

    try {
      await (executor as any).executeWorkflowGraph(liveTask);

      expect(store.getSettings).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
    } finally {
      run.mockRestore();
    }
  });

  it.each([
    ["missing", async () => null],
    ["error", async () => { throw new Error("custody unavailable"); }],
  ])("Task 3: ordinary task %s custody preserves generic execution", async (_case, getCccCampaignContextForTask) => {
    const liveTask = task();
    const { store, executor } = makeExecutorForTask(liveTask);
    store.getCccCampaignContextForTask = vi.fn(getCccCampaignContextForTask);
    const run = vi.spyOn(WorkflowGraphTaskRunner.prototype, "run").mockResolvedValue({
      disposition: "completed",
      outcome: "success",
      visitedNodeIds: ["start"],
    });

    try {
      await (executor as any).executeWorkflowGraph(liveTask);

      expect(store.getSettings).toHaveBeenCalledTimes(1);
      expect(run).toHaveBeenCalledTimes(1);
    } finally {
      run.mockRestore();
    }
  });

  it("Wave 4 verification: public TaskExecutor terminal CCC park bypasses generic in-review routing", async () => {
    const liveTask = task({ status: "in-review", customFields: { cccFusionProfile: "ccc-fusion" } });
    const { store, executor } = makeExecutorForTask(liveTask);
    const workItem = { id: "WI-wave4-terminal", taskId: liveTask.id, kind: "task", state: "running", attempt: 1 };
    store.listWorkflowWorkItemsForTask = vi.fn().mockResolvedValue([workItem]);
    store.transitionWorkflowWorkItem = vi.fn().mockResolvedValue(workItem);
    const run = vi.spyOn(WorkflowGraphTaskRunner.prototype, "run").mockResolvedValue({
      disposition: "failed",
      outcome: "failure",
      reason: "ccc-branch-persistence-terminal-failed",
      context: { "ccc:branch-persistence-failure": "ccc-branch-persistence-terminal-failed" },
      visitedNodeIds: ["start", "A", "split", "B"],
    });

    try {
      await (executor as any).executeWorkflowGraph(liveTask);

      expect(store.transitionWorkflowWorkItem).toHaveBeenCalledWith(workItem.id, "manual-required", expect.objectContaining({
        blockedReason: "ccc-branch-persistence-terminal-failed",
        lastError: "ccc-branch-persistence-terminal-failed",
        leaseOwner: null,
        leaseExpiresAt: null,
      }));
      expect(store.updateTask).toHaveBeenCalledTimes(1);
      expect(store.updateTask).toHaveBeenLastCalledWith(liveTask.id, {
        toolFailureDetectorLogCursor: 0,
      }, undefined);
    } finally {
      run.mockRestore();
    }
  });

  it("Wave 4 RED: fresh CCC branch persistence failure creates and parks a native work item", async () => {
    const liveTask = task({ customFields: { cccFusionProfile: "ccc-fusion" } });
    const { store, executor } = makeExecutorForTask(liveTask);
    const workItem = { id: "WI-wave4-fresh", taskId: liveTask.id, runId: `${liveTask.id}:builtin:coding`, nodeId: "ccc-branch-persistence", kind: "task", state: "running", attempt: 1 };
    store.listWorkflowWorkItemsForTask = vi.fn().mockResolvedValue([]);
    store.upsertWorkflowWorkItem = vi.fn().mockResolvedValue(workItem);
    store.transitionWorkflowWorkItem = vi.fn().mockResolvedValue(workItem);
    const run = vi.spyOn(WorkflowGraphTaskRunner.prototype, "run").mockResolvedValue({
      disposition: "failed",
      outcome: "failure",
      reason: "ccc-branch-persistence-terminal-failed",
      context: { "ccc:branch-persistence-failure": "ccc-branch-persistence-terminal-failed" },
      visitedNodeIds: ["start", "A", "fanout", "B"],
    });

    try {
      await executor.execute(liveTask);

      expect(store.upsertWorkflowWorkItem).toHaveBeenCalledWith(expect.objectContaining({
        runId: `${liveTask.id}:builtin:coding`, taskId: liveTask.id, nodeId: "ccc-branch-persistence", kind: "task", state: "running",
      }));
      expect(store.transitionWorkflowWorkItem).toHaveBeenCalledWith(workItem.id, "manual-required", expect.objectContaining({
        blockedReason: "ccc-branch-persistence-terminal-failed",
        lastError: "ccc-branch-persistence-terminal-failed",
      }));
    } finally {
      run.mockRestore();
    }
  });

  it("Task 6 P1 RED: user hard-cancel fences a late first-run CCC terminal publication", async () => {
    const liveTask = task({ customFields: { cccFusionProfile: "ccc-fusion" } });
    const { store, executor } = makeExecutorForTask(liveTask);
    const workItem = { id: "WI-task6-late-terminal", taskId: liveTask.id, runId: `${liveTask.id}:builtin:coding`, nodeId: "ccc-branch-persistence", kind: "task", state: "running", attempt: 1 };
    store.listWorkflowWorkItemsForTask = vi.fn().mockResolvedValue([]);
    store.upsertWorkflowWorkItem = vi.fn().mockResolvedValue(workItem);
    store.transitionWorkflowWorkItem = vi.fn().mockResolvedValue(workItem);
    let resolveRun!: (result: {
      disposition: "failed";
      outcome: "failure";
      reason: string;
      context: Record<string, unknown>;
      visitedNodeIds: string[];
    }) => void;
    const delayedRun = new Promise<Parameters<typeof resolveRun>[0]>((resolve) => {
      resolveRun = resolve;
    });
    const run = vi.spyOn(WorkflowGraphTaskRunner.prototype, "run").mockReturnValue(delayedRun);
    const execution = executor.execute(liveTask);
    let commitUserMove!: () => void;
    const userMoveCanCommit = new Promise<void>((resolve) => {
      commitUserMove = resolve;
    });
    let userMoveLockAcquired!: () => void;
    const userMoveHasLock = new Promise<void>((resolve) => {
      userMoveLockAcquired = resolve;
    });

    try {
      await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
      const userMove = store.withTaskLock(liveTask.id, async () => {
        await disposeTaskBeforeMove(store, {
          task: liveTask,
          from: "in-progress",
          to: "todo",
          source: "user",
        });
        userMoveLockAcquired();
        await userMoveCanCommit;
        store._setRow(liveTask.id, { column: "todo", paused: true, userPaused: true });
      });
      await userMoveHasLock;
      resolveRun({
        disposition: "failed",
        outcome: "failure",
        reason: "ccc-branch-persistence-terminal-failed",
        context: { "ccc:branch-persistence-failure": "ccc-branch-persistence-terminal-failed" },
        visitedNodeIds: ["start", "A", "fanout", "B"],
      });

      try {
        await vi.waitFor(() => {
          expect(
            store.withTaskLock.mock.calls.length > 1
            || store.upsertWorkflowWorkItem.mock.calls.length > 0,
          ).toBe(true);
        });
        expect(store.upsertWorkflowWorkItem).not.toHaveBeenCalled();
      } finally {
        commitUserMove();
        await userMove;
        await execution;
      }

      expect(store.readTaskForMove).toHaveBeenCalledWith(liveTask.id);
      expect(store.upsertWorkflowWorkItem).not.toHaveBeenCalled();
      expect(store.transitionWorkflowWorkItem).not.toHaveBeenCalled();
    } finally {
      run.mockRestore();
    }
  });

  it("Task 6 P1 RED: first-run terminal publication propagates an authoritative reread failure", async () => {
    const liveTask = task({ customFields: { cccFusionProfile: "ccc-fusion" } });
    const { store, executor } = makeExecutorForTask(liveTask);
    store.listWorkflowWorkItemsForTask = vi.fn().mockResolvedValue([]);
    store.readTaskForMove = vi.fn().mockRejectedValue(new Error("authoritative-task-reread-failed"));
    store.upsertWorkflowWorkItem = vi.fn();
    const run = vi.spyOn(WorkflowGraphTaskRunner.prototype, "run").mockResolvedValue({
      disposition: "failed",
      outcome: "failure",
      reason: "ccc-branch-persistence-terminal-failed",
      context: { "ccc:branch-persistence-failure": "ccc-branch-persistence-terminal-failed" },
      visitedNodeIds: ["start", "A", "fanout", "B"],
    });

    try {
      await expect(executor.execute(liveTask)).rejects.toThrow("authoritative-task-reread-failed");
      expect(store.upsertWorkflowWorkItem).not.toHaveBeenCalled();
    } finally {
      run.mockRestore();
    }
  });

  it("Wave 4 RED: public TaskExecutor parks a classified CCC permanent graph failure once", async () => {
    const liveTask = task({ customFields: { cccFusionProfile: "ccc-fusion" } });
    const { store, executor } = makeExecutorForTask(liveTask);
    const workItem = { id: "WI-wave4-permanent", taskId: liveTask.id, runId: `${liveTask.id}:builtin:coding`, nodeId: "ccc-retry-classification", kind: "task", state: "running", attempt: 1 };
    store.listWorkflowWorkItemsForTask = vi.fn().mockResolvedValue([]);
    store.upsertWorkflowWorkItem = vi.fn().mockResolvedValue(workItem);
    store.transitionWorkflowWorkItem = vi.fn().mockResolvedValue(workItem);
    store.recordRunAuditEvent = vi.fn().mockResolvedValue({});
    const selected = { workflowId: "wave4-actual-permanent", stepIds: [] };
    store.getTaskWorkflowSelectionAsync = vi.fn().mockResolvedValue(selected);
    store.getWorkflowDefinition = vi.fn().mockResolvedValue({
      id: selected.workflowId,
      name: "Wave 4 actual permanent",
      ir: { version: "v2", name: "Wave 4 actual permanent", columns: [], nodes: [{ id: "start", kind: "start" }, { id: "A", kind: "prompt", config: {} }, { id: "end", kind: "end" }], edges: [{ from: "start", to: "A" }, { from: "A", to: "end", condition: "success" }] },
    });
    const customNode = vi.spyOn(executor as any, "runGraphCustomNode").mockRejectedValue(new (await import("../engine-errors.js")).PermanentError("operator action", "CCC_PERMANENT"));
    const graphFailure = vi.spyOn(executor as any, "handleGraphFailure").mockResolvedValue(undefined);
    try {
      await executor.execute(liveTask);
      expect(store.upsertWorkflowWorkItem).toHaveBeenCalledWith(expect.objectContaining({ nodeId: "ccc-retry-classification", state: "running" }));
      expect(store.transitionWorkflowWorkItem).toHaveBeenCalledWith(workItem.id, "manual-required", expect.objectContaining({
        blockedReason: "ccc-permanent:CCC_PERMANENT", lastError: "ccc-permanent:CCC_PERMANENT",
      }));
      expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
        mutationType: "workflow:work-item-transition", metadata: expect.objectContaining({ classification: "ccc-permanent" }),
      }));
    } finally { customNode.mockRestore(); graphFailure.mockRestore(); }
  });

  it("Wave 4 RED: public TaskExecutor exhausts a classified CCC transient graph failure", async () => {
    const liveTask = task({ customFields: { cccFusionProfile: "ccc-fusion" } });
    const { store, executor } = makeExecutorForTask(liveTask);
    const workItem = { id: "WI-wave4-transient", taskId: liveTask.id, runId: `${liveTask.id}:builtin:coding`, nodeId: "ccc-retry-classification", kind: "task", state: "running", attempt: 3 };
    store.listWorkflowWorkItemsForTask = vi.fn().mockResolvedValue([]);
    store.upsertWorkflowWorkItem = vi.fn().mockResolvedValue(workItem);
    store.transitionWorkflowWorkItem = vi.fn().mockResolvedValue(workItem);
    store.recordRunAuditEvent = vi.fn().mockResolvedValue({});
    const selected = { workflowId: "wave4-actual-transient", stepIds: [] };
    store.getTaskWorkflowSelectionAsync = vi.fn().mockResolvedValue(selected);
    store.getWorkflowDefinition = vi.fn().mockResolvedValue({
      id: selected.workflowId,
      name: "Wave 4 actual transient",
      ir: { version: "v2", name: "Wave 4 actual transient", columns: [], nodes: [{ id: "start", kind: "start" }, { id: "A", kind: "prompt", config: { maxRetries: 3 } }, { id: "end", kind: "end" }], edges: [{ from: "start", to: "A" }, { from: "A", to: "end", condition: "success" }] },
    });
    const customNode = vi.spyOn(executor as any, "runGraphCustomNode").mockRejectedValue(new (await import("../engine-errors.js")).TransientError("retry", "CCC_TRANSIENT"));
    const graphFailure = vi.spyOn(executor as any, "handleGraphFailure").mockResolvedValue(undefined);
    try {
      await executor.execute(liveTask);
      expect(customNode).toHaveBeenCalledTimes(3);
      expect(store.transitionWorkflowWorkItem).toHaveBeenCalledWith(workItem.id, "exhausted", expect.objectContaining({
        lastError: "ccc-transient-retry-exhausted:CCC_TRANSIENT",
      }));
      expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
        mutationType: "workflow:work-item-transition", metadata: expect.objectContaining({ classification: "ccc-transient-exhausted" }),
      }));
    } finally { customNode.mockRestore(); graphFailure.mockRestore(); }
  });

  it("Wave 4 verification: public TaskExecutor replaces a stale continuation attempt with the consumed cap", async () => {
    const liveTask = task({ customFields: { cccFusionProfile: "ccc-fusion" } });
    const { store, executor } = makeExecutorForTask(liveTask);
    const stale = { id: "WI-wave4-stale", taskId: liveTask.id, runId: `${liveTask.id}:builtin:coding`, nodeId: "A", kind: "task", state: "running", attempt: 9 };
    store.listWorkflowWorkItemsForTask = vi.fn().mockResolvedValue([stale]);
    store.transitionWorkflowWorkItem = vi.fn().mockResolvedValue({ ...stale, state: "exhausted", attempt: 2 });
    store.recordRunAuditEvent = vi.fn().mockResolvedValue({});
    const selected = { workflowId: "wave4-two-attempt-transient", stepIds: [] };
    store.getTaskWorkflowSelectionAsync = vi.fn().mockResolvedValue(selected);
    store.getWorkflowDefinition = vi.fn().mockResolvedValue({
      id: selected.workflowId,
      name: "Wave 4 two attempts",
      ir: { version: "v2", name: "Wave 4 two attempts", columns: [], nodes: [{ id: "start", kind: "start" }, { id: "A", kind: "prompt", config: { maxRetries: 2 } }, { id: "end", kind: "end" }], edges: [{ from: "start", to: "A" }, { from: "A", to: "end", condition: "success" }] },
    });
    const customNode = vi.spyOn(executor as any, "runGraphCustomNode").mockRejectedValue(new (await import("../engine-errors.js")).TransientError("retry", "CCC_TWO"));
    try {
      await executor.execute(liveTask);
      expect(customNode).toHaveBeenCalledTimes(2);
      expect(store.transitionWorkflowWorkItem).toHaveBeenCalledWith(stale.id, "exhausted", expect.objectContaining({
        attempt: 2,
        lastError: "ccc-transient-retry-exhausted:CCC_TWO",
      }));
      expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
        mutationType: "workflow:work-item-transition",
        metadata: expect.objectContaining({ classification: "ccc-transient-exhausted", attempt: 2 }),
      }));
    } finally { customNode.mockRestore(); }
  });

  it("Wave 4 RED: public TaskExecutor persists a branch terminal's consumed retry cap over a stale continuation", async () => {
    const liveTask = task({ customFields: { cccFusionProfile: "ccc-fusion" } });
    const { store, executor } = makeExecutorForTask(liveTask);
    const stale = { id: "WI-wave4-branch-stale", taskId: liveTask.id, runId: `${liveTask.id}:wave4-branch-retry`, nodeId: "split", kind: "task", state: "running", attempt: 9 };
    store.listWorkflowWorkItemsForTask = vi.fn().mockResolvedValue([stale]);
    store.transitionWorkflowWorkItem = vi.fn().mockResolvedValue({ ...stale, state: "exhausted", attempt: 2 });
    store.recordRunAuditEvent = vi.fn().mockResolvedValue({});
    store.saveWorkflowRunBranch = vi.fn().mockResolvedValue(undefined);
    store.loadWorkflowRunBranches = vi.fn().mockResolvedValue([]);
    store.clearWorkflowRunBranches = vi.fn().mockResolvedValue(undefined);
    const selected = { workflowId: "wave4-branch-two-attempt-transient", stepIds: [] };
    store.getTaskWorkflowSelectionAsync = vi.fn().mockResolvedValue(selected);
    store.getWorkflowDefinition = vi.fn().mockResolvedValue({
      id: selected.workflowId,
      name: "Wave 4 branch two attempts",
      ir: {
        version: "v2",
        name: "Wave 4 branch two attempts",
        columns: [],
        nodes: [
          { id: "start", kind: "start" },
          { id: "split", kind: "split" },
          { id: "retrying-branch", kind: "prompt", config: { maxRetries: 2 } },
          { id: "sibling", kind: "prompt", config: {} },
          { id: "join", kind: "join", config: { mode: "all", onBranchFailure: "fail-fast" } },
          { id: "end", kind: "end" },
        ],
        edges: [
          { from: "start", to: "split" },
          { from: "split", to: "retrying-branch" },
          { from: "split", to: "sibling" },
          { from: "retrying-branch", to: "join", condition: "success" },
          { from: "sibling", to: "join", condition: "success" },
          { from: "join", to: "end", condition: "success" },
        ],
      },
    });
    const customNode = vi.spyOn(executor as any, "runGraphCustomNode").mockImplementation(async (node: { id: string }) => {
      if (node.id === "retrying-branch") {
        throw new (await import("../engine-errors.js")).TransientError("retry", "CCC_BRANCH_TWO");
      }
      return { outcome: "success" };
    });

    try {
      await executor.execute(liveTask);

      expect(customNode).toHaveBeenCalledTimes(3);
      expect(store.transitionWorkflowWorkItem).toHaveBeenCalledWith(stale.id, "exhausted", expect.objectContaining({
        attempt: 2,
        lastError: "ccc-transient-retry-exhausted:CCC_BRANCH_TWO",
      }));
      expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
        mutationType: "workflow:work-item-transition",
        metadata: expect.objectContaining({ classification: "ccc-transient-exhausted", attempt: 2 }),
      }));
    } finally {
      customNode.mockRestore();
    }
  });

  it("Wave 4 RED: public TaskExecutor persists one consumed attempt for a permanent nested branch", async () => {
    const liveTask = task({ customFields: { cccFusionProfile: "ccc-fusion" } });
    const { store, executor } = makeExecutorForTask(liveTask);
    const stale = {
      id: "WI-wave4-nested-permanent-stale",
      taskId: liveTask.id,
      runId: `${liveTask.id}:wave4-nested-permanent`,
      nodeId: "outer-split",
      kind: "task",
      state: "running",
      attempt: 9,
    };
    store.listWorkflowWorkItemsForTask = vi.fn().mockResolvedValue([stale]);
    store.transitionWorkflowWorkItem = vi.fn().mockResolvedValue({ ...stale, state: "manual-required", attempt: 1 });
    store.recordRunAuditEvent = vi.fn().mockResolvedValue({});
    store.saveWorkflowRunBranch = vi.fn().mockResolvedValue(undefined);
    store.loadWorkflowRunBranches = vi.fn().mockResolvedValue([]);
    store.clearWorkflowRunBranches = vi.fn().mockResolvedValue(undefined);
    const selected = { workflowId: "wave4-nested-permanent", stepIds: [] };
    store.getTaskWorkflowSelectionAsync = vi.fn().mockResolvedValue(selected);
    store.getWorkflowDefinition = vi.fn().mockResolvedValue({
      id: selected.workflowId,
      name: "Wave 4 nested permanent",
      ir: {
        version: "v2",
        name: "Wave 4 nested permanent",
        columns: [],
        nodes: [
          { id: "start", kind: "start" },
          { id: "outer-split", kind: "split" },
          { id: "inner-split", kind: "split" },
          { id: "permanent-branch", kind: "prompt", config: { maxRetries: 4 } },
          { id: "inner-sibling", kind: "prompt", config: {} },
          { id: "inner-join", kind: "join", config: { mode: "all", onBranchFailure: "fail-fast" } },
          { id: "outer-sibling", kind: "prompt", config: {} },
          { id: "outer-join", kind: "join", config: { mode: "all", onBranchFailure: "fail-fast" } },
          { id: "end", kind: "end" },
        ],
        edges: [
          { from: "start", to: "outer-split" },
          { from: "outer-split", to: "inner-split" },
          { from: "outer-split", to: "outer-sibling" },
          { from: "inner-split", to: "permanent-branch" },
          { from: "inner-split", to: "inner-sibling" },
          { from: "permanent-branch", to: "inner-join", condition: "success" },
          { from: "inner-sibling", to: "inner-join", condition: "success" },
          { from: "inner-join", to: "outer-join", condition: "success" },
          { from: "outer-sibling", to: "outer-join", condition: "success" },
          { from: "outer-join", to: "end", condition: "success" },
        ],
      },
    });
    let permanentCalls = 0;
    const customNode = vi.spyOn(executor as any, "runGraphCustomNode").mockImplementation(async (node: { id: string }) => {
      if (node.id === "permanent-branch") {
        permanentCalls += 1;
        throw new (await import("../engine-errors.js")).PermanentError("operator action", "CCC_NESTED_PERMANENT");
      }
      return { outcome: "success" };
    });

    try {
      await executor.execute(liveTask);

      expect(permanentCalls).toBe(1);
      expect(store.transitionWorkflowWorkItem).toHaveBeenCalledWith(stale.id, "manual-required", expect.objectContaining({
        attempt: 1,
        lastError: "ccc-permanent:CCC_NESTED_PERMANENT",
      }));
      expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
        mutationType: "workflow:work-item-transition",
        metadata: expect.objectContaining({ classification: "ccc-permanent", attempt: 1 }),
      }));
    } finally {
      customNode.mockRestore();
    }
  });

  it("graph executor with a custom workflow skips custom pre-merge prompt/gate nodes in fast mode", async () => {
    const { store, executor } = makeExecutorForTask(task({ executionMode: "fast", worktree: "/tmp/wt" }));
    const executeStep = vi.spyOn(executor as any, "executeWorkflowStep").mockResolvedValue({ success: true });
    const executeScript = vi.spyOn(executor as any, "executeScriptWorkflowStep").mockResolvedValue({ success: true });

    const definition = {
      id: "WF-fast-custom",
      name: "Fast custom",
      description: "custom workflow",
      kind: "workflow",
      layout: {},
      createdAt: now,
      updatedAt: now,
      ir: {
        version: "v1",
        name: "Fast custom",
        nodes: [
          { id: "start", kind: "start" },
          { id: "custom-review", kind: "prompt", config: { prompt: "Review this" } },
          { id: "custom-gate", kind: "gate", config: { prompt: "Gate this", gateMode: "gate" } },
          { id: "end", kind: "end" },
        ],
        edges: [
          { from: "start", to: "custom-review" },
          { from: "custom-review", to: "custom-gate" },
          { from: "custom-gate", to: "end" },
        ],
      },
    };

    const runner = new WorkflowGraphTaskRunner({
      store: {
        getTaskWorkflowSelection: () => ({ workflowId: "WF-fast-custom", stepIds: [] }),
        getWorkflowDefinition: vi.fn(async () => definition),
      },
      seams: (executor as any).createAuthoritativeWorkflowSeams({}),
      primitives: (executor as any).createAuthoritativeWorkflowPrimitives({ experimentalFeatures: { workflowGraphExecutor: true } }),
      runCustomNode: (node, nodeTask, context) => (executor as any).runGraphCustomNode(node, nodeTask, {}, undefined),
    });

    const result = await runner.run(task({ id: "FN-6226", executionMode: "fast" }), { experimentalFeatures: { workflowGraphExecutor: true } });
    expect(result.disposition).toBe("completed");
    expect(result.visitedNodeIds).toEqual(["start", "custom-review", "custom-gate"]);
    expect(executeStep).not.toHaveBeenCalled();
    expect(executeScript).not.toHaveBeenCalled();
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-6226",
      "Fast mode — custom graph node 'custom-review' skipped",
      undefined,
      undefined,
    );
  });

  it("falls back to the runner task when prepareWorktree cannot trust the live row", async () => {
    const store = createMockStore();
    store.getTask.mockResolvedValue({ ...task({ id: "FN-OTHER", worktree: "/tmp/wrong" }) });
    const executor = new TaskExecutor(store, "/tmp/test");

    const result = await (executor as any)
      .createAuthoritativeWorkflowPrimitives({ experimentalFeatures: { workflowGraphExecutor: true } })
      .prepareWorktree(
        { run: { taskId: "FN-6226" }, node: { node: { id: "execute" }, context: {} } },
        task({ id: "FN-6226", worktree: "/tmp/right", branch: "fusion/fn-6226" }),
      );

    expect(result).toMatchObject({
      outcome: "success",
      data: {
        worktreePath: "/tmp/right",
        branchName: "fusion/fn-6226",
      },
    });
  });

  it("does not project a fresh graph step or capture its baseline before the executor creates its worktree", async () => {
    let liveTask = task({
      steps: [{ name: "Preflight", status: "pending" }],
      worktree: undefined,
      branch: undefined,
      baseCommitSha: undefined,
    });
    const store = createMockStore();
    store.getTask.mockImplementation(async () => liveTask);
    const executor = new TaskExecutor(store, "/tmp/project-root");
    const runGraphTaskStep = vi.spyOn(executor as any, "runGraphTaskStep").mockImplementation(async () => {
      expect(store.updateStep).not.toHaveBeenCalled();
      liveTask = {
        ...liveTask,
        worktree: "/tmp/project-root/.worktrees/fresh-step",
        branch: "fusion/fn-6226",
        baseCommitSha: "fresh-worktree-base",
        steps: [{ name: "Preflight", status: "done" }],
      };
      return { success: true };
    });

    const result = await (executor as any)
      .createAuthoritativeWorkflowPrimitives({ experimentalFeatures: { workflowGraphExecutor: true } })
      .runTaskStep(
        {
          run: { taskId: liveTask.id },
          node: {
            node: { id: "steps#0:step-execute" },
            context: {
              [FOREACH_ACTIVE_CONTEXT_KEY]: {
                foreachNodeId: "steps",
                stepIndex: 0,
                instanceId: "steps#0",
              },
            },
          },
        },
        liveTask,
        0,
      );

    expect(runGraphTaskStep).toHaveBeenCalledTimes(1);
    expect(store.updateStep).not.toHaveBeenCalled();
    expect(result).toEqual({
      outcome: "success",
      baselineSha: "fresh-worktree-base",
      checkpointId: undefined,
    });
  });

  it("defers truthy missing and non-directory worktrees until acquisition", async () => {
    for (const [worktree, exists, directory] of [
      ["/tmp/fn-8464-missing-worktree", false, false],
      ["/tmp/fn-8464-file-worktree", true, false],
    ]) {
      let liveTask = task({
        steps: [{ name: "Preflight", status: "pending" }],
        worktree,
        baseCommitSha: undefined,
      });
      const store = createMockStore();
      store.getTask.mockImplementation(async () => liveTask);
      mockedExistsSync.mockReturnValue(exists);
      mockedStatSync.mockReturnValue({ isDirectory: () => directory } as any);
      const executor = new TaskExecutor(store, "/tmp/project-root");
      vi.spyOn(executor as any, "runGraphTaskStep").mockImplementation(async () => {
        expect(store.updateStep).not.toHaveBeenCalled();
        liveTask = { ...liveTask, worktree: "/tmp/acquired", baseCommitSha: "acquired-base" };
        return { success: true };
      });

      const result = await (executor as any).runProjectedGraphTaskStep(
        liveTask,
        liveTask,
        0,
        { foreachNodeId: "steps", stepIndex: 0, instanceId: "steps#0" },
      );

      expect(result).toMatchObject({ outcome: "success", baselineSha: "acquired-base" });
      expect(mockedExec).not.toHaveBeenCalled();
    }
  });

  it("defers a worktree whose directory stat throws instead of propagating a cwd race", async () => {
    let liveTask = task({
      steps: [{ name: "Preflight", status: "pending" }],
      worktree: "/tmp/fn-8464-stat-race",
      baseCommitSha: undefined,
    });
    const store = createMockStore();
    store.getTask.mockImplementation(async () => liveTask);
    mockedStatSync.mockImplementation(() => {
      throw new Error("simulated removal race");
    });
    const executor = new TaskExecutor(store, "/tmp/project-root");
    vi.spyOn(executor as any, "runGraphTaskStep").mockImplementation(async () => {
      expect(store.updateStep).not.toHaveBeenCalled();
      liveTask = { ...liveTask, worktree: "/tmp/acquired", baseCommitSha: "acquired-base" };
      return { success: true };
    });

    await expect(
      (executor as any).runProjectedGraphTaskStep(
        liveTask,
        liveTask,
        0,
        { foreachNodeId: "steps", stepIndex: 0, instanceId: "steps#0" },
      ),
    ).resolves.toMatchObject({ outcome: "success", baselineSha: "acquired-base" });
    expect(mockedExec).not.toHaveBeenCalled();
  });

  it("captures a pre-step baseline when the projected worktree is a directory", async () => {
    const liveTask = task({
      steps: [{ name: "Preflight", status: "pending" }],
      worktree: "/tmp/fn-8464-existing-worktree",
    });
    const store = createMockStore();
    store.getTask.mockResolvedValue(liveTask);
    mockedExistsSync.mockReturnValue(true);
    mockedStatSync.mockReturnValue({ isDirectory: () => true } as any);
    mockedExec.mockImplementation((_command: string, _options: unknown, callback: any) => {
      callback(null, "existing-head\n", "");
      return {} as any;
    });
    const executor = new TaskExecutor(store, "/tmp/project-root");
    const runGraphTaskStep = vi
      .spyOn(executor as any, "runGraphTaskStep")
      .mockResolvedValue({ success: true });

    const result = await (executor as any).runProjectedGraphTaskStep(
      liveTask,
      liveTask,
      0,
      { foreachNodeId: "steps", stepIndex: 0, instanceId: "steps#0" },
    );

    expect(result).toMatchObject({ outcome: "success", baselineSha: "existing-head" });
    expect(runGraphTaskStep).toHaveBeenCalledOnce();
    expect(store.updateStep).toHaveBeenCalledWith("FN-6226", 0, "in-progress", { source: "graph" });
    expect(mockedExec).toHaveBeenCalledWith("git rev-parse HEAD", { cwd: liveTask.worktree }, expect.any(Function));
  });

  it("applies missing-worktree step ordering through the legacy graph seam", async () => {
    let liveTask = task({
      steps: [{ name: "Preflight", status: "pending" }],
      worktree: "/tmp/fn-8464-legacy-missing-worktree",
      baseCommitSha: undefined,
    });
    mockedExistsSync.mockReturnValue(false);
    const store = createMockStore();
    store.getTask.mockImplementation(async () => liveTask);
    const executor = new TaskExecutor(store, "/tmp/project-root");
    vi.spyOn(executor as any, "runGraphTaskStep").mockImplementation(async () => {
      expect(store.updateStep).not.toHaveBeenCalled();
      liveTask = {
        ...liveTask,
        worktree: "/tmp/project-root/.worktrees/fresh-step",
        baseCommitSha: "fresh-worktree-base",
        steps: [{ name: "Preflight", status: "done" }],
      };
      return { success: true };
    });
    const active = {
      foreachNodeId: "steps",
      stepIndex: 0,
      instanceId: "steps#0",
    };

    const result = await executor.createAuthoritativeWorkflowSeams({} as any).stepExecute?.(
      liveTask,
      { [FOREACH_ACTIVE_CONTEXT_KEY]: active },
    );

    expect(store.updateStep).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      outcome: "success",
      contextPatch: {
        [FOREACH_ACTIVE_CONTEXT_KEY]: {
          baselineSha: "fresh-worktree-base",
          checkpointId: undefined,
        },
      },
    });
  });

  it("fast builtin:coding still parses and executes steps while disabled optional groups stay inert", async () => {
    const calls: string[] = [];
    const prompt = "# Task\n\n## Steps\n\n### Step 1: Do the work\n- [ ] edit files";
    const taskSteps = [{ name: "Do the work", status: "pending" }];
    const seams = {
      planning: vi.fn(async () => {
        calls.push("plan");
        return { outcome: "success", value: "planned" };
      }),
      execute: vi.fn(async () => {
        calls.push("legacy-execute");
        return { outcome: "success", value: "implemented" };
      }),
      review: vi.fn(async () => {
        calls.push("review");
        return { outcome: "success", value: "approved" };
      }),
      merge: vi.fn(async () => {
        calls.push("merge");
        return { outcome: "success", value: "merged" };
      }),
      schedule: vi.fn(async () => ({ outcome: "success", value: "scheduled" })),
      stepExecute: vi.fn(async (_task, context) => {
        calls.push(`step-execute:${context["foreach:active"]?.stepIndex}`);
        return { outcome: "success", value: "step-done" };
      }),
    };
    const runner = new WorkflowGraphTaskRunner({
      store: {
        getTaskWorkflowSelection: () => ({ workflowId: "builtin:coding", stepIds: [] }),
        getWorkflowDefinition: vi.fn(async (id: string) => getBuiltinWorkflow(id)),
      },
      seams,
      parseStepsDeps: {
        readArtifact: async (_target, key) => key === "PROMPT.md" ? prompt : undefined,
        writeSteps: async (target) => {
          calls.push("parse");
          target.steps = taskSteps;
        },
      },
      runCustomNode: vi.fn(async (node) => {
        calls.push(`custom:${node.id}`);
        return { outcome: "success", value: "custom-ok" };
      }),
    });

    const result = await runner.run(task({
      id: "FN-6226",
      executionMode: "fast",
      enabledWorkflowSteps: [],
      prompt,
    }), { experimentalFeatures: { workflowGraphExecutor: true } });

    expect(result.disposition).toBe("completed");
    expect(result.visitedNodeIds).toContain("parse");
    expect(result.visitedNodeIds).toContain("steps#0:step-execute");
    expect(result.visitedNodeIds).toContain("browser-verification");
    expect(result.visitedNodeIds).not.toContain("browser-verification::browser-verification-step");
    expect(result.visitedNodeIds).toContain("code-review");
    expect(result.visitedNodeIds).not.toContain("code-review::code-review-step");
    expect(result.visitedNodeIds).not.toContain("workflow-step");
    expect(calls).toContain("parse");
    expect(calls).toContain("step-execute:0");
    expect(calls).not.toContain("legacy-execute");
    /*
    FNXC:WorkflowFastMode 2026-07-01-00:00:
    The default built-in now resolves to the stepwise final-review workflow. In raw fast-mode compatibility runs, default-on review groups are skipped as custom nodes and the legacy review seam is not invoked; the merge seam remains the lifecycle suffix assertion.
    */
    expect(seams.review).not.toHaveBeenCalled();
    expect(seams.merge).toHaveBeenCalledTimes(1);
  });

  it("raw fast mode skips skill executor nodes when primitives are unavailable", async () => {
    const runCustomNode = vi.fn(async () => ({ outcome: "success", value: "ran-skill" }));
    const runner = new WorkflowGraphTaskRunner({
      store: {
        getTaskWorkflowSelection: () => ({ workflowId: "WF-fast-skill", stepIds: [] }),
        getWorkflowDefinition: vi.fn(async () => ({
          id: "WF-fast-skill",
          name: "Fast skill",
          description: "custom skill workflow",
          kind: "workflow",
          layout: {},
          createdAt: now,
          updatedAt: now,
          ir: {
            version: "v1",
            name: "Fast skill",
            nodes: [
              { id: "start", kind: "start" },
              { id: "skill-review", kind: "prompt", config: { executor: "skill", skillName: "compound-engineering:ce-code-review" } },
              { id: "end", kind: "end" },
            ],
            edges: [
              { from: "start", to: "skill-review" },
              { from: "skill-review", to: "end", condition: "success" },
            ],
          },
        })),
      },
      seams: {
        planning: vi.fn(async () => ({ outcome: "success", value: "planned" })),
        execute: vi.fn(async () => ({ outcome: "success", value: "implemented" })),
        review: vi.fn(async () => ({ outcome: "success", value: "approved" })),
        merge: vi.fn(async () => ({ outcome: "success", value: "merged" })),
        schedule: vi.fn(async () => ({ outcome: "success", value: "scheduled" })),
      },
      runCustomNode,
    });

    const result = await runner.run(task({ executionMode: "fast" }), { experimentalFeatures: { workflowGraphExecutor: true } });

    expect(result.disposition).toBe("completed");
    expect(result.visitedNodeIds).toEqual(["start", "skill-review"]);
    expect(runCustomNode).not.toHaveBeenCalled();
  });

  it("raw fast mode still invokes non-executable review seam nodes", async () => {
    const review = vi.fn(async () => ({ outcome: "success" as const, value: "approved" }));
    const runCustomNode = vi.fn(async () => ({ outcome: "failure" as const, value: "unexpected-custom-node" }));
    const runner = new WorkflowGraphTaskRunner({
      store: {
        getTaskWorkflowSelection: () => ({ workflowId: "WF-fast-review-seam", stepIds: [] }),
        getWorkflowDefinition: vi.fn(async () => ({
          id: "WF-fast-review-seam",
          name: "Fast review seam",
          description: "custom review seam workflow",
          kind: "workflow",
          layout: {},
          createdAt: now,
          updatedAt: now,
          ir: {
            version: "v1",
            name: "Fast review seam",
            nodes: [
              { id: "start", kind: "start" },
              { id: "review", kind: "prompt", config: { seam: "review" } },
              { id: "end", kind: "end" },
            ],
            edges: [
              { from: "start", to: "review" },
              { from: "review", to: "end", condition: "success" },
            ],
          },
        })),
      },
      seams: {
        planning: vi.fn(async () => ({ outcome: "success", value: "planned" })),
        execute: vi.fn(async () => ({ outcome: "success", value: "implemented" })),
        review,
        merge: vi.fn(async () => ({ outcome: "success", value: "merged" })),
        schedule: vi.fn(async () => ({ outcome: "success", value: "scheduled" })),
      },
      runCustomNode,
    });

    const result = await runner.run(task({ executionMode: "fast" }), { experimentalFeatures: { workflowGraphExecutor: true } });

    expect(result.disposition).toBe("completed");
    expect(result.visitedNodeIds).toEqual(["start", "review"]);
    expect(review).toHaveBeenCalledTimes(1);
    expect(runCustomNode).not.toHaveBeenCalled();
  });

  it("fast builtin:coding executes explicitly selected optional-group template nodes", async () => {
    const calls: string[] = [];
    const prompt = "# Task\n\n## Steps\n\n### Step 1: Do the work\n- [ ] edit files";
    const taskSteps = [{ name: "Do the work", status: "pending" }];
    const seams = {
      planning: vi.fn(async () => ({ outcome: "success", value: "planned" })),
      execute: vi.fn(async () => ({ outcome: "success", value: "implemented" })),
      review: vi.fn(async () => ({ outcome: "success", value: "approved" })),
      merge: vi.fn(async () => ({ outcome: "success", value: "merged" })),
      schedule: vi.fn(async () => ({ outcome: "success", value: "scheduled" })),
      stepExecute: vi.fn(async () => ({ outcome: "success", value: "step-done" })),
    };
    const runner = new WorkflowGraphTaskRunner({
      store: {
        getTaskWorkflowSelection: () => ({ workflowId: "builtin:coding", stepIds: [] }),
        getWorkflowDefinition: vi.fn(async (id: string) => getBuiltinWorkflow(id)),
      },
      seams,
      parseStepsDeps: {
        readArtifact: async (_target, key) => key === "PROMPT.md" ? prompt : undefined,
        writeSteps: async (target) => {
          target.steps = taskSteps;
        },
      },
      runCustomNode: vi.fn(async (node) => {
        calls.push(`custom:${node.id}`);
        return { outcome: "success", value: "APPROVE" };
      }),
    });

    const result = await runner.run(task({
      id: "FN-7283",
      executionMode: "fast",
      enabledWorkflowSteps: ["browser-verification"],
      prompt,
    }), { experimentalFeatures: { workflowGraphExecutor: true } });

    expect(result.disposition).toBe("completed");
    expect(result.visitedNodeIds).toContain("browser-verification::browser-verification-step");
    expect(calls).toContain("custom:browser-verification-step");
    expect(result.visitedNodeIds).toContain("code-review");
    expect(result.visitedNodeIds).not.toContain("code-review::code-review-step");
  });

  it("blocks fast builtin:coding merge when parsed implementation proof is missing", async () => {
    const liveTask = task({
      id: "FN-7271",
      executionMode: "fast",
      enabledWorkflowSteps: [],
      column: "in-progress",
      steps: [],
      prompt: "# Task\n\n## Steps\n\n### Step 1: Do the work\n- [ ] edit files",
    });
    const store = createMockStore();
    store.getTask.mockResolvedValue(liveTask);
    store.getTaskWorkflowSelection = vi.fn(() => ({ workflowId: "builtin:coding", stepIds: [] }));
    store.getWorkflowDefinition = vi.fn(async (id: string) => getBuiltinWorkflow(id));
    store.moveTask.mockResolvedValue({ ...liveTask, column: "in-review" });
    const executor = new TaskExecutor(store, "/tmp/test") as any;
    const mergeRequester = vi.fn(async () => ({ merged: true }));
    executor.setMergeRequester(mergeRequester);

    const result = await executor.createAuthoritativeWorkflowPrimitives({ autoMerge: true }).requestMerge(
      {
        run: { runId: "FN-7271:builtin:coding", taskId: "FN-7271", workflowId: "builtin-stepwise-final-review-coding" },
        node: { node: { id: "merge" } },
      },
      liveTask,
    );

    expect(result).toMatchObject({
      outcome: "failure",
      value: "implementation-incomplete",
      data: { reason: "implementation-incomplete" },
    });
    expect(mergeRequester).not.toHaveBeenCalled();
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-7271",
      expect.stringContaining("Workflow merge blocked before requester: implementation did not run"),
      undefined,
      undefined,
    );
  });


  it("allows noCommitsExpected builtin:coding merge even when parsed implementation steps are empty", async () => {
    const liveTask = task({
      id: "FN-1165-NOOP",
      executionMode: "fast",
      enabledWorkflowSteps: [],
      column: "in-progress",
      steps: [],
      noCommitsExpected: true,
      branch: null,
      worktree: null,
      prompt: "# Task\n\n## Steps\n\n### Step 1: Decide\n- [ ] Record no-code decision",
    });
    const inReviewTask = { ...liveTask, column: "in-review" } as typeof liveTask;
    const doneTask = {
      ...liveTask,
      column: "done",
      mergeDetails: {
        mergeConfirmed: true,
        noOpMerge: true,
        noOpReason: "no-commits-expected",
      },
    } as typeof liveTask;
    const store = createMockStore();
    store.getTask.mockResolvedValue(liveTask);
    store.getTaskWorkflowSelection = vi.fn(() => ({ workflowId: "builtin:coding", stepIds: [] }));
    store.getWorkflowDefinition = vi.fn(async (id: string) => getBuiltinWorkflow(id));
    store.moveTask
      .mockResolvedValueOnce(inReviewTask)
      .mockResolvedValueOnce(doneTask);
    const executor = new TaskExecutor(store, "/tmp/test") as any;
    const mergeRequester = vi.fn(async () => ({
      task: inReviewTask,
      merged: true,
      noOp: true,
      mergeConfirmed: true,
      reason: "no-commits-expected",
    }));
    executor.setMergeRequester(mergeRequester);

    const result = await executor.createAuthoritativeWorkflowPrimitives({ autoMerge: true }).requestMerge(
      {
        run: { runId: "FN-1165-NOOP:builtin:coding", taskId: "FN-1165-NOOP", workflowId: "builtin-stepwise-final-review-coding" },
        node: { node: { id: "merge" } },
      },
      liveTask,
    );

    expect(result).toMatchObject({ outcome: "success", value: "merge-noop" });
    expect(mergeRequester).toHaveBeenCalledWith("FN-1165-NOOP", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(store.logEntry).not.toHaveBeenCalledWith(
      "FN-1165-NOOP",
      expect.stringContaining("implementation did not run"),
      undefined,
      undefined,
    );
    expect(store.moveTask).toHaveBeenCalledWith("FN-1165-NOOP", "done", expect.objectContaining({ preserveProgress: true }));
  });

  it("fast builtin:coding executes plain Steps-section headings from fast triage specs", async () => {
    const calls: string[] = [];
    const prompt = `# Task

## Steps

### Preflight
- [ ] inspect

### Implementation
- [ ] edit

### Testing & Verification
- [ ] test
`;
    const seams = {
      planning: vi.fn(async () => ({ outcome: "success", value: "planned" })),
      execute: vi.fn(async () => ({ outcome: "success", value: "implemented" })),
      review: vi.fn(async () => ({ outcome: "success", value: "approved" })),
      merge: vi.fn(async () => ({ outcome: "success", value: "merged" })),
      schedule: vi.fn(async () => ({ outcome: "success", value: "scheduled" })),
      stepExecute: vi.fn(async (_task, context) => {
        calls.push(`step-execute:${context["foreach:active"]?.stepIndex}`);
        return { outcome: "success", value: "step-done" };
      }),
    };
    const runner = new WorkflowGraphTaskRunner({
      store: {
        getTaskWorkflowSelection: () => ({ workflowId: "builtin:coding", stepIds: [] }),
        getWorkflowDefinition: vi.fn(async (id: string) => getBuiltinWorkflow(id)),
      },
      seams,
      parseStepsDeps: {
        readArtifact: async (_target, key) => key === "PROMPT.md" ? prompt : undefined,
        writeSteps: async (target, steps) => {
          target.steps = steps;
        },
      },
      runCustomNode: vi.fn(async () => ({ outcome: "success" })),
    });

    const result = await runner.run(task({
      id: "FN-7260",
      executionMode: "fast",
      enabledWorkflowSteps: [],
      prompt,
    }), { experimentalFeatures: { workflowGraphExecutor: true } });

    expect(result.disposition).toBe("completed");
    expect(result.visitedNodeIds).toContain("steps#0:step-execute");
    expect(result.visitedNodeIds).toContain("steps#1:step-execute");
    expect(result.visitedNodeIds).toContain("steps#2:step-execute");
    expect(calls).toEqual(["step-execute:0", "step-execute:1", "step-execute:2"]);
    expect(seams.merge).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["standard", "standard"],
    ["undefined", undefined],
    ["null", null],
  ])("runs custom pre-merge prompt nodes in %s execution mode", async (_label, executionMode) => {
    const { executor } = makeExecutorForTask(task({ executionMode, worktree: "/tmp/wt" }));
    const executeStep = vi.spyOn(executor as any, "executeWorkflowStep").mockResolvedValue({ success: true });

    const result = await (executor as any).runGraphCustomNode(
      { id: "custom-review", kind: "prompt", config: { prompt: "Review this" } },
      task({ executionMode }),
      {},
      undefined,
    );

    expect(result.outcome).toBe("success");
    expect(result.value).toBe("passed");
    expect(executeStep).toHaveBeenCalledTimes(1);
  });

  it.each(["prompt", "script", "gate"])("skips custom %s nodes in fast mode before workflow-step execution", async (kind) => {
    const { executor } = makeExecutorForTask(task({ executionMode: "fast", worktree: "/tmp/wt" }));
    const executeStep = vi.spyOn(executor as any, "executeWorkflowStep").mockResolvedValue({ success: true });
    const executeScript = vi.spyOn(executor as any, "executeScriptWorkflowStep").mockResolvedValue({ success: true });
    const config = kind === "script" ? { scriptName: "lint" } : { prompt: "check" };

    const result = await (executor as any).runGraphCustomNode(
      { id: `custom-${kind}`, kind, config },
      task({ executionMode: "fast" }),
      {},
      undefined,
    );

    expect(result).toMatchObject({ outcome: "success", value: "workflow-step-skipped" });
    expect(executeStep).not.toHaveBeenCalled();
    expect(executeScript).not.toHaveBeenCalled();
  });

  it.each([
    ["completion-summary id", { id: "completion-summary", kind: "prompt", config: { prompt: "summarize" } }],
    ["summaryTarget task", { id: "custom-summary", kind: "prompt", config: { prompt: "summarize", summaryTarget: "task" } }],
  ])("does not skip completion summary nodes in fast mode by %s", async (_label, node) => {
    const { executor } = makeExecutorForTask(task({ executionMode: "fast", worktree: "/tmp/wt" }));
    const executeStep = vi.spyOn(executor as any, "executeWorkflowStep").mockResolvedValue({ success: true, output: "Done." });

    const result = await (executor as any).runGraphCustomNode(
      node,
      task({ executionMode: "fast" }),
      {},
      undefined,
    );

    expect(result).toMatchObject({ outcome: "success", value: "passed" });
    expect(executeStep).toHaveBeenCalledTimes(1);
  });

  it.each(["prompt", "script", "gate"])("executes optional-group template %s nodes in fast mode", async (kind) => {
    const { executor } = makeExecutorForTask(task({ executionMode: "fast", worktree: "/tmp/wt" }));
    const executeStep = vi.spyOn(executor as any, "executeWorkflowStep").mockResolvedValue({ success: true });
    const executeScript = vi.spyOn(executor as any, "executeScriptWorkflowStep").mockResolvedValue({ success: true });
    const config = kind === "script" ? { scriptName: "lint" } : { prompt: "check" };

    const result = await (executor as any).runGraphCustomNode(
      { id: `custom-${kind}`, kind, config },
      task({ executionMode: "fast" }),
      {},
      undefined,
      { "workflow:optionalGroupActive": "browser-verification" },
    );

    expect(result).toMatchObject({ outcome: "success" });
    if (kind === "script") {
      expect(executeScript).toHaveBeenCalledTimes(1);
      expect(executeStep).not.toHaveBeenCalled();
    } else {
      expect(executeStep).toHaveBeenCalledTimes(1);
      expect(executeScript).not.toHaveBeenCalled();
    }
  });

  it("does not bypass await-input custom graph nodes in fast mode", async () => {
    const { executor } = makeExecutorForTask(task({ executionMode: "fast" }));
    const awaitInput = vi.spyOn(executor as any, "runAwaitInputNode").mockResolvedValue({ outcome: "success", value: "awaiting-input" });

    const result = await (executor as any).runGraphCustomNode(
      { id: "human", kind: "prompt", config: { awaitInput: true } },
      task({ executionMode: "fast" }),
      {},
      undefined,
    );

    expect(result.value).toBe("awaiting-input");
    expect(awaitInput).toHaveBeenCalledTimes(1);
  });

  it("Task 6 RED: fenced CCC graph model node refuses before native Pi session when provider binding cannot be created", async () => {
    const nodeTask = task({
      executionMode: "fast",
      worktree: "/tmp/ccc-provider-binding",
      modelProvider: "openai",
      modelId: "gpt-4o",
    });
    const { store, executor } = makeExecutorForTask(nodeTask);
    store.getAsyncLayer = vi.fn(() => ({}) as any);
    const failure = new Error("provider attempt is not admitted");
    createCccCampaignProviderAttemptBindingMock.mockRejectedValueOnce(failure);
    const execution = Object.freeze({
      originTaskId: nodeTask.id,
      semanticTaskId: "FN-6226-semantic",
      semanticTask: task({ id: "FN-6226-semantic" }),
      runId: "FN-6226-run",
      visitIdentity: Object.freeze({ nodeId: "provider-node", materializedNodeId: "provider-node" }),
      executionFence: Object.freeze({ workItemId: "wi-provider-binding", leaseOwner: "provider-worker", attempt: 1, runId: "FN-6226-run" }),
      providerAttemptTurnKey: "ccc-provider-turn-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    });

    await expect((executor as any).executeWorkflowStep(
      nodeTask,
      {
        id: "provider-model",
        name: "Provider model",
        mode: "prompt",
        phase: "pre-merge",
        gateMode: "advisory",
        prompt: "Do the bounded work.",
        toolMode: "readonly",
        enabled: true,
      },
      "/tmp/ccc-provider-binding",
      { executionProvider: "openai", executionModelId: "gpt-4o" },
      undefined,
      { execution },
    )).rejects.toThrow("provider attempt is not admitted");

    expect(createCccCampaignProviderAttemptBindingMock).toHaveBeenCalledTimes(1);
    expect(mockedCreateFnAgent).not.toHaveBeenCalled();
    expect(store.logEntry).not.toHaveBeenCalled();
  });

  it("Task 6 RED: fenced CCC graph model node passes sealed provider attempt binding to native Pi with actual provider and model", async () => {
    const nodeTask = task({
      executionMode: "fast",
      worktree: "/tmp/ccc-provider-binding",
      modelProvider: "openai",
      modelId: "gpt-4o",
    });
    const { store, executor } = makeExecutorForTask(nodeTask);
    store.getAsyncLayer = vi.fn(() => ({}) as any);
    const signal = new AbortController().signal;
    const turnKey = "ccc-provider-turn-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const binding = Object.freeze({
      turnKey,
      controller: Object.freeze({ preDispatch: vi.fn(), reconcile: vi.fn() }),
    });
    createCccCampaignProviderAttemptBindingMock.mockResolvedValueOnce(binding);
    mockedCreateFnAgent.mockResolvedValue({
      session: {
        subscribe: vi.fn(() => vi.fn()),
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      },
    });
    const execution = Object.freeze({
      originTaskId: nodeTask.id,
      semanticTaskId: "FN-6226-semantic",
      semanticTask: task({ id: "FN-6226-semantic" }),
      runId: "FN-6226-run",
      visitIdentity: Object.freeze({ nodeId: "provider-node", materializedNodeId: "provider-node" }),
      executionFence: Object.freeze({ workItemId: "wi-provider-binding", leaseOwner: "pi-provider-worker", attempt: 1, runId: "FN-6226-run" }),
      providerAttemptTurnKey: turnKey,
    });

    await (executor as any).executeWorkflowStep(
      nodeTask,
      {
        id: "provider-model",
        name: "Provider model",
        mode: "prompt",
        phase: "pre-merge",
        gateMode: "advisory",
        prompt: "Do the bounded work.",
        toolMode: "readonly",
        enabled: true,
      },
      "/tmp/ccc-provider-binding",
      { executionProvider: "openai", executionModelId: "gpt-4o" },
      undefined,
      { execution, signal },
    );

    expect(createCccCampaignProviderAttemptBindingMock).toHaveBeenCalledWith(expect.objectContaining({
      originTaskId: execution.originTaskId,
      semanticTaskId: "FN-6226-semantic",
      turnKey: execution.providerAttemptTurnKey,
      workItemFence: Object.freeze({
        workItemId: execution.executionFence.workItemId,
        runId: execution.executionFence.runId,
        attempt: execution.executionFence.attempt,
      }),
      workItemLeaseOwner: execution.executionFence.leaseOwner,
      signal,
      expectedRoute: Object.freeze({ providerId: "openai", modelId: "gpt-4o", transport: "pi" }),
    }));
    expect(mockedCreateFnAgent).toHaveBeenCalledWith(expect.objectContaining({
      runtimeHint: "pi",
      profile: "ccc-fusion",
      subscriptionReady: true,
      cccProviderAttemptBinding: binding,
    }));
    const piOptions = mockedCreateFnAgent.mock.calls.find(([options]: any[]) => options?.cccProviderAttemptBinding === binding)?.[0] as any;
    expect(piOptions.cccProviderAttemptBinding).toBe(binding);
    expect(Object.isFrozen(binding)).toBe(true);
    expect(Object.isFrozen(binding.controller)).toBe(true);
    expect(binding.turnKey).toBe(execution.providerAttemptTurnKey);
  });

  it("Task provider-fence RED: workflow-extension resolver passes the sealed execution fence into provider binding", async () => {
    const nodeTask = task({ executionMode: "fast", worktree: "/tmp/ccc-provider-binding" });
    const { store, executor } = makeExecutorForTask(nodeTask);
    store.getAsyncLayer = vi.fn(() => ({}) as any);
    const binding = Object.freeze({
      providerController: Object.freeze({ preDispatch: vi.fn(), reconcile: vi.fn() }),
      providerRoute: Object.freeze({
        providerId: "openai",
        modelId: "gpt-4o",
        transport: "workflow",
        workflowExtensionId: "plugin:ccc-campaign:provider",
      }),
    });
    createCccCampaignProviderAttemptBindingMock.mockResolvedValueOnce(binding);
    const executionFence = Object.freeze({
      workItemId: "wi-workflow-provider-binding",
      leaseOwner: "workflow-provider-worker",
      attempt: 2,
      runId: "FN-6226-workflow-run",
    });
    const execution = Object.freeze({
      originTaskId: nodeTask.id,
      semanticTaskId: "FN-6226-semantic",
      nativeTaskId: nodeTask.id,
      semanticTask: task({ id: "FN-6226-semantic" }),
      runId: executionFence.runId,
      visitIdentity: Object.freeze({ nodeId: "provider-node", materializedNodeId: "provider-node" }),
      executionFence,
      providerAttemptTurnKey: "ccc-provider-turn-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    });
    const signal = new AbortController().signal;

    const resolver = executor.createCccCampaignWorkflowNodeProviderControllerResolver();
    await expect(resolver({
      node: { id: "provider-node", kind: "prompt" },
      semanticTask: execution.semanticTask,
      workflow: { id: "workflow-1", name: "Workflow", version: 1, nodes: [], edges: [] },
      extensionId: "plugin:ccc-campaign:provider",
      execution,
      signal,
    } as any)).resolves.toBe(binding);

    expect(createCccCampaignProviderAttemptBindingMock).toHaveBeenCalledWith(expect.objectContaining({
      originTaskId: execution.originTaskId,
      semanticTaskId: execution.semanticTaskId,
      nativeTaskId: execution.nativeTaskId,
      turnKey: execution.providerAttemptTurnKey,
      workItemFence: Object.freeze({
        workItemId: executionFence.workItemId,
        runId: executionFence.runId,
        attempt: executionFence.attempt,
      }),
      workItemLeaseOwner: executionFence.leaseOwner,
      signal,
      workflowProviderBinding: true,
    }));
  });

  it.each([undefined, " bad-owner "])("Task provider-owner RED: workflow-extension route refuses noncanonical lease owner %s", async (leaseOwner) => {
    const nodeTask = task({ executionMode: "fast", worktree: "/tmp/ccc-provider-binding" });
    const { store, executor } = makeExecutorForTask(nodeTask);
    store.getAsyncLayer = vi.fn(() => ({}) as any);
    createCccCampaignProviderAttemptBindingMock.mockResolvedValueOnce(Object.freeze({}));
    const execution = Object.freeze({
      originTaskId: nodeTask.id,
      semanticTaskId: "FN-6226-semantic",
      nativeTaskId: nodeTask.id,
      semanticTask: task({ id: "FN-6226-semantic" }),
      runId: "FN-6226-workflow-run",
      visitIdentity: Object.freeze({ nodeId: "provider-node", materializedNodeId: "provider-node" }),
      executionFence: Object.freeze({
        workItemId: "wi-workflow-provider-binding",
        ...(leaseOwner === undefined ? {} : { leaseOwner }),
        attempt: 2,
        runId: "FN-6226-workflow-run",
      }),
      providerAttemptTurnKey: "ccc-provider-turn-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    });

    const resolver = executor.createCccCampaignWorkflowNodeProviderControllerResolver();
    await expect(resolver({
      node: { id: "provider-node", kind: "prompt" },
      semanticTask: execution.semanticTask,
      workflow: { id: "workflow-1", name: "Workflow", version: 1, nodes: [], edges: [] },
      extensionId: "plugin:ccc-campaign:provider",
      execution,
    } as any)).rejects.toThrow(/lease owner/i);
    expect(createCccCampaignProviderAttemptBindingMock).not.toHaveBeenCalled();
  });

  it.each([undefined, " bad-owner "])("Task provider-owner RED: Pi route refuses noncanonical lease owner %s", async (leaseOwner) => {
    const nodeTask = task({ executionMode: "fast", worktree: "/tmp/ccc-provider-binding" });
    const { store, executor } = makeExecutorForTask(nodeTask);
    store.getAsyncLayer = vi.fn(() => ({}) as any);
    createCccCampaignProviderAttemptBindingMock.mockResolvedValueOnce(Object.freeze({}));
    const execution = Object.freeze({
      originTaskId: nodeTask.id,
      semanticTaskId: "FN-6226-semantic",
      nativeTaskId: nodeTask.id,
      semanticTask: task({ id: "FN-6226-semantic" }),
      runId: "FN-6226-pi-run",
      visitIdentity: Object.freeze({ nodeId: "provider-node", materializedNodeId: "provider-node" }),
      executionFence: Object.freeze({
        workItemId: "wi-pi-provider-binding",
        ...(leaseOwner === undefined ? {} : { leaseOwner }),
        attempt: 2,
        runId: "FN-6226-pi-run",
      }),
      providerAttemptTurnKey: "ccc-provider-turn-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    });

    await expect((executor as any).createCccProviderAttemptBindingForWorkflowStep({
      execution,
      provider: "openai",
      modelId: "gpt-4o",
    })).rejects.toThrow(/lease owner/i);
    expect(createCccCampaignProviderAttemptBindingMock).not.toHaveBeenCalled();
  });

  it("Task 4 RED: fenced CLI node without a host-native binding refuses before log or session effects", async () => {
    const nodeTask = task({
      executionMode: "fast",
      worktree: "/tmp/cli-test",
      modelProvider: "openai",
      modelId: "gpt-4o",
    });
    const { store, executor } = makeExecutorForTask(nodeTask);
    const resolveMcpServers = vi.fn(async () => []);
    const resolveMcpServersSpy = vi.spyOn(executor as any, "resolveMcpServers").mockImplementation(resolveMcpServers);
    const executionFence = Object.freeze({
      workItemId: "wi-cli-binding-red",
      attempt: 1,
      runId: "FN-6226-run",
    });
    const execution = Object.freeze({
      originTaskId: "FN-6226",
      semanticTaskId: "FN-6226-semantic",
      semanticTask: task({ id: "FN-6226-semantic", executionMode: "fast" }),
      runId: "FN-6226-run",
      visitIdentity: Object.freeze({
        nodeId: "cli-node",
        materializedNodeId: "cli-node",
      }),
      executionFence,
      providerAttemptTurnKey: "ccc-cli-turn-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    });
    const graphContext = Object.freeze({});
    const sealedExecutionContext = Object.freeze({
      task: nodeTask,
      settings: undefined,
      context: {},
      execution,
    });

    let result: unknown;
    let failure: unknown;
    try {
      result = await (executor as any).runGraphCustomNode(
        {
          id: "cli-native-node",
          kind: "prompt",
          config: {
            executor: "cli-agent",
            cliAdapterId: "test-cli-adapter",
            cliSettings: { profile: "ccc-fusion" },
            prompt: "test cli",
          },
        },
        nodeTask,
        {},
        undefined,
        graphContext,
        sealedExecutionContext,
      );
    } catch (err) {
      failure = err;
    } finally {
      resolveMcpServersSpy.mockRestore();
    }

    expect(failure).toMatchObject({ code: "CCC_NATIVE_CLI_BINDING_REFUSED" });
    expect(result).toBeUndefined();

    expect(store.logEntry).not.toHaveBeenCalled();
    expect(store.updateTask).not.toHaveBeenCalled();
    expect(resolveMcpServers).not.toHaveBeenCalled();
  });

  it.each(["mutable", "extra-key"])("Task 4 RED: validates $case host-native CLI binding before preDispatch or effects", async (caseName) => {
    const nodeTask = task({
      executionMode: "fast",
      worktree: "/tmp/cli-test",
      modelProvider: "openai",
      modelId: "gpt-4o",
    });
    const store = createMockStore();
    store.getTask.mockImplementation(async (id: string) => ({ ...nodeTask, id }));
    store.getSettings.mockResolvedValue({
      autoMerge: false,
      experimentalFeatures: { workflowGraphExecutor: true },
    });
    const runtimeStore = {
      listByTask: vi.fn(async () => []),
    };
    const preDispatch = vi.fn();
    const reconcile = vi.fn();
    const observe = vi.fn();
    const binding = {
      kind: "ccc-fusion.native-cli-binding",
      version: 1,
      id: "fusion-native:ccc-cli-one-shot",
      turnKey: "ccc-cli-turn-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      dispatchKey: "cli-agent:1",
      route: Object.freeze({
        adapterId: "test-cli-adapter",
        providerId: "openai",
        modelId: "gpt-4o",
        transport: "cli",
      }),
      limits: Object.freeze({
        maxRequests: 1,
        lifetimeMs: 60000,
        termGraceMs: 5000,
        killClosureMs: 5000,
      }),
      followUp: false,
      observer: Object.freeze({
        id: "ccc-native-cli-observer.v1",
        observe,
      }),
      controller: Object.freeze({
        preDispatch,
        reconcile,
      }),
    };
    const resolveCccNativeCliBinding = vi.fn(async () => {
      const candidate = { ...binding };
      return caseName === "extra-key"
        ? Object.freeze({ ...candidate, unexpected: "unexpected-key" })
        : candidate;
    });
    const executor = new TaskExecutor(store, "/tmp/test", {
      cliAgentRuntime: {
        manager: {
          preflightPtyRuntime: vi.fn(async () => undefined),
        } as any,
        hub: {} as any,
        registry: {} as any,
        store: runtimeStore,
        projectId: "test",
        hookEndpointUrl: "http://127.0.0.1:1/unused",
        resolveCccNativeCliBinding,
      } as any,
    } as any);
    const resolveMcpServers = vi.fn(async () => []);
    const resolveMcpServersSpy = vi.spyOn(executor as any, "resolveMcpServers").mockImplementation(resolveMcpServers);

    const executionFence = Object.freeze({
      workItemId: "wi-cli-binding-red",
      attempt: 1,
      runId: "FN-6226-run",
    });
    const execution = Object.freeze({
      originTaskId: "FN-6226",
      semanticTaskId: "FN-6226-semantic",
      semanticTask: task({ id: "FN-6226-semantic", executionMode: "fast" }),
      runId: "FN-6226-run",
      visitIdentity: Object.freeze({
        nodeId: "cli-node",
        materializedNodeId: "cli-node",
      }),
      executionFence,
      providerAttemptTurnKey: "ccc-cli-turn-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    });
    const graphContext = Object.freeze({});
    const sealedExecutionContext = Object.freeze({
      task: nodeTask,
      settings: undefined,
      context: {},
      execution,
    });

    let result: unknown;
    let failure: unknown;
    try {
      result = await (executor as any).runGraphCustomNode(
        {
          id: "cli-native-node",
          kind: "prompt",
          config: {
            executor: "cli-agent",
            cliAdapterId: "test-cli-adapter",
            cliSettings: {
              profile: "ccc-fusion",
              providerId: "openai",
              model: "gpt-4o",
            },
            prompt: "test cli",
          },
        },
        nodeTask,
        {},
        undefined,
        graphContext,
        sealedExecutionContext,
      );
    } catch (err) {
      failure = err;
    } finally {
      resolveMcpServersSpy.mockRestore();
    }

    expect(failure).toMatchObject({ code: "CCC_NATIVE_CLI_BINDING_REFUSED" });
    expect(result).toBeUndefined();
    expect(resolveCccNativeCliBinding).toHaveBeenCalledTimes(1);
    if (caseName === "mutable") {
      expect(String((failure as any)?.message ?? "")).toMatch(/frozen/i);
    } else {
      expect(String((failure as any)?.message ?? "")).toMatch(/exact|keys/i);
    }

    expect(preDispatch).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
    expect(observe).not.toHaveBeenCalled();
    expect(runtimeStore.listByTask).not.toHaveBeenCalled();
    expect(resolveMcpServers).not.toHaveBeenCalled();
    expect(store.logEntry).not.toHaveBeenCalled();
    expect(store.updateTask).not.toHaveBeenCalled();
  });

  // U4 (KTD-2): the legacy `workflow-step` seam and `runWorkflowStep` primitive
  // were removed, so the two it.each blocks that drove them directly (fast-mode
  // skip + standard-mode run) are gone. Fast-mode skip of workflow gates is now
  // covered above by the custom-node tests ("skips custom %s nodes in fast mode")
  // and by builtin-coding-workflow-step-results.test.ts (graph recording path).

  it("re-enters graph recovery for fast completed tasks with unsatisfied explicit optional steps", async () => {
    const liveTask = task({
      id: "FN-7283-RECOVERY",
      executionMode: "fast",
      enabledWorkflowSteps: ["browser-verification"],
      worktree: "/tmp/wt",
      baseCommitSha: "base",
      steps: [{ name: "Do it", status: "done" }],
      workflowStepResults: [],
    });
    const { executor } = makeExecutorForTask(liveTask);
    vi.spyOn(executor as any, "captureModifiedFiles").mockResolvedValue([]);
    const graph = vi.spyOn(executor as any, "executeWorkflowGraph").mockResolvedValue(undefined);

    const recovered = await executor.recoverCompletedTask(liveTask as any);

    expect(recovered).toBe(true);
    expect(graph).toHaveBeenCalledWith(liveTask);
  });

  /*
  FNXC:EngineTests 2026-07-19-18:20 (U10b):
  The requirement under test is a store that CANNOT resolve a workflow selection (minimal/older embedded
  adapters). The shared harness supplies both selection readers, so the reader-less shape is reconstructed
  explicitly here — otherwise the graph resolves builtin:coding and this branch is never reached.
  The park is now UNCONDITIONAL: with the legacy execute fallback deleted, the graph is the only executor,
  so a store that cannot resolve a workflow must park loudly whether or not the task has explicit
  `enabledWorkflowSteps` — the old "no enabled steps means nothing to gate" carve-out would now silently run
  nothing. Both step shapes are asserted so the carve-out cannot be reintroduced.
  */
  it.each([
    ["explicit optional steps", ["browser-verification"]],
    ["no enabled steps", []],
  ])("fails closed when the store cannot resolve workflow selection (%s)", async (_label, enabledWorkflowSteps) => {
    const liveTask = task({
      id: "FN-7283-MINIMAL-STORE",
      executionMode: "fast",
      enabledWorkflowSteps,
      worktree: "/tmp/wt",
    });
    const store = createMockStore();
    store.getTask.mockResolvedValue(liveTask);
    delete (store as any).getTaskWorkflowSelection;
    delete (store as any).getTaskWorkflowSelectionAsync;
    const executor = new TaskExecutor(store, "/tmp/test") as any;
    const graphFailure = vi.spyOn(executor, "handleGraphFailure").mockResolvedValue(undefined);

    await executor.executeWorkflowGraph(liveTask);

    expect(graphFailure).toHaveBeenCalledWith(liveTask, expect.objectContaining({
      disposition: "failed",
      outcome: "failure",
      reason: expect.stringContaining("workflow-selection-api-unavailable"),
    }));
  });

  it("skips graph recovery for fast completed tasks with no explicit optional steps", async () => {
    const liveTask = task({
      id: "FN-7283-RECOVERY-EMPTY",
      executionMode: "fast",
      enabledWorkflowSteps: [],
      worktree: "/tmp/wt",
      baseCommitSha: "base",
      steps: [{ name: "Do it", status: "done" }],
      workflowStepResults: [],
    });
    const { store, executor } = makeExecutorForTask(liveTask);
    vi.spyOn(executor as any, "captureModifiedFiles").mockResolvedValue([]);
    const graph = vi.spyOn(executor as any, "executeWorkflowGraph").mockResolvedValue(undefined);

    const recovered = await executor.recoverCompletedTask(liveTask as any);

    expect(recovered).toBe(true);
    expect(graph).not.toHaveBeenCalled();
    expect(store.handoffToReview).toHaveBeenCalledWith(
      "FN-7283-RECOVERY-EMPTY",
      expect.objectContaining({ evidence: expect.objectContaining({ reason: "completed-task-recovered" }) }),
    );
  });

  /*
  FNXC:WorkflowReviewGates 2026-07-19-02:40:
  U10 (R9) tombstone: `fn_review_step` is deleted outright. Neither fast nor standard mode may
  inject it — review gates are graph nodes, and a second in-session review authority is exactly
  the duplicate-Plan-Review defect the cutover removes. `fn_task_done` stays mandatory in both.
  */
  it("keeps fn_task_done mandatory while never injecting fn_review_step in fast mode", async () => {
    mockedCreateFnAgent.mockImplementation(async (opts: any) => ({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
        sessionManager: {
          getLeafId: vi.fn().mockReturnValue("leaf"),
          branchWithSummary: vi.fn(),
          navigateTree: vi.fn().mockResolvedValue({ cancelled: false }),
        },
        navigateTree: vi.fn().mockResolvedValue({ cancelled: false }),
      },
      capturedTools: opts.customTools,
    }));
    const store = createMockStore();
    store.getTask.mockResolvedValue(task({ id: "FN-TOOLS", executionMode: "fast" }));
    const executor = new TaskExecutor(store, "/tmp/test");

    await executor.execute(task({ id: "FN-TOOLS", executionMode: "fast" }));

    expect(allSessionToolNames()).toContain("fn_task_done");
    expect(allSessionToolNames()).not.toContain("fn_review_step");
  });

  it("never injects fn_review_step in standard mode either", async () => {
    mockedCreateFnAgent.mockImplementation(async (opts: any) => ({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
        sessionManager: {
          getLeafId: vi.fn().mockReturnValue("leaf"),
          branchWithSummary: vi.fn(),
          navigateTree: vi.fn().mockResolvedValue({ cancelled: false }),
        },
        navigateTree: vi.fn().mockResolvedValue({ cancelled: false }),
      },
      capturedTools: opts.customTools,
    }));
    const store = createMockStore();
    store.getTask.mockResolvedValue(task({ id: "FN-TOOLS", executionMode: "standard" }));
    const executor = new TaskExecutor(store, "/tmp/test");

    await executor.execute(task({ id: "FN-TOOLS", executionMode: "standard" }));

    expect(allSessionToolNames()).toContain("fn_task_done");
    expect(allSessionToolNames()).not.toContain("fn_review_step");
  });

});
