/**
 * Async Drizzle ApprovalRequestStore helpers (U6 satellite-db-injected-stores).
 *
 * FNXC:ApprovalRequestStore 2026-06-24-07:30:
 * Async equivalents of the sync SQLite ApprovalRequestStore call sites in
 * approval-request-store.ts. These helpers target the PostgreSQL
 * `project.approval_requests` and `project.approval_request_audit_events`
 * tables via Drizzle.
 *
 * SQLite → PostgreSQL notes (VAL-SCHEMA-004):
 *   The `targetContext` column is jsonb in PostgreSQL, so Drizzle returns it
 *   already-parsed as a JS value. The audit-event insert and the status update
 *   run in a single transaction so the audit row commits/rolls back atomically
 *   with the state transition (matching the sync transactionImmediate pattern).
 *
 * Transition context (see library/satellite-store-migration-pattern.md):
 *   `getDatabase()` still returns the sync `Database` until the coordinated
 *   flip. These helpers are the async target the PostgreSQL integration tests
 *   consume.
 */
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { and, desc, eq, sql } from "drizzle-orm";
import { assertCccCampaignAuthorityBinding, createCccCampaignAuthorityBinding } from "./ccc-campaign/canonical.js";
import type { CccCampaignAuthorityStore } from "./ccc-campaign/store.js";
import type { CccCampaignActionLookup, CccCampaignAuthorityBinding, CccCampaignContext } from "./ccc-campaign/types.js";
import { canonicalCccPrdJson } from "./ccc-prd/contract.js";
import * as schema from "./postgres/schema/index.js";
import { recordRunAuditEventWithinTransaction, type AsyncDataLayer, type DbTransaction } from "./postgres/data-layer.js";
import {
  normalizeApprovalRequestActionCategory,
  type ApprovalRequest,
  type ApprovalRequestActorSnapshot,
  type ApprovalRequestAuditEvent,
  type ApprovalRequestAuditEventType,
  type ApprovalRequestActionCategory,
  type ApprovalRequestCompletionInput,
  type ApprovalRequestCreateInput,
  type ApprovalRequestDecisionInput,
  type ApprovalRequestListInput,
  type ApprovalRequestStatus,
} from "./types.js";

/** A query-capable handle: either the top-level db or a transaction handle. */
type QueryHandle = AsyncDataLayer["db"] | DbTransaction;

interface ApprovalRequestRow {
  projectId: string;
  id: string;
  status: ApprovalRequestStatus;
  requesterActorId: string;
  requesterActorType: ApprovalRequestActorSnapshot["actorType"];
  requesterActorName: string;
  targetActionCategory: string;
  targetActionOperation: string;
  targetActionSummary: string;
  targetResourceType: string;
  targetResourceId: string;
  targetContext: Record<string, unknown> | null;
  taskId: string | null;
  runId: string | null;
  requestedAt: string;
  decidedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  notBeforeAt: string | null;
  expiresAt: string | null;
  claimToken: string | null;
  claimedAt: string | null;
  campaignProjectId: string | null;
  campaignImportId: string | null;
  campaignId: string | null;
  campaignTaskId: string | null;
  campaignActionId: string | null;
  campaignActionTarget: string | null;
  campaignIdempotencyKey: string | null;
  campaignPacketHash: string | null;
  campaignSidecarHash: string | null;
  campaignBundleHash: string | null;
  campaignTargetRepository: string | null;
  campaignTargetBase: string | null;
  campaignProviderId: string | null;
  campaignModelId: string | null;
  campaignTransport: string | null;
  campaignManifestHash: string | null;
  campaignBindingHash: string | null;
}

interface ApprovalRequestAuditEventRow {
  id: string;
  requestId: string;
  eventType: ApprovalRequestAuditEventType;
  actorId: string;
  actorType: ApprovalRequestActorSnapshot["actorType"];
  actorName: string;
  note: string | null;
  createdAt: string;
}

function rowToRequest(row: ApprovalRequestRow): ApprovalRequest {
  const campaignColumns = [
    row.campaignProjectId, row.campaignImportId, row.campaignId, row.campaignTaskId,
    row.campaignActionId, row.campaignActionTarget, row.campaignIdempotencyKey,
    row.campaignPacketHash, row.campaignSidecarHash, row.campaignBundleHash,
    row.campaignTargetRepository, row.campaignTargetBase, row.campaignProviderId,
    row.campaignModelId, row.campaignTransport, row.campaignManifestHash,
    row.campaignBindingHash,
  ];
  const campaignPresent = campaignColumns.some((column) => column !== null);
  if (campaignPresent && (
    campaignColumns.some((column) => column === null)
    || row.campaignProjectId !== row.projectId
    || row.notBeforeAt === null
    || row.expiresAt === null
  )) {
    throw new TypeError("CCC approval row has a partial campaign authority");
  }
  const campaign = campaignPresent ? {
    binding: assertCccCampaignAuthorityBinding({
      projectId: row.campaignProjectId!, importId: row.campaignImportId!, campaignId: row.campaignId!,
      taskId: row.campaignTaskId!, actionId: row.campaignActionId!, actionTarget: row.campaignActionTarget!,
      idempotencyKey: row.campaignIdempotencyKey!, packetHash: row.campaignPacketHash!,
      sidecarHash: row.campaignSidecarHash!, bundleHash: row.campaignBundleHash!,
      targetRepository: row.campaignTargetRepository!, targetBase: row.campaignTargetBase!,
      providerId: row.campaignProviderId!, modelId: row.campaignModelId!,
      transport: row.campaignTransport! as CccCampaignAuthorityBinding["transport"],
      manifestHash: row.campaignManifestHash!, bindingHash: row.campaignBindingHash!,
    }),
    notBeforeAt: row.notBeforeAt!,
    expiresAt: row.expiresAt!,
    ...(row.claimToken === null ? {} : { claimToken: row.claimToken }),
    ...(row.claimedAt === null ? {} : { claimedAt: row.claimedAt }),
  } : undefined;
  return {
    id: row.id,
    status: row.status,
    requester: {
      actorId: row.requesterActorId,
      actorType: row.requesterActorType,
      actorName: row.requesterActorName,
    },
    targetAction: {
      category: normalizeApprovalRequestActionCategory(
        row.targetActionCategory as Parameters<typeof normalizeApprovalRequestActionCategory>[0],
      ),
      action: row.targetActionOperation,
      summary: row.targetActionSummary,
      resourceType: row.targetResourceType,
      resourceId: row.targetResourceId,
      context: row.targetContext ?? {},
    },
    taskId: row.taskId ?? undefined,
    runId: row.runId ?? undefined,
    requestedAt: row.requestedAt,
    decidedAt: row.decidedAt ?? undefined,
    completedAt: row.completedAt ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(campaign ? { campaign } : {}),
  };
}

