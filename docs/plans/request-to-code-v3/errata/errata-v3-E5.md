# CONTRACT errata E5: W2 round-1 verdicts and repair 1 for K2, L1, G1 and P1

Date: 2026-10-14. Binding on top of CONTRACT-v3.1, E3 and E4. Order of precedence: E5, then E4, then E3, then v3.1. If CONTRACT-v3.2 exists when you read this, v3.2 replaces v3.1, E3 and E4, and E5 still wins over it.

## Verdicts (round 1)

- **A1 at 1a758d644: ACCEPTED** (normal lane, fresh Opus reviewer). Cherry-picked onto integration as part of INT-2a. Recorded residuals:
  - no test pins the task-row FOR UPDATE;
  - the project-scoping test proves RLS, not the module's own predicate;
  - a replay under an operator fence does not re-check the fence, so callers must not read `replayed: true` as proof that `controlSeq` is current.
- **K2, L1, G1 and P1: REPAIR.** Repair 1 of 2 for each lineage. The required items are listed below. Each repair agent implements every item with a RED that fails on a behavioural assertion against the round-1 bytes, plus its positive control.
- **INT-2a** (parent) is on `agent/request-to-code-v3`, on top of INT-1b `ff4fc3e4f`. It contains:
  - A1;
  - `packages/core/src/index.gate.ts`, which now mirrors `export * from "./ccc-planning/index.js"`;
  - `packages/core/src/ccc-campaign/index.ts`, which now exports K1's view types: `CccProviderAttemptLimitReason`, `CccProviderAttemptRefusalReason`, `CccProviderAttemptRouteBindingView`, `CccProviderAttemptScopeView`, `CccProviderAttemptSettlementInputOf`, `CccProviderAttemptControllerView` and `CccProviderControllerDecisionView`.

  Each W2 leaf has been rebased onto INT-2a (E2-82).
- **Running in parallel, do not depend on them:** K1b (path-key fold change, one appended refusal code, verifier/control overlap refusal) and X1c (dispose result, narrowed factory seam). A W2 repair test must not depend on their current or future behaviour.
- **PostgreSQL rule, made explicit after a W2 incident.** Every test command that can reach PostgreSQL sets `FUSION_PG_TEST_URL_BASE` to your own disposable server, dashboard runs included. A run without it falls back to the shared `localhost:5432`, which is forbidden. (During W2 a builder left three `fusion_test_18636_*` databases there; the parent reports them and does not touch `:5432`.)

## E5-K2: card K2 repair 1 (opus, critical)

1. **Envelope remaining-calls guard.** `checkEnvelope` refuses `run.implementationCallsRemaining` that is not a non-negative safe integer: `ENVELOPE_MISMATCH` on field `run.implementationCallsRemaining`. REDs: NaN and undefined. Control: 3072 stays within.
2. **Literal member model.** Every member's `modelId` must equal the literal `"glm/glm-5.3-flash"`, and the envelope also refuses a receipt whose `models.glm53Flash` is not that literal. RED: a resealed receipt with `glm53Flash = glm/glm-5.3` and members on `glm/glm-5.3`.
3. **Route-kind allowlist.** In `route-admission.ts` `reasonFor`, the G8 branch is `else if (route.routeKind === "g8-judge")`, and any other kind returns `role-model-mismatch`. RED: an unknown kind is refused. Control: `g8-judge` is admitted.
4. **Run-to-receipt binding.** `checkEnvelope` requires:
   - `run.runId === cccPlanningRunId({ projectId: receipt.project.projectId, requestDigest: receipt.request.sha256, receiptSha256: input.receiptSha256 })` (K1 `policy.ts`);
   - `receipt.mode === "build"`;
   - `authorization.maxRequests <= receipt.phaseCallCaps.implementation`.

   The test fixture's `RUN_ID` is derived from the control receipt. REDs, each with a one-field control: another receipt's run id; a Spec receipt; `maxRequests` above the receipt cap. The test "or is not the receipt the run consumed" must actually exercise the binding. AD1 derives the run id the same way; v3.2 records this.
