import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import * as schema from "../postgres/schema/index.js";
import {
  projectOwnershipPartition,
  recordRunAuditEventWithinTransaction,
  type AsyncDataLayer,
  type DbTransaction,
} from "../postgres/data-layer.js";
import {
  CCC_PLANNING_ARTIFACT_ENVELOPE_SCHEMA,
  CCC_PLANNING_ARTIFACT_KEY_PREFIX,
  CCC_PLANNING_STAGE_KINDS,
  computeCccPlanningEnvelopeIdentityDigest,
  decodeCccPlanningArtifactKey,
  encodeCccPlanningArtifactContent,
  encodeCccPlanningArtifactKey,
  type CccPlanningArtifactContent,
  type CccPlanningArtifactEnvelopeV1,
  type CccPlanningArtifactKind,
  type CccPlanningArtifactPolicy,
  type CccPlanningArtifactProducer,
  type CccPlanningArtifactRef,
  type CccPlanningArtifactSlot,
  type CccPlanningArtifactStatus,
  type CccPlanningPublicationFence,
} from "../ccc-planning/artifacts.js";
import { CccPlanningRefusal, cccPlanningRefusalFromDatabaseError } from "../ccc-planning/errors.js";
import { CCC_PLANNING_RUN_ID_PATTERN } from "../ccc-planning/marker.js";
import { cccPlanningEventId } from "../ccc-planning/policy.js";

/*
FNXC:CccPlanningArtifacts 2026-10-14-13:42:
Publish, read, list and resolve immutable request-to-code planning artifacts (CONTRACT-v3 section 2.6, decision D6). An artifact is a task document under the reserved `cccplan-` key prefix, written once through this module and guarded by trigger 0043, which refuses any other writer through the publisher flag `fusion.ccc_planning_publication`. Publication is one transaction in the contract's order: validate and encode, lock the task row, lock the fence's work item, replay or refuse a taken key, verify the inputs, raise the flag, insert, drop the flag, audit. Two decisions are worth stating where the code is:
- The flag is raised and dropped inside a savepoint, so a refusal or a failure rolls the flag back with the insert, and a shared transaction stays usable and never keeps the flag on for a later raw `cccplan-` insert (the reset case in the A1 tests).
- A replay writes no second audit event. The deterministic event id would collide on a changed fence, and the first publication already committed its event in the same transaction as its row.
*/

const PUBLICATION_FLAG = "fusion.ccc_planning_publication";
const PUBLISHED_EVENT = "ccc-planning:artifact-published" as const;
const CONTROLLER_AGENT_ID = "ccc-planning-controller";
const KEY_UNIQUE_CONSTRAINT = "task_documents_task_id_key_unique";
const MAX_CAUSE_DEPTH = 4;
const HEX64 = /^[0-9a-f]{64}$/u;
const ROLE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const CONTENT_SCHEMA = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const ISO_INSTANT = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?Z$/u;
const FIELD_MAX = 256;
const STATUSES: ReadonlySet<string> = new Set<CccPlanningArtifactStatus>(["complete", "infeasible", "blocked", "refused"]);

export type PublishCccPlanningArtifactInput = Readonly<{
  planningTaskId: string; runId: string; slot: CccPlanningArtifactSlot; kind: CccPlanningArtifactKind;
  contentSchema: string; content: CccPlanningArtifactContent; inputs: readonly CccPlanningArtifactRef[];
  producer: CccPlanningArtifactProducer; policy: CccPlanningArtifactPolicy; status: CccPlanningArtifactStatus;
  fence: CccPlanningPublicationFence; now?: string;
}>;
export type CccPlanningArtifactRecord = Readonly<{ id: string; key: string; envelope: CccPlanningArtifactEnvelopeV1; replayed: boolean }>;

type TaskDocuments = typeof schema.project.taskDocuments;

