import { afterEach, describe, expect, it, vi } from "vitest";
import { processDueWorkflowWorkItem } from "../workflow-work-processor.js";

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
      .mockResolvedValueOnce({ id: "FN-renew", title: "Before CAS", steps: [] })
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
