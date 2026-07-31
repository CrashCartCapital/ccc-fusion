import { createHash, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  canonicalCccPrdJson,
  computeCccPrdProofDefinitionSha256,
} from "../ccc-prd/contract.js";
import type { AsyncDataLayer, DbTransaction } from "../postgres/data-layer.js";
import * as schema from "../postgres/schema/index.js";
import { createCccCampaignAuthorityBinding } from "./canonical.js";
import { loadCccCampaignContextForTask } from "./store.js";
import {
  CCC_CAMPAIGN_PROOF_ATTEMPT_SCHEMA_VERSION,
  CccCampaignContextError,
  CccCampaignProofAttemptCollisionError,
  CccCampaignProofAttemptIdentityError,
  CccCampaignProofAttemptStateError,
  type CccCampaignProofAttempt,
  type CccCampaignProofAttemptDispatchDecision,
  type CccCampaignProofAttemptScope,
  type CccCampaignProofExecutionResult,
  type CccCampaignProofExecutionResultInput,
  type CccCampaignProofWorkItemFence,
  type CccCampaignTaskContext,
} from "./types.js";

const ATTEMPT_KEY_PATTERN = /^ccc-proof-attempt-[0-9a-f]{64}$/;
const CONTROLLER_TOKEN_PATTERN = /^ccc-proof-controller-[0-9a-f-]{36}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const GIT_OBJECT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const OUTPUT_TAIL_CHARS = 8_000;
const MAX_WARNINGS = 64;
const MAX_WARNING_CHARS = 2_000;
const MAX_NEGATIVE_CONTROL_LABEL_CHARS = 512;

type ProofAttemptRow =
  typeof schema.project.cccCampaignProofAttempts.$inferSelect;

type TransactionalInput = Readonly<{
  layer: AsyncDataLayer;
  tx?: DbTransaction;
}>;

export type ReserveCccCampaignProofAttemptInput = TransactionalInput & Readonly<{
  rootDir: string;
  taskId: string;
  proofId: string;
  scope?: CccCampaignProofAttemptScope;
  sourceCommit: string;
  sourceTree: string;
  workItemFence: CccCampaignProofWorkItemFence;
}>;

export type TransitionCccCampaignProofAttemptInput = TransactionalInput & Readonly<{
  attemptKey: string;
  controllerToken: string;
}>;

export type SettleCccCampaignProofAttemptInput =
  TransitionCccCampaignProofAttemptInput
  & Readonly<{ result: CccCampaignProofExecutionResultInput }>;

export type InspectCccCampaignProofAttemptInput = TransactionalInput & Readonly<{
  attemptKey: string;
}>;

export type ListCccCampaignProofAttemptsForCommitInput =
  TransactionalInput
  & Readonly<{
    importId: string;
    campaignId: string;
    taskId: string;
    sourceCommit: string;
  }>;

function projectIdFor(layer: AsyncDataLayer): string {
  return layer.projectId?.trim() || "__legacy_unscoped__";
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function requireCanonicalText(
  value: unknown,
  label: string,
  maximumLength = Number.POSITIVE_INFINITY,
): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value !== value.trim()
    || value.length > maximumLength
  ) {
    throw new CccCampaignProofAttemptIdentityError(
      `CCC campaign proof attempt ${label} must be a non-empty canonical string`,
    );
  }
  return value;
}

function requireIdentifier(value: unknown, label: string): string {
  const identifier = requireCanonicalText(value, label, 256);
  if (!IDENTIFIER_PATTERN.test(identifier)) {
    throw new CccCampaignProofAttemptIdentityError(
      `CCC campaign proof attempt ${label} must be a bounded canonical identifier`,
    );
  }
  return identifier;
}

function requireSha256(value: unknown, label: string): string {
  const digest = requireCanonicalText(value, label, 64);
  if (!SHA256_PATTERN.test(digest)) {
    throw new CccCampaignProofAttemptIdentityError(
      `CCC campaign proof attempt ${label} must be a lowercase SHA-256 digest`,
    );
  }
  return digest;
}

