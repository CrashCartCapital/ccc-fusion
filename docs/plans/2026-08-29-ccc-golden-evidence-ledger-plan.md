# CCC Golden Evidence Ledger Implementation Plan

## Goal

Produce and twice re-prove a proper disposable Evidence Ledger project through a sealed CCC-Fusion campaign, compare Pi and OpenCode under controlled conditions, and repair the smallest proven harness, sizing, budget, receipt, or recovery defect until the campaign succeeds or an external blocker is precisely evidenced.

## Preconditions

- The design in `docs/plans/2026-08-29-ccc-golden-evidence-ledger-design.md` is explicitly operator-approved.
- Work occurs only in `/Users/ryanpappal/03_CODE/ccc-fusion-worktrees/golden-campaign-readiness-20260829` on `agent/golden-campaign-readiness-20260829`.
- The branch begins clean at `e74be50f10253751a4da5ee7ee3701ecc4f8a330`, three commits ahead of `origin/main`.
- Live port `4040`, shared PostgreSQL, credentials, global routes, remote Git, publication, and unrelated worktrees are outside scope.
- Configured provider calls for this disposable campaign are operator-authorized; every call remains bounded and receipt-backed.

## Findings

- The current CCC campaign worker is not bare Pi: Fusion adds worktree/path custody, tool policy, request-derived phase limits, provider binding, compaction, durable effect receipts, and bounded continuations around the Pi session.
- The inner implementation turn still primarily delegates to `session.prompt()` and receives deterministic verification feedback after the turn. Prior M3 evidence showed extensive reads/searches and zero edits despite compact probes selecting edits, making first-mutation behavior the leading falsifier.
- The existing product-acceptance fixture uses CLI-agent/Codex routes for its provider cutpoint and generates toy text mutations. It is a lifecycle control, not a Pi-versus-OpenCode worker benchmark.
- OpenCode `1.18.3` is installed and its doctor is ready, but no first-class CCC runtime or bundled adapter exists. Its initial use must be task-local and benchmark-only.
- The repo-local instruction pack selector is unavailable on this host, so the exact committed workflow, consultation, Codex-runtime, project-local, and OmniRoute packs were read directly.

## Durable Mode Packet

- **Plan Path:** `docs/plans/2026-08-29-ccc-golden-evidence-ledger-plan.md`
- **Findings Path:** `docs/plans/2026-08-29-ccc-golden-evidence-ledger-design.md`
- **Recovery Rule:** after compaction or session resume, reread the design and this plan, then inspect current Git status, experiment receipts, owned disposable process handles, and the most recent RED/GREEN/proof output before acting. Update task status in this plan rather than creating a parallel scratch plan.
- **Resume/Handoff Rule:** a fresh agent starts from this plan, verifies the exact worktree and protected boundaries, and continues the first incomplete task. Existing handoff files receive only a delta if later needed.

## Task Map

### Task 1: Freeze the trusted project contract and fixture builder

- **Status:** completed — 2026-08-30; focused command, phase, and adversarial proof passed 23/23 after three independent review rounds closed custody, residue, date, static-boundary, path-escape, transactionality, fixture-hardcoding, CLI-hardcoding, and exit-contract false-greens. Scoped ESLint, syntax, and diff checks passed; source and generated verifier stay at or below 300 lines.
- **Surfaces:**
  - `scripts/__tests__/ccc-golden-evidence-ledger.test.mjs`
  - `scripts/lib/ccc-golden-evidence-ledger.mjs`
  - `scripts/ccc-golden-evidence-ledger.mjs`
- **Why now:** every later campaign and harness comparison must consume byte-identical baseline behavior.
- **Steps:**
  1. RED: test that the builder creates the exact baseline-owned package, Taskfile, verifier, and fixture set while leaving all six worker-owned files absent.
  2. GREEN: implement the smallest deterministic builder in `scripts/lib/ccc-golden-evidence-ledger.mjs` and a thin CLI entry point.
  3. RED: test valid, shuffled, malformed, duplicate, unknown-field, invalid-timestamp, invalid-confidence, hardcode-control, and semantic-mutation fixtures against candidate project trees.
  4. GREEN: implement `verify/project-verifier.mjs contract|core|cli|project` around the frozen public signatures and exact JSON/text/exit-code contract in the design. Each phase imports only files that exist at that point.
  5. REFACTOR: separate target construction, fixture definitions, and verification without files exceeding 300 lines.
