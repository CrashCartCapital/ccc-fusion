/**
 * FNXC:CccPlanningCampaignLink 2026-10-15-00:45 (card BF):
 * Campaign outcome mapping (D43) against a real PostgreSQL. Every work-item transition of a planning-linked campaign
 * carries its outcome into the run, in the work-item transaction, through L1's within-transaction functions only, and
 * inside a savepoint: a refused or failed mapping writes ccc-planning:campaign-unmapped and the work-item transition
 * still commits. One test per row of the section 2.11 table, plus the savepoint, rollback, L1-only and reconcile cases.
 *
 * Every assertion reads the anchor, work item and audit rows back from PostgreSQL. The positive control runs the same
 * work-item transitions on an unlinked import and gets the existing results and no planning rows.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { createSharedPgTaskStoreTestHarness, pgDescribe, type SharedPgTaskStoreHarness } from "../../__test-utils__/pg-test-harness.js";
import {
  createCccPrdImportTestBundle,
  createCccPrdImportTestExecutionPolicy,
  rehashCccPrdImportTestBundle,
} from "../../__test-utils__/ccc-prd-import-fixture.js";
import { importCccPrdBundle } from "../../ccc-prd/importer.js";
import { CCC_CAMPAIGN_OPERATOR_STOPPED_PREFIX } from "../../ccc-prd/product-status.js";
import { claimCccCampaignApproval, issueCccCampaignApproval } from "../../async-approval-request-store.js";
import {
  beginCccProviderAttemptDispatch,
  reconcileCccProviderAttempt,
  reserveCccProviderAttempt,
} from "../../ccc-campaign/provider-attempt.js";
import { atomicReserveCccCampaignProviderDispatch } from "../../ccc-campaign/provider-controller.js";
import type { CccCampaignWorkItemFence, CccProviderAttemptReconciliation, CccProviderAttemptScope } from "../../ccc-campaign/types.js";
import { registerCccRunningRuntimeDistManifest } from "../../ccc-planning/runtime-identity.js";
import { cccPlanningRuns } from "../../postgres/schema/ccc-planning.js";
import type { DbTransaction } from "../../postgres/data-layer.js";
import { publishCccPlanningArtifact } from "../../task-store/ccc-planning-artifact-ops.js";
import {
  completeCccPlanningCancellationWithin,
  recordCccPlanningBuildControl,
  transitionCccPlanningRunStateWithin,
} from "../../task-store/ccc-planning-ops.js";
import {
  CccPlanningLinkedWriterLimitError,
  __setCccPlanningCampaignOutcomeSeamForTesting,
  openCccPlanningLinkedWriterAttempt,
  reconcileCccPlanningCampaignOutcome,
  recordCccPlanningWriterRefusal,
} from "../../task-store/ccc-planning-campaign-link-ops.js";
import type { ApprovalRequestActorSnapshot, WorkflowWorkItem, WorkflowWorkItemState, WorkflowWorkItemTransitionPatch } from "../../types.js";

/*
 * The spy for "only L1's within functions reach the anchor": both within functions are wrapped so every anchor write
 * they make carries the transaction-local setting bf.via = 'l1', and a test trigger logs that setting for every anchor
 * UPDATE. A direct BF write to the anchor would log an empty via.
 */
vi.mock("../../task-store/ccc-planning-ops.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../task-store/ccc-planning-ops.js")>();
  const { sql: tag } = await import("drizzle-orm");
  const via = async <T>(tx: DbTransaction, work: () => Promise<T>): Promise<T> => {
    await tx.execute(tag`SELECT set_config('bf.via', 'l1', true)`);
    try {
      return await work();
    } finally {
      await tx.execute(tag`SELECT set_config('bf.via', '', true)`).catch(() => undefined);
    }
  };
  return {
    ...real,
    transitionCccPlanningRunStateWithin: vi.fn((tx: DbTransaction, i: Parameters<typeof real.transitionCccPlanningRunStateWithin>[1]) =>
      via(tx, () => real.transitionCccPlanningRunStateWithin(tx, i))),
    completeCccPlanningCancellationWithin: vi.fn((tx: DbTransaction, i: Parameters<typeof real.completeCccPlanningCancellationWithin>[1]) =>
      via(tx, () => real.completeCccPlanningCancellationWithin(tx, i))),
  };
});

const NOW = "2026-10-15T00:00:00.000Z";
const FAR = "2999-01-01T00:00:00.000Z";
const DAY_MS = 86_400_000;
const PAUSED_REASON = "ccc-operator:campaign-paused";
const CLOSURE_UNCONFIRMED = "ccc-permanent:CCC_PLANNING_WRITER_CLOSURE_UNCONFIRMED";
const worker: ApprovalRequestActorSnapshot = { actorId: "bf-outcome-worker", actorType: "agent", actorName: "BF outcome" };
const ACTION = { actionId: "ACTION-LIVE-EXECUTION", actionTarget: "ccc-lab-super:pre-live-provider-gate", requireProtected: true } as const;

