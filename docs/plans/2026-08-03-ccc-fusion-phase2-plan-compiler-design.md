# Phase 2 — the plan-of-attack compiler (design, 2026-08-03, rev 4)

How an *accepted PRD understanding* becomes an *importable campaign*. This document is bird's-eye and mid-level. Granular particulars — exact constant values where a range is given, file layout, function signatures, fixture bytes — are the implementer's call.

**Revision 4** folds round-2 residue: four findings, all fixed, the largest being a regression the rev 3 OQ-1 fix introduced — synthesized artifact rows are span-validated like every other collection, so the design now states which spans they carry and why that is honest (§2.2).

**Revision 3** answered a round-1 adversarial review that rejected rev 2 on two blockers. Every Phase 2 and cross-document finding is addressed; the mapping is in the CHANGELOG at the end.

The decisive finding: **`compiler.ts:786-833` enforces bidirectional structural equality between `edges[]` and `dependencyTaskIds`**, in both directions, with a `CCC_PRD_PRODUCT_GRAPH_UNSUPPORTED` refusal on each side. Rev 2 read the *comment* at `compiler.ts:518-525` describing the hazard and missed the *code* enforcing against it, so rev 2's OQ-1 ruling — "preserve the true graph in `edges[]` while `dependencyTaskIds` carries the chain" — was exactly the shape those two checks exist to reject. OQ-1 has been re-adjudicated (§10) and its consequences re-propagated throughout.

**Revision 2** folded the orchestrator's adjudications of rev 1's seven open questions into settled rulings. Those rulings stand except where the re-adjudication of OQ-1 supersedes them.

**Evidence base.** Every claim about current behavior carries a `file:line` citation, read on 2026-08-03 from the read-only worktree `/Users/ryanpappal/03_CODE/ccc-fusion-worktrees/phase2-design-read` at **`63f8bbb9483cf81c90876ae05c2530841d9d6e30`** (`63f8bbb94`, "fix(cli): close embedded-PG on settings writes; fix keyless loopback + duplicate provider name (#17)") — the current `origin/main` tip. Paths are repo-relative. The primary checkout sits on a different, dirty branch; its bytes are **not** authoritative for this document.

**Settled inputs, not re-litigated.** The frozen human-merge semantics (`autoMerge:false`) and the E-series (E1 live resolver is authority; E2 requested identity in the binding hash only, effective identity at the attempt layer, no campaign fallback; E3 cost claims require receipts and explicit "unknown" is legal). This design builds on them and never weakens them. D2 (chunked extraction plus a deterministic anchor resolver) is treated as an incoming input shape, not a dependency — see §6.

**Three flagged contradictions, now adjudicated.** The charter's acceptance bar asks for a *dependency work tree / workflow graph*, for `ownedPaths` that enable *parallel worktree execution*, and for a negative control that can be *shown to actually fail*. The code as pinned admits none of the three as stated. Rev 1 recorded them with citations rather than improvising; rev 2 carries the orchestrator's rulings. The rulings resolve **how Phase 2 proceeds**; two of the three underlying code-level divergences are deliberately *not repaired* in this phase and stay flagged for the operator (§"Flagged contradictions").

---

## 0. What the current code actually does

Nine facts shape every decision below. Phase 2 is far more a *bridge* than a *build*: most of the charter's acceptance bar already exists in some layer, and the gap is narrower and sharper than the charter implies.

### 0.1 The understanding artifact is deliberately non-executable, and compile refuses it outright

`understandCccPrdPacket` emits `CccPrdUnderstandingReview` with `schema: "ccc-prd.understanding-review.v1"` (`packages/engine/src/ccc-prd/understanding.ts:14-15`) and a literal `executable: false` (`understanding.ts:34`). It carries the full semantic payload — `requirements`, `proofs`, `tasks`, `edges`, `workflows`, `documents`, `artifacts`, `protectedActions`, `unresolvedDecisions` (`understanding.ts:39-52`) — but its import intents are renamed to `proposedImportIntents` (`understanding.ts:46`), and its `implementationContext` is a hole by construction: `targetRepository.path` and `baseCommit` are `null` unless the sidecar carried an absolute path and a 40-hex commit (`understanding.ts:110-113`), all three bounds are `null` unless positive (`understanding.ts:114-118`, `positive` at `:90-92`), `admittedWriteRoots` is whatever the sidecar had, and `missingFacts` enumerates exactly four codes — `CCC_PRD_TARGET_REPOSITORY_REQUIRED` (`:122`), `CCC_PRD_BASELINE_REQUIRED` (`:128`), `CCC_PRD_EXECUTION_BOUNDS_REQUIRED` (`:134`), `CCC_PRD_ALLOWED_PATHS_REQUIRED` (`:140`).

Understanding calls `authorCccPrdPacket` with **no `constraints`** (`understanding.ts:165-170`), so the whole constraints block — target drift, bounds drift, review-count bound, and task-custody provenance — is skipped. That is why understanding tasks carry no `ownedPaths` and no `allowedWriteRoots`.

`compileCccPrdPacket` refuses the review on sight: `validateTopLevelShape` requires `schema === CCC_PRD_SIDECAR_SCHEMA_VERSION` and otherwise emits `CCC_PRD_UNKNOWN_SIDECAR_SCHEMA` (`packages/engine/src/ccc-prd/compiler.ts:268-273`, code at `:270`).

**So today there is no path at all from an accepted understanding to an importable campaign.** That gap is Phase 2's entire reason to exist.

### 0.2 `ownedPaths`, proof edges, and dependency edges already exist as types

Nothing in the charter's data model needs inventing:

| Charter item | Already in the type layer |
|---|---|
| `ownedPaths` on tasks | `CccPrdTask.ownedPaths?: string[]` (`packages/core/src/ccc-prd/types.ts:95`), `allowedWriteRoots?: string[]` (`:102`), both documented as optional on legacy sidecars but **required by the supported product policy generator** (`:90-101`) |
| requirement→proof edge | `CccPrdProof { id, requirementIds, command, positiveOracle, negativeControls, spans, confidence }` (`types.ts:56-65`), plus the reverse pointer `CccPrdRequirement.proofIds` (`types.ts:73`) |
| dependency work tree | `CccPrdDependencyEdge { id, fromTaskId, toTaskId, kind: "depends_on" }` (`types.ts:106-111`) and `CccPrdWorkflow { taskIds, entryTaskIds, terminalTaskIds }` (`types.ts:113-120`) |
| import intents | `CccPrdImportIntent { entityType, entityId, operation: "create", target }` over nine entity types (`types.ts:141-158`) |

Phase 2 therefore **populates and validates** these fields. It does not extend the sidecar schema. That matters: `validateExactKeys` on tasks enumerates exactly fourteen keys including `ownedPaths` and `allowedWriteRoots` (`compiler.ts:1118-1139`, the two at `:1134-1135`), so any new task key is refused at compile.

### 0.3 The compile path already enforces proof completeness — but not requirement→proof coverage

`compiler.ts:1105-1113` refuses `CCC_PRD_PROOF_INVALID` unless a proof has a non-empty `command`, a non-empty `positiveOracle`, and a **non-empty** `negativeControls` array whose every entry is a non-empty string. `requireReferences` binds `proof.requirementIds` to declared requirements (`compiler.ts:1104`) and `task.proofIds` to declared proofs (`compiler.ts:1149`).

What compile does **not** enforce is the other direction: a requirement with `proofIds: []` compiles cleanly. The "every requirement has a proof" rule lives in the **CLI**, in `assertProductBundleComplete` (`prd.ts:1452-1487`) — whose single call site is `compileProductBundle` (`:1636`, which also sets `requireMaterialCoverage: true` at `:1633`), the shared helper serving **both `preview` and `import`**, not preview alone — as `CCC_PRD_REQUIREMENT_PROOF_COVERAGE_MISSING` (`packages/cli/src/commands/prd.ts:1477-1485`, code at `:1482`), next to `CCC_PRD_REQUIREMENT_TASK_COVERAGE_MISSING` (`prd.ts:1471-1476`, code at `:1473`).

This split is load-bearing for §4: a Phase 2 compiler that emits a sidecar which *compiles* is not yet a sidecar that *previews*, and the acceptance bar is the second one.

### 0.4 Negative controls are source-bound assertion strings, not executable commands

`CccPrdProof.negativeControls` is `string[]` (`types.ts:61`). The authoring path requires each one to be **stated inside that proof's cited source span**, refusing `CCC_PRD_NEGATIVE_CONTROL_PROVENANCE_REQUIRED` otherwise (`packages/engine/src/ccc-prd/authoring.ts:612-619`, code at `:615`), exactly as it does for the command (`CCC_PRD_PROOF_COMMAND_PROVENANCE_REQUIRED`, `authoring.ts:599`) and the oracle (`CCC_PRD_PROOF_ORACLE_PROVENANCE_REQUIRED`, `authoring.ts:607`). The same triple is carried in `CccPrdImplementationFactProvenance.proofs` as span-bound bindings (`types.ts:300-305`).

So a negative control today is **a quoted claim from the PRD about how the verifier could fail**, not a runnable artifact. The charter asks for "a way the verifier can be shown to actually fail when it should". Making that mechanical is a genuine extension, and §4 designs it as an *additive, opt-in* layer that never weakens the existing provenance rule.

### 0.5 Transactional import is already built, counted, and failure-injectable

`packages/core/src/ccc-prd/importer.ts` implements the whole charter item:

- **All-or-nothing:** writes run inside a serializable transaction (`serializable` at `importer.ts:1093`, retry classification at `:1063-1081` over SQLSTATE `40001`/`40P01`, `RETRYABLE_SQLSTATES` at `:46`), staged through `prepareDatabaseImport` (`:1172`) → projection claim → `activateImport` (`:1840`).
- **Exact non-zero counts:** `CccPrdImportDirectCounts` has nine fields — `campaigns`, `tasks`, `dependencyEdges`, `workflows`, `documents`, `artifacts`, `sources`, `workItems`, `runAudits` (`importer.ts:75-85`) — surfaced on every `CccPrdImportInspection` (`:87-99`) and recomputed by `inspectDirectCounts` (`:2049`).
- **Deterministic refusal on injected failure:** `CccPrdImportFailureCheckpoint` enumerates the nine entity types plus eleven positional checkpoints (`importer.ts:48-60`), and `inject` raises `CCC_PRD_IMPORT_INJECTED_FAILURE` at any of them (`:214-217`) or `CCC_PRD_IMPORT_LOST_RESPONSE` at the post-commit checkpoint (`:208-213`).
- **Writer-class witness:** `CccPrdImportTransactionWitness { transactionId, writerClasses }` (`:64-67`) proves every writer class ran in one transaction, with `CccPrdImportTransactionProbe` (`:69-73`) as the test seam.
- **Admission before any write:** `assertCccPrdImportBundle` re-derives and checks the bundle hash (`packages/core/src/ccc-prd/import-admission.ts:68-74`), pins `rootDir` to `bundle.targetRepository.path` (`:81-86`), clamps bounds to local ceilings (`:87-102`), requires `.fusion/tasks` and `.fusion/artifacts` inside admitted write roots (`:103-112`), pattern-checks every entity id (`:23`, `:113-124`), and requires an import intent for every non-optional writer class (`:125-138`).

**Phase 2 must not rebuild any of this.** Its obligation is to produce a bundle that this machinery accepts, and to add the refusal codes for its *own* stage.

### 0.6 The supported product path admits exactly one shape: a single linear chain

This is the first flagged contradiction, and it is decisive for §2 and §3.

`productGraphAdmissionDiagnostics` (`compiler.ts:531`) documents its own contract as "a strictly ordered sequence of tasks … ordered by a dependency relation that is a total order (a single linear chain)" (`compiler.ts:504-530`). It enforces that:

| Rule | Code | Lines |
|---|---|---|
| exactly one declared workflow | `CCC_PRD_PRODUCT_GRAPH_UNSUPPORTED` | `compiler.ts:549-556` |
| workflow + work-item intents reference that workflow | `…GRAPH_UNSUPPORTED` | `:559-565` |
| declared / workflow-referenced / imported task sets are identical | `…GRAPH_UNSUPPORTED` | `:570-614` |
| every task belongs to that workflow | `…GRAPH_UNSUPPORTED` | `:615-622` |
| **exactly one entry task and exactly one terminal task** | `…GRAPH_UNSUPPORTED` | `:624-637` |
| every task in an N>1 chain declares its own `ownedPaths` and `allowedWriteRoots` | `CCC_PRD_PRODUCT_TASK_CUSTODY_MISSING` | `:649-660` |
| **no task pair owns overlapping paths — including dependency-ordered pairs** | `CCC_PRD_PRODUCT_TASK_OWNERSHIP_OVERLAP` | `:665-681` |
| no two tasks share a `live_execution` protected action | `CCC_PRD_PRODUCT_PROTECTED_ACTION_SHARED` | `:683-702` |
| **no task declares more than one predecessor** | `…GRAPH_UNSUPPORTED` | `:721-727` |
| **no task is the predecessor of more than one task** | `…GRAPH_UNSUPPORTED` | `:728-734` |
| **exactly `N−1` dependency relations for N tasks** | `…GRAPH_UNSUPPORTED` | `:735-740` |
| chain starts at exactly one predecessor-free task, matching the declared entry | `…GRAPH_UNSUPPORTED` | `:742-753` |
| chain ends at exactly one successor-free task, matching the declared terminal | `…GRAPH_UNSUPPORTED` | `:755-765` |
| **every task is reachable by walking the chain from the head** (disjoint chains satisfy every local count above) | `…GRAPH_UNSUPPORTED` | `:767-784` |
| **every `dependencyTaskIds` relation has a declared `edges[]` row** | `…GRAPH_UNSUPPORTED` | `:815-821` |
| **every `edges[]` row is a declared `dependencyTaskIds` relation** | `…GRAPH_UNSUPPORTED` | `:822-828` |
| no relation is declared by more than one edge row | `…GRAPH_UNSUPPORTED` | `:829-833` |
| every declared edge has an edge import intent, and no intent is a stray | `…GRAPH_UNSUPPORTED` | `:835-854` |

A tree, a diamond, or any fan-out is refused. This block runs only when `input.requireMaterialCoverage` is set **and** there is exactly one workflow intent and one work-item intent (`compiler.ts:1355-1367`) — so an acceptance check that omits that flag exercises none of it.

**The mirroring rule is the one that constrains this whole design.** `compiler.ts:786-833` compares the two relations structurally — `relationsByDependent` built from `dependencyTaskIds` (`:788-791`), `edgesByDependent` built from `edges[]` keyed `fromTaskId → toTaskId` (`:792-800`) — and refuses in **both** directions via `relationsAbsentFrom` (`:801-813`): a relation with no edge row at `:815-821`, an edge row that is not a relation at `:822-828`. The docstring states it in prose too: the chain must be "mirrored exactly by the declared dependency edges" (`compiler.ts:510-511`).

The consequence is absolute and worth stating once, plainly: **`edges[]` cannot carry any relation the chain does not also carry.** There is no room in the admitted sidecar for a dependency graph richer than the linear chain. Everything in §2.2 follows from this.

### 0.7 Two different ownership rules live at two different layers

`compiler.ts:665-681` refuses overlap for **every** task pair, and its own message says so: "the supported product path requires disjoint ownership for every task pair, **including dependency-ordered pairs**" (`:676`). `ownedPathsOverlap` is prefix containment (`compiler.ts:498-502`).

The campaign layer applies a **weaker, dependency-aware** rule. `assertConcurrentOwnershipDoesNotOverlap` (`packages/core/src/ccc-campaign/canonical.ts:682-707`) skips any pair where either task transitively depends on the other (`:691-696`, `taskDependsOn` at `:667-680`) and refuses only genuinely concurrent overlap (`:697-704`). It is called by the v2 parser (`canonical.ts:782`) and the v3 parser (`:821`).

