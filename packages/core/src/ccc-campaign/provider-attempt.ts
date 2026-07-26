import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, like, sql } from "drizzle-orm";
import { canonicalCccPrdJson } from "../ccc-prd/contract.js";
import {
  recordRunAuditEventWithinTransaction,
  RunAuditEventCollisionError,
  type AsyncDataLayer,
  type DbTransaction,
  type RunAuditEvent,
} from "../postgres/data-layer.js";
import * as schema from "../postgres/schema/index.js";
import {
  assertCccCampaignAuthorityBinding,
  createCccCampaignAuthorityBinding,
} from "./canonical.js";
import { loadCccCampaignContextForTask } from "./store.js";
import {
  CCC_PROVIDER_ATTEMPT_SCHEMA_VERSION,
  CccCampaignContextError,
  CccProviderAttemptCollisionError,
  CccProviderAttemptIdentityError,
  CccProviderAttemptLimitError,
  CccProviderAttemptStateError,
  type CccCampaignAuthorityBinding,
  type CccCampaignTaskContext,
  type CccProviderAttemptReconciliation,
  type CccProviderAttemptRequest,
  type CccProviderAttemptScope,
  type CccProviderAttemptState,
  type CccProviderAttemptTransition,
} from "./types.js";

const ATTEMPT_KEY_PATTERN = /^ccc-provider-attempt-[0-9a-f]{64}$/;
const CONTROLLER_TOKEN_PATTERN = /^ccc-provider-controller-[0-9a-f-]{36}$/;
const CANONICAL_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const PROVIDER_ATTEMPT_AGENT_ID = "ccc-provider-attempt";

type AttemptStage = "reserved" | "dispatched" | "terminal";

type TerminalReceipt = Readonly<{
  kind: "not-dispatched" | "reconciled";
  state: Extract<CccProviderAttemptState, "committed" | "proved_failed">;
  evidenceDigest?: string;
  observerId?: string;
}>;

type StoredAttempt = {
  scope: CccProviderAttemptScope;
  reserved: boolean;
  dispatched: boolean;
  terminal?: TerminalReceipt;
};

type ProviderAttemptHistory = Readonly<{
  attempts: ReadonlyMap<string, StoredAttempt>;
  activeCount: number;
}>;

type ProviderAttemptMetadata = Readonly<{
  schema: typeof CCC_PROVIDER_ATTEMPT_SCHEMA_VERSION;
  attemptKey: string;
  controllerToken: string;
  semanticTaskId: string;
  campaignDeadlineAt: string;
  turnKey: string;
  attemptOrdinal: number;
  requestCount: number;
  bindingHash: string;
  stageOrdinal: number;
  state: CccProviderAttemptState;
  terminal?: TerminalReceipt;
}>;

type ProviderAttemptStoreInput = Readonly<{
  layer: AsyncDataLayer;
  rootDir: string;
  tx?: DbTransaction;
}>;

type ReserveInput = ProviderAttemptStoreInput & Readonly<{
  request: CccProviderAttemptRequest;
}>;

type TransitionInput = ProviderAttemptStoreInput & Readonly<{
  transition: CccProviderAttemptTransition;
}>;

type ReconciliationInput = ProviderAttemptStoreInput & Readonly<{
  reconciliation: CccProviderAttemptReconciliation;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function requireCanonicalText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new CccProviderAttemptIdentityError(
      "invalid-input",
      `CCC provider attempt ${label} must be a non-empty canonical string`,
    );
  }
  return value;
}

function requireCanonicalIdentifier(value: unknown, label: string): string {
  const identifier = requireCanonicalText(value, label);
  if (!CANONICAL_IDENTIFIER_PATTERN.test(identifier)) {
    throw new CccProviderAttemptIdentityError(
      "invalid-input",
      `CCC provider attempt ${label} must be a bounded canonical identifier`,
    );
  }
  return identifier;
}

function requirePositiveSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new CccProviderAttemptIdentityError(
      "invalid-input",
      `CCC provider attempt ${label} must be a positive safe integer`,
    );
  }
  return value as number;
}

function requireLowercaseSha256(value: unknown, label: string): string {
  const digest = requireCanonicalText(value, label);
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    throw new CccProviderAttemptIdentityError(
      "invalid-input",
      `CCC provider attempt ${label} must be a lowercase SHA-256 digest`,
    );
  }
  return digest;
}

