---
"@runfusion/fusion": patch
---

summary: Record real Codex CLI token usage in CCC provider-attempt settlement instead of always reporting unknown cost.
category: feature
dev: Adds a codex exec turn.completed usage parser (packages/engine/src/cli-agent/codex-exec-usage.ts), session-manager capture on close, a usage field on the held-closure receipt/evidence with a shared frozen/non-frozen validator, and executor settlement wiring at both settlement sites so captured usage flows into effectiveRoute with a truthful cost reason.
