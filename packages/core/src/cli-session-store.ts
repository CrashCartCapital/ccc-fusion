/**
 * Durable PostgreSQL store for experimental CLI Agent Executor sessions.
 *
 * FNXC:CliAgentPostgres 2026-07-14-12:00:
 * CLI-agent execution must remain available after the PostgreSQL cutover. Keep
 * the runtime-facing API synchronous by hydrating a project-scoped cache before
 * construction, while serializing every mutation through the injected
 * AsyncDataLayer. Callers that cross a durability boundary (PTY launch and
 * runtime shutdown) await flush().
 */
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { realpath } from "node:fs/promises";
import { and, desc, eq, sql } from "drizzle-orm";
import * as schema from "./postgres/schema/index.js";
import {
  recordRunAuditEventWithinTransaction,
  RunAuditEventCollisionError,
  type AsyncDataLayer,
  type DbTransaction,
} from "./postgres/data-layer.js";
import { fromJson } from "./db-helpers.js";
import {
  isCliAgentState,
  isCliSessionPurpose,
  isCliTerminationReason,
  type CliAgentState,
  type CliAutonomyPosture,
  type CliSession,
  type CliSessionCreateInput,
  type CliSessionPurpose,
  type CliSessionUpdateInput,
  type CliTerminationReason,
} from "./cli-session-types.js";
import {
  CccEffectReceiptPendingError,
  CccEffectReceiptProtocolError,
  canonicalCccEffectJson,
  type CccCampaignEffectAuthority,
  type CccCampaignEffectClaim,
  type CccEffectTurn,
  type CccEffectReceiptRecord,
  type CccPreparedEffectReceipt,
  type CccPreparedEffectReceiptReconciliation,
} from "./ccc-effect-receipts.js";
import {
  assertClaimedCccCampaignApprovalWithinTransaction,
  assertConsumedCccCampaignApprovalWithinTransaction,
  assertExpiredCccCampaignApprovalWithinTransaction,
  consumeCccCampaignApprovalWithinTransaction,
  expireClaimedCccCampaignApprovalAfterProvedNoEffectWithinTransaction,
} from "./async-approval-request-store.js";
import { assertCccCampaignAuthorityBinding, createCccCampaignAuthorityBinding } from "./ccc-campaign/canonical.js";
import { assertCccProviderFollowOnSettlementCustody, inspectCccProviderAttempt, reconcileCccProviderAttempt } from "./ccc-campaign/provider-attempt.js";
import type { CccCampaignAuthorityStore } from "./ccc-campaign/store.js";
import type {
  CccCampaignAuthorityBinding,
  CccProviderAttemptReconciliation,
  CccProviderAttemptScope,
} from "./ccc-campaign/types.js";

export interface CliSessionStoreEvents {
  "cli-session:created": [session: CliSession];
  "cli-session:updated": [session: CliSession];
  "cli-session:deleted": [sessionId: string];
}

/** Optional native campaign custody dependencies for effect receipt operations. */
export interface CliSessionStoreOptions {
  campaignAuthorityStore?: CccCampaignAuthorityStore;
  rootDir?: string;
}

type CliSessionRow = typeof schema.project.cliSessions.$inferSelect;

type CccEffectReceiptRow = {
  project_id: string;
  effect_scope_id: string;
  logical_key: string;
  turn_key: string;
  slot_ordinal: number;
  tool_authority: string;
  arguments_digest: string;
  repeat_of: string | null;
  state: CccEffectReceiptRecord["state"];
  controller_token: string;
  evidence_digest: string | null;
  result_json: string | null;
  campaign_project_id: string | null;
  campaign_import_id: string | null;
  campaign_id: string | null;
  campaign_task_id: string | null;
  campaign_action_id: string | null;
  campaign_action_target: string | null;
  campaign_idempotency_key: string | null;
  campaign_packet_hash: string | null;
  campaign_sidecar_hash: string | null;
  campaign_bundle_hash: string | null;
  campaign_target_repository: string | null;
  campaign_target_base: string | null;
  campaign_provider_id: string | null;
  campaign_model_id: string | null;
  campaign_transport: string | null;
  campaign_manifest_hash: string | null;
  campaign_binding_hash: string | null;
};

type ResolvedCampaignEffectAuthority = {
  taskId: string;
  claim: CccCampaignEffectClaim;
  authority: CccCampaignEffectAuthority;
};

function campaignAuthorityFromRow(row: CccEffectReceiptRow): CccCampaignEffectAuthority | undefined {
  const columns = [
    row.campaign_project_id, row.campaign_import_id, row.campaign_id, row.campaign_task_id,
    row.campaign_action_id, row.campaign_action_target, row.campaign_idempotency_key,
    row.campaign_packet_hash, row.campaign_sidecar_hash, row.campaign_bundle_hash,
    row.campaign_target_repository, row.campaign_target_base, row.campaign_provider_id,
    row.campaign_model_id, row.campaign_transport, row.campaign_manifest_hash,
    row.campaign_binding_hash,
  ];
  const present = columns.some((column) => column !== null);
  if (!present) return undefined;
  if (columns.some((column) => column === null) || row.campaign_project_id !== row.project_id) {
    throw new CccEffectReceiptProtocolError(
      "CCC_EFFECT_RECONCILIATION_REQUIRED",
      `CCC effect receipt ${row.logical_key} has partial campaign authority`,
    );
  }
  return {
    binding: createCccCampaignAuthorityBindingFromRow(row),
  };
}

function createCccCampaignAuthorityBindingFromRow(row: CccEffectReceiptRow): CccCampaignAuthorityBinding {
  const binding: CccCampaignAuthorityBinding = {
    projectId: row.campaign_project_id!,
    importId: row.campaign_import_id!,
    campaignId: row.campaign_id!,
    taskId: row.campaign_task_id!,
    actionId: row.campaign_action_id!,
    actionTarget: row.campaign_action_target!,
    idempotencyKey: row.campaign_idempotency_key!,
    packetHash: row.campaign_packet_hash!,
    sidecarHash: row.campaign_sidecar_hash!,
    bundleHash: row.campaign_bundle_hash!,
    targetRepository: row.campaign_target_repository!,
    targetBase: row.campaign_target_base!,
    providerId: row.campaign_provider_id!,
    modelId: row.campaign_model_id!,
    transport: row.campaign_transport! as CccCampaignAuthorityBinding["transport"],
    manifestHash: row.campaign_manifest_hash!,
    bindingHash: row.campaign_binding_hash!,
  };
  return assertCccCampaignAuthorityBinding(binding);
}

function receiptFromRow(row: CccEffectReceiptRow): CccEffectReceiptRecord {
  const campaign = campaignAuthorityFromRow(row);
  return {
    effectScopeId: row.effect_scope_id,
    logicalKey: row.logical_key,
    repeatOf: row.repeat_of,
    toolAuthority: row.tool_authority,
    argumentsDigest: row.arguments_digest,
    controllerToken: row.controller_token,
    turnKey: row.turn_key,
    slotOrdinal: row.slot_ordinal,
    forwardedArguments: undefined,
    state: row.state,
    result: row.result_json === null ? undefined : JSON.parse(row.result_json),
    ...(campaign ? { campaign } : {}),
  };
}

function reconciliationEvidenceDigest(input: CccPreparedEffectReceiptReconciliation): string {
  const claim = input.receipt.campaignClaim;
  if (!claim) {
    throw new CccEffectReceiptProtocolError(
      "CCC_EFFECT_RECONCILIATION_REQUIRED",
      `CCC reconciliation has no campaign claim: ${input.receipt.logicalKey}`,
    );
  }
  const observed = input.observation.kind === "committed"
    ? { kind: input.observation.kind, result: input.observation.result }
    : { kind: input.observation.kind };
  return createHash("sha256")
    .update(canonicalCccEffectJson({
      schema: "ccc-effect-reconciliation-evidence/v1",
      effectScopeId: input.receipt.effectScopeId,
      logicalKey: input.receipt.logicalKey,
      controllerGeneration: input.controllerGeneration,
      observerId: input.observerId,
      observationDigest: input.observationDigest,
      observation: observed,
      actionId: claim.actionId,
      actionTarget: claim.actionTarget,
      approvalRequestId: claim.approvalRequestId,
      claimToken: claim.claimToken,
    }))
    .digest("hex");
}

