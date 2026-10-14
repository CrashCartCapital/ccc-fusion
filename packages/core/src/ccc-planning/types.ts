import type {
  CccCampaignWorkItemFence,
  CccProviderAttemptScope,
} from "../ccc-campaign/types.js";

/*
FNXC:CccPlanningTypes 2026-10-14-08:20:
The pure vocabulary of a request-to-code run (CONTRACT-v2 sections 2.1, 2.3, 2.4, 2.7 and 2.10). Every later card imports these names, so they live in core and nothing here reaches PostgreSQL, the engine or the clock. The run-state list and the allowed transitions are a mirror of `project.ccc_planning_run_transition_allowed` (migration 0042); L1 proves the two agree for all 400 pairs.
*/

// ---------------------------------------------------------------- modes and profiles

export type CccPlanningMode = "spec" | "build";
export type CccPlanningBudgetProfile = "standard" | "large";
export type CccPlanningRoleProfile = "full-v2" | "adaptive-v2" | "lean-v2"; // only "full-v2" admitted in I1-I2
export type CccPlanningPhase = "planning" | "implementation" | "review_proof";

// ---------------------------------------------------------------- run states (PRD §9)

export const CCC_PLANNING_RUN_STATES = [
  "admitted", "running", "awaiting_intent", "awaiting_budget", "awaiting_execution_authority",
  "blocked_prerequisite", "blocked_provider", "budget_exhausted", "unknown_effect", "paused",
  "cancelling", "cancelled", "spec_ready", "importing", "building", "verification_failed",
  "accepted", "delivering", "delivered", "failed",
] as const;
export type CccPlanningRunState = (typeof CCC_PLANNING_RUN_STATES)[number];

export const CCC_PLANNING_TERMINAL_STATES = ["cancelled", "delivered", "failed"] as const;

/** States that wait on an operator or a reconcile; the live poll stops on these too. */
export const CCC_PLANNING_OPERATOR_WAIT_STATES = [
  "awaiting_intent", "awaiting_budget", "awaiting_execution_authority", "paused",
  "blocked_prerequisite", "blocked_provider", "budget_exhausted", "unknown_effect",
] as const;

/*
FNXC:CccPlanningTransitions 2026-10-14-08:20:
The 64 pairs frozen in migration 0042 plus ('importing','budget_exhausted') from leader adjudication item 38: IB2's Build fit runs after ST2 has already moved the run to `importing`, and its refusal code CCC_PLANNING_BUILD_FIT_INSUFFICIENT is a `budget_exhausted` code, so without this pair the anchor trigger would refuse the only correct outcome. 65 pairs plus identity. Identity is allowed for every state, exactly as the SQL function says; the trigger refuses updates to terminal rows separately.
*/
export const CCC_PLANNING_RUN_TRANSITIONS: readonly (readonly [CccPlanningRunState, CccPlanningRunState])[] = Object.freeze([
  ["admitted", "running"], ["admitted", "cancelling"], ["admitted", "failed"], ["admitted", "blocked_prerequisite"],
  ["running", "awaiting_intent"], ["running", "awaiting_budget"], ["running", "blocked_prerequisite"],
  ["running", "blocked_provider"], ["running", "budget_exhausted"], ["running", "unknown_effect"],
  ["running", "paused"], ["running", "cancelling"], ["running", "spec_ready"], ["running", "failed"],
  ["awaiting_intent", "running"], ["awaiting_intent", "cancelling"],
  ["awaiting_budget", "running"], ["awaiting_budget", "building"], ["awaiting_budget", "cancelling"],
  ["blocked_prerequisite", "running"], ["blocked_prerequisite", "building"], ["blocked_prerequisite", "cancelling"],
  ["blocked_provider", "running"], ["blocked_provider", "building"], ["blocked_provider", "cancelling"],
  ["budget_exhausted", "awaiting_budget"], ["budget_exhausted", "cancelling"], ["budget_exhausted", "failed"],
  ["unknown_effect", "running"], ["unknown_effect", "building"], ["unknown_effect", "cancelling"],
  ["paused", "running"], ["paused", "building"], ["paused", "cancelling"],
  ["cancelling", "cancelled"],
  ["spec_ready", "importing"], ["spec_ready", "cancelling"], ["spec_ready", "paused"],
  ["spec_ready", "blocked_prerequisite"], ["spec_ready", "budget_exhausted"], ["spec_ready", "failed"],
  ["importing", "awaiting_execution_authority"], ["importing", "building"],
  ["importing", "blocked_prerequisite"], ["importing", "cancelling"], ["importing", "failed"],
  ["importing", "budget_exhausted"],
  ["awaiting_execution_authority", "building"], ["awaiting_execution_authority", "cancelling"],
  ["awaiting_execution_authority", "failed"],
  ["building", "verification_failed"], ["building", "accepted"], ["building", "paused"],
  ["building", "cancelling"], ["building", "blocked_prerequisite"], ["building", "blocked_provider"],
  ["building", "budget_exhausted"], ["building", "unknown_effect"], ["building", "failed"],
  ["verification_failed", "cancelling"], ["verification_failed", "failed"],
  ["accepted", "delivering"], ["accepted", "cancelling"],
  ["delivering", "delivered"], ["delivering", "failed"],
] as const);