- **Verification:** `node --test scripts/__tests__/ccc-golden-evidence-ledger.test.mjs`
- **Done when:** the exact baseline can be regenerated twice with identical tracked bytes and the controls fail or pass for the intended reasons.

### Task 2: Freeze experiment receipts and harness-event normalization

- **Status:** completed — 2026-08-30; receipt/OpenCode tests passed 13/13 after independent reviews closed invalid RED evidence, nested-event drift, raw tool-payload leakage, truncated-hash collisions, no-mutation serialization, route-proof contradiction, and free-text secret leakage. Existing Pi route-receipt coverage passed 116/116.
- **Surfaces:**
  - `scripts/__tests__/ccc-golden-experiment-receipt.test.mjs`
  - `scripts/lib/ccc-golden-experiment-receipt.mjs`
  - `scripts/__tests__/ccc-opencode-events.test.mjs`
  - `scripts/lib/ccc-opencode-events.mjs`
  - existing Pi route-receipt tests in `packages/engine/src/__tests__/ccc-route-receipt-adapter.test.ts` and `packages/engine/src/__tests__/pi.test.ts`
- **Why now:** live trials are uninterpretable without truthful route, first-mutation, request, tool, proof, and residue evidence.
- **Steps:**
  1. RED: reject receipts missing target hashes, harness version, prompt/argv/config/agent/tool-schema hashes, budget counters, effective-route proof classification, first-mutation fields, proof state, or terminal outcome.
  2. GREEN: implement canonical receipt validation and stable JSON serialization; hash bounded tool arguments rather than persisting prompt or secret-bearing data.
  3. RED: feed representative fake OpenCode JSON events and require normalized prompt, step, tool-call, tool-result, retry, compaction, patch/mutation, usage, permission, and terminal records.
  4. GREEN: implement a pure event normalizer that makes unsupported or malformed events explicit instead of silently discarding them.
  5. Re-run the existing synthetic terminal-SSE/Pi route-receipt tests and add a focused RED only if they do not prove effective provider/model propagation into the campaign receipt.
  6. REFACTOR: share canonical serialization and enum validation without coupling experiment receipts to task execution state.
- **Verification:** `node --test scripts/__tests__/ccc-golden-experiment-receipt.test.mjs scripts/__tests__/ccc-opencode-events.test.mjs`
- **Done when:** fake streams yield byte-stable bounded receipts and missing effective identity resolves to `ROUTE_UNKNOWN`, never an inferred model verdict.

### Task 3A: Build and transactionally import the sealed three-task CCC packet

- **Status:** completed — 2026-08-30; the built CLI froze, authored, validated, compiled, previewed, imported, replayed, and reported the exact three-task packet against disposable embedded PostgreSQL. Five honest-PG phases now include foreign-base refusal with zero rows for the exact idempotency key. Packet paths fail closed before staging on POSIX/Windows absolute paths, traversal, and NUL; lifecycle children use an isolated HOME and allowlisted environment with no inherited DB/provider credentials. Focused tests, no-ignore ESLint, CLI typecheck, and independent closure review are the acceptance gates.
- **Surfaces:**
  - `scripts/__tests__/ccc-golden-packet.test.mjs`
  - `scripts/lib/ccc-golden-packet.mjs`
  - `scripts/ccc-golden-evidence-ledger.mjs`
- **Why now:** lifecycle execution cannot be diagnosed until packet custody, proof mapping, and transactional import are independently green.
- **Steps:**
  1. RED: assert a generated proposal/sidecar/execution plan has exactly three tasks, the contract/core/CLI dependency chain, six disjoint worker-owned paths, phase-scoped baseline proofs, request/duration/concurrency bounds, canonical protected-action IDs, and no unresolved decisions.
  2. GREEN: construct the immutable PRD, support context, proposal, and per-task routes through existing `fn prd freeze`, authoring/compile, policy, preview, and transactional import seams.
  3. RED: corrupt one task dependency, owned path, proof phase, source hash, and target base in separate cases and require deterministic refusal with zero imported rows or files.
  4. GREEN: expose the minimum pure packet builder and transactional-import caller required by the tests.
  5. REFACTOR: keep proposal construction separate from CLI invocation and PostgreSQL lifecycle.
- **Verification:** `node --test scripts/__tests__/ccc-golden-packet.test.mjs`
- **Done when:** the exact packet imports once, replays idempotently, and every malformed variant refuses without residue.

### Task 3B: Build the disposable lifecycle and fake-worker campaign control

