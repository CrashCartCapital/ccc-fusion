/**
 * RED-M1: product-status must not silently anchor provider-attempt lookup on
 * `nativeTaskIds[0]` and swallow the result into `providerAttempts: []` when
 * that anchor cannot be resolved. `resolveCccPrdProductStatusProviderAttemptAnchorTaskId`
 * and `providerAttemptStatusesForCampaign` are the pure, database-free units
 * `inspectCccPrdProductStatus` now delegates to (same pattern as the pure
 * `providerAttemptStatus` transform proved in
 * ccc-prd-product-status-effective-route.test.ts), so the anchor-refusal and
 * multi-task surfacing behavior are proved directly here without a
 * PostgreSQL harness.
 *
 * Query-scoping reality found: `listCccProviderAttemptsForCampaign` ->
 * `loadHistory` (packages/core/src/ccc-campaign/provider-attempt.ts:844-867)
 * filters its `runAuditEvents` query only by `projectId` and
 * `campaignImportId` -- never by `taskId` -- and `assembleHistory`
 * (provider-attempt.ts:738-820) validates the fetched rows against
 * `context.requestCount`, which is the campaign-wide counter persisted on
 * `cccPrdImports.requestCount` (packages/core/src/ccc-campaign/store.ts:337,
 * :497), not a per-task counter. So any one resolvable campaign task can
 * anchor the lookup and the FULL multi-task attempt history returns
 * regardless of which task's ID is passed as `taskId`; the `taskId` argument
 * only resolves the anchor task's own context (route, deadline, custody
 * validity) via `loadCccCampaignContextForTask`
 * (packages/core/src/ccc-campaign/store.ts:308-513). The only silent gap is
 * that `loadCccCampaignContextForTask` returns `null` (rather than throwing)
 * when the anchor task's own row is absent from persisted custody
 * (store.ts:371), and `listCccProviderAttemptsForCampaign` turns that `null`
 * into an honestly-empty-looking `[]` (provider-attempt.ts:1303). The fix is
 * therefore anchor-refusal in product-status.ts, not a query-scoping change
 * in provider-attempt.ts.
 */
import { describe, expect, it } from "vitest";
import {
  productNextAction,
  providerAttemptStatusesForCampaign,
  resolveCccPrdProductStatusProviderAttemptAnchorTaskId,
  type CccPrdProductApprovalStatus,
  type CccPrdProductNextActionInput,
  type CccPrdProductTaskStatus,
  type CccPrdProductWorkItemStatus,
} from "../ccc-prd/product-status.js";
import { CccCampaignContextError } from "../ccc-campaign/types.js";
import type { CccProviderAttemptScope } from "../ccc-campaign/types.js";

function taskStatus(
  overrides: Partial<CccPrdProductTaskStatus> = {},
): CccPrdProductTaskStatus {
  return {
    ordinal: 0,
    semanticTaskId: "TASK-1",
    nativeTaskId: "task-1",
    present: true,
    title: "Task 1",
    description: null,
    route: null,
    worktree: null,
    branch: null,
    baseCommit: null,
    mergeCommit: null,
    state: {
      column: null,
      status: null,
      paused: null,
      userPaused: null,
      pausedReason: null,
      error: null,
      updatedAt: null,
    },
    ...overrides,
  };
}

const binding = Object.freeze({
  projectId: "project-1",
  importId: "import-1",
  campaignId: "campaign-1",
  taskId: "task-1",
  actionId: "task-1",
  actionTarget: "/repo",
  idempotencyKey: "idem-1",
  packetHash: "0".repeat(64),
  sidecarHash: "1".repeat(64),
  bundleHash: "2".repeat(64),
  targetRepository: "org/repo",
  targetBase: "main",
  providerId: "anthropic",
  modelId: "claude-sonnet-5",
  transport: "pi" as const,
  manifestHash: "3".repeat(64),
  bindingHash: "4".repeat(64),
});

