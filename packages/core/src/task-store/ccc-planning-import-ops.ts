/*
FNXC:CccPlanningImportLink 2026-10-14-22:48:
The import intent and the import link of a request-to-code Build run (CONTRACT-v3.5 section 2.11, card IM1; D16, D17,
critic 7, challenge 21). The intent is persisted before the importer runs and the link is written after it, each once:
- `recordCccPlanningImportIntent` is one transaction: it requires the intent's limits to deep-equal the bounds of the
  published `bundle` and `admission_facts` artifacts (else IMPORT_IDENTITY_DRIFT), CASes the anchor (state importing,
  intent digest null) to `import_intent_digest = sha256(canonical(intent))` and `import_idempotency_key`, and publishes
  the `import_intent` artifact. The anchor and the artifact commit or roll back together, so recovery can trust either.
- `linkCccPlanningImport` is one transaction: it reads the importer's `ccc_prd_imports` row by the import key, requires
  its bundle hash to equal the intent's, sets `import_id` and `implementation_transferred`, and publishes
  `import_receipt`. The state stays `importing`; AU2 moves it on.
- `inspectCccPlanningImportLink` reports none, intent-only (the bridge's RECONCILE signal) or linked.
The anchor trigger (0042) keeps the four link columns write-once (IMPORT_LINK_WRITE_ONCE) as the backstop; this module
refuses first, before any write, and replays an identical intent or link instead of rewriting it.

Decisions worth stating where the code is (each is the narrowest reading of the contract against the real code):
- `CccPlanningImportClosure` is defined here. Section 2.11 names it in the intent but core defines it nowhere, and core
  never imports engine, so the ADR B shape (13 artifact refs) lives with the intent that carries it.
- The bounds check. `bundle.bounds` is `CccPrdExecutionBounds`, which has exactly maxRequests, maxDurationMs and
  maxConcurrency, so it is compared with those three fields of the limits. `admission_facts.bounds` is where D16 stores
  the bounds computed once, so it is compared with the whole limits object, boundsComputedAt and clamps included. Both
  comparisons are canonical-JSON equality. The two artifacts are found by kind and run revision (exactly one of each),
  because their slot names belong to the bridge (IB2), not to this card.
- Artifact slots: the intent is `cccplan-r<rev>-import-intent-v01` (ADR B Q2), the receipt
  `cccplan-r<rev>-import-receipt-v01`. The intent's inputs are the two artifacts it was checked against; the
  receipt's input is the intent. Both publish through A1 under the planning work item's lease.
- `implementation_transferred` is the intent's `limits.maxRequests` (D16: min(implementation allocation, 10,000)).
- Lock order is task row, then the fenced work item, then the anchor: A1's publisher takes the task row before the
  work item and L1 takes the work item before the anchor, so this order agrees with both.
- A caller bug (a malformed intent, an intent for another run, receipt or key, a link before any intent or before the
  importer committed its row) refuses CCC_PLANNING_INTERNAL_ERROR before any write, as AD1 does.
*/
import { createHash } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import { canonicalCccPrdJson } from "../ccc-prd/contract.js";
import {
  recordRunAuditEventWithinTransaction,
  RunAuditEventCollisionError,
  type AsyncDataLayer,
  type DbTransaction,
} from "../postgres/data-layer.js";
import {
  decodeCccPlanningArtifactKey,
  encodeCccPlanningArtifactKey,
  type CccPlanningArtifactKind,
  type CccPlanningArtifactRef,
} from "../ccc-planning/artifacts.js";
import { CccPlanningRefusal, cccPlanningRefusalFromDatabaseError, type CccPlanningRefusalCode } from "../ccc-planning/errors.js";
import { CCC_PLANNING_RUN_ID_PATTERN } from "../ccc-planning/marker.js";
import {
  CCC_PRD_IMPORT_MAX_DURATION_MS,
  CCC_PRD_IMPORT_MAX_REQUESTS,
  cccPlanningEventId,
  cccPlanningImportKey,
} from "../ccc-planning/policy.js";
import type { CccPlanningAuditMutationType, CccPlanningWorkItemFence } from "../ccc-planning/types.js";
import { publishCccPlanningArtifactWithinTransaction } from "./ccc-planning-artifact-ops.js";

