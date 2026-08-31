# CCC Golden Campaign Execution Findings

## Bottom line

`OBSERVED`: CCC-Fusion can now give one precise coding task to real Pi, receive the intended two-file implementation, preserve an attributable commit, admit the task and final-integrated proofs, and stop at the unlanded merge approval hold. The successful cell used four provider requests and the terminal OmniRoute receipts named `cx/gpt-5.6-luna-max`.

`OBSERVED`: the same Pi cell did not repeat cleanly. Its replay failed before mutation when the third provider response omitted the terminal SSE route receipt. CCC correctly preserved that attempt as `dispatched_unknown` and required uncertain-effect recovery rather than pretending the route was proven. This is a transport/receipt-settlement repeatability failure, not evidence that the model failed to generate the project on replay.

`OBSERVED`: standalone OpenCode also produced and committed the project when routed through the same configured `cx/gpt-5.6-luna-max` model ID. It was slower and much heavier, and it did not expose a terminal upstream receipt. OpenCode is therefore useful benchmark evidence, not a proven CCC runtime replacement.

## The actual pinch points

### Task contract, not task size

The one-task bite owned only `src/record.mjs` and `src/validation.mjs`. Early Pi cells still exhausted 3 and then 9 requests without a mutation because the task omitted the public exports and exact validation rules. Pi spent its budget reverse-engineering the verifier.

After the packet named `parseEvidenceLine(line, lineNumber)`, `validateEvidenceRecords(records)`, the strict record schema, and the edit/proof sequence, Pi wrote both files on request 2 and invoked `task verify:contract` on request 3.

The next hidden constraint was the verifier's static boundary. Both Pi and OpenCode initially used `new Date(...)`; the verifier forbids it. Once the task explicitly required arithmetic calendar validation and named the forbidden static surfaces, Pi passed on its first proof run.

`INFERRED`: the original no-progress symptom was primarily a task-affordance failure amplified by a loose inner tool loop. The bite was not too large in file count.

The final three-task packet now gives the contract, core, and CLI tasks the same class of explicit API, behavior, static-boundary, first-edit, and first-proof instructions. The deterministic three-task campaign passes, but no live three-task provider run was purchased after the one-task replay exposed the transport blocker.

### Request and tool budgets

- 3 requests: too small even for initial inspection and implementation.
- 5 requests with the public API stated: enough to edit and run a first proof, but not enough to diagnose and repair a hidden static-boundary failure.
- 9 requests with the static boundary still hidden: enough for work, but Pi used the remaining requests on repeated verifier reads.
- 6 requests with the complete contract: sufficient; the successful cell used 4.

`INFERRED`: a campaign request cap is necessary but not sufficient. Pi still lacks a repair-phase repeated-read budget or first-mutation tripwire. Those controls would have made the bad cells cheaper, but they would not have repaired the missing task contract.

### Pi is not vanilla

CCC wraps Pi with request reservations, duration bounds, explicit route binding, terminal-route receipt reconciliation, worktree and path custody, a required commit fence, semantic proof admission, execution and merge holds, durable status, and uncertain-effect recovery. The successful cell exercised those controls.

The inner coding loop is still close to an unconstrained Pi session. The observed weak points were repeated verifier reads, no first-edit or repair-read tripwire, and route receipt fragility on replay.

### OpenCode is more harnessed, but not automatically safer

OpenCode's installed interactive role refused unattended `--auto`, kept containment plugins active, loaded skills, created a todo plan, used patch tools, ran proof repeatedly, committed exact owned files, and ended cleanly.

It also incurred large harness overhead: 3 skill calls, 4 todo updates, 16 reads, 10 shell calls, 3 patch calls, 20 model steps, and 38 total tool events. The run lasted 207.476 seconds.

The configured OpenCode-Go Luna-Max route returned 17 consecutive HTTP 500 errors across 18 attempts before the external 240-second timeout. OpenCode emitted no JSON error event, made no mutation, and supplied no internal retry ceiling. The working direct-`cx` cell required a task-local config copy.

`INFERRED`: OpenCode has better operator-role containment and richer coding middleware, but its retry control and route-proof custody are currently weaker than CCC's Pi path. A first-class adapter should not be adopted from this benchmark alone.

The comparison is a whole-harness diagnostic, not a raw model leaderboard. Pi ran inside CCC custody with terminal-route enforcement; OpenCode ran standalone with a task-local configuration and no effective-route receipt. Tool counts and latency therefore describe the observed harnesses, not model quality.

### Harness hardening discovered during closure

