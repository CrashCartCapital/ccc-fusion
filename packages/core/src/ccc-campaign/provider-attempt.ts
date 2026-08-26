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
import { loadCccCampaignContextForTask, type CccCampaignAuthorityStore } from "./store.js";
import { readConsumedCccCampaignApprovalCustodyWithinTransaction } from "../async-approval-request-store.js";
import {
  CCC_PROVIDER_ATTEMPT_SCHEMA_VERSION,
  CCC_PROVIDER_ATTEMPT_V2_SCHEMA_VERSION,
  CCC_PROVIDER_ATTEMPT_V3_SCHEMA_VERSION,
  CCC_PROVIDER_ATTEMPT_V4_SCHEMA_VERSION,
  CccCampaignContextError,
  CccProviderAttemptCollisionError,
  CccProviderAttemptIdentityError,
  CccProviderAttemptLimitError,
  CccProviderAttemptStateError,
  type CccCampaignAuthorityBinding,
  type CccCampaignRouteReceiptAdapterId,
  type CccCampaignTaskContext,
  type CccCampaignWorkItemFence,
  type CccProviderAttemptCost,
  type CccProviderAttemptEffectiveRoute,
  type CccProviderAttemptEffectiveRouteInput,
  type CccProviderAttemptOmniRouteReceipt,
  type CccProviderAttemptOmniRouteObservation,
  type CccProviderAttemptReceiptSource,
  type CccProviderAttemptReconciliation,
  type CccProviderAttemptDispatchDecision,
  type CccProviderAttemptRequest,
  type CccProviderAttemptScope,
  type CccProviderAttemptState,
  type CccProviderAttemptTerminalEvidence,
  type CccProviderAttemptTransition,
  type CccProviderAttemptUsage,
} from "./types.js";

const ATTEMPT_KEY_PATTERN = /^ccc-provider-attempt-[0-9a-f]{64}$/;
const CONTROLLER_TOKEN_PATTERN = /^ccc-provider-controller-[0-9a-f-]{36}$/;
const CANONICAL_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const PROVIDER_ATTEMPT_AGENT_ID = "ccc-provider-attempt";

type AttemptStage = "reserved" | "dispatched" | "terminal";

type TerminalReceipt = CccProviderAttemptTerminalEvidence;

type StoredAttempt = {
  scope: CccProviderAttemptScope;
  schema:
    | typeof CCC_PROVIDER_ATTEMPT_V2_SCHEMA_VERSION
    | typeof CCC_PROVIDER_ATTEMPT_V3_SCHEMA_VERSION
    | typeof CCC_PROVIDER_ATTEMPT_V4_SCHEMA_VERSION;
  reserved: boolean;
  dispatched: boolean;
  terminal?: TerminalReceipt;
};

type ProviderAttemptHistory = Readonly<{
  attempts: ReadonlyMap<string, StoredAttempt>;
  activeCount: number;
}>;

type ProviderAttemptMetadata = Readonly<{
  schema:
    | typeof CCC_PROVIDER_ATTEMPT_V2_SCHEMA_VERSION
    | typeof CCC_PROVIDER_ATTEMPT_V3_SCHEMA_VERSION
    | typeof CCC_PROVIDER_ATTEMPT_V4_SCHEMA_VERSION;
  attemptKey: string;
  controllerToken: string;
  semanticTaskId: string;
  campaignDeadlineAt: string;
  turnKey: string;
  dispatchKey: string;
  attemptOrdinal: number;
  requestCount: number;
  workItemFence: CccCampaignWorkItemFence | null;
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

export type ListCccProviderAttemptsForCampaignInput = ProviderAttemptStoreInput & Readonly<{
  taskId: string;
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

function requireNonNegativeSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new CccProviderAttemptIdentityError(
      "invalid-input",
      `CCC provider attempt ${label} must be a non-negative safe integer`,
    );
  }
  return value as number;
}

function requireFiniteNonNegativeAmount(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new CccProviderAttemptIdentityError(
      "invalid-input",
      `CCC provider attempt ${label} must be a finite non-negative amount`,
    );
  }
  return value;
}

function requireUsage(value: unknown): CccProviderAttemptUsage | null {
  if (value === null) return null;
  if (!isRecord(value)) {
    throw new CccProviderAttemptIdentityError(
      "invalid-input",
      "CCC provider attempt usage must be an object or null",
    );
  }
  const keys = Object.keys(value).sort();
  if (!sameCanonicalValue(keys, ["inputTokens", "outputTokens"])) {
    throw new CccProviderAttemptIdentityError(
      "invalid-input",
      "CCC provider attempt usage fields must be exactly inputTokens, outputTokens",
    );
  }
  return Object.freeze({
    inputTokens: requireNonNegativeSafeInteger(value.inputTokens, "usage inputTokens"),
    outputTokens: requireNonNegativeSafeInteger(value.outputTokens, "usage outputTokens"),
  });
}