function requireGitObject(value: unknown, label: string): string {
  const objectId = requireCanonicalText(value, label, 64);
  if (!GIT_OBJECT_PATTERN.test(objectId)) {
    throw new CccCampaignProofAttemptIdentityError(
      `CCC campaign proof attempt ${label} must be a lowercase full Git object ID`,
    );
  }
  return objectId;
}

function requireAttemptKey(value: unknown): string {
  const attemptKey = requireCanonicalText(value, "attempt key");
  if (!ATTEMPT_KEY_PATTERN.test(attemptKey)) {
    throw new CccCampaignProofAttemptIdentityError(
      "CCC campaign proof attempt key is malformed",
    );
  }
  return attemptKey;
}

function requireControllerToken(value: unknown): string {
  const controllerToken = requireCanonicalText(value, "controller token");
  if (!CONTROLLER_TOKEN_PATTERN.test(controllerToken)) {
    throw new CccCampaignProofAttemptIdentityError(
      "CCC campaign proof attempt controller token is malformed",
    );
  }
  return controllerToken;
}

function requirePositiveSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new CccCampaignProofAttemptIdentityError(
      `CCC campaign proof attempt ${label} must be a positive safe integer`,
    );
  }
  return value as number;
}

function requireNonNegativeSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new CccCampaignProofAttemptIdentityError(
      `CCC campaign proof attempt ${label} must be a non-negative safe integer`,
    );
  }
  return value as number;
}

function requireExitCode(value: unknown): number | null {
  if (value === null) return null;
  if (
    !Number.isSafeInteger(value)
    || (value as number) < -2_147_483_648
    || (value as number) > 2_147_483_647
  ) {
    throw new CccCampaignProofAttemptIdentityError(
      "CCC campaign proof attempt exit code must be a PostgreSQL integer or null",
    );
  }
  return value as number;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new CccCampaignProofAttemptIdentityError(
      `CCC campaign proof attempt ${label} must be a boolean`,
    );
  }
  return value;
}

function assertCanonicalTimestamp(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) {
    throw new CccCampaignContextError(
      `CCC campaign proof attempt ${label} must be a canonical ISO timestamp`,
    );
  }
  return value;
}

function terminalResult(row: ProofAttemptRow): CccCampaignProofExecutionResult {
  if (
    row.resultSuccess === null
    || row.durationMs === null
    || row.stdoutSha256 === null
    || row.stderrSha256 === null
    || row.stdoutTail === null
    || row.stderrTail === null
    || row.timedOut === null
    || row.killed === null
    || !Array.isArray(row.warnings)
    || !row.warnings.every((warning) => typeof warning === "string")
  ) {
    throw new CccCampaignContextError(
      `CCC campaign proof attempt ${row.attemptKey} has incomplete terminal evidence`,
    );
  }
  const warnings = Object.freeze([...row.warnings]);
  return Object.freeze({
    success: row.resultSuccess === 1,
    exitCode: row.exitCode,
    durationMs: row.durationMs,
    stdoutSha256: requireSha256(row.stdoutSha256, "stored stdout digest"),
    stderrSha256: requireSha256(row.stderrSha256, "stored stderr digest"),
    stdoutTail: row.stdoutTail,
    stderrTail: row.stderrTail,
    timedOut: row.timedOut === 1,
    killed: row.killed === 1,
    warnings,
    ...(row.changedPathsSha256
      ? { changedPathsSha256: requireSha256(row.changedPathsSha256, "stored changed-path digest") }
      : {}),
    ...(row.negativeControlLabel
      ? { negativeControlLabel: row.negativeControlLabel }
      : {}),
  });
}