function scope(overrides: Partial<CccProviderAttemptScope> = {}): CccProviderAttemptScope {
  return {
    attemptKey: `ccc-provider-attempt-${"a".repeat(64)}`,
    controllerToken: "ccc-provider-controller-00000000-0000-0000-0000-000000000000",
    taskId: "task-1",
    semanticTaskId: "TASK-1",
    campaignDeadlineAt: "2999-01-01T00:00:00.000Z",
    turnKey: "turn-1",
    dispatchKey: "dispatch-1",
    attemptOrdinal: 1,
    requestCount: 1,
    workItemFence: null,
    state: "dispatched_unknown",
    binding: { ...binding, taskId: overrides.taskId ?? "task-1", actionId: overrides.taskId ?? "task-1" },
    ...overrides,
  };
}

describe("resolveCccPrdProductStatusProviderAttemptAnchorTaskId", () => {
  it("RED-M1a: refuses (does not silently pick no anchor) when the campaign has no persisted task at all", () => {
    expect(() => resolveCccPrdProductStatusProviderAttemptAnchorTaskId([]))
      .toThrow(CccCampaignContextError);
  });

  it("RED-M1a: refuses when the first persisted task entity's own row is absent from custody", () => {
    const taskStatuses = [taskStatus({ present: false })];

    let thrown: unknown;
    try {
      resolveCccPrdProductStatusProviderAttemptAnchorTaskId(taskStatuses);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(CccCampaignContextError);
    expect((thrown as CccCampaignContextError).code).toBe("CCC_CAMPAIGN_CONTEXT_REFUSED");
  });

  it("resolves the first present task's native ID as the anchor (no false-positive refusal)", () => {
    const taskStatuses = [
      taskStatus({ nativeTaskId: "task-1", present: true }),
      taskStatus({ nativeTaskId: "task-2", present: true, ordinal: 1 }),
    ];

    expect(resolveCccPrdProductStatusProviderAttemptAnchorTaskId(taskStatuses)).toBe("task-1");
  });
});

describe("providerAttemptStatusesForCampaign multi-task surfacing", () => {
  it("RED-M1b: surfaces provider attempts belonging to a second, non-anchor task rather than dropping them", () => {
    const firstTaskAttempt = scope({ taskId: "task-1", attemptKey: `ccc-provider-attempt-${"a".repeat(64)}`, requestCount: 1 });
    const secondTaskAttempt = scope({ taskId: "task-2", attemptKey: `ccc-provider-attempt-${"b".repeat(64)}`, requestCount: 2 });

    const statuses = providerAttemptStatusesForCampaign([firstTaskAttempt, secondTaskAttempt]);

    const taskIds = statuses.map((status) => status.taskId);
    expect(taskIds).toContain("task-1");
    expect(taskIds).toContain("task-2");
    expect(statuses).toHaveLength(2);
  });

  it("sorts multi-task attempts by task ID, then request count, then attempt key", () => {
    const laterTask = scope({ taskId: "task-2", attemptKey: `ccc-provider-attempt-${"b".repeat(64)}`, requestCount: 2 });
    const earlierTask = scope({ taskId: "task-1", attemptKey: `ccc-provider-attempt-${"a".repeat(64)}`, requestCount: 1 });

    const statuses = providerAttemptStatusesForCampaign([laterTask, earlierTask]);

    expect(statuses.map((status) => status.taskId)).toEqual(["task-1", "task-2"]);
  });
});

/**
 * RED-M1c: the guided `nextAction` must see a SECOND task's live-execution hold.
 *
 * The parked work item's `taskId` stays pinned to the workflow entry task for
 * the whole campaign, so matching the issued live-execution approval by the WORK
 * ITEM's task ID can only ever surface task A's approval. Once task A's approval
 * is consumed and task B's is issued, the operator is told the campaign is
 * `blocked` while a claimable approval is sitting right there.
 */
const LIVE_EXECUTION_APPROVAL_REQUIRED_REASON =
  "ccc-permanent:CCC_CAMPAIGN_LIVE_EXECUTION_APPROVAL_REQUIRED";
const LIVE_EXECUTION_ACTION_ID = "ccc:live-execution";

function workItem(
  overrides: Partial<CccPrdProductWorkItemStatus> = {},
): CccPrdProductWorkItemStatus {
  return {
    id: "work-item-1",
    runId: "run-1",
    taskId: "task-1",
    nodeId: "node-1",
    kind: "prompt",
    state: "manual-required",
    attempt: 1,
    retryAfter: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    lastError: LIVE_EXECUTION_APPROVAL_REQUIRED_REASON,
    blockedReason: LIVE_EXECUTION_APPROVAL_REQUIRED_REASON,
    waitReason: null,
    stableWorkflowRunId: null,
    continuationSequence: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function approval(
  overrides: Partial<{
    id: string;
    taskId: string;
    status: string;
    actionId: string;
    requestedAt: string;
  }> = {},
): CccPrdProductApprovalStatus {
  return {
    id: "approval-1",
    status: "issued",
    taskId: "task-1",
    runId: "run-1",
    actionId: LIVE_EXECUTION_ACTION_ID,
    actionTarget: "/repo",
    requester: { actorId: "runtime", actorKind: "agent" },
    targetAction: { category: "live-execution", description: "dispatch" },
    requestedAt: "2026-08-01T00:00:00.000Z",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    campaign: {},
    ...overrides,
  } as unknown as CccPrdProductApprovalStatus;
}

/** A present task with a resolved route, so custody checks do not pre-empt the hold. */
const routedTask = {
  providerId: "anthropic",
  modelId: "claude-sonnet-5",
  transport: "pi",
  executor: "model",
  toolMode: "coding",
  worktreeMode: "isolated",
  ownedPaths: [],
  allowedWriteRoots: [],
  commitPolicy: "required",
  cliAdapterId: null,
} as const;

function nextActionInput(
  overrides: Partial<{
    workItems: readonly CccPrdProductWorkItemStatus[];
    approvals: readonly CccPrdProductApprovalStatus[];
    taskStatuses: readonly CccPrdProductTaskStatus[];
  }> = {},
): CccPrdProductNextActionInput {
  return {
    row: { state: "active", runnable: 1 } as unknown as CccPrdProductNextActionInput["row"],
    taskStatuses: overrides.taskStatuses ?? [
      taskStatus({ nativeTaskId: "task-1", semanticTaskId: "TASK-1", ordinal: 0, route: routedTask }),
      taskStatus({ nativeTaskId: "task-2", semanticTaskId: "TASK-2", ordinal: 1, route: routedTask }),
    ],
    workItems: overrides.workItems ?? [],
    proofs: [],
    orphanProofAttempts: [],
    providerAttempts: [],
    approvals: overrides.approvals ?? [],
    landingIntents: [],
    landingMaterializations: [],
    landingTerminals: [],
    liveExecutionActionIds: new Set([LIVE_EXECUTION_ACTION_ID]),
    mergeActionIds: new Set(["ccc:merge"]),
  };
}

describe("productNextAction multi-task live-execution holds", () => {
  it("RED-M1c: surfaces the second task's issued live-execution approval instead of reporting blocked", () => {
    const action = productNextAction(nextActionInput({
      // The parked item's taskId stays pinned to the workflow entry task.
      workItems: [workItem({ taskId: "task-1" })],
      approvals: [
        approval({ id: "approval-1", taskId: "task-1", status: "consumed" }),
        approval({
          id: "approval-2",
          taskId: "task-2",
          status: "issued",
          requestedAt: "2026-08-01T01:00:00.000Z",
        }),
      ],
    }));

    expect(action.kind).toBe("approve-execution");
    expect(action).toMatchObject({ approvalRequestId: "approval-2", approvalStatus: "issued" });
  });

  it("still surfaces the entry task's own issued live-execution approval", () => {
    const action = productNextAction(nextActionInput({
      workItems: [workItem({ taskId: "task-1" })],
      approvals: [approval({ id: "approval-1", taskId: "task-1", status: "issued" })],
    }));

    expect(action.kind).toBe("approve-execution");
    expect(action).toMatchObject({ approvalRequestId: "approval-1" });
  });

  it("surfaces the EARLIEST unconsumed issued approval when several campaign tasks hold", () => {
    const action = productNextAction(nextActionInput({
      workItems: [workItem({ taskId: "task-1" })],
      approvals: [
        approval({
          id: "approval-3",
          taskId: "task-3",
          status: "issued",
          requestedAt: "2026-08-01T03:00:00.000Z",
        }),
        approval({
          id: "approval-2",
          taskId: "task-2",
          status: "issued",
          requestedAt: "2026-08-01T02:00:00.000Z",
        }),
      ],
    }));

    expect(action).toMatchObject({ kind: "approve-execution", approvalRequestId: "approval-2" });
  });

  it("does not surface an approval whose action is not a live-execution action", () => {
    const action = productNextAction(nextActionInput({
      workItems: [workItem({ taskId: "task-1" })],
      approvals: [approval({ id: "approval-9", taskId: "task-2", actionId: "ccc:merge" })],
    }));

    expect(action.kind).not.toBe("approve-execution");
  });

  it("does not surface a consumed live-execution approval", () => {
    const action = productNextAction(nextActionInput({
      workItems: [workItem({ taskId: "task-1" })],
      approvals: [approval({ id: "approval-1", taskId: "task-2", status: "consumed" })],
    }));

    expect(action.kind).not.toBe("approve-execution");
  });

  /*
  RED (fan-out): concurrent branches can leave one branch's approval CLAIMED
  but unconsumed (its dispatch was aborted when the sibling branch parked)
  while the sibling's approval is still ISSUED. Sorting purely by requestedAt
  then guides the operator at the claimed approval forever — approve-execution
  on it is an idempotent no-op replay, the resumed run re-parks on the
  unapproved sibling, and the campaign livelocks. The actionable ISSUED
  approval must outrank a claimed one regardless of issuance order.
  */
  it("guides at the ISSUED sibling approval, not an earlier claimed-but-unconsumed one", () => {
    const action = productNextAction(nextActionInput({
      workItems: [workItem({ taskId: "task-1" })],
      approvals: [
        approval({ id: "approval-1", taskId: "task-1", status: "consumed" }),
        // Branch C parked first: approved by the operator, claimed by the
        // runtime, then its dispatch was aborted before consumption.
        approval({
          id: "approval-3",
          taskId: "task-3",
          status: "claimed",
          requestedAt: "2026-08-01T01:00:00.000Z",
        }),
        // Branch B is the one actually waiting on the operator.
        approval({
          id: "approval-2",
          taskId: "task-2",
          status: "issued",
          requestedAt: "2026-08-01T01:00:01.000Z",
        }),
      ],
    }));

    expect(action).toMatchObject({
      kind: "approve-execution",
      approvalRequestId: "approval-2",
      approvalStatus: "issued",
    });
  });

  it("still guides at the earliest claimed approval when nothing is issued (crash-recovery replay)", () => {
    const action = productNextAction(nextActionInput({
      workItems: [workItem({ taskId: "task-1" })],
      approvals: [
        approval({
          id: "approval-3",
          taskId: "task-3",
          status: "claimed",
          requestedAt: "2026-08-01T02:00:00.000Z",
        }),
        approval({
          id: "approval-2",
          taskId: "task-2",
          status: "claimed",
          requestedAt: "2026-08-01T01:00:00.000Z",
        }),
      ],
    }));

    expect(action).toMatchObject({
      kind: "approve-execution",
      approvalRequestId: "approval-2",
      approvalStatus: "claimed",
    });
  });
});
