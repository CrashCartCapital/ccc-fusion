/**
 * Task 4 RED proof: provider admission is persisted before a provider call.
 *
 * The production surface is intentionally cast locally so this suite reaches
 * the real PostgreSQL store and fails on absent runtime methods, not imports.
 */
import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { importCccPrdBundle } from "../../index.js";
import {
  claimCccCampaignApproval,
  getApprovalRequest,
  issueCccCampaignApproval,
} from "../../async-approval-request-store.js";
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
import { canonicalCccPrdJson } from "../../ccc-prd/contract.js";
import type { ApprovalRequestActorSnapshot } from "../../types.js";

const providerWorker: ApprovalRequestActorSnapshot = {
  actorId: "provider-settlement-worker",
  actorType: "agent",
  actorName: "Provider settlement worker",
};

type ProviderAttemptRequest = Readonly<{
  taskId: string;
  actionId: string;
  actionTarget: string;
  turnKey: string;
  dispatchKey: string;
  providerId: string;
  modelId: string;
  transport: "pi" | "cli" | "workflow";
  workItemFence: WorkItemFence;
}>;

type WorkItemFence = Readonly<{
  workItemId: string;
  runId: string;
  attempt: number;
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
  dispatchKey: string;
  attemptOrdinal: number;
  requestCount: number;
  workItemFence: WorkItemFence | null;
  state: "reserved" | "dispatched_unknown" | "committed" | "proved_failed";
  terminal?:
    | Readonly<{ kind: "not-dispatched"; state: "proved_failed" }>
    | Readonly<{ kind: "reconciled"; state: "committed" | "proved_failed"; evidenceDigest: string; observerId: string }>;
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
  beginCccProviderAttemptDispatch(input: ProviderAttemptTransition): Promise<
    | Readonly<{ kind: "dispatch-permit"; scope: ProviderAttemptScope }>
    | Readonly<{ kind: "dispatched-unknown" | "terminal"; scope: ProviderAttemptScope }>
  >;
  markCccProviderAttemptDispatched(input: ProviderAttemptTransition): Promise<ProviderAttemptScope>;
  proveCccProviderAttemptNotDispatched(input: ProviderAttemptTransition): Promise<ProviderAttemptScope>;
  reconcileCccProviderAttempt(input: ProviderAttemptTransition & {
    outcome: "committed" | "proved_failed";
    evidenceDigest: string;
    observerId: string;
  }): Promise<ProviderAttemptScope>;
  inspectCccProviderAttempt(input: Pick<ProviderAttemptTransition, "taskId" | "attemptKey">): Promise<ProviderAttemptScope | null>;
  settleCccProviderAttemptAndApproval(input: ProviderAttemptTransition & {
    outcome: "committed" | "proved_failed";
    evidenceDigest: string;
    observerId: string;
  }): Promise<ProviderAttemptScope>;
};

const api = (store: TaskStore): ProviderAttemptStore => store as unknown as ProviderAttemptStore;

