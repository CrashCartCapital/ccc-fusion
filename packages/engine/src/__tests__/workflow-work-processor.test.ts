import { afterEach, describe, expect, it, vi } from "vitest";
import { beginTaskMoveDisposal, getTaskMoveDisposer, registerTaskMoveDisposer } from "@fusion/core";
import { processDueWorkflowWorkItem } from "../workflow-work-processor.js";

type ProcessorStore = Parameters<typeof processDueWorkflowWorkItem>[0];
type ProcessorRuntime = Parameters<typeof processDueWorkflowWorkItem>[1];

const item = {
  id: "WW-renew",
  taskId: "FN-renew",
  runId: "run-renew",
  nodeId: "execute",
  kind: "task",
  state: "running",
  attempt: 1,
  leaseOwner: "worker",
  leaseExpiresAt: "2026-07-25T00:01:00.000Z",
  lastError: null,
  createdAt: "2026-07-25T00:00:00.000Z",
  updatedAt: "2026-07-25T00:00:01.000Z",
} as any;

function campaignContext(taskId = "FN-renew"): any {
  return {
    schema: "ccc-campaign-context/v1",
    taskId,
    route: { taskId, transport: "workflow" },
    manifestHash: "a".repeat(64),
    requestCount: 1,
    activeActionLeases: {},
  };
}

afterEach(() => vi.useRealTimers());

