/**
 * workflow-workitems-ops-2 operations.
 *
 * FNXC:StoreModularization 2026-06-25-00:00:
 * Extracted from the monolithic packages/core/src/store.ts as a pure
 * behavior-preserving refactor. Each function receives the TaskStore
 * instance as its first parameter and performs byte-identical work.
 */
import {TaskStore} from "../store.js";
import * as schema from "../postgres/schema/index.js";
import {randomUUID} from "node:crypto";
import {and, eq, gt, inArray, isNull, lte, or, sql} from "drizzle-orm";
import type {RunAuditEventInput, WorkflowWorkItem, WorkflowWorkItemState, WorkflowWorkItemTransitionPatch, WorkflowWorkItemUpsertInput} from "../types.js";
import "../builtin-traits.js";
import {__setTaskActivityLogLimitsForTesting} from "../task-store/comments.js";
import {replaceActiveTaskWorkflowContinuation as replaceActiveTaskWorkflowContinuationAsync, upsertWorkflowWorkItem as upsertWorkflowWorkItemAsync, transitionWorkflowWorkItem as transitionWorkflowWorkItemAsync} from "../task-store/async-workflow-workitems.js";
import type {WorkflowWorkItemRow} from "../task-store/row-types.js";
import type {DbTransaction} from "../postgres/data-layer.js";
import {recordRunAuditEventWithinTransaction} from "../postgres/data-layer.js";

export type FencedCccCampaignProofAuditInput = Readonly<{
  workItemId: string;
  originTaskId: string;
  leaseOwner: string;
  attempt: number;
  runId: string;
  event: RunAuditEventInput;
}>;

export type CccCampaignWorkflowLeaseFenceInput = Readonly<{
  workItemId: string;
  originTaskId: string;
  leaseOwner: string;
  attempt: number;
  runId: string;
}>;

export class CccCampaignWorkflowLeaseFenceError extends Error {
  public readonly code = "CCC_CAMPAIGN_WORKFLOW_LEASE_REFUSED";

  public constructor(message: string) {
    super(message);
    this.name = "CccCampaignWorkflowLeaseFenceError";
  }
}

export class CccCampaignProofAuditLeaseError extends Error {
  public readonly code = "CCC_PROOF_AUDIT_LEASE_REFUSED";

  public constructor(message: string) {
    super(message);
    this.name = "CccCampaignProofAuditLeaseError";
  }
}

export async function assertCccCampaignWorkflowLeaseFenceImpl(
  store: TaskStore,
  input: CccCampaignWorkflowLeaseFenceInput,
): Promise<void> {
  if (!store.backendMode || !store.asyncLayer) {
    throw new CccCampaignWorkflowLeaseFenceError(
      "CCC campaign workflow lease preflight requires the PostgreSQL TaskStore",
    );
  }
  requireCccCampaignWorkflowLeaseFenceInput(input);
  const rows = await store.asyncLayer.db
    .select({ id: schema.project.workflowWorkItems.id })
    .from(schema.project.workflowWorkItems)
    .where(and(
      eq(schema.project.workflowWorkItems.id, input.workItemId),
      eq(schema.project.workflowWorkItems.taskId, input.originTaskId),
      eq(schema.project.workflowWorkItems.runId, input.runId),
      eq(schema.project.workflowWorkItems.state, "running"),
      eq(schema.project.workflowWorkItems.leaseOwner, input.leaseOwner),
      eq(schema.project.workflowWorkItems.attempt, input.attempt),
      sql`${schema.project.workflowWorkItems.leaseExpiresAt} IS NOT NULL
        AND ${schema.project.workflowWorkItems.leaseExpiresAt}::timestamptz > clock_timestamp()`,
    ))
    .limit(1);
  if (rows.length !== 1) {
    throw new CccCampaignWorkflowLeaseFenceError(
      `CCC campaign workflow lease fence refused work item ${input.workItemId}`,
    );
  }
}

