import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  CccCampaignTaskContext,
  MergeResult,
  Task,
  TaskStore,
} from "@fusion/core";
import {
  assertActiveClaimedCccCampaignApprovalWithinTransaction,
  assertClaimedCccCampaignApprovalWithinTransaction,
  canonicalCccPrdJson,
  cccPermanentWorkItemHasReason,
  compareCccPrdCodeUnits,
  consumeCccCampaignApprovalWithinTransaction,
  computeCccPrdProofDefinitionSha256,
  computeCccPrdProofV2AdmissionDigests,
  createCccCampaignAuthorityBinding,
  drizzleSql,
  getApprovalRequest,
  listCccCampaignProofAttemptsForCommit,
  postgresSchema,
  queryRunAuditEvents,
  recordRunAuditEventWithinTransaction,
  type CccCampaignAuthorityBinding,
  type CccCampaignProofAttempt,
} from "@fusion/core";
import { createCccCampaignMergeControl } from "./ccc-campaign-merge-control.js";
import {
  casCccCampaignGitRef,
  inspectCccCampaignGitLandingState,
  materializeCccCampaignGitCheckout,
  prepareCccCampaignGitObjects,
  recheckCccCampaignGitObjects,
  restoreCccCampaignGitObjects,
  type CccCampaignGitCommitIdentity,
  type CccCampaignGitCustodyIdentity,
  type CccCampaignTargetCheckout,
  type PreparedCccCampaignGitObjects,
} from "./ccc-campaign-git-objects.js";
import {
  inspectCccCampaignLocalGit,
  runControlledCccCampaignGit,
} from "./ccc-campaign-local-git.js";
import { resolveTaskWorkingBranch } from "./worktree-names.js";

const LANDING_AGENT_ID = "ccc-campaign-native-git-landing";
const LANDING_DOMAIN = "git";
const LANDING_TIMESTAMP = "2026-07-26T00:00:00.000Z";
const COMMIT_TIMESTAMP = "2026-07-26T00:00:00Z";
const MERGE_APPROVAL_REQUIRED = "ccc-permanent:CCC_CAMPAIGN_MERGE_APPROVAL_REQUIRED";
export const CCC_CAMPAIGN_FINAL_PROOF_CUSTODY_SCHEMA_VERSION =
  "ccc-campaign.final-proof-custody.v2" as const;
export const CCC_CAMPAIGN_MERGE_PROOF_RUN_ID_PREFIX =
  "ccc-merge-proof-v2" as const;

type LandingAuditEvent = Awaited<ReturnType<typeof queryRunAuditEvents>>[number];
type ApprovalTransaction = Parameters<typeof assertActiveClaimedCccCampaignApprovalWithinTransaction>[0];

export type CccCampaignFinalProofCustody = Readonly<{
  schema: typeof CCC_CAMPAIGN_FINAL_PROOF_CUSTODY_SCHEMA_VERSION;
  sourceCommit: string;
  sourceTree: string;
  finalReceiptSetSha256: string;
}>;

export type CccCampaignGitLandingFault =
  | "after-objects-before-intent"
  | "after-intent-write-before-commit"
  | "after-intent"
  | "after-checkout-materialization"
  | "after-checkout-receipt"
  | "after-cas"
  | "foreign-before-cas"
  | "foreign-after-cas";

type CampaignAuthorityStore = TaskStore & {
  getCccCampaignContextForTaskWithinTransaction?: (
    tx: unknown,
    taskId: string,
  ) => Promise<CccCampaignTaskContext | null>;
};

type MergeAction = Readonly<{
  actionId: string;
  actionTarget: string;
}>;

type ApprovalInput = Readonly<{
  authorityStore: CampaignAuthorityStore;
  rootDir: string;
  taskId: string;
  action: MergeAction;
  approvalRequestId: string;
  claimToken: string;
}>;

type IntentMetadataBase = Readonly<{
  expectedBaseObject: string;
  sourceRef: string;
  targetRef: string;
  sourceCommit: string;
  treeObject: string;
  commitObject: string;
  mutationPaths: readonly string[];
  admittedWriteRoots: readonly string[];
  objectBaselineBefore: readonly string[];
  expectedGeneratedObjectIds: readonly string[];
  targetCheckout: CccCampaignTargetCheckout;
  custodyIdentity: CccCampaignGitCustodyIdentity;
  identity: CccCampaignGitCommitIdentity;
  message: string;
}>;

type IntentMetadata =
  | Readonly<IntentMetadataBase & {
    schema: "ccc-campaign.git-landing.intent.v2";
  }>
  | Readonly<IntentMetadataBase & {
    schema: "ccc-campaign.git-landing.intent.v3";
    finalProofCustody: CccCampaignFinalProofCustody;
  }>;

function requireMergeAction(context: CccCampaignTaskContext): MergeAction {
  const assigned = new Set(context.protectedActionIds);
  const actions = context.protectedActions.filter((candidate) =>
    assigned.has(candidate.id)
    && candidate.kind === "merge"
    && candidate.requiresOperatorDecision === true
    && candidate.operatorDecision === "approve_merge"
  );
  if (actions.length !== 1) {
    throw new Error("CCC campaign Git landing requires exactly one approved merge protected action");
  }
  return Object.freeze({
    actionId: actions[0]!.id,
    actionTarget: actions[0]!.target,
  });
}

function sourceWriteRoots(
  context: CccCampaignTaskContext,
  targetRoot: string,
): readonly string[] {
  if (context.executionPolicy.schema !== "ccc-campaign.execution-policy.v2") {
    throw new Error("CCC campaign Git landing requires product execution policy v2");
  }
  const roots = context.executionPolicy.routes
    .flatMap((route) => route.allowedWriteRoots ?? [])
    .map((root) => resolve(targetRoot, root));
  if (roots.length === 0) {
    throw new Error("CCC campaign Git landing requires route-scoped source write roots");
  }
  return Object.freeze([...new Set(roots)].sort());
}

function runId(context: CccCampaignTaskContext, action: MergeAction): string {
  return `ccc-git-landing:${context.taskId}:${action.actionId}`;
}

type LandingPhase = "intent" | "checkout-materialized" | "terminal";

function eventKey(context: CccCampaignTaskContext, action: MergeAction, phase: LandingPhase): string {
  return `ccc-git-landing/${context.projectId}/${context.importId}/${context.taskId}/${action.actionId}/${phase}`;
}