function attemptFromRow(row: ProofAttemptRow): CccCampaignProofAttempt {
  if (
    row.state !== "reserved"
    && row.state !== "dispatched_unknown"
    && row.state !== "committed"
    && row.state !== "proved_failed"
  ) {
    throw new CccCampaignContextError(
      `CCC campaign proof attempt ${row.attemptKey} has an invalid state`,
    );
  }
  const terminal = row.state === "committed" || row.state === "proved_failed";
  const attempt: CccCampaignProofAttempt = {
    schema: CCC_CAMPAIGN_PROOF_ATTEMPT_SCHEMA_VERSION,
    attemptKey: requireAttemptKey(row.attemptKey),
    controllerToken: requireControllerToken(row.controllerToken),
    projectId: row.projectId,
    importId: row.importId,
    campaignId: row.campaignId,
    taskId: row.taskId,
    semanticTaskId: row.semanticTaskId,
    proofId: row.proofId,
    packetHash: requireSha256(row.packetHash, "stored packet hash"),
    sidecarHash: requireSha256(row.sidecarHash, "stored sidecar hash"),
    bundleHash: requireSha256(row.bundleHash, "stored bundle hash"),
    manifestHash: requireSha256(row.manifestHash, "stored manifest hash"),
    campaignBindingHash: requireSha256(
      row.campaignBindingHash,
      "stored campaign binding hash",
    ),
    targetRepository: row.targetRepository,
    targetBase: row.targetBase,
    sourceCommit: requireGitObject(row.sourceCommit, "stored source commit"),
    sourceTree: requireGitObject(row.sourceTree, "stored source tree"),
    definitionSha256: requireSha256(
      row.definitionSha256,
      "stored proof-definition digest",
    ),
    command: row.command,
    commandSha256: requireSha256(row.commandSha256, "stored command digest"),
    workItemId: row.workItemId,
    runId: row.runId,
    workItemAttempt: row.workItemAttempt,
    state: row.state,
    ...(terminal ? { result: terminalResult(row) } : {}),
    createdAt: assertCanonicalTimestamp(row.createdAt, "createdAt"),
    updatedAt: assertCanonicalTimestamp(row.updatedAt, "updatedAt"),
    ...(row.dispatchedAt
      ? { dispatchedAt: assertCanonicalTimestamp(row.dispatchedAt, "dispatchedAt") }
      : {}),
    ...(row.settledAt
      ? { settledAt: assertCanonicalTimestamp(row.settledAt, "settledAt") }
      : {}),
  };
  return Object.freeze(attempt);
}

function immutableAttemptIdentity(attempt: CccCampaignProofAttempt): Record<string, unknown> {
  return {
    schema: attempt.schema,
    attemptKey: attempt.attemptKey,
    projectId: attempt.projectId,
    importId: attempt.importId,
    campaignId: attempt.campaignId,
    taskId: attempt.taskId,
    semanticTaskId: attempt.semanticTaskId,
    proofId: attempt.proofId,
    packetHash: attempt.packetHash,
    sidecarHash: attempt.sidecarHash,
    bundleHash: attempt.bundleHash,
    manifestHash: attempt.manifestHash,
    campaignBindingHash: attempt.campaignBindingHash,
    targetRepository: attempt.targetRepository,
    targetBase: attempt.targetBase,
    sourceCommit: attempt.sourceCommit,
    sourceTree: attempt.sourceTree,
    definitionSha256: attempt.definitionSha256,
    command: attempt.command,
    commandSha256: attempt.commandSha256,
    workItemId: attempt.workItemId,
    runId: attempt.runId,
    workItemAttempt: attempt.workItemAttempt,
  };
}

function sameCanonicalValue(left: unknown, right: unknown): boolean {
  return canonicalCccPrdJson(left) === canonicalCccPrdJson(right);
}

function proofForContext(
  context: CccCampaignTaskContext,
  proofId: string,
  scope: CccCampaignProofAttemptScope,
) {
  if (scope === "task" && !context.proofIds.includes(proofId)) {
    throw new CccCampaignProofAttemptIdentityError(
      `CCC campaign proof ${proofId} is not admitted for task ${context.taskId}`,
    );
  }
  const matches = context.proofs.filter((proof) => proof.id === proofId);
  if (matches.length !== 1) {
    throw new CccCampaignProofAttemptIdentityError(
      `CCC campaign proof ${proofId} does not resolve to one immutable admitted definition`,
    );
  }
  return matches[0]!;
}

