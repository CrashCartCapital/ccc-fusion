# ccc-fusion Conversion Continuation

## Goal

Finish the remaining ccc-fusion conversion with one accepted predecessor chain, one central writer for shared integration surfaces, bounded fanout work that respects real dependencies, and proof that reflects user-visible behavior rather than test ceremony.

This is the code-local continuation packet. The vault remains authoritative for product requirements, operator gates, and changing orchestration state:

- Product contract: `/Users/ryanpappal/01_VAULT/KnR-Vault/00_MAIN/01_ActiveProjects/ccc-fusion/PRJ-AI-ccc-fusion-PRD-v0.1.md`
- Implementation plan: `/Users/ryanpappal/01_VAULT/KnR-Vault/00_MAIN/01_ActiveProjects/ccc-fusion/PRJ-AI-ccc-fusion-ConversionPlan-v0.1.md`
- Current execution ledger: `/Users/ryanpappal/01_VAULT/KnR-Vault/00_MAIN/01_ActiveProjects/ccc-fusion/REF-AI-ccc-fusion-Phase5-OrchestrationCheckpoint.md`
- Parallel-work policy: `/Users/ryanpappal/01_VAULT/KnR-Vault/00_MAIN/01_ActiveProjects/ccc-fusion/REF-AI-ccc-fusion-ParallelForwardFillExecutionApproach-2026-07-24.md`

## Success Criteria

- A fresh audit identifies plan defects, unnecessary work, missing user-facing acceptance, weak tests, unsafe parallelism, and the shortest safe remaining route.
- Wave 5 compilation and validation remain deterministic and side-effect free.
- Wave 5 import is one explicit PostgreSQL transaction or an equally strong repository-native atomic boundary.
- Failed import creates no runnable partial campaign.
- Repeating the same admitted import does not duplicate tasks, edges, workflows, documents, artifacts, or campaign identity.
- Verification reports exact imported counts and hashes against a disposable project fixture.
- The central writer owns shared persistence and CLI seams; child sessions work only on collision-free audit, test, fixture, review, or frozen-contract scaffolding lanes.
- No speculative Wave 6 or Wave 7 code becomes accepted without replay onto and proof against the accepted predecessor.

## Current Verified State

| Surface | State | Identity |
|---|---|---|
| Accepted Wave 4 | Accepted and frozen | `726db7806c5964097f982b7048da680d2fdd750a` |
| Wave 5 compiler code | Forward-filled and verified | `e29732e74f38393eeb0ba25e899dd14e012b9fbf` |
| Wave 5 integration branch | Current code-writing branch | `agent/ccc-fusion-wave-5-integration` |
| Wave 5 import | Not implemented | Blocked on audit and contract freeze |
| Wave 6 and Wave 7 | Speculative evidence only | Isolated worktrees, not ancestors of integration |
| Primary checkout | Untouched writing target | `main` at pinned fork base |

The Wave 5 code baseline contains exactly four forward-filled commits and 34 changed files relative to accepted Wave 4. Focused proof passed core 2/2, engine 5/5, and CLI 1/1 tests; core, engine, and CLI typechecks; lint; full build; cached rebuild; manifest and diff checks; and two identical compiler runs against the committed ccc-lab-super v7.2.3 fixture.

## Implemented Compiler Surface

- `packages/core/src/ccc-prd/` owns the public packet, source, diagnostic, requirement, proof, bundle, protected-action, and hash contracts.
- `packages/engine/src/ccc-prd/` owns pure manifest admission, path and hash checks, requirement extraction, protected-action discovery, deterministic sorting, and bundle creation.
- `packages/cli/src/commands/prd.ts` owns zero-store `compile` and `validate` commands.
- `packages/engine/src/__tests__/fixtures/ccc-prd-canaries/` owns approved test copies for SRU, ccc-lab-super, and the Neo handoff candidate.
- `packages/core/src/__tests__/ccc-prd-schema.test.ts`, `packages/engine/src/__tests__/ccc-prd-compiler.test.ts`, `packages/engine/src/__tests__/ccc-prd-corpus.test.ts`, and `packages/cli/src/commands/__tests__/prd.test.ts` are the current focused proof.

The public compiler contract is frozen for the import slice unless a new failing test proves it cannot express a required user outcome.

## Remaining Wave 5 Slice

### Import Contract

The audit must first freeze:

- the admitted bundle identity and idempotency key;
- exact task, dependency-edge, workflow-definition, document, artifact, and campaign records created;
- which repository-native PostgreSQL transaction owns all writes;
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

Do not spread import logic across existing task-creation helpers before identifying one transaction owner. Do not add a second database, scheduler, receipt store, parser, or dashboard intake path.

## Dependency-Aware Execution Route

### Stage 1 — Independent Audit

One Nimbalyst meta-agent owns the audit. Fanout children independently inspect product/user value, implementation structure, test quality, persistence/import seams, and remaining dependency/parallelism. Children are read-only. The parent adjudicates conflicts and writes one vault report.

### Stage 2 — Contract And RED Freeze

The parent converts accepted audit recommendations into one exact Wave 5 import contract. One central writer receives shared-file authority. Independent children may prepare read-only source maps, test case designs, corpus count oracles, and disposable-fixture plans, but only the writer changes product files and tests.

### Stage 3 — Transactional Import

The writer captures valid RED for partial rollback, duplicate import, zero-store compile/validate, exact counts, and CLI refusal before production edits. The smallest implementation then reaches targeted GREEN and preserves the compiler baseline.

### Stage 4 — Integrated Candidate Proof

Freeze exact branch, HEAD, tree, status, manifests, accepted-predecessor digest, changed files, and proof artifacts. Run focused compiler/import tests first, then relevant package typechecks, lint, `pnpm test:gate`, build, diff checks, and disposable PostgreSQL proof. Preserve failed PostgreSQL evidence; clean successful owned fixtures.

### Stage 5 — Independent Acceptance

Fan out fresh behavioral/PostgreSQL, static/build, and final-artifact reviews against identical frozen bytes. Any P0/P1 returns to the sole writer for one evidence-backed repair cycle. Full Wave 5 becomes accepted only after all lanes pass and the parent re-freezes identity.

### Stage 6 — Later Waves

After full Wave 5 acceptance, inspect and replay only still-valid Wave 6 speculative commits. Complete its deferred shared seams, rerun integrated proof, and accept it before doing the same for Wave 7. Waves 8–10 remain ordered behind those predecessor contracts and their operator gates.

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
- The next action is audit, not implementation.

## Open Questions For The Audit

- Is CF-009's current bundle detailed enough to create the required tasks, edges, workflow definitions, documents, and artifacts without expanding the compiler contract?
- What is the narrowest existing PostgreSQL transaction seam that can own the complete import?
- Which exact operator-visible result makes import useful before the later proof/receipt waves exist?
- Which remaining Wave 6–10 items can be cut, merged, delayed, or converted into acceptance checks?
- Which speculative Wave 6/7 commits are likely to survive and which should be abandoned rather than repaired?
- What fanout shape minimizes total wall time without increasing replay cost or weakening proof?

## Recovery And Handoff

- Recovery Rule: after compaction or a fresh session, read the vault checkpoint first, then this note, then verify live branch/HEAD/tree/status before issuing work.
- Handoff Rule: the next agent writes its audit to `/Users/ryanpappal/01_VAULT/KnR-Vault/00_MAIN/01_ActiveProjects/ccc-fusion/conversionplan-v0.1-progress-analysis-and-recommendations.md`; it does not edit product code.
- Resume Rule: product implementation resumes only after Ryan reviews that report and the parent freezes the accepted remaining route.