function invalid(detail: string, field: string): CccPlanningRefusal {
  return new CccPlanningRefusal("CCC_PLANNING_ARTIFACT_ENVELOPE_INVALID", detail, field);
}

function compareKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function nonEmptyString(value: unknown, field: string, max = FIELD_MAX): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || value !== value.trim()) {
    throw invalid(`${field} must be a trimmed non-empty string of at most ${max} characters`, field);
  }
  return value;
}

function positiveInteger(value: unknown, field: string, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max) {
    throw invalid(`${field} must be an integer from 1 to ${max}`, field);
  }
  return value;
}

/** Sorted by key, duplicates removed; one key with two digests is a digest mismatch, not a silent pick. */
function normalizeInputs(inputs: readonly CccPlanningArtifactRef[], ownKey: string): CccPlanningArtifactRef[] {
  if (!Array.isArray(inputs)) throw invalid("inputs must be an array", "inputs");
  const byKey = new Map<string, string>();
  for (const input of inputs) {
    const artifactKey = nonEmptyString(input?.artifactKey, "inputs.artifactKey");
    if (decodeCccPlanningArtifactKey(artifactKey) === null) {
      throw invalid(`input ${JSON.stringify(artifactKey)} is not a planning artifact key`, "inputs.artifactKey");
    }
    if (artifactKey === ownKey) throw invalid(`artifact ${ownKey} cannot take itself as an input`, "inputs.artifactKey");
    if (typeof input.digest !== "string" || !HEX64.test(input.digest)) {
      throw invalid(`input ${artifactKey} digest must be 64 lowercase hex characters`, "inputs.digest");
    }
    const seen = byKey.get(artifactKey);
    if (seen !== undefined && seen !== input.digest) {
      throw new CccPlanningRefusal("CCC_PLANNING_ARTIFACT_DIGEST_MISMATCH",
        `input ${artifactKey} is named with two digests ${seen} and ${input.digest}`, "inputs");
    }
    byKey.set(artifactKey, input.digest);
  }
  return [...byKey.entries()].sort(([left], [right]) => compareKeys(left, right)).map(([artifactKey, digest]) => ({ artifactKey, digest }));
}

function normalizeProducer(producer: CccPlanningArtifactProducer): CccPlanningArtifactProducer {
  if (producer === null || typeof producer !== "object") throw invalid("producer is required", "producer");
  if (producer.kind !== "model" && producer.kind !== "controller" && producer.kind !== "operator") {
    throw invalid("producer.kind must be model, controller or operator", "producer.kind");
  }
  const roleId = nonEmptyString(producer.roleId, "producer.roleId", 64);
  if (!ROLE_ID.test(roleId)) throw invalid(`producer.roleId ${JSON.stringify(roleId)} is not a role id`, "producer.roleId");
  const instanceId = nonEmptyString(producer.instanceId, "producer.instanceId");
  const optional = (value: unknown, field: string): string | undefined =>
    value === undefined ? undefined : nonEmptyString(value, field);
  const attemptRef = optional(producer.attemptRef, "producer.attemptRef");
  const requestedModel = optional(producer.requestedModel, "producer.requestedModel");
  const resolvedModel = optional(producer.resolvedModel, "producer.resolvedModel");
  const routeReceiptDigest = optional(producer.routeReceiptDigest, "producer.routeReceiptDigest");
  if (producer.kind === "model") {
    if (requestedModel === undefined || resolvedModel === undefined || routeReceiptDigest === undefined) {
      throw invalid("a model producer needs requestedModel, resolvedModel and routeReceiptDigest", "producer");
    }
    if (!HEX64.test(routeReceiptDigest)) throw invalid("producer.routeReceiptDigest must be 64 lowercase hex characters", "producer.routeReceiptDigest");
  }
  if (producer.kind === "controller" && roleId !== "controller") throw invalid("a controller producer has roleId controller", "producer.roleId");
  if (producer.kind === "operator" && (roleId !== "operator" || !instanceId.startsWith("operator:"))) {
    throw invalid("an operator producer has roleId operator and an instanceId of operator:<controlSeq>", "producer");
  }
  return {
    kind: producer.kind, roleId: roleId as CccPlanningArtifactProducer["roleId"], instanceId,
    ...(attemptRef === undefined ? {} : { attemptRef }),
    ...(requestedModel === undefined ? {} : { requestedModel: requestedModel as CccPlanningArtifactProducer["requestedModel"] }),
    ...(resolvedModel === undefined ? {} : { resolvedModel }),
    ...(routeReceiptDigest === undefined ? {} : { routeReceiptDigest }),
  };
}

