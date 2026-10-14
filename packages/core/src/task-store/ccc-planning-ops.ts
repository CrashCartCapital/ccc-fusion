/*
FNXC:CccPlanningLedger 2026-10-14-14:05:
The request-to-code planning ledger, control and cancellation (CONTRACT-v3 section 2.11, card L1). Each function is one
PostgreSQL transaction that locks in a fixed order (the fenced work item, then the anchor row) so concurrent callers
serialize instead of deadlocking, reads the database clock, folds the run's append-only audit history, checks the
section 2.9 counters and writes the anchor and its deterministic audit events together (D4, D39). A refusal writes
nothing. The anchor trigger (0042) is the backstop for every counter rule enforced here.

Audit events go through `recordRunAuditEventWithinTransaction` directly, because `TaskStore.recordRunAuditEvent` drops
the deterministic `eventId` (errata E1 carry-forward). Metadata never carries an `undefined` value: optional keys are
added only when present, so a replay compares equal without relying on any normalization in the data layer.
*/
import { createHash, randomUUID } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import {
  recordRunAuditEventWithinTransaction,
  RunAuditEventCollisionError,
  type AsyncDataLayer,
  type DbTransaction,
} from "../postgres/data-layer.js";
import { CccPlanningRefusal, cccPlanningRefusalFromDatabaseError, type CccPlanningRefusalCode } from "../ccc-planning/errors.js";
import {
  CCC_PLANNING_LAUNCH_HEADROOM_MS,
  CCC_PLANNING_MAX_CALLS_PER_ATTEMPT,
  CCC_PLANNING_MAX_DISPATCH_ATTEMPTS_PER_LINEAGE,
  CCC_PLANNING_MAX_REPAIR_CHUNKS,
  CCC_PLANNING_PREFLIGHT_LINEAGES,
  CCC_PLANNING_PREFLIGHT_MAX_CALLS_PER_ATTEMPT,
  CCC_PLANNING_SOURCE_POLICY_I2,
  CCC_PLANNING_STAGNATION_EPOCHS,
  cccPlanningAttemptKey,
  cccPlanningBindingHash,
  cccPlanningDecisionId,
  cccPlanningEventId,
  cccPlanningRole,
  cccPlanningTurnKey,
} from "../ccc-planning/policy.js";
import { assessCccRepairChunkFit } from "../ccc-planning/budget-fit.js";
import {
  CCC_PLANNING_ARTIFACT_ENVELOPE_SCHEMA,
  computeCccPlanningEnvelopeIdentityDigest,
  encodeCccPlanningArtifactContent,
  encodeCccPlanningArtifactKey,
} from "../ccc-planning/artifacts.js";
import {
  CCC_PLANNING_IR_STAGES,
  CCC_PLANNING_RUN_STATES,
  CCC_PLANNING_TERMINAL_STATES,
  cccPlanningResumeTarget,
  cccPlanningTransitionAllowed,
  type CccPlanningAuditMutationType,
  type CccPlanningBudgetProfile,
  type CccPlanningCallRequest,
  type CccPlanningCallScope,
  type CccPlanningMode,
  type CccPlanningRoleId,
  type CccPlanningRoleProfile,
  type CccPlanningRouteBinding,
  type CccPlanningRunCustody,
  type CccPlanningRunState,
  type CccPlanningRunStatusV1,
  type CccPlanningWorkItemFence,
} from "../ccc-planning/types.js";
import {
  CccProviderAttemptCollisionError,
  CccProviderAttemptIdentityError,
  CccProviderAttemptLimitError,
  CccProviderAttemptStateError,
  type CccCampaignWorkItemFence,
  type CccProviderAttemptEffectiveRoute,
  type CccProviderAttemptLimitReason,
  type CccProviderAttemptSettlementInputOf,
} from "../ccc-campaign/types.js";
import { assertCccProviderAttemptEffectiveRoute } from "../ccc-campaign/provider-attempt.js";
import type {
  CccProviderAttemptControllerView,
  CccProviderControllerDecisionView,
} from "../ccc-campaign/provider-controller.js";

export type CccPlanningLinkedOutcomePorts = Readonly<{
  reconcileLinkedOutcome?: (layer: AsyncDataLayer, runId: string) => Promise<void>;
}>;   // verify-v2 item 35: BF (W6) owns the real function; L1 only takes this optional port

// ---------------------------------------------------------------- shared vocabulary

const CONTROLLER_AGENT = "ccc-planning-controller";
const RUN_ID_PATTERN = /^ccc-plan:[0-9a-f]{24}$/u;
const DISPATCH_KEY_PATTERN = /^pi-stream:([1-9][0-9]{0,8})$/u;
const GRANT_KEY_PATTERN = /^(ccc-plan:[0-9a-f]{24}):f([1-9][0-9]{0,8})$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const STATE_CODE_PATTERN = /^CCC_[A-Z0-9_]{1,120}$/u;
const ACTOR_MAX = 200;
const TERMINAL_STATES: ReadonlySet<string> = new Set(CCC_PLANNING_TERMINAL_STATES);
const RUN_STATES: ReadonlySet<string> = new Set(CCC_PLANNING_RUN_STATES);
const WORK_ITEM_TERMINAL: ReadonlySet<string> = new Set(["succeeded", "failed", "cancelled", "exhausted"]);
/** States the anchor CHECK (ccc_planning_runs_state_code_check) refuses without a state code. */
const STATE_CODE_REQUIRED: ReadonlySet<string> = new Set([
  "awaiting_budget", "blocked_prerequisite", "blocked_provider", "budget_exhausted", "unknown_effect",
  "verification_failed", "failed",
]);
const ROUTE_REFUSALS: ReadonlySet<string> = new Set(["receipt-missing", "receipt-mismatch", "effective-route-drift"]);

type Row = Record<string, unknown>;

type AnchorRow = {
  project_id: string; run_id: string; planning_task_id: string; mode: CccPlanningMode; budget_profile: CccPlanningBudgetProfile;
  role_profile: CccPlanningRoleProfile; policy_digest: string; grant_digest: string; runtime_dist_manifest_sha256: string;
  revision: number; state: CccPlanningRunState; state_code: string | null; deadline_at: string;
  planning_allocation: number; implementation_allocation: number; review_proof_allocation: number;
  planning_spent: number; review_proof_spent: number; research_fetch_allocation: number; research_fetch_spent: number;
  research_bytes_allocation: number; research_bytes_spent: number; repair_epoch_state: "unopened" | "open" | "closed";
  repair_chunks_used: number; review_epochs: number; stagnant_epochs: number; control_seq: number;
  control_request: "pause" | "cancel" | "resume" | null; control_revision: number | null; control_requested_at: string | null;
  awaiting_decision_id: string | null; import_intent_digest: string | null; import_idempotency_key: string | null;
  import_id: string | null; implementation_transferred: number | null; updated_at: string;
};

const ANCHOR_COLUMNS = sql.raw(`project_id, run_id, planning_task_id, mode, budget_profile, role_profile, policy_digest,
  grant_digest, runtime_dist_manifest_sha256, revision, state, state_code, deadline_at, planning_allocation,
  implementation_allocation, review_proof_allocation, planning_spent, review_proof_spent, research_fetch_allocation,
  research_fetch_spent, research_bytes_allocation::text AS research_bytes_allocation,
  research_bytes_spent::text AS research_bytes_spent, repair_epoch_state, repair_chunks_used, review_epochs,
  stagnant_epochs, control_seq, control_request, control_revision, control_requested_at, awaiting_decision_id,
  import_intent_digest, import_idempotency_key, import_id, implementation_transferred, updated_at`);

function refuse(code: CccPlanningRefusalCode, detail: string, field?: string): never {
  throw new CccPlanningRefusal(code, detail, field);
}

function limit(reason: CccProviderAttemptLimitReason, detail: string): never {
  throw new CccProviderAttemptLimitError(reason, `CCC planning ${reason}: ${detail}`);
}

