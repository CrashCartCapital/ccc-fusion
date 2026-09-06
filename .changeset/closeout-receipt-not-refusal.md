---
"@fusion/core": patch
"@fusion/engine": patch
---

summary: `fn prd stop` on a terminal-failed campaign now returns its close-out receipt instead of refusing after closing it.
category: fix
dev: Product status re-validated per-task campaign context (via `listCccProviderAttemptsForCampaign`) even when the import row it just read in the same call is already non-active, so building the post-close-out `completedStatus` receipt threw `CCC_CAMPAIGN_CONTEXT_REFUSED` right after `markCccPrdImportStopped` had already committed the close. `loadCccCampaignContextForTask` (`packages/core/src/ccc-campaign/store.ts`) now takes a read-only `allowNonRunnable` option, off by default everywhere; `listCccProviderAttemptsForCampaign`'s history read is the only caller that passes it, and only ever with `lockForUpdate: false`, so a status read of a closed campaign can still list its real provider-attempt ledger instead of losing it. Every leasing or mutating path (`reserveCccProviderAttempt`, dispatch, reconcile, and the rest) keeps the option off and keeps refusing a non-runnable import exactly as before. Repeating `stop` against an already-closed campaign now fails closed with a clear, typed `CCC_CAMPAIGN_OPERATOR_CONTROL_IMPORT_REFUSED`, not a crash.
