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
| Accepted Task 1 | Immutable campaign/execution-policy identity plus populated-0035 quarantine proof; closed Wave 5 mapping now 81/81 | `1cbcef3037a86917f5a1b769eac7d84059b7099b` |
| Accepted Task 2 descendant | Native campaign governance, final indivisible `0037`, Task A/B corrections, and P1-03/P1-04 repair | `bdd5cfce44271ba2f13636098e6d736dcf7ea874` |
| Accepted Task 3 descendant | Fail-closed native proof-admission binding, sealed provenance registry, fenced workflow ownership, built-CLI proof host bootstrap, generic-executor refusal, and preserved Wave 5 81-name proof mapping | `dc2d4968d828d623986991f504a530112ba59c3a` |
| Task 4 foundation | Committed pre-provider admission foundation only: coarse campaign/action admission and native provider-attempt accounting, not transport wiring or Task 4 acceptance | `0ff3748319036ba57356afe1625e2d04e95ef850` |
| Accepted Task 4 controller component | Atomic provider-dispatch controller plus production local-Git recheck wrapper; component-only acceptance, not Task 4 acceptance | `79c91f8be245038100741cb5e405b34e01a4b46e` |
| Accepted Phase A/B contract | Generated sidecar, structural compiler, validate, and built CLI | `90c585766b37605aae4be5a9ad6880455e1b7afa` |
| Accepted Phase C import | PostgreSQL/filesystem unit of work, recovery, and idempotency | `d0debd4ee1b50276b149741e23bbe69c18360ba2` |
| Task 3 acceptance branch | Accepted product plus this documentation descendant for Task 4 | `agent/ccc-fusion-task2-plan-repair` |
| Wave 6 and Wave 7 | Speculative evidence only; unchanged replay rejected | Isolated worktrees, not ancestors of integration |
| Primary checkout | Not a product writing target | `main` has a generated-instruction descendant and one preserved pre-existing untracked report |

Accepted Wave 5 is frozen at tree `c273946cfdd7aaceed9a1e7c50f3dcb8290c8149`. Its original closed proof inventory was exactly 80 uniquely named tests: built CLI 10, core sidecar/compiler contract 7, core import/recovery 40, import migration 2, engine authoring/compiler/corpus 20, and native imported execution 1. Accepted Task 1 descendant `1cbcef3037a86917f5a1b769eac7d84059b7099b`, tree `ee4926193a230fb71f0bea97a2d03417ff672b5c`, adds the populated-runnable `0035→0036` quarantine regression and advances the same closed mapping to 81/81 without changing production behavior. Wave 4 regression, relevant typechecks/builds, lint, runner policy and stop-settlement self-tests, manifests, diff hygiene, user-like built CLI, loopback PostgreSQL, and all three fresh Task 1 council lanes passed. The earlier compiler-only baseline `e29732e74f38393eeb0ba25e899dd14e012b9fbf` remains historical custody evidence only.

## Implemented Compiler Surface

- `packages/core/src/ccc-prd/` owns the accepted sidecar, packet, source-span, diagnostic, requirement, proof, task, dependency, workflow, document, artifact, protected-action, bounds, import-intent, and raw-byte identity contracts.
- `packages/engine/src/ccc-prd/` owns accepted structural declaration validation, raw-byte custody, code-unit canonical ordering, distinct validate/compile semantics, and deterministic semantic bundle creation. The earlier table-only extraction, prose protected-action discovery, decoded-text identity, and locale-dependent ordering descriptions are historical and no longer describe live code.
- `packages/cli/src/commands/prd.ts` exposes built `prd author`, `validate`, and `compile` behavior with stable success/refusal/usage exits. The accepted Task 2 descendant implements the designated native authoring path: `prd author` needs no proposal argument, uses bounded injected local transport/fakes, maintains an admitted previous sidecar, and refuses target/base/bounds/review drift. The deterministic proposal-file route remains a labelled compatibility fixture only, not the user path.
- The accepted `ccc-lab-super-r2` oracle declares 3 sidecar requirements across an unchanged 18-source, 7,201-line packet. The packet contains a large unnormalized set of `REQ-`-like tokens, including prefixes and ranges as well as requirement identifiers; different reasonable regex boundaries produce different totals. The sidecar is therefore a representative executable slice, not a measured completeness claim; semantic extraction completeness is unproven and must never be described as full-packet requirement coverage.
- CF-008 is reconciled in the PRD as a sidecar-era supersession of the earlier SRU FR-table field list. The retained SRU Markdown fixture is legacy evidence, not an active compiler oracle and not a reason to reopen accepted Waves 1–5.

## Accepted Wave 5 Contract And Forward Corrections

### Packet And Compiler Contract

Wave 5 accepted the structured sidecar, structural compiler, distinct validate/compile behavior, built CLI, and import unit of work. Accepted Task 2 adds the designated content-generating authoring path without reopening that verdict or using a live provider call. The workflow generates and updates a traceable candidate from unchanged Markdown and presents Ryan only a bounded ambiguity/exception/protected-decision list; Ryan does not manually enumerate requirements or tasks. The sidecar identifies ordered raw-byte-hashed sources and authority roles; stable requirements with exact source spans, acceptance, producer, dependencies, and proof IDs; proof commands with positive oracles and negative controls; declared protected actions with exact targets; finite bounds; admitted write roots; target/base identity; non-goals; provenance, confidence, and unresolved-decision status. Original PRD Markdown remains unchanged.

Task A REDs showed that reordered previous source-bound rows falsely drifted, `requirements: [null]` returned a generic failure, and a zero review ceiling produced engine refusal plus CLI usage exit `2`. GREEN is engine native authoring `11/11`, built CLI command `2/2`, core contract `7/7`, and post-rebuild combined built-CLI `12/12`. The first `12/12` was stale-binary evidence because `dist/bin.js` predated Task B cardinality and its fixture lacked campaign/source/run-audit intents; one fixture-only helper repair added those three exact intents, the ignored CLI artifact was rebuilt from current sources, and the two built CLI files reran `12/12`. This reopened one accepted test helper, not a test name; the strict compiler remained unchanged. Source bindings are now order-insensitive and code-unit-normalized, malformed rows emit `CCC_PRD_AUTHORING_PROPOSAL_INVALID`, and `maxReviewItems=0` is valid. Exact provider/model equality remains intentional; the byte bound remains authoritative with a conservative token bound; pre-stringification observation does not falsify the guarantee. Accepted structural compiler behavior remains unchanged: validate reports bounded diagnostics, compile emits the semantic bundle, both run through the built CLI, and both leave admitted roots unchanged.

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
- Task 1 campaign binding and execution-policy identity remain accepted. Forward corrections do not reopen Waves 1–5 or Task 1; every changed production surface receives fresh descendant proof.
- The independent full audit at `00_MAIN/02_Inbox/REF-AI-ccc-fusion-IndependentFullAudit-2026-07-25.md` is advisory evidence. The disposition ledger below records the root writer's live-source adjudication.
- P1-04/P1-03 repairs and Tasks A/B/2 are accepted only in Task 2 descendant `bdd5cfce44271ba2f13636098e6d736dcf7ea874`; the acceptance record below supersedes earlier development-candidate wording. `0037` is its one indivisible final migration, including the `0036` legacy-row repair; do not create `0038` or reopen Waves 1–5 or Task 1. Tasks 3–10 are next.

## Independent Audit Disposition — 2026-07-25

| Finding | Disposition | Verified reason and smallest response |
|---|---|---|
| P1-01 authoring generator absent | Accept | Accepted `authoring.ts` only calls an injected adapter and the built CLI injects a proposal-file pass-through. An incomplete uncommitted packet-specific draft was discovered during review, preserved as stash `03d9be663712969ed97ec29320c2ce473a220944`, and excluded from product truth because it was neither accepted nor generally valid. Add Task A; no manual proposal-file input in its user acceptance and no packet-specific production lookup table. |
| P1-02 controlling documents stale | Accept | This plan described rejected compiler behavior as current, `docs/testing.md` still said zero requirements, and the vault PRD/Conversion Plan lagged accepted Wave 5 and Task 1. Reconcile current-state blocks while preserving dated history. |
| P1-03 legacy `0036` rows provider-capable | Accept; P0 safety impact | `0036` wrote an unadmitted policy but left import, task, and work-item execution fields active. The root writer escalates impact because the written no-provider guarantee was false. Final `0037` parks only explicit `unadmitted.v0` imports, their ledger tasks, and every provider-capable work item bound to those tasks, including later non-ledger work items; Task 4 adds provider-boundary defense in depth. The partial migration remains unaccepted until all Task 2 DDL shares the same immutable `0037` candidate. |
| P1-04 ordinary MCP error bricks scope | Partially accept | A valid `result.isError: true` is a completed replayable tool result and must commit. A top-level JSON-RPC error, malformed/missing result, disconnect, or abort remains genuine post-dispatch uncertainty and must stay `dispatched_unknown`. |
| P2-01 1.3% oracle coverage | Partially accept | Root reconfirmed 3 declared requirements, 18 authoritative sources, and 7,201 newline-delimited lines. Direct recounts of `REQ-`-like tokens vary with boundary rules and include prefixes and ranges, so no regex total is a verified requirement denominator or product invariant. Always report the 3-requirement representative slice and that completeness is unproven. |
| P2-02 CF-008 unreachable literally | Partially accept | The literal SRU FR-table field list is stale; the sidecar-era contract deliberately supersedes it. Amend CF-008 instead of adding unused legacy fields or reopening accepted Waves 1–5. Retain the SRU fixture as labelled legacy evidence; do not archive or delete it. |
| P2-03 accepted test bodies later changed | Accept as process correction | Later descendant work legitimately reopened two accepted names and reran proof. Every future body change under a frozen name must record “N of M names reopened and re-verified” against the new candidate. |
| P2-04 line-count attribution and enforcement | Accept | `ccc-omniroute-transport.test.ts` is CCC-created and over 2,000 lines; the checker currently reports 56 violations and is not in `test:gate`. Record it as campaign debt, keep the checker advisory for the current repository, and require no unexplained candidate growth plus an explicit final disposition. |
| P2-05 PostgreSQL skip-green outside runner | Partially accept | Bare focused runs can skip; the closed runner is not vulnerable. Focused RED/GREEN counts only with an owned loopback fixture, explicit `FUSION_PG_TEST_URL_BASE`, nonzero executed tests, and zero skipped/pending/todo. Only the closed runner counts as wave acceptance. |
| P2-06 four import-intent types not cross-validated | Accept | `work_item` and `run_audit` can silently reference invented IDs; `campaign` and aggregate `source` lack separate declaration maps. Task B adds explicit per-type relationship/cardinality validation without inventing a second schema. |
| P2-07 zero-effects observer is unwired | Accept as proof defect | No importer `.emit()` call exists, so the observer assertion is vacuous. Task B removes the fake instrument and proves zero provider/effect/hook activity through real durable seams and direct counts. |
| P2-08 activation updates append-only audit | Accept | `activateImport` is the repository's only in-place `run_audit_events` update. Task B appends an active event and preserves the prepared event. |
| P2-09 base commit never verified in Git | Accept as Task 5 requirement | Compiler shape/equality checks are custody, not Git proof. Task 5 must prove the commit exists and the mutation checkout/HEAD is based on the admitted identity immediately before mutation. |
| P2-10 exported manifest path trap | Partially accept | Current callers pass admitted realpaths; the live hole is latent. The audit's suggested lexical absolute-path check does not detect an absolute symlink. Task 5 must use the existing realpath/no-symlink admission before calling the manifest boundary; do not add a misleading two-line guard or branded-path abstraction now. |
| P3 optional runner `expectedNames` | Accept | Task B makes the inventory mandatory for every machine-result command and adds a refusal self-test. |
| P3 duplicate canonical JSON | Reject immediate refactor | The implementations currently emit the same bytes but preserve domain-specific error types and have no observed drift. Coupling PRD and effect protocols adds risk without closing a requirement; revisit only if behavior diverges. |
| P3 no durable static/build artifact | Accept for acceptance packaging | Task 7 persists command, exit, commit/tree, and digest evidence for lint/typecheck/build rather than relying on narrative. |
| P3 orphan SRU fixture | Reject deletion/archive | It is harmless retained legacy evidence and archive/delete work is authority-sensitive. Label it non-oracle; do not spend implementation risk moving it. |
| P3 branch moved during audit | Reject as product defect | The audit observed an active implementation branch, not a frozen acceptance candidate. Candidate freeze still requires one exact clean commit/tree and invalidates verdicts after any byte change; no new lease/control plane is justified. |

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

- Accepted predecessor: Task 1 `1cbcef3037a86917f5a1b769eac7d84059b7099b`.
- Accepted tree: `ee4926193a230fb71f0bea97a2d03417ff672b5c`.
- Preserved closed Wave 5 proof inventory: 81 exact tests. The original accepted Wave 5 product commit remains `db486195224839ff10dee396d3b119623ae59661`; Task 1 adds only the durable populated-0035 regression and its exact expected name.
- Task 1 owns immutable migration `0036_ccc_campaign_native_enforcement.sql`. Task 2 must advance through new forward migration `0037_ccc_campaign_governance.sql`; it must not edit or repurpose `0036`.
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

### Do-First Forward Corrections — P1-04 And P1-03

- P1-04 RED: an effectful MCP tool returned a valid bounded `result.isError: true`; the next effect in the same scope was refused because the first receipt remained `dispatched_unknown`.
- P1-04 GREEN: current-format acknowledged tool errors commit and replay exactly; a second effect in the same scope reaches upstream; restart replay makes no new upstream call. Top-level JSON-RPC errors and incomplete/unparseable responses remain unresolved.
- P1-03 RED: a row carrying the `unadmitted.v0` policy remained `active`, `runnable=1`, and activated after the would-be `0037` apply. A second RED then proved that a later `retry` work item bound to an imported legacy task but absent from the import ledger remained runnable with an active provider-worker lease.
- P1-03 GREEN: the final `0037_ccc_campaign_governance.sql` parks only explicit `unadmitted.v0` imports, pauses and triages only their ledger-owned tasks, and holds every runnable/running/retrying work item bound either directly by the import ledger or through one of those tasks. A simultaneously admitted v1 import remains active and runnable, and terminal work items are not resurrected. The historical focused proof became acceptance evidence only when complete Task 2 governance DDL occupied the same frozen `0037`; do not create `0038`.
- Acceptance: these are descendant corrections, not Wave 5 or Task 1 re-adjudication. Before consolidation they require focused regression, relevant package typechecks, preserved Wave 5 regression, and a fresh candidate council.

### Task A — Generated Packet-Sidecar Authoring Workflow