function invalid(detail: string): never {
  throw new CccProviderAttemptIdentityError("invalid-input", `CCC planning call: ${detail}`);
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function pad3(value: number): string {
  return String(value).padStart(3, "0");
}

async function rows<T = Row>(tx: DbTransaction, query: SQL): Promise<T[]> {
  return (await tx.execute(query)) as unknown as T[];
}

function normalizeAnchor(row: Row): AnchorRow {
  return {
    ...(row as unknown as AnchorRow),
    research_bytes_allocation: Number(row.research_bytes_allocation),
    research_bytes_spent: Number(row.research_bytes_spent),
  };
}

/** Our own refusals pass through; a trigger refusal (CCC_PLANNING_* message prefix) becomes the typed refusal. */
function mapDatabaseError(error: unknown): unknown {
  if (error instanceof CccPlanningRefusal || error instanceof CccProviderAttemptLimitError
    || error instanceof CccProviderAttemptIdentityError || error instanceof CccProviderAttemptStateError
    || error instanceof CccProviderAttemptCollisionError || error instanceof RunAuditEventCollisionError) {
    return error;
  }
  return cccPlanningRefusalFromDatabaseError(error) ?? error;
}

async function inTransaction<T>(layer: AsyncDataLayer, work: (tx: DbTransaction) => Promise<T>): Promise<T> {
  try {
    return await layer.transactionImmediate(work);
  } catch (error) {
    throw mapDatabaseError(error);
  }
}

async function databaseNow(tx: DbTransaction): Promise<string> {
  const result = await rows<{ now: string }>(tx, sql`
    SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now
  `);
  return result[0]!.now;
}

/**
 * FNXC:CccPlanningLedger 2026-10-14-14:05:
 * The state event subject is `${from}->${to}@${OLD.updated_at}` (section 2.1), so two transitions of one run must never
 * share an `updated_at`; the next value is strictly later than the old one even inside one database millisecond.
 * FNXC:CccPlanningLedger 2026-10-14-14:16:
 * The state event is stamped with that new `updated_at`, so a run's state history (cancelling then cancelled in one
 * transaction) has a strict time order instead of a tie broken by the hashed event id.
 */
function nextUpdatedAt(previous: string, now: string): string {
  const before = Date.parse(previous);
  const current = Date.parse(now);
  return Number.isFinite(before) && current <= before ? new Date(before + 1).toISOString() : now;
}

function requireRunId(runId: string): void {
  if (typeof runId !== "string" || !RUN_ID_PATTERN.test(runId)) {
    refuse("CCC_PLANNING_RUN_NOT_FOUND", `run id ${JSON.stringify(runId)} is not ccc-plan:<24 hex>`, "runId");
  }
}

/** E2-4/E3-3: the CLI refuses first, so an actor that reaches L1 out of range is a caller bug. */
function requireActor(actor: unknown): string {
  const trimmed = typeof actor === "string" ? actor.trim() : "";
  if (trimmed.length < 1 || trimmed.length > ACTOR_MAX) {
    refuse("CCC_PLANNING_INTERNAL_ERROR", `actor must be 1 to ${ACTOR_MAX} characters after trim`, "actor");
  }
  return trimmed;
}

function requireControlRequest(request: unknown): "pause" | "cancel" | "resume" {
  if (request !== "pause" && request !== "cancel" && request !== "resume") {
    refuse("CCC_PLANNING_INTERNAL_ERROR", `control request must be pause, cancel or resume, got ${String(request)}`, "request");
  }
  return request;
}

function scopeClause(layer: AsyncDataLayer): SQL {
  const projectId = layer.projectId?.trim();
  return projectId ? sql`AND project_id = ${projectId}` : sql``;
}

/** Identity read (no lock) by run id within the layer's bound project, when it has one. */
async function locateRun(tx: DbTransaction, layer: AsyncDataLayer, runId: string): Promise<AnchorRow> {
  requireRunId(runId);
  const found = await rows(tx, sql`
    SELECT ${ANCHOR_COLUMNS} FROM project.ccc_planning_runs WHERE run_id = ${runId} ${scopeClause(layer)}
  `);
  if (found.length === 0) refuse("CCC_PLANNING_RUN_NOT_FOUND", `run ${runId} not found`, "runId");
  if (found.length > 1) refuse("CCC_PLANNING_RUN_AMBIGUOUS", `run ${runId} exists in ${found.length} projects`, "runId");
  return normalizeAnchor(found[0]!);
}

async function lockAnchor(tx: DbTransaction, projectId: string, runId: string): Promise<AnchorRow> {
  const locked = await rows(tx, sql`
    SELECT ${ANCHOR_COLUMNS} FROM project.ccc_planning_runs
     WHERE project_id = ${projectId} AND run_id = ${runId} FOR UPDATE
  `);
  if (locked.length !== 1) refuse("CCC_PLANNING_RUN_NOT_FOUND", `run ${runId} not found`, "runId");
  return normalizeAnchor(locked[0]!);
}

function custodyOf(anchor: AnchorRow): CccPlanningRunCustody {
  return {
    kind: "planning", projectId: anchor.project_id, runId: anchor.run_id, planningTaskId: anchor.planning_task_id,
    revision: anchor.revision, state: anchor.state, mode: anchor.mode, budgetProfile: anchor.budget_profile,
    deadlineAt: anchor.deadline_at, grantDigest: anchor.grant_digest, controlSeq: anchor.control_seq,
    importId: anchor.import_id, runtimeDistManifestSha256: anchor.runtime_dist_manifest_sha256,
  };
}

/**
 * Locks the fenced work item with the same predicate as the campaign lease fence (running, same owner and attempt,
 * lease not expired by the database clock). A planning fence names the run's own planning work item; a campaign
 * fence names the linked import's campaign item (`ccc-prd:<import_id>`, D14).
 */
async function lockFence(tx: DbTransaction, anchor: AnchorRow, fence: CccPlanningWorkItemFence,
  kind: "planning" | "campaign" | "either"): Promise<void> {
  if (!fence || typeof fence !== "object" || typeof fence.workItemId !== "string" || typeof fence.leaseOwner !== "string"
    || typeof fence.originTaskId !== "string" || typeof fence.runId !== "string" || !Number.isSafeInteger(fence.attempt)) {
    refuse("CCC_PLANNING_FENCE_STALE", "fence is malformed", "fence");
  }
  if (kind !== "either" && fence.kind !== kind) {
    refuse("CCC_PLANNING_FENCE_STALE", `a ${kind} fence is required, got ${String(fence.kind)}`, "fence");
  }
  if (fence.kind === "planning") {
    if (fence.runId !== anchor.run_id || fence.originTaskId !== anchor.planning_task_id) {
      refuse("CCC_PLANNING_FENCE_STALE", "planning fence does not name this run's planning work item", "fence");
    }
  } else if (fence.kind === "campaign") {
    if (anchor.import_id === null || fence.runId !== `ccc-prd:${anchor.import_id}`) {
      refuse("CCC_PLANNING_FENCE_STALE", "campaign fence does not name this run's linked import", "fence");
    }
  } else {
    refuse("CCC_PLANNING_FENCE_STALE", `unknown fence kind ${String((fence as { kind?: unknown }).kind)}`, "fence");
  }
  const locked = await rows(tx, sql`
    SELECT id FROM project.workflow_work_items
     WHERE project_id = ${anchor.project_id} AND id = ${fence.workItemId} AND task_id = ${fence.originTaskId}
       AND run_id = ${fence.runId} AND state = 'running' AND lease_owner = ${fence.leaseOwner}
       AND attempt = ${fence.attempt} AND lease_expires_at IS NOT NULL
       AND lease_expires_at::timestamptz > clock_timestamp()
     FOR UPDATE
  `);
  if (locked.length !== 1) refuse("CCC_PLANNING_FENCE_STALE", `work item ${fence.workItemId} lease is not current`, "fence");
}

type PlanningItem = { id: string; state: string; attempt: number; lease_expires_at: string | null };

/** The run's planning work items (run_id = runId on the planning task), locked before the anchor. */
async function lockPlanningItems(tx: DbTransaction, anchor: AnchorRow): Promise<PlanningItem[]> {
  return rows<PlanningItem>(tx, sql`
    SELECT id, state, attempt, lease_expires_at FROM project.workflow_work_items
     WHERE project_id = ${anchor.project_id} AND run_id = ${anchor.run_id} AND task_id = ${anchor.planning_task_id}
     ORDER BY id FOR UPDATE
  `);
}

async function appendEvent(tx: DbTransaction, anchor: AnchorRow, i: Readonly<{
  mutationType: CccPlanningAuditMutationType; subject: string; agentId: string; timestamp: string; metadata: Row }>): Promise<void> {
  await recordRunAuditEventWithinTransaction(tx, {
    timestamp: i.timestamp, taskId: anchor.planning_task_id, agentId: i.agentId, runId: anchor.run_id, domain: "database",
    mutationType: i.mutationType, target: i.subject, metadata: i.metadata,
    eventId: cccPlanningEventId({ projectId: anchor.project_id, runId: anchor.run_id, mutationType: i.mutationType, subject: i.subject }),
  }, anchor.project_id);
}

/** CAS state move plus its state event. Leaving a pending control behind is impossible for paused/cancelling/cancelled. */
async function moveRun(tx: DbTransaction, anchor: AnchorRow, i: Readonly<{ to: CccPlanningRunState; stateCode: string | null;
  now: string; agentId: string; bumpControlSeq?: boolean; decisionId?: string }>): Promise<AnchorRow> {
  const from = anchor.state;
  if (from === i.to || !cccPlanningTransitionAllowed(from, i.to)) {
    refuse("CCC_PLANNING_STATE_TRANSITION_REFUSED", `run ${anchor.run_id} ${from} -> ${i.to} is not allowed`, "state");
  }
  if (STATE_CODE_REQUIRED.has(i.to) && i.stateCode === null) {
    refuse("CCC_PLANNING_STATE_TRANSITION_REFUSED", `state ${i.to} requires a state code`, "stateCode");
  }
  if (i.to === "awaiting_intent" && !i.decisionId) {
    refuse("CCC_PLANNING_STATE_TRANSITION_REFUSED", "awaiting_intent requires a published decision_request", "state");
  }
  const clearsControl = i.to === "paused" || i.to === "cancelling" || i.to === "cancelled";
  const updatedAt = nextUpdatedAt(anchor.updated_at, i.now);
  const assignments: SQL[] = [
    sql`state = ${i.to}`,
    sql`state_code = ${i.stateCode}`,
    sql`awaiting_decision_id = ${i.to === "awaiting_intent" ? i.decisionId! : null}`,
    sql`updated_at = ${updatedAt}`,
    ...(clearsControl ? [sql`control_request = NULL`, sql`control_revision = NULL`, sql`control_requested_at = NULL`] : []),
    ...(i.bumpControlSeq ? [sql`control_seq = control_seq + 1`] : []),
  ];
  const updated = await rows(tx, sql`
    UPDATE project.ccc_planning_runs SET ${sql.join(assignments, sql`, `)}
     WHERE project_id = ${anchor.project_id} AND run_id = ${anchor.run_id} AND state = ${from}
    RETURNING ${ANCHOR_COLUMNS}
  `);
  if (updated.length !== 1) refuse("CCC_PLANNING_STATE_TRANSITION_REFUSED", `run ${anchor.run_id} changed concurrently`, "state");
  const row = normalizeAnchor(updated[0]!);
  await appendEvent(tx, row, {
    mutationType: "ccc-planning:state", subject: `${from}->${i.to}@${anchor.updated_at}`, agentId: i.agentId, timestamp: updatedAt,
    metadata: {
      schema: "ccc-planning-state/v1", runId: row.run_id, revision: row.revision, from, to: i.to, stateCode: i.stateCode,
      controlSeq: row.control_seq, ...(i.decisionId ? { decisionId: i.decisionId } : {}),
    },
  });
  return row;
}

// ---------------------------------------------------------------- history fold (D4)

type CallRecord = {
  attemptKey: string; turnKey: string; dispatchKey: string; lineageId: string; phase: string; preflight: boolean;
  bindingHash: string; reserved: Row; reservedAt: string; dispatchedAt: string | null; terminal: Row | null;
};
type LineageRecord = Row & { lineageId: string; inheritedDispatchAttempts: number };

type History = {
  calls: Map<string, CallRecord>;
  lineages: Map<string, LineageRecord>;
};

async function readCallHistory(tx: DbTransaction, anchor: AnchorRow): Promise<History> {
  const events = await rows<{ mutation_type: string; target: string; metadata: Row; timestamp: string }>(tx, sql`
    SELECT mutation_type, target, metadata, timestamp FROM project.run_audit_events
     WHERE project_id = ${anchor.project_id} AND run_id = ${anchor.run_id}
       AND mutation_type IN ('ccc-planning:call:reserved', 'ccc-planning:call:dispatched', 'ccc-planning:call:terminal',
                             'ccc-planning:lineage:created')
  `);
  const calls = new Map<string, CallRecord>();
  const lineages = new Map<string, LineageRecord>();
  for (const event of events) {
    if (event.mutation_type === "ccc-planning:call:reserved") {
      const meta = event.metadata;
      calls.set(String(meta.attemptKey), {
        attemptKey: String(meta.attemptKey), turnKey: String(meta.turnKey), dispatchKey: String(meta.dispatchKey),
        lineageId: String(meta.lineageId), phase: String(meta.phase), preflight: meta.preflight === true,
        bindingHash: String(meta.bindingHash), reserved: meta, reservedAt: event.timestamp, dispatchedAt: null, terminal: null,
      });
    } else if (event.mutation_type === "ccc-planning:lineage:created") {
      lineages.set(String(event.metadata.lineageId), event.metadata as LineageRecord);
    }
  }
  for (const event of events) {
    const call = calls.get(event.target);
    if (!call) continue;
    if (event.mutation_type === "ccc-planning:call:dispatched") call.dispatchedAt = event.timestamp;
    if (event.mutation_type === "ccc-planning:call:terminal") call.terminal = event.metadata;
  }
  return { calls, lineages };
}

function dispatchAttempts(history: History, lineageId: string): number {
  const inherited = Number(history.lineages.get(lineageId)?.inheritedDispatchAttempts ?? 0);
  const turns = new Set<string>();
  for (const call of history.calls.values()) if (call.lineageId === lineageId) turns.add(call.turnKey);
  return inherited + turns.size;
}

function callsInTurn(history: History, turnKey: string): CallRecord[] {
  return [...history.calls.values()].filter((call) => call.turnKey === turnKey)
    .sort((left, right) => dispatchOrdinal(left.dispatchKey) - dispatchOrdinal(right.dispatchKey));
}

function dispatchOrdinal(dispatchKey: string): number {
  const match = DISPATCH_KEY_PATTERN.exec(dispatchKey);
  return match ? Number(match[1]) : Number.NaN;
}

function controllerTokenFor(projectId: string, attemptKey: string): string {
  return `ccc-plan-token-${sha256Hex(`ccc-plan-token/v1\0${projectId}\0${attemptKey}`)}`;
}

function fenceSummary(fence: CccPlanningWorkItemFence): Row {
  return { kind: fence.kind, workItemId: fence.workItemId, runId: fence.runId, attempt: fence.attempt };
}

// ---------------------------------------------------------------- custody and status reads

export async function getCccPlanningRunForTask(layer: AsyncDataLayer, taskId: string): Promise<CccPlanningRunCustody | null> {
  return inTransaction(layer, async (tx) => {
    const found = await rows(tx, sql`
      SELECT ${ANCHOR_COLUMNS} FROM project.ccc_planning_runs WHERE planning_task_id = ${taskId} ${scopeClause(layer)}
    `);
    if (found.length === 0) return null;
    if (found.length > 1) refuse("CCC_PLANNING_RUN_AMBIGUOUS", `task ${taskId} anchors runs in ${found.length} projects`, "taskId");
    return custodyOf(normalizeAnchor(found[0]!));
  });
}

type ArtifactRow = { key: string; stage: string | null; kind: string | null; digest: string | null };

async function readRevisionArtifacts(tx: DbTransaction, anchor: AnchorRow): Promise<ArtifactRow[]> {
  return rows<ArtifactRow>(tx, sql`
    SELECT key, metadata->>'stageId' AS stage, metadata->>'kind' AS kind, metadata->>'outputDigest' AS digest
      FROM project.task_documents
     WHERE project_id = ${anchor.project_id} AND task_id = ${anchor.planning_task_id}
       AND key LIKE ${`cccplan-r${pad3(anchor.revision)}-%`}
     ORDER BY key
  `);
}

/** Every decision_request of the current revision, keyed by the decision id it implies (D47, section 2.1). */
async function readQuestions(tx: DbTransaction, anchor: AnchorRow): Promise<Array<{ key: string; digest: string; decisionId: string }>> {
  const artifacts = await readRevisionArtifacts(tx, anchor);
  return artifacts
    .filter((artifact) => artifact.kind === "decision_request" && artifact.digest !== null && DIGEST_PATTERN.test(artifact.digest))
    .map((artifact) => ({
      key: artifact.key, digest: artifact.digest!,
      decisionId: cccPlanningDecisionId({ revision: anchor.revision, questionDigest: artifact.digest! }),
    }));
}

export async function inspectCccPlanningRun(layer: AsyncDataLayer, runId: string,
  ports?: CccPlanningLinkedOutcomePorts): Promise<CccPlanningRunStatusV1> {
  /*
  FNXC:CccPlanningLedger 2026-10-14-14:05:
  D43 and verify-v2 item 35: for a linked run the campaign outcome is reconciled before the status is read, through the
  optional port (BF owns the real function; WR and CL2 wire it). The port runs outside any L1 transaction, so it can take
  its own locks; an unlinked run, or a call without ports, only reads.
  */
  const located = await inTransaction(layer, (tx) => locateRun(tx, layer, runId));
  if (located.import_id !== null && ports?.reconcileLinkedOutcome) await ports.reconcileLinkedOutcome(layer, runId);
  return inTransaction(layer, async (tx) => {
    const anchor = await locateRun(tx, layer, runId);
    const history = await readCallHistory(tx, anchor);
    const artifacts = await readRevisionArtifacts(tx, anchor);
    const controls = await rows<{ metadata: Row; timestamp: string }>(tx, sql`
      SELECT metadata, timestamp FROM project.run_audit_events
       WHERE project_id = ${anchor.project_id} AND run_id = ${anchor.run_id} AND mutation_type = 'ccc-planning:control'
    `);
    const lastControlEvent = controls.sort((left, right) => Number(right.metadata.controlSeq) - Number(left.metadata.controlSeq))[0];
    const importRow = anchor.import_id === null ? undefined : (await rows<{ state: string; request_count: number }>(tx, sql`
      SELECT state, request_count FROM project.ccc_prd_imports
       WHERE project_id = ${anchor.project_id} AND import_id = ${anchor.import_id}
    `))[0];
    const calls = [...history.calls.values()];
    const question = anchor.awaiting_decision_id === null ? undefined
      : (await readQuestions(tx, anchor)).find((candidate) => candidate.decisionId === anchor.awaiting_decision_id);
    const stages = CCC_PLANNING_IR_STAGES
      .filter((stageId) => anchor.mode === "build" || stageId !== "import")
      .map((stageId) => {
        const artifactKeys = artifacts.filter((artifact) => artifact.stage === stageId).map((artifact) => artifact.key);
        return { stageId, status: artifactKeys.length > 0 ? "committed" as const : "pending" as const, artifactKeys };
      });
    return {
      schema: "ccc-planning.run-status.v1",
      runId: anchor.run_id, projectId: anchor.project_id, planningTaskId: anchor.planning_task_id, mode: anchor.mode,
      budgetProfile: anchor.budget_profile, roleProfile: anchor.role_profile, state: anchor.state, stateCode: anchor.state_code,
      revision: anchor.revision, controlSeq: anchor.control_seq, deadlineAt: anchor.deadline_at,
      pendingControl: anchor.control_request === null ? null : {
        request: anchor.control_request, revision: anchor.control_revision ?? anchor.revision,
        requestedAt: anchor.control_requested_at ?? "",
      },
      lastControl: lastControlEvent === undefined ? null : {
        request: lastControlEvent.metadata.request as "pause" | "cancel" | "resume",
        controlSeq: Number(lastControlEvent.metadata.controlSeq), actor: String(lastControlEvent.metadata.actor),
        at: lastControlEvent.timestamp, route: lastControlEvent.metadata.route as "planning" | "campaign-bridge",
        outcome: lastControlEvent.metadata.outcome as "applied" | "pending" | "deferred-leased",
      },
      awaitingDecision: anchor.awaiting_decision_id === null ? null : {
        decisionId: anchor.awaiting_decision_id, questionArtifactKey: question?.key ?? "", questionDigest: question?.digest ?? "",
      },
      budgets: {
        planning: {
          allocation: anchor.planning_allocation, spent: anchor.planning_spent,
          preflightSpent: calls.filter((call) => call.preflight && call.phase === "planning").length,
        },
        implementation: {
          allocation: anchor.implementation_allocation, transferred: anchor.implementation_transferred,
          spent: importRow === undefined ? null : Number(importRow.request_count),
        },
        reviewProof: { allocation: anchor.review_proof_allocation, spent: anchor.review_proof_spent },
        researchFetches: { allocation: anchor.research_fetch_allocation, spent: anchor.research_fetch_spent },
        researchBytes: { allocation: anchor.research_bytes_allocation, spent: anchor.research_bytes_spent },
      },
      counters: {
        repairEpochState: anchor.repair_epoch_state, repairChunksUsed: anchor.repair_chunks_used,
        reviewEpochs: anchor.review_epochs, stagnantEpochs: anchor.stagnant_epochs,
      },
      stages,
      unreconciled: calls.filter((call) => call.terminal === null)
        .map((call) => ({ lineageId: call.lineageId, attemptKey: call.attemptKey, dispatchedAt: call.dispatchedAt ?? call.reservedAt })),
      writerAttempts: [],   // BF (W6) owns linked writer attempts
      import: anchor.import_idempotency_key === null ? null : {
        idempotencyKey: anchor.import_idempotency_key, intentDigest: anchor.import_intent_digest ?? "",
        importId: anchor.import_id, importState: importRow?.state ?? null,
      },
      executionAuthority: null,   // AU2 owns the live-execution release
      notRun: [],
    };
  });
}

/**
 * FNXC:CccPlanningLedger 2026-10-14-14:05:
 * `fn plan <RUN_ID>` resolves the project from the run row (D49). The lookup bypasses project isolation for this one
 * read only; every later call runs project-scoped with the returned projectId.
 */
export async function resolveCccPlanningRunProject(layer: AsyncDataLayer, i: Readonly<{ runId: string; projectId?: string }>):
  Promise<Readonly<{ projectId: string }>> {
  requireRunId(i.runId);
  const projects = await inTransaction(layer, async (tx) => {
    await tx.execute(sql`SELECT set_config('fusion.project_bypass', 'on', true)`);
    return rows<{ project_id: string }>(tx, sql`
      SELECT DISTINCT project_id FROM project.ccc_planning_runs WHERE run_id = ${i.runId} ORDER BY project_id
    `);
  });
  if (projects.length === 0) refuse("CCC_PLANNING_RUN_NOT_FOUND", `run ${i.runId} not found`, "runId");
  if (projects.length > 1) refuse("CCC_PLANNING_RUN_AMBIGUOUS", `run ${i.runId} exists in ${projects.length} projects`, "runId");
  const projectId = projects[0]!.project_id;
  if (i.projectId !== undefined && i.projectId !== projectId) {
    refuse("CCC_PLANNING_RUN_PROJECT_MISMATCH", `run ${i.runId} belongs to another project`, "projectId");
  }
  return { projectId };
}

// ---------------------------------------------------------------- dispatch admission and settlement (section 2.9, D10)

function isPreflightLineage(binding: CccPlanningRouteBinding): boolean {
  return CCC_PLANNING_PREFLIGHT_LINEAGES.some((entry) => entry.lineageId === binding.lineageId && entry.roleId === binding.roleId);
}

/** Structural checks that need no database: binding hash, derived turn key, 1-based dispatch key, role class and phase. */
function requireCallRequest(request: CccPlanningCallRequest): number {
  const binding = request?.binding;
  if (!binding || binding.kind !== "ccc-planning-route.v1") invalid("binding kind must be ccc-planning-route.v1");
  if (binding.bindingHash !== cccPlanningBindingHash(binding)) invalid("bindingHash does not match the binding");
  if (binding.transport !== "pi") invalid("transport must be pi");
  let role;
  try {
    role = cccPlanningRole(binding.roleId);
  } catch {
    invalid(`unknown role ${JSON.stringify(binding.roleId)}`);
  }
  if (role.roleClass !== binding.roleClass) invalid(`role ${binding.roleId} is ${role.roleClass}, binding says ${binding.roleClass}`);
  if (role.phase === "implementation" || role.phase !== binding.phase) {
    invalid(`role ${binding.roleId} is charged to ${role.phase}, binding says ${binding.phase}`);
  }
  const turnKey = cccPlanningTurnKey({
    projectId: binding.projectId, runId: binding.runId, revision: binding.runRevision, stageId: binding.stageId,
    roleId: binding.roleId, lineageId: binding.lineageId, nodeAttemptOrdinal: binding.nodeAttemptOrdinal,
  });
  if (request.turnKey !== turnKey) invalid("turnKey is not the key derived from the binding");
  const ordinal = dispatchOrdinal(request.dispatchKey);
  if (!Number.isSafeInteger(ordinal)) invalid(`dispatch key ${JSON.stringify(request.dispatchKey)} is not pi-stream:<N>`);
  if (request.preflight !== isPreflightLineage(binding)) invalid("preflight is true only for the three qualification lineages");
  return ordinal;
}

function requireBindingMatchesRun(binding: CccPlanningRouteBinding, anchor: AnchorRow): void {
  if (binding.projectId !== anchor.project_id || binding.taskId !== anchor.planning_task_id
    || binding.grantDigest !== anchor.grant_digest || binding.policyDigest !== anchor.policy_digest) {
    invalid("binding does not match the run's project, planning task, grant or policy");
  }
  if (binding.runRevision !== anchor.revision) {
    refuse("CCC_PLANNING_REVISION_STALE", `binding revision ${binding.runRevision} is not run revision ${anchor.revision}`,
      "runRevision");
  }
}

function callMetadata(request: CccPlanningCallRequest, attemptKey: string, outcome: string): Row {
  const b = request.binding;
  return {
    schema: "ccc-planning-call/v1", runId: b.runId, revision: b.runRevision, stageId: b.stageId, roleId: b.roleId,
    lineageId: b.lineageId, nodeAttemptOrdinal: b.nodeAttemptOrdinal, turnKey: request.turnKey,
    dispatchKey: request.dispatchKey, attemptKey, phase: b.phase, providerId: b.providerId, modelId: b.modelId,
    transport: b.transport, preflight: request.preflight, bindingHash: b.bindingHash, toolsetDigest: b.toolsetDigest,
    promptDigest: b.promptDigest, fence: fenceSummary(request.fence), outcome,
  };
}

function scopeFor(anchor: AnchorRow, i: Readonly<{ binding: CccPlanningRouteBinding; turnKey: string; dispatchKey: string;
  attemptKey: string; fence: CccCampaignWorkItemFence; attemptOrdinal: number; requestCount: number;
  state: CccPlanningCallScope["state"] }>): CccPlanningCallScope {
  return {
    attemptKey: i.attemptKey, controllerToken: controllerTokenFor(anchor.project_id, i.attemptKey),
    taskId: anchor.planning_task_id, semanticTaskId: i.binding.lineageId, campaignDeadlineAt: anchor.deadline_at,
    turnKey: i.turnKey, dispatchKey: i.dispatchKey, attemptOrdinal: i.attemptOrdinal, requestCount: i.requestCount,
    workItemFence: i.fence, state: i.state, binding: i.binding,
  };
}

function terminalState(terminal: Row): "committed" | "proved_failed" {
  return terminal.outcome === "committed" ? "committed" : "proved_failed";
}

/** Reserve + begin in one transaction: lock fence item, lock anchor, read db clock, fold history, check 2.9 rules,
 *  CAS the phase counter, append call:reserved and call:dispatched events. */
export async function admitCccPlanningDispatch(layer: AsyncDataLayer, request: CccPlanningCallRequest):
  Promise<CccProviderControllerDecisionView<CccPlanningCallScope>> {
  const ordinal = requireCallRequest(request);
  const binding = request.binding;
  const planningPhase = binding.phase === "planning";
  return inTransaction(layer, async (tx) => {
    const located = await locateRun(tx, layer, binding.runId);
    if (located.project_id !== binding.projectId) {
      refuse("CCC_PLANNING_RUN_PROJECT_MISMATCH", `run ${binding.runId} belongs to another project`, "projectId");
    }
    await lockFence(tx, located, request.fence, planningPhase ? "planning" : "campaign");
    const anchor = await lockAnchor(tx, located.project_id, located.run_id);
    requireBindingMatchesRun(binding, anchor);
    const now = await databaseNow(tx);
    const history = await readCallHistory(tx, anchor);
    const attemptKey = cccPlanningAttemptKey({
      projectId: anchor.project_id, runId: anchor.run_id, turnKey: request.turnKey, dispatchKey: request.dispatchKey,
    });
    const turnCalls = callsInTurn(history, request.turnKey);
    const fence3 = { workItemId: request.fence.workItemId, runId: request.fence.runId, attempt: request.fence.attempt };

    const existing = history.calls.get(attemptKey);
    if (existing) {
      if (existing.bindingHash !== binding.bindingHash) {
        throw new CccProviderAttemptCollisionError(`CCC planning attempt ${attemptKey} was reserved under another binding`);
      }
      const phaseCalls = [...history.calls.values()].filter((call) => call.phase === existing.phase)
        .sort((left, right) => left.reservedAt.localeCompare(right.reservedAt) || left.attemptKey.localeCompare(right.attemptKey));
      return {
        kind: "hold",
        reason: existing.terminal === null ? "dispatched-unknown" : "terminal",
        scope: scopeFor(anchor, {
          binding, turnKey: request.turnKey, dispatchKey: request.dispatchKey, attemptKey, fence: fence3,
          attemptOrdinal: turnCalls.findIndex((call) => call.attemptKey === attemptKey) + 1,
          requestCount: phaseCalls.findIndex((call) => call.attemptKey === attemptKey) + 1,
          state: existing.terminal === null ? "dispatched_unknown" : terminalState(existing.terminal),
        }),
      };
    }

    const phaseState: CccPlanningRunState = planningPhase ? "running" : "building";
    if (anchor.state !== phaseState) limit("run-not-building", `run ${anchor.run_id} is ${anchor.state}, not ${phaseState}`);
    if (anchor.control_request !== null) limit("control-pending", `run ${anchor.run_id} has a pending ${anchor.control_request}`);
    if (Date.parse(now) + CCC_PLANNING_LAUNCH_HEADROOM_MS >= Date.parse(anchor.deadline_at)) {
      limit("deadline", `run ${anchor.run_id} deadline ${anchor.deadline_at} is within the launch headroom`);
    }
    const unsettled = [...history.calls.values()].find((call) => call.lineageId === binding.lineageId && call.terminal === null);
    if (unsettled) limit("unreconciled-dispatch", `lineage ${binding.lineageId} has dispatched_unknown ${unsettled.attemptKey}`);
    if (turnCalls.length === 0 && dispatchAttempts(history, binding.lineageId) >= CCC_PLANNING_MAX_DISPATCH_ATTEMPTS_PER_LINEAGE) {
      limit("dispatch-cap", `lineage ${binding.lineageId} has used ${CCC_PLANNING_MAX_DISPATCH_ATTEMPTS_PER_LINEAGE} dispatch attempts`);
    }
    const cap = request.preflight ? CCC_PLANNING_PREFLIGHT_MAX_CALLS_PER_ATTEMPT : CCC_PLANNING_MAX_CALLS_PER_ATTEMPT;
    if (ordinal > cap || turnCalls.length >= cap) {
      limit("iteration-cap", `turn ${request.turnKey} allows ${cap} calls; ${request.dispatchKey} refused`);
    }
    const spent = planningPhase ? anchor.planning_spent : anchor.review_proof_spent;
    const allocation = planningPhase ? anchor.planning_allocation : anchor.review_proof_allocation;
    if (spent >= allocation) limit("phase-allocation", `${binding.phase} allocation ${allocation} is spent`);

    const column = sql.raw(planningPhase ? "planning_spent" : "review_proof_spent");
    const charged = await rows<{ spent: number }>(tx, sql`
      UPDATE project.ccc_planning_runs SET ${column} = ${column} + 1, updated_at = ${nextUpdatedAt(anchor.updated_at, now)}
       WHERE project_id = ${anchor.project_id} AND run_id = ${anchor.run_id} AND ${column} = ${spent}
         AND state = ${phaseState} AND control_request IS NULL
      RETURNING ${column} AS spent
    `);
    if (charged.length !== 1) throw new CccProviderAttemptStateError(`CCC planning spend CAS lost on run ${anchor.run_id}`);
    const reserved = callMetadata(request, attemptKey, "reserved");
    await appendEvent(tx, anchor, {
      mutationType: "ccc-planning:call:reserved", subject: attemptKey, agentId: CONTROLLER_AGENT, timestamp: now, metadata: reserved,
    });
    await appendEvent(tx, anchor, {
      mutationType: "ccc-planning:call:dispatched", subject: attemptKey, agentId: CONTROLLER_AGENT, timestamp: now,
      metadata: { ...reserved, outcome: "dispatched" },
    });
    return {
      kind: "dispatch-permit",
      scope: scopeFor(anchor, {
        binding, turnKey: request.turnKey, dispatchKey: request.dispatchKey, attemptKey, fence: fence3,
        attemptOrdinal: turnCalls.length + 1, requestCount: Number(charged[0]!.spent), state: "dispatched_unknown",
      }),
    };
  });
}

async function loadCallForSettlement(tx: DbTransaction, layer: AsyncDataLayer, scope: Readonly<{
  binding: CccPlanningRouteBinding; attemptKey: string; controllerToken: string; taskId: string; turnKey: string;
  dispatchKey: string }>): Promise<{ anchor: AnchorRow; call: CallRecord; now: string }> {
  if (!scope.binding || scope.binding.kind !== "ccc-planning-route.v1"
    || scope.binding.bindingHash !== cccPlanningBindingHash(scope.binding)) {
    invalid("settlement binding is not a sealed ccc-planning-route.v1 binding");
  }
  const located = await locateRun(tx, layer, scope.binding.runId);
  const anchor = await lockAnchor(tx, located.project_id, located.run_id);
  const history = await readCallHistory(tx, anchor);
  const call = history.calls.get(scope.attemptKey);
  if (!call) throw new CccProviderAttemptStateError(`CCC planning attempt ${scope.attemptKey} was never reserved`);
  if (call.bindingHash !== scope.binding.bindingHash || call.turnKey !== scope.turnKey || call.dispatchKey !== scope.dispatchKey
    || scope.taskId !== anchor.planning_task_id || scope.controllerToken !== controllerTokenFor(anchor.project_id, scope.attemptKey)) {
    throw new CccProviderAttemptCollisionError(`CCC planning settlement identity differs from reserved attempt ${scope.attemptKey}`);
  }
  return { anchor, call, now: await databaseNow(tx) };
}

function observedRoute(raw: unknown): Row | null {
  if (!raw || typeof raw !== "object") return null;
  const route = raw as { effectiveProvider?: unknown; effectiveModel?: unknown };
  return typeof route.effectiveProvider === "string" && typeof route.effectiveModel === "string"
    ? { provider: route.effectiveProvider, model: route.effectiveModel }
    : null;
}

export async function proveCccPlanningCallNotDispatched(layer: AsyncDataLayer, scope: CccPlanningCallScope, evidenceDigest: string):
  Promise<CccPlanningCallScope> {
  if (typeof evidenceDigest !== "string" || evidenceDigest.length === 0) invalid("evidenceDigest is required");
  return inTransaction(layer, async (tx) => {
    const { anchor, call, now } = await loadCallForSettlement(tx, layer, scope);
    await appendEvent(tx, anchor, {
      mutationType: "ccc-planning:call:terminal", subject: call.attemptKey, agentId: CONTROLLER_AGENT, timestamp: now,
      metadata: { ...call.reserved, outcome: "proved_not_dispatched", evidenceDigest },
    });
    return { ...scope, state: "proved_failed", terminal: { kind: "not-dispatched", state: "proved_failed" } };
  });
}

/*
FNXC:CccPlanningLedger 2026-10-14-14:05:
D10 and verify-v2 item 42: a planning settlement is idempotent on the same content (the deterministic terminal event
replays) and settles exactly once otherwise (a different terminal throws RunAuditEventCollisionError). A route refusal
keeps the spend and, in the same transaction, moves the run from its phase state (running, or building for G7/G8) to
blocked_provider / CCC_PROVIDER_PIN_DRIFT, so no further call can be reserved. A provider error event is a
failed_known_effect and leaves the run where it is, so a retry inside the caps stays possible.
*/
export async function settleCccPlanningCall(layer: AsyncDataLayer,
  settlement: CccProviderAttemptSettlementInputOf<CccPlanningCallScope>): Promise<CccPlanningCallScope> {
  const binding = settlement.binding;
  if (typeof settlement.evidenceDigest !== "string" || settlement.evidenceDigest.length === 0) invalid("evidenceDigest is required");
  if (typeof settlement.observerId !== "string" || settlement.observerId.length === 0) invalid("observerId is required");
  let outcome: "committed" | "refused_known_effect" | "failed_known_effect";
  let effectiveRoute: CccProviderAttemptEffectiveRoute | undefined;
  if (settlement.outcome === "committed") {
    if (settlement.refusalReason !== undefined) invalid("a committed settlement carries no refusalReason");
    effectiveRoute = assertCccProviderAttemptEffectiveRoute(settlement.effectiveRoute,
      { providerId: binding.providerId, modelId: binding.modelId }, { receiptAdapterId: binding.receiptAdapterId });
    outcome = "committed";
  } else if (settlement.outcome === "proved_failed") {
    if (settlement.refusalReason === undefined) invalid("a planning proved_failed settlement requires a refusalReason");
    outcome = ROUTE_REFUSALS.has(settlement.refusalReason) ? "refused_known_effect" : "failed_known_effect";
  } else {
    invalid(`outcome ${String(settlement.outcome)} is not committed or proved_failed`);
  }
  return inTransaction(layer, async (tx) => {
    const { anchor, call, now } = await loadCallForSettlement(tx, layer, settlement);
    const metadata: Row = {
      ...call.reserved, outcome, evidenceDigest: settlement.evidenceDigest,
      ...(effectiveRoute ? { effectiveRoute } : {}),
      ...(outcome === "committed" ? {} : {
        refusal: {
          reason: settlement.refusalReason!, requested: { provider: binding.providerId, model: binding.modelId },
          observed: observedRoute(settlement.effectiveRoute),
        },
      }),
    };
    const replay = call.terminal !== null;
    await appendEvent(tx, anchor, {
      mutationType: "ccc-planning:call:terminal", subject: call.attemptKey, agentId: CONTROLLER_AGENT, timestamp: now, metadata,
    });
    const phaseState: CccPlanningRunState = call.phase === "review_proof" ? "building" : "running";
    if (!replay && outcome === "refused_known_effect" && anchor.state === phaseState) {
      await moveRun(tx, anchor, { to: "blocked_provider", stateCode: "CCC_PROVIDER_PIN_DRIFT", now, agentId: CONTROLLER_AGENT });
    }
    const state = outcome === "committed" ? "committed" as const : "proved_failed" as const;
    return {
      attemptKey: settlement.attemptKey, controllerToken: settlement.controllerToken, taskId: settlement.taskId,
      semanticTaskId: settlement.semanticTaskId, campaignDeadlineAt: settlement.campaignDeadlineAt,
      turnKey: settlement.turnKey, dispatchKey: settlement.dispatchKey, attemptOrdinal: settlement.attemptOrdinal,
      requestCount: settlement.requestCount, workItemFence: settlement.workItemFence, binding, state,
      terminal: {
        kind: "reconciled", state, evidenceDigest: settlement.evidenceDigest, observerId: settlement.observerId,
        ...(effectiveRoute ? { effectiveRoute } : {}),
      },
    };
  });
}

// ---------------------------------------------------------------- lineages, repair chunks and review epochs (D13, D31)

function requireLineageId(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    refuse("CCC_PLANNING_INTERNAL_ERROR", `${label} must be a lineage id of 1 to 256 characters`, label);
  }
  return value;
}