function requireAttemptKey(value: unknown): string {
  const attemptKey = requireCanonicalText(value, "attempt key");
  if (!ATTEMPT_KEY_PATTERN.test(attemptKey)) {
    throw new CccProviderAttemptIdentityError(
      "invalid-input",
      "CCC provider attempt key is malformed",
    );
  }
  return attemptKey;
}

function requireControllerToken(value: unknown): string {
  const controllerToken = requireCanonicalText(value, "controller token");
  if (!CONTROLLER_TOKEN_PATTERN.test(controllerToken)) {
    throw new CccProviderAttemptIdentityError(
      "invalid-input",
      "CCC provider attempt controller token is malformed",
    );
  }
  return controllerToken;
}

function assertCanonicalTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new CccCampaignContextError(`CCC provider attempt ${label} must be a canonical ISO timestamp`);
  }
  return value;
}

function sameCanonicalValue(left: unknown, right: unknown): boolean {
  return canonicalCccPrdJson(left) === canonicalCccPrdJson(right);
}

function scopeIdentity(scope: CccProviderAttemptScope): Record<string, unknown> {
  return {
    attemptKey: scope.attemptKey,
    controllerToken: scope.controllerToken,
    taskId: scope.taskId,
    semanticTaskId: scope.semanticTaskId,
    campaignDeadlineAt: scope.campaignDeadlineAt,
    turnKey: scope.turnKey,
    attemptOrdinal: scope.attemptOrdinal,
    requestCount: scope.requestCount,
    binding: scope.binding,
  };
}

function scopeWithState(
  scope: CccProviderAttemptScope,
  state: CccProviderAttemptState,
): CccProviderAttemptScope {
  const binding = Object.freeze({ ...scope.binding });
  return Object.freeze({
    attemptKey: scope.attemptKey,
    controllerToken: scope.controllerToken,
    taskId: scope.taskId,
    semanticTaskId: scope.semanticTaskId,
    campaignDeadlineAt: scope.campaignDeadlineAt,
    turnKey: scope.turnKey,
    attemptOrdinal: scope.attemptOrdinal,
    requestCount: scope.requestCount,
    state,
    binding,
  });
}

function createScope(input: {
  attemptKey: string;
  controllerToken: string;
  taskId: string;
  semanticTaskId: string;
  campaignDeadlineAt: string;
  turnKey: string;
  attemptOrdinal: number;
  requestCount: number;
  state: CccProviderAttemptState;
  binding: CccCampaignAuthorityBinding;
}): CccProviderAttemptScope {
  const binding = Object.freeze({ ...input.binding });
  return Object.freeze({
    attemptKey: input.attemptKey,
    controllerToken: input.controllerToken,
    taskId: input.taskId,
    semanticTaskId: input.semanticTaskId,
    campaignDeadlineAt: input.campaignDeadlineAt,
    turnKey: input.turnKey,
    attemptOrdinal: input.attemptOrdinal,
    requestCount: input.requestCount,
    state: input.state,
    binding,
  });
}

function stageForMutationType(value: string): AttemptStage {
  switch (value) {
    case "ccc-campaign:provider-attempt:reserved":
      return "reserved";
    case "ccc-campaign:provider-attempt:dispatched":
      return "dispatched";
    case "ccc-campaign:provider-attempt:terminal":
      return "terminal";
    default:
      throw new CccCampaignContextError(`CCC provider attempt history has unknown mutation type ${value}`);
  }
}

function expectedStageOrdinal(
  stage: AttemptStage,
  terminalKind?: unknown,
): number {
  if (stage === "reserved") return 1;
  if (stage === "dispatched") return 2;
  return terminalKind === "not-dispatched" ? 2 : 3;
}

function exactMetadataKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const observed = Object.keys(value).sort();
  const canonicalExpected = [...expected].sort();
  if (!sameCanonicalValue(observed, canonicalExpected)) {
    throw new CccCampaignContextError(
      `CCC provider attempt metadata fields must be exactly ${canonicalExpected.join(", ")}`,
    );
  }
}