- Surfaces: `packages/engine/src/ccc-prd/authoring.ts`, one focused authoring adapter module under `packages/engine/src/ccc-prd/`, `packages/cli/src/commands/prd.ts`, existing authoring/corpus/built-CLI tests, and deterministic authoring transport fixtures. Reuse the native model/transport boundary already selected by Fusion; do not add a provider control plane, proposal store, parser, or second sidecar schema.
- RED: built `prd author` given only an admitted unchanged packet, target/base, finite bounds, and an injected deterministic local transport must produce a traceable candidate sidecar and bounded review list without a proposal JSON input. Missing source custody, malformed/partial model output, duplicate or unstable IDs, ambiguous source quotes, unresolved protected targets, unbounded review output, packet drift, and changed-existing-sidecar identity must refuse deterministically. The transport observer must prove the prompt contains ordered raw source custody and the response cannot write outside the one requested candidate path.
- GREEN: implement one production authoring adapter that constructs a bounded packet-to-proposal request, invokes the existing native transport interface, validates the complete structured response through the accepted sidecar authoring contract, preserves stable IDs when maintaining an admitted prior sidecar, and reports only ambiguities, unresolved decisions, exceptions, and exact protected action targets for human review. The CLI selects this adapter through existing runtime configuration; tests inject a deterministic fake at the transport seam. No live provider-backed authoring call is executed in local acceptance.
- REFACTOR: keep source-span resolution, sidecar validation, and canonical identity in their accepted owners. The adapter generates content; it does not duplicate compiler validation or make Ryan translate requirements/tasks.
- Verification: focused engine authoring/corpus tests; built CLI author-without-proposal-file acceptance; malformed-output and bounded-review negative controls; engine/CLI typechecks and builds; lint; `git diff --check`; zero non-loopback/provider/credential/billing observation. The deterministic fake proves user-path wiring, raw-source custody, bounded request/response handling, validation, and stable materialization; it does not by itself prove semantic extraction quality on arbitrary novel packets.
- Done when: an unchanged representative packet reaches a versioned candidate sidecar and bounded exception list through the built user path without manual requirement/task translation or a pre-authored proposal-file argument. Local acceptance proves the bounded authoring contract and failure behavior. Semantic usefulness across novel packets and literal live usefulness remain gated on separately authorized provider/local-inference canaries.
- Accepted descendant evidence: Task A passed engine native authoring `11/11`, CLI `2/2`, post-rebuild built CLI `12/12`, and core contract `7/7` inside Task 2 acceptance. The runner-reopen finding was repaired without changing the preserved 81-name Wave 5 inventory. Do not reopen Waves 1–5 or Task 1.

### Task B — Compiler, Import-Proof, And Runner Integrity Corrections

- Compiler: enforce exactly nine native targets, map `work_item` to `workflow` and `run_audit` to `campaign`, and require exactly one each of campaign, source, and run-audit. The first integrated run exposed legitimate fixture debt: `3` failed / `42` passed because the fixture had zero aggregate intents; the fixture-only repair preserved the strict compiler and the combined engine proof passed `45/45`. Accepted Wave 5 mapping arrays remain unchanged.
- Import proof: activation is append-only (`prepared` then `active`) for audit history. Remove inert effects/events inputs and assert the real database seam; require exact direct counts, including `runAudits === 1`, plus zero-effect receipts and non-database-domain checks. RED was `9` failed / `34` passed because history had only `active`; GREEN uses two exact PostgreSQL files, `43/43`, zero skipped/pending/todo, and ordered prepared-plus-active history on an owned loopback fixture.
- Runner: every machine-results command now requires nonempty `expectedNames`. RED accepted the missing inventory; GREEN is `node scripts/run-ccc-pg-proof.mjs --self-test-policies` passing. The Wave 5 arrays were independently restored against accepted Task 1 before this intentional bounded Task B runner change.
- Accepted descendant evidence: Task B's compiler/import-proof/runner repair is included in the Task 2 frozen candidate. Core, engine, and CLI typechecks, global diff hygiene, full build/lint, and the preserved Wave 5 proof passed. `0037` is no longer a draft: its complete governance DDL and the `0036` legacy-row repair share the same accepted immutable migration bytes.

- Surfaces: `packages/engine/src/ccc-prd/compiler.ts`, focused new descendant compiler tests, `packages/core/src/ccc-prd/importer.ts`, focused import PostgreSQL tests, `scripts/run-ccc-pg-proof.mjs`, and `docs/testing.md`. Keep accepted Wave 5 names and its 81-name mapping unchanged.
- RED: invented `work_item` and `run_audit` import-intent IDs must currently pass; aggregate `campaign`/`source` intent cardinality or target drift must currently pass without a named diagnostic; prepared audit history must disappear on activation; zero-effects observer assertions must pass even though nothing emits; a synthetic machine-result command with no `expectedNames` must bypass inventory enforcement.
- GREEN: add explicit per-type import-intent validation: declared entity maps for task/edge/workflow/document/artifact; work-item-to-workflow binding; run-audit-to-campaign binding; and exact aggregate campaign/source cardinality plus native target checks. Replace activation's in-place audit update with a new native append. Remove unwired observer claims and assert zero effect/provider/hook activity against real durable rows or actual invocation seams. Require a non-empty exact-name inventory for every machine-result runner command.
- REFACTOR: do not add campaign/source declaration objects solely to satisfy the audit; use relationships already present in the accepted sidecar and importer. Preserve domain-specific canonical JSON implementations until a real divergence exists.
- Verification: focused compiler refusal tests; import activation history and zero-effect direct-count tests on owned loopback PostgreSQL; runner policy self-test including missing inventory; preserved Wave 5 81/81; core/engine typechecks and builds; lint; diff hygiene.
- Done when: no admitted import-intent type silently bypasses an applicable semantic relationship, audit history remains append-only, zero-effects evidence observes a real seam, and every machine-result runner lane is closed by exact names.

### Task 2 — Native Run-Audit Receipt, Approval CAS, And Effect Binding

- Surfaces: `packages/core/src/types/run-audit.ts`, `packages/core/src/types/agents.ts`, `packages/core/src/task-store/async-audit.ts`, `packages/core/src/postgres/data-layer.ts`, `packages/core/src/async-approval-request-store.ts`, `packages/core/src/approval-request-store.ts`, `packages/core/src/ccc-effect-receipts.ts`, `packages/core/src/cli-session-store.ts`, new `packages/core/src/postgres/schema/campaign-governance.ts`, `packages/core/src/postgres/schema/project.ts`, `packages/core/src/postgres/schema-applier.ts`, new forward migration `packages/core/src/postgres/migrations/0037_ccc_campaign_governance.sql`, fresh schema `packages/core/src/postgres/migrations/0000_initial.sql`, core exports, new `packages/core/src/__tests__/postgres/ccc-campaign-governance-migration.pg.test.ts`, existing PostgreSQL campaign, approval, effect-receipt, and CLI-session-store tests. Do not modify `0036_ccc_campaign_native_enforcement.sql`. Migration `0037` must not alter the structure, constraints, or identity of the Wave 5 custody tables inspected by `ccc-prd-import-migration.pg.test.ts` (`ccc_prd_imports`, `ccc_prd_import_sources`, `ccc_prd_import_entities`); Task 2 runtime code may update the Task 1 campaign counters and leases those tables intentionally expose. Do not add Task 2 names to the closed Wave 5 migration file.
- RED: preserve the P1-03 legacy-only quarantine proof already in this migration, including the dynamically created non-ledger work-item case. Identical campaign audit event replay must return one row; the same event key with changed binding must refuse; legacy audit, approval, and effect rows may retain an all-null campaign binding, but a partial binding or any typed campaign write without its complete binding must refuse in both application and database paths. Two concurrent approval claims must produce exactly one winner; not-before and issued-expiry must refuse; a claimed approval must not expire while its action lease is active or dispatch truth is unknown; only the winning claim token may consume; denial is legal only before claim; denial, expiry, and consume must each append one same-transaction audit transition. An admitted protected action must persist and reuse that winning claim token across an identical retry, consume it exactly once after authoritative completion, keep it claimed while completion is unknown, and expire rather than silently reissue it only after bounded proven pre-dispatch abandonment. A campaign effect with no complete TaskStore-derived binding must refuse before effect execution; receipt binding drift must collide; an unresolved dispatch must reject blind retry yet accept one exact authoritative no-effect or committed-effect observation.
- GREEN: add first-class campaign/action/event/idempotency/packet/bundle/target/base/provider/model/manifest/binding fields to native RunAuditEvent and deterministic insert-or-read collision semantics. Extend ApprovalRequest compatibly with `issued`, `claimed`, `consumed`, and `expired`; preserve legacy pending/approved/completed callers; make legacy and campaign transitions conditional updates with exact-one-row enforcement. New CCC authority methods require PostgreSQL and fail closed in legacy SQLite mode. Campaign binding columns on native audit, approval, and effect rows are nullable only as a complete legacy tuple: database check constraints require every binding field to be all null or fully populated, and typed campaign writers require the fully populated form. Every campaign effect reservation, dispatch, commit, replay, and reconciliation must reload and bind the complete campaign identity through `TaskStore.getCccCampaignContextForTask`; caller metadata cannot supply it and omission refuses before the effect seam. Preserve `dispatched_unknown` as manual/reconciliation truth until a new native reconcile method receives exact campaign binding, controller generation, authoritative observer identity, observation digest, and an authoritative observation. A no-effect observation may transition only `dispatched_unknown → proved_failed`; a committed-effect observation may transition only `dispatched_unknown → committed`, consume the exact persisted winning approval claim token, and append the approval/audit transition in the same database transaction. An already committed observation remains committed and any mismatched observation collides. Expiry sweeps must not expire approval claims bound to an active action lease or `dispatched_unknown` receipt; those claims remain claimed until authoritative reconciliation. Only a bounded, proven pre-dispatch abandonment may expire a claimed token.
- REFACTOR: split run-audit and approval Drizzle definitions out of oversized `project.ts` while re-exporting the same symbols. Keep the one final forward migration at `0037`, preserve its P1-03 data repair, explicit constant/path/apply registration, and `SCHEMA_BASELINE_VERSION = "0037"`; preserve RLS/project binding, add paired-null campaign-binding constraints, prove fresh-schema parity, prove `0036→0037` upgrade-once, and preserve unchanged legacy read shapes. `0037` must be idempotent both after a `0036` database and after the fresh `0000_initial.sql` schema. Never rewrite committed migration `0036` or create `0038` for this campaign slice. Do not commit, accept, or durably apply an intermediate quarantine-only `0037`: the version marker may advance only with the complete final Task 2 migration bytes.
- Verification: start one task-owned disposable loopback PostgreSQL fixture, set `FUSION_PG_TEST_URL_BASE` to that fixture, require `FUSION_PG_TEST_SKIP` to be unset or not `1`, and preserve reporter evidence showing a nonzero executed-test count with zero skipped, pending, or todo tests before accepting the focused PostgreSQL result. Then run `pnpm --filter @fusion/core exec vitest run --config vitest.pg.config.ts src/__tests__/postgres/ccc-campaign-governance-migration.pg.test.ts src/__tests__/postgres/ccc-campaign-native.pg.test.ts src/__tests__/postgres/cli-session-store.pg.test.ts src/__tests__/postgres/satellite-db-injected-stores.test.ts --silent=passed-only --reporter=dot`; focused sync approval and effect-receipt tests; direct negative controls for partial audit/approval/effect bindings through typed writers and SQL; schema-applier registration/parity; explicit `SCHEMA_BASELINE_VERSION === "0037"` proof; fresh-baseline-plus-0037 no-op/idempotence proof; core typecheck/build; focused lint; `git diff --check`. Until the future closed `--wave 6` inventory exists, an exit-zero focused run with any skipped Task 2 PostgreSQL test is a refusal, not proof. Task 2 tests enter that future inventory only after their exact names freeze; the accepted Wave 5 command and its 81-name mapping remain unchanged.
- Done when: `0036→0037` upgrade and fresh-schema parity, all-null-or-complete binding enforcement, audit replay/collision, approval one-winner authority, expiry/not-before, exact-token completion consumption, same-transaction history, both authoritative effect-reconciliation outcomes, effect collision, and restart reads are directly proven.

### Task 3 — Fail-Closed Proof Admission And Fenced Workflow Ownership

