import { createHash } from "node:crypto";
import { and, eq, sql, type SQL } from "drizzle-orm";
import { canonicalCccPrdJson } from "../ccc-prd/contract.js";
import { recordRunAuditEventWithinTransaction, type AsyncDataLayer, type DbTransaction } from "../postgres/data-layer.js";
import * as schema from "../postgres/schema/index.js";
import { cccPlanningRuns } from "../postgres/schema/ccc-planning.js";
import { CccPlanningRefusal } from "../ccc-planning/errors.js";
import { CCC_PLANNING_AUDIT_STRING_MAX, cccPlanningEventId,
  cccPlanningLinkedWriterTurnKey } from "../ccc-planning/policy.js";
import type { CccPlanningAuditMutationType, CccPlanningRunCustody, CccPlanningRunState } from "../ccc-planning/types.js";
import { loadCccCampaignContextForTask } from "../ccc-campaign/store.js";
import {
  CccProviderAttemptLimitError,
  type CccCampaignWorkItemFence,
} from "../ccc-campaign/types.js";
import type { WorkflowWorkItem, WorkflowWorkItemState } from "../types.js";
import { CCC_CAMPAIGN_OPERATOR_STOPPED_PREFIX } from "../ccc-prd/product-status.js";
import { completeCccPlanningCancellationWithin, transitionCccPlanningRunStateWithin } from "./ccc-planning-ops.js";

type Row = Record<string, unknown>;
const PAUSED_REASON = "ccc-operator:campaign-paused";
// Native product-status/approval custody use this canonical reason; their current constant is module-private.
const LIVE_EXECUTION_APPROVAL_REQUIRED_REASON = "ccc-permanent:CCC_CAMPAIGN_LIVE_EXECUTION_APPROVAL_REQUIRED";
const ROUTE_REFUSALS = new Set(["receipt-missing", "receipt-mismatch", "effective-route-drift"]);
const LIMIT_REASONS = new Set(["deadline", "max-requests", "max-concurrency", "iteration-cap", "dispatch-cap",
  "unreconciled-dispatch", "control-pending", "phase-allocation", "run-not-building", "runtime-not-permitted",
  ...ROUTE_REFUSALS, "degenerate-output"]);
const TERMINAL_ITEMS = new Set(["succeeded", "failed", "manual-required", "cancelled", "exhausted"]);

async function rows<T = Row>(tx: DbTransaction, query: SQL): Promise<T[]> {
  return await tx.execute(query) as unknown as T[];
}

function bounded(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value || value !== value.trim() || value.length > CCC_PLANNING_AUDIT_STRING_MAX) {
    throw new CccPlanningRefusal("CCC_PLANNING_INTERNAL_ERROR", `${label} must be bounded canonical text`, label);
  }
}

async function now(tx: DbTransaction): Promise<string> {
  return (await rows<{ now: string }>(tx, sql`
    SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now
  `))[0]!.now;
}

/** FNXC:CccPlanningCampaignLink 2026-10-15: one indexed, project-scoped lookup; the lock serializes linked reservations and outcome mapping. */
export async function findCccPlanningRunForImport(tx: DbTransaction, projectId: string, importId: string):
  Promise<CccPlanningRunCustody | null> {
  const table = cccPlanningRuns;
  const [run] = await tx.select().from(table).where(and(eq(table.projectId, projectId), eq(table.importId, importId)))
    .limit(1).for("update");
  return run ? {
    kind: "planning", projectId: run.projectId, runId: run.runId, planningTaskId: run.planningTaskId, revision: run.revision,
    state: run.state as CccPlanningRunState, mode: run.mode, budgetProfile: run.budgetProfile, deadlineAt: run.deadlineAt,
    grantDigest: run.grantDigest, controlSeq: run.controlSeq, importId: run.importId,
    runtimeDistManifestSha256: run.runtimeDistManifestSha256,
  } : null;
}

export type CccPlanningLinkedWriterRoute = Readonly<{
  providerId: string; modelId: string; transport: string; roleClass: string; toolsetDigest: string;
}>;

