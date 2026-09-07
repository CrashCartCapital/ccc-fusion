---
"@fusion/engine": patch
---

summary: Self-healing merge recovery now recognizes a CCC campaign controller commit as task-owned.
category: fix
dev: `commitOwnedByTask` (self-healing.ts) previously recognized only a `Fusion-Task-Lineage`/`Fusion-Task-Id` trailer or a `type(id): …`/`id: …` subject anchor, so it never attributed the literal campaign controller commit (`ccc-fusion campaign <id>`, author `ccc-fusion <ccc-fusion@localhost>`, no trailer) produced by `ccc-campaign-required-commit.ts` to its task — a blind spot in the four merge-recovery reconcilers behind `findLandedTaskCommit` (interrupted-merge recovery, done-task mergeDetails repair, stuck-merge-deadlock recovery). Now accepts that exact shape by reusing the newly-exported `isCccCampaignControllerCommit` predicate from worktree-acquisition.ts (already exercised there via `isCccCampaignTaskOwnedCommit`) instead of duplicating the comparison, so the two cannot drift; both `findLandedTaskCommit` call sites now also fetch commit author name/email. Traced separately: none of the four reconcilers' candidate filters (merge-active status, done column, or failed status on `Task`) can currently select a campaign task parked on `CCC_CAMPAIGN_MERGE_APPROVAL_REQUIRED`, since that park is recorded only in the `workItems` table, not on `Task`.
