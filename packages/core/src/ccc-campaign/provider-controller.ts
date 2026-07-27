import {
  assertActiveClaimedCccCampaignApprovalWithinTransaction,
  assertClaimedCccCampaignApprovalWithinTransaction,
  assertConsumedCccCampaignApprovalWithinTransaction,
  type AssertActiveClaimedCccCampaignApprovalInput,
} from "../async-approval-request-store.js";
import type { AsyncDataLayer } from "../postgres/data-layer.js";
import { beginCccProviderAttemptDispatch, reserveCccProviderAttempt } from "./provider-attempt.js";
import { loadCccCampaignContextForTask, type CccCampaignAuthorityStore } from "./store.js";
import type { CccPrdProtectedActionIntent } from "../ccc-prd/types.js";
import type { CccCampaignTransport, CccProviderAttemptDispatchDecision, CccProviderAttemptScope } from "./types.js";

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
  taskId: string;
  approvalRequestId: string;
  claimToken: string;
}> & CccCampaignProviderDispatchInput;

export type CccCampaignLiveExecutionAction = Readonly<{
  actionId: string;
  actionTarget: string;
  requireProtected: true;
}>;

const CANONICAL_GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

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
  return input.layer.transactionImmediate(async (tx) => {
    const context = await loadCccCampaignContextForTask(input.layer, input.rootDir, input.taskId, tx, true);
    if (!context) throw new Error(`Task ${input.taskId} has no persisted CCC campaign context`);
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
      },
    });
    switch (reserved.state) {
      case "reserved":
        await assertActiveClaimedCccCampaignApprovalWithinTransaction(tx, approvalInput);
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