function attemptKeyFor(input: {
  context: CccCampaignTaskContext;
  proofId: string;
  sourceCommit: string;
  definitionSha256: string;
}): string {
  return `ccc-proof-attempt-${sha256(canonicalCccPrdJson({
    schema: CCC_CAMPAIGN_PROOF_ATTEMPT_SCHEMA_VERSION,
    projectId: input.context.projectId,
    importId: input.context.importId,
    campaignId: input.context.campaignId,
    semanticTaskId: input.context.semanticTaskId,
    proofId: input.proofId,
    sourceCommit: input.sourceCommit,
    definitionSha256: input.definitionSha256,
  }))}`;
}

async function databaseNow(tx: DbTransaction): Promise<string> {
  const rows = await tx.execute(sql`
    SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now
  `) as unknown as Array<{ now: string }>;
  return assertCanonicalTimestamp(rows[0]?.now, "database clock");
}

async function selectAttempt(
  tx: DbTransaction,
  projectId: string,
  attemptKey: string,
  lockForUpdate: boolean,
): Promise<CccCampaignProofAttempt | null> {
  const selection = tx
    .select()
    .from(schema.project.cccCampaignProofAttempts)
    .where(and(
      eq(schema.project.cccCampaignProofAttempts.projectId, projectId),
      eq(schema.project.cccCampaignProofAttempts.attemptKey, attemptKey),
    ))
    .limit(2);
  const rows = lockForUpdate ? await selection.for("update") : await selection;
  if (rows.length === 0) return null;
  if (rows.length !== 1) {
    throw new CccCampaignContextError(
      `CCC campaign proof attempt ${attemptKey} has ambiguous persistence`,
    );
  }
  return attemptFromRow(rows[0]!);
}

function assertController(
  attempt: CccCampaignProofAttempt,
  controllerToken: string,
): void {
  if (attempt.controllerToken !== controllerToken) {
    throw new CccCampaignProofAttemptStateError(
      `CCC campaign proof attempt ${attempt.attemptKey} controller token does not own the reservation`,
    );
  }
}

function prepareTerminalResult(
  input: CccCampaignProofExecutionResultInput,
): CccCampaignProofExecutionResult {
  if (!input || typeof input !== "object") {
    throw new CccCampaignProofAttemptIdentityError(
      "CCC campaign proof attempt result is missing",
    );
  }
  const success = requireBoolean(input.success, "result success");
  const exitCode = requireExitCode(input.exitCode);
  const durationMs = requireNonNegativeSafeInteger(input.durationMs, "result durationMs");
  const stdout = typeof input.stdout === "string"
    ? input.stdout
    : (() => {
      throw new CccCampaignProofAttemptIdentityError(
        "CCC campaign proof attempt stdout must be a string",
      );
    })();
  const stderr = typeof input.stderr === "string"
    ? input.stderr
    : (() => {
      throw new CccCampaignProofAttemptIdentityError(
        "CCC campaign proof attempt stderr must be a string",
      );
    })();
  const timedOut = requireBoolean(input.timedOut, "result timedOut");
  const killed = requireBoolean(input.killed, "result killed");
  if (!Array.isArray(input.warnings) || input.warnings.length > MAX_WARNINGS) {
    throw new CccCampaignProofAttemptIdentityError(
      `CCC campaign proof attempt warnings must contain at most ${MAX_WARNINGS} strings`,
    );
  }
  const warnings = input.warnings.map((warning, index) => {
    if (typeof warning !== "string" || warning.length > MAX_WARNING_CHARS) {
      throw new CccCampaignProofAttemptIdentityError(
        `CCC campaign proof attempt warning ${index} must be a bounded string`,
      );
    }
    return warning;
  });
  if (success && (exitCode !== 0 || timedOut || killed)) {
    throw new CccCampaignProofAttemptIdentityError(
      "CCC campaign proof attempt success requires exit code 0 without timeout or kill",
    );
  }
  const changedPathsSha256 = input.changedPathsSha256 === undefined
    ? undefined
    : requireSha256(input.changedPathsSha256, "changed-path digest");
  const negativeControlLabel = input.negativeControlLabel === undefined
    ? undefined
    : requireCanonicalText(
      input.negativeControlLabel,
      "negative-control label",
      MAX_NEGATIVE_CONTROL_LABEL_CHARS,
    );
  return Object.freeze({
    success,
    exitCode,
    durationMs,
    stdoutSha256: sha256(stdout),
    stderrSha256: sha256(stderr),
    stdoutTail: stdout.slice(-OUTPUT_TAIL_CHARS),
    stderrTail: stderr.slice(-OUTPUT_TAIL_CHARS),
    timedOut,
    killed,
    warnings: Object.freeze([...warnings]),
    ...(changedPathsSha256 ? { changedPathsSha256 } : {}),
    ...(negativeControlLabel ? { negativeControlLabel } : {}),
  });
}

