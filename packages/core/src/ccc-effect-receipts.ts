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
  const updated = store.updateSession(input.sessionId, {
    autonomyPosture: {
      ...(session.autonomyPosture ?? {}),
      cccEffectReceiptContract: CCC_EFFECT_RECEIPT_CONTRACT,
      cccEffectReceipts: [...receipts(session.autonomyPosture), identity],
    },
  });
  if (!updated) throw new CccEffectReceiptSessionMissingError(input.sessionId);
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