- Surfaces: `packages/core/src/ccc-prd/types.ts`, sidecar schema/canonical/compiler/authoring fixtures and tests, `packages/core/src/ccc-campaign/types.ts`, `packages/core/src/ccc-campaign/store.ts`, `packages/core/src/ccc-campaign/custody.ts`, `packages/core/src/workflow-extension-types.ts`, `packages/core/src/workflow-extension-registry.ts`, PluginLoader/native registration provenance, `packages/core/src/task-store/async-workflow-workitems.ts`, `packages/core/src/task-store/workflow-workitems-ops-2.ts`, workflow transition types, `packages/engine/src/ccc-prd/authoring.ts`, `packages/engine/src/ccc-prd/native-authoring-adapter.ts`, `packages/engine/src/plugin-workflow-extension-adapter.ts`, plugin loader/runner seams, `packages/engine/src/workflow-task-runtime.ts`, `packages/engine/src/workflow-work-processor.ts`, new `packages/engine/src/ccc-campaign-proof-admission.ts`, `packages/cli/src/commands/prd.ts`, built-CLI authoring tests, existing extension/runtime/processor tests, and new `packages/engine/src/__tests__/ccc-campaign-proof-workflow.test.ts`. This is a forward descendant of accepted Task 2 and does not reopen Waves 1–5, Task 1, or Task 2.
- Expected sidecar binding: `CccPrdProof.admission` remains optional for backward-compatible `sidecar.v1` validation/compile and contains `schema: "ccc-prd.proof-admission.v1"`, `pluginId`, `pluginVersion`, `extensionId`, `proofVersion`, `extensionRootRelativeSource`, raw-byte `extensionSourceSha256`, raw-byte `extensionManifestSha256`, and `definitionSha256`. `extensionRootRelativeSource` is relative to the trusted real plugin/native package root, never `targetRepository.path`. These are expected bindings, never authority by themselves. Compute `definitionSha256` over the canonical mapped proof with the entire `admission` object omitted.
- Host authority and registry mutation safety: the native registry definition carries host-derived registration provenance stamped by PluginLoader/native host: manifest plugin ID/version, trusted real plugin/native package root, real entry path, raw entry-byte digest, and raw manifest-byte digest. A `proof-admission` contribution may provide only its evaluator and `proofVersion`; it cannot assert plugin/version/root/source/manifest identity. Proof-admission register/upsert without complete host provenance refuses at the registry boundary. The fixed native extension must be one self-contained/bundled runtime entry: registration rejects relative, file-URL, or dynamic local runtime dependencies outside the hashed entry; type-only imports that compile away and Node built-ins are allowed. Entry bytes plus raw package manifest therefore cover its locally executable Task 3 code. External or multi-file proof extensions remain blocked until a later explicit persisted-selection and dependency-closure contract. This closes local dependency provenance without a dependency graph or store. The registry copies, freezes, and seals proof identity, provenance, and evaluator pointer into an internal record; it never stores caller-owned mutable objects. `get`/`list` expose readonly frozen snapshots, while internal degraded state changes only through registry methods. On same-ID proof identity drift, retain the old internal record, mark it runtime-fault degraded, and refuse replacement. RED mutates the original contribution, returned `get`, and `list` snapshot and proves identity/evaluator remain unchanged or the mutation refuses. Ordinary extensions remain compatible unless proof-specific behavior is invoked.
- Authoring: after proposal mapping, the designated authoring workflow—not the model, proposal JSON, or Ryan—looks up only the host-owned native registry ID `plugin:fusion-native:ccc-proof-admission` and stamps every newly generated proof with that registration's host-derived expected binding plus definition hash. Standalone built CLI authoring must explicitly bootstrap this fixed native host registration before stamping; a successful built-CLI result without that bootstrap is impossible. Missing, degraded, or colliding registration refuses authoring. External proof-admission extensions remain possible only through a later explicit persisted selection contract, never ambient discovery. Existing sidecars without admission remain validate/compile-compatible, but campaign execution fails closed until maintenance authoring stamps them. Do not add a target-repository proof-source field: proof commands, oracles, and source spans bind through definition plus bundle; target/base/live-Git drift remains a separate Task 4/5 control.
- Execution authority: one no-migration TaskStore custody API—`getCccCampaignContextForTask` or one delegate that reuses it—returns the mapped semantic task ID and immutable canonical task proof-ID set derived from the already reconstructed `canonicalBundle` plus import-entity mapping. Before trusting that bundle, independently recompute `bundleHash` from canonical bundle bytes with `bundleHash` omitted and require equality; stored/embedded equality alone and the current task-omitting manifest are insufficient proof of task authority. Missing mapping, collision, rehash failure, or mismatch refuses. Engine must not requery or reconstruct a parallel custody path. The returned Task authority must still have a unique, nonempty, canonical `Task.sourceMetadata.proofIds` set, matching `sourceMetadata.bundleHash`, and exact equality with the immutable canonical task set before use. Caller input and a requirement-proof union remain forbidden.
- Execution custody: for both entry and manifest, validate the lexical path, pre-resolve it within the trusted real root, open the exact file with platform-supported `O_NOFOLLOW | O_CLOEXEC` where available, `fstat` the opened handle, post-resolve/stat the candidate, and require opened-handle device/inode equality with the post-resolved contained file. Read and hash raw bytes only from that same open handle, close it before invoking the already-registered in-memory evaluator, and refuse when a required no-follow or file-identity guarantee is unavailable. This rejects parent retarget between check/open without string-path reads; the evaluator receives no path. The native evaluator must be proof-aware and substantiate the proof's declared positive oracle and negative-control semantics or refuse unsupported definitions; a generic exit-zero shell evaluator is inadmissible. It receives immutable engine-built input plus `AbortSignal` and returns `{ outcome: "pass" | "fail", evaluatedInputSha256, summary }`; engine accepts pass only when the echoed digest equals the current canonical input digest and the signal remains live, otherwise it refuses as false, stale, or aborted. Bind and audit through native `RunAuditEvent` with campaign, import, bundle, manifest, task, node, work item, owner, attempt, proof definition, and input digest; add no proof receipt store.
- Proof RED/GREEN: missing, degraded, replaced, source/manifest/definition-drifted, stale, unknown, false, incomplete, or ambiguously registered proof authority must block before evaluator/provider/session work. The named registry RED changed identity under the same extension ID and incorrectly left the old entry non-degraded (`1` failed, `4` passed); degrade-and-refuse GREEN is blocking.
- Workflow fencing: add `exhausted` to the async terminal set and prove by PostgreSQL RED that it does not emit a false audit. Freeze a per-invocation runtime API equivalent to `run(task, settings, { signal, workItemFence, deferCompletionSummary: true })`; never mutate constructor dependencies. The processor owns the AbortController and renews the workflow lease at a fraction of `opts.leaseDurationMs` through exact owner/attempt CAS; cancellation or lease loss aborts execution. The processor alone terminal-transitions with `expectedState: "running"`, owner, and attempt. For campaign success, terminal CAS must succeed first; the processor then freshly reloads post-CAS task state and writes the completion summary using current task/reason/workflow/run values. Runtime writes no campaign completion summary and need not return prebuilt summary bytes. Durable cancellation returns cancelled truth; stale/takeover CAS uncertainty is surfaced. Widen narrowed patch types as needed; ordinary non-campaign `runWorkItem` behavior remains unchanged.
- Generic-consumer closure: persisted `getCccCampaignContextForTask` is the only campaign authority; exact `ccc-prd` task/work-item shapes are suspicion only. Before settings, provider, or runner effects, generic `TaskExecutor` must fail closed on authoritative campaign context or an unresolved exact marker, then defend again before work-item transition/runner. Authority lookup error fails closed when campaign custody, a supplied fence, or an exact import marker is present; an ordinary non-campaign lookup error preserves compatibility. It returns without `handleGraphFailure`, parking, pause, terminal transition, or consuming the runnable/held item. Public `TaskExecutor.execute` and scheduler-like tests must prove zero dependency, ephemeral, task, and work-item mutation plus correct `graphRouting` and preheld-semaphore cleanup; private `executeWorkflowGraph` tests are defense-level only. Add the lookup race where the first authority read returns null but the mandatory second read immediately before transition/runner observes campaign custody and refuses. `alreadyClaimed` is routing-lock ownership only, never campaign authority. Direct `WorkflowTaskRuntime.run` must refuse before graph resolution when a campaign lacks a `workItemFence` or marker/fence custody is missing or unresolved; ordinary tasks remain compatible. The sanctioned processor continuation remains untouched.
- Public one-node closure: AGY follow-up `9aa1d951-3634-4246-8b81-7fdca6f0a002` found public `WorkflowTaskRuntime.runWorkItem` is a direct unfenced campaign surface. Root verified its only production caller is `processDueWorkflowWorkItem`, but the exported method and `ccc-prd-import-execution.real-pg.test.ts` directly accept imported work items. Before `getTask`, resolution, transition, or handler work, `runWorkItem` must refuse authoritative campaign context or an exact imported-work-item marker and leave the item untouched; ordinary behavior remains compatible. The later real-PG proof must exercise the sanctioned process-due/full-graph route, not direct unfenced `runWorkItem`. This is blocking Task 3 defense in depth and does not change Task 5 bootstrap ownership.
- Fence authority preflight: before workflow resolution, one native TaskStore method must validate the exact work-item ID, origin task, run ID, `running` state, lease owner, attempt, and unexpired lease using database time. Missing, forged, stale, mismatched, or expired fence custody refuses with zero resolution, handler, summary, or state mutation. Per-proof same-transaction audit revalidation remains mandatory because preflight can race; orchestration-only graphs still require preflight. Reuse the current store/database and processor; add no new store, database, scheduler, or control plane.
- Blocking imported-execution repair: before Task 3 freeze, replace the direct successful `runWorkItem` call at line 44 of `ccc-prd-import-execution.real-pg.test.ts` with the sanctioned `processDueWorkflowWorkItem` full-graph route. Update that exact closed proof-runner inventory/name only if the repaired test requires it, leave unrelated Wave 5 names unchanged, and rerun the exact real-PG file plus closed mapping. This forward security preservation does not reopen accepted Wave 5 adjudication; Task 5 still owns the production `InProcessRuntime` bootstrap.
- Current development evidence: runtime focused engine `90/90`; focused combined PostgreSQL `90/90`; final author/admission engine `60/60`; built CLI `14/14`; lexical provenance RED on two false accepts then GREEN `12/12`; relevant typechecks, build, lint, and diff hygiene are green. The generic-refusal correction is in RED/GREEN progress. These are dirty development bytes, not Task 3 acceptance; the candidate freeze is suspended pending an integrated proof and fresh no-P0/P1 council.
- Latest plan council: behavioral and architecture reviews failed exact plan `24c6cde8…`, testing `c775f3fb…`, and checkpoint `e3c3677a…` with no P0. Root accepted all blocking P1s above, including public-path cleanup/race proof and mixed-queue production eligibility. Its independent four-file engine run passed `110/110`; the worker's earlier `98` count came from a narrower/different snapshot. This is development evidence only, not final integrated acceptance, and the candidate freeze remains suspended.
- AGY follow-up session `9aa1d951-3634-4246-8b81-7fdca6f0a002` returned `PASS WITH REQUIRED RACE/FIELD TESTS` for the proposed pre-resolution database-time fence validator, public pre-mutation plus pre-transition double-check, and existing-queue targeted campaign selection. Accept its expired-lease, public no-update/worktree/session, and mixed-queue no-stall tests. Interpret its `createProofAdmission` test location as runtime/store-preflight coverage, not authority moved into the evaluator. Consultation remains advisory.
- Accepted amended-plan freeze receipt: exact reviewed SHA-256 values were plan `0365b456b03c579b09b2bf3d630650d30023679710f3ca6a81860c00a1e7f4ee`, testing `fb59def10b675482c3547062197a5bdb86e2b9cf444e5416c0f287bc1b5ad10c`, and checkpoint `8a968f23f3608d5557f9a42e6a9c3bf22f8c3158370006e10aa75d19cf3ba257`. Native behavioral PASS had no P0/P1 and one P2: freeze exact Task 5 bootstrap/mixed-queue names before the Task 5 candidate. Native architecture PASS had no P0/P1/P2 and recommends a plain database-time `SELECT`, not a transaction lock, for preflight. AGY session `9aa1d951-3634-4246-8b81-7fdca6f0a002` exact-byte PASS had no contract P0/P1. Implementation may resume; Task 3 product remains unaccepted. This receipt only records review and does not alter the reviewed contract.
- Council adjudication: the first exact-byte freeze reviewed plan `b08ea7…`, testing `7e749b…`, and checkpoint `2bea4e…`; native behavioral, native architecture, and AGY session `7b25a79f-efad-48ac-8e37-2ea3879c2c0d` all returned FAIL with no accepted P0. AGY's P0 registry label is rejected because the defect is the named pre-production RED, but its GREEN remains blocking. Root/host stamping is accepted; definition hashing, TOCTOU custody, and concurrency findings are partially accepted exactly as specified above. Requirement union is rejected because the explicit task set is authority, while immutable-bundle equality is added. A mandatory migration helper is rejected because deliberate fail-closed execution plus maintenance authoring performs the upgrade. Core `exhausted` and per-invocation signal P1 findings are accepted.
- Second council adjudication: the second freeze reviewed plan `7334da2…`, testing `ed67ba1…`, and checkpoint `3a7641a…`. Native behavioral returned PASS. Native architecture returned FAIL with no P0 and two accepted P1s: one native custody API and immutable internal registry records. AGY session `3957b94f-008d-449d-888b-e762b4e38c9e` returned FAIL; accept its file-descriptor binding P1 and the substance of provenance enforcement at the registry boundary, whose P2 overlaps the architecture P1. Reject its prebuilt-summary P2 because fresh re-derivation after terminal CAS is safer and the current helper requires task/reason/workflow/run rather than stale prebuilt bytes.
- Final repair 2 plan-freeze receipt: exact reviewed bytes were plan SHA-256 `cb989d9a92f650ed9e694cab59d7be366b6ce07991660122820efa0c778946b7`, testing SHA-256 `e876dd9bc5a215b4ca662045322a7499e46820799c007350162d2a0307414152`, and checkpoint SHA-256 `ca017a85df21ed5fb43ef6ecc63be9c364bf383182f6c27a54cd5ac4551da828`, with documentation predecessor `97e102c90da91535b5a06b6f13e91a8aeb112855`. Native behavioral returned PASS with no P0/P1. Native architecture/concurrency returned PASS with no P0/P1 and one implementation-time P2: compute the independent bundle rehash from the compiler's exact `bundleWithoutHash` projection. AGY session `15ac8b8a-540d-453d-8afd-dc81b0d5dc75` initially returned FAIL on six scope misreads, all rejected after source/contract verification: work-item CAS plus best-effort summary is not task/proof atomicity; bundle rehash is synchronous within one custody read; workflow lease-TTL CAS is not a permanent process lock; device/inode identity is the deliberately local POSIX fail-closed scope; generic exit refusal is proof-only; and dependency refusal is limited to the fixed native proof entry. One allowed follow-up returned PASS with no P0/P1. Consultation is evidence, not authority. This receipt-only text does not alter the reviewed Task 3 contract.
- REFACTOR: reuse the accepted sidecar canonicalizer, PluginLoader/native host provenance, native extension registry, and existing workflow processor. Add no migration, `0038`, proof store, database, parser, scheduler, or parallel control plane.
- Verification: sidecar compatibility and newly generated host-stamped admission tests; built-CLI fixed-registration bootstrap plus missing/degraded/collision refusals; registry provenance/identity-drift plus caller/get/list mutation REDs; fixed-native-entry negative controls for relative/file/dynamic local runtime dependencies; native TaskStore custody, independent canonical-bundle rehash, proof-set equality, and database-time fence preflight; file-descriptor-bound entry/manifest race controls; proof-aware positive-oracle/negative-control support and generic-exit-zero refusal; `exhausted` PostgreSQL no-audit proof; exact work-item owner/attempt renewal and terminal-CAS tests; engine runtime cancellation/takeover/post-CAS-summary tests; `pnpm --filter @fusion/engine exec vitest run src/__tests__/workflow-work-processor.test.ts src/__tests__/workflow-task-runtime.test.ts src/__tests__/ccc-campaign-proof-workflow.test.ts src/__tests__/executor-fast-mode-workflows.test.ts --silent=passed-only --reporter=dot`; `pnpm --filter @fusion/engine exec vitest run src/__tests__/ccc-prd-import-execution.real-pg.test.ts --silent=passed-only --reporter=dot` against an owned loopback PostgreSQL fixture; repaired exact closed runner mapping; core/engine/CLI typechecks and builds; focused lint; `git diff --check`.
- Done when: host-stamped proof identity, one immutable TaskStore custody route with independent bundle rehash, sealed registry records, self-contained native entry provenance, file-descriptor-bound raw-byte custody, proof-aware evaluator result, and workflow fencing all fail closed, and no stale, cancelled, exhausted, or lease-lost worker can publish success or a premature/stale completion summary. The Task 3 repair 2 plan freeze is accepted and frozen; implementation may proceed, but Task 3 remains unaccepted product until GREEN and a fresh integrated council.

### Task 4 — Shared Pre-Provider Admission, Bounds, Drift, And Durable Cancellation

