import {
  assertActiveClaimedCccCampaignApprovalWithinTransaction,
  assertClaimedCccCampaignApprovalWithinTransaction,
  assertConsumedCccCampaignApprovalForFollowOnDispatchWithinTransaction,
  assertConsumedCccCampaignApprovalWithinTransaction,
  type AssertActiveClaimedCccCampaignApprovalInput,
} from "../async-approval-request-store.js";
import type { AsyncDataLayer } from "../postgres/data-layer.js";
import { and, eq, sql } from "drizzle-orm";
import * as schema from "../postgres/schema/index.js";
import { beginCccProviderAttemptDispatch, listCccProviderAttemptsForCampaign, reserveCccProviderAttempt } from "./provider-attempt.js";
import { loadCccCampaignContextForTask, type CccCampaignAuthorityStore } from "./store.js";
import type { CccPrdProtectedActionIntent } from "../ccc-prd/types.js";
import type {
  CccCampaignTransport,
  CccCampaignWorkItemFence,
  CccProviderAttemptDispatchDecision,
  CccProviderAttemptScope,
} from "./types.js";

export type CccCampaignProviderControllerHoldReason = "dispatched-unknown" | "terminal";

export type CccCampaignProviderControllerDecision =
  | Readonly<{ kind: "dispatch-permit"; scope: CccProviderAttemptScope }>
  | Readonly<{ kind: "hold"; reason: CccCampaignProviderControllerHoldReason; scope: CccProviderAttemptScope }>;

export type CccCampaignProviderDispatchInput = Readonly<{
  turnKey: string;
  dispatchKey: string;
  providerId: string;
  modelId: string;
  transport: CccCampaignTransport;
}>;

export type AtomicCccCampaignProviderDispatchInput = Readonly<{
  layer: AsyncDataLayer;
  rootDir: string;
  authorityStore: CccCampaignAuthorityStore;
  gitObservation: Readonly<{ targetRoot: string; expectedBaseObject: string; head: string; headDescendsFromExpectedBase: true }>;
  /** Sealed graph task that owns the active workflow work item for this semantic task dispatch. */
  originTaskId: string;
  taskId: string;
  approvalRequestId: string;
  claimToken: string;
  workItemFence: CccCampaignWorkItemFence;
  workItemLeaseOwner: string;
}> & CccCampaignProviderDispatchInput;

export type CccCampaignLiveExecutionAction = Readonly<{
  actionId: string;
  actionTarget: string;
  requireProtected: true;
}>;

const CANONICAL_GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const CANONICAL_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;

function requireWorkItemFence(value: unknown): CccCampaignWorkItemFence {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("CCC campaign workflow work-item fence must be an object");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (JSON.stringify(keys) !== JSON.stringify(["attempt", "runId", "workItemId"])) {
    throw new Error("CCC campaign workflow work-item fence fields must be exactly attempt, runId, workItemId");
  }
  if (
    typeof record.workItemId !== "string"
    || !CANONICAL_IDENTIFIER.test(record.workItemId)
    || typeof record.runId !== "string"
    || !CANONICAL_IDENTIFIER.test(record.runId)
    || !Number.isSafeInteger(record.attempt)
    || (record.attempt as number) < 1
  ) {
    throw new Error("CCC campaign workflow work-item fence is invalid");
  }
  return Object.freeze({
    workItemId: record.workItemId,
    runId: record.runId,
    attempt: record.attempt as number,
  });
}

function requireWorkItemLeaseOwner(value: unknown): string {
  if (typeof value !== "string" || !CANONICAL_IDENTIFIER.test(value)) {
    throw new Error("CCC campaign workflow work-item lease owner is invalid");
  }
  return value;
}

function requireOriginTaskId(value: unknown): string {
  if (typeof value !== "string" || !CANONICAL_IDENTIFIER.test(value)) {
    throw new Error("CCC campaign workflow origin task ID is invalid");
  }
  return value;
}

