import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import {
  beginCccCampaignProofAttemptDispatch,
  claimCccCampaignApproval,
  claimCccCampaignExecutionAuthorization,
  consumeCccCampaignApprovalWithinTransaction,
  createCccCampaignAuthorityBinding,
  CCC_CAMPAIGN_REQUEST_BUDGET_EXHAUSTED_REASON,
  importCccPrdBundle,
  issueCccCampaignApproval,
  issueCccCampaignExecutionAuthorization,
  recordRunAuditEventWithinTransaction,
  reserveCccCampaignProofAttempt,
  settleCccCampaignProofAttempt,
} from "../../index.js";
import {
  createCccPrdImportTestProductBundle,
  createCccPrdImportTestExecutionPolicy,
  createCccPrdImportTestProductExecutionPolicy,
  rehashCccPrdImportTestBundle,
} from "../../__test-utils__/ccc-prd-import-fixture.js";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
} from "../../__test-utils__/pg-test-harness.js";
import type { AsyncDataLayer } from "../../postgres/data-layer.js";
import type { CccPrdSemanticBundle } from "../../ccc-prd/types.js";
import { inspectCccPrdProductStatus } from "../../ccc-prd/product-status.js";

const SOURCE_COMMIT = "d".repeat(40);
const SOURCE_TREE = "e".repeat(40);
const CLAIM_TOKEN = "claim-product-status-secret";
const MERGE_ACTION = {
  actionId: "MERGE-product-status",
  actionTarget: "refs/heads/main",
} as const;
const LIVE_EXECUTION_ACTION = {
  actionId: "LIVE-product-status",
  actionTarget: "fixture://native-done",
} as const;
const MERGE_APPROVAL_REQUIRED =
  "ccc-permanent:CCC_CAMPAIGN_MERGE_APPROVAL_REQUIRED";
const LIVE_EXECUTION_APPROVAL_REQUIRED =
  "ccc-permanent:CCC_CAMPAIGN_LIVE_EXECUTION_APPROVAL_REQUIRED";
function withMergeAction(source: CccPrdSemanticBundle): CccPrdSemanticBundle {
  const terminalTask = source.tasks.at(-1)!;
  return rehashCccPrdImportTestBundle({
    ...source,
    bounds: {
      ...source.bounds,
      maxRequests: 5,
      maxDurationMs: 120_000,
    },
    tasks: source.tasks.map((task) =>
      task.id === terminalTask.id
        ? { ...task, protectedActionIds: [MERGE_ACTION.actionId] }
        : task),
    protectedActions: [{
      id: MERGE_ACTION.actionId,
      kind: "merge",
      target: MERGE_ACTION.actionTarget,
      operatorDecision: "approve_merge",
      requiresOperatorDecision: true,
      spans: [terminalTask.spans[0]!],
    }],
  });
}

function withLiveExecutionAction(
  source: CccPrdSemanticBundle,
): CccPrdSemanticBundle {
  const liveActions = source.tasks.map((task, index) => index === 0
    ? {
      id: LIVE_EXECUTION_ACTION.actionId,
      kind: "live_execution" as const,
      target: LIVE_EXECUTION_ACTION.actionTarget,
      operatorDecision: "approve_live_execution" as const,
      requiresOperatorDecision: true,
      spans: [task.spans[0]!],
    }
    : {
      id: `${LIVE_EXECUTION_ACTION.actionId}-${index + 1}`,
      kind: "live_execution" as const,
      target: `fixture://native-done/${task.id}`,
      operatorDecision: "approve_live_execution" as const,
      requiresOperatorDecision: true,
      spans: [task.spans[0]!],
    });
  return rehashCccPrdImportTestBundle({
    ...source,
    tasks: source.tasks.map((task, index) => ({
      ...task,
      protectedActionIds: [liveActions[index]!.id],
    })),
    protectedActions: liveActions,
  });
}

