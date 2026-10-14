import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { CccCampaignExecutionAuthorization } from "../ccc-campaign/execution-authorization.js";
import { canonicalCccPrdJson } from "../ccc-prd/contract.js";
import type { CccPlanningBudgetPolicy } from "./budget-fit.js";
import { CccPlanningRefusal } from "./errors.js";
import { cccPlanningImportKey, classifyCccModelIdentity } from "./policy.js";

/*
FNXC:CccPlanningAuthority 2026-10-14-13:52:
The live-authority receipt is the operator's exact grant for one request-to-code run (D23, ADR D Q3, CONTRACT-v3 section 2.18). It names the target, the three exact model pins, the loopback route, the budget, the deadline, the expiry and the one protected action it lets code release, and it is consumed once at G0. The receipt file must be the canonical JSON of the receipt (one trailing newline tolerated), so a duplicate key, a reordered field or a formatting change can never make the bytes say something other than what the confirmation digest covers. Ryan types the digest; this module only checks that the typed value, the stored `operatorConfirmation` and the recomputed digest are the same string. That is procedural, not enforced: any local process can compute the digest (D52).

Parse order follows G0 (section 2.18): confirmation present, canonical bytes, exact keys and field shapes (a model id other than the slot's exact pin is REJECTED_MODEL_IDENTITY; a target class that needs qualification is QUALIFICATION_REQUIRED; declared remotes are TARGET_NOT_DISPOSABLE), confirmation equality, validity window against `now`, then the budget recomputed from the policy. Loopback (`validateCccLoopbackHttpUrl`, G0 step 8), the installed runtime digest (step 7), the source policy digest (step 12), Large authorization (step 6) and target ownership (step 10) are checked by G0 in the engine, which owns those inputs; core cannot import the engine's loopback policy and does not copy it.
*/

export const CCC_PLANNING_LIVE_AUTHORITY_RECEIPT_SCHEMA = "ccc-planning.live-authority-receipt.v1" as const;
export type CccPlanningLiveExecutionRelease = "operator_confirm_after_import" | "controller_within_receipt";

export type CccPlanningLiveAuthorityReceiptV1 = Readonly<{
  schema: typeof CCC_PLANNING_LIVE_AUTHORITY_RECEIPT_SCHEMA;
  receiptId: string;                               // /^[a-z0-9][a-z0-9-]{7,63}$/
  issuedAt: string; notBefore: string; expiresAt: string;   // canonical UTC ISO-8601; expiresAt ≤ issuedAt + 7 days and ≥ deadlineAt
  operator: Readonly<{ actorId: string; actorName: string }>;
  project: Readonly<{ projectId: string }>;          // the project created for this target before issuance
  target: Readonly<{
    class: "owned_disposable";                     // the only value accepted before qualification
    scratchRoot: string;                           // realpath; the repository is a direct child
    repositoryRealpath: string;
    baseCommit: string; baseTree: string;          // 40- or 64-hex object ids
    ownershipMarker: Readonly<{ path: string; sha256: string }>;  // <scratchRoot>/owner.json, outside the repository
    remotes: readonly [];                          // literally empty
    admittedFusionPaths: readonly string[];        // e.g. ["proof/**", "Taskfile.yml"]: verifier-baseline paths outside the request's scope
  }>;
  request: Readonly<{ sha256: string; byteLength: number }>;
  mode: "spec" | "build";
  profile: "full-v2";
  budgetProfile: "standard" | "large";
  budgetPolicyVersion: string;                     // the versioned policy whose allocations G0 recomputes
  largeAuthorized: boolean;
  phaseCallCaps: Readonly<{ planning: number; implementation: number; reviewProof: number }>; // must equal the policy allocation
  deadlineAt: string;
  models: Readonly<{ glm53: "glm/glm-5.3"; glm53Flash: "glm/glm-5.3-flash"; minimaxM3: "minimax/MiniMax-M3" }>;
  omniRoute: Readonly<{
    baseUrl: string;                               // must pass validateCccLoopbackHttpUrl (engine, G0 step 8)
    receiptAdapterId: "terminal-route-sse-comments.v1";
    providerIds: Readonly<{ glm53: string; glm53Flash: string; minimaxM3: string }>;
  }>;
  quota: Readonly<{ accounting: "subscription_unknown"; meteredFallback: "forbidden" }>;
  escalation: "forbidden";                         // I2 uses no higher ladder
  permittedProtectedActions: readonly Readonly<{ kind: "live_execution"; release: CccPlanningLiveExecutionRelease }>[]; // at most one entry
  sourceToolPolicy: Readonly<{ policyId: string; sha256: string }>;
  runtime: Readonly<{ installedRuntimeReceiptSha256: string; packageVersion: string; distManifestSha256: string }>;
  operatorConfirmation: string;                    // SHA-256 of the canonical receipt without this field
}>;

