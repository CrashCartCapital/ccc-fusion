import type {
  CccCampaignAuthorityBinding,
  CccCampaignProviderControllerDecision,
  CccCampaignProviderDispatchInput,
  CccProviderAttemptReconciliation,
  CccProviderAttemptScope,
  CliTerminationReason,
} from "@fusion/core";
import { assertCccCampaignAuthorityBinding } from "@fusion/core";
import type {
  WorkflowMaterializedVisitIdentity,
  WorkflowNodeExecutionFence,
} from "../workflow-graph-executor.js";
import { PermanentError } from "../engine-errors.js";

export const CCC_NATIVE_CLI_BINDING_KIND = "ccc-fusion.native-cli-binding" as const;
export const CCC_NATIVE_CLI_BINDING_VERSION = 1 as const;
export const CCC_NATIVE_CLI_BINDING_ID = "fusion-native:ccc-cli-one-shot" as const;
export const CCC_NATIVE_CLI_DISPATCH_KEY = "cli-agent:1" as const;
export const CCC_NATIVE_CLI_OBSERVER_ID = "ccc-native-cli-observer.v1" as const;
export const CCC_NATIVE_CLI_PRE_PROVIDER_OBSERVER_ID = "ccc-native-cli-pre-provider.v1" as const;
export const CCC_NATIVE_CLI_OBSERVATION_KIND = "ccc-fusion.native-cli-observation" as const;
export const CCC_NATIVE_CLI_OBSERVATION_VERSION = 1 as const;
export const CCC_NATIVE_CLI_SESSION_POLICY_KIND = "ccc-fusion.native-cli-session-policy" as const;
export const CCC_NATIVE_CLI_SESSION_POLICY_VERSION = 1 as const;
export const CCC_NATIVE_CLI_HELD_CLOSURE_KIND = "ccc-fusion.native-cli-held-closure" as const;
export const CCC_NATIVE_CLI_HELD_CLOSURE_VERSION = 1 as const;
export const CCC_NATIVE_CLI_HELD_CLOSURE_EVIDENCE_KIND = "ccc-fusion.native-cli-held-closure-evidence" as const;
export const CCC_NATIVE_CLI_HELD_CLOSURE_EVIDENCE_VERSION = 1 as const;
export const CCC_NATIVE_CLI_TRANSPORT = "cli" as const;
export const CCC_NATIVE_CLI_BINDING_REFUSED_CODE = "CCC_NATIVE_CLI_BINDING_REFUSED" as const;

export type CccNativeCliRoute = Readonly<{
  adapterId: string;
  providerId: string;
  modelId: string;
  transport: typeof CCC_NATIVE_CLI_TRANSPORT;
}>;

export type CccNativeCliLimits = Readonly<{
  maxRequests: 1;
  lifetimeMs: number;
  termGraceMs: number;
  killClosureMs: number;
}>;

export type CccNativeCliObserver = Readonly<{
  id: typeof CCC_NATIVE_CLI_OBSERVER_ID;
  observe: (...args: unknown[]) => unknown;
}>;

export type CccNativeCliObservation = Readonly<{
  kind: typeof CCC_NATIVE_CLI_OBSERVATION_KIND;
  version: typeof CCC_NATIVE_CLI_OBSERVATION_VERSION;
  outcome: "committed" | "proved_failed";
  evidenceDigest: string;
}>;

export type CccNativeCliTerminalObserverId = typeof CCC_NATIVE_CLI_OBSERVER_ID | typeof CCC_NATIVE_CLI_PRE_PROVIDER_OBSERVER_ID;

export type CccNativeCliSessionPolicy = Readonly<{
  kind: typeof CCC_NATIVE_CLI_SESSION_POLICY_KIND;
  version: typeof CCC_NATIVE_CLI_SESSION_POLICY_VERSION;
  attemptKey: string;
  controllerToken: string;
  taskId: string;
  authorityBindingHash: string;
  turnKey: string;
  dispatchKey: typeof CCC_NATIVE_CLI_DISPATCH_KEY;
  route: CccNativeCliRoute;
  deadlineAtMs: number;
  limits: CccNativeCliLimits;
}>;

export type CccNativeCliHeldClosureTrigger = "done" | "exit" | "cancel" | "lifetime";

export type CccNativeCliHeldClosureReceipt = Readonly<{
  kind: typeof CCC_NATIVE_CLI_HELD_CLOSURE_KIND;
  version: typeof CCC_NATIVE_CLI_HELD_CLOSURE_VERSION;
  sessionId: string;
  attemptKey: string;
  controllerToken: string;
  taskId: string;
  authorityBindingHash: string;
  turnKey: string;
  dispatchKey: typeof CCC_NATIVE_CLI_DISPATCH_KEY;
  trigger: CccNativeCliHeldClosureTrigger;
  exitCode: number;
  exitSignal: number;
  processGroupClosed: true;
  proxyClosed: true;
  durableFloorFlushed: true;
  slotHeld: true;
}>;

export type CccNativeCliHeldClosureEvidence = Readonly<{
  kind: typeof CCC_NATIVE_CLI_HELD_CLOSURE_EVIDENCE_KIND;
  version: typeof CCC_NATIVE_CLI_HELD_CLOSURE_EVIDENCE_VERSION;
  sessionId: string;
  trigger: CccNativeCliHeldClosureTrigger;
  exitCode: number;
  exitSignal: number;
  processGroupClosed: true;
  proxyClosed: true;
  durableFloorFlushed: true;
  slotHeld: true;
}>;

