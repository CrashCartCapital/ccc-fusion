---
"@fusion/core": patch
"@fusion/engine": patch
---

summary: `fn prd stop` on a terminal-failed campaign now returns its close-out receipt instead of refusing after closing it.
category: fix
dev: Product status re-validated per-task campaign context (via `listCccProviderAttemptsForCampaign`) even when the import row it just read in the same call is already non-active, so building the post-close-out `completedStatus` receipt threw `CCC_CAMPAIGN_CONTEXT_REFUSED` right after `markCccPrdImportStopped` had already committed the close. `inspectCccPrdProductStatus` now skips that per-task re-validation once the freshly-read import row itself is not `active`, reporting `providerAttemptHistoryConsistent: false` instead of throwing; the check still fires exactly as before for a genuinely still-active import with broken task custody. Repeating `stop` against an already-closed campaign now fails closed with a clear, typed `CCC_CAMPAIGN_OPERATOR_CONTROL_IMPORT_REFUSED`, not a crash.
