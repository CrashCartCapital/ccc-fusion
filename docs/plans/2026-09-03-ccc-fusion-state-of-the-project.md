# CCC-Fusion — State of the Project, 2026-09-03

Snapshot taken at `main` = `c3849a2a9` (in sync with `origin/main`, 0 ahead / 0 behind). This is an assessment, not a plan. The execution plan is a separate document once its open decisions are settled.

Every claim below is either directly observed this session or attributed to the document that carries it. Where something is inferred rather than observed, it says so.

---

## 1. What this project actually is

`ccc-fusion` is Ryan's fork of `Runfusion/Fusion` — a Trello-shaped multi-agent AI coding task board. The fork exists to add one thing: a lane that turns a reviewed PRD document into a proof-gated, dependency-driven coding campaign.

The scale split matters for every decision downstream:

| | Files (.ts/.tsx) | LOC |
|---|---|---|
| Whole repo | ~4,387 | ~1.68M |
| CCC-specific (`ccc-*` named) | ~170 | ~91K (5.4%) |

CCC is a thin, deep vertical slice bolted onto a large inherited horizontal platform. It lives almost entirely in two packages:

- `packages/engine` — 124 CCC files, ~68.7K LOC (`ccc-campaign-*.ts` runtime, `ccc-prd/` compiler chain)
- `packages/core` — 37 CCC files, ~20.7K LOC (`ccc-prd/` importer/admission/custody, `ccc-campaign/` types/stores)
- `packages/cli` — 7 files, ~1.3K LOC
- `packages/dashboard` — **2 files, ~378 LOC** (one route *guard*, plus its test)

Storage is PostgreSQL only. CCC adds 7 migrations at the tip of the shared chain (`0034_ccc_effect_receipts` … `0040_ccc_campaign_semantic_proof_v2`), applied through the same generic applier as everything else.

Divergence from upstream was measured at `upstream/main...origin/main = 1928 / 304` in the 2026-08-29 audit. This is a permanent fork, not a tracking branch.

---

## 2. Where it stands — the honest proof ladder

The project's own vocabulary (written → in code → tests pass → committed → pushed → merged → installed → running → **proved in real use**) is the right frame. Here is where each capability sits.

### Proved in real use

**Gate 1 — worker loop.** A single small task given to a real model produces the intended edit, one attributable commit, admitted proof, and an honest terminal result. Proven August.

**Gate 2 — whole-product acceptance.** Proven 2026-09-02, PR #56, commit `27b29351d`, evidence at `docs/plans/evidence/2026-09-02-ccc-gate2-installed-live-acceptance.md`. This is the largest single result the project has:

- One frozen, **installed** candidate (`@runfusion/fusion 0.73.0-beta.4`) ran a 6-task DAG end to end from normal PRD entry.
- Real peer routing across three live models — GLM-5.3, MiniMax-M3, Gemini 3.8 Flash — through OmniRoute. **385/385 provider attempts committed, zero dispatched-unknown, zero off-allowlist routes.**
- Safe fanout/join: three disjoint-scope tasks overlapped, then joined into a single integrating commit.
- 7/7 semantic proof groups, 6/6 external usefulness cases.
- Restart continuity from a durable approval hold with no repeated effects; quiet pause → one resume → terminal stop.
- Stale-authority refusal recorded, then exactly one fresh controlled landing.
- All artifacts hash-bound: tarball, `fn`, controller, runtime host SHA-256s match the receipt with no drift.

That answers the question the whole project was stuck on for months. **The machine works.**

### Present in code and tested, not proved in real use

- Intake → freeze → understanding/extraction → authoring proposal → DAG compile. Modular and real, with real-PG and real-git test coverage.
- Reservation/settlement custody: one Postgres transaction per dispatch attempt that re-compares git observation against locked custody, consumes an operator-issued approval, and holds a work-item lease.
- Proof admission/execution/sandbox/host pipeline gating merge.

### Written as a target, not built

These are the gaps between today and the product contract.

---

## 3. The five real gaps

### G1 — Operator experience is effectively zero *(biggest gap)*

The product contract and vault PRD v0.3 both say **dashboard-first**. Ryan should see: what is running, what is blocked, what changed, what proved green, what failed and why, what needs his decision, and exact local commit/delivery state.

