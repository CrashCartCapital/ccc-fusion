# CCC-Fusion Gate 2 Installed Live Acceptance Evidence

## Verdict

Gate 2 passed on commit `27b29351dfa8fb363cb3f43d3d10aa3afbe02bcf` (tree `de4df58ec2b4e722cd5ece99c2c071f6cad73ac7`) combined with the deterministic 39-check canary (pueue `1550`, `git rev-parse HEAD | grep -qx 27b29351d... && corepack pnpm verify:ccc-prd-product`, all 39 `exactChecks` passed, `headCommit`/`headTree` match current HEAD) and the full acceptance gate (pueue `1562`, `env VITEST_MAX_WORKERS=1 task gate`, every stage green).

The clean lane (pueue `1554`) generated and landed a six-task telemetry service through real Pi/OmniRoute workers, proved all seven semantic proof groups, passed all six external usefulness cases, used only the three required effective upstreams (GLM, MiniMax, Gemini 3.8 Flash) across 385 committed provider attempts with zero dispatched-unknown and zero Luna/GPT matches, and left the disposable target clean. The recovery lane (pueue `1555`) and the operator-stop lane (pueue `1561`, which reruns and supersedes a teardown-flaked `1556`) each passed independently without provider dispatch.

### G2-01..G2-08 acceptance matrix

| Requirement | Proof source | Result |
|---|---|---|
| G2-01 normal PRD entry | Clean lane (1554) landing evidence: unchanged source hashes, `landingEvidence.status: passed`, imported six-task DAG (KB-001..KB-006) | passed |
| G2-02 real peer routing | Clean lane (1554) requested->effective route table: 385/385 attempts `committed`, 0 dispatched-unknown, 0 Luna/GPT matches | passed |
| G2-03 safe fanout/join | Clean lane (1554) 7/7 proof groups, including `PROOF-TELEMETRY-CANDIDATE`/`PROOF-TELEMETRY-INTEGRATED` joining the KB-002/KB-003/KB-005 leaves into KB-006 | passed |
| G2-04 useful artifact | Clean lane (1554) `PROOF-TELEMETRY-INTEGRATED` (all 6 AC clauses plus its own negative control) and usefulness 6/6 | passed |
| G2-05 recovery | Recovery lane (1555): restart completed, continuity verified, target head unchanged, 0/0 provider and proof attempts before/after restart | passed |
| G2-06 operator controls | Operator-stop lane (1561): pause -> resume -> stop sequence verified, provider execution `not_started`, 1 cancelled work item | passed |
| G2-07 installed runtime | Installed-runtime custody: 7 SHA-256s hash-bound, receipt digest identical across clean/recovery/stop | passed |
| G2-08 controlled landing | Clean lane (1554) landing evidence: `CCC_PRD_MERGE_CONFIRMATION_REFUSED` stale refusal recorded, then exactly one fresh confirmed landing (`56a8d0b1e6828cee764b24ffded761c67f465988`) | passed |

## Installed runtime custody

- Receipt file: `/tmp/ccc-gate2-installed-runtime-final8-27b29351d.KUtVJw/installed-runtime-receipt.json`, schema `ccc-gate2.installed-runtime.v1`.
- Receipt file SHA-256: `1bea995ad704af760104c400bd478fbc9ec5d1b64201b5ab8c975d34774ceb73`.
- The receipt JSON carries no internal commit field; source-commit binding lives in each evidence file's `sourceCommit`/`sourceTree`, not the receipt itself.
- Installed-runtime receipt digest (`installedRuntimeReceiptDigest`/`receiptDigest`, echoed in `runtimeExecutionBoundary.installedRuntime.receiptDigest` in all three evidence files): `320e85009a55a260395dd64fea369c90dee394ef3a0998a214f0d97876d7bf96`.
- Package tarball SHA-256: `8adabc9bbe75749ed713bf01ff01f0414d426131db6063f6b7efb7a9d9c64928` (`@runfusion/fusion` `0.73.0-beta.4`, `versionOutputSha256` `061e442b79755e85bd728e48be39343df6b9ddb7b2d50d2f5b2dc8391110dbd8`).
- Installed `fn` SHA-256: `77208b6842c6b1b8adce8d5859742f88843dbba329de34cccf87eaa35d071a77`.
- Installed controller SHA-256: `73459dcc2178c74f71408a8b1cf5b1ab79d6d455256730a6f9a7259d3895842a`.
- Installed runtime host SHA-256: `e5cd15a4638e1c294c01be81ddc8cc6033cfca48b86aaf30560ffd108d59483d`.
- Combo snapshot file SHA-256 (`combo-snapshots-management.json`): `01357a5dee46347db7fc1fe063c546a19ab6387d9b7a2c5400c52b167f032b38`.

