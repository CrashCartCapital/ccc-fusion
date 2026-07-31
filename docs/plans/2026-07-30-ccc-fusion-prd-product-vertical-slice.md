# CCC Fusion PRD Product Vertical Slice

**Status:** implementation candidate; broad dirty-tree gates green, exact clean-tree acceptance pending
**Plan path:** `docs/plans/2026-07-30-ccc-fusion-prd-product-vertical-slice.md`
**Accepted base:** `1dd173311fbf7c16f85213066cc881fc959a2a2c`
**Accepted base tree:** `ec30f36368d72b756640793374541636e307e696`
**Implementation worktree:** `/Users/ryanpappal/03_CODE/ccc-fusion-worktrees/prd-product-vertical-slice`
**Product target:** one supported CLI-first operator journey, with the dashboard consuming the same contracts after the spine is proven

## Outcome

A normal operator can freeze a Markdown PRD packet, review a hash-bound semantic sidecar and execution preview, confirm the exact preview, import it through Fusion's transactional importer, run coding nodes in an isolated worktree, execute every admitted verifier against the final campaign-created commit, recover conservatively from uncertain effects, and stop at an exact human merge approval. The product path uses normal `fn` commands and the production engine. The acceptance harness may drive that path but may not replace it with test-only mutations, prebuilt commits, or a custom importer.

## Baseline evidence

- Local `origin/main` is the accepted product lineage at `1dd173311fbf7c16f85213066cc881fc959a2a2c`; the dirty shared checkout is inspection-only and is not an implementation baseline.
- `pnpm verify:fast` passed all 11 static/build/boot-smoke steps on the integrated dirty implementation tree, including built `fn --help` and a real `/api/health` 200 response.
- `node scripts/run-ccc-pg-proof.mjs --wave 6` passed the exact six-command PostgreSQL inventory on the integrated dirty implementation tree: 416 passed (69 + 53 + 95 + 139 + 54 + 6), with zero missing, skipped, extra, timed-out, or force-killed tests.
- `pnpm test:gate`, bound explicitly to an owned disposable PostgreSQL service, passed PostgreSQL 10/10, engine 299/299, and CLI 65/65 on the integrated dirty implementation tree.
- `pnpm lint`, `pnpm typecheck`, `pnpm build`, and `git diff --check` passed on the same integrated bytes. These are not substitutes for the final clean-commit product acceptance.
- No fetch was performed. The remote-tracking ref is a local fact, not proof of current GitHub state.

## Approach decision

### Adopt: extend the existing CLI and execution spine

Extend `fn prd` with hash-bound preview, confirmation-bound import, inspection, and reconciliation. Reuse the current packet compiler, transactional importer, workflow work-item runtime, task worktree lifecycle, provider-attempt controls, bounded verifier runner, approval system, and Git landing CAS.

### Defer: dashboard-first construction

The dashboard remains the first-class operator experience, but building it before the stateful spine is proven would duplicate changing contracts. It will consume the same preview, campaign-status, recovery, and approval services after the CLI vertical slice is green.

### Reject: standalone script or new orchestrator

A developer-written glue script would not be the supported product route and would create a second control plane. The exact-tree acceptance script may provision disposable resources and invoke the normal CLI/engine; it may not import, mutate campaign state, create the implementation commit, or mark proof results directly.

## Audit-finding disposition ledger