async function withinWriteTransaction<T>(
  input: TransactionalInput,
  operation: (tx: DbTransaction) => Promise<T>,
): Promise<T> {
  if (input.tx) return operation(input.tx);
  return input.layer.transactionImmediate(operation);
}

export async function reserveCccCampaignProofAttempt(
  input: ReserveCccCampaignProofAttemptInput,
): Promise<CccCampaignProofAttempt> {
  const taskId = requireIdentifier(input.taskId, "task ID");
  const proofId = requireIdentifier(input.proofId, "proof ID");
  const sourceCommit = requireGitObject(input.sourceCommit, "source commit");
  const sourceTree = requireGitObject(input.sourceTree, "source tree");
  const scope = input.scope ?? "task";
  if (scope !== "task" && scope !== "campaign") {
    throw new CccCampaignProofAttemptIdentityError(
      "CCC campaign proof attempt scope must be task or campaign",
    );
  }
  const workItemId = requireIdentifier(
    input.workItemFence?.workItemId,
    "work-item ID",
  );
  const runId = requireIdentifier(input.workItemFence?.runId, "run ID");
  const workItemAttempt = requirePositiveSafeInteger(
    input.workItemFence?.attempt,
    "work-item attempt",
  );
  return withinWriteTransaction(input, async (tx) => {
    const context = await loadCccCampaignContextForTask(
      input.layer,
      input.rootDir,
      taskId,
      tx,
      true,
    );
    if (!context) {
      throw new CccCampaignContextError(
        `Task ${taskId} has no persisted CCC campaign context`,
      );
    }
    const proof = proofForContext(context, proofId, scope);
    const definitionSha256 = computeCccPrdProofDefinitionSha256(proof);
    const command = requireCanonicalText(proof.command, `proof ${proofId} command`);
    const commandSha256 = sha256(command);
    const binding = createCccCampaignAuthorityBinding(context, {
      actionId: `proof:${proofId}`,
      actionTarget: sourceCommit,
    });
    const attemptKey = attemptKeyFor({
      context,
      proofId,
      sourceCommit,
      definitionSha256,
    });
    const now = await databaseNow(tx);
    const controllerToken = `ccc-proof-controller-${randomUUID()}`;
    const candidate: CccCampaignProofAttempt = Object.freeze({
      schema: CCC_CAMPAIGN_PROOF_ATTEMPT_SCHEMA_VERSION,
      attemptKey,
      controllerToken,
      projectId: context.projectId,
      importId: context.importId,
      campaignId: context.campaignId,
      taskId: context.taskId,
      semanticTaskId: context.semanticTaskId,
      proofId,
      packetHash: context.packetHash,
      sidecarHash: context.sidecarHash,
      bundleHash: context.bundleHash,
      manifestHash: context.manifestHash,
      campaignBindingHash: binding.bindingHash,
      targetRepository: context.targetRepository.path,
      targetBase: context.targetRepository.baseCommit,
      sourceCommit,
      sourceTree,
      definitionSha256,
      command,
      commandSha256,
      workItemId,
      runId,
      workItemAttempt,
      state: "reserved",
      createdAt: now,
      updatedAt: now,
    });
    await tx
      .insert(schema.project.cccCampaignProofAttempts)
      .values({
        projectId: candidate.projectId,
        attemptKey: candidate.attemptKey,
        controllerToken: candidate.controllerToken,
        importId: candidate.importId,
        campaignId: candidate.campaignId,
        taskId: candidate.taskId,
        semanticTaskId: candidate.semanticTaskId,
        proofId: candidate.proofId,
        packetHash: candidate.packetHash,
        sidecarHash: candidate.sidecarHash,
        bundleHash: candidate.bundleHash,
        manifestHash: candidate.manifestHash,
        campaignBindingHash: candidate.campaignBindingHash,
        targetRepository: candidate.targetRepository,
        targetBase: candidate.targetBase,
        sourceCommit: candidate.sourceCommit,
        sourceTree: candidate.sourceTree,
        definitionSha256: candidate.definitionSha256,
        command: candidate.command,
        commandSha256: candidate.commandSha256,
        workItemId: candidate.workItemId,
        runId: candidate.runId,
        workItemAttempt: candidate.workItemAttempt,
        state: candidate.state,
        createdAt: candidate.createdAt,
        updatedAt: candidate.updatedAt,
      })
      .onConflictDoNothing();
    const persisted = await selectAttempt(
      tx,
      context.projectId,
      attemptKey,
      true,
    );
    if (!persisted) {
      throw new CccCampaignContextError(
        `CCC campaign proof attempt ${attemptKey} reservation was not persisted`,
      );
    }
    if (
      !sameCanonicalValue(
        immutableAttemptIdentity(persisted),
        immutableAttemptIdentity(candidate),
      )
    ) {
      throw new CccCampaignProofAttemptCollisionError(
        `CCC campaign proof attempt ${attemptKey} collides with changed immutable identity`,
      );
    }
    return persisted;
  });
}