function rowToAuditEvent(row: ApprovalRequestAuditEventRow): ApprovalRequestAuditEvent {
  return {
    id: row.id,
    requestId: row.requestId,
    eventType: row.eventType,
    actor: {
      actorId: row.actorId,
      actorType: row.actorType,
      actorName: row.actorName,
    },
    note: row.note ?? undefined,
    createdAt: row.createdAt,
  };
}

/**
 * Append an audit event row inside the given transaction handle.
 *
 * FNXC:ApprovalAnalyticsIsolation 2026-07-14-01:04:
 * Audit events must carry the bound layer's project ID at write time because request IDs alone do not provide a reliable tenant ownership join for Command Center intervention analytics.
 */
async function appendAuditEvent(
  tx: DbTransaction,
  projectId: string,
  requestId: string,
  eventType: ApprovalRequestAuditEventType,
  actor: ApprovalRequestActorSnapshot,
  createdAt: string,
  note?: string,
): Promise<ApprovalRequestAuditEvent> {
  const id = `aprevt-${eventType}-${requestId}-${createdAt}`;
  const event: ApprovalRequestAuditEvent = {
    id,
    requestId,
    eventType,
    actor,
    ...(note !== undefined ? { note } : {}),
    createdAt,
  };
  await tx.insert(schema.project.approvalRequestAuditEvents).values({
    projectId,
    id,
    requestId,
    eventType,
    actorId: actor.actorId,
    actorType: actor.actorType,
    actorName: actor.actorName,
    note: note ?? null,
    createdAt,
  });
  return event;
}

/**
 * FNXC:ApprovalRequestStore 2026-06-24-07:35:
 * Create an approval request + audit event atomically. The request insert and
 * the "created" audit event run in a single transaction so they commit/rollback
 * together.
 */
export async function createApprovalRequest(
  layer: AsyncDataLayer,
  input: ApprovalRequestCreateInput & { id: string },
): Promise<ApprovalRequest> {
  const now = new Date().toISOString();
  const projectId = layer.projectId ?? "";
  const request: ApprovalRequest = {
    id: input.id,
    status: "pending",
    requester: input.requester,
    targetAction: {
      ...input.targetAction,
      category: normalizeApprovalRequestActionCategory(input.targetAction.category),
    },
    taskId: input.taskId,
    runId: input.runId,
    requestedAt: now,
    createdAt: now,
    updatedAt: now,
  };
  await layer.transactionImmediate(async (tx) => {
    await tx.insert(schema.project.approvalRequests).values({
      id: request.id,
      status: request.status,
      requesterActorId: request.requester.actorId,
      requesterActorType: request.requester.actorType,
      requesterActorName: request.requester.actorName,
      targetActionCategory: request.targetAction.category,
      targetActionOperation: request.targetAction.action,
      targetActionSummary: request.targetAction.summary,
      targetResourceType: request.targetAction.resourceType,
      targetResourceId: request.targetAction.resourceId,
      targetContext: request.targetAction.context,
      taskId: request.taskId ?? null,
      runId: request.runId ?? null,
      requestedAt: request.requestedAt,
      decidedAt: null,
      completedAt: null,
      createdAt: request.createdAt,
      updatedAt: request.updatedAt,
    });
    await appendAuditEvent(tx, projectId, request.id, "created", input.requester, now);
  });
  return request;
}

/**
 * Get a single approval request by id.
 */
export async function getApprovalRequest(
  handle: QueryHandle,
  id: string,
): Promise<ApprovalRequest | null> {
  const rows = await handle
    .select()
    .from(schema.project.approvalRequests)
    .where(eq(schema.project.approvalRequests.id, id));
  return rows[0] ? rowToRequest(rows[0] as ApprovalRequestRow) : null;
}

/**
 * FNXC:ApprovalRequestStore 2026-06-24-07:40:
 * List approval requests with optional filters. Ordered by createdAt DESC.
 */
export async function listApprovalRequests(
  handle: QueryHandle,
  input: ApprovalRequestListInput = {},
): Promise<ApprovalRequest[]> {
  const conditions: ReturnType<typeof eq>[] = [];
  if (input.status) conditions.push(eq(schema.project.approvalRequests.status, input.status));
  if (input.requesterActorId) conditions.push(eq(schema.project.approvalRequests.requesterActorId, input.requesterActorId));
  if (input.taskId) conditions.push(eq(schema.project.approvalRequests.taskId, input.taskId));
  if (input.runId) conditions.push(eq(schema.project.approvalRequests.runId, input.runId));
  const limit = input.limit ?? 100;
  const offset = input.offset ?? 0;
  const query = handle
    .select()
    .from(schema.project.approvalRequests)
    .orderBy(desc(schema.project.approvalRequests.createdAt), desc(schema.project.approvalRequests.id))
    .limit(limit)
    .offset(offset);
  const rows = conditions.length > 0 ? await query.where(and(...conditions)) : await query;
  return rows.map((row) => rowToRequest(row as ApprovalRequestRow));
}

/**
 * FNXC:ApprovalRequestStore 2026-06-24-07:45:
 * Decide (approve/deny) an approval request. The status update and the audit
 * event run in a single transaction. Throws on invalid transition.
 */
export async function decideApprovalRequest(
  layer: AsyncDataLayer,
  requestId: string,
  status: "approved" | "denied",
  input: ApprovalRequestDecisionInput,
): Promise<ApprovalRequest> {
  const now = new Date().toISOString();
  const updated = await layer.transactionImmediate(async (tx) => {
    const rows = await tx
      .update(schema.project.approvalRequests)
      .set({ status, decidedAt: now, updatedAt: now })
      .where(and(
        eq(schema.project.approvalRequests.id, requestId),
        eq(schema.project.approvalRequests.status, "pending"),
      ))
      .returning();
    if (rows.length !== 1) {
      throw new Error(`Approval request ${requestId} was not pending for ${status}`);
    }
    await appendAuditEvent(tx, layer.projectId ?? "", requestId, status, input.actor, now, input.note);
    return rowToRequest(rows[0] as ApprovalRequestRow);
  });
  return updated;
}

