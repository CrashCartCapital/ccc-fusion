import { isCccPlanningCustodyTask } from "@fusion/core";
import { isCccCampaignTask } from "@fusion/engine";
import { ApiError, conflict } from "../api-error.js";
import type { ApiRoutesContext } from "./types.js";

/*
FNXC:CccCampaignTaskGuard 2026-08-11-00:00 (top-down audit, Lane A):
Imported CCC campaign tasks render as ordinary board cards, but their lifecycle
(pause receipts, digest-confirmed approvals, hard-cancel semantics) is owned by
the `fn prd` CLI — the dashboard's generic task mutation endpoints know nothing
about campaign custody and would strand or corrupt a campaign (e.g. a "move"
that skips the controller, a "retry" that re-runs a sealed execution, a "delete"
that orphans campaign ledger rows). Mirror the approvals-surface posture
(register-approval-routes.ts CccCampaignApprovalGuard): refuse with 409 + a
stable code + the exact CLI commands, and fail CLOSED for future mutation routes
by guarding the whole non-read `/tasks/:id` subtree instead of an endpoint
allowlist. Reads intentionally stay open — campaign tasks must remain VISIBLE,
just not mutable from the dashboard.

Custody detection reuses the engine's isCccCampaignTask (compiler-owned
`ccc-prd:` lineage OR the pre-product customFields profile marker) — the same
suspicion marker the executor and workflow-graph safety boundaries use. No
parallel marker is introduced.
*/
export const CCC_CAMPAIGN_TASK_MUTATION_BLOCKED_CODE = "CCC_CAMPAIGN_TASK_MUTATION_BLOCKED";

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function refusalMessage(taskId: string): string {
  return (
    `Task ${taskId} belongs to a CCC campaign and cannot be mutated from the dashboard. `
    + "The dashboard's generic task endpoints do not verify campaign custody, receipts, or "
    + "confirmation digests, so mutating the card here would desynchronize the campaign ledger. "
    + "Operate on the campaign from the CLI instead: run `fn prd status <idempotency-key>` to get "
    + "the current status digest, then `fn prd pause|resume <idempotency-key> --confirm <status-digest>` "
    + "or `fn prd stop <idempotency-key> --reason <reason> --confirm <status-digest>`."
  );
}

export function cccCampaignTaskMutationConflict(taskIds: string[]): ApiError {
  return conflict(refusalMessage(taskIds.join(", ")), {
    code: CCC_CAMPAIGN_TASK_MUTATION_BLOCKED_CODE,
    taskIds,
  });
}

/*
FNXC:CccPlanningCustody 2026-10-14-13:41 (card G1, D22):
A held request-to-code planning task (K1 marker: `ccc-plan:` run-id lineage, paused, not user-paused) is owned by the `fn plan` CLI the same way an imported campaign task is owned by `fn prd`, so the same guard refuses it with the same stable code; `custody: "planning"` and the message tell the operator which CLI to use. The predicate is composed here from `isCccCampaignTask` and core's `isCccPlanningCustodyTask`, which is exactly the engine's guard-only `isCccCustodyGuardedTask`: the engine barrel that would export that name is parent-owned (D34) and not yet re-exported.
*/
export const CCC_TASK_CUSTODY_LOOKUP_FAILED_CODE = "CCC_TASK_CUSTODY_LOOKUP_FAILED";

function planningRefusalMessage(taskId: string): string {
  return (
    `Task ${taskId} is held by a request-to-code planning run and cannot be mutated from the dashboard. `
    + "Operate on the run from the CLI instead: `fn plan status <run-id>`, then "
    + "`fn plan pause|resume|cancel <run-id>`."
  );
}

export function cccPlanningTaskMutationConflict(taskIds: string[]): ApiError {
  return conflict(planningRefusalMessage(taskIds.join(", ")), {
    code: CCC_CAMPAIGN_TASK_MUTATION_BLOCKED_CODE,
    taskIds,
    custody: "planning",
  });
}