const ALLOWED_TRANSITIONS: ReadonlySet<string> = new Set(CCC_PLANNING_RUN_TRANSITIONS.map(([from, to]) => `${from}\0${to}`));

/** No automatic exit in I2. Build-mode spec_ready is transient (it moves on to importing). */
export function cccPlanningRestingStates(mode: CccPlanningMode): readonly CccPlanningRunState[] {
  return mode === "spec" ? ["spec_ready"] : ["accepted", "verification_failed"];
}

/** Must equal project.ccc_planning_run_transition_allowed for all 400 pairs; 65 pairs plus identity. */
export function cccPlanningTransitionAllowed(from: CccPlanningRunState, to: CccPlanningRunState): boolean {
  return from === to || ALLOWED_TRANSITIONS.has(`${from}\0${to}`);
}

/** Resume, unblock and reconcile return to "running" before import and "building" after. */
export function cccPlanningResumeTarget(run: Readonly<{ importId: string | null }>): "running" | "building" {
  return run.importId === null ? "running" : "building";
}

// ---------------------------------------------------------------- stages (section 2.4)

export const CCC_PLANNING_IR_STAGES = [
  "preflight", "intent", "research", "design", "design-review", "spec",
  "plan", "verifier", "review", "repair", "specready", "import",
] as const; // IR order; Spec mode omits "import"
export const CCC_PLANNING_ARTIFACT_ONLY_STAGES = ["admission", "operator", "invalidate", "g7", "g8"] as const;
export type CccPlanningIrStageId = (typeof CCC_PLANNING_IR_STAGES)[number];
export type CccPlanningStageId = CccPlanningIrStageId | (typeof CCC_PLANNING_ARTIFACT_ONLY_STAGES)[number];
export const CCC_PLANNING_STAGE_IDS: readonly CccPlanningStageId[] = [
  ...CCC_PLANNING_IR_STAGES,
  ...CCC_PLANNING_ARTIFACT_ONLY_STAGES,
];

// ---------------------------------------------------------------- roles (section 2.7)

export type CccPlanningRoleClass = "author" | "researcher" | "critic" | "writer";
export type CccPlanningExactModelId = "glm/glm-5.3" | "glm/glm-5.3-flash" | "minimax/MiniMax-M3";
export type CccModelFamily = "glm" | "minimax";
export type CccPlanningRoleId =
  | "intent-assessor" | "acceptance-reviewer" | "researcher" | "extraction-leaf" | "leaf-reviewer"
  | "source-verifier" | "designer-a" | "designer-b" | "design-a-reviewer" | "design-b-reviewer"
  | "spec-author" | "execution-planner" | "verifier-author" | "verifier-auditor" | "product-adversary"
  | "technical-critic" | "preflight-writer" | "preflight-critic" | "preflight-researcher"
  | "implementation-writer" | "task-reviewer" | "final-judge";
