import {
  createHash,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { realpath } from "node:fs/promises";
import {
  CCC_CAMPAIGN_EXECUTION_AUTHORIZATION_SCHEMA_VERSION,
  canonicalCccPrdJson,
  claimCccCampaignApproval,
  claimCccCampaignExecutionAuthorization,
  createCccCampaignAuthorityBinding,
  getApprovalRequest,
  getCccCampaignExecutionAuthorization,
  issueCccCampaignApproval as issuePersistedCccCampaignApproval,
  issueCccCampaignExecutionAuthorization,
  selectCccCampaignDeclaredLiveExecutionAction,
  type ApprovalRequest,
  type ApprovalRequestActorSnapshot,
  type CccCampaignActionLookup,
  type CccCampaignExecutionAuthorization,
  type CccCampaignTaskContext,
  type CccPrdProductApprovalStatus,
  type MergeResult,
  type TaskStore,
} from "@fusion/core";
import { matchesCccCampaignMergeControl } from "./ccc-campaign-merge-control.js";
import {
  deriveCccCampaignFinalProofCustodyForCurrentSource,
  encodeCccCampaignMergeProofRunId,
  parseCccCampaignMergeProofRunId,
  type CccCampaignFinalProofCustody,
} from "./ccc-campaign-git-landing.js";
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

type ApproveCccCampaignLiveExecutionBaseInput = Readonly<{
  store: CampaignAuthorityStore;
  rootDir: string;
  taskId: string;
  confirmation: string;
  actor: ApprovalRequestActorSnapshot;
}>;

export type ApproveCccCampaignLiveExecutionInput =
  ApproveCccCampaignLiveExecutionBaseInput & (
    | Readonly<{
      /** Required for sealed-bundle manifests. */
      authorizationId: string;
      approvalRequestId?: never;
    }>
    | Readonly<{
      /** Required only for legacy per-task manifests. */
      approvalRequestId: string;
      authorizationId?: never;
    }>
  );

export type CccCampaignLiveExecutionAuthorizationStatus = Omit<
  CccCampaignExecutionAuthorization,
  "claimToken"
>;

export type CccCampaignLiveExecutionApprovalStatus =
  | CccPrdProductApprovalStatus
  | CccCampaignLiveExecutionAuthorizationStatus;

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
  let finalProofCustody: CccCampaignFinalProofCustody | null;
  try {
    finalProofCustody = await deriveCccCampaignFinalProofCustodyForCurrentSource(
      input.store,
      context,
      input.rootDir,
    );
  } catch (error) {
    throw new PermanentError(
      "CCC campaign merge approval requires an exact passing final_integrated proof receipt set",
      "CCC_CAMPAIGN_MERGE_PROOF_CUSTODY_REFUSED",
      undefined,
      error instanceof Error ? error : undefined,
    );
  }
  return issuePersistedCccCampaignApproval(layer, {
    authorityStore: input.store,
    rootDir: input.rootDir,
    taskId: input.taskId,
    action: exactMergeAction(context),
    requester: MERGE_APPROVAL_REQUESTER,
    runId: finalProofCustody
      ? encodeCccCampaignMergeProofRunId(finalProofCustody)
      : input.runId,
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
  const finalProofCustody = parseCccCampaignMergeProofRunId(approval.runId);
  const confirmation = finalProofCustody
    ? {
      schema: "ccc-campaign.merge-approval-confirmation.v2",
      approvalRequestId: approval.id,
      taskId: approval.taskId ?? null,
      runId: approval.runId ?? null,
      targetAction: approval.targetAction,
      binding: approval.campaign.binding,
      finalProofCustody,
      notBeforeAt: approval.campaign.notBeforeAt,
      expiresAt: approval.campaign.expiresAt,
    }
    : {
      schema: "ccc-campaign.merge-approval-confirmation.v1",
      approvalRequestId: approval.id,
      taskId: approval.taskId ?? null,
      runId: approval.runId ?? null,
      targetAction: approval.targetAction,
      binding: approval.campaign.binding,
      notBeforeAt: approval.campaign.notBeforeAt,
      expiresAt: approval.campaign.expiresAt,
    };
  return createHash("sha256")
    .update(canonicalCccPrdJson(confirmation), "utf8")
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

async function assertCurrentSemanticMergeProofCustody(
  store: CampaignAuthorityStore,
  rootDir: string,
  context: CccCampaignTaskContext,
  approval: ApprovalRequest,
): Promise<void> {
  if (!context.proofs.some((proof) => proof.schema === "ccc-prd.proof.v2")) {
    return;
  }
  const approvedCustody = parseCccCampaignMergeProofRunId(approval.runId);
  try {
    const currentCustody = await deriveCccCampaignFinalProofCustodyForCurrentSource(
      store,
      context,
      rootDir,
    );
    if (
      !approvedCustody
      || !currentCustody
      || canonicalCccPrdJson(approvedCustody) !== canonicalCccPrdJson(currentCustody)
    ) {
      throw new Error("CCC campaign merge proof custody drifted after approval issuance");
    }
  } catch (error) {
    throw new PermanentError(
      "CCC campaign merge approval no longer matches the exact passing final_integrated proof custody",
      "CCC_CAMPAIGN_MERGE_PROOF_CUSTODY_REFUSED",
      undefined,
      error instanceof Error ? error : undefined,
    );
  }
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
    await assertCurrentSemanticMergeProofCustody(
      input.store,
      input.rootDir,
      context,
      approval,
    );
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

function redactLiveExecutionAuthorization(
  authorization: CccCampaignExecutionAuthorization,
): CccCampaignLiveExecutionAuthorizationStatus {
  const { claimToken: _claimToken, ...redacted } = authorization;
  return redacted;
}

function isSealedLiveExecutionAuthorization(
  value: ApprovalRequest | CccCampaignLiveExecutionApprovalStatus,
): value is CccCampaignLiveExecutionAuthorizationStatus {
  return "schemaVersion" in value
    && value.schemaVersion === CCC_CAMPAIGN_EXECUTION_AUTHORIZATION_SCHEMA_VERSION
    && "authorizationId" in value;
}

function assertExactLiveExecutionAuthorizationBinding(
  authorization: CccCampaignExecutionAuthorization,
  context: CccCampaignTaskContext,
  action: CccCampaignActionLookup,
): CccCampaignExecutionAuthorization["members"][number] {
  const binding = createCccCampaignAuthorityBinding(context, action);
  const members = authorization.members.filter(({ nativeTaskId }) =>
    nativeTaskId === context.taskId);
  const member = members[0];
  if (
    authorization.schemaVersion !== CCC_CAMPAIGN_EXECUTION_AUTHORIZATION_SCHEMA_VERSION
    || authorization.projectId !== context.projectId
    || authorization.importId !== context.importId
    || authorization.campaignId !== context.campaignId
    || authorization.idempotencyKey !== context.idempotencyKey
    || authorization.packetHash !== context.packetHash
    || authorization.sidecarHash !== context.sidecarHash
    || authorization.bundleHash !== context.bundleHash
    || authorization.manifestHash !== context.manifestHash
    || authorization.targetRepository !== context.targetRepository.path
    || authorization.targetBase !== context.targetRepository.baseCommit
    || authorization.campaignStartedAt !== context.campaignStartedAt
    || authorization.campaignDeadlineAt !== context.campaignDeadlineAt
    || authorization.maxRequests !== context.bounds.maxRequests
    || authorization.maxConcurrency !== context.bounds.maxConcurrency
    || authorization.notBeforeAt !== context.campaignStartedAt
    || authorization.expiresAt !== context.campaignDeadlineAt
    || canonicalCccPrdJson(authorization.requester)
      !== canonicalCccPrdJson(LIVE_EXECUTION_APPROVAL_REQUESTER)
    || members.length !== 1
    || !member
    || member.semanticTaskId !== context.semanticTaskId
    || member.actionId !== action.actionId
    || member.actionTarget !== action.actionTarget
    || member.bindingHash !== binding.bindingHash
    || member.providerId !== binding.providerId
    || member.modelId !== binding.modelId
    || member.transport !== binding.transport
    || member.promptSchema !== context.executionCustody?.promptSchema
    || member.promptSha256 !== context.executionCustody?.promptSha256
    || member.routeSha256 !== context.executionCustody?.routeSha256
    || member.approvalRequestId !== `ccc-approval-${binding.bindingHash}`
  ) {
    throw new PermanentError(
      `CCC campaign live-execution authorization ${authorization.authorizationId} does not match current campaign custody`,
      "CCC_CAMPAIGN_LIVE_EXECUTION_APPROVAL_DRIFT",
    );
  }
  return member;
}

async function assertExactSealedLiveExecutionMemberClaim(
  store: CampaignAuthorityStore,
  rootDir: string,
  authorization: CccCampaignExecutionAuthorization,
  taskId: string,
): Promise<void> {
  if (authorization.status !== "claimed" || !authorization.claimToken) {
    throw new PermanentError(
      `CCC campaign live-execution authorization ${authorization.authorizationId} is not exactly claimed`,
      "CCC_CAMPAIGN_LIVE_EXECUTION_APPROVAL_NOT_CLAIMABLE",
    );
  }
  const layer = store.getAsyncLayer();
  if (!layer) {
    throw new PermanentError(
      "CCC campaign live-execution authorization requires PostgreSQL custody",
      "CCC_CAMPAIGN_LIVE_EXECUTION_APPROVAL_STORE_REQUIRED",
    );
  }
  const context = await exactLiveExecutionCampaignContext(store, rootDir, taskId);
  const action = exactLiveExecutionAction(context);
  const member = assertExactLiveExecutionAuthorizationBinding(
    authorization,
    context,
    action,
  );
  const child = await getApprovalRequest(layer.db, member.approvalRequestId);
  if (!child) {
    throw new PermanentError(
      `CCC campaign live-execution authorization ${authorization.authorizationId} is missing child approval ${member.approvalRequestId}`,
      "CCC_CAMPAIGN_LIVE_EXECUTION_APPROVAL_LEASE_DRIFT",
    );
  }
  assertExactLiveExecutionApprovalBinding(child, context, action);
  await assertExactLiveExecutionClaimLease(store, context, action, child);
}

async function assertAllExactSealedLiveExecutionClaims(
  store: CampaignAuthorityStore,
  rootDir: string,
  authorization: CccCampaignExecutionAuthorization,
): Promise<void> {
  for (const { nativeTaskId } of authorization.members) {
    await assertExactSealedLiveExecutionMemberClaim(
      store,
      rootDir,
      authorization,
      nativeTaskId,
    );
  }
}

/**
 * Issue the exact live-execution decision without dispatching work.
 *
 * Manifest-v2 campaigns issue one sealed parent over every provider member;
 * manifest-v1 campaigns retain the original per-task approval. Both operator
 * shapes omit claim tokens.
 */
export async function issueCccCampaignLiveExecutionApproval(
  input: IssueCccCampaignLiveExecutionApprovalInput,
): Promise<CccCampaignLiveExecutionApprovalStatus> {
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
  if (context.executionAuthorizationMode === "sealed_bundle_v1") {
    const authorization = await issueCccCampaignExecutionAuthorization(layer, {
      authorityStore: input.store,
      rootDir: input.rootDir,
      taskId: input.taskId,
      requester: LIVE_EXECUTION_APPROVAL_REQUESTER,
      notBeforeAt: context.campaignStartedAt,
      expiresAt: context.campaignDeadlineAt,
    });
    assertExactLiveExecutionAuthorizationBinding(
      authorization,
      context,
      action,
    );
    return redactLiveExecutionAuthorization(authorization);
  }
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
  approval: ApprovalRequest | CccCampaignLiveExecutionApprovalStatus,
): string {
  if (isSealedLiveExecutionAuthorization(approval)) {
    return createHash("sha256")
      .update(canonicalCccPrdJson({
        schema: "ccc-campaign.live-execution-approval-confirmation.v2",
        authorizationId: approval.authorizationId,
        authorizationDigest: approval.authorizationDigest,
        memberSetHash: approval.memberSetHash,
        members: approval.members,
        projectId: approval.projectId,
        importId: approval.importId,
        campaignId: approval.campaignId,
        idempotencyKey: approval.idempotencyKey,
        workflowId: approval.workflowId,
        workItemId: approval.workItemId,
        workflowIrHash: approval.workflowIrHash,
        packetHash: approval.packetHash,
        sidecarHash: approval.sidecarHash,
        bundleHash: approval.bundleHash,
        manifestHash: approval.manifestHash,
        executionPolicySha256: approval.executionPolicySha256,
        targetRepository: approval.targetRepository,
        targetBase: approval.targetBase,
        campaignStartedAt: approval.campaignStartedAt,
        campaignDeadlineAt: approval.campaignDeadlineAt,
        maxRequests: approval.maxRequests,
        maxConcurrency: approval.maxConcurrency,
        expectedRequestCount: approval.expectedRequestCount,
        requester: approval.requester,
        notBeforeAt: approval.notBeforeAt,
        expiresAt: approval.expiresAt,
      }), "utf8")
      .digest("hex");
  }
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
 * Claim the sealed launch decision, or the legacy exact per-task decision.
 *
 * A sealed claim atomically creates every exact child lease, while provider
 * dispatch remains task-specific. The returned operator payload omits tokens.
 */
export async function approveCccCampaignLiveExecution(
  input: ApproveCccCampaignLiveExecutionInput,
): Promise<CccCampaignLiveExecutionApprovalStatus> {
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
  if (context.executionAuthorizationMode === "sealed_bundle_v1") {
    if (!input.authorizationId || input.approvalRequestId !== undefined) {
      throw new PermanentError(
        "CCC sealed live-execution approval requires exactly one parent authorization ID",
        "CCC_CAMPAIGN_LIVE_EXECUTION_APPROVAL_MISSING",
      );
    }
    let authorization = await getCccCampaignExecutionAuthorization(
      layer.db,
      input.authorizationId,
    );
    if (!authorization || authorization.authorizationId !== input.authorizationId) {
      throw new PermanentError(
        `CCC campaign live-execution authorization ${input.authorizationId} is missing`,
        "CCC_CAMPAIGN_LIVE_EXECUTION_APPROVAL_MISSING",
      );
    }
    const action = exactLiveExecutionAction(context);
    assertExactLiveExecutionAuthorizationBinding(authorization, context, action);
    const expectedConfirmation =
      computeCccCampaignLiveExecutionApprovalConfirmation(authorization);
    if (!exactConfirmation(input.confirmation, expectedConfirmation)) {
      throw new PermanentError(
        "CCC campaign live-execution authorization confirmation is stale or does not match",
        "CCC_CAMPAIGN_LIVE_EXECUTION_CONFIRMATION_REFUSED",
      );
    }
    if (authorization.status === "issued") {
      try {
        authorization = await claimCccCampaignExecutionAuthorization(layer, {
          authorityStore: input.store,
          rootDir: input.rootDir,
          authorizationId: authorization.authorizationId,
          claimant: input.actor,
          claimToken: randomUUID(),
        });
      } catch (error) {
        const concurrent = await getCccCampaignExecutionAuthorization(
          layer.db,
          authorization.authorizationId,
        );
        if (!concurrent || concurrent.status !== "claimed") throw error;
        assertExactLiveExecutionAuthorizationBinding(concurrent, context, action);
        authorization = concurrent;
      }
    }
    if (authorization.status !== "claimed") {
      throw new PermanentError(
        `CCC campaign live-execution authorization ${authorization.authorizationId} is ${authorization.status}, not claimable`,
        "CCC_CAMPAIGN_LIVE_EXECUTION_APPROVAL_NOT_CLAIMABLE",
      );
    }
    await assertAllExactSealedLiveExecutionClaims(
      input.store,
      input.rootDir,
      authorization,
    );
    return redactLiveExecutionAuthorization(authorization);
  }
  if (!input.approvalRequestId || input.authorizationId !== undefined) {
    throw new PermanentError(
      "CCC legacy live-execution approval requires exactly one child approval request ID",
      "CCC_CAMPAIGN_LIVE_EXECUTION_APPROVAL_MISSING",
    );
  }
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
 * Issue or replay live-execution authority, then stop unless this task's exact
 * child lease is already durable.
 *
 * This seam neither claims the decision nor dispatches provider work. Its
 * successful replay is redacted for direct operator-surface compatibility.
 */
export async function requireCccCampaignLiveExecutionApproval(
  input: IssueCccCampaignLiveExecutionApprovalInput,
): Promise<CccCampaignLiveExecutionApprovalStatus> {
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
  if (context.executionAuthorizationMode === "sealed_bundle_v1") {
    if (!isSealedLiveExecutionAuthorization(approval)) {
      throw new PermanentError(
        `CCC campaign ${context.campaignId} has mismatched sealed live-execution authorization custody`,
        CCC_CAMPAIGN_LIVE_EXECUTION_APPROVAL_REQUIRED_CODE,
      );
    }
    const persisted = await getCccCampaignExecutionAuthorization(
      layer.db,
      approval.authorizationId,
    );
    try {
      if (!persisted || persisted.authorizationId !== approval.authorizationId) {
        throw new Error("sealed live-execution authorization disappeared after issuance");
      }
      assertExactLiveExecutionAuthorizationBinding(
        persisted,
        context,
        exactLiveExecutionAction(context),
      );
      await assertExactSealedLiveExecutionMemberClaim(
        input.store,
        input.rootDir,
        persisted,
        input.taskId,
      );
      return redactLiveExecutionAuthorization(persisted);
    } catch (error) {
      throw new PermanentError(
        `CCC campaign ${context.campaignId} is awaiting exact human live-execution authorization ${approval.authorizationId}`,
        CCC_CAMPAIGN_LIVE_EXECUTION_APPROVAL_REQUIRED_CODE,
        undefined,
        error instanceof Error ? error : undefined,
      );
    }
  }
  if (isSealedLiveExecutionAuthorization(approval)) {
    throw new PermanentError(
      `CCC campaign ${context.campaignId} has mismatched legacy live-execution approval custody`,
      CCC_CAMPAIGN_LIVE_EXECUTION_APPROVAL_REQUIRED_CODE,
    );
  }
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
