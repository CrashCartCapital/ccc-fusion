# CCC-Fusion Gate 2 Whole-Product Campaign Plan

## Goal

Prove that one frozen, installed CCC-Fusion candidate can accept a normal PRD, execute a useful six-task project through real Pi/OmniRoute workers, survive recovery and stop controls, expose honest operator status, and produce a controlled candidate without duplicate effects or hidden residue.

Gate 1 remains separate: the earlier same-task MiniMax/GLM/Gemini matrix proved the worker loop. This plan must not infer Gate 2 from that evidence.

## Preconditions

- Candidate baseline: `origin/main` at `5b52ddf0fc1fd4016bda8111f8c4e889c43bacf2`.
- Worktree: `.worktrees/gate2-whole-product-20260901` on `agent/gate2-whole-product-20260901`.
- Product contract: `docs/ccc-fusion-product.md`.
- Deterministic lifecycle canary: `scripts/ccc-prd-product-acceptance.mjs` via `pnpm verify:ccc-prd-product`.
- Existing real-Pi reference: `packages/engine/src/__tests__/ccc-golden-evidence-ledger-pi.live.real-pg.test.ts`.
- Approved routes: `minimax-latest`, `glm-latest`, and `gemini-flash-latest`; Luna and silent substitution are forbidden.
- Each live run receives an isolated HOME, PostgreSQL database/schema, port set, target repository, local bare remote, and idempotency key.

## Campaign Contract

The disposable target is `gate2-telemetry-service`, a TypeScript service with typed HTTP event ingest, append-only JSONL audit storage, SSE subscriber delivery, a CLI health probe, tests, and operator documentation.

Task graph:

1. `TASK-TELEMETRY-CONTRACT` — GLM; schema and fixtures.
2. `TASK-TELEMETRY-INGEST` — MiniMax; depends on contract.
3. `TASK-TELEMETRY-AUDIT` — GLM; depends on contract.
4. `TASK-TELEMETRY-BROADCAST` — Gemini Flash; depends on contract.
5. `TASK-TELEMETRY-CLI` — Gemini Flash; joins ingest, audit, and broadcast.
6. `TASK-TELEMETRY-INTEGRATE` — MiniMax; depends on the joined CLI node and creates only the final candidate commit.

Tasks 2-4 must have disjoint owned paths and overlapping dispatch windows. A separate deterministic negative control proves overlapping scopes are blocked; it is not a seventh DAG task. Remote landing remains owned by the terminal delivery lane, never task 6.

## Traceability

| Requirement | Acceptance proof | Test/proof ID |
|---|---|---|
| G2-01 normal PRD entry | unchanged source hashes, deterministic sidecars, imported six-task DAG | `gate2_packet_normal_entry` |
| G2-02 real peer routing | requested/configured/effective upstream receipts for every attempt | `gate2_live_route_attribution` |
| G2-03 safe fanout/join | tasks 2-4 overlap, scope conflict blocks, task 6 joins all leaf commits | `gate2_live_fanout_join` |
| G2-04 useful artifact | HTTP, JSONL, SSE, CLI, build/test, README binary rubric | `PROOF-TELEMETRY-INTEGRATED` |
| G2-05 recovery | deterministic post-commit fault cutpoints plus receipt-bound installed-runtime restart continuity without duplicate effects | `gate2_live_restart_recovery` |
| G2-06 operator controls | pause quiet window, one resume, stop cleanup and readable status | `gate2_live_pause_resume_stop` |
| G2-07 installed runtime | campaign launched from hash-bound built/installed artifacts | `gate2_installed_runtime` |
| G2-08 controlled landing | stale authority refuses; fresh local landing occurs exactly once | `gate2_controlled_landing` |

## Task Map

### Task 1: Seal the telemetry packet and deterministic verifier

- Surfaces: `scripts/lib/ccc-gate2-telemetry-*.mjs`, `scripts/__tests__/ccc-gate2-telemetry-*.test.mjs`, and `packages/engine/src/__tests__/fixtures/ccc-campaign/gate2-telemetry-service/` only when a static fixture is required.
- RED: packet-shape tests require exactly six tasks, seven dependency edges, three disjoint fanout owners, one explicit join, per-task routes, concurrency three, the 2,304-request/360-minute envelope, and a PRD that states observable behavior without verifier-answer leakage.
- GREEN: add the smallest packet/baseline/verifier builders and normal `fn prd` lifecycle preparation needed to satisfy the contract.
- Verification: focused Node tests plus `git diff --check`.