export async function openCccPlanningLinkedWriterAttempt(layer: AsyncDataLayer, i: Readonly<{
  importId: string; semanticTaskId: string; baseTurnKey: string; nodeAttemptOrdinal: number;
  toolsetDigest: string; fence: CccCampaignWorkItemFence }>):
  Promise<Readonly<{ turnKey: string; dispatchAttemptOrdinal: 1 | 2 | 3; route: CccPlanningLinkedWriterRoute }>> {
  for (const key of ["importId", "semanticTaskId", "baseTurnKey"] as const) bounded(i[key], key);
  // FNXC:CccPlanningLinkedWriterRoute 2026-10-15-11:00: WR supplies the issued C2 policy's schema-bearing digest (E18); core cannot derive engine tool schemas.
  if (typeof i.toolsetDigest !== "string" || !/^[0-9a-f]{64}$/u.test(i.toolsetDigest)) {
    throw new CccPlanningRefusal("CCC_PLANNING_INTERNAL_ERROR", "toolsetDigest must be a lowercase sha256", "toolsetDigest");
  }
  if (!Number.isSafeInteger(i.nodeAttemptOrdinal) || i.nodeAttemptOrdinal < 1) {
    throw new CccPlanningRefusal("CCC_PLANNING_INTERNAL_ERROR", "nodeAttemptOrdinal must be a positive integer");
  }
  return layer.transactionImmediate(async (tx) => {
    const projectId = layer.projectId?.trim() || "__legacy_unscoped__";
    const [task] = await rows<{ native_id: string; root_dir: string }>(tx, sql`
      SELECT e.native_id, i.root_dir FROM project.ccc_prd_import_entities e
      JOIN project.ccc_prd_imports i ON i.project_id = e.project_id AND i.import_id = e.import_id
      JOIN project.workflow_work_items w ON w.project_id = e.project_id
       WHERE e.project_id = ${projectId} AND e.import_id = ${i.importId}
         AND e.entity_type = 'task' AND e.entity_id = ${i.semanticTaskId}
         AND w.id = ${i.fence.workItemId} AND w.run_id = ${`ccc-prd:${i.importId}`}
         AND w.run_id = ${i.fence.runId} AND w.attempt = ${i.fence.attempt}
         AND w.state = 'running' AND w.lease_expires_at::timestamptz > clock_timestamp()
       LIMIT 1
    `);
    if (!task) throw new CccPlanningRefusal("CCC_PLANNING_FENCE_STALE", "linked writer requires its live campaign fence");
    const context = await loadCccCampaignContextForTask(layer, task.root_dir, task.native_id, tx, true);
    const run = await findCccPlanningRunForImport(tx, projectId, i.importId);
    if (!run || !context || context.semanticTaskId !== i.semanticTaskId || context.importId !== i.importId) {
      throw new CccPlanningRefusal("CCC_PLANNING_TASK_CUSTODY", "writer has no exact linked import custody");
    }
    if (i.nodeAttemptOrdinal > 3) {
      throw new CccPlanningLinkedWriterLimitError({ runId: run.runId, importId: i.importId,
        turnKey: i.baseTurnKey, dispatchKey: "pi-stream:1", reason: "dispatch-cap", refusedAt: await now(tx) },
      "CCC_PLANNING_DISPATCH_CAP: linked writer has at most three attempts");
    }
    const dispatchAttemptOrdinal = i.nodeAttemptOrdinal as 1 | 2 | 3;
    return Object.freeze({ turnKey: cccPlanningLinkedWriterTurnKey({ baseTurnKey: i.baseTurnKey, dispatchAttemptOrdinal }),
      dispatchAttemptOrdinal, route: Object.freeze({ providerId: context.route.providerId, modelId: context.route.modelId,
        transport: context.route.transport, roleClass: "writer", toolsetDigest: i.toolsetDigest }) });
  });
}

type OutcomeInput = Readonly<{
  projectId: string; before: WorkflowWorkItem; workItem: WorkflowWorkItem; fromState: WorkflowWorkItemState;
  toState: WorkflowWorkItemState }>;