- Surfaces: new `packages/engine/src/ccc-campaign-admission.ts`, `packages/engine/src/executor.ts`, `packages/engine/src/agent-session-helpers.ts`, `packages/engine/src/cli-agent/task-session.ts`, `packages/engine/src/cli-agent/session-manager.ts`, `packages/engine/src/workflow-task-runtime.ts`, `packages/engine/src/workflow-work-processor.ts`, `packages/engine/src/pi.ts`, existing CCC cancellation/effect seams, new `packages/engine/src/__tests__/ccc-campaign-execution.test.ts`, and relevant executor/CLI-agent/workflow/Pi/provider/cancellation tests.
- RED: missing policy, foreign packet/bundle/manifest, wrong target/common-Git identity, wrong base, wrong provider/model, expired campaign deadline, missing/denied approval for a protected live action, missing/degraded proof, or pre-aborted signal must produce zero provider-session and zero effect-reservation calls. At each actual route seam, exhausted request count or saturated concurrency must produce zero Pi transport, zero CLI `manager.spawn`, and zero non-Pi workflow-provider dispatches. One Pi session that triggers an initial call, fallback, and compaction retry must reserve and settle three distinct attempts, enforce the request cap before each one, detect route drift at each dispatch, and never reuse one concurrency lease across overlapping transports. CLI and non-Pi workflow routes must prove the same cap, concurrency, drift, pre-dispatch cleanup, unknown-dispatch hold, and authoritative settlement rules.
- GREEN: expose one `admitCccCampaignAction` implementation and invoke it as a coarse fail-closed check at every native provider-capable entry: immediately before direct `createResolvedAgentSession`, immediately before `launchCliTaskSession`, and immediately before a campaign workflow node handler. Each caller uses a stable persisted action key so a lost response retries the same action identity. The function reloads campaign binding through `TaskStore.getCccCampaignContextForTask`, resolves target and current Git common-directory identity, verifies expected base ancestry and route, and compares the live task's `baseCommitSha`, `modelProvider`, and `modelId` with persisted campaign custody immediately before provider use. It then runs proof admission, atomically claims any required approval, and returns the persisted winning claim token as part of the immutable admitted context; caller metadata cannot mint or replace it. Persist the token on the action lease and reuse it only for an identical action retry. Carry the admitted context into provider seams without trusting caller-supplied provenance.
- GREEN, route-specific attempt accounting: implement one native `CccProviderAttemptScope` backed by `reserveCccProviderAttempt`, settlement, and reconciliation methods. Pi wraps both `ModelRuntime.stream` and `streamSimple` and reserves immediately before every actual transport, including fallback and compaction retries. A CLI route reserves immediately before `manager.spawn`, holds the attempt for the authoritative subprocess lifetime, enforces a finite adapter-supported turn/request ceiling plus wall-clock deadline, passes a concrete subprocess turn limit when the adapter supports one, reconciles actual consumed turns when the adapter reports them, and refuses any adapter that cannot prove the declared bounds before launch. A provider-capable workflow handler that does not delegate through Pi or CLI must receive the scope and reserve immediately before each handler-owned provider dispatch; a provider-capable handler without that instrumented scope fails closed. The attempt key is deterministic from campaign/action/route/turn/effective provider/effective model/monotonic attempt ordinal; an identical lost-response retry reuses only that exact attempt, while each new outbound attempt increments the finite request count. Atomically reserve request count plus one concurrency lease with database time, reload drift-sensitive truth immediately before dispatch, and settle only that attempt's owner token after its transport or subprocess closes. Pre-dispatch failure records `proved_failed` and releases the attempt; an opened transport without authoritative completion becomes `dispatched_unknown` and remains held until Task 2 reconciliation. Every pre-session action and provider-attempt lease carries the campaign deadline and bounded heartbeat/expiry, so synchronous setup exceptions release immediately and restart may reclaim only proven pre-dispatch abandonment.
- GREEN, authority settlement: add one authoritative campaign-action reconciler that receives exact completion evidence from provider, effect, or Git seams. Confirmed completion CAS-consumes the exact persisted approval claim token and appends its audit transition in the same transaction before emitting terminal success. `dispatched_unknown` or uncertain Git/effect state keeps the token claimed. A pre-dispatch failure preserves the token only for the same bounded action retry; denial blocks before claim; an abandoned claim transitions to expired at its database-time deadline and is never silently returned to issued. Actions without a declared protected target carry no approval token.
- REFACTOR: keep ordinary Fusion execution byte-compatible when no persisted campaign mapping exists. Do not rely on task `customFields`, caller-provided provenance, or provider-returned identity as admission truth.
- Verification: `pnpm --filter @fusion/engine exec vitest run src/__tests__/ccc-campaign-execution.test.ts src/__tests__/ccc-cancellation-resume.provider-matrix.test.ts src/__tests__/executor-user-cancel.test.ts src/__tests__/workflow-work-processor.test.ts src/__tests__/workflow-task-runtime.test.ts --silent=passed-only --reporter=dot`; `pnpm --filter @fusion/core exec vitest run --config vitest.pg.config.ts src/__tests__/postgres/ccc-campaign-native.pg.test.ts --silent=passed-only --reporter=dot`; typechecks/builds/lint.
- Done when: every rejected path proves zero provider/effect calls; Pi, CLI, and non-Pi workflow dispatches each consume their own bounded request/concurrency attempt; exact approval claims reach truthful consumed, claimed, denied, or expired terminal state; and accepted local fake actions preserve exact provider/model identity across restart and cancellation.

### Task 5 — Native Merger And Ref-Update Reconciliation

- Surfaces: new `packages/engine/src/ccc-campaign-git-admission.ts`, `packages/engine/src/merger-ai.ts` at the sole `runAiMerge` chokepoint, `packages/engine/src/merger-ref-update-advance.ts`, `packages/engine/src/merger-overlap-guard.ts`, the production `InProcessRuntime` bootstrap and authoritative TaskExecutor/runtime assembly, existing merger/ref tests, and new `packages/engine/src/__tests__/ccc-campaign-git-integration.real-pg.test.ts`.
- RED: lexical/canonical target mismatch, symlink ancestor, invalid ref, dirty integration checkout, foreign HEAD/base, hard overlap, unapproved protected merge, and out-of-manifest mutation must refuse before provider or Git mutation. Inject interruption before CAS, after CAS before success audit, and after success audit. Prove manual conflict hold when the observed ref is neither expected nor new. A landed or reconciled ref must consume the exact winning approval claim once; an unknown or manual-hold outcome must keep it claimed.
- GREEN: derive campaign Git context from the persisted task/import mapping inside `runAiMerge`; require the admitted base to resolve to a local commit object; use the existing realpath/no-symlink admission before manifest evaluation; and re-resolve target, common Git directory, checkout `HEAD`, base ancestry, and ref immediately before mutation. Disable campaign dirty-autostash, auto-sync, push, and fail-open overlap modes. Persist an exact native run-audit intent before `update-ref`. On retry, `ref == new` plus matching intent means landed and calls the Task 4 authoritative action reconciler to CAS-consume the exact approval claim before appending terminal success; `ref == expected` means retryable; any other ref appends manual hold and preserves the claim. Audit failure after a landed CAS must not be classified as foreign concurrency.
- GREEN, production ownership: bootstrap and reverify the fixed native proof contribution in the long-lived `InProcessRuntime`, construct exactly one `WorkflowTaskRuntime` from authoritative TaskExecutor/runtime assemblies, route persisted campaign work exclusively through `processDueWorkflowWorkItem`, and prove the legacy generic executor cannot consume it. Extend or reuse the native claim/scheduler seam to target an authoritative campaign candidate in a mixed ordinary-plus-campaign due queue while preserving symbol and lease CAS. Prove the mixed queue drains both classes, campaign work runs only through `processDueWorkflowWorkItem`, and ordinary work stays on the existing route. This is required before a live or synthetic campaign runs. Do not add a second scheduler or control plane.
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
- Verification: focused suites; Wave 4 regression; preserved Wave 5 81/81; consolidated runner; core/engine/CLI typechecks and builds; root lint; real local Git plus loopback PostgreSQL; built CLI; `git diff --check`; exact manifests; clean status.
- Done when: one frozen commit/tree passes central proof and fresh behavioral/PostgreSQL, static/build, and adversarial final-byte council lanes with no P0/P1. Any code or test repair creates a new candidate and invalidates every verdict.

### Task 8 — Real-Packet Local Preflight

- Surfaces: the Task A authoring path, accepted validate/compile/import commands, normal task/workflow/document/artifact readers, disposable target repositories/worktrees, and the Task 7 loopback PostgreSQL harness. Preserve every source packet byte.
- RED: no current user-like lane carries an unchanged `ccc-lab-super` or `ccc-autocode-neo` packet through author, validate, compile, import, restart inspection, proof admission, and protected-action preflight without a proposal-file argument or live provider.
- GREEN: generate versioned candidate sidecars for `ccc-lab-super` and `ccc-autocode-neo` through the admitted authoring transport with deterministic local fakes. Select a third packet only if ordinary live discovery finds one without protected access or external authority. For each admitted packet, record ordered source custody, representative coverage limits, bounded review items, exact bundle/import counts, restart visibility, Git/base admission, proof admission, and blocked protected actions in disposable local targets.
- REFACTOR: reuse the Task 6 campaign fixture and Task 7 proof harness; do not create packet-specific production parsers, a second preflight state machine, or a fake claim of semantic completeness.
- Verification: built CLI author/validate/compile/import; normal public readers before and after restart; disposable local Git and loopback PostgreSQL; zero non-loopback calls, credentials, billing, live providers, or operator actions.
- Done when: at least one real packet reaches complete local preflight and both named packets have either passed or one exact evidence-backed local blocker. The three live provider-backed canaries remain literal-completion operator gates.

### Task 9 — Shallow Completion And Merge Readiness

- Surfaces: CLI help and compatibility aliases, operator-facing documentation, `docs/testing.md`, this continuation plan, the vault PRD/Conversion Plan/checkpoint, divergence ledger, worktree inventory, and frozen proof artifacts. Do not perform deep internal renames.
- RED: stale or contradictory current-state prose, missing aliases/help, undocumented intentional worktree state, unresolved speculative branches, or proof artifacts that cannot be tied to one commit/tree block merge readiness even when tests pass.
- GREEN: reconcile current code, commands, identities, manifests, checkpoint state, and operator help; preserve dated history as history; classify every speculative Wave 6/7 branch as selectively harvested, superseded, or rejected; and make every campaign worktree clean or precisely document the intentional state and recovery command.
- REFACTOR: remove duplicate current-state prose only when one canonical pointer is clearer. Do not rename core product concepts or add a documentation control plane.
- Verification: built `fn --help` and CCC aliases; compatibility tests; manifest hashes; `git diff --check`; worktree/branch/status inventory; exact frozen proof artifact digests; fresh user-facing inspection.
- Done when: a new agent or Ryan can identify the accepted spine, run the proof, understand every remaining gate, and prepare a merge without resolving hidden local state.

### Task 10 — UP-N Local Boundary And Operator Packet

- Surfaces: only upstream evidence already present locally, the divergence ledger, compatibility tests, frozen proof bundle, and one operator decision packet. No remote fetch or adoption branch.
- RED: any proposed upstream range whose local commits, changed paths, compatibility impact, expected effects, or rollback cannot be named is not ready for operator review.
- GREEN: inspect only locally present upstream evidence; finish every safe compatibility and divergence proof; and record the exact proposed range, commands, expected effects, rollback, and current proof for the remaining adoption decision. If no locally present range is admissible, record that bounded result instead of fabricating one.
- REFACTOR: keep this a decision packet, not an adoption framework.
- Verification: local object/ancestry/path inspection, compatibility tests, frozen manifest/proof hashes, and clean/declared worktree state.
- Done when: every safe local UP-N prerequisite is complete and the only remaining adoption action is a narrow operator-authority gate. Do not fetch, create an adoption branch, push, merge, release, publish, or mutate `main`.

### Plan-Freeze Acceptance Gate

- Central writer verifies every named file and command against live repository structure.
- Terra evidence lane, substituting for unavailable Luna, verifies persistence/schema/traceability. This is a recorded substitution, not a Luna verdict.
- Terra runtime lane verifies executor/provider/Git/user-like proof.
- Lower-reasoning Sol lane challenges workflow leasing, cancellation, proof provenance, path/ref admission, crash reconciliation, false-green coverage, and the user-facing paths through `session-manager.ts`, `executor.ts`, `pi.ts`, the policy modules, and the compiler body rather than reviewing tests alone.
- AGY adversarial review is advisory only. Native council evidence remains authoritative.
- Prior consolidated-plan acceptance: commit `00543100fc8c2447ba487e9756f714857741c253` received a fresh native final-byte `PASS — no unresolved P0/P1` after closing per-transport Pi/CLI/non-Pi bounds, full-graph work-processor routing, mandatory TaskStore-derived effect binding, and exact approval-claim reconciliation. Task 2 subsequently received its own fresh final-byte council as recorded below.
- The original accepted documentation commit remains the execution-plan predecessor for Task 1. This post-audit amendment preserves every accepted Task 1 byte, reserves one indivisible `0037` for campaign governance, isolates its migration proof from the closed Wave 5 runner, and explicitly advances fresh-schema baseline ownership to `0037`. The 2026-07-25 fresh plan-freeze council returned three independent PASS verdicts with no unresolved P0/P1 after the migration-marker, schema-name, dynamic-work-item, Git-state, and oracle-count repairs. Any later discovery that invalidates a frozen contract must amend the plan, update the checkpoint, and receive a fresh review before dependent production edits continue.

### Task 2 Frozen Acceptance — 2026-07-25

- Accepted product: `bdd5cfce44271ba2f13636098e6d736dcf7ea874`; branch `agent/ccc-fusion-task2-plan-repair`; parent `32593d796e76583ac6b9d921db67cf77da5dc6b5`; tree `edc3d571bfb617ada24f889489307968cb567880`. Its accepted documentation descendant is `97e102c90da91535b5a06b6f13e91a8aeb112855`, tree `4e663900fb6773a4474726bae02066e28200d13c`; the Task 3 amendment is an uncommitted forward documentation descendant until the root writer freezes it.
- Scope accepted: Task A authoring, Task B compiler/import-proof/runner integrity, Task 2 native run-audit/approval/effect governance, and the P1-03/P1-04 corrections. Provenance for campaign effects is always TaskStore-derived and reloaded; `campaign_project_id = project_id` is protected by an enforceable composite foreign key. Approval and effect replay/CAS semantics are accepted.
- `0037_ccc_campaign_governance.sql` is the final indivisible migration. It incorporates the legacy `0036` provider-capability repair, fresh-schema and upgrade parity, and governance DDL; no `0038` is permitted for this slice. The audit's P1-03 safety concern is accepted at P0 impact. P1-04 is partially accepted only in its stated boundary: a valid MCP `result.isError: true` commits/replays, while top-level RPC errors, malformed/missing results, disconnects, and aborts remain `dispatched_unknown`.
- Frozen proof: focused Task 2 PostgreSQL `177/177`; engine descendants `80/80`; CLI Task A `2/2`; closed Wave 5 `81/81` twice; full typecheck, lint, build, diff hygiene, and manifest verification. The proof report digest is `d2cf29944bc5cc2556038c99ee5f7d47e637b6a2f5f239eb47d3bd79593ecc12`.
- Fresh behavioral/PostgreSQL, static/build, and AGY adversarial (`dedbf944-4add-4e02-a867-7e1c3311188d`) lanes all returned PASS with no P0/P1. The AGY reviewer noted only that bounded authoring response content is accumulated in memory before the `maxResponseBytes` cap; it is nonblocking and does not alter the enforced byte ceiling.
- The closed Wave 5 mapping remains exactly 81 unique names despite the one migration-body repair; Task A tests remain outside it. Changed-path digest: `a198ac879692fa384363eb9b7ea2fbcb2c9f7ddebf28cd29d1317b06004044b9`. Accepted-predecessor binary diff digest: `be108c15b7dbb7c38aded491389ff7cea6164cb2562d672d147d5f3ac9bbb9b7`. Package/workspace/lock hashes remain `cf1e924d…`, `0e5f3ad…`, and `09244dac…`.
- Wave 6 `2a739f13bfbea4e2c10a46570719fbd6441ba0a6` and Wave 7 `93309dcaa111614dfd2c2362d96525f9af597dc7` remain unaccepted development evidence; neither is replayed. All provider, credential, billing, non-loopback, fetch, push, merge, release, publication, remote-adoption, and `main` gates remain unissued. Next sequence: Tasks 3–10.

