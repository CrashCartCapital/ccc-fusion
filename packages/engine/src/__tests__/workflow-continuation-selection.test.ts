import { afterEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskStore, WorkflowWorkItem } from "@fusion/core";
import { executingTaskLock } from "../active-session-registry.js";
import {
  InProcessRuntime,
  isPlanningContinuationTaskDispatchable,
  resolvePlanningContinuationCandidate,
  selectActionablePlanningContinuations,
} from "../runtimes/in-process-runtime.js";

function workItem(
  id: string,
  waitReason: WorkflowWorkItem["waitReason"],
  patch: Partial<WorkflowWorkItem> = {},
): WorkflowWorkItem {
  return { id, taskId: `task-${id}`, waitReason, ...patch } as WorkflowWorkItem;
}

function task(id: string, patch: Partial<Task> = {}): Task {
  return { id, column: "todo", paused: false, userPaused: false, ...patch } as Task;
}

describe("isPlanningContinuationTaskDispatchable", () => {
  it("rejects missing, paused, soft-deleted, archived, and done tasks", () => {
    expect(isPlanningContinuationTaskDispatchable(undefined)).toBe(false);
    expect(isPlanningContinuationTaskDispatchable(null)).toBe(false);
    expect(isPlanningContinuationTaskDispatchable(task("T-1", { paused: true }))).toBe(false);
    expect(isPlanningContinuationTaskDispatchable(task("T-2", { userPaused: true }))).toBe(false);
    expect(isPlanningContinuationTaskDispatchable(task("T-3", { deletedAt: "2026-07-22T05:15:38.174Z" }))).toBe(false);
    expect(isPlanningContinuationTaskDispatchable(task("T-4", { column: "archived" }))).toBe(false);
    expect(isPlanningContinuationTaskDispatchable(task("T-5", { column: "done" }))).toBe(false);
    expect(isPlanningContinuationTaskDispatchable(task("T-6", { column: "todo" }))).toBe(true);
  });
});

describe("resolvePlanningContinuationCandidate", () => {
  it("marks lookup failures and missing tasks as orphans to cancel", () => {
    const item = workItem("orphan-missing", "planning");
    expect(resolvePlanningContinuationCandidate(item, undefined, { taskLookupFailed: true })).toEqual({
      kind: "orphan",
      item,
      reason: "task-not-found",
    });
    expect(resolvePlanningContinuationCandidate(item, null)).toEqual({
      kind: "orphan",
      item,
      reason: "task-not-found",
    });
  });

  it("marks terminal board tasks as orphans even when getTask returns an archive fallback", () => {
    const item = workItem("orphan-terminal", "planning");
    expect(
      resolvePlanningContinuationCandidate(item, task("FN-8470", { column: "archived" })),
    ).toEqual({ kind: "orphan", item, reason: "task-terminal" });
    expect(
      resolvePlanningContinuationCandidate(item, task("FN-8401", { column: "done" })),
    ).toEqual({ kind: "orphan", item, reason: "task-terminal" });
    expect(
      resolvePlanningContinuationCandidate(
        item,
        task("FN-soft", { deletedAt: "2026-07-22T05:15:38.174Z", column: "todo" }),
      ),
    ).toEqual({ kind: "orphan", item, reason: "task-terminal" });
  });

  it("skips non-planning and paused planning items without cancelling", () => {
    const capacity = workItem("cap", "capacity");
    expect(resolvePlanningContinuationCandidate(capacity, task("T-cap"))).toEqual({
      kind: "skip",
      item: capacity,
      reason: "not-planning",
    });

    const paused = workItem("paused", "planning");
    expect(resolvePlanningContinuationCandidate(paused, task("T-p", { paused: true }))).toEqual({
      kind: "skip",
      item: paused,
      reason: "paused",
    });
  });

  it("selects unpaused planning items on live non-terminal tasks", () => {
    const item = workItem("eligible", "planning");
    const live = task("FN-8471", { column: "todo" });
    expect(resolvePlanningContinuationCandidate(item, live)).toEqual({
      kind: "actionable",
      item,
      task: live,
    });
  });
});

