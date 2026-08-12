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
    let campaignTaskId: string | undefined;
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const task = await scopedStore.getTask(req.params.id);
      if (task && isCccCampaignTask(task)) {
        campaignTaskId = String(req.params.id);
      }
    } catch {
      /*
      FNXC:CccCampaignTaskGuard 2026-08-11-00:00:
      A guard-side lookup failure (project context or store read) falls through
      to the route handler, which resolves the SAME context/store and will
      surface the same failure with its route-specific error mapping. Refusing
      here on infrastructure errors would turn every store hiccup into a
      misleading campaign-custody 409.
      */
      next();
      return;
    }
    if (campaignTaskId !== undefined) {
      next(cccCampaignTaskMutationConflict([campaignTaskId]));
      return;
    }
    next();
  });
}
