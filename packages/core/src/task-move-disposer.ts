import type { TaskStore } from "./store.js";
import type { ColumnId, Task } from "./types.js";

export type TaskMoveSource = "user" | "engine" | "scheduler";
export type TaskMoveDisposer = (task: Task) => Promise<void>;

export interface TaskMoveDisposalInput {
  task: Task;
  from: ColumnId;
  to: ColumnId;
  source: TaskMoveSource;
  /** Authoritative lifecycle classification supplied by the task store. */
  hardCancel?: boolean;
}

/*
 * Core owns task-transition ordering but cannot import the engine. Keep the
 * cancellation seam store-scoped so one project's executor cannot stop work
 * owned by another store. A set preserves every live owner during overlap.
 */
const disposers = new WeakMap<TaskStore, Set<TaskMoveDisposer>>();
const activeMoveIntents = new WeakMap<TaskStore, Map<string, number>>();
const TASK_MOVE_DISPOSAL_TIMEOUT_MS = 30_000;
let taskMoveDisposalTimeoutMs = TASK_MOVE_DISPOSAL_TIMEOUT_MS;

export function __setTaskMoveDisposalTimeoutForTesting(
  timeoutMs = TASK_MOVE_DISPOSAL_TIMEOUT_MS,
): void {
  taskMoveDisposalTimeoutMs = timeoutMs;
}

export function registerTaskMoveDisposer(store: TaskStore, disposer: TaskMoveDisposer): () => void {
  const registered = disposers.get(store) ?? new Set<TaskMoveDisposer>();
  registered.add(disposer);
  disposers.set(store, registered);
  return () => {
    const current = disposers.get(store);
    current?.delete(disposer);
    if (current?.size === 0) disposers.delete(store);
  };
}

export function getTaskMoveDisposer(store: TaskStore): TaskMoveDisposer | undefined {
  const registered = disposers.get(store);
  if (!registered?.size) return undefined;
  return async (task) => {
    await Promise.all([...registered].map((disposer) => disposer(task)));
  };
}

export function isTaskMoveDisposalActive(store: TaskStore, taskId: string): boolean {
  return (activeMoveIntents.get(store)?.get(taskId) ?? 0) > 0;
}

export async function beginTaskMoveDisposal(
  store: TaskStore,
  input: TaskMoveDisposalInput,
): Promise<() => void> {
  const hardCancel =
    input.hardCancel === true ||
    (input.source === "user" && input.from === "in-progress" && input.to === "todo");
  if (!hardCancel) {
    return () => undefined;
  }

  const taskIntents = activeMoveIntents.get(store) ?? new Map<string, number>();
  taskIntents.set(input.task.id, (taskIntents.get(input.task.id) ?? 0) + 1);
  activeMoveIntents.set(store, taskIntents);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    const current = activeMoveIntents.get(store);
    const remaining = (current?.get(input.task.id) ?? 1) - 1;
    if (remaining > 0) current?.set(input.task.id, remaining);
    else current?.delete(input.task.id);
    if (current?.size === 0) activeMoveIntents.delete(store);
  };

  const disposer = getTaskMoveDisposer(store);
  if (!disposer) return release;

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      disposer(input.task),
      new Promise<void>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`Timed out stopping active work for ${input.task.id} before moving to Todo`));
        }, taskMoveDisposalTimeoutMs);
        timeout.unref?.();
      }),
    ]);
    return release;
  } catch (error) {
    release();
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/**
 * FNXC:WorkflowLifecycle 2026-07-18-14:32:
 * A user move from active execution back to Todo is a hard cancel. Await every
 * registered execution surface before publishing the new column so persisted
 * board state can never claim the task is idle while its agent still runs.
 */
export async function disposeTaskBeforeMove(store: TaskStore, input: TaskMoveDisposalInput): Promise<void> {
  const release = await beginTaskMoveDisposal(store, input);
  release();
}
