---
"@runfusion/fusion": patch
---

summary: Let a campaign whose workflow already failed or was cancelled be closed instead of stuck active forever.
category: fix
dev: Adds a close-out plan/apply path shared by `fn prd stop` and `fn prd stop-drifted` for a terminal work item under an active or drifted import; preserves the work item's recorded error verbatim and writes only the import row. Also wraps the drift-stop work-item cancel in a typed error so a partial-apply interruption can be finished by re-running stop-drifted.