function parseMetadata(value: unknown, stage: AttemptStage): ProviderAttemptMetadata {
  if (!isRecord(value)) {
    throw new CccCampaignContextError("CCC provider attempt audit metadata must be an object");
  }
  const baseKeys = [
    "attemptKey",
    "attemptOrdinal",
    "bindingHash",
    "campaignDeadlineAt",
    "controllerToken",
    "requestCount",
    "schema",
    "semanticTaskId",
    "stageOrdinal",
    "state",
    "turnKey",
  ] as const;
  const terminalKind = value.terminalKind;
  if (stage !== "terminal") {
    exactMetadataKeys(value, baseKeys);
  } else if (terminalKind === "not-dispatched") {
    exactMetadataKeys(value, [...baseKeys, "terminalKind"]);
  } else if (terminalKind === "reconciled") {
    exactMetadataKeys(value, [...baseKeys, "evidenceDigest", "observerId", "terminalKind"]);
  } else {
    throw new CccCampaignContextError("CCC provider attempt terminal metadata has an invalid terminal kind");
  }
  if (value.schema !== CCC_PROVIDER_ATTEMPT_SCHEMA_VERSION) {
    throw new CccCampaignContextError("CCC provider attempt metadata schema is invalid");
  }
  const stageOrdinal = expectedStageOrdinal(stage, terminalKind);
  if (value.stageOrdinal !== stageOrdinal) {
    throw new CccCampaignContextError("CCC provider attempt metadata stage ordinal is invalid");
  }
  const state = value.state;
  if (
    state !== "reserved"
    && state !== "dispatched_unknown"
    && state !== "committed"
    && state !== "proved_failed"
  ) {
    throw new CccCampaignContextError("CCC provider attempt metadata state is invalid");
  }
  if (
    (stage === "reserved" && state !== "reserved")
    || (stage === "dispatched" && state !== "dispatched_unknown")
    || (stage === "terminal" && state !== "committed" && state !== "proved_failed")
  ) {
    throw new CccCampaignContextError("CCC provider attempt metadata state does not match its audit stage");
  }
  let terminal: TerminalReceipt | undefined;
  if (stage === "terminal") {
    if (terminalKind === "not-dispatched") {
      if (state !== "proved_failed") {
        throw new CccCampaignContextError("CCC provider attempt no-dispatch terminal must be proved_failed");
      }
      terminal = { kind: "not-dispatched", state };
    } else {
      terminal = {
        kind: "reconciled",
        state: state as Extract<CccProviderAttemptState, "committed" | "proved_failed">,
        evidenceDigest: requireLowercaseSha256(value.evidenceDigest, "reconciliation evidence digest"),
        observerId: requireCanonicalIdentifier(value.observerId, "reconciliation observer ID"),
      };
    }
  }
  return {
    schema: CCC_PROVIDER_ATTEMPT_SCHEMA_VERSION,
    attemptKey: requireAttemptKey(value.attemptKey),
    controllerToken: requireControllerToken(value.controllerToken),
    semanticTaskId: requireCanonicalIdentifier(value.semanticTaskId, "semantic task ID"),
    campaignDeadlineAt: assertCanonicalTimestamp(value.campaignDeadlineAt, "campaign deadline"),
    turnKey: requireCanonicalIdentifier(value.turnKey, "turn key"),
    attemptOrdinal: requirePositiveSafeInteger(value.attemptOrdinal, "attempt ordinal"),
    requestCount: requirePositiveSafeInteger(value.requestCount, "request count"),
    bindingHash: requireLowercaseSha256(value.bindingHash, "binding hash"),
    stageOrdinal,
    state,
    ...(terminal ? { terminal } : {}),
  };
}

function bindingFromAuditRow(
  row: typeof schema.project.runAuditEvents.$inferSelect,
): CccCampaignAuthorityBinding {
  const required = [
    row.projectId,
    row.campaignProjectId,
    row.campaignImportId,
    row.campaignId,
    row.campaignTaskId,
    row.campaignActionId,
    row.campaignActionTarget,
    row.campaignIdempotencyKey,
    row.campaignPacketHash,
    row.campaignSidecarHash,
    row.campaignBundleHash,
    row.campaignTargetRepository,
    row.campaignTargetBase,
    row.campaignProviderId,
    row.campaignModelId,
    row.campaignTransport,
    row.campaignManifestHash,
    row.campaignBindingHash,
    row.campaignEventKey,
  ];
  if (required.some((value) => value === null)) {
    throw new CccCampaignContextError("CCC provider attempt history has a partial campaign binding");
  }
  if (row.projectId !== row.campaignProjectId) {
    throw new CccCampaignContextError("CCC provider attempt history campaign project does not match row project");
  }
  return assertCccCampaignAuthorityBinding({
    projectId: row.campaignProjectId!,
    importId: row.campaignImportId!,
    campaignId: row.campaignId!,
    taskId: row.campaignTaskId!,
    actionId: row.campaignActionId!,
    actionTarget: row.campaignActionTarget!,
    idempotencyKey: row.campaignIdempotencyKey!,
    packetHash: row.campaignPacketHash!,
    sidecarHash: row.campaignSidecarHash!,
    bundleHash: row.campaignBundleHash!,
    targetRepository: row.campaignTargetRepository!,
    targetBase: row.campaignTargetBase!,
    providerId: row.campaignProviderId!,
    modelId: row.campaignModelId!,
    transport: row.campaignTransport! as CccCampaignAuthorityBinding["transport"],
    manifestHash: row.campaignManifestHash!,
    bindingHash: row.campaignBindingHash!,
  });
}

