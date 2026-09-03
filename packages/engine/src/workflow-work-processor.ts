import {
  CCC_CAMPAIGN_EXECUTION_AUTHORIZATION_MODE_SEALED_BUNDLE_V1,
  closeUnopenedCccCampaignExecutionAuthorizationMembers,
  getCccCampaignExecutionAuthorizationForImport,
  isTaskMoveDisposalActive,
  registerTaskMoveDisposer,
  type Settings,
  type TaskDetail,
  type TaskStore,
  type WorkflowWorkItem,
  type WorkflowWorkItemKind,
  type WorkflowWorkItemState,
} from "@fusion/core";
import { claimDueWorkflowWorkItem, type ExactWorkflowWorkCandidate, type WorkflowWorkSchedulerStore } from "./workflow-work-scheduler.js";
import { WorkflowTaskRuntime, type WorkflowTaskRuntimeResult } from "./workflow-task-runtime.js";
import { ensureWorkflowCompletionSummary } from "./workflow-completion-summary.js";
import { isImportedCccCampaignWorkItem } from "./ccc-campaign-routing.js";
import { CCC_CAMPAIGN_LIVE_EXECUTION_APPROVAL_REQUIRED_REASON } from "./ccc-campaign-product-control.js";
import { CCC_RETRY_CLASSIFICATION_CONTEXT_KEY } from "./workflow-graph-executor.js";

export interface WorkflowWorkProcessorOptions {
  leaseOwner: string;
  leaseDurationMs: number;
  now?: string;
  kinds?: WorkflowWorkItemKind[];
  exactCandidate?: ExactWorkflowWorkCandidate;
  campaignRequired?: boolean;
}

export interface WorkflowWorkProcessorResult {
  claimed: boolean;
  workItemId?: string;
  taskId?: string;
  runtime?: WorkflowTaskRuntimeResult;
  /** Post-terminal custody warnings; durable work-item state remains authoritative. */
  diagnostics?: readonly string[];
}

type WorkflowWorkProcessorStore = WorkflowWorkSchedulerStore & {
  transitionWorkflowWorkItem?: (
    id: string,
    state: WorkflowWorkItemState,
    patch?: { now?: string; expectedState?: WorkflowWorkItemState; expectedLeaseOwner?: string | null; expectedAttempt?: number; attempt?: number; lastError?: string | null; blockedReason?: string | null; leaseOwner?: string | null; leaseExpiresAt?: string | null },
  ) => WorkflowWorkItem | Promise<WorkflowWorkItem>;
  renewWorkflowWorkItemLease?: (
    id: string,
    leaseOwner: string,
    expectedAttempt: number,
    opts: { leaseDurationMs: number; now?: string },
  ) => WorkflowWorkItem | null | Promise<WorkflowWorkItem | null>;
  getCccCampaignContextForTask?: (taskId: string) => Promise<unknown | null> | unknown | null;
  getWorkflowWorkItem?: (id: string) => WorkflowWorkItem | null | Promise<WorkflowWorkItem | null>;
  updateTask?: (taskId: string, updates: { summary: string }) => Promise<unknown> | unknown;
};

class WorkflowCampaignTerminalTransitionError extends Error {
  public constructor(public readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "WorkflowCampaignTerminalTransitionError";
  }
}

const WORKFLOW_TERMINAL_AUTHORIZATION_ACTOR = Object.freeze({
  actorId: "ccc-campaign-work-processor",
  actorType: "system" as const,
  actorName: "CCC Campaign Work Processor",
});

type CampaignCompletion =
  | { runtime: WorkflowTaskRuntimeResult }
  | { error: unknown };

