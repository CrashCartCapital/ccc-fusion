# Request-to-code v3: five-repair closeout

Date: 2026-10-15. Scope: Ryan’s “Finish, don’t expand” instruction. No new product cards were completed after that instruction.

The five requested repairs are implemented, independently reviewed and committed on `agent/request-to-code-v3`. The original BF/AU4/AU2 drafts were consolidated into final implementation commits; no WIP commits were introduced into integration. Historical leaf commits remain recoverable.

## Verified repair scope

Tested code commit: `29b147a1755dbd32585c169d160af8639aea8856`. Six unchanged entries from the checked-in TARGETED inventory ran directly, followed by the normal gate. Every command exited 0 without a timeout. File closure and owned-test-name closure were validated with the repository’s existing result validators. Final integrated source bytes match the independently reviewed leaf bytes.

| Card | What changed | Integration commit | Passing tests | Reviewed leaf |
|---|---|---|---:|---|
| C2 | confined tool policy | `c6d042e8c` | 46 | `b70ee3eb2` |
| BF | linked writer limits and outcomes | `339890814` | 134 | `442f8da6f` |
| AU4 | owned disposable target | `f04f6b0c5` | 33 | `f2a36b337` |
| AU2 | receipt-bounded execution release | `e3988aff8` | 10 | `c04129223` |
| H1z | raced resume/answer and watchdog cleanup | `29b147a17` | 95 | `549faa92b` |

Total: **318 passed, 0 failed, 0 skipped** across the six scoped commands. H1z is 72 unit/processor tests plus 23 PostgreSQL tests. Its scope is E17 items 1 and 4; optional items 2, 3 and 5 were not implemented.

Core and engine builds, the core/engine/CLI/dashboard typechecks, K1 test typecheck and `pnpm lint` passed. `pnpm test:gate` passed; its 579 passing tests and 3 existing platform skips are separate from the zero-skip repair checks. The owned PostgreSQL fixture at port 57805 was fast-stopped (exit 0). No shared PostgreSQL or port 4040 was accessed.

C2 and AU4 received independent Sol reviews. BF, AU2 and H1z received independent Sol reviews plus Gemini adversarial acceptance of their final bytes. Sol routes were requested explicitly; effective native route identity was not independently observable. AGY reported `gemini-3.8-flash-high`. The earlier AU2 acceptance was rejected after the native-import fixture gap was found; only the repaired final candidate was accepted.

## I2: not run

**Exact blocker:** the request-to-code Build entry path is not wired. `packages/cli/src/commands/plan.ts:367` returns `CCC_PLANNING_COMMAND_NOT_SUPPORTED` with “fn plan start is not available in this build.” The CLI command tests passed 22/22 and preserve that refusal. Approval cannot repair missing implementation. No new decision or authority is needed from Ryan for this software blocker; a live receipt and Ryan-typed digest must wait until a runnable candidate exists.

The repaired candidate was not installed, no product model requests were launched, and actual GLM 5.3 / MiniMax M3 / GLM 5.3 Flash performance remains unverified. No main merge, release, production change or new pilot occurred.

## Wider verification remains incomplete

- The full `pnpm test:ccc-planning` attempt was interrupted after the unmodified X1 process sweep timed out and its `/usr/sbin/lsof` process remained in an uninterruptible OS state after SIGKILL. The canonical report is **not passing**. A separate lsof diagnostic warned about the Time Machine mount before becoming stuck; that suggests an I/O issue but does not establish its root cause. No confinement check was weakened or removed.
- The existing `in-process-runtime.pg.test.ts` startup/shutdown case timed out at the same 90-second outer bound both before H1z (`f04f6b0c5`) and on H1z (`549faa92b`). Both owned servers were stopped. The wider regression lane is **INCOMPLETE**; no database deadlock or product fix is claimed.
- BF’s writer-attempt status projection, the stopped SF drafts, untouched GGz/LV work, later planning/build wiring, installed acceptance and the full product criteria remain outside this five-repair closeout.

## Evidence and exact commands

