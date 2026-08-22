import type {
  CccPrdAdmittedWriteRoot,
  CccPrdExecutionBounds,
  CccPrdExecutionPrompt,
  CccPrdProof,
  CccPrdProofPhase,
  CccPrdProtectedActionIntent,
  CccPrdTargetRepository,
} from "../ccc-prd/types.js";

export const CCC_CAMPAIGN_EXECUTION_POLICY_V1_SCHEMA_VERSION =
  "ccc-campaign.execution-policy.v1" as const;
export const CCC_CAMPAIGN_EXECUTION_POLICY_V2_SCHEMA_VERSION =
  "ccc-campaign.execution-policy.v2" as const;
export const CCC_CAMPAIGN_EXECUTION_POLICY_V3_SCHEMA_VERSION =
  "ccc-campaign.execution-policy.v3" as const;
export const CCC_PRD_EXECUTION_PLAN_SCHEMA_VERSION =
  "ccc-prd.execution-plan.v1" as const;
/** @deprecated Use the version-specific execution-policy constant. */
export const CCC_CAMPAIGN_EXECUTION_POLICY_SCHEMA_VERSION =
  CCC_CAMPAIGN_EXECUTION_POLICY_V1_SCHEMA_VERSION;
export const CCC_CAMPAIGN_MANIFEST_V1_SCHEMA_VERSION =
  "ccc-campaign.manifest.v1" as const;
export const CCC_CAMPAIGN_MANIFEST_V2_SCHEMA_VERSION =
  "ccc-campaign.manifest.v2" as const;
/** @deprecated Use the version-specific campaign-manifest constant. */
export const CCC_CAMPAIGN_MANIFEST_SCHEMA_VERSION =
  CCC_CAMPAIGN_MANIFEST_V1_SCHEMA_VERSION;
export const CCC_CAMPAIGN_EXECUTION_AUTHORIZATION_MODE_PER_TASK_V1 =
  "per_task_v1" as const;
export const CCC_CAMPAIGN_EXECUTION_AUTHORIZATION_MODE_SEALED_BUNDLE_V1 =
  "sealed_bundle_v1" as const;
export const CCC_CAMPAIGN_CONTEXT_SCHEMA_VERSION =
  "ccc-campaign.context.v1" as const;

export type CccCampaignTransport = "pi" | "cli" | "workflow";

export const CCC_PROVIDER_ATTEMPT_V2_SCHEMA_VERSION =
  "ccc-campaign.provider-attempt.v2" as const;
export const CCC_PROVIDER_ATTEMPT_V3_SCHEMA_VERSION =
  "ccc-campaign.provider-attempt.v3" as const;
export const CCC_PROVIDER_ATTEMPT_V4_SCHEMA_VERSION =
  "ccc-campaign.provider-attempt.v4" as const;
export const CCC_PROVIDER_ATTEMPT_SCHEMA_VERSION =
  CCC_PROVIDER_ATTEMPT_V4_SCHEMA_VERSION;
export const CCC_CAMPAIGN_PROOF_ATTEMPT_V1_SCHEMA_VERSION =
  "ccc-campaign.proof-attempt.v1" as const;
export const CCC_CAMPAIGN_PROOF_ATTEMPT_V2_SCHEMA_VERSION =
  "ccc-campaign.proof-attempt.v2" as const;
/** Frozen legacy alias; explicit v2 attempts use the v2 discriminator. */
export const CCC_CAMPAIGN_PROOF_ATTEMPT_SCHEMA_VERSION =
  CCC_CAMPAIGN_PROOF_ATTEMPT_V1_SCHEMA_VERSION;
export const CCC_CAMPAIGN_PROOF_ATTEMPT_CONTRACT_V1 = "v1" as const;
export const CCC_CAMPAIGN_PROOF_ATTEMPT_CONTRACT_V2 = "v2" as const;

export type CccCampaignProofAttemptContractVersion =
  | typeof CCC_CAMPAIGN_PROOF_ATTEMPT_CONTRACT_V1
  | typeof CCC_CAMPAIGN_PROOF_ATTEMPT_CONTRACT_V2;

export type CccCampaignProofAttemptState =
  | "reserved"
  | "dispatched_unknown"
  | "committed"
  | "proved_failed";

export type CccCampaignProofAttemptScope = "task" | "campaign";

