/**
 * Regression suite for loose quote matching with true-source substitution
 * (wave 6).
 *
 * Two full corpus runs established that the authoring model never invents
 * quotes -- it copies real source sentences and drifts by a handful of bytes
 * (case, indentation, markdown emphasis, verb tense, a swallowed table pipe,
 * or a mid-sentence elision). Byte-exact containment then rejects the whole
 * chunk, and the run dies at CCC_PRD_CHUNK_ATTEMPTS_EXHAUSTED.
 *
 * Every positive fixture below is a REAL observed failure, extracted
 * programmatically from the harness evidence in
 * `.smoke-scratch/wave4/corpus/evidence/*.json` and re-proven against the
 * frozen source document it came from. The provenance record -- packet,
 * evidence file, source line, how the true text was recovered, and how many
 * rows each drift was observed on -- lives in
 * `.smoke-scratch/wave6/quote-failure-fixtures.json`. That corpus is
 * untracked, so each fixture carries a verbatim window of its real source
 * document here and this suite stays self-contained.
 *
 * THIS FILE IS GENERATED. It is `test-header.ts.txt` + `fixtures.embed.ts.txt`
 * + `test-footer.ts.txt`, concatenated by
 * `.smoke-scratch/wave6/assemble-test.mjs`. The fixture block in the middle is
 * emitted by `.smoke-scratch/wave6/build-fixtures.mjs`. Edit those inputs and
 * re-assemble; do not hand-edit this file.
 *
 * WHAT IS ASSERTED, AND WHY IT IS PHRASED THIS WAY
 *
 * There is no "stored quote" to compare against. `CccPrdSourceSpan`
 * (core/src/ccc-prd/types.ts:14-29) carries byte coordinates and hashes, never
 * quote text; both lanes destructure `sourceRefs` away at the
 * sourceRefs -> spans boundary (chunk-verification.ts:135, authoring.ts:779).
 * The real invariant is therefore positional:
 *
 *   (a) the resolver returns a span instead of rejecting; and
 *   (b) slicing the source at the resolved coordinates yields the TRUE source
 *       text, never the model's drifted version -- this is the heart of it; and
 *   (c) the excerpt hash the compiler re-derives from those coordinates
 *       (compiler.ts:409) matches sha256(trueSourceText), so the span does not
 *       go CCC_PRD_SOURCE_SPAN_STALE.
 *
 * (c) exists to pin the two halves together. Loosening the match WITHOUT
 * substituting would leave `byteEnd` and `excerptSha256` derived from the
 * model's bytes (anchor-resolver.ts:161-162), and compiler.ts:410 would start
 * firing CCC_PRD_SOURCE_SPAN_STALE. A future change cannot ship one half
 * without the other while (c) holds.
 *
 * NOT EVERY FIXTURE RECOVERS, AND THAT IS THE MEASURED ANSWER
 *
 * This suite was first written expecting all 19 fixtures to resolve. Two things
 * measured afterwards say otherwise, and the assertions below now follow the
 * measurements rather than the original hope:
 *
 *   1. Fuzzy matching (tier 2) ships OFF. `DEFAULT_CCC_PRD_QUOTE_MATCH_POLICY`
 *      is `{allowFuzzy: false}` because a meaning-INVERTING one-word edit
 *      scores 0.9747 while the innocent word-substitution drift tier 2 exists
 *      to accept scores 0.9449 -- the populations interleave and no threshold
 *      separates them (locator-report.md, POPULATIONS_SEPARABLE=NO). So the two
 *      fixtures that need tier 2 are asserted TWICE: refused under the shipping
 *      default, recovered under an explicit test-local `{allowFuzzy: true}`.
 *      Nothing here turns fuzzy on in production.
 *
 *   2. The ~135-character elision is unrecoverable at ANY threshold, and this
 *      is structural rather than a tuning miss. Tier 2 is a minimum-distance
 *      sliding window; spanning the elided middle costs ~135 insertions, so the
 *      minimum-distance window is always a FRAGMENT of the tail, never the
 *      spliced whole. Lowering the threshold does not recover the true span --
 *      it admits a wrong one. The elision tests below prove exactly that, so a
 *      later session cannot "fix" this fixture by loosening a number.
 *
 * The fixture's `failureClass` decides which of the three dispositions applies;
 * the mapping is measured, sourced, and guarded by its own test.
 *
 * LANES. The chunked and single-shot lanes have fully independent resolvers
 * and are not fixed by one change. These tests drive the chunked lane's
 * `resolveCccPrdAnchor` -> `buildSpan` (anchor-resolver.ts:154-164), which is
 * where substitution belongs. Each fixture records the lane that observed it;
 * the drift classes themselves are lane-independent. The single-shot resolver
 * (`resolveSourceRefs`, authoring.ts:718-773) is not exported and has no test
 * seam below `authorCccPrdPacket` -- see red-phase.md.
 *
 * The chunk containment gate (chunk-verification.ts:116) gets secondary tests
 * only. It yields a boolean and a violation string, never an offset, and its
 * result is discarded, so no substitution can happen there -- but it must still
 * be relaxed or it refuses before the resolver ever runs.
 */
import { createHash } from "node:crypto";
import { CCC_PRD_AUTHORING_PROPOSAL_FRAGMENT_SCHEMA_VERSION } from "@fusion/core";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_CCC_PRD_QUOTE_MATCH_POLICY,
  resolveCccPrdAnchor,
  type CccPrdQuoteMatchPolicy,
} from "../ccc-prd/anchor-resolver.js";
import { IDENTITY_COLLECTIONS } from "../ccc-prd/authoring.js";
import { describeCccPrdChunkQuoteOutsideSliceViolations } from "../ccc-prd/chunk-verification.js";
import { CccPrdCustodyError } from "../ccc-prd/custody.js";

type QuoteDriftFailureClass =
  | "case"
  | "whitespace"
  | "emphasis"
  | "tense"
  | "punctuation"
  | "elision"
  | "other";

type QuoteDriftFixture = {
  id: string;
  sourceDocument: string;
  /** Which lane's resolver observed this drift. The two lanes do not share code. */
  lane: "chunked" | "single-shot";
  chunkIndex: number | null;
  failureClass: QuoteDriftFailureClass;
  /** UTF-8 byte-level edit distance between `modelQuote` and `trueSourceText`. */
  byteDelta: number;
  /** Exact bytes the model returned, as recorded by the harness. */
  modelQuote: string;
  /** Exact bytes that really occur in the source document. */
  trueSourceText: string;
  /** Verbatim window of the real frozen source document containing `trueSourceText`. */
  sourceExcerpt: string;
};

