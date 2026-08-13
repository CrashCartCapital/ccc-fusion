import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { importCccPrdBundle } from "../../index.js";
import {
  claimCccCampaignApproval,
  consumeCccCampaignApproval,
  denyCccCampaignApproval,
} from "../../async-approval-request-store.js";
import { createCccCampaignAuthorityBinding } from "../../ccc-campaign/canonical.js";
import { recordRunAuditEventWithinTransaction } from "../../postgres/data-layer.js";
import * as schema from "../../postgres/schema/index.js";
import type { CccCampaignAuthorityStore } from "../../ccc-campaign/store.js";
import {
  claimCccCampaignExecutionAuthorization,
  closeUnopenedCccCampaignExecutionAuthorizationMembers,
  getCccCampaignExecutionAuthorization,
  issueCccCampaignExecutionAuthorization,
} from "../../ccc-campaign/execution-authorization.js";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
} from "../../__test-utils__/pg-test-harness.js";
import {
  createCccPrdImportTestProductBundle,
  createCccPrdImportTestProductExecutionPolicy,
  rehashCccPrdImportTestBundle,
} from "../../__test-utils__/ccc-prd-import-fixture.js";
import type { ApprovalRequestActorSnapshot } from "../../types.js";
import type {
  CccProviderAttemptRequest,
  CccProviderAttemptSettlementInput,
  CccProviderAttemptTransition,
} from "../../ccc-campaign/types.js";

const REQUESTER: ApprovalRequestActorSnapshot = Object.freeze({
  actorId: "ccc-campaign-runtime",
  actorType: "agent",
  actorName: "CCC Campaign Runtime",
});
const OPERATOR: ApprovalRequestActorSnapshot = Object.freeze({
  actorId: "operator-sealed-launch",
  actorType: "user",
  actorName: "Sealed Launch Operator",
});