function assertAuditRow(
  row: typeof schema.project.runAuditEvents.$inferSelect,
): { stage: AttemptStage; metadata: ProviderAttemptMetadata; scope: CccProviderAttemptScope } {
  const stage = stageForMutationType(row.mutationType);
  const metadata = parseMetadata(row.metadata, stage);
  const binding = bindingFromAuditRow(row);
  if (
    row.domain !== "database"
    || row.agentId !== PROVIDER_ATTEMPT_AGENT_ID
    || row.runId !== `ccc-provider-attempt:${metadata.attemptKey}`
    || row.taskId !== binding.taskId
    || row.target !== binding.actionTarget
    || row.campaignEventKey !== `${metadata.attemptKey}:${stage}`
    || metadata.bindingHash !== binding.bindingHash
  ) {
    throw new CccCampaignContextError("CCC provider attempt history has inconsistent audit custody");
  }
  assertCanonicalTimestamp(row.timestamp, "audit timestamp");
  return {
    stage,
    metadata,
    scope: createScope({
      attemptKey: metadata.attemptKey,
      controllerToken: metadata.controllerToken,
      taskId: binding.taskId,
      semanticTaskId: metadata.semanticTaskId,
      campaignDeadlineAt: metadata.campaignDeadlineAt,
      turnKey: metadata.turnKey,
      attemptOrdinal: metadata.attemptOrdinal,
      requestCount: metadata.requestCount,
      state: metadata.state,
      binding,
    }),
  };
}

function assertHistoryScopeMatches(
  existing: CccProviderAttemptScope,
  incoming: CccProviderAttemptScope,
): void {
  if (!sameCanonicalValue(scopeIdentity(existing), scopeIdentity(incoming))) {
    throw new CccCampaignContextError("CCC provider attempt history has inconsistent scope fields");
  }
}

function assembleHistory(
  rows: readonly (typeof schema.project.runAuditEvents.$inferSelect)[],
  context: CccCampaignTaskContext,
): ProviderAttemptHistory {
  const attempts = new Map<string, StoredAttempt>();
  for (const row of rows) {
    const { stage, metadata, scope } = assertAuditRow(row);
    let attempt = attempts.get(scope.attemptKey);
    if (!attempt) {
      attempt = { scope: scopeWithState(scope, "reserved"), reserved: false, dispatched: false };
      attempts.set(scope.attemptKey, attempt);
    } else {
      assertHistoryScopeMatches(attempt.scope, scope);
    }
    if (stage === "reserved") {
      if (attempt.reserved) {
        throw new CccCampaignContextError("CCC provider attempt history duplicates a reservation stage");
      }
      attempt.reserved = true;
    } else if (stage === "dispatched") {
      if (attempt.dispatched) {
        throw new CccCampaignContextError("CCC provider attempt history duplicates a dispatched stage");
      }
      attempt.dispatched = true;
    } else {
      if (attempt.terminal || !metadata.terminal) {
        throw new CccCampaignContextError("CCC provider attempt history duplicates or omits a terminal receipt");
      }
      attempt.terminal = metadata.terminal;
    }
  }

  const requestCounts: number[] = [];
  let activeCount = 0;
  for (const attempt of attempts.values()) {
    if (!attempt.reserved) {
      throw new CccCampaignContextError("CCC provider attempt history has a transition without a reservation");
    }
    if (attempt.scope.binding.importId !== context.importId) {
      throw new CccCampaignContextError("CCC provider attempt history crossed campaign imports");
    }
    if (attempt.scope.campaignDeadlineAt !== context.campaignDeadlineAt) {
      throw new CccCampaignContextError("CCC provider attempt history campaign deadline drifted");
    }
    requestCounts.push(attempt.scope.requestCount);
    if (attempt.terminal) {
      if (attempt.terminal.kind === "not-dispatched" && attempt.dispatched) {
        throw new CccCampaignContextError("CCC provider attempt history proves no dispatch after dispatch was recorded");
      }
      if (attempt.terminal.kind === "reconciled" && !attempt.dispatched) {
        throw new CccCampaignContextError("CCC provider attempt history reconciles an attempt that was never dispatched");
      }
      attempt.scope = scopeWithState(attempt.scope, attempt.terminal.state);
    } else if (attempt.dispatched) {
      attempt.scope = scopeWithState(attempt.scope, "dispatched_unknown");
      activeCount += 1;
    } else {
      attempt.scope = scopeWithState(attempt.scope, "reserved");
      activeCount += 1;
    }
  }
  const sortedCounts = [...requestCounts].sort((left, right) => left - right);
  if (sortedCounts.some((value, index) => value !== index + 1)) {
    throw new CccCampaignContextError("CCC provider attempt history request counts are not a contiguous reservation sequence");
  }
  if (context.requestCount !== sortedCounts.length) {
    throw new CccCampaignContextError("CCC provider attempt history does not match persisted campaign request count");
  }
  return { attempts, activeCount };
}

