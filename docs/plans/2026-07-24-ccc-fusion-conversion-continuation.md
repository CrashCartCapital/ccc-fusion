# ccc-fusion Conversion Continuation

## Goal

Finish the remaining ccc-fusion conversion with one accepted predecessor chain, one central writer for shared integration surfaces, bounded fanout work that respects real dependencies, and proof that reflects user-visible behavior rather than test ceremony.

This is the code-local continuation packet. The vault remains authoritative for product requirements, operator gates, and changing orchestration state:

- Product contract: `/Users/ryanpappal/01_VAULT/KnR-Vault/00_MAIN/01_ActiveProjects/ccc-fusion/PRJ-AI-ccc-fusion-PRD-v0.1.md`
- Implementation plan: `/Users/ryanpappal/01_VAULT/KnR-Vault/00_MAIN/01_ActiveProjects/ccc-fusion/PRJ-AI-ccc-fusion-ConversionPlan-v0.1.md`
- Post-audit route: `/Users/ryanpappal/01_VAULT/KnR-Vault/00_MAIN/01_ActiveProjects/ccc-fusion/REF-AI-ccc-fusion-PostAuditAdjudicationAndExecutionRoute-2026-07-24.md`
- Current execution ledger: `/Users/ryanpappal/01_VAULT/KnR-Vault/00_MAIN/01_ActiveProjects/ccc-fusion/REF-AI-ccc-fusion-Phase5-OrchestrationCheckpoint.md`
- Parallel-work policy: `/Users/ryanpappal/01_VAULT/KnR-Vault/00_MAIN/01_ActiveProjects/ccc-fusion/REF-AI-ccc-fusion-ParallelForwardFillExecutionApproach-2026-07-24.md`

## Success Criteria

- The completed audit and adjudication control the continuation route.
- One designated ccc-fusion authoring workflow generates and maintains a versioned packet sidecar/index from exact unchanged Markdown spans and raw source hashes, reports bounded ambiguities/exceptions for Ryan to decide, and produces exact non-zero requirements, proofs, actions, dependencies, bounds, and import intent without making Ryan manually recreate the task graph.
- Wave 5 compilation and validation are deterministic, semantically distinct, exercised through the built CLI, and side-effect free under an explicit bounded-temp policy.
- Wave 5 import uses one import-owned database/filesystem unit of work; every database writer shares one transaction handle, and file projection is staged, compensated, or reconciled from a non-runnable state.
- Failed import creates no runnable partial campaign.
- Repeating the same admitted import does not duplicate tasks, edges, workflows, documents, artifacts, or campaign identity.
- Verification reports exact imported counts and hashes against a disposable project fixture.
- The central writer owns shared persistence and CLI seams; child sessions work only on collision-free audit, test, fixture, review, or frozen-contract scaffolding lanes.
- No speculative Wave 6 or Wave 7 code becomes accepted without replay onto and proof against the accepted predecessor.

## Current Verified State

| Surface | State | Identity |
|---|---|---|
| Accepted Wave 4 | Accepted and frozen | `726db7806c5964097f982b7048da680d2fdd750a` |
| Accepted Wave 5 | Accepted after closed 80-test proof and three fresh no-P0/P1 council passes | `db486195224839ff10dee396d3b119623ae59661` |
| Accepted Phase A/B contract | Generated sidecar, structural compiler, validate, and built CLI | `90c585766b37605aae4be5a9ad6880455e1b7afa` |
| Accepted Phase C import | PostgreSQL/filesystem unit of work, recovery, and idempotency | `d0debd4ee1b50276b149741e23bbe69c18360ba2` |
| Wave 5 integration branch | Current code-writing branch | `agent/ccc-fusion-wave-5-integration` |
| Wave 6 and Wave 7 | Speculative evidence only; unchanged replay rejected | Isolated worktrees, not ancestors of integration |
| Primary checkout | Not a product writing target | `main` has a generated-instruction descendant and one preserved pre-existing untracked report |

Accepted Wave 5 is frozen at tree `c273946cfdd7aaceed9a1e7c50f3dcb8290c8149`. The closed proof inventory is exactly 80 uniquely named tests: built CLI 10, core sidecar/compiler contract 7, core import/recovery 40, import migration 2, engine authoring/compiler/corpus 20, and native imported execution 1. Wave 4 regression, relevant typechecks/builds, lint, runner policy and stop-settlement self-tests, manifests, diff hygiene, user-like built CLI, loopback PostgreSQL, and all three fresh council lanes passed. The earlier compiler-only baseline `e29732e74f38393eeb0ba25e899dd14e012b9fbf` remains historical custody evidence only.

## Implemented Compiler Surface

