---
"@runfusion/fusion": patch
---

summary: Campaign receipts are no longer deleted by the 30-day operational-log retention sweep; campaign proof is kept forever.
category: fix
dev: `pruneOperationalLogsAsync` now excludes `run_audit_events` rows with `campaign_import_id IS NOT NULL` from the retention DELETE. Campaign receipts (provider attempts, effects, landing audits) carry the campaign task's `task_id`, so the task-scoped DELETE previously matched them and silently expired campaign proof after `operationalLogRetentionDays` (default 30). The binding check constraint makes campaign columns all-or-nothing, so `campaign_import_id` is the canonical campaign-bound marker. Ordinary rows keep the existing retention behavior.