function metadataFromPrepared(
  prepared: PreparedCccCampaignGitObjects,
  finalProofCustody: CccCampaignFinalProofCustody | null,
): IntentMetadata {
  const metadata = {
    expectedBaseObject: prepared.expectedTarget,
    sourceRef: prepared.sourceRef,
    targetRef: prepared.targetRef,
    sourceCommit: prepared.sourceCommit,
    treeObject: prepared.treeObject,
    commitObject: prepared.commitObject,
    mutationPaths: prepared.mutationPaths,
    admittedWriteRoots: prepared.admittedWriteRoots,
    objectBaselineBefore: prepared.objectBaselineBefore,
    expectedGeneratedObjectIds: prepared.expectedGeneratedObjectIds,
    targetCheckout: prepared.targetCheckout,
    custodyIdentity: prepared.custodyIdentity,
    identity: prepared.identity,
    message: prepared.message,
  };
  return finalProofCustody
    ? Object.freeze({
      schema: "ccc-campaign.git-landing.intent.v3",
      ...metadata,
      finalProofCustody,
    })
    : Object.freeze({
      schema: "ccc-campaign.git-landing.intent.v2",
      ...metadata,
    });
}

function preparedFromIntent(
  prepared: PreparedCccCampaignGitObjects,
  intent: IntentMetadata,
): PreparedCccCampaignGitObjects {
  if (
    prepared.expectedTarget !== intent.expectedBaseObject
    || prepared.sourceRef !== intent.sourceRef
    || prepared.targetRef !== intent.targetRef
    || prepared.sourceCommit !== intent.sourceCommit
    || prepared.treeObject !== intent.treeObject
    || prepared.commitObject !== intent.commitObject
    || JSON.stringify(prepared.targetCheckout) !== JSON.stringify(intent.targetCheckout)
    || JSON.stringify(prepared.custodyIdentity) !== JSON.stringify(intent.custodyIdentity)
    || JSON.stringify(prepared.identity) !== JSON.stringify(intent.identity)
    || prepared.message !== intent.message
  ) {
    throw new Error("CCC campaign Git landing intent drifted from deterministic object preparation");
  }
  return Object.freeze({
    ...prepared,
    mutationPaths: intent.mutationPaths,
    admittedWriteRoots: intent.admittedWriteRoots,
    objectBaselineBefore: intent.objectBaselineBefore,
    expectedGeneratedObjectIds: intent.expectedGeneratedObjectIds,
    targetCheckout: intent.targetCheckout,
    custodyIdentity: intent.custodyIdentity,
    identity: intent.identity,
    message: intent.message,
  });
}

function readIntentMetadata(event: LandingAuditEvent | undefined): IntentMetadata | null {
  const metadata = event?.metadata as Partial<IntentMetadata> | null | undefined;
  if (
    !metadata
    || ![
      "ccc-campaign.git-landing.intent.v2",
      "ccc-campaign.git-landing.intent.v3",
    ].includes(metadata.schema ?? "")
  ) return null;
  if (
    !isObjectId(metadata.expectedBaseObject)
    || !isGitRef(metadata.sourceRef)
    || !isGitRef(metadata.targetRef)
    || !isObjectId(metadata.sourceCommit)
    || !isObjectId(metadata.treeObject)
    || !isObjectId(metadata.commitObject)
    || !isStringArray(metadata.mutationPaths)
    || !isStringArray(metadata.admittedWriteRoots)
    || !isStringArray(metadata.objectBaselineBefore, isObjectId)
    || !isStringArray(metadata.expectedGeneratedObjectIds, isObjectId)
    || !isTargetCheckout(metadata.targetCheckout)
    || !isCustodyIdentity(metadata.custodyIdentity)
    || !isCommitIdentity(metadata.identity)
    || typeof metadata.message !== "string"
    || metadata.message.length === 0
    || (metadata.schema === "ccc-campaign.git-landing.intent.v3"
      && !isFinalProofCustody(metadata.finalProofCustody))
  ) {
    throw new Error("CCC campaign Git landing audit metadata is malformed");
  }
  return metadata as IntentMetadata;
}

async function findLandingEvent(
  store: TaskStore,
  context: CccCampaignTaskContext,
  action: MergeAction,
  binding: CccCampaignAuthorityBinding,
  phase: LandingPhase,
): Promise<LandingAuditEvent | undefined> {
  const layer = store.getAsyncLayer();
  if (!layer) throw new Error("CCC campaign Git landing requires TaskStore AsyncDataLayer");
  const events = await queryRunAuditEvents(layer.db, {
    taskId: context.taskId,
    domain: LANDING_DOMAIN,
    mutationType: `ccc-campaign-git-landing:${phase}`,
  });
  return events.find((event) =>
    event.campaign?.eventKey === eventKey(context, action, phase)
    && campaignBindingsEqual(event.campaign.binding, binding));
}

async function currentTargetCommit(prepared: PreparedCccCampaignGitObjects): Promise<string> {
  return (await runControlledCccCampaignGit(
    prepared.postObjectSnapshot,
    ["rev-parse", "--verify", `${prepared.targetRef}^{commit}`],
  )).toString("utf8").trim();
}

function landingResult(task: Task, context: CccCampaignTaskContext, branch: string): MergeResult {
  return {
    task,
    branch,
    merged: true,
    noOp: false,
    worktreeRemoved: false,
    branchDeleted: false,
    reason: "ccc-campaign-native-git-landed",
    campaignControlled: createCccCampaignMergeControl(context),
  };
}

function campaignBindingsEqual(
  observed: CccCampaignAuthorityBinding,
  expected: CccCampaignAuthorityBinding,
): boolean {
  return Object.entries(expected).every(([key, value]) =>
    observed[key as keyof CccCampaignAuthorityBinding] === value);
}

function isObjectId(value: unknown): value is string {
  return typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value);
}

function isGitRef(value: unknown): value is string {
  return typeof value === "string" && /^refs\/[A-Za-z0-9._/-]+$/u.test(value) && !value.includes("..");
}

function isTargetCheckout(value: unknown): value is CccCampaignTargetCheckout {
  if (!value || typeof value !== "object") return false;
  const checkout = value as Partial<CccCampaignTargetCheckout>;
  return checkout.mode === "target-root"
    ? typeof checkout.path === "string" && checkout.path.length > 0
    : checkout.mode === "not-checked-out"
      && (
        checkout.rootBranch === null
        || (typeof checkout.rootBranch === "string" && isGitRef(checkout.rootBranch))
      );
}

function isCustodyStat(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const stat = value as Record<string, unknown>;
  return typeof stat.path === "string"
    && stat.path.length > 0
    && ["dev", "ino", "mode", "birthtimeNs"].every((key) =>
      typeof stat[key] === "string" && /^(?:0|[1-9]\d*)$/u.test(stat[key] as string));
}

function isCustodyIdentity(value: unknown): value is CccCampaignGitCustodyIdentity {
  if (!value || typeof value !== "object") return false;
  const custody = value as Partial<CccCampaignGitCustodyIdentity>;
  return isCustodyStat(custody.targetRoot)
    && isCustodyStat(custody.gitControlPath)
    && isCustodyStat(custody.gitDir)
    && isCustodyStat(custody.gitCommonDir)
    && isCustodyStat(custody.gitBinary)
    && typeof custody.indexPath === "string"
    && custody.indexPath.length > 0;
}

