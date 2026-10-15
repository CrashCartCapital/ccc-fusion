# Errata E14: W3 outage re-run verdicts; final repairs of C2, H1 and X1z

Date: 2026-10-15. Precedence: E14 > E13 > E12 > E11 > E10 > E9 > v3.5.

## Verdicts

- **P1z: ACCEPTED** at 426a016a7 (repair 1 review ACCEPT, repair 1 adversary ACCEPT). Integrates at INT-3b. W6 may now dispatch (E10 N-3).
- **L1z: ACCEPTED** at 5ea7a413a (both ACCEPT). Integrates at INT-3b. `transitionCccPlanningRunStateWithin` is exported through core's `export *` of ccc-planning-ops. BF may now dispatch.
- **C2: REPAIR** at 2d90c7cc5. Repair 1 review ACCEPT; repair 1 adversary REPAIR (3).
- **H1: REPAIR** at 69452d104. Repair 1 review REPAIR (5); repair 1 adversary REPAIR (4).
- **X1z: REPAIR** at 5ece4d1c3. Both REPAIR, test-only.
- C2, H1 and X1z each get **repair 2 of 2 (final)**, then a fresh critical review (Opus reviewer plus Opus adversary). If that fails, the leader re-plans the residuals as a z-card.

## C2 repair 2 (binding)

Before dispatch, the leader rebases agent/r2c-c2 onto INT-3b, which carries P1z's version of the P1 test files.

1. **No FIFO or special-file freeze.**
   - Every checked landing in the confined fs operations opens with O_NONBLOCK, then fstats the handle and refuses anything that is not a regular file with `CccConfinedPathRefusedError`. Writes refuse before any truncate.
   - The grep walk skips every child that is neither a regular file nor a directory, and the single-file grep path checks the same way.
   - RED: a `mkfifo` fixture inside a root. Read, edit, write and grep each settle promptly with a refusal or a skip.
   - Control: an unrelated `fs.promises` read still completes afterwards, and a regular file still reads.
2. **The probe wrapper records what the model sent.**
   - `wrapCccProbedTool` records the raw arguments of the claimed call, captured before any substitution, as `params`.
   - It records `result: 'error'` whenever the inner tool reports the call as inexact. A wrapped `ccc_probe_echo` never yields an `ok` observation for an inexact echo.
   - RED: an inexact echo driven through Pi's real agentLoop with the wrapper. Assert one stream entry, one abortTurn, no `ok` observation, and no params the model did not send.
   - Control: an exact echo records `ok` with the sent params.
3. **The final tool set is checked for every policy** (D11, verify-v2 item 37). This is adopted fail-closed: the C2 build's WeakSet deviation is withdrawn.
   - `createFnAgent` runs the full `assertCccSessionToolSet` (names, digest, mark, required non-confined tools) for every policy. It refuses a policy not built by `buildCccSessionToolPolicy`.
   - **Grant:** C2 repair 2 may edit the fixture policies in `packages/engine/src/__tests__/ccc-planning-provider-binding.test.ts` and `packages/engine/src/__tests__/ccc-planning-provider-settlement.test.ts`, moving them onto `buildCccSessionToolPolicy` with real tools, and `scripts/lib/ccc-planning-proof-inventory/cards/p1.mjs` if a name changes. P1's lineage is closed, so no other writer holds those files. Assertions must not be weakened; only fixture construction changes.
   - REDs: a hand-built critic policy without `ccc_submit_verdict`, and a hand-built linked-writer policy without `fn_complete_phase`, are both refused.
   - Control: the same roles built through `buildCccSessionToolPolicy` create their sessions.
   - Obligation recorded: SF, WR and C6 build every session policy through `buildCccSessionToolPolicy`.

## H1 repair 2 (binding)

1. **The planning claim is total.** No throw inside `runPlanningWorkflowWorkItem` may reach the shared campaign or ordinary catch in `processDueWorkflowWorkItem`.
   - The run lookup, the attempt bump, `store.getTask`, and the hold at the normal path each either conclude through `concludeFailure` while the lease is held, or release the item to `runnable` when L1 is unreachable (the RED 16b rule). None of them ever writes `failed` behind a live run.
   - Defence in depth: the shared catch releases to `runnable`, never `failed`, for a custody-guarded planning item.
   - REDs (real PostgreSQL): a lookup that throws once, and a `getTask` that throws once. Each ends with the run `failed` or the item `runnable`, and a later cancel completes.
2. **The success path completes cancellation (D45).** After the `succeeded` transition, call L1's quiet cancellation completion, as `holdWorkItem` does. Read the run back, and conclude a run that is still `admitted` or `running` behind a succeeded item.
   - RED (real PostgreSQL): a cancel raced against the final write ends `cancelled`, not `cancelling`.
3. **Runnable and retrying planning items are found independently of the shared page limit** in `in-process-runtime.ts`, in the same way repair 1 handled lease-expired items.
   - RED: 25 older runnable items on paused tasks, then a runnable planning item. It dispatches.
4. **The `awaiting_intent` park carries `CCC_PLANNING_AWAITING_INTENT`** as its state code (section 2.3).
   - Positive control for RED 18: an admitted park, with the run `awaiting_intent`, that state code, the item `held`, the decisionId in blockedReason, and exactly one state event.
   - L1's `STATE_CODE_REQUIRED` omitting `awaiting_intent` is recorded as a defence-in-depth follow-up for the next core planning card. It is not H1's file.
5. **RED 11b is not vacuous.** The swallowing session sits in the last IR stage, or the test asserts the hold names the refusing node and no later stage is entered. Mutant C10 must fail.
6. **cancelAll waits for every handle.** The spy records `cancelAll` only when a slow handle's cancel settles, or a registry unit case shows cancelAll still pending. Mutant C13 must fail.
7. **The `rejected` outcome is pinned.**
   - A stage returning `{kind:"rejected", code:"CCC_PLANNING_GRAPH_INADMISSIBLE"}` leaves the run `failed` with that state code, one state event, the item `failed`, and no later stage entered.
   - An invalid code maps to `CCC_PLANNING_INTERNAL_ERROR`.
   - Mutant C18 must fail.

## X1z repair 2 (binding; test-only)

1. **The default search path is pinned by observation, not by HOME.**
   - In the discovery test, partially mock `node:fs` so `realpathSync`, or whichever probe discovery uses, passes through and records every path it is given.
   - Run `discoverCccToolchain({ required: [<random tool name>], optional: [] })` with `searchPath` absent, and assert that the directories probed, in order, are exactly `cccToolchainDefaultSearchPath()`.
   - Keep the explicit-directory positive controls.
   - Mutants td-mh-homedir, td-mu-userinfo, td-usrlocal, m4 and the HOME-environment m5 must each now fail on an assertion.
   - Correct the mutant list and the test names in `cards/x1b.mjs` exactly.
