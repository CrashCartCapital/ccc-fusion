import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  closeUnopenedCccCampaignExecutionAuthorizationMembers,
  createCccCampaignAuthorityBinding,
  drizzleSql,
  getApprovalRequest,
  getCccCampaignExecutionAuthorization,
  importCccPrdBundle,
  inspectCccPrdProductStatus,
  queryRunAuditEvents,
  recordRunAuditEventWithinTransaction,
  TaskStore,
  type ApprovalRequestActorSnapshot,
  type CccPrdProtectedActionIntent,
  type CccCampaignExecutionAuthorization,
  type Settings,
  type WorkflowIrNode,
} from "@fusion/core";
import {
  admitCccPrdImportTestProductBundle,
  createCccPrdImportTestProductBundle,
  createCccPrdImportTestProductExecutionPolicy,
  rehashCccPrdImportTestProductBundleV2,
  rehashCccPrdImportTestBundle,
} from "../../../core/src/__test-utils__/ccc-prd-import-fixture.js";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
} from "../../../core/src/__test-utils__/pg-test-harness.js";
import * as schema from "../../../core/src/postgres/schema/index.js";
import * as productControl from "../ccc-campaign-product-control.js";
import { TaskExecutor } from "../executor.js";
import { formatCccPermanentWorkItemError } from "../workflow-task-runtime.js";
import type { WorkflowNodeExecutionContext } from "../workflow-graph-executor.js";

const execFile = promisify(execFileCallback);
const pgTest = pgDescribe;

const OPERATOR: ApprovalRequestActorSnapshot = Object.freeze({
  actorId: "operator-live-execution-test",
  actorType: "user",
  actorName: "Live Execution Test Operator",
});

const LIVE_EXECUTION_APPROVAL_TEST_WINDOW_MS = 60_000;
const NON_LIVE_PERMANENT_REASON =
  "ccc-permanent:CCC_CAMPAIGN_MERGE_APPROVAL_REQUIRED";

type SealedLiveExecutionApproval = Omit<
  CccCampaignExecutionAuthorization,
  "claimToken"
>;

type LiveExecutionApprovalApi = Readonly<{
  issueCccCampaignLiveExecutionApproval(input: Readonly<{
    store: ReturnType<ReturnType<typeof createSharedPgTaskStoreTestHarness>["store"]>;
    rootDir: string;
    taskId: string;
    runId: string;
  }>): Promise<SealedLiveExecutionApproval>;
  computeCccCampaignLiveExecutionApprovalConfirmation(
    approval: SealedLiveExecutionApproval,
  ): string;
  approveCccCampaignLiveExecution(input: Readonly<{
    store: ReturnType<ReturnType<typeof createSharedPgTaskStoreTestHarness>["store"]>;
    rootDir: string;
    taskId: string;
    authorizationId: string;
    confirmation: string;
    actor: ApprovalRequestActorSnapshot;
  }>): Promise<SealedLiveExecutionApproval>;
}>;

type LiveExecutionRequireApi = Readonly<{
  CCC_CAMPAIGN_LIVE_EXECUTION_APPROVAL_REQUIRED_CODE: string;
  CCC_CAMPAIGN_LIVE_EXECUTION_APPROVAL_REQUIRED_REASON: string;
  requireCccCampaignLiveExecutionApproval(input: Readonly<{
    store: ReturnType<ReturnType<typeof createSharedPgTaskStoreTestHarness>["store"]>;
    rootDir: string;
    taskId: string;
    runId: string;
  }>): Promise<SealedLiveExecutionApproval>;
}>;

function liveExecutionApprovalApi(): LiveExecutionApprovalApi {
  const candidate = productControl as unknown as Partial<LiveExecutionApprovalApi>;
  expect(candidate.issueCccCampaignLiveExecutionApproval)
    .toBeTypeOf("function");
  expect(candidate.computeCccCampaignLiveExecutionApprovalConfirmation)
    .toBeTypeOf("function");
  expect(candidate.approveCccCampaignLiveExecution)
    .toBeTypeOf("function");
  return candidate as LiveExecutionApprovalApi;
}

function liveExecutionRequireApi(): LiveExecutionRequireApi {
  const candidate = productControl as unknown as Partial<LiveExecutionRequireApi>;
  expect(candidate.requireCccCampaignLiveExecutionApproval)
    .toBeTypeOf("function");
  expect(candidate.CCC_CAMPAIGN_LIVE_EXECUTION_APPROVAL_REQUIRED_CODE)
    .toBe("CCC_CAMPAIGN_LIVE_EXECUTION_APPROVAL_REQUIRED");
  expect(candidate.CCC_CAMPAIGN_LIVE_EXECUTION_APPROVAL_REQUIRED_REASON)
    .toBe("ccc-permanent:CCC_CAMPAIGN_LIVE_EXECUTION_APPROVAL_REQUIRED");
  return candidate as LiveExecutionRequireApi;
}

async function initializeGitRoot(rootDir: string): Promise<string> {
  await execFile("git", ["init", "--initial-branch=main", rootDir]);
  await execFile("git", ["-C", rootDir, "config", "user.name", "Fusion Test"]);
  await execFile("git", ["-C", rootDir, "config", "user.email", "fusion-test@example.invalid"]);
  await execFile("git", ["-C", rootDir, "commit", "--allow-empty", "-m", "base"]);
  return (await execFile("git", ["-C", rootDir, "rev-parse", "HEAD"], {
    encoding: "utf8",
  })).stdout.trim();
}

type FixtureMode = "live" | "two-live" | "wrong-action" | "missing-action";