- **Status:** completed — 2026-08-30; the repaired stock one-task product slice passes 3/3 against honest disposable PostgreSQL, and the exact three-task Evidence Ledger fake campaign passes 3/3 in 67.43s at a durable unlanded merge hold. The control proves three ordered provider mutations/commits, task proofs for contract/core/CLI, one final integrated proof, exactly one merge approval, and an unchanged target `main`. Root-cause iterations closed generated Fusion-state ignore custody, transitive candidate and fixture closure, nested sandbox OpenSSL config propagation, controller-runtime-file custody, sorted semantic result sets, and missing baseline config closure without relaxing the verifier.
- **Surfaces:**
  - `scripts/__tests__/ccc-golden-campaign.test.mjs`
  - `scripts/lib/ccc-golden-campaign.mjs`
  - `scripts/ccc-golden-evidence-ledger.mjs`
- **Why now:** provider trials must prove the full CCC path rather than a standalone coding prompt, but process ownership must be tested separately from packet semantics.
- **Steps:**
  1. RED: run a deterministic fake worker through the campaign and require three isolated commits, contract/core/CLI phase proofs, integrated proof, exact route/harness receipts, and zero residue after owned cleanup.
  2. GREEN: start task-specific disposable PostgreSQL/Git resources through the repo's existing supervised-process seam, register each exact handle before use, execute the current CCC controller, collect evidence, and await only those owned processes during success, timeout, signal, and exception cleanup.
  3. RED: inject worker failure, verifier failure, timeout, and interrupted cleanup separately; require truthful terminal settlement, preserved redacted evidence, and no automatic replay or leaked process/worktree/database ownership.
  4. GREEN: implement the minimum recovery and evidence-preservation paths required by those failures.
  5. REFACTOR: keep lifecycle orchestration separate from project/verifier, packet, and receipt modules.
- **Verification:** `node --test scripts/__tests__/ccc-golden-campaign.test.mjs`
- **Done when:** the fake-backed full campaign passes twice from frozen PRD through integrated proof and every injected failure settles honestly.

### Task 4: Establish the Pi baseline and isolate the first failing transition

- **Status:** partial — 2026-08-30. The first complete live Pi cell reached the durable unlanded `approve-merge` hold in four requests: one fixture inspection, two owned-file writes, one passing `task verify:contract`, `fn_complete_phase`, one attributable task commit, and two admitted proof attempts (`task` plus `final_integrated`). Every settled request carried `omniRoute.final = cx/gpt-5.6-luna-max`. An identical replay failed before mutation when request 3 lacked the terminal SSE route receipt; CCC preserved it as `dispatched_unknown` and failed closed on uncertain external effect. Pi therefore proves Gate 1 once but not repeatably.
- **Surfaces:** disposable campaign roots and redacted receipts created by `scripts/ccc-golden-evidence-ledger.mjs`; production changes only if a failure is reproduced by a focused test.
- **Why now:** Pi is the current intended in-process CCC worker and must be measured before adapter work.
- **Steps:**
  1. Re-probe the exact configured and effective OmniRoute route without changing routing state.
  2. Run concurrency `1`, recommended three-task chain, file-first prompt, request ceiling `9`, and ten-minute campaign ceiling.
  3. If it fails, inspect request/tool chronology, first-mutation ordinal, phase transitions, compaction, proof, commit, and settlement; classify model, harness, bite, budget, route, custody, or external failure.
  4. Change one variable at a time: tiny single task, broad two-task bite, request ceilings `6` and `12`, current prompt versus file-first prompt. Stop unchanged cells per the design.
  5. For a proven product defect, capture a focused RED in the owning package, implement the minimum GREEN repair, refactor, and rerun the failed cell.
- **Verification:** exact per-run command recorded in the experiment receipt plus the owning focused Vitest command for every production repair.
- **Done when:** Pi either passes twice or has one precisely reproduced terminal blocker whose route and external ownership are proven.

### Task 5: Run the matched OpenCode benchmark and decide adapter scope

