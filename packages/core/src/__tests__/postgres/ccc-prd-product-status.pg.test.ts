import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import {
  beginCccCampaignProofAttemptDispatch,
  claimCccCampaignApproval,
  consumeCccCampaignApprovalWithinTransaction,
  createCccCampaignAuthorityBinding,
  importCccPrdBundle,
  issueCccCampaignApproval,
  recordRunAuditEventWithinTransaction,
  reserveCccCampaignProofAttempt,
  settleCccCampaignProofAttempt,
} from "../../index.js";
import {
  createCccPrdImportTestBundle,
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
  const codingTask = source.tasks[0]!;
  return rehashCccPrdImportTestBundle({
    ...source,
    tasks: source.tasks.map((task) =>
      task.id === codingTask.id
        ? { ...task, protectedActionIds: [LIVE_EXECUTION_ACTION.actionId] }
        : task),
    protectedActions: [{
      id: LIVE_EXECUTION_ACTION.actionId,
      kind: "live_execution",
      target: LIVE_EXECUTION_ACTION.actionTarget,
      operatorDecision: "approve_live_execution",
      requiresOperatorDecision: true,
      spans: [codingTask.spans[0]!],
    }],
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
    const source = createCccPrdImportTestBundle(
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
    const source = createCccPrdImportTestBundle(
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
    const reserved = await h.store().reserveCccProviderAttempt({
      taskId,
      actionId: taskId,
      actionTarget: h.rootDir(),
      turnKey: "turn-product-status-provider-unknown",
      dispatchKey: "dispatch-product-status-provider-unknown",
      providerId: "deterministic-fake",
      modelId: "fixture-v2",
      transport: "pi",
    });
    await h.store().beginCccProviderAttemptDispatch({
      taskId,
      attemptKey: reserved.attemptKey,
      controllerToken: reserved.controllerToken,
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
  });

  it("projects exact live-execution approval and returns to runtime waiting after requeue", async () => {
    const source = withLiveExecutionAction(
      createCccPrdImportTestBundle(h.rootDir(), "product-status-live"),
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
    const issued = await issueCccCampaignApproval(h.layer(), {
      authorityStore: h.store(),
      rootDir: h.rootDir(),
      taskId: codingTaskId,
      action: LIVE_EXECUTION_ACTION,
      requester: {
        actorId: "runtime-product-status-live",
        actorType: "agent",
        actorName: "Runtime",
      },
      runId: "product-status-live-issue",
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

    await expect(inspectCccPrdProductStatus({
      idempotencyKey: "product-status-live",
      layer: h.layer(),
      rootDir: h.rootDir(),
    })).resolves.toMatchObject({
      workItems: [{
        id: workItem.id,
        state: "manual-required",
        lastError: LIVE_EXECUTION_APPROVAL_REQUIRED,
        blockedReason: LIVE_EXECUTION_APPROVAL_REQUIRED,
      }],
      approvals: [{
        id: issued.id,
        status: "issued",
        actionId: LIVE_EXECUTION_ACTION.actionId,
        actionTarget: LIVE_EXECUTION_ACTION.actionTarget,
      }],
      nextAction: {
        kind: "approve-execution",
        approvalRequestId: issued.id,
        approvalStatus: "issued",
      },
    });

    await claimCccCampaignApproval(h.layer(), {
      authorityStore: h.store(),
      rootDir: h.rootDir(),
      taskId: codingTaskId,
      action: LIVE_EXECUTION_ACTION,
      claimant: {
        actorId: "operator-product-status-live",
        actorType: "user",
        actorName: "Operator",
      },
      runId: "product-status-live-claim",
      claimToken: "product-status-live-claim-token",
    });
    await expect(inspectCccPrdProductStatus({
      idempotencyKey: "product-status-live",
      layer: h.layer(),
      rootDir: h.rootDir(),
    })).resolves.toMatchObject({
      workItems: [{
        id: workItem.id,
        state: "manual-required",
      }],
      approvals: [{
        id: issued.id,
        status: "claimed",
      }],
      nextAction: {
        kind: "approve-execution",
        approvalRequestId: issued.id,
        approvalStatus: "claimed",
      },
    });

    await h.store().transitionWorkflowWorkItem(workItem.id, "runnable", {
      expectedState: "manual-required",
      expectedAttempt: 1,
      attempt: 1,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: null,
      blockedReason: null,
    });

    await expect(inspectCccPrdProductStatus({
      idempotencyKey: "product-status-live",
      layer: h.layer(),
      rootDir: h.rootDir(),
    })).resolves.toMatchObject({
      workItems: [{
        id: workItem.id,
        state: "runnable",
        lastError: null,
        blockedReason: null,
      }],
      approvals: [{
        id: issued.id,
        status: "claimed",
        actionId: LIVE_EXECUTION_ACTION.actionId,
        actionTarget: LIVE_EXECUTION_ACTION.actionTarget,
      }],
      nextAction: { kind: "wait-for-runtime" },
    });
  });

  it("returns a deterministic, redacted, import-scoped operator snapshot", async () => {
    const source = withMergeAction(
      createCccPrdImportTestBundle(h.rootDir(), "product-status"),
    );
    const imported = await importCccPrdBundle({
      bundle: source,
      executionPolicy: createCccPrdImportTestProductExecutionPolicy(source),
      idempotencyKey: "product-status-primary",
      store: h.store(),
      layer: h.layer(),
      rootDir: h.rootDir(),
    });
    const other = createCccPrdImportTestBundle(h.rootDir(), "product-status-other");
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
