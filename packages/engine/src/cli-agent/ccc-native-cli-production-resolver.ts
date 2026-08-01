import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import {
  createCccCampaignAuthorityBinding,
  selectCccCampaignDeclaredLiveExecutionAction,
  type AsyncDataLayer,
  type CccCampaignAuthorityStore,
  type CccCampaignProviderDispatchInput,
  type CccCampaignTaskContext,
} from "@fusion/core";
import { inspectCccCampaignLocalGit } from "../ccc-campaign-local-git.js";
import {
  preDispatchCccCampaignProviderFromEngine,
  requireCccCampaignWorkItemLeaseOwner,
} from "../ccc-campaign-provider-controller.js";
import {
  CCC_NATIVE_CLI_BINDING_ID,
  CCC_NATIVE_CLI_BINDING_KIND,
  CCC_NATIVE_CLI_BINDING_VERSION,
  CCC_NATIVE_CLI_DISPATCH_KEY,
  CCC_NATIVE_CLI_OBSERVER_ID,
  CCC_NATIVE_CLI_OBSERVATION_KIND,
  CCC_NATIVE_CLI_OBSERVATION_VERSION,
  type CccNativeCliBinding,
  type CccNativeCliBindingResolver,
  type CccNativeCliBindingResolverInput,
  type CccNativeCliHeldClosureReceipt,
  type CccNativeCliControllerReconciliation,
  type CccNativeCliRoute,
} from "./ccc-native-cli-binding.js";
import type { CliSessionStore } from "@fusion/core";

export type CreateCccNativeCliProductionResolverInput = Readonly<{
  layer: AsyncDataLayer;
  rootDir: string;
  campaignAuthorityStore: CccCampaignAuthorityStore;
  cliSessionStore: CliSessionStore;
}>;

const TERM_GRACE_MS = 1_000;
const KILL_CLOSURE_MS = 1_000;

/**
 * Native production route. It only creates a sealed one-shot binding; the
 * executor owns PTY lifecycle and this module never launches a provider.
 */
export function createCccNativeCliProductionResolver(
  options: CreateCccNativeCliProductionResolverInput,
): CccNativeCliBindingResolver {
  return async (input: CccNativeCliBindingResolverInput): Promise<CccNativeCliBinding> => {
    input.signal?.throwIfAborted();
    const workItemLeaseOwner = requireCccCampaignWorkItemLeaseOwner(input.executionFence.leaseOwner);
    const rootDir = await realpath(options.rootDir);
    const context = await loadContext(
      options,
      input.nativeTaskId,
      input.semanticTaskId,
    );
    assertRoute(input.expectedRoute, context);
    if (context.targetRepository.path !== rootDir) {
      throw new Error("CCC native CLI resolver root does not match persisted campaign target");
    }
    const action = selectCccCampaignDeclaredLiveExecutionAction(
      context.protectedActions,
      context.protectedActionIds,
    );
    const authorityBinding = Object.freeze(createCccCampaignAuthorityBinding(context, action));
    const lease = await options.campaignAuthorityStore.inspectCccCampaignActionLease(
      context.taskId,
      action,
    );
    if (
      !lease
      || lease.binding.bindingHash !== authorityBinding.bindingHash
      || lease.lease.bindingHash !== authorityBinding.bindingHash
      || lease.lease.actionId !== action.actionId
      || lease.lease.actionTarget !== action.actionTarget
    ) {
      throw new Error("CCC native CLI resolver requires one exact active action lease");
    }
    const initialGitSnapshot = await inspectCccCampaignLocalGit({
      targetRoot: rootDir,
      expectedBaseObject: context.targetRepository.baseCommit,
    });
    const limits = oneShotLimits(context.bounds.maxDurationMs);
    const route = Object.freeze({ ...input.expectedRoute });
    const workItemFence = Object.freeze({
      workItemId: input.executionFence.workItemId,
      runId: input.executionFence.runId,
      attempt: input.executionFence.attempt,
    });

    return Object.freeze({
      kind: CCC_NATIVE_CLI_BINDING_KIND,
      version: CCC_NATIVE_CLI_BINDING_VERSION,
      id: CCC_NATIVE_CLI_BINDING_ID,
      turnKey: input.turnKey,
      dispatchKey: CCC_NATIVE_CLI_DISPATCH_KEY,
      authorityBindingHash: authorityBinding.bindingHash,
      route,
      limits,
      followUp: false,
      observer: Object.freeze({
        id: CCC_NATIVE_CLI_OBSERVER_ID,
        observe: (value: unknown) => observeHeldClosure(value, authorityBinding.bindingHash),
      }),
      controller: Object.freeze({
        preDispatch: (dispatch: CccCampaignProviderDispatchInput) => preDispatchCccCampaignProviderFromEngine({
          initialGitSnapshot,
          signal: input.signal,
          preDispatch: {
            layer: options.layer,
            authorityStore: options.campaignAuthorityStore,
            rootDir,
            originTaskId: input.originTaskId,
            taskId: context.taskId,
            approvalRequestId: lease.lease.approvalRequestId,
            claimToken: lease.lease.claimToken,
            ...dispatch,
            workItemFence,
            workItemLeaseOwner,
          },
        }),
        reconcile: (reconciliation: CccNativeCliControllerReconciliation) => options.cliSessionStore.settleCccProviderAttemptAndFence({
          reconciliation,
          terminationReason: reconciliation.terminationReason,
          cancellationState: reconciliation.cancellationState,
        }),
      }),
    }) satisfies CccNativeCliBinding;
  };
}

