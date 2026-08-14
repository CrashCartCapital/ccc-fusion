import { createHash } from "node:crypto";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import type {
  CccCampaignAuthorityBinding,
  CccCampaignExecutionAuthorizationMode,
  CccCampaignExecutionRoute,
  CccCampaignProofAttemptContractVersion,
  CccCampaignProofEvidenceV2,
  CccCampaignProofAttemptState,
  CccCampaignProofTerminalEnvelopeV2,
  CccCampaignWorkItemFence,
  CccProviderAttemptCost,
  CccProviderAttemptReceiptSource,
  CccProviderAttemptState,
  CccProviderAttemptTerminalEvidence,
  CccProviderAttemptUsage,
} from "../ccc-campaign/types.js";
import { CccCampaignContextError } from "../ccc-campaign/types.js";
import {
  listCccProviderAttemptsForCampaign,
} from "../ccc-campaign/provider-attempt.js";
import {
  assertCccCampaignAuthorityBinding,
} from "../ccc-campaign/canonical.js";
import { reconstructCccCampaignCustody } from "../ccc-campaign/custody.js";
import {
  getCccCampaignExecutionAuthorizationForImport,
  type CccCampaignExecutionAuthorization,
} from "../ccc-campaign/execution-authorization.js";
import {
  CCC_CAMPAIGN_PROOF_DEADLINE_EXPIRED_CODE,
  CCC_CAMPAIGN_PROOF_DEADLINE_EXPIRED_REASON,
} from "../ccc-campaign/types.js";
import {
  CCC_CAMPAIGN_REQUEST_BUDGET_EXHAUSTED_CODE,
  CCC_CAMPAIGN_REQUEST_BUDGET_EXHAUSTED_REASON,
} from "../ccc-campaign/request-budget.js";
import type { AsyncDataLayer } from "../postgres/data-layer.js";
import * as schema from "../postgres/schema/index.js";
import {
  normalizeApprovalRequestActionCategory,
  type ApprovalRequest as CoreApprovalRequest,
  type ApprovalRequestActionCategoryInput as CoreApprovalRequestActionCategoryInput,
} from "../types.js";
import {
  canonicalCccPrdJson,
  compareCccPrdCodeUnits,
  computeCccPrdProofDefinitionSha256,
  computeCccPrdProofV2AdmissionDigests,
} from "./contract.js";
import {
  CccPrdImportError,
} from "./import-error.js";
import { physicalCccPrdImportRoot } from "./import-admission.js";
import type {
  CccPrdProof,
  CccPrdProofPhase,
} from "./types.js";

export const CCC_PRD_PRODUCT_STATUS_SCHEMA_VERSION =
  "ccc-prd.product-status.v1" as const;
const CCC_CAMPAIGN_MERGE_APPROVAL_REQUIRED_REASON =
  "ccc-permanent:CCC_CAMPAIGN_MERGE_APPROVAL_REQUIRED";
const CCC_CAMPAIGN_LIVE_EXECUTION_APPROVAL_REQUIRED_REASON =
  "ccc-permanent:CCC_CAMPAIGN_LIVE_EXECUTION_APPROVAL_REQUIRED";
const CCC_CAMPAIGN_VERIFIER_CONFINEMENT_UNAVAILABLE_REASON =
  "ccc-permanent:CCC_CAMPAIGN_VERIFIER_CONFINEMENT_UNAVAILABLE";
const CCC_CAMPAIGN_OPERATOR_STOPPED_PREFIX =
  "ccc-operator:campaign-stopped:";

export type CccPrdProductNextActionKind =
  | "reconcile-import"
  | "wait-for-runtime"
  | "resolve-manual-required"
  | "approve-execution"
  | "approve-merge"
  | "landing-recovery"
  | "abandoned"
  | "complete"
  | "blocked";

export type CccPrdProductTaskRoute = Readonly<{
  providerId: string;
  modelId: string;
  transport: string;
  executor: string | null;
  toolMode: string | null;
  worktreeMode: string | null;
  ownedPaths: readonly string[];
  allowedWriteRoots: readonly string[];
  commitPolicy: string | null;
  cliAdapterId: string | null;
}>;

export type CccPrdProductTaskStatus = Readonly<{
  ordinal: number;
  semanticTaskId: string;
  nativeTaskId: string;
  present: boolean;
  title: string | null;
  description: string | null;
  route: CccPrdProductTaskRoute | null;
  worktree: string | null;
  branch: string | null;
  baseCommit: string | null;
  mergeCommit: string | null;
  state: Readonly<{
    column: string | null;
    status: string | null;
    paused: boolean | null;
    userPaused: boolean | null;
    pausedReason: string | null;
    error: string | null;
    updatedAt: string | null;
  }>;
}>;

export type CccPrdProductWorkItemStatus = Readonly<{
  id: string;
  runId: string;
  taskId: string;
  nodeId: string;
  kind: string;
  state: string;
  attempt: number;
  retryAfter: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  lastError: string | null;
  blockedReason: string | null;
  waitReason: string | null;
  stableWorkflowRunId: string | null;
  continuationSequence: number | null;
  createdAt: string;
  updatedAt: string;
}>;

export type CccPrdProductProofAttemptResult = Readonly<{
  success: boolean;
  exitCode: number | null;
  durationMs: number | null;
  stdoutSha256: string | null;
  stderrSha256: string | null;
  stdoutTail: string | null;
  stderrTail: string | null;
  timedOut: boolean | null;
  killed: boolean | null;
  warnings: readonly string[] | null;
  changedPathsSha256: string | null;
  negativeControlLabel: string | null;
}>;

export type CccPrdProductProofAttemptStatus = Readonly<{
  attemptKey: string;
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
  commandSha256: string;
  workItemId: string;
  runId: string;
  workItemAttempt: number;
  attemptContractVersion?: CccCampaignProofAttemptContractVersion;
  phase?: CccPrdProofPhase | null;
  verifierClosureSha256?: string | null;
  candidateInputsSha256?: string | null;
  executionToolchainSha256?: string | null;
  state: CccCampaignProofAttemptState;
  result: CccPrdProductProofAttemptResult | null;
  terminalEnvelope?: CccCampaignProofTerminalEnvelopeV2 | null;
  terminalEnvelopeSha256?: string | null;
  proofEvidence?: CccCampaignProofEvidenceV2 | null;
  proofEvidenceSha256?: string | null;
  createdAt: string;
  updatedAt: string;
  dispatchedAt: string | null;
  settledAt: string | null;
}>;

export type CccPrdProductProofStatus = Readonly<{
  definition: CccPrdProof;
  definitionSha256: string;
  attempts: readonly CccPrdProductProofAttemptStatus[];
}>;

export type CccPrdProductProviderAttemptStatus = Readonly<{
  attemptKey: string;
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
  /**
   * Flattened terminal-evidence receipt facts (effective-route-and-usage-cost
   * substrate), derived from `terminal` for direct consumption. Honestly
   * absent (undefined) whenever the attempt has no reconciled effective-route
   * receipt; data-layer only, no display strings invented here.
   */
  effectiveProvider?: string;
  effectiveModel?: string;
  effectiveReasoningEffort?: string;
  effectiveServiceTier?: string;
  usage?: CccProviderAttemptUsage | null;
  cost?: CccProviderAttemptCost;
  receiptSource?: CccProviderAttemptReceiptSource;
  binding: Readonly<CccCampaignAuthorityBinding>;
}>;

export type CccPrdProductApprovalStatus = Readonly<
  Omit<CoreApprovalRequest, "campaign">
  & {
  actionId: string;
  actionTarget: string;
  campaign: Readonly<
    Omit<NonNullable<CoreApprovalRequest["campaign"]>, "claimToken">
  >;
}>;

export type CccPrdProductExecutionAuthorizationStatus = Readonly<
  Omit<CccCampaignExecutionAuthorization, "claimToken">
>;

export type CccPrdProductLandingMetadata = Readonly<{
  schema: string | null;
  expectedBaseObject: string | null;
  sourceRef: string | null;
  targetRef: string | null;
  sourceCommit: string | null;
  treeObject: string | null;
  commitObject: string | null;
  mutationPaths: readonly string[] | null;
  admittedWriteRoots: readonly string[] | null;
  objectBaselineBefore: readonly string[] | null;
  expectedGeneratedObjectIds: readonly string[] | null;
  targetCheckoutMode: string | null;
}>;

export type CccPrdProductLandingAudit = Readonly<{
  auditId: string;
  timestamp: string;
  taskId: string | null;
  runId: string;
  eventKey: string;
  bindingHash: string;
  metadata: CccPrdProductLandingMetadata;
}>;

