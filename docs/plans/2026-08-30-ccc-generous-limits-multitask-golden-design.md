# CCC Generous Limits And Multi-Task Golden Design

## Goal

Make useful completion the default sizing posture for CCC-Fusion campaigns, then evaluate the existing sealed Evidence Ledger project across exactly three OmniRoute peer aliases: `minimax-latest`, `glm-latest`, and `gemini-flash-latest`.

## Success Criteria

- CCC-Fusion documents and exposes a finite, task-sized generous request recommendation that is distinct from the structural admission floor.
- Tight operator-authored envelopes remain valid when they satisfy the structural floor, but preview evidence labels them as tight instead of implying adequacy.
- The active golden matrix contains exactly `minimax-latest`, `glm-latest`, and `gemini-flash-latest`; Luna is absent from active configuration and cannot be selected as a default or fallback.
- Each peer receives the same sealed three-task Evidence Ledger packet, 1,152-request campaign-global cap, 180-minute campaign cap, concurrency one, 200k context, 32,768 output tokens, and 5m soft / 10m hard tokens per task.
- The campaign produces six worker-owned files through the contract, core, and CLI dependency chain; three task proofs and one final integrated proof must pass.
- Evidence identifies requested and effective routes, total and per-task requests, proof outcomes, candidate files, and any early terminal boundary.

## Approved Decisions

### Generous means completion-oriented and finite

Limits are safety envelopes, not throughput targets. Size them from the expected task graph with empirical headroom for discovery, implementation, verification, and repair. Prefer a longer useful run over an arbitrary early cutoff. Retain explicit authority, cost, quota, duration, inactivity, retry-storm, and runaway safeguards.

The existing two-request-per-provider-task value remains the structural admission floor. It proves only that the phase machine can admit a mutate and repair turn. A 384-request-per-provider-task starting recommendation expresses the completion-oriented posture without rejecting a deliberate tighter operator choice. The first live MiniMax multi-task cell exhausted the earlier 42-request campaign cap after Contract passed and Core began. A second MiniMax cell passed at 191 of 192 requests, proving that 192 total was a successful minimum but not a generous project envelope.

### Reuse the frozen three-task project

Use the existing Evidence Ledger chain rather than inventing a new benchmark:

1. Contract owns `src/record.mjs` and `src/validation.mjs`.
2. Core owns `src/ledger.mjs` and `src/report.mjs` and depends on Contract.
3. CLI owns `bin/evidence-ledger.mjs` and `README.md` and depends on Core.

The baseline-owned verifier remains the oracle. A single six-file task would not test multi-task orchestration; adding a fourth worker-authored verifier task would weaken the oracle boundary.

### Use a 1,152-request, 180-minute project envelope

The first live three-task trial used 42 campaign-global requests and exhausted them in 163 seconds after Contract completed and Core began. The next MiniMax trial passed the whole project in 191 requests: Contract 36, Core 46, and CLI 109. The final peer envelope therefore allows 384 requests per task, or 1,152 campaign-global requests, and 180 minutes. This is about six times the observed complete MiniMax campaign cost and leaves large finite headroom for a request-hungry model. The allowance is not reserved per task, so evidence reports request counts by semantic task. Concurrency remains one because the chain is serial and the evaluation compares worker behavior, not scheduler parallelism.

Actual request consumption is an evaluation result, not automatically a failure. Compare request totals and per-task distributions across MiniMax, GLM, and Gemini Flash under the same high ceiling. If one model reliably uses more calls while still producing accepted work, use that evidence for later model-specific sizing rather than shrinking the common evaluation envelope.

### Attribute the three aliases as peers

Each cell configures one synthetic Fusion provider pointing at OmniRoute and one exact alias. An operational alias may advertise fallbacks, but the golden cell has a narrower attribution allowlist: a GLM cell counts only GLM terminal receipts, a MiniMax cell counts only MiniMax terminal receipts, and a Gemini Flash cell counts only Gemini-family terminal receipts. A cross-peer fallback is persisted as `CCC_GOLDEN_ROUTE_ATTRIBUTION_FAILED`, never credited to the requested peer. The Pi-level receipt must match the configured synthetic provider and alias; the nested OmniRoute receipt must be present and must resolve within the requested model family. Any Luna resolution is a failed route-integrity result, not an accepted fallback.

Historical evidence that mentions Luna remains unchanged as history. Only active matrix configuration, defaults, and new campaign evidence are in scope.

## Product And Instruction Surfaces

- `docs/ccc-fusion-product.md` owns the product-facing execution-envelope principle.
- `packages/core/src/ccc-campaign/request-budget.ts` owns the distinction between structural floor and recommended starting allowance.
- `packages/cli/src/commands/prd.ts` exposes the recommendation and sizing posture in preview evidence without changing confirmation identity or admission.
- `30_DEVSTACK/surface_system/projects/PRJ-AI-InstructionOverlay-ccc-fusion.md` owns the source-first agent instruction principle. Generated roots are rebuilt and audited, not edited directly.
- The golden driver helper and live real-PostgreSQL fixture own the active peer matrix and campaign-specific envelope.

## Non-Goals

- No global unlimited mode.
- No weakening of absolute admission ceilings, proof timeouts, inactivity watchdogs, or retry protections.
- No provider-routing strategy change outside the three sealed test cells.
- No new OpenCode adapter or Pi harness redesign unless live evidence isolates a defect.
- No rewriting of prior experiment findings.

## Handoff

Execute `docs/plans/2026-08-30-ccc-generous-limits-multitask-golden-plan.md` under RED -> GREEN -> REFACTOR, then run the three live cells serially and freeze their receipts for independent review.
