import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { canonicalCccPrdJson, compareCccPrdCodeUnits } from "../ccc-prd/contract.js";
import type { CccPrdSemanticBundle } from "../ccc-prd/types.js";
import {
  CCC_CAMPAIGN_CONTEXT_SCHEMA_VERSION,
  CCC_CAMPAIGN_EXECUTION_POLICY_SCHEMA_VERSION,
  CCC_CAMPAIGN_MANIFEST_SCHEMA_VERSION,
  CccCampaignContextError,
  type CccCampaignActionLookup,
  type CccCampaignAuthorityBinding,
  type CccCampaignContext,
  type CccCampaignExecutionPolicy,
  type CccCampaignExecutionRoute,
  type CccCampaignManifest,
  type CccCampaignTransport,
} from "./types.js";

const ROUTE_KEYS = ["modelId", "providerId", "taskId", "transport"] as const;
const POLICY_KEYS = ["routes", "schema"] as const;
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

function parseRoute(value: unknown, index: number): CccCampaignExecutionRoute {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CccCampaignExecutionPolicyError(
      `CCC campaign execution route ${index} must be an object`,
    );
  }
  const route = value as Record<string, unknown>;
  exactKeys(route, ROUTE_KEYS, `CCC campaign execution route ${index}`);
  const transport = exactIdentifier(
    route.transport,
    `CCC campaign execution route ${index} transport`,
  );
  if (!TRANSPORTS.has(transport as CccCampaignTransport)) {
    throw new CccCampaignExecutionPolicyError(
      `CCC campaign execution route ${index} has unsupported transport ${JSON.stringify(transport)}`,
    );
  }
  return {
    taskId: exactIdentifier(route.taskId, `CCC campaign execution route ${index} taskId`),
    providerId: exactIdentifier(
      route.providerId,
      `CCC campaign execution route ${index} providerId`,
    ),
    modelId: exactIdentifier(route.modelId, `CCC campaign execution route ${index} modelId`),
    transport: transport as CccCampaignTransport,
  };
}

export function parseCccCampaignExecutionPolicy(
  value: unknown,
  bundle: Pick<CccPrdSemanticBundle, "tasks">,
): CccCampaignExecutionPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CccCampaignExecutionPolicyError(
      "CCC PRD import requires a versioned execution policy",
    );
  }
  const policy = value as Record<string, unknown>;
  exactKeys(policy, POLICY_KEYS, "CCC campaign execution policy");
  if (policy.schema !== CCC_CAMPAIGN_EXECUTION_POLICY_SCHEMA_VERSION) {
    throw new CccCampaignExecutionPolicyError(
      `CCC campaign execution policy schema must be ${CCC_CAMPAIGN_EXECUTION_POLICY_SCHEMA_VERSION}`,
    );
  }
  if (!Array.isArray(policy.routes)) {
    throw new CccCampaignExecutionPolicyError(
      "CCC campaign execution policy routes must be an array",
    );
  }
  const routes = policy.routes.map(parseRoute);
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
  return {
    schema: CCC_CAMPAIGN_EXECUTION_POLICY_SCHEMA_VERSION,
    routes: routes.sort((left, right) => compareCccPrdCodeUnits(left.taskId, right.taskId)),
  };
}

export function createCccCampaignManifest(input: {
  projectId: string;
  importId: string;
  idempotencyKey: string;
  campaignId: string;
  bundle: CccPrdSemanticBundle;
  executionPolicy: CccCampaignExecutionPolicy;
  targetRepositoryPath: string;
  campaignStartedAt: string;
}): CccCampaignManifest {
  const startedAt = Date.parse(input.campaignStartedAt);
  if (
    !Number.isFinite(startedAt)
    || new Date(startedAt).toISOString() !== input.campaignStartedAt
  ) {
    throw new CccCampaignExecutionPolicyError(
      "CCC campaign start must be a canonical ISO timestamp",
    );
  }
  return {
    schema: CCC_CAMPAIGN_MANIFEST_SCHEMA_VERSION,
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
    proofs: input.bundle.proofs.map((proof) => ({
      ...proof,
      requirementIds: [...proof.requirementIds],
      negativeControls: [...proof.negativeControls],
      spans: proof.spans.map((span) => ({ ...span })),
    })),
    protectedActions: input.bundle.protectedActions.map((action) => ({
      ...action,
      spans: action.spans.map((span) => ({ ...span })),
    })),
    executionPolicy: {
      schema: input.executionPolicy.schema,
      routes: input.executionPolicy.routes.map((route) => ({ ...route })),
    },
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
  if (requireAuthorityText(context.route.taskId, "campaign route taskId") !== taskId) {
    throw new CccCampaignContextError("CCC campaign route taskId does not match campaign taskId");
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
