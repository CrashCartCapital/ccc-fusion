import { createHash } from "node:crypto";
import {
  computeCccPrdCampaignDriftStopConfirmation,
  markCccPrdImportStopped,
  type AsyncDataLayer,
  type CccPrdCampaignDriftStopPlan,
  type TaskStore,
  type WorkflowWorkItemState,
} from "@fusion/core";
import { CCC_CAMPAIGN_OPERATOR_STOPPED_PREFIX } from "./ccc-campaign-operator-control.js";

/**
 * Terminally closing a campaign whose persisted custody no longer reconstructs.
 *
 * The ordinary operator stop needs a full product status, and product status
 * rebuilds campaign custody, so a campaign with a drifted manifest cannot reach
 * any control at all. This path takes the drift plan instead, which is built
 * from import-row columns alone.
 *
 * What it deliberately does not do: it never removes or relocates a worktree,
 * never deletes a branch, never resolves or expires an approval, and never
 * closes an execution authorization. A drifted campaign's evidence is the only
 * record of what it did, and closing it must not consume any of that. Every
 * unresolved effect is reported as preserved.
 */

const DRIFT_STOP_ACTOR = "ccc-fusion-local-operator";

export class CccCampaignDriftStopError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly safeState?: Readonly<{
      workItemId: string;
      workItemState: string;
    }>,
  ) {
    super(message);
    this.name = "CccCampaignDriftStopError";
  }
}

export type CccCampaignDriftStopResult = Readonly<{
  workItemId: string;
  workItemState: "cancelled";
  taskIds: readonly string[];
  driftReason: string;
  stoppedReason: string;
  unresolvedEffectsPreserved: boolean;
}>;

export type ApplyCccCampaignDriftStopInput = Readonly<{
  plan: CccPrdCampaignDriftStopPlan;
  reason: string;
  confirmation: string;
  store: TaskStore;
  layer: AsyncDataLayer;
}>;

export function computeCccCampaignDriftStopConfirmation(
  plan: CccPrdCampaignDriftStopPlan,
): string {
  return computeCccPrdCampaignDriftStopConfirmation(plan);
}

function exactDigest(left: string, right: string): boolean {
  const normalizedLeft = left.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalizedLeft)) return false;
  if (normalizedLeft.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < normalizedLeft.length; index += 1) {
    difference |= normalizedLeft.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

/**
 * The closure sentence written to both the workflow work item and the import
 * row. It carries the operator's own reason and the verbatim custody refusal,
 * so the terminal state explains itself without any custody rebuild.
 */
export function cccCampaignDriftStopClosure(
  plan: CccPrdCampaignDriftStopPlan,
  reason: string,
): string {
  return `${reason.trim()} | custody-drift: ${plan.driftReason}`;
}

export async function applyCccCampaignDriftStop(
  input: ApplyCccCampaignDriftStopInput,
): Promise<CccCampaignDriftStopResult> {
  const reason = input.reason.trim();
  if (reason.length < 10) {
    throw new CccCampaignDriftStopError(
      "CCC_CAMPAIGN_DRIFT_STOP_REASON_REFUSED",
      "Closing a drifted campaign requires an operator reason of at least 10 characters.",
    );
  }
  const expected = computeCccCampaignDriftStopConfirmation(input.plan);
  if (!exactDigest(input.confirmation, expected)) {
    throw new CccCampaignDriftStopError(
      "CCC_CAMPAIGN_DRIFT_STOP_CONFIRMATION_REFUSED",
      "Drifted-campaign stop confirmation is stale or does not match the current campaign plan.",
    );
  }

  const closure = cccCampaignDriftStopClosure(input.plan, reason);
  const closureDigest = createHash("sha256").update(closure, "utf8").digest("hex");
  const stoppedMarker = `${CCC_CAMPAIGN_OPERATOR_STOPPED_PREFIX}${closureDigest}`;
  const workItem = input.plan.workItem;

  await input.store.transitionWorkflowWorkItem(workItem.id, "cancelled", {
    expectedState: workItem.state as WorkflowWorkItemState,
    expectedAttempt: workItem.attempt,
    expectedLeaseOwner: null,
    attempt: workItem.attempt,
    retryAfter: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    lastError: stoppedMarker,
    blockedReason: `${stoppedMarker} ${closure}`,
  });

  let taskPauseError: unknown = null;
  for (const taskId of input.plan.taskIds) {
    try {
      await input.store.pauseTask(taskId, true, undefined, {
        pausedByAgentId: DRIFT_STOP_ACTOR,
        pausedReason: stoppedMarker,
      });
    } catch (error) {
      taskPauseError ??= error;
    }
  }

  /*
   * Written last and unconditionally. This is the only write that stops the
   * campaign re-projecting its task directories, so a task-pause failure must
   * not leave the import active and projecting.
   */
  await markCccPrdImportStopped({
    layer: input.layer,
    idempotencyKey: input.plan.idempotencyKey,
    stoppedReason: `${stoppedMarker} ${closure}`,
  });

  if (taskPauseError !== null) {
    throw new CccCampaignDriftStopError(
      "CCC_CAMPAIGN_DRIFT_STOP_TASK_STOP_INCOMPLETE",
      `Campaign workflow is terminally stopped and the import will no longer re-project, but one or more task pause projections failed: ${taskPauseError instanceof Error ? taskPauseError.message : String(taskPauseError)}`,
      { workItemId: workItem.id, workItemState: "cancelled" },
    );
  }

  return {
    workItemId: workItem.id,
    workItemState: "cancelled",
    taskIds: input.plan.taskIds,
    driftReason: input.plan.driftReason,
    stoppedReason: closure,
    // Nothing was disposed, resolved, or consumed, so everything the campaign
    // left behind is still there.
    unresolvedEffectsPreserved: true,
  };
}