- `packages/core/src/ccc-prd/` currently owns packet, source, diagnostic, requirement, proof, bundle, protected-action, and hash contracts; the CF-008 semantic contract is now explicitly reopened.
- `packages/engine/src/ccc-prd/` currently owns manifest admission, path and hash checks, table-only requirement extraction, prose action discovery, locale-dependent sorting, and bundle creation; the latter three behaviors are rejected.
- `packages/cli/src/commands/prd.ts` currently exposes `compile` and `validate` through the same implementation; the built CLI must gain distinct operator semantics and stable output/exit behavior.
- `packages/engine/src/__tests__/fixtures/ccc-prd-canaries/` owns approved test copies for SRU, ccc-lab-super, and the Neo handoff candidate.
- `packages/core/src/__tests__/ccc-prd-schema.test.ts`, `packages/engine/src/__tests__/ccc-prd-compiler.test.ts`, `packages/engine/src/__tests__/ccc-prd-corpus.test.ts`, and `packages/cli/src/commands/__tests__/prd.test.ts` are the current focused proof.

The public compiler contract is not frozen. The real corpus producing zero requirements is the failing proof that reopened it. It freezes again only after the packet-sidecar specification and one real-packet exact-count oracle pass.

## Remaining Wave 5 Slice

### Packet And Compiler Contract

Before import work, freeze one designated authoring workflow and one versioned structured sidecar/index per admitted packet. The workflow generates and updates a traceable candidate from unchanged Markdown and presents Ryan only a bounded ambiguity/exception/protected-decision list; Ryan does not manually enumerate requirements or tasks. The sidecar must identify ordered raw-byte-hashed sources and authority roles; stable requirements with exact source spans, acceptance, producer, dependencies, and proof IDs; proof commands with positive oracles and negative controls; declared protected actions with exact targets; finite bounds; admitted write roots; target/base identity; non-goals; provenance, confidence, and unresolved-decision status. Original PRD Markdown remains unchanged.

The first `ccc-lab-super` generated sidecar is the authoring/compiler RED and exact-count oracle. Add a fresh-packet acceptance case that reaches a traceable candidate sidecar plus bounded exception list without manual requirement/task translation. Replace table-only extraction, prose protected-action matching, prose `while true`/`status: DEFERRED` refusal, decoded-text hashing, and `localeCompare` canonicalization with structural declarations, raw-byte custody, and code-unit ordering. Validate reports bounded diagnostics; compile emits the semantic bundle. Both run through the built CLI and leave admitted roots unchanged.

### Import Unit Of Work

After structural compiler GREEN, freeze:

- the admitted bundle identity and idempotency key;
- exact task, dependency-edge, workflow-definition, document, artifact, and campaign records created;
- which transaction-aware repository owns every database write through one `DbTransaction`;
- how task directories, prompt projections, artifact bytes, allocator reservations, caches, hooks, and events are staged, compensated, or reconciled without runnable partial state;
- how a second identical import returns the existing result without duplication;
- how any injected write failure rolls back every sibling write;
- how compile and validate prove zero writes;
- how the CLI distinguishes compile, validate, import success, refusal, duplicate replay, and rollback failure;
- the exact operator-visible summary needed to understand what was imported and what remains blocked.

### Candidate Code Surfaces

The current vault plan names these candidate ownership areas. The audit must verify the live API before authorizing edits:

- `packages/core/src/task-store/task-creation.ts`
- PostgreSQL task/workflow/document/artifact transaction helpers under `packages/core/src/task-store/`
- a narrow import service under `packages/engine/src/ccc-prd/`
- `packages/cli/src/commands/prd.ts`
- focused core, engine, CLI, and disposable-PostgreSQL tests

Do not call independently committing public task/document/artifact/workflow helpers from inside the import transaction. Do not spread import logic before identifying one database/filesystem unit-of-work owner. Do not add a second database, scheduler, receipt store, parser, or dashboard intake path.

## Dependency-Aware Execution Route

### Stage 1 — Packet Contract And Real Oracle

The audit is complete. The main Sol-max agent freezes the generated-sidecar authoring contract, sidecar/index specification, one fresh-packet no-manual-translation acceptance case, and one exact `ccc-lab-super` oracle. Read-only or disjoint fixture/count/failure-matrix work may fan out; the shared authoring and compiler contract has one writer.

### Stage 2 — Structural Compiler And CLI

The central writer captures the real-packet RED, repairs the bundle contract/compiler/validate/CLI semantics, and freezes the interface after exact non-zero GREEN. No prose inference remains.

### Stage 3 — Import-Owned Unit Of Work

The writer first designs transaction-aware persistence and the filesystem staging/compensation/reconciliation boundary. RED covers failure after every entity and file class, audit/activation failure, commit/projection crash, sequential/concurrent/lost-response replay, exact counts, normal API visibility after restart, and zero provider activity.

### Stage 4 — Integrated Candidate Proof

Freeze exact branch, HEAD, tree, status, manifests, accepted-predecessor digest, changed files, and proof artifacts. Run focused compiler/import tests first, then relevant package typechecks, lint, `pnpm test:gate`, build, diff checks, and disposable PostgreSQL proof. Preserve failed PostgreSQL evidence; clean successful owned fixtures.

