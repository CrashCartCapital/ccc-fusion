import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { canonicalCccPrdJson, compareCccPrdCodeUnits } from "../ccc-prd/contract.js";
import type { CccPrdSemanticBundle } from "../ccc-prd/types.js";
import {
  CCC_CAMPAIGN_EXECUTION_POLICY_SCHEMA_VERSION,
  CCC_CAMPAIGN_MANIFEST_SCHEMA_VERSION,
  type CccCampaignExecutionPolicy,
  type CccCampaignExecutionRoute,
  type CccCampaignManifest,
  type CccCampaignTransport,
} from "./types.js";

const ROUTE_KEYS = ["modelId", "providerId", "taskId", "transport"] as const;
const POLICY_KEYS = ["routes", "schema"] as const;
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
}): CccCampaignManifest {
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
      path: resolve(input.bundle.targetRepository.path),
      baseCommit: input.bundle.targetRepository.baseCommit,
    },
    bounds: { ...input.bundle.bounds },
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
