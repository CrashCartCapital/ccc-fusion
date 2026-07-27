/**
 * Phase E native campaign persistence RED suite.
 *
 * This file deliberately names the desired TaskStore reader contract before
 * production adds it. Campaign context is derived from CCC PRD custody rows,
 * never supplied by a task caller or a second campaign store.
 */

import { beforeAll, beforeEach, afterAll, afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { mkdir, realpath, symlink, unlink } from "node:fs/promises";
import { join } from "node:path";
import { importCccPrdBundle, reconcileCccPrdImport } from "../../index.js";
import * as campaignCanonical from "../../ccc-campaign/canonical.js";
import type { CccCampaignTaskContext } from "../../ccc-campaign/index.js";
import { canonicalCccPrdJson } from "../../ccc-prd/contract.js";
import { TaskStore } from "../../store.js";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import {
  createCccPrdImportTestBundle as bundle,
  rehashCccPrdImportTestBundle,
} from "../../__test-utils__/ccc-prd-import-fixture.js";
import type { CccPrdSemanticBundle } from "../../ccc-prd/types.js";
import type { DbTransaction } from "../../postgres/data-layer.js";

type ExecutionRoute = Readonly<{
  taskId: string;
  providerId: string;
  modelId: string;
  transport: "pi" | "cli" | "workflow";
  workflowExtensionId?: string;
}>;

type ExecutionPolicy = Readonly<{
  schema: "ccc-campaign.execution-policy.v1";
  routes: readonly ExecutionRoute[];
}>;

type CampaignContext = Readonly<CccCampaignTaskContext>;

type CampaignContextStore = {
  getCccCampaignContextForTask(taskId: string): Promise<CampaignContext | null>;
  getCccCampaignContextForTaskWithinTransaction(
    tx: DbTransaction,
    taskId: string,
  ): Promise<CampaignContext | null>;
  assertCccCampaignWorkflowLeaseFence(input: {
    workItemId: string;
    originTaskId: string;
    leaseOwner: string;
    attempt: number;
    runId: string;
  }): Promise<void>;
  claimCccCampaignActionLease(
    taskId: string,
    action: { actionId: string; actionTarget: string },
    claim: {
      approvalRequestId: string;
      claimToken: string;
      claimedAt: string;
      expiresAt: string;
    },
    tx?: DbTransaction,
  ): Promise<{ lease: ActionLease; binding: AuthorityBinding }>;
  inspectCccCampaignActionLease(
    taskId: string,
    action: { actionId: string; actionTarget: string },
    tx?: DbTransaction,
  ): Promise<{ lease: ActionLease; binding: AuthorityBinding } | null>;
  settleCccCampaignActionLease(
    taskId: string,
    action: { actionId: string; actionTarget: string },
    claimToken: string,
    tx?: DbTransaction,
  ): Promise<void>;
};

type AuthorityBinding = Readonly<{
  projectId: string;
  importId: string;
  campaignId: string;
  taskId: string;
  actionId: string;
  actionTarget: string;
  idempotencyKey: string;
  packetHash: string;
  sidecarHash: string;
  bundleHash: string;
  targetRepository: string;
  targetBase: string;
  providerId: string;
  modelId: string;
  transport: "pi" | "cli" | "workflow";
  manifestHash: string;
  bindingHash: string;
}>;

type ActionLease = Readonly<{
  actionId: string;
  actionTarget: string;
  approvalRequestId: string;
  claimToken: string;
  claimedAt: string;
  expiresAt: string;
  bindingHash: string;
}>;

function errorChainText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const record = current as { message?: unknown; code?: unknown; cause?: unknown };
    if (typeof record.message === "string") parts.push(record.message);
    if (typeof record.code === "string") parts.push(record.code);
    current = record.cause;
  }
  return parts.join("\n");
}

type CampaignAuthorityApi = {
  createCccCampaignAuthorityBinding(
    context: CampaignContext,
    action: { actionId: string; actionTarget: string; requireProtected?: boolean },
  ): AuthorityBinding;
};

const authorityApi = campaignCanonical as unknown as CampaignAuthorityApi;

function routesFor(source: CccPrdSemanticBundle): ExecutionRoute[] {
  return source.tasks.map((task) => ({
    taskId: task.id,
    providerId: "deterministic-fake",
    modelId: "fixture-v1",
    transport: "pi",
  }));
}

function policyFor(source: CccPrdSemanticBundle, routes = routesFor(source)): ExecutionPolicy {
  return {
    schema: "ccc-campaign.execution-policy.v1",
    routes,
  };
}

function withProtectedActions(
  source: CccPrdSemanticBundle,
  actions: readonly { actionId: string; actionTarget: string }[],
): CccPrdSemanticBundle {
  return rehashCccPrdImportTestBundle({
    ...source,
    tasks: source.tasks.map((task, index) => index === 0
      ? { ...task, protectedActionIds: actions.map(({ actionId }) => actionId) }
      : task),
    protectedActions: actions.map(({ actionId, actionTarget }) => ({
      id: actionId,
      kind: "merge" as const,
      target: actionTarget,
      operatorDecision: "approve_merge" as const,
      requiresOperatorDecision: true as const,
      spans: [source.tasks[0]!.spans[0]!],
    })),
  });
}

