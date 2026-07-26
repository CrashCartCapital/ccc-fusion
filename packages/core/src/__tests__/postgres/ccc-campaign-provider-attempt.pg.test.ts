/**
 * Task 4 RED proof: provider admission is persisted before a provider call.
 *
 * The production surface is intentionally cast locally so this suite reaches
 * the real PostgreSQL store and fails on absent runtime methods, not imports.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { importCccPrdBundle } from "../../index.js";
import { TaskStore } from "../../store.js";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import {
  createCccPrdImportTestBundle as bundle,
  createCccPrdImportTestExecutionPolicy,
  rehashCccPrdImportTestBundle,
} from "../../__test-utils__/ccc-prd-import-fixture.js";

type ProviderAttemptRequest = Readonly<{
  taskId: string;
  actionId: string;
  actionTarget: string;
  turnKey: string;
  attemptOrdinal: number;
  providerId: string;
  modelId: string;
  transport: "pi" | "cli" | "workflow";
}>;

type ProviderAttemptTransition = Readonly<{
  taskId: string;
  attemptKey: string;
  controllerToken: string;
}>;

type ProviderAttemptScope = Readonly<{
  attemptKey: string;
  controllerToken: string;
  taskId: string;
  semanticTaskId: string;
  campaignDeadlineAt: string;
  turnKey: string;
  attemptOrdinal: number;
  requestCount: number;
  state: "reserved" | "dispatched_unknown" | "committed" | "proved_failed";
  binding: Readonly<{
    actionId: string;
    actionTarget: string;
    providerId: string;
    modelId: string;
    transport: "pi" | "cli" | "workflow";
    packetHash: string;
    sidecarHash: string;
    bundleHash: string;
    manifestHash: string;
    bindingHash: string;
  }>;
}>;

type ProviderAttemptStore = {
  reserveCccProviderAttempt(input: ProviderAttemptRequest): Promise<ProviderAttemptScope>;
  markCccProviderAttemptDispatched(input: ProviderAttemptTransition): Promise<ProviderAttemptScope>;
  proveCccProviderAttemptNotDispatched(input: ProviderAttemptTransition): Promise<ProviderAttemptScope>;
  reconcileCccProviderAttempt(input: ProviderAttemptTransition & {
    outcome: "committed" | "proved_failed";
    evidenceDigest: string;
    observerId: string;
  }): Promise<ProviderAttemptScope>;
  inspectCccProviderAttempt(input: Pick<ProviderAttemptTransition, "taskId" | "attemptKey">): Promise<ProviderAttemptScope | null>;
};

const api = (store: TaskStore): ProviderAttemptStore => store as unknown as ProviderAttemptStore;

pgDescribe("CCC campaign provider-attempt admission (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_ccc_provider_attempt" });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  async function context(
    suffix: string,
    bounds: Readonly<{ maxRequests: number; maxDurationMs: number; maxConcurrency: number }> = {
      maxRequests: 3, maxDurationMs: 60_000, maxConcurrency: 1,
    },
  ) {
    const source = rehashCccPrdImportTestBundle({
      ...bundle(h.rootDir(), suffix),
      bounds,
    });
    await importCccPrdBundle({
      bundle: source,
      idempotencyKey: `provider-attempt-${suffix}`,
      store: h.store(),
      layer: h.layer(),
      rootDir: h.rootDir(),
      executionPolicy: createCccPrdImportTestExecutionPolicy(source),
    });
    const taskId = `TASK-${suffix}`;
    const campaign = await h.store().getCccCampaignContextForTask(taskId);
    if (!campaign) throw new Error(`missing campaign context for ${taskId}`);
    return { taskId, campaign, source };
  }

  function request(
    taskId: string,
    actionTarget: string,
    turnKey: string,
    attemptOrdinal: number,
    route: Partial<Pick<ProviderAttemptRequest, "providerId" | "modelId" | "transport">> = {},
  ): ProviderAttemptRequest {
    return {
      taskId,
      actionId: taskId,
      actionTarget,
      turnKey,
      attemptOrdinal,
      providerId: route.providerId ?? "deterministic-fake",
      modelId: route.modelId ?? "fixture-v1",
      transport: route.transport ?? "pi",
    };
  }

  async function auditRows() {
    return h.layer().db.execute(sql`
      SELECT timestamp, mutation_type, campaign_provider_id, campaign_model_id,
        campaign_transport, campaign_packet_hash, campaign_sidecar_hash,
        campaign_bundle_hash, campaign_manifest_hash, campaign_binding_hash
      FROM project.run_audit_events
      WHERE mutation_type LIKE 'ccc-campaign:provider-attempt:%'
      ORDER BY timestamp ASC
    `);
  }

  async function persistedRequestCount(importId: string): Promise<number> {
    const rows = await h.layer().db.execute(sql`
      SELECT request_count::int AS request_count
      FROM project.ccc_prd_imports
      WHERE import_id = ${importId}
    `) as unknown as Array<{ request_count: number }>;
    expect(rows).toHaveLength(1);
    return rows[0]!.request_count;
  }

  function mutateReturnedScope(scope: ProviderAttemptScope) {
    const mutable = scope as unknown as {
      state: string;
      turnKey: string;
      binding: {
        providerId: string;
        modelId: string;
        actionTarget: string;
        packetHash: string;
      };
    };
    for (const mutate of [
      () => { mutable.state = "committed"; },
      () => { mutable.turnKey = "turn-mutated"; },
      () => { mutable.binding.providerId = "provider-mutated"; },
      () => { mutable.binding.modelId = "model-mutated"; },
      () => { mutable.binding.actionTarget = `${h.rootDir()}-mutated`; },
      () => { mutable.binding.packetHash = "0".repeat(64); },
    ]) {
      try {
        mutate();
      } catch {
        // Frozen snapshots reject mutation in strict mode; mutable snapshots reveal the RED.
      }
    }
  }

  it("reserves all named TaskStore methods, replays a lost reservation byte-identically, and persists one admission event", async () => {
    const store = api(h.store());
    expect(typeof store.reserveCccProviderAttempt).toBe("function");
    expect(typeof store.markCccProviderAttemptDispatched).toBe("function");
    expect(typeof store.proveCccProviderAttemptNotDispatched).toBe("function");
    expect(typeof store.reconcileCccProviderAttempt).toBe("function");
    expect(typeof store.inspectCccProviderAttempt).toBe("function");

    const { taskId, campaign } = await context("replay");
    // The fixture declares no protected action. Its task import intent is the
    // exact non-protected action identity: TASK-replay targeting rootDir.
    const input = request(taskId, h.rootDir(), "turn-replay", 1);
    const first = await store.reserveCccProviderAttempt(input);
    const replay = await store.reserveCccProviderAttempt(input);
    expect(replay).toEqual(first);
    expect(JSON.stringify(replay)).toBe(JSON.stringify(first));
    const restarted = api(new TaskStore(h.rootDir(), undefined, { asyncLayer: h.layer() }));
    const inspected = await restarted.inspectCccProviderAttempt({
      taskId,
      attemptKey: first.attemptKey,
    });
    expect(inspected).toEqual(first);
    expect(JSON.stringify(inspected)).toBe(JSON.stringify(first));
    expect(first.attemptKey).toMatch(/^ccc-provider-attempt-[0-9a-f]{64}$/);
    expect(first.controllerToken).toMatch(/^ccc-provider-controller-[0-9a-f-]{36}$/);
    expect(first.taskId).toBe(taskId);
    expect(first.semanticTaskId).toBe(campaign.semanticTaskId);
    expect(first.campaignDeadlineAt).toBe(campaign.campaignDeadlineAt);
    expect(first.attemptOrdinal).toBe(1);
    expect(first.requestCount).toBe(1);
    expect(await persistedRequestCount(campaign.importId)).toBe(1);
    expect(first.binding).toMatchObject({
      actionId: taskId,
      actionTarget: h.rootDir(),
      providerId: campaign.route.providerId,
      modelId: campaign.route.modelId,
      transport: campaign.route.transport,
      packetHash: campaign.packetHash,
      sidecarHash: campaign.sidecarHash,
      bundleHash: campaign.bundleHash,
      manifestHash: campaign.manifestHash,
    });
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      campaign_provider_id: "deterministic-fake",
      campaign_model_id: "fixture-v1",
      campaign_transport: "pi",
      campaign_packet_hash: campaign.packetHash,
      campaign_sidecar_hash: campaign.sidecarHash,
      campaign_bundle_hash: campaign.bundleHash,
      campaign_manifest_hash: campaign.manifestHash,
      campaign_binding_hash: first.binding.bindingHash,
    });
  });

  it("returns immutable provider-attempt authority snapshots without changing persisted bytes", async () => {
    const { taskId } = await context("immutable-scope");
    const store = api(h.store());
    const reserved = await store.reserveCccProviderAttempt(request(taskId, h.rootDir(), "turn-immutable", 1));
    const reservedBytes = JSON.stringify(reserved);
    const transition = {
      taskId,
      attemptKey: reserved.attemptKey,
      controllerToken: reserved.controllerToken,
    };

    mutateReturnedScope(reserved);

    expect.soft(Object.isFrozen(reserved)).toBe(true);
    expect.soft(Object.isFrozen(reserved.binding)).toBe(true);
    expect.soft(JSON.stringify(reserved)).toBe(reservedBytes);

    const dispatched = await store.markCccProviderAttemptDispatched(transition);
    const dispatchedBytes = JSON.stringify(dispatched);

    mutateReturnedScope(dispatched);

    expect.soft(Object.isFrozen(dispatched)).toBe(true);
    expect.soft(Object.isFrozen(dispatched.binding)).toBe(true);
    expect.soft(JSON.stringify(dispatched)).toBe(dispatchedBytes);

    const restarted = api(new TaskStore(h.rootDir(), undefined, { asyncLayer: h.layer() }));
    const inspected = await restarted.inspectCccProviderAttempt({
      taskId,
      attemptKey: transition.attemptKey,
    });
    expect(inspected).toEqual(JSON.parse(dispatchedBytes));
    expect(JSON.stringify(inspected)).toBe(dispatchedBytes);
  });

  it("admits exactly one concurrent reservation at maxConcurrency and records only its event", async () => {
    const { taskId } = await context("concurrent");
    const store = api(h.store());
    const outcomes = await Promise.allSettled([
      store.reserveCccProviderAttempt(request(taskId, h.rootDir(), "turn-winner", 1)),
      store.reserveCccProviderAttempt(request(taskId, h.rootDir(), "turn-loser", 1)),
    ]);
    const winners = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const losers = outcomes.filter((outcome) => outcome.status === "rejected");
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]).toMatchObject({ reason: expect.objectContaining({ code: "CCC_PROVIDER_ATTEMPT_LIMIT_REFUSED", reason: "max-concurrency" }) });
    expect(await auditRows()).toHaveLength(1);
  });

  it("collision-refuses a changed action target for one logical attempt without another audit or request", async () => {
    const { taskId, campaign } = await context("action-collision");
    const store = api(h.store());
    await store.reserveCccProviderAttempt(request(taskId, h.rootDir(), "turn-action", 1));
    await expect(store.reserveCccProviderAttempt(
      request(taskId, `${h.rootDir()}-changed`, "turn-action", 1),
    )).rejects.toMatchObject({ code: "CCC_PROVIDER_ATTEMPT_COLLISION" });
    expect(await auditRows()).toHaveLength(1);
    expect(await persistedRequestCount(campaign.importId)).toBe(1);
  });

  it("refuses provider route drift before writing an audit event or incrementing request_count", async () => {
    const { taskId, campaign } = await context("route-drift");
    const store = api(h.store());
    await expect(store.reserveCccProviderAttempt(request(taskId, h.rootDir(), "turn-route", 1, {
      modelId: "fixture-v2",
    }))).rejects.toMatchObject({
      code: "CCC_PROVIDER_ATTEMPT_IDENTITY_REFUSED",
      reason: "route-drift",
    });
    expect(await auditRows()).toHaveLength(0);
    expect(await persistedRequestCount(campaign.importId)).toBe(0);
  });

  it("refuses a third reservation after two proved-not-dispatched attempts at maxRequests", async () => {
    const { taskId, campaign } = await context("max-requests", {
      maxRequests: 2, maxDurationMs: 60_000, maxConcurrency: 1,
    });
    const store = api(h.store());
    for (const [turnKey, attemptOrdinal] of [["turn-one", 1], ["turn-two", 2]] as const) {
      const attempt = await store.reserveCccProviderAttempt(request(taskId, h.rootDir(), turnKey, attemptOrdinal));
      await store.proveCccProviderAttemptNotDispatched({
        taskId, attemptKey: attempt.attemptKey, controllerToken: attempt.controllerToken,
      });
    }
    await expect(store.reserveCccProviderAttempt(request(taskId, h.rootDir(), "turn-three", 3))).rejects.toMatchObject({
      code: "CCC_PROVIDER_ATTEMPT_LIMIT_REFUSED",
      reason: "max-requests",
    });
    expect(await persistedRequestCount(campaign.importId)).toBe(2);
  });

  it("refuses a non-next attempt ordinal after a terminal attempt without another audit or request", async () => {
    const { taskId, campaign } = await context("ordinal", {
      maxRequests: 3, maxDurationMs: 60_000, maxConcurrency: 1,
    });
    const store = api(h.store());
    const first = await store.reserveCccProviderAttempt(request(taskId, h.rootDir(), "turn-one", 1));
    await store.proveCccProviderAttemptNotDispatched({
      taskId, attemptKey: first.attemptKey, controllerToken: first.controllerToken,
    });
    expect(await auditRows()).toHaveLength(2);
    await expect(store.reserveCccProviderAttempt(
      request(taskId, h.rootDir(), "turn-skipped", 3),
    )).rejects.toMatchObject({
      code: "CCC_PROVIDER_ATTEMPT_IDENTITY_REFUSED",
      reason: "invalid-input",
    });
    expect(await auditRows()).toHaveLength(2);
    expect(await persistedRequestCount(campaign.importId)).toBe(1);
  });

  it("uses the database clock to refuse a reservation after the campaign deadline", async () => {
    const { taskId, campaign } = await context("deadline", {
      maxRequests: 2, maxDurationMs: 1, maxConcurrency: 1,
    });
    await h.layer().db.execute(sql`SELECT pg_sleep(0.01)`);
    await expect(api(h.store()).reserveCccProviderAttempt(
      request(taskId, h.rootDir(), "turn-deadline", 1),
    )).rejects.toMatchObject({
      code: "CCC_PROVIDER_ATTEMPT_LIMIT_REFUSED",
      reason: "deadline",
    });
    expect(await auditRows()).toHaveLength(0);
    expect(await persistedRequestCount(campaign.importId)).toBe(0);
  });

  it("keeps dispatched-unknown across restart, releases only after authoritative committed reconciliation, and advances ordinal", async () => {
    const { taskId } = await context("restart");
    const store = api(h.store());
    const firstInput = request(taskId, h.rootDir(), "turn-one", 1);
    const first = await store.reserveCccProviderAttempt(firstInput);
    const transition = { taskId, attemptKey: first.attemptKey, controllerToken: first.controllerToken };
    const dispatched = await store.markCccProviderAttemptDispatched(transition);
    const restarted = api(new TaskStore(h.rootDir(), undefined, { asyncLayer: h.layer() }));
    await expect(restarted.inspectCccProviderAttempt({
      taskId,
      attemptKey: first.attemptKey,
    })).resolves.toEqual(dispatched);
    await expect(restarted.reserveCccProviderAttempt(request(taskId, h.rootDir(), "turn-two", 2))).rejects.toMatchObject({
      code: "CCC_PROVIDER_ATTEMPT_LIMIT_REFUSED",
      reason: "max-concurrency",
    });
    await restarted.reconcileCccProviderAttempt({
      ...transition,
      outcome: "committed",
      evidenceDigest: "b".repeat(64),
      observerId: "provider-observer-committed",
    });
    const second = await restarted.reserveCccProviderAttempt(request(taskId, h.rootDir(), "turn-two", 2));
    expect(second.attemptOrdinal).toBe(2);
    expect(second.requestCount).toBe(2);
  });

  it("only proves reserved attempts as not dispatched and collision-refuses changed terminal reconciliation", async () => {
    const { taskId } = await context("terminal");
    const store = api(h.store());
    const reservedInput = request(taskId, h.rootDir(), "turn-reserved", 1);
    const reserved = await store.reserveCccProviderAttempt(reservedInput);
    const reservedTransition = {
      taskId, attemptKey: reserved.attemptKey, controllerToken: reserved.controllerToken,
    };
    const preDispatch = await store.proveCccProviderAttemptNotDispatched(reservedTransition);
    expect(preDispatch).toMatchObject({ state: "proved_failed" });
    await expect(store.proveCccProviderAttemptNotDispatched(reservedTransition)).resolves.toEqual(preDispatch);

    const dispatchedInput = request(taskId, h.rootDir(), "turn-dispatched", 2);
    const dispatched = await store.reserveCccProviderAttempt(dispatchedInput);
    const transition = { taskId, attemptKey: dispatched.attemptKey, controllerToken: dispatched.controllerToken };
    await store.markCccProviderAttemptDispatched(transition);
    await expect(store.proveCccProviderAttemptNotDispatched(transition)).rejects.toMatchObject({
      code: "CCC_PROVIDER_ATTEMPT_STATE_REFUSED",
    });

    const first = await store.reconcileCccProviderAttempt({
      ...transition,
      outcome: "proved_failed",
      evidenceDigest: "a".repeat(64),
      observerId: "provider-observer-1",
    });
    await expect(store.proveCccProviderAttemptNotDispatched(transition)).rejects.toMatchObject({
      code: "CCC_PROVIDER_ATTEMPT_STATE_REFUSED",
    });
    await expect(store.reconcileCccProviderAttempt({
      ...transition,
      outcome: "proved_failed",
      evidenceDigest: "a".repeat(64),
      observerId: "provider-observer-1",
    })).resolves.toEqual(first);
    await expect(store.reconcileCccProviderAttempt({
      ...transition,
      outcome: "committed",
      evidenceDigest: "b".repeat(64),
      observerId: "provider-observer-2",
    })).rejects.toMatchObject({
      code: "CCC_RUN_AUDIT_EVENT_COLLISION",
    });
  });
});