Observed: the React app (`packages/dashboard/app`, 783 `.tsx` files) contains **zero** CCC surface. A grep for "ccc" across the whole app returns one incidental CSS match. The only CCC code in the dashboard package is `routes/ccc-campaign-task-guard.ts` — a guard that *refuses* mutation of campaign tasks.

CCC is operated entirely through `fn prd {corpus, discover, freeze, preview, import, author, status, pause, resume, stop, abandon}`, implemented in a single 3,636-line `packages/cli/src/commands/prd.ts`. There is no CCC section in `docs/getting-started.md`.

Consequence: building operator visibility means building from near-zero, not extending. And today Ryan cannot run a campaign without reading plan documents.

### G2 — No remote delivery lane

`ccc-campaign-git-landing.ts` (1,320 lines) performs a compare-and-swap git ref update into a **local** target repository, gated by final-proof custody and task-commit ancestry. Grep for push / remote / origin / `gh pr` / pull request / github across that file and `ccc-campaign-merge-control.ts`: **zero hits.**

The product contract's "dedicated terminal delivery agent" that rechecks target branch, remote head, required checks, stale approvals, protected-branch rules, and the unconsumed authority receipt before any remote mutation — does not exist. Gate 2's "controlled landing" was into a local bare remote, which is correct for a proof and insufficient for use.

### G3 — Capacity is authorized but structurally unenforced

`maxConcurrency` is validated when the execution authorization is created (`core/src/ccc-campaign/execution-authorization.ts`) and read back exactly once for a consistency check (`engine/src/ccc-campaign-product-control.ts:560`). The actual work-claim path, `engine/src/workflow-work-scheduler.ts`, contains no reference to concurrency or any counter. There is no write-root lease pool and no capacity ramp.

So "maximal safe parallelism, constrained empirically" is currently: whatever a generic single-item work-claim scheduler happens to produce. The number is declared and then nobody reads it.

### G4 — CI tells a less honest story than it looks

The **merge-blocking** bar — Lint, Typecheck, Build, Gate — is green on every recent branch. That part is solid.

The two richer signals are both red:

**CCC PRD Product Acceptance has never been green in CI.** Four runs since the workflow was created 2026-08-03; all four failed. The flagship 39-check whole-product proof has zero CI evidence and passes only on Ryan's Mac.

Root cause traced this session, and it is small: CI installs the go-task CLI as an npm package (`npm install -g @go-task/cli@3.52.0`), whose `bin/task` resolves to a JavaScript launcher, `.../node_modules/@go-task/cli/run-task.js`. The semantic-proof custody sealer (`packages/core/src/ccc-prd/semantic-proof-custody.ts:368`) copies the resolved executable to a sealed path and execs it directly to capture `--version`. A `.js` file is not directly executable, so the probe throws and the run refuses with `CCC_PRD_SEMANTIC_PROOF_CUSTODY_REFUSED`. Locally `task` is `/Users/ryanpappal/go/bin/task`, a real Mach-O arm64 binary, so the same code path passes. The gate is not wrong — the CI toolchain shape is.

**Full Suite is red on the last four consecutive pushes to main.** The latest (run 33798716516) fails across test shards 1/4, 2/4, 4/4 *and* "Product route + engine slow" together. The product-route failures are in CCC's own acceptance tests:

- `ccc-native-cli-public-route.real-pg.test.ts` — campaign-global request exhaustion parking; persisted route lease + restart settlement; two crash-cut rehydration cases
- `ccc-prd-product-vertical-slice.real-pg.test.ts` — duplicate-intent and multi-task refusal residue; the full frozen-packet → admission → coding → proof → landing case (`expected { exitCode: 1 } to match { exitCode: 0 }`)

Both workflows are marked non-blocking, which is why this has persisted.

### G5 — Route-receipt settlement is not repeatable

Recorded in `docs/plans/2026-08-30-ccc-golden-execution-findings.md` and not fixed: an identical Pi replay of a golden-campaign task failed pre-mutation because request #3 omitted the terminal SSE route receipt, correctly downgrading to `dispatched_unknown` / uncertain-effect recovery. This is consistent with the known OmniRoute behavior where uncached calls commit response headers before an upstream is chosen, so the route arrives only as trailing SSE comments. Named as the next action in that document; still open.

---

## 4. Secondary findings