function sha(label: string): string {
  return createHash("sha256").update(label, "utf8").digest("hex");
}

const RUNTIME = sha("bf-outcome-runtime");

type Row = Record<string, unknown>;
type LinkState = "building" | "awaiting_execution_authority";
type Fixture = Readonly<{
  suffix: string; taskId: string; semanticTaskId: string; importId: string; projectId: string; workItemId: string;
  campaign: NonNullable<Awaited<ReturnType<ReturnType<SharedPgTaskStoreHarness["store"]>["getCccCampaignContextForTask"]>>>;
  leaseOwner: string; approvalRequestId: string; claimToken: string; runId: string; planningTaskId: string;
}>;

function errorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/u.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

pgDescribe("ccc planning campaign outcome mapping (card BF, PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_ccc_planning_bf_outcome" });
  beforeAll(async () => {
    await h.beforeAll();
    registerCccRunningRuntimeDistManifest(RUNTIME);
  });
  beforeEach(h.beforeEach);
  afterEach(async () => {
    __setCccPlanningCampaignOutcomeSeamForTesting(null);
    vi.mocked(transitionCccPlanningRunStateWithin).mockClear();
    vi.mocked(completeCccPlanningCancellationWithin).mockClear();
    await h.afterEach();
  });
  afterAll(h.afterAll);

  function admin(): PostgresJsDatabase {
    return h.adminDb();
  }

  async function rows<T = Row>(query: ReturnType<typeof sql>): Promise<T[]> {
    return (await admin().execute(query)) as unknown as T[];
  }

  async function move(projectId: string, runId: string, state: string, stateCode: string | null = null): Promise<void> {
    await admin().execute(sql`
      UPDATE project.ccc_planning_runs SET state = ${state}, state_code = ${stateCode}
       WHERE project_id = ${projectId} AND run_id = ${runId}
    `);
  }

  async function linkRun(i: Readonly<{ suffix: string; projectId: string; importId: string; state: LinkState }>):
    Promise<{ runId: string; planningTaskId: string }> {
    const planningTaskId = `R2C-BF-OUT-${i.suffix}`;
    const runId = `ccc-plan:${sha(`bf-outcome-run-${i.suffix}`).slice(0, 24)}`;
    await admin().execute(sql`
      INSERT INTO project.tasks (project_id, id, description, "column", created_at, updated_at)
      VALUES (${i.projectId}, ${planningTaskId}, ${`request-to-code fixture ${planningTaskId}`}, 'todo', ${NOW}, ${NOW})
    `);
    await admin().insert(cccPlanningRuns).values({
      projectId: i.projectId, runId, planningTaskId, mode: "build", budgetProfile: "standard", roleProfile: "full-v2",
      policyVersion: "ccc-planning.budget-policy.v1", policyDigest: sha("policy"), requestDigest: sha(`request:${runId}`),
      requestBytes: 512, targetRepository: h.rootDir(), admittedBase: "b".repeat(40),
      grantDigest: sha(`grant:${runId}`), authorityReceiptSha256: sha(`receipt:${runId}`),
      authorityReceiptJson: JSON.stringify({ runId }), runtimeDistManifestSha256: RUNTIME, state: "admitted",
      deadlineAt: FAR, planningAllocation: 1536, implementationAllocation: 64, reviewProofAllocation: 16,
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

  async function fixture(suffix: string, options: Readonly<{ link?: LinkState | null; approval?: boolean }> = {}): Promise<Fixture> {
    const initial = createCccPrdImportTestBundle(h.rootDir(), suffix);
    const source = rehashCccPrdImportTestBundle({
      ...initial,
      bounds: { maxRequests: 16, maxDurationMs: DAY_MS, maxConcurrency: 1 },
      tasks: initial.tasks.map((task, index) => index === 0 ? { ...task, protectedActionIds: [ACTION.actionId] } : task),
      protectedActions: [{ id: ACTION.actionId, kind: "live_execution", target: ACTION.actionTarget, requiresOperatorDecision: true,
        operatorDecision: "approve_live_execution", spans: [initial.tasks[0]!.spans[0]!] }],
    });
    const imported = await importCccPrdBundle({ bundle: source, idempotencyKey: `bf-outcome-${suffix}`, store: h.store(),
      layer: h.layer(), rootDir: h.rootDir(), executionPolicy: createCccPrdImportTestExecutionPolicy(source) });
    const semanticTaskId = `TASK-${suffix}`;
    const native = await rows<{ native_id: string }>(sql`
      SELECT native_id FROM project.ccc_prd_import_entities
       WHERE import_id = ${imported.importId} AND entity_type = 'task' AND entity_id = ${semanticTaskId}
    `);
    const taskId = native[0]!.native_id;
    const campaign = await h.store().getCccCampaignContextForTask(taskId);
    if (!campaign) throw new Error("missing campaign context");
    const items = await rows<{ id: string }>(sql`
      SELECT id FROM project.workflow_work_items WHERE run_id = ${`ccc-prd:${imported.importId}`}
    `);
    expect(items).toHaveLength(1);
    const linked = options.link === null
      ? { runId: "", planningTaskId: "" }
      : await linkRun({ suffix, projectId: campaign.projectId, importId: imported.importId, state: options.link ?? "building" });
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
    return { suffix, taskId, semanticTaskId, importId: imported.importId, projectId: campaign.projectId, workItemId: items[0]!.id,
      campaign, leaseOwner: `bf-outcome-lease-${suffix}`, approvalRequestId, claimToken, ...linked };
  }

  /** Setup only: puts the campaign item into a state with plain SQL, so the hook does not run. */
  async function setItem(f: Fixture, state: WorkflowWorkItemState, fields: Readonly<{ leased?: boolean; blockedReason?: string | null;
    attempt?: number }> = {}): Promise<void> {
    await admin().execute(sql`
      UPDATE project.workflow_work_items
         SET state = ${state}, attempt = ${fields.attempt ?? 1},
             lease_owner = ${fields.leased ? f.leaseOwner : null}, lease_expires_at = ${fields.leased ? f.campaign.campaignDeadlineAt : null},
             blocked_reason = ${fields.blockedReason ?? null}, last_error = NULL
       WHERE id = ${f.workItemId}
    `);
  }

  function transition(f: Fixture, state: WorkflowWorkItemState, patch: WorkflowWorkItemTransitionPatch = {}, tx?: DbTransaction):
    Promise<WorkflowWorkItem> {
    return h.store().transitionWorkflowWorkItem(f.workItemId, state, patch, tx);
  }

  async function lease(f: Fixture): Promise<void> {
    await setItem(f, "runnable");
    await transition(f, "running", { attempt: 1, leaseOwner: f.leaseOwner, leaseExpiresAt: f.campaign.campaignDeadlineAt });
  }

  async function anchor(f: Fixture): Promise<Row> {
    return (await rows(sql`SELECT * FROM project.ccc_planning_runs WHERE run_id = ${f.runId}`))[0]!;
  }

  async function item(f: Fixture): Promise<Row> {
    return (await rows(sql`SELECT * FROM project.workflow_work_items WHERE id = ${f.workItemId}`))[0]!;
  }

  async function events(f: Fixture, mutationType: string): Promise<Array<Row & { xmin: string; metadata: Row }>> {
    return rows(sql`
      SELECT xmin::text AS xmin, timestamp, target, metadata FROM project.run_audit_events
       WHERE run_id = ${f.runId} AND mutation_type = ${mutationType} ORDER BY timestamp, id
    `);
  }

  async function stateMoves(f: Fixture): Promise<string[]> {
    return (await events(f, "ccc-planning:state")).map((event) => `${String(event.metadata.from)}->${String(event.metadata.to)}`);
  }

  async function publishVerdict(f: Fixture, kind: "final_judgment" | "task_review", verdict: "accept" | "reject"): Promise<void> {
    await publishCccPlanningArtifact(h.layer(), {
      planningTaskId: f.planningTaskId, runId: f.runId,
      slot: { runRevision: 1, stageId: kind === "final_judgment" ? "g8" : "g7", slot: kind === "final_judgment" ? "judgment" : "review",
        version: 1 },
      kind, contentSchema: "ccc-planning.review-verdict.v1", content: { type: "json", value: { verdict, findings: [] } },
      inputs: [], producer: { kind: "model", roleId: kind === "final_judgment" ? "final-judge" : "task-reviewer", instanceId: `bf-${kind}`,
        requestedModel: "minimax/MiniMax-M3", resolvedModel: "minimax/MiniMax-M3", routeReceiptDigest: sha(`receipt-${kind}`) },
      policy: { promptVersion: "v1", promptDigest: sha("prompt"), toolPolicyVersion: "v1", toolPolicyDigest: sha("tools") },
      status: "complete",
      fence: { kind: "campaign_work_item_lease", workItemId: f.workItemId, leaseOwner: f.leaseOwner, attempt: 1,
        runId: `ccc-prd:${f.importId}` },
    });
  }

  async function refusal(f: Fixture, reason: string): Promise<void> {
    await recordCccPlanningWriterRefusal(h.layer(), { runId: f.runId, importId: f.importId, turnKey: `turn-${reason}`,
      dispatchKey: "pi-stream:1", reason: reason as CccPlanningLinkedWriterLimitError["reason"], refusedAt: NOW });
  }

  function attemptRequest(f: Fixture, turnKey: string, dispatchKey: string) {
    return {
      taskId: f.taskId, actionId: ACTION.actionId, actionTarget: ACTION.actionTarget, turnKey, dispatchKey,
      providerId: f.campaign.route.providerId, modelId: f.campaign.route.modelId, transport: f.campaign.route.transport,
      workItemFence: { workItemId: f.workItemId, runId: `ccc-prd:${f.importId}`, attempt: 1 } as CccCampaignWorkItemFence,
    };
  }

  /** A reserved and begun (dispatched_unknown) campaign attempt. */
  async function dispatched(f: Fixture, turnKey: string): Promise<CccProviderAttemptScope> {
    const scope = await reserveCccProviderAttempt({ layer: h.layer(), rootDir: h.rootDir(), request: attemptRequest(f, turnKey, "pi-stream:1") });
    const begun = await beginCccProviderAttemptDispatch({ layer: h.layer(), rootDir: h.rootDir(),
      transition: { taskId: f.taskId, attemptKey: scope.attemptKey, controllerToken: scope.controllerToken } });
    expect(begun.kind).toBe("dispatch-permit");
    return begun.scope;
  }

  describe("D43 rows", () => {
    it("operator pause moves building to paused", async () => {
      const f = await fixture("pause");
      await setItem(f, "runnable");
      await transition(f, "held", { expectedLeaseOwner: null, blockedReason: PAUSED_REASON, leaseOwner: null, leaseExpiresAt: null });
      expect(await anchor(f)).toMatchObject({ state: "paused", state_code: null });
      expect(await stateMoves(f)).toEqual(["building->paused"]);
    });

    it("operator resume moves paused to building only when before.blockedReason was the pause reason", async () => {
      const f = await fixture("resume");
      await setItem(f, "runnable");
      await transition(f, "held", { expectedLeaseOwner: null, blockedReason: PAUSED_REASON });
      await transition(f, "runnable", { expectedLeaseOwner: null, blockedReason: null, lastError: null });
      expect(await anchor(f)).toMatchObject({ state: "building" });
      expect(await stateMoves(f)).toEqual(["building->paused", "paused->building"]);

      const other = await fixture("resume-other");
      await setItem(other, "runnable");
      await transition(other, "held", { expectedLeaseOwner: null, blockedReason: PAUSED_REASON });
      await setItem(other, "held", { blockedReason: "ccc-other:held-for-capacity" });
      await transition(other, "runnable", { expectedLeaseOwner: null, blockedReason: null });
      expect(await item(other)).toMatchObject({ state: "runnable" });
      expect(await anchor(other)).toMatchObject({ state: "paused" });
      expect(await stateMoves(other)).toEqual(["building->paused"]);
    });

    it("operator stop moves the current state to cancelled through cancelling and clears control_request", async () => {
      const f = await fixture("stop");
      await recordCccPlanningBuildControl(h.layer(), { runId: f.runId, request: "cancel", actor: "bf-operator" });
      expect(await anchor(f)).toMatchObject({ control_request: "cancel" });
      await setItem(f, "runnable");
      await transition(f, "cancelled", { expectedLeaseOwner: null, lastError: `${CCC_CAMPAIGN_OPERATOR_STOPPED_PREFIX}${sha("stop")}` });
      expect(await anchor(f)).toMatchObject({ state: "cancelled", state_code: "CCC_PLANNING_CANCELLED", control_request: null,
        control_revision: null, control_requested_at: null });
      expect(await stateMoves(f)).toEqual(["building->cancelling", "cancelling->cancelled"]);

      const paused = await fixture("stop-paused");
      await setItem(paused, "runnable");
      await transition(paused, "held", { expectedLeaseOwner: null, blockedReason: PAUSED_REASON });
      await transition(paused, "cancelled", { expectedLeaseOwner: null, lastError: `${CCC_CAMPAIGN_OPERATOR_STOPPED_PREFIX}${sha("p")}` });
      expect(await anchor(paused)).toMatchObject({ state: "cancelled" });
      expect(await stateMoves(paused)).toEqual(["building->paused", "paused->cancelling", "cancelling->cancelled"]);

      const authority = await fixture("stop-authority", { link: "awaiting_execution_authority" });
      await setItem(authority, "runnable");
      await transition(authority, "cancelled", { expectedLeaseOwner: null, lastError: `${CCC_CAMPAIGN_OPERATOR_STOPPED_PREFIX}${sha("a")}` });
      expect(await stateMoves(authority)).toEqual(["awaiting_execution_authority->cancelling", "cancelling->cancelled"]);
    });

    it("in-lease cancel moves the current state to cancelled and clears control_request", async () => {
      const f = await fixture("in-lease");
      await lease(f);
      await recordCccPlanningBuildControl(h.layer(), { runId: f.runId, request: "cancel", actor: "bf-operator" });
      await transition(f, "cancelled", { expectedLeaseOwner: f.leaseOwner, leaseOwner: null, leaseExpiresAt: null,
        lastError: "workflow-user-cancelled" });
      expect(await anchor(f)).toMatchObject({ state: "cancelled", state_code: "CCC_PLANNING_CANCELLED", control_request: null });
      expect(await stateMoves(f)).toEqual(["building->cancelling", "cancelling->cancelled"]);
    });

    it("every item succeeded with an accepted final_judgment moves building to accepted", async () => {
      const f = await fixture("accepted");
      await lease(f);
      await publishVerdict(f, "final_judgment", "accept");
      await transition(f, "succeeded", { leaseOwner: null, leaseExpiresAt: null });
      expect(await anchor(f)).toMatchObject({ state: "accepted", state_code: null });
      expect(await stateMoves(f)).toEqual(["building->accepted"]);
    });

    it("every item succeeded without a final_judgment moves building to failed FINAL_JUDGMENT_MISSING", async () => {
      const f = await fixture("no-judgment");
      await lease(f);
      await transition(f, "succeeded", { leaseOwner: null, leaseExpiresAt: null });
      expect(await anchor(f)).toMatchObject({ state: "failed", state_code: "CCC_PLANNING_FINAL_JUDGMENT_MISSING" });

      const rejected = await fixture("judgment-rejected");
      await lease(rejected);
      await publishVerdict(rejected, "final_judgment", "reject");
      await transition(rejected, "succeeded", { leaseOwner: null, leaseExpiresAt: null });
      expect(await anchor(rejected)).toMatchObject({ state: "failed", state_code: "CCC_PLANNING_FINAL_JUDGMENT_MISSING" });
    });

    it("a rejected task_review then item failed moves building to verification_failed", async () => {
      const f = await fixture("review-rejected");
      await lease(f);
      await publishVerdict(f, "task_review", "reject");
      await transition(f, "failed", { leaseOwner: null, leaseExpiresAt: null, lastError: "review rejected" });
      expect(await anchor(f)).toMatchObject({ state: "verification_failed", state_code: "CCC_PLANNING_CODING_REPAIR_NOT_RUN" });
    });

    it("a dispatch-cap refusal then item failed moves building to budget_exhausted DISPATCH_CAP", async () => {
      const f = await fixture("dispatch-cap");
      await lease(f);
      await refusal(f, "iteration-cap");
      await refusal(f, "dispatch-cap");
      await transition(f, "failed", { leaseOwner: null, leaseExpiresAt: null, lastError: "writer refused" });
      expect(await anchor(f)).toMatchObject({ state: "budget_exhausted", state_code: "CCC_PLANNING_DISPATCH_CAP" });

      const iteration = await fixture("iteration-cap");
      await lease(iteration);
      await refusal(iteration, "iteration-cap");
      await transition(iteration, "manual-required", { leaseOwner: null, leaseExpiresAt: null });
      expect(await anchor(iteration)).toMatchObject({ state: "budget_exhausted", state_code: "CCC_PLANNING_ITERATION_CAP" });
    });

    it("a route refusal then item failed moves building to blocked_provider PIN_DRIFT", async () => {
      const f = await fixture("route-refusal");
      await lease(f);
      await refusal(f, "receipt-mismatch");
      await transition(f, "failed", { leaseOwner: null, leaseExpiresAt: null, lastError: "route refused" });
      expect(await anchor(f)).toMatchObject({ state: "blocked_provider", state_code: "CCC_PROVIDER_PIN_DRIFT" });
    });

    it("a dispatched_unknown linked attempt then item manual-required moves building to unknown_effect", async () => {
      const f = await fixture("unknown-effect");
      await lease(f);
      await dispatched(f, "turn-unknown");
      await transition(f, "manual-required", { leaseOwner: null, leaseExpiresAt: null });
      expect(await anchor(f)).toMatchObject({ state: "unknown_effect", state_code: "CCC_PLANNING_UNRECONCILED_DISPATCH" });
    });

    it("a writer closure that is unconfirmed moves building to blocked_prerequisite", async () => {
      const f = await fixture("closure");
      await lease(f);
      await transition(f, "manual-required", { leaseOwner: null, leaseExpiresAt: null, blockedReason: CLOSURE_UNCONFIRMED });
      expect(await anchor(f)).toMatchObject({ state: "blocked_prerequisite", state_code: "CCC_PLANNING_WRITER_CLOSURE_UNCONFIRMED" });
    });

    it("a pending cancel or a control-pending refusal ends the run cancelled, never CAMPAIGN_FAILED", async () => {
      const f = await fixture("cancel-race", { approval: true });
      await lease(f);
      const opened = await openCccPlanningLinkedWriterAttempt(h.layer(), { importId: f.importId, semanticTaskId: f.semanticTaskId,
        baseTurnKey: "base-turn-race", nodeAttemptOrdinal: 1,
        fence: { workItemId: f.workItemId, runId: `ccc-prd:${f.importId}`, attempt: 1 } });
      await recordCccPlanningBuildControl(h.layer(), { runId: f.runId, request: "cancel", actor: "bf-operator" });
      const refused = await atomicReserveCccCampaignProviderDispatch({
        layer: h.layer(), rootDir: h.rootDir(), authorityStore: h.store(),
        gitObservation: { targetRoot: f.campaign.targetRepository.path, expectedBaseObject: f.campaign.targetRepository.baseCommit,
          head: f.campaign.targetRepository.baseCommit, headDescendsFromExpectedBase: true },
        originTaskId: f.taskId, taskId: f.taskId, approvalRequestId: f.approvalRequestId, claimToken: f.claimToken,
        turnKey: opened.turnKey, dispatchKey: "pi-stream:1", providerId: f.campaign.route.providerId,
        modelId: f.campaign.route.modelId, transport: f.campaign.route.transport,
        workItemFence: { workItemId: f.workItemId, runId: `ccc-prd:${f.importId}`, attempt: 1 }, workItemLeaseOwner: f.leaseOwner,
      }).then(() => null, (caught: unknown) => caught);
      expect(refused).toBeInstanceOf(CccPlanningLinkedWriterLimitError);
      expect(await events(f, "ccc-planning:writer-refused")).toHaveLength(1);
      expect(await anchor(f)).toMatchObject({ state: "building", control_request: "cancel" });
      await transition(f, "failed", { leaseOwner: null, leaseExpiresAt: null, lastError: "writer refused" });
      expect(await anchor(f)).toMatchObject({ state: "cancelled", state_code: "CCC_PLANNING_CANCELLED", control_request: null });

      const manual = await fixture("cancel-manual");
      await lease(manual);
      await recordCccPlanningBuildControl(h.layer(), { runId: manual.runId, request: "cancel", actor: "bf-operator" });
      await transition(manual, "manual-required", { leaseOwner: null, leaseExpiresAt: null });
      expect(await anchor(manual)).toMatchObject({ state: "cancelled", state_code: "CCC_PLANNING_CANCELLED" });

      const refusedOnly = await fixture("cancel-refusal-only");
      await lease(refusedOnly);
      await refusal(refusedOnly, "control-pending");
      await transition(refusedOnly, "failed", { leaseOwner: null, leaseExpiresAt: null, lastError: "writer refused" });
      expect(await anchor(refusedOnly)).toMatchObject({ state: "cancelled", state_code: "CCC_PLANNING_CANCELLED" });
    });

    it("any other failure moves building or awaiting_execution_authority to failed CAMPAIGN_FAILED", async () => {
      const f = await fixture("other-failure");
      await lease(f);
      await transition(f, "failed", { leaseOwner: null, leaseExpiresAt: null, lastError: "boom" });
      expect(await anchor(f)).toMatchObject({ state: "failed", state_code: "CCC_PLANNING_CAMPAIGN_FAILED" });

      const authority = await fixture("other-failure-authority", { link: "awaiting_execution_authority" });
      await lease(authority);
      await transition(authority, "exhausted", { leaseOwner: null, leaseExpiresAt: null });
      expect(await anchor(authority)).toMatchObject({ state: "failed", state_code: "CCC_PLANNING_CAMPAIGN_FAILED" });
      expect(await stateMoves(authority)).toEqual(["awaiting_execution_authority->failed"]);
    });

    it("pins the pause reason the mapping reads to the engine operator constant", () => {
      const source = readFileSync(fileURLToPath(new URL("../../../../engine/src/ccc-campaign-operator-control.ts", import.meta.url)), "utf8");
      expect(source).toMatch(/export const CCC_CAMPAIGN_OPERATOR_PAUSED_REASON =\s*"ccc-operator:campaign-paused";/u);
      expect(PAUSED_REASON).toBe("ccc-operator:campaign-paused");
    });
  });

  describe("savepoint, rollback and L1-only writes", () => {
    it("a transition the anchor does not allow leaves it unchanged, writes campaign-unmapped and commits the item", async () => {
      const f = await fixture("disallowed");
      await lease(f);
      await move(f.projectId, f.runId, "accepted");
      const before = JSON.stringify(await anchor(f));
      await transition(f, "failed", { leaseOwner: null, leaseExpiresAt: null, lastError: "late failure" });
      expect(await item(f)).toMatchObject({ state: "failed", last_error: "late failure" });
      expect(JSON.stringify(await anchor(f))).toBe(before);
      const unmapped = await events(f, "ccc-planning:campaign-unmapped");
      expect(unmapped).toHaveLength(1);
      expect(unmapped[0]!.metadata).toMatchObject({ marker: "CCC_PLANNING_CAMPAIGN_STATE_UNMAPPED", workItemId: f.workItemId,
        fromState: "running", toState: "failed" });
    });

    it("an SQL error inside the mapping body is contained by its savepoint", async () => {
      const f = await fixture("sql-error");
      await lease(f);
      const before = JSON.stringify(await anchor(f));
      __setCccPlanningCampaignOutcomeSeamForTesting(async (tx) => {
        await tx.execute(sql`SELECT 1/0`);
      });
      await transition(f, "failed", { leaseOwner: null, leaseExpiresAt: null, lastError: "boom" });
      expect(await item(f)).toMatchObject({ state: "failed" });
      expect(JSON.stringify(await anchor(f))).toBe(before);
      expect(await events(f, "ccc-planning:campaign-unmapped")).toHaveLength(1);

      const aborted = await h.layer().transactionImmediate(async (tx) => {
        await tx.execute(sql`SELECT 1/0`).catch(() => undefined);
        return tx.execute(sql`SELECT 1`).then(() => "continued", (error: unknown) => errorCode(error));
      }).catch((error: unknown) => errorCode(error));
      expect(aborted).toBe("25P02");
    });

    it("an outer rollback after the mapping leaves no anchor change and no state event", async () => {
      const f = await fixture("outer-rollback");
      await setItem(f, "runnable");
      const before = JSON.stringify(await anchor(f));
      let inside: unknown;
      await expect(h.layer().transactionImmediate(async (tx) => {
        await transition(f, "held", { expectedLeaseOwner: null, blockedReason: PAUSED_REASON }, tx);
        inside = ((await tx.execute(sql`SELECT state FROM project.ccc_planning_runs WHERE run_id = ${f.runId}`)) as unknown as Row[])[0]!.state;
        throw new Error("bf-outer-rollback");
      })).rejects.toThrow("bf-outer-rollback");
      expect(inside).toBe("paused");
      expect(JSON.stringify(await anchor(f))).toBe(before);
      expect(await events(f, "ccc-planning:state")).toEqual([]);
      expect(await item(f)).toMatchObject({ state: "runnable" });
    });

    it("reaches the anchor only through L1's two within functions", async () => {
      const f = await fixture("l1-only");
      await setItem(f, "runnable");
      await h.layer().db.execute(sql`CREATE TABLE IF NOT EXISTS project.bf_anchor_writes (via text, old_state text, new_state text)`);
      await h.layer().db.execute(sql`
        CREATE OR REPLACE FUNCTION project.bf_anchor_write_log() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          INSERT INTO project.bf_anchor_writes VALUES (coalesce(current_setting('bf.via', true), ''), OLD.state, NEW.state);
          RETURN NEW;
        END $$
      `);
      await h.layer().db.execute(sql`
        CREATE TRIGGER bf_anchor_write_log BEFORE UPDATE ON project.ccc_planning_runs
        FOR EACH ROW EXECUTE FUNCTION project.bf_anchor_write_log()
      `);
      try {
        await transition(f, "held", { expectedLeaseOwner: null, blockedReason: PAUSED_REASON });
        await transition(f, "cancelled", { expectedLeaseOwner: null, lastError: `${CCC_CAMPAIGN_OPERATOR_STOPPED_PREFIX}${sha("l1")}` });
        const writes = await rows<{ via: string; old_state: string; new_state: string }>(sql`SELECT * FROM project.bf_anchor_writes`);
        expect(writes).toEqual([
          { via: "l1", old_state: "building", new_state: "paused" },
          { via: "l1", old_state: "paused", new_state: "cancelling" },
          { via: "l1", old_state: "cancelling", new_state: "cancelled" },
        ]);
        expect(vi.mocked(transitionCccPlanningRunStateWithin).mock.calls.map(([, i]) => `${i.from}->${i.to}`))
          .toEqual(["building->paused", "paused->cancelling"]);
        expect(vi.mocked(completeCccPlanningCancellationWithin).mock.calls.map(([, i]) => i.runId)).toEqual([f.runId]);
      } finally {
        await h.layer().db.execute(sql`DROP TRIGGER IF EXISTS bf_anchor_write_log ON project.ccc_planning_runs`);
        await h.layer().db.execute(sql`DROP FUNCTION IF EXISTS project.bf_anchor_write_log()`);
        await h.layer().db.execute(sql`DROP TABLE IF EXISTS project.bf_anchor_writes`);
      }
    });

    it("maps the success row to cancelling while a cancel is pending", async () => {
      const f = await fixture("success-cancel");
      await lease(f);
      await publishVerdict(f, "final_judgment", "accept");
      await recordCccPlanningBuildControl(h.layer(), { runId: f.runId, request: "cancel", actor: "bf-operator" });
      await transition(f, "succeeded", { leaseOwner: null, leaseExpiresAt: null });
      expect(await anchor(f)).toMatchObject({ state: "cancelling", control_request: null });
      expect(await stateMoves(f)).toEqual(["building->cancelling"]);
      expect(vi.mocked(transitionCccPlanningRunStateWithin).mock.calls.map(([, i]) => `${i.from}->${i.to}`))
        .toEqual(["building->accepted", "building->cancelling"]);
    });
  });

  describe("reconcile", () => {
    it("moves the run to blocked_provider in the reconcile transaction for an effective-route-drift refusal", async () => {
      const f = await fixture("reconcile-drift");
      await lease(f);
      const scope = await dispatched(f, "turn-drift");
      const reconciliation = { taskId: f.taskId, attemptKey: scope.attemptKey, controllerToken: scope.controllerToken,
        outcome: "proved_failed", evidenceDigest: sha("drift"), observerId: "pi", refusalReason: "effective-route-drift" } as
        CccProviderAttemptReconciliation;
      await expect(reconcileCccProviderAttempt({ layer: h.layer(), rootDir: h.rootDir(), reconciliation }))
        .resolves.toMatchObject({ state: "proved_failed" });
      expect(await anchor(f)).toMatchObject({ state: "blocked_provider", state_code: "CCC_PROVIDER_PIN_DRIFT" });
      const terminal = await rows<{ xmin: string }>(sql`
        SELECT xmin::text AS xmin FROM project.run_audit_events
         WHERE campaign_import_id = ${f.importId} AND mutation_type = 'ccc-campaign:provider-attempt:terminal'
      `);
      const moved = await events(f, "ccc-planning:state");
      expect(moved.map((event) => event.xmin)).toEqual([terminal[0]!.xmin]);
      expect((await events(f, "ccc-planning:writer-refused")).map((event) => event.metadata.reason)).toEqual(["effective-route-drift"]);

      const plain = await fixture("reconcile-plain", { link: null });
      await lease(plain);
      const plainScope = await dispatched(plain, "turn-drift");
      await expect(reconcileCccProviderAttempt({ layer: h.layer(), rootDir: h.rootDir(), reconciliation: { ...reconciliation,
        taskId: plain.taskId, attemptKey: plainScope.attemptKey, controllerToken: plainScope.controllerToken } }))
        .resolves.toMatchObject({ state: "proved_failed" });
      expect(await rows(sql`SELECT 1 FROM project.run_audit_events WHERE mutation_type LIKE 'ccc-planning:%'
        AND metadata->>'importId' = ${plain.importId}`)).toEqual([]);
    });

    it("reconcileCccPlanningCampaignOutcome maps item states written outside the hook, idempotently", async () => {
      const f = await fixture("backstop");
      await setItem(f, "succeeded");
      expect(await anchor(f)).toMatchObject({ state: "building" });
      await reconcileCccPlanningCampaignOutcome(h.layer(), f.runId);
      expect(await anchor(f)).toMatchObject({ state: "failed", state_code: "CCC_PLANNING_FINAL_JUDGMENT_MISSING" });
      await reconcileCccPlanningCampaignOutcome(h.layer(), f.runId);
      expect(await stateMoves(f)).toEqual(["building->failed"]);
    });
  });

  describe("unlinked positive control", () => {
    it("gives an unlinked campaign the same work-item results and no planning rows", async () => {
      const linked = await fixture("twin-linked");
      const plain = await fixture("twin-plain", { link: null });
      const results: Array<Array<Pick<WorkflowWorkItem, "state" | "attempt" | "blockedReason" | "lastError">>> = [];
      for (const f of [linked, plain]) {
        await setItem(f, "runnable");
        const steps = [
          await transition(f, "held", { expectedLeaseOwner: null, blockedReason: PAUSED_REASON }),
          await transition(f, "runnable", { expectedLeaseOwner: null, blockedReason: null }),
          await transition(f, "running", { attempt: 1, leaseOwner: f.leaseOwner, leaseExpiresAt: f.campaign.campaignDeadlineAt }),
          await transition(f, "failed", { leaseOwner: null, leaseExpiresAt: null, lastError: "boom" }),
        ];
        results.push(steps.map((step) => ({ state: step.state, attempt: step.attempt, blockedReason: step.blockedReason,
          lastError: step.lastError })));
      }
      expect(results[1]).toEqual(results[0]);
      expect(await anchor(linked)).toMatchObject({ state: "failed" });
      const transitions = await rows<{ meta: string }>(sql`
        SELECT (metadata - 'id')::text AS meta FROM project.run_audit_events
         WHERE mutation_type = 'workflowWorkItem:transition' AND run_id = ${`ccc-prd:${plain.importId}`} ORDER BY timestamp, id
      `);
      expect(transitions.map((row) => JSON.parse(row.meta) as Row)).toEqual([
        { fromState: "runnable", toState: "held", attempt: 1 }, { fromState: "held", toState: "runnable", attempt: 1 },
        { fromState: "runnable", toState: "running", attempt: 1 }, { fromState: "running", toState: "failed", attempt: 1 },
      ]);
      expect(await rows(sql`SELECT 1 FROM project.run_audit_events WHERE mutation_type LIKE 'ccc-planning:%'
        AND (metadata->>'importId' = ${plain.importId} OR target LIKE ${`%${plain.workItemId}%`})`)).toEqual([]);
    });
  });
});