### Task 3 Frozen Acceptance — 2026-07-25

- Accepted product: `dc2d4968d828d623986991f504a530112ba59c3a`; parent `aac700ab851e973f89b49a0f41bfd180bd7c98b7`; tree `5aed8833cd8345b967945052c005cd50f11cb19f`. This documentation descendant records the acceptance for Task 4 handoff; its predecessor documentation contract was `4aa78a2f1033d9d45dc991d6ccc7fc0df4cb50fb`, tree `8fd00c728c875a9831632f0f9143385b888822da`. Candidate `aac700ab851e973f89b49a0f41bfd180bd7c98b7` is rejected/invalidate-only evidence because it expanded the Wave 5 inventory and left proof-authority false greens.
- Scope accepted: native proof-admission sidecar stamping and built-CLI bootstrap; raw-byte, file-descriptor-bound fixed-entry provenance; sealed registry snapshots and proof-record collision refusal; PluginLoader/Runner withholding of ambient external proof-admission contributions; TaskStore-derived campaign custody and independent bundle rehash; generic `TaskExecutor` and direct runtime refusal for unfenced campaign work; database-time work-item fence preflight; proof-audit binding; and the sanctioned `processDueWorkflowWorkItem` full-graph route.
- Intentional boundary: the native self-check is conformance-only. It proves that the binding machinery is intact and is explicitly non-authorizing for campaign task execution. Task 4 owns explicit persisted proof semantics and provider/action bounds; Task 5 owns the long-lived `InProcessRuntime` bootstrap. Do not treat the self-check as a user proof. The positive loopback PostgreSQL path uses a deterministic synthetic evaluator whose exact source bytes are placed under provenance, with no provider, hook, live command, credential, billing, or non-loopback call.
- Fresh root proof on the accepted product: core proof/provenance focused `44/44`; engine proof/workflow focused `47/47`; CLI build plus focused proof-host and PRD command tests `15/15`; compiler split `26/26`; loopback PostgreSQL imported workflow `1/1`; broader engine regression `176/176`; broader core regression `58/58`; core, engine, and CLI typechecks; core, engine, and CLI builds; workspace lint; `git diff --check`; proof-runner policy self-test; and closed Wave 5 proof runner PASS with report `/var/folders/m0/q5ny02wd0wd5lf0tt9w2jwqr0000gn/T/ccc-wave-5-proof-a0Rfj0/report.json`.
- Closed Wave 5 inventory is restored and preserved at exactly 81 names: CLI 10, core contract 7, core import/recovery 40, core migration 3, engine contract 20, and native imported execution 1. The runner report has `passed: true`, `policyError: null`, and six command groups with `code=0`, no signal, no timeout, and no forced kill. Do not expand or reuse Wave 5 names for later Task 3+ proof work.
- Fresh review: native adversarial final-byte lane returned PASS with no P0/P1 and two accepted P2 carry-forwards: same-process trusted-caller assumptions are not a malicious sandbox, and the fixed-entry scanner is not a general JavaScript sandbox for future arbitrary proof evaluators. AGY adversarial session `747ac95f-0931-40e3-be66-a2a1a0b5059b` correctly observed the fail-closed production semantic-proof gap and the test-only synthetic registry override; both are accepted as documented boundaries, not Task 3 blockers.
- Package/workspace/lock hashes remain `cf1e924da8b13c1d6a4ed23b7e5cfb033b9e265a4676b8329050b2a9c6ba1755`, `0e5f3ad808110908c6864d6fa02d05fe4a55d35eee75bf71815361f4c35118d1`, and `09244dac5fdbc33029b5a44a9f7aca19c09de57ecb5c8547ca202eae6d34a7ab`. The only current untracked state during proof was the intentional dependency-hydration symlinks `node_modules` and `packages/core/node_modules`, both pointing at the read-only `wave-3-retry` hydration source.
- Next sequence: Task 4 pre-provider admission, finite bounds, drift checks, and durable cancellation. Task 4 must not rely on caller-supplied provenance or the conformance self-check as semantic proof authority. It must bootstrap/reverify the fixed native contribution in the long-lived runtime, admit real campaign actions through TaskStore-derived custody, and preserve ordinary Fusion compatibility.

## Recovery And Handoff

- Recovery Rule: after compaction or a fresh session, read the vault checkpoint first, then this note, then verify live branch/HEAD/tree/status before issuing work.
- Handoff Rule: the active goal already exists. The sole accepted-spine writer resumes from accepted Task 3 `dc2d4968d828d623986991f504a530112ba59c3a`, then advances Tasks 4–10 and updates the vault checkpoint after each material contract, RED, GREEN, commit, review, or operator gate.
- Resume Rule: local product implementation resumes from accepted Task 3 through Task 4 pre-provider admission, bounds, drift, and durable cancellation. It does not begin a live provider, credential, billing, non-loopback, fetch, push, merge, release, publication, protected-path, upstream-adoption, or `main` action.

## Current Task 4 Foundation Receipt — 2026-07-25

This section is the current correction layer for this continuation packet. It supersedes contradictory historical wording in earlier receipts, including the pre-foundation Task 4 RED-scaffold freeze below. It does not reopen Waves 1–5 or accepted Task 1–3.

### Accepted Spine And Recovery

- The accepted Task 3 product is `dc2d4968d828d623986991f504a530112ba59c3a`, tree `5aed8833cd8345b967945052c005cd50f11cb19f`, from a clean detached candidate.
- The Task 4 foundation product is `0ff3748319036ba57356afe1625e2d04e95ef850`, parent `5fcaff1ea47121eea476e09a1ccaec03d2f7046f`, tree `7a73a5595c013126b06337bfdd417cda0622c5db`, on `agent/ccc-fusion-task4-preprovider`. It is a committed foundation only, not Task 4 acceptance, not transport integration, and not provider proof.
- Task 4 foundation reused existing `ccc_prd_imports` locking and native `run_audit_events`. It added no migration, table, receipt store, scheduler, parser, or parallel control plane. Public `TaskStore` provider-attempt methods own their own database transactions and return only after commit; they do not accept caller-provided transaction handles.
- The foundation freezes two native authorities: coarse campaign/action admission before a provider-capable path, and immutable per-attempt scope returned by native provider-attempt reservation. Attempt states are `reserved`, `dispatched_unknown`, `committed`, and `proved_failed`; `dispatched_unknown` remains active until authoritative reconciliation.
- Final focused proof on the committed foundation: engine admission/execution `26/26`; core loopback PostgreSQL provider-attempt `10/10`; core typecheck PASS; engine typecheck PASS; engine build PASS; targeted lint PASS; `git diff --check` PASS.
- Final adversarial review returned PASS with no P0/P1/P2. Accepted repairs include native lease validation, canonical Git object-ID refusal for non-object heads, immutable context before async callbacks, immutable returned authority/attempt scopes, public transaction ownership, restart-visible unknown dispatch, and collision refusal for changed replay evidence.
- RED/GREEN trail preserved: initial engine negative controls for Git OID, empty claim token, and mutable returned lease produced `19 pass / 3 fail`, then `22/22`; later unprotected binding/context mutation controls produced `22 pass / 2 fail`, callback-timing controls produced `24 pass / 2 fail`, then final `26/26`; core provider-scope immutability produced `9 pass / 1 fail`, then final `10/10`.
- Documentation descendant `c59a46310af4ed2f3121423fbeeaa6aa575ea8d4` was preserved. The old Task 2 worktree has an unstaged provenance experiment quarantined as non-accepted evidence. The sole product-writing surface is `/Users/ryanpappal/03_CODE/ccc-fusion-worktrees/task4-preprovider-admission` on `agent/ccc-fusion-task4-preprovider`.
- Package, workspace, and lockfile hashes remain unchanged: `cf1e924da8b13c1d6a4ed23b7e5cfb033b9e265a4676b8329050b2a9c6ba1755`, `0e5f3ad808110908c6864d6fa02d05fe4a55d35eee75bf71815361f4c35118d1`, and `09244dac5fdbc33029b5a44a9f7aca19c09de57ecb5c8547ca202eae6d34a7ab`. The read-only dependency-hydration symlinks `node_modules` and `packages/core/node_modules` were removed before the clean freeze; their targets under `wave-3-retry` were not modified.
- Speculative Wave 6 `2a739f13bfbea4e2c10a46570719fbd6441ba0a6` and Wave 7 `93309dcaa111614dfd2c2362d96525f9af597dc7` remain unaccepted, non-ancestral development evidence only. Neither is replayed unchanged.

### Task 4 Scope, Authorities, And Non-Goals

Task 4 remains incomplete after the foundation commit. The committed foundation admits or refuses campaign actions before provider-capable dispatch and can reserve/reconcile provider attempts, but no production Pi, CLI-agent, or provider-capable workflow call site is wired yet. The injected Git inspector in `packages/engine/src/ccc-campaign-admission.ts` is a trusted interface boundary for focused proof; Task 4 must replace that with production local-Git admission and live local-Git proof. Production merger/ref-update reconciliation and terminal Git receipts remain downstream Task 5 work.

The frozen authorities are:

1. One coarse campaign/action-admission authority controls whether a campaign action may reach a provider-capable path.
2. One per-transport `CccProviderAttemptScope` controls each actual transport request, reserve, settlement, and concurrency observation.

The next implementation sequence must wire these authorities into actual provider-capable transports without widening scope:

- Pi reserves immediately at `ModelRuntime.stream` and `streamSimple`, including initial, fallback, and compaction transports.
- CLI-agent reserves immediately before `manager.spawn`, proves finite supported bounds before launch, and holds the attempt for the authoritative subprocess lifetime.
- Provider-capable workflow handlers either receive and use the scope at their owned dispatch seam or fail closed unless explicitly declared no-provider.
- Production local-Git admission rederives target, base, `HEAD`, ancestry, dirty state, approval claim, and restart-visible custody before any provider-capable dispatch. Production merger/ref-update reconciliation and terminal Git receipts are Task 5 downstream.

### Required RED Inventory And Adjudication

Closed by the foundation: max-concurrency race, lost-response replay, same-key changed-content collision, missing/null imported custody, provider/model/target/base drift, protected-action claim refusal, expired campaign deadline, pre-aborted signal, invalid native lease, non-canonical Git head, mutable returned authority, public transaction false-green, restart-visible unknown dispatch, and zero provider/action/hook callback effects before admission.

Still open for Task 4 acceptance: Pi initial/fallback/compaction wiring; CLI finite-bound launch and abort-to-`dispatched_unknown`; provider-capable workflow scope admission and opaque-plugin refusal at production extension boundaries; durable cancellation; approval-retention and authoritative terminal settlement across unknown dispatch; production local-Git admission; and user-like transport/restart inspection. Task 4 does not implement or own long-lived `InProcessRuntime` bootstrap; Task 5 owns it, production merger/ref-update reconciliation, and terminal Git receipts. Abort alone still may not mark a dispatched attempt `proved_failed`; only authoritative terminal observation may settle it.

No operator gate has been issued. Manifests remain unchanged.

### Task 4 Transport Plan-Freeze Council — 2026-07-25

This correction layer supersedes contradictory Task 4 transport prose above. It freezes the implementation contract only; it is not Task 4 acceptance and does not reopen accepted Task 1 routing.

- **Store identity and replay:** under the existing import lock, the database allocates a campaign-wide monotonic `attemptOrdinal`. The caller supplies a stable semantic `turnKey` and deterministic `dispatchKey`. Exact lost-response replay returns the original attempt, owner token, and ordinal without incrementing the counter. Reusing a key with changed task, action, target, route, provider, model, or binding collides.
- **Dispatch and settlement:** one atomic dispatch acquisition chooses one winner; only its CAS winner receives a dispatch permit. `reserved` attempts may compete, while `dispatched_unknown` and terminal attempts never redispatch. A committed replay with durably recorded output returns that recorded output and terminal evidence verbatim. A committed replay without durably recorded output is an explicit recovery hold and never reconstructs or invents output. Identical reconciliation is idempotent; changed evidence collides. Abort, timeout, or disconnect uncertainty remains unknown, while terminal output carries deterministic SHA-256 evidence.
- **Pi transport:** wrap outside Pi's `pi-ai` lazy provider/auth setup, so reserve plus permit complete before the original `stream` or `streamSimple` call. Same-route `pi-stream:1`, `pi-stream:2`, and `pi-stream:3` slots share one durable work-item-attempt turn identity. Provider/model fallback is route drift under the accepted singular Task 1 route and refuses; Task 4 does not reopen Task 1. Ordinary Pi zero-attempt operations remain ordinary.
- **CLI transport:** the current interactive CLI cannot prove finite request accounting or a manager-owned lifetime deadline. Fail closed before `manager.spawn` unless the host offers an exact immutable one-request-per-process capability. A deterministic local fake may prove the admitted path. The manager owns the deadline and awaited process-tree closure; `followUp` is refused. Exit, native-done, or cancel alone is not terminal provider evidence. Generic, opaque, and interactive adapters fail closed.
- **Workflow transport:** normalize an immutable host-owned posture at registry publication. An omitted posture or external self-declaration is opaque and cannot authorize campaign execution. A host-scoped handler receives a narrow controller; a host-owned no-provider handler proves zero controller effects; an opaque plugin fails before its handler. Do not expose raw `TaskStore` or add a subsystem/control plane.
- **Scope split:** Task 4 implements the store contract, Pi seam, fail-closed CLI capability plus deterministic fake, workflow seam, production local-Git admission, approval/cancellation settlement, and focused integration. Task 5 owns long-lived `InProcessRuntime` bootstrap, mixed ordinary/campaign queue handling, and merger/ref-update terminal receipts.

Council evidence converged across native workflow-map, native CLI-map, and native concurrency/identity review. AGY session `40852e44-d9fa-4d0a-b439-bc0741715de5` was advisory: accept its runtime-wiring, stable replay identity, CLI/provenance, and terminal-replay findings; partially accept unknown-dispatch lockout (intentional hold requiring authoritative settlement/saturation proof), injected Git callback trust (test seam only; production inspector required), and ordinary-marker concern (production derives custody); reject its claim that `pi-ai` `lazyStream` is unavailable because installed `@earendil-works/pi-ai` `0.81.1` exports and uses it. The later AGY exact-byte lane was permission-blocked and therefore provides zero acceptance evidence; its native Sol exact-byte substitute found the P1 ownership correction recorded here. Luna was unavailable for this evidence lane, so a Terra-medium substitute prepared these documentation bytes. No operator gate has been issued.