function requireCccCampaignWorkflowLeaseFenceInput(
  input: CccCampaignWorkflowLeaseFenceInput,
): void {
  if (!input || typeof input !== "object") {
    throw new CccCampaignWorkflowLeaseFenceError("CCC campaign workflow lease fence input is missing");
  }
  for (const [label, value] of [
    ["work item id", input.workItemId],
    ["origin task id", input.originTaskId],
    ["lease owner", input.leaseOwner],
    ["run id", input.runId],
  ] as const) {
    if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
      throw new CccCampaignWorkflowLeaseFenceError(
        `CCC campaign workflow lease fence ${label} must be a canonical string`,
      );
    }
  }
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 1) {
    throw new CccCampaignWorkflowLeaseFenceError(
      "CCC campaign workflow lease fence attempt must be a positive safe integer",
    );
  }
}

export async function upsertWorkflowWorkItemImpl(store: TaskStore, input: WorkflowWorkItemUpsertInput, tx?: DbTransaction): Promise<WorkflowWorkItem> {
    if (store.backendMode) {
      const layer = store.asyncLayer!;
      return upsertWorkflowWorkItemAsync(layer, input, tx);
    }
    return store.db.transactionImmediate(() => {
      const existing = store.db
        .prepare("SELECT * FROM workflow_work_items WHERE runId = ? AND taskId = ? AND nodeId = ? AND kind = ?")
        .get(input.runId, input.taskId, input.nodeId, input.kind) as WorkflowWorkItemRow | undefined;
      const now = input.now ?? new Date().toISOString();
      const existingState = existing ? store.normalizeWorkflowWorkItemState(existing.state) : null;
      const state = input.state ?? existingState ?? "runnable";
      if (existingState && store.isTerminalWorkflowWorkItemState(existingState) && existingState !== state) {
        throw new Error(
          `Workflow work item ${existing?.id ?? input.id ?? input.nodeId} is terminal (${existingState}) and cannot be requeued as ${state}`,
        );
      }

      const id = existing?.id ?? input.id ?? randomUUID();
      store.db
        .prepare(
          `INSERT INTO workflow_work_items (
             id, runId, taskId, nodeId, kind, state, attempt, retryAfter,
             leaseOwner, leaseExpiresAt, lastError, blockedReason, stableWorkflowRunId,
             continuationSequence, waitReason, sourceColumn, targetColumn, irHash, createdAt, updatedAt
           )
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(runId, taskId, nodeId, kind) DO UPDATE SET
             state = excluded.state,
             attempt = excluded.attempt,
             retryAfter = excluded.retryAfter,
             leaseOwner = excluded.leaseOwner,
             leaseExpiresAt = excluded.leaseExpiresAt,
             lastError = excluded.lastError,
             blockedReason = excluded.blockedReason,
             stableWorkflowRunId = excluded.stableWorkflowRunId,
             continuationSequence = excluded.continuationSequence,
             waitReason = excluded.waitReason,
             sourceColumn = excluded.sourceColumn,
             targetColumn = excluded.targetColumn,
             irHash = excluded.irHash,
             updatedAt = excluded.updatedAt`,
        )
        .run(
          id,
          input.runId,
          input.taskId,
          input.nodeId,
          input.kind,
          state,
          input.attempt ?? existing?.attempt ?? 0,
          input.retryAfter === undefined ? existing?.retryAfter ?? null : input.retryAfter,
          input.leaseOwner === undefined ? existing?.leaseOwner ?? null : input.leaseOwner,
          input.leaseExpiresAt === undefined ? existing?.leaseExpiresAt ?? null : input.leaseExpiresAt,
          input.lastError === undefined ? existing?.lastError ?? null : input.lastError,
          input.blockedReason === undefined ? existing?.blockedReason ?? null : input.blockedReason,
          input.stableWorkflowRunId === undefined ? existing?.stableWorkflowRunId ?? null : input.stableWorkflowRunId,
          input.continuationSequence === undefined ? existing?.continuationSequence ?? null : input.continuationSequence,
          input.waitReason === undefined ? existing?.waitReason ?? null : input.waitReason,
          input.sourceColumn === undefined ? existing?.sourceColumn ?? null : input.sourceColumn,
          input.targetColumn === undefined ? existing?.targetColumn ?? null : input.targetColumn,
          input.irHash === undefined ? existing?.irHash ?? null : input.irHash,
          existing?.createdAt ?? now,
          now,
        );

      const row = store.db.prepare("SELECT * FROM workflow_work_items WHERE id = ?").get(id) as WorkflowWorkItemRow | undefined;
      if (!row) throw new Error(`Failed to upsert workflow work item ${id}`);
      store.insertRunAuditEventRow({
        taskId: row.taskId,
        runId: row.runId,
        domain: "database",
        mutationType: "workflowWorkItem:upsert",
        target: row.id,
        metadata: { id: row.id, nodeId: row.nodeId, kind: row.kind, state: row.state, attempt: row.attempt },
      });
      return store.rowToWorkflowWorkItem(row);
    });
  }