const QUOTE_DRIFT_FIXTURES: QuoteDriftFixture[] = [
  {
    id: "agentic-trade-management-01-case",
    sourceDocument: "v0.8.x/PRODPRD-atm-v0.8.4.md",
    lane: "chunked",
    chunkIndex: 0,
    failureClass: "case",
    byteDelta: 6,
    modelQuote: "Type: prj\nDomain: ccc\nStatus: draft\nDate_created: 2026-07-03\nDate_modified: 2026-07-11\nVersion: 0.8.4",
    trueSourceText: "type: prj\ndomain: ccc\nstatus: draft\ndate_created: 2026-07-03\ndate_modified: 2026-07-11\nversion: 0.8.4",
    sourceExcerpt: "---\ntype: prj\ndomain: ccc\nstatus: draft\ndate_created: 2026-07-03\ndate_modified: 2026-07-11\nversion: 0.8.4\naliases:\n",
  },
  {
    id: "agentic-trade-management-02-whitespace",
    sourceDocument: "v0.8.x/PRODPRD-atm-v0.8.4.md",
    lane: "chunked",
    chunkIndex: 0,
    failureClass: "whitespace",
    byteDelta: 3,
    modelQuote: "Aliases:\n - Agentic Trade Management PRD v0.8.4\n - ATM PRD v0.8.4",
    trueSourceText: "aliases:\n  - Agentic Trade Management PRD v0.8.4\n  - ATM PRD v0.8.4",
    sourceExcerpt: "version: 0.8.4\naliases:\n  - Agentic Trade Management PRD v0.8.4\n  - ATM PRD v0.8.4\ntags:\n",
  },
  {
    id: "agentic-trade-management-03-whitespace",
    sourceDocument: "v0.8.x/PRODPRD-atm-v0.8.4.md",
    lane: "chunked",
    chunkIndex: 0,
    failureClass: "whitespace",
    byteDelta: 5,
    modelQuote: "Tags:\n - trading\n - trade-management\n - agentic-trade-management\n - prd",
    trueSourceText: "tags:\n  - trading\n  - trade-management\n  - agentic-trade-management\n  - prd",
    sourceExcerpt: "  - ATM PRD v0.8.4\ntags:\n  - trading\n  - trade-management\n  - agentic-trade-management\n  - prd\nbrainstorm_status: complete\n",
  },
  {
    id: "agentic-trade-management-04-case",
    sourceDocument: "v0.8.x/PRODPRD-atm-v0.8.4.md",
    lane: "chunked",
    chunkIndex: 0,
    failureClass: "case",
    byteDelta: 2,
    modelQuote: "Source_prd: \"[[PRODPRD-atm-v0.8.3]]\"\nSupersedes: \"[[PRODPRD-atm-v0.8.3]]\"",
    trueSourceText: "source_prd: \"[[PRODPRD-atm-v0.8.3]]\"\nsupersedes: \"[[PRODPRD-atm-v0.8.3]]\"",
    sourceExcerpt: "brainstorm_topic: agentic trade management PRD\nsource_prd: \"[[PRODPRD-atm-v0.8.3]]\"\nsupersedes: \"[[PRODPRD-atm-v0.8.3]]\"\nsource_change_plan: \"[[REF-AI-AgenticTradeManagement-PRD-ChangePlan-to-v0.8.4-ATM-20260710-C01-R7]]\"\n",
  },
  {
    id: "agentic-trade-management-05-case",
    sourceDocument: "v0.8.x/PRODPRD-atm-v0.8.4.md",
    lane: "chunked",
    chunkIndex: 0,
    failureClass: "case",
    byteDelta: 1,
    modelQuote: "Source_change_plan: \"[[REF-AI-AgenticTradeManagement-PRD-ChangePlan-to-v0.8.4-ATM-20260710-C01-R7]]\"",
    trueSourceText: "source_change_plan: \"[[REF-AI-AgenticTradeManagement-PRD-ChangePlan-to-v0.8.4-ATM-20260710-C01-R7]]\"",
    sourceExcerpt: "supersedes: \"[[PRODPRD-atm-v0.8.3]]\"\nsource_change_plan: \"[[REF-AI-AgenticTradeManagement-PRD-ChangePlan-to-v0.8.4-ATM-20260710-C01-R7]]\"\nsource_architecture_closure: \"[[REF-AI-AgenticTradeManagement-TechnicalClosure-ATM-20260710-C01-R7]]\"\n",
  },
  {
    id: "agentic-trade-management-06-case",
    sourceDocument: "v0.8.x/PRODPRD-atm-v0.8.4.md",
    lane: "chunked",
    chunkIndex: 0,
    failureClass: "case",
    byteDelta: 1,
    modelQuote: "Source_architecture_closure: \"[[REF-AI-AgenticTradeManagement-TechnicalClosure-ATM-20260710-C01-R7]]\"",
    trueSourceText: "source_architecture_closure: \"[[REF-AI-AgenticTradeManagement-TechnicalClosure-ATM-20260710-C01-R7]]\"",
    sourceExcerpt: "source_change_plan: \"[[REF-AI-AgenticTradeManagement-PRD-ChangePlan-to-v0.8.4-ATM-20260710-C01-R7]]\"\nsource_architecture_closure: \"[[REF-AI-AgenticTradeManagement-TechnicalClosure-ATM-20260710-C01-R7]]\"\nsource_patch_basis: Copy-first v0.8.3-to-v0.8.4 patch under the exact 27-parent architecture thirds and direct 2026-07-11 user authority to generate the target PRD\n",
  },
  {
    id: "agentic-trade-management-07-case",
    sourceDocument: "v0.8.x/PRODPRD-atm-v0.8.4.md",
    lane: "chunked",
    chunkIndex: 0,
    failureClass: "case",
    byteDelta: 1,
    modelQuote: "Source_patch_basis: Copy-first v0.8.3-to-v0.8.4 patch under the exact 27-parent architecture thirds and direct 2026-07-11 user authority to generate the target PRD",
    trueSourceText: "source_patch_basis: Copy-first v0.8.3-to-v0.8.4 patch under the exact 27-parent architecture thirds and direct 2026-07-11 user authority to generate the target PRD",
    sourceExcerpt: "source_architecture_closure: \"[[REF-AI-AgenticTradeManagement-TechnicalClosure-ATM-20260710-C01-R7]]\"\nsource_patch_basis: Copy-first v0.8.3-to-v0.8.4 patch under the exact 27-parent architecture thirds and direct 2026-07-11 user authority to generate the target PRD\nsource_feedback: \"[[v0.8.2-feedback]]\"\n",
  },
  {
    id: "agentic-trade-management-08-case",
    sourceDocument: "v0.8.x/PRODPRD-atm-v0.8.4.md",
    lane: "chunked",
    chunkIndex: 0,
    failureClass: "case",
    byteDelta: 1,
    modelQuote: "Source_feedback: \"[[v0.8.2-feedback]]\"",
    trueSourceText: "source_feedback: \"[[v0.8.2-feedback]]\"",
    sourceExcerpt: "source_patch_basis: Copy-first v0.8.3-to-v0.8.4 patch under the exact 27-parent architecture thirds and direct 2026-07-11 user authority to generate the target PRD\nsource_feedback: \"[[v0.8.2-feedback]]\"\nsource_templates:\n",
  },
  {
    id: "agentic-trade-management-09-whitespace",
    sourceDocument: "v0.8.x/PRODPRD-atm-v0.8.4.md",
    lane: "chunked",
    chunkIndex: 0,
    failureClass: "whitespace",
    byteDelta: 3,
    modelQuote: "Source_templates:\n - \"[[00_MAIN/01_ActiveProjects/agentic-trade-management/_templates/TPL-Thesis]]\"\n - \"[[00_MAIN/01_ActiveProjects/agentic-trade-management/_templates/TPL-Trade]]\"",
    trueSourceText: "source_templates:\n  - \"[[00_MAIN/01_ActiveProjects/agentic-trade-management/_templates/TPL-Thesis]]\"\n  - \"[[00_MAIN/01_ActiveProjects/agentic-trade-management/_templates/TPL-Trade]]\"",
    sourceExcerpt: "source_feedback: \"[[v0.8.2-feedback]]\"\nsource_templates:\n  - \"[[00_MAIN/01_ActiveProjects/agentic-trade-management/_templates/TPL-Thesis]]\"\n  - \"[[00_MAIN/01_ActiveProjects/agentic-trade-management/_templates/TPL-Trade]]\"\nsource_stack_context: \"[[00_MAIN/00_RyanSSOT/REF-HUM-RyanFinalStackSSOT]]\"\n",
  },
  {
    id: "agentic-trade-management-10-case",
    sourceDocument: "v0.8.x/PRODPRD-atm-v0.8.4.md",
    lane: "chunked",
    chunkIndex: 0,
    failureClass: "case",
    byteDelta: 1,
    modelQuote: "Source_stack_context: \"[[00_MAIN/00_RyanSSOT/REF-HUM-RyanFinalStackSSOT]]\"",
    trueSourceText: "source_stack_context: \"[[00_MAIN/00_RyanSSOT/REF-HUM-RyanFinalStackSSOT]]\"",
    sourceExcerpt: "  - \"[[00_MAIN/01_ActiveProjects/agentic-trade-management/_templates/TPL-Trade]]\"\nsource_stack_context: \"[[00_MAIN/00_RyanSSOT/REF-HUM-RyanFinalStackSSOT]]\"\n---\n",
  },
  {
    id: "agentic-trade-management-11-case",
    sourceDocument: "v0.8.x/PRODPRD-atm-v0.8.4.md",
    lane: "chunked",
    chunkIndex: 0,
    failureClass: "case",
    byteDelta: 2,
    modelQuote: "Brainstorm_status: complete\nBrainstorm_topic: agentic trade management PRD",
    trueSourceText: "brainstorm_status: complete\nbrainstorm_topic: agentic trade management PRD",
    sourceExcerpt: "  - prd\nbrainstorm_status: complete\nbrainstorm_topic: agentic trade management PRD\nsource_prd: \"[[PRODPRD-atm-v0.8.3]]\"\n",
  },
  {
    id: "agentic-trade-management-12-whitespace",
    sourceDocument: "v0.8.x/PRODPRD-atm-v0.8.4.md",
    lane: "chunked",
    chunkIndex: 0,
    failureClass: "whitespace",
    byteDelta: 12,
    modelQuote: "---\nType: prj\nDomain: ccc\nStatus: draft\nDate_created: 2026-07-03\nDate_modified: 2026-07-11\nVersion: 0.8.4\nAliases:\n - Agentic Trade Management PRD v0.8.4\n - ATM PRD v0.8.4\nTags:\n - trading\n - trade-ma",
    trueSourceText: "---\ntype: prj\ndomain: ccc\nstatus: draft\ndate_created: 2026-07-03\ndate_modified: 2026-07-11\nversion: 0.8.4\naliases:\n  - Agentic Trade Management PRD v0.8.4\n  - ATM PRD v0.8.4\ntags:\n  - trading\n  - trade-ma",
    sourceExcerpt: "---\ntype: prj\ndomain: ccc\nstatus: draft\ndate_created: 2026-07-03\ndate_modified: 2026-07-11\nversion: 0.8.4\naliases:\n  - Agentic Trade Management PRD v0.8.4\n  - ATM PRD v0.8.4\ntags:\n  - trading\n  - trade-management\n  - agentic-trade-management\n",
  },
  {
    id: "ccc-autocode-neo-13-case",
    sourceDocument: "prd-v0.5.0/260712-ccc-autocode-neo-PRODPRD-v0.5.0.md",
    lane: "chunked",
    chunkIndex: 2,
    failureClass: "case",
    byteDelta: 1,
    modelQuote: "V0.5.0 is the bounded convergence repair: it unifies requirement IDs, closes trusted-repository and handoff schemas, makes negative controls executable, repairs intake/adjudication/gate state contract",
    trueSourceText: "v0.5.0 is the bounded convergence repair: it unifies requirement IDs, closes trusted-repository and handoff schemas, makes negative controls executable, repairs intake/adjudication/gate state contract",
    sourceExcerpt: "\nThe thirteen required architecture decisions are all made in this document. None is left open. This document is deliberately self-contained: every fact, constraint, constant, schema, and decision needed to understand and build the system is stated in this file, and no external note is required reading (the provenance appendix names archival sources for audit only). Version history, briefly: v0.1.0 was the original adjudicated draft; v0.2.0 applied the first adversarial-review patch (SQLite writer matrix, reboot-safe ledger ordering, Tier-3 cascade and lease/fence lifecycle completion, product-repo bootstrap and runtime capability-pack tasks, ship converted to an operator-confirmed proposal); v0.2.1 applied the second review cycle (Lamport logical clock replacing timestamp ordering, cascade crash-recovery bracket, mandatory `--no-ff` merges making `revert -m 1` provably correct, collision-free branch namespaces, a separate gate concurrency budget, and NEO-M2-009 owning the external review); v0.3.0 is the contract-closure edition: it freezes trusted-repository admission, approved-remote egress, operator-confirmed publication, replay-safe state and side effects, closed proof schemas, total lifecycles, a 23-task implementation DAG, eight global acceptance rows, and separate live SHIP and truthful-failure evidence. v0.4.0 closes the remaining implementation gaps found by the first blind post-apply review: trusted-repository-only admission, exact research neutralization, total remote-call and Dagu transactions, closed clarification and operator-query surfaces, one gate-fold owner, ordered process locks, mechanical external review, release-scoped evidence, a committed truthful-failure candidate, a non-self-referential handoff, deterministic merge planning, and exact task/proof parity. v0.5.0 is the bounded convergence repair: it unifies requirement IDs, closes trusted-repository and handoff schemas, makes negative controls executable, repairs intake/adjudication/gate state contracts, removes unsafe pre-lock ledger writes, and resolves the final query, review, Dagu, and truthful-failure contradictions.\n\n",
  },
  {
    id: "prd-expansion-engine-14-case",
    sourceDocument: "PRJ-PRDExpansionEngine-ExecutionPRD-v0.2.md",
    lane: "chunked",
    chunkIndex: 1,
    failureClass: "case",
    byteDelta: 1,
    modelQuote: "Everything marked `[needs probe]` must be verified against the running system before a builder relies on it.",
    trueSourceText: "everything marked `[needs probe]` must be verified against the running system before a builder relies on it.",
    sourceExcerpt: "\nStatus: draft; this version is the **implementation contract**. It supersedes [[PRJ-PRDExpansionEngine-ExecutionPRD-v0.1|Execution PRD v0.1]] by applying the Ryan-approved [[REF-AI-PRDExpansionEngine-PRD-ChangePlan-to-v0.2-2026-07-08|B2 change plan]] (2026-07-08): all five product decisions C1–C5 are resolved and folded in, the twenty adopt items are applied, the two full Expand/Validate build contracts are deferred with stubs, and the four build-time probes I1–I4 stay open and labeled `[needs probe]`. Everything marked `[SSOT-derived]` comes from [[00_MAIN/00_RyanSSOT/REF-HUM-RyanFinalStackSSOT|Ryan Stack SSOT]] without a live probe; everything marked `[needs probe]` must be verified against the running system before a builder relies on it. The dense contract (schemas, CLI surface, state table, grammars, DDL, fixtures) lives in [[#Engine Contract v0 Appendix]] per C3 — one document, tight core plus appendix.\n\n",
  },
  {
    id: "prd-expansion-engine-15-elision",
    sourceDocument: "PRJ-PRDExpansionEngine-ExecutionPRD-v0.2.md",
    lane: "chunked",
    chunkIndex: 1,
    failureClass: "elision",
    byteDelta: 135,
    modelQuote: "the four build-time probes I1–I4 stay open and labeled `[needs probe]`. Everything marked `[needs probe]` must be verified against the running system before a builder relies on it.",
    trueSourceText: "the four build-time probes I1–I4 stay open and labeled `[needs probe]`. Everything marked `[SSOT-derived]` comes from [[00_MAIN/00_RyanSSOT/REF-HUM-RyanFinalStackSSOT|Ryan Stack SSOT]] without a live probe; everything marked `[needs probe]` must be verified against the running system before a builder relies on it.",
    sourceExcerpt: "\nStatus: draft; this version is the **implementation contract**. It supersedes [[PRJ-PRDExpansionEngine-ExecutionPRD-v0.1|Execution PRD v0.1]] by applying the Ryan-approved [[REF-AI-PRDExpansionEngine-PRD-ChangePlan-to-v0.2-2026-07-08|B2 change plan]] (2026-07-08): all five product decisions C1–C5 are resolved and folded in, the twenty adopt items are applied, the two full Expand/Validate build contracts are deferred with stubs, and the four build-time probes I1–I4 stay open and labeled `[needs probe]`. Everything marked `[SSOT-derived]` comes from [[00_MAIN/00_RyanSSOT/REF-HUM-RyanFinalStackSSOT|Ryan Stack SSOT]] without a live probe; everything marked `[needs probe]` must be verified against the running system before a builder relies on it. The dense contract (schemas, CLI surface, state table, grammars, DDL, fixtures) lives in [[#Engine Contract v0 Appendix]] per C3 — one document, tight core plus appendix.\n\n",
  },
  {
    id: "route-bench-16-emphasis",
    sourceDocument: "PRJ-HUM-RouteBench-PRD-v0.1.md",
    lane: "single-shot",
    chunkIndex: null,
    failureClass: "emphasis",
    byteDelta: 4,
    modelQuote: "Tasks must be replayable: each pins a repo, a base commit, and a revert path, so every route starts from identical state.",
    trueSourceText: "Tasks must be **replayable**: each pins a repo, a base commit, and a revert path, so every route starts from identical state.",
    sourceExcerpt: "\nTasks must be **replayable**: each pins a repo, a base commit, and a revert path, so every route starts from identical state.\n\n",
  },
  {
    id: "session-recall-unit-17-punctuation",
    sourceDocument: "prd-v0.4.x/sru-prd-v0.4.0.md",
    lane: "chunked",
    chunkIndex: 5,
    failureClass: "punctuation",
    byteDelta: 2,
    modelQuote: "Introspect the live `agent-session-search` tool through MCP metadata (`tools/list` / input schema) on the resolved route and serialize it to `tests/fixtures/agent_session_search.schema.json`. Treat th",
    trueSourceText: "Introspect the live `agent-session-search` tool through MCP metadata (`tools/list` / input schema) on the resolved route and serialize it to `tests/fixtures/agent_session_search.schema.json`. | Treat th",
    sourceExcerpt: "| Transport discovery | Resolve the transcript-search transport through the active runtime route: explicit env/config override first, then known MCP/client config anchors, then the current Codex broker orientation `http://127.0.0.1:8163/mcp` or Claude direct `stack-core` route only if active config confirms it. | Record the actual transport and callable name in the preflight report and isolate it behind `TranscriptSearchClient`. Do not assume `/sse`, raw TCP, direct transcript JSONL roots, or a direct server path when the broker is the configured route. |\n| Tool schema capture | Introspect the live `agent-session-search` tool through MCP metadata (`tools/list` / input schema) on the resolved route and serialize it to `tests/fixtures/agent_session_search.schema.json`. | Treat the committed live capture as authoritative over field names, but require the minimum capabilities this PRD depends on: candidate-display mode or equivalent, evidence-display/follow-up mode or equivalent, source filters, caller-session metadata, and path/session identifiers. If metadata discovery or minimum capability matching fails, write a structured Phase 0 preflight failure and halt for a PRD/adapter update instead of inferring schema from transcript files or prose. |\n| Safe response-shape capture | Run exactly one small candidate-scan probe after transport discovery. Hold raw output in memory only, deep-replace or structurally redact every raw string value before display, logging, report inclusion, model exposure, or disk write, then persist only shape-safe fixtures under `tests/fixtures/`. | This throwaway shape-capture utility is not the final sanitizer. Phase 0 must still build the real deterministic sanitizer and realistic synthetic/protected-path/secret corpora before any model-facing transcript path is allowed. |\n",
  },
  {
    id: "skill-hook-authoring-18-other",
    sourceDocument: "v0.1/v0.1.6-SkillHookAuthoringPipeline-PRODPRD.md",
    lane: "chunked",
    chunkIndex: 4,
    failureClass: "other",
    byteDelta: 7,
    modelQuote: "The router chooses one of `skill_only`, `hook_only`, `skill_plus_hook`, `neither`, or `clarify` per fixture without free-form fallback.",
    trueSourceText: "The router chooses one of `skill_only`, `hook_only`, `skill_plus_hook`, `neither`, or `clarify` for every fixture without free-form fallback.",
    sourceExcerpt: "\n- The router chooses one of `skill_only`, `hook_only`, `skill_plus_hook`, `neither`, or `clarify` for every fixture without free-form fallback.\n- Every generated readiness packet has valid frontmatter, exactly one H1, route-specific required sections, one machine-owned state block, and no unvalidated runtime claim marked ready.\n",
  },
  {
    id: "session-recall-unit-19-tense",
    sourceDocument: "prd-v0.4.x/sru-prd-v0.4.0.md",
    lane: "chunked",
    chunkIndex: 5,
    failureClass: "tense",
    byteDelta: 2,
    modelQuote: "Hold raw output in memory only, deep-replace or structurally redacted every raw string value before display, logging, report inclusion, model exposure, or disk write, then persist only shape-safe fixt",
    trueSourceText: "Hold raw output in memory only, deep-replace or structurally redact every raw string value before display, logging, report inclusion, model exposure, or disk write, then persist only shape-safe fixt",
    sourceExcerpt: "| Tool schema capture | Introspect the live `agent-session-search` tool through MCP metadata (`tools/list` / input schema) on the resolved route and serialize it to `tests/fixtures/agent_session_search.schema.json`. | Treat the committed live capture as authoritative over field names, but require the minimum capabilities this PRD depends on: candidate-display mode or equivalent, evidence-display/follow-up mode or equivalent, source filters, caller-session metadata, and path/session identifiers. If metadata discovery or minimum capability matching fails, write a structured Phase 0 preflight failure and halt for a PRD/adapter update instead of inferring schema from transcript files or prose. |\n| Safe response-shape capture | Run exactly one small candidate-scan probe after transport discovery. Hold raw output in memory only, deep-replace or structurally redact every raw string value before display, logging, report inclusion, model exposure, or disk write, then persist only shape-safe fixtures under `tests/fixtures/`. | This throwaway shape-capture utility is not the final sanitizer. Phase 0 must still build the real deterministic sanitizer and realistic synthetic/protected-path/secret corpora before any model-facing transcript path is allowed. |\n| OmniRoute and model-candidate resolution | `GET ${base}/v1/models`, resolve seed MiniMax/Gemini/judge aliases into reachable IDs, and write `config/model_candidates.resolved.json` plus initial `config/provider_routes.json` records. | Record reachable IDs, auth requirement, base URL, route IDs, and matching predicates. Required bakeoff commands consume the resolved candidate config and fail closed when a seed alias cannot resolve. |\n",
  },
];