type OutcomeResult = Readonly<{ kind: "not-linked" } | { kind: "mapped"; runState: CccPlanningRunState } | { kind: "unmapped" }>;
let outcomeSeam: ((tx: DbTransaction) => Promise<void>) | null = null;

async function audit(tx: DbTransaction, run: CccPlanningRunCustody, mutationType: CccPlanningAuditMutationType,
  subject: string, timestamp: string, metadata: Row): Promise<void> {
  await recordRunAuditEventWithinTransaction(tx, { timestamp, taskId: run.planningTaskId,
    agentId: "ccc-planning-controller", runId: run.runId, domain: "database", mutationType, target: subject, metadata,
    eventId: cccPlanningEventId({ projectId: run.projectId, runId: run.runId, mutationType, subject }) }, run.projectId);
}

async function move(tx: DbTransaction, run: CccPlanningRunCustody, to: CccPlanningRunState, stateCode: string | null):
  Promise<CccPlanningRunCustody> {
  if (run.state === to) return run;
  return transitionCccPlanningRunStateWithin(tx, { projectId: run.projectId, runId: run.runId, from: run.state,
    to, stateCode, fence: null });
}

async function cancel(tx: DbTransaction, run: CccPlanningRunCustody, complete: boolean): Promise<CccPlanningRunState> {
  if (run.state === "cancelled") return "cancelled";
  const cancelling = await move(tx, run, "cancelling", null);
  if (complete && !await hasUnsettledLinkedCall(tx, run, true) && (await completeCccPlanningCancellationWithin(tx, { projectId: run.projectId, runId: run.runId })).completed) {
    return "cancelled";
  }
  return cancelling.state;
}

async function verdicts(tx: DbTransaction, run: CccPlanningRunCustody): Promise<Readonly<{ finalAccepted: boolean; rejected: boolean }>> {
  const documents = await rows<{ content: string; metadata: { kind: string; outputDigest: string; runId: string; status: string } }>(tx, sql`
    SELECT content, metadata FROM project.task_documents WHERE project_id = ${run.projectId} AND task_id = ${run.planningTaskId}
      AND key LIKE ${`cccplan-r${String(run.revision).padStart(3, "0")}-%`}
      AND metadata->>'kind' IN ('task_review', 'final_judgment')
  `);
  let finalAccepted = false;
  let rejected = false;
  for (const document of documents) {
    if (document.metadata.runId !== run.runId || document.metadata.status !== "complete"
      || createHash("sha256").update(document.content).digest("hex") !== document.metadata.outputDigest) continue;
    const content = JSON.parse(document.content) as { verdict?: unknown };
    if (document.metadata.kind === "final_judgment" && content.verdict === "accept") finalAccepted = true;
    if (content.verdict === "reject") rejected = true;
  }
  return { finalAccepted, rejected };
}

async function latestRefusal(tx: DbTransaction, run: CccPlanningRunCustody): Promise<string | null> {
  return (await rows<{ reason: string }>(tx, sql`
    SELECT metadata->>'reason' AS reason FROM project.run_audit_events
     WHERE project_id = ${run.projectId} AND run_id = ${run.runId} AND mutation_type = 'ccc-planning:writer-refused'
     ORDER BY coalesce((metadata->>'ordinal')::int, 0) DESC, timestamp DESC, id DESC LIMIT 1
  `))[0]?.reason ?? null;
}

async function hasUnsettledLinkedCall(tx: DbTransaction, run: CccPlanningRunCustody, includeReserved: boolean): Promise<boolean> {
  const [active] = await rows(tx, sql`
    SELECT 1 FROM project.run_audit_events d WHERE d.project_id = ${run.projectId}
      AND d.campaign_import_id = ${run.importId}
      AND (d.mutation_type = 'ccc-campaign:provider-attempt:dispatched'
        OR (${includeReserved} AND d.mutation_type = 'ccc-campaign:provider-attempt:reserved'))
      AND NOT EXISTS (SELECT 1 FROM project.run_audit_events t WHERE t.project_id = d.project_id
        AND t.campaign_import_id = d.campaign_import_id AND t.mutation_type = 'ccc-campaign:provider-attempt:terminal'
        AND t.metadata->>'attemptKey' = d.metadata->>'attemptKey') LIMIT 1
  `);
  return active !== undefined;
}