function isCommitIdentity(value: unknown): value is CccCampaignGitCommitIdentity {
  if (!value || typeof value !== "object") return false;
  const identity = value as Partial<CccCampaignGitCommitIdentity>;
  return typeof identity.name === "string"
    && identity.name.length > 0
    && typeof identity.email === "string"
    && identity.email.length > 0
    && typeof identity.timestamp === "string"
    && identity.timestamp.length > 0;
}

function isStringArray(
  value: unknown,
  itemGuard: (item: unknown) => item is string = (item): item is string => typeof item === "string",
): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => itemGuard(item) && item.length > 0);
}

function sha256CanonicalStrings(values: readonly string[]): string {
  return createHash("sha256")
    .update(JSON.stringify([...values].sort()), "utf8")
    .digest("hex");
}

function sha256CanonicalValue(value: unknown): string {
  return createHash("sha256")
    .update(canonicalCccPrdJson(value), "utf8")
    .digest("hex");
}

type ImportedWorkflowWorkItemFence = Readonly<{
  id: string;
  runId: string;
  attempt: number;
}>;

async function requireImportedWorkflowWorkItemFence(
  store: TaskStore,
  context: CccCampaignTaskContext,
  tx: ApprovalTransaction | undefined,
  mode: "issuance" | "landing" | "replay",
): Promise<ImportedWorkflowWorkItemFence> {
  const layer = store.getAsyncLayer();
  if (!layer) throw new Error("CCC campaign Git landing work-item fence check requires PostgreSQL");
  const query = tx ?? layer.db;
  const entities = postgresSchema.project.cccPrdImportEntities;
  const workItems = postgresSchema.project.workflowWorkItems;
  const selection = query
    .select({
      id: workItems.id,
      runId: workItems.runId,
      kind: workItems.kind,
      state: workItems.state,
      attempt: workItems.attempt,
      leaseOwner: workItems.leaseOwner,
      leaseExpiresAt: workItems.leaseExpiresAt,
      lastError: workItems.lastError,
      blockedReason: workItems.blockedReason,
      stableWorkflowRunId: workItems.stableWorkflowRunId,
    })
    .from(entities)
    .innerJoin(
      workItems,
      drizzleSql`${workItems.projectId} = ${entities.projectId}
        AND ${workItems.id} = ${entities.nativeId}`,
    )
    .where(drizzleSql`${entities.projectId} = ${context.projectId}
      AND ${entities.importId} = ${context.importId}
      AND ${entities.entityType} = 'work_item'`)
    .limit(2);
  const rows = tx ? await selection.for("update") : await selection;
  if (rows.length !== 1) {
    throw new Error("CCC campaign Git landing requires one exact imported workflow work item");
  }
  const workItem = rows[0]!;
  const expectedRunId = `ccc-prd:${context.importId}`;
  const hasNoLiveLease = workItem.leaseOwner === null && workItem.leaseExpiresAt === null;
  const hasCompleteLiveLease = workItem.leaseOwner !== null && workItem.leaseExpiresAt !== null;
  const isParkedForMergeApproval = cccPermanentWorkItemHasReason(
    workItem,
    MERGE_APPROVAL_REQUIRED,
  );
  const isIssuanceRuntime = mode === "issuance"
    && workItem.state === "running"
    && hasCompleteLiveLease;
  const isPostLandingSuccess = mode === "replay" && workItem.state === "succeeded";
  if (
    workItem.kind !== "task"
    || workItem.runId !== expectedRunId
    || workItem.stableWorkflowRunId !== expectedRunId
    || !Number.isSafeInteger(workItem.attempt)
    || workItem.attempt < 1
    || (!isIssuanceRuntime && !hasNoLiveLease)
    || (!isParkedForMergeApproval && !isPostLandingSuccess && !isIssuanceRuntime)
  ) {
    throw new Error(
      "CCC campaign Git landing requires the exact imported workflow work item parked for merge approval",
    );
  }
  return Object.freeze({
    id: workItem.id,
    runId: workItem.runId,
    attempt: workItem.attempt,
  });
}

function semanticProofContract(
  context: CccCampaignTaskContext,
): "v1" | "v2" {
  const hasV1 = context.proofs.some((proof) => proof.schema !== "ccc-prd.proof.v2");
  const hasV2 = context.proofs.some((proof) => proof.schema === "ccc-prd.proof.v2");
  if (hasV1 && hasV2) {
    throw new Error("CCC campaign Git landing refuses a mixed semantic-proof contract");
  }
  return hasV2 ? "v2" : "v1";
}

function approvedFinalProofCustody(
  context: CccCampaignTaskContext,
  approvalRunId: string | undefined,
): CccCampaignFinalProofCustody | null {
  if (semanticProofContract(context) === "v1") return null;
  const custody = parseCccCampaignMergeProofRunId(approvalRunId);
  if (!custody) {
    throw new Error(
      "CCC campaign Git landing semantic-v2 approval is missing exact final proof custody",
    );
  }
  return custody;
}

function finalProofReceiptProjection(
  receipt: CccCampaignProofAttempt,
): Record<string, unknown> {
  return {
    attemptKey: receipt.attemptKey,
    attemptContractVersion: receipt.attemptContractVersion,
    phase: receipt.phase,
    taskId: receipt.taskId,
    semanticTaskId: receipt.semanticTaskId,
    proofId: receipt.proofId,
    packetHash: receipt.packetHash,
    sidecarHash: receipt.sidecarHash,
    bundleHash: receipt.bundleHash,
    manifestHash: receipt.manifestHash,
    campaignBindingHash: receipt.campaignBindingHash,
    targetRepository: receipt.targetRepository,
    targetBase: receipt.targetBase,
    sourceCommit: receipt.sourceCommit,
    sourceTree: receipt.sourceTree,
    definitionSha256: receipt.definitionSha256,
    commandSha256: receipt.commandSha256,
    workItemId: receipt.workItemId,
    runId: receipt.runId,
    workItemAttempt: receipt.workItemAttempt,
    verifierClosureSha256: receipt.verifierClosureSha256,
    candidateInputsSha256: receipt.candidateInputsSha256,
    executionToolchainSha256: receipt.executionToolchainSha256,
    terminalEnvelopeSha256: receipt.terminalEnvelopeSha256,
    proofEvidenceSha256: receipt.proofEvidenceSha256,
  };
}

function finalProofReceiptSetSha256(
  sourceCommit: string,
  sourceTree: string,
  receipts: readonly CccCampaignProofAttempt[],
): string {
  return createHash("sha256")
    .update(canonicalCccPrdJson({
      schema: "ccc-campaign.final-proof-receipt-set.v2",
      phase: "final_integrated",
      sourceCommit,
      sourceTree,
      receipts: receipts.map(finalProofReceiptProjection),
    }), "utf8")
    .digest("hex");
}

