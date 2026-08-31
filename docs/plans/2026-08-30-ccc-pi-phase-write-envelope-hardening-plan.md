# CCC Pi Phase And Write-Envelope Hardening Plan

## Goal

Implement the accepted provider-neutral signal handshake and early candidate write-envelope guard, preserve the generous three-peer campaign, and prove the change through deterministic tests plus a fresh serial live matrix.

## Preconditions

- Design: `docs/plans/2026-08-30-ccc-pi-phase-write-envelope-hardening-design.md`.
- Worktree: `/Users/ryanpappal/03_CODE/ccc-fusion-worktrees/golden-campaign-readiness-20260829` on `agent/golden-campaign-readiness-20260829`.
- Baseline commit: `cab04368c5547022d84393028f61b5fb78163cad`.
- Historical receipts: `/tmp/ccc-golden-glm-r1152-20260830.json` and `/tmp/ccc-golden-minimax-r1152-20260830.json`.
- The user authorized live provider calls, bounded Sol/Luna/AGY consultation, iterative repair, verification, and a final local commit.

## Findings

- GLM's failure is an omitted `fn_complete_phase` call after correct admitted work; the tool was present and no route fallback occurred.
- MiniMax's failure is late discovery of `.fusion-tmp/h2.txt`; current Pi custody policy stops observing potential mutation tools once the phase leaves DISCOVER.
- Pi exposes sequential per-tool execution, not a whole-batch pre-dispatch hook. Signal-only safety therefore uses pre-execution refusal, persistent invalidation, and terminating results.
- Required-commit and readiness already fail closed on foreign paths. They remain final defense-in-depth gates rather than being weakened.

## Durable Mode Packet

- **Plan Path:** `docs/plans/2026-08-30-ccc-pi-phase-write-envelope-hardening-plan.md`
- **Findings Path:** `docs/plans/2026-08-30-ccc-pi-phase-write-envelope-hardening-design.md`
- **Recovery Rule:** after compaction or resume, reread the design and this plan, then inspect Git status and the latest RED/GREEN or live receipt before acting. Update status in this plan rather than creating a competing scratch plan.
- **Resume/Handoff Rule:** a fresh agent starts from this plan and the latest evidence file. Preserve the unchanged golden envelope and exact three-peer matrix.

## Task Map

### Task 1: Prove the missing signal-only state

- **Surfaces:**
  - `packages/engine/src/__tests__/ccc-phase-machine.test.ts`
  - `packages/engine/src/__tests__/ccc-campaign-fallback-executor-seam.test.ts`
- **RED:**
  1. Add `phase_signal_handshake_after_dirty_continuation` expecting a second dirty unsignaled MUTATE observation to choose `PROMPT_PHASE_SIGNAL` and enter `AWAIT_PHASE_SIGNAL`.
  2. Add an executor regression that simulates GLM's dirty work plus prose-only continuation and expects a third, signal-only prompt rather than immediate failure.
  3. Add the positive continuation where the third prompt calls only `fn_complete_phase`; expect controller VERIFY and ready handoff after settlement.
  4. Add the sibling-tool case; expect the non-signal tool implementation not to run and a later signal not to clear invalidation.
- **Verification:**
  - `pnpm --filter @fusion/engine exec vitest run src/__tests__/ccc-phase-machine.test.ts src/__tests__/ccc-campaign-fallback-executor-seam.test.ts --silent=passed-only --reporter=dot`
- **Done when:** all new tests fail for missing signal-only behavior, not fixture or import errors.

### Task 2: Implement the formal signal handshake

- **Surfaces:**
  - `packages/engine/src/ccc-phase-machine.ts`
  - `packages/engine/src/executor.ts`
  - `packages/engine/src/pi.ts`
- **GREEN:**
  1. Add `AWAIT_PHASE_SIGNAL` and `PROMPT_PHASE_SIGNAL` with a one-request transition to VERIFY or terminal failure.
  2. Render one exact signal-only prompt after the normal MUTATE continuation.
  3. Add Pi campaign-policy callbacks for signal-only mode and sibling-tool invalidation.
  4. Refuse and terminate every non-`fn_complete_phase` tool before execution in that state; preserve invalidation even if a later signal call appears.
- **REFACTOR:** keep prompt rendering in one helper and phase decisions in the pure phase machine; do not add provider-specific branches.
- **Verification:** rerun Task 1's exact command.
- **Done when:** the observed REDs pass and all existing phase tests remain green.

### Task 3: Prove and implement early candidate write custody

- **Surfaces:**
  - `packages/engine/src/ccc-campaign-ready.ts`
  - `packages/engine/src/pi.ts`
  - `packages/engine/src/executor.ts`
  - `packages/engine/src/__tests__/ccc-campaign-fallback-refusal.test.ts`
  - `packages/engine/src/__tests__/ccc-campaign-fallback-executor-seam.test.ts`
  - `packages/engine/src/__tests__/ccc-campaign-required-commit.real-git.test.ts`