describe("processDueWorkflowWorkItem symbol lock renewal", () => {
  it("Task 6 P1 RED: late processor registration observes an active hard-move intent and cancels before runtime", async () => {
    let releaseClaim!: () => void;
    let releaseBlocker!: () => void;
    const claim = new Promise<any>((resolve) => { releaseClaim = () => resolve(item); });
    const blocker = vi.fn(() => new Promise<void>((resolve) => { releaseBlocker = resolve; }));
    const store = {
      listDueWorkflowWorkItems: async () => [item],
      acquireWorkflowWorkItemLease: async () => claim,
      transitionWorkflowWorkItem: vi.fn(async (_id: string, state: string) => ({ ...item, state })),
      renewWorkflowWorkItemLease: vi.fn(async () => item),
      getCccCampaignContextForTask: vi.fn(async () => campaignContext()),
      getTask: vi.fn(async () => ({ id: item.taskId, title: "Campaign task" })),
    };
    const run = vi.fn(async () => ({ disposition: "completed", outcome: "success", visitedNodeIds: [], context: {} }));
    registerTaskMoveDisposer(store as any, blocker);

    const processing = processDueWorkflowWorkItem(store as any, { run } as any, undefined, {
      leaseOwner: "worker", leaseDurationMs: 1_000, campaignRequired: true,
    });
    const moveBeginning = beginTaskMoveDisposal(store as any, {
      task: { id: item.taskId }, from: "in-progress", to: "todo", source: "user",
    });
    await vi.waitFor(() => expect(blocker).toHaveBeenCalledOnce());
    releaseBlocker();
    const releaseMove = await moveBeginning;
    try {
      releaseClaim();
      await expect(processing).resolves.toMatchObject({ runtime: { disposition: "cancelled" } });
      expect(run).not.toHaveBeenCalled();
    } finally {
      releaseMove();
    }
  });

  it("late processor registration observes an explicit custom-column hard-cancel intent", async () => {
    let releaseClaim!: () => void;
    let releaseBlocker = () => undefined;
    const claim = new Promise<any>((resolve) => { releaseClaim = () => resolve(item); });
    const blocker = vi.fn(() => new Promise<void>((resolve) => { releaseBlocker = resolve; }));
    const store = {
      listDueWorkflowWorkItems: async () => [item],
      acquireWorkflowWorkItemLease: async () => claim,
      transitionWorkflowWorkItem: vi.fn(async (_id: string, state: string) => ({ ...item, state })),
      renewWorkflowWorkItemLease: vi.fn(async () => item),
      getCccCampaignContextForTask: vi.fn(async () => campaignContext()),
      getTask: vi.fn(async () => ({ id: item.taskId, title: "Campaign task" })),
    };
    const run = vi.fn(async () => ({ disposition: "completed", outcome: "success", visitedNodeIds: [], context: {} }));
    registerTaskMoveDisposer(store as any, blocker);
    const input = {
      task: { id: item.taskId } as any,
      from: "implementing",
      to: "todo",
      source: "user",
      hardCancel: true,
    } satisfies Parameters<typeof beginTaskMoveDisposal>[1];

    const processing = processDueWorkflowWorkItem(store as any, { run } as any, undefined, {
      leaseOwner: "worker", leaseDurationMs: 1_000, campaignRequired: true,
    });
    const moveBeginning = beginTaskMoveDisposal(store as any, input);
    await vi.waitFor(() => expect(blocker).toHaveBeenCalledOnce());
    releaseBlocker();
    const releaseMove = await moveBeginning;
    try {
      releaseClaim();
      await expect(processing).resolves.toMatchObject({ runtime: { disposition: "cancelled" } });
      expect(run).not.toHaveBeenCalled();
    } finally {
      releaseMove();
    }
  });

  it("Task 6 P1 RED: fresh user pause returns before custody starts and cannot leak a delayed rejection", async () => {
    let rejectCustody: ((error: Error) => void) | undefined;
    const getCccCampaignContextForTask = vi.fn(() => new Promise<unknown>((_resolve, reject) => {
      rejectCustody = reject;
    }));
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      const store = {
        listDueWorkflowWorkItems: async () => [item],
        acquireWorkflowWorkItemLease: async () => item,
        transitionWorkflowWorkItem: vi.fn(async (_id: string, state: string) => ({ ...item, state })),
        renewWorkflowWorkItemLease: vi.fn(async () => item),
        getCccCampaignContextForTask,
        getTask: vi.fn(async () => ({ id: item.taskId, title: "Paused task", userPaused: true })),
      };
      await expect(processDueWorkflowWorkItem(store as any, { run: vi.fn(), runWorkItem: vi.fn() } as any, undefined, {
        leaseOwner: "worker", leaseDurationMs: 1_000, campaignRequired: true,
      })).resolves.toMatchObject({ runtime: { disposition: "cancelled" } });
      rejectCustody?.(new Error("late custody rejection"));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(getCccCampaignContextForTask).not.toHaveBeenCalled();
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("Task 6 P1 RED: an already-aborted custody read consumes its delayed rejection", async () => {
    let rejectCustody!: (error: Error) => void;
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      const store = {
        listDueWorkflowWorkItems: async () => [item],
        acquireWorkflowWorkItemLease: async () => item,
        transitionWorkflowWorkItem: vi.fn(async (_id: string, state: string) => ({ ...item, state })),
        renewWorkflowWorkItemLease: vi.fn(async () => item),
        getCccCampaignContextForTask: vi.fn(function (this: unknown) {
          const disposer = getTaskMoveDisposer(store as any)!;
          void disposer({ id: item.taskId } as any).catch(() => undefined);
          return new Promise<unknown>((_resolve, reject) => {
            rejectCustody = reject;
          });
        }),
        getTask: vi.fn(async () => ({ id: item.taskId, title: "Campaign task" })),
      };
      const processing = processDueWorkflowWorkItem(store as any, { run: vi.fn() } as any, undefined, {
        leaseOwner: "worker", leaseDurationMs: 1_000, campaignRequired: true,
      });
      await vi.waitFor(() => expect(rejectCustody).toBeTypeOf("function"));
      rejectCustody(new Error("late already-aborted custody rejection"));
      await expect(processing).resolves.toMatchObject({ runtime: { disposition: "cancelled" } });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("Task 6 P2 RED: user cancellation aborts a hung best-effort summary after succeeded CAS", async () => {
    const never = new Promise<never>(() => {});
    const getTask = vi.fn()
      .mockResolvedValueOnce({ id: item.taskId, title: "Classified task" })
      .mockResolvedValueOnce({ id: item.taskId, title: "Runtime task" })
      .mockReturnValueOnce(never);
    const transitionWorkflowWorkItem = vi.fn(async (_id: string, state: string) => ({ ...item, state }));
    const run = vi.fn(async () => ({ disposition: "completed", outcome: "success", visitedNodeIds: [], context: {} }));
    const store = {
      listDueWorkflowWorkItems: async () => [item],
      acquireWorkflowWorkItemLease: async () => item,
      transitionWorkflowWorkItem,
      renewWorkflowWorkItemLease: vi.fn(async () => item),
      getCccCampaignContextForTask: vi.fn(async () => campaignContext()),
      getTask,
      updateTask: vi.fn(),
    };
    const processing = processDueWorkflowWorkItem(store as any, { run } as any, undefined, {
      leaseOwner: "worker", leaseDurationMs: 1_000,
    });
    await vi.waitFor(() => expect(transitionWorkflowWorkItem).toHaveBeenCalledWith(item.id, "succeeded", expect.anything()));
    const dispose = getTaskMoveDisposer(store as any)!({ id: item.taskId } as any);

    await expect(Promise.race([
      dispose.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
    ])).resolves.toBe(true);
    await processing;
    expect(transitionWorkflowWorkItem).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledOnce();
  });

  it("Task 6 P1-A RED: user cancellation races a hung runtime task read and persists cancelled", async () => {
    const never = new Promise<never>(() => {});
    const transitionWorkflowWorkItem = vi.fn(async (_id: string, state: string) => ({ ...item, state }));
    const store = {
      listDueWorkflowWorkItems: async () => [item],
      acquireWorkflowWorkItemLease: async () => item,
      transitionWorkflowWorkItem,
      renewWorkflowWorkItemLease: vi.fn(async () => item),
      getCccCampaignContextForTask: vi.fn(async () => campaignContext()),
      getTask: vi.fn()
        .mockResolvedValueOnce({ id: item.taskId, title: "Campaign task" })
        .mockReturnValueOnce(never),
    };

    void processDueWorkflowWorkItem(store as any, { run: vi.fn() } as any, undefined, {
      leaseOwner: "worker",
      leaseDurationMs: 1_000,
      campaignRequired: true,
    });
    await vi.waitFor(() => expect(getTaskMoveDisposer(store as any)).toBeTypeOf("function"));
    const dispose = getTaskMoveDisposer(store as any)!({ id: item.taskId } as any);

    await expect(Promise.race([
      dispose.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
    ])).resolves.toBe(true);
    expect(transitionWorkflowWorkItem).toHaveBeenCalledWith(item.id, "cancelled", expect.anything());
  });

  it("Task 6 P1 RED: cancellation after task-read fulfillment prevents runtime dispatch", async () => {
    let resolveRuntimeTask!: (task: unknown) => void;
    const runtimeTask = new Promise<unknown>((resolve) => { resolveRuntimeTask = resolve; });
    const run = vi.fn(async () => ({
      disposition: "completed", outcome: "success", visitedNodeIds: [], context: {},
    }));
    const transitionWorkflowWorkItem = vi.fn(async (_id: string, state: string) => ({ ...item, state }));
    const getTask = vi.fn()
      .mockResolvedValueOnce({ id: item.taskId, title: "Classification task" })
      .mockReturnValueOnce(runtimeTask);
    const store = {
      listDueWorkflowWorkItems: async () => [item],
      acquireWorkflowWorkItemLease: async () => item,
      transitionWorkflowWorkItem,
      renewWorkflowWorkItemLease: vi.fn(async () => item),
      getCccCampaignContextForTask: vi.fn(async () => campaignContext()),
      getTask,
    };

    const processing = processDueWorkflowWorkItem(store as any, { run } as any, undefined, {
      leaseOwner: "worker", leaseDurationMs: 1_000,
    });
    await vi.waitFor(() => expect(getTask).toHaveBeenCalledTimes(2));
    const disposer = getTaskMoveDisposer(store as any)!;
    resolveRuntimeTask({ id: item.taskId, title: "Runtime task" });
    const cancellation = new Promise<void>((resolve, reject) => {
      queueMicrotask(() => {
        void disposer({ id: item.taskId } as any).then(resolve, reject);
      });
    });

    await cancellation;
    await expect(processing).resolves.toMatchObject({ runtime: {
      disposition: "cancelled",
      reason: "workflow-user-cancelled",
    } });
    expect(run).not.toHaveBeenCalled();
    expect(transitionWorkflowWorkItem).toHaveBeenCalledTimes(1);
    expect(transitionWorkflowWorkItem).toHaveBeenCalledWith(item.id, "cancelled", expect.anything());
  });

  it("Task 6 P1-B RED: context-only campaign cancellation registers during classification and never runs either runtime", async () => {
    let resolveContext!: (value: unknown) => void;
    const context = new Promise<unknown>((resolve) => { resolveContext = resolve; });
    const run = vi.fn();
    const runWorkItem = vi.fn();
    const transitionWorkflowWorkItem = vi.fn(async (_id: string, state: string) => ({ ...item, state }));
    const store = {
      listDueWorkflowWorkItems: async () => [item],
      acquireWorkflowWorkItemLease: async () => item,
      transitionWorkflowWorkItem,
      renewWorkflowWorkItemLease: vi.fn(async () => item),
      getCccCampaignContextForTask: vi.fn(async () => context),
      getTask: vi.fn(async () => ({ id: item.taskId, title: "Campaign task" })),
    };

    const processing = processDueWorkflowWorkItem(store as any, { run, runWorkItem } as any, undefined, {
      leaseOwner: "worker",
      leaseDurationMs: 1_000,
    });
    await vi.waitFor(() => expect(getTaskMoveDisposer(store as any)).toBeTypeOf("function"));
    const dispose = getTaskMoveDisposer(store as any)!({ id: item.taskId } as any);
    resolveContext(campaignContext());

    await dispose;
    await expect(processing).resolves.toMatchObject({ runtime: { disposition: "cancelled" } });
    expect(run).not.toHaveBeenCalled();
    expect(runWorkItem).not.toHaveBeenCalled();
  });

  it("Task 6 P1-A: user cancellation races a hung custody read and persists cancelled", async () => {
    const never = new Promise<never>(() => {});
    const transitionWorkflowWorkItem = vi.fn(async (_id: string, state: string) => ({ ...item, state }));
    const store = {
      listDueWorkflowWorkItems: async () => [item],
      acquireWorkflowWorkItemLease: async () => item,
      transitionWorkflowWorkItem,
      renewWorkflowWorkItemLease: vi.fn(async () => item),
      getCccCampaignContextForTask: vi.fn(async () => never),
      getTask: vi.fn(async () => ({ id: item.taskId, title: "Campaign task" })),
    };

    const processing = processDueWorkflowWorkItem(store as any, { run: vi.fn(), runWorkItem: vi.fn() } as any, undefined, {
      leaseOwner: "worker",
      leaseDurationMs: 1_000,
    });
    await vi.waitFor(() => expect(getTaskMoveDisposer(store as any)).toBeTypeOf("function"));
    await getTaskMoveDisposer(store as any)!({ id: item.taskId } as any);

    await expect(processing).resolves.toMatchObject({ runtime: { disposition: "cancelled" } });
    expect(transitionWorkflowWorkItem).toHaveBeenCalledWith(item.id, "cancelled", expect.anything());
  });

  it("Task 6 P1-B RED: ordinary classification unregisters its provisional disposer before runWorkItem", async () => {
    let finish!: () => void;
    const runWorkItem = vi.fn(() => new Promise<any>((resolve) => {
      finish = () => resolve({ disposition: "completed", outcome: "success", visitedNodeIds: [], context: {} });
    }));
    const store = {
      listDueWorkflowWorkItems: async () => [item],
      acquireWorkflowWorkItemLease: async () => item,
      transitionWorkflowWorkItem: vi.fn(async (_id: string, state: string) => ({ ...item, state })),
      getCccCampaignContextForTask: vi.fn(async () => null),
    };

    const processing = processDueWorkflowWorkItem(store as any, { runWorkItem } as any, undefined, {
      leaseOwner: "worker",
      leaseDurationMs: 1_000,
    });
    await vi.waitFor(() => expect(runWorkItem).toHaveBeenCalledOnce());
    expect(getTaskMoveDisposer(store as any)).toBeUndefined();
    finish();
    await processing;
  });

  it("Task 6 P1 RED: null-custody ordinary work does not wait on campaign task reads", async () => {
    const never = new Promise<never>(() => {});
    const runWorkItem = vi.fn(async () => ({
      disposition: "completed", outcome: "success", visitedNodeIds: [item.nodeId], context: {},
    }));
    const store = {
      listDueWorkflowWorkItems: async () => [item],
      acquireWorkflowWorkItemLease: async () => item,
      transitionWorkflowWorkItem: vi.fn(async (_id: string, state: string) => ({ ...item, state })),
      getCccCampaignContextForTask: vi.fn(async () => null),
      getTask: vi.fn(() => never),
    };

    const processing = processDueWorkflowWorkItem(store as any, { runWorkItem } as any, undefined, {
      leaseOwner: "worker",
      leaseDurationMs: 1_000,
    });
    await vi.waitFor(() => expect(runWorkItem).toHaveBeenCalledOnce());
    await expect(processing).resolves.toMatchObject({ runtime: { disposition: "completed" } });
    expect(store.getTask).not.toHaveBeenCalled();
  });

  it("Task 6 RED: required campaign cancellation registers before async custody, waits for cancelled CAS, and never dispatches", async () => {
    let resolveCustody!: (value: unknown) => void;
    let resolveTerminal!: () => void;
    let terminalStarted = false;
    const custody = new Promise<unknown>((resolve) => { resolveCustody = resolve; });
    const terminal = new Promise<void>((resolve) => { resolveTerminal = resolve; });
    const run = vi.fn(async () => ({ disposition: "completed" as const, outcome: "success" as const, visitedNodeIds: [], context: {} }));
    const transitionWorkflowWorkItem = vi.fn(async (_id: string, state: string) => {
      if (state === "cancelled") {
        terminalStarted = true;
        await terminal;
      }
      return { ...item, state };
    });
    const store = {
      listDueWorkflowWorkItems: async () => [item],
      acquireWorkflowWorkItemLease: async () => item,
      transitionWorkflowWorkItem,
      renewWorkflowWorkItemLease: vi.fn(async () => item),
      getCccCampaignContextForTask: vi.fn(async () => custody),
      getTask: vi.fn(async () => ({ id: item.taskId, title: "Campaign task" })),
    };

    const processing = processDueWorkflowWorkItem(store as any, { run } as any, undefined, {
      leaseOwner: "worker",
      leaseDurationMs: 1_000,
      campaignRequired: true,
    });
    await vi.waitFor(() => expect(getTaskMoveDisposer(store as any)).toBeTypeOf("function"));

    const dispose = getTaskMoveDisposer(store as any)!({ id: item.taskId } as any);
    let disposed = false;
    void dispose.then(() => { disposed = true; });
    resolveCustody(campaignContext());
    await vi.waitFor(() => expect(terminalStarted).toBe(true));
    expect(disposed).toBe(false);
    expect(run).not.toHaveBeenCalled();

    resolveTerminal();
    await dispose;
    await processing;
    expect(transitionWorkflowWorkItem).toHaveBeenCalledWith(item.id, "cancelled", expect.objectContaining({
      expectedState: "running",
      expectedLeaseOwner: "worker",
      expectedAttempt: item.attempt,
    }));
  });

  it("Task 6 RED: a mismatched task move cannot abort an active campaign", async () => {
    let finish!: () => void;
    let observedSignal: AbortSignal | undefined;
    const run = vi.fn((_task: unknown, _settings: unknown, options: { signal: AbortSignal }) => new Promise<any>((resolve) => {
      observedSignal = options.signal;
      finish = () => resolve({ disposition: "completed", outcome: "success", visitedNodeIds: [], context: {} });
    }));
    const store = {
      listDueWorkflowWorkItems: async () => [item],
      acquireWorkflowWorkItemLease: async () => item,
      transitionWorkflowWorkItem: vi.fn(async (_id: string, state: string) => ({ ...item, state })),
      renewWorkflowWorkItemLease: vi.fn(async () => item),
      getCccCampaignContextForTask: vi.fn(async () => campaignContext()),
      getTask: vi.fn(async () => ({ id: item.taskId, title: "Campaign task" })),
    };

    const processing = processDueWorkflowWorkItem(store as any, { run } as any, undefined, {
      leaseOwner: "worker",
      leaseDurationMs: 1_000,
    });
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    await getTaskMoveDisposer(store as any)!({ id: "FN-other" } as any);
    expect(observedSignal?.aborted).toBe(false);

    finish();
    await processing;
  });

  it("Task 6: a user cancellation during custody failure still persists cancelled", async () => {
    let rejectCustody!: (error: Error) => void;
    const custody = new Promise<unknown>((_resolve, reject) => { rejectCustody = reject; });
    const transitionWorkflowWorkItem = vi.fn(async (_id: string, state: string) => ({ ...item, state }));
    const store = {
      listDueWorkflowWorkItems: async () => [item],
      acquireWorkflowWorkItemLease: async () => item,
      transitionWorkflowWorkItem,
      renewWorkflowWorkItemLease: vi.fn(async () => item),
      getCccCampaignContextForTask: vi.fn(async () => custody),
      getTask: vi.fn(async () => ({ id: item.taskId, title: "Campaign task" })),
    };

    const processing = processDueWorkflowWorkItem(store as any, { run: vi.fn() } as any, undefined, {
      leaseOwner: "worker",
      leaseDurationMs: 1_000,
      campaignRequired: true,
    });
    await vi.waitFor(() => expect(getTaskMoveDisposer(store as any)).toBeTypeOf("function"));
    const dispose = getTaskMoveDisposer(store as any)!({ id: item.taskId } as any);
    rejectCustody(new Error("custody lookup interrupted"));

    await dispose;
    await expect(processing).resolves.toMatchObject({ runtime: {
      disposition: "cancelled",
      reason: "workflow-user-cancelled",
    } });
    expect(transitionWorkflowWorkItem).toHaveBeenCalledWith(item.id, "cancelled", expect.objectContaining({
      expectedState: "running",
      expectedLeaseOwner: "worker",
      expectedAttempt: item.attempt,
    }));
  });

  it("Task 6: a user cancellation wins when lease loss aborted the controller first", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    let observedSignal: AbortSignal | undefined;
    const run = vi.fn((_task: unknown, _settings: unknown, options: { signal: AbortSignal }) => new Promise<any>((resolve) => {
      observedSignal = options.signal;
      finish = () => resolve({ disposition: "failed", outcome: "failure", visitedNodeIds: [], context: {}, reason: "lease-loss-observed" });
    }));
    const transitionWorkflowWorkItem = vi.fn(async (_id: string, state: string) => ({ ...item, state }));
    const store = {
      listDueWorkflowWorkItems: async () => [item],
      acquireWorkflowWorkItemLease: async () => item,
      transitionWorkflowWorkItem,
      renewWorkflowWorkItemLease: vi.fn(async () => null),
      getCccCampaignContextForTask: vi.fn(async () => campaignContext()),
      getTask: vi.fn(async () => ({ id: item.taskId, title: "Campaign task" })),
    };

    const processing = processDueWorkflowWorkItem(store as any, { run } as any, undefined, {
      leaseOwner: "worker",
      leaseDurationMs: 900,
    });
    await vi.advanceTimersByTimeAsync(300);
    expect(observedSignal?.aborted).toBe(true);

    const dispose = getTaskMoveDisposer(store as any)!({ id: item.taskId } as any);
    finish();
    await dispose;
    await expect(processing).resolves.toMatchObject({ runtime: {
      disposition: "cancelled",
      reason: "workflow-user-cancelled",
    } });
    expect(transitionWorkflowWorkItem).toHaveBeenCalledWith(item.id, "cancelled", expect.anything());
  });

  it("Task 6: a user pause observed after campaign claim prevents runtime dispatch", async () => {
    let releaseClaim!: () => void;
    const claimed = new Promise<any>((resolve) => { releaseClaim = () => resolve(item); });
    const run = vi.fn();
    const transitionWorkflowWorkItem = vi.fn(async (_id: string, state: string) => ({ ...item, state }));
    const store = {
      listDueWorkflowWorkItems: async () => [item],
      acquireWorkflowWorkItemLease: async () => claimed,
      transitionWorkflowWorkItem,
      renewWorkflowWorkItemLease: vi.fn(async () => item),
      getCccCampaignContextForTask: vi.fn(async () => campaignContext()),
      getTask: vi.fn(async () => ({ id: item.taskId, title: "Campaign task", userPaused: true })),
    };

    const processing = processDueWorkflowWorkItem(store as any, { run } as any, undefined, {
      leaseOwner: "worker",
      leaseDurationMs: 1_000,
      campaignRequired: true,
    });
    releaseClaim();

    await expect(processing).resolves.toMatchObject({ runtime: {
      disposition: "cancelled",
      reason: "workflow-user-cancelled",
    } });
    expect(run).not.toHaveBeenCalled();
    expect(transitionWorkflowWorkItem).toHaveBeenCalledWith(item.id, "cancelled", expect.objectContaining({
      expectedState: "running",
      expectedLeaseOwner: "worker",
      expectedAttempt: item.attempt,
    }));
  });

  it("Task 5 RED: passes an exact campaign candidate through to the lease claim", async () => {
    const exactCandidate = { id: item.id, runId: item.runId, attempt: item.attempt };
    const acquireWorkflowWorkItemLease = vi.fn(async () => item);
    const store = {
      getWorkflowWorkItem: async () => item,
      listDueWorkflowWorkItems: async () => [item],
      acquireWorkflowWorkItemLease,
      transitionWorkflowWorkItem: async () => item,
    } as unknown as ProcessorStore;
    const runtime = {
      runWorkItem: async () => ({ disposition: "completed" as const, outcome: "success" as const, visitedNodeIds: [], context: {} }),
    } as unknown as ProcessorRuntime;
    const result = await processDueWorkflowWorkItem(store, runtime, undefined, {
      leaseOwner: "worker",
      leaseDurationMs: 1_000,
      exactCandidate,
    });

    expect(result.claimed).toBe(true);
    expect(acquireWorkflowWorkItemLease).toHaveBeenCalledWith(item.id, "worker", expect.objectContaining({
      expectedRunId: exactCandidate.runId,
      expectedAttempt: exactCandidate.attempt,
    }));
  });

  it("renews a claimed mission symbol before its short admission lease can expire", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const runWorkItem = vi.fn(() => new Promise<any>((resolve) => { finish = () => resolve({ disposition: "completed", outcome: "success", visitedNodeIds: [], context: {} }); }));
    const renewSymbolLocks = vi.fn(async () => ({ renewed: ["pkg/a.ts#a"], lost: [] }));
    const store = {
      listDueWorkflowWorkItems: () => [item],
      acquireWorkflowWorkItemLease: () => item,
      transitionWorkflowWorkItem: async () => item,
      getTask: async () => ({ id: "FN-renew", missionId: "M-1", sliceId: "SL-1", declaredSymbols: ["pkg/a.ts#A"] }),
      getMissionStore: () => ({
        getFeatureByTaskId: async () => ({ id: "F-1", sliceId: "SL-1", status: "triaged" }),
        getSlice: async () => ({ id: "SL-1", milestoneId: "MS-1", status: "active" }),
        getMilestone: async () => ({ id: "MS-1", missionId: "M-1", status: "active" }),
        getMission: async () => ({ id: "M-1", status: "active" }),
      }),
      acquireSymbolLocks: async () => ({ acquired: true, conflicts: [] as [] }),
      renewSymbolLocks,
    };

    const processing = processDueWorkflowWorkItem(store as any, { runWorkItem } as any, undefined, {
      leaseOwner: "worker", leaseDurationMs: 1_000,
    });
    await vi.advanceTimersByTimeAsync(200_001);
    expect(renewSymbolLocks).toHaveBeenCalledWith(["pkg/a.ts#a"], "FN-renew", 10 * 60_000);

    finish();
    await processing;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(renewSymbolLocks).toHaveBeenCalledOnce();
  });

  it("Task 3 RED: ordinary non-campaign work items do not renew workflow work-item leases", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const runWorkItem = vi.fn(() => new Promise<any>((resolve) => {
      finish = () => resolve({ disposition: "completed", outcome: "success", visitedNodeIds: [], context: {} });
    }));
    const renewWorkflowWorkItemLease = vi.fn(async () => item);
    const store = {
      listDueWorkflowWorkItems: async () => [item],
      acquireWorkflowWorkItemLease: async () => item,
      transitionWorkflowWorkItem: vi.fn(async () => item),
      renewWorkflowWorkItemLease,
      getCccCampaignContextForTask: async () => null,
    };

    const processing = processDueWorkflowWorkItem(store as any, { runWorkItem } as any, undefined, {
      leaseOwner: "worker",
      leaseDurationMs: 900,
    });
    await vi.advanceTimersByTimeAsync(900);
    expect(renewWorkflowWorkItemLease).not.toHaveBeenCalled();
    expect(runWorkItem).toHaveBeenCalledOnce();

    finish();
    await processing;
  });

  it("Task 5 RED: campaign-required custody classification never falls through when recheck is missing", async () => {
    const run = vi.fn(async () => ({ disposition: "completed", outcome: "success", visitedNodeIds: ["start"], context: {} }));
    const runWorkItem = vi.fn(async () => ({ disposition: "completed", outcome: "success", visitedNodeIds: [item.nodeId], context: {} }));
    const transitionWorkflowWorkItem = vi.fn(async () => ({ ...item, state: "failed" }));
    const acquireWorkflowWorkItemLease = vi.fn(async () => item);
    const logEntry = vi.fn(async () => undefined);
    const store = {
      listDueWorkflowWorkItems: async () => [item],
      acquireWorkflowWorkItemLease,
      transitionWorkflowWorkItem,
      renewWorkflowWorkItemLease: vi.fn(async () => item),
      getCccCampaignContextForTask: vi.fn(async () => null),
      getTask: vi.fn(async () => ({ id: item.taskId, title: "Campaign task" })),
      getMissionStore: vi.fn(() => ({
        getFeatureByTaskId: vi.fn(async () => undefined),
        getSlice: vi.fn(async () => undefined),
        getMilestone: vi.fn(async () => undefined),
        getMission: vi.fn(async () => undefined),
      })),
      acquireSymbolLocks: vi.fn(),
      logEntry,
    };

    const result = await processDueWorkflowWorkItem(store as unknown as ProcessorStore, { run, runWorkItem } as unknown as ProcessorRuntime, undefined, {
      leaseOwner: "worker",
      leaseDurationMs: 1_000,
      campaignRequired: true,
    });

    expect(result.runtime).toEqual(expect.objectContaining({
      disposition: "failed",
      outcome: "failure",
      reason: expect.stringContaining("campaign custody is missing"),
    }));
    expect(run).not.toHaveBeenCalled();
    expect(runWorkItem).not.toHaveBeenCalled();
    expect(acquireWorkflowWorkItemLease).toHaveBeenCalledOnce();
    expect(logEntry).not.toHaveBeenCalledWith(item.taskId, expect.stringContaining("mission lineage blocked"));
    expect(transitionWorkflowWorkItem).toHaveBeenCalledWith(item.id, "failed", expect.objectContaining({
      expectedState: "running",
      expectedLeaseOwner: "worker",
      expectedAttempt: item.attempt,
    }));
  });

  it("Task 3 RED: an imported campaign work item fails closed when campaign custody lookup is unwired", async () => {
    const importedItem = {
      ...item,
      runId: "ccc-prd:import-1",
      stableWorkflowRunId: "ccc-prd:import-1",
      irHash: "a".repeat(64),
    };
    const runWorkItem = vi.fn(async () => ({
      disposition: "completed",
      outcome: "success",
      visitedNodeIds: [importedItem.nodeId],
      context: {},
    }));
    const transitionWorkflowWorkItem = vi.fn(async () => ({
      ...importedItem,
      state: "failed",
    }));
    const store = {
      listDueWorkflowWorkItems: async () => [importedItem],
      acquireWorkflowWorkItemLease: async () => importedItem,
      transitionWorkflowWorkItem,
    };

    const result = await processDueWorkflowWorkItem(
      store as any,
      { runWorkItem } as any,
      undefined,
      { leaseOwner: "worker", leaseDurationMs: 1_000 },
    );

    expect(result.runtime).toEqual(expect.objectContaining({
      disposition: "failed",
      outcome: "failure",
      reason: expect.stringContaining("campaign custody lookup is unwired"),
    }));
    expect(runWorkItem).not.toHaveBeenCalled();
    expect(transitionWorkflowWorkItem).toHaveBeenCalledWith(
      importedItem.id,
      "failed",
      expect.objectContaining({
        expectedState: "running",
        expectedLeaseOwner: "worker",
        expectedAttempt: importedItem.attempt,
      }),
    );
  });

  it("Wave 4 RED: rejects the public processor call when runtime and fallback terminal persistence both fail", async () => {
    const runtimeFailure = new Error("runtime terminal failure");
    const fallbackFailure = new Error("fallback terminal persistence failure");
    const transitionWorkflowWorkItem = vi.fn(async () => { throw fallbackFailure; });
    const store = {
      listDueWorkflowWorkItems: async () => [item],
      acquireWorkflowWorkItemLease: async () => item,
      transitionWorkflowWorkItem,
    };
    const runtime = { runWorkItem: vi.fn(async () => { throw runtimeFailure; }) };

    let observed: unknown;
    try {
      await processDueWorkflowWorkItem(store as any, runtime as any, undefined, {
        leaseOwner: "worker", leaseDurationMs: 1_000,
      });
    } catch (error) {
      observed = error;
    }

    expect(observed).toBeInstanceOf(AggregateError);
    expect((observed as AggregateError).errors).toEqual([runtimeFailure, fallbackFailure]);
    expect(transitionWorkflowWorkItem).toHaveBeenCalledWith(item.id, "failed", expect.objectContaining({
      expectedState: "running",
      expectedLeaseOwner: "worker",
      expectedAttempt: 1,
    }));
  });

  it("Wave 4 RED: rejects before claiming when native fallback terminal persistence is unavailable", async () => {
    const acquireWorkflowWorkItemLease = vi.fn(async () => item);
    const runWorkItem = vi.fn(async () => { throw new Error("runtime failure"); });
    const store = {
      listDueWorkflowWorkItems: async () => [item],
      acquireWorkflowWorkItemLease,
    };

    await expect(processDueWorkflowWorkItem(store as any, { runWorkItem } as any, undefined, {
      leaseOwner: "worker", leaseDurationMs: 1_000,
    })).rejects.toThrow("workflow work processor requires transitionWorkflowWorkItem");
    expect(acquireWorkflowWorkItemLease).not.toHaveBeenCalled();
    expect(runWorkItem).not.toHaveBeenCalled();
  });

  it("Task 3 RED: campaign processor enters the full graph instead of the addressed work-item node", async () => {
    const run = vi.fn(async () => ({ disposition: "completed", outcome: "success", visitedNodeIds: ["start", "prepare", "execute"], context: {} }));
    const runWorkItem = vi.fn(async () => ({ disposition: "completed", outcome: "success", visitedNodeIds: ["execute"], context: {} }));
    const transitionWorkflowWorkItem = vi.fn(async () => ({ ...item, state: "succeeded" }));
    const store = {
      listDueWorkflowWorkItems: async () => [item],
      acquireWorkflowWorkItemLease: async () => item,
      transitionWorkflowWorkItem,
      renewWorkflowWorkItemLease: vi.fn(async () => item),
      getCccCampaignContextForTask: vi.fn(async () => campaignContext()),
      getTask: vi.fn(async () => ({ id: "FN-renew", title: "Campaign task" })),
      updateTask: vi.fn(),
    };

    const result = await processDueWorkflowWorkItem(store as any, { run, runWorkItem } as any, undefined, {
      leaseOwner: "worker",
      leaseDurationMs: 1_000,
    });

    expect(result.runtime?.disposition).toBe("completed");
    expect(run).toHaveBeenCalledOnce();
    expect(runWorkItem).not.toHaveBeenCalled();
    expect(run.mock.calls[0]?.[2]).toMatchObject({
      deferCompletionSummary: true,
      workItemFence: {
        workItemId: item.id,
        leaseOwner: "worker",
        attempt: 1,
        runId: item.runId,
        eventTimestamp: item.updatedAt,
      },
    });
    expect(run.mock.calls[0]?.[2]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("persists the exact campaign blocker when full-graph execution requires a human decision", async () => {
    const reason =
      "ccc-permanent:CCC_CAMPAIGN_LIVE_EXECUTION_APPROVAL_REQUIRED";
    const run = vi.fn(async () => ({
      disposition: "manual-required",
      outcome: "failure",
      visitedNodeIds: ["start", "execute"],
      context: {},
      reason,
    }));
    const transitionWorkflowWorkItem = vi.fn(async () => ({
      ...item,
      state: "manual-required",
    }));
    const store = {
      listDueWorkflowWorkItems: async () => [item],
      acquireWorkflowWorkItemLease: async () => item,
      transitionWorkflowWorkItem,
      renewWorkflowWorkItemLease: vi.fn(async () => item),
      getCccCampaignContextForTask: vi.fn(async () => campaignContext()),
      getTask: vi.fn(async () => ({ id: "FN-renew", title: "Campaign task" })),
    };

    await processDueWorkflowWorkItem(
      store as any,
      { run } as any,
      undefined,
      { leaseOwner: "worker", leaseDurationMs: 1_000 },
    );

    expect(transitionWorkflowWorkItem).toHaveBeenCalledWith(
      item.id,
      "manual-required",
      expect.objectContaining({
        lastError: reason,
        blockedReason: reason,
      }),
    );
  });

  it("Task 3 RED: a first imported campaign claim promotes attempt zero before building its fence", async () => {
    const imported = {
      ...item,
      attempt: 0,
      runId: "ccc-prd:attempt-zero",
      stableWorkflowRunId: "ccc-prd:attempt-zero",
      irHash: "c".repeat(64),
    };
    const promoted = { ...imported, attempt: 1 };
    const transitionWorkflowWorkItem = vi.fn(async (_id, state, patch) => state === "running" && patch?.attempt === 1
      ? promoted
      : { ...promoted, state });
    const run = vi.fn(async () => ({ disposition: "completed", outcome: "success", visitedNodeIds: ["start"], context: {} }));
    const store = {
      listDueWorkflowWorkItems: async () => [imported],
      acquireWorkflowWorkItemLease: async () => imported,
      transitionWorkflowWorkItem,
      renewWorkflowWorkItemLease: vi.fn(async () => promoted),
      getCccCampaignContextForTask: async () => campaignContext(imported.taskId),
      getTask: async () => ({ id: imported.taskId, title: "Campaign task" }),
    };

    const result = await processDueWorkflowWorkItem(store as any, { run } as any, undefined, {
      leaseOwner: "worker",
      leaseDurationMs: 1_000,
    });

    expect(result.runtime?.disposition).toBe("completed");
    expect(transitionWorkflowWorkItem).toHaveBeenCalledWith(imported.id, "running", expect.objectContaining({
      expectedState: "running",
      expectedLeaseOwner: "worker",
      expectedAttempt: 0,
      attempt: 1,
    }));
    expect(run.mock.calls[0]?.[2]?.workItemFence.attempt).toBe(1);
  });

  it("Task 3: attempt-zero promotion CAS failure never enters runtime or publishes success", async () => {
    const imported = {
      ...item,
      attempt: 0,
      runId: "ccc-prd:attempt-zero-race",
      stableWorkflowRunId: "ccc-prd:attempt-zero-race",
      irHash: "d".repeat(64),
    };
    const run = vi.fn();
    const transitionWorkflowWorkItem = vi.fn(async (_id, state) => {
      if (state === "running") throw new Error("attempt-zero promotion CAS refused");
      return { ...imported, state };
    });
    const store = {
      listDueWorkflowWorkItems: async () => [imported],
      acquireWorkflowWorkItemLease: async () => imported,
      transitionWorkflowWorkItem,
      renewWorkflowWorkItemLease: vi.fn(),
      getCccCampaignContextForTask: async () => campaignContext(imported.taskId),
      getTask: async () => ({ id: imported.taskId, title: "Campaign task" }),
    };

    const result = await processDueWorkflowWorkItem(store as any, { run } as any, undefined, {
      leaseOwner: "worker",
      leaseDurationMs: 1_000,
    });

    expect(result.runtime).toEqual(expect.objectContaining({
      disposition: "failed",
      reason: expect.stringContaining("attempt-zero promotion CAS refused"),
    }));
    expect(run).not.toHaveBeenCalled();
    expect(transitionWorkflowWorkItem).not.toHaveBeenCalledWith(imported.id, "succeeded", expect.anything());
  });

  it("Task 3 RED: exact workflow lease renewal loss aborts the campaign run", async () => {
    vi.useFakeTimers();
    let observedSignal: AbortSignal | undefined;
    const run = vi.fn((_task, _settings, options) => {
      observedSignal = options.signal;
      return new Promise<any>((resolve) => {
        options.signal.addEventListener("abort", () => resolve({
          disposition: "failed",
          outcome: "failure",
          visitedNodeIds: [],
          context: {},
          reason: "workflow-aborted",
        }), { once: true });
      });
    });
    const renewWorkflowWorkItemLease = vi.fn(async () => null);
    const transitionWorkflowWorkItem = vi.fn(async () => ({ ...item, state: "failed" }));
    const store = {
      listDueWorkflowWorkItems: async () => [item],
      acquireWorkflowWorkItemLease: async () => item,
      transitionWorkflowWorkItem,
      renewWorkflowWorkItemLease,
      getCccCampaignContextForTask: async () => campaignContext(),
      getTask: async () => ({ id: "FN-renew", title: "Campaign task" }),
    };

    const processing = processDueWorkflowWorkItem(store as any, { run } as any, undefined, {
      leaseOwner: "worker",
      leaseDurationMs: 900,
    });
    await vi.advanceTimersByTimeAsync(300);
    await processing;

    expect(renewWorkflowWorkItemLease).toHaveBeenCalledWith(item.id, "worker", 1, { leaseDurationMs: 900 });
    expect(observedSignal?.aborted).toBe(true);
    expect(transitionWorkflowWorkItem).toHaveBeenCalledWith(item.id, "failed", expect.objectContaining({
      expectedState: "running",
      expectedLeaseOwner: "worker",
      expectedAttempt: 1,
    }));
  });

  it("Task 3 RED: campaign work persists fenced failure before runtime when native work-item lease renewal is absent", async () => {
    const run = vi.fn(async () => ({ disposition: "completed", outcome: "success", visitedNodeIds: [], context: {} }));
    const transitionWorkflowWorkItem = vi.fn(async () => ({ ...item, state: "failed" }));
    const store = {
      listDueWorkflowWorkItems: async () => [item],
      acquireWorkflowWorkItemLease: async () => item,
      transitionWorkflowWorkItem,
      getCccCampaignContextForTask: async () => campaignContext(),
      getTask: async () => ({ id: "FN-renew", title: "Campaign task" }),
    };

    const result = await processDueWorkflowWorkItem(store as any, { run } as any, undefined, {
      leaseOwner: "worker",
      leaseDurationMs: 1_000,
    });

    expect(result.runtime).toEqual(expect.objectContaining({
      disposition: "failed",
      outcome: "failure",
      reason: expect.stringContaining("workflow campaign processor requires renewWorkflowWorkItemLease"),
    }));
    expect(transitionWorkflowWorkItem).toHaveBeenCalledWith(item.id, "failed", expect.objectContaining({
      expectedState: "running",
      expectedLeaseOwner: "worker",
      expectedAttempt: 1,
    }));
    expect(run).not.toHaveBeenCalled();
  });

  it("Task 3 RED: renewal loss after graph return refuses terminal success CAS", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const run = vi.fn((_task, _settings, _options) => new Promise<any>((resolve) => {
      finish = () => resolve({ disposition: "completed", outcome: "success", visitedNodeIds: [], context: {} });
    }));
    const renewWorkflowWorkItemLease = vi.fn(async () => null);
    const transitionWorkflowWorkItem = vi.fn(async () => ({ ...item, state: "succeeded" }));
    const store = {
      listDueWorkflowWorkItems: async () => [item],
      acquireWorkflowWorkItemLease: async () => item,
      transitionWorkflowWorkItem,
      renewWorkflowWorkItemLease,
      getCccCampaignContextForTask: async () => campaignContext(),
      getTask: async () => ({ id: "FN-renew", title: "Campaign task" }),
    };

    const processing = processDueWorkflowWorkItem(store as any, { run } as any, undefined, {
      leaseOwner: "worker",
      leaseDurationMs: 900,
    });
    await vi.advanceTimersByTimeAsync(300);
    finish();
    const result = await processing;

    expect(result.runtime).toEqual(expect.objectContaining({
      disposition: "failed",
      outcome: "failure",
      reason: "workflow-aborted",
    }));
    expect(transitionWorkflowWorkItem).toHaveBeenCalledWith(item.id, "failed", expect.objectContaining({
      expectedState: "running",
      expectedLeaseOwner: "worker",
      expectedAttempt: 1,
    }));
    expect(transitionWorkflowWorkItem).not.toHaveBeenCalledWith(item.id, "succeeded", expect.anything());
  });

  it("Task 3 RED: work-item lease renewal is single-flight while runtime is active", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    let finishRenewal!: () => void;
    const run = vi.fn(() => new Promise<any>((resolve) => {
      finish = () => resolve({ disposition: "completed", outcome: "success", visitedNodeIds: [], context: {} });
    }));
    const renewWorkflowWorkItemLease = vi.fn(() => new Promise<any>((resolve) => {
      finishRenewal = () => resolve(item);
    }));
    const store = {
      listDueWorkflowWorkItems: async () => [item],
      acquireWorkflowWorkItemLease: async () => item,
      transitionWorkflowWorkItem: vi.fn(async () => ({ ...item, state: "succeeded" })),
      renewWorkflowWorkItemLease,
      getCccCampaignContextForTask: async () => campaignContext(),
      getTask: async () => ({ id: "FN-renew", title: "Campaign task", summary: "already summarized" }),
    };

    const processing = processDueWorkflowWorkItem(store as any, { run } as any, undefined, {
      leaseOwner: "worker",
      leaseDurationMs: 900,
    });
    await vi.advanceTimersByTimeAsync(600);
    expect(renewWorkflowWorkItemLease).toHaveBeenCalledOnce();
    finishRenewal();
    await vi.advanceTimersByTimeAsync(300);
    expect(renewWorkflowWorkItemLease).toHaveBeenCalledTimes(2);

    finish();
    await processing;
  });

  it("Task 3 RED: stale owner or attempt cannot publish campaign success", async () => {
    const updateTask = vi.fn();
    const transitionWorkflowWorkItem = vi.fn(async () => {
      throw new Error("Workflow work item WW-renew transition precondition failed");
    });
    const store = {
      listDueWorkflowWorkItems: async () => [item],
      acquireWorkflowWorkItemLease: async () => item,
      transitionWorkflowWorkItem,
      renewWorkflowWorkItemLease: vi.fn(async () => item),
      getCccCampaignContextForTask: async () => campaignContext(),
      getTask: async () => ({ id: "FN-renew", title: "Campaign task" }),
      updateTask,
    };
    const runtime = {
      run: vi.fn(async () => ({ disposition: "completed", outcome: "success", visitedNodeIds: [], context: {} })),
    };

    await expect(processDueWorkflowWorkItem(store as any, runtime as any, undefined, {
      leaseOwner: "worker",
      leaseDurationMs: 1_000,
    })).rejects.toThrow("transition precondition failed");

    expect(transitionWorkflowWorkItem).toHaveBeenCalledWith(item.id, "succeeded", expect.objectContaining({
      expectedState: "running",
      expectedLeaseOwner: "worker",
      expectedAttempt: 1,
    }));
    expect(updateTask).not.toHaveBeenCalled();
  });

  it("Task 3 RED: campaign summary is written only after terminal CAS using a freshly reloaded task", async () => {
    const events: string[] = [];
    const getTask = vi
      .fn()
      .mockResolvedValueOnce({ id: "FN-renew", title: "Before classification", steps: [] })
      .mockResolvedValueOnce({ id: "FN-renew", title: "Before graph", steps: [] })
      .mockResolvedValueOnce({
        id: "FN-renew",
        title: "After CAS",
        steps: [{ title: "Finish graph", status: "done" }],
      });
    const updateTask = vi.fn(async (_taskId, _update) => { events.push("summary"); });
    const transitionWorkflowWorkItem = vi.fn(async () => {
      events.push("terminal-cas");
      return { ...item, state: "succeeded" };
    });
    const store = {
      listDueWorkflowWorkItems: async () => [item],
      acquireWorkflowWorkItemLease: async () => item,
      transitionWorkflowWorkItem,
      renewWorkflowWorkItemLease: vi.fn(async () => item),
      getCccCampaignContextForTask: async () => campaignContext(),
      getTask,
      updateTask,
      logEntry: vi.fn(),
    };
    const runtime = {
      run: vi.fn(async () => ({ disposition: "completed", outcome: "success", visitedNodeIds: ["start"], context: {} })),
    };

    const result = await processDueWorkflowWorkItem(store as any, runtime as any, undefined, {
      leaseOwner: "worker",
      leaseDurationMs: 1_000,
    });

    expect(result.runtime?.disposition).toBe("completed");
    expect(events).toEqual(["terminal-cas", "summary"]);
    expect(getTask).toHaveBeenCalledTimes(3);
    expect(updateTask.mock.calls[0]?.[1]?.summary).toContain("Workflow completed: After CAS.");
  });

  it("Task 3 RED: durable cancellation after runtime success is reported truthfully", async () => {
    const cancelled = { ...item, state: "cancelled", leaseOwner: "worker", attempt: 1, lastError: "cancelled-by-user-hard-cancel" };
    const store = {
      listDueWorkflowWorkItems: async () => [item],
      acquireWorkflowWorkItemLease: async () => item,
      transitionWorkflowWorkItem: vi.fn(async () => {
        throw new Error("Workflow work item WW-renew is terminal (cancelled) and cannot transition to succeeded");
      }),
      renewWorkflowWorkItemLease: vi.fn(async () => item),
      getCccCampaignContextForTask: async () => campaignContext(),
      getTask: async () => ({ id: "FN-renew", title: "Campaign task" }),
      getWorkflowWorkItem: vi.fn(async () => cancelled),
      updateTask: vi.fn(),
    };
    const runtime = {
      run: vi.fn(async () => ({ disposition: "completed", outcome: "success", visitedNodeIds: [], context: {} })),
    };

    const result = await processDueWorkflowWorkItem(store as any, runtime as any, undefined, {
      leaseOwner: "worker",
      leaseDurationMs: 1_000,
    });

    expect(result.runtime).toEqual(expect.objectContaining({
      disposition: "cancelled",
      outcome: "failure",
      reason: "workflow-work-item-cancelled",
    }));
    expect(store.updateTask).not.toHaveBeenCalled();
  });
});