Scoped machine receipt: [/private/tmp/ccc-five-repairs-final-y6sj7hor/receipt.json](/private/tmp/ccc-five-repairs-final-y6sj7hor/receipt.json). Closed results: [/private/tmp/ccc-five-repairs-final-y6sj7hor/closure.json](/private/tmp/ccc-five-repairs-final-y6sj7hor/closure.json). Broader interrupted run: [/Users/ryanpappal/03_CODE/ccc-fusion/.worktrees/request-to-code-v3/.archive/r2c-codex-resume-20261015/final-targeted-report.json](/Users/ryanpappal/03_CODE/ccc-fusion/.worktrees/request-to-code-v3/.archive/r2c-codex-resume-20261015/final-targeted-report.json). Paired runtime diagnostic: [/private/tmp/ccc-h1z-paired-30luqcc6/summary.json](/private/tmp/ccc-h1z-paired-30luqcc6/summary.json).

The following commands were observed against the tested commit. PostgreSQL commands used both `FUSION_PG_TEST_URL_BASE` and `CCC_PG_URL_BASE` set to the owned fixture endpoint; non-PG commands used `FUSION_PG_TEST_SKIP=1`. All used `PI_OFFLINE=1`. The fixture is now stopped; these lines record proof, not instructions to reuse that port.

```sh
pnpm --filter @fusion/engine exec vitest run --project=engine-default src/__tests__/ccc-session-tool-policy.test.ts src/__tests__/ccc-confined-fs-tools.test.ts src/__tests__/ccc-confined-grep-tool.test.ts src/__tests__/ccc-verdict-tool.test.ts src/__tests__/ccc-probe-echo-tool.test.ts --silent=passed-only --reporter=dot --reporter=json --outputFile=/private/tmp/ccc-five-repairs-final-y6sj7hor/c2-engine-tool-policy.json
pnpm --filter @fusion/engine exec vitest run --project=engine-default src/__tests__/ccc-planning-disposable-target.real-git.test.ts --silent=passed-only --reporter=dot --reporter=json --outputFile=/private/tmp/ccc-five-repairs-final-y6sj7hor/au4-disposable-target.json
pnpm --filter @fusion/core exec vitest run --config vitest.pg.config.ts src/__tests__/postgres/ccc-planning-writer-caps.pg.test.ts src/__tests__/postgres/ccc-planning-campaign-outcome.pg.test.ts src/__tests__/postgres/ccc-campaign-provider-controller.pg.test.ts src/__tests__/postgres/ccc-campaign-provider-attempt.pg.test.ts src/__tests__/postgres/ccc-provider-attempt-effective-route.pg.test.ts src/__tests__/postgres/workitem-transition-event.pg.test.ts src/__tests__/postgres/orphan-workitem-cancellation.pg.test.ts --silent=passed-only --reporter=dot --reporter=json --outputFile=/private/tmp/ccc-five-repairs-final-y6sj7hor/bf-linked-writer-and-outcomes.json
pnpm --filter @fusion/engine exec vitest run --project=engine-default src/__tests__/ccc-planning-live-execution-release.real-pg.test.ts --silent=passed-only --reporter=dot --reporter=json --outputFile=/private/tmp/ccc-five-repairs-final-y6sj7hor/au2-live-execution-release.json
pnpm --filter @fusion/engine exec vitest run --project=engine-default src/__tests__/ccc-planning-host.test.ts src/__tests__/workflow-work-processor.test.ts --silent=passed-only --reporter=dot --reporter=json --outputFile=/private/tmp/ccc-five-repairs-final-y6sj7hor/h1-engine-host.json
pnpm --filter @fusion/engine exec vitest run --project=engine-default src/__tests__/ccc-planning-host.real-pg.test.ts --silent=passed-only --reporter=dot --reporter=json --outputFile=/private/tmp/ccc-five-repairs-final-y6sj7hor/h1-engine-host-pg.json
pnpm test:gate
```

## Custody and resumption

The primary checkout and protected paths were not developed in. Repair worktrees are retained for recovery; the SF worktree retains three untracked drafts and is not integrated. No new cards are authorized by this closeout. The next product work would be completing the missing Build entry path, not requesting a live digest prematurely.