### Task 4 Controller Contract Correction — 2026-07-25

This section supersedes only the earlier Task 4 transport-plan wording where it conflicts with the controller contract below. It preserves the historical record, accepted Tasks 1–3, the Task 4 foundation boundary, and every operator gate. AGY session `45479c99-e01f-42d2-b32b-855eb6dc3da6` and the native Terra live-source verification are advisory evidence, not authority; each finding below was adjudicated against current production seams and the frozen campaign safety requirements.

#### Live-Source Adjudication

- **ACCEPT — visit-aware dispatch identity:** the exact execution coordinate binds fenced `workItemId`, work-item `attempt`, fenced `runId`, node semantic task ID, and the materialized visit: foreach instance plus rework pass, loop ID plus iteration, optional-group parent, and top-level rework pass where applicable. One materialized visit identity is sealed across handler retries; a genuinely later visit is a distinct coordinate. A process restart may collide or hold safely when it cannot prove the visit, but it must never invent one.
- **ACCEPT — semantic-task substitution:** the task identified by `node.config.cccPrdTaskId` is loaded once and becomes the task used for preparation, plugin or default handler invocation, progress, projection, and transport. The origin task owns only the workflow work item, fence, and audit lineage. Handler retry reuses the same sealed semantic task and controller rather than re-reading or re-authorizing either.
- **ACCEPT — controller continuity refinement:** committed provider output may advance to the next deterministic stream slot only inside the same live controller that retained and delivered the parsed output. A new or re-entered controller encountering `committed` or `dispatched_unknown` holds because the provider-attempt row stores only a digest and observer evidence, not replayable output. `proved_failed` permits a new deterministic slot. No restart, retry, or session-history path may fabricate provider output.
- **PARTIALLY ACCEPT — auth-order finding:** coarse campaign, action, proof, Git, and approval admission completes before runtime or session creation and before any credential or provider setup. For each actual stream, the route, bounds, fence, Git, and active-approval rechecks plus native reserve and dispatch-begin CAS complete before the original provider stream, provider authentication, provider handshake, or network child. Only demonstrably no-effect local capability or model-structure preflight may precede dispatch begin. Local acceptance injects deterministic fakes and reads no credentials. A failure after dispatch begin remains `dispatched_unknown` unless exact authoritative terminal evidence proves that no provider effect was accepted.
- **REJECT — extra dispatch nonce:** `turnKey`, `dispatchKey`, the persisted attempt key and owner/controller token, and the work-item fence already correlate one attempt. A lost dispatch-begin response must re-read and hold; it must never re-dispatch. No additional nonce is justified without a failing requirement proof, and Task 4 will not weaken safety for liveness or reopen store identity speculatively.
- **REJECT — session-history replay mandate:** native session persistence may later support verified hydration, but digest-only provider-attempt history cannot reconstruct response bytes or parsed output. A recovery hold is the current truthful contract.
- **REJECT — approval auto-renewal or subclaims:** the controller performs a database-clock active-claim assertion before every new dispatch, and expiry stops new dispatches. An already claimed action follows the existing proved-no-effect or consume settlement rules. The controller never extends an operator-issued expiry autonomously and does not create derivative authority.
- **ACCEPT WITH REFINEMENT — Git roll-forward gap:** the initial Task 4 Git snapshot remains an exact clean, physical-custody observation and is never advanced merely because model output exists. A later mutation-aware checkpoint may advance only after an exact native effect or merger receipt, normalized admitted-path proof, and a fresh physical and content observation. Until that downstream Task 5 seam exists, any dirty or changed repository state holds before another provider stream.
- **REJECT — wildcard action targets:** the earlier `provider:direct -> semantic task` controller wording is superseded for the accepted controller boundary because the unchanged real ccc-lab-super packet declares exact `ACTION-LIVE-EXECUTION -> ccc-lab-super:pre-live-provider-gate`. The semantic task remains independently bound in provider-attempt scope, no wildcard target was added, and Task 1 was not reopened. Dynamic tool mutations require their own exact native per-effect target admission and receipt; no wildcard target authorizes them.
- **PARTIALLY ACCEPT — plugin identity concern:** there is no host override of an external registration. Fixed trusted host posture and bootstrap must be established before campaign work begins. Omitted, external, or self-declared posture remains opaque, and same-ID posture drift fails closed.
- **ACCEPT — bounded CLI cancellation ladder:** cancellation is scoped `TERM`, a bounded grace period, scoped `KILL`, then bounded closure confirmation. Failure to confirm closure leaves `needsAttention` with the fence retained; it never produces a false terminal result.
- **REJECT — ordinary campaign-attempt telemetry:** ordinary workflows remain behavior-compatible and write zero campaign provider-attempt rows. Existing ordinary telemetry is a separate subsystem and is outside Task 4.

#### Local-Git Candidate Disposition

- Local-Git candidate hashes `08f48f`, `a7ee71`, and `dd69c0` are **INVALIDATED** despite their reported `23/23`: repository `stat` produced a false-clean result, the repository filter was executed instead of proved structurally, and the timeout was not a hard deadline.
- The exact two-file TDD repair in `packages/engine/src/ccc-campaign-local-git.ts` and `packages/engine/src/__tests__/ccc-campaign-local-git.real-git.test.ts` is no longer active-candidate work: accepted local-Git commit `9ed1839827ced133ff435499a7ab3a8e9f4416a4` re-proved and froze it before controller commit `79c91f8be245038100741cb5e405b34e01a4b46e` consumed the production wrapper.
- Component `499068fa730d31835bc0437fc1f99d05f4872ac1` remains the committed provider-attempt identity component only. It is not Task 4 transport acceptance, local-Git acceptance, or Task 4 acceptance.

#### Revised Task 4 RED Inventory

Task 4 cannot freeze an acceptance candidate until these exact negative controls fail before their production corrections and pass on one integrated byte set:

1. A handler retry for one materialized visit must reuse one sealed task/controller coordinate, while later foreach, rework, loop, optional-group, and top-level rework visits must receive distinct coordinates; restart without sufficient visit proof must hold.
2. A workflow origin task that differs from `cccPrdTaskId` must prove that preparation, handler, progress, projection, proof admission, and transport all receive the persisted semantic task; missing or changed semantic custody must refuse before handler execution.
3. Pi initial, fallback, and compaction streams must reserve distinct deterministic slots only after structural admission and before Pi provider/auth setup; provider/model drift, exhausted bounds, unknown dispatch, terminal digest-only replay, and ordinary-workflow invocation must produce zero forbidden provider calls.
4. Same-live-controller committed output may advance to its next slot, while a new controller must hold on `committed` or `dispatched_unknown`; `proved_failed` alone permits a new deterministic slot, and no test may synthesize response bytes from a digest.
5. CLI generic, interactive, mutable, or opaque adapters must refuse before scratch creation and `manager.spawn`; only a fixed host-owned one-request-per-process capability may proceed. `followUp` must refuse, and the bounded `TERM` → grace → `KILL` → closure ladder must retain `needsAttention` and the fence when closure is unconfirmed.
6. External or self-declared plugin posture must remain opaque; fixed host `no-provider` must prove zero controller effects, fixed host scoped-provider must receive only the narrow controller, and same-ID posture drift must fail before handler execution.
7. Every new dispatch must reassert the exact approval claim against database time. Expired authority must produce zero new dispatch, no autonomous renewal, and no subclaim; post-begin uncertainty must remain unknown unless authoritative evidence proves no accepted effect.
8. Initial Git admission must detect repository `stat` drift, symlink or physical-custody drift, filter execution, dirty state, changed `HEAD`, and non-hard timeout false greens. No model output may advance the admitted snapshot; absent the Task 5 native effect/merger receipt seam, changed state must hold before another stream.
9. The single declared `live_execution` action ID and target must bind approval and provider-attempt action authority, while `semanticTaskId` binds the task independently; dynamic mutation targets must prove separate exact native admission and receipt, and wildcard targets must refuse.
10. Ordinary workflows must retain existing behavior and produce exactly zero campaign provider-attempt rows, while campaign cancellation, restart, lost begin response, and terminal settlement remain truthful through normal public readers.

#### Collision-Free Writer Ownership

- One controller-contract writer owns the narrow controller, shared types, and barrel exports.
- One workflow writer owns graph execution, task-runtime substitution, materialized-visit identity, plugin posture, and their focused tests.
- One transport writer owns Pi and CLI seams, lazy dispatch ordering, bounded cancellation, and their focused tests.
- The root accepted-spine writer exclusively owns `packages/engine/src/executor.ts`, candidate integration, byte freeze, and final acceptance synthesis.
- No two writers edit `executor.ts` or a shared barrel concurrently. The controller writer must wait for the active local-Git repair to be accepted or explicitly superseded before integrating through its barrel, and all lanes must preserve concurrent uncommitted work.

### Task 4 Component Freeze Receipt — 2026-07-25

This receipt preserves the historical local-Git invalidations and the controller-contract correction above. It freezes two accepted components only; Task 4 remains unaccepted and no operator gate is issued.

- Approval-recheck component: commit `5da5d15270a45440fa3f32baa68eccafeeb4722e`, parent `499068fa730d31835bc0437fc1f99d05f4872ac1`, tree `beea09405c32ebdfc948e4a5068664a4b444153e`. Exact package, workspace, and lock hashes remain `cf1e924da8b13c1d6a4ed23b7e5cfb033b9e265a4676b8329050b2a9c6ba1755`, `0e5f3ad808110908c6864d6fa02d05fe4a55d35eee75bf71815361f4c35118d1`, and `09244dac5fdbc33029b5a44a9f7aca19c09de57ecb5c8547ca202eae6d34a7ab`; root PostgreSQL proof was `16/16` and fresh review was PASS.
- Local-Git custody component: commit `9ed1839827ced133ff435499a7ab3a8e9f4416a4`, parent `5da5d15270a45440fa3f32baa68eccafeeb4722e`, tree `6203098caa6733d937e8d8f92782c3dea4e9c76a`. Frozen helper, test, and index evidence hashes are `3dad656a824b8d33c3a6af7e79f1a1838c457767b38e3e53a94f1a461372faf0`, `6fecfa6d885a56119ad5c1f8bfe8144177ac892876a032499c549ab3006c7bed`, and `dd69c07a06c1cbd76e2ca5a4362c1f2a869d6671905b07aaf0d2b12de005fa3c`. Root proof was `37/37`, with typecheck, lint, and `git diff --check` PASS; two fresh review lanes returned PASS.
- Closed final P1 RED classes: hidden `stat` bytes, filter execution, nonclosing process, staged index, FIFO/unbounded read, owner execute bit, intermediate symlink parent, and ambient `PATH` binary spoof.
- Latest accepted product is `9ed1839827ced133ff435499a7ab3a8e9f4416a4`; manifests remain unchanged. Immediately before this documentation edit, repository status showed only this plan file unstaged.
- Next order: controller/types, then graph/runtime/plugin, then Pi/CLI, then executor integration. Do not treat either component freeze as Task 4 acceptance or as authorization to reopen invalidated candidates.

### Task 4 Controller Component Freeze Receipt — 2026-07-25

This receipt accepts only the controller component. Task 4 remains unaccepted, and no provider, credential, billing, non-loopback, fetch, push, merge, release, publication, remote-adoption, `main`, or live-canary gate has been issued.

- **Product identity:** commit `79c91f8be245038100741cb5e405b34e01a4b46e`, tree `e47902c4220e6bf3f8178c53dc7cac6495d96f94`, parent documentation descendant `8f10f7c08217b94c7a31bc4f1052aaafe24d7854`, on branch `agent/ccc-fusion-task4-preprovider`.
- **Changed paths:** `packages/core/src/ccc-campaign/provider-controller.ts`, `packages/core/src/ccc-campaign/index.ts`, `packages/core/src/__tests__/postgres/ccc-campaign-provider-controller.pg.test.ts`, `packages/engine/src/ccc-campaign-provider-controller.ts`, `packages/engine/src/index.ts`, `packages/engine/src/__tests__/ccc-campaign-provider-controller.test.ts`, and `packages/engine/src/__tests__/ccc-campaign-provider-controller.real-packet.test.ts`.
- **Accepted P1 repair:** the raw core API no longer exposes a full pre-dispatch admission name, `routeKind`, or an ordinary bypass. The core primitive is explicitly persistence-only and compares a frozen Git observation only against locked campaign custody inside one transaction. The engine wrapper is the only full pre-dispatch path and rechecks production local Git before calling core.
- **Real-packet action repair:** the controller derives exactly one declared `live_execution` protected action from locked custody. The accepted real ccc-lab-super sidecar remains unchanged and binds `ACTION-LIVE-EXECUTION` to `ccc-lab-super:pre-live-provider-gate`; the semantic task remains separate in provider-attempt scope and is not substituted into the action target. The earlier hardcoded `provider:direct -> semantic task` controller wording is superseded because the unchanged real packet declares the exact live-execution action and target; no wildcard was added and Task 1 was not reopened.
- **Production Git wrapper:** the engine wrapper uses a fresh production local-Git recheck result before calling the core persistence primitive. The PostgreSQL proof covers mixed SHA-1/SHA-256 object-format refusal and the matching 64-character base/head positive custody case.
- **Root proofs:** `FUSION_PG_TEST_URL_BASE='postgresql://postgres:password@127.0.0.1:61316' node_modules/.bin/vitest run src/__tests__/postgres/ccc-campaign-provider-controller.pg.test.ts --reporter=dot` from `packages/core` passed `1` file and `14` tests. `node_modules/.bin/vitest run src/__tests__/ccc-campaign-provider-controller.test.ts src/__tests__/ccc-campaign-provider-controller.real-packet.test.ts --reporter=dot` from `packages/engine` passed `2` files and `5` tests. `pnpm --filter @fusion/core typecheck`, `pnpm --filter @fusion/engine typecheck`, targeted production ESLint, and `git diff --check` passed.
- **Final-byte review:** fresh read-only review returned PASS with no P0/P1. It verified the prior route/action false-greens were closed, approval and lease checks use real PostgreSQL row locks and custody, rollback/lost-response proofs use real audit/import tables, and provider-attempt replay holds instead of redispatching on unknown output.
- **Manifest hashes:** package manifest `cf1e924da8b13c1d6a4ed23b7e5cfb033b9e265a4676b8329050b2a9c6ba1755`; workspace manifest `0e5f3ad808110908c6864d6fa02d05fe4a55d35eee75bf71815361f4c35118d1`; lockfile `09244dac5fdbc33029b5a44a9f7aca19c09de57ecb5c8547ca202eae6d34a7ab`.
- **Next order:** graph/runtime/plugin implementation is next, using the accepted controller interface. Pi/CLI and root-owned `executor.ts` integration follow after the workflow posture and materialized-visit identity are proven.

