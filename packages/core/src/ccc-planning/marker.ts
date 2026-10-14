import type { Task } from "../types/task-core.js";

/*
FNXC:CccPlanningMarker 2026-10-14-09:05:
A planning task is held by a request-to-code run when, and only when, its lineage id is a run id (`ccc-plan:` plus 24 lowercase hex), it is paused, and the pause is not the operator's own (CONTRACT-v2 section 2.5, D37). Every custody guard in core and engine asks this one predicate, so a task with a look-alike lineage (a `ccc-prd:` import lineage, a run id with an extra character) or one the operator paused by hand is never treated as run-held. A task row without `userPaused` counts as not user-paused, because older rows never carried the field.
*/

export const CCC_PLANNING_RUN_ID_PATTERN = /^ccc-plan:[0-9a-f]{24}$/u;

export function isCccPlanningRunId(value: unknown): value is string {
  return typeof value === "string" && CCC_PLANNING_RUN_ID_PATTERN.test(value);
}

export function isCccPlanningCustodyTask(task: Pick<Task, "lineageId" | "paused" | "userPaused">): boolean {
  return isCccPlanningRunId(task.lineageId) && task.paused === true && task.userPaused !== true;
}
