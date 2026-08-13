---
"@fusion/core": patch
---

Let a live campaign session's follow-on turns ride the consumed live-execution approval. Settlement consumes the approval claim on the session's first committed terminal, which previously made every later turn of the same fenced node visit die with "approval is not exactly claimed" — no multi-turn live pi session could complete. A new reservation now accepts exact consumed custody, but only when the same work-item fence already owns a committed attempt for the action (the one whose settlement consumed the claim) and the approval's dispatch window is still open, so one human approval covers exactly the session it authorized and nothing else.

Settlement gets the matching fix: a follow-on turn's committed terminal previously demanded the persisted action lease that the first turn's settlement had already removed, failing with "no exact persisted action lease" (observed live: turn 2 dispatched a real model call under the fixed reservation path, then died at commit). When no lease exists, both the pi/workflow store and the CLI-session store now settle under the same consumed custody — a committed same-fence attempt must exist and the consumed approval's binding must match — and skip re-consuming; every lease-mismatch refusal keeps its exact prior signature.