**Unlanded value.** Two draft PRs carry finished, unreviewed features: **#50** `codex/pr-model-admission-platform` (~3,287 additions, deterministic model-admission evaluator + capability profile + telemetry) and **#49** `codex/pr-oss-base-admission` (~2,252 additions, open-source-reuse admission contract). Both are DRAFT, blocked, with no checks ever run. Separately, `agent/phase1-chunked-understanding` (tip `5c3fe2949`, 46 commits ahead) carries the quote-drift repair chain that fixes fuzzy-match recovery — the single-shot quote resolver still cannot fuzzy-match at all while the chunked lane can.

**Custody debt.** 70 registered worktrees, ~86 local branches. Roughly 35 branches are prunable outright (their only unique commits are repeated "install generated instruction roots"). Three worktrees carry real uncommitted work: `pr18-a612-reproduction` (34 files), `scaleup-w0-w3t2-w1` (11), `wave-5-integration` (4). `wave-3` remains revoked and was not accessed.

**Stale runtime.** The live server on port 4040 has been up ~9.8 days running `packages/cli/dist/bin.js` from the `r1-qe-runner` worktree — a build from before six merged PRs. There is no global `fn` on PATH. So the thing Ryan can actually reach is not the product.

**Architecture risk.** `packages/engine/src/executor.ts` is 23,422 lines and contains **573 CCC references**. It is simultaneously the largest file, the highest-traffic dispatch point, and deeply CCC-aware. The repo tracks this honestly — `scripts/check-file-line-count.mjs` enforces a 2,000-line cap on new files against a ratchet baseline that currently grandfathers 106 existing files. Separately, `core/src/postgres/data-layer.ts` imports CCC campaign types directly, so a low-level persistence module knows about campaign domain concepts.

**Doc and vault drift.** The vault's portfolio row (2026-08-24) and status note (2026-08-25, self-reporting a 245-commit-behind checkout) predate Gate 2 entirely. The vault still describes the system as "a real, carefully built, **serial** PRD-to-campaign pipeline… not yet the parallel software factory PRD v0.3 describes" — which was true on 2026-08-11 and is no longer accurate. An older generation of `FN-####` audit docs (April–July) is a stale backlog whose line numbers have drifted; treat as themes to spot-check, not facts.

---

## 5. Reframing: what "done" means from here

Gate 1 asked *can one worker do one task?* Gate 2 asked *can the whole product run a campaign?* Both are answered.

The remaining question is different in kind:

> **Gate 3 — can Ryan feed it one of his own real PRDs, watch it work, understand what happened, and get the result into a pull request — without reading plan documents or source code?**

Gate 2 proved the engine on a synthetic target (`gate2-telemetry-service`) with a purpose-built packet. Gate 3 is real-use proof: Ryan's PRD, Ryan's repo, Ryan's eyes on a screen, output landing somewhere he can review.

Everything in §3 is a prerequisite for Gate 3, and nothing outside §3 is.

---

## 6. Constraints that shape any plan

**CI throughput caps parallelism.** All PR jobs run on the M2 Max behind a global three-slot admission queue shared across four repos. A PR costs ~11–15 minutes wall clock. Beyond roughly three concurrent PRs, added agents produce queue, not throughput. This is a measured number, not a guess.

**`executor.ts` is the write chokepoint.** Any lane that hooks campaign execution flow touches the same 23K-line file. Parallel lanes must be partitioned so at most one owns it at a time.

**Worker compute policy is fixed.** Routine CCC workers are OmniRoute MiniMax M3 and GLM 5.2/5.3. Codex is last-resort escalation. Direct Anthropic Claude Code is explicitly not a CCC worker lane. (This governs the *product's* workers, not the agents developing the product.)

**Proof-state vocabulary must never collapse.** Tested is not installed. Installed is not proved in real use. The project's credibility rests on this distinction being maintained in every report.

---

## 7. Open decisions

These change the shape of the work and are the operator's to make.

1. **Sequencing.** Build the operator surface first (G1), or force one real-repo campaign through the CLI first and let its pain define the screens?
2. **Delivery scope.** Full automated push/PR/merge with drift refusal (G2 as written), or stop at "branch is landed locally and green — Ryan runs one `gh pr create`"?
3. **Draft PRs #49/#50.** Adopt and land ~5.5K lines of unreviewed model/OSS admission work, or close them as out-of-scope for Gate 3?
