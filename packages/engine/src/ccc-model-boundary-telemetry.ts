import { createHmac } from "node:crypto";

export const CCC_MODEL_BOUNDARY_TELEMETRY_SCHEMA_VERSION = "1.0" as const;

export const CCC_MODEL_BOUNDARY_EVENT_STAGES = [
  "request_built",
  "request_dispatched",
  "stream_opened",
  "stream_activity",
  "reasoning_observed",
  "tool_call_observed",
  "tool_result_dispatched",
  "terminal_observed",
  "stream_closed",
  "stream_failed",
  "controller_handoff",
  "proof_started",
] as const;

export const CCC_MODEL_TERMINAL_CLASSIFICATIONS = [
  "none",
  "success",
  "failure",
  "cancelled",
  "dispatched_unknown",
] as const;

export type CccModelBoundaryEventStage =
  (typeof CCC_MODEL_BOUNDARY_EVENT_STAGES)[number];
export type CccModelTerminalClassification =
  (typeof CCC_MODEL_TERMINAL_CLASSIFICATIONS)[number];

export interface CccModelBoundaryEvent {
  readonly schemaVersion: typeof CCC_MODEL_BOUNDARY_TELEMETRY_SCHEMA_VERSION;
  readonly stage: CccModelBoundaryEventStage;
  readonly identity: Readonly<{
    runId: string;
    scenarioId: string;
    turnId: string;
    attemptId: string;
  }>;
  readonly sequence: number;
  readonly capabilityProfileDigest: string;
  readonly requestedRoute: Readonly<{
    provider: string;
    model: string;
    transport: string;
  }>;
  readonly effectiveRoute: Readonly<{
    provider: string;
    model: string;
  }> | null;
  readonly adapterVersion: string;
  readonly omniRouteReceipt: Readonly<{
    present: boolean;
    state: "not_observed" | "requested_only" | "effective_proven" | "invalid";
  }>;
  readonly occurredAt: string;
  readonly elapsedMs: number;
  readonly tool: Readonly<{ name: string; category: string }> | null;
  readonly schemaFingerprints: readonly string[];
  readonly usage: Readonly<{
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  }> | null;
  readonly terminalClassification: CccModelTerminalClassification;
  readonly sensitivePayloadHmac: string | null;
}

export interface CccModelAttemptState {
  readonly attemptId: string;
  readonly identity: CccModelBoundaryEvent["identity"];
  readonly requestedRoute: CccModelBoundaryEvent["requestedRoute"];
  readonly effectiveRoute: CccModelBoundaryEvent["effectiveRoute"];
  readonly requestBuilt: boolean;
  readonly requestDispatched: boolean;
  readonly streamOpened: boolean;
  readonly streamFailed: boolean;
  readonly terminalObserved: boolean;
  readonly streamClosed: boolean;
  readonly controllerHandoff: boolean;
  readonly proofStarted: boolean;
  readonly replayAuthorized: boolean;
  readonly terminalClassification: CccModelTerminalClassification;
  readonly toolCallCount: number;
  readonly toolResultCount: number;
  readonly lastSequence: number;
  readonly lastElapsedMs: number;
}

export class CccModelBoundaryTelemetryValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(issues.join("; "));
    this.name = "CccModelBoundaryTelemetryValidationError";
    this.issues = Object.freeze([...issues]);
  }
}

export class CccModelBoundaryTransitionError extends Error {
  readonly attemptId: string;

  constructor(attemptId: string, reason: string) {
    super(reason);
    this.name = "CccModelBoundaryTransitionError";
    this.attemptId = attemptId;
  }
}

type JsonObject = Record<string, unknown>;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SHA256_FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/;
const HMAC_PATTERN = /^hmac-sha256:[0-9a-f]{64}$/;
const FORBIDDEN_PROPERTY_NAMES = new Set([
  "prompt",
  "reasoningtext",
  "toolarguments",
  "tooloutput",
  "authorization",
  "cookie",
  "apikey",
  "token",
  "environment",
  "database",
  "payload",
  "input",
  "body",
  "headers",
]);

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const entry of Object.values(value)) deepFreeze(entry);
  return Object.freeze(value);
}

function normalizedPropertyName(key: string): string {
  return key.replaceAll(/[-_]/g, "").toLowerCase();
}

