import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  __setTaskMoveDisposalTimeoutForTesting,
  isTaskMoveDisposalActive,
  registerTaskMoveDisposer,
} from "../../task-move-disposer.js";
import { readTaskRow } from "../../task-store/async-persistence.js";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
} from "../../__test-utils__/pg-test-harness.js";
import { BUILTIN_CODING_WORKFLOW_IR } from "../../builtin-coding-workflow-ir.js";
import type { WorkflowIrV2 } from "../../workflow-ir-types.js";

function workflowWithCustomImplementationColumn(): WorkflowIrV2 {
  const ir = structuredClone(BUILTIN_CODING_WORKFLOW_IR) as WorkflowIrV2;
  ir.name = "custom-hard-cancel-workflow";
  const implementation = ir.columns.find((column) => column.id === "in-progress");
  if (!implementation) throw new Error("expected built-in implementation column");
  implementation.id = "implementing";
  implementation.name = "Implementing";
  for (const node of ir.nodes) {
    if (node.column === "in-progress") node.column = "implementing";
  }
  return ir;
}

/*
FNXC:TaskMovement 2026-07-18-14:32:
Surface enumeration for the hard-cancel invariant:
 - A user move from in-progress to Todo waits for executor cancellation before persistence.
 - The durable task stays in-progress throughout a delayed cancellation.
 - A wedged cancellation times out fail-closed and releases the per-task lock.
 - Engine moves, forward moves, and other destinations do not invoke the user-cancel seam
   (covered by task-move-disposer.test.ts).
 - Main, step, workflow, configured-command, subagent, and CLI surfaces share the executor's
   awaitAbortInFlightTaskWork path (covered by executor-user-cancel.test.ts).
*/
pgDescribe("user move to Todo hard-cancel ordering", () => {
  const harness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_task_move_cancel" });
  beforeAll(harness.beforeAll);
  beforeEach(harness.beforeEach);
  afterEach(harness.afterEach);
  afterAll(harness.afterAll);

  async function expectHeldHardCancel(args: {
    fromColumn: string;
    workItemId: string;
    prepare: (store: ReturnType<typeof harness.store>, taskId: string) => Promise<void>;
  }): Promise<void> {
    const store = harness.store();
    const created = await store.createTask({ description: `Hard cancel from ${args.fromColumn}` });
    await args.prepare(store, created.id);
    const workItem = await store.upsertWorkflowWorkItem({
      id: args.workItemId,
      runId: `run-${args.workItemId}`,
      taskId: created.id,
      nodeId: "execute",
      kind: "task",
      state: "runnable",
      attempt: 0,
    });
    let releaseCancellation = () => undefined;
    const disposer = vi.fn(() => new Promise<void>((resolve) => { releaseCancellation = resolve; }));
    const unregister = registerTaskMoveDisposer(store, disposer);
    let eventPublished = false;
    const onTaskMoved = ({ task }: { task: typeof created }) => {
      if (task.id === created.id && task.column === "todo") eventPublished = true;
    };
    store.on("task:moved", onTaskMoved);
    let moveSettled = false;
    const move = store.moveTask(created.id, "todo", { moveSource: "user" })
      .finally(() => { moveSettled = true; });

    try {
      await vi.waitFor(() => expect(disposer).toHaveBeenCalledOnce());
      expect({
        intentActive: isTaskMoveDisposalActive(store, created.id),
        durableTaskColumn: (await readTaskRow(store.asyncLayer!, created.id))?.column,
        durableWorkItemState: (await store.getWorkflowWorkItem(workItem.id))?.state,
        eventPublished,
        moveSettled,
      }).toEqual({
        intentActive: true,
        durableTaskColumn: args.fromColumn,
        durableWorkItemState: "runnable",
        eventPublished: false,
        moveSettled: false,
      });

      releaseCancellation();
      await expect(move).resolves.toMatchObject({ column: "todo", userPaused: true });
      await expect(store.getWorkflowWorkItem(workItem.id)).resolves.toMatchObject({
        state: "cancelled",
        leaseOwner: null,
        leaseExpiresAt: null,
      });
      expect(eventPublished).toBe(true);
      expect(isTaskMoveDisposalActive(store, created.id)).toBe(false);
    } finally {
      releaseCancellation();
      await move.catch(() => undefined);
      store.off("task:moved", onTaskMoved);
      unregister();
    }
  }

  it("hard-cancels custom implementing task work before publishing Todo", async () => {
    await expectHeldHardCancel({
      fromColumn: "implementing",
      workItemId: "WW-custom-hard-cancel",
      prepare: async (store, taskId) => {
        await store.updateGlobalSettings({ experimentalFeatures: { workflowColumns: true } });
        const workflow = await store.createWorkflowDefinition({
          name: "Custom hard cancel",
          ir: workflowWithCustomImplementationColumn(),
        });
        await store.selectTaskWorkflow(taskId, workflow.id);
        await store.moveTask(taskId, "todo", { moveSource: "engine" });
        await store.moveTask(taskId, "implementing", {
          moveSource: "scheduler",
          bypassGuards: true,
        });
      },
    });
  });

  it("hard-cancels in-review task work before publishing Todo", async () => {
    await expectHeldHardCancel({
      fromColumn: "in-review",
      workItemId: "WW-review-hard-cancel",
      prepare: async (store, taskId) => {
        await store.moveTask(taskId, "todo", { moveSource: "engine" });
        await store.moveTask(taskId, "in-progress", { moveSource: "scheduler" });
        await store.moveTask(taskId, "in-review", {
          moveSource: "engine",
          bypassGuards: true,
        });
      },
    });
  });

  it("preserves legacy userPaused semantics for a user reopen from done to Todo", async () => {
    const store = harness.store();
    const created = await store.createTask({ description: "Reopen completed work" });
    await store.moveTask(created.id, "todo", { moveSource: "engine" });
    await store.moveTask(created.id, "in-progress", { moveSource: "scheduler" });
    await store.moveTask(created.id, "in-review", {
      moveSource: "engine",
      bypassGuards: true,
    });
    await store.moveTask(created.id, "done", {
      moveSource: "engine",
      skipMergeBlocker: true,
    });

    await expect(store.moveTask(created.id, "todo", { moveSource: "user" }))
      .resolves.toMatchObject({ column: "todo", userPaused: true });
  });

  it("keeps the durable task in-progress until cancellation finishes", async () => {
    const store = harness.store();
    const created = await store.createTask({ description: "Stop before returning to Todo" });
    await store.moveTask(created.id, "todo", { moveSource: "engine" });
    await store.moveTask(created.id, "in-progress", { moveSource: "scheduler" });

    let resolveCancellation: (() => void) | undefined;
    const cancellation = new Promise<void>((resolve) => {
      resolveCancellation = resolve;
    });
    const disposer = vi.fn(() => cancellation);
    const unregister = registerTaskMoveDisposer(store, disposer);

    try {
      const move = store.moveTask(created.id, "todo", { moveSource: "user" });
      await vi.waitFor(() => expect(disposer).toHaveBeenCalledOnce());

      expect((await readTaskRow(store.asyncLayer!, created.id))?.column).toBe("in-progress");

      resolveCancellation?.();
      await expect(move).resolves.toMatchObject({ column: "todo", userPaused: true });
      expect((await store.getTask(created.id)).column).toBe("todo");
    } finally {
      resolveCancellation?.();
      unregister();
    }
  });

  it("Task 6 P1 RED: move intent remains active through task publication and clears after return", async () => {
    const store = harness.store();
    const created = await store.createTask({ description: "Publish under active move intent" });
    await store.moveTask(created.id, "todo", { moveSource: "engine" });
    await store.moveTask(created.id, "in-progress", { moveSource: "scheduler" });
    let activeAtPublication = false;
    store.once("task:moved", ({ task }) => {
      if (task.id === created.id && task.column === "todo") {
        activeAtPublication = isTaskMoveDisposalActive(store, created.id);
      }
    });

    await expect(store.moveTask(created.id, "todo", { moveSource: "user" })).resolves.toMatchObject({ column: "todo" });
    expect(activeAtPublication).toBe(true);
    expect(isTaskMoveDisposalActive(store, created.id)).toBe(false);
  });

  it("Task 6 P1: move intent clears when publication fails after disposal", async () => {
    const store = harness.store();
    const created = await store.createTask({ description: "Clear intent after publication failure" });
    await store.moveTask(created.id, "todo", { moveSource: "engine" });
    await store.moveTask(created.id, "in-progress", { moveSource: "scheduler" });
    vi.spyOn(store, "writeTaskJsonFile").mockRejectedValueOnce(new Error("fixture publication failure"));

    await expect(store.moveTask(created.id, "todo", { moveSource: "user" }))
      .rejects.toThrow("fixture publication failure");
    expect(isTaskMoveDisposalActive(store, created.id)).toBe(false);
  });

  it("Task 6 P1 RED: Todo and active task-work cancellation commit atomically", async () => {
    const store = harness.store();
    const created = await store.createTask({ description: "Commit hard cancel atomically" });
    await store.moveTask(created.id, "todo", { moveSource: "engine" });
    await store.moveTask(created.id, "in-progress", { moveSource: "scheduler" });
    const workItem = await store.upsertWorkflowWorkItem({
      id: "WW-task-move-atomic",
      runId: "run-task-move-atomic",
      taskId: created.id,
      nodeId: "execute",
      kind: "task",
      state: "runnable",
      attempt: 0,
    });
    let releaseCancellation!: () => void;
    const cancellationHeld = new Promise<void>((resolve) => { releaseCancellation = resolve; });
    let signalCancellationEntered!: (value: { hasTransaction: boolean }) => void;
    const cancellationEntered = new Promise<{ hasTransaction: boolean }>((resolve) => {
      signalCancellationEntered = resolve;
    });
    const originalCancellation = store.cancelActiveWorkflowWorkItemsForTask.bind(store);
    const cancellationSpy = vi.spyOn(store, "cancelActiveWorkflowWorkItemsForTask").mockImplementation(async (taskId, opts, tx) => {
      if (taskId === created.id && opts.kinds?.includes("task")) {
        signalCancellationEntered({ hasTransaction: tx !== undefined });
        await cancellationHeld;
      }
      return originalCancellation(taskId, opts, tx);
    });
    let eventPublished = false;
    const onTaskMoved = ({ task }: { task: typeof created }) => {
      if (task.id === created.id && task.column === "todo") eventPublished = true;
    };
    store.once("task:moved", onTaskMoved);
    let moveSettled = false;
    let move: ReturnType<typeof store.moveTask> | undefined;

    try {
      move = store.moveTask(created.id, "todo", { moveSource: "user" })
        .finally(() => { moveSettled = true; });
      try {
        const placement = await cancellationEntered;
        const durableTask = await readTaskRow(store.asyncLayer!, created.id);
        const durableWorkItem = await store.getWorkflowWorkItem(workItem.id);
        expect({
          cancellationHasTransaction: placement.hasTransaction,
          durableTaskColumn: durableTask?.column,
          durableWorkItemState: durableWorkItem?.state,
          eventPublished,
          moveSettled,
        }).toEqual({
          cancellationHasTransaction: true,
          durableTaskColumn: "in-progress",
          durableWorkItemState: "runnable",
          eventPublished: false,
          moveSettled: false,
        });
      } finally {
        releaseCancellation();
      }

      await expect(move).resolves.toMatchObject({ column: "todo", userPaused: true });
      await expect(store.getWorkflowWorkItem(workItem.id)).resolves.toMatchObject({
        state: "cancelled",
        leaseOwner: null,
        leaseExpiresAt: null,
      });
    } finally {
      releaseCancellation();
      await move?.catch(() => undefined);
      store.off("task:moved", onTaskMoved);
      cancellationSpy.mockRestore();
    }
  });

  it("Task 6 P1 RED: task-work cancellation failure rolls the Todo move back", async () => {
    const store = harness.store();
    const created = await store.createTask({ description: "Rollback failed hard cancel" });
    await store.moveTask(created.id, "todo", { moveSource: "engine" });
    await store.moveTask(created.id, "in-progress", { moveSource: "scheduler" });
    const workItem = await store.upsertWorkflowWorkItem({
      id: "WW-task-move-rollback",
      runId: "run-task-move-rollback",
      taskId: created.id,
      nodeId: "execute",
      kind: "task",
      state: "runnable",
      attempt: 0,
    });
    const originalCancellation = store.cancelActiveWorkflowWorkItemsForTask.bind(store);
    const cancellationSpy = vi.spyOn(store, "cancelActiveWorkflowWorkItemsForTask").mockImplementation(async (taskId, opts, tx) => {
      if (taskId === created.id && opts.kinds?.includes("task") && tx) {
        throw new Error("injected atomic task-work cancellation failure");
      }
      return originalCancellation(taskId, opts, tx);
    });
    let eventPublished = false;
    const onTaskMoved = ({ task }: { task: typeof created }) => {
      if (task.id === created.id && task.column === "todo") eventPublished = true;
    };
    store.once("task:moved", onTaskMoved);

    try {
      let moveError: unknown;
      try {
        await store.moveTask(created.id, "todo", { moveSource: "user" });
      } catch (error) {
        moveError = error;
      }
      const durableTask = await readTaskRow(store.asyncLayer!, created.id);
      const durableWorkItem = await store.getWorkflowWorkItem(workItem.id);
      expect({
        error: moveError instanceof Error ? moveError.message : null,
        durableTaskColumn: durableTask?.column,
        durableWorkItemState: durableWorkItem?.state,
        eventPublished,
      }).toEqual({
        error: "injected atomic task-work cancellation failure",
        durableTaskColumn: "in-progress",
        durableWorkItemState: "runnable",
        eventPublished: false,
      });
    } finally {
      store.off("task:moved", onTaskMoved);
      cancellationSpy.mockRestore();
    }
  });

  it("keeps the task in-progress but releases its lock when cancellation times out", async () => {
    const store = harness.store();
    const created = await store.createTask({ description: "Release a wedged hard cancel" });
    await store.moveTask(created.id, "todo", { moveSource: "engine" });
    await store.moveTask(created.id, "in-progress", { moveSource: "scheduler" });
    const unregister = registerTaskMoveDisposer(store, () => new Promise<void>(() => {}));

    __setTaskMoveDisposalTimeoutForTesting(1);
    try {
      await expect(
        store.moveTask(created.id, "todo", { moveSource: "user" }),
      ).rejects.toThrow(
        `Timed out stopping active work for ${created.id} before moving to Todo`,
      );
    } finally {
      __setTaskMoveDisposalTimeoutForTesting();
      unregister();
    }

    expect((await readTaskRow(store.asyncLayer!, created.id))?.column).toBe("in-progress");
    expect(isTaskMoveDisposalActive(store, created.id)).toBe(false);
    await expect(
      store.moveTask(created.id, "todo", { moveSource: "engine" }),
    ).resolves.toMatchObject({ column: "todo" });
  });
});
