/**
 * FNXC:CliAgentPostgres 2026-07-14-12:00:
 * The experimental CLI Agent Executor must persist and rehydrate its session
 * lifecycle through PostgreSQL; no SQLite database is available at runtime.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { CliSessionStore } from "../../cli-session-store.js";
import {
  importCccPrdBundle,
  inspectCccPrdProductStatus,
} from "../../index.js";
import {
  claimCccCampaignApproval,
  getApprovalRequest,
  getApprovalAuditHistory,
  issueCccCampaignApproval,
} from "../../async-approval-request-store.js";
import * as effectReceipts from "../../ccc-effect-receipts.js";
import {
  abandonCccEffectReceipt,
  canonicalCccEffectJson,
  cccEffectReceiptIdentity,
  commitCccEffectReceipt,
  hasCccEffectReceipt,
  markCccEffectReceiptDispatched,
  reserveCccEffectReceipt,
} from "../../ccc-effect-receipts.js";
import { recordRunAuditEvent } from "../../postgres/data-layer.js";
import {
  createCccPrdImportTestBundle,
  rehashCccPrdImportTestBundle,
} from "../../__test-utils__/ccc-prd-import-fixture.js";
import type { CccPrdSemanticBundle } from "../../ccc-prd/types.js";
import type { CccProviderAttemptReconciliation, CccProviderAttemptScope } from "../../ccc-campaign/types.js";
import type { CliTerminationReason } from "../../cli-session-types.js";
import type { ApprovalRequestActorSnapshot } from "../../types.js";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";

const campaignAction = {
  actionId: "PA-effect-receipt",
  actionTarget: "refs/heads/main",
};

const campaignRequester: ApprovalRequestActorSnapshot = {
  actorId: "operator-effect",
  actorType: "user",
  actorName: "Effect operator",
};

const campaignWorker: ApprovalRequestActorSnapshot = {
  actorId: "worker-effect",
  actorType: "agent",
  actorName: "Effect worker",
};

function campaignBundle(source: CccPrdSemanticBundle): CccPrdSemanticBundle {
  return rehashCccPrdImportTestBundle({
    ...source,
    bounds: { maxRequests: 2, maxDurationMs: 120_000, maxConcurrency: 1 },
    tasks: source.tasks.map((task, index) => index === 0
      ? { ...task, protectedActionIds: [campaignAction.actionId] }
      : task),
    protectedActions: [{
      id: campaignAction.actionId,
      kind: "merge",
      target: campaignAction.actionTarget,
      operatorDecision: "approve_merge",
      requiresOperatorDecision: true,
      spans: [source.tasks[0]!.spans[0]!],
    }],
  });
}

function campaignPolicy(source: CccPrdSemanticBundle, transport: "pi" | "cli" = "pi") {
  return {
    schema: "ccc-campaign.execution-policy.v1" as const,
    routes: source.tasks.map((task) => ({
      taskId: task.id,
      providerId: "deterministic-fake",
      modelId: "fixture-v1",
      transport,
    })),
  };
}

pgDescribe("CliSessionStore PostgreSQL persistence", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_cli_session_store",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  async function importedNativeTaskId(
    idempotencyKey: string,
    semanticTaskId: string,
  ): Promise<string> {
    const productStatus = await inspectCccPrdProductStatus({
      idempotencyKey,
      layer: h.layer(),
      rootDir: h.rootDir(),
    });
    const importedTasks = productStatus?.tasks.filter(
      (task) => task.semanticTaskId === semanticTaskId,
    ) ?? [];
    expect(importedTasks).toEqual([
      expect.objectContaining({
        semanticTaskId,
        nativeTaskId: expect.any(String),
        present: true,
      }),
    ]);
    const taskId = importedTasks[0]!.nativeTaskId;
    expect(taskId).not.toBe(semanticTaskId);
    return taskId;
  }

  async function claimedCampaignAuthority(
    suffix: string,
    claimToken = `claim-${suffix}`,
    transport: "pi" | "cli" = "pi",
  ) {
    const source = campaignBundle(createCccPrdImportTestBundle(h.rootDir(), suffix));
    const idempotencyKey = `effect-${suffix}`;
    await importCccPrdBundle({
      bundle: source,
      idempotencyKey,
      store: h.store(),
      layer: h.layer(),
      rootDir: h.rootDir(),
      executionPolicy: campaignPolicy(source, transport),
    });
    const semanticTaskId = `TASK-${suffix}`;
    const taskId = await importedNativeTaskId(idempotencyKey, semanticTaskId);
    const campaign = await h.store().getCccCampaignContextForTask(taskId);
    if (!campaign) throw new Error(`missing campaign context for ${taskId}`);
    expect(campaign).toMatchObject({ taskId, semanticTaskId, idempotencyKey });
    const rootDir = campaign.targetRepository.path;
    const issued = await issueCccCampaignApproval(h.layer(), {
      authorityStore: h.store(),
      rootDir,
      taskId,
      action: campaignAction,
      requester: campaignRequester,
      runId: `effect-issue:${suffix}`,
      notBeforeAt: campaign.campaignStartedAt,
      expiresAt: campaign.campaignDeadlineAt,
    });
    const claimed = await claimCccCampaignApproval(h.layer(), {
      authorityStore: h.store(),
      rootDir,
      taskId,
      action: campaignAction,
      claimant: campaignWorker,
      runId: `effect-claim:${suffix}`,
      claimToken,
    });
    return { taskId, rootDir, issued, claimed, claimToken };
  }

  type AtomicProviderAttemptSettlementStore = {
    settleCccProviderAttemptAndFence(input: {
      reconciliation: CccProviderAttemptReconciliation;
      terminationReason: CliTerminationReason;
      cancellationState?: string | null;
    }): Promise<CccProviderAttemptScope>;
  };

  function atomicSettlement(store: CliSessionStore): AtomicProviderAttemptSettlementStore {
    return store as unknown as AtomicProviderAttemptSettlementStore;
  }

  async function dispatchedCliProviderAttempt(suffix: string) {
    const claimed = await claimedCampaignAuthority(`provider-settlement-${suffix}`, undefined, "cli");
    const [workItem] = await h.store().listWorkflowWorkItemsForTask(
      claimed.taskId,
      { kinds: ["task"] },
    );
    if (!workItem) throw new Error("missing CLI provider workflow work item");
    const leasedWorkItem = await h.store().transitionWorkflowWorkItem(
      workItem.id,
      "running",
      {
        expectedState: "runnable",
        expectedAttempt: workItem.attempt,
        expectedLeaseOwner: null,
        attempt: workItem.attempt + 1,
        leaseOwner: `cli-provider-worker-${suffix}`,
        leaseExpiresAt: "2999-07-31T23:59:59.000Z",
      },
    );
    const provider = await h.store().reserveCccProviderAttempt({
      taskId: claimed.taskId,
      actionId: campaignAction.actionId,
      actionTarget: campaignAction.actionTarget,
      turnKey: `provider-settlement-turn-${suffix}`,
      dispatchKey: `provider-settlement-dispatch-${suffix}`,
      providerId: "deterministic-fake",
      modelId: "fixture-v1",
      transport: "cli",
      workItemFence: {
        workItemId: leasedWorkItem.id,
        runId: leasedWorkItem.runId,
        attempt: leasedWorkItem.attempt,
      },
    });
    const dispatch = await h.store().beginCccProviderAttemptDispatch({
      taskId: claimed.taskId,
      attemptKey: provider.attemptKey,
      controllerToken: provider.controllerToken,
    });
    expect(dispatch).toMatchObject({ kind: "dispatch-permit", scope: { state: "dispatched_unknown" } });
    return { claimed, provider: dispatch.scope };
  }

  async function heldCliProviderSession(
    suffix: string,
    provider: CccProviderAttemptScope,
    taskId: string,
  ) {
    const store = await CliSessionStore.create(h.layer(), "__legacy_unscoped__", {
      campaignAuthorityStore: h.store(),
      rootDir: h.rootDir(),
    });
    const id = `cli-pg-provider-settlement-${suffix}`;
    store.createSession({
      id,
      projectId: "__legacy_unscoped__",
      adapterId: "codex",
      purpose: "execute",
      taskId,
      agentState: "needsAttention",
      terminationReason: null,
      autonomyPosture: {
        cccNativeCliOneShot: true,
        cccProviderAttemptKey: provider.attemptKey,
        cccProviderAttemptControllerToken: provider.controllerToken,
        cccAuthorityBindingHash: provider.binding.bindingHash,
        cccControllerGeneration: provider.controllerToken,
        cccControllerFenced: false,
        cccNativeCliClosureState: "held-closed",
      },
    });
    await store.flush();
    return { id, store };
  }

  it("atomically settles a dispatched CLI provider attempt and fences its held one-shot session", async () => {
    const { claimed, provider } = await dispatchedCliProviderAttempt("committed");
    const { id, store } = await heldCliProviderSession("committed", provider, claimed.taskId);
    const reconciliation: CccProviderAttemptReconciliation = {
      taskId: claimed.taskId,
      attemptKey: provider.attemptKey,
      controllerToken: provider.controllerToken,
      outcome: "committed",
      evidenceDigest: "a".repeat(64),
      observerId: "loopback-cli-provider-observer",
    };

    await expect(atomicSettlement(store).settleCccProviderAttemptAndFence({
      reconciliation,
      terminationReason: "completed",
      cancellationState: "provider-settled",
    })).resolves.toEqual({
      ...provider,
      state: "committed",
      terminal: {
        kind: "reconciled",
        state: "committed",
        evidenceDigest: reconciliation.evidenceDigest,
        observerId: reconciliation.observerId,
      },
    });
    await expect(h.store().inspectCccProviderAttempt({
      taskId: claimed.taskId,
      attemptKey: provider.attemptKey,
    })).resolves.toEqual({
      ...provider,
      state: "committed",
      terminal: {
        kind: "reconciled",
        state: "committed",
        evidenceDigest: reconciliation.evidenceDigest,
        observerId: reconciliation.observerId,
      },
    });
    const rehydrated = await CliSessionStore.create(h.layer(), "__legacy_unscoped__", {
      campaignAuthorityStore: h.store(),
      rootDir: claimed.rootDir,
    });
    expect(rehydrated.getSession(id)).toMatchObject({
      agentState: "dead",
      terminationReason: "completed",
      autonomyPosture: {
        cccControllerFenced: true,
        cccCancellationState: "provider-settled",
        cccNativeCliClosureState: "settled",
      },
    });
    await expect(getApprovalRequest(h.layer().db, claimed.issued.id)).resolves.toMatchObject({ status: "consumed" });
    await expect(h.store().inspectCccCampaignActionLease(claimed.taskId, campaignAction)).resolves.toBeNull();
  });

  it("replays identical CLI provider settlement without changing its truthful terminal scope", async () => {
    const { claimed, provider } = await dispatchedCliProviderAttempt("identical-replay");
    const { id, store } = await heldCliProviderSession("identical-replay", provider, claimed.taskId);
    const reconciliation: CccProviderAttemptReconciliation = {
      taskId: claimed.taskId,
      attemptKey: provider.attemptKey,
      controllerToken: provider.controllerToken,
      outcome: "committed",
      evidenceDigest: "1".repeat(64),
      observerId: "loopback-cli-provider-observer",
    };
    const settlement = {
      reconciliation,
      terminationReason: "completed" as const,
      cancellationState: "provider-settled",
    };

    const first = await atomicSettlement(store).settleCccProviderAttemptAndFence(settlement);
    await expect(atomicSettlement(store).settleCccProviderAttemptAndFence(settlement)).resolves.toEqual(first);
    await expect(h.store().inspectCccProviderAttempt({
      taskId: claimed.taskId,
      attemptKey: provider.attemptKey,
    })).resolves.toEqual(first);
    await expect(getApprovalRequest(h.layer().db, claimed.issued.id)).resolves.toMatchObject({ status: "consumed" });
    const auditAfterFirst = await getApprovalAuditHistory(h.layer().db, claimed.issued.id);
    await atomicSettlement(store).settleCccProviderAttemptAndFence(settlement);
    const auditAfterSecond = await getApprovalAuditHistory(h.layer().db, claimed.issued.id);
    expect(auditAfterSecond).toEqual(auditAfterFirst);
    const rehydrated = await CliSessionStore.create(h.layer(), "__legacy_unscoped__", {
      campaignAuthorityStore: h.store(),
      rootDir: claimed.rootDir,
    });
    expect(rehydrated.getSession(id)).toMatchObject({
      agentState: "dead",
      terminationReason: "completed",
      autonomyPosture: {
        cccControllerFenced: true,
        cccCancellationState: "provider-settled",
        cccNativeCliClosureState: "settled",
      },
    });
    await expect(h.store().inspectCccCampaignActionLease(claimed.taskId, campaignAction)).resolves.toBeNull();
  });

  it("rolls back provider settlement when the held session generation is stale", async () => {
    const { claimed, provider } = await dispatchedCliProviderAttempt("stale-generation");
    const { id, store } = await heldCliProviderSession("stale-generation", provider, claimed.taskId);
    await expect(store.updateCccSessionForController(id, provider.controllerToken, {
      agentState: "needsAttention",
      terminationReason: null,
      controllerToken: "replacement-controller-generation",
      controllerFenced: false,
    })).resolves.toBeDefined();
    const reconciliation: CccProviderAttemptReconciliation = {
      taskId: claimed.taskId,
      attemptKey: provider.attemptKey,
      controllerToken: provider.controllerToken,
      outcome: "committed",
      evidenceDigest: "b".repeat(64),
      observerId: "loopback-cli-provider-observer",
    };

    await expect(atomicSettlement(store).settleCccProviderAttemptAndFence({
      reconciliation,
      terminationReason: "completed",
    })).rejects.toThrow(/stale|generation|controller|fenc/i);
    await expect(h.store().inspectCccProviderAttempt({
      taskId: claimed.taskId,
      attemptKey: provider.attemptKey,
    })).resolves.toEqual(provider);
    await expect(getApprovalRequest(h.layer().db, claimed.issued.id)).resolves.toMatchObject({ status: "claimed" });
    await expect(h.store().inspectCccCampaignActionLease(claimed.taskId, campaignAction)).resolves.toMatchObject({
      lease: { claimToken: claimed.claimToken },
    });
    const rehydrated = await CliSessionStore.create(h.layer(), "__legacy_unscoped__", {
      campaignAuthorityStore: h.store(),
      rootDir: claimed.rootDir,
    });
    expect(rehydrated.getSession(id)).toMatchObject({
      agentState: "needsAttention",
      terminationReason: null,
      autonomyPosture: {
        cccControllerGeneration: "replacement-controller-generation",
        cccControllerFenced: false,
      },
    });
  });

  it("refuses provider settlement when the held one-shot session has no closure marker", async () => {
    const { claimed, provider } = await dispatchedCliProviderAttempt("missing-closure");
    const { id, store } = await heldCliProviderSession("missing-closure", provider, claimed.taskId);
    const session = store.getSession(id);
    if (!session?.autonomyPosture) throw new Error("missing held CLI posture");
    const { cccNativeCliClosureState: _missingClosure, ...unclosedPosture } = session.autonomyPosture;
    store.updateSession(id, { autonomyPosture: unclosedPosture });
    await store.flush();
    const reconciliation: CccProviderAttemptReconciliation = {
      taskId: claimed.taskId,
      attemptKey: provider.attemptKey,
      controllerToken: provider.controllerToken,
      outcome: "committed",
      evidenceDigest: "e".repeat(64),
      observerId: "loopback-cli-provider-observer",
    };

    await expect(atomicSettlement(store).settleCccProviderAttemptAndFence({
      reconciliation,
      terminationReason: "completed",
    })).rejects.toThrow(/closure|held|one-shot/i);
    await expect(h.store().inspectCccProviderAttempt({
      taskId: claimed.taskId,
      attemptKey: provider.attemptKey,
    })).resolves.toEqual(provider);
    const rehydrated = await CliSessionStore.create(h.layer(), "__legacy_unscoped__", {
      campaignAuthorityStore: h.store(),
      rootDir: claimed.rootDir,
    });
    expect(rehydrated.getSession(id)).toMatchObject({
      agentState: "needsAttention",
      terminationReason: null,
      autonomyPosture: { cccControllerFenced: false },
    });
  });

  it("refuses provider settlement when the closed one-shot session is still busy", async () => {
    const { claimed, provider } = await dispatchedCliProviderAttempt("busy-closure");
    const { id, store } = await heldCliProviderSession("busy-closure", provider, claimed.taskId);
    store.updateSession(id, { agentState: "busy", terminationReason: null });
    await store.flush();
    const reconciliation: CccProviderAttemptReconciliation = {
      taskId: claimed.taskId,
      attemptKey: provider.attemptKey,
      controllerToken: provider.controllerToken,
      outcome: "committed",
      evidenceDigest: "f".repeat(64),
      observerId: "loopback-cli-provider-observer",
    };

    await expect(atomicSettlement(store).settleCccProviderAttemptAndFence({
      reconciliation,
      terminationReason: "completed",
    })).rejects.toThrow(/held|needsAttention|state|closed/i);
    await expect(h.store().inspectCccProviderAttempt({
      taskId: claimed.taskId,
      attemptKey: provider.attemptKey,
    })).resolves.toEqual(provider);
    const rehydrated = await CliSessionStore.create(h.layer(), "__legacy_unscoped__", {
      campaignAuthorityStore: h.store(),
      rootDir: claimed.rootDir,
    });
    expect(rehydrated.getSession(id)).toMatchObject({
      agentState: "busy",
      terminationReason: null,
      autonomyPosture: {
        cccNativeCliClosureState: "held-closed",
        cccControllerFenced: false,
      },
    });
  });

  it("rejects conflicting provider terminal reconciliation without terminating the held CLI session", async () => {
    const { claimed, provider } = await dispatchedCliProviderAttempt("terminal-conflict");
    const { id, store } = await heldCliProviderSession("terminal-conflict", provider, claimed.taskId);
    const existing: CccProviderAttemptReconciliation = {
      taskId: claimed.taskId,
      attemptKey: provider.attemptKey,
      controllerToken: provider.controllerToken,
      outcome: "committed",
      evidenceDigest: "c".repeat(64),
      observerId: "first-cli-provider-observer",
    };
    const terminal = await h.store().reconcileCccProviderAttempt(existing);

    await expect(atomicSettlement(store).settleCccProviderAttemptAndFence({
      reconciliation: {
        ...existing,
        evidenceDigest: "d".repeat(64),
        observerId: "conflicting-cli-provider-observer",
      },
      terminationReason: "completed",
    })).rejects.toThrow(/collision|conflict|reconcil/i);
    await expect(h.store().inspectCccProviderAttempt({
      taskId: claimed.taskId,
      attemptKey: provider.attemptKey,
    })).resolves.toEqual(terminal);
    const rehydrated = await CliSessionStore.create(h.layer(), "__legacy_unscoped__", {
      campaignAuthorityStore: h.store(),
      rootDir: claimed.rootDir,
    });
    expect(rehydrated.getSession(id)).toMatchObject({
      agentState: "needsAttention",
      terminationReason: null,
      autonomyPosture: { cccControllerFenced: false },
    });
  });

  it("refuses campaign receipt reservation before an authority reader is injected", async () => {
    const source = campaignBundle(createCccPrdImportTestBundle(h.rootDir(), "effect-missing-authority"));
    const idempotencyKey = "effect-missing-authority";
    await importCccPrdBundle({
      bundle: source,
      idempotencyKey,
      store: h.store(),
      layer: h.layer(),
      rootDir: h.rootDir(),
      executionPolicy: campaignPolicy(source),
    });
    const taskId = await importedNativeTaskId(
      idempotencyKey,
      "TASK-effect-missing-authority",
    );
    const store = await CliSessionStore.create(h.layer(), "__legacy_unscoped__");
    store.createSession({
      id: "cli-pg-campaign-missing-authority",
      projectId: "__legacy_unscoped__",
      adapterId: "pi",
      purpose: "execute",
      taskId,
    });
    await store.flush();

    await expect(reserveCccEffectReceipt(store, {
      sessionId: "cli-pg-campaign-missing-authority",
      controllerToken: "campaign-controller",
      toolName: "merge_candidate",
      arguments: { target: "refs/heads/main", __fusion_effect: { key: "campaign-effect" } },
    })).rejects.toThrow(/campaign authority store|campaign receipt/i);
  });

  it("derives and persists complete campaign effect authority from the stored session task", async () => {
    const claimed = await claimedCampaignAuthority("effect-binding");
    const store = await CliSessionStore.create(h.layer(), "__legacy_unscoped__", {
      campaignAuthorityStore: h.store(),
      rootDir: claimed.rootDir,
    });
    store.createSession({
      id: "cli-pg-campaign-binding",
      projectId: "__legacy_unscoped__",
      adapterId: "pi",
      purpose: "execute",
      taskId: claimed.taskId,
    });
    await store.flush();

    await reserveCccEffectReceipt(store, {
      sessionId: "cli-pg-campaign-binding",
      controllerToken: "campaign-binding-controller",
      toolName: "merge_candidate",
      arguments: { target: "refs/heads/main", __fusion_effect: { key: "campaign-binding-effect" } },
      campaign: {
        actionId: campaignAction.actionId,
        actionTarget: campaignAction.actionTarget,
        approvalRequestId: claimed.issued.id,
        claimToken: claimed.claimToken,
      },
    });

    const persisted = await store.getCccEffectReceipt("cli-pg-campaign-binding", "campaign-binding-effect");
    expect(persisted).toMatchObject({
      campaign: {
        binding: {
          taskId: claimed.taskId,
          actionId: campaignAction.actionId,
          actionTarget: campaignAction.actionTarget,
        },
      },
    });
    const binding = persisted?.campaign?.binding;
    if (!binding) throw new Error("missing campaign receipt binding");
    await expect(h.layer().db.execute(sql`
      UPDATE project.ccc_effect_receipts
      SET campaign_import_id = ${`${binding.importId}-foreign`}
      WHERE project_id = ${binding.projectId}
        AND effect_scope_id = 'cli-pg-campaign-binding'
        AND logical_key = 'campaign-binding-effect'
    `)).rejects.toMatchObject({
      cause: expect.objectContaining({
        constraint_name: "ccc_effect_receipts_campaign_import_fkey",
      }),
    });
  });

  it("refuses a campaign receipt when its hydrated session task is stale against PostgreSQL", async () => {
    const claimed = await claimedCampaignAuthority("effect-persisted-session");
    const store = await CliSessionStore.create(h.layer(), "__legacy_unscoped__", {
      campaignAuthorityStore: h.store(),
      rootDir: claimed.rootDir,
    });
    store.createSession({
      id: "cli-pg-campaign-persisted-session",
      projectId: "__legacy_unscoped__",
      adapterId: "pi",
      purpose: "execute",
      taskId: claimed.taskId,
    });
    await store.flush();
    await h.layer().db.execute(sql`
      UPDATE project.cli_sessions
      SET task_id = 'TASK-not-campaign'
      WHERE owner_project_id = '__legacy_unscoped__'
        AND id = 'cli-pg-campaign-persisted-session'
    `);

    await expect(reserveCccEffectReceipt(store, {
      sessionId: "cli-pg-campaign-persisted-session",
      controllerToken: "campaign-persisted-session-controller",
      toolName: "merge_candidate",
      arguments: { target: "refs/heads/main", __fusion_effect: { key: "campaign-persisted-session-effect" } },
      campaign: {
        actionId: campaignAction.actionId,
        actionTarget: campaignAction.actionTarget,
        approvalRequestId: claimed.issued.id,
        claimToken: claimed.claimToken,
      },
    })).rejects.toMatchObject({ code: "CCC_EFFECT_RECONCILIATION_REQUIRED" });
  });

  it("does not transfer a campaign reservation after a controller restart without reconciliation", async () => {
    const claimed = await claimedCampaignAuthority("effect-no-blind-takeover");
    const first = await CliSessionStore.create(h.layer(), "__legacy_unscoped__", {
      campaignAuthorityStore: h.store(),
      rootDir: claimed.rootDir,
    });
    first.createSession({
      id: "cli-pg-campaign-no-blind-takeover",
      projectId: "__legacy_unscoped__",
      adapterId: "pi",
      purpose: "execute",
      taskId: claimed.taskId,
      agentState: "dead",
      terminationReason: "engineDeath",
      autonomyPosture: {
        cccControllerGeneration: "campaign-controller-one",
        cccControllerFenced: true,
      },
    });
    await first.flush();
    const effectInput = {
      sessionId: "cli-pg-campaign-no-blind-takeover",
      controllerToken: "campaign-controller-one",
      toolName: "merge_candidate",
      arguments: { target: "refs/heads/main", __fusion_effect: { key: "campaign-no-blind-takeover" } },
      campaign: {
        actionId: campaignAction.actionId,
        actionTarget: campaignAction.actionTarget,
        approvalRequestId: claimed.issued.id,
        claimToken: claimed.claimToken,
      },
    };
    await reserveCccEffectReceipt(first, effectInput);

    const restarted = await CliSessionStore.create(h.layer(), "__legacy_unscoped__", {
      campaignAuthorityStore: h.store(),
      rootDir: claimed.rootDir,
    });
    await expect(reserveCccEffectReceipt(restarted, {
      ...effectInput,
      controllerToken: "campaign-controller-two",
    })).rejects.toMatchObject({ code: "CCC_EFFECT_RECONCILIATION_REQUIRED" });
  });

  it("reconciles a campaign dispatched receipt to committed with the claimed approval in one durable path", async () => {
    const claimed = await claimedCampaignAuthority("effect-reconcile-committed");
    const store = await CliSessionStore.create(h.layer(), "__legacy_unscoped__", {
      campaignAuthorityStore: h.store(),
      rootDir: claimed.rootDir,
    });
    store.createSession({
      id: "cli-pg-campaign-reconcile-committed",
      projectId: "__legacy_unscoped__",
      adapterId: "pi",
      purpose: "execute",
      taskId: claimed.taskId,
      autonomyPosture: { cccControllerGeneration: "campaign-reconcile-generation" },
    });
    await store.flush();
    const effectInput = {
      sessionId: "cli-pg-campaign-reconcile-committed",
      controllerToken: "campaign-reconcile-generation",
      toolName: "merge_candidate",
      arguments: { target: "refs/heads/main", __fusion_effect: { key: "campaign-reconcile-committed" } },
      campaign: {
        actionId: campaignAction.actionId,
        actionTarget: campaignAction.actionTarget,
        approvalRequestId: claimed.issued.id,
        claimToken: claimed.claimToken,
      },
    };
    await reserveCccEffectReceipt(store, effectInput);
    await markCccEffectReceiptDispatched(store, effectInput);
    const reconciliation = {
      ...effectInput,
      controllerGeneration: "campaign-reconcile-generation",
      observerId: "loopback-effect-observer",
      observationDigest: "a".repeat(64),
      observation: { kind: "committed" as const, result: { merged: true, revision: "fixture" } },
      actor: campaignWorker,
      runId: "effect-reconcile:committed",
    };

    const reconcile = (effectReceipts as unknown as {
      reconcileCccEffectReceipt: (store: CliSessionStore, input: typeof reconciliation) => Promise<unknown>;
    }).reconcileCccEffectReceipt;
    await expect(reconcile(store, reconciliation)).resolves.toMatchObject({
      state: "committed",
      result: { merged: true, revision: "fixture" },
    });
    await expect(reconcile(store, {
      ...reconciliation,
      campaign: { ...reconciliation.campaign, claimToken: "wrong-campaign-claim-token" },
    })).rejects.toThrow(/consumed|approval|claim/i);
    await expect(getApprovalRequest(h.layer().db, claimed.issued.id)).resolves.toMatchObject({ status: "consumed" });
    await expect(h.store().inspectCccCampaignActionLease(claimed.taskId, campaignAction)).resolves.toBeNull();

    await expect(reconcile(store, reconciliation)).resolves.toMatchObject({
      state: "committed",
      result: { merged: true, revision: "fixture" },
    });
  });

  it("rolls back campaign receipt, approval, and lease when the deterministic reconciliation audit collides", async () => {
    const claimed = await claimedCampaignAuthority("effect-reconcile-audit-rollback");
    const store = await CliSessionStore.create(h.layer(), "__legacy_unscoped__", {
      campaignAuthorityStore: h.store(),
      rootDir: claimed.rootDir,
    });
    store.createSession({
      id: "cli-pg-campaign-reconcile-audit-rollback",
      projectId: "__legacy_unscoped__",
      adapterId: "pi",
      purpose: "execute",
      taskId: claimed.taskId,
      autonomyPosture: { cccControllerGeneration: "campaign-audit-rollback-generation" },
    });
    await store.flush();
    const effectInput = {
      sessionId: "cli-pg-campaign-reconcile-audit-rollback",
      controllerToken: "campaign-audit-rollback-generation",
      toolName: "merge_candidate",
      arguments: { target: "refs/heads/main", __fusion_effect: { key: "campaign-reconcile-audit-rollback" } },
      campaign: {
        actionId: campaignAction.actionId,
        actionTarget: campaignAction.actionTarget,
        approvalRequestId: claimed.issued.id,
        claimToken: claimed.claimToken,
      },
    };
    await reserveCccEffectReceipt(store, effectInput);
    await markCccEffectReceiptDispatched(store, effectInput);
    const reconciliation = {
      ...effectInput,
      controllerGeneration: "campaign-audit-rollback-generation",
      observerId: "loopback-effect-observer",
      observationDigest: "c".repeat(64),
      observation: { kind: "committed" as const, result: { merged: true, revision: "rollback" } },
      actor: campaignWorker,
      runId: "effect-reconcile:audit-rollback",
    };
    const reserved = await store.getCccEffectReceipt(effectInput.sessionId, "campaign-reconcile-audit-rollback");
    const binding = reserved?.campaign?.binding;
    if (!binding) throw new Error("missing campaign binding for audit collision proof");
    const evidenceDigest = createHash("sha256").update(canonicalCccEffectJson({
      schema: "ccc-effect-reconciliation-evidence/v1",
      effectScopeId: effectInput.sessionId,
      logicalKey: "campaign-reconcile-audit-rollback",
      controllerGeneration: reconciliation.controllerGeneration,
      observerId: reconciliation.observerId,
      observationDigest: reconciliation.observationDigest,
      observation: reconciliation.observation,
      actionId: effectInput.campaign.actionId,
      actionTarget: effectInput.campaign.actionTarget,
      approvalRequestId: effectInput.campaign.approvalRequestId,
      claimToken: effectInput.campaign.claimToken,
    })).digest("hex");
    await recordRunAuditEvent(h.layer(), {
      timestamp: "2026-01-01T00:00:00.000Z",
      taskId: claimed.taskId,
      agentId: "audit-collision-fixture",
      runId: "audit-collision-fixture",
      domain: "ccc-effect",
      mutationType: "effect-receipt:committed",
      target: binding.actionTarget,
      metadata: { injected: true },
      campaign: {
        eventKey: `ccc-effect:${binding.bindingHash}:${effectInput.sessionId}:campaign-reconcile-audit-rollback:committed:${evidenceDigest}`,
        binding,
      },
    });
    const reconcile = (effectReceipts as unknown as {
      reconcileCccEffectReceipt: (store: CliSessionStore, input: typeof reconciliation) => Promise<unknown>;
    }).reconcileCccEffectReceipt;

    await expect(reconcile(store, reconciliation)).rejects.toThrow(/collid|audit/i);
    await expect(store.getCccEffectReceipt(effectInput.sessionId, "campaign-reconcile-audit-rollback"))
      .resolves.toMatchObject({ state: "dispatched_unknown" });
    await expect(getApprovalRequest(h.layer().db, claimed.issued.id)).resolves.toMatchObject({ status: "claimed" });
    await expect(h.store().inspectCccCampaignActionLease(claimed.taskId, campaignAction)).resolves.toMatchObject({
      lease: { claimToken: claimed.claimToken },
    });
  });

  it("records local no-effect evidence without releasing an unexpired campaign claim", async () => {
    const claimed = await claimedCampaignAuthority("effect-reconcile-no-effect");
    const store = await CliSessionStore.create(h.layer(), "__legacy_unscoped__", {
      campaignAuthorityStore: h.store(),
      rootDir: claimed.rootDir,
    });
    store.createSession({
      id: "cli-pg-campaign-reconcile-no-effect",
      projectId: "__legacy_unscoped__",
      adapterId: "pi",
      purpose: "execute",
      taskId: claimed.taskId,
      autonomyPosture: { cccControllerGeneration: "campaign-no-effect-generation" },
    });
    await store.flush();
    const effectInput = {
      sessionId: "cli-pg-campaign-reconcile-no-effect",
      controllerToken: "campaign-no-effect-generation",
      toolName: "merge_candidate",
      arguments: { target: "refs/heads/main", __fusion_effect: { key: "campaign-reconcile-no-effect" } },
      campaign: {
        actionId: campaignAction.actionId,
        actionTarget: campaignAction.actionTarget,
        approvalRequestId: claimed.issued.id,
        claimToken: claimed.claimToken,
      },
    };
    await reserveCccEffectReceipt(store, effectInput);
    await markCccEffectReceiptDispatched(store, effectInput);
    const reconciliation = {
      ...effectInput,
      controllerGeneration: "campaign-no-effect-generation",
      observerId: "loopback-effect-observer",
      observationDigest: "b".repeat(64),
      observation: { kind: "no_effect" as const },
      actor: campaignWorker,
      runId: "effect-reconcile:no-effect",
    };
    const reconcile = (effectReceipts as unknown as {
      reconcileCccEffectReceipt: (store: CliSessionStore, input: typeof reconciliation) => Promise<unknown>;
    }).reconcileCccEffectReceipt;

    await expect(reconcile(store, reconciliation)).resolves.toMatchObject({ state: "proved_failed" });
    await expect(getApprovalRequest(h.layer().db, claimed.issued.id)).resolves.toMatchObject({ status: "claimed" });
    await expect(h.store().inspectCccCampaignActionLease(claimed.taskId, campaignAction)).resolves.toMatchObject({
      lease: { claimToken: claimed.claimToken },
    });
    await expect(reconcile(store, {
      ...reconciliation,
      observerId: "different-observer",
    })).rejects.toMatchObject({ code: "CCC_EFFECT_KEY_COLLISION" });
    // Simulate the authoritative database deadline crossing after a local
    // observer proved no dispatch. The identical replay must expire/settle,
    // not return early with a permanently claimed lease.
    await h.layer().db.execute(sql`
      UPDATE project.approval_requests
      SET not_before_at = to_char(
            (clock_timestamp() AT TIME ZONE 'UTC') - interval '2 seconds',
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
          ),
          expires_at = to_char(
            (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 second',
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
          )
      WHERE id = ${claimed.issued.id}
    `);
    await expect(reconcile(store, reconciliation)).resolves.toMatchObject({ state: "proved_failed" });
    await expect(getApprovalRequest(h.layer().db, claimed.issued.id)).resolves.toMatchObject({ status: "expired" });
    await expect(h.store().inspectCccCampaignActionLease(claimed.taskId, campaignAction)).resolves.toBeNull();
    await expect(reconcile(store, reconciliation)).resolves.toMatchObject({ state: "proved_failed" });
  });

  it("directly commits a campaign receipt only with atomic approval consumption and lease settlement", async () => {
    const claimed = await claimedCampaignAuthority("effect-direct-commit");
    const store = await CliSessionStore.create(h.layer(), "__legacy_unscoped__", {
      campaignAuthorityStore: h.store(),
      rootDir: claimed.rootDir,
    });
    store.createSession({
      id: "cli-pg-campaign-direct-commit",
      projectId: "__legacy_unscoped__",
      adapterId: "pi",
      purpose: "execute",
      taskId: claimed.taskId,
    });
    await store.flush();
    const effectInput = {
      sessionId: "cli-pg-campaign-direct-commit",
      controllerToken: "campaign-direct-controller",
      toolName: "merge_candidate",
      arguments: { target: "refs/heads/main", __fusion_effect: { key: "campaign-direct-commit" } },
      campaign: {
        actionId: campaignAction.actionId,
        actionTarget: campaignAction.actionTarget,
        approvalRequestId: claimed.issued.id,
        claimToken: claimed.claimToken,
      },
    };
    await reserveCccEffectReceipt(store, effectInput);
    await markCccEffectReceiptDispatched(store, effectInput);

    await expect(commitCccEffectReceipt(store, effectInput, { merged: true })).resolves.toMatchObject({
      state: "committed",
      campaign: { binding: { taskId: claimed.taskId } },
    });
    await expect(getApprovalRequest(h.layer().db, claimed.issued.id)).resolves.toMatchObject({ status: "consumed" });
    await expect(h.store().inspectCccCampaignActionLease(claimed.taskId, campaignAction)).resolves.toBeNull();
    await expect(commitCccEffectReceipt(store, effectInput, { merged: true })).resolves.toMatchObject({
      state: "committed",
      campaign: { binding: { taskId: claimed.taskId } },
    });
    await expect(commitCccEffectReceipt(store, {
      ...effectInput,
      campaign: { ...effectInput.campaign, claimToken: "wrong-campaign-claim-token" },
    }, { merged: true })).rejects.toThrow(/consumed|approval|claim/i);
    const restarted = await CliSessionStore.create(h.layer(), "__legacy_unscoped__", {
      campaignAuthorityStore: h.store(),
      rootDir: claimed.rootDir,
    });
    await expect(reserveCccEffectReceipt(restarted, effectInput)).resolves.toMatchObject({
      state: "committed",
      campaign: { binding: { taskId: claimed.taskId } },
    });
    await expect(reserveCccEffectReceipt(restarted, {
      ...effectInput,
      campaign: { ...effectInput.campaign, claimToken: "wrong-campaign-claim-token" },
    })).rejects.toThrow(/consumed|approval|claim/i);
    await expect(reserveCccEffectReceipt(restarted, {
      ...effectInput,
      campaign: { ...effectInput.campaign, approvalRequestId: "foreign-approval-request" },
    })).rejects.toThrow(/consumed|approval|claim/i);
  });

  it("persists, updates, filters, deletes, and rehydrates project sessions", async () => {
    const store = await CliSessionStore.create(h.layer(), "project-a");
    const created = store.createSession({
      id: "cli-pg-1",
      projectId: "project-a",
      adapterId: "codex",
      purpose: "execute",
      taskId: "FN-9000",
      autonomyPosture: { autoApprove: true },
    });
    await store.flush();

    expect(created.agentState).toBe("starting");
    expect(store.listByTask("FN-9000")).toHaveLength(1);
    store.updateSession(created.id, {
      agentState: "waitingOnInput",
      nativeSessionId: "native-1",
      resumeAttempts: 2,
    });
    await store.flush();

    const rehydrated = await CliSessionStore.create(h.layer(), "project-a");
    expect(rehydrated.getSession(created.id)).toMatchObject({
      agentState: "waitingOnInput",
      nativeSessionId: "native-1",
      resumeAttempts: 2,
      autonomyPosture: { autoApprove: true },
    });
    expect(rehydrated.listSessions({ agentState: "waitingOnInput" })).toHaveLength(1);
    expect((await CliSessionStore.create(h.layer(), "project-b")).listSessions()).toEqual([]);

    expect(rehydrated.deleteSession(created.id)).toBe(true);
    await rehydrated.flush();
    expect((await CliSessionStore.create(h.layer(), "project-a")).getSession(created.id)).toBeUndefined();
  });

  it("rejects a stale CCC controller lifecycle finalizer after durable generation takeover", async () => {
    const bootstrap = await CliSessionStore.create(h.layer(), "project-a");
    const session = bootstrap.createSession({
      id: "cli-pg-controller-cas",
      projectId: "project-a",
      adapterId: "pi",
      purpose: "execute",
      taskId: "FN-CCC-CAS",
      agentState: "dead",
      terminationReason: "engineDeath",
      autonomyPosture: {
        cccControllerGeneration: "controller-old",
        cccControllerFenced: true,
      },
    });
    await bootstrap.flush();

    const oldController = await CliSessionStore.create(h.layer(), "project-a");
    const replacementController = await CliSessionStore.create(h.layer(), "project-a");
    const replacement = await replacementController.updateCccSessionForController(session.id, "controller-old", {
      agentState: "busy",
      terminationReason: null,
      controllerToken: "controller-fresh",
      controllerFenced: false,
      cancellationState: null,
    });
    expect(replacement).toMatchObject({
      agentState: "busy",
      terminationReason: null,
      autonomyPosture: {
        cccControllerGeneration: "controller-fresh",
        cccControllerFenced: false,
      },
    });

    await expect(oldController.updateCccSessionForController(session.id, "controller-old", {
      agentState: "dead",
      terminationReason: "killed",
      controllerFenced: true,
      cancellationState: "CANCELLED",
    })).resolves.toBeUndefined();
    expect((await CliSessionStore.create(h.layer(), "project-a")).getSession(session.id)).toMatchObject({
      agentState: "busy",
      terminationReason: null,
      autonomyPosture: {
        cccControllerGeneration: "controller-fresh",
        cccControllerFenced: false,
      },
    });
  });

  it("persists and removes the native CLI closure marker through the controller CAS lifecycle path", async () => {
    const store = await CliSessionStore.create(h.layer(), "project-a");
    const session = store.createSession({
      id: "cli-pg-controller-closure-marker",
      projectId: "project-a",
      adapterId: "codex",
      purpose: "execute",
      taskId: "FN-CCC-CLOSURE",
      agentState: "needsAttention",
      terminationReason: null,
      autonomyPosture: {
        cccControllerGeneration: "controller-closure",
        cccControllerFenced: false,
      },
    });
    await store.flush();
    const controller = store as unknown as {
      updateCccSessionForController(
        id: string,
        expectedControllerToken: string,
        input: {
          agentState: "needsAttention";
          terminationReason: null;
          nativeCliClosureState?: string | null;
        },
      ): ReturnType<CliSessionStore["updateCccSessionForController"]>;
    };

    await expect(controller.updateCccSessionForController(session.id, "controller-closure", {
      agentState: "needsAttention",
      terminationReason: null,
      nativeCliClosureState: "held-closed",
    })).resolves.toMatchObject({
      autonomyPosture: { cccNativeCliClosureState: "held-closed" },
    });
    expect((await CliSessionStore.create(h.layer(), "project-a")).getSession(session.id)).toMatchObject({
      autonomyPosture: { cccNativeCliClosureState: "held-closed" },
    });

    const removed = await controller.updateCccSessionForController(session.id, "controller-closure", {
      agentState: "needsAttention",
      terminationReason: null,
      nativeCliClosureState: null,
    });
    expect(removed?.autonomyPosture?.cccNativeCliClosureState).toBeUndefined();
    expect((await CliSessionStore.create(h.layer(), "project-a")).getSession(session.id)?.autonomyPosture)
      .not.toHaveProperty("cccNativeCliClosureState");
  });

  it("does not reissue a committed CCC effect after PostgreSQL store rehydration", async () => {
    const first = await CliSessionStore.create(h.layer(), "project-a");
    first.createSession({
      id: "cli-pg-effect-receipt",
      projectId: "project-a",
      adapterId: "custom-provider-pi",
      purpose: "execute",
      taskId: "FN-CCC-EFFECT",
      autonomyPosture: { cccFusionProfile: "ccc-fusion" },
    });
    await first.flush();
    const effectInput = {
      sessionId: "cli-pg-effect-receipt",
      toolCallId: "provider-call-001",
      controllerToken: "controller-initial",
      toolName: "commit_synthetic_effect",
      arguments: { target: "loopback", revision: 1, __fusion_effect: { key: "effect-initial" } },
    };
    let executions = 0;
    const executeIfUncommitted = async (store: CliSessionStore) => {
      if (await hasCccEffectReceipt(store, effectInput)) return "replayed" as const;
      await reserveCccEffectReceipt(store, effectInput);
      await markCccEffectReceiptDispatched(store, effectInput);
      executions += 1;
      await commitCccEffectReceipt(store, effectInput);
      return "executed" as const;
    };

    expect(await executeIfUncommitted(first)).toBe("executed");
    const restarted = await CliSessionStore.create(h.layer(), "project-a");
    expect(await executeIfUncommitted(restarted)).toBe("replayed");
    expect(executions).toBe(1);
    expect(restarted.getSession("cli-pg-effect-receipt")?.autonomyPosture).toMatchObject({
      cccFusionProfile: "ccc-fusion",
    });
  });

  it("keys one logical effect across provider call-id drift and requires repeatOf for an intentional identical repeat", async () => {
    const first = {
      sessionId: "cli-pg-logical-effect",
      toolCallId: "provider-request-001",
      controllerToken: "controller-logical",
      toolName: "commit_synthetic_effect",
      arguments: {
        target: "loopback",
        __fusion_effect: { key: "logical-effect-001" },
      },
    };
    const retry = {
      ...first,
      toolCallId: "provider-request-retried-999",
    };

    // Provider request IDs are fencing evidence, not the durable logical
    // effect address. Current v1 incorrectly hashes this value into identity.
    expect(cccEffectReceiptIdentity(retry)).toBe(cccEffectReceiptIdentity(first));
  });

  it("single-flights one effect across two independently hydrated CliSessionStore controllers", async () => {
    const bootstrap = await CliSessionStore.create(h.layer(), "project-a");
    bootstrap.createSession({
      id: "cli-pg-two-controller-effect",
      projectId: "project-a",
      adapterId: "pi",
      purpose: "execute",
      taskId: "FN-CCC-TWO-CONTROLLER",
      autonomyPosture: { cccFusionProfile: "ccc-fusion" },
    });
    await bootstrap.flush();

    const left = await CliSessionStore.create(h.layer(), "project-a");
    const right = await CliSessionStore.create(h.layer(), "project-a");
    const input = {
      sessionId: "cli-pg-two-controller-effect",
      toolCallId: "provider-call-one",
      controllerToken: "controller-left",
      toolName: "commit_synthetic_effect",
      arguments: { target: "loopback", __fusion_effect: { key: "effect-two-controller" } },
    };
    let handlerCount = 0;
    const dispatch = async (store: CliSessionStore, controllerToken: string) => {
      const command = { ...input, controllerToken };
      await reserveCccEffectReceipt(store, command);
      await markCccEffectReceiptDispatched(store, command);
      handlerCount += 1;
      await commitCccEffectReceipt(store, command);
    };

    await Promise.allSettled([dispatch(left, "controller-left"), dispatch(right, "controller-right")]);

    expect(handlerCount).toBe(1);
  });

  it("keeps post-dispatch crash unknown across reopen until authoritative reconciliation", async () => {
    const first = await CliSessionStore.create(h.layer(), "project-a");
    first.createSession({
      id: "cli-pg-post-dispatch-unknown",
      projectId: "project-a",
      adapterId: "pi",
      purpose: "execute",
      taskId: "FN-CCC-UNKNOWN",
      autonomyPosture: { cccFusionProfile: "ccc-fusion" },
    });
    await first.flush();
    const input = {
      sessionId: "cli-pg-post-dispatch-unknown",
      toolCallId: "provider-call-unknown",
      controllerToken: "controller-unknown",
      toolName: "commit_synthetic_effect",
      arguments: { target: "loopback", __fusion_effect: { key: "effect-unknown" } },
    };

    await reserveCccEffectReceipt(first, input);
    await markCccEffectReceiptDispatched(first, input);
    // An untrusted post-dispatch throw is not proof that the downstream effect
    // did not happen. The v1 helper nevertheless clears the pending claim.
    await expect(abandonCccEffectReceipt(first, input))
      .rejects.toMatchObject({ code: "CCC_EFFECT_RECONCILIATION_REQUIRED" });

    const reopened = await CliSessionStore.create(h.layer(), "project-a");
    await expect(reopened.getCccEffectReceipt(input.sessionId, "effect-unknown"))
      .resolves.toMatchObject({ state: "dispatched_unknown" });
  });

  it("reclaims a reserved receipt only after the prior controller is explicitly fenced", async () => {
    const store = await CliSessionStore.create(h.layer(), "project-a");
    store.createSession({ id: "cli-pg-fenced-reservation", projectId: "project-a", adapterId: "pi", purpose: "execute" });
    await store.flush();
    const prior = {
      sessionId: "cli-pg-fenced-reservation", controllerToken: "generation-one", toolName: "commit_synthetic_effect",
      arguments: { target: "loopback", __fusion_effect: { key: "fenced-effect" } },
    };
    await reserveCccEffectReceipt(store, prior);
    // This is a durable, explicit controller decision; no elapsed-time input is
    // supplied or inferred anywhere in the takeover proof.
    await abandonCccEffectReceipt(store, prior);

    await expect(reserveCccEffectReceipt(await CliSessionStore.create(h.layer(), "project-a"), {
      ...prior,
      controllerToken: "generation-two",
    })).resolves.toMatchObject({ state: "reserved", controllerToken: "generation-two" });
  });

  it("takes over a pre-dispatch reservation only after durable session ownership proves the prior controller dead", async () => {
    const initial = await CliSessionStore.create(h.layer(), "project-a");
    initial.createSession({
      id: "cli-pg-dead-controller-fence",
      projectId: "project-a",
      adapterId: "pi",
      purpose: "execute",
      autonomyPosture: { cccFusionProfile: "ccc-fusion", cccControllerGeneration: "generation-one" },
    });
    await initial.flush();
    const first = {
      sessionId: "cli-pg-dead-controller-fence",
      controllerToken: "generation-one",
      toolName: "commit_synthetic_effect",
      arguments: { target: "loopback", __fusion_effect: { key: "fenced-after-death" } },
    };
    await reserveCccEffectReceipt(initial, first);

    // This is the durable crash/fence proof available after the first controller
    // is gone. It deliberately does not invoke its unavailable in-memory helper
    // or use elapsed time as an authority signal.
    initial.updateSession(first.sessionId, {
      agentState: "dead",
      terminationReason: "engineDeath",
      autonomyPosture: {
        cccFusionProfile: "ccc-fusion",
        cccControllerGeneration: "generation-one",
        cccControllerFenced: true,
      },
    });
    await initial.flush();

    const restarted = await CliSessionStore.create(h.layer(), "project-a");
    await expect(reserveCccEffectReceipt(restarted, {
      ...first,
      controllerToken: "generation-two",
    })).resolves.toMatchObject({ state: "reserved", controllerToken: "generation-two" });
  });

  it("blocks an entire effectful scope after dispatched_unknown until reconciliation", async () => {
    const store = await CliSessionStore.create(h.layer(), "project-a");
    store.createSession({ id: "cli-pg-scope-barrier", projectId: "project-a", adapterId: "pi", purpose: "execute" });
    await store.flush();
    const unknown = {
      sessionId: "cli-pg-scope-barrier", controllerToken: "generation-one", toolName: "commit_synthetic_effect",
      arguments: { target: "loopback-a", __fusion_effect: { key: "unknown-effect" } },
    };
    await reserveCccEffectReceipt(store, unknown);
    await markCccEffectReceiptDispatched(store, unknown);

    await expect(reserveCccEffectReceipt(await CliSessionStore.create(h.layer(), "project-a"), {
      sessionId: unknown.sessionId,
      controllerToken: "generation-two",
      toolName: "commit_synthetic_effect",
      arguments: { target: "loopback-b", __fusion_effect: { key: "different-effect" } },
    })).rejects.toMatchObject({ code: "CCC_EFFECT_RECONCILIATION_REQUIRED" });
  });

  it("rejects ambiguous same-payload keys and commits an explicit repeatOf receipt", async () => {
    const store = await CliSessionStore.create(h.layer(), "project-a");
    store.createSession({ id: "cli-pg-repeat-of", projectId: "project-a", adapterId: "pi", purpose: "execute" });
    await store.flush();
    const first = {
      sessionId: "cli-pg-repeat-of", controllerToken: "generation-one", toolName: "commit_synthetic_effect",
      arguments: { target: "loopback", __fusion_effect: { key: "original-effect" } },
    };
    await reserveCccEffectReceipt(store, first);
    await markCccEffectReceiptDispatched(store, first);
    await commitCccEffectReceipt(store, first);

    await expect(reserveCccEffectReceipt(store, {
      ...first,
      controllerToken: "generation-two",
      arguments: { target: "loopback", __fusion_effect: { key: "ambiguous-copy" } },
    })).rejects.toMatchObject({ code: "CCC_EFFECT_AMBIGUOUS_DUPLICATE" });

    const repeat = {
      ...first,
      controllerToken: "generation-three",
      arguments: { target: "loopback", __fusion_effect: { key: "intentional-repeat", repeatOf: "original-effect" } },
    };
    await reserveCccEffectReceipt(store, repeat);
    await markCccEffectReceiptDispatched(store, repeat);
    await expect(commitCccEffectReceipt(store, repeat)).resolves.toMatchObject({ state: "committed", logicalKey: "intentional-repeat" });
  });

  it("admits an identical effect in a distinct Fusion-owned durable turn", async () => {
    const store = await CliSessionStore.create(h.layer(), "project-a");
    store.createSession({ id: "cli-pg-distinct-turn-repeat", projectId: "project-a", adapterId: "pi", purpose: "execute" });
    await store.flush();
    const first = {
      sessionId: "cli-pg-distinct-turn-repeat",
      controllerToken: "turn-controller-one",
      turnKey: "turn-one",
      slotOrdinal: 0,
      toolName: "commit_synthetic_effect",
      arguments: { target: "loopback" },
    };
    await reserveCccEffectReceipt(store, first);
    await markCccEffectReceiptDispatched(store, first);
    await commitCccEffectReceipt(store, first, { content: [{ type: "text", text: "first" }] });

    const repeatInNewTurn = {
      ...first,
      controllerToken: "turn-controller-two",
      turnKey: "turn-two",
    };
    await expect(reserveCccEffectReceipt(store, repeatInNewTurn)).resolves.toMatchObject({
      state: "reserved",
      turnKey: "turn-two",
      slotOrdinal: 0,
    });
  });

  it("reopens committed effect and suppresses replay despite changed provider request id", async () => {
    const first = await CliSessionStore.create(h.layer(), "project-a");
    first.createSession({
      id: "cli-pg-request-id-drift",
      projectId: "project-a",
      adapterId: "pi",
      purpose: "execute",
      taskId: "FN-CCC-REQUEST-ID-DRIFT",
      autonomyPosture: { cccFusionProfile: "ccc-fusion" },
    });
    await first.flush();
    const committed = {
      sessionId: "cli-pg-request-id-drift",
      toolCallId: "provider-request-original",
      controllerToken: "controller-committed",
      toolName: "commit_synthetic_effect",
      arguments: { target: "loopback", revision: 1, __fusion_effect: { key: "effect-request-drift" } },
    };
    await reserveCccEffectReceipt(first, committed);
    await markCccEffectReceiptDispatched(first, committed);
    await commitCccEffectReceipt(first, committed);

    const reopened = await CliSessionStore.create(h.layer(), "project-a");
    expect(await hasCccEffectReceipt(reopened, {
      ...committed,
      toolCallId: "provider-request-after-restart",
    })).toBe(true);
  });

  it("rejects non-JSON arguments and distinguishes undefined from string undefined", () => {
    const input = {
      sessionId: "cli-pg-non-json",
      toolCallId: "provider-call-non-json",
      controllerToken: "controller-non-json",
      toolName: "commit_synthetic_effect",
      arguments: { target: undefined, __fusion_effect: { key: "effect-non-json" } },
    };
    expect(() => cccEffectReceiptIdentity(input)).toThrow(/JSON|undefined|canonical/i);
    expect(() => cccEffectReceiptIdentity({ ...input, arguments: { target: "undefined", __fusion_effect: { key: "effect-non-json" } } })).not.toThrow();
  });

  it("stale independent CliSessionStore posture flush cannot erase authoritative receipt state", async () => {
    const bootstrap = await CliSessionStore.create(h.layer(), "project-a");
    bootstrap.createSession({
      id: "cli-pg-stale-posture",
      projectId: "project-a",
      adapterId: "pi",
      purpose: "execute",
      taskId: "FN-CCC-STALE-POSTURE",
      autonomyPosture: { cccFusionProfile: "ccc-fusion" },
    });
    await bootstrap.flush();
    const authoritative = await CliSessionStore.create(h.layer(), "project-a");
    const stale = await CliSessionStore.create(h.layer(), "project-a");
    const input = {
      sessionId: "cli-pg-stale-posture",
      toolCallId: "provider-call-stale",
      controllerToken: "controller-stale",
      toolName: "commit_synthetic_effect",
      arguments: { target: "loopback", __fusion_effect: { key: "effect-stale" } },
    };
    await reserveCccEffectReceipt(authoritative, input);
    await markCccEffectReceiptDispatched(authoritative, input);
    await commitCccEffectReceipt(authoritative, input);
    stale.updateSession(input.sessionId, { autonomyPosture: { unrelated: "stale-cache-write" } });
    await stale.flush();

    expect(await hasCccEffectReceipt(await CliSessionStore.create(h.layer(), "project-a"), input)).toBe(true);
  });

  it("fresh baseline exposes the dedicated v2 receipt table", async () => {
    const rows = await h.layer().db.execute(sql`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'project' AND table_name = 'ccc_effect_receipts'
    `) as unknown as Array<{ table_name: string }>;
    expect(rows.map((row) => row.table_name)).toEqual(["ccc_effect_receipts"]);
  });

  it("surfaces a queued PostgreSQL write failure at every durability boundary", async () => {
    /*
    FNXC:CliAgentPostgresDurability 2026-07-14-19:00:
    Session mutations are synchronous for event-driven callers, but a rejected queued write must remain observable at flush instead of becoming an unhandled rejection or a false durability success.
    */
    const layer = h.layer();
    const store = await CliSessionStore.create(layer, "project-a");
    const failure = new Error("forced queued write failure");
    const insert = vi.spyOn(layer.db, "insert").mockImplementationOnce(() => ({
      values: () => Promise.reject(failure),
    }) as never);
    try {
      store.createSession({
        id: "cli-pg-write-failure",
        projectId: "project-a",
        adapterId: "codex",
        purpose: "execute",
      });

      await expect(store.flush()).rejects.toBe(failure);
      await expect(store.flush()).rejects.toBe(failure);
      expect(store.getSession("cli-pg-write-failure")).toBeDefined();
    } finally {
      insert.mockRestore();
    }
  });
});