/**
 * Mark an approval request as completed. The status update and the audit
 * event run in a single transaction. Throws on invalid transition.
 */
export async function markApprovalRequestCompleted(
  layer: AsyncDataLayer,
  requestId: string,
  input: ApprovalRequestCompletionInput,
): Promise<ApprovalRequest> {
  const now = new Date().toISOString();
  const updated = await layer.transactionImmediate(async (tx) => {
    const rows = await tx
      .update(schema.project.approvalRequests)
      .set({ status: "completed", completedAt: now, updatedAt: now })
      .where(and(
        eq(schema.project.approvalRequests.id, requestId),
        eq(schema.project.approvalRequests.status, "approved"),
      ))
      .returning();
    if (rows.length !== 1) {
      throw new Error(`Approval request ${requestId} was not approved for completion`);
    }
    await appendAuditEvent(tx, layer.projectId ?? "", requestId, "completed", input.actor, now, input.note);
    return rowToRequest(rows[0] as ApprovalRequestRow);
  });
  return updated;
}

type CccCampaignApprovalAction = Pick<CccCampaignActionLookup, "actionId" | "actionTarget">;

type CccCampaignApprovalBaseInput = {
  authorityStore: CccCampaignAuthorityStore;
  rootDir: string;
  taskId: string;
  action: CccCampaignApprovalAction;
  runId: string;
};

export type IssueCccCampaignApprovalInput = CccCampaignApprovalBaseInput & {
  requester: ApprovalRequestActorSnapshot;
  notBeforeAt: string;
  expiresAt: string;
};

export type ClaimCccCampaignApprovalInput = CccCampaignApprovalBaseInput & {
  claimant: ApprovalRequestActorSnapshot;
  claimToken: string;
};

export type DecideCccCampaignApprovalInput = CccCampaignApprovalBaseInput & {
  actor: ApprovalRequestActorSnapshot;
};

export type ConsumeCccCampaignApprovalInput = CccCampaignApprovalBaseInput & {
  actor: ApprovalRequestActorSnapshot;
  claimToken: string;
};

/** Exact approval identity that an effect writer must hold before touching a receipt. */
export type AssertClaimedCccCampaignApprovalInput = Pick<
  CccCampaignApprovalBaseInput,
  "authorityStore" | "rootDir" | "taskId" | "action"
> & {
  approvalRequestId: string;
  claimToken: string;
};

export type AssertConsumedCccCampaignApprovalInput =
  AssertClaimedCccCampaignApprovalInput;

/**
 * Read-only exact terminal custody for a committed provider-attempt replay.
 * The caller supplies only the task/action selected from persisted campaign
 * context; the native approval identity and claim token are re-derived here.
 */
export type ReadConsumedCccCampaignApprovalCustodyInput = Pick<
  CccCampaignApprovalBaseInput,
  "authorityStore" | "rootDir" | "taskId" | "action"
>;

/**
 * Exact approval identity required before a new provider dispatch. Unlike the
 * after-effect assertion, this also proves the approval and action lease are
 * still inside their database-clock windows.
 */
export type AssertActiveClaimedCccCampaignApprovalInput =
  AssertClaimedCccCampaignApprovalInput;

/** Named durable receipt evidence required to safely expire a claimed action. */
export type ExpireClaimedCccCampaignApprovalAfterProvedNoEffectInput =
  AssertClaimedCccCampaignApprovalInput & {
    actor: ApprovalRequestActorSnapshot;
    runId: string;
    effectScopeId: string;
    logicalKey: string;
  };

export type ClaimedCccCampaignApproval = {
  approval: ApprovalRequest;
  binding: CccCampaignAuthorityBinding;
};

export type ConsumedCccCampaignApproval = ClaimedCccCampaignApproval;
export type ExpiredCccCampaignApproval = ClaimedCccCampaignApproval;
export type ConsumedCccCampaignApprovalCustody = Readonly<{
  approvalRequestId: string;
  claimToken: string;
  binding: CccCampaignAuthorityBinding;
}>;

function requireCanonicalTimestamp(value: string, label: string): number {
  const instant = Date.parse(value);
  if (typeof value !== "string" || !Number.isFinite(instant) || new Date(instant).toISOString() !== value) {
    throw new TypeError(`CCC campaign approval ${label} must be a canonical ISO timestamp`);
  }
  return instant;
}

function requireCanonicalText(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new TypeError(`CCC campaign approval ${label} must be a non-empty canonical string`);
  }
  return value;
}

function campaignApprovalId(binding: CccCampaignAuthorityBinding): string {
  return `ccc-approval-${binding.bindingHash}`;
}

function canonicalCampaignApprovalEventKey(
  binding: CccCampaignAuthorityBinding,
  eventType: ApprovalRequestAuditEventType,
): string {
  return `ccc-approval:${binding.bindingHash}:${eventType}`;
}

function approvalAuditId(
  requestId: string,
  eventType: ApprovalRequestAuditEventType,
  timestamp: string,
): string {
  return `ccc-approval-audit-${createHash("sha256")
    .update(`ccc-approval-audit/v1\0${requestId}\0${eventType}\0${timestamp}`, "utf8")
    .digest("hex")}`;
}

async function dbNow(tx: DbTransaction): Promise<string> {
  const rows = await tx.execute(sql`
    SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now
  `) as unknown as Array<{ now: string }>;
  const now = rows[0]?.now;
  requireCanonicalTimestamp(now ?? "", "database clock");
  return now!;
}

