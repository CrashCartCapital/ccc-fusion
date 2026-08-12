---
"@fusion/core": patch
---

Let a live campaign session's follow-on turns ride the consumed live-execution approval. Settlement consumes the approval claim on the session's first committed terminal, which previously made every later turn of the same fenced node visit die with "approval is not exactly claimed" — no multi-turn live pi session could complete. A new reservation now accepts exact consumed custody, but only when the same work-item fence already owns a committed attempt for the action (the one whose settlement consumed the claim) and the approval's dispatch window is still open, so one human approval covers exactly the session it authorized and nothing else.