const INVENTED_QUOTE = "Every route must publish a signed provenance receipt to the CCC ledger before its result is admitted.";
const INVENTED_SOURCE_EXCERPT = "Target roughly 12–15 tasks across the shapes that actually recur: single-file bug with a failing test; multi-file feature behind an interface; test-writing against existing behavior; dependency or toolchain repair; a research-and-summarize task graded on citation accuracy; and a vault-documentation task graded on frontmatter and link validity.\n\nTasks must be **replayable**: each pins a repo, a base commit, and a revert path, so every route starts from identical state.\n\n### Metrics\n";

const AMBIGUOUS_QUOTE = "| C | [Cause] → [effect] | [How the effect should appear in data or price.] | [Timing.] | [Failure condition.] |";
const AMBIGUOUS_SOURCE_EXCERPT = "| C1 | [Cause] → [effect] | [How the effect should appear in data or price.] | [Immediate, days, weeks, quarters.] | [Specific failure condition.] |\n| C2 | [Cause] → [effect] | [How the effect should appear in data or price.] | [Timing.] | [Failure condition.] |\n| C3 | [Cause] → [effect] | [How the effect should appear in data or price.] | [Timing.] | [Failure condition.] |\n\n";
const AMBIGUOUS_CANDIDATE_A = "| C2 | [Cause] → [effect] | [How the effect should appear in data or price.] | [Timing.] | [Failure condition.] |";
const AMBIGUOUS_CANDIDATE_B = "| C3 | [Cause] → [effect] | [How the effect should appear in data or price.] | [Timing.] | [Failure condition.] |";
const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