| July 30 finding | Disposition | Current evidence | Acceptance requirement |
|---|---|---|---|
| The shared checkout lacked the accepted product while local `origin/main` contained it. | Adopt | The accepted isolated worktree starts at local `origin/main` commit `1dd173311fbf7c16f85213066cc881fc959a2a2c`, tree `ec30f36368d72b756640793374541636e307e696`; the dirty shared checkout remains inspection-only. | Final proof names the integrated commit/tree and reruns all gates there. No local remote-tracking ref is described as live GitHub proof. |
| The transactional importer had no normal operator caller. | Adopt | `fn prd preview`, confirmation-bound `import`, `inspect`, `reconcile`, and redacted `status` call the production compiler/import/status services. | The exact acceptance command must invoke the built CLI and prove rejected provenance leaves no database or filesystem residue. |
| Imported tasks defaulted to read-only thinking rather than coding custody. | Adopt | Product policy v2 requires coding tool mode, isolated worktrees, owned paths, route-scoped write roots, provider/model/transport, and required commits; importer and runtime tests exercise the production preparation seam. | A real runtime provider must change one admitted file in the acquired worktree; the fenced controller must create the required commit and refuse dirty, unchanged, wrong-branch, filtered, or foreign-path output. |
| Proof admission checked declarations but did not execute tests. | Adopt with modification | Admission remains an explicit pre-dispatch trust check. A separate durable proof-attempt service now runs every declared command against the exact campaign commit and records terminal evidence. | A planted defect must produce a fresh `proved_failed` receipt; a corrected campaign commit must produce a fresh `committed` receipt; landing must reject every stale or mismatched receipt. |
| Real-PRD canaries extracted only three requirements and did not change target code. | Adopt | Historical fixtures are treated only as intake leads; they are not product completion evidence. | Build a current three-packet manifest, report omissions/questions/coverage, run one approved live authoring experiment, and keep private vault bytes out of Git. The product acceptance route must change disposable target source. |
| The broad campaign gate and PostgreSQL proof were not fresh. | Adopt | On the integrated implementation bytes, `pnpm test:gate` passed PostgreSQL 10/10, engine 299/299, and CLI 65/65; Wave 6 passed its exact 416-test inventory. | Rerun the exact product acceptance on the clean integrated commit; stale baseline runs do not close this item. |
| Documentation overstated import/runtime completeness. | Adopt | This plan separates designed, implemented, tested, locally proven, live, and deployed states and identifies the remaining real-runtime/acceptance work. | Update operator documentation only after the built CLI/runtime acceptance is fresh-green; do not claim live provider or deployment proof. |
| A unified campaign-admission helper may be unused while runtime-specific gates exist. | Defer | Current product safety is enforced at the narrower work-item lease, provider-attempt, proof-attempt, approval, path, and Git-CAS seams. Centralization is not required for the shortest vertical slice. | Every supported execution route must reach those exact gates. Remove or consolidate the compatibility helper only in a separately proved cleanup; do not weaken a runtime-specific fence to make the helper appear authoritative. |

## Frozen product contracts

### Operator journey

1. `fn prd author` freezes ordered sources and creates a reviewable `ccc-prd.sidecar.v1`.
2. `fn prd preview` recompiles and validates the packet, execution policy, target repository, target HEAD, project context, unresolved decisions, requirement coverage, proof coverage, protected actions, routes, paths, and bounds. It prints a canonical preview plus a confirmation digest.
3. `fn prd import --confirm <digest>` repeats the complete preflight and recomputes the digest. Any byte, target HEAD, policy, project, or context drift refuses before database or filesystem residue.
4. The transactional importer activates the campaign and work item only after projection is complete.
5. The production engine dispatches coding nodes under campaign custody. The task worktree lifecycle creates and reuses the isolated worktree; campaign nodes cannot run through an unguarded executor.
6. The final proof barrier requires a clean campaign worktree and a campaign-created commit descended from the frozen baseline, verifies changed paths, and executes all admitted proof commands against that exact final commit.
7. The merge seam refuses absent, failed, stale, reused, wrong-tree, or wrong-commit proof receipts. It issues or waits for an exact human merge approval and does not advance the target ref before that approval is claimed.
8. Inspection surfaces explain active work, blockers, proof results, uncertain effects, approval expiry, recovery choices, and the next safe action.

### PRD sidecar

Keep `ccc-prd.sidecar.v1` as the semantic intake contract. It already binds ordered source paths and hashes; requirements and acceptance; tasks and dependencies; proofs; protected actions; bounds; admitted write roots; target repository and base; non-goals; unresolved decisions; ambiguities; exceptions; confidence; and authoring provenance. Tighten validation rather than silently inventing missing product decisions.

