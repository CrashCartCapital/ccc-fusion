import { createHash } from "node:crypto";

export const CCC_MODEL_CAPABILITY_PROFILE_SCHEMA_VERSION = "1.0" as const;

export const CCC_MODEL_CAPABILITY_KEYS = [
  "supportedInstructionRoles",
  "reasoningRequestDialect",
  "reasoningResponseDialect",
  "reasoningHistoryReplay",
  "toolCallRequestSchema",
  "toolCallResponseSchema",
  "toolCallIdPreservation",
  "terminalFinishSignals",
  "finalRouteReceipt",
  "usageReceipt",
  "streamFinalization",
  "resumeReplaySafety",
  "declaredLimits",
  "transportTransformationOwner",
] as const;

export const CCC_CAMPAIGN_CRITICAL_CAPABILITY_KEYS =
  CCC_MODEL_CAPABILITY_KEYS;

export const CCC_MODEL_CAPABILITY_EVIDENCE_STATES = [
  "unknown",
  "declared",
  "offline_proven",
  "live_proven",
] as const;

export type CccModelCapabilityKey =
  (typeof CCC_MODEL_CAPABILITY_KEYS)[number];
export type CccModelCapabilityEvidenceState =
  (typeof CCC_MODEL_CAPABILITY_EVIDENCE_STATES)[number];
export type CccSupportedInstructionRole = "system" | "developer";
export type CccReasoningHistoryReplay = "required" | "optional" | "forbidden";
export type CccResumeReplaySafety = "safe" | "unsafe" | "conditional";
export type CccTransportTransformationOwner =
  | "provider"
  | "gateway"
  | "adapter"
  | "none";

export type CccCapabilityEvidence<T> = Readonly<
  | { evidence: "unknown"; value: null }
  | {
      evidence: Exclude<CccModelCapabilityEvidenceState, "unknown">;
      value: T;
    }
>;

export interface CccModelCapabilityProfile {
  readonly schemaVersion: typeof CCC_MODEL_CAPABILITY_PROFILE_SCHEMA_VERSION;
  readonly profileId: string;
  readonly revision: number;
  readonly route: Readonly<{
    provider: string;
    model: string;
    transport: string;
  }>;
  readonly capabilities: Readonly<{
    supportedInstructionRoles: CccCapabilityEvidence<
      readonly CccSupportedInstructionRole[]
    >;
    reasoningRequestDialect: CccCapabilityEvidence<string>;
    reasoningResponseDialect: CccCapabilityEvidence<string>;
    reasoningHistoryReplay: CccCapabilityEvidence<CccReasoningHistoryReplay>;
    toolCallRequestSchema: CccCapabilityEvidence<string>;
    toolCallResponseSchema: CccCapabilityEvidence<string>;
    toolCallIdPreservation: CccCapabilityEvidence<boolean>;
    terminalFinishSignals: CccCapabilityEvidence<readonly string[]>;
    finalRouteReceipt: CccCapabilityEvidence<boolean>;
    usageReceipt: CccCapabilityEvidence<boolean>;
    streamFinalization: CccCapabilityEvidence<string>;
    resumeReplaySafety: CccCapabilityEvidence<CccResumeReplaySafety>;
    declaredLimits: CccCapabilityEvidence<
      Readonly<{ contextTokens: number; outputTokens: number }>
    >;
    transportTransformationOwner: CccCapabilityEvidence<CccTransportTransformationOwner>;
  }>;
}

export class CccModelCapabilityProfileValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(issues.join("; "));
    this.name = "CccModelCapabilityProfileValidationError";
    this.issues = Object.freeze([...issues]);
  }
}

type JsonObject = Record<string, unknown>;
type ValueValidator = (value: unknown, path: string, issues: string[]) => void;

const SHA256_FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function validateBoolean(
  value: unknown,
  path: string,
  issues: string[],
): void {
  if (typeof value !== "boolean") issues.push(`${path}: must be a boolean`);
}