/**
 * What a fixture is measured to do, not what anyone hoped it would do.
 *
 *   deterministic  -- resolves under the SHIPPING DEFAULT policy, using tiers 0
 *                     and 1 only (byte-exact, then normalization for case,
 *                     whitespace, markdown emphasis and table pipes).
 *   needs-fuzzy    -- refused by the shipping default; resolves only when an
 *                     operator opts in to tier 2 with `{allowFuzzy: true}`.
 *   unrecoverable  -- refused in BOTH switch states, and no threshold recovers
 *                     it. See the elision block for the proof.
 *
 * The mapping is per drift class because that is the unit the measurement used:
 * `locator-report.md` "Result per drift class" (produced by
 * `measure-locator.mts` against the real corpus documents) and
 * `fixture-census.md` (FUZZY_REQUIRED_CLASSES=tense, other;
 * UNRECOVERABLE_BY_ANY_TIER_CLASSES=elision).
 */
type FixtureDisposition = "deterministic" | "needs-fuzzy" | "unrecoverable";

const DISPOSITION_BY_FAILURE_CLASS: Record<QuoteDriftFailureClass, FixtureDisposition> = {
  case: "deterministic",
  whitespace: "deterministic",
  emphasis: "deterministic",
  punctuation: "deterministic",
  tense: "needs-fuzzy",
  other: "needs-fuzzy",
  elision: "unrecoverable",
};