export async function replaceActiveTaskWorkflowContinuationImpl(
  store: TaskStore,
  input: WorkflowWorkItemUpsertInput & { kind: "task" },
): Promise<WorkflowWorkItem> {
  if (store.backendMode) {
    return replaceActiveTaskWorkflowContinuationAsync(store.asyncLayer!, input);
  }

  // Compatibility path for legacy embedded stores. PostgreSQL is the
  // authoritative runtime and performs this replacement atomically above.
  return store.db.transactionImmediate(() => {
    const active = store.db.prepare(
      `SELECT id, runId, nodeId, kind FROM workflow_work_items
       WHERE taskId = ? AND kind = 'task' AND state IN ('runnable', 'running', 'held', 'retrying')`,
    ).all(input.taskId) as Array<{ id: string; runId: string; nodeId: string; kind: string }>;
    for (const row of active) {
      if (row.runId === input.runId && row.nodeId === input.nodeId && row.kind === input.kind) continue;
      store.transitionWorkflowWorkItemSync(row.id, "succeeded", {
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: null,
      });
    }
    return upsertWorkflowWorkItemImpl(store, input);
  });
}

export async function transitionWorkflowWorkItemImpl(store: TaskStore, id: string, state: WorkflowWorkItemState, patch: WorkflowWorkItemTransitionPatch = {}, tx?: DbTransaction,): Promise<WorkflowWorkItem> {
    if (store.backendMode) {
      const layer = store.asyncLayer!;
      return transitionWorkflowWorkItemAsync(layer, id, state, patch, tx);
    }
    return store.transitionWorkflowWorkItemSync(id, state, patch);
  }