export async function processDueWorkflowWorkItem(
  store: WorkflowWorkProcessorStore,
  runtime: WorkflowTaskRuntime,
  settings: (Pick<Settings, "experimentalFeatures"> & Partial<Settings>) | undefined,
  opts: WorkflowWorkProcessorOptions,
): Promise<WorkflowWorkProcessorResult> {
  if (typeof store.transitionWorkflowWorkItem !== "function") {
    /*
    FNXC:CCCWorkProcessor 2026-07-24-15:12: never consume a recoverable work
    lease unless the native terminal transition exists to durably record a
    runtime rejection.
    */
    throw new Error("workflow work processor requires transitionWorkflowWorkItem");
  }
  /* FNXC:MissionSymbolAdmission 2026-07-31-12:00: await the async symbol-lock admission before runtime may consume the workflow work lease. */
  const dispatch = await claimDueWorkflowWorkItem(store, {
    now: opts.now,
    leaseOwner: opts.leaseOwner,
    leaseDurationMs: opts.leaseDurationMs,
    kinds: opts.kinds,
    exactCandidate: opts.exactCandidate,
    bypassMissionSymbolAdmission: opts.campaignRequired === true,
  });
  if (!dispatch) return { claimed: false };
  const diagnostics: string[] = [];

  let runtimeResult: WorkflowTaskRuntimeResult;
  let campaignContext: unknown | null = null;
  const abortController = new AbortController();
  let resolveCampaignCompletion: ((completion: CampaignCompletion) => void) | undefined;
  let campaignCompletion: Promise<CampaignCompletion> | undefined;
  let unregisterTaskMoveDisposer: (() => void) | undefined;
  let campaignCompletionError: unknown;
  let userCancellationRequested = false;
  const requestUserCancellation = () => {
    userCancellationRequested = true;
    if (!abortController.signal.aborted) abortController.abort(new Error("workflow-user-cancelled"));
  };
  const observeUserPausedTask = async () => {
    const task = await awaitPreRuntimeRead(Promise.resolve(store.getTask?.(dispatch.taskId)), abortController.signal) as TaskDetail | undefined;
    if (task?.userPaused === true) requestUserCancellation();
  };
  const registerCampaignTaskMoveDisposer = () => {
    if (unregisterTaskMoveDisposer) return;
    campaignCompletion = new Promise<CampaignCompletion>((resolve) => {
      resolveCampaignCompletion = resolve;
    });
    /*
    FNXC:CCCHardCancellation 2026-07-27-02:00: any claimed workflow item
    may still be awaiting campaign classification when a user parks it.
    Register on the exact TaskStore instance before that await so moveTask
    cannot make the task look idle before this claim reaches a durable state.
    */
    unregisterTaskMoveDisposer = registerTaskMoveDisposer(store as TaskStore, async (task) => {
      if (task.id !== dispatch.taskId) return;
      requestUserCancellation();
      const completion = await campaignCompletion!;
      if ("error" in completion) throw completion.error;
    });
  };
  // Classify every claimed item under an exact-task disposer so a user move that
  // lands during an async read cannot escape into either runtime path.
  registerCampaignTaskMoveDisposer();
  if (isTaskMoveDisposalActive(store as TaskStore, dispatch.taskId)) {
    requestUserCancellation();
  }
  let workflowLeaseRenewInterval: ReturnType<typeof setInterval> | undefined;
  /*
  FNXC:MissionSymbolAdmission 2026-08-01-01:00:
  Workflow execution can outlive the ten-minute crash-recoverable lease. Renew
  only locks acquired by this claim while its runtime is live; transition release
  remains authoritative once the work reaches review, requeue, or terminal state.
  */
  const renewInterval = dispatch.symbolLocks && store.renewSymbolLocks
    ? setInterval(() => {
      void store.renewSymbolLocks!(dispatch.symbolLocks!, dispatch.taskId, 10 * 60_000)
        .then(async (result) => {
          if (result.lost.length > 0) {
            await store.logEntry?.(dispatch.taskId, `workflow symbol-lock renewal lost: ${result.lost.join(", ")}`);
          }
        })
        .catch(() => undefined);
    }, (10 * 60_000) / 3)
    : undefined;
  try {
    const importedCampaignWorkItem = isImportedCccCampaignWorkItem(dispatch.workItem);
    const campaignRequired = opts.campaignRequired === true || importedCampaignWorkItem;
    if (userCancellationRequested) {
      runtimeResult = await transitionCampaignTerminal(store, opts, dispatch.workItem, abortedCampaignRuntimeResult(true), abortController.signal, campaignContext, diagnostics);
      return claimedProcessorResult(dispatch.workItem, runtimeResult, diagnostics);
    }
    if (campaignRequired) {
      await observeUserPausedTask();
      if (userCancellationRequested) {
        runtimeResult = await transitionCampaignTerminal(store, opts, dispatch.workItem, abortedCampaignRuntimeResult(true), abortController.signal, campaignContext, diagnostics);
        return claimedProcessorResult(dispatch.workItem, runtimeResult, diagnostics);
      }
    }
    const getCampaignContext = store.getCccCampaignContextForTask;
    if (campaignRequired && typeof getCampaignContext !== "function") {
      throw new Error("workflow campaign custody lookup is unwired");
    }
    campaignContext = typeof getCampaignContext === "function"
      ? await awaitPreRuntimeRead(Promise.resolve(getCampaignContext.call(store, dispatch.taskId)), abortController.signal)
      : null;
    if (userCancellationRequested) {
      runtimeResult = await transitionCampaignTerminal(store, opts, dispatch.workItem, abortedCampaignRuntimeResult(true), abortController.signal, campaignContext, diagnostics);
      return claimedProcessorResult(dispatch.workItem, runtimeResult, diagnostics);
    }
    if (campaignRequired && !campaignContext) {
      throw new Error(importedCampaignWorkItem
        ? "workflow imported campaign custody is missing"
        : "workflow required campaign custody is missing");
    }
    if (campaignRequired || campaignContext) {
      if (!campaignRequired) {
        await observeUserPausedTask();
        if (userCancellationRequested) {
          runtimeResult = await transitionCampaignTerminal(store, opts, dispatch.workItem, abortedCampaignRuntimeResult(true), abortController.signal, campaignContext, diagnostics);
          return claimedProcessorResult(dispatch.workItem, runtimeResult, diagnostics);
        }
      }
      if (dispatch.workItem.attempt === 0) {
        dispatch.workItem = await store.transitionWorkflowWorkItem(dispatch.workItem.id, "running", {
          now: opts.now,
          expectedState: "running",
          expectedLeaseOwner: opts.leaseOwner,
          expectedAttempt: 0,
          attempt: 1,
          leaseOwner: opts.leaseOwner,
        });
      }
      registerCampaignTaskMoveDisposer();
      if (abortController.signal.aborted) {
        runtimeResult = await transitionCampaignTerminal(store, opts, dispatch.workItem, abortedCampaignRuntimeResult(userCancellationRequested), abortController.signal, campaignContext, diagnostics);
        return claimedProcessorResult(dispatch.workItem, runtimeResult, diagnostics);
      }
      if (typeof store.renewWorkflowWorkItemLease !== "function") {
        throw new Error("workflow campaign processor requires renewWorkflowWorkItemLease");
      }
      workflowLeaseRenewInterval = startWorkflowLeaseRenewal(store, dispatch.workItem, opts, abortController);
      runtimeResult = await runCampaignWorkflowWorkItem(store, runtime, settings, opts, dispatch.workItem, abortController.signal, () => userCancellationRequested, campaignContext, diagnostics);
    } else {
      unregisterTaskMoveDisposer?.();
      unregisterTaskMoveDisposer = undefined;
      runtimeResult = await runtime.runWorkItem(dispatch.workItem, settings);
    }
  } catch (err) {
    if (err instanceof WorkflowCampaignTerminalTransitionError) {
      campaignCompletionError = err.cause instanceof Error ? err.cause : err;
      throw campaignCompletionError;
    }
    if (userCancellationRequested) {
      try {
        runtimeResult = await transitionCampaignTerminal(store, opts, dispatch.workItem, abortedCampaignRuntimeResult(true), abortController.signal, campaignContext, diagnostics);
        return claimedProcessorResult(dispatch.workItem, runtimeResult, diagnostics);
      } catch (terminalPersistenceError) {
        campaignCompletionError = new AggregateError(
          [err, terminalPersistenceError],
          "workflow work cancellation and terminal persistence both failed",
        );
        throw campaignCompletionError;
      }
    }
    const reason = `workflow-work-item-runtime-error:${err instanceof Error ? err.message : String(err)}`;
    try {
      await store.transitionWorkflowWorkItem(dispatch.workItem.id, "failed", {
        now: opts.now,
        expectedState: "running",
        expectedLeaseOwner: opts.leaseOwner,
        expectedAttempt: dispatch.workItem.attempt,
        attempt: dispatch.workItem.attempt,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: reason,
      });
    } catch (terminalPersistenceError) {
      /*
      FNXC:CCCWorkProcessor 2026-07-24-14:35:
      A runtime rejection plus a rejected native terminal transition is not an
      acknowledged claim: retaining both causes lets the owning caller surface
      the durable-state uncertainty instead of falsely reporting completion.
      */
      campaignCompletionError = new AggregateError(
        [err, terminalPersistenceError],
        "workflow work runtime and terminal persistence both failed",
      );
      throw campaignCompletionError;
    }
    await closeClaimedSealedAuthorizationAfterTerminal(
      store,
      dispatch.workItem,
      "failed",
      reason,
      campaignContext,
      diagnostics,
    );
    runtimeResult = {
      disposition: "failed",
      outcome: "failure",
      visitedNodeIds: [],
      context: {},
      reason,
    };
  } finally {
    if (renewInterval) clearInterval(renewInterval);
    if (workflowLeaseRenewInterval) clearInterval(workflowLeaseRenewInterval);
    unregisterTaskMoveDisposer?.();
    resolveCampaignCompletion?.(campaignCompletionError === undefined
      ? { runtime: runtimeResult! }
      : { error: campaignCompletionError });
  }
  return claimedProcessorResult(dispatch.workItem, runtimeResult, diagnostics);
}

