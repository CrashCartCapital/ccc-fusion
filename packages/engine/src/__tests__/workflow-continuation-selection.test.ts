import { describe, expect, it, vi } from "vitest";
import type { Task, TaskStore, WorkflowWorkItem } from "@fusion/core";
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
      executor: { execute: ReturnType<typeof vi.fn> };
      cccCampaignWorkflowRuntime: object;
      campaignWorkflowContinuationsInFlight: Set<string>;
      drainWorkflowContinuations: () => Promise<void>;
    };
    runtime.status = "active";
    runtime.taskStore = store;
    runtime.executor = { execute: vi.fn() };
    runtime.cccCampaignWorkflowRuntime = {};

    await runtime.drainWorkflowContinuations();
    await firstClaimStarted;
    await runtime.drainWorkflowContinuations();

    expect(matchingClaimReads).toBe(1);
    expect(store.acquireWorkflowWorkItemLease).not.toHaveBeenCalled();

    releaseFirstClaim();
    await vi.waitFor(() => {
      expect(runtime.campaignWorkflowContinuationsInFlight.size).toBe(0);
    });
  });
});
