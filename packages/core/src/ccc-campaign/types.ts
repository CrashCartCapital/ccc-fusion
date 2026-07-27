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

export const CCC_PROVIDER_ATTEMPT_SCHEMA_VERSION =
  "ccc-campaign.provider-attempt.v2" as const;

export type CccProviderAttemptState =
  | "reserved"
  | "dispatched_unknown"
  | "committed"
  | "proved_failed";

export type CccProviderAttemptRequest = Readonly<{
  taskId: string;
  actionId: string;
  actionTarget: string;
  turnKey: string;
  dispatchKey: string;
  providerId: string;
  modelId: string;
  transport: CccCampaignTransport;
}>;

export type CccProviderAttemptTransition = Readonly<{
  taskId: string;
  attemptKey: string;
  controllerToken: string;
}>;

export type CccProviderAttemptReconciliation = CccProviderAttemptTransition & Readonly<{
  outcome: Extract<CccProviderAttemptState, "committed" | "proved_failed">;
  evidenceDigest: string;
  observerId: string;
}>;

export type CccProviderAttemptTerminalEvidence =
  | Readonly<{ kind: "not-dispatched"; state: "proved_failed" }>
  | Readonly<{
    kind: "reconciled";
    state: Extract<CccProviderAttemptState, "committed" | "proved_failed">;
    evidenceDigest: string;
    observerId: string;
  }>;

export type CccProviderAttemptScope = Readonly<{
  attemptKey: string;
  controllerToken: string;
  taskId: string;
  semanticTaskId: string;
  campaignDeadlineAt: string;
  turnKey: string;
  dispatchKey: string;
  attemptOrdinal: number;
  requestCount: number;
  state: CccProviderAttemptState;
  terminal?: CccProviderAttemptTerminalEvidence;
  binding: Readonly<CccCampaignAuthorityBinding>;
}>;

/** Full immutable persisted identity required to settle a native provider attempt. */
export type CccProviderAttemptSettlementInput = CccProviderAttemptReconciliation & Pick<
  CccProviderAttemptScope,
  "semanticTaskId" | "campaignDeadlineAt" | "turnKey" | "dispatchKey" | "attemptOrdinal" | "requestCount" | "binding"
>;

export type CccProviderAttemptDispatchDecision =
  | Readonly<{ kind: "dispatch-permit"; scope: CccProviderAttemptScope }>
  | Readonly<{ kind: "dispatched-unknown" | "terminal"; scope: CccProviderAttemptScope }>;

export class CccProviderAttemptIdentityError extends Error {
  public readonly code = "CCC_PROVIDER_ATTEMPT_IDENTITY_REFUSED";

  public constructor(public readonly reason: "route-drift" | "invalid-input", message: string) {
    super(message);
    this.name = "CccProviderAttemptIdentityError";
  }
}

export class CccProviderAttemptLimitError extends Error {
  public readonly code = "CCC_PROVIDER_ATTEMPT_LIMIT_REFUSED";

  public constructor(
    public readonly reason: "deadline" | "max-requests" | "max-concurrency",
    message: string,
  ) {
    super(message);
    this.name = "CccProviderAttemptLimitError";
  }
}

export class CccProviderAttemptStateError extends Error {
  public readonly code = "CCC_PROVIDER_ATTEMPT_STATE_REFUSED";

  public constructor(message: string) {
    super(message);
    this.name = "CccProviderAttemptStateError";
  }
}

export class CccProviderAttemptCollisionError extends Error {
  public readonly code = "CCC_PROVIDER_ATTEMPT_COLLISION";

  public constructor(message: string) {
    super(message);
    this.name = "CccProviderAttemptCollisionError";
  }
}

export type CccCampaignExecutionRoute = {
  taskId: string;
  providerId: string;
  modelId: string;
  transport: CccCampaignTransport;
  workflowExtensionId?: string;
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
  /** Exact protected actions declared by this semantic task; may be empty. */
  protectedActionIds: readonly string[];
};
