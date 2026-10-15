# CONTRACT errata E8: final-repair verdicts, INT-2d, three re-plan cards (P1z, X1z, L1z), the v3.4 check rulings, and the W3 dispatch notes

Date: 2026-10-14. Binding on top of CONTRACT-v3.4 (compiled from v3.3 + E7; its check said AMEND with one blocking finding, B-1, ruled below). Order of precedence: E8, then E7, then E6, then E5, then v3.4.

## Verdicts (repair 2, final)

- **K2 at c594c8c02: ACCEPTED** (critical lane; review and adversary both accept). Recorded residuals:
  - `certificateApplies` trusts the array prototype: a hand-built in-memory array with an own `includes`, or a sparse array, can pass. Data parsed from JSON cannot take either form, so this is unreachable through the qualification port; the I6 port that feeds real certificates parses JSON.
  - G8 identities never call `roleOf`, so a G8 identity whose `taskId` is a writer or a G7 review id is admitted. **IB2 obligation:** the import bridge builds a G8 identity only for the judge task; when `CccRouteRole` gains a G8 role, K2 refuses a G8 identity whose graph role is writer or g7-review.
  - The deadline row is pinned at 1 ms, not at the 1 µs timestamp resolution.
- **L1 at dbe1f6a71: ACCEPTED** (both). E7-L item 8(b) found that dispatch counters are keyed by lineage id alone, so L1 now refuses a campaign-fence lineage named like a planning fixed lineage. The remaining L1 gaps go to the new card L1z (below).
- **P1 at 66ef8f379: lineage closed, re-planned.** The review accepted; the adversary found one fail-open path that E7-P item 1 did not cover: a body-processing failure **after** [DONE] (a cut or malformed data line after [DONE]) carries no marker, so pi.ts settles it as provider-error-event and retries, including when the receipt named a drifted route (adversary probes B1-B3). P1's lineage (1 build + 2 repairs) is used up. **Leader re-plan:** P1's three commits are integrated as they are (INT-2d), and the residual defect becomes the new card **P1z** with its own lineage. P1z must be accepted before W6 (no live call runs before then).
- **X1b at 270f92439: lineage closed, re-planned.** The review accepted; the adversary found that `discoverCccToolchain` still requires `searchPath`, while section 2.13 declares it optional (E6-0) and G0 step 11, SF and WR call discovery with its defaults. **Leader re-plan:** X1b's three commits are integrated (INT-2d); the defect becomes the new card **X1z**. X1z must be accepted before W4 (SF).
- **INT-2d** (parent): K2 (`11c512ee1`, `9485e02cc`, `2e9d0cbb8`), L1 (`5bb02616c`, `b6680746c`, `ccad72351`), P1 (`d4bef2024`, `33f5789a9`, `f689f11d5`) and X1b (`3ca856f00`, `40918ac77`, `b290aac0d`) cherry-picked on INT-2c `115ab8d7f` without conflicts, then one parent barrel commit:
  - core `index.ts` and `index.gate.ts`: `export *` of `task-store/ccc-planning-artifact-ops.js` (A1) and `task-store/ccc-planning-ops.js` (L1, including `completeCccPlanningCancellationWithin`), so engine and CLI cards import them through `@fusion/core`;
  - engine `index.ts`: `isCccCustodyGuardedTask` (G1), `attachCccProviderAttemptBoundRoute` and `type CccProviderAttemptBoundRoute` (P1);
  - the dashboard custody guard now asks `isCccCustodyGuardedTask` and uses `isCccPlanningCustodyTask` only to pick the message (E5-G1 item 6).
  - Checks: INT-2c's set plus the K1 test-tsc check; results in `scratchpad/int2d/summary.txt`.

## E8-0 Leader decisions and rulings on the v3.4 check