describe("selectActionablePlanningContinuations", () => {
  it("retains only planning items whose tasks are present, unpaused, and non-terminal", () => {
    /*
    FNXC:WorkflowScheduling 2026-07-21-22:31:
    Regression for the FN-8470→FN-8471 starvation class: a deleted/archived
    earlier due row must not remain "actionable" and must not prevent a later
    live planning continuation from being selected.
    */
    const selected = selectActionablePlanningContinuations([
      { item: workItem("eligible", "planning"), task: task("T-1") },
      { item: workItem("capacity", "capacity"), task: task("T-2") },
      { item: workItem("missing", "planning"), task: undefined },
      { item: workItem("null-task", "planning"), task: null },
      { item: workItem("no-wait-reason", null), task: task("T-5") },
      { item: workItem("paused", "planning"), task: task("T-3", { paused: true }) },
      { item: workItem("user-paused", "planning"), task: task("T-4", { userPaused: true }) },
      { item: workItem("archived", "planning"), task: task("FN-8470", { column: "archived" }) },
      { item: workItem("done", "planning"), task: task("FN-done", { column: "done" }) },
      { item: workItem("soft-deleted", "planning"), task: task("FN-soft", { deletedAt: "2026-07-22T05:15:38.174Z" }) },
      { item: workItem("later-live", "planning"), task: task("FN-8471", { column: "todo" }) },
    ]);

    expect(selected.map(({ item, task: selectedTask }) => [item.id, selectedTask.id])).toEqual([
      ["eligible", "T-1"],
      ["later-live", "FN-8471"],
    ]);
  });
});