pgDescribe("CCC PRD product status (PostgreSQL)", () => {
  const h = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_ccc_prd_product_status",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  async function nativeTaskIdForImport(
    importId: string,
    semanticTaskId: string,
  ): Promise<string> {
    const rows = await h.layer().db.execute(sql`
      SELECT native_id
      FROM project.ccc_prd_import_entities
      WHERE import_id = ${importId}
        AND entity_type = 'task'
        AND entity_id = ${semanticTaskId}
    `) as unknown as Array<{ native_id: string }>;
    expect(rows).toHaveLength(1);
    return rows[0]!.native_id;
  }

  it("reports an operator-stopped campaign as abandoned while preserving uncertainty", async () => {
    const source = createCccPrdImportTestProductBundle(
      h.rootDir(),
      "product-status-stopped",
    );
    const imported = await importCccPrdBundle({
      bundle: source,
      executionPolicy: createCccPrdImportTestProductExecutionPolicy(source),
      idempotencyKey: "product-status-stopped",
      store: h.store(),
      layer: h.layer(),
      rootDir: h.rootDir(),
    });
    const workItem = await h.store().getWorkflowWorkItem(
      `${imported.importId}--WORK-product-status-stopped`,
    );
    if (!workItem) throw new Error("missing stopped campaign work item");
    await h.store().transitionWorkflowWorkItem(workItem.id, "cancelled", {
      expectedState: "runnable",
      expectedAttempt: workItem.attempt,
      expectedLeaseOwner: null,
      attempt: workItem.attempt,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: `ccc-operator:campaign-stopped:${"a".repeat(64)}`,
      blockedReason:
        `ccc-operator:campaign-stopped:${"a".repeat(64)} Operator preserved an uncertain effect.`,
    });

    await expect(inspectCccPrdProductStatus({
      idempotencyKey: "product-status-stopped",
      layer: h.layer(),
      rootDir: h.rootDir(),
    })).resolves.toMatchObject({
      workItems: [{
        id: workItem.id,
        state: "cancelled",
        lastError: `ccc-operator:campaign-stopped:${"a".repeat(64)}`,
        blockedReason: expect.stringContaining(
          "Operator preserved an uncertain effect.",
        ),
      }],
      nextAction: {
        kind: "abandoned",
        reason: expect.stringContaining("preserved"),
      },
    });
  });

  it("surfaces redacted provider uncertainty as an exact operator decision", async () => {
    const source = createCccPrdImportTestProductBundle(
      h.rootDir(),
      "product-status-provider-unknown",
    );
    const imported = await importCccPrdBundle({
      bundle: source,
      executionPolicy: createCccPrdImportTestProductExecutionPolicy(source),
      idempotencyKey: "product-status-provider-unknown",
      store: h.store(),
      layer: h.layer(),
      rootDir: h.rootDir(),
    });
    const taskId = await nativeTaskIdForImport(
      imported.importId,
      source.tasks[0]!.id,
    );
    const [workItem] = await h.store().listWorkflowWorkItemsForTask(taskId, {
      kinds: ["task"],
    });
    if (!workItem) throw new Error("missing provider-attempt work item");
    const claimedWorkItem = await h.store().transitionWorkflowWorkItem(
      workItem.id,
      "running",
      {
        expectedState: "runnable",
        expectedAttempt: workItem.attempt,
        expectedLeaseOwner: null,
        attempt: workItem.attempt + 1,
        leaseOwner: "runtime-provider-owner",
        leaseExpiresAt: "2999-07-31T23:59:59.000Z",
      },
    );
    const reserved = await h.store().reserveCccProviderAttempt({
      taskId,
      actionId: taskId,
      actionTarget: h.rootDir(),
      turnKey: "turn-product-status-provider-unknown",
      dispatchKey: "dispatch-product-status-provider-unknown",
      providerId: "deterministic-fake",
      modelId: "fixture-v2",
      transport: "pi",
      workItemFence: {
        workItemId: claimedWorkItem.id,
        runId: claimedWorkItem.runId,
        attempt: claimedWorkItem.attempt,
      },
    });
    await h.store().beginCccProviderAttemptDispatch({
      taskId,
      attemptKey: reserved.attemptKey,
      controllerToken: reserved.controllerToken,
    });
    await h.store().upsertWorkflowWorkItem({
      ...claimedWorkItem,
      leaseExpiresAt: "2000-01-01T00:00:00.000Z",
    });

    const status = await inspectCccPrdProductStatus({
      idempotencyKey: "product-status-provider-unknown",
      layer: h.layer(),
      rootDir: h.rootDir(),
    });
    expect(status).toMatchObject({
      providerAttempts: [{
        attemptKey: reserved.attemptKey,
        taskId,
        semanticTaskId: source.tasks[0]!.id,
        turnKey: "turn-product-status-provider-unknown",
        dispatchKey: "dispatch-product-status-provider-unknown",
        workItemFence: {
          workItemId: claimedWorkItem.id,
          runId: claimedWorkItem.runId,
          attempt: claimedWorkItem.attempt,
        },
        state: "dispatched_unknown",
        binding: {
          providerId: "deterministic-fake",
          modelId: "fixture-v2",
          transport: "pi",
        },
      }],
      nextAction: {
        kind: "resolve-manual-required",
        reason: expect.stringContaining(reserved.attemptKey),
      },
    });
    expect(JSON.stringify(status)).not.toContain(reserved.controllerToken);
    expect(JSON.stringify(status)).not.toContain("controllerToken");

    await h.store().upsertWorkflowWorkItem({
      ...claimedWorkItem,
      leaseExpiresAt: "2999-07-31T23:59:59.000Z",
    });

    await expect(inspectCccPrdProductStatus({
      idempotencyKey: "product-status-provider-unknown",
      layer: h.layer(),
      rootDir: h.rootDir(),
    })).resolves.toMatchObject({
      workItems: [{
        id: claimedWorkItem.id,
        state: "running",
        leaseOwner: "runtime-provider-owner",
      }],
      providerAttempts: [{
        attemptKey: reserved.attemptKey,
        state: "dispatched_unknown",
      }],
      nextAction: {
        kind: "wait-for-runtime",
        reason: expect.stringContaining("still owned by the runtime"),
      },
    });

    await h.store().upsertWorkflowWorkItem({
      ...claimedWorkItem,
      state: "running",
      leaseOwner: "runtime-provider-owner",
      leaseExpiresAt: "2999-07-31T23:59:59.000Z",
      attempt: claimedWorkItem.attempt + 1,
    });
    await expect(inspectCccPrdProductStatus({
      idempotencyKey: "product-status-provider-unknown",
      layer: h.layer(),
      rootDir: h.rootDir(),
    })).resolves.toMatchObject({
      workItems: [{
        id: claimedWorkItem.id,
        state: "running",
        leaseOwner: "runtime-provider-owner",
        leaseExpiresAt: "2999-07-31T23:59:59.000Z",
        attempt: claimedWorkItem.attempt + 1,
      }],
      nextAction: {
        kind: "resolve-manual-required",
        reason: expect.stringContaining(reserved.attemptKey),
      },
    });
  });

  it("does not let one runtime-owned provider attempt hide separate manual work", async () => {
    const source = createCccPrdImportTestProductBundle(
      h.rootDir(),
      "product-status-mixed-uncertainty",
    );
    const imported = await importCccPrdBundle({
      bundle: source,
      executionPolicy: createCccPrdImportTestProductExecutionPolicy(source),
      idempotencyKey: "product-status-mixed-uncertainty",
      store: h.store(),
      layer: h.layer(),
      rootDir: h.rootDir(),
    });
    const taskId = await nativeTaskIdForImport(
      imported.importId,
      source.tasks[0]!.id,
    );
    const runningWorkItem = await h.store().getWorkflowWorkItem(
      `${imported.importId}--WORK-product-status-mixed-uncertainty`,
    );
    if (!runningWorkItem) throw new Error("missing mixed-uncertainty work item");
    const claimedWorkItem = await h.store().transitionWorkflowWorkItem(
      runningWorkItem.id,
      "running",
      {
        expectedState: "runnable",
        expectedAttempt: runningWorkItem.attempt,
        expectedLeaseOwner: null,
        attempt: runningWorkItem.attempt + 1,
        leaseOwner: "runtime-mixed-uncertainty-owner",
        leaseExpiresAt: "2999-07-31T23:59:59.000Z",
      },
    );
    const reserved = await h.store().reserveCccProviderAttempt({
      taskId,
      actionId: taskId,
      actionTarget: h.rootDir(),
      turnKey: "turn-product-status-mixed-uncertainty",
      dispatchKey: "dispatch-product-status-mixed-uncertainty",
      providerId: "deterministic-fake",
      modelId: "fixture-v2",
      transport: "pi",
      workItemFence: {
        workItemId: claimedWorkItem.id,
        runId: claimedWorkItem.runId,
        attempt: claimedWorkItem.attempt,
      },
    });
    await h.store().beginCccProviderAttemptDispatch({
      taskId,
      attemptKey: reserved.attemptKey,
      controllerToken: reserved.controllerToken,
    });
    const manualWorkItemId = `${imported.importId}--WORK-separate-manual-effect`;
    await h.store().upsertWorkflowWorkItem({
      id: manualWorkItemId,
      runId: claimedWorkItem.runId,
      stableWorkflowRunId: claimedWorkItem.stableWorkflowRunId,
      taskId,
      nodeId: "separate-manual-effect",
      kind: "task",
      state: "manual-required",
      attempt: 1,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: "separate external effect is uncertain",
      blockedReason: "operator reconciliation required",
    });

    await expect(inspectCccPrdProductStatus({
      idempotencyKey: "product-status-mixed-uncertainty",
      layer: h.layer(),
      rootDir: h.rootDir(),
    })).resolves.toMatchObject({
      providerAttempts: [{
        attemptKey: reserved.attemptKey,
        state: "dispatched_unknown",
      }],
      nextAction: {
        kind: "resolve-manual-required",
        reason: expect.stringContaining(manualWorkItemId),
      },
    });
  });

  it("projects one redacted sealed execution authorization and returns to runtime waiting after requeue", async () => {
    const source = withLiveExecutionAction(
      createCccPrdImportTestProductBundle(h.rootDir(), "product-status-live"),
    );
    const imported = await importCccPrdBundle({
      bundle: source,
      executionPolicy: createCccPrdImportTestProductExecutionPolicy(source),
      idempotencyKey: "product-status-live",
      store: h.store(),
      layer: h.layer(),
      rootDir: h.rootDir(),
    });
    const codingTaskId = await nativeTaskIdForImport(
      imported.importId,
      source.tasks[0]!.id,
    );
    const campaign = await h.store().getCccCampaignContextForTask(codingTaskId);
    if (!campaign) throw new Error("missing live-execution campaign context");
    const issued = await issueCccCampaignExecutionAuthorization(h.layer(), {
      authorityStore: h.store(),
      rootDir: h.rootDir(),
      taskId: codingTaskId,
      requester: {
        actorId: "runtime-product-status-live",
        actorType: "agent",
        actorName: "Runtime",
      },
      notBeforeAt: campaign.campaignStartedAt,
      expiresAt: campaign.campaignDeadlineAt,
    });
    const workItem = await h.store().getWorkflowWorkItem(
      `${imported.importId}--WORK-product-status-live`,
    );
    if (!workItem) throw new Error("missing live-execution workflow work item");
    await h.store().upsertWorkflowWorkItem({
      ...workItem,
      state: "manual-required",
      attempt: 1,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: LIVE_EXECUTION_APPROVAL_REQUIRED,
      blockedReason: LIVE_EXECUTION_APPROVAL_REQUIRED,
      waitReason: null,
    });

    const issuedStatus = await inspectCccPrdProductStatus({
      idempotencyKey: "product-status-live",
      layer: h.layer(),
      rootDir: h.rootDir(),
    });
    expect(issuedStatus?.executionAuthorizationMode).toBe("sealed_bundle_v1");
    expect(issuedStatus?.workItems).toMatchObject([{
      id: workItem.id,
      state: "manual-required",
      lastError: LIVE_EXECUTION_APPROVAL_REQUIRED,
      blockedReason: LIVE_EXECUTION_APPROVAL_REQUIRED,
    }]);
    expect(issuedStatus?.executionAuthorization).toMatchObject({
      authorizationId: issued.authorizationId,
      authorizationDigest: issued.authorizationDigest,
      memberSetHash: issued.memberSetHash,
      expectedRequestCount: 0,
      status: "issued",
      members: issued.members.map((member) => ({
        nativeTaskId: member.nativeTaskId,
        approvalRequestId: member.approvalRequestId,
        bindingHash: member.bindingHash,
      })),
    });
    expect(issuedStatus?.approvals).toEqual(expect.arrayContaining(
      issued.members.map((member) => expect.objectContaining({
        id: member.approvalRequestId,
        status: "issued",
      })),
    ));
    expect(issuedStatus?.nextAction).toMatchObject({
      kind: "approve-execution",
      executionAuthorizationId: issued.authorizationId,
      executionAuthorizationStatus: "issued",
    });

    await claimCccCampaignExecutionAuthorization(h.layer(), {
      authorityStore: h.store(),
      rootDir: h.rootDir(),
      authorizationId: issued.authorizationId,
      claimant: {
        actorId: "operator-product-status-live",
        actorType: "user",
        actorName: "Operator",
      },
      claimToken: "product-status-live-claim-token",
    });
    const claimedStatus = await inspectCccPrdProductStatus({
      idempotencyKey: "product-status-live",
      layer: h.layer(),
      rootDir: h.rootDir(),
    });
    expect(claimedStatus?.workItems).toMatchObject([{
      id: workItem.id,
      state: "manual-required",
    }]);
    expect(claimedStatus?.executionAuthorization).toMatchObject({
      authorizationId: issued.authorizationId,
      status: "claimed",
    });
    expect(claimedStatus?.approvals).toEqual(expect.arrayContaining(
      issued.members.map((member) => expect.objectContaining({
        id: member.approvalRequestId,
        status: "claimed",
      })),
    ));
    expect(claimedStatus?.nextAction).toMatchObject({
      kind: "approve-execution",
      executionAuthorizationId: issued.authorizationId,
      executionAuthorizationStatus: "claimed",
    });
    expect(JSON.stringify(claimedStatus)).not.toContain("claimToken");
    expect(JSON.stringify(claimedStatus)).not.toContain("product-status-live-claim-token");

    await h.store().transitionWorkflowWorkItem(workItem.id, "runnable", {
      expectedState: "manual-required",
      expectedAttempt: 1,
      attempt: 1,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: null,
      blockedReason: null,
    });

    const resumedStatus = await inspectCccPrdProductStatus({
      idempotencyKey: "product-status-live",
      layer: h.layer(),
      rootDir: h.rootDir(),
    });
    expect(resumedStatus?.workItems).toMatchObject([{
      id: workItem.id,
      state: "runnable",
      lastError: null,
      blockedReason: null,
    }]);
    expect(resumedStatus?.executionAuthorization).toMatchObject({
      authorizationId: issued.authorizationId,
      status: "claimed",
    });
    expect(resumedStatus?.approvals).toEqual(expect.arrayContaining(
      issued.members.map((member) => expect.objectContaining({
        id: member.approvalRequestId,
        status: "claimed",
      })),
    ));
    expect(resumedStatus?.nextAction).toMatchObject({ kind: "wait-for-runtime" });
  });

  it("keeps manifest-v1 imports on their exact per-task approval status contract", async () => {
    const source = withLiveExecutionAction(
      createCccPrdImportTestProductBundle(h.rootDir(), "product-status-live-legacy"),
    );
    const imported = await importCccPrdBundle({
      bundle: source,
      executionPolicy: createCccPrdImportTestExecutionPolicy(source),
      idempotencyKey: "product-status-live-legacy",
      store: h.store(),
      layer: h.layer(),
      rootDir: h.rootDir(),
    });
    const codingTaskId = await nativeTaskIdForImport(
      imported.importId,
      source.tasks[0]!.id,
    );
    const campaign = await h.store().getCccCampaignContextForTask(codingTaskId);
    if (!campaign) throw new Error("missing legacy live-execution campaign context");
    expect(campaign.executionAuthorizationMode).toBe("per_task_v1");
    const issued = await issueCccCampaignApproval(h.layer(), {
      authorityStore: h.store(),
      rootDir: h.rootDir(),
      taskId: codingTaskId,
      action: LIVE_EXECUTION_ACTION,
      requester: {
        actorId: "runtime-product-status-live-legacy",
        actorType: "agent",
        actorName: "Runtime",
      },
      runId: "product-status-live-legacy-issue",
      notBeforeAt: campaign.campaignStartedAt,
      expiresAt: campaign.campaignDeadlineAt,
    });
    const workItem = await h.store().getWorkflowWorkItem(
      `${imported.importId}--WORK-product-status-live-legacy`,
    );
    if (!workItem) throw new Error("missing legacy live-execution workflow work item");
    await h.store().upsertWorkflowWorkItem({
      ...workItem,
      state: "manual-required",
      attempt: 1,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: LIVE_EXECUTION_APPROVAL_REQUIRED,
      blockedReason: LIVE_EXECUTION_APPROVAL_REQUIRED,
      waitReason: null,
    });

    const status = await inspectCccPrdProductStatus({
      idempotencyKey: "product-status-live-legacy",
      layer: h.layer(),
      rootDir: h.rootDir(),
    });
    expect(status?.executionAuthorizationMode).toBe("per_task_v1");
    expect(status?.executionAuthorization).toBeNull();
    expect(status?.approvals).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: issued.id, status: "issued" }),
    ]));
    expect(status?.nextAction).toMatchObject({
      kind: "approve-execution",
      approvalRequestId: issued.id,
      approvalStatus: "issued",
    });
    expect(status?.nextAction).not.toHaveProperty("executionAuthorizationId");
  });

  it("explains a verifier-confinement manual stop without calling it an uncertain effect", async () => {
    const source = createCccPrdImportTestProductBundle(
      h.rootDir(),
      "product-status-verifier-manual",
    );
    const imported = await importCccPrdBundle({
      bundle: source,
      executionPolicy: createCccPrdImportTestProductExecutionPolicy(source),
      idempotencyKey: "product-status-verifier-manual",
      store: h.store(),
      layer: h.layer(),
      rootDir: h.rootDir(),
    });
    const workItem = await h.store().getWorkflowWorkItem(
      `${imported.importId}--WORK-product-status-verifier-manual`,
    );
    if (!workItem) throw new Error("missing verifier-manual work item");
    const verifierUnavailable =
      "ccc-permanent:CCC_CAMPAIGN_VERIFIER_CONFINEMENT_UNAVAILABLE";
    await h.store().upsertWorkflowWorkItem({
      ...workItem,
      state: "manual-required",
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: verifierUnavailable,
      blockedReason: verifierUnavailable,
      waitReason: null,
    });

    const status = await inspectCccPrdProductStatus({
      idempotencyKey: "product-status-verifier-manual",
      layer: h.layer(),
      rootDir: h.rootDir(),
    });
    expect(status?.nextAction).toMatchObject({
      kind: "blocked",
      reason: "Verifier confinement is unavailable, so exact requirement proof cannot run safely.",
      diagnostic: "CCC_CAMPAIGN_VERIFIER_CONFINEMENT_UNAVAILABLE",
      safeState: `Workflow work item ${workItem.id} is parked manual-required; no proof attempt or Git landing effect is assumed.`,
      decisionOwner: "Fusion host or CI runner operator",
      consequence: "Campaign execution cannot continue until a trusted verifier sandbox passes its functional readiness probe.",
      recoveryOptions: [
        "Repair the trusted bubblewrap or sandbox-exec backend without enabling native fallback.",
        "After readiness passes, explicitly requeue the parked work item; do not blindly retry an uncertain effect.",
        "Stop the campaign if the operator does not want to continue, preserving receipts and worktree state.",
      ],
      nextSafeAction: "Run the verifier-confinement readiness check on the execution host, then inspect campaign status again.",
    });
    expect(status?.nextAction.kind).not.toBe("resolve-manual-required");
  });

  it("RED-S1-status: explains campaign-global request-budget exhaustion without suggesting a retry", async () => {
    const source = rehashCccPrdImportTestBundle({
      ...createCccPrdImportTestProductBundle(
        h.rootDir(),
        "product-status-request-budget",
      ),
      bounds: {
        maxRequests: 5,
        maxDurationMs: 120_000,
        maxConcurrency: 5,
      },
    });
    const imported = await importCccPrdBundle({
      bundle: source,
      executionPolicy: createCccPrdImportTestProductExecutionPolicy(source),
      idempotencyKey: "product-status-request-budget",
      store: h.store(),
      layer: h.layer(),
      rootDir: h.rootDir(),
    });
    const workItem = await h.store().getWorkflowWorkItem(
      `${imported.importId}--WORK-product-status-request-budget`,
    );
    if (!workItem) throw new Error("missing request-budget work item");
    const taskId = await nativeTaskIdForImport(
      imported.importId,
      source.tasks[0]!.id,
    );
    const claimedWorkItem = await h.store().transitionWorkflowWorkItem(
      workItem.id,
      "running",
      {
        expectedState: "runnable",
        expectedAttempt: workItem.attempt,
        expectedLeaseOwner: null,
        attempt: workItem.attempt + 1,
        leaseOwner: "runtime-request-budget-owner",
        leaseExpiresAt: "2999-08-12T00:00:00.000Z",
      },
    );
    for (let ordinal = 1; ordinal <= 5; ordinal += 1) {
      const reservation = await h.store().reserveCccProviderAttempt({
        taskId,
        actionId: taskId,
        actionTarget: h.rootDir(),
        turnKey: `turn-product-status-request-budget-${ordinal}`,
        dispatchKey: `dispatch-product-status-request-budget-${ordinal}`,
        providerId: "deterministic-fake",
        modelId: "fixture-v2",
        transport: "pi",
        workItemFence: {
          workItemId: claimedWorkItem.id,
          runId: claimedWorkItem.runId,
          attempt: claimedWorkItem.attempt,
        },
      });
      await h.store().proveCccProviderAttemptNotDispatched({
        taskId,
        attemptKey: reservation.attemptKey,
        controllerToken: reservation.controllerToken,
      });
    }
    await h.store().upsertWorkflowWorkItem({
      ...claimedWorkItem,
      state: "manual-required",
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: CCC_CAMPAIGN_REQUEST_BUDGET_EXHAUSTED_REASON,
      blockedReason: CCC_CAMPAIGN_REQUEST_BUDGET_EXHAUSTED_REASON,
      waitReason: null,
    });

    const status = await inspectCccPrdProductStatus({
      idempotencyKey: "product-status-request-budget",
      layer: h.layer(),
      rootDir: h.rootDir(),
    });

    expect(status?.nextAction).toEqual({
      kind: "blocked",
      reason:
        "The campaign-global provider request budget is exhausted; this immutable import cannot resume.",
      diagnostic: "CCC_CAMPAIGN_REQUEST_BUDGET_EXHAUSTED",
      safeState:
        `Workflow work item ${workItem.id} is parked manual-required after using 5 of 5 first-time provider-attempt reservation slots; the refused next slot was not reserved or dispatched. Existing attempts, commits, worktrees, and receipts remain preserved.`,
      decisionOwner: "Campaign operator",
      consequence:
        "The same immutable import cannot resume, prove, or land because its sealed request cap cannot be raised.",
      recoveryOptions: [
        "Retain the exhausted import and its receipts as immutable evidence; do not retry or requeue it.",
        "Create a fresh source-bound packet, preview, and import with a larger campaign-global maxRequests value.",
        "Treat prior task commits as evidence only; integrating those bytes into a new base requires separate authorization and proof.",
      ],
      nextSafeAction:
        "Create and confirm a fresh sealed import with a larger campaign-global request cap.",
    });
    expect(status?.nextAction.kind).not.toBe("resolve-manual-required");
    expect(status?.import.requestBudget).toEqual({
      scope: "campaign-global",
      maximum: 5,
      used: 5,
      remaining: 0,
      providerTasks: 2,
      deterministicMinimum: 2,
      headroomAboveMinimum: 3,
      completionAdequacy: "unproven",
    });
  });

  it("RED-S1-status: provider uncertainty dominates budget exhaustion until reconciliation", async () => {
    const source = rehashCccPrdImportTestBundle({
      ...createCccPrdImportTestProductBundle(
        h.rootDir(),
        "product-status-request-budget-unknown",
      ),
      bounds: {
        maxRequests: 5,
        maxDurationMs: 120_000,
        maxConcurrency: 5,
      },
    });
    const imported = await importCccPrdBundle({
      bundle: source,
      executionPolicy: createCccPrdImportTestProductExecutionPolicy(source),
      idempotencyKey: "product-status-request-budget-unknown",
      store: h.store(),
      layer: h.layer(),
      rootDir: h.rootDir(),
    });
    const workItem = await h.store().getWorkflowWorkItem(
      `${imported.importId}--WORK-product-status-request-budget-unknown`,
    );
    if (!workItem) throw new Error("missing request-budget-unknown work item");
    const taskId = await nativeTaskIdForImport(
      imported.importId,
      source.tasks[0]!.id,
    );
    const claimedWorkItem = await h.store().transitionWorkflowWorkItem(
      workItem.id,
      "running",
      {
        expectedState: "runnable",
        expectedAttempt: workItem.attempt,
        expectedLeaseOwner: null,
        attempt: workItem.attempt + 1,
        leaseOwner: "runtime-request-budget-unknown-owner",
        leaseExpiresAt: "2999-08-12T00:00:00.000Z",
      },
    );
    const reserved = await h.store().reserveCccProviderAttempt({
      taskId,
      actionId: taskId,
      actionTarget: h.rootDir(),
      turnKey: "turn-product-status-request-budget-unknown",
      dispatchKey: "dispatch-product-status-request-budget-unknown",
      providerId: "deterministic-fake",
      modelId: "fixture-v2",
      transport: "pi",
      workItemFence: {
        workItemId: claimedWorkItem.id,
        runId: claimedWorkItem.runId,
        attempt: claimedWorkItem.attempt,
      },
    });
    await h.store().beginCccProviderAttemptDispatch({
      taskId,
      attemptKey: reserved.attemptKey,
      controllerToken: reserved.controllerToken,
    });
    for (let ordinal = 2; ordinal <= 5; ordinal += 1) {
      const filler = await h.store().reserveCccProviderAttempt({
        taskId,
        actionId: taskId,
        actionTarget: h.rootDir(),
        turnKey: `turn-product-status-request-budget-unknown-${ordinal}`,
        dispatchKey: `dispatch-product-status-request-budget-unknown-${ordinal}`,
        providerId: "deterministic-fake",
        modelId: "fixture-v2",
        transport: "pi",
        workItemFence: {
          workItemId: claimedWorkItem.id,
          runId: claimedWorkItem.runId,
          attempt: claimedWorkItem.attempt,
        },
      });
      await h.store().proveCccProviderAttemptNotDispatched({
        taskId,
        attemptKey: filler.attemptKey,
        controllerToken: filler.controllerToken,
      });
    }
    await h.store().upsertWorkflowWorkItem({
      ...claimedWorkItem,
      state: "manual-required",
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: CCC_CAMPAIGN_REQUEST_BUDGET_EXHAUSTED_REASON,
      blockedReason: CCC_CAMPAIGN_REQUEST_BUDGET_EXHAUSTED_REASON,
      waitReason: null,
    });

    await expect(inspectCccPrdProductStatus({
      idempotencyKey: "product-status-request-budget-unknown",
      layer: h.layer(),
      rootDir: h.rootDir(),
    })).resolves.toMatchObject({
      nextAction: {
        kind: "resolve-manual-required",
        reason: expect.stringContaining(reserved.attemptKey),
      },
    });

    await h.store().reconcileCccProviderAttempt({
      ...reserved,
      taskId,
      attemptKey: reserved.attemptKey,
      controllerToken: reserved.controllerToken,
      outcome: "proved_failed",
      evidenceDigest: "1".repeat(64),
      observerId: "product-status-request-budget-unknown",
    });

    await expect(inspectCccPrdProductStatus({
      idempotencyKey: "product-status-request-budget-unknown",
      layer: h.layer(),
      rootDir: h.rootDir(),
    })).resolves.toMatchObject({
      nextAction: {
        kind: "blocked",
        diagnostic: "CCC_CAMPAIGN_REQUEST_BUDGET_EXHAUSTED",
        safeState: expect.stringContaining("first-time provider-attempt reservation slots"),
      },
    });
  });

  it("RED-S1-status: reserved provider custody dominates exact budget exhaustion advice", async () => {
    const source = rehashCccPrdImportTestBundle({
      ...createCccPrdImportTestProductBundle(
        h.rootDir(),
        "product-status-request-budget-reserved",
      ),
      bounds: {
        maxRequests: 5,
        maxDurationMs: 120_000,
        maxConcurrency: 5,
      },
    });
    const imported = await importCccPrdBundle({
      bundle: source,
      executionPolicy: createCccPrdImportTestProductExecutionPolicy(source),
      idempotencyKey: "product-status-request-budget-reserved",
      store: h.store(),
      layer: h.layer(),
      rootDir: h.rootDir(),
    });
    const workItem = await h.store().getWorkflowWorkItem(
      `${imported.importId}--WORK-product-status-request-budget-reserved`,
    );
    if (!workItem) throw new Error("missing request-budget-reserved work item");
    const taskId = await nativeTaskIdForImport(
      imported.importId,
      source.tasks[0]!.id,
    );
    const claimedWorkItem = await h.store().transitionWorkflowWorkItem(
      workItem.id,
      "running",
      {
        expectedState: "runnable",
        expectedAttempt: workItem.attempt,
        expectedLeaseOwner: null,
        attempt: workItem.attempt + 1,
        leaseOwner: "runtime-request-budget-reserved-owner",
        leaseExpiresAt: "2999-08-12T00:00:00.000Z",
      },
    );
    const reserved = await h.store().reserveCccProviderAttempt({
      taskId,
      actionId: taskId,
      actionTarget: h.rootDir(),
      turnKey: "turn-product-status-request-budget-reserved",
      dispatchKey: "dispatch-product-status-request-budget-reserved",
      providerId: "deterministic-fake",
      modelId: "fixture-v2",
      transport: "pi",
      workItemFence: {
        workItemId: claimedWorkItem.id,
        runId: claimedWorkItem.runId,
        attempt: claimedWorkItem.attempt,
      },
    });
    for (let ordinal = 2; ordinal <= 5; ordinal += 1) {
      await h.store().reserveCccProviderAttempt({
        taskId,
        actionId: taskId,
        actionTarget: h.rootDir(),
        turnKey: `turn-product-status-request-budget-reserved-${ordinal}`,
        dispatchKey: `dispatch-product-status-request-budget-reserved-${ordinal}`,
        providerId: "deterministic-fake",
        modelId: "fixture-v2",
        transport: "pi",
        workItemFence: {
          workItemId: claimedWorkItem.id,
          runId: claimedWorkItem.runId,
          attempt: claimedWorkItem.attempt,
        },
      });
    }
    await h.store().upsertWorkflowWorkItem({
      ...claimedWorkItem,
      state: "manual-required",
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: CCC_CAMPAIGN_REQUEST_BUDGET_EXHAUSTED_REASON,
      blockedReason: CCC_CAMPAIGN_REQUEST_BUDGET_EXHAUSTED_REASON,
      waitReason: null,
    });

    await expect(inspectCccPrdProductStatus({
      idempotencyKey: "product-status-request-budget-reserved",
      layer: h.layer(),
      rootDir: h.rootDir(),
    })).resolves.toMatchObject({
      nextAction: {
        kind: "resolve-manual-required",
        reason: expect.stringContaining(reserved.attemptKey),
      },
    });

    await h.store().upsertWorkflowWorkItem({
      ...claimedWorkItem,
      state: "running",
      leaseOwner: "runtime-request-budget-reserved-owner",
      leaseExpiresAt: "2999-08-12T00:00:00.000Z",
    });
    await expect(inspectCccPrdProductStatus({
      idempotencyKey: "product-status-request-budget-reserved",
      layer: h.layer(),
      rootDir: h.rootDir(),
    })).resolves.toMatchObject({
      nextAction: {
        kind: "wait-for-runtime",
        reason: expect.stringContaining("still owned by the runtime"),
      },
    });
  });

  it("RED-S1-status: refuses budget-exhaustion advice when the marker outruns the persisted counter", async () => {
    const source = rehashCccPrdImportTestBundle({
      ...createCccPrdImportTestProductBundle(
        h.rootDir(),
        "product-status-request-budget-counter-drift",
      ),
      bounds: {
        maxRequests: 5,
        maxDurationMs: 120_000,
        maxConcurrency: 5,
      },
    });
    const imported = await importCccPrdBundle({
      bundle: source,
      executionPolicy: createCccPrdImportTestProductExecutionPolicy(source),
      idempotencyKey: "product-status-request-budget-counter-drift",
      store: h.store(),
      layer: h.layer(),
      rootDir: h.rootDir(),
    });
    const workItem = await h.store().getWorkflowWorkItem(
      `${imported.importId}--WORK-product-status-request-budget-counter-drift`,
    );
    if (!workItem) throw new Error("missing request-budget-counter-drift work item");
    await h.store().upsertWorkflowWorkItem({
      ...workItem,
      state: "manual-required",
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: CCC_CAMPAIGN_REQUEST_BUDGET_EXHAUSTED_REASON,
      blockedReason: CCC_CAMPAIGN_REQUEST_BUDGET_EXHAUSTED_REASON,
      waitReason: null,
    });

    await expect(inspectCccPrdProductStatus({
      idempotencyKey: "product-status-request-budget-counter-drift",
      layer: h.layer(),
      rootDir: h.rootDir(),
    })).resolves.toMatchObject({
      nextAction: {
        kind: "blocked",
        diagnostic: "CCC_CAMPAIGN_REQUEST_BUDGET_COUNTER_DRIFT",
        safeState: expect.stringContaining("0 of 5 first-time provider-attempt reservation slots"),
      },
    });
  });

  it("RED-S1-status: treats request-budget counter overshoot as custody drift", async () => {
    const source = rehashCccPrdImportTestBundle({
      ...createCccPrdImportTestProductBundle(
        h.rootDir(),
        "product-status-request-budget-overshoot",
      ),
      bounds: {
        maxRequests: 2,
        maxDurationMs: 120_000,
        maxConcurrency: 2,
      },
    });
    const imported = await importCccPrdBundle({
      bundle: source,
      executionPolicy: createCccPrdImportTestProductExecutionPolicy(source),
      idempotencyKey: "product-status-request-budget-overshoot",
      store: h.store(),
      layer: h.layer(),
      rootDir: h.rootDir(),
    });
    const workItem = await h.store().getWorkflowWorkItem(
      `${imported.importId}--WORK-product-status-request-budget-overshoot`,
    );
    if (!workItem) throw new Error("missing request-budget-overshoot work item");
    await h.layer().db.execute(sql`
      UPDATE project.ccc_prd_imports
      SET request_count = 3
      WHERE import_id = ${imported.importId}
    `);
    await h.store().upsertWorkflowWorkItem({
      ...workItem,
      state: "manual-required",
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: CCC_CAMPAIGN_REQUEST_BUDGET_EXHAUSTED_REASON,
      blockedReason: CCC_CAMPAIGN_REQUEST_BUDGET_EXHAUSTED_REASON,
      waitReason: null,
    });

    await expect(inspectCccPrdProductStatus({
      idempotencyKey: "product-status-request-budget-overshoot",
      layer: h.layer(),
      rootDir: h.rootDir(),
    })).resolves.toMatchObject({
      nextAction: {
        kind: "blocked",
        diagnostic: "CCC_CAMPAIGN_REQUEST_BUDGET_COUNTER_DRIFT",
        safeState: expect.stringContaining("3 of 2 first-time provider-attempt reservation slots"),
      },
    });
  });

  it("RED-S1-status: treats an at-limit counter with missing attempt history as custody drift", async () => {
    const source = createCccPrdImportTestProductBundle(
      h.rootDir(),
      "product-status-request-budget-ledger-drift",
    );
    const imported = await importCccPrdBundle({
      bundle: source,
      executionPolicy: createCccPrdImportTestProductExecutionPolicy(source),
      idempotencyKey: "product-status-request-budget-ledger-drift",
      store: h.store(),
      layer: h.layer(),
      rootDir: h.rootDir(),
    });
    const workItem = await h.store().getWorkflowWorkItem(
      `${imported.importId}--WORK-product-status-request-budget-ledger-drift`,
    );
    if (!workItem) throw new Error("missing request-budget-ledger-drift work item");
    await h.layer().db.execute(sql`
      UPDATE project.ccc_prd_imports
      SET request_count = ${source.bounds.maxRequests}
      WHERE import_id = ${imported.importId}
    `);
    await h.store().upsertWorkflowWorkItem({
      ...workItem,
      state: "manual-required",
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: CCC_CAMPAIGN_REQUEST_BUDGET_EXHAUSTED_REASON,
      blockedReason: CCC_CAMPAIGN_REQUEST_BUDGET_EXHAUSTED_REASON,
      waitReason: null,
    });

    await expect(inspectCccPrdProductStatus({
      idempotencyKey: "product-status-request-budget-ledger-drift",
      layer: h.layer(),
      rootDir: h.rootDir(),
    })).resolves.toMatchObject({
      nextAction: {
        kind: "blocked",
        diagnostic: "CCC_CAMPAIGN_REQUEST_BUDGET_COUNTER_DRIFT",
        safeState: expect.stringContaining("does not match the provider-attempt ledger"),
      },
    });
  });

  it("prefers sanitized verifier recovery over a generic failed-work-item message for historical receipts", async () => {
    const source = createCccPrdImportTestProductBundle(
      h.rootDir(),
      "product-status-verifier-history",
    );
    const imported = await importCccPrdBundle({
      bundle: source,
      executionPolicy: createCccPrdImportTestProductExecutionPolicy(source),
      idempotencyKey: "product-status-verifier-history",
      store: h.store(),
      layer: h.layer(),
      rootDir: h.rootDir(),
    });
    const terminalTaskId = await nativeTaskIdForImport(
      imported.importId,
      source.tasks.at(-1)!.id,
    );
    const workItem = await h.store().getWorkflowWorkItem(
      `${imported.importId}--WORK-product-status-verifier-history`,
    );
    if (!workItem) throw new Error("missing verifier-history work item");
    const proofWorkItem = {
      ...workItem,
      attempt: 1,
      leaseOwner: null,
      leaseExpiresAt: null,
    };
    await h.store().upsertWorkflowWorkItem(proofWorkItem);
    const proof = source.proofs[0]!;
    const reserved = await reserveCccCampaignProofAttempt({
      layer: h.layer(),
      rootDir: h.rootDir(),
      taskId: terminalTaskId,
      proofId: proof.id,
      sourceCommit: SOURCE_COMMIT,
      sourceTree: SOURCE_TREE,
      workItemFence: {
        workItemId: proofWorkItem.id,
        runId: proofWorkItem.runId,
        attempt: proofWorkItem.attempt,
      },
    });
    await beginCccCampaignProofAttemptDispatch({
      layer: h.layer(),
      attemptKey: reserved.attemptKey,
      controllerToken: reserved.controllerToken,
    });
    await settleCccCampaignProofAttempt({
      layer: h.layer(),
      attemptKey: reserved.attemptKey,
      controllerToken: reserved.controllerToken,
      result: {
        success: false,
        exitCode: null,
        durationMs: 2,
        stdout: "",
        stderr:
          "bubblewrap is required for verifier confinement on Linux (not-installed-at-trusted-system-path); refusing to run verification natively. PRIVATE_ARBITRARY_STDERR",
        timedOut: false,
        killed: false,
        warnings: [],
        changedPathsSha256: createHash("sha256")
          .update(JSON.stringify([]), "utf8")
          .digest("hex"),
        negativeControlLabel: "verifier-confinement-unavailable",
      },
    });
    await h.store().upsertWorkflowWorkItem({
      ...proofWorkItem,
      state: "failed",
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: "verifier returned a terminal failure",
      blockedReason: "proof did not pass",
      waitReason: null,
    });

    const status = await inspectCccPrdProductStatus({
      idempotencyKey: "product-status-verifier-history",
      layer: h.layer(),
      rootDir: h.rootDir(),
    });
    expect(status?.nextAction).toMatchObject({
      kind: "blocked",
      reason: `Verifier confinement was unavailable for proof ${proof.id}; the infrastructure failure receipt is preserved and is not a product-test failure.`,
      diagnostic: "CCC_CAMPAIGN_VERIFIER_CONFINEMENT_UNAVAILABLE",
      safeState: `Proof attempt ${reserved.attemptKey} remains proved_failed at commit ${SOURCE_COMMIT}; workflow ${workItem.id} is failed and no Git landing is recorded.`,
      decisionOwner: "Fusion host or CI runner operator",
      consequence: "The campaign-created commit is preserved, but it has no passing requirement proof and cannot proceed to merge approval.",
      recoveryOptions: [
        "Repair the trusted bubblewrap or sandbox-exec backend without enabling native fallback.",
        "After readiness passes, explicitly requeue the failed work item and execute a fresh proof attempt bound to the preserved commit.",
        "Retain this failed receipt as infrastructure evidence; never relabel it as a planted-defect or product-test result.",
      ],
      nextSafeAction: "Run the verifier-confinement readiness check on the execution host, then explicitly requeue proof for the preserved source commit.",
    });
    expect(JSON.stringify(status?.nextAction)).not.toContain(
      "PRIVATE_ARBITRARY_STDERR",
    );
    expect(status?.nextAction.reason).not.toContain("ended as failed");
  });

  it("returns a deterministic, redacted, import-scoped operator snapshot", async () => {
    const source = withMergeAction(
      createCccPrdImportTestProductBundle(h.rootDir(), "product-status"),
    );
    const imported = await importCccPrdBundle({
      bundle: source,
      executionPolicy: createCccPrdImportTestProductExecutionPolicy(source),
      idempotencyKey: "product-status-primary",
      store: h.store(),
      layer: h.layer(),
      rootDir: h.rootDir(),
    });
    const other = createCccPrdImportTestProductBundle(h.rootDir(), "product-status-other");
    await importCccPrdBundle({
      bundle: other,
      executionPolicy: createCccPrdImportTestProductExecutionPolicy(other),
      idempotencyKey: "product-status-other",
      store: h.store(),
      layer: h.layer(),
      rootDir: h.rootDir(),
    });

    await expect(inspectCccPrdProductStatus({
      idempotencyKey: "missing",
      layer: h.layer(),
      rootDir: h.rootDir(),
    })).resolves.toBeNull();

    const initial = await inspectCccPrdProductStatus({
      idempotencyKey: "product-status-primary",
      layer: h.layer(),
      rootDir: h.rootDir(),
    });
    expect(initial).toMatchObject({
      schema: "ccc-prd.product-status.v1",
      import: {
        importId: imported.importId,
        idempotencyKey: "product-status-primary",
        identityHash: imported.identityHash,
        bundleHash: source.bundleHash,
        packetHash: source.provenance.packetHash,
        sidecarHash: source.sidecarHash,
        targetRepository: imported.targetRepository,
        targetBase: source.targetRepository.baseCommit,
        executionPolicySchema: "ccc-campaign.execution-policy.v2",
        campaignId: "CAMPAIGN-product-status",
        state: "active",
        runnable: true,
      },
      tasks: [
        {
          semanticTaskId: "TASK-product-status",
          route: {
            providerId: "deterministic-fake",
            modelId: "fixture-v2",
            transport: "pi",
            executor: "model",
            toolMode: "coding",
            worktreeMode: "isolated",
            ownedPaths: ["src/task-0"],
            allowedWriteRoots: ["src/task-0"],
            commitPolicy: "required",
          },
        },
        {
          semanticTaskId: "TASK-terminal-product-status",
          route: {
            ownedPaths: ["src/task-1"],
            allowedWriteRoots: ["src/task-1"],
          },
        },
      ],
      proofs: [{
        definition: { id: "PROOF-product-status", command: "pnpm test" },
        attempts: [],
      }],
      landing: { intents: [], terminals: [] },
      nextAction: { kind: "wait-for-runtime" },
    });
    expect(initial?.tasks).toHaveLength(2);
    expect(initial?.workItems).toHaveLength(1);
    expect(JSON.stringify(initial)).not.toContain("product-status-other");

    const terminalSemanticTaskId = source.tasks.at(-1)!.id;
    const terminalTaskId = await nativeTaskIdForImport(
      imported.importId,
      terminalSemanticTaskId,
    );
    await h.store().updateTask(terminalTaskId, {
      worktree: join(h.rootDir(), ".fusion", "worktrees", terminalTaskId),
      branch: "agent/product-status",
      baseCommitSha: source.targetRepository.baseCommit,
      mergeDetails: { commitSha: SOURCE_COMMIT },
      status: "proof-ready",
    });
    const workItem = await h.store().getWorkflowWorkItem(
      `${imported.importId}--WORK-product-status`,
    );
    if (!workItem) throw new Error("missing imported product-status work item");
    await h.store().upsertWorkflowWorkItem({
      ...workItem,
      state: "manual-required",
      attempt: 3,
      leaseOwner: "worker-product-status",
      leaseExpiresAt: "2026-07-30T20:00:00.000Z",
      lastError: "proof dispatch outcome is uncertain",
      blockedReason: "operator reconciliation required",
      waitReason: "capacity",
    });
    await expect(inspectCccPrdProductStatus({
      idempotencyKey: "product-status-primary",
      layer: h.layer(),
      rootDir: h.rootDir(),
    })).resolves.toMatchObject({
      tasks: [{
        semanticTaskId: "TASK-product-status",
      }, {
        semanticTaskId: terminalSemanticTaskId,
        worktree: join(h.rootDir(), ".fusion", "worktrees", terminalTaskId),
        branch: "agent/product-status",
        baseCommit: source.targetRepository.baseCommit,
        mergeCommit: SOURCE_COMMIT,
        state: { status: "proof-ready" },
      }],
      workItems: [{
        id: `${imported.importId}--WORK-product-status`,
        state: "manual-required",
        attempt: 3,
        leaseOwner: "worker-product-status",
        leaseExpiresAt: "2026-07-30T20:00:00.000Z",
        lastError: "proof dispatch outcome is uncertain",
        blockedReason: "operator reconciliation required",
        waitReason: "capacity",
      }],
      nextAction: { kind: "resolve-manual-required" },
    });

    const proof = source.proofs[0]!;
    const reserved = await reserveCccCampaignProofAttempt({
      layer: h.layer(),
      rootDir: h.rootDir(),
      taskId: terminalTaskId,
      proofId: proof.id,
      sourceCommit: SOURCE_COMMIT,
      sourceTree: SOURCE_TREE,
      workItemFence: {
        workItemId: workItem.id,
        runId: workItem.runId,
        attempt: 3,
      },
    });
    await beginCccCampaignProofAttemptDispatch({
      layer: h.layer(),
      attemptKey: reserved.attemptKey,
      controllerToken: reserved.controllerToken,
    });
    await settleCccCampaignProofAttempt({
      layer: h.layer(),
      attemptKey: reserved.attemptKey,
      controllerToken: reserved.controllerToken,
      result: {
        success: true,
        exitCode: 0,
        durationMs: 19,
        stdout: "one passing verifier\n",
        stderr: "",
        timedOut: false,
        killed: false,
        warnings: ["fixture warning"],
        changedPathsSha256: createHash("sha256")
          .update(JSON.stringify(["src/task-1"]), "utf8")
          .digest("hex"),
        negativeControlLabel: "planted-defect-failed",
      },
    });

    const campaign = await h.store().getCccCampaignContextForTask(terminalTaskId);
    if (!campaign) throw new Error("missing terminal campaign context");
    const requester = {
      actorId: "operator-product-status",
      actorType: "user" as const,
      actorName: "Operator",
    };
    const mergeApproval = await issueCccCampaignApproval(h.layer(), {
      authorityStore: h.store(),
      rootDir: h.rootDir(),
      taskId: terminalTaskId,
      action: MERGE_ACTION,
      requester,
      runId: "product-status-approval-issue",
      notBeforeAt: campaign.campaignStartedAt,
      expiresAt: campaign.campaignDeadlineAt,
    });
    await h.store().upsertWorkflowWorkItem({
      ...workItem,
      state: "manual-required",
      attempt: 4,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: MERGE_APPROVAL_REQUIRED,
      blockedReason: "exact human merge approval required",
      waitReason: null,
    });

    await expect(inspectCccPrdProductStatus({
      idempotencyKey: "product-status-primary",
      layer: h.layer(),
      rootDir: h.rootDir(),
    })).resolves.toMatchObject({
      proofs: [{
        definition: {
          id: proof.id,
          command: proof.command,
        },
        definitionSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        attempts: [{
          attemptKey: reserved.attemptKey,
          state: "committed",
          sourceCommit: SOURCE_COMMIT,
          sourceTree: SOURCE_TREE,
          definitionSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
          commandSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
          workItemId: workItem.id,
          runId: workItem.runId,
          workItemAttempt: 3,
          result: {
            success: true,
            exitCode: 0,
            durationMs: 19,
            stdoutSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
            stderrSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
            stdoutTail: "one passing verifier\n",
            stderrTail: "",
            timedOut: false,
            killed: false,
            warnings: ["fixture warning"],
            changedPathsSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
            negativeControlLabel: "planted-defect-failed",
          },
        }],
      }],
      approvals: [{
        status: "issued",
        actionId: MERGE_ACTION.actionId,
        actionTarget: MERGE_ACTION.actionTarget,
        requester: {
          actorId: requester.actorId,
          actorType: requester.actorType,
          actorName: requester.actorName,
        },
        targetAction: {
          action: MERGE_ACTION.actionId,
          resourceId: MERGE_ACTION.actionTarget,
        },
        taskId: terminalTaskId,
        runId: "product-status-approval-issue",
        campaign: {
          binding: {
            actionId: MERGE_ACTION.actionId,
            actionTarget: MERGE_ACTION.actionTarget,
            bindingHash: expect.stringMatching(/^[0-9a-f]{64}$/),
          },
          notBeforeAt: campaign.campaignStartedAt,
          expiresAt: campaign.campaignDeadlineAt,
        },
      }],
      nextAction: {
        kind: "approve-merge",
        approvalRequestId: mergeApproval.id,
        approvalStatus: "issued",
      },
    });
    await h.store().transitionWorkflowWorkItem(workItem.id, "succeeded", {
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: null,
      blockedReason: null,
    });

    await claimCccCampaignApproval(h.layer(), {
      authorityStore: h.store(),
      rootDir: h.rootDir(),
      taskId: terminalTaskId,
      action: MERGE_ACTION,
      claimant: {
        actorId: "landing-product-status",
        actorType: "agent",
        actorName: "Landing",
      },
      runId: "product-status-approval-claim",
      claimToken: CLAIM_TOKEN,
    });

    const binding = createCccCampaignAuthorityBinding(campaign, {
      ...MERGE_ACTION,
      requireProtected: true,
    });
    const landingIntentAt = new Date(
      Date.parse(campaign.campaignStartedAt) + 1,
    ).toISOString();
    const landingTerminalAt = new Date(
      Date.parse(campaign.campaignStartedAt) + 3,
    ).toISOString();
    const checkoutMaterializedAt = new Date(
      Date.parse(campaign.campaignStartedAt) + 2,
    ).toISOString();
    const landingMetadata = {
      schema: "ccc-campaign.git-landing.intent.v1",
      expectedBaseObject: source.targetRepository.baseCommit,
      sourceRef: "refs/heads/agent/product-status",
      targetRef: MERGE_ACTION.actionTarget,
      sourceCommit: SOURCE_COMMIT,
      treeObject: SOURCE_TREE,
      commitObject: "f".repeat(40),
      mutationPaths: ["src/task-1"],
      admittedWriteRoots: ["src/task-1"],
      objectBaselineBefore: [source.targetRepository.baseCommit],
      expectedGeneratedObjectIds: [SOURCE_TREE, "f".repeat(40)],
      claimToken: CLAIM_TOKEN,
      controllerToken: reserved.controllerToken,
    };
    await h.layer().transactionImmediate(async (tx) => {
      await recordRunAuditEventWithinTransaction(tx, {
        timestamp: landingIntentAt,
        taskId: terminalTaskId,
        agentId: "landing-product-status",
        runId: `ccc-git-landing:${terminalTaskId}:${MERGE_ACTION.actionId}`,
        domain: "git",
        mutationType: "ccc-campaign-git-landing:intent",
        target: MERGE_ACTION.actionTarget,
        metadata: landingMetadata,
        campaign: {
          eventKey: `product-status/${imported.importId}/intent`,
          binding,
        },
      });
      await recordRunAuditEventWithinTransaction(tx, {
        timestamp: checkoutMaterializedAt,
        taskId: terminalTaskId,
        agentId: "landing-product-status",
        runId: `ccc-git-landing:${terminalTaskId}:${MERGE_ACTION.actionId}`,
        domain: "git",
        mutationType: "ccc-campaign-git-landing:checkout-materialized",
        target: MERGE_ACTION.actionTarget,
        metadata: landingMetadata,
        campaign: {
          eventKey: `product-status/${imported.importId}/checkout-materialized`,
          binding,
        },
      });
    });

    const recovery = await inspectCccPrdProductStatus({
      idempotencyKey: "product-status-primary",
      layer: h.layer(),
      rootDir: h.rootDir(),
    });
    expect(recovery).toMatchObject({
      approvals: [{ status: "claimed" }],
      landing: {
        intents: [{
          bindingHash: binding.bindingHash,
          metadata: {
            schema: "ccc-campaign.git-landing.intent.v1",
            sourceCommit: SOURCE_COMMIT,
            treeObject: SOURCE_TREE,
            mutationPaths: ["src/task-1"],
          },
        }],
        materializations: [{
          bindingHash: binding.bindingHash,
          metadata: {
            sourceCommit: SOURCE_COMMIT,
            treeObject: SOURCE_TREE,
            mutationPaths: ["src/task-1"],
          },
        }],
        terminals: [],
      },
      nextAction: { kind: "landing-recovery" },
    });
    const serializedRecovery = JSON.stringify(recovery);
    expect(serializedRecovery).not.toContain(CLAIM_TOKEN);
    expect(serializedRecovery).not.toContain(reserved.controllerToken);
    expect(serializedRecovery).not.toContain("claimToken");
    expect(serializedRecovery).not.toContain("controllerToken");

    await h.layer().transactionImmediate(async (tx) => {
      await recordRunAuditEventWithinTransaction(tx, {
        timestamp: landingTerminalAt,
        taskId: terminalTaskId,
        agentId: "landing-product-status",
        runId: `ccc-git-landing:${terminalTaskId}:${MERGE_ACTION.actionId}`,
        domain: "git",
        mutationType: "ccc-campaign-git-landing:terminal",
        target: MERGE_ACTION.actionTarget,
        metadata: landingMetadata,
        campaign: {
          eventKey: `product-status/${imported.importId}/terminal`,
          binding,
        },
      });
      await consumeCccCampaignApprovalWithinTransaction(tx, {
        authorityStore: h.store(),
        rootDir: h.rootDir(),
        taskId: terminalTaskId,
        action: MERGE_ACTION,
        actor: {
          actorId: "landing-product-status",
          actorType: "agent",
          actorName: "Landing",
        },
        runId: "product-status-approval-consume",
        claimToken: CLAIM_TOKEN,
      });
    });
    await expect(inspectCccPrdProductStatus({
      idempotencyKey: "product-status-primary",
      layer: h.layer(),
      rootDir: h.rootDir(),
    })).resolves.toMatchObject({
      landing: {
        intents: [{ metadata: { sourceCommit: SOURCE_COMMIT } }],
        materializations: [{ metadata: { sourceCommit: SOURCE_COMMIT } }],
        terminals: [{ metadata: { sourceCommit: SOURCE_COMMIT } }],
      },
      approvals: [{ status: "consumed" }],
      nextAction: { kind: "complete" },
    });

    const foreignRoot = join(h.rootDir(), "foreign-root");
    await mkdir(foreignRoot);
    await expect(inspectCccPrdProductStatus({
      idempotencyKey: "product-status-primary",
      layer: h.layer(),
      rootDir: foreignRoot,
    })).rejects.toMatchObject({ code: "CCC_PRD_IMPORT_ROOT_MISMATCH" });

    const layer = h.layer();
    const foreignLayer: AsyncDataLayer = {
      ...layer,
      projectId: "foreign-project",
    };
    await expect(inspectCccPrdProductStatus({
      idempotencyKey: "product-status-primary",
      layer: foreignLayer,
      rootDir: h.rootDir(),
    })).resolves.toBeNull();
  });
});
