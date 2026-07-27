import {
  atomicReserveCccCampaignProviderDispatch,
  createCccCampaignAuthorityBinding,
  readConsumedCccCampaignApprovalCustodyWithinTransaction,
  selectCccCampaignDeclaredLiveExecutionAction,
  type CccCampaignAuthorityStore,
  type CccCampaignProviderControllerDecision,
  type CccCampaignProviderDispatchInput,
  type CccProviderAttemptScope,
  type CccProviderAttemptSettlementInput,
  type AtomicCccCampaignProviderDispatchInput,
  type AsyncDataLayer,
} from "@fusion/core";
import { realpath } from "node:fs/promises";
import { inspectCccCampaignLocalGit } from "./ccc-campaign-local-git.js";
import type { CccProviderAttemptBinding } from "./agent-runtime.js";
import { recheckCccCampaignLocalGit, type CccCampaignLocalGitSnapshot } from "./ccc-campaign-local-git.js";

export type CccCampaignEngineProviderControllerInput = Readonly<{
  initialGitSnapshot: CccCampaignLocalGitSnapshot;
  signal?: AbortSignal;
  preDispatch: Omit<AtomicCccCampaignProviderDispatchInput, "layer" | "authorityStore" | "gitObservation"> & {
    layer: AsyncDataLayer;
    authorityStore: CccCampaignAuthorityStore;
  };
}>;

/** Rechecks the immutable initial Git observation before obtaining a one-shot core permit. */
export async function preDispatchCccCampaignProviderFromEngine(
  input: CccCampaignEngineProviderControllerInput,
): Promise<CccCampaignProviderControllerDecision> {
  const rechecked = await recheckCccCampaignLocalGit(input.initialGitSnapshot, input.signal);
  input.signal?.throwIfAborted();
  return atomicReserveCccCampaignProviderDispatch({
    ...input.preDispatch,
    gitObservation: Object.freeze({ targetRoot: rechecked.targetRoot, expectedBaseObject: rechecked.expectedBaseObject, head: rechecked.head, headDescendsFromExpectedBase: true }),
  });
}

/**
 * Create the one sealed provider binding for a fenced workflow model node. The
 * closure re-derives persisted campaign custody and never accepts route or
 * approval provenance from its caller.
 */
export async function createCccCampaignProviderAttemptBinding(input: Readonly<{
  layer: AsyncDataLayer;
  rootDir: string;
  authorityStore: CccCampaignAuthorityStore;
  semanticTaskId: string;
  turnKey: string;
  /** PI binds exact resolved route; scoped workflow binds its native transport. */
  expectedRoute: Readonly<{ transport: "workflow" }> | Readonly<{ transport: "pi"; providerId: string; modelId: string }>;
  signal?: AbortSignal;
}>): Promise<CccProviderAttemptBinding> {
  const rootDir = await realpath(input.rootDir);
  const context = await input.layer.transaction((tx) =>
    input.authorityStore.getCccCampaignContextForTaskWithinTransaction(tx, input.semanticTaskId));
  if (!context || context.taskId !== input.semanticTaskId || context.semanticTaskId !== input.semanticTaskId) {
    throw new Error("CCC PI binding requires persisted matching task context");
  }
  if (context.targetRepository.path !== rootDir) {
    throw new Error("CCC provider binding route does not match persisted campaign custody");
  }
  if (input.expectedRoute.transport === "workflow") {
    if (context.route.transport !== "workflow") throw new Error("CCC workflow binding route does not match persisted campaign route");
  } else if (
    context.route.transport !== "pi"
    || context.route.providerId !== input.expectedRoute.providerId
    || context.route.modelId !== input.expectedRoute.modelId
  ) throw new Error("CCC PI binding resolved route does not match persisted campaign route");
  const action = selectCccCampaignDeclaredLiveExecutionAction(context.protectedActions, context.protectedActionIds);
  const authorityBinding = createCccCampaignAuthorityBinding(context, action);
  const lease = await input.authorityStore.inspectCccCampaignActionLease(context.taskId, action);
  const approvalCustody = lease
    ? (() => {
        if (
          lease.binding.bindingHash !== authorityBinding.bindingHash
          || lease.lease.bindingHash !== authorityBinding.bindingHash
          || lease.lease.actionId !== action.actionId
          || lease.lease.actionTarget !== action.actionTarget
        ) throw new Error("CCC PI binding requires one exact active action lease");
        return Object.freeze({
          approvalRequestId: lease.lease.approvalRequestId,
          claimToken: lease.lease.claimToken,
        });
      })()
    : await input.layer.transaction((tx) => readConsumedCccCampaignApprovalCustodyWithinTransaction(tx, {
      authorityStore: input.authorityStore,
      rootDir,
      taskId: context.taskId,
      action,
    }));
  const initialGitSnapshot = await inspectCccCampaignLocalGit({
    targetRoot: rootDir,
    expectedBaseObject: context.targetRepository.baseCommit,
  });
  const controller = Object.freeze({
    preDispatch: async (dispatch: CccCampaignProviderDispatchInput) => {
      if (dispatch.turnKey !== input.turnKey || dispatch.transport !== context.route.transport) {
        throw new Error("CCC provider binding turn or transport drift refused");
      }
      return preDispatchCccCampaignProviderFromEngine({
        initialGitSnapshot,
        signal: input.signal,
        preDispatch: {
          layer: input.layer,
          authorityStore: input.authorityStore,
          rootDir,
          taskId: context.taskId,
          approvalRequestId: approvalCustody.approvalRequestId,
          claimToken: approvalCustody.claimToken,
          ...dispatch,
        },
      });
    },
    reconcile: async (reconciliation: CccProviderAttemptSettlementInput): Promise<CccProviderAttemptScope> => {
      if (reconciliation.taskId !== context.taskId || reconciliation.turnKey !== input.turnKey) {
        throw new Error("CCC provider binding reconciliation task or turn drift refused");
      }
      const store = input.authorityStore as CccCampaignAuthorityStore & {
        settleCccProviderAttemptAndApproval?: (value: typeof reconciliation) => Promise<unknown>;
      };
      if (typeof store.settleCccProviderAttemptAndApproval !== "function") {
        throw new Error("CCC provider binding requires TaskStore provider settlement");
      }
      return store.settleCccProviderAttemptAndApproval(reconciliation) as ReturnType<CccProviderAttemptBinding["controller"]["reconcile"]>;
    },
  });
  return Object.freeze({ turnKey: input.turnKey, controller });
}