async function mapOutcome(tx: DbTransaction, run: CccPlanningRunCustody, i: OutcomeInput): Promise<OutcomeResult> {
  if (outcomeSeam) await outcomeSeam(tx);
  if ((run.state === "cancelling" || run.state === "cancelled") && TERMINAL_ITEMS.has(i.toState)) {
    return { kind: "mapped", runState: await cancel(tx, run, true) };
  }
  let target: CccPlanningRunState | null = null;
  let code: string | null = null;
  const prebuildApprovalPark = i.toState === "manual-required"
    && (run.state === "importing" || run.state === "awaiting_execution_authority")
    && i.workItem.blockedReason === LIVE_EXECUTION_APPROVAL_REQUIRED_REASON;
  if (i.toState === "held" && i.workItem.blockedReason === PAUSED_REASON) target = "paused";
  else if (i.fromState === "held" && i.toState === "runnable" && i.before.blockedReason === PAUSED_REASON) target = "building";
  else if (i.toState === "cancelled" && (i.workItem.lastError?.startsWith(CCC_CAMPAIGN_OPERATOR_STOPPED_PREFIX)
    || (i.fromState === "running" && i.workItem.lastError === "workflow-user-cancelled"))) {
    return { kind: "mapped", runState: await cancel(tx, run, true) };
  } else if (i.toState === "succeeded") {
    const [incomplete] = await rows(tx, sql`SELECT 1 FROM project.workflow_work_items
      WHERE project_id = ${run.projectId} AND run_id = ${`ccc-prd:${run.importId}`} AND state <> 'succeeded' LIMIT 1`);
    if (incomplete) return { kind: "mapped", runState: run.state };
    const evidence = await verdicts(tx, run);
    target = evidence.finalAccepted ? "accepted" : "failed";
    code = evidence.finalAccepted ? null : "CCC_PLANNING_FINAL_JUDGMENT_MISSING";
  } else if (!prebuildApprovalPark && (i.toState === "failed" || i.toState === "manual-required")) {
    const evidence = await verdicts(tx, run);
    const refusal = await latestRefusal(tx, run);
    if (evidence.rejected) { target = "verification_failed"; code = "CCC_PLANNING_CODING_REPAIR_NOT_RUN"; }
    else if (["iteration-cap", "dispatch-cap", "phase-allocation", "max-requests", "deadline"].includes(refusal ?? "")) {
      target = "budget_exhausted";
      code = ({ "iteration-cap": "CCC_PLANNING_ITERATION_CAP", "dispatch-cap": "CCC_PLANNING_DISPATCH_CAP",
        "phase-allocation": "CCC_PLANNING_PHASE_ALLOCATION_EXHAUSTED", "max-requests": "CCC_PLANNING_PHASE_ALLOCATION_EXHAUSTED",
        deadline: "CCC_PLANNING_DEADLINE" } as Record<string, string>)[refusal!]!;
    } else if (ROUTE_REFUSALS.has(refusal ?? "") || refusal === "degenerate-output") {
      target = "blocked_provider"; code = refusal === "degenerate-output" ? "CCC_MODEL_DEGENERATE_OUTPUT" : "CCC_PROVIDER_PIN_DRIFT";
    } else if (i.toState === "manual-required" && await hasUnsettledLinkedCall(tx, run, false)) {
      target = "unknown_effect"; code = "CCC_PLANNING_UNRECONCILED_DISPATCH";
    } else if (i.toState === "manual-required"
      && i.workItem.blockedReason === "ccc-permanent:CCC_PLANNING_WRITER_CLOSURE_UNCONFIRMED") {
      target = "blocked_prerequisite"; code = "CCC_PLANNING_WRITER_CLOSURE_UNCONFIRMED";
    }
  }
  if (target === null && ["failed", "manual-required", "cancelled"].includes(i.toState)) {
    const [control] = await rows<{ control_request: string | null }>(tx, sql`SELECT control_request
      FROM project.ccc_planning_runs WHERE project_id = ${run.projectId} AND run_id = ${run.runId}`);
    if (control?.control_request === "cancel" || await latestRefusal(tx, run) === "control-pending") {
      return { kind: "mapped", runState: await cancel(tx, run, true) };
    }
  }
  // FNXC:CccPlanningCampaignLink 2026-10-15-06:00: native live-approval parking preserves the prebuild anchor after cancellation has had priority.
  if (prebuildApprovalPark) return { kind: "mapped", runState: run.state };
  if (target === null && TERMINAL_ITEMS.has(i.toState)) { target = "failed"; code = "CCC_PLANNING_CAMPAIGN_FAILED"; }
  if (target === null) return { kind: "mapped", runState: run.state };
  try {
    return { kind: "mapped", runState: (await move(tx, run, target, code)).state };
  } catch (error) {
    if (error instanceof CccPlanningRefusal && error.code === "CCC_PLANNING_CONTROL_PENDING") {
      const [control] = await rows<{ control_request: string | null }>(tx, sql`SELECT control_request
        FROM project.ccc_planning_runs WHERE project_id = ${run.projectId} AND run_id = ${run.runId}`);
      if (control?.control_request === "cancel") return { kind: "mapped", runState: await cancel(tx, run, i.toState !== "succeeded") };
    }
    throw error;
  }
}