export type CccPrdProductStatus = Readonly<{
  schema: typeof CCC_PRD_PRODUCT_STATUS_SCHEMA_VERSION;
  observedAt: string;
  projectId: string;
  import: Readonly<{
    importId: string;
    idempotencyKey: string;
    identityHash: string;
    bundleHash: string;
    packetHash: string;
    sidecarHash: string;
    manifestHash: string;
    sourceVersion: string;
    targetRepository: string;
    targetBase: string;
    executionPolicySchema: string;
    campaignId: string;
    campaignStartedAt: string;
    campaignDeadlineAt: string;
    requestBudget: CccPrdProductRequestBudgetStatus;
    state: string;
    runnable: boolean;
    lastError: string | null;
    createdAt: string;
    updatedAt: string;
    activatedAt: string | null;
  }>;
  tasks: readonly CccPrdProductTaskStatus[];
  workItems: readonly CccPrdProductWorkItemStatus[];
  proofs: readonly CccPrdProductProofStatus[];
  orphanProofAttempts: readonly CccPrdProductProofAttemptStatus[];
  providerAttempts: readonly CccPrdProductProviderAttemptStatus[];
  executionAuthorizationMode: CccCampaignExecutionAuthorizationMode;
  executionAuthorization: CccPrdProductExecutionAuthorizationStatus | null;
  approvals: readonly CccPrdProductApprovalStatus[];
  landing: Readonly<{
    intents: readonly CccPrdProductLandingAudit[];
    materializations: readonly CccPrdProductLandingAudit[];
    terminals: readonly CccPrdProductLandingAudit[];
  }>;
  nextAction: Readonly<{
    kind: CccPrdProductNextActionKind;
    reason: string;
    approvalRequestId?: string;
    approvalStatus?: CoreApprovalRequest["status"];
    executionAuthorizationId?: string;
    executionAuthorizationStatus?: CccCampaignExecutionAuthorization["status"];
    diagnostic?: string;
    safeState?: string;
    decisionOwner?: string;
    consequence?: string;
    recoveryOptions?: readonly string[];
    nextSafeAction?: string;
  }>;
}>;

export type CccPrdProductRequestBudgetStatus = Readonly<{
  scope: "campaign-global";
  maximum: number;
  used: number;
  remaining: number;
  providerTasks: number;
  deterministicMinimum: number;
  headroomAboveMinimum: number;
  completionAdequacy: "unproven";
}>;

export type InspectCccPrdProductStatusInput = Readonly<{
  idempotencyKey: string;
  layer: AsyncDataLayer;
  rootDir: string;
}>;

type ProductImportRow = typeof schema.project.cccPrdImports.$inferSelect;
type ProductTaskRow = Pick<
  typeof schema.project.tasks.$inferSelect,
  | "id"
  | "title"
  | "description"
  | "column"
  | "status"
  | "paused"
  | "userPaused"
  | "pausedReason"
  | "error"
  | "worktree"
  | "branch"
  | "baseCommitSha"
  | "mergeDetails"
  | "updatedAt"
>;
type ProofAttemptRow =
  typeof schema.project.cccCampaignProofAttempts.$inferSelect;

function projectIdFor(layer: AsyncDataLayer): string {
  return layer.projectId?.trim() || "__legacy_unscoped__";
}

function mergeCommitFrom(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const commitSha = (value as Record<string, unknown>).commitSha;
  return typeof commitSha === "string" ? commitSha : null;
}

function routeStatus(
  route: CccCampaignExecutionRoute | undefined,
): CccPrdProductTaskRoute | null {
  if (!route) return null;
  return {
    providerId: route.providerId,
    modelId: route.modelId,
    transport: route.transport,
    executor: route.executor ?? null,
    toolMode: route.toolMode ?? null,
    worktreeMode: route.worktreeMode ?? null,
    ownedPaths: [...(route.ownedPaths ?? [])],
    allowedWriteRoots: [...(route.allowedWriteRoots ?? [])],
    commitPolicy: route.commitPolicy ?? null,
    cliAdapterId: route.cliAdapterId ?? null,
  };
}

function cloneCanonicalJson<T>(value: unknown): T {
  return JSON.parse(canonicalCccPrdJson(value)) as T;
}

