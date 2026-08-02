import { and, eq, inArray, or } from "drizzle-orm";
import type {
  CccCampaignAuthorityBinding,
  CccCampaignExecutionRoute,
  CccCampaignProofAttemptState,
  CccCampaignWorkItemFence,
  CccProviderAttemptCost,
  CccProviderAttemptReceiptSource,
  CccProviderAttemptState,
  CccProviderAttemptTerminalEvidence,
  CccProviderAttemptUsage,
} from "../ccc-campaign/types.js";
import {
  listCccProviderAttemptsForCampaign,
} from "../ccc-campaign/provider-attempt.js";
import {
  assertCccCampaignAuthorityBinding,
} from "../ccc-campaign/canonical.js";
import { reconstructCccCampaignCustody } from "../ccc-campaign/custody.js";
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
} from "./contract.js";
import {
  CccPrdImportError,
} from "./import-error.js";
import { physicalCccPrdImportRoot } from "./import-admission.js";
import type {
  CccPrdProof,
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
  state: CccCampaignProofAttemptState;
  result: CccPrdProductProofAttemptResult | null;
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
    diagnostic?: string;
    safeState?: string;
    decisionOwner?: string;
    consequence?: string;
    recoveryOptions?: readonly string[];
    nextSafeAction?: string;
  }>;
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
  if (proofs.length === 0) return null;
  let candidates: Set<string> | null = null;
  for (const proof of proofs) {
    const passing = new Set<string>(
      proof.attempts
        .filter((attempt) =>
          attempt.state === "committed"
          && attempt.result?.success === true)
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

function isKnownVerifierConfinementFailure(
  attempt: CccPrdProductProofAttemptStatus,
): boolean {
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

function hasLiveRuntimeLease(item: CccPrdProductWorkItemStatus): boolean {
  if (
    item.state !== "running"
    || item.leaseOwner === null
    || item.leaseExpiresAt === null
  ) {
    return false;
  }
  const leaseExpiresAt = Date.parse(item.leaseExpiresAt);
  return Number.isFinite(leaseExpiresAt) && leaseExpiresAt > Date.now();
}

function productNextAction(input: {
  row: ProductImportRow;
  taskStatuses: readonly CccPrdProductTaskStatus[];
  workItems: readonly CccPrdProductWorkItemStatus[];
  proofs: readonly CccPrdProductProofStatus[];
  orphanProofAttempts: readonly CccPrdProductProofAttemptStatus[];
  providerAttempts: readonly CccPrdProductProviderAttemptStatus[];
  approvals: readonly CccPrdProductApprovalStatus[];
  landingIntents: readonly CccPrdProductLandingAudit[];
  landingMaterializations: readonly CccPrdProductLandingAudit[];
  landingTerminals: readonly CccPrdProductLandingAudit[];
  liveExecutionActionIds: ReadonlySet<string>;
  mergeActionIds: ReadonlySet<string>;
}): CccPrdProductStatus["nextAction"] {
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
  const unknownProofs = input.proofs
    .flatMap((proof) => proof.attempts)
    .filter((attempt) => attempt.state === "dispatched_unknown");
  const unknownProviders = input.providerAttempts
    .filter((attempt) => attempt.state === "dispatched_unknown");
  const unknownProof = unknownProofs[0];
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
    && item.id !== liveExecutionApprovalWorkItem?.id);
  // Only an unexpired lease matching the full persisted work-item fence proves
  // that the runtime still owns an uncertain effect. Task identity alone is
  // insufficient because a later retry can reuse the same task and item ID.
  const runningWorkOwnsAllUnknownEffects =
    uncertainManualWorkItem === undefined
    && (unknownProofs.length + unknownProviders.length) > 0
    && unknownProofs.every((attempt) => input.workItems.some((item) =>
      hasLiveRuntimeLease(item)
      && item.id === attempt.workItemId
      && item.runId === attempt.runId
      && item.attempt === attempt.workItemAttempt))
    && unknownProviders.every((attempt) => attempt.workItemFence !== null
      && input.workItems.some((item) =>
        hasLiveRuntimeLease(item)
        && item.id === attempt.workItemFence!.workItemId
        && item.runId === attempt.workItemFence!.runId
        && item.attempt === attempt.workItemFence!.attempt));
  if (runningWorkOwnsAllUnknownEffects) {
    return {
      kind: "wait-for-runtime",
      reason:
        "Campaign external work is in flight and still owned by the runtime.",
    };
  }
  if (unknownProof || unknownProvider || uncertainManualWorkItem) {
    return {
      kind: "resolve-manual-required",
      reason: uncertainManualWorkItem
        ? `Workflow work item ${uncertainManualWorkItem.id} requires an operator decision.`
        : unknownProof
          ? `Proof attempt ${unknownProof.attemptKey} has an uncertain external effect.`
          : `Provider attempt ${unknownProvider!.attemptKey} has an uncertain external effect.`,
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
  const failedWorkItem = input.workItems.find((item) =>
    item.state === "failed"
    || item.state === "cancelled"
    || item.state === "exhausted");
  const failedProof = input.proofs.find((proof) =>
    proof.attempts.some((attempt) => attempt.state === "proved_failed")
    && !proof.attempts.some((attempt) =>
      attempt.state === "committed" && attempt.result?.success === true));
  const historicalVerifierFailure = input.proofs
    .filter((proof) => !proof.attempts.some((attempt) =>
      attempt.state === "committed" && attempt.result?.success === true))
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
  if (liveExecutionApprovalWorkItem) {
    const approval = input.approvals.find((candidate) =>
      candidate.taskId === liveExecutionApprovalWorkItem.taskId
      && input.liveExecutionActionIds.has(candidate.actionId)
      && (candidate.status === "issued" || candidate.status === "claimed"));
    if (approval) {
      return {
        kind: "approve-execution",
        reason: `Workflow work item ${liveExecutionApprovalWorkItem.id} requires exact live-execution approval.`,
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
    const providerAttempts = (
      nativeTaskIds[0]
        ? await listCccProviderAttemptsForCampaign({
          layer: input.layer,
          rootDir,
          taskId: nativeTaskIds[0],
          tx,
        })
        : []
    )
      .map(providerAttemptStatus)
      .sort((left, right) => {
        const byTask = compareCccPrdCodeUnits(left.taskId, right.taskId);
        if (byTask !== 0) return byTask;
        return left.requestCount - right.requestCount
          || compareCccPrdCodeUnits(left.attemptKey, right.attemptKey);
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
    const nextAction = productNextAction({
      row,
      taskStatuses,
      workItems,
      proofs,
      orphanProofAttempts,
      providerAttempts,
      approvals,
      landingIntents,
      landingMaterializations,
      landingTerminals,
      liveExecutionActionIds,
      mergeActionIds,
    });

    return {
      schema: CCC_PRD_PRODUCT_STATUS_SCHEMA_VERSION,
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