export async function recordCccPlanningLineageSplit(layer: AsyncDataLayer, i: Readonly<{
  runId: string; parentLineageId: string; childLineageIds: readonly string[]; fence: CccPlanningWorkItemFence }>): Promise<void> {
  const parent = requireLineageId(i.parentLineageId, "parentLineageId");
  const children = Array.isArray(i.childLineageIds) ? i.childLineageIds.map((child) => requireLineageId(child, "childLineageIds")) : [];
  if (children.length === 0 || new Set(children).size !== children.length || children.includes(parent)) {
    refuse("CCC_PLANNING_INTERNAL_ERROR", "a split needs distinct child lineages other than the parent", "childLineageIds");
  }
  await inTransaction(layer, async (tx) => {
    const located = await locateRun(tx, layer, i.runId);
    await lockFence(tx, located, i.fence, "either");
    const anchor = await lockAnchor(tx, located.project_id, located.run_id);
    const now = await databaseNow(tx);
    const history = await readCallHistory(tx, anchor);
    const inherited = dispatchAttempts(history, parent);
    for (const child of children) {
      await appendEvent(tx, anchor, {
        mutationType: "ccc-planning:lineage:created", subject: child, agentId: CONTROLLER_AGENT, timestamp: now,
        metadata: { schema: "ccc-planning-lineage/v1", runId: anchor.run_id, lineageId: child, kind: "split",
          parentLineageId: parent, inheritedDispatchAttempts: inherited },
      });
    }
  });
}