Because §0.6 admits only a linear chain, **every** pair in an admitted product bundle is dependency-ordered, so `assertConcurrentOwnershipDoesNotOverlap` is vacuous on the product path and the compiler's strict all-pairs rule is the one that actually bites. The charter's phrasing ("concurrent tasks never write shared surfaces") describes `canonical.ts:682-707`; the gate Phase 2 must clear is `compiler.ts:665-681`. Design to the stricter rule.

### 0.8 `materialCoverage` is recomputed and canonically compared on every compile

`compiler.ts:1369-1389` runs `analyzeCccPrdMaterialCoverage` over the sidecar's own `requirements`, `tasks`, and `unresolvedDecisions`, then requires `canonicalCccPrdJson(sidecar.materialCoverage) === canonicalCccPrdJson(analysis.coverage)` (`:1381-1389`), or `CCC_PRD_MATERIAL_COVERAGE_INVALID`. A missing array is `CCC_PRD_MATERIAL_COVERAGE_REQUIRED` (`:1376-1380`). Both run on **every** compile; the early return at `compiler.ts:1391` gates the remaining four diagnostics behind `requireMaterialCoverage` — conflicts (`:1406-1414`), undispositioned sections (`:1415-1424`), undispositioned requirements (`:1425-1434`), and the 80% shallowness floor (`:1437-1449`).

Two consequences bind Phase 2 hard:

1. **A disposition records task IDs.** `disposition.taskIds` is the sorted set of matching task ids (`packages/engine/src/ccc-prd/material-coverage.ts:243-251`, ids at `:248`). Any Phase 2 mutation of the task set — splitting a task for ownership disjointness, renaming, merging — changes `analysis.coverage`, so the stored `materialCoverage` **must be regenerated from the post-mutation task set**, not copied from the understanding review.
2. **Resolving an unresolved decision into a task, without dropping the decision, manufactures a conflict.** `material-coverage.ts:234-240` pushes an item to `conflicts` when a matching task coexists with a matching unresolved decision (or a deferral/out-of-scope marker). Compile then refuses at `compiler.ts:1406-1414`. So the disposition-promotion rule in §2 must *remove* the promoted `unresolvedDecisions` row, not merely add a task beside it.

### 0.9 The human-merge gate is preserved by omission, and by three separate facts

The imported mission row is written with `autoMerge: 0`, alongside `autoAdvance: 0` and `autopilotEnabled: 0` (`importer.ts:317-319`, `autoMerge` at `:318`). Imported tasks are created by `preparedCccPrdTask`, which sets `paused: true` and `userPaused: true` (`packages/core/src/ccc-prd/projection.ts:66-67`) and **never stamps `task.autoMerge` at all** (whole projection at `projection.ts:42-95`). The engine treats an absent per-task stamp under global `autoMerge:false` as manual-hold: auto-merge-off "leaves in-review terminal until a human merges" (`packages/engine/src/project-engine.ts:2292-2295`), and the legacy-stamp sweep only flags tasks with `autoMerge === true` and non-`user` provenance (`project-engine.ts:2829`).

Separately, the merge landing is a *protected action*, not a policy flag: `mergeLandingFor` requires the single terminal task to reference exactly one declared `merge`-kind protected action, refusing `CCC_PRD_IMPORT_INVALID_BUNDLE` on multiple terminals or a mismatched reference (`importer.ts:799-834`).

**Phase 2's obligation here is entirely negative:** emit no `autoMerge` key anywhere, emit the merge protected action on the terminal task only, and let `preparedCccPrdTask` keep doing what it does. §5 makes this an asserted invariant rather than an assumption.

---

## 1. Scope and non-goals

### In scope

A new compiler stage — call it the **plan compiler** — that takes an accepted `CccPrdUnderstandingReview` plus operator-supplied implementation facts and emits a `ccc-prd.sidecar.v1` that clears `compileCccPrdPacket` with `requireMaterialCoverage` set, and a `ccc-prd.execution-plan.v1` that clears `parseCccPrdProductExecutionPlan`. Concretely:

1. Promote the review's semantic rows into sidecar rows, resolving dispositions per §0.8's conflict rule.
2. Derive `ownedPaths` and `allowedWriteRoots` per task (§3).
3. Complete the requirement→proof edge set and attach negative-control mechanics (§4).
4. Order tasks into the admitted shape and emit `edges`, `workflows`, and `importIntents` that agree with each other (§2).
5. Regenerate `materialCoverage` and `implementationFactProvenance` from the emitted rows.
6. Refuse, with a typed code, wherever an operator fact is missing or a derived fact cannot be proven from source (§5).

### Non-goals

- **Rebuilding the importer.** §0.5 — it exists, it is transactional, it counts, it injects failure. Phase 2 feeds it.
- **Extending the sidecar or bundle schema.** `validateExactKeys` (`compiler.ts:1118-1139`) and the bundle assembly (`compiler.ts:1499-1535`) fix the key sets. Any new field is a schema-version decision, not a Phase 2 decision.
- **Widening the admitted graph shape.** §0.6 is a flagged contradiction for the orchestrator, not something this design resolves.
- **Changing merge, approval, or oversight semantics.** §0.9. Frozen.
- **Inferring implementation facts the operator did not supply.** The four `missingFacts` codes (`understanding.ts:122-140`) are questions for a human. The compiler refuses; it does not guess a target repository or a baseline commit.
- **Executing anything.** The plan compiler is pure over (review, operator facts, admitted source bytes). No provider calls, no git, no database.

---

## 2. The compilation pipeline

### 2.0 Shape of the stage

```
  accepted understanding review        operator implementation facts
  (ccc-prd.understanding-review.v1)    (target, base, bounds, write roots,
              |                         route selection, ownership map)
              |                                     |
              +------------------+------------------+
                                 |
                        [ PLAN COMPILER ]        <-- new, pure
                                 |
              +------------------+------------------+
              |                                     |
     ccc-prd.sidecar.v1                  ccc-prd.execution-plan.v1
              |                                     |
     compileCccPrdPacket                 parseCccPrdProductExecutionPlan
     (requireMaterialCoverage)                      |
              |                                     |
              +------------------+------------------+
                                 |
                     fn prd preview  -->  fn prd import
                                 |
                        transactional import (§0.5)
```

The plan compiler sits **before** `compile`, not inside it. That placement is deliberate: `checkCccPrdPacket` reads a sidecar off disk and validates it (`compiler.ts:1453-1488`), and keeping the compiler's output an ordinary on-disk sidecar means every existing gate applies to Phase 2 output unchanged, with no new trust path into the bundle.

### 2.1 Stages, in order

**Stage A — admit the review.** Refuse unless `schema === "ccc-prd.understanding-review.v1"`, `kind === "understanding-review"`, and `executable === false` (shape at `understanding.ts:31-36`). Refuse a review whose `coverage.missing` or `coverage.conflicts` is non-empty (`understanding.ts:72-73`): the review reports them without refusing (`understanding.ts:261-264`), but compile refuses both downstream (`compiler.ts:1406-1424`), so admitting one here only defers a certain failure. Refuse a review whose `provenance.packetHash` does not match the recomputed custody of the packet being compiled against.

**Stage B — bind operator facts.** The four holes from `understanding.ts:119-143` are filled from explicit operator input, never inferred: `targetRepository.path` (absolute), `targetRepository.baseCommit` (40-hex), `bounds` (three positive integers inside the import ceilings at `import-admission.ts:87-102`), and `admittedWriteRoots`. Each missing fact refuses with the review's own code, so the operator sees the same code the review already showed them.

**Stage C — resolve dispositions.** For every review row, decide its fate:

| Review row | Compiled fate |
|---|---|
| `requirements[]` | carried through, with `proofIds` completed in §4 |
| `tasks[]` | carried through, with ownership derived in §3 |
| `unresolvedDecisions[]` | either **promoted** to a task (and the decision row **dropped**, per §0.8 fact 2) or **retained** unresolved |
| `ambiguities[]`, `exceptions[]` | not sidecar fields — see below |
| `proposedImportIntents[]` | regenerated, not copied (§2.3) |
| `protectedActions[]` | carried through; merge action re-homed to the terminal task (§0.9) |

A retained `unresolvedDecisions` row is legal in a sidecar (`types.ts:328`) and keeps dispositioning its material items (`material-coverage.ts:252-259`). A promoted one must be removed or its item lands in `conflicts`.

**Promotion can also silently *un*-disposition an item, because the two matchers are not symmetric.** `matchingUnresolved` matches on `overlaps(decision.spans, item)` **or** `decision.question.includes(item.title)` (`material-coverage.ts:224-227`, the title-substring arm at `:226`). `matchingTasks` matches on `overlaps(task.spans, item)` or a shared requirement id (`:220-223`) — **there is no title-substring arm**. So a decision whose `question` text contains a requirement token but whose spans sit elsewhere in the file dispositions that item today via `:226`; promote it to a task carrying the decision's spans and drop the decision row, and the new task neither overlaps the item's byte range nor claims a matching requirement id. The item falls through to `missing` (`:277`), and compile refuses `CCC_PRD_SOURCE_REQUIREMENT_UNDISPOSITIONED` (`compiler.ts:1425-1434`) or `CCC_PRD_MATERIAL_SECTION_UNDISPOSITIONED` (`:1415-1424`).

Stage A already refused any review with non-empty `coverage.missing`, so this failure would be **created by Phase 2 itself**. The rule: **a promotion is admissible only if re-running `analyzeCccPrdMaterialCoverage` over the post-promotion rows leaves every item the promoted decision was dispositioning still dispositioned.** Otherwise refuse `CCC_PRD_PLAN_PROMOTION_DROPS_DISPOSITION` — naming the decision, the orphaned items, and the matcher arm that was carrying them. Retaining the decision is always the safe fallback and is what the operator should be told to consider.

`ambiguities` and `exceptions` are `CccPrdSemanticDeclarations` fields (`types.ts:329-330`) present on the sidecar but **omitted from the bundle** (`CccPrdSemanticBundle` is `Omit<…, "ambiguities" | "exceptions" | "unresolvedDecisions">`, `types.ts:351-353`). They therefore survive compile and vanish at bundle time; the plan compiler carries them verbatim and does not treat them as blocking.

**Stage D — order and shape the graph.** §2.2.

**Stage E — derive ownership.** §3.

**Stage F — complete proof edges.** §4.

**Stage G — regenerate derived artifacts.** Call `analyzeCccPrdMaterialCoverage` over the **emitted** requirements/tasks/unresolvedDecisions and store the result as `materialCoverage` (per §0.8 fact 1). Rebuild `implementationFactProvenance` (`types.ts:275-311`) over the emitted facts. Both must be produced by the same call shape the compile path will re-run, or the canonical-equality gate refuses (`compiler.ts:1381-1389`).

**Stage H — self-check, which cannot be done in memory.** `validateCccPrdPacket` (`compiler.ts:1490-1497`) delegates to `checkCccPrdPacket` (`:1453-1488`), which refuses `CCC_PRD_SIDECAR_REQUIRED` without `input.sidecarPath` (`:1455-1457`), then resolves that path through `resolveCccPrdAdmittedFile` and `readFileSync` (`:1460-1461`). The resolver refuses `CCC_PRD_UNDECLARED_COMPANION` when the file is absent (`custody.ts:110`, `:122`) or is not a regular file (`:128-129`), and `CCC_PRD_PATH_ESCAPE` on symlink traversal (`:113`) or escape (`:126`). `validateSidecar` is module-private (`compiler.ts:859`; the package exports only `compileCccPrdPacket`, `validateCccPrdPacket`, `validateNeoCandidate` at `packages/engine/src/ccc-prd/index.ts:28`). **There is no in-memory entry point.**

The ordering is therefore explicit, and it is the same write-through-temp-then-rename discipline §5.4 already requires:

1. Create a temp directory **inside** the packet root.
2. Write the candidate sidecar and execution plan into it.
3. Run `validateCccPrdPacket` against the **temp** sidecar path with `requireMaterialCoverage` set.
4. On success, rename both into their final paths. On any failure, remove the temp directory and refuse `CCC_PRD_PLAN_SELF_CHECK_FAILED`.

Emitting a sidecar the compiler will reject is a compiler bug, and it should surface here rather than two commands later. Commissioning a public in-memory `validateCccPrdSidecarValue` entry point would be cleaner, but it is a new public surface that P-3's non-goal did not budget; if the implementer wants it, it must be raised as an explicit added deliverable rather than assumed.

### 2.2 Graph shaping — and where it stops

Given the review's `tasks[]` and `edges[]`, the compiler must emit the shape §0.6 admits. Two things are mechanical and one is not:

**Mechanical.** Both `edges` and `dependencyTaskIds` are *emitted by the compiler* from one linearized chain sequence, never accepted as independent inputs and never permitted to differ — the mirroring rule at `compiler.ts:815-828` forbids divergence in both directions. Cycles are caught by `detectDependencyCycle` (`compiler.ts:454-482`) and refused before ordering is attempted.

**Mechanical.** `workflows` must be exactly one, with exactly one entry and one terminal (`compiler.ts:549-556`, `:624-637`), and `importIntents` must cover every writer class the bundle needs (`import-admission.ts:125-138`) with one intent per task, no strays and no duplicates (`compiler.ts:596-614`).

**Re-adjudicated (OQ-1, rev 3) — linearize into the chain; carry graph truth in an artifact.** Rev 2's ruling put the true graph in `edges[]`; §0.6's mirroring rule refuses exactly that. The corrected ruling:

- **`edges[]` and `dependencyTaskIds` carry *exactly* the linearized chain.** Bidirectional equality (`compiler.ts:815-828`), the `N−1` relation count (`:735-740`), the no-branching rules (`:721-734`), and the single-edge-per-relation rule (`:829-833`) all hold **by construction**, because both are generated from one chain sequence rather than from two different relations. There is no divergence to guard.
- **The true dependency graph moves to a `CccPrdArtifact` row** (`types.ts:131-139`), `type: "plan-dependency-graph"`. Every edge in that record is tagged **`true-dependency`** (stated by the PRD) or **`linearization-order`** (introduced by the sort to serialize independent work). The record is the honest account of what the PRD said; the sidecar's `edges[]` is the execution order the product path admits.
- **No synthetic edge is misrepresented.** Rev 2's principle survives, relocated: nothing tagged `linearization-order` may be read as a stated dependency. The tag is what preserves that distinction now that both relations in the sidecar are the chain.

**Linearization algorithm.** Standard Kahn topological sort over the true edge set, with a **stable, documented tie-break among ready tasks: lexicographic by semantic task id**, using the same code-unit comparator the compiler uses elsewhere (`compareCccPrdCodeUnits`, e.g. `compiler.ts:570`). Determinism is total — the emitted order is a pure function of (true edge set, task id set), independent of input array order or map iteration.

**Cycles are the only graph-shape refusal.** A cyclic review refuses via the existing `CCC_PRD_DEPENDENCY_CYCLE` (`detectDependencyCycle`, `compiler.ts:454-482`) before linearization is attempted.

**Emit-time toposort check.** Before writing, verify that the emitted chain order topologically satisfies every `true-dependency` edge in the artifact record: for each such edge `A → B`, *A* precedes *B* in the chain. Violation refuses `CCC_PRD_PLAN_CHAIN_VIOLATES_TRUE_EDGE`. **This check cannot fire if the toposort is correct** — it is kept deliberately, as an assertion against a linearizer bug rather than against expected input. A check that can only fire on a defect is still worth having when the defect would otherwise silently reorder a campaign's work.

**Where the artifact attaches.** `artifact.taskId` must be a non-empty string resolving to a declared task (`compiler.ts:1253-1254`), so a campaign-scoped record needs a task anchor. It attaches to the **workflow's single entry task** — the one task guaranteed to exist in every admitted shape (`compiler.ts:624-637`) and the natural owner of a plan-wide record.