function normalizePolicy(policy: CccPlanningArtifactPolicy): CccPlanningArtifactPolicy {
  if (policy === null || typeof policy !== "object") throw invalid("policy is required", "policy");
  return {
    promptVersion: nonEmptyString(policy.promptVersion, "policy.promptVersion"),
    promptDigest: nonEmptyString(policy.promptDigest, "policy.promptDigest"),
    toolPolicyVersion: nonEmptyString(policy.toolPolicyVersion, "policy.toolPolicyVersion"),
    toolPolicyDigest: nonEmptyString(policy.toolPolicyDigest, "policy.toolPolicyDigest"),
  };
}

/** Keeps only the declared keys of each fence kind, so the stored fence is canonical whatever the caller passed. */
function normalizeFence(fence: CccPlanningPublicationFence): CccPlanningPublicationFence {
  if (fence === null || typeof fence !== "object") throw invalid("fence is required", "fence");
  switch (fence.kind) {
    case "admission":
      return { kind: "admission" };
    case "work_item_lease":
      return {
        kind: "work_item_lease", workItemId: nonEmptyString(fence.workItemId, "fence.workItemId"),
        leaseOwner: nonEmptyString(fence.leaseOwner, "fence.leaseOwner"), attempt: positiveInteger(fence.attempt, "fence.attempt"),
        runId: nonEmptyString(fence.runId, "fence.runId"),
      };
    case "campaign_work_item_lease": {
      const runId = nonEmptyString(fence.runId, "fence.runId");
      if (!runId.startsWith("ccc-prd:")) throw invalid("a campaign fence names the campaign run ccc-prd:<import_id>", "fence.runId");
      return {
        kind: "campaign_work_item_lease", workItemId: nonEmptyString(fence.workItemId, "fence.workItemId"),
        leaseOwner: nonEmptyString(fence.leaseOwner, "fence.leaseOwner"), attempt: positiveInteger(fence.attempt, "fence.attempt"),
        runId: runId as `ccc-prd:${string}`,
      };
    }
    case "operator": {
      const controlSeq = (fence as { controlSeq: unknown }).controlSeq;
      if (typeof controlSeq !== "number" || !Number.isSafeInteger(controlSeq) || controlSeq < 0) {
        throw invalid("fence.controlSeq must be a non-negative integer", "fence.controlSeq");
      }
      return { kind: "operator", runRevision: positiveInteger((fence as { runRevision: unknown }).runRevision, "fence.runRevision", 999), controlSeq };
    }
    default:
      throw invalid("fence.kind must be admission, work_item_lease, campaign_work_item_lease or operator", "fence.kind");
  }
}

type PreparedArtifact = Readonly<{
  key: string; text: string; envelope: CccPlanningArtifactEnvelopeV1; fence: CccPlanningPublicationFence;
}>;

