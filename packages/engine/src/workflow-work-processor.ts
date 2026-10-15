import {
  CCC_CAMPAIGN_EXECUTION_AUTHORIZATION_MODE_SEALED_BUNDLE_V1,
  closeUnopenedCccCampaignExecutionAuthorizationMembers,
  getCccCampaignExecutionAuthorizationForImport,
  isTaskMoveDisposalActive,
  registerTaskMoveDisposer,
  type CccPlanningRunCustody,
  type CccPlanningRunState,
  type Settings,
  type TaskDetail,
  type TaskStore,
  type WorkflowWorkItem,
  type WorkflowWorkItemKind,
  type WorkflowWorkItemState,
} from "@fusion/core";
import { claimDueWorkflowWorkItem, type ExactWorkflowWorkCandidate, type WorkflowWorkSchedulerStore } from "./workflow-work-scheduler.js";
import {
  CCC_PLANNING_HOLD_CONTEXT_KEY,
  WorkflowTaskRuntime,
  type CccPlanningHoldContext,
  type WorkflowTaskRuntimeResult,
  type WorkflowWorkCustodyKind,
} from "./workflow-task-runtime.js";
import {
  concludeCccPlanningRunFailure,
  createCccPlanningDescendantRegistry,
  settleCccPlanningRun,
  type CccPlanningFailureConclusion,
} from "./ccc-planning/controller.js";
import { cccPlanningCancellationCompleter, cccPlanningHostLedger, cccPlanningRunLookup } from "./ccc-planning/ports.js";
import { ensureWorkflowCompletionSummary } from "./workflow-completion-summary.js";
import { isImportedCccCampaignWorkItem } from "./ccc-campaign-routing.js";
import { CCC_CAMPAIGN_LIVE_EXECUTION_APPROVAL_REQUIRED_REASON } from "./ccc-campaign-product-control.js";
import { CCC_RETRY_CLASSIFICATION_CONTEXT_KEY } from "./workflow-graph-executor.js";

/** W3 repair 1: the code a startable planning run fails with when the host concludes a failure that is not a hold. */
const CCC_PLANNING_INTERNAL_ERROR_CODE = "CCC_PLANNING_INTERNAL_ERROR";

export interface WorkflowWorkProcessorOptions {
  leaseOwner: string;
  leaseDurationMs: number;
  now?: string;
  kinds?: WorkflowWorkItemKind[];
  exactCandidate?: ExactWorkflowWorkCandidate;
  campaignRequired?: boolean;
  /** Card H1: "campaign" is the campaign custody path (`campaignRequired: true` aliases it); "planning" the planning run. */
  custody?: WorkflowWorkCustodyKind;
}

export type { WorkflowWorkCustodyKind } from "./workflow-task-runtime.js";

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
  getCccPlanningRunForTask?: (taskId: string) => Promise<CccPlanningRunCustody | null>;
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
  /*
  FNXC:CccPlanningHost 2026-10-14-22:17:
  D2: `campaignRequired: true` is an alias for custody "campaign"; "planning" is the request-to-code planning run. The
  two cannot be asked for at once, and that is refused before any lease is consumed.
  */
  if (opts.custody === "planning" && opts.campaignRequired === true) {
    throw new Error("workflow work processor custody \"planning\" cannot also require campaign custody");
  }
  const custody: WorkflowWorkCustodyKind | undefined = opts.custody ?? (opts.campaignRequired === true ? "campaign" : undefined);
  /* FNXC:MissionSymbolAdmission 2026-07-31-12:00: await the async symbol-lock admission before runtime may consume the workflow work lease. */
  const dispatch = await claimDueWorkflowWorkItem(store, {
    now: opts.now,
    leaseOwner: opts.leaseOwner,
    leaseDurationMs: opts.leaseDurationMs,
    kinds: opts.kinds,
    exactCandidate: opts.exactCandidate,
    bypassMissionSymbolAdmission: custody !== undefined,
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
    if (custody === "planning") {
      runtimeResult = await runPlanningWorkflowWorkItem(store, runtime, settings, opts, dispatch.workItem, abortController,
        diagnostics, (current) => { dispatch.workItem = current; });
      return claimedProcessorResult(dispatch.workItem, runtimeResult, diagnostics);
    }
    const importedCampaignWorkItem = isImportedCccCampaignWorkItem(dispatch.workItem);
    const campaignRequired = custody === "campaign" || importedCampaignWorkItem;
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
    /*
    FNXC:CccPlanningHost 2026-10-15-00:04:
    W3 repair 2 (E14 item 1), defence in depth. runPlanningWorkflowWorkItem is total, so a planning claim should never
    get here. If one ever does, its item goes back to `runnable` for the next stage start (the L1-unreachable rule),
    never to `failed`: a failed item behind a run that could still run strands the run, and neither the campaign
    cancellation branch nor the ordinary failure below applies to planning custody.
    */
    if (custody === "planning") {
      runtimeResult = await releasePlanningClaimAfterError(store, opts, dispatch.workItem, err, diagnostics);
      return claimedProcessorResult(dispatch.workItem, runtimeResult, diagnostics);
    }
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
    /*
    FNXC:CCCHardCancellation 2026-09-07:
    Resolve campaignCompletion before task-log diagnostics. logEntry re-acquires
    the same task lock held by a user move while it awaits this disposer; an
    inline await deadlocks the move before Todo publication. Keep this ordered
    projection awaited after durable terminal state and authorization cleanup;
    it must not become void fire-and-forget.
    */
    for (const diagnostic of diagnostics) {
      await bestEffortWorkflowDiagnostic(store, dispatch.taskId, diagnostic);
    }
  }
  return claimedProcessorResult(dispatch.workItem, runtimeResult, diagnostics);
}