### Stage 5 — Independent Acceptance

Fan out fresh behavioral/PostgreSQL, static/build, and final-artifact reviews against identical frozen bytes. Any P0/P1 returns to the sole writer for one evidence-backed repair cycle. Full Wave 5 becomes accepted only after all lanes pass and the parent re-freezes identity.

### Stage 6 — Consolidated Native Enforcement And Local Completion

After full Wave 5 acceptance, discard the Wave 6 parallel receipt production design and reject unchanged Wave 7 replay. Rebuild only useful invariants through native run-audit, atomic approval compare-and-swap, workflow/proof, normalized mutation, production merger/ref-update, real-Git interruption, bounds, drift, and terminal-state seams. Then complete deterministic local mixed-provider, real-packet preflight, shallow docs/branding, and merge-readiness equivalents of Waves 8–10. Live providers, credentials, billing, remote fetch, push, merge, release, publication, and `main` remain operator-gated.

## User-Centric And Anti-Overengineering Checks

Every remaining task must answer:

- What does Ryan gain or avoid because this exists?
- Which concrete operator action or failure becomes safer, faster, or clearer?
- Does Fusion already have a native mechanism that satisfies the outcome?
- Can the requirement be proven through a smaller public seam?
- Is this blocking the first useful end-to-end handoff, or can it wait?
- Does the test prove observable behavior, or only the implementation shape?
- Is speculative work likely to survive predecessor integration?
- Would deleting this task weaken a named PRD requirement or user outcome?

Reject work whose only defense is architectural neatness, theoretical future scale, internal renaming, duplicate state, or an unmeasured claim of flexibility.

## Constraints

- Never access the revoked `wave-3` worktree.
- `wave-3-retry` is read-only dependency hydration only.
- Do not install, rebuild dependencies, fetch, push, merge, tag, release, publish, or mutate `main`.
- Do not use provider, credential, billing, non-loopback network, or protected-vault surfaces.
- Keep one writer per file or shared interface.
- Keep PostgreSQL fixtures disposable, loopback-only, and off pre-existing port `55439`.
- Preserve package manifests and lockfiles unless a separately approved requirement proves a change is necessary.
- Do not count speculative commits, historical tests, or malformed child handoffs as acceptance evidence.

## Decisions

- The vault checkpoint is the changing source of truth; this repo note is a code-local execution mirror.
- The accepted spine remains linear even when scaffolding proceeds in parallel.
- Shared persistence and import stay serial under one writer.
- Fanout is for independent evidence and isolated scaffolding, not parallel edits to one interface.
- Wave 5 is accepted. The next implementation action is the RED for the native campaign binding, execution-policy identity, audit, and approval CAS contract.

## Settled Post-Audit Decisions

- CF-009's current bundle is insufficient; the sidecar-driven CF-008 contract is reopened.
- `AsyncDataLayer.transaction()` is a useful primitive but not a complete import seam. Import needs transaction-aware writers plus an explicit filesystem unit of work.
- One real packet compiling, importing, restarting, and remaining inspectable with exact non-zero counts is the first useful local milestone.
- Waves 6 and 7 collapse into one native enforcement/integration slice. The Wave 6 production design is discarded and Wave 7 unchanged replay is rejected.
- Waves 8–10 remain in scope as locally achievable consolidated equivalents; only live/external actions are deferred to operator gates.
- Safe fanout is limited to read-only inventories, disjoint fixtures, independent count oracles, failure-matrix design, and review until consumed contracts freeze.

## Accepted Consolidated Native Phase E/F Plan Freeze

### Goal

Extend existing Fusion production seams so an imported CCC campaign is admitted, executed, proved, cancelled, reconciled, and locally merged only under one immutable packet/bundle/target/base/provider/model policy; every request, approval, proof, effect, workflow lease, and ref update remains bounded and restart-truthful; deterministic local provider fakes prove the joined user path without contacting a live provider.

### Preconditions

- Accepted predecessor: `db486195224839ff10dee396d3b119623ae59661`.
- Accepted tree: `c273946cfdd7aaceed9a1e7c50f3dcb8290c8149`.
- Accepted Wave 5 proof inventory: 80 exact tests.
- Package, workspace, and lockfile hashes remain unchanged.
- Wave 6 `2f01f5f559f44cd60733d304d30976e973a5e894` and Wave 7 `8be022a734fe47aa2deec2d6d9e494b31bef66a3` are non-ancestors and may supply test ideas only.
- Provider, credential, billing, non-loopback, fetch, push, merge, release, publication, upstream-adoption, and `main` actions remain unissued.

### Findings