function requireCost(value: unknown): CccProviderAttemptCost {
  if (!isRecord(value)) {
    throw new CccProviderAttemptIdentityError(
      "invalid-input",
      "CCC provider attempt cost must be an object",
    );
  }
  const keys = Object.keys(value).sort();
  if (sameCanonicalValue(keys, ["amountUsd", "source"])) {
    return Object.freeze({
      amountUsd: requireFiniteNonNegativeAmount(value.amountUsd, "cost amountUsd"),
      source: requireCanonicalText(value.source, "cost source"),
    });
  }
  if (sameCanonicalValue(keys, ["kind", "reason"])) {
    if (value.kind !== "unknown") {
      throw new CccProviderAttemptIdentityError(
        "invalid-input",
        "CCC provider attempt cost kind must be unknown when no amount is claimed",
      );
    }
    return Object.freeze({
      kind: "unknown" as const,
      reason: requireCanonicalText(value.reason, "cost reason"),
    });
  }
  throw new CccProviderAttemptIdentityError(
    "invalid-input",
    'CCC provider attempt cost must be exactly {amountUsd, source} or {kind: "unknown", reason}',
  );
}

function requireReceiptSource(value: unknown): CccProviderAttemptReceiptSource {
  if (value !== "stream-usage" && value !== "provider-api" && value !== "none") {
    throw new CccProviderAttemptIdentityError(
      "invalid-input",
      "CCC provider attempt receipt source must be stream-usage, provider-api, or none",
    );
  }
  return value;
}

/** Shared field parsing between the settlement-input boundary and the audit read-back boundary. */
type ReceiptParseError = (message: string) => never;

function parseOmniRouteText(value: unknown, label: string, error: ReceiptParseError): string {
  try {
    return requireCanonicalText(value, `OmniRoute ${label}`);
  } catch {
    return error(`CCC provider attempt OmniRoute ${label} must be a non-empty canonical string`);
  }
}

function parseOmniRouteObservation(
  value: unknown,
  label: string,
  error: ReceiptParseError,
): CccProviderAttemptOmniRouteObservation {
  if (!isRecord(value)) {
    return error(`CCC provider attempt OmniRoute ${label} observation must be an object`);
  }
  const keys = Object.keys(value).sort();
  if (!sameCanonicalValue(keys, ["model", "provider"])) {
    return error(`CCC provider attempt OmniRoute ${label} observation fields must be exactly model, provider`);
  }
  return Object.freeze({
    provider: parseOmniRouteText(value.provider, `${label} provider`, error),
    model: parseOmniRouteText(value.model, `${label} model`, error),
  });
}

function parseOmniRouteReceipt(
  value: unknown,
  error: ReceiptParseError = (message) => {
    throw new CccProviderAttemptIdentityError("invalid-input", message);
  },
): CccProviderAttemptOmniRouteReceipt {
  if (!isRecord(value)) {
    return error("CCC provider attempt OmniRoute receipt must be an object");
  }
  /*
   * `initial` is the header-derived observation and is optional: a keepalive-first
   * OmniRoute response commits its headers before an upstream is chosen, so only
   * the trailing SSE comments carry the route. `final` is always required.
   */
  const keys = Object.keys(value).sort();
  if (!sameCanonicalValue(keys, ["final", "initial"]) && !sameCanonicalValue(keys, ["final"])) {
    return error("CCC provider attempt OmniRoute receipt fields must be exactly final, or final and initial");
  }
  return Object.freeze({
    ...(Object.prototype.hasOwnProperty.call(value, "initial")
      ? { initial: parseOmniRouteObservation(value.initial, "initial", error) }
      : {}),
    final: parseOmniRouteObservation(value.final, "final", error),
  });
}

function parseEffectiveRouteFields(
  value: Record<string, unknown>,
  error: ReceiptParseError = (message) => {
    throw new CccProviderAttemptIdentityError("invalid-input", message);
  },
): CccProviderAttemptEffectiveRoute {
  return Object.freeze({
    effectiveProvider: requireCanonicalText(value.effectiveProvider, "effective provider"),
    effectiveModel: requireCanonicalText(value.effectiveModel, "effective model"),
    ...(value.effectiveReasoningEffort !== undefined
      ? { effectiveReasoningEffort: requireCanonicalText(value.effectiveReasoningEffort, "effective reasoning effort") }
      : {}),
    ...(value.effectiveServiceTier !== undefined
      ? { effectiveServiceTier: requireCanonicalText(value.effectiveServiceTier, "effective service tier") }
      : {}),
    usage: requireUsage(value.usage),
    cost: requireCost(value.cost),
    receiptSource: requireReceiptSource(value.receiptSource),
    ...(Object.prototype.hasOwnProperty.call(value, "omniRoute")
      ? { omniRoute: parseOmniRouteReceipt(value.omniRoute, error) }
      : {}),
  });
}