describe("CCC campaign native public surface", () => {
  it("reserves the TaskStore campaign-context reader", () => {
    expect(typeof (TaskStore.prototype as unknown as Partial<CampaignContextStore>).getCccCampaignContextForTask).toBe("function");
  });

  it("Task 6 RED: canonical workflow routes require an extension identity and bind it into manifest identity", () => {
    const source = bundle("/tmp/ccc-campaign-workflow-route", "workflow-route");
    const workflowExtensionId = "plugin:ccc-campaign:provider-dispatch";
    const workflowRoute = {
      ...routesFor(source)[0]!,
      transport: "workflow" as const,
      workflowExtensionId,
    };
    const workflowPolicy = policyFor(source, [
      workflowRoute,
      ...routesFor(source).slice(1),
    ]);

    expect(() => campaignCanonical.parseCccCampaignExecutionPolicy(
      policyFor(source, [
        { ...workflowRoute, workflowExtensionId: undefined },
        ...routesFor(source).slice(1),
      ]),
      source,
    )).toThrow("CCC campaign execution route 0 workflowExtensionId must be a non-empty canonical registry ID");

    expect(campaignCanonical.parseCccCampaignExecutionPolicy(workflowPolicy, source).routes)
      .toContainEqual(expect.objectContaining({ workflowExtensionId }));

    for (const transport of ["pi", "cli"] as const) {
      expect(() => campaignCanonical.parseCccCampaignExecutionPolicy(
        policyFor(source, [
          { ...workflowRoute, transport },
          ...routesFor(source).slice(1),
        ]),
        source,
      )).toThrow(`CCC campaign execution route 0 workflowExtensionId is forbidden for ${transport} transport`);
    }

    const manifest = (extensionId: string) => campaignCanonical.hashCccCampaignManifest(
      campaignCanonical.createCccCampaignManifest({
        projectId: "project-workflow-route",
        importId: "import-workflow-route",
        idempotencyKey: "idem-workflow-route",
        campaignId: "campaign-workflow-route",
        bundle: source,
        executionPolicy: campaignCanonical.parseCccCampaignExecutionPolicy(
          policyFor(source, [
            { ...workflowRoute, workflowExtensionId: extensionId },
            ...routesFor(source).slice(1),
          ]),
          source,
        ),
        targetRepositoryPath: source.targetRepository.path,
        campaignStartedAt: "2026-07-27T00:00:00.000Z",
      }),
    );

    expect(manifest(workflowExtensionId)).not.toBe(manifest("plugin:ccc-campaign:alternate-dispatch"));
  });
});

const pgTest = pgDescribe;