- Native run audit is append-only but currently lacks typed campaign binding and deterministic replay/collision identity.
- Native ApprovalRequest uses read-then-update in both backends and cannot safely represent issued, claimed, consumed, denied, or expired campaign authority.
- The existing CCC effect store already has the correct `reserved → dispatched_unknown → committed|proved_failed` transport protocol. `dispatched_unknown` is a deliberate reconciliation hold, not a failure to clear automatically.
- The existing workflow extension registry is the required proof-admission mechanism, but fail-closed behavior must be enforced at the consuming boundary and implementation provenance must be pinned.
- Workflow work-item terminal writes are not lease-owner/attempt CAS operations, the processor renews symbol locks but not the work-item lease, and node execution does not receive a processor-owned cancellation signal.
- Provider-capable work has three native entry shapes that must share one coarse campaign/action admission function: direct executor sessions, CLI-agent task sessions, and workflow work-item node handlers. Gating only `createResolvedAgentSession` would leave the other two paths open.
- Session/action admission is not request admission. Pi can issue multiple actual transports through `ModelRuntime.stream` or `streamSimple` during fallback and compaction. Every transport attempt needs its own persisted request/concurrency reservation immediately before dispatch and settlement after the transport closes.
- Pi is not the only transport shape. CLI-agent subprocess launch and provider-capable workflow handlers that do not delegate through Pi also need route-specific attempt scopes. An opaque route that cannot prove and report finite provider bounds is not admissible for a campaign.
- `processDueWorkflowWorkItem` currently calls the one-node `runWorkItem` path, while only `WorkflowTaskRuntime.run` executes a complete graph. A joined campaign proof must enter the full graph only through the claimed native work-processor path.
- Existing effect receipt identity does not bind campaign, action, packet, bundle, target, base, or manifest. Campaign effects must derive a complete binding from TaskStore and refuse before execution when it is absent; an optional column is legacy compatibility only.
- Native `git update-ref <ref> <new> <old>` already supplies ref CAS, but an interruption after the ref lands and before the success audit can be misclassified as a foreign concurrent advance.
- Phase C already performs segment-by-segment no-symlink and realpath custody checks at every owned projection path. The new mutation manifest must apply equivalent lexical plus canonical admission immediately before campaign mutations; the old speculative lexical-only implementation is not reusable.
- AGY session `839cae2d-9f7e-4950-9116-d57bf0543f53` independently confirmed the approval, fail-closed proof, pre-provider bounds/drift, audit-schema, and post-CAS reconciliation gaps. Automatic clearing of `dispatched_unknown` is rejected, but its follow-up correctly identified the missing typed path for authoritative evidence to resolve `dispatched_unknown → proved_failed`. Its importer-wide symlink claim is superseded by the accepted Phase C path controls.

### Durable Mode Packet

- Plan Path: `docs/plans/2026-07-24-ccc-fusion-conversion-continuation.md`
- Findings Path: `/Users/ryanpappal/01_VAULT/KnR-Vault/00_MAIN/01_ActiveProjects/ccc-fusion/REF-AI-ccc-fusion-Phase5-OrchestrationCheckpoint.md`
- Recovery Rule: after compaction, reread the vault checkpoint, then this plan section, then reverify branch, HEAD, tree, manifests, status, accepted ancestry, and speculative non-ancestry before editing.
- Resume/Handoff Rule: the root Sol-max agent remains the only writer of shared schema, importer, audit, approval, proof, executor, merger, runner, and checkpoint surfaces. Children receive only explicit disjoint test, fixture, documentation, or read-only review ownership.

### Task 1 — Freeze Immutable Campaign And Execution-Policy Identity

- Surfaces: `packages/core/src/ccc-prd/types.ts`, `packages/core/src/ccc-prd/importer.ts`, `packages/core/src/postgres/schema/ccc-prd-import.ts`, new `packages/core/src/ccc-campaign/types.ts`, new `packages/core/src/ccc-campaign/canonical.ts`, new `packages/core/src/ccc-campaign/store.ts`, `packages/core/src/store.ts`, `packages/core/src/postgres/migrations/0036_ccc_campaign_native_enforcement.sql`, `packages/core/src/postgres/migrations/0000_initial.sql`, core exports, `packages/core/src/__tests__/postgres/ccc-prd-import.pg.test.ts`, and new `packages/core/src/__tests__/postgres/ccc-campaign-native.pg.test.ts`.
- RED: require import-time execution policy with exact per-task local route `{ providerId, modelId, transport }`; prove missing/extra/duplicate routes refuse; prove the same idempotency key with a changed route/provider/model/transport refuses; prove a task lookup reloads identity from `ccc_prd_imports` plus `ccc_prd_import_entities`, not caller metadata.
- GREEN: persist a versioned execution policy, policy-complete manifest hash, request count, campaign start/deadline, and active action leases on the existing `ccc_prd_imports` row. Bind import identity to project, import, campaign, packet, sidecar, bundle, canonical target, expected base, bounds, admitted roots, protected actions, proof definitions, and every provider/model route. Set imported task route/base fields from that persisted policy. Add one explicit `TaskStore.getCccCampaignContextForTask(taskId)` delegate that joins `ccc_prd_import_entities` to `ccc_prd_imports`; normal task hydration stays unchanged and consumers never infer campaign truth from task JSON. Extract projection helpers into a focused module before the 1,998-line importer can grow beyond the 2,000-line new-file ceiling.
- REFACTOR: reuse `canonicalCccPrdJson` code-unit ordering and one campaign-binding parser. Do not add a campaign database, parser, scheduler, or state machine.
- Verification: `pnpm --filter @fusion/core exec vitest run --config vitest.pg.config.ts src/__tests__/postgres/ccc-prd-import.pg.test.ts src/__tests__/postgres/ccc-campaign-native.pg.test.ts --silent=passed-only --reporter=dot`; core typecheck; focused migration fresh/upgrade parity; `git diff --check`.
- Done when: direct rows, normal task readers, restart lookup, sequential/concurrent/lost-response replay, and changed-policy collision all report the same immutable binding.

