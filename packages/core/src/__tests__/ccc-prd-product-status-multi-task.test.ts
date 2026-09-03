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
import { describe, expect, it, vi } from "vitest";
import {
  campaignClockStatus,
  joinCccPrdProductExecutionAuthorizationMemberCustody,
  productNextAction,
  productRequestBudgetStatus,
  providerAttemptStatusesForCampaign,
  resolveCccPrdProductStatusProviderAttemptAnchorTaskId,
  type CccPrdProductApprovalStatus,
  type CccPrdProductExecutionAuthorizationStatus,
  type CccPrdProductNextActionInput,
  type CccPrdProductProofAttemptStatus,
  type CccPrdProductTaskStatus,
  type CccPrdProductWorkItemStatus,
} from "../ccc-prd/product-status.js";
import {
  CCC_CAMPAIGN_RECOMMENDED_REQUESTS_PER_PROVIDER_TASK,
  cccCampaignRecommendedStartingMaximum,
  cccCampaignRequestFloor,
  cccCampaignRequestSizingGuidance,
} from "../ccc-campaign/request-budget.js";
import { CccCampaignContextError } from "../ccc-campaign/types.js";
import { CccPrdImportError } from "../ccc-prd/import-error.js";
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
const REQUEST_BUDGET_EXHAUSTED_REASON =
  "ccc-permanent:CCC_CAMPAIGN_REQUEST_BUDGET_EXHAUSTED";
const PROOF_DEADLINE_EXPIRED_REASON =
  "ccc-permanent:CCC_CAMPAIGN_PROOF_DEADLINE_EXPIRED";