/*
FNXC:CccPlanningAuthority 2026-10-14-14:02:
ADR D's union plus `CCC_PLANNING_AUTHORITY_CONFIRMATION_REQUIRED`, which the contract's G0 step 2 and card K2 require from the parse for a missing `--confirm-authority` but ADR D's list omits (reported as a contract gap). Every member is a K1 `CccPlanningRefusalCode`.
*/
export type CccPlanningAuthorityRefusalCode =
  | "CCC_PLANNING_AUTHORITY_RECEIPT_REQUIRED" | "CCC_PLANNING_AUTHORITY_RECEIPT_INVALID"
  | "CCC_PLANNING_AUTHORITY_RECEIPT_UNCONFIRMED" | "CCC_PLANNING_AUTHORITY_RECEIPT_EXPIRED"
  | "CCC_PLANNING_AUTHORITY_RECEIPT_CONSUMED" | "CCC_PLANNING_REJECTED_MODEL_IDENTITY"
  | "CCC_PLANNING_ENDPOINT_NOT_LOOPBACK" | "CCC_PLANNING_BUDGET_POLICY_MISMATCH"
  | "CCC_PLANNING_RUNTIME_NOT_PERMITTED" | "CCC_PLANNING_TARGET_NOT_DISPOSABLE"
  | "CCC_PLANNING_QUALIFICATION_REQUIRED" | "CCC_PLANNING_AUTHORITY_CONFIRMATION_REQUIRED";

// ---------------------------------------------------------------- shared helpers

const INVALID = "CCC_PLANNING_AUTHORITY_RECEIPT_INVALID" as const;
const SHA256_HEX = /^[a-f0-9]{64}$/u;
const GIT_OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const RECEIPT_ID = /^[a-z0-9][a-z0-9-]{7,63}$/u;
/** The campaign route identifier grammar (ccc-campaign/canonical.ts), so a receipt provider id is a valid route provider id. */
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?Z$/u;
const SEVEN_DAYS_MICROS = 7 * 24 * 60 * 60 * 1_000_000;
const REQUEST_MAX_BYTES = 4 * 1024 * 1024;   // G0 step 4: at most 4 MiB
const TEXT_MAX = 256;                          // CCC_PLANNING_AUDIT_STRING_MAX
const LIVE_EXECUTION_RELEASES: readonly string[] = ["operator_confirm_after_import", "controller_within_receipt"];

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function join(parent: string, key: string): string {
  return parent === "" ? key : `${parent}.${key}`;
}

/**
 * Canonical UTC ISO-8601 (`YYYY-MM-DDTHH:MM:SS[.f{1,6}]Z`, the anchor's deadline CHECK grammar) as integer
 * microseconds since the epoch, or null. A calendar-impossible date (`2026-02-30`) is null, although
 * `Date.parse` would roll it over.
 */
function timestampMicros(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = TIMESTAMP.exec(value);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  if (year < 1970 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return null;
  const millis = Date.UTC(year, month - 1, day, hour, minute, second);
  const date = new Date(millis);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  const fraction = (match[7] ?? "").padEnd(6, "0");
  return millis * 1000 + Number(fraction);
}

/** An absolute, normalized POSIX path that is not the root. */
function isAbsoluteNormalPath(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("/") && value !== "/" && !value.endsWith("/")
    && !value.includes("\0") && posix.normalize(value) === value;
}

/** Relative and normalized: no leading slash, no empty, "." or ".." segment, no backslash or NUL. */
function isRelativeNormalPath(value: unknown): value is string {
  if (typeof value !== "string" || value === "" || value.startsWith("/") || value.includes("\\") || hasControlCharacter(value)) return false;
  return value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/**
 * An admitted Fusion path is an exact relative path or `<dir>/**`, nothing else: no other wildcard, no `.git`
 * segment. The grammar is closed so the envelope check can match it exactly, case-sensitively.
 */
function isAdmittedFusionPathPattern(value: unknown): value is string {
  if (typeof value !== "string" || value.length > TEXT_MAX) return false;
  const base = value.endsWith("/**") ? value.slice(0, -3) : value;
  if (!isRelativeNormalPath(base) || /[*?[\]{}]/u.test(base)) return false;
  return !base.split("/").includes(".git");
}

function matchesAdmittedFusionPath(path: string, pattern: string): boolean {
  if (!pattern.endsWith("/**")) return path === pattern;
  const prefix = pattern.slice(0, -2);   // keeps the trailing slash: "proof/"
  return path.startsWith(prefix) && path.length > prefix.length;
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function isBoundedText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= TEXT_MAX && !hasControlCharacter(value);
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const entry of Object.values(value)) deepFreeze(entry);
  }
  return value;
}

