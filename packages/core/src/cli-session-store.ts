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
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { and, desc, eq, sql } from "drizzle-orm";
import * as schema from "./postgres/schema/index.js";
import type { AsyncDataLayer, DbTransaction } from "./postgres/data-layer.js";
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
  type CccEffectTurn,
  type CccEffectReceiptRecord,
  type CccPreparedEffectReceipt,
} from "./ccc-effect-receipts.js";

export interface CliSessionStoreEvents {
  "cli-session:created": [session: CliSession];
  "cli-session:updated": [session: CliSession];
  "cli-session:deleted": [sessionId: string];
}

type CliSessionRow = typeof schema.project.cliSessions.$inferSelect;

type CccEffectReceiptRow = {
  effect_scope_id: string;
  logical_key: string;
  turn_key: string;
  slot_ordinal: number;
  tool_authority: string;
  arguments_digest: string;
  repeat_of: string | null;
  state: CccEffectReceiptRecord["state"];
  controller_token: string;
  result_json: string | null;
};

function receiptFromRow(row: CccEffectReceiptRow): CccEffectReceiptRecord {
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
  };
}

function parsePosture(value: string | null): CliAutonomyPosture | null {
  return fromJson<CliAutonomyPosture>(value) ?? null;
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
  ) {
    super();
    this.setMaxListeners(100);
  }

  /** Hydrate all project sessions before exposing the synchronous cache API. */
  static async create(layer: AsyncDataLayer, projectId: string): Promise<CliSessionStore> {
    const store = new CliSessionStore(layer, projectId);
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
      SELECT effect_scope_id, logical_key, turn_key, slot_ordinal, tool_authority, arguments_digest, repeat_of,
        state, controller_token, result_json
      FROM project.ccc_effect_receipts
      WHERE owner_project_id = ${this.projectId} AND effect_scope_id = ${effectScopeId}
      FOR UPDATE
    `)) as unknown as CccEffectReceiptRow[];
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

  private assertReceiptCompatibility(input: CccPreparedEffectReceipt, existing: CccEffectReceiptRow): void {
    if (existing.tool_authority !== input.toolAuthority
      || existing.arguments_digest !== input.argumentsDigest
      || existing.repeat_of !== input.repeatOf) {
      throw new CccEffectReceiptProtocolError(
        "CCC_EFFECT_KEY_COLLISION",
        `CCC effect key collision: ${input.logicalKey}`,
      );
    }
  }

  async reserveCccEffectReceipt(input: CccPreparedEffectReceipt): Promise<CccEffectReceiptRecord> {
    this.assertNoLegacyCccReceiptEvidence(input.effectScopeId);
    return this.layer.transaction(async (tx) => {
      const rows = await this.lockedCccEffectRows(tx, input.effectScopeId);
      const unresolvedDispatch = rows.find((row) => row.state === "dispatched_unknown");
      if (unresolvedDispatch) {
        throw new CccEffectReceiptPendingError(unresolvedDispatch.logical_key);
      }
      const sameKey = rows.find((row) => row.logical_key === input.logicalKey);
      if (sameKey) {
        this.assertReceiptCompatibility(input, sameKey);
        if (sameKey.state === "committed") return receiptFromRow(sameKey);
        if (sameKey.state === "reserved" && sameKey.controller_token === input.controllerToken) return receiptFromRow(sameKey);
        // proved_failed is the durable, explicit fence for a controller that
        // never crossed dispatch. It is the only takeover path; elapsed time
        // is deliberately absent from this state machine.
        if (sameKey.state === "proved_failed" || (
          sameKey.state === "reserved"
          && await this.priorControllerIsDurablyFenced(tx, input.effectScopeId, sameKey.controller_token)
        )) {
          const now = new Date().toISOString();
          await tx.execute(sql`
            UPDATE project.ccc_effect_receipts
            SET state = 'reserved', controller_token = ${input.controllerToken}, updated_at = ${now}
            WHERE owner_project_id = ${this.projectId}
              AND effect_scope_id = ${input.effectScopeId}
              AND logical_key = ${input.logicalKey}
              AND state IN ('proved_failed', 'reserved')
          `);
          return { ...input, state: "reserved", result: undefined };
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
      const now = new Date().toISOString();
      await tx.execute(sql`
        INSERT INTO project.ccc_effect_receipts (
          owner_project_id, effect_scope_id, logical_key, turn_key, slot_ordinal, tool_authority,
          arguments_digest, repeat_of, state, controller_token, created_at, updated_at
        ) VALUES (
          ${this.projectId}, ${input.effectScopeId}, ${input.logicalKey}, ${input.turnKey}, ${input.slotOrdinal}, ${input.toolAuthority},
          ${input.argumentsDigest}, ${input.repeatOf}, 'reserved', ${input.controllerToken}, ${now}, ${now}
        )
      `);
      return { ...input, state: "reserved", result: undefined };
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
    return this.layer.transaction(async (tx) => {
      const rows = await this.lockedCccEffectRows(tx, input.effectScopeId);
      const existing = rows.find((row) => row.logical_key === input.logicalKey);
      if (!existing) throw new CccEffectReceiptProtocolError("CCC_EFFECT_RECONCILIATION_REQUIRED", `CCC effect receipt is missing: ${input.logicalKey}`);
      this.assertReceiptCompatibility(input, existing);
      if (existing.state === next) return receiptFromRow(existing);
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
      await tx.execute(sql`
        UPDATE project.ccc_effect_receipts
        SET state = ${next}, result_json = ${resultJson}, updated_at = ${now}
        WHERE owner_project_id = ${this.projectId}
          AND effect_scope_id = ${input.effectScopeId}
          AND logical_key = ${input.logicalKey}
          AND controller_token = ${input.controllerToken}
          AND state = ${expected}
      `);
      return { ...input, state: next, result };
    });
  }

  async getCccEffectReceipt(effectScopeId: string, logicalKey: string): Promise<CccEffectReceiptRecord | undefined> {
    const rows = (await this.layer.db.execute(sql`
      SELECT effect_scope_id, logical_key, turn_key, slot_ordinal, tool_authority, arguments_digest, repeat_of,
        state, controller_token, result_json
      FROM project.ccc_effect_receipts
      WHERE owner_project_id = ${this.projectId}
        AND effect_scope_id = ${effectScopeId}
        AND logical_key = ${logicalKey}
    `)) as unknown as CccEffectReceiptRow[];
    return rows[0] ? receiptFromRow(rows[0]) : undefined;
  }
}