export async function acquireWorkflowWorkItemLeaseImpl(store: TaskStore, id: string, leaseOwner: string, opts: { leaseDurationMs: number; now?: string; expectedRunId?: string; expectedAttempt?: number },): Promise<WorkflowWorkItem | null> {
    if (!Number.isFinite(opts.leaseDurationMs) || opts.leaseDurationMs <= 0) {
      throw new Error(`workflow work item leaseDurationMs must be > 0 (received ${opts.leaseDurationMs})`);
    }

    if (store.backendMode) {
      const layer = store.asyncLayer!;
      const now = opts.now ?? new Date().toISOString();
      const leaseExpiresAt = new Date(new Date(now).getTime() + opts.leaseDurationMs).toISOString();
      /*
      FNXC:CccWave4Lease 2026-07-24-18:35:
      PostgreSQL claim eligibility and the returned lease must come from one
      guarded UPDATE. A follow-up SELECT can observe a competing owner after
      this claimant's write and makes two workers believe they acquired it.
      */
      const claimedRows = await layer.db
        .update(schema.project.workflowWorkItems)
        .set({
          state: "running",
          leaseOwner,
          leaseExpiresAt,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.project.workflowWorkItems.id, id),
            ...(opts.expectedRunId === undefined ? [] : [eq(schema.project.workflowWorkItems.runId, opts.expectedRunId)]),
            ...(opts.expectedAttempt === undefined ? [] : [eq(schema.project.workflowWorkItems.attempt, opts.expectedAttempt)]),
            inArray(schema.project.workflowWorkItems.state, ["runnable", "retrying", "running"]),
            or(
              isNull(schema.project.workflowWorkItems.retryAfter),
              lte(schema.project.workflowWorkItems.retryAfter, now),
            ),
            or(
              isNull(schema.project.workflowWorkItems.leaseExpiresAt),
              lte(schema.project.workflowWorkItems.leaseExpiresAt, now),
            ),
          ),
        )
        .returning();
      const claimedRow = claimedRows[0] as WorkflowWorkItemRow | undefined;
      if (!claimedRow) return null;
      const updated = store.rowToWorkflowWorkItem(claimedRow);
      // Record the audit event (fire-and-forget).
      void store.recordRunAuditEvent({
        taskId: updated.taskId,
        agentId: "system",
        runId: updated.runId,
        domain: "database",
        mutationType: "workflowWorkItem:lease-acquired",
        target: updated.id,
        metadata: { id: updated.id, leaseOwner: updated.leaseOwner, leaseExpiresAt: updated.leaseExpiresAt },
      });
      return updated;
    }

    return store.db.transactionImmediate(() => {
      const now = opts.now ?? new Date().toISOString();
      const leaseExpiresAt = new Date(new Date(now).getTime() + opts.leaseDurationMs).toISOString();
      const result = store.db
        .prepare(
          `UPDATE workflow_work_items
              SET state = 'running',
                  leaseOwner = ?,
                  leaseExpiresAt = ?,
                  updatedAt = ?
            WHERE id = ?
              AND state IN ('runnable', 'retrying', 'running')
              AND (? IS NULL OR runId = ?)
              AND (? IS NULL OR attempt = ?)
              AND (retryAfter IS NULL OR retryAfter <= ?)
              AND (leaseExpiresAt IS NULL OR leaseExpiresAt <= ?)`,
        )
        .run(
          leaseOwner,
          leaseExpiresAt,
          now,
          id,
          opts.expectedRunId ?? null,
          opts.expectedRunId ?? null,
          opts.expectedAttempt ?? null,
          opts.expectedAttempt ?? null,
          now,
          now,
        );
      if (result.changes === 0) return null;

      const row = store.db.prepare("SELECT * FROM workflow_work_items WHERE id = ?").get(id) as WorkflowWorkItemRow | undefined;
      if (!row) throw new Error(`Workflow work item ${id} disappeared`);
      store.insertRunAuditEventRow({
        taskId: row.taskId,
        runId: row.runId,
        domain: "database",
        mutationType: "workflowWorkItem:lease-acquired",
        target: row.id,
        metadata: { id: row.id, leaseOwner: row.leaseOwner, leaseExpiresAt: row.leaseExpiresAt },
      });
      return store.rowToWorkflowWorkItem(row);
    });
  }

export async function renewWorkflowWorkItemLeaseImpl(store: TaskStore, id: string, leaseOwner: string, expectedAttempt: number, opts: { leaseDurationMs: number; now?: string },): Promise<WorkflowWorkItem | null> {
  if (!Number.isFinite(opts.leaseDurationMs) || opts.leaseDurationMs <= 0) {
    throw new Error(`workflow work item leaseDurationMs must be a positive finite number (received ${opts.leaseDurationMs})`);
  }
  const now = opts.now ?? new Date().toISOString();
  const leaseExpiresAt = new Date(new Date(now).getTime() + opts.leaseDurationMs).toISOString();

  if (store.backendMode) {
    return store.asyncLayer!.transactionImmediate(async (tx) => {
      const renewedRows = await tx
        .update(schema.project.workflowWorkItems)
        .set({ leaseExpiresAt, updatedAt: now })
        .where(and(
          eq(schema.project.workflowWorkItems.id, id),
          eq(schema.project.workflowWorkItems.state, "running"),
          eq(schema.project.workflowWorkItems.leaseOwner, leaseOwner),
          eq(schema.project.workflowWorkItems.attempt, expectedAttempt),
          gt(schema.project.workflowWorkItems.leaseExpiresAt, now),
        ))
        .returning();
      const row = renewedRows[0] as WorkflowWorkItemRow | undefined;
      if (renewedRows.length !== 1 || !row) return null;
      await recordRunAuditEventWithinTransaction(tx, {
        taskId: row.taskId,
        agentId: "system",
        runId: row.runId,
        domain: "database",
        mutationType: "workflowWorkItem:lease-renewed",
        target: row.id,
        metadata: { id: row.id, leaseOwner, attempt: expectedAttempt, leaseExpiresAt },
      });
      return store.rowToWorkflowWorkItem(row);
    });
  }

  return store.db.transactionImmediate(() => {
    const result = store.db.prepare(
      `UPDATE workflow_work_items
          SET leaseExpiresAt = ?, updatedAt = ?
        WHERE id = ?
          AND state = 'running'
          AND leaseOwner = ?
          AND attempt = ?
          AND leaseExpiresAt IS NOT NULL
          AND leaseExpiresAt > ?`,
    ).run(leaseExpiresAt, now, id, leaseOwner, expectedAttempt, now);
    if (result.changes !== 1) return null;
    const row = store.db.prepare("SELECT * FROM workflow_work_items WHERE id = ?").get(id) as WorkflowWorkItemRow | undefined;
    if (!row) throw new Error(`Workflow work item ${id} disappeared after lease renewal`);
    store.insertRunAuditEventRow({
      taskId: row.taskId,
      runId: row.runId,
      domain: "database",
      mutationType: "workflowWorkItem:lease-renewed",
      target: row.id,
      metadata: { id: row.id, leaseOwner, attempt: expectedAttempt, leaseExpiresAt },
    });
    return store.rowToWorkflowWorkItem(row);
  });
}