export async function beginCccCampaignProofAttemptDispatch(
  input: TransitionCccCampaignProofAttemptInput,
): Promise<CccCampaignProofAttemptDispatchDecision> {
  const attemptKey = requireAttemptKey(input.attemptKey);
  const controllerToken = requireControllerToken(input.controllerToken);
  return withinWriteTransaction(input, async (tx) => {
    const projectId = projectIdFor(input.layer);
    const attempt = await selectAttempt(tx, projectId, attemptKey, true);
    if (!attempt) {
      throw new CccCampaignProofAttemptStateError(
        `CCC campaign proof attempt ${attemptKey} does not exist`,
      );
    }
    assertController(attempt, controllerToken);
    if (attempt.state === "dispatched_unknown") {
      return Object.freeze({ kind: "dispatched-unknown", attempt });
    }
    if (attempt.state !== "reserved") {
      return Object.freeze({ kind: "terminal", attempt });
    }
    const now = await databaseNow(tx);
    const updated = await tx
      .update(schema.project.cccCampaignProofAttempts)
      .set({
        state: "dispatched_unknown",
        dispatchedAt: now,
        updatedAt: now,
      })
      .where(and(
        eq(schema.project.cccCampaignProofAttempts.projectId, projectId),
        eq(schema.project.cccCampaignProofAttempts.attemptKey, attemptKey),
        eq(schema.project.cccCampaignProofAttempts.controllerToken, controllerToken),
        eq(schema.project.cccCampaignProofAttempts.state, "reserved"),
      ))
      .returning();
    if (updated.length !== 1) {
      throw new CccCampaignProofAttemptStateError(
        `CCC campaign proof attempt ${attemptKey} dispatch compare-and-swap lost`,
      );
    }
    return Object.freeze({
      kind: "dispatch-permit",
      attempt: attemptFromRow(updated[0]!),
    });
  });
}