Required product-import refusals include:

- zero requirements, tasks, workflows, or proofs;
- a material source section with no task, explicit deferral, out-of-scope disposition, or unresolved question;
- unresolved implementation-changing decisions;
- target repository, baseline, or admitted path drift;
- missing requirement-to-task or requirement-to-proof coverage;
- an implausibly shallow extraction relative to the frozen source packet;
- compiler provenance, source span, excerpt hash, or bundle hash mismatch.

Future PRDs get an optional lint/template contract. Existing PRDs remain unchanged; normalization is a reviewable successor proposal, never an in-place rewrite.

### Execution policy

Preserve `ccc-campaign.execution-policy.v1` only for legacy programmatic compatibility. It does not qualify for the supported product route.

Add `ccc-campaign.execution-policy.v2`. Every semantic task has exactly one route with exact keys:

- `taskId`
- `providerId`
- `modelId`
- `transport`: `pi` or `cli` for the first supported product version
- `executor`: `model` for `pi`, `cli-agent` for `cli`
- `toolMode`: exactly `coding`
- `worktreeMode`: exactly `isolated`
- `ownedPaths`: non-empty canonical target-relative paths
- `allowedWriteRoots`: non-empty canonical target-relative roots, each contained by both the PRD-admitted roots and the task's ownership
- `commitPolicy`: exactly `required`
- `cliAdapterId`: required only for `cli`

The parser rejects unknown fields, duplicate or missing task routes, path overlap between concurrently runnable tasks, path escape, provider/model/transport mismatch, and any read-only or shared-checkout posture. Imported task metadata and generated workflow IR both carry the validated contract. Coding nodes set `toolMode: "coding"` and the correct executor fields. The in-process campaign runtime must call the existing graph preparation hook so the normal task worktree acquisition runs before a write-capable node.

### Proof execution

Proof-definition admission remains a separate pre-dispatch trust check. It must continue to say that it does not execute the command.

Add a dedicated PostgreSQL proof-attempt receipt with immutable identity:

- project, import, campaign, native task, semantic task, workflow work item, and proof IDs;
- packet, sidecar, bundle, manifest, and campaign binding hashes;
- target repository and frozen base;
- final source commit and source tree;
- admitted proof definition and command hashes;
- controller token and timestamps;
- state: `reserved`, `dispatched_unknown`, `committed`, or `proved_failed`;
- bounded terminal evidence: exit code, duration, stdout/stderr digests and tails, changed-path digest, and negative-control label when the acceptance harness supplies one.

The unique identity is campaign + semantic proof + final source commit + proof-definition hash. Reserve and mark `dispatched_unknown` transactionally before process spawn. A restart that finds `dispatched_unknown` never spawns again; it parks the workflow work item in the existing `manual-required` state and shows settle-or-abandon choices. A terminal receipt replays without spawning. A process result may settle only the exact controller token and immutable identity.

The generated workflow has one final proof barrier after all terminal coding nodes and before Git landing. It:

1. requires an existing isolated worktree;
2. refuses dirty or detached campaign state;
3. requires `HEAD` to differ from and descend from the frozen base;
4. requires all changed paths to be inside the union of task ownership and PRD-admitted roots;
5. runs every required admitted proof command through the bounded verifier runner;
6. stores each result against the same final commit and tree;
7. fails closed on missing, extra, duplicate, stale, or definition-mismatched proof results.

Running the whole required proof set at the final commit prevents an earlier task's passing receipt from authorizing later unverified changes.

### Git landing and approval

Before creating durable landing intent, require one successful `committed` proof receipt for every required proof ID, all bound to the exact source commit and tree being prepared for landing. Refuse missing, reused, failed, `dispatched_unknown`, stale, wrong-definition, wrong-tree, or wrong-commit receipts.