function admittedBounds(context: CccCampaignTaskContext): {
  maxRequests: number;
  maxConcurrency: number;
  deadlineAt: number;
} {
  const maxRequests = context.bounds.maxRequests;
  const maxConcurrency = context.bounds.maxConcurrency;
  if (
    !Number.isSafeInteger(maxRequests)
    || maxRequests <= 0
    || !Number.isSafeInteger(maxConcurrency)
    || maxConcurrency <= 0
  ) {
    throw new CccCampaignContextError("CCC provider attempt campaign bounds are invalid");
  }
  const deadlineAt = Date.parse(context.campaignDeadlineAt);
  if (!Number.isFinite(deadlineAt)) {
    throw new CccCampaignContextError("CCC provider attempt campaign deadline is invalid");
  }
  return { maxRequests, maxConcurrency, deadlineAt };
}

async function loadHistory(
  tx: DbTransaction,
  context: CccCampaignTaskContext,
): Promise<ProviderAttemptHistory> {
  const { maxRequests } = admittedBounds(context);
  const maximumRows = (maxRequests * 3) + 1;
  if (!Number.isSafeInteger(maximumRows)) {
    throw new CccCampaignContextError("CCC provider attempt history bound is invalid");
  }
  const rows = await tx
    .select()
    .from(schema.project.runAuditEvents)
    .where(and(
      eq(schema.project.runAuditEvents.projectId, context.projectId),
      eq(schema.project.runAuditEvents.campaignImportId, context.importId),
      like(schema.project.runAuditEvents.mutationType, "ccc-campaign:provider-attempt:%"),
    ))
    .orderBy(asc(schema.project.runAuditEvents.timestamp), asc(schema.project.runAuditEvents.id))
    .limit(maximumRows);
  if (rows.length === maximumRows) {
    throw new CccCampaignContextError("CCC provider attempt history exceeds the admitted finite request bound");
  }
  return assembleHistory(rows, context);
}

async function databaseNow(tx: DbTransaction): Promise<string> {
  const rows = await tx.execute(sql`
    SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now
  `) as unknown as Array<{ now: string }>;
  return assertCanonicalTimestamp(rows[0]?.now, "database clock");
}

function assertBeforeDeadline(context: CccCampaignTaskContext, now: string): void {
  const { deadlineAt } = admittedBounds(context);
  if (Date.parse(now) >= deadlineAt) {
    throw new CccProviderAttemptLimitError(
      "deadline",
      `CCC provider attempt for ${context.taskId} is outside its database-clock campaign deadline`,
    );
  }
}

function assertRequestRoute(
  context: CccCampaignTaskContext,
  request: CccProviderAttemptRequest,
): void {
  if (
    request.providerId !== context.route.providerId
    || request.modelId !== context.route.modelId
    || request.transport !== context.route.transport
  ) {
    throw new CccProviderAttemptIdentityError(
      "route-drift",
      `CCC provider attempt route for ${request.taskId} does not match its persisted provider, model, and transport`,
    );
  }
}

function deriveAttemptKey(
  context: CccCampaignTaskContext,
  turnKey: string,
  attemptOrdinal: number,
): string {
  const identity = {
    projectId: context.projectId,
    importId: context.importId,
    campaignId: context.campaignId,
    taskId: context.taskId,
    semanticTaskId: context.semanticTaskId,
    turnKey,
    attemptOrdinal,
  };
  return `ccc-provider-attempt-${createHash("sha256")
    .update(`ccc-provider-attempt/v1\\0${canonicalCccPrdJson(identity)}`, "utf8")
    .digest("hex")}`;
}