function findForbiddenProperties(value: unknown, path = ""): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) =>
      findForbiddenProperties(entry, `${path}[${index}]`),
    );
  }
  if (!isObject(value)) return [];
  return Object.entries(value).flatMap(([key, entry]) => {
    const childPath = path ? `${path}.${key}` : key;
    if (FORBIDDEN_PROPERTY_NAMES.has(normalizedPropertyName(key))) {
      return [`${childPath}: forbidden sensitive or payload-bearing property`];
    }
    return findForbiddenProperties(entry, childPath);
  });
}

function rejectUnknownKeys(
  value: JsonObject,
  allowed: readonly string[],
  path: string,
  issues: string[],
): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(value).sort()) {
    if (!allowedKeys.has(key)) {
      issues.push(`${path ? `${path}.` : ""}${key}: unknown property`);
    }
  }
}

function validateNonEmptyString(
  value: unknown,
  path: string,
  issues: string[],
): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    issues.push(`${path}: must be a non-empty string`);
  }
}

function validateIdentity(
  value: unknown,
  path: string,
  issues: string[],
): void {
  if (!isObject(value)) {
    issues.push(`${path}: must be an object`);
    return;
  }
  const keys = ["runId", "scenarioId", "turnId", "attemptId"] as const;
  rejectUnknownKeys(value, keys, path, issues);
  for (const key of keys) validateNonEmptyString(value[key], `${path}.${key}`, issues);
}

function validateRoute(
  value: unknown,
  path: string,
  includeTransport: boolean,
  issues: string[],
): void {
  if (!isObject(value)) {
    issues.push(`${path}: must be an object`);
    return;
  }
  const keys = includeTransport
    ? (["provider", "model", "transport"] as const)
    : (["provider", "model"] as const);
  rejectUnknownKeys(value, keys, path, issues);
  for (const key of keys) validateNonEmptyString(value[key], `${path}.${key}`, issues);
}

function validateReceipt(value: unknown, issues: string[]): void {
  if (!isObject(value)) {
    issues.push("omniRouteReceipt: must be an object");
    return;
  }
  rejectUnknownKeys(value, ["present", "state"], "omniRouteReceipt", issues);
  if (typeof value.present !== "boolean") {
    issues.push("omniRouteReceipt.present: must be a boolean");
  }
  const states = ["not_observed", "requested_only", "effective_proven", "invalid"];
  if (typeof value.state !== "string" || !states.includes(value.state)) {
    issues.push(`omniRouteReceipt.state: must be one of ${states.join(", ")}`);
  }
  if (value.present === false && value.state !== "not_observed") {
    issues.push("omniRouteReceipt.state: must be not_observed when receipt is absent");
  }
  if (value.present === true && value.state === "not_observed") {
    issues.push("omniRouteReceipt.state: must describe the present receipt");
  }
}

function validateTool(value: unknown, stage: unknown, issues: string[]): void {
  if (value === null) return;
  if (!isObject(value)) {
    issues.push("tool: must be null or an object");
    return;
  }
  rejectUnknownKeys(value, ["name", "category"], "tool", issues);
  validateNonEmptyString(value.name, "tool.name", issues);
  validateNonEmptyString(value.category, "tool.category", issues);
  if (stage !== "tool_call_observed" && stage !== "tool_result_dispatched") {
    issues.push("tool: may be present only for tool boundary stages");
  }
}

function validateFingerprints(value: unknown, issues: string[]): void {
  if (!Array.isArray(value)) {
    issues.push("schemaFingerprints: must be an array");
    return;
  }
  const seen = new Set<string>();
  value.forEach((entry, index) => {
    if (typeof entry !== "string" || !SHA256_FINGERPRINT_PATTERN.test(entry)) {
      issues.push(
        `schemaFingerprints[${index}]: must be a lowercase sha256 fingerprint`,
      );
    } else if (seen.has(entry)) {
      issues.push(`schemaFingerprints[${index}]: duplicate fingerprint`);
    }
    if (typeof entry === "string") seen.add(entry);
  });
}

function validateUsage(value: unknown, issues: string[]): void {
  if (value === null) return;
  if (!isObject(value)) {
    issues.push("usage: must be null or an object");
    return;
  }
  const keys = ["inputTokens", "outputTokens", "totalTokens"] as const;
  rejectUnknownKeys(value, keys, "usage", issues);
  for (const key of keys) {
    if (!Number.isSafeInteger(value[key]) || (value[key] as number) < 0) {
      issues.push(`usage.${key}: must be a non-negative safe integer`);
    }
  }
  if (
    keys.every((key) => Number.isSafeInteger(value[key])) &&
    value.totalTokens !== (value.inputTokens as number) + (value.outputTokens as number)
  ) {
    issues.push("usage.totalTokens: must equal inputTokens plus outputTokens");
  }
}

