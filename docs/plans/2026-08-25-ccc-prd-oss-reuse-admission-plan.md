# CCC PRD Open-Source Reuse Admission Implementation Plan

## Goal

Implement and prove the design in `docs/plans/2026-08-25-ccc-prd-oss-reuse-admission-design.md` as pure public source-and-test contracts. Completion means the parser, canonical digest, and evaluator pass targeted tests, package typechecks/builds pass, the canonical repository gate passes, the combined diff is reviewed, and the isolated worktree is clean after coherent commits.

## Preconditions

- Baseline commit: `05955137886c88f71cc475251ff1df2da2dfaf44`.
- Branch: `codex/oss-base-admission`.
- Worktree: `/Users/ryanpappal/03_CODE/ccc-fusion-worktrees/oss-base-admission/ccc-fusion`.
- The active R1 worktree and all runtime/provider/database state are outside this task's ownership.
- Dependency hydration was performed only in this worktree with `pnpm install --offline --frozen-lockfile --ignore-scripts`.
- Baseline targeted Vitest proof passed for `packages/engine/src/__tests__/ccc-prd-lane-classifier.test.ts` with 8 tests.

## Findings

- `packages/core/src/ccc-prd/contract.ts` already owns canonical CCC PRD JSON and deterministic SHA-256 helpers; the new contract reuses `canonicalCccPrdJson` rather than inventing another serializer.
- `packages/core/src/ccc-prd/index.ts` and `packages/engine/src/ccc-prd/index.ts` are the established public package export seams.
- Live GitHub research belongs to engine research providers; the admission evaluator therefore consumes evidence and owns no discovery transport.
- The repository's canonical deep gate is `task verify`; `task ci` separately reproduces the PR gate, while package typecheck/build and targeted Vitest give the narrow proof.

## Durable Mode Packet

- Plan Path: `docs/plans/2026-08-25-ccc-prd-oss-reuse-admission-plan.md`
- Findings Path: `docs/plans/2026-08-25-ccc-prd-oss-reuse-admission-design.md`
- Recovery Rule: after compaction or session replacement, reread both files before editing; update the checkpoint ledger in this plan rather than creating a parallel scratch plan.
- Resume/Handoff Rule: a fresh executor starts from this plan, verifies the recorded branch/worktree/baseline, and resumes from the first incomplete checkpoint without touching R1 or model-admission worktrees.

## File Map

- Add `packages/core/src/ccc-prd/oss-reuse-contract.ts`.
- Add `packages/core/src/__tests__/ccc-prd-oss-reuse-contract.test.ts`.
- Add `packages/engine/src/ccc-prd/oss-reuse-admission.ts`.
- Add `packages/engine/src/__tests__/ccc-prd-oss-reuse-admission.test.ts`.
- Add exports to `packages/core/src/ccc-prd/index.ts` and `packages/engine/src/ccc-prd/index.ts`.
- Add operator/developer documentation at `docs/ccc-prd-oss-reuse-admission.md`.
- Keep all provider, controller, database, importer, workflow runtime, and R1 orchestration files untouched.

## Task Map

### Task 1: Freeze and validate design/plan

- Surfaces: the two `docs/plans/2026-08-25-ccc-prd-oss-reuse-admission-*.md` files.
- Steps:
  1. Compute exact SHA-256 values for both artifacts.
  2. Run independent Luna read-only contract/test reviews and record requested/effective model evidence.
  3. Run AGY adversarial review against the exact files, adjudicate every material finding, repair the artifacts, and run one closure review if bytes change materially.
  4. Validate Markdown structure and `git diff --check`.
- Verification: `shasum -a 256 docs/plans/2026-08-25-ccc-prd-oss-reuse-admission-design.md docs/plans/2026-08-25-ccc-prd-oss-reuse-admission-plan.md && git diff --check`.
- Done when: no unresolved blocker remains and the checkpoint records exact reviewed hashes.

### Task 2: Core evidence contract, RED -> GREEN -> REFACTOR

- Surfaces: `packages/core/src/ccc-prd/oss-reuse-contract.ts`, `packages/core/src/__tests__/ccc-prd-oss-reuse-contract.test.ts`, `packages/core/src/ccc-prd/index.ts`.
- RED:
  1. Import the existing `@fusion/core` public barrel through a typed contract view and add an assertion that `parseCccPrdOssReuseEvidence` is a function; this executes against the real package and fails as an assertion while the export is absent, without a missing-module crash.
  2. After that first valid RED, add one public-behavior test at a time for strict schema/keys, deeply frozen normalized output, stable semantic ordering/digest, digest drift, exact-path errors, bounded package capability, cost basis/confidence, and set relationships.
  3. Include the failure probe where one code-reuse hard gate is `unknown` and prove the parsed packet preserves that unknown state for fail-closed evaluation.
  4. Run `pnpm --filter @fusion/core exec vitest run src/__tests__/ccc-prd-oss-reuse-contract.test.ts --reporter=verbose`; each intended RED is an executed assertion failure for the next missing behavior.
- GREEN: implement the smallest strict parser, canonical projection, digest helper, error type, policy constant, and public export that make the same command pass.
- REFACTOR: remove parser duplication, preserve exact error paths, freeze nested arrays/objects, and rerun the same suite plus `pnpm --filter @fusion/core typecheck`.
- Done when: RED, GREEN, and REFACTOR outputs are recorded and core typecheck passes.

### Task 3: Engine evaluator, RED -> GREEN -> REFACTOR