export type CccNativeCliController = Readonly<{
  preDispatch: (input: CccCampaignProviderDispatchInput) => Promise<CccCampaignProviderControllerDecision>;
  reconcile: (input: CccNativeCliControllerReconciliation) => Promise<CccProviderAttemptScope>;
}>;

export type CccNativeCliControllerReconciliation = CccProviderAttemptReconciliation & Readonly<{
  terminationReason: CliTerminationReason;
  cancellationState: "CANCELLED" | null;
}>;

export type CccNativeCliBinding = Readonly<{
  kind: typeof CCC_NATIVE_CLI_BINDING_KIND;
  version: typeof CCC_NATIVE_CLI_BINDING_VERSION;
  id: typeof CCC_NATIVE_CLI_BINDING_ID;
  turnKey: string;
  dispatchKey: typeof CCC_NATIVE_CLI_DISPATCH_KEY;
  authorityBindingHash: string;
  route: CccNativeCliRoute;
  limits: CccNativeCliLimits;
  followUp: false;
  observer: CccNativeCliObserver;
  controller: CccNativeCliController;
}>;

export type CccNativeCliBindingResolverInput = Readonly<{
  nodeId: string;
  originTaskId: string;
  semanticTaskId: string;
  nativeTaskId: string;
  executionFence: WorkflowNodeExecutionFence;
  visitIdentity: WorkflowMaterializedVisitIdentity;
  turnKey: string;
  expectedRoute: CccNativeCliRoute;
  signal?: AbortSignal;
}>;

export type CccNativeCliBindingResolver = (
  input: CccNativeCliBindingResolverInput,
) => Promise<unknown>;

export class CccNativeCliBindingRefusedError extends PermanentError {
  public constructor(message: string, details?: Record<string, unknown>) {
    super(message, CCC_NATIVE_CLI_BINDING_REFUSED_CODE, details);
  }
}

export interface CccNativeCliBindingValidationExpectation {
  turnKey: string;
  route: CccNativeCliRoute;
  dispatchKey?: typeof CCC_NATIVE_CLI_DISPATCH_KEY;
}

export interface CccNativeCliPermitScopeValidationExpectation {
  dispatchRequest: CccCampaignProviderDispatchInput;
  semanticTaskId: string;
  nativeTaskId: string;
  authorityBindingHash: string;
  executionFence: WorkflowNodeExecutionFence;
}

export interface CccNativeCliSessionPolicyValidationExpectation {
  adapterId: string;
  taskId: string;
  providerId?: string;
  modelId?: string;
  transport?: typeof CCC_NATIVE_CLI_TRANSPORT;
  nowMs?: number;
}

const TURN_KEY_PATTERN = /^ccc-cli-turn-[a-f0-9]{64}$/;
const AUTHORITY_BINDING_HASH_PATTERN = /^[a-f0-9]{64}$/;
const EVIDENCE_DIGEST_PATTERN = AUTHORITY_BINDING_HASH_PATTERN;
const ATTEMPT_KEY_PATTERN = /^ccc-provider-attempt-[a-f0-9]{64}$/;
const CONTROLLER_TOKEN_PATTERN = /^ccc-provider-controller-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ROOT_KEYS = ["kind", "version", "id", "turnKey", "dispatchKey", "authorityBindingHash", "route", "limits", "followUp", "observer", "controller"] as const;
const SESSION_POLICY_KEYS = ["kind", "version", "attemptKey", "controllerToken", "taskId", "authorityBindingHash", "turnKey", "dispatchKey", "route", "deadlineAtMs", "limits"] as const;
const PERMIT_SCOPE_KEYS = ["attemptKey", "controllerToken", "taskId", "semanticTaskId", "campaignDeadlineAt", "turnKey", "dispatchKey", "attemptOrdinal", "requestCount", "state", "workItemFence", "binding"] as const;
const TERMINAL_SCOPE_KEYS = ["attemptKey", "controllerToken", "taskId", "semanticTaskId", "campaignDeadlineAt", "turnKey", "dispatchKey", "attemptOrdinal", "requestCount", "state", "workItemFence", "binding", "terminal"] as const;
const OBSERVATION_KEYS = ["kind", "version", "outcome", "evidenceDigest"] as const;
const TERMINAL_KEYS = ["kind", "state", "evidenceDigest", "observerId"] as const;
const TERMINAL_KEYS_WITH_EFFECTIVE_ROUTE = [...TERMINAL_KEYS, "effectiveRoute"] as const;
const EFFECTIVE_ROUTE_KEYS = ["effectiveProvider", "effectiveModel", "usage", "cost", "receiptSource"] as const;
const EFFECTIVE_ROUTE_USAGE_KEYS = ["inputTokens", "outputTokens"] as const;
const EFFECTIVE_ROUTE_COST_CLAIM_KEYS = ["amountUsd", "source"] as const;
const EFFECTIVE_ROUTE_COST_UNKNOWN_KEYS = ["kind", "reason"] as const;
const HELD_CLOSURE_RECEIPT_KEYS = ["kind", "version", "sessionId", "attemptKey", "controllerToken", "taskId", "authorityBindingHash", "turnKey", "dispatchKey", "trigger", "exitCode", "exitSignal", "processGroupClosed", "proxyClosed", "durableFloorFlushed", "slotHeld"] as const;
const HELD_CLOSURE_EVIDENCE_KEYS = ["kind", "version", "sessionId", "trigger", "exitCode", "exitSignal", "processGroupClosed", "proxyClosed", "durableFloorFlushed", "slotHeld"] as const;
const ROUTE_KEYS = ["adapterId", "providerId", "modelId", "transport"] as const;
const LIMIT_KEYS = ["maxRequests", "lifetimeMs", "termGraceMs", "killClosureMs"] as const;
const OBSERVER_KEYS = ["id", "observe"] as const;
const CONTROLLER_KEYS = ["preDispatch", "reconcile"] as const;
const WORK_ITEM_FENCE_KEYS = ["workItemId", "runId", "attempt"] as const;
const LEASED_EXECUTION_FENCE_KEYS = ["workItemId", "leaseOwner", "attempt", "runId"] as const;