function claimedProcessorResult(
  workItem: WorkflowWorkItem,
  runtime: WorkflowTaskRuntimeResult,
  diagnostics: readonly string[],
): WorkflowWorkProcessorResult {
  return {
    claimed: true,
    workItemId: workItem.id,
    taskId: workItem.taskId,
    runtime,
    ...(diagnostics.length > 0 ? { diagnostics: [...diagnostics] } : {}),
  };
}

function awaitPreRuntimeRead<T>(read: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const settle = (operation: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      operation();
    };
    const onAbort = () => {
      settle(() => reject(signal.reason ?? new Error("workflow-pre-runtime-aborted")));
    };
    void read.then(
      (value) => settle(() => resolve(value)),
      (error) => settle(() => reject(error)),
    );
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

async function runCampaignWorkflowWorkItem(
  store: WorkflowWorkProcessorStore,
  runtime: WorkflowTaskRuntime,
  settings: (Pick<Settings, "experimentalFeatures"> & Partial<Settings>) | undefined,
  opts: WorkflowWorkProcessorOptions,
  workItem: WorkflowWorkItem,
  signal: AbortSignal,
  userCancellationRequested: () => boolean,
  campaignContext: unknown | null,
  diagnostics: string[],
): Promise<WorkflowTaskRuntimeResult> {
  if (!store.getTask) {
    throw new Error("workflow campaign processor requires getTask");
  }
  const task = await awaitPreRuntimeRead(Promise.resolve(store.getTask(workItem.taskId)), signal) as TaskDetail | undefined;
  if (!task) {
    throw new Error(`workflow campaign task missing:${workItem.taskId}`);
  }
  if (signal.aborted) {
    return await transitionCampaignTerminal(
      store,
      opts,
      workItem,
      abortedCampaignRuntimeResult(userCancellationRequested()),
      signal,
      campaignContext,
      diagnostics,
    );
  }
  let runtimeResult: WorkflowTaskRuntimeResult;
  try {
    runtimeResult = await runtime.run(task, settings, {
      signal,
      workItemFence: {
        workItemId: workItem.id,
        leaseOwner: opts.leaseOwner,
        attempt: workItem.attempt,
        runId: workItem.runId,
        eventTimestamp: workItem.updatedAt,
        irHash: workItem.irHash ?? undefined,
      },
      deferCompletionSummary: true,
    });
  } catch (err) {
    if (!signal.aborted) throw err;
    return await transitionCampaignTerminal(store, opts, workItem, abortedCampaignRuntimeResult(userCancellationRequested()), signal, campaignContext, diagnostics);
  }
  if (signal.aborted) {
    return await transitionCampaignTerminal(store, opts, workItem, abortedCampaignRuntimeResult(userCancellationRequested(), runtimeResult), signal, campaignContext, diagnostics);
  }

  return await transitionCampaignTerminal(store, opts, workItem, runtimeResult, signal, campaignContext, diagnostics);
}

function abortedCampaignRuntimeResult(
  userCancellationRequested: boolean,
  runtimeResult?: WorkflowTaskRuntimeResult,
): WorkflowTaskRuntimeResult {
  return {
    disposition: userCancellationRequested ? "cancelled" : "failed",
    outcome: "failure",
    visitedNodeIds: runtimeResult?.visitedNodeIds ?? [],
    context: runtimeResult?.context ?? {},
    reason: userCancellationRequested ? "workflow-user-cancelled" : "workflow-aborted",
  };
}

async function transitionCampaignTerminal(
  store: WorkflowWorkProcessorStore,
  opts: WorkflowWorkProcessorOptions,
  workItem: WorkflowWorkItem,
  runtimeResult: WorkflowTaskRuntimeResult,
  signal: AbortSignal,
  campaignContext: unknown | null,
  diagnostics: string[],
): Promise<WorkflowTaskRuntimeResult> {
  const terminalState: WorkflowWorkItemState = runtimeResult.disposition === "completed"
    ? "succeeded"
    : runtimeResult.disposition === "manual-required"
      ? "manual-required"
      : runtimeResult.disposition === "cancelled"
        ? "cancelled"
        : "failed";
  try {
    await store.transitionWorkflowWorkItem!(workItem.id, terminalState, {
      now: opts.now,
      expectedState: "running",
      expectedLeaseOwner: opts.leaseOwner,
      expectedAttempt: workItem.attempt,
      attempt: workItem.attempt,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: runtimeResult.reason ?? null,
      blockedReason: terminalState === "manual-required"
        ? typeof runtimeResult.context[CCC_RETRY_CLASSIFICATION_CONTEXT_KEY] === "string"
          ? runtimeResult.context[CCC_RETRY_CLASSIFICATION_CONTEXT_KEY] as string
          : runtimeResult.reason ?? "manual-required"
        : null,
    });
  } catch (err) {
    const cancelled = await cancelledWorkItemAfterCasFailure(store, workItem.id);
    if (cancelled) {
      await closeClaimedSealedAuthorizationAfterTerminal(
        store,
        workItem,
        "cancelled",
        "workflow-work-item-cancelled",
        campaignContext,
        diagnostics,
      );
      return {
        disposition: "cancelled",
        outcome: "failure",
        visitedNodeIds: runtimeResult.visitedNodeIds,
        context: runtimeResult.context,
        reason: "workflow-work-item-cancelled",
      };
    }
    throw new WorkflowCampaignTerminalTransitionError(err);
  }

  await closeClaimedSealedAuthorizationAfterTerminal(
    store,
    workItem,
    terminalState,
    runtimeResult.reason,
    campaignContext,
    diagnostics,
  );

  /*
   * The transition above is the ONLY place the terminal reason is recorded, and
   * it goes to the work item's lastError column. Reading that back needs the
   * campaign idempotency key or database credentials, so a failed item otherwise
   * dies with nothing an operator can see — the sealed-authorization diagnostics
   * above report `terminal=failed` but never why. Surface the reason on the same
   * best-effort channel. Emitted after the authorization cleanup so that a
   * closure diagnostic, which explains that cleanup, still leads.
   */
  if (terminalState !== "succeeded") {
    const diagnostic =
      `[ccc-campaign:work-item-terminal] workItem=${workItem.id} `
      + `terminal=${terminalState} reason=${runtimeResult.reason ?? "<none recorded>"}`;
    diagnostics.push(diagnostic);
    await bestEffortWorkflowDiagnostic(store, workItem.taskId, diagnostic);
  }

  if (terminalState === "succeeded" && store.getTask) {
    const latestTask = await awaitPreRuntimeRead(
      Promise.resolve(store.getTask(workItem.taskId)),
      signal,
    ).catch(() => undefined) as TaskDetail | undefined;
    if (latestTask) {
      await awaitPreRuntimeRead(
        Promise.resolve(ensureWorkflowCompletionSummary(store, latestTask, {
          reason: "workflow-work-item:campaign",
          workflowId: String(runtimeResult.context["workflow:id"] ?? "unknown"),
          runId: workItem.runId,
        })),
        signal,
      ).catch(() => undefined);
    }
  }
  return runtimeResult;
}

async function closeClaimedSealedAuthorizationAfterTerminal(
  store: WorkflowWorkProcessorStore,
  workItem: WorkflowWorkItem,
  terminalState: WorkflowWorkItemState,
  reason: string | undefined,
  campaignContext: unknown | null,
  diagnostics: string[],
): Promise<void> {
  if (
    terminalState === "succeeded"
    || (
      terminalState === "manual-required"
      && reason === CCC_CAMPAIGN_LIVE_EXECUTION_APPROVAL_REQUIRED_REASON
    )
  ) {
    return;
  }
  let authorizationId = "unknown";
  try {
    const importId = sealedAuthorizationImportId(campaignContext, workItem);
    if (!importId) return;
    const authorityStore = store as TaskStore;
    const layer = authorityStore.getAsyncLayer();
    if (!layer) {
      throw new Error("sealed campaign terminal authorization cleanup requires PostgreSQL custody");
    }
    const authorization = await getCccCampaignExecutionAuthorizationForImport(
      layer.db,
      importId,
    );
    if (authorization?.status !== "claimed") return;
    authorizationId = authorization.authorizationId;
    const closure = await closeUnopenedCccCampaignExecutionAuthorizationMembers(layer, {
      authorityStore,
      rootDir: authorityStore.rootDir,
      authorizationId,
      actor: WORKFLOW_TERMINAL_AUTHORIZATION_ACTOR,
      runId: workItem.runId,
    });
    if (closure.openedApprovalRequestIds.length > 0) {
      const diagnostic =
        "[ccc-campaign:execution-authorization-reconciliation-required] "
        + `workItem=${workItem.id} authorization=${authorizationId} `
        + `terminal=${terminalState} openedApprovalRequests=${closure.openedApprovalRequestIds.join(",")}`;
      diagnostics.push(diagnostic);
      await bestEffortWorkflowDiagnostic(store, workItem.taskId, diagnostic);
    }
  } catch (error) {
    const diagnostic =
      "[ccc-campaign:execution-authorization-closure-failed] "
      + `workItem=${workItem.id} authorization=${authorizationId} `
      + `terminal=${terminalState} error=${error instanceof Error ? error.message : String(error)}`;
    diagnostics.push(diagnostic);
    await bestEffortWorkflowDiagnostic(store, workItem.taskId, diagnostic);
  }
}

function sealedAuthorizationImportId(
  campaignContext: unknown | null,
  workItem: WorkflowWorkItem,
): string | null {
  if (campaignContext && typeof campaignContext === "object") {
    return "executionAuthorizationMode" in campaignContext
      && campaignContext.executionAuthorizationMode
        === CCC_CAMPAIGN_EXECUTION_AUTHORIZATION_MODE_SEALED_BUNDLE_V1
      && "importId" in campaignContext
      && typeof campaignContext.importId === "string"
      ? campaignContext.importId
      : null;
  }
  if (!isImportedCccCampaignWorkItem(workItem)) return null;
  return workItem.runId.slice("ccc-prd:".length);
}

async function bestEffortWorkflowDiagnostic(
  store: WorkflowWorkProcessorStore,
  taskId: string,
  diagnostic: string,
): Promise<void> {
  try {
    await store.logEntry?.(taskId, diagnostic);
  } catch {
    // The returned processor diagnostic remains available when logging is down.
  }
}

function startWorkflowLeaseRenewal(
  store: WorkflowWorkProcessorStore,
  workItem: WorkflowWorkItem,
  opts: WorkflowWorkProcessorOptions,
  abortController: AbortController,
): ReturnType<typeof setInterval> | undefined {
  const renewWorkflowWorkItemLease = store.renewWorkflowWorkItemLease;
  if (typeof renewWorkflowWorkItemLease !== "function") return undefined;
  const intervalMs = Math.max(1, Math.floor(opts.leaseDurationMs / 3));
  let renewalInFlight = false;
  return setInterval(() => {
    if (renewalInFlight) return;
    renewalInFlight = true;
    /*
    FNXC:CccCampaignWorkflowLease 2026-08-14-10:03: TaskStore lease renewal is
    receiver-dependent; preserve its store binding across the interval callback.
    */
    void Promise.resolve(renewWorkflowWorkItemLease.call(store, workItem.id, opts.leaseOwner, workItem.attempt, {
      leaseDurationMs: opts.leaseDurationMs,
    }))
      .then((renewed) => {
        if (!renewed) abortController.abort(new Error("workflow-work-item-lease-lost"));
      })
      .catch((err) => {
        abortController.abort(err instanceof Error ? err : new Error(String(err)));
      })
      .finally(() => {
        renewalInFlight = false;
      });
  }, intervalMs);
}

async function cancelledWorkItemAfterCasFailure(
  store: WorkflowWorkProcessorStore,
  workItemId: string,
): Promise<boolean> {
  try {
    const current = await store.getWorkflowWorkItem?.(workItemId);
    return current?.state === "cancelled";
  } catch {
    return false;
  }
}

export function workflowMergeWorkKinds(): WorkflowWorkItemKind[] {
  return ["merge", "manual-hold"];
}