export type CccCampaignWorkItemFence = Readonly<{
  workItemId: string;
  runId: string;
  attempt: number;
}>;

export type CccCampaignProofWorkItemFence = CccCampaignWorkItemFence;

export type CccCampaignProofExecutionResultInput = Readonly<{
  success: boolean;
  exitCode: number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  killed: boolean;
  warnings: readonly string[];
  changedPathsSha256?: string;
  negativeControlLabel?: string;
}>;

export type CccCampaignProofExecutionResult = Readonly<{
  success: boolean;
  exitCode: number | null;
  durationMs: number;
  stdoutSha256: string;
  stderrSha256: string;
  stdoutTail: string;
  stderrTail: string;
  timedOut: boolean;
  killed: boolean;
  warnings: readonly string[];
  changedPathsSha256?: string;
  negativeControlLabel?: string;
}>;

export const CCC_PRD_PROOF_EVIDENCE_V2_SCHEMA_VERSION =
  "ccc-prd.proof-evidence.v2" as const;
export const CCC_PRD_PROOF_TERMINAL_ENVELOPE_V2_SCHEMA_VERSION =
  "ccc-prd.proof-terminal-envelope.v2" as const;

export type CccCampaignProofEvidenceClauseResult = Readonly<{
  clauseId: string;
  passed: boolean;
}>;

export type CccCampaignProofEvidencePositiveCaseResult = Readonly<{
  caseId: string;
  passed: boolean;
}>;

export type CccCampaignProofEvidenceNegativeControlResult = Readonly<{
  controlId: string;
  passed: boolean;
}>;

export type CccCampaignProofEvidenceV2 = Readonly<{
  schema: typeof CCC_PRD_PROOF_EVIDENCE_V2_SCHEMA_VERSION;
  proofId: string;
  phase: CccPrdProofPhase;
  sourceCommit: string;
  sourceTree: string;
  passed: boolean;
  clauseResults: readonly CccCampaignProofEvidenceClauseResult[];
  positiveCaseResults: readonly CccCampaignProofEvidencePositiveCaseResult[];
  negativeControlResults: readonly CccCampaignProofEvidenceNegativeControlResult[];
}>;

export type CccCampaignProofExecutionRefusalCode =
  | "timeout"
  | "killed"
  | "no_output"
  | "malformed_output"
  | "output_over_limit"
  | "spawn_refused"
  | "sandbox_refused";

type CccCampaignProofTerminalEnvelopeV2Base = Readonly<{
  schema: typeof CCC_PRD_PROOF_TERMINAL_ENVELOPE_V2_SCHEMA_VERSION;
  proofId: string;
  phase: CccPrdProofPhase;
  sourceCommit: string;
  sourceTree: string;
  exitCode: number | null;
  durationMs: number;
  stdoutSha256: string;
  stderrSha256: string;
  changedPathsSha256: string;
  stdoutTail: string;
  stderrTail: string;
  timedOut: boolean;
  killed: boolean;
  warnings: readonly string[];
}>;

export type CccCampaignProofVerifiedTerminalEnvelopeV2 =
  CccCampaignProofTerminalEnvelopeV2Base
  & Readonly<{
    kind: "verified";
    passed: boolean;
    evidence: CccCampaignProofEvidenceV2;
    evidenceSha256: string;
  }>;

export type CccCampaignProofExecutionRefusedTerminalEnvelopeV2 =
  CccCampaignProofTerminalEnvelopeV2Base
  & Readonly<{
    kind: "execution_refused";
    code: CccCampaignProofExecutionRefusalCode;
  }>;

export type CccCampaignProofTerminalEnvelopeV2 =
  | CccCampaignProofVerifiedTerminalEnvelopeV2
  | CccCampaignProofExecutionRefusedTerminalEnvelopeV2;

