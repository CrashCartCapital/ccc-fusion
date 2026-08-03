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
  consumeCccCampaignApprovalWithinTransaction,
  computeCccPrdProofDefinitionSha256,
  createCccCampaignAuthorityBinding,
  drizzleSql,
  listCccCampaignProofAttemptsForCommit,
  postgresSchema,
  queryRunAuditEvents,
  recordRunAuditEventWithinTransaction,
  type CccCampaignAuthorityBinding,
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

type LandingAuditEvent = Awaited<ReturnType<typeof queryRunAuditEvents>>[number];
type ApprovalTransaction = Parameters<typeof assertActiveClaimedCccCampaignApprovalWithinTransaction>[0];

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

type IntentMetadata = Readonly<{
  schema: "ccc-campaign.git-landing.intent.v2";
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

function metadataFromPrepared(prepared: PreparedCccCampaignGitObjects): IntentMetadata {
  return Object.freeze({
    schema: "ccc-campaign.git-landing.intent.v2",
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
  if (!metadata || metadata.schema !== "ccc-campaign.git-landing.intent.v2") return null;
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

type ImportedWorkflowWorkItemFence = Readonly<{
  id: string;
  runId: string;
  attempt: number;
}>;

async function requireImportedWorkflowWorkItemFence(
  store: TaskStore,
  context: CccCampaignTaskContext,
  tx: ApprovalTransaction | undefined,
  allowSucceeded: boolean,
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
  const isParkedForMergeApproval = workItem.state === "manual-required"
    && workItem.lastError === MERGE_APPROVAL_REQUIRED
    && workItem.blockedReason === MERGE_APPROVAL_REQUIRED;
  const isPostLandingSuccess = allowSucceeded && workItem.state === "succeeded";
  if (
    workItem.kind !== "task"
    || workItem.runId !== expectedRunId
    || workItem.stableWorkflowRunId !== expectedRunId
    || !Number.isSafeInteger(workItem.attempt)
    || workItem.attempt < 1
    || !hasNoLiveLease
    || (!isParkedForMergeApproval && !isPostLandingSuccess)
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

async function assertExactCommittedProofReceipts(
  store: TaskStore,
  context: CccCampaignTaskContext,
  source: Readonly<{
    sourceCommit: string;
    sourceTree: string;
    mutationPaths: readonly string[];
  }>,
  tx?: ApprovalTransaction,
  allowSucceededWorkItem = false,
): Promise<void> {
  const layer = store.getAsyncLayer();
  if (!layer) throw new Error("CCC campaign Git landing proof receipt check requires PostgreSQL");
  if (!Array.isArray(context.proofs) || context.proofs.length === 0) {
    throw new Error("CCC campaign Git landing requires at least one executed proof receipt");
  }
  const workItemFence = await requireImportedWorkflowWorkItemFence(
    store,
    context,
    tx,
    allowSucceededWorkItem,
  );
  const receipts = await listCccCampaignProofAttemptsForCommit({
    layer,
    importId: context.importId,
    campaignId: context.campaignId,
    taskId: context.taskId,
    sourceCommit: source.sourceCommit,
    ...(tx ? { tx } : {}),
  });
  const expectedProofIds = context.proofs.map(({ id }) => id).sort();
  const observedProofIds = receipts.map(({ proofId }) => proofId).sort();
  if (
    new Set(expectedProofIds).size !== expectedProofIds.length
    || JSON.stringify(observedProofIds) !== JSON.stringify(expectedProofIds)
  ) {
    throw new Error("CCC campaign Git landing requires one exact passing receipt for every campaign proof");
  }
  const changedPathsSha256 = sha256CanonicalStrings(source.mutationPaths);
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
      || receipt.result.changedPathsSha256 !== changedPathsSha256
      || receipt.workItemId !== workItemFence.id
      || receipt.runId !== workItemFence.runId
      || receipt.workItemAttempt !== workItemFence.attempt
    ) {
      throw new Error(
        `CCC campaign Git landing proof receipt ${proof.id} is failed, stale, incomplete, or bound to different source`,
      );
    }
  }
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
    await assertExactCommittedProofReceipts(store, context, {
      sourceCommit: terminalMetadata.sourceCommit,
      sourceTree: terminalMetadata.treeObject,
      mutationPaths: terminalMetadata.mutationPaths,
    }, undefined, true);
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
  const sourceRef = `refs/heads/${branch}`;
  const admittedWriteRoots = sourceWriteRoots(context, targetRoot);
  const identity: CccCampaignGitCommitIdentity = Object.freeze({
    name: "CCC Campaign",
    email: "ccc-campaign@example.com",
    timestamp: COMMIT_TIMESTAMP,
  });
  const message = `CCC campaign native Git landing ${context.taskId}`;
  if (!intentMetadata) {
    const snapshot = await inspectCccCampaignLocalGit({
      targetRoot,
      expectedBaseObject: context.targetRepository.baseCommit,
    });
    const observed = (await runControlledCccCampaignGit(
      snapshot,
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
  const intent = intentMetadata ?? metadataFromPrepared(prepared);
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
  const approvalInput = {
    authorityStore,
    rootDir: targetRoot,
    taskId: context.taskId,
    action,
    approvalRequestId: lease.approvalRequestId,
    claimToken: lease.claimToken,
  };

  if (!intentMetadata && fault === "after-objects-before-intent") {
    throw new Error("CCC campaign Git landing test fault after deterministic objects before durable intent");
  }

  if (!intentMetadata) await layer.transactionImmediate(async (tx) => {
    await assertExactCommittedProofReceipts(store, context, {
      sourceCommit: prepared.sourceCommit,
      sourceTree: prepared.treeObject,
      mutationPaths: prepared.mutationPaths,
    }, tx);
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
      await assertExactCommittedProofReceipts(store, context, {
        sourceCommit: prepared.sourceCommit,
        sourceTree: prepared.treeObject,
        mutationPaths: prepared.mutationPaths,
      }, tx);
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
        await assertExactCommittedProofReceipts(store, context, {
          sourceCommit: prepared.sourceCommit,
          sourceTree: prepared.treeObject,
          mutationPaths: prepared.mutationPaths,
        }, tx);
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
      await assertExactCommittedProofReceipts(store, context, {
        sourceCommit: prepared.sourceCommit,
        sourceTree: prepared.treeObject,
        mutationPaths: prepared.mutationPaths,
      }, tx);
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
    await assertExactCommittedProofReceipts(store, context, {
      sourceCommit: prepared.sourceCommit,
      sourceTree: prepared.treeObject,
      mutationPaths: prepared.mutationPaths,
    }, tx);
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