pgTest("CCC campaign native persistence", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_ccc_campaign_native",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  function request(
    source: CccPrdSemanticBundle,
    idempotencyKey: string,
    executionPolicy?: ExecutionPolicy,
  ) {
    return {
      bundle: source,
      idempotencyKey,
      store: h.store(),
      layer: h.layer(),
      rootDir: h.rootDir(),
      executionPolicy,
    };
  }

  async function importContext(
    suffix: string,
    options: {
      protectedAction?: { actionId: string; actionTarget: string };
      protectedActions?: readonly { actionId: string; actionTarget: string }[];
    } = {},
  ): Promise<CampaignContext> {
    const initial = bundle(h.rootDir(), suffix);
    const protectedActions = options.protectedActions
      ?? (options.protectedAction ? [options.protectedAction] : []);
    const source = protectedActions.length > 0
      ? withProtectedActions(initial, protectedActions)
      : initial;
    await importCccPrdBundle(request(source, `idem-${suffix}`, policyFor(source)));
    const context = await (h.store() as unknown as CampaignContextStore)
      .getCccCampaignContextForTask(`TASK-${suffix}`);
    expect(context).not.toBeNull();
    return context!;
  }

  it("Task 3 RED: read-only workflow lease preflight validates every fence field with database time", async () => {
    const context = await importContext("workflow-fence-preflight");
    const store = h.store() as unknown as CampaignContextStore;
    const [workItem] = await h.store().listWorkflowWorkItemsForTask(context.taskId, { kinds: ["task"] });
    expect(workItem).toBeDefined();
    const leaseOwner = "workflow-fence-worker";
    const attempt = 3;
    await h.store().transitionWorkflowWorkItem(workItem!.id, "running", {
      attempt,
      leaseOwner,
      leaseExpiresAt: "2999-07-25T12:00:00.000Z",
    });
    const input = {
      workItemId: workItem!.id,
      originTaskId: context.taskId,
      leaseOwner,
      attempt,
      runId: workItem!.runId,
    };
    const proofAuditCount = async () => h.layer().db.execute(sql`
      SELECT count(*)::int AS count
      FROM project.run_audit_events
      WHERE mutation_type = 'ccc-campaign:proof-admission'
    `) as Promise<Array<{ count: number }>>;
    const before = await proofAuditCount();

    await expect(store.assertCccCampaignWorkflowLeaseFence(input)).resolves.toBeUndefined();
    for (const changed of [
      { ...input, workItemId: `${input.workItemId}-wrong` },
      { ...input, originTaskId: `${input.originTaskId}-wrong` },
      { ...input, runId: `${input.runId}-wrong` },
      { ...input, leaseOwner: `${input.leaseOwner}-wrong` },
      { ...input, attempt: input.attempt + 1 },
      { ...input, workItemId: ` ${input.workItemId}` },
      { ...input, attempt: 0 },
    ]) {
      await expect(store.assertCccCampaignWorkflowLeaseFence(changed))
        .rejects.toMatchObject({ code: "CCC_CAMPAIGN_WORKFLOW_LEASE_REFUSED" });
    }

    await h.layer().db.execute(sql`
      UPDATE project.workflow_work_items SET state = 'held' WHERE id = ${input.workItemId}
    `);
    await expect(store.assertCccCampaignWorkflowLeaseFence(input))
      .rejects.toMatchObject({ code: "CCC_CAMPAIGN_WORKFLOW_LEASE_REFUSED" });
    await h.layer().db.execute(sql`
      UPDATE project.workflow_work_items
      SET state = 'running', lease_expires_at = NULL
      WHERE id = ${input.workItemId}
    `);
    await expect(store.assertCccCampaignWorkflowLeaseFence(input))
      .rejects.toMatchObject({ code: "CCC_CAMPAIGN_WORKFLOW_LEASE_REFUSED" });
    await h.layer().db.execute(sql`
      UPDATE project.workflow_work_items
      SET lease_expires_at = '2000-01-01T00:00:00.000Z'
      WHERE id = ${input.workItemId}
    `);
    await expect(store.assertCccCampaignWorkflowLeaseFence(input))
      .rejects.toMatchObject({ code: "CCC_CAMPAIGN_WORKFLOW_LEASE_REFUSED" });

    expect(await proofAuditCount()).toEqual(before);
  });

  async function mutateCanonicalBundleTask(
    idempotencyKey: string,
    semanticTaskId: string,
    patchSql: ReturnType<typeof sql>,
  ): Promise<void> {
    await h.layer().db.execute(sql`
      UPDATE project.ccc_prd_imports
      SET canonical_bundle = jsonb_set(
        canonical_bundle,
        ARRAY[
          'tasks',
          (
            SELECT (ordinality - 1)::text
            FROM jsonb_array_elements(canonical_bundle->'tasks') WITH ORDINALITY AS task(value, ordinality)
            WHERE task.value->>'id' = ${semanticTaskId}
          )
        ],
        ${patchSql}
      )
      WHERE idempotency_key = ${idempotencyKey}
    `);
  }

  function claimInput(
    context: CampaignContext,
    overrides: Partial<{
      approvalRequestId: string;
      claimToken: string;
      claimedAt: string;
      expiresAt: string;
    }> = {},
  ) {
    return {
      approvalRequestId: "approval-request-1",
      claimToken: "claim-token-1",
      claimedAt: context.campaignStartedAt,
      expiresAt: context.campaignDeadlineAt,
      ...overrides,
    };
  }

  it("uses a supplied transaction for a campaign-context reload", async () => {
    const context = await importContext("transaction-aware-context");
    const store = h.store() as unknown as CampaignContextStore;

    await h.layer().transaction(async (tx) => {
      await tx.execute(sql`
        UPDATE project.ccc_prd_imports
        SET request_count = 7
        WHERE idempotency_key = ${context.idempotencyKey}
      `);
      await expect(
        store.getCccCampaignContextForTaskWithinTransaction(tx, context.taskId),
      ).resolves.toMatchObject({ requestCount: 7 });
    });
  });

  it("locks the campaign import for a transaction-scoped authority read", async () => {
    const context = await importContext("transaction-context-lock");
    const store = h.store() as unknown as CampaignContextStore;

    await h.layer().transaction(async (tx) => {
      await expect(
        store.getCccCampaignContextForTaskWithinTransaction(tx, context.taskId),
      ).resolves.toMatchObject({ importId: context.importId });
      await expect(h.layer().transaction(async (contender) => {
        await contender.execute(sql`SET LOCAL lock_timeout = '100ms'`);
        await contender.execute(sql`
          UPDATE project.ccc_prd_imports
          SET request_count = request_count
          WHERE idempotency_key = ${context.idempotencyKey}
        `);
      })).rejects.toSatisfy((error) =>
        /lock timeout|55P03/i.test(errorChainText(error)),
      );
    });
  });

  it("derives a full authority binding and canonical hash from persisted campaign context", async () => {
    const context = await importContext("authority-binding");
    const binding = authorityApi.createCccCampaignAuthorityBinding(context, {
      actionId: "receipt-action",
      actionTarget: "local://receipt",
    });
    const { bindingHash, ...bindingFields } = binding;

    expect(binding).toEqual({
      projectId: context.projectId,
      importId: context.importId,
      campaignId: context.campaignId,
      taskId: context.taskId,
      actionId: "receipt-action",
      actionTarget: "local://receipt",
      idempotencyKey: context.idempotencyKey,
      packetHash: context.packetHash,
      sidecarHash: context.sidecarHash,
      bundleHash: context.bundleHash,
      targetRepository: context.targetRepository.path,
      targetBase: context.targetRepository.baseCommit,
      providerId: context.route.providerId,
      modelId: context.route.modelId,
      transport: context.route.transport,
      manifestHash: context.manifestHash,
      bindingHash: createHash("sha256")
        .update(canonicalCccPrdJson(bindingFields), "utf8")
        .digest("hex"),
    });
    expect(bindingHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses protected action target drift", async () => {
    const context = await importContext("protected-target-drift", {
      protectedAction: {
        actionId: "merge-main",
        actionTarget: "refs/heads/main",
      },
    });

    expect(() => authorityApi.createCccCampaignAuthorityBinding(context, {
      actionId: "merge-main",
      actionTarget: "refs/heads/release",
    })).toThrow("CCC campaign protected action merge-main target must match exactly");
  });

  it("refuses an undeclared action when protected authority is required", async () => {
    const context = await importContext("undeclared-protected-action");

    expect(() => authorityApi.createCccCampaignAuthorityBinding(context, {
      actionId: "not-declared",
      actionTarget: "refs/heads/main",
      requireProtected: true,
    })).toThrow("CCC campaign action not-declared is not a declared protected action");
  });

  it("allows one action-lease winner under two concurrent claims", async () => {
    const context = await importContext("concurrent-action-lease", {
      protectedAction: {
        actionId: "receipt-concurrent",
        actionTarget: "local://receipt/concurrent",
      },
    });
    const binding = authorityApi.createCccCampaignAuthorityBinding(context, {
      actionId: "receipt-concurrent",
      actionTarget: "local://receipt/concurrent",
      requireProtected: true,
    });
    const results = await Promise.allSettled([
      (h.store() as unknown as CampaignContextStore).claimCccCampaignActionLease(context.taskId, {
        actionId: binding.actionId,
        actionTarget: binding.actionTarget,
      }, claimInput(context, {
        claimToken: "claim-token-left",
      })),
      (h.store() as unknown as CampaignContextStore).claimCccCampaignActionLease(context.taskId, {
        actionId: binding.actionId,
        actionTarget: binding.actionTarget,
      }, claimInput(context, {
        claimToken: "claim-token-right",
      })),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const winner = results.find((result) => result.status === "fulfilled");
    expect(winner).toMatchObject({
      value: {
        lease: {
          actionId: binding.actionId,
          actionTarget: binding.actionTarget,
          bindingHash: binding.bindingHash,
        },
        binding,
      },
    });
  });

  it("replays an identical action lease without changing its owner", async () => {
    const context = await importContext("identical-action-lease", {
      protectedAction: {
        actionId: "receipt-identical",
        actionTarget: "local://receipt/identical",
      },
    });
    const binding = authorityApi.createCccCampaignAuthorityBinding(context, {
      actionId: "receipt-identical",
      actionTarget: "local://receipt/identical",
      requireProtected: true,
    });
    const store = h.store() as unknown as CampaignContextStore;
    const action = { actionId: binding.actionId, actionTarget: binding.actionTarget };
    const input = claimInput(context);
    const first = await store.claimCccCampaignActionLease(context.taskId, action, input);
    const replay = await store.claimCccCampaignActionLease(context.taskId, action, input);

    expect(replay).toEqual(first);
    await expect(store.inspectCccCampaignActionLease(context.taskId, action)).resolves.toEqual(first);
  });

  it("refuses an action lease collision with a changed winning token", async () => {
    const context = await importContext("action-lease-collision", {
      protectedAction: {
        actionId: "receipt-collision",
        actionTarget: "local://receipt/collision",
      },
    });
    const binding = authorityApi.createCccCampaignAuthorityBinding(context, {
      actionId: "receipt-collision",
      actionTarget: "local://receipt/collision",
      requireProtected: true,
    });
    const store = h.store() as unknown as CampaignContextStore;
    const action = { actionId: binding.actionId, actionTarget: binding.actionTarget };
    await store.claimCccCampaignActionLease(context.taskId, action, claimInput(context));

    await expect(store.claimCccCampaignActionLease(context.taskId, action, claimInput(context, {
      claimToken: "different-winning-token",
    }))).rejects.toThrow(
      "CCC campaign action lease receipt-collision collision: claim token differs",
    );
  });

  it("settles only the exact winning action lease", async () => {
    const context = await importContext("exact-action-settle", {
      protectedActions: [
        {
          actionId: "receipt-settle-first",
          actionTarget: "local://receipt/settle-first",
        },
        {
          actionId: "receipt-settle-second",
          actionTarget: "local://receipt/settle-second",
        },
      ],
    });
    const firstBinding = authorityApi.createCccCampaignAuthorityBinding(context, {
      actionId: "receipt-settle-first",
      actionTarget: "local://receipt/settle-first",
      requireProtected: true,
    });
    const secondBinding = authorityApi.createCccCampaignAuthorityBinding(context, {
      actionId: "receipt-settle-second",
      actionTarget: "local://receipt/settle-second",
      requireProtected: true,
    });
    const store = h.store() as unknown as CampaignContextStore;
    const firstAction = {
      actionId: firstBinding.actionId,
      actionTarget: firstBinding.actionTarget,
    };
    const secondAction = {
      actionId: secondBinding.actionId,
      actionTarget: secondBinding.actionTarget,
    };
    const firstLease = await store.claimCccCampaignActionLease(
      context.taskId,
      firstAction,
      claimInput(context, { claimToken: "first-winning-token" }),
    );
    const secondLease = await store.claimCccCampaignActionLease(
      context.taskId,
      secondAction,
      claimInput(context, { claimToken: "second-winning-token" }),
    );

    await expect(store.settleCccCampaignActionLease(
      context.taskId,
      firstAction,
      "wrong-token",
    )).rejects.toThrow(
      "CCC campaign action lease receipt-settle-first can only settle with its winning claim token and binding",
    );

    await store.settleCccCampaignActionLease(
      context.taskId,
      firstAction,
      firstLease.lease.claimToken,
    );
    await expect(store.inspectCccCampaignActionLease(context.taskId, firstAction)).resolves.toBeNull();
    await expect(store.inspectCccCampaignActionLease(context.taskId, secondAction)).resolves.toEqual(secondLease);
  });

  it("keeps an action lease visible after a TaskStore restart", async () => {
    const context = await importContext("restart-action-lease", {
      protectedAction: {
        actionId: "receipt-restart",
        actionTarget: "local://receipt/restart",
      },
    });
    const binding = authorityApi.createCccCampaignAuthorityBinding(context, {
      actionId: "receipt-restart",
      actionTarget: "local://receipt/restart",
      requireProtected: true,
    });
    const action = { actionId: binding.actionId, actionTarget: binding.actionTarget };
    const lease = await (h.store() as unknown as CampaignContextStore)
      .claimCccCampaignActionLease(context.taskId, action, claimInput(context));
    const restarted = new TaskStore(
      h.rootDir(),
      undefined,
      { asyncLayer: h.layer() },
    ) as unknown as CampaignContextStore;

    await expect(
      restarted.getCccCampaignContextForTask(context.taskId),
    ).resolves.toMatchObject({
      activeActionLeases: {
        [binding.actionId]: lease.lease,
      },
    });
    await expect(restarted.inspectCccCampaignActionLease(context.taskId, action)).resolves.toEqual(lease);
  });

  it("refuses a persisted action lease whose protected binding has drifted", async () => {
    const context = await importContext("drifted-action-lease", {
      protectedAction: {
        actionId: "receipt-drifted",
        actionTarget: "local://receipt/drifted",
      },
    });
    const action = {
      actionId: "receipt-drifted",
      actionTarget: "local://receipt/drifted",
    };
    const lease = await (h.store() as unknown as CampaignContextStore)
      .claimCccCampaignActionLease(context.taskId, action, claimInput(context));
    await h.layer().db.execute(sql`
      UPDATE project.ccc_prd_imports
      SET active_action_leases = ${JSON.stringify({
        [context.taskId]: {
          [action.actionId]: {
            ...lease.lease,
            bindingHash: "0".repeat(64),
          },
        },
      })}::jsonb
      WHERE idempotency_key = ${context.idempotencyKey}
    `);
    const restarted = new TaskStore(
      h.rootDir(),
      undefined,
      { asyncLayer: h.layer() },
    ) as unknown as CampaignContextStore;

    await expect(
      restarted.getCccCampaignContextForTask(context.taskId),
    ).rejects.toThrow(
      "CCC campaign action lease receipt-drifted binding does not match persisted campaign context",
    );
  });

  it.each([
    ["missing", (source: CccPrdSemanticBundle) => policyFor(source, routesFor(source).slice(1))],
    ["extra", (source: CccPrdSemanticBundle) => policyFor(source, [...routesFor(source), {
      taskId: "TASK-not-in-packet", providerId: "deterministic-fake", modelId: "fixture-v1", transport: "pi",
    }])],
    ["duplicate", (source: CccPrdSemanticBundle) => policyFor(source, [...routesFor(source), routesFor(source)[0]!])],
  ] as const)("refuses %s exact per-task execution routes", async (kind, executionPolicy) => {
    const source = bundle(h.rootDir(), `route-${kind}`);
    await expect(importCccPrdBundle(request(source, `idem-route-${kind}`, executionPolicy(source)))).rejects.toMatchObject({
      code: "CCC_PRD_EXECUTION_ROUTE_REFUSED",
    });
  });

  it("refuses an idempotency replay whose provider, model, or transport binding changed", async () => {
    const source = bundle(h.rootDir(), "route-idempotency");
    const admitted = policyFor(source);
    await expect(importCccPrdBundle(request(source, "idem-route-binding", admitted))).resolves.toMatchObject({ state: "active" });

    for (const changed of [
      policyFor(source, routesFor(source).map((route, index) => index === 0 ? { ...route, providerId: "other-fake" } : route)),
      policyFor(source, routesFor(source).map((route, index) => index === 0 ? { ...route, modelId: "fixture-v2" } : route)),
      policyFor(source, routesFor(source).map((route, index) => index === 0 ? { ...route, transport: "cli" } : route)),
    ]) {
      await expect(importCccPrdBundle(request(source, "idem-route-binding", changed))).rejects.toMatchObject({
        code: "CCC_PRD_IMPORT_IDEMPOTENCY_COLLISION",
      });
    }
  });

  it("returns one immutable context across a sequential identical replay", async () => {
    const source = bundle(h.rootDir(), "sequential-context");
    const executionPolicy = policyFor(source);
    const first = await importCccPrdBundle(
      request(source, "idem-sequential-context", executionPolicy),
    );
    const replay = await importCccPrdBundle(
      request(source, "idem-sequential-context", executionPolicy),
    );
    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    const context = await (h.store() as unknown as CampaignContextStore)
      .getCccCampaignContextForTask("TASK-sequential-context");
    expect(context).toMatchObject({
      importId: first.importId,
      manifestHash: first.identityHash,
      executionPolicy,
    });
  });

  it("returns one immutable context across two concurrent identical imports", async () => {
    const source = bundle(h.rootDir(), "concurrent-context");
    const executionPolicy = policyFor(source);
    const [left, right] = await Promise.all([
      importCccPrdBundle(request(source, "idem-concurrent-context", executionPolicy)),
      importCccPrdBundle(request(source, "idem-concurrent-context", executionPolicy)),
    ]);
    expect(new Set([left.importId, right.importId])).toEqual(new Set([left.importId]));
    expect([left.replayed, right.replayed].sort()).toEqual([false, true]);
    const context = await (h.store() as unknown as CampaignContextStore)
      .getCccCampaignContextForTask("TASK-concurrent-context");
    expect(context).toMatchObject({
      importId: left.importId,
      manifestHash: left.identityHash,
      executionPolicy,
    });
  });

  it("reloads the same immutable context after a post-commit lost response", async () => {
    const source = bundle(h.rootDir(), "lost-context");
    const executionPolicy = policyFor(source);
    await expect(importCccPrdBundle({
      ...request(source, "idem-lost-context", executionPolicy),
      failureInjection: { checkpoint: "lost_response_after_commit" },
    })).rejects.toMatchObject({ code: "CCC_PRD_IMPORT_LOST_RESPONSE" });
    const replay = await importCccPrdBundle(
      request(source, "idem-lost-context", executionPolicy),
    );
    expect(replay.replayed).toBe(true);
    const restarted = new TaskStore(
      h.rootDir(),
      undefined,
      { asyncLayer: h.layer() },
    ) as unknown as CampaignContextStore;
    await expect(
      restarted.getCccCampaignContextForTask("TASK-lost-context"),
    ).resolves.toMatchObject({
      importId: replay.importId,
      manifestHash: replay.identityHash,
      executionPolicy,
    });
  });

  it("persists and reloads an immutable policy-complete campaign binding from custody rows after restart", async () => {
    const source = bundle(h.rootDir(), "context");
    const executionPolicy = policyFor(source);
    const imported = await importCccPrdBundle(request(source, "idem-context", executionPolicy));

    const rows = await h.layer().db.execute(sql`
      SELECT execution_policy, campaign_manifest, campaign_manifest_hash
      FROM project.ccc_prd_imports
      WHERE idempotency_key = ${"idem-context"}
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      execution_policy: executionPolicy,
      campaign_manifest: {
        importId: imported.importId,
        campaignId: "CAMPAIGN-context",
        packetHash: source.sourceHash,
        sidecarHash: source.sidecarHash,
        bundleHash: source.bundleHash,
        executionPolicy,
      },
      campaign_manifest_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });

    const restarted = new TaskStore(h.rootDir(), undefined, { asyncLayer: h.layer() }) as unknown as CampaignContextStore;
    await expect(restarted.getCccCampaignContextForTask("TASK-context")).resolves.toEqual({
      schema: "ccc-campaign.context.v1",
      projectId: "__legacy_unscoped__",
      importId: imported.importId,
      idempotencyKey: "idem-context",
      campaignId: "CAMPAIGN-context",
      taskId: "TASK-context",
      semanticTaskId: "TASK-context",
      proofIds: ["PROOF-context"],
      protectedActionIds: source.tasks[0]!.protectedActionIds,
      packetHash: source.sourceHash,
      sidecarHash: source.sidecarHash,
      bundleHash: source.bundleHash,
      manifestHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      sourceVersion: source.sourceVersion,
      targetRepository: {
        ...source.targetRepository,
        path: await realpath(source.targetRepository.path),
      },
      bounds: source.bounds,
      admittedWriteRoots: source.admittedWriteRoots,
      proofs: source.proofs,
      protectedActions: source.protectedActions,
      executionPolicy,
      route: routesFor(source)[0],
      campaignStartedAt: expect.any(String),
      campaignDeadlineAt: expect.any(String),
      requestCount: 0,
      activeActionLeases: {},
    });

    await expect(restarted.getTask("TASK-context")).resolves.toMatchObject({
      modelProvider: "deterministic-fake",
      modelId: "fixture-v1",
      baseCommitSha: source.targetRepository.baseCommit,
    });
  });

  it("does not accept caller task metadata as campaign context", async () => {
    const source = bundle(h.rootDir(), "caller-metadata");
    const executionPolicy = policyFor(source);
    await importCccPrdBundle(request(source, "idem-caller-metadata", executionPolicy));
    const callerMetadata = JSON.stringify({
      bundleHash: source.bundleHash,
      proofIds: source.tasks[0]!.proofIds,
      campaignId: "caller-asserted",
      providerId: "caller-asserted",
      modelId: "caller-asserted",
    });
    await h.layer().db.execute(sql`
      UPDATE project.tasks
      SET source_metadata = ${callerMetadata}::jsonb
      WHERE id = ${"TASK-caller-metadata"}
    `);

    const restarted = new TaskStore(h.rootDir(), undefined, { asyncLayer: h.layer() }) as unknown as CampaignContextStore;
    const context = await restarted.getCccCampaignContextForTask("TASK-caller-metadata");
    expect(context).toMatchObject({
      campaignId: "CAMPAIGN-caller-metadata",
      semanticTaskId: "TASK-caller-metadata",
      proofIds: ["PROOF-caller-metadata"],
      executionPolicy,
      route: routesFor(source)[0],
    });
    expect(context).not.toMatchObject({
      campaignId: "caller-asserted",
      route: { providerId: "caller-asserted", modelId: "caller-asserted" },
    });
  });

  it("refuses a canonical bundle task proof-id mutation that is not rehashed", async () => {
    const source = bundle(h.rootDir(), "bundle-proof-drift");
    await importCccPrdBundle(
      request(source, "idem-bundle-proof-drift", policyFor(source)),
    );
    await mutateCanonicalBundleTask(
      "idem-bundle-proof-drift",
      "TASK-bundle-proof-drift",
      sql`${JSON.stringify({
        ...source.tasks[0]!,
        proofIds: ["PROOF-bundle-proof-drift-mutated"],
      })}::jsonb`,
    );

    const restarted = new TaskStore(
      h.rootDir(),
      undefined,
      { asyncLayer: h.layer() },
    ) as unknown as CampaignContextStore;
    await expect(
      restarted.getCccCampaignContextForTask("TASK-bundle-proof-drift"),
    ).rejects.toMatchObject({
      name: "CccCampaignContextError",
      code: "CCC_CAMPAIGN_CONTEXT_REFUSED",
    });
  });

  it.each([
    ["proof IDs", "native-metadata-proof-drift", { proofIds: ["PROOF-native-metadata-proof-drift-mutated"] }],
    ["bundle hash", "native-metadata-hash-drift", { bundleHash: "0".repeat(64) }],
  ] as const)("refuses native task source metadata drift in %s", async (_kind, suffix, patch) => {
    const source = bundle(h.rootDir(), suffix);
    await importCccPrdBundle(
      request(source, `idem-${suffix}`, policyFor(source)),
    );
    await h.layer().db.execute(sql`
      UPDATE project.tasks
      SET source_metadata = source_metadata || ${JSON.stringify(patch)}::jsonb
      WHERE id = ${`TASK-${suffix}`}
    `);

    const restarted = new TaskStore(
      h.rootDir(),
      undefined,
      { asyncLayer: h.layer() },
    ) as unknown as CampaignContextStore;
    await expect(
      restarted.getCccCampaignContextForTask(`TASK-${suffix}`),
    ).rejects.toMatchObject({
      name: "CccCampaignContextError",
      code: "CCC_CAMPAIGN_CONTEXT_REFUSED",
    });
  });

  it("fails closed with a typed refusal when persisted campaign custody is malformed", async () => {
    const source = bundle(h.rootDir(), "malformed-custody");
    await importCccPrdBundle(
      request(source, "idem-malformed-custody", policyFor(source)),
    );
    await h.layer().db.execute(sql`
      UPDATE project.ccc_prd_imports
      SET campaign_manifest = '{}'::jsonb
      WHERE idempotency_key = ${"idem-malformed-custody"}
    `);

    const restarted = new TaskStore(
      h.rootDir(),
      undefined,
      { asyncLayer: h.layer() },
    ) as unknown as CampaignContextStore;
    await expect(
      restarted.getCccCampaignContextForTask("TASK-malformed-custody"),
    ).rejects.toMatchObject({
      name: "CccCampaignContextError",
      code: "CCC_CAMPAIGN_CONTEXT_REFUSED",
    });
  });

  it("refuses restart custody after an admitted symlink target is retargeted", async () => {
    const linkPath = join(h.rootDir(), "campaign-target-link");
    const retargetPath = join(h.rootDir(), "retargeted-campaign-root");
    await symlink(h.rootDir(), linkPath, "dir");
    try {
      const source = bundle(linkPath, "symlink-retarget");
      await importCccPrdBundle({
        ...request(source, "idem-symlink-retarget", policyFor(source)),
        rootDir: linkPath,
      });
      const restarted = new TaskStore(
        linkPath,
        undefined,
        { asyncLayer: h.layer() },
      ) as unknown as CampaignContextStore;
      await mkdir(retargetPath);
      await unlink(linkPath);
      await symlink(retargetPath, linkPath, "dir");

      await expect(
        restarted.getCccCampaignContextForTask("TASK-symlink-retarget"),
      ).rejects.toMatchObject({
        name: "CccCampaignContextError",
        code: "CCC_CAMPAIGN_CONTEXT_REFUSED",
      });
    } finally {
      await unlink(linkPath).catch(() => {});
    }
  });

  it("refuses a shifted persisted campaign window even when its duration is preserved", async () => {
    const source = bundle(h.rootDir(), "shifted-window");
    await importCccPrdBundle(
      request(source, "idem-shifted-window", policyFor(source)),
    );
    const admitted = await (h.store() as unknown as CampaignContextStore)
      .getCccCampaignContextForTask("TASK-shifted-window");
    const shiftedStart = new Date(
      Date.parse(admitted!.campaignStartedAt) + 1_000,
    ).toISOString();
    const shiftedDeadline = new Date(
      Date.parse(admitted!.campaignDeadlineAt) + 1_000,
    ).toISOString();
    await h.layer().db.execute(sql`
      UPDATE project.ccc_prd_imports
      SET
        campaign_started_at = ${shiftedStart},
        campaign_deadline_at = ${shiftedDeadline}
      WHERE idempotency_key = ${"idem-shifted-window"}
    `);

    const restarted = new TaskStore(
      h.rootDir(),
      undefined,
      { asyncLayer: h.layer() },
    ) as unknown as CampaignContextStore;
    await expect(
      restarted.getCccCampaignContextForTask("TASK-shifted-window"),
    ).rejects.toMatchObject({
      name: "CccCampaignContextError",
      code: "CCC_CAMPAIGN_CONTEXT_REFUSED",
    });
  });

  it("releases its projection claim when the physical root drifts immediately after claim", async () => {
    const linkPath = join(h.rootDir(), "claimed-target-link");
    const retargetPath = join(h.rootDir(), "claimed-retarget-root");
    await symlink(h.rootDir(), linkPath, "dir");
    let announceClaim!: () => void;
    let releaseClaim!: () => void;
    const claimed = new Promise<void>((resolveClaimed) => {
      announceClaim = resolveClaimed;
    });
    const holdClaim = new Promise<void>((resolveHeld) => {
      releaseClaim = resolveHeld;
    });
    try {
      const source = bundle(linkPath, "claimed-retarget");
      const importing = importCccPrdBundle({
        ...request(source, "idem-claimed-retarget", policyFor(source)),
        rootDir: linkPath,
        failureInjection: {
          pause: {
            checkpoint: "after_projection_claim",
            entered: announceClaim,
            until: holdClaim,
          },
        },
      });
      await claimed;
      await mkdir(retargetPath);
      await unlink(linkPath);
      await symlink(retargetPath, linkPath, "dir");
      releaseClaim();
      await expect(importing).rejects.toMatchObject({
        code: "CCC_PRD_IMPORT_ROOT_MISMATCH",
      });
      const rows = await h.layer().db.execute(sql`
        SELECT state, runnable, projection_owner
        FROM project.ccc_prd_imports
        WHERE idempotency_key = ${"idem-claimed-retarget"}
      `);
      expect(rows).toEqual([{
        state: "prepared",
        runnable: 0,
        projection_owner: null,
      }]);
    } finally {
      releaseClaim?.();
      await unlink(linkPath).catch(() => {});
    }
  });

  it("refuses reconciliation of an explicitly unadmitted legacy campaign row", async () => {
    const source = bundle(h.rootDir(), "unadmitted-reconcile");
    await importCccPrdBundle(
      request(source, "idem-unadmitted-reconcile", policyFor(source)),
    );
    await h.layer().db.execute(sql`
      UPDATE project.ccc_prd_imports
      SET
        state = 'prepared',
        runnable = 0,
        projection_owner = NULL,
        projection_lease_until = NULL,
        execution_policy = ${JSON.stringify({
          schema: "ccc-campaign.execution-policy.unadmitted.v0",
          routes: [],
        })}::jsonb,
        campaign_manifest = ${JSON.stringify({
          schema: "ccc-campaign.manifest.unadmitted.v0",
        })}::jsonb
      WHERE idempotency_key = ${"idem-unadmitted-reconcile"}
    `);

    await expect(reconcileCccPrdImport({
      idempotencyKey: "idem-unadmitted-reconcile",
      store: h.store(),
      layer: h.layer(),
      rootDir: h.rootDir(),
    })).rejects.toMatchObject({
      code: "CCC_PRD_IMPORT_CAMPAIGN_CUSTODY_REFUSED",
    });
    const rows = await h.layer().db.execute(sql`
      SELECT state, runnable, projection_owner
      FROM project.ccc_prd_imports
      WHERE idempotency_key = ${"idem-unadmitted-reconcile"}
    `);
    expect(rows).toEqual([{
      state: "prepared",
      runnable: 0,
      projection_owner: null,
    }]);
  });
});
