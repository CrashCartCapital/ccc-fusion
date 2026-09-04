---
"@runfusion/fusion": patch
---

summary: The in-review branch rebinder now proves campaign custody against the sealed base, not the mutable task row.
category: fix
dev: Acquisition and the rebinder share one resolveCccCampaignCustodyBase helper in ccc-campaign-branch-custody.ts, so both writers judge the same branch by the same evidence. A poisoned baseCommitSha, or a seal that cannot be read, refuses the rebind instead of admitting a branch acquisition would reject.
