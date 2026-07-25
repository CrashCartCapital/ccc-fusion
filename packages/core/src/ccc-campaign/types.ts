import type {
  CccPrdAdmittedWriteRoot,
  CccPrdExecutionBounds,
  CccPrdProof,
  CccPrdProtectedActionIntent,
  CccPrdTargetRepository,
} from "../ccc-prd/types.js";

export const CCC_CAMPAIGN_EXECUTION_POLICY_SCHEMA_VERSION =
  "ccc-campaign.execution-policy.v1" as const;
export const CCC_CAMPAIGN_MANIFEST_SCHEMA_VERSION =
  "ccc-campaign.manifest.v1" as const;
export const CCC_CAMPAIGN_CONTEXT_SCHEMA_VERSION =
  "ccc-campaign.context.v1" as const;

export type CccCampaignTransport = "pi" | "cli" | "workflow";

export type CccCampaignExecutionRoute = {
  taskId: string;
  providerId: string;
  modelId: string;
  transport: CccCampaignTransport;
};

export type CccCampaignActionLookup = {
  actionId: string;
  actionTarget: string;
  requireProtected?: boolean;
};

export type CccCampaignAuthorityBinding = {
  projectId: string;
  importId: string;
  campaignId: string;
  taskId: string;
  actionId: string;
  actionTarget: string;
  idempotencyKey: string;
  packetHash: string;
  sidecarHash: string;
  bundleHash: string;
  targetRepository: string;
  targetBase: string;
  providerId: string;
  modelId: string;
  transport: CccCampaignTransport;
  manifestHash: string;
  bindingHash: string;
};

export type CccCampaignActionLease = {
  actionId: string;
  actionTarget: string;
  approvalRequestId: string;
  claimToken: string;
  claimedAt: string;
  expiresAt: string;
  bindingHash: string;
};

export class CccCampaignContextError extends Error {
  public readonly code = "CCC_CAMPAIGN_CONTEXT_REFUSED";

  public constructor(message: string) {
    super(message);
    this.name = "CccCampaignContextError";
  }
}

export type CccCampaignExecutionPolicy = {
  schema: typeof CCC_CAMPAIGN_EXECUTION_POLICY_SCHEMA_VERSION;
  routes: CccCampaignExecutionRoute[];
};

export type CccCampaignManifest = {
  schema: typeof CCC_CAMPAIGN_MANIFEST_SCHEMA_VERSION;
  projectId: string;
  importId: string;
  idempotencyKey: string;
  campaignId: string;
  packetHash: string;
  sidecarHash: string;
  bundleHash: string;
  sourceVersion: string;
  targetRepository: CccPrdTargetRepository;
  bounds: CccPrdExecutionBounds;
  campaignStartedAt: string;
  campaignDeadlineAt: string;
  admittedWriteRoots: CccPrdAdmittedWriteRoot[];
  proofs: CccPrdProof[];
  protectedActions: CccPrdProtectedActionIntent[];
  executionPolicy: CccCampaignExecutionPolicy;
};

export type CccCampaignContext = Omit<CccCampaignManifest, "schema"> & {
  schema: typeof CCC_CAMPAIGN_CONTEXT_SCHEMA_VERSION;
  taskId: string;
  route: CccCampaignExecutionRoute;
  manifestHash: string;
  requestCount: number;
  activeActionLeases: Record<string, CccCampaignActionLease>;
};

export type CccCampaignTaskContext = CccCampaignContext & {
  semanticTaskId: string;
  proofIds: readonly string[];
};