export type CccPlanningImportClosure = Readonly<{
  originalRequest: CccPlanningArtifactRef; admissionGrant: CccPlanningArtifactRef;
  buildGrant: CccPlanningArtifactRef; buildTransition: CccPlanningArtifactRef;
  acceptanceCases: CccPlanningArtifactRef; requirementMap: CccPlanningArtifactRef;
  finalPrd: CccPlanningArtifactRef; technicalAnnex: CccPlanningArtifactRef;
  taskPlan: CccPlanningArtifactRef; routingPlan: CccPlanningArtifactRef;
  verifierBundle: CccPlanningArtifactRef; oracleAudit: CccPlanningArtifactRef;
  finalAdjudication: CccPlanningArtifactRef;
}>;

export type CccPlanningImportIntentV1 = Readonly<{
  schema: "ccc-planning.import-intent.v1"; runId: string; runRevision: number; idempotencyKey: string;
  bundleHash: string; packetHash: string; sidecarHash: string; executionPolicyDigest: string;
  targetRepository: string; targetBase: string; targetHead: string;     // targetBase = B1; targetHead = B1 after the baseline step
  baselineBranchRef: string; buildTransitionRef: CccPlanningArtifactRef;
  limits: Readonly<{ maxRequests: number; maxDurationMs: number; maxConcurrency: 1; boundsComputedAt: string;
    clamps: readonly Readonly<{ field: "maxRequests" | "maxDurationMs"; requested: number; applied: number;
      reason: "import-ceiling" | "deadline-headroom" }>[] }>;
  closure: CccPlanningImportClosure; closureDigest: string; receiptSha256: string;
}>;

export type CccPlanningImportReceiptV1 = Readonly<{
  schema: "ccc-planning.import-receipt.v1"; runId: string; runRevision: number; idempotencyKey: string;
  importId: string; bundleHash: string; intentDigest: string; implementationTransferred: number;
  maxDurationMs: number; replayed: boolean;
  release: "released" | "awaiting_operator" | "not_applicable";
}>;

const CONTROLLER_AGENT = "ccc-planning-controller";
const INTENT_SCHEMA = "ccc-planning.import-intent.v1";
const RECEIPT_SCHEMA = "ccc-planning.import-receipt.v1";
const HEX64 = /^[0-9a-f]{64}$/u;
const COMMIT_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const ISO_INSTANT = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?Z$/u;
const IMPORT_KEY_PATTERN = /^ccc-plan:[0-9a-f]{24}:r([1-9][0-9]{0,2})$/u;
const PATH_MAX = 4096;
const REF_NAME_MAX = 256;
const TERMINAL_STATES: ReadonlySet<string> = new Set(["cancelled", "delivered", "failed"]);
const RELEASES: ReadonlySet<string> = new Set(["released", "awaiting_operator", "not_applicable"]);
const NO_POLICY = { promptVersion: "none", promptDigest: "none", toolPolicyVersion: "none", toolPolicyDigest: "none" } as const;
const INTENT_KEYS = [
  "schema", "runId", "runRevision", "idempotencyKey", "bundleHash", "packetHash", "sidecarHash", "executionPolicyDigest",
  "targetRepository", "targetBase", "targetHead", "baselineBranchRef", "buildTransitionRef", "limits", "closure",
  "closureDigest", "receiptSha256",
] as const;
const INTENT_DIGEST_FIELDS = [
  "bundleHash", "packetHash", "sidecarHash", "executionPolicyDigest", "closureDigest", "receiptSha256",
] as const;
const LIMIT_KEYS = ["maxRequests", "maxDurationMs", "maxConcurrency", "boundsComputedAt", "clamps"] as const;
const CLAMP_KEYS = ["field", "requested", "applied", "reason"] as const;
const CLOSURE_FIELDS = [
  "originalRequest", "admissionGrant", "buildGrant", "buildTransition", "acceptanceCases", "requirementMap", "finalPrd",
  "technicalAnnex", "taskPlan", "routingPlan", "verifierBundle", "oracleAudit", "finalAdjudication",
] as const;

type Row = Record<string, unknown>;
type QueryHandle = Pick<DbTransaction, "execute">;

type AnchorRow = {
  project_id: string; run_id: string; planning_task_id: string; mode: string; state: string; revision: number;
  authority_receipt_sha256: string; implementation_allocation: number; import_intent_digest: string | null;
  import_idempotency_key: string | null; import_id: string | null; implementation_transferred: number | null;
  updated_at: string;
};

const ANCHOR_COLUMNS = sql.raw(`project_id, run_id, planning_task_id, mode, state, revision, authority_receipt_sha256,
  implementation_allocation, import_intent_digest, import_idempotency_key, import_id, implementation_transferred,
  updated_at`);