### Task 2 — Native Run-Audit Receipt, Approval CAS, And Effect Binding

- Surfaces: `packages/core/src/types/run-audit.ts`, `packages/core/src/types/agents.ts`, `packages/core/src/task-store/async-audit.ts`, `packages/core/src/postgres/data-layer.ts`, `packages/core/src/async-approval-request-store.ts`, `packages/core/src/approval-request-store.ts`, `packages/core/src/ccc-effect-receipts.ts`, `packages/core/src/cli-session-store.ts`, new `packages/core/src/postgres/schema/campaign-governance.ts`, `packages/core/src/postgres/schema/project.ts`, migration `0036`, fresh schema `0000_initial.sql`, core exports, new PostgreSQL campaign test, existing approval and CLI-session-store tests.
- RED: identical campaign audit event replay must return one row; the same event key with changed binding must refuse; two concurrent approval claims must produce exactly one winner; not-before and issued-expiry must refuse; a claimed approval must not expire mid-effect; only the winning claim token may consume; denial/expiry/consume must append one same-transaction audit transition; an admitted protected action must persist and reuse that winning claim token across an identical retry, consume it exactly once after authoritative completion, keep it claimed while completion is unknown, and expire rather than silently reissue it after bounded abandonment; a campaign effect with no complete TaskStore-derived binding must refuse before effect execution; receipt binding drift must collide; an unresolved dispatch must reject blind retry yet accept one exact authoritative no-effect proof.
- GREEN: add first-class campaign/action/event/idempotency/packet/bundle/target/base/provider/model/manifest/binding fields to native RunAuditEvent and deterministic insert-or-read collision semantics. Extend ApprovalRequest compatibly with `issued`, `claimed`, `consumed`, and `expired`; preserve legacy pending/approved/completed callers; make legacy and campaign transitions conditional updates with exact-one-row enforcement. New CCC authority methods require PostgreSQL and fail closed in legacy SQLite mode. Add a nullable campaign binding hash to the existing CCC effect receipt row only for legacy-row compatibility. Every campaign effect reservation, dispatch, commit, replay, and reconciliation must reload and bind the complete campaign identity through `TaskStore.getCccCampaignContextForTask`; caller metadata cannot supply it and omission refuses before the effect seam. Preserve `dispatched_unknown` as manual/reconciliation truth until a new native reconcile method receives exact campaign binding, controller generation, authoritative observer identity, observation digest, and a no-effect result; only that evidence may transition `dispatched_unknown → proved_failed`. A committed observation remains committed and any mismatched observation collides.
- REFACTOR: split run-audit and approval Drizzle definitions out of oversized `project.ts` while re-exporting the same symbols. Keep one forward migration, RLS/project binding, fresh-schema parity, upgrade-once proof, and unchanged legacy read shapes.
- Verification: `pnpm --filter @fusion/core exec vitest run --config vitest.pg.config.ts src/__tests__/postgres/ccc-campaign-native.pg.test.ts src/__tests__/postgres/cli-session-store.pg.test.ts src/__tests__/postgres/satellite-db-injected-stores.test.ts --silent=passed-only --reporter=dot`; focused sync approval tests; core typecheck/build; focused lint; schema parity; `git diff --check`.
- Done when: audit replay/collision, approval one-winner authority, expiry/not-before, exact-token completion consumption, same-transaction history, effect collision, and restart reads are directly proven.

### Task 3 — Fail-Closed Proof Admission And Fenced Workflow Ownership

