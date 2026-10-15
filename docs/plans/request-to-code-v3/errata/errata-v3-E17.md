# Errata E17: H1 lineage closed, re-plan card H1z

Date: 2026-10-15. Precedence: E17 > E16 > E15 > E14 > E13 > E12 > E11 > E10 > E9 > v3.5.

## Verdict

- **H1 lineage: CLOSED and integrated** at b13f33e87 (local INT-3c picks 0245e499d, 1c2dd8900, 299a7dbc3).
  - Repair 2 review: ACCEPT.
  - Repair 2 adversary: REPAIR, one finding, reproduced on real PostgreSQL.
  - Under the lineage rule, the residual is re-planned as card H1z with a fresh lineage.
- **Why H1 still integrates.** The finding is a race in the held branch that existed before repair 2 and was not introduced by it. Repair 2 closed all seven E14 items with REDs and killed mutants. The check passes 90/90 and the regression passes 607/607.
- **SF is not blocked by H1z.** SF depends on H1's frozen ports (`ports.ts`), which H1z does not own.

## Card H1z: host residuals after H1

- **Base:** the local INT-3c tip that carries H1. Worktree r2c-h1z, branch agent/r2c-h1z.
- **Route and review:** Opus. Critical lane: a fresh Opus reviewer plus a fresh Opus adversary.
- **Depends:** H1, L1, L1z.
- **Owns** (successor owner of H1's processor and controller files; `ports.ts` stays frozen and is not owned):
  - `packages/engine/src/workflow-work-processor.ts`
  - `packages/engine/src/runtimes/in-process-runtime.ts` (planning hunks only)
  - `packages/engine/src/ccc-planning/controller.ts`
  - `packages/engine/src/ccc-planning/recovery.ts`
  - `packages/engine/src/__tests__/ccc-planning-host.test.ts`
  - `packages/engine/src/__tests__/ccc-planning-host.real-pg.test.ts`
  - `scripts/lib/ccc-planning-proof-inventory/cards/h1.mjs` (successor owner; add the new names)
- **Check:** the H1 check command (`ccc-planning-host.test.ts`, `ccc-planning-host.real-pg.test.ts` and `workflow-work-processor.test.ts`, engine-default, on an owned server).
- **Regression:** the H1 regression set (`workflow-*.test.ts`, `in-process-runtime*.test.ts`, `engine-no-blocking-shellout.test.ts`), unchanged.

### Items

Each item has a RED that fails on the INT-3c bytes on a behavioural assertion, and a positive control.

1. **No held item behind a startable run** (adversary 3, blocking; reproduced in scratchpad/adv3-h1, `copy/packages/engine/src/__tests__/adv3-h1.real-pg.test.ts`, cases Y1, Y2 and Y3).
   - After the held write succeeds and the quiet cancellation completion has run, `holdWorkItem` reads the run back through the ledger's `inspectCccPlanningRun`.
   - If the run is startable again for its mode (as `STARTABLE_STATES` has them), the item moves `held → runnable`, with the same effect as L1's requeue on resume and answer: attempt + 1, lease cleared, blocked reason cleared. The move is a CAS on `state = held` and the same attempt.
   - The move uses L1's exported requeue operation if one exists, otherwise an existing core work-item transition. Never direct SQL from the engine.
   - If the read-back throws, the item is released to `runnable` (the RED 16b rule).
   - REDs on real PostgreSQL:
     - Y1: a resume races a blocked park.
     - Y2: an answer races an awaiting_intent park.

     In each, the run continues, a later cancel is applied, and nothing is stranded.
   - Control: Y3. The same answer sent after the held write requeues as today.
2. **A planning item never ends `succeeded` behind a run outside its mode's expected end** (review 3 note, adversary 3 X8; adopted fail-closed).
   - In `concludeCompletion`, a Spec run must be at `spec_ready` (or terminal). A Build run must be past importing (`awaiting_execution_authority`, `building`, or terminal), or at an operator-wait state reached through the ledger.
   - Any other state concludes the run `failed` / `CCC_PLANNING_INTERNAL_ERROR` before the item is written.
   - RED: a Build run whose import stage leaves it at `spec_ready`.
   - Control: a Build run that reaches `awaiting_execution_authority` succeeds the item.
3. **Reclaim after import succeeds the item** (review 3 PROBE D).
   - On claim, a Build run whose `import_id` is set, or whose state is `awaiting_execution_authority` or `building`, has finished its planning stages. The item is written `succeeded`; it is not held by `restAt`.
   - RED: the import stage moves the run to `awaiting_execution_authority`, then the succeeded write fails once. The reclaim ends the item `succeeded` and the run is unchanged.
   - Control: a reclaim of a Build run still at `running` resumes its stages.
4. **The D40 watchdog does not leak on a synchronous throw** (adversary 3 note).
   - When `factory.open()` throws synchronously, the 30-minute timer and the abort listener are cleared.
   - RED: a spy on clearTimeout, or on the listener count, after a synchronous throw.
5. **Pins** (review 3 notes). Each pin kills a named surviving mutant.
   - (a) A store without `renewWorkflowWorkItemLease` concludes the run, as H1 claims (mutant I1-unwired-renew-fail-item).
   - (b) Stage-start check order: with both a runtime-digest drift and an IR-hash drift, the refusal is the digest (`CCC_PLANNING_RUNTIME_NOT_PERMITTED`).
   - (c) Blocked and rejected state codes:
     - If K1 or L1 exports the section 2.3 per-state code list, a park whose code is not in its state's list maps to `CCC_PLANNING_INTERNAL_ERROR`, as an invalid rejected code already does.
     - If no such list is exported, report that, and do not invent one.

### Recorded, not H1z items

- The drain's planning query has no LIMIT on each pass. Bounding it needs a core filter (run_id prefix `ccc-plan:`), which belongs to a core card.
- `releaseUnconcluded` has no retryAfter backoff. A deterministic L1 error loops at the drain cadence and adds one lease audit row per claim. Recorded for a later card; no new timing constant is invented here.
- The runtime digest is computed at the first `start()`, not at module load.
- Engine-start recovery runs only when `engineInstanceId` is set.
- L1's `STATE_CODE_REQUIRED` omits `awaiting_intent` (from E14). This belongs to the next core planning card.
