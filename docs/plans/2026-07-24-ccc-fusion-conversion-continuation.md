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
| Accepted Phase A/B contract | Generated sidecar, structural compiler, validate, and built CLI | `90c585766b37605aae4be5a9ad6880455e1b7afa` |
| Accepted Phase C import | PostgreSQL/filesystem unit of work, recovery, and idempotency | `d0debd4ee1b50276b149741e23bbe69c18360ba2` |
| Task 2 acceptance branch | Accepted product candidate; documentation descendant pending root commit | `agent/ccc-fusion-task2-plan-repair` |
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

- Surfaces: `packages/core/src/workflow-extension-types.ts`, `packages/core/src/workflow-extension-registry.ts`, `packages/core/src/task-store/async-workflow-workitems.ts`, `packages/core/src/task-store/workflow-workitems-ops-2.ts`, workflow transition types, `packages/engine/src/plugin-workflow-extension-adapter.ts`, `packages/engine/src/workflow-task-runtime.ts`, `packages/engine/src/workflow-work-processor.ts`, new `packages/engine/src/ccc-campaign-proof-admission.ts`, existing extension/runtime/processor tests, and new `packages/engine/src/__tests__/ccc-campaign-proof-workflow.test.ts`.
- RED: missing, degraded, replaced, digest-drifted, unknown-proof, stale-input, or false proof extensions must block before provider/session work; stale lease owners must not write terminal state; a long node must renew its workflow lease; cancellation or lease loss must abort the owned node and prevent late success; a claimed campaign work item must execute the complete workflow graph when entered only through `processDueWorkflowWorkItem`, not the one-node `runWorkItem` path.
- GREEN: add a `proof-admission` workflow-extension kind with pinned plugin/version/canonical local source/digest/proof-version identity and a fail-closed result contract. Load proof definitions from the persisted campaign context and bind proof, campaign, bundle, node, attempt, and input digest. Add expected-state/lease-owner/attempt preconditions to native work-item transition, a CAS lease-renewal method, processor-owned AbortController, renewal-loss abort, and signal propagation into the node handler. Treat an already-durable `cancelled` work item as cancellation truth, not a failed late terminal write. For a work item with persisted campaign provenance, make `processDueWorkflowWorkItem` load the mapped task and call the existing full-graph `WorkflowTaskRuntime.run` under the same claimed lease, attempt fence, and cancellation signal; the processor remains the sole terminal-transition owner. Keep `runWorkItem` for ordinary native one-node items, so no scheduler or graph executor is duplicated. Freeze a required campaign-action admission callback on `WorkflowTaskRuntime` so Task 4 can place the same persisted gate immediately before any provider-capable node handler; missing callback for a campaign node fails closed.
- REFACTOR: ordinary non-campaign extensions and workflow items retain compatibility; the strict proof and lease preconditions activate only when campaign provenance exists or when an explicit expected-owner transition is used.
- Verification: `pnpm --filter @fusion/core exec vitest run src/__tests__/workflow-extension-registry.test.ts src/__tests__/postgres/taskstore-remaining.test.ts --silent=passed-only --reporter=dot`; `pnpm --filter @fusion/engine exec vitest run src/__tests__/workflow-work-processor.test.ts src/__tests__/workflow-task-runtime.test.ts src/__tests__/ccc-campaign-proof-workflow.test.ts --silent=passed-only --reporter=dot`; core/engine typechecks and builds; focused lint.
- Done when: proof provenance fails closed and no stale, cancelled, or lease-lost worker can publish success.

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

- Surfaces: new `packages/engine/src/ccc-campaign-git-admission.ts`, `packages/engine/src/merger-ai.ts` at the sole `runAiMerge` chokepoint, `packages/engine/src/merger-ref-update-advance.ts`, `packages/engine/src/merger-overlap-guard.ts`, existing merger/ref tests, and new `packages/engine/src/__tests__/ccc-campaign-git-integration.real-pg.test.ts`.
- RED: lexical/canonical target mismatch, symlink ancestor, invalid ref, dirty integration checkout, foreign HEAD/base, hard overlap, unapproved protected merge, and out-of-manifest mutation must refuse before provider or Git mutation. Inject interruption before CAS, after CAS before success audit, and after success audit. Prove manual conflict hold when the observed ref is neither expected nor new. A landed or reconciled ref must consume the exact winning approval claim once; an unknown or manual-hold outcome must keep it claimed.
- GREEN: derive campaign Git context from the persisted task/import mapping inside `runAiMerge`; require the admitted base to resolve to a local commit object; use the existing realpath/no-symlink admission before manifest evaluation; and re-resolve target, common Git directory, checkout `HEAD`, base ancestry, and ref immediately before mutation. Disable campaign dirty-autostash, auto-sync, push, and fail-open overlap modes. Persist an exact native run-audit intent before `update-ref`. On retry, `ref == new` plus matching intent means landed and calls the Task 4 authoritative action reconciler to CAS-consume the exact approval claim before appending terminal success; `ref == expected` means retryable; any other ref appends manual hold and preserves the claim. Audit failure after a landed CAS must not be classified as foreign concurrency.
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