function assertNoCostWithoutReceipt(receipt: CccProviderAttemptEffectiveRoute): void {
  if ("amountUsd" in receipt.cost && (receipt.usage === null || receipt.receiptSource === "none")) {
    throw new CccProviderAttemptIdentityError(
      "invalid-input",
      "CCC provider attempt cannot claim a cost without non-null usage and a trustworthy receipt source",
    );
  }
}

const EFFECTIVE_ROUTE_REQUIRED_KEYS = ["effectiveProvider", "effectiveModel", "usage", "cost", "receiptSource"] as const;
const EFFECTIVE_ROUTE_INPUT_OPTIONAL_KEYS = ["effectiveReasoningEffort", "effectiveServiceTier", "fallbackReason", "omniRoute"] as const;
const EFFECTIVE_ROUTE_RECEIPT_OPTIONAL_KEYS = ["effectiveReasoningEffort", "effectiveServiceTier", "omniRoute"] as const;

function splitProviderQualifiedModel(modelId: string): { provider: string; model: string } | undefined {
  const separator = modelId.indexOf("/");
  if (separator <= 0 || separator === modelId.length - 1 || modelId.indexOf("/", separator + 1) !== -1) {
    return undefined;
  }
  if (modelId !== modelId.trim()) return undefined;
  const provider = modelId.slice(0, separator);
  const model = modelId.slice(separator + 1);
  if (provider !== provider.trim() || model !== model.trim()) return undefined;
  return { provider, model };
}

function assertTerminalRouteReceipt(
  receipt: CccProviderAttemptEffectiveRoute,
  requestedIdentity: Readonly<{ providerId: string; modelId: string }>,
  receiptAdapterId: CccCampaignRouteReceiptAdapterId | undefined,
): void {
  if (receiptAdapterId === undefined) return;
  const requestedUpstream = splitProviderQualifiedModel(requestedIdentity.modelId);
  if (!requestedUpstream) {
    throw new CccProviderAttemptIdentityError(
      "invalid-input",
      "CCC terminal route receipt adapter requires a provider-qualified requested model",
    );
  }
  const observed = receipt.omniRoute;
  if (!observed) {
    throw new CccProviderAttemptIdentityError(
      "invalid-input",
      "CCC terminal route receipt adapter requires a final terminal route receipt",
    );
  }
  if (
    observed.initial
    && (observed.initial.provider !== observed.final.provider
      || observed.initial.model !== observed.final.model)
  ) {
    throw new CccProviderAttemptIdentityError(
      "route-drift",
      "CCC initial and final terminal route receipts conflict",
    );
  }
  if (
    observed.final.provider !== requestedUpstream.provider
    || observed.final.model !== requestedUpstream.model
  ) {
    throw new CccProviderAttemptIdentityError(
      "route-drift",
      "CCC final terminal provider/model receipt does not match the requested provider-qualified route",
    );
  }
}

function assertExactEffectiveRouteKeys(
  value: Record<string, unknown>,
  optionalKeys: readonly string[],
  error: (message: string) => never,
): void {
  const observed = Object.keys(value);
  for (const key of observed) {
    if (!EFFECTIVE_ROUTE_REQUIRED_KEYS.includes(key as typeof EFFECTIVE_ROUTE_REQUIRED_KEYS[number]) && !optionalKeys.includes(key)) {
      error(`CCC provider attempt effective route has an unexpected field ${key}`);
    }
  }
  for (const key of EFFECTIVE_ROUTE_REQUIRED_KEYS) {
    if (!observed.includes(key)) {
      error(`CCC provider attempt effective route is missing required field ${key}`);
    }
  }
}

/**
 * Validate a settlement's effective-route/usage/cost claim and enforce
 * identity discipline against the attempt's own requested route. Pure and
 * side-effect free so it can be exercised without a database. Campaign
 * fallback is forbidden by policy: a non-null `fallbackReason` is refused,
 * and an effective identity that differs from the requested route is always
 * a refusal, never a record.
 */