export function selectCccCampaignDeclaredLiveExecutionAction(
  protectedActions: readonly CccPrdProtectedActionIntent[],
  protectedActionIds?: readonly string[],
): CccCampaignLiveExecutionAction {
  const assignedActionIds = protectedActionIds === undefined
    ? null
    : new Set(protectedActionIds);
  const actions = protectedActions.filter((candidate) =>
    (assignedActionIds === null || assignedActionIds.has(candidate.id))
    &&
    candidate.kind === "live_execution"
    && candidate.operatorDecision === "approve_live_execution"
    && candidate.requiresOperatorDecision === true
  );
  if (actions.length !== 1) {
    throw new Error("CCC campaign requires exactly one declared live-execution protected action");
  }
  const declared = actions[0]!;
  return Object.freeze({
    actionId: declared.id,
    actionTarget: declared.target,
    requireProtected: true,
  });
}

/**
 * Persistence-only primitive that atomically acquires one provider dispatch permit without
 * performing physical Git inspection, full admission, provider, auth, or network work.
 *
 * The engine wrapper is the full pre-dispatch admission path: it performs the production
 * local-Git recheck and passes this primitive only the frozen observation needed for
 * locked-custody comparison inside the same database transaction.
 *
 * Locked campaign custody is checked in the reservation request. Callers supply the actual
 * per-dispatch route together with replay coordinates and the issued approval claim identity.
 */
