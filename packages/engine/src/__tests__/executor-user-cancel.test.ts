import { describe, it, expect, vi } from "vitest";
import "./executor-test-helpers.js";
import { getTaskMoveDisposer, type TaskStore } from "@fusion/core";
import { activeSessionRegistry } from "../active-session-registry.js";
import { TaskExecutor } from "../executor.js";
import { createMockStore, resetExecutorMocks } from "./executor-test-helpers.js";

interface CancellationTestSession {
  prompt: () => void;
  abort: () => Promise<void>;
  dispose: () => void;
}

interface CancellationTestSessionState {
  session: CancellationTestSession;
  seenSteeringIds: Set<string>;
  lastResolvedModelProvider: string;
}

interface CancellationTestExecutorInternals {
  activeSessions: Map<string, CancellationTestSessionState>;
  activeWorktrees: Map<string, Set<string>>;
  setActiveSession(taskId: string, state: CancellationTestSessionState, worktreePath: string): void;
}

function cancellationTestInternals(executor: TaskExecutor): CancellationTestExecutorInternals {
  return executor as unknown as CancellationTestExecutorInternals;
}

describe("TaskExecutor user cancel handling", () => {
  /*
  FNXC:WorkflowLifecycle 2026-07-18-14:32:
  A user move from active execution to Todo must await every executor
  cancellation surface so the card cannot keep processing in the background.
  */
  it("registers an awaited user-move disposer that aborts all active work before Todo", async () => {
    resetExecutorMocks();
    const store = createMockStore();
    const executor = new TaskExecutor(store as any, "/tmp/test");
    const terminateChildren = vi.spyOn(executor as any, "terminateAllChildren").mockResolvedValue(undefined);
    let resolveAbort: (() => void) | undefined;
    const abortPending = new Promise<void>((resolve) => {
      resolveAbort = resolve;
    });
    const session = {
      prompt: vi.fn(),
      abort: vi.fn(() => abortPending),
      dispose: vi.fn(),
    } as any;
    (executor as any).activeSessions.set("FN-AWAITED", {
      session,
      seenSteeringIds: new Set<string>(),
    });

    const disposer = getTaskMoveDisposer(store as any);
    expect(disposer).toBeTypeOf("function");
    let disposed = false;
    const disposal = disposer!({ id: "FN-AWAITED" } as any).then(() => {
      disposed = true;
    });

    await Promise.resolve();
    expect(terminateChildren).toHaveBeenCalledWith("FN-AWAITED");
    expect(session.abort).toHaveBeenCalledOnce();
    expect(disposed).toBe(false);

    resolveAbort?.();
    await disposal;
    expect(session.dispose).toHaveBeenCalledOnce();
    expect((executor as any).userCanceledTaskIds.has("FN-AWAITED")).toBe(true);
  });

  /*
  FNXC:CCCFusionCancellation 2026-07-23-17:32:
  A custom-provider stream remains the executor's active owner until its async
  abort has closed the stream. Releasing the registry earlier lets a replacement
  run acquire the same task while the original provider still has live effects.
  */
  it("keeps custom-provider ownership registered until its stream abort settles", async () => {
    resetExecutorMocks();
    const store = createMockStore();
    const executor = new TaskExecutor(store as unknown as TaskStore, "/tmp/test");
    const internals = cancellationTestInternals(executor);
    let resolveAbort: (() => void) | undefined;
    const abortPending = new Promise<void>((resolve) => {
      resolveAbort = resolve;
    });
    const session = {
      prompt: vi.fn(),
      abort: vi.fn(() => abortPending),
      dispose: vi.fn(),
    };
    internals.activeSessions.set("FN-CUSTOM-PROVIDER-CLOSE", {
      session,
      seenSteeringIds: new Set<string>(),
      lastResolvedModelProvider: "custom-provider-pi",
    });

    const cleanup = executor.awaitAbortInFlightTaskWork(
      "FN-CUSTOM-PROVIDER-CLOSE",
      "user cancellation",
      { userCanceled: true },
    );

    await Promise.resolve();
    expect(session.abort).toHaveBeenCalledOnce();
    expect(internals.activeSessions.get("FN-CUSTOM-PROVIDER-CLOSE")?.session).toBe(session);
    expect(session.dispose).not.toHaveBeenCalled();

    resolveAbort?.();
    await cleanup;
    expect(session.dispose).toHaveBeenCalledOnce();
    expect(internals.activeSessions.has("FN-CUSTOM-PROVIDER-CLOSE")).toBe(false);
  });

  it("keeps the custom-provider worktree lease until its stream abort settles", async () => {
    resetExecutorMocks();
    const taskId = "FN-CUSTOM-PROVIDER-LEASE";
    const worktreePath = "/tmp/fn-custom-provider-stream";
    const store = createMockStore();
    const executor = new TaskExecutor(store as unknown as TaskStore, "/tmp/test");
    const internals = cancellationTestInternals(executor);
    let resolveAbort: (() => void) | undefined;
    const abortPending = new Promise<void>((resolve) => {
      resolveAbort = resolve;
    });
    const session = {
      prompt: vi.fn(),
      abort: vi.fn(() => abortPending),
      dispose: vi.fn(),
    };
    internals.activeWorktrees.set(taskId, new Set([worktreePath]));
    internals.setActiveSession(taskId, {
      session,
      seenSteeringIds: new Set<string>(),
      lastResolvedModelProvider: "custom-provider-pi",
    }, worktreePath);

    const cleanup = executor.awaitAbortInFlightTaskWork(taskId, "user cancellation", { userCanceled: true });

    await Promise.resolve();
    try {
      expect(activeSessionRegistry.lookupByPath(worktreePath)).toMatchObject({ taskId, kind: "executor" });
    } finally {
      resolveAbort?.();
      await cleanup;
      activeSessionRegistry.unregisterPath(worktreePath);
    }
    expect(activeSessionRegistry.lookupByPath(worktreePath)).toBeNull();
  });

  it("returns a typed failure and retains custom-provider ownership when abort rejects", async () => {
    resetExecutorMocks();
    const taskId = "FN-CUSTOM-PROVIDER-ABORT-REJECTS";
    const worktreePath = "/tmp/fn-custom-provider-abort-rejects";
    const store = createMockStore();
    const executor = new TaskExecutor(store as unknown as TaskStore, "/tmp/test");
    const internals = cancellationTestInternals(executor);
    const session = {
      prompt: vi.fn(),
      abort: vi.fn().mockRejectedValue(new Error("loopback stream close rejected")),
      dispose: vi.fn(),
    };
    internals.activeWorktrees.set(taskId, new Set([worktreePath]));
    internals.setActiveSession(taskId, {
      session,
      seenSteeringIds: new Set<string>(),
      lastResolvedModelProvider: "custom-provider-pi",
    }, worktreePath);

    try {
      await expect(executor.awaitAbortInFlightTaskWork(taskId, "user cancellation", { userCanceled: true }))
        .rejects.toMatchObject({ code: "TASK_CANCELLATION_ABORT_FAILED" });

      expect(session.dispose).not.toHaveBeenCalled();
      expect(internals.activeSessions.get(taskId)?.session).toBe(session);
      expect(activeSessionRegistry.lookupByPath(worktreePath)).toMatchObject({ taskId, kind: "executor" });
    } finally {
      activeSessionRegistry.unregisterPath(worktreePath);
      internals.activeSessions.delete(taskId);
      internals.activeWorktrees.delete(taskId);
    }
  });

  it("bounds an unclosed custom-provider abort without releasing its worktree lease", async () => {
    resetExecutorMocks();
    const taskId = "FN-CUSTOM-PROVIDER-ABORT-NO-CLOSE";
    const worktreePath = "/tmp/fn-custom-provider-abort-no-close";
    const store = createMockStore();
    const executor = new TaskExecutor(store as unknown as TaskStore, "/tmp/test", { cancellationTimeoutMs: 15 });
    const internals = cancellationTestInternals(executor);
    const session = {
      prompt: vi.fn(),
      abort: vi.fn(() => new Promise<void>(() => undefined)),
      dispose: vi.fn(),
    };
    internals.activeWorktrees.set(taskId, new Set([worktreePath]));
    internals.setActiveSession(taskId, {
      session,
      seenSteeringIds: new Set<string>(),
      lastResolvedModelProvider: "custom-provider-pi",
    }, worktreePath);

    try {
      await expect(executor.awaitAbortInFlightTaskWork(taskId, "user cancellation", { userCanceled: true }))
        .rejects.toMatchObject({ code: "TASK_CANCELLATION_TIMEOUT" });

      expect(session.dispose).not.toHaveBeenCalled();
      expect(internals.activeSessions.get(taskId)?.session).toBe(session);
      expect(activeSessionRegistry.lookupByPath(worktreePath)).toMatchObject({ taskId, kind: "executor" });
    } finally {
      activeSessionRegistry.unregisterPath(worktreePath);
      internals.activeSessions.delete(taskId);
      internals.activeWorktrees.delete(taskId);
    }
  });

  it("finalizes a late custom-provider close after the caller received the bounded typed failure", async () => {
    resetExecutorMocks();
    const taskId = "FN-CUSTOM-PROVIDER-LATE-CLOSE";
    const worktreePath = "/tmp/fn-custom-provider-late-close";
    const durableSessions = new Map<string, any>([["ccc-late-close", {
      id: "ccc-late-close",
      agentState: "busy",
      terminationReason: null,
      autonomyPosture: {},
    }]]);
    const durableStore = {
      getSession: (id: string) => durableSessions.get(id),
      updateSession: vi.fn((id: string, patch: Record<string, unknown>) => {
        const current = durableSessions.get(id);
        if (!current) return undefined;
        Object.assign(current, patch);
        return current;
      }),
      flush: vi.fn(async () => undefined),
    };
    let resolveAbort: (() => void) | undefined;
    const abortPending = new Promise<void>((resolve) => {
      resolveAbort = resolve;
    });
    const session = {
      prompt: vi.fn(),
      abort: vi.fn(() => abortPending),
      dispose: vi.fn(),
    };
    const store = createMockStore();
    const executor = new TaskExecutor(store as unknown as TaskStore, "/tmp/test", { cancellationTimeoutMs: 15 });
    const internals = cancellationTestInternals(executor);
    internals.activeWorktrees.set(taskId, new Set([worktreePath]));
    internals.setActiveSession(taskId, {
      session,
      seenSteeringIds: new Set<string>(),
      lastResolvedModelProvider: "custom-provider-pi",
      cccDurableSession: { store: durableStore, sessionId: "ccc-late-close" },
    } as any, worktreePath);

    try {
      await expect(executor.awaitAbortInFlightTaskWork(taskId, "user cancellation", { userCanceled: true }))
        .rejects.toMatchObject({ code: "TASK_CANCELLATION_TIMEOUT" });
      await expect(executor.awaitAbortInFlightTaskWork(taskId, "user cancellation", { userCanceled: true }))
        .rejects.toMatchObject({ code: "TASK_CANCELLATION_TIMEOUT" });
      expect(session.abort).toHaveBeenCalledOnce();
      expect(internals.activeSessions.get(taskId)?.session).toBe(session);

      resolveAbort?.();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(durableSessions.get("ccc-late-close")).toMatchObject({
        agentState: "dead",
        terminationReason: "killed",
        autonomyPosture: { cccCancellationState: "CANCELLED" },
      });
      expect(durableStore.flush).toHaveBeenCalledTimes(2);
      expect(session.dispose).toHaveBeenCalledOnce();
      expect(internals.activeSessions.has(taskId)).toBe(false);
      expect(internals.activeWorktrees.has(taskId)).toBe(false);
      expect(activeSessionRegistry.lookupByPath(worktreePath)).toBeNull();
    } finally {
      activeSessionRegistry.unregisterPath(worktreePath);
      internals.activeSessions.delete(taskId);
      internals.activeWorktrees.delete(taskId);
    }
  });

  it("does not let late cancellation cleanup touch a replacement execution", async () => {
    resetExecutorMocks();
    let resolveChildStateUpdate: (() => void) | undefined;
    const childStateUpdate = new Promise<void>((resolve) => {
      resolveChildStateUpdate = resolve;
    });
    const agentStore = {
      updateAgentState: vi.fn(() => childStateUpdate),
      deleteAgent: vi.fn().mockResolvedValue(undefined),
    };
    const store = createMockStore();
    const executor = new TaskExecutor(store as any, "/tmp/test", { agentStore } as any);
    const oldSession = {
      prompt: vi.fn(),
      abort: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
    } as any;
    const oldChildSession = { dispose: vi.fn() } as any;
    (executor as any).activeSessions.set("FN-GENERATION", {
      session: oldSession,
      seenSteeringIds: new Set<string>(),
    });
    (executor as any).spawnedAgents.set("FN-GENERATION", new Set(["old-child"]));
    (executor as any).childSessions.set("old-child", oldChildSession);

    const disposer = getTaskMoveDisposer(store as any)!;
    const disposal = disposer({ id: "FN-GENERATION" } as any);

    const replacementSession = { dispose: vi.fn() } as any;
    const replacementChildren = new Set(["new-child"]);
    (executor as any).activeSessions.set("FN-GENERATION", {
      session: replacementSession,
      seenSteeringIds: new Set<string>(),
    });
    (executor as any).spawnedAgents.set("FN-GENERATION", replacementChildren);

    resolveChildStateUpdate?.();
    await disposal;

    expect(oldSession.abort).toHaveBeenCalledOnce();
    expect(oldChildSession.dispose).toHaveBeenCalledOnce();
    expect((executor as any).activeSessions.get("FN-GENERATION")?.session).toBe(replacementSession);
    expect((executor as any).spawnedAgents.get("FN-GENERATION")).toBe(replacementChildren);
  });

  it("aborts before dispose when user moves in-progress task back to todo", async () => {
    resetExecutorMocks();
    const store = createMockStore();
    const executor = new TaskExecutor(store as any, "/tmp/test");

    const callOrder: string[] = [];
    const session = {
      prompt: vi.fn(),
      abort: vi.fn(() => {
        callOrder.push("abort");
        return Promise.resolve();
      }),
      dispose: vi.fn(() => {
        callOrder.push("dispose");
      }),
    } as any;

    (executor as any).activeSessions.set("FN-001", {
      session,
      seenSteeringIds: new Set<string>(),
    });

    (store as any)._trigger("task:moved", {
      task: {
        id: "FN-001",
        column: "todo",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
      },
      from: "in-progress",
      to: "todo",
      source: "user",
    });

    await (executor as any).pendingTaskDisposals.get("FN-001");

    expect(callOrder[0]).toBe("abort");
    expect(callOrder[1]).toBe("dispose");
    expect((executor as any).activeSessions.has("FN-001")).toBe(false);
    expect((executor as any).userCanceledTaskIds.has("FN-001")).toBe(true);
    expect(store.moveTask).not.toHaveBeenCalled();
  });

  it("does not mark engine-initiated move as user cancel", () => {
    resetExecutorMocks();
    const store = createMockStore();
    const executor = new TaskExecutor(store as any, "/tmp/test");

    (store as any)._trigger("task:moved", {
      task: {
        id: "FN-002",
        column: "todo",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
      },
      from: "in-progress",
      to: "todo",
      source: "engine",
    });

    expect((executor as any).userCanceledTaskIds.has("FN-002")).toBe(false);
  });

  it("clears userCanceled marker when task is moved back to in-progress", () => {
    resetExecutorMocks();
    const store = createMockStore();
    const executor = new TaskExecutor(store as any, "/tmp/test");

    (executor as any).userCanceledTaskIds.add("FN-003");

    (store as any)._trigger("task:moved", {
      task: {
        id: "FN-003",
        column: "in-progress",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
      },
      from: "todo",
      to: "in-progress",
      source: "user",
    });

    expect((executor as any).userCanceledTaskIds.has("FN-003")).toBe(false);
  });

  it("re-dispatch (task:moved → in-progress) awaits prior disposal before execute()", async () => {
    resetExecutorMocks();
    const store = createMockStore();
    const executor = new TaskExecutor(store as any, "/tmp/test");

    const callOrder: string[] = [];
    let resolveAbort: (() => void) | null = null;
    const abortPromise = new Promise<void>((resolve) => {
      resolveAbort = () => {
        callOrder.push("abort-resolved");
        resolve();
      };
    });

    const session = {
      prompt: vi.fn(),
      abort: vi.fn(() => {
        callOrder.push("abort-started");
        return abortPromise;
      }),
      dispose: vi.fn(() => {
        callOrder.push("dispose");
      }),
    } as any;

    (executor as any).activeSessions.set("FN-RACE", {
      session,
      seenSteeringIds: new Set<string>(),
    });
    const executeSpy = vi.spyOn(executor, "execute" as any).mockImplementation(async () => {
      callOrder.push("execute");
    });

    // Move away first — kicks off async disposal.
    (store as any)._trigger("task:moved", {
      task: { id: "FN-RACE", column: "todo", dependencies: [], steps: [], currentStep: 0, log: [] },
      from: "in-progress",
      to: "todo",
      source: "user",
    });
    // Immediate re-dispatch — must wait for the disposal above.
    (store as any)._trigger("task:moved", {
      task: { id: "FN-RACE", column: "in-progress", dependencies: [], steps: [], currentStep: 0, log: [] },
      from: "todo",
      to: "in-progress",
      source: "user",
    });

    // execute() must not run yet — abort is still pending.
    await Promise.resolve();
    expect(callOrder).toEqual(["abort-started"]);

    // Resolve abort. Dispose + execute should follow in order.
    resolveAbort!();
    await (executor as any).pendingTaskDisposals.get("FN-RACE");
    await Promise.resolve();
    await Promise.resolve();

    expect(callOrder.indexOf("execute")).toBeGreaterThan(callOrder.indexOf("dispose"));
    executeSpy.mockRestore();
  });
});