**Artifact rows are span-validated, and `spans` may not be empty.** `validateSpans` runs over every collection except `edges`, `importIntents`, and `authorityRoles` (`compiler.ts:1047-1053`) — `artifacts` is **not** on that skip list. Per row it requires a non-empty `spans` array, else `CCC_PRD_SOURCE_SPAN_MISSING` (`compiler.ts:344-347`); exact span key shape and integer offsets with a 64-hex `sha256` (`:354-375`); a resolvable `span.path`, else `CCC_PRD_SOURCE_SPAN_FOREIGN` (`:377-384`); a byte-exact round-trip through `createCccPrdSpanFromBytes` with matching `sha256`/`line`/`column`/`endLine`/`endColumn`, else `CCC_PRD_SOURCE_SPAN_STALE` (`:385-408`); and `excerptSha256 === sha256(source.subarray(byteStart, byteEnd))` (`:409-416`).

So `spans: []` — the naive value for a record synthesized from nothing — refuses on **every** Phase 2 campaign, because §2.2 emits this record unconditionally.

**The rule: a synthesized record carries the spans of the row it describes, and says so in its own content.** The `plan-dependency-graph` record carries the **workflow row's spans** (`types.ts:119`), because the workflow is the subject the record describes. §4.2's Layer 2 records carry the **spans of the `CccPrdProof` they attest** (`types.ts:62`). Both are real spans lifted from an already-validated row, so they round-trip byte-exact by construction — the compiler copies them, never recomputes or invents them.

**Why this is honest, stated explicitly because it is the kind of thing that rots.** A span on a synthesized record identifies its **subject**, not a quotation of its contents. The record's `content` must say that in as many words, so no later reader — human or agent — mistakes the span for a citation asserting that the PRD stated the linearization. This is the same discipline §2.2 applies one level down when it tags `linearization-order` edges: the artifact never claims the PRD said something it did not. A record that cannot name a subject row whose spans it may carry must refuse rather than borrow an unrelated span.

**Consequence: `artifact` becomes a required import writer class.** `optionalEmptyWriterClasses` admits `artifact` only when `bundle.artifacts.length === 0` (`import-admission.ts:125-129`); the loop at `:130-138` then throws `CCC_PRD_IMPORT_INVALID_BUNDLE` without an artifact import intent. Because the plan-dependency-graph record is emitted for **every** campaign, `artifact` is effectively **always** a required writer class in Phase 2 output. §2.3's intent regeneration must therefore run *after* all artifact rows are attached. The same consequence applies to §4.2's Layer 2 records.

**Option (W) — widening `productGraphAdmissionDiagnostics` to admit a DAG — remains DEFERRED to Phase 4–6 and explicitly operator-gated.** It is not attempted here and no part of this design presumes it. See the flagged-contradictions section.

### 2.3 Import intents are regenerated, never copied

The review's `proposedImportIntents` (`understanding.ts:46`) came from a model. The compiler regenerates the intent set deterministically from the emitted rows, because three separate gates cross-check it: `productGraphAdmissionDiagnostics` requires task intents to match declared tasks exactly (`compiler.ts:596-614`); `writeTasks` refuses when intent count ≠ task count (`importer.ts:383-389`); and `assertCccPrdImportBundle` requires an intent for every non-optional writer class (`import-admission.ts:125-138`, optional-when-empty set at `:125-129`). A model-proposed intent set that disagrees with any of these fails late and illegibly. Generation is cheap and total; keep the proposal as diagnostic evidence only.

---

## 3. `ownedPaths` derivation and conflict semantics

### 3.1 What the fields mean, and the containment invariant

`ownedPaths` is *target-relative semantic ownership* used to stop concurrently runnable tasks claiming the same source surface; `allowedWriteRoots` is the *filesystem scope the coding executor may write*, and every root must stay inside **both** task ownership and the PRD-wide admitted roots (`types.ts:90-101`). That double containment is enforced twice in the campaign layer: `allowedWriteRoots ⊆ ownedPaths` and `allowedWriteRoots ⊆ admittedWriteRoots` (`canonical.ts:327-340` for v2 routes, `:594` via `assertAllowedWriteRootsWithinCustodyV3` for v3), and it is re-enforced at commit time — the required-commit fence refuses any changed path outside `allowedWriteRoots` (`packages/engine/src/ccc-campaign-required-commit.ts:210-229`).

Both fields must be **non-empty** for policy generation: `createCccPrdProductExecutionPlan` throws "has no source-owned paths" (`canonical.ts:860-864`) and "has no allowed write roots" (`:865-869`) otherwise. Every generated route is `worktreeMode: "isolated"` and `commitPolicy: "required"` (`canonical.ts:878`, `:881`).

### 3.2 Derivation rules

Ownership is derived, then proven — never accepted on the model's word.

1. **Source of candidates.** For each task, collect candidate paths from, in precedence order: (a) an explicit operator ownership map keyed by semantic task id; (b) paths quoted inside the task's own cited spans; (c) paths quoted inside the spans of the requirements the task claims via `requirementIds`. Precedence matters because (a) is an operator fact and (b)/(c) are extractions.
2. **Canonicalization.** Normalize to target-relative, forward-slash, no trailing slash, no `.`/`..` segments — the same shape `exactTargetRelativePaths` enforces on routes (`canonical.ts:321-326`, v3 at `:592-593`). A path that will not canonicalize refuses rather than being silently dropped.
3. **Admitted-root containment.** Every derived `ownedPath` must sit inside some `admittedWriteRoots` entry from Stage B. This is stricter than the campaign layer, which only constrains `allowedWriteRoots` (`canonical.ts:327-340`) — but a task owning a path it can never be permitted to write is a plan that cannot execute, and catching it here is cheaper than catching it at the commit fence.
4. **Disjointness — to the strict rule.** Per §0.7, target `compiler.ts:665-681`: **no two tasks may own overlapping paths at all**, using prefix containment (`compiler.ts:498-502`). Do not target the weaker concurrent-only rule at `canonical.ts:682-707`; on the linear-chain shape it never fires.
5. **`allowedWriteRoots` derivation.** Default to the task's `ownedPaths` unchanged — the containment invariant is then trivially satisfied. Narrow only on explicit operator instruction. Never widen.
6. **Non-empty or refuse.** A task that derives zero owned paths refuses with a typed code (§5) rather than emitting a task that `createCccPrdProductExecutionPlan` will throw on (`canonical.ts:860-864`), because that throw is a `CccCampaignExecutionPolicyError` from a different layer with no PRD refusal code attached.

### 3.3 Conflict semantics

**Adjudicated (OQ-4): the strict all-pairs rule (`compiler.ts:665-681`) is the Phase 2 contract.** Rationale, as ruled: it is what the compiler enforces today, so targeting it changes no frozen path; and all-pairs disjointness makes any future DAG widening (the deferred option W) **automatically ownership-safe**, because a graph that is ownership-safe for every pair is ownership-safe for every concurrent subset of pairs. Both rules stay layered — `canonical.ts:682-707` is not weakened, not repaired, and not removed. The divergence is recorded as **intentional defense-in-depth**, not a defect.

The practical consequence for the machinery below: because OQ-1 linearizes rather than refusing, a Phase 2 chain routinely contains task pairs whose adjacency is `linearization-order` rather than a stated dependency. Under the all-pairs rule those pairs must still own disjoint paths — so the machinery below is **load-bearing, not a rare edge case**, and its refusal paths will be exercised by ordinary PRDs.

When rule 4 finds an overlap between tasks *A* and *B*, the compiler must resolve deterministically or refuse. **There are two live outcomes, not three** — see the narrow row:

| Situation | Resolution |
|---|---|
| Overlap is exact and *A*, *B* claim the same requirement set | **Merge** *A* and *B* into one task *M*. See the collapse rules below — a naive remap is unsafe. |
| Overlap is containment (*A* owns `src/x`, *B* owns `src/x/y`) | **Narrow** the container *only if the PRD text itself enumerates the sibling paths*; otherwise **refuse**. In practice PRD prose essentially never lists a directory's siblings, so this branch almost always takes the refuse arm. The target filesystem is **never** consulted to enumerate siblings — that would violate P-2's purity and §1's "executing anything" non-goal. |
| Overlap is partial or the tasks claim disjoint requirements | **Refuse.** Splitting a task on ownership grounds invents a decomposition the PRD did not state. |

**Merge collapse rules — a plain remap manufactures a cycle.** Under the all-pairs rule the overlapping pair is routinely chain-*adjacent*, so `B.dependencyTaskIds` contains `A`. Rewriting every reference `A→M`, `B→M` then yields `M.dependencyTaskIds = [M]` and an edge row `{fromTaskId: M, toTaskId: M}`. At the pin that breaks three separate gates:

- `detectDependencyCycle` visits *M*, adds it to `visiting` (`compiler.ts:463`), reads its dependency *M*, re-enters `visit(M)`, and returns at `:461` → `CCC_PRD_DEPENDENCY_CYCLE`.
- `chainHeads` filters tasks with zero dependencies (`compiler.ts:742`) and is now empty → refusal at `:744-748`.
- `relationCount` counts the self-relation (`compiler.ts:715-719`), so collapsing N tasks to N−1 yields `relationCount = N−1` where `(N−1)−1` is required → refusal at `:735-740`.

So a merge is: rewrite references `A→M` and `B→M`; **then delete every reflexive `dependencyTaskIds` entry and every reflexive `edges` row**; then re-derive the chain and re-run the §0.6 checks. The reflexive-deletion step is not optional and not implied by "remap".

Merging and narrowing both mutate the task set, so both must re-run rule 4 to fixpoint and then re-run Stage G. A derivation that does not converge within a declared iteration bound refuses rather than looping.

**The `taskIds` coupling is the sharp edge.** Because `disposition.taskIds` records the surviving task ids (`material-coverage.ts:248`), a merge changes `materialCoverage` bytes, which changes the sidecar hash, which changes the bundle hash, which the execution plan pins (`canonical.ts:928-942`). Ownership resolution must therefore complete **before** the execution plan is generated, never after.

### 3.4 What this does and does not buy

Under the linear-chain shape (§0.6), disjoint ownership does **not** enable parallel execution in Phase 2 — there is no concurrency to protect. What it buys now: each task runs in its own isolated worktree (`canonical.ts:878`) with a commit fence scoped to its own paths (`ccc-campaign-required-commit.ts:210-229`), so a task cannot silently modify a surface another task owns. That is a real containment property and it is worth having on its own terms.

What it buys **later** is the point of the OQ-1/OQ-4 pairing. Because the `plan-dependency-graph` artifact preserves the true graph with every edge tagged `true-dependency` or `linearization-order`, and because all-pairs disjointness is proven over the whole task set rather than over concurrent subsets, a Phase 2 campaign already carries everything a future DAG-admitting runtime would need: the real graph, recoverable by discarding the `linearization-order` edges, and an ownership proof strong enough to remain valid under any concurrency schedule derived from it. Phase 2 therefore produces parallel-*ready* campaigns while executing them serially.

Note precisely where that readiness lives after the rev 3 re-adjudication: **not** in the sidecar's `edges[]`, which the mirroring rule (`compiler.ts:815-828`) pins to the chain, but in an artifact row that travels with the campaign through compile, admission, and import. The parallelism the charter describes is deferred, not designed away — see the flagged-contradictions section.

---

## 4. Requirement→proof edges and negative-control mechanics

### 4.1 The edge schema, as it already exists

The charter's "every requirement links to a verifier command, a positive oracle, and a negative control" is `CccPrdProof` (`types.ts:56-65`) joined to `CccPrdRequirement.proofIds` (`types.ts:73`). Phase 2 adds no fields. It must make the edge set **total and provable**:

| Property | Enforced by | Phase 2 obligation |
|---|---|---|
| proof has non-empty `command`, `positiveOracle`, ≥1 `negativeControls` | `compiler.ts:1105-1113` | emit or refuse |
| proof's `requirementIds` all resolve | `compiler.ts:1104` | emit or refuse |
| task's `proofIds` all resolve | `compiler.ts:1149` | emit or refuse |
| **every requirement has ≥1 declared proof** | `prd.ts:1477-1485` (CLI shared product-bundle path) | emit or refuse — §0.3 |
| **every requirement has a task disposition** | `prd.ts:1471-1476` (CLI shared product-bundle path) | emit or refuse |
| command / oracle / each control is quoted inside the proof's cited span | `authoring.ts:599`, `:607`, `:612-619` | preserve; never synthesize an unquoted control |

The last row is the constraint that makes this hard and honest: **the plan compiler cannot invent a verifier command.** If the PRD does not state one inside a citable span, there is no admissible proof, and the honest outcome is a refusal naming the requirement — which is exactly what `CCC_PRD_EXPECTED_PROOF_REQUIRED` already asks the operator at intake (`packages/engine/src/ccc-prd/intake-contract.ts:176-181`).

### 4.2 Negative-control mechanics

Today a negative control is a source-bound string (§0.4). "Shown to actually fail when it should" requires something executable. The design keeps both, layered:

**Layer 1 (unchanged, always required).** The declared control stays a `negativeControls[]` string quoted from the PRD, with `CCC_PRD_NEGATIVE_CONTROL_PROVENANCE_REQUIRED` intact (`authoring.ts:612-619`). This is the *claim*.

**Layer 2 (new, additive, opt-in).** A **negative-control execution record**: for each declared control, a mutation the verifier is expected to reject, plus the observed failing exit and a digest of the observed output. The mechanical property to prove is a two-run differential — the same `command` passes on the unmutated tree and fails under the mutation — which is what distinguishes a real verifier from one that passes unconditionally.

Layer 2 **cannot live on `CccPrdProof`**: `validateExactKeys` fixes the proof key set to exactly eight keys (`compiler.ts:1089-1103`, the list at `:1092-1101`), and `CccPrdProofAdmission` (`types.ts:37-47`, fields enumerated at `compiler.ts:139-150`) is already occupied binding a plugin-supplied proof definition.

**Adjudicated (OQ-2): the record lives in a `CccPrdArtifact` row (`types.ts:131-139`).** Rationale, as ruled: it is an existing admitted typed home, so no schema version bump is needed, and — critically — nothing escapes gate visibility. A sidecar-*adjacent* file would sit outside the compiled bundle entirely, which is exactly the property that makes it unauditable; an artifact row is carried through compile (`compiler.ts:1520`), admitted by `assertCccPrdImportBundle`'s id check (`import-admission.ts:118`), and persisted by `writeArtifacts` (`importer.ts:894`), so it is inside every gate the rest of the plan passes through.

The row uses the existing artifact shape — `{ id, taskId, type, title, mimeType, content, spans }` (`types.ts:131-139`) — with a reserved `type` discriminator and the record serialized into `content`. The record must carry, at minimum:

- the **two-run differential result**: the verifier's outcome on the unmutated tree and its outcome under the declared mutation, as an explicit pass/fail pair;
- the **verifier command identity**, bound to the `CccPrdProof.command` it claims to exercise, so a record cannot silently drift to a different command;
- **timestamps** for each run.

Fixing those three makes the row shape assertable, which is what lets the gate check in §8 verify it *when present* rather than trusting it.

**Layer 2 stays opt-in and non-blocking, exactly as rev 1 designed it — ruled ENDORSED-SETTLED.** A missing or failing Layer 2 record must not turn a compilable plan into an uncompilable one in this phase, because doing so would change the frozen compile contract. It is reported, it is gate-checkable (§8), and it is the honest answer to "can this verifier actually fail". Note the scope limit ruled under OQ-7: E3's "explicit unknown is legal" governs **cost claims**, not gate outcomes.

Four consequences of the artifact placement worth stating rather than discovering.

