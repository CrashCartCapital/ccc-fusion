import { createHash } from "node:crypto";
import {
  canonicalCccPrdJson,
  type CccPrdProductStatus,
  type Task,
  type WorkflowWorkItem,
  type WorkflowWorkItemState,
  type WorkflowWorkItemTransitionPatch,
} from "@fusion/core";

export const CCC_CAMPAIGN_OPERATOR_PAUSED_REASON =
  "ccc-operator:campaign-paused";
export const CCC_CAMPAIGN_OPERATOR_STOPPED_PREFIX =
  "ccc-operator:campaign-stopped:";

export type CccCampaignOperatorControlAction = "pause" | "resume" | "stop";

type OperatorControlStore = Readonly<{
  transitionWorkflowWorkItem(
    id: string,
    state: WorkflowWorkItemState,
    patch: WorkflowWorkItemTransitionPatch,
  ): Promise<WorkflowWorkItem | unknown>;
  pauseTask(
    id: string,
    paused: boolean,
    runContext?: undefined,
    agentOptions?: {
      pausedByAgentId?: string;
      pausedReason?: string;
    },
  ): Promise<Task | unknown>;
}>;

export type CccCampaignOperatorControlDescriptor = Readonly<{
  action: CccCampaignOperatorControlAction;
  allowed: boolean;
  reason: string;
  consequence: string;
  recovery: string;
  approvalExpiresAt: string | null;
  confirmation: string | null;
}>;

export type ApplyCccCampaignOperatorControlInput = Readonly<{
  action: CccCampaignOperatorControlAction;
  status: CccPrdProductStatus;
  store: OperatorControlStore;
  reason?: string;
}>;

export type CccCampaignOperatorControlResult = Readonly<{
  action: CccCampaignOperatorControlAction;
  workItemId: string;
  workItemState: Extract<
    WorkflowWorkItemState,
    "held" | "runnable" | "cancelled"
  >;
  taskIds: readonly string[];
  unresolvedEffectsPreserved: boolean;
}>;

export class CccCampaignOperatorControlError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly safeState?: Readonly<{
      workItemId: string;
      workItemState: string;
    }>,
  ) {
    super(message);
    this.name = "CccCampaignOperatorControlError";
  }
}

type ExactControlContext = Readonly<{
  workItem: CccPrdProductStatus["workItems"][number];
  taskIds: readonly string[];
}>;

function exactControlContext(
  status: CccPrdProductStatus,
): ExactControlContext {
  if (
    status.schema !== "ccc-prd.product-status.v1"
    || status.import.state !== "active"
    || status.import.runnable !== true
  ) {
    throw new CccCampaignOperatorControlError(
      "CCC_CAMPAIGN_OPERATOR_CONTROL_IMPORT_REFUSED",
      "Campaign controls require one active runnable product import.",
    );
  }
  if (status.workItems.length !== 1) {
    throw new CccCampaignOperatorControlError(
      "CCC_CAMPAIGN_OPERATOR_CONTROL_WORK_ITEM_AMBIGUOUS",
      `Campaign controls require exactly one imported workflow work item; found ${status.workItems.length}.`,
    );
  }
  const workItem = status.workItems[0]!;
  const expectedRunId = `ccc-prd:${status.import.importId}`;
  if (
    workItem.kind !== "task"
    || workItem.runId !== expectedRunId
    || workItem.stableWorkflowRunId !== expectedRunId
    || !Number.isSafeInteger(workItem.attempt)
    || workItem.attempt < 0
  ) {
    throw new CccCampaignOperatorControlError(
      "CCC_CAMPAIGN_OPERATOR_CONTROL_CUSTODY_REFUSED",
      `Workflow work item ${workItem.id} does not match exact imported campaign custody.`,
    );
  }
  if (
    status.tasks.length === 0
    || status.tasks.some((task) =>
      !task.present
      || task.nativeTaskId.length === 0
      || task.semanticTaskId.length === 0)
  ) {
    throw new CccCampaignOperatorControlError(
      "CCC_CAMPAIGN_OPERATOR_CONTROL_TASK_CUSTODY_REFUSED",
      "Campaign controls require every imported native task and semantic route to be present.",
    );
  }
  const taskIds = status.tasks
    .map(({ nativeTaskId }) => nativeTaskId)
    .sort();
  if (new Set(taskIds).size !== taskIds.length) {
    throw new CccCampaignOperatorControlError(
      "CCC_CAMPAIGN_OPERATOR_CONTROL_TASK_CUSTODY_REFUSED",
      "Campaign controls refuse duplicate imported native task identities.",
    );
  }
  return { workItem, taskIds };
}