export function createCccSensitivePayloadHmac(
  key: Uint8Array,
  payload: string | Uint8Array,
): string {
  if (!(key instanceof Uint8Array) || key.byteLength < 32) {
    throw new TypeError("HMAC key must contain at least 32 bytes");
  }
  if (typeof payload !== "string" && !(payload instanceof Uint8Array)) {
    throw new TypeError("Sensitive payload must be a string or Uint8Array");
  }
  return `hmac-sha256:${createHmac("sha256", key).update(payload).digest("hex")}`;
}

export function parseCccModelBoundaryEvent(
  input: unknown,
): Readonly<CccModelBoundaryEvent> {
  const forbidden = findForbiddenProperties(input);
  if (forbidden.length > 0) {
    throw new CccModelBoundaryTelemetryValidationError(forbidden);
  }
  if (!isObject(input)) {
    throw new CccModelBoundaryTelemetryValidationError([
      "event: must be an object",
    ]);
  }
  const issues: string[] = [];
  rejectUnknownKeys(
    input,
    [
      "schemaVersion",
      "stage",
      "identity",
      "sequence",
      "capabilityProfileDigest",
      "requestedRoute",
      "effectiveRoute",
      "adapterVersion",
      "omniRouteReceipt",
      "occurredAt",
      "elapsedMs",
      "tool",
      "schemaFingerprints",
      "usage",
      "terminalClassification",
      "sensitivePayloadHmac",
    ],
    "",
    issues,
  );
  if (input.schemaVersion !== CCC_MODEL_BOUNDARY_TELEMETRY_SCHEMA_VERSION) {
    issues.push(
      `schemaVersion: must equal ${CCC_MODEL_BOUNDARY_TELEMETRY_SCHEMA_VERSION}`,
    );
  }
  if (
    typeof input.stage !== "string" ||
    !(CCC_MODEL_BOUNDARY_EVENT_STAGES as readonly string[]).includes(input.stage)
  ) {
    issues.push(`stage: must be one of ${CCC_MODEL_BOUNDARY_EVENT_STAGES.join(", ")}`);
  }
  validateIdentity(input.identity, "identity", issues);
  if (!Number.isSafeInteger(input.sequence) || (input.sequence as number) <= 0) {
    issues.push("sequence: must be a positive safe integer");
  }
  if (
    typeof input.capabilityProfileDigest !== "string" ||
    !SHA256_PATTERN.test(input.capabilityProfileDigest)
  ) {
    issues.push("capabilityProfileDigest: must be a lowercase SHA-256 digest");
  }
  validateRoute(input.requestedRoute, "requestedRoute", true, issues);
  if (input.effectiveRoute !== null) {
    validateRoute(input.effectiveRoute, "effectiveRoute", false, issues);
  }
  validateNonEmptyString(input.adapterVersion, "adapterVersion", issues);
  validateReceipt(input.omniRouteReceipt, issues);
  if (
    typeof input.occurredAt !== "string" ||
    Number.isNaN(Date.parse(input.occurredAt)) ||
    new Date(input.occurredAt).toISOString() !== input.occurredAt
  ) {
    issues.push("occurredAt: must be a canonical ISO-8601 timestamp");
  }
  if (
    typeof input.elapsedMs !== "number" ||
    !Number.isFinite(input.elapsedMs) ||
    input.elapsedMs < 0
  ) {
    issues.push("elapsedMs: must be a non-negative finite number");
  }
  validateTool(input.tool, input.stage, issues);
  validateFingerprints(input.schemaFingerprints, issues);
  validateUsage(input.usage, issues);
  if (
    typeof input.terminalClassification !== "string" ||
    !(CCC_MODEL_TERMINAL_CLASSIFICATIONS as readonly string[]).includes(
      input.terminalClassification,
    )
  ) {
    issues.push(
      `terminalClassification: must be one of ${CCC_MODEL_TERMINAL_CLASSIFICATIONS.join(", ")}`,
    );
  }
  if (
    input.sensitivePayloadHmac !== null &&
    (typeof input.sensitivePayloadHmac !== "string" ||
      !HMAC_PATTERN.test(input.sensitivePayloadHmac))
  ) {
    issues.push("sensitivePayloadHmac: must be null or a keyed HMAC-SHA-256 token");
  }
  if (issues.length > 0) {
    throw new CccModelBoundaryTelemetryValidationError(issues);
  }
  return deepFreeze(structuredClone(input) as unknown as CccModelBoundaryEvent);
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function serializeCccModelBoundaryEvent(
  event: Readonly<CccModelBoundaryEvent>,
): string {
  return canonicalize(parseCccModelBoundaryEvent(event));
}

interface MutableAttemptState {
  attemptId: string;
  identity: CccModelBoundaryEvent["identity"];
  requestedRoute: CccModelBoundaryEvent["requestedRoute"];
  effectiveRoute: CccModelBoundaryEvent["effectiveRoute"];
  requestBuilt: boolean;
  requestDispatched: boolean;
  streamOpened: boolean;
  streamFailed: boolean;
  terminalObserved: boolean;
  streamClosed: boolean;
  controllerHandoff: boolean;
  proofStarted: boolean;
  replayAuthorized: boolean;
  terminalClassification: CccModelTerminalClassification;
  toolCallCount: number;
  toolResultCount: number;
  lastSequence: number;
  lastElapsedMs: number;
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalize(left) === canonicalize(right);
}

function transitionError(attemptId: string, reason: string): never {
  throw new CccModelBoundaryTransitionError(attemptId, reason);
}

function newAttemptState(event: CccModelBoundaryEvent): MutableAttemptState {
  if (event.stage !== "request_built") {
    transitionError(event.identity.attemptId, "an attempt must begin with request_built");
  }
  return {
    attemptId: event.identity.attemptId,
    identity: event.identity,
    requestedRoute: event.requestedRoute,
    effectiveRoute: event.effectiveRoute,
    requestBuilt: false,
    requestDispatched: false,
    streamOpened: false,
    streamFailed: false,
    terminalObserved: false,
    streamClosed: false,
    controllerHandoff: false,
    proofStarted: false,
    replayAuthorized: false,
    terminalClassification: "none",
    toolCallCount: 0,
    toolResultCount: 0,
    lastSequence: 0,
    lastElapsedMs: 0,
  };
}

function applyTransition(
  state: MutableAttemptState,
  event: CccModelBoundaryEvent,
): void {
  const attemptId = state.attemptId;
  if (event.sequence <= state.lastSequence) {
    transitionError(attemptId, "sequence must strictly increase within an attempt");
  }
  if (event.elapsedMs < state.lastElapsedMs) {
    transitionError(attemptId, "elapsedMs must not decrease within an attempt");
  }
  if (!sameJson(event.identity, state.identity)) {
    transitionError(attemptId, "attempt identity changed within an attempt");
  }
  if (!sameJson(event.requestedRoute, state.requestedRoute)) {
    transitionError(attemptId, "requested route changed within an attempt");
  }
  if (event.effectiveRoute !== null) {
    if (state.effectiveRoute && !sameJson(event.effectiveRoute, state.effectiveRoute)) {
      transitionError(attemptId, "effective route changed after proof");
    }
    state.effectiveRoute = event.effectiveRoute;
  }

  const nonterminalStages: readonly CccModelBoundaryEventStage[] = [
    "request_built",
    "request_dispatched",
    "stream_opened",
    "stream_activity",
    "reasoning_observed",
    "tool_call_observed",
    "tool_result_dispatched",
  ];
  if (
    nonterminalStages.includes(event.stage) &&
    event.terminalClassification !== "none"
  ) {
    transitionError(
      attemptId,
      `${event.stage} requires terminalClassification none`,
    );
  }
  if (
    ["stream_closed", "controller_handoff", "proof_started"].includes(
      event.stage,
    ) &&
    event.terminalClassification !== state.terminalClassification
  ) {
    transitionError(
      attemptId,
      `${event.stage} classification must match the attempt terminal state`,
    );
  }

  switch (event.stage) {
    case "request_built":
      if (state.requestBuilt) transitionError(attemptId, "request_built cannot repeat");
      state.requestBuilt = true;
      break;
    case "request_dispatched":
      if (!state.requestBuilt) {
        transitionError(attemptId, "request_dispatched requires request_built");
      }
      if (state.requestDispatched) {
        transitionError(attemptId, "request_dispatched cannot repeat");
      }
      state.requestDispatched = true;
      break;
    case "stream_opened":
      if (!state.requestDispatched) {
        transitionError(attemptId, "stream_opened requires request_dispatched");
      }
      if (state.streamOpened) transitionError(attemptId, "stream_opened cannot repeat");
      if (state.streamFailed || state.terminalObserved || state.streamClosed) {
        transitionError(attemptId, "stream_opened cannot follow terminal stream state");
      }
      state.streamOpened = true;
      break;
    case "stream_activity":
    case "reasoning_observed":
      if (!state.streamOpened || state.streamFailed || state.terminalObserved || state.streamClosed) {
        transitionError(attemptId, `${event.stage} requires an active open stream`);
      }
      break;
    case "tool_call_observed":
      if (!state.streamOpened || state.streamFailed || state.terminalObserved || state.streamClosed) {
        transitionError(attemptId, "tool_call_observed requires an active open stream");
      }
      state.toolCallCount += 1;
      break;
    case "tool_result_dispatched":
      if (!state.streamOpened || state.streamFailed || state.terminalObserved || state.streamClosed) {
        transitionError(attemptId, "tool_result_dispatched requires an active open stream");
      }
      if (state.toolResultCount >= state.toolCallCount) {
        transitionError(attemptId, "tool_result_dispatched requires an unmatched tool call");
      }
      state.toolResultCount += 1;
      break;
    case "terminal_observed":
      if (state.streamFailed) {
        transitionError(attemptId, "terminal_observed cannot follow stream_failed in the same attempt");
      }
      if (state.terminalObserved) {
        transitionError(attemptId, "terminal_observed cannot repeat");
      }
      if (!state.requestDispatched || !state.streamOpened) {
        transitionError(
          attemptId,
          "terminal_observed requires request_dispatched and stream_opened",
        );
      }
      if (
        event.terminalClassification === "none" ||
        event.terminalClassification === "dispatched_unknown"
      ) {
        transitionError(attemptId, "terminal_observed requires a terminal classification");
      }
      state.terminalObserved = true;
      state.terminalClassification = event.terminalClassification;
      break;
    case "stream_failed":
      if (!state.requestDispatched) {
        transitionError(attemptId, "stream_failed requires request_dispatched");
      }
      if (state.streamFailed) transitionError(attemptId, "stream_failed cannot repeat");
      if (state.terminalObserved || state.streamClosed) {
        transitionError(attemptId, "stream_failed cannot follow terminal stream state");
      }
      if (
        event.terminalClassification !== "failure" &&
        event.terminalClassification !== "dispatched_unknown"
      ) {
        transitionError(
          attemptId,
          "stream_failed requires failure or dispatched_unknown classification",
        );
      }
      state.streamFailed = true;
      state.terminalClassification = event.terminalClassification;
      break;
    case "stream_closed":
      if (!state.streamOpened) {
        transitionError(attemptId, "stream_closed requires stream_opened");
      }
      if (state.streamClosed) transitionError(attemptId, "stream_closed cannot repeat");
      if (!state.terminalObserved && !state.streamFailed) {
        transitionError(attemptId, "stream_closed requires terminal_observed or stream_failed");
      }
      state.streamClosed = true;
      break;
    case "controller_handoff":
      if (!state.terminalObserved || !state.streamClosed) {
        transitionError(
          attemptId,
          "controller_handoff requires terminal_observed and stream_closed",
        );
      }
      if (state.controllerHandoff) {
        transitionError(attemptId, "controller_handoff cannot repeat");
      }
      state.controllerHandoff = true;
      state.replayAuthorized = state.terminalClassification === "success";
      break;
    case "proof_started":
      if (!state.controllerHandoff || state.terminalClassification !== "success") {
        transitionError(
          attemptId,
          "proof_started requires successful terminal controller_handoff",
        );
      }
      if (state.proofStarted) transitionError(attemptId, "proof_started cannot repeat");
      state.proofStarted = true;
      break;
  }
  state.lastSequence = event.sequence;
  state.lastElapsedMs = event.elapsedMs;
}

export function validateCccModelBoundarySequence(
  events: readonly unknown[],
): readonly Readonly<CccModelAttemptState>[] {
  const states = new Map<string, MutableAttemptState>();
  for (const input of events) {
    const event = parseCccModelBoundaryEvent(input);
    const attemptId = event.identity.attemptId;
    let state = states.get(attemptId);
    if (!state) {
      state = newAttemptState(event);
      states.set(attemptId, state);
    }
    applyTransition(state, event);
  }
  return deepFreeze(
    [...states.values()].map((state) => ({
      ...state,
      replayAuthorized:
        state.terminalObserved &&
        state.streamClosed &&
        state.controllerHandoff &&
        state.terminalClassification === "success",
    })),
  );
}
