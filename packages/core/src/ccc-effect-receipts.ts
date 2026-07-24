import { createHash } from "node:crypto";
import type { CliAutonomyPosture, CliSession } from "./cli-session-types.js";

/** Versioned durable protocol, not a caller-supplied effect label. */
export const CCC_EFFECT_RECEIPT_CONTRACT = "ccc-tool-receipts/v1";

export interface CccEffectReceiptStore {
  getSession(id: string): CliSession | undefined;
  updateSession(id: string, updates: { autonomyPosture?: CliAutonomyPosture }): CliSession | undefined;
  flush(): Promise<void>;
}

export interface CccEffectReceiptInput {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  arguments: unknown;
}

export class CccEffectReceiptSessionMissingError extends Error {
  readonly code = "CCC_EFFECT_RECEIPT_SESSION_MISSING";

  constructor(public readonly sessionId: string) {
    super(`CCC effect receipt session is missing: ${sessionId}`);
    this.name = "CccEffectReceiptSessionMissingError";
  }
}

/** An effect may have crossed its external boundary; replay requires reconciliation, never a guess. */
export class CccEffectReceiptPendingError extends Error {
  readonly code = "CCC_EFFECT_RECEIPT_RECONCILIATION_REQUIRED";

  constructor(public readonly identity: string) {
    super(`CCC effect receipt is pending reconciliation: ${identity}`);
    this.name = "CccEffectReceiptPendingError";
  }
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(String(value));
}

/** Stable identity from the real provider tool-call envelope and arguments. */
export function cccEffectReceiptIdentity(input: CccEffectReceiptInput): string {
  return createHash("sha256")
    .update(CCC_EFFECT_RECEIPT_CONTRACT)
    .update("\0")
    .update(input.sessionId)
    .update("\0")
    .update(input.toolCallId)
    .update("\0")
    .update(input.toolName)
    .update("\0")
    .update(canonicalJson(input.arguments))
    .digest("hex");
}

function receipts(posture: CliAutonomyPosture | null | undefined): string[] {
  return Array.isArray(posture?.cccEffectReceipts)
    ? posture.cccEffectReceipts.filter((receipt): receipt is string => typeof receipt === "string")
    : [];
}

function pendingReceipts(posture: CliAutonomyPosture | null | undefined): string[] {
  return Array.isArray(posture?.cccEffectReceiptPending)
    ? posture.cccEffectReceiptPending.filter((receipt): receipt is string => typeof receipt === "string")
    : [];
}

function updateReceiptPosture(
  store: CccEffectReceiptStore,
  sessionId: string,
  update: (current: CliAutonomyPosture | null | undefined) => CliAutonomyPosture,
): CliSession {
  const session = store.getSession(sessionId);
  if (!session) throw new CccEffectReceiptSessionMissingError(sessionId);
  const updated = store.updateSession(sessionId, { autonomyPosture: update(session.autonomyPosture) });
  if (!updated) throw new CccEffectReceiptSessionMissingError(sessionId);
  return updated;
}

/*
FNXC:CCCEffectReceipts 2026-07-23-20:38:
An external custom-tool effect can succeed immediately before its post-effect
receipt write crashes. Persist a pending claim first; a restarted controller
must require reconciliation instead of guessing that it may repeat the effect.
Only a proved tool rejection clears this claim for an honest retry.
*/
/** Durable pre-effect claim. A reopen seeing this state must not replay blindly. */
export async function reserveCccEffectReceipt(
  store: CccEffectReceiptStore,
  input: CccEffectReceiptInput,
): Promise<{ identity: string; alreadyCommitted: boolean; pending: boolean }> {
  const identity = cccEffectReceiptIdentity(input);
  const session = store.getSession(input.sessionId);
  if (!session) throw new CccEffectReceiptSessionMissingError(input.sessionId);
  if (receipts(session.autonomyPosture).includes(identity)) {
    return { identity, alreadyCommitted: true, pending: false };
  }
  if (pendingReceipts(session.autonomyPosture).includes(identity)) {
    return { identity, alreadyCommitted: false, pending: true };
  }
  updateReceiptPosture(store, input.sessionId, (posture) => ({
    ...(posture ?? {}),
    cccEffectReceiptContract: CCC_EFFECT_RECEIPT_CONTRACT,
    cccEffectReceiptPending: [...pendingReceipts(posture), identity],
  }));
  await store.flush();
  return { identity, alreadyCommitted: false, pending: false };
}

/** Clear a proved pre-effect failure so a genuine retry may execute. */
export async function abandonCccEffectReceipt(
  store: CccEffectReceiptStore,
  input: CccEffectReceiptInput,
): Promise<void> {
  const identity = cccEffectReceiptIdentity(input);
  const session = store.getSession(input.sessionId);
  if (!session) throw new CccEffectReceiptSessionMissingError(input.sessionId);
  if (!pendingReceipts(session.autonomyPosture).includes(identity)) return;
  updateReceiptPosture(store, input.sessionId, (posture) => ({
    ...(posture ?? {}),
    cccEffectReceiptPending: pendingReceipts(posture).filter((entry) => entry !== identity),
  }));
  await store.flush();
}

/** Read before execution, then write and flush before returning an effect ack. */
export async function commitCccEffectReceipt(
  store: CccEffectReceiptStore,
  input: CccEffectReceiptInput,
): Promise<{ identity: string; alreadyCommitted: boolean }> {
  const identity = cccEffectReceiptIdentity(input);
  const session = store.getSession(input.sessionId);
  if (!session) throw new CccEffectReceiptSessionMissingError(input.sessionId);
  if (receipts(session.autonomyPosture).includes(identity)) {
    return { identity, alreadyCommitted: true };
  }
  updateReceiptPosture(store, input.sessionId, (posture) => ({
    ...(posture ?? {}),
    cccEffectReceiptContract: CCC_EFFECT_RECEIPT_CONTRACT,
    cccEffectReceipts: [...receipts(posture), identity],
    cccEffectReceiptPending: pendingReceipts(posture).filter((entry) => entry !== identity),
  }));
  await store.flush();
  return { identity, alreadyCommitted: false };
}

export function hasCccEffectReceipt(
  store: Pick<CccEffectReceiptStore, "getSession">,
  input: CccEffectReceiptInput,
): boolean {
  const session = store.getSession(input.sessionId);
  return Boolean(session && receipts(session.autonomyPosture).includes(cccEffectReceiptIdentity(input)));
}