Keep the existing target-baseline check, deterministic object preparation, admitted-path check, claimed approval lease, compare-and-swap ref update, terminal audit, and single-use approval consumption. Automatic merge remains out of scope. The first operator-visible stop is an issued human merge approval with the target ref unchanged.

## Implementation sequence

### Stage 1: core coding contract

**Owned production files**

- `packages/core/src/ccc-campaign/types.ts`
- `packages/core/src/ccc-campaign/canonical.ts`
- `packages/core/src/ccc-prd/projection.ts`
- `packages/core/src/ccc-prd/importer.ts`
- `packages/core/src/ccc-prd/import-admission.ts`
- `packages/core/src/__test-utils__/ccc-prd-import-fixture.ts`

**RED**

- Extend core contract/import tests so product import rejects v1/read-only routes.
- Assert v2 rejects missing ownership, overlapping concurrent ownership, path escape, invalid transport/executor pairs, and unknown fields.
- Assert native IR emits coding-capable nodes, one final proof barrier, and merge only after that barrier.

**GREEN**

- Add the strict versioned parser and projections.
- Preserve explicit v1 compatibility in existing programmatic callers, while the normal product caller requires v2.

**Narrow proof**

`pnpm --filter @fusion/core test -- --run ccc-campaign ccc-prd-import`

### Stage 2: supported CLI preview and import

**Owned production files**

- `packages/cli/src/commands/prd.ts`
- `packages/cli/src/bin.ts`
- `packages/cli/src/project-context.ts`
- `packages/cli/src/__tests__/prd-command.test.ts`
- `packages/cli/src/__tests__/bin.test.ts`

**RED**

- Preview refuses missing project context, unresolved decisions, target HEAD drift, and v1 execution policy.
- Import refuses no confirmation, wrong confirmation, and preview-to-import source/policy/HEAD drift with zero database and filesystem residue.
- A database bootstrap failure is a clear preflight error rather than an unhandled connection exception.

**GREEN**

- Reuse the existing project-context and async-layer lifecycle used by stateful CLI commands.
- Recompile and recompute the confirmation digest during import.
- Call the production `importCccPrdBundle`, `inspectCccPrdImport`, and `reconcileCccPrdImport` APIs.

**Narrow proof**

`pnpm --filter @fusion/cli test -- --run prd-command bin`

### Stage 3: campaign worktree preparation

**Owned production files**

- `packages/engine/src/executor.ts`
- `packages/engine/src/runtimes/in-process-runtime.ts`
- `packages/engine/src/workflow-node-execution-needs.ts`
- relevant engine runtime tests

**RED**

- The fenced in-process campaign runtime must invoke node preparation for a v2 coding node.
- An unguarded executor or a campaign node missing the isolated-worktree/path contract must refuse before provider dispatch or source mutation.
- The coding node must execute from a registered task worktree and persist the assigned branch/worktree.

**GREEN**

- Expose a narrow public preparation adapter on `TaskExecutor`.
- Pass it into `WorkflowTaskRuntime` from the in-process campaign runtime.
- Validate campaign ownership again at the execution boundary.

**Narrow proof**

`pnpm --filter @fusion/engine test -- --run ccc-campaign-runtime-bootstrap workflow-node-execution-needs`

### Stage 4: durable exact-commit proof execution

**Owned production files**

- `packages/core/src/postgres/schema/campaign-governance.ts`
- `packages/core/src/postgres/schema/index.ts`
- `packages/core/src/postgres/migrations/0038_ccc_campaign_proof_attempts.sql`
- `packages/core/src/postgres/migrations/meta/_journal.json`
- `packages/core/src/ccc-campaign/proof-attempt.ts`
- task-store/data-layer plumbing and exports
- `packages/engine/src/ccc-campaign-proof-execution.ts`
- `packages/engine/src/executor.ts`
- proof-attempt and workflow tests

**RED**

- Reserve/dispatch/settle transitions reject identity drift and duplicate dispatch.
- A crash after dispatch persists `dispatched_unknown`; restart returns `manual-required` and never spawns again.
- A planted verifier defect stores `proved_failed`; the corrected campaign commit stores `committed`.
- Dirty worktree, unchanged baseline, foreign path, wrong proof definition, wrong commit, missing proof, duplicate proof, or extra proof refuses.