/** FNXC:CccPlanningCampaignLink 2026-10-15: contain SQL failures in a savepoint so campaign transitions always retain their own outcome. */
export async function applyCccPlanningCampaignOutcomeWithinTransaction(tx: DbTransaction, i: OutcomeInput):
  Promise<Readonly<{ kind: "not-linked" } | { kind: "mapped"; runState: CccPlanningRunState } | { kind: "unmapped" }>> {
  if (!i.workItem.runId.startsWith("ccc-prd:")) return { kind: "not-linked" };
  const importId = i.workItem.runId.slice("ccc-prd:".length);
  let run: CccPlanningRunCustody | null = null;
  try {
    return await tx.transaction(async (nested) => {
      run = await findCccPlanningRunForImport(nested, i.projectId, importId);
      return run ? mapOutcome(nested, run, i) : { kind: "not-linked" } as const;
    });
  } catch {
    if (run) {
      const linked = run;
      // The marker has its own savepoint too: audit failure must never poison the caller's transaction.
      await tx.transaction(async (nested) => audit(nested, linked, "ccc-planning:campaign-unmapped",
        createHash("sha256").update(canonicalCccPrdJson({ workItemId: i.workItem.id, attempt: i.workItem.attempt,
          fromState: i.fromState, toState: i.toState, updatedAt: i.workItem.updatedAt })).digest("hex"), await now(nested),
        { marker: "CCC_PLANNING_CAMPAIGN_STATE_UNMAPPED", importId, workItemId: i.workItem.id,
          fromState: i.fromState, toState: i.toState })).catch(() => undefined);
    }
    return { kind: "unmapped" };
  }
}

export async function reconcileCccPlanningCampaignOutcome(layer: AsyncDataLayer, runId: string): Promise<void> {
  bounded(runId, "runId");
  await layer.transactionImmediate(async (tx) => {
    const table = cccPlanningRuns;
    const found = await tx.select().from(table).where(and(eq(table.runId, runId),
      layer.projectId ? eq(table.projectId, layer.projectId) : undefined)).limit(2);
    if (found.length !== 1 || !found[0]!.importId) return;
    const run = found[0]!;
    const items = schema.project.workflowWorkItems;
    const workItems = await tx.select().from(items).where(and(eq(items.projectId, run.projectId),
      eq(items.runId, `ccc-prd:${run.importId}`))).orderBy(items.id);
    for (const row of workItems) {
      const item = row as WorkflowWorkItem;
      await applyCccPlanningCampaignOutcomeWithinTransaction(tx, { projectId: run.projectId, before: item,
        workItem: item, fromState: item.state, toState: item.state });
    }
  });
}

