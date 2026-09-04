import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { canonicalCccPrdJson, compareCccPrdCodeUnits } from "../ccc-prd/contract.js";
import type {
  CccPrdProof,
  CccPrdPythonExecutionToolchain,
  CccPrdSemanticBundle,
} from "../ccc-prd/types.js";
import {
  CCC_CAMPAIGN_CONTEXT_SCHEMA_VERSION,
  CCC_CAMPAIGN_EXECUTION_AUTHORIZATION_MODE_PER_TASK_V1,
  CCC_CAMPAIGN_EXECUTION_AUTHORIZATION_MODE_SEALED_BUNDLE_V1,
  CCC_CAMPAIGN_EXECUTION_POLICY_SCHEMA_VERSION,
  CCC_CAMPAIGN_EXECUTION_POLICY_V2_SCHEMA_VERSION,
  CCC_CAMPAIGN_EXECUTION_POLICY_V3_SCHEMA_VERSION,
  CCC_CAMPAIGN_MANIFEST_V1_SCHEMA_VERSION,
  CCC_CAMPAIGN_MANIFEST_V2_SCHEMA_VERSION,
  CCC_PRD_EXECUTION_PLAN_SCHEMA_VERSION,
  CccCampaignContextError,
  type CccCampaignActionLookup,
  type CccCampaignAuthorityBinding,
  type CccCampaignContext,
  type CccCampaignExecutionPolicy,
  type CccCampaignExecutionAuthorizationMode,
  type CccCampaignExecutionRoute,
  type CccCampaignManifest,
  type CccCampaignManifestBase,
  type CccCampaignProductExecutionPolicy,
  type CccCampaignProductExecutionPolicyV3,
  type CccCampaignProductExecutionRoute,
  type CccCampaignProductExecutionRouteV3,
  type CccCampaignRouteAccessTier,
  type CccCampaignRouteEgressPolicy,
  type CccCampaignRouteFallbackPolicy,
  type CccCampaignRouteLimits,
  type CccCampaignRouteReasoningEffort,
  type CccCampaignRouteReceiptAdapterId,
  type CccCampaignRouteSensitivityClass,
  type CccCampaignRouteServiceTier,
  type CccCampaignTerminalRouteMember,
  type CccCampaignTransport,
  type CccPrdProductExecutionPlan,
  type CccPrdProductExecutionRouteSelection,
} from "./types.js";

const ROUTE_KEYS = ["modelId", "providerId", "taskId", "transport"] as const;
const WORKFLOW_ROUTE_KEYS = [...ROUTE_KEYS, "workflowExtensionId"] as const;
const ROUTE_RECEIPT_KEYS = [...ROUTE_KEYS, "receiptAdapterId"] as const;
const ROUTE_COMBO_RECEIPT_KEYS = [...ROUTE_RECEIPT_KEYS, "terminalRouteMembers"] as const;
const PRODUCT_ROUTE_KEYS = [
  "allowedWriteRoots",
  "commitPolicy",
  "executor",
  "modelId",
  "ownedPaths",
  "providerId",
  "taskId",
  "toolMode",
  "transport",
  "worktreeMode",
] as const;
const PRODUCT_CLI_ROUTE_KEYS = [...PRODUCT_ROUTE_KEYS, "cliAdapterId"] as const;
const PRODUCT_ROUTE_RECEIPT_KEYS = [...PRODUCT_ROUTE_KEYS, "receiptAdapterId"] as const;
const PRODUCT_ROUTE_COMBO_RECEIPT_KEYS = [...PRODUCT_ROUTE_RECEIPT_KEYS, "terminalRouteMembers"] as const;
const PRODUCT_ROUTE_V3_KEYS = [
  "accessTier",
  "allowedWriteRoots",
  "catalogDigest",
  "commitPolicy",
  "decidedAt",
  "egressPolicy",
  "executor",
  "fallbackPolicy",
  "limits",
  "modelId",
  "ownedPaths",
  "providerId",
  "reasoningEffort",
  "routeProfileId",
  "sensitivityClass",
  "serviceTier",
  "taskArchetype",
  "taskId",
  "toolMode",
  "transport",
  "worktreeMode",
] as const;
const PRODUCT_CLI_ROUTE_V3_KEYS = [...PRODUCT_ROUTE_V3_KEYS, "cliAdapterId"] as const;
const PRODUCT_ROUTE_RECEIPT_V3_KEYS = [...PRODUCT_ROUTE_V3_KEYS, "receiptAdapterId"] as const;
const PRODUCT_ROUTE_COMBO_RECEIPT_V3_KEYS = [...PRODUCT_ROUTE_RECEIPT_V3_KEYS, "terminalRouteMembers"] as const;
const RECEIPT_ADAPTER_IDS = new Set<CccCampaignRouteReceiptAdapterId>([
  "terminal-route-sse-comments.v1",
]);
const EGRESS_POLICY_LOOPBACK_KEYS = ["kind"] as const;
const EGRESS_POLICY_ALLOWLISTED_KEYS = ["kind", "providers"] as const;
const FALLBACK_POLICY_KEYS = ["kind"] as const;
const LIMITS_REQUIRED_KEYS = ["maxConcurrency", "maxDurationMs", "maxRequests"] as const;
const LIMITS_ALL_KEYS = [
  "maxConcurrency",
  "maxDurationMs",
  "maxRequests",
  "maxResponseTokens",
  "maxSpendUsd",
] as const;
const REASONING_EFFORTS = new Set<CccCampaignRouteReasoningEffort>([
  "minimal",
  "low",
  "medium",
  "high",
  "max",
  "not-applicable",
]);
const SERVICE_TIERS = new Set<CccCampaignRouteServiceTier>([
  "standard",
  "priority",
  "flex",
  "default",
]);
const ACCESS_TIERS = new Set<CccCampaignRouteAccessTier>([
  "subscription",
  "free",
  "plan",
  "metered",
  "unknown",
]);
const SENSITIVITY_CLASSES = new Set<CccCampaignRouteSensitivityClass>([
  "private-vault",
  "sanitized",
  "synthetic",
  "public",
]);
const POLICY_KEYS = ["routes", "schema"] as const;
const EXECUTION_PLAN_KEYS = [
  "bundleHash",
  "packetHash",
  "policy",
  "schema",
  "sidecarHash",
] as const;
const AUTHORITY_BINDING_KEYS = [
  "actionId",
  "actionTarget",
  "bindingHash",
  "bundleHash",
  "campaignId",
  "idempotencyKey",
  "importId",
  "manifestHash",
  "modelId",
  "packetHash",
  "projectId",
  "providerId",
  "sidecarHash",
  "targetBase",
  "targetRepository",
  "taskId",
  "transport",
] as const;
const TRANSPORTS = new Set<CccCampaignTransport>(["pi", "cli", "workflow"]);
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const WORKFLOW_EXTENSION_REGISTRY_ID_PATTERN = /^plugin:[a-z0-9]([a-z0-9-]*[a-z0-9])?:[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

export class CccCampaignExecutionPolicyError extends Error {
  public readonly code = "CCC_PRD_EXECUTION_ROUTE_REFUSED";

  public constructor(message: string) {
    super(message);
    this.name = "CccCampaignExecutionPolicyError";
  }
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const observed = Object.keys(value).sort(compareCccPrdCodeUnits);
  const canonicalExpected = [...expected].sort(compareCccPrdCodeUnits);
  if (canonicalCccPrdJson(observed) !== canonicalCccPrdJson(canonicalExpected)) {
    throw new CccCampaignExecutionPolicyError(
      `${label} fields must be exactly ${canonicalExpected.join(", ")}; received ${observed.join(", ") || "none"}`,
    );
  }
}

function exactIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || value !== value.trim()
    || !IDENTIFIER_PATTERN.test(value)
  ) {
    throw new CccCampaignExecutionPolicyError(
      `${label} must be a non-empty canonical identifier`,
    );
  }
  return value;
}

function assertReceiptAdapterModelIdentity(
  modelId: string,
  receiptAdapterId: CccCampaignRouteReceiptAdapterId | undefined,
  label: string,
): void {
  if (receiptAdapterId === undefined) return;
  const separator = modelId.indexOf("/");
  if (
    separator <= 0
    || separator === modelId.length - 1
    || modelId.indexOf("/", separator + 1) !== -1
  ) {
    throw new CccCampaignExecutionPolicyError(
      `${label} receipt adapter requires a provider-qualified model in provider/model form`,
    );
  }
}

