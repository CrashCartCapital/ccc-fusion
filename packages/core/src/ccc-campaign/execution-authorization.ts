import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { and, eq, sql } from "drizzle-orm";
import {
  cccCampaignExecutionAuthorizationChildClaimToken,
  claimCccCampaignApprovalWithinTransaction,
  closeUnopenedCccCampaignApprovalWithinTransaction,
  issueCccCampaignApprovalWithinTransaction,
} from "../async-approval-request-store.js";
import { canonicalCccPrdJson } from "../ccc-prd/contract.js";
import type { CccCampaignAuthorityStore } from "./store.js";
import type { AsyncDataLayer, DbTransaction } from "../postgres/data-layer.js";
import * as schema from "../postgres/schema/index.js";
import type { ApprovalRequestActorSnapshot } from "../types.js";
import { createCccCampaignAuthorityBinding } from "./canonical.js";
import { listCccProviderAttemptsForCampaign } from "./provider-attempt.js";
import type {
  CccCampaignActionLookup,
  CccCampaignTaskContext,
  CccCampaignTransport,
} from "./types.js";

export const CCC_CAMPAIGN_EXECUTION_AUTHORIZATION_SCHEMA_VERSION =
  "ccc-campaign.execution-authorization.v1" as const;
export const CCC_CAMPAIGN_EXECUTION_AUTHORIZATION_MEMBER_SCHEMA_VERSION =
  "ccc-campaign.execution-authorization-member.v1" as const;
export const CCC_CAMPAIGN_EXECUTION_AUTHORIZATION_MEMBER_SET_SCHEMA_VERSION =
  "ccc-campaign.execution-authorization-member-set.v1" as const;

const LOWERCASE_SHA256 = /^[a-f0-9]{64}$/u;
const GIT_OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

export type CccCampaignExecutionAuthorizationMemberIdentityInput = Readonly<{
  ordinal: number;
  nativeTaskId: string;
  semanticTaskId: string;
  actionId: string;
  actionTarget: string;
  providerId: string;
  modelId: string;
  transport: CccCampaignTransport;
  promptSchema: "ccc-prd.execution-prompt.v1";
  promptSha256: string;
  routeSha256: string;
  bindingHash: string;
}>;

export type CccCampaignExecutionAuthorizationMember = Readonly<
  CccCampaignExecutionAuthorizationMemberIdentityInput & {
    approvalRequestId: string;
    memberHash: string;
  }
>;

export type CccCampaignExecutionAuthorizationIdentityInput = Readonly<{
  projectId: string;
  importId: string;
  campaignId: string;
  idempotencyKey: string;
  workflowId: string;
  workItemId: string;
  workflowIrHash: string;
  packetHash: string;
  sidecarHash: string;
  bundleHash: string;
  manifestHash: string;
  executionPolicySha256: string;
  targetRepository: string;
  targetBase: string;
  campaignStartedAt: string;
  campaignDeadlineAt: string;
  maxRequests: number;
  maxConcurrency: number;
  members: readonly CccCampaignExecutionAuthorizationMemberIdentityInput[];
}>;

export type CccCampaignExecutionAuthorizationIdentity = Readonly<{
  authorizationId: string;
  authorizationDigest: string;
  memberSetHash: string;
  members: readonly CccCampaignExecutionAuthorizationMember[];
}>;

export type CccCampaignExecutionAuthorizationStatus = "issued" | "claimed" | "settled";

export type CccCampaignExecutionAuthorization = Readonly<
  Omit<CccCampaignExecutionAuthorizationIdentityInput, "members">
  & CccCampaignExecutionAuthorizationIdentity
  & {
    schemaVersion: typeof CCC_CAMPAIGN_EXECUTION_AUTHORIZATION_SCHEMA_VERSION;
    expectedRequestCount: number;
    status: CccCampaignExecutionAuthorizationStatus;
    requester: ApprovalRequestActorSnapshot;
    notBeforeAt: string;
    expiresAt: string;
    claimToken?: string;
    claimedAt?: string;
    settledAt?: string;
    createdAt: string;
    updatedAt: string;
  }
>;

type CccCampaignExecutionAuthorizationBaseInput = Readonly<{
  authorityStore: CccCampaignAuthorityStore;
  rootDir: string;
}>;

export type IssueCccCampaignExecutionAuthorizationInput =
  CccCampaignExecutionAuthorizationBaseInput & Readonly<{
    taskId: string;
    requester: ApprovalRequestActorSnapshot;
    notBeforeAt: string;
    expiresAt: string;
  }>;

export type ClaimCccCampaignExecutionAuthorizationInput =
  CccCampaignExecutionAuthorizationBaseInput & Readonly<{
    authorizationId: string;
    claimant: ApprovalRequestActorSnapshot;
    claimToken: string;
  }>;

export type CloseUnopenedCccCampaignExecutionAuthorizationInput =
  CccCampaignExecutionAuthorizationBaseInput & Readonly<{
    authorizationId: string;
    actor: ApprovalRequestActorSnapshot;
    runId: string;
  }>;

export type CloseUnopenedCccCampaignExecutionAuthorizationResult = Readonly<{
  authorization: CccCampaignExecutionAuthorization;
  closedApprovalRequestIds: readonly string[];
  openedApprovalRequestIds: readonly string[];
}>;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalText(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new TypeError(`CCC execution authorization ${label} must be a non-empty canonical string`);
  }
  return value;
}

