import { createHash } from "node:crypto";
import type { CccCampaignAuthorityBinding } from "./ccc-campaign/types.js";
import type { ApprovalRequestActorSnapshot } from "./types.js";

/** Versioned, PostgreSQL-authoritative CCC effect protocol. */
export const CCC_EFFECT_RECEIPT_CONTRACT = "ccc-tool-receipts/v2";

export type CccEffectReceiptState = "reserved" | "dispatched_unknown" | "committed" | "proved_failed";

/** Caller-supplied semantic locator only; provenance is always re-derived. */
export interface CccCampaignEffectClaim {
  actionId: string;
  actionTarget: string;
  approvalRequestId: string;
  claimToken: string;
}

/** Complete persisted authority reconstructed from the campaign-owned binding. */
export interface CccCampaignEffectAuthority {
  binding: CccCampaignAuthorityBinding;
}

export interface CccEffectReceiptInput {
  /** Stable CliSession.id reused through the exact CCC resume/retry chain. */
  sessionId: string;
  /** Provider request/call identity is fencing evidence only. */
  toolCallId?: string;
  nativeRequestId?: string;
  retryNumber?: number;
  /** Must identify the controller generation that owns this dispatch. */
  controllerToken?: string;
  /** Fusion-owned durable prompt/turn identity. Never supplied by a provider. */
  turnKey?: string;
  /** Fusion-owned deterministic zero-based effect position within turnKey. */
  slotOrdinal?: number;
  toolName: string;
  /** Untrusted tool arguments containing the required __fusion_effect envelope. */
  arguments: unknown;
  /** Campaign action/approval locator. Never include a provenance tuple here. */
  campaign?: CccCampaignEffectClaim;
}

export interface CccPreparedEffectReceipt {
  effectScopeId: string;
  logicalKey: string;
  repeatOf: string | null;
  toolAuthority: string;
  argumentsDigest: string;
  controllerToken: string;
  turnKey: string;
  slotOrdinal: number;
  /** Safe arguments forwarded downstream after stripping Fusion-only envelope. */
  forwardedArguments: unknown;
  campaignClaim?: CccCampaignEffectClaim;
}

export interface CccEffectReceiptRecord extends CccPreparedEffectReceipt {
  state: CccEffectReceiptState;
  /** Bounded structured result returned when a committed effect is replayed. */
  result: unknown;
  /** Present only when the full binding was durably written. */
  campaign?: CccCampaignEffectAuthority;
}

/**
 * Local, deterministic observer result for a post-dispatch receipt. This is
 * deliberately not a provider response: the observer supplies its own stable
 * identity and digest and the native receipt binds both to the campaign claim.
 */
export type CccEffectReceiptObservation =
  | { kind: "no_effect" }
  | { kind: "committed"; result: unknown };

export interface CccEffectReceiptReconciliationInput extends CccEffectReceiptInput {
  /** Durable controller generation recorded on the persisted CLI session. */
  controllerGeneration: string;
  /** Named local observer, not caller-asserted campaign provenance. */
  observerId: string;
  /** Exact SHA-256 digest of the observer's bounded evidence. */
  observationDigest: string;
  observation: CccEffectReceiptObservation;
  actor: ApprovalRequestActorSnapshot;
  runId: string;
}

export interface CccPreparedEffectReceiptReconciliation {
  receipt: CccPreparedEffectReceipt;
  controllerGeneration: string;
  observerId: string;
  observationDigest: string;
  observation: CccEffectReceiptObservation;
  actor: ApprovalRequestActorSnapshot;
  runId: string;
}

export interface CccEffectTurn {
  effectScopeId: string;
  turnKey: string;
  controllerToken: string;
  state: "open" | "closed";
}

export interface CccEffectReceiptStore {
  openCccEffectTurn(effectScopeId: string, controllerToken: string): Promise<CccEffectTurn>;
  closeCccEffectTurn(effectScopeId: string, turnKey: string, controllerToken: string): Promise<void>;
  reserveCccEffectReceipt(input: CccPreparedEffectReceipt): Promise<CccEffectReceiptRecord>;
  markCccEffectReceiptDispatched(input: CccPreparedEffectReceipt): Promise<CccEffectReceiptRecord>;
  commitCccEffectReceipt(input: CccPreparedEffectReceipt, result?: unknown): Promise<CccEffectReceiptRecord>;
  proveCccEffectReceiptFailed(input: CccPreparedEffectReceipt): Promise<CccEffectReceiptRecord>;
  reconcileCccEffectReceipt(input: CccPreparedEffectReceiptReconciliation): Promise<CccEffectReceiptRecord>;
  getCccEffectReceipt(effectScopeId: string, logicalKey: string): Promise<CccEffectReceiptRecord | undefined>;
}

