/**
 * Task 2 RED→GREEN proof for native CCC campaign approval custody.
 *
 * This suite uses the real PostgreSQL task/import projection. It deliberately
 * exercises the public approval helpers with a persisted TaskStore authority
 * reader: callers provide only an action pair and a claim token, never a
 * campaign binding or provenance tuple.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { importCccPrdBundle } from "../../index.js";
import {
  claimCccCampaignApproval,
  consumeCccCampaignApprovalWithinTransaction,
  denyCccCampaignApproval,
  assertActiveClaimedCccCampaignApprovalWithinTransaction,
  assertClaimedCccCampaignApprovalWithinTransaction,
  assertConsumedCccCampaignApprovalWithinTransaction,
  assertExpiredCccCampaignApprovalWithinTransaction,
  expireClaimedCccCampaignApprovalAfterProvedNoEffectWithinTransaction,
  expireCccCampaignApproval,
  getApprovalAuditHistory,
  getApprovalRequest,
  issueCccCampaignApproval,
} from "../../async-approval-request-store.js";
import { ApprovalRequestStore } from "../../approval-request-store.js";
import { recordRunAuditEventWithinTransaction } from "../../postgres/data-layer.js";
import * as schema from "../../postgres/schema/index.js";
import { TaskStore } from "../../store.js";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
} from "../../__test-utils__/pg-test-harness.js";
import {
  createCccPrdImportTestBundle as bundle,
  rehashCccPrdImportTestBundle,
} from "../../__test-utils__/ccc-prd-import-fixture.js";
import type { CccPrdProtectedActionIntent, CccPrdSemanticBundle } from "../../ccc-prd/types.js";
import type { ApprovalRequestActorSnapshot } from "../../types.js";
import type { CccCampaignAuthorityBinding } from "../../ccc-campaign/types.js";

const requester: ApprovalRequestActorSnapshot = {
  actorId: "operator-1",
  actorType: "user",
  actorName: "Operator",
};
const worker: ApprovalRequestActorSnapshot = {
  actorId: "worker-1",
  actorType: "agent",
  actorName: "Worker",
};
const VALID_PROVED_EVIDENCE_DIGEST = "a".repeat(64);
const VALID_OTHER_EVIDENCE_DIGEST = "b".repeat(64);
const action = { actionId: "PA-approval", actionTarget: "refs/heads/main" };
type ProtectedActionFixture = Pick<CccPrdProtectedActionIntent, "id" | "kind" | "target" | "operatorDecision">;
const mergeProtectedAction: ProtectedActionFixture = {
  id: action.actionId,
  kind: "merge",
  target: action.actionTarget,
  operatorDecision: "approve_merge",
};

function withCampaignAction(
  source: CccPrdSemanticBundle,
  protectedAction: ProtectedActionFixture = mergeProtectedAction,
): CccPrdSemanticBundle {
  return rehashCccPrdImportTestBundle({
    ...source,
    bounds: { maxRequests: 2, maxDurationMs: 120_000, maxConcurrency: 1 },
    tasks: source.tasks.map((task, index) => index === 0
      ? { ...task, protectedActionIds: [protectedAction.id] }
      : task),
    protectedActions: [{
      ...protectedAction,
      requiresOperatorDecision: true,
      spans: [source.tasks[0]!.spans[0]!],
    }],
  });
}

function policyFor(source: CccPrdSemanticBundle) {
  return {
    schema: "ccc-campaign.execution-policy.v1" as const,
    routes: source.tasks.map((task) => ({
      taskId: task.id,
      providerId: "deterministic-fake",
      modelId: "fixture-v1",
      transport: "pi" as const,
    })),
  };
}

function receiptRow(
  binding: CccCampaignAuthorityBinding,
  effectScopeId: string,
  logicalKey: string,
  state: "proved_failed" | "dispatched_unknown",
  evidenceDigest: string | null,
) {
  const now = new Date().toISOString();
  return {
    projectId: binding.projectId,
    ownerProjectId: binding.projectId,
    effectScopeId,
    logicalKey,
    turnKey: `turn-${logicalKey}`,
    slotOrdinal: 0,
    toolAuthority: "fixture-tool",
    argumentsDigest: "fixture-arguments-digest",
    repeatOf: null,
    state,
    controllerToken: "fixture-controller",
    evidenceDigest,
    resultJson: null,
    createdAt: now,
    updatedAt: now,
    campaignProjectId: binding.projectId,
    campaignImportId: binding.importId,
    campaignId: binding.campaignId,
    campaignTaskId: binding.taskId,
    campaignActionId: binding.actionId,
    campaignActionTarget: binding.actionTarget,
    campaignIdempotencyKey: binding.idempotencyKey,
    campaignPacketHash: binding.packetHash,
    campaignSidecarHash: binding.sidecarHash,
    campaignBundleHash: binding.bundleHash,
    campaignTargetRepository: binding.targetRepository,
    campaignTargetBase: binding.targetBase,
    campaignProviderId: binding.providerId,
    campaignModelId: binding.modelId,
    campaignTransport: binding.transport,
    campaignManifestHash: binding.manifestHash,
    campaignBindingHash: binding.bindingHash,
  };
}

pgDescribe("CCC campaign approval lifecycle (PostgreSQL)", () => {
  const h = createSharedPgTaskStoreTestHarness({ prefix: "fusion_ccc_campaign_approval" });

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

  async function context(suffix: string, protectedAction: ProtectedActionFixture = mergeProtectedAction) {
    const source = withCampaignAction(bundle(h.rootDir(), suffix), protectedAction);
    const imported = await importCccPrdBundle({
      bundle: source,
      idempotencyKey: `approval-${suffix}`,
      store: h.store(),
      layer: h.layer(),
      rootDir: h.rootDir(),
      executionPolicy: policyFor(source),
    });
    const semanticTaskId = `TASK-${suffix}`;
    const taskId = await nativeTaskIdForImport(imported.importId, semanticTaskId);
    const campaign = await h.store().getCccCampaignContextForTask(taskId);
    if (!campaign) throw new Error(`missing campaign context for ${taskId}`);
    expect(campaign).toMatchObject({ taskId, semanticTaskId });
    return {
      campaign,
      taskId,
      semanticTaskId,
      action: { actionId: protectedAction.id, actionTarget: protectedAction.target },
    };
  }

  function issueInput(
    taskId: string,
    campaign: { campaignStartedAt: string; campaignDeadlineAt: string },
    overrides: Partial<{ notBeforeAt: string; expiresAt: string; runId: string }> = {},
    campaignAction = action,
  ) {
    return {
      authorityStore: h.store(),
      rootDir: h.rootDir(),
      taskId,
      action: campaignAction,
      requester,
      runId: overrides.runId ?? `approval-run:${taskId}`,
      notBeforeAt: overrides.notBeforeAt ?? campaign.campaignStartedAt,
      expiresAt: overrides.expiresAt ?? campaign.campaignDeadlineAt,
    };
  }

  it("exposes the lifecycle through the native store and fails closed without PostgreSQL authority", async () => {
    const unavailable = new ApprovalRequestStore(null);
    expect(typeof unavailable.issueCccCampaignApproval).toBe("function");
    await expect(unavailable.issueCccCampaignApproval({
      taskId: "missing", action, requester, runId: "missing", notBeforeAt: new Date().toISOString(), expiresAt: new Date().toISOString(),
    })).rejects.toThrow(/PostgreSQL|campaign/i);
  });

  it("issues, claims, consumes, and survives a normal PostgreSQL reader restart", async () => {
    const { campaign, taskId } = await context("lifecycle");
    await expect(issueCccCampaignApproval(h.layer(), {
      ...issueInput(taskId, campaign),
      rootDir: `${h.rootDir()}-foreign`,
    })).rejects.toThrow(/root.*target/i);
    const originalIssue = issueInput(taskId, campaign);
    const issued = await issueCccCampaignApproval(h.layer(), originalIssue);
    expect(issued.status).toBe("issued");
    expect(issued.campaign?.binding.taskId).toBe(taskId);
    expect(issued.campaign?.binding.actionTarget).toBe(action.actionTarget);

    const claimed = await claimCccCampaignApproval(h.layer(), {
      authorityStore: h.store(), rootDir: h.rootDir(), taskId, action,
      claimant: worker, runId: "approval-claim:lifecycle", claimToken: "claim-lifecycle",
    });
    expect(claimed.status).toBe("claimed");
    expect(claimed.campaign?.claimToken).toBe("claim-lifecycle");

    await expect(issueCccCampaignApproval(h.layer(), originalIssue)).resolves.toMatchObject({
      id: issued.id,
      status: "claimed",
      campaign: { claimToken: "claim-lifecycle" },
    });

    const consumed = await h.layer().transactionImmediate((tx) =>
      consumeCccCampaignApprovalWithinTransaction(tx, {
        authorityStore: h.store(), rootDir: h.rootDir(), taskId, action,
        actor: worker, runId: "approval-consume:lifecycle", claimToken: "claim-lifecycle",
      }));
    expect(consumed.status).toBe("consumed");
    await expect(getApprovalAuditHistory(h.layer().db, issued.id)).resolves.toMatchObject([
      { eventType: "issued" },
      { eventType: "claimed" },
      { eventType: "consumed" },
    ]);

    const restarted = new TaskStore(h.rootDir(), undefined, { asyncLayer: h.layer() });
    const reader = new ApprovalRequestStore(null, { asyncLayer: h.layer(), campaignAuthorityStore: restarted, rootDir: h.rootDir() });
    await expect(reader.get(issued.id)).resolves.toMatchObject({
      id: issued.id,
      status: "consumed",
      campaign: { binding: { taskId, actionId: action.actionId } },
    });
  });

  it("keeps active action leases scoped to each sibling task when they reuse an action ID", async () => {
    const suffix = "sibling-action-leases";
    const fixture = bundle(h.rootDir(), suffix);
    const sharedAction = { actionId: "actionId", actionTarget: action.actionTarget };
    const source = rehashCccPrdImportTestBundle({
      ...withCampaignAction(fixture, {
        ...mergeProtectedAction,
        id: sharedAction.actionId,
        target: sharedAction.actionTarget,
      }),
      tasks: fixture.tasks.map((task) => ({
        ...task,
        protectedActionIds: [sharedAction.actionId],
      })),
    });
    const imported = await importCccPrdBundle({
      bundle: source,
      idempotencyKey: `approval-${suffix}`,
      store: h.store(),
      layer: h.layer(),
      rootDir: h.rootDir(),
      executionPolicy: policyFor(source),
    });
    const semanticTaskIds = [`TASK-${suffix}`, `TASK-terminal-${suffix}`];
    const taskIds = await Promise.all(semanticTaskIds.map((semanticTaskId) =>
      nativeTaskIdForImport(imported.importId, semanticTaskId)));
    const campaigns = await Promise.all(taskIds.map(async (taskId, index) => {
      const campaign = await h.store().getCccCampaignContextForTask(taskId);
      if (!campaign) throw new Error(`missing campaign context for ${taskId}`);
      expect(campaign).toMatchObject({
        taskId,
        semanticTaskId: semanticTaskIds[index],
      });
      return campaign;
    }));

    await Promise.all(campaigns.map((campaign, index) => h.store().claimCccCampaignActionLease(
      taskIds[index]!,
      sharedAction,
      {
        approvalRequestId: `approval-${index}`,
        claimToken: `claim-${index}`,
        claimedAt: campaign.campaignStartedAt,
        expiresAt: campaign.campaignDeadlineAt,
      },
    )));

    const persistedContexts = await Promise.all(taskIds.map((taskId) =>
      h.store().getCccCampaignContextForTask(taskId)));
    expect(persistedContexts).toEqual([
      expect.objectContaining({
        taskId: taskIds[0],
        semanticTaskId: semanticTaskIds[0],
        activeActionLeases: expect.objectContaining({
          [sharedAction.actionId]: expect.objectContaining({ claimToken: "claim-0" }),
        }),
      }),
      expect.objectContaining({
        taskId: taskIds[1],
        semanticTaskId: semanticTaskIds[1],
        activeActionLeases: expect.objectContaining({
          [sharedAction.actionId]: expect.objectContaining({ claimToken: "claim-1" }),
        }),
      }),
    ]);
    await expect(Promise.all(taskIds.map((taskId) =>
      h.store().inspectCccCampaignActionLease(taskId, sharedAction)))).resolves.toEqual([
      expect.objectContaining({ lease: expect.objectContaining({ claimToken: "claim-0" }) }),
      expect.objectContaining({ lease: expect.objectContaining({ claimToken: "claim-1" }) }),
    ]);
  });

  it("refuses a nonempty legacy flat action-lease row", async () => {
    const { campaign, taskId } = await context("legacy-flat-action-lease");
    const claimed = await h.store().claimCccCampaignActionLease(taskId, action, {
      approvalRequestId: "approval-legacy-flat",
      claimToken: "claim-legacy-flat",
      claimedAt: campaign.campaignStartedAt,
      expiresAt: campaign.campaignDeadlineAt,
    });
    await h.layer().db.execute(sql`
      UPDATE project.ccc_prd_imports
      SET active_action_leases = ${JSON.stringify({ [action.actionId]: claimed.lease })}::jsonb
      WHERE project_id = ${campaign.projectId}
        AND import_id = ${campaign.importId}
    `);

    await expect(h.store().getCccCampaignContextForTask(taskId)).rejects.toThrow(
      /legacy flat lease rows are unsupported/,
    );
  });

  it("asserts exact consumed custody and refuses wrong request, token, or a remaining action lease", async () => {
    const { campaign, taskId } = await context("consumed-custody");
    const issued = await issueCccCampaignApproval(h.layer(), issueInput(taskId, campaign));
    await claimCccCampaignApproval(h.layer(), {
      authorityStore: h.store(), rootDir: h.rootDir(), taskId, action,
      claimant: worker, runId: "approval-claim:consumed-custody", claimToken: "claim-consumed-custody",
    });
    await h.layer().transactionImmediate((tx) => consumeCccCampaignApprovalWithinTransaction(tx, {
      authorityStore: h.store(), rootDir: h.rootDir(), taskId, action,
      actor: worker, runId: "approval-consume:consumed-custody", claimToken: "claim-consumed-custody",
    }));
    const assertionInput = {
      authorityStore: h.store(), rootDir: h.rootDir(), taskId, action,
      approvalRequestId: issued.id, claimToken: "claim-consumed-custody",
    };
    await expect(h.layer().transactionImmediate((tx) =>
      assertConsumedCccCampaignApprovalWithinTransaction(tx, assertionInput),
    )).resolves.toMatchObject({
      approval: { id: issued.id, status: "consumed" },
      binding: issued.campaign!.binding,
    });
    await expect(h.layer().transactionImmediate((tx) =>
      assertConsumedCccCampaignApprovalWithinTransaction(tx, {
        ...assertionInput,
        approvalRequestId: `${issued.id}-foreign`,
      }),
    )).rejects.toThrow(/request identity|custody/i);
    await expect(h.layer().transactionImmediate((tx) =>
      assertConsumedCccCampaignApprovalWithinTransaction(tx, {
        ...assertionInput,
        claimToken: "claim-consumed-custody-wrong",
      }),
    )).rejects.toThrow(/consumed|approval.*token/i);

    await h.store().claimCccCampaignActionLease(taskId, action, {
      approvalRequestId: issued.id,
      claimToken: "claim-consumed-custody",
      claimedAt: new Date().toISOString(),
      expiresAt: campaign.campaignDeadlineAt,
    });
    await expect(h.layer().transactionImmediate((tx) =>
      assertConsumedCccCampaignApprovalWithinTransaction(tx, assertionInput),
    )).rejects.toThrow(/lease/i);
  });

  it("maps each protected-action kind to the matching approval policy category", async () => {
    const deletion: ProtectedActionFixture = {
      id: "PA-delete",
      kind: "deletion",
      target: "workspace/generated/obsolete.json",
      operatorDecision: "approve_deletion",
    };
    const { campaign, taskId, action: deletionAction } = await context("deletion-category", deletion);
    await expect(issueCccCampaignApproval(
      h.layer(),
      issueInput(taskId, campaign, {}, deletionAction),
    )).resolves.toMatchObject({
      targetAction: {
        category: "file_write_delete",
        summary: "CCC deletion protected action PA-delete",
        resourceType: "ccc-campaign-deletion",
        resourceId: deletionAction.actionTarget,
        context: {
          protectedActionKind: "deletion",
          operatorDecision: "approve_deletion",
        },
      },
    });
  });

  it("denies issued approval and refuses claim before not-before time", async () => {
    const deniedContext = await context("denied");
    await issueCccCampaignApproval(h.layer(), issueInput(deniedContext.taskId, deniedContext.campaign));
    await expect(denyCccCampaignApproval(h.layer(), {
      authorityStore: h.store(), rootDir: h.rootDir(), taskId: deniedContext.taskId, action,
      actor: requester, runId: "approval-deny:denied",
    })).resolves.toMatchObject({ status: "denied" });

    const futureContext = await context("not-before");
    await issueCccCampaignApproval(h.layer(), issueInput(futureContext.taskId, futureContext.campaign, {
      notBeforeAt: futureContext.campaign.campaignDeadlineAt,
      expiresAt: futureContext.campaign.campaignDeadlineAt,
    }));
    await expect(claimCccCampaignApproval(h.layer(), {
      authorityStore: h.store(), rootDir: h.rootDir(), taskId: futureContext.taskId, action,
      claimant: worker, runId: "approval-claim:not-before", claimToken: "claim-not-before",
    })).rejects.toThrow(/not-before|issued|claim/i);
  });

  it("rolls a denied transition back when its immutable campaign audit receipt collides", async () => {
    const { campaign, taskId } = await context("audit-rollback");
    const issued = await issueCccCampaignApproval(h.layer(), issueInput(taskId, campaign));
    const binding = issued.campaign!.binding;
    await h.layer().transactionImmediate((tx) => recordRunAuditEventWithinTransaction(tx, {
      timestamp: issued.requestedAt,
      taskId,
      agentId: requester.actorId,
      runId: "preseeded-audit-collision",
      domain: "ccc-campaign",
      mutationType: "approval:denied",
      target: action.actionTarget,
      metadata: { intentionallyDifferent: true },
      campaign: {
        eventKey: `ccc-approval:${binding.bindingHash}:denied`,
        binding,
      },
    }));
    await expect(denyCccCampaignApproval(h.layer(), {
      authorityStore: h.store(), rootDir: h.rootDir(), taskId, action,
      actor: requester, runId: "approval-deny:audit-rollback",
    })).rejects.toThrow(/collid/i);
    await expect(getApprovalRequest(h.layer().db, issued.id)).resolves.toMatchObject({ status: "issued" });
    await expect(getApprovalAuditHistory(h.layer().db, issued.id)).resolves.toMatchObject([
      { eventType: "issued" },
    ]);
  });

  it("expires an issued approval, rejects claimed expiry without effect evidence, and refuses a wrong consume token", async () => {
    const expiredContext = await context("expired");
    const now = Date.now();
    await issueCccCampaignApproval(h.layer(), issueInput(expiredContext.taskId, expiredContext.campaign, {
      notBeforeAt: new Date(now - 2_000).toISOString(),
      expiresAt: new Date(now - 1_000).toISOString(),
    }));
    await expect(expireCccCampaignApproval(h.layer(), {
      authorityStore: h.store(), rootDir: h.rootDir(), taskId: expiredContext.taskId, action,
      actor: worker, runId: "approval-expire:issued",
    })).resolves.toMatchObject({ status: "expired" });

    const claimedContext = await context("claimed-expiry");
    const issued = await issueCccCampaignApproval(h.layer(), issueInput(claimedContext.taskId, claimedContext.campaign));
    await claimCccCampaignApproval(h.layer(), {
      authorityStore: h.store(), rootDir: h.rootDir(), taskId: claimedContext.taskId, action,
      claimant: worker, runId: "approval-claim:claimed-expiry", claimToken: "claim-expiry",
    });
    await expect(h.layer().transactionImmediate((tx) => consumeCccCampaignApprovalWithinTransaction(tx, {
      authorityStore: h.store(), rootDir: h.rootDir(), taskId: claimedContext.taskId, action,
      actor: worker, runId: "approval-consume:wrong-token", claimToken: "wrong-token",
    }))).rejects.toThrow(/token|claim|consume/i);
    await expect(expireCccCampaignApproval(h.layer(), {
      authorityStore: h.store(), rootDir: h.rootDir(), taskId: claimedContext.taskId, action,
      actor: worker, runId: "approval-expire:claimed",
    })).rejects.toThrow(/effect|receipt|claimed/i);
    await expect(getApprovalRequest(h.layer().db, issued.id)).resolves.toMatchObject({ status: "claimed" });
  });

  it("reconciles a claimed approval after nominal expiry, but refuses a same-token replay without its persisted lease", async () => {
    const lapsedContext = await context("late-consume");
    const lapsedIssued = await issueCccCampaignApproval(h.layer(), issueInput(lapsedContext.taskId, lapsedContext.campaign));
    await claimCccCampaignApproval(h.layer(), {
      authorityStore: h.store(), rootDir: h.rootDir(), taskId: lapsedContext.taskId, action,
      claimant: worker, runId: "approval-claim:late-consume", claimToken: "claim-late-consume",
    });
    const now = Date.now();
    await h.layer().db.execute(sql`
      UPDATE project.approval_requests
      SET not_before_at = ${new Date(now - 2_000).toISOString()}, expires_at = ${new Date(now - 1_000).toISOString()}
      WHERE id = ${lapsedIssued.id}
    `);
    await expect(h.layer().transactionImmediate((tx) => consumeCccCampaignApprovalWithinTransaction(tx, {
      authorityStore: h.store(), rootDir: h.rootDir(), taskId: lapsedContext.taskId, action,
      actor: worker, runId: "approval-consume:late-consume", claimToken: "claim-late-consume",
    }))).resolves.toMatchObject({ status: "consumed" });

    const replayContext = await context("missing-lease-replay");
    const replayIssued = await issueCccCampaignApproval(h.layer(), issueInput(replayContext.taskId, replayContext.campaign));
    await claimCccCampaignApproval(h.layer(), {
      authorityStore: h.store(), rootDir: h.rootDir(), taskId: replayContext.taskId, action,
      claimant: worker, runId: "approval-claim:missing-lease", claimToken: "claim-missing-lease",
    });
    await h.layer().db.execute(sql`
      UPDATE project.ccc_prd_imports
      SET active_action_leases = '{}'::jsonb
      WHERE project_id = ${replayIssued.campaign!.binding.projectId}
        AND import_id = ${replayIssued.campaign!.binding.importId}
    `);
    await expect(claimCccCampaignApproval(h.layer(), {
      authorityStore: h.store(), rootDir: h.rootDir(), taskId: replayContext.taskId, action,
      claimant: worker, runId: "approval-claim:missing-lease-replay", claimToken: "claim-missing-lease",
    })).rejects.toThrow(/persisted action lease|lease/i);
  });

  it("admits one exact active claimed approval before a new provider dispatch without writing lifecycle or audit state", async () => {
    const { campaign, taskId } = await context("active-pre-dispatch");
    const issued = await issueCccCampaignApproval(h.layer(), issueInput(taskId, campaign));
    await claimCccCampaignApproval(h.layer(), {
      authorityStore: h.store(), rootDir: h.rootDir(), taskId, action,
      claimant: worker, runId: "approval-claim:active-pre-dispatch", claimToken: "claim-active-pre-dispatch",
    });
    const before = await getApprovalRequest(h.layer().db, issued.id);
    const auditBefore = await getApprovalAuditHistory(h.layer().db, issued.id);
    const assertionInput = {
      authorityStore: h.store(), rootDir: h.rootDir(), taskId, action,
      approvalRequestId: issued.id, claimToken: "claim-active-pre-dispatch",
    };
    await expect(h.layer().transactionImmediate((tx) =>
      assertActiveClaimedCccCampaignApprovalWithinTransaction(tx, assertionInput),
    )).resolves.toMatchObject({ approval: { id: issued.id, status: "claimed" }, binding: issued.campaign!.binding });
    await expect(getApprovalRequest(h.layer().db, issued.id)).resolves.toEqual(before);
    await expect(getApprovalAuditHistory(h.layer().db, issued.id)).resolves.toEqual(auditBefore);
  });

  it("refuses provider dispatch when only the persisted action lease claim time drifts", async () => {
    const { campaign, taskId } = await context("lease-claimed-at-drift");
    const issued = await issueCccCampaignApproval(h.layer(), issueInput(taskId, campaign));
    const claimed = await claimCccCampaignApproval(h.layer(), {
      authorityStore: h.store(), rootDir: h.rootDir(), taskId, action,
      claimant: worker, runId: "approval-claim:lease-claimed-at-drift", claimToken: "claim-lease-claimed-at-drift",
    });
    const driftedClaimedAt = new Date(Date.parse(claimed.campaign!.claimedAt!) - 1).toISOString();
    await h.layer().db.execute(sql`
      UPDATE project.ccc_prd_imports
      SET active_action_leases = jsonb_set(
        active_action_leases,
        ARRAY[${taskId}, ${action.actionId}, 'claimedAt'],
        to_jsonb(${driftedClaimedAt}::text),
        true
      )
      WHERE project_id = ${issued.campaign!.binding.projectId}
        AND import_id = ${issued.campaign!.binding.importId}
    `);
    await expect(h.layer().transactionImmediate((tx) =>
      assertActiveClaimedCccCampaignApprovalWithinTransaction(tx, {
        authorityStore: h.store(), rootDir: h.rootDir(), taskId, action,
        approvalRequestId: issued.id, claimToken: "claim-lease-claimed-at-drift",
      }),
    )).rejects.toThrow(/lease|claim.*time|custody/i);
  });

  it("refuses provider dispatch when only the persisted action lease expiry drifts but remains active", async () => {
    const { campaign, taskId } = await context("lease-expiry-drift");
    const issued = await issueCccCampaignApproval(h.layer(), issueInput(taskId, campaign));
    const claimed = await claimCccCampaignApproval(h.layer(), {
      authorityStore: h.store(), rootDir: h.rootDir(), taskId, action,
      claimant: worker, runId: "approval-claim:lease-expiry-drift", claimToken: "claim-lease-expiry-drift",
    });
    const claimedAt = Date.parse(claimed.campaign!.claimedAt!);
    const approvalExpiresAt = Date.parse(claimed.campaign!.expiresAt);
    const driftedExpiresAt = new Date(claimedAt + Math.floor((approvalExpiresAt - claimedAt) / 2)).toISOString();
    expect(Date.parse(driftedExpiresAt)).toBeGreaterThan(Date.now());
    expect(Date.parse(driftedExpiresAt)).toBeLessThan(approvalExpiresAt);
    await h.layer().db.execute(sql`
      UPDATE project.ccc_prd_imports
      SET active_action_leases = jsonb_set(
        active_action_leases,
        ARRAY[${taskId}, ${action.actionId}, 'expiresAt'],
        to_jsonb(${driftedExpiresAt}::text),
        true
      )
      WHERE project_id = ${issued.campaign!.binding.projectId}
        AND import_id = ${issued.campaign!.binding.importId}
    `);
    await expect(h.layer().transactionImmediate((tx) =>
      assertActiveClaimedCccCampaignApprovalWithinTransaction(tx, {
        authorityStore: h.store(), rootDir: h.rootDir(), taskId, action,
        approvalRequestId: issued.id, claimToken: "claim-lease-expiry-drift",
      }),
    )).rejects.toThrow(/lease|expiry|custody/i);
  });

  it("refuses provider dispatch when only the claimed approval not-before moves into the future", async () => {
    const { campaign, taskId } = await context("approval-not-before-drift");
    const issued = await issueCccCampaignApproval(h.layer(), issueInput(taskId, campaign));
    await claimCccCampaignApproval(h.layer(), {
      authorityStore: h.store(), rootDir: h.rootDir(), taskId, action,
      claimant: worker, runId: "approval-claim:approval-not-before-drift", claimToken: "claim-approval-not-before-drift",
    });
    const futureNotBeforeAt = new Date(Date.now() + 30_000).toISOString();
    await h.layer().db.execute(sql`
      UPDATE project.approval_requests
      SET not_before_at = ${futureNotBeforeAt}
      WHERE id = ${issued.id}
    `);
    await expect(h.layer().transactionImmediate((tx) =>
      assertActiveClaimedCccCampaignApprovalWithinTransaction(tx, {
        authorityStore: h.store(), rootDir: h.rootDir(), taskId, action,
        approvalRequestId: issued.id, claimToken: "claim-approval-not-before-drift",
      }),
    )).rejects.toThrow(/window|not-before|active/i);
  });

  it("refuses a past database-clock approval window before dispatch while preserving after-effect consume", async () => {
    const { campaign, taskId } = await context("expired-pre-dispatch");
    const issued = await issueCccCampaignApproval(h.layer(), issueInput(taskId, campaign));
    await claimCccCampaignApproval(h.layer(), {
      authorityStore: h.store(), rootDir: h.rootDir(), taskId, action,
      claimant: worker, runId: "approval-claim:expired-pre-dispatch", claimToken: "claim-expired-pre-dispatch",
    });
    await h.layer().db.execute(sql`
      UPDATE project.approval_requests
      SET not_before_at = ${new Date(Date.now() - 2_000).toISOString()}, expires_at = ${new Date(Date.now() - 1_000).toISOString()}
      WHERE id = ${issued.id}
    `);
    const assertionInput = {
      authorityStore: h.store(), rootDir: h.rootDir(), taskId, action,
      approvalRequestId: issued.id, claimToken: "claim-expired-pre-dispatch",
    };
    await expect(h.layer().transactionImmediate((tx) =>
      assertActiveClaimedCccCampaignApprovalWithinTransaction(tx, assertionInput),
    )).rejects.toThrow(/window|expiry|active/i);
    await expect(h.layer().transactionImmediate((tx) => consumeCccCampaignApprovalWithinTransaction(tx, {
      authorityStore: h.store(), rootDir: h.rootDir(), taskId, action,
      actor: worker, runId: "approval-consume:expired-pre-dispatch", claimToken: "claim-expired-pre-dispatch",
    }))).resolves.toMatchObject({ status: "consumed" });
  });

  it("refuses a wrong token, elapsed, missing, or drifted lease, and gives a restarted PostgreSQL reader the same active result", async () => {
    const { campaign, taskId } = await context("active-custody");
    const issued = await issueCccCampaignApproval(h.layer(), issueInput(taskId, campaign));
    await claimCccCampaignApproval(h.layer(), {
      authorityStore: h.store(), rootDir: h.rootDir(), taskId, action,
      claimant: worker, runId: "approval-claim:active-custody", claimToken: "claim-active-custody",
    });
    const assertionInput = {
      authorityStore: h.store(), rootDir: h.rootDir(), taskId, action,
      approvalRequestId: issued.id, claimToken: "claim-active-custody",
    };
    await expect(h.layer().transactionImmediate((tx) =>
      assertActiveClaimedCccCampaignApprovalWithinTransaction(tx, { ...assertionInput, claimToken: "wrong-token" }),
    )).rejects.toThrow(/claimed|token/i);
    const restarted = new TaskStore(h.rootDir(), undefined, { asyncLayer: h.layer() });
    const reader = new ApprovalRequestStore(null, { asyncLayer: h.layer(), campaignAuthorityStore: restarted, rootDir: h.rootDir() });
    await expect(reader.assertActiveClaimedCccCampaignApproval({
      taskId, action, approvalRequestId: issued.id, claimToken: "claim-active-custody",
    })).resolves.toMatchObject({ approval: { id: issued.id, status: "claimed" }, binding: issued.campaign!.binding });
    await h.layer().db.execute(sql`
      UPDATE project.ccc_prd_imports
      SET active_action_leases = jsonb_set(
        active_action_leases,
        ARRAY[${taskId}, ${action.actionId}, 'expiresAt'],
        to_jsonb(${new Date(Date.now() - 1_000).toISOString()}::text),
        true
      )
      WHERE project_id = ${issued.campaign!.binding.projectId}
        AND import_id = ${issued.campaign!.binding.importId}
    `);
    await expect(h.layer().transactionImmediate((tx) =>
      assertActiveClaimedCccCampaignApprovalWithinTransaction(tx, assertionInput),
    )).rejects.toThrow(/window|expiry|active/i);
    await h.layer().db.execute(sql`
      UPDATE project.ccc_prd_imports
      SET active_action_leases = jsonb_set(
        active_action_leases,
        ARRAY[${taskId}, ${action.actionId}, 'bindingHash'],
        to_jsonb('drifted'::text),
        true
      )
      WHERE project_id = ${issued.campaign!.binding.projectId}
        AND import_id = ${issued.campaign!.binding.importId}
    `);
    await expect(h.layer().transactionImmediate((tx) =>
      assertActiveClaimedCccCampaignApprovalWithinTransaction(tx, assertionInput),
    )).rejects.toThrow(/lease|binding|campaign/i);
    await h.layer().db.execute(sql`
      UPDATE project.ccc_prd_imports
      SET active_action_leases = '{}'::jsonb
      WHERE project_id = ${issued.campaign!.binding.projectId}
        AND import_id = ${issued.campaign!.binding.importId}
    `);
    await expect(h.layer().transactionImmediate((tx) =>
      assertActiveClaimedCccCampaignApprovalWithinTransaction(tx, assertionInput),
    )).rejects.toThrow(/lease/i);
  });

  it("expires a claimed approval only after exact native proved-failed receipt evidence and no unknown dispatch", async () => {
    const { campaign, taskId } = await context("proved-no-effect");
    const issued = await issueCccCampaignApproval(h.layer(), issueInput(taskId, campaign));
    await claimCccCampaignApproval(h.layer(), {
      authorityStore: h.store(), rootDir: h.rootDir(), taskId, action,
      claimant: worker, runId: "approval-claim:proved-no-effect", claimToken: "claim-proved-no-effect",
    });
    const binding = issued.campaign!.binding;
    await expect(h.layer().transactionImmediate((tx) => assertClaimedCccCampaignApprovalWithinTransaction(tx, {
      authorityStore: h.store(), rootDir: h.rootDir(), taskId, action,
      approvalRequestId: issued.id, claimToken: "claim-proved-no-effect",
    }))).resolves.toMatchObject({ approval: { id: issued.id, status: "claimed" }, binding });
    const now = Date.now();
    await h.layer().db.execute(sql`
      UPDATE project.approval_requests
      SET not_before_at = ${new Date(now - 2_000).toISOString()}, expires_at = ${new Date(now - 1_000).toISOString()}
      WHERE id = ${issued.id}
    `);
    await h.layer().db.insert(schema.project.cccEffectReceipts).values([
      receiptRow(binding, "effect-proved", "receipt-proved", "proved_failed", "A".repeat(64)),
      receiptRow(binding, "effect-unknown", "receipt-unknown", "dispatched_unknown", null),
    ]);
    const expireInput = {
      authorityStore: h.store(), rootDir: h.rootDir(), taskId, action,
      approvalRequestId: issued.id, claimToken: "claim-proved-no-effect",
      actor: worker, runId: "approval-expire:proved-no-effect",
      effectScopeId: "effect-proved", logicalKey: "receipt-proved",
    };
    await expect(h.layer().transactionImmediate((tx) =>
      expireClaimedCccCampaignApprovalAfterProvedNoEffectWithinTransaction(tx, expireInput),
    )).rejects.toThrow(/lowercase SHA-256/i);
    await expect(getApprovalRequest(h.layer().db, issued.id)).resolves.toMatchObject({ status: "claimed" });
    await h.layer().db.update(schema.project.cccEffectReceipts).set({
      evidenceDigest: VALID_PROVED_EVIDENCE_DIGEST,
    }).where(sql`${schema.project.cccEffectReceipts.logicalKey} = 'receipt-proved'`);
    await expect(h.layer().transactionImmediate((tx) =>
      expireClaimedCccCampaignApprovalAfterProvedNoEffectWithinTransaction(tx, expireInput),
    )).rejects.toThrow(/unresolved dispatched/i);
    await h.layer().db.update(schema.project.cccEffectReceipts).set({
      state: "proved_failed", evidenceDigest: VALID_OTHER_EVIDENCE_DIGEST,
    }).where(sql`${schema.project.cccEffectReceipts.logicalKey} = 'receipt-unknown'`);
    await expect(h.layer().transactionImmediate((tx) =>
      expireClaimedCccCampaignApprovalAfterProvedNoEffectWithinTransaction(tx, expireInput),
    )).resolves.toMatchObject({ status: "expired" });
    await expect(h.layer().transactionImmediate((tx) =>
      assertExpiredCccCampaignApprovalWithinTransaction(tx, {
        authorityStore: h.store(), rootDir: h.rootDir(), taskId, action,
        approvalRequestId: issued.id, claimToken: "claim-proved-no-effect",
      }),
    )).resolves.toMatchObject({
      approval: { id: issued.id, status: "expired" },
      binding,
    });
    await expect(getApprovalAuditHistory(h.layer().db, issued.id)).resolves.toMatchObject([
      { eventType: "issued" },
      { eventType: "claimed" },
      { eventType: "expired" },
    ]);
  });

  it("admits exactly one distinct concurrent claim and rejects issue drift", async () => {
    const { campaign, taskId } = await context("race");
    await issueCccCampaignApproval(h.layer(), issueInput(taskId, campaign));
    const claims = await Promise.allSettled([
      claimCccCampaignApproval(h.layer(), {
        authorityStore: h.store(), rootDir: h.rootDir(), taskId, action,
        claimant: worker, runId: "approval-claim:race-a", claimToken: "claim-race-a",
      }),
      claimCccCampaignApproval(h.layer(), {
        authorityStore: h.store(), rootDir: h.rootDir(), taskId, action,
        claimant: worker, runId: "approval-claim:race-b", claimToken: "claim-race-b",
      }),
    ]);
    expect(claims.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(claims.filter((result) => result.status === "rejected")).toHaveLength(1);

    await expect(issueCccCampaignApproval(h.layer(), issueInput(taskId, campaign, {
      notBeforeAt: new Date(Date.parse(campaign.campaignStartedAt) + 1_000).toISOString(),
    }))).rejects.toThrow(/collision|drift|approval/i);
  });
});