// ---------------------------------------------------------------- the receipt's named fields

/** `true` is a leaf; a nested object lists its own named fields; `[shape]` is an array of that shape. */
type ReceiptShape = true | readonly [ReceiptShape] | Readonly<{ [key: string]: ReceiptShape }>;

const RECEIPT_BODY_SHAPE = {
  schema: true, receiptId: true, issuedAt: true, notBefore: true, expiresAt: true,
  operator: { actorId: true, actorName: true },
  project: { projectId: true },
  target: {
    class: true, scratchRoot: true, repositoryRealpath: true, baseCommit: true, baseTree: true,
    ownershipMarker: { path: true, sha256: true }, remotes: true, admittedFusionPaths: true,
  },
  request: { sha256: true, byteLength: true },
  mode: true, profile: true, budgetProfile: true, budgetPolicyVersion: true, largeAuthorized: true,
  phaseCallCaps: { planning: true, implementation: true, reviewProof: true },
  deadlineAt: true,
  models: { glm53: true, glm53Flash: true, minimaxM3: true },
  omniRoute: { baseUrl: true, receiptAdapterId: true, providerIds: { glm53: true, glm53Flash: true, minimaxM3: true } },
  quota: { accounting: true, meteredFallback: true },
  escalation: true,
  permittedProtectedActions: [{ kind: true, release: true }],
  sourceToolPolicy: { policyId: true, sha256: true },
  runtime: { installedRuntimeReceiptSha256: true, packageVersion: true, distManifestSha256: true },
} as const satisfies Readonly<{ [key: string]: ReceiptShape }>;
const RECEIPT_SHAPE = { ...RECEIPT_BODY_SHAPE, operatorConfirmation: true } as const;

/** Picks exactly the named fields at every level; throws on a missing field or a wrong container. */
function projectNamed(value: unknown, shape: ReceiptShape, field: string): unknown {
  if (shape === true) return value;
  if (Array.isArray(shape)) {
    if (!Array.isArray(value)) throw new TypeError(`${field || "$"} must be an array`);
    return value.map((entry, index) => projectNamed(entry, (shape as readonly [ReceiptShape])[0], `${field}[${index}]`));
  }
  if (!isPlainObject(value)) throw new TypeError(`${field || "$"} must be an object`);
  const picked: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(shape as Readonly<Record<string, ReceiptShape>>)) {
    if (!hasOwn(value, key)) throw new TypeError(`${join(field, key)} is missing`);
    picked[key] = projectNamed(value[key], inner, join(field, key));
  }
  return picked;
}