function enumValidator(values: readonly string[]): ValueValidator {
  const allowed = new Set(values);
  return (value, path, issues) => {
    if (typeof value !== "string" || !allowed.has(value)) {
      issues.push(`${path}: must be one of ${values.join(", ")}`);
    }
  };
}

function validateStringArray(
  value: unknown,
  path: string,
  issues: string[],
  allowed?: readonly string[],
): void {
  if (!Array.isArray(value)) {
    issues.push(`${path}: must be an array`);
    return;
  }
  const allowedValues = allowed ? new Set(allowed) : null;
  const seen = new Set<string>();
  value.forEach((entry, index) => {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      issues.push(`${path}[${index}]: must be a non-empty string`);
      return;
    }
    if (allowedValues && !allowedValues.has(entry)) {
      issues.push(`${path}[${index}]: unsupported value ${entry}`);
    }
    if (seen.has(entry)) issues.push(`${path}[${index}]: duplicate value ${entry}`);
    seen.add(entry);
  });
}

function validateFingerprint(
  value: unknown,
  path: string,
  issues: string[],
): void {
  if (typeof value !== "string" || !SHA256_FINGERPRINT_PATTERN.test(value)) {
    issues.push(`${path}: must be a lowercase sha256 fingerprint`);
  }
}

function validateDeclaredLimits(
  value: unknown,
  path: string,
  issues: string[],
): void {
  if (!isObject(value)) {
    issues.push(`${path}: must be an object`);
    return;
  }
  rejectUnknownKeys(value, ["contextTokens", "outputTokens"], path, issues);
  for (const key of ["contextTokens", "outputTokens"] as const) {
    const limit = value[key];
    if (!Number.isSafeInteger(limit) || (limit as number) <= 0) {
      issues.push(`${path}.${key}: must be a positive safe integer`);
    }
  }
}

const CAPABILITY_VALUE_VALIDATORS: Readonly<
  Record<CccModelCapabilityKey, ValueValidator>
> = {
  supportedInstructionRoles: (value, path, issues) =>
    validateStringArray(value, path, issues, ["system", "developer"]),
  reasoningRequestDialect: validateNonEmptyString,
  reasoningResponseDialect: validateNonEmptyString,
  reasoningHistoryReplay: enumValidator(["required", "optional", "forbidden"]),
  toolCallRequestSchema: validateFingerprint,
  toolCallResponseSchema: validateFingerprint,
  toolCallIdPreservation: validateBoolean,
  terminalFinishSignals: validateStringArray,
  finalRouteReceipt: validateBoolean,
  usageReceipt: validateBoolean,
  streamFinalization: validateNonEmptyString,
  resumeReplaySafety: enumValidator(["safe", "unsafe", "conditional"]),
  declaredLimits: validateDeclaredLimits,
  transportTransformationOwner: enumValidator([
    "provider",
    "gateway",
    "adapter",
    "none",
  ]),
};

function validateCapability(
  value: unknown,
  key: CccModelCapabilityKey,
  issues: string[],
): void {
  const path = `capabilities.${key}`;
  if (!isObject(value)) {
    issues.push(`${path}: must be an object`);
    return;
  }
  rejectUnknownKeys(value, ["evidence", "value"], path, issues);
  const evidence = value.evidence;
  if (
    typeof evidence !== "string" ||
    !(CCC_MODEL_CAPABILITY_EVIDENCE_STATES as readonly string[]).includes(evidence)
  ) {
    issues.push(
      `${path}.evidence: must be one of ${CCC_MODEL_CAPABILITY_EVIDENCE_STATES.join(", ")}`,
    );
    return;
  }
  if (!("value" in value)) {
    issues.push(`${path}.value: missing required property`);
    return;
  }
  if (evidence === "unknown") {
    if (value.value !== null) {
      issues.push(`${path}.value: must be null when evidence is unknown`);
    }
    return;
  }
  CAPABILITY_VALUE_VALIDATORS[key](value.value, `${path}.value`, issues);
}

function cloneCapabilityValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneCapabilityValue);
  if (isObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, cloneCapabilityValue(entry)]),
    );
  }
  return value;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const entry of Object.values(value)) deepFreeze(entry);
  return Object.freeze(value);
}

