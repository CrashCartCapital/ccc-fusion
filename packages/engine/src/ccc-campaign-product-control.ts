import {
  createHash,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { realpath } from "node:fs/promises";
import {
  canonicalCccPrdJson,
  claimCccCampaignApproval,
  createCccCampaignAuthorityBinding,
  getApprovalRequest,
  issueCccCampaignApproval as issuePersistedCccCampaignApproval,
  selectCccCampaignDeclaredLiveExecutionAction,
  type ApprovalRequest,
  type ApprovalRequestActorSnapshot,
  type CccCampaignActionLookup,
  type CccCampaignTaskContext,
  type CccPrdProductApprovalStatus,
  type MergeResult,
  type TaskStore,
} from "@fusion/core";
import { matchesCccCampaignMergeControl } from "./ccc-campaign-merge-control.js";
import { PermanentError } from "./engine-errors.js";
import { runAiMerge } from "./merger-ai.js";

export const CCC_CAMPAIGN_MERGE_APPROVAL_REQUIRED_CODE =
  "CCC_CAMPAIGN_MERGE_APPROVAL_REQUIRED";

export const CCC_CAMPAIGN_MERGE_APPROVAL_REQUIRED_REASON =
  `ccc-permanent:${CCC_CAMPAIGN_MERGE_APPROVAL_REQUIRED_CODE}`;

export const CCC_CAMPAIGN_LIVE_EXECUTION_APPROVAL_REQUIRED_CODE =
  "CCC_CAMPAIGN_LIVE_EXECUTION_APPROVAL_REQUIRED";

export const CCC_CAMPAIGN_LIVE_EXECUTION_APPROVAL_REQUIRED_REASON =
  `ccc-permanent:${CCC_CAMPAIGN_LIVE_EXECUTION_APPROVAL_REQUIRED_CODE}`;

const MERGE_APPROVAL_REQUESTER: ApprovalRequestActorSnapshot = Object.freeze({
  actorId: "ccc-campaign-runtime",
  actorType: "agent",
  actorName: "CCC Campaign Runtime",
});

const LIVE_EXECUTION_APPROVAL_REQUESTER: ApprovalRequestActorSnapshot =
  Object.freeze({
    actorId: "ccc-campaign-runtime",
    actorType: "agent",
    actorName: "CCC Campaign Runtime",
  });

type CampaignAuthorityStore = TaskStore & {
  getCccCampaignContextForTask(taskId: string): Promise<CccCampaignTaskContext | null>;
};

export type IssueCccCampaignMergeApprovalInput = Readonly<{
  store: CampaignAuthorityStore;
  rootDir: string;
  taskId: string;
  runId: string;
}>;

export type ApproveCccCampaignMergeInput = Readonly<{
  store: CampaignAuthorityStore;
  rootDir: string;
  taskId: string;
  approvalRequestId: string;
  confirmation: string;
  actor: ApprovalRequestActorSnapshot;
}>;

export type IssueCccCampaignLiveExecutionApprovalInput = Readonly<{
  store: CampaignAuthorityStore;
  rootDir: string;
  taskId: string;
  runId: string;
}>;

export type ApproveCccCampaignLiveExecutionInput = Readonly<{
  store: CampaignAuthorityStore;
  rootDir: string;
  taskId: string;
  approvalRequestId: string;
  confirmation: string;
  actor: ApprovalRequestActorSnapshot;
}>;

function exactMergeAction(context: CccCampaignTaskContext): CccCampaignActionLookup {
  if (context.executionPolicy.schema !== "ccc-campaign.execution-policy.v2") {
    throw new PermanentError(
      "CCC campaign merge approval is available only for product execution policy v2",
      "CCC_CAMPAIGN_PRODUCT_EXECUTION_REQUIRED",
    );
  }
  const protectedIds = new Set(context.protectedActionIds);
  const mergeActions = context.protectedActions.filter((action) =>
    action.kind === "merge" && protectedIds.has(action.id));
  if (mergeActions.length !== 1) {
    throw new PermanentError(
      `CCC campaign task ${context.taskId} requires exactly one protected merge action`,
      "CCC_CAMPAIGN_MERGE_ACTION_REFUSED",
    );
  }
  const action = mergeActions[0]!;
  return {
    actionId: action.id,
    actionTarget: action.target,
    requireProtected: true,
  };
}

async function exactCampaignContext(
  store: CampaignAuthorityStore,
  taskId: string,
): Promise<CccCampaignTaskContext> {
  const context = await store.getCccCampaignContextForTask(taskId);
  if (
    !context
    || context.taskId !== taskId
    || context.route.taskId !== context.semanticTaskId
  ) {
    throw new PermanentError(
      `CCC campaign merge task ${taskId} has no exact persisted campaign custody`,
      "CCC_CAMPAIGN_MERGE_CUSTODY_REFUSED",
    );
  }
  return context;
}

/**
 * Persist the one campaign-bound merge decision request after executed proof.
 *
 * Issuance is idempotent for the immutable campaign/action/run binding. It does
 * not claim authority and does not touch Git.
 */
export async function issueCccCampaignMergeApproval(
  input: IssueCccCampaignMergeApprovalInput,
): Promise<ApprovalRequest> {
  const layer = input.store.getAsyncLayer();
  if (!layer) {
    throw new PermanentError(
      "CCC campaign merge approval requires PostgreSQL custody",
      "CCC_CAMPAIGN_MERGE_APPROVAL_STORE_REQUIRED",
    );
  }
  const context = await exactCampaignContext(input.store, input.taskId);
  return issuePersistedCccCampaignApproval(layer, {
    authorityStore: input.store,
    rootDir: input.rootDir,
    taskId: input.taskId,
    action: exactMergeAction(context),
    requester: MERGE_APPROVAL_REQUESTER,
    runId: input.runId,
    notBeforeAt: context.campaignStartedAt,
    expiresAt: context.campaignDeadlineAt,
  });
}

/**
 * Digest shown by status and required by the human approval command.
 *
 * Mutable lifecycle fields and hidden claim material are intentionally absent,
 * so an issued request can be safely retried after claim or landing recovery.
 */
export function computeCccCampaignMergeApprovalConfirmation(
  approval: ApprovalRequest,
): string {
  if (!approval.campaign) {
    throw new TypeError("CCC campaign merge approval confirmation requires campaign custody");
  }
  return createHash("sha256")
    .update(canonicalCccPrdJson({
      schema: "ccc-campaign.merge-approval-confirmation.v1",
      approvalRequestId: approval.id,
      taskId: approval.taskId ?? null,
      runId: approval.runId ?? null,
      targetAction: approval.targetAction,
      binding: approval.campaign.binding,
      notBeforeAt: approval.campaign.notBeforeAt,
      expiresAt: approval.campaign.expiresAt,
    }), "utf8")
    .digest("hex");
}

function exactConfirmation(provided: string, expected: string): boolean {
  if (!/^[0-9a-f]{64}$/u.test(provided) || !/^[0-9a-f]{64}$/u.test(expected)) {
    return false;
  }
  return timingSafeEqual(
    Buffer.from(provided, "hex"),
    Buffer.from(expected, "hex"),
  );
}

function assertExactApprovalBinding(
  approval: ApprovalRequest,
  context: CccCampaignTaskContext,
  action: CccCampaignActionLookup,
): void {
  if (
    !approval.campaign
    || approval.taskId !== context.taskId
    || canonicalCccPrdJson(approval.campaign.binding)
      !== canonicalCccPrdJson(createCccCampaignAuthorityBinding(context, action))
  ) {
    throw new PermanentError(
      `CCC campaign merge approval ${approval.id} does not match current campaign custody`,
      "CCC_CAMPAIGN_MERGE_APPROVAL_DRIFT",
    );
  }
}

/**
 * Claim the exact human decision and execute the recovery-aware native landing.
 *
 * A retry after claim or after ref CAS reuses persisted custody; it never
 * creates a second approval or a second uncontrolled Git effect.
 */
export async function approveCccCampaignMerge(
  input: ApproveCccCampaignMergeInput,
): Promise<MergeResult> {
  const layer = input.store.getAsyncLayer();
  if (!layer) {
    throw new PermanentError(
      "CCC campaign merge approval requires PostgreSQL custody",
      "CCC_CAMPAIGN_MERGE_APPROVAL_STORE_REQUIRED",
    );
  }
  const context = await exactCampaignContext(input.store, input.taskId);
  const action = exactMergeAction(context);
  let approval = await getApprovalRequest(layer.db, input.approvalRequestId);
  if (!approval || approval.id !== input.approvalRequestId) {
    throw new PermanentError(
      `CCC campaign merge approval ${input.approvalRequestId} is missing`,
      "CCC_CAMPAIGN_MERGE_APPROVAL_MISSING",
    );
  }
  assertExactApprovalBinding(approval, context, action);
  const expectedConfirmation =
    computeCccCampaignMergeApprovalConfirmation(approval);
  if (!exactConfirmation(input.confirmation, expectedConfirmation)) {
    throw new PermanentError(
      "CCC campaign merge approval confirmation is stale or does not match",
      "CCC_CAMPAIGN_MERGE_CONFIRMATION_REFUSED",
    );
  }

  if (approval.status === "issued") {
    try {
      approval = await claimCccCampaignApproval(layer, {
        authorityStore: input.store,
        rootDir: input.rootDir,
        taskId: input.taskId,
        action,
        claimant: input.actor,
        runId: `ccc-merge-approval:${approval.id}`,
        claimToken: randomUUID(),
      });
    } catch (error) {
      const concurrent = await getApprovalRequest(layer.db, approval.id);
      if (!concurrent || concurrent.status !== "claimed") throw error;
      assertExactApprovalBinding(concurrent, context, action);
      approval = concurrent;
    }
  }
  if (!["claimed", "consumed"].includes(approval.status)) {
    throw new PermanentError(
      `CCC campaign merge approval ${approval.id} is ${approval.status}, not claimable`,
      "CCC_CAMPAIGN_MERGE_APPROVAL_NOT_CLAIMABLE",
    );
  }

  const result = await runAiMerge(
    input.store,
    input.rootDir,
    input.taskId,
    { manual: true },
  );
  if (!matchesCccCampaignMergeControl(result.campaignControlled, context)) {
    throw new PermanentError(
      "CCC campaign merge returned without exact campaign-controlled landing proof",
      "CCC_CAMPAIGN_MERGE_AUTHORITY_MISMATCH",
    );
  }
  return result;
}

/**
 * Called by the graph merge seam after proof. It always leaves landing for an
 * explicit human action unless an exact claimed lease already exists.
 */
export async function requireCccCampaignMergeApproval(
  input: IssueCccCampaignMergeApprovalInput,
): Promise<ApprovalRequest> {
  const approval = await issueCccCampaignMergeApproval(input);
  const context = await exactCampaignContext(input.store, input.taskId);
  const action = exactMergeAction(context);
  const lease = context.activeActionLeases[action.actionId];
  if (
    approval.status !== "claimed"
    || !approval.campaign?.claimToken
    || !lease
    || lease.approvalRequestId !== approval.id
    || lease.claimToken !== approval.campaign.claimToken
    || lease.actionId !== action.actionId
    || lease.actionTarget !== action.actionTarget
  ) {
    throw new PermanentError(
      `CCC campaign ${context.campaignId} is proved and awaiting exact human merge approval ${approval.id}`,
      CCC_CAMPAIGN_MERGE_APPROVAL_REQUIRED_CODE,
    );
  }
  return approval;
}

function exactLiveExecutionAction(
  context: CccCampaignTaskContext,
): CccCampaignActionLookup {
  if (context.executionPolicy.schema !== "ccc-campaign.execution-policy.v2") {
    throw new PermanentError(
      "CCC campaign live-execution approval is available only for product execution policy v2",
      "CCC_CAMPAIGN_PRODUCT_EXECUTION_REQUIRED",
    );
  }
  try {
    return selectCccCampaignDeclaredLiveExecutionAction(
      context.protectedActions,
      context.protectedActionIds,
    );
  } catch (error) {
    throw new PermanentError(
      `CCC campaign task ${context.taskId} requires exactly one assigned live-execution protected action`,
      "CCC_CAMPAIGN_LIVE_EXECUTION_ACTION_REFUSED",
      undefined,
      error instanceof Error ? error : undefined,
    );
  }
}

async function exactLiveExecutionCampaignContext(
  store: CampaignAuthorityStore,
  rootDir: string,
  taskId: string,
): Promise<CccCampaignTaskContext> {
  const context = await store.getCccCampaignContextForTask(taskId);
  const canonicalRoot = await realpath(rootDir).catch(() => null);
  if (
    !context
    || context.taskId !== taskId
    || context.route.taskId !== context.semanticTaskId
    || canonicalRoot !== context.targetRepository.path
  ) {
    throw new PermanentError(
      `CCC campaign live-execution task ${taskId} has no exact persisted campaign custody`,
      "CCC_CAMPAIGN_LIVE_EXECUTION_CUSTODY_REFUSED",
    );
  }
  return context;
}

function expectedLiveExecutionTargetAction(
  action: CccCampaignActionLookup,
): ApprovalRequest["targetAction"] {
  return {
    category: "command_execution",
    action: action.actionId,
    summary: `CCC live_execution protected action ${action.actionId}`,
    resourceType: "ccc-campaign-live_execution",
    resourceId: action.actionTarget,
    context: {
      protectedActionKind: "live_execution",
      operatorDecision: "approve_live_execution",
    },
  };
}

function assertExactLiveExecutionApprovalBinding(
  approval: ApprovalRequest,
  context: CccCampaignTaskContext,
  action: CccCampaignActionLookup,
): void {
  if (
    !approval.campaign
    || approval.taskId !== context.taskId
    || approval.campaign.notBeforeAt !== context.campaignStartedAt
    || approval.campaign.expiresAt !== context.campaignDeadlineAt
    || canonicalCccPrdJson(approval.requester)
      !== canonicalCccPrdJson(LIVE_EXECUTION_APPROVAL_REQUESTER)
    || canonicalCccPrdJson(approval.targetAction)
      !== canonicalCccPrdJson(expectedLiveExecutionTargetAction(action))
    || canonicalCccPrdJson(approval.campaign.binding)
      !== canonicalCccPrdJson(createCccCampaignAuthorityBinding(context, action))
  ) {
    throw new PermanentError(
      `CCC campaign live-execution approval ${approval.id} does not match current campaign custody`,
      "CCC_CAMPAIGN_LIVE_EXECUTION_APPROVAL_DRIFT",
    );
  }
}

function redactLiveExecutionApproval(
  approval: ApprovalRequest,
): CccPrdProductApprovalStatus {
  if (!approval.campaign) {
    throw new PermanentError(
      `CCC campaign live-execution approval ${approval.id} has no campaign custody`,
      "CCC_CAMPAIGN_LIVE_EXECUTION_APPROVAL_DRIFT",
    );
  }
  const { claimToken: _claimToken, ...campaign } = approval.campaign;
  return {
    ...approval,
    actionId: campaign.binding.actionId,
    actionTarget: campaign.binding.actionTarget,
    campaign,
  };
}

/**
 * Issue the exact product-v2 live-execution decision without dispatching work.
 *
 * The persistence primitive owns immutable idempotency. This wrapper selects
 * only the live action assigned to the semantic task and returns the same
 * claim-token-free shape used by product status.
 */
export async function issueCccCampaignLiveExecutionApproval(
  input: IssueCccCampaignLiveExecutionApprovalInput,
): Promise<CccPrdProductApprovalStatus> {
  const layer = input.store.getAsyncLayer();
  if (!layer) {
    throw new PermanentError(
      "CCC campaign live-execution approval requires PostgreSQL custody",
      "CCC_CAMPAIGN_LIVE_EXECUTION_APPROVAL_STORE_REQUIRED",
    );
  }
  const context = await exactLiveExecutionCampaignContext(
    input.store,
    input.rootDir,
    input.taskId,
  );
  const action = exactLiveExecutionAction(context);
  const approval = await issuePersistedCccCampaignApproval(layer, {
    authorityStore: input.store,
    rootDir: input.rootDir,
    taskId: input.taskId,
    action,
    requester: LIVE_EXECUTION_APPROVAL_REQUESTER,
    runId: input.runId,
    notBeforeAt: context.campaignStartedAt,
    expiresAt: context.campaignDeadlineAt,
  });
  assertExactLiveExecutionApprovalBinding(approval, context, action);
  return redactLiveExecutionApproval(approval);
}

/**
 * Stable human confirmation over immutable approval and campaign authority.
 *
 * Mutable status, timestamps, and the hidden claim token are excluded so the
 * same digest remains valid across an idempotent claim replay.
 */
export function computeCccCampaignLiveExecutionApprovalConfirmation(
  approval: ApprovalRequest,
): string {
  if (!approval.campaign) {
    throw new TypeError(
      "CCC campaign live-execution approval confirmation requires campaign custody",
    );
  }
  return createHash("sha256")
    .update(canonicalCccPrdJson({
      schema: "ccc-campaign.live-execution-approval-confirmation.v1",
      approvalRequestId: approval.id,
      taskId: approval.taskId ?? null,
      runId: approval.runId ?? null,
      targetAction: approval.targetAction,
      binding: approval.campaign.binding,
      notBeforeAt: approval.campaign.notBeforeAt,
      expiresAt: approval.campaign.expiresAt,
    }), "utf8")
    .digest("hex");
}

async function assertExactLiveExecutionClaimLease(
  store: CampaignAuthorityStore,
  context: CccCampaignTaskContext,
  action: CccCampaignActionLookup,
  approval: ApprovalRequest,
): Promise<void> {
  const claimToken = approval.campaign?.claimToken;
  const lease = await store.inspectCccCampaignActionLease(
    context.taskId,
    action,
  );
  if (
    approval.status !== "claimed"
    || !approval.campaign
    || !claimToken
    || !approval.campaign.claimedAt
    || !lease
    || lease.binding.bindingHash !== approval.campaign.binding.bindingHash
    || lease.lease.approvalRequestId !== approval.id
    || lease.lease.claimToken !== claimToken
    || lease.lease.actionId !== action.actionId
    || lease.lease.actionTarget !== action.actionTarget
    || lease.lease.bindingHash !== approval.campaign.binding.bindingHash
    || lease.lease.claimedAt !== approval.campaign.claimedAt
    || lease.lease.expiresAt !== approval.campaign.expiresAt
  ) {
    throw new PermanentError(
      `CCC campaign live-execution approval ${approval.id} has no exact active claim lease`,
      "CCC_CAMPAIGN_LIVE_EXECUTION_APPROVAL_LEASE_DRIFT",
    );
  }
}

/**
 * Claim only the exact live-execution decision and action lease.
 *
 * Provider dispatch and workflow work-item mutation remain separate seams.
 * The returned operator payload intentionally omits the claim token.
 */
export async function approveCccCampaignLiveExecution(
  input: ApproveCccCampaignLiveExecutionInput,
): Promise<CccPrdProductApprovalStatus> {
  const layer = input.store.getAsyncLayer();
  if (!layer) {
    throw new PermanentError(
      "CCC campaign live-execution approval requires PostgreSQL custody",
      "CCC_CAMPAIGN_LIVE_EXECUTION_APPROVAL_STORE_REQUIRED",
    );
  }
  const context = await exactLiveExecutionCampaignContext(
    input.store,
    input.rootDir,
    input.taskId,
  );
  const action = exactLiveExecutionAction(context);
  let approval = await getApprovalRequest(layer.db, input.approvalRequestId);
  if (!approval || approval.id !== input.approvalRequestId) {
    throw new PermanentError(
      `CCC campaign live-execution approval ${input.approvalRequestId} is missing`,
      "CCC_CAMPAIGN_LIVE_EXECUTION_APPROVAL_MISSING",
    );
  }
  assertExactLiveExecutionApprovalBinding(approval, context, action);
  const expectedConfirmation =
    computeCccCampaignLiveExecutionApprovalConfirmation(approval);
  if (!exactConfirmation(input.confirmation, expectedConfirmation)) {
    throw new PermanentError(
      "CCC campaign live-execution approval confirmation is stale or does not match",
      "CCC_CAMPAIGN_LIVE_EXECUTION_CONFIRMATION_REFUSED",
    );
  }

  if (approval.status === "issued") {
    try {
      approval = await claimCccCampaignApproval(layer, {
        authorityStore: input.store,
        rootDir: input.rootDir,
        taskId: input.taskId,
        action,
        claimant: input.actor,
        runId: `ccc-live-execution-approval:${approval.id}`,
        claimToken: randomUUID(),
      });
    } catch (error) {
      const concurrent = await getApprovalRequest(layer.db, approval.id);
      if (!concurrent || concurrent.status !== "claimed") throw error;
      assertExactLiveExecutionApprovalBinding(concurrent, context, action);
      approval = concurrent;
    }
  }
  if (approval.status !== "claimed") {
    throw new PermanentError(
      `CCC campaign live-execution approval ${approval.id} is ${approval.status}, not claimable`,
      "CCC_CAMPAIGN_LIVE_EXECUTION_APPROVAL_NOT_CLAIMABLE",
    );
  }
  await assertExactLiveExecutionClaimLease(
    input.store,
    context,
    action,
    approval,
  );
  return redactLiveExecutionApproval(approval);
}

/**
 * Issue or replay the task's exact live-execution approval, then stop unless
 * its matching claimed action lease is already durable.
 *
 * This seam neither claims the decision nor dispatches provider work. Its
 * successful replay is redacted for direct operator-surface compatibility.
 */
export async function requireCccCampaignLiveExecutionApproval(
  input: IssueCccCampaignLiveExecutionApprovalInput,
): Promise<CccPrdProductApprovalStatus> {
  const approval = await issueCccCampaignLiveExecutionApproval(input);
  const layer = input.store.getAsyncLayer();
  if (!layer) {
    throw new PermanentError(
      "CCC campaign live-execution approval requires PostgreSQL custody",
      "CCC_CAMPAIGN_LIVE_EXECUTION_APPROVAL_STORE_REQUIRED",
    );
  }
  const context = await exactLiveExecutionCampaignContext(
    input.store,
    input.rootDir,
    input.taskId,
  );
  const action = exactLiveExecutionAction(context);
  const persisted = await getApprovalRequest(layer.db, approval.id);
  try {
    if (!persisted || persisted.id !== approval.id) {
      throw new Error("live-execution approval disappeared after issuance");
    }
    assertExactLiveExecutionApprovalBinding(persisted, context, action);
    await assertExactLiveExecutionClaimLease(
      input.store,
      context,
      action,
      persisted,
    );
  } catch (error) {
    throw new PermanentError(
      `CCC campaign ${context.campaignId} is awaiting exact human live-execution approval ${approval.id}`,
      CCC_CAMPAIGN_LIVE_EXECUTION_APPROVAL_REQUIRED_CODE,
      undefined,
      error instanceof Error ? error : undefined,
    );
  }
  return redactLiveExecutionApproval(persisted);
}