- The generated verifier now distinguishes local CLI and integrated project proof without Taskfile environment behavior, which CCC semantic-proof custody correctly forbids. CLI and project use distinct declared candidate-input order; an explicit phase selector with mismatched inputs fails closed.
- OpenCode 1.18 flat events and non-JSON diagnostics interspersed after stream start normalize without losing the warning or accepting malformed JSON envelopes.
- The Pi custom-provider loader now honors runtime `HOME`, and its tests install the synthetic provider in the Vitest supervisor-owned isolated HOME so subprocess re-isolation cannot invalidate the fixture.
- The CLI PostgreSQL golden config uses a 30-second integration timeout. PostgreSQL acceptance commands must run serially: concurrent execution produced resource-contention timeouts that disappeared on serial replay.

## Golden evidence

### CCC-Fusion Pi success cell

- Packet: one semantic task, two owned files, request cap 6, duration cap 180 seconds, concurrency 1.
- Requested binding: `golden-omniroute-luna / cx/gpt-5.6-luna-max / pi`.
- Provider requests used: 4.
- Tool sequence: fixture inspection, write `src/record.mjs`, write `src/validation.mjs`, `task verify:contract`, `fn_complete_phase`.
- Proof attempts: 2 committed (`task`, `final_integrated`).
- Terminal boundary: one unlanded `approve-merge` hold; target `main` unchanged.
- Effective upstream receipts: every settled request contained `omniRoute.final.provider = cx` and `omniRoute.final.model = gpt-5.6-luna-max`.
- Automated replay: `HONEST_RED` because request 3 had no terminal SSE route receipt and settled as an uncertain external effect.
- Classification: CCC route-settlement repeatability `FAIL`; model generation on replay `UNVERIFIED` because CCC stopped before mutation.

### Standalone OpenCode success cell

- Disposable repository: `/tmp/ccc-golden-opencode-parent.YUjwGv/project`.
- Baseline commit: `573514fe1679ee77ba08b175dfc9267b49fe6d70`.
- Generated commit: `dd79719f3fbca162d2b7aeaff538761dacefffea`.
- Generated tree: `260b8b09e2b52332162230374630ffc190a4d477`.
- Changed files: only `src/record.mjs` and `src/validation.mjs`.
- Independent proof: `task verify:contract` exited 0 with 9/9 clauses passed.
- Working tree after commit: clean.
- Configured model ID: `cx/gpt-5.6-luna-max` through temporary config SHA-256 `c3b1af604b93685df334d022553286784bf599f747958a1d5e00cf5138af6b96`.
- Effective upstream: `ROUTE_UNKNOWN`; OpenCode emitted no terminal upstream receipt.
- Event stream SHA-256: `3ca47a20c95bece135f7bcca1115a4d53fc7df0d756156c807a4a99b81d6984a`.
- Normalized receipt: `docs/plans/evidence/2026-08-30-ccc-golden-opencode-cx-r1.events.json`, SHA-256 `d93869789686ccb322095b8ff9c868af8e3596b9bcca3ee868ebbc88c2d44538`.
- Prompt SHA-256: `cc7d45de4b4ff283dd2c0f873b3480e9bcae16c1bad9ead0dcbda5c518ebeed4`.
- Argv SHA-256: `81d0e9ad3b27fd5f3a48b254b787aab5e2576f640330bf3917cf734b1122e189`.

## Readiness verdict

- Gate 1 worker loop: `PARTIAL`. One real Pi campaign fully crossed mutation, commit, proof, and operator-hold boundaries, but its identical replay failed on route-receipt settlement.
- OpenCode benchmark: `PARTIAL`. It generated a correct project, but outside CCC lifecycle custody and without effective-route proof.
- Gate 2 whole-product acceptance: `UNKNOWN` in this work slice. No claim of product readiness follows from Gate 1.

## Final verification

- Golden script suite: 54/54 passed.
- Pi/custom-provider/route-receipt suite: 121/121 passed.
- Fake three-task PostgreSQL campaign: 3/3 passed at the unlanded merge hold.
- CLI packet/import PostgreSQL suite: 7/7 passed with the default golden config.
- Stock product vertical slice: 3/3 passed when run serially.
- Engine and CLI typechecks: passed.
- Scoped lint and `git diff --check`: passed; ignored-test warnings were rerun through repo-native typecheck and direct Vitest surfaces.
- Independent code review: approved after the phase-custody and timeout findings were repaired.
- AGY adversarial review: its true phase-selector, task-brief, and interspersed-event findings were repaired; the claimed macOS `/tmp` OpenSSL failure was refuted by a real `/tmp` integrated proof, and raw extra receipt fields are already rejected by the closed schema.

## Smallest next action

Add a deterministic regression around terminal SSE receipt loss after earlier committed requests, then decide whether the transport should retry inside the same reserved attempt, expose a bounded recoverable error, or remain an operator-owned uncertain-effect stop. Do not raise campaign request caps or add a first-class OpenCode adapter until that receipt path is repeatable.