/**
 * FNXC:CccPlanningHost 2026-10-14-22:17:
 * Card H1 (D1, D3, D45). A planning item runs the whole K1 planning workflow under this one lease. The lease is
 * renewed like a campaign lease; losing it (or any abort) settles the run strictly as cancelAll, flush, release,
 * completeCancellation: registered descendants are cancelled, the runtime's own bookkeeping is awaited, the item goes
 * back to `runnable` for the existing acquire path, and L1 completes a pending cancellation if nothing still holds it.
 * A stage that parks the run (operator wait, blocked, unknown effect) holds the item without changing its attempt, so
 * L1's resume and answer paths can requeue it; a cancelling run releases the item to `held` before L1 completes the
 * cancellation, so a deferred completion never re-runs stages. Campaign custody, sealed authorization and campaign
 * summaries never apply here.
 *
 * FNXC:CccPlanningHost 2026-10-14-23:24:
 * W3 repair 1 (review findings 2, 4 and 5). The claim never ends with a failed or held item behind a run that could
 * still run. A failure that is not a hold (a runtime rejection, a host or ledger error, a stage handler that threw) is
 * concluded under the still-live fence first: a startable run moves to `failed` / CCC_PLANNING_INTERNAL_ERROR (its
 * pending pause or cancel wins instead), and only then does the item fail; a resting run holds the item. When L1
 * cannot be reached the item goes back to `runnable`, as on lease loss, so the next stage start runs its checks and
 * pending controls again. Every hold also asks L1 to complete a cancellation (D45): an operator cancel that lands after
 * the park and before the release is deferred live-lease by L1, and nothing else would finish it before a restart.
 *
 * FNXC:CccPlanningHost 2026-10-15-00:04:
 * W3 repair 2 (E14 items 1 and 2). The claim is total: no throw leaves this function for the shared catch, and the item
 * is never written `failed` behind a run that could still run. A run lookup that throws releases the item to
 * `runnable` (L1 unreachable, as RED 16b). Once the run is known, the attempt bump, the planning task read and a store
 * that cannot read the task are concluded on the run under the still-live lease. Every item write is quiet: a `held`,
 * `failed` or `succeeded` write that fails leaves the item leased, and the existing acquire path reclaims it after the
 * lease expires, so the next stage start re-holds or re-concludes it. Anything else releases the item to `runnable`.
 * On completion the run is read back while the fence is still live (the `succeeded` write ends it): a run still
 * admitted or running is concluded, because nothing would move it again behind a succeeded item; otherwise the item
 * succeeds and L1 is asked to complete a cancellation that landed before the write (D45), as every hold already does.
 */
