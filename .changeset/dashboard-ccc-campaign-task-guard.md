---
"@runfusion/fusion": patch
---

summary: Refuse generic dashboard task mutations on CCC campaign-custody tasks with a 409 and exact `fn prd` CLI guidance.
category: security
dev: Imported CCC campaign tasks rendered as ordinary board cards, and every generic dashboard mutation endpoint (move, merge, revert, retry, reset, pause, unpause, delete, PATCH, PR actions, and more) accepted them unguarded even though the campaign-safe lifecycle (pause receipts, digest-confirmed approvals, hard-cancel) lives only in the `fn prd` CLI. A new prefix middleware (`packages/dashboard/src/routes/ccc-campaign-task-guard.ts`, registered first in `registerTaskWorkflowRoutes`) fronts every non-GET `/tasks/:id...` route — including routes added by later registrars — and refuses campaign-custody tasks with 409 + stable code `CCC_CAMPAIGN_TASK_MUTATION_BLOCKED`, reusing the engine's `isCccCampaignTask` custody marker (now exported from the engine barrel) rather than inventing a parallel one. Bulk routes carry explicit guards: `batch-update-models` refuses when any named target is campaign-owned; `archive-all-done` excludes campaign tasks and reports `skippedCccCampaignTaskIds` additively. Read-only endpoints stay open so campaign tasks remain visible.