function requestedReservation(
  context: CccCampaignTaskContext,
  request: CccProviderAttemptRequest,
): { binding: CccCampaignAuthorityBinding; attemptKey: string; turnKey: string; attemptOrdinal: number } {
  const taskId = requireCanonicalText(request.taskId, "task ID");
  if (taskId !== context.taskId) {
    throw new CccProviderAttemptIdentityError(
      "invalid-input",
      `CCC provider attempt task ${taskId} does not match locked task ${context.taskId}`,
    );
  }
  assertRequestRoute(context, request);
  const turnKey = requireCanonicalIdentifier(request.turnKey, "turn key");
  const attemptOrdinal = requirePositiveSafeInteger(request.attemptOrdinal, "attempt ordinal");
  const binding = createCccCampaignAuthorityBinding(context, {
    actionId: requireCanonicalText(request.actionId, "action ID"),
    actionTarget: requireCanonicalText(request.actionTarget, "action target"),
  });
  return {
    binding,
    attemptKey: deriveAttemptKey(context, turnKey, attemptOrdinal),
    turnKey,
    attemptOrdinal,
  };
}

function assertReservationReplay(
  existing: StoredAttempt,
  request: {
    binding: CccCampaignAuthorityBinding;
    attemptKey: string;
    turnKey: string;
    attemptOrdinal: number;
  },
  context: CccCampaignTaskContext,
): CccProviderAttemptScope {
  const scope = existing.scope;
  if (
    scope.attemptKey !== request.attemptKey
    || scope.taskId !== context.taskId
    || scope.semanticTaskId !== context.semanticTaskId
    || scope.turnKey !== request.turnKey
    || scope.attemptOrdinal !== request.attemptOrdinal
    || !sameCanonicalValue(scope.binding, request.binding)
  ) {
    throw new CccProviderAttemptCollisionError(
      `CCC provider attempt ${request.attemptKey} collides with changed campaign authority`,
    );
  }
  return scope;
}

function transitionAttempt(
  history: ProviderAttemptHistory,
  transition: CccProviderAttemptTransition,
  taskId: string,
): StoredAttempt {
  if (requireCanonicalText(transition.taskId, "task ID") !== taskId) {
    throw new CccProviderAttemptStateError("CCC provider attempt transition task does not match locked task");
  }
  const attemptKey = requireAttemptKey(transition.attemptKey);
  const attempt = history.attempts.get(attemptKey);
  if (!attempt || attempt.scope.taskId !== taskId) {
    throw new CccProviderAttemptStateError(`CCC provider attempt ${attemptKey} is not present for task ${taskId}`);
  }
  if (attempt.scope.controllerToken !== requireControllerToken(transition.controllerToken)) {
    throw new CccProviderAttemptStateError(`CCC provider attempt ${attemptKey} controller token does not own the reservation`);
  }
  return attempt;
}

function metadataFor(
  scope: CccProviderAttemptScope,
  state: CccProviderAttemptState,
  terminal?: TerminalReceipt,
): Record<string, unknown> {
  const base = {
    schema: CCC_PROVIDER_ATTEMPT_SCHEMA_VERSION,
    attemptKey: scope.attemptKey,
    controllerToken: scope.controllerToken,
    semanticTaskId: scope.semanticTaskId,
    campaignDeadlineAt: scope.campaignDeadlineAt,
    turnKey: scope.turnKey,
    attemptOrdinal: scope.attemptOrdinal,
    requestCount: scope.requestCount,
    bindingHash: scope.binding.bindingHash,
    stageOrdinal: terminal
      ? (terminal.kind === "not-dispatched" ? 2 : 3)
      : (state === "reserved" ? 1 : 2),
    state,
  };
  if (!terminal) return base;
  if (terminal.kind === "not-dispatched") {
    return { ...base, terminalKind: "not-dispatched" };
  }
  return {
    ...base,
    terminalKind: "reconciled",
    evidenceDigest: terminal.evidenceDigest!,
    observerId: terminal.observerId!,
  };
}