### Task 2: Add the installed live-Pi Gate 2 harness

- Surfaces: `packages/engine/src/__tests__/ccc-gate2-telemetry-pi.live.real-pg.test.ts` and focused helpers under `packages/engine/src/__tests__/helpers/`.
- RED: source-level harness tests require three exact peers, task-specific routes, concurrency three, isolated run identity, effective upstream attribution, installed-artifact binding, evidence persistence, and no Luna literals/defaults.
- GREEN: implement clean-success orchestration using the normal PRD preview/import/status/approval path, real Pi, isolated Postgres, and the sealed packet.
- Verification: focused skipped-live/source tests, typecheck, and fake-backed control before any provider call.

### Task 3: Add recovery and stop runs

- Surfaces: the Gate 2 live harness and the narrowest existing lifecycle/fault helpers.
- RED: recovery asserts a receipt-bound installed runtime can restart at a durable approval hold without changing the authorization, Git head, provider attempts, or proof attempts; deterministic post-commit and post-dispatch cutpoints remain in the 39-check lifecycle canary. Stop asserts a quiet pause window, one resume, terminal cancellation, and retained evidence before provider dispatch.
- GREEN: add separate isolated `clean`, `recovery`, and `stop` run modes. `clean` remains the only full real-model product-generation run. `recovery` is a focused installed-runtime continuity run and must not claim fresh product generation. `stop` is a focused pre-provider operator-control run and must not claim generation, usefulness, recovery, or landing.
- Verification: focused fake/cutpoint tests first, then each live mode independently.

### Task 4: Prove operator status and controlled local landing

- Surfaces: existing dashboard read APIs/refusal guards, CLI status digest, Gate 2 evidence collector, and a disposable local bare remote.
- RED: evidence must show DAG, blockers, route receipts, proof states, terminal state, dashboard mutation refusal with exact CLI guidance, stale landing refusal, and one fresh landing.
- GREEN: extend only missing evidence/read seams; ordinary workers remain unable to perform remote mutation.
- Verification: focused dashboard/API tests, CLI tests, and local bare-remote landing checks.

### Task 5: Run deterministic Lane A

- Commands: `task ci`, `task build && task gate`, relevant formerly failing full-suite shards, and `pnpm verify:ccc-prd-product` with all 39 clauses.
- Done when: the exact candidate is clean and all deterministic lifecycle/fault evidence is green. Curated gates alone do not authorize live proof.

### Task 6: Run installed live Lane B

- Per-run envelope: concurrency `3`, requests `2,304`, duration `21,600,000ms`, context `200,000`, max output `32,768`, task tokens `500,000,000` soft / `600,000,000` hard.
- Runs: full real-model clean success, focused installed-runtime restart continuity, and focused pre-provider pause/resume/stop, each fully isolated.
- Done when: the clean run records all effective upstream identities with no Luna and passes the binary project rubric; deterministic acceptance proves post-dispatch/post-commit recovery cutpoints; the installed-runtime recovery run preserves the durable approval state exactly; and stop leaves no hidden runnable work. No single operational lane may claim whole-product readiness by itself.

### Task 7: Independent review and delivery

- Freeze the exact diff, commit, evidence receipts, dashboard captures, and target candidate.
- Obtain artifact-bound code review and AGY adversarial review. Material repairs invalidate affected evidence and require reruns.
- Run final verification, commit exact paths, push the feature branch, open a PR, wait for a non-empty all-green check set, merge with head-SHA lock, and reconcile the primary checkout without disturbing user-owned untracked files.

## Drop Gates

Gate 2 is not proven if any required surface is missing or unknown: effective upstream route, installed-runtime binding, real Pi completion, clean fanout/join, recovery, operator visibility, controlled landing, usefulness, or residue cleanup. Any Luna route, silent fallback, fixture-only entry, duplicate effect, foreign write, hidden partial completion, failed integrated proof, or unclean target is a hard no-pass.

## Recovery Rule

After compaction or resume, reread this plan, inspect the worktree branch/status, then inspect the newest RED/GREEN output or live evidence receipt. Do not create a competing scratch plan.