function directCommitEvidenceDigest(input: CccPreparedEffectReceipt, result: unknown): string {
  const claim = input.campaignClaim;
  if (!claim) {
    throw new CccEffectReceiptProtocolError(
      "CCC_EFFECT_RECONCILIATION_REQUIRED",
      `CCC direct commit has no campaign claim: ${input.logicalKey}`,
    );
  }
  return createHash("sha256")
    .update(canonicalCccEffectJson({
      schema: "ccc-effect-direct-commit-evidence/v1",
      effectScopeId: input.effectScopeId,
      logicalKey: input.logicalKey,
      toolAuthority: input.toolAuthority,
      argumentsDigest: input.argumentsDigest,
      result,
      actionId: claim.actionId,
      actionTarget: claim.actionTarget,
      approvalRequestId: claim.approvalRequestId,
      claimToken: claim.claimToken,
    }))
    .digest("hex");
}

function parsePosture(value: unknown): CliAutonomyPosture | null {
  if (typeof value === "string" || value === null || value === undefined) {
    return fromJson<CliAutonomyPosture>(value) ?? null;
  }
  // postgres.js normally returns the text column as a string. Accepting a
  // plain object as well keeps controller fencing correct if a driver or view
  // decodes the JSON-shaped posture before this native reader sees it.
  if (typeof value === "object" && !Array.isArray(value)) return value as CliAutonomyPosture;
  return null;
}