- Accepted product: `bdd5cfce44271ba2f13636098e6d736dcf7ea874`; branch `agent/ccc-fusion-task2-plan-repair`; parent `32593d796e76583ac6b9d921db67cf77da5dc6b5`; tree `edc3d571bfb617ada24f889489307968cb567880`. The documentation descendant is pending the root writer's documentation commit and therefore is deliberately not self-named here.
- Scope accepted: Task A authoring, Task B compiler/import-proof/runner integrity, Task 2 native run-audit/approval/effect governance, and the P1-03/P1-04 corrections. Provenance for campaign effects is always TaskStore-derived and reloaded; `campaign_project_id = project_id` is protected by an enforceable composite foreign key. Approval and effect replay/CAS semantics are accepted.
- `0037_ccc_campaign_governance.sql` is the final indivisible migration. It incorporates the legacy `0036` provider-capability repair, fresh-schema and upgrade parity, and governance DDL; no `0038` is permitted for this slice. The audit's P1-03 safety concern is accepted at P0 impact. P1-04 is partially accepted only in its stated boundary: a valid MCP `result.isError: true` commits/replays, while top-level RPC errors, malformed/missing results, disconnects, and aborts remain `dispatched_unknown`.
- Frozen proof: focused Task 2 PostgreSQL `177/177`; engine descendants `80/80`; CLI Task A `2/2`; closed Wave 5 `81/81` twice; full typecheck, lint, build, diff hygiene, and manifest verification. The proof report digest is `d2cf29944bc5cc2556038c99ee5f7d47e637b6a2f5f239eb47d3bd79593ecc12`.
- Fresh behavioral/PostgreSQL, static/build, and AGY adversarial (`dedbf944-4add-4e02-a867-7e1c3311188d`) lanes all returned PASS with no P0/P1. The AGY reviewer noted only that bounded authoring response content is accumulated in memory before the `maxResponseBytes` cap; it is nonblocking and does not alter the enforced byte ceiling.
- The closed Wave 5 mapping remains exactly 81 unique names despite the one migration-body repair; Task A tests remain outside it. Changed-path digest: `a198ac879692fa384363eb9b7ea2fbcb2c9f7ddebf28cd29d1317b06004044b9`. Accepted-predecessor binary diff digest: `be108c15b7dbb7c38aded491389ff7cea6164cb2562d672d147d5f3ac9bbb9b7`. Package/workspace/lock hashes remain `cf1e924d…`, `0e5f3ad…`, and `09244dac…`.
- Wave 6 `2a739f13bfbea4e2c10a46570719fbd6441ba0a6` and Wave 7 `93309dcaa111614dfd2c2362d96525f9af597dc7` remain unaccepted development evidence; neither is replayed. All provider, credential, billing, non-loopback, fetch, push, merge, release, publication, remote-adoption, and `main` gates remain unissued. Next sequence: Tasks 3–10.

## Recovery And Handoff

- Recovery Rule: after compaction or a fresh session, read the vault checkpoint first, then this note, then verify live branch/HEAD/tree/status before issuing work.
- Handoff Rule: the active goal already exists. The sole accepted-spine writer resumes from accepted Task 2 `bdd5cfce44271ba2f13636098e6d736dcf7ea874`, then advances Tasks 3–10 and updates the vault checkpoint after each material contract, RED, GREEN, commit, review, or operator gate.
- Resume Rule: local product implementation resumes from accepted Task 2 through the consolidated native E/F plan above. It does not begin a live provider, credential, billing, non-loopback, fetch, push, merge, release, publication, protected-path, upstream-adoption, or `main` action.