describe("InProcessRuntime campaign continuation dispatch", () => {
  afterEach(() => {
    executingTaskLock._clearForTest();
  });

  it("waits for startup recovery before selecting workflow continuations", async () => {
    let releaseStartupRecovery!: () => void;
    const startupRecovery = new Promise<void>((resolve) => {
      releaseStartupRecovery = resolve;
    });
    const store = {
      listDueWorkflowWorkItems: vi.fn(async () => []),
    } as unknown as TaskStore;
    const runtime = new InProcessRuntime({
      projectId: "startup-recovery-fence",
      workingDirectory: "/tmp/startup-recovery-fence",
      isolationMode: "in-process",
      maxConcurrent: 1,
      maxWorktrees: 1,
    } as never, {} as never) as InProcessRuntime & {
      status: "active";
      taskStore: TaskStore;
      startupRecoveryPromise: Promise<void> | undefined;
      drainWorkflowContinuations: () => Promise<void>;
    };
    runtime.status = "active";
    runtime.taskStore = store;
    runtime.startupRecoveryPromise = startupRecovery;

    const drain = runtime.drainWorkflowContinuations();
    await Promise.resolve();
    await Promise.resolve();

    expect(store.listDueWorkflowWorkItems).not.toHaveBeenCalled();

    releaseStartupRecovery();
    await drain;

    expect(store.listDueWorkflowWorkItems).toHaveBeenCalledTimes(1);
  });

  it("keeps the startup recovery sequence pending until self-healing settles", async () => {
    let releaseSelfHealing!: () => void;
    const selfHealing = new Promise<void>((resolve) => {
      releaseSelfHealing = resolve;
    });
    const runtime = new InProcessRuntime({
      projectId: "startup-recovery-sequence",
      workingDirectory: "/tmp/startup-recovery-sequence",
      isolationMode: "in-process",
      maxConcurrent: 1,
      maxWorktrees: 1,
    } as never, {} as never) as InProcessRuntime & {
      restartRecoveryCoordinator: { recoverInterruptedRuns: ReturnType<typeof vi.fn> };
      selfHealingManager: { runStartupRecovery: ReturnType<typeof vi.fn> };
      resumeStartupRecoverySequence: () => Promise<void>;
    };
    runtime.restartRecoveryCoordinator = {
      recoverInterruptedRuns: vi.fn(async () => undefined),
    };
    runtime.selfHealingManager = {
      runStartupRecovery: vi.fn(async () => selfHealing),
    };

    let settled = false;
    const recovery = runtime.resumeStartupRecoverySequence().then(() => {
      settled = true;
    });
    await vi.waitFor(() => {
      expect(runtime.selfHealingManager.runStartupRecovery).toHaveBeenCalledTimes(1);
    });

    expect(settled).toBe(false);

    releaseSelfHealing();
    await recovery;
    expect(settled).toBe(true);
  });

  it("keeps workflow dispatch blocked after startup recovery fails until a retry succeeds", async () => {
    const startupFailure = new Error("restart recovery unavailable");
    const store = {
      listDueWorkflowWorkItems: vi.fn(async () => []),
    } as unknown as TaskStore;
    const runtime = new InProcessRuntime({
      projectId: "startup-recovery-failure",
      workingDirectory: "/tmp/startup-recovery-failure",
      isolationMode: "in-process",
      maxConcurrent: 1,
      maxWorktrees: 1,
    } as never, {} as never) as InProcessRuntime & {
      status: "active";
      taskStore: TaskStore;
      restartRecoveryCoordinator: { recoverInterruptedRuns: ReturnType<typeof vi.fn> };
      selfHealingManager: { runStartupRecovery: ReturnType<typeof vi.fn> };
      beginStartupRecoverySequence: () => Promise<void>;
      drainWorkflowContinuations: () => Promise<void>;
    };
    runtime.status = "active";
    runtime.taskStore = store;
    runtime.restartRecoveryCoordinator = {
      recoverInterruptedRuns: vi.fn()
        .mockRejectedValueOnce(startupFailure)
        .mockResolvedValueOnce(undefined),
    };
    runtime.selfHealingManager = {
      runStartupRecovery: vi.fn(async () => undefined),
    };

    await expect(runtime.beginStartupRecoverySequence()).rejects.toBe(startupFailure);
    await runtime.drainWorkflowContinuations();
    await runtime.drainWorkflowContinuations();

    expect(store.listDueWorkflowWorkItems).not.toHaveBeenCalled();

    await runtime.beginStartupRecoverySequence();
    await runtime.drainWorkflowContinuations();

    expect(runtime.restartRecoveryCoordinator.recoverInterruptedRuns).toHaveBeenCalledTimes(2);
    expect(runtime.selfHealingManager.runStartupRecovery).toHaveBeenCalledTimes(1);
    expect(store.listDueWorkflowWorkItems).toHaveBeenCalledTimes(1);
  });

  it("keeps workflow dispatch blocked after self-healing startup recovery fails until a retry succeeds", async () => {
    const selfHealingFailure = new Error("self-healing recovery unavailable");
    const store = {
      listDueWorkflowWorkItems: vi.fn(async () => []),
    } as unknown as TaskStore;
    const runtime = new InProcessRuntime({
      projectId: "self-healing-recovery-failure",
      workingDirectory: "/tmp/self-healing-recovery-failure",
      isolationMode: "in-process",
      maxConcurrent: 1,
      maxWorktrees: 1,
    } as never, {} as never) as InProcessRuntime & {
      status: "active";
      taskStore: TaskStore;
      restartRecoveryCoordinator: { recoverInterruptedRuns: ReturnType<typeof vi.fn> };
      selfHealingManager: { runStartupRecovery: ReturnType<typeof vi.fn> };
      beginStartupRecoverySequence: () => Promise<void>;
      drainWorkflowContinuations: () => Promise<void>;
    };
    runtime.status = "active";
    runtime.taskStore = store;
    runtime.restartRecoveryCoordinator = {
      recoverInterruptedRuns: vi.fn(async () => undefined),
    };
    runtime.selfHealingManager = {
      runStartupRecovery: vi.fn()
        .mockRejectedValueOnce(selfHealingFailure)
        .mockResolvedValueOnce(undefined),
    };

    await expect(runtime.beginStartupRecoverySequence()).rejects.toBe(selfHealingFailure);
    await runtime.drainWorkflowContinuations();
    await runtime.drainWorkflowContinuations();

    expect(store.listDueWorkflowWorkItems).not.toHaveBeenCalled();

    await runtime.beginStartupRecoverySequence();
    await runtime.drainWorkflowContinuations();

    expect(runtime.restartRecoveryCoordinator.recoverInterruptedRuns).toHaveBeenCalledTimes(2);
    expect(runtime.selfHealingManager.runStartupRecovery).toHaveBeenCalledTimes(2);
    expect(store.listDueWorkflowWorkItems).toHaveBeenCalledTimes(1);
  });

  it("does not dispatch the same exact candidate while its first claim is in flight", async () => {
    const item = workItem("campaign-in-flight", "planning", {
      runId: "run-campaign-in-flight",
      kind: "task",
      state: "runnable",
      attempt: 0,
    });
    const liveTask = task(item.taskId);
    let matchingClaimReads = 0;
    let releaseFirstClaim!: () => void;
    let reportFirstClaimStarted!: () => void;
    const firstClaimStarted = new Promise<void>((resolve) => {
      reportFirstClaimStarted = resolve;
    });
    const holdFirstClaim = new Promise<void>((resolve) => {
      releaseFirstClaim = resolve;
    });
    const store = {
      listDueWorkflowWorkItems: vi.fn(async () => [item]),
      getTask: vi.fn(async () => liveTask),
      getCccCampaignContextForTask: vi.fn(async () => ({ campaignId: "campaign-in-flight" })),
      getSettings: vi.fn(async () => ({})),
      transitionWorkflowWorkItem: vi.fn(),
      acquireWorkflowWorkItemLease: vi.fn(),
      getWorkflowWorkItem: vi.fn(async (id: string) => {
        if (id === item.id) {
          matchingClaimReads += 1;
          if (matchingClaimReads === 1) {
            reportFirstClaimStarted();
            await holdFirstClaim;
          }
        }
        return null;
      }),
    } as unknown as TaskStore;
    const runtime = new InProcessRuntime({
      projectId: "continuation-fence",
      workingDirectory: "/tmp/continuation-fence",
      isolationMode: "in-process",
      maxConcurrent: 1,
      maxWorktrees: 1,
    } as never, {} as never) as InProcessRuntime & {
      status: "active";
      taskStore: TaskStore;
      executor: {
        execute: ReturnType<typeof vi.fn>;
        tryBeginAuthoritativeWorkflowExecution: (taskId: string) => (() => void) | null;
      };
      cccCampaignWorkflowRuntime: object;
      campaignWorkflowContinuationsInFlight: Set<string>;
      drainWorkflowContinuations: () => Promise<void>;
    };
    runtime.status = "active";
    runtime.taskStore = store;
    runtime.executor = {
      execute: vi.fn(),
      tryBeginAuthoritativeWorkflowExecution: (taskId: string) => {
        if (!executingTaskLock.tryClaim(taskId)) return null;
        return () => executingTaskLock.release(taskId);
      },
    };
    runtime.cccCampaignWorkflowRuntime = {};

    await runtime.drainWorkflowContinuations();
    await firstClaimStarted;
    expect(executingTaskLock.has(item.taskId)).toBe(true);
    await runtime.drainWorkflowContinuations();

    expect(matchingClaimReads).toBe(1);
    expect(store.acquireWorkflowWorkItemLease).not.toHaveBeenCalled();

    releaseFirstClaim();
    await vi.waitFor(() => {
      expect(runtime.campaignWorkflowContinuationsInFlight.size).toBe(0);
    });
    expect(executingTaskLock.has(item.taskId)).toBe(false);
  });
});