async function lockedCampaignAuthority(
  tx: DbTransaction,
  input: Pick<CccCampaignApprovalBaseInput, "authorityStore" | "rootDir" | "taskId" | "action">,
): Promise<{
  context: CccCampaignContext;
  binding: CccCampaignAuthorityBinding;
  protectedAction: CccCampaignContext["protectedActions"][number];
}> {
  const context = await input.authorityStore.getCccCampaignContextForTaskWithinTransaction(tx, input.taskId);
  if (!context) {
    throw new Error(`CCC campaign approval refused: task ${input.taskId} has no persisted campaign context`);
  }
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(input.rootDir);
  } catch {
    throw new Error(`CCC campaign approval refused: task ${input.taskId} root does not match persisted campaign target`);
  }
  if (canonicalRoot !== context.targetRepository.path) {
    throw new Error(`CCC campaign approval refused: task ${input.taskId} root does not match persisted campaign target`);
  }
  const binding = createCccCampaignAuthorityBinding(context, {
    actionId: input.action.actionId,
    actionTarget: input.action.actionTarget,
    requireProtected: true,
  });
  const matchingProtectedActions = context.protectedActions.filter((protectedAction) =>
    protectedAction.id === binding.actionId && protectedAction.target === binding.actionTarget,
  );
  if (matchingProtectedActions.length !== 1) {
    throw new Error(`CCC campaign approval ${binding.actionId} has ambiguous protected-action custody`);
  }
  return { context, binding, protectedAction: matchingProtectedActions[0]! };
}

const PROTECTED_ACTION_CATEGORIES = {
  promotion: "task_agent_mutation",
  live_execution: "command_execution",
  deletion: "file_write_delete",
  merge: "git_write",
  publication: "network_api",
  credential: "secrets_access",
  billing: "network_api",
  upstream_write: "git_write",
} as const satisfies Record<
  CccCampaignContext["protectedActions"][number]["kind"],
  ApprovalRequestActionCategory
>;
const LOWERCASE_SHA256_PATTERN = /^[a-f0-9]{64}$/;

function campaignTargetAction(
  binding: CccCampaignAuthorityBinding,
  protectedAction: CccCampaignContext["protectedActions"][number],
): ApprovalRequest["targetAction"] {
  return {
    category: PROTECTED_ACTION_CATEGORIES[protectedAction.kind],
    action: binding.actionId,
    summary: `CCC ${protectedAction.kind} protected action ${binding.actionId}`,
    resourceType: `ccc-campaign-${protectedAction.kind}`,
    resourceId: binding.actionTarget,
    context: {
      protectedActionKind: protectedAction.kind,
      operatorDecision: protectedAction.operatorDecision,
    },
  };
}

function campaignApprovalWhere(binding: CccCampaignAuthorityBinding, requestId = campaignApprovalId(binding)) {
  const table = schema.project.approvalRequests;
  return and(
    eq(table.projectId, binding.projectId),
    eq(table.id, requestId),
    eq(table.campaignProjectId, binding.projectId),
    eq(table.campaignImportId, binding.importId),
    eq(table.campaignActionId, binding.actionId),
    eq(table.campaignActionTarget, binding.actionTarget),
    eq(table.campaignBindingHash, binding.bindingHash),
  );
}

async function lockedCampaignApproval(
  tx: DbTransaction,
  binding: CccCampaignAuthorityBinding,
): Promise<ApprovalRequest | null> {
  const rows = await tx
    .select()
    .from(schema.project.approvalRequests)
    .where(campaignApprovalWhere(binding))
    .limit(2)
    .for("update");
  if (rows.length > 1) {
    throw new Error(`CCC campaign approval ${binding.actionId} is ambiguous`);
  }
  return rows[0] ? rowToRequest(rows[0] as ApprovalRequestRow) : null;
}

function campaignEffectReceiptWhere(binding: CccCampaignAuthorityBinding) {
  const table = schema.project.cccEffectReceipts;
  return and(
    eq(table.projectId, binding.projectId),
    eq(table.campaignProjectId, binding.projectId),
    eq(table.campaignImportId, binding.importId),
    eq(table.campaignId, binding.campaignId),
    eq(table.campaignTaskId, binding.taskId),
    eq(table.campaignActionId, binding.actionId),
    eq(table.campaignActionTarget, binding.actionTarget),
    eq(table.campaignIdempotencyKey, binding.idempotencyKey),
    eq(table.campaignPacketHash, binding.packetHash),
    eq(table.campaignSidecarHash, binding.sidecarHash),
    eq(table.campaignBundleHash, binding.bundleHash),
    eq(table.campaignTargetRepository, binding.targetRepository),
    eq(table.campaignTargetBase, binding.targetBase),
    eq(table.campaignProviderId, binding.providerId),
    eq(table.campaignModelId, binding.modelId),
    eq(table.campaignTransport, binding.transport),
    eq(table.campaignManifestHash, binding.manifestHash),
    eq(table.campaignBindingHash, binding.bindingHash),
  );
}

function assertCampaignWindow(
  context: CccCampaignContext,
  notBeforeAt: string,
  expiresAt: string,
): void {
  const notBefore = requireCanonicalTimestamp(notBeforeAt, "not-before");
  const expiry = requireCanonicalTimestamp(expiresAt, "expiry");
  const deadline = requireCanonicalTimestamp(context.campaignDeadlineAt, "campaign deadline");
  if (notBefore > expiry || expiry > deadline) {
    throw new Error("CCC campaign approval window exceeds its admitted campaign deadline");
  }
}

/**
 * Mutable lifecycle fields (status, claim token/timestamp, completion fields)
 * are deliberately excluded. An idempotent issue replay must return the one
 * approval after it progresses, while still refusing any drift in the original
 * immutable issuance contract.
 */
function campaignIssueComparable(request: ApprovalRequest): Record<string, unknown> {
  return {
    id: request.id,
    requester: request.requester,
    targetAction: request.targetAction,
    taskId: request.taskId ?? null,
    runId: request.runId ?? null,
    campaign: request.campaign ? {
      binding: request.campaign.binding,
      notBeforeAt: request.campaign.notBeforeAt,
      expiresAt: request.campaign.expiresAt,
    } : null,
  };
}

function equivalentCampaignIssue(existing: ApprovalRequest, requested: ApprovalRequest): boolean {
  return canonicalCccPrdJson(campaignIssueComparable(existing))
    === canonicalCccPrdJson(campaignIssueComparable(requested));
}