export function assertCccProviderAttemptEffectiveRoute(
  input: CccProviderAttemptEffectiveRouteInput | undefined,
  requestedIdentity: Readonly<{ providerId: string; modelId: string }>,
  options: Readonly<{
    receiptAdapterId?: CccCampaignRouteReceiptAdapterId;
    terminalReceiptRequired?: boolean;
  }> = {},
): CccProviderAttemptEffectiveRoute | undefined {
  if (input === undefined) {
    if (
      options.receiptAdapterId !== undefined
      && options.terminalReceiptRequired !== false
    ) {
      throw new CccProviderAttemptIdentityError(
        "invalid-input",
        "CCC terminal route receipt adapter requires an effective route terminal receipt",
      );
    }
    return undefined;
  }
  if (!isRecord(input)) {
    throw new CccProviderAttemptIdentityError(
      "invalid-input",
      "CCC provider attempt effective route must be an object",
    );
  }
  assertExactEffectiveRouteKeys(input, EFFECTIVE_ROUTE_INPUT_OPTIONAL_KEYS, (message) => {
    throw new CccProviderAttemptIdentityError("invalid-input", message);
  });
  if (input.fallbackReason !== null && input.fallbackReason !== undefined) {
    throw new CccProviderAttemptIdentityError(
      "invalid-input",
      "CCC provider attempt fallback is not an admitted behavior; campaign fallback is forbidden by policy",
    );
  }
  const receipt = parseEffectiveRouteFields(input);
  if (
    receipt.effectiveProvider !== requestedIdentity.providerId
    || receipt.effectiveModel !== requestedIdentity.modelId
  ) {
    throw new CccProviderAttemptIdentityError(
      "route-drift",
      "CCC provider attempt effective route does not match its requested provider and model identity; "
        + "campaign fallback is not an admitted behavior",
    );
  }
  if (options.terminalReceiptRequired !== false || receipt.omniRoute !== undefined) {
    assertTerminalRouteReceipt(receipt, requestedIdentity, options.receiptAdapterId);
  }
  assertNoCostWithoutReceipt(receipt);
  return receipt;
}

/**
 * Idempotent-replay comparison for a settlement's effective-route receipt.
 * `sameCanonicalValue` rejects `undefined` (canonical JSON has no `undefined`
 * representation), so this handles absence explicitly rather than delegating
 * an `undefined` operand to it: absent-vs-absent is the legacy no-receipt
 * replay and must resolve idempotently; absent-vs-present or
 * present-vs-different must never resolve idempotently — every such pair a
 * caller can construct falls through to the existing collision refusal.
 */
export function sameCccProviderAttemptEffectiveRoute(
  left: CccProviderAttemptEffectiveRoute | undefined,
  right: CccProviderAttemptEffectiveRoute | undefined,
): boolean {
  if (left === undefined && right === undefined) return true;
  if (left === undefined || right === undefined) return false;
  return sameCanonicalValue(left, right);
}