export async function recordFencedCccCampaignProofAuditImpl(
  store: TaskStore,
  input: FencedCccCampaignProofAuditInput,
): Promise<void> {
  if (!store.backendMode || !store.asyncLayer) {
    throw new CccCampaignProofAuditLeaseError(
      "CCC campaign proof audit requires the PostgreSQL TaskStore",
    );
  }
  requireFencedProofAuditInput(input);
  await store.asyncLayer.transactionImmediate(async (tx) => {
    const rows = await tx
      .select({
        id: schema.project.workflowWorkItems.id,
        taskId: schema.project.workflowWorkItems.taskId,
        runId: schema.project.workflowWorkItems.runId,
      })
      .from(schema.project.workflowWorkItems)
      .where(and(
        eq(schema.project.workflowWorkItems.id, input.workItemId),
        eq(schema.project.workflowWorkItems.taskId, input.originTaskId),
        eq(schema.project.workflowWorkItems.runId, input.runId),
        eq(schema.project.workflowWorkItems.state, "running"),
        eq(schema.project.workflowWorkItems.leaseOwner, input.leaseOwner),
        eq(schema.project.workflowWorkItems.attempt, input.attempt),
        sql`${schema.project.workflowWorkItems.leaseExpiresAt} IS NOT NULL
          AND ${schema.project.workflowWorkItems.leaseExpiresAt}::timestamptz > clock_timestamp()`,
      ))
      .limit(1)
      .for("update");
    if (rows.length !== 1) {
      throw new CccCampaignProofAuditLeaseError(
        `CCC campaign proof audit lease fence refused work item ${input.workItemId}`,
      );
    }
    await recordRunAuditEventWithinTransaction(tx, input.event);
  });
}

function requireFencedProofAuditInput(
  input: FencedCccCampaignProofAuditInput,
): void {
  if (!input || typeof input !== "object") {
    throw new CccCampaignProofAuditLeaseError("CCC campaign proof audit input is missing");
  }
  for (const [label, value] of [
    ["work item id", input.workItemId],
    ["origin task id", input.originTaskId],
    ["lease owner", input.leaseOwner],
    ["run id", input.runId],
  ] as const) {
    if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
      throw new CccCampaignProofAuditLeaseError(
        `CCC campaign proof audit ${label} must be a canonical string`,
      );
    }
  }
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 1) {
    throw new CccCampaignProofAuditLeaseError(
      "CCC campaign proof audit attempt must be a positive safe integer",
    );
  }
  const event = input.event;
  if (
    !event
    || event.agentId !== input.leaseOwner
    || event.runId !== input.runId
    || event.mutationType !== "ccc-campaign:proof-admission"
    || !event.campaign
    || !event.campaign.binding.actionId.startsWith("proof:")
    || event.campaign.binding.taskId !== event.taskId
    || event.campaign.binding.actionTarget !== event.target
  ) {
    throw new CccCampaignProofAuditLeaseError(
      "CCC campaign proof audit event does not match its workflow lease fence",
    );
  }
}
