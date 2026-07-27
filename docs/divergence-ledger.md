# Divergence Ledger

[← Docs index](./README.md) · [← Repository root](../README.md)

This file tracks **what** diverges between ccc-fusion and upstream [Runfusion/Fusion](https://github.com/Runfusion/Fusion) — the intentional fork deltas and the code/doc surfaces that own them. It does not own the upstream review cadence, the `UP-N` maintenance-wave process, or the Ryan-approval gates around adopting upstream changes; those live in the vault ConversionPlan (`00_MAIN/01_ActiveProjects/ccc-fusion/PRJ-AI-ccc-fusion-ConversionPlan-v0.1.md`). Each entry below is maintained as the owning surfaces change — this is a living ledger, not a point-in-time snapshot.

---

## CF-DIV-001 — Subscription-only Claude/Codex launch profiles

ccc-fusion pins CLI-agent child processes to subscription-authenticated Claude Code / Codex launches instead of accepting arbitrary API-key or base-URL overrides. Before a child process spawns, the engine requires an explicit subscription-readiness preflight and strips a fixed set of forbidden env keys (`ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`, Bedrock/Vertex switches, etc.) so a launched agent can never silently fall back to a raw-key or third-party-routed provider.

- **Status:** active divergence — maintained.
- **Owning surfaces:** `packages/engine/src/cli-agent/ccc-subscription-policy.ts`

## CF-DIV-002 — Exact OmniRoute transport

Any loopback HTTP transport ccc-fusion admits for provider/tool routing must match one exact shape: literal `http://127.0.0.1:<port>/<path>` with an explicit positive port, no hostname aliases, no IPv6, no userinfo, and no query/hash suffix. This is stricter than upstream Fusion's general transport handling and matches the single admitted local-gateway shape ccc-fusion routes through.

- **Status:** active divergence — maintained.
- **Owning surfaces:** `packages/engine/src/ccc-loopback-policy.ts`

## CF-DIV-003 — Cancellation/effect durability

ccc-fusion introduces a versioned, PostgreSQL-authoritative effect-receipt protocol (`ccc-tool-receipts/v2`) for tool-dispatch effects issued during a campaign run. Every effect claim moves through explicit states (`reserved` → `dispatched_unknown` → `committed` / `proved_failed`) so a cancelled or interrupted run can be reconciled from durable state instead of losing track of in-flight side effects.

- **Status:** active divergence — maintained.
- **Owning surfaces:** `packages/core/src/ccc-effect-receipts.ts`, `packages/core/src/postgres/migrations/0034_ccc_effect_receipts.sql`

## CF-DIV-004 — Fail-closed ccc branch persistence

Landing a campaign-driven change onto a git branch is fail-closed: the local-git inspection layer re-derives the target repository root, base commit, and working-tree cleanliness on every check rather than trusting cached state, and the landing path only proceeds through an explicitly claimed and consumed campaign-authority binding. Any drift (foreign HEAD, dirty tree, base mismatch) refuses the landing instead of persisting a possibly-wrong branch state.

- **Status:** active divergence — maintained.
- **Owning surfaces:** `packages/engine/src/ccc-campaign-git-landing.ts`, `packages/engine/src/ccc-campaign-local-git.ts`

## CF-DIV-005 — PRD compiler/import

ccc-fusion adds a full CCC PRD campaign pipeline that upstream Fusion does not have: an authoring/compiler layer that turns an admitted manifest of source files into a deterministic, hash-addressed semantic bundle (`author` → `validate`/`compile`), and a transactional PostgreSQL importer that lands a compiled bundle onto the task board with idempotency and restart/reconciliation support. The CLI surface (`fn prd author|validate|compile`) is documented in [`docs/cli-reference.md`](./cli-reference.md#prd-campaign-fn-prd); import itself is programmatic only (`importCccPrdBundle` from `@fusion/core`).

- **Status:** active divergence — maintained.
- **Owning surfaces:** `packages/engine/src/ccc-prd/`, `packages/core/src/ccc-prd/`

## CF-DIV-006 — ccc proof/receipt/limit extensions

Campaign execution runs inside a native, admission-gated proof/enforcement layer: a fixed proof-admission host bootstraps bounded workflow extensions before authoring or execution is allowed to proceed, and PostgreSQL migrations add the campaign-native-enforcement and governance schema this layer depends on. This closes the loop between the effect-receipt protocol (CF-DIV-003) and the campaign admission checks (CF-DIV-004/007) with one consistent proof surface.

- **Status:** active divergence — maintained.
- **Owning surfaces:** `packages/engine/src/ccc-campaign-proof-admission.ts`, `packages/engine/src/ccc-campaign-proof-host.ts`, `packages/core/src/postgres/migrations/0036_ccc_campaign_native_enforcement.sql`

## CF-DIV-007 — Manual conflict, scope, mutation, and interruption profile

Merge and admission decisions for imported campaign tasks distinguish "ordinary" task custody from "campaign" custody and route campaign-owned tasks through dedicated conflict/authority checks (task drift, provider drift, route drift, action drift, git base/target drift, dirty tree) rather than the general-purpose merge path. This is the manual-intervention surface: an admission refusal names the exact drift reason instead of silently proceeding or silently discarding operator scope.

- **Status:** active divergence — maintained.
- **Owning surfaces:** `packages/engine/src/ccc-campaign-merge-control.ts`, `packages/engine/src/ccc-campaign-admission.ts`

## CF-DIV-008 — Shallow operator brand and CLI alias

ccc-fusion is a shallow-branded fork: the operator-facing product name is "ccc-fusion", but internal package/env/bin identifiers (`@fusion/*`, `@runfusion/fusion`, `FUSION_*`, the `fn`/`fusion` bins) intentionally stay on upstream naming so upstream diffs remain mergeable and no deep rename touches persistence, migrations, or internal scope. Operator-facing closure shipped 2026-07-27: README section, `docs/cli-reference.md` PRD-campaign docs, the `scripts/ccc-fusion` operator alias, and `scripts/check-ccc-shallow-brand.mjs` as the dedicated policy verifier.

- **Status:** active divergence — operator-facing closure shipped 2026-07-27: README section, cli-reference prd docs, scripts/ccc-fusion wrapper, check-ccc-shallow-brand verifier.
- **Owning surfaces:** `README.md`, `scripts/ccc-fusion`, `scripts/check-ccc-shallow-brand.mjs`