- Surfaces: `packages/core/src/workflow-extension-types.ts`, `packages/core/src/workflow-extension-registry.ts`, `packages/core/src/task-store/async-workflow-workitems.ts`, `packages/core/src/task-store/workflow-workitems-ops-2.ts`, workflow transition types, `packages/engine/src/plugin-workflow-extension-adapter.ts`, `packages/engine/src/workflow-task-runtime.ts`, `packages/engine/src/workflow-work-processor.ts`, new `packages/engine/src/ccc-campaign-proof-admission.ts`, existing extension/runtime/processor tests, and new `packages/engine/src/__tests__/ccc-campaign-proof-workflow.test.ts`.
- RED: missing, degraded, replaced, digest-drifted, unknown-proof, stale-input, or false proof extensions must block before provider/session work; stale lease owners must not write terminal state; a long node must renew its workflow lease; cancellation or lease loss must abort the owned node and prevent late success; a claimed campaign work item must execute the complete workflow graph when entered only through `processDueWorkflowWorkItem`, not the one-node `runWorkItem` path.
- GREEN: add a `proof-admission` workflow-extension kind with pinned plugin/version/canonical local source/digest/proof-version identity and a fail-closed result contract. Load proof definitions from the persisted campaign context and bind proof, campaign, bundle, node, attempt, and input digest. Add expected-state/lease-owner/attempt preconditions to native work-item transition, a CAS lease-renewal method, processor-owned AbortController, renewal-loss abort, and signal propagation into the node handler. Treat an already-durable `cancelled` work item as cancellation truth, not a failed late terminal write. For a work item with persisted campaign provenance, make `processDueWorkflowWorkItem` load the mapped task and call the existing full-graph `WorkflowTaskRuntime.run` under the same claimed lease, attempt fence, and cancellation signal; the processor remains the sole terminal-transition owner. Keep `runWorkItem` for ordinary native one-node items, so no scheduler or graph executor is duplicated. Freeze a required campaign-action admission callback on `WorkflowTaskRuntime` so Task 4 can place the same persisted gate immediately before any provider-capable node handler; missing callback for a campaign node fails closed.
- REFACTOR: ordinary non-campaign extensions and workflow items retain compatibility; the strict proof and lease preconditions activate only when campaign provenance exists or when an explicit expected-owner transition is used.
- Verification: `pnpm --filter @fusion/core exec vitest run src/__tests__/workflow-extension-registry.test.ts src/__tests__/postgres/taskstore-remaining.test.ts --silent=passed-only --reporter=dot`; `pnpm --filter @fusion/engine exec vitest run src/__tests__/workflow-work-processor.test.ts src/__tests__/workflow-task-runtime.test.ts src/__tests__/ccc-campaign-proof-workflow.test.ts --silent=passed-only --reporter=dot`; core/engine typechecks and builds; focused lint.
- Done when: proof provenance fails closed and no stale, cancelled, or lease-lost worker can publish success.

### Task 4 — Shared Pre-Provider Admission, Bounds, Drift, And Durable Cancellation