All four shasum-verified artifact hashes (tarball, `fn`, controller, runtime host) match the values the receipt records internally -- no drift. Receipt `artifactScope.installedRuntime` surfaces: `fn-cli, prd-controller, semantic-proof-toolchain, central-core, task-store, in-process-runtime, proof-admission-host, provider-config`; `sourceInProcessScheduler: not_used`, `fullInstalledRuntime: not_claimed_daemon_process`, `installedInProcessRuntime: receipt_bound` -- identical framing appears in the `runtimeExecutionBoundary` block of every evidence file (clean/recovery/stop).

### Combo snapshot terminal route members

| Combo | Alias | Terminal route members (ordered) | Digest |
|---|---|---|---|
| minimax | `minimax-latest` | `minimax/MiniMax-M3` | `bd1c620e78be5bd3316b37b589cfc0bf7f9ebdff5f0ca98fb791c411ce72311e` |
| glm | `glm-latest` | 1. `glm/glm-5.3` 2. `minimax/MiniMax-M3` (fallback) | `141b767ce10f3d6ae7ce1fefd09d501b47683261a7e10bf7d2ba35b3c312abd0` |
| gemini | `gemini-flash-latest` | 1. `antigravity/gemini-3.8-flash-high` 2. `gemini/gemini-flash-latest` (fallback) | `de05b713b7df99b0f6c659dce6136e99fab63008ce8a956bd1bcbea8a0ae3365` |

The combo snapshot was resealed from live OmniRoute on 2026-09-02 (`updatedAt: 2026-09-02T19:29:42.366Z` for the gemini combo) to admit `antigravity/gemini-3.8-flash-high` as the golden Flash peer, replacing `antigravity/gemini-3.7-flash-high` from the e731ac876 doc, matching repair commit `53b367cf8 fix(ccc): admit Gemini 3.8 Flash as the golden Flash peer`. The minimax and glm combos are unchanged since 2026-08-26.

## Clean whole-product lane

- Pueue task: `1554`, label `ccc-gate2-final8-clean-27b29351d`, result Success.
- Pueue window: 17:29:32-17:53:50 PT (24m18s wall); vitest-internal duration `1457.49s` (~24.3 min).
- Run ID: `clean-final8-27b29351d`; idempotency key `ccc-gate2-telemetry-clean-final8-27b29351d-clean`.
- Evidence path: `/tmp/ccc-gate2-installed-runtime-final8-27b29351d.KUtVJw/evidence/clean-final8-27b29351d.json`.
- Evidence SHA-256: `89c0871ccf2404140ec6f3e3d31a35828248b365116a952727070cb5d165c7df` (1,750,569 bytes), schema `ccc-gate2.telemetry-live-evidence.v1`.
- `outcome: passed`, `statusExitCode: 0`, `runMode: clean`.
- `gate2Readiness`: `{status: proved, reason: landing_and_usefulness_passed}`.

### Landing

