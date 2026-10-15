/**
 * FNXC:CccPlanningCampaignLink 2026-10-15-00:45 (card BF):
 * Linked writer caps against a real PostgreSQL. A campaign import linked to a request-to-code run (D15) caps each writer
 * attempt at 11 calls and each semantic task at 3 attempts, and refuses a reservation when the run is not building, a
 * cancel is pending, the run deadline is inside the launch headroom or the running runtime is not the run's. Every
 * refusal is the linked subclass of CccProviderAttemptLimitError, and through atomicReserveCccCampaignProviderDispatch it
 * is recorded only after the reservation transaction has rolled back (verify-v2 item 48).
 *
 * Every assertion reads the attempt, anchor and audit rows back from PostgreSQL. The positive control runs the same
 * reservation sequence on an unlinked import and gets the existing behaviour and no planning rows.
 */
import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { createSharedPgTaskStoreTestHarness, pgDescribe, type SharedPgTaskStoreHarness } from "../../__test-utils__/pg-test-harness.js";
import {
  createCccPrdImportTestBundle,
  createCccPrdImportTestExecutionPolicy,
  rehashCccPrdImportTestBundle,
} from "../../__test-utils__/ccc-prd-import-fixture.js";
import { importCccPrdBundle } from "../../ccc-prd/importer.js";
import { claimCccCampaignApproval, issueCccCampaignApproval } from "../../async-approval-request-store.js";
import { proveCccProviderAttemptNotDispatched, reserveCccProviderAttempt } from "../../ccc-campaign/provider-attempt.js";
import { atomicReserveCccCampaignProviderDispatch } from "../../ccc-campaign/provider-controller.js";
import { CccProviderAttemptLimitError, type CccCampaignWorkItemFence, type CccProviderAttemptScope } from "../../ccc-campaign/types.js";
import { registerCccRunningRuntimeDistManifest } from "../../ccc-planning/runtime-identity.js";
import { cccPlanningRuns } from "../../postgres/schema/ccc-planning.js";
import type { AsyncDataLayer, DbTransaction } from "../../postgres/data-layer.js";
import { recordCccPlanningBuildControl } from "../../task-store/ccc-planning-ops.js";
import {
  CccPlanningLinkedWriterLimitError,
  openCccPlanningLinkedWriterAttempt,
  recordCccPlanningWriterRefusal,
} from "../../task-store/ccc-planning-campaign-link-ops.js";
import type { ApprovalRequestActorSnapshot } from "../../types.js";

const NOW = "2026-10-15T00:00:00.000Z";
const FAR = "2999-01-01T00:00:00.000Z";
const DAY_MS = 86_400_000;
const worker: ApprovalRequestActorSnapshot = { actorId: "bf-caps-worker", actorType: "agent", actorName: "BF caps" };
const ACTION = { actionId: "ACTION-LIVE-EXECUTION", actionTarget: "ccc-lab-super:pre-live-provider-gate", requireProtected: true } as const;

function sha(label: string): string {
  return createHash("sha256").update(label, "utf8").digest("hex");
}

const RUNTIME = sha("bf-caps-runtime");

type Row = Record<string, unknown>;
type LinkState = "building" | "awaiting_execution_authority";
type Fixture = Readonly<{
  suffix: string; taskId: string; semanticTaskId: string; importId: string; projectId: string;
  campaign: NonNullable<Awaited<ReturnType<ReturnType<SharedPgTaskStoreHarness["store"]>["getCccCampaignContextForTask"]>>>;
  workItemFence: CccCampaignWorkItemFence; workItemLeaseOwner: string; approvalRequestId: string; claimToken: string;
  runId: string | null; planningTaskId: string | null;
}>;