function isComboModel(modelId: string): boolean {
  return modelId.startsWith("combo/") && modelId.indexOf("/", "combo/".length) === -1;
}

function parseTerminalRouteMembers(
  value: unknown,
  present: boolean,
  modelId: string,
  receiptAdapterId: CccCampaignRouteReceiptAdapterId | undefined,
  label: string,
): readonly CccCampaignTerminalRouteMember[] | undefined {
  const combo = isComboModel(modelId);
  if (combo && receiptAdapterId === undefined) {
    throw new CccCampaignExecutionPolicyError(
      `${label} combo request requires a terminal route receipt adapter`,
    );
  }
  if (combo && !present) {
    throw new CccCampaignExecutionPolicyError(
      `${label} combo request requires terminalRouteMembers`,
    );
  }
  if (!combo && present) {
    throw new CccCampaignExecutionPolicyError(
      `${label} terminalRouteMembers is permitted only for a combo request`,
    );
  }
  if (!present) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new CccCampaignExecutionPolicyError(
      `${label} terminalRouteMembers must be a non-empty array`,
    );
  }
  const seen = new Set<string>();
  const members = value.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new CccCampaignExecutionPolicyError(
        `${label} terminalRouteMembers[${index}] must be an object`,
      );
    }
    const member = candidate as Record<string, unknown>;
    exactKeys(member, ["model", "provider"], `${label} terminalRouteMembers[${index}]`);
    const parsed = Object.freeze({
      provider: exactIdentifier(member.provider, `${label} terminalRouteMembers[${index}] provider`),
      model: exactIdentifier(member.model, `${label} terminalRouteMembers[${index}] model`),
    });
    const key = `${parsed.provider}\u0000${parsed.model}`;
    if (seen.has(key)) {
      throw new CccCampaignExecutionPolicyError(
        `${label} terminalRouteMembers must not contain duplicates`,
      );
    }
    seen.add(key);
    return parsed;
  });
  return Object.freeze(members);
}

function parseRoute(value: unknown, index: number): CccCampaignExecutionRoute {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CccCampaignExecutionPolicyError(
      `CCC campaign execution route ${index} must be an object`,
    );
  }
  const route = value as Record<string, unknown>;
  const transport = exactIdentifier(
    route.transport,
    `CCC campaign execution route ${index} transport`,
  );
  if (!TRANSPORTS.has(transport as CccCampaignTransport)) {
    throw new CccCampaignExecutionPolicyError(
      `CCC campaign execution route ${index} has unsupported transport ${JSON.stringify(transport)}`,
    );
  }
  const isWorkflowTransport = transport === "workflow";
  const hasReceiptAdapter = Object.prototype.hasOwnProperty.call(route, "receiptAdapterId");
  const hasTerminalRouteMembers = Object.prototype.hasOwnProperty.call(route, "terminalRouteMembers");
  if (hasReceiptAdapter && transport !== "pi") {
    throw new CccCampaignExecutionPolicyError(
      `CCC campaign execution route ${index} receiptAdapterId is forbidden for ${transport} transport`,
    );
  }
  if (!isWorkflowTransport && Object.prototype.hasOwnProperty.call(route, "workflowExtensionId")) {
    throw new CccCampaignExecutionPolicyError(
      `CCC campaign execution route ${index} workflowExtensionId is forbidden for ${transport} transport`,
    );
  }
  if (isWorkflowTransport) {
    exactWorkflowExtensionRegistryId(route.workflowExtensionId, index);
  }
  exactKeys(
    route,
    isWorkflowTransport
      ? WORKFLOW_ROUTE_KEYS
      : hasTerminalRouteMembers
        ? ROUTE_COMBO_RECEIPT_KEYS
      : hasReceiptAdapter
        ? ROUTE_RECEIPT_KEYS
        : ROUTE_KEYS,
    `CCC campaign execution route ${index}`,
  );
  const workflowExtensionId = isWorkflowTransport ? route.workflowExtensionId as string : undefined;
  const receiptAdapterId = hasReceiptAdapter
    ? exactEnum(
      route.receiptAdapterId,
      RECEIPT_ADAPTER_IDS,
      `CCC campaign execution route ${index} unsupported receipt adapter`,
    )
    : undefined;
  const modelId = exactIdentifier(route.modelId, `CCC campaign execution route ${index} modelId`);
  assertReceiptAdapterModelIdentity(
    modelId,
    receiptAdapterId,
    `CCC campaign execution route ${index}`,
  );
  const terminalRouteMembers = parseTerminalRouteMembers(
    route.terminalRouteMembers,
    hasTerminalRouteMembers,
    modelId,
    receiptAdapterId,
    `CCC campaign execution route ${index}`,
  );
  return {
    taskId: exactIdentifier(route.taskId, `CCC campaign execution route ${index} taskId`),
    providerId: exactIdentifier(
      route.providerId,
      `CCC campaign execution route ${index} providerId`,
    ),
    modelId,
    transport: transport as CccCampaignTransport,
    ...(workflowExtensionId ? { workflowExtensionId } : {}),
    ...(receiptAdapterId ? { receiptAdapterId } : {}),
    ...(terminalRouteMembers ? { terminalRouteMembers } : {}),
  };
}

function exactTargetRelativePaths(
  value: unknown,
  index: number,
  field: "ownedPaths" | "allowedWriteRoots",
): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new CccCampaignExecutionPolicyError(
      `CCC campaign execution route ${index} ${field} must be a non-empty array of canonical target-relative paths`,
    );
  }
  const paths = value.map((candidate, pathIndex) => {
    if (
      typeof candidate !== "string"
      || candidate.length === 0
      || candidate !== candidate.trim()
      || candidate.includes("\\")
      || candidate.includes("\0")
      || isAbsolute(candidate)
      || candidate === "."
      || candidate.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
    ) {
      throw new CccCampaignExecutionPolicyError(
        `CCC campaign execution route ${index} ${field}[${pathIndex}] must be a canonical target-relative path`,
      );
    }
    if (candidate === ".fusion" || candidate.startsWith(".fusion/")) {
      throw new CccCampaignExecutionPolicyError(
        `CCC campaign execution route ${index} ${field}[${pathIndex}] targets a reserved controller path`,
      );
    }
    return candidate;
  });
  if (new Set(paths).size !== paths.length) {
    throw new CccCampaignExecutionPolicyError(
      `CCC campaign execution route ${index} ${field} must not contain duplicates`,
    );
  }
  return paths;
}