type RepairLineage = Readonly<{ roleId: CccPlanningRoleId; lineageId: string; kind: "author-repair" | "review-node";
  parentLineageId: string; inheritedDispatchAttempts: number }>;

function requireRoles(roles: unknown, label: string): CccPlanningRoleId[] {
  if (!Array.isArray(roles) || new Set(roles).size !== roles.length) {
    refuse("CCC_PLANNING_INTERNAL_ERROR", `${label} must be a list of distinct roles`, label);
  }
  for (const roleId of roles) {
    try {
      cccPlanningRole(roleId as CccPlanningRoleId);
    } catch {
      refuse("CCC_PLANNING_ROUTE_NOT_ADMITTED", `unknown role ${JSON.stringify(roleId)} in ${label}`, label);
    }
  }
  return roles as CccPlanningRoleId[];
}

/** The author's latest lineage: its newest repair lineage, else its original `${stageId}:${roleId}` (D13). */
function latestAuthorLineage(history: History, roleId: CccPlanningRoleId): string {
  let latest: { lineageId: string; chunk: number } | null = null;
  for (const lineage of history.lineages.values()) {
    if (lineage.kind === "author-repair" && lineage.roleId === roleId) {
      const chunk = Number(lineage.chunkOrdinal);
      if (latest === null || chunk > latest.chunk) latest = { lineageId: lineage.lineageId, chunk };
    }
  }
  return latest?.lineageId ?? `${cccPlanningRole(roleId).stageId}:${roleId}`;
}