export function parseCccModelCapabilityProfile(
  input: unknown,
): Readonly<CccModelCapabilityProfile> {
  const issues: string[] = [];
  if (!isObject(input)) {
    throw new CccModelCapabilityProfileValidationError([
      "profile: must be an object",
    ]);
  }

  rejectUnknownKeys(
    input,
    ["schemaVersion", "profileId", "revision", "route", "capabilities"],
    "",
    issues,
  );
  if (input.schemaVersion !== CCC_MODEL_CAPABILITY_PROFILE_SCHEMA_VERSION) {
    issues.push(
      `schemaVersion: must equal ${CCC_MODEL_CAPABILITY_PROFILE_SCHEMA_VERSION}`,
    );
  }
  validateNonEmptyString(input.profileId, "profileId", issues);
  if (!Number.isSafeInteger(input.revision) || (input.revision as number) <= 0) {
    issues.push("revision: must be a positive safe integer");
  }

  if (!isObject(input.route)) {
    issues.push("route: must be an object");
  } else {
    rejectUnknownKeys(
      input.route,
      ["provider", "model", "transport"],
      "route",
      issues,
    );
    validateNonEmptyString(input.route.provider, "route.provider", issues);
    validateNonEmptyString(input.route.model, "route.model", issues);
    validateNonEmptyString(input.route.transport, "route.transport", issues);
  }

  if (!isObject(input.capabilities)) {
    issues.push("capabilities: must be an object");
  } else {
    rejectUnknownKeys(
      input.capabilities,
      CCC_MODEL_CAPABILITY_KEYS,
      "capabilities",
      issues,
    );
    for (const key of CCC_MODEL_CAPABILITY_KEYS) {
      if (!(key in input.capabilities)) {
        issues.push(`capabilities.${key}: missing required capability`);
      } else {
        validateCapability(input.capabilities[key], key, issues);
      }
    }
  }

  if (issues.length > 0) {
    throw new CccModelCapabilityProfileValidationError(issues);
  }

  const route = input.route as JsonObject;
  const capabilities = input.capabilities as JsonObject;
  const parsed = {
    schemaVersion: CCC_MODEL_CAPABILITY_PROFILE_SCHEMA_VERSION,
    profileId: input.profileId as string,
    revision: input.revision as number,
    route: {
      provider: route.provider as string,
      model: route.model as string,
      transport: route.transport as string,
    },
    capabilities: Object.fromEntries(
      CCC_MODEL_CAPABILITY_KEYS.map((key) => {
        const capability = capabilities[key] as JsonObject;
        return [
          key,
          {
            evidence: capability.evidence,
            value: cloneCapabilityValue(capability.value),
          },
        ];
      }),
    ),
  } as unknown as CccModelCapabilityProfile;

  return deepFreeze(parsed);
}

function canonicalizeValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalizeValue).join(",")}]`;
  }
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalizeValue(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function canonicalizeCccModelCapabilityProfile(
  profile: Readonly<CccModelCapabilityProfile>,
): string {
  return canonicalizeValue(profile);
}

export function digestCccModelCapabilityProfile(
  profile: Readonly<CccModelCapabilityProfile>,
): string {
  return createHash("sha256")
    .update(canonicalizeCccModelCapabilityProfile(profile), "utf8")
    .digest("hex");
}

export interface CccCampaignCapabilityAdmission {
  readonly admitted: boolean;
  readonly reasons: readonly string[];
}

export function evaluateCccCampaignCapabilityAdmission(
  profile: Readonly<CccModelCapabilityProfile>,
): Readonly<CccCampaignCapabilityAdmission> {
  const reasons = CCC_CAMPAIGN_CRITICAL_CAPABILITY_KEYS.flatMap((key) =>
    profile.capabilities[key].evidence === "unknown"
      ? [`capabilities.${key}: campaign-critical evidence is unknown`]
      : [],
  );
  return deepFreeze({ admitted: reasons.length === 0, reasons });
}
