import { isCccPlanningCustodyTask, type Task, type WorkflowWorkItem } from "@fusion/core";

/**
 * Imported CCC PRD projection uses this exact lineage shape. It is a suspicion
 * marker only; persisted campaign custody remains the authoritative binding.
 */
export function isImportedCccCampaignTask(task: Pick<Task, "lineageId">): boolean {
  return typeof task.lineageId === "string"
    && /^ccc-prd:[0-9a-f]{24}:.+$/u.test(task.lineageId);
}

/**
 * Unified task-profile detection for campaign safety boundaries.
 *
 * Imported product tasks are identified by compiler-owned lineage. The custom
 * field remains supported for pre-product campaign tasks and focused fixtures.
 */
export function isCccCampaignTask(
  task: Pick<Task, "customFields" | "lineageId">,
): boolean {
  return task.customFields?.cccFusionProfile === "ccc-fusion"
    || isImportedCccCampaignTask(task);
}

/**
 * FNXC:CccPlanningCustody 2026-10-14-13:41:
 * Guard-only custody predicate (D22, challenge 24): a campaign task or a held request-to-code planning task (the
 * K1 marker). Use it only where a mutation must be refused. `isCccCampaignTask` above stays exactly as it was,
 * because widening it would also turn on the campaign durable frontier, permanent-failure handling and executor
 * classification for planning tasks.
 */
export function isCccCustodyGuardedTask(
  task: Pick<Task, "customFields" | "lineageId" | "paused" | "userPaused">,
): boolean {
  return isCccCampaignTask(task) || isCccPlanningCustodyTask(task);
}

/** The imported workflow-item shape is the native processor admission marker. */
export function isImportedCccCampaignWorkItem(workItem: WorkflowWorkItem): boolean {
  return workItem.kind === "task"
    && typeof workItem.stableWorkflowRunId === "string"
    && workItem.stableWorkflowRunId === workItem.runId
    && workItem.runId.startsWith("ccc-prd:")
    && typeof workItem.irHash === "string"
    && /^[0-9a-f]{64}$/u.test(workItem.irHash);
}