export async function atomicReserveCccCampaignProviderDispatch(
  input: AtomicCccCampaignProviderDispatchInput,
): Promise<CccCampaignProviderControllerDecision> {
  const workItemFence = requireWorkItemFence(input.workItemFence);
  const workItemLeaseOwner = requireWorkItemLeaseOwner(input.workItemLeaseOwner);
  const originTaskId = requireOriginTaskId(input.originTaskId);
  return input.layer.transactionImmediate(async (tx) => {
    const context = await loadCccCampaignContextForTask(input.layer, input.rootDir, input.taskId, tx, true);
    if (!context) throw new Error(`Task ${input.taskId} has no persisted CCC campaign context`);
    const originContext = originTaskId === context.taskId
      ? context
      : await loadCccCampaignContextForTask(input.layer, input.rootDir, originTaskId, tx, true);
    if (
      !originContext
      || originContext.taskId !== originTaskId
      || originContext.projectId !== context.projectId
      || originContext.importId !== context.importId
      || originContext.campaignId !== context.campaignId
      || originContext.idempotencyKey !== context.idempotencyKey
      || originContext.packetHash !== context.packetHash
      || originContext.sidecarHash !== context.sidecarHash
      || originContext.bundleHash !== context.bundleHash
      || originContext.manifestHash !== context.manifestHash
      || originContext.targetRepository.path !== context.targetRepository.path
      || originContext.targetRepository.baseCommit !== context.targetRepository.baseCommit
    ) {
      throw new Error("CCC campaign workflow origin task does not match semantic task campaign custody");
    }
    if (
      input.gitObservation.targetRoot !== context.targetRepository.path
      || input.gitObservation.expectedBaseObject !== context.targetRepository.baseCommit
      || !CANONICAL_GIT_OBJECT_ID.test(input.gitObservation.head)
      || input.gitObservation.head.length !== input.gitObservation.expectedBaseObject.length
      || input.gitObservation.headDescendsFromExpectedBase !== true
    ) {
      throw new Error("CCC campaign local Git snapshot does not match locked campaign custody");
    }
    const action = selectCccCampaignDeclaredLiveExecutionAction(
      context.protectedActions,
      context.protectedActionIds,
    );
    const approvalInput: AssertActiveClaimedCccCampaignApprovalInput = {
      authorityStore: input.authorityStore,
      rootDir: input.rootDir,
      taskId: context.taskId,
      action,
      approvalRequestId: input.approvalRequestId,
      claimToken: input.claimToken,
    };
    const reserved = await reserveCccProviderAttempt({
      layer: input.layer,
      rootDir: input.rootDir,
      tx,
      request: {
        taskId: context.taskId,
        actionId: action.actionId,
        actionTarget: action.actionTarget,
        turnKey: input.turnKey,
        dispatchKey: input.dispatchKey,
        providerId: input.providerId,
        modelId: input.modelId,
        transport: input.transport,
        workItemFence,
      },
    });
    if (reserved.state === "reserved") {
      /*
       * Only a brand-new attempt reservation needs a live, currently-running
       * workflow work-item lease: reserveCccProviderAttempt's attemptKey is
       * derived from workItemFence and it re-validates that exact fence via
       * assertReservationReplay on every replay, so an already-reserved
       * attempt (dispatched_unknown/proved_failed/committed) stays correctly
       * fenced to its original caller even after the work item has left
       * "running" (settled terminal, or a crash-recovery restart whose lease
       * expired before the held closure could be rehydrated).
       */
      const workItems = await tx
        .select({ id: schema.project.workflowWorkItems.id })
        .from(schema.project.workflowWorkItems)
        .where(and(
          eq(schema.project.workflowWorkItems.projectId, context.projectId),
          eq(schema.project.workflowWorkItems.id, workItemFence.workItemId),
          eq(schema.project.workflowWorkItems.taskId, originTaskId),
          eq(schema.project.workflowWorkItems.runId, workItemFence.runId),
          eq(schema.project.workflowWorkItems.attempt, workItemFence.attempt),
          eq(schema.project.workflowWorkItems.state, "running"),
          eq(schema.project.workflowWorkItems.leaseOwner, workItemLeaseOwner),
          sql`${schema.project.workflowWorkItems.leaseExpiresAt} IS NOT NULL
            AND ${schema.project.workflowWorkItems.leaseExpiresAt}::timestamptz > clock_timestamp()`,
        ))
        .limit(1)
        .for("update");
      if (workItems.length !== 1) {
        throw new Error(`CCC campaign workflow work-item fence refused ${workItemFence.workItemId}`);
      }
    }
    switch (reserved.state) {
      case "reserved":
        try {
          await assertActiveClaimedCccCampaignApprovalWithinTransaction(tx, approvalInput);
        } catch (activeClaimError) {
          /*
           * Follow-on turn custody: settlement consumes the live-execution
           * approval on the session's first committed terminal, so a later
           * turn of the same fenced node visit can never present an active
           * claim. Accept exact consumed custody instead, but only when this
           * same work-item fence already owns a committed attempt for this
           * action — that committed attempt's settlement is what consumed
           * the claim, so the operator's one approval keeps covering exactly
           * the session it authorized and nothing else.
           */
          const attempts = await listCccProviderAttemptsForCampaign({
            layer: input.layer,
            rootDir: input.rootDir,
            taskId: context.taskId,
            tx,
          });
          const sessionCommitted = attempts.some((scope) =>
            scope.state === "committed"
            && scope.binding.actionId === action.actionId
            && scope.binding.actionTarget === action.actionTarget
            && scope.workItemFence !== null
            && scope.workItemFence.workItemId === workItemFence.workItemId
            && scope.workItemFence.runId === workItemFence.runId
            && scope.workItemFence.attempt === workItemFence.attempt);
          if (!sessionCommitted) throw activeClaimError;
          await assertConsumedCccCampaignApprovalForFollowOnDispatchWithinTransaction(tx, approvalInput);
        }
        break;
      case "dispatched_unknown":
      case "proved_failed":
        await assertClaimedCccCampaignApprovalWithinTransaction(tx, approvalInput);
        break;
      case "committed":
        await assertConsumedCccCampaignApprovalWithinTransaction(tx, approvalInput);
        break;
    }
    const begun = await beginCccProviderAttemptDispatch({
      layer: input.layer,
      rootDir: input.rootDir,
      tx,
      transition: {
        taskId: reserved.taskId,
        attemptKey: reserved.attemptKey,
        controllerToken: reserved.controllerToken,
      },
    });
    return controllerDecision(begun);
  });
}


function controllerDecision(decision: CccProviderAttemptDispatchDecision): CccCampaignProviderControllerDecision {
  if (decision.kind === "dispatch-permit") return Object.freeze({ kind: "dispatch-permit", scope: decision.scope });
  return Object.freeze({
    kind: "hold",
    reason: decision.kind === "dispatched-unknown" ? "dispatched-unknown" : "terminal",
    scope: decision.scope,
  });
}