- **Status:** completed as a benchmark, not as a CCC adapter — 2026-08-30. OpenCode `1.18.3` blocked unattended `--auto` under the interactive role. Its referenced bounded autocode-worker profile was not installed. The configured OpenCode-Go Luna-Max route then returned 17 consecutive HTTP 500 errors across 18 attempts before the external 240-second timeout, with no JSON event or mutation; OpenCode supplied no retry ceiling. A task-local config copy routed the same prompt through `cx/gpt-5.6-luna-max`; that run completed in 207.476 seconds with 20 model steps, 38 tool events, three patch attempts, three contract-proof runs, a clean two-file commit `dd79719f3fbca162d2b7aeaff538761dacefffea`, and an independently replayed 9/9 contract proof. OpenCode did not expose a terminal upstream receipt, so its effective route remains `ROUTE_UNKNOWN` despite the configured `cx` model ID. The event normalizer was updated under RED/GREEN to accept the installed CLI's flat 1.18 event schema.
- **Surfaces:**
  - task-local disposable OpenCode config/data roots
  - `scripts/lib/ccc-opencode-events.mjs`
- **Why now:** OpenCode should not be adopted or rejected from feature lists or historical fanout failures.
- **Steps:**
  1. Verify `opencode-interactive` version/help/doctor and task-local directory behavior; do not use `--auto` or `--pure`. Invoke exactly `OPENCODE_DB=<run-root>/opencode.db /Users/ryanpappal/.opencode/bin/opencode-interactive run --format json --dir <disposable-repo> --model <live-admitted-model> --agent build --title <experiment-id> <prompt>` with standard input closed.
  2. Run the same frozen project, task bite, prompt, admitted model route where possible, budget, timeout, worktree, and verifier as the Pi baseline. Record prompt-prefix, argv, config, agent, tool-schema, and middleware hashes as treatment differences.
  3. Normalize structured events and compare success, first mutation, tools, retries, compactions, latency, usage, residue, permission denials, route proof, and review burden.
  4. If OpenCode exposes a material advantage, freeze the measured requirements in a separate `docs/plans/2026-08-29-ccc-opencode-runtime-design.md` and implementation plan, obtain artifact-bound AGY review, then proceed under the operator's existing end-to-end authority without pausing unless the design expands credentials, routing, remote, destructive, or other protected scope.
  5. If it does not, record the negative result and keep Pi as the worker while applying only independently proven harness repairs.
- **Verification:** fake-stream tests, exact benchmark receipts, and focused adapter tests if an adapter is implemented.
- **Done when:** the whole-harness decision follows paired evidence, treatment differences are explicit, and OpenCode is never described as lifecycle-proven without CCC custody/effect proof.

### Task 6: Re-prove the winning campaign and close readiness

- **Status:** completed with a partial readiness verdict — 2026-08-30. Current-source script tests passed 54/54, Pi/custom-provider/route tests passed 121/121, the fake three-task PostgreSQL campaign passed 3/3, the CLI packet/import PostgreSQL suite passed 7/7, and the stock product vertical slice passed 3/3 when the PostgreSQL controls were run serially. Engine and CLI typechecks, scoped lint, and `git diff --check` passed. Independent code review approved the final phase-custody and timeout repairs. Gate 1 is observed once through real Pi but is not repeatable because terminal SSE receipt settlement failed closed on replay; standalone OpenCode generated the project without CCC custody or route proof. Gate 2 remains unknown and is not implied by this closure.
- **Surfaces:** all files changed by Tasks 1-5, the final disposable target, experiment receipts, and this plan.
- **Why now:** one green run or child report is not product readiness.
- **Steps:**
  1. Run the winning cell twice from fresh disposable roots and require identical accepted behavior, effective route proof, clean task/worktree/process/PostgreSQL residue, and integrated verifier pass.
  2. Run all focused tests, `pnpm verify:fast`, `git diff --check`, and the repo's risk-proportionate gate for changed packages.
  3. Freeze the exact diff and hashes; obtain independent AGY adversarial review and a separate code-review subagent verdict; adjudicate every finding.
  4. After any material repair, rerun affected proof and one bounded independent closure review of the final bytes.
  5. Update this plan with final statuses, commands, observed results, route/harness verdict, remaining risk, and retained disposable evidence paths.
- **Verification:** `task ci` plus exact golden-campaign receipts and the final independent-review verdict, unless a narrower documented gate is justified by the final changed surface.
- **Done when:** every design success criterion is directly evidenced, no named proof is stale, and no required work remains.

## Next Lane

Add a deterministic regression around terminal SSE receipt loss after earlier committed requests, then choose a bounded recovery contract at the transport seam. Do not increase request budgets or build a first-class OpenCode adapter before route settlement is repeatable. The frozen conclusion is that explicit task contracts repaired the worker loop; Pi's remaining blocker is terminal-route receipt settlement, while OpenCode's measured advantages do not yet establish CCC lifecycle equivalence.