export type CccCampaignProofAttempt = Readonly<{
  schema:
    | typeof CCC_CAMPAIGN_PROOF_ATTEMPT_V1_SCHEMA_VERSION
    | typeof CCC_CAMPAIGN_PROOF_ATTEMPT_V2_SCHEMA_VERSION;
  attemptContractVersion: CccCampaignProofAttemptContractVersion;
  attemptKey: string;
  controllerToken: string;
  projectId: string;
  importId: string;
  campaignId: string;
  taskId: string;
  semanticTaskId: string;
  proofId: string;
  packetHash: string;
  sidecarHash: string;
  bundleHash: string;
  manifestHash: string;
  campaignBindingHash: string;
  targetRepository: string;
  targetBase: string;
  sourceCommit: string;
  sourceTree: string;
  definitionSha256: string;
  command: string;
  commandSha256: string;
  workItemId: string;
  runId: string;
  workItemAttempt: number;
  phase?: CccPrdProofPhase;
  verifierClosureSha256?: string;
  candidateInputsSha256?: string;
  executionToolchainSha256?: string;
  state: CccCampaignProofAttemptState;
  result?: CccCampaignProofExecutionResult;
  terminalEnvelope?: CccCampaignProofTerminalEnvelopeV2;
  terminalEnvelopeSha256?: string;
  proofEvidence?: CccCampaignProofEvidenceV2;
  proofEvidenceSha256?: string;
  createdAt: string;
  updatedAt: string;
  dispatchedAt?: string;
  settledAt?: string;
}>;

export type CccCampaignProofAttemptDispatchDecision =
  | Readonly<{ kind: "dispatch-permit"; attempt: CccCampaignProofAttempt }>
  | Readonly<{
    kind: "dispatched-unknown" | "terminal";
    attempt: CccCampaignProofAttempt;
  }>;

export class CccCampaignProofAttemptIdentityError extends Error {
  public readonly code = "CCC_CAMPAIGN_PROOF_ATTEMPT_IDENTITY_REFUSED";

  public constructor(message: string) {
    super(message);
    this.name = "CccCampaignProofAttemptIdentityError";
  }
}

export class CccCampaignProofAttemptStateError extends Error {
  public readonly code = "CCC_CAMPAIGN_PROOF_ATTEMPT_STATE_REFUSED";

  public constructor(message: string) {
    super(message);
    this.name = "CccCampaignProofAttemptStateError";
  }
}

export const CCC_CAMPAIGN_PROOF_DEADLINE_EXPIRED_CODE =
  "CCC_CAMPAIGN_PROOF_DEADLINE_EXPIRED" as const;
export const CCC_CAMPAIGN_PROOF_DEADLINE_EXPIRED_REASON =
  `ccc-permanent:${CCC_CAMPAIGN_PROOF_DEADLINE_EXPIRED_CODE}` as const;

export class CccCampaignProofAttemptLimitError extends Error {
  public readonly code = "CCC_CAMPAIGN_PROOF_ATTEMPT_LIMIT_REFUSED";

  public constructor(
    public readonly reason: "deadline",
    message: string,
  ) {
    super(message);
    this.name = "CccCampaignProofAttemptLimitError";
  }
}

export class CccCampaignProofAttemptCollisionError extends Error {
  public readonly code = "CCC_CAMPAIGN_PROOF_ATTEMPT_COLLISION";

  public constructor(message: string) {
    super(message);
    this.name = "CccCampaignProofAttemptCollisionError";
  }
}

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
  workItemFence: CccCampaignWorkItemFence;
}>;

export type CccProviderAttemptTransition = Readonly<{
  taskId: string;
  attemptKey: string;
  controllerToken: string;
}>;

/**
 * Terminal-evidence receipt fields (effective-route-and-usage-cost substrate).
 * Requested identity lives in the route/binding; these fields record what the
 * transport actually did, at settlement time only. Additive to the v3 terminal
 * shape and versioned under {@link CCC_PROVIDER_ATTEMPT_V4_SCHEMA_VERSION}.
 */
export type CccProviderAttemptUsage = Readonly<{
  inputTokens: number;
  outputTokens: number;
}>;

export type CccProviderAttemptCostClaim = Readonly<{ amountUsd: number; source: string }>;
export type CccProviderAttemptCostUnknown = Readonly<{ kind: "unknown"; reason: string }>;
export type CccProviderAttemptCost = CccProviderAttemptCostClaim | CccProviderAttemptCostUnknown;

export type CccProviderAttemptReceiptSource = "stream-usage" | "provider-api" | "none";

/** The two allowlisted provider/model observations emitted by OmniRoute. */
export type CccProviderAttemptOmniRouteObservation = Readonly<{
  provider: string;
  model: string;
}>;

