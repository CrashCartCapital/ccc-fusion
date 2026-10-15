# Errata E12: GG lineage closed, re-plan card GGz

Date: 2026-10-14. Precedence: E12 > E11 > E10 > E9 > v3.5.

## Verdict

- **GG lineage: CLOSED and integrated** at 1ee8b3bf8 (local integration picks 73102d1a8, a498e07e1 and 474c6d0bb on top of INT-3a ba52f2f92).
  - Repair 2 review: ACCEPT.
  - Repair 2 adversary: REPAIR, with three new importer-parity gaps.
  - Under the lineage rule (1 build + 2 repairs), the leader re-plans the residuals as card GGz with a fresh lineage.
- **Why GG still integrates:** none of the adversary findings is a regression. Each one is a further check G4 must mirror, of the same class as E11. Two fail open (G4 admits what the importer refuses, so review spend is wasted, but the importer still refuses). One fails closed (an over-refusal).

## Card GGz: G4 importer and custody parity, residuals

- **Base:** the local integration tip 474c6d0bb (INT-3a + GG). Worktree r2c-ggz, branch agent/r2c-ggz.
- **Route and review:** Opus. Critical lane: a fresh Opus reviewer plus a fresh Opus adversary.
- **Depends:** GG, IB1, B2, B3. GGz must be accepted before W8 (IB2) and before the I2 live slice.
- **Owns** (successor owner of GG's G4 files):
  - `packages/engine/src/ccc-planning/gates.ts`
  - `packages/engine/src/ccc-planning/graph-gate.ts`
  - `packages/engine/src/ccc-planning/proof-command-policy.ts`
  - `packages/engine/src/__tests__/ccc-planning-graph-gate.test.ts`
  - `packages/engine/src/__tests__/ccc-planning-schedule-and-commands.test.ts`
  - new: `packages/engine/src/__tests__/ccc-planning-g4-importer-parity.test.ts`
  - `scripts/lib/ccc-planning-proof-inventory/cards/gg.mjs` (successor owner; add the new file's names)
- **Central promise (section 2.17), in both directions:**
  - A plan G4 admits is never refused later by the importer: execution-policy parse, `assertCccPrdImportBundle`, the semantic proof plan, the custody check or Taskfile verification.
  - G4 never refuses a plan the importer admits.

### RED items (each with its control, each pinned against the REAL importer or custody function it mirrors)

1. **Closure paths git cannot address literally.**
   - Refuse any verifier closure path whose first character is `:`, since git pathspec magic makes custody's `git ls-tree` miss it (semantic-proof-custody.ts:150, :167). Refuse it as `CCC_PLANNING_GRAPH_INADMISSIBLE` under a closure-path rule.
   - RED: `:data.json`. Control: `fixtures:x/words.txt`.
   - Pin both against the real custody hydration on a temp git repo the test creates and removes, if that runs in under about 2 s. Otherwise cite :150 and :167 in the FNXC and pin against `git ls-tree` directly.
2. **Import entity ids.**
   - Apply the importer's `ENTITY_ID_PATTERN` (import-admission.ts:22, :113-125) to every dependency-edge id and to the `IMPORT-EDGE-<id>` intent id it implies, including the length limit with the prefix.
   - As defense in depth, apply the same rule to every task id and any other id that IB1 turns into an import entity or intent.
   - RED: edge `T2->T1`. Control: `E-T2-T1`. Both are pinned against the real `assertCccPrdImportBundle`.
3. **Shared-proof over-refusal.**
   - Replace `candidate-in-own-write-roots` with the custody rule restricted to the proof's own tasks: each candidate input lies, by exact spelling, inside the `ownedPaths` or `allowedWriteRoots` of at least one task that runs the proof. Correct the false FNXC comment (custody runs once per proof against every route's write roots: importer.ts:1509-1517).
   - Also require every task to name at least one task-phase proof that no other task names, mirroring importer.ts:742-748, with an exact refusal.
   - REDs and controls:
     - (B) a `stats` proof shared by T2 and T3, each with its own proof as well: admitted.
     - (C) GG's "write root inside an owned directory" control, with IB1-built candidates: admitted.
     - A task whose only proof is shared: refused.
   - Pin all of these against the real `parseCccCampaignProductExecutionPolicy` and the importer's proof-plan rule.
4. **Proof-graph parity** (adversary note, adopted). Mirror `semanticV2WorkflowProofPlan` (importer.ts:660-762) in G4, so a single-owner proof whose requirementIds include another task's requirement is refused before review spend.
   - RED: that case. Control: the same proof with only its own task's requirements.
5. **Relative admitted write roots** (reviewer note, adopted fail-closed). G4 refuses a non-absolute admitted write root as `CCC_PLANNING_GRAPH_INADMISSIBLE`, because the importer resolves it against its own working directory.
   - RED: `src`. Control: `<target>/src`.
6. **IB1 parity fixtures.** The graph-gate and proof-command fixtures must build proposal proofs the way IB1 does (phases, candidateInputs and clauseIds as `proposal.ts` builds them, ideally through IB1's real builder now that both are integrated). Keep any hand-built fixture only where a test needs a shape IB1 cannot produce, and say so in the test.
7. **De-duplicate the source paths (E9-4).** Derive `CCC_PLANNING_G4_SOURCE_PATHS` from IB1's `CCC_PLANNING_PACKET_SOURCES` (packet.ts:29-33). Keep the exported name and add a pin that the two agree.

- **Non-vacuous:** each RED fails on 474c6d0bb bytes on a behavioural assertion, and each mirrored rule is pinned so that deleting it from G4 fails a test.
- **Check:** `FUSION_PG_TEST_SKIP=1 PI_OFFLINE=1 pnpm --filter @fusion/engine exec vitest run --project=engine-default src/__tests__/ccc-planning-source-fidelity.test.ts src/__tests__/ccc-planning-graph-gate.test.ts src/__tests__/ccc-planning-objections.test.ts src/__tests__/ccc-planning-schedule-and-commands.test.ts src/__tests__/ccc-planning-g4-importer-parity.test.ts --silent=passed-only --reporter=dot`
- **Regression:** the B2 graph-admission tests (`cards/b2.mjs`) and the IB1 proposal test (`cards/ib1.mjs`), unchanged.
- **Accepted residual, not a GGz item:** a task id IB1's packet already refuses (SHORT_ID) is only defense in depth (item 2 covers it).