function sha256CanonicalValue(value: unknown): string {
  return createHash("sha256")
    .update(canonicalCccPrdJson(value), "utf8")
    .digest("hex");
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function proofAttemptStatus(
  row: ProofAttemptRow,
): CccPrdProductProofAttemptStatus {
  const hasResult = row.resultSuccess !== null;
  return {
    attemptKey: row.attemptKey,
    importId: row.importId,
    campaignId: row.campaignId,
    taskId: row.taskId,
    semanticTaskId: row.semanticTaskId,
    proofId: row.proofId,
    packetHash: row.packetHash,
    sidecarHash: row.sidecarHash,
    bundleHash: row.bundleHash,
    manifestHash: row.manifestHash,
    campaignBindingHash: row.campaignBindingHash,
    targetRepository: row.targetRepository,
    targetBase: row.targetBase,
    sourceCommit: row.sourceCommit,
    sourceTree: row.sourceTree,
    definitionSha256: row.definitionSha256,
    commandSha256: row.commandSha256,
    workItemId: row.workItemId,
    runId: row.runId,
    workItemAttempt: row.workItemAttempt,
    ...(row.attemptContractVersion === "v2"
      ? {
        attemptContractVersion: row.attemptContractVersion,
        phase: row.phase,
        verifierClosureSha256: row.verifierClosureSha256,
        candidateInputsSha256: row.candidateInputsSha256,
        executionToolchainSha256: row.executionToolchainSha256,
      }
      : {}),
    state: row.state,
    result: hasResult
      ? {
        success: row.resultSuccess === 1,
        exitCode: row.exitCode,
        durationMs: row.durationMs,
        stdoutSha256: row.stdoutSha256,
        stderrSha256: row.stderrSha256,
        stdoutTail: row.stdoutTail,
        stderrTail: row.stderrTail,
        timedOut: row.timedOut === null ? null : row.timedOut === 1,
        killed: row.killed === null ? null : row.killed === 1,
        warnings: Array.isArray(row.warnings)
          ? row.warnings.filter((warning): warning is string => typeof warning === "string")
          : null,
        changedPathsSha256: row.changedPathsSha256,
        negativeControlLabel: row.negativeControlLabel,
      }
      : null,
    ...(row.attemptContractVersion === "v2"
      ? {
        terminalEnvelope: row.terminalEnvelope === null
          ? null
          : cloneCanonicalJson<CccCampaignProofTerminalEnvelopeV2>(
            row.terminalEnvelope,
          ),
        terminalEnvelopeSha256: row.terminalEnvelopeSha256,
        proofEvidence: row.proofEvidence === null
          ? null
          : cloneCanonicalJson<CccCampaignProofEvidenceV2>(row.proofEvidence),
        proofEvidenceSha256: row.proofEvidenceSha256,
      }
      : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    dispatchedAt: row.dispatchedAt,
    settledAt: row.settledAt,
  };
}

export function providerAttemptStatus(
  attempt: Awaited<
    ReturnType<typeof listCccProviderAttemptsForCampaign>
  >[number],
): CccPrdProductProviderAttemptStatus {
  const effectiveRoute = attempt.terminal?.kind === "reconciled" ? attempt.terminal.effectiveRoute : undefined;
  return {
    attemptKey: attempt.attemptKey,
    taskId: attempt.taskId,
    semanticTaskId: attempt.semanticTaskId,
    campaignDeadlineAt: attempt.campaignDeadlineAt,
    turnKey: attempt.turnKey,
    dispatchKey: attempt.dispatchKey,
    attemptOrdinal: attempt.attemptOrdinal,
    requestCount: attempt.requestCount,
    workItemFence: attempt.workItemFence
      ? { ...attempt.workItemFence }
      : null,
    state: attempt.state,
    ...(attempt.terminal
      ? { terminal: { ...attempt.terminal } }
      : {}),
    ...(effectiveRoute
      ? {
        effectiveProvider: effectiveRoute.effectiveProvider,
        effectiveModel: effectiveRoute.effectiveModel,
        ...(effectiveRoute.effectiveReasoningEffort !== undefined
          ? { effectiveReasoningEffort: effectiveRoute.effectiveReasoningEffort }
          : {}),
        ...(effectiveRoute.effectiveServiceTier !== undefined
          ? { effectiveServiceTier: effectiveRoute.effectiveServiceTier }
          : {}),
        usage: effectiveRoute.usage,
        cost: effectiveRoute.cost,
        receiptSource: effectiveRoute.receiptSource,
      }
      : {}),
    binding: { ...attempt.binding },
  };
}

/**
 * `listCccProviderAttemptsForCampaign` scopes its history query to the whole
 * campaign import, not to a single task (see `loadHistory` in
 * ccc-campaign/provider-attempt.ts, which filters only by `campaignImportId`
 * and validates the campaign-wide, not per-task, request-count sequence), so
 * any one persisted campaign task can anchor the lookup and the full,
 * multi-task attempt history comes back regardless of which task anchors it.
 * Refuse rather than pick an unresolvable anchor: an empty task list, or an
 * anchor task whose own row is missing from persisted custody, both make
 * `listCccProviderAttemptsForCampaign` silently return zero attempts, which
 * would hide a real `dispatched_unknown` provider attempt from status output.
 */
export function resolveCccPrdProductStatusProviderAttemptAnchorTaskId(
  taskStatuses: readonly CccPrdProductTaskStatus[],
): string {
  const anchor = taskStatuses[0];
  if (!anchor || !anchor.present) {
    throw new CccCampaignContextError(
      "CCC PRD product status has no resolvable campaign context anchor task to load provider attempts",
    );
  }
  return anchor.nativeTaskId;
}

export function providerAttemptStatusesForCampaign(
  attempts: Awaited<ReturnType<typeof listCccProviderAttemptsForCampaign>>,
): readonly CccPrdProductProviderAttemptStatus[] {
  return attempts
    .map(providerAttemptStatus)
    .sort((left, right) => {
      const byTask = compareCccPrdCodeUnits(left.taskId, right.taskId);
      if (byTask !== 0) return byTask;
      return left.requestCount - right.requestCount
        || compareCccPrdCodeUnits(left.attemptKey, right.attemptKey);
    });
}

function textMetadata(
  metadata: Record<string, unknown> | null,
  key: string,
): string | null {
  const value = metadata?.[key];
  return typeof value === "string" ? value : null;
}

function stringArrayMetadata(
  metadata: Record<string, unknown> | null,
  key: string,
): readonly string[] | null {
  const value = metadata?.[key];
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? [...value]
    : null;
}

function landingMetadata(
  value: unknown,
): CccPrdProductLandingMetadata {
  const metadata =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  const targetCheckout =
    metadata?.targetCheckout !== null
    && typeof metadata?.targetCheckout === "object"
    && !Array.isArray(metadata.targetCheckout)
      ? metadata.targetCheckout as Record<string, unknown>
      : null;
  return {
    schema: textMetadata(metadata, "schema"),
    expectedBaseObject: textMetadata(metadata, "expectedBaseObject"),
    sourceRef: textMetadata(metadata, "sourceRef"),
    targetRef: textMetadata(metadata, "targetRef"),
    sourceCommit: textMetadata(metadata, "sourceCommit"),
    treeObject: textMetadata(metadata, "treeObject"),
    commitObject: textMetadata(metadata, "commitObject"),
    mutationPaths: stringArrayMetadata(metadata, "mutationPaths"),
    admittedWriteRoots: stringArrayMetadata(metadata, "admittedWriteRoots"),
    objectBaselineBefore: stringArrayMetadata(metadata, "objectBaselineBefore"),
    expectedGeneratedObjectIds: stringArrayMetadata(
      metadata,
      "expectedGeneratedObjectIds",
    ),
    targetCheckoutMode: textMetadata(targetCheckout, "mode"),
  };
}

function cloneProof(proof: CccPrdProof): CccPrdProof {
  return JSON.parse(canonicalCccPrdJson(proof)) as CccPrdProof;
}

function approvalActorType(
  value: string,
  approvalId: string,
): CoreApprovalRequest["requester"]["actorType"] {
  if (value === "agent" || value === "user" || value === "system") return value;
  throw new CccPrdImportError(
    "CCC_PRD_IMPORT_CAMPAIGN_CUSTODY_REFUSED",
    `CCC PRD approval ${approvalId} has an invalid requester actor type`,
  );
}

function compareCreatedThenId(
  left: { createdAt: string; id?: string; attemptKey?: string },
  right: { createdAt: string; id?: string; attemptKey?: string },
): number {
  const byCreated = compareCccPrdCodeUnits(left.createdAt, right.createdAt);
  if (byCreated !== 0) return byCreated;
  return compareCccPrdCodeUnits(
    left.id ?? left.attemptKey ?? "",
    right.id ?? right.attemptKey ?? "",
  );
}

function commonPassingProofCommit(
  proofs: readonly CccPrdProductProofStatus[],
): string | null {
  const mergeProofs = proofs.filter(({ definition }) =>
    definition.schema !== "ccc-prd.proof.v2"
    || definition.phases.includes("final_integrated"));
  if (mergeProofs.length === 0) return null;
  let candidates: Set<string> | null = null;
  for (const proof of mergeProofs) {
    const passing = new Set<string>(
      proof.attempts
        .filter((attempt) => isPassingProofAttempt(proof, attempt))
        .map((attempt) => attempt.sourceCommit),
    );
    if (passing.size === 0) return null;
    if (candidates === null) {
      candidates = passing;
    } else {
      const retained = new Set<string>();
      for (const commit of candidates) {
        if (passing.has(commit)) retained.add(commit);
      }
      candidates = retained;
    }
    if (candidates.size === 0) return null;
  }
  return [...(candidates ?? [])].sort(compareCccPrdCodeUnits)[0] ?? null;
}

function isPassingProofAttempt(
  proof: CccPrdProductProofStatus,
  attempt: CccPrdProductProofAttemptStatus,
): boolean {
  if (proof.definition.schema !== "ccc-prd.proof.v2") {
    return (attempt.attemptContractVersion ?? "v1") === "v1"
      && attempt.state === "committed"
      && attempt.result?.success === true;
  }
  const envelope = attempt.terminalEnvelope;
  const evidence = attempt.proofEvidence;
  if (
    attempt.attemptContractVersion !== "v2"
    || attempt.phase !== "final_integrated"
    || !proof.definition.phases.includes("final_integrated")
    || attempt.state !== "committed"
  ) return false;
  let admissionDigests: ReturnType<
    typeof computeCccPrdProofV2AdmissionDigests
  >;
  try {
    admissionDigests = computeCccPrdProofV2AdmissionDigests(proof.definition);
  } catch {
    return false;
  }
  const expectedEvidenceResults = {
    clauseResults: [...proof.definition.clauseIds]
      .sort(compareCccPrdCodeUnits)
      .map((clauseId) => ({ clauseId, passed: true })),
    positiveCaseResults: [...proof.definition.positiveCases]
      .sort((left, right) => compareCccPrdCodeUnits(left.id, right.id))
      .map(({ id: caseId }) => ({ caseId, passed: true })),
    negativeControlResults: [...proof.definition.negativeControls]
      .sort((left, right) => compareCccPrdCodeUnits(left.id, right.id))
      .map(({ id: controlId }) => ({ controlId, passed: true })),
  };
  return attempt.definitionSha256
      === computeCccPrdProofDefinitionSha256(proof.definition)
    && attempt.proofId === proof.definition.id
    && attempt.commandSha256 === sha256Text(proof.definition.command)
    && attempt.verifierClosureSha256 === admissionDigests.verifierClosureSha256
    && attempt.candidateInputsSha256 === admissionDigests.candidateInputsSha256
    && attempt.executionToolchainSha256
      === admissionDigests.executionToolchainSha256
    && envelope?.schema === "ccc-prd.proof-terminal-envelope.v2"
    && envelope.kind === "verified"
    && envelope.phase === "final_integrated"
    && envelope.proofId === proof.definition.id
    && envelope.sourceCommit === attempt.sourceCommit
    && envelope.sourceTree === attempt.sourceTree
    && envelope.passed === true
    && evidence?.schema === "ccc-prd.proof-evidence.v2"
    && evidence.phase === "final_integrated"
    && evidence.proofId === proof.definition.id
    && evidence.sourceCommit === attempt.sourceCommit
    && evidence.sourceTree === attempt.sourceTree
    && evidence.passed === true
    && canonicalCccPrdJson({
      clauseResults: evidence.clauseResults,
      positiveCaseResults: evidence.positiveCaseResults,
      negativeControlResults: evidence.negativeControlResults,
    }) === canonicalCccPrdJson(expectedEvidenceResults)
    && attempt.terminalEnvelopeSha256 !== null
    && attempt.proofEvidenceSha256 !== null
    && attempt.terminalEnvelopeSha256 === sha256CanonicalValue(envelope)
    && attempt.proofEvidenceSha256 === sha256CanonicalValue(evidence)
    && envelope.evidenceSha256 === attempt.proofEvidenceSha256
    && canonicalCccPrdJson(envelope.evidence) === canonicalCccPrdJson(evidence);
}

function isKnownVerifierConfinementFailure(
  attempt: CccPrdProductProofAttemptStatus,
): boolean {
  if (attempt.attemptContractVersion === "v2") {
    return attempt.state === "proved_failed"
      && attempt.terminalEnvelope?.kind === "execution_refused"
      && attempt.terminalEnvelope.code === "sandbox_refused";
  }
  if (attempt.state !== "proved_failed" || !attempt.result) return false;
  const evidence = [
    attempt.result.stderrTail,
    ...(attempt.result.warnings ?? []),
  ].filter((value): value is string => typeof value === "string");
  return evidence.some((value) =>
    value.includes("bubblewrap is required for verifier confinement on Linux (")
    || value.includes(
      "sandbox-exec is required for verifier confinement on this host but was not found; refusing to run verification natively.",
    )
    || value.includes(
      "No enforced verifier sandbox backend is available on platform ",
    )
    || value.includes("failed to build Linux verifier sandbox policy ("));
}

function hasLiveRuntimeLease(
  item: CccPrdProductWorkItemStatus,
  observedAt: string,
): boolean {
  if (
    item.state !== "running"
    || item.leaseOwner === null
    || item.leaseExpiresAt === null
  ) {
    return false;
  }
  const leaseExpiresAt = Date.parse(item.leaseExpiresAt);
  const databaseObservedAt = Date.parse(observedAt);
  return Number.isFinite(leaseExpiresAt)
    && Number.isFinite(databaseObservedAt)
    && leaseExpiresAt > databaseObservedAt;
}

export type CccPrdProductNextActionInput = Readonly<{
  row: ProductImportRow;
  observedAt: string;
  requestBudget: CccPrdProductRequestBudgetStatus;
  providerAttemptHistoryConsistent?: boolean;
  taskStatuses: readonly CccPrdProductTaskStatus[];
  workItems: readonly CccPrdProductWorkItemStatus[];
  proofs: readonly CccPrdProductProofStatus[];
  orphanProofAttempts: readonly CccPrdProductProofAttemptStatus[];
  providerAttempts: readonly CccPrdProductProviderAttemptStatus[];
  approvals: readonly CccPrdProductApprovalStatus[];
  executionAuthorizationMode?: "per_task_v1" | "sealed_bundle_v1";
  executionAuthorization?: CccPrdProductExecutionAuthorizationStatus | null;
  landingIntents: readonly CccPrdProductLandingAudit[];
  landingMaterializations: readonly CccPrdProductLandingAudit[];
  landingTerminals: readonly CccPrdProductLandingAudit[];
  liveExecutionActionIds: ReadonlySet<string>;
  mergeActionIds: ReadonlySet<string>;
}>;

export function productNextAction(
  input: CccPrdProductNextActionInput,
): CccPrdProductStatus["nextAction"] {
  if (input.row.state !== "active" || input.row.runnable !== 1) {
    return {
      kind: "reconcile-import",
      reason: `Import is ${input.row.state} and must become active before runtime work.`,
    };
  }
  const operatorStopped = input.workItems.find((item) =>
    item.state === "cancelled"
    && item.lastError?.startsWith(CCC_CAMPAIGN_OPERATOR_STOPPED_PREFIX));
  if (operatorStopped) {
    return {
      kind: "abandoned",
      reason:
        `Workflow work item ${operatorStopped.id} was terminally stopped by the operator; worktrees, approvals, proof receipts, and any uncertain-effect evidence remain preserved for review.`,
    };
  }
  const proofAttempts = [
    ...input.proofs.flatMap((proof) => proof.attempts),
    ...input.orphanProofAttempts,
  ];
  const reservedProofs = proofAttempts
    .filter((attempt) => attempt.state === "reserved");
  const unknownProofs = proofAttempts
    .filter((attempt) => attempt.state === "dispatched_unknown");
  const reservedProviders = input.providerAttempts
    .filter((attempt) => attempt.state === "reserved");
  const unknownProviders = input.providerAttempts
    .filter((attempt) => attempt.state === "dispatched_unknown");
  const reservedProof = reservedProofs[0];
  const unknownProof = unknownProofs[0];
  const reservedProvider = reservedProviders[0];
  const unknownProvider = unknownProviders[0];
  const liveExecutionApprovalWorkItem = input.workItems.find((item) =>
    item.state === "manual-required"
    && item.lastError ===
      CCC_CAMPAIGN_LIVE_EXECUTION_APPROVAL_REQUIRED_REASON
    && item.blockedReason ===
      CCC_CAMPAIGN_LIVE_EXECUTION_APPROVAL_REQUIRED_REASON);
  const verifierConfinementWorkItem = input.workItems.find((item) =>
    item.state === "manual-required"
    && item.lastError ===
      CCC_CAMPAIGN_VERIFIER_CONFINEMENT_UNAVAILABLE_REASON
    && item.blockedReason ===
      CCC_CAMPAIGN_VERIFIER_CONFINEMENT_UNAVAILABLE_REASON);
  const requestBudgetExhaustionWorkItem = input.workItems.find((item) =>
    item.state === "manual-required"
    && item.lastError === CCC_CAMPAIGN_REQUEST_BUDGET_EXHAUSTED_REASON
    && item.blockedReason === CCC_CAMPAIGN_REQUEST_BUDGET_EXHAUSTED_REASON);
  const proofDeadlineExpiredWorkItem = input.workItems.find((item) =>
    item.state === "manual-required"
    && item.lastError === CCC_CAMPAIGN_PROOF_DEADLINE_EXPIRED_REASON
    && item.blockedReason === CCC_CAMPAIGN_PROOF_DEADLINE_EXPIRED_REASON);
  if (verifierConfinementWorkItem) {
    return {
      kind: "blocked",
      reason:
        "Verifier confinement is unavailable, so exact requirement proof cannot run safely.",
      diagnostic: "CCC_CAMPAIGN_VERIFIER_CONFINEMENT_UNAVAILABLE",
      safeState:
        `Workflow work item ${verifierConfinementWorkItem.id} is parked manual-required; no proof attempt or Git landing effect is assumed.`,
      decisionOwner: "Fusion host or CI runner operator",
      consequence:
        "Campaign execution cannot continue until a trusted verifier sandbox passes its functional readiness probe.",
      recoveryOptions: [
        "Repair the trusted bubblewrap or sandbox-exec backend without enabling native fallback.",
        "After readiness passes, explicitly requeue the parked work item; do not blindly retry an uncertain effect.",
        "Stop the campaign if the operator does not want to continue, preserving receipts and worktree state.",
      ],
      nextSafeAction:
        "Run the verifier-confinement readiness check on the execution host, then inspect campaign status again.",
    };
  }
  const uncertainManualWorkItem = input.workItems.find((item) =>
    item.state === "manual-required"
    && item.lastError !== CCC_CAMPAIGN_MERGE_APPROVAL_REQUIRED_REASON
    && item.lastError !== CCC_CAMPAIGN_REQUEST_BUDGET_EXHAUSTED_REASON
    && item.lastError !== CCC_CAMPAIGN_PROOF_DEADLINE_EXPIRED_REASON
    && item.id !== liveExecutionApprovalWorkItem?.id);
  // Only an unexpired lease matching the full persisted work-item fence proves
  // that the runtime still owns an uncertain effect. Task identity alone is
  // insufficient because a later retry can reuse the same task and item ID.
  const runningWorkOwnsAllUnknownEffects =
    uncertainManualWorkItem === undefined
    && (
      reservedProofs.length
      + unknownProofs.length
      + unknownProviders.length
      + reservedProviders.length
    ) > 0
    && reservedProofs.every((attempt) => input.workItems.some((item) =>
      hasLiveRuntimeLease(item, input.observedAt)
      && item.id === attempt.workItemId
      && item.runId === attempt.runId
      && item.attempt === attempt.workItemAttempt))
    && unknownProofs.every((attempt) => input.workItems.some((item) =>
      hasLiveRuntimeLease(item, input.observedAt)
      && item.id === attempt.workItemId
      && item.runId === attempt.runId
      && item.attempt === attempt.workItemAttempt))
    && unknownProviders.every((attempt) => attempt.workItemFence !== null
      && input.workItems.some((item) =>
        hasLiveRuntimeLease(item, input.observedAt)
        && item.id === attempt.workItemFence!.workItemId
        && item.runId === attempt.workItemFence!.runId
        && item.attempt === attempt.workItemFence!.attempt))
    && reservedProviders.every((attempt) => attempt.workItemFence !== null
      && input.workItems.some((item) =>
        hasLiveRuntimeLease(item, input.observedAt)
        && item.id === attempt.workItemFence!.workItemId
        && item.runId === attempt.workItemFence!.runId
        && item.attempt === attempt.workItemFence!.attempt));
  if (runningWorkOwnsAllUnknownEffects) {
    return {
      kind: "wait-for-runtime",
      reason:
        "Campaign provider/proof work is reserved or in flight and still owned by the runtime.",
    };
  }
  if (unknownProof || unknownProvider || reservedProvider || uncertainManualWorkItem) {
    return {
      kind: "resolve-manual-required",
      reason: uncertainManualWorkItem
        ? `Workflow work item ${uncertainManualWorkItem.id} requires an operator decision.`
        : unknownProof
          ? `Proof attempt ${unknownProof.attemptKey} has an uncertain external effect.`
          : unknownProvider
            ? `Provider attempt ${unknownProvider.attemptKey} has an uncertain external effect.`
            : `Provider attempt ${reservedProvider!.attemptKey} is reserved and has unresolved provider custody.`,
    };
  }
  if (proofDeadlineExpiredWorkItem) {
    const reservedDetail = reservedProof
      ? ` Proof attempt ${reservedProof.attemptKey} remains durably reserved but was not dispatched.`
      : " No proof attempt was reserved or dispatched after expiry.";
    return {
      kind: "blocked",
      reason:
        "The sealed campaign deadline expired before a new semantic proof could begin.",
      diagnostic: CCC_CAMPAIGN_PROOF_DEADLINE_EXPIRED_CODE,
      safeState:
        `Workflow work item ${proofDeadlineExpiredWorkItem.id} is parked manual-required.${reservedDetail} Existing commits, worktrees, and receipts remain preserved.`,
      decisionOwner: "Campaign operator",
      consequence:
        "This immutable import cannot start another proof or proceed to merge after its sealed deadline.",
      recoveryOptions: [
        "Retain this expired import and its receipts as immutable evidence; do not retry or requeue it.",
        "Create a fresh semantic-v2 packet, preview, and import with a new deadline.",
        "Treat prior task commits as evidence only; carrying their bytes into a new base requires separate custody and proof.",
      ],
      nextSafeAction:
        "Create and confirm a fresh semantic-v2 import with a new campaign deadline.",
    };
  }
  if (reservedProof) {
    return {
      kind: "resolve-manual-required",
      reason: `Proof attempt ${reservedProof.attemptKey} is reserved and has unresolved proof custody.`,
    };
  }
  if (
    input.taskStatuses.some((task) => !task.present || task.route === null)
    || input.orphanProofAttempts.length > 0
  ) {
    return {
      kind: "blocked",
      reason: "Persisted campaign custody is missing a task, route, or declared proof.",
    };
  }
  if (
    requestBudgetExhaustionWorkItem
    && (
      input.requestBudget.used !== input.requestBudget.maximum
      || input.providerAttemptHistoryConsistent === false
    )
  ) {
    const driftDetail = input.providerAttemptHistoryConsistent === false
      ? `${input.requestBudget.used} of ${input.requestBudget.maximum} first-time provider-attempt reservation slots are persisted as consumed, but that counter does not match the provider-attempt ledger`
      : `${input.requestBudget.used} of ${input.requestBudget.maximum} first-time provider-attempt reservation slots are persisted as consumed`;
    return {
      kind: "blocked",
      reason:
        "Request-budget exhaustion custody is inconsistent with the persisted reservation-slot counter.",
      diagnostic: "CCC_CAMPAIGN_REQUEST_BUDGET_COUNTER_DRIFT",
      safeState:
        `Workflow work item ${requestBudgetExhaustionWorkItem.id} is parked manual-required for request-budget exhaustion, but ${driftDetail}.`,
      decisionOwner: "Fusion database operator",
      consequence:
        "Campaign status cannot prove true budget exhaustion until the marker and counter are reconciled.",
      recoveryOptions: [
        "Inspect campaign provider-attempt rows and the import request_count in the same database snapshot.",
        "Reconcile missing receipts or repair the persisted marker; do not requeue the campaign from this inconsistent state.",
      ],
      nextSafeAction:
        "Run a read-only custody audit for the import row and provider-attempt ledger.",
    };
  }
  /*
  FNXC:CCCCampaignRequestBudgetStatus 2026-08-12-21:10:
  A sealed campaign cannot raise its request cap in place. Surface exhaustion
  as a terminal recovery path before the generic manual-required classifier so
  operators are never told to retry an immutable import against the same cap.
  Reserved or dispatched-unknown provider/proof attempts still dominate this
  advice because their runtime custody must be reconciled before budget finality
  is safe.
  */
  if (requestBudgetExhaustionWorkItem) {
    return {
      kind: "blocked",
      reason:
        "The campaign-global provider request budget is exhausted; this immutable import cannot resume.",
      diagnostic: CCC_CAMPAIGN_REQUEST_BUDGET_EXHAUSTED_CODE,
      safeState:
        `Workflow work item ${requestBudgetExhaustionWorkItem.id} is parked manual-required after using ${input.requestBudget.used} of ${input.requestBudget.maximum} first-time provider-attempt reservation slots; the refused next slot was not reserved or dispatched. Existing attempts, commits, worktrees, and receipts remain preserved.`,
      decisionOwner: "Campaign operator",
      consequence:
        "The same immutable import cannot resume, prove, or land because its sealed request cap cannot be raised.",
      recoveryOptions: [
        "Retain the exhausted import and its receipts as immutable evidence; do not retry or requeue it.",
        "Create a fresh source-bound packet, preview, and import with a larger campaign-global maxRequests value.",
        "Treat prior task commits as evidence only; integrating those bytes into a new base requires separate authorization and proof.",
      ],
      nextSafeAction:
        "Create and confirm a fresh sealed import with a larger campaign-global request cap.",
    };
  }
  const failedWorkItem = input.workItems.find((item) =>
    item.state === "failed"
    || item.state === "cancelled"
    || item.state === "exhausted");
  const failedProof = input.proofs.find((proof) =>
    proof.attempts.some((attempt) => attempt.state === "proved_failed")
    && !proof.attempts.some((attempt) => isPassingProofAttempt(proof, attempt)));
  const historicalVerifierFailure = input.proofs
    .filter((proof) => !proof.attempts.some((attempt) =>
      isPassingProofAttempt(proof, attempt)))
    .map((proof) => ({
      proof,
      attempt: proof.attempts.find(isKnownVerifierConfinementFailure),
    }))
    .find((candidate) => candidate.attempt !== undefined);
  if (
    historicalVerifierFailure?.attempt
    && input.landingIntents.length === 0
    && input.landingMaterializations.length === 0
    && input.landingTerminals.length === 0
  ) {
    const attempt = historicalVerifierFailure.attempt;
    const workflowState = failedWorkItem
      ? `workflow ${failedWorkItem.id} is ${failedWorkItem.state}`
      : `workflow ${attempt.workItemId} remains preserved`;
    return {
      kind: "blocked",
      reason:
        `Verifier confinement was unavailable for proof ${historicalVerifierFailure.proof.definition.id}; the infrastructure failure receipt is preserved and is not a product-test failure.`,
      diagnostic: "CCC_CAMPAIGN_VERIFIER_CONFINEMENT_UNAVAILABLE",
      safeState:
        `Proof attempt ${attempt.attemptKey} remains proved_failed at commit ${attempt.sourceCommit}; ${workflowState} and no Git landing is recorded.`,
      decisionOwner: "Fusion host or CI runner operator",
      consequence:
        "The campaign-created commit is preserved, but it has no passing requirement proof and cannot proceed to merge approval.",
      recoveryOptions: [
        "Repair the trusted bubblewrap or sandbox-exec backend without enabling native fallback.",
        "After readiness passes, explicitly requeue the failed work item and execute a fresh proof attempt bound to the preserved commit.",
        "Retain this failed receipt as infrastructure evidence; never relabel it as a planted-defect or product-test result.",
      ],
      nextSafeAction:
        "Run the verifier-confinement readiness check on the execution host, then explicitly requeue proof for the preserved source commit.",
    };
  }
  if (failedWorkItem || failedProof) {
    return {
      kind: "blocked",
      reason: failedWorkItem
        ? `Workflow work item ${failedWorkItem.id} ended as ${failedWorkItem.state}.`
        : `Proof ${failedProof!.definition.id} has no passing executed receipt.`,
    };
  }
  const passingCommit = commonPassingProofCommit(input.proofs);
  const workComplete =
    input.workItems.length > 0
    && input.workItems.every((item) =>
      item.state === "succeeded"
      || (
        item.state === "manual-required"
        && item.lastError === CCC_CAMPAIGN_MERGE_APPROVAL_REQUIRED_REASON
      ));
  if (input.landingTerminals.length > 0) {
    if (
      input.landingIntents.length < input.landingTerminals.length
      || input.landingMaterializations.length > input.landingIntents.length
      || !passingCommit
      || !workComplete
    ) {
      return {
        kind: "blocked",
        reason: "Terminal Git landing audit exists without complete matching proof and workflow custody.",
      };
    }
    return {
      kind: "complete",
      reason: "The campaign has executed proof and a terminal Git landing audit.",
    };
  }
  if (input.landingMaterializations.length > 0) {
    if (
      input.landingIntents.length === 0
      || input.landingMaterializations.length > input.landingIntents.length
    ) {
      return {
        kind: "blocked",
        reason: "A checkout-materialization receipt exists without one matching durable Git landing intent.",
      };
    }
    return {
      kind: "landing-recovery",
      reason: "The approved target checkout is exactly materialized; ref CAS and terminal settlement remain.",
    };
  }
  if (input.landingIntents.length > 0) {
    return {
      kind: "landing-recovery",
      reason: "A durable Git landing intent exists without a terminal audit.",
    };
  }
  if (passingCommit && workComplete) {
    if (input.mergeActionIds.size === 0) {
      return {
        kind: "blocked",
        reason: "Product work and proof are complete but no human merge action was declared.",
      };
    }
    const mergeApprovals = input.approvals.filter((approval) =>
      input.mergeActionIds.has(approval.actionId));
    const issuedMergeApproval = mergeApprovals.find((approval) =>
      approval.status === "issued");
    if (issuedMergeApproval) {
      return {
        kind: "approve-merge",
        reason: `Executed proof is complete at commit ${passingCommit}; exact human merge approval is next.`,
        approvalRequestId: issuedMergeApproval.id,
        approvalStatus: issuedMergeApproval.status,
      };
    }
    if (mergeApprovals.length === 0) {
      return {
        kind: "wait-for-runtime",
        reason: `Executed proof is complete at commit ${passingCommit}; the runtime has not issued the exact merge approval request yet.`,
      };
    }
    if (mergeApprovals.some((approval) => approval.status === "consumed")) {
      return {
        kind: "landing-recovery",
        reason: "Merge approval was consumed without a terminal Git landing audit.",
      };
    }
  }
  if (
    input.executionAuthorizationMode === "sealed_bundle_v1"
    && input.executionAuthorization
    && (
      input.executionAuthorization.status === "issued"
      || input.executionAuthorization.status === "claimed"
    )
  ) {
    const authorizationExpiresAt = Date.parse(input.executionAuthorization.expiresAt);
    const observedAt = Date.parse(input.observedAt);
    if (!Number.isFinite(observedAt)) {
      return {
        kind: "blocked",
        reason: "Product status could not establish an authoritative database clock.",
        diagnostic: "CCC_CAMPAIGN_STATUS_DATABASE_CLOCK_INVALID",
        nextSafeAction:
          "Preserve campaign custody and repair the product-status database clock before approving execution.",
      };
    }
    if (!Number.isFinite(authorizationExpiresAt)) {
      return {
        kind: "blocked",
        reason: "The sealed live-execution authorization window is invalid.",
        diagnostic: "CCC_CAMPAIGN_LIVE_EXECUTION_AUTHORIZATION_WINDOW_INVALID",
        nextSafeAction:
          "Preserve campaign custody and inspect the persisted parent authorization before any execution.",
      };
    }
    if (authorizationExpiresAt <= observedAt) {
      const preservedWorkItem = liveExecutionApprovalWorkItem ?? input.workItems[0];
      return {
        kind: "blocked",
        reason:
          "The sealed live-execution authorization window expired before the campaign could start or continue provider work.",
        diagnostic: "CCC_CAMPAIGN_LIVE_EXECUTION_AUTHORIZATION_EXPIRED",
        safeState: preservedWorkItem
          ? `Workflow work item ${preservedWorkItem.id} remains ${preservedWorkItem.state}; no new provider effect may start under the expired parent authorization. Existing attempts, worktrees, and receipts remain preserved.`
          : "No new provider effect may start under the expired parent authorization. Existing attempts, worktrees, and receipts remain preserved.",
        decisionOwner: "Campaign operator",
        consequence:
          "This immutable import cannot authorize a new provider request after its sealed deadline.",
        recoveryOptions: [
          "Retain this expired import and its persisted custody as immutable evidence; do not retry its authorization.",
          "Create a fresh semantic-v2 preview and import with a new campaign deadline.",
          "Confirm only the new parent authorization emitted by that fresh import.",
        ],
        nextSafeAction:
          "Create and confirm a fresh semantic-v2 import with a new campaign deadline.",
      };
    }
  }
  if (liveExecutionApprovalWorkItem) {
    if (input.executionAuthorizationMode === "sealed_bundle_v1") {
      const authorization = input.executionAuthorization;
      if (!authorization) {
        return {
          kind: "blocked",
          reason:
            `Workflow work item ${liveExecutionApprovalWorkItem.id} is parked for sealed live execution, but its single campaign authorization is missing.`,
          diagnostic: "The runtime did not persist the parent authorization required by manifest-v2 custody.",
          nextSafeAction: "Preserve the campaign and inspect runtime authorization issuance; do not approve diagnostic child rows.",
        };
      }
      if (authorization.status === "issued" || authorization.status === "claimed") {
        return {
          kind: "approve-execution",
          reason:
            `Workflow work item ${liveExecutionApprovalWorkItem.id} requires one sealed launch decision for ${authorization.members.length} exact campaign action${authorization.members.length === 1 ? "" : "s"}.`,
          executionAuthorizationId: authorization.authorizationId,
          executionAuthorizationStatus: authorization.status,
        };
      }
      return {
        kind: "blocked",
        reason:
          `Workflow work item ${liveExecutionApprovalWorkItem.id} is parked for live execution after sealed authorization ${authorization.authorizationId} became ${authorization.status}.`,
        diagnostic: "A terminal parent authorization cannot be reused to launch new work.",
        nextSafeAction: "Preserve campaign custody and reconcile the terminal authorization before any further execution.",
      };
    }
    /*
    A multi-task campaign holds once per task, but the parked work item's `taskId` stays pinned
    to the workflow entry task for the whole campaign. Matching the approval by the WORK ITEM's
    task ID therefore surfaces only the first task's approval; once that one is consumed and the
    second task's approval is issued (its own distinct id and taskId), the guided next action
    degraded to `blocked` while a claimable approval was sitting unclaimed. Match on the
    approval's own identity instead and surface the earliest unconsumed one, so the operator is
    walked through the holds in the order the runtime issued them.

    An ISSUED approval always outranks a CLAIMED one. Concurrent fan-out branches can leave one
    branch's approval claimed but unconsumed (its dispatch was aborted when the sibling branch
    parked); approve-execution on that claimed approval is an idempotent replay, so guiding at it
    while a sibling still waits ISSUED walks the operator in a circle. Claimed-only guidance
    remains for crash recovery, where the replay is exactly what re-queues the work item.
    */
    const approval = input.approvals
      .filter((candidate) =>
        input.liveExecutionActionIds.has(candidate.actionId)
        && (candidate.status === "issued" || candidate.status === "claimed"))
      .sort((left, right) =>
        Number(left.status === "claimed") - Number(right.status === "claimed")
        || left.requestedAt.localeCompare(right.requestedAt)
        || left.createdAt.localeCompare(right.createdAt)
        || left.id.localeCompare(right.id))[0];
    if (approval) {
      const heldTask = approval.taskId && approval.taskId !== liveExecutionApprovalWorkItem.taskId
        ? ` for campaign task ${approval.taskId}`
        : "";
      return {
        kind: "approve-execution",
        reason: `Workflow work item ${liveExecutionApprovalWorkItem.id} requires exact live-execution approval${heldTask}.`,
        approvalRequestId: approval.id,
        approvalStatus: approval.status,
      };
    }
  }
  if (
    input.workItems.some((item) =>
      item.state === "runnable"
      || item.state === "running"
      || item.state === "held"
      || item.state === "retrying")
    || input.proofs.some((proof) =>
      proof.attempts.some((attempt) => attempt.state === "reserved"))
    || input.approvals.some((approval) => approval.status === "claimed")
  ) {
    return {
      kind: "wait-for-runtime",
      reason: "Campaign work is admitted and still owned by the runtime.",
    };
  }
  return {
    kind: "blocked",
    reason: "Campaign state has no safe automatic transition.",
  };
}

export async function inspectCccPrdProductStatus(
  input: InspectCccPrdProductStatusInput,
): Promise<CccPrdProductStatus | null> {
  const rootDir = await physicalCccPrdImportRoot(input.rootDir);
  const projectId = projectIdFor(input.layer);
  return input.layer.transaction(async (tx) => {
    const importRows = await tx
      .select()
      .from(schema.project.cccPrdImports)
      .where(and(
        eq(schema.project.cccPrdImports.projectId, projectId),
        eq(schema.project.cccPrdImports.idempotencyKey, input.idempotencyKey),
      ))
      .limit(1);
    const row = importRows[0];
    if (!row) return null;
    if (row.rootDir !== rootDir) {
      throw new CccPrdImportError(
        "CCC_PRD_IMPORT_ROOT_MISMATCH",
        `CCC PRD import ${row.importId} belongs to ${row.rootDir}, not ${rootDir}`,
      );
    }

    const custody = reconstructCccCampaignCustody(row);
    const entityRows = await tx
      .select()
      .from(schema.project.cccPrdImportEntities)
      .where(and(
        eq(schema.project.cccPrdImportEntities.projectId, projectId),
        eq(schema.project.cccPrdImportEntities.importId, row.importId),
      ));
    const taskEntities = entityRows
      .filter((entity) => entity.entityType === "task")
      .sort((left, right) =>
        left.ordinal - right.ordinal
        || compareCccPrdCodeUnits(left.entityId, right.entityId));
    const nativeTaskIds = taskEntities.map((entity) => entity.nativeId);
    const taskRows = nativeTaskIds.length === 0
      ? []
      : await tx
        .select({
          id: schema.project.tasks.id,
          title: schema.project.tasks.title,
          description: schema.project.tasks.description,
          column: schema.project.tasks.column,
          status: schema.project.tasks.status,
          paused: schema.project.tasks.paused,
          userPaused: schema.project.tasks.userPaused,
          pausedReason: schema.project.tasks.pausedReason,
          error: schema.project.tasks.error,
          worktree: schema.project.tasks.worktree,
          branch: schema.project.tasks.branch,
          baseCommitSha: schema.project.tasks.baseCommitSha,
          mergeDetails: schema.project.tasks.mergeDetails,
          updatedAt: schema.project.tasks.updatedAt,
        })
        .from(schema.project.tasks)
        .where(and(
          eq(schema.project.tasks.projectId, projectId),
          inArray(schema.project.tasks.id, nativeTaskIds),
        ));
    const taskById = new Map(
      (taskRows as ProductTaskRow[]).map((task) => [task.id, task]),
    );
    const routeBySemanticTaskId = new Map(
      custody.executionPolicy.routes.map((route) => [route.taskId, route]),
    );
    const taskStatuses: CccPrdProductTaskStatus[] = taskEntities.map((entity) => {
      const task = taskById.get(entity.nativeId);
      return {
        ordinal: entity.ordinal,
        semanticTaskId: entity.entityId,
        nativeTaskId: entity.nativeId,
        present: task !== undefined,
        title: task?.title ?? null,
        description: task?.description ?? null,
        route: routeStatus(routeBySemanticTaskId.get(entity.entityId)),
        worktree: task?.worktree ?? null,
        branch: task?.branch ?? null,
        baseCommit: task?.baseCommitSha ?? null,
        mergeCommit: mergeCommitFrom(task?.mergeDetails),
        state: {
          column: task?.column ?? null,
          status: task?.status ?? null,
          paused: task ? task.paused === 1 : null,
          userPaused: task ? task.userPaused === 1 : null,
          pausedReason: task?.pausedReason ?? null,
          error: task?.error ?? null,
          updatedAt: task?.updatedAt ?? null,
        },
      };
    });
    const campaignRunId = `ccc-prd:${row.importId}`;
    const workItemRows = await tx
      .select()
      .from(schema.project.workflowWorkItems)
      .where(and(
        eq(schema.project.workflowWorkItems.projectId, projectId),
        or(
          eq(schema.project.workflowWorkItems.runId, campaignRunId),
          eq(schema.project.workflowWorkItems.stableWorkflowRunId, campaignRunId),
        ),
      ));
    const workItems: CccPrdProductWorkItemStatus[] = workItemRows
      .map((item) => ({
        id: item.id,
        runId: item.runId,
        taskId: item.taskId,
        nodeId: item.nodeId,
        kind: item.kind,
        state: item.state,
        attempt: item.attempt,
        retryAfter: item.retryAfter,
        leaseOwner: item.leaseOwner,
        leaseExpiresAt: item.leaseExpiresAt,
        lastError: item.lastError,
        blockedReason: item.blockedReason,
        waitReason: item.waitReason,
        stableWorkflowRunId: item.stableWorkflowRunId,
        continuationSequence: item.continuationSequence,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      }))
      .sort(compareCreatedThenId);

    const proofAttemptRows = await tx
      .select({
        attemptKey: schema.project.cccCampaignProofAttempts.attemptKey,
        importId: schema.project.cccCampaignProofAttempts.importId,
        campaignId: schema.project.cccCampaignProofAttempts.campaignId,
        taskId: schema.project.cccCampaignProofAttempts.taskId,
        semanticTaskId: schema.project.cccCampaignProofAttempts.semanticTaskId,
        proofId: schema.project.cccCampaignProofAttempts.proofId,
        packetHash: schema.project.cccCampaignProofAttempts.packetHash,
        sidecarHash: schema.project.cccCampaignProofAttempts.sidecarHash,
        bundleHash: schema.project.cccCampaignProofAttempts.bundleHash,
        manifestHash: schema.project.cccCampaignProofAttempts.manifestHash,
        campaignBindingHash: schema.project.cccCampaignProofAttempts.campaignBindingHash,
        targetRepository: schema.project.cccCampaignProofAttempts.targetRepository,
        targetBase: schema.project.cccCampaignProofAttempts.targetBase,
        sourceCommit: schema.project.cccCampaignProofAttempts.sourceCommit,
        sourceTree: schema.project.cccCampaignProofAttempts.sourceTree,
        definitionSha256: schema.project.cccCampaignProofAttempts.definitionSha256,
        commandSha256: schema.project.cccCampaignProofAttempts.commandSha256,
        workItemId: schema.project.cccCampaignProofAttempts.workItemId,
        runId: schema.project.cccCampaignProofAttempts.runId,
        workItemAttempt: schema.project.cccCampaignProofAttempts.workItemAttempt,
        attemptContractVersion:
          schema.project.cccCampaignProofAttempts.attemptContractVersion,
        phase: schema.project.cccCampaignProofAttempts.phase,
        verifierClosureSha256:
          schema.project.cccCampaignProofAttempts.verifierClosureSha256,
        candidateInputsSha256:
          schema.project.cccCampaignProofAttempts.candidateInputsSha256,
        executionToolchainSha256:
          schema.project.cccCampaignProofAttempts.executionToolchainSha256,
        state: schema.project.cccCampaignProofAttempts.state,
        resultSuccess: schema.project.cccCampaignProofAttempts.resultSuccess,
        exitCode: schema.project.cccCampaignProofAttempts.exitCode,
        durationMs: schema.project.cccCampaignProofAttempts.durationMs,
        stdoutSha256: schema.project.cccCampaignProofAttempts.stdoutSha256,
        stderrSha256: schema.project.cccCampaignProofAttempts.stderrSha256,
        stdoutTail: schema.project.cccCampaignProofAttempts.stdoutTail,
        stderrTail: schema.project.cccCampaignProofAttempts.stderrTail,
        timedOut: schema.project.cccCampaignProofAttempts.timedOut,
        killed: schema.project.cccCampaignProofAttempts.killed,
        warnings: schema.project.cccCampaignProofAttempts.warnings,
        changedPathsSha256: schema.project.cccCampaignProofAttempts.changedPathsSha256,
        negativeControlLabel: schema.project.cccCampaignProofAttempts.negativeControlLabel,
        terminalEnvelope:
          schema.project.cccCampaignProofAttempts.terminalEnvelope,
        terminalEnvelopeSha256:
          schema.project.cccCampaignProofAttempts.terminalEnvelopeSha256,
        proofEvidence: schema.project.cccCampaignProofAttempts.proofEvidence,
        proofEvidenceSha256:
          schema.project.cccCampaignProofAttempts.proofEvidenceSha256,
        createdAt: schema.project.cccCampaignProofAttempts.createdAt,
        updatedAt: schema.project.cccCampaignProofAttempts.updatedAt,
        dispatchedAt: schema.project.cccCampaignProofAttempts.dispatchedAt,
        settledAt: schema.project.cccCampaignProofAttempts.settledAt,
      })
      .from(schema.project.cccCampaignProofAttempts)
      .where(and(
        eq(schema.project.cccCampaignProofAttempts.projectId, projectId),
        eq(schema.project.cccCampaignProofAttempts.importId, row.importId),
      ));
    const allAttempts = (proofAttemptRows as ProofAttemptRow[])
      .map(proofAttemptStatus)
      .sort(compareCreatedThenId);
    const attemptsByProofId = new Map<string, CccPrdProductProofAttemptStatus[]>();
    for (const attempt of allAttempts) {
      const attempts = attemptsByProofId.get(attempt.proofId) ?? [];
      attempts.push(attempt);
      attemptsByProofId.set(attempt.proofId, attempts);
    }
    const proofs: CccPrdProductProofStatus[] = custody.bundle.proofs
      .map((proof) => ({
        definition: cloneProof(proof),
        definitionSha256: computeCccPrdProofDefinitionSha256(proof),
        attempts: attemptsByProofId.get(proof.id) ?? [],
      }))
      .sort((left, right) =>
        compareCccPrdCodeUnits(left.definition.id, right.definition.id));
    const declaredProofIds = new Set(proofs.map(({ definition }) => definition.id));
    const orphanProofAttempts = allAttempts.filter((attempt) =>
      !declaredProofIds.has(attempt.proofId));

    const approvalRows = await tx
      .select({
        projectId: schema.project.approvalRequests.projectId,
        id: schema.project.approvalRequests.id,
        status: schema.project.approvalRequests.status,
        requesterActorId: schema.project.approvalRequests.requesterActorId,
        requesterActorType: schema.project.approvalRequests.requesterActorType,
        requesterActorName: schema.project.approvalRequests.requesterActorName,
        targetActionCategory: schema.project.approvalRequests.targetActionCategory,
        targetActionOperation: schema.project.approvalRequests.targetActionOperation,
        targetActionSummary: schema.project.approvalRequests.targetActionSummary,
        targetResourceType: schema.project.approvalRequests.targetResourceType,
        targetResourceId: schema.project.approvalRequests.targetResourceId,
        targetContext: schema.project.approvalRequests.targetContext,
        taskId: schema.project.approvalRequests.taskId,
        runId: schema.project.approvalRequests.runId,
        actionId: schema.project.approvalRequests.campaignActionId,
        actionTarget: schema.project.approvalRequests.campaignActionTarget,
        requestedAt: schema.project.approvalRequests.requestedAt,
        notBeforeAt: schema.project.approvalRequests.notBeforeAt,
        expiresAt: schema.project.approvalRequests.expiresAt,
        claimedAt: schema.project.approvalRequests.claimedAt,
        decidedAt: schema.project.approvalRequests.decidedAt,
        completedAt: schema.project.approvalRequests.completedAt,
        createdAt: schema.project.approvalRequests.createdAt,
        updatedAt: schema.project.approvalRequests.updatedAt,
        campaignProjectId: schema.project.approvalRequests.campaignProjectId,
        campaignImportId: schema.project.approvalRequests.campaignImportId,
        campaignId: schema.project.approvalRequests.campaignId,
        campaignTaskId: schema.project.approvalRequests.campaignTaskId,
        campaignIdempotencyKey: schema.project.approvalRequests.campaignIdempotencyKey,
        campaignPacketHash: schema.project.approvalRequests.campaignPacketHash,
        campaignSidecarHash: schema.project.approvalRequests.campaignSidecarHash,
        campaignBundleHash: schema.project.approvalRequests.campaignBundleHash,
        campaignTargetRepository: schema.project.approvalRequests.campaignTargetRepository,
        campaignTargetBase: schema.project.approvalRequests.campaignTargetBase,
        campaignProviderId: schema.project.approvalRequests.campaignProviderId,
        campaignModelId: schema.project.approvalRequests.campaignModelId,
        campaignTransport: schema.project.approvalRequests.campaignTransport,
        campaignManifestHash: schema.project.approvalRequests.campaignManifestHash,
        bindingHash: schema.project.approvalRequests.campaignBindingHash,
      })
      .from(schema.project.approvalRequests)
      .where(and(
        eq(schema.project.approvalRequests.projectId, projectId),
        eq(schema.project.approvalRequests.campaignImportId, row.importId),
      ));
    const approvals: CccPrdProductApprovalStatus[] = approvalRows
      .map((approval) => {
        const campaignValues = [
          approval.campaignProjectId,
          approval.campaignImportId,
          approval.campaignId,
          approval.campaignTaskId,
          approval.actionId,
          approval.actionTarget,
          approval.campaignIdempotencyKey,
          approval.campaignPacketHash,
          approval.campaignSidecarHash,
          approval.campaignBundleHash,
          approval.campaignTargetRepository,
          approval.campaignTargetBase,
          approval.campaignProviderId,
          approval.campaignModelId,
          approval.campaignTransport,
          approval.campaignManifestHash,
          approval.bindingHash,
          approval.notBeforeAt,
          approval.expiresAt,
        ];
        if (campaignValues.some((value) => value === null)) {
          throw new CccPrdImportError(
            "CCC_PRD_IMPORT_CAMPAIGN_CUSTODY_REFUSED",
            `CCC PRD approval ${approval.id} has partial campaign custody`,
          );
        }
        const requesterActorType = approvalActorType(
          approval.requesterActorType,
          approval.id,
        );
        const targetContext =
          approval.targetContext !== null
          && typeof approval.targetContext === "object"
          && !Array.isArray(approval.targetContext)
            ? approval.targetContext as Record<string, unknown>
            : {};
        const binding = assertCccCampaignAuthorityBinding({
          projectId: approval.campaignProjectId!,
          importId: approval.campaignImportId!,
          campaignId: approval.campaignId!,
          taskId: approval.campaignTaskId!,
          actionId: approval.actionId!,
          actionTarget: approval.actionTarget!,
          idempotencyKey: approval.campaignIdempotencyKey!,
          packetHash: approval.campaignPacketHash!,
          sidecarHash: approval.campaignSidecarHash!,
          bundleHash: approval.campaignBundleHash!,
          targetRepository: approval.campaignTargetRepository!,
          targetBase: approval.campaignTargetBase!,
          providerId: approval.campaignProviderId!,
          modelId: approval.campaignModelId!,
          transport: approval.campaignTransport! as
            typeof custody.executionPolicy.routes[number]["transport"],
          manifestHash: approval.campaignManifestHash!,
          bindingHash: approval.bindingHash!,
        });
        return {
          id: approval.id,
          status: approval.status as CoreApprovalRequest["status"],
          requester: {
            actorId: approval.requesterActorId,
            actorType: requesterActorType,
            actorName: approval.requesterActorName,
          },
          targetAction: {
            category: normalizeApprovalRequestActionCategory(
              approval.targetActionCategory as
                CoreApprovalRequestActionCategoryInput,
            ),
            action: approval.targetActionOperation,
            summary: approval.targetActionSummary,
            resourceType: approval.targetResourceType,
            resourceId: approval.targetResourceId,
            context: targetContext,
          },
          ...(approval.taskId === null ? {} : { taskId: approval.taskId }),
          ...(approval.runId === null ? {} : { runId: approval.runId }),
          requestedAt: approval.requestedAt,
          ...(approval.decidedAt === null
            ? {}
            : { decidedAt: approval.decidedAt }),
          ...(approval.completedAt === null
            ? {}
            : { completedAt: approval.completedAt }),
          createdAt: approval.createdAt,
          updatedAt: approval.updatedAt,
          actionId: approval.actionId!,
          actionTarget: approval.actionTarget!,
          campaign: {
            binding,
            notBeforeAt: approval.notBeforeAt!,
            expiresAt: approval.expiresAt!,
            ...(approval.claimedAt === null
              ? {}
              : { claimedAt: approval.claimedAt }),
          },
        };
      })
      .sort(compareCreatedThenId);

    const persistedExecutionAuthorization =
      await getCccCampaignExecutionAuthorizationForImport(tx, row.importId);
    const executionAuthorization = persistedExecutionAuthorization
      ? (() => {
        if (
          persistedExecutionAuthorization.projectId !== projectId
          || persistedExecutionAuthorization.importId !== row.importId
          || persistedExecutionAuthorization.campaignId !== custody.manifest.campaignId
          || persistedExecutionAuthorization.manifestHash !== custody.manifestHash
          || persistedExecutionAuthorization.packetHash !== row.packetHash
          || persistedExecutionAuthorization.sidecarHash !== row.sidecarHash
          || persistedExecutionAuthorization.bundleHash !== row.bundleHash
          || persistedExecutionAuthorization.targetRepository !== row.targetRepository
          || persistedExecutionAuthorization.targetBase !== row.targetBase
          || persistedExecutionAuthorization.maxRequests !== custody.manifest.bounds.maxRequests
          || persistedExecutionAuthorization.maxConcurrency !== custody.manifest.bounds.maxConcurrency
        ) {
          throw new CccPrdImportError(
            "CCC_PRD_IMPORT_CAMPAIGN_CUSTODY_REFUSED",
            `CCC PRD execution authorization ${persistedExecutionAuthorization.authorizationId} drifted from import custody`,
          );
        }
        const { claimToken: _claimToken, ...redacted } = persistedExecutionAuthorization;
        return redacted;
      })()
      : null;

    const landingRows = await tx
      .select({
        auditId: schema.project.runAuditEvents.id,
        timestamp: schema.project.runAuditEvents.timestamp,
        taskId: schema.project.runAuditEvents.taskId,
        runId: schema.project.runAuditEvents.runId,
        mutationType: schema.project.runAuditEvents.mutationType,
        metadata: schema.project.runAuditEvents.metadata,
        eventKey: schema.project.runAuditEvents.campaignEventKey,
        bindingHash: schema.project.runAuditEvents.campaignBindingHash,
      })
      .from(schema.project.runAuditEvents)
      .where(and(
        eq(schema.project.runAuditEvents.projectId, projectId),
        eq(schema.project.runAuditEvents.campaignImportId, row.importId),
        eq(schema.project.runAuditEvents.domain, "git"),
        inArray(schema.project.runAuditEvents.mutationType, [
          "ccc-campaign-git-landing:intent",
          "ccc-campaign-git-landing:checkout-materialized",
          "ccc-campaign-git-landing:terminal",
        ]),
      ));
    const mappedLanding = landingRows
      .filter((landing): landing is typeof landing & {
        eventKey: string;
        bindingHash: string;
      } => landing.eventKey !== null && landing.bindingHash !== null)
      .map((landing) => ({
        auditId: landing.auditId,
        timestamp: landing.timestamp,
        taskId: landing.taskId,
        runId: landing.runId,
        eventKey: landing.eventKey,
        bindingHash: landing.bindingHash,
        metadata: landingMetadata(landing.metadata),
        mutationType: landing.mutationType,
      }))
      .sort((left, right) => {
        const byTimestamp = compareCccPrdCodeUnits(left.timestamp, right.timestamp);
        return byTimestamp !== 0
          ? byTimestamp
          : compareCccPrdCodeUnits(left.auditId, right.auditId);
      });
    const landingIntents: CccPrdProductLandingAudit[] = mappedLanding
      .filter((landing) =>
        landing.mutationType === "ccc-campaign-git-landing:intent")
      .map(({ mutationType: _mutationType, ...landing }) => landing);
    const landingTerminals: CccPrdProductLandingAudit[] = mappedLanding
      .filter((landing) =>
        landing.mutationType === "ccc-campaign-git-landing:terminal")
      .map(({ mutationType: _mutationType, ...landing }) => landing);
    const landingMaterializations: CccPrdProductLandingAudit[] = mappedLanding
      .filter((landing) =>
        landing.mutationType === "ccc-campaign-git-landing:checkout-materialized")
      .map(({ mutationType: _mutationType, ...landing }) => landing);
    const mergeActionIds = new Set(
      custody.bundle.protectedActions
        .filter((action) => action.kind === "merge")
        .map((action) => action.id),
    );
    const liveExecutionActionIds = new Set(
      custody.bundle.protectedActions
        .filter((action) => action.kind === "live_execution")
        .map((action) => action.id),
    );
    const providerTasks = custody.executionPolicy.routes.length;
    const requestBudget: CccPrdProductRequestBudgetStatus = {
      scope: "campaign-global",
      maximum: custody.manifest.bounds.maxRequests,
      used: row.requestCount,
      remaining: Math.max(
        0,
        custody.manifest.bounds.maxRequests - row.requestCount,
      ),
      providerTasks,
      deterministicMinimum: providerTasks,
      headroomAboveMinimum:
        custody.manifest.bounds.maxRequests - providerTasks,
      completionAdequacy: "unproven",
    };
    let providerAttempts: readonly CccPrdProductProviderAttemptStatus[] = [];
    let providerAttemptHistoryConsistent = true;
    try {
      providerAttempts = providerAttemptStatusesForCampaign(
        await listCccProviderAttemptsForCampaign({
          layer: input.layer,
          rootDir,
          taskId: resolveCccPrdProductStatusProviderAttemptAnchorTaskId(taskStatuses),
          tx,
        }),
      );
    } catch (error) {
      const hasBudgetExhaustionMarker = workItems.some((item) =>
        item.state === "manual-required"
        && item.lastError === CCC_CAMPAIGN_REQUEST_BUDGET_EXHAUSTED_REASON
        && item.blockedReason === CCC_CAMPAIGN_REQUEST_BUDGET_EXHAUSTED_REASON);
      if (
        !(error instanceof CccCampaignContextError)
        || !error.message.includes("request count")
        || !hasBudgetExhaustionMarker
      ) {
        throw error;
      }
      providerAttemptHistoryConsistent = false;
    }
    // Read the authority clock after collecting the status snapshot so an
    // authorization that expires during inspection is never advertised as
    // actionable in the returned result.
    const databaseClockRows = await tx.execute(sql`
      SELECT to_char(
        clock_timestamp() AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ) AS now
    `) as unknown as Array<{ now: string }>;
    const observedAt = databaseClockRows[0]?.now;
    if (typeof observedAt !== "string" || !Number.isFinite(Date.parse(observedAt))) {
      throw new CccPrdImportError(
        "CCC_PRD_PRODUCT_STATUS_DATABASE_CLOCK_INVALID",
        "CCC PRD product status could not read the canonical database clock",
      );
    }
    const nextAction = productNextAction({
      row,
      observedAt,
      requestBudget,
      providerAttemptHistoryConsistent,
      taskStatuses,
      workItems,
      proofs,
      orphanProofAttempts,
      providerAttempts,
      approvals,
      executionAuthorizationMode: custody.executionAuthorizationMode,
      executionAuthorization,
      landingIntents,
      landingMaterializations,
      landingTerminals,
      liveExecutionActionIds,
      mergeActionIds,
    });

    return {
      schema: CCC_PRD_PRODUCT_STATUS_SCHEMA_VERSION,
      observedAt,
      projectId,
      import: {
        importId: row.importId,
        idempotencyKey: row.idempotencyKey,
        identityHash: row.identityHash,
        bundleHash: row.bundleHash,
        packetHash: row.packetHash,
        sidecarHash: row.sidecarHash,
        manifestHash: custody.manifestHash,
        sourceVersion: row.sourceVersion,
        targetRepository: row.targetRepository,
        targetBase: row.targetBase,
        executionPolicySchema: custody.executionPolicy.schema,
        campaignId: custody.manifest.campaignId,
        campaignStartedAt: custody.manifest.campaignStartedAt,
        campaignDeadlineAt: custody.manifest.campaignDeadlineAt,
        requestBudget,
        state: row.state,
        runnable: row.runnable === 1,
        lastError: row.lastError,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        activatedAt: row.activatedAt,
      },
      tasks: taskStatuses,
      workItems,
      proofs,
      orphanProofAttempts,
      providerAttempts,
      executionAuthorizationMode: custody.executionAuthorizationMode,
      executionAuthorization,
      approvals,
      landing: {
        intents: landingIntents,
        materializations: landingMaterializations,
        terminals: landingTerminals,
      },
      nextAction,
    };
  }, {
    isolationLevel: "repeatable read",
    accessMode: "read only",
  });
}