**GREEN**

- Add the dedicated table and strict transition API modeled on provider attempts.
- Add the final proof barrier runner using `runVerificationCommand`.
- Route uncertain dispatch through the existing work-item `manual-required` disposition.

**Narrow proof**

`node scripts/run-ccc-pg-proof.mjs --wave 6`

### Stage 5: proof-gated human landing

**Owned production files**

- `packages/engine/src/ccc-campaign-git-landing.ts`
- `packages/engine/src/ccc-campaign-git-objects.ts`
- campaign Git integration tests

**RED**

- Landing refuses no proof, failed proof, `dispatched_unknown`, a receipt for ancestor commit C1 when source is C2, wrong tree, wrong definition, incomplete campaign work, foreign paths, baseline drift, unrecorded effects, and missing/reused approval.
- Without human approval the target ref remains unchanged and the campaign exposes the exact pending decision.

**GREEN**

- Query and validate the complete exact-commit proof set before durable landing intent.
- Preserve the existing approval and Git compare-and-swap behavior.

**Narrow proof**

`pnpm --filter @fusion/engine test -- --run ccc-campaign-git-integration`

### Stage 6: one non-test vertical slice

**Owned production files**

- `scripts/ccc-prd-product-acceptance.mjs`
- `package.json`
- sanitized fixtures under existing test fixture roots
- operator CLI documentation after the bytes are proven

**Acceptance command**

`pnpm verify:ccc-prd-product`

The command must:

- require a clean exact input tree and record HEAD/tree/package hashes;
- provision an owned embedded PostgreSQL cluster and disposable Git target;
- invoke the built normal `fn prd` author/preview/import path;
- prove a compiler-provenance bypass leaves zero database and filesystem residue;
- run the production engine with a deterministic disposable coding provider that edits only one admitted file, then require the fenced controller to create the campaign commit;
- run the exact admitted verifier and show a planted defect fails;
- rerun from a fresh campaign/target, create the corrected commit, and show the verifier passes;
- exercise forbidden-path and dispatched-without-terminal negative controls;
- restart at import, dispatch, proof, and landing cut points;
- show idempotent replay or `manual-required`, never duplicate uncertain effects;
- stop on the real human merge approval with the target ref unchanged;
- reject missing, skipped, extra, stale, and provenance-mismatched checks.

The deterministic provider is acceptance infrastructure, not the product path. It enters through the same production provider/controller and worktree seams as a configurable real provider, and it may not pre-create the commit or mutate task/proof state directly. Native PRD authoring in the acceptance route uses the normal built `fn prd author` command against a disposable OpenAI-compatible streaming loopback; it is local product-path proof, not a live-provider claim.

### Stage 7: operator experience and real PRD understanding

- Add CLI campaign status, pause, resume, stop, proof inspection, and explicit settle-or-abandon commands over production services.
- Add one dashboard journey over the same contracts: PRD selection, preview, import approval, progress, blockers, diff, proof, recovery, and merge approval.
- Build a current, local-only corpus manifest from `00_MAIN/01_ActiveProjects`, excluding protected and archive-like paths.
- Run three representative packet canaries and report selection, hashes, requirement coverage, omissions, ambiguity, task quality, proof expectations, protected actions, and questions.
- Run one bounded live authoring experiment only after operator authorization for the approved provider route. Fixtures and replayed proposals remain `tested`, not `live`.
- Add the optional future-PRD lint/template without changing approved source PRDs.

**Current local corpus evidence (2026-07-31)**