async function loadContext(
  options: CreateCccNativeCliProductionResolverInput,
  nativeTaskId: string,
  semanticTaskId: string,
): Promise<CccCampaignTaskContext> {
  const context = await options.layer.transaction(async (tx) =>
    options.campaignAuthorityStore.getCccCampaignContextForTaskWithinTransaction(tx, nativeTaskId));
  if (
    !context
    || context.taskId !== nativeTaskId
    || context.semanticTaskId !== semanticTaskId
    || context.route.taskId !== semanticTaskId
  ) {
    throw new Error("CCC native CLI resolver requires persisted matching task context");
  }
  return context;
}

function assertRoute(route: CccNativeCliRoute, context: CccCampaignTaskContext): void {
  if (
    route.transport !== "cli"
    || route.providerId !== context.route.providerId
    || route.modelId !== context.route.modelId
    || context.route.transport !== "cli"
    || !canonicalText(route.adapterId)
    || !canonicalText(route.providerId)
    || !canonicalText(route.modelId)
  ) {
    throw new Error("CCC native CLI resolver route does not match persisted campaign route");
  }
}

function oneShotLimits(maxDurationMs: number) {
  if (!Number.isSafeInteger(maxDurationMs) || maxDurationMs <= TERM_GRACE_MS + KILL_CLOSURE_MS) {
    throw new Error("CCC native CLI resolver campaign duration cannot fund bounded closure");
  }
  return Object.freeze({
    maxRequests: 1 as const,
    lifetimeMs: maxDurationMs,
    termGraceMs: TERM_GRACE_MS,
    killClosureMs: KILL_CLOSURE_MS,
  });
}

function observeHeldClosure(value: unknown, authorityBindingHash: string) {
  const candidate = value as { receipt?: CccNativeCliHeldClosureReceipt; permitScope?: { taskId?: unknown; turnKey?: unknown; dispatchKey?: unknown; binding?: { bindingHash?: unknown } } };
  const receipt = candidate?.receipt;
  const permit = candidate?.permitScope;
  const exact = Boolean(
    receipt
    && permit
    && receipt.taskId === permit.taskId
    && receipt.turnKey === permit.turnKey
    && receipt.dispatchKey === permit.dispatchKey
    && receipt.authorityBindingHash === authorityBindingHash
    && permit.binding?.bindingHash === authorityBindingHash
    && receipt.trigger === "done"
    && receipt.exitCode === 0
    && receipt.exitSignal === 0
    && receipt.processGroupClosed === true
    && receipt.proxyClosed === true
    && receipt.durableFloorFlushed === true
    && receipt.slotHeld === true,
  );
  return Object.freeze({
    kind: CCC_NATIVE_CLI_OBSERVATION_KIND,
    version: CCC_NATIVE_CLI_OBSERVATION_VERSION,
    outcome: exact ? "committed" as const : "proved_failed" as const,
    evidenceDigest: createHash("sha256").update(JSON.stringify({
      authorityBindingHash,
      taskId: receipt?.taskId ?? null,
      turnKey: receipt?.turnKey ?? null,
      dispatchKey: receipt?.dispatchKey ?? null,
      trigger: receipt?.trigger ?? null,
      exitCode: receipt?.exitCode ?? null,
      exitSignal: receipt?.exitSignal ?? null,
      processGroupClosed: receipt?.processGroupClosed === true,
      proxyClosed: receipt?.proxyClosed === true,
      durableFloorFlushed: receipt?.durableFloorFlushed === true,
      slotHeld: receipt?.slotHeld === true,
    })).digest("hex"),
  });
}

function canonicalText(value: string): boolean {
  return value.length > 0 && value === value.trim();
}