async function appendAttemptEvent(
  tx: DbTransaction,
  now: string,
  scope: CccProviderAttemptScope,
  stage: AttemptStage,
  terminal?: TerminalReceipt,
): Promise<RunAuditEvent> {
  const state = stage === "reserved"
    ? "reserved"
    : stage === "dispatched"
      ? "dispatched_unknown"
      : terminal!.state;
  return recordRunAuditEventWithinTransaction(tx, {
    timestamp: now,
    taskId: scope.taskId,
    agentId: PROVIDER_ATTEMPT_AGENT_ID,
    runId: `ccc-provider-attempt:${scope.attemptKey}`,
    domain: "database",
    mutationType: `ccc-campaign:provider-attempt:${stage}`,
    target: scope.binding.actionTarget,
    metadata: metadataFor(scope, state, terminal),
    campaign: {
      eventKey: `${scope.attemptKey}:${stage}`,
      binding: scope.binding,
    },
  });
}

async function incrementRequestCount(
  tx: DbTransaction,
  context: CccCampaignTaskContext,
  nextRequestCount: number,
  now: string,
): Promise<void> {
  const updated = await tx
    .update(schema.project.cccPrdImports)
    .set({ requestCount: nextRequestCount, updatedAt: now })
    .where(and(
      eq(schema.project.cccPrdImports.projectId, context.projectId),
      eq(schema.project.cccPrdImports.idempotencyKey, context.idempotencyKey),
      eq(schema.project.cccPrdImports.importId, context.importId),
      eq(schema.project.cccPrdImports.campaignManifestHash, context.manifestHash),
      eq(schema.project.cccPrdImports.requestCount, context.requestCount),
    ))
    .returning({ importId: schema.project.cccPrdImports.importId });
  if (updated.length !== 1) {
    throw new CccCampaignContextError("CCC provider attempt request-count compare-and-swap lost");
  }
}

async function lockedContext(
  input: ProviderAttemptStoreInput,
  tx: DbTransaction,
  taskId: string,
): Promise<CccCampaignTaskContext> {
  const context = await loadCccCampaignContextForTask(input.layer, input.rootDir, taskId, tx, true);
  if (!context) {
    throw new CccCampaignContextError(`Task ${taskId} has no persisted CCC campaign context`);
  }
  return context;
}

async function withinWriteTransaction<T>(
  input: ProviderAttemptStoreInput,
  operation: (tx: DbTransaction) => Promise<T>,
): Promise<T> {
  if (input.tx) return operation(input.tx);
  return input.layer.transactionImmediate(operation);
}

export async function reserveCccProviderAttempt(input: ReserveInput): Promise<CccProviderAttemptScope> {
  requireCanonicalText(input.request.taskId, "task ID");
  return withinWriteTransaction(input, async (tx) => {
    const context = await lockedContext(input, tx, input.request.taskId);
    const requested = requestedReservation(context, input.request);
    const history = await loadHistory(tx, context);
    const existing = history.attempts.get(requested.attemptKey);
    if (existing) return assertReservationReplay(existing, requested, context);

    const { maxRequests, maxConcurrency } = admittedBounds(context);
    if (history.activeCount >= maxConcurrency) {
      throw new CccProviderAttemptLimitError(
        "max-concurrency",
        `CCC provider attempt for ${context.taskId} exceeds its admitted concurrency bound`,
      );
    }
    if (requested.attemptOrdinal !== context.requestCount + 1) {
      throw new CccProviderAttemptIdentityError(
        "invalid-input",
        `CCC provider attempt ordinal must advance from ${context.requestCount} to ${context.requestCount + 1}`,
      );
    }
    const now = await databaseNow(tx);
    assertBeforeDeadline(context, now);
    if (context.requestCount >= maxRequests) {
      throw new CccProviderAttemptLimitError(
        "max-requests",
        `CCC provider attempt for ${context.taskId} exceeds its admitted request bound`,
      );
    }
    const scope = createScope({
      attemptKey: requested.attemptKey,
      controllerToken: `ccc-provider-controller-${randomUUID()}`,
      taskId: context.taskId,
      semanticTaskId: context.semanticTaskId,
      campaignDeadlineAt: context.campaignDeadlineAt,
      turnKey: requested.turnKey,
      attemptOrdinal: requested.attemptOrdinal,
      requestCount: context.requestCount + 1,
      state: "reserved",
      binding: requested.binding,
    });
    await appendAttemptEvent(tx, now, scope, "reserved");
    await incrementRequestCount(tx, context, scope.requestCount, now);
    return scope;
  });
}