/** Step 1: validate and encode. Nothing here touches the database. */
function prepareArtifact(input: PublishCccPlanningArtifactInput): PreparedArtifact {
  nonEmptyString(input.planningTaskId, "planningTaskId");
  if (typeof input.runId !== "string" || !CCC_PLANNING_RUN_ID_PATTERN.test(input.runId)) {
    throw invalid("runId must be ccc-plan:<24 hex>", "runId");
  }
  const key = encodeCccPlanningArtifactKey(input.slot);
  const allowed = CCC_PLANNING_STAGE_KINDS[input.slot.stageId];
  if (!allowed.includes(input.kind)) {
    throw invalid(`kind ${JSON.stringify(input.kind)} cannot be published at stage ${input.slot.stageId}`, "kind");
  }
  if (!STATUSES.has(input.status)) throw invalid("status must be complete, infeasible, blocked or refused", "status");
  if (typeof input.contentSchema !== "string" || !CONTENT_SCHEMA.test(input.contentSchema)) {
    throw invalid("contentSchema must be a schema identifier such as ccc-planning.requirement-map.v1", "contentSchema");
  }
  const publishedAt = input.now ?? new Date().toISOString();
  if (typeof publishedAt !== "string" || !ISO_INSTANT.test(publishedAt)) throw invalid("now must be an ISO-8601 UTC instant", "now");
  const encoded = encodeCccPlanningArtifactContent(input.content);
  const inputs = normalizeInputs(input.inputs, key);
  const producer = normalizeProducer(input.producer);
  const policy = normalizePolicy(input.policy);
  const fence = normalizeFence(input.fence);
  const identity = {
    schema: CCC_PLANNING_ARTIFACT_ENVELOPE_SCHEMA, artifactKey: key, runId: input.runId, runRevision: input.slot.runRevision,
    stageId: input.slot.stageId, slot: input.slot.slot, version: input.slot.version, kind: input.kind,
    contentType: encoded.contentType, contentSchema: input.contentSchema, inputs, producer, policy,
    outputDigest: encoded.outputDigest, status: input.status,
  } as const;
  const envelope: CccPlanningArtifactEnvelopeV1 = {
    ...identity, fence, identityDigest: computeCccPlanningEnvelopeIdentityDigest(identity), publishedAt,
  };
  return { key, text: encoded.text, envelope, fence };
}

function causeChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current: unknown = error;
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH && current !== undefined && current !== null; depth += 1) {
    chain.push(current);
    current = (current as { cause?: unknown }).cause;
  }
  return chain;
}

/** A unique violation of the (project, task, key) document key: another publisher took the slot first. */
function isKeyUniqueViolation(error: unknown): boolean {
  return causeChain(error).some((link) => {
    const candidate = link as { code?: unknown; constraint_name?: unknown };
    return candidate.code === "23505" && candidate.constraint_name === KEY_UNIQUE_CONSTRAINT;
  });
}

/** The stored envelope, shape-checked just enough to trust the fields this module reads. */
function storedEnvelope(row: { key: string; metadata: unknown }): CccPlanningArtifactEnvelopeV1 {
  const metadata = row.metadata as Record<string, unknown> | null;
  if (
    metadata === null || typeof metadata !== "object" || Array.isArray(metadata)
    || metadata.schema !== CCC_PLANNING_ARTIFACT_ENVELOPE_SCHEMA || metadata.artifactKey !== row.key
    || typeof metadata.outputDigest !== "string" || typeof metadata.identityDigest !== "string"
  ) {
    throw invalid(`stored artifact ${row.key} has no valid envelope`, "envelope");
  }
  return metadata as unknown as CccPlanningArtifactEnvelopeV1;
}

function recordFromRow(row: { id: string; key: string; metadata: unknown }, replayed = false): CccPlanningArtifactRecord {
  return { id: row.id, key: row.key, envelope: storedEnvelope(row), replayed };
}

async function readSlot(tx: DbTransaction, projectId: string, taskId: string, key: string) {
  const documents: TaskDocuments = schema.project.taskDocuments;
  const rows = await tx.select({ id: documents.id, key: documents.key, metadata: documents.metadata }).from(documents).where(and(
    eq(documents.projectId, projectId), eq(documents.taskId, taskId), eq(documents.key, key),
  )).limit(1);
  return rows[0];
}