- Surfaces: new `packages/engine/src/ccc-campaign-admission.ts`, `packages/engine/src/executor.ts`, `packages/engine/src/agent-session-helpers.ts`, `packages/engine/src/cli-agent/task-session.ts`, `packages/engine/src/cli-agent/session-manager.ts`, `packages/engine/src/workflow-task-runtime.ts`, `packages/engine/src/workflow-work-processor.ts`, `packages/engine/src/pi.ts`, existing CCC cancellation/effect seams, new `packages/engine/src/__tests__/ccc-campaign-execution.test.ts`, and relevant executor/CLI-agent/workflow/Pi/provider/cancellation tests.
- RED: missing policy, foreign packet/bundle/manifest, wrong target/common-Git identity, wrong base, wrong provider/model, expired campaign deadline, missing/denied approval for a protected live action, missing/degraded proof, or pre-aborted signal must produce zero provider-session and zero effect-reservation calls. At each actual route seam, exhausted request count or saturated concurrency must produce zero Pi transport, zero CLI `manager.spawn`, and zero non-Pi workflow-provider dispatches. One Pi session that triggers an initial call, fallback, and compaction retry must reserve and settle three distinct attempts, enforce the request cap before each one, detect route drift at each dispatch, and never reuse one concurrency lease across overlapping transports. CLI and non-Pi workflow routes must prove the same cap, concurrency, drift, pre-dispatch cleanup, unknown-dispatch hold, and authoritative settlement rules.
- GREEN: expose one `admitCccCampaignAction` implementation and invoke it as a coarse fail-closed check at every native provider-capable entry: immediately before direct `createResolvedAgentSession`, immediately before `launchCliTaskSession`, and immediately before a campaign workflow node handler. Each caller uses a stable persisted action key so a lost response retries the same action identity. The function reloads campaign binding through `TaskStore.getCccCampaignContextForTask`, resolves target and current Git common-directory identity, verifies expected base ancestry and route, runs proof admission, atomically claims any required approval, and returns the persisted winning claim token as part of the immutable admitted context; caller metadata cannot mint or replace it. Persist the token on the action lease and reuse it only for an identical action retry. Carry the admitted context into provider seams without trusting caller-supplied provenance.
- GREEN, route-specific attempt accounting: implement one native `CccProviderAttemptScope` backed by `reserveCccProviderAttempt`, settlement, and reconciliation methods. Pi wraps both `ModelRuntime.stream` and `streamSimple` and reserves immediately before every actual transport, including fallback and compaction retries. A CLI route reserves immediately before `manager.spawn`, holds the attempt for the authoritative subprocess lifetime, enforces a finite adapter-supported turn/request ceiling plus wall-clock deadline, and refuses any adapter that cannot prove those bounds. A provider-capable workflow handler that does not delegate through Pi or CLI must receive the scope and reserve immediately before each handler-owned provider dispatch; a provider-capable handler without that instrumented scope fails closed. The attempt key is deterministic from campaign/action/route/turn/effective provider/effective model/monotonic attempt ordinal; an identical lost-response retry reuses only that exact attempt, while each new outbound attempt increments the finite request count. Atomically reserve request count plus one concurrency lease with database time, reload drift-sensitive truth immediately before dispatch, and settle only that attempt's owner token after its transport or subprocess closes. Pre-dispatch failure records `proved_failed` and releases the attempt; an opened transport without authoritative completion becomes `dispatched_unknown` and remains held until Task 2 reconciliation. Every pre-session action and provider-attempt lease carries the campaign deadline and bounded heartbeat/expiry, so synchronous setup exceptions release immediately and restart may reclaim only proven pre-dispatch abandonment.
- GREEN, authority settlement: add one authoritative campaign-action reconciler that receives exact completion evidence from provider, effect, or Git seams. Confirmed completion CAS-consumes the exact persisted approval claim token and appends its audit transition in the same transaction before emitting terminal success. `dispatched_unknown` or uncertain Git/effect state keeps the token claimed. A pre-dispatch failure preserves the token only for the same bounded action retry; denial blocks before claim; an abandoned claim transitions to expired at its database-time deadline and is never silently returned to issued. Actions without a declared protected target carry no approval token.
- REFACTOR: keep ordinary Fusion execution byte-compatible when no persisted campaign mapping exists. Do not rely on task `customFields`, caller-provided provenance, or provider-returned identity as admission truth.
- Verification: `pnpm --filter @fusion/engine exec vitest run src/__tests__/ccc-campaign-execution.test.ts src/__tests__/ccc-cancellation-resume.provider-matrix.test.ts src/__tests__/executor-user-cancel.test.ts src/__tests__/workflow-work-processor.test.ts src/__tests__/workflow-task-runtime.test.ts --silent=passed-only --reporter=dot`; `pnpm --filter @fusion/core exec vitest run --config vitest.pg.config.ts src/__tests__/postgres/ccc-campaign-native.pg.test.ts --silent=passed-only --reporter=dot`; typechecks/builds/lint.
- Done when: every rejected path proves zero provider/effect calls; Pi, CLI, and non-Pi workflow dispatches each consume their own bounded request/concurrency attempt; exact approval claims reach truthful consumed, claimed, denied, or expired terminal state; and accepted local fake actions preserve exact provider/model identity across restart and cancellation.

### Task 5 — Native Merger And Ref-Update Reconciliation

- Surfaces: new `packages/engine/src/ccc-campaign-git-admission.ts`, `packages/engine/src/merger-ai.ts` at the sole `runAiMerge` chokepoint, `packages/engine/src/merger-ref-update-advance.ts`, `packages/engine/src/merger-overlap-guard.ts`, existing merger/ref tests, and new `packages/engine/src/__tests__/ccc-campaign-git-integration.real-pg.test.ts`.
- RED: lexical/canonical target mismatch, symlink ancestor, invalid ref, dirty integration checkout, foreign HEAD/base, hard overlap, unapproved protected merge, and out-of-manifest mutation must refuse before provider or Git mutation. Inject interruption before CAS, after CAS before success audit, and after success audit. Prove manual conflict hold when the observed ref is neither expected nor new. A landed or reconciled ref must consume the exact winning approval claim once; an unknown or manual-hold outcome must keep it claimed.
- GREEN: derive campaign Git context from the persisted task/import mapping inside `runAiMerge`; re-resolve target and ref immediately before mutation; disable campaign dirty-autostash, auto-sync, push, and fail-open overlap modes. Persist an exact native run-audit intent before `update-ref`. On retry, `ref == new` plus matching intent means landed and calls the Task 4 authoritative action reconciler to CAS-consume the exact approval claim before appending terminal success; `ref == expected` means retryable; any other ref appends manual hold and preserves the claim. Audit failure after a landed CAS must not be classified as foreign concurrency.
- REFACTOR: reuse `advanceIntegrationBranchRef`, `detectMergeOverlap`, native audit, and existing Git subprocess seam. Do not add a second merger, ref store, receipt table, or Git state machine.
- Verification: `pnpm --filter @fusion/engine exec vitest run src/__tests__/merger-ref-update-advance.test.ts src/__tests__/ccc-campaign-git-integration.real-pg.test.ts --silent=passed-only --reporter=dot`; relevant real-Git merger tests; loopback PostgreSQL; typecheck/build/lint/diff hygiene.
- Done when: real local Git proves overlap/dirty/foreign refusal, CAS landing, all interruption outcomes, idempotent reconciliation, manual hold, and truthful terminal audit receipts.