async function runPlanningWorkflowWorkItem(
  store: WorkflowWorkProcessorStore,
  runtime: WorkflowTaskRuntime,
  settings: (Pick<Settings, "experimentalFeatures"> & Partial<Settings>) | undefined,
  opts: WorkflowWorkProcessorOptions,
  claimed: WorkflowWorkItem,
  abortController: AbortController,
  diagnostics: string[],
  track: (workItem: WorkflowWorkItem) => void,
): Promise<WorkflowTaskRuntimeResult> {
  let workItem = claimed;
  const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
  const failed = (reason: string): WorkflowTaskRuntimeResult => ({
    disposition: "failed", outcome: "failure", visitedNodeIds: [], context: {}, reason,
  });
  const casPatch = () => ({
    now: opts.now,
    expectedState: "running" as const,
    expectedLeaseOwner: opts.leaseOwner,
    expectedAttempt: workItem.attempt,
    attempt: workItem.attempt,
    leaseOwner: null,
    leaseExpiresAt: null,
  });
  /** Write the item under this claim's lease; a refused or failed write is left to the lease. True when written. */
  const releaseQuietly = async (state: WorkflowWorkItemState,
    patch: { lastError?: string | null; blockedReason?: string | null }): Promise<boolean> => {
    try {
      await store.transitionWorkflowWorkItem!(workItem.id, state, { ...casPatch(), ...patch });
      return true;
    } catch (error) {
      // The lease is gone, the item moved, or the write failed: the acquire path reclaims a still-leased item later.
      diagnostics.push(`ccc planning release to ${state} skipped: ${message(error)}`);
      return false;
    }
  };
  const completer = cccPlanningCancellationCompleter(store);
  /** D45: L1 completes a due cancellation; a failure is left to engine-start recovery. */
  const completeCancellationQuietly = async (): Promise<void> => {
    if (!completer) {
      diagnostics.push(`ccc planning cancellation completion is unwired for run ${workItem.runId}`);
      return;
    }
    try {
      await completer(workItem.runId);
    } catch (error) {
      diagnostics.push(`ccc planning cancellation completion deferred: ${message(error)}`);
    }
  };
  const descendants = createCccPlanningDescendantRegistry();
  const signal = abortController.signal;
  const settle = (release: () => Promise<boolean>, reason: Error, flush: () => Promise<void> = async () => undefined) =>
    settleCccPlanningRun({
      descendants,
      flush,
      release: async () => { await release(); },
      completeCancellation: completeCancellationQuietly,
      reason,
    });
  /** L1 cannot conclude the run on this claim: release the item so the next stage start runs its checks again. */
  const releaseUnconcluded = async (why: Error): Promise<WorkflowTaskRuntimeResult> => {
    await settle(() => releaseQuietly("runnable", { lastError: why.message }), why);
    return failed(why.message);
  };
  const failWorkItem = async (reason: string): Promise<WorkflowTaskRuntimeResult> => {
    await releaseQuietly("failed", { lastError: reason });
    return failed(reason);
  };
  const settleAbort = async (flush: () => Promise<void>, why?: Error): Promise<WorkflowTaskRuntimeResult> => {
    const reason = why ?? (signal.reason instanceof Error ? signal.reason : new Error("workflow-aborted"));
    await settle(() => releaseQuietly("runnable", { lastError: reason.message }), reason, flush);
    return failed(reason.message);
  };
  /** A held or cancelling run: hold the item, then let L1 complete a cancellation if one is due (D45). */
  const holdWorkItem = async (hold: CccPlanningHoldContext): Promise<void> => {
    const blockedReason = hold.disposition === "cancel"
      ? "ccc-planning:cancelling"
      : ["ccc-planning", hold.runState, hold.code, hold.decisionId]
        .filter((part): part is string => typeof part === "string" && part.length > 0)
        .join(":");
    await settle(
      () => releaseQuietly("held", { blockedReason, lastError: null }),
      new Error(hold.disposition === "cancel" ? "ccc-planning-cancelling" : `ccc-planning-held:${hold.runState}`),
    );
  };
  /** Conclude a failure that is not a hold before the work item moves (W3 repair 1). */
  const concludeFailure = async (base: WorkflowTaskRuntimeResult, reason: string): Promise<WorkflowTaskRuntimeResult> => {
    let conclusion: CccPlanningFailureConclusion;
    try {
      const ledger = cccPlanningHostLedger(store);
      if (!ledger) throw new Error("ccc planning ledger is unwired");
      conclusion = await concludeCccPlanningRunFailure({
        ledger,
        fence: {
          kind: "planning",
          workItemId: workItem.id,
          runId: workItem.runId,
          attempt: workItem.attempt,
          leaseOwner: opts.leaseOwner,
          originTaskId: workItem.taskId,
        },
        code: CCC_PLANNING_INTERNAL_ERROR_CODE,
      });
    } catch (error) {
      const released = await releaseUnconcluded(new Error(`${reason}; run not concluded: ${message(error)}`));
      return { ...base, disposition: "failed", outcome: "failure", reason: released.reason };
    }
    if (conclusion.kind === "ended") {
      await descendants.cancelAll(new Error("ccc-planning-workflow-ended"));
      await releaseQuietly("failed", { lastError: reason });
      return { ...base, disposition: "failed", outcome: "failure", reason };
    }
    const { hold } = conclusion;
    const concluded = {
      ...base,
      outcome: "failure" as const,
      context: { ...base.context, [CCC_PLANNING_HOLD_CONTEXT_KEY]: hold },
      reason: `${reason}; ccc-planning-${hold.disposition}:${hold.runState}${hold.code ? `:${hold.code}` : ""}`,
    };
    if (hold.disposition === "lease-lost") {
      await settleAbort(async () => undefined, new Error("ccc-planning-fence-stale"));
      return { ...concluded, disposition: "failed" };
    }
    await holdWorkItem(hold);
    return { ...concluded, disposition: hold.disposition === "cancel" ? "cancelled" : "manual-required" };
  };
  /** The workflow completed: conclude a run still admitted or running under the live fence, else succeed (D45). */
  const concludeCompletion = async (result: WorkflowTaskRuntimeResult): Promise<WorkflowTaskRuntimeResult> => {
    await descendants.cancelAll(new Error("ccc-planning-workflow-ended"));
    let runState: CccPlanningRunState;
    try {
      const ledger = cccPlanningHostLedger(store);
      if (!ledger) throw new Error("ccc planning ledger is unwired");
      runState = (await ledger.inspectCccPlanningRun(workItem.runId)).state;
    } catch (error) {
      return releaseUnconcluded(new Error(`workflow planning completed but its run was not read back: ${message(error)}`));
    }
    if (runState === "admitted" || runState === "running") {
      const reason = `workflow-planning-completed-with-run-${runState}`;
      return concludeFailure({ ...result, disposition: "failed", outcome: "failure", reason }, reason);
    }
    if (!(await releaseQuietly("succeeded", { lastError: null }))) {
      return { ...result, disposition: "failed", outcome: "failure", reason: "ccc-planning-success-not-recorded" };
    }
    await completeCancellationQuietly();
    return result;
  };

  let renewal: ReturnType<typeof setInterval> | undefined;
  try {
    const lookup = cccPlanningRunLookup(store);
    if (!lookup) return await failWorkItem("workflow planning custody lookup is unwired");
    let planningRun: CccPlanningRunCustody | null;
    try {
      planningRun = await lookup(workItem.taskId);
    } catch (error) {
      return await releaseUnconcluded(new Error(`workflow planning custody lookup failed: ${message(error)}`));
    }
    if (!planningRun || planningRun.runId !== workItem.runId || planningRun.planningTaskId !== workItem.taskId) {
      return await failWorkItem("workflow required planning custody is missing");
    }
    // From here the run behind this item is known: every failure is concluded on it under the still-live lease.
    if (typeof store.renewWorkflowWorkItemLease !== "function") {
      const reason = "workflow planning processor requires renewWorkflowWorkItemLease";
      return await concludeFailure(failed(reason), reason);
    }
    if (typeof store.getTask !== "function") {
      const reason = "workflow planning processor requires getTask";
      return await concludeFailure(failed(reason), reason);
    }
    if (workItem.attempt === 0) {
      try {
        workItem = await store.transitionWorkflowWorkItem!(workItem.id, "running", {
          now: opts.now,
          expectedState: "running",
          expectedLeaseOwner: opts.leaseOwner,
          expectedAttempt: 0,
          attempt: 1,
          leaseOwner: opts.leaseOwner,
        });
        track(workItem);
      } catch (error) {
        const reason = `workflow planning attempt bump failed: ${message(error)}`;
        return await concludeFailure(failed(reason), reason);
      }
    }
    renewal = startWorkflowLeaseRenewal(store, workItem, opts, abortController);
    let task: TaskDetail | undefined;
    try {
      task = await store.getTask(workItem.taskId) as TaskDetail | undefined;
    } catch (error) {
      if (signal.aborted) return await settleAbort(async () => undefined);
      const reason = `workflow planning task read failed: ${message(error)}`;
      return await concludeFailure(failed(reason), reason);
    }
    if (signal.aborted) return await settleAbort(async () => undefined);
    if (!task) return await concludeFailure(failed("workflow planning task is missing"), "workflow planning task is missing");
    const running = runtime.run(task, settings, {
      signal,
      custody: "planning",
      cccPlanningDescendants: descendants,
      deferCompletionSummary: true,
      workItemFence: {
        workItemId: workItem.id,
        leaseOwner: opts.leaseOwner,
        attempt: workItem.attempt,
        runId: workItem.runId,
        eventTimestamp: opts.now ?? new Date().toISOString(),
        ...(workItem.irHash ? { irHash: workItem.irHash } : {}),
      },
    });
    const settled = running.then(() => undefined, () => undefined);
    const aborted = new Promise<"aborted">((resolve) => {
      if (signal.aborted) resolve("aborted");
      else signal.addEventListener("abort", () => resolve("aborted"), { once: true });
    });
    const first = await Promise.race([
      running.then((result) => ({ result }), (error: unknown) => ({ error })),
      aborted,
    ]);
    if (first === "aborted") return await settleAbort(() => settled);
    if ("error" in first) {
      const reason = `workflow-work-item-runtime-error:${message(first.error)}`;
      return await concludeFailure(failed(reason), reason);
    }
    const result = first.result;
    if (signal.aborted) return await settleAbort(async () => undefined);
    const hold = result.context[CCC_PLANNING_HOLD_CONTEXT_KEY] as CccPlanningHoldContext | undefined;
    if (hold?.disposition === "lease-lost") {
      await settleAbort(async () => undefined, new Error("ccc-planning-fence-stale"));
      return result;
    }
    if (hold?.disposition === "cancel" || hold?.disposition === "held") {
      await holdWorkItem(hold);
      return result;
    }
    if (result.disposition === "completed") return await concludeCompletion(result);
    return await concludeFailure(result, result.reason ?? "workflow-planning-failed");
  } catch (error) {
    // Nothing above should throw; if something does, the item goes back for the next stage start, never `failed`.
    return await releaseUnconcluded(new Error(`workflow planning claim error: ${message(error)}`));
  } finally {
    if (renewal) clearInterval(renewal);
  }
}