5. **Non-vacuity table.** Add one RED per guard that the round-1 mutants showed is unprotected, each built from the control with one field changed, with the control admitted.
   - Envelope: `now` before `notBefore`; zero members; `maxRequests` 0; a non-hex baseline commit; a receipt edited without resealing but with a matching `receiptSha256`; the changed path `proof/../src/index.mjs`.
   - Route admission: a G7 identity on a writer task; a G7 review of a review or of a non-writer; duplicate task ids; a pin with the wrong family or a malformed settings digest; a G8 judge with a non-null `reviewOfTaskId`.
   - Parse: a table-driven RED with one row per field check the adversary found unprotected. The rows are `notBefore < issuedAt`, `expiresAt <= notBefore`, `baseTree` format, distinct provider ids, quota, escalation, profile, `receiptId`, request `byteLength` and `sha256`, marker `sha256`, runtime and source-policy digests, the adapter literal, `largeAuthorized` type, operator `actorId`, `baseCommit` format, absolute `scratchRoot`, mode, `meteredFallback`, the release literal, and a duplicate admitted path.

   Re-run the mutation sets (the reviewers' scripts are under `scratchpad/review-k2/` and `scratchpad/adv-k2/`) and report each mutant killed.
6. **One provider per model.** Route admission refuses pins that give two models the same `providerId` (`provider-not-pinned`).
7. **Case-insensitive `.git` ban.** `isAdmittedFusionPathPattern` bans a `.git` segment case-insensitively, through K1's `cccPlanningPathComparisonKey` on each segment. RED: `.GIT/**`.
8. **Accepted round-1 deviations, no change:**
   - `CccCampaignProductRoute` is an alias of `CccCampaignProductExecutionRoute`;
   - `CccRouteRole` has no G8 value;
   - parse runs expiry and caps inside step 2.

   CL2's G0 step 6 refuses `budgetProfile: "large"` without `largeAuthorized` (`LARGE_NOT_AUTHORIZED`) and a profile other than `full-v2` (`PROFILE_NOT_SUPPORTED`); K2's parse refuses only malformed values. CL2 passes `now` in the canonical `…Z` form.

## E5-L1: card L1 repair 1 (opus, critical)

1. **Real race.**
   - Rewrite "two connections racing at spent = allocation - 1 admit exactly one" in this shape:
     - an admin transaction holds `SELECT 1 FROM project.ccc_planning_runs WHERE project_id=$1 AND run_id=$2 FOR UPDATE`;
     - both `admitCccPlanningDispatch` calls start;
     - a bounded loop polls `pg_stat_activity` (`datname = current_database() AND wait_event_type = 'Lock'`) until 2 waiters are seen;
     - then the admin transaction commits.
   - Assert:
     - 2 waiters were seen;
     - exactly one call was fulfilled;
     - the other was rejected as `CccProviderAttemptLimitError` with reason `phase-allocation`;
     - `planning_spent` is the allocation;
     - there are exactly 2 `call:reserved` events.
   - Show it fails with the anchor and fence locks removed, and with the spend CAS removed.
2. **Fence-kind test.** Before the review_proof-under-planning-fence probe, re-lease the planning work item: set state `running`, the fence owner, and a future `lease_expires_at`. Then only the kind check can refuse. Show that removing the kind check fails it.
3. **Lineage admission (ADV-1).** Inside the locked transaction, `admitCccPlanningDispatch` refuses, with a typed limit or route refusal, any `lineageId` that is not one of:
   - the fixed lineage for its stage and role (`${stage}:${role}`, `research:leaf-N` up to the leaf cap, `research:leaf-reviewer`, the preflight ids, `review:<semanticTaskId>`, `judge:final`);
   - a lineage recorded by a `ccc-planning:lineage:created` event for this run with the same role.

   `repair:k:*` and `*:rvk` lineages always need that event, and the lineage must match the stage. REDs: an unclaimed `repair:1`; an ordinal above `CCC_PLANNING_MAX_REPAIR_CHUNKS`; an unclaimed `:rvk`. Change the test helper that switched to an unclaimed stage to make a turn.
4. **Superseded lineages (ADV-8, ADV-9).** Once `claimCccPlanningRepairChunk` creates a lineage for a role, admit refuses new turn keys on every earlier lineage of that role. The claim refuses while any earlier lineage of the same role has a `reserved` or `dispatched_unknown` call (`UNRECONCILED_DISPATCH`). REDs: the ADV-8 and ADV-9 sequences.
5. **Pending control blocks transitions (ADV-11, ADV-12).**
   - While `control_request` is set, `transitionCccPlanningRunState` refuses with `CCC_PLANNING_CONTROL_PENDING` every transition except those to `paused`, `cancelling` or `cancelled`. This is a CAS predicate on the UPDATE (`AND (control_request IS NULL OR <target> IN (...))`), not a read-then-check.
   - REDs: the ADV-12 sequence (pause pending at `spec_ready`, then `spec_ready → importing` refused); a concurrency variant in which the pause commits between the caller's read and the transition.
   - Control: with no pending control, the transition succeeds.
6. **Unknown refusal reasons fail closed (ADV-2).** `settleCccPlanningCall` validates `refusalReason` against the 4-member union and refuses an unknown value with `CCC_PLANNING_INTERNAL_ERROR`, writing nothing.
7. **Database clock for lease liveness.** `completeCccPlanningCancellation` judges lease liveness with the database clock (`clock_timestamp()`), never with a caller-supplied `now`. RED: a caller `now` far in the future does not complete a cancellation while a live lease exists.
8. **One path to `cancelled` (ADV-10, D45).**
   - The generic `transitionCccPlanningRunState` refuses `→ cancelled` with `STATE_TRANSITION_REFUSED`; only `completeCccPlanningCancellation` reaches `cancelled`.
   - `completeCccPlanningCancellation` also refuses (`{completed:false}`, reason recorded) while any call of the run is `reserved` or `dispatched_unknown`, using code `CCC_PLANNING_DESCENDANTS_UNSETTLED` where a code is surfaced.
   - REDs for both.
9. **Epoch replay (ADV-5).** `recordCccPlanningReviewEpoch` treats a digest equal to any earlier epoch's digest for the same run and stage as a replay. It returns the existing epoch and records no new epoch or stagnation. RED: epoch 1's digest redelivered after epoch 2.
10. **Audit metadata bounds.**
    - `binding.lineageId`, `providerId` and other id strings are at most 256 characters.
    - Digests (`evidenceDigest`, `toolsetDigest`, `promptDigest`) are 64 lowercase hex.
    - `refusalReason` is in its union.
    - A violation refuses before any write: `CCC_PLANNING_INTERNAL_ERROR` for an internal caller, the existing actor rule for actors.
    - One RED per field class.
11. **Use A1's publisher.** `answerCccPlanningDecision` publishes the operator answer through card A1's publisher in `packages/core/src/task-store/ccc-planning-artifact-ops.ts`, now on the base, instead of its own INSERT and event. Existing answer tests stay green.
12. **No `deferred-leased`.** `requestCccPlanningControl` no longer produces `deferred-leased`; remove it from the outcome type.
13. **Keep as is, documented in a comment:**
    - the held→runnable `attempt + 1` (a stale holder's fence is refused);
    - a second cancel while one is pending gives `CONTROL_PENDING`.
14. **Optional.** If a non-superuser `fusion_runtime` test fixture exists (S0 uses one for its REVOKE tests), add one RLS case for `resolveCccPlanningRunProject`. Otherwise skip it and say so.

## E5-G1: card G1 repair 1 (opus, critical)

**Grants:**
- `packages/core/src/task-store/archive-lifecycle-2.ts`: custody checks only.
- `packages/core/src/task-store/workflow-task-create-ops.ts`: inside `atomicWriteTaskJsonImpl2` only.
- `packages/core/src/task-store/project-store-ops.ts`: inside `atomicWriteTaskJsonWithAuditImpl` only.

No other card owns these files now.

1. **Delete and archive on the PostgreSQL path.**
   - Call `assertCccPlanningTaskIdNotHeld(store.asyncLayer, id, "delete")` at the top of `deleteTaskBackendImpl`, inside the task lock and before the soft delete. This covers `deleteTask`, `deleteTaskIf` and direct callers.
   - Call it in `deleteTaskIfBackendImpl` before the predicate runs.
   - Add the archive equivalent in `archiveTaskBackendImpl`.
   - Remove the dead guard and its false comment at `archive-lifecycle.ts:349-350`.
   - RED: `store.deleteTaskIf(held, () => true)` throws `CccPlanningTaskCustodyError` with operation `delete`, and the row is unchanged. Control: the twin is soft-deleted.
2. **Snapshot-writer backstop.**
   - In both snapshot write primitives, inside their transaction, use the existing row they already read. When that row carries the K1 marker, an anchor row exists, and `changedColumns` includes any of `paused`, `userPaused`, `column`, `lineageId` or `deletedAt`, throw `CccPlanningTaskCustodyError`.
   - Ordinary tasks, those without the marker, pay no extra query.
   - REDs: `store.updateTaskDependencies(held, {operation:"add", dependency})` on a held `todo` task is refused and the row is unchanged; a direct snapshot write that changes `column` on a held task is refused.
   - Control: the twin moves to triage.
3. **Coverage of the guards already present.**
   - An anchored task whose marker is cleared is not held, and a move is allowed. This proves the marker half of the predicate matters.
   - `moveTaskIf` and `handoffToReview` on a held task are refused. This proves the in-lock guard in `moveTaskInternal`.
   - Removing the `task-update.ts` backstop (`assertCccPlanningCustodyPreserved`) fails some test. If it truly cannot be reached once item 2 exists, delete it and say why.
4. **Accepted design, recorded in v3.2:**
   - a planning task stays held while its marker is set, even after its run is terminal; no card releases it yet;
   - triage excludes any `ccc-plan:` lineage;
   - the dashboard guard checks the marker only, and passes requests through on not-found;
   - lookup failures return 500 with `CCC_TASK_CUSTODY_LOOKUP_FAILED`.

   Any later card that must change a held task's custody columns does so through a dedicated custody op, not through store writers.
5. **Not required:**
   - `batch-update-models` (not custody);
   - unbound-layer id collisions (legacy stores only).

   Note them in your report.
6. The engine barrel export of `isCccCustodyGuardedTask` and the dashboard switch to it are done by the parent at INT-2. Do not edit barrels.

## E5-P1: card P1 repair 1 (opus, critical)

**Grants:**
- `packages/engine/src/ccc-route-receipt-adapter.ts`: an additive structural marker on error events.
- `packages/engine/src/pi.ts`: the `AgentOptions.cccProviderAttemptBinding` property line (about 2244), plus region (a) as before.

1. **Refusal memory first.** In planning scopes, write the refused slot to `state.routeRefusals` before awaiting the settlement reconcile, then await it, then throw. RED: the fake reconcile persists the settlement and then rejects. A second `agent.stream()` still rejects with `CccProviderRouteReceiptError`, the distinct keys stay `["pi-stream:1"]`, and the provider is called once.
2. **The real abort shape.** Add a control: a provider stream that yields `{type:"error", reason:"aborted", …}` (the adapter's abort shape). It gets no reconcile, re-entry throws `/dispatched_unknown/` with keys `["pi-stream:1","pi-stream:1"]`, and the provider is called once. Show that changing the abort check to `if (planningScope)` fails it.
3. **D48 fails closed for linked writers.** Both `"planning"` and `"planning-linked-writer"` bindings without the bound-route marker are refused at session creation, and so is a bound provider that is not `options.defaultProvider`. REDs for both. Card BF must attach `CCC_PROVIDER_ATTEMPT_ROUTE_MARKER`; v3.2 records this.
4. **Receipt failure versus transport failure.**
   - The adapter sets an additive structural field on the error events it emits:
     - `cccRouteFailure: "receipt-missing" | "receipt-conflicting" | "receipt-incomplete" | "receipt-not-terminal"` for terminal-receipt failures;
     - `cccTransportFailure: true` for a terminated stream, socket reset, fetch failure or adapter timeout.
     - Upstream-reported errors (an HTTP status from the provider, or `finish_reason` error) carry neither field.
   - In planning scopes, P1 handles them as follows:
     - **receipt failure:** a route refusal. Settle once as proved_failed with `receipt-missing`, or `receipt-mismatch` when a conflicting or observed receipt exists. Record it in `routeRefusals`, throw `CccProviderRouteReceiptError`, and do not advance.
     - **transport failure:** no settlement, so the attempt stays `dispatched_unknown`. This settles the §2.12 lost-connection rule.
     - **upstream error:** `provider-error-event`, and advance.
   - REDs through the real `streamCccTerminalRouteReceipt` against a loopback SSE server the test owns, on port 0:
     - missing, conflicting and incomplete receipts each give keys `["pi-stream:1"]` and exactly one upstream request;
     - a socket destroyed mid-stream gives no reconcile, and re-entry holds with keys `["pi-stream:1","pi-stream:1"]`;
     - control: an HTTP 500 from the upstream settles `provider-error-event` and advances to `pi-stream:2`.
   - Keep the adapter's existing tests green. Find them with rg and run them as regression.
5. **Binding types usable without casts.** Type `AgentOptions.cccProviderAttemptBinding` and `AgentRuntimeOptions.cccProviderAttemptBinding` as `CccProviderAttemptBinding<CccProviderAttemptScopeView>`, and keep the alias default for campaign code. Add a type-only test that passes the factory's binding to `createFnAgent` options and to `AgentRuntimeOptions` with no cast, and remove the `as any` casts from the P1 tests where this makes them unnecessary.
6. **One definition of the view types.** Replace the copies in `agent-runtime.ts` with imports of K1's view types from `@fusion/core` (exported at INT-2a). Keep or simplify the `Same<>` test.
7. **No campaign semantics for a planning controller.** Refuse a permit or hold scope whose `scope.binding.scopeKind` is `planning` or `planning-linked-writer` when the session binding's `scopeKind` does not match. RED: a hand-built binding without `scopeKind` around a planning controller.
8. **Confinement shape.** When the tool policy allows `bash`, `cccConfinement.bash` must be an object with an `exec` function, and `cccConfinement.fs` is shape-checked. RED: `{}`, and an object with no `bash` key.
9. **Tool policy matches the binding.** `validateCccSessionToolPolicy`:
   - compares `allowedTools` with K1's `cccPlanningSessionToolNames(roleClass, scopeKind, probe)`;
   - requires `deniedNames ⊇ CCC_PLANNING_DENIED_NAMES`;
   - requires the policy's `toolsetDigest` to equal the route binding's;
   - requires the policy's role class to equal the binding's.

   One RED each. Fix the fixtures that paired mismatched digests.
10. **Keep the observed receipt.** A provider-error refusal's evidence keeps the observed `omniRoute` receipt when the event carries one.
11. **Accepted:** `effective-route-drift` is unreachable in planning scope, so there is no drift branch. Document it in a comment.
12. **Dispose type (E4-9, E6-0).**
    - In `agent-runtime.ts`, type `CccConfinement.bash` structurally as `(BashOperations & { dispose(): Promise<Readonly<{ closure: "confirmed" | "unconfirmed" }>> }) | null`.
    - When the tool policy allows `bash`, item 8's runtime shape check also requires `dispose` to be a function.
    - Use no import from X1c.
