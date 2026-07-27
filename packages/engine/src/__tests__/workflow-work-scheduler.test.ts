import type { AsyncMissionStore, Task, WorkflowWorkItem } from "@fusion/core";
import { describe, expect, it, vi } from "vitest";
import { claimDueWorkflowWorkItem, type WorkflowWorkSchedulerStore, WorkflowWorkSchedulerExactCandidateInvariantError } from "../workflow-work-scheduler.js";

const item = {
  id: "WW-1",
  taskId: "FN-1",
  runId: "run-1",
  nodeId: "execute",
  kind: "execute",
  state: "runnable",
  attempt: 1,
  retryAfter: null,
  leaseOwner: null,
  leaseExpiresAt: null,
  lastError: null,
  blockedReason: null,
  stableWorkflowRunId: null,
  continuationSequence: null,
  waitReason: null,
  sourceColumn: null,
  targetColumn: null,
  irHash: null,
  createdAt: "2026-07-26T00:00:00.000Z",
  updatedAt: "2026-07-26T00:00:00.000Z",
} as unknown as WorkflowWorkItem;

function store(overrides: Partial<WorkflowWorkSchedulerStore>): WorkflowWorkSchedulerStore {
  return {
    listDueWorkflowWorkItems: () => [],
    acquireWorkflowWorkItemLease: () => null,
    ...overrides,
  };
}

function missionTask(): Task {
  return {
    id: "FN-1",
    description: "",
    column: "todo",
    dependencies: [],
    steps: [],
    currentStep: 0,
    missionId: "M-1",
    sliceId: "SL-1",
    declaredSymbols: ["pkg/a.ts#A"],
  } as unknown as Task;
}

function activeMissionStore(): AsyncMissionStore {
  return {
    getFeatureByTaskId: async () => ({ id: "F-1", sliceId: "SL-1", status: "triaged" }),
    getSlice: async () => ({ id: "SL-1", milestoneId: "MS-1", status: "active" }),
    getMilestone: async () => ({ id: "MS-1", missionId: "M-1", status: "active" }),
    getMission: async () => ({ id: "M-1", status: "active" }),
  } as unknown as AsyncMissionStore;
}

function blockedMissionStore(): AsyncMissionStore {
  return {
    getFeatureByTaskId: async () => undefined,
    getSlice: async () => undefined,
    getMilestone: async () => undefined,
    getMission: async () => undefined,
  } as unknown as AsyncMissionStore;
}