function canonicalSha256(value: string, label: string): string {
  if (!LOWERCASE_SHA256.test(value)) {
    throw new TypeError(`CCC execution authorization ${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function canonicalTimestamp(value: string, label: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new TypeError(`CCC execution authorization ${label} must be a canonical ISO timestamp`);
  }
  return value;
}

function canonicalPositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`CCC execution authorization ${label} must be a positive safe integer`);
  }
  return value;
}

function duplicate(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

function canonicalMember(
  input: CccCampaignExecutionAuthorizationMemberIdentityInput,
): CccCampaignExecutionAuthorizationMember {
  if (!Number.isSafeInteger(input.ordinal) || input.ordinal < 0) {
    throw new TypeError("CCC execution authorization member ordinal must be a non-negative safe integer");
  }
  if (!(["pi", "cli", "workflow"] as const).includes(input.transport)) {
    throw new TypeError("CCC execution authorization member transport is invalid");
  }
  if (input.promptSchema !== "ccc-prd.execution-prompt.v1") {
    throw new TypeError("CCC execution authorization member prompt schema is invalid");
  }
  const canonical = {
    ordinal: input.ordinal,
    nativeTaskId: canonicalText(input.nativeTaskId, "member native task ID"),
    semanticTaskId: canonicalText(input.semanticTaskId, "member semantic task ID"),
    actionId: canonicalText(input.actionId, "member action ID"),
    actionTarget: canonicalText(input.actionTarget, "member action target"),
    providerId: canonicalText(input.providerId, "member provider ID"),
    modelId: canonicalText(input.modelId, "member model ID"),
    transport: input.transport,
    promptSchema: input.promptSchema,
    promptSha256: canonicalSha256(input.promptSha256, "member prompt digest"),
    routeSha256: canonicalSha256(input.routeSha256, "member route digest"),
    bindingHash: canonicalSha256(input.bindingHash, "member binding hash"),
  } as const;
  const memberHash = sha256(canonicalCccPrdJson({
    schema: CCC_CAMPAIGN_EXECUTION_AUTHORIZATION_MEMBER_SCHEMA_VERSION,
    ...canonical,
  }));
  return {
    ...canonical,
    approvalRequestId: `ccc-approval-${canonical.bindingHash}`,
    memberHash,
  };
}

/**
 * Build the immutable parent identity from a closed, persisted member list.
 * Expected request count and all lifecycle fields intentionally live outside
 * this digest; they are first-claim preconditions, not campaign identity.
 */
export function createCccCampaignExecutionAuthorizationIdentity(
  input: CccCampaignExecutionAuthorizationIdentityInput,
): CccCampaignExecutionAuthorizationIdentity {
  const members = input.members
    .map(canonicalMember)
    .sort((left, right) => left.ordinal - right.ordinal);
  if (members.length === 0) {
    throw new TypeError("CCC execution authorization requires at least one sealed member");
  }
  if (members.some((member, index) => member.ordinal !== index)) {
    throw new TypeError("CCC execution authorization member ordinals must be unique and contiguous from zero");
  }
  if (
    duplicate(members.map(({ nativeTaskId }) => nativeTaskId))
    || duplicate(members.map(({ semanticTaskId }) => semanticTaskId))
    || duplicate(members.map(({ bindingHash }) => bindingHash))
    || duplicate(members.map(({ approvalRequestId }) => approvalRequestId))
    || duplicate(members.map(({ nativeTaskId, actionId }) => `${nativeTaskId}\0${actionId}`))
  ) {
    throw new TypeError("CCC execution authorization member set is incomplete or ambiguous");
  }
  const campaignStartedAt = canonicalTimestamp(input.campaignStartedAt, "campaign start");
  const campaignDeadlineAt = canonicalTimestamp(input.campaignDeadlineAt, "campaign deadline");
  if (Date.parse(campaignStartedAt) >= Date.parse(campaignDeadlineAt)) {
    throw new TypeError("CCC execution authorization campaign window must be positive");
  }
  if (!GIT_OBJECT_ID.test(input.targetBase)) {
    throw new TypeError("CCC execution authorization target base must be a Git object ID");
  }
  const memberSetHash = sha256(canonicalCccPrdJson({
    schema: CCC_CAMPAIGN_EXECUTION_AUTHORIZATION_MEMBER_SET_SCHEMA_VERSION,
    members: members.map(({ ordinal, memberHash }) => ({ ordinal, memberHash })),
  }));
  const authorizationDigest = sha256(canonicalCccPrdJson({
    schema: CCC_CAMPAIGN_EXECUTION_AUTHORIZATION_SCHEMA_VERSION,
    projectId: canonicalText(input.projectId, "project ID"),
    importId: canonicalText(input.importId, "import ID"),
    campaignId: canonicalText(input.campaignId, "campaign ID"),
    idempotencyKey: canonicalText(input.idempotencyKey, "idempotency key"),
    workflowId: canonicalText(input.workflowId, "workflow ID"),
    workItemId: canonicalText(input.workItemId, "work-item ID"),
    workflowIrHash: canonicalSha256(input.workflowIrHash, "workflow IR hash"),
    packetHash: canonicalSha256(input.packetHash, "packet hash"),
    sidecarHash: canonicalSha256(input.sidecarHash, "sidecar hash"),
    bundleHash: canonicalSha256(input.bundleHash, "bundle hash"),
    manifestHash: canonicalSha256(input.manifestHash, "manifest hash"),
    executionPolicySha256: canonicalSha256(
      input.executionPolicySha256,
      "execution-policy hash",
    ),
    targetRepository: canonicalText(input.targetRepository, "target repository"),
    targetBase: input.targetBase,
    campaignStartedAt,
    campaignDeadlineAt,
    maxRequests: canonicalPositiveInteger(input.maxRequests, "maxRequests"),
    maxConcurrency: canonicalPositiveInteger(input.maxConcurrency, "maxConcurrency"),
    memberSetHash,
  }));
  return {
    authorizationId: `ccc-execution-authorization-${authorizationDigest}`,
    authorizationDigest,
    memberSetHash,
    members,
  };
}

type ExecutionAuthorizationParentRow = typeof schema.project.cccCampaignExecutionAuthorizations.$inferSelect;
type ExecutionAuthorizationMemberRow = typeof schema.project.cccCampaignExecutionAuthorizationMembers.$inferSelect;
type ExecutionAuthorizationQuery = AsyncDataLayer["db"] | DbTransaction;

function requiredLiveExecutionAction(context: CccCampaignTaskContext): CccCampaignActionLookup {
  const assigned = new Set(context.protectedActionIds);
  const actions = context.protectedActions.filter((action) =>
    assigned.has(action.id)
    && action.kind === "live_execution"
    && action.operatorDecision === "approve_live_execution");
  if (actions.length !== 1) {
    throw new Error(
      `CCC sealed execution authorization task ${context.taskId} requires exactly one live-execution action`,
    );
  }
  return {
    actionId: actions[0]!.id,
    actionTarget: actions[0]!.target,
    requireProtected: true,
  };
}

async function assertRootMatchesContext(
  rootDir: string,
  context: CccCampaignTaskContext,
): Promise<void> {
  const canonicalRoot = await realpath(rootDir).catch(() => null);
  if (canonicalRoot !== context.targetRepository.path) {
    throw new Error("CCC sealed execution authorization root does not match campaign target");
  }
}

function memberIdentity(
  context: CccCampaignTaskContext,
  action: CccCampaignActionLookup,
  ordinal: number,
): CccCampaignExecutionAuthorizationMemberIdentityInput {
  if (!context.executionCustody) {
    throw new Error(`CCC sealed execution authorization task ${context.taskId} has no prompt custody`);
  }
  const binding = createCccCampaignAuthorityBinding(context, action);
  return {
    ordinal,
    nativeTaskId: context.taskId,
    semanticTaskId: context.semanticTaskId,
    actionId: binding.actionId,
    actionTarget: binding.actionTarget,
    providerId: binding.providerId,
    modelId: binding.modelId,
    transport: binding.transport,
    promptSchema: context.executionCustody.promptSchema,
    promptSha256: context.executionCustody.promptSha256,
    routeSha256: context.executionCustody.routeSha256,
    bindingHash: binding.bindingHash,
  };
}

async function deriveExecutionAuthorization(
  tx: DbTransaction,
  authorityStore: CccCampaignAuthorityStore,
  rootDir: string,
  locatorTaskId: string,
): Promise<{
  context: CccCampaignTaskContext;
  identityInput: CccCampaignExecutionAuthorizationIdentityInput;
  identity: CccCampaignExecutionAuthorizationIdentity;
  actionsByTaskId: ReadonlyMap<string, CccCampaignActionLookup>;
}> {
  const context = await authorityStore.getCccCampaignContextForTaskWithinTransaction(
    tx,
    canonicalText(locatorTaskId, "locator task ID"),
  );
  if (!context) {
    throw new Error(`CCC sealed execution authorization task ${locatorTaskId} has no campaign custody`);
  }
  await assertRootMatchesContext(rootDir, context);
  if (
    context.executionAuthorizationMode !== "sealed_bundle_v1"
    || context.executionPolicy.schema !== "ccc-campaign.execution-policy.v2"
  ) {
    throw new Error("CCC sealed execution authorization requires manifest-v2 sealed-bundle custody");
  }
  const entityRows = await tx
    .select({
      semanticTaskId: schema.project.cccPrdImportEntities.entityId,
      nativeTaskId: schema.project.cccPrdImportEntities.nativeId,
      ordinal: schema.project.cccPrdImportEntities.ordinal,
    })
    .from(schema.project.cccPrdImportEntities)
    .where(and(
      eq(schema.project.cccPrdImportEntities.projectId, context.projectId),
      eq(schema.project.cccPrdImportEntities.importId, context.importId),
      eq(schema.project.cccPrdImportEntities.entityType, "task"),
    ))
    .orderBy(schema.project.cccPrdImportEntities.ordinal);
  const providerRoutes = context.executionPolicy.routes.filter((route) =>
    route.transport === "pi" || route.transport === "cli");
  const providerTaskIds = providerRoutes.map(({ taskId }) => taskId);
  const providerTaskIdSet = new Set(providerTaskIds);
  if (
    entityRows.length !== providerRoutes.length
    || providerTaskIdSet.size !== providerTaskIds.length
    || entityRows.some((entity, index) =>
      entity.ordinal !== index || !providerTaskIdSet.has(entity.semanticTaskId))
  ) {
    throw new Error("CCC sealed execution authorization has incomplete or reordered task custody");
  }
  const actionsByTaskId = new Map<string, CccCampaignActionLookup>();
  const memberInputs: CccCampaignExecutionAuthorizationMemberIdentityInput[] = [];
  for (const [ordinal, entity] of entityRows.entries()) {
    const memberContext = entity.nativeTaskId === context.taskId
      ? context
      : await authorityStore.getCccCampaignContextForTaskWithinTransaction(tx, entity.nativeTaskId);
    if (
      !memberContext
      || memberContext.importId !== context.importId
      || memberContext.manifestHash !== context.manifestHash
      || memberContext.semanticTaskId !== entity.semanticTaskId
      || memberContext.executionAuthorizationMode !== "sealed_bundle_v1"
    ) {
      throw new Error(`CCC sealed execution authorization member ${entity.nativeTaskId} drifted`);
    }
    const action = requiredLiveExecutionAction(memberContext);
    actionsByTaskId.set(entity.nativeTaskId, action);
    memberInputs.push(memberIdentity(memberContext, action, ordinal));
  }
  const ledgerRows = await tx
    .select({
      entityType: schema.project.cccPrdImportEntities.entityType,
      nativeId: schema.project.cccPrdImportEntities.nativeId,
    })
    .from(schema.project.cccPrdImportEntities)
    .where(and(
      eq(schema.project.cccPrdImportEntities.projectId, context.projectId),
      eq(schema.project.cccPrdImportEntities.importId, context.importId),
    ));
  const workflows = ledgerRows.filter(({ entityType }) => entityType === "workflow");
  const workItems = ledgerRows.filter(({ entityType }) => entityType === "work_item");
  if (workflows.length !== 1 || workItems.length !== 1) {
    throw new Error("CCC sealed execution authorization requires one imported workflow and work item");
  }
  const workItemRows = await tx
    .select({ irHash: schema.project.workflowWorkItems.irHash })
    .from(schema.project.workflowWorkItems)
    .where(and(
      eq(schema.project.workflowWorkItems.projectId, context.projectId),
      eq(schema.project.workflowWorkItems.id, workItems[0]!.nativeId),
    ))
    .limit(2)
    .for("update");
  if (workItemRows.length !== 1 || !workItemRows[0]!.irHash) {
    throw new Error("CCC sealed execution authorization work-item custody is missing");
  }
  const workflowRows = await tx
    .select({ ir: schema.project.workflows.ir })
    .from(schema.project.workflows)
    .where(eq(schema.project.workflows.id, workflows[0]!.nativeId))
    .limit(2)
    .for("update");
  if (
    workflowRows.length !== 1
    || sha256(canonicalCccPrdJson(workflowRows[0]!.ir)) !== workItemRows[0]!.irHash
  ) {
    throw new Error("CCC sealed execution authorization workflow IR drifted from its work-item hash");
  }
  const identityInput: CccCampaignExecutionAuthorizationIdentityInput = {
    projectId: context.projectId,
    importId: context.importId,
    campaignId: context.campaignId,
    idempotencyKey: context.idempotencyKey,
    workflowId: workflows[0]!.nativeId,
    workItemId: workItems[0]!.nativeId,
    workflowIrHash: workItemRows[0]!.irHash,
    packetHash: context.packetHash,
    sidecarHash: context.sidecarHash,
    bundleHash: context.bundleHash,
    manifestHash: context.manifestHash,
    executionPolicySha256: sha256(canonicalCccPrdJson(context.executionPolicy)),
    targetRepository: context.targetRepository.path,
    targetBase: context.targetRepository.baseCommit,
    campaignStartedAt: context.campaignStartedAt,
    campaignDeadlineAt: context.campaignDeadlineAt,
    maxRequests: context.bounds.maxRequests,
    maxConcurrency: context.bounds.maxConcurrency,
    members: memberInputs,
  };
  return {
    context,
    identityInput,
    identity: createCccCampaignExecutionAuthorizationIdentity(identityInput),
    actionsByTaskId,
  };
}

async function assertExecutionAuthorizationLaunchLedger(
  tx: DbTransaction,
  layer: AsyncDataLayer,
  rootDir: string,
  context: CccCampaignTaskContext,
): Promise<void> {
  const attempts = await listCccProviderAttemptsForCampaign({
    layer,
    rootDir,
    taskId: context.taskId,
    tx,
  });
  if (context.requestCount > context.bounds.maxRequests) {
    throw new Error(
      `CCC sealed execution authorization request count ${context.requestCount} exceeds its admitted maximum ${context.bounds.maxRequests}`,
    );
  }
  const unresolved = attempts.filter(({ state }) =>
    state === "reserved" || state === "dispatched_unknown");
  if (unresolved.length > 0) {
    throw new Error(
      `CCC sealed execution authorization refuses ${unresolved.length} unresolved provider attempt${unresolved.length === 1 ? "" : "s"} before launch claim`,
    );
  }
}

function executionAuthorizationFromRows(
  parent: ExecutionAuthorizationParentRow,
  memberRows: readonly ExecutionAuthorizationMemberRow[],
): CccCampaignExecutionAuthorization {
  const members = [...memberRows]
    .sort((left, right) => left.ordinal - right.ordinal)
    .map((row) => ({
      ordinal: row.ordinal,
      nativeTaskId: row.nativeTaskId,
      semanticTaskId: row.semanticTaskId,
      actionId: row.actionId,
      actionTarget: row.actionTarget,
      providerId: row.providerId,
      modelId: row.modelId,
      transport: row.transport as CccCampaignTransport,
      promptSchema: row.promptSchema as "ccc-prd.execution-prompt.v1",
      promptSha256: row.promptSha256,
      routeSha256: row.routeSha256,
      bindingHash: row.bindingHash,
      approvalRequestId: row.approvalRequestId,
      memberHash: row.memberHash,
    }));
  const value: CccCampaignExecutionAuthorization = {
    schemaVersion: CCC_CAMPAIGN_EXECUTION_AUTHORIZATION_SCHEMA_VERSION,
    authorizationId: parent.authorizationId,
    authorizationDigest: parent.authorizationDigest,
    memberSetHash: parent.memberSetHash,
    projectId: parent.projectId,
    importId: parent.importId,
    campaignId: parent.campaignId,
    idempotencyKey: parent.idempotencyKey,
    workflowId: parent.workflowId,
    workItemId: parent.workItemId,
    workflowIrHash: parent.workflowIrHash,
    packetHash: parent.packetHash,
    sidecarHash: parent.sidecarHash,
    bundleHash: parent.bundleHash,
    manifestHash: parent.manifestHash,
    executionPolicySha256: parent.executionPolicySha256,
    targetRepository: parent.targetRepository,
    targetBase: parent.targetBase,
    campaignStartedAt: parent.campaignStartedAt,
    campaignDeadlineAt: parent.campaignDeadlineAt,
    maxRequests: parent.maxRequests,
    maxConcurrency: parent.maxConcurrency,
    expectedRequestCount: parent.expectedRequestCount,
    status: parent.status as CccCampaignExecutionAuthorizationStatus,
    requester: {
      actorId: parent.requesterActorId,
      actorType: parent.requesterActorType as ApprovalRequestActorSnapshot["actorType"],
      actorName: parent.requesterActorName,
    },
    notBeforeAt: parent.notBeforeAt,
    expiresAt: parent.expiresAt,
    ...(parent.claimToken ? { claimToken: parent.claimToken } : {}),
    ...(parent.claimedAt ? { claimedAt: parent.claimedAt } : {}),
    ...(parent.settledAt ? { settledAt: parent.settledAt } : {}),
    createdAt: parent.createdAt,
    updatedAt: parent.updatedAt,
    members,
  };
  const identity = createCccCampaignExecutionAuthorizationIdentity(value);
  if (
    identity.authorizationId !== value.authorizationId
    || identity.authorizationDigest !== value.authorizationDigest
    || identity.memberSetHash !== value.memberSetHash
    || canonicalCccPrdJson(identity.members) !== canonicalCccPrdJson(value.members)
  ) {
    throw new Error(`CCC sealed execution authorization ${parent.authorizationId} custody drifted`);
  }
  return value;
}

async function getAuthorizationWithinTransaction(
  tx: DbTransaction,
  authorizationId: string,
  lock = false,
): Promise<CccCampaignExecutionAuthorization | null> {
  const selection = tx
    .select()
    .from(schema.project.cccCampaignExecutionAuthorizations)
    .where(eq(schema.project.cccCampaignExecutionAuthorizations.authorizationId, authorizationId))
    .limit(2);
  const parents = lock ? await selection.for("update") : await selection;
  if (parents.length > 1) throw new Error(`CCC sealed execution authorization ${authorizationId} is ambiguous`);
  if (!parents[0]) return null;
  const members = await tx
    .select()
    .from(schema.project.cccCampaignExecutionAuthorizationMembers)
    .where(and(
      eq(schema.project.cccCampaignExecutionAuthorizationMembers.projectId, parents[0].projectId),
      eq(schema.project.cccCampaignExecutionAuthorizationMembers.authorizationId, authorizationId),
    ))
    .orderBy(schema.project.cccCampaignExecutionAuthorizationMembers.ordinal);
  return executionAuthorizationFromRows(parents[0], members);
}

/**
 * Mutation lock order starts with the import, then the parent. Reading the
 * immutable parent locator without a row lock is safe because the foreign key
 * prevents the import identity from disappearing; the parent is re-read and
 * fully validated only after the import lock is held.
 */
async function lockExecutionAuthorizationImportBeforeParent(
  tx: DbTransaction,
  authorizationId: string,
): Promise<void> {
  const locators = await tx
    .select({
      projectId: schema.project.cccCampaignExecutionAuthorizations.projectId,
      importId: schema.project.cccCampaignExecutionAuthorizations.importId,
    })
    .from(schema.project.cccCampaignExecutionAuthorizations)
    .where(eq(
      schema.project.cccCampaignExecutionAuthorizations.authorizationId,
      authorizationId,
    ))
    .limit(2);
  if (locators.length !== 1) {
    throw new Error(`CCC sealed execution authorization ${authorizationId} is missing or ambiguous`);
  }
  const imports = await tx
    .select({ importId: schema.project.cccPrdImports.importId })
    .from(schema.project.cccPrdImports)
    .where(and(
      eq(schema.project.cccPrdImports.projectId, locators[0]!.projectId),
      eq(schema.project.cccPrdImports.importId, locators[0]!.importId),
    ))
    .limit(2)
    .for("update");
  if (imports.length !== 1) {
    throw new Error(`CCC sealed execution authorization ${authorizationId} has no exact import custody`);
  }
}

export async function getCccCampaignExecutionAuthorization(
  db: ExecutionAuthorizationQuery,
  authorizationId: string,
): Promise<CccCampaignExecutionAuthorization | null> {
  const canonicalId = canonicalText(authorizationId, "authorization ID");
  const parents = await db
    .select()
    .from(schema.project.cccCampaignExecutionAuthorizations)
    .where(eq(schema.project.cccCampaignExecutionAuthorizations.authorizationId, canonicalId))
    .limit(2);
  if (parents.length > 1) throw new Error(`CCC sealed execution authorization ${canonicalId} is ambiguous`);
  if (!parents[0]) return null;
  const members = await db
    .select()
    .from(schema.project.cccCampaignExecutionAuthorizationMembers)
    .where(and(
      eq(schema.project.cccCampaignExecutionAuthorizationMembers.projectId, parents[0].projectId),
      eq(schema.project.cccCampaignExecutionAuthorizationMembers.authorizationId, canonicalId),
    ))
    .orderBy(schema.project.cccCampaignExecutionAuthorizationMembers.ordinal);
  return executionAuthorizationFromRows(parents[0], members);
}

export async function getCccCampaignExecutionAuthorizationForImport(
  db: ExecutionAuthorizationQuery,
  importId: string,
): Promise<CccCampaignExecutionAuthorization | null> {
  const canonicalImportId = canonicalText(importId, "import ID");
  const parents = await db
    .select()
    .from(schema.project.cccCampaignExecutionAuthorizations)
    .where(eq(schema.project.cccCampaignExecutionAuthorizations.importId, canonicalImportId))
    .limit(2);
  if (parents.length > 1) {
    throw new Error(`CCC sealed execution authorization for import ${canonicalImportId} is ambiguous`);
  }
  if (!parents[0]) return null;
  const members = await db
    .select()
    .from(schema.project.cccCampaignExecutionAuthorizationMembers)
    .where(and(
      eq(schema.project.cccCampaignExecutionAuthorizationMembers.projectId, parents[0].projectId),
      eq(
        schema.project.cccCampaignExecutionAuthorizationMembers.authorizationId,
        parents[0].authorizationId,
      ),
    ))
    .orderBy(schema.project.cccCampaignExecutionAuthorizationMembers.ordinal);
  return executionAuthorizationFromRows(parents[0], members);
}

export async function issueCccCampaignExecutionAuthorization(
  layer: AsyncDataLayer,
  input: IssueCccCampaignExecutionAuthorizationInput,
): Promise<CccCampaignExecutionAuthorization> {
  return layer.transactionImmediate(async (tx) => {
    const derived = await deriveExecutionAuthorization(
      tx,
      input.authorityStore,
      input.rootDir,
      input.taskId,
    );
    assertCampaignWindowForAuthorization(
      derived.context,
      input.notBeforeAt,
      input.expiresAt,
    );
    const existingParent = await getAuthorizationWithinTransaction(
      tx,
      derived.identity.authorizationId,
      true,
    );
    if (!existingParent || existingParent.status === "issued") {
      await assertExecutionAuthorizationLaunchLedger(
        tx,
        layer,
        input.rootDir,
        derived.context,
      );
    }
    const stableRunId = `ccc-execution-authorization:${derived.identity.authorizationId}`;
    for (const member of derived.identity.members) {
      const action = derived.actionsByTaskId.get(member.nativeTaskId);
      if (!action) throw new Error(`CCC sealed execution authorization member ${member.nativeTaskId} lost its action`);
      await issueCccCampaignApprovalWithinTransaction(tx, {
        authorityStore: input.authorityStore,
        rootDir: input.rootDir,
        taskId: member.nativeTaskId,
        action,
        requester: input.requester,
        runId: stableRunId,
        notBeforeAt: input.notBeforeAt,
        expiresAt: input.expiresAt,
      });
    }
    const now = await databaseNow(tx);
    const inserted = await tx.insert(schema.project.cccCampaignExecutionAuthorizations).values({
      projectId: derived.identityInput.projectId,
      authorizationId: derived.identity.authorizationId,
      schemaVersion: CCC_CAMPAIGN_EXECUTION_AUTHORIZATION_SCHEMA_VERSION,
      importId: derived.identityInput.importId,
      campaignId: derived.identityInput.campaignId,
      idempotencyKey: derived.identityInput.idempotencyKey,
      workflowId: derived.identityInput.workflowId,
      workItemId: derived.identityInput.workItemId,
      workflowIrHash: derived.identityInput.workflowIrHash,
      packetHash: derived.identityInput.packetHash,
      sidecarHash: derived.identityInput.sidecarHash,
      bundleHash: derived.identityInput.bundleHash,
      manifestHash: derived.identityInput.manifestHash,
      executionPolicySha256: derived.identityInput.executionPolicySha256,
      targetRepository: derived.identityInput.targetRepository,
      targetBase: derived.identityInput.targetBase,
      campaignStartedAt: derived.identityInput.campaignStartedAt,
      campaignDeadlineAt: derived.identityInput.campaignDeadlineAt,
      maxRequests: derived.identityInput.maxRequests,
      maxConcurrency: derived.identityInput.maxConcurrency,
      memberSetHash: derived.identity.memberSetHash,
      authorizationDigest: derived.identity.authorizationDigest,
      expectedRequestCount: derived.context.requestCount,
      status: "issued",
      requesterActorId: input.requester.actorId,
      requesterActorType: input.requester.actorType,
      requesterActorName: input.requester.actorName,
      notBeforeAt: input.notBeforeAt,
      expiresAt: input.expiresAt,
      claimToken: null,
      claimedAt: null,
      settledAt: null,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoNothing().returning();
    if (inserted.length === 1) {
      await tx.insert(schema.project.cccCampaignExecutionAuthorizationMembers).values(
        derived.identity.members.map((member) => ({
          projectId: derived.identityInput.projectId,
          authorizationId: derived.identity.authorizationId,
          ...member,
        })),
      );
    }
    const persisted = await getAuthorizationWithinTransaction(
      tx,
      derived.identity.authorizationId,
      true,
    );
    if (!persisted || !equivalentIssuedAuthorization(persisted, derived, input)) {
      throw new Error(`CCC sealed execution authorization ${derived.identity.authorizationId} collision or drift`);
    }
    return persisted;
  });
}

export async function claimCccCampaignExecutionAuthorization(
  layer: AsyncDataLayer,
  input: ClaimCccCampaignExecutionAuthorizationInput,
): Promise<CccCampaignExecutionAuthorization> {
  const claimToken = canonicalText(input.claimToken, "claim token");
  return layer.transactionImmediate(async (tx) => {
    const authorizationId = canonicalText(input.authorizationId, "authorization ID");
    await lockExecutionAuthorizationImportBeforeParent(tx, authorizationId);
    const parent = await getAuthorizationWithinTransaction(
      tx,
      authorizationId,
      true,
    );
    if (!parent) throw new Error(`CCC sealed execution authorization ${input.authorizationId} is missing`);
    const derived = await deriveExecutionAuthorization(
      tx,
      input.authorityStore,
      input.rootDir,
      parent.members[0]!.nativeTaskId,
    );
    if (!matchesDerivedIdentity(parent, derived)) {
      throw new Error(`CCC sealed execution authorization ${parent.authorizationId} member custody drifted`);
    }
    if (parent.status === "claimed" && parent.claimToken === claimToken) {
      await assertAllChildLeases(input.authorityStore, tx, parent, claimToken);
      return parent;
    }
    if (parent.status !== "issued") {
      throw new Error(`CCC sealed execution authorization ${parent.authorizationId} is not issued for claim`);
    }
    if (parent.expectedRequestCount !== derived.context.requestCount) {
      throw new Error(`CCC sealed execution authorization ${parent.authorizationId} request-count compare-and-swap lost`);
    }
    await assertExecutionAuthorizationLaunchLedger(
      tx,
      layer,
      input.rootDir,
      derived.context,
    );
    const now = await databaseNow(tx);
    if (Date.parse(parent.notBeforeAt) > Date.parse(now) || Date.parse(parent.expiresAt) <= Date.parse(now)) {
      throw new Error(`CCC sealed execution authorization ${parent.authorizationId} is outside its window`);
    }
    const updated = await tx.update(schema.project.cccCampaignExecutionAuthorizations).set({
      status: "claimed",
      claimToken,
      claimedAt: now,
      updatedAt: now,
    }).where(and(
      eq(schema.project.cccCampaignExecutionAuthorizations.projectId, parent.projectId),
      eq(schema.project.cccCampaignExecutionAuthorizations.authorizationId, parent.authorizationId),
      eq(schema.project.cccCampaignExecutionAuthorizations.status, "issued"),
      eq(schema.project.cccCampaignExecutionAuthorizations.expectedRequestCount, derived.context.requestCount),
      sql`${schema.project.cccCampaignExecutionAuthorizations.notBeforeAt}::timestamptz <= clock_timestamp()`,
      sql`${schema.project.cccCampaignExecutionAuthorizations.expiresAt}::timestamptz > clock_timestamp()`,
    )).returning();
    if (updated.length !== 1) {
      throw new Error(`CCC sealed execution authorization ${parent.authorizationId} claim compare-and-swap lost`);
    }
    const stableRunId = `ccc-execution-authorization:${parent.authorizationId}`;
    for (const member of [...parent.members].sort((left, right) =>
      left.bindingHash.localeCompare(right.bindingHash))) {
      const action = derived.actionsByTaskId.get(member.nativeTaskId);
      if (!action) throw new Error(`CCC sealed execution authorization member ${member.nativeTaskId} lost its action`);
      await claimCccCampaignApprovalWithinTransaction(tx, {
        authorityStore: input.authorityStore,
        rootDir: input.rootDir,
        taskId: member.nativeTaskId,
        action,
        claimant: input.claimant,
        runId: stableRunId,
        claimToken: cccCampaignExecutionAuthorizationChildClaimToken(
          claimToken,
          member.bindingHash,
        ),
      });
    }
    const claimed = await getAuthorizationWithinTransaction(tx, parent.authorizationId, true);
    if (!claimed) throw new Error(`CCC sealed execution authorization ${parent.authorizationId} disappeared`);
    await assertAllChildLeases(input.authorityStore, tx, claimed, claimToken);
    return claimed;
  });
}

export async function closeUnopenedCccCampaignExecutionAuthorizationMembers(
  layer: AsyncDataLayer,
  input: CloseUnopenedCccCampaignExecutionAuthorizationInput,
): Promise<CloseUnopenedCccCampaignExecutionAuthorizationResult> {
  return layer.transactionImmediate(async (tx) => {
    const authorizationId = canonicalText(input.authorizationId, "authorization ID");
    await lockExecutionAuthorizationImportBeforeParent(tx, authorizationId);
    const parent = await getAuthorizationWithinTransaction(tx, authorizationId, true);
    if (!parent) throw new Error(`CCC sealed execution authorization ${authorizationId} is missing`);
    if (parent.status === "settled") {
      return {
        authorization: parent,
        closedApprovalRequestIds: [],
        openedApprovalRequestIds: [],
      };
    }
    if (parent.status !== "claimed") {
      throw new Error(`CCC sealed execution authorization ${authorizationId} is not claimed for unopened closure`);
    }
    const derived = await deriveExecutionAuthorization(
      tx,
      input.authorityStore,
      input.rootDir,
      parent.members[0]!.nativeTaskId,
    );
    if (!matchesDerivedIdentity(parent, derived)) {
      throw new Error(`CCC sealed execution authorization ${authorizationId} member custody drifted`);
    }
    const closedApprovalRequestIds: string[] = [];
    const openedApprovalRequestIds: string[] = [];
    for (const member of [...parent.members].sort((left, right) =>
      left.bindingHash.localeCompare(right.bindingHash))) {
      const childRows = await tx
        .select({ status: schema.project.approvalRequests.status })
        .from(schema.project.approvalRequests)
        .where(and(
          eq(schema.project.approvalRequests.projectId, parent.projectId),
          eq(schema.project.approvalRequests.id, member.approvalRequestId),
        ))
        .limit(2);
      if (childRows.length !== 1) {
        throw new Error(`CCC sealed execution authorization child ${member.approvalRequestId} is missing or ambiguous`);
      }
      if (childRows[0]!.status === "consumed" || childRows[0]!.status === "expired") continue;
      if (childRows[0]!.status !== "claimed") {
        throw new Error(`CCC sealed execution authorization child ${member.approvalRequestId} is not claimed`);
      }
      const action = derived.actionsByTaskId.get(member.nativeTaskId);
      if (!action) throw new Error(`CCC sealed execution authorization member ${member.nativeTaskId} lost its action`);
      const result = await closeUnopenedCccCampaignApprovalWithinTransaction(tx, {
        authorityStore: input.authorityStore,
        rootDir: input.rootDir,
        taskId: member.nativeTaskId,
        action,
        approvalRequestId: member.approvalRequestId,
        actor: input.actor,
        runId: input.runId,
      });
      if (result.outcome === "closed-no-effect") {
        closedApprovalRequestIds.push(member.approvalRequestId);
      } else {
        openedApprovalRequestIds.push(member.approvalRequestId);
      }
    }
    const authorization = await getAuthorizationWithinTransaction(tx, authorizationId, true);
    if (!authorization) throw new Error(`CCC sealed execution authorization ${authorizationId} disappeared`);
    return { authorization, closedApprovalRequestIds, openedApprovalRequestIds };
  });
}

function assertCampaignWindowForAuthorization(
  context: CccCampaignTaskContext,
  notBeforeAt: string,
  expiresAt: string,
): void {
  const notBefore = Date.parse(canonicalTimestamp(notBeforeAt, "not-before"));
  const expiry = Date.parse(canonicalTimestamp(expiresAt, "expiry"));
  if (
    notBefore !== Date.parse(context.campaignStartedAt)
    || expiry !== Date.parse(context.campaignDeadlineAt)
  ) {
    throw new Error("CCC sealed execution authorization window must exactly match campaign custody");
  }
}

async function databaseNow(tx: DbTransaction): Promise<string> {
  const rows = await tx.execute(sql`
    SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now
  `) as unknown as Array<{ now: string }>;
  return canonicalTimestamp(rows[0]?.now ?? "", "database clock");
}

function equivalentIssuedAuthorization(
  persisted: CccCampaignExecutionAuthorization,
  derived: Awaited<ReturnType<typeof deriveExecutionAuthorization>>,
  input: IssueCccCampaignExecutionAuthorizationInput,
): boolean {
  return matchesDerivedIdentity(persisted, derived)
    && (
      persisted.status !== "issued"
      || persisted.expectedRequestCount === derived.context.requestCount
    )
    && canonicalCccPrdJson(persisted.requester) === canonicalCccPrdJson(input.requester)
    && persisted.notBeforeAt === input.notBeforeAt
    && persisted.expiresAt === input.expiresAt;
}

function matchesDerivedIdentity(
  persisted: CccCampaignExecutionAuthorization,
  derived: Awaited<ReturnType<typeof deriveExecutionAuthorization>>,
): boolean {
  return persisted.authorizationId === derived.identity.authorizationId
    && persisted.authorizationDigest === derived.identity.authorizationDigest
    && persisted.memberSetHash === derived.identity.memberSetHash
    && canonicalCccPrdJson(persisted.members) === canonicalCccPrdJson(derived.identity.members);
}

async function assertAllChildLeases(
  authorityStore: CccCampaignAuthorityStore,
  tx: DbTransaction,
  parent: CccCampaignExecutionAuthorization,
  parentClaimToken: string,
): Promise<void> {
  for (const member of parent.members) {
    const lease = await authorityStore.inspectCccCampaignActionLease(
      member.nativeTaskId,
      { actionId: member.actionId, actionTarget: member.actionTarget },
      tx,
    );
    if (
      !lease
      || lease.binding.bindingHash !== member.bindingHash
      || lease.lease.bindingHash !== member.bindingHash
      || lease.lease.approvalRequestId !== member.approvalRequestId
      || lease.lease.claimToken !== cccCampaignExecutionAuthorizationChildClaimToken(
        parentClaimToken,
        member.bindingHash,
      )
    ) {
      throw new Error(`CCC sealed execution authorization member ${member.nativeTaskId} has no exact child lease`);
    }
  }
}