function approvalExpiry(status: CccPrdProductStatus): string | null {
  const expiries = status.approvals
    .filter((approval) =>
      approval.status === "issued" || approval.status === "claimed")
    .map((approval) => approval.campaign.expiresAt)
    .sort();
  return expiries[0] ?? null;
}

function controlDisposition(
  status: CccPrdProductStatus,
  action: CccCampaignOperatorControlAction,
): Readonly<{ allowed: boolean; reason: string }> {
  let context: ExactControlContext;
  try {
    context = exactControlContext(status);
  } catch (error) {
    return {
      allowed: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  const { workItem } = context;
  if (
    workItem.leaseOwner !== null
    || workItem.leaseExpiresAt !== null
    || workItem.state === "running"
  ) {
    return {
      allowed: false,
      reason:
        `Workflow work item ${workItem.id} still has runtime lease custody; wait for the next unleased safe boundary.`,
    };
  }
  if (action === "pause") {
    return workItem.state === "runnable" || workItem.state === "retrying"
      ? {
          allowed: true,
          reason: "Campaign is unleased and can be parked at this safe boundary.",
        }
      : {
          allowed: false,
          reason: `Campaign cannot pause from workflow state ${workItem.state}.`,
        };
  }
  if (action === "resume") {
    return workItem.state === "held"
      && workItem.blockedReason === CCC_CAMPAIGN_OPERATOR_PAUSED_REASON
      ? {
          allowed: true,
          reason: "Campaign is held by the exact operator pause receipt.",
        }
      : {
          allowed: false,
          reason:
            `Campaign cannot resume from workflow state ${workItem.state} without the exact operator pause receipt.`,
        };
  }
  return (
    workItem.state === "runnable"
    || workItem.state === "retrying"
    || workItem.state === "held"
    || workItem.state === "manual-required"
  )
    ? {
        allowed: true,
        reason:
          "Campaign is unleased and can be terminally stopped without deleting worktrees or receipts.",
      }
    : {
        allowed: false,
        reason: `Campaign cannot stop from terminal workflow state ${workItem.state}.`,
      };
}

function confirmationIdentity(
  status: CccPrdProductStatus,
  action: CccCampaignOperatorControlAction,
): Record<string, unknown> {
  const { workItem, taskIds } = exactControlContext(status);
  return {
    schema: "ccc-campaign.operator-control-confirmation.v1",
    action,
    projectId: status.projectId,
    import: {
      importId: status.import.importId,
      idempotencyKey: status.import.idempotencyKey,
      packetHash: status.import.packetHash,
      sidecarHash: status.import.sidecarHash,
      bundleHash: status.import.bundleHash,
      targetRepository: status.import.targetRepository,
      targetBase: status.import.targetBase,
      state: status.import.state,
      runnable: status.import.runnable,
    },
    workItem: {
      id: workItem.id,
      runId: workItem.runId,
      stableWorkflowRunId: workItem.stableWorkflowRunId,
      taskId: workItem.taskId,
      state: workItem.state,
      attempt: workItem.attempt,
      leaseOwner: workItem.leaseOwner,
      leaseExpiresAt: workItem.leaseExpiresAt,
      lastError: workItem.lastError,
      blockedReason: workItem.blockedReason,
    },
    taskIds,
    proofAttempts: status.proofs
      .flatMap(({ attempts }) => attempts)
      .map(({ attemptKey, state }) => ({ attemptKey, state }))
      .sort((left, right) => left.attemptKey.localeCompare(right.attemptKey)),
    providerAttempts: status.providerAttempts
      .map(({ attemptKey, state }) => ({ attemptKey, state }))
      .sort((left, right) => left.attemptKey.localeCompare(right.attemptKey)),
    approvals: status.approvals
      .map(({ id, status: approvalStatus, actionId, taskId, campaign }) => ({
        id,
        status: approvalStatus,
        actionId,
        taskId,
        expiresAt: campaign.expiresAt,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
}

export function computeCccCampaignOperatorControlConfirmation(
  status: CccPrdProductStatus,
  action: CccCampaignOperatorControlAction,
): string {
  return createHash("sha256")
    .update(canonicalCccPrdJson(confirmationIdentity(status, action)), "utf8")
    .digest("hex");
}

export function describeCccCampaignOperatorControls(
  status: CccPrdProductStatus,
): readonly CccCampaignOperatorControlDescriptor[] {
  const expiresAt = approvalExpiry(status);
  return (["pause", "resume", "stop"] as const).map((action) => {
    const disposition = controlDisposition(status, action);
    const shared = {
      action,
      allowed: disposition.allowed,
      reason: disposition.reason,
      approvalExpiresAt: expiresAt,
      confirmation: disposition.allowed
        ? computeCccCampaignOperatorControlConfirmation(status, action)
        : null,
    };
    if (action === "pause") {
      return {
        ...shared,
        consequence:
          "Parks the unleased workflow at its current safe boundary and pauses every imported task.",
        recovery:
          "Use resume with a fresh status confirmation. Worktrees, proof receipts, approvals, and Git state are preserved.",
      };
    }
    if (action === "resume") {
      return {
        ...shared,
        consequence:
          "Unpauses imported tasks, then makes the operator-held workflow runnable.",
        recovery:
          "Pause again at the next unleased safe boundary. Existing receipts and attempts are reused.",
      };
    }
    return {
      ...shared,
      consequence:
        "Terminally cancels this campaign workflow. It does not delete worktrees, consume merge approval, or claim uncertain effects were settled.",
      recovery:
        "There is no resume after stop. Start a new reviewed import; inspect preserved worktrees and receipts before cleanup.",
    };
  });
}

function assertAllowed(
  status: CccPrdProductStatus,
  action: CccCampaignOperatorControlAction,
): ExactControlContext {
  const context = exactControlContext(status);
  const disposition = controlDisposition(status, action);
  if (!disposition.allowed) {
    const leased =
      context.workItem.leaseOwner !== null
      || context.workItem.leaseExpiresAt !== null
      || context.workItem.state === "running";
    throw new CccCampaignOperatorControlError(
      leased
        ? "CCC_CAMPAIGN_OPERATOR_CONTROL_LEASED"
        : "CCC_CAMPAIGN_OPERATOR_CONTROL_STATE_REFUSED",
      disposition.reason,
    );
  }
  return context;
}

function stopReason(reason: string | undefined): string {
  const canonical = reason?.trim();
  if (
    !canonical
    || canonical !== reason
    || canonical.length < 10
    || canonical.length > 1_000
  ) {
    throw new CccCampaignOperatorControlError(
      "CCC_CAMPAIGN_OPERATOR_STOP_REASON_REQUIRED",
      "Stopping a campaign requires a 10-1000 character canonical operator reason.",
    );
  }
  return canonical;
}

function unresolvedEffects(status: CccPrdProductStatus): boolean {
  return status.proofs.some(({ attempts }) =>
    attempts.some(({ state }) => state === "dispatched_unknown"))
    || status.providerAttempts.some(
      ({ state }) => state === "dispatched_unknown",
    )
    || status.workItems.some(({ state, lastError }) =>
      state === "manual-required"
      && lastError !== null
      && !lastError.includes("APPROVAL_REQUIRED"));
}

async function pauseTasks(
  store: OperatorControlStore,
  taskIds: readonly string[],
  pausedReason: string,
): Promise<void> {
  for (const taskId of taskIds) {
    await store.pauseTask(taskId, true, undefined, {
      pausedByAgentId: "ccc-fusion-local-operator",
      pausedReason,
    });
  }
}

export async function applyCccCampaignOperatorControl(
  input: ApplyCccCampaignOperatorControlInput,
): Promise<CccCampaignOperatorControlResult> {
  const { workItem, taskIds } = assertAllowed(input.status, input.action);
  const commonPatch = {
    expectedState: workItem.state as WorkflowWorkItemState,
    expectedAttempt: workItem.attempt,
    expectedLeaseOwner: null,
    attempt: workItem.attempt,
    retryAfter: null,
    leaseOwner: null,
    leaseExpiresAt: null,
  };
  if (input.action === "pause") {
    await input.store.transitionWorkflowWorkItem(workItem.id, "held", {
      ...commonPatch,
      lastError: workItem.lastError,
      blockedReason: CCC_CAMPAIGN_OPERATOR_PAUSED_REASON,
    });
    try {
      await pauseTasks(
        input.store,
        taskIds,
        CCC_CAMPAIGN_OPERATOR_PAUSED_REASON,
      );
    } catch (error) {
      throw new CccCampaignOperatorControlError(
        "CCC_CAMPAIGN_OPERATOR_CONTROL_TASK_PAUSE_INCOMPLETE",
        `Campaign workflow is safely held, but one or more task pause projections failed: ${error instanceof Error ? error.message : String(error)}`,
        { workItemId: workItem.id, workItemState: "held" },
      );
    }
    return {
      action: input.action,
      workItemId: workItem.id,
      workItemState: "held",
      taskIds,
      unresolvedEffectsPreserved: unresolvedEffects(input.status),
    };
  }
  if (input.action === "resume") {
    const unpaused: string[] = [];
    try {
      for (const taskId of taskIds) {
        await input.store.pauseTask(taskId, false);
        unpaused.push(taskId);
      }
      await input.store.transitionWorkflowWorkItem(workItem.id, "runnable", {
        ...commonPatch,
        lastError: null,
        blockedReason: null,
      });
    } catch (error) {
      await Promise.allSettled(unpaused.map((taskId) =>
        input.store.pauseTask(taskId, true, undefined, {
          pausedByAgentId: "ccc-fusion-local-operator",
          pausedReason: CCC_CAMPAIGN_OPERATOR_PAUSED_REASON,
        })));
      throw new CccCampaignOperatorControlError(
        "CCC_CAMPAIGN_OPERATOR_CONTROL_RESUME_INCOMPLETE",
        `Campaign remains safely held because resume did not complete: ${error instanceof Error ? error.message : String(error)}`,
        { workItemId: workItem.id, workItemState: "held" },
      );
    }
    return {
      action: input.action,
      workItemId: workItem.id,
      workItemState: "runnable",
      taskIds,
      unresolvedEffectsPreserved: unresolvedEffects(input.status),
    };
  }
  const reason = stopReason(input.reason);
  const reasonDigest = createHash("sha256").update(reason, "utf8").digest("hex");
  const stoppedMarker = `${CCC_CAMPAIGN_OPERATOR_STOPPED_PREFIX}${reasonDigest}`;
  await input.store.transitionWorkflowWorkItem(workItem.id, "cancelled", {
    ...commonPatch,
    lastError: stoppedMarker,
    blockedReason: `${stoppedMarker} ${reason}`,
  });
  try {
    await pauseTasks(input.store, taskIds, stoppedMarker);
  } catch (error) {
    throw new CccCampaignOperatorControlError(
      "CCC_CAMPAIGN_OPERATOR_CONTROL_TASK_STOP_INCOMPLETE",
      `Campaign workflow is terminally stopped, but one or more task pause projections failed: ${error instanceof Error ? error.message : String(error)}`,
      { workItemId: workItem.id, workItemState: "cancelled" },
    );
  }
  return {
    action: input.action,
    workItemId: workItem.id,
    workItemState: "cancelled",
    taskIds,
    unresolvedEffectsPreserved: unresolvedEffects(input.status),
  };
}
