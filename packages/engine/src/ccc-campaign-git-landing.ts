import { realpath } from "node:fs/promises";
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
  createCccCampaignAuthorityBinding,
  queryRunAuditEvents,
  recordRunAuditEventWithinTransaction,
  type CccCampaignAuthorityBinding,
} from "@fusion/core";
import { createCccCampaignMergeControl } from "./ccc-campaign-merge-control.js";
import {
  casCccCampaignGitRef,
  prepareCccCampaignGitObjects,
  recheckCccCampaignGitObjects,
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

type LandingAuditEvent = Awaited<ReturnType<typeof queryRunAuditEvents>>[number];
type ApprovalTransaction = Parameters<typeof assertActiveClaimedCccCampaignApprovalWithinTransaction>[0];

export type CccCampaignGitLandingFault =
  | "after-objects-before-intent"
  | "after-intent-write-before-commit"
  | "after-intent"
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
  schema: "ccc-campaign.git-landing.intent.v1";
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

function runId(context: CccCampaignTaskContext, action: MergeAction): string {
  return `ccc-git-landing:${context.taskId}:${action.actionId}`;
}

function eventKey(context: CccCampaignTaskContext, action: MergeAction, phase: "intent" | "terminal"): string {
  return `ccc-git-landing/${context.projectId}/${context.importId}/${context.taskId}/${action.actionId}/${phase}`;
}

function metadataFromPrepared(prepared: PreparedCccCampaignGitObjects): IntentMetadata {
  return Object.freeze({
    schema: "ccc-campaign.git-landing.intent.v1",
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
  ) {
    throw new Error("CCC campaign Git landing intent drifted from deterministic object preparation");
  }
  return Object.freeze({
    ...prepared,
    mutationPaths: intent.mutationPaths,
    admittedWriteRoots: intent.admittedWriteRoots,
    objectBaselineBefore: intent.objectBaselineBefore,
    expectedGeneratedObjectIds: intent.expectedGeneratedObjectIds,
  });
}

function readIntentMetadata(event: LandingAuditEvent | undefined): IntentMetadata | null {
  const metadata = event?.metadata as Partial<IntentMetadata> | null | undefined;
  if (!metadata || metadata.schema !== "ccc-campaign.git-landing.intent.v1") return null;
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
  phase: "intent" | "terminal",
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

function isStringArray(
  value: unknown,
  itemGuard: (item: unknown) => item is string = (item): item is string => typeof item === "string",
): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => itemGuard(item) && item.length > 0);
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
  const terminal = await findLandingEvent(store, context, action, binding, "terminal");
  const terminalMetadata = readIntentMetadata(terminal);
  if (terminalMetadata) {
    if (!intentMetadata || JSON.stringify(terminalMetadata) !== JSON.stringify(intentMetadata)) {
      throw new Error("CCC campaign Git landing terminal metadata does not match durable intent");
    }
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
  const admittedWriteRoots = context.admittedWriteRoots.map(({ path }) => path);
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
  const preparedBase = await prepareCccCampaignGitObjects({
    targetRoot,
    expectedBaseObject: context.targetRepository.baseCommit,
    sourceRef,
    targetRef,
    admittedWriteRoots,
    identity: {
      name: "CCC Campaign",
      email: "ccc-campaign@example.com",
      timestamp: COMMIT_TIMESTAMP,
    },
    message: `CCC campaign native Git landing ${context.taskId}`,
  });
  const prepared = intentMetadata
    ? preparedFromIntent(preparedBase, intentMetadata)
    : preparedBase;
  const intent = intentMetadata ?? metadataFromPrepared(prepared);
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

  await recheckCccCampaignGitObjects(prepared);
  const observedBeforeCas = await currentTargetCommit(prepared);
  if (observedBeforeCas === prepared.expectedTarget) {
    await layer.transactionImmediate(async (tx) => {
      await assertActiveApprovalLeaseWithinTransaction(authorityStore, tx, context, approvalInput);
    });
    if (fault === "foreign-before-cas") {
      await moveTargetToForeignCommit(prepared);
    }
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