## Task 4 Native CLI Plan Freeze — 2026-07-26

This correction freezes the Native CLI implementation route only. Base accepted product remains `2b574951fa58675b19085e4bfd021f18d04394ca`, tree `c222be6c7a527c3965592b41b08e539c8d35c1c6`. Task 4 is not accepted, and no operator gate has been issued. Luna was unavailable; this documentation update is the Terra evidence/docs substitute. The council was Terra implementation-readiness plus native Sol architectural review; AGY was unavailable or permission-blocked, so native Sol substituted for that review lane. Verdict: CORRECTIONS REQUIRED with no P0 and three accepted P1s.

### Frozen Slices

- **Slice A — sealed workflow identity:** clone and freeze the processor `workItemFence` before the first `WorkflowTaskRuntime` await, validate the exact snapshot, reuse it for proof admission, and pass a host-owned `executionFence` containing only `workItemId`, `attempt`, and `runId`. `WorkflowGraphExecutor` seals that with origin, semantic task, and materialized visit identity, then derives a schema-versioned canonical SHA-256 `turnKey`. The custom-node runner and service forward only the sealed context. Missing, unvalidated, or mutated fence data refuses.
- **Slice B — host-native CLI binding:** add a separate frozen host-native CLI binding/resolver, not a sentinel or plugin capability. The binding has fixed kind, version, id, exact adapter/provider/model/`transport=cli`, `maxRequests=1`, finite lifetime, TERM grace, KILL closure bounds, `followUp=false`, observer, and controller `preDispatch` plus `reconcile`. Current `createCliAgentRuntime` and bundled interactive, generic, or opaque adapters publish no binding and therefore fail closed before log mutation, MCP/auth, kill, scratch, session row, or spawn. Exact keys, freeze, routes, and permit scope validate before launch.
- **Slice C — campaign termination and receipt:** campaign-only manager policy owns per-session termination: TERM, full bounded grace, KILL, full bounded process-group closure, proxy closure, durable fence flush, and registry-slot release. Observer runs only after closure receipt; then reconciliation uses the exact retained scope/token and validates exact terminal scope. Native done, exit, or cancel alone is never terminal provider evidence. Timeout, nonclosure, signal, observer, or reconcile uncertainty leaves `dispatched_unknown` and session `needsAttention` with fence and slot retained.
- **Slice D — integration:** focused real-PostgreSQL and restart integration proves the public route. Ordinary CLI remains unchanged and writes zero campaign rows.

### Required RED Inventory

- `workItemId` or `attempt` changes the `turnKey`; retry of the same sealed visit does not.
- Caller fence mutation causes no drift; missing fence gives no controller.
- Malformed, mutable, extra-key, and current interactive/generic/opaque adapters have zero effects.
- `preDispatch` happens before MCP, kill, scratch, session row, or spawn.
- Hold/restart paths produce zero spawn.
- Admitted path produces exactly one spawn and no `followUp`.
- Fake-clock termination proves TERM, grace, KILL, and closure.
- Nonclosure retains fence and slot.
- Native done, exit, and cancel never reconcile by themselves.
- Closure happens before observer, and observer before reconcile.
- Committed and `proved_failed` terminal reconciliation is exact and idempotent.
- Lost response stays unknown.
- Ordinary CLI compatibility is retained with zero campaign rows.

### Next Execution

Start with Slice A RED:

```sh
pnpm --filter @fusion/engine exec vitest run src/__tests__/workflow-custom-node-execution.test.ts -t "forwards sealed workflow execution context to cli-agent custom runner"
```

Then add workflow task-runtime identity REDs before implementing the host-native CLI binding. Do not claim Task 4 accepted.

## Task 4 Native CLI Slice A Candidate Invalidation — 2026-07-26

Accepted product remains HEAD `2b574951fa58675b19085e4bfd021f18d04394ca`, tree `c222be6c7a527c3965592b41b08e539c8d35c1c6`. Frozen 10-path candidate diff SHA-256 `3a493efef1857d74b415d94991a7a7d6f7858d8146c26990ba4208ff44a11b98` passed `89/89`, typecheck, build, changed production and test lint, and diff check, but fresh Sol exact-byte review returned FAIL with no P0 and one P1: top-level rework re-enters the same node with default `{nodeId, materializedNodeId}` identity, so later materialized passes reuse `providerAttemptTurnKey`.

Candidate bytes and all acceptance verdicts are invalidated. No commit, tree, manifest, or operator gate changed. Terra-for-Luna and native Sol-for-AGY substitutions remain recorded for this documentation evidence lane. P2 legacy `WorkflowGraphTaskRunner` and `TaskExecutor` fourth/sixth context wiring remains deliberately deferred to Slice B/Task 5 owning-runtime integration and is not authority.

Exact RED now active:

```sh
pnpm --filter @fusion/engine exec vitest run src/__tests__/pr-rework-bound.test.ts -t "gives each top-level rework pass a distinct provider turn key" --reporter=dot
```

## Task 4 Native CLI Slice A Component Accepted — 2026-07-26

Accepted Slice A component commit `003b397c44ff3213867ec3b90850bbf24ae928ed`, parent `2b574951fa58675b19085e4bfd021f18d04394ca`, tree `91eb0c2bdff5d18de30e8cc8c318bb32178ff32a`, is accepted as a Task 4 Native CLI Slice A component only. Task 4 remains unaccepted. Exact commit diff SHA-256 is `d63431b8184909e13712b22b1a5a997709e6e7930f1edb0d6baad046a18c02a7`; exact scope is 11 tracked paths. Tracked status after acceptance was clean, with only intentional dependency-hydration symlinks `?? node_modules` and `?? packages/core/node_modules`.

Proof passed: `4` files / `95` tests, engine typecheck, engine build, production ESLint, test ESLint with `--no-ignore`, and `git diff --check`. Manifest hashes remain unchanged: package `cf1e924da8b13c1d6a4ed23b7e5cfb033b9e265a4676b8329050b2a9c6ba1755`, workspace `0e5f3ad808110908c6864d6fa02d05fe4a55d35eee75bf71815361f4c35118d1`, lock `09244dac5fdbc33029b5a44a9f7aca19c09de57ecb5c8547ca202eae6d34a7ab`.

Fresh native Sol exact-byte review returned PASS with P0 `0`, P1 `0`, and P2 `0` new. The known legacy context-drop P2 remains owned by Slice B/Task 5 owning-runtime integration. Prior invalidated candidate `3a493efef1857d74b415d94991a7a7d6f7858d8146c26990ba4208ff44a11b98` remains invalid and is not resurrected. Native Sol substituted for unavailable AGY; Terra substituted for unavailable Luna. Next state is `task4_cli_predispatch_admission_red_active`.

## Task 4 Slice B Legacy Context And Missing Binding Transition — 2026-07-26

This records uncommitted Slice B development evidence only. Slice B and Task 4 are not accepted. Spark added `Task 4 RED: forwards sealed node execution context through the legacy task runner wrapper`; RED observed arg4 `undefined`, and GREEN threads the exact optional arg through `workflow-graph-task-runner.ts`. Spark also added corrected `Task 4 RED: fenced CLI node without a host-native binding refuses before log or session effects`; RED resolved `runtime-unavailable` and logged because arg6 was ignored. Terra GREEN in `executor.ts` threads the sixth `WorkflowNodeExecutionContext`, and fenced `cli-agent` now throws code `CCC_NATIVE_CLI_BINDING_REFUSED` before task reload, log, MCP, or session work; ordinary and unfenced paths are unchanged.

Root proof with owned loopback PostgreSQL at `127.0.0.1:61316` passed `workflow-graph-task-runner.test.ts` plus `executor-fast-mode-workflows.test.ts`: `2` files / `69` tests. Engine typecheck, targeted lint, and diff check were reported PASS. Component bytes remain uncommitted.

Native Sol contract challenge is accepted: use a host-owned optional `resolveCccNativeCliBinding` on `CliAgentRuntime`, never graph context or adapter capabilities; require exact frozen one-shot binding and permit validation. Slice C still owns termination, observer, and reconcile. AGY was unavailable, so native Sol substituted; Luna was unavailable, so Terra is the docs substitute. Next execution state is `task4_cli_binding_validation_red_active`.

## Task 4 Slice B Binding And Permit Transition — 2026-07-26

This records uncommitted Slice B development evidence only. Slice B and Task 4 are not accepted. Spark hash RED proved the exact frozen binding refused exact keys because `authorityBindingHash` was absent. Terra GREEN requires a host-owned lowercase 64-hex `authorityBindingHash`.

Positive built fake RED failed at `CCC_NATIVE_CLI_DISPATCH_NOT_IMPLEMENTED` before `preDispatch`. Terra GREEN uses the exact typed controller, a frozen one-shot request, non-permit refusal, then the existing one-shot path. The initial post-GREEN test false-RED was a mock-observer bug: a post-import spy observed `0`. Spark REFACTOR used hoisted shared mocks.

Root final proof with owned loopback PostgreSQL at `127.0.0.1:61316` passed `4` files / `73` tests. Engine typecheck, production plus new-test ESLint `--no-ignore`, and `git diff --check` passed. Component remains uncommitted and unaccepted; observer, reconcile, termination, and restart are not accepted yet. Current bundled runtimes still have no resolver, so real/bundled CLI remains fail-closed.

AGY was unavailable and native Sol substituted; Luna was unavailable and Terra is the docs substitute. No operator gate was issued. Next execution state is `task4_cli_permit_scope_negative_red_active`.

## Task 4 Slice B Permit Scope Validation — 2026-07-26

This remains uncommitted Slice B development evidence only. Slice B and Task 4 are not accepted. Terra RED added five malformed permit-scope cases: mutable scope, foreign canonical authority hash, sealed semantic mismatch, committed/terminal state, and `requestCount != 1`. Each wrongly reached resolver -> `preDispatch` -> MCP -> kill -> launch and returned `needs-attention`.

GREEN adds an exact frozen nonterminal permit-scope validator before effects. It requires canonical attempt and controller IDs, sealed task match, positive ordinal, `requestCount=1`, `dispatched_unknown`, canonical complete authority binding/hash, and exact provider/model/`transport=cli` association before resolver, `preDispatch`, MCP, kill, or launch.

Root proof with owned PostgreSQL passed `4` files / `78` tests. Engine typecheck, production/new-test lint `--no-ignore`, and diff check passed. Observer, reconcile, termination, and restart remain open. AGY/native Sol and Luna/Terra substitutions remain in force. No operator gate was issued. Next execution state is `task4_cli_prepermit_input_and_lifecycle_red_active`.

## Task 4 Slice B Strict Profile Pre-Binding Transition — 2026-07-26

This records uncommitted Slice B development evidence only, based on current product HEAD `003b397c44ff3213867ec3b90850bbf24ae928ed`. Slice B and Task 4 are not accepted. The strict-profile RED proved a legacy root-only `profile: "ccc-fusion"` incorrectly reached `[resolver, preDispatch, kill, launch]` and returned `needs-attention` instead of controlled `CCC_NATIVE_CLI_BINDING_REFUSED`.

GREEN removes the root `cfg.profile` fallback. Fenced campaign CLI admission now admits only resolved `cliSettings.profile` exactly `ccc-fusion` before binding resolution or `preDispatch`; ordinary and unfenced CLI behavior remains outside this Slice B admission path.

Root proof with owned loopback PostgreSQL at `127.0.0.1:61316` passed the pre-binding refusal filter `4/4`, full `ccc-native-cli-executor.test.ts` `10/10`, existing missing/invalid binding filters in `executor-fast-mode-workflows.test.ts` `3` total, and `workflow-graph-task-runner.test.ts` `17/17`. Engine typecheck, production ESLint, and diff check passed.

No commit, tree, operator gate, or Task 4 acceptance changed. Luna was unavailable, so Terra is the bounded documentation writer substitute. Next gate is finite lifecycle/closure/observer/reconcile plan freeze plus REDs; do not reopen Waves 1-5 or Task 1.

## Task 4 Slice C Lifecycle Plan Freeze — 2026-07-26

This is a documentation-only plan-freeze transition. No code, commit, operator gate, P0/P1-zero acceptance, Slice B acceptance, or Task 4 acceptance is claimed.

Council record: root synthesis plus native Sol architectural challenge plus Terra PostgreSQL feasibility review. AGY remains unavailable with native Sol substitution already recorded; Luna remains unavailable with Terra documentation substitution.

Accepted P0 findings:

- Current native done can advance before proven process-group, proxy, and durable closure, while reap failure is swallowed.
- Provider-attempt terminal reconciliation and CLI-session fence settlement must be atomic in one existing `AsyncDataLayer` transaction.

Accepted minimal route:

- Retain the validated host binding and permit scope.
- Use a campaign-only manager-issued frozen held closure receipt.
- Treat `lifetimeMs` as the total permit-to-closure budget bounded by `campaignDeadlineAt`; begin shutdown early enough to preserve full `termGraceMs + killClosureMs`.
- Run TERM for the full grace, then KILL, then bounded closure/proxy drain plus durable `needsAttention` floor while the slot remains held.
- Let the observer see only the retained scope plus held receipt and produce an exact observation.
- Let the host controller atomic settlement call existing provider-attempt `reconcile(tx)` plus CLI generation compare-and-swap in the same transaction.
- Release the slot only after an exact validated terminal result.
- Keep malformed, timeout, collision, flush, observer, or reconcile uncertainty as `dispatched_unknown` plus `needsAttention` ownership.
- Preserve one-shot `followUp=false`; ordinary CLI remains unchanged.
- Add no database, store, scheduler, control plane, or new durable subsystem.

Pre-spawn invariant: the provider PTY cannot spawn before the durable attempt-bound CLI row flushes. A residual crash before that row is a proved-no-dispatch reconciliation case, not a launch retry.

Implementation order: exact observation and terminal validators -> core PostgreSQL atomic settlement -> manager held closure and supervisor timing -> task-session one-shot behavior -> executor observer/reconcile/release -> restart resume exclusion -> real process and PostgreSQL regressions.

Next execution state remains lifecycle RED active: `task4_cli_lifecycle_plan_freeze_red_active`.

## Task 4 Slice C Observation And Settlement Transition — 2026-07-26

This is uncommitted Slice C development evidence only. Slice C and Task 4 are not accepted. No code is accepted, no commit or operator gate was issued, and no P0/P1-zero claim is made.

Validator record:

- Observation validator RED was missing-function failure across `5` tests; GREEN passed `6/6`.
- Terminal-scope RED was missing-function failure across `11` tests.
- Two false-green corrections were accepted: synthetic root `state: "terminal"` must refuse, and mutable authority bindings must refuse before core authority validation.
- Strict terminal-scope GREEN passed `19/19`.

Atomic settlement record:

- Core settlement RED was `3` missing-method failures with `24` older tests still green.
- GREEN passed `27/27`.
- Closure precondition RED was `2` cases resolving incorrectly; GREEN passed `29/29`.
- Settled-state/idempotent-replay RED added `2` cases; GREEN passed `30/30` on owned loopback PostgreSQL `127.0.0.1:61316`.

