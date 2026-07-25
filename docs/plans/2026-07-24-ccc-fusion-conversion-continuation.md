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
| Wave 5 compiler code | Custody/repeatability proven; semantic contract rejected | `e29732e74f38393eeb0ba25e899dd14e012b9fbf` |
| Wave 5 integration branch | Current code-writing branch | `agent/ccc-fusion-wave-5-integration` |
| Wave 5 sidecar/compiler/import | Not implemented | Sidecar oracle and contract repair precede import |
| Wave 6 and Wave 7 | Speculative evidence only; unchanged replay rejected | Isolated worktrees, not ancestors of integration |
| Primary checkout | Not a product writing target | `main` has a generated-instruction descendant and one preserved pre-existing untracked report |

The Wave 5 product baseline contains exactly four forward-filled commits and 34 changed files relative to accepted Wave 4. Focused proof passed core 2/2, engine 5/5, and CLI 1/1 tests; core, engine, and CLI typechecks; lint; full build; cached rebuild; manifest and diff checks; and two identical compiler runs against the committed ccc-lab-super v7.2.3 fixture. Post-audit proof showed that the same 18-source fixture yields zero requirements, so these results establish custody and repeatability, not useful compiler semantics or Wave 5 acceptance.

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
- The audit is complete. The next implementation action is the packet-sidecar oracle, not import.

## Settled Post-Audit Decisions

- CF-009's current bundle is insufficient; the sidecar-driven CF-008 contract is reopened.
- `AsyncDataLayer.transaction()` is a useful primitive but not a complete import seam. Import needs transaction-aware writers plus an explicit filesystem unit of work.
- One real packet compiling, importing, restarting, and remaining inspectable with exact non-zero counts is the first useful local milestone.
- Waves 6 and 7 collapse into one native enforcement/integration slice. The Wave 6 production design is discarded and Wave 7 unchanged replay is rejected.
- Waves 8–10 remain in scope as locally achievable consolidated equivalents; only live/external actions are deferred to operator gates.
- Safe fanout is limited to read-only inventories, disjoint fixtures, independent count oracles, failure-matrix design, and review until consumed contracts freeze.

## Recovery And Handoff

- Recovery Rule: after compaction or a fresh session, read the vault checkpoint first, then this note, then verify live branch/HEAD/tree/status before issuing work.
- Handoff Rule: the next agent reads the completed audit and adjudication, verifies live Git, creates the requested `/goal`, and updates the vault checkpoint after each material transition.
- Resume Rule: local product implementation resumes on the Wave 5 integration spine with the packet-sidecar oracle. It does not begin a provider, credential, billing, non-loopback, fetch, push, merge, release, publication, protected-path, or `main` action.