export function encodeCccCampaignMergeProofRunId(
  custody: CccCampaignFinalProofCustody,
): string {
  return `${CCC_CAMPAIGN_MERGE_PROOF_RUN_ID_PREFIX}:${custody.sourceCommit}:${custody.sourceTree}:${custody.finalReceiptSetSha256}`;
}

export function parseCccCampaignMergeProofRunId(
  runId: string | undefined,
): CccCampaignFinalProofCustody | null {
  if (!runId) return null;
  const [prefix, sourceCommit, sourceTree, finalReceiptSetSha256, extra] =
    runId.split(":");
  if (
    extra !== undefined
    || prefix !== CCC_CAMPAIGN_MERGE_PROOF_RUN_ID_PREFIX
    || !isObjectId(sourceCommit)
    || !isObjectId(sourceTree)
    || typeof finalReceiptSetSha256 !== "string"
    || !/^[0-9a-f]{64}$/u.test(finalReceiptSetSha256)
  ) {
    return null;
  }
  return Object.freeze({
    schema: CCC_CAMPAIGN_FINAL_PROOF_CUSTODY_SCHEMA_VERSION,
    sourceCommit,
    sourceTree,
    finalReceiptSetSha256,
  });
}

function isFinalProofCustody(value: unknown): value is CccCampaignFinalProofCustody {
  if (!value || typeof value !== "object") return false;
  const custody = value as Partial<CccCampaignFinalProofCustody>;
  return custody.schema === CCC_CAMPAIGN_FINAL_PROOF_CUSTODY_SCHEMA_VERSION
    && isObjectId(custody.sourceCommit)
    && isObjectId(custody.sourceTree)
    && typeof custody.finalReceiptSetSha256 === "string"
    && /^[0-9a-f]{64}$/u.test(custody.finalReceiptSetSha256);
}

function assertMatchingFinalProofCustody(
  observed: CccCampaignFinalProofCustody | null,
  expected: CccCampaignFinalProofCustody | null,
): void {
  if (
    (observed === null) !== (expected === null)
    || (observed && expected
      && canonicalCccPrdJson(observed) !== canonicalCccPrdJson(expected))
  ) {
    throw new Error(
      "CCC campaign Git landing final_integrated proof custody does not match the approved commit, tree, and receipt set",
    );
  }
}

async function assertExactCommittedProofReceipts(
  store: TaskStore,
  context: CccCampaignTaskContext,
  source: Readonly<{
    sourceCommit: string;
    sourceTree: string;
    mutationPaths?: readonly string[];
  }>,
  tx?: ApprovalTransaction,
  workItemMode: "issuance" | "landing" | "replay" = "landing",
): Promise<CccCampaignFinalProofCustody | null> {
  const layer = store.getAsyncLayer();
  if (!layer) throw new Error("CCC campaign Git landing proof receipt check requires PostgreSQL");
  if (!Array.isArray(context.proofs) || context.proofs.length === 0) {
    throw new Error("CCC campaign Git landing requires at least one executed proof receipt");
  }
  const workItemFence = await requireImportedWorkflowWorkItemFence(
    store,
    context,
    tx,
    workItemMode,
  );
  const receipts = await listCccCampaignProofAttemptsForCommit({
    layer,
    importId: context.importId,
    campaignId: context.campaignId,
    taskId: context.taskId,
    sourceCommit: source.sourceCommit,
    ...(tx ? { tx } : {}),
  });
  if (semanticProofContract(context) === "v2") {
    const expectedProofs = context.proofs
      .filter((proof) =>
        proof.schema === "ccc-prd.proof.v2"
        && proof.phases.includes("final_integrated"))
      .sort((left, right) => compareCccPrdCodeUnits(left.id, right.id));
    if (expectedProofs.length === 0) {
      throw new Error("CCC campaign Git landing requires at least one final_integrated proof");
    }
    // A proof retry advances the imported work-item attempt while preserving
    // the failed receipt as immutable history. Only the current fence can
    // authorize landing; duplicate or missing receipts inside that fence still
    // fail the exact proof-ID comparison below.
    const finalReceipts = receipts
      .filter((receipt) =>
        receipt.attemptContractVersion === "v2"
        && receipt.phase === "final_integrated"
        && receipt.workItemId === workItemFence.id
        && receipt.runId === workItemFence.runId
        && receipt.workItemAttempt === workItemFence.attempt)
      .sort((left, right) => compareCccPrdCodeUnits(left.proofId, right.proofId));
    if (
      JSON.stringify(finalReceipts.map(({ proofId }) => proofId))
        !== JSON.stringify(expectedProofs.map(({ id }) => id))
    ) {
      throw new Error(
        "CCC campaign Git landing requires one exact final_integrated v2 receipt for every admitted final proof",
      );
    }
    const changedPathsSha256 = source.mutationPaths
      ? sha256CanonicalStrings(source.mutationPaths)
      : null;
    for (const [index, receipt] of finalReceipts.entries()) {
      const proof = expectedProofs[index]!;
      if (proof.schema !== "ccc-prd.proof.v2") {
        throw new Error("CCC campaign Git landing final proof contract drifted");
      }
      const binding = createCccCampaignAuthorityBinding(context, {
        actionId: `proof:${proof.id}`,
        actionTarget: source.sourceCommit,
      });
      const admissionDigests = computeCccPrdProofV2AdmissionDigests(proof);
      const observedTerminalEnvelopeSha256 = receipt.terminalEnvelope == null
        ? null
        : sha256CanonicalValue(receipt.terminalEnvelope);
      const observedProofEvidenceSha256 = receipt.proofEvidence == null
        ? null
        : sha256CanonicalValue(receipt.proofEvidence);
      if (
        receipt.state !== "committed"
        || receipt.attemptContractVersion !== "v2"
        || receipt.phase !== "final_integrated"
        || receipt.terminalEnvelope?.kind !== "verified"
        || receipt.terminalEnvelope.passed !== true
        || receipt.proofEvidence?.passed !== true
        || receipt.terminalEnvelopeSha256 !== observedTerminalEnvelopeSha256
        || receipt.proofEvidenceSha256 !== observedProofEvidenceSha256
        || receipt.terminalEnvelope.evidenceSha256 !== receipt.proofEvidenceSha256
        || receipt.importId !== context.importId
        || receipt.campaignId !== context.campaignId
        || receipt.taskId !== context.taskId
        || receipt.semanticTaskId !== context.semanticTaskId
        || receipt.packetHash !== context.packetHash
        || receipt.sidecarHash !== context.sidecarHash
        || receipt.bundleHash !== context.bundleHash
        || receipt.manifestHash !== context.manifestHash
        || receipt.campaignBindingHash !== binding.bindingHash
        || receipt.targetRepository !== context.targetRepository.path
        || receipt.targetBase !== context.targetRepository.baseCommit
        || receipt.sourceCommit !== source.sourceCommit
        || receipt.sourceTree !== source.sourceTree
        || receipt.definitionSha256 !== computeCccPrdProofDefinitionSha256(proof)
        || receipt.command !== proof.command
        || receipt.commandSha256 !== createHash("sha256").update(proof.command, "utf8").digest("hex")
        || receipt.verifierClosureSha256 !== admissionDigests.verifierClosureSha256
        || receipt.candidateInputsSha256 !== admissionDigests.candidateInputsSha256
        || receipt.executionToolchainSha256 !== admissionDigests.executionToolchainSha256
        || (changedPathsSha256 !== null
          && receipt.terminalEnvelope.changedPathsSha256 !== changedPathsSha256)
        || receipt.workItemId !== workItemFence.id
        || receipt.runId !== workItemFence.runId
        || receipt.workItemAttempt !== workItemFence.attempt
      ) {
        throw new Error(
          `CCC campaign Git landing final_integrated proof receipt ${proof.id} is failed, stale, incomplete, or bound to different custody`,
        );
      }
    }
    return Object.freeze({
      schema: CCC_CAMPAIGN_FINAL_PROOF_CUSTODY_SCHEMA_VERSION,
      sourceCommit: source.sourceCommit,
      sourceTree: source.sourceTree,
      finalReceiptSetSha256: finalProofReceiptSetSha256(
        source.sourceCommit,
        source.sourceTree,
        finalReceipts,
      ),
    });
  }
  const expectedProofIds = context.proofs.map(({ id }) => id).sort();
  const observedProofIds = receipts.map(({ proofId }) => proofId).sort();
  if (
    new Set(expectedProofIds).size !== expectedProofIds.length
    || JSON.stringify(observedProofIds) !== JSON.stringify(expectedProofIds)
  ) {
    throw new Error("CCC campaign Git landing requires one exact passing receipt for every campaign proof");
  }
  const changedPathsSha256 = source.mutationPaths
    ? sha256CanonicalStrings(source.mutationPaths)
    : null;
  for (const receipt of receipts) {
    const proof = context.proofs.find(({ id }) => id === receipt.proofId);
    if (!proof) {
      throw new Error(`CCC campaign Git landing proof receipt ${receipt.proofId} is not declared`);
    }
    const binding = createCccCampaignAuthorityBinding(context, {
      actionId: `proof:${proof.id}`,
      actionTarget: source.sourceCommit,
    });
    if (
      receipt.state !== "committed"
      || receipt.result?.success !== true
      || receipt.importId !== context.importId
      || receipt.campaignId !== context.campaignId
      || receipt.taskId !== context.taskId
      || receipt.semanticTaskId !== context.semanticTaskId
      || receipt.packetHash !== context.packetHash
      || receipt.sidecarHash !== context.sidecarHash
      || receipt.bundleHash !== context.bundleHash
      || receipt.manifestHash !== context.manifestHash
      || receipt.campaignBindingHash !== binding.bindingHash
      || receipt.targetRepository !== context.targetRepository.path
      || receipt.targetBase !== context.targetRepository.baseCommit
      || receipt.sourceCommit !== source.sourceCommit
      || receipt.sourceTree !== source.sourceTree
      || receipt.definitionSha256 !== computeCccPrdProofDefinitionSha256(proof)
      || receipt.command !== proof.command
      || receipt.commandSha256 !== createHash("sha256").update(proof.command, "utf8").digest("hex")
      || (changedPathsSha256 !== null
        && receipt.result.changedPathsSha256 !== changedPathsSha256)
      || receipt.workItemId !== workItemFence.id
      || receipt.runId !== workItemFence.runId
      || receipt.workItemAttempt !== workItemFence.attempt
    ) {
      throw new Error(
        `CCC campaign Git landing proof receipt ${proof.id} is failed, stale, incomplete, or bound to different source`,
      );
    }
  }
  return null;
}