export type CccPlanningWriterRefusal = Readonly<{ runId: string; importId: string; turnKey: string; dispatchKey: string;
  reason: CccProviderAttemptLimitError["reason"]; refusedAt: string }>;

export class CccPlanningLinkedWriterLimitError extends CccProviderAttemptLimitError {
  public readonly refusal: CccPlanningWriterRefusal;

  public constructor(refusal: CccPlanningWriterRefusal, message: string) {
    super(refusal.reason, message);
    this.name = "CccPlanningLinkedWriterLimitError";
    this.refusal = Object.freeze({ ...refusal });
  }
}

export async function recordCccPlanningWriterRefusalWithin(tx: DbTransaction, run: CccPlanningRunCustody,
  refusal: CccPlanningWriterRefusal): Promise<void> {
  const subject = createHash("sha256").update(canonicalCccPrdJson({ importId: refusal.importId, turnKey: refusal.turnKey,
    dispatchKey: refusal.dispatchKey, reason: refusal.reason })).digest("hex");
  const eventId = cccPlanningEventId({ projectId: run.projectId, runId: run.runId,
    mutationType: "ccc-planning:writer-refused", subject });
  const [existing] = await rows<{ ordinal: string }>(tx, sql`SELECT metadata->>'ordinal' AS ordinal FROM project.run_audit_events
    WHERE project_id = ${run.projectId} AND id = ${eventId}`);
  const [count] = await rows<{ n: number }>(tx, sql`SELECT count(*)::int AS n FROM project.run_audit_events
    WHERE project_id = ${run.projectId} AND run_id = ${run.runId} AND mutation_type = 'ccc-planning:writer-refused'`);
  const ordinal = existing ? Number(existing.ordinal) : count!.n + 1;
  if (!Number.isSafeInteger(ordinal) || ordinal < 1) {
    throw new CccPlanningRefusal("CCC_PLANNING_INTERNAL_ERROR", "writer refusal ordinal is invalid");
  }
  await audit(tx, run, "ccc-planning:writer-refused", subject, refusal.refusedAt,
    { importId: refusal.importId, turnKey: refusal.turnKey, dispatchKey: refusal.dispatchKey, reason: refusal.reason,
      ordinal });
}

export async function recordCccPlanningWriterRefusal(layer: AsyncDataLayer, refusal: CccPlanningWriterRefusal): Promise<void> {
  for (const key of ["runId", "importId", "turnKey", "dispatchKey"] as const) bounded(refusal[key], key);
  if (!LIMIT_REASONS.has(refusal.reason) || !Number.isFinite(Date.parse(refusal.refusedAt))) {
    throw new CccPlanningRefusal("CCC_PLANNING_INTERNAL_ERROR", "writer refusal has an invalid reason or timestamp");
  }
  await layer.transactionImmediate(async (tx) => {
    const table = cccPlanningRuns;
    const runs = await tx.select({ projectId: table.projectId }).from(table).where(and(eq(table.runId, refusal.runId),
      eq(table.importId, refusal.importId), layer.projectId ? eq(table.projectId, layer.projectId) : undefined)).limit(2);
    if (runs.length !== 1) throw new CccPlanningRefusal("CCC_PLANNING_TASK_CUSTODY", "writer refusal has no exact run");
    const run = await findCccPlanningRunForImport(tx, runs[0]!.projectId, refusal.importId);
    if (!run || run.runId !== refusal.runId) throw new CccPlanningRefusal("CCC_PLANNING_TASK_CUSTODY", "writer refusal run drifted");
    await recordCccPlanningWriterRefusalWithin(tx, run, refusal);
  });
}

export function __setCccPlanningCampaignOutcomeSeamForTesting(seam: ((tx: DbTransaction) => Promise<void>) | null): void {
  outcomeSeam = seam;
}