pgDescribe("ccc planning linked writer caps (card BF, PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_ccc_planning_bf_caps" });
  beforeAll(async () => {
    await h.beforeAll();
    registerCccRunningRuntimeDistManifest(RUNTIME);
  });
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  function admin(): PostgresJsDatabase {
    return h.adminDb();
  }

  async function rows<T = Row>(query: ReturnType<typeof sql>): Promise<T[]> {
    return (await admin().execute(query)) as unknown as T[];
  }

  async function databaseNowPlus(seconds: number): Promise<string> {
    const found = await rows<{ at: string }>(sql`
      SELECT to_char((clock_timestamp() + make_interval(secs => ${seconds})) AT TIME ZONE 'UTC',
                     'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at
    `);
    return found[0]!.at;
  }

  async function nativeTaskIdForImport(importId: string, semanticTaskId: string): Promise<string> {
    const found = await rows<{ native_id: string }>(sql`
      SELECT native_id FROM project.ccc_prd_import_entities
       WHERE import_id = ${importId} AND entity_type = 'task' AND entity_id = ${semanticTaskId}
    `);
    expect(found).toHaveLength(1);
    return found[0]!.native_id;
  }

  /** A held planning task and an anchor linked to `importId`, moved through the real transition pairs to `state`. */
  async function linkRun(i: Readonly<{ suffix: string; projectId: string; importId: string; state: LinkState;
    deadlineAt?: string; runtime?: string }>): Promise<{ runId: string; planningTaskId: string }> {
    const planningTaskId = `R2C-BF-CAPS-${i.suffix}`;
    const runId = `ccc-plan:${sha(`bf-caps-run-${i.suffix}`).slice(0, 24)}`;
    await admin().execute(sql`
      INSERT INTO project.tasks (project_id, id, description, "column", created_at, updated_at)
      VALUES (${i.projectId}, ${planningTaskId}, ${`request-to-code fixture ${planningTaskId}`}, 'todo', ${NOW}, ${NOW})
    `);
    await admin().insert(cccPlanningRuns).values({
      projectId: i.projectId, runId, planningTaskId, mode: "build", budgetProfile: "standard", roleProfile: "full-v2",
      policyVersion: "ccc-planning.budget-policy.v1", policyDigest: sha("policy"), requestDigest: sha(`request:${runId}`),
      requestBytes: 512, targetRepository: h.rootDir(), admittedBase: "b".repeat(40),
      grantDigest: sha(`grant:${runId}`), authorityReceiptSha256: sha(`receipt:${runId}`),
      authorityReceiptJson: JSON.stringify({ runId }), runtimeDistManifestSha256: i.runtime ?? RUNTIME, state: "admitted",
      deadlineAt: i.deadlineAt ?? FAR, planningAllocation: 1536, implementationAllocation: 64, reviewProofAllocation: 16,
      researchFetchAllocation: 5, researchBytesAllocation: 4 * 1_048_576, createdAt: NOW, updatedAt: NOW,
    });
    for (const state of ["running", "spec_ready", "importing"]) await move(i.projectId, runId, state);
    await admin().execute(sql`
      UPDATE project.ccc_planning_runs
         SET import_intent_digest = ${sha(`intent:${runId}`)}, import_idempotency_key = ${`${runId}:r1`}
       WHERE project_id = ${i.projectId} AND run_id = ${runId}
    `);
    await admin().execute(sql`
      UPDATE project.ccc_planning_runs SET import_id = ${i.importId}, implementation_transferred = 32
       WHERE project_id = ${i.projectId} AND run_id = ${runId}
    `);
    await move(i.projectId, runId, i.state);
    return { runId, planningTaskId };
  }

  async function move(projectId: string, runId: string, state: string, stateCode: string | null = null): Promise<void> {
    await admin().execute(sql`
      UPDATE project.ccc_planning_runs SET state = ${state}, state_code = ${stateCode}
       WHERE project_id = ${projectId} AND run_id = ${runId}
    `);
  }

  async function fixture(suffix: string, options: Readonly<{ link?: LinkState | null; deadlineAt?: string; runtime?: string;
    approval?: boolean }> = {}): Promise<Fixture> {
    const initial = createCccPrdImportTestBundle(h.rootDir(), suffix);
    const source = rehashCccPrdImportTestBundle({
      ...initial,
      bounds: { maxRequests: 64, maxDurationMs: DAY_MS, maxConcurrency: 1 },
      tasks: initial.tasks.map((task, index) => index === 0 ? { ...task, protectedActionIds: [ACTION.actionId] } : task),
      protectedActions: [{ id: ACTION.actionId, kind: "live_execution", target: ACTION.actionTarget, requiresOperatorDecision: true,
        operatorDecision: "approve_live_execution", spans: [initial.tasks[0]!.spans[0]!] }],
    });
    const imported = await importCccPrdBundle({ bundle: source, idempotencyKey: `bf-caps-${suffix}`, store: h.store(),
      layer: h.layer(), rootDir: h.rootDir(), executionPolicy: createCccPrdImportTestExecutionPolicy(source) });
    const semanticTaskId = `TASK-${suffix}`;
    const taskId = await nativeTaskIdForImport(imported.importId, semanticTaskId);
    const campaign = await h.store().getCccCampaignContextForTask(taskId);
    if (!campaign) throw new Error("missing campaign context");
    const projectId = campaign.projectId;
    const linked = options.link === undefined || options.link === null
      ? null
      : await linkRun({ suffix, projectId, importId: imported.importId, state: options.link,
        ...(options.deadlineAt ? { deadlineAt: options.deadlineAt } : {}), ...(options.runtime ? { runtime: options.runtime } : {}) });
    const [workItem] = await h.store().listWorkflowWorkItemsForTask(taskId, { kinds: ["task"] });
    if (!workItem) throw new Error("missing campaign work item");
    const workItemLeaseOwner = `bf-caps-lease-${suffix}`;
    const leased = await h.store().transitionWorkflowWorkItem(workItem.id, "running", {
      attempt: 1, leaseOwner: workItemLeaseOwner, leaseExpiresAt: campaign.campaignDeadlineAt,
    });
    const workItemFence = Object.freeze({ workItemId: leased.id, runId: leased.runId, attempt: leased.attempt });
    let approvalRequestId = `approval-${suffix}`;
    const claimToken = `claim-${suffix}`;
    if (options.approval === true) {
      const issued = await issueCccCampaignApproval(h.layer(), { authorityStore: h.store(), rootDir: h.rootDir(), taskId,
        action: ACTION, requester: worker, runId: `issue-${suffix}`, notBeforeAt: campaign.campaignStartedAt,
        expiresAt: campaign.campaignDeadlineAt });
      approvalRequestId = issued.id;
      await claimCccCampaignApproval(h.layer(), { authorityStore: h.store(), rootDir: h.rootDir(), taskId, action: ACTION,
        claimant: worker, runId: `claim-${suffix}`, claimToken });
    }
    return { suffix, taskId, semanticTaskId, importId: imported.importId, projectId, campaign, workItemFence, workItemLeaseOwner,
      approvalRequestId, claimToken, runId: linked?.runId ?? null, planningTaskId: linked?.planningTaskId ?? null };
  }

  function request(f: Fixture, turnKey: string, dispatchKey: string) {
    return {
      taskId: f.taskId, actionId: ACTION.actionId, actionTarget: ACTION.actionTarget, turnKey, dispatchKey,
      providerId: f.campaign.route.providerId, modelId: f.campaign.route.modelId, transport: f.campaign.route.transport,
      workItemFence: f.workItemFence,
    };
  }

  /** One reserved call, proved not dispatched at once so the concurrency bound of 1 never interferes. */
  async function call(f: Fixture, turnKey: string, dispatchKey: string, layer: AsyncDataLayer = h.layer()):
    Promise<CccProviderAttemptScope> {
    const scope = await reserveCccProviderAttempt({ layer, rootDir: h.rootDir(), request: request(f, turnKey, dispatchKey) });
    await proveCccProviderAttemptNotDispatched({ layer, rootDir: h.rootDir(),
      transition: { taskId: f.taskId, attemptKey: scope.attemptKey, controllerToken: scope.controllerToken } });
    return scope;
  }

  function atomicInput(f: Fixture, turnKey: string, dispatchKey: string, layer: AsyncDataLayer = h.layer()) {
    return {
      layer, rootDir: h.rootDir(), authorityStore: h.store(),
      gitObservation: { targetRoot: f.campaign.targetRepository.path, expectedBaseObject: f.campaign.targetRepository.baseCommit,
        head: f.campaign.targetRepository.baseCommit, headDescendsFromExpectedBase: true as const },
      originTaskId: f.taskId, taskId: f.taskId, approvalRequestId: f.approvalRequestId, claimToken: f.claimToken,
      turnKey, dispatchKey, providerId: f.campaign.route.providerId, modelId: f.campaign.route.modelId,
      transport: f.campaign.route.transport, workItemFence: f.workItemFence, workItemLeaseOwner: f.workItemLeaseOwner,
    };
  }

  async function linkedRefusal(promise: Promise<unknown>, reason: string): Promise<CccPlanningLinkedWriterLimitError> {
    const error = await promise.then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(CccPlanningLinkedWriterLimitError);
    expect(error).toBeInstanceOf(CccProviderAttemptLimitError);
    expect((error as CccProviderAttemptLimitError).reason).toBe(reason);
    return error as CccPlanningLinkedWriterLimitError;
  }

  async function open(f: Fixture, baseTurnKey: string, nodeAttemptOrdinal: number) {
    return openCccPlanningLinkedWriterAttempt(h.layer(), { importId: f.importId, semanticTaskId: f.semanticTaskId, baseTurnKey,
      nodeAttemptOrdinal, fence: f.workItemFence });
  }

  async function attemptRows(f: Fixture): Promise<Array<{ mutation_type: string; turn_key: string; dispatch_key: string }>> {
    return rows(sql`
      SELECT mutation_type, metadata->>'turnKey' AS turn_key, metadata->>'dispatchKey' AS dispatch_key
        FROM project.run_audit_events
       WHERE campaign_import_id = ${f.importId} AND mutation_type LIKE 'ccc-campaign:provider-attempt:%'
       ORDER BY timestamp, id
    `);
  }

  async function requestCount(f: Fixture): Promise<number> {
    return (await rows<{ n: number }>(sql`
      SELECT request_count::int AS n FROM project.ccc_prd_imports WHERE import_id = ${f.importId}
    `))[0]!.n;
  }

  async function anchor(f: Fixture): Promise<Row> {
    return (await rows(sql`SELECT * FROM project.ccc_planning_runs WHERE run_id = ${f.runId}`))[0]!;
  }

  async function planningEvents(f: Fixture, mutationType: string): Promise<Array<Row & { xmin: string }>> {
    return rows(sql`
      SELECT xmin::text AS xmin, timestamp, metadata, target FROM project.run_audit_events
       WHERE run_id = ${f.runId} AND mutation_type = ${mutationType} ORDER BY timestamp, id
    `);
  }

  describe("iteration and dispatch caps", () => {
    it("caps a linked writer turn at 11 calls, gives each node attempt its own turn and refuses a 4th distinct attempt", async () => {
      const f = await fixture("caps", { link: "building" });
      const first = await open(f, "base-turn-1", 1);
      for (let n = 1; n <= 11; n += 1) await call(f, first.turnKey, `pi-stream:${n}`);
      const twelfth = await linkedRefusal(call(f, first.turnKey, "pi-stream:12"), "iteration-cap");
      expect(twelfth.refusal).toMatchObject({ runId: f.runId, importId: f.importId, turnKey: first.turnKey,
        dispatchKey: "pi-stream:12", reason: "iteration-cap" });
      expect(await requestCount(f)).toBe(11);

      const second = await open(f, "base-turn-1", 2);
      expect(second.turnKey).not.toBe(first.turnKey);
      expect(second.dispatchAttemptOrdinal).toBe(2);
      for (let n = 1; n <= 11; n += 1) await call(f, second.turnKey, `pi-stream:${n}`);
      await linkedRefusal(call(f, second.turnKey, "pi-stream:12"), "iteration-cap");
      expect((await open(f, "base-turn-1", 2)).turnKey).toBe(second.turnKey);

      const third = await open(f, "base-turn-1", 3);
      await call(f, third.turnKey, "pi-stream:1");
      await linkedRefusal(open(f, "base-turn-1", 4), "dispatch-cap");
      const foreign = await open(f, "base-turn-2", 1);
      await linkedRefusal(call(f, foreign.turnKey, "pi-stream:1"), "dispatch-cap");

      const reserved = (await attemptRows(f)).filter((row) => row.mutation_type === "ccc-campaign:provider-attempt:reserved");
      const perTurn = new Map<string, number>();
      for (const row of reserved) perTurn.set(row.turn_key, (perTurn.get(row.turn_key) ?? 0) + 1);
      expect([...perTurn.entries()]).toEqual([[first.turnKey, 11], [second.turnKey, 11], [third.turnKey, 1]]);
      expect(await requestCount(f)).toBe(23);
    });

    it("returns the five admitted writer route values as exactly five string keys", async () => {
      const f = await fixture("route", { link: "building" });
      const opened = await open(f, "base-turn-route", 1);
      expect(Object.keys(opened.route).sort()).toEqual(["modelId", "providerId", "roleClass", "toolsetDigest", "transport"]);
      for (const value of Object.values(opened.route)) expect(typeof value).toBe("string");
      expect(opened.route).toMatchObject({ providerId: f.campaign.route.providerId, modelId: f.campaign.route.modelId,
        transport: f.campaign.route.transport, roleClass: "writer" });
      expect(opened.route.toolsetDigest).toMatch(/^[0-9a-f]{64}$/u);
      expect((await open(f, "base-turn-route", 2)).route).toEqual(opened.route);
    });
  });

  describe("run state, control, deadline and runtime", () => {
    it("refuses control-pending while the run has a pending cancel", async () => {
      const f = await fixture("control", { link: "building" });
      const opened = await open(f, "base-turn-control", 1);
      await call(f, opened.turnKey, "pi-stream:1");
      await recordCccPlanningBuildControl(h.layer(), { runId: f.runId!, request: "cancel", actor: "bf-operator" });
      expect(await anchor(f)).toMatchObject({ state: "building", control_request: "cancel" });
      await linkedRefusal(call(f, opened.turnKey, "pi-stream:2"), "control-pending");
      expect(await requestCount(f)).toBe(1);
    });

    it("refuses deadline when the run deadline is 20 s away even though the campaign deadline is a day later", async () => {
      const f = await fixture("deadline", { link: "building", deadlineAt: await databaseNowPlus(20) });
      expect(Date.parse(f.campaign.campaignDeadlineAt) - Date.now()).toBeGreaterThan(DAY_MS - 3_600_000);
      const opened = await open(f, "base-turn-deadline", 1);
      await linkedRefusal(call(f, opened.turnKey, "pi-stream:1"), "deadline");
      expect(await requestCount(f)).toBe(0);

      const control = await fixture("deadline-control", { link: "building", deadlineAt: await databaseNowPlus(3600) });
      const controlTurn = await open(control, "base-turn-deadline", 1);
      await expect(call(control, controlTurn.turnKey, "pi-stream:1")).resolves.toMatchObject({ requestCount: 1 });
    });

    it("refuses run-not-building with RUN_ENDED once the run is accepted and CONTROL_PENDING while it is paused", async () => {
      const accepted = await fixture("accepted", { link: "building" });
      await move(accepted.projectId, accepted.runId!, "accepted");
      const acceptedTurn = await open(accepted, "base-turn-accepted", 1);
      const ended = await linkedRefusal(call(accepted, acceptedTurn.turnKey, "pi-stream:1"), "run-not-building");
      expect(ended.message).toContain("CCC_PLANNING_RUN_ENDED");

      const paused = await fixture("paused", { link: "building" });
      await move(paused.projectId, paused.runId!, "paused");
      const pausedTurn = await open(paused, "base-turn-paused", 1);
      const pending = await linkedRefusal(call(paused, pausedTurn.turnKey, "pi-stream:1"), "run-not-building");
      expect(pending.message).toContain("CCC_PLANNING_CONTROL_PENDING");
      expect(await requestCount(accepted) + await requestCount(paused)).toBe(0);
    });

    it("refuses runtime-not-permitted when the registered runtime is not the run's", async () => {
      const f = await fixture("runtime", { link: "building", runtime: sha("another-runtime") });
      const opened = await open(f, "base-turn-runtime", 1);
      await linkedRefusal(call(f, opened.turnKey, "pi-stream:1"), "runtime-not-permitted");
      expect(await requestCount(f)).toBe(0);
    });

    it("moves the run awaiting_execution_authority to building in the first approved reservation transaction", async () => {
      const f = await fixture("authority", { link: "awaiting_execution_authority", approval: true });
      const opened = await open(f, "base-turn-authority", 1);
      await expect(atomicReserveCccCampaignProviderDispatch({ ...atomicInput(f, opened.turnKey, "pi-stream:1"), claimToken: "wrong-claim" }))
        .rejects.toThrow();
      expect(await anchor(f)).toMatchObject({ state: "awaiting_execution_authority" });
      expect(await planningEvents(f, "ccc-planning:state")).toHaveLength(0);

      await expect(atomicReserveCccCampaignProviderDispatch(atomicInput(f, opened.turnKey, "pi-stream:1")))
        .resolves.toMatchObject({ kind: "dispatch-permit" });
      expect(await anchor(f)).toMatchObject({ state: "building", state_code: null });
      const moved = await planningEvents(f, "ccc-planning:state");
      expect(moved).toHaveLength(1);
      expect(moved[0]!.metadata).toMatchObject({ from: "awaiting_execution_authority", to: "building" });
      const reservedRow = (await rows<{ xmin: string }>(sql`
        SELECT xmin::text AS xmin FROM project.run_audit_events
         WHERE campaign_import_id = ${f.importId} AND mutation_type = 'ccc-campaign:provider-attempt:reserved'
      `));
      expect(reservedRow).toHaveLength(1);
      expect(moved[0]!.xmin).toBe(reservedRow[0]!.xmin);
    });
  });

  describe("refusal recording (item 48)", () => {
    it("records exactly one writer-refused event after the reservation transaction rolls back, on a fresh transaction", async () => {
      const f = await fixture("record", { link: "building", approval: true });
      const opened = await open(f, "base-turn-record", 1);
      await recordCccPlanningBuildControl(h.layer(), { runId: f.runId!, request: "cancel", actor: "bf-operator" });
      const before = JSON.stringify(await anchor(f));
      const journal: string[] = [];
      const xids: string[] = [];
      const base = h.layer();
      const spy = new Proxy(base, {
        get(target, property) {
          if (property !== "transactionImmediate") return Reflect.get(target, property, target);
          return async (work: (tx: DbTransaction) => Promise<unknown>, options?: unknown) => {
            const n = xids.length + 1;
            journal.push(`open:${n}`);
            try {
              const result = await (target.transactionImmediate as (w: typeof work, o?: unknown) => Promise<unknown>)(
                async (tx) => {
                  const id = (await tx.execute(sql`SELECT pg_current_xact_id()::xid::text AS id`)) as unknown as Array<{ id: string }>;
                  xids.push(id[0]!.id);
                  return work(tx);
                }, options);
              journal.push(`commit:${n}`);
              return result;
            } catch (error) {
              journal.push(`rollback:${n}`);
              throw error;
            }
          };
        },
      }) as AsyncDataLayer;

      const refused = await linkedRefusal(atomicReserveCccCampaignProviderDispatch(atomicInput(f, opened.turnKey, "pi-stream:1", spy)),
        "control-pending");
      expect(journal).toEqual(["open:1", "rollback:1", "open:2", "commit:2"]);
      expect(await attemptRows(f)).toEqual([]);
      expect(JSON.stringify(await anchor(f))).toBe(before);
      const events = await planningEvents(f, "ccc-planning:writer-refused");
      expect(events).toHaveLength(1);
      expect(events[0]!.timestamp).toBe(refused.refusal.refusedAt);
      expect(events[0]!.metadata).toMatchObject({ reason: "control-pending", turnKey: opened.turnKey, dispatchKey: "pi-stream:1" });
      expect(events[0]!.xmin).toBe(xids[1]);
      expect(events[0]!.xmin).not.toBe(xids[0]);

      const replayed = await linkedRefusal(atomicReserveCccCampaignProviderDispatch(atomicInput(f, opened.turnKey, "pi-stream:1")),
        "control-pending");
      expect(replayed.refusal.refusedAt >= refused.refusal.refusedAt).toBe(true);
      await expect(recordCccPlanningWriterRefusal(h.layer(), { ...refused.refusal, refusedAt: await databaseNowPlus(60) }))
        .resolves.toBeUndefined();
      const after = await planningEvents(f, "ccc-planning:writer-refused");
      expect(after).toHaveLength(1);
      expect(after[0]!.timestamp).toBe(refused.refusal.refusedAt);
    });
  });

  describe("unlinked positive control", () => {
    it("keeps the unlinked reservation sequence byte-identical and writes no planning rows", async () => {
      const linked = await fixture("twin-linked", { link: "building" });
      const unlinked = await fixture("twin-plain");
      const linkedTurn = await open(linked, "base-turn-twin", 1);
      const shape = (scope: CccProviderAttemptScope) => ({ state: scope.state, dispatchKey: scope.dispatchKey,
        attemptOrdinal: scope.attemptOrdinal, requestCount: scope.requestCount });
      const linkedScopes: unknown[] = [];
      const plainScopes: unknown[] = [];
      for (let n = 1; n <= 11; n += 1) {
        linkedScopes.push(shape(await call(linked, linkedTurn.turnKey, `pi-stream:${n}`)));
        plainScopes.push(shape(await call(unlinked, "turn-twin", `pi-stream:${n}`)));
      }
      expect(plainScopes).toEqual(linkedScopes);
      await linkedRefusal(call(linked, linkedTurn.turnKey, "pi-stream:12"), "iteration-cap");
      await expect(call(unlinked, "turn-twin", "pi-stream:12")).resolves.toMatchObject({ requestCount: 12 });
      expect((await attemptRows(unlinked)).map((row) => row.mutation_type)).toEqual(
        Array.from({ length: 12 }, () => ["ccc-campaign:provider-attempt:reserved", "ccc-campaign:provider-attempt:terminal"]).flat());

      const held = await reserveCccProviderAttempt({ layer: h.layer(), rootDir: h.rootDir(),
        request: request(unlinked, "turn-twin", "pi-stream:13") });
      const plainLimit = await reserveCccProviderAttempt({ layer: h.layer(), rootDir: h.rootDir(),
        request: request(unlinked, "turn-twin", "pi-stream:14") }).then(() => null, (caught: unknown) => caught);
      expect(plainLimit).toBeInstanceOf(CccProviderAttemptLimitError);
      expect(plainLimit).not.toBeInstanceOf(CccPlanningLinkedWriterLimitError);
      expect((plainLimit as CccProviderAttemptLimitError).reason).toBe("max-concurrency");
      expect(held.state).toBe("reserved");
      expect(await rows(sql`
        SELECT 1 FROM project.run_audit_events
         WHERE mutation_type LIKE 'ccc-planning:%' AND (campaign_import_id = ${unlinked.importId} OR target LIKE ${`%${unlinked.importId}%`}
               OR metadata->>'importId' = ${unlinked.importId})
      `)).toEqual([]);
    });
  });
});