export function assertCanonicalCccNativeCliTurnKey(value: unknown, label = "turnKey"): string {
  if (typeof value !== "string" || !TURN_KEY_PATTERN.test(value)) {
    throw new CccNativeCliBindingRefusedError(`CCC native CLI ${label} must be canonical ccc-cli-turn hex`);
  }
  return value;
}

export function assertCanonicalCccNativeCliText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new CccNativeCliBindingRefusedError(`CCC native CLI ${label} must be canonical nonblank text`);
  }
  return value;
}

export function validateCccNativeCliBinding(
  value: unknown,
  expected: CccNativeCliBindingValidationExpectation,
): CccNativeCliBinding {
  const binding = requirePlainFrozenExactObject(value, ROOT_KEYS, "binding") as Record<string, unknown>;
  if (binding.kind !== CCC_NATIVE_CLI_BINDING_KIND) throw refused("binding.kind mismatch");
  if (binding.version !== CCC_NATIVE_CLI_BINDING_VERSION) throw refused("binding.version mismatch");
  if (binding.id !== CCC_NATIVE_CLI_BINDING_ID) throw refused("binding.id mismatch");
  if (binding.turnKey !== expected.turnKey) throw refused("binding.turnKey mismatch");
  if (binding.dispatchKey !== (expected.dispatchKey ?? CCC_NATIVE_CLI_DISPATCH_KEY)) throw refused("binding.dispatchKey mismatch");
  if (typeof binding.authorityBindingHash !== "string" || !AUTHORITY_BINDING_HASH_PATTERN.test(binding.authorityBindingHash)) {
    throw refused("binding.authorityBindingHash must be lowercase 64-hex");
  }
  if (binding.followUp !== false) throw refused("binding.followUp must be false");

  validateRoute(binding.route, expected.route);
  validateLimits(binding.limits);
  validateObserver(binding.observer);
  validateController(binding.controller);

  return binding as unknown as CccNativeCliBinding;
}