/**
 * TEST-LOCAL ONLY. Nothing in production sets `quoteMatchPolicy`, so production
 * runs deterministic-only. This object exists so the two fixtures that need
 * tier 2 can be asserted in the switch state that actually recovers them --
 * enabling fuzzy anywhere outside a test would take on the meaning-inversion
 * exposure documented in the header.
 */
const FUZZY_ENABLED: CccPrdQuoteMatchPolicy = { allowFuzzy: true, recordFuzzyForReview: true };

/**
 * Measured similarity of the elision against its own source: 0.7216, below the
 * shipping fuzzy threshold of 0.85. These three thresholds sit at it and far
 * below it, which is the range a later session would reach for while "fixing"
 * this fixture.
 */
const ELISION_MEASURED_SCORE = 0.7216;
const ELISION_LOOSENED_THRESHOLDS = [0.72, 0.5, 0.0001];

/**
 * Candidate previews in an ambiguity refusal start at the CELL CONTENT, not at
 * the row's leading pipe: pipe stripping removes `|` from the normalized
 * projection the match is found in, so the emitted bound is the first real
 * character of the cell (locator-report.md, "Spans start at cell content").
 * The bytes are true source bytes either way.
 */
const asCellContent = (row: string): string => row.replace(/^\|\s*/, "").replace(/\s*\|$/, "");