1. `artifact.taskId` must be a non-empty string that resolves to a declared task, and `content` must be non-empty, both refused as `CCC_PRD_ARTIFACT_INVALID` (`compiler.ts:1253-1260`), so each record is anchored to the task owning the proof — never free-floating.
2. The key set is exactly seven (`compiler.ts:1249`), so the record serializes *into* `content` rather than adding fields.
3. **Emitting any artifact row makes `artifact` a required import writer class.** `optionalEmptyWriterClasses` admits `artifact` only when `bundle.artifacts.length === 0` (`import-admission.ts:125-129`); otherwise the loop at `:130-138` throws `CCC_PRD_IMPORT_INVALID_BUNDLE` without an artifact import intent. §2.3's intent regeneration must therefore run **after** all artifact rows are attached, never before. The intent-cardinality gate requires exactly one intent only for `campaign`/`source`/`run_audit`/`workflow`/`work_item` (`compiler.ts:1324-1335`), so multiple artifact intents are fine.
4. In Phase 2 this is not hypothetical: §2.2's `plan-dependency-graph` record is emitted for **every** campaign, so `artifact` is effectively always a required writer class regardless of whether Layer 2 is enabled. The "a plan with zero Layer 2 records still imports cleanly" property survives — but only because the dependency-graph record supplies the intent, not because artifacts are absent.
5. **Artifact rows are span-validated like every other collection** (`compiler.ts:1047-1053` → `:339-417`), so `spans` may not be empty (`CCC_PRD_SOURCE_SPAN_MISSING`, `:344-347`) and each span must round-trip byte-exact against admitted source (`CCC_PRD_SOURCE_SPAN_STALE`, `:385-416`). A Layer 2 record carries the spans of the `CccPrdProof` it attests, per the subject-not-quotation rule in §2.2.

### 4.3 Proof-to-task attachment

`task.proofIds` must resolve (`compiler.ts:1149`), and a task's proofs should be the proofs of the requirements it claims. The compiler derives `task.proofIds` as the union of `requirement.proofIds` over `task.requirementIds`, then refuses any task left with an empty proof set — an unverifiable task in a chain whose terminal action is a human merge is a task no one can review against a stated bar.

---

## 5. Transactional import and the failure taxonomy

### 5.1 What Phase 2 adds, and what it must not touch

The import transaction, counts, and injected-failure behavior are §0.5 and stay unchanged. Phase 2's failure surface is the **plan-compilation stage**, upstream of import. Its codes must be consistent with the existing 239-code `CCC_PRD_*` taxonomy: uppercase, `CCC_PRD_`-prefixed, named for the refused condition rather than the refusing function.

Reused unchanged, never redefined: the four `missingFacts` codes (`understanding.ts:122-140`), `CCC_PRD_UNKNOWN_SIDECAR_SCHEMA` (`compiler.ts:270`), `CCC_PRD_PRODUCT_GRAPH_UNSUPPORTED` / `CCC_PRD_PRODUCT_TASK_OWNERSHIP_OVERLAP` / `CCC_PRD_PRODUCT_TASK_CUSTODY_MISSING` / `CCC_PRD_PRODUCT_PROTECTED_ACTION_SHARED` (`compiler.ts:486-489`), `CCC_PRD_MATERIAL_COVERAGE_REQUIRED` / `_INVALID` (`compiler.ts:1376-1389`), `CCC_PRD_DEPENDENCY_CYCLE`, `CCC_PRD_REQUIREMENT_PROOF_COVERAGE_MISSING` / `CCC_PRD_REQUIREMENT_TASK_COVERAGE_MISSING` (`prd.ts:1473`, `:1482`), and the whole `CCC_PRD_IMPORT_*` family.

### 5.2 New refusal codes

| Code | Raised when |
|---|---|
| `CCC_PRD_PLAN_INPUT_NOT_UNDERSTANDING` | Input is not a `ccc-prd.understanding-review.v1` with `executable: false` |
| `CCC_PRD_PLAN_UNDERSTANDING_INCOMPLETE` | Review's `coverage.missing` or `coverage.conflicts` is non-empty (§2.1 Stage A) |
| `CCC_PRD_PLAN_PACKET_DRIFT` | Review `provenance.packetHash` ≠ recomputed custody of the compile-time packet |
| `CCC_PRD_PLAN_IMPLEMENTATION_FACT_MISSING` | An operator fact required by Stage B was not supplied; carries the review's own `missingFacts` code |
| `CCC_PRD_PLAN_CHAIN_VIOLATES_TRUE_EDGE` | The emitted chain does not topologically satisfy some `true-dependency` edge in the `plan-dependency-graph` artifact — a linearizer bug, caught before writing (§2.2). Cannot fire with a correct toposort; kept as an assertion, not an input guard |
| `CCC_PRD_PLAN_REQUIREMENT_UNPROVEN` | A requirement would be emitted with no proof or no task disposition (OQ-3 ruling, §5.5) |
| `CCC_PRD_PLAN_PROMOTION_DROPS_DISPOSITION` | Promoting an unresolved decision to a task would leave an item it was dispositioning in `missing` — the matcher-asymmetry failure (§2.1 Stage C) |
| `CCC_PRD_PLAN_OWNERSHIP_FILE_INVALID` | Ownership file unreadable, not JSON, or fails schema validation (§5.6) |
| `CCC_PRD_PLAN_OWNERSHIP_FILE_TASK_UNKNOWN` | Ownership map names a task not declared in the review, or omits a declared one (§5.6) |
| `CCC_PRD_PLAN_OWNERSHIP_UNDERIVABLE` | A task derives zero owned paths (§3.2 rule 6) |
| `CCC_PRD_PLAN_OWNERSHIP_OUTSIDE_ADMITTED_ROOTS` | A derived owned path sits outside `admittedWriteRoots` (§3.2 rule 3) |
| `CCC_PRD_PLAN_OWNERSHIP_IRRECONCILABLE` | Overlap is partial, or tasks claim disjoint requirements (§3.3 row 3) |
| `CCC_PRD_PLAN_OWNERSHIP_NOT_CONVERGENT` | Ownership resolution exceeded its iteration bound (§3.3) |
| `CCC_PRD_PLAN_PROOF_UNQUOTABLE` | A requirement has no verifier command stated inside a citable span (§4.1) |
| `CCC_PRD_PLAN_DISPOSITION_CONFLICT` | A promoted unresolved decision was not dropped, so an item would land in `conflicts` (§0.8 fact 2) |
| `CCC_PRD_PLAN_SELF_CHECK_FAILED` | Stage H: the emitted sidecar does not clear `validateCccPrdPacket` — a compiler bug, surfaced as one |
| `CCC_PRD_PLAN_MERGE_SEMANTICS_VIOLATED` | Emitted output would set `autoMerge`, or the merge protected action is not on the single terminal task (§5.3) |

### 5.3 The merge-semantics assertion

`CCC_PRD_PLAN_MERGE_SEMANTICS_VIOLATED` deserves its own note because it inverts the usual burden. Rather than trusting §0.9's "preserved by omission", the plan compiler **asserts** the omission before writing: no emitted object carries an `autoMerge` key at any depth; exactly one `merge`-kind protected action exists; it is referenced by exactly one task; that task is the workflow's single terminal (matching `mergeLandingFor` at `importer.ts:820-832`). A frozen safety property that holds only because nobody wrote a key is one refactor away from not holding. Make it a check.

### 5.4 Zero partial state at the plan stage

The plan compiler writes two files. It must follow the existing custody discipline exactly: resolve outputs inside the admitted packet root, refuse a pre-existing target, write through a temp directory inside the root and rename — the pattern the execution-plan writer already uses, including `CCC_PRD_EXECUTION_PLAN_OUTPUT_EXISTS` (`prd.ts:806-810`) and `CCC_PRD_EXECUTION_PLAN_TARGET_PROTECTED` (`:817-821`).

The achievable guarantee is stated precisely, because Stage H forces a temp write: **any refusal leaves no file at either final path**, and the temp directory is removed. It is *not* "refusal writes nothing" — the candidate sidecar is written into the packet root's temp directory before validation, by necessity (§2.1 Stage H). Emitting the sidecar to its final path and then refusing on the execution plan would leave a half-plan a later command would happily compile; the rename-both-or-neither ordering is what prevents that.

### 5.5 Unproven requirements refuse at the plan stage (OQ-3)

**Adjudicated: the frozen compile contract is not touched.** `CCC_PRD_REQUIREMENT_PROOF_COVERAGE_MISSING` and `CCC_PRD_REQUIREMENT_TASK_COVERAGE_MISSING` stay exactly where they are, in the CLI's shared product-bundle path (`assertProductBundleComplete`, `prd.ts:1452-1487`, invoked from `compileProductBundle` at `:1636`), which serves both `preview` and `import`. Moving them into `compileCccPrdPacket` would change what an existing sidecar compiles to, which is out of scope by charter constraint 1.

Instead the **new** review→sidecar stage refuses to *emit* a sidecar containing an unproven requirement, with the new typed code `CCC_PRD_PLAN_REQUIREMENT_UNPROVEN` (§5.2). The refusal fires in Stage F, before Stage H's self-check, and names every offending requirement id. The property this buys: **nothing the plan compiler produces can reach `compile` unproven.** The invariant is enforced at the point of production rather than by widening a downstream gate.

**Known pre-existing gap, recorded for the operator and not fixed in Phase 2.** A hand-authored sidecar, or one produced by any non-CLI caller, can still carry a requirement with `proofIds: []` and clear `compileCccPrdPacket` cleanly, because compile has never enforced requirement→proof coverage (§0.3) and Phase 2 does not change that. The bypass predates this work and is unchanged by it. Closing it means either moving the two CLI checks into the compiler or adding an equivalent compile-side diagnostic — both are frozen-path changes and belong to whoever owns that decision, not to Phase 2.

### 5.6 CLI surface (OQ-5, OQ-6)

**Adjudicated (OQ-6): a new `fn prd plan` subcommand.** Not a mode of `fn prd policy` (`prd.ts:195-196`). Rationale, as ruled: the plan compiler is a distinct ladder stage with a distinct input type — `policy` goes sidecar → execution plan, `plan` goes review → sidecar + execution plan — and overloading `policy` muddies both the ladder and the parser. **`fn prd policy` is untouched**, keeping its two mutually exclusive forms and its existing arg count.

**Adjudicated (OQ-5): the per-task ownership map is one flag taking one path.** Following the `--routes-file` precedent (`prd.ts:196`), `fn prd plan` takes a single `--ownership-file <path>` pointing at a schema-validated JSON document keyed by semantic task id.

**The rationale is simplicity and typed refusals, not parser limits.** Rev 2 claimed repeated flags were "the known killer" of the exact-arg-count parser. That was wrong and is corrected here: `prd.ts:457` and `:491` bind `parseGeneratedUnderstandingArgs` only, and `fn prd plan` ships its own parser regardless. More directly, **`parseGuidedFreezeContext` is a working repeated-flag parser in the same file** — `--owned-path` accumulates at `prd.ts:1278-1281`, `--write-root` at `:1282-1285`, single-valued flags are duplicate-checked at `:1286`. Repeated flags are supported. The actual reason to prefer one file: a schema-validated document yields typed, specific refusals (`…OWNERSHIP_FILE_INVALID`, `…FILE_TASK_UNKNOWN`) that a flag-repetition shape cannot, and `admittedWriteRoots` is a list of `{path, purpose}` pairs (`types.ts:216-219`) that no flat flag shape expresses cleanly.

### The full `fn prd plan` shape

Rev 2 defined only the ownership flag, leaving Stage B's four operator facts (§2.1) with no argv surface — which made tests 6 and 63 unwritable. The complete shape, modelled on `generatedAuthorFlags` (`prd.ts:358-369`, exact-count check at `:386`), which already carries five of the needed values:

```
fn prd plan <root-dir> <manifest-path> <review-path> <sidecar-output> <execution-plan-output>
  --target <absolute-repo-path>
  --base <40-hex-commit>
  --max-requests <n>
  --max-duration-ms <n>
  --max-concurrency <n>
  --ownership-file <path>
  --provider <provider>  --model <model>  --transport <pi|cli>  [--cli-adapter <id>]
```

Five positionals; **nine required single-value flags** — `--target`, `--base`, `--max-requests`, `--max-duration-ms`, `--max-concurrency`, `--ownership-file`, `--provider`, `--model`, `--transport` — plus `--cli-adapter`, which is **conditional** on `--transport cli` and is not part of the required set.

**The arity contract is a range, not an equality**, and this is the detail that decides whether the parser works at all: `options.length === 18` for the nine required flags, or `=== 20` when `--transport cli` supplies `--cli-adapter`. A fixed exact-count check in the style of `parseGeneratedAuthorArgs` (`options.length !== generatedAuthorFlags.length * 2`, `prd.ts:386`) **cannot express "18 or 20"** and would reject every valid invocation. `fn prd policy` already solves exactly this shape with a flag allowlist rather than an exact count — `PRODUCT_POLICY_FLAGS` carries both the conditional `--cli-adapter` and the mutually exclusive `--routes-file` (`prd.ts:549-555`) — and is the parser to copy.

Test 63's arity assertion is written against that pair of counts plus the conditional, not against a single number.

`--target`, `--base`, and the three bounds map one-to-one onto Stage B's first three `missingFacts` codes. **`admittedWriteRoots` is carried in the ownership file**, not on argv — it is `{path, purpose}` pair data, it is custody information that belongs beside per-task ownership, and folding it there keeps one schema-validated home for everything the containment invariants of §3.1 need to check together. Its absence refuses `CCC_PRD_ALLOWED_PATHS_REQUIRED`, the review's own code, exactly as the other three do.

The four route-selection flags mirror `fn prd policy`'s provider form (`prd.ts:195`) because Stage §2.0's diagram lists route selection as a plan-time input and `createCccPrdProductExecutionPlan` requires a selection per task (`canonical.ts:838-858`).

The file is confined **inside the packet root** under the established path-escape semantics — the same escape, parent, and symlink rules the review output already resolves under (`prd.ts:264-279`) and the execution plan reuses (`:794-824`), refusing `CCC_PRD_PATH_ESCAPE`. It is an input, never an admitted source: custody ingests only manifest entries flagged `authoritative` (`custody.ts:218`, bytes at `:243`, source row at `:244-247`), so an ownership file inside the root can never be silently ingested as PRD text.

Three typed refusals cover the ownership file's failure modes, consistent with the §5.2 family:

| Condition | Code |
|---|---|
| File is unreadable, not JSON, or fails schema validation | `CCC_PRD_PLAN_OWNERSHIP_FILE_INVALID` |
| Map names a task id not declared in the review, or omits one that is | `CCC_PRD_PLAN_OWNERSHIP_FILE_TASK_UNKNOWN` |
| Map's own entries overlap before derivation even runs | `CCC_PRD_PLAN_OWNERSHIP_IRRECONCILABLE` (reused from §5.2) |

The third reuses the existing code deliberately: an operator-declared overlap and a derived overlap are the same defect, and giving them one code keeps the taxonomy from growing a near-duplicate.

---

## 6. Interaction with the chunked-understanding lane (PR #18)

Read read-only from `origin/agent/phase1-chunked-understanding` at **`d27fbb7abcaf0dc409b1a11e6cfa97ba58f69b74`**, whose merge-base with `origin/main` is exactly the `63f8bbb94` pin — the branch is a clean fast-forward candidate.

### What PR #18 changes that Phase 2 can see

Its 28-file diff is almost entirely *additive* and *upstream* of Phase 2. The two type-layer changes are:

1. `CCC_PRD_AUTHORING_PROPOSAL_FRAGMENT_SCHEMA_VERSION` plus `CccPrdAuthoringProposalFragment` and `CccPrdFragmentRow<T>` in `packages/core/src/ccc-prd/types.ts`. The fragment is a **chunk-scoped** shape that deliberately omits `bounds`, `admittedWriteRoots`, `targetRepository`, `nonGoals`, and packet-level `confidence`, and adds an optional `materialItemIds?: string[]` ledger per row.
2. `verbatimCapable?: boolean` on `CustomProvider.models` in `packages/core/src/types/workflow-steps.ts` — a declared operator assertion about route capability.

### The answer: nothing in this design changes