function pathContains(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}/`);
}

function filesystemPathContains(parent: string, child: string): boolean {
  const descendant = relative(parent, child);
  return descendant === ""
    || (descendant !== ".." && !descendant.startsWith(`..${sep}`) && !isAbsolute(descendant));
}

function parseProductRoute(
  value: unknown,
  index: number,
  bundle: Pick<CccPrdSemanticBundle, "admittedWriteRoots" | "targetRepository">,
): CccCampaignProductExecutionRoute {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CccCampaignExecutionPolicyError(
      `CCC campaign execution route ${index} must be an object`,
    );
  }
  const route = value as Record<string, unknown>;
  const transport = exactIdentifier(
    route.transport,
    `CCC campaign execution route ${index} transport`,
  );
  if (transport !== "pi" && transport !== "cli") {
    throw new CccCampaignExecutionPolicyError(
      `CCC campaign execution route ${index} product transport must be pi or cli`,
    );
  }
  const hasReceiptAdapter = Object.prototype.hasOwnProperty.call(route, "receiptAdapterId");
  const hasTerminalRouteMembers = Object.prototype.hasOwnProperty.call(route, "terminalRouteMembers");
  if (hasReceiptAdapter && transport !== "pi") {
    throw new CccCampaignExecutionPolicyError(
      `CCC campaign execution route ${index} receiptAdapterId is forbidden for ${transport} transport`,
    );
  }
  exactKeys(
    route,
    transport === "cli"
      ? PRODUCT_CLI_ROUTE_KEYS
      : hasTerminalRouteMembers
        ? PRODUCT_ROUTE_COMBO_RECEIPT_KEYS
      : hasReceiptAdapter
        ? PRODUCT_ROUTE_RECEIPT_KEYS
        : PRODUCT_ROUTE_KEYS,
    `CCC campaign execution route ${index}`,
  );
  const executor = exactIdentifier(
    route.executor,
    `CCC campaign execution route ${index} executor`,
  );
  if (transport === "pi" && executor !== "model") {
    throw new CccCampaignExecutionPolicyError(
      `CCC campaign execution route ${index} pi transport requires executor model`,
    );
  }
  if (transport === "cli" && executor !== "cli-agent") {
    throw new CccCampaignExecutionPolicyError(
      `CCC campaign execution route ${index} cli transport requires executor cli-agent`,
    );
  }
  if (route.toolMode !== "coding") {
    throw new CccCampaignExecutionPolicyError(
      `CCC campaign execution route ${index} toolMode must be coding`,
    );
  }
  if (route.worktreeMode !== "isolated") {
    throw new CccCampaignExecutionPolicyError(
      `CCC campaign execution route ${index} worktreeMode must be isolated`,
    );
  }
  if (route.commitPolicy !== "required") {
    throw new CccCampaignExecutionPolicyError(
      `CCC campaign execution route ${index} commitPolicy must be required`,
    );
  }
  const ownedPaths = exactTargetRelativePaths(route.ownedPaths, index, "ownedPaths");
  const allowedWriteRoots = exactTargetRelativePaths(
    route.allowedWriteRoots,
    index,
    "allowedWriteRoots",
  );
  const receiptAdapterId = hasReceiptAdapter
    ? exactEnum(
      route.receiptAdapterId,
      RECEIPT_ADAPTER_IDS,
      `CCC campaign execution route ${index} unsupported receipt adapter`,
    )
    : undefined;
  const modelId = exactIdentifier(route.modelId, `CCC campaign execution route ${index} modelId`);
  assertReceiptAdapterModelIdentity(
    modelId,
    receiptAdapterId,
    `CCC campaign execution route ${index}`,
  );
  const terminalRouteMembers = parseTerminalRouteMembers(
    route.terminalRouteMembers,
    hasTerminalRouteMembers,
    modelId,
    receiptAdapterId,
    `CCC campaign execution route ${index}`,
  );
  for (const allowedRoot of allowedWriteRoots) {
    if (!ownedPaths.some((ownedPath) => pathContains(ownedPath, allowedRoot))) {
      throw new CccCampaignExecutionPolicyError(
        `CCC campaign execution route ${index} allowedWriteRoots path ${JSON.stringify(allowedRoot)} is outside task ownership`,
      );
    }
    const absoluteAllowedRoot = resolve(bundle.targetRepository.path, allowedRoot);
    if (
      !bundle.admittedWriteRoots.some(({ path }) =>
        filesystemPathContains(resolve(path), absoluteAllowedRoot))
    ) {
      throw new CccCampaignExecutionPolicyError(
        `CCC campaign execution route ${index} allowedWriteRoots path ${JSON.stringify(allowedRoot)} is outside PRD-admitted write roots`,
      );
    }
  }
  return {
    taskId: exactIdentifier(route.taskId, `CCC campaign execution route ${index} taskId`),
    providerId: exactIdentifier(
      route.providerId,
      `CCC campaign execution route ${index} providerId`,
    ),
    modelId,
    transport,
    executor: executor as CccCampaignProductExecutionRoute["executor"],
    toolMode: "coding",
    worktreeMode: "isolated",
    ownedPaths,
    allowedWriteRoots,
    commitPolicy: "required",
    ...(transport === "cli"
      ? {
        cliAdapterId: exactIdentifier(
          route.cliAdapterId,
          `CCC campaign execution route ${index} cliAdapterId`,
        ),
      }
      : {}),
    ...(receiptAdapterId ? { receiptAdapterId } : {}),
    ...(terminalRouteMembers ? { terminalRouteMembers } : {}),
  };
}

function exactEnum<T extends string>(value: unknown, allowed: ReadonlySet<T>, label: string): T {
  if (typeof value !== "string" || !allowed.has(value as T)) {
    throw new CccCampaignExecutionPolicyError(
      `${label} must be one of ${[...allowed].join(", ")}`,
    );
  }
  return value as T;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new CccCampaignExecutionPolicyError(`${label} must be a positive integer`);
  }
  return value;
}

/**
 * v3-only counterpart of exactTargetRelativePaths that labels errors with
 * the owning taskId instead of just the array index, kept separate from the
 * v2 helper so v2 error text (and the tests pinning it) never changes.
 */
function exactTargetRelativePathsV3(
  value: unknown,
  label: string,
  field: "ownedPaths" | "allowedWriteRoots",
): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new CccCampaignExecutionPolicyError(
      `${label} ${field} must be a non-empty array of canonical target-relative paths`,
    );
  }
  const paths = value.map((candidate, pathIndex) => {
    if (
      typeof candidate !== "string"
      || candidate.length === 0
      || candidate !== candidate.trim()
      || candidate.includes("\\")
      || candidate.includes("\0")
      || isAbsolute(candidate)
      || candidate === "."
      || candidate.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
    ) {
      throw new CccCampaignExecutionPolicyError(
        `${label} ${field}[${pathIndex}] must be a canonical target-relative path`,
      );
    }
    if (candidate === ".fusion" || candidate.startsWith(".fusion/")) {
      throw new CccCampaignExecutionPolicyError(
        `${label} ${field}[${pathIndex}] targets a reserved controller path`,
      );
    }
    return candidate;
  });
  if (new Set(paths).size !== paths.length) {
    throw new CccCampaignExecutionPolicyError(`${label} ${field} must not contain duplicates`);
  }
  return paths;
}

function assertAllowedWriteRootsWithinCustodyV3(
  ownedPaths: string[],
  allowedWriteRoots: string[],
  label: string,
  bundle: Pick<CccPrdSemanticBundle, "admittedWriteRoots" | "targetRepository">,
): void {
  for (const allowedRoot of allowedWriteRoots) {
    if (!ownedPaths.some((ownedPath) => pathContains(ownedPath, allowedRoot))) {
      throw new CccCampaignExecutionPolicyError(
        `${label} allowedWriteRoots path ${JSON.stringify(allowedRoot)} is outside task ownership`,
      );
    }
    const absoluteAllowedRoot = resolve(bundle.targetRepository.path, allowedRoot);
    if (
      !bundle.admittedWriteRoots.some(({ path }) =>
        filesystemPathContains(resolve(path), absoluteAllowedRoot))
    ) {
      throw new CccCampaignExecutionPolicyError(
        `${label} allowedWriteRoots path ${JSON.stringify(allowedRoot)} is outside PRD-admitted write roots`,
      );
    }
  }
}

function parseEgressPolicy(value: unknown, label: string): CccCampaignRouteEgressPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CccCampaignExecutionPolicyError(`${label} egressPolicy must be an object`);
  }
  const policy = value as Record<string, unknown>;
  if (policy.kind === "loopback-only") {
    exactKeys(policy, EGRESS_POLICY_LOOPBACK_KEYS, `${label} egressPolicy`);
    return { kind: "loopback-only" };
  }
  if (policy.kind === "allowlisted") {
    exactKeys(policy, EGRESS_POLICY_ALLOWLISTED_KEYS, `${label} egressPolicy`);
    if (!Array.isArray(policy.providers) || policy.providers.length === 0) {
      throw new CccCampaignExecutionPolicyError(
        `${label} egressPolicy.providers must be a non-empty array`,
      );
    }
    const providers = policy.providers.map((provider, providerIndex) =>
      exactIdentifier(provider, `${label} egressPolicy.providers[${providerIndex}]`));
    if (new Set(providers).size !== providers.length) {
      throw new CccCampaignExecutionPolicyError(
        `${label} egressPolicy.providers must not contain duplicates`,
      );
    }
    return { kind: "allowlisted", providers };
  }
  throw new CccCampaignExecutionPolicyError(
    `${label} egressPolicy.kind must be loopback-only or allowlisted`,
  );
}

function parseLimits(
  value: unknown,
  label: string,
  transport: "pi" | "cli",
): CccCampaignRouteLimits {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CccCampaignExecutionPolicyError(`${label} limits must be an object`);
  }
  const limits = value as Record<string, unknown>;
  const observed = Object.keys(limits).sort(compareCccPrdCodeUnits);
  const unknownKeys = observed.filter((key) => !(LIMITS_ALL_KEYS as readonly string[]).includes(key));
  if (unknownKeys.length > 0) {
    throw new CccCampaignExecutionPolicyError(
      `${label} limits fields must be a subset of ${LIMITS_ALL_KEYS.join(", ")}; received unexpected ${unknownKeys.join(", ")}`,
    );
  }
  const missing = LIMITS_REQUIRED_KEYS.filter((key) => !(key in limits));
  if (missing.length > 0) {
    throw new CccCampaignExecutionPolicyError(
      `${label} limits missing required fields ${missing.join(", ")}`,
    );
  }
  if (transport === "cli" && "maxSpendUsd" in limits) {
    throw new CccCampaignExecutionPolicyError(
      `${label} limits.maxSpendUsd is forbidden for cli transport (receipt-incapable); enforceable caps are maxRequests, maxDurationMs, maxConcurrency`,
    );
  }
  return {
    maxRequests: positiveInteger(limits.maxRequests, `${label} limits.maxRequests`),
    maxDurationMs: positiveInteger(limits.maxDurationMs, `${label} limits.maxDurationMs`),
    maxConcurrency: positiveInteger(limits.maxConcurrency, `${label} limits.maxConcurrency`),
    ...("maxResponseTokens" in limits
      ? { maxResponseTokens: positiveInteger(limits.maxResponseTokens, `${label} limits.maxResponseTokens`) }
      : {}),
    ...("maxSpendUsd" in limits
      ? { maxSpendUsd: positiveInteger(limits.maxSpendUsd, `${label} limits.maxSpendUsd`) }
      : {}),
  };
}

function parseFallbackPolicy(value: unknown, label: string): CccCampaignRouteFallbackPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CccCampaignExecutionPolicyError(`${label} fallbackPolicy must be an object`);
  }
  const policy = value as Record<string, unknown>;
  if (policy.kind === "ordered") {
    throw new CccCampaignExecutionPolicyError(
      `${label} fallbackPolicy kind "ordered" is not yet supported`,
    );
  }
  if (policy.kind !== "forbidden") {
    throw new CccCampaignExecutionPolicyError(`${label} fallbackPolicy.kind must be forbidden`);
  }
  exactKeys(policy, FALLBACK_POLICY_KEYS, `${label} fallbackPolicy`);
  return { kind: "forbidden" };
}

function parseCatalogDigest(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new CccCampaignExecutionPolicyError(
      `${label} catalogDigest must be null or a lowercase SHA-256 hash`,
    );
  }
  return value;
}

function parseDecidedAt(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new CccCampaignExecutionPolicyError(`${label} decidedAt must be a canonical ISO timestamp`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new CccCampaignExecutionPolicyError(`${label} decidedAt must be a canonical ISO timestamp`);
  }
  return value;
}

function parseProductRouteV3(
  value: unknown,
  index: number,
  bundle: Pick<CccPrdSemanticBundle, "admittedWriteRoots" | "targetRepository">,
): CccCampaignProductExecutionRouteV3 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CccCampaignExecutionPolicyError(
      `CCC campaign execution route ${index} must be an object`,
    );
  }
  const route = value as Record<string, unknown>;
  const taskId = exactIdentifier(route.taskId, `CCC campaign execution route ${index} taskId`);
  const label = `CCC campaign execution route ${index} (task ${taskId})`;
  const transport = exactIdentifier(route.transport, `${label} transport`);
  if (transport !== "pi" && transport !== "cli") {
    throw new CccCampaignExecutionPolicyError(`${label} product transport must be pi or cli`);
  }
  const hasReceiptAdapter = Object.prototype.hasOwnProperty.call(route, "receiptAdapterId");
  const hasTerminalRouteMembers = Object.prototype.hasOwnProperty.call(route, "terminalRouteMembers");
  if (hasReceiptAdapter && transport !== "pi") {
    throw new CccCampaignExecutionPolicyError(`${label} receiptAdapterId is forbidden for ${transport} transport`);
  }
  exactKeys(
    route,
    transport === "cli"
      ? PRODUCT_CLI_ROUTE_V3_KEYS
      : hasTerminalRouteMembers
        ? PRODUCT_ROUTE_COMBO_RECEIPT_V3_KEYS
      : hasReceiptAdapter
        ? PRODUCT_ROUTE_RECEIPT_V3_KEYS
        : PRODUCT_ROUTE_V3_KEYS,
    label,
  );
  const executor = exactIdentifier(route.executor, `${label} executor`);
  if (transport === "pi" && executor !== "model") {
    throw new CccCampaignExecutionPolicyError(`${label} pi transport requires executor model`);
  }
  if (transport === "cli" && executor !== "cli-agent") {
    throw new CccCampaignExecutionPolicyError(`${label} cli transport requires executor cli-agent`);
  }
  if (route.toolMode !== "coding") {
    throw new CccCampaignExecutionPolicyError(`${label} toolMode must be coding`);
  }
  if (route.worktreeMode !== "isolated") {
    throw new CccCampaignExecutionPolicyError(`${label} worktreeMode must be isolated`);
  }
  if (route.commitPolicy !== "required") {
    throw new CccCampaignExecutionPolicyError(`${label} commitPolicy must be required`);
  }
  const ownedPaths = exactTargetRelativePathsV3(route.ownedPaths, label, "ownedPaths");
  const allowedWriteRoots = exactTargetRelativePathsV3(route.allowedWriteRoots, label, "allowedWriteRoots");
  assertAllowedWriteRootsWithinCustodyV3(ownedPaths, allowedWriteRoots, label, bundle);
  const routeProfileId = exactIdentifier(route.routeProfileId, `${label} routeProfileId`);
  const taskArchetype = exactIdentifier(route.taskArchetype, `${label} taskArchetype`);
  const reasoningEffort = exactEnum(route.reasoningEffort, REASONING_EFFORTS, `${label} reasoningEffort`);
  const serviceTier = exactEnum(route.serviceTier, SERVICE_TIERS, `${label} serviceTier`);
  const accessTier = exactEnum(route.accessTier, ACCESS_TIERS, `${label} accessTier`);
  const sensitivityClass = exactEnum(route.sensitivityClass, SENSITIVITY_CLASSES, `${label} sensitivityClass`);
  const egressPolicy = parseEgressPolicy(route.egressPolicy, label);
  const limits = parseLimits(route.limits, label, transport);
  const fallbackPolicy = parseFallbackPolicy(route.fallbackPolicy, label);
  const catalogDigest = parseCatalogDigest(route.catalogDigest, label);
  const decidedAt = parseDecidedAt(route.decidedAt, label);
  const receiptAdapterId = hasReceiptAdapter
    ? exactEnum(route.receiptAdapterId, RECEIPT_ADAPTER_IDS, `${label} unsupported receipt adapter`)
    : undefined;
  const modelId = exactIdentifier(route.modelId, `${label} modelId`);
  assertReceiptAdapterModelIdentity(modelId, receiptAdapterId, label);
  const terminalRouteMembers = parseTerminalRouteMembers(
    route.terminalRouteMembers,
    hasTerminalRouteMembers,
    modelId,
    receiptAdapterId,
    label,
  );
  return {
    taskId,
    providerId: exactIdentifier(route.providerId, `${label} providerId`),
    modelId,
    transport,
    executor: executor as CccCampaignProductExecutionRouteV3["executor"],
    toolMode: "coding",
    worktreeMode: "isolated",
    ownedPaths,
    allowedWriteRoots,
    commitPolicy: "required",
    routeProfileId,
    taskArchetype,
    reasoningEffort,
    serviceTier,
    accessTier,
    sensitivityClass,
    egressPolicy,
    limits,
    fallbackPolicy,
    catalogDigest,
    decidedAt,
    ...(transport === "cli"
      ? {
        cliAdapterId: exactIdentifier(route.cliAdapterId, `${label} cliAdapterId`),
      }
      : {}),
    ...(receiptAdapterId ? { receiptAdapterId } : {}),
    ...(terminalRouteMembers ? { terminalRouteMembers } : {}),
  };
}

function exactWorkflowExtensionRegistryId(value: unknown, index: number): string {
  if (typeof value !== "string" || value !== value.trim() || !WORKFLOW_EXTENSION_REGISTRY_ID_PATTERN.test(value)) {
    throw new CccCampaignExecutionPolicyError(
      `CCC campaign execution route ${index} workflowExtensionId must be a non-empty canonical registry ID`,
    );
  }
  return value;
}

function assertCompleteRouteSet(
  routes: CccCampaignExecutionRoute[],
  bundle: Pick<CccPrdSemanticBundle, "tasks">,
): void {
  const routeIds = routes.map(({ taskId }) => taskId);
  const duplicateIds = routeIds.filter((id, index) => routeIds.indexOf(id) !== index);
  const expectedIds = bundle.tasks.map(({ id }) => id).sort(compareCccPrdCodeUnits);
  const observedIds = [...new Set(routeIds)].sort(compareCccPrdCodeUnits);
  const missing = expectedIds.filter((id) => !observedIds.includes(id));
  const extra = observedIds.filter((id) => !expectedIds.includes(id));
  if (
    duplicateIds.length > 0
    || missing.length > 0
    || extra.length > 0
    || routes.length !== expectedIds.length
  ) {
    throw new CccCampaignExecutionPolicyError(
      `CCC campaign routes must bind every task exactly once; missing=${missing.join(",") || "none"}; extra=${extra.join(",") || "none"}; duplicate=${[...new Set(duplicateIds)].sort(compareCccPrdCodeUnits).join(",") || "none"}`,
    );
  }
}

function taskDependsOn(
  taskId: string,
  dependencyId: string,
  tasks: ReadonlyMap<string, Pick<CccPrdSemanticBundle["tasks"][number], "dependencyTaskIds">>,
  visited = new Set<string>(),
): boolean {
  if (taskId === dependencyId) return true;
  if (visited.has(taskId)) return false;
  visited.add(taskId);
  const task = tasks.get(taskId);
  if (!task) return false;
  return task.dependencyTaskIds.some((candidate) =>
    candidate === dependencyId || taskDependsOn(candidate, dependencyId, tasks, visited));
}

function assertConcurrentOwnershipDoesNotOverlap(
  routes: CccCampaignProductExecutionRoute[],
  bundle: Pick<CccPrdSemanticBundle, "tasks">,
): void {
  const tasks = new Map(bundle.tasks.map((task) => [task.id, task]));
  for (let leftIndex = 0; leftIndex < routes.length; leftIndex += 1) {
    const left = routes[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < routes.length; rightIndex += 1) {
      const right = routes[rightIndex]!;
      if (
        taskDependsOn(left.taskId, right.taskId, tasks)
        || taskDependsOn(right.taskId, left.taskId, tasks)
      ) {
        continue;
      }
      const overlap = left.ownedPaths.find((leftPath) =>
        right.ownedPaths.some((rightPath) =>
          pathContains(leftPath, rightPath) || pathContains(rightPath, leftPath)));
      if (overlap) {
        throw new CccCampaignExecutionPolicyError(
          `CCC campaign concurrently runnable tasks ${left.taskId} and ${right.taskId} have overlapping ownership at ${overlap}`,
        );
      }
    }
  }
}

type CccCampaignExecutionPolicyBundle = Pick<CccPrdSemanticBundle, "tasks">
  & Partial<Pick<CccPrdSemanticBundle, "admittedWriteRoots" | "targetRepository">>;

export function parseCccCampaignExecutionPolicy(
  value: unknown,
  bundle: CccCampaignExecutionPolicyBundle,
): CccCampaignExecutionPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CccCampaignExecutionPolicyError(
      "CCC PRD import requires a versioned execution policy",
    );
  }
  const policy = value as Record<string, unknown>;
  exactKeys(policy, POLICY_KEYS, "CCC campaign execution policy");
  if (
    policy.schema !== CCC_CAMPAIGN_EXECUTION_POLICY_SCHEMA_VERSION
    && policy.schema !== CCC_CAMPAIGN_EXECUTION_POLICY_V2_SCHEMA_VERSION
  ) {
    throw new CccCampaignExecutionPolicyError(
      `CCC campaign execution policy schema must be ${CCC_CAMPAIGN_EXECUTION_POLICY_SCHEMA_VERSION} or ${CCC_CAMPAIGN_EXECUTION_POLICY_V2_SCHEMA_VERSION}`,
    );
  }
  if (!Array.isArray(policy.routes)) {
    throw new CccCampaignExecutionPolicyError(
      "CCC campaign execution policy routes must be an array",
    );
  }
  if (policy.schema === CCC_CAMPAIGN_EXECUTION_POLICY_V2_SCHEMA_VERSION) {
    if (!bundle.admittedWriteRoots || !bundle.targetRepository) {
      throw new CccCampaignExecutionPolicyError(
        "CCC campaign execution-policy v2 requires target repository and admitted write roots",
      );
    }
    return parseCccCampaignProductExecutionPolicy(policy, {
      tasks: bundle.tasks,
      admittedWriteRoots: bundle.admittedWriteRoots,
      targetRepository: bundle.targetRepository,
    });
  }
  const routes = policy.routes.map(parseRoute);
  assertCompleteRouteSet(routes, bundle);
  return {
    schema: CCC_CAMPAIGN_EXECUTION_POLICY_SCHEMA_VERSION,
    routes: routes.sort((left, right) => compareCccPrdCodeUnits(left.taskId, right.taskId)),
  };
}

export function parseCccCampaignProductExecutionPolicy(
  value: unknown,
  bundle: Pick<
    CccPrdSemanticBundle,
    "tasks" | "admittedWriteRoots" | "targetRepository"
  >,
): CccCampaignProductExecutionPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CccCampaignExecutionPolicyError(
      "CCC PRD product import requires a versioned execution policy",
    );
  }
  const policy = value as Record<string, unknown>;
  exactKeys(policy, POLICY_KEYS, "CCC campaign execution policy");
  if (policy.schema !== CCC_CAMPAIGN_EXECUTION_POLICY_V2_SCHEMA_VERSION) {
    throw new CccCampaignExecutionPolicyError(
      `CCC PRD product import requires ${CCC_CAMPAIGN_EXECUTION_POLICY_V2_SCHEMA_VERSION}`,
    );
  }
  if (!Array.isArray(policy.routes)) {
    throw new CccCampaignExecutionPolicyError(
      "CCC campaign execution policy routes must be an array",
    );
  }
  const routes = policy.routes.map((route, index) => parseProductRoute(route, index, bundle));
  assertCompleteRouteSet(routes, bundle);
  assertConcurrentOwnershipDoesNotOverlap(routes, bundle);
  return {
    schema: CCC_CAMPAIGN_EXECUTION_POLICY_V2_SCHEMA_VERSION,
    routes: routes.sort((left, right) => compareCccPrdCodeUnits(left.taskId, right.taskId)),
  };
}

/**
 * Routing-contract v3 parser. A distinct entry point from the v2 parser: a
 * v2 policy object is refused here (no automatic v2->v3 backfill), and a v3
 * policy object is refused by the v2 parser (unknown schema). Callers must
 * pick their schema version explicitly.
 */
export function parseCccCampaignProductExecutionPolicyV3(
  value: unknown,
  bundle: Pick<
    CccPrdSemanticBundle,
    "tasks" | "admittedWriteRoots" | "targetRepository"
  >,
): CccCampaignProductExecutionPolicyV3 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CccCampaignExecutionPolicyError(
      "CCC PRD product import requires a versioned execution policy",
    );
  }
  const policy = value as Record<string, unknown>;
  exactKeys(policy, POLICY_KEYS, "CCC campaign execution policy");
  if (policy.schema !== CCC_CAMPAIGN_EXECUTION_POLICY_V3_SCHEMA_VERSION) {
    throw new CccCampaignExecutionPolicyError(
      `CCC PRD product import requires ${CCC_CAMPAIGN_EXECUTION_POLICY_V3_SCHEMA_VERSION}; upgrade the policy schema explicitly before importing (no automatic v2-to-v3 backfill is performed)`,
    );
  }
  if (!Array.isArray(policy.routes)) {
    throw new CccCampaignExecutionPolicyError(
      "CCC campaign execution policy routes must be an array",
    );
  }
  const routes = policy.routes.map((route, index) => parseProductRouteV3(route, index, bundle));
  assertCompleteRouteSet(routes, bundle);
  assertConcurrentOwnershipDoesNotOverlap(routes, bundle);
  return {
    schema: CCC_CAMPAIGN_EXECUTION_POLICY_V3_SCHEMA_VERSION,
    routes: routes.sort((left, right) => compareCccPrdCodeUnits(left.taskId, right.taskId)),
  };
}

export function createCccPrdProductExecutionPlan(input: {
  bundle: CccPrdSemanticBundle;
  route?: CccPrdProductExecutionRouteSelection;
  routesByTaskId?: Record<string, CccPrdProductExecutionRouteSelection>;
}): CccPrdProductExecutionPlan {
  if (input.route && input.routesByTaskId) {
    throw new CccCampaignExecutionPolicyError(
      "CCC PRD product execution plan accepts exactly one of route or routesByTaskId",
    );
  }
  let routeSelectionForTask: (taskId: string) => CccPrdProductExecutionRouteSelection;
  if (input.routesByTaskId) {
    const routesByTaskId = input.routesByTaskId;
    const expectedIds = input.bundle.tasks.map(({ id }) => id).sort(compareCccPrdCodeUnits);
    const observedIds = Object.keys(routesByTaskId).sort(compareCccPrdCodeUnits);
    const missing = expectedIds.filter((id) => !observedIds.includes(id));
    const extra = observedIds.filter((id) => !expectedIds.includes(id));
    if (missing.length > 0 || extra.length > 0) {
      throw new CccCampaignExecutionPolicyError(
        `CCC PRD product execution plan routesByTaskId must bind every task exactly once; missing=${missing.join(",") || "none"}; extra=${extra.join(",") || "none"}`,
      );
    }
    routeSelectionForTask = (taskId) => routesByTaskId[taskId]!;
  } else if (input.route) {
    const route = input.route;
    routeSelectionForTask = () => route;
  } else {
    throw new CccCampaignExecutionPolicyError(
      "CCC PRD product execution plan requires route or routesByTaskId",
    );
  }
  const routes = input.bundle.tasks.map((task) => {
    if (!Array.isArray(task.ownedPaths) || task.ownedPaths.length === 0) {
      throw new CccCampaignExecutionPolicyError(
        "CCC PRD task " + task.id + " has no source-owned paths for product policy generation",
      );
    }
    if (!Array.isArray(task.allowedWriteRoots) || task.allowedWriteRoots.length === 0) {
      throw new CccCampaignExecutionPolicyError(
        "CCC PRD task " + task.id + " has no allowed write roots for product policy generation",
      );
    }
    const selection = routeSelectionForTask(task.id);
    if (
      selection.receiptAdapterId !== undefined
      && !RECEIPT_ADAPTER_IDS.has(selection.receiptAdapterId)
    ) {
      throw new CccCampaignExecutionPolicyError(
        `CCC PRD task ${task.id} has unsupported receipt adapter ${JSON.stringify(selection.receiptAdapterId)}`,
      );
    }
    if (selection.transport === "cli" && selection.receiptAdapterId !== undefined) {
      throw new CccCampaignExecutionPolicyError(
        `CCC PRD task ${task.id} receiptAdapterId is forbidden for cli transport`,
      );
    }
    if (selection.transport === "cli" && selection.terminalRouteMembers !== undefined) {
      throw new CccCampaignExecutionPolicyError(
        `CCC PRD task ${task.id} terminalRouteMembers is forbidden for cli transport`,
      );
    }
    assertReceiptAdapterModelIdentity(
      selection.modelId,
      selection.receiptAdapterId,
      `CCC PRD task ${task.id}`,
    );
    const terminalRouteMembers = parseTerminalRouteMembers(
      selection.terminalRouteMembers,
      selection.terminalRouteMembers !== undefined,
      selection.modelId,
      selection.receiptAdapterId,
      `CCC PRD task ${task.id}`,
    );
    return {
      taskId: task.id,
      providerId: selection.providerId,
      modelId: selection.modelId,
      transport: selection.transport,
      executor: selection.transport === "cli" ? "cli-agent" as const : "model" as const,
      toolMode: "coding" as const,
      worktreeMode: "isolated" as const,
      ownedPaths: [...task.ownedPaths],
      allowedWriteRoots: [...task.allowedWriteRoots],
      commitPolicy: "required" as const,
      ...(selection.transport === "cli"
        ? { cliAdapterId: selection.cliAdapterId }
        : {}),
      ...(selection.transport === "pi" && selection.receiptAdapterId
        ? { receiptAdapterId: selection.receiptAdapterId }
        : {}),
      ...(terminalRouteMembers ? { terminalRouteMembers } : {}),
    };
  });
  const policy = parseCccCampaignProductExecutionPolicy({
    schema: CCC_CAMPAIGN_EXECUTION_POLICY_V2_SCHEMA_VERSION,
    routes,
  }, input.bundle);
  return {
    schema: CCC_PRD_EXECUTION_PLAN_SCHEMA_VERSION,
    packetHash: input.bundle.sourceHash,
    sidecarHash: input.bundle.sidecarHash,
    bundleHash: input.bundle.bundleHash,
    policy,
  };
}

function executionPlanHash(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new CccCampaignExecutionPolicyError(
      "CCC PRD execution plan " + label + " must be a lowercase SHA-256 hash",
    );
  }
  return value;
}

export function parseCccPrdProductExecutionPlan(
  value: unknown,
  bundle: CccPrdSemanticBundle,
): CccPrdProductExecutionPlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CccCampaignExecutionPolicyError(
      "CCC PRD product import requires a versioned execution plan",
    );
  }
  const plan = value as Record<string, unknown>;
  exactKeys(plan, EXECUTION_PLAN_KEYS, "CCC PRD execution plan");
  if (plan.schema !== CCC_PRD_EXECUTION_PLAN_SCHEMA_VERSION) {
    throw new CccCampaignExecutionPolicyError(
      "CCC PRD product import requires " + CCC_PRD_EXECUTION_PLAN_SCHEMA_VERSION,
    );
  }
  const packetHash = executionPlanHash(plan.packetHash, "packet hash");
  const sidecarHash = executionPlanHash(plan.sidecarHash, "sidecar hash");
  const bundleHash = executionPlanHash(plan.bundleHash, "bundle hash");
  if (packetHash !== bundle.sourceHash) {
    throw new CccCampaignExecutionPolicyError(
      "CCC PRD execution plan packet hash does not match the compiled bundle",
    );
  }
  if (sidecarHash !== bundle.sidecarHash) {
    throw new CccCampaignExecutionPolicyError(
      "CCC PRD execution plan sidecar hash does not match the compiled bundle",
    );
  }
  if (bundleHash !== bundle.bundleHash) {
    throw new CccCampaignExecutionPolicyError(
      "CCC PRD execution plan bundle hash does not match the compiled bundle",
    );
  }
  return {
    schema: CCC_PRD_EXECUTION_PLAN_SCHEMA_VERSION,
    packetHash,
    sidecarHash,
    bundleHash,
    policy: parseCccCampaignProductExecutionPolicy(plan.policy, bundle),
  };
}

type CccCampaignManifestCreationBase = {
  projectId: string;
  importId: string;
  idempotencyKey: string;
  campaignId: string;
  bundle: CccPrdSemanticBundle;
  executionPolicy: CccCampaignExecutionPolicy;
  targetRepositoryPath: string;
  campaignStartedAt: string;
};

export type CreateCccCampaignManifestInput = CccCampaignManifestCreationBase & (
  | Readonly<{
    manifestSchema?: typeof CCC_CAMPAIGN_MANIFEST_V1_SCHEMA_VERSION;
    executionAuthorizationMode?: never;
  }>
  | Readonly<{
    manifestSchema: typeof CCC_CAMPAIGN_MANIFEST_V2_SCHEMA_VERSION;
    executionAuthorizationMode:
      typeof CCC_CAMPAIGN_EXECUTION_AUTHORIZATION_MODE_SEALED_BUNDLE_V1;
  }>
);

export function executionAuthorizationModeFromManifest(
  manifest: CccCampaignManifest,
): CccCampaignExecutionAuthorizationMode {
  const record = manifest as CccCampaignManifest & Record<string, unknown>;
  if (manifest.schema === CCC_CAMPAIGN_MANIFEST_V1_SCHEMA_VERSION) {
    if (Object.prototype.hasOwnProperty.call(record, "executionAuthorizationMode")) {
      throw new CccCampaignExecutionPolicyError(
        "CCC campaign manifest v1 must not store executionAuthorizationMode",
      );
    }
    return CCC_CAMPAIGN_EXECUTION_AUTHORIZATION_MODE_PER_TASK_V1;
  }
  if (
    manifest.schema === CCC_CAMPAIGN_MANIFEST_V2_SCHEMA_VERSION
    && record.executionAuthorizationMode
      === CCC_CAMPAIGN_EXECUTION_AUTHORIZATION_MODE_SEALED_BUNDLE_V1
  ) {
    return CCC_CAMPAIGN_EXECUTION_AUTHORIZATION_MODE_SEALED_BUNDLE_V1;
  }
  throw new CccCampaignExecutionPolicyError(
    "CCC campaign manifest v2 requires executionAuthorizationMode sealed_bundle_v1",
  );
}

function copyPythonExecutionToolchain(
  python: CccPrdPythonExecutionToolchain,
): CccPrdPythonExecutionToolchain {
  const manifest = python.runtimeManifest;
  const copyFiles = (files: CccPrdPythonExecutionToolchain["runtimeManifest"]["stdlib"]) =>
    files.map((file) => ({
      ...file,
      ...(file.requestedPaths ? { requestedPaths: [...file.requestedPaths] } : {}),
    }));
  return {
    ...python,
    runtimeManifest: {
      ...manifest,
      interpreter: { ...manifest.interpreter },
      sitePackagesRoots: [...manifest.sitePackagesRoots],
      extensionModuleRoots: [...manifest.extensionModuleRoots],
      runtimeSupport: copyFiles(manifest.runtimeSupport),
      stdlib: copyFiles(manifest.stdlib),
      sitePackages: copyFiles(manifest.sitePackages),
      extensionModules: copyFiles(manifest.extensionModules),
      dylibClosure: copyFiles(manifest.dylibClosure),
    },
  };
}

/*
The manifest deep-copies every admitted proof so a caller cannot mutate campaign
custody through the bundle it handed in. That copy is also the object the engine
holds at proof-admission time, and `computeCccPrdProofDefinitionSha256` is
recomputed from it and compared against the pin frozen at compile. So any field
this copy fails to carry is not a cosmetic omission: it silently changes the
recomputed definition hash and halts a live campaign at
CCC_PROOF_ADMISSION_REFUSED, far from the code that dropped it. Every branch
below therefore spreads before it overrides, so an unmodelled field survives,
and the closing guard is the fail-closed backstop: if a later edit reintroduces
a field-by-field pick, the drift surfaces here rather than in a live campaign.
*/
function copyAdmittedCampaignProof(proof: CccPrdProof): CccPrdProof {
  const copied: CccPrdProof = proof.schema === "ccc-prd.proof.v2"
    ? {
      ...proof,
      requirementIds: [...proof.requirementIds],
      clauseIds: [...proof.clauseIds],
      phases: [...proof.phases],
      positiveCases: proof.positiveCases.map((proofCase) => ({ ...proofCase })),
      negativeControls: proof.negativeControls.map((control) => ({ ...control })),
      verifierClosure: proof.verifierClosure.map((entry) => ({ ...entry })),
      candidateInputs: [...proof.candidateInputs],
      executionToolchain: {
        ...proof.executionToolchain,
        task: { ...proof.executionToolchain.task },
        node: { ...proof.executionToolchain.node },
        proofHost: { ...proof.executionToolchain.proofHost },
        linkedRuntime: proof.executionToolchain.linkedRuntime.map((entry) => ({ ...entry })),
        ...(proof.executionToolchain.python
          ? { python: copyPythonExecutionToolchain(proof.executionToolchain.python) }
          : {}),
      },
      ...(proof.verifierProfile ? { verifierProfile: { ...proof.verifierProfile } } : {}),
      spans: proof.spans.map((span) => ({ ...span })),
      ...(proof.admission ? { admission: { ...proof.admission } } : {}),
    }
    : {
      ...proof,
      requirementIds: [...proof.requirementIds],
      negativeControls: [...proof.negativeControls],
      spans: proof.spans.map((span) => ({ ...span })),
      ...(proof.admission ? { admission: { ...proof.admission } } : {}),
    };
  if (canonicalCccPrdJson(copied) !== canonicalCccPrdJson(proof)) {
    throw new CccCampaignExecutionPolicyError(
      `CCC campaign proof ${String(proof.id)} manifest copy is not byte-identical to its admitted definition`,
    );
  }
  return copied;
}

export function createCccCampaignManifest(
  input: CreateCccCampaignManifestInput,
): CccCampaignManifest {
  const startedAt = Date.parse(input.campaignStartedAt);
  if (
    !Number.isFinite(startedAt)
    || new Date(startedAt).toISOString() !== input.campaignStartedAt
  ) {
    throw new CccCampaignExecutionPolicyError(
      "CCC campaign start must be a canonical ISO timestamp",
    );
  }
  const manifestSchema = input.manifestSchema
    ?? CCC_CAMPAIGN_MANIFEST_V1_SCHEMA_VERSION;
  if (
    manifestSchema !== CCC_CAMPAIGN_MANIFEST_V1_SCHEMA_VERSION
    && manifestSchema !== CCC_CAMPAIGN_MANIFEST_V2_SCHEMA_VERSION
  ) {
    throw new CccCampaignExecutionPolicyError(
      "CCC campaign manifest schema is unsupported",
    );
  }
  if (
    manifestSchema === CCC_CAMPAIGN_MANIFEST_V1_SCHEMA_VERSION
    && input.executionAuthorizationMode !== undefined
  ) {
    throw new CccCampaignExecutionPolicyError(
      "CCC campaign manifest v1 must not store executionAuthorizationMode",
    );
  }
  if (
    manifestSchema === CCC_CAMPAIGN_MANIFEST_V2_SCHEMA_VERSION
    && input.executionAuthorizationMode
      !== CCC_CAMPAIGN_EXECUTION_AUTHORIZATION_MODE_SEALED_BUNDLE_V1
  ) {
    throw new CccCampaignExecutionPolicyError(
      "CCC campaign manifest v2 requires executionAuthorizationMode sealed_bundle_v1",
    );
  }
  const manifestBase: CccCampaignManifestBase = {
    projectId: input.projectId,
    importId: input.importId,
    idempotencyKey: input.idempotencyKey,
    campaignId: input.campaignId,
    packetHash: input.bundle.sourceHash,
    sidecarHash: input.bundle.sidecarHash,
    bundleHash: input.bundle.bundleHash,
    sourceVersion: input.bundle.sourceVersion,
    targetRepository: {
      path: resolve(input.targetRepositoryPath),
      baseCommit: input.bundle.targetRepository.baseCommit,
    },
    bounds: { ...input.bundle.bounds },
    campaignStartedAt: input.campaignStartedAt,
    campaignDeadlineAt: new Date(
      startedAt + input.bundle.bounds.maxDurationMs,
    ).toISOString(),
    admittedWriteRoots: input.bundle.admittedWriteRoots.map((root) => ({ ...root })),
    proofs: input.bundle.proofs.map(copyAdmittedCampaignProof),
    protectedActions: input.bundle.protectedActions.map((action) => ({
      ...action,
      spans: action.spans.map((span) => ({ ...span })),
    })),
    executionPolicy: {
      schema: input.executionPolicy.schema,
      routes: input.executionPolicy.routes.map((route) => ({ ...route })),
    },
  };
  return manifestSchema === CCC_CAMPAIGN_MANIFEST_V2_SCHEMA_VERSION
    ? {
      schema: CCC_CAMPAIGN_MANIFEST_V2_SCHEMA_VERSION,
      ...manifestBase,
      executionAuthorizationMode:
        CCC_CAMPAIGN_EXECUTION_AUTHORIZATION_MODE_SEALED_BUNDLE_V1,
    }
    : {
      schema: CCC_CAMPAIGN_MANIFEST_V1_SCHEMA_VERSION,
      ...manifestBase,
    };
}

export function hashCccCampaignManifest(manifest: CccCampaignManifest): string {
  return createHash("sha256")
    .update(canonicalCccPrdJson(manifest), "utf8")
    .digest("hex");
}

function requireAuthorityText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new CccCampaignContextError(`${label} must be a non-empty canonical string`);
  }
  return value;
}

function requireAuthorityHash(value: unknown, label: string): string {
  const hash = requireAuthorityText(value, label);
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    throw new CccCampaignContextError(`${label} must be a lowercase SHA-256 hash`);
  }
  return hash;
}

function requireAuthorityTransport(value: unknown): CccCampaignTransport {
  if (typeof value !== "string" || !TRANSPORTS.has(value as CccCampaignTransport)) {
    throw new CccCampaignContextError("campaign route transport is invalid");
  }
  return value as CccCampaignTransport;
}

function requireAuthorityContext(
  context: CccCampaignContext,
): Omit<CccCampaignAuthorityBinding, "actionId" | "actionTarget" | "bindingHash"> {
  if (!context || typeof context !== "object") {
    throw new CccCampaignContextError("CCC campaign context is missing");
  }
  if (context.schema !== CCC_CAMPAIGN_CONTEXT_SCHEMA_VERSION) {
    throw new CccCampaignContextError("CCC campaign context schema is invalid");
  }
  if (!context.targetRepository || typeof context.targetRepository !== "object") {
    throw new CccCampaignContextError("CCC campaign context target repository is missing");
  }
  if (!context.route || typeof context.route !== "object") {
    throw new CccCampaignContextError("CCC campaign context execution route is missing");
  }
  const taskId = requireAuthorityText(context.taskId, "campaign taskId");
  const semanticTaskId = "semanticTaskId" in context
    ? requireAuthorityText(context.semanticTaskId, "campaign semanticTaskId")
    : taskId;
  const routeTaskId = requireAuthorityText(
    context.route.taskId,
    "campaign route taskId",
  );
  if (routeTaskId !== semanticTaskId) {
    throw new CccCampaignContextError(
      `CCC campaign route taskId ${routeTaskId} does not match campaign semanticTaskId ${semanticTaskId} (native taskId ${taskId})`,
    );
  }
  return {
    projectId: requireAuthorityText(context.projectId, "campaign projectId"),
    importId: requireAuthorityText(context.importId, "campaign importId"),
    campaignId: requireAuthorityText(context.campaignId, "campaign campaignId"),
    taskId,
    idempotencyKey: requireAuthorityText(
      context.idempotencyKey,
      "campaign idempotencyKey",
    ),
    packetHash: requireAuthorityHash(context.packetHash, "campaign packetHash"),
    sidecarHash: requireAuthorityHash(context.sidecarHash, "campaign sidecarHash"),
    bundleHash: requireAuthorityHash(context.bundleHash, "campaign bundleHash"),
    targetRepository: requireAuthorityText(
      context.targetRepository.path,
      "campaign targetRepository",
    ),
    targetBase: requireAuthorityText(
      context.targetRepository.baseCommit,
      "campaign targetBase",
    ),
    providerId: requireAuthorityText(context.route.providerId, "campaign providerId"),
    modelId: requireAuthorityText(context.route.modelId, "campaign modelId"),
    transport: requireAuthorityTransport(context.route.transport),
    manifestHash: requireAuthorityHash(context.manifestHash, "campaign manifestHash"),
  };
}

function protectedActionFor(
  context: CccCampaignContext,
  actionId: string,
): { id: string; target: string } | undefined {
  if (!Array.isArray(context.protectedActions)) {
    throw new CccCampaignContextError("CCC campaign protected actions are missing");
  }
  const matches = context.protectedActions.filter((action) => {
    if (!action || typeof action !== "object") {
      throw new CccCampaignContextError("CCC campaign protected action is invalid");
    }
    const id = requireAuthorityText(action.id, "campaign protected action id");
    requireAuthorityText(action.target, `campaign protected action ${id} target`);
    return id === actionId;
  });
  if (matches.length > 1) {
    throw new CccCampaignContextError(
      `CCC campaign protected action ${actionId} is declared more than once`,
    );
  }
  return matches[0];
}

export function assertCccCampaignAuthorityBinding(
  binding: CccCampaignAuthorityBinding,
): CccCampaignAuthorityBinding {
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
    throw new CccCampaignContextError("CCC campaign authority binding is missing");
  }
  const record = binding as Record<string, unknown>;
  const observedKeys = Object.keys(record).sort(compareCccPrdCodeUnits);
  const expectedKeys = [...AUTHORITY_BINDING_KEYS].sort(compareCccPrdCodeUnits);
  if (canonicalCccPrdJson(observedKeys) !== canonicalCccPrdJson(expectedKeys)) {
    throw new CccCampaignContextError(
      `CCC campaign authority binding fields must be exactly ${expectedKeys.join(", ")}`,
    );
  }
  const fields = {
    projectId: requireAuthorityText(record.projectId, "campaign binding projectId"),
    importId: requireAuthorityText(record.importId, "campaign binding importId"),
    campaignId: requireAuthorityText(record.campaignId, "campaign binding campaignId"),
    taskId: requireAuthorityText(record.taskId, "campaign binding taskId"),
    actionId: requireAuthorityText(record.actionId, "campaign binding actionId"),
    actionTarget: requireAuthorityText(record.actionTarget, "campaign binding actionTarget"),
    idempotencyKey: requireAuthorityText(
      record.idempotencyKey,
      "campaign binding idempotencyKey",
    ),
    packetHash: requireAuthorityHash(record.packetHash, "campaign binding packetHash"),
    sidecarHash: requireAuthorityHash(record.sidecarHash, "campaign binding sidecarHash"),
    bundleHash: requireAuthorityHash(record.bundleHash, "campaign binding bundleHash"),
    targetRepository: requireAuthorityText(
      record.targetRepository,
      "campaign binding targetRepository",
    ),
    targetBase: requireAuthorityText(record.targetBase, "campaign binding targetBase"),
    providerId: requireAuthorityText(record.providerId, "campaign binding providerId"),
    modelId: requireAuthorityText(record.modelId, "campaign binding modelId"),
    transport: requireAuthorityTransport(record.transport),
    manifestHash: requireAuthorityHash(record.manifestHash, "campaign binding manifestHash"),
  };
  const bindingHash = requireAuthorityHash(record.bindingHash, "campaign binding bindingHash");
  const expectedHash = createHash("sha256")
    .update(canonicalCccPrdJson(fields), "utf8")
    .digest("hex");
  if (bindingHash !== expectedHash) {
    throw new CccCampaignContextError("CCC campaign authority binding hash does not match its fields");
  }
  return { ...fields, bindingHash };
}

export function createCccCampaignAuthorityBinding(
  context: CccCampaignContext,
  action: CccCampaignActionLookup,
): CccCampaignAuthorityBinding {
  const bindingContext = requireAuthorityContext(context);
  if (!action || typeof action !== "object") {
    throw new CccCampaignContextError("CCC campaign action lookup is missing");
  }
  const actionId = requireAuthorityText(action.actionId, "CCC campaign actionId");
  const actionTarget = requireAuthorityText(
    action.actionTarget,
    "CCC campaign actionTarget",
  );
  if (action.requireProtected !== undefined && typeof action.requireProtected !== "boolean") {
    throw new CccCampaignContextError("CCC campaign requireProtected must be a boolean");
  }
  const protectedAction = protectedActionFor(context, actionId);
  if (protectedAction && protectedAction.target !== actionTarget) {
    throw new CccCampaignContextError(
      `CCC campaign protected action ${actionId} target must match exactly`,
    );
  }
  if (action.requireProtected === true && !protectedAction) {
    throw new CccCampaignContextError(
      `CCC campaign action ${actionId} is not a declared protected action`,
    );
  }
  const fields = {
    ...bindingContext,
    actionId,
    actionTarget,
  };
  return assertCccCampaignAuthorityBinding({
    ...fields,
    bindingHash: createHash("sha256")
      .update(canonicalCccPrdJson(fields), "utf8")
      .digest("hex"),
  });
}