async function appendCampaignApprovalAudit(
  tx: DbTransaction,
  request: ApprovalRequest,
  binding: CccCampaignAuthorityBinding,
  eventType: ApprovalRequestAuditEventType,
  actor: ApprovalRequestActorSnapshot,
  runId: string,
  timestamp: string,
): Promise<void> {
  const id = approvalAuditId(request.id, eventType, timestamp);
  await tx.insert(schema.project.approvalRequestAuditEvents).values({
    projectId: binding.projectId,
    id,
    requestId: request.id,
    eventType,
    actorId: actor.actorId,
    actorType: actor.actorType,
    actorName: actor.actorName,
    note: null,
    createdAt: timestamp,
  });
  await recordRunAuditEventWithinTransaction(tx, {
    timestamp,
    taskId: binding.taskId,
    agentId: actor.actorId,
    runId,
    domain: "ccc-campaign",
    mutationType: `approval:${eventType}`,
    target: binding.actionTarget,
    metadata: { approvalRequestId: request.id, outcome: eventType },
    campaign: {
      eventKey: canonicalCampaignApprovalEventKey(binding, eventType),
      binding,
    },
  });
}

function campaignRequestFromRow(row: unknown): ApprovalRequest {
  return rowToRequest(row as ApprovalRequestRow);
}

/**
 * Issue a campaign-bound approval from persisted task custody. This is a
 * PostgreSQL-only native seam; it never accepts a caller-provided binding.
 */
export async function issueCccCampaignApproval(
  layer: AsyncDataLayer,
  input: IssueCccCampaignApprovalInput,
): Promise<ApprovalRequest> {
  requireCanonicalText(input.runId, "run ID");
  return layer.transactionImmediate(async (tx) => {
    const { context, binding, protectedAction } = await lockedCampaignAuthority(tx, input);
    assertCampaignWindow(context, input.notBeforeAt, input.expiresAt);
    const now = await dbNow(tx);
    const id = campaignApprovalId(binding);
    const requested: ApprovalRequest = {
      id,
      status: "issued",
      requester: input.requester,
      targetAction: campaignTargetAction(binding, protectedAction),
      taskId: binding.taskId,
      runId: input.runId,
      requestedAt: now,
      createdAt: now,
      updatedAt: now,
      campaign: { binding, notBeforeAt: input.notBeforeAt, expiresAt: input.expiresAt },
    };
    const inserted = await tx.insert(schema.project.approvalRequests).values({
      projectId: binding.projectId,
      id,
      status: "issued",
      requesterActorId: input.requester.actorId,
      requesterActorType: input.requester.actorType,
      requesterActorName: input.requester.actorName,
      targetActionCategory: requested.targetAction.category,
      targetActionOperation: requested.targetAction.action,
      targetActionSummary: requested.targetAction.summary,
      targetResourceType: requested.targetAction.resourceType,
      targetResourceId: requested.targetAction.resourceId,
      targetContext: requested.targetAction.context,
      taskId: binding.taskId,
      runId: input.runId,
      requestedAt: now,
      decidedAt: null,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
      notBeforeAt: input.notBeforeAt,
      expiresAt: input.expiresAt,
      claimToken: null,
      claimedAt: null,
      campaignProjectId: binding.projectId,
      campaignImportId: binding.importId,
      campaignId: binding.campaignId,
      campaignTaskId: binding.taskId,
      campaignActionId: binding.actionId,
      campaignActionTarget: binding.actionTarget,
      campaignIdempotencyKey: binding.idempotencyKey,
      campaignPacketHash: binding.packetHash,
      campaignSidecarHash: binding.sidecarHash,
      campaignBundleHash: binding.bundleHash,
      campaignTargetRepository: binding.targetRepository,
      campaignTargetBase: binding.targetBase,
      campaignProviderId: binding.providerId,
      campaignModelId: binding.modelId,
      campaignTransport: binding.transport,
      campaignManifestHash: binding.manifestHash,
      campaignBindingHash: binding.bindingHash,
    }).onConflictDoNothing().returning();
    if (inserted.length === 1) {
      const result = campaignRequestFromRow(inserted[0]);
      await appendCampaignApprovalAudit(tx, result, binding, "issued", input.requester, input.runId, now);
      return result;
    }
    const existing = await lockedCampaignApproval(tx, binding);
    if (!existing || !equivalentCampaignIssue(existing, requested)) {
      throw new Error(`CCC campaign approval ${binding.actionId} collision or drift`);
    }
    return existing;
  });
}

/** Claim an issued campaign approval and its matching campaign action lease atomically. */
export async function claimCccCampaignApproval(
  layer: AsyncDataLayer,
  input: ClaimCccCampaignApprovalInput,
): Promise<ApprovalRequest> {
  const claimToken = requireCanonicalText(input.claimToken, "claim token");
  requireCanonicalText(input.runId, "run ID");
  return layer.transactionImmediate(async (tx) => {
    const { binding } = await lockedCampaignAuthority(tx, input);
    const existing = await lockedCampaignApproval(tx, binding);
    if (!existing?.campaign) throw new Error(`CCC campaign approval ${binding.actionId} is missing`);
    if (existing.status === "claimed" && existing.campaign.claimToken === claimToken) {
      const persistedLease = await input.authorityStore.inspectCccCampaignActionLease(
        input.taskId,
        input.action,
        tx,
      );
      if (
        !persistedLease
        || persistedLease.binding.bindingHash !== binding.bindingHash
        || persistedLease.lease.approvalRequestId !== existing.id
        || persistedLease.lease.claimToken !== claimToken
        || persistedLease.lease.actionId !== binding.actionId
        || persistedLease.lease.actionTarget !== binding.actionTarget
        || persistedLease.lease.bindingHash !== binding.bindingHash
      ) {
        throw new Error(`CCC campaign approval ${binding.actionId} claimed replay has no exact persisted action lease`);
      }
      return existing;
    }
    if (existing.status !== "issued") {
      throw new Error(`CCC campaign approval ${binding.actionId} is not issued for claim`);
    }
    const now = await dbNow(tx);
    if (Date.parse(existing.campaign.notBeforeAt) > Date.parse(now) || Date.parse(existing.campaign.expiresAt) <= Date.parse(now)) {
      throw new Error(`CCC campaign approval ${binding.actionId} is outside its not-before or expiry window`);
    }
    const lease = await input.authorityStore.claimCccCampaignActionLease(
      input.taskId,
      input.action,
      {
        approvalRequestId: existing.id,
        claimToken,
        claimedAt: now,
        expiresAt: existing.campaign.expiresAt,
      },
      tx,
    );
    if (lease.binding.bindingHash !== binding.bindingHash) {
      throw new Error(`CCC campaign approval ${binding.actionId} lease binding drifted`);
    }
    const updated = await tx.update(schema.project.approvalRequests).set({
      status: "claimed",
      claimToken,
      claimedAt: now,
      updatedAt: now,
    }).where(and(
      campaignApprovalWhere(binding, existing.id),
      eq(schema.project.approvalRequests.status, "issued"),
      sql`${schema.project.approvalRequests.notBeforeAt}::timestamptz <= clock_timestamp()`,
      sql`${schema.project.approvalRequests.expiresAt}::timestamptz > clock_timestamp()`,
    )).returning();
    if (updated.length !== 1) {
      throw new Error(`CCC campaign approval ${binding.actionId} claim compare-and-swap lost`);
    }
    const result = campaignRequestFromRow(updated[0]);
    await appendCampaignApprovalAudit(tx, result, binding, "claimed", input.claimant, input.runId, now);
    return result;
  });
}