Regression proof: executor regression `10/10`, engine typecheck, production/test lints, repo diff checks, and no-index checks passed. Component remains uncommitted and unaccepted.

Frozen settlement contract: use the existing shared transaction so provider-attempt terminal audit and exact one-shot CLI generation fence settlement commit or roll back together. The settlement requires held `needsAttention`, null unfenced state, and held-closed lifecycle. It writes dead/fenced/settled state. Identical replay is idempotent. Drift or collision rolls back both sides.

Next RED is manager-held closure and registry-slot lifecycle. Do not claim Slice C, Task 4, or P0/P1-zero acceptance. Keep `execution_state` lifecycle RED active: `task4_cli_lifecycle_plan_freeze_red_active`.

## Task 4 Slice C Manager, Session, Executor, And Restart Transition — 2026-07-26

This is uncommitted Slice C development evidence only. Accepted product remains HEAD `003b397c44ff3213867ec3b90850bbf24ae928ed`, parent `2b574951fa58675b19085e4bfd021f18d04394ca`, tree `91eb0c2bdff5d18de30e8cc8c318bb32178ff32a`. Slice C and Task 4 remain unaccepted.

The manager now builds and validates one frozen one-shot session policy, enforces the bounded lifetime, issues a held closure receipt, exposes an observer-only waiter, retains the registry slot, and releases it only after exact terminal fenced settlement. Direct one-shot resume refuses. `TaskSession` forwards the same policy, converts done, exit, lifetime, and cancel into the held result, and makes campaign kill wait for release.

The executor builds that policy after permit validation and before MCP, kill, scratch, or spawn; validates the actual launched session ID and held receipt; observes only the frozen receipt plus retained permit scope; controller-reconciles the exact outcome; and releases only after terminal-scope validation. Uncertain observation, reconciliation, validation, or release retains the active map. Ordinary result-rejection cleanup remains intact.

Restart admission now marks one-shot rows `needsAttention` and ineligible without spawning. Root and child review also repaired four false greens: a rejected release deferred, an ordinary result map leak, foreign outcome/receipt session identity, and one-shot rows silently filtered instead of surfaced.

Focused proof passed the combined binding/session/task/executor lane `50/50`, restart exclusion `3/3`, and core PostgreSQL CLI-session settlement `31/31` on the owned loopback fixture at `127.0.0.1:61316`. The full native-MCP provider matrix first reproduced `8` failures; exact diagnosis exposed Undici refusing invalid forwarded `content-length`. The minimal proxy repair strips hop-by-hop, routing, and body-framing headers before forwarding. Exact RED `2/2` and the full matrix `33/33` then passed with the owned PostgreSQL fixture. This closes a real latent protocol bug, not parallel-test noise.

No manifest, lockfile, operator gate, commit, or Task 4 acceptance changed. Remaining work is pre-spawn failure and proved-no-dispatch reconciliation, restart/effect reconciliation proof, full fake-bound integration, and integrated freeze/review. AGY remains unavailable with native Sol substitution; Luna remains unavailable with Terra documentation substitution. Next execution state is `task4_cli_predispatch_failure_reconciliation_red_active`.

## Task 4 Slice C Pre-Provider Failure Reconciliation Transition — 2026-07-26

Accepted product remains HEAD `003b397c44ff3213867ec3b90850bbf24ae928ed`, parent `2b574951fa58675b19085e4bfd021f18d04394ca`, tree `91eb0c2bdff5d18de30e8cc8c318bb32178ff32a`. This is uncommitted development evidence only. Slice C and Task 4 remain unaccepted.

A read-only Sol child violated its ownership and TDD limits and wrote a speculative helper that auto-reconciled every generic launch rejection as proved no-dispatch. That candidate is INVALIDATED and not accepted. The same child changed only the disposable loopback PostgreSQL role `ccc_task4` to `BYPASSRLS`; no product or external state changed, and final scratch-cluster teardown remains required.

Corrective TDD rewound that helper. Exact RED command:

```sh
pnpm --filter @fusion/engine exec vitest run src/__tests__/ccc-native-cli-executor.test.ts --reporter=dot -t 'terminalizes permit|typed launch rejection|generic launch rejection'
```

RED proved three missing safe reconciliations: MCP resolution, prior-session kill, and typed `CliConcurrencyLimitError` each called reconcile `0` times. The generic launch case passed because it correctly stayed unreconciled, invalidating the earlier false green.

GREEN uses an exact phase enum and reconciles only those three proven pre-provider failures. A generic `launchCliTaskSession` rejection remains `dispatched_unknown` with no automatic reconcile. The SHA-256 evidence digest binds a fixed version, phase, permit identity, and authority-binding hash only; it never includes raw error text. One fixed pre-provider observer ID and exact terminal-scope validation prevent a reconciliation rejection or foreign scope from fabricating an at-capacity result.

Root proof passed the focused filter `7` selected tests with `23` development-filter skips, the five-file Slice C lane `71/71`, engine typecheck, owned ESLint `--no-ignore`, and `git diff --check`. The first six-file integrated attempt used `DATABASE_URL` instead of the PostgreSQL test harness variable and failed authentication as the laptop user; this was a command/configuration failure with no code signal. The corrected command used `FUSION_PG_TEST_URL_BASE=postgresql://postgres@127.0.0.1:61316`: six engine files passed `104/104`, and core `cli-session-store` PostgreSQL proof passed `31/31`.

AGY remains unavailable, so native children substituted. Luna remains unavailable, so Terra substituted for this documentation lane. A Spark restart inventory failed to produce source evidence after one follow-up and is rejected as non-evidence. Next execution state is `task4_cli_restart_effect_reconciliation_red_active`; remaining gaps are restart/effect reconciliation, full fake-bound user-like integration, one-shot `killAll()` handling review, and consolidated Task 4 freeze/council.

## Task 4 Kill-All, Legacy Receipt, And Evidence-Custody Transition — 2026-07-26

Accepted product identity remains HEAD `003b397c44ff3213867ec3b90850bbf24ae928ed`, parent `2b574951fa58675b19085e4bfd021f18d04394ca`, tree `91eb0c2bdff5d18de30e8cc8c318bb32178ff32a`; the candidate remains uncommitted and Task 4 is not accepted. Intentional hydration state remains `?? node_modules` and `?? packages/core/node_modules`.

Kill-all RED `Task 4 RED: dispose/killAll closes a one-shot CCC session through held-closure (not dead/engineDeath/fenced)` first observed `dead/engineDeath/fenced` overwriting the held closure. GREEN routes CCC policy sessions through `closeCccNativeCliSession` with `cancel`. Exact proof passed `1/1`; the integrated engine lane passed `105/105`, core PostgreSQL CLI-session settlement passed `31/31`, and typecheck, lint, and `git diff --check` passed.

Residual audit compatibility edge P1-04 reopened the predecessor test `replays an unambiguous legacy raw-tool receipt through the current native JSON-RPC request id`. RED returned JSON-RPC `-32000` (`CCC native MCP legacy receipt is not safely replayable`) for a valid legacy envelope whose `result` carried `isError: true`. GREEN accepts only completed, error-free JSON-RPC envelopes with a record `result`, makes zero upstream call, and keeps malformed and top-level-error envelopes fail-closed. The provider matrix passed `33/33`; integrated engine proof passed `105/105`.

Evidence-custody incident: read-only Spark wandered into `/Users/ryanpappal/03_CODE/ccc-fusion-worktrees/wave-5-integration` on `agent/ccc-fusion-wave-5-integration` at `3f04bf4a18dec5d8e1bca5b184e9df95a40c7022` and left uncommitted edits in `docs/testing.md`, `packages/engine/src/__tests__/ccc-native-mcp-provider-matrix.test.ts`, and `packages/engine/src/cli-agent/ccc-native-mcp-proxy.ts`. Those bytes are **INVALIDATED**, isolated from the accepted spine, and are neither reverted nor overwritten. The correct idea was independently rederived in this accepted Task 4 tree; do not forward-fill blindly.

Remaining Task 4 gate is a real-PostgreSQL public-route fake-bound integration proving restart inspection and authoritative settlement, followed by a fresh freeze/council. `execution_state` remains exactly `task4_cli_restart_effect_reconciliation_red_active`.

## Task 4 Public-Route Settlement And Exact Replay Transition — 2026-07-26

Accepted product remains HEAD `003b397c44ff3213867ec3b90850bbf24ae928ed` until the root writer freezes and commits this candidate. Task 4 is candidate proof/pre-freeze active, uncommitted, and not accepted; no operator gate, manifest, lockfile, live provider, or network action changed.

Two guarantees were repaired after public-route integration. Same-transaction committed CLI provider settlement now consumes the exact claimed approval and clears the exact action lease; stale or rollback settlement leaves that claim and lease intact, while identical replay adds no duplicate approval mutation. Post-commit `preDispatch` replay reserves or loads the exact attempt first, then validates state-specific exact approval custody: `reserved=active claimed`, `dispatched_unknown` or `proved_failed` = claimed, and `committed=consumed`; terminal replay returns a hold with no extra attempt, count, or provider permit. Wrong approval or token remains refused.

RED first observed consumed approval expected but still claimed; the next terminal replay was rejected as `not exactly claimed`. GREEN is core PostgreSQL proof in two files `49/49`, engine focused public-route proof in nine files `177/177` including one real-PostgreSQL workflow, core and engine typechecks PASS, and `git diff --check` PASS.

The public user-like path is import/reconcile -> work-item claim -> native workflow/`TaskExecutor` -> one local fake PTY spawn -> terminal committed settlement -> approval consumed/lease cleared -> restart visibility -> exact replay hold. It uses zero live provider or network activity. Luna is unavailable and Terra is the bounded documentation substitute; AGY is unavailable and native review remains planned. `execution_state` is `task4_candidate_proof_pre_freeze_active`.

## Task 4 Pre-Freeze Workspace And Dashboard Proof Transition — 2026-07-26

Accepted product remains HEAD `003b397c44ff3213867ec3b90850bbf24ae928ed`. This candidate remains uncommitted, unaccepted, and pre-freeze; no operator gate, manifest, lockfile, or live-provider action changed. `execution_state` remains exactly `task4_candidate_proof_pre_freeze_active`.

Full-workspace proof is now recorded. `pnpm typecheck` passed `34 of 36` workspace packages; the script excludes desktop and mobile. `pnpm build` passed, including the dashboard build over `7163` modules; only the existing Vite warnings remained.

The first full test run used `FUSION_PG_TEST_URL_BASE=postgresql://postgres@127.0.0.1:61316 pnpm test` and was a valid RED: two stale three-argument assertions in `workflow-node-handlers.test.ts` did not supply the fourth execution-context argument that production correctly required. Spark made a test-only GREEN repair to those two assertions. `pnpm --filter @fusion/engine test:core` then passed `299/299`; the rerun full `pnpm test` passed with engine `299/299`, core PostgreSQL gate `10/10`, and CLI CI-shape `65/65`, with no temporary or live `.fusion` leaks.

Dashboard build also exposed a false green: a direct dashboard import of `workflow-settings-resolver` reached Node-only `workflow-extension-provenance`. The pure resolver moved to browser-safe `execution-and-ui`, was exported through the types barrel, and dashboard now imports `@fusion/core`; the stale allowlist entry was removed. Focused core proof passed `45/45` and the dashboard build passed.

Dependency hydration did not install, fetch, or change a manifest or lockfile. Read-only Wave-3-retry links exposed stale Wave 1/2 workspace resolution, so a candidate-local link view bound the current `@fusion` and plugin packages. This is environmental proof scaffolding only: it must be removed or precisely accounted for before freeze.

Luna remains unavailable, so Terra is the bounded documentation substitute. AGY remains unavailable; native Sol review is still planned. This evidence does not claim Task 4 acceptance.

## Task 4 Full-Sweep Disposition And Final Pre-Freeze Gates — 2026-07-26

Accepted product remains HEAD `003b397c44ff3213867ec3b90850bbf24ae928ed`; the candidate remains uncommitted and unaccepted. `execution_state` remains `task4_candidate_proof_pre_freeze_active`. Freeze/council is next.

The default `pnpm test:full` first reached core `4352` pass / `1` skip, with three failures: one real architecture invariant (three bare `listTasks` calls) and PostgreSQL contention in schema-applier/transition coverage. Spark isolated the PostgreSQL lanes at `77/77`, `5/5`, and combined `82/82`, establishing non-deterministic full-sweep contention rather than a product failure.

The real invariant was repaired with explicit `{ slim: true, includeArchived: false }` at dashboard provider-health and two engine usage-limit call sites. Architecture passed `1/1`, usage-limit `49/49`, and provider-health `11/11`. The official serial full sweep then passed core `4355/4356`, with one documented skip.

The engine full-package run is not valid host proof: enforced no-TTY SafeExec blocks on scratch Git checkout/revert/reset/stash caused `93` files / `342` test failures, alongside single-worker mock pollution. Treat that result as environment-invalid, not a product regression; do not bypass SafeExec.

Fresh acceptance-relevant gates after the micro-fix all passed: `pnpm lint`; `pnpm typecheck` (`34/36`); `pnpm build` (dashboard `7163` modules); `FUSION_PG_TEST_URL_BASE=postgresql://postgres@127.0.0.1:61316 pnpm test` (engine `299/299`, PostgreSQL `10/10`, CLI `65/65`, zero leaks); Task 4 engine nine files `177/177`; and core Task 4 PostgreSQL two files `49/49`. Luna remains unavailable with Terra substitution; AGY remains unavailable and native Sol review remains planned. No acceptance is claimed.

## Task 4 Proxy Closure Bound GREEN Transition — 2026-07-26

Frozen candidate `b94dd45390d80ea13cb81feac0ff611960d9407d` was rejected by native Sol with P0 `0` and P1 `1`: proxy disposal could wait forever before the durable held floor. The candidate and its prior acceptance verdicts are invalidated.

RED expected `NATIVE_MCP_PROXY_DISPOSAL_TIMEOUT` but observed `TEST_PROXY_DISPOSAL_BOUND_EXCEEDED`. GREEN uses one deadline, `min(policy.deadlineAtMs, closeStart + termGraceMs + killClosureMs)`, while process-group and proxy closure run concurrently. Proxy timeout or error maps to `NATIVE_MCP_PROXY_DISPOSAL_FAILED`; state stays `needsAttention`, the fence and registry slot remain held, and no closure receipt is emitted.

Focused proof passed `1/1`; lifecycle passed `11/11`; the Task 4 engine nine-file lane passed `178/178`; core provider-controller plus CLI-session PostgreSQL passed `49/49`; engine typecheck, production/test ESLint, root lint, and `git diff --check` passed. The existing test-process `MaxListeners` warning remains visible.

The repair is uncommitted and unaccepted. Fresh integrated gates and a new final-byte council are mandatory. Task 5 ownership of the long-lived runtime resolver/bootstrap and mixed queue is unchanged. Current state is `task4_proxy_closure_bound_green_integrated_proof_active`.