export type CccPlanningRoleSpec = Readonly<{
  roleId: CccPlanningRoleId; modelId: CccPlanningExactModelId; family: CccModelFamily; roleClass: CccPlanningRoleClass;
  stageId: CccPlanningStageId | "campaign"; phase: "planning" | "implementation" | "review_proof";
  reviewedBy: CccPlanningRoleId | null; counting: "fixed" | "per-leaf" | "once-if-leaves" | "per-task" | "once" | "probe";
}>;
export type CccModelIdentityReason =
  | "excluded-model" | "floating-alias" | "combo-route" | "unqualified-id" | "not-in-pin-registry";

// ---------------------------------------------------------------- audit vocabulary (section 2.1)

export const CCC_PLANNING_AUDIT_MUTATION_TYPES = [
  "ccc-planning:call:reserved", "ccc-planning:call:dispatched", "ccc-planning:call:terminal",
  "ccc-planning:lineage:created", "ccc-planning:control", "ccc-planning:decision:answered",
  "ccc-planning:repair-chunk", "ccc-planning:repair-epoch-closed", "ccc-planning:review-epoch",
  "ccc-planning:fetch:reserved", "ccc-planning:fetch:settled", "ccc-planning:artifact-published",
  "ccc-planning:import-intent", "ccc-planning:import-linked", "ccc-planning:live-execution-released",
  "ccc-planning:state", "ccc-planning:writer-refused", "ccc-planning:campaign-unmapped",
  "ccc-planning:build-baseline",
] as const; // S0 adds exactly these 19 literals to RunAuditMutationType (packages/core/src/types/run-audit.ts)
export type CccPlanningAuditMutationType = (typeof CCC_PLANNING_AUDIT_MUTATION_TYPES)[number];

// ---------------------------------------------------------------- review verdicts (adjudication item 34)

/*
FNXC:CccPlanningReviewVerdict 2026-10-14-08:20:
Reviewer findings are typed in core, not in the engine verdict tool, because core content schemas (`CccPlanningObjectionV1.ref`) and the engine stage host both need them and core can never import engine (leader adjudication item 34). Card C2's `ccc_submit_verdict` tool imports these two types.
*/
export type CccReviewFindingRef =
  | Readonly<{ kind: "requirement"; requirementId: string }>
  | Readonly<{ kind: "source"; artifactKey: string; quote?: string }>
  | Readonly<{ kind: "artifact"; artifactKey: string }>
  | Readonly<{ kind: "counterexample"; text: string }>; // at most 600 characters
export type CccReviewVerdict = Readonly<{
  verdict: "accept" | "reject";
  findings: readonly Readonly<{ ref: CccReviewFindingRef; severity: "blocking" | "advisory"; path?: string; line?: number; summary: string }>[];
}>;

// ---------------------------------------------------------------- grant, custody, fences (section 2.10)

export type CccPlanningGrantV1 = Readonly<{
  schema: "ccc-planning.grant.v1"; mode: CccPlanningMode; budgetProfile: CccPlanningBudgetProfile;
  budgetPolicyVersion: string; allocations: Readonly<{ planning: number; implementation: number; reviewProof: number }>;
  research: Readonly<{ fetches: number; bytes: number }>; deadlineAt: string; sourcePolicyId: string; amendmentSeq: number;
}>;
export type CccPlanningRunCustody = Readonly<{
  kind: "planning"; projectId: string; runId: string; planningTaskId: string; revision: number;
  state: CccPlanningRunState; mode: CccPlanningMode; budgetProfile: CccPlanningBudgetProfile;
  deadlineAt: string; grantDigest: string; controlSeq: number; importId: string | null;
  runtimeDistManifestSha256: string;
}>;
/** Ledger and artifact fence. "planning" is the planning work item; "campaign" is a planning-linked campaign item (G7/G8). */
export type CccPlanningWorkItemFence = Readonly<{
  kind: "planning" | "campaign"; workItemId: string; runId: string; attempt: number; leaseOwner: string; originTaskId: string;
}>;
export type CccPlanningReadSnapshot =
  | Readonly<{ kind: "admitted-base" }>
  | Readonly<{ kind: "candidate"; commit: string; tree: string }>; // from ccc:proof:source-commit / source-tree
