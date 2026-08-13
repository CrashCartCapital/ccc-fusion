import {
  atomicReserveCccCampaignProviderDispatch,
  createCccCampaignAuthorityBinding,
  CccProviderAttemptLimitError,
  readConsumedCccCampaignApprovalCustodyWithinTransaction,
  selectCccCampaignDeclaredLiveExecutionAction,
  type CccCampaignAuthorityStore,
  type CccCampaignWorkItemFence,
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
import { encodeCccCampaignRequestBudgetExhausted } from "./ccc-campaign-runtime-errors.js";

const CANONICAL_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;

export type CccCampaignWorkflowProviderBinding = Readonly<{
  providerController: CccProviderAttemptBinding["controller"];
  providerRoute: Readonly<{
    providerId: string;
    modelId: string;
    transport: "workflow";
    workflowExtensionId: string;
  }>;
}>;

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
  try {
    return await atomicReserveCccCampaignProviderDispatch({
      ...input.preDispatch,
      gitObservation: Object.freeze({ targetRoot: rechecked.targetRoot, expectedBaseObject: rechecked.expectedBaseObject, head: rechecked.head, headDescendsFromExpectedBase: true }),
    });
  } catch (error) {
    if (
      error instanceof CccProviderAttemptLimitError
      && error.reason === "max-requests"
    ) {
      throw encodeCccCampaignRequestBudgetExhausted(error);
    }
    throw error;
  }
}

/**
 * Create the one sealed provider binding for a fenced workflow model node. The
 * closure re-derives persisted campaign custody and never accepts route or
 * approval provenance from its caller.
 */
type CccCampaignProviderAttemptBindingInput = Readonly<{
  layer: AsyncDataLayer;
  rootDir: string;
  authorityStore: CccCampaignAuthorityStore;
  /** Sealed graph task that owns the active workflow work-item fence. */
  originTaskId: string;
  semanticTaskId: string;
  nativeTaskId?: string;
  turnKey: string;
  workItemFence: CccCampaignWorkItemFence;
  workItemLeaseOwner: string;
  /** PI binds exact resolved route; scoped workflow binds its native transport and extension identity. */
  expectedRoute: Readonly<{ transport: "workflow"; workflowExtensionId: string }> | Readonly<{ transport: "pi"; providerId: string; modelId: string }>;
  signal?: AbortSignal;
}>;

export function createCccCampaignProviderAttemptBinding(
  input: CccCampaignProviderAttemptBindingInput & Readonly<{
    expectedRoute: Readonly<{ transport: "workflow"; workflowExtensionId: string }>;
    workflowProviderBinding: true;
  }>,
): Promise<CccCampaignWorkflowProviderBinding>;
export function createCccCampaignProviderAttemptBinding(
  input: CccCampaignProviderAttemptBindingInput & Readonly<{ workflowProviderBinding?: false | undefined }>,
): Promise<CccProviderAttemptBinding>;
export async function createCccCampaignProviderAttemptBinding(
  input: CccCampaignProviderAttemptBindingInput & Readonly<{ workflowProviderBinding?: boolean }>,
): Promise<CccProviderAttemptBinding | CccCampaignWorkflowProviderBinding> {
  const workItemLeaseOwner = requireCccCampaignWorkItemLeaseOwner(input.workItemLeaseOwner);
  const rootDir = await realpath(input.rootDir);
  const nativeTaskId = input.nativeTaskId ?? input.semanticTaskId;
  const context = await input.layer.transaction((tx) =>
    input.authorityStore.getCccCampaignContextForTaskWithinTransaction(tx, nativeTaskId));
  if (
    !context
    || context.taskId !== nativeTaskId
    || context.semanticTaskId !== input.semanticTaskId
    || context.route.taskId !== input.semanticTaskId
  ) {
    throw new Error("CCC PI binding requires persisted matching task context");
  }
  if (context.targetRepository.path !== rootDir) {
    throw new Error("CCC provider binding route does not match persisted campaign custody");
  }
  if (input.expectedRoute.transport === "workflow") {
    if (context.route.transport !== "workflow") throw new Error("CCC workflow binding route does not match persisted campaign route");
    if (context.route.workflowExtensionId !== input.expectedRoute.workflowExtensionId) {
      throw new Error("CCC workflow extension binding does not match persisted campaign route");
    }
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
          originTaskId: input.originTaskId,
          taskId: context.taskId,
          approvalRequestId: approvalCustody.approvalRequestId,
          claimToken: approvalCustody.claimToken,
          ...dispatch,
          workItemFence: input.workItemFence,
          workItemLeaseOwner,
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
  if (input.workflowProviderBinding) {
    if (
      input.expectedRoute.transport !== "workflow"
      || typeof context.route.providerId !== "string"
      || !CANONICAL_IDENTIFIER_PATTERN.test(context.route.providerId)
      || typeof context.route.modelId !== "string"
      || !CANONICAL_IDENTIFIER_PATTERN.test(context.route.modelId)
      || typeof context.route.workflowExtensionId !== "string"
      || !CANONICAL_IDENTIFIER_PATTERN.test(context.route.workflowExtensionId)
    ) {
      throw new Error("CCC workflow binding requires a persisted canonical provider route");
    }
    return Object.freeze({
      providerController: controller,
      providerRoute: Object.freeze({
        providerId: context.route.providerId,
        modelId: context.route.modelId,
        transport: "workflow" as const,
        workflowExtensionId: context.route.workflowExtensionId,
      }),
    });
  }
  return Object.freeze({ turnKey: input.turnKey, controller });
}

export function requireCccCampaignWorkItemLeaseOwner(value: unknown): string {
  if (typeof value !== "string" || !CANONICAL_IDENTIFIER_PATTERN.test(value)) {
    throw new Error("CCC campaign workflow work-item lease owner is invalid");
  }
  return value;
}