/** An existing key is the same artifact only when its identity digest matches; otherwise the slot is taken. */
function replayOrConflict(
  row: { id: string; key: string; metadata: unknown }, prepared: PreparedArtifact,
): CccPlanningArtifactRecord {
  const stored = storedEnvelope(row);
  if (stored.identityDigest === prepared.envelope.identityDigest) return recordFromRow(row, true);
  throw new CccPlanningRefusal("CCC_PLANNING_ARTIFACT_SLOT_CONFLICT",
    `artifact ${prepared.key} is already published with a different identity`, "slot");
}

/** Step 3: hold the fence's work item for the rest of the transaction, so the lease cannot move under the insert. */
async function lockFenceWorkItem(
  tx: DbTransaction, projectId: string, planningTaskId: string, fence: CccPlanningPublicationFence,
): Promise<void> {
  if (fence.kind !== "work_item_lease" && fence.kind !== "campaign_work_item_lease") return;
  const items = schema.project.workflowWorkItems;
  const conditions = [
    eq(items.projectId, projectId), eq(items.id, fence.workItemId), eq(items.runId, fence.runId), eq(items.state, "running"),
    eq(items.leaseOwner, fence.leaseOwner), eq(items.attempt, fence.attempt),
    sql`${items.leaseExpiresAt} IS NOT NULL AND ${items.leaseExpiresAt}::timestamptz > clock_timestamp()`,
  ];
  if (fence.kind === "work_item_lease") conditions.push(eq(items.taskId, planningTaskId));
  const rows = await tx.select({ id: items.id }).from(items).where(and(...conditions)).limit(1).for("update");
  if (rows.length !== 1) {
    throw new CccPlanningRefusal("CCC_PLANNING_ARTIFACT_FENCE_REFUSED",
      `work item ${fence.workItemId} does not hold a live lease for this publication`, "fence");
  }
}

/** Step 5: every input is already a published planning artifact of this task, at the named digest. */
async function verifyInputsPublished(
  tx: DbTransaction, projectId: string, taskId: string, inputs: readonly CccPlanningArtifactRef[],
): Promise<void> {
  if (inputs.length === 0) return;
  const documents: TaskDocuments = schema.project.taskDocuments;
  const rows = await tx.select({ key: documents.key, digest: sql<string | null>`${documents.metadata}->>'outputDigest'` })
    .from(documents).where(and(
      eq(documents.projectId, projectId), eq(documents.taskId, taskId),
      inArray(documents.key, inputs.map((input) => input.artifactKey)),
    ));
  const published = new Map(rows.map((row) => [row.key, row.digest]));
  for (const input of inputs) {
    if (published.get(input.artifactKey) !== input.digest) {
      throw new CccPlanningRefusal("CCC_PLANNING_ARTIFACT_INPUT_UNPUBLISHED",
        `${input.artifactKey} is not published at ${input.digest}`, "inputs");
    }
  }
}

export async function publishCccPlanningArtifact(
  layer: AsyncDataLayer, input: PublishCccPlanningArtifactInput,
): Promise<CccPlanningArtifactRecord> {
  const projectId = projectOwnershipPartition(layer.projectId);
  return layer.transactionImmediate((tx) => publishCccPlanningArtifactWithinTransaction(tx, projectId, input));
}

