# CCC campaign production hardening implementation plan

## Goal

Implement the accepted design in small, independently provable changes while preserving the merged multi-turn custody fix and all existing frozen campaign receipts.

Design: `docs/plans/2026-08-12-ccc-campaign-production-hardening-design.md`

## Preconditions

- Branch/worktree: `agent/campaign-production-hardening` in `/Users/ryanpappal/03_CODE/ccc-fusion-worktrees/campaign-production-hardening`.
- Accepted predecessor: `origin/main` at `91b74f1090e1fb28e48fa12136b9b9fab7183fc7`.
- Round 10 database rows, worktrees, commits, and pilot ledger are evidence only and remain untouched.
- The primary checkout, revoked `wave-3`, read-only `wave-3-retry`, port `4040`, provider credentials, and live OmniRoute settings are outside the implementation write set.
- Dependency hydration may run only in this task worktree and must leave manifests/lockfile unchanged.

## Slice 1: truthful global request-budget behavior

### RED

1. Add an engine regression crossing the real provider/session error-flattening seam. The 25th request must currently end `failed`; assert the required result is `manual-required` with both `lastError` and `blockedReason` equal to `ccc-permanent:CCC_CAMPAIGN_REQUEST_BUDGET_EXHAUSTED`, no retry, and no additional provider call.
2. Add a core PostgreSQL regression where task A consumes the shared cap and task B's next reservation is refused without a new reservation audit row.
3. Add preview/render tests requiring campaign-global scope, task-count floor, headroom, and `completion adequacy: unproven`.
4. Add authoritative fresh-v2 import and preview refusal when `maxRequests < providerTaskCount`. Exact persisted legacy replay remains allowed, and runtime per-member behavior is unchanged in this slice.
5. Add status regressions proving the counter accounts for reservation slots, exact exhaustion requires `used === maximum` plus matching provider-attempt history, and any reserved/dispatched-unknown provider or proof work or missing custody outranks fresh-import recovery guidance.

### GREEN

- Preserve `CccProviderAttemptLimitError` identity through the controller/session boundary with a stable tagged code.
- Translate only `reason === "max-requests"` on a sealed campaign into `PermanentError` code `CCC_CAMPAIGN_REQUEST_BUDGET_EXHAUSTED`.
- Add status recovery text that says the immutable import cannot resume and a fresh sealed import is required.
- Add derived preview budget guidance outside the confirmation identity.
- Enforce the deterministic one-request-per-provider-task admission floor for fresh v2 creation without adding runtime task quotas or blocking exact legacy replay.

### REFACTOR and proof

- Centralize the stable budget-exhaustion classifier; do not match free-form prose.
- Rerun the engine boundary test, core PG attempt suite, CLI render/command suites, package typechecks, targeted lint, and `git diff --check`.

## Slice 2: one sealed parent launch authorization

### RED

1. In `packages/engine/src/__tests__/ccc-campaign-live-execution-approval.real-pg.test.ts`, require either task in a two-task import to issue the same parent authorization whose canonical members are exactly both existing task/action/binding hashes.
2. Approve once and assert both child approvals and `[taskId][actionId]` leases are claimed atomically.
3. Inject child drift and an intermediate claim fault; assert parent, children, and leases all roll back and provider attempts remain zero.
4. Restart and replay issue/claim; assert one parent, identical membership, no duplicate children, and exact child dispatch custody.
5. Status/CLI acceptance must expose one human execution confirmation, not child confirmations.

### GREEN

- Add parent/member types and canonical hashing without changing `CccCampaignAuthorityBinding`.
- Add migration `0039_ccc_campaign_execution_authorization.sql`, baseline parity, RLS, foreign keys, and uniqueness.
- Add manifest v2 with hash-bound `sealed_bundle_v1`; manifest v1 remains `per_task_v1`. Any projection column is loader-checked and cannot independently switch modes.
- Factor issue/claim-within-transaction primitives and implement atomic parent plus sorted-child issue/claim.
- Bind confirmation to the complete sealed member set, one-time expected-request-count snapshot, global bounds, and immutable campaign identity. Exclude mutable work-item attempt/run/lease/timestamp fields.
- Keep provider controller and settlement task-specific; resolve the current task's exact claimed child under the parent membership.
- Filter child rows from human prompt counts while retaining diagnostic status.

### REFACTOR and proof

- Preserve explicit lock order: import, parent, sorted children, leases, attempts/effects.
- Run migration baseline/upgrade parity, approval PG suites, live-execution real-PG suite, controller/settlement suites, product-status multi-task tests, CLI tests, chained/fan-out product acceptance, package typechecks, targeted lint, and `git diff --check`.

## Slice 3: authorization replay and unused-child terminal custody

### RED