- `landingEvidence.status: passed`, `landingEvidence.applicability: required`.
- Product source commit/tree: `5b7f9a0d643406c4481479ae7edfc4712c494d2b` / `6030f03ad3984eb28b60f6ad734225e9993ab9b6`.
- Controlled landed commit: `56a8d0b1e6828cee764b24ffded761c67f465988`.
- `target.baseCommit` / `target.mainCommit`: `ab0777034647f1f721897635ba9b903dcc16f345` / `56a8d0b1e6828cee764b24ffded761c67f465988`.
- `duplicateEffectPrevented: true`.
- Stale-refusal proof present: `staleRefusal[0]` shows `CCC_PRD_MERGE_CONFIRMATION_REFUSED` correctly refused before the fresh confirmed replay landed.

### Proof groups -- 7/7, one committed attempt each (all `exitCode: 0`, `success: true`)

| Proof ID | Command | taskId | semanticTaskId | phase | state | source commit |
|---|---|---|---|---|---|---|
| `PROOF-TELEMETRY-CONTRACT` | `task verify:contract` | KB-004 | TASK-TELEMETRY-CONTRACT | task | committed | `be782575d0ab4872601f1ccbdc2e0760f5dc4ae6` |
| `PROOF-TELEMETRY-INGEST` | `task verify:ingest` | KB-005 | TASK-TELEMETRY-INGEST | task | committed | `973ae2739bb51e7ff8c0f0bdaa63be3dcb53e2b4` |
| `PROOF-TELEMETRY-AUDIT` | `task verify:audit` | KB-001 | TASK-TELEMETRY-AUDIT | task | committed | `c7269c7ed46dd8dfdb502651cd65344eca910e5d` |
| `PROOF-TELEMETRY-BROADCAST` | `task verify:broadcast` | KB-002 | TASK-TELEMETRY-BROADCAST | task | committed | `b7090f7b182ce33c8a4d8257d2dd155180ac2e60` |
| `PROOF-TELEMETRY-CLI` | `task verify:cli` | KB-003 | TASK-TELEMETRY-CLI | task | committed | `fd341cc4b44c83d18ca112c0a74e4e89cc482901` |
| `PROOF-TELEMETRY-CANDIDATE` | `task verify:candidate` | KB-006 | TASK-TELEMETRY-INTEGRATE | task | committed | `5b7f9a0d643406c4481479ae7edfc4712c494d2b` |
| `PROOF-TELEMETRY-INTEGRATED` | `task verify:integrated` | KB-006 | TASK-TELEMETRY-INTEGRATE | final_integrated | committed | `5b7f9a0d643406c4481479ae7edfc4712c494d2b` |

All clause/positive-case/negative-control results embedded in each proof's stdout are `passed: true`. `PROOF-TELEMETRY-INTEGRATED` covers all 6 AC clauses (contract/ingest/audit/broadcast/cli/integrate) plus its own negative control, matching the "integrated proof" role from the e731ac876 doc.

### Usefulness -- 6/6 (`usefulnessEvidenceState.status: passed`, `reason: usefulness_probe_passed`)

| caseId | passed |
|---|---|
| `valid-event-post` | true |
| `invalid-event-4xx` | true |
| `sse-delivery` | true |
| `audit-survives-restart` | true |
| `cli-healthy` | true |
| `cli-unavailable` | true |

- `usefulnessEvidence.sourceCommit`/`sourceTree`: same as landed source (`5b7f9a0d64...` / `6030f03ad3...`); `detachedCheckout.clean: true`.
- Loopback probe reserved port `57143`; process exit `{exitCode:0, signal:null, durationMs:2494}`.
- Cleanup: `processGroupStopped: true` (posix-kill-zero verified absent after exit, pgid 52579, darwin), `checkoutRemoved: true`, `scratchRemoved: true`. `finalTargetStatus: passed`.

### Per-semantic-task provider attempts