export async function publishCccPlanningArtifactWithinTransaction(
  tx: DbTransaction, projectId: string, input: PublishCccPlanningArtifactInput,
): Promise<CccPlanningArtifactRecord> {
  const prepared = prepareArtifact(input);
  const { key, envelope } = prepared;
  const tasks = schema.project.tasks;
  const documents: TaskDocuments = schema.project.taskDocuments;

  // Step 2: serialise every publisher of this task, and any archive or delete of it.
  const taskRows = await tx.select({ id: tasks.id }).from(tasks)
    .where(and(eq(tasks.projectId, projectId), eq(tasks.id, input.planningTaskId))).limit(1).for("update");
  if (taskRows.length !== 1) {
    throw new CccPlanningRefusal("CCC_PLANNING_RUN_NOT_FOUND", `no planning task ${input.planningTaskId} in this project`, "planningTaskId");
  }
  await lockFenceWorkItem(tx, projectId, input.planningTaskId, prepared.fence);

  // Step 4: a taken key replays when the identity matches and is a slot conflict when it does not.
  const taken = await readSlot(tx, projectId, input.planningTaskId, key);
  if (taken) return replayOrConflict(taken, prepared);

  await verifyInputsPublished(tx, projectId, input.planningTaskId, envelope.inputs);

  // Steps 6 to 8 sit in one savepoint: the flag is on only for the insert, and any failure takes the flag back with it.
  const id = randomUUID();
  try {
    await tx.transaction(async (insertScope) => {
      await insertScope.execute(sql`SELECT set_config(${PUBLICATION_FLAG}, 'on', true)`);
      await insertScope.insert(documents).values({
        projectId, id, taskId: input.planningTaskId, key, content: prepared.text, revision: 1,
        author: `ccc-planning:${envelope.producer.roleId}`, metadata: envelope,
        createdAt: envelope.publishedAt, updatedAt: envelope.publishedAt,
      });
      await insertScope.execute(sql`SELECT set_config(${PUBLICATION_FLAG}, '', true)`);
    });
  } catch (error) {
    if (isKeyUniqueViolation(error)) {
      // Another connection took the slot between the read and the insert. The savepoint is rolled back, so re-read.
      const winner = await readSlot(tx, projectId, input.planningTaskId, key);
      if (winner) return replayOrConflict(winner, prepared);
      throw new CccPlanningRefusal("CCC_PLANNING_ARTIFACT_SLOT_CONFLICT",
        `artifact ${key} was taken by a concurrent publication that this snapshot cannot read`, "slot");
    }
    throw cccPlanningRefusalFromDatabaseError(error) ?? error;
  }

  // Step 9: one deterministic event per key; the record and its event commit or roll back together.
  await recordRunAuditEventWithinTransaction(tx, {
    taskId: input.planningTaskId,
    agentId: CONTROLLER_AGENT_ID,
    runId: input.runId,
    domain: "database",
    mutationType: PUBLISHED_EVENT,
    target: key,
    timestamp: envelope.publishedAt,
    eventId: cccPlanningEventId({ projectId, runId: input.runId, mutationType: PUBLISHED_EVENT, subject: key }),
    metadata: {
      artifactKey: key, kind: envelope.kind, stageId: envelope.stageId, slot: envelope.slot, version: envelope.version,
      runRevision: envelope.runRevision, status: envelope.status, outputDigest: envelope.outputDigest,
      identityDigest: envelope.identityDigest, producerKind: envelope.producer.kind, producerRoleId: envelope.producer.roleId,
      fenceKind: envelope.fence.kind, inputCount: envelope.inputs.length,
    },
  }, projectId);
  return { id, key, envelope, replayed: false };
}

/**
 * Reads one planning artifact with its stored text. The text is re-hashed against the envelope's `outputDigest` on every
 * read, so storage drift is a DIGEST_MISMATCH even when the caller names no digest; `expectedDigest` is the caller's own
 * pin (an input ref's digest). A key that is not a planning key is refused, and an absent planning key is null.
 */