1. Let task A spend requests after the parent claim, then enter task B's `require` seam after restart and a changed work-item attempt; assert claimed replay remains valid without comparing the now-current request count.
2. Change the request count before the first parent claim; assert the stored `expectedRequestCount` CAS refuses atomically with no child lease.
3. Cancel before any member dispatches and close every claimed child only after proving the terminal work item and zero reservations.
4. Fail an upstream task after one child consumed; close downstream unopened children as no-effect, settle the parent as partial, and make merge ineligible.
5. Pass the database deadline with an unopened child and prove restart-safe no-effect closure.
6. Race provider settlement against no-effect closure; assert exactly one child terminal outcome, one lease settlement, and one parent terminalization.
7. Prove a reserved, dispatched-unknown, proved-not-dispatched, committed, or proved-failed member is never classified as unopened.

### GREEN

- Split immutable parent authorization/member identity from the one-time expected-request-count claim CAS.
- Add atomic claimed-unopened no-effect closure gated by terminal work-item/deadline custody, exact zero-reservation history, and no unknown effect.
- Add parent terminal `settled` outcome that distinguishes complete effect from partial/no-effect closure.
- Keep every reserved state opened and spent; do not create credits or decrement history.

### REFACTOR and proof

- Reuse campaign attempt history and the established import/approval/effect lock order.
- Run chained/fan-out engine acceptance in addition to direct PG seams, plus cancellation, deadline, restart, and race tests.

## Slice 4: clause-complete semantic packet and prompt

### RED

1. Feed a v2 Round 10 slugify source with stable clause IDs, then omit the empty-string clause ID from the proposal and require `CCC_PRD_ACCEPTANCE_CLAUSE_UNDISPOSITIONED`. Feed the original unstructured paragraph to the v2 path and require semantic-normalization refusal rather than heuristic sentence splitting.
2. Reject malformed v2 clause Markdown: duplicate/foreign IDs, continuation lines, trailing whitespace, clauses outside the exact requirement acceptance subsection, and invalid disposition references.
3. Require every accepted clause to link to a proof; unresolved, duplicate, foreign, or uncovered clauses refuse.
4. Require the sealed execution prompt to contain the exact admitted clauses and source excerpts, with their hashes included in bundle/prompt identity.
5. Prove a changed clause or excerpt changes sidecar, bundle, prompt, and confirmation custody.

### GREEN

- Add explicit v2 discriminators for proposal, proposal fragment, sidecar, bundle, proof admission, execution prompt, and proof definition while preserving v1 parsing/hash semantics. Packet and implementation-fact-provenance remain v1 by explicit contract.
- Add versioned source-declared acceptance-clause and disposition types to the authoring proposal, sidecar, and semantic bundle.
- Add deterministic exact-span clause-ID coverage and bounded authoring diagnostics; do not infer clauses from prose.
- Render accepted clauses and source excerpts in the execution prompt.
- Preserve v1 packet inspection while refusing new production-semantic status without the v2 contract.
- Update native/chunk authoring prompts and the PRD intake template to require clause completeness.

### REFACTOR and proof

- Reuse raw-byte span verification and canonical code-unit ordering.
- Run native/chunk authoring, structural compiler, execution-prompt, import, built-CLI, and real-packet fixture suites plus package typechecks and lint.

## Slice 5: verifier-owned proof and task proof gate

### RED

1. Refuse a proof whose verifier closure is inside any task owned/write root.
2. Refuse missing, untracked, symlinked, non-regular, base-drifted, or hash-drifted closure members and task-runner definitions.
3. Refuse an unchanged Taskfile target that uses includes, dotenv, dependencies, variables, package-script indirection, shell substitution, dynamic dispatch, or delegates to a model-owned test.
4. Make a correctly hash-bound harness dynamically read/import an undeclared model-owned helper; execution must refuse because the helper is absent from the materialized root and the original repository is unreadable.
5. Drift either the exact Task or Node executable/version identity after preview and require refusal before process spawn.
6. After a task commit, withhold dependent scheduling until the linked trusted proof passes; park terminally on proof failure with zero downstream provider calls.
7. Mutate a trusted verifier after task execution and assert final proof refuses before merge approval.
8. For a one-task campaign whose task and final commit are identical, require two executions with distinct `task` and `final_integrated` attempts while same-phase replay remains idempotent.
9. Exit zero with missing, duplicate, unknown, malformed, over-limit, or failing canonical evidence and assert refusal.
10. Assert proof receipts bind phase, clause IDs, complete closure, candidate inputs, toolchain, commit/tree, command, and parsed terminal evidence.
11. Upgrade a database containing terminal v1 attempts, prove byte-stable v1 replay, then create both v2 phases and enforce their phase/evidence constraints and uniqueness on both upgraded and fresh schemas.
12. Change one candidate path, Task identity, Node identity, or proof-host identity after admission and require a changed definition hash plus pre-spawn stale-admission/replay refusal.
13. Persist and replay four distinct `proved_failed` v2 terminals: timeout, no output, malformed output, and valid canonical failing evidence. Only the last carries parsed proof evidence; every case carries a canonical controller terminal envelope and raw process/output digests.

### GREEN