/*
FNXC:CccPlanningLedger 2026-10-14-14:05:
D13 (leader ruling, the caps compose) with errata E2-9/E3-2: repair authors must be author-class (every class but
critic) and re-reviewers reviewer-class (critic), else ROUTE_NOT_ADMITTED / role-class-mismatch. Each author repairs in
`repair:k:<role>` and inherits its latest lineage's count, so an author with no attempt left refuses the whole chunk
(DISPATCH_CAP); each re-reviewer gets a fresh review node `<stage>:<role>:rv<k>` with 0 inherited. The one epoch of 4
chunks bounds repairs globally whatever the per-lineage counters say. Every refusal writes nothing.
*/
export async function claimCccPlanningRepairChunk(layer: AsyncDataLayer, i: Readonly<{
  runId: string; source: "planning-rejection" | "coding-rejection"; candidateDigest: string;
  repairAuthors: readonly CccPlanningRoleId[]; reReviewers: readonly CccPlanningRoleId[]; fence: CccPlanningWorkItemFence }>):
  Promise<Readonly<{ chunkOrdinal: 1 | 2 | 3 | 4; lineages: readonly RepairLineage[] }>> {
  const authors = requireRoles(i.repairAuthors, "repairAuthors");
  const reviewers = requireRoles(i.reReviewers, "reReviewers");
  for (const roleId of authors) {
    if (cccPlanningRole(roleId).roleClass === "critic") {
      refuse("CCC_PLANNING_ROUTE_NOT_ADMITTED", `role-class-mismatch: repair author ${roleId} is a critic`, "repairAuthors");
    }
  }
  for (const roleId of reviewers) {
    if (cccPlanningRole(roleId).roleClass !== "critic") {
      refuse("CCC_PLANNING_ROUTE_NOT_ADMITTED", `role-class-mismatch: re-reviewer ${roleId} is not a critic`, "reReviewers");
    }
  }
  if (i.source !== "planning-rejection" && i.source !== "coding-rejection") {
    refuse("CCC_PLANNING_INTERNAL_ERROR", `unknown repair source ${String(i.source)}`, "source");
  }
  if (typeof i.candidateDigest !== "string" || !DIGEST_PATTERN.test(i.candidateDigest)) {
    refuse("CCC_PLANNING_INTERNAL_ERROR", "candidateDigest must be a lowercase sha256", "candidateDigest");
  }
  return inTransaction(layer, async (tx) => {
    const located = await locateRun(tx, layer, i.runId);
    await lockFence(tx, located, i.fence, "either");
    const anchor = await lockAnchor(tx, located.project_id, located.run_id);
    const now = await databaseNow(tx);

    const latestChunk = (await rows<{ metadata: Row }>(tx, sql`
      SELECT metadata FROM project.run_audit_events
       WHERE project_id = ${anchor.project_id} AND run_id = ${anchor.run_id} AND mutation_type = 'ccc-planning:repair-chunk'
         AND target = ${`repair:${anchor.repair_chunks_used}`}
    `))[0]?.metadata;
    if (latestChunk && latestChunk.source === i.source && latestChunk.candidateDigest === i.candidateDigest
      && JSON.stringify(latestChunk.repairAuthors) === JSON.stringify(authors)
      && JSON.stringify(latestChunk.reReviewers) === JSON.stringify(reviewers)) {
      return { chunkOrdinal: Number(latestChunk.chunkOrdinal) as 1 | 2 | 3 | 4, lineages: latestChunk.lineages as RepairLineage[] };
    }
    if (anchor.repair_chunks_used >= CCC_PLANNING_MAX_REPAIR_CHUNKS) {
      refuse("CCC_PLANNING_REPAIR_EXHAUSTED", `run ${anchor.run_id} has used ${CCC_PLANNING_MAX_REPAIR_CHUNKS} repair chunks`);
    }
    if (anchor.repair_epoch_state === "closed") refuse("CCC_PLANNING_REPAIR_EPOCH_CLOSED", `run ${anchor.run_id} repair epoch is closed`);

    const chunkOrdinal = (anchor.repair_chunks_used + 1) as 1 | 2 | 3 | 4;
    const history = await readCallHistory(tx, anchor);
    const lineages: RepairLineage[] = [];
    for (const roleId of authors) {
      const parentLineageId = latestAuthorLineage(history, roleId);
      const inherited = dispatchAttempts(history, parentLineageId);
      if (inherited >= CCC_PLANNING_MAX_DISPATCH_ATTEMPTS_PER_LINEAGE) {
        refuse("CCC_PLANNING_DISPATCH_CAP", `repair author ${roleId} has no dispatch attempt left in ${parentLineageId}`, "repairAuthors");
      }
      lineages.push({ roleId, lineageId: `repair:${chunkOrdinal}:${roleId}`, kind: "author-repair", parentLineageId,
        inheritedDispatchAttempts: inherited });
    }
    for (const roleId of reviewers) {
      const parentLineageId = `${cccPlanningRole(roleId).stageId}:${roleId}`;
      lineages.push({ roleId, lineageId: `${parentLineageId}:rv${chunkOrdinal}`, kind: "review-node", parentLineageId,
        inheritedDispatchAttempts: 0 });
    }
    const planning = i.source === "planning-rejection";
    const remaining = planning ? anchor.planning_allocation - anchor.planning_spent : anchor.review_proof_allocation - anchor.review_proof_spent;
    if (!assessCccRepairChunkFit({ phase: planning ? "planning" : "review_proof", repairNodes: lineages.length, remaining })) {
      refuse(planning ? "CCC_PLANNING_PLANNING_FIT_INSUFFICIENT" : "CCC_PLANNING_BUILD_FIT_INSUFFICIENT",
        `repair chunk of ${lineages.length} nodes does not fit ${remaining} remaining calls`);
    }

    await tx.execute(sql`
      UPDATE project.ccc_planning_runs
         SET repair_epoch_state = 'open', repair_chunks_used = ${chunkOrdinal},
             updated_at = ${nextUpdatedAt(anchor.updated_at, now)}
       WHERE project_id = ${anchor.project_id} AND run_id = ${anchor.run_id} AND repair_chunks_used = ${chunkOrdinal - 1}
    `);
    await appendEvent(tx, anchor, {
      mutationType: "ccc-planning:repair-chunk", subject: `repair:${chunkOrdinal}`, agentId: CONTROLLER_AGENT, timestamp: now,
      metadata: { schema: "ccc-planning-repair/v1", runId: anchor.run_id, chunkOrdinal, source: i.source,
        candidateDigest: i.candidateDigest, repairAuthors: authors, reReviewers: reviewers, lineages },
    });
    for (const lineage of lineages) {
      await appendEvent(tx, anchor, {
        mutationType: "ccc-planning:lineage:created", subject: lineage.lineageId, agentId: CONTROLLER_AGENT, timestamp: now,
        metadata: {
          schema: "ccc-planning-lineage/v1", runId: anchor.run_id, lineageId: lineage.lineageId, kind: lineage.kind,
          roleId: lineage.roleId, parentLineageId: lineage.parentLineageId, chunkOrdinal,
          inheritedDispatchAttempts: lineage.inheritedDispatchAttempts,
          ...(lineage.kind === "review-node" ? { candidateDigest: i.candidateDigest } : {}),
        },
      });
    }
    return { chunkOrdinal, lineages };
  });
}