**Phase 2's input is `CccPrdUnderstandingReview`, and PR #18 does not change that type.** The fragment is an intermediate the chunked lane assembles *away* before a review exists; §4 of the D2 design is explicit that assembly synthesizes packet-level singletons and re-runs the analyzer so the assembled artifact satisfies the same compile-side conditions. `materialItemIds` is a per-chunk diagnostic ledger checked against the real analyzer, never trusted, and never reaches the sidecar — and it could not, since `validateExactKeys` would refuse it (`compiler.ts:1118-1139`).

So:

| If PR #18 lands | If it does not |
|---|---|
| Phase 2 unchanged. Reviews may arrive from either lane; both are `understanding-review.v1`. | Phase 2 unchanged. |

Two second-order consequences are worth stating rather than discovering:

- **Review-item volume.** The D2 design expects the chunked lane to emit more `unresolvedDecisions` — a chunk that cannot disposition an item from its own bytes emits a decision rather than inventing coverage. Every such decision is a Stage C promote-or-retain choice (§2.1), so a chunked review plausibly presents Phase 2 with materially more disposition decisions than a single-shot review of the same PRD. This is a **volume** difference, not a semantic one.
- **Merge order.** Both branches touch `packages/core/src/ccc-prd/types.ts`. PR #18 adds at `:1-7` and `:442-471`; Phase 2 adds no type-layer keys at all (§1 non-goals), so the textual conflict risk is low — but Phase 2 should rebase onto whichever lands first rather than assuming independence.

### Every claim in this section is unverified at the pin and must be re-checked post-merge

`verbatimCapable` is genuinely absent from `main` — `workflow-steps.ts:195` is `models?: { id, name, maxTokens?, contextWindow? }[]` at `63f8bbb94`, consistent with the above. But the PR #18 shape itself was read from a branch, not from `main`, and a branch can be rebased or amended. **At implementation time, re-verify against the *merged* Phase 1 shape**, specifically:

- the two `types.ts` line anchors (`:1-7`, `:442-471`), which shift with any rebase;
- the claim that `materialItemIds` "never reaches the sidecar — and it could not, since `validateExactKeys` would refuse it". That is true for `task` rows as written (`compiler.ts:1118-1139`), but `validateExactKeys` is applied **per collection**, so the claim must be re-checked for **every row type the fragment carries** — requirements, proofs, workflows, documents, artifacts, protected actions, unresolved decisions, ambiguities, exceptions;
- the "textual conflict risk is low" conclusion itself.

### Cross-campaign merge order

Three campaigns are editing one `packages/core` tree concurrently, and this is the only doc that tracks merge order:

| Campaign | Touches | Phase 2 exposure |
|---|---|---|
| Phase 1 (PR #18) | `ccc-prd/types.ts`, `types/workflow-steps.ts`, `expectedChecks` (30 → 35+) | **`expectedChecks` collision — the real one.** Rebase and re-read before editing (§8). Type-layer additions: no exposure (P-3). |
| Phase 3 (routing) | `ccc-campaign/types.ts`, `provider-attempt.ts`, probably `canonical.ts` | No Phase 2 exposure. Phase 2 touches `canonical.ts` not at all and `ccc-campaign` not at all. |
| Phase 2 (this) | compiler, CLI, gate script | — |

One asymmetry worth recording for the orchestrator rather than acting on: `verbatimCapable` is **upstream-only and irrelevant** to Phase 2 (P-13), but it is a **hard fail-closed admission dependency** for Phase 3. If Phase 1 does not land, Phase 2 proceeds unchanged while Phase 3's D3 rule is unimplementable. That asymmetry is not a contradiction — Phase 2's input type genuinely is unaffected — but Phase 3 carries a merge-order dependency that its own document does not track.

---

## 7. Enumerated RED tests

Naming and structure follow the existing engine suites. Proposed files: `ccc-prd-plan-compiler.test.ts` (pure), `ccc-prd-plan-ownership.test.ts` (pure), `ccc-prd-plan-proof-edges.test.ts` (pure), and additions to the existing import test surface.

### Admission and operator facts

| # | Test | Expected RED signature |
|---|---|---|
| 1 | refuses a `ccc-prd.sidecar.v1` passed where a review is expected | accepted, compiles a sidecar twice |
| 2 | refuses a review with `executable` absent or true | accepted |
| 3 | **refuses a review whose `coverage.missing` is non-empty** (`understanding.ts:261-264` reports without refusing) | accepted, then refused far downstream at `compiler.ts:1415-1424` |
| 4 | refuses a review whose `coverage.conflicts` is non-empty | accepted, refused later at `compiler.ts:1406-1414` |
| 5 | refuses on `provenance.packetHash` drift against recomputed custody | stale review compiled against different bytes |
| 6 | each of the four `missingFacts` codes refuses with that same code | generic refusal, operator cannot tell which fact is missing |
| 7 | refuses a non-absolute target path and a non-40-hex baseline (`understanding.ts:112-113` shape) | accepted, refused at import admission (`import-admission.ts:81-86`) |
| 8 | refuses bounds outside the import ceilings (`import-admission.ts:87-102`) | accepted, refused after the transaction opens |

### Graph shaping

| # | Test | Expected RED signature |
|---|---|---|
| 9 | a one-task review emits the degenerate chain and compiles (`compiler.ts:515-516`) | multi-task machinery breaks the single-task case |
| 10 | **emitted `edges` and `dependencyTaskIds` mirror each other exactly, in both directions** (`compiler.ts:815-828`), for a review whose true graph is a fan-out | `CCC_PRD_PRODUCT_GRAPH_UNSUPPORTED` from either `:815-821` or `:822-828` — the rev 2 failure mode |
| 10a | no relation is declared by more than one edge row (`compiler.ts:829-833`) | duplicate edge emitted for one relation |
| 10b | every declared edge has an edge import intent and no intent is a stray (`compiler.ts:835-854`) | `…GRAPH_UNSUPPORTED` at import-intent pairing |
| 10c | every task is reachable by walking the chain from the head (`compiler.ts:767-784`) | disjoint chains pass every local count and refuse here |
| 11 | emits exactly one workflow, one entry, one terminal (`compiler.ts:549-556`, `:624-637`) | `CCC_PRD_PRODUCT_GRAPH_UNSUPPORTED` |
| 12 | emits exactly `N−1` dependency relations for N tasks (`compiler.ts:735-740`) | `…GRAPH_UNSUPPORTED` |
| 13 | declared entry equals the chain head (`compiler.ts:742-753`) | `…GRAPH_UNSUPPORTED` |
| 14 | a cyclic review refuses via `detectDependencyCycle` (`compiler.ts:454-482`) before ordering | infinite loop or arbitrary order |
| 15 | **a fan-out review linearizes to a chain that compiles**, and the true fan-out is recoverable from the `plan-dependency-graph` artifact (OQ-1, rev 3) | true graph lost entirely, or written into `edges[]` and refused at `compiler.ts:815-828` |
| 15a | **every artifact edge is tagged `true-dependency` or `linearization-order`**, and discarding the latter reproduces the review's edge set exactly | synthetic ordering indistinguishable from stated dependency |
| 15b | linearization tie-break is lexicographic by task id and stable across shuffled input order | order varies run to run |
| 15c | **the emitted chain topologically satisfies every `true-dependency` edge**; a deliberately corrupted order refuses `CCC_PRD_PLAN_CHAIN_VIOLATES_TRUE_EDGE` | chain reorders stated dependencies silently |
| 15d | the `plan-dependency-graph` artifact attaches to the workflow's entry task and resolves (`compiler.ts:1253-1254`) | `CCC_PRD_ARTIFACT_INVALID` |
| 15d1 | **the artifact's `spans` are non-empty and round-trip byte-exact against admitted source** (`compiler.ts:1047-1053` → `:344-347`, `:385-416`) | `spans: []` emitted; `CCC_PRD_SOURCE_SPAN_MISSING` on every Phase 2 campaign |
| 15d2 | the artifact carries the **workflow row's** spans, and its `content` states the span identifies the record's subject rather than quoting it | span borrowed from an unrelated row, or read as a PRD citation for the linearization |
| 15e | **emitting the artifact makes `artifact` a required writer class**, and the regenerated intent set includes it (`import-admission.ts:125-138`) | `CCC_PRD_IMPORT_INVALID_BUNDLE`: bundle has no artifact import intent |
| 16 | import intents are regenerated, not copied: a review with a wrong `proposedImportIntents` set still emits a correct one | `compiler.ts:596-614` refuses, or `importer.ts:383-389` throws |
| 17 | every non-optional writer class has an intent (`import-admission.ts:125-138`) | import refuses after admission |

### Ownership

| # | Test | Expected RED signature |
|---|---|---|
| 18 | every emitted task has non-empty `ownedPaths` and `allowedWriteRoots` (`canonical.ts:860-869`) | `CccCampaignExecutionPolicyError` from a foreign layer with no PRD code |
| 19 | **disjointness targets the strict all-pairs rule, so two dependency-ordered tasks with overlapping ownership refuse** (`compiler.ts:665-681`) | passes the weak concurrent-only rule (`canonical.ts:691-696`) and is refused at compile |
| 20 | prefix containment counts as overlap: `src/x` vs `src/x/y` (`compiler.ts:498-502`) | treated as disjoint |
| 21 | `allowedWriteRoots ⊆ ownedPaths` for every task (`canonical.ts:327-340`) | v2 route parse throws |
| 22 | `allowedWriteRoots ⊆ admittedWriteRoots` (`canonical.ts:333-341`) | route parse throws |
| 22a | the ownership file supplies `admittedWriteRoots` as `{path, purpose}` pairs (`types.ts:216-219`); absence refuses `CCC_PRD_ALLOWED_PATHS_REQUIRED` | list data forced onto argv, or silently defaulted |
| 23 | a derived owned path outside `admittedWriteRoots` refuses (§3.2 rule 3) | plan compiles, commit fence refuses at runtime (`ccc-campaign-required-commit.ts:224-229`) |
| 24 | exact-overlap merge remaps every `dependencyTaskIds`, `edges`, `workflows.taskIds`, and intent reference | dangling reference after merge |
| 24a | **merging two chain-adjacent tasks emits no self-dependency and no self-edge** (§3.3 collapse rules) | `CCC_PRD_DEPENDENCY_CYCLE` (`compiler.ts:461-463`), empty `chainHeads` (`:742-748`), and a `relationCount` off-by-one (`:735-740`) — all three fire |
| 24b | the narrow branch admits only when the PRD text itself enumerates the siblings, and never reads the target filesystem | filesystem consulted, violating P-2 purity |
| 25 | **a merge regenerates `materialCoverage`, and stored coverage canonically equals a fresh analyzer run** (`compiler.ts:1381-1389`, ids at `material-coverage.ts:248`) | stale `taskIds` in coverage; compile refuses a correct plan |
| 26 | containment overlap narrows the container to enumerable siblings, or refuses | silently drops the subtree from ownership |
| 27 | partial overlap with disjoint requirement claims refuses (§3.3 row 3) | invents a task decomposition |
| 28 | ownership resolution reaches a fixpoint, and a non-convergent input refuses within the bound | infinite loop |
| 29 | derivation is deterministic: same review plus same operator map yields byte-identical output twice | ordering varies with map iteration |

### Proof edges and negative controls

| # | Test | Expected RED signature |
|---|---|---|
| 30 | every emitted proof has non-empty `command`, `positiveOracle`, ≥1 `negativeControls` (`compiler.ts:1105-1113`) | `CCC_PRD_PROOF_INVALID` |
| 31 | **every requirement has ≥1 proof, so `fn prd preview` clears** (`prd.ts:1477-1485`) | compile passes, preview refuses `CCC_PRD_REQUIREMENT_PROOF_COVERAGE_MISSING` |
| 31a | **an unproven requirement refuses `CCC_PRD_PLAN_REQUIREMENT_UNPROVEN` at the plan stage, naming every offender** (OQ-3) | sidecar emitted; failure surfaces only at preview, two commands later |
| 31b | the two CLI preview refusals stay in the CLI: `compileCccPrdPacket` still accepts a hand-authored sidecar with `proofIds: []` (recorded pre-existing gap, §5.5) | compile changed — a frozen-path regression |
| 32 | every requirement has a task disposition (`prd.ts:1471-1476`) | preview refuses `…TASK_COVERAGE_MISSING` |
| 33 | **a requirement whose PRD states no citable verifier command refuses `CCC_PRD_PLAN_PROOF_UNQUOTABLE`** — the compiler never synthesizes one | invented command; `authoring.ts:599` provenance rule bypassed |
| 34 | a negative control not quoted inside the proof's span refuses (`authoring.ts:612-619`) | unquoted control admitted |
| 35 | `task.proofIds` is the union over `task.requirementIds`, and all resolve (`compiler.ts:1149`) | dangling proof reference |
| 36 | a task left with an empty proof set refuses (§4.3) | unverifiable task admitted into the chain |
| 37 | Layer 2 absence is reported, not refused, and a zero-record plan imports cleanly (`import-admission.ts:125-129`) | plan becomes uncompilable, changing the frozen compile contract |
| 38 | **Layer 2 differential: the same command passes unmutated and fails under the declared mutation** | verifier passes unconditionally and nobody notices |
| 38a | **the Layer 2 record is a `CccPrdArtifact` row** carrying the differential pair, the bound verifier-command identity, and both timestamps (OQ-2) | record written sidecar-adjacent, outside every gate |
| 38b | the record's `taskId` resolves to the task owning the proof, and `content` is non-empty (`compiler.ts:1253-1260`) | `CCC_PRD_ARTIFACT_INVALID` |
| 38b1 | **the Layer 2 record's `spans` are the attested proof's spans and round-trip byte-exact** (`compiler.ts:385-416`) | `spans: []`; `CCC_PRD_SOURCE_SPAN_MISSING` |
| 38c | a record whose command identity does not match the `CccPrdProof.command` it claims refuses | record silently attests a different command |

### Disposition, coverage, and merge semantics

| # | Test | Expected RED signature |
|---|---|---|
| 39 | **promoting an unresolved decision to a task drops the decision row** (`material-coverage.ts:234-240`) | item lands in `conflicts`; compile refuses at `compiler.ts:1406-1414` |
| 39a | **a decision dispositioning an item only via `question.includes(item.title)` (`material-coverage.ts:226`) cannot be promoted to a task whose spans sit elsewhere** — refuses `CCC_PRD_PLAN_PROMOTION_DROPS_DISPOSITION` | item silently falls to `missing` (`:277`); compile refuses `CCC_PRD_SOURCE_REQUIREMENT_UNDISPOSITIONED` (`compiler.ts:1425-1434`) on a failure Phase 2 created |
| 39b | the same promotion **is** admissible when the new task's spans overlap the item or it claims a matching requirement id (`material-coverage.ts:220-223`) | over-refusal: every promotion blocked |
| 40 | a retained unresolved decision still dispositions its item (`material-coverage.ts:252-259`) | item lands in `missing` |
| 41 | `ambiguities` and `exceptions` survive compile and vanish at bundle (`types.ts:351-353`) | treated as blocking, or leaked into the bundle |
| 42 | regenerated `materialCoverage` canonically equals a fresh analyzer run over emitted rows (`compiler.ts:1381-1389`) | coverage copied from the review; compile refuses |
| 43 | emitted plan clears all six coverage diagnostics **with `requireMaterialCoverage` set** (`compiler.ts:1376-1449`) | passes with two of six exercised, because `compiler.ts:1391` returned early |
| 44 | **no emitted object carries an `autoMerge` key at any depth** (§5.3) | a future refactor stamps one and the human gate silently opens |
| 45 | exactly one `merge` protected action, on the single terminal task (`importer.ts:820-832`) | `CCC_PRD_IMPORT_INVALID_BUNDLE` at import |
| 46 | no two tasks share a `live_execution` protected action (`compiler.ts:683-702`) | one approval releases live execution for another task |
| 47 | Stage H self-check: a deliberately malformed emission refuses `CCC_PRD_PLAN_SELF_CHECK_FAILED` at the plan stage | surfaces two commands later as a compile refusal |
| 47a | **Stage H validates against a temp sidecar path inside the packet root**, since `checkCccPrdPacket` requires an on-disk file (`compiler.ts:1455-1461`, `custody.ts:110`/`:113`/`:122`/`:128-129`) | implementer finds no in-memory API and either exports `validateSidecar` (`compiler.ts:859`, module-private) or writes to the final path |
| 47b | on Stage H failure the temp directory is removed and **neither final path exists** | half-plan left on disk |

### End-to-end and import

| # | Test | Expected RED signature |
|---|---|---|
| 48 | compiled plan → `compile` → `preview` → `import` succeeds and reports **exact non-zero** `directCounts` (`importer.ts:75-85`) | zero counts, or counts unasserted |
| 49 | imported mission has `autoMerge: 0` (`importer.ts:318`) and every task is `paused`/`userPaused` (`projection.ts:66-67`) | auto-merge eligible import |
| 50 | **injected failure at each checkpoint leaves zero rows and refuses `CCC_PRD_IMPORT_INJECTED_FAILURE`** (`importer.ts:48-60`, `:214-217`) | partial import survives |
| 51 | plan-stage refusal writes neither the sidecar nor the execution plan (§5.4) | half-plan on disk |
| 52 | execution plan hashes pin the compiled bundle (`canonical.ts:928-942`) | plan accepted against a different bundle |
| 53 | plan compilation is pure: no provider call, no git, no database | hidden I/O |
| 54 | *(reserved — rev 2 numbering gap, retained so existing references stay stable)* | — |
| 55 | *(reserved — as above)* | — |

### CLI surface (OQ-5, OQ-6)

| # | Test | Expected RED signature |
|---|---|---|
| 56 | **`fn prd plan` exists as its own subcommand and `fn prd policy` is byte-unchanged** in behavior and arg count (`prd.ts:195-196`) | `policy` overloaded; its existing two forms regress |
| 57 | `--ownership-file` takes exactly one path and adds exactly two argv entries | repeated-flag shape breaks the exact-count parser (`prd.ts:457`) |
| 57a | **`options.length === 18` with the nine required flags is accepted**, and `=== 20` with `--transport cli` plus `--cli-adapter` | a hard-coded `=== 20` rejects every valid invocation |
| 57b | `--cli-adapter` without `--transport cli` refuses, and `--transport cli` without `--cli-adapter` refuses | conditional flag treated as unconditionally required or unconditionally optional |
| 58 | **an ownership file outside the packet root refuses `CCC_PRD_PATH_ESCAPE`**, including via symlink (`prd.ts:264-279`) | arbitrary paths accepted |
| 59 | an ownership file inside the root is never ingested as an admitted source (`custody.ts:218`, `:244-247`) | ownership JSON read as PRD text |
| 60 | malformed or schema-invalid ownership JSON refuses `CCC_PRD_PLAN_OWNERSHIP_FILE_INVALID` | silently ignored; derivation falls back to extraction |
| 61 | a map naming an undeclared task, or omitting a declared one, refuses `CCC_PRD_PLAN_OWNERSHIP_FILE_TASK_UNKNOWN` | stray entry ignored |
| 62 | an operator map whose own entries overlap refuses `CCC_PRD_PLAN_OWNERSHIP_IRRECONCILABLE` before derivation runs | overlap discovered only at compile |
| 63 | unknown flags, duplicates, and odd arg counts are still rejected | allowlist too permissive |

### Determinism

| # | Test | Expected RED signature |
|---|---|---|
| 64 | same review plus same operator facts yields byte-identical sidecar and plan across runs and across shuffled input order | non-canonical ordering |
| 65 | a chunked-lane review (§6) compiles identically to a single-shot review of the same PRD when their semantic rows agree | lane leaks into plan output |

---

## 8. Proposed acceptance-gate checks

The gate is a frozen list of check IDs in `expectedChecks` (`scripts/ccc-prd-product-acceptance.mjs:33-64` — **30 ids at the `63f8bbb94` pin**), and the ledger refuses extra, duplicate, missing, and skipped entries (`:70-105`), so the constant must be edited in the same commit as the capability.

**Counts are stated relatively, not absolutely.** Phase 2 **adds six ids to `expectedChecks`, whatever its length is at merge time**. The live Phase 1 branch is concurrently taking the same constant past 30, so any absolute "30 → 36" arithmetic goes stale the moment Phase 1 lands — and the ledger's four rejections (`:78-80`, `:81-83`, `:94-98`, `:100-102`) make staleness a hard failure, not a warning. Re-read `expectedChecks` after rebasing onto merged Phase 1, before editing it. The six additions:

| New check ID | Proves |
|---|---|
| `plan-compiled-from-understanding` | An accepted understanding review plus operator facts compiles to a sidecar and execution plan. Evidence: review schema in, sidecar + plan hashes out, task count, requirement count, proof count. |
| `plan-compile-gates-cleared` | The emitted sidecar runs through `compileCccPrdPacket` **with `requireMaterialCoverage` set**, clearing all six coverage diagnostics across both tiers (`compiler.ts:1376-1449`). Without that flag the early return at `compiler.ts:1391` exercises two of six and the check reports a false pass. |
| `plan-ownership-disjoint` | Every task pair has disjoint `ownedPaths` under the strict rule (`compiler.ts:665-681`), every `allowedWriteRoots` is inside both task ownership and admitted roots (`canonical.ts:327-340`), and no task has empty custody. Evidence: task count, the derived ownership map, zero overlaps. |
| `plan-requirement-proof-total` | Every requirement has ≥1 proof and a task disposition, so `fn prd preview` clears (`prd.ts:1471-1485`). Evidence: requirement count, proof count, zero uncovered. |
| `plan-negative-control-differential` | For at least one proof, the declared verifier passes on the unmutated tree and **fails** under the declared negative-control mutation. Evidence: both exit codes, both output digests, the bound verifier-command identity, and the `CccPrdArtifact` row id carrying the record (OQ-2). |
| `plan-import-human-merge-preserved` | The compiled plan imports transactionally with exact non-zero `directCounts`, the mission row has `autoMerge: 0`, every task is paused, and no emitted object carries an `autoMerge` key. Evidence: the nine counts, the mission row, the key-absence assertion. |

Every pre-existing check keeps its ID and assertions. `campaign-import-admitted` and `merge-human-hold` in particular must be left byte-identical, since the last proposed check deliberately overlaps their territory and its value comes from being an independent witness rather than a replacement.

### The ledger stays two-state (OQ-7)

**Adjudicated: the gate ledger keeps its pass-only shape (`scripts/ccc-prd-product-acceptance.mjs:70-105`) — no third "recorded unknown" state is added.** Rev 1 raised the possibility because E3 makes an explicit "unknown" legal; the ruling narrows that correctly. **E3's "unknown is legal" governs *cost claims*, not *gate outcomes*.** A gate check that cannot prove its property is a failing check, not an unknown one. The ledger's `pass`/`finalize` pair (`:70-105`) and its four rejections — extra, duplicate, missing, skipped — stay exactly as written.

**The fixture already hosts a mechanically mutable verifier — no fixture extension is needed.** Rev 2 said "extend the fixture"; that instruction had a false premise and, taken literally, would have walked into frozen assertions. At the pin:

- `scripts/ccc-prd-product-acceptance.mjs:1071` writes `src/value.txt` = `"bad\n"` into the target repo;
- `:1074-1104` writes `verify.cjs`, which reads `src/value.txt` and accepts only `good`;
- `:1132-1134` writes the Taskfile target `verify:vertical: - node verify.cjs`;
- `:1474-1487` declares `PROOF-VERTICAL` with `command: "task verify:vertical"`, a positive oracle, and one negative control.

The two-run differential is therefore already runnable with **zero fixture change**: `src/value.txt` = `good` → pass; mutate to any other value → nonzero.

**Three frozen assertions forbid the rev 2 instruction, and must not be touched:** `:716-719` freezes `provenance.proofs.length === 1` **and** `provenance.proofs[0].negativeControls.length === 1` — so "add a proof" and "add a second negative control" are both refused; `:800-810` freezes `proofs[0].command`, `proofs[0].positiveOracle`, and `proofs[0].negativeControls[0]` as **exact literal strings** — so editing the verifier's declared identity is refused. These are assertions, not the "fixture provisioning" this section declares free to change.

**One provisioning consequence for the new checks.** The gate's fixture sidecar declares `artifacts: []` (`:1555`) and therefore declares no artifact import intent. The six new checks compile their **own** bundle through the plan compiler, so that bundle carries the `plan-dependency-graph` row and its regenerated intent set must include the artifact intent, or `assertCccPrdImportBundle` throws `CCC_PRD_IMPORT_INVALID_BUNDLE` (`import-admission.ts:130-138`). This is fixture provisioning for the new checks only — **the pre-existing frozen checks continue to use the existing fixture unchanged**, `artifacts: []` included.

**Explicit stop condition, retained.** It now applies to the artifact consequence rather than to verifier provisioning: emitting the `plan-dependency-graph` record (§2.2) and any Layer 2 record flips `bundle.artifacts` from `[]` (`:1555`) to non-empty, which makes `artifact` a required import writer class (`import-admission.ts:125-138`). Verified at the pin: the gate asserts **no** artifact count anywhere, and its only `directCounts` assertions are `tasks === 2` and `workItems === 1` (`:3687-3688`), so this does not break a frozen assertion. If implementation nevertheless finds a frozen check distorted by the artifact rows, the implementer must **stop and report the exact conflict** — which check, which assertion, which fixture byte. Inventing a third ledger state, weakening another check to make room, or asserting the differential without running it are all out of bounds. This is a halt-not-skip point.

---

## 9. Decision table

### Settled by this design

| # | Decision |
|---|---|
| P-1 | The plan compiler is a **separate stage upstream of `compile`**, emitting an ordinary on-disk sidecar. No new trust path into the bundle; every existing gate applies unchanged. |
| P-2 | It is **pure** over (review, operator facts, admitted source bytes). No provider call, no git, no database. |
| P-3 | **No sidecar or bundle schema extension.** `validateExactKeys` (`compiler.ts:1118-1139`) fixes the key sets; anything new is a schema-version decision outside Phase 2. |
| P-4 | Operator implementation facts are **supplied, never inferred**. The four `missingFacts` codes (`understanding.ts:122-140`) refuse with their own codes. |
| P-5 | Ownership disjointness targets the **strict all-pairs rule** (`compiler.ts:665-681`), not the weaker concurrent-only rule (`canonical.ts:682-707`), because on the linear-chain shape the latter never fires. |
| P-6 | Import intents are **regenerated deterministically**, never copied from the model's `proposedImportIntents`. |
| P-7 | `materialCoverage` is **regenerated from emitted rows** after every task-set mutation, never copied from the review (`material-coverage.ts:248`, `compiler.ts:1381-1389`). |
| P-8 | Promoting an unresolved decision to a task **drops the decision row** (`material-coverage.ts:234-240`). |
| P-9 | The compiler **never synthesizes a verifier command, oracle, or negative control**. Absent a citable span, it refuses (`authoring.ts:599`, `:607`, `:615`). |
| P-10 | Negative-control execution (Layer 2) is **evidence, not admission** — reported and gate-checked, never able to make a compilable plan uncompilable in this phase. |
| P-11 | Merge semantics are **asserted, not assumed**: `CCC_PRD_PLAN_MERGE_SEMANTICS_VIOLATED` checks the absence of `autoMerge` and the single-terminal merge action before writing (§5.3). |
| P-12 | Plan-stage refusal is **all-or-nothing on disk**: neither output file is written (§5.4). |
| P-13 | PR #18 changes nothing in this design. Phase 2's input type is unchanged by it (§6). |

### Settled by orchestrator adjudication (rev 2)

| # | Decision | From |
|---|---|---|
| P-14 | ~~True graph preserved in `edges[]`~~ — **SUPERSEDED by P-14a (rev 3)**. Refused by the bidirectional mirroring rule at `compiler.ts:815-828`. Retained struck-through so the review trail stays legible. | OQ-1 (rev 2) |
| P-14a | **Non-linear graphs compile by deterministic topological linearization** (Kahn, lexicographic tie-break among ready tasks) into the admitted chain. **`edges[]` and `dependencyTaskIds` carry exactly that chain**, so mirroring (`compiler.ts:815-828`), the `N−1` count (`:735-740`), and the no-branching rules (`:721-734`) hold **by construction**. The **true dependency graph moves to a `CccPrdArtifact` row** (`type: "plan-dependency-graph"`), every edge tagged `true-dependency` or `linearization-order`, anchored to the workflow entry task. An emit-time check asserts the chain topologically satisfies every `true-dependency` edge (`CCC_PRD_PLAN_CHAIN_VIOLATES_TRUE_EDGE`) — it cannot fire with a correct toposort and is kept for honesty. Cycles remain the only graph-shape refusal. | OQ-1 (rev 3) |
| P-15 | **Contradiction #1 is resolved for Phase 2 by P-14a. DAG admission (option W, widening `productGraphAdmissionDiagnostics`) remains DEFERRED to Phase 4–6 and explicitly operator-gated** — not attempted here, and nothing in this design presumes it. | OQ-1 |
| P-16 | **The strict all-pairs ownership rule (`compiler.ts:665-681`) is the Phase 2 contract**, because it is what the compiler enforces today (no frozen-path change) and because all-pairs disjointness makes any future DAG widening automatically ownership-safe. Both rules stay layered; neither is weakened. The divergence from `canonical.ts:682-707` is recorded as **intentional defense-in-depth, not repaired**. | OQ-4 |
| P-17 | **The Layer 2 negative-control execution record lives in a `CccPrdArtifact` row** (`types.ts:131-139`): an existing admitted typed home, no schema version bump, nothing escaping gate visibility. The row carries the two-run differential result, the bound verifier-command identity, and timestamps, so a gate check can assert its shape when present. Layer 2 stays opt-in and non-blocking. | OQ-2 |
| P-18 | **The frozen compile contract is not touched.** The new review→sidecar stage refuses `CCC_PRD_PLAN_REQUIREMENT_UNPROVEN` rather than emitting an unproven requirement, so nothing the plan compiler produces reaches compile unproven. CLI preview refusals stay where they are. The hand-authored-sidecar bypass is **recorded as a known pre-existing gap for the operator, not fixed in Phase 2** (§5.5). | OQ-3 |
| P-19 | **CLI: a new `fn prd plan` subcommand** (distinct ladder stage, distinct input type); `fn prd policy` untouched. **Per-task ownership arrives as one `--ownership-file <path>` flag** carrying schema-validated JSON, confined inside the packet root under established path-escape semantics, with typed refusals for schema, unknown-task, and overlap violations. One file rather than repeated flags — not because repeated flags fail (they demonstrably work, `prd.ts:1278-1285`) but because a schema-validated document yields typed refusals and holds pair-shaped write-root data. See P-26, P-27 for the full argv shape and the corrected rationale. | OQ-5, OQ-6 |
| P-20 | **The gate ledger stays two-state pass-only** (`scripts/ccc-prd-product-acceptance.mjs:70-105` unchanged). E3's "explicit unknown is legal" governs **cost claims, not gate outcomes**. The fixture is instead extended minimally to host one mechanically mutable verifier — **superseded by P-25: no fixture extension is needed**, the fixture already hosts a mutable verifier and the frozen assertions at `:716-719` / `:800-810` forbid extending it. The ledger ruling and the halt-not-skip stop condition stand unchanged. | OQ-7 |

### Settled by round-1 review (rev 3)

| # | Decision | From |
|---|---|---|
| P-21 | **`edges[]` can never carry a relation the chain does not carry.** `compiler.ts:786-833` enforces bidirectional structural equality; §0.6's rule table now lists it, plus the connectivity walk (`:767-784`), the single-edge-per-relation rule (`:829-833`), and edge import-intent pairing (`:835-854`). | P-F2, P-F3 |
| P-22 | **Stage H validates against a temp sidecar path inside the packet root**, because `checkCccPrdPacket` requires an on-disk regular file (`compiler.ts:1455-1461`, `custody.ts:110`/`:113`/`:122`/`:128-129`) and `validateSidecar` is module-private (`compiler.ts:859`). The guarantee is "no file at either final path on refusal", not "writes nothing". | P-F4 |
| P-23 | **A merge deletes reflexive `dependencyTaskIds` entries and reflexive `edges` rows** before re-deriving the chain. A plain remap of two chain-adjacent tasks fires `CCC_PRD_DEPENDENCY_CYCLE` (`compiler.ts:461-463`), empties `chainHeads` (`:742-748`), and breaks the `N−1` count (`:735-740`). | P-F5 |
| P-24 | **A promotion is admissible only if every item the promoted decision was dispositioning stays dispositioned** after re-running the analyzer; else `CCC_PRD_PLAN_PROMOTION_DROPS_DISPOSITION`. The matchers are asymmetric: `matchingUnresolved` has a `question.includes(item.title)` arm (`material-coverage.ts:226`), `matchingTasks` has none (`:220-223`). | P-F6 |
| P-25 | **The gate fixture already hosts a mechanically mutable verifier** (`ccc-prd-product-acceptance.mjs:1071`, `:1074-1104`, `:1132-1134`, `:1474-1487`); no fixture extension is needed, and the frozen assertions at `:716-719` and `:800-810` forbid the rev 2 instruction. | P-F7 |
| P-26 | **`fn prd plan` takes five positionals and nine required single-value flags** (`options.length === 18`, or `=== 20` when `--transport cli` supplies the conditional `--cli-adapter`) — an arity **range**, parsed on `fn prd policy`'s flag-allowlist model (`PRODUCT_POLICY_FLAGS`, `prd.ts:549-555`), never `parseGeneratedAuthorArgs`'s exact-count equality (`prd.ts:386`), which cannot express a conditional flag. `admittedWriteRoots` is carried in the ownership file as `{path, purpose}` pairs, not on argv. *(corrected in rev 4, N-F2)* | P-F8 |
| P-27 | **Repeated flags are supported in this CLI** (`parseGuidedFreezeContext`, `prd.ts:1278-1285`). OQ-5's ruling stands, but on the correct rationale: one schema-validated file yields typed refusals a flag-repetition shape cannot. | P-F9 |
| P-28 | The two requirement-coverage refusals sit in the CLI's **shared product-bundle path** (`assertProductBundleComplete`, `prd.ts:1452-1487`, from `compileProductBundle` at `:1636`), serving **both `preview` and `import`** — not preview alone. | P-F10 |
| P-29 | **Any artifact row makes `artifact` a required import writer class** (`import-admission.ts:125-138`); intent regeneration runs after artifacts are attached. In Phase 2 this always applies, because the `plan-dependency-graph` record is emitted for every campaign. | P-F11 |
| P-30 | **Gate-check counts are stated relatively** ("adds six ids to `expectedChecks`, whatever its length at merge time"), because the live Phase 1 branch is concurrently taking the same constant past 30 and the ledger makes staleness fatal (`:78-102`). | X-F1 |
| P-31 | **§3.3 has two live outcomes, not three.** The narrow branch admits only when the PRD text itself enumerates siblings; the target filesystem is never consulted (P-2 purity). In practice it almost always refuses. | P-F13 |
| P-32 | **Every §6 claim about PR #18 is unverified at the pin** and must be re-checked against the merged Phase 1 shape — particularly that `validateExactKeys` is applied per-collection, so the `materialItemIds` containment claim needs checking for every fragment row type, not just tasks. | P-F14 |

### Endorsed-settled (rev 1, confirmed unchanged)

| # | Decision |
|---|---|
| E-A | **Any task-set mutation forces `materialCoverage` regeneration.** Stored coverage is never copied across a mutated task set, because dispositions record surviving task ids (`material-coverage.ts:248`) and compile demands canonical equality (`compiler.ts:1381-1389`). Restates P-7; explicitly endorsed. |
| E-B | **Layer 2 stays non-blocking.** A missing or failing negative-control record never turns a compilable plan into an uncompilable one in this phase. Restates P-10; explicitly endorsed. |

### Open

None. All seven of rev 1's open questions are adjudicated above and restated as rulings in §10.

---

## 10. Adjudicated rulings (rev 1's open questions, now closed)

All seven are settled. Each records the question as asked, the ruling, and the rationale. None is re-opened below.

**OQ-1 — how to compile a non-linear understanding graph, given that the product path admits only a single linear chain (`compiler.ts:721-740`).**
**RE-ADJUDICATED IN REV 3 after round-1 review.** Rev 2's ruling — "chain with true edges preserved", putting the true graph in `edges[]` — is **withdrawn**: `compiler.ts:786-833` enforces bidirectional structural equality between `edges[]` and `dependencyTaskIds`, refusing a relation with no edge row (`:815-821`) and an edge row that is not a relation (`:822-828`). A fan-out review under rev 2's scheme fires **both**. Rev 2 cited the *comment* at `:518-525` and missed the enforcing code.
**CORRECTED RULING: linearize into the chain; carry graph truth in an artifact.** `edges[]` and `dependencyTaskIds` carry **exactly** the linearized chain, so mirroring, the `N−1` count, and the no-branching rules hold by construction. The true dependency graph moves to a `CccPrdArtifact` row (`type: "plan-dependency-graph"`, anchored to the workflow entry task), every edge tagged `true-dependency` or `linearization-order`. An emit-time check asserts the chain topologically satisfies every `true-dependency` edge (`CCC_PRD_PLAN_CHAIN_VIOLATES_TRUE_EDGE`); it cannot fire with a correct toposort and is kept as a defect assertion. The deterministic tie-break stands.
**Rationale.** The distinction rev 2 was reaching for — ordering is not dependency — is correct and survives; only its *location* was wrong. Plain (R), refusing every non-linear review, would reject ordinary PRDs for what is a runtime limitation rather than a modelling one. Promoting option (W) out of its deferral is a frozen-path change and the operator's call, not the implementer's. Moving graph truth to an artifact keeps both properties: the sidecar satisfies a gate that demands the chain and nothing but the chain, while the record of what the PRD actually stated travels with the campaign through compile, admission, and import — recoverable later by discarding the `linearization-order` edges. **Option (W) remains deferred to Phase 4–6 and operator-gated.** Applied in §0.6 (three added rules), §2.2, §3.4, §5.2, §7 tests 10/10a-c and 15/15a-e; recorded as P-14a, P-15, P-21.

**OQ-2 — where the negative-control execution record (§4.2 Layer 2) lives.**
**RULING: a `CccPrdArtifact` row (`types.ts:131-139`).** The row carries the two-run differential result, the bound verifier-command identity, and timestamps. Layer 2 remains opt-in and non-blocking.
**Rationale.** It is an existing admitted typed home, so no schema version bump is required, and — the decisive property — nothing escapes gate visibility. A sidecar-adjacent file would sit outside the compiled bundle, which is precisely what would make it unauditable; an artifact row passes through compile (`compiler.ts:1520`), import admission (`import-admission.ts:118`), and persistence (`importer.ts:894`) alongside everything else. Fixing the three carried fields is what makes the row shape assertable by a gate check rather than merely trusted. Applied in §4.2, §7 tests 38a/38b/38c, §8; recorded as P-17.

**OQ-3 — whether the two requirement-coverage refusals should move from the CLI's shared product-bundle path (`prd.ts:1452-1487`, invoked from `compileProductBundle` at `:1636`, serving both `preview` and `import`) into the compiler.**
**RULING: no — the frozen compile contract is not touched.** The two CLI refusals stay where they are. Instead the new review→sidecar stage refuses `CCC_PRD_PLAN_REQUIREMENT_UNPROVEN` rather than emitting a sidecar containing an unproven requirement.
**Rationale.** Moving the checks would change what an existing sidecar compiles to, which charter constraint 1 forbids. Refusing at the point of *production* achieves the same guarantee for everything Phase 2 emits — nothing it produces can reach compile unproven — without touching a frozen gate. The residual bypass (a hand-authored or non-CLI-authored sidecar with `proofIds: []` compiling cleanly) is **pre-existing, unchanged by Phase 2, and recorded for the operator rather than fixed here**. Applied in §5.2, §5.5, §7 tests 31a/31b; recorded as P-18.

**OQ-4 — whether the strict all-pairs ownership rule (`compiler.ts:665-681`) should stay stricter than the campaign layer's concurrent-only rule (`canonical.ts:682-707`).**
**RULING: yes. The strict all-pairs rule is the Phase 2 contract. Both rules stay layered; neither is weakened; the divergence is intentional defense-in-depth and is not repaired.**
**Rationale.** Two reasons, and the second is the forward-looking one. First, all-pairs is what the compiler enforces today, so targeting it changes no frozen path. Second, all-pairs disjointness makes any future DAG widening **automatically ownership-safe**: a task set proven disjoint for every pair remains disjoint for every concurrent subset a scheduler could derive, so the deferred option W needs no new ownership analysis. The practical cost is that §3.3's merge/narrow machinery is load-bearing rather than rare, since linearization routinely produces chains containing pairs with no stated dependency. Applied in §3.3, §3.4, §7 tests 19/20; recorded as P-16.

**OQ-5 — the operator's input surface for the per-task ownership map (§3.2 rule 1a).**
**RULING: routes-file-style — one `--ownership-file <path>` flag** taking a schema-validated JSON map keyed by semantic task id, confined inside the packet root under the established path-escape semantics, with typed refusals for schema, unknown-task, and overlap violations. **No repeated-flag shapes.**
**Rationale (corrected in rev 3).** The `--routes-file` precedent already exists (`prd.ts:196`). Rev 2 justified the ruling by claiming the exact-arg-count parser makes repeated flags unworkable; that was **wrong** — `prd.ts:457`/`:491` bind `parseGeneratedUnderstandingArgs` only, and `parseGuidedFreezeContext` is a working repeated-flag parser in the same file (`prd.ts:1278-1285`). The ruling stands on its real merits: a schema-validated document yields typed, specific refusals (`…OWNERSHIP_FILE_INVALID`, `…FILE_TASK_UNKNOWN`) that flag repetition cannot, and `admittedWriteRoots` is `{path, purpose}` pair data (`types.ts:216-219`) that no flat flag shape expresses cleanly. Root confinement keeps the file under the same custody discipline as every other plan input, and because custody ingests only manifest entries flagged `authoritative` (`custody.ts:218`), it can never be mistaken for PRD text. Applied in §5.6, §7 tests 22a and 57–62; recorded as P-19, P-26, P-27.

**OQ-6 — whether the plan compiler is a new subcommand or a mode of `fn prd policy`.**
**RULING: a new `fn prd plan` subcommand. `fn prd policy` is untouched.**
**Rationale.** It is a distinct ladder stage with a distinct input type — `policy` goes sidecar → execution plan; `plan` goes review → sidecar + execution plan. Overloading `policy` would muddy both the ladder the operator reasons about and the parser, which already carries two mutually exclusive forms for that command (`prd.ts:195-196`). Applied in §5.6, §7 test 56; recorded as P-19.

**OQ-7 — the acceptance bar for `plan-negative-control-differential` when no fixture proof has a mechanically mutable verifier.**
**RULING: extend the fixture, not the ledger.** The gate ledger stays two-state pass-only (`scripts/ccc-prd-product-acceptance.mjs:70-105` unchanged). The fixture is extended minimally so at least one proof carries a mechanically mutable verifier plus a deterministic mutation that must flip it to fail.
**Rationale.** E3's "explicit unknown is legal" governs **cost claims, not gate outcomes** — rev 1 over-extended it. A gate check that cannot prove its property is a *failing* check, not an unknown one, and adding a third ledger state would let any future check quietly opt out of proving itself. **Explicit stop condition:** if the fixture cannot host a mutable verifier without distorting another frozen check, the implementer halts and reports the exact conflict — check, assertion, fixture byte. Inventing a third state, weakening another check, or asserting the differential without running it are all out of bounds. Applied in §8; recorded as P-20.

---

## Flagged contradictions — charter versus code

All three are adjudicated. Two are resolved *for Phase 2* without repairing the underlying code-level divergence; those stay flagged for the operator.

**#1 — "dependency work tree / workflow graph" and "parallel worktree execution" versus the admitted linear chain.** `productGraphAdmissionDiagnostics` documents and enforces "a single linear chain": exactly one workflow (`compiler.ts:549-556`), exactly one entry and one terminal (`:624-637`), no task with more than one predecessor (`:721-727`), no task the predecessor of more than one task (`:728-734`), and exactly `N−1` relations for N tasks (`:735-740`). A tree or DAG is refused `CCC_PRD_PRODUCT_GRAPH_UNSUPPORTED`. Consequently there are **no concurrent tasks** on the supported product path, and disjoint `ownedPaths` cannot "enable parallel worktree execution" as the charter states — it enables per-task worktree isolation and a per-task commit fence (`canonical.ts:878`, `ccc-campaign-required-commit.ts:210-229`), which is a real but different property.
**Status: RESOLVED FOR PHASE 2 by P-14a; DAG admission DEFERRED to Phase 4–6, OPERATOR-GATED.** Phase 2 emits a linear chain in `edges[]`/`dependencyTaskIds` and carries the true graph in a `plan-dependency-graph` artifact row, so it produces parallel-*ready* campaigns executed serially. Note the correction: rev 2 claimed the true graph could live in `edges[]`; `compiler.ts:786-833` refuses exactly that, in both directions. Widening `productGraphAdmissionDiagnostics` to admit a DAG is not attempted here and nothing in this design presumes it; it requires the operator's sign-off because it touches the frozen product path and the gate. **P-14a, P-15, P-21.**

**#2 — "concurrent tasks never write shared surfaces" describes the weaker of two live rules.** The campaign layer's `assertConcurrentOwnershipDoesNotOverlap` matches the charter's wording exactly, skipping dependency-ordered pairs (`canonical.ts:682-707`, skip at `:691-696`). The compiler's admission rule is strictly stronger and fires first, refusing overlap for every pair "including dependency-ordered pairs" (`compiler.ts:665-681`, message at `:676`). Because the admitted shape is a chain, the charter-matching rule is vacuous and the stronger one is the real gate.
**Status: ADJUDICATED — the divergence is INTENTIONAL DEFENSE-IN-DEPTH and is NOT REPAIRED.** The strict all-pairs rule is the Phase 2 contract; both rules stay layered and neither is weakened. This is a deliberate non-repair, not an outstanding defect: all-pairs disjointness is what makes the deferred DAG widening automatically ownership-safe. **P-16.**

**#3 — "negative control: a way the verifier can be shown to actually fail" versus a source-bound string.** `negativeControls` is `string[]` (`types.ts:61`) whose entries must be quoted from the PRD (`authoring.ts:612-619`). Nothing executes them.
**Status: RESOLVED.** Layer 1 (the quoted claim) is unchanged and still required. Layer 2 adds a mechanical two-run differential, homed in a `CccPrdArtifact` row so it stays inside every gate (P-17), kept opt-in and non-blocking so the frozen compile contract is untouched (P-10, E-B), and proven by a fixture extension rather than a ledger relaxation (P-20). **P-17, P-20.**

### Recorded for the operator — not fixed in Phase 2

| Item | Why it is left |
|---|---|
| DAG admission in `productGraphAdmissionDiagnostics` (`compiler.ts:721-740`, plus the mirroring rule at `:786-833`) | Deferred to Phase 4–6, operator-gated. Touches the frozen product path and the acceptance gate. Widening must relax the mirroring rule too, not just the branching rules — otherwise a DAG still cannot be expressed in `edges[]`. |
| Unproven requirements can reach `compile` via a hand-authored or non-CLI-authored sidecar (§0.3, §5.5) | Pre-existing gap, unchanged by Phase 2. Closing it means moving the two CLI checks (`prd.ts:1471-1485`) into the compiler or adding a compile-side diagnostic — both frozen-path changes. |
| The two-layer ownership divergence (`compiler.ts:665-681` vs `canonical.ts:682-707`) | Intentional defense-in-depth per P-16. Listed so a future reader does not "fix" it by weakening one side. |

---

## Cost and timing honesty

No wall-clock claim is made for plan compilation. The stage is pure and does no I/O beyond reading the review and the admitted source bytes, so it should be fast relative to any provider-bearing stage — but that is an expectation, not a receipt. Per E3 the implementer reports measured wall-clock from the first real run; until then the honest cost claim is **unknown**.

The two-run negative-control differential (§4.2 Layer 2) does execute a verifier twice per checked proof, and its cost is entirely the verifier's. That is the one part of Phase 2 with a real and potentially large runtime, and it is why Layer 2 is opt-in.

Note the boundary the OQ-7 ruling draws: E3's "explicit unknown is legal" applies to **this section** — cost and timing claims — and not to gate outcomes. A gate check that cannot prove its property fails; it does not record "unknown".

---

## CHANGELOG — rev 3 → rev 4 (round-2 residue)

Round-2 verdict on rev 3: **ACCEPT-WITH-CHANGES** — all 29 round-1 dispositions held (28 fixed, 1 rebuttal accepted, 0 wrong, 0 unaddressed). Four new findings addressed to this document, all verified against source at `63f8bbb94` before being applied, all **FIXED**.

| Finding | Severity | Disposition | Change |
|---|---|---|---|
| N-F1 | MAJOR | **FIXED** | Regression introduced by the rev 3 OQ-1 fix. Verified: `artifacts` is absent from `validateSpans`'s skip list (`compiler.ts:1047-1053`, which skips only `edges`/`importIntents`/`authorityRoles`), so `spans: []` refuses `CCC_PRD_SOURCE_SPAN_MISSING` (`:344-347`) on every Phase 2 campaign. §2.2 gained the span-validation rule and the settled answer: a synthesized record carries the spans of the row it **describes** — workflow spans for `plan-dependency-graph`, the attested proof's spans for Layer 2 — copied from an already-validated row so they round-trip by construction, with the record's `content` stating that the span identifies its subject rather than quoting it. §4.2 gained a fifth consequence. Tests 15d1, 15d2, 38b1 added. |
| N-F2 | MAJOR | **FIXED** | Verified against the doc's own flag block: nine required flags, not ten — `--cli-adapter` is bracketed conditional. §5.6 corrected to **nine required flags** and an arity **range** (`options.length === 18`, or `=== 20` with `--transport cli`), with the second-order point stated: an exact-count check cannot express a conditional flag, so `parseGeneratedAuthorArgs`'s equality shape (`prd.ts:386`) is the wrong model and `fn prd policy`'s flag allowlist (`PRODUCT_POLICY_FLAGS`, `prd.ts:549-555`) is the right one. Tests 57a, 57b added. |
| N-F3 | MINOR | **FIXED** | §8 gained the unstated provisioning consequence: the six new checks compile their own bundle, so its regenerated intent set must include the artifact intent (`import-admission.ts:130-138`); the fixture's `artifacts: []` (`:1555`) is superseded for those checks only, and the pre-existing frozen checks keep the existing fixture unchanged. |
| N-F4 | MINOR | **FIXED** | §9's rev-2 row P-20 marked "**superseded by P-25**: no fixture extension is needed", so a reader scanning the decision table alone no longer picks up the instruction rev 3 reversed. |
| N-F5 | — | **No action** | Both rev 3 rebuttals (P-F12's `canonical.ts:333-341` anchor, X-F2's not-applicable-to-Phase-2) were independently verified and accepted by the reviewer. No change. |
| X-F1 (addendum) | — | **No action** | Round-2's completion addendum confirms both parts of the round-1 fix landed in §6 and §8 and records P-30. No residue. |

---

## CHANGELOG — rev 2 → rev 3 (round-1 review findings)

Round-1 verdict on rev 2: **REJECT** — 2 blockers, 5 majors, 4 minors, 2 advisories, plus 4 cross-document findings. Every finding was verified against source at `63f8bbb94` before being applied. Dispositions:

| Finding | Severity | Disposition | Change |
|---|---|---|---|
| P-F1 | BLOCKER | **FIXED** | §7 test 10 rewritten — it now pins the mirroring rule (`compiler.ts:815-828`) instead of contradicting it, with 10a/10b/10c added for the duplicate-edge, import-intent, and connectivity rules. The reviewer is right that test 10 was the *correct* one. §7 numbering gap closed by explicitly reserving 54/55. |
| P-F2 | BLOCKER | **FIXED** | Verified: `compiler.ts:786-833` is enforced bidirectional equality, not a comment. OQ-1 re-adjudicated (§10): `edges[]`/`dependencyTaskIds` carry exactly the chain; true graph moves to a `plan-dependency-graph` `CccPrdArtifact` row with per-edge `true-dependency`/`linearization-order` tags; emit-time toposort assertion retained. §2.2, §3.3, §3.4, §5.2, §7, §9 P-14a/P-15/P-21, contradiction #1 all re-propagated. |
| P-F3 | MAJOR | **FIXED** | §0.6's table gained four rows: connectivity walk (`:767-784`), mirroring both directions (`:815-828`), single edge per relation (`:829-833`), edge import-intent pairing (`:835-854`) — plus a paragraph stating the consequence that made P-F2 inevitable. |
| P-F4 | MAJOR | **FIXED** | §2.1 Stage H rewritten with the explicit temp-write ordering, citing `compiler.ts:1455-1461`, `custody.ts:110`/`:113`/`:122`/`:128-129`, and `validateSidecar`'s module-privacy (`compiler.ts:859`, exports at `index.ts:28`). §5.4's guarantee restated as "no file at either final path". Tests 47a/47b added. P-22. |
| P-F5 | MAJOR | **FIXED** | §3.3 gained explicit merge collapse rules: delete reflexive `dependencyTaskIds` entries and `edges` rows before re-deriving the chain, with all three failure paths cited (`compiler.ts:461-463`, `:742-748`, `:735-740`). Test 24a added. P-23. |
| P-F6 | MAJOR | **FIXED** | §2.1 Stage C gained the matcher-asymmetry rule and new code `CCC_PRD_PLAN_PROMOTION_DROPS_DISPOSITION`, citing the `question.includes(item.title)` arm (`material-coverage.ts:226`) absent from `matchingTasks` (`:220-223`). Tests 39a/39b added. P-24. |
| P-F7 | MAJOR | **FIXED** | §8's fixture-extension paragraph replaced: the existing `PROOF-VERTICAL` verifier is already mutable (`:1071`, `:1074-1104`, `:1132-1134`, `:1474-1487`), and the frozen assertions at `:716-719` / `:800-810` forbid the rev 2 instruction. Stop condition retained and re-scoped to the artifact consequence. P-25. |
| P-F8 | MAJOR | **FIXED** | §5.6 gained the full `fn prd plan` shape — five positionals, ten required flags, `options.length === 20` — modelled on `generatedAuthorFlags` (`prd.ts:358-369`, `:386`), with `admittedWriteRoots` folded into the ownership file as `{path, purpose}` pairs. Test 22a added. P-26. |
| P-F9 | MINOR | **FIXED** | Rationale corrected in both §5.6 and §10 OQ-5: repeated flags demonstrably work (`parseGuidedFreezeContext`, `prd.ts:1278-1285`); the real reason for one file is typed refusals plus pair-shaped write-root data. Ruling unchanged. P-27. |
| P-F10 | MINOR | **FIXED** | "CLI preview only" corrected to the shared product-bundle path in all five places (§0.3, §4.1 ×2, §5.5, §10 OQ-3), citing `assertProductBundleComplete` (`prd.ts:1452-1487`) and its single call site `compileProductBundle` (`:1636`, `requireMaterialCoverage: true` at `:1633`). P-28. |
| P-F11 | MINOR | **FIXED** | §4.2's three consequences became four; the new one states that any artifact row makes `artifact` a required writer class (`import-admission.ts:125-138`) and that intent regeneration must follow artifact attachment. Compounded in rev 3 because `plan-dependency-graph` makes this universal. Test 15e added. P-29. |
| P-F12 | MINOR | **FIXED (3 of 4)** / **REBUTTED (1)** | Corrected: `CCC_PRD_EXECUTION_PLAN_TARGET_PROTECTED` → `prd.ts:817-821` (`OUTPUT_EXISTS` → `:806-810`); 54/55 reserved. **Rebutted:** §7 test 22's `canonical.ts:333-341` is correct as written — `:333` computes `absoluteAllowedRoot`, `:334-337` is the condition, `:338-340` the throw, `:341` the closing brace; `:342` closes the enclosing `for` loop and is not part of the check. Anchor retained. The "36" arithmetic is handled under X-F1. |
| P-F13 | ADVISORY | **FIXED** | §3.3 now states plainly that there are two live outcomes, that the narrow branch admits only when the PRD text itself enumerates siblings, and that the target filesystem is never consulted (P-2 purity). Test 24b added. P-31. |
| P-F14 | ADVISORY | **FIXED** | §6 gained a re-verification subsection naming the three at-risk claims, including that `validateExactKeys` is applied per-collection so the `materialItemIds` containment claim must be re-checked for every fragment row type. P-32. |
| X-F1 | MAJOR | **FIXED** | §8's absolute counts replaced with relative language ("adds six ids to `expectedChecks`, whatever its length at merge time"), the pin count kept as a dated fact, and the ledger's four rejections cited as the reason staleness is fatal. §6 gained the rebase-and-re-read merge-order line. P-30. |
| X-F2 | MAJOR | **REBUTTED (not applicable to Phase 2)** | The finding's minimal fix is entirely Phase 3 §2.4/§5.4 — re-anchoring `native-authoring-adapter.ts:128` and fixing the two-gate relationship. This document contains no `verbatimCapable` gate, cites `native-authoring-adapter.ts` nowhere, and treats the flag as upstream-only (P-13, §6). No Phase 2 change is warranted; recorded here so the finding is not silently dropped. |
| X-F3 | MINOR | **FIXED (Phase 2 half)** | §6's new cross-campaign merge-order table records the asymmetry explicitly: `verbatimCapable` is irrelevant to Phase 2 and a hard fail-closed dependency for Phase 3, which tracks no merge order. The Phase 3 half of the fix belongs to that document. |
| X-F4 | MINOR | **FIXED** | §6's cross-campaign table names all three campaigns, what each touches in `packages/core`, and Phase 2's exposure to each — which is `expectedChecks` and nothing else. |

Reviewer findings recorded as SOUND and left unchanged: the human-merge gate treatment (§0.9, §5.3), E3 scoping (§10 OQ-7), the strict all-pairs ownership target (P-16), coverage regeneration (P-7/E-A), the OQ-3 refuse-at-emit ruling (P-18), the OQ-2 artifact placement (P-17), §2.3 intent regeneration, and §5.4's custody discipline.

**Orchestrator STOP condition — not hit.** The re-adjudication was conditioned on halting if the findings indicted the `CccPrdArtifact` home. They do not: the reviewer's own SOUND section records "every consequence §4.2 states is accurate. (P-F11 is an omission, not an error.)" Independently re-verified for the *new* dependency-graph use: the gate asserts no artifact count anywhere, and its only `directCounts` assertions are `tasks === 2` / `workItems === 1` (`ccc-prd-product-acceptance.mjs:3687-3688`), so `artifacts: []` at `:1555` is fixture provisioning, not a frozen assertion. The artifact home holds for both record kinds.

---

## CHANGELOG — rev 1 → rev 2 (orchestrator adjudications OQ-1..OQ-7)

Rev 2 folds seven adjudications. No rev 1 decision was re-opened and no redesign was performed; the entries below are rulings incorporated plus their mechanical consequences propagated.

| OQ | Ruling | Sections changed |
|---|---|---|
| OQ-1 | **L-variant, "chain with true edges preserved."** Deterministic topological linearization (lexicographic tie-break among ready tasks) into the admitted chain; true graph preserved verbatim in `edges[]`; no synthetic edge represented as a real dependency; cycles the only refusal. Option W (DAG widening) deferred to Phase 4–6, operator-gated. | §2.2 rewritten (the three-option block replaced by the ruling, the algorithm, and the `edges` / `dependencyTaskIds` containment invariant); §2.2 "Mechanical" bullet corrected to stop asserting edge/`dependencyTaskIds` equality; §3.4 rewritten around parallel-*ready*; new code `CCC_PRD_PLAN_CHAIN_VIOLATES_TRUE_EDGE` in §5.2, replacing `CCC_PRD_PLAN_GRAPH_NOT_LINEARIZABLE`; §7 test 15 rewritten and 15a/15b/15c added; §9 P-14, P-15; §10 OQ-1; contradiction #1 status |
| OQ-2 | **Layer 2 record lives in a `CccPrdArtifact` row**, carrying the two-run differential, bound verifier-command identity, and timestamps. Opt-in and non-blocking retained. | §4.2 placement paragraph rewritten with the three artifact-layer consequences (`compiler.ts:1249`, `:1253-1260`, `import-admission.ts:125-129`); §7 tests 38a/38b/38c added; §8 evidence fields extended; §9 P-17; §10 OQ-2; contradiction #3 status |
| OQ-3 | **Frozen compile contract untouched.** New stage refuses `CCC_PRD_PLAN_REQUIREMENT_UNPROVEN` instead. CLI preview refusals stay put. Hand-authored-sidecar bypass recorded as a pre-existing gap. | New §5.5; new code in §5.2; §7 tests 31a/31b added; §9 P-18; §10 OQ-3; new "Recorded for the operator" table |
| OQ-4 | **Strict all-pairs rule is the Phase 2 contract.** Both rules stay layered; divergence recorded as intentional defense-in-depth, not repaired. | §3.3 gained the ruling and its consequence that merge/narrow is load-bearing, not rare; §3.4 forward-looking rationale; §9 P-16; §10 OQ-4; contradiction #2 status |
| OQ-5 | **One `--ownership-file <path>` flag**, schema-validated JSON, root-confined, typed refusals. No repeated-flag shapes. | New §5.6 with the three ownership-file refusal codes; §7 tests 57–62 added; §9 P-19; §10 OQ-5 |
| OQ-6 | **New `fn prd plan` subcommand**; `fn prd policy` untouched. | §5.6; §7 test 56 added; §9 P-19; §10 OQ-6 |
| OQ-7 | **Fixture extended, ledger unchanged.** Two-state pass-only retained; E3's "unknown" scoped to cost claims, not gate outcomes; explicit stop condition if the fixture cannot host a mutable verifier. | §8 gained "The ledger stays two-state"; §8 differential-check evidence corrected to drop the "records unknown" fallback; cost section gained the E3 boundary note; §9 P-20; §10 OQ-7 |
| — | **Endorsed-settled, no change.** `materialCoverage` regeneration on any task-set mutation (P-7) and the non-blocking Layer 2 posture (P-10) confirmed as ruled. | §9 new "Endorsed-settled" table (E-A, E-B) |
| (a) | Header re-marked rev 2; the "two flagged contradictions" preamble corrected to three and re-scoped from "not resolved" to "adjudicated"; §9 "Open" section emptied. | Header, §9 |
| (b) | Citation precision fixes carried from rev 1 review: `compiler.ts:515-516` (degenerate chain), `canonical.ts:333-341` (admitted-root containment), `compiler.ts:1089-1103` with the key list at `:1092-1101` (proof exact keys), `prd.ts:457`/`:491` (arg-count and distinct-value checks), `prd.ts:264-279` (path escape), `custody.ts:218`/`:243`/`:244-247` (authoritative ingest). | §4.2, §5.6, §7 |
