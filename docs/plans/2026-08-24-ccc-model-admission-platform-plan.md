# CCC Model-Admission Platform Implementation Plan

## Goal

Build the first source-and-test implementation of CCC-Fusion's provider-neutral model-admission and boundary-diagnostic contracts without touching any live provider, campaign, controller, database, approval, or R1 runtime surface.

Success means:

- one strict, versioned, immutable capability profile can be parsed, canonically serialized, SHA-256 digested, and refused when a campaign-critical capability is `unknown`;
- one privacy-safe telemetry envelope can compare sensitive payload equality by keyed HMAC without serializing payload bytes, and its transition validator fails closed on false terminal success, repeated terminal/closure events, unresolved dispatch, and handoff before closure;
- one deterministic evaluator returns `admitted`, `rejected`, or `insufficient_evidence` with exact reasons and the smallest next probe under the stated 10/10, 30-arm, and five-task policy;
- the three public contracts are exported through the existing package index pattern, documented, and proven by targeted Vitest, package typecheck/build, `task verify`, `git diff --check`, branch-diff review, and clean committed status;
- the code contains no MiniMax-, Gemini-, alias-, or provider-name inference and leaves clear data-driven seams for MiniMax M3, Gemini Flash, and later models.

Controller-forced termination is explicitly out of scope. This phase records and evaluates evidence only; it does not terminate, replay, resume, or control a live model session.

## Preconditions and Findings

- Plan Path: `docs/plans/2026-08-24-ccc-model-admission-platform-plan.md`
- Findings Path: none; verified Git and repository facts are recorded in this plan's checkpoint ledger.
- Recovery Rule: after compaction, session replacement, or resume, reread this plan before executing another step and update only the checkpoint ledger here.
- Resume/Handoff Rule: a fresh owner starts with this plan, confirms the branch/worktree/HEAD and R1 boundary again, then resumes from the first incomplete checkpoint. No parallel scratch handoff may replace this plan.
- Exact baseline: `67a123b2a50953c42809617890b56d36b8d100f3`.
- Branch: `codex/model-admission-platform`.
- Worktree: `/Users/ryanpappal/03_CODE/ccc-fusion-worktrees/model-admission-platform/ccc-fusion`.
- `agent/r1-qe-runner` was verified at the same baseline with dirty in-flight work; it remains unowned and read-only.
- The repository's canonical deep local acceptance gate is `task verify`, a thin wrapper over `pnpm verify:workspace`.
- This task is authorized to run tests and builds but not dependency installation, provider calls, runtime wiring, pushes, PRs, merges, or releases.

## Exact Ownership Boundary

Owned writes are limited to:

- `docs/plans/2026-08-24-ccc-model-admission-platform-plan.md`
- `docs/model-admission.md`
- `packages/core/src/ccc-model-capability-profile.ts`
- `packages/core/src/__tests__/ccc-model-capability-profile.test.ts`
- the minimal additive export lines in `packages/core/src/index.ts`
- `packages/engine/src/ccc-model-boundary-telemetry.ts`
- `packages/engine/src/__tests__/ccc-model-boundary-telemetry.test.ts`
- `packages/engine/src/ccc-model-admission.ts`
- `packages/engine/src/__tests__/ccc-model-admission.test.ts`
- the minimal additive export lines in `packages/engine/src/index.ts`

Never write, stage, or mutate:

- `/Users/ryanpappal/03_CODE/ccc-fusion-worktrees/r1-qe-runner`, `agent/r1-qe-runner`, or its `.opencode/` state;
- the parked model-admission analysis batch or detached anchor;
- any R1 campaign worktree, live campaign state, PostgreSQL/Fusion runtime state, approval, provider session, OmniRoute/AgentSecrets setting, credential, Pueue task, or service;
- any `wave-3` path;
- `packages/engine/src/executor.ts`, `packages/engine/src/pi.ts`, provider-attempt persistence/migrations, campaign bootstrap, live provider/controller code, or R1 orchestration artifacts;
- `main`, any remote branch, a PR, release, install, or runtime deployment.

## Public Interface Map

### Slice A: capability profile

Files:

- `packages/core/src/ccc-model-capability-profile.ts`
- `packages/core/src/__tests__/ccc-model-capability-profile.test.ts`

Public contract:

- `CCC_MODEL_CAPABILITY_PROFILE_SCHEMA_VERSION`
- `CCC_MODEL_CAPABILITY_KEYS`
- `CCC_CAMPAIGN_CRITICAL_CAPABILITY_KEYS`
- `parseCccModelCapabilityProfile(input)` returns a deeply frozen validated profile or throws `CccModelCapabilityProfileValidationError` with exact property paths.
- `canonicalizeCccModelCapabilityProfile(profile)` returns stable key-sorted JSON.
- `digestCccModelCapabilityProfile(profile)` returns a lowercase SHA-256 hex digest of the canonical JSON.
- `evaluateCccCampaignCapabilityAdmission(profile)` returns `{ admitted, reasons }` and refuses every campaign-critical `unknown` capability by exact capability name.

The profile identifies exactly one requested provider/model/transport route. Every required capability is an `{ evidence, value }` record. Validation is strict at every object layer, performs no alias/provider heuristics, and accepts only the versioned schema.

### Slice B: boundary telemetry

Files:

- `packages/engine/src/ccc-model-boundary-telemetry.ts`
- `packages/engine/src/__tests__/ccc-model-boundary-telemetry.test.ts`

Public contract:

- `CCC_MODEL_BOUNDARY_TELEMETRY_SCHEMA_VERSION`
- `createCccSensitivePayloadHmac(key, payload)` accepts a key of at least 32 bytes and an already encoded `string | Uint8Array` payload, then returns only a keyed HMAC-SHA-256 equality token. It never accepts an object whose property order could change the token.
- `parseCccModelBoundaryEvent(input)` strictly validates the data-only envelope and rejects unknown or secret-bearing keys.
- `serializeCccModelBoundaryEvent(event)` returns canonical safe JSON containing no payload bytes.
- `validateCccModelBoundarySequence(events)` consumes events in caller-supplied order with a strictly increasing per-attempt sequence number and monotonic elapsed time, then returns a deeply immutable `readonly CccModelAttemptState[]` in first-attempt order or throws `CccModelBoundaryTransitionError` on an illegal/repeated transition.

Each event carries `runId`, `scenarioId`, `turnId`, and `attemptId` so a failed attempt cannot silently become successful and a new attempt can be distinguished. Requested route identity is always present; effective identity remains optional until proven. Tool fields contain only name/category and schema fingerprints. Payload comparison stores HMAC tokens only.

### Slice C: admission evaluator

Files:

- `packages/engine/src/ccc-model-admission.ts`
- `packages/engine/src/__tests__/ccc-model-admission.test.ts`

Public contract:

- `CCC_MODEL_ADMISSION_STAGES`
- `CCC_MODEL_ADMISSION_POLICY_V1`
- `evaluateCccModelAdmission(input, policy = CCC_MODEL_ADMISSION_POLICY_V1)` returns an immutable structured verdict with `verdict`, `highestStage`, ordered `reasons`, and `nextProbe`.

The evaluator consumes one already validated capability profile plus explicit offline fixtures, live microprobes, predefined replicated arms, five sealed coding trials, route proof, controls, and terminal classifications. Generic evidence records contain no provider-specific behavior. It evaluates all schema-valid evidence in fixed stage order, then orders reasons by stage, policy rule, and evidence identifier. Verdict precedence is `rejected` over `insufficient_evidence` over `admitted`: an explicit failed invariant cannot be hidden by a missing later record. `nextProbe` is the probe attached to the first ordered reason for either non-admitted verdict and is `null` only when admitted. Only a complete policy-conformant set produces `admitted`.

## RED to GREEN to REFACTOR Sequence

### Task 1: Capability profile

RED:

1. Create the test file first with public-behavior cases for exact parsing, immutability, stable canonical serialization/digest, unknown capability refusal, strict unknown-key rejection, and exact missing-capability errors.
2. Run `pnpm --filter @fusion/core exec vitest run src/__tests__/ccc-model-capability-profile.test.ts --silent=passed-only --reporter=dot`.
3. Record the missing-module/public-contract failure in the checkpoint ledger.

GREEN:

1. Add the smallest manual strict validator, canonicalizer, digest, freeze, and admission check required by the tests.
2. Re-run the exact RED command and record the passing count.

REFACTOR:

1. Remove duplicated validation/canonicalization paths without expanding the schema.
2. Re-run the exact Slice A test and `pnpm --filter @fusion/core typecheck`.
3. Add the minimal static Slice A export to `packages/core/src/index.ts`, rerun the Slice A test and core typecheck, then stage exactly the Slice A source, test, and index files and commit `feat(ccc): add model capability profile` after the proof is green.

### Task 2: Boundary telemetry

RED:

1. Create the test file first with public-behavior cases for all required stages, safe serialization, keyed-HMAC equality, secret/raw-payload rejection, false terminal success, `dispatched_unknown`, mid-stream failure, repeated terminal/closure, and handoff-before-closure.
2. Run `pnpm --filter @fusion/engine exec vitest run src/__tests__/ccc-model-boundary-telemetry.test.ts --silent=passed-only --reporter=dot`.
3. Record the missing-module/public-contract failure in the checkpoint ledger.

GREEN:

1. Add the smallest strict envelope parser, canonical serializer, HMAC helper, and pure attempt-aware state validator required by the tests.
2. Re-run the exact RED command and record the passing count.

REFACTOR:

1. Consolidate transition invariants and privacy-key checks without adding runtime wiring.
2. Re-run the exact Slice B test and `pnpm --filter @fusion/engine typecheck`.
3. Add the minimal static Slice B export to `packages/engine/src/index.ts`, rerun the Slice B test and engine typecheck, then stage exactly the Slice B source, test, and index files and commit `feat(ccc): add privacy-safe model boundary telemetry` after the proof is green.

### Task 3: Admission evaluator

RED:

1. Create the test file first with public-behavior cases for each stage, route proof/mismatch, 10/10 terminal microprobes, 30 unique arms, unresolved attempts, five sealed coding tasks, controls, verifier/scope/proof failures, capability evidence thresholds, malformed evidence, and a passing diff without terminal return.
2. Run `pnpm --filter @fusion/engine exec vitest run src/__tests__/ccc-model-admission.test.ts --silent=passed-only --reporter=dot`.
3. Record the missing-module/public-contract failure in the checkpoint ledger.

GREEN:

1. Add the smallest deterministic, ordered, provider-neutral evaluator required by the tests.
2. Re-run the exact RED command and record the passing count.

REFACTOR:

1. Consolidate ordered reason generation and stage thresholds without hiding exact failure causes.
2. Re-run the exact Slice C test and `pnpm --filter @fusion/engine typecheck`.
3. Add the minimal static Slice C export to `packages/engine/src/index.ts`, rerun the Slice C test and engine typecheck, then stage exactly the Slice C source, test, and index files and commit `feat(ccc): add deterministic model admission evaluator` after the proof is green.

### Task 4: Public exports and documentation

1. Confirm the slice commits already contain only the minimal static exports needed for cross-package compilation.
2. Add `docs/model-admission.md` explaining the three contracts, evidence levels, privacy boundary, policy thresholds, extension procedure, source/test-only lifecycle label, and explicit Phase 2 exclusions.
3. Run the three targeted tests together and both package typechecks/builds.
4. Stage only the documentation and commit `docs(ccc): document model admission contracts` after proof.

## Review Fanout Ownership

No oc-fanout batch will be created or mutated in this implementation.

- Luna architecture reviewer: requested model `gpt-5.6-luna`, reasoning effort `max`, read-only. It may inspect the plan and proposed public interfaces for coupling, privacy leaks, and provider/model assumptions. It owns no files or Git actions.
- Luna test reviewer: requested model `gpt-5.6-luna`, reasoning effort `max`, read-only. It may inspect final tests and recorded RED/GREEN/REFACTOR evidence for mock-only assertions and missing negative controls. It owns no files or Git actions.
- AGY plan reviewer: `agy-bridge adversarial_review`, read-only, exact saved plan candidate.
- AGY closeout reviewer: `agy-bridge adversarial_review`, read-only, exact final diff/files after deterministic proof.

Requested and effective routes must be reported separately. If the Luna route is not proven effective as requested, label it `ROUTE_UNAVAILABLE` and continue with direct parent plus AGY review. Reviewers do not implement, stage, commit, run providers, or mutate runtime state. The parent adjudicates every recommendation before changing files.

## Integration Order

1. Commit this reviewed plan on the isolated branch.
2. Complete and commit Slice A from its own valid RED/GREEN/REFACTOR cycle.
3. Complete and commit Slice B from its own valid RED/GREEN/REFACTOR cycle.
4. Complete and commit Slice C after Slice A's public types exist.
5. Add documentation after confirming each slice already carries its minimal export.
6. Run Luna architecture/test reviews and AGY exact-artifact review; disposition each concrete finding as adopt, reject, defer, or investigate.
7. If a material repair changes reviewed bytes, rerun the affected targeted proof and one bounded closure review.
8. Run final targeted, package, canonical, diff, status, branch-diff, and R1 conflict checks.

