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
import { createHash } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import {
  recordRunAuditEventWithinTransaction,
  RunAuditEventCollisionError,
  type AsyncDataLayer,
  type DbTransaction,
} from "../postgres/data-layer.js";
import { CccPlanningRefusal, cccPlanningRefusalFromDatabaseError, type CccPlanningRefusalCode } from "../ccc-planning/errors.js";
import {
  CCC_PLANNING_AUDIT_STRING_MAX,
  CCC_PLANNING_LAUNCH_HEADROOM_MS,
  CCC_PLANNING_MAX_CALLS_PER_ATTEMPT,
  CCC_PLANNING_MAX_DISPATCH_ATTEMPTS_PER_LINEAGE,
  CCC_PLANNING_MAX_REPAIR_CHUNKS,
  CCC_PLANNING_PREFLIGHT_LINEAGES,
  CCC_PLANNING_PREFLIGHT_MAX_CALLS_PER_ATTEMPT,
  CCC_PLANNING_ROLE_POLICY_FULL_V2,
  CCC_PLANNING_SOURCE_POLICY_I2,
  CCC_PLANNING_STAGNATION_EPOCHS,
  cccPlanningAttemptKey,
  cccPlanningBindingHash,
  cccPlanningDecisionId,
  cccPlanningEventId,
  cccPlanningRole,
  cccPlanningTurnKey,
} from "../ccc-planning/policy.js";
import { assessCccRepairChunkFit, cccPlanningMaxNodes, countCccPlanningNodes } from "../ccc-planning/budget-fit.js";
import { publishCccPlanningArtifactWithinTransaction } from "./ccc-planning-artifact-ops.js";
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
/** The 4-member CccProviderAttemptRefusalReason union (errata E5-L1 item 6): anything else fails closed. */
const REFUSAL_REASONS: ReadonlySet<string> = new Set([...ROUTE_REFUSALS, "provider-error-event"]);
/**
 * FNXC:CccPlanningLedger 2026-10-14-18:47:
 * Free-text observation strings a committed settlement copies into its terminal event, such as `cost.reason` (errata
 * E7-L item 5). Id-like strings use K1's CCC_PLANNING_AUDIT_STRING_MAX (256) instead (E7-L item 6: one constant).
 */
const AUDIT_FREE_TEXT_MAX = 1024;
/** A G7 lineage names its PRD semantic task id, an entity id of the import admission grammar (ccc-prd/import-admission.ts). */
const SEMANTIC_TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u;
const AUTHOR_REPAIR_LINEAGE_PATTERN = /^repair:([1-9][0-9]{0,8}):(.+)$/u;
const REVIEW_NODE_LINEAGE_PATTERN = /^(.+):rv([1-9][0-9]{0,8})$/u;
const LEAF_LINEAGE_PATTERN = /^research:leaf-([1-9][0-9]{0,8})$/u;

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