function rowToSession(row: CliSessionRow): CliSession {
  return {
    id: row.id,
    taskId: row.taskId,
    chatSessionId: row.chatSessionId,
    purpose: row.purpose as CliSessionPurpose,
    // FNXC:MultiProjectIsolation 2026-07-15-23:40: the domain projectId now maps to owner_project_id; project_id is the trigger/GUC-owned RLS partition (migration 0011). The store always writes it, so hydrated rows are non-null.
    projectId: row.ownerProjectId ?? "",
    adapterId: row.adapterId,
    agentState: row.agentState as CliAgentState,
    terminationReason: row.terminationReason as CliTerminationReason | null,
    nativeSessionId: row.nativeSessionId,
    resumeAttempts: row.resumeAttempts,
    autonomyPosture: parsePosture(row.autonomyPosture),
    worktreePath: row.worktreePath,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class CliSessionStore extends EventEmitter<CliSessionStoreEvents> {
  private readonly sessions = new Map<string, CliSession>();
  private writeTail: Promise<void> = Promise.resolve();
  private writeError: unknown;

  private constructor(
    private readonly layer: AsyncDataLayer,
    private readonly projectId: string,
    private readonly options: CliSessionStoreOptions = {},
  ) {
    super();
    this.setMaxListeners(100);
  }

  /** Hydrate all project sessions before exposing the synchronous cache API. */
  static async create(
    layer: AsyncDataLayer,
    projectId: string,
    options: CliSessionStoreOptions = {},
  ): Promise<CliSessionStore> {
    const store = new CliSessionStore(layer, projectId, options);
    const rows = await layer.db
      .select()
      .from(schema.project.cliSessions)
      .where(eq(schema.project.cliSessions.ownerProjectId, projectId))
      .orderBy(desc(schema.project.cliSessions.updatedAt));
    for (const row of rows) store.sessions.set(row.id, rowToSession(row));
    return store;
  }

  /** Wait until all mutations queued before this call are durable. */
  async flush(): Promise<void> {
    await this.writeTail;
    if (this.writeError !== undefined) throw this.writeError;
  }

  private enqueue(write: () => Promise<unknown>): void {
    this.writeTail = this.writeTail
      .then(async () => {
        await write();
      })
      .catch((error: unknown) => {
        // Event-driven state transitions cannot await storage directly. Retain
        // the first failure for the next explicit durability boundary without
        // creating an unhandled rejection, and keep later writes ordered.
        this.writeError ??= error;
      });
  }

  private assertAgentState(value: unknown): asserts value is CliAgentState {
    if (!isCliAgentState(value)) throw new Error(`Invalid CLI agent state: ${JSON.stringify(value)}`);
  }

  private assertPurpose(value: unknown): asserts value is CliSessionPurpose {
    if (!isCliSessionPurpose(value)) throw new Error(`Invalid CLI session purpose: ${JSON.stringify(value)}`);
  }

  private assertTerminationReason(value: unknown): asserts value is CliTerminationReason | null {
    if (value !== null && value !== undefined && !isCliTerminationReason(value)) {
      throw new Error(`Invalid CLI termination reason: ${JSON.stringify(value)}`);
    }
  }

  createSession(input: CliSessionCreateInput): CliSession {
    this.assertPurpose(input.purpose);
    const agentState = input.agentState ?? "starting";
    this.assertAgentState(agentState);
    this.assertTerminationReason(input.terminationReason ?? null);
    if (!input.projectId) throw new Error("CLI session requires a projectId");
    if (input.projectId !== this.projectId) throw new Error(`CLI session projectId must be ${this.projectId}`);
    if (!input.adapterId) throw new Error("CLI session requires an adapterId");

    const now = new Date().toISOString();
    const session: CliSession = {
      id: input.id ?? `cli-${randomUUID().slice(0, 8)}`,
      taskId: input.taskId ?? null,
      chatSessionId: input.chatSessionId ?? null,
      purpose: input.purpose,
      projectId: input.projectId,
      adapterId: input.adapterId,
      agentState,
      terminationReason: input.terminationReason ?? null,
      nativeSessionId: input.nativeSessionId ?? null,
      resumeAttempts: input.resumeAttempts ?? 0,
      autonomyPosture: input.autonomyPosture ?? null,
      worktreePath: input.worktreePath ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(session.id, session);
    // FNXC:MultiProjectIsolation 2026-07-15-23:40: write the session's domain project to
    // owner_project_id and never project_id — the trigger/GUC owns the RLS partition.
    const { projectId: ownerProjectId, ...columns } = session;
    this.enqueue(() => this.layer.db.insert(schema.project.cliSessions).values({
      ...columns,
      ownerProjectId,
      autonomyPosture: session.autonomyPosture ? JSON.stringify(session.autonomyPosture) : null,
    }));
    this.emit("cli-session:created", session);
    return session;
  }

  getSession(id: string): CliSession | undefined {
    return this.sessions.get(id);
  }

  listSessions(options?: {
    taskId?: string;
    chatSessionId?: string;
    projectId?: string;
    agentState?: CliAgentState;
    purpose?: CliSessionPurpose;
  }): CliSession[] {
    if (options?.agentState !== undefined) this.assertAgentState(options.agentState);
    if (options?.purpose !== undefined) this.assertPurpose(options.purpose);
    return [...this.sessions.values()]
      .filter((session) => options?.taskId === undefined || session.taskId === options.taskId)
      .filter((session) => options?.chatSessionId === undefined || session.chatSessionId === options.chatSessionId)
      .filter((session) => options?.projectId === undefined || session.projectId === options.projectId)
      .filter((session) => options?.agentState === undefined || session.agentState === options.agentState)
      .filter((session) => options?.purpose === undefined || session.purpose === options.purpose)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  listByTask(taskId: string): CliSession[] {
    return this.listSessions({ taskId });
  }

  listByChatSession(chatSessionId: string): CliSession[] {
    return this.listSessions({ chatSessionId });
  }

  updateSession(id: string, input: CliSessionUpdateInput): CliSession | undefined {
    const existing = this.sessions.get(id);
    if (!existing) return undefined;
    if (input.agentState !== undefined) this.assertAgentState(input.agentState);
    if (input.terminationReason !== undefined) this.assertTerminationReason(input.terminationReason);
    const updated: CliSession = { ...existing, ...input, updatedAt: new Date().toISOString() };
    this.sessions.set(id, updated);
    this.enqueue(() => this.layer.db
      .update(schema.project.cliSessions)
      .set({
        taskId: updated.taskId,
        chatSessionId: updated.chatSessionId,
        agentState: updated.agentState,
        terminationReason: updated.terminationReason,
        nativeSessionId: updated.nativeSessionId,
        resumeAttempts: updated.resumeAttempts,
        autonomyPosture: updated.autonomyPosture ? JSON.stringify(updated.autonomyPosture) : null,
        worktreePath: updated.worktreePath,
        updatedAt: updated.updatedAt,
      })
      .where(and(
        eq(schema.project.cliSessions.id, id),
        eq(schema.project.cliSessions.ownerProjectId, this.projectId),
      )));
    this.emit("cli-session:updated", updated);
    return updated;
  }

  /**
   * Atomically transition the CCC lifecycle row only when this controller still
   * owns the durable generation. This deliberately bypasses the hydrated cache:
   * independently restarted engines must not let a stale late finalizer write
   * over a replacement controller's state.
   */
  async updateCccSessionForController(
    id: string,
    expectedControllerToken: string,
    input: {
      agentState: CliAgentState;
      terminationReason: CliTerminationReason | null;
      nativeSessionId?: string | null;
      controllerToken?: string;
      controllerFenced?: boolean;
      cancellationState?: string | null;
      nativeCliClosureState?: "held-closed" | "settled" | null;
      nativeCliHeldClosureEvidence?: Readonly<Record<string, unknown>> | null;
    },
  ): Promise<CliSession | undefined> {
    this.assertAgentState(input.agentState);
    this.assertTerminationReason(input.terminationReason);
    await this.flush();
    const updated = await this.layer.transaction(async (tx) => {
      const rows = (await tx.execute(sql`
        SELECT id, task_id AS "taskId", chat_session_id AS "chatSessionId", purpose,
          owner_project_id AS "ownerProjectId", adapter_id AS "adapterId", agent_state AS "agentState",
          termination_reason AS "terminationReason", native_session_id AS "nativeSessionId",
          resume_attempts AS "resumeAttempts", autonomy_posture AS "autonomyPosture",
          worktree_path AS "worktreePath", created_at AS "createdAt", updated_at AS "updatedAt"
        FROM project.cli_sessions
        WHERE owner_project_id = ${this.projectId} AND id = ${id}
        FOR UPDATE
      `)) as unknown as CliSessionRow[];
      const row = rows[0];
      if (!row) return undefined;
      const current = rowToSession(row);
      const posture = current.autonomyPosture ?? {};
      if (posture.cccControllerGeneration !== expectedControllerToken) return undefined;
      const nextPosture: CliAutonomyPosture = {
        ...posture,
        ...(input.controllerToken !== undefined ? { cccControllerGeneration: input.controllerToken } : {}),
        ...(input.controllerFenced !== undefined ? { cccControllerFenced: input.controllerFenced } : {}),
      };
      if (input.cancellationState === null) delete nextPosture.cccCancellationState;
      else if (input.cancellationState !== undefined) nextPosture.cccCancellationState = input.cancellationState;
      if (input.nativeCliClosureState === null) delete nextPosture.cccNativeCliClosureState;
      else if (input.nativeCliClosureState !== undefined) {
        nextPosture.cccNativeCliClosureState = input.nativeCliClosureState;
      }
      if (input.nativeCliHeldClosureEvidence === null) delete nextPosture.cccNativeCliHeldClosureEvidence;
      else if (input.nativeCliHeldClosureEvidence !== undefined) {
        nextPosture.cccNativeCliHeldClosureEvidence = input.nativeCliHeldClosureEvidence;
      }
      const next: CliSession = {
        ...current,
        agentState: input.agentState,
        terminationReason: input.terminationReason,
        ...(input.nativeSessionId !== undefined ? { nativeSessionId: input.nativeSessionId } : {}),
        autonomyPosture: nextPosture,
        updatedAt: new Date().toISOString(),
      };
      await tx.execute(sql`
        UPDATE project.cli_sessions
        SET agent_state = ${next.agentState}, termination_reason = ${next.terminationReason},
          native_session_id = ${next.nativeSessionId},
          autonomy_posture = ${JSON.stringify(nextPosture)}, updated_at = ${next.updatedAt}
        WHERE owner_project_id = ${this.projectId} AND id = ${id}
          AND autonomy_posture::jsonb->>'cccControllerGeneration' = ${expectedControllerToken}
      `);
      return next;
    });
    if (!updated) return undefined;
    this.sessions.set(id, updated);
    this.emit("cli-session:updated", updated);
    return updated;
  }

  /**
   * Settle a provider dispatch and fence its matching one-shot CLI session in
   * the same durable transaction. Provider reconciliation must roll back if
   * the held session no longer proves the same controller custody.
   */
  async settleCccProviderAttemptAndFence(input: {
    reconciliation: CccProviderAttemptReconciliation;
    terminationReason: CliTerminationReason;
    cancellationState?: string | null;
  }): Promise<CccProviderAttemptScope> {
    this.assertTerminationReason(input.terminationReason);
    await this.flush();
    const rootDir = this.options.rootDir;
    if (!rootDir) throw new Error("CCC provider attempt settlement requires a campaign rootDir");
    const campaignAuthorityStore = this.options.campaignAuthorityStore;
    const { terminal, session, changed } = await this.layer.transactionImmediate(async (tx) => {
      let claimedApproval: {
        action: Pick<CccCampaignAuthorityBinding, "actionId" | "actionTarget">;
        claimToken: string;
      } | undefined;
      if (input.reconciliation.outcome === "committed") {
        const initialAttempt = await inspectCccProviderAttempt({
          layer: this.layer,
          rootDir,
          tx,
          taskId: input.reconciliation.taskId,
          attemptKey: input.reconciliation.attemptKey,
        });
        if (initialAttempt?.state === "dispatched_unknown") {
          if (!campaignAuthorityStore) {
            throw new Error("CCC committed provider settlement requires a campaign authority store");
          }
          const action = {
            actionId: initialAttempt.binding.actionId,
            actionTarget: initialAttempt.binding.actionTarget,
          };
          const lease = await campaignAuthorityStore.inspectCccCampaignActionLease(
            initialAttempt.taskId,
            action,
            tx,
          );
          const lockedAttempt = await inspectCccProviderAttempt({
            layer: this.layer,
            rootDir,
            tx,
            taskId: input.reconciliation.taskId,
            attemptKey: input.reconciliation.attemptKey,
          });
          if (lockedAttempt?.state === "dispatched_unknown") {
            if (lease === null) {
              await assertCccProviderFollowOnSettlementCustody({
                layer: this.layer,
                rootDir,
                tx,
                authorityStore: campaignAuthorityStore,
                attempt: lockedAttempt,
              });
            } else if (
              lease.binding.bindingHash !== lockedAttempt.binding.bindingHash
              || lease.lease.bindingHash !== lockedAttempt.binding.bindingHash
              || lease.lease.actionId !== lockedAttempt.binding.actionId
              || lease.lease.actionTarget !== lockedAttempt.binding.actionTarget
            ) {
              throw new Error("CCC committed provider settlement has no exact persisted action lease");
            } else {
              await assertClaimedCccCampaignApprovalWithinTransaction(tx, {
                authorityStore: campaignAuthorityStore,
                rootDir,
                taskId: lockedAttempt.taskId,
                action: {
                  actionId: lockedAttempt.binding.actionId,
                  actionTarget: lockedAttempt.binding.actionTarget,
                },
                approvalRequestId: lease.lease.approvalRequestId,
                claimToken: lease.lease.claimToken,
              });
              claimedApproval = {
                action: {
                  actionId: lockedAttempt.binding.actionId,
                  actionTarget: lockedAttempt.binding.actionTarget,
                },
                claimToken: lease.lease.claimToken,
              };
            }
          }
        }
      }
      let terminal: CccProviderAttemptScope;
      try {
        terminal = await reconcileCccProviderAttempt({
          layer: this.layer,
          rootDir,
          tx,
          reconciliation: input.reconciliation,
        });
      } catch (error) {
        if (error instanceof RunAuditEventCollisionError) {
          throw new RunAuditEventCollisionError(`CCC provider attempt reconciliation collision: ${error.message}`);
        }
        throw error;
      }
      const rows = (await tx.execute(sql`
        SELECT id, task_id AS "taskId", chat_session_id AS "chatSessionId", purpose,
          owner_project_id AS "ownerProjectId", adapter_id AS "adapterId", agent_state AS "agentState",
          termination_reason AS "terminationReason", native_session_id AS "nativeSessionId",
          resume_attempts AS "resumeAttempts", autonomy_posture AS "autonomyPosture",
          worktree_path AS "worktreePath", created_at AS "createdAt", updated_at AS "updatedAt"
        FROM project.cli_sessions
        WHERE owner_project_id = ${this.projectId}
          AND task_id = ${input.reconciliation.taskId}
          AND autonomy_posture::jsonb->>'cccNativeCliOneShot' = 'true'
          AND autonomy_posture::jsonb->>'cccProviderAttemptKey' = ${input.reconciliation.attemptKey}
          AND autonomy_posture::jsonb->>'cccProviderAttemptControllerToken' = ${input.reconciliation.controllerToken}
        FOR UPDATE
      `)) as unknown as CliSessionRow[];
      if (rows.length !== 1) {
        throw new Error(`CCC provider attempt settlement requires exactly one held CLI session; found ${rows.length}`);
      }
      const current = rowToSession(rows[0]!);
      const posture = current.autonomyPosture ?? {};
      if (posture.cccAuthorityBindingHash !== terminal.binding.bindingHash) {
        throw new Error("CCC provider attempt settlement authority binding does not match held CLI session");
      }
      if (posture.cccControllerGeneration !== input.reconciliation.controllerToken) {
        throw new Error("CCC provider attempt settlement controller generation is stale");
      }
      const cancellationMatches = input.cancellationState === undefined
        || (input.cancellationState === null
          ? posture.cccCancellationState === undefined
          : posture.cccCancellationState === input.cancellationState);
      if (
        current.agentState === "dead"
        && current.terminationReason === input.terminationReason
        && posture.cccControllerFenced === true
        && posture.cccNativeCliClosureState === "settled"
        && cancellationMatches
      ) {
        return { terminal, session: current, changed: false };
      }
      if (current.agentState !== "needsAttention" || current.terminationReason !== null) {
        throw new Error("CCC provider attempt settlement requires a held needsAttention CLI session");
      }
      if (posture.cccNativeCliClosureState !== "held-closed" || posture.cccControllerFenced !== false) {
        throw new Error("CCC provider attempt settlement requires an unfenced held-closed CLI session");
      }
      if (claimedApproval) {
        if (!campaignAuthorityStore) {
          throw new Error("CCC committed provider settlement requires a campaign authority store");
        }
        await consumeCccCampaignApprovalWithinTransaction(tx, {
          authorityStore: campaignAuthorityStore,
          rootDir,
          taskId: terminal.taskId,
          action: claimedApproval.action,
          claimToken: claimedApproval.claimToken,
          actor: Object.freeze({
            actorId: "ccc-native-cli-provider",
            actorType: "agent" as const,
            actorName: "CCC native CLI provider settlement",
          }),
          runId: `ccc-cli-provider-settlement:${terminal.taskId}:${terminal.attemptKey}`,
        });
      }
      const nextPosture: CliAutonomyPosture = {
        ...posture,
        cccControllerFenced: true,
        cccNativeCliClosureState: "settled",
      };
      if (input.cancellationState === null) delete nextPosture.cccCancellationState;
      else if (input.cancellationState !== undefined) nextPosture.cccCancellationState = input.cancellationState;
      const updatedAt = new Date().toISOString();
      const updatedRows = (await tx.execute(sql`
        UPDATE project.cli_sessions
        SET agent_state = 'dead', termination_reason = ${input.terminationReason},
          autonomy_posture = ${JSON.stringify(nextPosture)}, updated_at = ${updatedAt}
        WHERE owner_project_id = ${this.projectId}
          AND id = ${current.id}
          AND task_id = ${input.reconciliation.taskId}
          AND agent_state = 'needsAttention'
          AND termination_reason IS NULL
          AND autonomy_posture::jsonb->>'cccNativeCliOneShot' = 'true'
          AND autonomy_posture::jsonb->>'cccNativeCliClosureState' = 'held-closed'
          AND autonomy_posture::jsonb->>'cccControllerFenced' = 'false'
          AND autonomy_posture::jsonb->>'cccProviderAttemptKey' = ${input.reconciliation.attemptKey}
          AND autonomy_posture::jsonb->>'cccProviderAttemptControllerToken' = ${input.reconciliation.controllerToken}
          AND autonomy_posture::jsonb->>'cccAuthorityBindingHash' = ${terminal.binding.bindingHash}
          AND autonomy_posture::jsonb->>'cccControllerGeneration' = ${input.reconciliation.controllerToken}
        RETURNING id, task_id AS "taskId", chat_session_id AS "chatSessionId", purpose,
          owner_project_id AS "ownerProjectId", adapter_id AS "adapterId", agent_state AS "agentState",
          termination_reason AS "terminationReason", native_session_id AS "nativeSessionId",
          resume_attempts AS "resumeAttempts", autonomy_posture AS "autonomyPosture",
          worktree_path AS "worktreePath", created_at AS "createdAt", updated_at AS "updatedAt"
      `)) as unknown as CliSessionRow[];
      if (updatedRows.length !== 1) {
        throw new Error(`CCC provider attempt settlement session fence compare-and-swap lost; updated ${updatedRows.length}`);
      }
      return { terminal, session: rowToSession(updatedRows[0]!), changed: true };
    });
    this.sessions.set(session.id, session);
    if (changed) this.emit("cli-session:updated", session);
    return terminal;
  }

  deleteSession(id: string): boolean {
    if (!this.sessions.delete(id)) return false;
    this.enqueue(() => this.layer.db
      .delete(schema.project.cliSessions)
      .where(and(
        eq(schema.project.cliSessions.id, id),
        eq(schema.project.cliSessions.ownerProjectId, this.projectId),
      )));
    this.emit("cli-session:deleted", id);
    return true;
  }

  /*
  FNXC:CCCEffectReceipts 2026-07-23-21:42:
  Receipt transitions use their own PostgreSQL row and a transaction-scoped
  advisory lock. The session posture cache remains lifecycle metadata only: two
  independently hydrated stores must never coordinate dispatch through it.
  */
  private assertNoLegacyCccReceiptEvidence(effectScopeId: string): void {
    const posture = this.sessions.get(effectScopeId)?.autonomyPosture;
    if (Array.isArray(posture?.cccEffectReceipts) || Array.isArray(posture?.cccEffectReceiptPending)) {
      throw new CccEffectReceiptProtocolError(
        "CCC_EFFECT_LEGACY_RECONCILIATION_REQUIRED",
        `CCC v1 receipt evidence requires reconciliation: ${effectScopeId}`,
      );
    }
  }

  private async lockedCccEffectRows(tx: DbTransaction, effectScopeId: string): Promise<CccEffectReceiptRow[]> {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`fusion:ccc-effect:${this.projectId}:${effectScopeId}`}))`);
    return (await tx.execute(sql`
      SELECT project_id, effect_scope_id, logical_key, turn_key, slot_ordinal, tool_authority, arguments_digest, repeat_of,
        state, controller_token, evidence_digest, result_json,
        campaign_project_id, campaign_import_id, campaign_id, campaign_task_id, campaign_action_id,
        campaign_action_target, campaign_idempotency_key, campaign_packet_hash, campaign_sidecar_hash,
        campaign_bundle_hash, campaign_target_repository, campaign_target_base, campaign_provider_id,
        campaign_model_id, campaign_transport, campaign_manifest_hash, campaign_binding_hash
      FROM project.ccc_effect_receipts
      WHERE owner_project_id = ${this.projectId} AND effect_scope_id = ${effectScopeId}
      FOR UPDATE
    `)) as unknown as CccEffectReceiptRow[];
  }

  /**
   * Resolve campaign custody from the durable session task before taking the
   * effect lock. Callers provide only action/approval identity; the complete
   * binding comes from the TaskStore's persisted import context.
   */
  private async resolveCampaignEffectAuthority(
    tx: DbTransaction,
    input: CccPreparedEffectReceipt,
    options: { requireActiveLease?: boolean; controllerGeneration?: string } = {},
  ): Promise<ResolvedCampaignEffectAuthority | undefined> {
    const sessions = (await tx.execute(sql`
      SELECT task_id, autonomy_posture
      FROM project.cli_sessions
      WHERE owner_project_id = ${this.projectId} AND id = ${input.effectScopeId}
    `)) as unknown as Array<{ task_id: string | null; autonomy_posture: string | null }>;
    const taskId = sessions[0]?.task_id;
    if (!taskId) {
      if (input.campaignClaim) {
        throw new CccEffectReceiptProtocolError(
          "CCC_EFFECT_RECONCILIATION_REQUIRED",
          `CCC campaign receipt has no persisted session task: ${input.effectScopeId}`,
        );
      }
      return undefined;
    }
    const authorityStore = this.options.campaignAuthorityStore;
    if (!authorityStore) {
    const campaignRows = (await tx.execute(sql`
      SELECT 1
      FROM project.ccc_prd_import_entities entities
      INNER JOIN project.ccc_prd_imports imports
        ON imports.project_id = entities.project_id
        AND imports.import_id = entities.import_id
      WHERE entities.project_id = ${this.projectId}
        AND entities.entity_type = 'task'
        AND entities.native_id = ${taskId}
      LIMIT 2
    `)) as unknown as Array<{ "?column?": number }>;
      if (campaignRows.length > 0 || input.campaignClaim) {
      throw new CccEffectReceiptProtocolError(
        "CCC_EFFECT_RECONCILIATION_REQUIRED",
          `CCC campaign receipt requires a campaign authority store: ${input.effectScopeId}`,
      );
    }
      return undefined;
    }
    const context = await authorityStore.getCccCampaignContextForTaskWithinTransaction(tx, taskId);
    if (!context) {
      if (input.campaignClaim) {
        throw new CccEffectReceiptProtocolError(
          "CCC_EFFECT_RECONCILIATION_REQUIRED",
          `CCC campaign receipt has no persisted campaign context: ${input.effectScopeId}`,
        );
      }
      return undefined;
    }
    let canonicalRootDir: string;
    try {
      canonicalRootDir = this.options.rootDir ? await realpath(this.options.rootDir) : "";
    } catch {
      canonicalRootDir = "";
    }
    if (!canonicalRootDir || canonicalRootDir !== context.targetRepository.path) {
      throw new CccEffectReceiptProtocolError(
        "CCC_EFFECT_RECONCILIATION_REQUIRED",
        `CCC campaign receipt root does not match persisted target: ${input.effectScopeId}`,
      );
    }
    if (!input.campaignClaim) {
      throw new CccEffectReceiptProtocolError(
        "CCC_EFFECT_RECONCILIATION_REQUIRED",
        `CCC campaign receipt requires action and approval identity: ${input.effectScopeId}`,
      );
    }
    const binding = createCccCampaignAuthorityBinding(context, {
      actionId: input.campaignClaim.actionId,
      actionTarget: input.campaignClaim.actionTarget,
      requireProtected: true,
    });
    if (options.controllerGeneration !== undefined
      && parsePosture(sessions[0]?.autonomy_posture ?? null)?.cccControllerGeneration !== options.controllerGeneration) {
      throw new CccEffectReceiptProtocolError(
        "CCC_EFFECT_RECONCILIATION_REQUIRED",
        `CCC campaign receipt controller generation does not match persisted session: ${input.effectScopeId}`,
      );
    }
    if (options.requireActiveLease === false) {
      return {
        taskId,
        claim: input.campaignClaim,
        authority: { binding },
      };
    }
    const lease = await authorityStore.inspectCccCampaignActionLease(
      taskId,
      { actionId: input.campaignClaim.actionId, actionTarget: input.campaignClaim.actionTarget },
      tx,
    );
    if (!lease
      || lease.binding.bindingHash !== binding.bindingHash
      || lease.lease.approvalRequestId !== input.campaignClaim.approvalRequestId
      || lease.lease.claimToken !== input.campaignClaim.claimToken) {
      throw new CccEffectReceiptProtocolError(
        "CCC_EFFECT_RECONCILIATION_REQUIRED",
        `CCC campaign receipt action lease does not match the claimed approval: ${input.effectScopeId}`,
      );
    }
    return {
      taskId,
      claim: input.campaignClaim,
      authority: { binding },
    };
  }

  private async priorControllerIsDurablyFenced(
    tx: DbTransaction,
    effectScopeId: string,
    controllerToken: string,
  ): Promise<boolean> {
    const rows = (await tx.execute(sql`
      SELECT agent_state, autonomy_posture
      FROM project.cli_sessions
      WHERE owner_project_id = ${this.projectId} AND id = ${effectScopeId}
      FOR UPDATE
    `)) as unknown as Array<{ agent_state: string; autonomy_posture: string | null }>;
    const row = rows[0];
    if (!row || row.agent_state !== "dead") return false;
    const posture = parsePosture(row.autonomy_posture);
    return posture?.cccControllerGeneration === controllerToken
      && posture?.cccControllerFenced === true;
  }

  async openCccEffectTurn(effectScopeId: string, controllerToken: string): Promise<CccEffectTurn> {
    this.assertNoLegacyCccReceiptEvidence(effectScopeId);
    return this.layer.transaction(async (tx) => {
      await this.lockedCccEffectRows(tx, effectScopeId);
      const rows = (await tx.execute(sql`
        SELECT effect_scope_id, turn_key, state, controller_token
        FROM project.ccc_effect_turns
        WHERE owner_project_id = ${this.projectId} AND effect_scope_id = ${effectScopeId} AND state = 'open'
        FOR UPDATE
      `)) as unknown as Array<{ effect_scope_id: string; turn_key: string; state: "open" | "closed"; controller_token: string }>;
      const current = rows[0];
      if (current) {
        if (current.controller_token === controllerToken) {
          return { effectScopeId, turnKey: current.turn_key, state: current.state, controllerToken };
        }
        if (!await this.priorControllerIsDurablyFenced(tx, effectScopeId, current.controller_token)) {
          throw new CccEffectReceiptPendingError(current.turn_key);
        }
        const now = new Date().toISOString();
        await tx.execute(sql`
          UPDATE project.ccc_effect_turns
          SET controller_token = ${controllerToken}, updated_at = ${now}
          WHERE owner_project_id = ${this.projectId} AND effect_scope_id = ${effectScopeId}
            AND turn_key = ${current.turn_key} AND state = 'open' AND controller_token = ${current.controller_token}
        `);
        return { effectScopeId, turnKey: current.turn_key, state: "open", controllerToken };
      }
      const turnKey = randomUUID();
      const now = new Date().toISOString();
      await tx.execute(sql`
        INSERT INTO project.ccc_effect_turns (
          owner_project_id, effect_scope_id, turn_key, state, controller_token, created_at, updated_at
        ) VALUES (${this.projectId}, ${effectScopeId}, ${turnKey}, 'open', ${controllerToken}, ${now}, ${now})
      `);
      return { effectScopeId, turnKey, state: "open", controllerToken };
    });
  }

  async closeCccEffectTurn(effectScopeId: string, turnKey: string, controllerToken: string): Promise<void> {
    await this.layer.transaction(async (tx) => {
      await this.lockedCccEffectRows(tx, effectScopeId);
      const now = new Date().toISOString();
      await tx.execute(sql`
        UPDATE project.ccc_effect_turns SET state = 'closed', updated_at = ${now}
        WHERE owner_project_id = ${this.projectId} AND effect_scope_id = ${effectScopeId}
          AND turn_key = ${turnKey} AND state = 'open' AND controller_token = ${controllerToken}
      `);
    });
  }

  private assertReceiptCompatibility(
    input: CccPreparedEffectReceipt,
    existing: CccEffectReceiptRow,
    campaign: ResolvedCampaignEffectAuthority | undefined,
  ): void {
    if (existing.tool_authority !== input.toolAuthority
      || existing.arguments_digest !== input.argumentsDigest
      || existing.repeat_of !== input.repeatOf) {
      throw new CccEffectReceiptProtocolError(
        "CCC_EFFECT_KEY_COLLISION",
        `CCC effect key collision: ${input.logicalKey}`,
      );
    }
    const persistedCampaign = campaignAuthorityFromRow(existing);
    if (!persistedCampaign && !campaign) return;
    if (!persistedCampaign || !campaign
      || persistedCampaign.binding.bindingHash !== campaign.authority.binding.bindingHash) {
      throw new CccEffectReceiptProtocolError(
        "CCC_EFFECT_KEY_COLLISION",
        `CCC campaign effect authority collision: ${input.logicalKey}`,
      );
    }
  }

  async reserveCccEffectReceipt(input: CccPreparedEffectReceipt): Promise<CccEffectReceiptRecord> {
    this.assertNoLegacyCccReceiptEvidence(input.effectScopeId);
    return this.layer.transactionImmediate(async (tx) => {
      const campaign = await this.resolveCampaignEffectAuthority(tx, input, { requireActiveLease: false });
      const authorityStore = this.options.campaignAuthorityStore;
      const rootDir = this.options.rootDir;
      const claim = input.campaignClaim;
      let approvalState: "claimed" | "consumed" | "expired" | undefined;
      let approvalFailure: unknown;
      if (campaign) {
        if (!authorityStore || !rootDir || !claim) {
          throw new CccEffectReceiptProtocolError(
            "CCC_EFFECT_RECONCILIATION_REQUIRED",
            `CCC campaign receipt has no complete approval custody: ${input.logicalKey}`,
          );
        }
        const approvalInput = {
          authorityStore,
          rootDir,
          taskId: campaign.taskId,
          action: { actionId: claim.actionId, actionTarget: claim.actionTarget },
          approvalRequestId: claim.approvalRequestId,
          claimToken: claim.claimToken,
        };
        try {
          const approved = await assertClaimedCccCampaignApprovalWithinTransaction(tx, approvalInput);
          if (approved.binding.bindingHash !== campaign.authority.binding.bindingHash) throw new CccEffectReceiptProtocolError(
            "CCC_EFFECT_KEY_COLLISION", `CCC campaign receipt approval binding drift: ${input.logicalKey}`,
          );
          approvalState = "claimed";
        } catch {
          try {
            const approved = await assertConsumedCccCampaignApprovalWithinTransaction(tx, approvalInput);
            if (approved.binding.bindingHash !== campaign.authority.binding.bindingHash) throw new CccEffectReceiptProtocolError(
              "CCC_EFFECT_KEY_COLLISION", `CCC campaign receipt approval binding drift: ${input.logicalKey}`,
            );
            approvalState = "consumed";
          } catch {
            try {
              const approved = await assertExpiredCccCampaignApprovalWithinTransaction(tx, approvalInput);
              if (approved.binding.bindingHash !== campaign.authority.binding.bindingHash) throw new CccEffectReceiptProtocolError(
                "CCC_EFFECT_KEY_COLLISION", `CCC campaign receipt approval binding drift: ${input.logicalKey}`,
              );
              approvalState = "expired";
            } catch (error) {
              approvalFailure = error;
            }
          }
        }
      }
      const rows = await this.lockedCccEffectRows(tx, input.effectScopeId);
      const unresolvedDispatch = rows.find((row) => row.state === "dispatched_unknown");
      if (unresolvedDispatch) {
        throw new CccEffectReceiptPendingError(unresolvedDispatch.logical_key);
      }
      const sameKey = rows.find((row) => row.logical_key === input.logicalKey);
      if (sameKey) {
        this.assertReceiptCompatibility(input, sameKey, campaign);
        if (sameKey.state === "committed") {
          if (campaign && approvalState !== "consumed") throw approvalFailure ?? new CccEffectReceiptProtocolError(
            "CCC_EFFECT_RECONCILIATION_REQUIRED",
            `CCC campaign committed receipt requires exact consumed approval: ${input.logicalKey}`,
          );
          return receiptFromRow(sameKey);
        }
        if (sameKey.state === "reserved" && sameKey.controller_token === input.controllerToken) {
          if (campaign && approvalState !== "claimed") throw approvalFailure ?? new CccEffectReceiptProtocolError(
            "CCC_EFFECT_RECONCILIATION_REQUIRED",
            `CCC campaign reservation requires exact claimed approval: ${input.logicalKey}`,
          );
          return receiptFromRow(sameKey);
        }
        if (campaign && sameKey.state === "reserved") {
          // A campaign claim can never be transferred merely because a prior
          // controller was fenced. Reconciliation must first establish whether
          // the protected action crossed dispatch.
          throw new CccEffectReceiptPendingError(input.logicalKey);
        }
        // proved_failed is the durable, explicit fence for a controller that
        // never crossed dispatch. It is the only takeover path; elapsed time
        // is deliberately absent from this state machine.
        if (sameKey.state === "proved_failed" || (
          sameKey.state === "reserved"
          && await this.priorControllerIsDurablyFenced(tx, input.effectScopeId, sameKey.controller_token)
        )) {
          if (campaign && approvalState !== "claimed") throw approvalFailure ?? new CccEffectReceiptProtocolError(
            "CCC_EFFECT_RECONCILIATION_REQUIRED",
            `CCC campaign retry requires exact claimed approval: ${input.logicalKey}`,
          );
          const now = new Date().toISOString();
          const updated = (await tx.execute(sql`
            UPDATE project.ccc_effect_receipts
            SET state = 'reserved', controller_token = ${input.controllerToken}, evidence_digest = NULL,
              result_json = NULL, updated_at = ${now}
            WHERE owner_project_id = ${this.projectId}
              AND effect_scope_id = ${input.effectScopeId}
              AND logical_key = ${input.logicalKey}
              AND controller_token = ${sameKey.controller_token}
              AND state = ${sameKey.state}
            RETURNING *
          `)) as unknown as CccEffectReceiptRow[];
          if (updated.length !== 1) {
            throw new CccEffectReceiptProtocolError(
              "CCC_EFFECT_RECONCILIATION_REQUIRED",
              `CCC effect receipt takeover lost compare-and-swap: ${input.logicalKey}`,
            );
          }
          return receiptFromRow(updated[0]!);
        }
        throw new CccEffectReceiptPendingError(input.logicalKey);
      }
      // A new durable turn is an explicit Fusion-owned repeat boundary. The
      // ambiguity guard applies only within the same recovered turn, never
      // across a separately opened prompt/turn.
      const priorSameIntent = rows.find((row) => row.state === "committed"
        // Legacy envelope callers have no recoverable turn boundary. Keep
        // their conservative scope-wide ambiguity rule while production
        // Fusion-owned turn/slot callers can intentionally repeat in a new
        // durable turn.
        && (input.turnKey.startsWith("legacy:") || row.turn_key === input.turnKey)
        && row.tool_authority === input.toolAuthority
        && row.arguments_digest === input.argumentsDigest);
      if (priorSameIntent && input.repeatOf !== priorSameIntent.logical_key) {
        throw new CccEffectReceiptProtocolError(
          "CCC_EFFECT_AMBIGUOUS_DUPLICATE",
          `CCC effect repeats committed intent without repeatOf: ${input.logicalKey}`,
        );
      }
      if (input.repeatOf) {
        const repeated = rows.find((row) => row.logical_key === input.repeatOf);
        if (!repeated || repeated.state !== "committed") {
          throw new CccEffectReceiptProtocolError(
            "CCC_EFFECT_AMBIGUOUS_DUPLICATE",
            `CCC effect repeatOf must name a committed effect: ${input.repeatOf}`,
          );
        }
      }
      if (campaign && approvalState !== "claimed") {
        throw approvalFailure ?? new CccEffectReceiptProtocolError(
          "CCC_EFFECT_RECONCILIATION_REQUIRED",
          `CCC campaign reservation requires exact claimed approval: ${input.logicalKey}`,
        );
      }
      const now = new Date().toISOString();
      const inserted = (await tx.execute(sql`
        INSERT INTO project.ccc_effect_receipts (
          owner_project_id, effect_scope_id, logical_key, turn_key, slot_ordinal, tool_authority,
          arguments_digest, repeat_of, state, controller_token, created_at, updated_at,
          campaign_project_id, campaign_import_id, campaign_id, campaign_task_id, campaign_action_id,
          campaign_action_target, campaign_idempotency_key, campaign_packet_hash, campaign_sidecar_hash,
          campaign_bundle_hash, campaign_target_repository, campaign_target_base, campaign_provider_id,
          campaign_model_id, campaign_transport, campaign_manifest_hash, campaign_binding_hash
        ) VALUES (
          ${this.projectId}, ${input.effectScopeId}, ${input.logicalKey}, ${input.turnKey}, ${input.slotOrdinal}, ${input.toolAuthority},
          ${input.argumentsDigest}, ${input.repeatOf}, 'reserved', ${input.controllerToken}, ${now}, ${now},
          ${campaign?.authority.binding.projectId ?? null}, ${campaign?.authority.binding.importId ?? null},
          ${campaign?.authority.binding.campaignId ?? null}, ${campaign?.authority.binding.taskId ?? null},
          ${campaign?.authority.binding.actionId ?? null}, ${campaign?.authority.binding.actionTarget ?? null},
          ${campaign?.authority.binding.idempotencyKey ?? null}, ${campaign?.authority.binding.packetHash ?? null},
          ${campaign?.authority.binding.sidecarHash ?? null}, ${campaign?.authority.binding.bundleHash ?? null},
          ${campaign?.authority.binding.targetRepository ?? null}, ${campaign?.authority.binding.targetBase ?? null},
          ${campaign?.authority.binding.providerId ?? null}, ${campaign?.authority.binding.modelId ?? null},
          ${campaign?.authority.binding.transport ?? null}, ${campaign?.authority.binding.manifestHash ?? null},
          ${campaign?.authority.binding.bindingHash ?? null}
        )
        RETURNING *
      `)) as unknown as CccEffectReceiptRow[];
      if (inserted.length !== 1) {
        throw new CccEffectReceiptProtocolError(
          "CCC_EFFECT_RECONCILIATION_REQUIRED",
          `CCC effect receipt reservation lost insert: ${input.logicalKey}`,
        );
      }
      return receiptFromRow(inserted[0]!);
    });
  }

  async markCccEffectReceiptDispatched(input: CccPreparedEffectReceipt): Promise<CccEffectReceiptRecord> {
    return this.transitionCccEffectReceipt(input, "reserved", "dispatched_unknown");
  }

  async commitCccEffectReceipt(input: CccPreparedEffectReceipt, result?: unknown): Promise<CccEffectReceiptRecord> {
    return this.transitionCccEffectReceipt(input, "dispatched_unknown", "committed", result);
  }

  async proveCccEffectReceiptFailed(input: CccPreparedEffectReceipt): Promise<CccEffectReceiptRecord> {
    return this.transitionCccEffectReceipt(input, "reserved", "proved_failed");
  }

  private async transitionCccEffectReceipt(
    input: CccPreparedEffectReceipt,
    expected: CccEffectReceiptRecord["state"],
    next: CccEffectReceiptRecord["state"],
    result?: unknown,
  ): Promise<CccEffectReceiptRecord> {
    this.assertNoLegacyCccReceiptEvidence(input.effectScopeId);
    return this.layer.transactionImmediate(async (tx) => {
      const campaign = await this.resolveCampaignEffectAuthority(tx, input, {
        requireActiveLease: next === "committed" ? false : true,
      });
      const authorityStore = this.options.campaignAuthorityStore;
      const rootDir = this.options.rootDir;
      let approvalState: "claimed" | "consumed" | undefined;
      if (campaign && next === "committed") {
        if (!authorityStore || !rootDir || !input.campaignClaim) {
          throw new CccEffectReceiptProtocolError(
            "CCC_EFFECT_RECONCILIATION_REQUIRED",
            `CCC campaign receipt has no complete approval custody: ${input.logicalKey}`,
          );
        }
        const approvalInput = {
          authorityStore,
          rootDir,
          taskId: campaign.taskId,
          action: {
            actionId: input.campaignClaim.actionId,
            actionTarget: input.campaignClaim.actionTarget,
          },
          approvalRequestId: input.campaignClaim.approvalRequestId,
          claimToken: input.campaignClaim.claimToken,
        };
        let approval;
        try {
          approval = await assertClaimedCccCampaignApprovalWithinTransaction(tx, approvalInput);
          approvalState = "claimed";
        } catch {
          approval = await assertConsumedCccCampaignApprovalWithinTransaction(tx, approvalInput);
          approvalState = "consumed";
        }
        if (approval.binding.bindingHash !== campaign.authority.binding.bindingHash) {
          throw new CccEffectReceiptProtocolError(
            "CCC_EFFECT_KEY_COLLISION",
            `CCC campaign receipt approval binding drift: ${input.logicalKey}`,
          );
        }
      }
      const rows = await this.lockedCccEffectRows(tx, input.effectScopeId);
      const existing = rows.find((row) => row.logical_key === input.logicalKey);
      if (!existing) throw new CccEffectReceiptProtocolError("CCC_EFFECT_RECONCILIATION_REQUIRED", `CCC effect receipt is missing: ${input.logicalKey}`);
      this.assertReceiptCompatibility(input, existing, campaign);
      if (campaign && next === "proved_failed") {
        throw new CccEffectReceiptProtocolError(
          "CCC_EFFECT_RECONCILIATION_REQUIRED",
          `CCC campaign receipt requires authoritative reconciliation: ${input.logicalKey}`,
        );
      }
      if (existing.state === next) {
        if (campaign && next === "committed") {
          const expectedEvidence = directCommitEvidenceDigest(input, result ?? null);
          if (approvalState !== "consumed"
            || existing.result_json !== canonicalCccEffectJson(result ?? null)
            || existing.evidence_digest !== expectedEvidence) {
            throw new CccEffectReceiptProtocolError(
              "CCC_EFFECT_KEY_COLLISION",
              `CCC campaign direct-commit replay collision: ${input.logicalKey}`,
            );
          }
        }
        return receiptFromRow(existing);
      }
      if (existing.state !== expected || existing.controller_token !== input.controllerToken) {
        throw new CccEffectReceiptPendingError(input.logicalKey);
      }
      // Compatibility callers that only need a durable execution marker did not
      // historically provide a result. Persist JSON null, never an undefined or
      // fabricated success payload; production effect boundaries always provide
      // their actual structured result before replying.
      const resultJson = next === "committed" ? canonicalCccEffectJson(result ?? null) : null;
      if (resultJson !== null && Buffer.byteLength(resultJson, "utf8") > 65_536) {
        throw new CccEffectReceiptProtocolError("CCC_EFFECT_RECONCILIATION_REQUIRED", "CCC effect result exceeds the durable replay bound");
      }
      const now = new Date().toISOString();
      if (campaign && next === "committed") {
        if (approvalState !== "claimed") {
          throw new CccEffectReceiptProtocolError(
            "CCC_EFFECT_RECONCILIATION_REQUIRED",
            `CCC campaign receipt is consumed without a committed effect: ${input.logicalKey}`,
          );
        }
        await consumeCccCampaignApprovalWithinTransaction(tx, {
          authorityStore: authorityStore!,
          rootDir: rootDir!,
          taskId: campaign.taskId,
          action: {
            actionId: input.campaignClaim!.actionId,
            actionTarget: input.campaignClaim!.actionTarget,
          },
          actor: { actorId: "ccc-effect-direct", actorType: "agent", actorName: "CCC effect receipt" },
          runId: `ccc-effect-direct:${input.effectScopeId}:${input.logicalKey}`,
          claimToken: input.campaignClaim!.claimToken,
        });
      }
      const evidenceDigest = campaign && next === "committed"
        ? directCommitEvidenceDigest(input, result ?? null)
        : null;
      const updated = (await tx.execute(sql`
        UPDATE project.ccc_effect_receipts
        SET state = ${next}, result_json = ${resultJson}, evidence_digest = ${evidenceDigest}, updated_at = ${now}
        WHERE owner_project_id = ${this.projectId}
          AND effect_scope_id = ${input.effectScopeId}
          AND logical_key = ${input.logicalKey}
          AND controller_token = ${input.controllerToken}
          AND state = ${expected}
        RETURNING *
      `)) as unknown as CccEffectReceiptRow[];
      if (updated.length !== 1) {
        throw new CccEffectReceiptProtocolError(
          "CCC_EFFECT_RECONCILIATION_REQUIRED",
          `CCC effect receipt transition lost compare-and-swap: ${input.logicalKey}`,
        );
      }
      if (campaign && next === "committed") {
        await recordRunAuditEventWithinTransaction(tx, {
          timestamp: now,
          taskId: campaign.taskId,
          agentId: "ccc-effect-direct",
          runId: `ccc-effect-direct:${input.effectScopeId}:${input.logicalKey}`,
          domain: "ccc-effect",
          mutationType: "effect-receipt:committed",
          target: campaign.authority.binding.actionTarget,
          metadata: {
            effectScopeId: input.effectScopeId,
            logicalKey: input.logicalKey,
            evidenceDigest,
            outcome: "committed",
          },
          campaign: {
            eventKey: `ccc-effect-direct:${campaign.authority.binding.bindingHash}:${input.effectScopeId}:${input.logicalKey}:${evidenceDigest}`,
            binding: campaign.authority.binding,
          },
        });
      }
      return receiptFromRow(updated[0]!);
    });
  }

  private reconciledCampaignReceipt(
    existing: CccEffectReceiptRow,
    input: CccPreparedEffectReceiptReconciliation,
    campaign: ResolvedCampaignEffectAuthority,
    evidenceDigest: string,
  ): CccEffectReceiptRecord | undefined {
    if (existing.state !== "committed" && existing.state !== "proved_failed") return undefined;
    this.assertReceiptCompatibility(input.receipt, existing, campaign);
    const expectedState = input.observation.kind === "committed" ? "committed" : "proved_failed";
    const expectedResult = input.observation.kind === "committed"
      ? canonicalCccEffectJson(input.observation.result)
      : null;
    if (existing.state !== expectedState
      || existing.evidence_digest !== evidenceDigest
      || existing.result_json !== expectedResult) {
      throw new CccEffectReceiptProtocolError(
        "CCC_EFFECT_KEY_COLLISION",
        `CCC campaign reconciliation evidence collision: ${input.receipt.logicalKey}`,
      );
    }
    return receiptFromRow(existing);
  }

  /**
   * Resolve an unknown protected effect from a local observer. Campaign/import
   * and approval locks are acquired before the receipt lock; a committed
   * result consumes and settles the exact claim in the same transaction.
   */
  async reconcileCccEffectReceipt(input: CccPreparedEffectReceiptReconciliation): Promise<CccEffectReceiptRecord> {
    this.assertNoLegacyCccReceiptEvidence(input.receipt.effectScopeId);
    return this.layer.transactionImmediate(async (tx) => {
      const campaign = await this.resolveCampaignEffectAuthority(tx, input.receipt, {
        requireActiveLease: false,
        controllerGeneration: input.controllerGeneration,
      });
      const claim = input.receipt.campaignClaim;
      if (!campaign || !claim) {
        throw new CccEffectReceiptProtocolError(
          "CCC_EFFECT_RECONCILIATION_REQUIRED",
          `CCC effect reconciliation requires persisted campaign authority: ${input.receipt.logicalKey}`,
        );
      }
      const authorityStore = this.options.campaignAuthorityStore;
      const rootDir = this.options.rootDir;
      if (!authorityStore || !rootDir) {
        throw new CccEffectReceiptProtocolError(
          "CCC_EFFECT_RECONCILIATION_REQUIRED",
          `CCC effect reconciliation requires campaign custody dependencies: ${input.receipt.logicalKey}`,
        );
      }
      const action = {
        actionId: claim.actionId,
        actionTarget: claim.actionTarget,
      };
      const evidenceDigest = reconciliationEvidenceDigest(input);
      let claimedApproval: Awaited<ReturnType<typeof assertClaimedCccCampaignApprovalWithinTransaction>> | undefined;
      let consumedApproval: Awaited<ReturnType<typeof assertConsumedCccCampaignApprovalWithinTransaction>> | undefined;
      let expiredApproval: Awaited<ReturnType<typeof assertExpiredCccCampaignApprovalWithinTransaction>> | undefined;
      let claimFailure: unknown;
      try {
        claimedApproval = await assertClaimedCccCampaignApprovalWithinTransaction(tx, {
          authorityStore,
          rootDir,
          taskId: campaign.taskId,
          action,
          approvalRequestId: claim.approvalRequestId,
          claimToken: claim.claimToken,
        });
        if (claimedApproval.binding.bindingHash !== campaign.authority.binding.bindingHash) {
          throw new CccEffectReceiptProtocolError(
            "CCC_EFFECT_KEY_COLLISION",
            `CCC campaign reconciliation binding drift: ${input.receipt.logicalKey}`,
          );
        }
      } catch {
        try {
          consumedApproval = await assertConsumedCccCampaignApprovalWithinTransaction(tx, {
            authorityStore,
            rootDir,
            taskId: campaign.taskId,
            action,
            approvalRequestId: claim.approvalRequestId,
            claimToken: claim.claimToken,
          });
          if (consumedApproval.binding.bindingHash !== campaign.authority.binding.bindingHash) {
            throw new CccEffectReceiptProtocolError(
              "CCC_EFFECT_KEY_COLLISION",
              `CCC campaign reconciliation binding drift: ${input.receipt.logicalKey}`,
            );
          }
        } catch (error) {
          try {
            expiredApproval = await assertExpiredCccCampaignApprovalWithinTransaction(tx, {
              authorityStore,
              rootDir,
              taskId: campaign.taskId,
              action,
              approvalRequestId: claim.approvalRequestId,
              claimToken: claim.claimToken,
            });
            if (expiredApproval.binding.bindingHash !== campaign.authority.binding.bindingHash) {
              throw new CccEffectReceiptProtocolError(
                "CCC_EFFECT_KEY_COLLISION",
                `CCC campaign reconciliation binding drift: ${input.receipt.logicalKey}`,
              );
            }
          } catch (expiredError) {
            claimFailure = expiredError ?? error;
          }
        }
      }

      const rows = await this.lockedCccEffectRows(tx, input.receipt.effectScopeId);
      const existing = rows.find((row) => row.logical_key === input.receipt.logicalKey);
      if (!existing) {
        throw new CccEffectReceiptProtocolError(
          "CCC_EFFECT_RECONCILIATION_REQUIRED",
          `CCC effect receipt is missing: ${input.receipt.logicalKey}`,
        );
      }
      const expireProvedFailureIfDue = async (): Promise<void> => {
        if (!claimedApproval) return;
        const databaseNowRows = (await tx.execute(sql`SELECT clock_timestamp()::text AS now`)) as unknown as Array<{ now: string }>;
        const databaseNow = databaseNowRows[0]?.now;
        if (!databaseNow || Date.parse(databaseNow) < Date.parse(claimedApproval.approval.campaign!.expiresAt)) return;
        await expireClaimedCccCampaignApprovalAfterProvedNoEffectWithinTransaction(tx, {
          authorityStore,
          rootDir,
          taskId: campaign.taskId,
          action,
          approvalRequestId: claim.approvalRequestId,
          claimToken: claim.claimToken,
          actor: input.actor,
          runId: input.runId,
          effectScopeId: input.receipt.effectScopeId,
          logicalKey: input.receipt.logicalKey,
        });
        expiredApproval = await assertExpiredCccCampaignApprovalWithinTransaction(tx, {
          authorityStore,
          rootDir,
          taskId: campaign.taskId,
          action,
          approvalRequestId: claim.approvalRequestId,
          claimToken: claim.claimToken,
        });
        claimedApproval = undefined;
      };
      if (existing.state === "proved_failed" && input.observation.kind === "no_effect") {
        await expireProvedFailureIfDue();
      }
      if (existing.state === "committed" && !consumedApproval) {
        // A terminal replay is allowed only after the approval-owned consumed
        // verifier proves the same request/token against native custody.
        throw claimFailure ?? new CccEffectReceiptProtocolError(
          "CCC_EFFECT_RECONCILIATION_REQUIRED",
          `CCC campaign committed replay requires approval terminal verification: ${input.receipt.logicalKey}`,
        );
      }
      if (existing.state === "proved_failed" && !claimedApproval) {
        if (!expiredApproval) throw claimFailure ?? new CccEffectReceiptProtocolError(
          "CCC_EFFECT_RECONCILIATION_REQUIRED",
          `CCC campaign proved-failed replay requires approval terminal verification: ${input.receipt.logicalKey}`,
        );
      }
      const replay = this.reconciledCampaignReceipt(existing, input, campaign, evidenceDigest);
      if (replay) return replay;
      if (claimFailure !== undefined) throw claimFailure;
      this.assertReceiptCompatibility(input.receipt, existing, campaign);
      if (existing.state !== "dispatched_unknown" || existing.controller_token !== input.receipt.controllerToken) {
        throw new CccEffectReceiptPendingError(input.receipt.logicalKey);
      }
      if (!claimedApproval) {
        throw new CccEffectReceiptProtocolError(
          "CCC_EFFECT_RECONCILIATION_REQUIRED",
          `CCC campaign receipt is settled without a terminal receipt: ${input.receipt.logicalKey}`,
        );
      }

      const next = input.observation.kind === "committed" ? "committed" : "proved_failed";
      const resultJson = input.observation.kind === "committed"
        ? canonicalCccEffectJson(input.observation.result)
        : null;
      if (next === "committed") {
        // This helper holds campaign/import then approval before this method
        // takes the receipt transition, and rolls the consume/lease-settle
        // back if the receipt compare-and-swap loses.
        await consumeCccCampaignApprovalWithinTransaction(tx, {
          authorityStore,
          rootDir,
          taskId: campaign.taskId,
          action,
          actor: input.actor,
          runId: input.runId,
          claimToken: claim.claimToken,
        });
      }
      const now = new Date().toISOString();
      const updated = (await tx.execute(sql`
        UPDATE project.ccc_effect_receipts
        SET state = ${next}, result_json = ${resultJson}, evidence_digest = ${evidenceDigest}, updated_at = ${now}
        WHERE project_id = ${campaign.authority.binding.projectId}
          AND owner_project_id = ${this.projectId}
          AND effect_scope_id = ${input.receipt.effectScopeId}
          AND logical_key = ${input.receipt.logicalKey}
          AND controller_token = ${input.receipt.controllerToken}
          AND state = 'dispatched_unknown'
          AND campaign_binding_hash = ${campaign.authority.binding.bindingHash}
        RETURNING *
      `)) as unknown as CccEffectReceiptRow[];
      if (updated.length !== 1) {
        throw new CccEffectReceiptProtocolError(
          "CCC_EFFECT_RECONCILIATION_REQUIRED",
          `CCC campaign reconciliation lost receipt compare-and-swap: ${input.receipt.logicalKey}`,
        );
      }
      if (next === "proved_failed") await expireProvedFailureIfDue();
      await recordRunAuditEventWithinTransaction(tx, {
        timestamp: now,
        taskId: campaign.taskId,
        agentId: input.actor.actorId,
        runId: input.runId,
        domain: "ccc-effect",
        mutationType: `effect-receipt:${next}`,
        target: campaign.authority.binding.actionTarget,
        metadata: {
          effectScopeId: input.receipt.effectScopeId,
          logicalKey: input.receipt.logicalKey,
          observerId: input.observerId,
          observationDigest: input.observationDigest,
          evidenceDigest,
          outcome: next,
        },
        campaign: {
          eventKey: `ccc-effect:${campaign.authority.binding.bindingHash}:${input.receipt.effectScopeId}:${input.receipt.logicalKey}:${next}:${evidenceDigest}`,
          binding: campaign.authority.binding,
        },
      });
      return receiptFromRow(updated[0]!);
    });
  }

  async getCccEffectReceipt(effectScopeId: string, logicalKey: string): Promise<CccEffectReceiptRecord | undefined> {
    const rows = (await this.layer.db.execute(sql`
      SELECT project_id, effect_scope_id, logical_key, turn_key, slot_ordinal, tool_authority, arguments_digest, repeat_of,
        state, controller_token, evidence_digest, result_json,
        campaign_project_id, campaign_import_id, campaign_id, campaign_task_id, campaign_action_id,
        campaign_action_target, campaign_idempotency_key, campaign_packet_hash, campaign_sidecar_hash,
        campaign_bundle_hash, campaign_target_repository, campaign_target_base, campaign_provider_id,
        campaign_model_id, campaign_transport, campaign_manifest_hash, campaign_binding_hash
      FROM project.ccc_effect_receipts
      WHERE owner_project_id = ${this.projectId}
        AND effect_scope_id = ${effectScopeId}
        AND logical_key = ${logicalKey}
    `)) as unknown as CccEffectReceiptRow[];
    return rows[0] ? receiptFromRow(rows[0]) : undefined;
  }
}