/**
 * Resolves a quote against a real source excerpt with the whole excerpt as the
 * chunk slice, mirroring how the chunked lane calls the resolver
 * (chunk-verification.ts:136-144). Omitting `quoteMatchPolicy` is what
 * production does, and it means the deterministic-only default.
 */
function anchorAgainstSource(quote: string, excerpt: string, quoteMatchPolicy?: CccPrdQuoteMatchPolicy) {
  const source = Buffer.from(excerpt, "utf8");
  return resolveCccPrdAnchor({
    sourcePath: "corpus-source.md",
    source,
    quote,
    entityId: "REQ-quote-drift",
    policy: "select",
    sliceBounds: { byteStart: 0, byteEnd: source.byteLength },
    ...(quoteMatchPolicy === undefined ? {} : { quoteMatchPolicy }),
  });
}

/**
 * The bytes a reader gets by slicing the source at the resolved coordinates.
 * No quote text is ever persisted, so this -- not a stored string -- is what
 * "the quote" resolves to for every downstream consumer.
 */
function sourceTextAtSpan(excerpt: string, span: { byteStart: number; byteEnd: number }): string {
  return Buffer.from(excerpt, "utf8").subarray(span.byteStart, span.byteEnd).toString("utf8");
}

/** Mirrors compiler.ts:409 exactly: the excerpt hash re-derived from real source bytes. */
function compilerDerivedExcerptHash(
  excerpt: string,
  span: { byteStart: number; byteEnd: number },
): string {
  return sha256(Buffer.from(excerpt, "utf8").subarray(span.byteStart, span.byteEnd));
}

/** Minimal well-shaped fragment carrying a single source-bound row. */
function fragmentCiting(quote: string) {
  const empty = Object.fromEntries(IDENTITY_COLLECTIONS.map((key) => [key, []]));
  return {
    ...empty,
    schema: CCC_PRD_AUTHORING_PROPOSAL_FRAGMENT_SCHEMA_VERSION,
    requirements: [{
      id: "REQ-quote-drift",
      sourceRefs: [{ path: "corpus-source.md", exactQuote: quote }],
    }],
  };
}

function containmentViolationsFor(
  quote: string,
  excerpt: string,
  quoteMatchPolicy?: CccPrdQuoteMatchPolicy,
): string[] {
  return describeCccPrdChunkQuoteOutsideSliceViolations(
    fragmentCiting(quote) as never,
    Buffer.from(excerpt, "utf8"),
    quoteMatchPolicy,
  );
}

function caughtError(run: () => unknown): unknown {
  try {
    run();
    return null;
  } catch (error) {
    return error;
  }
}

/** Asserts a refusal and returns the error, so callers can inspect its message. */
function expectRefusal(quote: string, excerpt: string, code: string, quoteMatchPolicy?: CccPrdQuoteMatchPolicy): CccPrdCustodyError {
  const error = caughtError(() => anchorAgainstSource(quote, excerpt, quoteMatchPolicy));
  expect(error, "the resolver must refuse rather than return a span").toBeInstanceOf(CccPrdCustodyError);
  expect((error as CccPrdCustodyError).code).toBe(code);
  return error as CccPrdCustodyError;
}

/**
 * The three positional assertions (a), (b), (c) from the header, registered as
 * separate tests so a failure names which half of the invariant broke.
 * `policyLabel` says which switch state is being proven.
 */
function itResolvesToTrueSourceBytes(
  fixture: QuoteDriftFixture,
  policyLabel: string,
  quoteMatchPolicy?: CccPrdQuoteMatchPolicy,
): void {
  it(`(a) ${policyLabel}: the resolver returns a span instead of rejecting the quote`, () => {
    expect(() => anchorAgainstSource(fixture.modelQuote, fixture.sourceExcerpt, quoteMatchPolicy)).not.toThrow();
  });

  it(`(b) ${policyLabel}: slicing the source at the resolved coordinates yields the TRUE text`, () => {
    const { span } = anchorAgainstSource(fixture.modelQuote, fixture.sourceExcerpt, quoteMatchPolicy);

    expect(sourceTextAtSpan(fixture.sourceExcerpt, span)).toBe(fixture.trueSourceText);
    expect(sourceTextAtSpan(fixture.sourceExcerpt, span)).not.toBe(fixture.modelQuote);
    // byteEnd must come from the matched true text, not from the model's
    // quote length as anchor-resolver.ts:161 derives it today.
    expect(span.byteEnd - span.byteStart).toBe(Buffer.byteLength(fixture.trueSourceText, "utf8"));
  });

  it(`(c) ${policyLabel}: the excerpt hash the compiler re-derives matches the true text, not the model's`, () => {
    const { span } = anchorAgainstSource(fixture.modelQuote, fixture.sourceExcerpt, quoteMatchPolicy);
    const derived = compilerDerivedExcerptHash(fixture.sourceExcerpt, span);

    expect(derived).toBe(sha256(Buffer.from(fixture.trueSourceText, "utf8")));
    // compiler.ts:410 -- a span whose recorded hash disagrees with the hash
    // of its own source bytes is CCC_PRD_SOURCE_SPAN_STALE. Loosening the
    // match without substituting would trip exactly this.
    expect(span.excerptSha256, `${fixture.id} would go CCC_PRD_SOURCE_SPAN_STALE`).toBe(derived);
  });
}