/** A within-transaction form has no layer, so its caller names the project; a blank one is a caller bug. */
function requireProjectId(projectId: unknown): void {
  if (typeof projectId !== "string" || projectId.trim().length === 0) {
    refuse("CCC_PLANNING_INTERNAL_ERROR", "projectId must be a non-blank string", "projectId");
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

type PlanningItem = { id: string; state: string; attempt: number; lease_expires_at: string | null; live: boolean };

/**
 * The run's planning work items (run_id = runId on the planning task), locked before the anchor.
 * FNXC:CccPlanningControl 2026-10-14-17:37:
 * Errata E5-L1 item 7: `live` (a running item whose lease has not expired) is judged by the database clock at lock
 * time, the same predicate as the lease fence, never by a caller-supplied `now`, which only stamps the writes.
 */
async function lockPlanningItems(tx: DbTransaction, anchor: AnchorRow): Promise<PlanningItem[]> {
  return rows<PlanningItem>(tx, sql`
    SELECT id, state, attempt, lease_expires_at,
           (state = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at::timestamptz > clock_timestamp()) AS live
      FROM project.workflow_work_items
     WHERE project_id = ${anchor.project_id} AND run_id = ${anchor.run_id} AND task_id = ${anchor.planning_task_id}
     ORDER BY id FOR UPDATE
  `);
}

/** `idSubject` (default `subject`) is what the deterministic event id is derived from, when it must say more than the target. */
async function appendEvent(tx: DbTransaction, anchor: AnchorRow, i: Readonly<{
  mutationType: CccPlanningAuditMutationType; subject: string; agentId: string; timestamp: string; metadata: Row;
  idSubject?: string }>): Promise<void> {
  await recordRunAuditEventWithinTransaction(tx, {
    timestamp: i.timestamp, taskId: anchor.planning_task_id, agentId: i.agentId, runId: anchor.run_id, domain: "database",
    mutationType: i.mutationType, target: i.subject, metadata: i.metadata,
    eventId: cccPlanningEventId({ projectId: anchor.project_id, runId: anchor.run_id, mutationType: i.mutationType,
      subject: i.idSubject ?? i.subject }),
  }, anchor.project_id);
}

/**
 * FNXC:CccPlanningControl 2026-10-14-18:47:
 * Errata E7-L item 2: which targets a pending control lets a run move to. Cancelling and cancelled always pass; paused
 * passes only a pending pause (the request H1 applies). A pending cancel is never erased by a move to paused: a caller
 * that read the pause before the operator's cancel replaced it is refused CONTROL_PENDING and the cancel stays.
 */
function pendingControlAllows(controlRequest: string | null, to: CccPlanningRunState): boolean {
  return controlRequest === null || to === "cancelling" || to === "cancelled" || (to === "paused" && controlRequest === "pause");
}

/**
 * CAS state move plus its state event. Leaving a pending control behind is impossible for paused/cancelling/cancelled.
 * FNXC:CccPlanningControl 2026-10-14-17:37:
 * Errata E5-L1 item 5 (ADV-11, ADV-12): with `respectControl` the UPDATE itself carries the pending-control predicate,
 * so a control that is pending when the row is written blocks every target except paused, cancelling and cancelled,
 * whatever the caller read before; the refusal is CONTROL_PENDING and nothing is written.
 * FNXC:CccPlanningControl 2026-10-14-18:47:
 * Errata E7-L item 2 narrows paused to a pending pause (`pendingControlAllows`), in the predicate and in the re-read
 * that classifies a refused UPDATE.
 */
async function moveRun(tx: DbTransaction, anchor: AnchorRow, i: Readonly<{ to: CccPlanningRunState; stateCode: string | null;
  now: string; agentId: string; bumpControlSeq?: boolean; decisionId?: string; respectControl?: boolean }>): Promise<AnchorRow> {
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
  const controlPredicate = i.respectControl
    ? sql`AND (control_request IS NULL OR ${i.to}::text IN ('cancelling', 'cancelled')
           OR (${i.to}::text = 'paused' AND control_request = 'pause'))`
    : sql``;
  const updated = await rows(tx, sql`
    UPDATE project.ccc_planning_runs SET ${sql.join(assignments, sql`, `)}
     WHERE project_id = ${anchor.project_id} AND run_id = ${anchor.run_id} AND state = ${from} ${controlPredicate}
    RETURNING ${ANCHOR_COLUMNS}
  `);
  if (updated.length !== 1) {
    const current = i.respectControl ? (await rows<{ state: string; control_request: string | null }>(tx, sql`
      SELECT state, control_request FROM project.ccc_planning_runs WHERE project_id = ${anchor.project_id} AND run_id = ${anchor.run_id}
    `))[0] : undefined;
    if (current && current.state === from && !pendingControlAllows(current.control_request, i.to)) {
      refuse("CCC_PLANNING_CONTROL_PENDING", `run ${anchor.run_id} has a pending ${current.control_request}; ${from} -> ${i.to} waits`,
        "state");
    }
    refuse("CCC_PLANNING_STATE_TRANSITION_REFUSED", `run ${anchor.run_id} changed concurrently`, "state");
  }
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

// ---------------------------------------------------------------- lineage admission (errata E5-L1 items 3 and 4)

type LineageOwner = Readonly<{ roleId: CccPlanningRoleId; stageId: string }>;

/** A repair lineage or a review node: these exist only once a `lineage:created` event records them (D13). */
function isClaimedLineageForm(lineageId: string): boolean {
  return lineageId.startsWith("repair:") || REVIEW_NODE_LINEAGE_PATTERN.test(lineageId);
}

/**
 * The leaf cap: the largest L whose planning node count (14 + L + 1, K1 `countCccPlanningNodes`) fits the allocation's
 * node ceiling (K1 `cccPlanningMaxNodes`). K1 exports no leaf-cap constant, so it is derived from those two functions.
 */
function cccPlanningLeafCap(planningAllocation: number): number {
  return Math.max(0, cccPlanningMaxNodes(planningAllocation) - countCccPlanningNodes({ leaves: 1 }) + 1);
}

/** The fixed lineages of CONTRACT section 2.1 that spell this id, each with the one role and stage it admits. */
function fixedLineageOwners(lineageId: string, leafCap: number): LineageOwner[] {
  if (isClaimedLineageForm(lineageId)) return [];
  const owners: LineageOwner[] = [];
  for (const entry of CCC_PLANNING_PREFLIGHT_LINEAGES) {
    if (entry.lineageId === lineageId) owners.push({ roleId: entry.roleId, stageId: cccPlanningRole(entry.roleId).stageId });
  }
  for (const spec of CCC_PLANNING_ROLE_POLICY_FULL_V2.roles) {
    if ((spec.counting === "fixed" || spec.counting === "once-if-leaves") && lineageId === `${spec.stageId}:${spec.roleId}`) {
      owners.push({ roleId: spec.roleId, stageId: spec.stageId });
    }
  }
  const leaf = LEAF_LINEAGE_PATTERN.exec(lineageId);
  if (leaf && Number(leaf[1]) <= leafCap) owners.push({ roleId: "extraction-leaf", stageId: "research" });
  if (lineageId.startsWith("review:") && SEMANTIC_TASK_ID_PATTERN.test(lineageId.slice("review:".length))) {
    owners.push({ roleId: "task-reviewer", stageId: "g7" });
  }
  if (lineageId === "judge:final") owners.push({ roleId: "final-judge", stageId: "g8" });
  return owners;
}

/** The role and stage a `lineage:created` record admits, or null when the record is not one this module writes. */
function recordedLineageOwner(record: LineageRecord): LineageOwner | null {
  if (typeof record.roleId !== "string") return null;
  const roleId = record.roleId as CccPlanningRoleId;
  let role;
  try {
    role = cccPlanningRole(roleId);
  } catch {
    return null;
  }
  const lineageId = record.lineageId;
  if (record.kind === "author-repair") {
    const match = AUTHOR_REPAIR_LINEAGE_PATTERN.exec(lineageId);
    return match && match[2] === roleId && Number(match[1]) <= CCC_PLANNING_MAX_REPAIR_CHUNKS ? { roleId, stageId: "repair" } : null;
  }
  if (record.kind === "review-node") {
    const match = REVIEW_NODE_LINEAGE_PATTERN.exec(lineageId);
    return match && match[1] === `${role.stageId}:${roleId}` && Number(match[2]) <= CCC_PLANNING_MAX_REPAIR_CHUNKS
      ? { roleId, stageId: role.stageId } : null;
  }
  if (record.kind === "split" && typeof record.stageId === "string" && !isClaimedLineageForm(lineageId)) {
    return { roleId, stageId: record.stageId };
  }
  return null;
}

/*
FNXC:CccPlanningLedger 2026-10-14-17:37:
Errata E5-L1 item 3 (ADV-1). A lineage takes a call only when it is the fixed lineage of the binding's role and stage
(`${stage}:${role}`, `research:leaf-N` up to the leaf cap, `research:leaf-reviewer`, the preflight ids,
`review:<semanticTaskId>` for G7, `judge:final` for G8), or when a `lineage:created` event of this run records it for the
same role: `repair:k:<role>` at stage repair and `<stage>:<role>:rv<k>` at the role's stage, both with k at most
CCC_PLANNING_MAX_REPAIR_CHUNKS, or a split child at its parent's role and stage. A repair or review-node id is never
fixed. Anything else is ROUTE_NOT_ADMITTED and nothing is written.
FNXC:CccPlanningLedger 2026-10-14-18:47:
Errata E7-L item 8b. Dispatch counters (`dispatchAttempts`) and the unreconciled-dispatch block are keyed by lineage id
alone: the history is one fold over every call of the run, whatever fence admitted it. So a campaign-fence lineage (a
review_proof call: G7 `review:<semanticTaskId>`, G8 `judge:final`) whose id is also a planning fixed lineage, for
example a semantic task named `product-adversary`, would share that planning critic's counter and block. It is refused
ROUTE_NOT_ADMITTED before any write; AD1 refuses such a semantic task id at admission (E7-0).
*/
function requireLineageAdmitted(history: History, anchor: AnchorRow, binding: CccPlanningRouteBinding): void {
  const matches = (owner: LineageOwner | null) => owner !== null && owner.roleId === binding.roleId && owner.stageId === binding.stageId;
  const fixedOwners = fixedLineageOwners(binding.lineageId, cccPlanningLeafCap(anchor.planning_allocation));
  if (binding.phase !== "planning" && fixedOwners.some((owner) => cccPlanningRole(owner.roleId).phase !== "review_proof")) {
    refuse("CCC_PLANNING_ROUTE_NOT_ADMITTED", `lineage-not-admitted: ${binding.lineageId} is a planning fixed lineage, and a `
      + `${binding.phase} lineage under a campaign fence may not share its dispatch counter`, "lineageId");
  }
  if (fixedOwners.some(matches)) return;
  const record = history.lineages.get(binding.lineageId);
  if (record && matches(recordedLineageOwner(record))) return;
  refuse("CCC_PLANNING_ROUTE_NOT_ADMITTED", `lineage-not-admitted: ${binding.lineageId} is neither the fixed lineage of `
    + `${binding.roleId} at stage ${binding.stageId} nor recorded for that role by a lineage:created event`, "lineageId");
}

/** The repair chunk a lineage belongs to: its claim's chunk, a split child's parent's, 0 for a fixed lineage. */
function lineageChunk(history: History, lineageId: string): number {
  const seen = new Set<string>();
  let current = history.lineages.get(lineageId);
  while (current && !seen.has(current.lineageId)) {
    seen.add(current.lineageId);
    if (current.kind === "author-repair" || current.kind === "review-node") return Number(current.chunkOrdinal) || 0;
    if (current.kind !== "split") return 0;
    current = history.lineages.get(String(current.parentLineageId));
  }
  return 0;
}

/** The newest repair chunk that claimed a lineage (author repair or review node) for this role, 0 when none has. */
function newestClaimChunk(history: History, roleId: string): number {
  let newest = 0;
  for (const record of history.lineages.values()) {
    if ((record.kind === "author-repair" || record.kind === "review-node") && record.roleId === roleId) {
      newest = Math.max(newest, Number(record.chunkOrdinal) || 0);
    }
  }
  return newest;
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
    // Errata E7-L item 4: only control requests (subject `control:<seq>`), never a `cancel-deferred:` row, are a lastControl.
    const controls = await rows<{ metadata: Row; timestamp: string }>(tx, sql`
      SELECT metadata, timestamp FROM project.run_audit_events
       WHERE project_id = ${anchor.project_id} AND run_id = ${anchor.run_id} AND mutation_type = 'ccc-planning:control'
         AND target LIKE 'control:%'
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
        outcome: lastControlEvent.metadata.outcome as "applied" | "pending",   // E5-L1 item 12: no deferred-leased
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

/*
FNXC:CccPlanningLedger 2026-10-14-17:37:
Errata E5-L1 item 10. Every value an audit event copies is bounded before any write: id strings 1 to 256 characters,
digests 64 lowercase hex. A caller passing anything else is an internal caller bug, refused with INTERNAL_ERROR and the
offending field, so an unbounded or malformed value never reaches run_audit_events.
*/
function requireAuditId(value: unknown, field: string): void {
  if (typeof value !== "string" || value.length < 1 || value.length > CCC_PLANNING_AUDIT_STRING_MAX) {
    refuse("CCC_PLANNING_INTERNAL_ERROR", `${field} must be a string of 1 to ${CCC_PLANNING_AUDIT_STRING_MAX} characters`, field);
  }
}

function requireAuditFreeText(value: unknown, field: string): void {
  if (typeof value !== "string" || value.length > AUDIT_FREE_TEXT_MAX) {
    refuse("CCC_PLANNING_INTERNAL_ERROR", `${field} must be a string of at most ${AUDIT_FREE_TEXT_MAX} characters`, field);
  }
}

/*
FNXC:CccPlanningLedger 2026-10-14-18:47:
Errata E7-L item 5 (ADV1-E). A committed settlement copies its parsed effective route into the call:terminal event, and
the shared route parser bounds no string length, so every string of that route is bounded before the transaction:
the id-like fields (effective provider, model, reasoning effort and service tier, cost.source and the OmniRoute
provider and model observations) at CCC_PLANNING_AUDIT_STRING_MAX, the free-text cost.reason at 1024 characters.
A violation is an internal caller bug: INTERNAL_ERROR naming the field, and nothing is written.
*/
function requireCommittedRouteBounds(route: CccProviderAttemptEffectiveRoute): void {
  requireAuditId(route.effectiveProvider, "effectiveRoute.effectiveProvider");
  requireAuditId(route.effectiveModel, "effectiveRoute.effectiveModel");
  if (route.effectiveReasoningEffort !== undefined) {
    requireAuditId(route.effectiveReasoningEffort, "effectiveRoute.effectiveReasoningEffort");
  }
  if (route.effectiveServiceTier !== undefined) requireAuditId(route.effectiveServiceTier, "effectiveRoute.effectiveServiceTier");
  if ("source" in route.cost) requireAuditId(route.cost.source, "effectiveRoute.cost.source");
  else requireAuditFreeText(route.cost.reason, "effectiveRoute.cost.reason");
  for (const [label, observation] of [["initial", route.omniRoute?.initial], ["final", route.omniRoute?.final]] as const) {
    if (observation === undefined) continue;
    requireAuditId(observation.provider, `effectiveRoute.omniRoute.${label}.provider`);
    requireAuditId(observation.model, `effectiveRoute.omniRoute.${label}.model`);
  }
}

function requireAuditDigest(value: unknown, field: string): void {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    refuse("CCC_PLANNING_INTERNAL_ERROR", `${field} must be 64 lowercase hex characters`, field);
  }
}

function requireCallAuditBounds(request: CccPlanningCallRequest): void {
  const binding = request.binding;
  for (const field of ["projectId", "runId", "taskId", "stageId", "roleId", "lineageId", "providerId", "modelId",
    "receiptAdapterId"] as const) {
    requireAuditId(binding[field], `binding.${field}`);
  }
  for (const field of ["toolsetDigest", "promptDigest", "policyDigest", "grantDigest", "bindingHash"] as const) {
    requireAuditDigest(binding[field], `binding.${field}`);
  }
  const fence = request.fence as Partial<Record<string, unknown>> | null | undefined;
  if (fence && typeof fence === "object") {
    for (const field of ["workItemId", "leaseOwner", "originTaskId", "runId"]) {
      const value = fence[field];
      if (typeof value === "string" && value.length > CCC_PLANNING_AUDIT_STRING_MAX) requireAuditId(value, `fence.${field}`);
    }
  }
}

/** Structural checks that need no database: binding hash, derived turn key, 1-based dispatch key, role class and phase. */
function requireCallRequest(request: CccPlanningCallRequest): number {
  const binding = request?.binding;
  if (!binding || binding.kind !== "ccc-planning-route.v1") invalid("binding kind must be ccc-planning-route.v1");
  requireCallAuditBounds(request);
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

    requireLineageAdmitted(history, anchor, binding);
    /*
    FNXC:CccPlanningLedger 2026-10-14-17:37:
    Errata E5-L1 item 4 (ADV-9): once a repair chunk has claimed a lineage for this role, every earlier lineage of the
    role (its fixed lineage, an older repair or review node, and their split children) takes no new turn key; the work
    continues in the claimed lineage.
    FNXC:CccPlanningLedger 2026-10-14-18:47:
    Errata E7-L item 7 (ADV1-C) replaces the E5 allowance for a continuing turn: a superseded lineage takes no new call
    at all, the next call of a turn that started before the claim included, so no effect lands in a lineage after its
    repair lineage has started. A call already dispatched is not a new reservation: its replay above holds and its
    settlement commits as before.
    */
    if (newestClaimChunk(history, binding.roleId) > lineageChunk(history, binding.lineageId)) {
      refuse("CCC_PLANNING_ROUTE_NOT_ADMITTED", `lineage-superseded: ${binding.lineageId} is older than repair chunk `
        + `${newestClaimChunk(history, binding.roleId)}'s lineage for ${binding.roleId}`, "lineageId");
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

/** Errata E5-L1 item 10: the observed route a refusal copies into its terminal event is bounded like any audit id. */
function requireObservedRouteBounds(raw: unknown): void {
  if (!raw || typeof raw !== "object") return;
  const route = raw as { effectiveProvider?: unknown; effectiveModel?: unknown };
  for (const field of ["effectiveProvider", "effectiveModel"] as const) {
    if (typeof route[field] === "string") requireAuditId(route[field], `effectiveRoute.${field}`);
  }
}

export async function proveCccPlanningCallNotDispatched(layer: AsyncDataLayer, scope: CccPlanningCallScope, evidenceDigest: string):
  Promise<CccPlanningCallScope> {
  requireAuditDigest(evidenceDigest, "evidenceDigest");
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
FNXC:CccPlanningLedger 2026-10-14-17:37:
Errata E5-L1 items 6 and 10 (ADV-2). The refusal reason must be one of the four members of the union; an unknown value
used to fall through to failed_known_effect, so a misspelt route refusal left the run open. It now fails closed with
INTERNAL_ERROR before the transaction, as do an evidence digest that is not 64 lowercase hex, an observer id or an
observed route string over 256 characters.
*/
export async function settleCccPlanningCall(layer: AsyncDataLayer,
  settlement: CccProviderAttemptSettlementInputOf<CccPlanningCallScope>): Promise<CccPlanningCallScope> {
  const binding = settlement.binding;
  requireAuditDigest(settlement.evidenceDigest, "evidenceDigest");
  requireAuditId(settlement.observerId, "observerId");
  requireObservedRouteBounds(settlement.effectiveRoute);
  let outcome: "committed" | "refused_known_effect" | "failed_known_effect";
  let effectiveRoute: CccProviderAttemptEffectiveRoute | undefined;
  if (settlement.outcome === "committed") {
    if (settlement.refusalReason !== undefined) invalid("a committed settlement carries no refusalReason");
    effectiveRoute = assertCccProviderAttemptEffectiveRoute(settlement.effectiveRoute,
      { providerId: binding.providerId, modelId: binding.modelId }, { receiptAdapterId: binding.receiptAdapterId });
    if (effectiveRoute !== undefined) requireCommittedRouteBounds(effectiveRoute);
    outcome = "committed";
  } else if (settlement.outcome === "proved_failed") {
    if (settlement.refusalReason === undefined) invalid("a planning proved_failed settlement requires a refusalReason");
    if (!REFUSAL_REASONS.has(settlement.refusalReason)) {
      refuse("CCC_PLANNING_INTERNAL_ERROR", `refusalReason ${JSON.stringify(String(settlement.refusalReason).slice(0, 64))} `
        + "is not receipt-missing, receipt-mismatch, effective-route-drift or provider-error-event", "refusalReason");
    }
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
    // FNXC:CccPlanningLedger 2026-10-14-18:47: errata E7-L item 11, recorded and not fixed: this move does not respect
    // a pending pause (no respectControl), so the pause survives into blocked_provider and the operator may have to
    // resume twice.
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

/** FNXC:CccPlanningLedger 2026-10-14-20:52: errata E8-L item 5: one bound for every audit id, K1's constant. */
function requireLineageId(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > CCC_PLANNING_AUDIT_STRING_MAX) {
    refuse("CCC_PLANNING_INTERNAL_ERROR", `${label} must be a lineage id of 1 to ${CCC_PLANNING_AUDIT_STRING_MAX} characters`, label);
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
    const owner = splitParentOwner(history, anchor, parent);
    /*
    FNXC:CccPlanningLedger 2026-10-14-18:47:
    Errata E7-L item 8a: a split child may not take an id that names a fixed lineage of any role (for example child
    `review:technical-critic` of parent `review:product-adversary`), because its split record would hand that role's
    real lineage another role's inherited count. Every `research:leaf-N` form counts as fixed here whatever the run's
    current leaf cap, so a later leaf can never collide with an earlier split child. Recorded and not fixed (item 11):
    splitting a parent that has used no attempt gives each child a fresh 3 attempts (D13 as written).
    */
    for (const child of children) {
      if (isClaimedLineageForm(child)) {
        refuse("CCC_PLANNING_ROUTE_NOT_ADMITTED", `lineage-not-admitted: split child ${child} uses a repair or review-node id`,
          "childLineageIds");
      }
      if (fixedLineageOwners(child, Number.MAX_SAFE_INTEGER).length > 0) {
        refuse("CCC_PLANNING_ROUTE_NOT_ADMITTED", `lineage-not-admitted: split child ${child} is a fixed lineage id`,
          "childLineageIds");
      }
    }
    const inherited = dispatchAttempts(history, parent);
    for (const child of children) {
      await appendEvent(tx, anchor, {
        mutationType: "ccc-planning:lineage:created", subject: child, agentId: CONTROLLER_AGENT, timestamp: now,
        metadata: { schema: "ccc-planning-lineage/v1", runId: anchor.run_id, lineageId: child, kind: "split",
          roleId: owner.roleId, stageId: owner.stageId, parentLineageId: parent, inheritedDispatchAttempts: inherited },
      });
    }
  });
}

/*
FNXC:CccPlanningLedger 2026-10-14-17:37:
Errata E5-L1 item 3 admits a split child only for its parent's role, so the split event now records the role and stage
it inherits. The parent is a recorded lineage (its record's owner), or a fixed lineage; a fixed id that two roles could
own (`review:<id>` is also G7's form) is settled by the calls the parent already made. A parent that resolves to no
single role and stage is ROUTE_NOT_ADMITTED, and nothing is written.
*/
function splitParentOwner(history: History, anchor: AnchorRow, parent: string): LineageOwner {
  const record = history.lineages.get(parent);
  let owners: LineageOwner[] = record ? [recordedLineageOwner(record)].filter((owner): owner is LineageOwner => owner !== null)
    : fixedLineageOwners(parent, cccPlanningLeafCap(anchor.planning_allocation));
  if (owners.length > 1) {
    const called = [...history.calls.values()].filter((call) => call.lineageId === parent);
    owners = owners.filter((owner) => called.some((call) => call.reserved.roleId === owner.roleId && call.reserved.stageId === owner.stageId));
  }
  if (owners.length !== 1) {
    refuse("CCC_PLANNING_ROUTE_NOT_ADMITTED", `lineage-not-admitted: split parent ${parent} does not resolve to one admitted role`,
      "parentLineageId");
  }
  return owners[0]!;
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
    /*
    FNXC:CccPlanningLedger 2026-10-14-17:37:
    Errata E5-L1 item 4 (ADV-8): a claim supersedes every earlier lineage of its roles (admission refuses them new turn
    keys), so it waits until none of them has a reserved or dispatched_unknown call; otherwise that call's effect could
    land after the repair lineage started. Refused with UNRECONCILED_DISPATCH, naming the role; nothing is written.
    FNXC:CccPlanningLedger 2026-10-14-18:47:
    Errata E7-L item 11, recorded and not fixed: supersession is decided per role, so H1, BF and ST2 must never name
    task-reviewer as a coding-rejection re-reviewer (it would supersede every review:<semanticTaskId> lineage at once).
    */
    for (const [label, roles] of [["repairAuthors", authors], ["reReviewers", reviewers]] as const) {
      for (const roleId of roles) {
        const open = [...history.calls.values()].find((call) => call.terminal === null && call.reserved.roleId === roleId);
        if (open) {
          refuse("CCC_PLANNING_UNRECONCILED_DISPATCH",
            `role ${roleId} has unsettled call ${open.attemptKey} in lineage ${open.lineageId}`, label);
        }
      }
    }
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
    const epochs = (await rows<{ metadata: Row }>(tx, sql`
      SELECT metadata FROM project.run_audit_events
       WHERE project_id = ${anchor.project_id} AND run_id = ${anchor.run_id} AND mutation_type = 'ccc-planning:review-epoch'
    `)).map((row) => row.metadata);
    const previous = anchor.review_epochs === 0 ? undefined
      : epochs.find((metadata) => Number(metadata.epoch) === anchor.review_epochs);
    const result = (reviewEpochs: number, stagnantEpochs: number) =>
      ({ reviewEpochs, stagnantEpochs, stop: stagnantEpochs >= CCC_PLANNING_STAGNATION_EPOCHS });
    /*
    FNXC:CccPlanningLedger 2026-10-14-17:37:
    Errata E5-L1 item 9 (ADV-5): a digest equal to ANY earlier epoch of the run is a replay of that epoch, not only the
    latest one, so a late redelivery returns the stored epoch and records no new epoch or stagnation. The input carries
    no stage, so the match is per run. The same digest with other findings is a collision.
    */
    const replayed = epochs.find((metadata) => metadata.epochDigest === i.epochDigest);
    if (replayed) {
      if (Number(replayed.blockingFindings) !== i.blockingFindings) {
        throw new RunAuditEventCollisionError(cccPlanningEventId({ projectId: anchor.project_id, runId: anchor.run_id,
          mutationType: "ccc-planning:review-epoch", subject: `epoch:${Number(replayed.epoch)}` }));
      }
      return result(Number(replayed.epoch), Number(replayed.stagnantEpochs));
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
  if (typeof i.nodeId !== "string" || i.nodeId.length === 0 || i.nodeId.length > CCC_PLANNING_AUDIT_STRING_MAX
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

/*
FNXC:CccPlanningControl 2026-10-14-17:37:
Held planning work items go back to runnable with a fresh fence attempt (attempt + 1). Errata E5-L1 item 13 keeps this
on purpose: the lease fence matches on the attempt, so a stale holder that still carries the old attempt has its fence
refused (FENCE_STALE) instead of writing into the resumed run.
*/
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

type CancellationBlock = Readonly<{ reason: "live-lease" }>
  | Readonly<{ reason: "descendants-unsettled"; code: "CCC_PLANNING_DESCENDANTS_UNSETTLED" }>;

/*
FNXC:CccPlanningControl 2026-10-14-17:37:
D45: cancelling with no live lease holder ends the open planning work items and the run in one transaction. This is
the only path to `cancelled` (errata E5-L1 item 8, ADV-10). Liveness is the database clock's (`live`, item 7), and the
run also stays cancelling while any of its calls is reserved or dispatched_unknown, because that call's effect is still
unknown; the block says why (DESCENDANTS_UNSETTLED for the calls).
*/
async function completeCancellationWithin(tx: DbTransaction, anchor: AnchorRow, items: readonly PlanningItem[], now: string,
  agentId: string): Promise<{ completed: boolean; anchor: AnchorRow; blocked?: CancellationBlock }> {
  if (anchor.state === "cancelled") return { completed: true, anchor };
  if (anchor.state !== "cancelling") return { completed: false, anchor };
  if (items.some((item) => item.live)) return { completed: false, anchor, blocked: { reason: "live-lease" } };
  const unsettled = [...(await readCallHistory(tx, anchor)).calls.values()].some((call) => call.terminal === null);
  if (unsettled) {
    return { completed: false, anchor, blocked: { reason: "descendants-unsettled", code: "CCC_PLANNING_DESCENDANTS_UNSETTLED" } };
  }
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

/*
FNXC:CccPlanningControl 2026-10-14-18:47:
Errata E7-L item 4 (ADV1-D). A deferred completion called directly (or through its within-transaction form) records
why, so the reason the run is still cancelling is never only the stale one the cancel request recorded. One
`ccc-planning:control` row, subject `cancel-deferred:<reason>`, with an event id derived from the run, the current
control_seq and the reason: repeating the same deferral replays that row and writes nothing new, a changed reason
writes one new row. The row is not a control request, so status reads skip it and `lastControl` stays the operator's.
FNXC:CccPlanningControl 2026-10-14-20:52:
Errata E8-L item 3 (ADV2-A): a reason that flips back (live-lease, descendants-unsettled, live-lease) must be recorded
again, or the latest row names a blocker that has already cleared. The event id is now derived from (run id,
control_seq, deferral ordinal), the ordinal being one more than the deferral rows of that control_seq, and a row is
written only when the latest of them (highest `deferralOrdinal`, which the metadata carries because a caller-supplied
`now` can repeat a timestamp) has a different reason, or none exists. Repeating the latest reason writes nothing. The
anchor row is locked first, so two completions of one run count the rows one after the other.
*/
async function recordCancellationDeferral(tx: DbTransaction, anchor: AnchorRow, blocked: CancellationBlock, now: string):
  Promise<void> {
  const prior = (await rows<{ metadata: Row }>(tx, sql`
    SELECT metadata FROM project.run_audit_events
     WHERE project_id = ${anchor.project_id} AND run_id = ${anchor.run_id} AND mutation_type = 'ccc-planning:control'
       AND target LIKE 'cancel-deferred:%'
  `)).map((row) => row.metadata).filter((metadata) => Number(metadata.controlSeq) === anchor.control_seq);
  const latest = prior.reduce<Row | undefined>((best, metadata) =>
    best === undefined || Number(metadata.deferralOrdinal) > Number(best.deferralOrdinal) ? metadata : best, undefined);
  if (latest !== undefined && latest.reason === blocked.reason) return;
  const deferralOrdinal = prior.length + 1;
  await appendEvent(tx, anchor, {
    mutationType: "ccc-planning:control", subject: `cancel-deferred:${blocked.reason}`,
    idSubject: `cancel-deferred@control:${anchor.control_seq}:${deferralOrdinal}`,
    agentId: CONTROLLER_AGENT, timestamp: now,
    metadata: {
      schema: "ccc-planning-cancel-deferred/v1", runId: anchor.run_id, controlSeq: anchor.control_seq, reason: blocked.reason,
      deferralOrdinal, ...("code" in blocked ? { code: blocked.code } : {}),
    },
  });
}

function requireCompletionNow(now: unknown): void {
  if (now !== undefined && (typeof now !== "string" || !Number.isFinite(Date.parse(now)))) {
    refuse("CCC_PLANNING_INTERNAL_ERROR", "now must be an ISO timestamp", "now");
  }
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
      // FNXC:CccPlanningControl 2026-10-14-18:47: errata E7-L item 1: there is no admitted -> paused pair, so a pause
      // recorded here could never be applied, and the pending-control predicate then refused admitted -> running too.
      // It is refused before any write; cancel in admitted stays direct.
      if (state === "admitted" && request === "pause") refused("admitted has no -> paused transition");
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
      // Errata E5-L1 item 13 keeps this: a second cancel while one is in progress is CONTROL_PENDING, not a new control.
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
FNXC:CccPlanningControl 2026-10-14-18:47:
Errata E7-L item 1: in admitted only cancel applies (directly); a pause there is refused, so only running and Build
spec_ready record a pending request.
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
    /*
    FNXC:CccPlanningControl 2026-10-14-17:37:
    Errata E5-L1 item 12: a cancel is `applied` once the run is cancelling; there is no `deferred-leased` outcome. When
    completion has to wait, the control event records why under `cancellation` (item 8).
    */
    let outcome: "applied" | "pending";
    let cancellation: Row | undefined;
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
      outcome = "applied";
      cancellation = completion.completed ? { completed: true } : { completed: false, ...completion.blocked };
    }
    await appendEvent(tx, anchor, {
      mutationType: "ccc-planning:control", subject: `control:${controlSeq}`, agentId, timestamp: now,
      metadata: { schema: "ccc-planning-control/v1", runId: anchor.run_id, controlSeq, request, actor, route: "planning",
        outcome, fromState: anchor.state, toState: finalState, ...(cancellation ? { cancellation } : {}) },
    });
    return { controlSeq, appliedDirectly: plan.kind !== "pending" };
  });
}

/*
FNXC:CccPlanningControl 2026-10-14-14:05:
D32 and D52: answering the awaited decision is one transaction. control_seq moves first, so the operator_answer artifact
publishes under the operator fence {runRevision, controlSeq} that trigger 0043 checks against the anchor; the run goes
back to running and the held planning work item to runnable. The actor is recorded in the answer content and the
decision:answered audit agentId, because the frozen producer type has no actor field.
FNXC:CccPlanningControl 2026-10-14-17:37:
Errata E5-L1 item 11: the operator_answer is published through card A1's publisher inside this transaction, so it gets
A1's validation, task-row lock, input check, savepoint-scoped publisher flag and A1's artifact-published event, instead
of a second local INSERT and event of another shape.
FNXC:CccPlanningControl 2026-10-14-18:47:
Errata E7-L item 11, recorded and not fixed: this locks the planning work items, then the anchor, then (inside A1's
publisher) the task row, while A1's planning-fence publish takes the task row before the work item. With a running
planning item while the run awaits intent the two can deadlock; PostgreSQL detects it (40P01) and aborts one of them.
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

    const contentSchema = "ccc-planning.operator-answer.v1";
    const { key } = await publishCccPlanningArtifactWithinTransaction(tx, anchor.project_id, {
      planningTaskId: anchor.planning_task_id, runId: anchor.run_id,
      slot: { runRevision: anchor.revision, stageId: "operator", slot: `answer${controlSeq}`, version: 1 },
      kind: "operator_answer", contentSchema,
      content: { type: "json", value: { schema: contentSchema, decisionId: i.decisionId, actor, answer: i.answer } },
      inputs: question ? [{ artifactKey: question.key, digest: question.digest }] : [],
      producer: { kind: "operator", roleId: "operator", instanceId: `operator:${controlSeq}` },
      policy: { promptVersion: "none", promptDigest: "none", toolPolicyVersion: "none", toolPolicyDigest: "none" },
      status: "complete", fence: { kind: "operator", runRevision: anchor.revision, controlSeq }, now,
    });
    await requeueHeld(tx, running, items, now);

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
        // Errata E5-L1 item 13 keeps this: a second cancel while one is pending is CONTROL_PENDING and writes nothing.
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

/*
FNXC:CccPlanningControl 2026-10-14-18:47:
Errata E7-L item 9: the within-transaction form for BF, whose D43 rows that end in `cancelled` run inside the campaign
transaction's savepoint. It is the one path to `cancelled` (D45): the direct function below only opens the transaction
and calls it. It writes nothing of its own outside `tx`, so a caller that rolls back leaves the run as it was. The
caller names the project, because the transaction carries no layer.
*/
export async function completeCccPlanningCancellationWithin(tx: DbTransaction, i: Readonly<{
  projectId: string; runId: string; now?: string }>): Promise<Readonly<{ completed: boolean }>> {
  requireCompletionNow(i.now);
  requireProjectId(i.projectId);
  requireRunId(i.runId);
  try {
    const found = await rows(tx, sql`
      SELECT ${ANCHOR_COLUMNS} FROM project.ccc_planning_runs WHERE project_id = ${i.projectId} AND run_id = ${i.runId}
    `);
    if (found.length !== 1) refuse("CCC_PLANNING_RUN_NOT_FOUND", `run ${i.runId} not found`, "runId");
    const located = normalizeAnchor(found[0]!);
    if (located.state === "cancelled") return { completed: true };
    if (located.state !== "cancelling") return { completed: false };
    const items = await lockPlanningItems(tx, located);
    const anchor = await lockAnchor(tx, located.project_id, located.run_id);
    // Errata E5-L1 item 7: the caller's `now` only stamps the writes; lease liveness was judged by the database clock.
    const now = i.now ?? await databaseNow(tx);
    const completion = await completeCancellationWithin(tx, anchor, items, now, CONTROLLER_AGENT);
    if (!completion.completed && completion.blocked) await recordCancellationDeferral(tx, completion.anchor, completion.blocked, now);
    return { completed: completion.completed };
  } catch (error) {
    throw mapDatabaseError(error);
  }
}

export async function completeCccPlanningCancellation(layer: AsyncDataLayer, i: Readonly<{ runId: string; now?: string }>):
  Promise<Readonly<{ completed: boolean }>> {
  requireCompletionNow(i.now);
  return inTransaction(layer, async (tx) => {
    const located = await locateRun(tx, layer, i.runId);
    return completeCccPlanningCancellationWithin(tx, {
      projectId: located.project_id, runId: located.run_id, ...(i.now !== undefined ? { now: i.now } : {}),
    });
  });
}

type CccPlanningTransitionInput = Readonly<{
  runId: string; from: CccPlanningRunState; to: CccPlanningRunState; stateCode: string | null;
  fence: CccPlanningWorkItemFence | null }>;

/** The refusals of the generic transition that need no read; both forms run them before anything else. */
function requireTransitionInput(i: CccPlanningTransitionInput): void {
  if (!RUN_STATES.has(i.from) || !RUN_STATES.has(i.to)) refuse("CCC_PLANNING_INTERNAL_ERROR", "from and to must be run states", "state");
  if (i.stateCode !== null && (typeof i.stateCode !== "string" || !STATE_CODE_PATTERN.test(i.stateCode))) {
    refuse("CCC_PLANNING_INTERNAL_ERROR", "stateCode must match CCC_[A-Z0-9_]{1,120}", "stateCode");
  }
  if (i.from === i.to || !cccPlanningTransitionAllowed(i.from, i.to)) {
    refuse("CCC_PLANNING_STATE_TRANSITION_REFUSED", `${i.from} -> ${i.to} is not an allowed transition`, "state");
  }
  /*
  FNXC:CccPlanningControl 2026-10-14-17:37:
  Errata E5-L1 item 8 (ADV-10, D45): cancelled is reached only by completeCccPlanningCancellation, which checks the
  lease and the unsettled calls first; the generic transition refuses it. Item 5: the move carries the pending-control
  predicate (moveRun `respectControl`), so a pending control refuses every other target with CONTROL_PENDING.
  */
  if (i.to === "cancelled") {
    refuse("CCC_PLANNING_STATE_TRANSITION_REFUSED", "only completeCccPlanningCancellation moves a run to cancelled", "to");
  }
}

/*
FNXC:CccPlanningLedger 2026-10-14-14:05:
The generic CAS transition used by H1 and the stage host. Moving to awaiting_intent derives awaiting_decision_id from the
newest decision_request artifact of the current revision, because the frozen signature carries no decision id and the
anchor CHECK requires one; with no such artifact the move is refused and nothing is written.
FNXC:CccPlanningControl 2026-10-14-20:52:
Errata E8-L item 1 (E8-0 B-1): the within-transaction form for BF, whose D43 rows that do not end in cancelled (and
the -> cancelling step before completeCccPlanningCancellationWithin) move the run inside the campaign transaction's
savepoint. It has the same refusals, the same pending-control CAS predicate (E7-L item 2) and the same state event as
the direct form, which only opens the transaction and calls it, so there is one transition path. It writes nothing
outside `tx`, so a caller that rolls back leaves the run as it was. The caller names the project, because the
transaction carries no layer (as completeCccPlanningCancellationWithin does). A malformed run id is refused before any
read, so it never aborts the caller's transaction.
*/
export async function transitionCccPlanningRunStateWithin(tx: DbTransaction, i: Readonly<{ projectId: string }>
  & CccPlanningTransitionInput): Promise<CccPlanningRunCustody> {
  requireTransitionInput(i);
  requireProjectId(i.projectId);
  requireRunId(i.runId);
  try {
    const found = await rows(tx, sql`
      SELECT ${ANCHOR_COLUMNS} FROM project.ccc_planning_runs WHERE project_id = ${i.projectId} AND run_id = ${i.runId}
    `);
    if (found.length !== 1) refuse("CCC_PLANNING_RUN_NOT_FOUND", `run ${i.runId} not found`, "runId");
    const located = normalizeAnchor(found[0]!);
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
      to: i.to, stateCode: i.stateCode, now, agentId: CONTROLLER_AGENT, respectControl: true, ...(decisionId ? { decisionId } : {}),
    });
    return custodyOf(moved);
  } catch (error) {
    throw mapDatabaseError(error);
  }
}

export async function transitionCccPlanningRunState(layer: AsyncDataLayer, i: CccPlanningTransitionInput):
  Promise<CccPlanningRunCustody> {
  requireTransitionInput(i);
  return inTransaction(layer, async (tx) => {
    const located = await locateRun(tx, layer, i.runId);
    return transitionCccPlanningRunStateWithin(tx, {
      projectId: located.project_id, runId: located.run_id, from: i.from, to: i.to, stateCode: i.stateCode, fence: i.fence,
    });
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
