---
"@fusion/core": patch
"@fusion/engine": patch
---

summary: Notify operators when a CCC campaign parks for a decision or fails terminally.
category: feature
dev: TaskStore emits workitem:transitioned on transaction-free transitions; NotificationService classifies campaign parks (manual-required with a ccc-* reason) and terminal failed/exhausted into campaign-needs-decision and campaign-failed pings through the existing ntfy/webhook providers, deduped per work item + state, with machine-fact payloads only.