## Verification Commands

Targeted contract proof:

```bash
pnpm exec vitest run \
  packages/core/src/__tests__/ccc-model-capability-profile.test.ts \
  packages/engine/src/__tests__/ccc-model-boundary-telemetry.test.ts \
  packages/engine/src/__tests__/ccc-model-admission.test.ts
```

Package-configured targeted proof, run in addition to the operator-required root command above:

```bash
pnpm --filter @fusion/core exec vitest run src/__tests__/ccc-model-capability-profile.test.ts --silent=passed-only --reporter=dot
pnpm --filter @fusion/engine exec vitest run src/__tests__/ccc-model-boundary-telemetry.test.ts src/__tests__/ccc-model-admission.test.ts --silent=passed-only --reporter=dot
```

Package gates:

```bash
pnpm --filter @fusion/core typecheck
pnpm --filter @fusion/core build
pnpm --filter @fusion/engine typecheck
pnpm --filter @fusion/engine build
```

Canonical and Git proof:

```bash
task verify
git diff --check 67a123b2a50953c42809617890b56d36b8d100f3..HEAD
git status --short --branch
git diff --stat 67a123b2a50953c42809617890b56d36b8d100f3..HEAD
git diff --name-status 67a123b2a50953c42809617890b56d36b8d100f3..HEAD
git log --oneline 67a123b2a50953c42809617890b56d36b8d100f3..HEAD
git log --oneline codex/model-admission-platform..agent/r1-qe-runner
git diff --name-only codex/model-admission-platform...agent/r1-qe-runner
```

Required deliberate failure probes are named tests and must also be visible in the final targeted run:

1. one required profile capability at `unknown` is refused;
2. `controller_handoff` before `stream_closed` is refused;
3. a passing coding diff without terminal model return is not admitted.

## Checkpoint Ledger

| Checkpoint | Git identity | Evidence | Status |
|---|---|---|---|
| Ownership preflight | baseline `67a123b2a50953c42809617890b56d36b8d100f3`; branch `codex/model-admission-platform`; isolated path above | branch/path collision checks absent; R1 worktree dirty at baseline; `oc-fanout doctor` ready and capacity observed read-only, but oc-fanout intentionally unused | accepted |
| Durable plan | uncommitted candidate | AGY `gemini-3.7-flash-high` returned REJECT; adopted export sequencing, deterministic ordering, binary HMAC input, explicit state return, and critical-key constant; retained the operator-required root Vitest command plus package-configured proof; rejected `nextProbe: null` for rejected verdicts because the controlling spec requires the smallest result-changing probe; AGY closure review of repaired SHA-256 `e927c9c7bfa4f1e97aa39306d0ba8cc8ade069d272376a1f330bfb57d263ad10` returned ACCEPT | accepted; commit pending |
| Slice A | baseline | RED/GREEN/REFACTOR not yet run | pending |
| Slice B | baseline | RED/GREEN/REFACTOR not yet run | pending |
| Slice C | baseline | RED/GREEN/REFACTOR not yet run | pending |
| Exports/docs | baseline | targeted/package proof not yet run | pending |
| Independent review | baseline | Luna and AGY review not yet run | pending |
| Final verification | baseline | targeted, package, `task verify`, diff, status, and conflict proof not yet run | pending |

## Remaining Risks

- A fresh worktree may not have usable dependency artifacts. If the targeted runner fails for environment/bootstrap reasons, that is not valid RED; stop implementation until the existing repository-supported artifact path can run without dependency installation.
- Strict runtime validation can become too permissive if unknown nested keys or non-finite numbers are accepted; tests must cover both.
- Privacy safety can regress through a future generic metadata bag; this version deliberately exposes no arbitrary metadata/payload field.
- A route receipt can prove presence without proving identity; the evaluator requires both requested and effective identity evidence and exact equality.
- Deterministic reason ordering and the smallest-next-probe rule can drift if validation and policy logic are duplicated; keep one ordered evaluation path.
- Source/test proof cannot establish provider correctness, runtime telemetry capture, installed state, or campaign usefulness. Those remain Phase 2 evidence tasks.

## Phase 2 Deferred Work

Phase 2 may add transport instrumentation, persisted evidence receipts, real offline fixtures, live microprobes, replicated scenario runners, bounded coding trials, and later a separately authorized controller-termination experiment. It must first reconcile the current R1 work, persistence schema ownership, runtime adapter boundaries, and live provider authority. None of that wiring is part of this branch.