pgTest("CCC campaign live-execution approval", () => {
  const h = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_ccc_live_execution_approval",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterAll(h.afterAll);

  async function importFixture(suffix: string, mode: FixtureMode = "live") {
    const rootDir = h.rootDir();
    const baseCommit = await initializeGitRoot(rootDir);
    const source = createCccPrdImportTestProductBundle(rootDir, suffix);
    const firstTask = source.tasks[0]!;
    const secondTask = source.tasks[1]!;
    const firstLiveAction = {
      id: `ACTION-${suffix}-LIVE-A`,
      kind: "live_execution" as const,
      target: `provider://${suffix}/task-a`,
      requiresOperatorDecision: true as const,
      operatorDecision: "approve_live_execution" as const,
      spans: [firstTask.spans[0]!],
    };
    const secondLiveAction = {
      id: `ACTION-${suffix}-LIVE-B`,
      kind: "live_execution" as const,
      target: `provider://${suffix}/task-b`,
      requiresOperatorDecision: true as const,
      operatorDecision: "approve_live_execution" as const,
      spans: [secondTask.spans[0]!],
    };
    const wrongAction = {
      id: `ACTION-${suffix}-MERGE`,
      kind: "merge" as const,
      target: "refs/heads/main",
      requiresOperatorDecision: true as const,
      operatorDecision: "approve_merge" as const,
      spans: [firstTask.spans[0]!],
    };
    const protectedActions: CccPrdProtectedActionIntent[] =
      mode === "wrong-action"
        ? [wrongAction, secondLiveAction]
        : mode === "missing-action"
          ? [secondLiveAction]
          : [firstLiveAction, secondLiveAction];
    const legacy = rehashCccPrdImportTestBundle({
      ...source,
      bounds: {
        ...source.bounds,
        maxDurationMs: LIVE_EXECUTION_APPROVAL_TEST_WINDOW_MS,
      },
      targetRepository: { path: rootDir, baseCommit },
      tasks: source.tasks.map((task) => {
        if (task.id === firstTask.id) {
          return {
            ...task,
            protectedActionIds:
              mode === "missing-action"
                ? []
                : [mode === "wrong-action" ? wrongAction.id : firstLiveAction.id],
          };
        }
        if (task.id === secondTask.id) {
          return { ...task, protectedActionIds: [secondLiveAction.id] };
        }
        return task;
      }),
      protectedActions,
    });
    const admitted = await admitCccPrdImportTestProductBundle(legacy, suffix);
    const bundle = mode === "missing-action" || mode === "wrong-action"
      ? rehashCccPrdImportTestProductBundleV2({
        ...admitted.bundle,
        tasks: admitted.bundle.tasks.map((task) => {
          if (task.id !== firstTask.id) return task;
          return {
            ...task,
            protectedActionIds: mode === "missing-action" ? [] : [wrongAction.id],
          };
        }),
      })
      : admitted.bundle;
    const imported = await importCccPrdBundle({
      bundle,
      executionPolicy: createCccPrdImportTestProductExecutionPolicy(bundle),
      idempotencyKey: `live-execution-approval-${suffix}`,
      store: h.store(),
      layer: h.layer(),
      rootDir,
      semanticProofToolchainPaths: admitted.semanticProofToolchainPaths,
    });
    const idempotencyKey = `live-execution-approval-${suffix}`;
    const productStatus = await inspectCccPrdProductStatus({
      idempotencyKey,
      layer: h.layer(),
      rootDir,
    });
    if (!productStatus) throw new Error("missing live-execution product status");
    expect(productStatus.import.importId).toBe(imported.importId);
    expect(
      Date.parse(productStatus.import.campaignDeadlineAt)
        - Date.parse(productStatus.import.campaignStartedAt),
    ).toBe(LIVE_EXECUTION_APPROVAL_TEST_WINDOW_MS);
    const nativeBySemantic = new Map(
      productStatus.tasks.map(({ semanticTaskId, nativeTaskId }) => [
        semanticTaskId,
        nativeTaskId,
      ]),
    );
    const firstTaskId = nativeBySemantic.get(firstTask.id);
    const secondTaskId = nativeBySemantic.get(secondTask.id);
    expect(firstTaskId).toEqual(expect.any(String));
    expect(secondTaskId).toEqual(expect.any(String));
    expect(firstTaskId).not.toBe(firstTask.id);
    expect(secondTaskId).not.toBe(secondTask.id);
    const workItemId = `${imported.importId}--WORK-${suffix}`;
    const workItem = await h.store().getWorkflowWorkItem(workItemId);
    if (!workItem) throw new Error(`missing workflow work item ${workItemId}`);
    return {
      rootDir,
      imported,
      workItem,
      firstTaskId: firstTaskId as string,
      secondTaskId: secondTaskId as string,
      firstSemanticTaskId: firstTask.id,
      secondSemanticTaskId: secondTask.id,
      firstLiveAction,
      secondLiveAction,
    };
  }

  async function prepareFormatterToStoreFixture(
    suffix: string,
    reason: string,
    error: unknown,
  ) {
    const api = liveExecutionApprovalApi();
    const fixture = await importFixture(suffix);
    const issued = await api.issueCccCampaignLiveExecutionApproval({
      store: h.store(),
      rootDir: fixture.rootDir,
      taskId: fixture.firstTaskId,
      runId: `RUN-${suffix}-issue`,
    });
    const confirmation =
      api.computeCccCampaignLiveExecutionApprovalConfirmation(issued);
    const claimed = await api.approveCccCampaignLiveExecution({
      store: h.store(),
      rootDir: fixture.rootDir,
      taskId: fixture.firstTaskId,
      authorizationId: issued.authorizationId,
      confirmation,
      actor: OPERATOR,
    });
    const formatted = formatCccPermanentWorkItemError(reason, error);
    expect(formatted).toBe(reason);
    await h.layer().db.execute(drizzleSql`
      UPDATE project.workflow_work_items
      SET state = 'manual-required',
          last_error = ${formatted},
          blocked_reason = ${reason},
          lease_owner = NULL,
          lease_expires_at = NULL,
          updated_at = ${new Date().toISOString()}
      WHERE id = ${claimed.workItemId}
    `);
    await expect(h.store().getWorkflowWorkItem(fixture.workItem.id))
      .resolves.toMatchObject({
        state: "manual-required",
        lastError: formatted,
        blockedReason: reason,
        leaseOwner: null,
        leaseExpiresAt: null,
      });
    return { fixture, claimed, formatted };
  }

  async function childRows(importId: string) {
    return await h.layer().db.execute(drizzleSql`
      SELECT id, status, claim_token
      FROM project.approval_requests
      WHERE campaign_import_id = ${importId}
      ORDER BY id
    `) as unknown as Array<{
      id: string;
      status: string;
      claim_token: string | null;
    }>;
  }

  async function closureAuditRows(importId: string) {
    return await h.layer().db.execute(drizzleSql`
      SELECT mutation_type, campaign_binding_hash
      FROM project.run_audit_events
      WHERE campaign_import_id = ${importId}
        AND mutation_type IN (
          'ccc-campaign:provider-attempt:reserved',
          'execution-authorization:child-closed-no-effect',
          'execution-authorization:settled'
        )
      ORDER BY id
    `) as unknown as Array<{
      mutation_type: string;
      campaign_binding_hash: string | null;
    }>;
  }

  function actionFor(
    fixture: Awaited<ReturnType<typeof importFixture>>,
    taskId: string,
  ) {
    if (taskId === fixture.firstTaskId) {
      return {
        actionId: fixture.firstLiveAction.id,
        actionTarget: fixture.firstLiveAction.target,
      };
    }
    if (taskId === fixture.secondTaskId) {
      return {
        actionId: fixture.secondLiveAction.id,
        actionTarget: fixture.secondLiveAction.target,
      };
    }
    throw new Error(`unknown formatter-to-store task ${taskId}`);
  }

  async function assertClaimedLeases(
    fixture: Awaited<ReturnType<typeof importFixture>>,
    claimed: SealedLiveExecutionApproval,
  ) {
    for (const member of claimed.members) {
      await expect(h.store().inspectCccCampaignActionLease(
        member.nativeTaskId,
        actionFor(fixture, member.nativeTaskId),
      )).resolves.toMatchObject({
        binding: { bindingHash: member.bindingHash },
        lease: { approvalRequestId: member.approvalRequestId },
      });
    }
  }

  async function assertNoEffectSettlement(
    prepared: Awaited<ReturnType<typeof prepareFormatterToStoreFixture>>,
    runId: string,
  ) {
    const { fixture, claimed } = prepared;
    const closed = await closeUnopenedCccCampaignExecutionAuthorizationMembers(
      h.layer(),
      {
        authorityStore: h.store(),
        rootDir: fixture.rootDir,
        authorizationId: claimed.authorizationId,
        actor: OPERATOR,
        runId,
      },
    );
    expect(closed).toMatchObject({
      authorization: { status: "settled" },
      openedApprovalRequestIds: [],
    });
    expect([...closed.closedApprovalRequestIds].sort()).toEqual(
      claimed.members.map(({ approvalRequestId }) => approvalRequestId).sort(),
    );
    const children = await childRows(fixture.imported.importId);
    expect(children).toHaveLength(2);
    expect(children.every(({ status, claim_token }) =>
      status === "expired" && typeof claim_token === "string")).toBe(true);
    for (const member of claimed.members) {
      await expect(h.store().inspectCccCampaignActionLease(
        member.nativeTaskId,
        actionFor(fixture, member.nativeTaskId),
      )).resolves.toBeNull();
    }
    const audits = await closureAuditRows(fixture.imported.importId);
    expect(audits.filter(({ mutation_type }) =>
      mutation_type === "execution-authorization:child-closed-no-effect")).toHaveLength(2);
    expect(audits.filter(({ mutation_type }) =>
      mutation_type === "execution-authorization:settled")).toHaveLength(1);
    expect(audits.filter(({ mutation_type }) =>
      mutation_type === "ccc-campaign:provider-attempt:reserved")).toEqual([]);
  }

  it("formatter-to-store allows bare normalized non-live reason with no reservation or effect", async () => {
    const prepared = await prepareFormatterToStoreFixture(
      "formatter-bare-no-effect",
      NON_LIVE_PERMANENT_REASON,
      new Error(NON_LIVE_PERMANENT_REASON),
    );
    await assertNoEffectSettlement(
      prepared,
      `formatter-to-store-bare-no-effect:${prepared.claimed.authorizationId}`,
    );
  });

  it("formatter-to-store allows already-prefixed-empty normalized non-live reason with no reservation or effect", async () => {
    const prepared = await prepareFormatterToStoreFixture(
      "formatter-empty-suffix-no-effect",
      NON_LIVE_PERMANENT_REASON,
      new Error(`${NON_LIVE_PERMANENT_REASON}:`),
    );
    await assertNoEffectSettlement(
      prepared,
      `formatter-to-store-empty-suffix-no-effect:${prepared.claimed.authorizationId}`,
    );
  });

  it("formatter-to-store keeps normalized non-live reason open when a durable reservation exists", async () => {
    const prepared = await prepareFormatterToStoreFixture(
      "formatter-reservation",
      NON_LIVE_PERMANENT_REASON,
      new Error(`${NON_LIVE_PERMANENT_REASON}:`),
    );
    const { fixture, claimed } = prepared;
    const openedTaskId = fixture.secondTaskId;
    const openedContext = await h.store().getCccCampaignContextForTask(openedTaskId);
    if (!openedContext) throw new Error("missing formatter reservation context");
    const openedBinding = createCccCampaignAuthorityBinding(openedContext, {
      ...actionFor(fixture, openedTaskId),
    });
    await h.layer().transactionImmediate((tx) => recordRunAuditEventWithinTransaction(tx, {
      timestamp: new Date().toISOString(),
      taskId: openedTaskId,
      agentId: "ccc-provider-controller",
      runId: `ccc-campaign:provider-attempt:reserved:${claimed.authorizationId}`,
      domain: "database",
      mutationType: "ccc-campaign:provider-attempt:reserved",
      target: openedBinding.actionTarget,
      metadata: { fixture: "formatter-to-store-reservation" },
      campaign: {
        eventKey: `ccc-formatter-to-store-reservation:${openedBinding.bindingHash}`,
        binding: openedBinding,
      },
    }));

    const closed = await closeUnopenedCccCampaignExecutionAuthorizationMembers(
      h.layer(),
      {
        authorityStore: h.store(),
        rootDir: fixture.rootDir,
        authorizationId: claimed.authorizationId,
        actor: OPERATOR,
        runId: `formatter-to-store-reservation-closure:${claimed.authorizationId}`,
      },
    );
    const openedMember = claimed.members.find(({ nativeTaskId }) =>
      nativeTaskId === openedTaskId);
    if (!openedMember) throw new Error("missing formatter reservation member");
    expect(closed.authorization.status).toBe("claimed");
    expect(closed.openedApprovalRequestIds).toEqual([
      openedMember.approvalRequestId,
    ]);
    expect(closed.closedApprovalRequestIds).toHaveLength(1);
    const children = await childRows(fixture.imported.importId);
    expect(children.find(({ id }) => id === openedMember.approvalRequestId)?.status)
      .toBe("claimed");
    expect(children.find(({ id }) => id !== openedMember.approvalRequestId)?.status)
      .toBe("expired");
    await expect(h.store().inspectCccCampaignActionLease(
      openedTaskId,
      actionFor(fixture, openedTaskId),
    )).resolves.toMatchObject({
      binding: { bindingHash: openedBinding.bindingHash },
      lease: { approvalRequestId: openedMember.approvalRequestId },
    });
    await expect(h.store().inspectCccCampaignActionLease(
      fixture.firstTaskId,
      actionFor(fixture, fixture.firstTaskId),
    )).resolves.toBeNull();
    const audits = await closureAuditRows(fixture.imported.importId);
    expect(audits.filter(({ mutation_type }) =>
      mutation_type === "ccc-campaign:provider-attempt:reserved")).toHaveLength(1);
    expect(audits.filter(({ mutation_type }) =>
      mutation_type === "execution-authorization:child-closed-no-effect")).toHaveLength(1);
    expect(audits.filter(({ mutation_type }) =>
      mutation_type === "execution-authorization:settled")).toEqual([]);
  });

  it("formatter-to-store refuses normalized non-live reason with dispatched unknown effect", async () => {
    const prepared = await prepareFormatterToStoreFixture(
      "formatter-unknown-effect",
      NON_LIVE_PERMANENT_REASON,
      new Error(`${NON_LIVE_PERMANENT_REASON}:`),
    );
    const { fixture, claimed } = prepared;
    const unknownTaskId = fixture.firstTaskId;
    const unknownContext = await h.store().getCccCampaignContextForTask(unknownTaskId);
    if (!unknownContext) throw new Error("missing formatter unknown-effect context");
    const unknownBinding = createCccCampaignAuthorityBinding(unknownContext, {
      ...actionFor(fixture, unknownTaskId),
    });
    const now = new Date().toISOString();
    await h.layer().db.insert(schema.project.cccEffectReceipts).values({
      projectId: unknownBinding.projectId,
      ownerProjectId: unknownBinding.projectId,
      effectScopeId: "formatter-to-store-unknown-effect",
      logicalKey: `formatter-to-store-unknown-effect:${claimed.authorizationId}`,
      turnKey: "formatter-to-store-unknown-effect-turn",
      slotOrdinal: 0,
      toolAuthority: "formatter-to-store-fixture",
      argumentsDigest: "formatter-to-store-unknown-effect-arguments",
      repeatOf: null,
      state: "dispatched_unknown",
      controllerToken: "formatter-to-store-unknown-effect-controller",
      evidenceDigest: null,
      resultJson: null,
      createdAt: now,
      updatedAt: now,
      campaignProjectId: unknownBinding.projectId,
      campaignImportId: unknownBinding.importId,
      campaignId: unknownBinding.campaignId,
      campaignTaskId: unknownBinding.taskId,
      campaignActionId: unknownBinding.actionId,
      campaignActionTarget: unknownBinding.actionTarget,
      campaignIdempotencyKey: unknownBinding.idempotencyKey,
      campaignPacketHash: unknownBinding.packetHash,
      campaignSidecarHash: unknownBinding.sidecarHash,
      campaignBundleHash: unknownBinding.bundleHash,
      campaignTargetRepository: unknownBinding.targetRepository,
      campaignTargetBase: unknownBinding.targetBase,
      campaignProviderId: unknownBinding.providerId,
      campaignModelId: unknownBinding.modelId,
      campaignTransport: unknownBinding.transport,
      campaignManifestHash: unknownBinding.manifestHash,
      campaignBindingHash: unknownBinding.bindingHash,
    });

    await expect(closeUnopenedCccCampaignExecutionAuthorizationMembers(
      h.layer(),
      {
        authorityStore: h.store(),
        rootDir: fixture.rootDir,
        authorizationId: claimed.authorizationId,
        actor: OPERATOR,
        runId: `formatter-to-store-unknown-effect-closure:${claimed.authorizationId}`,
      },
    )).rejects.toThrow(/unresolved dispatched receipt/u);
    await expect(getCccCampaignExecutionAuthorization(
      h.layer().db,
      claimed.authorizationId,
    )).resolves.toMatchObject({ status: "claimed" });
    const children = await childRows(fixture.imported.importId);
    expect(children.every(({ status }) => status === "claimed")).toBe(true);
    await assertClaimedLeases(fixture, claimed);
    const audits = await closureAuditRows(fixture.imported.importId);
    expect(audits.filter(({ mutation_type }) =>
      mutation_type === "ccc-campaign:provider-attempt:reserved")).toEqual([]);
    expect(audits.filter(({ mutation_type }) =>
      mutation_type === "execution-authorization:child-closed-no-effect")).toEqual([]);
    expect(audits.filter(({ mutation_type }) =>
      mutation_type === "execution-authorization:settled")).toEqual([]);
  });

  it("formatter-to-store refuses normalized live approval reason", async () => {
    const liveReason = liveExecutionRequireApi()
      .CCC_CAMPAIGN_LIVE_EXECUTION_APPROVAL_REQUIRED_REASON;
    const prepared = await prepareFormatterToStoreFixture(
      "formatter-live-approval",
      liveReason,
      new Error(`${liveReason}:`),
    );
    const { fixture, claimed } = prepared;
    const parentBefore = await getCccCampaignExecutionAuthorization(
      h.layer().db,
      claimed.authorizationId,
    );
    const childrenBefore = await childRows(fixture.imported.importId);
    const leasesBefore = await Promise.all(claimed.members.map((member) =>
      h.store().inspectCccCampaignActionLease(
        member.nativeTaskId,
        actionFor(fixture, member.nativeTaskId),
      )));
    const auditsBefore = await closureAuditRows(fixture.imported.importId);

    await expect(closeUnopenedCccCampaignExecutionAuthorizationMembers(
      h.layer(),
      {
        authorityStore: h.store(),
        rootDir: fixture.rootDir,
        authorizationId: claimed.authorizationId,
        actor: OPERATOR,
        runId: `formatter-to-store-live-approval-closure:${claimed.authorizationId}`,
      },
    )).rejects.toThrow(/cannot close unopened members from work-item state manual-required/u);
    await expect(getCccCampaignExecutionAuthorization(
      h.layer().db,
      claimed.authorizationId,
    )).resolves.toEqual(parentBefore);
    await expect(childRows(fixture.imported.importId))
      .resolves.toEqual(childrenBefore);
    const leasesAfter = await Promise.all(claimed.members.map((member) =>
      h.store().inspectCccCampaignActionLease(
        member.nativeTaskId,
        actionFor(fixture, member.nativeTaskId),
      )));
    expect(leasesAfter).toEqual(leasesBefore);
    await expect(closureAuditRows(fixture.imported.importId))
      .resolves.toEqual(auditsBefore);
  });

  it("issues one immutable, idempotent, redacted approval without execution side effects", async () => {
    const api = liveExecutionApprovalApi();
    const fixture = await importFixture("issue");
    const beforeWorkItem = await h.store().getWorkflowWorkItem(fixture.workItem.id);

    const first = await api.issueCccCampaignLiveExecutionApproval({
      store: h.store(),
      rootDir: fixture.rootDir,
      taskId: fixture.firstTaskId,
      runId: "RUN-live-execution-issue",
    });
    const replay = await api.issueCccCampaignLiveExecutionApproval({
      store: h.store(),
      rootDir: fixture.rootDir,
      taskId: fixture.firstTaskId,
      runId: "RUN-live-execution-issue",
    });

    expect(first).toMatchObject({
      schemaVersion: "ccc-campaign.execution-authorization.v1",
      status: "issued",
      importId: fixture.imported.importId,
      expectedRequestCount: 0,
      members: expect.arrayContaining([
        expect.objectContaining({
          nativeTaskId: fixture.firstTaskId,
          actionId: fixture.firstLiveAction.id,
          actionTarget: fixture.firstLiveAction.target,
        }),
        expect.objectContaining({
          nativeTaskId: fixture.secondTaskId,
          actionId: fixture.secondLiveAction.id,
          actionTarget: fixture.secondLiveAction.target,
        }),
      ]),
    });
    expect(replay).toEqual(first);
    expect(api.computeCccCampaignLiveExecutionApprovalConfirmation(first))
      .toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.stringify({
      approval: first,
      confirmation:
        api.computeCccCampaignLiveExecutionApprovalConfirmation(first),
    })).not.toContain("claimToken");
    await expect(api.issueCccCampaignLiveExecutionApproval({
      store: h.store(),
      rootDir: fixture.rootDir,
      taskId: fixture.firstTaskId,
      runId: "RUN-live-execution-issue-drifted",
    })).resolves.toEqual(first);

    await expect(h.store().getWorkflowWorkItem(fixture.workItem.id))
      .resolves.toEqual(beforeWorkItem);
    await expect(h.store().getCccCampaignContextForTask(fixture.firstTaskId))
      .resolves.toMatchObject({ requestCount: 0, activeActionLeases: {} });
    const audits = await queryRunAuditEvents(h.layer().db, {
      taskId: fixture.firstTaskId,
    });
    expect(audits.filter(({ mutationType }) =>
      mutationType.startsWith("ccc-campaign:provider-attempt:"))).toEqual([]);
  });

  it("issues one sealed parent from either task and one claim atomically unlocks both exact children", async () => {
    const api = liveExecutionApprovalApi();
    const fixture = await importFixture("sealed-parent", "two-live");

    const fromFirstTask = await api.issueCccCampaignLiveExecutionApproval({
      store: h.store(),
      rootDir: fixture.rootDir,
      taskId: fixture.firstTaskId,
      runId: "RUN-sealed-parent-first",
    });
    const fromSecondTask = await api.issueCccCampaignLiveExecutionApproval({
      store: h.store(),
      rootDir: fixture.rootDir,
      taskId: fixture.secondTaskId,
      runId: "RUN-sealed-parent-second",
    });

    expect(fromSecondTask).toEqual(fromFirstTask);
    expect(fromFirstTask).toMatchObject({
      schemaVersion: "ccc-campaign.execution-authorization.v1",
      authorizationId: expect.stringMatching(/^ccc-execution-authorization-[a-f0-9]{64}$/u),
      status: "issued",
      expectedRequestCount: 0,
      members: [
        {
          nativeTaskId: fixture.firstTaskId,
          semanticTaskId: fixture.firstSemanticTaskId,
          actionId: fixture.firstLiveAction.id,
          actionTarget: fixture.firstLiveAction.target,
          approvalRequestId: expect.stringMatching(/^ccc-approval-[a-f0-9]{64}$/u),
        },
        {
          nativeTaskId: fixture.secondTaskId,
          semanticTaskId: fixture.secondSemanticTaskId,
          actionId: fixture.secondLiveAction.id,
          actionTarget: fixture.secondLiveAction.target,
          approvalRequestId: expect.stringMatching(/^ccc-approval-[a-f0-9]{64}$/u),
        },
      ],
    });
    expect(JSON.stringify(fromFirstTask)).not.toContain("claimToken");
    const confirmation =
      api.computeCccCampaignLiveExecutionApprovalConfirmation(fromFirstTask);
    expect(confirmation).toMatch(/^[a-f0-9]{64}$/u);

    const claimed = await api.approveCccCampaignLiveExecution({
      store: h.store(),
      rootDir: fixture.rootDir,
      taskId: fixture.secondTaskId,
      authorizationId: fromFirstTask.authorizationId,
      confirmation,
      actor: OPERATOR,
    });
    expect(claimed).toMatchObject({
      authorizationId: fromFirstTask.authorizationId,
      status: "claimed",
    });
    expect(api.computeCccCampaignLiveExecutionApprovalConfirmation(claimed))
      .toBe(confirmation);
    expect(JSON.stringify(claimed)).not.toContain("claimToken");

    const persistedParent = await getCccCampaignExecutionAuthorization(
      h.layer().db,
      fromFirstTask.authorizationId,
    );
    expect(persistedParent).toMatchObject({
      status: "claimed",
      claimToken: expect.any(String),
    });
    for (const member of fromFirstTask.members) {
      await expect(getApprovalRequest(h.layer().db, member.approvalRequestId))
        .resolves.toMatchObject({ status: "claimed" });
      await expect(h.store().inspectCccCampaignActionLease(
        member.nativeTaskId,
        { actionId: member.actionId, actionTarget: member.actionTarget },
      )).resolves.toMatchObject({
        binding: { bindingHash: member.bindingHash },
        lease: {
          approvalRequestId: member.approvalRequestId,
          bindingHash: member.bindingHash,
        },
      });
    }
    const firstContext = await h.store().getCccCampaignContextForTask(
      fixture.firstTaskId,
    );
    if (!firstContext) throw new Error("missing first sealed task context");
    const reserved = await h.store().reserveCccProviderAttempt({
      taskId: fixture.firstTaskId,
      actionId: fixture.firstLiveAction.id,
      actionTarget: fixture.firstLiveAction.target,
      turnKey: "sealed-parent-task-a-turn-1",
      dispatchKey: "pi-stream:sealed-parent-task-a-turn-1",
      providerId: firstContext.route.providerId,
      modelId: firstContext.route.modelId,
      transport: firstContext.route.transport,
      workItemFence: {
        workItemId: fixture.workItem.id,
        runId: fixture.workItem.runId,
        attempt: Math.max(1, fixture.workItem.attempt),
      },
    });
    await h.store().proveCccProviderAttemptNotDispatched({
      taskId: fixture.firstTaskId,
      attemptKey: reserved.attemptKey,
      controllerToken: reserved.controllerToken,
    });
    await expect(h.store().getCccCampaignContextForTask(fixture.firstTaskId))
      .resolves.toMatchObject({ requestCount: 1 });
    const advancedWorkItem = await h.store().transitionWorkflowWorkItem(
      fixture.workItem.id,
      "running",
      {
        expectedState: fixture.workItem.state,
        expectedAttempt: fixture.workItem.attempt,
        expectedLeaseOwner: fixture.workItem.leaseOwner,
        attempt: Math.max(1, fixture.workItem.attempt + 1),
        leaseOwner: "sealed-parent-restart-owner",
        leaseExpiresAt: "2999-07-31T23:59:59.000Z",
      },
    );
    expect(advancedWorkItem.attempt).toBeGreaterThan(fixture.workItem.attempt);
    await expect(liveExecutionRequireApi().requireCccCampaignLiveExecutionApproval({
      store: new TaskStore(
        fixture.rootDir,
        undefined,
        { asyncLayer: h.layer() },
      ),
      rootDir: fixture.rootDir,
      taskId: fixture.secondTaskId,
      runId: "RUN-sealed-parent-replay-after-request",
    })).resolves.toMatchObject({
      authorizationId: fromFirstTask.authorizationId,
      status: "claimed",
    });
    const providerAudits = (await Promise.all([
      queryRunAuditEvents(h.layer().db, { taskId: fixture.firstTaskId }),
      queryRunAuditEvents(h.layer().db, { taskId: fixture.secondTaskId }),
    ])).flat().filter(({ mutationType }) =>
      mutationType.startsWith("ccc-campaign:provider-attempt:"));
    expect(providerAudits.map(({ mutationType }) => mutationType).sort()).toEqual([
      "ccc-campaign:provider-attempt:reserved",
      "ccc-campaign:provider-attempt:terminal",
    ]);
  });

  it("requires an exact claimed live-execution lease without exposing or performing the effect", async () => {
    const api = liveExecutionApprovalApi();
    const requiredApi = liveExecutionRequireApi();
    const fixture = await importFixture("required");
    const input = {
      store: h.store(),
      rootDir: fixture.rootDir,
      taskId: fixture.firstTaskId,
      runId: "RUN-live-execution-required",
    } as const;
    const beforeWorkItem = await h.store().getWorkflowWorkItem(fixture.workItem.id);

    await expect(requiredApi.requireCccCampaignLiveExecutionApproval(input))
      .rejects.toMatchObject({
        code: "CCC_CAMPAIGN_LIVE_EXECUTION_APPROVAL_REQUIRED",
      });
    await expect(requiredApi.requireCccCampaignLiveExecutionApproval(input))
      .rejects.toMatchObject({
        code: "CCC_CAMPAIGN_LIVE_EXECUTION_APPROVAL_REQUIRED",
      });

    const issued = await api.issueCccCampaignLiveExecutionApproval(input);
    expect(issued).toMatchObject({
      status: "issued",
      members: expect.arrayContaining([
        expect.objectContaining({
          nativeTaskId: fixture.firstTaskId,
          actionId: fixture.firstLiveAction.id,
          actionTarget: fixture.firstLiveAction.target,
        }),
      ]),
    });
    expect(JSON.stringify(issued)).not.toContain("claimToken");
    await expect(h.store().getCccCampaignContextForTask(fixture.firstTaskId))
      .resolves.toMatchObject({ requestCount: 0, activeActionLeases: {} });
    await expect(h.store().getWorkflowWorkItem(fixture.workItem.id))
      .resolves.toEqual(beforeWorkItem);
    const issuanceAudits = (await queryRunAuditEvents(h.layer().db, {
      taskId: fixture.firstTaskId,
    })).filter(({ mutationType }) => mutationType === "approval:issued");
    expect(issuanceAudits).toHaveLength(1);

    const confirmation =
      api.computeCccCampaignLiveExecutionApprovalConfirmation(issued);
    const claimed = await api.approveCccCampaignLiveExecution({
      store: h.store(),
      rootDir: fixture.rootDir,
      taskId: fixture.firstTaskId,
      authorizationId: issued.authorizationId,
      confirmation,
      actor: OPERATOR,
    });
    const exactLease = await h.store().inspectCccCampaignActionLease(
      fixture.firstTaskId,
      {
        actionId: fixture.firstLiveAction.id,
        actionTarget: fixture.firstLiveAction.target,
      },
    );
    if (!exactLease) throw new Error("missing exact claimed live-execution lease");
    const mismatchedBindingHash = "0".repeat(64);
    const inspectLease = vi.spyOn(
      h.store(),
      "inspectCccCampaignActionLease",
    ).mockResolvedValue({
      binding: {
        ...exactLease.binding,
        bindingHash: mismatchedBindingHash,
      },
      lease: {
        ...exactLease.lease,
        approvalRequestId: "ccc-approval-wrong-request",
        bindingHash: mismatchedBindingHash,
      },
    });
    await expect(requiredApi.requireCccCampaignLiveExecutionApproval(input))
      .rejects.toMatchObject({
        code: "CCC_CAMPAIGN_LIVE_EXECUTION_APPROVAL_REQUIRED",
      });
    inspectLease.mockRestore();

    const replay =
      await requiredApi.requireCccCampaignLiveExecutionApproval(input);
    expect(replay).toEqual(claimed);
    expect(JSON.stringify(replay)).not.toContain("claimToken");
    await expect(h.store().getWorkflowWorkItem(fixture.workItem.id))
      .resolves.toEqual(beforeWorkItem);
    await expect(h.store().getCccCampaignContextForTask(fixture.firstTaskId))
      .resolves.toMatchObject({ requestCount: 0 });
    const providerAudits = (await queryRunAuditEvents(h.layer().db, {
      taskId: fixture.firstTaskId,
    })).filter(({ mutationType }) =>
      mutationType.startsWith("ccc-campaign:provider-attempt:"));
    expect(providerAudits).toEqual([]);
  });

  it("parks the authoritative coding runner before provider dispatch until exact live approval is claimed", async () => {
    const api = liveExecutionApprovalApi();
    const fixture = await importFixture("runner-gate");
    const task = await h.store().getTask(fixture.firstTaskId);
    if (!task) throw new Error("missing imported live-execution task");
    const node: WorkflowIrNode = {
      id: "ccc-live-execution-node",
      kind: "prompt",
      config: {
        cccPrdTaskId: fixture.firstSemanticTaskId,
        executor: "model",
        toolMode: "coding",
        modelProvider: "deterministic-fake",
        modelId: "fixture-v2",
      },
    };
    const executionContext: WorkflowNodeExecutionContext = Object.freeze({
      task,
      settings: undefined,
      context: {},
      execution: Object.freeze({
        originTaskId: fixture.firstTaskId,
        semanticTaskId: fixture.firstSemanticTaskId,
        nativeTaskId: fixture.firstTaskId,
        semanticTask: task,
        runId: fixture.workItem.runId,
        visitIdentity: Object.freeze({
          nodeId: node.id,
          materializedNodeId: node.id,
        }),
        executionFence: Object.freeze({
          workItemId: fixture.workItem.id,
          leaseOwner: "runner-gate-owner",
          attempt: 1,
          runId: fixture.workItem.runId,
        }),
      }),
    });
    const executor = new TaskExecutor(h.store(), fixture.rootDir);
    const providerEffect = vi.spyOn(
      executor as never,
      "runGraphCustomNode" as never,
    ).mockResolvedValue({ outcome: "failure", value: "provider-ran" } as never);
    const runner =
      executor.createAuthoritativeWorkflowCustomNodeRunner({} as Settings);

    await expect(runner(node, task, {}, executionContext)).rejects.toMatchObject({
      code: "CCC_CAMPAIGN_LIVE_EXECUTION_APPROVAL_REQUIRED",
    });
    expect(providerEffect).not.toHaveBeenCalled();
    const issued = await api.issueCccCampaignLiveExecutionApproval({
      store: h.store(),
      rootDir: fixture.rootDir,
      taskId: fixture.firstTaskId,
      runId: fixture.workItem.runId,
    });
    const confirmation =
      api.computeCccCampaignLiveExecutionApprovalConfirmation(issued);
    await api.approveCccCampaignLiveExecution({
      store: h.store(),
      rootDir: fixture.rootDir,
      taskId: fixture.firstTaskId,
      authorizationId: issued.authorizationId,
      confirmation,
      actor: OPERATOR,
    });

    await expect(runner(node, task, {}, executionContext)).resolves.toMatchObject({
      outcome: "failure",
      value: "provider-ran",
    });
    expect(providerEffect).toHaveBeenCalledTimes(1);
  });

  it("refuses missing and non-live declared actions", async () => {
    const api = liveExecutionApprovalApi();
    const missing = await importFixture("missing-action", "missing-action");

    await expect(api.issueCccCampaignLiveExecutionApproval({
      store: h.store(),
      rootDir: missing.rootDir,
      taskId: missing.firstTaskId,
      runId: "RUN-missing-live-execution-action",
    })).rejects.toMatchObject({
      code: "CCC_CAMPAIGN_LIVE_EXECUTION_ACTION_REFUSED",
    });
  });

  it("refuses the wrong protected-action kind as live execution", async () => {
    const api = liveExecutionApprovalApi();
    const wrong = await importFixture("wrong-action", "wrong-action");

    await expect(api.issueCccCampaignLiveExecutionApproval({
      store: h.store(),
      rootDir: wrong.rootDir,
      taskId: wrong.firstTaskId,
      runId: "RUN-wrong-live-execution-action",
    })).rejects.toMatchObject({
      code: "CCC_CAMPAIGN_LIVE_EXECUTION_ACTION_REFUSED",
    });
  });

  it("refuses a wrong parent identifier and a stale digest before any claim", async () => {
    const api = liveExecutionApprovalApi();
    const fixture = await importFixture("binding", "two-live");
    const approval = await api.issueCccCampaignLiveExecutionApproval({
      store: h.store(),
      rootDir: fixture.rootDir,
      taskId: fixture.firstTaskId,
      runId: "RUN-live-execution-binding",
    });
    const confirmation =
      api.computeCccCampaignLiveExecutionApprovalConfirmation(approval);
    const beforeWorkItem = await h.store().getWorkflowWorkItem(fixture.workItem.id);

    await expect(api.approveCccCampaignLiveExecution({
      store: h.store(),
      rootDir: fixture.rootDir,
      taskId: fixture.secondTaskId,
      authorizationId: `ccc-execution-authorization-${"0".repeat(64)}`,
      confirmation,
      actor: OPERATOR,
    })).rejects.toMatchObject({
      code: "CCC_CAMPAIGN_LIVE_EXECUTION_APPROVAL_MISSING",
    });
    await expect(api.approveCccCampaignLiveExecution({
      store: h.store(),
      rootDir: fixture.rootDir,
      taskId: fixture.firstTaskId,
      authorizationId: approval.authorizationId,
      confirmation: "0".repeat(64),
      actor: OPERATOR,
    })).rejects.toMatchObject({
      code: "CCC_CAMPAIGN_LIVE_EXECUTION_CONFIRMATION_REFUSED",
    });

    await expect(getCccCampaignExecutionAuthorization(
      h.layer().db,
      approval.authorizationId,
    ))
      .resolves.toMatchObject({ status: "issued" });
    await expect(h.store().getCccCampaignContextForTask(fixture.firstTaskId))
      .resolves.toMatchObject({ requestCount: 0, activeActionLeases: {} });
    await expect(h.store().getCccCampaignContextForTask(fixture.secondTaskId))
      .resolves.toMatchObject({ requestCount: 0, activeActionLeases: {} });
    await expect(h.store().getWorkflowWorkItem(fixture.workItem.id))
      .resolves.toEqual(beforeWorkItem);
    const audits = await queryRunAuditEvents(h.layer().db, {
      taskId: fixture.firstTaskId,
    });
    expect(audits.filter(({ mutationType }) =>
      mutationType.startsWith("ccc-campaign:provider-attempt:"))).toEqual([]);
  });

  it("claims only the exact live-execution lease and returns no hidden claim material", async () => {
    const api = liveExecutionApprovalApi();
    const fixture = await importFixture("claim");
    const approval = await api.issueCccCampaignLiveExecutionApproval({
      store: h.store(),
      rootDir: fixture.rootDir,
      taskId: fixture.firstTaskId,
      runId: "RUN-live-execution-claim",
    });
    const confirmation =
      api.computeCccCampaignLiveExecutionApprovalConfirmation(approval);
    const beforeWorkItem = await h.store().getWorkflowWorkItem(fixture.workItem.id);
    const providerAuditsBefore = (await queryRunAuditEvents(h.layer().db, {
      taskId: fixture.firstTaskId,
    })).filter(({ mutationType }) =>
      mutationType.startsWith("ccc-campaign:provider-attempt:"));

    const claimed = await api.approveCccCampaignLiveExecution({
      store: h.store(),
      rootDir: fixture.rootDir,
      taskId: fixture.firstTaskId,
      authorizationId: approval.authorizationId,
      confirmation,
      actor: OPERATOR,
    });
    await expect(api.approveCccCampaignLiveExecution({
      store: h.store(),
      rootDir: `${fixture.rootDir}-stale`,
      taskId: fixture.firstTaskId,
      authorizationId: approval.authorizationId,
      confirmation,
      actor: OPERATOR,
    })).rejects.toMatchObject({
      code: "CCC_CAMPAIGN_LIVE_EXECUTION_CUSTODY_REFUSED",
    });
    const replay = await api.approveCccCampaignLiveExecution({
      store: h.store(),
      rootDir: fixture.rootDir,
      taskId: fixture.firstTaskId,
      authorizationId: approval.authorizationId,
      confirmation,
      actor: OPERATOR,
    });
    const persisted = await getCccCampaignExecutionAuthorization(
      h.layer().db,
      approval.authorizationId,
    );
    const firstMember = approval.members.find(({ nativeTaskId }) =>
      nativeTaskId === fixture.firstTaskId);
    if (!firstMember) throw new Error("missing first sealed member");
    const persistedChild = await getApprovalRequest(
      h.layer().db,
      firstMember.approvalRequestId,
    );
    const lease = await h.store().inspectCccCampaignActionLease(
      fixture.firstTaskId,
      {
        actionId: fixture.firstLiveAction.id,
        actionTarget: fixture.firstLiveAction.target,
      },
    );

    expect(claimed).toMatchObject({
      status: "claimed",
      authorizationId: approval.authorizationId,
    });
    expect(replay).toEqual(claimed);
    expect(JSON.stringify(claimed)).not.toContain("claimToken");
    expect(persisted).toMatchObject({
      status: "claimed",
      authorizationId: approval.authorizationId,
      claimToken: expect.any(String),
    });
    expect(persistedChild).toMatchObject({
      id: firstMember.approvalRequestId,
      status: "claimed",
      campaign: { claimToken: expect.any(String) },
    });
    expect(lease).toMatchObject({
      binding: {
        bindingHash: firstMember.bindingHash,
      },
      lease: {
        approvalRequestId: firstMember.approvalRequestId,
        claimToken: persistedChild?.campaign?.claimToken,
        actionId: fixture.firstLiveAction.id,
        actionTarget: fixture.firstLiveAction.target,
        bindingHash: firstMember.bindingHash,
      },
    });
    await expect(h.store().getWorkflowWorkItem(fixture.workItem.id))
      .resolves.toEqual(beforeWorkItem);
    await expect(h.store().getCccCampaignContextForTask(fixture.firstTaskId))
      .resolves.toMatchObject({ requestCount: 0 });
    const providerAuditsAfter = (await queryRunAuditEvents(h.layer().db, {
      taskId: fixture.firstTaskId,
    })).filter(({ mutationType }) =>
      mutationType.startsWith("ccc-campaign:provider-attempt:"));
    expect(providerAuditsAfter).toEqual(providerAuditsBefore);

    const issueReplay = await api.issueCccCampaignLiveExecutionApproval({
      store: h.store(),
      rootDir: fixture.rootDir,
      taskId: fixture.firstTaskId,
      runId: "RUN-live-execution-claim",
    });
    expect(issueReplay).toEqual(claimed);
    expect(JSON.stringify(issueReplay)).not.toContain("claimToken");
  });
});