### Task 6 — Joined Local Mixed-Provider Synthetic Campaign

- Surfaces: new `packages/engine/src/__tests__/ccc-campaign-local-acceptance.real-pg.test.ts`, deterministic local provider fixtures under `packages/engine/src/__tests__/fixtures/ccc-campaign/`, existing imported workflow/runtime/executor/receipt readers, and no production control-plane file beyond Tasks 1–5.
- RED: the existing one-node import test cannot prove mixed routes, split/join/barrier order, terminal timing, cancellation, restart, proof admission, bounds, Git reconciliation, or receipt truth together.
- GREEN: import one deterministic multi-node fixture through the real importer, claim it only through `processDueWorkflowWorkItem`, and require that production path to enter full-graph `WorkflowTaskRuntime.run` under the same fenced lease and cancellation signal. Execute the graph through the native executor with two in-memory provider identities, persist split branches and a join/barrier, prove no terminal node runs early, exercise bounded Pi, CLI, and non-Pi workflow attempt scopes, cancel one owned action, restart TaskStore/CliSessionStore, reconcile committed and dispatched-unknown effects, admit exact proofs, enforce per-transport bounds across a forced fallback/compaction retry, and finish through the real local Git campaign gate. Inspect tasks, workflow items, documents, artifacts, audit history, approvals, effects, and terminal receipts through normal public readers, including exact final approval state and same-transaction authority history.
- REFACTOR: test fixtures may inject deterministic provider behavior and interruption checkpoints but may not assert provenance, bypass admission, call production functions out of order, contact a socket, or substitute an in-memory campaign store.
- Verification: `pnpm --filter @fusion/engine exec vitest run src/__tests__/ccc-campaign-local-acceptance.real-pg.test.ts --silent=passed-only --reporter=dot`; zero non-loopback socket/provider observer; disposable repository and PostgreSQL cleanup proof.
- Done when: one user-like local campaign proves the full joined route with exact provider/model identity and zero live provider, credential, billing, or external-network activity.

### Task 7 — Freeze Consolidated E/F Acceptance

- Surfaces: `scripts/run-ccc-pg-proof.mjs`, `docs/testing.md`, this plan, the vault checkpoint, and only the exact focused tests completed above.
- RED: the runner must reject `--wave 6` before the inventory is added; after test creation, the old mapping must reject every new extra name.
- GREEN: add one closed consolidated E/F mapping only after exact names and counts are frozen. Reject missing, duplicate, extra, skipped, pending, todo, timed-out, signaled, forced-killed, failed, missing-output, stale, interrupted, or teardown-failed results. Preserve Wave 4 and Wave 5 mappings unchanged.
- REFACTOR: timing-bearing logs stay outside identity bytes; report exact commands, counts, hashes, Git identities, and cleanup state.
- Verification: focused suites; Wave 4 regression; accepted Wave 5 80/80; consolidated runner; core/engine/CLI typechecks and builds; root lint; real local Git plus loopback PostgreSQL; built CLI; `git diff --check`; exact manifests; clean status.
- Done when: one frozen commit/tree passes central proof and fresh behavioral/PostgreSQL, static/build, and adversarial final-byte council lanes with no P0/P1. Any code or test repair creates a new candidate and invalidates every verdict.

### Plan-Freeze Acceptance Gate

- Central writer verifies every named file and command against live repository structure.
- Terra evidence lane, substituting for unavailable Luna, verifies persistence/schema/traceability.
- Terra runtime lane verifies executor/provider/Git/user-like proof.
- Lower-reasoning Sol lane challenges workflow leasing, cancellation, proof provenance, path/ref admission, crash reconciliation, and false-green coverage.
- AGY adversarial review is advisory only. Native council evidence remains authoritative.
- Accepted verdict: the repaired plan received a fresh native final-byte `PASS — no unresolved P0/P1` after closing per-transport Pi/CLI/non-Pi bounds, full-graph work-processor routing, mandatory TaskStore-derived effect binding, and exact approval-claim reconciliation.
- This accepted documentation commit is the execution predecessor for Task 1 RED. Any implementation discovery that invalidates a frozen contract must amend the plan, update the checkpoint, and receive a fresh review before production edits continue.

## Recovery And Handoff

- Recovery Rule: after compaction or a fresh session, read the vault checkpoint first, then this note, then verify live branch/HEAD/tree/status before issuing work.
- Handoff Rule: the active goal already exists. The sole accepted-spine writer resumes at Task 1 RED and updates the vault checkpoint after each material contract, RED, GREEN, commit, review, or operator gate.
- Resume Rule: local product implementation resumes from accepted Wave 5 `db4861952` through the consolidated native E/F plan above. It does not begin a live provider, credential, billing, non-loopback, fetch, push, merge, release, publication, protected-path, upstream-adoption, or `main` action.