/** Deny only a still-issued campaign approval; claimed work is never silently revoked. */
export async function denyCccCampaignApproval(
  layer: AsyncDataLayer,
  input: DecideCccCampaignApprovalInput,
): Promise<ApprovalRequest> {
  requireCanonicalText(input.runId, "run ID");
  return layer.transactionImmediate(async (tx) => {
    const { binding } = await lockedCampaignAuthority(tx, input);
    const now = await dbNow(tx);
    const updated = await tx.update(schema.project.approvalRequests).set({
      status: "denied", decidedAt: now, updatedAt: now,
    }).where(and(
      campaignApprovalWhere(binding),
      eq(schema.project.approvalRequests.status, "issued"),
      sql`${schema.project.approvalRequests.expiresAt}::timestamptz > clock_timestamp()`,
    )).returning();
    if (updated.length !== 1) throw new Error(`CCC campaign approval ${binding.actionId} deny compare-and-swap lost`);
    const result = campaignRequestFromRow(updated[0]);
    await appendCampaignApprovalAudit(tx, result, binding, "denied", input.actor, input.runId, now);
    return result;
  });
}

/**
 * Expire an issued approval after its database-clock expiry. Claimed expiry is
 * deliberately fail-closed until the effect receipt seam can prove no dispatch
 * or unknown receipt remains.
 */
export async function expireCccCampaignApproval(
  layer: AsyncDataLayer,
  input: DecideCccCampaignApprovalInput,
): Promise<ApprovalRequest> {
  requireCanonicalText(input.runId, "run ID");
  return layer.transactionImmediate(async (tx) => {
    const { binding } = await lockedCampaignAuthority(tx, input);
    const existing = await lockedCampaignApproval(tx, binding);
    if (!existing?.campaign) throw new Error(`CCC campaign approval ${binding.actionId} is missing`);
    if (existing.status === "claimed") {
      throw new Error(`CCC campaign claimed approval ${binding.actionId} cannot expire without effect receipt abandonment proof`);
    }
    const now = await dbNow(tx);
    const updated = await tx.update(schema.project.approvalRequests).set({
      status: "expired", decidedAt: now, updatedAt: now,
    }).where(and(
      campaignApprovalWhere(binding, existing.id),
      eq(schema.project.approvalRequests.status, "issued"),
      sql`${schema.project.approvalRequests.expiresAt}::timestamptz <= clock_timestamp()`,
    )).returning();
    if (updated.length !== 1) throw new Error(`CCC campaign approval ${binding.actionId} expiry compare-and-swap lost`);
    const result = campaignRequestFromRow(updated[0]);
    await appendCampaignApprovalAudit(tx, result, binding, "expired", input.actor, input.runId, now);
    return result;
  });
}

/**
 * Consume a claimed approval inside an existing transaction. The later effect
 * receipt writer calls this before its receipt write, so the lock order is
 * campaign/import → approval → effect and a receipt failure rolls all state
 * back together.
 */
export async function consumeCccCampaignApprovalWithinTransaction(
  tx: DbTransaction,
  input: ConsumeCccCampaignApprovalInput,
): Promise<ApprovalRequest> {
  const claimToken = requireCanonicalText(input.claimToken, "claim token");
  requireCanonicalText(input.runId, "run ID");
  const { binding } = await lockedCampaignAuthority(tx, input);
  const now = await dbNow(tx);
  const updated = await tx.update(schema.project.approvalRequests).set({
    status: "consumed", completedAt: now, updatedAt: now,
  }).where(and(
    campaignApprovalWhere(binding),
    eq(schema.project.approvalRequests.status, "claimed"),
    eq(schema.project.approvalRequests.claimToken, claimToken),
  )).returning();
  if (updated.length !== 1) throw new Error(`CCC campaign approval ${binding.actionId} consume compare-and-swap lost`);
  const result = campaignRequestFromRow(updated[0]);
  await input.authorityStore.settleCccCampaignActionLease(input.taskId, input.action, claimToken, tx);
  await appendCampaignApprovalAudit(tx, result, binding, "consumed", input.actor, input.runId, now);
  return result;
}

/** Consume a claimed approval in a new PostgreSQL transaction. */
export async function consumeCccCampaignApproval(
  layer: AsyncDataLayer,
  input: ConsumeCccCampaignApprovalInput,
): Promise<ApprovalRequest> {
  return layer.transactionImmediate((tx) => consumeCccCampaignApprovalWithinTransaction(tx, input));
}

/**
 * Re-derive and lock the campaign-owned approval before an effect writer takes
 * a receipt lock. This exposes no caller-supplied provenance: the task/action
 * pair is resolved again from native campaign custody in the same transaction.
 */
