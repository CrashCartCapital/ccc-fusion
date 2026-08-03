# Divergence Ledger

[← Docs index](./README.md) · [← Repository root](../README.md)

This file tracks **what** diverges between ccc-fusion and upstream [Runfusion/Fusion](https://github.com/Runfusion/Fusion) — the intentional fork deltas and the code/doc surfaces that own them. It does not own the upstream review cadence, the `UP-N` maintenance-wave process, or the Ryan-approval gates around adopting upstream changes; those live in the vault ConversionPlan (`00_MAIN/01_ActiveProjects/ccc-fusion/PRJ-AI-ccc-fusion-ConversionPlan-v0.1.md`). Each entry below is maintained as the owning surfaces change — this is a living ledger, not a point-in-time snapshot.

---

## CF-DIV-001 — Subscription-only Claude/Codex launch profiles

ccc-fusion pins CLI-agent child processes toward subscription-authenticated Claude Code / Codex launches instead of accepting arbitrary API-key or base-URL overrides. The enforced part is env hygiene: before a child process spawns, the engine strips a fixed set of forbidden env keys (`ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`, Bedrock/Vertex switches, etc.) so a launched agent cannot inherit a raw-key or third-party-routed billing path from the parent environment. The subscription-readiness check itself is a caller-supplied structural assertion (`subscriptionReady: true` at the call sites); it neither probes live auth nor reads credentials, so it documents intent rather than proving an authenticated subscription session exists.

- **Status:** active divergence — maintained. Enforced: env-key stripping. Advisory: subscription-readiness assertion (no live auth probe).
- **Owning surfaces:** `packages/engine/src/cli-agent/ccc-subscription-policy.ts`

## CF-DIV-002 — Exact OmniRoute transport

Any loopback HTTP transport ccc-fusion admits for provider/tool routing must match one exact shape: literal `http://127.0.0.1:<port>/<path>` with an explicit positive port, no hostname aliases, no IPv6, no userinfo, and no query/hash suffix. This is stricter than upstream Fusion's general transport handling and matches the single admitted local-gateway shape ccc-fusion routes through.

That loopback shape governs configured custom providers. Because a provider selection under the ccc-fusion profile is not always a custom provider, the profile now resolves every selection — primary and fallback alike — against exactly two admitted transports: a configured custom provider, whose base URL must satisfy the loopback shape above, or a non-HTTP subscription transport enumerated in `CCC_ADMITTED_NON_HTTP_TRANSPORTS` (`packages/engine/src/pi.ts`), which currently holds only the `pi-claude-cli` child-process bridge. An enumerated transport skips URL validation because it has no HTTP base URL to validate; CF-DIV-001's env-key stripping is what contains it. Every other provider selection — including pi-ai's built-in cloud HTTP routes such as `anthropic`, `openai`, and `openrouter` — now fails closed with `CCC_CUSTOM_PROVIDER_EGRESS_POLICY_VIOLATION` before the model registry, the session, or any provider dispatch exists. Previously a selection that resolved to no configured custom provider was skipped rather than refused, so a built-in cloud route bypassed the boundary entirely. The fallback selection is validated too, because an unresolvable primary promotes the fallback to the session's selected model.

- **Status:** active divergence — maintained. Fail-closed provider admission added 2026-08-01.
- **Owning surfaces:** `packages/engine/src/ccc-loopback-policy.ts`, `packages/engine/src/pi.ts` (`CCC_ADMITTED_NON_HTTP_TRANSPORTS`, `assertCccCustomProviderEgress`)

## CF-DIV-003 — Cancellation/effect durability

ccc-fusion introduces a versioned, PostgreSQL-authoritative effect-receipt protocol (`ccc-tool-receipts/v2`) for tool-dispatch effects issued during a campaign run. Every effect claim moves through explicit states (`reserved` → `dispatched_unknown` → `committed` / `proved_failed`) so a cancelled or interrupted run can be reconciled from durable state instead of losing track of in-flight side effects.

- **Status:** active divergence — maintained.
- **Owning surfaces:** `packages/core/src/ccc-effect-receipts.ts`, `packages/core/src/postgres/migrations/0034_ccc_effect_receipts.sql`

## CF-DIV-004 — Fail-closed ccc branch persistence

Landing a campaign-driven change onto a git branch is fail-closed: the local-git inspection layer re-derives the target repository root, base commit, and working-tree cleanliness on every check rather than trusting cached state, and the landing path only proceeds through an explicitly claimed and consumed campaign-authority binding. Any drift (foreign HEAD, dirty tree, base mismatch) refuses the landing instead of persisting a possibly-wrong branch state.

- **Status:** active divergence — maintained.
- **Owning surfaces:** `packages/engine/src/ccc-campaign-git-landing.ts`, `packages/engine/src/ccc-campaign-local-git.ts`

## CF-DIV-005 — PRD compiler/import

ccc-fusion adds a full CCC PRD campaign pipeline that upstream Fusion does not have: an authoring/compiler layer that turns an admitted manifest of source files into a deterministic, hash-addressed semantic bundle (`author` → `validate`/`compile`), and a transactional PostgreSQL importer that lands a compiled bundle onto the task board with idempotency and restart/reconciliation support. The CLI surface — authoring/compiling plus the operator commands that drive a campaign, including `fn prd preview` and the digest-confirmed `fn prd import` — is documented in [`docs/cli-reference.md`](./cli-reference.md#prd-campaign-fn-prd). The importer itself is `importCccPrdBundle` from `@fusion/core`, which the CLI calls after an operator confirms an exact preview digest.

- **Status:** active divergence — maintained.
- **Owning surfaces:** `packages/engine/src/ccc-prd/`, `packages/core/src/ccc-prd/`

## CF-DIV-006 — ccc proof/receipt/limit extensions

Campaign execution runs inside a native, admission-gated proof/enforcement layer: a fixed proof-admission host bootstraps bounded workflow extensions before authoring or execution is allowed to proceed, and PostgreSQL migrations add the campaign-native-enforcement and governance schema this layer depends on. This closes the loop between the effect-receipt protocol (CF-DIV-003) and the campaign admission checks (CF-DIV-004/007) with one consistent proof surface.

- **Status:** active divergence — maintained.
- **Owning surfaces:** `packages/engine/src/ccc-campaign-proof-admission.ts`, `packages/engine/src/ccc-campaign-proof-host.ts`, `packages/core/src/postgres/migrations/0036_ccc_campaign_native_enforcement.sql`

## CF-DIV-007 — Manual conflict, scope, mutation, and interruption profile

Merge and admission decisions for imported campaign tasks distinguish "ordinary" task custody from "campaign" custody and route campaign-owned tasks through dedicated conflict/authority checks (task drift, provider drift, route drift, action drift, git base/target drift, dirty tree) rather than the general-purpose merge path. This is the manual-intervention surface: an admission refusal names the exact drift reason instead of silently proceeding or silently discarding operator scope.

The production admission enforcement for campaign execution lives in `packages/engine/src/ccc-campaign-merge-control.ts` and `packages/engine/src/cli-agent/ccc-native-cli-production-resolver.ts` (wired in `cli-agent/runtime.ts`), plus per-seam route/identity checks in provider-attempt, store, binding, and workflow-graph-executor code. Those are the only admission surfaces; there is no separate unification helper to consult. A designed-but-unwired helper (`packages/engine/src/ccc-campaign-admission.ts`) previously sat alongside them with no production call site; it was deleted on 2026-08-02 with operator approval so the deprecated path could not be mistaken for a gate.

- **Status:** active divergence — maintained. Live enforcement: merge-control + native CLI production resolver + per-seam checks. The deprecated unwired admission helper was deleted 2026-08-02.
- **Owning surfaces:** `packages/engine/src/ccc-campaign-merge-control.ts`, `packages/engine/src/cli-agent/ccc-native-cli-production-resolver.ts`

## CF-DIV-008 — Shallow operator brand and CLI alias

ccc-fusion is a shallow-branded fork: the operator-facing product name is "ccc-fusion", but internal package/env/bin identifiers (`@fusion/*`, `@runfusion/fusion`, `FUSION_*`, the `fn`/`fusion` bins) intentionally stay on upstream naming so upstream diffs remain mergeable and no deep rename touches persistence, migrations, or internal scope. Operator-facing closure shipped 2026-07-27: README section, `docs/cli-reference.md` PRD-campaign docs, the `scripts/ccc-fusion` operator alias, and `scripts/check-ccc-shallow-brand.mjs` as the dedicated policy verifier.

- **Status:** active divergence — operator-facing closure shipped 2026-07-27: README section, cli-reference prd docs, scripts/ccc-fusion wrapper, check-ccc-shallow-brand verifier.
- **Owning surfaces:** `README.md`, `scripts/ccc-fusion`, `scripts/check-ccc-shallow-brand.mjs`
