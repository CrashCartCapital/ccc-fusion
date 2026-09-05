---
"@runfusion/fusion": patch
---

summary: A campaign whose stored manifest no longer reconstructs can now be closed with fn prd stop-drifted.
category: fix
dev: The close reads import-row columns only, requires custody reconstruction to fail, records the drift reason in the terminal state, and marks the import terminal so reconcile stops re-projecting its task directories. Worktrees, branches, approvals, and receipts are preserved. Migration 0041 widens ccc_prd_imports_state_check to admit the terminal stopped state; the import row is written before anything is cancelled or paused, and a leased, running, or already-terminal work item is refused.