export class CccEffectReceiptProtocolError extends Error {
  constructor(
    public readonly code:
      | "CCC_EFFECT_IDENTITY_INVALID"
      | "CCC_EFFECT_KEY_COLLISION"
      | "CCC_EFFECT_AMBIGUOUS_DUPLICATE"
      | "CCC_EFFECT_RECONCILIATION_REQUIRED"
      | "CCC_EFFECT_LEGACY_RECONCILIATION_REQUIRED",
    message: string,
  ) {
    super(message);
    this.name = "CccEffectReceiptProtocolError";
  }
}

/** Retained export for callers that distinguish a missing durable effect scope. */
export class CccEffectReceiptSessionMissingError extends CccEffectReceiptProtocolError {
  constructor(public readonly sessionId: string) {
    super("CCC_EFFECT_RECONCILIATION_REQUIRED", `CCC effect scope is missing: ${sessionId}`);
    this.name = "CccEffectReceiptSessionMissingError";
  }
}

export class CccEffectReceiptPendingError extends CccEffectReceiptProtocolError {
  constructor(public readonly identity: string) {
    super("CCC_EFFECT_RECONCILIATION_REQUIRED", `CCC effect receipt requires reconciliation: ${identity}`);
    this.name = "CccEffectReceiptPendingError";
  }
}