- The built `fn prd discover` command scanned the current `00_MAIN/01_ActiveProjects` tree without archive or protected-path reads: 10 project-local selections, 2 explicit ambiguities, and 12 projects with no candidate. It selected `ccc-fusion/PRJ-AI-ccc-fusion-PRD-v0.1.md` over a same-version conversion report by the explicit PRD filename signal; it did not trust the portfolio tracker as lineage authority.
- Three representative packets froze outside the vault with exact source receipts and no vault writes: agentic-trade-management packet `a471dfedad47a8df0783c92ed35285b76a3515fcb847f06a69f83b73f281f5f5` (3 files, 343,953 bytes, 5 unresolved ordinary references), ccc-quant-engine packet `ecc8b600ee4a93d3aa95242005d6c24d0572f7adde906d43a9ebfcd7e7049403` (1 file, 135,219 bytes, no unresolved references), and ccc-quant-wiki packet `3d9a2a2ad481ab14a594e9e2c0075d85de99050b9a08c68d2323baca73f9b5ad` (5 files, 156,952 bytes, 6 unresolved ordinary references). Unresolved missing, outside-project, or archive links are reported but never read or silently invented.
- Two meaningful negative controls refused atomically with no output directory: the current ccc-fusion PRD declares a missing authority document, and the selected ccc-lab v7.2.3 PRD declares a source unavailable in the active project tree. Explicit authority remains fail-closed.
- The optional intake-contract linter reports understandable implementation questions without rewriting source. All 10 current selections still lack an explicit exact target repository, 40-hex baseline, and allowed write roots under this contract; packet-specific gaps also include acceptance behavior, expected proof, or protected actions. Those facts must come from Ryan or an authoritative source before native authoring; the product does not infer them from folder names.
- State is `locally proven` for discovery, freeze, custody, unresolved-reference reporting, lint/template output, and refusal residue. Requirement/task/proof extraction on these real packets remains `blocked` pending one operator-authorized live authoring route plus explicit target/baseline/path decisions; fixture proposals remain only `tested`.

## Pre-mortem

- **False vertical slice:** the acceptance harness mutates DB state or prebuilds the commit. Guard by tracing every state change to built CLI/engine calls and adding a canary that disables the product caller.
- **Stale proof authorizes newer code:** run the complete proof set once at the final commit and require every receipt to match the landing commit and tree.
- **Crash duplicates a verifier or provider effect:** persist `dispatched_unknown` before spawn and make restart park `manual-required`.
- **Imported coding node runs in the shared checkout:** v2 contract plus runtime preparation and execution-boundary refusal must both require a registered isolated worktree.
- **Preview/import time-of-check drift:** import repeats compile, validation, target-HEAD verification, and digest calculation before opening a transaction.
- **Legacy compatibility becomes an accidental supported path:** label v1 imports compatibility-only and make the normal operator command refuse them.
- **Dashboard and CLI diverge:** expose shared application services; UI commands render those results rather than reimplementing admission.

## Recovery and handoff

**Recovery rule:** after compaction or interruption, reread this plan, confirm the worktree HEAD/tree/status, inspect the last recorded RED/GREEN proof, and resume at the first incomplete stage. Never infer completion from a test file or historical report.

**Resume rule:** one writer owns each production file. Advisory reviewers and speculative agents are read-only until an interface is frozen. Integrated bytes must rerun the narrow test, then the exact stage gate.

**Failure rule:** one informed repair is allowed for a repeated signature. If it repeats, stop retrying, update this plan with the observed blocker, and reframe the interface or proof.

## Final verification

Before any completion claim:

1. `pnpm verify:ccc-prd-product`
2. `node scripts/run-ccc-pg-proof.mjs --wave 6`
3. `pnpm verify:fast`
4. canonical `pnpm test:gate` inside the owned embedded PostgreSQL lifecycle
5. `pnpm lint`
6. `pnpm typecheck`
7. `pnpm build`
8. `git diff --check`
9. exact HEAD/tree/status/package hashes
10. read-only adversarial diff review and disposition of every actionable finding

The product may be called `implemented` when the normal path exists, `tested` when targeted tests pass, and `locally proven` only after the exact-tree acceptance command passes. It remains not `live` until a separately authorized real-provider run succeeds. Human merge approval remains mandatory.