- Surfaces: `packages/engine/src/ccc-prd/oss-reuse-admission.ts`, `packages/engine/src/__tests__/ccc-prd-oss-reuse-admission.test.ts`, `packages/engine/src/ccc-prd/index.ts`.
- RED:
  1. Import the existing `@fusion/engine` public barrel through a typed contract view and assert that `evaluateCccPrdOssReuseAdmission` is a function; this creates an executed assertion RED without a missing-module crash.
  2. After that first valid RED, add table-driven tests one behavior at a time for evidence-derived project classification, established-project application-base rejection, incomplete discovery, missing controls, unknown/failed hard gates, architecture conflicts, recomputed cost receipts and ties, deterministic candidate ordering, close/partial/scratch outcomes, package selection, reference-only recording, and exact next-smallest-evidence messages.
  3. Include the failure probe where a strong functional match costs at least as much as scratch and prove it returns `scratch_build`.
  4. Run `pnpm --filter @fusion/engine exec vitest run src/__tests__/ccc-prd-oss-reuse-admission.test.ts --project=engine-default --reporter=verbose`; each intended RED is an executed assertion failure for the next missing behavior.
- GREEN: implement the ordered pure evaluator and public export without network, filesystem, database, provider, or runtime access.
- REFACTOR: extract small decision helpers, preserve reason ordering and tie-breaking, and rerun the same suite plus `pnpm --filter @fusion/engine typecheck`.
- Done when: RED, GREEN, and REFACTOR outputs are recorded and engine typecheck passes.

### Task 4: Documentation and combined targeted proof

- Surfaces: `docs/ccc-prd-oss-reuse-admission.md` and all new public exports.
- Steps:
  1. Document project-mode classification, GitHub-search eligibility, hard gates, candidate ranking, package boundary, evidence collection boundary, and later wiring surfaces.
  2. State explicitly that source/test implementation is not installed, runtime-loaded, live-searching, or automatically forking anything.
  3. Run both targeted package commands in sequence, preserving each package's Vitest configuration.
- Verification:
  - `pnpm --filter @fusion/core exec vitest run src/__tests__/ccc-prd-oss-reuse-contract.test.ts --silent=passed-only --reporter=dot`
  - `pnpm --filter @fusion/engine exec vitest run src/__tests__/ccc-prd-oss-reuse-admission.test.ts --project=engine-default --silent=passed-only --reporter=dot`
- Done when: both suites pass together and docs match the exported API.

### Task 5: Independent implementation review and repair

- Surfaces: complete diff against baseline `05955137886c88f71cc475251ff1df2da2dfaf44`.
- Steps:
  1. Run a read-only Luna test review and an AGY adversarial review against the exact diff.
  2. Adjudicate findings as adopt, reject, defer, or investigate with direct file/test evidence.
  3. Repair accepted findings through a new RED -> GREEN -> REFACTOR cycle when behavior changes.
  4. Re-run targeted suites and package typechecks.
- Verification: `git diff --check && git diff --stat 05955137886c88f71cc475251ff1df2da2dfaf44...HEAD` plus the targeted commands above.
- Done when: no material blocker remains and reviewer route provenance is recorded honestly.

### Task 6: Canonical proof, diff review, and clean commits

- Steps:
  1. Run `task verify` with a realistic timeout.
  2. Run `task ci` because the repository documents that it covers PR-gate checks absent from `task verify`.
  3. Run `git diff --check`, inspect every changed path and the complete branch diff against the baseline, and compare changed paths with commits added to `agent/r1-qe-runner` after the baseline.
  4. Stage exact paths only and create coherent commits; never use `git add .` or `git add -A`.
  5. Confirm `git status --short --branch` is clean.
- Done when: targeted proof, canonical gates, diff review, conflict check, and worktree cleanliness are fresh and successful; otherwise report `PARTIAL`, `FAIL`, or `UNVERIFIED`.

## Checkpoint Ledger

- 2026-08-25 — Isolated branch/worktree created at exact baseline `05955137886c88f71cc475251ff1df2da2dfaf44`; clean status proven.
- 2026-08-25 — Local dependencies hydrated offline with install scripts disabled; R1 dependencies and runtime untouched.
- 2026-08-25 — Baseline engine Vitest lane proof: 1 file, 8 tests passed.
- 2026-08-25 — Requested Luna review route could not expose an effective model receipt and is recorded as `ROUTE_UNAVAILABLE`; its read-only findings were treated as advisory only.
- 2026-08-25 — AGY exact-artifact review initially rejected five major and three minor ambiguities. All eight were repaired; closure review using `gemini-3.7-flash-high` returned `ACCEPT`, with two minor follow-ups (uniform cost horizon and explicit result interfaces) applied.
- Task 2 core contract: pending.
- Task 3 engine evaluator: pending.
- Task 4 combined documentation/proof: pending.
- Task 5 independent implementation review: pending.
- Task 6 canonical closeout: pending.

## Remaining Risks

- Human- or model-authored ownership-cost estimates can still be wrong; v1 makes their basis and confidence explicit but does not independently generate them.
- License compatibility remains an upstream legal/policy judgment; v1 records and enforces that judgment but does not practice law or infer compatibility from SPDX text.
- No live GitHub search, static scanner, sandbox pilot, or PRD compiler wiring exists in this phase; later adapters must be separately designed, permissioned, and proved.
- The active R1 branch may advance during implementation; final path-overlap review is required, but this branch will not automatically absorb those commits.

## Explicitly Out Of Scope

Controller-forced actions, automatic repository forking, clone/install/build execution, provider calls, PostgreSQL changes, live campaign wiring, push, PR creation, merge, publication, and runtime installation are out of scope.