function canonicalJson(value: unknown, seen = new Set<object>()): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new CccEffectReceiptProtocolError("CCC_EFFECT_IDENTITY_INVALID", "CCC effect arguments must be finite JSON numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new CccEffectReceiptProtocolError("CCC_EFFECT_IDENTITY_INVALID", "CCC effect arguments must not contain cycles");
    seen.add(value);
    const result = `[${value.map((entry) => canonicalJson(entry, seen)).join(",")}]`;
    seen.delete(value);
    return result;
  }
  if (typeof value === "object") {
    if (seen.has(value as object)) throw new CccEffectReceiptProtocolError("CCC_EFFECT_IDENTITY_INVALID", "CCC effect arguments must not contain cycles");
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new CccEffectReceiptProtocolError("CCC_EFFECT_IDENTITY_INVALID", "CCC effect arguments must be plain JSON objects");
    }
    seen.add(value as object);
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry, seen)}`);
    seen.delete(value as object);
    return `{${entries.join(",")}}`;
  }
  throw new CccEffectReceiptProtocolError("CCC_EFFECT_IDENTITY_INVALID", "CCC effect arguments must be JSON values");
}

/** Strict JSON validation shared by receipt arguments and replayable results. */
export function canonicalCccEffectJson(value: unknown): string {
  return canonicalJson(value);
}

function envelope(argumentsValue: unknown): { key: string; repeatOf: string | null; forwardedArguments: unknown } {
  if (!argumentsValue || typeof argumentsValue !== "object" || Array.isArray(argumentsValue)) {
    throw new CccEffectReceiptProtocolError("CCC_EFFECT_IDENTITY_INVALID", "CCC effect requires an object argument envelope");
  }
  const raw = argumentsValue as Record<string, unknown>;
  const marker = raw.__fusion_effect;
  if (!marker || typeof marker !== "object" || Array.isArray(marker)) {
    throw new CccEffectReceiptProtocolError("CCC_EFFECT_IDENTITY_INVALID", "CCC effect requires __fusion_effect identity");
  }
  const key = (marker as Record<string, unknown>).key;
  const repeatOf = (marker as Record<string, unknown>).repeatOf;
  if (typeof key !== "string" || key.length === 0 || key.length > 256) {
    throw new CccEffectReceiptProtocolError("CCC_EFFECT_IDENTITY_INVALID", "CCC effect key must be a bounded string");
  }
  if (repeatOf !== undefined && (typeof repeatOf !== "string" || repeatOf.length === 0 || repeatOf.length > 256)) {
    throw new CccEffectReceiptProtocolError("CCC_EFFECT_IDENTITY_INVALID", "CCC effect repeatOf must be a bounded string when supplied");
  }
  const { __fusion_effect: _marker, ...forwardedArguments } = raw;
  return { key, repeatOf: typeof repeatOf === "string" ? repeatOf : null, forwardedArguments };
}

function campaignClaim(value: CccEffectReceiptInput["campaign"]): CccCampaignEffectClaim | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CccEffectReceiptProtocolError(
      "CCC_EFFECT_IDENTITY_INVALID",
      "CCC campaign effect claim must be an object",
    );
  }
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = ["actionId", "actionTarget", "approvalRequestId", "claimToken"];
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    throw new CccEffectReceiptProtocolError(
      "CCC_EFFECT_IDENTITY_INVALID",
      "CCC campaign effect claim must contain only action and approval identity",
    );
  }
  const entries: Array<[keyof CccCampaignEffectClaim, unknown]> = [
    ["actionId", value.actionId],
    ["actionTarget", value.actionTarget],
    ["approvalRequestId", value.approvalRequestId],
    ["claimToken", value.claimToken],
  ];
  for (const [key, entry] of entries) {
    if (typeof entry !== "string" || entry.length === 0 || entry.length > 512 || entry.trim() !== entry) {
      throw new CccEffectReceiptProtocolError(
        "CCC_EFFECT_IDENTITY_INVALID",
        `CCC campaign effect ${key} must be a bounded string`,
      );
    }
  }
  return {
    actionId: value.actionId,
    actionTarget: value.actionTarget,
    approvalRequestId: value.approvalRequestId,
    claimToken: value.claimToken,
  };
}

function canonicalBoundedText(value: unknown, label: string, maxLength = 256): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || value.trim() !== value) {
    throw new CccEffectReceiptProtocolError("CCC_EFFECT_IDENTITY_INVALID", `CCC effect ${label} must be a bounded string`);
  }
  return value;
}

/** Validate the local observer contract before taking any database lock. */
export function prepareCccEffectReceiptReconciliation(
  input: CccEffectReceiptReconciliationInput,
): CccPreparedEffectReceiptReconciliation {
  const receipt = prepareCccEffectReceipt(input);
  if (!receipt.campaignClaim) {
    throw new CccEffectReceiptProtocolError(
      "CCC_EFFECT_RECONCILIATION_REQUIRED",
      `CCC effect reconciliation requires a campaign claim: ${receipt.logicalKey}`,
    );
  }
  const controllerGeneration = canonicalBoundedText(input.controllerGeneration, "controller generation");
  const observerId = canonicalBoundedText(input.observerId, "observer ID");
  if (typeof input.observationDigest !== "string" || !/^[a-f0-9]{64}$/.test(input.observationDigest)) {
    throw new CccEffectReceiptProtocolError("CCC_EFFECT_IDENTITY_INVALID", "CCC effect observation digest must be a lowercase SHA-256 digest");
  }
  if (!input.observation || typeof input.observation !== "object" || Array.isArray(input.observation)) {
    throw new CccEffectReceiptProtocolError("CCC_EFFECT_IDENTITY_INVALID", "CCC effect observation must be an object");
  }
  const observation = input.observation;
  if (observation.kind === "no_effect") {
    if (Object.keys(observation).length !== 1) {
      throw new CccEffectReceiptProtocolError("CCC_EFFECT_IDENTITY_INVALID", "CCC no-effect observation must not carry a result");
    }
  } else if (observation.kind === "committed") {
    if (Object.keys(observation).length !== 2 || !("result" in observation)) {
      throw new CccEffectReceiptProtocolError("CCC_EFFECT_IDENTITY_INVALID", "CCC committed observation requires one result");
    }
    const resultJson = canonicalCccEffectJson(observation.result);
    if (Buffer.byteLength(resultJson, "utf8") > 65_536) {
      throw new CccEffectReceiptProtocolError("CCC_EFFECT_RECONCILIATION_REQUIRED", "CCC effect result exceeds the durable replay bound");
    }
  } else {
    throw new CccEffectReceiptProtocolError("CCC_EFFECT_IDENTITY_INVALID", "CCC effect observation kind is invalid");
  }
  return {
    receipt,
    controllerGeneration,
    observerId,
    observationDigest: input.observationDigest,
    observation,
    actor: input.actor,
    runId: canonicalBoundedText(input.runId, "run ID", 512),
  };
}

/** Validate the reserved envelope and produce immutable authority/digest assertions. */
export function prepareCccEffectReceipt(input: CccEffectReceiptInput): CccPreparedEffectReceipt {
  if (!input.sessionId || !input.toolName || !input.controllerToken) {
    throw new CccEffectReceiptProtocolError("CCC_EFFECT_IDENTITY_INVALID", "CCC effect scope, authority, and controller token are required");
  }
  const fusionOwnedTurn = input.turnKey !== undefined || input.slotOrdinal !== undefined;
  const claim = campaignClaim(input.campaign);
  if (fusionOwnedTurn) {
    if (typeof input.turnKey !== "string" || input.turnKey.length === 0 || input.turnKey.length > 256
      || !Number.isInteger(input.slotOrdinal) || input.slotOrdinal! < 0) {
      throw new CccEffectReceiptProtocolError("CCC_EFFECT_IDENTITY_INVALID", "CCC effect requires a Fusion-owned turn key and slot ordinal");
    }
    const canonicalArguments = canonicalJson(input.arguments);
    return {
      effectScopeId: input.sessionId,
      logicalKey: `${input.turnKey}:${input.slotOrdinal}`,
      repeatOf: null,
      toolAuthority: input.toolName,
      argumentsDigest: createHash("sha256").update(canonicalArguments).digest("hex"),
      controllerToken: input.controllerToken,
      turnKey: input.turnKey,
      slotOrdinal: input.slotOrdinal!,
      forwardedArguments: input.arguments,
      ...(claim ? { campaignClaim: claim } : {}),
    };
  }
  // Compatibility only for already-written v2 callers. Production boundaries
  // must use Fusion-owned turn/slot identity above, never model arguments.
  const extracted = envelope(input.arguments);
  const canonicalArguments = canonicalJson(extracted.forwardedArguments);
  return {
    effectScopeId: input.sessionId,
    logicalKey: extracted.key,
    repeatOf: extracted.repeatOf,
    toolAuthority: input.toolName,
    argumentsDigest: createHash("sha256").update(canonicalArguments).digest("hex"),
    controllerToken: input.controllerToken,
    turnKey: `legacy:${extracted.key}`,
    slotOrdinal: 0,
    forwardedArguments: extracted.forwardedArguments,
    ...(claim ? { campaignClaim: claim } : {}),
  };
}

/** Logical v2 identity intentionally excludes provider call/request IDs. */
export function cccEffectReceiptIdentity(input: CccEffectReceiptInput): string {
  const prepared = prepareCccEffectReceipt(input);
  return createHash("sha256")
    .update(CCC_EFFECT_RECEIPT_CONTRACT)
    .update("\0")
    .update(prepared.effectScopeId)
    .update("\0")
    .update(prepared.logicalKey)
    .update("\0")
    .update(prepared.toolAuthority)
    .update("\0")
    .update(prepared.argumentsDigest)
    .update("\0")
    .update(prepared.repeatOf ?? "")
    .digest("hex");
}

export async function reserveCccEffectReceipt(store: CccEffectReceiptStore, input: CccEffectReceiptInput): Promise<CccEffectReceiptRecord> {
  return store.reserveCccEffectReceipt(prepareCccEffectReceipt(input));
}

export async function markCccEffectReceiptDispatched(store: CccEffectReceiptStore, input: CccEffectReceiptInput): Promise<CccEffectReceiptRecord> {
  return store.markCccEffectReceiptDispatched(prepareCccEffectReceipt(input));
}

export async function commitCccEffectReceipt(store: CccEffectReceiptStore, input: CccEffectReceiptInput, result?: unknown): Promise<CccEffectReceiptRecord> {
  return store.commitCccEffectReceipt(prepareCccEffectReceipt(input), result);
}

/** Resolve a campaign dispatched receipt from local observer evidence only. */
export async function reconcileCccEffectReceipt(
  store: CccEffectReceiptStore,
  input: CccEffectReceiptReconciliationInput,
): Promise<CccEffectReceiptRecord> {
  return store.reconcileCccEffectReceipt(prepareCccEffectReceiptReconciliation(input));
}

/** Only a proved pre-dispatch failure is allowed to clear a reservation. */
export async function abandonCccEffectReceipt(store: CccEffectReceiptStore, input: CccEffectReceiptInput): Promise<CccEffectReceiptRecord> {
  return store.proveCccEffectReceiptFailed(prepareCccEffectReceipt(input));
}

export async function hasCccEffectReceipt(store: CccEffectReceiptStore, input: CccEffectReceiptInput): Promise<boolean> {
  const prepared = prepareCccEffectReceipt(input);
  const receipt = await store.getCccEffectReceipt(prepared.effectScopeId, prepared.logicalKey);
  return receipt?.state === "committed";
}
