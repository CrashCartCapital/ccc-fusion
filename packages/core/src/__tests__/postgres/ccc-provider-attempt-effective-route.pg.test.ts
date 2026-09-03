/**
 * Effective-route and usage/cost receipt substrate — full persist-and-read-back
 * proof against a real PostgreSQL-backed campaign context.
 *
 * The pure accept/reject validation contract is proved without a database in
 * `../ccc-provider-attempt-effective-route.test.ts`; this suite additionally
 * proves the settlement round trip through `reconcileCccProviderAttempt` and
 * `inspectCccProviderAttempt` — reserve, dispatch, reconcile with an
 * effective-route receipt, then read it back byte-identically.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { importCccPrdBundle } from "../../index.js";
import {
  beginCccProviderAttemptDispatch,
  reconcileCccProviderAttempt,
  reserveCccProviderAttempt,
  inspectCccProviderAttempt,
} from "../../ccc-campaign/provider-attempt.js";
import { CccProviderAttemptIdentityError } from "../../ccc-campaign/types.js";
import { TaskStore } from "../../store.js";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import {
  createAdmittedCccPrdImportTestProductFixture,
  createCccPrdImportTestBundle as bundle,
  createCccPrdImportTestExecutionPolicy,
  createCccPrdImportTestProductExecutionPolicy,
  rehashCccPrdImportTestBundle,
  rehashCccPrdImportTestProductBundleV2,
} from "../../__test-utils__/ccc-prd-import-fixture.js";
import { sql } from "drizzle-orm";

pgDescribe("CCC provider-attempt effective-route settlement (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_ccc_provider_attempt_route" });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  async function nativeTaskIdForImport(importId: string, semanticTaskId: string): Promise<string> {
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

  async function context(suffix: string) {
    const source = rehashCccPrdImportTestBundle({
      ...bundle(h.rootDir(), suffix),
      bounds: { maxRequests: 3, maxDurationMs: 60_000, maxConcurrency: 1 },
    });
    const imported = await importCccPrdBundle({
      bundle: source,
      idempotencyKey: `provider-attempt-route-${suffix}`,
      store: h.store(),
      layer: h.layer(),
      rootDir: h.rootDir(),
      executionPolicy: createCccPrdImportTestExecutionPolicy(source),
    });
    const semanticTaskId = `TASK-${suffix}`;
    const taskId = await nativeTaskIdForImport(imported.importId, semanticTaskId);
    const campaign = await h.store().getCccCampaignContextForTask(taskId);
    if (!campaign) throw new Error(`missing campaign context for ${taskId}`);
    return { taskId, semanticTaskId, campaign, source };
  }

  async function reserveAndDispatch(taskId: string, turnKey: string) {
    const reserved = await reserveCccProviderAttempt({
      layer: h.layer(),
      rootDir: h.rootDir(),
      request: {
        taskId,
        actionId: taskId,
        actionTarget: h.rootDir(),
        turnKey,
        dispatchKey: `dispatch-${turnKey}`,
        providerId: "deterministic-fake",
        modelId: "fixture-v1",
        transport: "pi",
        workItemFence: { workItemId: `work-item-${turnKey}`, runId: `run-${turnKey}`, attempt: 1 },
      },
    });
    const decision = await beginCccProviderAttemptDispatch({
      layer: h.layer(),
      rootDir: h.rootDir(),
      transition: { taskId, attemptKey: reserved.attemptKey, controllerToken: reserved.controllerToken },
    });
    expect(decision.kind).toBe("dispatch-permit");
    return reserved;
  }

  async function adapterContext(suffix: string) {
    const admitted = await createAdmittedCccPrdImportTestProductFixture(h.rootDir(), suffix);
    const source = rehashCccPrdImportTestProductBundleV2({
      ...admitted.bundle,
      bounds: { maxRequests: 4, maxDurationMs: 60_000, maxConcurrency: 1 },
    });
    const executionPolicy = createCccPrdImportTestProductExecutionPolicy(source);
    executionPolicy.routes = executionPolicy.routes.map((route) => ({
      ...route,
      providerId: "arbitrary-gateway",
      modelId: "upstream/model-a",
      receiptAdapterId: "terminal-route-sse-comments.v1",
    }));
    const imported = await importCccPrdBundle({
      bundle: source,
      idempotencyKey: `provider-attempt-adapter-${suffix}`,
      store: h.store(),
      layer: h.layer(),
      rootDir: h.rootDir(),
      executionPolicy,
      semanticProofToolchainPaths: admitted.semanticProofToolchainPaths,
    });
    const semanticTaskId = `TASK-${suffix}`;
    const taskId = await nativeTaskIdForImport(imported.importId, semanticTaskId);
    const campaign = await h.store().getCccCampaignContextForTask(taskId);
    if (!campaign) throw new Error(`missing adapter campaign context for ${taskId}`);
    return { taskId, semanticTaskId, campaign };
  }

  async function twoTaskComboContext(suffix: string) {
    const admitted = await createAdmittedCccPrdImportTestProductFixture(h.rootDir(), suffix);
    const source = rehashCccPrdImportTestProductBundleV2({
      ...admitted.bundle,
      bounds: { maxRequests: 4, maxDurationMs: 60_000, maxConcurrency: 1 },
    });
    const executionPolicy = createCccPrdImportTestProductExecutionPolicy(source);
    executionPolicy.routes = executionPolicy.routes.map((route, index) => index === 0
      ? {
          ...route,
          providerId: "golden-omniroute-glm-latest",
          modelId: "combo/glm-latest",
          receiptAdapterId: "terminal-route-sse-comments.v1",
          terminalRouteMembers: [{ provider: "glm", model: "glm-5.3" }],
        }
      : {
          ...route,
          providerId: "golden-omniroute-minimax-latest",
          modelId: "combo/minimax-latest",
          receiptAdapterId: "terminal-route-sse-comments.v1",
          terminalRouteMembers: [{ provider: "minimax", model: "MiniMax-M3" }],
        });
    const imported = await importCccPrdBundle({
      bundle: source,
      idempotencyKey: `provider-attempt-combo-${suffix}`,
      store: h.store(),
      layer: h.layer(),
      rootDir: h.rootDir(),
      executionPolicy,
      semanticProofToolchainPaths: admitted.semanticProofToolchainPaths,
    });
    const firstSemanticTaskId = source.tasks[0]!.id;
    const secondSemanticTaskId = source.tasks[1]!.id;
    return {
      firstTaskId: await nativeTaskIdForImport(imported.importId, firstSemanticTaskId),
      firstSemanticTaskId,
      secondTaskId: await nativeTaskIdForImport(imported.importId, secondSemanticTaskId),
      secondSemanticTaskId,
    };
  }

  async function reserveAndDispatchAdapter(taskId: string, turnKey: string) {
    const reserved = await reserveCccProviderAttempt({
      layer: h.layer(),
      rootDir: h.rootDir(),
      request: {
        taskId,
        actionId: taskId,
        actionTarget: h.rootDir(),
        turnKey,
        dispatchKey: `dispatch-${turnKey}`,
        providerId: "arbitrary-gateway",
        modelId: "upstream/model-a",
        transport: "pi",
        workItemFence: { workItemId: `work-item-${turnKey}`, runId: `run-${turnKey}`, attempt: 1 },
      },
    });
    const decision = await beginCccProviderAttemptDispatch({
      layer: h.layer(),
      rootDir: h.rootDir(),
      transition: { taskId, attemptKey: reserved.attemptKey, controllerToken: reserved.controllerToken },
    });
    expect(decision.kind).toBe("dispatch-permit");
    return reserved;
  }

  it("RED-1: persists a settlement with a matching effective route, usage, and cost, and reads it back byte-identically", async () => {
    const { taskId } = await context("route-persist");
    const reserved = await reserveAndDispatch(taskId, "turn-route-persist");

    const terminal = await reconcileCccProviderAttempt({
      layer: h.layer(),
      rootDir: h.rootDir(),
      reconciliation: {
        taskId,
        attemptKey: reserved.attemptKey,
        controllerToken: reserved.controllerToken,
        outcome: "committed",
        evidenceDigest: "a".repeat(64),
        observerId: "settlement-worker",
        effectiveRoute: {
          effectiveProvider: "deterministic-fake",
          effectiveModel: "fixture-v1",
          effectiveReasoningEffort: "high",
          usage: { inputTokens: 321, outputTokens: 88 },
          cost: { amountUsd: 0.0789, source: "stream-usage" },
          receiptSource: "stream-usage",
        },
      },
    });

    expect(terminal.terminal).toMatchObject({
      kind: "reconciled",
      state: "committed",
      effectiveRoute: {
        effectiveProvider: "deterministic-fake",
        effectiveModel: "fixture-v1",
        effectiveReasoningEffort: "high",
        usage: { inputTokens: 321, outputTokens: 88 },
        cost: { amountUsd: 0.0789, source: "stream-usage" },
        receiptSource: "stream-usage",
      },
    });

    const inspected = await inspectCccProviderAttempt({
      layer: h.layer(),
      rootDir: h.rootDir(),
      taskId,
      attemptKey: reserved.attemptKey,
    });
    expect(inspected).toEqual(terminal);
    expect(JSON.stringify(inspected)).toBe(JSON.stringify(terminal));
  });

  it("RED-2: rejects a settlement whose effectiveModel differs from the requested route", async () => {
    const { taskId } = await context("route-mismatch");
    const reserved = await reserveAndDispatch(taskId, "turn-route-mismatch");

    await expect(reconcileCccProviderAttempt({
      layer: h.layer(),
      rootDir: h.rootDir(),
      reconciliation: {
        taskId,
        attemptKey: reserved.attemptKey,
        controllerToken: reserved.controllerToken,
        outcome: "committed",
        evidenceDigest: "b".repeat(64),
        observerId: "settlement-worker",
        effectiveRoute: {
          effectiveProvider: "deterministic-fake",
          effectiveModel: "wrong-model",
          usage: null,
          cost: { kind: "unknown", reason: "not applicable" },
          receiptSource: "none",
        },
      },
    })).rejects.toBeInstanceOf(CccProviderAttemptIdentityError);

    const inspected = await inspectCccProviderAttempt({
      layer: h.layer(), rootDir: h.rootDir(), taskId, attemptKey: reserved.attemptKey,
    });
    expect(inspected?.state).toBe("dispatched_unknown");
    expect(inspected?.terminal).toBeUndefined();
  });

  it("RED-3: rejects a settlement carrying a non-null fallbackReason", async () => {
    const { taskId } = await context("route-fallback");
    const reserved = await reserveAndDispatch(taskId, "turn-route-fallback");

    await expect(reconcileCccProviderAttempt({
      layer: h.layer(),
      rootDir: h.rootDir(),
      reconciliation: {
        taskId,
        attemptKey: reserved.attemptKey,
        controllerToken: reserved.controllerToken,
        outcome: "committed",
        evidenceDigest: "c".repeat(64),
        observerId: "settlement-worker",
        effectiveRoute: {
          effectiveProvider: "deterministic-fake",
          effectiveModel: "fixture-v1",
          fallbackReason: "primary provider timed out",
          usage: null,
          cost: { kind: "unknown", reason: "not applicable" },
          receiptSource: "none",
        },
      },
    })).rejects.toBeInstanceOf(CccProviderAttemptIdentityError);
  });

  it("RED-4: rejects a settlement claiming cost.amountUsd with usage null, naming the missing receipt", async () => {
    const { taskId } = await context("route-cost-no-usage");
    const reserved = await reserveAndDispatch(taskId, "turn-route-cost-no-usage");

    await expect(reconcileCccProviderAttempt({
      layer: h.layer(),
      rootDir: h.rootDir(),
      reconciliation: {
        taskId,
        attemptKey: reserved.attemptKey,
        controllerToken: reserved.controllerToken,
        outcome: "committed",
        evidenceDigest: "d".repeat(64),
        observerId: "settlement-worker",
        effectiveRoute: {
          effectiveProvider: "deterministic-fake",
          effectiveModel: "fixture-v1",
          usage: null,
          cost: { amountUsd: 1.23, source: "provider-api" },
          receiptSource: "provider-api",
        },
      },
    })).rejects.toThrow(/cannot claim a cost without/);
  });

  it("RED-5: accepts and persists a settlement with usage null and cost {kind: unknown, reason}", async () => {
    const { taskId } = await context("route-honest-unknown");
    const reserved = await reserveAndDispatch(taskId, "turn-route-honest-unknown");

    const terminal = await reconcileCccProviderAttempt({
      layer: h.layer(),
      rootDir: h.rootDir(),
      reconciliation: {
        taskId,
        attemptKey: reserved.attemptKey,
        controllerToken: reserved.controllerToken,
        outcome: "committed",
        evidenceDigest: "e".repeat(64),
        observerId: "settlement-worker",
        effectiveRoute: {
          effectiveProvider: "deterministic-fake",
          effectiveModel: "fixture-v1",
          usage: null,
          cost: { kind: "unknown", reason: "provider did not emit usage on this transport" },
          receiptSource: "none",
        },
      },
    });

    expect(terminal.terminal).toMatchObject({
      kind: "reconciled",
      effectiveRoute: {
        usage: null,
        cost: { kind: "unknown", reason: "provider did not emit usage on this transport" },
        receiptSource: "none",
      },
    });

    const inspected = await inspectCccProviderAttempt({
      layer: h.layer(), rootDir: h.rootDir(), taskId, attemptKey: reserved.attemptKey,
    });
    expect(inspected).toEqual(terminal);
  });

  it("reconciles without an effective route exactly as before (backward-compatible settlement)", async () => {
    const { taskId } = await context("route-legacy");
    const reserved = await reserveAndDispatch(taskId, "turn-route-legacy");

    const terminal = await reconcileCccProviderAttempt({
      layer: h.layer(),
      rootDir: h.rootDir(),
      reconciliation: {
        taskId,
        attemptKey: reserved.attemptKey,
        controllerToken: reserved.controllerToken,
        outcome: "committed",
        evidenceDigest: "f".repeat(64),
        observerId: "settlement-worker",
      },
    });

    expect(terminal.terminal).toEqual({
      kind: "reconciled",
      state: "committed",
      evidenceDigest: "f".repeat(64),
      observerId: "settlement-worker",
    });
  });

  it("RED-RECEIPT-RESTART-1: a fresh authority-store instance reloads adapter custody and reserves the next turn", async () => {
    const { taskId, campaign } = await adapterContext("receipt-restart");
    expect(campaign.route.receiptAdapterId).toBe("terminal-route-sse-comments.v1");
    const reserved = await reserveAndDispatchAdapter(taskId, "turn-receipt-restart-1");

    const terminal = await reconcileCccProviderAttempt({
      layer: h.layer(),
      rootDir: h.rootDir(),
      reconciliation: {
        taskId,
        attemptKey: reserved.attemptKey,
        controllerToken: reserved.controllerToken,
        outcome: "committed",
        evidenceDigest: "9".repeat(64),
        observerId: "receipt-restart-worker",
        effectiveRoute: {
          effectiveProvider: "arbitrary-gateway",
          effectiveModel: "upstream/model-a",
          usage: { inputTokens: 8, outputTokens: 5 },
          cost: { kind: "unknown", reason: "fixture pricing unavailable" },
          receiptSource: "stream-usage",
          omniRoute: { final: { provider: "upstream", model: "model-a" } },
        },
      },
    });

    const restarted = new TaskStore(h.rootDir(), undefined, { asyncLayer: h.layer() });
    await expect(restarted.getCccCampaignContextForTask(taskId)).resolves.toMatchObject({
      route: { receiptAdapterId: "terminal-route-sse-comments.v1" },
    });
    await expect(restarted.inspectCccProviderAttempt({
      taskId,
      attemptKey: reserved.attemptKey,
    })).resolves.toEqual(terminal);
    const next = await restarted.reserveCccProviderAttempt({
      taskId,
      actionId: taskId,
      actionTarget: h.rootDir(),
      turnKey: "turn-receipt-restart-2",
      dispatchKey: "dispatch-turn-receipt-restart-2",
      providerId: "arbitrary-gateway",
      modelId: "upstream/model-a",
      transport: "pi",
      workItemFence: {
        workItemId: "work-item-turn-receipt-restart-2",
        runId: "run-turn-receipt-restart-2",
        attempt: 1,
      },
    });
    await expect(restarted.beginCccProviderAttemptDispatch({
      taskId,
      attemptKey: next.attemptKey,
      controllerToken: next.controllerToken,
    })).resolves.toMatchObject({ kind: "dispatch-permit" });
    expect(next).toMatchObject({ state: "reserved", requestCount: 2 });
  });

  it("RED-G2-route-history-scope: sibling combo routes validate terminal receipts against their own task route", async () => {
    const { firstTaskId, secondTaskId } = await twoTaskComboContext("sibling-route-receipt");
    const first = await reserveCccProviderAttempt({
      layer: h.layer(),
      rootDir: h.rootDir(),
      request: {
        taskId: firstTaskId,
        actionId: firstTaskId,
        actionTarget: h.rootDir(),
        turnKey: "turn-sibling-route-receipt-glm",
        dispatchKey: "dispatch-sibling-route-receipt-glm",
        providerId: "golden-omniroute-glm-latest",
        modelId: "combo/glm-latest",
        transport: "pi",
        workItemFence: { workItemId: "work-item-sibling-route-receipt-glm", runId: "run-sibling-route-receipt", attempt: 1 },
      },
    });
    await expect(beginCccProviderAttemptDispatch({
      layer: h.layer(),
      rootDir: h.rootDir(),
      transition: { taskId: firstTaskId, attemptKey: first.attemptKey, controllerToken: first.controllerToken },
    })).resolves.toMatchObject({ kind: "dispatch-permit" });
    await expect(reconcileCccProviderAttempt({
      layer: h.layer(),
      rootDir: h.rootDir(),
      reconciliation: {
        taskId: firstTaskId,
        attemptKey: first.attemptKey,
        controllerToken: first.controllerToken,
        outcome: "committed",
        evidenceDigest: "7".repeat(64),
        observerId: "sibling-route-receipt-worker",
        effectiveRoute: {
          effectiveProvider: "golden-omniroute-glm-latest",
          effectiveModel: "combo/glm-latest",
          usage: { inputTokens: 8, outputTokens: 5 },
          cost: { kind: "unknown", reason: "fixture pricing unavailable" },
          receiptSource: "stream-usage",
          omniRoute: { final: { provider: "glm", model: "glm-5.3" } },
        },
      },
    })).resolves.toMatchObject({ state: "committed" });

    await expect(reserveCccProviderAttempt({
      layer: h.layer(),
      rootDir: h.rootDir(),
      request: {
        taskId: secondTaskId,
        actionId: secondTaskId,
        actionTarget: h.rootDir(),
        turnKey: "turn-sibling-route-receipt-minimax",
        dispatchKey: "dispatch-sibling-route-receipt-minimax",
        providerId: "golden-omniroute-minimax-latest",
        modelId: "combo/minimax-latest",
        transport: "pi",
        workItemFence: { workItemId: "work-item-sibling-route-receipt-minimax", runId: "run-sibling-route-receipt", attempt: 1 },
      },
    })).resolves.toMatchObject({
      state: "reserved",
      requestCount: 2,
      binding: {
        providerId: "golden-omniroute-minimax-latest",
        modelId: "combo/minimax-latest",
      },
    });
  });
});