const MERGE_APPROVAL_REQUIRED_REASON =
  "ccc-permanent:CCC_CAMPAIGN_MERGE_APPROVAL_REQUIRED";
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
    actionTarget: string;
    bindingHash: string;
    requestedAt: string;
  }> = {},
): CccPrdProductApprovalStatus {
  const taskId = overrides.taskId ?? "task-1";
  const actionId = overrides.actionId ?? LIVE_EXECUTION_ACTION_ID;
  const actionTarget = overrides.actionTarget ?? `/repo/${taskId}`;
  const bindingHash = overrides.bindingHash ?? (taskId === "task-2"
    ? "b".repeat(64)
    : "a".repeat(64));
  return {
    id: "approval-1",
    status: "issued",
    taskId,
    runId: "run-1",
    actionId,
    actionTarget,
    requester: { actorId: "runtime", actorKind: "agent" },
    targetAction: { category: "live-execution", description: "dispatch" },
    requestedAt: "2026-08-01T00:00:00.000Z",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    campaign: {
      binding: {
        ...binding,
        taskId,
        actionId,
        actionTarget,
        bindingHash,
      },
      expiresAt: "2999-01-01T00:00:00.000Z",
      notBeforeAt: "2026-08-01T00:00:00.000Z",
    },
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

function executionAuthorization(
  status: "issued" | "claimed" | "settled" = "issued",
): CccPrdProductExecutionAuthorizationStatus {
  return {
    authorizationId: `ccc-execution-authorization-${"9".repeat(64)}`,
    status,
    expiresAt: "2999-01-01T00:00:00.000Z",
    members: [
      {
        ordinal: 0,
        semanticTaskId: "TASK-1",
        nativeTaskId: "task-1",
        actionId: LIVE_EXECUTION_ACTION_ID,
        actionTarget: "/repo/task-1",
        bindingHash: "a".repeat(64),
        approvalRequestId: `ccc-approval-${"a".repeat(64)}`,
      },
      {
        ordinal: 1,
        semanticTaskId: "TASK-2",
        nativeTaskId: "task-2",
        actionId: `${LIVE_EXECUTION_ACTION_ID}-2`,
        actionTarget: "/repo/task-2",
        bindingHash: "b".repeat(64),
        approvalRequestId: `ccc-approval-${"b".repeat(64)}`,
      },
    ],
  } as unknown as CccPrdProductExecutionAuthorizationStatus;
}

function nextActionInput(
  overrides: Partial<Pick<CccPrdProductNextActionInput,
    | "workItems"
    | "approvals"
    | "taskStatuses"
    | "requestBudget"
    | "proofs"
    | "orphanProofAttempts"
    | "providerAttempts"
    | "providerAttemptHistoryConsistent"
    | "executionAuthorizationMode"
    | "executionAuthorization"
  >> = {},
): CccPrdProductNextActionInput {
  return {
    row: { state: "active", runnable: 1 } as unknown as CccPrdProductNextActionInput["row"],
    observedAt: "2026-08-01T00:00:00.000Z",
    campaignDeadlineAt: "2026-08-08T00:00:00.000Z",
    requestBudget: overrides.requestBudget ?? {
      scope: "campaign-global",
      maximum: 24,
      used: 0,
      remaining: 24,
      providerTasks: 2,
      deterministicMinimum: 2,
      headroomAboveMinimum: 22,
      completionAdequacy: "unproven",
    },
    taskStatuses: overrides.taskStatuses ?? [
      taskStatus({ nativeTaskId: "task-1", semanticTaskId: "TASK-1", ordinal: 0, route: routedTask }),
      taskStatus({ nativeTaskId: "task-2", semanticTaskId: "TASK-2", ordinal: 1, route: routedTask }),
    ],
    workItems: overrides.workItems ?? [],
    proofs: overrides.proofs ?? [],
    orphanProofAttempts: overrides.orphanProofAttempts ?? [],
    providerAttempts: overrides.providerAttempts ?? [],
    providerAttemptHistoryConsistent:
      overrides.providerAttemptHistoryConsistent ?? true,
    approvals: overrides.approvals ?? [],
    executionAuthorizationMode: overrides.executionAuthorizationMode,
    executionAuthorization: overrides.executionAuthorization,
    landingIntents: [],
    landingMaterializations: [],
    landingTerminals: [],
    liveExecutionActionIds: new Set([LIVE_EXECUTION_ACTION_ID]),
    mergeActionIds: new Set(["ccc:merge"]),
  };
}

function proofAttempt(
  state: CccPrdProductProofAttemptStatus["state"],
  overrides: Partial<CccPrdProductProofAttemptStatus> = {},
): CccPrdProductProofAttemptStatus {
  return {
    attemptKey: "ccc-proof-attempt-1",
    importId: "import-1",
    campaignId: "campaign-1",
    taskId: "task-1",
    semanticTaskId: "TASK-1",
    proofId: "PROOF-1",
    packetHash: "0".repeat(64),
    sidecarHash: "1".repeat(64),
    bundleHash: "2".repeat(64),
    manifestHash: "3".repeat(64),
    campaignBindingHash: "4".repeat(64),
    targetRepository: "org/repo",
    targetBase: "main",
    sourceCommit: "5".repeat(40),
    sourceTree: "6".repeat(40),
    definitionSha256: "7".repeat(64),
    commandSha256: "8".repeat(64),
    workItemId: "work-item-1",
    runId: "run-1",
    workItemAttempt: 1,
    attemptContractVersion: "v1",
    phase: null,
    verifierClosureSha256: null,
    candidateInputsSha256: null,
    executionToolchainSha256: null,
    state,
    result: null,
    terminalEnvelope: null,
    terminalEnvelopeSha256: null,
    proofEvidence: null,
    proofEvidenceSha256: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    dispatchedAt: null,
    settledAt: null,
    ...overrides,
  };
}

describe("productNextAction multi-task live-execution holds", () => {
  it("keeps approval guidance when lastError includes a bounded diagnostic", () => {
    const authorization = executionAuthorization();
    const action = productNextAction(nextActionInput({
      workItems: [workItem({
        lastError:
          `${LIVE_EXECUTION_APPROVAL_REQUIRED_REASON}: awaiting exact authorization ${authorization.authorizationId}`,
      })],
      executionAuthorizationMode: "sealed_bundle_v1",
      executionAuthorization: authorization,
      approvals: authorization.members.map((member) => approval({
        id: member.approvalRequestId,
        taskId: member.nativeTaskId,
      })),
    }));

    expect(action).toMatchObject({
      kind: "approve-execution",
      executionAuthorizationId: authorization.authorizationId,
      executionAuthorizationStatus: "issued",
    });
  });

  it("surfaces one sealed parent authorization instead of either diagnostic child approval", () => {
    const authorization = executionAuthorization();
    const action = productNextAction(nextActionInput({
      workItems: [workItem({ taskId: "task-1" })],
      executionAuthorizationMode: "sealed_bundle_v1",
      executionAuthorization: authorization,
      approvals: [
        approval({ id: authorization.members[0]!.approvalRequestId, taskId: "task-1" }),
        approval({ id: authorization.members[1]!.approvalRequestId, taskId: "task-2" }),
      ],
    }));

    expect(action).toMatchObject({
      kind: "approve-execution",
      executionAuthorizationId: authorization.authorizationId,
      executionAuthorizationStatus: "issued",
    });
    expect(action).not.toHaveProperty("approvalRequestId");
  });

  it("RED-R11-expired-parent-status: blocks an expired sealed parent instead of advertising approve-execution", () => {
    const authorization = {
      ...executionAuthorization(),
      expiresAt: "2000-01-01T00:00:00.000Z",
    };
    const action = productNextAction(nextActionInput({
      workItems: [workItem({ taskId: "task-1" })],
      executionAuthorizationMode: "sealed_bundle_v1",
      executionAuthorization: authorization,
      approvals: [
        approval({ id: authorization.members[0]!.approvalRequestId, taskId: "task-1" }),
        approval({ id: authorization.members[1]!.approvalRequestId, taskId: "task-2" }),
      ],
    }));

    expect(action).toMatchObject({
      kind: "blocked",
      diagnostic: "CCC_CAMPAIGN_LIVE_EXECUTION_AUTHORIZATION_EXPIRED",
      nextSafeAction: expect.stringContaining("fresh semantic-v2 import"),
    });
    expect(action).not.toHaveProperty("executionAuthorizationId");
  });

  it("RED-R11-expired-claimed-parent: blocks an expired claimed parent after runtime requeue", () => {
    const authorization = {
      ...executionAuthorization("claimed"),
      expiresAt: "2000-01-01T00:00:00.000Z",
    };
    const action = productNextAction(nextActionInput({
      workItems: [workItem({
        taskId: "task-1",
        state: "runnable",
        lastError: null,
        blockedReason: null,
      })],
      executionAuthorizationMode: "sealed_bundle_v1",
      executionAuthorization: authorization,
    }));

    expect(action).toMatchObject({
      kind: "blocked",
      diagnostic: "CCC_CAMPAIGN_LIVE_EXECUTION_AUTHORIZATION_EXPIRED",
      nextSafeAction: expect.stringContaining("fresh semantic-v2 import"),
    });
  });

  it("RED-R11-expired-parent-db-clock: trusts the status snapshot clock when the app clock lags", () => {
    const authorization = {
      ...executionAuthorization(),
      expiresAt: "2026-08-14T14:19:04.384Z",
    };
    const appClock = vi.spyOn(Date, "now")
      .mockReturnValue(Date.parse("2026-08-14T14:00:00.000Z"));
    try {
      const action = productNextAction({
        ...nextActionInput({
          workItems: [workItem({ taskId: "task-1" })],
          executionAuthorizationMode: "sealed_bundle_v1",
          executionAuthorization: authorization,
        }),
        observedAt: "2026-08-14T14:30:00.000Z",
      });

      expect(action).toMatchObject({
        kind: "blocked",
        diagnostic: "CCC_CAMPAIGN_LIVE_EXECUTION_AUTHORIZATION_EXPIRED",
      });
    } finally {
      appClock.mockRestore();
    }
  });

  it("fails closed when a sealed live-execution hold has child diagnostics but no parent", () => {
    const action = productNextAction(nextActionInput({
      workItems: [workItem({ taskId: "task-1" })],
      executionAuthorizationMode: "sealed_bundle_v1",
      executionAuthorization: null,
      approvals: [approval({ id: "child-must-not-be-actionable", taskId: "task-1" })],
    }));

    expect(action).toMatchObject({
      kind: "blocked",
      reason: expect.stringContaining("single campaign authorization is missing"),
    });
    expect(action).not.toHaveProperty("approvalRequestId");
  });

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

describe("sealed execution-authorization member custody", () => {
  it("RED-W1-status-custody: joins every immutable parent member to one redacted child status", () => {
    const authorization = executionAuthorization();
    const custody = joinCccPrdProductExecutionAuthorizationMemberCustody(
      authorization,
      [
        approval({
          id: authorization.members[1]!.approvalRequestId,
          taskId: "task-2",
          status: "claimed",
          actionId: authorization.members[1]!.actionId,
          actionTarget: authorization.members[1]!.actionTarget,
          bindingHash: authorization.members[1]!.bindingHash,
        }),
        approval({
          id: authorization.members[0]!.approvalRequestId,
          taskId: "task-1",
          status: "issued",
          actionId: authorization.members[0]!.actionId,
          actionTarget: authorization.members[0]!.actionTarget,
          bindingHash: authorization.members[0]!.bindingHash,
        }),
      ],
    );

    expect(custody).toEqual([
      expect.objectContaining({
        ordinal: 0,
        semanticTaskId: "TASK-1",
        nativeTaskId: "task-1",
        approvalRequestId: authorization.members[0]!.approvalRequestId,
        status: "issued",
      }),
      expect.objectContaining({
        ordinal: 1,
        semanticTaskId: "TASK-2",
        nativeTaskId: "task-2",
        approvalRequestId: authorization.members[1]!.approvalRequestId,
        status: "claimed",
      }),
    ]);
    expect(JSON.stringify(custody)).not.toContain("claimToken");
  });

  it("RED-W1-status-custody: refuses a missing child approval instead of hiding the member", () => {
    const authorization = executionAuthorization();
    expect(() => joinCccPrdProductExecutionAuthorizationMemberCustody(
      authorization,
      [approval({ id: authorization.members[0]!.approvalRequestId })],
    )).toThrow(CccPrdImportError);
  });

  it("RED-W1-status-custody: refuses duplicate child approvals for one parent member", () => {
    const authorization = executionAuthorization();
    const child = approval({ id: authorization.members[0]!.approvalRequestId });
    expect(() => joinCccPrdProductExecutionAuthorizationMemberCustody(
      authorization,
      [child, { ...child, requestedAt: "2026-08-01T00:00:01.000Z" }],
    )).toThrow(CccPrdImportError);
  });

  it("RED-W1-status-custody: refuses non-campaign child lifecycle status", () => {
    const authorization = executionAuthorization();
    expect(() => joinCccPrdProductExecutionAuthorizationMemberCustody(
      authorization,
      [
        approval({ id: authorization.members[0]!.approvalRequestId, status: "approved" }),
        approval({
          id: authorization.members[1]!.approvalRequestId,
          taskId: "task-2",
          actionId: authorization.members[1]!.actionId,
          actionTarget: authorization.members[1]!.actionTarget,
          bindingHash: authorization.members[1]!.bindingHash,
        }),
      ],
    )).toThrow(CccPrdImportError);
  });

  it("RED-W1-status-custody: refuses child approval binding drift", () => {
    const authorization = executionAuthorization();
    expect(() => joinCccPrdProductExecutionAuthorizationMemberCustody(
      authorization,
      [
        approval({ id: authorization.members[0]!.approvalRequestId, taskId: "different-task" }),
        approval({
          id: authorization.members[1]!.approvalRequestId,
          taskId: "task-2",
          actionId: authorization.members[1]!.actionId,
          actionTarget: authorization.members[1]!.actionTarget,
          bindingHash: authorization.members[1]!.bindingHash,
        }),
      ],
    )).toThrow(CccPrdImportError);
  });
});

describe("productNextAction request-budget custody precedence", () => {
  const exhaustedBudget = {
    scope: "campaign-global" as const,
    maximum: 2,
    used: 2,
    remaining: 0,
    providerTasks: 2,
    deterministicMinimum: 2,
    headroomAboveMinimum: 0,
    completionAdequacy: "unproven" as const,
  };
  const budgetWorkItem = workItem({
    id: "budget-work-item",
    state: "manual-required",
    lastError: REQUEST_BUDGET_EXHAUSTED_REASON,
    blockedReason: REQUEST_BUDGET_EXHAUSTED_REASON,
  });

  it("RED-S1-status: a reserved proof outranks fresh-import budget recovery", () => {
    const reserved = proofAttempt("reserved", {
      workItemId: "proof-work-item",
      runId: "proof-run",
      workItemAttempt: 3,
    });
    const action = productNextAction(nextActionInput({
      requestBudget: exhaustedBudget,
      workItems: [budgetWorkItem],
      proofs: [{
        definition: {} as never,
        definitionSha256: reserved.definitionSha256,
        attempts: [reserved],
      }],
    }));

    expect(action).toEqual({
      kind: "resolve-manual-required",
      reason: `Proof attempt ${reserved.attemptKey} is reserved and has unresolved proof custody.`,
    });
  });

  it("RED-S1-status: an exact live lease owns a reserved proof before budget recovery", () => {
    const reserved = proofAttempt("reserved", {
      workItemId: "proof-work-item",
      runId: "proof-run",
      workItemAttempt: 3,
    });
    const action = productNextAction(nextActionInput({
      requestBudget: exhaustedBudget,
      workItems: [
        budgetWorkItem,
        workItem({
          id: reserved.workItemId,
          runId: reserved.runId,
          state: "running",
          attempt: reserved.workItemAttempt,
          leaseOwner: "proof-runtime",
          leaseExpiresAt: "2999-08-01T00:00:00.000Z",
          lastError: null,
          blockedReason: null,
        }),
      ],
      proofs: [{
        definition: {} as never,
        definitionSha256: reserved.definitionSha256,
        attempts: [reserved],
      }],
    }));

    expect(action).toEqual({
      kind: "wait-for-runtime",
      reason:
        "Campaign provider/proof work is reserved or in flight and still owned by the runtime.",
    });
  });

  it("RED-S1-status: orphan proof custody outranks fresh-import budget recovery", () => {
    const action = productNextAction(nextActionInput({
      requestBudget: exhaustedBudget,
      workItems: [budgetWorkItem],
      orphanProofAttempts: [proofAttempt("proved_failed")],
    }));

    expect(action).toEqual({
      kind: "blocked",
      reason: "Persisted campaign custody is missing a task, route, or declared proof.",
    });
  });
});

describe("productNextAction runtime-lease snapshot clock", () => {
  it("RED-R11-lease-db-clock: treats a proof lease expired by database time as unowned when the app clock lags", () => {
    const unknown = proofAttempt("dispatched_unknown", {
      workItemId: "proof-work-item",
      runId: "proof-run",
      workItemAttempt: 3,
    });
    const appClock = vi.spyOn(Date, "now")
      .mockReturnValue(Date.parse("2026-08-14T14:00:00.000Z"));
    try {
      const action = productNextAction({
        ...nextActionInput({
          workItems: [workItem({
            id: unknown.workItemId,
            runId: unknown.runId,
            state: "running",
            attempt: unknown.workItemAttempt,
            leaseOwner: "proof-runtime",
            leaseExpiresAt: "2026-08-14T14:15:00.000Z",
            lastError: null,
            blockedReason: null,
          })],
          proofs: [{
            definition: {} as never,
            definitionSha256: unknown.definitionSha256,
            attempts: [unknown],
          }],
        }),
        observedAt: "2026-08-14T14:30:00.000Z",
      });

      expect(action).toEqual({
        kind: "resolve-manual-required",
        reason: `Proof attempt ${unknown.attemptKey} has an uncertain external effect.`,
      });
    } finally {
      appClock.mockRestore();
    }
  });

  it("RED-R11-lease-db-clock: keeps a provider attempt runtime-owned by database time when the app clock is ahead", () => {
    const fence = {
      workItemId: "provider-work-item",
      runId: "provider-run",
      attempt: 4,
    };
    const unknown = providerAttemptStatusesForCampaign([
      scope({
        state: "dispatched_unknown",
        workItemFence: fence,
      }),
    ])[0]!;
    const appClock = vi.spyOn(Date, "now")
      .mockReturnValue(Date.parse("2026-08-14T15:00:00.000Z"));
    try {
      const action = productNextAction({
        ...nextActionInput({
          workItems: [workItem({
            id: fence.workItemId,
            runId: fence.runId,
            state: "running",
            attempt: fence.attempt,
            leaseOwner: "provider-runtime",
            leaseExpiresAt: "2026-08-14T14:45:00.000Z",
            lastError: null,
            blockedReason: null,
          })],
          providerAttempts: [unknown],
        }),
        observedAt: "2026-08-14T14:30:00.000Z",
      });

      expect(action).toEqual({
        kind: "wait-for-runtime",
        reason:
          "Campaign provider/proof work is reserved or in flight and still owned by the runtime.",
      });
    } finally {
      appClock.mockRestore();
    }
  });
});

describe("productNextAction semantic-proof deadline custody", () => {
  const deadlineWorkItem = workItem({
    id: "proof-deadline-work-item",
    state: "manual-required",
    lastError: PROOF_DEADLINE_EXPIRED_REASON,
    blockedReason: PROOF_DEADLINE_EXPIRED_REASON,
  });

  it("RED-S5-db-deadline reports immutable expiry when reservation never became an external effect", () => {
    const reserved = proofAttempt("reserved", {
      workItemId: deadlineWorkItem.id,
      runId: deadlineWorkItem.runId,
      workItemAttempt: deadlineWorkItem.attempt,
    });
    const action = productNextAction(nextActionInput({
      workItems: [deadlineWorkItem],
      proofs: [{
        definition: {} as never,
        definitionSha256: reserved.definitionSha256,
        attempts: [reserved],
      }],
    }));

    expect(action).toMatchObject({
      kind: "blocked",
      diagnostic: "CCC_CAMPAIGN_PROOF_DEADLINE_EXPIRED",
      nextSafeAction: expect.stringContaining("fresh"),
    });
    expect(action.reason).toContain("deadline");
    expect(action.safeState).toContain(reserved.attemptKey);
    expect(action.safeState).toContain("was not dispatched");
    expect(action.recoveryOptions?.some((option) =>
      /^(?:retry|requeue)\b/iu.test(option))).toBe(false);
  });

  it("RED-S5-db-deadline keeps a dispatched-unknown proof ahead of fresh-import expiry advice", () => {
    const unknown = proofAttempt("dispatched_unknown", {
      workItemId: deadlineWorkItem.id,
      runId: deadlineWorkItem.runId,
      workItemAttempt: deadlineWorkItem.attempt,
    });
    const action = productNextAction(nextActionInput({
      workItems: [deadlineWorkItem],
      proofs: [{
        definition: {} as never,
        definitionSha256: unknown.definitionSha256,
        attempts: [unknown],
      }],
    }));

    expect(action).toEqual({
      kind: "resolve-manual-required",
      reason: `Proof attempt ${unknown.attemptKey} has an uncertain external effect.`,
    });
  });
});

describe("productNextAction semantic proof v2 truth", () => {
  it("RED-S5-STATUS-PHASE: never infers final proof from a passing task-phase generic result", () => {
    const taskAttempt = proofAttempt("committed", {
      attemptContractVersion: "v2",
      phase: "task",
      result: {
        success: true,
        exitCode: 0,
        durationMs: 1,
        stdoutSha256: "a".repeat(64),
        stderrSha256: "b".repeat(64),
        stdoutTail: "PASS",
        stderrTail: "",
        timedOut: false,
        killed: false,
        warnings: [],
        changedPathsSha256: "c".repeat(64),
        negativeControlLabel: null,
      },
      terminalEnvelope: {
        schema: "ccc-prd.proof-terminal-envelope.v2",
        kind: "verified",
        proofId: "PROOF-1",
        phase: "task",
        sourceCommit: "5".repeat(40),
        sourceTree: "6".repeat(40),
        exitCode: 0,
        durationMs: 1,
        stdoutSha256: "a".repeat(64),
        stderrSha256: "b".repeat(64),
        changedPathsSha256: "c".repeat(64),
        stdoutTail: "PASS",
        stderrTail: "",
        timedOut: false,
        killed: false,
        warnings: [],
        passed: true,
        evidence: {
          schema: "ccc-prd.proof-evidence.v2",
          proofId: "PROOF-1",
          phase: "task",
          sourceCommit: "5".repeat(40),
          sourceTree: "6".repeat(40),
          passed: true,
          clauseResults: [],
          positiveCaseResults: [],
          negativeControlResults: [],
        },
        evidenceSha256: "d".repeat(64),
      },
      terminalEnvelopeSha256: "e".repeat(64),
      proofEvidence: {
        schema: "ccc-prd.proof-evidence.v2",
        proofId: "PROOF-1",
        phase: "task",
        sourceCommit: "5".repeat(40),
        sourceTree: "6".repeat(40),
        passed: true,
        clauseResults: [],
        positiveCaseResults: [],
        negativeControlResults: [],
      },
      proofEvidenceSha256: "d".repeat(64),
    });
    const action = productNextAction(nextActionInput({
      workItems: [workItem({
        state: "manual-required",
        lastError: MERGE_APPROVAL_REQUIRED_REASON,
        blockedReason: MERGE_APPROVAL_REQUIRED_REASON,
      })],
      proofs: [{
        definition: {
          schema: "ccc-prd.proof.v2",
          id: "PROOF-1",
          phases: ["task", "final_integrated"],
        } as never,
        definitionSha256: taskAttempt.definitionSha256,
        attempts: [taskAttempt],
      }],
      approvals: [approval({
        id: "merge-approval",
        actionId: "ccc:merge",
        status: "issued",
      })],
    }));

    expect(action.kind).not.toBe("approve-merge");
  });
});

describe("C3: request floor is 2x provider tasks (structural, not adequacy)", () => {
  it("cccCampaignRequestFloor doubles provider task count", () => {
    expect(cccCampaignRequestFloor(2)).toBe(4);
    expect(cccCampaignRequestFloor(1)).toBe(2);
    expect(cccCampaignRequestFloor(5)).toBe(10);
  });

  it("productRequestBudgetStatus reports the doubled deterministic minimum and headroom", () => {
    const status = productRequestBudgetStatus(2, 4, 0);
    expect(status).toEqual({
      scope: "campaign-global",
      maximum: 4,
      used: 0,
      remaining: 4,
      providerTasks: 2,
      deterministicMinimum: 4,
      headroomAboveMinimum: 0,
      completionAdequacy: "unproven",
    });
  });

  it("with 2 provider tasks, maxRequests 3 is below the floor and maxRequests 4 meets it", () => {
    const floor = cccCampaignRequestFloor(2);
    expect(floor).toBe(4);
    expect(3 >= floor).toBe(false);
    expect(4 >= floor).toBe(true);

    const below = productRequestBudgetStatus(2, 3, 0);
    expect(below.deterministicMinimum).toBe(4);
    expect(below.headroomAboveMinimum).toBe(3 - 4);

    const at = productRequestBudgetStatus(2, 4, 0);
    expect(at.deterministicMinimum).toBe(4);
    expect(at.headroomAboveMinimum).toBe(0);
  });

  it("recommends a finite generous starting maximum distinct from the admission floor", () => {
    expect(CCC_CAMPAIGN_RECOMMENDED_REQUESTS_PER_PROVIDER_TASK).toBe(384);
    expect(cccCampaignRecommendedStartingMaximum(1)).toBe(384);
    expect(cccCampaignRecommendedStartingMaximum(3)).toBe(1_152);
    expect(cccCampaignRecommendedStartingMaximum(3)).toBeGreaterThan(
      cccCampaignRequestFloor(3),
    );
  });

  it("classifies floor-sized budgets as tight and recommendation-sized budgets as generous", () => {
    expect(cccCampaignRequestSizingGuidance(1, 2)).toEqual({
      recommendedStartingMaximum: 384,
      headroomAboveRecommendation: -382,
      sizingPosture: "tight",
    });
    expect(cccCampaignRequestSizingGuidance(1, 384)).toEqual({
      recommendedStartingMaximum: 384,
      headroomAboveRecommendation: 0,
      sizingPosture: "generous",
    });
  });
});

describe("C4a: campaign clock visibility", () => {
  it("campaignClockStatus reports remaining ms before the deadline", () => {
    const clock = campaignClockStatus(
      "2026-08-01T01:00:00.000Z",
      "2026-08-01T00:00:00.000Z",
    );
    expect(clock).toEqual({
      campaignDeadlineAt: "2026-08-01T01:00:00.000Z",
      remainingMs: 60 * 60 * 1000,
    });
  });

  it("campaignClockStatus never goes negative once the deadline has passed", () => {
    const clock = campaignClockStatus(
      "2026-08-01T00:00:00.000Z",
      "2026-08-01T01:00:00.000Z",
    );
    expect(clock.remainingMs).toBe(0);
  });

  it("approve-execution (sealed_bundle_v1) reason states the campaign deadline and remaining time", () => {
    const authorization = executionAuthorization();
    const action = productNextAction(nextActionInput({
      workItems: [workItem({ taskId: "task-1" })],
      executionAuthorizationMode: "sealed_bundle_v1",
      executionAuthorization: authorization,
    }));

    expect(action.kind).toBe("approve-execution");
    expect(action.reason).toContain("campaign clock started at import");
    expect(action.reason).toContain("2026-08-08T00:00:00.000Z");
  });

  it("approve-execution (per_task_v1) reason states the campaign deadline and remaining time", () => {
    const action = productNextAction(nextActionInput({
      workItems: [workItem({ taskId: "task-1" })],
      approvals: [approval({ id: "approval-1", taskId: "task-1", status: "issued" })],
    }));

    expect(action.kind).toBe("approve-execution");
    expect(action.reason).toContain("campaign clock started at import");
    expect(action.reason).toContain("2026-08-08T00:00:00.000Z");
  });
});