export async function readCccPlanningArtifact(
  layer: AsyncDataLayer, planningTaskId: string, key: string, options?: Readonly<{ expectedDigest?: string }>,
): Promise<Readonly<{ record: CccPlanningArtifactRecord; text: string }> | null> {
  if (decodeCccPlanningArtifactKey(key) === null) {
    throw invalid(`${JSON.stringify(key)} is not a planning artifact key`, "key");
  }
  const documents: TaskDocuments = schema.project.taskDocuments;
  const rows = await layer.db.select({ id: documents.id, key: documents.key, content: documents.content, metadata: documents.metadata })
    .from(documents).where(and(
      eq(documents.projectId, projectOwnershipPartition(layer.projectId)),
      eq(documents.taskId, planningTaskId), eq(documents.key, key),
    )).limit(1);
  const row = rows[0];
  if (!row) return null;
  const record = recordFromRow(row);
  if (sha256Text(row.content) !== record.envelope.outputDigest) {
    throw new CccPlanningRefusal("CCC_PLANNING_ARTIFACT_DIGEST_MISMATCH",
      `stored text of ${key} no longer hashes to its envelope digest`, "content");
  }
  if (options?.expectedDigest !== undefined && options.expectedDigest !== record.envelope.outputDigest) {
    throw new CccPlanningRefusal("CCC_PLANNING_ARTIFACT_DIGEST_MISMATCH",
      `${key} is published at ${record.envelope.outputDigest}, not the expected ${options.expectedDigest}`, "expectedDigest");
  }
  return { record, text: row.content };
}

async function readPlanningRows(layer: AsyncDataLayer, planningTaskId: string) {
  const documents: TaskDocuments = schema.project.taskDocuments;
  const rows = await layer.db.select({ id: documents.id, key: documents.key, metadata: documents.metadata })
    .from(documents).where(and(
      eq(documents.projectId, projectOwnershipPartition(layer.projectId)),
      eq(documents.taskId, planningTaskId), like(documents.key, `${CCC_PLANNING_ARTIFACT_KEY_PREFIX}%`),
    ));
  // Sorted by code unit here, not by the database collation, so the order is the same on every cluster.
  return rows.sort((left, right) => compareKeys(left.key, right.key));
}

/** Every planning artifact of the task, in key order. Ordinary task documents are not listed. */
export async function listCccPlanningArtifacts(layer: AsyncDataLayer, planningTaskId: string): Promise<readonly CccPlanningArtifactRecord[]> {
  return (await readPlanningRows(layer, planningTaskId)).map((row) => recordFromRow(row));
}

/**
 * The transitive input closure of `roots`, the roots included, sorted by key and unique. It is the same closure that
 * trigger 0043 walks for the design seal. An unknown root is INPUT_UNPUBLISHED and a root named at the wrong digest is
 * DIGEST_MISMATCH, as is any stored input whose digest disagrees with the artifact it names.
 */
export async function resolveCccPlanningInputClosure(
  layer: AsyncDataLayer, planningTaskId: string, roots: readonly CccPlanningArtifactRef[],
): Promise<readonly CccPlanningArtifactRef[]> {
  if (roots.length === 0) return [];
  const stored = new Map<string, CccPlanningArtifactEnvelopeV1>();
  for (const row of await readPlanningRows(layer, planningTaskId)) stored.set(row.key, storedEnvelope(row));

  const closure = new Map<string, string>();
  const pending: CccPlanningArtifactRef[] = [...roots];
  while (pending.length > 0) {
    const ref = pending.pop()!;
    const envelope = stored.get(ref.artifactKey);
    if (!envelope) {
      throw new CccPlanningRefusal("CCC_PLANNING_ARTIFACT_INPUT_UNPUBLISHED", `${ref.artifactKey} is not published on this task`, "roots");
    }
    if (envelope.outputDigest !== ref.digest) {
      throw new CccPlanningRefusal("CCC_PLANNING_ARTIFACT_DIGEST_MISMATCH",
        `${ref.artifactKey} is published at ${envelope.outputDigest}, not ${ref.digest}`, "roots");
    }
    if (closure.has(ref.artifactKey)) continue;
    closure.set(ref.artifactKey, envelope.outputDigest);
    pending.push(...envelope.inputs);
  }
  return [...closure.entries()].sort(([left], [right]) => compareKeys(left, right)).map(([artifactKey, digest]) => ({ artifactKey, digest }));
}