export async function settleCccCampaignProofAttempt(
  input: SettleCccCampaignProofAttemptInput,
): Promise<CccCampaignProofAttempt> {
  const attemptKey = requireAttemptKey(input.attemptKey);
  const controllerToken = requireControllerToken(input.controllerToken);
  const result = prepareTerminalResult(input.result);
  return withinWriteTransaction(input, async (tx) => {
    const projectId = projectIdFor(input.layer);
    const attempt = await selectAttempt(tx, projectId, attemptKey, true);
    if (!attempt) {
      throw new CccCampaignProofAttemptStateError(
        `CCC campaign proof attempt ${attemptKey} does not exist`,
      );
    }
    assertController(attempt, controllerToken);
    if (attempt.result) {
      if (sameCanonicalValue(attempt.result, result)) return attempt;
      throw new CccCampaignProofAttemptCollisionError(
        `CCC campaign proof attempt ${attemptKey} terminal result collides with persisted evidence`,
      );
    }
    if (attempt.state !== "dispatched_unknown") {
      throw new CccCampaignProofAttemptStateError(
        `CCC campaign proof attempt ${attemptKey} cannot settle from ${attempt.state}`,
      );
    }
    const now = await databaseNow(tx);
    const state = result.success ? "committed" : "proved_failed";
    const updated = await tx
      .update(schema.project.cccCampaignProofAttempts)
      .set({
        state,
        resultSuccess: result.success ? 1 : 0,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        stdoutSha256: result.stdoutSha256,
        stderrSha256: result.stderrSha256,
        stdoutTail: result.stdoutTail,
        stderrTail: result.stderrTail,
        timedOut: result.timedOut ? 1 : 0,
        killed: result.killed ? 1 : 0,
        warnings: [...result.warnings],
        changedPathsSha256: result.changedPathsSha256 ?? null,
        negativeControlLabel: result.negativeControlLabel ?? null,
        settledAt: now,
        updatedAt: now,
      })
      .where(and(
        eq(schema.project.cccCampaignProofAttempts.projectId, projectId),
        eq(schema.project.cccCampaignProofAttempts.attemptKey, attemptKey),
        eq(schema.project.cccCampaignProofAttempts.controllerToken, controllerToken),
        eq(schema.project.cccCampaignProofAttempts.state, "dispatched_unknown"),
      ))
      .returning();
    if (updated.length !== 1) {
      throw new CccCampaignProofAttemptStateError(
        `CCC campaign proof attempt ${attemptKey} settlement compare-and-swap lost`,
      );
    }
    return attemptFromRow(updated[0]!);
  });
}

export async function inspectCccCampaignProofAttempt(
  input: InspectCccCampaignProofAttemptInput,
): Promise<CccCampaignProofAttempt | null> {
  const attemptKey = requireAttemptKey(input.attemptKey);
  const inspect = (tx: DbTransaction) =>
    selectAttempt(tx, projectIdFor(input.layer), attemptKey, false);
  if (input.tx) return inspect(input.tx);
  return input.layer.transaction(inspect);
}

export async function listCccCampaignProofAttemptsForCommit(
  input: ListCccCampaignProofAttemptsForCommitInput,
): Promise<readonly CccCampaignProofAttempt[]> {
  const importId = requireIdentifier(input.importId, "import ID");
  const campaignId = requireIdentifier(input.campaignId, "campaign ID");
  const taskId = requireIdentifier(input.taskId, "task ID");
  const sourceCommit = requireGitObject(input.sourceCommit, "source commit");
  const select = async (tx: DbTransaction) => {
    const rows = await tx
      .select()
      .from(schema.project.cccCampaignProofAttempts)
      .where(and(
        eq(schema.project.cccCampaignProofAttempts.projectId, projectIdFor(input.layer)),
        eq(schema.project.cccCampaignProofAttempts.importId, importId),
        eq(schema.project.cccCampaignProofAttempts.campaignId, campaignId),
        eq(schema.project.cccCampaignProofAttempts.taskId, taskId),
        eq(schema.project.cccCampaignProofAttempts.sourceCommit, sourceCommit),
      ));
    return Object.freeze(rows
      .map(attemptFromRow)
      .sort((left, right) =>
        left.proofId < right.proofId ? -1 : left.proofId > right.proofId ? 1 : 0));
  };
  if (input.tx) return select(input.tx);
  return input.layer.transaction(select);
}