export async function assertClaimedCccCampaignApprovalWithinTransaction(
  tx: DbTransaction,
  input: AssertClaimedCccCampaignApprovalInput,
): Promise<ClaimedCccCampaignApproval> {
  const approvalRequestId = requireCanonicalText(input.approvalRequestId, "approval request ID");
  const claimToken = requireCanonicalText(input.claimToken, "claim token");
  const { binding } = await lockedCampaignAuthority(tx, input);
  const expectedRequestId = campaignApprovalId(binding);
  if (approvalRequestId !== expectedRequestId) {
    throw new Error(`CCC campaign approval ${binding.actionId} request identity does not match campaign custody`);
  }
  const approval = await lockedCampaignApproval(tx, binding);
  if (
    !approval?.campaign
    || approval.id !== approvalRequestId
    || approval.status !== "claimed"
    || approval.campaign.claimToken !== claimToken
    || canonicalCccPrdJson(approval.campaign.binding) !== canonicalCccPrdJson(binding)
  ) {
    throw new Error(`CCC campaign approval ${binding.actionId} is not exactly claimed by the supplied approval/token`);
  }
  return { approval, binding };
}

/**
 * Re-derive and lock exact claimed custody before a new provider dispatch.
 * This is deliberately read-only: it neither changes lifecycle state nor
 * creates an audit event. Post-effect reconciliation keeps using the less
 * restrictive asserted-claimed seam so an already-started effect can settle
 * after nominal approval expiry.
 */
export async function assertActiveClaimedCccCampaignApprovalWithinTransaction(
  tx: DbTransaction,
  input: AssertActiveClaimedCccCampaignApprovalInput,
): Promise<ClaimedCccCampaignApproval> {
  const { approval, binding } = await assertClaimedCccCampaignApprovalWithinTransaction(tx, input);
  const persistedLease = await input.authorityStore.inspectCccCampaignActionLease(
    input.taskId,
    input.action,
    tx,
  );
  if (
    !persistedLease
    || persistedLease.binding.bindingHash !== binding.bindingHash
    || persistedLease.lease.approvalRequestId !== approval.id
    || persistedLease.lease.claimToken !== input.claimToken
    || approval.campaign!.claimedAt === undefined
    || persistedLease.lease.claimedAt !== approval.campaign!.claimedAt
    || persistedLease.lease.actionId !== binding.actionId
    || persistedLease.lease.actionTarget !== binding.actionTarget
    || persistedLease.lease.bindingHash !== binding.bindingHash
  ) {
    throw new Error(`CCC campaign approval ${binding.actionId} has no exact persisted action lease for provider dispatch`);
  }
  const now = await dbNow(tx);
  const notBeforeAt = requireCanonicalTimestamp(approval.campaign!.notBeforeAt, "not-before");
  const approvalExpiresAt = requireCanonicalTimestamp(approval.campaign!.expiresAt, "expiry");
  const leaseExpiresAt = requireCanonicalTimestamp(persistedLease.lease.expiresAt, "lease expiry");
  const nowAt = requireCanonicalTimestamp(now, "database clock");
  if (nowAt < notBeforeAt || nowAt >= approvalExpiresAt) {
    throw new Error(`CCC campaign approval ${binding.actionId} is outside its active provider-dispatch window`);
  }
  if (persistedLease.lease.expiresAt !== approval.campaign!.expiresAt) {
    throw new Error(`CCC campaign approval ${binding.actionId} has no exact persisted action lease for provider dispatch`);
  }
  if (nowAt >= leaseExpiresAt) {
    throw new Error(`CCC campaign approval ${binding.actionId} is outside its active provider-dispatch window`);
  }
  return { approval, binding };
}

/**
 * Re-derive and lock one closed terminal approval after its campaign action
 * lease has been settled. This is a read-only reconciliation assertion: it
 * neither mutates lifecycle state nor appends another audit event. The only
 * public entry points close the expected status to consumed or expired.
 */
async function assertTerminalCccCampaignApprovalWithinTransaction(
  tx: DbTransaction,
  input: AssertConsumedCccCampaignApprovalInput,
  expectedStatus: "consumed" | "expired",
): Promise<ConsumedCccCampaignApproval> {
  const approvalRequestId = requireCanonicalText(input.approvalRequestId, "approval request ID");
  const claimToken = requireCanonicalText(input.claimToken, "claim token");
  const { binding } = await lockedCampaignAuthority(tx, input);
  if (approvalRequestId !== campaignApprovalId(binding)) {
    throw new Error(`CCC campaign approval ${binding.actionId} request identity does not match campaign custody`);
  }
  const approval = await lockedCampaignApproval(tx, binding);
  if (
    !approval?.campaign
    || approval.id !== approvalRequestId
    || approval.status !== expectedStatus
    || approval.campaign.claimToken !== claimToken
    || canonicalCccPrdJson(approval.campaign.binding) !== canonicalCccPrdJson(binding)
  ) {
    throw new Error(`CCC campaign approval ${binding.actionId} is not exactly ${expectedStatus} by the supplied approval/token`);
  }
  const persistedLease = await input.authorityStore.inspectCccCampaignActionLease(
    input.taskId,
    input.action,
    tx,
  );
  if (persistedLease !== null) {
    throw new Error(`CCC campaign approval ${binding.actionId} ${expectedStatus} custody still has a persisted action lease`);
  }
  return { approval, binding };
}

export async function assertConsumedCccCampaignApprovalWithinTransaction(
  tx: DbTransaction,
  input: AssertConsumedCccCampaignApprovalInput,
): Promise<ConsumedCccCampaignApproval> {
  return assertTerminalCccCampaignApprovalWithinTransaction(tx, input, "consumed");
}

/**
 * Re-derive exact consumed custody for a follow-on provider dispatch inside
 * the same approved session. Settlement consumes the claim on the session's
 * first committed terminal, so a later turn of that fenced node visit can
 * never present an active claim; it rides the consumed approval instead,
 * still bounded by the approval's dispatch window. Callers must separately
 * prove a committed attempt exists under the exact same work-item fence
 * before trusting this custody for a new reservation.
 */