/*
FNXC:CccPlanningAuthority 2026-10-14-13:52:
The confirmation digest hashes exactly the receipt's named fields minus `operatorConfirmation` (errata E1-11): a caller that passes the full receipt, or a wider object, gets the digest of the named fields alone. For a receipt with exact keys that is sha256(canonicalCccPrdJson(receipt without operatorConfirmation)), the frozen rule (section 2.1). There is no domain tag because the receipt's own `schema` field separates it.
*/
export function computeCccPlanningAuthorityReceiptDigest(
  receipt: Omit<CccPlanningLiveAuthorityReceiptV1, "operatorConfirmation">,
): string {
  try {
    return sha256Hex(canonicalCccPrdJson(projectNamed(receipt, RECEIPT_BODY_SHAPE, "")));
  } catch (error) {
    throw new CccPlanningRefusal(INVALID, `receipt cannot be digested: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ---------------------------------------------------------------- parse

class ReceiptRefused {
  public constructor(
    public readonly code: CccPlanningAuthorityRefusalCode,
    public readonly field: string,
    public readonly detail: string,
  ) {}
}

function refuse(code: CccPlanningAuthorityRefusalCode, field: string, detail: string): never {
  throw new ReceiptRefused(code, field, detail);
}

/** Exact keys at every level: an unnamed key first (in canonical key order), then a missing one. */
function requireExactKeys(value: unknown, shape: ReceiptShape, field: string): void {
  if (shape === true) return;
  if (Array.isArray(shape)) {
    if (!Array.isArray(value)) refuse(INVALID, field, "must be an array");
    value.forEach((entry, index) => requireExactKeys(entry, (shape as readonly [ReceiptShape])[0], `${field}[${index}]`));
    return;
  }
  if (!isPlainObject(value)) refuse(INVALID, field || "$", "must be an object");
  const named = shape as Readonly<Record<string, ReceiptShape>>;
  for (const key of Object.keys(value)) {
    if (!hasOwn(named, key)) refuse(INVALID, join(field, key), "is not a field of the live-authority receipt");
  }
  for (const [key, inner] of Object.entries(named)) {
    if (!hasOwn(value, key)) refuse(INVALID, join(field, key), "is missing");
    requireExactKeys(value[key], inner, join(field, key));
  }
}

function requireLiteral(value: unknown, field: string, expected: readonly string[]): void {
  if (typeof value !== "string" || !expected.includes(value)) {
    refuse(INVALID, field, `must be ${expected.map((entry) => JSON.stringify(entry)).join(" or ")}`);
  }
}

function requireMatch(value: unknown, field: string, pattern: RegExp, what: string): void {
  if (typeof value !== "string" || !pattern.test(value)) refuse(INVALID, field, `must be ${what}`);
}

function requireText(value: unknown, field: string): void {
  if (!isBoundedText(value)) refuse(INVALID, field, `must be 1-${TEXT_MAX} characters without control characters`);
}

function requireTimestamp(value: unknown, field: string): number {
  const micros = timestampMicros(value);
  if (micros === null) refuse(INVALID, field, "must be a canonical UTC ISO-8601 timestamp (YYYY-MM-DDTHH:MM:SS[.ffffff]Z)");
  return micros;
}

function requireCount(value: unknown, field: string): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) refuse(INVALID, field, "must be a non-negative integer");
}

const MODEL_SLOTS = [
  ["glm53", "glm/glm-5.3"], ["glm53Flash", "glm/glm-5.3-flash"], ["minimaxM3", "minimax/MiniMax-M3"],
] as const;

type ReceiptTimes = Readonly<{ issuedAt: number; notBefore: number; expiresAt: number; deadlineAt: number }>;

/** Field shapes, in receipt order, after exact keys. Returns the parsed times for the window checks. */
function requireReceiptFields(r: Record<string, unknown>): ReceiptTimes {
  requireLiteral(r.schema, "schema", [CCC_PLANNING_LIVE_AUTHORITY_RECEIPT_SCHEMA]);
  requireMatch(r.receiptId, "receiptId", RECEIPT_ID, "8-64 characters of a-z, 0-9 and '-', starting with a letter or digit");
  const issuedAt = requireTimestamp(r.issuedAt, "issuedAt");
  const notBefore = requireTimestamp(r.notBefore, "notBefore");
  const expiresAt = requireTimestamp(r.expiresAt, "expiresAt");
  const operator = r.operator as Record<string, unknown>;
  requireText(operator.actorId, "operator.actorId");
  requireText(operator.actorName, "operator.actorName");
  requireText((r.project as Record<string, unknown>).projectId, "project.projectId");

  const target = r.target as Record<string, unknown>;
  if (target.class === "admitted_repository") {
    refuse("CCC_PLANNING_QUALIFICATION_REQUIRED", "target.class",
      "an admitted repository needs a qualification certificate, and none exists before I6; only owned_disposable is admitted (D24)");
  }
  requireLiteral(target.class, "target.class", ["owned_disposable"]);
  if (!isAbsoluteNormalPath(target.scratchRoot)) refuse(INVALID, "target.scratchRoot", "must be an absolute, normalized path other than /");
  if (!isAbsoluteNormalPath(target.repositoryRealpath) || posix.dirname(target.repositoryRealpath) !== target.scratchRoot) {
    refuse(INVALID, "target.repositoryRealpath", "must be an absolute, normalized path directly inside target.scratchRoot");
  }
  requireMatch(target.baseCommit, "target.baseCommit", GIT_OBJECT_ID, "a 40- or 64-hex git object id");
  requireMatch(target.baseTree, "target.baseTree", GIT_OBJECT_ID, "a 40- or 64-hex git object id");
  if ((target.baseCommit as string).length !== (target.baseTree as string).length) {
    refuse(INVALID, "target.baseTree", "must use the same object format as target.baseCommit");
  }
  const marker = target.ownershipMarker as Record<string, unknown>;
  if (marker.path !== `${target.scratchRoot as string}/owner.json`) {
    refuse(INVALID, "target.ownershipMarker.path", "must be <scratchRoot>/owner.json, outside the repository");
  }
  requireMatch(marker.sha256, "target.ownershipMarker.sha256", SHA256_HEX, "a lowercase sha256");
  if (!Array.isArray(target.remotes)) refuse(INVALID, "target.remotes", "must be an empty array");
  if (target.remotes.length !== 0) {
    refuse("CCC_PLANNING_TARGET_NOT_DISPOSABLE", "target.remotes", "an owned disposable target has no remotes");
  }
  if (!Array.isArray(target.admittedFusionPaths)) refuse(INVALID, "target.admittedFusionPaths", "must be an array");
  const seen = new Set<string>();
  target.admittedFusionPaths.forEach((pattern: unknown, index: number) => {
    const field = `target.admittedFusionPaths[${index}]`;
    if (!isAdmittedFusionPathPattern(pattern)) {
      refuse(INVALID, field, "must be a relative path or <dir>/**, with no other wildcard, '..' or .git segment");
    }
    if (seen.has(pattern)) refuse(INVALID, field, "is a duplicate");
    seen.add(pattern);
  });

  const request = r.request as Record<string, unknown>;
  requireMatch(request.sha256, "request.sha256", SHA256_HEX, "a lowercase sha256");
  if (typeof request.byteLength !== "number" || !Number.isSafeInteger(request.byteLength)
    || request.byteLength < 1 || request.byteLength > REQUEST_MAX_BYTES) {
    refuse(INVALID, "request.byteLength", `must be an integer from 1 to ${REQUEST_MAX_BYTES}`);
  }
  requireLiteral(r.mode, "mode", ["spec", "build"]);
  requireLiteral(r.profile, "profile", ["full-v2"]);
  requireLiteral(r.budgetProfile, "budgetProfile", ["standard", "large"]);
  requireText(r.budgetPolicyVersion, "budgetPolicyVersion");
  if (typeof r.largeAuthorized !== "boolean") refuse(INVALID, "largeAuthorized", "must be a boolean");
  const caps = r.phaseCallCaps as Record<string, unknown>;
  for (const key of ["planning", "implementation", "reviewProof"]) requireCount(caps[key], `phaseCallCaps.${key}`);
  const deadlineAt = requireTimestamp(r.deadlineAt, "deadlineAt");

  const models = r.models as Record<string, unknown>;
  for (const [slot, exact] of MODEL_SLOTS) {
    const modelId = models[slot];
    if (typeof modelId !== "string") refuse(INVALID, `models.${slot}`, "must be a string");
    if (modelId !== exact) {
      const identity = classifyCccModelIdentity(modelId);
      refuse("CCC_PLANNING_REJECTED_MODEL_IDENTITY", `models.${slot}`, identity.admitted
        ? `${modelId} is an exact pin, but this slot admits only ${exact}`
        : `${modelId} is refused (${identity.reason}); this slot admits only ${exact}`);
    }
  }

  const omniRoute = r.omniRoute as Record<string, unknown>;
  if (typeof omniRoute.baseUrl !== "string" || omniRoute.baseUrl === "" || omniRoute.baseUrl.length > 2048) {
    refuse(INVALID, "omniRoute.baseUrl", "must be a URL string (its loopback rule is G0 step 8)");
  }
  requireLiteral(omniRoute.receiptAdapterId, "omniRoute.receiptAdapterId", ["terminal-route-sse-comments.v1"]);
  const providerIds = omniRoute.providerIds as Record<string, unknown>;
  for (const [slot] of MODEL_SLOTS) {
    requireMatch(providerIds[slot], `omniRoute.providerIds.${slot}`, PROVIDER_ID, "a canonical provider identifier");
  }
  if (new Set(MODEL_SLOTS.map(([slot]) => providerIds[slot])).size !== MODEL_SLOTS.length) {
    refuse(INVALID, "omniRoute.providerIds", "must name three distinct providers, one pinned model each");
  }

  const quota = r.quota as Record<string, unknown>;
  requireLiteral(quota.accounting, "quota.accounting", ["subscription_unknown"]);
  requireLiteral(quota.meteredFallback, "quota.meteredFallback", ["forbidden"]);
  requireLiteral(r.escalation, "escalation", ["forbidden"]);
  const actions = r.permittedProtectedActions as readonly Record<string, unknown>[];
  if (actions.length > 1) refuse(INVALID, "permittedProtectedActions", "may list at most one protected action");
  actions.forEach((action, index) => {
    requireLiteral(action.kind, `permittedProtectedActions[${index}].kind`, ["live_execution"]);
    requireLiteral(action.release, `permittedProtectedActions[${index}].release`, LIVE_EXECUTION_RELEASES);
  });
  const sourceToolPolicy = r.sourceToolPolicy as Record<string, unknown>;
  requireText(sourceToolPolicy.policyId, "sourceToolPolicy.policyId");
  requireMatch(sourceToolPolicy.sha256, "sourceToolPolicy.sha256", SHA256_HEX, "a lowercase sha256");
  const runtime = r.runtime as Record<string, unknown>;
  requireMatch(runtime.installedRuntimeReceiptSha256, "runtime.installedRuntimeReceiptSha256", SHA256_HEX, "a lowercase sha256");
  requireText(runtime.packageVersion, "runtime.packageVersion");
  requireMatch(runtime.distManifestSha256, "runtime.distManifestSha256", SHA256_HEX, "a lowercase sha256");
  requireMatch(r.operatorConfirmation, "operatorConfirmation", SHA256_HEX, "a lowercase sha256");

  // The window itself (section 4.6): issued before it starts, at most 7 days long, and covering the deadline.
  if (notBefore < issuedAt) refuse(INVALID, "notBefore", "must not be before issuedAt");
  if (expiresAt > issuedAt + SEVEN_DAYS_MICROS) refuse(INVALID, "expiresAt", "must be at most 7 days after issuedAt");
  if (expiresAt < deadlineAt) refuse(INVALID, "expiresAt", "must not be before deadlineAt");
  if (expiresAt <= notBefore) refuse(INVALID, "expiresAt", "must be after notBefore");
  return { issuedAt, notBefore, expiresAt, deadlineAt };
}

export function parseCccPlanningLiveAuthorityReceipt(
  bytes: Uint8Array,
  input: { confirmDigest: string; now: string; budgetPolicy: CccPlanningBudgetPolicy },
):
  | { ok: true; receipt: CccPlanningLiveAuthorityReceiptV1; receiptSha256: string }
  | { ok: false; code: CccPlanningAuthorityRefusalCode; field: string; detail: string } {
  const now = timestampMicros(input.now);
  if (now === null) throw new TypeError(`parseCccPlanningLiveAuthorityReceipt: now must be a canonical UTC timestamp, got ${JSON.stringify(input.now)}`);
  try {
    if (typeof input.confirmDigest !== "string" || input.confirmDigest === "") {
      refuse("CCC_PLANNING_AUTHORITY_CONFIRMATION_REQUIRED", "confirmDigest",
        "--confirm-authority is required: the receipt digest exactly as the operator typed it");
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      refuse(INVALID, "$", "receipt bytes are not valid UTF-8");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      refuse(INVALID, "$", "receipt bytes are not JSON");
    }
    let canonical: string;
    try {
      canonical = canonicalCccPrdJson(parsed);
    } catch {
      refuse(INVALID, "$", "receipt is not canonical JSON");
    }
    if (text !== canonical && text !== `${canonical}\n`) {
      refuse(INVALID, "$", "receipt bytes must be exactly the canonical JSON of the receipt (one trailing newline allowed)");
    }
    requireExactKeys(parsed, RECEIPT_SHAPE, "");
    const record = parsed as Record<string, unknown>;
    const times = requireReceiptFields(record);
    const receipt = record as unknown as CccPlanningLiveAuthorityReceiptV1;

    // G0 step 2: the stored confirmation is the digest of this body, and the operator typed that same digest.
    if (receipt.operatorConfirmation !== computeCccPlanningAuthorityReceiptDigest(receipt)) {
      refuse("CCC_PLANNING_AUTHORITY_RECEIPT_UNCONFIRMED", "operatorConfirmation",
        "operatorConfirmation is not the digest of this receipt; the receipt changed after it was confirmed");
    }
    if (input.confirmDigest !== receipt.operatorConfirmation) {
      refuse("CCC_PLANNING_AUTHORITY_RECEIPT_UNCONFIRMED", "confirmDigest",
        "--confirm-authority does not equal the receipt's operatorConfirmation");
    }

    // G0 step 3: inside the validity window, before the deadline.
    if (now < times.notBefore) refuse("CCC_PLANNING_AUTHORITY_RECEIPT_EXPIRED", "notBefore", "the receipt is not valid yet");
    if (now >= times.expiresAt) refuse("CCC_PLANNING_AUTHORITY_RECEIPT_EXPIRED", "expiresAt", "the receipt has expired");
    if (now >= times.deadlineAt) refuse("CCC_PLANNING_AUTHORITY_RECEIPT_EXPIRED", "deadlineAt", "the receipt's deadline has passed");

    // G0 step 6: the caps are the versioned allocation for the profile; another size is an amendment, not a receipt.
    if (receipt.budgetPolicyVersion !== input.budgetPolicy.policyVersion) {
      refuse("CCC_PLANNING_BUDGET_POLICY_MISMATCH", "budgetPolicyVersion",
        `the receipt names ${receipt.budgetPolicyVersion}; the admitted policy is ${input.budgetPolicy.policyVersion}`);
    }
    const profiles = input.budgetPolicy.profiles as Readonly<Record<string, Readonly<{ planning: number; implementation: number; reviewProof: number }>>>;
    const allocation = profiles[`${receipt.mode}:${receipt.budgetProfile}`];
    if (!allocation) {
      refuse("CCC_PLANNING_BUDGET_POLICY_MISMATCH", "budgetProfile", `the policy has no ${receipt.mode}:${receipt.budgetProfile} profile`);
    }
    for (const key of ["planning", "implementation", "reviewProof"] as const) {
      if (receipt.phaseCallCaps[key] !== allocation[key]) {
        refuse("CCC_PLANNING_BUDGET_POLICY_MISMATCH", `phaseCallCaps.${key}`,
          `${receipt.mode}:${receipt.budgetProfile} allocates ${allocation[key]} ${key} calls; the receipt says ${receipt.phaseCallCaps[key]}`);
      }
    }

    return { ok: true, receipt: deepFreeze(receipt), receiptSha256: sha256Hex(canonical) };
  } catch (error) {
    if (error instanceof ReceiptRefused) return { ok: false, code: error.code, field: error.field, detail: error.detail };
    throw error;
  }
}

// ---------------------------------------------------------------- envelope check (section 2.18)

class EnvelopeMismatch {
  public constructor(public readonly field: string, public readonly detail: string) {}
}

function mismatch(field: string, detail: string): never {
  throw new EnvelopeMismatch(field, detail);
}

function envelopeTime(value: unknown, field: string): number {
  const micros = timestampMicros(value);
  if (micros === null) mismatch(field, "is not a canonical UTC timestamp");
  return micros;
}

/*
FNXC:CccPlanningAuthority 2026-10-14-13:52:
The envelope check decides whether code may release live execution for the campaign this run imported, with no operator step (D36, leader ruling `controller_within_receipt`). It never widens: every field of the issued authorization must sit inside the receipt and the run, and any mismatch returns the field so AU2 falls back to `awaiting_execution_authority`. The import key is `cccPlanningImportKey(runId, runRevision)` (`ccc-plan:<24hex>:r<n>`, decision 0.5), not v1's digest-keyed form, so a retry with a changed digest can never point the release at a second campaign. The bundle hash is checked against the intent elsewhere (section 2.18). Two checks beyond ADR D's list are fail-closed bindings: the receipt is the one the run consumed (its SHA-256 and confirmation), and the authorization's project is the receipt's project.
*/
function checkEnvelope(input: Parameters<typeof assertCccPlanningExecutionAuthorizationWithinReceipt>[0]): void {
  const { receipt, run, authorization, baseline } = input;
  const actions = receipt.permittedProtectedActions;
  if (actions.length !== 1 || actions[0]!.kind !== "live_execution" || actions[0]!.release !== "controller_within_receipt") {
    mismatch("receipt.permittedProtectedActions", "the receipt does not let the controller release live execution");
  }
  let confirmation: string;
  try {
    confirmation = computeCccPlanningAuthorityReceiptDigest(receipt);
  } catch {
    mismatch("receipt", "the receipt cannot be digested");
  }
  if (receipt.operatorConfirmation !== confirmation) mismatch("receipt.operatorConfirmation", "the receipt changed after confirmation");
  // The consumed receipt's identity is the SHA-256 of its canonical named fields, as parse returned it (errata E1-11).
  if (sha256Hex(canonicalCccPrdJson(projectNamed(receipt, RECEIPT_SHAPE, ""))) !== input.receiptSha256) {
    mismatch("receiptSha256", "the receipt is not the one this run consumed");
  }
  const now = envelopeTime(input.now, "now");
  if (now < envelopeTime(receipt.notBefore, "receipt.notBefore") || now >= envelopeTime(receipt.expiresAt, "receipt.expiresAt")) {
    mismatch("now", "outside the receipt's validity window");
  }

  if (authorization.projectId !== receipt.project.projectId) mismatch("authorization.projectId", "not the receipt's project");
  if (authorization.targetRepository !== receipt.target.repositoryRealpath) {
    mismatch("authorization.targetRepository", "not the receipt's repository");
  }
  if (typeof baseline.commit !== "string" || !GIT_OBJECT_ID.test(baseline.commit) || authorization.targetBase !== baseline.commit) {
    mismatch("authorization.targetBase", "not the observed Build baseline B1");
  }
  if (baseline.firstParent !== receipt.target.baseCommit) mismatch("baseline.firstParent", "B1's first parent is not the receipt's base commit");
  for (const path of baseline.changedPaths) {
    if (!isRelativeNormalPath(path) || !receipt.target.admittedFusionPaths.some((pattern) => matchesAdmittedFusionPath(path, pattern))) {
      mismatch("baseline.changedPaths", `${JSON.stringify(path)} is outside the receipt's admitted Fusion paths`);
    }
  }

  let importKey: string;
  try {
    importKey = cccPlanningImportKey(run.runId, run.runRevision);
  } catch {
    mismatch("run.runId", "the run id and revision do not form an import key");
  }
  if (authorization.idempotencyKey !== importKey) mismatch("authorization.idempotencyKey", `must be ${importKey}`);

  const flashProvider = receipt.omniRoute.providerIds.glm53Flash;
  if (run.writerProviderId !== flashProvider) mismatch("run.writerProviderId", "not the receipt's Flash provider");
  const members = authorization.members;
  if (members.length < 1 || members.length !== run.compiledProviderTaskCount) {
    mismatch("authorization.members", `has ${members.length} members; the compiled campaign has ${run.compiledProviderTaskCount} provider tasks`);
  }
  members.forEach((member, index) => {
    const field = `authorization.members[${index}]`;
    if (member.modelId !== receipt.models.glm53Flash) mismatch(`${field}.modelId`, `must be ${receipt.models.glm53Flash}`);
    if (member.providerId !== flashProvider) mismatch(`${field}.providerId`, `must be ${flashProvider}`);
    if (member.transport !== "pi") mismatch(`${field}.transport`, "must be pi");
  });
  if (!Number.isSafeInteger(authorization.maxRequests) || authorization.maxRequests < 1
    || authorization.maxRequests > run.implementationCallsRemaining) {
    mismatch("authorization.maxRequests", `must be at most the ${run.implementationCallsRemaining} implementation calls remaining`);
  }
  const deadline = Math.min(envelopeTime(receipt.deadlineAt, "receipt.deadlineAt"), envelopeTime(run.deadlineAt, "run.deadlineAt"));
  if (envelopeTime(authorization.campaignDeadlineAt, "authorization.campaignDeadlineAt") > deadline) {
    mismatch("authorization.campaignDeadlineAt", "is after the receipt's or the run's deadline");
  }
  if (envelopeTime(authorization.expiresAt, "authorization.expiresAt") > envelopeTime(receipt.expiresAt, "receipt.expiresAt")) {
    mismatch("authorization.expiresAt", "outlives the receipt");
  }
}

export function assertCccPlanningExecutionAuthorizationWithinReceipt(input: {
  receipt: CccPlanningLiveAuthorityReceiptV1; receiptSha256: string;
  run: { runId: string; runRevision: number; deadlineAt: string; implementationCallsRemaining: number;
    compiledProviderTaskCount: number; writerProviderId: string };
  authorization: CccCampaignExecutionAuthorization;   // execution-authorization.ts
  baseline: { commit: string; firstParent: string; changedPaths: readonly string[] };
  now: string;
}): { ok: true } | { ok: false; code: "CCC_PLANNING_RECEIPT_ENVELOPE_MISMATCH"; field: string; detail: string } {
  try {
    checkEnvelope(input);
    return { ok: true };
  } catch (error) {
    if (error instanceof EnvelopeMismatch) {
      return { ok: false, code: "CCC_PLANNING_RECEIPT_ENVELOPE_MISMATCH", field: error.field, detail: error.detail };
    }
    throw error;
  }
}