/**
 * A read that says the task does not exist: the real store's `Task <id> not found`, an ENOENT-coded error
 * (the file-era store and the route-level 404 mapping), or an ApiError 404.
 */
function isTaskNotFoundError(error: unknown, taskId: string): boolean {
  if (error instanceof ApiError) return error.statusCode === 404;
  if (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT") return true;
  return error instanceof Error && error.message === `Task ${taskId} not found`;
}

/**
 * Same status and message the error middleware gives the raw error (500 and its message), so routes keep their
 * tested response, plus a stable code saying the custody check, not the route, refused the mutation.
 */
function custodyLookupFailed(taskId: string, error: unknown): ApiError {
  return new ApiError(
    500,
    error instanceof Error ? error.message : "Internal server error",
    { code: CCC_TASK_CUSTODY_LOOKUP_FAILED_CODE, taskIds: [taskId] },
    error,
  );
}

/*
FNXC:CccCampaignTaskGuard 2026-08-11-00:00:
Registered at the TOP of registerTaskWorkflowRoutes — the first registrar in
createApiRoutes that touches `/tasks` paths — so this middleware layer precedes
every `/tasks/:id...` route in the app, including routes added by LATER
registrars (register-git-github's `/tasks/:id/pr/*`, register-workflow-routes'
`/tasks/:taskId/workflow`, register-files-terminal-workspaces' task file
writes). Express `router.use("/tasks/:id", ...)` is prefix-matched, so the
guard also fronts any future per-task mutation route without needing a new
allowlist entry. Collection-level paths (`/tasks`, `/tasks/batch-update-models`,
`/tasks/archive-all-done`) either don't match this prefix or resolve `:id` to a
non-task segment (getTask returns nothing → pass-through); the two bulk
mutation endpoints carry their own explicit guards in
register-task-workflow-routes.ts.
*/
export function registerCccCampaignTaskMutationGuard(ctx: ApiRoutesContext): void {
  const { router, getProjectContext } = ctx;

  router.use("/tasks/:id", async (req, _res, next) => {
    if (READ_METHODS.has(req.method)) {
      next();
      return;
    }
    const taskId = String(req.params.id);
    /*
    FNXC:CccPlanningCustody 2026-10-14-13:41 (card G1, D22):
    Supersedes the 2026-08-11 fall-through on lookup failure. A transient failure here followed by a successful read in the route let an unchecked mutation through, which D22 forbids, so the guard now fails closed without inventing a custody 409:
    - a project-context failure is forwarded unchanged, so the response is the error mapping the route would have produced and the route never runs;
    - a store read that says the task does not exist passes through, because a missing task holds no custody, the route owns its 404, and the `/tasks/:id` prefix also matches collection routes (`/tasks/batch-update-models`), where the real store throws "Task <segment> not found";
    - any other read failure is refused before the route runs, with the 500 and message the error middleware gives the raw error plus the stable code CCC_TASK_CUSTODY_LOOKUP_FAILED;
    - a store with no `getTask` at all (only partial test stores) passes through: a store without a task read is not a lookup that failed.
    */
    let scopedStore: Awaited<ReturnType<typeof getProjectContext>>["store"];
    try {
      ({ store: scopedStore } = await getProjectContext(req));
    } catch (error) {
      next(error);
      return;
    }
    if (typeof scopedStore.getTask !== "function") {
      // A partial store (route tests build them) has no task read, so it can hold no custody. The real TaskStore always has one.
      next();
      return;
    }
    let task: Awaited<ReturnType<typeof scopedStore.getTask>> | undefined;
    try {
      task = await scopedStore.getTask(taskId);
    } catch (error) {
      if (isTaskNotFoundError(error, taskId)) {
        next();
        return;
      }
      next(custodyLookupFailed(taskId, error));
      return;
    }
    if (task && isCccPlanningCustodyTask(task)) {
      next(cccPlanningTaskMutationConflict([taskId]));
      return;
    }
    if (task && isCccCampaignTask(task)) {
      next(cccCampaignTaskMutationConflict([taskId]));
      return;
    }
    next();
  });
}