const fixturesWithDisposition = (disposition: FixtureDisposition): QuoteDriftFixture[] =>
  QUOTE_DRIFT_FIXTURES.filter((fixture) => DISPOSITION_BY_FAILURE_CLASS[fixture.failureClass] === disposition);

describe("ccc-prd quote drift repair: observed corpus failures resolve to true source bytes", () => {
  it("the fixture corpus still covers every observed drift class and both lanes", () => {
    const classes = [...new Set(QUOTE_DRIFT_FIXTURES.map((fixture) => fixture.failureClass))].sort();
    expect(classes).toEqual([
      "case", "elision", "emphasis", "other", "punctuation", "tense", "whitespace",
    ]);
    expect(QUOTE_DRIFT_FIXTURES).toHaveLength(19);
    expect(QUOTE_DRIFT_FIXTURES.filter((fixture) => fixture.lane === "single-shot")).toHaveLength(1);
    expect(QUOTE_DRIFT_FIXTURES.filter((fixture) => fixture.lane === "chunked")).toHaveLength(18);
  });

  it("every fixture really is a drift: the model's bytes are absent from the real source", () => {
    for (const fixture of QUOTE_DRIFT_FIXTURES) {
      expect(fixture.sourceExcerpt, `${fixture.id} excerpt must hold the true text`)
        .toContain(fixture.trueSourceText);
      expect(fixture.sourceExcerpt.includes(fixture.modelQuote), `${fixture.id} must not already match`)
        .toBe(false);
      expect(fixture.modelQuote).not.toBe(fixture.trueSourceText);
    }
  });

  it("the disposition map still matches the measured census, and fuzzy still ships OFF", () => {
    // If a regenerated fixture block introduces a class this map does not
    // cover, or shifts the counts, this fails loudly rather than silently
    // asserting the wrong disposition for a new fixture.
    for (const fixture of QUOTE_DRIFT_FIXTURES) {
      expect(DISPOSITION_BY_FAILURE_CLASS[fixture.failureClass], `${fixture.id} has no measured disposition`)
        .toBeDefined();
    }
    // fixture-census.md: DETERMINISTIC_TIER_ONLY_COVERAGE=16, FUZZY_REQUIRED_COUNT=2,
    // UNRECOVERABLE_BY_ANY_TIER_COUNT=1.
    expect(fixturesWithDisposition("deterministic")).toHaveLength(16);
    expect(fixturesWithDisposition("needs-fuzzy")).toHaveLength(2);
    expect(fixturesWithDisposition("unrecoverable")).toHaveLength(1);

    // Every test below that omits `quoteMatchPolicy` is asserting the shipping
    // default. That default is deterministic-only, and it is proven here rather
    // than assumed, because the whole disposition split depends on it.
    expect(DEFAULT_CCC_PRD_QUOTE_MATCH_POLICY.allowFuzzy).toBe(false);
  });

  describe.each(fixturesWithDisposition("deterministic"))(
    "$id [$failureClass, $byteDelta byte drift, $lane lane] -- recovered by tiers 0+1",
    (fixture: QuoteDriftFixture) => {
      itResolvesToTrueSourceBytes(fixture, "shipping default policy");
    },
  );

  describe.each(fixturesWithDisposition("needs-fuzzy"))(
    "$id [$failureClass, $byteDelta byte drift, $lane lane] -- needs tier 2",
    (fixture: QuoteDriftFixture) => {
      it("is REFUSED under the shipping default, because tier 2 is off", () => {
        // Not a bug and not a regression: fuzzy ships off on purpose
        // (locator-report.md, POPULATIONS_SEPARABLE=NO). A run hitting this
        // drift class dies, and that is the deliberate trade.
        expectRefusal(fixture.modelQuote, fixture.sourceExcerpt, "CCC_PRD_SOURCE_QUOTE_MISSING");
      });

      itResolvesToTrueSourceBytes(fixture, "explicit {allowFuzzy: true}", FUZZY_ENABLED);
    },
  );

  describe.each(fixturesWithDisposition("unrecoverable"))(
    "$id [$failureClass, $byteDelta byte drift, $lane lane] -- refused at every threshold",
    (fixture: QuoteDriftFixture) => {
      it("is REFUSED under the shipping default", () => {
        expectRefusal(fixture.modelQuote, fixture.sourceExcerpt, "CCC_PRD_SOURCE_QUOTE_MISSING");
      });

      it("is REFUSED with fuzzy enabled too: it scores 0.7216, under the 0.85 threshold", () => {
        expectRefusal(fixture.modelQuote, fixture.sourceExcerpt, "CCC_PRD_SOURCE_QUOTE_MISSING", FUZZY_ENABLED);
      });

      it("WHY the refusal is right: a lowered threshold admits a WRONG span, it does not recover the true one", () => {
        // THE POINT OF THIS TEST. Tier 2 is a minimum-distance sliding window.
        // Spanning the elided middle costs ~135 insertions; matching only the
        // needle's tail costs far fewer edits, so the minimum-distance window
        // is always a FRAGMENT and never the spliced whole. Dropping the
        // threshold therefore does not surface the true span -- it surfaces a
        // shorter, wrong one, whose hash `compiler.ts:409` would then bless as
        // provenance. Do not "fix" this fixture by lowering a number.
        for (const fuzzyThreshold of ELISION_LOOSENED_THRESHOLDS) {
          const { span, receipt } = anchorAgainstSource(
            fixture.modelQuote,
            fixture.sourceExcerpt,
            { ...FUZZY_ENABLED, fuzzyThreshold },
          );
          const admitted = sourceTextAtSpan(fixture.sourceExcerpt, span);

          expect(receipt.matchStrategy, `threshold ${fuzzyThreshold} should reach tier 2`).toBe("fuzzy");
          expect(receipt.fuzzyDrift?.score, "measured similarity is below the shipping threshold")
            .toBeCloseTo(ELISION_MEASURED_SCORE, 4);
          expect(receipt.fuzzyDrift?.score ?? 1).toBeLessThan(0.85);

          expect(admitted, `threshold ${fuzzyThreshold} must not be mistaken for a recovery`)
            .not.toBe(fixture.trueSourceText);
          expect(fixture.trueSourceText, "what it admits is a fragment of the true span")
            .toContain(admitted);
          expect(Buffer.byteLength(admitted, "utf8"))
            .toBeLessThan(Buffer.byteLength(fixture.trueSourceText, "utf8"));

          // It starts mid-word, inside `...RyanFinalStackSSOT|...`, which is
          // what "the window is a fragment, not a span" looks like in bytes.
          const at = fixture.trueSourceText.indexOf(admitted);
          expect(at, "the admitted fragment starts after the true span's start").toBeGreaterThan(0);
          expect(/\w/.test(fixture.trueSourceText.charAt(at - 1)), "preceded by a word character").toBe(true);
          expect(/\w/.test(admitted.charAt(0)), "and starts with one -- i.e. mid-word").toBe(true);

          // And so the provenance hash would be the wrong bytes' hash.
          expect(compilerDerivedExcerptHash(fixture.sourceExcerpt, span))
            .not.toBe(sha256(Buffer.from(fixture.trueSourceText, "utf8")));
        }
      });

      it("and it is the SAME wrong span at every threshold, so no number can recover it", () => {
        // The minimum-distance window does not move as the threshold falls;
        // only whether it is admitted changes. That is why this is structural
        // rather than a tuning miss.
        const spans = ELISION_LOOSENED_THRESHOLDS.map((fuzzyThreshold) => {
          const { span } = anchorAgainstSource(
            fixture.modelQuote,
            fixture.sourceExcerpt,
            { ...FUZZY_ENABLED, fuzzyThreshold },
          );
          return `${span.byteStart}-${span.byteEnd}`;
        });

        expect(new Set(spans).size, `thresholds ${ELISION_LOOSENED_THRESHOLDS.join(", ")} all land on ${spans[0]}`).toBe(1);
      });
    },
  );

  it("secondary: the containment gate passes every deterministic fixture, or the resolver never runs", () => {
    // chunk-verification.ts:116 is a pre-flight predicate returning a boolean
    // and a violation string; it produces no offset and its result is
    // discarded, so no substitution happens here. It is asserted only because
    // verifyCccPrdChunkFragment runs it at step 3, BEFORE span resolution at
    // step 4 -- an unrelaxed gate refuses before buildSpan is ever reached.
    for (const fixture of fixturesWithDisposition("deterministic")) {
      expect(
        containmentViolationsFor(fixture.modelQuote, fixture.sourceExcerpt),
        `${fixture.id} must survive the containment gate`,
      ).toEqual([]);
    }
  });

  it("secondary: the gate blocks tier-2 fixtures by default and passes them with fuzzy enabled", () => {
    for (const fixture of fixturesWithDisposition("needs-fuzzy")) {
      const blocked = containmentViolationsFor(fixture.modelQuote, fixture.sourceExcerpt);
      expect(blocked, `${fixture.id} is blocked while tier 2 is off`).toHaveLength(1);
      // The diagnostic must say WHY, or a chunk that failed only because tier 2
      // was disabled reads identically to a fabricated quote.
      expect(blocked[0]).toContain("fuzzy matching is disabled");

      expect(
        containmentViolationsFor(fixture.modelQuote, fixture.sourceExcerpt, FUZZY_ENABLED),
        `${fixture.id} survives the gate once tier 2 is on`,
      ).toEqual([]);
    }
  });

  it("secondary: the gate blocks the elision in BOTH switch states", () => {
    for (const fixture of fixturesWithDisposition("unrecoverable")) {
      expect(containmentViolationsFor(fixture.modelQuote, fixture.sourceExcerpt)).toHaveLength(1);

      const withFuzzy = containmentViolationsFor(fixture.modelQuote, fixture.sourceExcerpt, FUZZY_ENABLED);
      expect(withFuzzy, `${fixture.id} is refused even with tier 2 on`).toHaveLength(1);
      // No "fuzzy is disabled" excuse here: tier 2 ran and still refused.
      expect(withFuzzy[0]).not.toContain("fuzzy matching is disabled");
    }
  });
});