- **RED:**
  1. Native write/edit target `../foreign.txt` and `.fusion-tmp/h2.txt` outside exact admitted roots must be refused before the tool implementation runs.
  2. In MUTATE, a fake Bash tool that creates `.fusion-tmp/h2.txt` must return a terminating `CCC_CAMPAIGN_WRITE_ENVELOPE_VIOLATION` with tool name, new foreign path, and allowed roots.
  3. A foreign path present before phase entry must fail baseline custody without being attributed to the next tool.
  4. Real Git admitted edits plus `.fusion-tmp/h2.txt` must remain uncommitted with HEAD and index unchanged.
- **GREEN:**
  1. Add a reusable candidate write-set snapshot from canonical Git paths.
  2. Render exact admitted roots in the campaign prompt.
  3. Preflight native write/edit paths against normalized exact-or-descendant admitted roots.
  4. Capture pre/post write sets around every potential mutation tool in every phase, compute new paths, and terminate on a new foreign path without cleanup.
  5. Assert zero foreign paths before the first provider prompt.
- **REFACTOR:** preserve readiness/commit checks as independent final gates and keep bounded tool-result diagnostics in the Pi result shape.
- **Verification:**
  - `pnpm --filter @fusion/engine exec vitest run src/__tests__/ccc-campaign-fallback-refusal.test.ts src/__tests__/ccc-campaign-fallback-executor-seam.test.ts src/__tests__/ccc-campaign-required-commit.real-git.test.ts --silent=passed-only --reporter=dot`
- **Done when:** the new custody REDs pass without weakening any existing refusal.

### Task 4: Run deterministic integration controls

- **Surfaces:** all changed engine files plus existing route and golden helpers.
- **Steps:**
  1. Run phase, Pi, executor, required-commit, provider-controller, route-receipt, matrix, and combo-snapshot suites.
  2. Run the fake three-task Evidence Ledger control.
  3. Run engine/core/CLI typechecks, scoped ESLint, `git diff --check`, and `pnpm verify:fast`.
- **Verification:** record exact commands and counts in the evidence note.
- **Done when:** deterministic project generation and all touched package gates are green.

### Task 5: Rerun the unchanged live matrix

- **Surfaces:**
  - `packages/engine/src/__tests__/ccc-golden-evidence-ledger-pi.live.real-pg.test.ts`
  - `docs/plans/2026-08-30-ccc-multitask-golden-evidence.md`
- **Steps:**
  1. Build current CLI/engine artifacts.
  2. Fetch and sanitize fresh authenticated OmniRoute combo snapshots without exposing the management credential to workers.
  3. Run `minimax-latest`, `glm-latest`, and `gemini-flash-latest` serially with the unchanged 1,152-request / 180-minute / three-task envelope.
  4. Persist one compact evidence receipt per cell with total/per-task requests, timings, route receipts, phase/custody diagnostics, proofs, and files.
  5. If a cell exposes a changed harness defect, return to a new named RED before editing. Do not lower caps or tasks.
- **Done when:** all three cells reach durable merge approval with three tasks, four proofs, and six files, or a genuine external blocker is precisely evidenced after changed experiments.

### Task 6: Review, verify, commit, and close

- **Surfaces:** final diff, design, plan, and golden evidence.
- **Steps:**
  1. Obtain AGY adversarial closure and one independent code-review subagent verdict.
  2. Adjudicate every finding; material repairs restart at RED.
  3. Rerun affected deterministic tests plus the repository fast gate after the final repair.
  4. Commit the complete change on the current branch; do not push or merge.
- **Done when:** reviews accept, the worktree is clean after commit, evidence proves the objective, and the active goal can be marked complete.

## Next Lane

Complete. The formal signal-only phase, admitted-root prompt/preflight, all-Bash pre/post custody, zero-foreign baseline, fail-closed baseline-unavailable path, live fixture repairs, enlarged trace receipts, and durable evidence note are implemented.

## Completion Evidence

- Phase/custody implementation: RED -> GREEN on the named phase-machine, executor-seam, Pi refusal, and real-Git tests.
- Harness iteration: two pre-provider live fixture defects were isolated and repaired; one valid MiniMax foreign-path failure exposed the Bash discovery/custody gap, which received its own RED -> GREEN repair.
- Live matrix under the unchanged envelope:
  - MiniMax: **PASS**, 193 requests, `minimax/MiniMax-M3`.
  - GLM: **PASS**, 162 requests, `glm/glm-5.3`, no fallback used.
  - Gemini Flash: **PASS**, 92 requests, `antigravity/gemini-3.7-flash-high`.
  - Every cell committed three tasks, passed three task proofs plus the final integrated proof, and reached durable merge approval.
- Review: AGY **ACCEPT**; bounded independent code review **APPROVE**. A Luna P2 fail-open finding was adopted, repaired, and independently re-approved.
- Closure gates: focused engine suites, fake real-Postgres 3/3 campaign, core/engine/CLI typechecks, production ESLint, `git diff --check`, and `pnpm verify:fast` 16/16 with build and health smoke are green.
- Evidence: `docs/plans/2026-08-30-ccc-multitask-golden-evidence.md` contains matched counts, routes, proof status, receipt paths, and SHA-256 hashes.