| semanticTaskId | taskId | providerId/modelId (requested) | attemptCount | committed | dispatched-unknown | totalRequestCount | maxRequestCount (final attempt's cumulative count) |
|---|---|---:|---:|---:|---:|---:|---:|
| TASK-TELEMETRY-CONTRACT | KB-004 | golden-omniroute-glm-latest / combo/glm-latest | 12 | 12 | 0 | 78 | 12 |
| TASK-TELEMETRY-AUDIT | KB-001 | golden-omniroute-glm-latest / combo/glm-latest | 27 | 27 | 0 | 3,021 | 162 |
| TASK-TELEMETRY-BROADCAST | KB-002 | golden-omniroute-gemini-flash-latest / combo/gemini-flash-latest | 35 | 35 | 0 | 2,205 | 116 |
| TASK-TELEMETRY-CLI | KB-003 | golden-omniroute-gemini-flash-latest / combo/gemini-flash-latest | 54 | 54 | 0 | 12,501 | 258 |
| TASK-TELEMETRY-INGEST | KB-005 | golden-omniroute-minimax-latest / combo/minimax-latest | 130 | 130 | 0 | 15,606 | 204 |
| TASK-TELEMETRY-INTEGRATE | KB-006 | golden-omniroute-minimax-latest / combo/minimax-latest | 127 | 127 | 0 | 40,894 | 385 |

Totals: 385 attempts, all `state: committed`, 0 dispatched-unknown; sum of `requestCount` across all attempts = 74,305. `providerAttempts` terminal `kind` is `reconciled` for all 385 rows; `observerId` is `pi` for all.

### Requested -> effective route

| Requested peer | Effective upstream | Tasks | Attempts |
|---|---|---:|---:|
| `combo/glm-latest` | `glm/glm-5.3` | 2 (KB-001, KB-004) | 39 |
| `combo/gemini-flash-latest` | `antigravity/gemini-3.8-flash-high` | 2 (KB-002, KB-003) | 89 |
| `combo/minimax-latest` | `minimax/MiniMax-M3` | 2 (KB-005, KB-006) | 257 |

No attempt fell back to a combo's secondary route member (glm never fell back to minimax; gemini never fell back to `gemini/gemini-flash-latest`). Luna/GPT check: a raw `grep -a -io "luna\|gpt"` over the entire 1.75 MB `clean-final8-27b29351d.json` returns zero matches; the 199,828-char serialized `agentDiagnostics` also contains no `luna`/`gpt` substring, confirming no unrecorded or foreign effective route.

### Campaign envelope

| Field | Value |
|---|---|
| `taskCount` | 6 |
| `maxRequests` | 2,304 |
| `maxDurationMs` | 21,600,000 (360 min / 6h) |
| `maxConcurrency` | 3 |
| `contextWindow` | 200,000 |
| `maxOutputTokens` | 32,768 |
| `taskTokenBudget.soft` | 500,000,000 |
| `taskTokenBudget.hard` | 600,000,000 |

The e731ac876 doc reported task token budgets of 5,000,000 soft / 10,000,000 hard. This run's envelope (identical in clean/recovery/stop) records 500,000,000 soft / 600,000,000 hard -- two orders of magnitude larger, landed by repair commit `0d7498f53`. Every other envelope field (taskCount, maxRequests, maxConcurrency, contextWindow, maxOutputTokens, maxDurationMs) matches the old doc exactly. No task or limit ended the run (no `failure`, `statusExitCode: 0`).

### Process/runtime hygiene

Pueue log 1554 shows one nonfatal `(node:23867) MaxListenersExceededWarning: ... 11 exit listeners added to [process]` -- the same class of warning the e731ac876 doc flagged as follow-up work, still present. No test failures or residue otherwise; `Test Files 1 passed (1)`, `Tests 1 passed (1)`. No `[token-cache-metrics]` line appears in the 1554 log (grepped raw log, zero hits).

## Recovery lane

- Pueue task: `1555`, label `ccc-gate2-final8-recovery-27b29351d`, result Success.
- Pueue window: 17:53:50-17:54:14 PT (24s); vitest duration `23.05s`.
- Run ID: `recovery-final8-27b29351d`.
- Evidence path: `/tmp/ccc-gate2-installed-runtime-final8-27b29351d.KUtVJw/evidence/recovery-final8-27b29351d.json`.
- Evidence SHA-256: `adeaee593a33d3954cae0c870b28b01cac2e71ea1c750e2de54b19369a0ea49f` (9,996 bytes).
- `outcome` / `statusExitCode`: `passed` / `0`.
- `recoveryBoundary.recoveryKind`: `installed_runtime_restart`; `recoveryBoundary.durableBoundary`: `live_execution_approval_hold`.
- `restartCompleted` / `continuityVerified`: `true` / `true`.
- `providerAttemptsBeforeRestart` / `AfterRestart`: `[]` / `[]` (0/0).
- `proofAttemptsBeforeRestart` / `AfterRestart`: `[]` / `[]` (0/0).
- Target head (unchanged before/after restart): `a18aa5cbc4061bcc3318a580c9bd1b0259d1eb17`.
- `gate2Readiness`: `{status: not_proven, reason: operational_recovery_lane_not_whole_product}` -- correct, since this lane lands no candidate.
- `usefulnessEvidenceState`: `not_applicable` (`operational_recovery_lane_has_no_landed_candidate`).
- `installedRuntimeReceiptDigest` echoed in `runtimeExecutionBoundary`: `320e85009a55a260395dd64fea369c90dee394ef3a0998a214f0d97876d7bf96` -- same receipt as the clean lane.

## Operator-stop lane

The cited stop-lane evidence is the rerun, pueue `1561` (`stop-final8b-27b29351d`); a first attempt at pueue `1556` (`stop-final8-27b29351d`) is superseded because its Gate 2 assertions passed but a PostgreSQL test-harness teardown timed out after the assertions completed, marking the pueue task Failed for reasons unrelated to Gate 2 correctness.

### Cited: pueue 1561 (`stop-final8b-27b29351d`) -- PASS, no caveats

- Pueue task: `1561`, label `ccc-gate2-final8b-stop-27b29351d`, result Success.
- Pueue window: 17:56:22-17:57:36 PT (74s); vitest duration `72.93s`, `Test Files 1 passed (1)`, `Tests 1 passed (1)` -- no teardown error this time.
- Run ID: `stop-final8b-27b29351d`; idempotency key `ccc-gate2-telemetry-stop-final8b-27b29351d-stop`.
- Evidence path: `/tmp/ccc-gate2-installed-runtime-final8-27b29351d.KUtVJw/evidence/stop-final8b-27b29351d.json`.
- Evidence SHA-256: `6d71463e663b3b357b44cb6bdee811bcf72a2f77f5220168fc975fa45a410c26` (549,486 bytes).
- `outcome` / `statusExitCode`: `passed` / `0`.
- `stopBoundary.stopKind`: `operator_control_before_provider_dispatch`; `stopBoundary.providerExecution`: `not_started`.
- `stopBoundary.quietWindowVerified` / `terminalStopVerified`: `true` / `true`; `stopBoundary.finalNextAction`: `abandoned`; `stopBoundary.cancelledWorkItems`: `1`.
- `controls` sequence: 3 entries -- `campaign-paused` (held) -> `campaign-resumed` (runnable) -> `campaign-stopped` (cancelled), all `unresolvedEffectsPreserved: false`.
- `providerAttempts` count: `0`; `proofs` count: `7` (proof definitions present, 0 attempts -- no dispatch occurred).
- `gate2Readiness`: `{status: not_proven, reason: campaign_stopped_before_landing}` -- correct.
- `target.baseCommit`/`mainCommit` (fresh disposable checkout, unchanged/clean): `d582af643b8d9729bf625ddcda5e7599d4780429`.
- `runtimeExecutionBoundary.installedRuntime.receiptDigest`: `320e85009a55a260395dd64fea369c90dee394ef3a0998a214f0d97876d7bf96` -- same receipt as the clean and recovery lanes.

Structurally identical to the superseded 1556 run (same 3-control sequence, same cancelled-work-item pattern, same receipt digest) -- only the disposable target commit and run id differ, as expected for a fresh rerun.

### Superseded: pueue 1556 (`stop-final8-27b29351d`) -- test passed, PG teardown timed out

Pueue task `1556` (result `{"Failed": 1}`, window 17:54:14-17:55:10 PT) has its own evidence still on disk (`.../evidence/stop-final8-27b29351d.json`, SHA-256 `ffab43e95dc993866f2bccf6e01173bc75ba9b3db184f57fcc445e7a0bba8664`, 549,478 bytes) and the Gate 2 stop-lane assertions inside it passed (`outcome: passed`, identical `stopBoundary`/`controls`/`gate2Readiness` shape to the 1561 run, target head `d461321dc6cc9a7da874d851e4af83edf3bdd916`; `CCC Gate 2 telemetry live Pi campaign (stop) > runs the selected installed-runtime Gate 2 lane` passed in 20648ms). The pueue task shows Failed solely because the suite's `afterAll` PostgreSQL test-harness teardown timed out after the Gate 2 assertions completed: `Error: PostgreSQL test harness teardown failed at drop-database; retained redacted diagnostic packet`, caused by `adminExec timed out after 15000ms: DROP DATABASE IF EXISTS "fusion_ccc_gate2_stop_stop_final8_27b29351d_59314_1_w5zklo" WITH (FORCE)`. `Test Files 1 failed (1)` / `Tests 1 passed (1)` -- the vitest file was marked failed solely by this teardown timeout, consistent with host/DB load contention from a concurrent pueue chain, not a Gate 2 correctness defect. This run is kept here only as a noted, explained retry; it is not cited as the stop-lane evidence.

## Final source verification

- Canary: pueue `1550`, label `ccc-gate2-final8-canary-27b29351d`, result Success, window 17:23:42-17:29:00 PT. Result JSON schema `ccc-prd-product-acceptance.v1`, `result: pass`, `startedAt`/`completedAt` `2026-09-03T00:23:43.262Z`/`2026-09-03T00:28:45.588Z`. `exactChecks` count: 39 (confirmed by parsing the embedded JSON; all 39 check ids listed, no partial output). `target.baseCommit` `625002ba5423d3b62418e9b7126f9b9728ac578f`, `target.campaignCommit` `da4543b48c68c2dd2639b5315eff2b214731fc11`, `target.landedCommit` `610dd1e98926578ee17562ff897774a295222eb3`, `target.fanoutBase` `80046ad3269a746482ac759fbb3778f298db6ede`. `headCommit`/`headTree` (in `exactChecks[0].evidence`): `27b29351dfa8fb363cb3f43d3d10aa3afbe02bcf` / `de4df58ec2b4e722cd5ece99c2c071f6cad73ac7` -- match current HEAD.
- Build: pueue `1551`, result Success, window 17:29:00-17:29:02 PT.
- Install: pueue `1552`, result Success, window 17:29:02-17:29:31 PT.
- Gate: pueue `1557` (dependent on the superseded 1556) is `Done` with result `DependencyFailed` and never ran; the cited gate run is pueue `1562`, label `ccc-gate2-final8b-gate-27b29351d`, command `... && env VITEST_MAX_WORKERS=1 task gate`, depending on `1561`. Result: `Done`/Success, window 17:57:36-17:59:19 PT (103s). Full `task gate` acceptance chain, every stage passed:

| Stage | Result |
|---|---|
| `check-no-nohup`, `check-no-kill-4040`, `check-no-getdatabase`, `check-no-node-only-core-imports-in-dashboard`, `check-pi-versions-pinned`, `check-no-test-timeout-appeasement`, `check-changeset-format`, `check-mock-completeness` | all passed (mock-completeness explicitly logs "all hardcoded mocks cover source imports" for both `@fusion/dashboard` and `@fusion/engine`) |
| `@fusion/core test:pg-gate` (`handoff-to-review-atomicity.pg.test.ts`, `task-lifecycle-e2e.pg.test.ts`) | 2 files / 10 tests passed |
| `@fusion/engine test:core` (`--project=engine-core`) | 16 files / 300 tests passed (engine-core gate bundle rebuilt from 381 first-party inputs in 45ms) |
| `pnpm test:ccc-prd-safety`: `@fusion/core process-supervisor.test.ts` | 1 file / 8 tests passed |
| `@fusion/engine run-verification-command.test.ts` + `ccc-campaign-proof-execution.test.ts` | 2 files / 74 passed, 3 skipped (77 total) |
| `@runfusion/fusion prd.test.ts` (cli) | 1 file / 51 tests passed |
| `@fusion/core` PG `ccc-prd-product-status.pg.test.ts` | 1 file / 15 tests passed |
| `@runfusion/fusion test:ci-shape` (`ci-workflow.test.ts`) | 1 file / 85 tests passed |

Full `task gate` acceptance run is green on commit `27b29351d` via the 1561 -> 1562 rerun chain.

As context prior to this installed-live run, commit `0d7498f53` had already passed local lint, typecheck, and 281 focused tests -- narrower proof that held before the live campaign was launched.

## Iteration findings

The live campaign exposed four distinct issues that narrower proof surfaces had missed:

1. A standards-valid SSE comment frame was mistaken for the first data event. Commit `07986c87b` made the outer probe skip control frames while preserving event validation; commit `487eb42e1` applied the same rule to the inner verifier.
2. A generated server flushed headers before registering its subscriber, losing a concurrent event. Commit `7030363f7` added causal worker guidance and a deterministic ordering rejection.
3. A generated server placed SSE on `GET /events` instead of `GET /stream`, while its self-authored tests validated the same mistake. Commit `487eb42e1` added an independent behavioral `/stream` proof for status, content type, and delivery.
4. A signal-terminated child has `exitCode === null` and a non-null `signalCode`; the usefulness shutdown path attached a second listener after exit and stranded top-level await. Commit `06e86bc4e` made shutdown signal-aware and armed one reusable exit promise before termination.
5. Slash-prefixed `rg` and `grep` search patterns such as `/stream` were misclassified as foreign filesystem traversal. Commit `29b0d1b2f` made the Pi guard distinguish the pattern operand from path operands and preserved refusal of real foreign roots.
6. Signal-terminated service startup was reported as a generic health timeout. Commit `29b0d1b2f` now reports both exit code and signal through the shared signal-aware exit predicate.
7. The golden Vitest child watchdog was 10 minutes while the controller verifier could legitimately use 15 minutes by default and 30 minutes when configured. Commit `d7dfef13b` moved the outer guard behind the controller's maximum plus kill grace; failed run `1380` is retained as the RED signature.
8. Concurrent fanout could read request count `28` and provider history `29` across two READ COMMITTED statements, falsely creating dispatched-unknown custody. Commits `b08c1603a` and `e731ac876` added a deterministic lock regression, explicit settlement locking, and repeatable-read status snapshots; failed run `1391` is retained as the RED signature.

The post-e731ac876 commits landed four more product-side and process-side gaps before this run:

9. CLI-read provider settlement snapshots could reflect an in-flight, unsettled write under concurrent fanout. Commit `efdc057da fix(ccc): lock CLI provider settlement snapshots` locks the settlement snapshot the CLI reads.
10. The live executable's SSE wiring had no proof against a real running process, only against fakes. Commit `b323a50f6 fix(ccc): prove live executable SSE wiring` adds a live-process SSE wiring proof.
11. Loopback proofs did not bind to the exact reserved port, leaving room for a port-mismatch false pass. Commit `a5ca712d6 fix(ccc): admit exact-port loopback proofs` admits only exact-port loopback proofs.
12. Execution could proceed against a copied scratch directory instead of the authoritative one. Commit `21faf20e9 fix(ccc): refuse copied scratch before execution` refuses copied scratch before execution begins.
13. Loopback readiness proofs were not admitted by the evaluator. Commit `13df9c80e fix(ccc): admit loopback readiness proofs` admits them.
14. Repair execution could run outside the custody boundary, and the task token budget was undersized at 5,000,000 soft / 10,000,000 hard for real live-model usage. Commit `0d7498f53 fix(ccc): keep repair execution inside custody` keeps repair execution inside custody and raises the task token budget to 500,000,000 soft / 600,000,000 hard (carried into this run's campaign envelope, above).

This session's repair series (`e731ac876..HEAD`, five commits) fixed five more defects, each caught by a live or sandboxed run rather than a narrower proof surface:

15. **`f94b33b98` -- give the Gate 2 live lane a startup budget.** Symptom: pueue `1500` and `1504` failed with the live-lane `beforeAll` exceeding its hook timeout. Root cause: `beforeAll` spawns 12 subprocesses, taking roughly 12s when the host is idle but 169-187s under host load, against a 45s `hookTimeout`. Fix: raised the per-hook budget to 900s. Proof: the operator-stop lane alone completed its full lifecycle in 38s, well inside the new budget, with no further `beforeAll` timeouts across the remaining runs in this series.
16. **`53b367cf8` -- admit Gemini 3.8 Flash as the golden Flash peer.** Symptom: pueue `1518` refused the gemini route with "not an admitted terminal member." Root cause: OmniRoute's live `gemini-flash-latest` combo had moved to `gemini-3.8-flash-high` while the driver's matrix was still pinned to `3.7`. Fix: bumped the matrix pin and resealed the combo snapshot via `fetchGoldenOmniRouteComboSnapshot`. Proof: this run's clean-lane routing table (above) shows `antigravity/gemini-3.8-flash-high` as the effective upstream for both gemini-routed tasks with zero refusals.
17. **`13c1c32b5` -- let sandboxed verifiers stop their own executables.** Symptom: pueue `1526` failed `verify:candidate`'s kill step with `EPERM` under the strict Darwin loopback sandbox profile, reproduced on both turns. Root cause: the sandbox profile did not grant a spawned verifier permission to signal its own child. Fix: added `(allow signal (target children))` to the profile whenever a loopback port is set. Proof: a standalone `sandbox-exec` repro plus a RED/GREEN test pin the fix; this run's `PROOF-TELEMETRY-CANDIDATE` committed cleanly with no kill failure.
18. **`08da70cc0` -- tell Gate 2 workers which loopback port they may bind.** Symptom: pueue `1534` failed a worker-authored loopback test that bound port `0`, producing `listen EPERM` under the sandbox. Root cause: workers were not told which exact port they were permitted to bind, so a worker-chosen ephemeral bind was refused. Fix: the contract and support code now name `CCC_PROOF_LOOPBACK_PORT` explicitly and forbid binding any other port. Proof: this run's usefulness probe (above) binds the reserved port `57143` exactly, with a clean `exitCode: 0` exit.
19. **`27b29351d` -- keep the sealed proof evaluator's hash byte-equivalent.** Symptom: pueue `1544` refused `PROOF-TELEMETRY-AUDIT` with "proof definition hash is stale." Root cause: the sealed proof evaluator's hash projection omitted the sorted `linkedRuntime` and `verifierProfile` fields that the canonical hash includes; left unfixed, this would have refused `PROOF-TELEMETRY-CANDIDATE` and `PROOF-TELEMETRY-INTEGRATED` unconditionally on every future run, not just this one. Fix: mirrored the canonical hash projection byte-for-byte, pinned with a regression fixture built from unsorted input. Proof: this run's clean lane (1554, above) shows all 7 proof groups, including `PROOF-TELEMETRY-CANDIDATE` and `PROOF-TELEMETRY-INTEGRATED`, committed with no stale-hash refusal.

Two environmental events surfaced during this series and are recorded here as non-findings -- neither reflects a Gate 2 correctness defect: install task `1510` failed once on a transient `corepack` fetch `EHOSTUNREACH` (network blip, resolved on retry); and stop task `1556` (superseded, above) passed its Gate 2 assertions but failed the pueue task on a `DROP DATABASE` teardown timeout under concurrent host load, resolved cleanly by the `1561` rerun.

These failures support the Gate 2 design: deterministic proof remains necessary, but installed whole-product usefulness, plus real sandboxed and live execution, is the layer that catches coherent-yet-unusable output, harness defects, and environment-coupling bugs that narrower proof surfaces cannot see.
