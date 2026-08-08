# D2 — chunked extraction with deterministic anchoring (design, 2026-08-03, rev 2)

Design resolution for the two ceilings Stage 4 measured: models cannot copy 48 quotes byte-exact *and* disposition 88 material blocks inside one bounded response, and a sentence that occurs twice verbatim cannot be anchored uniquely by any prompt. This document is bird's-eye and mid-level. Granular particulars — exact constant values where a range is given, file layout, function signatures, fixture bytes — are the implementer's call.

**Revision 2** answers an adversarial review that rejected rev 1 with five blockers and eight majors. Every finding is addressed; the mapping is in the CHANGELOG at the end.

**Evidence base.** Every claim about current behavior carries a `file:line` citation, re-read on 2026-08-03 from the worktree `/Users/ryanpappal/03_CODE/ccc-fusion-worktrees/stage4-prd-understanding` at HEAD **`1efd1071ab9b81ede823acb243feafecc6a7cab2`** (`1efd1071a`, "fix(lint): drop orphaned hasSourceBoundRows helper"). That lint commit removed a 15-line helper from `authoring.ts`, so every `authoring.ts` line below is 15 lower than in rev 1. Paths are repo-relative. `main` may not yet carry these bytes; verify before editing.

**Settled inputs, not re-litigated.** D2 (chunked extraction plus a deterministic anchor resolver, single-shot retained as a fast lane), D3 (extraction model class is a correctness property; MoE disqualified from quote-bearing work; routes must declare verbatim capability), and the frozen E-series (live resolver is authority; requested identity in the binding hash only; cost claims require receipts and explicit "unknown" is legal).