export async function closeCccPlanningRepairEpoch(layer: AsyncDataLayer, i: Readonly<{ runId: string; fence: CccPlanningWorkItemFence }>):
  Promise<void> {
  await inTransaction(layer, async (tx) => {
    const located = await locateRun(tx, layer, i.runId);
    await lockFence(tx, located, i.fence, "either");
    const anchor = await lockAnchor(tx, located.project_id, located.run_id);
    if (anchor.repair_epoch_state === "closed") return;
    const now = await databaseNow(tx);
    await tx.execute(sql`
      UPDATE project.ccc_planning_runs SET repair_epoch_state = 'closed', updated_at = ${nextUpdatedAt(anchor.updated_at, now)}
       WHERE project_id = ${anchor.project_id} AND run_id = ${anchor.run_id}
    `);
    await appendEvent(tx, anchor, {
      mutationType: "ccc-planning:repair-epoch-closed", subject: "repair-epoch", agentId: CONTROLLER_AGENT, timestamp: now,
      metadata: { schema: "ccc-planning-repair-epoch/v1", runId: anchor.run_id, repairChunksUsed: anchor.repair_chunks_used },
    });
  });
}

/** Improved iff blockingFindings < the previous epoch's; the first epoch is the baseline; stop at 2 stagnant epochs (D31, D41). */
export async function recordCccPlanningReviewEpoch(layer: AsyncDataLayer, i: Readonly<{
  runId: string; fence: CccPlanningWorkItemFence; epochDigest: string; blockingFindings: number }>):
  Promise<Readonly<{ reviewEpochs: number; stagnantEpochs: number; stop: boolean }>> {
  if (typeof i.epochDigest !== "string" || !DIGEST_PATTERN.test(i.epochDigest)) {
    refuse("CCC_PLANNING_INTERNAL_ERROR", "epochDigest must be a lowercase sha256", "epochDigest");
  }
  if (!Number.isSafeInteger(i.blockingFindings) || i.blockingFindings < 0) {
    refuse("CCC_PLANNING_INTERNAL_ERROR", "blockingFindings must be a non-negative integer", "blockingFindings");
  }
  return inTransaction(layer, async (tx) => {
    const located = await locateRun(tx, layer, i.runId);
    await lockFence(tx, located, i.fence, "either");
    const anchor = await lockAnchor(tx, located.project_id, located.run_id);
    const previous = anchor.review_epochs === 0 ? undefined : (await rows<{ metadata: Row }>(tx, sql`
      SELECT metadata FROM project.run_audit_events
       WHERE project_id = ${anchor.project_id} AND run_id = ${anchor.run_id} AND mutation_type = 'ccc-planning:review-epoch'
         AND target = ${`epoch:${anchor.review_epochs}`}
    `))[0]?.metadata;
    const result = (reviewEpochs: number, stagnantEpochs: number) =>
      ({ reviewEpochs, stagnantEpochs, stop: stagnantEpochs >= CCC_PLANNING_STAGNATION_EPOCHS });
    if (previous && previous.epochDigest === i.epochDigest) {
      if (Number(previous.blockingFindings) !== i.blockingFindings) {
        throw new RunAuditEventCollisionError(cccPlanningEventId({ projectId: anchor.project_id, runId: anchor.run_id,
          mutationType: "ccc-planning:review-epoch", subject: `epoch:${anchor.review_epochs}` }));
      }
      return result(anchor.review_epochs, anchor.stagnant_epochs);
    }
    if (anchor.stagnant_epochs >= CCC_PLANNING_STAGNATION_EPOCHS) {
      refuse("CCC_PLANNING_REVIEW_STAGNATED", `run ${anchor.run_id} stopped after ${anchor.stagnant_epochs} stagnant epochs`);
    }
    const epoch = anchor.review_epochs + 1;
    const improved = previous === undefined || i.blockingFindings < Number(previous.blockingFindings);
    const stagnant = improved ? 0 : anchor.stagnant_epochs + 1;
    const now = await databaseNow(tx);
    await tx.execute(sql`
      UPDATE project.ccc_planning_runs
         SET review_epochs = ${epoch}, stagnant_epochs = ${stagnant}, updated_at = ${nextUpdatedAt(anchor.updated_at, now)}
       WHERE project_id = ${anchor.project_id} AND run_id = ${anchor.run_id}
    `);
    await appendEvent(tx, anchor, {
      mutationType: "ccc-planning:review-epoch", subject: `epoch:${epoch}`, agentId: CONTROLLER_AGENT, timestamp: now,
      metadata: { schema: "ccc-planning-review-epoch/v1", runId: anchor.run_id, epoch, epochDigest: i.epochDigest,
        blockingFindings: i.blockingFindings, improved, stagnantEpochs: stagnant },
    });
    return result(epoch, stagnant);
  });
}

// ---------------------------------------------------------------- research fetch grants (D28, section 2.9)

type FetchRecord = { grantKey: string; nodeId: string; nodeAttempt: number; maxRawBytes: number; reserved: Row; settled: Row | null };

async function readFetches(tx: DbTransaction, anchor: AnchorRow): Promise<Map<string, FetchRecord>> {
  const events = await rows<{ mutation_type: string; target: string; metadata: Row }>(tx, sql`
    SELECT mutation_type, target, metadata FROM project.run_audit_events
     WHERE project_id = ${anchor.project_id} AND run_id = ${anchor.run_id}
       AND mutation_type IN ('ccc-planning:fetch:reserved', 'ccc-planning:fetch:settled')
  `);
  const fetches = new Map<string, FetchRecord>();
  for (const event of events) {
    if (event.mutation_type !== "ccc-planning:fetch:reserved") continue;
    fetches.set(event.target, {
      grantKey: event.target, nodeId: String(event.metadata.nodeId), nodeAttempt: Number(event.metadata.nodeAttempt),
      maxRawBytes: Number(event.metadata.maxRawBytes), reserved: event.metadata, settled: null,
    });
  }
  for (const event of events) {
    const fetch = fetches.get(event.target);
    if (fetch && event.mutation_type === "ccc-planning:fetch:settled") fetch.settled = event.metadata;
  }
  return fetches;
}

export async function reserveCccPlanningResearchFetch(layer: AsyncDataLayer, i: Readonly<{
  runId: string; nodeId: string; nodeAttempt: number; maxRawBytes: number; fence: CccPlanningWorkItemFence }>):
  Promise<Readonly<{ grantKey: string }>> {
  const policy = CCC_PLANNING_SOURCE_POLICY_I2;
  if (typeof i.nodeId !== "string" || i.nodeId.length === 0 || i.nodeId.length > 256
    || !Number.isSafeInteger(i.nodeAttempt) || i.nodeAttempt < 1
    || !Number.isSafeInteger(i.maxRawBytes) || i.maxRawBytes < 1 || i.maxRawBytes > policy.maxRawBytesPerFetch) {
    refuse("CCC_PLANNING_INTERNAL_ERROR", "fetch needs a node id, a node attempt >= 1 and 1..1 MiB of raw bytes");
  }
  return inTransaction(layer, async (tx) => {
    const located = await locateRun(tx, layer, i.runId);
    await lockFence(tx, located, i.fence, "planning");
    const anchor = await lockAnchor(tx, located.project_id, located.run_id);
    const now = await databaseNow(tx);
    if (anchor.control_request !== null) refuse("CCC_PLANNING_CONTROL_PENDING", `run ${anchor.run_id} has a pending ${anchor.control_request}`);
    if (anchor.state !== "running") refuse("CCC_PLANNING_RESEARCH_GRANT_EXHAUSTED", `run ${anchor.run_id} is ${anchor.state}, not running`);
    if (Date.parse(now) + CCC_PLANNING_LAUNCH_HEADROOM_MS >= Date.parse(anchor.deadline_at)) {
      refuse("CCC_PLANNING_DEADLINE", `run ${anchor.run_id} deadline is within the launch headroom`);
    }
    const fetches = [...(await readFetches(tx, anchor)).values()];
    const open = fetches.find((fetch) => fetch.settled === null);
    if (open) refuse("CCC_PLANNING_RESEARCH_GRANT_EXHAUSTED", `fetch ${open.grantKey} is unsettled`);
    if (anchor.research_fetch_spent >= anchor.research_fetch_allocation) {
      refuse("CCC_PLANNING_RESEARCH_GRANT_EXHAUSTED", `fetch allocation ${anchor.research_fetch_allocation} is spent`);
    }
    if (fetches.filter((fetch) => fetch.nodeId === i.nodeId && fetch.nodeAttempt === i.nodeAttempt).length >= policy.maxFetchesPerNode) {
      refuse("CCC_PLANNING_RESEARCH_GRANT_EXHAUSTED", `node ${i.nodeId} attempt ${i.nodeAttempt} used ${policy.maxFetchesPerNode} fetches`);
    }
    if (anchor.research_bytes_spent + policy.maxRawBytesPerFetch > anchor.research_bytes_allocation) {
      refuse("CCC_PLANNING_RESEARCH_GRANT_EXHAUSTED", "remaining research bytes do not cover one more fetch");
    }
    const grantKey = `${anchor.run_id}:f${anchor.research_fetch_spent + 1}`;
    await tx.execute(sql`
      UPDATE project.ccc_planning_runs
         SET research_fetch_spent = research_fetch_spent + 1, updated_at = ${nextUpdatedAt(anchor.updated_at, now)}
       WHERE project_id = ${anchor.project_id} AND run_id = ${anchor.run_id}
         AND research_fetch_spent = ${anchor.research_fetch_spent}
    `);
    await appendEvent(tx, anchor, {
      mutationType: "ccc-planning:fetch:reserved", subject: grantKey, agentId: CONTROLLER_AGENT, timestamp: now,
      metadata: { schema: "ccc-planning-fetch/v1", runId: anchor.run_id, grantKey, nodeId: i.nodeId, nodeAttempt: i.nodeAttempt,
        maxRawBytes: i.maxRawBytes, fence: fenceSummary(i.fence) },
    });
    return { grantKey };
  });
}

