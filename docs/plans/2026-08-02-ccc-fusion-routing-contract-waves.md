# CCC routing-contract waves — session record 2026-08-01/02

Controller: native Claude Fable 5 parent; writer children on native Sonnet 5 / Opus 5 subscription routes. Baseline at session start: `4e1108844855f2820bf88bc156c0a26e669c38c9` (fresh `pnpm verify:ccc-prd-product` PASS). Every commit below was accepted only against parent-rerun tests on the exact tree; the full acceptance gate was rerun and PASSED after each wave (`b72c78043`, `dba2c62a8`, `44a46e41e`).

## Accepted commits

- `08f7d2e18` fix(dashboard): the generic approvals endpoint refuses `ccc-campaign-*` approvals with CLI guidance and excludes them from the generic list/counts, instead of showing a false "approved" while the campaign stays stuck in manual-required.
- `75e810c9a` feat(prd): per-task routing (`createCccPrdProductExecutionPlan` accepts `routesByTaskId`, fail-closed on missing/extra ids) plus the execution-policy **v3** schema: per-route routeProfileId, taskArchetype, reasoningEffort, serviceTier, accessTier, sensitivityClass, egressPolicy, limits, fallbackPolicy, catalogDigest, decidedAt; `maxSpendUsd` rejected on the receipt-incapable cli transport; ordered fallback rejected as unsupported; v2→v3 has no silent backfill.
- `b72c78043` fix(engine): campaign-bound sessions refuse the settings-derived fallback at session creation and prompt time (`CCC_FALLBACK_REFUSED`, no attempt reserved on refusal); PRD authoring/understanding validate provider egress against the loopback policy before any corpus bytes are serialized.
- `5989d9436` chore(prd): v3 surface exported from the core barrel; `admitCccCampaignAction` marked deprecated in-source; divergence ledger corrected (CF-DIV-007 names the live enforcement surfaces; CF-DIV-001 separates enforced env-stripping from the advisory subscription-readiness assertion).
- `bb4ea85bb` + `b1fed6876` feat/test(prd): `fn prd policy --routes-file` (ccc-prd.routes-by-task.v1) gives each task its own provider/model/transport through the normal CLI, mutually exclusive with the single-selection flags, fail-closed on every malformed input with no plan written on refusal; fixture built from the shared core test helper.
- `dba2c62a8` feat(prd): provider-attempt **v4**: optional effective-route receipts (effective identity must match the requested binding; non-null fallbackReason refused; cost claims require usage + a trustworthy receiptSource; explicit unknown cost legal; absence-aware replay equality keeps legacy replays idempotent); product-status surfaces the facts. Proven against disposable PostgreSQL 16 (pg quartet 40/40).
- `44a46e41e` fix(engine): CCC provider admission fails closed — a selection must be a loopback-validated configured custom provider or a member of `CCC_ADMITTED_NON_HTTP_TRANSPORTS` (currently only `pi-claude-cli`); built-in cloud HTTP routes (`anthropic`, `openai`, `openrouter`) refuse before any session exists; fallback selections validated because primary-resolution failure promotes the fallback.

## Design decisions of record

- Live admission authority is `cli-agent/ccc-native-cli-production-resolver.ts` plus the per-seam checks; `ccc-campaign-admission.ts` is deprecated, unwired, and must not be cited as a gate.
- Campaign fallback is forbidden until each fallback entry is itself an admitted, separately reserved route. Requested identity stays in the authority-binding hash; effective identity lives only at the attempt/receipt layer.
- Cost honesty over cost enforcement: claiming a cost requires a receipt; explicit unknown is always legal; spend caps are only declarable on receipt-capable transports.

## M1 multi-task slice — landed 2026-08-02

The single-task restriction is gone end to end, proven by the extended 29-check acceptance gate (`pnpm verify:ccc-prd-product` PASS on the real tree) whose canary is now a two-task dependency chain with two route profiles via `fn prd policy --routes-file`, chained isolated worktrees (the successor's worktree contains the predecessor's commit as an ancestor), one live-execution hold per task surfaced through guided next-action, one campaign-wide proof over both commits, and the same single human merge stop.

- `53a5b4a06` compiler admits linear multi-task chains (chain topology, edges/intents bijection, disjoint custody, no shared live-execution action, mandatory per-task custody at N>1).
- `03aec1393` product status refuses on an unresolvable attempt anchor instead of silently returning empty.
- `18cffba5b` effective-route receipts produced by live transports (PI: observed identity + usage + cost; CLI: honest binding identity + explicit unknown).
- `b4fb0ab6b` chained worktrees, durable-receipt landing ancestry (single-task no-op), startup-recovery per-item containment.
- `fe12e3728`/`4f4f4e1b3` real-pg fixture repairs (custody, provider admission, real plan envelope, truthful pi identity) — real-pg surface 46/46 from 24 failures.
- `fd31d12f7` CLI per-task routes proven through the real un-mocked pipeline.
- `5e4cf1acd` receipts round-trip exactly through the pi assertion; silent step failures now name their cause durably.
- `714f6aac5` + `c4042ab04` the extended two-task gate with the guided-path assertion.
- `9043e5735` second campaign dispatch admitted (requestCount = attemptOrdinal), squash/rebase exemptions for chained successors, guided next-action across all campaign tasks.
- `599054056` required-commit guard measures against the task's own start commit in all three directions (also closing two silent-acceptance holes).

M1 defers by design: parallel tasks (needs per-task fences + pinned start commits), fan-out/fan-in, >1 terminal/workflow, per-task proof gates, pi-transport canary route, approval aggregation.

## Known-open items (queued)

- v3 policy emission through preview/import; reasoning-effort degrade persistence; authoring `maxResponseBytes`-as-tokens unit bug; operator rendering (human-readable status/refusals), digest UX, idempotency-key generation, CLI custom-provider registration.
- Export the core effective-route projection helper so the pi assertion stops hand-duplicating the fallbackReason drop.
- Claude Code transcript usage/model fields (live check, separately gated) could upgrade the claude-code adapter from receiptSource "none" to "stream-usage".
- Pre-existing intentional RED marker: `ccc-native-cli-lifecycle.test.ts` "Task 4 RED: release refuses before a durable atomic terminal settlement" (unchanged since the merged spine; owner is the future Task 4 settlement work).
- `fn prd author`/`understand` now refuse non-loopback/unconfigured providers (release-note item).
- Identity-coupling note: required-commit chain detection keys on lineageId; if executor campaign gating ever widens to customFields-only tasks, the guard must widen with it.