export function validateCccNativeCliPermitScope(
  value: unknown,
  expected: CccNativeCliPermitScopeValidationExpectation,
): CccProviderAttemptScope {
  const scope = requirePlainFrozenExactObject(value, PERMIT_SCOPE_KEYS, "permit scope") as Record<string, unknown>;
  if (typeof scope.attemptKey !== "string" || !ATTEMPT_KEY_PATTERN.test(scope.attemptKey)) {
    throw refused("permit scope attemptKey must be canonical");
  }
  if (typeof scope.controllerToken !== "string" || !CONTROLLER_TOKEN_PATTERN.test(scope.controllerToken)) {
    throw refused("permit scope controllerToken must be canonical");
  }
  const taskId = assertCanonicalCccNativeCliText(scope.taskId, "permit scope taskId");
  const semanticTaskId = assertCanonicalCccNativeCliText(scope.semanticTaskId, "permit scope semanticTaskId");
  assertCanonicalCccNativeCliText(scope.campaignDeadlineAt, "permit scope campaignDeadlineAt");
  if (taskId !== expected.nativeTaskId) throw refused("permit scope taskId must match sealed nativeTaskId");
  if (semanticTaskId !== expected.semanticTaskId) throw refused("permit scope semanticTaskId must match sealed semanticTaskId");
  if (scope.turnKey !== expected.dispatchRequest.turnKey) throw refused("permit scope turnKey mismatch");
  if (scope.dispatchKey !== expected.dispatchRequest.dispatchKey) throw refused("permit scope dispatchKey mismatch");
  const attemptOrdinal = requirePositiveSafeInteger(scope.attemptOrdinal, "permit scope attemptOrdinal");
  // requestCount is the campaign-wide reservation counter, not a per-attempt request budget:
  // core mints attemptOrdinal and requestCount together, so a later task legitimately carries N > 1.
  // One-shot semantics stay pinned by the equality, which admits exactly one request per ordinal.
  requirePositiveSafeInteger(scope.requestCount, "permit scope requestCount");
  if (scope.requestCount !== attemptOrdinal) {
    throw refused("permit scope requestCount must equal attemptOrdinal");
  }
  if (scope.state !== "dispatched_unknown") throw refused("permit scope state must be dispatched_unknown");
  if (Object.hasOwn(scope, "terminal")) throw refused("permit scope terminal must be absent");
  validateWorkItemFence(scope.workItemFence, expected.executionFence, "permit scope work-item fence");
  if (!Object.isFrozen(scope.binding)) throw refused("permit scope binding must be frozen");

  let authorityBinding: CccCampaignAuthorityBinding;
  try {
    authorityBinding = assertCccCampaignAuthorityBinding(scope.binding as CccCampaignAuthorityBinding);
  } catch (err) {
    throw new CccNativeCliBindingRefusedError(
      `CCC native CLI binding refused: permit scope authority binding invalid: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (authorityBinding.bindingHash !== expected.authorityBindingHash) {
    throw refused("permit scope authority binding hash mismatch");
  }
  if (authorityBinding.taskId !== taskId) throw refused("permit scope authority binding taskId mismatch");
  if (authorityBinding.providerId !== expected.dispatchRequest.providerId) throw refused("permit scope authority binding providerId mismatch");
  if (authorityBinding.modelId !== expected.dispatchRequest.modelId) throw refused("permit scope authority binding modelId mismatch");
  if (authorityBinding.transport !== expected.dispatchRequest.transport) throw refused("permit scope authority binding transport mismatch");

  return value as CccProviderAttemptScope;
}

export function validateCccNativeCliHoldScope(
  value: unknown,
  expected: CccNativeCliPermitScopeValidationExpectation,
): CccProviderAttemptScope {
  const candidate = value as Record<string, unknown>;
  if (candidate?.state === "dispatched_unknown") {
    return validateCccNativeCliPermitScope(value, expected);
  }
  if (candidate?.state !== "committed" && candidate?.state !== "proved_failed") {
    throw refused("hold scope state must be dispatched_unknown, committed, or proved_failed");
  }
  const scope = requirePlainFrozenExactObject(value, TERMINAL_SCOPE_KEYS, "hold terminal scope") as Record<string, unknown>;
  const terminal = requireCccNativeCliTerminalReceiptShape(scope.terminal, "hold terminal scope terminal");
  if (
    terminal.observerId !== CCC_NATIVE_CLI_OBSERVER_ID
    && terminal.observerId !== CCC_NATIVE_CLI_PRE_PROVIDER_OBSERVER_ID
  ) {
    throw refused("hold terminal scope observer is not a native CLI observer");
  }
  const observation = validateCccNativeCliObservation(Object.freeze({
    kind: CCC_NATIVE_CLI_OBSERVATION_KIND,
    version: CCC_NATIVE_CLI_OBSERVATION_VERSION,
    outcome: candidate.state,
    evidenceDigest: terminal.evidenceDigest,
  }));
  const permitScope = Object.freeze({
    attemptKey: scope.attemptKey,
    controllerToken: scope.controllerToken,
    taskId: scope.taskId,
    semanticTaskId: scope.semanticTaskId,
    campaignDeadlineAt: scope.campaignDeadlineAt,
    turnKey: scope.turnKey,
    dispatchKey: scope.dispatchKey,
    attemptOrdinal: scope.attemptOrdinal,
    requestCount: scope.requestCount,
    state: "dispatched_unknown" as const,
    workItemFence: scope.workItemFence,
    binding: scope.binding,
  });
  const validatedPermit = validateCccNativeCliPermitScope(permitScope, expected);
  return validateCccNativeCliTerminalScope(value, {
    permitScope: validatedPermit,
    observation,
    observerId: terminal.observerId,
  });
}

export function validateCccNativeCliSessionPolicy(
  value: unknown,
  expected: CccNativeCliSessionPolicyValidationExpectation,
): CccNativeCliSessionPolicy {
  const policy = requirePlainFrozenExactObject(value, SESSION_POLICY_KEYS, "session policy") as Record<string, unknown>;
  if (policy.kind !== CCC_NATIVE_CLI_SESSION_POLICY_KIND) throw refused("session policy.kind mismatch");
  if (policy.version !== CCC_NATIVE_CLI_SESSION_POLICY_VERSION) throw refused("session policy.version mismatch");
  if (typeof policy.attemptKey !== "string" || !ATTEMPT_KEY_PATTERN.test(policy.attemptKey)) {
    throw refused("session policy attemptKey must be canonical");
  }
  if (typeof policy.controllerToken !== "string" || !CONTROLLER_TOKEN_PATTERN.test(policy.controllerToken)) {
    throw refused("session policy controllerToken must be canonical");
  }
  const taskId = assertCanonicalCccNativeCliText(policy.taskId, "session policy taskId");
  if (taskId !== expected.taskId) throw refused("session policy taskId mismatch");
  if (typeof policy.authorityBindingHash !== "string" || !AUTHORITY_BINDING_HASH_PATTERN.test(policy.authorityBindingHash)) {
    throw refused("session policy authorityBindingHash must be lowercase 64-hex");
  }
  assertCanonicalCccNativeCliTurnKey(policy.turnKey, "session policy turnKey");
  if (policy.dispatchKey !== CCC_NATIVE_CLI_DISPATCH_KEY) throw refused("session policy dispatchKey mismatch");
  validateRoute(policy.route, {
    adapterId: expected.adapterId,
    providerId: expected.providerId ?? getPolicyRouteText(policy.route, "providerId"),
    modelId: expected.modelId ?? getPolicyRouteText(policy.route, "modelId"),
    transport: expected.transport ?? CCC_NATIVE_CLI_TRANSPORT,
  });
  const deadlineAtMs = policy.deadlineAtMs;
  const nowMs = expected.nowMs ?? Date.now();
  if (typeof deadlineAtMs !== "number" || !Number.isSafeInteger(deadlineAtMs) || deadlineAtMs <= nowMs) {
    throw refused("session policy deadlineAtMs must be a future safe integer");
  }
  const limits = validateLimits(policy.limits);
  if (deadlineAtMs - nowMs < limits.termGraceMs + limits.killClosureMs) {
    throw refused("session policy must allow full closure budget before deadline");
  }
  return policy as unknown as CccNativeCliSessionPolicy;
}

export function buildCccNativeCliSessionPolicy(
  binding: CccNativeCliBinding,
  permitScope: CccProviderAttemptScope,
  observedAtMs = Date.now(),
): CccNativeCliSessionPolicy {
  const policy = Object.freeze({
    kind: CCC_NATIVE_CLI_SESSION_POLICY_KIND,
    version: CCC_NATIVE_CLI_SESSION_POLICY_VERSION,
    attemptKey: permitScope.attemptKey,
    controllerToken: permitScope.controllerToken,
    taskId: permitScope.taskId,
    authorityBindingHash: binding.authorityBindingHash,
    turnKey: permitScope.turnKey,
    dispatchKey: CCC_NATIVE_CLI_DISPATCH_KEY,
    route: binding.route,
    deadlineAtMs: Math.min(Date.parse(permitScope.campaignDeadlineAt), observedAtMs + binding.limits.lifetimeMs),
    limits: binding.limits,
  }) satisfies CccNativeCliSessionPolicy;
  return validateCccNativeCliSessionPolicy(policy, {
    adapterId: binding.route.adapterId,
    taskId: permitScope.taskId,
    providerId: binding.route.providerId,
    modelId: binding.route.modelId,
    transport: binding.route.transport,
    nowMs: observedAtMs,
  });
}

export function validateCccNativeCliObservation(value: unknown): CccNativeCliObservation {
  const observation = requirePlainFrozenExactObject(value, OBSERVATION_KEYS, "observation") as Record<string, unknown>;
  if (observation.kind !== CCC_NATIVE_CLI_OBSERVATION_KIND) throw refused("observation.kind mismatch");
  if (observation.version !== CCC_NATIVE_CLI_OBSERVATION_VERSION) throw refused("observation.version mismatch");
  if (observation.outcome !== "committed" && observation.outcome !== "proved_failed") {
    throw refused("observation.outcome must be committed or proved_failed");
  }
  if (typeof observation.evidenceDigest !== "string" || !EVIDENCE_DIGEST_PATTERN.test(observation.evidenceDigest)) {
    throw refused("observation.evidenceDigest must be lowercase 64-hex");
  }
  return observation as unknown as CccNativeCliObservation;
}

export function validateCccNativeCliTerminalScope(
  value: unknown,
  expected: Readonly<{
    permitScope: CccProviderAttemptScope;
    observation: CccNativeCliObservation;
    observerId?: CccNativeCliTerminalObserverId;
  }>,
): CccProviderAttemptScope {
  const observation = validateCccNativeCliObservation(expected.observation);
  const scope = requirePlainFrozenExactObject(value, TERMINAL_SCOPE_KEYS, "terminal scope") as Record<string, unknown>;

  if (scope.attemptKey !== expected.permitScope.attemptKey) throw refused("terminal scope attemptKey mismatch");
  if (scope.controllerToken !== expected.permitScope.controllerToken) throw refused("terminal scope controllerToken mismatch");
  if (scope.taskId !== expected.permitScope.taskId) throw refused("terminal scope taskId mismatch");
  if (scope.semanticTaskId !== expected.permitScope.semanticTaskId) throw refused("terminal scope semanticTaskId mismatch");
  if (scope.campaignDeadlineAt !== expected.permitScope.campaignDeadlineAt) throw refused("terminal scope campaignDeadlineAt mismatch");
  if (scope.turnKey !== expected.permitScope.turnKey) throw refused("terminal scope turnKey mismatch");
  if (scope.dispatchKey !== expected.permitScope.dispatchKey) throw refused("terminal scope dispatchKey mismatch");
  if (scope.attemptOrdinal !== expected.permitScope.attemptOrdinal) throw refused("terminal scope attemptOrdinal mismatch");
  if (scope.requestCount !== expected.permitScope.requestCount) throw refused("terminal scope requestCount mismatch");
  if (scope.state !== observation.outcome) throw refused("terminal scope state must match observation outcome");
  validateWorkItemFence(
    scope.workItemFence,
    expected.permitScope.workItemFence,
    "terminal scope work-item fence",
  );
  const terminalBinding = validateAuthorityBinding(scope.binding, "terminal scope authority binding");
  const permitBinding = validateAuthorityBinding(expected.permitScope.binding, "permit scope authority binding");
  if (terminalBinding.bindingHash !== permitBinding.bindingHash) {
    throw refused("terminal scope authority binding hash mismatch");
  }
  if (!sameCanonicalAuthorityBinding(terminalBinding, permitBinding)) {
    throw refused("terminal scope authority binding identity mismatch");
  }

  validateTerminalReceipt(scope.terminal, observation, expected.observerId ?? CCC_NATIVE_CLI_OBSERVER_ID);

  return value as CccProviderAttemptScope;
}

export function validateCccNativeCliHeldClosureReceipt(
  value: unknown,
  expected: Readonly<{
    sessionId: string;
    policy: CccNativeCliSessionPolicy;
  }>,
): CccNativeCliHeldClosureReceipt {
  const receipt = requirePlainFrozenExactObject(value, HELD_CLOSURE_RECEIPT_KEYS, "held closure receipt") as Record<string, unknown>;
  if (receipt.kind !== CCC_NATIVE_CLI_HELD_CLOSURE_KIND) throw refused("held closure receipt.kind mismatch");
  if (receipt.version !== CCC_NATIVE_CLI_HELD_CLOSURE_VERSION) throw refused("held closure receipt.version mismatch");
  if (receipt.sessionId !== expected.sessionId) throw refused("held closure receipt sessionId mismatch");
  if (receipt.attemptKey !== expected.policy.attemptKey) throw refused("held closure receipt attemptKey mismatch");
  if (receipt.controllerToken !== expected.policy.controllerToken) throw refused("held closure receipt controllerToken mismatch");
  if (receipt.taskId !== expected.policy.taskId) throw refused("held closure receipt taskId mismatch");
  if (receipt.authorityBindingHash !== expected.policy.authorityBindingHash) throw refused("held closure receipt authorityBindingHash mismatch");
  if (receipt.turnKey !== expected.policy.turnKey) throw refused("held closure receipt turnKey mismatch");
  if (receipt.dispatchKey !== expected.policy.dispatchKey) throw refused("held closure receipt dispatchKey mismatch");
  if (!isHeldClosureTrigger(receipt.trigger)) throw refused("held closure receipt trigger mismatch");
  if (typeof receipt.exitCode !== "number" || !Number.isSafeInteger(receipt.exitCode)) {
    throw refused("held closure receipt exitCode must be a safe integer");
  }
  if (typeof receipt.exitSignal !== "number" || !Number.isSafeInteger(receipt.exitSignal)) {
    throw refused("held closure receipt exitSignal must be a safe integer");
  }
  if (receipt.processGroupClosed !== true) throw refused("held closure receipt processGroupClosed must be true");
  if (receipt.proxyClosed !== true) throw refused("held closure receipt proxyClosed must be true");
  if (receipt.durableFloorFlushed !== true) throw refused("held closure receipt durableFloorFlushed must be true");
  if (receipt.slotHeld !== true) throw refused("held closure receipt slotHeld must be true");
  return receipt as unknown as CccNativeCliHeldClosureReceipt;
}

export function buildCccNativeCliHeldClosureEvidence(
  input: Readonly<{
    sessionId: string;
    trigger: CccNativeCliHeldClosureTrigger;
    exitCode: number;
    exitSignal: number;
  }>,
): CccNativeCliHeldClosureEvidence {
  return validateCccNativeCliHeldClosureEvidence(Object.freeze({
    kind: CCC_NATIVE_CLI_HELD_CLOSURE_EVIDENCE_KIND,
    version: CCC_NATIVE_CLI_HELD_CLOSURE_EVIDENCE_VERSION,
    sessionId: input.sessionId,
    trigger: input.trigger,
    exitCode: input.exitCode,
    exitSignal: input.exitSignal,
    processGroupClosed: true,
    proxyClosed: true,
    durableFloorFlushed: true,
    slotHeld: true,
  }), input.sessionId);
}

export function restoreCccNativeCliHeldClosureReceipt(
  value: unknown,
  expected: Readonly<{
    sessionId: string;
    attemptKey: string;
    controllerToken: string;
    taskId: string;
    authorityBindingHash: string;
    turnKey: string;
    dispatchKey: typeof CCC_NATIVE_CLI_DISPATCH_KEY;
  }>,
): CccNativeCliHeldClosureReceipt {
  const evidence = validateCccNativeCliHeldClosureEvidence(value, expected.sessionId);
  return Object.freeze({
    kind: CCC_NATIVE_CLI_HELD_CLOSURE_KIND,
    version: CCC_NATIVE_CLI_HELD_CLOSURE_VERSION,
    sessionId: evidence.sessionId,
    attemptKey: expected.attemptKey,
    controllerToken: expected.controllerToken,
    taskId: expected.taskId,
    authorityBindingHash: expected.authorityBindingHash,
    turnKey: expected.turnKey,
    dispatchKey: expected.dispatchKey,
    trigger: evidence.trigger,
    exitCode: evidence.exitCode,
    exitSignal: evidence.exitSignal,
    processGroupClosed: true,
    proxyClosed: true,
    durableFloorFlushed: true,
    slotHeld: true,
  });
}

function validateCccNativeCliHeldClosureEvidence(
  value: unknown,
  expectedSessionId: string,
): CccNativeCliHeldClosureEvidence {
  if (!isPlainObject(value)) throw refused("held closure evidence must be a plain object");
  const actualKeys = Object.keys(value);
  if (
    actualKeys.length !== HELD_CLOSURE_EVIDENCE_KEYS.length
    || HELD_CLOSURE_EVIDENCE_KEYS.some((key) => !Object.hasOwn(value, key))
  ) {
    throw refused(`held closure evidence must have exact keys: ${HELD_CLOSURE_EVIDENCE_KEYS.join(", ")}`);
  }
  if (value.kind !== CCC_NATIVE_CLI_HELD_CLOSURE_EVIDENCE_KIND) throw refused("held closure evidence.kind mismatch");
  if (value.version !== CCC_NATIVE_CLI_HELD_CLOSURE_EVIDENCE_VERSION) throw refused("held closure evidence.version mismatch");
  if (value.sessionId !== expectedSessionId) throw refused("held closure evidence sessionId mismatch");
  if (!isHeldClosureTrigger(value.trigger)) throw refused("held closure evidence trigger mismatch");
  if (typeof value.exitCode !== "number" || !Number.isSafeInteger(value.exitCode)) {
    throw refused("held closure evidence exitCode must be a safe integer");
  }
  if (typeof value.exitSignal !== "number" || !Number.isSafeInteger(value.exitSignal)) {
    throw refused("held closure evidence exitSignal must be a safe integer");
  }
  if (value.processGroupClosed !== true) throw refused("held closure evidence processGroupClosed must be true");
  if (value.proxyClosed !== true) throw refused("held closure evidence proxyClosed must be true");
  if (value.durableFloorFlushed !== true) throw refused("held closure evidence durableFloorFlushed must be true");
  if (value.slotHeld !== true) throw refused("held closure evidence slotHeld must be true");
  return Object.freeze({
    kind: value.kind,
    version: value.version,
    sessionId: value.sessionId,
    trigger: value.trigger,
    exitCode: value.exitCode,
    exitSignal: value.exitSignal,
    processGroupClosed: true,
    proxyClosed: true,
    durableFloorFlushed: true,
    slotHeld: true,
  });
}

function validateRoute(value: unknown, expected: CccNativeCliRoute): void {
  const route = requirePlainFrozenExactObject(value, ROUTE_KEYS, "binding.route") as Record<string, unknown>;
  if (route.adapterId !== expected.adapterId) throw refused("binding.route.adapterId mismatch");
  if (route.providerId !== expected.providerId) throw refused("binding.route.providerId mismatch");
  if (route.modelId !== expected.modelId) throw refused("binding.route.modelId mismatch");
  if (route.transport !== CCC_NATIVE_CLI_TRANSPORT || route.transport !== expected.transport) {
    throw refused("binding.route.transport mismatch");
  }
}

function validateLimits(value: unknown): CccNativeCliLimits {
  const limits = requirePlainFrozenExactObject(value, LIMIT_KEYS, "binding.limits") as Record<string, unknown>;
  const maxRequests = limits.maxRequests;
  if (maxRequests !== 1) throw refused("binding.limits.maxRequests must be exactly 1");
  const lifetimeMs = requirePositiveSafeInteger(limits.lifetimeMs, "binding.limits.lifetimeMs");
  const termGraceMs = requirePositiveSafeInteger(limits.termGraceMs, "binding.limits.termGraceMs");
  const killClosureMs = requirePositiveSafeInteger(limits.killClosureMs, "binding.limits.killClosureMs");
  if (termGraceMs + killClosureMs > lifetimeMs) {
    throw refused("binding.limits termGraceMs plus killClosureMs must be <= lifetimeMs");
  }
  return {
    maxRequests: maxRequests,
    lifetimeMs,
    termGraceMs,
    killClosureMs,
  };
}

function validateObserver(value: unknown): void {
  const observer = requirePlainFrozenExactObject(value, OBSERVER_KEYS, "binding.observer") as Record<string, unknown>;
  if (observer.id !== CCC_NATIVE_CLI_OBSERVER_ID) throw refused("binding.observer.id mismatch");
  if (typeof observer.observe !== "function") throw refused("binding.observer.observe must be a function");
}

function validateController(value: unknown): void {
  const controller = requirePlainFrozenExactObject(value, CONTROLLER_KEYS, "binding.controller") as Record<string, unknown>;
  if (typeof controller.preDispatch !== "function") throw refused("binding.controller.preDispatch must be a function");
  if (typeof controller.reconcile !== "function") throw refused("binding.controller.reconcile must be a function");
}

function validateAuthorityBinding(value: unknown, label: string): CccCampaignAuthorityBinding {
  if (!Object.isFrozen(value)) throw refused(`${label} must be frozen`);
  try {
    return assertCccCampaignAuthorityBinding(value as CccCampaignAuthorityBinding);
  } catch (err) {
    throw new CccNativeCliBindingRefusedError(
      `CCC native CLI binding refused: ${label} invalid: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function validateWorkItemFence(
  value: unknown,
  expected: unknown,
  label: string,
): WorkflowNodeExecutionFence {
  const expectedHasLeaseOwner = isPlainObject(expected) && Object.hasOwn(expected, "leaseOwner");
  const sealedFence = requirePlainFrozenExactObject(
    expected,
    expectedHasLeaseOwner ? LEASED_EXECUTION_FENCE_KEYS : WORK_ITEM_FENCE_KEYS,
    "sealed execution work-item fence",
  ) as Record<string, unknown>;
  const sealedWorkItemId = assertCanonicalCccNativeCliText(
    sealedFence.workItemId,
    "sealed execution work-item fence workItemId",
  );
  const sealedRunId = assertCanonicalCccNativeCliText(
    sealedFence.runId,
    "sealed execution work-item fence runId",
  );
  const sealedAttempt = requirePositiveSafeInteger(
    sealedFence.attempt,
    "sealed execution work-item fence attempt",
  );
  if (expectedHasLeaseOwner) {
    assertCanonicalCccNativeCliText(
      sealedFence.leaseOwner,
      "sealed execution work-item fence leaseOwner",
    );
  }
  const fence = requirePlainFrozenExactObject(value, WORK_ITEM_FENCE_KEYS, label) as Record<string, unknown>;
  const workItemId = assertCanonicalCccNativeCliText(fence.workItemId, `${label} workItemId`);
  const runId = assertCanonicalCccNativeCliText(fence.runId, `${label} runId`);
  const attempt = requirePositiveSafeInteger(fence.attempt, `${label} attempt`);
  if (
    workItemId !== sealedWorkItemId
    || runId !== sealedRunId
    || attempt !== sealedAttempt
  ) {
    throw refused(`${label} must match sealed execution fence`);
  }
  return value as WorkflowNodeExecutionFence;
}

function validateTerminalReceipt(value: unknown, observation: CccNativeCliObservation, observerId: CccNativeCliTerminalObserverId): void {
  const terminal = requireCccNativeCliTerminalReceiptShape(value, "terminal scope terminal");
  if (terminal.kind !== "reconciled") throw refused("terminal scope terminal.kind mismatch");
  if (terminal.state !== observation.outcome) throw refused("terminal scope terminal.state mismatch");
  if (terminal.evidenceDigest !== observation.evidenceDigest) throw refused("terminal scope terminal.evidenceDigest mismatch");
  if (terminal.observerId !== observerId) throw refused("terminal scope terminal.observerId mismatch");
  if (Object.hasOwn(terminal, "effectiveRoute")) {
    validateCccNativeCliEffectiveRoute(terminal.effectiveRoute);
  }
}

/**
 * A terminal receipt is legacy-shaped (kind/state/evidenceDigest/observerId
 * only) unless it also carries an `effectiveRoute` claim, which is optional
 * and validated separately. Shared by the terminal-scope validator and the
 * terminal-hold replay peek so both paths accept the same persisted shape.
 */
function requireCccNativeCliTerminalReceiptShape(value: unknown, label: string): Record<string, unknown> {
  const hasEffectiveRoute = isPlainObject(value) && Object.hasOwn(value, "effectiveRoute");
  return requirePlainFrozenExactObject(
    value,
    hasEffectiveRoute ? TERMINAL_KEYS_WITH_EFFECTIVE_ROUTE : TERMINAL_KEYS,
    label,
  ) as Record<string, unknown>;
}

/**
 * Honest "this is what we launched" identity only — shape validation, not an
 * independent drift check (that already happened upstream when the receipt
 * was reconciled). Mirrors the exact-key discipline the CCC provider-attempt
 * schema enforces, without importing its unexported parser.
 */
function validateCccNativeCliEffectiveRoute(value: unknown): void {
  const route = requirePlainFrozenExactObject(value, EFFECTIVE_ROUTE_KEYS, "terminal scope terminal.effectiveRoute") as Record<string, unknown>;
  assertCanonicalCccNativeCliText(route.effectiveProvider, "terminal scope terminal.effectiveRoute.effectiveProvider");
  assertCanonicalCccNativeCliText(route.effectiveModel, "terminal scope terminal.effectiveRoute.effectiveModel");
  validateEffectiveRouteUsage(route.usage);
  validateEffectiveRouteCost(route.cost);
  if (route.receiptSource !== "stream-usage" && route.receiptSource !== "provider-api" && route.receiptSource !== "none") {
    throw refused("terminal scope terminal.effectiveRoute.receiptSource must be stream-usage, provider-api, or none");
  }
}

function validateEffectiveRouteUsage(value: unknown): void {
  if (value === null) return;
  const usage = requirePlainFrozenExactObject(
    value,
    EFFECTIVE_ROUTE_USAGE_KEYS,
    "terminal scope terminal.effectiveRoute.usage",
  ) as Record<string, unknown>;
  requireNonNegativeSafeInteger(usage.inputTokens, "terminal scope terminal.effectiveRoute.usage.inputTokens");
  requireNonNegativeSafeInteger(usage.outputTokens, "terminal scope terminal.effectiveRoute.usage.outputTokens");
}

function validateEffectiveRouteCost(value: unknown): void {
  const keys = isPlainObject(value) ? Object.keys(value) : [];
  const looksLikeClaim = keys.includes("amountUsd") || keys.includes("source");
  const cost = requirePlainFrozenExactObject(
    value,
    looksLikeClaim ? EFFECTIVE_ROUTE_COST_CLAIM_KEYS : EFFECTIVE_ROUTE_COST_UNKNOWN_KEYS,
    "terminal scope terminal.effectiveRoute.cost",
  ) as Record<string, unknown>;
  if (looksLikeClaim) {
    if (typeof cost.amountUsd !== "number" || !Number.isFinite(cost.amountUsd) || cost.amountUsd < 0) {
      throw refused("terminal scope terminal.effectiveRoute.cost.amountUsd must be a finite non-negative amount");
    }
    assertCanonicalCccNativeCliText(cost.source, "terminal scope terminal.effectiveRoute.cost.source");
    return;
  }
  if (cost.kind !== "unknown") {
    throw refused("terminal scope terminal.effectiveRoute.cost.kind must be unknown when no amount is claimed");
  }
  assertCanonicalCccNativeCliText(cost.reason, "terminal scope terminal.effectiveRoute.cost.reason");
}

function sameCanonicalAuthorityBinding(
  left: CccCampaignAuthorityBinding,
  right: CccCampaignAuthorityBinding,
): boolean {
  return left.projectId === right.projectId
    && left.importId === right.importId
    && left.campaignId === right.campaignId
    && left.taskId === right.taskId
    && left.actionId === right.actionId
    && left.actionTarget === right.actionTarget
    && left.idempotencyKey === right.idempotencyKey
    && left.packetHash === right.packetHash
    && left.sidecarHash === right.sidecarHash
    && left.bundleHash === right.bundleHash
    && left.targetRepository === right.targetRepository
    && left.targetBase === right.targetBase
    && left.providerId === right.providerId
    && left.modelId === right.modelId
    && left.transport === right.transport
    && left.manifestHash === right.manifestHash
    && left.bindingHash === right.bindingHash;
}

function getPolicyRouteText(value: unknown, key: "providerId" | "modelId"): string {
  const route = value as Record<string, unknown>;
  return assertCanonicalCccNativeCliText(route[key], `session policy route.${key}`);
}

function isHeldClosureTrigger(value: unknown): value is CccNativeCliHeldClosureTrigger {
  return value === "done" || value === "exit" || value === "cancel" || value === "lifetime";
}

function requirePlainFrozenExactObject(
  value: unknown,
  keys: readonly string[],
  label: string,
): object {
  if (!isPlainObject(value)) throw refused(`${label} must be a plain object`);
  if (!Object.isFrozen(value)) throw refused(`${label} must be frozen`);
  const actualKeys = Object.keys(value);
  if (actualKeys.length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    throw refused(`${label} must have exact keys: ${keys.join(", ")}`);
  }
  return value;
}

function requirePositiveSafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw refused(`${label} must be a positive safe integer`);
  }
  return value;
}

function requireNonNegativeSafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw refused(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object"
    && value !== null
    && Object.getPrototypeOf(value) === Object.prototype;
}

function refused(message: string): CccNativeCliBindingRefusedError {
  return new CccNativeCliBindingRefusedError(`CCC native CLI binding refused: ${message}`);
}