export async function settleCccPlanningResearchFetch(layer: AsyncDataLayer, i: Readonly<{
  grantKey: string; rawBytes: number; outcome: "fetched" | "refused" | "failed" }>): Promise<void> {
  const match = typeof i.grantKey === "string" ? GRANT_KEY_PATTERN.exec(i.grantKey) : null;
  if (!match) refuse("CCC_PLANNING_INTERNAL_ERROR", `grant key ${JSON.stringify(i.grantKey)} is not <runId>:f<N>`, "grantKey");
  if (i.outcome !== "fetched" && i.outcome !== "refused" && i.outcome !== "failed") {
    refuse("CCC_PLANNING_INTERNAL_ERROR", `fetch outcome ${String(i.outcome)} is unknown`, "outcome");
  }
  await inTransaction(layer, async (tx) => {
    const located = await locateRun(tx, layer, match[1]!);
    const anchor = await lockAnchor(tx, located.project_id, located.run_id);
    const fetch = (await readFetches(tx, anchor)).get(i.grantKey);
    if (!fetch) refuse("CCC_PLANNING_INTERNAL_ERROR", `grant ${i.grantKey} was never reserved`, "grantKey");
    if (!Number.isSafeInteger(i.rawBytes) || i.rawBytes < 0 || i.rawBytes > fetch.maxRawBytes) {
      refuse("CCC_PLANNING_INTERNAL_ERROR", `rawBytes must be 0..${fetch.maxRawBytes}`, "rawBytes");
    }
    const now = await databaseNow(tx);
    const replay = fetch.settled !== null;
    await appendEvent(tx, anchor, {
      mutationType: "ccc-planning:fetch:settled", subject: i.grantKey, agentId: CONTROLLER_AGENT, timestamp: now,
      metadata: { schema: "ccc-planning-fetch/v1", runId: anchor.run_id, grantKey: i.grantKey, nodeId: fetch.nodeId,
        nodeAttempt: fetch.nodeAttempt, rawBytes: i.rawBytes, outcome: i.outcome },
    });
    if (!replay && i.rawBytes > 0 && !TERMINAL_STATES.has(anchor.state)) {
      await tx.execute(sql`
        UPDATE project.ccc_planning_runs
           SET research_bytes_spent = research_bytes_spent + ${i.rawBytes}, updated_at = ${nextUpdatedAt(anchor.updated_at, now)}
         WHERE project_id = ${anchor.project_id} AND run_id = ${anchor.run_id}
      `);
    }
  });
}

// ---------------------------------------------------------------- operator control (D32, D45, D52)

function operatorAgent(actor: string): string {
  return `operator:${actor}`;
}

/** Held planning work items go back to runnable with a fresh fence attempt, so any stale holder's fence is refused. */
async function requeueHeld(tx: DbTransaction, anchor: AnchorRow, items: readonly PlanningItem[], now: string): Promise<void> {
  for (const item of items) {
    if (item.state !== "held") continue;
    await tx.execute(sql`
      UPDATE project.workflow_work_items
         SET state = 'runnable', attempt = attempt + 1, lease_owner = NULL, lease_expires_at = NULL, retry_after = NULL,
             blocked_reason = NULL, last_error = NULL, updated_at = ${now}
       WHERE project_id = ${anchor.project_id} AND id = ${item.id} AND state = 'held'
    `);
  }
}

/** D45: cancelling with no live lease holder ends the open planning work items and the run in one transaction. */
async function completeCancellationWithin(tx: DbTransaction, anchor: AnchorRow, items: readonly PlanningItem[], now: string,
  agentId: string): Promise<{ completed: boolean; anchor: AnchorRow }> {
  if (anchor.state === "cancelled") return { completed: true, anchor };
  if (anchor.state !== "cancelling") return { completed: false, anchor };
  const live = items.some((item) => item.state === "running" && item.lease_expires_at !== null
    && Date.parse(item.lease_expires_at) > Date.parse(now));
  if (live) return { completed: false, anchor };
  for (const item of items) {
    if (WORK_ITEM_TERMINAL.has(item.state)) continue;   // the import-stage item has already succeeded: left unchanged
    await tx.execute(sql`
      UPDATE project.workflow_work_items
         SET state = 'cancelled', lease_owner = NULL, lease_expires_at = NULL, retry_after = NULL,
             last_error = 'CCC_PLANNING_CANCELLED', updated_at = ${now}
       WHERE project_id = ${anchor.project_id} AND id = ${item.id} AND state = ${item.state}
    `);
  }
  const ended = await moveRun(tx, anchor, { to: "cancelled", stateCode: "CCC_PLANNING_CANCELLED", now, agentId });
  return { completed: true, anchor: ended };
}

type ControlPlan =
  | Readonly<{ kind: "pending" }>
  | Readonly<{ kind: "resume" }>
  | Readonly<{ kind: "cancel" }>;

function planControl(anchor: AnchorRow, request: "pause" | "cancel" | "resume"): ControlPlan {
  const state = anchor.state;
  const refused = (detail: string): never => refuse("CCC_PLANNING_STATE_TRANSITION_REFUSED", `${request} in ${state}: ${detail}`, "request");
  switch (state) {
    case "importing":
      if (request !== "cancel") refuse("CCC_PLANNING_COMMAND_NOT_SUPPORTED", `${request} is not supported while importing`, "request");
      if (anchor.import_intent_digest !== null) refused("the import intent is already recorded");
      return { kind: "cancel" };
    case "admitted":
    case "running":
    case "spec_ready": {
      if (request === "resume") refused("the run is not paused or blocked");
      if (state === "spec_ready" && anchor.mode === "spec" && request === "pause") refused("a Spec run rests at spec_ready");
      if (request === "cancel" && state !== "running") return { kind: "cancel" };
      if (anchor.control_request === "cancel" || (anchor.control_request !== null && request === "pause")) {
        refuse("CCC_PLANNING_CONTROL_PENDING", `run ${anchor.run_id} already has a pending ${anchor.control_request}`, "request");
      }
      return { kind: "pending" };
    }
    case "paused":
    case "blocked_prerequisite":
    case "blocked_provider":
    case "unknown_effect":
      if (request === "pause") refused("the run is already resting");
      return request === "resume" ? { kind: "resume" } : { kind: "cancel" };
    case "awaiting_intent":
    case "awaiting_budget":
    case "budget_exhausted":
      if (request !== "cancel") refused("only cancel applies; answer or amend the budget instead");
      return { kind: "cancel" };
    case "cancelling":
      if (request === "cancel") refuse("CCC_PLANNING_CONTROL_PENDING", "cancellation is already in progress", "request");
      return refused("the run is cancelling");
    default:
      return refused("no planning control applies");
  }
}

/*
FNXC:CccPlanningControl 2026-10-14-14:05:
D32 before the import link: a running (or admitted / Build spec_ready) run records the request on the anchor for H1 to
apply at its next safe point; paused, awaiting and blocked runs apply it directly in the same transaction, including the
planning work item (resume requeues it, cancel cancels it when no live holder exists, D45). After the link the only
route is the campaign bridge. Every accepted control bumps control_seq and is attributed to `operator:<actor>` (D52).
*/
export async function requestCccPlanningControl(layer: AsyncDataLayer, i: Readonly<{
  runId: string; request: "pause" | "cancel" | "resume"; actor: string }>): Promise<Readonly<{ controlSeq: number; appliedDirectly: boolean }>> {
  const actor = requireActor(i.actor);
  const request = requireControlRequest(i.request);
  return inTransaction(layer, async (tx) => {
    const located = await locateRun(tx, layer, i.runId);
    if (located.import_id !== null) {
      refuse("CCC_PLANNING_CONTROL_REQUIRES_CAMPAIGN_BRIDGE", `run ${located.run_id} is linked to import ${located.import_id}`);
    }
    if (TERMINAL_STATES.has(located.state)) refuse("CCC_PLANNING_RUN_TERMINAL", `run ${located.run_id} is ${located.state}`);
    const items = await lockPlanningItems(tx, located);
    const anchor = await lockAnchor(tx, located.project_id, located.run_id);
    if (anchor.import_id !== null) refuse("CCC_PLANNING_CONTROL_REQUIRES_CAMPAIGN_BRIDGE", `run ${anchor.run_id} is linked`);
    if (TERMINAL_STATES.has(anchor.state)) refuse("CCC_PLANNING_RUN_TERMINAL", `run ${anchor.run_id} is ${anchor.state}`);
    const plan = planControl(anchor, request);
    const now = await databaseNow(tx);
    const agentId = operatorAgent(actor);
    const controlSeq = anchor.control_seq + 1;
    let outcome: "applied" | "pending" | "deferred-leased";
    let finalState = anchor.state;
    if (plan.kind === "pending") {
      await tx.execute(sql`
        UPDATE project.ccc_planning_runs
           SET control_seq = ${controlSeq}, control_request = ${request}, control_revision = revision,
               control_requested_at = ${now}, updated_at = ${nextUpdatedAt(anchor.updated_at, now)}
         WHERE project_id = ${anchor.project_id} AND run_id = ${anchor.run_id} AND control_seq = ${anchor.control_seq}
      `);
      outcome = "pending";
    } else if (plan.kind === "resume") {
      const resumed = await moveRun(tx, anchor, {
        to: cccPlanningResumeTarget({ importId: null }), stateCode: null, now, agentId, bumpControlSeq: true,
      });
      await requeueHeld(tx, resumed, items, now);
      finalState = resumed.state;
      outcome = "applied";
    } else {
      const cancelling = await moveRun(tx, anchor, { to: "cancelling", stateCode: null, now, agentId, bumpControlSeq: true });
      const completion = await completeCancellationWithin(tx, cancelling, items, now, agentId);
      finalState = completion.anchor.state;
      outcome = completion.completed ? "applied" : "deferred-leased";
    }
    await appendEvent(tx, anchor, {
      mutationType: "ccc-planning:control", subject: `control:${controlSeq}`, agentId, timestamp: now,
      metadata: { schema: "ccc-planning-control/v1", runId: anchor.run_id, controlSeq, request, actor, route: "planning",
        outcome, fromState: anchor.state, toState: finalState },
    });
    return { controlSeq, appliedDirectly: plan.kind !== "pending" };
  });
}

