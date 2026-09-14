---
"@runfusion/fusion": patch
---

summary: Never sweep a worktree self-healing has no durable task record for; refuse to auto-register the Fusion source checkout as a project.
category: fix
dev: `scanIdleWorktrees` now requires a durable ownership record (a task row bound via `worktree`, or a `fusion/<task-id>` branch with a matching task) before treating any registered git worktree as idle/reclaimable, protecting `cleanupOrphans`, `enforceWorktreeCap`, `cleanupOrphanedWorktrees`, and pool warm-load alike; foreign paths are left alone and logged as `worktree-foreign-skipped`. `ensureCwdProjectRegistered` refuses to auto-register a cwd that looks like the Fusion source checkout (`packages/engine/package.json` declaring `@fusion/engine`, or a `.fusion-source` marker), printing a refusal that points at `cd`-ing into the target repo or `fn project add` + `--project`.