- **B-1 (blocking): a within-transaction state transition for BF.** BF's D43 rows need L1's transition inside the campaign transaction. L1's lineage is closed, so the new card **L1z** adds `transitionCccPlanningRunStateWithin(tx, i)` (E8-L item 1). BF uses it for every D43 row that does not end in `cancelled`, and for the `-> cancelling` step before `completeCccPlanningCancellationWithin`. v3.5 reopens the item until L1z is accepted.
- **N-1: the marker helper's real behaviour.** P1's `attachCccProviderAttemptBoundRoute<S>(controller: CccProviderAttemptController<S>, route: CccProviderAttemptBoundRoute): CccProviderAttemptController<S>` returns a **new frozen controller** that forwards `preDispatch` and `reconcile` and carries the marker. It refuses a controller whose own keys are not exactly `preDispatch` and `reconcile`, a controller that already carries a marker, and an empty route value. **WR rule:** WR builds its linked-writer binding around the **returned** controller; a binding built on the original controller is refused at session creation (fail-closed). WR adds that RED.
- **N-2:** L1's E7-L item 7 control (re-delivering the committed `pi-stream:1` settlement after the claim) is accepted as the only form the UNRECONCILED_DISPATCH guard allows.
- **N-3: the semantic-id collision refusal moves to GG.** AD1 never sees semantic task ids. Since counters are keyed by lineage id alone (E7-L 8(b)), **GG's G4 graph gate refuses a plan whose semantic task id would form a G7 lineage id `review:<id>` equal to any planning fixed lineage id** (detail naming the colliding id). This is added to GG's first repair round or, if GG is accepted without one, to a GG follow-up before W8. AD1 keeps only the run-id derivation.
- **N-4:** K2 refuses the F4 route with `CCC_ROUTE_IDENTITY_REJECTED` and reason `role-model-mismatch` (K2's actual choice); the import bridge reports it as `CCC_PLANNING_ROUTE_NOT_ADMITTED`. The review-identity shape is K2's own 7-key `CccPlanningReviewIdentity` (route-admission.ts), not a canonical.ts shape.
- **N-5:** BF's `openCccPlanningLinkedWriterAttempt` result gains `route: CccProviderAttemptBoundRoute`-shaped core data (`providerId`, `modelId`, `transport`, `roleClass`, `toolsetDigest`, all strings), which WR passes to `attachCccProviderAttemptBoundRoute`. BF declares the shape structurally in core (it cannot import engine); a type test in WR pins that the two shapes are equal.
- **N-6:** L1 refuses a split child that takes a fixed lineage id with `CCC_PLANNING_ROUTE_NOT_ADMITTED`, detail `lineage-not-admitted` (adopted).
- **N-7:** INT-2d runs the K1 test-tsc check (`tsconfig.ccc-planning-tests.json`), and every later INT step keeps it.
- **N-8:** the section 2.3 header comment is listed in the changelog.
- **Editor's conflicts confirmed:**
  - P1's adapter grant covers the processing and marker changes of E7-P item 1 and of P1z.
  - The K2 parse widening to `lean-v2` and `adaptive-v2`, with its PROFILE_NOT_SUPPORTED RED, belongs to **I6**, where section 3.3 places ADAPTIVE-v2 and LEAN-v2 (not I5).
  - The proof runner owns its PostgreSQL and refuses a caller's `FUSION_PG_TEST_SKIP`; a command that invokes the runner sets neither variable.
  - BF owes REDs for: its D43 rows going through L1's within-transaction functions (a rollback leaves nothing); a success row with a pending cancel mapped to `cancelling`; and the `route` values (N-5). WR owes the returned-controller RED (N-1).
  - `attachCccProviderAttemptBoundRoute`'s types are as written in N-1.
- **Item 6 refusal reason (P1 deviation, recorded):** a planning scope refused under a non-planning binding settles once with `refusalReason: "effective-route-drift"`. L1 and BF map it as a route refusal (`refused_known_effect`, then `blocked_provider`). Section 2.12's "unreachable in planning scope" note is corrected.
- **P1 residuals (recorded, not fixed):** a missing API key and a throw from an `onResponse` hook still settle provider-error-event (local failures; no upstream effect for the first, an already-answered request for the second); test (c)'s bind-close-dial has a tiny port-reuse race.

## E8-P: card P1z (W3; opus build; critical review)

Base: INT-2d. Owns: `packages/engine/src/ccc-route-receipt-adapter.ts` (processing and markers only), `packages/engine/src/__tests__/ccc-planning-provider-settlement.test.ts`, and `scripts/lib/ccc-planning-proof-inventory/cards/p1.mjs` (successor owner). **No pi.ts edit** (C2 owns pi.ts region (b) in W3).

1. **A body-processing failure after [DONE] never settles as an upstream error and never retries.** In `processBeforeDone` (and the final flush), when processing throws **after** [DONE] was seen, mark the error event `cccRouteFailure: "receipt-missing"` with detail `receipt-not-terminal`, so pi.ts settles a route refusal (`refused_known_effect`, no retry), exactly like the existing item-9 non-terminal case. Before [DONE] the existing transport rule stays.
2. **A 200 response whose content type is not `text/event-stream` (probe A7)** is never read, so its route is unverified: mark it `cccRouteFailure: "receipt-missing"` (detail `non-sse-response`), settled once, no retry. A non-2xx status stays an upstream error (provider-error-event), as section 2.12 says.
3. **REDs (loopback, through the real adapter, against INT-2d bytes):** B1 (cut data line after [DONE], no receipt check ran), B2 (missing receipt, then a cut line after [DONE]), B3 (drifted receipt, `finish_reason: error`, [DONE], then `data: {not-json}`), and A7. Each asserts: no provider-error-event settlement, no `pi-stream:2`, exactly one upstream request, and a single route-refusal settlement. Controls: B0 (drifted receipt with a clean end settles receipt-mismatch, one request) and B5 (a valid data line after [DONE] settles receipt-missing), unchanged.
4. Update `cards/p1.mjs` names exactly, checked against a JSON reporter run. Regression: the adapter tests, `custom-providers-openai-completions.test.ts` and `pi.test.ts` unchanged.

## E8-X: card X1z (W3; opus build; critical review)

Base: INT-2d. Owns: `packages/engine/src/ccc-confinement/toolchain-discovery.ts`, `packages/engine/src/__tests__/ccc-toolchain-discovery.darwin.test.ts`, `packages/engine/src/__tests__/ccc-shell-compat.darwin.test.ts`, and `scripts/lib/ccc-planning-proof-inventory/cards/x1b.mjs` (successor owner).

1. **`searchPath` is optional** and defaults inside the function: `const searchPath = i.searchPath ?? cccToolchainDefaultSearchPath();`. A value that is present but malformed still throws the existing TypeError. RED: `discoverCccToolchain({})` on this host succeeds and seals the same toolchain digest as `{ searchPath: cccToolchainDefaultSearchPath() }` (on INT-2d bytes it throws the TypeError). Also pin the frozen signature with a type-level assertion that `{}` is an accepted input.
2. **The compat decorator keeps `dispose`.** Assert that the decorated operations' `dispose` is the raw shell's `dispose` (or that disposing through the decorator returns the raw shell's closure result); mutant X2 (`return { exec } as unknown as T`) must fail.
3. Update `cards/x1b.mjs` names exactly. Measure the closed check at ambient load and keep `timeoutMs` at least 1.5 × the worst run.

## E8-L: card L1z (W3; opus build; critical review)

Base: INT-2d. Owns: `packages/core/src/task-store/ccc-planning-ops.ts`, `packages/core/src/__tests__/postgres/ccc-planning-control.pg.test.ts`, `packages/core/src/__tests__/postgres/ccc-planning-ledger.pg.test.ts`, and `scripts/lib/ccc-planning-proof-inventory/cards/l1.mjs` (successor owner).

1. **`transitionCccPlanningRunStateWithin(tx, i)`** (required; B-1). The same predicate, CAS and refusals as the direct form, including the E7-L item 2 control rule and the refusal of `-> cancelled` (only `completeCccPlanningCancellation[Within]` reaches `cancelled`). The direct `transitionCccPlanningRunState` becomes a wrapper that opens the transaction and calls it. Input shape: as the direct form, plus `projectId` if the within form needs it to scope the run (as `completeCccPlanningCancellationWithin` does). REDs: inside an outer transaction that then rolls back, nothing persists; with a pending cancel, `building -> accepted` within refuses CONTROL_PENDING and writes nothing; `-> cancelled` within is refused. Control: a committed within transition equals the direct form's result and audit rows.
2. **Pin the `lastControl` filter** (`target LIKE 'control:%'` in `inspectCccPlanningRun`, mutant r01/E4d): the review's RR2-PROBE-A sequence (a generic running -> cancelling with no operator control, lease expiry, then a deferred completion) must report `lastControl` from the operator control row only.
3. **Deferral rows for a reason that flips back (ADV2-A).** The id is derived from (run id, control_seq, deferral ordinal), and a row is written only when the latest deferral row for that control_seq has a different reason (or none exists). Repeating the same reason writes nothing. RED: live-lease, then descendants-unsettled, then live-lease again under one control_seq writes three rows and the latest says live-lease.
4. **Tests for surviving mutants:** the within form's deferral row (r03); `requireRunId` in the within form (r05); the split-child check's stricter cap (`Number.MAX_SAFE_INTEGER`, E8a'/r02): a split child named `research:leaf-1` on a 1536 run (leaf cap 0) is refused.
5. **One constant:** the remaining literal `256` bounds in `requireLineageId` and the research-fetch `nodeId` check use `CCC_PLANNING_AUDIT_STRING_MAX`.
6. Update `cards/l1.mjs` names exactly. Run the K1 test-tsc check too.

## E8-W3: notes for the W3 cards AD1, C2 and H1 (all opus; critical review)

- Base: INT-2d. The L1 and A1 store operations come from `@fusion/core` (INT-2d barrel).
- **AD1:** run id = `cccPlanningRunId({ projectId: receipt.project.projectId, requestDigest: receipt.request.sha256, receiptSha256 })`. No semantic-id duty (N-3 moved it to GG).
- **C2:** the pi.ts region (b) line numbers in the card (`3698-3730`, `3847`, `4043-4160`) predate P1's region (a) growth. C2 locates region (b) by content: the session tool assembly in `createFnAgent` (the `tools: "readonly"` path, `builtinToolsAllowlist`, MCP server tools, the final tool list) and reports the actual lines it edits. It never touches region (a) (the P1 seam, `validateCccSessionToolPolicy`, `assertCccSessionToolPolicyMatchesBinding`, the bound-route marker).
- **H1:** the session-level watchdog (D40) and per-node `maxRetriesPerNode: 1` rules stand; H1 consumes P1's settlement outcomes (a P1 route refusal moves the run to `blocked_provider` once).