pgDescribe("CCC sealed execution authorization (PostgreSQL)", () => {
  const h = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_ccc_execution_authorization",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  async function fixture(
    suffix: string,
    options: Readonly<{ maxDurationMs?: number }> = {},
  ) {
    const source = createCccPrdImportTestProductBundle(h.rootDir(), suffix);
    const actions = source.tasks.map((task, index) => ({
      id: `ACTION-${suffix}-LIVE-${index}`,
      kind: "live_execution" as const,
      target: `provider://${suffix}/task-${index}`,
      requiresOperatorDecision: true as const,
      operatorDecision: "approve_live_execution" as const,
      spans: [task.spans[0]!],
    }));
    const bundle = rehashCccPrdImportTestBundle({
      ...source,
      bounds: {
        ...source.bounds,
        maxRequests: 4,
        maxConcurrency: 2,
        maxDurationMs: options.maxDurationMs ?? source.bounds.maxDurationMs,
      },
      tasks: source.tasks.map((task, index) => ({
        ...task,
        protectedActionIds: [actions[index]!.id],
      })),
      protectedActions: actions,
    });
    const imported = await importCccPrdBundle({
      bundle,
      executionPolicy: createCccPrdImportTestProductExecutionPolicy(bundle),
      idempotencyKey: `sealed-execution-authorization-${suffix}`,
      store: h.store(),
      layer: h.layer(),
      rootDir: h.rootDir(),
    });
    const rows = await h.layer().db.execute(sql`
      SELECT entity_id, native_id
      FROM project.ccc_prd_import_entities
      WHERE import_id = ${imported.importId}
        AND entity_type = 'task'
      ORDER BY ordinal
    `) as unknown as Array<{ entity_id: string; native_id: string }>;
    expect(rows).toHaveLength(2);
    const firstContext = await h.store().getCccCampaignContextForTask(rows[0]!.native_id);
    if (!firstContext) throw new Error("missing sealed campaign context");
    return {
      imported,
      taskIds: rows.map(({ native_id }) => native_id),
      actions,
      campaignStartedAt: firstContext.campaignStartedAt,
      campaignDeadlineAt: firstContext.campaignDeadlineAt,
    };
  }

  function providerRequest(
    campaign: Awaited<ReturnType<typeof fixture>>,
    memberIndex: number,
    turnKey: string,
  ): CccProviderAttemptRequest {
    const taskId = campaign.taskIds[memberIndex]!;
    const action = campaign.actions[memberIndex]!;
    return {
      taskId,
      actionId: action.id,
      actionTarget: action.target,
      turnKey,
      dispatchKey: `dispatch-${turnKey}`,
      providerId: "deterministic-fake",
      modelId: "fixture-v2",
      transport: "pi",
      workItemFence: {
        workItemId: `work-item-${turnKey}`,
        runId: `run-${turnKey}`,
        attempt: 1,
      },
    };
  }

  function authorityProxy(
    getContext: CccCampaignAuthorityStore["getCccCampaignContextForTaskWithinTransaction"],
  ): CccCampaignAuthorityStore {
    return {
      getCccCampaignContextForTaskWithinTransaction: getContext,
      claimCccCampaignActionLease: (...args) =>
        h.store().claimCccCampaignActionLease(...args),
      inspectCccCampaignActionLease: (...args) =>
        h.store().inspectCccCampaignActionLease(...args),
      settleCccCampaignActionLease: (...args) =>
        h.store().settleCccCampaignActionLease(...args),
    };
  }

  it("RED-S2-persistence: either task issues one parent and one claim atomically unlocks every exact child", async () => {
    const campaign = await fixture("atomic");
    const issue = (taskId: string) => issueCccCampaignExecutionAuthorization(h.layer(), {
      authorityStore: h.store(),
      rootDir: h.rootDir(),
      taskId,
      requester: REQUESTER,
      notBeforeAt: campaign.campaignStartedAt,
      expiresAt: campaign.campaignDeadlineAt,
    });

    const fromFirst = await issue(campaign.taskIds[0]!);
    const fromSecond = await issue(campaign.taskIds[1]!);
    expect(fromSecond).toEqual(fromFirst);
    expect(fromFirst).toMatchObject({
      status: "issued",
      importId: campaign.imported.importId,
      expectedRequestCount: 0,
      members: [
        { ordinal: 0, nativeTaskId: campaign.taskIds[0]!, approvalRequestId: expect.any(String) },
        { ordinal: 1, nativeTaskId: campaign.taskIds[1]!, approvalRequestId: expect.any(String) },
      ],
    });
    expect(new Set(fromFirst.members.map(({ approvalRequestId }) => approvalRequestId)).size)
      .toBe(2);
    for (const [index, taskId] of campaign.taskIds.entries()) {
      await expect(h.store().inspectCccCampaignActionLease(taskId, {
        actionId: campaign.actions[index]!.id,
        actionTarget: campaign.actions[index]!.target,
      })).resolves.toBeNull();
    }

    const claimed = await claimCccCampaignExecutionAuthorization(h.layer(), {
      authorityStore: h.store(),
      rootDir: h.rootDir(),
      authorizationId: fromFirst.authorizationId,
      claimant: OPERATOR,
      claimToken: "sealed-parent-claim-token",
    });
    expect(claimed.status).toBe("claimed");
    await expect(getCccCampaignExecutionAuthorization(
      h.layer().db,
      fromFirst.authorizationId,
    )).resolves.toEqual(claimed);
    for (const [index, taskId] of campaign.taskIds.entries()) {
      const member = claimed.members[index]!;
      await expect(h.store().inspectCccCampaignActionLease(taskId, {
        actionId: campaign.actions[index]!.id,
        actionTarget: campaign.actions[index]!.target,
      })).resolves.toMatchObject({
        binding: { bindingHash: member.bindingHash },
        lease: {
          approvalRequestId: member.approvalRequestId,
          bindingHash: member.bindingHash,
          claimToken: expect.any(String),
        },
      });
    }
    const counts = await h.layer().db.execute(sql`
      SELECT
        (SELECT count(*)::int FROM project.ccc_campaign_execution_authorizations) AS parents,
        (SELECT count(*)::int FROM project.ccc_campaign_execution_authorization_members) AS members,
        (SELECT count(*)::int FROM project.approval_requests WHERE campaign_import_id = ${campaign.imported.importId}) AS children,
        (SELECT count(*)::int FROM project.run_audit_events
          WHERE campaign_import_id = ${campaign.imported.importId}
            AND mutation_type LIKE 'ccc-campaign:provider-attempt:%') AS attempts
    `) as unknown as Array<{
      parents: number;
      members: number;
      children: number;
      attempts: number;
    }>;
    expect(counts).toEqual([{ parents: 1, members: 2, children: 2, attempts: 0 }]);

    for (const [index, taskId] of campaign.taskIds.entries()) {
      const member = claimed.members[index]!;
      const lease = await h.store().inspectCccCampaignActionLease(taskId, {
        actionId: campaign.actions[index]!.id,
        actionTarget: campaign.actions[index]!.target,
      });
      if (!lease) throw new Error(`missing child lease for ${taskId}`);
      await consumeCccCampaignApproval(h.layer(), {
        authorityStore: h.store(),
        rootDir: h.rootDir(),
        taskId,
        action: {
          actionId: campaign.actions[index]!.id,
          actionTarget: campaign.actions[index]!.target,
        },
        actor: OPERATOR,
        claimToken: lease.lease.claimToken,
        runId: `sealed-child-consume:${member.approvalRequestId}`,
      });
      await expect(getCccCampaignExecutionAuthorization(
        h.layer().db,
        claimed.authorizationId,
      )).resolves.toMatchObject({
        status: index === campaign.taskIds.length - 1 ? "settled" : "claimed",
      });
    }
  });

  it("RED-S2-child-bypass: a sealed child cannot be claimed or denied outside its parent transition", async () => {
    const campaign = await fixture("sealed-child-bypass");
    const issued = await issueCccCampaignExecutionAuthorization(h.layer(), {
      authorityStore: h.store(),
      rootDir: h.rootDir(),
      taskId: campaign.taskIds[0]!,
      requester: REQUESTER,
      notBeforeAt: campaign.campaignStartedAt,
      expiresAt: campaign.campaignDeadlineAt,
    });
    const action = {
      actionId: campaign.actions[0]!.id,
      actionTarget: campaign.actions[0]!.target,
    };

    await expect(claimCccCampaignApproval(h.layer(), {
      authorityStore: h.store(),
      rootDir: h.rootDir(),
      taskId: campaign.taskIds[0]!,
      action,
      claimant: OPERATOR,
      runId: "sealed-child-bypass-claim",
      claimToken: "forged-individual-child-token",
    })).rejects.toThrow(/sealed.*parent|parent.*authorization/u);
    await expect(denyCccCampaignApproval(h.layer(), {
      authorityStore: h.store(),
      rootDir: h.rootDir(),
      taskId: campaign.taskIds[0]!,
      action,
      actor: OPERATOR,
      runId: "sealed-child-bypass-deny",
    })).rejects.toThrow(/sealed.*parent|parent.*authorization/u);
    await expect(getCccCampaignExecutionAuthorization(
      h.layer().db,
      issued.authorizationId,
    )).resolves.toMatchObject({ status: "issued" });
    const children = await h.layer().db.execute(sql`
      SELECT status, claim_token
      FROM project.approval_requests
      WHERE campaign_import_id = ${campaign.imported.importId}
      ORDER BY id
    `) as unknown as Array<{ status: string; claim_token: string | null }>;
    expect(children).toEqual([
      { status: "issued", claim_token: null },
      { status: "issued", claim_token: null },
    ]);
  });

  it("RED-S2-ledger-custody: parent issuance refuses a request counter with no exact reservation history", async () => {
    const campaign = await fixture("issue-ledger-drift");
    await h.layer().db.execute(sql`
      UPDATE project.ccc_prd_imports
      SET request_count = 1
      WHERE import_id = ${campaign.imported.importId}
    `);

    await expect(issueCccCampaignExecutionAuthorization(h.layer(), {
      authorityStore: h.store(),
      rootDir: h.rootDir(),
      taskId: campaign.taskIds[0]!,
      requester: REQUESTER,
      notBeforeAt: campaign.campaignStartedAt,
      expiresAt: campaign.campaignDeadlineAt,
    })).rejects.toThrow(/request.*history|ledger|request count/u);
    const counts = await h.layer().db.execute(sql`
      SELECT
        (SELECT count(*)::int FROM project.ccc_campaign_execution_authorizations) AS parents,
        (SELECT count(*)::int FROM project.approval_requests
          WHERE campaign_import_id = ${campaign.imported.importId}) AS children
    `) as unknown as Array<{ parents: number; children: number }>;
    expect(counts).toEqual([{ parents: 0, children: 0 }]);
  });

  it("RED-S2-unresolved-custody: parent issuance refuses an unresolved reservation even when its counter is consistent", async () => {
    const campaign = await fixture("issue-unresolved-reservation");
    const taskId = campaign.taskIds[0]!;
    const context = await h.store().getCccCampaignContextForTask(taskId);
    if (!context) throw new Error("missing unresolved issuance context");
    const binding = createCccCampaignAuthorityBinding(context, {
      actionId: campaign.actions[0]!.id,
      actionTarget: campaign.actions[0]!.target,
    });
    const attemptKey = `ccc-provider-attempt-${"a".repeat(64)}`;
    await h.layer().transactionImmediate((tx) => recordRunAuditEventWithinTransaction(tx, {
      timestamp: new Date().toISOString(),
      taskId,
      agentId: "ccc-provider-attempt",
      runId: `ccc-provider-attempt:${attemptKey}`,
      domain: "database",
      mutationType: "ccc-campaign:provider-attempt:reserved",
      target: binding.actionTarget,
      metadata: {
        schema: "ccc-campaign.provider-attempt.v4",
        attemptKey,
        controllerToken: "ccc-provider-controller-00000000-0000-4000-8000-000000000000",
        semanticTaskId: context.semanticTaskId,
        campaignDeadlineAt: context.campaignDeadlineAt,
        turnKey: "preapproval-reserved-turn",
        dispatchKey: "preapproval-reserved-dispatch",
        attemptOrdinal: 1,
        requestCount: 1,
        workItemFence: {
          workItemId: "preapproval-work-item",
          runId: "preapproval-run",
          attempt: 1,
        },
        bindingHash: binding.bindingHash,
        stageOrdinal: 1,
        state: "reserved",
      },
      campaign: {
        eventKey: `${attemptKey}:reserved`,
        binding,
      },
    }));
    await h.layer().db.execute(sql`
      UPDATE project.ccc_prd_imports
      SET request_count = 1
      WHERE import_id = ${campaign.imported.importId}
    `);

    await expect(issueCccCampaignExecutionAuthorization(h.layer(), {
      authorityStore: h.store(),
      rootDir: h.rootDir(),
      taskId,
      requester: REQUESTER,
      notBeforeAt: campaign.campaignStartedAt,
      expiresAt: campaign.campaignDeadlineAt,
    })).rejects.toThrow(/unresolved.*provider|provider.*unresolved/u);
    const counts = await h.layer().db.execute(sql`
      SELECT
        (SELECT count(*)::int FROM project.ccc_campaign_execution_authorizations) AS parents,
        (SELECT count(*)::int FROM project.approval_requests
          WHERE campaign_import_id = ${campaign.imported.importId}) AS children
    `) as unknown as Array<{ parents: number; children: number }>;
    expect(counts).toEqual([{ parents: 0, children: 0 }]);
  });

  it("RED-S2-unknown-dispatch-custody: parent issuance refuses an unresolved dispatched effect", async () => {
    const campaign = await fixture("issue-dispatched-unknown");
    const taskId = campaign.taskIds[0]!;
    const context = await h.store().getCccCampaignContextForTask(taskId);
    if (!context) throw new Error("missing dispatched-unknown issuance context");
    const binding = createCccCampaignAuthorityBinding(context, {
      actionId: campaign.actions[0]!.id,
      actionTarget: campaign.actions[0]!.target,
    });
    const attemptKey = `ccc-provider-attempt-${"b".repeat(64)}`;
    const timestamp = new Date().toISOString();
    await h.layer().transactionImmediate(async (tx) => {
      await recordRunAuditEventWithinTransaction(tx, {
        timestamp,
        taskId,
        agentId: "ccc-provider-attempt",
        runId: `ccc-provider-attempt:${attemptKey}`,
        domain: "database",
        mutationType: "ccc-campaign:provider-attempt:reserved",
        target: binding.actionTarget,
        metadata: {
          schema: "ccc-campaign.provider-attempt.v4",
          attemptKey,
          controllerToken: "ccc-provider-controller-00000000-0000-4000-8000-000000000001",
          semanticTaskId: context.semanticTaskId,
          campaignDeadlineAt: context.campaignDeadlineAt,
          turnKey: "preapproval-unknown-turn",
          dispatchKey: "preapproval-unknown-dispatch",
          attemptOrdinal: 1,
          requestCount: 1,
          workItemFence: {
            workItemId: "preapproval-unknown-work-item",
            runId: "preapproval-unknown-run",
            attempt: 1,
          },
          bindingHash: binding.bindingHash,
          stageOrdinal: 1,
          state: "reserved",
        },
        campaign: {
          eventKey: `${attemptKey}:reserved`,
          binding,
        },
      });
      await recordRunAuditEventWithinTransaction(tx, {
        timestamp,
        taskId,
        agentId: "ccc-provider-attempt",
        runId: `ccc-provider-attempt:${attemptKey}`,
        domain: "database",
        mutationType: "ccc-campaign:provider-attempt:dispatched",
        target: binding.actionTarget,
        metadata: {
          schema: "ccc-campaign.provider-attempt.v4",
          attemptKey,
          controllerToken: "ccc-provider-controller-00000000-0000-4000-8000-000000000001",
          semanticTaskId: context.semanticTaskId,
          campaignDeadlineAt: context.campaignDeadlineAt,
          turnKey: "preapproval-unknown-turn",
          dispatchKey: "preapproval-unknown-dispatch",
          attemptOrdinal: 1,
          requestCount: 1,
          workItemFence: {
            workItemId: "preapproval-unknown-work-item",
            runId: "preapproval-unknown-run",
            attempt: 1,
          },
          bindingHash: binding.bindingHash,
          stageOrdinal: 2,
          state: "dispatched_unknown",
        },
        campaign: {
          eventKey: `${attemptKey}:dispatched`,
          binding,
        },
      });
    });
    await h.layer().db.execute(sql`
      UPDATE project.ccc_prd_imports
      SET request_count = 1
      WHERE import_id = ${campaign.imported.importId}
    `);

    await expect(issueCccCampaignExecutionAuthorization(h.layer(), {
      authorityStore: h.store(),
      rootDir: h.rootDir(),
      taskId,
      requester: REQUESTER,
      notBeforeAt: campaign.campaignStartedAt,
      expiresAt: campaign.campaignDeadlineAt,
    })).rejects.toThrow(/unresolved.*provider|provider.*unresolved/u);
    const counts = await h.layer().db.execute(sql`
      SELECT
        (SELECT count(*)::int FROM project.ccc_campaign_execution_authorizations) AS parents,
        (SELECT count(*)::int FROM project.approval_requests
          WHERE campaign_import_id = ${campaign.imported.importId}) AS children
    `) as unknown as Array<{ parents: number; children: number }>;
    expect(counts).toEqual([{ parents: 0, children: 0 }]);
  });

  it("RED-S2-rollback: an intermediate child-claim fault rolls back the parent, children, and every lease", async () => {
    const campaign = await fixture("rollback");
    const parent = await issueCccCampaignExecutionAuthorization(h.layer(), {
      authorityStore: h.store(),
      rootDir: h.rootDir(),
      taskId: campaign.taskIds[0]!,
      requester: REQUESTER,
      notBeforeAt: campaign.campaignStartedAt,
      expiresAt: campaign.campaignDeadlineAt,
    });
    await h.layer().db.execute(sql`
      CREATE OR REPLACE FUNCTION project.ccc_test_refuse_second_child_claim()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $function$
      BEGIN
        IF OLD.status = 'issued' AND NEW.status = 'claimed' THEN
          IF current_setting('ccc.test_claim_count', true) = '1' THEN
            RAISE EXCEPTION 'injected second child claim failure';
          END IF;
          PERFORM set_config('ccc.test_claim_count', '1', true);
        END IF;
        RETURN NEW;
      END;
      $function$
    `);
    await h.layer().db.execute(sql`
      CREATE TRIGGER ccc_test_refuse_second_child_claim
      BEFORE UPDATE ON project.approval_requests
      FOR EACH ROW EXECUTE FUNCTION project.ccc_test_refuse_second_child_claim()
    `);
    try {
      await expect(claimCccCampaignExecutionAuthorization(h.layer(), {
        authorityStore: h.store(),
        rootDir: h.rootDir(),
        authorizationId: parent.authorizationId,
        claimant: OPERATOR,
        claimToken: "sealed-parent-failing-token",
      })).rejects.toThrow(/update .*approval_requests|second child claim failure/iu);
    } finally {
      await h.layer().db.execute(sql`
        DROP TRIGGER IF EXISTS ccc_test_refuse_second_child_claim
        ON project.approval_requests
      `);
      await h.layer().db.execute(sql`
        DROP FUNCTION IF EXISTS project.ccc_test_refuse_second_child_claim()
      `);
    }
    const rolledBackParent = await getCccCampaignExecutionAuthorization(
      h.layer().db,
      parent.authorizationId,
    );
    expect(rolledBackParent).toMatchObject({ status: "issued" });
    expect(rolledBackParent).not.toHaveProperty("claimToken");
    const children = await h.layer().db.execute(sql`
      SELECT id, status, claim_token
      FROM project.approval_requests
      WHERE campaign_import_id = ${campaign.imported.importId}
      ORDER BY id
    `) as unknown as Array<{ id: string; status: string; claim_token: string | null }>;
    expect(children).toHaveLength(2);
    expect(children.map(({ status, claim_token }) => ({ status, claimToken: claim_token })))
      .toEqual([
        { status: "issued", claimToken: null },
        { status: "issued", claimToken: null },
      ]);
    for (const [index, taskId] of campaign.taskIds.entries()) {
      await expect(h.store().inspectCccCampaignActionLease(taskId, {
        actionId: campaign.actions[index]!.id,
        actionTarget: campaign.actions[index]!.target,
      })).resolves.toBeNull();
    }
  });

  it("RED-S3-concurrency: distinct parent claim tokens race to one coherent winner", async () => {
    const campaign = await fixture("concurrent-distinct-claims");
    const issued = await issueCccCampaignExecutionAuthorization(h.layer(), {
      authorityStore: h.store(),
      rootDir: h.rootDir(),
      taskId: campaign.taskIds[0]!,
      requester: REQUESTER,
      notBeforeAt: campaign.campaignStartedAt,
      expiresAt: campaign.campaignDeadlineAt,
    });
    const claim = (claimToken: string) => claimCccCampaignExecutionAuthorization(h.layer(), {
      authorityStore: h.store(),
      rootDir: h.rootDir(),
      authorizationId: issued.authorizationId,
      claimant: OPERATOR,
      claimToken,
    });

    const outcomes = await Promise.allSettled([
      claim("sealed-parent-concurrent-token-a"),
      claim("sealed-parent-concurrent-token-b"),
    ]);
    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === "rejected")).toHaveLength(1);
    const winner = outcomes.find(({ status }) => status === "fulfilled");
    if (!winner || winner.status !== "fulfilled") throw new Error("missing claim winner");
    const persisted = await getCccCampaignExecutionAuthorization(
      h.layer().db,
      issued.authorizationId,
    );
    expect(persisted).toEqual(winner.value);
    expect(persisted).toMatchObject({ status: "claimed", claimToken: expect.any(String) });
    const children = await h.layer().db.execute(sql`
      SELECT status, claim_token
      FROM project.approval_requests
      WHERE campaign_import_id = ${campaign.imported.importId}
      ORDER BY id
    `) as unknown as Array<{ status: string; claim_token: string | null }>;
    expect(children).toHaveLength(2);
    expect(children.every(({ status, claim_token }) =>
      status === "claimed" && typeof claim_token === "string")).toBe(true);
    for (const [index, taskId] of campaign.taskIds.entries()) {
      await expect(h.store().inspectCccCampaignActionLease(taskId, {
        actionId: campaign.actions[index]!.id,
        actionTarget: campaign.actions[index]!.target,
      })).resolves.toMatchObject({
        lease: { approvalRequestId: issued.members[index]!.approvalRequestId },
      });
    }
  });

  it("RED-S3-lock-order: issue replay holding the import cannot deadlock a concurrent parent claim", async () => {
    const campaign = await fixture("issue-claim-lock-order");
    const issued = await issueCccCampaignExecutionAuthorization(h.layer(), {
      authorityStore: h.store(),
      rootDir: h.rootDir(),
      taskId: campaign.taskIds[0]!,
      requester: REQUESTER,
      notBeforeAt: campaign.campaignStartedAt,
      expiresAt: campaign.campaignDeadlineAt,
    });
    let signalIssueImportLocked!: () => void;
    const issueImportLocked = new Promise<void>((resolve) => {
      signalIssueImportLocked = resolve;
    });
    let releaseIssue!: () => void;
    const issueGate = new Promise<void>((resolve) => {
      releaseIssue = resolve;
    });
    let firstContextRead = true;
    const delayedIssueStore = authorityProxy(async (tx, taskId) => {
      const context = await h.store().getCccCampaignContextForTaskWithinTransaction(tx, taskId);
      if (firstContextRead) {
        firstContextRead = false;
        signalIssueImportLocked();
        await issueGate;
      }
      return context;
    });
    const replay = issueCccCampaignExecutionAuthorization(h.layer(), {
      authorityStore: delayedIssueStore,
      rootDir: h.rootDir(),
      taskId: campaign.taskIds[1]!,
      requester: REQUESTER,
      notBeforeAt: campaign.campaignStartedAt,
      expiresAt: campaign.campaignDeadlineAt,
    });
    await issueImportLocked;
    const claim = claimCccCampaignExecutionAuthorization(h.layer(), {
      authorityStore: h.store(),
      rootDir: h.rootDir(),
      authorizationId: issued.authorizationId,
      claimant: OPERATOR,
      claimToken: "sealed-parent-lock-order-token",
    });
    const releaseTimer = setTimeout(releaseIssue, 75);
    const outcomes = await Promise.allSettled([replay, claim]);
    clearTimeout(releaseTimer);

    expect(outcomes).toHaveLength(2);
    expect(outcomes.every(({ status }) => status === "fulfilled")).toBe(true);
    await expect(getCccCampaignExecutionAuthorization(
      h.layer().db,
      issued.authorizationId,
    )).resolves.toMatchObject({ status: "claimed" });
  });

  it("RED-S3-attempt-fence: a changed work-item attempt does not invalidate the immutable parent", async () => {
    const campaign = await fixture("changed-attempt");
    const issued = await issueCccCampaignExecutionAuthorization(h.layer(), {
      authorityStore: h.store(),
      rootDir: h.rootDir(),
      taskId: campaign.taskIds[0]!,
      requester: REQUESTER,
      notBeforeAt: campaign.campaignStartedAt,
      expiresAt: campaign.campaignDeadlineAt,
    });
    await h.layer().db.execute(sql`
      UPDATE project.workflow_work_items
      SET attempt = attempt + 1,
          updated_at = ${new Date().toISOString()}
      WHERE id = ${issued.workItemId}
    `);

    await expect(claimCccCampaignExecutionAuthorization(h.layer(), {
      authorityStore: h.store(),
      rootDir: h.rootDir(),
      authorizationId: issued.authorizationId,
      claimant: OPERATOR,
      claimToken: "sealed-parent-changed-attempt-token",
    })).resolves.toMatchObject({
      authorizationId: issued.authorizationId,
      status: "claimed",
    });
  });

  it("RED-S3-member-drift: persisted member drift refuses claim before any child or lease mutation", async () => {
    const campaign = await fixture("member-drift");
    const issued = await issueCccCampaignExecutionAuthorization(h.layer(), {
      authorityStore: h.store(),
      rootDir: h.rootDir(),
      taskId: campaign.taskIds[0]!,
      requester: REQUESTER,
      notBeforeAt: campaign.campaignStartedAt,
      expiresAt: campaign.campaignDeadlineAt,
    });
    await h.layer().db.execute(sql`
      UPDATE project.ccc_campaign_execution_authorization_members
      SET model_id = 'drifted-model'
      WHERE authorization_id = ${issued.authorizationId}
        AND ordinal = 1
    `);

    await expect(claimCccCampaignExecutionAuthorization(h.layer(), {
      authorityStore: h.store(),
      rootDir: h.rootDir(),
      authorizationId: issued.authorizationId,
      claimant: OPERATOR,
      claimToken: "sealed-parent-member-drift-token",
    })).rejects.toThrow(/custody drifted/u);
    const parentRows = await h.layer().db.execute(sql`
      SELECT status, claim_token
      FROM project.ccc_campaign_execution_authorizations
      WHERE authorization_id = ${issued.authorizationId}
    `) as unknown as Array<{ status: string; claim_token: string | null }>;
    expect(parentRows).toEqual([{ status: "issued", claim_token: null }]);
    const children = await h.layer().db.execute(sql`
      SELECT status, claim_token
      FROM project.approval_requests
      WHERE campaign_import_id = ${campaign.imported.importId}
      ORDER BY id
    `) as unknown as Array<{ status: string; claim_token: string | null }>;
    expect(children).toEqual([
      { status: "issued", claim_token: null },
      { status: "issued", claim_token: null },
    ]);
  });

  it("RED-S3-claim-cas: changed request count refuses the first parent claim without mutating any child", async () => {
    const campaign = await fixture("request-count-cas");
    const parent = await issueCccCampaignExecutionAuthorization(h.layer(), {
      authorityStore: h.store(),
      rootDir: h.rootDir(),
      taskId: campaign.taskIds[0]!,
      requester: REQUESTER,
      notBeforeAt: campaign.campaignStartedAt,
      expiresAt: campaign.campaignDeadlineAt,
    });
    expect(parent.expectedRequestCount).toBe(0);
    await h.layer().db.execute(sql`
      UPDATE project.ccc_prd_imports
      SET request_count = request_count + 1
      WHERE import_id = ${campaign.imported.importId}
    `);

    await expect(claimCccCampaignExecutionAuthorization(h.layer(), {
      authorityStore: h.store(),
      rootDir: h.rootDir(),
      authorizationId: parent.authorizationId,
      claimant: OPERATOR,
      claimToken: "sealed-parent-stale-count-token",
    })).rejects.toThrow(/request-count compare-and-swap lost/u);
    await expect(getCccCampaignExecutionAuthorization(
      h.layer().db,
      parent.authorizationId,
    )).resolves.toMatchObject({ status: "issued", expectedRequestCount: 0 });
    const children = await h.layer().db.execute(sql`
      SELECT status, claim_token
      FROM project.approval_requests
      WHERE campaign_import_id = ${campaign.imported.importId}
      ORDER BY id
    `) as unknown as Array<{ status: string; claim_token: string | null }>;
    expect(children).toEqual([
      { status: "issued", claim_token: null },
      { status: "issued", claim_token: null },
    ]);
    for (const [index, taskId] of campaign.taskIds.entries()) {
      await expect(h.store().inspectCccCampaignActionLease(taskId, {
        actionId: campaign.actions[index]!.id,
        actionTarget: campaign.actions[index]!.target,
      })).resolves.toBeNull();
    }
  });

  it("RED-S2-restart: claimed issue replay survives an advanced request counter and a restarted authority store", async () => {
    const campaign = await fixture("claimed-replay-after-request");
    const issued = await issueCccCampaignExecutionAuthorization(h.layer(), {
      authorityStore: h.store(),
      rootDir: h.rootDir(),
      taskId: campaign.taskIds[0]!,
      requester: REQUESTER,
      notBeforeAt: campaign.campaignStartedAt,
      expiresAt: campaign.campaignDeadlineAt,
    });
    const claimed = await claimCccCampaignExecutionAuthorization(h.layer(), {
      authorityStore: h.store(),
      rootDir: h.rootDir(),
      authorizationId: issued.authorizationId,
      claimant: OPERATOR,
      claimToken: "sealed-parent-claimed-replay-token",
    });
    await h.layer().db.execute(sql`
      UPDATE project.ccc_prd_imports
      SET request_count = request_count + 1
      WHERE import_id = ${campaign.imported.importId}
    `);
    const { TaskStore } = await import("../../store.js");
    const restarted = new TaskStore(h.rootDir(), undefined, { asyncLayer: h.layer() });

    await expect(issueCccCampaignExecutionAuthorization(h.layer(), {
      authorityStore: restarted,
      rootDir: h.rootDir(),
      taskId: campaign.taskIds[1]!,
      requester: REQUESTER,
      notBeforeAt: campaign.campaignStartedAt,
      expiresAt: campaign.campaignDeadlineAt,
    })).resolves.toEqual(claimed);
    await expect(claimCccCampaignExecutionAuthorization(h.layer(), {
      authorityStore: restarted,
      rootDir: h.rootDir(),
      authorizationId: claimed.authorizationId,
      claimant: OPERATOR,
      claimToken: "sealed-parent-claimed-replay-token",
    })).resolves.toEqual(claimed);
  });

  it("RED-S3-no-effect: terminal cancellation closes every unopened child and settles the parent without inventing an effect", async () => {
    const campaign = await fixture("cancel-unopened");
    const issued = await issueCccCampaignExecutionAuthorization(h.layer(), {
      authorityStore: h.store(),
      rootDir: h.rootDir(),
      taskId: campaign.taskIds[0]!,
      requester: REQUESTER,
      notBeforeAt: campaign.campaignStartedAt,
      expiresAt: campaign.campaignDeadlineAt,
    });
    const claimed = await claimCccCampaignExecutionAuthorization(h.layer(), {
      authorityStore: h.store(),
      rootDir: h.rootDir(),
      authorizationId: issued.authorizationId,
      claimant: OPERATOR,
      claimToken: "sealed-parent-cancel-token",
    });
    await h.layer().db.execute(sql`
      UPDATE project.workflow_work_items
      SET state = 'cancelled',
          last_error = 'workflow-user-cancelled',
          blocked_reason = NULL,
          lease_owner = NULL,
          lease_expires_at = NULL,
          updated_at = ${new Date().toISOString()}
      WHERE id = ${claimed.workItemId}
    `);

    const closed = await closeUnopenedCccCampaignExecutionAuthorizationMembers(h.layer(), {
      authorityStore: h.store(),
      rootDir: h.rootDir(),
      authorizationId: claimed.authorizationId,
      actor: OPERATOR,
      runId: `sealed-cancel-closure:${claimed.authorizationId}`,
    });
    expect(closed).toMatchObject({
      authorization: { status: "settled" },
      openedApprovalRequestIds: [],
    });
    expect([...closed.closedApprovalRequestIds].sort()).toEqual(
      claimed.members.map(({ approvalRequestId }) => approvalRequestId).sort(),
    );
    const children = await h.layer().db.execute(sql`
      SELECT id, status, claim_token
      FROM project.approval_requests
      WHERE campaign_import_id = ${campaign.imported.importId}
      ORDER BY id
    `) as unknown as Array<{ id: string; status: string; claim_token: string | null }>;
    expect(children.map(({ status }) => status)).toEqual(["expired", "expired"]);
    expect(children.every(({ claim_token }) => typeof claim_token === "string")).toBe(true);
    for (const [index, taskId] of campaign.taskIds.entries()) {
      await expect(h.store().inspectCccCampaignActionLease(taskId, {
        actionId: campaign.actions[index]!.id,
        actionTarget: campaign.actions[index]!.target,
      })).resolves.toBeNull();
    }
    const effects = await h.layer().db.execute(sql`
      SELECT mutation_type, metadata
      FROM project.run_audit_events
      WHERE campaign_import_id = ${campaign.imported.importId}
        AND mutation_type IN (
          'ccc-campaign:provider-attempt:reserved',
          'execution-authorization:child-closed-no-effect',
          'execution-authorization:settled'
        )
      ORDER BY mutation_type, id
    `) as unknown as Array<{ mutation_type: string; metadata: Record<string, unknown> }>;
    expect(effects.filter(({ mutation_type }) =>
      mutation_type === "ccc-campaign:provider-attempt:reserved")).toEqual([]);
    expect(effects.filter(({ mutation_type }) =>
      mutation_type === "execution-authorization:child-closed-no-effect")).toHaveLength(2);
    expect(effects.find(({ mutation_type }) =>
      mutation_type === "execution-authorization:settled")?.metadata).toMatchObject({
      terminalSummary: "partial-no-effect",
      consumedMemberCount: 0,
      closedNoEffectMemberCount: 2,
    });
    const { TaskStore } = await import("../../store.js");
    const restarted = new TaskStore(h.rootDir(), undefined, { asyncLayer: h.layer() });
    await expect(closeUnopenedCccCampaignExecutionAuthorizationMembers(h.layer(), {
      authorityStore: restarted,
      rootDir: h.rootDir(),
      authorizationId: claimed.authorizationId,
      actor: OPERATOR,
      runId: `sealed-cancel-closure-replay:${claimed.authorizationId}`,
    })).resolves.toMatchObject({
      authorization: { status: "settled" },
      closedApprovalRequestIds: [],
      openedApprovalRequestIds: [],
    });
  });

  it("RED-S3-upstream-failure: one consumed child plus one unopened downstream child settles as partial no-effect", async () => {
    const campaign = await fixture("upstream-failure-partial");
    const issued = await issueCccCampaignExecutionAuthorization(h.layer(), {
      authorityStore: h.store(),
      rootDir: h.rootDir(),
      taskId: campaign.taskIds[0]!,
      requester: REQUESTER,
      notBeforeAt: campaign.campaignStartedAt,
      expiresAt: campaign.campaignDeadlineAt,
    });
    const claimed = await claimCccCampaignExecutionAuthorization(h.layer(), {
      authorityStore: h.store(),
      rootDir: h.rootDir(),
      authorizationId: issued.authorizationId,
      claimant: OPERATOR,
      claimToken: "sealed-parent-upstream-failure-token",
    });
    const firstLease = await h.store().inspectCccCampaignActionLease(
      campaign.taskIds[0]!,
      {
        actionId: campaign.actions[0]!.id,
        actionTarget: campaign.actions[0]!.target,
      },
    );
    if (!firstLease) throw new Error("missing consumed-child lease");
    await consumeCccCampaignApproval(h.layer(), {
      authorityStore: h.store(),
      rootDir: h.rootDir(),
      taskId: campaign.taskIds[0]!,
      action: {
        actionId: campaign.actions[0]!.id,
        actionTarget: campaign.actions[0]!.target,
      },
      actor: OPERATOR,
      claimToken: firstLease.lease.claimToken,
      runId: `sealed-upstream-consume:${claimed.authorizationId}`,
    });
    await h.layer().db.execute(sql`
      UPDATE project.workflow_work_items
      SET state = 'failed',
          last_error = 'workflow-node-failed:upstream',
          blocked_reason = NULL,
          lease_owner = NULL,
          lease_expires_at = NULL,
          updated_at = ${new Date().toISOString()}
      WHERE id = ${claimed.workItemId}
    `);

    const closed = await closeUnopenedCccCampaignExecutionAuthorizationMembers(h.layer(), {
      authorityStore: h.store(),
      rootDir: h.rootDir(),
      authorizationId: claimed.authorizationId,
      actor: OPERATOR,
      runId: `sealed-upstream-closure:${claimed.authorizationId}`,
    });
    expect(closed).toMatchObject({
      authorization: { status: "settled" },
      openedApprovalRequestIds: [],
      closedApprovalRequestIds: [claimed.members[1]!.approvalRequestId],
    });
    const children = await h.layer().db.execute(sql`
      SELECT id, status
      FROM project.approval_requests
      WHERE campaign_import_id = ${campaign.imported.importId}
      ORDER BY id
    `) as unknown as Array<{ id: string; status: string }>;
    expect(children.find(({ id }) => id === claimed.members[0]!.approvalRequestId)?.status)
      .toBe("consumed");
    expect(children.find(({ id }) => id === claimed.members[1]!.approvalRequestId)?.status)
      .toBe("expired");
    const terminalRows = await h.layer().db.execute(sql`
      SELECT metadata
      FROM project.run_audit_events
      WHERE campaign_import_id = ${campaign.imported.importId}
        AND mutation_type = 'execution-authorization:settled'
    `) as unknown as Array<{ metadata: Record<string, unknown> }>;
    expect(terminalRows).toHaveLength(1);
    expect(terminalRows[0]!.metadata).toMatchObject({
      terminalSummary: "partial-no-effect",
      consumedMemberCount: 1,
      closedNoEffectMemberCount: 1,
    });
  });

  it("RED-S3-deadline: restart-safe closure uses the database deadline when work is otherwise nonterminal", async () => {
    const campaign = await fixture("deadline-unopened", { maxDurationMs: 750 });
    const issued = await issueCccCampaignExecutionAuthorization(h.layer(), {
      authorityStore: h.store(),
      rootDir: h.rootDir(),
      taskId: campaign.taskIds[0]!,
      requester: REQUESTER,
      notBeforeAt: campaign.campaignStartedAt,
      expiresAt: campaign.campaignDeadlineAt,
    });
    const claimed = await claimCccCampaignExecutionAuthorization(h.layer(), {
      authorityStore: h.store(),
      rootDir: h.rootDir(),
      authorizationId: issued.authorizationId,
      claimant: OPERATOR,
      claimToken: "sealed-parent-deadline-token",
    });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, Math.max(0, Date.parse(campaign.campaignDeadlineAt) - Date.now() + 75));
    });
    const { TaskStore } = await import("../../store.js");
    const restarted = new TaskStore(h.rootDir(), undefined, { asyncLayer: h.layer() });

    const closed = await closeUnopenedCccCampaignExecutionAuthorizationMembers(h.layer(), {
      authorityStore: restarted,
      rootDir: h.rootDir(),
      authorizationId: claimed.authorizationId,
      actor: OPERATOR,
      runId: `sealed-deadline-closure:${claimed.authorizationId}`,
    });
    expect(closed).toMatchObject({
      authorization: { status: "settled" },
      openedApprovalRequestIds: [],
    });
    expect(closed.closedApprovalRequestIds).toHaveLength(2);
    const events = await h.layer().db.execute(sql`
      SELECT metadata
      FROM project.run_audit_events
      WHERE campaign_import_id = ${campaign.imported.importId}
        AND mutation_type = 'execution-authorization:child-closed-no-effect'
      ORDER BY id
    `) as unknown as Array<{ metadata: Record<string, unknown> }>;
    expect(events).toHaveLength(2);
    expect(events.every(({ metadata }) => metadata.terminalReason === "campaign-deadline"))
      .toBe(true);
  });

  it("RED-S3-race: provider settlement and no-effect closure converge on one terminal outcome per child", async () => {
    const campaign = await fixture("settlement-closure-race");
    const issued = await issueCccCampaignExecutionAuthorization(h.layer(), {
      authorityStore: h.store(),
      rootDir: h.rootDir(),
      taskId: campaign.taskIds[0]!,
      requester: REQUESTER,
      notBeforeAt: campaign.campaignStartedAt,
      expiresAt: campaign.campaignDeadlineAt,
    });
    const claimed = await claimCccCampaignExecutionAuthorization(h.layer(), {
      authorityStore: h.store(),
      rootDir: h.rootDir(),
      authorizationId: issued.authorizationId,
      claimant: OPERATOR,
      claimToken: "sealed-parent-settlement-race-token",
    });
    const attempt = await h.store().reserveCccProviderAttempt(
      providerRequest(campaign, 0, "settlement-closure-race"),
    );
    const transition: CccProviderAttemptTransition = {
      taskId: attempt.taskId,
      attemptKey: attempt.attemptKey,
      controllerToken: attempt.controllerToken,
    };
    await expect(h.store().beginCccProviderAttemptDispatch(transition)).resolves.toMatchObject({
      kind: "dispatch-permit",
    });
    await h.layer().db.execute(sql`
      UPDATE project.workflow_work_items
      SET state = 'failed',
          last_error = 'workflow-node-failed:upstream-race',
          blocked_reason = NULL,
          lease_owner = NULL,
          lease_expires_at = NULL,
          updated_at = ${new Date().toISOString()}
      WHERE id = ${claimed.workItemId}
    `);
    const settlement: CccProviderAttemptSettlementInput = {
      ...attempt,
      outcome: "committed",
      evidenceDigest: "e".repeat(64),
      observerId: "execution-authorization-race",
    };

    const outcomes = await Promise.allSettled([
      h.store().settleCccProviderAttemptAndApproval(settlement),
      closeUnopenedCccCampaignExecutionAuthorizationMembers(h.layer(), {
        authorityStore: h.store(),
        rootDir: h.rootDir(),
        authorizationId: claimed.authorizationId,
        actor: OPERATOR,
        runId: `sealed-race-closure:${claimed.authorizationId}`,
      }),
    ]);
    expect(outcomes.every(({ status }) => status === "fulfilled")).toBe(true);
    await expect(getCccCampaignExecutionAuthorization(
      h.layer().db,
      claimed.authorizationId,
    )).resolves.toMatchObject({ status: "settled" });
    const children = await h.layer().db.execute(sql`
      SELECT id, status
      FROM project.approval_requests
      WHERE campaign_import_id = ${campaign.imported.importId}
      ORDER BY id
    `) as unknown as Array<{ id: string; status: string }>;
    expect(children.find(({ id }) => id === claimed.members[0]!.approvalRequestId)?.status)
      .toBe("consumed");
    expect(children.find(({ id }) => id === claimed.members[1]!.approvalRequestId)?.status)
      .toBe("expired");
    const terminalRows = await h.layer().db.execute(sql`
      SELECT mutation_type, campaign_binding_hash
      FROM project.run_audit_events
      WHERE campaign_import_id = ${campaign.imported.importId}
        AND mutation_type IN (
          'execution-authorization:child-closed-no-effect',
          'execution-authorization:settled'
        )
      ORDER BY id
    `) as unknown as Array<{ mutation_type: string; campaign_binding_hash: string | null }>;
    expect(terminalRows.filter(({ mutation_type }) =>
      mutation_type === "execution-authorization:settled")).toHaveLength(1);
    expect(terminalRows.some(({ mutation_type, campaign_binding_hash }) =>
      mutation_type === "execution-authorization:child-closed-no-effect"
      && campaign_binding_hash === claimed.members[0]!.bindingHash)).toBe(false);
  });

  it("RED-S3-opened: any durable reservation prevents an authorized child from being misclassified as unopened", async () => {
    const campaign = await fixture("reserved-child");
    const issued = await issueCccCampaignExecutionAuthorization(h.layer(), {
      authorityStore: h.store(),
      rootDir: h.rootDir(),
      taskId: campaign.taskIds[0]!,
      requester: REQUESTER,
      notBeforeAt: campaign.campaignStartedAt,
      expiresAt: campaign.campaignDeadlineAt,
    });
    const claimed = await claimCccCampaignExecutionAuthorization(h.layer(), {
      authorityStore: h.store(),
      rootDir: h.rootDir(),
      authorizationId: issued.authorizationId,
      claimant: OPERATOR,
      claimToken: "sealed-parent-reserved-child-token",
    });
    const openedTaskId = campaign.taskIds[1]!;
    const openedContext = await h.store().getCccCampaignContextForTask(openedTaskId);
    if (!openedContext) throw new Error("missing opened child context");
    const openedBinding = createCccCampaignAuthorityBinding(openedContext, {
      actionId: campaign.actions[1]!.id,
      actionTarget: campaign.actions[1]!.target,
    });
    await h.layer().transactionImmediate((tx) => recordRunAuditEventWithinTransaction(tx, {
      timestamp: new Date().toISOString(),
      taskId: openedTaskId,
      agentId: "ccc-provider-controller",
      runId: "ccc-provider-attempt:reserved-child-fixture",
      domain: "database",
      mutationType: "ccc-campaign:provider-attempt:reserved",
      target: openedBinding.actionTarget,
      metadata: { fixture: "durable-reservation" },
      campaign: {
        eventKey: `ccc-test-provider-reservation:${openedBinding.bindingHash}`,
        binding: openedBinding,
      },
    }));
    await h.layer().db.execute(sql`
      UPDATE project.workflow_work_items
      SET state = 'failed',
          last_error = 'workflow-node-failed:upstream',
          blocked_reason = NULL,
          lease_owner = NULL,
          lease_expires_at = NULL,
          updated_at = ${new Date().toISOString()}
      WHERE id = ${claimed.workItemId}
    `);

    const closed = await closeUnopenedCccCampaignExecutionAuthorizationMembers(h.layer(), {
      authorityStore: h.store(),
      rootDir: h.rootDir(),
      authorizationId: claimed.authorizationId,
      actor: OPERATOR,
      runId: `sealed-failed-closure:${claimed.authorizationId}`,
    });
    expect(closed.authorization.status).toBe("claimed");
    expect(closed.openedApprovalRequestIds).toEqual([
      claimed.members.find(({ nativeTaskId }) => nativeTaskId === openedTaskId)!.approvalRequestId,
    ]);
    expect(closed.closedApprovalRequestIds).toHaveLength(1);
    const openedMember = claimed.members.find(({ nativeTaskId }) => nativeTaskId === openedTaskId)!;
    const childRows = await h.layer().db.execute(sql`
      SELECT id, status
      FROM project.approval_requests
      WHERE campaign_import_id = ${campaign.imported.importId}
      ORDER BY id
    `) as unknown as Array<{ id: string; status: string }>;
    expect(childRows.find(({ id }) => id === openedMember.approvalRequestId)?.status).toBe("claimed");
    expect(childRows.find(({ id }) => id !== openedMember.approvalRequestId)?.status).toBe("expired");
    await expect(h.store().inspectCccCampaignActionLease(openedTaskId, {
      actionId: campaign.actions[1]!.id,
      actionTarget: campaign.actions[1]!.target,
    })).resolves.toMatchObject({
      binding: { bindingHash: openedBinding.bindingHash },
      lease: { approvalRequestId: openedMember.approvalRequestId },
    });
  });

  it("RED-S3-opened-lifecycles: every actual reserved or terminal provider-attempt lifecycle remains opened", async () => {
    for (const lifecycle of [
      "reserved",
      "proved-not-dispatched",
      "dispatched-unknown",
      "proved-failed",
    ] as const) {
      const campaign = await fixture(`opened-${lifecycle}`);
      const issued = await issueCccCampaignExecutionAuthorization(h.layer(), {
        authorityStore: h.store(),
        rootDir: h.rootDir(),
        taskId: campaign.taskIds[0]!,
        requester: REQUESTER,
        notBeforeAt: campaign.campaignStartedAt,
        expiresAt: campaign.campaignDeadlineAt,
      });
      const claimed = await claimCccCampaignExecutionAuthorization(h.layer(), {
        authorityStore: h.store(),
        rootDir: h.rootDir(),
        authorizationId: issued.authorizationId,
        claimant: OPERATOR,
        claimToken: `sealed-parent-opened-${lifecycle}-token`,
      });
      const attempt = await h.store().reserveCccProviderAttempt(
        providerRequest(campaign, 0, `opened-${lifecycle}`),
      );
      const transition: CccProviderAttemptTransition = {
        taskId: attempt.taskId,
        attemptKey: attempt.attemptKey,
        controllerToken: attempt.controllerToken,
      };
      if (lifecycle === "proved-not-dispatched") {
        await h.store().proveCccProviderAttemptNotDispatched(transition);
      } else if (lifecycle === "dispatched-unknown" || lifecycle === "proved-failed") {
        await h.store().beginCccProviderAttemptDispatch(transition);
        if (lifecycle === "proved-failed") {
          await h.store().settleCccProviderAttemptAndApproval({
            ...attempt,
            outcome: "proved_failed",
            evidenceDigest: "f".repeat(64),
            observerId: `execution-authorization-${lifecycle}`,
          });
        }
      }
      await h.layer().db.execute(sql`
        UPDATE project.workflow_work_items
        SET state = 'failed',
            last_error = ${`workflow-node-failed:${lifecycle}`},
            blocked_reason = NULL,
            lease_owner = NULL,
            lease_expires_at = NULL,
            updated_at = ${new Date().toISOString()}
        WHERE id = ${claimed.workItemId}
      `);

      const closed = await closeUnopenedCccCampaignExecutionAuthorizationMembers(h.layer(), {
        authorityStore: h.store(),
        rootDir: h.rootDir(),
        authorizationId: claimed.authorizationId,
        actor: OPERATOR,
        runId: `sealed-opened-${lifecycle}-closure:${claimed.authorizationId}`,
      });
      expect(closed.authorization.status).toBe("claimed");
      expect(closed.openedApprovalRequestIds).toEqual([
        claimed.members[0]!.approvalRequestId,
      ]);
      expect(closed.closedApprovalRequestIds).toEqual([
        claimed.members[1]!.approvalRequestId,
      ]);
      const childRows = await h.layer().db.execute(sql`
        SELECT id, status
        FROM project.approval_requests
        WHERE campaign_import_id = ${campaign.imported.importId}
        ORDER BY id
      `) as unknown as Array<{ id: string; status: string }>;
      expect(childRows.find(({ id }) => id === claimed.members[0]!.approvalRequestId)?.status)
        .toBe("claimed");
      expect(childRows.find(({ id }) => id === claimed.members[1]!.approvalRequestId)?.status)
        .toBe("expired");
    }
  });

  it("RED-S3-unknown-effect: an unresolved effect receipt rolls back every proposed no-effect closure", async () => {
    const campaign = await fixture("unknown-effect-no-reservation");
    const issued = await issueCccCampaignExecutionAuthorization(h.layer(), {
      authorityStore: h.store(),
      rootDir: h.rootDir(),
      taskId: campaign.taskIds[0]!,
      requester: REQUESTER,
      notBeforeAt: campaign.campaignStartedAt,
      expiresAt: campaign.campaignDeadlineAt,
    });
    const claimed = await claimCccCampaignExecutionAuthorization(h.layer(), {
      authorityStore: h.store(),
      rootDir: h.rootDir(),
      authorizationId: issued.authorizationId,
      claimant: OPERATOR,
      claimToken: "sealed-parent-unknown-effect-token",
    });
    const taskId = campaign.taskIds[0]!;
    const context = await h.store().getCccCampaignContextForTask(taskId);
    if (!context) throw new Error("missing unknown-effect context");
    const binding = createCccCampaignAuthorityBinding(context, {
      actionId: campaign.actions[0]!.id,
      actionTarget: campaign.actions[0]!.target,
    });
    const now = new Date().toISOString();
    await h.layer().db.insert(schema.project.cccEffectReceipts).values({
      projectId: binding.projectId,
      ownerProjectId: binding.projectId,
      effectScopeId: "execution-authorization-unknown-effect",
      logicalKey: "execution-authorization-unknown-effect-receipt",
      turnKey: "execution-authorization-unknown-effect-turn",
      slotOrdinal: 0,
      toolAuthority: "execution-authorization-fixture",
      argumentsDigest: "unknown-effect-arguments",
      repeatOf: null,
      state: "dispatched_unknown",
      controllerToken: "unknown-effect-controller",
      evidenceDigest: null,
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
    });
    await h.layer().db.execute(sql`
      UPDATE project.workflow_work_items
      SET state = 'failed',
          last_error = 'workflow-node-failed:unknown-effect',
          blocked_reason = NULL,
          lease_owner = NULL,
          lease_expires_at = NULL,
          updated_at = ${now}
      WHERE id = ${claimed.workItemId}
    `);

    await expect(closeUnopenedCccCampaignExecutionAuthorizationMembers(h.layer(), {
      authorityStore: h.store(),
      rootDir: h.rootDir(),
      authorizationId: claimed.authorizationId,
      actor: OPERATOR,
      runId: `sealed-unknown-effect-closure:${claimed.authorizationId}`,
    })).rejects.toThrow(/unresolved dispatched receipt/u);
    await expect(getCccCampaignExecutionAuthorization(
      h.layer().db,
      claimed.authorizationId,
    )).resolves.toMatchObject({ status: "claimed" });
    const childRows = await h.layer().db.execute(sql`
      SELECT status
      FROM project.approval_requests
      WHERE campaign_import_id = ${campaign.imported.importId}
      ORDER BY id
    `) as unknown as Array<{ status: string }>;
    expect(childRows.map(({ status }) => status)).toEqual(["claimed", "claimed"]);
  });

  it("RED-S3-manual-custody: a generic manual hold cannot close claimed children as proven no-effect", async () => {
    const campaign = await fixture("generic-manual-hold");
    const issued = await issueCccCampaignExecutionAuthorization(h.layer(), {
      authorityStore: h.store(),
      rootDir: h.rootDir(),
      taskId: campaign.taskIds[0]!,
      requester: REQUESTER,
      notBeforeAt: campaign.campaignStartedAt,
      expiresAt: campaign.campaignDeadlineAt,
    });
    const claimed = await claimCccCampaignExecutionAuthorization(h.layer(), {
      authorityStore: h.store(),
      rootDir: h.rootDir(),
      authorizationId: issued.authorizationId,
      claimant: OPERATOR,
      claimToken: "sealed-parent-generic-manual-token",
    });
    await h.layer().db.execute(sql`
      UPDATE project.workflow_work_items
      SET state = 'manual-required',
          last_error = 'manual-required',
          blocked_reason = 'manual-required',
          lease_owner = NULL,
          lease_expires_at = NULL,
          updated_at = ${new Date().toISOString()}
      WHERE id = ${claimed.workItemId}
    `);

    await expect(closeUnopenedCccCampaignExecutionAuthorizationMembers(h.layer(), {
      authorityStore: h.store(),
      rootDir: h.rootDir(),
      authorizationId: claimed.authorizationId,
      actor: OPERATOR,
      runId: `sealed-generic-manual-closure:${claimed.authorizationId}`,
    })).rejects.toThrow(/cannot close unopened members from work-item state manual-required/u);
    await expect(getCccCampaignExecutionAuthorization(
      h.layer().db,
      claimed.authorizationId,
    )).resolves.toMatchObject({ status: "claimed" });
    const children = await h.layer().db.execute(sql`
      SELECT status
      FROM project.approval_requests
      WHERE campaign_import_id = ${campaign.imported.importId}
      ORDER BY id
    `) as unknown as Array<{ status: string }>;
    expect(children.map(({ status }) => status)).toEqual(["claimed", "claimed"]);
  });

  it("RED-S3-terminal-reason: a terminal state without a durable reason cannot prove no-effect closure", async () => {
    const campaign = await fixture("missing-terminal-reason");
    const issued = await issueCccCampaignExecutionAuthorization(h.layer(), {
      authorityStore: h.store(),
      rootDir: h.rootDir(),
      taskId: campaign.taskIds[0]!,
      requester: REQUESTER,
      notBeforeAt: campaign.campaignStartedAt,
      expiresAt: campaign.campaignDeadlineAt,
    });
    const claimed = await claimCccCampaignExecutionAuthorization(h.layer(), {
      authorityStore: h.store(),
      rootDir: h.rootDir(),
      authorizationId: issued.authorizationId,
      claimant: OPERATOR,
      claimToken: "sealed-parent-missing-terminal-reason-token",
    });
    await h.layer().db.execute(sql`
      UPDATE project.workflow_work_items
      SET state = 'failed',
          last_error = NULL,
          blocked_reason = NULL,
          lease_owner = NULL,
          lease_expires_at = NULL,
          updated_at = ${new Date().toISOString()}
      WHERE id = ${claimed.workItemId}
    `);

    await expect(closeUnopenedCccCampaignExecutionAuthorizationMembers(h.layer(), {
      authorityStore: h.store(),
      rootDir: h.rootDir(),
      authorizationId: claimed.authorizationId,
      actor: OPERATOR,
      runId: `sealed-missing-reason-closure:${claimed.authorizationId}`,
    })).rejects.toThrow(/cannot close unopened members from work-item state failed/u);
    await expect(getCccCampaignExecutionAuthorization(
      h.layer().db,
      claimed.authorizationId,
    )).resolves.toMatchObject({ status: "claimed" });
  });
});