pgDescribe("CCC campaign provider-attempt admission (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_ccc_provider_attempt" });

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

  async function context(
    suffix: string,
    bounds: Readonly<{ maxRequests: number; maxDurationMs: number; maxConcurrency: number }> = {
      maxRequests: 3, maxDurationMs: 60_000, maxConcurrency: 1,
    },
    transport: "pi" | "cli" | "workflow" = "pi",
  ) {
    const source = rehashCccPrdImportTestBundle({
      ...bundle(h.rootDir(), suffix),
      bounds,
    });
    const imported = await importCccPrdBundle({
      bundle: source,
      idempotencyKey: `provider-attempt-${suffix}`,
      store: h.store(),
      layer: h.layer(),
      rootDir: h.rootDir(),
      executionPolicy: transport === "pi"
        ? createCccPrdImportTestExecutionPolicy(source)
        : {
            ...createCccPrdImportTestExecutionPolicy(source),
            routes: source.tasks.map(({ id }) => ({
              taskId: id, providerId: "deterministic-fake", modelId: "fixture-v1", transport,
            })),
          },
    });
    const semanticTaskId = `TASK-${suffix}`;
    const taskId = await nativeTaskIdForImport(imported.importId, semanticTaskId);
    const campaign = await h.store().getCccCampaignContextForTask(taskId);
    if (!campaign) throw new Error(`missing campaign context for ${taskId}`);
    expect(campaign).toMatchObject({ taskId, semanticTaskId });
    return { taskId, semanticTaskId, campaign, source };
  }

  async function protectedContext(suffix: string) {
    const initial = bundle(h.rootDir(), suffix);
    const action = {
      actionId: "ACTION-LIVE-EXECUTION",
      actionTarget: "ccc-lab-super:pre-live-provider-gate",
      requireProtected: true,
    };
    const source = rehashCccPrdImportTestBundle({
      ...initial,
      bounds: { maxRequests: 3, maxDurationMs: 60_000, maxConcurrency: 1 },
      tasks: initial.tasks.map((task, index) => index === 0
        ? { ...task, protectedActionIds: [action.actionId] }
        : task),
      protectedActions: [{
        id: action.actionId,
        kind: "live_execution",
        target: action.actionTarget,
        requiresOperatorDecision: true,
        operatorDecision: "approve_live_execution",
        spans: [initial.tasks[0]!.spans[0]!],
      }],
    });
    const imported = await importCccPrdBundle({
      bundle: source,
      idempotencyKey: `provider-attempt-protected-${suffix}`,
      store: h.store(),
      layer: h.layer(),
      rootDir: h.rootDir(),
      executionPolicy: createCccPrdImportTestExecutionPolicy(source),
    });
    const semanticTaskId = `TASK-${suffix}`;
    const taskId = await nativeTaskIdForImport(imported.importId, semanticTaskId);
    const campaign = await h.store().getCccCampaignContextForTask(taskId);
    if (!campaign) throw new Error(`missing protected campaign context for ${taskId}`);
    expect(campaign).toMatchObject({ taskId, semanticTaskId });
    const issued = await issueCccCampaignApproval(h.layer(), {
      authorityStore: h.store(), rootDir: h.rootDir(), taskId, action,
      requester: providerWorker, runId: `issue-provider-settlement-${suffix}`,
      notBeforeAt: campaign.campaignStartedAt, expiresAt: campaign.campaignDeadlineAt,
    });
    const claimToken = `claim-provider-settlement-${suffix}`;
    await claimCccCampaignApproval(h.layer(), {
      authorityStore: h.store(), rootDir: h.rootDir(), taskId, action,
      claimant: providerWorker, runId: `claim-provider-settlement-${suffix}`, claimToken,
    });
    return { taskId, semanticTaskId, action, issued, claimToken };
  }

  function request(
    taskId: string,
    actionTarget: string,
    turnKey: string,
    route: Partial<Pick<ProviderAttemptRequest, "actionId" | "providerId" | "modelId" | "transport">> = {},
  ): ProviderAttemptRequest {
    return {
      taskId,
      actionId: route.actionId ?? taskId,
      actionTarget,
      turnKey,
      dispatchKey: `dispatch-${turnKey}`,
      providerId: route.providerId ?? "deterministic-fake",
      modelId: route.modelId ?? "fixture-v1",
      transport: route.transport ?? "pi",
      workItemFence: {
        workItemId: `work-item-${turnKey}`,
        runId: `run-${turnKey}`,
        attempt: 1,
      },
    };
  }

  function legacyAttemptKey(
    campaign: Awaited<ReturnType<typeof context>>["campaign"],
    taskId: string,
    semanticTaskId: string,
    turnKey: string,
    dispatchKey: string,
  ): string {
    return `ccc-provider-attempt-${createHash("sha256")
      .update(`ccc-provider-attempt/v2\\0${canonicalCccPrdJson({
        projectId: campaign.projectId,
        importId: campaign.importId,
        campaignId: campaign.campaignId,
        taskId,
        semanticTaskId,
        turnKey,
        dispatchKey,
      })}`, "utf8")
      .digest("hex")}`;
  }

  function v3AttemptKey(
    campaign: Awaited<ReturnType<typeof context>>["campaign"],
    taskId: string,
    semanticTaskId: string,
    input: Pick<ProviderAttemptRequest, "turnKey" | "dispatchKey" | "workItemFence">,
  ): string {
    return `ccc-provider-attempt-${createHash("sha256")
      .update(`ccc-provider-attempt/v3\\0${canonicalCccPrdJson({
        projectId: campaign.projectId,
        importId: campaign.importId,
        campaignId: campaign.campaignId,
        taskId,
        semanticTaskId,
        turnKey: input.turnKey,
        dispatchKey: input.dispatchKey,
        workItemFence: input.workItemFence,
      })}`, "utf8")
      .digest("hex")}`;
  }

  async function auditRows() {
    return h.layer().db.execute(sql`
      SELECT timestamp, mutation_type, campaign_provider_id, campaign_model_id,
        campaign_transport, campaign_packet_hash, campaign_sidecar_hash,
        campaign_bundle_hash, campaign_manifest_hash, campaign_binding_hash,
        metadata
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
      workItemFence: { workItemId: string; runId: string; attempt: number };
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
      () => { mutable.workItemFence.attempt += 1; },
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

  async function dispatch(store: ProviderAttemptStore, transition: ProviderAttemptTransition): Promise<ProviderAttemptScope> {
    const decision = await store.beginCccProviderAttemptDispatch(transition);
    expect(decision.kind).toBe("dispatch-permit");
    return decision.scope;
  }

  it("reserves all named TaskStore methods, replays a lost reservation byte-identically, and persists one admission event", async () => {
    const store = api(h.store());
    expect(typeof store.reserveCccProviderAttempt).toBe("function");
    expect(typeof store.beginCccProviderAttemptDispatch).toBe("function");
    expect(typeof store.markCccProviderAttemptDispatched).toBe("function");
    expect(typeof store.proveCccProviderAttemptNotDispatched).toBe("function");
    expect(typeof store.reconcileCccProviderAttempt).toBe("function");
    expect(typeof store.inspectCccProviderAttempt).toBe("function");

    const { taskId, campaign } = await context("replay");
    // The fixture declares no protected action. Its task import intent is the
    // exact non-protected action identity: TASK-replay targeting rootDir.
    const input = request(taskId, h.rootDir(), "turn-replay");
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
    expect(first.workItemFence).toEqual(input.workItemFence);
    expect(Object.isFrozen(first.workItemFence)).toBe(true);
    expect(first.attemptKey).toBe(v3AttemptKey(
      campaign,
      taskId,
      campaign.semanticTaskId,
      input,
    ));
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
      metadata: expect.objectContaining({
        schema: "ccc-campaign.provider-attempt.v4",
        workItemFence: input.workItemFence,
      }),
    });
  });

  it("refuses audit history whose persisted attempt ordinal no longer matches its request count", async () => {
    const { taskId } = await context("ordinal-custody");
    const store = api(h.store());
    const reserved = await store.reserveCccProviderAttempt(request(taskId, h.rootDir(), "turn-ordinal-custody"));

    await h.layer().db.execute(sql`
      UPDATE project.run_audit_events
      SET metadata = jsonb_set(metadata, '{attemptOrdinal}', '2'::jsonb)
      WHERE metadata->>'attemptKey' = ${reserved.attemptKey}
    `);

    await expect(store.inspectCccProviderAttempt({ taskId, attemptKey: reserved.attemptKey }))
      .rejects.toMatchObject({ code: "CCC_CAMPAIGN_CONTEXT_REFUSED" });
  });

  it("refuses provider-attempt stages whose persisted work-item fence drifted", async () => {
    const { taskId } = await context("fence-stage-custody");
    const store = api(h.store());
    const reserved = await store.reserveCccProviderAttempt(request(taskId, h.rootDir(), "turn-fence-stage-custody"));
    await dispatch(store, {
      taskId,
      attemptKey: reserved.attemptKey,
      controllerToken: reserved.controllerToken,
    });
    await h.layer().db.execute(sql`
      UPDATE project.run_audit_events
      SET metadata = jsonb_set(metadata, '{workItemFence,attempt}', '2'::jsonb)
      WHERE metadata->>'attemptKey' = ${reserved.attemptKey}
        AND mutation_type = 'ccc-campaign:provider-attempt:dispatched'
    `);

    await expect(store.inspectCccProviderAttempt({ taskId, attemptKey: reserved.attemptKey }))
      .rejects.toMatchObject({ code: "CCC_CAMPAIGN_CONTEXT_REFUSED" });
  });

  it("allocates an ordinal in the store and grants only one dispatch permit after a lost reservation response", async () => {
    const { taskId, campaign } = await context("store-owned-dispatch", {
      maxRequests: 3, maxDurationMs: 60_000, maxConcurrency: 2,
    });
    const store = api(h.store());
    const input = request(taskId, h.rootDir(), "turn-owned");
    const first = await store.reserveCccProviderAttempt(input);
    const replay = await api(new TaskStore(h.rootDir(), undefined, { asyncLayer: h.layer() }))
      .reserveCccProviderAttempt(input);
    expect(replay).toEqual(first);
    expect(first).toMatchObject({ attemptOrdinal: 1, requestCount: 1, dispatchKey: "dispatch-turn-owned" });
    expect(await persistedRequestCount(campaign.importId)).toBe(1);

    const transition = { taskId, attemptKey: first.attemptKey, controllerToken: first.controllerToken };
    const decisions = await Promise.all([
      store.beginCccProviderAttemptDispatch(transition),
      store.beginCccProviderAttemptDispatch(transition),
    ]);
    expect(decisions.filter((decision) => decision.kind === "dispatch-permit")).toHaveLength(1);
    expect(decisions.filter((decision) => decision.kind === "dispatched-unknown")).toHaveLength(1);
    const restarted = api(new TaskStore(h.rootDir(), undefined, { asyncLayer: h.layer() }));
    await expect(restarted.beginCccProviderAttemptDispatch(transition)).resolves.toMatchObject({ kind: "dispatched-unknown" });
  });

  it("returns immutable provider-attempt authority snapshots without changing persisted bytes", async () => {
    const { taskId } = await context("immutable-scope");
    const store = api(h.store());
    const reserved = await store.reserveCccProviderAttempt(request(taskId, h.rootDir(), "turn-immutable"));
    const reservedBytes = JSON.stringify(reserved);
    const transition = {
      taskId,
      attemptKey: reserved.attemptKey,
      controllerToken: reserved.controllerToken,
    };

    mutateReturnedScope(reserved);

    expect.soft(Object.isFrozen(reserved)).toBe(true);
    expect.soft(Object.isFrozen(reserved.binding)).toBe(true);
    expect.soft(Object.isFrozen(reserved.workItemFence)).toBe(true);
    expect.soft(JSON.stringify(reserved)).toBe(reservedBytes);

    const dispatched = await dispatch(store, transition);
    const dispatchedBytes = JSON.stringify(dispatched);

    mutateReturnedScope(dispatched);

    expect.soft(Object.isFrozen(dispatched)).toBe(true);
    expect.soft(Object.isFrozen(dispatched.binding)).toBe(true);
    expect.soft(Object.isFrozen(dispatched.workItemFence)).toBe(true);
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
      store.reserveCccProviderAttempt(request(taskId, h.rootDir(), "turn-winner")),
      store.reserveCccProviderAttempt(request(taskId, h.rootDir(), "turn-loser")),
    ]);
    const winners = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const losers = outcomes.filter((outcome) => outcome.status === "rejected");
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]).toMatchObject({ reason: expect.objectContaining({ code: "CCC_PROVIDER_ATTEMPT_LIMIT_REFUSED", reason: "max-concurrency" }) });
    expect(await auditRows()).toHaveLength(1);
  });

  it("allocates unique contiguous store-owned ordinals for concurrent distinct dispatch keys", async () => {
    const { taskId, campaign } = await context("concurrent-ordinals", {
      maxRequests: 3, maxDurationMs: 60_000, maxConcurrency: 2,
    });
    const results = await Promise.all([
      api(h.store()).reserveCccProviderAttempt(request(taskId, h.rootDir(), "turn-one")),
      api(h.store()).reserveCccProviderAttempt(request(taskId, h.rootDir(), "turn-two")),
    ]);
    expect(results.map((result) => result.attemptOrdinal).sort()).toEqual([1, 2]);
    expect(results.map((result) => result.requestCount).sort()).toEqual([1, 2]);
    expect(await persistedRequestCount(campaign.importId)).toBe(2);
  });

  it("collision-refuses a changed action target for one logical attempt without another audit or request", async () => {
    const { taskId, campaign } = await context("action-collision");
    const store = api(h.store());
    await store.reserveCccProviderAttempt(request(taskId, h.rootDir(), "turn-action"));
    await expect(store.reserveCccProviderAttempt(
      request(taskId, `${h.rootDir()}-changed`, "turn-action"),
    )).rejects.toMatchObject({ code: "CCC_PROVIDER_ATTEMPT_COLLISION" });
    expect(await auditRows()).toHaveLength(1);
    expect(await persistedRequestCount(campaign.importId)).toBe(1);
  });

  it("collision-refuses changed route for one stable dispatch key without another audit or request", async () => {
    const { taskId, campaign } = await context("route-collision");
    const store = api(h.store());
    await store.reserveCccProviderAttempt(request(taskId, h.rootDir(), "turn-route"));
    await expect(store.reserveCccProviderAttempt(request(taskId, h.rootDir(), "turn-route", { modelId: "fixture-v2" })))
      .rejects.toMatchObject({ code: "CCC_PROVIDER_ATTEMPT_COLLISION" });
    expect(await auditRows()).toHaveLength(1);
    expect(await persistedRequestCount(campaign.importId)).toBe(1);
  });

  it("collision-refuses a changed work-item fence for one logical provider effect without another audit or request", async () => {
    const { taskId, campaign } = await context("fence-collision");
    const store = api(h.store());
    const input = request(taskId, h.rootDir(), "turn-fence-collision");
    const first = await store.reserveCccProviderAttempt(input);

    await expect(store.reserveCccProviderAttempt({
      ...input,
      workItemFence: { ...input.workItemFence, attempt: input.workItemFence.attempt + 1 },
    })).rejects.toMatchObject({ code: "CCC_PROVIDER_ATTEMPT_COLLISION" });

    expect(await auditRows()).toHaveLength(1);
    expect(await persistedRequestCount(campaign.importId)).toBe(1);
    await expect(store.inspectCccProviderAttempt({ taskId, attemptKey: first.attemptKey }))
      .resolves.toMatchObject({ workItemFence: input.workItemFence });
  });

  it("reads exact legacy-v2 history as explicitly unfenced and blocks a v3 reservation for the same logical effect", async () => {
    const { taskId, semanticTaskId, campaign } = await context("legacy-v2-visible");
    const store = api(h.store());
    const input = request(taskId, h.rootDir(), "turn-legacy-v2-visible");
    const current = await store.reserveCccProviderAttempt(input);
    await dispatch(store, {
      taskId,
      attemptKey: current.attemptKey,
      controllerToken: current.controllerToken,
    });
    await store.reconcileCccProviderAttempt({
      taskId,
      attemptKey: current.attemptKey,
      controllerToken: current.controllerToken,
      outcome: "committed",
      evidenceDigest: "8".repeat(64),
      observerId: "legacy-v2-visible",
    });
    const legacyKey = legacyAttemptKey(
      campaign,
      taskId,
      semanticTaskId,
      input.turnKey,
      input.dispatchKey,
    );
    await h.layer().db.execute(sql`
      UPDATE project.run_audit_events
      SET run_id = ${`ccc-provider-attempt:${legacyKey}`},
        campaign_event_key = ${legacyKey} || ':' || split_part(mutation_type, ':', 3),
        metadata = (metadata - 'workItemFence') || jsonb_build_object(
          'schema', 'ccc-campaign.provider-attempt.v2',
          'attemptKey', to_jsonb(${legacyKey}::text)
        )
      WHERE metadata->>'attemptKey' = ${current.attemptKey}
    `);

    const restarted = api(new TaskStore(h.rootDir(), undefined, { asyncLayer: h.layer() }));
    await expect(restarted.inspectCccProviderAttempt({ taskId, attemptKey: legacyKey }))
      .resolves.toMatchObject({
        attemptKey: legacyKey,
        state: "committed",
        workItemFence: null,
        terminal: { kind: "reconciled", state: "committed" },
      });
    await expect(restarted.beginCccProviderAttemptDispatch({
      taskId,
      attemptKey: legacyKey,
      controllerToken: current.controllerToken,
    })).rejects.toMatchObject({ code: "CCC_PROVIDER_ATTEMPT_STATE_REFUSED" });
    await expect(restarted.reserveCccProviderAttempt(input))
      .rejects.toMatchObject({ code: "CCC_PROVIDER_ATTEMPT_COLLISION" });
    expect(await auditRows()).toHaveLength(3);
    expect(await persistedRequestCount(campaign.importId)).toBe(1);
  });

  it("refuses provider route drift before writing an audit event or incrementing request_count", async () => {
    const { taskId, campaign } = await context("route-drift");
    const store = api(h.store());
    await expect(store.reserveCccProviderAttempt(request(taskId, h.rootDir(), "turn-route", {
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
    for (const turnKey of ["turn-one", "turn-two"] as const) {
      const attempt = await store.reserveCccProviderAttempt(request(taskId, h.rootDir(), turnKey));
      await store.proveCccProviderAttemptNotDispatched({
        taskId, attemptKey: attempt.attemptKey, controllerToken: attempt.controllerToken,
      });
    }
    await expect(store.reserveCccProviderAttempt(request(taskId, h.rootDir(), "turn-three"))).rejects.toMatchObject({
      code: "CCC_PROVIDER_ATTEMPT_LIMIT_REFUSED",
      reason: "max-requests",
    });
    expect(await persistedRequestCount(campaign.importId)).toBe(2);
  });

  it("enforces maxRequests as one campaign-global budget across semantic tasks", async () => {
    const { taskId: firstTaskId, campaign } = await context("global-max-requests", {
      maxRequests: 1, maxDurationMs: 60_000, maxConcurrency: 1,
    });
    const secondTaskId = await nativeTaskIdForImport(
      campaign.importId,
      "TASK-terminal-global-max-requests",
    );
    const store = api(h.store());

    const first = await store.reserveCccProviderAttempt(
      request(firstTaskId, h.rootDir(), "turn-first-task"),
    );
    await store.proveCccProviderAttemptNotDispatched({
      taskId: firstTaskId,
      attemptKey: first.attemptKey,
      controllerToken: first.controllerToken,
    });

    const auditCountBeforeRefusal = (await auditRows()).length;
    await expect(store.reserveCccProviderAttempt(
      request(secondTaskId, h.rootDir(), "turn-second-task"),
    )).rejects.toMatchObject({
      code: "CCC_PROVIDER_ATTEMPT_LIMIT_REFUSED",
      reason: "max-requests",
    });

    expect(await persistedRequestCount(campaign.importId)).toBe(1);
    expect(await auditRows()).toHaveLength(auditCountBeforeRefusal);
  });

  it("allocates the next ordinal after a terminal attempt without accepting caller ordinal", async () => {
    const { taskId, campaign } = await context("ordinal", {
      maxRequests: 3, maxDurationMs: 60_000, maxConcurrency: 1,
    });
    const store = api(h.store());
    const first = await store.reserveCccProviderAttempt(request(taskId, h.rootDir(), "turn-one"));
    await store.proveCccProviderAttemptNotDispatched({
      taskId, attemptKey: first.attemptKey, controllerToken: first.controllerToken,
    });
    expect(await auditRows()).toHaveLength(2);
    const next = await store.reserveCccProviderAttempt(request(taskId, h.rootDir(), "turn-skipped"));
    expect(next.attemptOrdinal).toBe(2);
    expect(await auditRows()).toHaveLength(3);
    expect(await persistedRequestCount(campaign.importId)).toBe(2);
  });

  it("uses the database clock to refuse a reservation after the campaign deadline", async () => {
    const { taskId, campaign } = await context("deadline", {
      maxRequests: 2, maxDurationMs: 1, maxConcurrency: 1,
    });
    await h.layer().db.execute(sql`SELECT pg_sleep(0.01)`);
    await expect(api(h.store()).reserveCccProviderAttempt(
      request(taskId, h.rootDir(), "turn-deadline"),
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
    const firstInput = request(taskId, h.rootDir(), "turn-one");
    const first = await store.reserveCccProviderAttempt(firstInput);
    const transition = { taskId, attemptKey: first.attemptKey, controllerToken: first.controllerToken };
    const dispatched = await dispatch(store, transition);
    const restarted = api(new TaskStore(h.rootDir(), undefined, { asyncLayer: h.layer() }));
    await expect(restarted.inspectCccProviderAttempt({
      taskId,
      attemptKey: first.attemptKey,
    })).resolves.toEqual(dispatched);
    await expect(restarted.reserveCccProviderAttempt(request(taskId, h.rootDir(), "turn-two"))).rejects.toMatchObject({
      code: "CCC_PROVIDER_ATTEMPT_LIMIT_REFUSED",
      reason: "max-concurrency",
    });
    await restarted.reconcileCccProviderAttempt({
      ...transition,
      outcome: "committed",
      evidenceDigest: "b".repeat(64),
      observerId: "provider-observer-committed",
    });
    const committed = await restarted.inspectCccProviderAttempt({ taskId, attemptKey: first.attemptKey });
    expect(committed).toMatchObject({
      state: "committed",
      terminal: {
        kind: "reconciled", state: "committed", evidenceDigest: "b".repeat(64), observerId: "provider-observer-committed",
      },
    });
    expect(Object.isFrozen(committed?.terminal)).toBe(true);
    await expect(restarted.beginCccProviderAttemptDispatch(transition)).resolves.toMatchObject({ kind: "terminal" });
    const second = await restarted.reserveCccProviderAttempt(request(taskId, h.rootDir(), "turn-two"));
    expect(second.attemptOrdinal).toBe(2);
    expect(second.requestCount).toBe(2);
  });

  it("only proves reserved attempts as not dispatched and collision-refuses changed terminal reconciliation", async () => {
    const { taskId } = await context("terminal");
    const store = api(h.store());
    const reservedInput = request(taskId, h.rootDir(), "turn-reserved");
    const reserved = await store.reserveCccProviderAttempt(reservedInput);
    const reservedTransition = {
      taskId, attemptKey: reserved.attemptKey, controllerToken: reserved.controllerToken,
    };
    const preDispatch = await store.proveCccProviderAttemptNotDispatched(reservedTransition);
    expect(preDispatch).toMatchObject({ state: "proved_failed" });
    expect(preDispatch.terminal).toEqual({ kind: "not-dispatched", state: "proved_failed" });
    expect(Object.isFrozen(preDispatch.terminal)).toBe(true);
    await expect(store.beginCccProviderAttemptDispatch(reservedTransition)).resolves.toMatchObject({ kind: "terminal" });
    await expect(store.proveCccProviderAttemptNotDispatched(reservedTransition)).resolves.toEqual(preDispatch);

    const dispatchedInput = request(taskId, h.rootDir(), "turn-dispatched");
    const dispatched = await store.reserveCccProviderAttempt(dispatchedInput);
    const transition = { taskId, attemptKey: dispatched.attemptKey, controllerToken: dispatched.controllerToken };
    await dispatch(store, transition);
    await expect(store.proveCccProviderAttemptNotDispatched(transition)).rejects.toMatchObject({
      code: "CCC_PROVIDER_ATTEMPT_STATE_REFUSED",
    });

    const first = await store.reconcileCccProviderAttempt({
      ...transition,
      outcome: "proved_failed",
      evidenceDigest: "a".repeat(64),
      observerId: "provider-observer-1",
    });
    expect(first.terminal).toEqual({
      kind: "reconciled", state: "proved_failed", evidenceDigest: "a".repeat(64), observerId: "provider-observer-1",
    });
    expect(Object.isFrozen(first.terminal)).toBe(true);
    await expect(store.beginCccProviderAttemptDispatch(transition)).resolves.toMatchObject({ kind: "terminal" });
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

  it("keeps legacy mark-dispatched fail-closed without an audit write", async () => {
    const { taskId } = await context("legacy-fail-closed");
    const store = api(h.store());
    const reserved = await store.reserveCccProviderAttempt(request(taskId, h.rootDir(), "turn-legacy"));
    const transition = { taskId, attemptKey: reserved.attemptKey, controllerToken: reserved.controllerToken };
    await expect(store.markCccProviderAttemptDispatched(transition)).rejects.toMatchObject({
      code: "CCC_PROVIDER_ATTEMPT_STATE_REFUSED",
    });
    expect(await auditRows()).toHaveLength(1);
  });

  it("Task 6 RED: transport-neutral settlement refuses CLI attempts before reconciliation", async () => {
    const { taskId } = await context("task6-cli-refusal", undefined, "cli");
    const store = api(h.store());
    const attempt = await store.reserveCccProviderAttempt(request(taskId, h.rootDir(), "turn-task6-cli", { transport: "cli" }));
    const transition = { taskId, attemptKey: attempt.attemptKey, controllerToken: attempt.controllerToken };
    await dispatch(store, transition);

    await expect(store.settleCccProviderAttemptAndApproval({
      ...attempt,
      outcome: "proved_failed",
      evidenceDigest: "d".repeat(64),
      observerId: "task6-cli-refusal",
    })).rejects.toThrow(/pi or workflow transport/i);
    await expect(store.inspectCccProviderAttempt({ taskId, attemptKey: attempt.attemptKey }))
      .resolves.toMatchObject({ state: "dispatched_unknown" });
  });

  it("Task 6 RED: committed pi settlement consumes the exact claimed approval without a CLI session", async () => {
    const { taskId, action, issued } = await protectedContext("task6-pi-committed-consumes");
    const store = api(h.store());
    const attempt = await store.reserveCccProviderAttempt(request(taskId, action.actionTarget, "turn-task6-pi-committed", {
      actionId: action.actionId, transport: "pi",
    }));
    const transition = { taskId, attemptKey: attempt.attemptKey, controllerToken: attempt.controllerToken };
    await dispatch(store, transition);

    await expect(store.settleCccProviderAttemptAndApproval({
      ...attempt, outcome: "committed", evidenceDigest: "c".repeat(64), observerId: "task6-pi-committed",
    })).resolves.toMatchObject({ state: "committed", terminal: { kind: "reconciled", state: "committed" } });
    await expect(getApprovalRequest(h.layer().db, issued.id)).resolves.toMatchObject({ status: "consumed" });
    await expect(h.store().inspectCccCampaignActionLease(taskId, action)).resolves.toBeNull();
    const cliRows = await h.layer().db.execute(sql`
      SELECT id FROM project.cli_sessions WHERE task_id = ${taskId}
    `);
    expect(cliRows).toHaveLength(0);
  });

  it("Task 6 P1 RED: TaskStore rejects a drifted immutable turn before terminal settlement or approval consumption", async () => {
    const { taskId, action, issued, claimToken } = await protectedContext("task6-native-identity-drift");
    const store = api(h.store());
    const attempt = await store.reserveCccProviderAttempt(request(taskId, action.actionTarget, "turn-task6-native-identity", {
      actionId: action.actionId, transport: "pi",
    }));
    await dispatch(store, { taskId, attemptKey: attempt.attemptKey, controllerToken: attempt.controllerToken });
    const auditsBefore = await auditRows();

    await expect(store.settleCccProviderAttemptAndApproval({
      ...attempt,
      turnKey: "turn-task6-native-identity-drift",
      outcome: "committed",
      evidenceDigest: "b".repeat(64),
      observerId: "task6-native-identity-drift",
    })).rejects.toThrow(/settlement immutable identity mismatch/i);

    const persisted = await store.inspectCccProviderAttempt({ taskId, attemptKey: attempt.attemptKey });
    expect(persisted).toMatchObject({ state: "dispatched_unknown" });
    expect(persisted?.terminal).toBeUndefined();
    await expect(getApprovalRequest(h.layer().db, issued.id)).resolves.toMatchObject({
      status: "claimed",
      campaign: { claimToken },
    });
    await expect(h.store().inspectCccCampaignActionLease(taskId, action)).resolves.toMatchObject({
      lease: { approvalRequestId: issued.id, claimToken },
    });
    expect(await auditRows()).toHaveLength(auditsBefore.length);
  });

  it("refuses a drifted work-item fence before terminal settlement or approval consumption", async () => {
    const { taskId, action, issued, claimToken } = await protectedContext("settlement-fence-drift");
    const store = api(h.store());
    const reservation = request(taskId, action.actionTarget, "turn-settlement-fence-drift", {
      actionId: action.actionId,
      transport: "pi",
    });
    const attempt = await store.reserveCccProviderAttempt(reservation);
    await dispatch(store, { taskId, attemptKey: attempt.attemptKey, controllerToken: attempt.controllerToken });
    const auditsBefore = await auditRows();

    await expect(store.settleCccProviderAttemptAndApproval({
      ...attempt,
      workItemFence: {
        ...reservation.workItemFence,
        attempt: reservation.workItemFence.attempt + 1,
      },
      outcome: "committed",
      evidenceDigest: "9".repeat(64),
      observerId: "settlement-fence-drift",
    })).rejects.toThrow(/settlement immutable identity mismatch/i);

    await expect(store.inspectCccProviderAttempt({ taskId, attemptKey: attempt.attemptKey }))
      .resolves.toMatchObject({ state: "dispatched_unknown", workItemFence: attempt.workItemFence });
    await expect(getApprovalRequest(h.layer().db, issued.id)).resolves.toMatchObject({
      status: "claimed",
      campaign: { claimToken },
    });
    expect(await auditRows()).toHaveLength(auditsBefore.length);
  });

  it("Task 6 RED: proved-failed pi settlement preserves the exact claimed approval for retry", async () => {
    const { taskId, action, issued, claimToken } = await protectedContext("task6-pi-proved-failed-retry");
    const store = api(h.store());
    const attempt = await store.reserveCccProviderAttempt(request(taskId, action.actionTarget, "turn-task6-pi-proved-failed", {
      actionId: action.actionId, transport: "pi",
    }));
    const transition = { taskId, attemptKey: attempt.attemptKey, controllerToken: attempt.controllerToken };
    await dispatch(store, transition);

    await expect(store.settleCccProviderAttemptAndApproval({
      ...attempt, outcome: "proved_failed", evidenceDigest: "f".repeat(64), observerId: "task6-pi-proved-failed",
    })).resolves.toMatchObject({ state: "proved_failed", terminal: { kind: "reconciled", state: "proved_failed" } });
    await expect(getApprovalRequest(h.layer().db, issued.id)).resolves.toMatchObject({ status: "claimed" });
    await expect(h.store().inspectCccCampaignActionLease(taskId, action)).resolves.toMatchObject({
      lease: { approvalRequestId: issued.id, claimToken, actionId: action.actionId, actionTarget: action.actionTarget },
    });
  });

  it("Task 6 RED: settlement refuses a self-consistent provider-attempt binding that drifted from the persisted campaign route", async () => {
    const { taskId, action } = await protectedContext("task6-settlement-binding-drift");
    const store = api(h.store());
    const attempt = await store.reserveCccProviderAttempt(request(taskId, action.actionTarget, "turn-task6-settlement-binding-drift", {
      actionId: action.actionId, transport: "pi",
    }));
    const transition = { taskId, attemptKey: attempt.attemptKey, controllerToken: attempt.controllerToken };
    await dispatch(store, transition);
    const { bindingHash: _bindingHash, ...driftedFields } = attempt.binding;
    const driftedBinding = {
      ...driftedFields,
      providerId: "deterministic-fake-drift",
      modelId: "fixture-v2",
      transport: "workflow" as const,
    };
    const driftedBindingHash = createHash("sha256")
      .update(canonicalCccPrdJson(driftedBinding), "utf8")
      .digest("hex");
    await h.layer().db.execute(sql`
      UPDATE project.run_audit_events
      SET campaign_provider_id = ${driftedBinding.providerId},
        campaign_model_id = ${driftedBinding.modelId},
        campaign_transport = ${driftedBinding.transport},
        campaign_binding_hash = ${driftedBindingHash},
        metadata = jsonb_set(metadata, '{bindingHash}', to_jsonb(${driftedBindingHash}::text))
      WHERE campaign_event_key LIKE ${`${attempt.attemptKey}:%`}
    `);

    await expect(store.settleCccProviderAttemptAndApproval({
      ...attempt, outcome: "proved_failed", evidenceDigest: "e".repeat(64), observerId: "task6-settlement-binding-drift",
    })).rejects.toThrow(/settlement immutable identity mismatch/i);
    await expect(store.inspectCccProviderAttempt({ taskId, attemptKey: attempt.attemptKey }))
      .resolves.toMatchObject({ state: "dispatched_unknown" });
  });

  it("permits a follow-on committed settlement in the same fenced visit after the approval is consumed", async () => {
    const { taskId, action, issued } = await protectedContext("follow-on-settlement");
    const store = api(h.store());
    const firstInput = request(taskId, action.actionTarget, "turn-follow-on-settlement-1", {
      actionId: action.actionId, transport: "pi",
    });
    const first = await store.reserveCccProviderAttempt(firstInput);
    await dispatch(store, { taskId, attemptKey: first.attemptKey, controllerToken: first.controllerToken });
    await store.settleCccProviderAttemptAndApproval({
      ...first, outcome: "committed", evidenceDigest: "1".repeat(64), observerId: "follow-on-settlement-1",
    });
    await expect(getApprovalRequest(h.layer().db, issued.id)).resolves.toMatchObject({ status: "consumed" });
    await expect(h.store().inspectCccCampaignActionLease(taskId, action)).resolves.toBeNull();

    const second = await store.reserveCccProviderAttempt({
      ...request(taskId, action.actionTarget, "turn-follow-on-settlement-2", {
        actionId: action.actionId, transport: "pi",
      }),
      workItemFence: firstInput.workItemFence,
    });
    await dispatch(store, { taskId, attemptKey: second.attemptKey, controllerToken: second.controllerToken });
    await expect(store.settleCccProviderAttemptAndApproval({
      ...second, outcome: "committed", evidenceDigest: "2".repeat(64), observerId: "follow-on-settlement-2",
    })).resolves.toMatchObject({ state: "committed", terminal: { kind: "reconciled", state: "committed" } });
    await expect(getApprovalRequest(h.layer().db, issued.id)).resolves.toMatchObject({ status: "consumed" });
    await expect(h.store().inspectCccCampaignActionLease(taskId, action)).resolves.toBeNull();
  });

  it("refuses a follow-on committed settlement under a different work-item fence", async () => {
    const { taskId, action, issued } = await protectedContext("follow-on-settle-fence");
    const store = api(h.store());
    const firstInput = request(taskId, action.actionTarget, "turn-follow-on-fence-1", {
      actionId: action.actionId, transport: "pi",
    });
    const first = await store.reserveCccProviderAttempt(firstInput);
    await dispatch(store, { taskId, attemptKey: first.attemptKey, controllerToken: first.controllerToken });
    await store.settleCccProviderAttemptAndApproval({
      ...first, outcome: "committed", evidenceDigest: "3".repeat(64), observerId: "follow-on-fence-1",
    });

    const second = await store.reserveCccProviderAttempt({
      ...request(taskId, action.actionTarget, "turn-follow-on-fence-2", {
        actionId: action.actionId, transport: "pi",
      }),
      workItemFence: { ...firstInput.workItemFence, attempt: firstInput.workItemFence.attempt + 1 },
    });
    await dispatch(store, { taskId, attemptKey: second.attemptKey, controllerToken: second.controllerToken });
    await expect(store.settleCccProviderAttemptAndApproval({
      ...second, outcome: "committed", evidenceDigest: "4".repeat(64), observerId: "follow-on-fence-2",
    })).rejects.toThrow(/no exact persisted action lease/i);
    await expect(store.inspectCccProviderAttempt({ taskId, attemptKey: second.attemptKey }))
      .resolves.toMatchObject({ state: "dispatched_unknown" });
    await expect(getApprovalRequest(h.layer().db, issued.id)).resolves.toMatchObject({ status: "consumed" });
  });

  async function omniRouteContext(suffix: string) {
    const source = rehashCccPrdImportTestBundle({
      ...bundle(h.rootDir(), suffix),
      bounds: { maxRequests: 3, maxDurationMs: 60_000, maxConcurrency: 1 },
    });
    const imported = await importCccPrdBundle({
      bundle: source,
      idempotencyKey: `provider-attempt-${suffix}`,
      store: h.store(),
      layer: h.layer(),
      rootDir: h.rootDir(),
      executionPolicy: {
        ...createCccPrdImportTestExecutionPolicy(source),
        routes: source.tasks.map(({ id }) => ({
          taskId: id,
          providerId: "omniroute-minimax-m3-pinned",
          modelId: "minimax/MiniMax-M3",
          transport: "pi" as const,
        })),
      },
    });
    const semanticTaskId = `TASK-${suffix}`;
    const taskId = await nativeTaskIdForImport(imported.importId, semanticTaskId);
    return { taskId, semanticTaskId };
  }

  function omniRouteRequest(taskId: string, turnKey: string) {
    return request(taskId, h.rootDir(), turnKey, {
      providerId: "omniroute-minimax-m3-pinned",
      modelId: "minimax/MiniMax-M3",
    });
  }

  // OmniRoute pre-terminal history: an OmniRoute campaign must be able to read
  // back its own reserved and dispatched rows. Those stages cannot carry a
  // terminal receipt, so demanding one makes the guard unsatisfiable and rolls
  // the whole provider step back before any request is ever built.
  it("reads back a reserved OmniRoute attempt without demanding a terminal receipt", async () => {
    const { taskId } = await omniRouteContext("omniroute-reserved");
    const store = api(h.store());
    const input = omniRouteRequest(taskId, "turn-omniroute-reserved");

    const first = await store.reserveCccProviderAttempt(input);
    expect(first.attemptOrdinal).toBe(1);
    expect(first.binding).toMatchObject({
      providerId: "omniroute-minimax-m3-pinned",
      modelId: "minimax/MiniMax-M3",
    });

    // Re-reading history is what every later stage does. It must not refuse a
    // pre-terminal row.
    await expect(store.reserveCccProviderAttempt(input)).resolves.toEqual(first);
    await expect(store.inspectCccProviderAttempt({
      taskId, attemptKey: first.attemptKey,
    })).resolves.toEqual(first);
  });

  it("reads back a dispatched OmniRoute attempt and a proved-not-dispatched terminal", async () => {
    const { taskId } = await omniRouteContext("omniroute-terminal");
    const store = api(h.store());
    const input = omniRouteRequest(taskId, "turn-omniroute-terminal");

    // A proved-not-dispatched terminal structurally has no effectiveRoute field
    // at all, so it can never satisfy an unconditional receipt demand. Proving
    // no dispatch is only legal from a reserved attempt, and maxConcurrency is
    // 1, so this terminating attempt runs before the one left dispatched.
    const undispatched = await store.reserveCccProviderAttempt(input);
    await store.proveCccProviderAttemptNotDispatched({
      taskId, attemptKey: undispatched.attemptKey, controllerToken: undispatched.controllerToken,
    });
    await expect(store.inspectCccProviderAttempt({
      taskId, attemptKey: undispatched.attemptKey,
    })).resolves.toMatchObject({ state: "proved_failed" });

    // A dispatched row likewise carries no terminal receipt.
    const dispatched = await store.reserveCccProviderAttempt(
      omniRouteRequest(taskId, "turn-omniroute-dispatched"),
    );
    const permit = await dispatch(store, {
      taskId, attemptKey: dispatched.attemptKey, controllerToken: dispatched.controllerToken,
    });
    expect(permit.attemptKey).toBe(dispatched.attemptKey);
    await expect(store.inspectCccProviderAttempt({
      taskId, attemptKey: dispatched.attemptKey,
    })).resolves.toMatchObject({ state: "dispatched_unknown" });
  });

  it("reads back a reconciled proved-failed OmniRoute attempt without a terminal route receipt", async () => {
    const { taskId } = await omniRouteContext("omniroute-reconciled-proved-failed");
    const store = api(h.store());
    const reserved = await store.reserveCccProviderAttempt(
      omniRouteRequest(taskId, "turn-omniroute-reconciled-proved-failed"),
    );
    await dispatch(store, {
      taskId,
      attemptKey: reserved.attemptKey,
      controllerToken: reserved.controllerToken,
    });

    await expect(store.reconcileCccProviderAttempt({
      taskId,
      attemptKey: reserved.attemptKey,
      controllerToken: reserved.controllerToken,
      outcome: "proved_failed",
      evidenceDigest: "e".repeat(64),
      observerId: "omniroute-timeout-observer",
    })).resolves.toMatchObject({
      state: "proved_failed",
      terminal: { kind: "reconciled", state: "proved_failed" },
    });
    await expect(store.inspectCccProviderAttempt({
      taskId,
      attemptKey: reserved.attemptKey,
    })).resolves.toMatchObject({
      state: "proved_failed",
      terminal: { kind: "reconciled", state: "proved_failed" },
    });
  });
});