export type CccPlanningRouteBinding = Readonly<{
  kind: "ccc-planning-route.v1";
  projectId: string; runId: string; runRevision: number; taskId: string; // taskId = planning task id, always
  stageId: CccPlanningStageId; roleId: CccPlanningRoleId; roleClass: CccPlanningRoleClass;
  lineageId: string; nodeAttemptOrdinal: 1 | 2 | 3; phase: "planning" | "review_proof";
  providerId: string; modelId: CccPlanningExactModelId; transport: "pi";
  receiptAdapterId: "terminal-route-sse-comments.v1";
  toolsetDigest: string; promptDigest: string; policyDigest: string; grantDigest: string;
  bindingHash: string; // cccPlanningBindingHash(all other fields)
}>;
/** Planning scope reuses the campaign scope's field names (ADR A); only binding and fence differ. */
export type CccPlanningCallScope = Readonly<Omit<CccProviderAttemptScope, "binding" | "workItemFence"> & {
  workItemFence: CccCampaignWorkItemFence; // 3-key {workItemId, runId, attempt} of the fence
  binding: CccPlanningRouteBinding;
}>;
// Field semantics: semanticTaskId = binding.lineageId; campaignDeadlineAt = run deadline_at; taskId = planning task;
// attemptOrdinal = call ordinal within the turn (1..11); requestCount = phase spent after the CAS.
export type CccPlanningCallRequest = Readonly<{
  binding: CccPlanningRouteBinding; turnKey: string; dispatchKey: string; // "pi-stream:N", N in 1..11
  fence: CccPlanningWorkItemFence; preflight: boolean;
}>;

// ---------------------------------------------------------------- status (section 2.10)

export type CccPlanningRunStatusV1 = Readonly<{
  schema: "ccc-planning.run-status.v1";
  runId: string; projectId: string; planningTaskId: string; mode: CccPlanningMode;
  budgetProfile: CccPlanningBudgetProfile; roleProfile: CccPlanningRoleProfile;
  state: CccPlanningRunState; stateCode: string | null; revision: number; controlSeq: number; deadlineAt: string;
  pendingControl: null | Readonly<{ request: "pause" | "cancel" | "resume"; revision: number; requestedAt: string }>;
  lastControl: null | Readonly<{ request: "pause" | "cancel" | "resume"; controlSeq: number; actor: string; at: string;
    route: "planning" | "campaign-bridge"; outcome: "applied" | "pending" | "deferred-leased" }>;
  awaitingDecision: null | Readonly<{ decisionId: string; questionArtifactKey: string; questionDigest: string }>;
  budgets: Readonly<{
    planning: Readonly<{ allocation: number; spent: number; preflightSpent: number }>;
    implementation: Readonly<{ allocation: number; transferred: number | null; spent: number | null }>; // spent = ccc_prd_imports.request_count
    reviewProof: Readonly<{ allocation: number; spent: number }>;
    researchFetches: Readonly<{ allocation: number; spent: number }>;
    researchBytes: Readonly<{ allocation: number; spent: number }>;
  }>;
  counters: Readonly<{ repairEpochState: "unopened" | "open" | "closed"; repairChunksUsed: number; reviewEpochs: number; stagnantEpochs: number }>;
  stages: readonly Readonly<{ stageId: CccPlanningIrStageId; status: "pending" | "running" | "committed" | "blocked" | "skipped"; artifactKeys: readonly string[] }>[];
  unreconciled: readonly Readonly<{ lineageId: string; attemptKey: string; dispatchedAt: string }>[];
  writerAttempts: readonly Readonly<{ semanticTaskId: string; dispatchAttemptOrdinal: 1 | 2 | 3; turnKey: string; calls: number }>[];
  import: null | Readonly<{ idempotencyKey: string; intentDigest: string; importId: string | null; importState: string | null }>;
  executionAuthority: null | Readonly<{ authorizationId: string; confirmation: string; command: string }>;
  notRun: readonly string[];
}>;