**Adjudicated decisions (rev 1's open questions, now closed).**

| # | Decision |
|---|---|
| D-1 | Resume journal is **opt-in and confined inside the packet root**, under the same boundary and `CCC_PRD_PATH_ESCAPE` semantics as the review output. No arbitrary journal paths. |
| D-2 | Chunk execution is **serial**. Order-independent assembly is the prerequisite for any future parallelism, and is pinned by a test. |
| D-3 | Fast-lane classifier is **inventory-item count × byte budget**, never file count. The acceptance gate asserts `lane === "single"` directly. |
| D-4 | `verbatimCapable` is a **declared operator assertion**, rendered as such. Measurement is deferred until real anchor-failure data exists. |
| D-5 | **No rewriting of model-copied source tokens.** Namespacing lives in an internal assembly key only; emitted IDs are the model's own; genuine collisions refuse. |
| D-6 | The execution authoring path **stays strict**. Extension is an understanding-lane device, and it never widens the emitted span. |

---

## 0. What the current code actually does

Seven facts shape every decision below.

**Quote anchoring is byte-exact and file-scoped.** `resolveSourceRefs` takes each `{path, exactQuote}`, finds it with `Buffer.indexOf` over the whole admitted source, refuses `CCC_PRD_SOURCE_QUOTE_MISSING` on zero hits (`packages/engine/src/ccc-prd/authoring.ts:749-754`) and `CCC_PRD_SOURCE_QUOTE_AMBIGUOUS` on a second hit (`authoring.ts:755-760`), then builds the span and stamps `excerptSha256` over the quoted bytes (`authoring.ts:761-770`, whole function `:717-771`). An unadmitted path is `CCC_PRD_SOURCE_SPAN_FOREIGN` (`authoring.ts:742-746`). There is no extension, no normalization, no fallback. Spans carry absolute byte offsets, display line/column, and the whole-file `sha256` (`packages/core/src/ccc-prd/contract.ts:131-158`; type at `packages/core/src/ccc-prd/types.ts:12-27`).

**The field contract the model must honor.** Citations live under `sourceRefs`, an array of `{path, exactQuote}` (`packages/core/src/ccc-prd/types.ts:373-376`), attached to every source-bound row type (`types.ts:378-415`). `confidence` is the string union `"high" | "medium" | "low"` (`types.ts:35`). `bounds` is an object with `maxRequests`, `maxDurationMs`, `maxConcurrency` (`types.ts:210-214`) — the shape validator refuses an array (`authoring.ts:235-237`) and a non-string confidence (`authoring.ts:241-243`). It enumerates every violation rather than saying "wrong shape" (`authoring.ts:147-245`), which is the pattern per-chunk validation copies.

**Coverage is scored from a deterministic heading walk.** `inventoryForSource` walks Markdown lines outside code fences, collecting ATX headings that have a non-empty immediate body (`packages/engine/src/ccc-prd/material-coverage.ts:87-138`; fence skip at `:97`, heading regex at `:98`, empty-body skip at `:119-120`) and separately collecting requirement-token rows (`material-coverage.ts:140-169`; fence skip at `:141`, heading regex at `:142`). A section item's coverage range runs from its heading line to the next *peer or shallower* heading, **or to end-of-file when no such heading exists** (`material-coverage.ts:121-126`). A requirement item's range is its single line (`:164-165`), and its `title` is the literal source token (`:162`). Disposition counts when a span byte-overlaps that range (`material-coverage.ts:178-187`).

**A requirement alone never dispositions anything.** In `analyzeCccPrdMaterialCoverage`, matching requirements are computed (`material-coverage.ts:216-218`) but only feed task matching (`:220-223`). The four paths that actually push into `coverage` are: a matching task (`:243`), a matching unresolved decision (`:252`), an explicit deferral marker (`:260`), and an explicit out-of-scope marker (`:268`). Everything else lands in `missing` (`:277`). A task plus a deferral/out-of-scope/unresolved marker, or a deferral plus an out-of-scope marker, lands in `conflicts` (`:234-240`). The analyzer accepts exactly three semantic collections: requirements, tasks, unresolvedDecisions (`material-coverage.ts:32-37`).

**The understanding depth gate is a floor, not a completeness check.** It refuses only when the inventory has ≥8 items and under a quarter are dispositioned, or ≥4 explicit requirement items and under half (`packages/engine/src/ccc-prd/understanding.ts:19-24, 208-232`). The cqw run at 20 of 88 (22.7%) fell under that floor. Conflicts are *reported* in the review but never refuse it (`understanding.ts:263-264`).

**The compile path emits six coverage diagnostics across two gating tiers, not two codes.** All in `checkCccPrdPacket`'s coverage block, split by the early return at `compiler.ts:1391` (`if (!input.requireMaterialCoverage) return;`):

| Tier | Condition | Code | Lines |
|---|---|---|---|
| **always** | `materialCoverage` array must exist | `CCC_PRD_MATERIAL_COVERAGE_REQUIRED` | `compiler.ts:1376-1380` |
| **always** | stored coverage must **canonically equal** the recomputed analysis | `CCC_PRD_MATERIAL_COVERAGE_INVALID` | `compiler.ts:1381-1389` |
| gated | zero conflicting dispositions | `CCC_PRD_MATERIAL_COVERAGE_INVALID` | `compiler.ts:1406-1414` |
| gated | zero undispositioned material sections | `CCC_PRD_MATERIAL_SECTION_UNDISPOSITIONED` | `compiler.ts:1415-1424` |
| gated | zero undispositioned explicit requirements | `CCC_PRD_SOURCE_REQUIREMENT_UNDISPOSITIONED` | `compiler.ts:1425-1434` |
| gated | under 80% resolved with any missing or conflicts | `CCC_PRD_EXTRACTION_IMPLAUSIBLY_SHALLOW` | `compiler.ts:1437-1448` |

The tier split is operationally important: the two `materialCoverage` conditions run on **every** compile, while the four coverage-quality conditions run only when the caller passes `requireMaterialCoverage`. The new acceptance check (§9) must therefore invoke the compile path **with `requireMaterialCoverage` set**, or it exercises two of the six diagnostics and silently reports a pass.

The canonical-equality gate at `:1381-1389` is the one rev 1 missed entirely, and it is load-bearing *and* always-on: the assembled sidecar's `materialCoverage` must be produced by the *same* `analyzeCccPrdMaterialCoverage` call the authoring path already makes (`authoring.ts:1036-1045`), or compile refuses even when coverage is genuinely complete.

**One packet is one prompt is one provider call, and output custody is atomic.** `buildPrompt` serializes every admitted source verbatim into one string (`packages/engine/src/ccc-prd/native-authoring-adapter.ts:97-167`; sources at `:158-165`, carrying full bodies per `types.ts:450-456`), and `generateCandidate` makes exactly one transport call raced against a timeout (`native-authoring-adapter.ts:258-308`). Sampling is deterministic — `temperature: 0` (`:200`) — so a retry that does not change the prompt reproduces the same output. Understanding calls authoring with no `constraints` (`understanding.ts:165-170`), so the whole constraints block including target drift, bounds drift, and the review-count bound is skipped in review mode (`authoring.ts:861-898`; target drift `:866-874`, bounds drift `:875-883`, review count `:884-897`). Output resolves inside the admitted packet root and refuses `CCC_PRD_PATH_ESCAPE` on escape, symlink, or protected segment (`packages/cli/src/commands/prd.ts:254-303`), must not pre-exist (`prd.ts:1018-1023`), is written through a temp directory inside the root and renamed (`prd.ts:508-524`), and any refusal writes nothing and exits 1 (`prd.ts:1081-1084`).

---

## 1. Chunk-boundary policy

**Principle: the chunk planner and the coverage scorer read the same inventory — but the inventory picks cut *points*, it does not decide which *bytes* get read.**

### The byte-partition invariant

For each authoritative source file, the union of its chunk slices must equal `[0, byteLength)` exactly, with every byte in exactly one slice apart from explicitly declared overlap margins. This is the primary invariant.

It exists because the inventory cannot see everything. `inventoryForSource` recognizes ATX headings only (`material-coverage.ts:98, :142`) — setext (`===` / `---` underline) headings are invisible. It skips fenced lines (`:97, :141`). And a section's coverage range starts at its heading line (`:134`), so any preamble, YAML frontmatter, or title block before the first heading belongs to no inventory item at all. Cutting a plan from inventory ranges alone would silently drop those bytes from extraction while still reporting complete coverage.

Rev 1's "a chunk's slice must fully contain the coverage range of every assigned item" is **deleted as a normal-case invariant**. It is false for the common case: a top-level heading with no later peer gets `coverageEnd = bytes.byteLength` (`material-coverage.ts:124-126`), so its range is the rest of the file, and containment would forbid the first cut of any file large enough to need chunking. Containment holds only for leaf sections and is never assumed.

### Cut-point selection

1. Compute the heading list for the file (the same walk as `material-coverage.ts:96-110`).
2. Start at the **shallowest** heading level present. Cut at those heading line starts. If every resulting piece fits `maxSliceBytes`, stop.
3. For any piece still over budget, descend one heading level *within that piece only* and cut again. Repeat.
4. For a piece with no interior heading left (a long table, code fence, or directory tree), cut at line boundaries and give each part an `overlapBytes` margin into its neighbor, so a quote straddling the cut is wholly present in at least one slice. Mark those chunks `partialSection: true`; assembly expects duplicate rows from them and merges (§4).
5. Bytes before the first heading are their own leading slice, chunked by line boundaries if oversize.
6. If the smallest indivisible unit still exceeds `maxSliceBytes`, refuse `CCC_PRD_CHUNK_PLAN_INVALID` before any provider call. Never truncate silently.

Descending only as needed keeps chunks as semantically whole as the budget allows, which is what makes a chunk's material items dispositionable from its own bytes.

### Item assignment

Each inventory item is assigned to the chunk containing its **heading-line start** (`spans[0].byteStart`). Heading lines are points, so this is a strict partition regardless of how ranges nest or overrun. An item's coverage *range* may extend past its chunk; that is expected and harmless, because chunk verification asks only whether the item is dispositioned (§3), not whether its whole range is in-slice.

### Size bounds

```
promptBudgetBytes ≈ (contextWindow − reservedOutputTokens − promptOverheadTokens) × bytesPerToken
```

Registered routes: `local-omlx` (dense 27B, A3B MoE) at maxTokens 32768 / context 65536, and `m2max-omlx` (OptiQ 27B) at 32768 / 262144. Limits come from provider model entries (`packages/core/src/types/workflow-steps.ts:195`) with registry fallbacks 16384 / 128000 when undeclared (`packages/engine/src/custom-provider-registry.ts:103-104`).

| Constant | Recommended | Rationale |
|---|---|---|
| `sliceTargetBytes` | 24 KiB (≈6k tokens) | Leaves room for the rules block plus a fragment on the 65,536-token window |
| `maxSliceBytes` | 48 KiB | Hard ceiling that triggers a deeper cut |
| `overlapBytes` | 2 KiB | Forced mid-section splits only |
| `reservedOutputTokens` | route `maxTokens` | Never assume early stopping |

A bigger context window buys **fewer chunks, not different rules**. Do not scale slices to fill a 262k window: generation dominates cost (≈23,000 tok/s cached ingest versus ≈74 tok/s generation), and a larger slice raises the chance a duplicated sentence lands twice inside one slice — the one case the resolver cannot settle (§5).

### Multi-file packets

Per-file plans concatenate in `custody.sources` order (manifest order, `packages/engine/src/ccc-prd/custody.ts:216-250`). A chunk never spans files, because `sourceRefs.path` and byte offsets are per-file. A requirement stated in file A and implemented in file B produces rows in two chunks, linked at assembly by ID (§4).

### Determinism

The plan is a pure function of `(packetHash, chunkPolicyVersion, sliceTargetBytes, maxSliceBytes, overlapBytes)`. Emit `chunkPlanHash = sha256(canonical JSON of the plan)`, computed before any provider call and carried in the run receipt. Same packet plus same policy always yields the same plan, which is what makes resume safe (§6).

If the whole packet's inventory is empty, refuse `CCC_PRD_CHUNK_PLAN_NO_INVENTORY`. An empty inventory makes `missing` trivially empty and would let a zero-heading or setext-only packet report perfect coverage having dispositioned nothing.

---

## 2. Per-chunk request contract

### Exact edits to `buildPrompt`

Rev 1 said "reuse `buildPrompt`, everything else byte-identical", which contradicted the fragment schema and omitted the change that makes chunking work at all. The edits, enumerated:

| Edit | Current | Change |
|---|---|---|
| Schema declaration | `native-authoring-adapter.ts:118` (interpolated constant) and `:137` (template literal) | Both become `ccc-prd.authoring-proposal-fragment.v1` |
| Singleton template keys | `:148` `bounds`, `:149` `admittedWriteRoots`, `:150` `targetRepository`, `:151` `nonGoals`, `:155` `confidence` | Removed from the fragment template — they are packet-global (§4) |
| Required-arrays line | `:127` (names all 19 top-level keys) | Names only the fragment collections |
| Coverage instruction | `:126` "disposition every Markdown heading block and requirement-like row" | "disposition every material item listed in this chunk" |
| Quote scope | — | New line: "Quote only from the bytes between BEGIN CHUNK SLICE and END CHUNK SLICE. A quote drawn from anywhere else is refused." |
| Payload | `:158-165` `orderedSources: request.sources` — full bodies of every file (`types.ts:450-456`) | Replaced by the chunk envelope below |

Everything else stays byte-identical, because it is measured to work: the verbatim-copy discipline (`:121-123`) and the field-contract template (`:136-156`) took shape failures from 100% to zero.

### The understanding-mode instruction block

Rev 1 said "drop `:108-111`". That is wrong — `:111` is the anti-invention rule, not a singleton instruction. The block is `native-authoring-adapter.ts:106-111`:

- `:106` review-only framing — **keep**
- `:107` extract source-grounded meaning — **keep**
- `:108` empty-string targetRepository — **drop** (packet-global, handled at assembly)
- `:109` zero bounds — **drop** (packet-global)
- `:110` empty admittedWriteRoots — **drop** (packet-global)
- `:111` *"Do not make assumptions. Convert every missing implementation-changing fact into a source-bound unresolved decision."* — **keep in every chunk prompt**

Dropping `:111` would remove the single instruction that turns a knowledge gap into an unresolved decision instead of an invention. It is also the instruction that makes an otherwise-bare material item dispositionable (`material-coverage.ts:252-259`), so it is load-bearing for coverage as well as honesty.

### Chunk envelope

```
{
  mode: "understanding" | "execution",
  packetHash, sourceVersion, chunkPlanHash,
  chunkId, chunkOrdinal, chunkCount,
  packetHeader: [{ path, role, sha256, byteLength }],   // paths only, no other file's bytes
  sourcePath, sliceByteStart, sliceByteEnd, sliceSha256,
  materialItems: [{ id, headingPath, title, byteStart, byteEnd }],
  slice: "<verbatim bytes of [sliceByteStart, sliceByteEnd)>"
}
```

The packet header carries paths but never other files' bodies, so IDs and `sourceRefs.path` stay valid packet-wide at a fraction of the context. Offsets in `materialItems` are absolute file offsets; the model is never asked to emit an offset, only `{path, exactQuote}`, and every offset is re-derived mechanically. That is why the existing field contract needs no change.

### Fragment shape

`ccc-prd.authoring-proposal-fragment.v1`. Rows are **exactly** the existing proposal row types (`types.ts:378-441`) — same keys, citations under `sourceRefs` as `{path, exactQuote}`, `confidence` as the string union. A fragment carries `requirements`, `proofs`, `tasks`, `edges`, `workflows`, `documents`, `artifacts`, `importIntents`, `protectedActions`, `unresolvedDecisions`, `ambiguities`, `exceptions`, `authorityRoles`.

It does **not** carry `bounds`, `targetRepository`, `admittedWriteRoots`, `nonGoals`, or packet-level `confidence`. N chunks emitting N copies would produce N conflicting facts with no adjudication rule.

One field is added per row: `materialItemIds`, listing the chunk-plan item IDs (`MAT-<hash>`, `material-coverage.ts:49-61`) the row claims to disposition. It is a *ledger* for diagnostics, checked against the real analyzer — never trusted on the model's word.

---

## 3. Mechanical per-chunk verification

No fragment reaches assembly until it passes all of these against real source bytes, cheapest and most diagnostic first.

1. **Shape.** Same enumerating validator style as `describeProposalShapeViolations` (`authoring.ts:147-245`). Failure: `CCC_PRD_CHUNK_FRAGMENT_INVALID`.
2. **Source scope.** Every `sourceRefs.path` must equal the chunk's `sourcePath`. Failure: `CCC_PRD_CHUNK_FOREIGN_SOURCE`.
3. **Quote in slice.** Every `exactQuote` must occur at least once inside the slice bytes, not merely somewhere in the file. Blocks a model reciting text from an earlier chunk. Failure: `CCC_PRD_CHUNK_QUOTE_OUTSIDE_SLICE`.
4. **Anchor resolution.** Each quote goes through the resolver (§5) and comes back as a span shaped exactly as `authoring.ts:761-770` produces today.
5. **Coverage, using the real scorer.** Run `analyzeCccPrdMaterialCoverage` with `sourceBytes = { chunkSourcePath: <full file bytes> }` and the fragment's resolved `requirements`, `tasks`, `unresolvedDecisions` (`material-coverage.ts:32-37`). Then require, **for every item assigned to this chunk**: it appears in `coverage`, and it does not appear in `conflicts`. Items assigned to other chunks are ignored at chunk scope.
6. **Task custody**, only when constraints are present: reuse `validateTaskCustodyProvenance` unchanged (`authoring.ts:105-139`). Understanding passes no constraints (`understanding.ts:165-170`), so this stays conditional exactly as today.

### Why step 5 must call the analyzer

Rev 1's step 5 was "every assigned item has at least one overlapping accepted span". That is strictly weaker than the scorer and would have shipped a false completeness proof. A requirement row with an overlapping span dispositions **nothing** — matching requirements only feed task matching (`material-coverage.ts:216-223`), and the four disposition paths are task (`:243`), unresolved decision (`:252`), explicit deferral (`:260`), explicit out-of-scope (`:268`). A chunk emitting only requirements passes the weak check and lands every one of its items in `missing` (`:277`).

Running the real analyzer at chunk scope also catches conflicts early (`:234-240`), which chunking makes *more* likely, not less: independent chunks can attach a task to a section another chunk marked deferred.

**Known conservative bias.** Cross-chunk disposition — a requirement in chunk 3 whose implementing task appears in chunk 9 — fails chunk-scope checking even though assembly would resolve it, because `matchingTasks` needs the task and the requirement in the same analyzer call (`:220-223`). The mitigation is the retained `:111` instruction: a chunk that cannot disposition an item from its own bytes emits a source-bound unresolved decision, which *is* a valid disposition (`:252-259`) and which assembly preserves. This biases toward more unresolved decisions rather than false coverage, which is the correct direction — but it interacts with the review-item budget (§4), and how often it fires is unmeasured.

### Retry versus refusal

`maxChunkAttempts` defaults to **2** — one attempt plus one mechanically-guided repair.

**Retry-eligible** (model-fixable, mechanically diagnosable): failures 1, 2, 3, 5, plus `CCC_PRD_SOURCE_QUOTE_MISSING` and the resolver's ambiguity refusal. The retry prompt is the same envelope plus a generated `priorViolations` array with the exact enumerated strings, including — for ambiguity — the colliding line numbers. Because sampling is deterministic (`native-authoring-adapter.ts:200`), a retry that does not change the prompt is guaranteed to reproduce the same output; carrying the violation list is what makes a retry meaningful.

**Never retried** (route or infrastructure): transport identity drift (`native-authoring-adapter.ts:289-293`), egress violation (`:58-95`), response over `maxResponseBytes`, timeout, and the verbatim-capability refusal (§8).

When any chunk exhausts its attempts, **the whole run refuses** with `CCC_PRD_CHUNK_ATTEMPTS_EXHAUSTED`, naming the chunk, surviving violations, and undispositioned items. There is no partial review.

---

## 4. Assembly semantics

### Identity — no rewriting of model-copied tokens

Rev 1 proposed rewriting every row ID to `<chunkOrdinal>-<rawId>`. That is rejected, and it was actively harmful: it destroys the `requirement.id === item.title` disposition path (`material-coverage.ts:217`), where `item.title` for requirement-kind inventory items is the *literal source token* copied out of the PRD (`:162`). Prefixing `REQ-FOO` to `07-REQ-FOO` breaks that equality, so chunked runs would score **worse** on exactly the metric the depth gate measures (`understanding.ts:212-217`).

The rule instead:

- Emitted IDs are the model's own, unmodified.
- Namespacing exists only as an **internal assembly key** `(chunkOrdinal, rawId)`, used for bookkeeping and never serialized.
- Same raw ID from two chunks with **equal** scalar payload → **merge**: union the `sourceRefs`/spans, keep one row. This is the normal, desirable case for a requirement token cited in two sections.
- Same raw ID with **different** scalar payload (statement, acceptance, command, oracle, kind, target, title, description) → refuse `CCC_PRD_ASSEMBLY_ID_COLLISION`, naming both chunks and the differing field.

Never rewrite a token the model copied out of the source. Any identifier the source itself defines is data, not a slot.

### Ordering and dedupe

Sort rows by ID with the existing comparator (`sortCccPrdById`, `custody.ts:272-274`) and sort spans with `compareSourceSpans` (`authoring.ts:333-339`). Assembly **reuses those helpers but is not `mapProposal`** (`authoring.ts:784`, invoked at `:910`): `mapProposal` resolves `sourceRefs` through `resolveSourceRefs`, which would refuse the slice-disambiguated quotes the resolver legitimately anchored (§5, "The chunked lane replaces `resolveSourceRefs`"). Assembly consumes fragments whose spans are already final. Assembly must be **order-independent**: the same fragment set in any arrival order canonicalizes to byte-identical JSON. Per D-2 that is the prerequisite for future parallelism, not a nicety.

Dedupe emits a **loser → winner ID map**, applied to every reference in every surviving row *before* the dangling-reference check. Rev 1 deduped without remapping while declaring unresolved references fatal, which manufactured `CCC_PRD_ASSEMBLY_DANGLING_REFERENCE` out of its own merges.

`CCC_PRD_ASSEMBLY_CONFLICT` is restricted to **contradictory facts** — two rows asserting different scalar values for the same identity. Co-located citations are not a conflict. Rev 1 refused on "same spans, different payload", but line-granular resolver behavior (§5) plus declared overlap margins (§1) make different rows citing identical spans the *expected* output, so that rule would have refused valid reviews.

### Review-item budget

`understanding.ts:185-193` refuses `CCC_PRD_AUTHORING_REVIEW_UNBOUNDED` when ambiguities + unresolvedDecisions + exceptions + protectedActions exceed `maxReviewItems`, and the gate passes `--max-review-items 4` (`scripts/ccc-prd-product-acceptance.mjs:2363-2364`). Chunking multiplies these rows: §1 expects an unresolved decision from any chunk that cannot disposition an item locally.

Decision: **the bound is on the assembled total, and it is checked as a running total after every chunk.** A run whose budget is already blown at chunk 2 refuses at chunk 2 with `CCC_PRD_CHUNK_REVIEW_BUDGET_EXCEEDED` (carrying chunk ordinal and running total), not after eight minutes of generation. The final assembled check still runs `understanding.ts:185-193` unchanged, so the existing code path and refusal remain authoritative.

Sizing guidance for operators: budget roughly 2–4 review rows per chunk. A 20-chunk plan needs a bound near 40–80, not 4. State the arithmetic in the CLI help so the number is chosen, not guessed.

### Packet-level singletons

In understanding mode, synthesize mechanically rather than spending a provider call. The review contract already forces them empty (`native-authoring-adapter.ts:108-110`, now dropped from chunk prompts): empty `targetRepository.path` and `baseCommit`, zero bounds, empty `admittedWriteRoots`. `nonGoals` is the deduped union of fragment-supplied non-goals; packet `confidence` is the minimum across fragments.

This is what keeps the frozen assertions true: `implementationContext` derives `missingFacts` from exactly those empty values (`understanding.ts:107-151`), and the gate asserts all four codes (`scripts/ccc-prd-product-acceptance.mjs:2388-2410`). Per-chunk emission would not reproduce it.

In execution mode the singletons come from caller constraints and are drift-checked as today (`authoring.ts:861-898`).

### Coverage accounting

Assembly must build the sidecar's `materialCoverage` through the **same** `analyzeCccPrdMaterialCoverage` call the authoring path makes (`authoring.ts:1036-1045`). Anything else fails the canonical-equality gate at `compiler.ts:1381-1389` even when coverage is genuinely complete.

After assembly, re-run the analyzer over the whole packet and require **both**:

- `analysis.missing.length === 0`, else `CCC_PRD_UNDERSTANDING_COVERAGE_INCOMPLETE`
- `analysis.conflicts.length === 0`, else `CCC_PRD_UNDERSTANDING_COVERAGE_CONFLICTED`

Conflicts must gate on the chunked path even though `understanding.ts:263-264` only reports them today, because chunking raises the conflict risk (independent chunks disagreeing about one section) and because compile refuses on conflicts anyway (`compiler.ts:1406-1414`). Shipping a review that cannot compile is the failure this whole design exists to prevent.

**What the completeness claim now rests on.** Not "by construction" in the hand-waving sense rev 1 used, but on three checkable facts: every inventory item is assigned to exactly one chunk (heading-line partition, §1); every chunk is accepted only when the real scorer dispositions all of its assigned items and conflicts none of them (§3 step 5); and the whole-packet re-run uses that same scorer. The whole-packet re-run is the authority — the chunk-scope check is what makes failure fast and locally attributable.

### Interaction with `CCC_PRD_UNDERSTANDING_IMPLAUSIBLY_SHALLOW`

Keep the existing gate exactly as written (`understanding.ts:208-232`). It is a floor and should be structurally unreachable on a chunked run. If it ever fires there, that is the alarm that planner and scorer diverged. Chunked understanding output now targets all five compile-side conditions (§0), which is the real bar.

---

## 5. Deterministic anchor resolver

Pure function. No model involvement, no invented bytes, no inference about intent.

### The adopted mechanism: extension selects, it never widens

Rev 1 had the resolver extend a quote until unique and emit the *extended* span. That is wrong, and the review caught it: coverage matching is pure byte-range overlap (`material-coverage.ts:182-186`), so an 8 KiB extension against 24 KiB slices could disposition items using text the model never read.

The fix is cleaner than "carry two spans". **Extension is a selection procedure whose only output is a byte offset.** The resolver extends candidate windows solely to decide *which occurrence* the model meant. Once one candidate survives, the emitted span is exactly:

```
[byteStart, byteStart + quote.byteLength)   with   excerptSha256 = sha256(quote)
```

— byte-identical in shape and semantics to what `authoring.ts:761-770` produces today. There is only ever one span in the artifact, it is always the model's own quoted bytes, and coverage math therefore never sees a byte the model did not read. The extended window appears in the run receipt only, as evidence of how the offset was chosen.

### Algorithm

1. Enumerate every occurrence of `proposedQuote` in the whole file (the same `indexOf` walk as `authoring.ts:748-760`).
2. **Zero** → `CCC_PRD_SOURCE_QUOTE_MISSING`, unchanged. Retry-eligible; this is the MoE paraphrase signature.
3. **Exactly one** → done, no extension attempted.
4. **More than one** → restrict candidates to occurrences starting inside `sliceBounds`.
   - **Exactly one in-slice candidate** → accept its offset. (Extension is not even needed: the slice already selected it. Still record the file-wide occurrence count in the receipt.)
   - **Several in-slice candidates** → run the extension loop independently from each. If exactly one candidate's window reaches file-wide uniqueness within limits, accept **that candidate's original offset**. If two or more reach uniqueness, the quote does not identify a location: refuse `CCC_PRD_ANCHOR_AMBIGUOUS_INTENT` listing every candidate's line number. The resolver never guesses.
   - **Zero in-slice candidates** → already caught by §3 step 3.

### Extension loop

Window starts at `[start, start + len)`, then:

- **Direction schedule:** right, left, right, left. Fixed, never data-dependent.
- **Step ladder:** (a) extend to the next line boundary in that direction, newline inclusive; (b) once at a line boundary, extend by one whole line; (c) at a file edge, the other direction continues alone.
- Recount window occurrences file-wide after each step; stop at one.
- **Limits:** `maxAnchorExtensionLines` (recommend 40), `maxAnchorExtensionBytes` (recommend 8192). Either exceeded → `CCC_PRD_ANCHOR_UNRESOLVABLE`.

Determinism is total: the outcome is a pure function of file bytes, initial quote, the fixed schedule, the fixed ladder, and the limits. Candidate enumeration order is irrelevant because every candidate is tried and the verdict is "exactly one survived" or "refuse".

### The two measured killers

**A sentence appearing twice verbatim (cqe, quote 48 of 48).** Under single-shot both occurrences are equally plausible — genuinely unresolvable, which is where Stage 4 stopped. Under chunking the slice is the disambiguation authority: if the occurrences fall in different chunks, the in-slice candidate set has one member and the offset is settled with no guessing at all. If both fall in one slice, the resolver refuses and the retry prompt says *"this quote occurs twice inside your slice, at lines X and Y — extend it"*. That is a mechanically generated, precisely actionable repair.

**A repeated bare identifier — `t-phase-1` (atm).** The in-slice restriction narrows candidates; survivors each extend to their own line, and both defining and referencing lines are typically unique, so several reach uniqueness and the resolver refuses with the full colliding-line list. The prompt already forbids quoting a short repeated identifier alone (`native-authoring-adapter.ts:123`); the resolver turns that guidance into a repairable failure carrying exact evidence. A retry quoting the whole defining line resolves in one step.

Neither case has an escape hatch that invents text. If the resolver cannot resolve and the retry budget is spent, the run refuses.

### The chunked lane replaces `resolveSourceRefs`; it never re-runs it

This is a hard structural consequence of selection-only anchoring, and it must be built deliberately rather than discovered.

Selection legitimately emits a span for a quote that occurs **more than once in the file** — that is the whole point of step 4's first bullet, where the slice, not the quote, settles which occurrence was meant. But `resolveSourceRefs` refuses exactly that shape: it throws `CCC_PRD_SOURCE_QUOTE_AMBIGUOUS` on any second file-wide hit (`authoring.ts:755-760`). And `mapProposal` (`authoring.ts:784`, invoked at `:910`) resolves every row's `sourceRefs` through that same function. So passing an assembled chunked proposal back through the single-shot path would refuse precisely the quotes the resolver just legitimately anchored.

Therefore:

- **The chunked lane builds spans once, in the resolver, at chunk-verification time (§3 step 4).** Those spans are final.
- **The assembled proposal is never re-run through `resolveSourceRefs` or `mapProposal`.** Assembly consumes fragments that already carry resolved spans; it performs `mapProposal`'s *other* duties — sorting by ID (`sortCccPrdById`), span sorting (`compareSourceSpans`), protected-action normalization (`normalizeProtectedAction`) and ID canonicalization — through a chunk-lane assembler that shares those helpers but not the quote-resolution step.
- **Assembly rows carry spans, not `sourceRefs`.** By the time a fragment is accepted it has been converted from `{path, exactQuote}` to `CccPrdSourceSpan[]`, exactly as `withoutSourceRefs` does today (`authoring.ts:773-782`) — but using the resolver's chosen offset rather than a bare `indexOf`.
- The emitted span shape is unchanged (`types.ts:12-27`), so everything downstream of assembly — coverage scoring, `materialCoverage`, compile — is unaffected. Only the *route to* the span differs.

The single-shot lane keeps calling `resolveSourceRefs`/`mapProposal` untouched. The two lanes converge on the same span type, not the same resolution code.

### Scope (D-6)

Understanding lane only. The execution authoring path keeps its strict refusal at `authoring.ts:755-760` unchanged, and keeps `mapProposal` as its resolution route. Gate the behavior behind `anchorPolicy: "strict" | "select"`, defaulting to `strict`, so the frozen gate semantics are untouched until a check opts in.

---

## 6. Failure taxonomy, zero partial state, restart

### New refusal codes

| Code | Raised when |
|---|---|
| `CCC_PRD_CHUNK_PLAN_INVALID` | Plan cannot be built inside the budget |
| `CCC_PRD_CHUNK_PLAN_NO_INVENTORY` | Whole-packet inventory is empty (§1) |
| `CCC_PRD_CHUNK_PLAN_DRIFT` | Resume journal's `packetHash` or `chunkPlanHash` differs from the recomputed plan |
| `CCC_PRD_CHUNK_FRAGMENT_INVALID` | Fragment shape violations, enumerated |
| `CCC_PRD_CHUNK_FOREIGN_SOURCE` | Fragment cites a path other than its chunk's |
| `CCC_PRD_CHUNK_QUOTE_OUTSIDE_SLICE` | Quote resolves in the file but not in the slice |
| `CCC_PRD_CHUNK_MATERIAL_UNDISPOSITIONED` | An assigned item is `missing` under the real scorer |
| `CCC_PRD_CHUNK_MATERIAL_CONFLICTED` | An assigned item is in `conflicts` at chunk scope |
| `CCC_PRD_CHUNK_REVIEW_BUDGET_EXCEEDED` | Running review-row total passed `maxReviewItems` mid-run |
| `CCC_PRD_CHUNK_ATTEMPTS_EXHAUSTED` | Retry budget spent on a repairable chunk |
| `CCC_PRD_ANCHOR_UNRESOLVABLE` | Extension hit the line or byte limit |
| `CCC_PRD_ANCHOR_AMBIGUOUS_INTENT` | Two or more candidates independently reached uniqueness |
| `CCC_PRD_ASSEMBLY_ID_COLLISION` | Same raw ID, contradictory scalar payload |
| `CCC_PRD_ASSEMBLY_CONFLICT` | Contradictory facts for one identity |
| `CCC_PRD_ASSEMBLY_DANGLING_REFERENCE` | A reference resolves to no assembled row after remapping |
| `CCC_PRD_UNDERSTANDING_COVERAGE_INCOMPLETE` | Assembled `missing` non-empty |
| `CCC_PRD_UNDERSTANDING_COVERAGE_CONFLICTED` | Assembled `conflicts` non-empty |
| `CCC_PRD_ROUTE_NOT_VERBATIM_CAPABLE` | Quote-bearing work on an undeclared route (§8) |

Reused unchanged: `CCC_PRD_SOURCE_QUOTE_MISSING`, `CCC_PRD_SOURCE_QUOTE_AMBIGUOUS`, `CCC_PRD_SOURCE_SPAN_FOREIGN` (`authoring.ts:742-760`), `CCC_PRD_PATH_ESCAPE` (`prd.ts:254-303`; `custody.ts:113-126`), `CCC_PRD_UNDERSTANDING_IMPLAUSIBLY_SHALLOW`, `CCC_PRD_AUTHORING_REVIEW_UNBOUNDED` (`understanding.ts:185-193`), `CCC_PRD_AUTHORING_EGRESS_POLICY_VIOLATION` (`native-authoring-adapter.ts:58-65`).

### CLI surface (finding 5)

Every flag rev 1 proposed — `--lane`, `--chunk-journal`, `--resume` — is rejected by today's parser: the six understanding flags are all mandatory (`prd.ts:349-356`) and the arg count is exact (`prd.ts:448-460`, `options.length !== generatedUnderstandingFlags.length * 2`).

**Chosen fix: an `optionalUnderstandingFlags` allowlist plus a range check.** Concretely:

- keep `generatedUnderstandingFlags` as the required set, unchanged;
- add `optionalUnderstandingFlags = ["--lane", "--chunk-journal", "--resume", "--max-chunk-attempts"]`;
- replace the exact-count test with: `options.length` is even, `≥ required.length * 2`, `≤ (required.length + optional.length) * 2`;
- every flag must be in `required ∪ optional` (the existing `.includes` rejection generalizes), no duplicates, no `--`-prefixed values — all unchanged in spirit.

Rejected alternative: making `--lane` mandatory. It would force editing the gate's six-flag invocation (`scripts/ccc-prd-product-acceptance.mjs:2348-2365`), every doc call site, and the usage string, and a mandatory flag cannot express "absent means default". The allowlist keeps unknown flags rejected, which is the property that matters.

### Zero partial state

Default (no `--chunk-journal`): every fragment stays in memory, and any refusal leaves the packet root byte-identical to its starting state. The existing custody chain is untouched (`prd.ts:254-303, 508-524, 1018-1023, 1081-1084`).

### Resume journal (D-1)

Opt-in via `--chunk-journal <path>`, and **the path must resolve inside the packet root**, under the same escape, symlink, and protected-segment rules as the review output. It needs its own resolver that shares those checks but admits its own schema tag, because `resolveAuthorOutput` only tolerates a pre-existing file when that file is a `ccc-prd.sidecar.v1` (`prd.ts:290-297`).

Living inside the root is safe: custody reads only manifest entries (`custody.ts:216-250`), so a journal can never be silently ingested as a source. It is append-only; each record carries `chunkId`, `packetHash`, `chunkPlanHash`, attempt count, and the verified fragment.

**Honest limit.** With the journal enabled, "packet root byte-identical on refusal" no longer holds — the journal is the one artifact left behind. State it plainly in the CLI help. It is a declared, schema-tagged, resumable scratch file, never product output, and never an admitted source. Without the flag the original guarantee is exact.

**Restart.** `--resume <journal>` recomputes the plan. Any `packetHash` or `chunkPlanHash` mismatch → `CCC_PRD_CHUNK_PLAN_DRIFT`, nothing reused. On a match, journaled chunks replay without a provider call — **but every replayed fragment is re-verified mechanically against live source bytes** (§3 and §5 in full). The journal is a cache, never proof, matching the campaign layer's rule that a worker's self-report is not evidence.

---

## 7. Fast-lane criteria (D-3)

Rev 1 gated the fast lane on `sources.length === 1`. That was a blocker: only `authoritative` manifest rows enter `sources`/`sourceBytes` (`custody.ts:216-250`, push at `:243-250`), and the acceptance fixture freezes **three** entries (`scripts/ccc-prd-product-acceptance.mjs:1333-1340` asserts `fileCount === 3`; the exact set at `:1342-1350`), of which the injected operator context is explicitly `authoritative === true` (`:1355-1362`). So the fixture has at least two authoritative sources, the file-count rule would have routed the frozen gate onto the chunked lane, and the one-POST assertion rev 1 claimed to preserve (`:2411-2416`) would have broken.

**Classifier: inventory-item count × byte budget. File count is never used.** A packet takes the single-shot lane when all hold, computed before any provider call:

1. total material inventory items ≤ `singleShotMaxInventoryItems` — recommend **48**;
2. total authoritative bytes across all sources ≤ `singleShotMaxBytes` — recommend **160 KiB**;
3. estimated prompt tokens + reserved output tokens ≤ the route's declared `contextWindow` (`workflow-steps.ts:195`; fallback 128000 at `custom-provider-registry.ts:103`).

This is the arithmetic that actually failed. cqe: 135,219 bytes, one file, reached 47/48 anchored quotes. cqw: 156,952 bytes, five files, **88 inventory items**, cleared shape and provenance, then failed coverage. The item count is the discriminator; bytes and context fit are the secondary guards.

`--lane auto|single|chunked`, default `auto`. `--lane single` on a packet that fails the criteria **refuses** rather than attempting a run arithmetic says cannot finish. `--lane chunked` on a qualifying packet is always allowed — chunking a small packet is slower, never wrong.

**The gate asserts the lane directly.** Emit `lane` in the CLI's JSON wrapper alongside `reviewPath` (`prd.ts:1100`), *not* in the stored artifact, so `CccPrdUnderstandingReview` and the on-disk schema are unchanged. The acceptance check asserts `understood.lane === "single"`, which is a direct statement of intent rather than an inference from POST count — POST count would silently pass if a future two-chunk plan happened to make one call.

---

## 8. Route policy hook (D3 / D-4)

### Where the declaration lives

On the provider's per-model entry. `CustomProvider.models` is already a structured per-model record (`packages/core/src/types/workflow-steps.ts:195`), and `fn provider add` already stamps per-model limits from provider-level flags (`packages/cli/src/commands/provider.ts:345, :383-386`).

- Type: `verbatimCapable?: boolean` on the model entry.
- CLI: `--verbatim-capable` on `fn provider add`, stamped onto every model of that registration exactly as `--max-tokens` / `--context-window` are, failing the same way when passed without `--model` (`provider.ts:386`).
- Semantics: **absent means unknown means not admitted** for quote-bearing work. Fail closed.

### Where it is enforced

In `createNativeCccPrdAuthoringAdapter`, alongside the existing egress assertion, which already resolves the configured provider and validates the route *before any prompt exists* (`native-authoring-adapter.ts:78-95`, invoked at `:259`). Refuse `CCC_PRD_ROUTE_NOT_VERBATIM_CAPABLE` there, before a single corpus byte is serialized. The refusal names provider and model only — never the base URL, never source text — matching the rule at `native-authoring-adapter.ts:67-77` that a refusal log must not become the leak it just prevented.

Scope: required for `mode: "understanding"` and for execution authoring, since both emit `sourceRefs`.

### The fixture must change, and "frozen" must be redefined (finding 4)

A fail-closed capability gate refuses **both** frozen native checks with zero POSTs, because they share one provider config whose model entry carries only `{id, name}` (`scripts/ccc-prd-product-acceptance.mjs:2314-2328`, used by the understanding run at `:2342` and the authoring run at `:2466`). Rev 1's promise to "keep `native-local-understanding-review` byte-for-byte" was therefore impossible.

Two explicit consequences:

1. **`configureNativeAuthoring` gains `verbatimCapable: true`** on its model entry (`:2322-2325`). This is fixture setup, and it is the correct place — the disposable loopback server does return verbatim quotes.
2. **"Frozen" is redefined as the assertions and the ledger keys, not the fixture setup.** What must not change: the understanding assertions at `:2388-2410` (schema, `executable === false`, `reviewPath`, `approvalStatus`, null target/base, all four `missingFacts` codes, stored-review agreement), the request assertions at `:2411-2416` (one POST, correct URL/model/stream/authorization), the non-compilable assertion at `:2428-2435` (`CCC_PRD_UNKNOWN_SIDECAR_SCHEMA`), the ledger key `native-local-understanding-review` and its evidence fields (`:2437-2459`), and the authoring-side equivalents at `:2504-2519`. Fixture provisioning is free to change to keep those assertions reachable.

### Why not the campaign route contract

The v3 execution route enforces an exact key set (`packages/core/src/ccc-campaign/canonical.ts:50-73`), so a new key means a v4 schema plus migration. Quote-bearing extraction happens in the authoring adapter, not in campaign route dispatch, so the provider-model declaration is sufficient and far cheaper. If per-task campaign routes ever need it, extend to v4 separately.

### Honesty (D-4, E3-flavored)

The declaration is an **operator assertion, not a measurement**. Render it as "declared verbatim-capable by operator", never as proven. The product cannot see the architecture behind an OpenAI-compatible URL, so MoE disqualification is enforced by declaration, not autodetection. Measurement is deferred until real anchor-failure data exists; when there is enough of it, a fixed probe packet whose quotes must all anchor byte-exact could upgrade the status to "measured".

---

## 9. RED tests and acceptance-gate extensions

Naming and structure follow `packages/engine/src/__tests__/ccc-prd-native-authoring.test.ts`. Proposed files: `ccc-prd-anchor-resolver.test.ts` (pure), `ccc-prd-chunk-planner.test.ts` (pure), `ccc-prd-chunked-understanding.test.ts` (fake transport, as the existing suite does at `:271-288`).

### Anchor resolver

| # | Test | Expected RED signature |
|---|---|---|
| 1 | anchors a unique quote without attempting extension | resolver absent |
| 2 | **emitted span equals the model's quote exactly, never the extended window** (offsets and `excerptSha256`) | span widened to the extension window |
| 3 | selects the correct occurrence when only one duplicate is inside the slice | `CCC_PRD_SOURCE_QUOTE_AMBIGUOUS` (`authoring.ts:755-760`) |
| 4 | refuses when both duplicates are inside one slice, naming both lines | ambiguous refusal with no candidate list |
| 5 | refuses a repeated bare identifier and lists colliding lines (`t-phase-1` fixture, ≥3 occurrences) | ambiguous refusal with no candidate list |
| 6 | resolves that identifier once the quote is the whole defining line | ambiguous refusal |
| 7 | deterministic across runs and across shuffled candidate order | resolver absent |
| 8 | refuses when extension exceeds the byte or line limit | no limit; unbounded loop |
| 9 | property: the emitted span's bytes equal `proposedQuote` byte-for-byte | resolver absent |
| 10 | execution lane keeps `anchorPolicy: "strict"` and still refuses a duplicate | extension applied in execution mode |

### Chunk planner

| # | Test | Expected RED signature |
|---|---|---|
| 11 | **union of a file's slices equals `[0, byteLength)`** (byte-partition invariant) | preamble/frontmatter bytes uncovered |
| 12 | covers bytes before the first heading | leading bytes dropped |
| 13 | covers a setext-only source (no ATX headings) | file entirely dropped |
| 14 | covers a zero-heading source | file entirely dropped |
| 15 | refuses a whole-packet empty inventory | trivially passes with zero dispositions |
| 16 | assigns every inventory item to exactly one chunk by heading-line offset | planner absent |
| 17 | **cuts at the shallowest interior heading level that fits, descending only as needed** | descends to deepest level first |
| 18 | a top-level heading with no peer (range = rest of file) does not break planning | containment invariant refuses the first cut |
| 19 | never spans two source files in one chunk | planner absent |
| 20 | falls back to line-boundary split with declared overlap when a piece has no interior heading | planner absent |
| 21 | stable `chunkPlanHash` for the same packet and policy; changes with `sliceTargetBytes` | planner absent |
| 22 | refuses when the smallest indivisible unit exceeds budget | silent truncation |

### Per-chunk verification

| # | Test | Expected RED signature |
|---|---|---|
| 23 | **a fragment emitting only requirements fails chunk coverage** (requirements alone never disposition, `material-coverage.ts:216-223`) | weak overlap check accepts it |
| 24 | a fragment emitting a task for each assigned item passes | verifier absent |
| 25 | a fragment whose unresolved decision covers an item passes (`:252-259`) | verifier absent |
| 26 | **an assigned item landing in `conflicts` refuses at chunk scope** (`:234-240`) | conflict ignored until compile |
| 27 | refuses a fragment quoting bytes outside its slice | quote resolves file-wide and is accepted |
| 28 | refuses a fragment citing another source path | accepted, or foreign-span error without chunk context |
| 29 | retries a repairable chunk once with an enumerated violation list, then refuses | transport called once; retry carries no violations |
| 30 | does not retry transport identity drift (`native-authoring-adapter.ts:289-293`) | transport called twice |
| 31 | MoE-shaped paraphrase fails on the first quote and never reaches assembly | failure surfaces only after assembly |
| 32 | running review-row total refuses mid-run at the offending chunk | refusal only after the last chunk |

### Assembly

| # | Test | Expected RED signature |
|---|---|---|
| 33 | **emitted requirement IDs are unprefixed, so `requirement.id === item.title` still dispositions** (`material-coverage.ts:217`, `:162`) | prefixed IDs; requirement dispositions drop |
| 34 | same raw ID with equal payload merges and unions `sourceRefs` | collision refusal on a legitimate repeat |
| 35 | same raw ID with contradictory payload refuses `CCC_PRD_ASSEMBLY_ID_COLLISION` | silent last-writer-wins |
| 36 | **dedupe emits a loser→winner map applied before the dangling check** | merges manufacture dangling references |
| 37 | co-located citations from overlap margins do not refuse | `CCC_PRD_ASSEMBLY_CONFLICT` on a valid review |
| 38 | order-independent: shuffled arrival yields byte-identical canonical JSON | output differs |
| 38a | **a slice-disambiguated non-unique quote survives assembly** — a fragment citing a quote that occurs twice file-wide, anchored by slice evidence, assembles and emits its span intact | `CCC_PRD_SOURCE_QUOTE_AMBIGUOUS` (`authoring.ts:755-760`) because assembly re-ran `resolveSourceRefs`/`mapProposal` |
| 39 | assembled `missing` is empty on the multi-file fixture | `CCC_PRD_UNDERSTANDING_IMPLAUSIBLY_SHALLOW` — the cqw signature |
| 40 | assembled `conflicts` non-empty refuses | reported but not refused (`understanding.ts:263-264`) |
| 41 | **assembled `materialCoverage` canonically equals a fresh analyzer run** (`compiler.ts:1381-1389`) | compile refuses a complete review |
| 42 | assembled review passes all five compile-side conditions | compile refuses |
| 43 | the shallow floor stays reachable on a deliberately under-dispositioned chunked run | floor removed |

### Zero partial state, restart, route, lane

| # | Test | Expected RED signature |
|---|---|---|
| 44 | default run writes nothing to the packet root when a middle chunk fails | chunk artifacts appear |
| 45 | journal resolves inside the packet root; an outside path refuses `CCC_PRD_PATH_ESCAPE` | arbitrary paths accepted |
| 46 | a journal file is never ingested as an admitted source (`custody.ts:216-250`) | journal read as source |
| 47 | resume with a differing `chunkPlanHash` refuses | stale fragments reused |
| 48 | replayed journal fragments are re-verified; a tampered quote refuses | tampered quote replayed as proof |
| 49 | undeclared route refuses with zero transport calls | run proceeds |
| 50 | declared verbatim-capable route is admitted | adapter refuses |
| 51 | `fn provider add --verbatim-capable` stamps every model entry; fails without `--model` | flag unknown (`provider.ts:345`) |
| 52 | **CLI accepts the six required flags with zero optional flags** (the gate's exact invocation) | range check rejects it |
| 53 | CLI accepts required plus one optional flag | exact-count check rejects it (`prd.ts:448-460`) |
| 54 | CLI still rejects an unknown flag, a duplicate, and an odd arg count | allowlist too permissive |
| 55 | **fixture-sized packet classifies `lane === "single"` and makes exactly one POST** | chunked, breaking `:2411-2416` |
| 56 | `--lane single` on a non-qualifying packet refuses | silently attempts |

### Acceptance-gate extensions

The gate is 30 frozen check IDs (`scripts/ccc-prd-product-acceptance.mjs:33-64`), and the ledger refuses extra, duplicate, missing, and skipped entries (`:70-105`), so the constant must be edited in the same commit as the capability. Proposed additions taking the gate to **36**:

| New check ID | Proves |
|---|---|
| `chunked-understanding-complete-coverage` | Chunked run over a multi-file disposable packet. Evidence: `chunkCount`, `chunkPlanHash`, `inventoryCount`, `dispositionCount`, `missingCount === 0`, **`conflictCount === 0`** |
| `chunked-understanding-compile-gates` | **(item c)** The chunked artifact is run through the compile-side coverage gates (`compiler.ts:1376-1448`) **with `requireMaterialCoverage` set**, clearing all six diagnostics across both tiers — without that flag the early return at `compiler.ts:1391` exercises only the two always-on `materialCoverage` conditions and the check passes while proving almost nothing. This check alone would have caught findings 2 and 10 |
| `chunked-understanding-anchor-selection` | The disposable packet deliberately contains one verbatim-duplicated sentence and one repeated identifier. Evidence: both anchored, candidate counts and extension steps recorded, and **every emitted span's bytes equal the model's quote** — zero widening, zero invented bytes |
| `chunked-understanding-refuses-without-residue` | One chunk forced to paraphrase. Evidence: exit 1, refusal code, packet-root directory digest unchanged (journal disabled) |
| `verbatim-capability-required-for-quote-bearing-work` | Undeclared route refuses with zero POSTs; declared route proceeds |
| `understanding-fast-lane-preserved` | The existing fixture reports `lane === "single"` and makes exactly one POST |

`native-local-understanding-review` keeps its ledger key and every assertion listed in §8; only its provider fixture gains `verbatimCapable: true`.

### Cost and timing honesty

From the two measured rates (≈23,000 tok/s cached ingest, ≈74 tok/s generation on the M5 Max), a ~6k-token slice producing a ~1.5k-token fragment costs roughly 20 seconds of generation plus a fraction of a second of ingest, putting a twenty-chunk cqw-shaped plan near 7–8 minutes serial against the ~22-minute single-shot run that refused. **That is an extrapolation from two rate measurements, not a receipt.** Per E3 the implementer reports measured wall-clock from the first real chunked run; until then the honest cost claim is "unknown".

Execution is serial per D-2. Chunks are independent and could later run in parallel, but oMLX cached-prefix behavior under interleaved requests is unmeasured, and order-independent assembly (test 38) is the precondition.

---

## Remaining measurement items

Not open design questions — the six from rev 1 are adjudicated above. These need data, and none blocks implementation.

1. **Cross-chunk disposition frequency (§3).** The conservative bias converts a cross-chunk item into an unresolved decision. How often that fires on real packets is unknown, and it directly sizes the review budget.
2. **Review-budget sizing.** The 2–4 rows per chunk guidance is inferred, not measured.
3. **Fast-lane thresholds.** 48 items and 160 KiB are fitted to three packets; re-fit after the first chunked runs.
4. **Chunked wall-clock**, per E3 above.
5. **Anchor-failure distribution** — the prerequisite for ever upgrading `verbatimCapable` from declared to measured (D-4).

---

## CHANGELOG — rev 1 → rev 2

| Finding | Severity | What changed |
|---|---|---|
| 1 | BLOCKER | §7 rewritten. File count deleted as a classifier; the fixture freezes 3 entries with ≥2 authoritative (`acceptance:1333-1362` + `custody.ts:216-250`), so `sources.length === 1` would have chunked the frozen gate. Classifier is now inventory-item count (48) × byte budget (160 KiB) × context fit. Gate asserts `lane === "single"` via a new `lane` field in the CLI JSON wrapper only (test 55, check `understanding-fast-lane-preserved`) |
| 2 | BLOCKER | §3 step 5 now runs `analyzeCccPrdMaterialCoverage` at chunk scope and requires every assigned item in `coverage` and none in `conflicts`. §3 gained "Why step 5 must call the analyzer" citing `material-coverage.ts:216-223, :243, :252, :260, :268, :277`. §4 restates the completeness claim on three checkable facts instead of "by construction". Tests 23-26 |
| 3 | BLOCKER | §4 identity rewritten per D-5. No ID rewriting; internal assembly key only; equal-payload merge; contradictory-payload refusal. Rationale cites `material-coverage.ts:217` + `:162` + `understanding.ts:212-217`. Test 33 |
| 4 | BLOCKER | §8 gained "The fixture must change, and 'frozen' must be redefined": `configureNativeAuthoring` (`acceptance:2314-2328`) gains `verbatimCapable: true`; frozen now means the assertions at `:2388-2410`, `:2411-2416`, `:2428-2435`, `:2504-2519` plus ledger keys, not fixture setup |
| 5 | BLOCKER | §6 gained a CLI-surface subsection choosing `optionalUnderstandingFlags` + range check over mandatory `--lane`, with the rejected alternative and its cost stated. Tests 52-54 |
| 6 | MAJOR | §2 replaced the "byte-identical" claim with an enumerated edit table: schema at `:118` and `:137`, five singleton keys at `:148-151` and `:155`, required-arrays line `:127`, coverage line `:126`, and `orderedSources` `:158-165` → chunk envelope |
| 7 | MAJOR | §2 gained the instruction-block table: drop `:108-110` only; `:111` (anti-invention) kept in every chunk prompt, with its double role — honesty and coverage via `:252-259` — stated |
| 8 | MAJOR | §5 rewritten around the adopted mechanism: **extension selects an offset, never widens the emitted span**. One span, always the model's own quote, `excerptSha256` over that quote, extended window in the receipt only. Coverage math (`material-coverage.ts:182-186`) can no longer see unread bytes. Tests 2, 9 |
| 9 | MAJOR | §1 deleted containment as a normal-case invariant (false when `coverageEnd = byteLength`, `:124-126`) and inverted the split rule: cut at the shallowest interior heading level that fits, descending only as needed. Tests 17-18 |
| 10 | MAJOR | §0 corrected from two codes to **five conditions / six diagnostics** (`compiler.ts:1376-1448`). §4 gates `conflicts` on the chunked path (`CCC_PRD_UNDERSTANDING_COVERAGE_CONFLICTED`) and requires `materialCoverage` built via `authoring.ts:1036-1045`. `conflictCount === 0` added to the coverage check evidence. Tests 40-42 |
| 11 | MAJOR | §4 gained "Review-item budget": bound applies to the assembled total, checked as a running total after each chunk, `CCC_PRD_CHUNK_REVIEW_BUDGET_EXCEEDED` at the offending chunk, sizing guidance of 2-4 rows per chunk. Test 32 |
| 12 | MAJOR | §4 dedupe now emits a loser→winner ID map applied before the dangling check; `CCC_PRD_ASSEMBLY_CONFLICT` narrowed to contradictory scalar facts, not co-located citations. Tests 36-37 |
| 13 | MINOR | §1 leads with the byte-partition invariant (union of slices = `[0, byteLength)`); inventory picks cut points only. Blind spots named: ATX-only (`:98, :142`), fenced skips (`:97, :141`), ranges start at the first heading (`:134`). `CCC_PRD_CHUNK_PLAN_NO_INVENTORY` added. Tests 11-15 |
| 14 | MAJOR | §5 gained "The chunked lane replaces `resolveSourceRefs`; it never re-runs it": selection legitimately emits spans for non-file-unique quotes, which `resolveSourceRefs` refuses (`authoring.ts:755-760`) and which `mapProposal` (`:784`, invoked at `:910`) would hit for every row. The chunked lane builds spans once at §3 step 4 and assembly consumes them as final, reusing `sortCccPrdById`/`compareSourceSpans`/`normalizeProtectedAction` but not the resolution step; rows carry spans, not `sourceRefs`, converted as `withoutSourceRefs` does at `:773-782`. §4 ordering paragraph corrected to stop modelling assembly on `mapProposal`. §5 Scope notes the execution lane keeps `mapProposal`. New test 38a |
| 15 | MINOR | §0 reworded from "five coverage conditions" to "six diagnostics across two gating tiers", table gained a Tier column, and the early return at `compiler.ts:1391` is named as the boundary: `:1376-1389` always run, `:1406-1448` only under `requireMaterialCoverage`. The `chunked-understanding-compile-gates` check now specifies that flag, since without it the check would exercise two of six diagnostics and report a false pass |
| (a) | — | Evidence base re-pinned to HEAD `1efd1071a`; all twelve `authoring.ts` citations shifted −15 and re-verified individually |
| (b) | — | The constraints citation is now the whole block `authoring.ts:861-898` with sub-ranges for target drift `:866-874`, bounds drift `:875-883`, review count `:884-897` |
| (c) | — | New acceptance check `chunked-understanding-compile-gates` runs the chunked artifact through `compiler.ts:1376-1448` |
| D-1…D-6 | — | Rev 1's six open questions replaced by the adjudicated decision table at the top and applied throughout: journal inside the packet root (§6), serial execution (§9), item×byte classifier (§7), declared capability (§8), no token rewriting (§4), strict execution lane (§5) |

## CHANGELOG — implementation phase (PR #18, agent/phase1-chunked-understanding)

| Item | What changed |
|---|---|
| IMPL-1 | §5 anchor resolver, §1 chunk planner, §2/§3 per-chunk request/verification, §4 assembly, §7 lane classifier, §8 verbatimCapable (declare + enforce), the end-to-end orchestrator wiring the four pure modules to real custody/transport, and §6 CLI surface (`--lane`, `--max-chunk-attempts`) are implemented and green. `--chunk-journal`/`--resume` are named in the allowlist but explicitly refused as not-yet-implemented rather than silently accepted. Tests 1-32, 33-41 (+36b), 42-43, 49-56 pass. |
| IMPL-2 | Acceptance gate extended from 30 to 33 checks: `understanding-fast-lane-preserved`, `chunked-understanding-complete-coverage`, `chunked-understanding-compile-gates`. Full gate run (disposable PostgreSQL 16) passes, one-POST assertion on `native-local-understanding-review` holds. |
| IMPL-3 | **Deferred to a fast-follow PR** (operator ruling, since D-1's resume journal is opt-in — nothing ships broken without it): test 44 (default run writes nothing to the packet root when a middle chunk fails) and tests 45-48 (resume journal: path-escape refusal, journal never ingested as a source, stale `chunkPlanHash` refusal, tampered-quote re-verification on replay). Correspondingly, acceptance checks `chunked-understanding-refuses-without-residue` and `verbatim-capability-required-for-quote-bearing-work` are not yet added to the gate (33/36, not 36/36). |
| IMPL-4 | Design self-contradiction found and resolved: §2 explicitly (twice, with rationale) removes `confidence`/`nonGoals` from the fragment schema; §4's "nonGoals is the deduped union of fragment-supplied non-goals; packet confidence is the minimum across fragments" requires fields §2 says fragments don't carry. Resolved in favor of §2 (more detailed, stated twice): both are synthesized as fixed packet-global defaults (`nonGoals: []`, `confidence: "low"`), never read from any fragment. |