/**
 * Initial HTTP metadata and terminal SSE metadata are kept together so a
 * replay cannot silently replace the terminal upstream identity with a body
 * model or a request echo.
 */
export type CccProviderAttemptOmniRouteReceipt = Readonly<{
  initial: CccProviderAttemptOmniRouteObservation;
  final: CccProviderAttemptOmniRouteObservation;
}>;

/** The validated, persisted shape: what the transport actually used. */
export type CccProviderAttemptEffectiveRoute = Readonly<{
  effectiveProvider: string;
  effectiveModel: string;
  effectiveReasoningEffort?: string;
  effectiveServiceTier?: string;
  usage: CccProviderAttemptUsage | null;
  cost: CccProviderAttemptCost;
  receiptSource: CccProviderAttemptReceiptSource;
  omniRoute?: CccProviderAttemptOmniRouteReceipt;
}>;

/**
 * The raw settlement input shape. `fallbackReason` exists only so a caller
 * that still believes fallback happened is refused explicitly; campaign
 * fallback is not an admitted behavior right now, so it must be null/absent
 * and is never persisted.
 */
export type CccProviderAttemptEffectiveRouteInput = Readonly<{
  effectiveProvider: string;
  effectiveModel: string;
  effectiveReasoningEffort?: string;
  effectiveServiceTier?: string;
  fallbackReason?: string | null;
  usage: CccProviderAttemptUsage | null;
  cost: CccProviderAttemptCost;
  receiptSource: CccProviderAttemptReceiptSource;
  omniRoute?: CccProviderAttemptOmniRouteReceipt;
}>;

export type CccProviderAttemptReconciliation = CccProviderAttemptTransition & Readonly<{
  outcome: Extract<CccProviderAttemptState, "committed" | "proved_failed">;
  evidenceDigest: string;
  observerId: string;
  effectiveRoute?: CccProviderAttemptEffectiveRouteInput;
}>;

export type CccProviderAttemptTerminalEvidence =
  | Readonly<{ kind: "not-dispatched"; state: "proved_failed" }>
  | Readonly<{
    kind: "reconciled";
    state: Extract<CccProviderAttemptState, "committed" | "proved_failed">;
    evidenceDigest: string;
    observerId: string;
    effectiveRoute?: CccProviderAttemptEffectiveRoute;
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
  workItemFence: CccCampaignWorkItemFence | null;
  state: CccProviderAttemptState;
  terminal?: CccProviderAttemptTerminalEvidence;
  binding: Readonly<CccCampaignAuthorityBinding>;
}>;

/** Full immutable persisted identity required to settle a native provider attempt. */
export type CccProviderAttemptSettlementInput = CccProviderAttemptReconciliation & Pick<
  CccProviderAttemptScope,
  "semanticTaskId" | "campaignDeadlineAt" | "turnKey" | "dispatchKey" | "attemptOrdinal" | "requestCount" | "workItemFence" | "binding"
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
  executor?: "model" | "cli-agent";
  toolMode?: "coding";
  worktreeMode?: "isolated";
  ownedPaths?: string[];
  allowedWriteRoots?: string[];
  commitPolicy?: "required";
  cliAdapterId?: string;
};

export type CccCampaignProductExecutionRoute = CccCampaignExecutionRoute & {
  transport: "pi" | "cli";
  executor: "model" | "cli-agent";
  toolMode: "coding";
  worktreeMode: "isolated";
  ownedPaths: string[];
  allowedWriteRoots: string[];
  commitPolicy: "required";
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
  schema:
    | typeof CCC_CAMPAIGN_EXECUTION_POLICY_V1_SCHEMA_VERSION
    | typeof CCC_CAMPAIGN_EXECUTION_POLICY_V2_SCHEMA_VERSION;
  routes: CccCampaignExecutionRoute[];
};

export type CccCampaignProductExecutionPolicy = CccCampaignExecutionPolicy & {
  schema: typeof CCC_CAMPAIGN_EXECUTION_POLICY_V2_SCHEMA_VERSION;
  routes: CccCampaignProductExecutionRoute[];
};

/**
 * Routing-contract v3 per-task metadata. Additive to the v2 product route
 * shape; a v3 route is never accepted where a v2 route is expected and vice
 * versa (versions are parsed and rejected exactly, never migrated silently).
 */
