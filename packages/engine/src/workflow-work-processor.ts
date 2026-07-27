import type { Settings, TaskDetail, WorkflowWorkItem, WorkflowWorkItemKind, WorkflowWorkItemState } from "@fusion/core";
import { claimDueWorkflowWorkItem, type ExactWorkflowWorkCandidate, type WorkflowWorkSchedulerStore } from "./workflow-work-scheduler.js";
import { WorkflowTaskRuntime, type WorkflowTaskRuntimeResult } from "./workflow-task-runtime.js";
import { ensureWorkflowCompletionSummary } from "./workflow-completion-summary.js";
import { isImportedCccCampaignWorkItem } from "./ccc-campaign-routing.js";

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
}

type WorkflowWorkProcessorStore = WorkflowWorkSchedulerStore & {
  transitionWorkflowWorkItem?: (
    id: string,
    state: WorkflowWorkItemState,
    patch?: { now?: string; expectedState?: WorkflowWorkItemState; expectedLeaseOwner?: string | null; expectedAttempt?: number; attempt?: number; lastError?: string | null; leaseOwner?: string | null; leaseExpiresAt?: string | null },
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

  let runtimeResult: WorkflowTaskRuntimeResult;
  const abortController = new AbortController();
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
    const getCampaignContext = store.getCccCampaignContextForTask;
    if (campaignRequired && typeof getCampaignContext !== "function") {
      throw new Error("workflow campaign custody lookup is unwired");
    }
    const campaignContext = typeof getCampaignContext === "function"
      ? await getCampaignContext.call(store, dispatch.taskId)
      : null;
    if (campaignRequired && !campaignContext) {
      throw new Error(importedCampaignWorkItem
        ? "workflow imported campaign custody is missing"
        : "workflow required campaign custody is missing");
    }
    if (campaignRequired || campaignContext) {
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
      if (typeof store.renewWorkflowWorkItemLease !== "function") {
        throw new Error("workflow campaign processor requires renewWorkflowWorkItemLease");
      }
      workflowLeaseRenewInterval = startWorkflowLeaseRenewal(store, dispatch.workItem, opts, abortController);
      runtimeResult = await runCampaignWorkflowWorkItem(store, runtime, settings, opts, dispatch.workItem, abortController.signal);
    } else {
      runtimeResult = await runtime.runWorkItem(dispatch.workItem, settings);
    }
  } catch (err) {
    if (err instanceof WorkflowCampaignTerminalTransitionError) {
      throw err.cause instanceof Error ? err.cause : err;
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
      throw new AggregateError(
        [err, terminalPersistenceError],
        "workflow work runtime and terminal persistence both failed",
      );
    }
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
  }
  return {
    claimed: true,
    workItemId: dispatch.workItem.id,
    taskId: dispatch.taskId,
    runtime: runtimeResult,
  };
}

async function runCampaignWorkflowWorkItem(
  store: WorkflowWorkProcessorStore,
  runtime: WorkflowTaskRuntime,
  settings: (Pick<Settings, "experimentalFeatures"> & Partial<Settings>) | undefined,
  opts: WorkflowWorkProcessorOptions,
  workItem: WorkflowWorkItem,
  signal: AbortSignal,
): Promise<WorkflowTaskRuntimeResult> {
  if (!store.getTask) {
    throw new Error("workflow campaign processor requires getTask");
  }
  const task = await store.getTask(workItem.taskId) as TaskDetail | undefined;
  if (!task) {
    throw new Error(`workflow campaign task missing:${workItem.taskId}`);
  }
  const runtimeResult = await runtime.run(task, settings, {
    signal,
    workItemFence: {
      workItemId: workItem.id,
      leaseOwner: opts.leaseOwner,
      attempt: workItem.attempt,
      runId: workItem.runId,
      eventTimestamp: workItem.updatedAt,
    },
    deferCompletionSummary: true,
  });
  if (signal.aborted && runtimeResult.disposition === "completed") {
    return await transitionCampaignTerminal(store, opts, workItem, {
      disposition: "failed",
      outcome: "failure",
      visitedNodeIds: runtimeResult.visitedNodeIds,
      context: runtimeResult.context,
      reason: "workflow-aborted",
    });
  }

  return await transitionCampaignTerminal(store, opts, workItem, runtimeResult);
}

async function transitionCampaignTerminal(
  store: WorkflowWorkProcessorStore,
  opts: WorkflowWorkProcessorOptions,
  workItem: WorkflowWorkItem,
  runtimeResult: WorkflowTaskRuntimeResult,
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
    });
  } catch (err) {
    const cancelled = await cancelledWorkItemAfterCasFailure(store, workItem.id);
    if (cancelled) {
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

  if (terminalState === "succeeded" && store.getTask) {
    const latestTask = await store.getTask(workItem.taskId) as TaskDetail | undefined;
    if (latestTask) {
      await ensureWorkflowCompletionSummary(store, latestTask, {
        reason: "workflow-work-item:campaign",
        workflowId: String(runtimeResult.context["workflow:id"] ?? "unknown"),
        runId: workItem.runId,
      }).catch(() => undefined);
    }
  }
  return runtimeResult;
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
    void Promise.resolve(renewWorkflowWorkItemLease(workItem.id, opts.leaseOwner, workItem.attempt, {
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