export async function markCccProviderAttemptDispatched(
  input: TransitionInput,
): Promise<CccProviderAttemptScope> {
  requireCanonicalText(input.transition.taskId, "task ID");
  return withinWriteTransaction(input, async (tx) => {
    const context = await lockedContext(input, tx, input.transition.taskId);
    const attempt = transitionAttempt(await loadHistory(tx, context), input.transition, context.taskId);
    if (attempt.scope.state === "dispatched_unknown") return attempt.scope;
    if (attempt.scope.state !== "reserved") {
      throw new CccProviderAttemptStateError(
        `CCC provider attempt ${attempt.scope.attemptKey} cannot dispatch from ${attempt.scope.state}`,
      );
    }
    const now = await databaseNow(tx);
    assertBeforeDeadline(context, now);
    const dispatched = scopeWithState(attempt.scope, "dispatched_unknown");
    await appendAttemptEvent(tx, now, dispatched, "dispatched");
    return dispatched;
  });
}

export async function proveCccProviderAttemptNotDispatched(
  input: TransitionInput,
): Promise<CccProviderAttemptScope> {
  requireCanonicalText(input.transition.taskId, "task ID");
  return withinWriteTransaction(input, async (tx) => {
    const context = await lockedContext(input, tx, input.transition.taskId);
    const attempt = transitionAttempt(await loadHistory(tx, context), input.transition, context.taskId);
    if (attempt.terminal?.kind === "not-dispatched") return attempt.scope;
    if (attempt.scope.state !== "reserved") {
      throw new CccProviderAttemptStateError(
        `CCC provider attempt ${attempt.scope.attemptKey} cannot prove no dispatch from ${attempt.scope.state}`,
      );
    }
    const terminal = scopeWithState(attempt.scope, "proved_failed");
    await appendAttemptEvent(
      tx,
      await databaseNow(tx),
      terminal,
      "terminal",
      { kind: "not-dispatched", state: "proved_failed" },
    );
    return terminal;
  });
}

export async function reconcileCccProviderAttempt(
  input: ReconciliationInput,
): Promise<CccProviderAttemptScope> {
  requireCanonicalText(input.reconciliation.taskId, "task ID");
  const outcome = input.reconciliation.outcome;
  if (outcome !== "committed" && outcome !== "proved_failed") {
    throw new CccProviderAttemptIdentityError("invalid-input", "CCC provider attempt reconciliation outcome is invalid");
  }
  const evidenceDigest = requireLowercaseSha256(input.reconciliation.evidenceDigest, "reconciliation evidence digest");
  const observerId = requireCanonicalIdentifier(input.reconciliation.observerId, "reconciliation observer ID");
  return withinWriteTransaction(input, async (tx) => {
    const context = await lockedContext(input, tx, input.reconciliation.taskId);
    const attempt = transitionAttempt(await loadHistory(tx, context), input.reconciliation, context.taskId);
    if (attempt.terminal) {
      if (
        attempt.terminal.kind === "reconciled"
        && attempt.terminal.state === outcome
        && attempt.terminal.evidenceDigest === evidenceDigest
        && attempt.terminal.observerId === observerId
      ) {
        return attempt.scope;
      }
      throw new RunAuditEventCollisionError(`${attempt.scope.attemptKey}:terminal`);
    }
    if (attempt.scope.state !== "dispatched_unknown") {
      throw new CccProviderAttemptStateError(
        `CCC provider attempt ${attempt.scope.attemptKey} cannot reconcile from ${attempt.scope.state}`,
      );
    }
    const terminalReceipt: TerminalReceipt = {
      kind: "reconciled",
      state: outcome,
      evidenceDigest,
      observerId,
    };
    const terminal = scopeWithState(attempt.scope, outcome);
    await appendAttemptEvent(
      tx,
      await databaseNow(tx),
      terminal,
      "terminal",
      terminalReceipt,
    );
    return terminal;
  });
}

export async function inspectCccProviderAttempt(
  input: ProviderAttemptStoreInput & Readonly<{ taskId: string; attemptKey: string }>,
): Promise<CccProviderAttemptScope | null> {
  const taskId = requireCanonicalText(input.taskId, "task ID");
  const attemptKey = requireAttemptKey(input.attemptKey);
  const inspect = async (tx: DbTransaction): Promise<CccProviderAttemptScope | null> => {
    const context = await loadCccCampaignContextForTask(input.layer, input.rootDir, taskId, tx);
    if (!context) return null;
    return (await loadHistory(tx, context)).attempts.get(attemptKey)?.scope ?? null;
  };
  if (input.tx) return inspect(input.tx);
  return input.layer.transaction(inspect);
}
