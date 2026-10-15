# CONTRACT-v3.5: CCC Fusion request-to-code, I1 and I2

- Revision v3.5: v3.4 with erratum E8 (`scratchpad/design/errata-v3-E8.md`) applied in place, in the section and card each item governs. E8 wins over E7, E7 over E6, E6 over E5, and E5 over v3.4. The v3.5 changelog below names every E8 item and the sections it changed; everything else is v3.4 byte for byte. v3.4's check said AMEND with one blocking finding, B-1, and the non-blocking findings N-1 to N-8; E8-0 rules on all of them. E8 closes the repair-2 round: K2 and L1 are accepted; P1's and X1b's lineages are closed, their commits integrated as they are, and their residual defects re-planned as the new W3 cards P1z and X1z; the new W3 card L1z closes B-1 and L1's remaining gaps. The bases E8 gives were checked read-only: INT-2d `fcb83879d` is the head of `agent/request-to-code-v3`; each of its twelve cherry-picks is patch-equal (`git patch-id --stable`) to the leaf commit it copies (`scratchpad/contract-v3.5/patchids.txt`); it changes 32 files, the 28 owned by K2, L1, P1 and X1b and the 4 of the parent barrel commit; and its `errors.ts` is INT-2c's, so the section 2.3 union still holds the 98 codes, and every planning refusal code E8 uses is in it (`scratchpad/contract-v3.5/codes-check.txt`).
- Revision v3.4: v3.3 with erratum E7 (`scratchpad/design/errata-v3-E7.md`) applied in place, in the section and card each item governs. E7 wins over E6, E6 over E5, and E5 over v3.3 (and v3.2 beneath it). The v3.4 changelog, which names every E7 item and the sections it changed, stays in `scratchpad/design/CONTRACT-v3.4.md`. v3.3's check said AMEND with one blocking finding, B1, and six non-blocking ones, N1 to N6; E7-C rules on all seven. E7 is the last allowed repair (repair 2 of 2) for K2, L1, P1 and X1b. The bases E7 gives were checked read-only: every rebased leaf commit is patch-equal (`git patch-id --stable`) to the commit E7 names (`scratchpad/contract-v3.4/patchids.txt`), INT-2c `115ab8d7f` is the head of `agent/request-to-code-v3`, and the refusal codes E7 uses are all in the section 2.3 union (`scratchpad/contract-v3.4/codes-check.txt`).
- Revision v3.3: v3.2 with errata E5 (`scratchpad/design/errata-v3-E5.md`) and E6 (`scratchpad/design/errata-v3-E6.md`) applied in place, in the section and card each item governs. E6 wins over E5, and E5 over v3.2. The v3.3 changelog, which names every E5 and E6 item and the sections it changed, stays in `scratchpad/design/CONTRACT-v3.3.md`. v3.2 was frozen by its check (E6), and E6-C rules on that check's twelve findings, F1 to F12. The code names E5 and E6 cite were checked read-only at INT-2b `ee89957c1`, which holds the 98 codes of the section 2.3 union in order, and at the round-1 heads E5 and E6 name.
- Revision v3.2: v3.1 with errata E3 (`scratchpad/design/errata-v3-E3.md`) and E4 (`scratchpad/design/errata-v3-E4.md`) applied in place, in the section and card each item governs. E4 wins over E3, and E3 over v3.1. The v3.2 changelog, which names every E3 and E4 item and the sections it changed, stays in `scratchpad/design/CONTRACT-v3.2.md`. The code names that E4 cites (`CCC_PLANNING_REFUSAL_CODES`, `sealCccToolchain`, the factory's `testOnly`, `CCC_WRITER_SHELL_PROFILE_TEMPLATE_MATERIAL`, `instance-disposed`) were checked read-only at INT-1b `ff4fc3e4f`.
- Revision v3.1: v3 with errata E1 (`scratchpad/design/errata-v3-E1.md`) and E2 (`scratchpad/design/errata-v3-E2.md`) applied in place, in the section and card each item governs. E2 wins over E1, and E1 over v3. The v3.1 changelog, which names every E1 and E2 item and the sections it changed, stays in `scratchpad/design/CONTRACT-v3.1.md`.
- Status: frozen for I1 and I2 card dispatch. Date: 2026-10-14. Branch: `agent/request-to-code-v3`. v2 was written at `a08af2c73`; v3 was checked at `dbe834b82`, where the W1 cards C6b, B4 and B2 have landed. `pi.ts`, `executor.ts`, `workflow-work-processor.ts`, `workflow-graph-executor.ts` and `ccc-campaign-operator-control.ts` are unchanged between the two commits.
- Revision: v3 is v2 with targeted edits. It applies the leader rulings in `scratchpad/design/adjudication-v2.md` on the findings in `scratchpad/design/verify-v2.md`: blocking items 34-41, 51 and 18 (closing the PARTIAL items 6, 9, 14, 18 and 29), later items 42-52, the repair-count ruling and the rulings on the questions for Ryan. Every edit was checked read-only against the worktree code; `fix-ledger-v3.md` maps each item to the sections it changed and the code evidence. Sections it does not name are unchanged from v2, which applied challenge findings 1-33 (`fix-ledger-v2.md`).
- Inputs: PRD `docs/plans/2026-10-13-ccc-fusion-request-to-code-prd-v3.md`; ADRs A (host and ledger), B (artifacts and import), C (sessions and confinement), D (proof, install and authority) in `scratchpad/design/`; critic points 1-15 in `scratchpad/i0-gap-and-critic.md`; challenge findings 1-33.
- Precedence: PRD v3, then this contract, then the ADRs. Where an ADR disagrees with this file, this file wins. A leaf that finds a contract fault stops and reports. It never "fixes" a frozen contract in place.
- Paths are relative to the worktree root `/Users/ryanpappal/03_CODE/ccc-fusion/.worktrees/request-to-code-v3`.

## v3.5 changelog

v3.5 applies erratum E8 (`scratchpad/design/errata-v3-E8.md`) in place. E8 wins over E7, E7 over E6, E6 over E5, and E5 over v3.4. Each entry names one E8 item and the sections or cards it changed. The v3.4 changelog (E7) stays in `scratchpad/design/CONTRACT-v3.4.md`.

E8 verdicts (repair 2, final) and INT-2d:
- **K2 ACCEPTED** at `c594c8c02` (critical lane, review and adversary), with three recorded residuals: K2 card "Repair 2 outcome (E8)"; section 2.7 (residual list); section 2.17 step 3, IB2 RED and IB2 rule (the G8 obligation); section 6 risks 55 and 56.
- **L1 ACCEPTED** at `dbe1f6a71` (both), with the E7-L 8(b) finding (dispatch counters keyed by lineage id alone): L1 card "Repair 2 outcome (E8)"; D13 lineage-admission bullet; section 2.1 "Superseded lineages and split children"; section 2.11 `admitCccPlanningDispatch` comment.
- **P1 lineage closed, re-planned** (`66ef8f379`; a body-processing failure after `[DONE]` settles `provider-error-event` and retries, adversary probes B1 to B3): P1 card "Repair 2 outcome (E8)"; new W3 card P1z; W3 base paragraph; W6 gate paragraph; C6 Depends; section 3.2 feeders.
- **X1b lineage closed, re-planned** (`270f92439`; `discoverCccToolchain` still requires `searchPath`): X1b card "Repair 2 outcome (E8)"; W1 residual "Repair 2 (E8)" paragraph; "Integration of the W1 residual" paragraph; new W3 card X1z; SF, CL2 and WR Depends; section 3.2 feeders.
- **W2 repair 2 outcome**: new paragraph after "W2 repair 2"; header revision bullet.
- **INT-2d** (`fcb83879d`): new INT-2d paragraph after INT-2c, with the check results from `scratchpad/int2d/summary.txt`; the INT-2 and "INT-2 additions" paragraphs marked done; section 2.10 task marker (dashboard guard switched); section 2.11 `completeCccPlanningCancellationWithin` comment (core barrel added); section 2.12 marker comment (engine barrel exports added); Appendix multi-owner list (dashboard guard) and parent-owned list.

E8-0 (leader decisions and rulings on the v3.4 check):
- **B-1** (blocking; a within-transaction state transition for BF): D43 note (E8-0); D45 note (E8-L); section 2.11 new `transitionCccPlanningRunStateWithin`, the `applyCccPlanningCampaignOutcomeWithinTransaction` comment and the "Through L1" paragraph; new card L1z; BF Depends, REDs and rule; W6 gate paragraph; section 3.2 feeders. The item stays open until L1z is accepted.
- **N-1** (the marker helper returns a new frozen controller): D48 note; section 2.12 `attachCccProviderAttemptBoundRoute` signature and comment (v3.4's editor's `controller: object` retired); section 2.11 "Through L1"; WR RED and rule (the binding is built around the returned controller); P1 card "Repair 2 outcome (E8)".
- **N-2** (L1's E7-L 7 control accepted as the only form the `UNRECONCILED_DISPATCH` guard allows): L1 card "Repair 2 outcome (E8)".
- **N-3** (the semantic-id collision refusal moves to GG): D13 lineage-admission bullet; section 2.1; section 2.11 `admitCccPlanningDispatch` comment; section 2.17 G4 (new collision check); GG RED and rule; AD1 rule (replaced: run-id derivation only); L1 card "Repair 2 outcome (E8)".
- **N-4** (K2 refuses probe F4 with `CCC_ROUTE_IDENTITY_REJECTED`, reason `role-model-mismatch`; the bridge reports `CCC_PLANNING_ROUTE_NOT_ADMITTED`; K2's own 7-key `CccPlanningReviewIdentity`): section 2.7 review-identity rule; section 2.3 comment; section 2.17 step 3; K2 card (E7-K 5) and "Repair 2 outcome (E8)"; IB2 rule.
- **N-5** (BF's `openCccPlanningLinkedWriterAttempt` result gains `route`): D48 note; section 2.11 `openCccPlanningLinkedWriterAttempt` result and comment, and "Through L1"; BF RED and rule; WR RED (type test) and rule.
- **N-6** (a split child with a fixed lineage id is refused `CCC_PLANNING_ROUTE_NOT_ADMITTED`, detail `lineage-not-admitted`): D13 lineage-admission bullet; section 2.1; section 2.11 `recordCccPlanningLineageSplit` comment; L1 card "Repair 2 outcome (E8)".
- **N-7** (the K1 test-tsc check at INT-2d and every later INT step): INT-2c paragraph (the owed check settled); INT-2d paragraph; INT-3; INT-8; L1z Check.
- **N-8** (the section 2.3 header comment): v3.4 changed the `CccPlanningRefusalCode` header comment (the two E7 lines, "E7 adds no code either", checked at INT-2c) without listing it; it is listed here. v3.5 adds three comment lines there: E8 adds no code (checked at INT-2d), and K2's `CCC_ROUTE_IDENTITY_REJECTED` is not in the union.
- **Editor's conflicts confirmed**: P1's adapter grant covers E7-P item 1 and P1z (section 2.12 adapter comment; P1 Owns adapter entry and rule; Appendix lists); the K2 parse widening and its `PROFILE_NOT_SUPPORTED` RED belong to I6 (section 2.18 step 6; CL2 RED; section 3.3, moved from I5 to I6); the proof runner owns its PostgreSQL and a command that invokes it sets neither PostgreSQL variable (section 3.0 rule 4, the editor's note now a confirmed rule); BF's and WR's owed REDs (BF and WR REDs); the attach types (section 2.12).
- **Item 6 refusal reason** (a planning scope refused under a non-planning binding settles `effective-route-drift`): D10 note (E8); section 2.12 settlement rule (the "unreachable" note corrected); P1 card (P11).
- **P1 residuals** (recorded, not fixed): section 2.12 settlement rule; P1 card "Repair 2 outcome (E8)"; section 6 risk 57.

E8-P (card P1z): new W3 card P1z, items 1 to 4; D10 note (E8); section 2.12 adapter comment (items 1 and 2) and settlement rule; H1 rule (E8-W3); Appendix multi-owner list (the adapter, the settlement test and `cards/p1.mjs`) and "exactly one card" list.

E8-X (card X1z): new W3 card X1z, items 1 to 3; section 2.13 `discoverCccToolchain` comment (item 1) and shell-compat comment (item 2); section 2.18 step 11; section 4.4 G0 bullet; Appendix multi-owner list.

E8-L (card L1z): new W3 card L1z, items 1 to 6; D45 note (E7, amended by item 3) and D45 note (E8-L, items 1 and 3); section 2.1 event subjects; section 2.11 `completeCccPlanningCancellationWithin` signature (`projectId`, as accepted) and deferral comment, and the new `transitionCccPlanningRunStateWithin`; Appendix multi-owner list.

E8-W3 (W3 dispatch notes): W3 base paragraph (base INT-2d, store operations from `@fusion/core`, the three re-plan cards and their gates); AD1 rules; C2 Owns `pi.ts` entry (region (b) located by content) and rule; H1 rule.

INT-3 barrel duty (task): INT-3 paragraph (`transitionCccPlanningRunStateWithin` is exported by INT-2d's `export *`; AD1's new `ccc-planning-admission-ops.ts` needs a core barrel line); AD1 rule; Appendix parent-owned list.

Checks (task, not an errata item): the Appendix v3.5 re-run bullet. `scratchpad/contract-v3.5/` holds the adapted checker and its output, the patch-id and refusal-code checks, the v3.4 to v3.5 diff and the removed-line trace.

Editor's additions in v3.5, labelled in place, for the leader to confirm:
- P1z's marker (section 2.12 adapter comment; P1z rule): E8 writes `cccRouteFailure: "receipt-missing"` with detail `receipt-not-terminal` or `non-sse-response`. The adapter's error event has no detail field, so v3.5 puts the detail in the error message. `"receipt-missing"` is in `pi.ts`'s `CCC_ROUTE_FAILURE_KINDS`, which is why P1z needs no `pi.ts` edit; the adapter's existing kind `"receipt-not-terminal"` would settle the same way.
- GG's N-3 refusal code (section 2.17 G4; GG rule): E8 names none, so v3.5 uses `CCC_PLANNING_GRAPH_INADMISSIBLE`, like G4's other graph diagnostics, and K1's code list is unchanged.
- `projectId` in `transitionCccPlanningRunStateWithin`'s input (section 2.11; L1z rule): written in, as `completeCccPlanningCancellationWithin` has it. E8-L item 1 asks for it only if the within form needs it, and L1z reports which.
- The W6 gate (W6 paragraph): E8 says P1z is accepted before W6. v3.5 holds all of W6 until P1z and L1z are accepted, and encodes the gate as Depends entries on C6 (P1z) and BF (L1z).
- X1z in CL2's and WR's Depends: E8 names G0 step 11 and WR as callers of discovery's defaults, but requires X1z only before W4 (SF).
- INT-3's barrel line for AD1's `ccc-planning-admission-ops.ts`, derived from AD1's callers outside core.
- INT-2d paragraph and INT-3: an INT script builds the engine before the CLI and dashboard typechecks, from INT-2d's first-run TS2305.

Open items closed by E8:
- The BF and WR REDs E7-0 named no RED for: closed by E8-0 (BF's within-function, pending-cancel and `route` REDs; WR's returned-controller RED and type test).
- E7-L item 8(a)'s refusal code: closed by N-6. Item 8(b)'s finding: counters are keyed by lineage id alone; AD1's E7-0 obligation is withdrawn and the refusal moves to GG (N-3).
- INT-2c's owed K1 test-tsc check: run at INT-2d (N-7).
- The section 3.0 editor's note on the proof runner and `FUSION_PG_TEST_SKIP`, and the widened adapter grant: confirmed by E8-0.
- v3.4's editor's note on `attachCccProviderAttemptBoundRoute(controller: object, ...)`: closed by N-1 (P1's generic types).
- The I5 against I6 epic for the K2 parse widening: I6 (E8-0).

New open items:
- B-1 stays open until L1z is accepted; BF (W6) is not dispatched before then.
- P1z must be accepted before W6, and X1z before W4 (SF).
- GG's N-3 check goes into GG's first repair round or, if GG is accepted without one, into a GG follow-up accepted before W8.
- The IB2 G8 obligation stays open until `CccRouteRole` gains a G8 role; the card that adds it makes K2's admission refuse a G8 identity whose graph role is writer or g7-review (risk 56).
- The editor's additions listed above need the leader's confirmation.

## 0. ADR conflicts and how they are resolved

| # | Topic | What the ADRs (or v1) said | Winner | Why |
|---|---|---|---|---|
| 0.1 | Migration numbers | A: `0042_ccc_planning_runs.sql`. B: `0042_ccc_planning_artifact_guard.sql`. | Both kept: **0042 = anchor table, 0043 = artifact guard**. One card (S0) owns both. | The artifact trigger reads the anchor for run membership and fences, so the anchor must exist first. A single owner also owns the three baseline pins (critic 5). |
| 0.2 | Stage ids | A: 13 ids (`admit`, `design-a`, ...). B: 15 ids (`srcverify`, `decision`, `receipt`, `build`, ...). | **One unified list (section 2.4)**. | IR node config, artifact keys, the trigger and turn keys must all speak one vocabulary. |
| 0.3 | Pi scope type | A: generic view types that keep the campaign field names. C: a separate `CccPlanningProviderAttemptScope` with `scopeKind` and `runDeadlineAt`. | **A's generic views and field names**, with C's binding fields added under `binding.kind = "ccc-planning-route.v1"`. C's tool policy and hooks are kept. C's settlement rule is kept **for planning scope only** (0.22). | `pi.ts` association, permit and reconcile asserts already read those names. A union scope would fork every assert. |
| 0.4 | G7 and G8 placement | A: compose reviews into the existing proof-suite gate inside the campaign work item. C: add `g7-review` routes and review tasks to the execution policy. | **A wins on placement.** C's verdict tool, critic tool set and route admission (including the same-family check) are kept. | No importer or IR change and no extra graph tasks. The campaign route binding admits only the writer route (`provider-attempt.ts:1188`). |
| 0.5 | Import idempotency key | A and D: `ccc-plan:<run>:<digest>`. B: `ccc-plan:<runId>:r<n>`. | **B wins.** Because the run id already carries the prefix, the key is `${runId}:r${revision}`, which is `ccc-plan:<24hex>:r<n>`. D's envelope check uses this key. | A digest-keyed key lets a retry with a changed digest create a second campaign (critic 7; B test T2.9). |
| 0.6 | Import mechanics | A: anchor CAS, then importer, then link (`build-bridge.ts`). B: intent artifact, importer, then RECONCILE through `inspectCccPrdImport` (`import-bridge.ts`). | **Merged into B's `import-bridge.ts`.** The `import_intent` artifact and A's anchor CAS are written in **one transaction** before the importer runs. A's link step follows. `build-bridge.ts` is not created. | One effect identity, persisted before the effect (PRD §9). |
| 0.7 | Campaign `maxRequests` | A: `min(implementation_allocation, 10000)`. D: 840, the fit floor. | **A wins**: 3,072 for Build Standard. | The floor is an admission test, not a spend cap. The PRD allows using less. Writer caps (D15) bound each task anyway. |
| 0.8 | Campaign `maxDurationMs` | A: `deadline − now − 30 s`. B: the importer ceiling is 24 h. | **`min(deadline − boundsComputedAt − 30 s, 86,400,000)`**, computed **once** and stored in the `admission_facts` artifact with the clamp (D16). | Both constraints are real (`import-admission.ts:88-102`). The importer reads bounds from `bundle.bounds`, which is inside `bundleHash`, so the value must never be recomputed on retry (challenge 21). |
| 0.9 | Review/proof N | A: tasks + 1 + proofs. D: 4 + 1 + one acceptance-run auditor. Critic 13: G7 was double counted. | **`N_impl = T`, `N_rev = T + 1 + P`**. P counts model proof or audit nodes in Build, and P = 0 in I2. | Each call is counted in exactly one phase. |
| 0.10 | Tool-fidelity preflight | C: 3 calls charged to planning. D: no preflight in N. v1: one planning node holding 9 calls. | **Controller-issued qualification calls, not a planning node.** Three lineages `preflight:writer`, `preflight:critic`, `preflight:researcher`, each at most 3 calls per attempt (one automatic attempt), reserved and spent against the **planning** allocation, excluded from N and covered by the fixed +300 term, and reported as a separate `preflightSpent` line (D29). | v1's single node could not hold three models under one binding, and its three probe sets used up all three dispatch attempts of one lineage (challenge 9). Counting them as 3 nodes breaks the Build Standard floor (N = 17, floor 1,620 > 1,536). |
| 0.11 | Receipt storage | D: an anchor column is preferred; otherwise `ccc_effect_receipts`. | **Anchor columns** `authority_receipt_sha256` and `authority_receipt_json`, unique per project. | No new table. Consumption is in the same transaction as admission. |
| 0.12 | Research grant port | C: a port that "ADR A implements". | **Anchor columns** for fetch count and bytes, plus per-fetch audit events. | Same backstop pattern as call spend. |
| 0.13 | Artifact fences | B: `admission` and `work_item_lease` only. | **Four kinds**: `admission`, `work_item_lease`, `campaign_work_item_lease` and `operator`. | G7 and G8 publish under the campaign item fence (0.4). Operator answers come from the CLI with no lease. |
| 0.14 | Design seal | B: by `stageId = 'design'`. | **By `kind = 'design_alternative'`** over the transitive input closure. | Design reviews live in stage `design-review` and must not be confused with alternatives. |
| 0.15 | Admission membership | B: admission must be the first artifact on the task. | **Membership through the anchor row.** Several admission artifacts are allowed while the anchor state is `admitted`. | Admission publishes `original_request`, `admission_grant` and `authority_receipt` together. |
| 0.16 | State vocabulary | A: coarse (`blocked`, `exhausted`). PRD §9: fine-grained. | **Fine-grained, 20 states (section 2.3)**, with an SQL transition function of 65 pairs (v3 adds `importing → budget_exhausted`, verify-v2 item 38). | `fn plan status` must show the PRD's states exactly. |
| 0.17 | Card names | D's proof runner is "P1". A's Pi seam is also "P1". C's binding card is "C1". | The proof runner is **P0**. **P1 = C's C1** (binding, planning-scope settlement, `pi.ts` region (a), `agent-runtime.ts`). A's Pi seam **types** move to K1 (0.24). | One owner for `pi.ts` region (a) and `agent-runtime.ts`; the types land a wave earlier so L1 can typecheck (challenge 13). |
| 0.18 | Proof inventory modules | D: shared area modules (`contracts.mjs`, `store.mjs`, ...). | **One module per card**: `scripts/lib/ccc-planning-proof-inventory/cards/<card-id>.mjs`. `index.mjs` loads `cards/*.mjs` in sorted order and is owned by P0. | Files stay pairwise disjoint without a parent-owned registry edit. |
| 0.19 | Coding repair | A: a G7 or G8 rejection claims a repair chunk. A §Q3.7 and D5: coding repair may not exist in I2. | **NOT RUN in I2.** A rejection parks the campaign with `CCC_PLANNING_CODING_REPAIR_NOT_RUN` and claims no chunk. | Claiming a chunk it cannot use would waste the shared allowance. |
| 0.20 | Event id and audit literals | A: L1 changes `data-layer.ts` and `run-audit.ts`. v1: S0 adds a new `EVENT_ID_COLLISION` code. | **S0 owns both** in W1, and **reuses** the existing `onConflictDoNothing`-then-compare pattern and `RunAuditEventCollisionError` (`data-layer.ts:232, 397-433`). No new collision code. | A1 and L1 both publish audit events in W2. Reuse instead of a parallel mechanism (challenge 25). |
| 0.21 | Route admission location | C: `core/ccc-campaign/route-admission.ts`, with edits to `canonical.ts` and `importer.ts`. | **Location kept, but `canonical.ts` and `importer.ts` are not changed.** The import bridge calls route admission for planning-linked imports only. | Direct `fn prd` behaviour stays byte-identical (PRD §2). Critic 11 is still closed for request-to-code writers. |
| 0.22 | Receipt-mismatch settlement scope | C and v1 D10: settle `proved_failed` on drift, campaigns included. | **Planning sessions and planning-linked writers only.** Campaign and direct `fn prd` behaviour, and `pi.test.ts:1872-1909`, stay byte-unchanged. In planning scope a drift or receipt mismatch settles once as a known-effect refusal and moves the run to `blocked_provider` / `CCC_PROVIDER_PIN_DRIFT`, with no further calls and no retry. | Today's hold on a wrong-model response is a safety property (PRD §2 "keep direct intake unchanged", PRD §5 no unapproved substitute). v1 turned it into an automatic retry (challenge 2). |
| 0.23 | Workflow IR builder location | A: engine (`H1`). | **Core, card K1** (`packages/core/src/ccc-planning/workflow-ir.ts`), pure. AD1 (core) stores it; H1 verifies it. | Core cannot import engine; AD1 must pin the IR at admission (challenge 10). |
| 0.24 | Pi seam view types | A and v1: P1 adds them in W2. | **K1 owns the type-only hunks** in `ccc-campaign/types.ts` and `ccc-campaign/provider-controller.ts` (W1). P1 imports them. | L1 (W2) uses them (challenge 13). |
| 0.25 | pi-ai workspace patch | D: the installed receipt records `piAi.workspacePatch`; challenge 15: carry the patch into the installed runtime. | **No patch is carried and nothing is hand-patched.** The keepalive response-model rule already lives in Fusion-owned code (`ccc-route-receipt-adapter.ts:394-413`), selected for every bound route (`pi.ts:3645-3673`) and bundled into the CLI (`tsup.config.ts:398-412`, `noExternal: [/^@fusion\//]`). pi-ai itself ships external and unpatched (`packages/cli/package.json` dependency). The receipt records `keepaliveModelSource: "fusion-receipt-adapter"` and `workspacePatch: "not_carried"`; P1 refuses a binding that would bypass the adapter (D48). | This is the adjudication's second option ("move the keepalive model read into Fusion-owned code so no patch is needed"), which the code already satisfies. Hand-patching is synthetic and does not count. |
| 0.26 | Pause and cancel during Build | A Q3.2 and v1 D32: a control flag plus "existing operator control", no owner. Challenge 6: bridge or refuse. v2: bridge all three through `applyCccCampaignOperatorControl`. Verify-v2 item 36: during `building` the processor holds the campaign item's lease for the whole graph (`workflow-work-processor.ts:196-214`, one terminal transition at `:404-430`), and the operator control refuses a leased item (`ccc-campaign-operator-control.ts:186-195`), so v2's bridge always got LEASED. | **Cancel is bridged; pause and resume are refused (card CB).** `fn plan cancel` during `building` uses the existing in-lease cancel: the task-move disposer aborts the processor with `workflow-user-cancelled` (`workflow-work-processor.ts:107-135, 383-397`), the item ends `cancelled`, and BF maps that to `cancelling → cancelled`. The disposer is registered per TaskStore instance (`task-move-disposer.ts:17-22`), so CB records the cancel on the anchor and serve applies it on its own store (WR wires the applier). An unleased item is stopped through the operator control, and an item that has already ended gets the L1 cancel directly (items 43 and 44). Pause and resume during `building` or `importing` are refused with `CCC_PLANNING_COMMAND_NOT_SUPPORTED`, an I4 must-do (section 4.5). | One existing mechanism for each case; every refusal is explicit and tracked. |
| 0.27 | Build baseline B1 | B: "the verifier-preparation ADR" (which does not exist) creates B1. v1: nobody. | **VP owns the baseline step** (`build-baseline.ts`), run by IB2 before the shared preflight. B1 is committed on a Fusion-owned branch in the target; the target's `main` stays at B0. | The import intent requires `targetBase = B1`, and the shared preflight requires HEAD = `bundle.targetRepository.baseCommit` (`prd.ts:2110-2115`) (challenge 3). |

## 1. Architecture decisions

Each decision has one line and an evidence pointer. "file:line" refers to the worktree at `a08af2c73`.

- **D1 Native host.** One planning task, one Fusion workflow made of gate nodes (`config.cccPlanningStage`), and one work item per run. The existing lease and fence are reused. Evidence: `workflow-work-processor.ts:334-386`, `workflow-task-runtime.ts:1090-1122`, ADR A Q1.
- **D2 Custody discriminator.** `custody: "campaign" | "planning"` on processor and runtime options. `campaignRequired: true` is an alias for `"campaign"`. Evidence: `workflow-work-processor.ts:171-186`, `workflow-task-runtime.ts:514-555, 725-791`.
- **D3 Planning recovery reuses the lease reclaim.** Expired leases are reclaimed by the existing acquire path, which re-claims `runnable`, `retrying` and lease-expired `running` items (`workflow-workitems-ops-2.ts:243-262`); no planning requeue code is written. H1 adds only two checks: at every stage start, any `dispatched_unknown` call in the run moves the run to `unknown_effect` and that lineage is never re-dispatched; and at engine start, `completeCccPlanningCancellation` finishes any `cancelling` run with no live holder. Evidence: challenge 25, ADR A Q1 "Restart and resume".
- **D4 Anchor, not ledger.** `project.ccc_planning_runs` (0042) holds identity, grant, counters and control. Per-call history is append-only `run_audit_events` with deterministic ids. Evidence: ADR A Q2, critic 2.
- **D5 Retention exclusion.** Maintenance never deletes `run_id LIKE 'ccc-plan:%'` audit rows. Evidence: `async-maintenance.ts:95-101`, `settings-schema.ts:781`.
- **D6 Artifacts are task documents.** Immutable `cccplan-` documents on the planning task, guarded by trigger 0043 and the publisher GUC. Evidence: ADR B Q1, critic 14.
- **D7 Migrations.** 0042 and 0043 belong to card S0, together with the applier, Drizzle schema, `projectTableNames` and the three `"0041"` baseline pins. Every key and foreign key of the anchor starts with `project_id`, including the composite task FK `(project_id, planning_task_id) → project.tasks(project_id, id) DEFERRABLE INITIALLY IMMEDIATE`, because 0006 rebuilds every project key as `(project_id, …)` and the boot ownership audit refuses anything else. `0000_initial.sql` is not edited. Evidence: `0006_project_ownership.sql:329-356`, `schema-applier.ts:66, 177, 406, 625-630, 640-706`, precedent `0037_ccc_campaign_governance.sql:103`, `schema-applier.test.ts:231`, `ccc-campaign-semantic-proof-v2-migration.pg.test.ts:65`, `ccc-campaign-execution-authorization-migration.pg.test.ts:166`.
- **D8 Unified stages.** There are 12 IR stages and 5 artifact-only stages (section 2.4). Keys are decoded from the right because stage ids may contain hyphens. Evidence: conflict 0.2.
- **D9 Pi seam.** Generic view types, owned by K1 (0.24). The planning scope reuses the campaign field names, and `binding.kind = "ccc-planning-route.v1"`. Evidence: `ccc-campaign/types.ts:337-346, 366-371, 383-404, 418-427`, `provider-controller.ts:21-25`, `agent-runtime.ts:74-84`, ADR A Q2 signatures.
- **D10 Terminal receipt settlement, planning scope only.** For `scopeKind` `"planning"` and `"planning-linked-writer"`: route drift, a missing receipt or a mismatched receipt on a non-error terminal, or (E7-0) a terminal receipt that names a route other than the bound one on an upstream error terminal, reconciles the attempt **exactly once** as `proved_failed` with the refusal evidence; the planning call outcome is `refused_known_effect` (response discarded, spend kept, never "zero effects"); the settlement itself moves the run to `blocked_provider` / `CCC_PROVIDER_PIN_DRIFT` in the same transaction (L1 for planning sessions, BF for linked writers); `pi.ts` then throws out of its slot loop instead of moving to the next slot after the `proved_failed` hold (`pi.ts:1030-1035`), so no further call is issued and nothing retries (dispatch keys `["pi-stream:1"]`, verify-v2 item 42). A provider `error` event whose terminal receipt, if any, names the bound route settles `proved_failed` with outcome `failed_known_effect` (E7-0), and a retry inside the caps is allowed: that `proved_failed` terminal hold advances `nextSlot`, so the retry in the same session takes the next dispatch key (`["pi-stream:1","pi-stream:2"]`). The throw-instead-of-advance rule of item 42 applies only to a held decision with `refused_known_effect`, or another route refusal (E2-1). Campaign scope is unchanged: drift stays `dispatched_unknown` and `pi.test.ts:1872-1909` is not edited. Evidence: `pi.test.ts:1872-1909`, `pi.ts:690-700, 1070-1095`, `provider-attempt.ts:1532-1591`, challenge 2.
  - **D10 note (E5-P1 items 1, 2 and 4).** The receipt adapter marks the error events it emits: `cccRouteFailure` for a terminal-receipt failure, which planning scope settles once as a route refusal (`receipt-missing`, or `receipt-mismatch` when a conflicting or observed receipt exists) and never advances; `cccTransportFailure: true` for a terminated stream, a socket reset, a fetch failure or an adapter timeout, which is not settled, so the attempt stays `dispatched_unknown`; an upstream-reported error carries neither and settles `provider-error-event`, then advances. This settles the lost-connection rule of section 2.12. `pi.ts` records a refused slot in its route-refusal memory before it awaits the settlement, so a reconcile that persists and then rejects still leaves the session refusing re-entry without a second dispatch. The adapter's abort shape (`{type: "error", reason: "aborted", …}`) is not settled and stays `dispatched_unknown`.
  - **D10 note (E7-0, amending D10; E7-P items 1, 3, 4 and 9).** A terminal receipt that names a route other than the bound one refuses `receipt-mismatch` and never retries, whether the upstream ended normally or with `finish_reason: error`: the PRD's failure probe "reject effective-model drift" outranks D10's narrower "non-error terminal" wording. The same upstream error with the bound model's receipt still settles `provider-error-event` and advances. A `receipt-mismatch` settlement keeps the observed conflicting `providerId` and `modelId` (bounded strings) in its evidence, never `observed: null`. Any error raised after the response body began and before `[DONE]` is a transport failure (`cccTransportFailure: true`, not settled, so the attempt stays `dispatched_unknown`) unless the upstream itself reported it (a parsed `finish_reason: error`, or an error object in a complete event). Rulings, no code: a receipt that is not terminal (a matching receipt followed by a data line) and an incomplete receipt settle `receipt-missing`, because no terminal receipt was observed; refusal memory stays per session (L1's and BF's run-state block covers new sessions); `cccStreamGuard` is a presence check.
  - **D10 note (E8-P items 1 and 2; E8-0, item 6).** A body-processing failure after `[DONE]` (a cut or malformed data line after it) and a 200 response that is not `text/event-stream` are route refusals: each settles `receipt-missing` once and never retries (P1z, section 2.12), never `provider-error-event`. A planning scope refused under a non-planning binding settles once with `refusalReason: "effective-route-drift"`, which L1 and BF map as a route refusal (section 2.12).
- **D11 Closed tool policy.** The binding's `toolPolicy` overrides caller tools, and the final tool set must **equal** the policy and match its digest. No MCP, web, `fn_task_*` or document tools reach any role. `grep` is a Fusion-owned TypeScript tool over the confined read operations; Pi's own `grep` (which always runs `ensureTool("rg", true)`) is never offered, and `find` uses a custom `glob` so Pi never needs `fd`. The planning-linked writer's policy is the writer toolset plus `fn_complete_phase` (`CCC_PLANNING_LINKED_WRITER_TOOLSET`, policy id `ccc-linked-writer-tools.v1`), because the campaign writer must call it to finish a phase; the preflight writer keeps the plain writer toolset (verify-v2 item 37). Evidence: `executor.ts:18861-18869, 19181-19187, 19267`, `ccc-campaign-ready.ts:883-900`, `workflow-step-tool-policy.ts:4-24`, `pi.ts:4043-4071, 4149`, Pi `dist/core/tools/grep.js:95`, `grep.d.ts:24-29`, `find.js:101-112, 157`, critic 8 (C6), challenge 8.
- **D12 Confined shell.** Each invocation runs under `sandbox-exec` with a sealed toolchain cloned per operations instance, an env allowlist, an in-sandbox reaper as the fast first line, and closure confirmed by a controller-side sweep that runs outside the sandbox (E1-18, ADR X1-R). G0 runs a self-qualification probe. X1 reuses the existing semantic-proof sandbox pieces (`acquireCccSemanticProofLoopbackPort`, `inspectCccSemanticProofSandboxReadiness`, the process runner) instead of a second implementation. Evidence: ADR C Q3 and probes P1-P9, `ccc-campaign-proof-sandbox.ts:21, 87, 117-140, 547`, critic 8 (C5), challenge 25, X1 review probes P4 and P6.
  - **D12 note (E2-12).** E1-18 overrides ADR C on two points: the toolchain is a per-instance clone, and closure authority is a controller-side sweep. The reason is the X1 review's P4 and P6 escapes: an in-sandbox reaper can be killed or frozen by the command (`(allow signal (target same-sandbox))`). Clone location, hash check and cleanup are in section 2.13 (E2-24).
  - **D12 note (E4-5, E4-B, E4-9).** The sealed toolchain comes from one discovery, X1b's `discoverCccToolchain`, which seals only through X1's `sealCccToolchain`. G0 step 11 runs it before `qualifyCccConfinedShell`, and SF and WR take their toolchain from the same discovery. Whoever creates a confined shell disposes it and reads its closure result: SF for planning sessions, WR for writer sessions (section 2.12).
  - **D12 note (E6-0).** The host is not changed: there is no `brew install`. Discovery's default required set is the minimal set every Fusion command needs (`bash`, `sh`, `node`, `git`, `task`, `rg` and the GNU coreutils); GNU grep, sed, findutils, gawk and diffutils are optional, sealed when found and left out when not. The default search path is Homebrew only, never a user-writable directory (section 2.13). A cloned binary pays macOS's first-launch check, so SF and WR measure that cost before they trust short model timeouts (section 6 risk 50).
- **D13 Counters (the caps compose; leader ruling).** Eleven calls per node attempt (1 initial + 10 feedback-processing calls), with dispatch keys `pi-stream:1..11` (1-based, `pi.ts:820`). Three dispatch attempts per node lineage, counted at the first reservation of a turn key. Lineage survives splits, and renaming or splitting never resets a counter.
  - **Author lineages** (every role whose class is not `critic`: spec author, execution planner, verifier author, designers, intent assessor, researchers, writers) keep **one** dispatch counter across their initial attempt and every repair of their own candidate. A repair lineage inherits the author's count through its `lineage:created` event, so one author gets at most 1 attempt plus 2 repairs.
  - **Reviews are per candidate version.** A fresh, independent review of a new candidate version is a new review node with its own counter of 3 (inherited 0), linked to the reviewer's parent lineage for spend attribution, because the PRD defines a review epoch per candidate version and critics receive no previous verdicts. Retrying the same review of the same version counts against that review node's 3.
  - One repair epoch of at most 4 chunks, shared across all lineages, bounds repairs globally. Stop after 2 stagnant review epochs.
  - Lineage admission (E5-L1 items 3 and 4). A call is admitted only on a lineage id of section 2.1 that is fixed for its stage and role, or on one a `lineage:created` event recorded for the run with the same role; repair and re-review lineages always need that event. Once a repair claim creates a lineage for a role, every earlier lineage of that role takes no new call reservation (`ROUTE_NOT_ADMITTED`, detail `lineage-superseded`), the next call of a continuing turn included, while a call already dispatched still settles normally (E7-L item 7, which replaces the allowance E5 item 4 left for a continuing turn); the claim refuses `UNRECONCILED_DISPATCH` while any earlier lineage of the same role has a `reserved` or `dispatched_unknown` call. A split child may not take a fixed lineage id (E7-L item 8); L1 refuses it `CCC_PLANNING_ROUTE_NOT_ADMITTED`, detail `lineage-not-admitted` (E8-0, N-6). Dispatch counters are keyed by lineage id alone (E7-L item 8(b), L1's repair 2, accepted in E8), so L1 refuses a campaign-fence lineage whose id equals a planning fixed lineage id, and GG's G4 refuses a plan whose semantic task id would form a G7 lineage id `review:<id>` equal to one (E8-0, N-3). Recorded, not changed (E7-L item 11): splitting an unused parent gives each child a fresh 3 attempts, as D13 is written, because each child inherits the parent's count of 0; supersession is per role, so H1, BF and ST2 never name `task-reviewer` as a coding-rejection re-reviewer.
  - Evidence: PRD §5, PRD:157, ADR A Q2, challenge 17, `adjudication-v2.md` (repair-count ruling).
- **D14 G7 and G8 composition.** Reviews and the final judge run inside the campaign work item, after the proof gate passes. They are charged to planning `review_proof` under the campaign fence. Reviewers read the **candidate** snapshot named by the proof gate (`ccc:proof:source-commit`, `ccc:proof:source-tree`), and G8 also receives a controller-published `proof_results` artifact. Evidence: `in-process-runtime.ts:2109-2112`, `ccc-campaign-proof-execution.ts:2011-2015, 2020`, ADR A Q3.4, challenge 4.
- **D15 Linked writer caps.** `reserveCccProviderAttempt` applies the iteration, dispatch, unreconciled, control (a pending `fn plan cancel`: `control-pending`), state (`run-not-building`), runtime (`runtime-not-permitted`) and run-deadline (`deadline`, against the run's own `deadline_at` minus 30 s) checks only when the import is planning-linked. Each dispatch attempt of a semantic task gets its own versioned turn key and its own 11-call bucket, at most 3 attempts per task. The attempt ordinal is the graph executor's retry index, passed as `nodeAttemptOrdinal` through WR's additive edit to `workflow-graph-executor.ts` (verify-v2 item 18). The first approved linked reservation moves the run `awaiting_execution_authority → building`. Direct `fn prd` is byte-identical. Evidence: `provider-attempt.ts:1419-1479`, `workflow-graph-executor.ts:145-154, 524-546, 2140-2227`, `executor.ts:9742, 10136-10142`, challenges 5 and 18.
- **D16 Build transfer.** `maxRequests = min(implementation_allocation, 10000)`. `maxDurationMs = min(run.deadline_at − boundsComputedAt − 30 s, 86,400,000)`, that is, clamped to the run's remaining time (verify-v2 item 49). `maxConcurrency = 1`. The bounds and every clamp are computed once, stored in `admission_facts`, and must equal `bundle.bounds`. The campaign clock starts at import, after `boundsComputedAt`, so BF's linked run-deadline check (D15) covers the gap. Evidence: `import-admission.ts:88-102`, conflicts 0.7 and 0.8, challenge 21.
- **D17 Import identity.** The key is `${runId}:r${revision}`. The intent (artifact plus anchor CAS) commits in one transaction before the importer runs. Recovery uses `inspectCccPrdImport`/`reconcileCccPrdImport`. Evidence: `importer.ts:1528-1533, 69-93`, ADR B Q2, critic 7.
- **D18 Shared import preflight.** Extracted from `prd.ts` into engine `ccc-prd/product-import-preflight.ts`. The CLI and the bridge share it. Authorship is derived from envelopes and never from fixture labels. Evidence: `prd.ts:1718-1830, 1960-2245, 3949`, `authoring.ts:1276-1307`, critic 6.
- **D19 Deterministic G4.** G4 runs graph admission, custody provenance, coverage, source fidelity, importer shape rules, the schedule simulation and the proof-command policy before any review is reserved. Every proof runs `task verify:<name>` through the baseline `Taskfile.yml`, and its verifier closure lies in the VP verifier bundle committed at B1, disjoint from every model write root (verify-v2 item 41). Evidence: `compiler.ts:1042-1380, 1917-1946`, `semantic-proof-custody.ts:29, 211-229, 266-292, 1266-1330`, ADR B Q3, PRD:202, challenge 29.
- **D20 Spec mode and the Build baseline.** Verifier preparation runs in a disposable clone. A reproducible baseline B1 (fixed author, committer and dates) is built on B0 and its commit id is predicted in `spec_ready`. In Build, VP's baseline step publishes a `build_transition` artifact naming the prediction **before** any git write, recreates B1 in the target with scrubbed-env plumbing, requires the commit id to equal the prediction, creates `refs/heads/fusion/r2c-<24hex>-r<NNN>-baseline` only if absent, and checks that branch out. The target's `main` stays at B0. Every step is idempotent on restart. Evidence: ADR B Q4 (`CccPlanningSpecReadyV1.verifierBaseline.predictedCommitOid`), `prd.ts:1673-1694, 2110-2115`, challenge 3.
- **D21 Strict N.** Planning `N = 14 + L + [L > 0]`. Preflight calls are not nodes (0.10). `N_impl = T`. `N_rev = T + 1 + P`. Repair chunks are not in admission N; each chunk must pass the fit rule against the remaining allocation before it is claimed. Evidence: ADR D Q4, critic 13, PRD §6:184, challenge 9.
- **D22 Store-level guards.** Core `moveTask`, `pauseTask`, `updateTask` (including the atomic path `updateTaskAtomic → updateTaskUnlocked` and `updateTaskColumns`), archive and delete refuse custody changes on planning tasks. A **separate guard-only predicate** `isCccCustodyGuardedTask` is used only at guard sites; `isCccCampaignTask` and its executor, graph-executor, branch and runtime callers are byte-unchanged. Triage excludes planning tasks, the dashboard guard fails closed, and `self-healing.ts` is not edited. Evidence: `task-mutation-ops.ts:545-552`, `task-update.ts:27`, `async-persistence.ts:464`, `branch-and-pr-entities.ts:861`, `ccc-campaign-routing.ts:18`, `archive-lifecycle.ts:190, 390`, ADR A Q4, critic 1, challenges 11 and 24.
  - **D22 note (E5-G1).** The PostgreSQL delete and archive backends refuse inside the task lock, so `deleteTask`, `deleteTaskIf` and direct callers are covered, and both snapshot write primitives refuse a change to `paused`, `userPaused`, `column`, `lineageId` or `deletedAt` on a marked task that has an anchor row, using the row they already read, so ordinary tasks pay no extra query. Accepted design: a planning task stays held while its marker is set, even after its run is terminal, and no card releases it yet; triage excludes any `ccc-plan:` lineage; the dashboard guard checks the marker only and passes a request through when the task is not found, and a lookup failure returns 500 with `CCC_TASK_CUSTODY_LOOKUP_FAILED`. A later card that must change a held task's custody columns does so through a dedicated custody op, not through the store writers.
- **D23 Live-authority receipt.** `ccc-planning.live-authority-receipt.v1` is consumed once at G0 into anchor columns. The `--confirm-authority` digest is typed by Ryan; no script or agent ever supplies it. This is **procedural, not enforced**: any local process can compute the digest, and the milestone claim says so (D52). Evidence: ADR D Q3, challenge 27.
- **D24 Pre-qualification.** The qualification port returns null until I6. G0 admits only `owned_disposable` targets named by a receipt. Evidence: PRD §7:213-215, critic 11.
- **D25 Proof runner.** A new closed-mapping, zero-skip runner (`test:ccc-planning`, `verify:ccc-planning-offline`) that owns PostgreSQL and scratch. Its aggregate verdict reuses `decideDarwinProofLaneOutcome`; only the closed-name and zero-skip checks are new. Evidence: ADR D Q1, critic 9, `ci-darwin-proof-lane.mjs:106`, challenge 25.
- **D26 Installed path.** Pack, install and record a digest receipt. Serve runs from the installed binary in a Pueue group with `env -i`, `PI_OFFLINE=1`, `--port 0`, `--host 127.0.0.1` and `--no-auto-register`, with the target as its working directory. Evidence: ADR D Q2, `serve.ts:246, 255-259, 401-406`, Pi `utils/tools-manager.js:12-17, 287-300`.
- **D27 Exact pins.** Three custom providers, one model each, with `modelSync: "disabled"`. The pin digest is checked at every session creation. Evidence: `serve.ts:1118`, `register-custom-provider-routes.ts:550-663`, ADR C 5.3 and 5.4.
- **D28 Research fetch.** The controller fetches over HTTPS under the fixed I2 source policy. Grants live on the anchor and citations are artifacts. Evidence: ADR C Q4, critic 14.
- **D29 Model quirks and preflight.** A degenerate-output guard runs in the Pi stream, built from existing M3 evidence (content empty, everything in reasoning). The tool-fidelity preflight is three controller-issued qualification lineages (0.10) that run first in stage `preflight`. In probe mode every probed tool (`ccc_probe_echo`, the writer's `edit`, the critic's `ccc_submit_verdict` and the researcher's `ccc_citation_read`) is wrapped to record its observation and abort the turn, so each probe is exactly one call and a lineage makes exactly 3 (verify-v2 item 39). No raw M3 probe is made outside a receipt-bound run: the first M3 tool call happens inside the I2 preflight. Evidence: ADR C Q5 and 5.2, memory "MiniMax M3 produces no commit", challenge 19.
- **D30 Coding repair NOT RUN in I2.** See conflict 0.19. Evidence: ADR A Q3.7.
- **D31 Review epochs.** `review_epochs` and `stagnant_epochs` are enforced by the anchor trigger. Evidence: PRD §5, critic 10.
- **D32 Control after import.** Before the import link, control is the anchor's `control_request`, applied by H1 at a safe point, and L1's control functions requeue or cancel the planning work item **in the same transaction** as the state change. After the link (`import_id` set), L1 refuses `requestCccPlanningControl` with `CCC_PLANNING_CONTROL_REQUIRES_CAMPAIGN_BRIDGE` and the CLI routes to CB (0.26). In states `importing` and `building`, pause and resume are refused with `CCC_PLANNING_COMMAND_NOT_SUPPORTED`, an I4 must-do. Before the link, in `importing`, cancel is accepted only before the intent is recorded. After the link, cancel is accepted from every linked state that has a `→ cancelling` pair in the section 2.2 function: `importing`, `awaiting_execution_authority`, `building`, `paused`, `awaiting_budget`, `blocked_prerequisite`, `blocked_provider`, `budget_exhausted`, `unknown_effect`, `verification_failed` and `accepted`. It sets the anchor's `control_request = 'cancel'`, which at once stops new review spend (trigger) and new linked writer reservations (BF), and the run's current state is the transition source. In `building` the in-lease cancel carries it out (0.26). `delivering` has no such pair and is refused with `CCC_PLANNING_STATE_TRANSITION_REFUSED`; the terminal states keep `CCC_PLANNING_RUN_ENDED` and `CCC_PLANNING_RUN_TERMINAL` (E2-3, E3-1, E4-13). Evidence: `ccc-campaign-operator-control.ts:25, 171-243, 411`, `async-workflow-workitems.ts:300-385`, `workflow-work-processor.ts:107-135, 196-214`, `task-move-disposer.ts:17-22`, challenge 6, verify-v2 item 36.
  - **D32 note (E5-L1 items 5 and 12).** While `control_request` is set, L1's `transitionCccPlanningRunState` refuses `CCC_PLANNING_CONTROL_PENDING` for every transition except one to `cancelling` or `cancelled`, or to `paused` when the pending request is a pause (E7-L item 2). The check is a compare-and-set predicate on the UPDATE, not a read followed by a check, so a pause that commits between a caller's read and its transition still blocks it. `requestCccPlanningControl` never reports a `deferred-leased` outcome.
  - **D32 note (E7-L items 1, 2 and 10; E7-0).** The predicate is `control_request IS NULL OR to IN ('cancelling', 'cancelled') OR (to = 'paused' AND control_request = 'pause')`, and the re-read fallback classifies the same way (`CONTROL_PENDING` otherwise), so a move to `paused` never erases a pending cancel. A pause at `admitted` refuses `CCC_PLANNING_STATE_TRANSITION_REFUSED` ("admitted has no -> paused transition") before any write; a cancel at `admitted` stays direct. The `deferred-leased` literal also leaves K1's `CccPlanningRunStatusV1.lastControl.outcome`, through E7-0's one-line grant to L1 (section 2.10).
- **D33 Terminal states are final.** `cancelled`, `delivered` and `failed` refuse every update at the database. Evidence: section 2.2 trigger.
- **D34 Barrels.** Barrels and shared registries are parent-owned: `packages/core/src/index.ts`, `packages/core/src/index.gate.ts` (it mirrors the core barrel's `export * from "./ccc-planning/index.js"` since INT-2a, E5), `packages/core/src/ccc-planning/index.ts` (new at INT-1, E2-80), `packages/core/src/postgres/schema/index.ts`, `packages/engine/src/index.ts`, `packages/engine/src/ccc-prd/index.ts`, `packages/engine/src/ccc-planning/stages/index.ts`, `packages/core/src/ccc-campaign/index.ts`, and the CLI mock list behind `scripts/check-mock-completeness.mjs`. Engine imports core only via `@fusion/core`. Engine typecheck runs after `pnpm --filter @fusion/core build`.
- **D35 `fn plan` usage handling.** `bin.ts` routes `plan` before the bin-level `--project` parse, so `plan.ts` owns exit 2 and the JSON usage errors. Evidence: `bin.ts:576-605, 715, 883`, critic 8 (C11).
- **D36 Live-execution release.** Selected by the receipt's `permittedProtectedActions[].release`. I2 uses `controller_within_receipt` (leader ruling; not a question for Ryan). Any envelope mismatch falls back to `awaiting_execution_authority`. A crash at any of its separate transactions replays to exactly one approval and one release artifact. Evidence: ADR D Q3, challenge 33.
- **D37 Sealed read roots.** Each planning session sees a `git archive` snapshot named by `readSnapshot` plus its own packet directory: `admitted-base` for planning roles, `candidate` (commit and tree, tree verified) for G7 and G8. Designer B never receives designer A's work. Evidence: ADR C Q1.6, ADR B "Sealing", challenge 4.
- **D38 CI evidence.** Darwin proof is local (M5 Max). Dispatching `full-suite.yml` on the branch is consult-gated. macOS CI evidence is NOT RUN in I2. The PostgreSQL-free, macOS-free planning suites run in the Linux Gate job (D51). Evidence: ADR D Q1, `full-suite.yml:18, 555`, `pr-checks.yml:154-304`.
- **D39 Audit events.** Reuse `recordRunAuditEventWithinTransaction`, extended with an optional deterministic `eventId`, inserted with `ON CONFLICT DO NOTHING`, re-read and compared, throwing the existing `RunAuditEventCollisionError` on a difference. The planning comparison omits `timestamp`, because the existing `runAuditComparable` includes it and a replay happens at a later clock. Evidence: `data-layer.ts:201-232, 355-433, 594-606`, critic 14, challenge 25.
- **D40 Watchdogs and estimates.** Watchdogs apply **per model-session attempt**, never per stage: 30 min for a planning or review session attempt, 60 min for a writer attempt, 20 min for a heavy check. The review/repair loop has no stage watchdog; it is bounded by the counters and the run deadline. Fit estimates: 10 min per planning or review session (and per preflight lineage), 60 min per writer, 20 min per heavy check. Evidence: PRD §6:178, challenge 28.
- **D41 Stagnation outcome.** Two consecutive non-improving review epochs end the run `failed` with `CCC_PLANNING_REVIEW_STAGNATED`. Evidence: PRD §5.
- **D42 Pin check before the fan-out.** A free, read-only `/v1/models` catalog check against loopback OmniRoute runs before I1 W1 (card PRE). Evidence: critic 15.
- **D43 Campaign outcome mapping.** For planning-linked imports only, BF maps the campaign's work-item transitions into the run record **in the same transaction** through a hook after the update in `transitionWorkflowWorkItem`, which passes the row before the update (`before`, already in scope there as `existing`; verify-v2 item 40) and the updated row, plus a reconcile on status read and engine start for any other writer. The hook never throws and never poisons the campaign transaction: its body runs inside a SAVEPOINT (nested Drizzle transaction), and an error or an unmappable pair leaves the anchor unchanged and writes a `ccc-planning:campaign-unmapped` audit event. Mapping table in section 2.11. Evidence: `async-workflow-workitems.ts:300-385`, `workflow-workitems-ops-2.ts:243-262` (non-terminal), `importer.ts:2256` (import activation, not an outcome), challenge 5.
  - **D43 note (E7-0).** BF's mapping rows go through L1's functions, never through direct SQL on the anchor. Rows that end in `cancelled` call L1's `completeCccPlanningCancellationWithin(tx, input)` (E7-L item 9) inside the campaign transaction's savepoint, so there is still one path to `cancelled` (D45). BF's success row (`building → accepted`) while a cancel is pending is refused `CCC_PLANNING_CONTROL_PENDING` by L1, and BF maps it to `cancelling`.
  - **D43 note (E8-0, B-1).** The rows that do not end in `cancelled` need L1's state transition inside the campaign transaction too. L1z adds `transitionCccPlanningRunStateWithin(tx, i)` (E8-L item 1; section 2.11), and BF uses it for every D43 row that does not end in `cancelled`, and for the `→ cancelling` step before `completeCccPlanningCancellationWithin`, all inside the campaign transaction (the hook's savepoint, or the reservation transaction for the first-reservation row). A rollback leaves nothing. B-1 stays open until L1z is accepted, and BF (W6) depends on L1z.
- **D44 Running-runtime digest.** The engine that runs the work registers its own installed `dist` manifest digest at start (K1 registry, H1 computes). H1 at every stage start, RV before every review reservation, and BF on every linked reservation refuse unless it equals the run's stored `runtime_dist_manifest_sha256`; an unregistered digest also refuses. Outcome: `blocked_prerequisite` / `CCC_PLANNING_RUNTIME_NOT_PERMITTED`. Evidence: ADR D installed receipt (`distManifestSha256`), memory "Fusion rebuilds are inert until serve restarts", challenge 12.
- **D45 Cancellation completion.** `cancelling → cancelled` is completed by L1's `completeCccPlanningCancellation` when no live holder exists: called directly by the control function, by H1 after `settleCccPlanningRun`, and by H1 at engine start. After the link, BF's mapping completes it when the campaign item is cancelled, and CB completes it directly when the campaign item had already ended (verify-v2 item 44). Evidence: challenge 6.
  - **D45 note (E5-L1 items 7 and 8).** `completeCccPlanningCancellation` is the only path to `cancelled`: the generic `transitionCccPlanningRunState` refuses `→ cancelled` with `CCC_PLANNING_STATE_TRANSITION_REFUSED`. It judges lease liveness with the database clock (`clock_timestamp()`), never with a caller-supplied `now`, and it does not complete (`{completed: false}`, with the reason recorded, and `CCC_PLANNING_DESCENDANTS_UNSETTLED` wherever a code is surfaced) while any call of the run is `reserved` or `dispatched_unknown`.
  - **D45 note (E7-L items 4 and 9).** A completion that defers writes one deterministic, idempotent audit row: event type `ccc-planning:control`, subject `cancel-deferred:<reason>` with reason `live-lease` or `descendants-unsettled`, and an event id derived from (run id, current `control_seq`, deferral ordinal), written only when the latest deferral row for that `control_seq` has another reason or none exists (E8-L item 3, replacing E7's (run id, `control_seq`, reason) derivation, which could not record a reason that flips back), so repeating the same deferral writes nothing new and a changed reason, a flip back included, writes one new row. Its metadata carries the reason and, for descendants, `CCC_PLANNING_DESCENDANTS_UNSETTLED`. `lastControl` still reports the cancel as pending. The within-transaction form `completeCccPlanningCancellationWithin(tx, input)` is the same path: the direct function is a wrapper that opens the transaction and calls it, and BF's mapping calls the within form (D43 note).
  - **D45 note (E8-L items 1 and 3).** L1z's `transitionCccPlanningRunStateWithin` refuses `→ cancelled` like the direct form, so the within-transaction pair still leaves one path to `cancelled`. RED for the deferral rows: under one `control_seq`, live-lease, then descendants-unsettled, then live-lease again writes three rows, and the latest says `live-lease` (ADV2-A).
- **D46 G5 verifier gate.** VP refuses (a) a setup failure (zero tests run, a load or syntax error, a missing file) with `CCC_PLANNING_ORACLE_SETUP_FAILURE`, (b) a defective control that fails without a requirement-tagged (`[REQ-x]`) assertion with `CCC_PLANNING_ORACLE_CONTROL_UNTAGGED`, (c) a verifier that passes any defective control with `CCC_PLANNING_ORACLE_CONTROL_FAILED`, and (d) runs verifiers only through `runCccSemanticProofSandboxedProcess`; sandbox not ready is `blocked_prerequisite` / `CCC_PLANNING_SANDBOX_UNAVAILABLE`, never a raw host run. Verifiers import the implementation dynamically inside each test body so B0 fails per test, not at load. Evidence: PRD:90, :203, :237, :247, :420-422, ADR B:954, `ccc-campaign-proof-sandbox.ts:87, 547`, challenge 7.
- **D47 Objections and decision records.** The controller converts every reviewer finding into an `objection` artifact in the reviewer's stage. The spec author writes one `decision_record` per objection (proposal, evidence, objection, discriminating observation, disposition, remaining uncertainty) in stage `spec` (and `repair`). Findings cite a requirement id, a source, an artifact or a counterexample (`CccReviewFindingRef`, defined in core by K1 so that core schemas and the engine share one type; verify-v2 item 34). G3 refuses spec-ready while any blocking objection lacks a resolving disposition (`CCC_PLANNING_OBJECTION_UNRESOLVED`). Evidence: PRD:86, :138, :201, challenge 14.
- **D48 Bound routes always use the Fusion receipt adapter.** For `scopeKind` `"planning"` or `"planning-linked-writer"`, P1 refuses session creation unless the binding's provider is the session's `defaultProvider` among the registered custom providers, because `pi.ts:3649-3651` selects the adapter only for the default provider and any other provider silently streams through unpatched pi-ai `openai-completions`. Evidence: `pi.ts:3536-3545, 3645-3673`, `ccc-route-receipt-adapter.ts:106, 394-413`, `tsup.config.ts:398-412`, `packages/cli/package.json`, root `package.json` `patchedDependencies`, challenge 15.
  - **D48 note (E5-P1 item 3).** The rule fails closed for linked writers too: a `"planning"` or `"planning-linked-writer"` binding without the bound-route marker `CCC_PROVIDER_ATTEMPT_ROUTE_MARKER` is refused at session creation, and so is a bound provider that is not `options.defaultProvider`. The marker is engine-side (E7-0, settling the v3.3 open item): a frozen object with exactly five keys (`providerId`, `modelId`, `transport`, `roleClass`, `toolsetDigest`) under `Symbol.for("ccc-fusion.provider-attempt-route.v1")` on the binding's controller. P1 exports its type `CccProviderAttemptBoundRoute` and the helper `attachCccProviderAttemptBoundRoute(controller, route)` from `pi.ts` (engine barrel since INT-2d). The helper returns a new frozen controller that forwards `preDispatch` and `reconcile` and carries the marker; it refuses a controller whose own keys are not exactly `preDispatch` and `reconcile`, a controller that already carries a marker, and an empty route value (E8-0, N-1). WR (engine) builds the linked-writer binding around the returned controller where it creates the session; a binding built on the original controller has no marker and is refused at session creation. BF (core) supplies the five values as the `route` field of `openCccPlanningLinkedWriterAttempt`'s result, a structural core copy of the marker type, and never imports engine (E8-0, N-5). For a linked-writer binding, P1 also compares the marker's `modelId`, as well as its `providerId`, with `options.defaultModelId` and the default provider at session creation, and refuses before any provider call (E7-P item 5).
- **D49 CLI grammar.** `fn plan` takes a positional `RUN_ID` and an optional `--project`, resolved from the run row (PRD:287-289). CL1 owns the `@runfusion/fusion` changeset. Evidence: PRD:280-291, :407, `bin.ts:585-605`, `.changeset/` format checked by `scripts/check-changeset-format.mjs`, challenge 16.
- **D50 Offline network denial.** P0 runs every planning suite with `PI_OFFLINE=1` and a `NODE_OPTIONS=--import` network guard that refuses and reports any non-loopback connect as `CCC_PLANNING_OFFLINE_NETWORK_ATTEMPT`. The guard is an in-process tripwire, not a sandbox: an outer `sandbox-exec` is not used because nested sandboxes fail and the writer shells already run inside one. Evidence: PRD:456, Pi `utils/tools-manager.js:12-17, 287-300`, challenge 30.
- **D51 Linux CI lane.** P0 adds runner mode `--mode ci-linux` (PostgreSQL-free, macOS-free inventory entries only) and one step in the `pr-checks.yml` Gate job; `ci-workflow.test.ts` pins it. No fifth package key. Evidence: `pr-checks.yml:154-304`, `packages/cli/src/__tests__/ci-workflow.test.ts:134, 149`, challenge 31.
- **D52 Procedural controls are labelled and attributed.** Three controls are not enforced by code: the operator typing the receipt digest, `fn plan answer`, and `fn plan pause|cancel|resume`. Each records its actor (OS user plus optional `--actor`) in the audit event and artifact producer, and the live proof report lists them under `notEnforced`. Evidence: challenge 27.
- **D53 Resting states depend on the mode.** `cccPlanningRestingStates("spec") = ["spec_ready"]`; `cccPlanningRestingStates("build") = ["accepted", "verification_failed"]`. In Build, `spec_ready` moves on to `importing` automatically. Evidence: challenge 32.

### Critic coverage

| Critic point | Closed by |
|---|---|
| 1 Held task outside guards | D22, card G1 (I1 W2) |
| 2 Mutable ledger | D4 |
| 3 Second scheduler | D1, D2, D3, card H1 |
| 4 #103 merge | Card R0p, DONE (section 3.1 W0) |
| 5 Baseline pins | D7, card S0 |
| 6 Preflight skipped, false authorship | D18, cards B3, IB1, IB2 |
| 7 Link after commit | D17, cards IM1, IB2 |
| 8 Vacuous REDs | Every card in section 3 carries a non-vacuity reason and a positive control; cards X1, AD1, C2, CL1 |
| 9 CI never runs it | D25, D38, D51, card P0 |
| 10 Build counters | D13, D15, D16, D31, D43, cards BF, RV |
| 11 G0 incomplete, no target restriction | D23, D24, conflict 0.21, cards K2, CL2 |
| 12 Fake-model Spec claim | Section 4: live Spec mode is NOT RUN |
| 13 Budget refuses | D21, section 4.6 arithmetic |
| 14 Unowned requirements | D5, D28, D39, D40, cards L1, CL1, AD1, P0, LV, A1 |
| 15 Late pins | D42, card PRE |

### Challenge-v1 coverage

| Finding | Closed by |
|---|---|
| 1 Anchor FK | D7, section 2.2, cards S0, AD1 |
| 2 D10 scope | 0.22, D10, section 2.12, card P1 |
| 3 Build baseline B1 | 0.27, D20, section 2.17, cards VP, IB2 |
| 4 Reviewer snapshot | D14, D37, section 2.16, cards SF, RV |
| 5 Campaign outcomes | D15, D43, section 2.11, card BF |
| 6 Answer, resume, cancel, Build control | 0.26, D32, D45, cards L1, H1, CB, CL1, CL2 |
| 7 G5 | D46, card VP |
| 8 Confined grep | D11, section 2.13, card C2 |
| 9 Preflight | 0.10, D21, D29, sections 2.7-2.9, cards K1, L1, C6, CL2 |
| 10 IR builder | 0.23, card K1, AD1, H1 |
| 11 Atomic update path | D22, card G1 |
| 12 Runtime digest | D44, cards K1, H1, RV, BF |
| 13 L1 and P1 types | 0.24, card K1 |
| 14 Decision records and objections | D47, section 2.4, cards GG, C2, ST1, ST2 |
| 15 pi-ai patch | 0.25, D48, cards P1, IP, LV |
| 16 CLI grammar and changeset | D49, section 2.19, cards CL1, CL2 |
| 17-33 | D13 (17), D15 (18), D29 (19), section 4.6 and K1 (20), D16 (21), IB2 (22), R0p/GG/ST1/ST2/X1 (23), D22 (24), D3/D12/D25/D39 (25), section 2.1 (26), D23/D52/LV (27), D40 (28), GG (29), D50 (30), D51 (31), D53 (32), AU2 (33) |

### Verify-v2 coverage (new in v3)

| Item | Closed by |
|---|---|
| 34 Review types in core (closes 14) | D47, sections 2.10 and 2.13, cards K1, C2, H1 |
| 35 Call to a later-wave function | Section 2.11 (`reconcileLinkedOutcome` port), section 2.16, cards L1, H1, WR, CL2 |
| 36 Build control (closes 6) | 0.26, D32, sections 2.11 and 2.19, cards L1, BF, CB, WR; risk 25 |
| 37 Writer toolset | D11, sections 2.7, 2.12 and 2.13, cards K1, P1, C2, WR |
| 38 `importing → budget_exhausted` | 0.16, sections 2.2 and 2.3, cards K1, S0, L1 |
| 39 Preflight call cap (closes 9) | D29, sections 2.7, 2.13 and 2.15, cards C2, C6 |
| 40 Hook lacks the previous row | D43, section 2.11, card BF |
| 41 Proof commands (closes 29) | D19, section 2.17, section 4.1, cards GG, VP |
| 42 Re-dispatch after a refusal | D10, section 2.12, cards P1, L1 |
| 43 Cancel reason | Section 2.19, card CB |
| 44 Stop on a finished item | D45, section 2.19, card CB |
| 45 P1 test rationale | Card P1 |
| 46 Proof results source | Section 2.17, card RV |
| 47 Vacuous C2 test | Card C2 |
| 48 Writer-refused transaction | Section 2.11, card BF |
| 49 Run deadline | D15, D16, section 2.17 step 5, cards IB2, BF |
| 50 L1 review_proof case | Card L1 |
| 51 K1 type test | Cards K1, P1 |
| 52 LV crypto spy | Card LV |
| 18 Retry ordinal (PARTIAL) | D15, section 2.11, card WR (additive edit to `workflow-graph-executor.ts`) |
| Repair counts (leader ruling) | D13, sections 2.1, 2.8, 2.9 and 2.11, section 4.6, cards L1, ST2; risk 24 |
| Questions for Ryan (leader rulings) | D36, sections 3.3, 4.2, 4.5 and 5 |

## 2. Frozen contracts

### 2.1 Conventions and the digest rule

- **Digest.** Every digest is lowercase hex SHA-256. For a JSON value it is computed over the UTF-8 bytes of `canonicalCccPrdJson(value)` (`packages/core/src/ccc-prd/contract.ts:100`). There are two exceptions: an artifact's `outputDigest` hashes the stored content text's UTF-8 bytes, and packet sources hash raw file bytes (`custody.ts:228-262`). A text artifact that becomes a packet source therefore has `outputDigest` equal to its manifest `sha256`.
- **Derived identifiers.** Each is a prefix plus SHA-256 hex over a domain tag, a NUL byte and canonical JSON:

```ts
// packages/core/src/ccc-planning/policy.ts (K1)
export function cccPlanningRunId(i: { projectId: string; requestDigest: string; receiptSha256: string }): string;
  // "ccc-plan:" + sha256("ccc-plan-run/v1\0" + canonical(i)).slice(0, 24)
export function cccPlanningTurnKey(i: { projectId: string; runId: string; revision: number; stageId: CccPlanningStageId;
  roleId: CccPlanningRoleId; lineageId: string; nodeAttemptOrdinal: 1 | 2 | 3 }): string;
  // "ccc-plan-turn-" + sha256("ccc-plan-turn/v1\0" + canonical(i)); refuses at runtime any nodeAttemptOrdinal outside
  // the typed range 1..3 (E2-47)
export function cccPlanningAttemptKey(i: { projectId: string; runId: string; turnKey: string; dispatchKey: string }): string;
  // "ccc-plan-attempt-" + sha256("ccc-plan-attempt/v1\0" + canonical(i)); the fence is metadata, not identity
export function cccPlanningLinkedWriterTurnKey(i: { baseTurnKey: string; dispatchAttemptOrdinal: 1 | 2 | 3 }): string;
  // "ccc-plan-writer-" + sha256("ccc-plan-writer-turn/v1\0" + canonical(i)); baseTurnKey is the campaign key from
  // createProviderAttemptTurnKey (workflow-graph-executor.ts:524-546), which has no retry index (challenge 18); BF derives
  // dispatchAttemptOrdinal from nodeAttemptOrdinal, which WR's additive graph-executor edit supplies (verify-v2 item 18)
export function cccPlanningEventId(i: { projectId: string; runId: string; mutationType: CccPlanningAuditMutationType; subject: string }): string;
  // "ccc-plan-event-" + sha256("ccc-plan-event/v1\0" + canonical(i))
export function cccPlanningDecisionId(i: { revision: number; questionDigest: string }): string;
  // `ccc-plan-decision-r${pad3(revision)}-${questionDigest.slice(0, 16)}`
export function cccPlanningImportKey(runId: string, revision: number): string;   // `${runId}:r${revision}`
export function cccPlanningGrantDigest(g: CccPlanningGrantV1): string;          // sha256(canonical(g))
export function cccPlanningBindingHash(b: Omit<CccPlanningRouteBinding, "bindingHash">): string;
export function cccPlanningBaselineBranchRef(runId: string, revision: number): string;
  // `refs/heads/fusion/r2c-${runId.slice("ccc-plan:".length)}-r${pad3(revision)}-baseline`
```

- **Exact key fields (E1-11).** The turn key, attempt key, linked-writer turn key, event id and run id each hash exactly their contract-named fields above. A caller passing extra fields gets the same key.
- **Node lineage ids** (not the task marker):
  - fixed nodes: `${stageId}:${roleId}`, for example `design:designer-b`;
  - leaves: `research:leaf-${n}`;
  - leaf review: `research:leaf-reviewer`;
  - preflight qualification lineages (not nodes, 0.10): `preflight:writer`, `preflight:critic`, `preflight:researcher`;
  - planning repair of an author's candidate: `repair:${chunkOrdinal}:${roleId}`, recorded with a `lineage:created` event `{kind: "author-repair", parentLineageId, inheritedDispatchAttempts}` whose `inheritedDispatchAttempts` equals the dispatch-attempt count of the author's latest lineage (its original lineage or the previous repair lineage), so a rename never resets the counter (D13);
  - review of a new candidate version: `${stageId}:${roleId}:rv${chunkOrdinal}`, for example `review:product-adversary:rv1`, recorded with a `lineage:created` event `{kind: "review-node", parentLineageId: "${stageId}:${roleId}", candidateDigest, inheritedDispatchAttempts: 0}`; each review node has its own 3 attempts (D13, leader ruling);
  - G7: `review:${semanticTaskId}`;
  - G8: `judge:final`;
  - linked writers keep the campaign's semantic task id; their attempt identity is the derived `cccPlanningLinkedWriterTurnKey`.
  - Admission (E5-L1 item 3, ADV-1): inside its locked transaction, `admitCccPlanningDispatch` refuses, with a typed limit or route refusal, any `lineageId` that is neither the fixed lineage for its stage and role (`${stageId}:${roleId}`, `research:leaf-${n}` up to the leaf cap, `research:leaf-reviewer`, the preflight ids, `review:${semanticTaskId}`, `judge:final`) nor a lineage recorded by a `ccc-planning:lineage:created` event for this run with the same role. `repair:${k}:*` and `*:rv${k}` lineages always need that event, and the lineage must match the stage; an ordinal above `CCC_PLANNING_MAX_REPAIR_CHUNKS` is refused.
  - Superseded lineages and split children (E7-L items 7 and 8). Once a repair chunk supersedes a lineage, every new call reservation on it is refused `ROUTE_NOT_ADMITTED` with detail `lineage-superseded`, the next call of a continuing turn included; a call already dispatched settles normally. `recordCccPlanningLineageSplit` refuses a child id that has any fixed lineage owner (for example child `review:technical-critic` of parent `review:product-adversary`) with `CCC_PLANNING_ROUTE_NOT_ADMITTED`, detail `lineage-not-admitted` (E8-0, N-6). L1's repair 2 found that dispatch counters are keyed by lineage id alone, so a campaign-fence lineage whose id equals a planning fixed lineage id is refused (E7-L item 8(b), accepted in E8). A PRD semantic task id whose G7 lineage id `review:<id>` equals a planning fixed lineage id is refused by GG's G4 graph gate, before import (E8-0, N-3; section 2.17); AD1 never sees semantic task ids.
- **Event subjects.** The subject for each event type:
  - call events: `attemptKey`;
  - `lineage:created`: the child lineage id;
  - control: `control:${controlSeq}`; a deferred cancellation completion: `cancel-deferred:${reason}`, reason `live-lease` or `descendants-unsettled`, event id derived from (run id, current `control_seq`, deferral ordinal), written only when the latest deferral row for that `control_seq` has another reason (E7-L item 4; derivation amended by E8-L item 3, card L1z);
  - repair: `repair:${ordinal}`;
  - review epochs: `epoch:${n}`;
  - fetches: `${grantKey}`;
  - artifacts: the artifact key;
  - import: the import key;
  - release: the authorization id;
  - state: `${from}->${to}@${OLD.updated_at}`;
  - writer refusals: `${turnKey}:${dispatchKey}:${reason}`;
  - unmapped campaign transitions: `${workItemId}:${fromState}->${toState}@${workItemUpdatedAt}`;
  - build baseline: `baseline:r${revision}`.
- **Audit content.** Strings are at most 256 characters (`CCC_PLANNING_AUDIT_STRING_MAX = 256`). Prompts, outputs and answers live only in artifacts.
  - L1's bounds (E5-L1 item 10): `binding.lineageId`, `providerId` and the other id strings are at most 256 characters; `evidenceDigest`, `toolsetDigest` and `promptDigest` are 64 lowercase hex; `refusalReason` is in its four-member union. A violation refuses before any write: `CCC_PLANNING_INTERNAL_ERROR` for an internal caller, and the existing actor rule (section 2.11 header) for actors.
  - Settlement strings (E7-L items 5 and 6): before the settlement transaction, L1 bounds every string of the committed `effectiveRoute` and cost: the id-like fields (`effectiveProvider`, `effectiveModel`, `effectiveReasoningEffort`, `effectiveServiceTier`, `cost.source` and the `omniRoute` id strings) at `CCC_PLANNING_AUDIT_STRING_MAX` (256), and `cost.reason` and any other free-text observation string at 1,024 characters. A violation refuses `CCC_PLANNING_INTERNAL_ERROR` and writes nothing. L1 uses K1's `CCC_PLANNING_AUDIT_STRING_MAX` and keeps no local `AUDIT_ID_MAX`.
- **Audit envelope.** Audit `runId` is the planning run id. Audit `domain` is `"database"`. Audit `agentId` is `ccc-planning-controller` for controller writes and `operator:<actor>` for answers and controls (D52).

```ts
export const CCC_PLANNING_AUDIT_MUTATION_TYPES = [
  "ccc-planning:call:reserved", "ccc-planning:call:dispatched", "ccc-planning:call:terminal",
  "ccc-planning:lineage:created", "ccc-planning:control", "ccc-planning:decision:answered",
  "ccc-planning:repair-chunk", "ccc-planning:repair-epoch-closed", "ccc-planning:review-epoch",
  "ccc-planning:fetch:reserved", "ccc-planning:fetch:settled", "ccc-planning:artifact-published",
  "ccc-planning:import-intent", "ccc-planning:import-linked", "ccc-planning:live-execution-released",
  "ccc-planning:state", "ccc-planning:writer-refused", "ccc-planning:campaign-unmapped",
  "ccc-planning:build-baseline",
] as const;   // S0 adds exactly these 19 literals to RunAuditMutationType (packages/core/src/types/run-audit.ts:17)
export type CccPlanningAuditMutationType = (typeof CCC_PLANNING_AUDIT_MUTATION_TYPES)[number];

// packages/core/src/postgres/data-layer.ts (S0): RunAuditEventInput (data-layer.ts:201-211) gains
//   readonly eventId?: string;  // must match /^ccc-plan-event-[0-9a-f]{64}$/; never combined with `campaign`
// With eventId: INSERT ... ON CONFLICT DO NOTHING RETURNING (the existing pattern at data-layer.ts:397-433),
// then re-read by (project_id, id) and compare canonicalCccPrdJson of a planning comparable that is
// runAuditComparable (data-layer.ts:594-606) minus `timestamp`. Unequal -> throw the existing
// RunAuditEventCollisionError(eventId) (code "CCC_RUN_AUDIT_EVENT_COLLISION", data-layer.ts:232).
// Equal -> return the persisted event (its original timestamp). Without eventId: behaviour unchanged.
// Before the insert (E2-62), recordPlanningRunAuditEvent normalizes the metadata by recursively dropping object
// properties whose value is undefined, which matches how jsonb stores them, and then canonicalizes it before the INSERT,
// so any other non-JSON value (a Date, a BigInt) is refused on the first write with no row written. It uses the same
// refusal mechanism as the malformed-eventId check.
```

- **Call metadata.** Schema `ccc-planning-call/v1`, with exactly these keys:
  - `schema`, `runId`, `revision`, `stageId`, `roleId`;
  - `lineageId`, `nodeAttemptOrdinal`, `turnKey`, `dispatchKey`, `attemptKey`;
  - `phase`, `providerId`, `modelId`, `transport`, `preflight` (boolean, true only for the three qualification lineages);
  - `bindingHash`, `toolsetDigest`, `promptDigest`;
  - `fence` = `{kind, workItemId, runId, attempt}`;
  - `outcome` = `"reserved" | "dispatched" | "committed" | "refused_known_effect" | "failed_known_effect" | "proved_not_dispatched" | "dispatched_unknown"`;
  - optional `evidenceDigest`;
  - optional `effectiveRoute`, present only for `committed`, and exactly the persisted `CccProviderAttemptEffectiveRoute` shape (`ccc-campaign/types.ts:337-346`): `{effectiveProvider, effectiveModel, effectiveReasoningEffort?, effectiveServiceTier?, usage, cost, receiptSource, omniRoute?}`. Usage lives inside it; there is no separate `usage` key;
  - optional `refusal` = `{reason: "receipt-missing" | "receipt-mismatch" | "effective-route-drift" | "provider-error-event", requested: {provider, model}, observed: {provider, model} | null}`, present only for `refused_known_effect` and `failed_known_effect`.

### 2.2 SQL: `packages/core/src/postgres/migrations/0042_ccc_planning_runs.sql` (card S0)

```sql
-- FNXC:CccPlanningRuns 2026-10-14: pre-import anchor for one request-to-code run.
-- Not a ledger: per-call history stays append-only in project.run_audit_events.
CREATE TABLE IF NOT EXISTS project.ccc_planning_runs (
  project_id text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('fusion.project_id', true), ''), '__legacy_unscoped__'),
  run_id text NOT NULL,
  planning_task_id text NOT NULL,
  mode text NOT NULL,
  budget_profile text NOT NULL,
  role_profile text NOT NULL,
  policy_version text NOT NULL,
  policy_digest text NOT NULL,
  request_digest text NOT NULL,
  request_bytes integer NOT NULL,
  target_repository text NOT NULL,
  admitted_base text NOT NULL,
  grant_digest text NOT NULL,
  authority_receipt_sha256 text NOT NULL,
  authority_receipt_json text NOT NULL,
  runtime_dist_manifest_sha256 text NOT NULL,
  amendment_seq integer NOT NULL DEFAULT 0,
  revision integer NOT NULL DEFAULT 1,
  state text NOT NULL,
  state_code text,
  deadline_at text NOT NULL,
  planning_allocation integer NOT NULL,
  implementation_allocation integer NOT NULL,
  review_proof_allocation integer NOT NULL,
  planning_spent integer NOT NULL DEFAULT 0,
  review_proof_spent integer NOT NULL DEFAULT 0,
  research_fetch_allocation integer NOT NULL,
  research_fetch_spent integer NOT NULL DEFAULT 0,
  research_bytes_allocation bigint NOT NULL,
  research_bytes_spent bigint NOT NULL DEFAULT 0,
  repair_epoch_state text NOT NULL DEFAULT 'unopened',
  repair_chunks_used integer NOT NULL DEFAULT 0,
  review_epochs integer NOT NULL DEFAULT 0,
  stagnant_epochs integer NOT NULL DEFAULT 0,
  control_seq integer NOT NULL DEFAULT 0,
  control_request text,
  control_revision integer,
  control_requested_at text,
  awaiting_decision_id text,
  import_intent_digest text,
  import_idempotency_key text,
  import_id text,
  implementation_transferred integer,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  PRIMARY KEY (project_id, run_id),
  CONSTRAINT ccc_planning_runs_task_unique UNIQUE (project_id, planning_task_id),
  CONSTRAINT ccc_planning_runs_import_unique UNIQUE (project_id, import_id),
  CONSTRAINT ccc_planning_runs_import_key_unique UNIQUE (project_id, import_idempotency_key),
  CONSTRAINT ccc_planning_runs_authority_receipt_unique UNIQUE (project_id, authority_receipt_sha256),
  -- 0006 rebuilt tasks' key as (project_id, id) (0006_project_ownership.sql:329-356); a single-column FK cannot be
  -- created and the boot ownership audit (schema-applier.ts:640-706) refuses any key without project_id.
  -- Precedent for the deferrable composite form: 0037_ccc_campaign_governance.sql:103.
  CONSTRAINT ccc_planning_runs_task_fkey FOREIGN KEY (project_id, planning_task_id)
    REFERENCES project.tasks(project_id, id) DEFERRABLE INITIALLY IMMEDIATE,
  -- E2-60: deferrable like the task FK and the 0037 precedent, so partition promotion can move a ccc_prd_imports row.
  CONSTRAINT ccc_planning_runs_import_fkey FOREIGN KEY (project_id, import_id)
    REFERENCES project.ccc_prd_imports(project_id, import_id) DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT ccc_planning_runs_run_id_check CHECK (run_id ~ '^ccc-plan:[0-9a-f]{24}$'),
  CONSTRAINT ccc_planning_runs_mode_check CHECK (mode IN ('spec', 'build')),
  CONSTRAINT ccc_planning_runs_budget_profile_check CHECK (budget_profile IN ('standard', 'large')),
  CONSTRAINT ccc_planning_runs_role_profile_check CHECK (role_profile IN ('full-v2', 'adaptive-v2', 'lean-v2')),
  CONSTRAINT ccc_planning_runs_digest_check CHECK (
    policy_digest ~ '^[a-f0-9]{64}$' AND request_digest ~ '^[a-f0-9]{64}$'
    AND grant_digest ~ '^[a-f0-9]{64}$' AND authority_receipt_sha256 ~ '^[a-f0-9]{64}$'
    AND runtime_dist_manifest_sha256 ~ '^[a-f0-9]{64}$'
    AND (import_intent_digest IS NULL OR import_intent_digest ~ '^[a-f0-9]{64}$')),
  CONSTRAINT ccc_planning_runs_base_check CHECK (admitted_base ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
  CONSTRAINT ccc_planning_runs_request_bytes_check CHECK (request_bytes BETWEEN 1 AND 4194304),
  -- E2-64: the spend check casts deadline_at to timestamptz, so 'tomorrow' and 'infinity' must never be stored. Adjust to
  -- the column's real name and type, plus the same check for any other text timestamp that the spend check casts.
  CONSTRAINT ccc_planning_runs_deadline_check CHECK (
    deadline_at IS NULL OR deadline_at ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?Z$'),
  CONSTRAINT ccc_planning_runs_sequence_check CHECK (
    revision BETWEEN 1 AND 999 AND amendment_seq >= 0 AND control_seq >= 0),
  CONSTRAINT ccc_planning_runs_state_check CHECK (state IN (
    'admitted', 'running', 'awaiting_intent', 'awaiting_budget', 'awaiting_execution_authority',
    'blocked_prerequisite', 'blocked_provider', 'budget_exhausted', 'unknown_effect', 'paused',
    'cancelling', 'cancelled', 'spec_ready', 'importing', 'building', 'verification_failed',
    'accepted', 'delivering', 'delivered', 'failed')),
  CONSTRAINT ccc_planning_runs_state_code_check CHECK (
    (state_code IS NULL OR state_code ~ '^CCC_[A-Z0-9_]{1,120}$')
    AND (state NOT IN ('awaiting_budget', 'blocked_prerequisite', 'blocked_provider', 'budget_exhausted',
                       'unknown_effect', 'verification_failed', 'failed') OR state_code IS NOT NULL)),
  CONSTRAINT ccc_planning_runs_decision_check CHECK ((state = 'awaiting_intent') = (awaiting_decision_id IS NOT NULL)),
  CONSTRAINT ccc_planning_runs_planning_spend_check CHECK (planning_spent BETWEEN 0 AND planning_allocation),
  CONSTRAINT ccc_planning_runs_review_spend_check CHECK (review_proof_spent BETWEEN 0 AND review_proof_allocation),
  CONSTRAINT ccc_planning_runs_research_check CHECK (
    research_fetch_spent BETWEEN 0 AND research_fetch_allocation
    AND research_bytes_spent BETWEEN 0 AND research_bytes_allocation
    AND research_fetch_allocation >= 0 AND research_bytes_allocation >= 0),
  CONSTRAINT ccc_planning_runs_allocation_check CHECK (
    planning_allocation > 0 AND implementation_allocation >= 0 AND review_proof_allocation >= 0
    AND (mode = 'build' OR (implementation_allocation = 0 AND review_proof_allocation = 0))),
  CONSTRAINT ccc_planning_runs_repair_check CHECK (
    repair_epoch_state IN ('unopened', 'open', 'closed') AND repair_chunks_used BETWEEN 0 AND 4),
  CONSTRAINT ccc_planning_runs_review_epoch_check CHECK (review_epochs >= 0 AND stagnant_epochs BETWEEN 0 AND 2),
  CONSTRAINT ccc_planning_runs_control_check CHECK (
    (control_request IS NULL OR control_request IN ('pause', 'cancel', 'resume'))
    AND ((control_request IS NULL) = (control_revision IS NULL))
    AND ((control_request IS NULL) = (control_requested_at IS NULL))),
  CONSTRAINT ccc_planning_runs_import_link_check CHECK (
    ((import_idempotency_key IS NULL) = (import_intent_digest IS NULL))
    AND (import_idempotency_key IS NULL OR (
          mode = 'build'
          AND import_idempotency_key ~ '^ccc-plan:[0-9a-f]{24}:r[1-9][0-9]{0,2}$'
          AND starts_with(import_idempotency_key, run_id || ':r')))
    AND (import_id IS NULL OR import_idempotency_key IS NOT NULL)
    AND ((import_id IS NULL) = (implementation_transferred IS NULL))
    AND (implementation_transferred IS NULL
         OR implementation_transferred BETWEEN 1 AND LEAST(implementation_allocation, 10000)))
);

CREATE INDEX IF NOT EXISTS idx_ccc_planning_runs_project_state
  ON project.ccc_planning_runs (project_id, state);

CREATE OR REPLACE FUNCTION project.ccc_planning_run_transition_allowed(from_state text, to_state text)
RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  -- 65 pairs. v2 adds ('admitted','blocked_prerequisite') for CCC_PLANNING_RUNTIME_NOT_PERMITTED before the first
  -- stage (D44) and ('awaiting_execution_authority','failed') for a campaign that ends before any approved writer call (D43).
  -- v3 adds ('importing','budget_exhausted') for CCC_PLANNING_BUILD_FIT_INSUFFICIENT at bridge step 4 (verify-v2 item 38).
  SELECT from_state = to_state OR (from_state, to_state) IN (
    ('admitted', 'running'), ('admitted', 'cancelling'), ('admitted', 'failed'), ('admitted', 'blocked_prerequisite'),
    ('running', 'awaiting_intent'), ('running', 'awaiting_budget'), ('running', 'blocked_prerequisite'),
    ('running', 'blocked_provider'), ('running', 'budget_exhausted'), ('running', 'unknown_effect'),
    ('running', 'paused'), ('running', 'cancelling'), ('running', 'spec_ready'), ('running', 'failed'),
    ('awaiting_intent', 'running'), ('awaiting_intent', 'cancelling'),
    ('awaiting_budget', 'running'), ('awaiting_budget', 'building'), ('awaiting_budget', 'cancelling'),
    ('blocked_prerequisite', 'running'), ('blocked_prerequisite', 'building'), ('blocked_prerequisite', 'cancelling'),
    ('blocked_provider', 'running'), ('blocked_provider', 'building'), ('blocked_provider', 'cancelling'),
    ('budget_exhausted', 'awaiting_budget'), ('budget_exhausted', 'cancelling'), ('budget_exhausted', 'failed'),
    ('unknown_effect', 'running'), ('unknown_effect', 'building'), ('unknown_effect', 'cancelling'),
    ('paused', 'running'), ('paused', 'building'), ('paused', 'cancelling'),
    ('cancelling', 'cancelled'),
    ('spec_ready', 'importing'), ('spec_ready', 'cancelling'), ('spec_ready', 'paused'),
    ('spec_ready', 'blocked_prerequisite'), ('spec_ready', 'budget_exhausted'), ('spec_ready', 'failed'),
    ('importing', 'awaiting_execution_authority'), ('importing', 'building'),
    ('importing', 'blocked_prerequisite'), ('importing', 'budget_exhausted'), ('importing', 'cancelling'),
    ('importing', 'failed'),
    ('awaiting_execution_authority', 'building'), ('awaiting_execution_authority', 'cancelling'),
    ('awaiting_execution_authority', 'failed'),
    ('building', 'verification_failed'), ('building', 'accepted'), ('building', 'paused'),
    ('building', 'cancelling'), ('building', 'blocked_prerequisite'), ('building', 'blocked_provider'),
    ('building', 'budget_exhausted'), ('building', 'unknown_effect'), ('building', 'failed'),
    ('verification_failed', 'cancelling'), ('verification_failed', 'failed'),
    ('accepted', 'delivering'), ('accepted', 'cancelling'),
    ('delivering', 'delivered'), ('delivering', 'failed'))
$$;

CREATE OR REPLACE FUNCTION project.ccc_planning_runs_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'admitted' OR NEW.revision <> 1 OR NEW.amendment_seq <> 0 OR NEW.control_seq <> 0
       OR NEW.planning_spent <> 0 OR NEW.review_proof_spent <> 0 OR NEW.research_fetch_spent <> 0
       OR NEW.research_bytes_spent <> 0 OR NEW.repair_chunks_used <> 0 OR NEW.repair_epoch_state <> 'unopened'
       OR NEW.review_epochs <> 0 OR NEW.stagnant_epochs <> 0 OR NEW.control_request IS NOT NULL
       OR NEW.import_intent_digest IS NOT NULL OR NEW.import_id IS NOT NULL THEN
      RAISE EXCEPTION 'CCC_PLANNING_ANCHOR_INSERT_INVALID: run % must start admitted with zero counters', NEW.run_id
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.state IN ('cancelled', 'delivered', 'failed') THEN
    RAISE EXCEPTION 'CCC_PLANNING_RUN_TERMINAL: run % is %', OLD.run_id, OLD.state USING ERRCODE = 'check_violation';
  END IF;

  -- E2-63: IS DISTINCT FROM, so an UPDATE that sets an identity column to NULL is refused too.
  IF NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.run_id IS DISTINCT FROM OLD.run_id
     OR NEW.planning_task_id IS DISTINCT FROM OLD.planning_task_id
     OR NEW.mode IS DISTINCT FROM OLD.mode OR NEW.budget_profile IS DISTINCT FROM OLD.budget_profile
     OR NEW.role_profile IS DISTINCT FROM OLD.role_profile
     OR NEW.policy_version IS DISTINCT FROM OLD.policy_version OR NEW.policy_digest IS DISTINCT FROM OLD.policy_digest
     OR NEW.request_digest IS DISTINCT FROM OLD.request_digest OR NEW.request_bytes IS DISTINCT FROM OLD.request_bytes
     OR NEW.target_repository IS DISTINCT FROM OLD.target_repository
     OR NEW.admitted_base IS DISTINCT FROM OLD.admitted_base
     OR NEW.authority_receipt_sha256 IS DISTINCT FROM OLD.authority_receipt_sha256
     OR NEW.authority_receipt_json IS DISTINCT FROM OLD.authority_receipt_json
     OR NEW.runtime_dist_manifest_sha256 IS DISTINCT FROM OLD.runtime_dist_manifest_sha256
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'CCC_PLANNING_ANCHOR_IMMUTABLE: run % identity is immutable', OLD.run_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.planning_spent < OLD.planning_spent OR NEW.review_proof_spent < OLD.review_proof_spent
     OR NEW.research_fetch_spent < OLD.research_fetch_spent OR NEW.research_bytes_spent < OLD.research_bytes_spent
     OR NEW.repair_chunks_used < OLD.repair_chunks_used OR NEW.review_epochs < OLD.review_epochs
     OR NEW.control_seq < OLD.control_seq OR NEW.revision < OLD.revision OR NEW.amendment_seq < OLD.amendment_seq
     OR NEW.control_seq > OLD.control_seq + 1 OR NEW.revision > OLD.revision + 1 THEN
    RAISE EXCEPTION 'CCC_PLANNING_COUNTER_DECREASE: run % counters only move forward one step', OLD.run_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF NOT project.ccc_planning_run_transition_allowed(OLD.state, NEW.state) THEN
    RAISE EXCEPTION 'CCC_PLANNING_STATE_TRANSITION_REFUSED: run % % -> %', OLD.run_id, OLD.state, NEW.state
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.planning_spent > OLD.planning_spent OR NEW.review_proof_spent > OLD.review_proof_spent
     OR NEW.research_fetch_spent > OLD.research_fetch_spent THEN
    IF OLD.control_request IS NOT NULL OR NEW.control_request IS NOT NULL OR OLD.state <> NEW.state
       OR (NEW.planning_spent > OLD.planning_spent AND NEW.state <> 'running')
       OR (NEW.research_fetch_spent > OLD.research_fetch_spent AND NEW.state <> 'running')
       OR (NEW.review_proof_spent > OLD.review_proof_spent AND NEW.state <> 'building')
       OR clock_timestamp() + interval '30 seconds' >= NEW.deadline_at::timestamptz
       OR (NEW.planning_spent - OLD.planning_spent) + (NEW.review_proof_spent - OLD.review_proof_spent)
          + (NEW.research_fetch_spent - OLD.research_fetch_spent) <> 1 THEN
      RAISE EXCEPTION 'CCC_PLANNING_SPEND_REFUSED: run % spends one call at a time, uncontrolled, in phase state, before the deadline', OLD.run_id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW.review_epochs > OLD.review_epochs + 1
     OR (NEW.stagnant_epochs <> OLD.stagnant_epochs
         AND NOT (NEW.review_epochs = OLD.review_epochs + 1
                  AND NEW.stagnant_epochs IN (0, OLD.stagnant_epochs + 1))) THEN
    RAISE EXCEPTION 'CCC_PLANNING_REVIEW_EPOCH_INVALID: run %', OLD.run_id USING ERRCODE = 'check_violation';
  END IF;

  IF (NEW.amendment_seq <> OLD.amendment_seq AND NEW.grant_digest = OLD.grant_digest)
     OR ((NEW.deadline_at <> OLD.deadline_at OR NEW.planning_allocation <> OLD.planning_allocation
          OR NEW.implementation_allocation <> OLD.implementation_allocation
          OR NEW.review_proof_allocation <> OLD.review_proof_allocation
          OR NEW.research_fetch_allocation <> OLD.research_fetch_allocation
          OR NEW.research_bytes_allocation <> OLD.research_bytes_allocation
          OR NEW.grant_digest <> OLD.grant_digest)
         AND NOT (NEW.amendment_seq = OLD.amendment_seq + 1
                  AND NEW.grant_digest <> OLD.grant_digest
                  AND NEW.deadline_at::timestamptz >= OLD.deadline_at::timestamptz
                  AND NEW.planning_allocation >= OLD.planning_allocation
                  AND NEW.implementation_allocation >= OLD.implementation_allocation
                  AND NEW.review_proof_allocation >= OLD.review_proof_allocation
                  AND NEW.research_fetch_allocation >= OLD.research_fetch_allocation
                  AND NEW.research_bytes_allocation >= OLD.research_bytes_allocation)) THEN
    RAISE EXCEPTION 'CCC_PLANNING_GRANT_CHANGE_REFUSED: run % grant changes only by one enlarging amendment', OLD.run_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF (OLD.repair_epoch_state = 'closed' AND NEW.repair_epoch_state <> 'closed')
     OR (OLD.repair_epoch_state = 'open' AND NEW.repair_epoch_state = 'unopened')
     OR (NEW.repair_chunks_used > OLD.repair_chunks_used
         AND (NEW.repair_chunks_used <> OLD.repair_chunks_used + 1 OR NEW.repair_epoch_state <> 'open')) THEN
    RAISE EXCEPTION 'CCC_PLANNING_REPAIR_EPOCH_CLOSED: run % repair epoch is one-way', OLD.run_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF (OLD.import_intent_digest IS NOT NULL AND NEW.import_intent_digest IS DISTINCT FROM OLD.import_intent_digest)
     OR (OLD.import_idempotency_key IS NOT NULL AND NEW.import_idempotency_key IS DISTINCT FROM OLD.import_idempotency_key)
     OR (OLD.import_id IS NOT NULL AND NEW.import_id IS DISTINCT FROM OLD.import_id)
     OR (OLD.implementation_transferred IS NOT NULL
         AND NEW.implementation_transferred IS DISTINCT FROM OLD.implementation_transferred) THEN
    RAISE EXCEPTION 'CCC_PLANNING_IMPORT_LINK_WRITE_ONCE: run %', OLD.run_id USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END $$;

-- BEFORE row triggers fire in name order; 'zz_' runs after fusion_assign_project_id, as 0043 does (E2-63).
DROP TRIGGER IF EXISTS zz_ccc_planning_runs_guard ON project.ccc_planning_runs;
CREATE TRIGGER zz_ccc_planning_runs_guard
  BEFORE INSERT OR UPDATE ON project.ccc_planning_runs
  FOR EACH ROW EXECUTE FUNCTION project.ccc_planning_runs_guard();

ALTER TABLE project.ccc_planning_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE project.ccc_planning_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fusion_project_isolation ON project.ccc_planning_runs;
CREATE POLICY fusion_project_isolation ON project.ccc_planning_runs
  USING (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true))
  WITH CHECK (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true));
DROP TRIGGER IF EXISTS fusion_assign_project_id ON project.ccc_planning_runs;
CREATE TRIGGER fusion_assign_project_id
  BEFORE INSERT OR UPDATE OF project_id ON project.ccc_planning_runs
  FOR EACH ROW EXECUTE FUNCTION project.fusion_assign_project_id();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fusion_runtime') THEN
    GRANT SELECT, INSERT, UPDATE ON project.ccc_planning_runs TO fusion_runtime;
    -- E1-15: the runtime never deletes an anchor row (a delete and re-insert would reset the counters), and the tasks
    -- FK is NO ACTION, so no cascade needs the privilege.
    REVOKE DELETE, TRUNCATE ON project.ccc_planning_runs FROM fusion_runtime;
  END IF;
END
$$;
```

These SQL statements belong in the TypeScript ops (L1), not in the migration:

```sql
-- Retention exclusion, packages/core/src/task-store/async-maintenance.ts:95-101 (L1)
DELETE FROM project.run_audit_events AS events
WHERE events.timestamp < ${cutoff}
  AND events.campaign_import_id IS NULL
  AND events.run_id NOT LIKE 'ccc-plan:%'
  AND events.task_id IN (SELECT id FROM project.tasks WHERE project_id = ${projectId})
RETURNING 1;

-- Spend compare-and-set inside admitCccPlanningDispatch (L1). Shown for planning; for review_proof the column is
-- review_proof_spent / review_proof_allocation and the state predicate is state = 'building'.
UPDATE project.ccc_planning_runs
   SET planning_spent = planning_spent + 1, updated_at = $now
 WHERE project_id = $project AND run_id = $run
   AND planning_spent = $seenSpent AND planning_spent < planning_allocation
   AND state = 'running' AND control_request IS NULL
RETURNING planning_spent;
```

Applier registration (S0, `schema-applier.ts`):
- add `CCC_PLANNING_RUNS_VERSION = "0042"` and `CCC_PLANNING_ARTIFACT_GUARD_VERSION = "0043"`;
- register both files in order after `0041_ccc_prd_import_stopped_state.sql`;
- set `SCHEMA_BASELINE_VERSION = "0043"`;
- update the three pins to `"0043"`.

Both files run after 0006 inside the same applier transaction (`schema-applier.ts:625-630`), and the ownership and relational audit (`schema-applier.ts:640-706`) runs on every boot. S0's migration test therefore applies the full chain to a fresh database, boots the applier a second time on the same database, and requires the audit to pass both times with `ccc_planning_runs` listed among the project-owned tables.

The Drizzle table `cccPlanningRuns` goes in `packages/core/src/postgres/schema/ccc-planning.ts`. Its table name is added to `projectTableNames` in `schema/project.ts`. The Drizzle foreign key mirrors the composite form, and the Drizzle comment on the import foreign key stays in sync with its `DEFERRABLE INITIALLY IMMEDIATE` declaration (E2-60).

Partition promotion (S0, `packages/core/src/postgres/migration-stamping.ts`, granted to S0 by E2-61). `fn plan start` requires a registered `--project`, so an anchor should never sit under a stand-in project id. As defence in depth, promotion first checks the stand-in partition for any `ccc_planning_runs` row or any `task_documents` key with the `cccplan-` prefix. If it finds one, it throws `ProjectPartitionRekeyError` with the new typed reason `planning-rows-present`, and startup falls back gracefully instead of refusing the project (`startup-factory.ts:1194-1205`). A stand-in partition that holds `ccc_prd_imports` rows and no anchor still promotes, because the import foreign key is deferrable (E2-60).

### 2.3 Run states (PRD §9) and `CCC_PLANNING_*` codes

```ts
// packages/core/src/ccc-planning/types.ts (K1)
export type CccPlanningRunState =
  | "admitted" | "running" | "awaiting_intent" | "awaiting_budget" | "awaiting_execution_authority"
  | "blocked_prerequisite" | "blocked_provider" | "budget_exhausted" | "unknown_effect" | "paused"
  | "cancelling" | "cancelled" | "spec_ready" | "importing" | "building" | "verification_failed"
  | "accepted" | "delivering" | "delivered" | "failed";
export const CCC_PLANNING_TERMINAL_STATES = ["cancelled", "delivered", "failed"] as const;
/** No automatic exit in I2. Build-mode spec_ready is transient (it moves on to importing). */
export function cccPlanningRestingStates(mode: CccPlanningMode): readonly CccPlanningRunState[];
  // "spec" -> ["spec_ready"]; "build" -> ["accepted", "verification_failed"]
/** States that wait on an operator or a reconcile; the live poll stops on these too. */
export const CCC_PLANNING_OPERATOR_WAIT_STATES = [
  "awaiting_intent", "awaiting_budget", "awaiting_execution_authority", "paused",
  "blocked_prerequisite", "blocked_provider", "budget_exhausted", "unknown_effect",
] as const;
export function cccPlanningTransitionAllowed(from: CccPlanningRunState, to: CccPlanningRunState): boolean;
  // must equal project.ccc_planning_run_transition_allowed for all 400 pairs (L1 parity test; S0 checks the SQL against the frozen literal list); 65 pairs plus identity
export function cccPlanningResumeTarget(run: { importId: string | null }): "running" | "building";
  // resume, unblock and reconcile return to "running" before import and "building" after
```

| State | Meaning | `state_code` (required unless marked optional) |
|---|---|---|
| admitted | G0 passed; task, anchor, workflow, work item and admission artifacts exist | optional |
| running | Planning stages (including the preflight qualification lineages) are executing | optional |
| awaiting_intent | Ambiguity needs an operator answer (`fn plan answer`) | `CCC_PLANNING_AWAITING_INTENT` |
| awaiting_budget | An enlarging amendment is needed. I2 has no `fn plan budget`, so only cancel can exit | `CCC_PLANNING_AWAITING_BUDGET` |
| awaiting_execution_authority | Imported; receipt release did not apply, so `fn prd approve-execution` is required. BF moves the run to `building` at the first approved linked writer reservation | `CCC_PLANNING_AWAITING_EXECUTION_AUTHORITY` |
| blocked_prerequisite | Host prerequisite missing | `CCC_PLANNING_SANDBOX_UNAVAILABLE`, `CCC_PLANNING_IMPORT_STOPPED`, `CCC_PLANNING_IMPORT_REPLAY_REFUSED`, `CCC_PLANNING_POSTGRES_REQUIRED`, `CCC_PLANNING_RUNTIME_NOT_PERMITTED`, `CCC_PLANNING_BUILD_BASELINE_MISMATCH`, `CCC_PLANNING_WRITER_CLOSURE_UNCONFIRMED` (a quarantined writer, through the existing pair `building → blocked_prerequisite`, E2-5, E4-2) |
| blocked_provider | Provider or route failure; in planning scope a single drift or receipt mismatch is enough (D10) | `CCC_BLOCKED_PROVIDER`, `CCC_PROVIDER_PIN_DRIFT`, `CCC_MODEL_DEGENERATE_OUTPUT` |
| budget_exhausted | An allocation, the deadline or a cap is spent | `CCC_PLANNING_PHASE_ALLOCATION_EXHAUSTED`, `CCC_PLANNING_DEADLINE`, `CCC_PLANNING_ITERATION_CAP`, `CCC_PLANNING_DISPATCH_CAP`, `CCC_PLANNING_REPAIR_EXHAUSTED`, `CCC_PLANNING_RESEARCH_GRANT_EXHAUSTED`, `CCC_PLANNING_BUILD_FIT_INSUFFICIENT`, `CCC_PLANNING_PLANNING_FIT_INSUFFICIENT` |
| unknown_effect | A call is `dispatched_unknown` and must be reconciled | `CCC_PLANNING_UNRECONCILED_DISPATCH` |
| paused / cancelling | Control applied or in progress | optional |
| cancelled | Terminal | optional (`CCC_PLANNING_CANCELLED`) |
| spec_ready | Reviewed closure sealed (`spec_ready` artifact). Resting in Spec mode; transient in Build | optional |
| importing | Baseline, preflight, intent, importer or reconcile in progress | optional |
| building | Campaign live, writers and G7/G8 running | optional |
| verification_failed | G7 or G8 rejected; coding repair NOT RUN in I2 | `CCC_PLANNING_CODING_REPAIR_NOT_RUN` (I2) or `CCC_PLANNING_REVIEW_REJECTED` |
| accepted | G8 approved the integrated candidate and every campaign item succeeded | optional |
| delivering / delivered | G9 (NOT RUN in I2) | optional |
| failed | Terminal | `CCC_PLANNING_GRAPH_INADMISSIBLE`, `CCC_PLANNING_ORACLE_CONTROL_FAILED`, `CCC_PLANNING_ORACLE_SETUP_FAILURE`, `CCC_PLANNING_ORACLE_CONTROL_UNTAGGED`, `CCC_PLANNING_OBJECTION_UNRESOLVED`, `CCC_PLANNING_REVIEW_STAGNATED`, `CCC_PLANNING_DESIGN_INFEASIBLE`, `CCC_PLANNING_IMPORT_IDENTITY_DRIFT`, `CCC_PLANNING_REVIEWED_BYTES_DRIFT`, `CCC_PLANNING_WORKFLOW_IR_DRIFT`, `CCC_PLANNING_FINAL_JUDGMENT_MISSING`, `CCC_PLANNING_CAMPAIGN_FAILED` |

```ts
// packages/core/src/ccc-planning/errors.ts (K1; K1b appends one code)
// K1 implements this union as `(typeof CCC_PLANNING_REFUSAL_CODES)[number]` over the closed const list
// CCC_PLANNING_REFUSAL_CODES, in exactly the order below (checked at INT-1b ff4fc3e4f: 97 codes). E4-1 drops
// ROLE_CLASS_MISMATCH and CONTROL_STATE_INVALID, which K1 never added. K1b appends CCC_PLANNING_WRITER_CLOSURE_UNCONFIRMED
// as the last entry, and every existing code keeps its position (E3-4, E4-K item 1).
// K1b was accepted at a46fed5e1 and is on integration as INT-2b ee89957c1 (E6), whose list holds exactly these 98 codes in
// this order. E5 and E6 add no code: the repair-1 refusals below reuse codes already in this list.
// E7 adds no code either: its repair-2 refusals reuse codes in this list (its ENVELOPE_MISMATCH is
// CCC_PLANNING_RECEIPT_ENVELOPE_MISMATCH), checked read-only at INT-2c 115ab8d7f, whose errors.ts is INT-2b's.
// E8 adds no code either: its refusals reuse ROUTE_NOT_ADMITTED, CONTROL_PENDING, STATE_TRANSITION_REFUSED,
// INTERNAL_ERROR and GRAPH_INADMISSIBLE, checked read-only at INT-2d fcb83879d, whose errors.ts is INT-2c's (E8-0, N-8).
// K2's CCC_ROUTE_IDENTITY_REJECTED (N-4) is a campaign route-admission code, not a member of this union.
export type CccPlanningRefusalCode =
  // G0 and admission
  | "CCC_PLANNING_AUTHORITY_RECEIPT_REQUIRED" | "CCC_PLANNING_AUTHORITY_RECEIPT_INVALID"
  | "CCC_PLANNING_AUTHORITY_RECEIPT_UNCONFIRMED" | "CCC_PLANNING_AUTHORITY_RECEIPT_EXPIRED"
  | "CCC_PLANNING_AUTHORITY_RECEIPT_CONSUMED" | "CCC_PLANNING_AUTHORITY_CONFIRMATION_REQUIRED"
  | "CCC_PLANNING_REJECTED_MODEL_IDENTITY"
  | "CCC_PLANNING_ENDPOINT_NOT_LOOPBACK" | "CCC_PLANNING_BUDGET_POLICY_MISMATCH"
  | "CCC_PLANNING_RUNTIME_NOT_PERMITTED" | "CCC_PLANNING_TARGET_NOT_DISPOSABLE"
  | "CCC_PLANNING_QUALIFICATION_REQUIRED" | "CCC_PLANNING_REQUEST_INVALID"
  | "CCC_PLANNING_REQUEST_DIGEST_MISMATCH" | "CCC_PLANNING_REQUEST_CONTAINS_PRD_GRAMMAR"
  | "CCC_PLANNING_PROFILE_NOT_SUPPORTED" | "CCC_PLANNING_LARGE_NOT_AUTHORIZED"
  | "CCC_PLANNING_PLANNING_FIT_INSUFFICIENT" | "CCC_PLANNING_SOURCE_POLICY_MISMATCH"
  | "CCC_PLANNING_CONFINEMENT_UNQUALIFIED" | "CCC_PLANNING_POSTGRES_REQUIRED"
  | "CCC_PLANNING_WORKFLOW_IR_DRIFT"
  // budget and counters
  | "CCC_PLANNING_PHASE_ALLOCATION_EXHAUSTED" | "CCC_PLANNING_ITERATION_CAP" | "CCC_PLANNING_DISPATCH_CAP"
  | "CCC_PLANNING_UNRECONCILED_DISPATCH" | "CCC_PLANNING_DEADLINE" | "CCC_PLANNING_REPAIR_EXHAUSTED"
  | "CCC_PLANNING_REPAIR_EPOCH_CLOSED" | "CCC_PLANNING_REVIEW_STAGNATED" | "CCC_PLANNING_BUILD_FIT_INSUFFICIENT"
  | "CCC_PLANNING_RESEARCH_GRANT_EXHAUSTED"
  // fences, control and custody
  | "CCC_PLANNING_FENCE_STALE" | "CCC_PLANNING_CONTROL_PENDING" | "CCC_PLANNING_REVISION_STALE"
  | "CCC_PLANNING_DECISION_NOT_AWAITED" | "CCC_PLANNING_STATE_TRANSITION_REFUSED" | "CCC_PLANNING_RUN_TERMINAL"
  | "CCC_PLANNING_RUN_NOT_FOUND" | "CCC_PLANNING_RUN_AMBIGUOUS" | "CCC_PLANNING_RUN_PROJECT_MISMATCH"
  | "CCC_PLANNING_RUN_ENDED" | "CCC_PLANNING_TASK_CUSTODY" | "CCC_PLANNING_DESCENDANTS_UNSETTLED"
  | "CCC_PLANNING_CONTROL_REQUIRES_CAMPAIGN_BRIDGE"
  // anchor trigger backstops (SQLSTATE 23514, message prefix)
  | "CCC_PLANNING_ANCHOR_INSERT_INVALID" | "CCC_PLANNING_ANCHOR_IMMUTABLE" | "CCC_PLANNING_COUNTER_DECREASE"
  | "CCC_PLANNING_SPEND_REFUSED" | "CCC_PLANNING_REVIEW_EPOCH_INVALID" | "CCC_PLANNING_GRANT_CHANGE_REFUSED"
  | "CCC_PLANNING_IMPORT_LINK_WRITE_ONCE"
  // artifacts (trigger 0043 uses SQLSTATE P0001 with these prefixes)
  | "CCC_PLANNING_ARTIFACT_IMMUTABLE" | "CCC_PLANNING_ARTIFACT_PUBLISHER_REQUIRED"
  | "CCC_PLANNING_ARTIFACT_ENVELOPE_INVALID" | "CCC_PLANNING_ARTIFACT_TOO_LARGE"
  | "CCC_PLANNING_ARTIFACT_NOT_UTF8" | "CCC_PLANNING_ARTIFACT_DIGEST_MISMATCH"
  | "CCC_PLANNING_ARTIFACT_RUN_MISMATCH" | "CCC_PLANNING_ARTIFACT_FENCE_REFUSED"
  | "CCC_PLANNING_ARTIFACT_INPUT_UNPUBLISHED" | "CCC_PLANNING_DESIGN_SEAL_BROKEN"
  | "CCC_PLANNING_ARTIFACT_SLOT_CONFLICT"
  // fidelity and objections (G3)
  | "CCC_PLANNING_REQUEST_ANCHOR_MISMATCH" | "CCC_PLANNING_REQUEST_QUOTE_UNRESOLVED"
  | "CCC_PLANNING_REQUEST_QUOTE_AMBIGUOUS" | "CCC_PLANNING_REQUEST_UNIT_UNDISPOSITIONED"
  | "CCC_PLANNING_REQUEST_DERIVATION_MISSING" | "CCC_PLANNING_ANNEX_ATTRIBUTED_TO_REQUEST"
  | "CCC_PLANNING_ACCEPTANCE_CASE_UNMAPPED" | "CCC_PLANNING_EXCLUSION_UNMAPPED"
  | "CCC_PLANNING_ANNEX_DECISION_UNKNOWN" | "CCC_PLANNING_OBJECTION_UNRESOLVED"
  // gates, import and build
  | "CCC_PLANNING_GRAPH_INADMISSIBLE" | "CCC_PLANNING_ORACLE_CONTROL_FAILED" | "CCC_PLANNING_ORACLE_SETUP_FAILURE"
  | "CCC_PLANNING_ORACLE_CONTROL_UNTAGGED" | "CCC_PLANNING_DESIGN_INFEASIBLE"
  | "CCC_PLANNING_REVIEW_REJECTED" | "CCC_PLANNING_CODING_REPAIR_NOT_RUN" | "CCC_PLANNING_SANDBOX_UNAVAILABLE"
  | "CCC_PLANNING_REVIEWED_BYTES_DRIFT" | "CCC_PLANNING_IMPORT_STOPPED" | "CCC_PLANNING_IMPORT_IDENTITY_DRIFT"
  | "CCC_PLANNING_IMPORT_REPLAY_REFUSED" | "CCC_PLANNING_RECEIPT_ENVELOPE_MISMATCH"
  | "CCC_PLANNING_ROUTE_NOT_ADMITTED" | "CCC_PLANNING_BUILD_BASELINE_MISMATCH"
  | "CCC_PLANNING_FINAL_JUDGMENT_MISSING" | "CCC_PLANNING_CAMPAIGN_FAILED"
  // state codes that are not refusals
  | "CCC_PLANNING_AWAITING_INTENT" | "CCC_PLANNING_AWAITING_BUDGET" | "CCC_PLANNING_AWAITING_EXECUTION_AUTHORITY"
  | "CCC_PLANNING_CANCELLED"
  // CLI
  | "CCC_PLANNING_CLI_USAGE" | "CCC_PLANNING_COMMAND_NOT_SUPPORTED" | "CCC_PLANNING_INTERNAL_ERROR"
  // appended last by K1b (E3-4, E4-K item 1): terminal for the writer attempt; WR quarantines, and BF maps the run to
  // blocked_prerequisite (E2-5, E4-2)
  | "CCC_PLANNING_WRITER_CLOSURE_UNCONFIRMED";

export class CccPlanningRefusal extends Error {
  public constructor(public readonly code: CccPlanningRefusalCode, public readonly detail: string, public readonly field?: string) {
    super(`${code}: ${detail}`);
    this.name = "CccPlanningRefusal";
  }
}
export class CccPlanningTaskCustodyError extends CccPlanningRefusal {
  public constructor(public readonly taskId: string, public readonly operation: string) {
    super("CCC_PLANNING_TASK_CUSTODY", `task ${taskId} is held by a request-to-code run; ${operation} refused`, operation);
    this.name = "CccPlanningTaskCustodyError";
  }
}
/** Maps a PostgreSQL error whose message starts with a CCC_PLANNING_* code to CccPlanningRefusal; otherwise null. */
export function cccPlanningRefusalFromDatabaseError(error: unknown): CccPlanningRefusal | null;
```

- v2 removes `CCC_PLANNING_EVENT_ID_COLLISION`; event-id collisions throw the existing `RunAuditEventCollisionError` (`CCC_RUN_AUDIT_EVENT_COLLISION`, D39).
- Related non-planning codes that keep their own error classes: `CCC_SESSION_TOOL_POLICY_REFUSED`, `CCC_PROVIDER_ROUTE_RECEIPT_REFUSED`, `CCC_ROUTE_IDENTITY_REJECTED`, `CCC_CONFINEMENT_REFUSED`, `CCC_CONFINEMENT_CLOSURE_UNCONFIRMED`, `CCC_RESEARCH_FETCH_REFUSED`, `CCC_MODEL_DEGENERATE_OUTPUT`, `CCC_PROVIDER_PIN_DRIFT`, `CCC_BLOCKED_PROVIDER`, `CCC_PROVIDER_ATTEMPT_LIMIT_REFUSED`, `CCC_CAMPAIGN_OPERATOR_CONTROL_LEASED`, `CCC_RUN_AUDIT_EVENT_COLLISION`, `CCC_PRD_TARGET_HEAD_DRIFT`, and the dashboard guard's `CCC_TASK_CUSTODY_LOOKUP_FAILED` (HTTP 500 when the custody lookup fails, E5-G1 item 4).
- Script codes (proof runner, installed and live lanes) are not in the core union: `CCC_PLANNING_PROOF_INVENTORY_INVALID`, `CCC_PLANNING_PROOF_PG_SKIP_REFUSED`, `CCC_PLANNING_OFFLINE_PLATFORM_UNSUPPORTED`, `CCC_PLANNING_OFFLINE_NETWORK_ATTEMPT`, `CCC_PLANNING_PROOF_NOT_IMPLEMENTED`, `CCC_PLANNING_PROFILE_NOT_IMPLEMENTED`, `SERVE_AUTO_REGISTERED`, `PORT_FORBIDDEN`, `FOREIGN_GIT_MUTATION`.
- Audit-only marker (never a state code): `CCC_PLANNING_CAMPAIGN_STATE_UNMAPPED`, in `ccc-planning:campaign-unmapped` events.

### 2.4 Stage vocabulary and artifact keys

```ts
// packages/core/src/ccc-planning/types.ts (K1)
export const CCC_PLANNING_IR_STAGES = [
  "preflight", "intent", "research", "design", "design-review", "spec",
  "plan", "verifier", "review", "repair", "specready", "import",
] as const;                                     // IR order; Spec mode omits "import"
export const CCC_PLANNING_ARTIFACT_ONLY_STAGES = ["admission", "operator", "invalidate", "g7", "g8"] as const;
export type CccPlanningIrStageId = (typeof CCC_PLANNING_IR_STAGES)[number];
export type CccPlanningStageId = CccPlanningIrStageId | (typeof CCC_PLANNING_ARTIFACT_ONLY_STAGES)[number];
```

- **IR nodes.**
  - Every IR stage is one `gate` node with `config: { cccPlanningStage: <id> }` and `maxRetries: 0`. IR stage nodes are host steps; they are not the "nodes" of the fit rule, which counts model-session lineages (D21).
  - The graph executor treats `maxRetries: 0` as unset (`workflow-graph-executor.ts:2160-2163`, E1 carry-forward). H1 therefore gets the single attempt per node through the settings `maxRetriesPerNode: 1` and never edits this K1-pinned IR (E2-14).
  - The nodes are chained in the order above.
  - `preflight` runs the three qualification lineages (0.10) and nothing else.
  - `repair` is a node that does nothing unless the review stage claimed a chunk. After a repair, the stage handler re-enters `review` through the controller's loop (inside one node attempt chain, bounded by the repair chunks, the inherited dispatch caps and stagnation), never through an IR back edge.
- **Key grammar.** `cccplan-r<rev 3 digits>-<stageId>-<slot>-v<version 2 digits>`, for example `cccplan-r001-design-review-a-v01`.
  - `slot` matches `/^[a-z0-9]{1,20}$/`.
  - Keys are decoded **from the right**: version, then slot, and the remainder is the stage id.
  - The maximum length is 51 characters.
- **Producers.** `objection` is always controller-produced, converted from a reviewer's verdict (D47). `decision_record` is model-produced by the spec author (stage `spec`) or the repairing author (stage `repair`). `proof_results` and `build_transition` are controller-produced.

| Stage | Artifact kinds it may publish |
|---|---|
| admission | original_request, admission_grant, authority_receipt |
| preflight | tool_fidelity_receipt, confinement_qualification, model_receipt |
| intent | acceptance_cases, acceptance_review, objection, decision_request, model_receipt |
| research | repository_snapshot, research_evidence, citation, extraction, extraction_review, source_verification, objection, model_receipt |
| design | design_alternative, model_receipt |
| design-review | design_review, objection, model_receipt |
| spec | requirement_map, final_prd, technical_annex, decision_record, model_receipt |
| plan | task_plan, routing_plan, model_receipt |
| verifier | verifier_bundle, verifier_audit, oracle_observation, oracle_review, objection, model_receipt |
| review | product_review, technical_review, adjudication, objection, budget_receipt, model_receipt |
| repair | decision_record, requirement_map, final_prd, technical_annex, task_plan, routing_plan, verifier_bundle, model_receipt |
| specready | spec_ready |
| import | build_transition, admission_facts, packet_manifest, sidecar, bundle, execution_plan, authorship_receipt, import_intent, import_receipt, live_execution_release |
| operator | operator_answer, build_grant, budget_amendment |
| invalidate | invalidation |
| g7 | task_review, proof_results, model_receipt |
| g8 | final_judgment, proof_results, model_receipt |

### 2.5 SQL: `packages/core/src/postgres/migrations/0043_ccc_planning_artifact_guard.sql` (card S0)

```sql
-- FNXC:CccPlanningArtifacts 2026-10-14: planning artifacts are task documents under the reserved
-- key prefix 'cccplan-'. Insert-once, publisher-gated, digest-checked, anchored to the run,
-- fence-guarded, closure-checked and design-sealed. Ordinary documents pay one LIKE test.
CREATE OR REPLACE FUNCTION project.ccc_planning_artifact_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  envelope jsonb;
  fence jsonb;
  input_ref jsonb;
  stage text;
  expected_key text;
  anchor project.ccc_planning_runs%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.key LIKE 'cccplan-%' THEN
      RAISE EXCEPTION 'CCC_PLANNING_ARTIFACT_IMMUTABLE: % on task % cannot be deleted', OLD.key, OLD.task_id
        USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.key LIKE 'cccplan-%' OR NEW.key LIKE 'cccplan-%' THEN
      RAISE EXCEPTION 'CCC_PLANNING_ARTIFACT_IMMUTABLE: % on task % cannot be updated', OLD.key, OLD.task_id
        USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.key NOT LIKE 'cccplan-%' THEN
    RETURN NEW;
  END IF;
  IF current_setting('fusion.ccc_planning_publication', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'CCC_PLANNING_ARTIFACT_PUBLISHER_REQUIRED: % is a reserved planning artifact key', NEW.key
      USING ERRCODE = 'P0001';
  END IF;

  envelope := NEW.metadata;
  stage := envelope->>'stageId';
  IF envelope IS NULL OR jsonb_typeof(envelope) <> 'object'
     OR envelope->>'schema' IS DISTINCT FROM 'ccc-planning.artifact-envelope.v1'
     OR envelope->>'artifactKey' IS DISTINCT FROM NEW.key
     OR stage IS NULL OR stage NOT IN (
       'preflight', 'intent', 'research', 'design', 'design-review', 'spec', 'plan', 'verifier', 'review',
       'repair', 'specready', 'import', 'admission', 'operator', 'invalidate', 'g7', 'g8')
     OR coalesce(envelope->>'slot', '') !~ '^[a-z0-9]{1,20}$'
     OR coalesce(envelope->>'runRevision', '') !~ '^[1-9][0-9]{0,2}$'
     OR coalesce(envelope->>'version', '') !~ '^[1-9][0-9]?$'
     OR coalesce(envelope->>'kind', '') = ''
     OR jsonb_typeof(envelope->'inputs') IS DISTINCT FROM 'array'
     OR jsonb_typeof(envelope->'fence') IS DISTINCT FROM 'object'
     OR NEW.revision <> 1
     OR NEW.author IS DISTINCT FROM ('ccc-planning:' || coalesce(envelope->'producer'->>'roleId', '')) THEN
    RAISE EXCEPTION 'CCC_PLANNING_ARTIFACT_ENVELOPE_INVALID: %', NEW.key USING ERRCODE = 'P0001';
  END IF;
  expected_key := 'cccplan-r' || lpad(envelope->>'runRevision', 3, '0') || '-' || stage || '-'
    || (envelope->>'slot') || '-v' || lpad(envelope->>'version', 2, '0');
  IF NEW.key <> expected_key THEN
    RAISE EXCEPTION 'CCC_PLANNING_ARTIFACT_ENVELOPE_INVALID: key % expected %', NEW.key, expected_key
      USING ERRCODE = 'P0001';
  END IF;
  IF octet_length(NEW.content) > 4194304 THEN
    RAISE EXCEPTION 'CCC_PLANNING_ARTIFACT_TOO_LARGE: %', NEW.key USING ERRCODE = 'P0001';
  END IF;
  IF envelope->>'outputDigest' IS DISTINCT FROM encode(sha256(convert_to(NEW.content, 'UTF8')), 'hex') THEN
    RAISE EXCEPTION 'CCC_PLANNING_ARTIFACT_DIGEST_MISMATCH: %', NEW.key USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO anchor FROM project.ccc_planning_runs r
   WHERE r.project_id = NEW.project_id AND r.planning_task_id = NEW.task_id
   FOR SHARE;
  IF NOT FOUND OR anchor.run_id IS DISTINCT FROM envelope->>'runId'
     OR (envelope->>'runRevision')::integer <> anchor.revision THEN
    RAISE EXCEPTION 'CCC_PLANNING_ARTIFACT_RUN_MISMATCH: % does not belong to the current revision of the run on task %',
      NEW.key, NEW.task_id USING ERRCODE = 'P0001';
  END IF;

  fence := envelope->'fence';
  IF fence->>'kind' = 'admission' THEN
    IF stage <> 'admission' OR anchor.state <> 'admitted' THEN
      RAISE EXCEPTION 'CCC_PLANNING_ARTIFACT_FENCE_REFUSED: % admission fence', NEW.key USING ERRCODE = 'P0001';
    END IF;
  ELSIF fence->>'kind' = 'work_item_lease' THEN
    IF stage IN ('admission', 'operator', 'g7', 'g8') OR fence->>'runId' IS DISTINCT FROM anchor.run_id
       OR NOT EXISTS (
         SELECT 1 FROM project.workflow_work_items w
          WHERE w.project_id = NEW.project_id AND w.id = fence->>'workItemId'
            AND w.task_id = NEW.task_id AND w.run_id = fence->>'runId' AND w.state = 'running'
            AND w.lease_owner = fence->>'leaseOwner' AND w.attempt = (fence->>'attempt')::integer
            AND w.lease_expires_at IS NOT NULL AND w.lease_expires_at::timestamptz > clock_timestamp()) THEN
      RAISE EXCEPTION 'CCC_PLANNING_ARTIFACT_FENCE_REFUSED: % work item lease', NEW.key USING ERRCODE = 'P0001';
    END IF;
  ELSIF fence->>'kind' = 'campaign_work_item_lease' THEN
    IF stage NOT IN ('g7', 'g8') OR anchor.import_id IS NULL
       OR anchor.state NOT IN ('building', 'awaiting_execution_authority')
       OR fence->>'runId' IS DISTINCT FROM ('ccc-prd:' || anchor.import_id)
       OR NOT EXISTS (
         SELECT 1 FROM project.workflow_work_items w
          WHERE w.project_id = NEW.project_id AND w.id = fence->>'workItemId'
            AND w.run_id = fence->>'runId' AND w.state = 'running'
            AND w.lease_owner = fence->>'leaseOwner' AND w.attempt = (fence->>'attempt')::integer
            AND w.lease_expires_at IS NOT NULL AND w.lease_expires_at::timestamptz > clock_timestamp()) THEN
      RAISE EXCEPTION 'CCC_PLANNING_ARTIFACT_FENCE_REFUSED: % campaign work item lease', NEW.key USING ERRCODE = 'P0001';
    END IF;
  ELSIF fence->>'kind' = 'operator' THEN
    IF stage <> 'operator'
       OR envelope->>'kind' NOT IN ('operator_answer', 'build_grant', 'budget_amendment')
       OR coalesce(fence->>'runRevision', '') !~ '^[1-9][0-9]{0,2}$'
       OR coalesce(fence->>'controlSeq', '') !~ '^[0-9]{1,9}$'
       OR (fence->>'runRevision')::integer <> anchor.revision
       OR (fence->>'controlSeq')::integer <> anchor.control_seq THEN
      RAISE EXCEPTION 'CCC_PLANNING_ARTIFACT_FENCE_REFUSED: % operator fence', NEW.key USING ERRCODE = 'P0001';
    END IF;
  ELSE
    RAISE EXCEPTION 'CCC_PLANNING_ARTIFACT_FENCE_REFUSED: % unknown fence kind', NEW.key USING ERRCODE = 'P0001';
  END IF;

  FOR input_ref IN SELECT value FROM jsonb_array_elements(envelope->'inputs') LOOP
    IF NOT EXISTS (
      SELECT 1 FROM project.task_documents d
       WHERE d.project_id = NEW.project_id AND d.task_id = NEW.task_id
         AND d.key LIKE 'cccplan-%' AND d.key = input_ref->>'artifactKey'
         AND d.metadata->>'outputDigest' = input_ref->>'digest') THEN
      RAISE EXCEPTION 'CCC_PLANNING_ARTIFACT_INPUT_UNPUBLISHED: % requires % at %',
        NEW.key, input_ref->>'artifactKey', input_ref->>'digest' USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  IF envelope->>'kind' = 'design_alternative' AND EXISTS (
    WITH RECURSIVE closure(artifact_key) AS (
      SELECT value->>'artifactKey' FROM jsonb_array_elements(envelope->'inputs')
      UNION
      SELECT parent.value->>'artifactKey'
        FROM closure c
        JOIN project.task_documents d
          ON d.project_id = NEW.project_id AND d.task_id = NEW.task_id AND d.key = c.artifact_key
        CROSS JOIN LATERAL jsonb_array_elements(d.metadata->'inputs') AS parent(value)
    )
    SELECT 1 FROM closure c
      JOIN project.task_documents d
        ON d.project_id = NEW.project_id AND d.task_id = NEW.task_id AND d.key = c.artifact_key
     WHERE d.metadata->>'kind' = 'design_alternative'
  ) THEN
    RAISE EXCEPTION 'CCC_PLANNING_DESIGN_SEAL_BROKEN: % may not depend on another design alternative', NEW.key
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

-- BEFORE row triggers fire in name order; 'zz_' runs after project-id assignment.
DROP TRIGGER IF EXISTS zz_ccc_planning_artifact_guard ON project.task_documents;
CREATE TRIGGER zz_ccc_planning_artifact_guard
  BEFORE INSERT OR UPDATE OR DELETE ON project.task_documents
  FOR EACH ROW EXECUTE FUNCTION project.ccc_planning_artifact_guard();
```

There is a consequence for deletion. Deleting a planning task cascades to its documents. The trigger refuses that cascade, and the anchor foreign key restricts it as well. A planning task therefore cannot be hard-deleted. This is the intended backstop for D22. Card A1 changes `cleanupArchivedTasksImpl` (`task-mutation-ops.ts:1496`) to skip tasks that own an anchor row, so archive cleanup never throws.

### 2.6 Artifact envelope (card K1, pure) and artifact ops (card A1, PostgreSQL)

```ts
// packages/core/src/ccc-planning/artifacts.ts (K1)
export const CCC_PLANNING_ARTIFACT_KEY_PREFIX = "cccplan-" as const;
export const CCC_PLANNING_ARTIFACT_ENVELOPE_SCHEMA = "ccc-planning.artifact-envelope.v1" as const;
export const CCC_PLANNING_ARTIFACT_MAX_BYTES = 4 * 1024 * 1024;
export type CccPlanningArtifactKind =
  | "original_request" | "admission_grant" | "authority_receipt" | "tool_fidelity_receipt"
  | "confinement_qualification" | "decision_request" | "operator_answer" | "acceptance_cases"
  | "acceptance_review" | "repository_snapshot" | "research_evidence" | "citation" | "extraction"
  | "extraction_review" | "source_verification" | "design_alternative" | "design_review"
  | "decision_record" | "objection" | "requirement_map" | "final_prd" | "technical_annex" | "task_plan"
  | "routing_plan" | "verifier_bundle" | "verifier_audit" | "oracle_observation" | "oracle_review"
  | "product_review" | "technical_review" | "adjudication" | "model_receipt" | "budget_receipt"
  | "spec_ready" | "build_grant" | "budget_amendment" | "build_transition" | "admission_facts"
  | "packet_manifest" | "sidecar" | "bundle" | "execution_plan" | "authorship_receipt" | "import_intent"
  | "import_receipt" | "live_execution_release" | "task_review" | "final_judgment" | "proof_results" | "invalidation";
export const CCC_PLANNING_STAGE_KINDS: Readonly<Record<CccPlanningStageId, readonly CccPlanningArtifactKind[]>>; // table in 2.4
export type CccPlanningArtifactSlot = Readonly<{ runRevision: number; stageId: CccPlanningStageId; slot: string; version: number }>;
export type CccPlanningArtifactRef = Readonly<{ artifactKey: string; digest: string }>;
export type CccPlanningArtifactStatus = "complete" | "infeasible" | "blocked" | "refused";
export type CccPlanningArtifactProducer = Readonly<{
  kind: "model" | "controller" | "operator";
  roleId: CccPlanningRoleId | "controller" | "operator";
  instanceId: string;              // session or attempt identity; "operator:<controlSeq>" for operator
  attemptRef?: string;             // attemptKey of the call that produced it
  requestedModel?: CccPlanningExactModelId;  // required when kind === "model"
  resolvedModel?: string;          // from the terminal route receipt; required when kind === "model"
  routeReceiptDigest?: string;     // required when kind === "model"
}>;
export type CccPlanningArtifactPolicy = Readonly<{
  promptVersion: string; promptDigest: string;           // "none" for controller and operator
  toolPolicyVersion: string; toolPolicyDigest: string;   // "none" for controller and operator
}>;
export type CccPlanningPublicationFence =
  | Readonly<{ kind: "admission" }>
  | Readonly<{ kind: "work_item_lease"; workItemId: string; leaseOwner: string; attempt: number; runId: string }>
  | Readonly<{ kind: "campaign_work_item_lease"; workItemId: string; leaseOwner: string; attempt: number; runId: `ccc-prd:${string}` }>
  | Readonly<{ kind: "operator"; runRevision: number; controlSeq: number }>;
export type CccPlanningArtifactEnvelopeV1 = Readonly<{
  schema: typeof CCC_PLANNING_ARTIFACT_ENVELOPE_SCHEMA;
  artifactKey: string; runId: string; runRevision: number; stageId: CccPlanningStageId; slot: string; version: number;
  kind: CccPlanningArtifactKind;
  contentType: "application/json" | "text/markdown; charset=utf-8";
  contentSchema: string;                         // e.g. "ccc-planning.requirement-map.v1"
  inputs: readonly CccPlanningArtifactRef[];     // sorted by artifactKey, unique
  producer: CccPlanningArtifactProducer;
  policy: CccPlanningArtifactPolicy;
  outputDigest: string;                          // sha256 of stored content UTF-8 bytes
  status: CccPlanningArtifactStatus;
  fence: CccPlanningPublicationFence;
  identityDigest: string;                        // sha256(canonical(envelope minus fence, publishedAt, identityDigest))
  publishedAt: string;
}>;
export type CccPlanningArtifactContent =
  | Readonly<{ type: "json"; value: unknown }>          // stored as canonicalCccPrdJson(value)
  | Readonly<{ type: "text"; bytes: Uint8Array }>;      // must be valid UTF-8
export function encodeCccPlanningArtifactKey(slot: CccPlanningArtifactSlot): string;
export function decodeCccPlanningArtifactKey(key: string): CccPlanningArtifactSlot | null;   // right-to-left
export function encodeCccPlanningArtifactContent(content: CccPlanningArtifactContent):
  Readonly<{ text: string; outputDigest: string; contentType: CccPlanningArtifactEnvelopeV1["contentType"] }>;
export function computeCccPlanningEnvelopeIdentityDigest(
  envelope: Omit<CccPlanningArtifactEnvelopeV1, "fence" | "publishedAt" | "identityDigest">): string;
export function computeCccPlanningClosureDigest(closure: readonly CccPlanningArtifactRef[]): string; // sha256(canonical(sorted unique refs))
// Canonical-JSON encoding failures (undefined values, non-plain objects) in these functions refuse as
// CccPlanningRefusal("CCC_PLANNING_ARTIFACT_ENVELOPE_INVALID"), never a plain Error (E1-13); computeCccPlanningClosureDigest
// maps them the same way, for example a ref whose digest is undefined (E2-44).

// packages/core/src/task-store/ccc-planning-artifact-ops.ts (A1)
export type PublishCccPlanningArtifactInput = Readonly<{
  planningTaskId: string; runId: string; slot: CccPlanningArtifactSlot; kind: CccPlanningArtifactKind;
  contentSchema: string; content: CccPlanningArtifactContent; inputs: readonly CccPlanningArtifactRef[];
  producer: CccPlanningArtifactProducer; policy: CccPlanningArtifactPolicy; status: CccPlanningArtifactStatus;
  fence: CccPlanningPublicationFence; now?: string;
}>;
export type CccPlanningArtifactRecord = Readonly<{ id: string; key: string; envelope: CccPlanningArtifactEnvelopeV1; replayed: boolean }>;
export async function publishCccPlanningArtifact(layer: AsyncDataLayer, input: PublishCccPlanningArtifactInput): Promise<CccPlanningArtifactRecord>;
export async function publishCccPlanningArtifactWithinTransaction(tx: DbTransaction, projectId: string, input: PublishCccPlanningArtifactInput): Promise<CccPlanningArtifactRecord>;
export async function readCccPlanningArtifact(layer: AsyncDataLayer, planningTaskId: string, key: string,
  options?: Readonly<{ expectedDigest?: string }>): Promise<Readonly<{ record: CccPlanningArtifactRecord; text: string }> | null>;
export async function listCccPlanningArtifacts(layer: AsyncDataLayer, planningTaskId: string): Promise<readonly CccPlanningArtifactRecord[]>;
export async function resolveCccPlanningInputClosure(layer: AsyncDataLayer, planningTaskId: string,
  roots: readonly CccPlanningArtifactRef[]): Promise<readonly CccPlanningArtifactRef[]>;
```

Publication runs these steps in order, in one transaction:
1. Validate and encode the content.
2. Lock the task row `FOR UPDATE`.
3. Lock the fence's work item `FOR UPDATE`, using the predicate from `workflow-workitems-ops-2.ts:405-418`.
4. If the key already exists, replay when the `identityDigest` is the same, or throw `SLOT_CONFLICT` when it differs. A `23505` from a concurrent publish is re-read and mapped the same way.
5. Verify the inputs.
6. Run `set_config('fusion.ccc_planning_publication','on', true)`.
7. Insert `{key, content, revision: 1, author: 'ccc-planning:'+roleId, metadata: envelope}`.
8. Reset the GUC to `''`.
9. Write the audit event `ccc-planning:artifact-published` with a deterministic `eventId` (D39; a replay returns the persisted event, a different payload throws `RunAuditEventCollisionError`).

Publication emits no `task:updated` event and does no citation scan.

### 2.7 Role policy FULL-v2 (card K1)

| Role | Exact model | Family | Class | Stage | Phase | Reviewed by (other family) | N counting |
|---|---|---|---|---|---|---|---|
| intent-assessor | `glm/glm-5.3` | glm | author | intent | planning | acceptance-reviewer | fixed |
| acceptance-reviewer | `minimax/MiniMax-M3` | minimax | critic | intent | planning | is the review | fixed |
| researcher | `minimax/MiniMax-M3` | minimax | researcher | research | planning | source-verifier | fixed |
| extraction-leaf | `glm/glm-5.3-flash` | glm | researcher | research | planning | leaf-reviewer | per leaf (L) |
| leaf-reviewer | `minimax/MiniMax-M3` | minimax | critic | research | planning | is the review (one batched instance) | once if L > 0 |
| source-verifier | `glm/glm-5.3` | glm | researcher | research | planning | is the review | fixed |
| designer-a | `minimax/MiniMax-M3` | minimax | author | design | planning | design-a-reviewer | fixed |
| designer-b | `glm/glm-5.3` | glm | author | design | planning | design-b-reviewer | fixed |
| design-a-reviewer | `glm/glm-5.3` | glm | critic | design-review | planning | is the review | fixed |
| design-b-reviewer | `minimax/MiniMax-M3` | minimax | critic | design-review | planning | is the review | fixed |
| spec-author | `glm/glm-5.3` | glm | author | spec | planning | product-adversary | fixed |
| execution-planner | `glm/glm-5.3` | glm | author | plan | planning | technical-critic | fixed |
| verifier-author | `glm/glm-5.3` | glm | writer | verifier | planning | verifier-auditor | fixed |
| verifier-auditor | `minimax/MiniMax-M3` | minimax | critic | verifier | planning | is the review | fixed |
| product-adversary | `minimax/MiniMax-M3` | minimax | critic | review | planning | is the review | fixed |
| technical-critic | `minimax/MiniMax-M3` | minimax | critic | review | planning | is the review | fixed |
| preflight-writer | `glm/glm-5.3-flash` | glm | writer | preflight | planning | none (qualification) | probe, not in N |
| preflight-critic | `minimax/MiniMax-M3` | minimax | critic | preflight | planning | none (qualification) | probe, not in N |
| preflight-researcher | `minimax/MiniMax-M3` | minimax | researcher | preflight | planning | none (qualification) | probe, not in N |
| implementation-writer | `glm/glm-5.3-flash` | glm | writer | (campaign) | implementation | task-reviewer | per task (T) |
| task-reviewer (G7) | `minimax/MiniMax-M3` | minimax | critic | g7 | review_proof | is the review | per task (T) |
| final-judge (G8) | `minimax/MiniMax-M3` | minimax | critic | g8 | review_proof | is the review | once |

- The 14 fixed planning roles are the 14 planning nodes when L = 0.
- **Preflight qualification lineages** (0.10, D29). The `preflight` stage runs three lineages in order, each one session and one node attempt, never retried automatically:
  - `preflight:writer` (role `preflight-writer`, Flash): identity, strict-echo, exact-edit. Its confined shell and write root is a controller-created scratch repository `$TMPDIR/ccc-plan-<24hex>/preflight-writer/` (`git init`, one seeded file), qualified by G0's confinement probe; no target worktree is touched.
  - `preflight:critic` (role `preflight-critic`, M3): identity, strict-echo, verdict-shape.
  - `preflight:researcher` (role `preflight-researcher`, M3): identity, strict-echo, citation-read on seeded citation fixtures. Its `ccc_research_fetch` tool is present (so the toolset matches the role class) but bound to a grant port that refuses every reserve with `probe-mode`, so no fetch grant is spent and nothing leaves the host.
  - Each probe is one prompt and one model call in the lineage's session, so a lineage uses dispatch keys `pi-stream:1..3`. In probe mode **every tool offered in the session** is wrapped by C2's `wrapCccProbedTool`, including the probed ones: `ccc_probe_echo` (identity, strict-echo), the writer's `edit` (exact-edit), the critic's `ccc_submit_verdict` (verdict-shape) and the researcher's `ccc_citation_read` (citation-read). The wrapper runs the tool, records the observation and aborts the turn, so a tool result never triggers a follow-up call. v2 wrapped only `ccc_probe_echo`, so a result from any other tool made Pi issue a 4th call and the cap refused every healthy route (verify-v2 item 39). L1's cap of 3 calls per preflight attempt (one turn key, `CCC_PLANNING_PREFLIGHT_MAX_CALLS_PER_ATTEMPT`) is a backstop only. The automatic path is one attempt per lineage, so 9 calls in total.
  - Probe tool policy = the role class's toolset plus `ccc_probe_echo`, every tool wrapped as above. The `tool_fidelity_receipt` records both the probe toolset digest and the role toolset digest.
  - Every probe call is a reserved planning call with `preflight: true` in its metadata, spent against `planning_spent` in state `running`, and reported separately as `preflightSpent`.
- Invariant (unit test in K1): every reviewer's family differs from the family of the role it reviews. Probe roles have `reviewedBy: null` and are excluded from the invariant by `counting: "probe"`.

```ts
// packages/core/src/ccc-planning/types.ts and policy.ts (K1)
export type CccPlanningRoleClass = "author" | "researcher" | "critic" | "writer";
export type CccPlanningExactModelId = "glm/glm-5.3" | "glm/glm-5.3-flash" | "minimax/MiniMax-M3";
export type CccModelFamily = "glm" | "minimax";
export type CccPlanningRoleId =
  | "intent-assessor" | "acceptance-reviewer" | "researcher" | "extraction-leaf" | "leaf-reviewer"
  | "source-verifier" | "designer-a" | "designer-b" | "design-a-reviewer" | "design-b-reviewer"
  | "spec-author" | "execution-planner" | "verifier-author" | "verifier-auditor" | "product-adversary"
  | "technical-critic" | "preflight-writer" | "preflight-critic" | "preflight-researcher"
  | "implementation-writer" | "task-reviewer" | "final-judge";
export type CccPlanningRoleSpec = Readonly<{
  roleId: CccPlanningRoleId; modelId: CccPlanningExactModelId; family: CccModelFamily; roleClass: CccPlanningRoleClass;
  stageId: CccPlanningStageId | "campaign"; phase: "planning" | "implementation" | "review_proof";
  reviewedBy: CccPlanningRoleId | null; counting: "fixed" | "per-leaf" | "once-if-leaves" | "per-task" | "once" | "probe";
}>;
export const CCC_PLANNING_ROLE_POLICY_FULL_V2: Readonly<{ policyId: "ccc-planning.role-policy.full-v2"; roles: readonly CccPlanningRoleSpec[] }>;
export const CCC_PLANNING_MODEL_FAMILIES: Readonly<Record<CccPlanningExactModelId, CccModelFamily>> = {
  "glm/glm-5.3": "glm", "glm/glm-5.3-flash": "glm", "minimax/MiniMax-M3": "minimax" };
export const CCC_PLANNING_TOOLSETS: Readonly<Record<CccPlanningRoleClass, readonly string[]>> = {
  author: ["ccc_submit_artifact", "find", "grep", "ls", "read"],
  researcher: ["ccc_citation_read", "ccc_research_fetch", "ccc_submit_artifact", "find", "grep", "ls", "read"],
  critic: ["ccc_submit_verdict", "find", "grep", "ls", "read"],
  writer: ["bash", "edit", "find", "grep", "ls", "read", "write"],
};   // "grep" is always the Fusion-owned confined grep (D11), never Pi's
export const CCC_PLANNING_LINKED_WRITER_TOOLSET = ["bash", "edit", "find", "fn_complete_phase", "grep", "ls", "read", "write"] as const;
  // planning-linked implementation writers only (D11, verify-v2 item 37). fn_complete_phase is the campaign ready tool
  // (ccc-campaign-ready.ts:883-900) the writer must call (executor.ts:18861-18869, 19267). The preflight writer keeps
  // CCC_PLANNING_TOOLSETS.writer.
export const CCC_PLANNING_PROBE_TOOL = "ccc_probe_echo" as const;
export const CCC_PLANNING_PREFLIGHT_LINEAGES = [
  { lineageId: "preflight:writer", roleId: "preflight-writer", probes: ["identity", "strict-echo", "exact-edit"] },
  { lineageId: "preflight:critic", roleId: "preflight-critic", probes: ["identity", "strict-echo", "verdict-shape"] },
  { lineageId: "preflight:researcher", roleId: "preflight-researcher", probes: ["identity", "strict-echo", "citation-read"] },
] as const;
export const CCC_PLANNING_DENIED_NAMES = [".agentsecrets", ".env", ".env.*", ".envrc", ".npmrc", "_secrets"] as const;
  // ".envrc" added by E2-42. Owned paths and write roots refuse any segment equal (folded, E2-40; E2-40a through K1b, E4-K) to an entry (E2-42)
export type CccModelIdentityReason =
  | "excluded-model" | "floating-alias" | "combo-route" | "unqualified-id" | "not-in-pin-registry";
/** Classification order is frozen: 1 exact pin admits; 2 any glm-5.2 form ("glm-5.2", "*/glm-5.2", "glm/glm-5.2-*")
 *  -> excluded-model; 3 suffix -latest, :latest or @latest -> floating-alias; 4 prefix "combo/" -> combo-route;
 *  5 no "/" -> unqualified-id; 6 anything else -> not-in-pin-registry. Matching is case-sensitive for admission
 *  and case-insensitive for refusal ("glm/GLM-5.3" is not-in-pin-registry). */
export function classifyCccModelIdentity(modelId: string):
  | Readonly<{ admitted: true; modelId: CccPlanningExactModelId; family: CccModelFamily }>
  | Readonly<{ admitted: false; reason: CccModelIdentityReason }>;
export function cccPlanningPolicyDigest(): string; // sha256(canonical({roles, toolsets, linked writer toolset, probe tool, preflight lineages, deniedNames, budget policy, source policy, counters}))
  // Every object that feeds this digest is deep-frozen, including CCC_PLANNING_PREFLIGHT_LINEAGES,
  // CCC_PLANNING_DENIED_NAMES and CCC_PLANNING_SOURCE_POLICY_I2: a mutation attempt throws in strict mode (E2-45)
```

Route admission (K2, `packages/core/src/ccc-campaign/route-admission.ts`) is ADR C's `admitCccRequestToCodeRoutes`, with two changes. First, `routes` is `readonly (CccCampaignProductRoute | CccPlanningReviewIdentity)[]`, where `CccPlanningReviewIdentity = Readonly<{ taskId: string; routeKind: "g7-review" | "g8-judge"; reviewOfTaskId: string | null; providerId: string; modelId: string; transport: "pi"; receiptAdapterId: "terminal-route-sse-comments.v1" }>`. Second, `CccCampaignReviewRoute` is **not** added to `ccc-campaign/types.ts`. The reasons are the five identity reasons plus `role-model-mismatch`, `provider-not-pinned`, `receipt-adapter-required`, `transport-not-pi` and `same-family-review`. It is called only by the import bridge for planning-linked imports.

K2's repair 1 (E5-K2) fixes three more route-admission rules:
- Route-kind allowlist (item 3): in `reasonFor`, the G8 branch is `else if (route.routeKind === "g8-judge")`, and any other kind returns `role-model-mismatch`.
- One provider per model (item 6): pins that give two models the same `providerId` are refused with `provider-not-pinned`.
- Accepted round-1 deviations, no change (item 8): `CccCampaignProductRoute` is an alias of `CccCampaignProductExecutionRoute`, and `CccRouteRole` has no G8 value.

K2's repair 2 (E7-K item 5) adds one more:
- Review identity by exact shape: `route-admission.ts` never decides that a route is a review identity from `hasOwnProperty("routeKind")`. A route counts as a review identity only when its own keys are exactly the seven keys of K2's own `CccPlanningReviewIdentity` (`route-admission.ts`, the shape above), not a `canonical.ts` shape (E8-0, N-4, correcting E7-K 5's wording). A route that carries product-route keys plus `routeKind` (probe F4) is neither a product route nor a review identity: K2 refuses it with `CCC_ROUTE_IDENTITY_REJECTED`, reason `role-model-mismatch` (K2's actual choice, accepted by N-4), and the import bridge reports any such refusal as `CCC_PLANNING_ROUTE_NOT_ADMITTED` (IB2, section 2.17 step 3). K2's tests pin the review-of-review row too (K2 card, E7-K 5).

K2 was accepted at repair 2 (E8) with three recorded residuals, none fixed:
- `certificateApplies` trusts the array prototype: a hand-built in-memory array with an own `includes`, or a sparse array, can pass. Data parsed from JSON cannot take either form, so this is unreachable through the qualification port; the I6 port that feeds real certificates parses JSON (section 6 risk 55).
- G8 identities never call `roleOf`, so a G8 identity whose `taskId` is a writer or a G7 review id is admitted. IB2 obligation: the import bridge builds a G8 identity only for the judge task. When `CccRouteRole` gains a G8 role, K2's admission refuses a G8 identity whose graph role is writer or g7-review (section 6 risk 56; IB2 rule).
- The deadline row is pinned at 1 ms, not at the 1 µs timestamp resolution.

### 2.8 Budget profiles, fit rule and N counting (card K1)

```ts
// packages/core/src/ccc-planning/budget-fit.ts (K1)
export const CCC_PLANNING_BUDGET_POLICY_V1 = {
  policyVersion: "ccc-planning.budget-policy.v1",
  profiles: {
    "spec:standard":  { total: 1536,  planning: 1536, implementation: 0,     reviewProof: 0,    deadlineMs: 43_200_000 },
    "build:standard": { total: 6144,  planning: 1536, implementation: 3072,  reviewProof: 1536, deadlineMs: 172_800_000 },
    "spec:large":     { total: 6144,  planning: 6144, implementation: 0,     reviewProof: 0,    deadlineMs: 172_800_000 },
    "build:large":    { total: 24576, planning: 6144, implementation: 12288, reviewProof: 6144, deadlineMs: 604_800_000 },
  },
  research: { maxFetchesPerNode: 8, maxFetchesPerRun: 24, maxRawBytesPerFetch: 1_048_576, maxRawBytesPerRun: 16_777_216 },
  floor: { perNodeCalls: 30, fixedCalls: 300, multiplier: 2 },   // the fixed 300 also covers the 9 preflight calls
  watchdogMs: { planningSessionAttempt: 1_800_000, reviewSessionAttempt: 1_800_000, writerAttempt: 3_600_000, heavyCheck: 1_200_000 },
  estimateMs: { preflightLineage: 600_000, planningNode: 600_000, reviewNode: 600_000, writer: 3_600_000, heavyCheck: 1_200_000 },
} as const;
export type CccPlanningBudgetPolicy = typeof CCC_PLANNING_BUDGET_POLICY_V1;
export function cccPlanningCallFloor(nodes: number): number;      // 2 * (30 * nodes + 300)
export function cccPlanningMaxNodes(allocation: number): number;  // max(0, floor((allocation / 2 - 300) / 30))
export function countCccPlanningNodes(i: Readonly<{ leaves: number }>): number;  // 14 + L + (L > 0 ? 1 : 0)
export function countCccBuildNodes(i: Readonly<{ providerTasks: number; modelProofNodes: number }>):
  Readonly<{ implementation: number; reviewProof: number }>;     // { T, T + 1 + P }
export type CccFitShortfall = Readonly<{ dimension: "planning-calls" | "implementation-calls" | "review-proof-calls" | "time";
  required: number; remaining: number }>;
export function assessCccPlanningFit(i: Readonly<{ leaves: number; remainingPlanning: number;
  criticalPathMs: number; remainingDeadlineMs: number }>):
  Readonly<{ ok: true; nodes: number; floor: number }> | Readonly<{ ok: false; code: "CCC_PLANNING_PLANNING_FIT_INSUFFICIENT"; shortfalls: readonly CccFitShortfall[] }>;
export function assessCccBuildFit(i: Readonly<{ providerTasks: number; modelProofNodes: number; campaignCriticalPathMs: number;
  remainingImplementation: number; remainingReviewProof: number; remainingDeadlineMs: number; maxDurationMs: number }>):
  Readonly<{ ok: true }> | Readonly<{ ok: false; code: "CCC_PLANNING_BUILD_FIT_INSUFFICIENT"; shortfalls: readonly CccFitShortfall[] }>;
  // time: 2 * campaignCriticalPathMs <= min(remainingDeadlineMs, maxDurationMs)
  // E1-9, E4-14: assessCccPlanningFit and assessCccBuildFit accept any finite remaining time and maxDurationMs (fractions
  // floored). A value that is zero, negative, or floors below the requirement returns
  // { ok: false, …, shortfalls: [{ dimension: "time", … }] } and never throws; a sufficient fractional value is admitted.
  // criticalPathMs stays non-negative.
export function assessCccRepairChunkFit(i: Readonly<{ phase: "planning" | "review_proof"; repairNodes: number; remaining: number }>): boolean;
  // remaining >= cccPlanningCallFloor(repairNodes) - 600, i.e. 2 * 30 * repairNodes; the fixed 300 is not charged again.
  // The caller passes repairNodes = the chunk's author repair lineages + its new review nodes (D13); K1's code is unchanged.
/** Sequential model at maxConcurrency 1 (I2): no two sessions overlap, including "parallel" reviewers in one stage. */
export function cccPlanningCriticalPathMs(i: Readonly<{ mode: "spec" | "build"; providerTasks: number; maxConcurrency: 1 }>):
  Readonly<{ planningMs: number; campaignMs: number; totalMs: number }>;
  // planningMs = 3*preflightLineage + 14*planningNode + 1*heavyCheck (G5 oracle run)
  // build adds: 1*heavyCheck (baseline, preflight, import) + campaignMs, where
  // campaignMs = T*(writer + heavyCheck + reviewNode) + heavyCheck (integration) + reviewNode (G8)
```

- **Fit rule.**
  - Calls: `allocation_remaining ≥ 2 · (30 · N + 300)`.
  - Time at G0: `2 · planningMs ≤ deadline − db_now`. T is not known at G0, so the Build part waits for G6.
  - Time at G6 (Build): `2 · campaignCriticalPathMs ≤ min(deadline − db_now, maxDurationMs)`, where `campaignCriticalPathMs` comes from GG's schedule simulation of the real graph. For the I2 diamond it equals the formula value 23,400,000.
  - The call check runs at G0, at leaf admission, before every repair chunk (call fit only, `assessCccRepairChunkFit`), and at G6 for the implementation and review/proof phases. A failure refuses with exact shortfalls and reserves nothing.
- **N counting (strict).**
  - Planning `N = 14 + L + [L > 0]`. The preflight lineages are not nodes; their 9 automatic calls (3 lineages x 1 attempt x 3 calls) are inside the fixed +300 term and shown as `preflightSpent`.
  - `N_impl = T`, the provider tasks in the compiled graph.
  - `N_rev = T + 1 + P`, where P is model proof or audit nodes in Build (P = 0 in I2).
  - Repairs are not in N.
- **Large.** Build Large's implementation allocation (12,288) exceeds the importer ceiling, so it is clamped to 10,000 and the clamp is recorded (D16). Large requires `receipt.largeAuthorized === true`.

### 2.9 Counters and constants (card K1)

```ts
export const CCC_PLANNING_MAX_CALLS_PER_ATTEMPT = 11 as const;            // 1 initial + 10 feedback-processing calls
export const CCC_PLANNING_MAX_DISPATCH_ATTEMPTS_PER_LINEAGE = 3 as const; // counted at first reservation of a turn key
export const CCC_PLANNING_PREFLIGHT_MAX_CALLS_PER_ATTEMPT = 3 as const;   // per preflight attempt (turn key): one call per probe; backstop for probe abort
export const CCC_PLANNING_MAX_REPAIR_CHUNKS = 4 as const;                 // one global epoch, shared planning + coding
export const CCC_PLANNING_MAX_REPAIR_EPOCHS = 1 as const;
export const CCC_PLANNING_STAGNATION_EPOCHS = 2 as const;                 // stop after 2 consecutive non-improving epochs
export const CCC_PLANNING_LAUNCH_HEADROOM_MS = 30_000 as const;
export const CCC_PLANNING_AUDIT_STRING_MAX = 256 as const;
export const CCC_PRD_IMPORT_MAX_REQUESTS = 10_000 as const;               // mirrors import-admission.ts:88-102
export const CCC_PRD_IMPORT_MAX_DURATION_MS = 86_400_000 as const;        // mirrors import-admission.ts:88-102
export const CCC_PLANNING_I2_MAX_CONCURRENCY = 1 as const;
export const CCC_PLANNING_SOURCE_POLICY_I2 = {
  policyId: "ccc-planning.source-policy.i2.v1",
  allow: [
    { host: "nodejs.org", pathPrefix: "/docs/latest-v24.x/api/" },
    { host: "developer.mozilla.org", pathPrefix: "/en-US/docs/Web/JavaScript/" },
  ],
  maxFetchesPerNode: 8, maxFetchesPerRun: 24, maxRawBytesPerFetch: 1_048_576, maxRawBytesPerRun: 16_777_216,
  timeoutMs: 20_000, maxRedirects: 3, mimeTypes: ["text/html", "text/plain", "text/markdown", "application/json"],
} as const;   // policySha256 = sha256(canonical(this object)); must equal receipt.sourceToolPolicy.sha256
```

Counting rules, enforced in L1 (planning) and BF (linked writers) inside the dispatch transaction:
- **Iteration cap.** A node attempt is one `turnKey`. It may have at most 11 reservations, with dispatch keys `pi-stream:1..11` (the slot counter starts at 1, `pi.ts:820`). Tool-only work never reserves.
- **Dispatch cap.** For lineage L, `dispatchAttempts(L)` is the inherited count from L's `lineage:created` event plus the number of distinct turn keys reserved with lineage L. Attempt 4 is refused (`dispatch-cap`).
- **Repair and review counting (D13, leader ruling: the caps compose).** Claiming repair chunk k writes one `lineage:created` for each lineage it opens:
  - for each repairing **author**, `repair:k:<roleId>` with `kind: "author-repair"` and `inheritedDispatchAttempts` = the author's latest lineage count. An author that used 1 attempt can repair in at most 2 chunks (1 + 2). A claim that names an author with no attempt left is refused `DISPATCH_CAP` and writes nothing;
  - for each **critic** that reviews the new candidate version, a review node `<stageId>:<roleId>:rv<k>` with `kind: "review-node"`, the reviewer's `parentLineageId` and `inheritedDispatchAttempts: 0`. A fresh review of a new version never inherits, so re-reviews do not exhaust a critic; retrying the same review of the same version counts against that node's 3;
  - the one epoch of 4 chunks is the global bound across all lineages.
- **Preflight lineages.** At most 3 calls per preflight attempt (turn key) and one automatic attempt per lineage, so 9 calls automatically. An operator resume from `blocked_provider` re-runs the preflight as each lineage's next attempt, inside the normal 3-attempt cap, so the worst case is 3 x 3 x 3 = 27 calls, each one charged and shown in `preflightSpent`.
- **Linked writers (BF).** Each dispatch attempt of a semantic task has its own derived turn key `cccPlanningLinkedWriterTurnKey({baseTurnKey, dispatchAttemptOrdinal})` and its own 11-call bucket. At most 3 attempts per semantic task. Calls are recorded per attempt. The attempt comes from the graph executor's retry index (`nodeAttemptOrdinal`, WR, verify-v2 item 18).
- **Unreconciled dispatch.** While any attempt of lineage L is `dispatched_unknown`, new reservations in L are refused. Other lineages proceed.
- **Control pending.** A non-null `control_request` refuses every new planning and review/proof reservation, and the trigger backs this up. After the link the only value ever set is `cancel` (CB, D32); while it is set, BF refuses linked writer reservations with `control-pending`. Linked writers are otherwise gated by run state (`run-not-building`) and the run deadline (`deadline`).
- **Research fetches.** A reservation needs no unsettled fetch in the run, `fetch_spent < allocation`, fewer than 8 fetches for the node attempt, and `bytes_spent + maxRawBytesPerFetch ≤ bytes_allocation`. Settlement adds the actual raw bytes (at most 1 MiB).

### 2.10 Core planning types (card K1)

```ts
// packages/core/src/ccc-planning/types.ts (K1)
export type CccPlanningMode = "spec" | "build";
export type CccPlanningBudgetProfile = "standard" | "large";
export type CccPlanningRoleProfile = "full-v2" | "adaptive-v2" | "lean-v2";  // only "full-v2" admitted in I1-I2
export type CccPlanningPhase = "planning" | "implementation" | "review_proof";
/** Reviewer verdicts are core types (verify-v2 item 34): core schemas (CccPlanningObjectionV1.ref) and the engine
 *  (C2's verdict tool, H1's session) both use them, and core cannot import engine. */
export type CccReviewFindingRef =
  | Readonly<{ kind: "requirement"; requirementId: string }>
  | Readonly<{ kind: "source"; artifactKey: string; quote?: string }>
  | Readonly<{ kind: "artifact"; artifactKey: string }>
  | Readonly<{ kind: "counterexample"; text: string }>;     // at most 600 characters
export type CccReviewVerdict = Readonly<{
  verdict: "accept" | "reject";
  findings: readonly Readonly<{ ref: CccReviewFindingRef; severity: "blocking" | "advisory"; path?: string; line?: number; summary: string }>[];
}>;
export type CccPlanningGrantV1 = Readonly<{
  schema: "ccc-planning.grant.v1"; mode: CccPlanningMode; budgetProfile: CccPlanningBudgetProfile;
  budgetPolicyVersion: string; allocations: Readonly<{ planning: number; implementation: number; reviewProof: number }>;
  research: Readonly<{ fetches: number; bytes: number }>; deadlineAt: string; sourcePolicyId: string; amendmentSeq: number;
}>;
export type CccPlanningRunCustody = Readonly<{
  kind: "planning"; projectId: string; runId: string; planningTaskId: string; revision: number;
  state: CccPlanningRunState; mode: CccPlanningMode; budgetProfile: CccPlanningBudgetProfile;
  deadlineAt: string; grantDigest: string; controlSeq: number; importId: string | null;
  runtimeDistManifestSha256: string;
}>;
/** Ledger and artifact fence. "planning" is the planning work item; "campaign" is a planning-linked campaign item (G7/G8). */
export type CccPlanningWorkItemFence = Readonly<{
  kind: "planning" | "campaign"; workItemId: string; runId: string; attempt: number; leaseOwner: string; originTaskId: string;
}>;
export type CccPlanningReadSnapshot =
  | Readonly<{ kind: "admitted-base" }>
  | Readonly<{ kind: "candidate"; commit: string; tree: string }>;   // from ccc:proof:source-commit / source-tree
export type CccPlanningRouteBinding = Readonly<{
  kind: "ccc-planning-route.v1";
  projectId: string; runId: string; runRevision: number; taskId: string;    // taskId = planning task id, always
  stageId: CccPlanningStageId; roleId: CccPlanningRoleId; roleClass: CccPlanningRoleClass;
  lineageId: string; nodeAttemptOrdinal: 1 | 2 | 3; phase: "planning" | "review_proof";
  providerId: string; modelId: CccPlanningExactModelId; transport: "pi";
  receiptAdapterId: "terminal-route-sse-comments.v1";
  toolsetDigest: string; promptDigest: string; policyDigest: string; grantDigest: string;
  bindingHash: string;                                                     // cccPlanningBindingHash(all other fields)
}>;
/** Planning scope reuses the campaign scope's field names (ADR A); only binding and fence differ. */
export type CccPlanningCallScope = Readonly<Omit<CccProviderAttemptScope, "binding" | "workItemFence"> & {
  workItemFence: CccCampaignWorkItemFence;   // 3-key {workItemId, runId, attempt} of the fence
  binding: CccPlanningRouteBinding;
}>;
// Field semantics: semanticTaskId = binding.lineageId; campaignDeadlineAt = run deadline_at; taskId = planning task;
// attemptOrdinal = call ordinal within the turn (1..11); requestCount = phase spent after the CAS.
export type CccPlanningCallRequest = Readonly<{
  binding: CccPlanningRouteBinding; turnKey: string; dispatchKey: string;   // "pi-stream:N", N in 1..11
  fence: CccPlanningWorkItemFence; preflight: boolean;
}>;
export type CccPlanningRunStatusV1 = Readonly<{
  schema: "ccc-planning.run-status.v1";
  runId: string; projectId: string; planningTaskId: string; mode: CccPlanningMode;
  budgetProfile: CccPlanningBudgetProfile; roleProfile: CccPlanningRoleProfile;
  state: CccPlanningRunState; stateCode: string | null; revision: number; controlSeq: number; deadlineAt: string;
  pendingControl: null | Readonly<{ request: "pause" | "cancel" | "resume"; revision: number; requestedAt: string }>;
  lastControl: null | Readonly<{ request: "pause" | "cancel" | "resume"; controlSeq: number; actor: string; at: string;
    route: "planning" | "campaign-bridge"; outcome: "applied" | "pending" }>;
    // E5-L1 item 12: L1 never produces "deferred-leased" and drops it from its own outcome types. E7-0 grants L1 the one
    // line at types.ts:214 (as at INT-2c) that removes the literal from this K1 type; nothing else in types.ts changes
    // (E7-L item 10). A deferred cancellation still reports the cancel as "pending"; this view has no reason field, so
    // the deferral reason lives in the cancel-deferred audit row (E7-L item 4, section 2.1)
  awaitingDecision: null | Readonly<{ decisionId: string; questionArtifactKey: string; questionDigest: string }>;
  budgets: Readonly<{
    planning: Readonly<{ allocation: number; spent: number; preflightSpent: number }>;
    implementation: Readonly<{ allocation: number; transferred: number | null; spent: number | null }>; // spent = ccc_prd_imports.request_count
    reviewProof: Readonly<{ allocation: number; spent: number }>;
    researchFetches: Readonly<{ allocation: number; spent: number }>;
    researchBytes: Readonly<{ allocation: number; spent: number }>;
  }>;
  counters: Readonly<{ repairEpochState: "unopened" | "open" | "closed"; repairChunksUsed: number; reviewEpochs: number; stagnantEpochs: number }>;
  stages: readonly Readonly<{ stageId: CccPlanningIrStageId; status: "pending" | "running" | "committed" | "blocked" | "skipped"; artifactKeys: readonly string[] }>[];
  unreconciled: readonly Readonly<{ lineageId: string; attemptKey: string; dispatchedAt: string }>[];
  writerAttempts: readonly Readonly<{ semanticTaskId: string; dispatchAttemptOrdinal: 1 | 2 | 3; turnKey: string; calls: number }>[];
  import: null | Readonly<{ idempotencyKey: string; intentDigest: string; importId: string | null; importState: string | null }>;
  executionAuthority: null | Readonly<{ authorizationId: string; confirmation: string; command: string }>;
  notRun: readonly string[];
}>;
```

- **Task marker** (K1 `marker.ts`, pure). A planning task has `lineageId === runId`, matching `/^ccc-plan:[0-9a-f]{24}$/`, plus `paused: true` and `userPaused: false`. The marker treats `userPaused !== true` as unpaused, so an absent field counts as `false` (E1-14). The predicate is `isCccPlanningCustodyTask(task)`. The database check, "an anchor row exists for this task", lives in G1's `ccc-planning-custody.ts`. The engine's guard-only predicate `isCccCustodyGuardedTask(task) = isCccCampaignTask(task) || isCccPlanningCustodyTask(task)` (G1) is used only at guard sites; `isCccCampaignTask` is unchanged (D22). Accepted design (E5-G1 item 4): a planning task stays held while its marker is set, even after its run is terminal, and no card releases it yet; triage excludes any `ccc-plan:` lineage. The parent exported `isCccCustodyGuardedTask` from the engine barrel and switched the dashboard guard to it at INT-2d `fcb83879d`; the guard uses `isCccPlanningCustodyTask` only to pick the message (E5-G1 item 6; done, E8).
- **Workflow IR** (K1 `workflow-ir.ts`, pure, 0.23):

```ts
export function buildCccPlanningWorkflowIr(mode: CccPlanningMode): WorkflowIr;   // WorkflowIr from core workflow-ir-types.ts:424;
  // section 2.4 order; every node a gate with config.cccPlanningStage and maxRetries 0; Spec omits "import"
export function cccPlanningWorkflowIrHash(ir: WorkflowIr): string;   // sha256(canonicalCccPrdJson(ir)), the same rule the importer
  // uses for campaign work items (importer.ts:302, 1266-1281); NOT the djb2 hashWorkflowIr (workflow-ir-resolver.ts:49)
```

- **Running-runtime identity** (K1 `runtime-identity.ts`, D44):

```ts
export function registerCccRunningRuntimeDistManifest(sha256: string): void;   // once per process; a different second value throws
export function readCccRunningRuntimeDistManifest(): string | null;
export function assertCccRunningRuntimePermitted(run: Readonly<{ runtimeDistManifestSha256: string }>): void;
  // throws CccPlanningRefusal("CCC_PLANNING_RUNTIME_NOT_PERMITTED") when unregistered or unequal
```

### 2.11 Ledger, control, admission, import link and campaign link (cards L1, AD1, IM1, BF)

```ts
// packages/core/src/task-store/ccc-planning-ops.ts (L1). All functions run in transactionImmediate.
// Every function that takes an `actor` refuses one longer than 200 characters with CCC_PLANNING_INTERNAL_ERROR (E2-4,
// E3-3): defence in depth behind the CLI rule, which refuses first with usage_error, so reaching L1 means a caller bug.
// E5-L1 item 10: every function validates the audit metadata it would write before any write (section 2.1 "Audit
// content"): id strings at most 256 characters, digests 64 lowercase hex, refusalReason in its union; an internal caller's
// violation refuses CCC_PLANNING_INTERNAL_ERROR, and an actor's follows the actor rule above.
export async function getCccPlanningRunForTask(layer: AsyncDataLayer, taskId: string): Promise<CccPlanningRunCustody | null>;
export type CccPlanningLinkedOutcomePorts = Readonly<{
  reconcileLinkedOutcome?: (layer: AsyncDataLayer, runId: string) => Promise<void>;
}>;   // verify-v2 item 35: BF (W6) owns the real function; L1 (W2) and H1 (W3) only take this optional port
export async function inspectCccPlanningRun(layer: AsyncDataLayer, runId: string,
  ports?: CccPlanningLinkedOutcomePorts): Promise<CccPlanningRunStatusV1>;
  // for a linked run, calls ports.reconcileLinkedOutcome (when given) before reading (D43). WR wires BF's
  // reconcileCccPlanningCampaignOutcome into the runtime, CL2 into `fn plan status`; L1's and H1's tests use stubs
export async function resolveCccPlanningRunProject(layer: AsyncDataLayer, i: Readonly<{ runId: string; projectId?: string }>):
  Promise<Readonly<{ projectId: string }>>;
  // bypass-scoped lookup by run_id: none -> RUN_NOT_FOUND; >1 project -> RUN_AMBIGUOUS; projectId given and different
  // -> RUN_PROJECT_MISMATCH. Every later call runs project-scoped with that projectId.
/** Reserve + begin in one transaction: lock fence item, lock anchor, read db clock, fold history, check 2.9 rules,
 *  CAS the phase counter, append call:reserved and call:dispatched events. */
export async function admitCccPlanningDispatch(layer: AsyncDataLayer, request: CccPlanningCallRequest):
  Promise<CccProviderControllerDecisionView<CccPlanningCallScope>>;   // throws CccProviderAttemptLimitError for caps
  // E5-L1 item 3 (ADV-1): inside the locked transaction, refuses with a typed limit or route refusal any lineageId that is
  // not a fixed lineage for its stage and role or a lineage recorded by a ccc-planning:lineage:created event for this run
  // with the same role (section 2.1 "Node lineage ids"). E5-L1 item 4 (ADV-8): once claimCccPlanningRepairChunk creates a
  // lineage for a role, refuses new turn keys on every earlier lineage of that role.
  // E7-L item 7 (ADV1-C), replacing the allowance item 4 left for a continuing turn: every new call reservation on a
  // superseded lineage is refused ROUTE_NOT_ADMITTED with detail lineage-superseded, the next call of a continuing turn
  // included; a call already dispatched still settles. E7-L item 3 (tests): a fixed lineage taken by the wrong role
  // (product-adversary in review:technical-critic) and a leaf above the run's leaf cap (none at 1,536; leaf-77 is the
  // last at 6,144) refuse ROUTE_NOT_ADMITTED lineage-not-admitted, with planning_spent and the call:reserved count
  // unchanged. E7-L item 8(b): L1 reports whether dispatch counters are keyed by lineage id alone or by (fence, lineage
  // id); if by id alone, a campaign-fence lineage whose id equals a planning fixed lineage id is refused
  // E8 (L1 accepted): counters are keyed by lineage id alone, so that refusal is in place (ROUTE_NOT_ADMITTED,
  // lineage-not-admitted); the semantic-id collision refusal is GG's G4, never AD1's (E8-0, N-3)
export async function proveCccPlanningCallNotDispatched(layer: AsyncDataLayer, scope: CccPlanningCallScope, evidenceDigest: string): Promise<CccPlanningCallScope>;
export async function settleCccPlanningCall(layer: AsyncDataLayer,
  settlement: CccProviderAttemptSettlementInputOf<CccPlanningCallScope>): Promise<CccPlanningCallScope>;
  // idempotent on same digest; outcome committed | refused_known_effect (refusalReason route) | failed_known_effect (provider error).
  // A route refusal (receipt-missing | receipt-mismatch | effective-route-drift) also moves the run to blocked_provider /
  // CCC_PROVIDER_PIN_DRIFT IN THE SAME TRANSACTION: from running, or from building for G7/G8 calls (verify-v2 item 42)
  // E5-L1 item 6 (ADV-2): a refusalReason outside the four-member union refuses CCC_PLANNING_INTERNAL_ERROR and writes nothing
  // E7-L item 5: before its transaction it bounds the committed effectiveRoute and cost strings (section 2.1 "Audit
  // content"); a violation refuses CCC_PLANNING_INTERNAL_ERROR and writes nothing. Recorded, not fixed (E7-L item 11):
  // the move to blocked_provider does not respect a pending pause, so the operator may need to resume twice
export async function recordCccPlanningLineageSplit(layer: AsyncDataLayer, i: Readonly<{
  runId: string; parentLineageId: string; childLineageIds: readonly string[]; fence: CccPlanningWorkItemFence }>): Promise<void>;
  // E7-L item 8(a): refuses a child id that has any fixed lineage owner (section 2.1), for example child
  // review:technical-critic of parent review:product-adversary; a fresh child id is accepted. Recorded (E7-L item 11):
  // splitting an unused parent gives each child a fresh 3 attempts (D13 as written)
  // E8-0, N-6: the refusal is CCC_PLANNING_ROUTE_NOT_ADMITTED, detail lineage-not-admitted (adopted)
export async function claimCccPlanningRepairChunk(layer: AsyncDataLayer, i: Readonly<{
  runId: string; source: "planning-rejection" | "coding-rejection"; candidateDigest: string;
  repairAuthors: readonly CccPlanningRoleId[]; reReviewers: readonly CccPlanningRoleId[]; fence: CccPlanningWorkItemFence }>):
  Promise<Readonly<{ chunkOrdinal: 1 | 2 | 3 | 4; lineages: readonly Readonly<{ roleId: CccPlanningRoleId; lineageId: string;
    kind: "author-repair" | "review-node"; parentLineageId: string; inheritedDispatchAttempts: number }>[] }>>;
  // D13 (leader ruling): each author -> repair:k:<role>, inheriting the author's count; each critic -> review node
  // <stage>:<role>:rv<k>, inherited 0. Refuses REPAIR_EXHAUSTED | REPAIR_EPOCH_CLOSED | fit (repairNodes = authors +
  // review nodes) | DISPATCH_CAP when any repair author has no attempt left; a refusal writes nothing.
  // E2-9, E3-2: also refuses ROUTE_NOT_ADMITTED, with detail "role-class-mismatch" in the refusal message, for a
  // reReviewers entry whose role is not reviewer-class or a repairAuthors entry whose role is not author-class. A role is
  // reviewer-class when roleClass === "critic", and author-class otherwise ("author", "researcher" or "writer"), per D13
  // and the K1 CccPlanningRoleClass union (E4-11)
  // E5-L1 item 4 (ADV-9): also refuses UNRECONCILED_DISPATCH while any earlier lineage of the same role has a reserved or
  // dispatched_unknown call
export async function closeCccPlanningRepairEpoch(layer: AsyncDataLayer, i: Readonly<{ runId: string; fence: CccPlanningWorkItemFence }>): Promise<void>;
export async function recordCccPlanningReviewEpoch(layer: AsyncDataLayer, i: Readonly<{
  runId: string; fence: CccPlanningWorkItemFence; epochDigest: string; blockingFindings: number }>):
  Promise<Readonly<{ reviewEpochs: number; stagnantEpochs: number; stop: boolean }>>;
  // improved iff blockingFindings < previous epoch's; stop iff stagnantEpochs reaches 2
  // E5-L1 item 9 (ADV-5): an epochDigest equal to any earlier epoch's digest for the same run and stage is a replay: it
  // returns the existing epoch and records no new epoch and no stagnation
export async function reserveCccPlanningResearchFetch(layer: AsyncDataLayer, i: Readonly<{
  runId: string; nodeId: string; nodeAttempt: number; maxRawBytes: number; fence: CccPlanningWorkItemFence }>): Promise<Readonly<{ grantKey: string }>>;
export async function settleCccPlanningResearchFetch(layer: AsyncDataLayer, i: Readonly<{
  grantKey: string; rawBytes: number; outcome: "fetched" | "refused" | "failed" }>): Promise<void>;
export async function requestCccPlanningControl(layer: AsyncDataLayer, i: Readonly<{
  runId: string; request: "pause" | "cancel" | "resume"; actor: string }>): Promise<Readonly<{ controlSeq: number; appliedDirectly: boolean }>>;
  // import_id set -> CONTROL_REQUIRES_CAMPAIGN_BRIDGE. state importing -> pause/resume COMMAND_NOT_SUPPORTED; cancel only
  // while import_intent_digest IS NULL. running -> sets control_request for H1 to apply at the next safe point.
  // paused/awaiting/blocked states apply directly IN THE SAME TRANSACTION: resume and unblock move the planning work item
  // held -> runnable; cancel moves the run to cancelling and, when no live lease holder exists, completes it (D45).
  // E5-L1 item 12: it never produces the outcome "deferred-leased", which leaves L1's own outcome types (section 2.10).
  // E5-L1 item 13, kept as is and documented in a code comment: held -> runnable takes attempt + 1, so a stale holder's
  // fence is refused; a second cancel while one is pending gives CONTROL_PENDING.
  // E7-L item 1: in admitted, pause refuses CCC_PLANNING_STATE_TRANSITION_REFUSED ("admitted has no -> paused
  // transition") before any write (control_seq and control_request unchanged, no ccc-planning:control event); cancel in
  // admitted stays direct. Since E7-0, "deferred-leased" has left K1's status type too (section 2.10)
export async function answerCccPlanningDecision(layer: AsyncDataLayer, i: Readonly<{
  runId: string; decisionId: string; answer: string; actor: string }>): Promise<Readonly<{ controlSeq: number; answerArtifactKey: string }>>;
  // one tx: CAS control_seq+1, publish operator_answer under {kind:"operator", runRevision, controlSeq} with producer
  // instanceId "operator:<controlSeq>" and the actor, state -> running, AND planning work item held -> runnable
  // E5-L1 item 11: the operator answer is published through card A1's publisher (task-store/ccc-planning-artifact-ops.ts,
  // on the base since INT-2a), not through L1's own INSERT and event. A1's recorded residual applies: a replay under an
  // operator fence does not re-check the fence, so L1 never reads replayed: true as proof that controlSeq is current
  // Recorded, not fixed (E7-L item 11): its lock order against A1's planning-fence publish can deadlock; PostgreSQL
  // detects it (40P01)
export async function recordCccPlanningBuildControl(layer: AsyncDataLayer, i: Readonly<{
  runId: string; request: "pause" | "cancel" | "resume"; actor: string }>): Promise<Readonly<{ controlSeq: number }>>;
  // only when import_id is set. In state importing or building, pause/resume -> COMMAND_NOT_SUPPORTED and nothing is
  // written (verify-v2 item 36; an I4 must-do). Otherwise CAS control_seq+1 and append ccc-planning:control
  // {route:"campaign-bridge", actor}. Cancel in building also sets control_request = 'cancel', which stops review spend
  // (trigger) and linked writer reservations (BF) at once; BF's mapping clears it when the run reaches cancelled.
  // E2-3, E4-13: cancel stores control_request = 'cancel' in every linked state that has an allowed -> cancelling pair:
  // importing, awaiting_execution_authority, building, paused, awaiting_budget, blocked_prerequisite, blocked_provider,
  // budget_exhausted, unknown_effect, verification_failed and accepted. delivering, the one linked non-terminal state with
  // no such pair, refuses STATE_TRANSITION_REFUSED (E3-1) and writes nothing; the terminal states keep RUN_ENDED and
  // RUN_TERMINAL
export async function completeCccPlanningCancellation(layer: AsyncDataLayer, i: Readonly<{ runId: string; now?: string }>):
  Promise<Readonly<{ completed: boolean }>>;
  // cancelling and no live lease holder on the planning work item -> work item cancelled + run cancelled in one tx;
  // a planning work item that has already ended (it succeeds after the import stage) is left unchanged
  // E5-L1 items 7 and 8 (ADV-10, D45): the only path to cancelled. Lease liveness is judged with the database clock
  // (clock_timestamp()), never with the caller's `now`. While any call of the run is reserved or dispatched_unknown it
  // returns {completed: false} and records the reason, with CCC_PLANNING_DESCENDANTS_UNSETTLED wherever a code is surfaced
export async function completeCccPlanningCancellationWithin(tx: DbTransaction, i: Readonly<{
  projectId: string; runId: string; now?: string }>):   // projectId as accepted at L1's repair 2 (E8-L item 1)
  Promise<Readonly<{ completed: boolean }>>;
  // E7-L item 9: the same completion inside the caller's transaction (BF's savepoint, D43 note), with the direct form's
  // input; completeCccPlanningCancellation above becomes a wrapper that opens the transaction and calls it, so there is
  // one path to cancelled. Inside an outer transaction that rolls back, nothing persists. E8: the within form takes
  // projectId (it runs on the caller's transaction, without the data layer the direct form uses to find the run), and
  // the parent added the core barrel export (export * of task-store/ccc-planning-ops.js) at INT-2d.
  // E7-L item 4: when either form defers, it writes one ccc-planning:control row, subject cancel-deferred:<reason>
  // (live-lease | descendants-unsettled), event id derived from (run id, current control_seq, deferral ordinal), written
  // only when the latest deferral row for that control_seq has another reason (E8-L item 3, card L1z): the same deferral
  // again writes nothing, and a changed reason, a flip back included, writes one new row. Its metadata carries the reason and, for descendants,
  // CCC_PLANNING_DESCENDANTS_UNSETTLED. lastControl still reports the cancel as pending
export async function transitionCccPlanningRunState(layer: AsyncDataLayer, i: Readonly<{
  runId: string; from: CccPlanningRunState; to: CccPlanningRunState; stateCode: string | null;
  fence: CccPlanningWorkItemFence | null }>): Promise<CccPlanningRunCustody>;   // CAS on from; appends state event
  // E5-L1 item 5 (ADV-11, ADV-12): while control_request is set, refuses CCC_PLANNING_CONTROL_PENDING for every target
  // except paused, cancelling and cancelled, as a CAS predicate on the UPDATE
  // (AND (control_request IS NULL OR <target> IN ('paused', 'cancelling', 'cancelled'))), not a read-then-check.
  // E7-L item 2: the predicate becomes (control_request IS NULL OR <target> IN ('cancelling', 'cancelled') OR
  // (<target> = 'paused' AND control_request = 'pause')), and the re-read fallback classifies the same way
  // (CONTROL_PENDING otherwise), so a move to paused never erases a pending cancel
  // E5-L1 item 8: refuses -> cancelled with STATE_TRANSITION_REFUSED; only completeCccPlanningCancellation reaches it
export async function transitionCccPlanningRunStateWithin(tx: DbTransaction, i: Readonly<{
  projectId: string; runId: string; from: CccPlanningRunState; to: CccPlanningRunState; stateCode: string | null;
  fence: CccPlanningWorkItemFence | null }>): Promise<CccPlanningRunCustody>;   // L1z, E8-L item 1 (E8-0, B-1)
  // The same predicate, CAS, state event and refusals as the direct form, inside the caller's transaction (BF's D43
  // rows, D43 note (E8-0)): the E7-L item 2 control predicate (CONTROL_PENDING), and -> cancelled refused
  // STATE_TRANSITION_REFUSED (only completeCccPlanningCancellation[Within] reaches cancelled). transitionCccPlanningRunState
  // above becomes a wrapper that opens the transaction and calls it. Inside an outer transaction that rolls back, nothing
  // persists. projectId scopes the run as in completeCccPlanningCancellationWithin (E8-L item 1 asks for it only if the
  // within form needs it; L1z reports which). No barrel edit: INT-2d's export * of ccc-planning-ops.js exports it
export async function assertCccPlanningDescendantsSettled(layer: AsyncDataLayer, runId: string): Promise<void>;  // DESCENDANTS_UNSETTLED
export function createCccPlanningAttemptController(i: Readonly<{ layer: AsyncDataLayer; binding: CccPlanningRouteBinding;
  turnKey: string; fence: CccPlanningWorkItemFence; preflight: boolean }>): CccProviderAttemptControllerView<CccPlanningCallScope>;
  // structural controller type from K1 (provider-controller.ts), so core never imports engine

// packages/core/src/task-store/ccc-planning-admission-ops.ts (AD1)
export type CccPlanningAdmissionInput = Readonly<{
  projectId: string; mode: CccPlanningMode; budgetProfile: CccPlanningBudgetProfile;
  request: Readonly<{ bytes: Uint8Array; sha256: string }>;
  receipt: CccPlanningLiveAuthorityReceiptV1; receiptSha256: string; receiptCanonicalJson: string;
  runtimeDistManifestSha256: string; targetRepository: string; admittedBase: string;
  grant: CccPlanningGrantV1; policyDigest: string; plannedLeaves: 0;
}>;
export async function admitCccPlanningRun(layer: AsyncDataLayer, input: CccPlanningAdmissionInput,
  hooks?: Readonly<{ afterStep?: (step: "task" | "anchor" | "workflow" | "work-item" | "artifacts") => Promise<void> }>):
  Promise<CccPlanningRunCustody>;
  // one tx, in this order: (1) held task (paused, marker); (2) anchor, state admitted (composite FK to the task);
  // (3) project.workflows row with ir = buildCccPlanningWorkflowIr(mode) and its taskWorkflowSelection (importer.ts:560-590 pattern);
  // (4) planning work item (run_id = runId, irHash = cccPlanningWorkflowIrHash(ir)); (5) artifacts original_request,
  // admission_grant, authority_receipt (fence admission); (6) audit state event. RECEIPT_CONSUMED via the unique constraint.
  // E5-K2 item 4: the run id is cccPlanningRunId({ projectId, requestDigest: receipt.request.sha256, receiptSha256 })
  // (K1 policy.ts), derived exactly as K2's envelope check derives it (section 2.18)

// packages/core/src/task-store/ccc-planning-import-ops.ts (IM1)
export type CccPlanningImportIntentV1 = Readonly<{
  schema: "ccc-planning.import-intent.v1"; runId: string; runRevision: number; idempotencyKey: string;
  bundleHash: string; packetHash: string; sidecarHash: string; executionPolicyDigest: string;
  targetRepository: string; targetBase: string; targetHead: string;     // targetBase = B1; targetHead = B1 after the baseline step
  baselineBranchRef: string; buildTransitionRef: CccPlanningArtifactRef;
  limits: Readonly<{ maxRequests: number; maxDurationMs: number; maxConcurrency: 1; boundsComputedAt: string;
    clamps: readonly Readonly<{ field: "maxRequests" | "maxDurationMs"; requested: number; applied: number;
      reason: "import-ceiling" | "deadline-headroom" }>[] }>;
  closure: CccPlanningImportClosure; closureDigest: string; receiptSha256: string;
}>;
export type CccPlanningImportReceiptV1 = Readonly<{
  schema: "ccc-planning.import-receipt.v1"; runId: string; runRevision: number; idempotencyKey: string;
  importId: string; bundleHash: string; intentDigest: string; implementationTransferred: number;
  maxDurationMs: number; replayed: boolean;
  release: "released" | "awaiting_operator" | "not_applicable";
}>;
/** One tx: require intent.limits deep-equal to the published bundle artifact's bounds and to admission_facts.bounds
 *  (else IMPORT_IDENTITY_DRIFT); CAS anchor importing (intent digest null) with import_intent_digest =
 *  sha256(canonical(intent)) and import_idempotency_key = intent.idempotencyKey; AND publish the import_intent artifact. */
export async function recordCccPlanningImportIntent(layer: AsyncDataLayer, i: Readonly<{
  runId: string; intent: CccPlanningImportIntentV1; fence: CccPlanningWorkItemFence;
  hooks?: Readonly<{ beforeArtifact?: () => Promise<void> }> }>): Promise<Readonly<{ intentDigest: string; replayed: boolean }>>;
/** One tx: read ccc_prd_imports by idempotency key, require bundle hash = intent, set import_id and
 *  implementation_transferred, publish import_receipt. State moves to building or awaiting_execution_authority later (AU2). */
export async function linkCccPlanningImport(layer: AsyncDataLayer, i: Readonly<{
  runId: string; fence: CccPlanningWorkItemFence; release: CccPlanningImportReceiptV1["release"] }>): Promise<CccPlanningImportReceiptV1>;
export async function inspectCccPlanningImportLink(layer: AsyncDataLayer, runId: string):
  Promise<Readonly<{ kind: "none" } | { kind: "intent-only"; intent: CccPlanningImportIntentV1 } | { kind: "linked"; receipt: CccPlanningImportReceiptV1 }>>;

// packages/core/src/task-store/ccc-planning-campaign-link-ops.ts (BF)
export async function findCccPlanningRunForImport(tx: DbTransaction, projectId: string, importId: string):
  Promise<CccPlanningRunCustody | null>;   // one indexed read on ccc_planning_runs_import_unique
export async function openCccPlanningLinkedWriterAttempt(layer: AsyncDataLayer, i: Readonly<{
  importId: string; semanticTaskId: string; baseTurnKey: string; nodeAttemptOrdinal: number; fence: CccCampaignWorkItemFence }>):
  Promise<Readonly<{ turnKey: string; dispatchAttemptOrdinal: 1 | 2 | 3;
    route: Readonly<{ providerId: string; modelId: string; transport: string; roleClass: string; toolsetDigest: string }> }>>;
  // E8-0, N-5: route is the linked writer's bound route, all five values strings, a structural core copy of the engine's
  // CccProviderAttemptBoundRoute (core never imports engine); WR passes it to attachCccProviderAttemptBoundRoute, and a
  // type test in WR pins that the two shapes are equal
  // nodeAttemptOrdinal = the graph executor's retry index + 1 (WR's additive edit, verify-v2 item 18); replay of the same
  // (baseTurnKey, nodeAttemptOrdinal) returns the same key; a 4th distinct attempt for the semantic task -> dispatch-cap
export async function applyCccPlanningCampaignOutcomeWithinTransaction(tx: DbTransaction, i: Readonly<{
  projectId: string; before: WorkflowWorkItem; workItem: WorkflowWorkItem; fromState: WorkflowWorkItemState;
  toState: WorkflowWorkItemState }>):   // before = rowToWorkflowWorkItem(existing), the row read before the update
                                        // (async-workflow-workitems.ts:320, mapper as at :388; verify-v2 item 40)
  Promise<Readonly<{ kind: "not-linked" } | { kind: "mapped"; runState: CccPlanningRunState } | { kind: "unmapped" }>>;
  // called by transitionWorkflowWorkItem after its update, same tx (async-workflow-workitems.ts:300-385); NEVER throws:
  // the mapping body runs inside a nested Drizzle transaction (tx.transaction(...), i.e. a SAVEPOINT), because a SQL error
  // would otherwise abort the outer campaign transaction; on any error the savepoint rolls back, then the outer tx writes
  // ccc-planning:campaign-unmapped and returns "unmapped". A disallowed anchor transition does the same without an error.
  // E7-0: the mapping body reaches the anchor only through L1's functions, never through direct SQL: a row that ends in
  // cancelled calls completeCccPlanningCancellationWithin(tx, ...) inside this savepoint, and the success row while a
  // cancel is pending is refused CONTROL_PENDING by L1, which BF maps to cancelling
  // E8-0, B-1: every other row, and the -> cancelling step before completeCccPlanningCancellationWithin, calls L1z's
  // transitionCccPlanningRunStateWithin(tx, ...) inside the same savepoint; a rollback of the savepoint leaves nothing
export async function reconcileCccPlanningCampaignOutcome(layer: AsyncDataLayer, runId: string): Promise<void>;
  // same mapping from the current campaign item states; used on status read and at engine start, injected into L1 and
  // H1 through CccPlanningLinkedOutcomePorts (WR and CL2 wire it)
/** Thrown by BF's linked checks. It extends the existing class, so the engine's max-requests mapping
 *  (ccc-campaign-provider-controller.ts:55-60) and every instanceof check keep working. */
export class CccPlanningLinkedWriterLimitError extends CccProviderAttemptLimitError {
  readonly refusal: Readonly<{ runId: string; importId: string; turnKey: string; dispatchKey: string;
    reason: CccProviderAttemptLimitError["reason"]; refusedAt: string }>;   // refusedAt = databaseNow read by the refused reservation
}
export async function recordCccPlanningWriterRefusal(layer: AsyncDataLayer,
  refusal: CccPlanningLinkedWriterLimitError["refusal"]): Promise<void>;
  // its own transaction, AFTER the outer reservation transaction has rolled back; writes only run_audit_events
  // (ccc-planning:writer-refused, deterministic eventId, timestamp = refusedAt), never the anchor (verify-v2 item 48)
```

**Campaign outcome mapping (BF, D43).** Applies only when `findCccPlanningRunForImport` returns a run. Rules, first match wins:

| Campaign event (work items with `run_id = ccc-prd:<import_id>`) | Evidence BF reads | Run transition and code |
|---|---|---|
| First approved linked writer reservation | reservation tx | `awaiting_execution_authority → building` |
| Item `→ held` with `blockedReason = CCC_CAMPAIGN_OPERATOR_PAUSED_REASON` (`ccc-campaign-operator-control.ts:25, 425-429`) | work item patch | `building → paused` |
| Item `held → runnable` whose `before.blockedReason` was that pause reason (operator resume, `:452-462`) | `before` and the updated row (verify-v2 item 40) | `paused → building` |
| Item `→ cancelled` with `lastError` starting with `CCC_CAMPAIGN_OPERATOR_STOPPED_PREFIX` (`:487, 524-528`) | work item patch | the run's current state (for example `building`, `paused` or `awaiting_execution_authority`; never the literal `building`, E2-3) → `cancelling` → `cancelled` (two steps, one tx); clears `control_request` |
| Item `running → cancelled` with `lastError = "workflow-user-cancelled"` (the in-lease cancel, `workflow-work-processor.ts:383-397, 404-430`) | work item patch | the run's current state (normally `building`; never the literal `building`, E2-3) → `cancelling` → `cancelled` (two steps, one tx); clears `control_request` (verify-v2 item 36) |
| Every item `succeeded` | an accepted `final_judgment` artifact for the import | `building → accepted`; without it `building → failed` / `CCC_PLANNING_FINAL_JUDGMENT_MISSING` |
| Item `failed` or `manual-required` | a rejected `task_review` or `final_judgment` artifact | `building → verification_failed` / `CCC_PLANNING_CODING_REPAIR_NOT_RUN` |
| Item `failed` or `manual-required` | latest `ccc-planning:writer-refused` with `iteration-cap`, `dispatch-cap`, `phase-allocation`/`max-requests`, `deadline` | `building → budget_exhausted` / `CCC_PLANNING_ITERATION_CAP`, `_DISPATCH_CAP`, `_PHASE_ALLOCATION_EXHAUSTED`, `_DEADLINE` |
| Item `failed` or `manual-required` | latest `writer-refused` with a route refusal, or a degenerate-output refusal | `building → blocked_provider` / `CCC_PROVIDER_PIN_DRIFT` or `CCC_MODEL_DEGENERATE_OUTPUT` |
| Item `manual-required` | a linked attempt `dispatched_unknown` | `building → unknown_effect` / `CCC_PLANNING_UNRECONCILED_DISPATCH` |
| Item `manual-required` after WR's quarantine (E2-5; an exec closure error or an `unconfirmed` dispose, E4-9) | the item's `blockedReason` `ccc-permanent:CCC_PLANNING_WRITER_CLOSURE_UNCONFIRMED`, from WR's `PermanentError` (E4-4) | `building → blocked_prerequisite` / `CCC_PLANNING_WRITER_CLOSURE_UNCONFIRMED`, through the existing pair (E4-2) |
| Item `failed`, `manual-required` or `cancelled`; checked before the generic failed row below (E2-2) | the run has `control_request = 'cancel'`, or its latest refusal code is `control-pending` | the run's current state → `cancelling` → `cancelled` (two steps, one tx) with the cancel reason; never `CCC_PLANNING_CAMPAIGN_FAILED` |
| Any other terminal item state | none | `building`/`awaiting_execution_authority` → `failed` / `CCC_PLANNING_CAMPAIGN_FAILED` |
| A transition the anchor does not allow from its current state | none | no anchor change; `ccc-planning:campaign-unmapped` (marker `CCC_PLANNING_CAMPAIGN_STATE_UNMAPPED`) |

The other work-item writers do not carry outcomes: lease acquire and renew (`workflow-workitems-ops-2.ts:243-262, 328-350`) are non-terminal, and `importer.ts:2256` is the import's activation (`held → runnable`). `reconcileCccPlanningCampaignOutcome` is the backstop for any path that bypasses the hook.

**Through L1 (E7-0; E8-0).** BF's rows reach the anchor only through L1's functions, never through direct SQL. A row that ends in `cancelled` calls `completeCccPlanningCancellationWithin` inside the savepoint; if it defers (a live lease or unsettled descendants), the run stays `cancelling` and the deferral is recorded (D45 note). The `succeeded` row while a cancel is pending is refused `CCC_PLANNING_CONTROL_PENDING` by L1, and BF maps the run to `cancelling` instead. Every row that does not end in `cancelled`, and the `→ cancelling` step of the rows that do, calls L1z's `transitionCccPlanningRunStateWithin` inside the campaign transaction (the hook's savepoint, or the reservation transaction for the first-reservation row), so a rollback leaves nothing (E8-0, B-1; open until L1z is accepted). For a linked writer, BF returns the five bound-route values as the `route` field of `openCccPlanningLinkedWriterAttempt`'s result (E8-0, N-5), and WR attaches the marker, building the binding around the controller the helper returns (E8-0, N-1; D48 note).

**Linked reservation checks (BF, D15)**, in `reserveCccProviderAttempt` (`provider-attempt.ts:1419-1479`), only when `findCccPlanningRunForImport` finds a run. BF first reads `databaseNow(tx)` (`provider-attempt.ts:1146`, the same clock read the reservation makes at `:1453`) as `refusedAt`, then checks in this order: runtime digest (`runtime-not-permitted`); run state (`awaiting_execution_authority` moves to `building` on the first approved call; any state other than `building` afterwards gives `run-not-building`, mapped to `CCC_PLANNING_RUN_ENDED` for terminal or resting states and `CCC_PLANNING_CONTROL_PENDING` for `paused`); a pending cancel (`control_request = 'cancel'` gives `control-pending`); the run deadline (`refusedAt + 30 s ≥ deadline_at` gives `deadline`, verify-v2 item 49); unreconciled dispatch; dispatch cap; iteration cap; then the existing deadline, max-requests and max-concurrency checks.

A refusal throws `CccPlanningLinkedWriterLimitError`. The reservation runs inside the caller's outer transaction (`provider-controller.ts:133-186`), so everything it wrote rolls back. **After** that outer transaction has rolled back, the catch in `atomicReserveCccCampaignProviderDispatch` (a hunk BF owns in `provider-controller.ts`) calls `recordCccPlanningWriterRefusal` in a new transaction that writes only the audit row, with `timestamp = refusedAt`, and then rethrows the same error. v2 wrote the event in its own transaction while the outer one was still open, which risked a lock wait or a lost event (verify-v2 item 48). A replay of the same refusal returns the persisted event (D39).

### 2.12 Pi seam: view types (card K1), binding and planning-scope settlement (card P1)

```ts
// packages/core/src/ccc-campaign/types.ts (K1, type-only and additive; CccProviderAttemptScope unchanged byte for byte)
export type CccProviderAttemptRouteBindingView = Readonly<{
  taskId: string; providerId: string; modelId: string; transport: CccCampaignTransport }>;
export type CccProviderAttemptScopeView = Readonly<Omit<CccProviderAttemptScope, "binding"> & { binding: CccProviderAttemptRouteBindingView }>;
export type CccProviderAttemptSettlementInputOf<S extends CccProviderAttemptScopeView> = CccProviderAttemptReconciliation & Pick<S,
  "semanticTaskId" | "campaignDeadlineAt" | "turnKey" | "dispatchKey" | "attemptOrdinal" | "requestCount" | "workItemFence" | "binding">
  & Readonly<{ refusalReason?: "receipt-missing" | "receipt-mismatch" | "effective-route-drift" | "provider-error-event" }>;
  // refusalReason is supplied only in planning and planning-linked scope; provider-attempt.ts never persists it
  // (persisted evidence is exact-key checked); L1 and BF consume it.
// CccProviderAttemptLimitError.reason (types.ts:418-427) widens to:
//   "deadline" | "max-requests" | "max-concurrency" | "iteration-cap" | "dispatch-cap" | "unreconciled-dispatch"
//   | "control-pending" | "phase-allocation" | "run-not-building" | "runtime-not-permitted"
// The engine's existing catch maps only "max-requests" (ccc-campaign-provider-controller.ts:55-60); the new reasons are
// raised only for planning or planning-linked scopes, so campaign behaviour is unchanged.

// packages/core/src/ccc-campaign/provider-controller.ts (K1, type-only)
export type CccProviderControllerDecisionView<S extends CccProviderAttemptScopeView = CccProviderAttemptScopeView> =
  | Readonly<{ kind: "dispatch-permit"; scope: S }>
  | Readonly<{ kind: "hold"; reason: CccCampaignProviderControllerHoldReason; scope: S }>;
export type CccProviderAttemptControllerView<S extends CccProviderAttemptScopeView = CccProviderAttemptScopeView> = Readonly<{
  preDispatch(input: CccCampaignProviderDispatchInput): Promise<CccProviderControllerDecisionView<S>>;
  reconcile(input: CccProviderAttemptSettlementInputOf<S>): Promise<S>;
}>;

// packages/engine/src/agent-runtime.ts (P1)
// E5-P1 item 6: agent-runtime.ts declares no copy of K1's view types; it imports them from @fusion/core, whose
// ccc-campaign/index.ts exports them since INT-2a (CccProviderAttemptLimitReason, CccProviderAttemptRefusalReason,
// CccProviderAttemptRouteBindingView, CccProviderAttemptScopeView, CccProviderAttemptSettlementInputOf,
// CccProviderAttemptControllerView, CccProviderControllerDecisionView)
export type CccProviderAttemptController<S extends CccProviderAttemptScopeView = CccProviderAttemptScopeView> =
  CccProviderAttemptControllerView<S>;      // alias of the K1 type; one definition
export type CccSessionToolPolicy = Readonly<{
  policyId: `ccc-${CccPlanningRoleClass}-tools.v1` | `ccc-${CccPlanningRoleClass}-probe-tools.v1` | "ccc-linked-writer-tools.v1";
  allowedTools: readonly string[];          // frozen, sorted, unique, exact final names (CCC_PLANNING_TOOLSETS [+ probe tool],
                                            // or CCC_PLANNING_LINKED_WRITER_TOOLSET for linked writers, item 37)
  toolsetDigest: string;                    // sha256(canonical(sorted CccExecutionToolAuthority[]))
  readRoots: readonly string[];             // realpaths
  writeRoots: readonly string[];            // realpaths; [] unless roleClass === "writer"
  deniedNames: readonly string[];           // CCC_PLANNING_DENIED_NAMES
}>;
export type CccConfinedFsOperations = Readonly<{
  read: ReadOperations; write: WriteOperations; edit: EditOperations;
  ls: LsOperations; find: FindOperations;   // Pi 0.81.1 seam types; find MUST provide `glob` (no fd, find.js:101-112)
}>;                                          // no GrepOperations: grep is a Fusion tool (2.13)
export type CccConfinement = Readonly<{
  bash: (BashOperations & { dispose(): Promise<Readonly<{ closure: "confirmed" | "unconfirmed" }>> }) | null;   // E4-9, E5-P1 item 12
  fs: CccConfinedFsOperations;
}>;
// E4-9: the dispose result has the shape of X1c's CccConfinedDisposeResult (section 2.13; E5-P1 item 12).
// The creator of the shell disposes it: SF at the end of a planning session, recording an "unconfirmed" closure as an
// attempt fact; WR for writer sessions, where "unconfirmed" quarantines exactly as E2-5 does. pi.ts never calls dispose.
// E5-P1 item 12, E6-0: P1's repair-1 base (INT-2b, E7-C B1) held no X1c bytes, so P1 types CccConfinement.bash structurally, as above, in
// agent-runtime.ts and imports nothing from X1c; the structure equals X1c's CccConfinedDisposeResult. When the tool policy
// allows bash, P1's runtime shape check (E5-P1 item 8, below) also requires dispose to be a function.
export type CccStreamGuardVerdict =
  | Readonly<{ degenerate: false }>
  | Readonly<{ degenerate: true; reason: string; metricsDigest: string }>;
export type CccStreamGuard = Readonly<{
  observeDelta(kind: "text" | "thinking", chunk: string): CccStreamGuardVerdict;
  observeMessage(message: Readonly<{ text: string; reasoning: string; toolCallCount: number }>): CccStreamGuardVerdict;
}>;
export type CccProviderPinCheck = (providers: readonly CustomProvider[]) => void;  // throws CCC_PROVIDER_PIN_DRIFT
export type CccProviderAttemptBinding<S extends CccProviderAttemptScopeView = CccProviderAttemptScopeView> = Readonly<{
  turnKey: string;
  controller: CccProviderAttemptController<S>;
  receiptAdapterId?: CccCampaignRouteReceiptAdapterId;
  terminalRouteMembers?: readonly CccCampaignTerminalRouteMember[];
  scopeKind?: "campaign" | "planning" | "planning-linked-writer";   // default "campaign"
  toolPolicy?: CccSessionToolPolicy;     // required for "planning" and "planning-linked-writer"
}>;
// AgentOptions and AgentRuntimeOptions gain (all optional, validated by pi.ts):
//   cccConfinement?: CccConfinement;           required whenever binding.toolPolicy is present
//   cccStreamGuard?: CccStreamGuard;           required for "planning" and "planning-linked-writer"
//   cccProviderPinCheck?: CccProviderPinCheck; required for "planning" and "planning-linked-writer"
// E5-P1 item 5: AgentOptions.cccProviderAttemptBinding (the pi.ts property line P1 is granted, about 2244) and
// AgentRuntimeOptions.cccProviderAttemptBinding are typed CccProviderAttemptBinding<CccProviderAttemptScopeView>, so the
// planning factory's binding passes to createFnAgent options and to AgentRuntimeOptions with no cast; campaign code keeps
// the alias default.
// Validation (pi.ts:3536-3545, P1): "planning" and "planning-linked-writer" require receiptAdapterId
// "terminal-route-sse-comments.v1", no terminalRouteMembers, and a binding provider equal to options.defaultProvider by
// customProviderRegistryKey (D48); toolPolicy.allowedTools containing "bash" requires cccConfinement.bash !== null.
// Repair-1 validation (E5-P1), each refused at session creation unless noted:
// - item 3 (D48): a "planning" or "planning-linked-writer" binding without the bound-route marker
//   CCC_PROVIDER_ATTEMPT_ROUTE_MARKER, and a bound provider that is not options.defaultProvider;
// - item 7: a permit or hold scope whose scope.binding.scopeKind is "planning" or "planning-linked-writer" while the
//   session binding's scopeKind does not match, so a planning controller never gets campaign semantics;
// - item 8: when the tool policy allows bash, cccConfinement.bash must be an object whose exec (and, item 12, dispose) is a
//   function, and cccConfinement.fs is shape-checked;
// - item 9: validateCccSessionToolPolicy requires allowedTools to equal K1's
//   cccPlanningSessionToolNames({ roleClass, scopeKind, probe }) (E7-C N5), deniedNames ⊇ CCC_PLANNING_DENIED_NAMES, the policy's
//   toolsetDigest to equal the route binding's, and the policy's role class to equal the binding's.
// Repair-2 validation (E7-P):
// - item 5: for a "planning-linked-writer" binding, the marker's modelId, as well as its providerId, must equal
//   options.defaultModelId and the default provider; refused at session creation, before any provider call;
// - item 6: the item-7 scope-kind check runs on the binding before preDispatch when it can; if it needs the permit's
//   scope, the reserved call is settled once as a refusal with no upstream request, through the path P1 uses for route
//   refusals, so the slot is never left reserved or dispatched_unknown;
// - item 4: a receipt-mismatch settlement's evidence records the observed conflicting providerId and modelId (bounded
//   strings), never observed: null.

// packages/engine/src/ccc-planning/provider-binding.ts (P1)
export function createCccPlanningProviderAttemptBinding(i: Readonly<{
  controller: CccProviderAttemptController<CccPlanningCallScope>;
  binding: CccPlanningRouteBinding; turnKey: string; toolPolicy: CccSessionToolPolicy;
}>): CccProviderAttemptBinding<CccPlanningCallScope>;   // frozen; preDispatch refuses (route-drift) if provider/model/transport ≠ binding

// packages/engine/src/pi.ts (P1, region (a): 744-1149 plus 3536-3545, plus the AgentOptions.cccProviderAttemptBinding
// property line granted by E5-P1)
// E7-0 also grants P1 the @fusion/core import block (lines 45-46 at repair 1, which add cccPlanningSessionToolNames and
// CCC_PLANNING_DENIED_NAMES); P1 may add to it any @fusion/core value its E7-P items need.
export class CccProviderRouteReceiptError extends Error {
  readonly code: "CCC_PROVIDER_ROUTE_RECEIPT_REFUSED";
  readonly reason: "receipt-missing" | "receipt-mismatch" | "effective-route-drift" | "provider-error-event";
  readonly requested: Readonly<{ provider: string; model: string }>;
  readonly observed: Readonly<{ provider: string; model: string }> | null;
}
// evidenceDigest = sha256(canonical({schema:"ccc-provider-route-refusal.v1", reason, requested, observed, adapter}))
// E5-P1 item 10: a provider-error refusal's evidence keeps the observed omniRoute receipt when the event carries one.
// E7-P item 4: in a receipt-mismatch refusal, observed carries the conflicting receipt's provider and model (bounded
// strings), so the evidence keeps them.
// E7-0, E7-P item 7: the bound-route marker, exported for WR, which attaches it at linked-writer session creation, and
// for BF, which supplies its five values in core data and never imports engine. The existing reader uses the same type,
// and a type test pins the five keys. The parent added the engine barrel exports at INT-2d (E8). The helper's types
// are P1's, as accepted (E8-0, N-1, which retires v3.4's editor's note on a `controller: object` parameter).
export const CCC_PROVIDER_ATTEMPT_ROUTE_MARKER: unique symbol;   // Symbol.for("ccc-fusion.provider-attempt-route.v1")
export type CccProviderAttemptBoundRoute = Readonly<{
  providerId: string; modelId: string; transport: string; roleClass: string; toolsetDigest: string }>;   // exactly 5 keys
export function attachCccProviderAttemptBoundRoute<S extends CccProviderAttemptViewScope>(
  controller: CccProviderAttemptController<S>, route: CccProviderAttemptBoundRoute): CccProviderAttemptController<S>;
  // E8-0, N-1: returns a NEW frozen controller that forwards preDispatch and reconcile and carries a frozen copy of the
  // five route values under CCC_PROVIDER_ATTEMPT_ROUTE_MARKER; the argument is not changed. It refuses a controller whose
  // own keys are not exactly preDispatch and reconcile, a controller that already carries a marker, and an empty route
  // value. The reader refuses a route that is not a frozen object with exactly these five string keys. WR builds the
  // linked-writer binding around the returned controller; a binding built on the original has no marker and is refused
  // at session creation. CccProviderAttemptViewScope is pi.ts's alias of agent-runtime's CccProviderAttemptScopeView

// packages/engine/src/ccc-route-receipt-adapter.ts (P1 grant, E5-P1 item 4: an additive structural marker on error events)
// Each error event the adapter emits may carry one extra field:
//   cccRouteFailure: "receipt-missing" | "receipt-conflicting" | "receipt-incomplete" | "receipt-not-terminal"
//     for a terminal-receipt failure;
//   cccTransportFailure: true
//     for a terminated stream, a socket reset, a fetch failure or an adapter timeout.
// An upstream-reported error (an HTTP status from the provider, or finish_reason error) carries neither field. The
// adapter's existing tests stay green.
// E7-P item 1: consumeReceiptAdapterSse wraps both the per-line processing inside its read loop (consumeLine and
// consumeData) and the final flush in try/catch; when no [DONE] was seen it sets transport.failed = true before
// rethrowing. An error raised after the body began and before [DONE] is therefore cccTransportFailure: true, unless the
// upstream itself reported it (a parsed finish_reason error, or an error object in a complete event). P1's adapter grant
// covers this change, and P1z's changes below (E8-0, confirmed).
// P1z (E8-P items 1 and 2), on the same adapter, processing and markers only, with no pi.ts edit:
// - a processing throw AFTER [DONE] (a cut or malformed data line after [DONE], in processBeforeDone or the final flush)
//   marks the error event cccRouteFailure: "receipt-missing" with detail receipt-not-terminal, so pi.ts settles one
//   route refusal (refused_known_effect, no retry), like the existing non-terminal case; before [DONE] the E7-P item 1
//   transport rule stays;
// - a 200 response whose content type is not text/event-stream is never read, so its route is unverified: it is marked
//   cccRouteFailure: "receipt-missing" with detail non-sse-response and settled once, with no retry; a non-2xx status
//   stays an upstream error (provider-error-event).
// Editor's note (E8-P): the adapter's error event has no separate detail field, so the detail travels in the error
// message. "receipt-missing" is in pi.ts's CCC_ROUTE_FAILURE_KINDS and settles refusalReason "receipt-missing", which is
// why P1z needs no pi.ts edit; the existing kind "receipt-not-terminal" would settle the same way.
```

**Settlement rule (D10).**
- **Campaign scope (default).** Unchanged. A drift or receipt mismatch keeps today's behaviour: `pi.ts` calls `reconcile` with a committed `effectiveRoute` naming the observed model, the controller refuses and throws, the attempt stays `dispatched_unknown`, the same dispatch key is re-entered, and the provider stream is called once (`pi.test.ts:1872-1909`, which no card edits).
- **Planning and planning-linked-writer scope.** Before `reconcile`, `pi.ts` runs `assertCccProviderAttemptEffectiveRoute` and `requireCccOmniRouteReceipt`.
  - Drift, a missing receipt or a mismatched receipt on a non-error terminal: call `reconcile` **once** with `outcome: "proved_failed"`, no `effectiveRoute`, the refusal `evidenceDigest` and `refusalReason`, then throw `CccProviderRouteReceiptError` **out of the stream's slot loop**. Today a `proved_failed` terminal hold advances `nextSlot` and dispatches again (`pi.ts:1030-1035`); in planning scope that path is never reached, so the dispatch keys stay `["pi-stream:1"]` (verify-v2 item 42). The response is discarded and the spend kept. L1's settlement (planning sessions and G7/G8) or BF's reconcile (linked writers) records `refused_known_effect` and moves the run to `blocked_provider` / `CCC_PROVIDER_PIN_DRIFT` in the same transaction, so no further call is reserved for the run. Nothing retries.
  - With the receipt adapter selected (always, D48), a model mismatch is caught as `receipt-mismatch`: `effectiveModel` is the requested Pi route, and the upstream identity comes only from the terminal route receipt (`pi.ts:474-520, 1066-1085`).
  - A provider `error` event: reconcile once `proved_failed` with `refusalReason: "provider-error-event"`, outcome `failed_known_effect`; a retry inside the iteration and dispatch caps is allowed. The `proved_failed` terminal hold advances `nextSlot` as D10 requires, so a retry in the same planning session dispatches `pi-stream:2` (E2-1). Throwing out of the slot loop instead of advancing applies only to a held decision with `refused_known_effect`, or another route refusal.
  - Drift on an upstream error (E7-0, amending D10; E7-P item 3): a `finish_reason: error` whose terminal receipt names another model settles `receipt-mismatch` once and does not retry: dispatch keys `["pi-stream:1"]` and one upstream request. The same error with the bound model's receipt settles `provider-error-event` and advances, as above.
  - A lost connection or an abort without any terminal event stays `dispatched_unknown`.
  - Error events, by the adapter's marker (E5-P1 item 4; this settles the lost-connection rule):
    - a receipt failure (`cccRouteFailure`) is a route refusal: settle once `proved_failed` with `refusalReason: "receipt-missing"`, or `"receipt-mismatch"` when a conflicting or observed receipt exists; record it in the route-refusal memory, throw `CccProviderRouteReceiptError`, and do not advance;
    - a transport failure (`cccTransportFailure: true`) is not settled, so the attempt stays `dispatched_unknown`;
    - an upstream-reported error (neither field) settles `provider-error-event` and advances, as above.
    - an error raised after the body began and before `[DONE]` is a transport failure unless the upstream reported it (E7-P item 1); a malformed data line mid-stream makes the adapter abandon the stream, so the outcome is unknown and the attempt stays `dispatched_unknown`;
    - rulings, no code (E7-P item 9): a receipt that is not terminal (a matching receipt followed by a data line) and an incomplete receipt settle `receipt-missing`, since no terminal receipt was observed; refusal memory stays per session (L1's and BF's run-state block covers new sessions); `cccStreamGuard` is a presence check.
  - Refusal memory first (E5-P1 item 1): `pi.ts` writes the refused slot to `state.routeRefusals` before it awaits the settlement reconcile, then awaits it, then throws. A reconcile that persists the settlement and then rejects still leaves a second `agent.stream()` rejecting with `CccProviderRouteReceiptError`, with distinct keys `["pi-stream:1"]` and one provider call.
  - The real abort shape (E5-P1 item 2): a provider stream that yields `{type: "error", reason: "aborted", …}`, the adapter's abort shape, gets no reconcile; re-entry throws `/dispatched_unknown/` with keys `["pi-stream:1","pi-stream:1"]`, and the provider is called once.
  - `effective-route-drift` (E8-0, item 6, correcting E5-P1 item 11's "unreachable in planning scope"): the adapter always reports the requested route as `effectiveModel` (D48), so a planning binding has no drift branch, but a planning scope refused under a non-planning binding (the E7-P item 6 refusal) settles once with `refusalReason: "effective-route-drift"`. L1 and BF map it as a route refusal: `refused_known_effect`, then `blocked_provider` / `CCC_PROVIDER_PIN_DRIFT`.
  - A body-processing failure after `[DONE]` and a 200 response that is not `text/event-stream` are route refusals (P1z, E8-P items 1 and 2; the adapter comment above): one settlement, no `pi-stream:2`, never `provider-error-event`.
  - P1 residuals (E8-0, recorded, not fixed): a missing API key and a throw from an `onResponse` hook still settle `provider-error-event` (local failures: no upstream effect for the first, an already-answered request for the second); P1's loopback test (c) (bind port 0, close it, dial it) has a small port-reuse race (section 6 risk 57).

### 2.13 Tool policy, confined tools and confinement (cards C2, X1, X1c, X1b)

```ts
// packages/engine/src/ccc-confinement/session-tool-policy.ts (C2)
export function buildCccSessionToolPolicy(i: Readonly<{ roleClass: CccPlanningRoleClass; probe?: boolean; linkedWriter?: boolean;
  readRoots: readonly string[]; writeRoots: readonly string[]; tools: readonly ToolDefinition[] }>): CccSessionToolPolicy;   // computes toolsetDigest
  // linkedWriter (roleClass "writer" only, verify-v2 item 37): CCC_PLANNING_LINKED_WRITER_TOOLSET, policy id
  // ccc-linked-writer-tools.v1; its fn_complete_phase must be the campaign ready tool (createCccCampaignReadyTool)
export function assertCccSessionToolSet(policy: CccSessionToolPolicy, finalTools: readonly ToolDefinition[]): void;
  // equality of names and digest after pi.ts:4043-4071 wrapper chain, AND every "grep"/"find"/"ls"/"read" definition
  // carries CCC_CONFINED_TOOL_MARK (so Pi's own grep can never satisfy the name); else CCC_SESSION_TOOL_POLICY_REFUSED
// With a toolPolicy, createFnAgent ignores options.tools and builtinToolsAllowlist, builds only policy tools from
// cccConfinement and the Fusion tools below, skips host extensions, plugin skills and RTK, and REFUSES any mcpServers,
// out-of-policy custom tool, toolsAllowlist or builtinToolsAllowlist entry.

// packages/engine/src/ccc-confinement/confined-fs-tools.ts (C2)
export const CCC_CONFINED_TOOL_MARK: unique symbol;
export function createCccConfinedFsOperations(i: Readonly<{ readRoots: readonly string[]; writeRoots: readonly string[];
  deniedNames: readonly string[] }>): CccConfinedFsOperations;
  // realpath every path; refuse outside roots, "..", absolute escapes, symlinks resolving outside, denied names;
  // find.glob is implemented here in TypeScript, so Pi never calls ensureTool("fd").
  // E2-7: write and edit call X1's cccConfinedWriteRefusal({path, writeRoots, deniedNames:
  // cccConfinedEffectiveDeniedNames(deniedNames)}), so they refuse a .git path segment and every effective denied name
  // exactly as the confined shell does

// packages/engine/src/ccc-confinement/confined-grep-tool.ts (C2, new; D11)
export function createCccConfinedGrepTool(i: Readonly<{ fs: CccConfinedFsOperations; readRoots: readonly string[];
  deniedNames: readonly string[]; limits: Readonly<{ maxFiles: number; maxBytesPerFile: number; maxMatches: number }> }>): ToolDefinition;
  // name "grep"; Pi-compatible parameters (pattern, path?, glob?, ignoreCase?, literal?, context?, limit?);
  // walks with the confined ls/read operations only; never spawns a process and never calls ensureTool("rg");
  // its path filter calls X1's cccConfinedWriteRefusal too (E2-7), with writeRoots: readRoots, so only the .git and
  // denied-name checks apply. C2 validates its denied names against [A-Za-z0-9._*-] before the call, because the
  // predicate throws a plain Error on an invalid name (E4-10)

// packages/engine/src/ccc-confinement/submit-artifact-tool.ts (C2)
export function createCccSubmitArtifactTool(i: Readonly<{ allowedKinds: readonly CccPlanningArtifactKind[];
  contentSchemas: Readonly<Record<string, (value: unknown) => readonly string[]>>;   // validator -> problems
  onSubmit: (s: Readonly<{ kind: CccPlanningArtifactKind; contentSchema: string; content: CccPlanningArtifactContent;
    status: CccPlanningArtifactStatus }>) => Promise<CccPlanningArtifactRef> }>): ToolDefinition;   // name "ccc_submit_artifact"

// packages/engine/src/ccc-confinement/verdict-tool.ts (C2)
// CccReviewFindingRef and CccReviewVerdict are imported from @fusion/core (K1 types.ts, section 2.10; verify-v2 item 34)
export function createCccVerdictTool(i: Readonly<{ requirementIds: readonly string[] | null; artifactKeys: readonly string[];
  reviewedPaths: readonly string[] | null; onVerdict: (v: CccReviewVerdict) => Promise<CccPlanningArtifactRef> }>): ToolDefinition;
  // name "ccc_submit_verdict"; refuses: accept with any blocking finding; a requirement ref when requirementIds is null
  // or the id is unknown; an artifact/source ref outside the session's inputs; path outside reviewedPaths;
  // summary > 600; second call

// packages/engine/src/ccc-confinement/probe-echo-tool.ts (C2, new)
export function createCccProbeEchoTool(i: Readonly<{ expected: Readonly<Record<string, string>>;
  onObservation: (o: Readonly<{ exact: boolean; received: unknown }>) => void; abortTurn: () => void }>): ToolDefinition;
  // name "ccc_probe_echo"; strict schema; records the observation and aborts the turn so no follow-up call is made
export function wrapCccProbedTool(tool: ToolDefinition, i: Readonly<{ probe: string;
  onObservation: (o: Readonly<{ probe: string; toolName: string; params: unknown; result: "ok" | "error"; detail: string }>) => void;
  abortTurn: () => void }>): ToolDefinition;
  // verify-v2 item 39: same name, parameters and CCC_CONFINED_TOOL_MARK as `tool`; runs it (the exact-edit probe needs the
  // real edit), records the observation, then aborts the turn, so the tool result never triggers a follow-up model call.
  // C6 wraps EVERY tool of a probe session, so any tool call ends the probe

// packages/engine/src/ccc-confinement/confined-shell.ts (X1; X1c is its successor owner in the W1 residual, E4-X):
// ADR C Q3, reusing ccc-campaign-proof-sandbox.ts
export type CccSealedExecutable = Readonly<{ path: string; sha256: string; name?: string }>;
  // E2-25: name matches ^[A-Za-z0-9._+-]{1,64}$. The clone file is named name ?? basename(path), so GNU coreutils
  // `gcat` can appear as `cat`; a duplicate effective name refuses toolchain-digest-drift. An Apple platform binary
  // refuses platform-binary-in-toolchain, never toolchain-digest-drift
export type CccSealedToolchain = Readonly<{ bash: CccSealedExecutable; sh: CccSealedExecutable; node: CccSealedExecutable;
  git: CccSealedExecutable & Readonly<{ execPath: string }>; utilities: readonly CccSealedExecutable[]; toolchainSha256: string }>;
  // E4-X item 4: CccSealedToolchain gains a field only if sealCccToolchain computes it; callers never build one by hand.
  // X1c's round-1 bytes (6782c1004) add `libraries: readonly CccSealedLibrary[]`, every library the clone copies (such as
  // Homebrew node's lib/libnode.*.dylib), computed and hashed by sealCccToolchain; X1b's base carries them (E6-B). Such
  // an output field is exception (iii) of X1c's frozen rule below (F6)
export type CccToolchainUtilitySpec = string | Readonly<{ path: string; name?: string }>;
export async function sealCccToolchain(i: Readonly<{ bash: string; sh: string; node: string; git: string;
  utilities: readonly CccToolchainUtilitySpec[] }>): Promise<CccSealedToolchain>;
  // An X1 export since round 2; X1's final repair widened utilities from readonly string[] to
  // readonly CccToolchainUtilitySpec[] (E2-25) and added CccToolchainUtilitySpec (F1). Its input shape is frozen while X1b
  // and X1c run side by side (E4-X); X1b builds every toolchain through it (E4-B). A utility given as {path, name} appears
  // in PATH as name (E2-25). The sh role always appears in PATH as sh, so `sh` takes no name (F4)
export type CccConfinementLimits = Readonly<{ wallMsCeiling: number; cpuSeconds: number; fileSizeBlocks: number;
  maxOutputBytes: number; maxReapPasses: number }>;   // 600_000, 600, (512-byte blocks), 1_048_576, 20
  // E7 (X1c residual): the wrapper sets ulimit -t and ulimit -f but not ulimit -u (section 6 risk 53)
export type CccConfinedShellInput = Readonly<{
  profileId: "ccc-writer-shell.v1"; worktreeRoot: string; gitDirs: readonly string[]; writeRoots: readonly string[];
  deniedNames: readonly string[]; deniedRoots: readonly string[]; scratchRoot: string; toolchain: CccSealedToolchain;
  taskEnv: Readonly<Record<string, string>>; loopbackPort?: number; limits: CccConfinementLimits;
  qualification: Readonly<{ receiptSha256: string; profileTemplateSha256: string; osBuild: string }>;
}>;
// loopbackPort comes from acquireCccSemanticProofLoopbackPort (ccc-campaign-proof-sandbox.ts:21); readiness from
// inspectCccSemanticProofSandboxReadiness (:87); spawn, limits and reap reuse the runner pieces behind
// runCccSemanticProofSandboxedProcess (:547). X1 exports helpers from that file; it changes no behaviour there.
//
// Closure authority: controller-side sweep (E1-18, ADR X1-R; D12 note). An in-sandbox reaper cannot be the closure
// authority, because a confined command can kill or freeze it ((allow signal (target same-sandbox))).
// - Unique per-instance toolchain. Each operations instance clones the sealed toolchain into its own directory
//   <scratchRoot>/toolchains/<instanceId>/bin/ (E2-24) with APFS clonefile (fs.copyFile with COPYFILE_FICLONE, falling
//   back to a full copy across volumes). Before the first exec each clone's sha256 must equal its sealed sha256, else
//   toolchain-digest-drift (E2-24). process-exec is allowed only under that directory. Hard links and symlinks of those
//   binaries into a write root are refused or cannot be executed; deny them explicitly if needed.
//   Seal coverage (E4-X item 4): the toolchain digest, the post-clone hash check and the per-exec drift check cover every
//   file the clone copies, including lib/*.dylib such as libnode, not only PATH-named executables. A per-exec check may
//   compare size, mtime and inode, provided the full hash runs at seal time and after the clone; a cloned file that
//   changes after sealing refuses toolchain-digest-drift.
// - Sweep. After every exec, including the error, timeout and qualification-failure paths, the controller enumerates
//   from outside the sandbox every same-uid process whose executable lies in that directory. First choice is
//   `lsof -a -d txt -F p +d <dir>` through a supervised async spawn; probe first and pick the method that argv[0]
//   spoofing (exec -a) cannot fool. The sweep spawns /usr/sbin/lsof by absolute path, never by PATH lookup (E2-22).
//   lsof stalls (E6-X item 5): bursts of scans hit the 11 s capture limit while an unreachable smbfs Time Machine mount
//   (/Volumes/.timemachine/...) is present on this host. X1c measures lsof -b (no blocking kernel calls), -e <mount> for
//   each network mount read from `mount` (smbfs, nfs, afpfs, webdav) and one bounded retry of a timed-out scan, and applies
//   what removes the stall without weakening the sweep-trust rule: the scan still parses, still lists the controller's
//   own pid and still sees clone inodes, and a test proves that with the chosen flags. The host is not changed (no
//   unmount). The stall rate before and after and the flags chosen go in the card header and section 6 risk 49.
//   Outcome (E7, X1c accepted at c16d103bf): X1c chose lsof -b from the mechanism (lsof's mount-point stat, with its
//   15 s -S default, exceeds the 11 s capture limit), not from a measured stall; the smbfs mount was gone during repair
//   1, so the after-rate is inferred. Any stall still fails closed (section 6 risk 54).
// - Kill order. SIGSTOP every match, re-scan until no new pid appears, SIGKILL all, then verify none remain. Rounds are
//   bounded.
// - Sweep trust (E4-7). The exit status of the lsof sweep never decides the outcome. A sweep is trusted only if its
//   output parses and lists the controller's own pid. Any other result, including exit 1 with empty stdout, means
//   closure-sweep-unavailable or unconfirmed, never clean.
// - Outcomes. A trusted sweep that converges to zero confirms closure even when the reaper died or froze. One that does
//   not converge, or a sweep that is not trusted, throws CccConfinementClosureError (unconfirmed), never a confirmation
//   (E2-22, E4-7). Before refusing as unconfirmed, the controller SIGKILLs every pid the reaper reported stopping, after
//   the E2-26(c) foreign-pid filter, so no stopped orphan outlives the exec (E4-X item 8). WR performs the quarantine at
//   its call site (E2-5), latching the first closure error through a wrapper (E4-3); E1-18's listener-closing clause is
//   dropped (E2-5).
//   That orphan kill is best effort (E6-X item 1): a failure in it is caught and recorded in the error message, and it
//   never replaces the closure error. The exec always throws CccConfinementClosureError when the sweep did not converge
//   or the reaper frame is unsandboxed, and execOnce sets the instance's unconfirmed latch directly at that point, not
//   from the error class in operations.exec.
//   On the unconfirmed path the sweep failed, so the foreign-pid filter cannot use it (F3, E6-X item 3). It kills a
//   reaper-reported pid only if the pid has the same uid, is stopped, has a start time (ps -o lstart=) no earlier than
//   this exec's start, and has an executable path inside the instance clone directory, read in a way exec -a cannot
//   spoof. If macOS gives no such path without lsof, the filter uses the first three conditions only, and a test shows
//   that an older stopped same-uid process the test owns, stopped before the exec started, is not killed.
// - The in-sandbox reaper stays as a fast first line.
// - Execs on one operations instance are serialized, so the last-closure record and the shared scratch home and tmp stay
//   unambiguous (E1-20).
export const CCC_CONFINED_DEFAULT_DENIED_NAMES: readonly string[];
  // the set {".agentsecrets", ".env", ".env.*", ".envrc", ".npmrc", "_secrets"}, listed in code order (F9; the set is
  // E4-8's, and X1's final repair added ".envrc"), a superset of K1 CCC_PLANNING_DENIED_NAMES (E2-81). The consistency test is X1c's
  // packages/engine/src/__tests__/ccc-confined-denied-names.test.ts, listed in cards/x1c.mjs (E4-8)
export function cccConfinedEffectiveDeniedNames(callerNames: readonly string[]): readonly string[];
  // the union with the defaults, de-duplicated; a caller cannot remove ".env" (E1-20, E2-23)
export function cccConfinedWriteRefusal(i: { path: string; writeRoots: readonly string[]; deniedNames: readonly string[] }):
  null | "outside-write-roots" | "git-segment" | "denied-name";
  // E2-23: resolves the path and checks containment in the write roots, any .git segment and every effective denied name
  // (the basename or any segment); name comparison folds case with K1's key (E2-40; E2-40a since E6-X item 6). X1's own
  // profile and validation use these exports, and so do C2's write, edit and grep path filter (E2-7)
  // E6-X item 6: the name comparison uses K1's cccPlanningPathComparisonKey from @fusion/core in place of
  // confined-shell.ts's private copy of the E2-40 fold, so it carries the E2-40a form K1b put on integration at INT-2b
  // (U+1E9E closed): a caller-added denied name ".ssh" refuses a write to a not-yet-existing ".ẞh" path
export function buildCccWriterShellDarwinProfile(input: CccConfinedShellInput): Promise<Readonly<{ profile: string; profileSha256: string }>>;
  // E1-20: writes to any path with a .git segment inside a write root are denied, and the template digest also covers
  // deniedNamePattern, sealedEnvironment and the loopback rule. E2-24: writes to <scratchRoot>/toolchains/ are denied even
  // though it sits under the scratch root
export const CCC_WRITER_SHELL_PROFILE_TEMPLATE_MATERIAL: readonly string[];
  // E4-X item 7: includes SYSTEM_RUNTIME_READ_ROOTS, DEVICE_READ_FILES and every input of the writer-profile assembly, so
  // widening any of them changes the template digest
  // E6-X item 7: the dylib-closure discovery is covered too. Either the rules of darwinLinkedRuntimeFiles,
  // resolveLinkedPath and the read-root derivation (in ccc-campaign-proof-sandbox.ts, where X1c's grant is helper exports
  // only, with no behaviour change) join this material, or the qualification receipt records the digest of the fully
  // rendered profile, discovered read roots included, so a widened read root changes a recorded digest; a test either way
  // E7 (X1c residual): the template digest binds function source text, so it differs between the vitest transform, tsc
  // dist and each tsup bundle. A qualification receipt is valid only for the build that produced it, and G0 records the
  // digest of the build under test (section 6 risk 52).
export type CccConfinedDisposeResult = Readonly<{ closure: "confirmed" | "unconfirmed" }>;   // E4-9, X1c
export function createCccConfinedBashOperations(input: CccConfinedShellInput, testOnly?: Readonly<{ lsofPath?: string }>):
  BashOperations & { dispose(): Promise<CccConfinedDisposeResult> };
  // E2-24: dispose is idempotent, removes this instance's clone directory with fs.rm on that exact directory, and makes
  // later execs refuse (reason instance-disposed). E2-22: creation checks that /usr/sbin/lsof exists and is executable,
  // else CccConfinementRefusedError("closure-sweep-unavailable"); tests reach a stub lsof through testOnly.lsofPath.
  // E4-X item 5: testOnly accepts only { lsofPath? }; any other key, sealedEnvironment included, throws TypeError. The
  // environment seam stays only on qualifyCccConfinedShell (E2-11).
  // E4-X item 6, E4-9: dispose returns { closure: "unconfirmed" } when its final sweep does not converge or any earlier
  // exec ended CLOSURE_UNCONFIRMED, else { closure: "confirmed" }; a repeated call returns the same result.
  // E6-X item 2: dispose also returns { closure: "unconfirmed" } when its final sweep found and killed any instance
  // process, because a survivor proves that an earlier confirmation was wrong.
  // The only exported-signature changes X1c may make are (i) the dispose result, (ii) the narrowed testOnly, and (iii)
  // output fields of CccSealedToolchain that only sealCccToolchain computes (E4-X item 4; F6). Input shapes stay frozen
  // (E4-X, frozen for X1b)
// cccConfinedShellLastClosure(operations: BashOperations): CccClosureRecord | null, an X1 export at INT-1b, reads the last
// closure record of the instance it is given. A wrapper (WR's latch, the shell-compat decorator) hides it, so callers
// read it from the inner operations; WR does (E6-B item 6, recorded, not a fix)
export type CccClosureRecord = Readonly<{ passes: number; killed: readonly number[]; persistent: readonly number[] }>;
  // killed lists only pids the controller confirmed as instance processes, whose text segment is in the clone directory
  // (E2-26(c)); a foreign zombie pid never appears
export class CccConfinementRefusedError extends Error { readonly code: "CCC_CONFINEMENT_REFUSED";
  readonly reason: "platform-unsupported" | "sandbox-exec-missing" | "toolchain-digest-drift" | "root-overlap" | "qualification-missing" | "taskenv-not-allowlisted"
    | "closure-sweep-unavailable" | "platform-binary-in-toolchain" | "instance-disposed"; }   // E2-22, E2-25, E4-X item 11
export class CccConfinementClosureError extends Error { readonly code: "CCC_CONFINEMENT_CLOSURE_UNCONFIRMED"; readonly record: CccClosureRecord | null; }
export type CccConfinementQualificationV1 = Readonly<{ schema: "ccc-confinement-qualification.v1"; osBuild: string;
  profileTemplateSha256: string; toolchainSha256: string;
  probes: readonly Readonly<{ probe: "network-denied" | "loopback-port-allowed" | "outside-read-denied" | "sibling-signal-denied" | "denied-name-in-root" | "env-scrubbed" | "escaper-reaped"; passed: boolean }>[] }>;
export async function qualifyCccConfinedShell(i: Readonly<{ toolchain: CccSealedToolchain; scratchRoot: string;
  testOnly?: Readonly<{ sealedEnvironment?: (sealed: Readonly<Record<string, string>>) => Readonly<Record<string, string>>;
    lsofPath?: string }> }>): Promise<CccConfinementQualificationV1>;
  // G0 self-qualification; any failed probe -> CCC_PLANNING_CONFINEMENT_UNQUALIFIED. Never uses kill(-1, ...).
  // Production never passes testOnly (E2-11). The env-scrubbed probe plants its canary in the controller's own
  // process.env (restored in finally) and asserts that the variable names inside the sandbox are a subset of the sealed
  // keys, the taskEnv keys and {PWD, SHLVL, _, OLDPWD} (E1-19). Qualification records the `ESCAPER <pid>` line outside
  // the throwing helper, and its finally kills that pid (E1-20).

// packages/engine/src/ccc-confinement/toolchain-discovery.ts (X1b, new; W1 residual, E4-B)
export function discoverCccToolchain(i: { searchPath?: readonly string[]; required?: readonly string[];
  optional?: readonly string[] }): Promise<CccSealedToolchain>;   // E6-0: searchPath optional, optional set added
  // E4-B, E4-5: the one toolchain discovery that G0 (step 11, section 2.18), SF and WR use. It seals only through
  // sealCccToolchain and never passes sealedEnvironment to the factory. A missing required tool throws
  // CccPlanningRefusal("CCC_PLANNING_CONFINEMENT_UNQUALIFIED", "toolchain-missing:<tool>"). `sh` is passed as
  // sealCccToolchain's sh path, which always appears in PATH as sh; its source is Homebrew dash if present, else Homebrew
  // bash (E4-15), and no name field is passed (F4, E6-B item 7)
  // E6-0, the default sets: `required` defaults to the minimal set every Fusion command needs, bash, sh, node, git, task,
  // rg and the GNU coreutils. `optional` defaults to GNU grep, sed, findutils, gawk and diffutils: each is sealed under its
  // unprefixed name when found and silently left out when not. The qualification receipt and the planning prompts can name
  // the missing optional tools; a later card that needs one asks the operator, once, to install it. The host is not
  // changed (no brew install).
  // E6-0, the default search path is Homebrew only: /opt/homebrew/bin, then the opt/<formula>/bin and libexec/gnubin
  // directories of the formulae the catalogue names. User-writable directories (~/.local/bin, ~/go/bin, ~/.cargo/bin and
  // the like) are never on it; a caller may still pass an explicit searchPath. whoami is not in the catalogue, because it
  // fails inside the sandbox.
  // E8-X item 1 (card X1z): searchPath is really optional, defaulted inside the function:
  // const searchPath = i.searchPath ?? cccToolchainDefaultSearchPath(); At INT-2d the implementation still requires it
  // and throws a TypeError on {}, while G0 step 11, SF and WR call discovery with its defaults. A searchPath that is
  // present but malformed still throws that TypeError. discoverCccToolchain({}) seals the same toolchain digest as
  // { searchPath: cccToolchainDefaultSearchPath() }, and a type-level assertion pins {} as an accepted input. X1z is
  // accepted before W4 (SF).

// packages/engine/src/ccc-confinement/shell-compat.ts (X1b, new)
// F5: exports a BashOperations decorator that prefixes each command with the package-command dispatcher setup (BASH_ENV
// and npm_config_script_shell exported inside the command, the dispatcher in a read-admitted path), because X1's taskEnv
// check refuses those keys (taskenv-not-allowlisted). SF and WR apply it. go-task runs Taskfile cmds in its own shell, so
// neither the BASH_ENV dispatcher, command_not_found_handle nor bash's exec builtin applies there (E6-0; section 6 risk 51)
// E8-X item 2 (card X1z): the decorated operations keep the raw shell's dispose (disposing through the decorator
// returns the raw shell's closure result), so the dispose duty of SF and WR (E4-9) reaches the confined shell; a test
// pins it, and mutant X2 (return { exec } as unknown as T) must fail it.
```

### 2.14 Research fetch (card C5)

This is ADR C Q4 verbatim: `CccResearchSourcePolicy`, `CccResearchCitation`, `CccResearchFetchRefusedError` (reasons `scheme | host-not-allowlisted | path-not-allowlisted | blocked-address | redirect-not-allowlisted | too-many-redirects | mime | grant-exhausted | timeout`), `fetchCccResearchSource`, `createCccResearchFetchTool` and `createCccCitationReadTool`. The one change is that `CccResearchGrantPort` is implemented by L1's `reserveCccPlanningResearchFetch` and `settleCccPlanningResearchFetch`, bound to the node's fence:

```ts
export interface CccResearchGrantPort {
  reserve(i: Readonly<{ runId: string; nodeId: string; nodeAttempt: number; maxRawBytes: number }>): Promise<Readonly<{ grantKey: string }>>;
  settle(i: Readonly<{ grantKey: string; rawBytes: number; outcome: "fetched" | "refused" | "failed" }>): Promise<void>;
}
```

Every resolved address is checked against `address-blocklist.ts`, which covers loopback, link-local, private, CGNAT, multicast, TEST-NET and the IPv6 equivalents, at connect time. Each citation is published as kind `citation` (the stage is `research`, the slot is the first 20 hex characters of the citation id).

### 2.15 Model quirks: degenerate output, tool-fidelity preflight, pins (cards C6, C6b)

These are ADR C Q5 and 5.2, with these changes:
- `CccDegenerateOutputObserver` and `detectCccDegenerateMessage` satisfy P1's `CccStreamGuard` through `createCccStreamGuard(limits)`. The limits are placeholderMax 3, zeroWidthRatioMax 0.5 per 4 KiB, deflateRatioMin 0.05 per 16 KiB and textOnlyStreakMax 2. The fixtures come from existing evidence (M3 `content: ""` with everything in `reasoning_content`); no new model call is made to build the guard.
- `runCccToolFidelityPreflight` runs the three qualification lineages of section 2.7 inside IR stage `preflight`, in the order writer, critic, researcher. Each lineage is one session under one turn key with at most 3 calls (identity, strict-echo, and exact-edit, verdict-shape or citation-read). The identity probe passes only when the terminal route receipt's resolved model equals the pinned model. Its `CccToolFidelityReceipt` (`schema "ccc-tool-fidelity.v1"`, `piVersion "0.81.1"`, both toolset digests per lineage, per-probe observation) is published as `tool_fidelity_receipt`. Any failure sets state `blocked_provider` with `CCC_BLOCKED_PROVIDER` and no planning node runs.
- **No raw M3 probe in I1 or W0** (challenge 19, deferred by ruling): no model call is made outside a receipt-bound run. The first M3 tool call of the programme is `preflight:critic` in the LIVE run, at most 3 calls, before any planning node spends.
- `assertCccProviderPinned` throws `CCC_PROVIDER_PIN_DRIFT` with one of these reasons: `missing | not-loopback | api-key-present | model-count | model-id | provenance-present | sync-enabled | digest`. P1 calls it at `pi.ts:3544` through `cccProviderPinCheck`.
- C6b adds `modelSync?: "disabled"` to `CustomProvider` (`packages/core/src/types/workflow-steps.ts`). Refresh-all skips and counts such providers, the single refresh returns 409, and both parsers carry the field.

### 2.16 Native host and stage contract (card H1)

These are ADR A Q1 signatures, with stage ids replaced by section 2.4:

```ts
// packages/engine/src/workflow-work-processor.ts and workflow-task-runtime.ts (H1)
export type WorkflowWorkCustodyKind = "campaign" | "planning";
// WorkflowWorkProcessorOptions.custody?: WorkflowWorkCustodyKind (campaignRequired: true aliases "campaign")
// WorkflowWorkProcessorStore.getCccPlanningRunForTask?(taskId): Promise<CccPlanningRunCustody | null>
// WorkflowTaskRuntimeDeps.runCccPlanningStage?: WorkflowNodeHandler  (gate nodes with config.cccPlanningStage)
export const CCC_PLANNING_HOLD_CONTEXT_KEY = "ccc:planning:hold" as const;   // processor maps it to work item state "held"

// packages/engine/src/ccc-planning/ports.ts (H1)
export interface CccPlanningLedgerPort { /* the L1 functions of 2.11, bound to one layer */ }
export interface CccPlanningArtifactPort { /* the A1 functions of 2.6, bound to one layer */ }
export interface CccPlanningSessionFactory {
  open(i: Readonly<{ run: CccPlanningRunCustody; stageId: CccPlanningStageId; roleId: CccPlanningRoleId; lineageId: string;
    nodeAttemptOrdinal: 1 | 2 | 3; phase: "planning" | "review_proof"; fence: CccPlanningWorkItemFence;
    inputs: readonly CccPlanningArtifactRef[]; readSnapshot: CccPlanningReadSnapshot; preflight?: boolean;
    signal: AbortSignal }>): Promise<CccPlanningSession>;
}
export interface CccPlanningSession {
  readonly binding: CccPlanningRouteBinding;
  run(prompt: string): Promise<Readonly<{ submitted: readonly CccPlanningArtifactRef[]; verdict: CccReviewVerdict | null }>>;
    // CccReviewVerdict comes from @fusion/core (K1, verify-v2 item 34), never from C2's engine module
  dispose(): Promise<void>;
}
export interface CccPlanningDescendantRegistry {
  register(handle: Readonly<{ id: string; cancel(reason: Error): Promise<void> }>): () => void;
  cancelAll(reason: Error): Promise<void>;   // resolves only after every handle settled
}
export interface CccPlanningStageContext {
  readonly run: CccPlanningRunCustody; readonly stageId: CccPlanningIrStageId; readonly fence: CccPlanningWorkItemFence;
  readonly signal: AbortSignal; readonly ledger: CccPlanningLedgerPort; readonly artifacts: CccPlanningArtifactPort;
  readonly sessions: CccPlanningSessionFactory; readonly descendants: CccPlanningDescendantRegistry;
}
export type CccPlanningStageOutcome =
  | Readonly<{ kind: "committed"; artifactKeys: readonly string[] }>
  | Readonly<{ kind: "awaiting-intent"; decisionId: string }>
  | Readonly<{ kind: "blocked"; state: "blocked_prerequisite" | "blocked_provider" | "budget_exhausted"; code: string }>
  | Readonly<{ kind: "unknown-effect"; attemptKeys: readonly string[] }>
  | Readonly<{ kind: "rejected"; code: string }>                     // terminal failed
  | Readonly<{ kind: "skipped"; reason: "spec-mode" | "no-repair-claimed" }>;
export type CccPlanningStageFn = (ctx: CccPlanningStageContext) => Promise<CccPlanningStageOutcome>;

// packages/engine/src/ccc-planning/controller.ts (H1)
export function createCccPlanningStageHandler(i: Readonly<{ stages: Readonly<Record<CccPlanningIrStageId, CccPlanningStageFn>>;
  ledger: CccPlanningLedgerPort; artifacts: CccPlanningArtifactPort; sessions: CccPlanningSessionFactory;
  now?: () => number }>): WorkflowNodeHandler;
  // before each stage, in order: (1) assertCccRunningRuntimePermitted (D44) -> blocked_prerequisite RUNTIME_NOT_PERMITTED;
  // (2) the stored work item irHash equals cccPlanningWorkflowIrHash(buildCccPlanningWorkflowIr(mode)) -> else failed
  // WORKFLOW_IR_DRIFT; (3) any dispatched_unknown call in the run -> unknown_effect, lineage never re-dispatched (D3);
  // (4) apply pending control at a safe point; (5) wrap every session attempt in its own watchdog (D40), never the stage.
  // A CccProviderRouteReceiptError from any session is mapped to blocked/blocked_provider/CCC_PROVIDER_PIN_DRIFT with no retry.
  // L1's settlement has already moved the run to blocked_provider in the refusing call's transaction (verify-v2 item 42),
  // so the handler only reads that state back; it never makes a second transition.
export async function settleCccPlanningRun(i: Readonly<{ descendants: CccPlanningDescendantRegistry;
  flush: () => Promise<void>; release: () => Promise<void>; completeCancellation: () => Promise<void>; reason: Error }>): Promise<void>;
  // strictly cancelAll -> flush -> release -> completeCancellation (L1 completeCccPlanningCancellation, D45)

// packages/engine/src/ccc-planning/recovery.ts (H1)
export async function recoverCccPlanningRuns(i: Readonly<{ store: TaskStore; now?: string; ports?: CccPlanningLinkedOutcomePorts }>):
  Promise<ReadonlyArray<Readonly<{ runId: string; outcome: "cancellation-completed" | "unknown-effect" | "campaign-reconciled" | "none" }>>>;
  // engine start only: completeCccPlanningCancellation for cancelling runs, ports.reconcileLinkedOutcome for linked runs
  // (verify-v2 item 35: H1 is W3 and BF is W6, so H1 never imports BF; WR passes BF's reconcileCccPlanningCampaignOutcome;
  // without the port a linked run reports "none"), and dispatched_unknown -> unknown_effect. Expired leases are NOT requeued here: the existing acquire path
  // reclaims them (workflow-workitems-ops-2.ts:243-262).

// packages/engine/src/ccc-planning/runtime-digest.ts (H1)
export async function computeCccRuntimeDistManifestSha256(distRoot: string): Promise<string>;
  // sha256(canonical(sorted [relPath, sha256] of dist/**/*.js)), the ADR D installed-receipt algorithm
export async function registerCccRunningRuntimeAtEngineStart(i: Readonly<{ distRoot: string | null }>): Promise<void>;
  // called by in-process-runtime.ts at start; distRoot null (source run) registers nothing, so planning work refuses
```

- The workflow IR builder and hash live in core (K1, 0.23); H1 only verifies them.
- The stage registry `packages/engine/src/ccc-planning/stages/index.ts` (parent-owned) exports `CCC_PLANNING_STAGES: Readonly<Record<CccPlanningIrStageId, CccPlanningStageFn>>`.
- `readSnapshot` (SF, D37): `admitted-base` archives `run.admittedBase`; `candidate` first requires `git rev-parse <commit>^{tree}` to equal `tree`, then archives `commit`. Each snapshot excludes `.git` and every denied name. Planning roles always get `admitted-base`; G7 gets the writer task's proof-gate candidate; G8 gets the integrated candidate.

### 2.17 Import preflight, packet, proposal, fidelity, gates, baseline and import bridge (cards B2, B3, B4, IB1, GG, VP, IB2)

These are ADR B Q2-Q4 verbatim, with these frozen changes:
- `cccPlanningImportKey(runId, revision)` returns `${runId}:r${revision}`. It lives in K1 `policy.ts`, not in `import-bridge.ts`.
- `CccPlanningImportBridgeInput.fence` has type `CccPlanningWorkItemFence` (kind `"planning"`).
- **Bridge order** (IB2), each step idempotent on restart:
  1. Load `spec_ready` and require its closure digest to equal the reviewed artifacts (else `REVIEWED_BYTES_DRIFT`).
  2. Build the packet and proposal (IB1) and compile the bundle. Require bundle schema v2, execution policy `ccc-campaign.execution-policy.v2`, and exactly one task-phase proof gate per provider task (`importer.ts:784-785, 936-949`); else `failed` / `CCC_PLANNING_GRAPH_INADMISSIBLE`.
  3. Route admission (K2) on every writer route and the planned G7 and G8 review identities; any refusal, K2's `CCC_ROUTE_IDENTITY_REJECTED` included (for example `role-model-mismatch` on a route that mixes product-route keys with `routeKind`, E8-0, N-4), returns `refused` with `CCC_PLANNING_ROUTE_NOT_ADMITTED`. The bridge builds a G8 identity only for the judge task (E8, K2 residual; IB2 rule).
  4. Build fit (K1 `assessCccBuildFit`, `providerTasks = T`, `modelProofNodes = 0`, `campaignCriticalPathMs` from GG's schedule simulation). A shortfall moves the run `importing → budget_exhausted` with `CCC_PLANNING_BUILD_FIT_INSUFFICIENT` (the 65th pair, verify-v2 item 38) and reserves nothing.
  5. Bounds: if an `admission_facts` artifact exists for this revision, reuse its `bounds`; otherwise compute them once at `boundsComputedAt = db_now` (D16) and publish `admission_facts` with them. `maxDurationMs` is clamped to the run's remaining time, `run.deadline_at − boundsComputedAt − 30 s`, recorded as a clamp with reason `deadline-headroom`; a non-positive result is a build-fit time shortfall handled as in step 4 (verify-v2 item 49). Then publish `packet_manifest`, `sidecar`, `bundle` (whose `bounds` are those bounds) and `execution_plan`.
  6. Baseline (VP `ensureCccPlanningBuildBaseline`, D20): `build_transition` artifact, B1 recreated and checked against the prediction, baseline branch created if absent and checked out. A mismatch parks `blocked_prerequisite` / `CCC_PLANNING_BUILD_BASELINE_MISMATCH`.
  7. Shared preflight (B3 `preflightCccPrdProductTarget`) against the target, whose HEAD is now B1 (`prd.ts:2110-2115`).
  8. IM1 `recordCccPlanningImportIntent` (anchor CAS and `import_intent` artifact together; limits must equal `bundle.bounds`).
  9. Importer with `limits` from the intent, then IM1 `linkCccPlanningImport`, then AU2 `releaseCccPlanningLiveExecution`; the state moves to `building` or `awaiting_execution_authority`.
- RECONCILE also accepts `inspectCccPlanningImportLink().kind === "intent-only"` as "intent exists". Before the importer is called a second time, it re-runs step 7 if the target HEAD moved (B's time-of-check rule).
- `CccPlanningImportBridgeResult.parked` maps to state `blocked_prerequisite` with the parked code. `refused` maps to `failed`.
- The authoring adapter id is `ccc-planning.full-v2:<runId>:r<n>`. `authoringModel` is the sorted, `+`-joined set of `resolvedModel` values from the producer envelopes.
- Graph admission (B2) is `diagnoseCccPrdProductGraphAdmission(input: CccPrdProductGraphAdmissionInput): CccPrdDiagnostic[]` in `compiler.ts`, and `compileCccPrdPacket` calls it.
- The packet writer (B4) is `writeCccPrdPacketFiles` in `packages/engine/src/ccc-prd/intake.ts`.
- G4 (GG) is `runCccPlanningG4(i: { taskPlan: CccPlanningTaskPlanV1; proposal: CccPrdAuthoringProposalV2; sources: {originalRequest, admissionFacts, finalPrd, technicalAnnex}; acceptanceCases; requirementMap }): readonly CccPrdDiagnostic[]`. It is pure, the caller builds the proposal with IB1, and it now also runs:
  - `simulateCccPlanningSchedule(taskPlan, policy): { campaignCriticalPathMs; order; diagnostics }` (`schedule-simulation.ts`): every task schedulable at `maxConcurrency` 1 in dependency order, and the critical path used by G6;
  - `checkCccPlanningProofCommands(taskPlan, verifierBundle): diagnostics` (`proof-command-policy.ts`, verify-v2 item 41). It mirrors the semantic-proof custody rules (`semantic-proof-custody.ts:29, 211-229, 266-292, 297-350, 1266-1330`), so a plan that G4 accepts cannot be refused later by the importer's custody check:
    - every proof command is exactly `task verify:<name>`, and `verify:<name>` is declared in the baseline `Taskfile.yml` with one literal command `node <harness> <candidate…>`;
    - the verifier closure (`Taskfile.yml` as the one `task_runner`, the one `harness`, any fixtures) lies inside the VP verifier bundle committed at B1, which is the base commit the custody check reads it from;
    - no closure path is the same as, inside, or above any model write root of any task;
    - every candidate path lies inside the task's own write roots, and no candidate is also a closure path;
    - writer tasks own only `src/**` and `bin/**`; a task that owns a test, fixture or `Taskfile.yml` path is refused;
    - every path comparison above uses K1 `cccPlanningPathComparisonKey` (as amended by E2-40 and, through K1b, E2-40a; E4-K), so an equivalent spelling (case, NFC/NFD, `./`) is treated as the same path (E2-13).
    Each violation is a diagnostic with the existing code `CCC_PLANNING_GRAPH_INADMISSIBLE` and a detail naming the proof id, the rule and the path, so K1's code list is unchanged.
  - the semantic-id collision check (E8-0, N-3): dispatch counters are keyed by lineage id alone (E7-L item 8(b)), so G4 refuses a plan any of whose semantic task ids would form a G7 lineage id `review:<id>` equal to a planning fixed lineage id of section 2.1 (`${stageId}:${roleId}`, `research:leaf-${n}`, `research:leaf-reviewer`, the preflight ids, `judge:final`), for example semantic task id `product-adversary`, whose `review:product-adversary` is the review-stage critic's lineage. The diagnostic's detail names the colliding id. Editor's note: E8 names no code; this check uses `CCC_PLANNING_GRAPH_INADMISSIBLE`, as G4's other graph diagnostics do, so K1's code list is unchanged.
- G3 objections (GG `objections.ts`, pure): `cccPlanningObjectionsFromVerdict(verdict, {stageId, reviewerRoleId, reviewedRef}) → CccPlanningObjectionV1[]` and `assessCccPlanningObjectionDispositions(objections, decisionRecords) → CccPrdDiagnostic[]`. A blocking objection is resolved only by a `decision_record` with disposition `accepted` (fixed in the reviewed closure) or `rejected` (with at least one evidence ref); `deferred` resolves advisory objections only. Otherwise `CCC_PLANNING_OBJECTION_UNRESOLVED`.
- G5 (VP, D46): `runCccPlanningOracleGate(i: { verifierBundle; controls: readonly {requirementId; files}[]; b0Snapshot; sandbox: { run: typeof runCccSemanticProofSandboxedProcess; readiness: typeof inspectCccSemanticProofSandboxReadiness } })`. Order: readiness (not ready → `blocked_prerequisite` / `SANDBOX_UNAVAILABLE`); run on B0 (zero tests, a load or syntax error, or a missing file → `ORACLE_SETUP_FAILURE`; any pass → `ORACLE_CONTROL_FAILED`); run each defective control (any pass → `ORACLE_CONTROL_FAILED`; a failure without a `[REQ-x]` tag matching the control's requirement → `ORACLE_CONTROL_UNTAGGED`). G5 failures are review rejections: ST2 claims a repair chunk for the verifier author when the fit and inherited caps allow, otherwise the run fails with the G5 code.
- Content schemas live in K1 `schemas.ts`:
  - `CccPlanningAcceptanceCasesV1`, `CccPlanningRequirementMapV1`, `CccPlanningTaskPlanV1`, `CccPlanningRoutingPlanV1`, `CccPlanningVerifierBundleV1`, `CccPlanningAdjudicationV1`, `CccPlanningSpecReadyV1` (B Q4 verbatim, including `verifierBaseline.predictedCommitOid`), `CccPlanningDecisionRequestV1`;
  - new: `CccPlanningObjectionV1` (`{stageId, reviewerRoleId, severity, ref: CccReviewFindingRef, summary, reviewedRef}`), `CccPlanningDecisionRecordV1` (`{objectionKey, proposal, evidence: CccReviewFindingRef[], objection, discriminatingObservation, disposition: "accepted"|"rejected"|"deferred", remainingUncertainty}`; `evidence` ratified as `CccReviewFindingRef[]` by E1-14), `CccPlanningBuildTransitionV1` (`{schema "ccc-planning.build-transition.v1", b0, predictedCommitOid, branchRef, verifierBundle: ref, specReady: ref}`), `CccPlanningProofResultsV1` (`{sourceCommit, sourceTree, proofIds, phase, results}`). The proof gate's context patch carries only the commit, tree, proof ids and phase (`ccc-campaign-proof-execution.ts:2005-2016`). `results` is read from the settled proof attempts, `listCccCampaignProofAttemptsForCommit` (`proof-attempt.ts:1584`), one entry per proof id: `{proofId, attemptKey, state: "committed" | "proved_failed", resultSuccess, exitCode, durationMs, stdoutSha256, stderrSha256, terminalEnvelopeSha256}` (verify-v2 item 46; K1's schema follows it exactly, E1-8). A proof id with no settled attempt refuses publication. `proofIds` and every `results[].proofId` must match `CCC_PLANNING_PROOF_ID_PATTERN`, and each entry's `state`/`exitCode` consistency mirrors the proof-attempt store exactly (`packages/core/src/.../proof-attempt.ts` near :1131; read it and copy its rule) (E2-43);
  - one validator for each, `validateCccPlanning<Name>(value): readonly string[]`.
- **Paths and proof ids** (K1 `schemas.ts`):
  - `cccPlanningPathComparisonKey(p)` is `posix.normalize(p.normalize("NFC").toLowerCase().toUpperCase().toLowerCase().normalize("NFC"))`, with trailing slashes trimmed as before (E2-40a, K1b; E4-K item 2). On this host's APFS volume, which ignores case and normalization form, it merges every pair the filesystem merges: ẞ/ß/ss (U+1E9E capital sharp s, which the E2-40 formula keyed to `ß` while `ß` and `ss` keyed to `ss`), ς/σ, ﬁ/fi, Kelvin K/k, İ/i̇, NFC/NFD and A/a. The key is idempotent: `key(key(x)) === key(x)`. Its one over-refusal, I/ı, is accepted as fail-closed. History: E1-10's `normalize("NFC").toLowerCase()`, replaced by E2-40's `normalize("NFC").toUpperCase().toLowerCase().normalize("NFC")`, replaced by E2-40a.
  - Task-plan owned paths: overlap across tasks compares the comparison key (E1-10, E2-40). The task-plan validator also refuses a duplicate owned path within one task, any owned path with a `.git` segment, and any owned path whose basename is `.env` or starts with `.env.` (E1-10). Owned paths and write roots also refuse any segment equal, after folding, to a `CCC_PLANNING_DENIED_NAMES` entry (E2-42). The "write root inside owned paths" check uses the comparison key, so `SRC/a.mjs` with owned `src/a.mjs` counts as inside (E2-46). Task-plan `proofIds` must match `CCC_PLANNING_PROOF_ID_PATTERN` (E2-43).
  - Verifier bundle (E1-12): a proof id is its Taskfile name. Each proof is `{id, requirementIds, files, taskfileTask}`; `id` matches `CCC_PLANNING_PROOF_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/u` and `taskfileTask === "verify:" + id`. Remove the root-level `taskfileTask` if item 41 leaves it no use; otherwise document what it names.
  - Verifier bundle file paths and control-file paths are de-duplicated on the comparison key, and they refuse a `.git` segment, a `.env`/`.env.*` basename and any `CCC_PLANNING_DENIED_NAMES` segment, reusing the owned-path reason helper (E2-41).
  - Controls cannot replace the verifier (K1b, E4-K item 4): `validateCccPlanningVerifierBundleV1` refuses a control file whose comparison key equals a verifier bundle file's key or lies inside it. A control that replaces an implementation file outside the bundle is admitted. Recorded residual (E6 K1b verdict): a control path that is a parent directory of a verifier bundle file, or a new file inside a bundle directory, is not refused; this fails closed in practice, because such a control's failure carries no `[REQ-x]` tag (G5 rule (b)).
  - Defence in depth (K1b, E4-K item 5): spec-ready `verifierBaseline.files` go through the E2-41 helper (key de-duplication plus refusal of `.git`, `.env` and denied names), and requirement-map `proofIds` must match `CCC_PLANNING_PROOF_ID_PATTERN`.
  - Denied names match whole segments only, so `.envrc.bak` is admitted. This is an accepted residual, not a RED (E4-K item 6; section 6 risk 48).

```ts
// packages/engine/src/ccc-planning/build-baseline.ts (VP, D20)
export async function ensureCccPlanningBuildBaseline(i: Readonly<{
  layer: AsyncDataLayer; run: CccPlanningRunCustody; specReady: CccPlanningArtifactRef; targetRoot: string;
  fence: CccPlanningWorkItemFence; hooks?: Readonly<{ afterRecord?: () => Promise<void> }> }>):
  Promise<Readonly<{ b1: string; branchRef: string; replayed: boolean }>>;
  // 1 publish build_transition (replay-safe); 2 recreate B1 with GIT_* scrubbed plumbing (the env rule of prd.ts:1673-1694)
  // and require oid === predictedCommitOid, else BUILD_BASELINE_MISMATCH and no ref; 3 git update-ref <branchRef> <B1> ""
  // (create-only); an existing ref at another oid -> BUILD_BASELINE_MISMATCH; 4 check out branchRef (refuse a dirty worktree);
  // main is never moved. Step 4 is skipped when HEAD already equals branchRef at B1.
```

### 2.18 Live-authority receipt, envelope check, release and qualification (cards K2, AU2)

These are ADR D Q3 verbatim (`packages/core/src/ccc-planning/authority.ts` and `qualification.ts`), covering:
- `CCC_PLANNING_LIVE_AUTHORITY_RECEIPT_SCHEMA`, `CccPlanningLiveAuthorityReceiptV1` (every field, including `release` inside `permittedProtectedActions`, `sourceToolPolicy` and `runtime`);
- `computeCccPlanningAuthorityReceiptDigest` and `parseCccPlanningLiveAuthorityReceipt`;
- `CccPlanningQualificationCertificateV1`, `CccPlanningQualificationPort`, `UNQUALIFIED_CCC_PLANNING_QUALIFICATION_PORT` and `decideCccPlanningTargetAdmission`.

There is one frozen change to `assertCccPlanningExecutionAuthorizationWithinReceipt`. It now requires `authorization.idempotencyKey === cccPlanningImportKey(run.runId, run.runRevision)`, so its `run` input carries `runRevision` in place of `finalBundleSha256` for the key. The bundle hash is checked separately against the intent. Every other check in D is unchanged, including that every member is `glm/glm-5.3-flash` on `receipt.omniRoute.providerIds.glm53Flash`, and `maxRequests ≤ implementationCallsRemaining`.

K2's repair 1 (E5-K2) adds these frozen rules to the envelope check (`checkEnvelope`, inside `assertCccPlanningExecutionAuthorizationWithinReceipt`) and the receipt parse:
- Remaining calls (item 1): `run.implementationCallsRemaining` that is not a non-negative safe integer refuses `ENVELOPE_MISMATCH` on field `run.implementationCallsRemaining`.
- Literal member model (item 2): every member's `modelId` equals the literal `"glm/glm-5.3-flash"`, and a receipt whose `models.glm53Flash` is not that literal is refused too.
- Run-to-receipt binding (item 4): `run.runId === cccPlanningRunId({ projectId: receipt.project.projectId, requestDigest: receipt.request.sha256, receiptSha256: input.receiptSha256 })` (K1 `policy.ts`), `receipt.mode === "build"`, and `authorization.maxRequests <= receipt.phaseCallCaps.implementation`. AD1 derives the run id the same way (section 2.11).
- Case-insensitive `.git` ban (item 7): the receipt parse's `isAdmittedFusionPathPattern` bans a `.git` segment case-insensitively, comparing each segment through K1's `cccPlanningPathComparisonKey`.
- Parse scope (item 8, an accepted round-1 deviation): the parse runs the expiry check and the caps check itself, inside G0 step 2, and refuses malformed `budgetProfile` values and every profile other than `full-v2` (`CCC_PLANNING_AUTHORITY_RECEIPT_INVALID`), so while the parse accepts only `full-v2`, CL2's step 6 owns only the large refusal below (E7-0, N1).

K2's repair 2 (E7-K) adds these frozen rules:
- Certificate shape (item 1): `certificateApplies` (`qualification.ts`) returns false unless each of `scope.targetClasses`, `scope.modes` and `scope.profiles` is an array (`Array.isArray`) whose entries are all strings, checked before any `.includes`, so a malformed certificate gives `QUALIFICATION_REQUIRED`, never admission.
- Cap type (item 3): the remaining-calls check requires `typeof cap === "number" && Number.isSafeInteger(cap)`, so a resealed (unparsed) receipt whose `maxRequests` is the string `"3500"` is refused.
- `.git` in changed paths (item 6): `baseline.changedPaths` gets the same case-insensitive `.git`-segment ban as the admitted patterns, so `proof/.GIT/config` is refused.
- Route admission (item 5): review identity by exact shape (section 2.7).
- Items 2 and 4 add pinning tests and change no rule: the deadline row, the single-action guard, the receipt `schema` literal and the UTF-8 `fatal: true` decode (K2 card).

```ts
// packages/engine/src/ccc-planning/live-execution-release.ts (AU2): ADR D verbatim
export type CccPlanningLiveExecutionReleaseResult =
  | { kind: "released"; authorizationId: string; authorizationDigest: string }
  | { kind: "awaiting_operator"; authorizationId: string; confirmation: string;
      reason: "receipt_requires_operator" | "envelope_mismatch"; mismatch?: { field: string; detail: string } };
export async function releaseCccPlanningLiveExecution(i: { store: TaskStore; rootDir: string; entryTaskId: string;
  receipt: CccPlanningLiveAuthorityReceiptV1; receiptSha256: string;
  run: { runId: string; runRevision: number; deadlineAt: string; implementationCallsRemaining: number;
         compiledProviderTaskCount: number; writerProviderId: string };
  observeBaseline: (commit: string) => Promise<{ commit: string; firstParent: string; changedPaths: readonly string[] }>;
  deps?: { issue?: typeof issueCccCampaignLiveExecutionApproval; approve?: typeof approveCccCampaignLiveExecution;
           compute?: typeof computeCccCampaignLiveExecutionApprovalConfirmation };
  hooks?: { afterStep?: (step: "issued" | "approved" | "published") => Promise<void> } }): Promise<CccPlanningLiveExecutionReleaseResult>;
// actor { actorId: "ccc-planning-controller", actorType: "system", actorName: "CCC planning receipt <first 12 hex>" };
// audit ccc-planning:live-execution-released; publishes live_execution_release artifact under the planning fence.
// Each step first reads what a prior attempt already wrote (existing approval row by authorization id, the release artifact
// by key), so a crash after any step replays to exactly one approval row and one release artifact (challenge 33).
```

**G0 order** (CL2 `packages/engine/src/ccc-planning/g0.ts`, frozen; the first failure refuses and writes nothing):
1. CLI usage (exit 2).
2. Receipt parse, exact keys, and `--confirm-authority` equals both `operatorConfirmation` and the recomputed digest. A missing `--confirm-authority` is `CCC_PLANNING_AUTHORITY_CONFIRMATION_REQUIRED`. The digest is typed by Ryan; this is procedural, not enforced (D23, D52).
3. Receipt not expired and not consumed.
4. Request bytes match `receipt.request` (sha256 and length) and are valid UTF-8 of at most 4 MiB.
5. Request contains no PRD grammar (`### Requirement`, `- [AC-`).
6. Profile is `full-v2`. `phaseCallCaps` equals the policy allocation. Large requires `largeAuthorized`. CL2 refuses `budgetProfile: "large"` without `largeAuthorized` with `CCC_PLANNING_LARGE_NOT_AUTHORIZED`; K2's parse runs the caps check inside step 2 (E5-K2 item 8). A profile other than `full-v2` is refused at step 2 by K2's parse (`AUTHORITY_RECEIPT_INVALID`), so no receipt reaches step 6's `CCC_PLANNING_PROFILE_NOT_SUPPORTED` while the parse accepts only `full-v2`; the code stays in the section 2.3 union, and the I6 card that widens the parse to `lean-v2` and `adaptive-v2` adds that RED (E7-0, N1; I6, not I5, confirmed by E8-0).
7. The installed `dist` manifest digest equals `receipt.runtime.distManifestSha256`, and the installed runtime receipt records `keepaliveModelSource: "fusion-receipt-adapter"` (D48).
8. OmniRoute is loopback (`validateCccLoopbackHttpUrl`).
9. Three pinned providers: digests, `modelSync: "disabled"`, one model each.
10. `decideCccPlanningTargetAdmission` with the null port, then `assertCccPlanningOwnedDisposableTarget`.
11. Discover and seal the toolchain (X1b `discoverCccToolchain`, whose defaults X1z makes real, E8-X item 1), then `qualifyCccConfinedShell` passes (seven probes, including `loopback-port-allowed`), and sandbox readiness is ready (E4-5). A missing required tool refuses `CCC_PLANNING_CONFINEMENT_UNQUALIFIED` with detail `toolchain-missing:<tool>`. Discovery uses its defaults (E6-0): the minimal required set, the optional GNU set, and the Homebrew-only search path; a missing optional tool never refuses. A qualification receipt is valid only for the build that produced it, and G0 records the profile template digest of the build under test (E7, X1c residual; section 6 risk 52).
12. Source policy digest equals `receipt.sourceToolPolicy.sha256`.
13. Planning fit with L = 0: N = 14, floor 1,440 ≤ 1,536.
14. Planning time fit: `2 · planningMs = 2 · 11,400,000 = 22,800,000 ms ≤ deadline − db_now`. The Build time fit needs the real T, so it runs at G6 (bridge step 4); section 4.6 shows it for T = 4.
15. `admitCccPlanningRun`.

The tool-fidelity preflight is stage 1 of the run, not part of G0. The serve process's own runtime digest is checked by H1 at every stage start (D44), not by G0.

CL2 passes `now` to K2's receipt checks in the canonical `…Z` form (E5-K2 item 8). Because K2's parse runs the step 3 expiry check and the step 6 caps check inside step 2, a single fault in either still refuses with its own code; only the step that reports it moves.

### 2.19 `fn plan` CLI (cards CL1, CL2)

```text
fn plan start  --project <id> --request-file <path> --mode spec|build --budget-profile standard|large
               --authority-receipt <path> --confirm-authority <sha256> [--json]
fn plan status RUN_ID [--project <id>] [--json]
fn plan answer RUN_ID --decision <decisionId> (--value <text> | --value-file <path>) [--actor <name>] [--project <id>] [--json]
fn plan pause|cancel|resume RUN_ID [--actor <name>] [--project <id>] [--json]
                                                          (after the import link: only cancel; pause/resume -> CCC_PLANNING_COMMAND_NOT_SUPPORTED until I4)
fn plan build RUN_ID --budget-profile standard|large      -> refusal CCC_PLANNING_COMMAND_NOT_SUPPORTED (until I4)
fn plan budget RUN_ID --amendment <file>                  -> refusal CCC_PLANNING_COMMAND_NOT_SUPPORTED (until I4)
```

```ts
// packages/cli/src/commands/plan.ts (CL1; CL2 adds the start path and wires CB)
export const CCC_PLANNING_CLI_SCHEMA = "ccc-planning.cli.v1" as const;
export type CccPlanningCliLineV1 =
  | Readonly<{ schema: typeof CCC_PLANNING_CLI_SCHEMA; kind: "run_admitted"; runId: string; projectId: string;
      planningTaskId: string; state: "admitted"; deadlineAt: string; receiptSha256: string;
      allocations: Readonly<{ planning: number; implementation: number; reviewProof: number }>; plannedPlanningNodes: number }>
  | Readonly<{ schema: typeof CCC_PLANNING_CLI_SCHEMA; kind: "status"; status: CccPlanningRunStatusV1 }>
  | Readonly<{ schema: typeof CCC_PLANNING_CLI_SCHEMA; kind: "control_accepted"; runId: string;
      request: "pause" | "cancel" | "resume"; controlSeq: number; appliedDirectly: boolean; route: "planning" | "campaign-bridge" }>
  | Readonly<{ schema: typeof CCC_PLANNING_CLI_SCHEMA; kind: "answer_accepted"; runId: string; decisionId: string;
      controlSeq: number; answerArtifactKey: string }>
  | Readonly<{ schema: typeof CCC_PLANNING_CLI_SCHEMA; kind: "refusal"; code: string; detail: string; field?: string; runId?: string }>
  | Readonly<{ schema: typeof CCC_PLANNING_CLI_SCHEMA; kind: "usage_error"; code: "CCC_PLANNING_CLI_USAGE"; detail: string; usage: string }>;
export const CCC_PLANNING_CLI_EXIT = { success: 0, refusal: 1, usage: 2 } as const;
export type PlanCommandDeps = Readonly<{
  /* store/layer factories, clock, stdout/stderr, ... */
  applyBuildControl: (i: Readonly<{ projectId: string; runId: string; request: "pause" | "cancel" | "resume"; actor: string }>) =>
    Promise<Readonly<{ kind: "applied"; controlSeq: number } | { kind: "refused"; code: string; detail: string }>>;
  // CL1 default: refused CCC_PLANNING_COMMAND_NOT_SUPPORTED ("build control bridge not wired"); CL2 wires CB
}>;
export async function runPlanCommand(argv: readonly string[], deps: PlanCommandDeps): Promise<0 | 1 | 2>;

// packages/engine/src/ccc-planning/build-control-bridge.ts (CB, 0.26)
export function cccPlanningBuildCancelReason(i: Readonly<{ actor: string; runId: string }>): string;
  // "fn plan cancel by <actor> for run <runId>" (verify-v2 item 43); the actor is truncated so the whole reason is
  // 10-1000 characters, the stop-reason rule of ccc-campaign-operator-control.ts:370-383
export async function applyCccPlanningBuildControl(i: Readonly<{ store: TaskStore; layer: AsyncDataLayer; projectId: string;
  runId: string; request: "pause" | "cancel" | "resume"; actor: string }>):
  Promise<Readonly<{ kind: "applied" | "pending-in-lease"; controlSeq: number } | { kind: "refused"; code: string; detail: string }>>;
  // pause | resume: refused CCC_PLANNING_COMMAND_NOT_SUPPORTED (I4 must-do, section 4.5); nothing written (item 36).
  // cancel: 1 L1 recordCccPlanningBuildControl (control_seq+1, actor; sets control_request='cancel' in every linked
  //   state with an allowed -> cancelling pair, E2-3, E4-13; an L1 refusal comes back as {kind: "refused"} with L1's
  //   code: STATE_TRANSITION_REFUSED in delivering (E3-1), INTERNAL_ERROR for an actor over 200 characters (E3-3, E4-6));
  //   2 status = inspectCccPrdProductStatus (product-status.ts:1467); 3 by the campaign item's state:
  //   - leased or running (the normal case in building): return "pending-in-lease". The serve-side applier below
  //     carries out the cancel; the CLI reports the cancel as accepted and pending.
  //   - unleased and not ended: applyCccCampaignOperatorControl({action: "stop", status, store,
  //     reason: cccPlanningBuildCancelReason(...)}) (:411); BF's hook moves the run in the same transaction.
  //   - already ended (cancelled or failed, :486-520 writes no item transition, so BF's hook never fires): CB runs
  //     L1 transitionCccPlanningRunState(<the run's current state> -> cancelling) and completeCccPlanningCancellation
  //     directly (item 44; the current state as the source, E2-3).
export async function applyCccPlanningPendingBuildCancels(i: Readonly<{ store: TaskStore; layer: AsyncDataLayer;
  projectId: string }>): Promise<ReadonlyArray<Readonly<{ runId: string; outcome: "disposed" | "no-live-lease" | "none" }>>>;
  // runs INSIDE serve, on serve's own TaskStore (the disposer registry is per TaskStore instance, task-move-disposer.ts:17-22,
  // so a disposer registered by serve's processor is invisible to the CLI process). For each linked run with
  // control_request='cancel', in building or any other linked state with an allowed -> cancelling pair (E4-13), using
  // the run's current state as the transition source and never the literal building (E2-3): find the leased campaign
  // work item and its task, then call
  // disposeTaskBeforeMove(store, {task, from: task.column, to: task.column, source: "engine", hardCancel: true}),
  // which runs the processor's registered disposer (workflow-work-processor.ts:115-131): it aborts the graph with
  // "workflow-user-cancelled" and waits (30 s limit) for the terminal transition (:383-397, 404-430), which BF maps to
  // cancelling -> cancelled. With no live lease it falls back to the unleased path above. WR calls it on every runtime
  // tick; it is idempotent.
```

- **Project resolution.** `--project` is optional for every subcommand except `start`. Without it, L1 `resolveCccPlanningRunProject` finds the run's project; with it, a different project is `CCC_PLANNING_RUN_PROJECT_MISMATCH`. A run id found in more than one project is `CCC_PLANNING_RUN_AMBIGUOUS`.
- **Control routing.** If the run has an `import_id`, pause, cancel and resume go to `deps.applyBuildControl`; otherwise to L1 `requestCccPlanningControl`. A `pending-in-lease` result is printed as `control_accepted` with `appliedDirectly: false` and `route: "campaign-bridge"`, exit 0; `fn plan status` shows the run reach `cancelled` once serve applies it.
- **Actor.** `--actor` defaults to the OS user name. It is trimmed and must be 1 to 200 characters; anything else is a `usage_error` (exit 2) before any read or write, and `deps` are never called (E2-4, E4-6). L1 also refuses an actor over 200 characters, as defence in depth, with `CCC_PLANNING_INTERNAL_ERROR`, because reaching L1 means a caller bug (E3-3). It is recorded, not authenticated (D52).
- **Output.** With `--json`, stdout holds exactly one JSON line, and stderr carries free-text diagnostics only. Without it, the output is human text with the same exit codes.
- **Usage errors (exit 2).** These include:
  - an unknown subcommand;
  - a missing or extra positional `RUN_ID`;
  - a missing or duplicate flag, including a duplicate `--project`;
  - a bad enum or a malformed sha256;
  - both `--value` and `--value-file`, or neither;
  - an `--actor` that is empty after trimming or longer than 200 characters (E2-4).
- **Refusals (exit 1).** Any `CCC_PLANNING_*`, `CCC_ROUTE_*`, `CCC_CONFINEMENT_*`, `CCC_PROVIDER_*` or `CCC_CAMPAIGN_OPERATOR_*` code.
- **Routing.** `bin.ts` routes `plan` before the bin-level `--project` parse (`bin.ts:576-605, 715`; the duplicate-`--project` error of `extractGlobalProjectFlag` never sees `plan`). `plan` never returns `FUSION_NON_RETRYABLE_EXIT_CODE`. An unexpected error maps to `refusal` with code `CCC_PLANNING_INTERNAL_ERROR` and exit 1.
- **Changeset (CL1).** `.changeset/ccc-planning-fn-plan.md`, frontmatter `"@runfusion/fusion": minor`, body `summary:`, `category: feature`, `dev:` lines, covering the whole `fn plan` surface; validated by `pnpm check:changesets`.

### 2.20 Proof runner, inventory, installed path and package keys (cards P0, IP, LV)

These are ADR D Q1 and Q2 signatures verbatim (`ccc-closed-vitest-results.mjs`, `run-ccc-planning-proof.mjs`, `CccPlanningProofReport`, `ccc-installed-cli.mjs`, `ccc-planning-installed-runtime.mjs`, `ccc-planning-serve-lane.mjs`), with these changes:
- The inventory is `scripts/lib/ccc-planning-proof-inventory/index.mjs`. It loads every `cards/*.mjs` in sorted filename order. Each card module exports `export const TARGETED: readonly ClosedSuiteCommand[]` and `export const OFFLINE: readonly ClosedSuiteCommand[]`. Every `ClosedSuiteCommand` declares `platform: "any" | "darwin"` and `needsPostgres: boolean` (E1-1: `needsPostgres` replaces v3's `needsPg` everywhere; the validator stays strict, refuses an entry spelled `needsPg`, and names `needsPg` in its error). Duplicate command ids across cards fail with `CCC_PLANNING_PROOF_INVENTORY_INVALID`. OFFLINE entries must be names-closed; TARGETED entries may be files-closed or names-closed (E1-6).
- **PostgreSQL per command (E1-2).** The runner sets `FUSION_PG_TEST_SKIP=1` in the child env of every command without `needsPostgres`, so no vitest global setup probes the shared `:5432`. Only `needsPostgres` commands get the owned URL, in `FUSION_PG_TEST_URL_BASE` and `CCC_PG_URL_BASE`, and the runner never sets the flag for them. A caller-supplied `FUSION_PG_TEST_SKIP` stays refused in every mode before any spawn. Against vacuous passes, the static skip policy refuses any literal `FUSION_PG_TEST_SKIP` inside a test file listed under a command without `needsPostgres`.
- **Credential stripping (E1-3).** In every mode the runner removes provider credential variables from each child env: names ending `_API_KEY`, `_TOKEN`, `_SECRET` or `_PASSWORD`, and names starting `OMNIROUTE_`, `ANTHROPIC_`, `OPENAI_`, `GEMINI_`, `GOOGLE_`, `AWS_`, `AZURE_`, `MINIMAX_`, `ZHIPU_` or `GLM_`. The report records the count of stripped names only, never names or values.
- **Report shape (E1-4).** `perCommand[].files` and `postgres.stopError` are required, as frozen by ADR D Q1. Ratified additive widenings: `scratch.root: string | null`; cleanup values `"not-created"` and `"removal-failed: <reason>"`; the refusal code `CCC_PLANNING_OFFLINE_NETWORK_ATTEMPT`; extra `runSupervised` fields. The runner's types header documents each one.
- **Sandbox probe (E1-5).** The sandbox readiness probe uses the absolute `/usr/bin/sandbox-exec`, never a PATH lookup.
- The runner's per-suite verdict reuses `decideDarwinProofLaneOutcome` (`scripts/ci-darwin-proof-lane.mjs:106`, empty-suite and failure detection); the closed-name check and "any skipped test fails" are added on top.
- **Offline network denial (D50).** For every mode the runner sets `PI_OFFLINE=1` and `NODE_OPTIONS=--import <abs>/scripts/lib/ccc-planning-offline-network-guard.mjs`. The guard wraps `net.connect`/`net.Socket.prototype.connect`, `tls.connect` and `dns.lookup`, refuses any non-loopback destination with `CCC_PLANNING_OFFLINE_NETWORK_ATTEMPT`, and appends one line per attempt to a report file the runner reads; a non-empty report fails the run. It is a tripwire for our own code paths, not a sandbox.
- **Modes.** `targeted` and `offline` (Darwin, owned PostgreSQL, every entry) and `ci-linux` (only `platform: "any"` and `needsPostgres: false` entries; zero selected entries is a failure).
- Root `package.json` gains exactly four keys, owned by P0:
  - `"test:ccc-planning": "node scripts/run-ccc-planning-proof.mjs --mode targeted"`
  - `"verify:ccc-planning-offline": "node scripts/run-ccc-planning-proof.mjs --mode offline"`
  - `"verify:ccc-planning-live": "node scripts/ccc-planning-live-proof.mjs"`
  - `"verify:ccc-planning-installed": "node scripts/ccc-planning-installed-proof.mjs"`

  None of these is added to `test:gate`, `test:ccc-prd-safety`, `pretest` or `test:pg-gate`. The Linux lane is one extra step in the `pr-checks.yml` Gate job (`[self-hosted, linux, ARM64, ccc-fusion-bwrap]`, `pr-checks.yml:154-304`), after `pnpm test:gate`: `node scripts/run-ccc-planning-proof.mjs --mode ci-linux`. `packages/cli/src/__tests__/ci-workflow.test.ts` (run by `test:ci-shape` inside `test:gate`) pins that step.
- `verify:ccc-planning-live` in I2 accepts only `--profile full`. `adaptive` and `lean` exit 1 with `CCC_PLANNING_PROFILE_NOT_IMPLEMENTED`. It requires `--confirm-authority <digest>` and passes the typed value byte for byte to `fn plan start`; it never computes, reads back or writes the digest (D23, D52). `verify:ccc-planning-installed` always exits 1 before I6 and lists its NOT RUN items.
- **Installed runtime receipt (IP, 0.25).** `ccc-planning.installed-runtime.v1` adds `piAi: { version: "0.81.1", shipping: "external", workspacePatch: "not_carried" | "carried", keepaliveModelSource: "fusion-receipt-adapter" }`. IP derives `shipping` from the packed `package.json` dependency list and the tsup `noExternal` rule, and `workspacePatch` from the installed pi-ai file bytes (the `identitySubstantive` marker of `patches/@earendil-works__pi-ai@0.81.1.patch`). LV refuses any receipt whose `keepaliveModelSource` is not `fusion-receipt-adapter`. Nobody edits files in an installed tree.
- The serve lane sets `PI_OFFLINE=1` in the serve env.
- The only allowed skip form in planning test files is `skipIf(process.platform !== "darwin")`, and only in files tagged `platform: "darwin"`. The one exception is the PostgreSQL gate idiom `const pgDescribe = PG_AVAILABLE ? describe : describe.skip;`, with `PG_AVAILABLE` reading `FUSION_PG_TEST_SKIP` (`packages/core/src/__tests__/postgres/schema-applier.test.ts:92-97`): files listed under a `needsPostgres` command may use it, the same idiom in a file without `needsPostgres` is refused, and the runtime closure (0 skipped, every expected name passed) is the backstop (E1-2b). P0's static policy check refuses every other skip form.
- **Masking (E1-7).** The skip-policy lexer indexes UTF-16 code units (`text.split("")`), never code points.

## 3. Card plan

### 3.0 Rules for every card

1. **Stub first, then RED.** The leaf first adds the frozen signatures from section 2 as stubs that throw `not implemented` (or return the wrong-but-typed value named in the card). The RED must fail on a **behavioural assertion**, not on a missing import or a thrown stub. The leaf records the failing command and failure signature.
2. **Non-vacuity and a positive control.** Every card says why its RED cannot pass vacuously and names a positive control: a case on the same fixture that must pass, proving the fixture really exercises the path.
3. **GREEN is the same command passing with 0 skipped** and at least the declared number of passing tests. The `dot` summary line is the evidence.
4. **PostgreSQL proof is never skipped.**
   - Core PG checks use `--config vitest.pg.config.ts`. That config's global setup provisions an embedded PostgreSQL itself.
   - Engine `*.real-pg.test.ts` checks need an owned server URL. The parent exports `CCC_PG_URL_BASE` from a disposable PostgreSQL it owns (initdb in scratch, `-c unix_socket_directories= -c listen_addresses=127.0.0.1 -c max_connections=200`, a verified-free port in 55400-55499, `psql` on PATH). Without it, the harness skips silently (`pg-test-harness.ts:93`), and a skipped count above 0 fails the card.
   - Owned server only (E5, made explicit after a W2 incident). Every test command that can reach PostgreSQL, dashboard runs included, sets `FUSION_PG_TEST_URL_BASE` to the leaf's own disposable server. A run without it falls back to the shared `localhost:5432`, which is forbidden. During W2 a builder left three `fusion_test_18636_*` databases there; the parent reports them and does not touch `:5432`.
   - Repeat (E7-0, still binding): every command that can reach PostgreSQL carries `FUSION_PG_TEST_URL_BASE` pointing at the leaf's own disposable server, and a command that needs no PostgreSQL carries `FUSION_PG_TEST_SKIP=1`. A readiness probe of the shared `localhost:5432` is a violation even when read-only (logged against K2 repair 1: four probes, no database created). Confirmed by E8-0 (first written as an editor's note from INT-2c's `checks.sh` and risk 10): the proof runner (`pnpm test:ccc-planning`) owns its PostgreSQL and refuses a caller-supplied `FUSION_PG_TEST_SKIP`, so a command that invokes the runner sets neither `FUSION_PG_TEST_URL_BASE` nor `FUSION_PG_TEST_SKIP` (INT-2d ran it as `env -u FUSION_PG_TEST_URL_BASE -u FUSION_PG_TEST_SKIP PI_OFFLINE=1 pnpm test:ccc-planning`).
5. **Engine runs.** Every engine check pins `--project=engine-default`, so the `engine-core` build-on-setup never fires.
6. **Typecheck.** Every touched package is typechecked: `pnpm --filter @fusion/core typecheck`. For engine, run `pnpm --filter @fusion/core build && pnpm --filter @fusion/engine typecheck`. CLI and dashboard use their own `typecheck`.
7. **Offline.** Every leaf check runs with `PI_OFFLINE=1`. After INT-1, the parent's `pnpm test:ccc-planning` also applies P0's network guard (D50).
8. **Proof inventory.** Each card writes `scripts/lib/ccc-planning-proof-inventory/cards/<card-id>.mjs` with the closed list of its test names, each entry tagged `platform` and `needsPostgres` (E1-1), and owns that file.
9. **Leaf branches.** A leaf works on `agent/r2c-<card-id>` from the integration branch. Leaves never push, merge, or touch files outside OWNED. The parent integrates at each INT step.
10. **Parent-owned files.** Barrels and registries (D34) are edited only by the parent, at INT steps.
11. **Routes and review lanes.**
    - Route `sonnet` = Sonnet 5 for bounded or mechanical work. Route `opus` = Opus 5 for shared contracts or critical paths.
    - Review lanes: `cheap` is one fresh Sonnet read of the diff. `normal` is `agy-bridge adversarial_review` on the diff with the content passed inline. `critical` is `normal`, plus a second independent reviewer, plus a parent rerun of the check.
    - Lanes for the current dispatch session (E3-5). Gemini (agy-bridge) and GPT (codex-mcp-server) are both parked after repeated failures, so `normal` is one fresh Opus reviewer, and `critical` is a fresh Opus reviewer, plus a fresh Opus adversarial reviewer with no shared context, plus the parent rerunning the check at integration. `cheap` is unchanged. The lane definitions above return when the leader restores those reviewers.

Check-command prefixes:

```text
CORE     = pnpm --filter @fusion/core exec vitest run
CORE_PG  = pnpm --filter @fusion/core exec vitest run --config vitest.pg.config.ts
ENGINE   = pnpm --filter @fusion/engine exec vitest run --project=engine-default
ENGINE_PG= FUSION_PG_TEST_URL_BASE="$CCC_PG_URL_BASE" pnpm --filter @fusion/engine exec vitest run --project=engine-default
CLI      = pnpm --filter @runfusion/fusion exec vitest run
DASH     = pnpm --filter @fusion/dashboard exec vitest run --project=dashboard-api-quality-backfill
SUFFIX   = --silent=passed-only --reporter=dot
SCRIPTS  = node --test
```

### 3.1 I1 (PRD §13 I1: offline contracts, store, host, confinement, CLI)

#### Wave W0 (parent, before any leaf)

- **PRE: exact-pin catalog read** (critic 15, D42).
  - Objective: make one read-only `GET /v1/models` request on the live loopback OmniRoute port, found through a narrow probe and never port 4040's owner. Assert that the exact ids `glm/glm-5.3`, `glm/glm-5.3-flash` and `minimax/MiniMax-M3` are served. No model call is made; the M3 tool-call probe is deferred into the receipt-bound LIVE preflight (D29, challenge 19).
  - Owns: none. Evidence goes under `.archive/r2c-pre/`.
  - RED/GREEN: report present or absent per id. Any absent id stops I2 planning for that role and goes to Ryan as a blocker.
  - Route: parent. Review: none.
- **R0p: quarantine rescue. DONE** (critic 4, ADR D Q5, challenge 23).
  - The cherry-pick of `1a8002f6d` already landed as `a08af2c73` ("rescue six expired round-11 quarantines", 8 files) on this branch. No leaf work remains.
  - RED evidence (from the adjudication): at parent `589c293c7`, `node scripts/check-quarantine-ledger.mjs --strict` exited 1 with `total=6 expired=6`.
  - GREEN evidence (from the adjudication): at `a08af2c73`, strict exited 0, and the 24 rescued tests passed 24/24 with 0 skipped on owned PostgreSQL.
  - Fresh re-check for v2 (read-only, HEAD `a08af2c73`): `node scripts/check-quarantine-ledger.mjs --strict` rc=0, `Summary: total=0 expired=0`; output in `scratchpad/quarantine-strict.txt`.
  - Owns: nothing further. Route: none. Review: none.

#### Wave W1 (independent; cheap first)

- **C6b: provider `modelSync` opt-out** (PRD §8, D27).
  - Objective: let a pinned custom provider refuse catalog sync, so a serve-start refresh can never widen the pins.
  - Owns:
    - `packages/core/src/types/workflow-steps.ts` (one field)
    - `packages/dashboard/src/routes/register-custom-provider-routes.ts`
    - `packages/dashboard/src/routes/__tests__/custom-provider-model-sync.test.ts`
    - `cards/c6b.mjs`
  - Depends: none.
  - RED: a fake `/v1/models` serves 3 models. A provider with `modelSync: "disabled"` must stay byte-identical after refresh-all, with `skipped: 1`. A single refresh must return 409, and a PATCH body must keep the field.
  - Non-vacuous: the stub ignores the field, so refresh-all merges the 3 models into the opted-out provider and the byte-identity assertion fails.
  - Positive control: a provider without the field, in the same test, is merged with the fake catalog, which proves the catalog is really served.
  - Check: `DASH src/routes/__tests__/custom-provider-model-sync.test.ts SUFFIX`
  - Route: sonnet. Review: cheap.
- **B4: packet writer extraction** (PRD §3, ADR B Q2).
  - Objective: one packet writer shared by the freeze path and the import bridge.
  - Owns:
    - `packages/engine/src/ccc-prd/intake.ts`
    - `packages/engine/src/__tests__/ccc-prd-packet-writer.test.ts`
    - `cards/b4.mjs`
  - Depends: none.
  - RED: `writeCccPrdPacketFiles` on the same sources and the freeze receipt must produce `manifestSha256` and `packetHash` equal to today's freeze output, taken from a fixture recorded before the change.
  - Non-vacuous: the stub returns empty hashes, which cannot equal a recorded 64-hex fixture.
  - Positive control: the fixture comes from the unmodified freeze path, and the existing `ccc-prd-intake.test.ts` passes unchanged.
  - Check: `ENGINE src/__tests__/ccc-prd-packet-writer.test.ts src/__tests__/ccc-prd-intake.test.ts SUFFIX`
  - Route: sonnet. Review: normal.
- **B2: graph-admission export** (G4, ADR B Q3).
  - Objective: expose the compiler's graph rules as a pure function G4 can call before review spend.
  - Owns:
    - `packages/engine/src/ccc-prd/compiler.ts`
    - `packages/engine/src/__tests__/ccc-planning-i2-graph-admission.test.ts`
    - `cards/b2.mjs`
  - Depends: none.
  - RED: these must each give their diagnostic: adding T4→T1 to the diamond gives the cycle diagnostic; a two-terminal graph is refused; the "bridge" T1→T3 plus T2→T3 plus T2→T4 is refused.
  - Non-vacuous: the stub returns `[]`, so every refusal case fails.
  - Positive control: the diamond T1→{T2,T3}→T4 admits with zero diagnostics, and for every existing compiler fixture the graph subset of `compileCccPrdPacket` diagnostics equals `diagnoseCccPrdProductGraphAdmission` (parity, so compiler and G4 cannot drift).
  - Check: `ENGINE src/__tests__/ccc-planning-i2-graph-admission.test.ts src/__tests__/ccc-prd-compiler.test.ts SUFFIX`
  - Route: sonnet. Review: normal.
- **P0: proof runner, offline guard and Linux lane** (PRD §14, critic 9, D25, D50, D51).
  - Objective: a closed-name, zero-skip, offline proof runner that owns PostgreSQL, plus the Linux CI step.
  - Owns:
    - `scripts/lib/ccc-closed-vitest-results.mjs`
    - `scripts/lib/ccc-planning-offline-network-guard.mjs`
    - `scripts/lib/ccc-planning-proof-inventory/index.mjs`
    - `scripts/lib/ccc-planning-proof-inventory/cards/p0.mjs`
    - `scripts/run-ccc-planning-proof.mjs`
    - `scripts/ccc-planning-live-proof.mjs` (stub, exits 1 `CCC_PLANNING_PROOF_NOT_IMPLEMENTED`)
    - `scripts/ccc-planning-installed-proof.mjs` (stub)
    - `scripts/__tests__/run-ccc-planning-proof.test.mjs`
    - `scripts/__tests__/ccc-planning-offline-network-guard.test.mjs`
    - root `package.json` (the four keys only)
    - `.github/workflows/pr-checks.yml` (one Gate step only)
    - `packages/cli/src/__tests__/ci-workflow.test.ts` (one assertion only)
  - Depends: none.
  - RED:
    - a JSON report with one `skipped` name fails `assertClosedNamedResults`;
    - a caller-supplied `FUSION_PG_TEST_SKIP=1` exits 1 with `CCC_PLANNING_PROOF_PG_SKIP_REFUSED` in every mode, and the `runSupervised` spy is never called (E1-2);
    - an injected `linux` platform in offline mode gives `CCC_PLANNING_OFFLINE_PLATFORM_UNSUPPORTED`;
    - the static policy refuses `it.skip(`, `describe.skip`, an inverse `skipIf`, and the `pgDescribe` idiom in a file listed under a command without `needsPostgres` (E1-2b);
    - the static policy refuses a literal `FUSION_PG_TEST_SKIP` inside a test file listed under a command without `needsPostgres` (E1-2);
    - the child env of a command without `needsPostgres` holds `FUSION_PG_TEST_SKIP=1` and no owned URL; a `needsPostgres` command's child env holds the owned URL in `FUSION_PG_TEST_URL_BASE` and `CCC_PG_URL_BASE` and no `FUSION_PG_TEST_SKIP` (E1-2);
    - every child env lacks the provider credential variables of section 2.20, and the report records only their count (E1-3);
    - an entry spelled `needsPg` is refused `INVENTORY_INVALID` with an error that names `needsPg` (E1-1);
    - an emoji followed by `.skip(` is refused (UTF-16 masking, E1-7);
    - two card modules with the same command id give `INVENTORY_INVALID`;
    - the env passed to `runSupervised` contains `PI_OFFLINE=1` and the guard `--import`;
    - a child script under the guard that connects to `192.0.2.1:9` is refused with `CCC_PLANNING_OFFLINE_NETWORK_ATTEMPT`, the report file has one line, and the run fails;
    - `--mode ci-linux` selects only `platform: "any"`, `needsPostgres: false` entries and fails on an empty selection;
    - `ci-workflow.test.ts` fails until the Gate job has the `--mode ci-linux` step.
  - Non-vacuous: the stub runner passes everything, so the skip and PG cases fail; the TEST-NET-1 target would otherwise end in a network error or timeout, never in the guard's code and report line.
  - Positive control: an all-passed report passes; a dirty-git snapshot trips `FOREIGN_GIT_MUTATION`; a loopback connect to a listener the test opens succeeds under the guard; an empty suite fails exactly as `decideDarwinProofLaneOutcome` decides it; the `pgDescribe` idiom in a `needsPostgres` file is accepted (E1-2b); an emoji followed by the Darwin `skipIf` is accepted in a darwin-tagged file (E1-7).
  - Check: `SCRIPTS scripts/__tests__/run-ccc-planning-proof.test.mjs scripts/__tests__/ccc-planning-offline-network-guard.test.mjs`, then `CLI src/__tests__/ci-workflow.test.ts SUFFIX`
  - Route: sonnet. Review: normal.
  - Status (E2): ACCEPTED at `e3f459740`.
  - Follow-up (E2-30, not dispatched now; folded into the next card that touches the runner): set `postgres.stopError` to `"unknown: supervisor failed"` when the supervisor throws; change `blank()` to `blankLiteral()` at `ccc-closed-vitest-results.mjs:429`; correct the types-header wording (E1-3 versus E1-4, CONTRACT-v3 citation).
- **K1: core types, policy, budget fit, artifacts, marker, errors, schemas, workflow IR, runtime identity, Pi view types** (PRD §4-§6, §8-§9; 0.23, 0.24).
  - Objective: every pure core contract the later cards import, including the type-only seam that L1 needs in W2.
  - Owns:
    - `packages/core/src/ccc-planning/{types,policy,budget-fit,artifacts,marker,errors,schemas,workflow-ir,runtime-identity}.ts`
    - `packages/core/src/ccc-campaign/types.ts` (type-only additive hunks: views, `SettlementInputOf` with `refusalReason`, widened limit reasons)
    - `packages/core/src/ccc-campaign/provider-controller.ts` (type-only: `CccProviderControllerDecisionView`, `CccProviderAttemptControllerView`)
    - `packages/core/src/__tests__/ccc-planning-{policy,budget-fit,artifacts,schemas,workflow-ir,runtime-identity}.test.ts`
    - `packages/core/src/__tests__/ccc-provider-attempt-views.typecheck.test.ts`
    - new `packages/core/tsconfig.ccc-planning-tests.json` (E2-48: extends the core tsconfig, sets `noEmit`, and includes only the K1 test files and their sources)
    - `cards/k1.mjs`
  - Depends: none.
  - RED:
    - `countCccPlanningNodes({leaves:0})` is 14 and `({leaves:2})` is 17.
    - `cccPlanningCallFloor(16)` is 1,560. `assessCccPlanningFit({leaves:1, remainingPlanning:1536, …})` is refused with shortfall `{dimension:"planning-calls", required:1560, remaining:1536}`; `({leaves:0, …})` is admitted at floor 1,440.
    - `cccPlanningCriticalPathMs({mode:"spec", providerTasks:4, maxConcurrency:1}).totalMs` is 11,400,000; for `"build"` it is 36,000,000 with `campaignMs` 23,400,000.
    - `decodeCccPlanningArtifactKey("cccplan-r001-design-review-a-v01")` gives stage `design-review` and slot `a`.
    - `classifyCccModelIdentity("glm/glm-5.2-latest")` gives `excluded-model`, not `floating-alias`.
    - Every non-probe reviewer is of the other family.
    - `cccPlanningTransitionAllowed` is true for exactly the 65 listed pairs plus identity, including `importing → budget_exhausted` (item 38).
    - `classifyCccModelIdentity("glm/glm-5.3-flashx")` gives `not-in-pin-registry`, while `glm/glm-5.3-flash` is pinned.
    - `CCC_PLANNING_LINKED_WRITER_TOOLSET` equals the writer toolset plus `fn_complete_phase`, sorted and unique, and `CCC_PLANNING_TOOLSETS.writer` does not contain `fn_complete_phase`; dropping the linked toolset from the digest input changes `cccPlanningPolicyDigest()` (item 37).
    - `CccReviewFindingRef` and `CccReviewVerdict` are exported from `@fusion/core`: a verdict literal with a `source` ref and a `quote` typechecks, and a ref of kind `"bogus"` is a `// @ts-expect-error` line (item 34).
    - `cccPlanningRestingStates("build")` excludes `spec_ready`; `("spec")` includes it.
    - `cccPlanningWorkflowIrHash(buildCccPlanningWorkflowIr("build"))` equals `sha256(canonicalCccPrdJson(ir))`, is stable across calls, and changes when one node config byte changes; the Spec IR has no `import` node.
    - `registerCccRunningRuntimeDistManifest` twice with different values throws; `assertCccRunningRuntimePermitted` throws `RUNTIME_NOT_PERMITTED` when unregistered.
    - `CccPlanningProofResultsV1.results` takes exactly one entry per proof id in the section 2.17 shape (E1-8). Its `state`/`exitCode` consistency mirrors the proof-attempt store's rule, and a `proofIds` entry, a `results[].proofId` or a task-plan `proofIds` entry that fails `CCC_PLANNING_PROOF_ID_PATTERN` is refused; each case has a control (E2-43).
    - `assessCccPlanningFit` and `assessCccBuildFit` with a remaining time or `maxDurationMs` that is zero, negative, or floors below the requirement return `{ok:false, …, shortfalls:[{dimension:"time", …}]}` and never throw; a sufficient fractional value is admitted (E1-9, E4-14).
    - Owned paths compare on `cccPlanningPathComparisonKey`: the ß/ss, ς/σ and ﬁ/fi pairs are refused both across tasks and as duplicates within one task (E2-40), and the test name documents the accepted I/ı over-refusal. A duplicate owned path within one task, a `.git` segment, and a `.env` or `.env.*` basename are refused (E1-10).
    - `.npmrc`, `_secrets/x`, `.agentsecrets` and `.envrc` are refused as owned paths and write roots; `src/env.mjs` and `docs/secrets-guide.md` are the controls (E2-42).
    - Write root `SRC/a.mjs` with owned `src/a.mjs` counts as inside the owned paths, with a control (E2-46).
    - The verifier bundle refuses `.git/hooks/post-checkout`, the `Taskfile.yml` + `taskfile.yml` pair, an NFC/NFD pair and `.env` among its file and control-file paths; an ordinary harness path is the control (E2-41). A proof whose `taskfileTask` is not `"verify:" + id` is refused (E1-12).
    - Each derived key (turn key, attempt key, linked-writer turn key, event id, run id) is unchanged when the caller passes extra fields (E1-11); `cccPlanningTurnKey` with `nodeAttemptOrdinal` 4 is refused at runtime (E2-47).
    - Canonical-JSON encoding failures (an `undefined` value, a non-plain object) refuse as `CccPlanningRefusal("CCC_PLANNING_ARTIFACT_ENVELOPE_INVALID")`, not a plain `Error` (E1-13), and `computeCccPlanningClosureDigest` given a ref with digest `undefined` refuses the same way (E2-44).
    - A mutation attempt on `CCC_PLANNING_PREFLIGHT_LINEAGES`, `CCC_PLANNING_DENIED_NAMES`, `CCC_PLANNING_SOURCE_POLICY_I2` or any other `cccPlanningPolicyDigest` input throws in strict mode, and the digest is unchanged (E2-45).
  - Non-vacuous: each expected number differs from the obvious wrong implementation: counting the preflight as a node (v1) gives 15; counting the leaf reviewer unconditionally gives 15; a parallel-stage time model gives less than 11,400,000; a left-to-right key split gives `design`; the djb2 `hashWorkflowIr` gives a non-hex value; a prefix match on `glm/glm-5.3-flash` classifies the lookalike as pinned.
  - Positive control: `running → importing` is refused while each of the 65 pairs is allowed. The type test assigns a structural fixture, a local object literal annotated as `CccProviderAttemptControllerView<CccProviderAttemptScope>`, never the engine controller, which core cannot import (item 51; P1 does the real-controller assignment), and a `// @ts-expect-error` line with a wrong scope type must error. A deliberately wrong fixture type fails `tsc -p tsconfig.ccc-planning-tests.json`; the repair reports that, then reverts it (E2-48).
  - Check: `CORE src/__tests__/ccc-planning-policy.test.ts src/__tests__/ccc-planning-budget-fit.test.ts src/__tests__/ccc-planning-artifacts.test.ts src/__tests__/ccc-planning-schemas.test.ts src/__tests__/ccc-planning-workflow-ir.test.ts src/__tests__/ccc-planning-runtime-identity.test.ts SUFFIX`, then `pnpm --filter @fusion/core typecheck` (covers the type test), then `pnpm --filter @fusion/core exec tsc -p tsconfig.ccc-planning-tests.json` (E2-48).
  - Route: opus. Review: critical.
  - Final repair (E2): repair 2 of 2, route opus. If the final bytes still fail review, the leader re-plans the card; a fourth attempt is never dispatched.
  - Round 3 (E4): ACCEPTED at `0026543d1`, with one residual defect routed to card K1b. Both reviewers independently found that the E2-40 key formula misses U+1E9E (capital sharp s): `ẞ`, `ß` and `ss` open the same APFS file, but `ẞ` keyed to `ß` while the others keyed to `ss`. This is the errata formula's fault, not the repairer's. Cherry-picked onto `agent/request-to-code-v3` as `9a8054a0a` (INT-1b). The K1 lineage has no repairs left; K1b is the successor owner of the K1 files it names.
- **X1: confined shell** (PRD §8, D12, Darwin).
  - Objective: the writer shell confinement, reusing the semantic-proof sandbox pieces.
  - Owns:
    - `packages/engine/src/ccc-confinement/confined-shell.ts`
    - `packages/engine/src/ccc-campaign-proof-sandbox.ts` (helper exports only, no behaviour change)
    - `packages/engine/src/__tests__/ccc-confined-shell.darwin.test.ts`
    - `cards/x1.mjs`
  - Depends: none.
  - RED, run under real `sandbox-exec`:
    - (a) Connecting to a 127.0.0.1 listener that the test opens on a port other than the admitted one gives EPERM.
    - (b) Reading a temp file outside the roots is denied.
    - (c) `kill -0` of a same-user sibling that the test spawned outside the sandbox gives EPERM.
    - (d) The parent seeds `OMNIROUTE_API_KEY=canary-…` and `FUSION_CANARY_SECRET=…`, and both are absent inside.
    - (e) A `setsid` escaper is in `CccClosureRecord.killed` after the command.
    - (f) `.env` inside the worktree is unreadable (P9 rule order).
    - (g) `qualifyCccConfinedShell` reports all seven probes passed.
    - (i) Controller-side closure (E1-18, probes P4 and P6 from the X1 review): a `setsid` escaper plus `kill -9 $PPID`, and a `setsid` escaper plus `kill -STOP $PPID` with a 2 s timeout. In both, the escaper is dead within a bounded time after `exec` returns, and its heartbeat file stops growing.
    - (j) Hard links and symlinks of the clone's binaries into a write root are refused or cannot be executed (E1-18).
    - (k) Through `testOnly.sealedEnvironment`, an environment builder that spreads `process.env` (with the planted canary) gives `env-scrubbed` `passed:false`, and qualification as a whole is not qualified (E1-19, E2-21).
    - (l) A write to a path with a `.git` segment inside a write root is denied, and a caller `deniedNames` list without `.env` still denies `.env` (E1-20).
    - (m) Through `testOnly.lsofPath` (or the equivalent seam on the operations input, documented): a missing path refuses at creation with `closure-sweep-unavailable`, and a stub that exits 1 yields closure-unconfirmed (E2-22).
    - (n) Unit tests of `cccConfinedEffectiveDeniedNames` and `cccConfinedWriteRefusal`, each refusal with a positive control (E2-23).
    - (o) A write into the clone directory from inside the sandbox is denied; after `dispose` the directory is gone and an exec refuses (E2-24).
    - (p) A utility sealed from `gcat` with `name: "cat"` runs as `cat` inside (E2-25).
  - Non-vacuous: every denial has a positive control outside the sandbox that succeeds (critic 8 C5), so a denial cannot come from a broken fixture.
  - Positive control: (h) inside the sandbox, a connect to the admitted `loopbackPort` from `acquireCccSemanticProofLoopbackPort` (the test listens there) succeeds, so the profile is not simply "deny all network" (challenge 23). The same outside-sandbox reads, kills and connects in (a)-(c) succeed. A normal command's closure is confirmed with zero survivors (E1-18); the default environment builder passes `env-scrubbed` (E2-21); the real `/usr/sbin/lsof` sweep confirms closure (E2-22).
  - Test hygiene (E1-20): the tests that start escapers record the `ESCAPER <pid>` line outside the throwing helper and kill that pid in `finally`; the CPU-limit test loops on `process.cpuUsage()`, not wall time.
  - Evidence the final repair reports (E2-26): (a) whether a CPU-bound command (`node -e 'for(;;){}'`) is killed by RLIMIT_CPU within `cpuSeconds` plus slack, with an explanation of the deviation note that "a loop calling process.cpuUsage() escapes RLIMIT_CPU"; if RLIMIT_CPU is unreliable on this host, the repair says so, the wall ceiling is then the binding bound, and section 6 gets a row (risk 44). (b) `ccc-campaign-proof-execution.test.ts` run on Darwin with `--project=engine-default` against `dbe834b82` and against the repair HEAD, both counts reported as the no-behaviour-change proof for the `runCccSemanticProofSandboxedProcess` delegation. (c) The closure record's `killed` list filtered to confirmed instance processes, so the P7 foreign-zombie pid never appears; a test if one can be made deterministic, otherwise a report.
  - Check: `ENGINE src/__tests__/ccc-confined-shell.darwin.test.ts SUFFIX`, which must show 0 skipped on Darwin. This is X1's closed check (E1-17); `cards/x1.mjs` lists its names, including the new ones (E2-21). Outside regression check, not in `cards/x1.mjs`: `ENGINE src/__tests__/ccc-campaign-proof-sandbox.test.ts SUFFIX`, whose Darwin skip predates this work (E1-17).
  - Route: opus. Review: critical.
  - Final repair (E2): repair 2 of 2, route opus. If the final bytes still fail review, the leader re-plans the card; a fourth attempt is never dispatched. Toolchain discovery and package-command compatibility are out of scope for X1 and belong to card X1b (W1 residual, E4-B).
  - Round 3 (E4): ACCEPTED for production behaviour at `63a5c05f0`: every production E2 item survived mutation. Cherry-picked onto `agent/request-to-code-v3` as `ff4fc3e4f` (INT-1b). Test and hardening residuals are routed to card X1c: the E2-24 layout test can never fail; the closed check runs 153-261 s against a 180 s runner bound; the 1 s quick control still flakes at a load average of about 30; and the hardening gaps of E4-X. X1c is the successor owner of the X1 files it names.
- **S0: migrations 0042 and 0043, applier, Drizzle, audit event id** (PRD §3, §9, D4, D6, D7, D39).
  - Objective: the anchor table, the artifact guard and deterministic planning audit ids, all passing the boot ownership audit.
  - Owns:
    - `packages/core/src/postgres/migrations/0042_ccc_planning_runs.sql`
    - `packages/core/src/postgres/migrations/0043_ccc_planning_artifact_guard.sql`
    - `packages/core/src/postgres/schema-applier.ts`
    - `packages/core/src/postgres/schema/ccc-planning.ts`
    - `packages/core/src/postgres/schema/project.ts` (`projectTableNames` only)
    - `packages/core/src/postgres/data-layer.ts` (`eventId` only)
    - `packages/core/src/types/run-audit.ts` (19 literals)
    - `packages/core/src/__tests__/postgres/schema-applier.test.ts`
    - `packages/core/src/__tests__/postgres/ccc-campaign-semantic-proof-v2-migration.pg.test.ts`
    - `packages/core/src/__tests__/postgres/ccc-campaign-execution-authorization-migration.pg.test.ts`
    - `packages/core/src/__tests__/postgres/ccc-prd-import-migration.pg.test.ts` (E1-16)
    - `packages/core/src/postgres/migration-stamping.ts` (the promotion check only, granted by E2-61)
    - new `packages/core/src/__tests__/postgres/ccc-planning-migration.pg.test.ts`
    - new `packages/core/src/__tests__/postgres/run-audit-event-id.pg.test.ts`
    - `cards/s0.mjs`
  - Depends: none. The SQL is frozen in section 2.
  - Parity note: this card's migration test checks the SQL transition function against the frozen literal list of 65 pairs from section 2.2 (v3 adds `importing → budget_exhausted`, item 38); the SQL-versus-TypeScript parity test for all 400 pairs belongs to L1 in W2, which depends on both.
  - RED: each refusal is paired with a control that differs by the one offending field and succeeds.
    - Ownership: on a fresh database the applier runs 0000-0043 and then boots a second time; both boots pass the ownership and relational audit (`schema-applier.ts:640-706`). An anchor naming a task id that exists only in another project is refused by the composite FK.
    - Anchor: `planning_spent` 3→2 is refused with `COUNTER_DECREASE`; a spend while `control_request='pause'` is refused with `SPEND_REFUSED`; `cancelled → running` is refused with `RUN_TERMINAL`; `running → importing` is refused with `STATE_TRANSITION_REFUSED`; `stagnant_epochs` +1 without `review_epochs` +1 is refused.
    - Artifacts: an insert without the GUC is refused with `PUBLISHER_REQUIRED`; a `design_alternative` whose closure holds another one is refused with `DESIGN_SEAL_BROKEN`; an UPDATE is refused with `IMMUTABLE`; an operator fence with a stale `controlSeq` is refused with `FENCE_REFUSED`; a campaign fence whose `runId` is not `ccc-prd:<import_id>` is refused.
    - Event id: the same `eventId` twice, with different timestamps, leaves one row and returns the first event; a different metadata payload under the same id throws `RunAuditEventCollisionError` (`CCC_RUN_AUDIT_EVENT_COLLISION`).
    - The three pins read `"0043"`.
    - Anchor delete (E1-15): as `fusion_runtime`, a DELETE fails with SQLSTATE 42501, and a delete-and-reinsert counter reset is refused. The privilege test asserts SELECT, INSERT and UPDATE each true and DELETE and TRUNCATE each false, one `has_table_privilege` call per privilege. `expectPermissionDenied` matches SQLSTATE 42501 and the table name only, not the English message text (E2-65).
    - `ccc-prd-import-migration.pg.test.ts` drops `project.ccc_planning_runs` before `project.ccc_prd_imports`, and adds `'0042', '0043'` to the bookkeeping delete with matching asserts (E1-16).
    - Import foreign key (E2-60): a stand-in project partition that holds one `ccc_prd_imports` row, and no anchor, is promoted with 0042 and 0043 present, and the row moves to the real id.
    - Planning rows at promotion (E2-61): a stand-in partition with an anchor gives `ProjectPartitionRekeyError` with reason `planning-rows-present`, not `CCC_PLANNING_ANCHOR_IMMUTABLE`. The report confirms the fallback path after reading `startup-factory.ts:1194-1205`.
    - Audit metadata (E2-62): an optional field set to `undefined`, written once and then replayed exactly, returns the persisted event; a `Date` or `BigInt` value is refused on the first write, and no row exists afterwards.
    - Guard order (E2-63): an UPDATE setting `project_id = NULL` is refused, and an explicit project change is a second refused case; the NULL case runs in a bypass session with no project GUC (E4-12). Every test that names the trigger uses `zz_ccc_planning_runs_guard`.
    - Deadline (E2-64): `deadline_at` values `'tomorrow'` and `'infinity'` are refused.
  - Non-vacuous: a single-column FK (v1) fails `CREATE TABLE` on the first boot, and any key without `project_id` fails the audit, so the ownership case cannot pass by accident; the timestamp case fails against today's comparator, which includes `timestamp` (`data-layer.ts:594-606`).
  - Positive control: each paired control succeeds (same-project anchor insert, `admitted → blocked_prerequisite`, `importing → budget_exhausted`, a correct operator fence, a campaign event-key insert through the unchanged `campaign` path). The paired control of the guard-order cases is an UPDATE of a mutable column, or one that sets `project_id` to its own value, which succeeds (E4-12, matching the accepted tests; E2-63 had named the explicit project change, which is refused); an ISO `toISOString()` deadline is accepted (E2-64).
  - Check: `CORE_PG src/__tests__/postgres/ccc-planning-migration.pg.test.ts src/__tests__/postgres/run-audit-event-id.pg.test.ts src/__tests__/postgres/schema-applier.test.ts src/__tests__/postgres/ccc-campaign-semantic-proof-v2-migration.pg.test.ts src/__tests__/postgres/ccc-campaign-execution-authorization-migration.pg.test.ts src/__tests__/postgres/ccc-prd-import-migration.pg.test.ts SUFFIX` (the last file added by E2-8, as in `063e4a287`; `cards/s0.mjs` lists it too)
  - Route: opus. Review: critical.
  - Final repair (E2): repair 2 of 2, Sonnet build and Opus review. If the final bytes still fail review, the leader re-plans the card; a fourth attempt is never dispatched. 0042 was edited in place: no database outside disposable test clusters ever booted `0719c0e98`.
  - Round 3 (E4): ACCEPTED at `7d8e2118d`; both reviewers say ACCEPT. Cherry-picked onto `agent/request-to-code-v3` as `596a5d7bf` (INT-1b). No code changes follow from E4-12, which corrects only this card's text. Recorded residuals (section 6 risks 45 to 47): the deadline CHECK tests only the text's shape, so an impossible date fails later, closed, as an untyped SQLSTATE 22008; the Drizzle mirror of the deadline CHECK has no test; the 0043 guard casts `lease_expires_at` without a format check.

**INT-1 (parent).** Merge the W1 leaves: P0, then K1, then S0, then X1, each cherry-picked as its exact accepted range (E2-80). Export K1 and S0 modules from `packages/core/src/index.ts`, `packages/core/src/ccc-campaign/index.ts` and `schema/index.ts`, and export B2 and B4 from `packages/engine/src/ccc-prd/index.ts`. The core barrel gains `export * from "./ccc-planning/index.js";`, with a new `packages/core/src/ccc-planning/index.ts` exporting the K1 modules (E2-80). `schema/index.ts` exports `schema/ccc-planning.ts` directly, not through `project.ts`, which would create a module cycle (E1 carry-forward, E2-80). The E2-81 consistency test (X1 `CCC_CONFINED_DEFAULT_DENIED_NAMES` ⊇ K1 `CCC_PLANNING_DENIED_NAMES`) is not a parent edit: it is X1c's new `packages/engine/src/__tests__/ccc-confined-denied-names.test.ts`, listed in `cards/x1c.mjs` (E4-8). Then run `pnpm --filter @fusion/core build`, the engine typecheck, `pnpm test:ccc-planning` and `pnpm check:changesets`. INT-1 is `a426a4377` (core and schema barrels), which holds the round-2 bytes of K1, S0 and X1 (E3-6; F8). The `ccc-campaign/index.ts` K1 exports came later, at INT-2a.

**INT-1b (parent, done; E4).** The round-3 commits were cherry-picked onto `agent/request-to-code-v3`: K1 `0026543d1` as `9a8054a0a`, S0 `7d8e2118d` as `596a5d7bf`, and X1 `63a5c05f0` as `ff4fc3e4f`. Core typecheck, core build, engine typecheck, CLI typecheck, the K1 test-tsc check and lint all exit 0. `ff4fc3e4f` holds the final W1 bytes and is the base of the W1 residual cards.

**W2 base (E2-82, E3-6).** W2 leaves branch from INT-1 `a426a4377`, which holds the round-2 bytes of K1, S0 and X1. Their final repairs:
- change no exported signature W2 consumes;
- add K1 path-key folding and validator strictness;
- change S0's FK deferrability, guard trigger name, deadline CHECK and audit metadata normalization;
- add X1 exports (including the `name` field, `CccToolchainUtilitySpec` and the widened `sealCccToolchain` input), which W2 does not consume (F1).

A W2 test must not depend on the round-2 behaviour of any of those, for example a 0042 trigger name or an un-folded path key (E3-6). Before review, each W2 leaf rebases onto the current integration head that holds the final W1 bytes (INT-1b `ff4fc3e4f` or later), and its card check is re-run (F7). No W2 card depends on a W1 residual card, so a W2 leaf never waits for one.

W2 repair 1 (E5; bases corrected by E7-C B1). E5 named INT-2a `9d4add879`, and each W2 leaf was rebased onto it (E2-82); the parent then re-rebased K2, L1, G1 and P1 onto INT-2b `ee89957c1` at 17:09, so the round-1 bytes are K2 `0876ea993`, L1 `0ce304036`, G1 `2c4285354` and P1 `c86d946ab`, each a child of `ee89957c1`, and the repair-1 commits `5636bb733`, `1d0df1cc5`, `11fff1ad1` and `19036aa27` are built on them. Each repair implements every item of its E5 section with a RED that fails on a behavioural assertion against the round-1 bytes, plus its positive control. E5's rule that no W2 repair test depends on K1b or X1c is retired (E7-0): K1b, G1 and X1c are all integrated.

W2 repair 2 (E7; FINAL). G1 is accepted and on integration at INT-2c. K2, L1 and P1 get their last allowed repair: each card's lineage is 1 build plus 2 repairs. Before repair 2 the parent rebased every remaining leaf onto INT-2c `115ab8d7f`, with no conflicts and no file overlap with G1 or X1c: K2 `42d2ffde8` + `ef72f9868`, L1 `a17b009a4` + `0ab6b6280` and P1 `cd65276c6` + `bbaa5fb4d`, each commit patch-equal to its round-1 or repair-1 original (`scratchpad/contract-v3.4/patchids.txt`), and X1b likewise (W1 residual). A repair-2 RED fails on the repair-1 bytes (the leaf's current head) on a behavioural assertion or, where E7 says so, is a pinning test whose failing signature comes from a reported mutant. If a card's repair 2 is not accepted by both its fresh reviewer and its fresh adversary, the leader re-plans that card (split, re-scope or re-derive); there is no repair 3 (E7-0).

W2 repair 2 outcome (E8). K2 is ACCEPTED at `c594c8c02` and L1 at `dbe1f6a71`, each by its fresh reviewer and its fresh adversary. P1 (`66ef8f379`) and X1b (`270f92439`, W1 residual) were accepted by their reviewers, but each adversary found one more defect. Both lineages are used up, so the leader re-planned rather than repairing: their commits are integrated as they are, and the defects become the new W3 cards P1z and X1z. L1's remaining gaps and B-1 become the new W3 card L1z. All four ranges are on integration at INT-2d `fcb83879d`, so every W2 card is integrated: A1 (INT-2a), G1 (INT-2c), and K2, L1 and P1 (INT-2d).

#### W1 residual (E4: K1b, X1c and X1b, from INT-1b, alongside W2)

These three cards start now. Each branches from INT-1b `ff4fc3e4f`, and they run at the same time as each other and as W2. K1b and X1c are the successor owners of the K1 and X1 files they name, since the K1 and X1 lineages have no repairs left; X1b moves here from W3 (E4-B). Their files are pairwise disjoint and disjoint from every W2 card's files, and no W2 card depends on them. Later cards depend on them: CL2, SF and WR on X1b (E4-5); WR, BF and GG on K1b (E3-4, E4-1, F11); SF and WR on X1c (E4-9).

Round 1 (E6): K1b ACCEPTED at `a46fed5e1` and on integration as INT-2b `ee89957c1`; X1c REPAIR at `6782c1004` and X1b REPAIR at `8025e5a87`, each repair 1 of 2. The repairs change the bases: X1c rebases onto INT-2b `ee89957c1`, and X1b onto `853f08491`, which is X1c's round-1 commit `6782c1004` rebased onto INT-2b (same patch-id; E6-X, E6-B; base corrected by E7-C B1).

Repair 1 (E7): X1c ACCEPTED at `c16d103bf` and on integration at INT-2c (`fc2b82cca` + `115ab8d7f`). X1b REPAIR at `10f9b23c5`, repair 2 of 2 (final, test-only); before it the parent rebased X1b onto INT-2c as `131b21d4d` + `a57fa435f`, patch-equal to `c9d4cedb7` and `10f9b23c5`, so X1b no longer sits on an X1c round-1 commit (E7-0). K1b, X1c and G1 are all integrated.

Repair 2 (E8): X1b's lineage is closed (1 build plus 2 repairs). Its review accepted; its adversary found that `discoverCccToolchain` still requires `searchPath`, which section 2.13 declares optional (E6-0) and which G0 step 11, SF and WR leave to the default. The leader re-planned: X1b's three commits are on integration at INT-2d (`3ca856f00` + `40918ac77` + `b290aac0d`, patch-equal to `131b21d4d`, `a57fa435f` and `270f92439`), and the defect is the new W3 card X1z, which must be accepted before W4 (SF). All three W1 residual cards are now integrated.

- **K1b: refusal-code append, capital sharp s key, freeze-test strength, verifier controls, defence in depth** (E3-4, E4-K; K1 residual).
  - Objective: append the one new refusal code that WR and BF need, close the U+1E9E gap in the path comparison key, and harden K1's freeze test and verifier validators, without moving any existing code or changing any exported signature.
  - Base: INT-1b `ff4fc3e4f`.
  - Owns:
    - `packages/core/src/ccc-planning/errors.ts` (append only)
    - `packages/core/src/ccc-planning/schemas.ts`
    - `packages/core/src/__tests__/ccc-planning-{schemas,policy,artifacts}.test.ts`
    - `cards/k1.mjs` (successor owner). K1b's tests live in K1's files, so their names extend K1's closed lists; there is no `cards/k1b.mjs` (E4-K supersedes E3-4 on this).
  - Depends: K1.
  - RED:
    - (1) Refusal code. At INT-1b no K1 test pins the whole list: `ccc-planning-policy.test.ts:497` checks membership only. K1b adds the pinned ordered list there, which is "whichever K1 test pins the refusal-code list" (E4-K). It fails until `CCC_PLANNING_WRITER_CLOSURE_UNCONFIRMED` is appended at the end of `CCC_PLANNING_REFUSAL_CODES`.
    - (2) E2-40a key, with ASCII test names such as "capital sharp s": `src/ẞ.mjs` against `src/ss.mjs`, and `src/ẞ.mjs` against `src/ß.mjs`, are refused across two tasks; `src/straẞe.mjs` and `src/strasse.mjs` are refused as duplicates within one task; bundle files `test/straẞe.mjs` and `test/strasse.mjs` are refused; ẞ, ß and ss have equal keys; and `key(key(x)) === key(x)` over a fixed sample that includes ẞ.
    - (3) Freeze test strength. In a fresh module import (`vi.resetModules()`, then a dynamic import inside the test), every module-level constant that feeds the policy digest is deep-frozen before any digest call. The test must fail if any one module-level `deepFreezeCccPlanningConstant` call is removed; the repair reports each mutant.
    - (4) Controls cannot replace the verifier: `validateCccPlanningVerifierBundleV1` refuses a control file whose comparison key equals a verifier bundle file's key, or lies inside it.
    - (5) Defence in depth: spec-ready `verifierBaseline.files` with a duplicate key, a `.git` segment, a `.env` name or a denied name are refused through the E2-41 helper; a requirement-map `proofIds` entry that fails `CCC_PLANNING_PROOF_ID_PATTERN` is refused.
  - Non-vacuous: the pinned list without the appended code fails (1); on the E2-40 formula `ẞ` keys to `ß` while `ss` keys to `ss`, so the ẞ/ss cases are admitted and (2) fails; (3) is proven by the reported mutants; (4) and (5) are admitted by the INT-1b validators.
  - Positive control: every existing code keeps its position in the pinned list; `ß` against `ss` stays refused, and I against dotless ı stays the accepted, pinned over-refusal; a control that replaces an implementation file outside the bundle is admitted; each (5) refusal has a control that differs in the one field.
  - Accepted residual, not a RED (E4-K item 6): denied names match whole segments only, so `.envrc.bak` is admitted (section 6 risk 48).
  - Check: the K1 Check line in full (card K1, because K1b extends K1's inventory), that is the six K1 test files under `CORE … SUFFIX`, then `pnpm --filter @fusion/core typecheck`, then `pnpm --filter @fusion/core exec tsc -p tsconfig.ccc-planning-tests.json`.
  - Route: sonnet build. Review: critical, because path ownership is a safety invariant (E4-K; E3-4's sonnet route and cheap review are superseded).
  - Round 1 (E6): ACCEPTED at `a46fed5e1` (critical lane; the Opus review and the Opus adversary both accepted). Cherry-picked onto integration as INT-2b `ee89957c1`. The K1b lineage is closed. Recorded residuals:
    - a control path that is a parent directory of a verifier bundle file, or a new file inside a bundle directory, is not refused; this fails closed in practice, because the control's failure carries no `[REQ-x]` tag (section 2.17);
    - the test comment that says ẞ and ß are written "as escapes" is false (cosmetic).
- **X1c: X1 test and hardening residuals** (E4-X; X1 residual; D12, Darwin).
  - Objective: make X1's layout test able to fail, make its quick control independent of host load and its closed check fit the runner bound, and close the seal, seam, dispose, template, orphan and sweep-trust gaps.
  - Base: INT-1b `ff4fc3e4f`.
  - Owns:
    - `packages/engine/src/ccc-confinement/confined-shell.ts`
    - `packages/engine/src/__tests__/ccc-confined-shell.darwin.test.ts`
    - `cards/x1.mjs` (successor owner)
    - new `packages/engine/src/__tests__/ccc-confined-denied-names.test.ts`
    - new `cards/x1c.mjs`
    - `packages/engine/src/ccc-campaign-proof-sandbox.ts` (repair 1, under X1's grant: helper exports only, no behaviour change, and only if E6-X item 7 needs it)
  - Depends: X1.
  - RED:
    - (1) E2-24 layout test, rewritten with builtins and node only: `n="$(command -v node)"; echo planted > "${n%/*}/planted"; echo "bin-write-rc=$?"`; a node `mkdirSync($HOME/../toolchains/other)` that prints `toolchains-mkdir-err <code>`; optionally a node `writeFileSync` over `${n%/*}/node`. It asserts `toMatch(/^bin-write-rc=1$/mu)` and `toContain("toolchains-mkdir-err EPERM")`, never a bare `rc=1` substring.
    - (4) Seal coverage: a fixture toolchain whose cloned library changes after sealing is refused with `toolchain-digest-drift`.
    - (5) Narrow seam: `createCccConfinedBashOperations(input, {sealedEnvironment: …})`, or any key other than `lsofPath`, throws `TypeError`.
    - (6) Dispose result: with a failing lsof stub, `dispose()` returns `{closure: "unconfirmed"}`; it is idempotent.
    - (7) Template material: `CCC_WRITER_SHELL_PROFILE_TEMPLATE_MATERIAL` includes `SYSTEM_RUNTIME_READ_ROOTS`, `DEVICE_READ_FILES` and each input of the writer-profile assembly.
    - (8) No stopped orphans: with a failing lsof stub and a background child that prints its pid, the exec refuses as unconfirmed, and within 2 s `process.kill(pid, 0)` throws `ESRCH`. On that path the sweep saw nothing, so the foreign-pid filter confirms an instance pid without it, by the E6-X item 3 conditions in section 2.13 (F3).
    - (9) Sweep trust (E4-7): an lsof stub that exits 1 with empty stdout means unconfirmed, not clean; a stub whose output omits the controller pid means unconfirmed.
    - (10) E2-81 consistency test (platform `any`, `ccc-confined-denied-names.test.ts`): every name in K1's `CCC_PLANNING_DENIED_NAMES` is matched by `cccConfinedEffectiveDeniedNames([])`.
  - Non-vacuous: removing the toolchains write-deny makes (1) fail (report the mutant); (4) passes on X1's PATH-only hash; (5) is accepted by the INT-1b factory, whose `testOnly` also takes `sealedEnvironment`; (6) returns nothing today. (9) and (10) are pinning tests that pass at INT-1b; their failing signature comes from a reported mutant, as for (1) (F2). For (9) the mutant treats exit 1 with empty stdout as a clean scan, or skips the sawSelf check; for (10) the mutant removes `.envrc` from `CCC_CONFINED_DEFAULT_DENIED_NAMES`.
  - Positive control: the `existsSync` checks and the `$HOME` write in (1); an unchanged toolchain runs in (4); real `/usr/sbin/lsof` gives `{closure: "confirmed"}` in (6); the quick positive control below passes at load.
  - Load and runtime (items 2 and 3, checked by the parent's two recorded runs, not by a RED):
    - The quick positive control uses a model timeout of at least 30 s; only the command that must time out keeps the 1 s timeout. The wall timer starts at the reaper's `CCC-STARTED` frame, so per-instance clone and hash time is never counted; bash and node start-up inside the sandbox is counted, as Pi's native bash counts it.
    - Tests that do not test isolation, lifecycle or qualification itself share one operations instance and one qualification. Any second full qualification that E2-21 does not need becomes the narrowest probe. If needed, `cards/x1.mjs` is split into several names-closed commands.
    - Each command's `timeoutMs` is at least 1.5 × the worst duration measured at a host load average of 25 or more, and within P0's maximum. The closed check runs twice, and both durations and load averages go in the card header. This sizes a runner hang bound for a deterministic suite; it is not a test-timeout widening.
  - Contract notes, no RED (item 11): the extra reason `instance-disposed` is listed in section 2.13, and the RLIMIT_CPU row moves from the `confined-shell.ts` header to section 6 risk 44.
  - Frozen for X1b, which runs at the same time: X1c changes no exported signature except (i) `dispose()` returns `CccConfinedDisposeResult` instead of `void`, (ii) the factory's `testOnly` is narrowed to `{ lsofPath? }`, and (iii) `CccSealedToolchain` may gain output fields that only `sealCccToolchain` computes (E4-X item 4; F6). `sealCccToolchain`, `qualifyCccConfinedShell` and `CccSealedExecutable` keep their input shapes. X1c's round 1 used (iii) to add `libraries`, and X1b's repair base carries it, so X1c's repair keeps that field.
  - Check: `ENGINE src/__tests__/ccc-confined-shell.darwin.test.ts SUFFIX` (or its split commands), which must show 0 skipped on Darwin, then `ENGINE src/__tests__/ccc-confined-denied-names.test.ts SUFFIX`, then the engine typecheck. Outside regression check, as for X1: `ENGINE src/__tests__/ccc-campaign-proof-sandbox.test.ts SUFFIX`.
  - Route: opus. Review: critical.
  - Round 1 (E6): REPAIR at `6782c1004`, repair 1 of 2 (opus, critical). One fail-open path, plus hardening the adversary recommended.
    - Base: rebased onto INT-2b `ee89957c1`, which carries K1b's E2-40a key (item 6 needs it; it is a base fact, not a W1r dependency).
    - Owns: as E4-X. The last Owns entry above is X1's helper-export grant on `ccc-campaign-proof-sandbox.ts`, which X1c holds as successor owner for item 7 (E6-X item 7).
    - Repair 1 items (E6-X), each with a RED that fails on a behavioural assertion against the round-1 bytes, or a reported mutant where the frozen seam cannot reach the fault, plus its positive control:
      - (R1) Fail-open path (item 1, required by the review). The orphan kill is best effort: `killReaperStoppedPids(...)` sits in try/catch, its failure is recorded in the error message, and `execOnce` always throws `CccConfinementClosureError` when `!sweep.converged` or the reaper frame is unsandboxed. `execOnce` sets the instance's unconfirmed latch directly at that point, not from the error class in `operations.exec`. Proof: the review's fault-simulation mutant, a ps capture that throws `spawn ENOMEM` synchronously; the exec still rejects with `CccConfinementClosureError` and `dispose()` returns `unconfirmed`. The frozen seam cannot reach `/bin/ps`, so this is a reported mutant run.
      - (R2) Dispose evidence (item 2). RED: a background escaper that survives an exec, then `dispose()`, which returns `unconfirmed` because its final sweep found and killed an instance process.
      - (R3) Stopped-orphan filter (item 3, F3). The unconfirmed-path kill uses the section 2.13 conditions. If macOS gives no such executable path without lsof, the filter uses the first three conditions, the report says so, and a test shows that an older stopped same-uid process the test owns is not killed; RED (8) still passes (E7-C N6).
      - (R4) `killStoppedSeen` (item 4). A stateful lsof stub, which the frozen `lsofPath` seam allows: its first scan lists the controller and an instance pid, and later scans fail. Assert that the pid it had stopped is killed. A mutant removing `killStoppedSeen` must fail it.
      - (R5) lsof stalls (item 5). Measure lsof `-b`, `-e <mount>` for each network mount read from `mount` (smbfs, nfs, afpfs, webdav), and one bounded retry of a timed-out scan; apply what removes the stall without weakening the E4-7 trust rule. A test proves that, with the chosen flags, the scan still parses, still lists the controller's own pid and still sees clone inodes. The stall rate before and after and the flags chosen go in the card header and section 6 risk 49. Do not unmount or change the host.
      - (R6) One path key (item 6). `confined-shell.ts`'s private copy of the E2-40 fold (about line 843) is replaced by K1's `cccPlanningPathComparisonKey` from `@fusion/core`. RED: a caller-added denied name `.ssh` refuses a write to a not-yet-existing `.ẞh` path.
      - (R7) Template material (item 7). Either the rules of `darwinLinkedRuntimeFiles`, `resolveLinkedPath` and the read-root derivation enter `CCC_WRITER_SHELL_PROFILE_TEMPLATE_MATERIAL`, or a test shows that the qualification receipt records the digest of the fully rendered profile, discovered read roots included, so a widened read root changes a recorded digest.
      - (R8) Measurement (item 8). The `cards/x1.mjs` header records the adversary's high-load measurement: 51/51 in 125 s at load 24.6-36.2 (mean 33), lsof at most 0.51 s, with 20 bounded CPU burners. `timeoutMs` stays at least 1.5 × the worst duration measured.
      - (R9) Optional (item 9): drop EACCES from the optional node-overwrite regex in RED (1), so that it discriminates.
  - Repair 1 (E7): ACCEPTED at `c16d103bf` (critical lane; the fresh review and the fresh adversary both accepted). Cherry-picked onto integration as `fc2b82cca` + `115ab8d7f` (INT-2c). The X1c lineage is closed. Recorded residuals (section 6 risks 52 to 54):
    - lsof `-b` was chosen from the mechanism (lsof's mount-point stat, with its 15 s `-S` default, exceeds the 11 s capture limit), not from a measured stall; the smbfs mount was gone during repair 1, so the after-rate is inferred. Any stall still fails closed.
    - The writer-shell profile template digest binds function source text, so it differs between the vitest transform, tsc `dist` and each tsup bundle. A qualification receipt is valid only for the build that produced it (G0 records the digest of the build under test).
    - The wrapper sets `ulimit -t` and `ulimit -f` but not `ulimit -u`; a confined fork bomb that exhausts the user's process limit makes the sweep's spawns fail with EAGAIN, and the exec then refuses (fails closed) rather than reaping. A risk row, not a repair item.
- **X1b: toolchain discovery and package-command compatibility** (E2 moved it out of X1's scope; E4-B moves it from W3 to the W1 residual; D12, Darwin).
  - Objective: find and seal a non-platform toolchain under unprefixed names, and run package commands through it. The I2 target is pure `node --test` with Taskfile, so I2 needs only discovery and unprefixed names; the shim layer is required before the I3 held-out cases.
  - Base: INT-1b `ff4fc3e4f` (E4-B).
  - Owns:
    - new `packages/engine/src/ccc-confinement/toolchain-discovery.ts`
    - new `packages/engine/src/ccc-confinement/shell-compat.ts`
    - new `packages/engine/src/__tests__/ccc-toolchain-discovery.darwin.test.ts`
    - new `packages/engine/src/__tests__/ccc-shell-compat.darwin.test.ts`
    - `cards/x1b.mjs`
  - Depends: X1 only (E4-B). Its files are new and disjoint from those of the other W1 residual cards.
  - RED (discovery REDs use fixture PATH directories with stub executables, E4-15):
    - Discovery finds the default required set, non-platform (Homebrew) `bash`, `sh`, `node`, `git`, `task` and `rg` plus the GNU coreutils, and the default optional set, GNU grep, sed, findutils, gawk and diffutils, each when present (E6-0). It seals them with unprefixed names through `CccSealedExecutable.name` (E2-25), so `gcat` is sealed as `cat`. `sh` is passed as `sealCccToolchain`'s `sh` path, which always appears in PATH as `sh`; the source is Homebrew `dash` if present, else Homebrew `bash` (E4-15), and no name field is passed (F4, E6-B item 7).
    - A missing required tool: `discoverCccToolchain` throws `CccPlanningRefusal` with code `CCC_PLANNING_CONFINEMENT_UNQUALIFIED` and detail `toolchain-missing:<tool>`, asserted on a fixture PATH. The RED does not touch G0 (E4-5); CL2 covers the G0 step.
    - Every wrapper carries a toolchain shebang.
    - A `BASH_ENV` dispatcher runs `node_modules/.bin` shims through the toolchain `sh` and sets `npm_config_script_shell`, through the shell-compat decorator in the rules below (F5).
  - Non-vacuous: X1 refuses an Apple platform binary with `platform-binary-in-toolchain` (E2-25), so a discovery that falls back to the platform `/bin` or `/usr/bin` tools cannot yield a toolchain X1 accepts.
  - Positive control: the real host scan, which stays Darwin-only: on the I2 host the default discovery succeeds, the required set is found and sealed, and a sealed `cat` (from `gcat`) runs inside X1's sandbox. The real scan is reported as evidence only (E4-15, E6-B item 4).
  - Rules (E4-B): build toolchains only through `sealCccToolchain`; never pass `sealedEnvironment` to the factory; export `discoverCccToolchain` (section 2.13), which G0, SF and WR use; share fixtures across the Darwin tests to keep the closed check under a measured bound; size each command's `timeoutMs` the X1c way (1.5 × the worst duration measured at load average 25 or more, within P0's maximum).
  - Rule (F5, E6-C): X1's taskEnv check refuses `BASH_ENV` and `npm_config_script_shell` as task environment keys, so `shell-compat.ts` exports a `BashOperations` decorator that prefixes each command with the dispatcher setup: it exports `BASH_ENV` and `npm_config_script_shell` inside the command, with the dispatcher in a read-admitted path. SF and WR apply the decorator.
  - Rule (E6-0): discovery defaults are the minimal required set, the optional GNU set and the Homebrew-only search path (`/opt/homebrew/bin`, then the `opt/<formula>/bin` and `libexec/gnubin` directories of the formulae the catalogue names). User-writable directories (`~/.local/bin`, `~/go/bin`, `~/.cargo/bin` and the like) are never on the default path; a caller may pass an explicit `searchPath`. `whoami` leaves the catalogue, because it fails inside the sandbox. A missing optional tool is left out silently; the qualification receipt and the planning prompts can name it.
  - Check: `ENGINE src/__tests__/ccc-toolchain-discovery.darwin.test.ts src/__tests__/ccc-shell-compat.darwin.test.ts SUFFIX`, which must show 0 skipped on Darwin.
  - Route: opus. Review: critical.
  - Round 1 (E6): REPAIR at `8025e5a87`, repair 1 of 2 (opus, critical). Two tests cannot fail, some hardening is untested, and the default search path reached into user-writable directories.
    - Base: `853f08491`, which is X1c's round-1 commit `6782c1004` rebased onto INT-2b (same patch-id; E7-C B1); the branch is rebased onto it, so X1b sees `CccSealedToolchain.libraries`. When integrating, the parent cherry-picks only X1b's own commits. This is a base fact, not a dependency on X1c (E6-B). Repair 2 has a new base (E7-0, below).
    - Owns: as E4-B.
    - Repair 1 items (E6-B), each with a RED that fails on a behavioural assertion against the round-1 bytes, or a named mutant that must fail, plus its positive control:
      - (B1) Pin the shim interpreter (item 1). `PNPM_SHIM`, or a dedicated `#!/bin/sh` fixture, prints `SH-BASH=${BASH-unset}` and whether `SHELLOPTS` contains `posix`. When `sh` was sealed from bash, `SH-BASH` equals `join(dirname(exec), "sh")` with posix on; when it was sealed from dash, `SH-BASH=unset`. Mutant `sh|dash) tool=bash` must fail. Keep the raw-shell control.
      - (B2) Pin directory-first lookup (item 2). An unprefixed `cat` stub in a directory after `earlier/`, while `cat` still resolves to `{path: earlier/gcat, name: "cat"}`. Mutant D12 (loops swapped) must fail.
      - (B3) Untested hardening (item 3): an extra file in the wrappers directory refuses the next exec (implemented, since the header claims it: plant `<install.dir>/extra-planted`, and the exec is refused); the `env -S` shebang handling has a test; a missing `bash` role and a missing `node` role each refuse with `toolchain-missing:<tool>`; the X_OK check in `usableCandidate` has a test.
      - (B4) E6-0 decisions (item 4). REDs from fixture PATH directories with stub executables: a missing optional tool still yields a toolchain; a missing required tool refuses; a tool found only in a user-writable directory is not found by default, but is found when the caller passes that directory explicitly. Positive control: the default discovery succeeds on this host.
      - (B5) Sizing (item 5). Measure the closed check once at host load average 25 or more; if the host is quieter, add bounded CPU burners for at most 3 minutes and stop them afterwards. `timeoutMs` is at least 1.5 × the worst run, and both runs go in the header.
      - (B6) Record, do not fix (item 6): `cccConfinedShellLastClosure` must be read from the inner operations, which WR does; the Taskfile, `exec` and PATH-change residuals (section 6 risk 51); pnpm and yarn have no wrapper.
      - (B7) Contract text only (item 7): the `sh` wording in the first RED above (F4).
  - Repair 2 (FINAL, E7): REPAIR at `10f9b23c5` (the review accepted; the adversary asked for repair), repair 2 of 2 (opus, critical; test-only).
    - Base: INT-2c `115ab8d7f`, leaf head `a57fa435f`: `131b21d4d` (= `c9d4cedb7`) + `a57fa435f` (= `10f9b23c5`). X1c is integrated, so X1b sits directly on INT-2c and the parent cherry-picks its commits as-is (E7-0).
    - Owns: as v3.3 X1b. No source change is expected; if one is needed to make a pinned behaviour hold, the leaf stops and reports it as a deviation.
    - Repair 2 items (E7-B), each a RED that fails on the repair-1 bytes, or a pinning test whose failing signature comes from the named mutant, plus its positive control:
      - (E7-B 1) Nested bash keeps the shim directories (required). Add a package script `nested: "bash -c 'hello from-nested'"` (or a `#!/usr/bin/env bash` `.bin` shim that calls `hello`), and assert HELLO-CLI and rc 0 through `compat`; keep the raw-shell control. Report that mutant N1 (`rest=` in place of the inherited-shim merge) fails on an assertion.
      - (E7-B 2) `#!/usr/bin/env bash` runs bash, not sh (required). A `.bin` shim with that shebang prints `${BASH-unset}` and the posix state; assert `BASH` equals `join(dirname(exec), "bash")` with posix off. Report that mutant N11 (`bash) tool=sh`) fails.
      - (E7-B 3) The no-shebang fallback runs sh (required, small). Pin the header's claim; mutant N2 (`*) tool=bash`) fails.
      - (E7-B 4) Optional: a test for mutant N7 (dropping `isRealDirectory(install.wrapperDir)`).
      - (E7-B 5) Record in the test and card headers: inside the sandbox `id -un` fails like the dropped `whoami` ("cannot find name for user ID"), so only numeric `id`/`id -u` is supported; `/opt/homebrew` is operator-writable, so "Homebrew only" does not mean protected (sealing records digests, so later changes fail closed); a keg-only `node@NN` not linked into `/opt/homebrew/bin` is not found by default; an optional tool that sealing rejects refuses the whole discovery (fails closed); an unprefixed Homebrew name in a directory wins over the g-name there.
      - (E7-B 6) Fix the stale test-header lines 17-18 ("reported as evidence, not asserted").
      - (E7-B 7) Confirm that the closed check still typechecks and passes on INT-2c (X1c's accepted bytes), and update `cards/x1b.mjs` names exactly.
  - Repair 2 outcome (E8): lineage closed, re-planned. The review accepted `270f92439`; the adversary found that `discoverCccToolchain` still requires `searchPath` (section 2.13 declares it optional). X1b's commits are integrated as they are at INT-2d (`3ca856f00` + `40918ac77` + `b290aac0d`). The defect, with the compat decorator's `dispose` pin (mutant X2), becomes card X1z (W3), successor owner of `toolchain-discovery.ts`, both Darwin tests and `cards/x1b.mjs`.

**Integration of the W1 residual (parent; E6-0, E7).** The parent cherry-picks each accepted residual card as its exact accepted range at the first INT step after its acceptance, with the same checks as INT-1b plus `pnpm test:ccc-planning`. K1b is on integration at INT-2b `ee89957c1`, which ran fewer checks: the CLI typecheck and `pnpm test:ccc-planning` were owed, and INT-2c ran both (E7-C N2). X1c is on integration at INT-2c `115ab8d7f` (E7). X1b's lineage closed at repair 2, and its three commits landed as they are at INT-2d `fcb83879d` (E8), before W4 as required, because SF (W4) depends on X1b and X1c; its residual defect is card X1z (W3), which SF now also depends on.

#### Wave W2

- **K2: authority receipt, qualification port, route admission** (G0, D23, D24, critic 11).
  - Objective: parse and check the live-authority receipt, the null qualification port and request-to-code route admission.
  - Owns:
    - `packages/core/src/ccc-planning/authority.ts`
    - `packages/core/src/ccc-planning/qualification.ts`
    - `packages/core/src/ccc-campaign/route-admission.ts`
    - `packages/core/src/__tests__/ccc-planning-authority.test.ts`
    - `packages/core/src/__tests__/ccc-planning-qualification.test.ts`
    - `packages/core/src/__tests__/ccc-campaign-route-admission.test.ts`
    - `cards/k2.mjs`
  - Depends: K1.
  - RED:
    - A receipt naming `glm/glm-5.2` gives `REJECTED_MODEL_IDENTITY`.
    - `phaseCallCaps.planning = 1535` gives `BUDGET_POLICY_MISMATCH`.
    - A wrong confirm digest gives `UNCONFIRMED`; a missing one gives `AUTHORITY_CONFIRMATION_REQUIRED`.
    - An extra key gives `INVALID`.
    - An `admitted_repository` class with the null certificate gives `QUALIFICATION_REQUIRED`.
    - The envelope check accepts key `ccc-plan:<24hex>:r1` and refuses `ccc-plan:<24hex>:<digest>`.
    - Route admission refuses `combo/x` as `combo-route`, and refuses a Flash writer reviewed by `glm/glm-5.3` as `same-family-review`.
  - Non-vacuous: the stub admits everything, so every refusal fails.
  - Positive control: each refusal has a control receipt or route that differs in one field and is admitted.
  - Check: `CORE src/__tests__/ccc-planning-authority.test.ts src/__tests__/ccc-planning-qualification.test.ts src/__tests__/ccc-campaign-route-admission.test.ts SUFFIX`
  - Route: opus. Review: critical.
  - Round 1 (E5): REPAIR, repair 1 of 2 (opus, critical). Base INT-2b `ee89957c1` (E5 named INT-2a `9d4add879`; the parent re-rebased at 17:09; round-1 bytes `0876ea993`; E7-C B1). Each item has a RED that fails on a behavioural assertion against the round-1 bytes, plus its positive control (section 2.18):
    - (K1) Remaining-calls guard (item 1): `run.implementationCallsRemaining` NaN and undefined each refuse `ENVELOPE_MISMATCH` on that field. Control: 3072 stays within.
    - (K2) Literal member model (item 2): a resealed receipt with `glm53Flash = glm/glm-5.3` and members on `glm/glm-5.3` is refused.
    - (K3) Route-kind allowlist (item 3): an unknown `routeKind` is refused `role-model-mismatch`. Control: `g8-judge` is admitted.
    - (K4) Run-to-receipt binding (item 4): the fixture's `RUN_ID` is derived from the control receipt. REDs, each with a one-field control: another receipt's run id; a Spec receipt; `maxRequests` above `receipt.phaseCallCaps.implementation`. The test "or is not the receipt the run consumed" must actually exercise the binding.
    - (K5) Non-vacuity table (item 5): one RED per guard that the round-1 mutants left unprotected, each built from the control with one field changed, the control admitted:
      - envelope: `now` before `notBefore`; zero members; `maxRequests` 0; a non-hex baseline commit; a receipt edited without resealing but with a matching `receiptSha256`; the changed path `proof/../src/index.mjs`;
      - route admission: a G7 identity on a writer task; a G7 review of a review or of a non-writer; duplicate task ids; a pin with the wrong family or a malformed settings digest; a G8 judge with a non-null `reviewOfTaskId`;
      - parse, table-driven, one row per field check: `notBefore < issuedAt`, `expiresAt <= notBefore`, `baseTree` format, distinct provider ids, quota, escalation, profile, `receiptId`, request `byteLength` and `sha256`, marker `sha256`, runtime and source-policy digests, the adapter literal, `largeAuthorized` type, operator `actorId`, `baseCommit` format, absolute `scratchRoot`, mode, `meteredFallback`, the release literal, and a duplicate admitted path.
      - Re-run the mutation sets (the reviewers' scripts under `scratchpad/review-k2/` and `scratchpad/adv-k2/`) and report each mutant killed.
    - (K6) One provider per model (item 6): pins that give two models the same `providerId` are refused `provider-not-pinned`.
    - (K7) Case-insensitive `.git` ban (item 7): `.GIT/**` is refused.
    - (K8) Accepted round-1 deviations, no change (item 8): `CccCampaignProductRoute` is an alias of `CccCampaignProductExecutionRoute`; `CccRouteRole` has no G8 value; the parse runs expiry and caps inside G0 step 2 and refuses malformed `budgetProfile` values and any profile other than `full-v2` (CL2 owns `LARGE_NOT_AUTHORIZED`; no receipt reaches `PROFILE_NOT_SUPPORTED` while the parse accepts only `full-v2`, E7-0, N1).
  - Repair 2 (FINAL, E7): REPAIR at `5636bb733` (the review accepted; the adversary asked for repair), repair 2 of 2 (opus, critical).
    - Base: INT-2c `115ab8d7f`, leaf head `ef72f9868`: `42d2ffde8` (= `0876ea993`) + `ef72f9868` (= `5636bb733`) (E7-0).
    - Owns: as v3.3 K2.
    - Repair 2 items (E7-K), each a RED that fails on a behavioural assertion against the repair-1 bytes, or a pinning test whose failing signature comes from the named mutant, plus its positive control (sections 2.7 and 2.18):
      - (E7-K 1) Fail-open on a malformed certificate (required). In `certificateApplies` (`qualification.ts`, about 56-69), return false unless each of `scope.targetClasses`, `scope.modes` and `scope.profiles` is an array (`Array.isArray`) whose entries are all strings, before any `.includes`; correct the :67 comment if needed. RED (`ccc-planning-qualification.test.ts`): a certificate whose scope fields are strings (one string-typed field at a time, three cases), with its `certificateId` recomputed over the canonical body, gives `QUALIFICATION_REQUIRED`. Control: the array-typed twin stays admitted.
      - (E7-K 2) Non-vacuous deadline row (required). From the envelope control: `run.deadlineAt` later than the receipt deadline (for example `2026-10-17T12:00:00.000Z`) and `authorization.campaignDeadlineAt` between the two (for example `2026-10-16T12:00:00.001Z`) give `ENVELOPE_MISMATCH` on `authorization.campaignDeadlineAt`. One-field control: `campaignDeadlineAt` equal to the receipt deadline stays within. Report that mutant A46b (`const deadline = envelopeTime(run.deadlineAt, ...)`) now fails.
      - (E7-K 3) Cap type (required). The remaining-calls check requires `typeof cap === "number" && Number.isSafeInteger(cap)`; correct the `authority.ts` comment at about 582-585. RED: a resealed (unparsed) receipt whose `maxRequests` is the string `"3500"` with 4000 remaining is refused. Control: the number 3500 is within.
      - (E7-K 4) Pinning tests (required; signature from a reported mutant). (a) The envelope's `actions.length !== 1` guard: a sealed receipt listing `[controller_within_receipt, operator_confirm_after_import]` is refused (mutant A31b fails). (b) The receipt `schema` literal: a receipt with another schema string is refused (mutant P28 fails). (c) The UTF-8 `fatal: true` decode: invalid bytes inside a JSON string value are refused (mutant B14 fails; the old `[0xff,0xfe]` input does not discriminate).
      - (E7-K 5) Review identity by exact shape (required; section 2.7). `route-admission.ts` (about 52-54) must not decide that a route is a review identity from `hasOwnProperty("routeKind")`. A route counts as a review identity only when its key set is exactly the seven keys of K2's own `CccPlanningReviewIdentity` (E8-0, N-4, correcting "the review-route shape that `canonical.ts` produces"); an object that carries product-route keys plus `routeKind` is refused (`CCC_ROUTE_IDENTITY_REJECTED`, reason `role-model-mismatch`, which the import bridge reports as `ROUTE_NOT_ADMITTED`; E8-0, N-4). RED: probe F4 (a product route for writer task T1 on `minimax/MiniMax-M3` that also carries `routeKind: "g8-judge", reviewOfTaskId: null`) is refused. Control: the plain product route is checked by the writer rule as before. Also add the review-of-review row whose reviewed identity has graph role `writer`, so deleting only `isReviewIdentity(reviewed) ||` (`route-admission.ts:111`) fails.
      - (E7-K 6) `.git` in changed paths (required, small). Apply the same case-insensitive `.git`-segment ban to `baseline.changedPaths` that the admitted patterns already have. RED: `proof/.GIT/config` is refused. Control: `proof/x` is within.
      - (E7-K 7) Update `cards/k2.mjs` names exactly.
  - Repair 2 outcome (E8): ACCEPTED at `c594c8c02` (review and adversary both accept), integrated at INT-2d as `11c512ee1` + `9485e02cc` + `2e9d0cbb8`. N-4: for probe F4, K2 refuses `CCC_ROUTE_IDENTITY_REJECTED` with reason `role-model-mismatch`, and the review identity is K2's own 7-key `CccPlanningReviewIdentity` (`route-admission.ts`), not a `canonical.ts` shape (section 2.7). Recorded residuals, not fixed (section 2.7; section 6 risks 55 and 56): `certificateApplies` trusts the array prototype (unreachable through JSON); G8 identities never call `roleOf` (IB2 obligation); the deadline row is pinned at 1 ms.
- **L1: ledger, control, cancellation and retention** (PRD §5, §9, §10, D3-D5, D13, D32, D45, critic 14, challenges 6, 9, 16, 17; verify-v2 items 35, 36, 38, 42, 50 and the repair-count ruling).
  - Objective: every planning counter, control and settlement rule, enforced in one transaction each.
  - Owns:
    - `packages/core/src/task-store/ccc-planning-ops.ts`
    - `packages/core/src/task-store/async-maintenance.ts` (retention hunk)
    - `packages/core/src/__tests__/postgres/ccc-planning-ledger.pg.test.ts`
    - `packages/core/src/__tests__/postgres/ccc-planning-control.pg.test.ts`
    - `packages/core/src/__tests__/postgres/ccc-planning-retention.pg.test.ts`
    - `packages/core/src/__tests__/postgres/ccc-planning-transition-parity.pg.test.ts`
    - `cards/l1.mjs`
    - `packages/core/src/ccc-planning/types.ts` (repair 2 grant, E7-0: the one line at about 214 that removes the `deferred-leased` literal from `CccPlanningRunStatusV1.lastControl.outcome`; nothing else in that file)
  - Depends: K1, S0.
  - RED:
    - In one turn key, the call with dispatch key `pi-stream:11` is admitted and `pi-stream:12` is refused with `iteration-cap`.
    - `claimCccPlanningRepairChunk` refuses `CCC_PLANNING_ROUTE_NOT_ADMITTED`, with detail `role-class-mismatch` in the refusal message, for a `reReviewers` entry whose role is not reviewer-class, and, in a second RED, for a `repairAuthors` entry whose role is not author-class (E2-9, E3-2). A role is reviewer-class when its K1 `roleClass` is `critic`, and author-class otherwise (`author`, `researcher` or `writer`) (E4-11).
    - The 4th distinct turn key in a lineage is refused with `dispatch-cap`.
    - A split child that inherits count 2 has its 2nd attempt refused; a repair lineage `repair:1:spec-author` claimed after the role used 2 attempts inherits 2, and its 2nd attempt is refused; `claimCccPlanningRepairChunk` refuses `DISPATCH_CAP` when a repair author has no attempt left, and writes no `lineage:created` event and no chunk.
    - Repair-count ruling (D13): a chunk with `reReviewers: ["product-adversary"]` claimed after that critic's `review:product-adversary` lineage used 3 attempts creates review node `review:product-adversary:rv1` with `kind: "review-node"` and inherited 0, which admits 3 turn keys and refuses the 4th; chunk 2 creates `rv2`, again inherited 0; a 5th chunk is refused `REPAIR_EXHAUSTED` whatever the counters say.
    - A preflight attempt's 4th call is refused (`CCC_PLANNING_PREFLIGHT_MAX_CALLS_PER_ATTEMPT`), and a fresh turn key in the same lineage admits 3 more.
    - `dispatched_unknown` in lineage L blocks L while lineage M proceeds.
    - Two connections race at `spent = allocation − 1`, and exactly one wins, in the lock-held shape of repair item (L1) below (E5-L1 item 1).
    - A settlement with `refusalReason: "effective-route-drift"` records `refused_known_effect`, spend stays charged, the run moves `running → blocked_provider` with `CCC_PROVIDER_PIN_DRIFT` in the same transaction (read back from PostgreSQL), the next reservation is refused, and a second identical settlement is a no-op (item 42).
    - A `review_proof` reservation under a campaign fence (`kind: "campaign"`, `runId = ccc-prd:<import_id>`) on a run in `building` is admitted and charged to `review_proof_spent`; the same reservation with a planning fence is refused, and so is a campaign fence naming another import (item 50, D14).
    - `inspectCccPlanningRun(layer, runId, {reconcileLinkedOutcome: stub})` calls the stub exactly once before reading for a linked run and never for an unlinked one; called without ports it only reads (item 35).
    - `requestCccPlanningControl('pause')` while running sets `control_request`, and the next dispatch is refused with `control-pending`.
    - `answerCccPlanningDecision` moves the run to `running` **and** the held planning work item to `runnable` in one transaction; `resume` from `paused` does the same; `cancel` from `awaiting_intent` with no live holder ends `cancelled` with the work item `cancelled`.
    - A control request on a run with `import_id` set is refused with `CONTROL_REQUIRES_CAMPAIGN_BRIDGE`; pause in `importing` is refused with `COMMAND_NOT_SUPPORTED`.
    - `recordCccPlanningBuildControl` in `building`: pause and resume are refused with `COMMAND_NOT_SUPPORTED` and `control_seq` is unchanged; cancel bumps `control_seq`, sets `control_request = 'cancel'`, and the next planning `review_proof` reservation is refused with `control-pending` (item 36). On a linked run, cancel also stores `control_request = 'cancel'` in each other state that has an allowed `→ cancelling` pair, one case per state: `importing`, `awaiting_execution_authority`, `paused`, `awaiting_budget`, `blocked_prerequisite`, `blocked_provider`, `budget_exhausted`, `unknown_effect`, `verification_failed` and `accepted`. In `delivering`, which has no such pair, it refuses `CCC_PLANNING_STATE_TRANSITION_REFUSED` and writes nothing (E2-3, E3-1, E4-13).
    - An `actor` longer than 200 characters is refused with `CCC_PLANNING_INTERNAL_ERROR` and changes no row (E2-4, defence in depth; E3-3, E4-6: the CLI refuses first with `usage_error`, so reaching L1 means a caller bug).
    - `resolveCccPlanningRunProject` returns `RUN_NOT_FOUND`, `RUN_AMBIGUOUS` (same run id seeded in two projects) and `RUN_PROJECT_MISMATCH` as specified.
    - The control and answer audit events carry `agentId = operator:<actor>`.
    - For all 400 (from, to) pairs, `project.ccc_planning_run_transition_allowed` equals K1's `cccPlanningTransitionAllowed`, and exactly 65 non-identity pairs are true.
    - A stagnant epoch twice gives `stop: true`. Retention with 0 days deletes a non-planning event and keeps the `ccc-plan:` one.
  - Non-vacuous: the race uses real concurrency on two pool clients and proves 2 lock waiters before the admin commit, so it cannot pass serially, and it fails with the anchor and fence locks or the spend CAS removed (E5-L1 item 1); the fence-kind case re-leases the work item first, so only the kind check can refuse (E5-L1 item 2); the requeue cases read the work item row back from PostgreSQL, which a state-only implementation leaves `held`; the dispatch-key boundary uses the real 1-based keys.
  - Positive control: a fresh lineage with 0 inherited attempts admits three turn keys; the retention control proves deletion runs; a run without `import_id` accepts the same pause; a `refusalReason`-free committed settlement leaves the run `running`.
  - Check: `CORE_PG src/__tests__/postgres/ccc-planning-ledger.pg.test.ts src/__tests__/postgres/ccc-planning-control.pg.test.ts src/__tests__/postgres/ccc-planning-retention.pg.test.ts src/__tests__/postgres/ccc-planning-transition-parity.pg.test.ts SUFFIX`
  - Route: opus. Review: critical.
  - Rule (E1 carry-forward): `TaskStore.recordRunAuditEvent` drops `eventId` (`task-store/project-store-ops.ts:516-526`), so L1 calls the data-layer function directly.
  - Round 1 (E5): REPAIR, repair 1 of 2 (opus, critical). Base INT-2b `ee89957c1`, which holds A1's publisher (E5 named INT-2a `9d4add879`; the parent re-rebased at 17:09; round-1 bytes `0ce304036`; E7-C B1). Each item has a RED that fails on a behavioural assertion against the round-1 bytes, plus its positive control (section 2.11):
    - (L1) Real race (item 1), replacing the race RED above. An admin transaction holds `SELECT 1 FROM project.ccc_planning_runs WHERE project_id=$1 AND run_id=$2 FOR UPDATE`; both `admitCccPlanningDispatch` calls start; a bounded loop polls `pg_stat_activity` (`datname = current_database() AND wait_event_type = 'Lock'`) until 2 waiters are seen; then the admin transaction commits. Assert: 2 waiters were seen; exactly one call was fulfilled; the other was rejected as `CccProviderAttemptLimitError` with reason `phase-allocation`; `planning_spent` is the allocation; there are exactly 2 `call:reserved` events. Show it fails with the anchor and fence locks removed, and with the spend CAS removed.
    - (L2) Fence-kind test (item 2): before the review_proof-under-planning-fence probe, re-lease the planning work item (state `running`, the fence owner, a future `lease_expires_at`), so only the kind check can refuse; removing the kind check fails it.
    - (L3) Lineage admission (item 3, ADV-1). REDs: an unclaimed `repair:1`; an ordinal above `CCC_PLANNING_MAX_REPAIR_CHUNKS`; an unclaimed `:rvk`. The test helper that switched to an unclaimed stage to make a turn changes.
    - (L4) Superseded lineages (item 4): REDs for the ADV-8 and ADV-9 sequences.
    - (L5) Pending control blocks transitions (item 5): the ADV-12 sequence (pause pending at `spec_ready`, then `spec_ready → importing` refused `CCC_PLANNING_CONTROL_PENDING`) and a concurrency variant in which the pause commits between the caller's read and the transition. Control: with no pending control, the transition succeeds.
    - (L6) Unknown refusal reasons fail closed (item 6, ADV-2): an unknown `refusalReason` refuses `CCC_PLANNING_INTERNAL_ERROR` and writes nothing.
    - (L7) Database clock (item 7): a caller `now` far in the future does not complete a cancellation while a live lease exists.
    - (L8) One path to `cancelled` (item 8, ADV-10): the generic transition `→ cancelled` refuses `STATE_TRANSITION_REFUSED`; `completeCccPlanningCancellation` returns `{completed:false}` while a call is `reserved` or `dispatched_unknown`.
    - (L9) Epoch replay (item 9, ADV-5): epoch 1's digest redelivered after epoch 2 returns the existing epoch and records no new epoch or stagnation.
    - (L10) Audit metadata bounds (item 10): one RED per field class (id strings over 256 characters, non-hex or wrong-length digests, an unknown `refusalReason`); each refuses before any write.
    - (L11) Use A1's publisher (item 11): `answerCccPlanningDecision` publishes through `ccc-planning-artifact-ops.ts`; the existing answer tests stay green.
    - (L12) No `deferred-leased` (item 12): removed from L1's outcome types. K1's `types.ts:214` still carried the literal in `CccPlanningRunStatusV1.lastControl.outcome`, which L1 did not own; E7-0 grants L1 that one line, and repair 2 removes it (E7-L 10).
    - (L13) Keep as is, documented in a comment (item 13): the held→runnable `attempt + 1`; a second cancel while one is pending gives `CONTROL_PENDING`.
    - (L14) Optional (item 14): if a non-superuser `fusion_runtime` fixture exists (S0 uses one for its REVOKE tests), one RLS case for `resolveCccPlanningRunProject`; otherwise skip it and say so.
  - Repair 2 (FINAL, E7): REPAIR at `1d0df1cc5` (the review and the adversary both asked for repair), repair 2 of 2 (opus, critical).
    - Base: INT-2c `115ab8d7f`, leaf head `0ab6b6280`: `a17b009a4` (= `0ce304036`) + `0ab6b6280` (= `1d0df1cc5`) (E7-0).
    - Owns: as v3.3 L1, plus E7-0's one-line grant in K1's `packages/core/src/ccc-planning/types.ts` (the last Owns entry above).
    - Repair 2 items (E7-L), each a RED that fails on a behavioural assertion against the repair-1 bytes, or a pinning test whose failing signature comes from the named mutant, plus its positive control (sections 2.1, 2.10 and 2.11):
      - (E7-L 1) Pause at `admitted` is refused (required; a repair-1 regression). In `planControl`, case `admitted`: `pause` refuses `CCC_PLANNING_STATE_TRANSITION_REFUSED` ("admitted has no -> paused transition") before any write; cancel stays direct. RED (`ccc-planning-control.pg.test.ts`): `seedRun({state:'admitted'})`, pause refused, `control_seq` stays 0, `control_request` stays null, no `ccc-planning:control` event; then `admitted → running` succeeds. Control: a pause while running is still recorded as pending. Mutant: restoring `return { kind: "pending" }` for `admitted` fails the RED.
      - (E7-L 2) A pending cancel is never erased by a move to `paused` (required; fail-open). The moveRun predicate becomes `control_request IS NULL OR to IN ('cancelling','cancelled') OR (to = 'paused' AND control_request = 'pause')`, and the re-read fallback classifies the same way (`CONTROL_PENDING` otherwise). RED: a running run, pause then cancel, then `running → paused` is refused `CONTROL_PENDING`, `control_request` stays `'cancel'`, and there is no state event; then `running → cancelling` succeeds. Control: a pending pause alone still allows `running → paused` (the existing ADV-12 test).
      - (E7-L 3) The lineage role half and the leaf cap get tests (required). (a) After product-adversary uses its 3 turn keys, a product-adversary binding at stage review with lineageId `review:technical-critic` is refused `ROUTE_NOT_ADMITTED` /lineage-not-admitted/, with `planning_spent` and the `call:reserved` count unchanged; control: a technical-critic binding in that lineage is admitted. (b) On the default 1536 run `research:leaf-1` is refused lineage-not-admitted; on `planningAllocation: 6144`, `research:leaf-77` is admitted and `research:leaf-78` refused. Report mutants I3e and I3f (m19) killed.
      - (E7-L 4) A deferred direct completion records its reason (required). When `completeCccPlanningCancellation` (or its within-transaction form) defers, it writes one deterministic, idempotent audit row: event type `ccc-planning:control`, subject `cancel-deferred:<reason>` where reason is `live-lease` or `descendants-unsettled`, event id derived from (run id, current `control_seq`, reason), so repeating the same deferral writes nothing new and a changed reason writes one new row. Its metadata carries the reason and, for descendants, the code `CCC_PLANNING_DESCENDANTS_UNSETTLED`. `lastControl` still reports the cancel as pending (the status view has no reason field, section 2.10). RED: the ADV1-D sequence (cancel recorded `live-lease`; the lease expires; direct completion defers on the unsettled call and now records `descendants-unsettled`; a second identical call adds no row).
      - (E7-L 5) Bound committed settlement strings (required). Before the settlement transaction, bound every string of the committed `effectiveRoute` and cost: id-like fields (`effectiveProvider`, `effectiveModel`, `effectiveReasoningEffort`, `effectiveServiceTier`, `cost.source` and the `omniRoute` id strings) at `CCC_PLANNING_AUDIT_STRING_MAX` (256); `cost.reason` and any other free-text observation string at 1,024 characters. A violation refuses `CCC_PLANNING_INTERNAL_ERROR` and writes nothing. RED: the ADV1-E sequence (a 100,000-character `effectiveReasoningEffort`; separately `cost.reason`) is refused with no row. Control: bounded values commit.
      - (E7-L 6) One constant. Replace the local `AUDIT_ID_MAX` with K1's `CCC_PLANNING_AUDIT_STRING_MAX` (a refactor; the existing tests stay green).
      - (E7-L 7) A superseded lineage takes no new call (required; ADV1-C). Once a repair chunk supersedes a lineage, every new call reservation on it is refused (`ROUTE_NOT_ADMITTED`, detail `lineage-superseded`), including the next call of a continuing turn; a call already dispatched still settles normally. This replaces the E5 item 4 allowance at about :851. RED: after `claimCccPlanningRepairChunk` creates `repair:1:spec-author`, the existing `spec:spec-author` turn's `pi-stream:2` is refused and nothing is charged. Control: a settle of the already-dispatched `pi-stream:1` still commits.
      - (E7-L 8) Split children and the lineage namespace (required). (a) `recordCccPlanningLineageSplit` refuses a child id that has any `fixedLineageOwners` (for example child `review:technical-critic` of parent `review:product-adversary`); RED plus control (a fresh child id is accepted). (b) Determine whether dispatch counters are keyed by lineage id alone or by (fence, lineage id). If by id alone, refuse a campaign-fence lineage whose id equals a planning fixed lineage id (RED plus control). If keyed per fence, add a test proving that a G7 `review:product-adversary` lineage on a campaign fence and the planning critic's lineage keep separate counters. Report which case holds.
      - (E7-L 9) Within-transaction cancellation completion for BF (required). Export `completeCccPlanningCancellationWithin(tx, input)`; the existing direct function becomes a wrapper that opens the transaction and calls it, keeping one path to `cancelled`. RED: called inside an outer transaction that then rolls back, nothing persists. Control: the committed form reaches `cancelled` exactly as before. The parent adds the barrel export at INT-2.
      - (E7-L 10) Drop `deferred-leased` from K1's `types.ts` through the E7-0 grant; the core typecheck must stay green.
      - (E7-L 11) Record, do not fix: settlement's move to `blocked_provider` does not respect a pending pause (the operator may need to resume twice); the lock order of `answerCccPlanningDecision` against A1's planning-fence publish can deadlock (PostgreSQL detects 40P01); splitting an unused parent gives each child a fresh 3 attempts (D13 as written); supersession is per role (H1, BF and ST2 must not name `task-reviewer` as a coding-rejection re-reviewer).
      - (E7-L 12) Update `cards/l1.mjs` names exactly.
  - Repair 2 outcome (E8): ACCEPTED at `dbe1f6a71` (review and adversary), integrated at INT-2d as `5bb02616c` + `b6680746c` + `ccad72351`. E7-L 8(b) found that dispatch counters are keyed by lineage id alone, so L1 refuses a campaign-fence lineage named like a planning fixed lineage; the semantic-id collision refusal moves to GG (E8-0, N-3). A split child that takes a fixed lineage id is refused `CCC_PLANNING_ROUTE_NOT_ADMITTED`, detail `lineage-not-admitted` (N-6, adopted). The E7-L 7 control, which re-delivers the committed `pi-stream:1` settlement after the claim, is accepted as the only form the `UNRECONCILED_DISPATCH` guard allows (N-2). The remaining gaps (the within-transaction transition of B-1, the `lastControl` pin, deferral rows for a reason that flips back, three surviving mutants, one constant) go to the new card L1z (W3).
- **A1: artifact ops** (PRD §3, D6, critic 14).
  - Objective: publish, read and resolve immutable planning artifacts.
  - Owns:
    - `packages/core/src/task-store/ccc-planning-artifact-ops.ts`
    - `packages/core/src/task-store/task-mutation-ops.ts` (`cleanupArchivedTasksImpl` hunk only)
    - `packages/core/src/__tests__/postgres/ccc-planning-artifacts.pg.test.ts`
    - `cards/a1.mjs`
  - Depends: K1, S0.
  - RED:
    - Republishing the same identity returns `replayed: true` and leaves one row.
    - The same key with a different identity gives `SLOT_CONFLICT`.
    - `expectedDigest` mismatch on read gives `DIGEST_MISMATCH`.
    - After a publish inside a shared transaction, a raw `cccplan-` insert in that same transaction is refused with `PUBLISHER_REQUIRED`, which proves the GUC reset.
    - Archive cleanup of an archived planning task does not throw and keeps its artifacts.
  - Non-vacuous: the GUC-reset case passes only if the reset happens; the cleanup case throws on the unmodified code because of the 0043 trigger.
  - Positive control: a first publish of a new key succeeds and reads back with the same digest; an archived ordinary task is still cleaned up.
  - Check: `CORE_PG src/__tests__/postgres/ccc-planning-artifacts.pg.test.ts SUFFIX`
  - Route: sonnet. Review: normal.
  - Rule (E1 carry-forward): `TaskStore.recordRunAuditEvent` drops `eventId` (`task-store/project-store-ops.ts:516-526`), so A1 calls the data-layer function directly.
  - Round 1 (E5): ACCEPTED at `1a758d644` (normal lane, fresh Opus reviewer). Cherry-picked onto integration as `a07f81830`, part of INT-2a. The A1 lineage is closed. Recorded residuals:
    - no test pins the task-row FOR UPDATE;
    - the project-scoping test proves RLS, not the module's own predicate;
    - a replay under an operator fence does not re-check the fence, so callers must not read `replayed: true` as proof that `controlSeq` is current (section 2.11).
- **G1: store-level planning-task guards** (critic 1, D22, challenges 11 and 24).
  - Objective: no store path can release, move, archive or delete a held planning task.
  - Owns:
    - `packages/core/src/task-store/ccc-planning-custody.ts` (new)
    - `packages/core/src/task-store/moves.ts`
    - `packages/core/src/task-store/branch-group-ops.ts`
    - `packages/core/src/task-store/branch-and-pr-entities.ts`
    - `packages/core/src/task-store/archive-lifecycle.ts`
    - `packages/core/src/task-store/task-update.ts` (`updateTaskUnlockedImpl` guard)
    - `packages/core/src/task-store/async-persistence.ts` (`updateTaskColumns` guard hunk)
    - `packages/engine/src/ccc-campaign-routing.ts` (new export `isCccCustodyGuardedTask` only; `isCccCampaignTask` byte-unchanged)
    - `packages/engine/src/triage.ts`
    - `packages/dashboard/src/routes/ccc-campaign-task-guard.ts`
    - `packages/core/src/__tests__/postgres/ccc-planning-task-guard.pg.test.ts`
    - `packages/engine/src/__tests__/ccc-planning-triage-guard.test.ts`
    - `packages/dashboard/src/routes/__tests__/ccc-planning-task-guard.test.ts`
    - `cards/g1.mjs`
    - `packages/core/src/task-store/archive-lifecycle-2.ts` (repair 1 grant, E5-G1: custody checks only)
    - `packages/core/src/task-store/workflow-task-create-ops.ts` (repair 1 grant, E5-G1: inside `atomicWriteTaskJsonImpl2` only)
    - `packages/core/src/task-store/project-store-ops.ts` (repair 1 grant, E5-G1: inside `atomicWriteTaskJsonWithAuditImpl` only)
  - Depends: K1 (marker), S0 (anchor).
  - RED: for a task with an anchor row:
    - `moveTask` to todo gives `CccPlanningTaskCustodyError`;
    - unpause is refused;
    - `updateTask({summary})` is allowed and `updateTask({paused:false})` is refused;
    - `store.updateTaskAtomic(id, () => ({paused:false}))` is refused (the path `task-mutation-ops.ts:545-552 → updateTaskUnlocked` that skips `updateTaskImpl`);
    - a direct `updateTaskColumns` write of `paused` is refused;
    - archive and delete are refused;
    - the dashboard guard refuses when the lookup throws (fail-closed);
    - `discoverReadyPlanningTasks` excludes the task even with `paused` cleared;
    - `isCccCampaignTask(planningTask)` is still `false` while `isCccCustodyGuardedTask(planningTask)` is `true`.
  - Non-vacuous: the atomic case passes on today's code (no guard on that path), so it fails until `task-update.ts` is guarded; the predicate case fails if `isCccCampaignTask` is widened (challenge 24).
  - Positive control: an identical task without an anchor row moves, unpauses through `updateTaskAtomic`, archives and deletes normally.
  - Check: `CORE_PG src/__tests__/postgres/ccc-planning-task-guard.pg.test.ts SUFFIX`, then `ENGINE src/__tests__/ccc-planning-triage-guard.test.ts SUFFIX`, then `DASH src/routes/__tests__/ccc-planning-task-guard.test.ts SUFFIX`. The DASH run sets `FUSION_PG_TEST_URL_BASE` to the leaf's own server (section 3.0 rule 4, E5).
  - Route: opus. Review: critical.
  - Round 1 (E5): REPAIR, repair 1 of 2 (opus, critical). Base INT-2b `ee89957c1` (E5 named INT-2a `9d4add879`; the parent re-rebased at 17:09; round-1 bytes `2c4285354`; E7-C B1). The three grants at the end of Owns are G1's alone; no other card owns those files now (E5-G1). Each item has a RED that fails on a behavioural assertion against the round-1 bytes, plus its positive control:
    - (G1) Delete and archive on the PostgreSQL path (item 1). `assertCccPlanningTaskIdNotHeld(store.asyncLayer, id, "delete")` runs at the top of `deleteTaskBackendImpl`, inside the task lock and before the soft delete (covering `deleteTask`, `deleteTaskIf` and direct callers), and in `deleteTaskIfBackendImpl` before the predicate runs; `archiveTaskBackendImpl` gets the archive equivalent. The dead guard and its false comment at `archive-lifecycle.ts:349-350` are removed. RED: `store.deleteTaskIf(held, () => true)` throws `CccPlanningTaskCustodyError` with operation `delete`, and the row is unchanged. Control: the twin is soft-deleted.
    - (G2) Snapshot-writer backstop (item 2). In both snapshot write primitives, inside their transaction and on the row they already read: when that row carries the K1 marker, an anchor row exists, and `changedColumns` includes any of `paused`, `userPaused`, `column`, `lineageId` or `deletedAt`, throw `CccPlanningTaskCustodyError`. Ordinary tasks, without the marker, pay no extra query. REDs: `store.updateTaskDependencies(held, {operation:"add", dependency})` on a held `todo` task is refused and the row is unchanged; a direct snapshot write that changes `column` on a held task is refused. Control: the twin moves to triage.
    - (G3) Coverage of the guards already present (item 3): an anchored task whose marker is cleared is not held, and a move is allowed; `moveTaskIf` and `handoffToReview` on a held task are refused; removing the `task-update.ts` backstop (`assertCccPlanningCustodyPreserved`) fails some test, or, if it truly cannot be reached once (G2) exists, it is deleted and the report says why.
    - (G4) Accepted design, no change (item 4; section 2.10 and D22).
    - (G5) Not required (item 5), noted in the report: `batch-update-models` (not custody); unbound-layer id collisions (legacy stores only).
    - (G6) No barrel edits (item 6): the engine barrel export of `isCccCustodyGuardedTask` and the dashboard switch to it are the parent's, at INT-2.
  - Repair 1 (E7): ACCEPTED at `11fff1ad1` (the fresh review and the fresh adversary both accepted). Cherry-picked onto integration as `90a4003bd` + `1c50053a2` (INT-2c). The G1 lineage is closed. The parent's INT-2 engine barrel export of `isCccCustodyGuardedTask` and the dashboard switch (G6) are still to come.
- **P1: Pi seam, binding and planning-scope settlement** (PRD §5, §8, D9, D10, D48; verify-v2 items 42, 45, 51).
  - Objective: bind a planning or linked-writer session to one exact route and settle a route refusal exactly once, without changing campaign behaviour.
  - Owns:
    - `packages/engine/src/agent-runtime.ts`
    - `packages/engine/src/pi.ts` (region (a): `744-1149` plus `3536-3545`; repair 1 adds the `AgentOptions.cccProviderAttemptBinding` property line, about 2244, E5-P1; repair 2 adds the `@fusion/core` import block, lines 45-46 at repair 1, E7-0 grant)
    - `packages/engine/src/ccc-planning/provider-binding.ts`
    - `packages/engine/src/__tests__/ccc-planning-provider-settlement.test.ts`
    - `packages/engine/src/__tests__/ccc-planning-provider-binding.test.ts`
    - `packages/engine/src/__tests__/ccc-provider-seam.typecheck.test.ts`
    - `cards/p1.mjs`
    - `packages/engine/src/ccc-route-receipt-adapter.ts` (repair 1 grant, E5-P1: an additive structural marker on error events only; repair 2, E7-P item 1: the transport marking of an error before `[DONE]` in `consumeReceiptAdapterSse`; E8-0 confirms that the grant covers E7-P item 1 and P1z's processing and marker changes, which P1z makes as successor owner)
  - Depends: K1.
  - RED:
    - `scopeKind: "planning"` with the receipt adapter selected (always, D48), a fake stream whose terminal route receipt names another model: `reconcile` is called exactly once with `proved_failed`, `refusalReason: "receipt-mismatch"` and no `effectiveRoute`; the provider stream is called once; `CccProviderRouteReceiptError` is thrown out of the slot loop. The fake controller answers any later `preDispatch` with a `proved_failed` terminal hold, and the distinct dispatch keys it saw equal `["pi-stream:1"]` (item 42).
    - Same with a missing receipt (`receipt-missing`), and the mismatch case again with `scopeKind: "planning-linked-writer"`: one key each.
    - A provider `error` event gives `proved_failed` with `provider-error-event`.
    - A provider error then a retry in one planning session yields dispatch keys `["pi-stream:1","pi-stream:2"]`, because a `proved_failed` terminal hold advances `nextSlot` (E2-1). The receipt-refusal REDs above stay as the negative case.
    - A planning binding whose `preDispatch` input has a different `modelId` is refused with `route-drift`.
    - A planning binding whose provider is not `options.defaultProvider` is refused at session creation. Today the same options silently register that provider without the receipt adapter (`pi.ts:3649-3651`) and stream through pi-ai.
    - `scopeKind: "planning"` without `toolPolicy` is refused at session creation.
  - Non-vacuous (rationale rewritten in v3, item 45): the mismatch case uses the same fixture as `pi.test.ts:1872-1909`. In campaign scope that fixture **does** call `reconcile`, once, with outcome `committed` and an `effectiveRoute` naming the drifted model; the campaign controller refuses and throws, and the attempt stays `dispatched_unknown`. Planning scope must instead call it with `proved_failed`, `receipt-mismatch` and no `effectiveRoute`, so an implementation that ignores `scopeKind` fails one of the two tests. The single-key assertion fails on today's slot loop, which moves to the next slot after a `proved_failed` terminal hold (`pi.ts:1030-1035`). The defaultProvider case passes on today's code only if nothing refuses, so it fails until P1 adds the check.
  - Positive control: the **unchanged** `pi.test.ts` passes, including the campaign drift case (committed reconcile with the drifted route, the controller throws, the attempt stays `dispatched_unknown`, keys `["pi-stream:1","pi-stream:1"]`, stream called once); abort with no terminal event stays `dispatched_unknown` in planning scope; `expectTypeOf` proves the campaign controller still satisfies `CccProviderAttemptController<CccProviderAttemptScope>`, and `ccc-provider-seam.typecheck.test.ts` assigns the real campaign controller to K1's `CccProviderAttemptControllerView<CccProviderAttemptScope>` (the assignment K1's core test cannot make, item 51).
  - Check: `ENGINE src/__tests__/ccc-planning-provider-settlement.test.ts src/__tests__/ccc-planning-provider-binding.test.ts src/__tests__/ccc-provider-seam.typecheck.test.ts src/__tests__/pi.test.ts SUFFIX`, plus the engine typecheck. From repair 1, also the receipt adapter's existing tests, found with rg and run as an outside regression check (E5-P1 item 4).
  - Route: opus. Review: critical.
  - Round 1 (E5): REPAIR, repair 1 of 2 (opus, critical). Base INT-2b `ee89957c1`, which exports K1's view types from `ccc-campaign/index.ts` since INT-2a (E5 named INT-2a `9d4add879`; the parent re-rebased at 17:09; round-1 bytes `c86d946ab`; E7-C B1). Each item has a RED that fails on a behavioural assertion against the round-1 bytes, plus its positive control (section 2.12):
    - (P1) Refusal memory first (item 1). The fake reconcile persists the settlement and then rejects; a second `agent.stream()` still rejects with `CccProviderRouteReceiptError`, the distinct keys stay `["pi-stream:1"]`, and the provider is called once.
    - (P2) The real abort shape (item 2). Control: a provider stream that yields `{type:"error", reason:"aborted", …}` gets no reconcile, re-entry throws `/dispatched_unknown/` with keys `["pi-stream:1","pi-stream:1"]`, and the provider is called once. Changing the abort check to `if (planningScope)` fails it.
    - (P3) D48 fails closed for linked writers (item 3). `"planning"` and `"planning-linked-writer"` bindings without the bound-route marker are refused at session creation, and so is a bound provider that is not `options.defaultProvider`. REDs for both.
    - (P4) Receipt failure versus transport failure (item 4). REDs through the real `streamCccTerminalRouteReceipt` against a loopback SSE server the test owns on port 0: missing, conflicting and incomplete receipts each give keys `["pi-stream:1"]` and exactly one upstream request; a socket destroyed mid-stream gives no reconcile, and re-entry holds with keys `["pi-stream:1","pi-stream:1"]`. Control: an HTTP 500 from the upstream settles `provider-error-event` and advances to `pi-stream:2`.
    - (P5) Binding types usable without casts (item 5). A type-only test passes the factory's binding to `createFnAgent` options and to `AgentRuntimeOptions` with no cast; the `as any` casts this makes unnecessary leave the P1 tests.
    - (P6) One definition of the view types (item 6). `agent-runtime.ts` imports K1's view types from `@fusion/core`; the `Same<>` test is kept or simplified.
    - (P7) No campaign semantics for a planning controller (item 7). RED: a hand-built binding without `scopeKind` around a planning controller is refused.
    - (P8) Confinement shape (item 8). REDs: `cccConfinement.bash = {}` (no exec function), and a `cccConfinement` with no `bash` key, while the tool policy allows `bash` (E7-C N4).
    - (P9) Tool policy matches the binding (item 9). One RED each for `allowedTools` against `cccPlanningSessionToolNames({ roleClass, scopeKind, probe })` (E7-C N5), `deniedNames ⊇ CCC_PLANNING_DENIED_NAMES`, the `toolsetDigest` and the role class. The fixtures that paired mismatched digests are fixed.
    - (P10) Keep the observed receipt (item 10). A provider-error refusal's evidence keeps the observed `omniRoute` receipt when the event carries one.
    - (P11) Accepted, comment only (item 11): `effective-route-drift` is unreachable in planning scope, so there is no drift branch. Corrected by E8-0 (item 6): a planning scope refused under a non-planning binding settles `effective-route-drift`, which L1 and BF map as a route refusal (section 2.12).
    - (P12) Dispose type (item 12, E6-0). `CccConfinement.bash` is typed structurally (section 2.12), with no import from X1c; when the tool policy allows `bash`, (P8)'s runtime check also requires `dispose` to be a function. RED: a `bash` object without `dispose` is refused.
  - Repair 2 (FINAL, E7): REPAIR at `19036aa27` (the review and the adversary both asked for repair), repair 2 of 2 (opus, critical).
    - Base: INT-2c `115ab8d7f`, leaf head `bbaa5fb4d`: `cd65276c6` (= `c86d946ab`) + `bbaa5fb4d` (= `19036aa27`) (E7-0).
    - Owns: as v3.3 P1, plus E7-0's `pi.ts` import grant (in the `pi.ts` entry above): the repair-1 hunk at lines 45-46 that adds `cccPlanningSessionToolNames` and `CCC_PLANNING_DENIED_NAMES` to the `@fusion/core` import list is ratified, and P1 may add to that import block any `@fusion/core` value its E7-P items need. The adapter entry above also covers item 1.
    - Repair 2 items (E7-P), each a RED that fails on a behavioural assertion against the repair-1 bytes, or whose failing signature comes from the named mutant where this block says so, plus its positive control (D10 and section 2.12):
      - (E7-P 1) Any error before `[DONE]` is a transport failure (required; fail-open). In `consumeReceiptAdapterSse` (`ccc-route-receipt-adapter.ts`), wrap both the per-line `consumeLine`/`consumeData` processing inside the read loop and the final flush in try/catch; when `!sawDone`, set `transport.failed = true` before rethrowing. An error raised after the body began and before `[DONE]` is never an upstream-reported error unless the upstream itself reported it (a parsed `finish_reason: error` or an error object in a complete event).
      - (E7-P 2) Loopback REDs through the real adapter (required), each asserting `cccTransportFailure: true`, reconcile never called, re-entry throwing `/dispatched_unknown/` with keys `["pi-stream:1","pi-stream:1"]`, and exactly one upstream request: (a) a truncated last data line at clean EOF: CONTENT_CHUNK, then `response.end('data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"wor')`; (b) clean EOF after a complete line, no `[DONE]` and no receipt (it stays transport, not receipt-missing; kills M4f/M5 and M4i/M10); (c) connection refused: bind port 0, close it, and point the adapter there (kills M4e/M6); (d) a malformed `data: {not-json}` mid-stream, followed by a valid finish, receipt and `[DONE]` (the adapter abandons the stream, so the outcome is unknown). Report the RED of (b) and (c) from the named mutants, since both pass on the repair-1 bytes; (a) and (d) fail on the repair-1 bytes.
      - (E7-P 3) Drift on an upstream error refuses (required; E7-0). A `finish_reason: error` whose terminal receipt names another model settles `receipt-mismatch` and does not retry. RED: probe D (the receipt names `minimax/MiniMax-M2.7`) gives keys `["pi-stream:1"]` and one upstream request. Control: the same error with the bound model's receipt settles `provider-error-event` as before.
      - (E7-P 4) Conflicting receipt values stay in the evidence (required, small). A `receipt-mismatch` settlement records the observed conflicting `providerId`/`modelId` (bounded strings) in its evidence, not `observed: null`. RED: assert the evidence fields.
      - (E7-P 5) Linked writer model check at creation (required). For a linked-writer binding, compare the marker's `modelId` (as well as its `providerId`) with `options.defaultModelId` and the default provider at session creation, and refuse before any provider call. RED plus control.
      - (E7-P 6) The item-7 refusal must not wedge the slot (required). If the planning-scope check can run on the binding before `preDispatch`, run it there. If it needs the permit's scope, settle the reserved call once as a refusal with no upstream request, through the path P1 already uses for route refusals, so it is not left reserved or `dispatched_unknown`. RED: after the refusal the slot is not reserved or `dispatched_unknown` (the fake controller records the settle).
      - (E7-P 7) Exports for WR and BF (required). Export the type `CccProviderAttemptBoundRoute` (exactly 5 keys) and `attachCccProviderAttemptBoundRoute(controller, route)` from `pi.ts`; the existing reader uses the same type. A type test pins the 5 keys. No barrel edit.
      - (E7-P 8) Optional. A fake-timer test for the adapter's `timedOut` flag (M4h). Relabel "No API key" and an `onResponse` hook throw as local, pre-request failures if a one-line label change does it; otherwise record it as a residual.
      - (E7-P 9) Rulings recorded, no code: a receipt that is not terminal (a matching receipt followed by a data line) and an incomplete receipt settle `receipt-missing` (no terminal receipt was observed); refusal memory stays per session (L1's and BF's run-state block covers new sessions); `cccStreamGuard` is a presence check.
      - (E7-P 10) Update `cards/p1.mjs` names exactly, re-checked against a JSON reporter run.
  - Repair 2 outcome (E8): lineage closed, re-planned. The review accepted `66ef8f379`; the adversary found one fail-open path E7-P item 1 did not cover: a body-processing failure after `[DONE]` (a cut or malformed data line after `[DONE]`) carries no marker, so `pi.ts` settles it `provider-error-event` and retries, even when the receipt named a drifted route (adversary probes B1 to B3). P1's lineage (1 build plus 2 repairs) is used up, so its commits are integrated as they are at INT-2d (`d4bef2024` + `33f5789a9` + `f689f11d5`), and the defect becomes card P1z (W3), which must be accepted before W6. Recorded (E8-0): the E7-P item 6 refusal settles `refusalReason: "effective-route-drift"` (P11 corrected; section 2.12); a missing API key and an `onResponse` throw still settle `provider-error-event`, and loopback test (c) has a small port-reuse race (risk 57); `attachCccProviderAttemptBoundRoute`'s types are as P1 wrote them (N-1; section 2.12).
  - Rule (E5-P1): the receipt adapter grant is additive; its existing tests stay green, and no other adapter behaviour changes, except E7-P item 1's transport marking in repair 2 and P1z's after-`[DONE]` and non-SSE markers (E8-P items 1 and 2); E8-0 confirms the widening.

**INT-2a (parent, done; E5).** On `agent/request-to-code-v3`, on top of INT-1b `ff4fc3e4f`: A1 cherry-picked as `a07f81830`, then `9d4add879`, in which `packages/core/src/index.gate.ts` mirrors `export * from "./ccc-planning/index.js"` and `packages/core/src/ccc-campaign/index.ts` exports K1's view types `CccProviderAttemptLimitReason`, `CccProviderAttemptRefusalReason`, `CccProviderAttemptRouteBindingView`, `CccProviderAttemptScopeView`, `CccProviderAttemptSettlementInputOf`, `CccProviderAttemptControllerView` and `CccProviderControllerDecisionView`. Each W2 leaf was rebased onto it (E2-82).

**INT-2b (parent, done; E6).** K1b's accepted range (`a46fed5e1`) cherry-picked as `ee89957c1`. At `ee89957c1`, `CCC_PLANNING_REFUSAL_CODES` holds exactly the 98 codes of the section 2.3 union, in order, with `CCC_PLANNING_WRITER_CLOSURE_UNCONFIRMED` last. X1c's repair rebases onto it, and the parent re-rebased K2, L1, G1 and P1 onto it at 17:09 (E7-C B1). Its checks were the core typecheck, the core build, the engine typecheck, the K1 test-tsc check, the seven K1 vitest files (125/125) and lint; the CLI typecheck and `pnpm test:ccc-planning` were owed, and INT-2c ran both (E7-C N2).

**INT-2c (parent, done; E7).** On top of INT-2b `ee89957c1`: G1's accepted range (round 1 plus repair 1, `11fff1ad1`) cherry-picked as `90a4003bd` + `1c50053a2`, then X1c's (`c16d103bf`) as `fc2b82cca` + `115ab8d7f`. INT-2c is `115ab8d7f`, the head of `agent/request-to-code-v3`. It changes 22 files, all owned by G1 or X1c (`scratchpad/int2c/int2c-files.txt`). Checks (`scratchpad/int2c/checks.sh`): INT-1b's checks except the K1 test-tsc check, plus the dashboard typecheck, `pnpm test:ccc-planning` and `pnpm test:gate` on an owned PostgreSQL (initdb in scratch, port 55493, stopped afterwards with the port free); results in `scratchpad/int2c/summary.txt`:
- core typecheck, core build, engine typecheck, CLI typecheck, dashboard typecheck and lint: rc=0;
- `pnpm test:ccc-planning` (targeted, `PI_OFFLINE=1`): 14 commands, passed with 0 skipped and 0 failed, among them `g1-core-custody-guards` 15, `g1-engine-triage-guard` 5, `g1-dashboard-mutation-guard` 5, `k1-core-contracts` 125, `x1-confined-shell` 57 of 57 and `x1c-denied-names` 2 of 2;
- `pnpm test:gate`: rc=0 (engine-core 300/300; core pg-gate 10/10; `test:ccc-prd-safety` 8/8, 74 passed with 3 skipped in the existing `run-verification-command` and `ccc-campaign-proof-execution` files, 72/72 and 15/15; `test:ci-shape` 100/100).

This settles the CLI typecheck and `pnpm test:ccc-planning` that INT-2b owed (N2). INT-1b's K1 test-tsc check is not in INT-2c's script and was owed at the next INT step; INT-2d ran it (E8-0, N-7). The remaining leaves were rebased onto INT-2c before repair 2 (the "W2 repair 2" paragraph and the W1 residual).

**INT-2d (parent, done; E8).** On top of INT-2c `115ab8d7f`, without conflicts: K2's accepted range as `11c512ee1` + `9485e02cc` + `2e9d0cbb8`, L1's as `5bb02616c` + `b6680746c` + `ccad72351`, P1's closed range as `d4bef2024` + `33f5789a9` + `f689f11d5`, and X1b's closed range as `3ca856f00` + `40918ac77` + `b290aac0d`, each commit patch-equal to the leaf commit it copies (`scratchpad/contract-v3.5/patchids.txt`). Then one parent barrel commit, `fcb83879d`, the head of `agent/request-to-code-v3`:
- core `index.ts` and `index.gate.ts`: `export * from "./task-store/ccc-planning-artifact-ops.js"` (A1) and `export * from "./task-store/ccc-planning-ops.js"` (L1, `completeCccPlanningCancellationWithin` included), so engine and CLI cards import them through `@fusion/core`;
- engine `index.ts`: `isCccCustodyGuardedTask` (G1), `attachCccProviderAttemptBoundRoute` and `type CccProviderAttemptBoundRoute` (P1);
- the dashboard custody guard (`ccc-campaign-task-guard.ts`) asks `isCccCustodyGuardedTask` and uses `isCccPlanningCustodyTask` only to pick the message (E5-G1 item 6).

INT-2d changes 32 files: the 28 owned by K2, L1, P1 and X1b, and the 4 of the barrel commit (`scratchpad/contract-v3.5/int2d-files.txt`). Checks (`scratchpad/int2d/checks.sh`): INT-2c's set plus the K1 test-tsc check (E8-0, N-7), with `pnpm test:gate` on an owned PostgreSQL (initdb in scratch, port 55495, stopped afterwards with the port free); results in `scratchpad/int2d/summary.txt`:
- core typecheck, core build, engine typecheck, the K1 test-tsc check (`tsc -p tsconfig.ccc-planning-tests.json --noEmit`) and lint: rc=0;
- CLI and dashboard typecheck: rc=2 on the first run, each with one TS2305 (`@fusion/engine` has no exported member `isCccCustodyGuardedTask`), because the script typechecked against an engine `dist` built before the barrel commit. After `pnpm --filter @fusion/engine build`, both re-runs exit 0 (`cli-typecheck2.log` and `dashboard-typecheck2.log` hold no error; the exit codes are recorded in the barrel commit message). Editor's note (E8): later INT scripts build the engine before the CLI and dashboard typechecks;
- `pnpm test:ccc-planning` (targeted, run as `env -u FUSION_PG_TEST_URL_BASE -u FUSION_PG_TEST_SKIP PI_OFFLINE=1`): 19 commands, 970 tests, 0 skipped and 0 failed: `a1-artifact-ops` 17, `b2-graph-admission` 70, `b4-packet-writer` 7 of 7, `b4-intake-regression` 21, `c6b-custom-provider-model-sync` 9 of 9, `g1-core-custody-guards` 15, `g1-engine-triage-guard` 5, `g1-dashboard-mutation-guard` 5, `k1-core-contracts` 125, `k2-core-authority` 53, `l1-planning-ledger-control` 60, `p0-runner-scripts` 83 of 83, `p0-ci-workflow-shape` 100, `p1-pi-seam` 84, `p1-pi-campaign-regression` 104, `s0-planning-migrations` 130, `x1-confined-shell` 57 of 57, `x1b-toolchain-shell-compat` 23 of 23 and `x1c-denied-names` 2 of 2;
- `pnpm test:gate`: rc=0 (core pg-gate 10/10; engine-core 300/300; `test:ccc-prd-safety` 8/8, 74 passed with 3 skipped in the existing `run-verification-command` and `ccc-campaign-proof-execution` files, 72/72 and 15/15; `test:ci-shape` 100/100).

Every later INT step keeps the K1 test-tsc check (N-7). INT-2d does the duties of the "INT-2" and "INT-2 additions" paragraphs below.

**INT-2 (parent; done at INT-2d `fcb83879d`, E8).** Barrels, core build, engine typecheck, `pnpm test:ccc-planning`, and the existing campaign suites `pnpm test:ccc-prd-safety`. The parent also adds the engine barrel export of G1's `isCccCustodyGuardedTask` and switches the dashboard guard to it (E5-G1 item 6).

INT-2 additions (E7; done at INT-2d, E8): the core barrel export of L1's `completeCccPlanningCancellationWithin` (E7-L item 9), and the engine barrel exports of P1's `CccProviderAttemptBoundRoute` and `attachCccProviderAttemptBoundRoute` (E7-0, E7-P item 7).

#### Wave W3

W3 base (E8-W3): every W3 card branches from INT-2d `fcb83879d` and imports the L1 and A1 store operations from `@fusion/core` (INT-2d barrel), never by a relative path into `task-store/`. AD1, C2 and H1 are opus builds with critical review. W3 also holds the three re-plan cards of E8, P1z, X1z and L1z (opus builds, critical review). Each is the successor owner of files whose earlier lineage is closed (P1, X1b) or accepted (L1); their files are disjoint from AD1's, C2's and H1's and from each other's, and P1z edits no `pi.ts` hunk, so C2 is the only W3 card that edits `pi.ts` (region (b)). Gates: X1z is accepted before W4 (SF); P1z and L1z are accepted before W6 (the W6 gate).

- **AD1: admission transaction** (G0 persistence, critic 8 C3, critic 14, challenges 1 and 10).
  - Objective: admit a run in one transaction, in FK-safe order, with the workflow IR pinned.
  - Owns:
    - `packages/core/src/task-store/ccc-planning-admission-ops.ts`
    - `packages/core/src/__tests__/postgres/ccc-planning-admission.pg.test.ts`
    - `cards/ad1.mjs`
  - Depends: K1, L1, A1, K2, G1.
  - RED:
    - For each `afterStep` value (`task`, `anchor`, `workflow`, `work-item`, `artifacts`) the hook throws, and afterwards there are zero rows in tasks, anchor, workflows, task_documents, workflow work items and audit for that run.
    - Reusing the receipt gives `RECEIPT_CONSUMED`.
    - The task is `paused:true` and `userPaused:false`, with the marker, and G1's guard refuses moving it.
    - The work item `run_id` equals the run id, and its `irHash` equals `cccPlanningWorkflowIrHash(buildCccPlanningWorkflowIr(mode))` (the value H1 verifies); the stored `project.workflows.ir` deep-equals the K1 IR.
  - Non-vacuous: each hook fails **after** a successful insert, so only a real rollback leaves zero rows; inserting the anchor before the task (v1 order) fails the composite FK at the `anchor` step.
  - Positive control: a clean admission leaves exactly one row in each table and replays to `RECEIPT_CONSUMED`, not a second run.
  - Check: `CORE_PG src/__tests__/postgres/ccc-planning-admission.pg.test.ts SUFFIX`
  - Route: opus. Review: critical.
  - Rule (E5-K2 item 4): the admitted run id is `cccPlanningRunId({ projectId: receipt.project.projectId, requestDigest: receipt.request.sha256, receiptSha256 })` (K1 `policy.ts`), the same derivation K2's envelope check binds the run to, so a run admitted here always passes that binding for its own receipt.
  - Rule (E8-W3, replacing E7-0's AD1 obligations): AD1 derives the run id with `cccPlanningRunId({ projectId: receipt.project.projectId, requestDigest: receipt.request.sha256, receiptSha256 })`, as the rule above says. AD1 has no semantic-id duty: it never sees semantic task ids, and the collision refusal E7-0 put here is GG's G4 (E8-0, N-3).
  - Rule (E8-W3; INT-3 barrel duty): AD1 imports L1's and A1's store operations from `@fusion/core`. Its new `ccc-planning-admission-ops.ts` is in no barrel yet; the parent adds `export * from "./task-store/ccc-planning-admission-ops.js"` to core `index.ts` and `index.gate.ts` at INT-3 (editor's derivation: G0 and CL2 call AD1 from outside core).
- **C2: tool policy and confined tools** (PRD §4 line 102, D11, critic 8 C6, challenges 8 and 14; verify-v2 items 34, 37, 39, 47).
  - Objective: every planning and linked-writer session gets exactly its policy tools, all confined and Fusion-owned where Pi's would escape.
  - Owns:
    - `packages/engine/src/ccc-confinement/session-tool-policy.ts`
    - `packages/engine/src/ccc-confinement/confined-fs-tools.ts`
    - `packages/engine/src/ccc-confinement/confined-grep-tool.ts`
    - `packages/engine/src/ccc-confinement/verdict-tool.ts`
    - `packages/engine/src/ccc-confinement/submit-artifact-tool.ts`
    - `packages/engine/src/ccc-confinement/probe-echo-tool.ts`
    - `packages/engine/src/pi.ts` (region (b), located by content (E8-W3): the session tool assembly in `createFnAgent`, that is the `tools: "readonly"` path, `builtinToolsAllowlist`, the MCP server tools and the final tool list; the line numbers `3698-3730`, `3847`, `4043-4160` predate P1's region (a) growth and are stale)
    - `packages/engine/src/__tests__/ccc-session-tool-policy.test.ts`
    - `packages/engine/src/__tests__/ccc-confined-fs-tools.test.ts`
    - `packages/engine/src/__tests__/ccc-confined-grep-tool.test.ts`
    - `packages/engine/src/__tests__/ccc-verdict-tool.test.ts`
    - `packages/engine/src/__tests__/ccc-probe-echo-tool.test.ts`
    - `cards/c2.mjs`
  - Depends: P1, K1, X1.
  - RED:
    - A caller passes `tools:"readonly"`, `builtinToolsAllowlist:["WebFetch"]` and one MCP server with a critic policy, and session creation is refused with `CCC_SESSION_TOOL_POLICY_REFUSED`.
    - A critic session's final tools equal exactly the 5 critic names, and its `grep` carries `CCC_CONFINED_TOOL_MARK` (it is not Pi's grep).
    - With `PATH=""` and `PI_OFFLINE=1`, a confined `grep` and a confined `find` over a fixture tree succeed and return the expected matches and paths, so neither needs `rg` or `fd`. v2 spied on Pi's `ensureTool`, which `grep.js:8` imports relatively while vitest externalizes `node_modules`, so the spy never intercepted anything (item 47).
    - `buildCccSessionToolPolicy({roleClass: "writer", linkedWriter: true, …})` gives policy id `ccc-linked-writer-tools.v1` and allowed tools equal to `CCC_PLANNING_LINKED_WRITER_TOOLSET`. A final tool set holding the campaign ready tool (`createCccCampaignReadyTool`, name `fn_complete_phase`) passes `assertCccSessionToolSet`; the same set without it, and a plain writer policy with it, are refused with `CCC_SESSION_TOOL_POLICY_REFUSED`; `linkedWriter: true` with any other role class throws (item 37).
    - `wrapCccProbedTool(edit, {probe: "exact-edit", …})` keeps the name, parameters and `CCC_CONFINED_TOOL_MARK`, runs the real confined edit, records `{probe: "exact-edit", toolName: "edit", result: "ok"}` and calls `abortTurn` exactly once; the same holds for a wrapped `ccc_submit_verdict` (item 39).
    - The confined grep finds a match in an allowed file, refuses a `path` outside the roots, and never returns lines from `.env` inside a root.
    - A confined read of `../x` and of an escaping symlink is refused.
    - A confined write or edit to `<root>/sub/.git/config` and to a denied-name file is refused through X1's shared `cccConfinedWriteRefusal`, and grep's path filter calls the same predicate with `writeRoots: readRoots`, so only its `.git` and denied-name checks apply (E2-7, E4-10).
    - The verdict tool refuses accept with a blocking finding, a `requirement` ref when `requirementIds` is null, and an `artifact` ref outside the session inputs; it accepts a `counterexample` ref. Its types are `CccReviewFindingRef` and `CccReviewVerdict` from `@fusion/core`; `verdict-tool.ts` declares no copy of either (item 34; the engine typecheck plus a source assertion in the test).
    - `ccc_probe_echo` with one extra key records `exact: false` and aborts the turn.
  - Non-vacuous: the policy refusal is checked against options that today's readonly allowlist admits; under the same empty `PATH`, Pi's own grep fails, so the confined tools succeed only because they spawn nothing; the linked-writer case fails if `fn_complete_phase` is missing from the K1 constant or silently dropped by the wrapper chain.
  - Positive control: the same options with no binding policy yield a session containing `WebFetch` (proves the allowlist admits it today); Pi's own grep, run under `PI_OFFLINE=1` with an empty `PATH`, rejects with "ripgrep (rg) is not available" (proves the spied path is the one Pi would take); a write or edit to a sibling ordinary file next to the refused `.git` and denied-name paths is accepted (E2-7).
  - Check: `ENGINE src/__tests__/ccc-session-tool-policy.test.ts src/__tests__/ccc-confined-fs-tools.test.ts src/__tests__/ccc-confined-grep-tool.test.ts src/__tests__/ccc-verdict-tool.test.ts src/__tests__/ccc-probe-echo-tool.test.ts SUFFIX`
  - Route: opus. Review: critical.
  - Rule (E4-10): grep's path filter passes `writeRoots: readRoots` to `cccConfinedWriteRefusal`, so a read root is never refused as "outside the write roots". C2 validates every denied name against `[A-Za-z0-9._*-]` before calling the predicate, because the predicate throws a plain `Error` on an invalid name.
  - Rule (E8-W3): C2 locates `pi.ts` region (b) by content, as its Owns entry says, and reports the actual lines it edits. It never touches region (a): P1's seam, `validateCccSessionToolPolicy`, `assertCccSessionToolPolicyMatchesBinding` and the bound-route marker. P1z edits no `pi.ts` hunk, so in W3 C2 is the only card that edits `pi.ts`.
- **H1: native host** (PRD §2, §13, D1-D3, D40, D44, D45, critic 3, challenges 10, 12, 25, 28; verify-v2 items 34, 35, 42).
  - Objective: run the planning workflow on the existing processor under one lease, with runtime and IR checks at every stage start.
  - Owns:
    - `packages/engine/src/workflow-work-processor.ts`
    - `packages/engine/src/workflow-task-runtime.ts`
    - `packages/engine/src/runtimes/in-process-runtime.ts` (drain classification, planning runtime wiring, runtime-digest registration, recovery call)
    - `packages/engine/src/ccc-planning/{controller,recovery,ports,runtime-digest}.ts`
    - `packages/engine/src/__tests__/ccc-planning-host.test.ts`
    - `packages/engine/src/__tests__/ccc-planning-host.real-pg.test.ts`
    - `cards/h1.mjs`
  - Depends: K1, L1, A1, G1, P1.
  - RED:
    - With a fake stage registry, a planning item runs the 12 stages in order under one lease.
    - Lease loss mid-stage aborts, and the spy order is `cancelAll → flush → release → completeCancellation`.
    - An expired lease is reclaimed by the existing acquire path and the next stage runs; `recovery.ts` contains no requeue.
    - A run with a `dispatched_unknown` call moves to `unknown_effect` at the next stage start and is never re-dispatched.
    - A pending pause is applied at the next stage boundary.
    - A registered runtime digest different from the run's gives `blocked_prerequisite` / `RUNTIME_NOT_PERMITTED` before any stage runs (from `admitted`); an unregistered digest does the same.
    - A stored IR altered by one node config gives `failed` / `WORKFLOW_IR_DRIFT`.
    - With a fake clock, a stage that runs four 20-minute sessions is not killed, while a single 31-minute session attempt is.
    - At engine start, a `cancelling` run whose lease expired ends `cancelled`.
    - At engine start, `recoverCccPlanningRuns({store, ports: {reconcileLinkedOutcome: stub}})` calls the stub once for each linked run and never for an unlinked one; without `ports` a linked run reports `none` (item 35; H1 imports nothing from BF).
    - A session that throws `CccProviderRouteReceiptError` after the fake L1 settlement moved the run to `blocked_provider` yields the blocked outcome with exactly one state event for the run, not two (item 42).
  - Non-vacuous: before H1, the processor throws "workflow required campaign custody is missing" for planning items, which the first test asserts against; a stage-level watchdog (v1) kills the four-session stage. The check asserts the K1-pinned workflow IR digest is unchanged (E2-14).
  - Positive control: a campaign work item still runs through the unchanged campaign path (`workflow-work-processor.test.ts`); the matching digest and IR run normally.
  - Check: `ENGINE_PG src/__tests__/ccc-planning-host.test.ts src/__tests__/ccc-planning-host.real-pg.test.ts src/__tests__/workflow-work-processor.test.ts SUFFIX`
  - Route: opus. Review: critical.
  - Rule (E1 carry-forward, E2-14): the graph executor treats `maxRetries: 0` as unset (`workflow-graph-executor.ts:2160-2163`), so H1 gets a single attempt per node through the settings `maxRetriesPerNode: 1` and never edits the K1-pinned workflow IR.
  - Rule (E7-L item 11, recorded): supersession is per role, so H1 never names `task-reviewer` as a coding-rejection re-reviewer.
  - Rule (E8-W3): the session-level watchdog (D40) and the per-node `maxRetriesPerNode: 1` rule stand. H1 consumes P1's settlement outcomes: a P1 route refusal (`receipt-missing`, `receipt-mismatch` or `effective-route-drift`, P1z's after-`[DONE]` and non-SSE refusals included) moves the run to `blocked_provider` once, through L1's settlement (section 2.12), and H1 neither retries it nor writes a second state event (H1's item-42 RED). H1 imports L1's and A1's store operations from `@fusion/core`.
- **P1z: receipt adapter, failures after `[DONE]` and non-SSE responses** (E8-P; re-plan of P1's closed lineage; D10, D48).
  - Objective: a body-processing failure after `[DONE]` and a 200 response that is not `text/event-stream` each settle once as a route refusal, never as `provider-error-event`, and never retry.
  - Owns (successor owner after P1's closed lineage, E8-P):
    - `packages/engine/src/ccc-route-receipt-adapter.ts` (processing and markers only)
    - `packages/engine/src/__tests__/ccc-planning-provider-settlement.test.ts`
    - `cards/p1.mjs`
  - Depends: P1 (integrated at INT-2d; base INT-2d `fcb83879d`).
  - RED (E8-P item 3; loopback, through the real adapter, against INT-2d bytes):
    - Each case asserts no `provider-error-event` settlement, no `pi-stream:2`, exactly one upstream request and a single route-refusal settlement.
    - B1: a cut data line after `[DONE]`, with no receipt check run.
    - B2: a missing receipt, then a cut line after `[DONE]`.
    - B3: a drifted receipt, `finish_reason: error`, `[DONE]`, then `data: {not-json}`.
    - A7: a 200 response whose content type is not `text/event-stream` (E8-P item 2).
  - Non-vacuous: on INT-2d bytes B1 to B3 settle `provider-error-event` and dispatch `pi-stream:2` (the adversary's probes), and A7 carries no marker, so each RED fails on a behavioural assertion before P1z.
  - Positive control: B0 (a drifted receipt with a clean end settles `receipt-mismatch`, one request) and B5 (a valid data line after `[DONE]` settles `receipt-missing`), both unchanged; a non-2xx status still settles `provider-error-event`; an error before `[DONE]` stays a transport failure (E7-P item 1).
  - Check: `ENGINE src/__tests__/ccc-planning-provider-settlement.test.ts src/__tests__/ccc-planning-provider-binding.test.ts src/__tests__/ccc-provider-seam.typecheck.test.ts src/__tests__/pi.test.ts SUFFIX`, plus the engine typecheck. Regression, unchanged (E8-P item 4): `ENGINE src/__tests__/ccc-route-receipt-adapter.test.ts src/__tests__/custom-providers-openai-completions.test.ts SUFFIX`.
  - Route: opus. Review: critical.
  - Rule (E8-P item 1): after `[DONE]`, a processing throw in `processBeforeDone` or the final flush marks the error event `cccRouteFailure: "receipt-missing"` with detail `receipt-not-terminal`, so `pi.ts` settles a route refusal (`refused_known_effect`, no retry), like the existing non-terminal case; before `[DONE]` the E7-P item 1 transport rule stays. A 200 response that is not `text/event-stream` is marked `receipt-missing` with detail `non-sse-response` (item 2). No `pi.ts` edit: `"receipt-missing"` is already a kind `pi.ts` settles (section 2.12, with the editor's note on the detail).
  - Rule (E8-P item 4): update `cards/p1.mjs` names exactly, checked against a JSON reporter run. P1z is accepted before W6.
- **X1z: discovery defaults and the compat decorator's `dispose`** (E8-X; re-plan of X1b's closed lineage; D12, Darwin).
  - Objective: `discoverCccToolchain` works with its defaults, as section 2.13 declares and as G0 step 11, SF and WR call it, and the shell-compat decorator keeps the raw shell's `dispose`.
  - Owns (successor owner after X1b's closed lineage, E8-X):
    - `packages/engine/src/ccc-confinement/toolchain-discovery.ts`
    - `packages/engine/src/__tests__/ccc-toolchain-discovery.darwin.test.ts`
    - `packages/engine/src/__tests__/ccc-shell-compat.darwin.test.ts`
    - `cards/x1b.mjs`
  - Depends: X1b (integrated at INT-2d; base INT-2d `fcb83879d`).
  - RED (E8-X items 1 and 2):
    - `discoverCccToolchain({})` on this host succeeds and seals the same toolchain digest as `discoverCccToolchain({ searchPath: cccToolchainDefaultSearchPath() })`; on INT-2d bytes it throws the `TypeError` ("searchPath must be an array of strings"). A type-level assertion pins `{}` as an accepted input of the frozen signature.
    - The decorated operations' `dispose` is the raw shell's `dispose` (or disposing through the decorator returns the raw shell's closure result); mutant X2 (`return { exec } as unknown as T`) fails it.
  - Non-vacuous: the first RED fails on INT-2d bytes with the TypeError, because `toolchain-discovery.ts` still declares `searchPath` required; the second is a pinning test whose failing signature comes from mutant X2.
  - Positive control: a `searchPath` that is present but malformed (not an array, or an array with a non-string entry) still throws the existing TypeError; an explicit `searchPath` still finds a tool in a user-writable directory (E6-0); X1b's raw-shell controls stay green.
  - Check: `ENGINE src/__tests__/ccc-toolchain-discovery.darwin.test.ts src/__tests__/ccc-shell-compat.darwin.test.ts SUFFIX`, which must show 0 skipped on Darwin, plus the engine typecheck.
  - Route: opus. Review: critical.
  - Rule (E8-X items 1 and 3): the default is applied inside the function, `const searchPath = i.searchPath ?? cccToolchainDefaultSearchPath();`, and the input type keeps `searchPath` optional (section 2.13). Update `cards/x1b.mjs` names exactly. Measure the closed check at ambient load and keep each `timeoutMs` at least 1.5 × the worst run. X1z is accepted before W4 (SF).
- **L1z: within-transaction state transition and L1's remaining gaps** (E8-L; E8-0 B-1; follow-up of L1, accepted; D43, D45).
  - Objective: BF's D43 rows can move the run inside the campaign transaction, and the gaps L1's repair 2 left are pinned.
  - Owns (successor owner after L1's accepted lineage, E8-L):
    - `packages/core/src/task-store/ccc-planning-ops.ts`
    - `packages/core/src/__tests__/postgres/ccc-planning-control.pg.test.ts`
    - `packages/core/src/__tests__/postgres/ccc-planning-ledger.pg.test.ts`
    - `cards/l1.mjs`
  - Depends: L1 (integrated at INT-2d; base INT-2d `fcb83879d`).
  - RED (E8-L items 1 to 4; each fails on a behavioural assertion against INT-2d bytes, or is a pinning test whose failing signature comes from the named mutant):
    - (item 1) `transitionCccPlanningRunStateWithin(tx, i)` inside an outer transaction that then rolls back: nothing persists (no state change, no state event). With a pending cancel, `building → accepted` within refuses `CCC_PLANNING_CONTROL_PENDING` and writes nothing. `→ cancelled` within is refused `CCC_PLANNING_STATE_TRANSITION_REFUSED`.
    - (item 2) The `lastControl` filter (`target LIKE 'control:%'` in `inspectCccPlanningRun`; mutant r01/E4d): the RR2-PROBE-A sequence (a generic `running → cancelling` with no operator control, lease expiry, then a deferred completion) reports `lastControl` from the operator control row only.
    - (item 3, ADV2-A) Under one `control_seq`, live-lease, then descendants-unsettled, then live-lease again writes three deferral rows, and the latest says `live-lease`; repeating the same reason writes nothing.
    - (item 4) Surviving mutants: the within form's deferral row (r03); `requireRunId` in the within form (r05); the split-child check's stricter cap (`Number.MAX_SAFE_INTEGER`, E8a'/r02): a split child named `research:leaf-1` on a 1536 run (leaf cap 0) is refused.
  - Non-vacuous: the within transition does not exist on INT-2d bytes; with the deferral id derived from (run id, `control_seq`, reason), the third row of item 3 collides with the first, so only two rows exist and the latest says `descendants-unsettled`; items 2 and 4 name the mutant each test must kill.
  - Positive control: a committed within transition equals the direct form's result and audit rows; the direct `transitionCccPlanningRunState`, now a wrapper, passes its existing tests; a pending pause alone still allows `running → paused` (E7-L item 2); an operator control row is still reported by `lastControl`; a fresh split child id is still accepted.
  - Check: `CORE_PG src/__tests__/postgres/ccc-planning-ledger.pg.test.ts src/__tests__/postgres/ccc-planning-control.pg.test.ts src/__tests__/postgres/ccc-planning-retention.pg.test.ts src/__tests__/postgres/ccc-planning-transition-parity.pg.test.ts SUFFIX`, plus the core typecheck and the K1 test-tsc check (`pnpm --filter @fusion/core exec tsc -p tsconfig.ccc-planning-tests.json --noEmit`; E8-L item 6, N-7).
  - Route: opus. Review: critical.
  - Rule (E8-L item 1, B-1): the within form has the same predicate, CAS and refusals as the direct form, including the E7-L item 2 control rule and the refusal of `→ cancelled` (only `completeCccPlanningCancellation[Within]` reaches `cancelled`); the direct form becomes a wrapper that opens the transaction and calls it; the input is the direct form's plus `projectId` if the within form needs it to scope the run, as `completeCccPlanningCancellationWithin` does (section 2.11). No barrel edit: INT-2d's `export *` of `ccc-planning-ops.js` exports it.
  - Rule (E8-L items 3 and 5): the deferral id is derived from (run id, `control_seq`, deferral ordinal), and a row is written only when the latest deferral row for that `control_seq` has a different reason, or none exists. The remaining literal `256` bounds in `requireLineageId` and the research-fetch `nodeId` check use `CCC_PLANNING_AUDIT_STRING_MAX`.
  - Rule (E8-L item 6): update `cards/l1.mjs` names exactly. L1z is accepted before W6, because BF (W6) depends on it (B-1).

**INT-3 (parent).** Barrels, build, typecheck, the targeted proof, and the campaign processor suites unchanged. Additions (E8):
- Barrel duty: L1z's `transitionCccPlanningRunStateWithin` needs no barrel edit, because INT-2d's `export * from "./task-store/ccc-planning-ops.js"` in core `index.ts` and `index.gate.ts` exports it automatically. The one new export W3 adds is AD1's `packages/core/src/task-store/ccc-planning-admission-ops.ts`: the parent adds `export * from "./task-store/ccc-planning-admission-ops.js"` to both core files (editor's derivation: G0 and CL2 call AD1 from outside core). C2's and H1's new engine modules are imported inside the engine and need no barrel line unless a later card imports one through `@fusion/engine`; P1z and X1z add no export.
- Checks: INT-2d's set, the K1 test-tsc check included (E8-0, N-7), with the engine built before the CLI and dashboard typechecks (editor's note, from INT-2d's first run).

#### Wave W4

- **IM1: import intent and link** (PRD §9, D16, D17, critic 7, challenge 21).
  - Objective: persist the import intent before the importer runs, and link it afterwards, write-once.
  - Owns:
    - `packages/core/src/task-store/ccc-planning-import-ops.ts`
    - `packages/core/src/__tests__/postgres/ccc-planning-import-link.pg.test.ts`
    - `cards/im1.mjs`
  - Depends: L1, A1.
  - RED:
    - `hooks.beforeArtifact` throws, and the anchor still has no intent digest (atomicity).
    - A second intent with another digest is refused with `IMPORT_LINK_WRITE_ONCE`.
    - An intent whose `limits.maxDurationMs` differs by 1 ms from the published bundle's `bounds` is refused with `IMPORT_IDENTITY_DRIFT`.
    - A link whose `ccc_prd_imports` bundle hash differs from the intent is refused.
    - Intent-only state is reported as `intent-only`.
  - Non-vacuous: the atomicity case needs both writes in one transaction; the bounds case passes on any implementation that does not read the bundle artifact.
  - Positive control: an intent whose limits equal the bundle's bounds records once and replays with `replayed: true`.
  - Check: `CORE_PG src/__tests__/postgres/ccc-planning-import-link.pg.test.ts SUFFIX`
  - Route: opus. Review: critical.
- **CL1: `fn plan` CLI** (PRD §10, D35, D49, critic 8 C11, challenge 16).
  - Objective: the PRD's command grammar with exit codes 0/1/2 and one JSON line.
  - Owns:
    - `packages/cli/src/commands/plan.ts`
    - `packages/cli/src/bin.ts` (the plan routing hunk only)
    - `packages/cli/src/commands/__tests__/plan.test.ts`
    - `packages/cli/src/__tests__/bin-plan-routing.test.ts`
    - `.changeset/ccc-planning-fn-plan.md`
    - `cards/cl1.mjs`
  - Depends: AD1, L1, K2.
  - RED:
    - Through bin's entry with injected argv, `fn plan status ccc-plan:<24hex> --project a --project b --json` exits 2 with one `usage_error` JSON line. Today it exits 1 with non-JSON output.
    - `fn plan status ccc-plan:<24hex> --json` with no `--project` resolves the project from the run row and exits 0 with `kind: "status"`.
    - A run id in two projects exits 1 with `RUN_AMBIGUOUS`; `--project` naming another project exits 1 with `RUN_PROJECT_MISMATCH`.
    - A missing positional `RUN_ID` exits 2 with JSON.
    - `--actor` is trimmed and must be 1 to 200 characters: a 2,000-character actor, or one that is blank after trimming, exits 2 with `usage_error`, and the injected deps are never called (spy), so nothing is read or written; a 200-character actor is passed to deps unchanged (spy) (E2-4, E4-6). The stored `operator:<actor>` audit `agentId` is asserted by L1 and CB, which own the write.
    - `fn plan build ccc-plan:<24hex> --budget-profile standard` exits 1 with `COMMAND_NOT_SUPPORTED`.
    - `pause` on a run without `import_id` returns `control_accepted` with `route: "planning"`; on a linked run it calls `deps.applyBuildControl` (spy) and, with the CL1 default, exits 1 `COMMAND_NOT_SUPPORTED`.
    - A thrown internal error exits 1 with `CCC_PLANNING_INTERNAL_ERROR`, never `FUSION_NON_RETRYABLE_EXIT_CODE`.
  - Non-vacuous: the duplicate-`--project` case fails on today's bin-level parse (`bin.ts:585-605`); the positional case fails on any `--run` grammar.
  - Positive control: `fn prd` routing through the same `bin.ts` is unchanged (existing bin tests), and `pnpm check:changesets` passes with the new changeset.
  - Check: `CLI src/commands/__tests__/plan.test.ts src/__tests__/bin-plan-routing.test.ts SUFFIX`, then `pnpm check:changesets`
  - Route: sonnet. Review: normal.
- **SF: real session factory** (D11, D37, challenge 4).
  - Objective: open confined, sealed, bound sessions over the right read snapshot.
  - Owns:
    - `packages/engine/src/ccc-planning/session-factory.ts`
    - `packages/engine/src/ccc-planning/repository-snapshot.ts`
    - `packages/engine/src/ccc-planning/packet-dir.ts`
    - `packages/engine/src/__tests__/ccc-planning-session-factory.test.ts`
    - `cards/sf.mjs`
  - Depends: P1, C2, X1, X1b (toolchain discovery, E4-5), X1c (dispose result, E4-9), L1, H1, X1z (discovery defaults and the decorator's `dispose`, E8-X; accepted before W4).
  - RED:
    - Dispose duty (E4-9): a planning session whose confined bash is a stub with `dispose()` resolving `{closure: "unconfirmed"}` is disposed exactly once at session end, and the attempt records the unconfirmed closure as an attempt fact. Non-vacuous: a factory that never disposes leaves the spy at 0 calls and records nothing. Control: a stub resolving `{closure: "confirmed"}` is disposed once and records no unconfirmed fact.
    - designer-b's packet directory lacks designer-a's artifact even though it is published.
    - The snapshot of a fixture repository with an ignored `.env` and a remote has no `.git` and no `.env`.
    - With `readSnapshot: {kind:"candidate", commit: W, tree}`, a reviewer's confined read finds a line that exists only in writer commit W; with `{kind:"admitted-base"}` the same read is not found.
    - A candidate whose `tree` does not match `W^{tree}` is refused.
    - A critic session's tools equal the critic set; a session without `CCC_FUSION_PROFILE` is refused; every binding has `receiptAdapterId` set and its provider equals `defaultProvider`.
  - Non-vacuous: a factory that always archives the admitted base (v1) fails the candidate read; the tree check fails on a forged tree id.
  - Positive control: product-adversary's packet holds both design artifacts, so sealing is selective, not empty; the admitted-base read of a line present in B0 succeeds.
  - Check: `ENGINE src/__tests__/ccc-planning-session-factory.test.ts SUFFIX`
  - Route: opus. Review: critical.
  - Rule (E4-5, E4-B): SF takes its sealed toolchain from X1b's `discoverCccToolchain`, the same discovery G0 step 11 uses, and never builds a `CccSealedToolchain` by hand.
  - Rule (E6-0): SF calls discovery with its defaults (the minimal required set, the optional GNU set, the Homebrew-only search path), and a missing optional tool never fails a session.
  - Rule (F5, E6-C): SF wraps the confined `BashOperations` in X1b's shell-compat decorator, so package commands reach the `BASH_ENV` dispatcher without a refused task environment key.
  - Rule (E6-0, section 6 risk 50): a cloned binary pays macOS's first-launch check, about 0.5-1.4 s per binary. SF measures that cost on the I2 host before trusting a short model timeout, and reports the figure.

#### Wave W5

- **O1: offline end-to-end** (I1 exit, PRD §13).
  - Objective: prove the I1 stack end to end with real PostgreSQL, real Pi sessions and a loopback fake model.
  - Owns:
    - `packages/engine/src/__tests__/ccc-planning-offline-e2e.real-pg.test.ts`
    - `packages/engine/src/__tests__/fixtures/ccc-planning-fake-models.ts`
    - `cards/o1.mjs`
  - Depends: all W1-W4 cards.
  - RED/GREEN: admission, then the host runs a two-stage fake registry. Each stage makes real Pi calls through SF to an in-process loopback fake that emits terminal-route SSE receipts. Then:
    - artifacts are published;
    - planning spend equals the call count;
    - a pause through the CLI op is applied at the stage boundary, and `resume` requeues the held item so the next stage runs;
    - an `awaiting-intent` stage outcome followed by `answer` requeues and continues;
    - `cancel` ends in `cancelled` with the work item `cancelled`;
    - spend is never refunded;
    - a fake receipt naming another model settles `refused_known_effect`, the run ends `blocked_provider` / `CCC_PROVIDER_PIN_DRIFT`, and the fake server sees no further request.
  - Non-vacuous: the counts are checked against the fake server's own request log, and the requeue cases fail if the work item stays `held`.
  - Positive control: a clean two-stage run commits both stages with spend equal to the log.
  - Check: `ENGINE_PG src/__tests__/ccc-planning-offline-e2e.real-pg.test.ts SUFFIX`
  - Route: opus. Review: critical.

**EXIT-I1 (parent).** Run `pnpm test:ccc-planning` and `pnpm verify:ccc-planning-offline` (Darwin, owned PostgreSQL, zero skips, network guard on), plus a fresh critical review of the I1 diff. The milestone claim names any item that was NOT RUN and the procedural controls of D52.

### 3.2 I2 (PRD §13 I2: one live FULL-v2 Build on an owned disposable target)

#### Wave W6 (cheap first)

W6 gate (E8): no W6 card is dispatched before P1z and L1z are accepted. P1z closes the last known fail-open settlement path before any live call (no live call runs before W6), and L1z gives BF the within-transaction transition (E8-0, B-1). The gate is encoded as Depends entries on C6 (P1z) and BF (L1z) (editor's encoding).

- **RP: role prompts** (PRD §4, D47).
  - Objective: versioned prompts for every FULL-v2 role and the three probe roles.
  - Owns:
    - `packages/engine/src/ccc-planning/roles.ts`
    - `packages/engine/src/ccc-planning/prompts.ts`
    - `packages/engine/src/__tests__/ccc-planning-prompts.test.ts`
    - `cards/rp.mjs`
  - Depends: K1.
  - RED:
    - Every FULL-v2 role and probe role has a versioned prompt and a stable digest.
    - Critic prompts name only `ccc_submit_verdict`; the spec-author prompt requires one `decision_record` per objection input.
    - No prompt template interpolates anything other than its declared packet inputs.
    - The prompt digest changes when one byte changes.
  - Non-vacuous: the stub has an empty table, so the coverage assertion fails.
  - Positive control: a role's digest is equal across two builds of the table.
  - Check: `ENGINE src/__tests__/ccc-planning-prompts.test.ts SUFFIX`
  - Route: sonnet. Review: cheap.
- **C6: degenerate output, tool-fidelity preflight, pin check** (D27, D29, challenges 9 and 19; verify-v2 item 39).
  - Objective: the stream guard, the three qualification lineages and the pin check.
  - Owns:
    - `packages/engine/src/ccc-confinement/degenerate-output.ts`
    - `packages/engine/src/ccc-planning/tool-fidelity-preflight.ts`
    - `packages/engine/src/ccc-planning/provider-pins.ts`
    - `packages/engine/src/__tests__/ccc-degenerate-output.test.ts`
    - `packages/engine/src/__tests__/ccc-tool-fidelity-preflight.test.ts`
    - `packages/engine/src/__tests__/ccc-provider-pins.test.ts`
    - `cards/c6.mjs`
  - Depends: P1, C2, SF, C6b, L1, P1z (accepted before W6, E8; editor's encoding of the W6 gate).
  - RED:
    - An M3-like fixture (`content` empty, everything in reasoning, from existing evidence) gives `empty-visible-output`; four placeholders give `placeholder-runaway`.
    - The preflight opens exactly three lineages `preflight:writer|critic|researcher` with the three probe role ids; each spends at most 3 calls, all with `preflight: true`, and none counts as a node.
    - A fake model that answers the strict-echo probe with an extra key gives `CCC_BLOCKED_PROVIDER` with a published `tool_fidelity_receipt`, and no planning node runs.
    - Every tool offered in a probe session is wrapped by C2's `wrapCccProbedTool`. With a fake model that **keeps calling tools** after every result, each lineage records exactly 3 dispatch keys, one per probe, and each probe ends after its first tool call: the writer's exact-edit probe calls `edit`, the critic's verdict-shape probe calls `ccc_submit_verdict`, and the researcher's citation-read probe calls `ccc_citation_read` (item 39).
    - A fake model that ignores the abort and asks for a 4th call is refused by L1's lineage cap (the backstop).
    - The researcher probe's fetch tool refuses `probe-mode` and the run's `research_fetch_spent` stays 0.
    - A pin entry carrying `modelProvenance` gives `PIN_DRIFT provenance-present`.
  - Non-vacuous: a single-lineage preflight (v1) fails the three-lineage assertion; a probe that does not abort issues a follow-up call the fake server logs; v2's wiring, which wrapped only `ccc_probe_echo`, gives a 4th key in the writer, critic and researcher lineages, which then go to `blocked_provider`.
  - Positive control: clean fixtures pass each check; a clean preflight spends exactly 9 calls, recorded as `preflightSpent: 9`.
  - Check: `ENGINE src/__tests__/ccc-degenerate-output.test.ts src/__tests__/ccc-tool-fidelity-preflight.test.ts src/__tests__/ccc-provider-pins.test.ts SUFFIX`
  - Route: sonnet. Review: normal.
- **C5: research fetch** (D28, critic 14).
  - Objective: controller-side HTTPS research fetch under the fixed source policy.
  - Owns:
    - `packages/engine/src/ccc-research/research-fetch.ts`
    - `packages/engine/src/ccc-research/address-blocklist.ts`
    - `packages/engine/src/__tests__/ccc-research-fetch.test.ts`
    - `cards/c5.mjs`
  - Depends: L1, A1.
  - RED:
    - An allowlisted host whose injected DNS answer is 127.0.0.1 gives `blocked-address`.
    - A redirect to a non-allowlisted host is refused.
    - The 25th fetch in a run is refused with `grant-exhausted`.
    - An `http:` URL is refused with `scheme`.
  - Non-vacuous: a local server really listens on 127.0.0.1, so a connect would succeed without the check.
  - Positive control: the 24th fetch is allowed; an allowlisted fixture served over a local TLS stub with an injected public address is fetched. Every network path is local or injected, so the test makes no real egress (the P0 guard would report it).
  - Check: `ENGINE src/__tests__/ccc-research-fetch.test.ts SUFFIX`
  - Route: sonnet. Review: normal.
- **AU4: disposable target** (D24, PRD §7:213-215).
  - Objective: admit only an owned disposable target.
  - Owns:
    - `packages/engine/src/ccc-planning/disposable-target.ts`
    - `scripts/lib/ccc-planning-disposable-target.mjs`
    - `packages/engine/src/__tests__/ccc-planning-disposable-target.real-git.test.ts`
    - `cards/au4.mjs`
  - Depends: K2.
  - RED: each of these is refused: a repository with a remote; `owner.json` with a different digest; a repository that is not a direct child of `scratchRoot`; `baseCommit` that is not HEAD.
  - Non-vacuous: the stub admits everything.
  - Positive control: the owned control repository passes.
  - Check: `ENGINE src/__tests__/ccc-planning-disposable-target.real-git.test.ts SUFFIX`
  - Route: sonnet. Review: normal.
- **IP: installed runtime and serve lane** (D26, D48, 0.25, challenge 15).
  - Objective: pack, install and describe the runtime truthfully, including how pi-ai ships and where the keepalive model rule lives, and launch serve safely.
  - Owns:
    - `scripts/lib/ccc-installed-cli.mjs` (new, extracted)
    - `scripts/lib/ccc-gate2-installed-runtime.mjs` (switched to the extraction)
    - `scripts/lib/ccc-planning-installed-runtime.mjs`
    - `scripts/lib/ccc-planning-serve-lane.mjs`
    - `scripts/ccc-planning-install-runtime.mjs`
    - `scripts/__tests__/ccc-planning-installed-runtime.test.mjs`
    - `scripts/__tests__/ccc-planning-serve-lane.test.mjs`
    - `scripts/__tests__/ccc-gate2-installed-runtime.test.mjs`
    - `scripts/__tests__/ccc-planning-installed-keepalive.test.mjs` (installed lane; its npm install uses the offline cache or a read-only public-registry fetch, npm ruling in section 5)
    - `cards/ip.mjs`
  - Depends: none from earlier waves.
  - RED (offline):
    - A serve log with an `Auto-registered` line gives `SERVE_AUTO_REGISTERED`. A 4040 binding gives `PORT_FORBIDDEN`.
    - The launch argv contains `env -i`, `PI_OFFLINE=1`, `--port 0`, `--host 127.0.0.1` and `--no-auto-register`, the cwd is the target, and there is no `PORT=`.
    - The receipt verifier detects a one-byte `dist` change.
    - A receipt without `piAi.keepaliveModelSource`, or with `shipping` not derived from the packed manifest, is refused. Today's receipt writer emits neither field.
  - RED (installed lane, parent-run; npm ruling in section 5): a loopback fake OmniRoute emits keepalive chunks carrying a placeholder model and then the trailing route SSE comments. (A) Through the packed and npm-installed `fn` bound route (custom provider = `defaultProvider`, receipt adapter selected) the attempt reports the true model. (B) Through the installed `@earendil-works/pi-ai` `openai-completions` stream directly, it reports the placeholder; IP writes `workspacePatch` from that observation.
  - Non-vacuous: arm (B) proves the installed pi-ai is the unpatched one, so arm (A) passing can only come from the Fusion adapter; a deliberately broken builder fails the argv canary.
  - Positive control: arm (B) itself (it must show the placeholder, or the receipt must say `carried`); the gate2 installed-runtime tests pass on the extraction.
  - Check: `SCRIPTS scripts/__tests__/ccc-planning-installed-runtime.test.mjs scripts/__tests__/ccc-planning-serve-lane.test.mjs scripts/__tests__/ccc-gate2-installed-runtime.test.mjs`; installed lane: `SCRIPTS scripts/__tests__/ccc-planning-installed-keepalive.test.mjs` (parent; npm ruling in section 5, inventory `platform: "darwin"`, excluded from `ci-linux`).
  - Route: sonnet. Review: normal.
- **B3: shared import preflight** (D18, critic 6).
  - Objective: one import preflight shared by `fn prd` and the bridge.
  - Owns:
    - `packages/engine/src/ccc-prd/product-import-preflight.ts`
    - `packages/cli/src/commands/prd.ts` (lines about `1718-1830` and `1961-2245` become calls)
    - `packages/engine/src/__tests__/ccc-prd-product-import-preflight.test.ts`
    - `cards/b3.mjs`
  - Depends: none from earlier waves.
  - RED (T2.1): for one packet, `fn prd preview --json` `confirmationDigest` equals `preflightCccPrdProductTarget(...).confirmationDigest`. An injected conformance failure refuses before identity.
  - Non-vacuous: the stub returns a fixed digest that cannot equal the CLI's.
  - Positive control: the existing CLI prd tests, which pin refusal order, pass unchanged. Run them first, in isolation, because they are a known gate flake.
  - Check: `ENGINE src/__tests__/ccc-prd-product-import-preflight.test.ts SUFFIX`, then `CLI src/commands/__tests__/prd.test.ts SUFFIX`
  - Route: opus. Review: critical.
- **BF: linked writer caps and campaign outcome mapping** (D15, D43, D44, critic 10, challenges 5, 12, 18; verify-v2 items 18, 36, 40, 48, 49).
  - Objective: cap linked writers per attempt, gate them on run state and runtime, and carry every campaign outcome into the run record in the same transaction.
  - Owns:
    - `packages/core/src/ccc-campaign/provider-attempt.ts`
    - `packages/core/src/task-store/async-workflow-workitems.ts` (one hook call after the update in `transitionWorkflowWorkItem`, same tx, passing `existing` as `before`)
    - `packages/core/src/ccc-campaign/provider-controller.ts` (one catch hunk around the `transactionImmediate` in `atomicReserveCccCampaignProviderDispatch` that calls `recordCccPlanningWriterRefusal` after the rollback and rethrows; item 48)
    - `packages/core/src/task-store/ccc-planning-campaign-link-ops.ts` (new)
    - `packages/core/src/__tests__/postgres/ccc-planning-writer-caps.pg.test.ts`
    - `packages/core/src/__tests__/postgres/ccc-planning-campaign-outcome.pg.test.ts`
    - `cards/bf.mjs`
  - Depends: K1, K1b (`CCC_PLANNING_WRITER_CLOSURE_UNCONFIRMED`, E3-4, E4-1), S0, L1, A1, L1z (`transitionCccPlanningRunStateWithin`, E8-0, B-1).
  - RED:
    - Linked import: attempt 1's turn key admits `pi-stream:11` and refuses `pi-stream:12` with `iteration-cap`; `openCccPlanningLinkedWriterAttempt` with `nodeAttemptOrdinal` 2 returns a new turn key that admits its own 11 calls; a 4th distinct attempt gives `dispatch-cap`; replaying `nodeAttemptOrdinal` 2 returns the same key (item 18 rename).
    - With `control_request = 'cancel'` on the run, a linked reservation is refused `control-pending` (item 36).
    - With the run's `deadline_at` 20 s after the database clock and the campaign's own deadline a day later, a linked reservation is refused `deadline` (item 49).
    - The first approved linked reservation moves the run `awaiting_execution_authority → building` in the reservation transaction.
    - A linked reservation after the run is `accepted` is refused `run-not-building` (`RUN_ENDED`); with the run `paused`, `run-not-building` (`CONTROL_PENDING`).
    - A registered runtime digest different from the run's gives `runtime-not-permitted`.
    - Every refusal throws `CccPlanningLinkedWriterLimitError`, which is `instanceof CccProviderAttemptLimitError`. Through `atomicReserveCccCampaignProviderDispatch`, the refused reservation leaves no attempt row and no anchor change, and exactly one `ccc-planning:writer-refused` event exists with the reason and `timestamp = refusedAt`. A spy shows the event write starts only after the outer transaction has rolled back, on a fresh transaction. Replaying the same refusal returns the persisted event and never throws `CCC_RUN_AUDIT_EVENT_COLLISION` (item 48).
    - Outcome mapping, one test per row of the section 2.11 table: operator pause → `paused`; operator resume → `building`, recognised only from `before.blockedReason` (a `held → runnable` whose `before.blockedReason` is another reason leaves the run unchanged, item 40); operator stop → `cancelled` with `control_request` cleared; the in-lease cancel (`running → cancelled`, `lastError = "workflow-user-cancelled"`) → `cancelling → cancelled` with `control_request` cleared (item 36); all items succeeded with an accepted `final_judgment` → `accepted`; without it → `failed` / `FINAL_JUDGMENT_MISSING`; a rejected `task_review` → `verification_failed`; `dispatch-cap` refusal then item failed → `budget_exhausted` / `DISPATCH_CAP`; route refusal → `blocked_provider`; `dispatched_unknown` manual-required → `unknown_effect`; manual-required whose item `blockedReason` is `ccc-permanent:CCC_PLANNING_WRITER_CLOSURE_UNCONFIRMED` (from WR's `PermanentError`, E4-4) → `building → blocked_prerequisite` / `CCC_PLANNING_WRITER_CLOSURE_UNCONFIRMED`, through the existing pair (E2-5, E4-2); item `failed`, `manual-required` or `cancelled` with `control_request = 'cancel'` or a latest refusal code `control-pending` → `cancelling → cancelled` with the cancel reason, never `CAMPAIGN_FAILED` (E2-2); other failure → `failed` / `CAMPAIGN_FAILED`. The operator-stop, in-lease-cancel and E2-2 rows take the run's current state as the transition source, never the literal `building` (E2-3).
    - Cancel versus failure (E2-2): with `control_request = 'cancel'` set, a linked writer refusal (`control-pending`) lands before the 2 s runtime tick applies the pending cancel, the item then ends `failed`, and the run still ends `cancelled`, not `failed` / `CAMPAIGN_FAILED`.
    - A transition the anchor does not allow leaves the anchor unchanged, writes `campaign-unmapped`, and the campaign work item transition still commits.
    - An injected SQL error inside the mapping body (a test seam that runs `SELECT 1/0` in the hook) also leaves the work item transition committed and writes `campaign-unmapped`; without the savepoint PostgreSQL aborts the whole transaction (`25P02`), so this case cannot pass by accident.
    - A reconcile linked writer with `refusalReason: "effective-route-drift"` moves the run to `blocked_provider` / `CCC_PROVIDER_PIN_DRIFT` in the reconcile transaction.
    - Through L1's within functions (E8-0, B-1): every D43 row that does not end in `cancelled` calls `transitionCccPlanningRunStateWithin`, and every row that ends in `cancelled` calls it for `→ cancelling` (unless the run is already `cancelling`) and then `completeCccPlanningCancellationWithin`, all inside the campaign transaction's savepoint. RED: when the outer transaction rolls back after the mapping, no anchor change and no state event persist; a spy shows only the two within functions reach the anchor (no direct SQL).
    - The success row (every item `succeeded`, with an accepted `final_judgment`) while a cancel is pending: L1's within transition refuses `building → accepted` with `CCC_PLANNING_CONTROL_PENDING`, and BF maps the row to `cancelling` (E8-0).
    - `openCccPlanningLinkedWriterAttempt` returns `route` with exactly the five string keys `providerId`, `modelId`, `transport`, `roleClass` and `toolsetDigest`, whose values are the attempt's admitted writer route (E8-0, N-5).
  - Non-vacuous: every assertion reads the anchor and audit rows back from PostgreSQL; the "still commits" case fails if the hook throws.
  - Positive control: an unlinked (direct `fn prd`) import with the same reservation sequence and the same work-item transitions gets byte-identical results and no planning rows; the existing provider-attempt and work-item suites pass unchanged.
  - Check: `CORE_PG src/__tests__/postgres/ccc-planning-writer-caps.pg.test.ts src/__tests__/postgres/ccc-planning-campaign-outcome.pg.test.ts src/__tests__/postgres/ccc-campaign-provider-controller.pg.test.ts src/__tests__/postgres/ccc-campaign-provider-attempt.pg.test.ts src/__tests__/postgres/ccc-provider-attempt-effective-route.pg.test.ts src/__tests__/postgres/workitem-transition-event.pg.test.ts src/__tests__/postgres/orphan-workitem-cancellation.pg.test.ts SUFFIX`
  - Route: opus. Review: critical.
  - Rule (E5-P1 item 3, D48; settled by E7-0): P1 refuses a `"planning-linked-writer"` binding without the bound-route marker at session creation. The marker is engine-side: BF supplies its five values (`providerId`, `modelId`, `transport`, `roleClass`, `toolsetDigest`) as the `route` field of `openCccPlanningLinkedWriterAttempt`'s result, declared structurally in core (E8-0, N-5; section 2.11), and never imports engine, and WR attaches it with P1's `attachCccProviderAttemptBoundRoute` where it creates the linked-writer session, building the binding around the returned controller (E8-0, N-1; D48 note).
  - Rule (E5-L1 items 5 and 8; settled by E7-0): L1's generic `transitionCccPlanningRunState` refuses `→ cancelled`, and, while `control_request` is set, every transition except to `cancelling` or `cancelled`, or to `paused` for a pending pause (E7-L item 2); only L1's cancellation completion reaches `cancelled`. BF's D43 rows therefore go through L1's functions, never direct SQL: rows that end in `cancelled` call `completeCccPlanningCancellationWithin` (E7-L item 9) inside the campaign transaction's savepoint, and the success row while a cancel is pending is refused `CONTROL_PENDING` by L1, which BF maps to `cancelling` (D43 note). Every other D43 row, and the `→ cancelling` step before `completeCccPlanningCancellationWithin`, calls L1z's `transitionCccPlanningRunStateWithin` in the same campaign transaction (E8-0, B-1; D43 note (E8-0)).
  - Rule (E7-L item 11, recorded): supersession is per role, so BF never names `task-reviewer` as a coding-rejection re-reviewer.
- **AU2: live-execution release** (D36, ADR D Q3, challenge 33).
  - Objective: release live execution within the receipt envelope, crash-safe.
  - Owns:
    - `packages/engine/src/ccc-planning/live-execution-release.ts`
    - `packages/engine/src/__tests__/ccc-planning-live-execution-release.real-pg.test.ts`
    - `cards/au2.mjs`
  - Depends: K2, IM1.
  - RED:
    - With `controller_within_receipt` and an exact envelope, the result is `released`, with system-actor audit.
    - A member with `minimax/MiniMax-M3` gives `awaiting_operator envelope_mismatch` and no approval row.
    - A receipt without a `live_execution` entry gives `awaiting_operator receipt_requires_operator`.
    - Crash replay: for each `afterStep` in `issued`, `approved`, `published` the hook throws once; a second call completes, and there is exactly one approval row, one `live_execution_release` artifact and one state transition.
  - Non-vacuous: the approval-row and artifact counts are read from PostgreSQL; an implementation that issues again on replay creates a second row.
  - Positive control: an uninterrupted release produces the same single rows as the replayed one.
  - Check: `ENGINE_PG src/__tests__/ccc-planning-live-execution-release.real-pg.test.ts SUFFIX`
  - Route: opus. Review: critical.

#### Wave W7

- **IB1: packet and truthful proposal** (critic 6).
  - Objective: build the packet and an authorship proposal derived from envelopes.
  - Owns:
    - `packages/engine/src/ccc-planning/packet.ts`
    - `packages/engine/src/ccc-planning/proposal.ts`
    - `packages/engine/src/__tests__/ccc-planning-proposal.test.ts`
    - `cards/ib1.mjs`
  - Depends: B4, K1.
  - RED (T2.5): the adapter id matches `^ccc-planning\.full-v2:`; flipping one envelope's `resolvedModel` to M3 changes `authoringModel` to `glm/glm-5.3+minimax/MiniMax-M3`; a proposal hash mismatch is refused.
  - Non-vacuous: a hard-coded label passes the first assertion but fails the flip.
  - Positive control: unflipped envelopes give `glm/glm-5.3`.
  - Check: `ENGINE src/__tests__/ccc-planning-proposal.test.ts SUFFIX`
  - Route: sonnet. Review: normal.
- **GG: deterministic gates, graph gate, source fidelity, objections, schedule simulation, proof-command policy** (G3, G4, D19, D47, challenges 14, 23, 29; verify-v2 item 41).
  - Objective: every deterministic planning gate as pure functions.
  - Owns:
    - `packages/engine/src/ccc-planning/gates.ts`
    - `packages/engine/src/ccc-planning/graph-gate.ts`
    - `packages/engine/src/ccc-planning/source-fidelity.ts`
    - `packages/engine/src/ccc-planning/objections.ts`
    - `packages/engine/src/ccc-planning/schedule-simulation.ts`
    - `packages/engine/src/ccc-planning/proof-command-policy.ts`
    - `packages/engine/src/__tests__/ccc-planning-source-fidelity.test.ts`
    - `packages/engine/src/__tests__/ccc-planning-graph-gate.test.ts`
    - `packages/engine/src/__tests__/ccc-planning-objections.test.ts`
    - `packages/engine/src/__tests__/ccc-planning-schedule-and-commands.test.ts`
    - `cards/gg.mjs`
  - Depends: B2, K1, K1b (E2-40a key, F11).
  - RED (T2.6, T2.7 and the new gates):
    - One changed request byte gives an anchor mismatch.
    - A quote that exists only in the PRD gives `REQUEST_QUOTE_UNRESOLVED`.
    - An uncovered heading-free line gives `UNIT_UNDISPOSITIONED`; the test asserts that compile alone gives zero items for it.
    - An annex clause citing the request gives `ANNEX_ATTRIBUTED_TO_REQUEST`.
    - A cyclic plan fails G4 with a graph diagnostic (no ledger spy: G4 is pure).
    - A blocking objection with no `decision_record` gives `OBJECTION_UNRESOLVED`; a `deferred` disposition on a blocking objection does too.
    - `cccPlanningObjectionsFromVerdict` turns a reject verdict with two findings (a `counterexample` ref and an `artifact` ref) into two objection contents with those refs.
    - The schedule simulation of the diamond gives `campaignCriticalPathMs = 4 × 5,400,000 + 1,200,000 + 600,000 = 23,400,000` at concurrency 1.
    - Proof commands (item 41), each refused with a detail naming the rule: `npm install && node --test`; `node --test test/tokenizer.test.mjs` (not `task verify:<name>`); `task verify:tokenizer` whose target is missing from the bundle's `Taskfile.yml`; a harness that is not in the verifier bundle; v2's demo shape, where writer `tokenizer` owns `test/tokenizer.test.mjs` and its proof's harness is that file (closure overlaps a model write root); a writer task that owns `Taskfile.yml` or any `test/**` path; a candidate path outside the task's own write roots.
    - Path comparison (E2-13): GG compares paths with K1 `cccPlanningPathComparisonKey` (as amended by E2-40 and, through K1b, E2-40a; E4-K), so an equivalent spelling (case, NFC/NFD, `./`) is treated as the same path: for example `./TASKFILE.yml` is refused as a writer-owned `Taskfile.yml`.
    - Semantic-id collision (E8-0, N-3): a plan with semantic task id `product-adversary`, whose G7 lineage id `review:product-adversary` equals the review-stage critic's fixed lineage, fails G4 with a diagnostic whose detail names `product-adversary`. Control: the section 4.1 diamond plan, whose ids form no fixed lineage id, passes.
  - Non-vacuous: the stubs return `[]` or 0, so each refusal and number fails. v2's rule ("`node --test` over paths inside the task's owned files") accepts v2's demo plan, which the importer's custody check refuses (`semantic-proof-custody.ts:1266-1279`, closure overlapping a model write root), so the overlap case fails on a v2-style implementation.
  - Positive control: a correctly attributed map, a resolved objection set, and the section 4.1 diamond plan (writers own only `src/**` and `bin/**`; each proof is `task verify:<name>` whose `Taskfile.yml` target runs `node test/<name>.test.mjs <src or bin file…>` from the verifier bundle) each yield zero diagnostics.
  - Check: `ENGINE src/__tests__/ccc-planning-source-fidelity.test.ts src/__tests__/ccc-planning-graph-gate.test.ts src/__tests__/ccc-planning-objections.test.ts src/__tests__/ccc-planning-schedule-and-commands.test.ts SUFFIX`
  - Route: opus. Review: critical.
  - Rule (E8-0, N-3): dispatch counters are keyed by lineage id alone (E7-L item 8(b)), so G4 refuses a plan whose semantic task id would form a G7 lineage id `review:<id>` equal to any planning fixed lineage id (section 2.1), with `CCC_PLANNING_GRAPH_INADMISSIBLE` and a detail naming the colliding id (editor's note: E8 names no code; section 2.17). If GG has a first repair round, the check and its RED go into it; if GG is accepted without one, they go into a GG follow-up accepted before W8. AD1 has no such duty.
- **VP: verifier preparation, G5 oracle gate, spec-ready, Build baseline** (G5, D20, D46, challenges 3 and 7).
  - Objective: prepare and qualify the verifier on B0 inside the sandbox, seal spec-ready, and recreate B1 in the target for Build.
  - Owns:
    - `packages/engine/src/ccc-planning/verifier-prep.ts`
    - `packages/engine/src/ccc-planning/verifier-baseline-recipe.ts`
    - `packages/engine/src/ccc-planning/spec-ready.ts`
    - `packages/engine/src/ccc-planning/build-baseline.ts`
    - `packages/engine/src/__tests__/ccc-planning-verifier-prep.real-git.test.ts`
    - `packages/engine/src/__tests__/ccc-planning-oracle-gate.darwin.test.ts`
    - `packages/engine/src/__tests__/ccc-planning-build-baseline.real-pg.test.ts`
    - `cards/vp.mjs`
  - Depends: K1, A1, AU4, X1.
  - RED:
    - The B1 recipe applied twice gives the same commit id.
    - G5 (a): a verifier file with a syntax error, one that imports a missing file at module scope, and one with zero tests each give `ORACLE_SETUP_FAILURE`, not a pass of "fails on B0".
    - G5 (b): a defective control that fails only on an untagged assertion gives `ORACLE_CONTROL_UNTAGGED`.
    - G5 (c): a weakened verifier that passes one defective control gives `ORACLE_CONTROL_FAILED`; a verifier that passes on B0 gives the same.
    - G5 (d): with readiness reporting not ready, the result is `blocked_prerequisite` / `SANDBOX_UNAVAILABLE`, and a `child_process` spy records zero spawns outside `runCccSemanticProofSandboxedProcess`.
    - Changing any reviewed artifact changes the `spec_ready` closure digest; preparation never touches the admitted repository (HEAD and status unchanged).
    - Baseline: with `afterRecord` throwing once, a second call ends with exactly one `build_transition` artifact, one `fusion/r2c-…-baseline` ref at B1, HEAD = B1, and `main` still at B0.
    - The B1 tree holds the verifier bundle's `Taskfile.yml` and every harness its proofs name, at the paths the task plan's proofs use, and none of them lies under `src/` or `bin/`; this is the closure the custody check reads at `baseCommit = B1` (item 41).
  - Non-vacuous: v1's single "fails on B0" check passes all three setup failures; the crash case leaves two artifacts or no ref in any non-idempotent implementation.
  - Positive control: a good verifier (dynamic import inside each test body) fails on B0 with `[REQ-x]`-tagged assertions and fails every defective control on its tag, so G5 passes; a changed verifier byte gives `BUILD_BASELINE_MISMATCH` and creates no ref.
  - Check: `ENGINE src/__tests__/ccc-planning-verifier-prep.real-git.test.ts src/__tests__/ccc-planning-oracle-gate.darwin.test.ts SUFFIX`, then `ENGINE_PG src/__tests__/ccc-planning-build-baseline.real-pg.test.ts SUFFIX`
  - Route: opus. Review: critical.
- **RV: G7/G8 review port composition** (D14, D44, critic 10, challenges 4 and 12; verify-v2 item 46).
  - Objective: run task and final reviews inside the campaign item, on the candidate snapshot, charged to review/proof.
  - Owns:
    - `packages/engine/src/ccc-planning/review-port.ts`
    - `packages/engine/src/__tests__/ccc-planning-review-port.real-pg.test.ts`
    - `cards/rv.mjs`
  - Depends: L1, A1, C2, SF, BF.
  - RED:
    - The proof gate passes and the review rejects, giving `new PermanentError(<message>, "CCC_PLANNING_REVIEW_REJECTED")`, and the item's `blockedReason` is `"ccc-permanent:CCC_PLANNING_REVIEW_REJECTED"` (F12, E6-0; the one-argument form would yield `ccc-permanent:PERMANENT`); the successor never runs; the rejection parks the campaign with `CCC_PLANNING_CODING_REPAIR_NOT_RUN` and claims no repair chunk.
    - G7 opens its session with `readSnapshot` `{kind:"candidate", commit, tree}` taken from the proof gate's `ccc:proof:source-commit` and `ccc:proof:source-tree`; G8 receives a `proof_results` artifact under the campaign fence and the integrated candidate.
    - Review spend raises `review_proof_spent` and leaves `ccc_prd_imports.request_count` unchanged.
    - A registered runtime digest different from the run's refuses before any review reservation.
    - G8's `proof_results` has one `results` entry per proof id, read from the settled proof attempts (`listCccCampaignProofAttemptsForCommit`, `proof-attempt.ts:1584`), and its `exitCode`, `resultSuccess` and `terminalEnvelopeSha256` equal the seeded attempt rows; with one proof id lacking a settled attempt, publication is refused and no review is reserved (item 46).
  - Non-vacuous: both counters and the artifact are read from PostgreSQL; a factory call with `admitted-base` fails the snapshot assertion; the proof gate's context patch carries no results (`ccc-campaign-proof-execution.ts:2005-2016`), so an implementation that reads it publishes an empty `results` and fails.
  - Positive control: an unlinked campaign handler gets an identity pass-through; an accepting review lets the successor run.
  - Check: `ENGINE_PG src/__tests__/ccc-planning-review-port.real-pg.test.ts SUFFIX`
  - Route: opus. Review: critical.
- **CB: Build control bridge** (0.26, D32, challenge 6; verify-v2 items 36, 43, 44).
  - Objective: `fn plan cancel` during Build through the existing in-lease cancel (leased item), the operator stop (unleased item) or a direct L1 cancel (ended item); `fn plan pause|resume` during Build refused until I4.
  - Owns:
    - `packages/engine/src/ccc-planning/build-control-bridge.ts`
    - `packages/engine/src/__tests__/ccc-planning-build-control-bridge.real-pg.test.ts`
    - `cards/cb.mjs`
  - Depends: L1, BF, H1.
  - RED:
    - Pause and resume on a linked run in `building` are refused `CCC_PLANNING_COMMAND_NOT_SUPPORTED`; `control_seq`, the campaign item and the run are unchanged (row counts).
    - Cancel with the campaign item **leased by a real in-process `workflow-work-processor`** running a fake graph that waits on its abort signal (the normal case in `building`): `applyCccPlanningBuildControl` returns `pending-in-lease` and sets `control_request = 'cancel'`. Then `applyCccPlanningPendingBuildCancels` on the processor's own store aborts the graph; the item ends `cancelled` with `lastError = "workflow-user-cancelled"`; the run ends `cancelled` through BF's mapping with `control_request` cleared; the control event carries the actor.
    - The same pending cancel applied from a **second** TaskStore instance over the same database finds no registered disposer and leaves the item running (the disposer registry is per store, `task-move-disposer.ts:17-22`), which is why serve applies it (WR).
    - Cancel with the item unleased: the operator stop runs with reason `fn plan cancel by alice for run ccc-plan:<24hex>`, the item is `cancelled` with the stopped marker, and the run is `cancelled`. `applyCccPlanningBuildControl` with a 2,000-character actor returns `{kind: "refused", code: "CCC_PLANNING_INTERNAL_ERROR"}` (L1's refusal passed through, E3-3) and changes no row; with a 200-character actor the control event's `agentId` is `operator:<actor>`, unchanged (E2-4, E4-6, replacing item 43's long-actor case; the CLI's exit 2 `usage_error` is CL1's RED).
    - Cancel with the item already `failed`: the operator control writes no item transition (`ccc-campaign-operator-control.ts:486-520`), and CB moves the run `building → cancelling → cancelled` directly (item 44).
    - Cancel from each non-building linked state that has an allowed `→ cancelling` pair, one RED per state: `importing`, `awaiting_execution_authority`, `paused`, `awaiting_budget`, `blocked_prerequisite`, `blocked_provider`, `budget_exhausted`, `unknown_effect`, `verification_failed` and `accepted`. In each, `control_request = 'cancel'` is stored, and the applier and BF's mapping move the run from that current state to `cancelling` and then `cancelled`, never from the literal `building` (E2-3, E4-13).
    - Cancel in `delivering` returns `{kind: "refused", code: "CCC_PLANNING_STATE_TRANSITION_REFUSED"}` from L1 and changes no row (E3-1, E4-13).
  - Non-vacuous: run and item states are read from PostgreSQL; v2's bridge gets `CCC_CAMPAIGN_OPERATOR_CONTROL_LEASED` in the leased case (`ccc-campaign-operator-control.ts:186-195`) and never cancels; a flag-only implementation (v1 D32) leaves the item `running`.
  - Positive control: `fn prd`'s own stop path through `applyCccCampaignOperatorControl` (`prd.ts:2895-2905`) still works on an unlinked campaign (`ccc-campaign-operator-control.real-pg.test.ts` unchanged).
  - Check: `ENGINE_PG src/__tests__/ccc-planning-build-control-bridge.real-pg.test.ts src/__tests__/ccc-campaign-operator-control.real-pg.test.ts SUFFIX`
  - Route: opus. Review: critical.

#### Wave W8

- **ST1: stages preflight, intent, research, design, design-review** (G1, G2, D29, D47, challenge 23).
  - Objective: the front planning stages on real PostgreSQL.
  - Owns:
    - `packages/engine/src/ccc-planning/stages/{preflight,intent,research,design,design-review}.ts`
    - `packages/engine/src/__tests__/ccc-planning-stages-front.real-pg.test.ts`
    - `cards/st1.mjs`
  - Depends: RP, C5, C6, SF, H1, GG.
  - RED:
    - An ambiguous request gives `awaiting-intent` with a decision id, and `answer` resumes.
    - A research artifact citing a URL without a citation artifact is refused.
    - designer-b's session inputs exclude designer-a's.
    - Both designs `infeasible` gives `DESIGN_INFEASIBLE`.
    - A design-review reject verdict yields controller-published `objection` artifacts in stage `design-review`.
    - The preflight failure path gives `blocked_provider`, and `preflightSpent` is read back from the anchor and audit.
  - Non-vacuous: a fake-model script drives each branch, and counters and artifacts are read from PostgreSQL, not from in-memory fakes.
  - Positive control: a clean script commits all five stages with spend equal to the fake server log.
  - Check: `ENGINE_PG src/__tests__/ccc-planning-stages-front.real-pg.test.ts SUFFIX`
  - Route: opus. Review: critical.
- **ST2: stages spec, plan, verifier, review, repair, specready** (G3-G5, D13, D21, D41, D47, challenges 14, 17, 23; the repair-count ruling).
  - Objective: the back planning stages, the repair loop and spec-ready, on real PostgreSQL.
  - Owns:
    - `packages/engine/src/ccc-planning/stages/{spec,plan,verifier,review,repair,specready}.ts`
    - `packages/engine/src/__tests__/ccc-planning-stages-back.real-pg.test.ts`
    - `cards/st2.mjs`
  - Depends: GG, VP, RP, IB1, SF, H1, L1.
  - RED:
    - A critic rejection claims a repair chunk with `repairAuthors` (the authors whose candidates change) and `reReviewers` (the critics that review the new version). Each author repair lineage inherits the author's count; each re-review runs on a new review node `<stage>:<role>:rv<k>` with inherited 0, and the critic receives no previous verdict (D13 ruling).
    - With the same critic re-reviewing in every chunk, all four chunks run and the fifth claim is refused `REPAIR_EXHAUSTED`. With the same **author** repairing in every chunk, its third repair (attempt 4 of the lineage) is refused `DISPATCH_CAP`, before chunk 4.
    - Two stagnant epochs give `failed REVIEW_STAGNATED`.
    - A G4 failure reserves zero review calls (ledger count from PostgreSQL).
    - A fifth repair is refused with `REPAIR_EXHAUSTED` (roles varied so the cap does not bind first).
    - An unresolved blocking objection blocks `specready`; resolving it with a `decision_record` from the spec author lets `specready` publish.
    - `specready` publishes only when all G0-G5 verdicts pass, and in Spec mode the run rests in `spec_ready` while in Build it moves to `importing`.
  - Non-vacuous: every counter is read back from the PostgreSQL ledger (challenge 23); an author repair lineage without inheritance admits the third repair, and v2's rule, which made critics inherit too, refuses the third re-review that the ruling allows.
  - Positive control: an accepting first review goes straight to `specready` with no chunk claimed.
  - Rule (E7-L item 11, recorded): supersession is per role, so ST2 never names `task-reviewer` as a coding-rejection re-reviewer.
  - Check: `ENGINE_PG src/__tests__/ccc-planning-stages-back.real-pg.test.ts SUFFIX`
  - Route: opus. Review: critical.
- **IB2: import bridge and import stage** (G6, D16, D17, D20, critic 6, critic 7, challenges 21 and 22; verify-v2 items 38 and 49).
  - Objective: import the reviewed plan once, from a computed-once bound, on the baseline B1.
  - Owns:
    - `packages/engine/src/ccc-planning/import-bridge.ts`
    - `packages/engine/src/ccc-planning/stages/import.ts`
    - `packages/engine/src/__tests__/ccc-planning-import-bridge.real-pg.test.ts`
    - `cards/ib2.mjs`
  - Depends: B3, IB1, IM1, K2, AU2, BF, VP, GG.
  - RED (T2.2-T2.4, T2.8-T2.10, plus the v2 cases):
    - An injected conformance failure gives no intent, and the importer spy is not called.
    - HEAD drift gives `CCC_PRD_TARGET_HEAD_DRIFT`.
    - `lost_response_after_commit` leaves one import row after recovery.
    - A one-byte annex change after the intent gives `SLOT_CONFLICT`, and the row count stays 1.
    - Reviewed-bytes drift is refused.
    - `maxRequests` is 3,072, the duration clamp is recorded, and a `combo/` writer route gives `ROUTE_NOT_ADMITTED`.
    - With the run's `deadline_at` 20 hours after `boundsComputedAt`, `maxDurationMs` is 71,970,000 (20 h − 30 s) with a `deadline-headroom` clamp, not the 86,400,000 import ceiling, and the intent's limits carry that value (item 49).
    - A build-fit shortfall at step 4 (the run's remaining time below `2 · campaignCriticalPathMs`) moves the run `importing → budget_exhausted` with `BUILD_FIT_INSUFFICIENT`, publishes no intent and does not call the importer (item 38; refused by the v2 trigger).
    - A retry after `admission_facts` and `bundle` are published, with the clock advanced 10 minutes, reuses the stored bounds: no `SLOT_CONFLICT`, and intent limits equal `bundle.bounds`.
    - The compiled bundle is schema v2 with execution policy `ccc-campaign.execution-policy.v2`, and every provider task has exactly one task-phase proof gate; a v1 policy is refused `GRAPH_INADMISSIBLE`.
    - The baseline step runs before the shared preflight: preflight sees HEAD = B1 on the baseline branch, and `main` is still B0.
    - The route-admission input holds exactly one G8 identity, built for the judge task (`judge:final`), and no G8 identity for a writer or G7 review task id; a writer route that mixes product-route keys with `routeKind` is refused by K2 (`CCC_ROUTE_IDENTITY_REJECTED`, `role-model-mismatch`) and reported `CCC_PLANNING_ROUTE_NOT_ADMITTED` (E8, K2 residual; E8-0, N-4).
  - Non-vacuous: the importer's real failure checkpoints are used (`importer.ts:69-93`); recomputing bounds from `db_now` on retry produces different bundle bytes and fails the retry case.
  - Positive control: a clean import links once, releases, and moves the run to `building` (or `awaiting_execution_authority` with an operator-release receipt).
  - Check: `ENGINE_PG src/__tests__/ccc-planning-import-bridge.real-pg.test.ts SUFFIX`
  - Route: opus. Review: critical.
  - Rule (E8, K2 residual): the bridge builds a G8 identity only for the judge task, because K2's G8 branch never calls `roleOf` and would admit a G8 identity whose `taskId` is a writer or a G7 review id. When `CccRouteRole` gains a G8 role, the card that adds it makes K2's admission refuse a G8 identity whose graph role is writer or g7-review (section 6 risk 56). K2's `CCC_ROUTE_IDENTITY_REJECTED` refusals, `role-model-mismatch` included, are reported as `CCC_PLANNING_ROUTE_NOT_ADMITTED` (E8-0, N-4; section 2.17 step 3).

**INT-8 (parent).** `stages/index.ts` registry, barrels, CLI mock list, build, typecheck, targeted proof. It keeps the K1 test-tsc check, as every INT step after INT-2d does (E8-0, N-7).

#### Wave W9

- **LV: live and installed proof scripts** (PRD §14, D23, D52, 0.25, challenge 27).
  - Objective: drive and record the live run without ever authoring authority.
  - Owns:
    - `scripts/ccc-planning-live-proof.mjs`
    - `scripts/ccc-planning-installed-proof.mjs`
    - `scripts/__tests__/ccc-planning-live-proof.test.mjs`
    - `cards/lv.mjs`
  - Depends: IP, P0.
  - RED:
    - Without `--confirm-authority`, the script exits 1 with `CCC_PLANNING_AUTHORITY_CONFIRMATION_REQUIRED` before any spawn.
    - With a wrong digest, the exact typed bytes reach `fn plan start` (argv spy), and the script reports the downstream `UNCONFIRMED` refusal unchanged.
    - The script never writes or confirms an authority receipt and never hashes one. A file-system spy covers writes; the `crypto` spy matches only hash updates whose input bytes equal the authority receipt file's bytes, so the dist-digest recomputation of the drift case is allowed (item 52).
    - `--profile adaptive` gives `PROFILE_NOT_IMPLEMENTED`; the installed proof always exits 1 and lists every NOT RUN item.
    - A candidate installed-runtime receipt with a drifted digest, or with `keepaliveModelSource` other than `fusion-receipt-adapter`, is refused.
    - The report lists `notEnforced` (D52).
  - Non-vacuous: the drift case uses a real recomputation, which v2's spy on every `crypto` hash flagged as a violation; a script that "helpfully" hashes the receipt to fill in the digest fails the narrowed spy.
  - Positive control: a correct receipt and digest pass through to a fake `fn` that returns `run_admitted`.
  - Check: `SCRIPTS scripts/__tests__/ccc-planning-live-proof.test.mjs`
  - Route: sonnet. Review: normal.
- **CL2: `fn plan start`, G0 composition and the Build control wiring** (G0, section 2.18 order, D49; verify-v2 items 35 and 36).
  - Objective: the frozen G0 order, CB as the default `applyBuildControl`, and BF's reconcile as the `reconcileLinkedOutcome` port of `fn plan status`.
  - Owns:
    - `packages/cli/src/commands/plan.ts`
    - `packages/engine/src/ccc-planning/g0.ts`
    - `packages/cli/src/commands/__tests__/plan-start.test.ts`
    - `packages/engine/src/__tests__/ccc-planning-g0.test.ts`
    - `cards/cl2.mjs`
  - Depends: CL1, K1, K2, AU4, C6, X1, X1b (G0 step 11 discovery, E4-5), IP, CB, BF, X1z (G0 step 11 calls discovery with its defaults, E8-X; editor's encoding).
  - RED:
    - Each of the 15 G0 steps refuses with its code when only that input is broken, and writes zero rows. Step 11 has two single-fault cases: a failing qualification, and a missing required tool, where discovery over a fixture search path without that tool makes G0 refuse `CCC_PLANNING_CONFINEMENT_UNQUALIFIED` with detail `toolchain-missing:<tool>` (E4-5).
    - Step 6 has one single-fault case (E5-K2 item 8; E7-0, N1): `budgetProfile: "large"` without `largeAuthorized` refuses `CCC_PLANNING_LARGE_NOT_AUTHORIZED`. A profile other than `full-v2` is refused at step 2 by K2's parse (`AUTHORITY_RECEIPT_INVALID`), so no receipt reaches `CCC_PLANNING_PROFILE_NOT_SUPPORTED` while the parse accepts only `full-v2`; the code stays in the section 2.3 union, and the I6 card (E8-0; not I5) that widens K2's parse to `lean-v2` and `adaptive-v2` adds that RED (a parse-valid profile the mode does not support). A missing optional tool at step 11 does not refuse (E6-0).
    - The step order is proven by breaking steps 2 and 9 together, which must report step 2.
    - A clean run returns `run_admitted` with `plannedPlanningNodes: 14`.
    - `cancel` on a linked run now reaches CB (spy) instead of the CL1 default refusal; a `pending-in-lease` result prints `control_accepted` with `appliedDirectly: false` and `route: "campaign-bridge"` and exits 0; `pause` on a linked run in `building` exits 1 with CB's `COMMAND_NOT_SUPPORTED` (item 36).
    - `fn plan status` on a linked run passes BF's `reconcileCccPlanningCampaignOutcome` as the port (spy called once before the status line is printed); on an unlinked run the spy is not called (item 35).
  - Non-vacuous: the single-fault matrix; v1's `plannedPlanningNodes: 15` fails.
  - Positive control: the clean run itself, admitted once and replayed to `RECEIPT_CONSUMED`.
  - Check: `ENGINE src/__tests__/ccc-planning-g0.test.ts SUFFIX`, then `CLI src/commands/__tests__/plan-start.test.ts src/commands/__tests__/plan.test.ts SUFFIX`
  - Route: opus. Review: critical.
  - Rule (E5-K2 item 8): CL2 passes `now` to K2's receipt checks in the canonical `…Z` form. K2's parse runs the expiry check and the caps check inside step 2, so a single fault in either is still refused with its own code (section 2.18).
- **WR: runtime wiring and writer sessions** (D12, D11, D14, D15, D48, challenge 18; verify-v2 items 18, 35, 36, 37).
  - Objective: wire the real stages, review port, linked outcome reconcile, pending Build cancels and linked writer sessions into the runtime, the graph executor and the executor.
  - Owns:
    - `packages/engine/src/runtimes/in-process-runtime.ts`: compose RV at `:2109`, inject the real stage registry and SF; pass BF's `reconcileCccPlanningCampaignOutcome` as `reconcileLinkedOutcome` to H1's recovery and to the runtime's status reads (item 35); call CB's `applyCccPlanningPendingBuildCancels` on serve's own store on every runtime tick (item 36)
    - `packages/engine/src/workflow-graph-executor.ts` (ADDITIVE only, item 18): add `nodeAttemptOrdinal?: number` to `WorkflowNodeExecutionContext` (`:145-154`) and pass `attempt + 1` in the handler call inside the retry loop (`:2175-2227`). No other change; existing handlers ignore the field. The file has no line-pinned shellout.
    - `packages/engine/src/executor.ts`: writer call site `19215-19260`. Planning-linked campaigns only: `scopeKind: "planning-linked-writer"`, the turn key from BF's `openCccPlanningLinkedWriterAttempt` with `nodeAttemptOrdinal` read from the execution context the executor already forwards into `stepOptions` (`executor.ts:9742, 10136-10142, 18629-18635`), `cccConfinement`, the linked writer `toolPolicy` (`buildCccSessionToolPolicy({roleClass: "writer", linkedWriter: true, …})`, which keeps the campaign ready tool `fn_complete_phase`, item 37), `cccStreamGuard`, `cccProviderPinCheck`, and no `mcpServers`.
    - `packages/engine/src/__tests__/ccc-planning-writer-session.test.ts`
    - `cards/wr.mjs`
  - Depends: H1, RV, X1, X1b (toolchain discovery, E4-5), X1c (dispose result, E4-9), K1b (`CCC_PLANNING_WRITER_CLOSURE_UNCONFIRMED`, E3-4, E4-1), C2, C6, ST1, ST2, IB2, BF, CB, X1z (discovery defaults and the decorator's `dispose`, E8-X; editor's encoding).
  - RED:
    - A planning-linked writer session has exactly `CCC_PLANNING_LINKED_WRITER_TOOLSET` (the writer tools plus the campaign ready tool `fn_complete_phase`), a confined bash, no MCP, and a binding provider equal to `defaultProvider`; a fake model that calls `fn_complete_phase` completes the phase (item 37).
    - On a node retry, the graph executor passes `nodeAttemptOrdinal` 1 and then 2 into the handler (spy on the execution context), the writer gets a different derived turn key from attempt 1, and each attempt's calls are recorded separately in `writerAttempts` (item 18).
    - At runtime start, H1's recovery reconciles a linked run left in a stale state through the real BF port; with a `building` run whose `control_request = 'cancel'`, the next runtime tick calls `applyCccPlanningPendingBuildCancels` (spy) with the runtime's own store (items 35 and 36).
    - Writer closure unconfirmed (E2-5, E4-3, E4-4): a stub `BashOperations` whose `exec` throws `CccConfinementClosureError` is driven through the real Pi session and tool loop, with no call-site injection. The result is the quarantine directory `<fusionDir>/quarantine/<attemptKey>/` holding the attempt's write roots and a `quarantine.json` (attempt key, closure record, timestamp), no commit, and `new PermanentError(<message>, "CCC_PLANNING_WRITER_CLOSURE_UNCONFIRMED")` to the graph executor. The item ends manual-required with `blockedReason === "ccc-permanent:CCC_PLANNING_WRITER_CLOSURE_UNCONFIRMED"`, so there is no retry on that worktree.
    - Dispose duty (E4-9): a writer session that ends normally, but whose confined bash stub's `dispose()` resolves `{closure: "unconfirmed"}`, is disposed exactly once and quarantined exactly as in the case above: same directory, no commit, same `PermanentError` and `blockedReason`.
    - Returned controller (E8-0, N-1): the linked-writer binding is built around the controller `attachCccProviderAttemptBoundRoute` returns, so session creation succeeds and `preDispatch` and `reconcile` reach BF's controller; a binding built on the original controller (no marker) is refused at session creation, before any provider call. The marker's values equal BF's `route` field (N-5).
    - Shape equality (E8-0, N-5): a type test pins that BF's core `route` shape and the engine's `CccProviderAttemptBoundRoute` are equal (for example `expectTypeOf<BfRoute>().toEqualTypeOf<CccProviderAttemptBoundRoute>()`), so a key added or changed on either side fails the engine typecheck.
  - Non-vacuous: v1's shared base turn key gives the same key for both attempts; without the graph-executor edit the execution context has no ordinal and the retry case fails; the plain writer policy refuses the executor's `fn_complete_phase` tool. Without the latch, Pi's agent loop turns the thrown error into an error tool result (`pi-agent-core dist/agent-loop.js:468-475`) and the session goes on, so the closure case fails (E4-3); a writer that never disposes, or ignores the result, commits in the dispose case.
  - Positive control: an unlinked campaign writer session is byte-identical to today (snapshot of the session options, including `mcpServers` from `resolveMcpServers`); a writer session whose dispose resolves `{closure: "confirmed"}` commits normally (E4-9).
  - Rule: the graph-executor edit is additive; any other change to `workflow-graph-executor.ts` is a contract fault, and the leaf stops and reports it.
  - Rule (E2-5, E4-3, E4-4, E4-9): WR wraps `cccConfinement.bash` at the writer call site, so the first `CccConfinementClosureError` thrown from `exec` is latched, because Pi's agent loop turns tool errors into error tool results. WR then aborts the session and, once it settles, rethrows at the call site. WR disposes the writer session's confined bash at session end; an `{closure: "unconfirmed"}` result is treated as the same closure failure. In either case WR moves the attempt's write roots to `<fusionDir>/quarantine/<attemptKey>/` by a rename on the same volume, writes `quarantine.json` with the attempt key, the closure record and a timestamp, does not commit, and gives the graph executor `new PermanentError(<message>, "CCC_PLANNING_WRITER_CLOSURE_UNCONFIRMED")`, whose second argument is the code (`engine-errors.ts:147`), so the item's `blockedReason` is `ccc-permanent:CCC_PLANNING_WRITER_CLOSURE_UNCONFIRMED`. Any later attempt uses a fresh worktree. No listener is closed: no long-lived admitted listener exists, because `acquireCccSemanticProofLoopbackPort` closes its probe listener.
  - Rule (E4-5, E4-B): WR takes the writer's sealed toolchain from X1b's `discoverCccToolchain`, the same discovery G0 step 11 uses, and never passes `sealedEnvironment` to the factory.
  - Rule (E6-0): WR calls discovery with its defaults (the minimal required set, the optional GNU set, the Homebrew-only search path), and a missing optional tool never fails a writer session.
  - Rule (F5, E6-C): WR wraps the writer's confined `BashOperations` in X1b's shell-compat decorator.
  - Rule (E6-B item 6): WR reads `cccConfinedShellLastClosure` from the inner confined operations, never from a wrapper around them (the decorator or the latch wrapper).
  - Rule (E6-0, section 6 risk 50): WR measures the first-launch cost of the cloned binaries (about 0.5-1.4 s per binary) on the I2 host before trusting a short model timeout, and reports the figure.
  - Rule (E7-0, D48 note; amended by E8-0, N-1 and N-5): WR attaches the bound-route marker with P1's `attachCccProviderAttemptBoundRoute(controller, route)` where it creates the linked-writer session (the `executor.ts` writer call site above), passing the `route` value of BF's `openCccPlanningLinkedWriterAttempt` result. The helper returns a new frozen controller and leaves its argument unchanged, so WR builds the linked-writer binding around the returned controller; a binding built on the original controller is refused at session creation (fail-closed).
  - Rule (E1 carry-forward): the graph executor treats `maxRetries: 0` as unset (`workflow-graph-executor.ts:2160-2163`); pass explicit attempts.
  - Check: `ENGINE src/__tests__/ccc-planning-writer-session.test.ts src/__tests__/workflow-graph-executor-handlers.test.ts src/__tests__/workflow-graph-executor-parity.test.ts src/__tests__/workflow-graph-executor-retry-coding-workflow.test.ts SUFFIX`. Outside regression check, not in `cards/wr.mjs` (E2-10): `ENGINE src/__tests__/ccc-campaign-proof-execution.test.ts SUFFIX`; its runtime `it.skip` is outside P0's static policy, because P0 scans only the files listed in an inventory.
  - Route: opus. Review: critical.

#### Wave W10

- **O2: offline Build slice and Spec mode** (I2 offline exit).
  - Objective: the whole I2 flow on fake loopback models, with counts reconciled against the server log.
  - Owns:
    - `packages/engine/src/__tests__/ccc-planning-build-slice.real-pg.test.ts`
    - `packages/engine/src/__tests__/ccc-planning-spec-mode.real-pg.test.ts`
    - `cards/o2.mjs`
  - Depends: all W6-W9 cards and O1's fixture (read-only).
  - RED/GREEN, with fake loopback models:
    - The text-stats request goes through the preflight (9 calls) and all planning stages, then baseline, import, release, four fake writers, G7 times 4, G8, and ends `accepted` through BF's mapping.
    - With an operator-release receipt, the run waits in `awaiting_execution_authority`, `fn prd approve-execution` is applied, and the first writer reservation moves it to `building`.
    - A fake writer that exceeds 11 calls in attempt 1 continues in attempt 2 under a new turn key; per-attempt call counts are recorded.
    - The planned diamond has writers owning only `src/**` and `bin/**` and proofs `task verify:<name>` from the verifier bundle at B1, and the importer's semantic-proof custody check accepts every proof at import (item 41).
    - A second Build run, cancelled with `fn plan cancel` while a fake writer runs, ends `cancelled` through serve's in-lease cancel and BF's mapping, with no linked reservation after the cancel (item 36).
    - Spec mode ends resting in `spec_ready` with no import row.
    - Spend matches the fake server log exactly, per phase, with `preflightSpent` separate.
  - Non-vacuous: per-phase counters are compared with the server log; the run never reaches `accepted` without BF's mapping.
  - Positive control: Spec mode on the same request produces the same planning artifacts up to `spec_ready`.
  - Check: `ENGINE_PG src/__tests__/ccc-planning-build-slice.real-pg.test.ts src/__tests__/ccc-planning-spec-mode.real-pg.test.ts SUFFIX`
  - Route: opus. Review: critical.

**EXIT-I2-offline (parent).** Run `pnpm test:ccc-planning` and `pnpm verify:ccc-planning-offline` (Darwin, network guard on), plus a critical review. Then `pnpm --filter @fusion/core typecheck`, the engine, CLI and dashboard typechecks, `pnpm check:changesets` and `pnpm lint`.

#### Wave W11

- **LIVE: operator-authorized live run.** The parent runs it after Ryan types the receipt digest. Section 4 has the commands. The installed keepalive test (IP, installed lane) runs first (section 4.2 step 0; npm ruling in section 5).

**I2 critical path:** `S0 → L1 → H1 → SF → O1 → EXIT-I1 → AU4 → VP → IB2 → WR → O2 → EXIT-I2-offline → LIVE` (one card per wave from W6 to W10). The parallel feeders that must also finish are:
- `P1 → C2 → SF`;
- `K1 → AD1 → CL1 → CL2`;
- `BF → RV → WR` and `BF → CB → CL2`;
- `GG → ST2 → WR`;
- `C6 → ST1 → WR`;
- `IM1 → AU2 → IB2` and `B3 → IB2`;
- the W1 residual (E4): `X1b → SF`, `X1c → SF`, `X1b → CL2`, `K1b → BF → WR` and `X1b, X1c, K1b → WR`; and `K1b → GG` (F11).
- the E8 re-plan cards in W3: `P1z → C6` (P1z before W6), `X1z → SF`, `X1z → CL2`, `X1z → WR` and `L1z → BF`.

### 3.3 I3-I6 epics (not carded)

- **I3 Build depth.**
  - Concurrency pools and the resource ramp; multi-root graphs.
  - Coding repair through the shared repair epoch.
  - Add a retry index to the campaign `providerAttemptTurnKey` for unlinked campaigns too, with a versioned key and legacy acceptance (linked writers already derive one, D15).
  - Flash extraction leaves within the allocation.
  - Raise the import ceilings for Build Large.
  - The observed-acceptance auditor (P = 1).
  - (The re-review counting question that v2 sent here is settled by the leader's repair-count ruling, D13.)
  - **Prerequisite (E6-0, section 6 risk 51):** go-task runs `cmds` in its own shell, so the `BASH_ENV` dispatcher, `command_not_found_handle` and bash's `exec` builtin never apply there. Verifier Taskfiles that run package scripts wrap them in `bash -c`, and VP or GG enforce that. I2 is unaffected, because its target runs `node --test` directly.
  - **Optional GNU tools (E6-0):** a later card that needs GNU grep, sed, findutils, gawk or diffutils asks the operator, once, to install them. Until then they are sealed when found and left out otherwise.
- **I4 Spec-to-Build and amendments.**
  - `fn plan build` and `fn plan budget`.
  - An identity migration for the Spec-to-Build mode change.
  - The escalation ladder.
  - The `awaiting_budget` exit.
  - **Must-do (verify-v2 item 36):** pause and resume during `importing` and `building`. The processor holds the campaign item's lease for the whole graph, so this needs a new in-lease safe point; until then both refuse with `CCC_PLANNING_COMMAND_NOT_SUPPORTED`. It is tracked in the acceptance tracker and is never silently dropped.
- **I5 Surfaces.**
  - Dashboard and mail views of `CccPlanningRunStatusV1`.
  - Neutral-directory CLI and dashboard journeys.
  - Delivery (G9) to a remote under exact operator approval.
  - Authenticated operator identity for answers and controls (D52).
- **I6 Qualification.**
  - Storage for the PostgreSQL qualification certificate, and the held-out corpus.
  - ADAPTIVE-v2 and LEAN-v2 comparison jobs.
  - Widening K2's receipt parse to `lean-v2` and `adaptive-v2`. That card adds CL2's `CCC_PLANNING_PROFILE_NOT_SUPPORTED` RED, a parse-valid profile the mode does not support (E7-0, N1; moved from I5 to I6 by E8-0).
  - A Linux confinement backend.
  - macOS CI evidence.
  - The twelve-criterion release matrix, and `verify:ccc-planning-installed` able to exit 0.
  - **Must-do before final acceptance (leader ruling):** exercise the Flash extraction leaf role (`extraction-leaf` and `leaf-reviewer`), which is NOT RUN in I2.

## 4. The I2 slice

### 4.1 Target and request

- **Target.** An owned disposable scratch root, `ROOT=<scratch>/ccc-planning-i2-<tag>/`, laid out exactly as ADR D Q4 describes:
  - `owner.json` (`ccc-planning.disposable-target-owner.v1`, with a 32-hex nonce);
  - `target/`, created with `git init -b main`, no remote, and a baseline B0 holding only `package.json` (text-stats, `node --test`), `README.md`, `.gitignore` and `Taskfile.yml`. B1 adds the reviewed verifier bundle: the `test/*.test.mjs` harnesses and one `verify:<name>` target per proof in `Taskfile.yml` (item 41);
  - `home/`, `install/`, `pg/`, `tmp/`, `request/request.md`, `authority/`, `evidence/`;
  - Fusion worktrees in `target-worktrees/`.
- **Baseline for Build (challenge 3).** At G6, VP's `ensureCccPlanningBuildBaseline` publishes a `build_transition` artifact naming the predicted B1, then commits the reviewed verifier bundle on the Fusion-owned branch `fusion/r2c-<24hex>-r001-baseline` (`cccPlanningBaselineBranchRef`) and checks out that branch. The target's `main` stays at B0. The import's `targetBase` is B1.
- **Request.** ADR D's sealed four-part text-stats request, verbatim:
  - a tokenizer;
  - word frequency;
  - reading time;
  - a CLI that prints JSON and exits 2 on error;
  - `node --test` tests, no dependencies, no `package.json` change, no network.

  Its SHA-256 and byte length go into the receipt.
- **Expected graph.** A diamond, T1 tokenizer → {T2 word frequency, T3 reading time} → T4 CLI, with disjoint ownership of `src/*.mjs` and `bin/text-stats.mjs` only. Writers own no test file (verify-v2 item 41): each task's proof is `task verify:<name>`, whose `Taskfile.yml` target runs `node test/<name>.test.mjs <the task's src or bin files>`, and the harness and `Taskfile.yml` come from the verifier bundle committed at B1, outside every write root, as the custody check requires (`semantic-proof-custody.ts:1266-1330`: closure disjoint from the write roots, read at the base commit, exactly one `Taskfile.yml` task runner, candidates inside the write roots). G4 checks admissibility before any review spend. A chain or a single task would also be admissible, and the G6 Build fit uses GG's schedule simulation of whichever graph is planned.

### 4.2 Commands (Darwin, M5 Max; the parent runs every step; nothing runs on port 4040)

```text
0. (parent, first; npm ruling in section 5)  PI_OFFLINE=1 node --test scripts/__tests__/ccc-planning-installed-keepalive.test.mjs
      arm A (packed + npm-installed fn, bound route through the Fusion receipt adapter) must report the true model;
      arm B (installed @earendil-works/pi-ai stream directly) must report the placeholder, or IP records workspacePatch "carried"
1. node scripts/ccc-planning-install-runtime.mjs "$ROOT/install"
      (npm: offline cache first; a read-only fetch of public packages from the public registry is ordinary dependency
       hydration, leader ruling; --ignore-scripts, no global install)
      -> $ROOT/evidence/installed-runtime.json (ccc-planning.installed-runtime.v1: distManifestSha256,
         piAi { version "0.81.1", shipping "external", workspacePatch, keepaliveModelSource "fusion-receipt-adapter" })
2. node scripts/lib/ccc-planning-disposable-target.mjs --root "$ROOT"
      -> target/, owner.json, request/request.md, home/.fusion/settings.json (3 pinned providers, modelSync "disabled",
         X-OmniRoute-No-Cache, no apiKey, openrouterModelSync/opencodeGoModelSync false), owned TCP-only PostgreSQL in pg/
3. cd "$ROOT/target" && env -i HOME="$ROOT/home" PATH="<sealed path>" DATABASE_URL="<owned pg>" TMPDIR="$ROOT/tmp" PI_OFFLINE=1 \
      "$ROOT/install/node_modules/.bin/fn" project add ... --json          -> projectId
4. The parent writes $ROOT/authority/receipt.draft.json (every field except operatorConfirmation; release
      "controller_within_receipt", leader ruling D36) and shows Ryan the draft and its computed digest (section 5).
      Ryan types the digest in his own message. Only then: receipt.json with operatorConfirmation = that digest.
5. pnpm verify:ccc-planning-live --profile full --candidate "$ROOT/evidence/installed-runtime.json" \
      --approval-receipt "$ROOT/authority/receipt.json" --confirm-authority "<the digest exactly as Ryan typed it>"
   It refuses without --confirm-authority, passes the typed bytes unchanged, and records ccc-planning.live-proof-report.v1:
   5a. Pueue group "ccc-r2c-i2": cd "$ROOT/target" && env -i HOME=... PATH=... DATABASE_URL=... TMPDIR=... PI_OFFLINE=1 \
         fn serve --port 0 --host 127.0.0.1 --no-auto-register --project <projectId>
       (liveness: exactly one bound line, zero "Auto-registered" lines, port != 4040, listener owned by the Pueue pid;
        serve registers its runtime dist digest at start, and H1/RV/BF refuse any run whose digest differs)
   5b. fn plan start --project <projectId> --request-file "$ROOT/request/request.md" --mode build \
         --budget-profile standard --authority-receipt "$ROOT/authority/receipt.json" --confirm-authority <typed digest> --json
         -> run_admitted, runId, plannedPlanningNodes 14
   5c. fn plan status <runId> --json (project resolved from the run row), polled every 60 s with a Monitor until-loop
       (never a foreground sleep) until the state is in cccPlanningRestingStates("build") = accepted | verification_failed,
       in CCC_PLANNING_TERMINAL_STATES, or in CCC_PLANNING_OPERATOR_WAIT_STATES. awaiting_execution_authority happens only
       if the release envelope check falls back (D36); then Ryan runs fn prd approve-execution and the poll resumes.
       To stop the run in building: fn plan cancel <runId> (serve carries it out in-lease); pause/resume are refused.
6. Teardown: pueue kill <that task id only>; confirm no descendant of its process group; pg_ctl -D "$ROOT/pg" -m fast stop;
      move $ROOT/evidence to .archive/r2c-i2-live/<tag>/ (no rm -rf; the rm guard drops it without a TTY anyway)
```

If anything is reinstalled after step 1, serve is restarted before step 5b. Without a restart, serve keeps running the old code, and H1 refuses with `CCC_PLANNING_RUNTIME_NOT_PERMITTED` (section 6 risk 32).

### 4.3 Models per role in the live run

The models are exactly as in the section 2.7 table:
- **GLM 5.3 (`glm/glm-5.3`):** intent assessor, source verifier, designer B, design-A reviewer, spec author, execution planner, verifier author.
- **M3 (`minimax/MiniMax-M3`):** acceptance reviewer, researcher, designer A, design-B reviewer, verifier auditor, product adversary, technical critic, the 4 G7 task reviewers and the G8 final judge.
- **Flash (`glm/glm-5.3-flash`):** the 4 implementation writers.
- **Preflight qualification lineages (not nodes):** `preflight-writer` on Flash with the writer toolset in a scratch confined repository; `preflight-critic` on M3 with the critic toolset; `preflight-researcher` on M3 with the researcher toolset, its fetch tool bound to a refusing grant port.

No combo, no floating alias, no GLM 5.2, and no escalation.

### 4.4 Gates that must be real (live models, real PostgreSQL, real sandbox, real receipts)

- **G0**, all 15 steps in section 2.18, including:
  - the typed authority confirmation;
  - toolchain discovery and sealing through X1b's `discoverCccToolchain` (E4-5), called with its defaults, which X1z makes real (E8-X item 1): its default required set, optional set and Homebrew-only search path; the qualification receipt can name any missing optional tool (E6-0; E7-C N6);
  - the seven-probe confinement self-qualification;
  - the installed dist digest;
  - `keepaliveModelSource`.
- **Preflight**: the three qualification lineages on all three pins, 9 calls, shown as `preflightSpent`.
- **G1**: GLM intent with an M3 acceptance review.
- **G2**: M3 research with real fetches under `ccc-planning.source-policy.i2.v1`, then GLM source verification.
- **Designs and adjudication**:
  - designs A and B with cross-family reviews;
  - reviewer findings published by the controller as `objection` artifacts;
  - the spec author's `decision_record` for each objection;
  - critic adjudication.
- **G3**: source fidelity against the sealed request bytes.
- **G4**: deterministic graph admission, plus schedule simulation and the proof-command policy.
- **G5**: the verifier on B0 inside `runCccSemanticProofSandboxedProcess`, with all four rules (a)-(d): setup failures refused, every defective control failing on a requirement-tagged assertion, weakened verifiers refused, and no host fallback.
- **Spec-ready**: no unresolved blocking objection.
- **G6** steps:
  - route admission;
  - Build fit;
  - bounds computed once;
  - the B1 baseline on the Fusion-owned branch;
  - the shared preflight;
  - intent, link and release.
- **Writers**: four Flash writers under real `sandbox-exec`. Each dispatch attempt gets its own 11-call bucket, with at most 3 attempts per task, and calls are recorded per attempt.
- **G7**: four real M3 reviews, each on the candidate snapshot (the writer commit and tree from the proof gate), charged to review/proof.
- **G8**: the real M3 final judge on the integrated candidate and the `proof_results` artifact.
- **Run record**: BF maps every campaign outcome into the run record in the same transaction. The runtime digest is checked at H1, RV and BF.
- **Every call**: a terminal-route SSE receipt and a settled ledger row. In planning scope, any route drift is settled once and moves the run to `blocked_provider`.

### 4.5 Declared NOT RUN in I2 (each one is named in the live proof report and the milestone claim)

- G9 delivery and any landing on the target's `main` (leader ruling: no landing in I2). The target has no remote, and landing is not permitted. B1 lives only on the Fusion-owned baseline branch.
- **Flash extraction leaves** (leader ruling: not run in I2 Standard; the leaf role must be exercised before final acceptance, I6). One leaf makes planning N = 16, with floor 1,560 against 1,536 (24 short). Two leaves make N = 17, with floor 1,620 (84 short).
- Coding repair. A G7 or G8 rejection ends `verification_failed` with `CCC_PLANNING_CODING_REPAIR_NOT_RUN`.
- The observed-acceptance auditor (P = 0).
- **Live Spec mode.** Only the offline fake-model run (O2) exists, and per PRD §7:219 that proof does not count for the mode (critic 12).
- `fn plan build`, `fn plan budget`, amendments, the escalation ladder, and pause or resume while `importing` or `building` (refused with `CCC_PLANNING_COMMAND_NOT_SUPPORTED`, an I4 must-do in the acceptance tracker, verify-v2 item 36). `fn plan cancel` during `building` is in I2 (CB).
- ADAPTIVE-v2 and LEAN-v2.
- Dashboard and mail surfaces.
- Multi-root graphs, concurrency above 1, and the resource ramp.
- The qualification certificate, the held-out corpus and admitted (non-disposable) repositories.
- The Linux confinement backend.
- macOS CI evidence. Dispatching it is consult-gated. The Linux Gate does run the PostgreSQL-free, macOS-free planning suites (P0, D51).
- `verify:ccc-planning-installed`, which exits 1 by design.
- **A raw M3 tool-call probe before I2** (challenge 19, deferred by ruling). No model call happens outside a receipt. M3's tool behaviour is first observed at the LIVE preflight, and the degenerate-output guard is built from existing evidence.
- **A retry index on unlinked campaign turn keys.** Planning-linked writers derive per-attempt turn keys (D15); direct `fn prd` campaigns are unchanged until I3.
- **Procedural controls are not enforced (D52).** These are recorded, with an actor, but not authenticated: the operator-typed authority digest, `fn plan answer`, and `--actor`. Any local process with the same database access could perform them.

### 4.6 Budget arithmetic (Build Standard, `ccc-planning.budget-policy.v1`)

**Calls.** The floor is `2 · (30 · N + 300)`.

| Phase | Planned nodes | N | Floor (work) | Allocation | Spare | Hard bound from caps (work) |
|---|---|---:|---|---:|---:|---|
| Planning | 14 fixed roles (section 2.7), L = 0. The 3 preflight lineages are outside N | 14 | 2 · (420 + 300) = 1,440 | 1,536 | 96 | 14 lineages × 3 attempts × 11 calls = 462, which covers every author repair (an author repair lineage inherits the author's count, D13). Re-reviews are new review nodes (leader ruling): at most 4 chunks × 3 critics that review repairable artifacts (product-adversary, technical-critic, verifier-auditor; section 2.4's `repair` row) × 3 × 11 = 396, so 858. Preflight adds 3 × 1 × 3 = 9 automatically, so 867 in total. With two operator resumes of the preflight it adds 18 more, so 885. All stay under the 1,536 allocation, and the repair-chunk fit check (section 2.8) refuses a chunk earlier if the allocation runs low |
| Implementation | 4 Flash writers | 4 | 2 · (120 + 300) = 840 | 3,072 | 2,232 | 4 tasks × 3 attempts × 11 calls = 132. Each attempt has its own bucket (D15, BF), so this bound is now reachable |
| Review/proof | 4 G7 + 1 G8, P = 0 | 5 | 2 · (150 + 300) = 900 | 1,536 | 636 | 5 × 3 × 11 = 165 |
| Total | | 23 | 3,180 | 6,144 | | 867 + 132 + 165 = 1,164 automatic (v2, before the ruling: 768) |

- **Leaves.**
  - `N = 14 + L + [L > 0]`.
  - L = 1: N = 16, floor = 2 · (480 + 300) = 1,560, short by 24.
  - L = 2: N = 17, floor = 2 · (510 + 300) = 1,620, short by 84.
  - G0 plans L = 0. A researcher request for a leaf is refused at leaf admission with exact numbers, and nothing is reserved.
- **Campaign limits.** Computed once at bridge step 5 from the stored `boundsComputedAt` (challenge 21):
  - `maxRequests = min(3,072, 10,000) = 3,072` (D16).
  - `maxDurationMs = min(run.deadline_at − boundsComputedAt − 30 s, 86,400,000)`, the run's remaining time (verify-v2 item 49). With a 48 h deadline and planning well under 24 h, that is 86,400,000 here, recorded as an `import-ceiling` clamp; a later import gets the smaller `deadline-headroom` value. BF also refuses any linked reservation within 30 s of the run's `deadline_at` (D15).
  - `maxConcurrency = 1`.
  - The intent's limits must equal `bundle.bounds` (IM1).

**Time.** The model is fully sequential at `maxConcurrency = 1`: no two sessions overlap, including the "parallel" reviewers of a stage (challenge 20). Estimates are 10 min per preflight lineage, planning node and review node; 60 min per writer; and 20 min per heavy check.

| Quantity | Work | Minutes | ms |
|---|---|---:|---:|
| `planningMs` | 3 × 10 (preflight) + 14 × 10 (nodes) + 20 (G5 oracle run) | 190 | 11,400,000 |
| Build importing step | 1 heavy check (baseline, shared preflight, import) | 20 | 1,200,000 |
| `campaignMs` (T = 4) | 4 × (60 writer + 20 check + 10 G7) + 20 integration + 10 G8 = 360 + 30 | 390 | 23,400,000 |
| `totalMs` (Build) | 190 + 20 + 390 | 600 | 36,000,000 |

- **G0 (planning time fit):** 2 × 11,400,000 = 22,800,000 ms (6 h 20 min) ≤ the 48 h deadline (172,800,000 ms).
- **G6 (Build time fit):** 2 × 23,400,000 = 46,800,000 ms (13 h) ≤ min(remaining deadline, 86,400,000). The remaining deadline is about 44.5 h if planning took its estimate, so the binding term is the 24 h clamp.
- **Whole run:** 2 × 36,000,000 = 72,000,000 ms = 20 h ≤ 48 h.
- **Spec Standard:** 2 × 11,400,000 = 22,800,000 ms ≤ 43,200,000 ms (12 h).
- **Compared with v1:** v1 claimed 130 min of planning by running stages in parallel. Challenge 20 recomputed 140. v2's fully sequential model, with three preflight lineages and the G5 run, gives 190, and every fit still holds.
- **Watchdogs** are per model-session attempt (D40, challenge 28): 30 min for planning and review sessions, 60 min for a writer attempt, and 20 min for a heavy check. A stage that runs several sessions, such as a four-chunk repair loop, is never killed for its total length.
- **Receipt windows.** `expiresAt` is at most `issuedAt` + 7 days and at least `deadlineAt`.

## 5. Questions for Ryan (authority only)

1. **Issue the I2 live-authority receipt?** Recommended: yes, with this envelope:
   - Build Standard on the owned disposable text-stats target, FULL-v2;
   - the three exact pins on loopback OmniRoute;
   - caps 1,536 / 3,072 / 1,536 and a deadline of 48 h, with expiry at most 7 days;
   - `escalation: "forbidden"`, and `quota: subscription_unknown` with metered fallback forbidden;
   - source policy `ccc-planning.source-policy.i2.v1`, which allows public HTTPS reads only under the nodejs.org API and MDN JavaScript paths.

   The parent shows the draft and its digest. Only a digest Ryan types in his own message is passed to `--confirm-authority`. LV refuses without one and passes it through byte for byte. No agent authors, computes into the flag or confirms it. This is a procedural control, recorded but not authenticated (D52).

This is the only question. It is raised only at I2, after INT-9, with the concrete target, the three exact models and every bound prepared in the draft. The receipt digest cannot be supplied automatically: it must be typed by Ryan.

**Leader rulings (v3; these were questions in v2 and are no longer asked):**
- **Release mode:** `controller_within_receipt`. Code releases live execution only inside the exact receipt envelope and falls back to `awaiting_execution_authority` on any mismatch; AU2 makes the release crash-safe (D36).
- **Flash extraction leaves:** not run in I2 Standard, and recorded NOT RUN (section 4.5). The leaf role must be exercised before final acceptance (I6 must-do, section 3.3).
- **npm registry for the installed candidate:** prefer the offline cache. A read-only fetch of public packages from the public registry is ordinary dependency hydration: `npm install --ignore-scripts` of the packed CLI's dependencies into the scratch root, no lifecycle scripts, no global install (section 4.2 step 1).
- **Landing on the target's `main`:** no in I2. G8 judges the integrated candidate commit and the run ends `accepted`; G9 delivery is NOT RUN in I2.
- **Repair re-review accounting** (v2's Q6): settled by the repair-count ruling (D13). Author lineages keep one counter (1 attempt + 2 repairs), a fresh review of a new candidate version is a new review node, and the 4-chunk epoch is the global bound.

**Consult-gated, not for Ryan:** `gh workflow run full-suite.yml --ref agent/request-to-code-v3`, for macOS CI evidence, needs an `agy-bridge adversarial_review` first. R0p no longer needs a conditional question, because it is DONE (section 3.1 W0).

## 6. Risks and mitigations

| # | Risk | Mitigation | Owner |
|---|---|---|---|
| 1 | Gate 2 saw 12-130 calls per task. The 11-call cap per writer attempt, even with 3 per-attempt buckets (33 calls per task), may still bind | Each dispatch attempt now has its own bucket (D15). Planner prompts size tasks small (RP). O2 and LIVE record calls per attempt. A binding cap ends the run honestly in `budget_exhausted` / `CCC_PLANNING_ITERATION_CAP` or `_DISPATCH_CAP` through BF's mapping, never silently. Raising 11 is one constant but changes PRD §5, so it goes to Ryan with the data | RP, BF, LIVE |
| 2 | Planning has 96 spare calls at the floor (1,536 − 1,440), and any extra planned node refuses at G0 | Strict N is unit-proven (K1: N = 14, floor 1,440; `cccPlanningCallFloor(16)` = 1,560). The floor is an admission test; the hard bound is 867 automatic (885 with two preflight resumes) under the repair-count ruling, author repairs and review nodes included, below the 1,536 allocation. Leaves are declared NOT RUN | K1, CL2 |
| 3 | A confinement gap, or `sandbox-exec` deprecation on a future macOS | Every run self-qualifies at G0 with seven probes, including the positive loopback-port probe, each with a positive control. The profile and toolchain digests are pinned. Never `kill(-1)`. A Linux backend is in I6 | X1, CL2 |
| 4 | Hot shared files (`pi.ts`, `executor.ts`, `in-process-runtime.ts`, `provider-attempt.ts`, `provider-controller.ts`, `async-workflow-workitems.ts`, `workflow-graph-executor.ts`, `prd.ts`) regress campaigns | Region ownership. `pi.ts` is touched in serial waves (P1 W2, C2 W3); `executor.ts` by WR only; `provider-attempt.ts` and `async-workflow-workitems.ts` by BF only; `provider-controller.ts` by K1 (types, W1) then BF (one catch hunk, W6); `workflow-graph-executor.ts` by WR only, additively, with its three existing suites in WR's check. Campaign suites run at every INT, and each of these cards gets critical review | Parent |
| 5 | Planning sessions now stop on the first route drift or missing receipt (D10, planning scope only), so a transient OmniRoute receipt glitch ends a run in `blocked_provider` | This is intended: no unapproved substitute, and no silent retry. Campaign and direct `fn prd` behaviour, including `pi.test.ts:1872-1909`, stays byte-unchanged (P1 positive control). An operator resume re-runs within the dispatch cap | P1 |
| 6 | Exact-key persisted evidence breaks on restart if a campaign scope gains a field | `CccProviderAttemptScope` stays unchanged byte for byte. The planning and linked-writer scopes are separate types in K1, and no persisted campaign key changes. Linked writers' derived turn keys are new keys, not edits to old ones | K1, P1, BF |
| 7 | Trigger cost on the busy `task_documents` table | Ordinary documents pay one `LIKE` test. The recursive seal runs only for `design_alternative`. S0's test covers ordinary inserts | S0 |
| 8 | The installed runtime reports a placeholder model from OmniRoute keepalive chunks | No workspace patch is needed or hand-applied: the keepalive model read is Fusion-owned (`packages/engine/src/pi.ts`, bundled into the CLI through `noExternal: [/^@fusion\//]` in `packages/cli/tsup.config.ts`), while pi-ai ships external and unpatched (`packages/cli/package.json:74`). IP proves it through the installed runtime: arm A gives the true model and arm B the placeholder. The residual risk is a session that bypasses the adapter, which risk 28 covers | IP, P1, LV |
| 9 | A serve-start catalog refresh widens the pins | `modelSync: "disabled"` (C6b), plus the pin digest check at every session (P1 and C6) | C6b, C6 |
| 10 | PostgreSQL tests skip silently, or offline tests reach the network | The runner owns PostgreSQL and refuses a caller-supplied `FUSION_PG_TEST_SKIP` in every mode before any spawn. The runner itself sets the flag only in the child env of commands without `needsPostgres`, and the static skip policy refuses any literal `FUSION_PG_TEST_SKIP` in a test file listed under such a command (E1-2). Name lists are closed. Engine PG checks require `CCC_PG_URL_BASE` and 0 skipped. Every run sets `PI_OFFLINE=1` and the network guard (D50) | P0, all PG cards |
| 11 | The exact pins were only used through combos before | The PRE catalog read before W1, plus the three preflight lineages at the start of every run | PRE, C6 |
| 12 | M3 degeneracy (empty content, reasoning only) | Degenerate guard built from existing evidence, 3 dispatch attempts per lineage, then `blocked_provider` with a receipt | C6 |
| 13 | Compiler shape limits (series-parallel, one terminal) reject the plan | G4 refuses before any review spend, with diagnostics identical to the compiler's (B2 parity test). A repair chunk re-plans | B2, GG, ST2 |
| 14 | History-fold cost grows with Large runs | The fold is bounded per run and indexed. Large is not run in I2 | L1 |
| 15 | Pause latency during a long stage | `control_request` blocks every new planning reservation immediately. The latency is at most one in-flight session attempt (30 min watchdog). In Build, see risk 25 | L1, H1 |
| 16 | The preflight time-of-check gap (HEAD moves before import) | The intent records `targetHead`, and IB2 runs the baseline before the shared preflight. RECONCILE re-runs the preflight if HEAD moved. The disposable target has no other writers | IB2 |
| 17 | Stale canon or settings still name GLM 5.2 | The classifier refuses at G0 and at route admission. Stale docs are flagged, not rewritten | K1, K2 |
| 18 | The self-healing sweep of `.worktrees/` after cwd auto-registration | `--no-auto-register`, cwd set to the target, and the liveness parser refuses an `Auto-registered` line | IP |
| 19 | (Closed) The #103 rescue was unproven | R0p is DONE: strict ledger rc=1 at `589c293c7`, rc=0 at `a08af2c73`, 24/24 rescued tests with 0 skips on owned PostgreSQL, and a fresh strict re-check shows `total=0 expired=0` | R0p |
| 20 | A G7 rejection with no coding repair ends the live run `verification_failed` | An honest outcome, mapped by BF and declared NOT RUN. Repair arrives in I3 | RV, BF |
| 21 | The research fetch is controller egress, so DNS rebinding and redirect escapes are possible | HTTPS only, a fixed allowlist, an address blocklist at connect, per-run grants on the anchor. The preflight researcher's grant port refuses every fetch | C5, C6 |
| 22 | Import ceilings are below Build Large (12,288 calls; deadline above 24 h) | Clamps are recorded, never silent. Ceilings are raised in I3 | IB2 |
| 23 | Build adds a Fusion-owned baseline branch at B1 to the target and checks it out | It is allowed only on owned disposable targets in I2 (D24). The target's `main` stays at B0. Real repositories wait for qualification (I6) | AU4, VP |
| 24 | (Resolved by the leader's repair-count ruling, D13.) v2's literal inheritance gave a critic that re-reviews every chunk only 2 usable chunks of 4. Residual: review nodes raise the planning hard bound from 471 to 867 automatic calls, and repeated reviews spend more | Authors keep one counter (1 + 2 repairs); each fresh review of a new candidate version is a new review node with its own 3 attempts; the 4-chunk epoch is the global bound. 867 stays under the 1,536 allocation, and the repair-chunk fit check refuses a chunk earlier when the allocation runs low. L1 and ST2 test both rules on PostgreSQL | L1, ST2 |
| 25 | Build control: the processor holds the campaign item's lease for the whole graph (`workflow-work-processor.ts:196-214`), and the operator control refuses a leased item (`ccc-campaign-operator-control.ts:186-195`), so v2's bridge could never apply during `building` | Pause and resume during `importing` and `building` refuse with `CCC_PLANNING_COMMAND_NOT_SUPPORTED`, an I4 must-do in the acceptance tracker. Cancel uses the existing in-lease cancel, carried out by serve on its own store (CB applier, wired by WR): `control_request = 'cancel'` stops new linked writer and review reservations at once (`control-pending`), and the in-flight session ends when its abort is handled, at most one writer attempt (60 min watchdog). Residual: while serve is down, the cancel stays pending and `fn plan status` shows it | CB, WR, CL2 |
| 26 | The offline network guard is a JavaScript tripwire, not an OS boundary. A non-Node child (`git`, `curl`) or native code could bypass it | Nested `sandbox-exec` is impossible because the proof tests run it themselves. All fake models and servers are loopback, the guard reports every attempt and fails the run, and X1's real-sandbox probes cover the writer path. Darwin offline mode is the only full proof | P0 |
| 27 | BF's hook runs on every campaign work item transition | One indexed lookup on `ccc_planning_runs_import_unique`, returning `not-linked` for every unlinked campaign. The body runs in a savepoint and never throws (BF RED covers an injected SQL error). Unlinked regression suites run unchanged | BF |
| 28 | A planning or linked binding on a provider other than `defaultProvider` would silently stream through unpatched pi-ai without the receipt adapter (`pi.ts:3649-3651`) | P1 refuses such a binding at session creation (D48), and SF asserts every binding's provider equals `defaultProvider` | P1, SF |
| 29 | Workflow-selection routes can change a planning task's workflow, and they are guarded only by the dashboard guard | H1 checks the stored IR hash at every stage start and fails the run with `WORKFLOW_IR_DRIFT` | G1, H1 |
| 30 | The Linux Gate job takes longer | Only PostgreSQL-free, macOS-free planning suites run there, the step's time is measured at INT-1, and it is reported against the current Gate wall time | P0 |
| 31 | M3's tool behaviour is first seen at the LIVE preflight (challenge 19 deferred) | The preflight runs before any planning node and blocks with a `tool_fidelity_receipt`. Its worst cost is 9 calls. A needed role-table change is then a PRD amendment for Ryan | C6, LIVE |
| 32 | The runtime digest check requires a serve restart after any reinstall | H1, RV and BF refuse a mismatch with `RUNTIME_NOT_PERMITTED` rather than run unpermitted code. The section 4.2 procedure restarts serve after a reinstall | H1, LIVE |
| 33 | (New in v3) The leased cancel depends on the processor's existing cancel path and the per-store disposer registry, and H1 edits `workflow-work-processor.ts` | H1 must leave the cancel path (`:100-135`, `:381-430`) byte-identical (Appendix). CB's test runs a real processor holding the lease, and a second-store case proves the CLI process cannot carry out the cancel, which is why serve does | H1, CB, WR |
| 34 | (New in v3) G4's proof-command policy now mirrors the semantic-proof custody rules. If custody changes later, G4 could accept a plan that the importer refuses | G4 cites the custody lines it mirrors. The importer's custody check stays the last word: a refusal at IB2 step 2 ends `failed` / `CCC_PLANNING_GRAPH_INADMISSIBLE` before any writer spend, and O2 runs the whole path offline | GG, IB2, O2 |
| 35 | (New in v3) Writers own only `src/**` and `bin/**`, so no writer can fix a faulty verifier test during Build | G5 (VP) qualifies the verifier against defective controls before Build. A verifier fault found later ends `verification_failed` honestly, since coding repair is NOT RUN in I2 | VP, RV |
| 36 | (New in v3) The `writer-refused` event is written after the outer transaction rolls back, so a crash in between loses that event, and BF's mapping then reads the item failure as `CCC_PLANNING_CAMPAIGN_FAILED` instead of the cap code | The refusal is still thrown with all its fields, and the event is evidence, not state. Replaying the same reservation refuses again and writes the event under its deterministic id. The cost is a less specific failure code, never a wrong success | BF |
| 37 | (New in v3) The run-deadline check and the `maxDurationMs` clamp can end a Build before the campaign's own deadline would | Intended: the run deadline is the receipt's bound. The clamp is recorded in `admission_facts`, and a refusal maps to `budget_exhausted` / `CCC_PLANNING_DEADLINE` | IB2, BF |
| 38 | (New in v3) The linked writer toolset adds `fn_complete_phase`, a campaign control tool | It is the existing campaign ready tool that every campaign writer already gets (`executor.ts:19181-19187`, `ccc-campaign-ready.ts:883-900`). It is in the policy digest the receipt binds, and the preflight writer does not get it | K1, C2, WR |
| 39 | (New in v3.1, accepted residual risk, E1) The P0 skip-policy lexer can be fooled by a regex literal after `)` that contains `/*`, which can hide code | Accepted: inventory files are written by our own cards, not by Fusion's models | P0 |
| 40 | (New in v3.1, accepted residual risk, E1) P0 refuses any `skip:` or `todo:` key, even in data | Accepted: this fails closed | P0 |
| 41 | (New in v3.1, accepted residual risk, E1) X1 has no process-count limit | Accepted: a fork bomb shares the per-user limit, and the controller sweep stops processes before killing them (E1-18) | X1 |
| 42 | (New in v3.1, accepted residual risk, E1) `glm/glm-5.2:latest`-style forms are labelled `floating-alias`, not `excluded-model` | Accepted: they are still refused | K1 |
| 43 | (New in v3.1, declined, E2) No BEFORE DELETE trigger on the anchor, so an owner or bypass connection can still delete an anchor row | Declined as an accepted residual risk: owner and bypass connections are the trusted migration and startup paths, and the runtime role cannot delete (E1-15) | S0 |
| 44 | (New in v3.1 as conditional, E2-26(a); confirmed in v3.2 and moved here from the `confined-shell.ts` header, E4-X item 11) RLIMIT_CPU does not bound a command that makes a system call on every pass. X1's final repair measured a pure user loop stopped at about 2.0 s under `ulimit -t 2`, while a loop with a system call per pass was still running at 15-20 s | The wall ceiling (`wallMsCeiling`) is the binding bound, enforced by the controller's wall timer; RLIMIT_CPU stays as a secondary bound only | X1, X1c |
| 45 | (New in v3.2, accepted residual, E4 S0 verdict) The 0042 deadline CHECK tests only the text's shape, so an impossible date passes it and fails later as an untyped SQLSTATE 22008 | Accepted residual (E4 S0 verdict) (F10) | S0 |
| 46 | (New in v3.2, accepted residual, E4 S0 verdict) The Drizzle mirror of the deadline CHECK has no test | Accepted residual (E4 S0 verdict) (F10) | S0 |
| 47 | (New in v3.2, accepted residual, E4 S0 verdict) The 0043 guard casts `lease_expires_at` without first checking its format | Accepted residual (E4 S0 verdict) (F10) | S0 |
| 48 | (New in v3.2, accepted residual, E4-K item 6) Denied names match whole path segments only, so `.envrc.bak` is admitted | Accepted: K1b records it as a residual, not a RED | K1b |
| 49 | (New in v3.3, E6-X item 5) Bursts of `lsof` scans hit the 11 s capture limit while an unreachable smbfs Time Machine mount (`/Volumes/.timemachine/…`) is present on the I2 host, so a sweep can end unconfirmed for a reason unrelated to the command | X1c's repair measures lsof `-b`, `-e <mount>` for each network mount read from `mount` (smbfs, nfs, afpfs, webdav) and one bounded retry of a timed-out scan, and applies what removes the stall without weakening the E4-7 trust rule; a test proves the scan with the chosen flags still parses, lists the controller's pid and sees clone inodes. The stall rate before and after and the flags chosen are recorded in the X1c card header and here. The host is not changed: nothing is unmounted. A stall that remains fails closed as unconfirmed | X1c |
| 50 | (New in v3.3, E6-0) A cloned binary pays macOS's first-launch check, about 0.5-1.4 s per binary, which can eat a short model timeout | Not a repair item. SF and WR measure the cost on the I2 host before trusting short model timeouts, and report it | SF, WR |
| 51 | (New in v3.3, E6-0 and E6-B item 6) go-task runs Taskfile `cmds` in its own shell, so the `BASH_ENV` dispatcher, `command_not_found_handle` and bash's `exec` builtin never apply to package commands there; PATH changes and the missing pnpm and yarn wrappers are recorded residuals too | Recorded as an I3 prerequisite (section 3.3): verifier Taskfiles that run package scripts wrap them in `bash -c`, and VP or GG enforce that. I2 is unaffected, because its target runs `node --test` directly | VP, GG |
| 52 | (New in v3.4, E7 X1c residual) The writer-shell profile template digest binds function source text, so it differs between the vitest transform, tsc `dist` and each tsup bundle | A qualification receipt is valid only for the build that produced it: G0 records the digest of the build under test (section 2.13; section 2.18 step 11) | X1c, CL2 |
| 53 | (New in v3.4, E7 X1c residual) The confined wrapper sets `ulimit -t` and `ulimit -f` but not `ulimit -u`, so a confined fork bomb that exhausts the user's process limit makes the sweep's spawns fail with EAGAIN | The exec then refuses (fails closed) rather than reaping. A risk row, not a repair item (see risk 41) | X1c |
| 54 | (New in v3.4, E7 X1c residual) X1c chose lsof `-b` from the mechanism (lsof's mount-point stat, with its 15 s `-S` default, exceeds the 11 s capture limit), not from a measured stall; the smbfs mount was gone during repair 1, so the after-rate is inferred | Any stall still fails closed as unconfirmed (risk 49) | X1c |
| 55 | (New in v3.5, E8 K2 residual) `certificateApplies` trusts the array prototype: a hand-built in-memory array with an own `includes`, or a sparse array, passes | Unreachable through the qualification port, because data parsed from JSON cannot take either form; the I6 port that feeds real certificates parses JSON | K2, I6 |
| 56 | (New in v3.5, E8 K2 residual) G8 identities never call `roleOf`, so a G8 identity whose `taskId` is a writer or a G7 review id is admitted; the deadline row is pinned at 1 ms, not at the 1 µs timestamp resolution | IB2 builds a G8 identity only for the judge task; when `CccRouteRole` gains a G8 role, the card that adds it makes K2's admission refuse a G8 identity whose graph role is writer or g7-review (section 2.7; IB2 rule) | IB2 |
| 57 | (New in v3.5, E8-0 P1 residuals) A missing API key and a throw from an `onResponse` hook still settle `provider-error-event`, and P1's loopback test (c) (bind port 0, close it, dial it) has a small port-reuse race | Recorded, not fixed: both are local failures (no upstream effect for the first, an already-answered request for the second), and any retry stays inside the iteration and dispatch caps | P1 (closed) |

## Appendix: per-wave ownership check

The OWNED lists in section 3 were checked mechanically with `scratchpad/v2check/own.py` and `scratchpad/v2check/deps.py`, run over `design/CONTRACT-v3.md` itself, with brace lists expanded:
- 42 cards, including PRE, R0p and LIVE.
- **0 overlaps** of owned files within any wave.
- **0 dependency-order violations.** Every `Depends` names only cards in earlier waves.
- Every card except the parent-run PRE, R0p and LIVE has Objective, Owns, Depends, RED, Non-vacuous, Positive control, Check, Route and Review.
- v3 re-run on this file: 42 cards, 0 overlaps, 0 dependency-order violations. WR now also owns `workflow-graph-executor.ts` and BF one hunk of `provider-controller.ts`; WR depends on CB (W7) and CL2 on BF (W6). The SQL transition function in section 2.2 holds exactly 65 distinct pairs (`scratchpad/v3edit/pairs.py`), including `importing → budget_exhausted` and excluding `running → importing`.
- v3.1 re-run on this file (`scratchpad/contract-v3.1/own.txt`, `deps.txt`): 43 cards, 0 overlaps, 0 dependency-order violations, and no card missing a required field. The new card X1b (W3 in v3.1, the W1 residual since E4-B) owns four new files under `packages/engine/src/ccc-confinement/` and `packages/engine/src/__tests__/` plus `cards/x1b.mjs`; no other card owns any of them (E2; "four" corrected from "five" by E4-16). K1 now also owns `packages/core/tsconfig.ccc-planning-tests.json` (E2-48), and S0 `ccc-prd-import-migration.pg.test.ts` (E1-16) and `migration-stamping.ts` (E2-61).
- v3.2 re-run on this file (`scratchpad/contract-v3.2/own_check_v32.py`, output in `scratchpad/contract-v3.2/own.txt` and `deps.txt`): 45 cards. K1b and X1c are new, and X1b moved from W3 to the W1 residual. The W1 residual is checked as its own wave, W1r, which runs after W1 and alongside W2: ownership overlap is checked jointly across W1r and W2, and a dependency between W1r and W2 in either direction counts as a violation. Result: 0 same-wave overlaps and 0 dependency-order violations, and K1b, X1c and X1b have every required field. The files K1b shares with K1, and X1c with X1, are cross-wave successor ownership, listed below.
- v3.3 re-run on this file (`scratchpad/contract-v3.3/own_check_v33.py`, output in `scratchpad/contract-v3.3/own.txt` and `deps.txt`): 45 cards, the same model as v3.2 (W1r checked jointly with W2). The repair grants count as owned files of their card's wave: G1's three task-store files and P1's receipt adapter (E5), and X1c's helper-export grant on `ccc-campaign-proof-sandbox.ts` (E6-X item 7). GG now depends on K1b (F11), a W1r card before W7. Result: 0 same-wave overlaps and 0 dependency-order violations; the missing-field lines are the same as v3.2's (parent-run PRE, R0p, LIVE; RED-label variants X1, O1, O2) (E7-C N3).
- v3.4 re-run on this file (`scratchpad/contract-v3.3/own_check_v33.py`, reused unchanged; output in `scratchpad/contract-v3.4/own.txt` and `deps.txt`): 45 cards, the same model as v3.3 (W1r checked jointly with W2). The E7 grants count as owned files of their card's wave: L1's one-line grant on K1's `packages/core/src/ccc-planning/types.ts` (W2), and P1's `pi.ts` import block and widened receipt-adapter grant, both on files P1 already owns. Result: 0 same-wave overlaps and 0 dependency-order violations. One new cross-wave multi-owner file, `types.ts` (K1 in W1, then L1 in W2), is listed below. The missing-field lines are unchanged from v3.3 (parent-run PRE, R0p, LIVE; RED-label variants X1, O1, O2). No Depends line changes: BF already depends on L1 (for `completeCccPlanningCancellationWithin`), AD1 on L1 (for E7-L item 8(b)), and WR reaches P1 through C2 and H1 (for `attachCccProviderAttemptBoundRoute`). A regression run of the same script on v3.3 (`scratchpad/contract-v3.4/own-v33-regression.txt`) differs from this run only in L1's owned-file count (7 to 8) and the `types.ts` line.
- v3.5 re-run on this file (`scratchpad/contract-v3.5/own_check_v35.py`, copied from `own_check_v33.py` with the same model and a longer report: the Owns and Depends of every W3 card, C6's Depends, the W3 files owned by more than one W3 card, and the W3 cards that own `pi.ts`; output in `scratchpad/contract-v3.5/own.txt` and `deps.txt`): 48 cards, the 45 of v3.4 plus E8's P1z, X1z and L1z in W3, each with every required field. The three are successor owners across waves, which gives eleven new cross-wave multi-owner files, listed below: P1z owns the receipt adapter, the settlement test and `cards/p1.mjs` after P1 (W2); X1z owns `toolchain-discovery.ts`, both Darwin tests and `cards/x1b.mjs` after X1b (W1r); L1z owns `ccc-planning-ops.ts`, the control and ledger PostgreSQL tests and `cards/l1.mjs` after L1 (W2). Result: 0 same-wave overlaps and 0 dependency-order violations. Inside W3 no file has two owners, and C2 is the only W3 card that owns `pi.ts` (region (b)); P1z owns no `pi.ts` hunk. Every new Depends entry points to an earlier wave: SF (W4), CL2 and WR (W9) on X1z; C6 (W6) on P1z; BF (W6) on L1z; and P1z, X1z and L1z on P1, X1b and L1. The missing-field lines are unchanged from v3.4 (parent-run PRE, R0p, LIVE; RED-label variants X1, O1, O2). A regression run of the same script on v3.4 (`scratchpad/contract-v3.5/own-v34-regression.txt`) reports 45 cards, 0 overlaps and 0 violations, and the unchanged v3.3 script on v3.4 reproduces `scratchpad/contract-v3.4/own.txt` (E8 checks, task).

Files owned by more than one card are always in different waves, in this order:
- `packages/engine/src/pi.ts`: P1 in W2 (region a: `744-1149`, `3536-3545`, plus the `AgentOptions.cccProviderAttemptBinding` property line, about 2244, E5-P1, and the `@fusion/core` import block, lines 45-46, E7-0), then C2 in W3 (region b, located by content, E8-W3: the session tool assembly in `createFnAgent`; the line numbers `3698-3730`, `3847`, `4043-4160` are stale). P1z (W3) edits no `pi.ts` hunk (E8-P).
- `packages/engine/src/runtimes/in-process-runtime.ts`: H1 in W3, then WR in W9.
- `packages/cli/src/commands/plan.ts`: CL1 in W4, then CL2 in W9.
- `scripts/ccc-planning-live-proof.mjs` and `scripts/ccc-planning-installed-proof.mjs`: P0 in W1 (stubs that exit 1), then LV in W9.
- `packages/core/src/ccc-campaign/provider-controller.ts`: K1 in W1 (type-only views), then BF in W6 (the refusal catch hunk, item 48).
- `packages/core/src/ccc-planning/errors.ts` (append only), `packages/core/src/ccc-planning/schemas.ts`, `packages/core/src/__tests__/ccc-planning-{schemas,policy,artifacts}.test.ts` and `cards/k1.mjs`: K1 in W1 (accepted, no repairs left), then K1b in the W1 residual as successor owner (E4-K).
- `packages/engine/src/ccc-confinement/confined-shell.ts`, `packages/engine/src/__tests__/ccc-confined-shell.darwin.test.ts` and `cards/x1.mjs`: X1 in W1 (accepted, no repairs left), then X1c in the W1 residual as successor owner (E4-X).
- `packages/engine/src/ccc-campaign-proof-sandbox.ts`: X1 in W1 (helper exports), then X1c in the W1 residual under the same grant, helper exports only and no behaviour change (E6-X item 7).
- `packages/dashboard/src/routes/ccc-campaign-task-guard.ts`: G1 in W2, then the parent at INT-2d `fcb83879d`, which switched the guard to `isCccCustodyGuardedTask` (E5-G1 item 6; done, E8).
- `packages/core/src/ccc-planning/types.ts`: K1 in W1 (accepted, no repairs left), then L1 in W2, one line at about 214 that removes the `deferred-leased` literal (E7-0 grant).
- `packages/engine/src/ccc-route-receipt-adapter.ts`, `packages/engine/src/__tests__/ccc-planning-provider-settlement.test.ts` and `cards/p1.mjs`: P1 in W2 (lineage closed, integrated at INT-2d), then P1z in W3 as successor owner (E8-P; the adapter for processing and markers only).
- `packages/engine/src/ccc-confinement/toolchain-discovery.ts`, `packages/engine/src/__tests__/ccc-toolchain-discovery.darwin.test.ts`, `packages/engine/src/__tests__/ccc-shell-compat.darwin.test.ts` and `cards/x1b.mjs`: X1b in the W1 residual (lineage closed, integrated at INT-2d), then X1z in W3 as successor owner (E8-X).
- `packages/core/src/task-store/ccc-planning-ops.ts`, `packages/core/src/__tests__/postgres/ccc-planning-control.pg.test.ts`, `packages/core/src/__tests__/postgres/ccc-planning-ledger.pg.test.ts` and `cards/l1.mjs`: L1 in W2 (accepted, integrated at INT-2d), then L1z in W3 as successor owner (E8-L).

Files touched by exactly one card:
- `executor.ts`: WR only. G1 no longer touches it.
- `provider-attempt.ts` and `async-workflow-workitems.ts`: BF only.
- `ccc-campaign/types.ts`: K1 only (type-only).
- `workflow-graph-executor.ts`: WR only (W9, additive `nodeAttemptOrdinal`, item 18).
- `data-layer.ts`, `run-audit.ts` and `schema-applier.ts`: S0 only.
- `migration-stamping.ts`: S0 only (E2-61).
- `task-update.ts` and `async-persistence.ts`: G1 only.
- `ccc-campaign-routing.ts`: G1 only (a new export).
- `archive-lifecycle-2.ts` (custody checks only), `workflow-task-create-ops.ts` (inside `atomicWriteTaskJsonImpl2` only) and `project-store-ops.ts` (inside `atomicWriteTaskJsonWithAuditImpl` only): G1 only, granted for repair 1 (E5-G1).
- `ccc-route-receipt-adapter.ts`: moved to the multi-owner list above (P1 in W2, then P1z in W3; E8-P). Its grant covers E5-P1's error-event marker, E7-P item 1's transport marking and P1z's after-`[DONE]` and non-SSE markers (E8-0, confirmed).
- `prd.ts`: B3 only.
- `ccc-gate2-installed-runtime.mjs`: IP only.
- `pr-checks.yml` and `ci-workflow.test.ts`: P0 only.

Parent-owned between waves:
- the barrels: `packages/core/src/index.ts`, `packages/core/src/ccc-campaign/index.ts`, `packages/core/src/ccc-planning/index.ts` (new at INT-1, E2-80), `packages/core/src/postgres/schema/index.ts`, `packages/engine/src/ccc-prd/index.ts`, `packages/engine/src/ccc-planning/index.ts`;
- `packages/core/src/index.gate.ts`, which mirrors the core barrel's `export * from "./ccc-planning/index.js"` since INT-2a (E5);
- the engine barrel `packages/engine/src/index.ts`, for the `isCccCustodyGuardedTask` export at INT-2, and the INT-2 switch of the dashboard guard to it (E5-G1 item 6); both done at INT-2d (E8);
- at INT-2 (E7; done at INT-2d `fcb83879d`, E8): the core barrel `export *` of `task-store/ccc-planning-artifact-ops.js` and `task-store/ccc-planning-ops.js` in `index.ts` and `index.gate.ts` (L1's `completeCccPlanningCancellationWithin` and, through the same line, L1z's `transitionCccPlanningRunStateWithin`), and the engine barrel exports of P1's `CccProviderAttemptBoundRoute` and `attachCccProviderAttemptBoundRoute`;
- at INT-3 (E8 INT-3 barrel duty, editor's derivation): `export * from "./task-store/ccc-planning-admission-ops.js"` (AD1) in core `index.ts` and `index.gate.ts`;
- `stages/index.ts`;
- the CLI mock list.

The proof inventory `index.mjs` needs no per-card edit, because it loads `cards/*.mjs` by directory listing.

Never edited by any card:
- `self-healing.ts` and `merger.ts`, because of the line-pinned shellout allowlist;
- `0000_initial.sql` and `0006_project_ownership.sql`;
- `canonical.ts` and `importer.ts`;
- `ccc-campaign-operator-control.ts`, which CB calls and does not change;
- `task-move-disposer.ts`, which CB calls through `disposeTaskBeforeMove` and does not change. H1's edits to `workflow-work-processor.ts` must leave its cancel path (`:100-135`, `:381-430`) byte-identical, because CB's leased-cancel case depends on it;
- every vitest config. The R0p change to `packages/engine/vitest.config.ts` has already landed in `a08af2c73`.