export type CccCampaignRouteReasoningEffort =
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "max"
  | "not-applicable";

export type CccCampaignRouteServiceTier = "standard" | "priority" | "flex" | "default";

export type CccCampaignRouteAccessTier =
  | "subscription"
  | "free"
  | "plan"
  | "metered"
  | "unknown";

export type CccCampaignRouteSensitivityClass =
  | "private-vault"
  | "sanitized"
  | "synthetic"
  | "public";

export type CccCampaignRouteEgressPolicy =
  | Readonly<{ kind: "loopback-only" }>
  | Readonly<{ kind: "allowlisted"; providers: string[] }>;

export type CccCampaignRouteLimits = Readonly<{
  maxRequests: number;
  maxDurationMs: number;
  maxConcurrency: number;
  maxResponseTokens?: number;
  /** Forbidden on receipt-incapable transports (e.g. cli); see limits parsing. */
  maxSpendUsd?: number;
}>;

/**
 * "ordered" fallback is intentionally not modeled as data yet; the v3 parser
 * rejects it with a not-yet-supported error rather than accepting a shape it
 * cannot enforce.
 */
export type CccCampaignRouteFallbackPolicy = Readonly<{ kind: "forbidden" }>;

export type CccCampaignProductExecutionRouteV3 = CccCampaignProductExecutionRoute & {
  routeProfileId: string;
  taskArchetype: string;
  reasoningEffort: CccCampaignRouteReasoningEffort;
  serviceTier: CccCampaignRouteServiceTier;
  accessTier: CccCampaignRouteAccessTier;
  sensitivityClass: CccCampaignRouteSensitivityClass;
  egressPolicy: CccCampaignRouteEgressPolicy;
  limits: CccCampaignRouteLimits;
  fallbackPolicy: CccCampaignRouteFallbackPolicy;
  catalogDigest: string | null;
  decidedAt: string;
};

export type CccCampaignProductExecutionPolicyV3 = {
  schema: typeof CCC_CAMPAIGN_EXECUTION_POLICY_V3_SCHEMA_VERSION;
  routes: CccCampaignProductExecutionRouteV3[];
};

export type CccPrdProductExecutionRouteSelection = {
  providerId: string;
  modelId: string;
  transport: "pi" | "cli";
  cliAdapterId?: string;
};

export type CccPrdProductExecutionPlan = {
  schema: typeof CCC_PRD_EXECUTION_PLAN_SCHEMA_VERSION;
  packetHash: string;
  sidecarHash: string;
  bundleHash: string;
  policy: CccCampaignProductExecutionPolicy;
};

export type CccCampaignExecutionAuthorizationMode =
  | typeof CCC_CAMPAIGN_EXECUTION_AUTHORIZATION_MODE_PER_TASK_V1
  | typeof CCC_CAMPAIGN_EXECUTION_AUTHORIZATION_MODE_SEALED_BUNDLE_V1;

export type CccCampaignManifestBase = {
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

export type CccCampaignManifestV1 = CccCampaignManifestBase & {
  schema: typeof CCC_CAMPAIGN_MANIFEST_V1_SCHEMA_VERSION;
};

export type CccCampaignManifestV2 = CccCampaignManifestBase & {
  schema: typeof CCC_CAMPAIGN_MANIFEST_V2_SCHEMA_VERSION;
  executionAuthorizationMode:
    typeof CCC_CAMPAIGN_EXECUTION_AUTHORIZATION_MODE_SEALED_BUNDLE_V1;
};

export type CccCampaignManifest = CccCampaignManifestV1 | CccCampaignManifestV2;

export type CccCampaignContext = CccCampaignManifestBase & {
  schema: typeof CCC_CAMPAIGN_CONTEXT_SCHEMA_VERSION;
  /** Persisted TaskStore custody loads normalize this; omission preserves legacy caller fixtures. */
  executionAuthorizationMode?: CccCampaignExecutionAuthorizationMode;
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
  /**
   * Product-v2 execution material re-derived from immutable campaign custody.
   * Runtime compares these digests with the imported workflow node before any
   * graph, provider, or tool effect.
   */
  executionCustody?: Readonly<{
    promptSchema: CccPrdExecutionPrompt["schema"];
    promptSha256: string;
    routeSha256: string;
  }>;
};