export async function assertConsumedCccCampaignApprovalForFollowOnDispatchWithinTransaction(
  tx: DbTransaction,
  input: AssertConsumedCccCampaignApprovalInput,
): Promise<ConsumedCccCampaignApproval> {
  const result = await assertTerminalCccCampaignApprovalWithinTransaction(tx, input, "consumed");
  const campaign = result.approval.campaign!;
  const nowAt = requireCanonicalTimestamp(await dbNow(tx), "database clock");
  const notBeforeAt = requireCanonicalTimestamp(campaign.notBeforeAt, "not-before");
  const approvalExpiresAt = requireCanonicalTimestamp(campaign.expiresAt, "expiry");
  if (nowAt < notBeforeAt || nowAt >= approvalExpiresAt) {
    throw new Error(`CCC campaign approval ${result.binding.actionId} is outside its active provider-dispatch window`);
  }
  return result;
}

/**
 * Re-derive the only approval identity that can replay a committed provider
 * attempt. Unlike the assertion above, this exposes no caller-provided
 * approval ID or token, so an engine restart cannot forge terminal custody.
 */
export async function readConsumedCccCampaignApprovalCustodyWithinTransaction(
  tx: DbTransaction,
  input: ReadConsumedCccCampaignApprovalCustodyInput,
): Promise<ConsumedCccCampaignApprovalCustody> {
  const { binding } = await lockedCampaignAuthority(tx, input);
  const approval = await lockedCampaignApproval(tx, binding);
  if (
    !approval?.campaign
    || approval.status !== "consumed"
    || canonicalCccPrdJson(approval.campaign.binding) !== canonicalCccPrdJson(binding)
  ) {
    throw new Error(`CCC campaign approval ${binding.actionId} is not exactly consumed by persisted campaign custody`);
  }
  const claimToken = requireCanonicalText(
    approval.campaign.claimToken ?? "",
    `CCC campaign approval ${binding.actionId} consumed claim token`,
  );
  const persistedLease = await input.authorityStore.inspectCccCampaignActionLease(
    input.taskId,
    input.action,
    tx,
  );
  if (persistedLease !== null) {
    throw new Error(`CCC campaign approval ${binding.actionId} consumed custody still has a persisted action lease`);
  }
  return Object.freeze({ approvalRequestId: approval.id, claimToken, binding });
}

export async function assertExpiredCccCampaignApprovalWithinTransaction(
  tx: DbTransaction,
  input: AssertConsumedCccCampaignApprovalInput,
): Promise<ExpiredCccCampaignApproval> {
  return assertTerminalCccCampaignApprovalWithinTransaction(tx, input, "expired");
}

/**
 * Expire a claimed campaign approval only after a native receipt proves the
 * effect never crossed dispatch. The receipt is read and locked after the
 * campaign/import and approval locks, preserving the single native lock order.
 */
export async function expireClaimedCccCampaignApprovalAfterProvedNoEffectWithinTransaction(
  tx: DbTransaction,
  input: ExpireClaimedCccCampaignApprovalAfterProvedNoEffectInput,
): Promise<ApprovalRequest> {
  requireCanonicalText(input.runId, "run ID");
  const effectScopeId = requireCanonicalText(input.effectScopeId, "effect scope ID");
  const logicalKey = requireCanonicalText(input.logicalKey, "effect logical key");
  const { approval, binding } = await assertClaimedCccCampaignApprovalWithinTransaction(tx, input);
  const now = await dbNow(tx);
  if (Date.parse(now) < Date.parse(approval.campaign!.expiresAt)) {
    throw new Error(`CCC campaign approval ${binding.actionId} cannot expire before its database-clock deadline`);
  }
  const namedReceipts = await tx
    .select()
    .from(schema.project.cccEffectReceipts)
    .where(and(
      campaignEffectReceiptWhere(binding),
      eq(schema.project.cccEffectReceipts.effectScopeId, effectScopeId),
      eq(schema.project.cccEffectReceipts.logicalKey, logicalKey),
    ))
    .limit(2)
    .for("update");
  if (namedReceipts.length !== 1 || namedReceipts[0]!.state !== "proved_failed") {
    throw new Error(`CCC campaign approval ${binding.actionId} claimed expiry requires one exact proved-failed receipt with authoritative evidence`);
  }
  if (!LOWERCASE_SHA256_PATTERN.test(namedReceipts[0]!.evidenceDigest ?? "")) {
    throw new Error(`CCC campaign approval ${binding.actionId} claimed expiry evidence digest must be lowercase SHA-256`);
  }
  const unresolvedDispatches = await tx
    .select({ logicalKey: schema.project.cccEffectReceipts.logicalKey })
    .from(schema.project.cccEffectReceipts)
    .where(and(
      campaignEffectReceiptWhere(binding),
      eq(schema.project.cccEffectReceipts.state, "dispatched_unknown"),
    ))
    .for("update");
  if (unresolvedDispatches.length > 0) {
    throw new Error(`CCC campaign approval ${binding.actionId} claimed expiry refuses unresolved dispatched receipt ${unresolvedDispatches[0]!.logicalKey}`);
  }
  const updated = await tx.update(schema.project.approvalRequests).set({
    status: "expired", decidedAt: now, updatedAt: now,
  }).where(and(
    campaignApprovalWhere(binding, approval.id),
    eq(schema.project.approvalRequests.status, "claimed"),
    eq(schema.project.approvalRequests.claimToken, input.claimToken),
    sql`${schema.project.approvalRequests.expiresAt}::timestamptz <= clock_timestamp()`,
  )).returning();
  if (updated.length !== 1) {
    throw new Error(`CCC campaign approval ${binding.actionId} claimed expiry compare-and-swap lost`);
  }
  const result = campaignRequestFromRow(updated[0]);
  await input.authorityStore.settleCccCampaignActionLease(input.taskId, input.action, input.claimToken, tx);
  await appendCampaignApprovalAudit(tx, result, binding, "expired", input.actor, input.runId, now);
  return result;
}

/**
 * Get the audit history for a request, ordered by createdAt ASC.
 */
export async function getApprovalAuditHistory(
  handle: QueryHandle,
  requestId: string,
): Promise<ApprovalRequestAuditEvent[]> {
  const rows = await handle
    .select()
    .from(schema.project.approvalRequestAuditEvents)
    .where(eq(schema.project.approvalRequestAuditEvents.requestId, requestId))
    .orderBy(
      sql`${schema.project.approvalRequestAuditEvents.createdAt} ASC, ${schema.project.approvalRequestAuditEvents.id} ASC`,
    );
  return rows.map((row) => rowToAuditEvent(row as ApprovalRequestAuditEventRow));
}