/**
 * FNXC:CccPlanningHost 2026-10-15-00:04:
 * W3 repair 2 (E14 item 1): the shared catch's planning branch (defence in depth). The item goes back to `runnable`
 * under this claim's lease, never `failed`; a refused write leaves it to the lease and the acquire path.
 */
async function releasePlanningClaimAfterError(
  store: WorkflowWorkProcessorStore,
  opts: WorkflowWorkProcessorOptions,
  workItem: WorkflowWorkItem,
  error: unknown,
  diagnostics: string[],
): Promise<WorkflowTaskRuntimeResult> {
  const reason = `workflow-work-item-runtime-error:${error instanceof Error ? error.message : String(error)}`;
  try {
    await store.transitionWorkflowWorkItem!(workItem.id, "runnable", {
      now: opts.now,
      expectedState: "running",
      expectedLeaseOwner: opts.leaseOwner,
      expectedAttempt: workItem.attempt,
      attempt: workItem.attempt,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: reason,
    });
  } catch (releaseError) {
    diagnostics.push(`ccc planning release to runnable skipped: ${releaseError instanceof Error ? releaseError.message : String(releaseError)}`);
  }
  return { disposition: "failed", outcome: "failure", visitedNodeIds: [], context: {}, reason };
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
    }
  } catch (error) {
    const diagnostic =
      "[ccc-campaign:execution-authorization-closure-failed] "
      + `workItem=${workItem.id} authorization=${authorizationId} `
      + `terminal=${terminalState} error=${error instanceof Error ? error.message : String(error)}`;
    diagnostics.push(diagnostic);
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