- Add versioned `verifierClosure` entries with role, canonical path, frozen-base Git blob identity, and SHA-256; explicit candidate-under-test paths; and hash/version-bound Task plus Node toolchain identity to proof custody.
- Validate lexical/physical/tracked-file custody, target grammar, complete declared inputs, and disjointness from all model-writeable paths during preview/import.
- Materialize only frozen verifier blobs and exact-commit candidate blobs into a fresh read-only proof root; expose only a separate writeable scratch directory and deny both original repositories, ambient PATH/environment, and network.
- Recheck every materialized closure member, candidate object, and toolchain identity immediately before execution.
- Run task-linked proof after the controller commit and before dependency release.
- Enforce compiler ownership: exactly one task owns each task-phase proof; cross-task proofs are final-only; every task has a task gate; every accepted clause has final-integrated coverage.
- Persist proof phase and include it in attempt identity/replay validation so task and final-integrated executions cannot collide.
- Add migration `0040_ccc_campaign_semantic_proof_v2.sql`: preserve phase-null/envelope-null/evidence-null v1 rows and keys; require v2 phase; require a canonical controller terminal envelope/digest at terminal; require passing parsed evidence for `committed`; allow either failing parsed evidence or a typed execution/output-refusal envelope for `proved_failed`; enforce same-phase uniqueness; and update the fresh baseline/schema registry.
- Define one shared v2 proof-definition hash over clauses, phases, closure, cases, and controls.
- Include the canonical candidate path set, complete Task/Node toolchain identities, and proof-host identity in that shared v2 definition hash.
- Parse bounded canonical `ccc-prd.proof-evidence.v2` output and require exact expected result sets in addition to exit zero.
- Rerun every proof against the final integrated tree and make only that result eligible for merge approval.
- Keep model-authored tests supplemental and AI review non-authoritative.

### REFACTOR and proof

- Reuse existing bounded proof command execution, confinement, commit/tree binding, and audit primitives.
- Run proof admission/execution/required-commit/workflow graph suites, real-Git negative controls, import real-PG acceptance, and product acceptance.

## Slice 6: pilot fixture and end-to-end acceptance

### RED fixture

- Add baseline-owned `verify/acceptance/slugify.acceptance.test.js` to a fresh disposable target baseline. Confirm the Round 10 implementation fails specifically on repeated separators and any other omitted clauses.
- Add known-bad remove-punctuation and preserve-repeated-hyphen controls and prove the trusted fixture rejects both.

### GREEN fixture and packet

- Create a fresh PRD packet whose exact acceptance clauses, trusted verifier paths/digests, provider routes, action set, and campaign-global request cap satisfy the new contract.
- Use a realistic source-bound global cap while retaining the admission floor and no-refund semantics. The floor creates no per-task quota or reservation; earlier tasks may still exhaust the global cap.
- Rebuild the repo CLI from the final accepted source and bind the fresh proof-host identity.

### Deterministic acceptance

- Run preview, import, one execution approval, all implementation tasks, per-task proofs, final integrated proof, one merge approval, and landing against fake deterministic provider drivers.
- Assert exact member set, request ordinals, provider receipts, child approval consumption, parent lifecycle, proof receipts, two human-facing decisions, final Git commit/tree, and no forbidden writes.

### Live acceptance

- Start only the supervised embedded PostgreSQL and proof host owned by the new round, using a verified-free loopback port other than `4040`.
- Re-probe the live provider model catalog and restore only the packet-declared identity-stable aliases after serve startup if required.
- Run one fresh live campaign. Do not reuse a prior digest or manufacture the two byte-exact human receipts.
- Preserve all audit rows, provider-attempt lifecycles, proof receipts, work-item terminal state, and Git landing evidence.

## Final verification and integration

For each accepted slice:

- freeze `HEAD`, tree, diff, and exact changed paths;
- run the narrowest named RED/GREEN tests, then relevant package typechecks and lint;
- run `pnpm verify:fast` after source integration;
- obtain independent final-byte correctness/security/test review and disposition every material finding;
- commit exact paths with a conventional `fix(FN-...):` or `feat(FN-...):` message and `Fusion-Task-Id` trailer;
- push only the feature branch.

Before merge:

```text
pnpm lint
pnpm typecheck
pnpm build
pnpm test:gate
git diff --check origin/main...HEAD
```

Open a non-draft PR against `CrashCartCapital/ccc-fusion`. Merge only when the head is mergeable/clean, the non-empty required check set is green, no review requests changes, and no self-approval or admin bypass is used. Squash is the default.

## Completion evidence

Completion requires all of the following, kept distinct:

- source: final merged commit and tree;
- tests: exact commands, counts, and zero named skips;
- migration: fresh-baseline and upgrade parity;
- runtime: built CLI/proof-host identity loaded from merged bytes;
- deterministic product: one launch confirmation plus one merge confirmation across a multi-task fake-provider campaign;
- live product: real provider calls, trusted proof, and final landing under fresh exact receipts;
- documentation: pilot ledger and operator intake template updated with request-budget and verifier-owned proof rules;
- remaining risk: explicitly named; no green test is promoted into live proof without the live evidence.