/*
FNXC:CccPlanningControl 2026-10-14-14:05:
D32 and D52: answering the awaited decision is one transaction. control_seq moves first, so the operator_answer artifact
publishes under the operator fence {runRevision, controlSeq} that trigger 0043 checks against the anchor; the run goes
back to running and the held planning work item to runnable. The artifact is published locally under the publisher GUC
(card A1's publisher is a parallel W2 card), and the actor is recorded in the answer content and the audit agentId,
because the frozen producer type has no actor field.
*/
export async function answerCccPlanningDecision(layer: AsyncDataLayer, i: Readonly<{
  runId: string; decisionId: string; answer: string; actor: string }>): Promise<Readonly<{ controlSeq: number; answerArtifactKey: string }>> {
  const actor = requireActor(i.actor);
  if (typeof i.answer !== "string" || i.answer.length === 0) refuse("CCC_PLANNING_INTERNAL_ERROR", "answer must be a non-empty string", "answer");
  if (typeof i.decisionId !== "string" || i.decisionId.length === 0) {
    refuse("CCC_PLANNING_DECISION_NOT_AWAITED", "decision id is required", "decisionId");
  }
  return inTransaction(layer, async (tx) => {
    const located = await locateRun(tx, layer, i.runId);
    if (TERMINAL_STATES.has(located.state)) refuse("CCC_PLANNING_RUN_TERMINAL", `run ${located.run_id} is ${located.state}`);
    const items = await lockPlanningItems(tx, located);
    const anchor = await lockAnchor(tx, located.project_id, located.run_id);
    if (anchor.state !== "awaiting_intent" || anchor.awaiting_decision_id !== i.decisionId) {
      refuse("CCC_PLANNING_DECISION_NOT_AWAITED", `run ${anchor.run_id} does not await decision ${i.decisionId}`, "decisionId");
    }
    const now = await databaseNow(tx);
    const agentId = operatorAgent(actor);
    const question = (await readQuestions(tx, anchor)).find((candidate) => candidate.decisionId === i.decisionId);
    const running = await moveRun(tx, anchor, { to: "running", stateCode: null, now, agentId, bumpControlSeq: true });
    const controlSeq = running.control_seq;

    const slot = `answer${controlSeq}`;
    const key = encodeCccPlanningArtifactKey({ runRevision: anchor.revision, stageId: "operator", slot, version: 1 });
    const contentSchema = "ccc-planning.operator-answer.v1";
    const encoded = encodeCccPlanningArtifactContent({
      type: "json", value: { schema: contentSchema, decisionId: i.decisionId, actor, answer: i.answer },
    });
    const identity = {
      schema: CCC_PLANNING_ARTIFACT_ENVELOPE_SCHEMA, artifactKey: key, runId: anchor.run_id, runRevision: anchor.revision,
      stageId: "operator" as const, slot, version: 1, kind: "operator_answer" as const, contentType: encoded.contentType,
      contentSchema, inputs: question ? [{ artifactKey: question.key, digest: question.digest }] : [],
      producer: { kind: "operator" as const, roleId: "operator" as const, instanceId: `operator:${controlSeq}` },
      policy: { promptVersion: "none", promptDigest: "none", toolPolicyVersion: "none", toolPolicyDigest: "none" },
      outputDigest: encoded.outputDigest, status: "complete" as const,
    };
    const envelope = {
      ...identity, fence: { kind: "operator", runRevision: anchor.revision, controlSeq },
      identityDigest: computeCccPlanningEnvelopeIdentityDigest(identity), publishedAt: now,
    };
    await tx.execute(sql`SELECT set_config('fusion.ccc_planning_publication', 'on', true)`);
    await tx.execute(sql`
      INSERT INTO project.task_documents (project_id, id, task_id, key, content, revision, author, metadata, created_at, updated_at)
      VALUES (${anchor.project_id}, ${randomUUID()}, ${anchor.planning_task_id}, ${key}, ${encoded.text}, 1,
              'ccc-planning:operator', ${JSON.stringify(envelope)}::jsonb, ${now}, ${now})
    `);
    await tx.execute(sql`SELECT set_config('fusion.ccc_planning_publication', 'off', true)`);
    await requeueHeld(tx, running, items, now);

    await appendEvent(tx, anchor, {
      mutationType: "ccc-planning:artifact-published", subject: key, agentId, timestamp: now,
      metadata: { schema: "ccc-planning-artifact/v1", runId: anchor.run_id, artifactKey: key, kind: "operator_answer",
        stageId: "operator", outputDigest: encoded.outputDigest },
    });
    await appendEvent(tx, anchor, {
      mutationType: "ccc-planning:decision:answered", subject: i.decisionId, agentId, timestamp: now,
      metadata: { schema: "ccc-planning-decision/v1", runId: anchor.run_id, decisionId: i.decisionId, controlSeq, actor,
        answerArtifactKey: key },
    });
    return { controlSeq, answerArtifactKey: key };
  });
}

/*
FNXC:CccPlanningControl 2026-10-14-14:05:
D32 after the link, verify-v2 item 36 and errata E2-3/E3-1: pause and resume in importing or building are an I4 must-do
and write nothing (COMMAND_NOT_SUPPORTED). Cancel stores control_request = 'cancel' in every linked non-terminal state
that has an allowed ->cancelling pair, which stops review spend (trigger) and linked writer reservations (BF) at once;
a state without that pair refuses with STATE_TRANSITION_REFUSED. Other requests are recorded for the campaign bridge.
*/
export async function recordCccPlanningBuildControl(layer: AsyncDataLayer, i: Readonly<{
  runId: string; request: "pause" | "cancel" | "resume"; actor: string }>): Promise<Readonly<{ controlSeq: number }>> {
  const actor = requireActor(i.actor);
  const request = requireControlRequest(i.request);
  return inTransaction(layer, async (tx) => {
    const located = await locateRun(tx, layer, i.runId);
    if (located.import_id === null) {
      refuse("CCC_PLANNING_INTERNAL_ERROR", `run ${located.run_id} is not linked; use planning control`, "runId");
    }
    if (TERMINAL_STATES.has(located.state)) refuse("CCC_PLANNING_RUN_TERMINAL", `run ${located.run_id} is ${located.state}`);
    const anchor = await lockAnchor(tx, located.project_id, located.run_id);
    if (TERMINAL_STATES.has(anchor.state)) refuse("CCC_PLANNING_RUN_TERMINAL", `run ${anchor.run_id} is ${anchor.state}`);
    if (request !== "cancel" && (anchor.state === "importing" || anchor.state === "building")) {
      refuse("CCC_PLANNING_COMMAND_NOT_SUPPORTED", `${request} is not supported while ${anchor.state}`, "request");
    }
    if (request === "cancel") {
      if (anchor.state === "cancelling" || !cccPlanningTransitionAllowed(anchor.state, "cancelling")) {
        refuse("CCC_PLANNING_STATE_TRANSITION_REFUSED", `cancel in ${anchor.state} has no ->cancelling transition`, "request");
      }
      if (anchor.control_request === "cancel") {
        refuse("CCC_PLANNING_CONTROL_PENDING", `run ${anchor.run_id} already has a pending cancel`, "request");
      }
    }
    const now = await databaseNow(tx);
    const controlSeq = anchor.control_seq + 1;
    const assignments: SQL[] = [
      sql`control_seq = ${controlSeq}`,
      sql`updated_at = ${nextUpdatedAt(anchor.updated_at, now)}`,
      ...(request === "cancel"
        ? [sql`control_request = 'cancel'`, sql`control_revision = revision`, sql`control_requested_at = ${now}`]
        : []),
    ];
    await tx.execute(sql`
      UPDATE project.ccc_planning_runs SET ${sql.join(assignments, sql`, `)}
       WHERE project_id = ${anchor.project_id} AND run_id = ${anchor.run_id} AND control_seq = ${anchor.control_seq}
    `);
    await appendEvent(tx, anchor, {
      mutationType: "ccc-planning:control", subject: `control:${controlSeq}`, agentId: operatorAgent(actor), timestamp: now,
      metadata: { schema: "ccc-planning-control/v1", runId: anchor.run_id, controlSeq, request, actor, route: "campaign-bridge",
        outcome: "pending", fromState: anchor.state, toState: anchor.state },
    });
    return { controlSeq };
  });
}

export async function completeCccPlanningCancellation(layer: AsyncDataLayer, i: Readonly<{ runId: string; now?: string }>):
  Promise<Readonly<{ completed: boolean }>> {
  if (i.now !== undefined && !Number.isFinite(Date.parse(i.now))) refuse("CCC_PLANNING_INTERNAL_ERROR", "now must be an ISO timestamp", "now");
  return inTransaction(layer, async (tx) => {
    const located = await locateRun(tx, layer, i.runId);
    if (located.state === "cancelled") return { completed: true };
    if (located.state !== "cancelling") return { completed: false };
    const items = await lockPlanningItems(tx, located);
    const anchor = await lockAnchor(tx, located.project_id, located.run_id);
    const now = i.now ?? await databaseNow(tx);
    const completion = await completeCancellationWithin(tx, anchor, items, now, CONTROLLER_AGENT);
    return { completed: completion.completed };
  });
}

/*
FNXC:CccPlanningLedger 2026-10-14-14:05:
The generic CAS transition used by H1 and the stage host. Moving to awaiting_intent derives awaiting_decision_id from the
newest decision_request artifact of the current revision, because the frozen signature carries no decision id and the
anchor CHECK requires one; with no such artifact the move is refused and nothing is written.
*/
export async function transitionCccPlanningRunState(layer: AsyncDataLayer, i: Readonly<{
  runId: string; from: CccPlanningRunState; to: CccPlanningRunState; stateCode: string | null;
  fence: CccPlanningWorkItemFence | null }>): Promise<CccPlanningRunCustody> {
  if (!RUN_STATES.has(i.from) || !RUN_STATES.has(i.to)) refuse("CCC_PLANNING_INTERNAL_ERROR", "from and to must be run states", "state");
  if (i.stateCode !== null && (typeof i.stateCode !== "string" || !STATE_CODE_PATTERN.test(i.stateCode))) {
    refuse("CCC_PLANNING_INTERNAL_ERROR", "stateCode must match CCC_[A-Z0-9_]{1,120}", "stateCode");
  }
  if (i.from === i.to || !cccPlanningTransitionAllowed(i.from, i.to)) {
    refuse("CCC_PLANNING_STATE_TRANSITION_REFUSED", `${i.from} -> ${i.to} is not an allowed transition`, "state");
  }
  return inTransaction(layer, async (tx) => {
    const located = await locateRun(tx, layer, i.runId);
    if (i.fence !== null) await lockFence(tx, located, i.fence, "either");
    const anchor = await lockAnchor(tx, located.project_id, located.run_id);
    if (TERMINAL_STATES.has(anchor.state)) refuse("CCC_PLANNING_RUN_TERMINAL", `run ${anchor.run_id} is ${anchor.state}`);
    if (anchor.state !== i.from) {
      refuse("CCC_PLANNING_STATE_TRANSITION_REFUSED", `run ${anchor.run_id} is ${anchor.state}, not ${i.from}`, "from");
    }
    let decisionId: string | undefined;
    if (i.to === "awaiting_intent") {
      const newest = (await rows<{ digest: string }>(tx, sql`
        SELECT metadata->>'outputDigest' AS digest FROM project.task_documents
         WHERE project_id = ${anchor.project_id} AND task_id = ${anchor.planning_task_id}
           AND key LIKE ${`cccplan-r${pad3(anchor.revision)}-%`} AND metadata->>'kind' = 'decision_request'
         ORDER BY created_at DESC, key DESC LIMIT 1
      `))[0];
      if (!newest || !DIGEST_PATTERN.test(newest.digest)) {
        refuse("CCC_PLANNING_STATE_TRANSITION_REFUSED", "awaiting_intent requires a published decision_request", "to");
      }
      decisionId = cccPlanningDecisionId({ revision: anchor.revision, questionDigest: newest.digest });
    }
    const now = await databaseNow(tx);
    const moved = await moveRun(tx, anchor, {
      to: i.to, stateCode: i.stateCode, now, agentId: CONTROLLER_AGENT, ...(decisionId ? { decisionId } : {}),
    });
    return custodyOf(moved);
  });
}

export async function assertCccPlanningDescendantsSettled(layer: AsyncDataLayer, runId: string): Promise<void> {
  await inTransaction(layer, async (tx) => {
    const anchor = await locateRun(tx, layer, runId);
    const open = [...(await readCallHistory(tx, anchor)).calls.values()].filter((call) => call.terminal === null);
    if (open.length > 0) {
      refuse("CCC_PLANNING_DESCENDANTS_UNSETTLED", `${open.length} call(s) unsettled, first ${open[0]!.attemptKey}`);
    }
    const fetch = [...(await readFetches(tx, anchor)).values()].find((candidate) => candidate.settled === null);
    if (fetch) refuse("CCC_PLANNING_DESCENDANTS_UNSETTLED", `research fetch ${fetch.grantKey} unsettled`);
  });
}

/** Structural controller (K1's provider-controller view), so core never imports engine. */
export function createCccPlanningAttemptController(i: Readonly<{ layer: AsyncDataLayer; binding: CccPlanningRouteBinding;
  turnKey: string; fence: CccPlanningWorkItemFence; preflight: boolean }>): CccProviderAttemptControllerView<CccPlanningCallScope> {
  return {
    preDispatch: async (input) => {
      if (input.providerId !== i.binding.providerId || input.modelId !== i.binding.modelId || input.transport !== i.binding.transport
        || input.turnKey !== i.turnKey) {
        throw new CccProviderAttemptIdentityError("route-drift", "CCC planning dispatch route differs from the session binding");
      }
      return admitCccPlanningDispatch(i.layer, {
        binding: i.binding, turnKey: input.turnKey, dispatchKey: input.dispatchKey, fence: i.fence, preflight: i.preflight,
      });
    },
    reconcile: async (settlement) => settleCccPlanningCall(i.layer, settlement),
  };
}
