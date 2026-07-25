/**
 * Phase E native campaign persistence RED suite.
 *
 * This file deliberately names the desired TaskStore reader contract before
 * production adds it. Campaign context is derived from CCC PRD custody rows,
 * never supplied by a task caller or a second campaign store.
 */

import { beforeAll, beforeEach, afterAll, afterEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { importCccPrdBundle, reconcileCccPrdImport } from "../../index.js";
import { TaskStore } from "../../store.js";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import {
  createCccPrdImportTestBundle as bundle,
} from "../../__test-utils__/ccc-prd-import-fixture.js";
import type { CccPrdSemanticBundle } from "../../ccc-prd/types.js";

type ExecutionRoute = Readonly<{
  taskId: string;
  providerId: string;
  modelId: string;
  transport: "pi" | "cli" | "workflow";
}>;

type ExecutionPolicy = Readonly<{
  schema: "ccc-campaign.execution-policy.v1";
  routes: readonly ExecutionRoute[];
}>;

type CampaignContext = Readonly<{
  schema: "ccc-campaign.context.v1";
  projectId: string;
  importId: string;
  idempotencyKey: string;
  campaignId: string;
  taskId: string;
  packetHash: string;
  sidecarHash: string;
  bundleHash: string;
  manifestHash: string;
  sourceVersion: string;
  targetRepository: { path: string; baseCommit: string };
  bounds: { maxRequests: number; maxDurationMs: number; maxConcurrency: number };
  admittedWriteRoots: readonly { path: string; purpose: string }[];
  proofs: CccPrdSemanticBundle["proofs"];
  protectedActions: readonly unknown[];
  executionPolicy: ExecutionPolicy;
  route: ExecutionRoute;
  campaignStartedAt: string;
  campaignDeadlineAt: string;
  requestCount: number;
  activeActionLeases: Readonly<Record<string, unknown>>;
}>;

type CampaignContextStore = {
  getCccCampaignContextForTask(taskId: string): Promise<CampaignContext | null>;
};

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

describe("CCC campaign native public surface", () => {
  it("reserves the TaskStore campaign-context reader", () => {
    expect(typeof (TaskStore.prototype as unknown as Partial<CampaignContextStore>).getCccCampaignContextForTask).toBe("function");
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
      packetHash: source.sourceHash,
      sidecarHash: source.sidecarHash,
      bundleHash: source.bundleHash,
      manifestHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      sourceVersion: source.sourceVersion,
      targetRepository: source.targetRepository,
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
      executionPolicy,
      route: routesFor(source)[0],
    });
    expect(context).not.toMatchObject({
      campaignId: "caller-asserted",
      route: { providerId: "caller-asserted", modelId: "caller-asserted" },
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