async function assertExactApprovedProofReceipts(
  store: TaskStore,
  context: CccCampaignTaskContext,
  source: Readonly<{
    sourceCommit: string;
    sourceTree: string;
    mutationPaths?: readonly string[];
  }>,
  expected: CccCampaignFinalProofCustody | null,
  tx?: ApprovalTransaction,
  workItemMode: "landing" | "replay" = "landing",
): Promise<void> {
  const observed = await assertExactCommittedProofReceipts(
    store,
    context,
    source,
    tx,
    workItemMode,
  );
  assertMatchingFinalProofCustody(observed, expected);
}

export async function deriveCccCampaignFinalProofCustodyForCurrentSource(
  store: TaskStore,
  context: CccCampaignTaskContext,
  targetRoot: string,
): Promise<CccCampaignFinalProofCustody | null> {
  if (semanticProofContract(context) === "v1") return null;
  const task = await store.getTask(context.taskId);
  const branch = resolveTaskWorkingBranch(task);
  const snapshot = await inspectCccCampaignLocalGit({
    targetRoot,
    expectedBaseObject: context.targetRepository.baseCommit,
  });
  const sourceCommit = (await runControlledCccCampaignGit(
    snapshot,
    ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`],
  )).toString("utf8").trim();
  const sourceTree = (await runControlledCccCampaignGit(
    snapshot,
    ["rev-parse", "--verify", `${sourceCommit}^{tree}`],
  )).toString("utf8").trim();
  const custody = await assertExactCommittedProofReceipts(
    store,
    context,
    { sourceCommit, sourceTree },
    undefined,
    "issuance",
  );
  if (!custody) {
    throw new Error("CCC campaign final proof custody was not derived for semantic proof v2");
  }
  return custody;
}

export type CccCampaignLandingTaskCommit = Readonly<{ taskId: string; commit: string }>;

/**
 * Verify, against real Git history, that the commit about to be landed contains
 * every campaign task's recorded commit.
 *
 * Landing sources exactly one branch and builds a single-parent commit, so
 * "every task's work is in there" is otherwise inherited entirely from the
 * proof gate's own ancestry loop. This is the independent second check: it
 * consults the object graph rather than a receipt, so a bypassed, mis-scoped,
 * or wrongly-attributed proof cannot by itself publish a commit that silently
 * drops an earlier task's work. An empty set is a refusal, not a pass — a
 * campaign with no verifiable task commits must never land vacuously.
 */
export async function assertCccCampaignLandingIntegratesTaskCommits(
  snapshot: Readonly<{ gitBinary: string; targetRoot: string }>,
  landingSourceCommit: string,
  taskCommits: readonly CccCampaignLandingTaskCommit[],
): Promise<void> {
  /*
   * An empty set is a NO-OP, not a refusal. This gate owns exactly one
   * question — "is each recorded task commit contained in what we are landing?"
   * — and deliberately does not own "does this campaign have receipts at all",
   * which `assertExactCommittedProofReceipts` already refuses authoritatively.
   * Refusing here would preempt that gate's precise diagnosis with a vaguer one
   * on every single-task campaign, whose only recorded commit is the landing
   * task's own and is therefore excluded upstream.
   */
  if (taskCommits.length === 0) return;
  if (!isObjectId(landingSourceCommit)) {
    throw new Error(
      `CCC campaign Git landing source commit ${landingSourceCommit} is not a canonical Git object ID`,
    );
  }
  for (const { taskId, commit } of taskCommits) {
    if (!isObjectId(commit)) {
      throw new Error(
        `CCC campaign Git landing campaign task ${taskId} commit ${commit} is not a canonical Git object ID`,
      );
    }
    try {
      await runControlledCccCampaignGit(
        snapshot,
        ["merge-base", "--is-ancestor", commit, landingSourceCommit],
      );
    } catch {
      throw new Error(
        `CCC campaign Git landing source commit ${landingSourceCommit} does not integrate campaign task ${taskId} commit ${commit}`,
      );
    }
  }
}

/**
 * The commit every OTHER campaign task durably recorded, taken from committed
 * proof-attempt receipts.
 *
 * Deriving this from live working branches was wrong: branch liveness is not
 * part of the landing model. An imported campaign always carries task entities
 * that never execute (a dependent terminal task, for one), and a task that did
 * execute may have had its branch collected before landing — neither is
 * evidence that work went missing. A committed receipt, by contrast, is durable
 * proof that a specific task's work existed at a specific commit.
 *
 * The landing task itself is excluded on purpose: `assertExactCommittedProofReceipts`
 * already pins its receipts to exactly `prepared.sourceCommit`, so including it
 * here would only preempt that gate's sharper diagnosis with a vaguer one. This
 * gate covers precisely the gap that gate cannot see — the OTHER tasks in a
 * multi-task campaign.
 */
async function recordedCampaignTaskCommits(
  store: TaskStore,
  context: CccCampaignTaskContext,
): Promise<readonly CccCampaignLandingTaskCommit[]> {
  const layer = store.getAsyncLayer();
  if (!layer) throw new Error("CCC campaign Git landing task ancestry check requires PostgreSQL");
  const attempts = postgresSchema.project.cccCampaignProofAttempts;
  const rows = await layer.db
    .select({ taskId: attempts.taskId, sourceCommit: attempts.sourceCommit })
    .from(attempts)
    .where(drizzleSql`${attempts.projectId} = ${context.projectId}
      AND ${attempts.importId} = ${context.importId}
      AND ${attempts.campaignId} = ${context.campaignId}
      AND ${attempts.taskId} <> ${context.taskId}
      AND ${attempts.state} = 'committed'`);
  const distinct = new Map<string, CccCampaignLandingTaskCommit>();
  for (const { taskId, sourceCommit } of rows) {
    distinct.set(`${taskId} ${sourceCommit}`, Object.freeze({ taskId, commit: sourceCommit }));
  }
  return Object.freeze([...distinct.values()]);
}

async function moveTargetToForeignCommit(prepared: PreparedCccCampaignGitObjects): Promise<void> {
  await runControlledCccCampaignGit(
    prepared.postObjectSnapshot,
    ["update-ref", prepared.targetRef, prepared.sourceCommit],
  );
}

async function assertActiveApprovalLeaseWithinTransaction(
  authorityStore: CampaignAuthorityStore,
  tx: ApprovalTransaction,
  expectedContext: CccCampaignTaskContext,
  approvalInput: ApprovalInput,
): Promise<void> {
  const reloaded = await authorityStore.getCccCampaignContextForTaskWithinTransaction!(tx, expectedContext.taskId);
  if (!reloaded || reloaded.targetRepository.baseCommit !== expectedContext.targetRepository.baseCommit) {
    throw new Error("CCC campaign Git landing custody drifted before approval-gated Git landing");
  }
  const persistedLease = reloaded.activeActionLeases[approvalInput.action.actionId];
  if (
    !persistedLease
    || persistedLease.approvalRequestId !== approvalInput.approvalRequestId
    || persistedLease.claimToken !== approvalInput.claimToken
  ) {
    throw new Error("CCC campaign Git landing approval lease drifted before approval-gated Git landing");
  }
  await assertActiveClaimedCccCampaignApprovalWithinTransaction(tx, approvalInput);
}

export async function campaignGitLandingRequiredResult(
  store: TaskStore,
  projectRootDir: string,
  task: Task,
  context: CccCampaignTaskContext,
  fault?: CccCampaignGitLandingFault,
): Promise<MergeResult> {
  const layer = store.getAsyncLayer();
  if (!layer) throw new Error("CCC campaign Git landing requires TaskStore AsyncDataLayer");
  if (context.executionPolicy.schema !== "ccc-campaign.execution-policy.v2") {
    throw new Error("CCC campaign Git landing requires product-v2 proof execution");
  }
  const authorityStore = store as CampaignAuthorityStore;
  if (typeof authorityStore.getCccCampaignContextForTaskWithinTransaction !== "function") {
    throw new Error("CCC campaign Git landing requires transaction-scoped campaign custody");
  }
  const targetRoot = await realpath(projectRootDir);
  if (
    targetRoot !== context.targetRepository.path
    || context.targetRepository.path !== context.targetRepository.path.trim()
  ) {
    throw new Error("CCC campaign Git landing target root does not match campaign custody");
  }
  const action = requireMergeAction(context);
  const binding: CccCampaignAuthorityBinding = createCccCampaignAuthorityBinding(context, {
    actionId: action.actionId,
    actionTarget: action.actionTarget,
    requireProtected: true,
  });
  const branch = resolveTaskWorkingBranch(task);
  const targetRef = action.actionTarget;
  const existingIntent = await findLandingEvent(store, context, action, binding, "intent");
  const intentMetadata = readIntentMetadata(existingIntent);
  const checkoutMaterialized = await findLandingEvent(
    store,
    context,
    action,
    binding,
    "checkout-materialized",
  );
  const checkoutMaterializedMetadata = readIntentMetadata(checkoutMaterialized);
  const terminal = await findLandingEvent(store, context, action, binding, "terminal");
  const terminalMetadata = readIntentMetadata(terminal);
  if (
    checkoutMaterialized
    && (
      !checkoutMaterializedMetadata
      || !intentMetadata
      || JSON.stringify(checkoutMaterializedMetadata) !== JSON.stringify(intentMetadata)
    )
  ) {
    throw new Error("CCC campaign Git landing materialization metadata does not match durable intent");
  }
  if (terminalMetadata) {
    if (!intentMetadata || JSON.stringify(terminalMetadata) !== JSON.stringify(intentMetadata)) {
      throw new Error("CCC campaign Git landing terminal metadata does not match durable intent");
    }
    const replayProofCustody = semanticProofContract(context) === "v2"
      ? terminalMetadata.schema === "ccc-campaign.git-landing.intent.v3"
        ? terminalMetadata.finalProofCustody
        : null
      : null;
    if (semanticProofContract(context) === "v2" && !replayProofCustody) {
      throw new Error(
        "CCC campaign Git landing semantic-v2 replay is missing durable final proof custody",
      );
    }
    const replayObservedCustody = await assertExactCommittedProofReceipts(store, context, {
      sourceCommit: terminalMetadata.sourceCommit,
      sourceTree: terminalMetadata.treeObject,
      mutationPaths: terminalMetadata.mutationPaths,
    }, undefined, "replay");
    assertMatchingFinalProofCustody(replayObservedCustody, replayProofCustody);
    const snapshot = await inspectCccCampaignLocalGit({
      targetRoot,
      expectedBaseObject: terminalMetadata.expectedBaseObject,
    });
    const observed = (await runControlledCccCampaignGit(
      snapshot,
      ["rev-parse", "--verify", `${targetRef}^{commit}`],
    )).toString("utf8").trim();
    if (observed !== terminalMetadata.commitObject) {
      throw new Error("CCC campaign Git landing terminal exists before matching target ref");
    }
    return landingResult(task, context, branch);
  }

  const lease = context.activeActionLeases[action.actionId];
  if (!lease) throw new Error("CCC campaign Git landing requires a claimed approval lease");
  const persistedApproval = await getApprovalRequest(layer.db, lease.approvalRequestId);
  if (!persistedApproval || persistedApproval.id !== lease.approvalRequestId) {
    throw new Error("CCC campaign Git landing approval is missing before Git mutation");
  }
  const expectedFinalProofCustody = approvedFinalProofCustody(
    context,
    persistedApproval.runId,
  );
  const approvalInput = {
    authorityStore,
    rootDir: targetRoot,
    taskId: context.taskId,
    action,
    approvalRequestId: lease.approvalRequestId,
    claimToken: lease.claimToken,
  };
  if (
    intentMetadata
    && (
      (expectedFinalProofCustody !== null)
        !== (intentMetadata.schema === "ccc-campaign.git-landing.intent.v3")
      || (intentMetadata.schema === "ccc-campaign.git-landing.intent.v3"
        && canonicalCccPrdJson(intentMetadata.finalProofCustody)
          !== canonicalCccPrdJson(expectedFinalProofCustody))
    )
  ) {
    throw new Error(
      "CCC campaign Git landing durable intent does not match the approved final proof custody",
    );
  }
  const sourceRef = `refs/heads/${branch}`;
  const admittedWriteRoots = sourceWriteRoots(context, targetRoot);
  const identity: CccCampaignGitCommitIdentity = Object.freeze({
    name: "CCC Campaign",
    email: "ccc-campaign@example.com",
    timestamp: COMMIT_TIMESTAMP,
  });
  const message = `CCC campaign native Git landing ${context.taskId}`;
  // A durable checkout-materialization receipt deliberately permits the target
  // root's index/worktree to differ from HEAD during recovery.  Re-derive Git
  // source custody from the live repository only before the first intent; on
  // replay, the durable intent is the exact source object authority and the
  // object-restoration path below independently validates it.
  const preMutationSnapshot = intentMetadata
    ? null
    : await inspectCccCampaignLocalGit({
      targetRoot,
      expectedBaseObject: context.targetRepository.baseCommit,
    });
  const preMutationSourceCommit = intentMetadata?.sourceCommit
    ?? (await runControlledCccCampaignGit(
      preMutationSnapshot!,
      ["rev-parse", "--verify", `${sourceRef}^{commit}`],
    )).toString("utf8").trim();
  const preMutationSourceTree = intentMetadata?.treeObject
    ?? (await runControlledCccCampaignGit(
      preMutationSnapshot!,
      ["rev-parse", "--verify", `${preMutationSourceCommit}^{tree}`],
    )).toString("utf8").trim();
  await layer.transactionImmediate(async (tx) => {
    await assertExactApprovedProofReceipts(store, context, {
      sourceCommit: preMutationSourceCommit,
      sourceTree: preMutationSourceTree,
    }, expectedFinalProofCustody, tx);
    await assertActiveApprovalLeaseWithinTransaction(
      authorityStore,
      tx,
      context,
      approvalInput,
    );
  });
  if (!intentMetadata) {
    const observed = (await runControlledCccCampaignGit(
      preMutationSnapshot!,
      ["rev-parse", "--verify", `${targetRef}^{commit}`],
    )).toString("utf8").trim();
    if (observed !== context.targetRepository.baseCommit) {
      throw new Error("CCC campaign Git landing target ref drifted before durable intent");
    }
  }
  const preparedBase = intentMetadata
    ? await restoreCccCampaignGitObjects({
      targetRoot,
      expectedTarget: intentMetadata.expectedBaseObject,
      sourceRef: intentMetadata.sourceRef,
      targetRef: intentMetadata.targetRef,
      sourceCommit: intentMetadata.sourceCommit,
      treeObject: intentMetadata.treeObject,
      commitObject: intentMetadata.commitObject,
      mutationPaths: intentMetadata.mutationPaths,
      admittedWriteRoots: intentMetadata.admittedWriteRoots,
      identity: intentMetadata.identity,
      message: intentMetadata.message,
      objectBaselineBefore: intentMetadata.objectBaselineBefore,
      expectedGeneratedObjectIds: intentMetadata.expectedGeneratedObjectIds,
      targetCheckout: intentMetadata.targetCheckout,
      custodyIdentity: intentMetadata.custodyIdentity,
    })
    : await prepareCccCampaignGitObjects({
      targetRoot,
      expectedBaseObject: context.targetRepository.baseCommit,
      sourceRef,
      targetRef,
      admittedWriteRoots,
      identity,
      message,
    });
  const prepared = intentMetadata
    ? preparedFromIntent(preparedBase, intentMetadata)
    : preparedBase;
  const intent = intentMetadata
    ?? metadataFromPrepared(prepared, expectedFinalProofCustody);
  /*
   * Defense in depth, independent of the proof gate: the landed tree is taken
   * from `sourceCommit`, so every commit another campaign task durably recorded
   * must already be an ancestor of it. The prepared commit itself is
   * deliberately re-parented onto the target base, which is why the source
   * commit — not `commitObject` — is the meaningful ancestry target here.
   */
  await assertCccCampaignLandingIntegratesTaskCommits(
    prepared.postObjectSnapshot,
    prepared.sourceCommit,
    await recordedCampaignTaskCommits(store, context),
  );
  if (!intentMetadata && fault === "after-objects-before-intent") {
    throw new Error("CCC campaign Git landing test fault after deterministic objects before durable intent");
  }

  if (!intentMetadata) await layer.transactionImmediate(async (tx) => {
    await assertExactApprovedProofReceipts(store, context, {
      sourceCommit: prepared.sourceCommit,
      sourceTree: prepared.treeObject,
      mutationPaths: prepared.mutationPaths,
    }, expectedFinalProofCustody, tx);
    await assertActiveApprovalLeaseWithinTransaction(authorityStore, tx, context, approvalInput);
    await recheckCccCampaignGitObjects(prepared);
    await recordRunAuditEventWithinTransaction(tx, {
      timestamp: LANDING_TIMESTAMP,
      taskId: context.taskId,
      agentId: LANDING_AGENT_ID,
      runId: runId(context, action),
      domain: LANDING_DOMAIN,
      mutationType: "ccc-campaign-git-landing:intent",
      target: binding.actionTarget,
      metadata: intent,
      campaign: { eventKey: eventKey(context, action, "intent"), binding },
    });
    if (fault === "after-intent-write-before-commit") {
      throw new Error("CCC campaign Git landing test fault after intent write before commit");
    }
  });
  if (fault === "after-intent") {
    throw new Error("CCC campaign Git landing test fault after durable intent");
  }

  if (intentMetadata) {
    await inspectCccCampaignGitLandingState(prepared);
  } else {
    await recheckCccCampaignGitObjects(prepared);
  }
  const observedBeforeCas = await currentTargetCommit(prepared);
  if (observedBeforeCas === prepared.expectedTarget) {
    await layer.transactionImmediate(async (tx) => {
      await assertExactApprovedProofReceipts(store, context, {
        sourceCommit: prepared.sourceCommit,
        sourceTree: prepared.treeObject,
        mutationPaths: prepared.mutationPaths,
      }, expectedFinalProofCustody, tx);
      await assertActiveApprovalLeaseWithinTransaction(authorityStore, tx, context, approvalInput);
    });
    if (fault === "foreign-before-cas") {
      await moveTargetToForeignCommit(prepared);
    }
    const stateBeforeMaterialization = await inspectCccCampaignGitLandingState(prepared);
    if (
      prepared.targetCheckout.mode === "target-root"
      && checkoutMaterializedMetadata
      && stateBeforeMaterialization === "base-clean"
    ) {
      throw new Error(
        "CCC campaign checkout materialization receipt exists but its filesystem effect is absent; manual recovery is required",
      );
    }
    const materializedState = await materializeCccCampaignGitCheckout(prepared);
    if (
      prepared.targetCheckout.mode === "target-root"
      && materializedState !== "checkout-materialized"
      && materializedState !== "landed-clean"
    ) {
      throw new Error("CCC campaign checked-out target did not reach exact materialized state");
    }
    if (
      prepared.targetCheckout.mode === "target-root"
      && fault === "after-checkout-materialization"
    ) {
      throw new Error("CCC campaign Git landing test fault after checkout materialization");
    }
    if (prepared.targetCheckout.mode === "target-root" && !checkoutMaterializedMetadata) {
      await layer.transactionImmediate(async (tx) => {
        await assertExactApprovedProofReceipts(store, context, {
          sourceCommit: prepared.sourceCommit,
          sourceTree: prepared.treeObject,
          mutationPaths: prepared.mutationPaths,
        }, expectedFinalProofCustody, tx);
        await assertActiveApprovalLeaseWithinTransaction(authorityStore, tx, context, approvalInput);
        const state = await inspectCccCampaignGitLandingState(prepared);
        if (state !== "checkout-materialized" && state !== "landed-clean") {
          throw new Error("CCC campaign checkout materialization state drifted before its durable receipt");
        }
        await recordRunAuditEventWithinTransaction(tx, {
          timestamp: LANDING_TIMESTAMP,
          taskId: context.taskId,
          agentId: LANDING_AGENT_ID,
          runId: runId(context, action),
          domain: LANDING_DOMAIN,
          mutationType: "ccc-campaign-git-landing:checkout-materialized",
          target: binding.actionTarget,
          metadata: intent,
          campaign: {
            eventKey: eventKey(context, action, "checkout-materialized"),
            binding,
          },
        });
      });
    }
    if (
      prepared.targetCheckout.mode === "target-root"
      && fault === "after-checkout-receipt"
    ) {
      throw new Error("CCC campaign Git landing test fault after checkout materialization receipt");
    }
    await layer.transactionImmediate(async (tx) => {
      await assertExactApprovedProofReceipts(store, context, {
        sourceCommit: prepared.sourceCommit,
        sourceTree: prepared.treeObject,
        mutationPaths: prepared.mutationPaths,
      }, expectedFinalProofCustody, tx);
      await assertActiveApprovalLeaseWithinTransaction(authorityStore, tx, context, approvalInput);
    });
    const cas = await casCccCampaignGitRef(prepared);
    if (!cas.advanced && cas.observed !== prepared.commitObject) {
      throw new Error("CCC campaign Git landing target ref drifted during CAS");
    }
  } else if (observedBeforeCas !== prepared.commitObject) {
    throw new Error("CCC campaign Git landing target ref drifted before CAS");
  }
  if (fault === "foreign-after-cas") {
    await moveTargetToForeignCommit(prepared);
  }
  if (fault === "after-cas") {
    throw new Error("CCC campaign Git landing test fault after CAS");
  }

  const observedBeforeTerminal = await currentTargetCommit(prepared);
  if (observedBeforeTerminal !== prepared.commitObject) {
    throw new Error("CCC campaign Git landing target ref drifted before terminal audit");
  }

  await layer.transactionImmediate(async (tx) => {
    await assertExactApprovedProofReceipts(store, context, {
      sourceCommit: prepared.sourceCommit,
      sourceTree: prepared.treeObject,
      mutationPaths: prepared.mutationPaths,
    }, expectedFinalProofCustody, tx);
    await assertClaimedCccCampaignApprovalWithinTransaction(tx, approvalInput);
    await recordRunAuditEventWithinTransaction(tx, {
      timestamp: LANDING_TIMESTAMP,
      taskId: context.taskId,
      agentId: LANDING_AGENT_ID,
      runId: runId(context, action),
      domain: LANDING_DOMAIN,
      mutationType: "ccc-campaign-git-landing:terminal",
      target: binding.actionTarget,
      metadata: intent,
      campaign: { eventKey: eventKey(context, action, "terminal"), binding },
    });
    await consumeCccCampaignApprovalWithinTransaction(tx, {
      ...approvalInput,
      actor: {
        actorId: LANDING_AGENT_ID,
        actorType: "agent",
        actorName: "CCC Campaign Native Git Landing",
      },
      runId: runId(context, action),
    });
  });

  return landingResult(task, context, branch);
}
