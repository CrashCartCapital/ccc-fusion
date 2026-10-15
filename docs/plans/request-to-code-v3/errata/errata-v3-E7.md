# CONTRACT errata E7: repair-1 verdicts, the FINAL repair of K2, L1, P1 and X1b, and the v3.3 check rulings

Date: 2026-10-14. Binding on top of CONTRACT-v3.3 (compiled from v3.2 + E5 + E6; its check said AMEND, one blocking finding B1, ruled below). Order of precedence: E7, then E6, then E5, then v3.3 (and v3.2 beneath it).

This is the **last allowed repair (repair 2 of 2)** for K2, L1, P1 and X1b. Each card's lineage is 1 build plus 2 repairs. If a card's repair 2 is not accepted by both its fresh reviewer and its fresh adversary, the leader re-plans that card (split, re-scope or re-derive); there is no repair 3.

## Verdicts (repair 1)

- **G1 at 11fff1ad1: ACCEPTED** (review and adversary). Cherry-picked onto integration as `90a4003bd` + `1c50053a2` (INT-2c).
- **X1c at c16d103bf: ACCEPTED** (critical lane, both). Cherry-picked as `fc2b82cca` + `115ab8d7f` (INT-2c). Recorded residuals:
  - lsof `-b` was chosen from the mechanism (lsof's mount-point stat with its 15 s `-S` default exceeds the 11 s capture limit), not from a measured stall; the smbfs mount was gone during repair 1, so the after-rate is inferred. Any stall still fails closed.
  - The writer-shell profile template digest binds function source text, so it differs between the vitest transform, tsc dist and each tsup bundle. A qualification receipt is valid only for the build that produced it (G0 records the digest of the build under test).
  - The wrapper sets `ulimit -t` and `ulimit -f` but not `ulimit -u`; a confined fork bomb that exhausts the user's process limit makes the sweep's spawns fail with EAGAIN, and the exec then refuses (fails closed) rather than reaping. Risk row, not a repair item.
- **K2 at 5636bb733: REPAIR** (adversary; the review accepted). Final repair.
- **L1 at 1d0df1cc5: REPAIR** (both). Final repair.
- **P1 at 19036aa27: REPAIR** (both). Final repair.
- **X1b at 10f9b23c5: REPAIR** (adversary; the review accepted). Final repair, test-only.

## E7-0 Leader decisions

- **Bases (rules on v3.3 B1).** INT-2c is `115ab8d7f` (INT-2b `ee89957c1` + G1 + X1c). Before repair 2 the parent rebased every remaining leaf onto INT-2c, with no conflicts and no file overlap with G1 or X1c:
  - K2: `42d2ffde8` (round 1, patch-equal to 0876ea993) + `ef72f9868` (repair 1, patch-equal to 5636bb733);
  - L1: `a17b009a4` (= 0ce304036) + `0ab6b6280` (= 1d0df1cc5);
  - P1: `cd65276c6` (= c86d946ab) + `bbaa5fb4d` (= 19036aa27);
  - X1b: `131b21d4d` (= c9d4cedb7) + `a57fa435f` (= 10f9b23c5), now directly on INT-2c (X1c is integrated), so X1b no longer sits on an X1c round-1 commit and the parent cherry-picks its commits as-is.
  - E5's rule "W2 repair tests must not depend on K1b or X1c" is retired: K1b, G1 and X1c are all integrated.
  - A repair-2 RED must fail on the repair-1 bytes (the leaf's current head) on a behavioural assertion, or, where this erratum says so, be a pinning test whose failing signature comes from a reported mutant.
- **PostgreSQL rule (repeat, still binding).** Every command that can reach PostgreSQL carries `FUSION_PG_TEST_URL_BASE` pointing at the leaf's own disposable server; a command that needs no PostgreSQL carries `FUSION_PG_TEST_SKIP=1`. A readiness probe of the shared localhost:5432 is a violation even when read-only (logged against K2 repair 1: four probes, no database created).
- **Marker attachment (v3.3 open item).** The 5-key bound-route marker (providerId, modelId, transport, roleClass, toolsetDigest) is engine-side. P1 exports, from pi.ts, the type `CccProviderAttemptBoundRoute` and a helper `attachCccProviderAttemptBoundRoute(controller, route)` that sets the `Symbol.for("ccc-fusion.provider-attempt-route.v1")` key. **WR** (engine) attaches it where it creates the linked-writer session. **BF** (core) supplies the five values in its core data and never imports engine. The parent adds the engine barrel exports at INT-2.
- **BF and cancellation (v3.3 open item).** BF's D43 rows go through L1's functions, never direct SQL: rows that end in `cancelled` call L1's new within-transaction completion (E7-L item 9) inside the campaign transaction's savepoint; BF's `accepted` row while a cancel is pending is refused CONTROL_PENDING by L1 and BF maps it to `cancelling`.
- **`deferred-leased` (v3.3 open item).** L1 is granted a one-line hunk in K1's `packages/core/src/ccc-planning/types.ts` (about line 214) that removes the `deferred-leased` literal from `CccPlanningRunStatusV1.lastControl.outcome`. Nothing else in that file.
- **P1 pi.ts import grant (ratified).** The repair-1 hunk at pi.ts lines 45-46, adding `cccPlanningSessionToolNames` and `CCC_PLANNING_DENIED_NAMES` to the `@fusion/core` import list, is an E7 grant. P1 may also add, in that same import block, any `@fusion/core` value it needs for E7-P items.
- **Effective-model drift on an upstream error (P1 probe D; v3.3 D10 amended).** A terminal receipt that names a route other than the bound one refuses `receipt-mismatch` and never retries, whether the upstream ended normally or with `finish_reason: error`. The PRD's failure probe "reject effective-model drift" outranks the narrower D10 wording. The evidence keeps the observed receipt values.
- **AD1 obligations (recorded; AD1 is W3).**
  - AD1 derives the run id with `cccPlanningRunId({ projectId, requestDigest: receipt.request.sha256, receiptSha256 })`.
  - AD1 refuses a PRD semantic task id that collides with a planning fixed lineage id if E7-L item 8 finds the counters are keyed by lineage id alone.
- **K2 parse and profiles (rules on v3.3 N1).** The CL2 single-fault case "a well-formed profile other than full-v2 refuses PROFILE_NOT_SUPPORTED" is dropped; no such receipt exists while K2's parse accepts only `full-v2`. The I5 card that widens K2's parse to `lean-v2` and `adaptive-v2` adds the PROFILE_NOT_SUPPORTED RED (a parse-valid profile the mode does not support). The code stays in the §2.3 union.

## E7-K: card K2 repair 2 (FINAL; opus, critical)

Base: INT-2c, leaf head `ef72f9868`. Owns: as v3.3 K2.

1. **Fail-open on a malformed certificate (required).** In `certificateApplies` (qualification.ts about 56-69), return false unless each of `scope.targetClasses`, `scope.modes` and `scope.profiles` is an array (`Array.isArray`) whose entries are all strings, before any `.includes`. Correct the :67 comment if needed. RED (ccc-planning-qualification.test.ts): a certificate whose scope fields are strings (one string-typed field at a time is enough, three cases), with its `certificateId` recomputed over the canonical body, gives QUALIFICATION_REQUIRED. Control: the array-typed twin stays admitted.
2. **Non-vacuous deadline row (required).** Add a case built from the envelope control: `run.deadlineAt` later than the receipt deadline (e.g. 2026-10-17T12:00:00.000Z), `authorization.campaignDeadlineAt` between the two (e.g. 2026-10-16T12:00:00.001Z): ENVELOPE_MISMATCH on `authorization.campaignDeadlineAt`. One-field control: `campaignDeadlineAt` equal to the receipt deadline stays within. Report that mutant A46b (`const deadline = envelopeTime(run.deadlineAt, ...)`) now fails.
3. **Cap type (required).** The remaining-calls check requires `typeof cap === "number" && Number.isSafeInteger(cap)`; correct the authority.ts ~582-585 comment. RED: a resealed (unparsed) receipt whose `maxRequests` is the string "3500" with 4000 remaining is refused; control: the number 3500 is within.
4. **Pinning tests (required; signature from a reported mutant).** (a) The envelope's `actions.length !== 1` guard: a sealed receipt listing `[controller_within_receipt, operator_confirm_after_import]` is refused (mutant A31b fails). (b) The receipt `schema` literal: a receipt with another schema string is refused (mutant P28 fails). (c) The UTF-8 `fatal: true` decode: invalid bytes inside a JSON string value are refused (mutant B14 fails; the old [0xff,0xfe] input does not discriminate).
5. **Review identity by exact shape (required).** route-admission.ts (about 52-54) must not decide that a route is a review identity from `hasOwnProperty("routeKind")`. A route counts as a review identity only when its key set is exactly the review-route shape that canonical.ts produces; an object that carries product-route keys plus `routeKind` is refused ROUTE_NOT_ADMITTED. RED: probe F4 (a product route for writer task T1 on minimax/MiniMax-M3 that also carries `routeKind: "g8-judge", reviewOfTaskId: null`) is refused; control: the plain product route is checked by the writer rule as before. Also add the review-of-review row whose reviewed identity has graph role `writer`, so deleting only `isReviewIdentity(reviewed) ||` (route-admission.ts:111) fails.
6. **`.git` in changed paths (required, small).** Apply the same case-insensitive `.git`-segment ban to `baseline.changedPaths` that the admitted patterns already have. RED: `proof/.GIT/config` is refused; control: `proof/x` is within.
7. Update cards/k2.mjs names exactly.

## E7-L: card L1 repair 2 (FINAL; opus, critical)

Base: INT-2c, leaf head `0ab6b6280`. Owns: as v3.3 L1, plus the E7-0 one-line grant in K1's types.ts.

1. **Pause at admitted is refused (required; repair-1 regression).** In `planControl`, case `admitted`: `pause` refuses CCC_PLANNING_STATE_TRANSITION_REFUSED ("admitted has no -> paused transition") before any write; cancel stays direct. RED (ccc-planning-control.pg.test.ts): `seedRun({state:'admitted'})`, pause refused, `control_seq` stays 0, `control_request` stays null, no `ccc-planning:control` event; then admitted -> running succeeds. Control: pause while running is still recorded as pending. Mutant: restoring `return { kind: "pending" }` for admitted fails the RED.
2. **A pending cancel is never erased by a move to paused (required; fail-open).** The moveRun predicate becomes `control_request IS NULL OR to IN ('cancelling','cancelled') OR (to = 'paused' AND control_request = 'pause')`, and the re-read fallback classifies the same way (CONTROL_PENDING otherwise). RED: running run, pause then cancel, then running -> paused is refused CONTROL_PENDING, `control_request` stays 'cancel', no state event; then running -> cancelling succeeds. Control: a pending pause alone still allows running -> paused (the existing ADV-12 test).
3. **Lineage role half and leaf cap get tests (required).** (a) After product-adversary uses its 3 turn keys, a product-adversary binding at stage review with lineageId `review:technical-critic` is refused ROUTE_NOT_ADMITTED /lineage-not-admitted/, with `planning_spent` and the `call:reserved` count unchanged; control: a technical-critic binding in that lineage is admitted. (b) On the default 1536 run `research:leaf-1` is refused lineage-not-admitted; on `planningAllocation: 6144` `research:leaf-77` is admitted and `research:leaf-78` refused. Report mutants I3e and I3f (m19) killed.
4. **A deferred direct completion records its reason (required).** When `completeCccPlanningCancellation` (or its within-transaction form) defers, it writes one deterministic, idempotent audit row: event type `ccc-planning:control`, subject `cancel-deferred:<reason>` where reason is `live-lease` or `descendants-unsettled`, event id derived from (run id, current control_seq, reason), so repeating the same deferral writes nothing new and a changed reason writes one new row. Its metadata carries the reason and, for descendants, the code CCC_PLANNING_DESCENDANTS_UNSETTLED. `lastControl` still reports the cancel as pending; if the status view has a reason field it shows the latest deferral reason. RED: the ADV1-D sequence (cancel recorded `live-lease`; lease expires; direct completion defers on the unsettled call and now records `descendants-unsettled`; a second identical call adds no row).
5. **Bound committed settlement strings (required).** Before the settlement transaction, bound every string of the committed effectiveRoute and cost: id-like fields (effectiveProvider, effectiveModel, effectiveReasoningEffort, effectiveServiceTier, cost.source and the omniRoute id strings) at `CCC_PLANNING_AUDIT_STRING_MAX` (256); `cost.reason` and any other free-text observation string at 1024 characters. A violation refuses CCC_PLANNING_INTERNAL_ERROR and writes nothing. RED: the ADV1-E sequence (100,000-character effectiveReasoningEffort; separately cost.reason) refused with no row; control: bounded values commit.
6. **One constant.** Replace the local `AUDIT_ID_MAX` with K1's `CCC_PLANNING_AUDIT_STRING_MAX` (refactor; existing tests stay green).
7. **Superseded lineage takes no new call (required; ADV1-C).** Once a repair chunk supersedes a lineage, every new call reservation on it is refused (ROUTE_NOT_ADMITTED, detail `lineage-superseded`), including the next call of a continuing turn; a call already dispatched still settles normally. This replaces the E5 item 4 allowance at about :851. RED: after `claimCccPlanningRepairChunk` creates `repair:1:spec-author`, the existing `spec:spec-author` turn's `pi-stream:2` is refused and nothing is charged; control: a settle of the already-dispatched `pi-stream:1` still commits.
8. **Split children and the lineage namespace (required).** (a) `recordCccPlanningLineageSplit` refuses a child id that has any `fixedLineageOwners` (e.g. child `review:technical-critic` of parent `review:product-adversary`). RED plus control (a fresh child id is accepted). (b) Determine whether dispatch counters are keyed by lineage id alone or by (fence, lineage id). If by id alone, refuse a campaign-fence lineage whose id equals a planning fixed lineage id (RED + control). If keyed per fence, add a test proving a G7 `review:product-adversary` lineage on a campaign fence and the planning critic's lineage keep separate counters. Report which case holds.
9. **Within-transaction cancellation completion for BF (required).** Export `completeCccPlanningCancellationWithin(tx, input)` (the existing direct function becomes a wrapper that opens the transaction and calls it), keeping one path to `cancelled`. RED: called inside an outer transaction that then rolls back, nothing persists; control: the committed form reaches `cancelled` exactly as before. The parent adds the barrel export at INT-2.
10. **Drop `deferred-leased`** from K1's types.ts via the E7-0 grant; core typecheck must stay green.
11. **Record, do not fix:** settlement's move to blocked_provider does not respect a pending pause (the operator may need to resume twice); the lock order of answerCccPlanningDecision vs A1's planning-fence publish can deadlock (PostgreSQL detects 40P01); splitting an unused parent gives each child a fresh 3 attempts (D13 as written); supersession is per role (H1, BF and ST2 must not name task-reviewer as a coding-rejection re-reviewer).
12. Update cards/l1.mjs names exactly.

## E7-P: card P1 repair 2 (FINAL; opus, critical)

Base: INT-2c, leaf head `bbaa5fb4d`. Owns: as v3.3 P1, plus the E7-0 pi.ts import grant.

1. **Any error before [DONE] is a transport failure (required; fail-open).** In `consumeReceiptAdapterSse` (ccc-route-receipt-adapter.ts), wrap both the per-line `consumeLine`/`consumeData` processing inside the read loop and the final flush in try/catch; when `!sawDone`, set `transport.failed = true` before rethrowing. An error raised after the body began and before [DONE] is never an upstream-reported error unless the upstream itself reported it (a parsed `finish_reason: error` or an error object in a complete event).
2. **Loopback REDs through the real adapter (required)**, each asserting `cccTransportFailure: true`, reconcile never called, re-entry throws /dispatched_unknown/ with keys [pi-stream:1, pi-stream:1], and exactly one upstream request:
   - (a) truncated last data line at clean EOF: CONTENT_CHUNK then `response.end('data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"wor')`;
   - (b) clean EOF after a complete line, no [DONE], no receipt (stays transport, not receipt-missing; kills M4f/M5 and M4i/M10);
   - (c) connection refused: bind port 0, close it, point the adapter there (kills M4e/M6);
   - (d) a malformed `data: {not-json}` mid-stream, followed by a valid finish, receipt and [DONE] (the adapter abandons the stream, so the outcome is unknown).
   Report the RED of (b) and (c) from the named mutants, since both pass on the repair-1 bytes; (a) and (d) fail on the repair-1 bytes.
3. **Drift on an upstream error refuses (required; E7-0).** A `finish_reason: error` whose terminal receipt names another model settles `receipt-mismatch` and does not retry. RED: probe D (receipt names minimax/MiniMax-M2.7) gives keys [pi-stream:1] and one upstream request; control: the same error with the bound model's receipt settles provider-error-event as before.
4. **Conflicting receipt values stay in the evidence (required, small).** A `receipt-mismatch` settlement records the observed conflicting providerId/modelId (bounded strings) in its evidence, not `observed: null`. RED: assert the evidence fields.
5. **Linked writer model check at creation (required).** For a linked-writer binding, compare the marker's `modelId` (as well as its providerId) with `options.defaultModelId`/provider at session creation and refuse before any provider call. RED plus control.
6. **The item-7 refusal must not wedge the slot (required).** If the planning-scope check can run on the binding before `preDispatch`, run it there. If it needs the permit's scope, settle the reserved call once as a refusal with no upstream request, through the same path P1 already uses for route refusals, so it is not left reserved or dispatched_unknown. RED: after the refusal the slot is not reserved/dispatched_unknown (fake controller records the settle).
7. **Exports for WR and BF (required).** Export the type `CccProviderAttemptBoundRoute` (exact 5 keys) and `attachCccProviderAttemptBoundRoute(controller, route)` from pi.ts; the existing reader uses the same type. A type test pins the 5 keys. No barrel edit.
8. **Optional.** A fake-timer test for the adapter's `timedOut` flag (M4h). Relabel "No API key" and an `onResponse` hook throw as local, pre-request failures if a one-line label change does it; otherwise record as a residual.
9. **Rulings recorded, no code:** a receipt that is not terminal (a matching receipt followed by a data line) and an incomplete receipt settle receipt-missing (no terminal receipt was observed); refusal memory stays per session (L1/BF's run-state block covers new sessions); `cccStreamGuard` is a presence check.
10. Update cards/p1.mjs names exactly, re-checked against a JSON reporter run.

## E7-B: card X1b repair 2 (FINAL; opus, critical; test-only)

Base: INT-2c, leaf head `a57fa435f`. Owns: as v3.3 X1b. No source change is expected; if one is needed to make a pinned behaviour hold, stop and report it as a deviation.

1. **Nested bash keeps the shim directories (required).** Add a package script `nested: "bash -c 'hello from-nested'"` (or a `#!/usr/bin/env bash` .bin shim that calls `hello`), and assert HELLO-CLI and rc 0 through `compat`; keep the raw-shell control. Report that mutant N1 (`rest=` in place of the inherited-shim merge) fails on an assertion.
2. **`#!/usr/bin/env bash` runs bash, not sh (required).** A `.bin` shim with that shebang prints `${BASH-unset}` and the posix state; assert `BASH` equals `join(dirname(exec), "bash")` with posix off. Report that mutant N11 (`bash) tool=sh`) fails.
3. **No-shebang fallback runs sh (required, small).** Pin the header's claim; mutant N2 (`*) tool=bash`) fails.
4. **Optional.** A test for N7 (dropping `isRealDirectory(install.wrapperDir)`).
5. **Record in the test and card headers:** inside the sandbox `id -un` fails like the dropped `whoami` ("cannot find name for user ID"), so only numeric `id`/`id -u` is supported; `/opt/homebrew` is operator-writable, so "Homebrew only" does not mean protected (sealing records digests, so later changes fail closed); a keg-only `node@NN` not linked into /opt/homebrew/bin is not found by default; an optional tool that sealing rejects refuses the whole discovery (fails closed); an unprefixed Homebrew name in a directory wins over the g-name there.
6. Fix the stale test-header lines 17-18 ("reported as evidence, not asserted").
7. Confirm the closed check still typechecks and passes on INT-2c (X1c's accepted bytes), and update cards/x1b.mjs names exactly.

## E7-C: rulings on the v3.3 check findings

- **B1 (blocking):** state the actual bases as E7-0 gives them, and replace the E5 "must not depend on K1b or X1c" sentence with E7-0's retirement of it.
- **N1:** as E7-0 (drop the CL2 single-fault case; I5 adds it).
- **N2:** list INT-2b's actual checks (core typecheck, core build, engine typecheck, K1 test-tsc, the seven K1 vitest files 125/125, lint). The CLI typecheck and `pnpm test:ccc-planning` were owed; INT-2c runs both (result recorded in the INT-2c paragraph).
- **N3, N4, N5, N6:** apply the checker's wording.
- **Editor's additions accepted:** the BF Note (now settled by E7-0), the (P12) RED, the X1c Owns grant entry, and the F8 clause.
- **New INT-2c paragraph:** G1 and X1c cherry-picked (`90a4003bd`, `1c50053a2`, `fc2b82cca`, `115ab8d7f`); checks as INT-1b plus dashboard typecheck, `pnpm test:ccc-planning` and `pnpm test:gate` on an owned PostgreSQL.
- **New risk rows:** the X1c residuals above (digest per build; no `ulimit -u`; lsof `-b` inferred).