describe("claimDueWorkflowWorkItem", () => {
  it("awaits normal coarse-fallback workflow lease acquisition", async () => {
    const acquireWorkflowWorkItemLease = vi.fn(() => item);
    const result = await claimDueWorkflowWorkItem(store({ listDueWorkflowWorkItems: () => [item], acquireWorkflowWorkItemLease }), { leaseOwner: "worker", leaseDurationMs: 1000 });
    expect(result).toMatchObject({ taskId: "FN-1", workItem: item });
    expect(acquireWorkflowWorkItemLease).toHaveBeenCalledOnce();
  });

  it("Task 6 P1 RED: ordinary coarse fallback does not read tasks without mission admission capabilities", async () => {
    const never = new Promise<never>(() => {});
    const getTask = vi.fn(() => never);
    const acquireWorkflowWorkItemLease = vi.fn(async () => item);

    const claim = claimDueWorkflowWorkItem(store({
      listDueWorkflowWorkItems: () => [item],
      getTask,
      acquireWorkflowWorkItemLease,
    }), {
      leaseOwner: "worker",
      leaseDurationMs: 1000,
    });

    await vi.waitFor(() => expect(acquireWorkflowWorkItemLease).toHaveBeenCalledOnce());
    await expect(claim).resolves.toMatchObject({ taskId: item.taskId, workItem: item });
    expect(getTask).not.toHaveBeenCalled();
  });

  it("Task 5 RED: claims the exact campaign candidate instead of an earlier ordinary due row", async () => {
    const ordinary = { ...item, id: "WW-ordinary", runId: "ordinary-run", attempt: 2 };
    const campaign = { ...item, id: "WW-campaign", runId: "ccc-prd:campaign-run", attempt: 7 };
    const acquireWorkflowWorkItemLease = vi.fn(async (id: string) => id === campaign.id ? campaign : ordinary);
    const getWorkflowWorkItem = vi.fn(async (id: string) => id === campaign.id ? campaign : null);

    const result = await claimDueWorkflowWorkItem(store({
      listDueWorkflowWorkItems: () => [ordinary, campaign],
      getWorkflowWorkItem,
      acquireWorkflowWorkItemLease,
    }), {
      leaseOwner: "worker",
      leaseDurationMs: 1000,
      exactCandidate: { id: campaign.id, runId: campaign.runId, attempt: campaign.attempt },
    });

    expect(result?.workItem).toBe(campaign);
    expect(getWorkflowWorkItem).toHaveBeenCalledWith(campaign.id);
    expect(acquireWorkflowWorkItemLease).toHaveBeenCalledWith(campaign.id, "worker", expect.objectContaining({
      expectedRunId: campaign.runId,
      expectedAttempt: campaign.attempt,
    }));
  });

  it("Task 5 RED: rejects a returned lease whose campaign identity differs from the exact candidate", async () => {
    const candidate = { ...item, id: "WW-campaign", runId: "ccc-prd:campaign-run", attempt: 7 };
    const releaseSymbolLocks = vi.fn(async () => undefined);
    await expect(claimDueWorkflowWorkItem(store({
      getWorkflowWorkItem: async () => candidate,
      listDueWorkflowWorkItems: () => [candidate],
      acquireWorkflowWorkItemLease: async () => ({ ...candidate, attempt: 8 }),
      releaseSymbolLocks,
      getTask: async () => missionTask(),
      getMissionStore: activeMissionStore,
      acquireSymbolLocks: async () => ({ acquired: true, conflicts: [] }),
    }), {
      leaseOwner: "worker",
      leaseDurationMs: 1000,
      exactCandidate: { id: candidate.id, runId: candidate.runId, attempt: candidate.attempt },
    })).rejects.toThrow(WorkflowWorkSchedulerExactCandidateInvariantError);

    expect(releaseSymbolLocks).toHaveBeenCalledWith(["pkg/a.ts#a"], "FN-1");
  });

  it("Task 5 RED: refuses an exact candidate outside the requested kinds before lease acquisition", async () => {
    const campaign = { ...item, id: "WW-campaign", runId: "ccc-prd:campaign-run", attempt: 7, kind: "task" };
    const acquireWorkflowWorkItemLease = vi.fn(async () => campaign);
    const result = await claimDueWorkflowWorkItem(store({
      getWorkflowWorkItem: async () => campaign,
      listDueWorkflowWorkItems: vi.fn(),
      acquireWorkflowWorkItemLease,
    }), {
      leaseOwner: "worker",
      leaseDurationMs: 1000,
      kinds: ["execute"],
      exactCandidate: { id: campaign.id, runId: campaign.runId, attempt: campaign.attempt },
    });

    expect(result).toBeNull();
    expect(acquireWorkflowWorkItemLease).not.toHaveBeenCalled();
  });

  it("Task 5 RED: refuses a direct lookup whose id differs from the exact candidate before lease acquisition", async () => {
    const exactCandidate = { id: "WW-campaign", runId: "ccc-prd:campaign-run", attempt: 7 };
    const wrongItem = { ...item, ...exactCandidate, id: "WW-different" };
    const acquireWorkflowWorkItemLease = vi.fn(async () => wrongItem);
    const result = await claimDueWorkflowWorkItem(store({
      getWorkflowWorkItem: async () => wrongItem,
      listDueWorkflowWorkItems: vi.fn(),
      acquireWorkflowWorkItemLease,
    }), {
      leaseOwner: "worker",
      leaseDurationMs: 1000,
      exactCandidate,
    });

    expect(result).toBeNull();
    expect(acquireWorkflowWorkItemLease).not.toHaveBeenCalled();
  });

  it("does not consume a work lease when mission lineage is unapproved", async () => {
    const acquireWorkflowWorkItemLease = vi.fn(() => item);
    const logEntry = vi.fn(async () => undefined);
    const result = await claimDueWorkflowWorkItem(store({
      listDueWorkflowWorkItems: () => [item], acquireWorkflowWorkItemLease, logEntry,
      getTask: async () => missionTask(),
      getMissionStore: blockedMissionStore,
      acquireSymbolLocks: vi.fn(),
    }), { leaseOwner: "worker", leaseDurationMs: 1000 });
    expect(result).toBeNull();
    expect(acquireWorkflowWorkItemLease).not.toHaveBeenCalled();
    expect(logEntry).toHaveBeenCalledWith("FN-1", expect.stringContaining("mission lineage blocked"));
  });

  it("bypasses only mission-symbol admission when campaign-required exact work owns custody recheck", async () => {
    const campaign = {
      ...item,
      id: "WW-campaign-required",
      runId: "ccc-prd:campaign-run",
      kind: "task",
      attempt: 0,
    };
    const acquireWorkflowWorkItemLease = vi.fn(async () => campaign);
    const logEntry = vi.fn(async () => undefined);
    const result = await claimDueWorkflowWorkItem(store({
      getWorkflowWorkItem: async () => campaign,
      listDueWorkflowWorkItems: () => [campaign],
      acquireWorkflowWorkItemLease,
      logEntry,
      getTask: async () => ({ ...missionTask(), id: campaign.taskId, sliceId: undefined, declaredSymbols: undefined }),
      getMissionStore: blockedMissionStore,
      acquireSymbolLocks: vi.fn(),
    }), {
      leaseOwner: "worker",
      leaseDurationMs: 1000,
      kinds: ["task"],
      bypassMissionSymbolAdmission: true,
      exactCandidate: { id: campaign.id, runId: campaign.runId, attempt: campaign.attempt },
    });

    expect(result?.workItem).toBe(campaign);
    expect(acquireWorkflowWorkItemLease).toHaveBeenCalledWith(campaign.id, "worker", expect.objectContaining({
      expectedRunId: campaign.runId,
      expectedAttempt: campaign.attempt,
    }));
    expect(logEntry).not.toHaveBeenCalledWith(campaign.taskId, expect.stringContaining("mission lineage blocked"));
  });

  it("keeps ordinary mission-linked candidates blocked before lease acquisition", async () => {
    const ordinary = {
      ...item,
      id: "WW-ordinary-mission",
      runId: "ordinary-mission-run",
      kind: "task",
      attempt: 0,
    };
    const acquireWorkflowWorkItemLease = vi.fn(async () => ordinary);
    const logEntry = vi.fn(async () => undefined);
    const result = await claimDueWorkflowWorkItem(store({
      getWorkflowWorkItem: async () => ordinary,
      listDueWorkflowWorkItems: () => [ordinary],
      acquireWorkflowWorkItemLease,
      logEntry,
      getTask: async () => ({ ...missionTask(), id: ordinary.taskId, sliceId: undefined, declaredSymbols: undefined }),
      getMissionStore: blockedMissionStore,
      acquireSymbolLocks: vi.fn(),
    }), {
      leaseOwner: "worker",
      leaseDurationMs: 1000,
      kinds: ["task"],
      exactCandidate: { id: ordinary.id, runId: ordinary.runId, attempt: ordinary.attempt },
    });

    expect(result).toBeNull();
    expect(acquireWorkflowWorkItemLease).not.toHaveBeenCalled();
    expect(logEntry).toHaveBeenCalledWith(ordinary.taskId, expect.stringContaining("mission lineage blocked"));
  });

  it("releases an acquired symbol lock when the workflow lease races", async () => {
    const releaseSymbolLocks = vi.fn(async () => undefined);
    const result = await claimDueWorkflowWorkItem(store({
      listDueWorkflowWorkItems: () => [item], acquireWorkflowWorkItemLease: () => null, releaseSymbolLocks,
      getTask: async () => missionTask(),
      getMissionStore: activeMissionStore,
      acquireSymbolLocks: async () => ({ acquired: true, conflicts: [] }),
    }), { leaseOwner: "worker", leaseDurationMs: 1000 });
    expect(result).toBeNull();
    expect(releaseSymbolLocks).toHaveBeenCalledWith(["pkg/a.ts#a"], "FN-1");
  });
});
