# CCC Generous Limits And Multi-Task Golden Plan

## Goal

Implement the approved generous-envelope policy and run the sealed three-task Evidence Ledger campaign across the three exact OmniRoute aliases with attributable route and proof evidence.

## Preconditions

- Design: `docs/plans/2026-08-30-ccc-generous-limits-multitask-golden-design.md`.
- Worktree: `/Users/ryanpappal/03_CODE/ccc-fusion-worktrees/golden-campaign-readiness-20260829` on `agent/golden-campaign-readiness-20260829`.
- Live OmniRoute catalog currently exposes `minimax-latest`, `glm-latest`, and `gemini-flash-latest`.
- The existing fake-backed three-task Evidence Ledger campaign and verifier remain the baseline control.
- The operator authorized bounded live provider calls and autonomous execution in this campaign.

## Findings

- `maxRequests` and `maxDurationMs` are campaign-global; `taskTokenBudget` is resolved per task.
- The first live MiniMax three-task attempt exhausted 42/42 requests after Contract passed and Core began. The next passed at 191/192 requests with a 36/46/109 task split, so the final matched envelope is 1,152 requests and 180 minutes with compact per-task evidence. Request consumption is a model comparison metric; later model-specific sizing follows the observed matrix rather than a universal low cap.
- The existing live fixture selects only `taskCount: 1`, reads logs only for `KB-001`, and expects only Contract plus integrated proof.
- The structural request floor is two per provider task, while existing source comments report 9-13 requests are common in live runs.
- Generated root instructions are source products; the canonical CCC-Fusion overlay must be changed and rebuilt source-first.

## Durable Mode Packet

- **Plan Path:** `docs/plans/2026-08-30-ccc-generous-limits-multitask-golden-plan.md`
- **Findings Path:** `docs/plans/2026-08-30-ccc-generous-limits-multitask-golden-design.md`
- **Recovery Rule:** after compaction or resume, reread the design and this plan, inspect Git status, then inspect the latest focused test or live-cell receipt before continuing. Record material status changes in this plan.
- **Resume/Handoff Rule:** a fresh agent starts from this plan and the latest `CCC_GOLDEN_PI_EVIDENCE` record; do not create a competing scratch plan.

## Task Map

### Task 1: Add completion-oriented request guidance

- **Surfaces:**
  - `packages/core/src/ccc-campaign/request-budget.ts`
  - `packages/cli/src/commands/prd.ts`
  - focused core and CLI tests owning product preview budget evidence
  - `docs/ccc-fusion-product.md`
- **RED:** prove the structural floor remains two requests per provider task, the recommended start is 384 per provider task, a floor-sized packet remains admitted but reports `tight`, and a recommendation-sized packet reports `generous`.
- **GREEN:** add the pure recommendation calculation and preview fields without changing import admission or confirmation digest.
- **REFACTOR:** keep campaign-global scope and lack of per-task reservation explicit in the explanation.
- **Verification:** exact core and CLI Vitest files selected after locating the owning assertions.
- **Done when:** preview distinguishes safety admission from useful-completion guidance and product docs state the same principle.

### Task 2: Replace the active peer matrix and wire the three-task envelope

- **Surfaces:**
  - `packages/engine/src/__tests__/helpers/ccc-golden-pi-driver-matrix.ts`
  - `packages/engine/src/__tests__/ccc-golden-pi-driver-matrix.test.ts`
  - `packages/engine/src/__tests__/ccc-golden-evidence-ledger-pi.live.real-pg.test.ts`
- **RED:** expect exactly the three alias model IDs, `taskCount: 3`, 1,152 requests, 180 minutes, no Luna active literal/default, all three semantic tasks, all four proofs, and all six candidate files.
- **GREEN:** update the matrix and generalize the live fixture to the full project while preserving a sealed single-provider cell.
- **REFACTOR:** capture bounded traces and request counts for every imported native task instead of hard-coding `KB-001`.
- **Verification:** `pnpm --filter @fusion/engine exec vitest run src/__tests__/ccc-golden-pi-driver-matrix.test.ts --silent=passed-only --reporter=dot`.
- **Done when:** skipped-live source checks and deterministic packet-shape checks prove the intended project and peer set.

### Task 3: Add the source-first instruction principle

- **Surfaces:**
  - `/Users/ryanpappal/01_VAULT/KnR-Vault/30_DEVSTACK/surface_system/projects/PRJ-AI-InstructionOverlay-ccc-fusion.md`
  - generated staged/root artifacts selected by Surface System
- **Proof:** change only the source overlay, run `task surface:build`, `task surface:validate`, and `task surface:audit`, and inspect the generated CCC-Fusion roots for the principle. Do not run live install without a separate explicit install action.
- **Done when:** source and staged/generated output agree and audit reports the exact expected delta.

### Task 4: Verify the implementation before live provider work

- **Surfaces:** all files changed in Tasks 1-3.
- **Steps:** run focused tests, scoped typecheck/lint, the fake-backed three-task campaign control when affordable, `git diff --check`, and inspect active route aliases from the live OmniRoute catalog.
- **Verification:** exact commands and observed counts are recorded in closeout evidence.
- **Done when:** deterministic controls are green and no active Luna route remains.

### Task 5: Run the three live peer cells serially

- **Surfaces:** disposable PostgreSQL, Git, and Fusion homes created by the live fixture; no shared route mutation.
- **Steps:** invoke the same live test once each with `CCC_GOLDEN_PI_DRIVER=minimax-latest`, `glm-latest`, and `gemini-flash-latest`; wait to a durable merge-approval hold; capture requested/effective route, total and per-task requests, proofs, candidate files, timing, terminal state, and any failure signature.
- **Verification:** each cell's exact command plus `CCC_GOLDEN_PI_EVIDENCE`; a passed cell needs three committed semantic tasks, four successful proofs, six candidate files, and no Luna in nested route receipts.
- **Done when:** all three cells have truthful terminal evidence, whether pass or precisely classified failure.

### Task 6: Review, repair, and close

- **Surfaces:** frozen final diff, live evidence, and this plan.
- **Steps:** obtain independent AGY adversarial review and a code-review subagent verdict; adjudicate each finding; after material repair, rerun affected deterministic proof and one bounded closure review.
- **Verification:** final scoped tests, typecheck/lint, `git diff --check`, source-first instruction audit, and reviewer verdicts.
- **Done when:** the generous-limit policy is durable, the active peer matrix is exact, live evidence is attributable, and no required repair remains.

## Closeout State

Tasks 1-6 are complete. Final matched evidence is recorded in `docs/plans/2026-08-30-ccc-multitask-golden-evidence.md`: MiniMax passed in 193 requests, GLM passed in 162 requests, and Gemini Flash passed in 92 requests after the Pi phase reminder and write-custody hardening. The earlier MiniMax final-custody failure and GLM phase-signal failure were preserved as harness findings and then closed by deterministic repair plus hardened live reruns. Independent review findings were adopted for HOME isolation, combo-member deduplication, snapshot tamper detection, failure-evidence fallback, immediate CLI validation, cross-peer route attribution, signal-only phase handling, and early write-envelope custody. AGY returned `ACCEPT`; the independent code-review closure returned `APPROVE` after the fail-open baseline exception was repaired. The pre-existing fractional `maxSpendUsd` observation was deferred as unrelated scope. Future provider ranking or model-specific cap tuning remains follow-on evidence work, not a reason to relabel the completed matrix.