/** Read-back parser for a persisted effective-route receipt; corrupt audit data is a context error, not an input refusal. */
function parseEffectiveRouteReceipt(value: unknown): CccProviderAttemptEffectiveRoute {
  if (!isRecord(value)) {
    throw new CccCampaignContextError("CCC provider attempt effective route receipt must be an object");
  }
  assertExactEffectiveRouteKeys(value, EFFECTIVE_ROUTE_RECEIPT_OPTIONAL_KEYS, (message) => {
    throw new CccCampaignContextError(message);
  });
  const receipt = parseEffectiveRouteFields(value, (message) => {
    throw new CccCampaignContextError(message);
  });
  assertNoCostWithoutReceipt(receipt);
  return receipt;
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

function requireWorkItemFence(value: unknown): CccCampaignWorkItemFence {
  if (!isRecord(value)) {
    throw new CccProviderAttemptIdentityError(
      "invalid-input",
      "CCC provider attempt work-item fence must be an object",
    );
  }
  const keys = Object.keys(value).sort();
  if (!sameCanonicalValue(keys, ["attempt", "runId", "workItemId"])) {
    throw new CccProviderAttemptIdentityError(
      "invalid-input",
      "CCC provider attempt work-item fence fields must be exactly attempt, runId, workItemId",
    );
  }
  return Object.freeze({
    workItemId: requireCanonicalIdentifier(value.workItemId, "work-item ID"),
    runId: requireCanonicalIdentifier(value.runId, "work-item run ID"),
    attempt: requirePositiveSafeInteger(value.attempt, "work-item attempt"),
  });
}

function scopeIdentity(scope: CccProviderAttemptScope): Record<string, unknown> {
  return {
    attemptKey: scope.attemptKey,
    controllerToken: scope.controllerToken,
    taskId: scope.taskId,
    semanticTaskId: scope.semanticTaskId,
    campaignDeadlineAt: scope.campaignDeadlineAt,
    turnKey: scope.turnKey,
    dispatchKey: scope.dispatchKey,
    attemptOrdinal: scope.attemptOrdinal,
    requestCount: scope.requestCount,
    workItemFence: scope.workItemFence,
    binding: scope.binding,
  };
}

function scopeWithState(
  scope: CccProviderAttemptScope,
  state: CccProviderAttemptState,
  terminal?: TerminalReceipt,
): CccProviderAttemptScope {
  const binding = Object.freeze({ ...scope.binding });
  const workItemFence = scope.workItemFence === null
    ? null
    : Object.freeze({ ...scope.workItemFence });
  return Object.freeze({
    attemptKey: scope.attemptKey,
    controllerToken: scope.controllerToken,
    taskId: scope.taskId,
    semanticTaskId: scope.semanticTaskId,
    campaignDeadlineAt: scope.campaignDeadlineAt,
    turnKey: scope.turnKey,
    dispatchKey: scope.dispatchKey,
    attemptOrdinal: scope.attemptOrdinal,
    requestCount: scope.requestCount,
    workItemFence,
    state,
    ...(terminal ? { terminal: Object.freeze({ ...terminal }) } : {}),
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
  dispatchKey: string;
  attemptOrdinal: number;
  requestCount: number;
  workItemFence: CccCampaignWorkItemFence | null;
  state: CccProviderAttemptState;
  binding: CccCampaignAuthorityBinding;
  terminal?: TerminalReceipt;
}): CccProviderAttemptScope {
  const binding = Object.freeze({ ...input.binding });
  const workItemFence = input.workItemFence === null
    ? null
    : Object.freeze({ ...input.workItemFence });
  return Object.freeze({
    attemptKey: input.attemptKey,
    controllerToken: input.controllerToken,
    taskId: input.taskId,
    semanticTaskId: input.semanticTaskId,
    campaignDeadlineAt: input.campaignDeadlineAt,
    turnKey: input.turnKey,
    dispatchKey: input.dispatchKey,
    attemptOrdinal: input.attemptOrdinal,
    requestCount: input.requestCount,
    workItemFence,
    state: input.state,
    ...(input.terminal ? { terminal: Object.freeze({ ...input.terminal }) } : {}),
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
  const schemaVersion = value.schema;
  if (
    schemaVersion !== CCC_PROVIDER_ATTEMPT_V2_SCHEMA_VERSION
    && schemaVersion !== CCC_PROVIDER_ATTEMPT_V3_SCHEMA_VERSION
    && schemaVersion !== CCC_PROVIDER_ATTEMPT_V4_SCHEMA_VERSION
  ) {
    throw new CccCampaignContextError("CCC provider attempt metadata schema is invalid");
  }
  const legacyBaseKeys = [
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
    "dispatchKey",
  ] as const;
  const baseKeys = schemaVersion === CCC_PROVIDER_ATTEMPT_V2_SCHEMA_VERSION
    ? legacyBaseKeys
    : [...legacyBaseKeys, "workItemFence"];
  const terminalKind = value.terminalKind;
  // effectiveRoute is terminal-only, reconciled-only, and requires v4; a v2/v3
  // row that somehow carries the key is rejected by exactMetadataKeys below.
  const hasEffectiveRoute = schemaVersion === CCC_PROVIDER_ATTEMPT_V4_SCHEMA_VERSION
    && Object.prototype.hasOwnProperty.call(value, "effectiveRoute");
  if (stage !== "terminal") {
    exactMetadataKeys(value, baseKeys);
  } else if (terminalKind === "not-dispatched") {
    exactMetadataKeys(value, [...baseKeys, "terminalKind"]);
  } else if (terminalKind === "reconciled") {
    exactMetadataKeys(value, hasEffectiveRoute
      ? [...baseKeys, "evidenceDigest", "observerId", "terminalKind", "effectiveRoute"]
      : [...baseKeys, "evidenceDigest", "observerId", "terminalKind"]);
  } else {
    throw new CccCampaignContextError("CCC provider attempt terminal metadata has an invalid terminal kind");
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
        ...(hasEffectiveRoute ? { effectiveRoute: parseEffectiveRouteReceipt(value.effectiveRoute) } : {}),
      };
    }
  }
  return {
    schema: schemaVersion,
    attemptKey: requireAttemptKey(value.attemptKey),
    controllerToken: requireControllerToken(value.controllerToken),
    semanticTaskId: requireCanonicalIdentifier(value.semanticTaskId, "semantic task ID"),
    campaignDeadlineAt: assertCanonicalTimestamp(value.campaignDeadlineAt, "campaign deadline"),
    turnKey: requireCanonicalIdentifier(value.turnKey, "turn key"),
    dispatchKey: requireCanonicalIdentifier(value.dispatchKey, "dispatch key"),
    attemptOrdinal: requirePositiveSafeInteger(value.attemptOrdinal, "attempt ordinal"),
    requestCount: requirePositiveSafeInteger(value.requestCount, "request count"),
    workItemFence: schemaVersion === CCC_PROVIDER_ATTEMPT_V2_SCHEMA_VERSION
      ? null
      : requireWorkItemFence(value.workItemFence),
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
  receiptAdapterId: CccCampaignRouteReceiptAdapterId | undefined,
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
  /*
   * A route receipt can only exist on a reconciled settlement. "reserved" and
   * "dispatched" rows carry no terminal at all, and a "not-dispatched" terminal
   * has no effectiveRoute field by construction, so requiring a receipt from
   * those stages is unsatisfiable rather than strict.
   */
  const reconciledTerminal = stage === "terminal" && metadata.terminal?.kind === "reconciled";
  const effectiveRoute = reconciledTerminal ? metadata.terminal!.effectiveRoute : undefined;
  if (
    effectiveRoute
    && (effectiveRoute.effectiveProvider !== binding.providerId || effectiveRoute.effectiveModel !== binding.modelId)
  ) {
    throw new CccCampaignContextError(
      "CCC provider attempt history has an effective route that does not match its persisted binding",
    );
  }
  if (
    reconciledTerminal
    && metadata.terminal?.state === "committed"
    && receiptAdapterId !== undefined
    && !effectiveRoute
  ) {
    throw new CccCampaignContextError(
      "CCC provider attempt history has no required terminal route receipt",
    );
  }
  if (
    effectiveRoute
    && receiptAdapterId !== undefined
    && (metadata.terminal?.state === "committed" || effectiveRoute.omniRoute !== undefined)
  ) {
    try {
      assertTerminalRouteReceipt(effectiveRoute, {
        providerId: binding.providerId,
        modelId: binding.modelId,
      }, receiptAdapterId);
    } catch (error) {
      throw new CccCampaignContextError(
        `CCC provider attempt history has an invalid terminal route receipt: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
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
      dispatchKey: metadata.dispatchKey,
      attemptOrdinal: metadata.attemptOrdinal,
      requestCount: metadata.requestCount,
      workItemFence: metadata.workItemFence,
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
    const { stage, metadata, scope } = assertAuditRow(row, context.route.receiptAdapterId);
    let attempt = attempts.get(scope.attemptKey);
    if (!attempt) {
      attempt = {
        scope: scopeWithState(scope, "reserved"),
        schema: metadata.schema,
        reserved: false,
        dispatched: false,
      };
      attempts.set(scope.attemptKey, attempt);
    } else {
      if (attempt.schema !== metadata.schema) {
        throw new CccCampaignContextError("CCC provider attempt history crossed metadata schema versions");
      }
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
    if (attempt.scope.attemptOrdinal !== attempt.scope.requestCount) {
      throw new CccCampaignContextError(
        "CCC provider attempt history attempt ordinal does not match its persisted request count",
      );
    }
    requestCounts.push(attempt.scope.requestCount);
    if (attempt.terminal) {
      if (attempt.terminal.kind === "not-dispatched" && attempt.dispatched) {
        throw new CccCampaignContextError("CCC provider attempt history proves no dispatch after dispatch was recorded");
      }
      if (attempt.terminal.kind === "reconciled" && !attempt.dispatched) {
        throw new CccCampaignContextError("CCC provider attempt history reconciles an attempt that was never dispatched");
      }
      attempt.scope = scopeWithState(attempt.scope, attempt.terminal.state, attempt.terminal);
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
  dispatchKey: string,
  workItemFence: CccCampaignWorkItemFence,
): string {
  const identity = {
    projectId: context.projectId,
    importId: context.importId,
    campaignId: context.campaignId,
    taskId: context.taskId,
    semanticTaskId: context.semanticTaskId,
    turnKey,
    dispatchKey,
    workItemFence,
  };
  return `ccc-provider-attempt-${createHash("sha256")
    .update(`ccc-provider-attempt/v3\\0${canonicalCccPrdJson(identity)}`, "utf8")
    .digest("hex")}`;
}

function requestedReservation(
  context: CccCampaignTaskContext,
  request: CccProviderAttemptRequest,
): {
  binding: CccCampaignAuthorityBinding;
  attemptKey: string;
  turnKey: string;
  dispatchKey: string;
  workItemFence: CccCampaignWorkItemFence;
  routeMatches: boolean;
} {
  const taskId = requireCanonicalText(request.taskId, "task ID");
  if (taskId !== context.taskId) {
    throw new CccProviderAttemptIdentityError(
      "invalid-input",
      `CCC provider attempt task ${taskId} does not match locked task ${context.taskId}`,
    );
  }
  const turnKey = requireCanonicalIdentifier(request.turnKey, "turn key");
  const dispatchKey = requireCanonicalIdentifier(request.dispatchKey, "dispatch key");
  const workItemFence = requireWorkItemFence(request.workItemFence);
  const binding = createCccCampaignAuthorityBinding(context, {
    actionId: requireCanonicalText(request.actionId, "action ID"),
    actionTarget: requireCanonicalText(request.actionTarget, "action target"),
  });
  return {
    binding,
    attemptKey: deriveAttemptKey(context, turnKey, dispatchKey, workItemFence),
    turnKey,
    dispatchKey,
    workItemFence,
    routeMatches: request.providerId === context.route.providerId
      && request.modelId === context.route.modelId
      && request.transport === context.route.transport,
  };
}

function assertReservationReplay(
  existing: StoredAttempt,
  request: {
    binding: CccCampaignAuthorityBinding;
    attemptKey: string;
    turnKey: string;
    dispatchKey: string;
    workItemFence: CccCampaignWorkItemFence;
  },
  context: CccCampaignTaskContext,
): CccProviderAttemptScope {
  const scope = existing.scope;
  if (
    scope.attemptKey !== request.attemptKey
    || scope.taskId !== context.taskId
    || scope.semanticTaskId !== context.semanticTaskId
    || scope.turnKey !== request.turnKey
    || scope.dispatchKey !== request.dispatchKey
    || !sameCanonicalValue(scope.workItemFence, request.workItemFence)
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
  if (attempt.schema !== CCC_PROVIDER_ATTEMPT_V4_SCHEMA_VERSION) {
    throw new CccProviderAttemptStateError(
      `CCC provider attempt ${attemptKey} uses read-only legacy metadata`,
    );
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
    dispatchKey: scope.dispatchKey,
    attemptOrdinal: scope.attemptOrdinal,
    requestCount: scope.requestCount,
    workItemFence: scope.workItemFence,
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
    ...(terminal.effectiveRoute ? { effectiveRoute: terminal.effectiveRoute } : {}),
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
    if (existing) {
      if (!requested.routeMatches) {
        throw new CccProviderAttemptCollisionError(
          `CCC provider attempt ${requested.attemptKey} collides with changed campaign route`,
        );
      }
      return assertReservationReplay(existing, requested, context);
    }
    const logicalExisting = [...history.attempts.values()].find(({ scope }) =>
      scope.taskId === context.taskId
      && scope.turnKey === requested.turnKey
      && scope.dispatchKey === requested.dispatchKey
    );
    if (logicalExisting) {
      throw new CccProviderAttemptCollisionError(
        `CCC provider attempt ${requested.attemptKey} collides with a changed work-item fence`,
      );
    }
    if (!requested.routeMatches) assertRequestRoute(context, input.request);

    const { maxRequests, maxConcurrency } = admittedBounds(context);
    if (history.activeCount >= maxConcurrency) {
      throw new CccProviderAttemptLimitError(
        "max-concurrency",
        `CCC provider attempt for ${context.taskId} exceeds its admitted concurrency bound`,
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
      dispatchKey: requested.dispatchKey,
      attemptOrdinal: context.requestCount + 1,
      requestCount: context.requestCount + 1,
      workItemFence: requested.workItemFence,
      state: "reserved",
      binding: requested.binding,
    });
    await appendAttemptEvent(tx, now, scope, "reserved");
    await incrementRequestCount(tx, context, scope.requestCount, now);
    return scope;
  });
}

export async function markCccProviderAttemptDispatched(
  _input: TransitionInput,
): Promise<CccProviderAttemptScope> {
  throw new CccProviderAttemptStateError(
    "CCC provider attempt legacy mark-dispatched is fail-closed; use beginCccProviderAttemptDispatch",
  );
}

export async function beginCccProviderAttemptDispatch(
  input: TransitionInput,
): Promise<CccProviderAttemptDispatchDecision> {
  requireCanonicalText(input.transition.taskId, "task ID");
  return withinWriteTransaction(input, async (tx) => {
    const context = await lockedContext(input, tx, input.transition.taskId);
    const attempt = transitionAttempt(await loadHistory(tx, context), input.transition, context.taskId);
    if (attempt.scope.state === "dispatched_unknown") return Object.freeze({ kind: "dispatched-unknown", scope: attempt.scope });
    if (attempt.scope.state !== "reserved") return Object.freeze({ kind: "terminal", scope: attempt.scope });
    const now = await databaseNow(tx);
    assertBeforeDeadline(context, now);
    const dispatched = scopeWithState(attempt.scope, "dispatched_unknown");
    await appendAttemptEvent(tx, now, dispatched, "dispatched");
    return Object.freeze({ kind: "dispatch-permit", scope: dispatched });
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
    const terminalReceipt: TerminalReceipt = { kind: "not-dispatched", state: "proved_failed" };
    const terminal = scopeWithState(attempt.scope, "proved_failed", terminalReceipt);
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
    const effectiveRoute = assertCccProviderAttemptEffectiveRoute(
      input.reconciliation.effectiveRoute,
      {
        providerId: attempt.scope.binding.providerId,
        modelId: attempt.scope.binding.modelId,
      },
      {
        receiptAdapterId: context.route.receiptAdapterId,
        terminalReceiptRequired: outcome === "committed",
      },
    );
    if (attempt.terminal) {
      if (
        attempt.terminal.kind === "reconciled"
        && attempt.terminal.state === outcome
        && attempt.terminal.evidenceDigest === evidenceDigest
        && attempt.terminal.observerId === observerId
        && sameCccProviderAttemptEffectiveRoute(attempt.terminal.effectiveRoute, effectiveRoute)
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
      ...(effectiveRoute ? { effectiveRoute } : {}),
    };
    const terminal = scopeWithState(attempt.scope, outcome, terminalReceipt);
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

export async function listCccProviderAttemptsForCampaign(
  input: ListCccProviderAttemptsForCampaignInput,
): Promise<readonly CccProviderAttemptScope[]> {
  const taskId = requireCanonicalText(input.taskId, "task ID");
  const list = async (tx: DbTransaction): Promise<readonly CccProviderAttemptScope[]> => {
    const context = await loadCccCampaignContextForTask(input.layer, input.rootDir, taskId, tx);
    if (!context) return Object.freeze([]);
    const history = await loadHistory(tx, context);
    return Object.freeze([...history.attempts.values()]
      .map((attempt) => attempt.scope)
      .sort((left, right) => left.requestCount - right.requestCount || left.attemptKey.localeCompare(right.attemptKey)));
  };
  if (input.tx) return list(input.tx);
  return input.layer.transaction(list);
}

/**
 * Prove that a committed settlement with no persisted action lease belongs to
 * the same approved session. Settlement consumes the live-execution approval on
 * the session's first committed terminal, so a follow-on turn of the exact same
 * fenced node visit settles under consumed custody instead of a claimed lease.
 * Callers reach this only when no action lease exists at all; a lease that
 * exists but mismatches must keep refusing on the caller's own settlement error.
 */
export async function assertCccProviderFollowOnSettlementCustody(input: Readonly<{
  layer: AsyncDataLayer;
  rootDir: string;
  tx: DbTransaction;
  authorityStore: CccCampaignAuthorityStore;
  attempt: CccProviderAttemptScope;
}>): Promise<void> {
  const action = {
    actionId: input.attempt.binding.actionId,
    actionTarget: input.attempt.binding.actionTarget,
  };
  const fence = input.attempt.workItemFence;
  const attempts = await listCccProviderAttemptsForCampaign({
    layer: input.layer, rootDir: input.rootDir, taskId: input.attempt.taskId, tx: input.tx,
  });
  const sessionCommitted = fence !== null && attempts.some((scope) =>
    scope.state === "committed"
    && scope.binding.actionId === action.actionId
    && scope.binding.actionTarget === action.actionTarget
    && scope.workItemFence !== null
    && scope.workItemFence.workItemId === fence.workItemId
    && scope.workItemFence.runId === fence.runId
    && scope.workItemFence.attempt === fence.attempt);
  if (!sessionCommitted) {
    throw new Error("CCC committed provider settlement has no exact persisted action lease");
  }
  const custody = await readConsumedCccCampaignApprovalCustodyWithinTransaction(input.tx, {
    authorityStore: input.authorityStore,
    rootDir: input.rootDir,
    taskId: input.attempt.taskId,
    action,
  });
  if (custody.binding.bindingHash !== input.attempt.binding.bindingHash) {
    throw new Error("CCC committed provider settlement has no exact persisted action lease");
  }
}
