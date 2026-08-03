# ccc-fusion PRD v0.2 — successor proposal (draft, lives outside the vault)

**Status:** proposal only. The vault original (`PRJ-AI-ccc-fusion-PRD-v0.1.md`) is untouched and stays human-authoritative. This document exists because the product's own intake refuses v0.1, and repairing that requires operator decisions that only Ryan can make. Nothing here changes the vault; approving it is a separate explicit act.

**Provenance of this proposal:** built on 2026-08-02 under the operator-approved option (b) from `docs/plans/2026-07-30-ccc-fusion-prd-product-vertical-slice.md` — read exactly the two archived authority notes so a successor proposal can be built without changing the original. Exactly two archive files were read, nothing else:

| Archived authority note | SHA-256 |
| --- | --- |
| `00_MAIN/02_Inbox/_archive/REF-HUM-OrchestratorForkSecondOpinion-2026-07-23.md` | `3f51af16267bcb9d87ade1c750842c3fc61bda0457b3f6ed2a01d21bc72ceb9d` |
| `00_MAIN/02_Inbox/_archive/REF-HUM-MultiProviderAgentOrchestratorLandscape-2026-07-22.md` | `0d343089c2da4429a780654847f06e18f57c6ce5be700260effd975eee1c9ddb` |

## Why v0.1 cannot enter the product today

Reproduced fresh on 2026-08-02 against merged main (`5a23315fc`):

1. **Authority refusal (hard block).** `fn prd freeze` refuses with `CCC_PRD_DECLARED_AUTHORITY_MISSING`: v0.1's Source Authority section declares `[[REF-HUM-OrchestratorForkSecondOpinion-2026-07-23]]` and `[[REF-HUM-MultiProviderAgentOrchestratorLandscape-2026-07-22]]` as load-bearing authority, but no non-archive Markdown file resolves those names. The product is deliberately forbidden from reading archives, so it fails closed. No output directory, no partial state.
2. **Intake-contract gaps (lint findings, not blocks).** v0.1 does not machine-declare the target repository, an exact 40-hex baseline, allowed write roots, or exact executable proof. The freeze context flags (`--target/--base/--owned-path/--write-root/--write-purpose/--max-*` or `--context-stdin`) can supply these as an operator sidecar without editing the PRD.
3. **Stale facts.** v0.1 pins `42fe154abe…` (the pre-conversion Fusion baseline) and describes delivery state as of 2026-07-27 (Tasks 9–10 active on `agent/ccc-fusion-task4-preprovider`). Reality as of 2026-08-03: the M1 multi-task product and the Stage 6 operator experience are merged to `main` (PR #14 `84d045a93`, PR #15 `5a23315fc`), and the acceptance bar is the 30-check `pnpm verify:ccc-prd-product`.

## What the two archived notes actually establish (read 2026-08-02)

These summaries exist so the successor can carry authority **inline** and the archive can stay archived.

**Landscape note (2026-07-22).** A frozen requirement contract and field survey — 79 candidates, 41 repos source-audited, 15 finalists — concluding that **no turnkey product** meets the ten-layer bar (auth reuse, exact model invocation, streaming+cancel, tool loop, MCP, per-agent routing, session continuity, delegation, parallelism, operations). It recommends composing a small Dagu–Omnigent spine and supplies the HR-01…HR-19 acceptance ladder, the exactly-one-owner table, the disable-auto-merge posture, and sourced rejection reasons for every major alternative (Paperclip's shared-checkout races #9447/#9460/#9898; Omnigent's wrong-worktree/child-resume defects; Harness's provider layer; etc.). **It never names Fusion** — it must not be cited as the document that chose Fusion.

**Second-opinion note (2026-07-23).** One day later, a five-lane read-only re-survey surfaced Runfusion/Fusion (MIT, v0.72.0) and verified at source level that it already ships the combination every earlier candidate only partially had: native Claude Code and Codex adapters reusing logged-in subscriptions, a generic OpenAI-compatible lane, per-task git worktrees by default, a durable dependency graph with restart recovery, and a review-and-merge pipeline with recorded human approval (`autoMerge:false`). Verdict: **fork Fusion**, build the one missing piece (a PRD-intake compiler), and verify four acceptance items in a disposable checkout — do not fork Paperclip, do not take on Omnigent's three-subsystem build. Stated uncertainty: Fusion's ~3-month maturity and single-vendor risk, with named conditions that would flip the verdict.

Read together: the landscape note supplies the *requirement contract and the rejections*; the second opinion supplies the *fork decision*. Both decisions were subsequently validated by the conversion itself (the purchase-gate audit confirmed the second opinion's own caveats: the SQLite claim was stale — it is PostgreSQL — Codex was not subscription-only, and the generic adapter was not suitable transport; all were converted into CF-requirements and have since been enforced in code).

## The decision Ryan needs to make (one of three)

**Option A — approve a v0.2 successor PRD (recommended).** A new `PRJ-AI-ccc-fusion-PRD-v0.2.md` in the vault that: carries the authority content inline exactly as the section above does (with the two SHA-256 receipts), cites the archived notes as historical provenance in prose rather than load-bearing wikilinks, machine-declares the intake facts below, and refreshes the delivery-state narrative. The archive stays untouched; freeze then passes on authority; the intake sidecar becomes optional rather than compensatory.

**Option B — un-archive the two notes.** Move (or copy) both notes back to a non-archive vault location so v0.1's wikilinks resolve. One exact vault change, Ryan-gated; v0.1's stale facts and missing intake declarations would still need the freeze context flags every time.

**Option C — supply context-only.** Keep v0.1 as-is and always drive freeze with `--context-stdin`/flags. This never fixes the authority refusal — the product would still refuse the packet — so C alone is not viable; it is listed for completeness.

## Ready-to-paste machine intake block (for v0.2 or `--context-stdin`)

- Target repository: `CrashCartCapital/ccc-fusion` (local primary checkout `/Users/ryanpappal/03_CODE/ccc-fusion`)
- Exact baseline: `5a23315fc88ff1e4118d72a019b6a8ae867e1ef8` (main, PR #15 merge) — refresh at freeze time
- Allowed write roots: repository worktrees under `.worktrees/` (or the established `ccc-fusion-worktrees/` sibling), never the vault, never the primary checkout's working tree
- Exact executable proof: `pnpm verify:ccc-prd-product` (30 checks, disposable PostgreSQL 16), plus the per-package suites CI runs on the `ccc-fusion-bwrap` lane
- Bounds: to be set by Ryan at freeze (`--max-requests`, `--max-duration-ms`, `--max-concurrency`); the product refuses unbounded values by design

## What v0.2 keeps unchanged from v0.1

The product goal, principles 1–7, CF-001 through CF-020 as the requirement contract (with CF-008 already in its sidecar-era form), the non-goals, the protected-action and operator-gate posture, and the rule that live provider calls, billing, credentials, push, merge, release, and `main` mutation each require fresh explicit authority. The delivery-state and authority sections are the only structural rewrites.

## Wrap-up for the reviewer

**Doing:** make ccc-fusion's own PRD admissible to the product it specifies. **Just did:** reproduced both refusal and lint gaps on merged main, read the two approved archived notes (hashes above), and reduced the fix to one decision with a recommended option. **Next:** Ryan picks A, B, or C; if A, the v0.2 draft is assembled from v0.1 plus the sections above and enters the vault only on his approval.