function refuse(code: CccPlanningRefusalCode, detail: string, field?: string): never {
  throw new CccPlanningRefusal(code, detail, field);
}

function callerBug(field: string, detail: string): never {
  return refuse("CCC_PLANNING_INTERNAL_ERROR", detail, field);
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

async function rows<T = Row>(handle: QueryHandle, query: SQL): Promise<T[]> {
  return (await handle.execute(query)) as unknown as T[];
}

/** Our own refusals and event collisions pass through; a trigger refusal (CCC_PLANNING_* prefix) becomes typed. */
function mapDatabaseError(error: unknown): unknown {
  if (error instanceof CccPlanningRefusal || error instanceof RunAuditEventCollisionError) return error;
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

/** The anchor's `updated_at` only moves forward, as L1 keeps it (state event subjects depend on it). */
function nextUpdatedAt(previous: string, now: string): string {
  const before = Date.parse(previous);
  const current = Date.parse(now);
  return Number.isFinite(before) && current <= before ? new Date(before + 1).toISOString() : now;
}

// ---------------------------------------------------------------- input validation (pure, before any read)

function requireRunId(runId: unknown): string {
  if (typeof runId !== "string" || !CCC_PLANNING_RUN_ID_PATTERN.test(runId)) {
    refuse("CCC_PLANNING_RUN_NOT_FOUND", `run id ${JSON.stringify(runId)} is not ccc-plan:<24 hex>`, "runId");
  }
  return runId;
}

function requireObject(value: unknown, keys: readonly string[], field: string): Row {
  if (value === null || typeof value !== "object" || Array.isArray(value)) callerBug(field, `${field} must be an object`);
  const actual = Object.keys(value as Row).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    callerBug(field, `${field} must have exactly the keys ${expected.join(", ")}`);
  }
  return value as Row;
}

function requireInteger(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    callerBug(field, `${field} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function requireText(value: unknown, field: string, max: number): void {
  if (typeof value !== "string" || value.length === 0 || value.length > max || value !== value.trim()) {
    callerBug(field, `${field} must be a trimmed non-empty string of at most ${max} characters`);
  }
}

function requirePattern(value: unknown, pattern: RegExp, field: string, what: string): void {
  if (typeof value !== "string" || !pattern.test(value)) callerBug(field, `${field} must be ${what}`);
}

function requireRef(value: unknown, field: string): void {
  const ref = requireObject(value, ["artifactKey", "digest"], field);
  if (typeof ref.artifactKey !== "string" || decodeCccPlanningArtifactKey(ref.artifactKey) === null) {
    callerBug(`${field}.artifactKey`, `${field}.artifactKey must be a planning artifact key`);
  }
  requirePattern(ref.digest, HEX64, `${field}.digest`, "64 lowercase hex characters");
}

function requireLimits(value: unknown): void {
  const limits = requireObject(value, LIMIT_KEYS, "intent.limits");
  requireInteger(limits.maxRequests, "intent.limits.maxRequests", 1, CCC_PRD_IMPORT_MAX_REQUESTS);
  requireInteger(limits.maxDurationMs, "intent.limits.maxDurationMs", 1, CCC_PRD_IMPORT_MAX_DURATION_MS);
  if (limits.maxConcurrency !== 1) callerBug("intent.limits.maxConcurrency", "a planning import runs one writer at a time (D16)");
  requirePattern(limits.boundsComputedAt, ISO_INSTANT, "intent.limits.boundsComputedAt", "an ISO-8601 UTC instant");
  if (!Array.isArray(limits.clamps)) callerBug("intent.limits.clamps", "intent.limits.clamps must be an array");
  for (const [index, raw] of (limits.clamps as unknown[]).entries()) {
    const field = `intent.limits.clamps[${index}]`;
    const clamp = requireObject(raw, CLAMP_KEYS, field);
    if (clamp.field !== "maxRequests" && clamp.field !== "maxDurationMs") callerBug(`${field}.field`, "a clamp names maxRequests or maxDurationMs");
    if (clamp.reason !== "import-ceiling" && clamp.reason !== "deadline-headroom") {
      callerBug(`${field}.reason`, "a clamp reason is import-ceiling or deadline-headroom");
    }
    requireInteger(clamp.requested, `${field}.requested`, 0, Number.MAX_SAFE_INTEGER);
    requireInteger(clamp.applied, `${field}.applied`, 0, Number.MAX_SAFE_INTEGER);
  }
}

/** The intent is exactly the frozen shape and names this run and its own import key (D17). */
function requireIntent(runId: string, intent: CccPlanningImportIntentV1): void {
  const value = requireObject(intent, INTENT_KEYS, "intent");
  if (value.schema !== INTENT_SCHEMA) callerBug("intent.schema", `intent.schema must be ${INTENT_SCHEMA}`);
  if (value.runId !== runId) callerBug("intent.runId", `the intent names run ${String(value.runId)}, not ${runId}`);
  const revision = requireInteger(value.runRevision, "intent.runRevision", 1, 999);
  if (value.idempotencyKey !== cccPlanningImportKey(runId, revision)) {
    callerBug("intent.idempotencyKey", `the import key must be ${cccPlanningImportKey(runId, revision)} (D17)`);
  }
  for (const field of INTENT_DIGEST_FIELDS) requirePattern(value[field], HEX64, `intent.${field}`, "64 lowercase hex characters");
  requireText(value.targetRepository, "intent.targetRepository", PATH_MAX);
  requirePattern(value.targetBase, COMMIT_OID, "intent.targetBase", "a commit oid");
  requirePattern(value.targetHead, COMMIT_OID, "intent.targetHead", "a commit oid");
  requireText(value.baselineBranchRef, "intent.baselineBranchRef", REF_NAME_MAX);
  requireRef(value.buildTransitionRef, "intent.buildTransitionRef");
  const closure = requireObject(value.closure, CLOSURE_FIELDS, "intent.closure");
  for (const field of CLOSURE_FIELDS) requireRef(closure[field], `intent.closure.${field}`);
  requireLimits(value.limits);
}

function requireFenceShape(fence: CccPlanningWorkItemFence): void {
  if (!fence || typeof fence !== "object" || fence.kind !== "planning" || typeof fence.workItemId !== "string"
    || typeof fence.leaseOwner !== "string" || typeof fence.originTaskId !== "string" || typeof fence.runId !== "string"
    || !Number.isSafeInteger(fence.attempt) || fence.attempt < 1) {
    refuse("CCC_PLANNING_FENCE_STALE", "the import stage publishes under its planning work item fence", "fence");
  }
}

// ---------------------------------------------------------------- anchor, locks and artifacts

function scopeClause(layer: AsyncDataLayer): SQL {
  const projectId = layer.projectId?.trim();
  return projectId ? sql`AND project_id = ${projectId}` : sql``;
}

/** Identity read (no lock) by run id within the layer's bound project, when it has one; the same rule as L1. */
async function locateRun(handle: QueryHandle, layer: AsyncDataLayer, runId: string): Promise<AnchorRow> {
  const found = await rows<AnchorRow>(handle, sql`
    SELECT ${ANCHOR_COLUMNS} FROM project.ccc_planning_runs WHERE run_id = ${runId} ${scopeClause(layer)}
  `);
  if (found.length === 0) refuse("CCC_PLANNING_RUN_NOT_FOUND", `run ${runId} not found`, "runId");
  if (found.length > 1) refuse("CCC_PLANNING_RUN_AMBIGUOUS", `run ${runId} exists in ${found.length} projects`, "runId");
  return found[0]!;
}

/** Task row, then the fenced planning work item, then the anchor (see the header for why this order). */
async function lockRun(tx: DbTransaction, located: AnchorRow, fence: CccPlanningWorkItemFence): Promise<AnchorRow> {
  const task = await rows(tx, sql`
    SELECT id FROM project.tasks WHERE project_id = ${located.project_id} AND id = ${located.planning_task_id} FOR UPDATE
  `);
  if (task.length !== 1) refuse("CCC_PLANNING_RUN_NOT_FOUND", `planning task ${located.planning_task_id} not found`, "runId");
  if (fence.runId !== located.run_id || fence.originTaskId !== located.planning_task_id) {
    refuse("CCC_PLANNING_FENCE_STALE", "the fence does not name this run's planning work item", "fence");
  }
  const item = await rows(tx, sql`
    SELECT id FROM project.workflow_work_items
     WHERE project_id = ${located.project_id} AND id = ${fence.workItemId} AND task_id = ${fence.originTaskId}
       AND run_id = ${fence.runId} AND state = 'running' AND lease_owner = ${fence.leaseOwner}
       AND attempt = ${fence.attempt} AND lease_expires_at IS NOT NULL
       AND lease_expires_at::timestamptz > clock_timestamp()
     FOR UPDATE
  `);
  if (item.length !== 1) refuse("CCC_PLANNING_FENCE_STALE", `work item ${fence.workItemId} lease is not current`, "fence");
  const anchor = await rows<AnchorRow>(tx, sql`
    SELECT ${ANCHOR_COLUMNS} FROM project.ccc_planning_runs
     WHERE project_id = ${located.project_id} AND run_id = ${located.run_id} FOR UPDATE
  `);
  if (anchor.length !== 1) refuse("CCC_PLANNING_RUN_NOT_FOUND", `run ${located.run_id} not found`, "runId");
  return anchor[0]!;
}

function leaseFence(fence: CccPlanningWorkItemFence) {
  return {
    kind: "work_item_lease", workItemId: fence.workItemId, leaseOwner: fence.leaseOwner, attempt: fence.attempt,
    runId: fence.runId,
  } as const;
}

function controllerProducer(importKey: string) {
  return { kind: "controller", roleId: "controller", instanceId: `controller:import:${importKey}` } as const;
}

type StoredArtifact = Readonly<{ ref: CccPlanningArtifactRef; value: unknown }>;

/** Re-hashes the stored text against its envelope digest, then parses it. */
function storedJson(row: { key: string; content: string; content_type: string | null; output_digest: string | null }):
  StoredArtifact {
  if (row.output_digest === null || sha256Hex(row.content) !== row.output_digest) {
    refuse("CCC_PLANNING_ARTIFACT_DIGEST_MISMATCH", `stored text of ${row.key} no longer hashes to its envelope digest`, "content");
  }
  if (row.content_type !== "application/json") {
    refuse("CCC_PLANNING_IMPORT_IDENTITY_DRIFT", `${row.key} is not a JSON artifact`, row.key);
  }
  return { ref: { artifactKey: row.key, digest: row.output_digest }, value: JSON.parse(row.content) as unknown };
}

/** The one published artifact of `kind` for the revision; none, or more than one, is drift. */
async function readImportArtifact(tx: DbTransaction, anchor: AnchorRow, kind: CccPlanningArtifactKind, revision: number):
  Promise<StoredArtifact> {
  const found = await rows<{ key: string; content: string; content_type: string | null; output_digest: string | null }>(tx, sql`
    SELECT key, content, metadata->>'contentType' AS content_type, metadata->>'outputDigest' AS output_digest
      FROM project.task_documents
     WHERE project_id = ${anchor.project_id} AND task_id = ${anchor.planning_task_id} AND key LIKE 'cccplan-%'
       AND metadata->>'kind' = ${kind} AND metadata->>'runRevision' = ${String(revision)}
     ORDER BY key
  `);
  if (found.length !== 1) {
    refuse("CCC_PLANNING_IMPORT_IDENTITY_DRIFT",
      `revision ${revision} of run ${anchor.run_id} has ${found.length} published ${kind} artifacts, not exactly one`, kind);
  }
  return storedJson(found[0]!);
}

function boundsOf(value: unknown): unknown {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Row).bounds : undefined;
}

/** D16: the stored bounds and the intent's must be the same value, compared as canonical JSON. */
function requireSameBounds(kind: string, stored: unknown, expected: object): void {
  let same = false;
  try {
    same = stored !== undefined && canonicalCccPrdJson(stored) === canonicalCccPrdJson(expected);
  } catch {
    same = false;
  }
  if (!same) {
    refuse("CCC_PLANNING_IMPORT_IDENTITY_DRIFT", `the intent's limits differ from the published ${kind} bounds (D16)`, `${kind}.bounds`);
  }
}

function importRevision(anchor: AnchorRow): number {
  const match = IMPORT_KEY_PATTERN.exec(anchor.import_idempotency_key ?? "");
  if (!match) refuse("CCC_PLANNING_INTERNAL_ERROR", `run ${anchor.run_id} has no import key`, "importIdempotencyKey");
  return Number(match[1]);
}

function importArtifactKey(revision: number, slot: "intent" | "receipt"): string {
  return encodeCccPlanningArtifactKey({ runRevision: revision, stageId: "import", slot, version: 1 });
}

async function readSlotRow(handle: QueryHandle, anchor: AnchorRow, key: string) {
  const found = await rows<{ key: string; content: string; content_type: string | null; output_digest: string | null }>(handle, sql`
    SELECT key, content, metadata->>'contentType' AS content_type, metadata->>'outputDigest' AS output_digest
      FROM project.task_documents
     WHERE project_id = ${anchor.project_id} AND task_id = ${anchor.planning_task_id} AND key = ${key}
  `);
  if (found.length !== 1) {
    refuse("CCC_PLANNING_INTERNAL_ERROR", `run ${anchor.run_id} records an import fact but has no ${key} artifact`, key);
  }
  return found[0]!;
}

/** The recorded intent, whose stored bytes must hash to the anchor's intent digest. */
async function readIntent(handle: QueryHandle, anchor: AnchorRow): Promise<Readonly<{ ref: CccPlanningArtifactRef; intent: CccPlanningImportIntentV1 }>> {
  const stored = storedJson(await readSlotRow(handle, anchor, importArtifactKey(importRevision(anchor), "intent")));
  if (stored.ref.digest !== anchor.import_intent_digest) {
    refuse("CCC_PLANNING_ARTIFACT_DIGEST_MISMATCH",
      `${stored.ref.artifactKey} is published at ${stored.ref.digest}, the anchor records ${String(anchor.import_intent_digest)}`, "intent");
  }
  return { ref: stored.ref, intent: stored.value as CccPlanningImportIntentV1 };
}

async function appendEvent(tx: DbTransaction, anchor: AnchorRow, mutationType: CccPlanningAuditMutationType,
  importKey: string, now: string, metadata: Row): Promise<void> {
  await recordRunAuditEventWithinTransaction(tx, {
    timestamp: now, taskId: anchor.planning_task_id, agentId: CONTROLLER_AGENT, runId: anchor.run_id, domain: "database",
    mutationType, target: importKey, metadata,
    eventId: cccPlanningEventId({ projectId: anchor.project_id, runId: anchor.run_id, mutationType, subject: importKey }),
  }, anchor.project_id);
}

function requireImportingBuild(anchor: AnchorRow, what: string): void {
  if (anchor.mode !== "build") callerBug("mode", `only a Build run imports; run ${anchor.run_id} is ${anchor.mode}`);
  if (TERMINAL_STATES.has(anchor.state)) refuse("CCC_PLANNING_RUN_TERMINAL", `run ${anchor.run_id} is ${anchor.state}`, "state");
  if (anchor.state !== "importing") {
    refuse("CCC_PLANNING_STATE_TRANSITION_REFUSED", `${what} is written only while importing; run ${anchor.run_id} is ${anchor.state}`, "state");
  }
}

// ---------------------------------------------------------------- the three operations

/** One tx: require intent.limits deep-equal to the published bundle artifact's bounds and to admission_facts.bounds
 *  (else IMPORT_IDENTITY_DRIFT); CAS anchor importing (intent digest null) with import_intent_digest =
 *  sha256(canonical(intent)) and import_idempotency_key = intent.idempotencyKey; AND publish the import_intent artifact. */
export async function recordCccPlanningImportIntent(layer: AsyncDataLayer, i: Readonly<{
  runId: string; intent: CccPlanningImportIntentV1; fence: CccPlanningWorkItemFence;
  hooks?: Readonly<{ beforeArtifact?: () => Promise<void> }> }>): Promise<Readonly<{ intentDigest: string; replayed: boolean }>> {
  const runId = requireRunId(i.runId);
  requireIntent(runId, i.intent);
  requireFenceShape(i.fence);
  const intent = i.intent;
  const intentDigest = sha256Hex(canonicalCccPrdJson(intent));
  const importKey = intent.idempotencyKey;

  return inTransaction(layer, async (tx) => {
    const anchor = await lockRun(tx, await locateRun(tx, layer, runId), i.fence);

    // Write-once: the same intent replays; any other digest is refused before anything is read or written.
    if (anchor.import_intent_digest !== null) {
      if (anchor.import_intent_digest === intentDigest && anchor.import_idempotency_key === importKey) {
        return { intentDigest, replayed: true };
      }
      refuse("CCC_PLANNING_IMPORT_LINK_WRITE_ONCE",
        `run ${anchor.run_id} already recorded import intent ${anchor.import_intent_digest}`, "intent");
    }
    requireImportingBuild(anchor, "an import intent");
    if (intent.runRevision !== anchor.revision) {
      refuse("CCC_PLANNING_REVISION_STALE", `the intent is for revision ${intent.runRevision}, the run is at ${anchor.revision}`, "intent.runRevision");
    }
    if (intent.receiptSha256 !== anchor.authority_receipt_sha256) {
      callerBug("intent.receiptSha256", "the intent names another authority receipt than the one the run consumed");
    }
    const transferable = Math.min(anchor.implementation_allocation, CCC_PRD_IMPORT_MAX_REQUESTS);
    if (intent.limits.maxRequests > transferable) {
      callerBug("intent.limits.maxRequests", `maxRequests ${intent.limits.maxRequests} exceeds min(implementation allocation, 10000) = ${transferable} (D16)`);
    }

    // D16: the bounds were computed once and stored; the intent may only repeat them.
    const facts = await readImportArtifact(tx, anchor, "admission_facts", intent.runRevision);
    const bundle = await readImportArtifact(tx, anchor, "bundle", intent.runRevision);
    requireSameBounds("admission_facts", boundsOf(facts.value), intent.limits);
    requireSameBounds("bundle", boundsOf(bundle.value), {
      maxRequests: intent.limits.maxRequests, maxDurationMs: intent.limits.maxDurationMs,
      maxConcurrency: intent.limits.maxConcurrency,
    });

    const now = await databaseNow(tx);
    const updated = await rows(tx, sql`
      UPDATE project.ccc_planning_runs
         SET import_intent_digest = ${intentDigest}, import_idempotency_key = ${importKey},
             updated_at = ${nextUpdatedAt(anchor.updated_at, now)}
       WHERE project_id = ${anchor.project_id} AND run_id = ${anchor.run_id} AND state = 'importing'
         AND import_intent_digest IS NULL
      RETURNING run_id
    `);
    if (updated.length !== 1) {
      refuse("CCC_PLANNING_STATE_TRANSITION_REFUSED", `run ${anchor.run_id} left importing before its intent was recorded`, "state");
    }
    // The hook runs between the anchor CAS and the artifact, inside the same transaction (the atomicity test's seam).
    if (i.hooks?.beforeArtifact) await i.hooks.beforeArtifact();

    const published = await publishCccPlanningArtifactWithinTransaction(tx, anchor.project_id, {
      planningTaskId: anchor.planning_task_id, runId: anchor.run_id,
      slot: { runRevision: intent.runRevision, stageId: "import", slot: "intent", version: 1 }, kind: "import_intent",
      contentSchema: INTENT_SCHEMA, content: { type: "json", value: intent }, inputs: [facts.ref, bundle.ref],
      producer: controllerProducer(importKey), policy: NO_POLICY, status: "complete", fence: leaseFence(i.fence), now,
    });
    if (published.envelope.outputDigest !== intentDigest) {
      refuse("CCC_PLANNING_ARTIFACT_DIGEST_MISMATCH",
        `${published.key} is published at ${published.envelope.outputDigest}, not the intent digest ${intentDigest}`, "intent");
    }
    await appendEvent(tx, anchor, "ccc-planning:import-intent", importKey, now, {
      schema: "ccc-planning-import-intent/v1", runId: anchor.run_id, revision: intent.runRevision, importKey, intentDigest,
      bundleHash: intent.bundleHash, artifactKey: published.key, maxRequests: intent.limits.maxRequests,
      maxDurationMs: intent.limits.maxDurationMs,
    });
    return { intentDigest, replayed: false };
  });
}

/** One tx: read ccc_prd_imports by idempotency key, require bundle hash = intent, set import_id and
 *  implementation_transferred, publish import_receipt. State moves to building or awaiting_execution_authority later (AU2). */
export async function linkCccPlanningImport(layer: AsyncDataLayer, i: Readonly<{
  runId: string; fence: CccPlanningWorkItemFence; release: CccPlanningImportReceiptV1["release"] }>): Promise<CccPlanningImportReceiptV1> {
  const runId = requireRunId(i.runId);
  if (!RELEASES.has(i.release)) callerBug("release", "release must be released, awaiting_operator or not_applicable");
  requireFenceShape(i.fence);

  return inTransaction(layer, async (tx) => {
    const anchor = await lockRun(tx, await locateRun(tx, layer, runId), i.fence);
    if (anchor.import_intent_digest === null) {
      callerBug("intent", `run ${anchor.run_id} has no import intent; it is recorded before the importer runs (D17)`);
    }
    const importKey = anchor.import_idempotency_key!;
    const { ref: intentRef, intent } = await readIntent(tx, anchor);
    const imported = await rows<{ import_id: string; bundle_hash: string }>(tx, sql`
      SELECT import_id, bundle_hash FROM project.ccc_prd_imports
       WHERE project_id = ${anchor.project_id} AND idempotency_key = ${importKey}
       FOR SHARE
    `);
    if (imported.length !== 1) {
      callerBug("importId", `no ccc_prd_imports row for ${importKey}; the link follows a committed import`);
    }
    const row = imported[0]!;
    if (row.bundle_hash !== intent.bundleHash) {
      refuse("CCC_PLANNING_IMPORT_IDENTITY_DRIFT",
        `import ${row.import_id} holds bundle ${row.bundle_hash}, the intent names ${intent.bundleHash}`, "bundleHash");
    }
    const linkedBefore = anchor.import_id !== null;
    if (linkedBefore && anchor.import_id !== row.import_id) {
      refuse("CCC_PLANNING_IMPORT_LINK_WRITE_ONCE", `run ${anchor.run_id} is linked to import ${anchor.import_id}`, "importId");
    }
    if (!linkedBefore) requireImportingBuild(anchor, "the import link");

    const receipt: CccPlanningImportReceiptV1 = {
      schema: RECEIPT_SCHEMA, runId: anchor.run_id, runRevision: intent.runRevision, idempotencyKey: importKey,
      importId: row.import_id, bundleHash: intent.bundleHash, intentDigest: anchor.import_intent_digest,
      implementationTransferred: intent.limits.maxRequests, maxDurationMs: intent.limits.maxDurationMs, replayed: false,
      release: i.release,
    };
    const now = await databaseNow(tx);
    if (!linkedBefore) {
      const updated = await rows(tx, sql`
        UPDATE project.ccc_planning_runs
           SET import_id = ${row.import_id}, implementation_transferred = ${receipt.implementationTransferred},
               updated_at = ${nextUpdatedAt(anchor.updated_at, now)}
         WHERE project_id = ${anchor.project_id} AND run_id = ${anchor.run_id} AND import_id IS NULL
           AND import_intent_digest = ${anchor.import_intent_digest}
        RETURNING run_id
      `);
      if (updated.length !== 1) {
        refuse("CCC_PLANNING_STATE_TRANSITION_REFUSED", `run ${anchor.run_id} changed before its import was linked`, "importId");
      }
    }
    // A replay re-publishes the same receipt (A1 replays it); a different release is A1's SLOT_CONFLICT.
    const published = await publishCccPlanningArtifactWithinTransaction(tx, anchor.project_id, {
      planningTaskId: anchor.planning_task_id, runId: anchor.run_id,
      slot: { runRevision: intent.runRevision, stageId: "import", slot: "receipt", version: 1 }, kind: "import_receipt",
      contentSchema: RECEIPT_SCHEMA, content: { type: "json", value: receipt }, inputs: [intentRef],
      producer: controllerProducer(importKey), policy: NO_POLICY, status: "complete", fence: leaseFence(i.fence), now,
    });
    if (linkedBefore) return { ...receipt, replayed: true };
    await appendEvent(tx, anchor, "ccc-planning:import-linked", importKey, now, {
      schema: "ccc-planning-import-linked/v1", runId: anchor.run_id, revision: intent.runRevision, importKey,
      importId: row.import_id, intentDigest: anchor.import_intent_digest, bundleHash: intent.bundleHash,
      implementationTransferred: receipt.implementationTransferred, release: i.release, artifactKey: published.key,
    });
    return receipt;
  });
}

/** none before the intent; intent-only between the intent and the link (the bridge's RECONCILE signal); linked after. */
export async function inspectCccPlanningImportLink(layer: AsyncDataLayer, runId: string):
  Promise<Readonly<{ kind: "none" } | { kind: "intent-only"; intent: CccPlanningImportIntentV1 } | { kind: "linked"; receipt: CccPlanningImportReceiptV1 }>> {
  requireRunId(runId);
  try {
    const anchor = await locateRun(layer.db, layer, runId);
    if (anchor.import_intent_digest === null) return { kind: "none" };
    if (anchor.import_id === null) return { kind: "intent-only", intent: (await readIntent(layer.db, anchor)).intent };
    const stored = storedJson(await readSlotRow(layer.db, anchor, importArtifactKey(importRevision(anchor), "receipt")));
    const receipt = stored.value as CccPlanningImportReceiptV1;
    if (receipt.importId !== anchor.import_id || receipt.intentDigest !== anchor.import_intent_digest) {
      refuse("CCC_PLANNING_IMPORT_IDENTITY_DRIFT",
        `${stored.ref.artifactKey} names import ${receipt.importId}, the anchor is linked to ${anchor.import_id}`, "receipt");
    }
    return { kind: "linked", receipt };
  } catch (error) {
    throw mapDatabaseError(error);
  }
}