describe("ccc-prd quote drift repair: negative controls that must STILL be rejected", () => {
  it("refuses an invented quote that appears nowhere in the source slice, in both switch states", () => {
    expectRefusal(INVENTED_QUOTE, INVENTED_SOURCE_EXCERPT, "CCC_PRD_SOURCE_QUOTE_MISSING");
    // Measured at 0.3366 similarity -- far under any workable threshold.
    // Loosening the matcher must not manufacture a home for a fabrication.
    expectRefusal(INVENTED_QUOTE, INVENTED_SOURCE_EXCERPT, "CCC_PRD_SOURCE_QUOTE_MISSING", FUZZY_ENABLED);
  });

  it("refuses the ambiguous drift as ABSENT under the shipping default, where the collision is invisible", () => {
    // Two real adjacent rows differ only by their ordinal. The quote drops the
    // ordinal, landing exactly one edit from each. With tier 2 off, neither row
    // is ever a candidate, so the honest refusal is "absent" -- the ambiguity
    // only becomes visible once fuzzy matching can see both rows at all.
    expectRefusal(AMBIGUOUS_QUOTE, AMBIGUOUS_SOURCE_EXCERPT, "CCC_PRD_SOURCE_QUOTE_MISSING");
  });

  it("refuses the ambiguous drift loudly with fuzzy enabled, naming BOTH real candidates", () => {
    let resolved: string | null = null;
    const error = caughtError(() => {
      const { span } = anchorAgainstSource(AMBIGUOUS_QUOTE, AMBIGUOUS_SOURCE_EXCERPT, FUZZY_ENABLED);
      resolved = sourceTextAtSpan(AMBIGUOUS_SOURCE_EXCERPT, span);
      return resolved;
    });

    expect(resolved, "silently picking one candidate would fabricate the model's intent").toBeNull();
    expect(error).toBeInstanceOf(CccPrdCustodyError);

    // TWO AMBIGUITY CODES EXIST AND THEY MEAN DIFFERENT THINGS. This one means
    // "a loose match landed on regions the matcher cannot tell apart"; the
    // older CCC_PRD_ANCHOR_AMBIGUOUS_INTENT means "several byte-EXACT
    // occurrences survived extension". Different causes, different remediation
    // -- the model fixes this one by quoting whatever distinguishes the rows.
    // Do not collapse them.
    expect((error as CccPrdCustodyError).code).toBe("CCC_PRD_ANCHOR_QUOTE_AMBIGUOUS_MATCH");
    expect((error as CccPrdCustodyError).code).not.toBe("CCC_PRD_ANCHOR_AMBIGUOUS_INTENT");

    const message = (error as CccPrdCustodyError).message;
    expect(message, "the refusal must show the first competing candidate")
      .toContain(asCellContent(AMBIGUOUS_CANDIDATE_A));
    expect(message, "the refusal must show the second competing candidate")
      .toContain(asCellContent(AMBIGUOUS_CANDIDATE_B));
  });
});
