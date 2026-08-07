import { createHash } from "node:crypto";
import { CCC_PRD_AUTHORING_PROPOSAL_FRAGMENT_SCHEMA_VERSION } from "@fusion/core";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_CCC_PRD_QUOTE_MATCH_POLICY,
  resolveCccPrdAnchor,
  type CccPrdQuoteMatchPolicy,
} from "../ccc-prd/anchor-resolver.js";
import { IDENTITY_COLLECTIONS } from "../ccc-prd/authoring.js";
import {
  describeCccPrdChunkQuoteOutsideSliceViolations,
  verifyCccPrdChunkFragment,
} from "../ccc-prd/chunk-verification.js";
import { CccPrdCustodyError } from "../ccc-prd/custody.js";

/**
 * Integration coverage for the CHUNKED lane's loose quote matching: does the
 * drift the corpus actually produced now resolve to a span, does that span
 * hold TRUE source bytes, and does the excerpt hash the compiler re-derives
 * agree?
 *
 * `ccc-prd-quote-locator.test.ts` already proves the matcher in isolation.
 * What is proven here is the wiring around it, which is where the design can
 * silently fail in three distinct ways:
 *
 *   1. `chunk-verification.ts` runs its containment gate BEFORE span
 *      resolution. An unrelaxed gate refuses a drifted quote before the
 *      resolver ever sees it, so the resolver's work is unreachable.
 *   2. `anchor-resolver.ts` emits the span. Loosening the match without
 *      substituting true source bytes leaves `byteEnd` and `excerptSha256`
 *      derived from the model's bytes, and `compiler.ts:409` then rejects
 *      every recovered quote as CCC_PRD_SOURCE_SPAN_STALE. The two halves
 *      must land together, so (b) and (c) below are asserted together.
 *   3. The fuzzy tier is behind a switch that defaults OFF. Every assertion
 *      therefore names the policy it runs under; nothing here passes "in
 *      general".
 *
 * HERMETIC BY CONSTRUCTION. Every excerpt below is verbatim real corpus text,
 * but it is inlined rather than read from `.smoke-scratch/`, which is
 * untracked. The `describe` block at the top re-proves each fixture really is
 * a drift -- the true text is present, the model's bytes are not -- so a
 * mistyped constant fails loudly instead of quietly testing nothing.
 */

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

const FUZZY_SILENT: CccPrdQuoteMatchPolicy = { allowFuzzy: true, recordFuzzyForReview: false };
const FUZZY_RECORDED: CccPrdQuoteMatchPolicy = { allowFuzzy: true, recordFuzzyForReview: true };

// --- real corpus excerpts ---------------------------------------------------

/** PRODPRD-atm-v0.8.4.md frontmatter, verbatim. */
const ATM_FRONTMATTER = [
  "---",
  "type: prj",
  "domain: ccc",
  "status: draft",
  "date_created: 2026-07-03",
  "date_modified: 2026-07-11",
  "version: 0.8.4",
  "aliases:",
  "  - Agentic Trade Management PRD v0.8.4",
  "  - ATM PRD v0.8.4",
  "tags:",
  "  - trading",
  "  - trade-management",
  "  - agentic-trade-management",
  "  - prd",
  "brainstorm_status: complete",
  "---",
  "",
].join("\n");

/** PRJ-HUM-RouteBench-PRD-v0.1.md, verbatim. */
const ROUTE_BENCH = [
  "Target roughly 12–15 tasks across the shapes that actually recur: single-file bug with a failing test.",
  "",
  "Tasks must be **replayable**: each pins a repo, a base commit, and a revert path, so every route starts from identical state.",
  "",
].join("\n");

/** sru-prd-v0.4.0.md table rows, verbatim. */
const SRU_TABLE = [
  "| Tool schema capture | Introspect the live `agent-session-search` tool through MCP metadata (`tools/list` / input schema) on the resolved route and serialize it to `tests/fixtures/agent_session_search.schema.json`. | Treat the committed live capture as authoritative over field names, but require the minimum capabilities this PRD depends on. |",
  "| Safe response-shape capture | Run exactly one small candidate-scan probe after transport discovery. Hold raw output in memory only, deep-replace or structurally redact every raw string value before display, logging, report inclusion, model exposure, or disk write, then persist only shape-safe fixtures under `tests/fixtures/`. | This throwaway shape-capture utility is not the final sanitizer. |",
  "",
].join("\n");

/** v0.1.6-SkillHookAuthoringPipeline-PRODPRD.md, verbatim. */
const SKILL_HOOK_METRICS = [
  "Success metrics for MVP:",
  "",
  "- The router chooses one of `skill_only`, `hook_only`, `skill_plus_hook`, `neither`, or `clarify` for every fixture without free-form fallback.",
  "- Every generated readiness packet has valid frontmatter, exactly one H1, and no unvalidated runtime claim marked ready.",
  "",
].join("\n");

/** PRJ-PRDExpansionEngine-ExecutionPRD-v0.2.md, verbatim (en dashes in C1–C5 / I1–I4). */
const EXPANSION_PARAGRAPH = [
  "Status: draft; this version is the **implementation contract**. It applies the Ryan-approved B2 change plan (2026-07-08): all five product decisions C1–C5 are resolved and folded in, and the four build-time probes I1–I4 stay open and labeled `[needs probe]`. Everything marked `[SSOT-derived]` comes from [[00_MAIN/00_RyanSSOT/REF-HUM-RyanFinalStackSSOT|Ryan Stack SSOT]] without a live probe; everything marked `[needs probe]` must be verified against the running system before a builder relies on it.",
  "",
].join("\n");

/** TPL-Thesis.md, verbatim. Rows C2 and C3 differ only by their ordinal. */
const TPL_THESIS_TABLE = [
  "| ID | Causal link | Expected transmission | Lag / timing | What would break this link |",
  "|---|---|---|---|---|",
  "| C1 | [Cause] → [effect] | [How the effect should appear in data or price.] | [Immediate, days, weeks, quarters.] | [Specific failure condition.] |",
  "| C2 | [Cause] → [effect] | [How the effect should appear in data or price.] | [Timing.] | [Failure condition.] |",
  "| C3 | [Cause] → [effect] | [How the effect should appear in data or price.] | [Timing.] | [Failure condition.] |",
  "",
].join("\n");

/** Two regions identical apart from capitalization: ambiguous WITHOUT any fuzzy matching. */
const CASE_COLLISION = "## Alpha\n\nThe gate must fail closed.\n\n## Beta\n\nThe Gate must fail closed.\n";

// --- fixtures ---------------------------------------------------------------

type DriftFixture = {
  id: string;
  failureClass: string;
  /** Lowest policy that recovers this fixture. */
  tier: "normalized" | "fuzzy";
  source: string;
  modelQuote: string;
  trueSourceText: string;
};

/** Recovered by tiers 0+1 alone, so they pass under the DEFAULT policy. */
const DETERMINISTIC_FIXTURES: DriftFixture[] = [
  {
    id: "agentic-trade-management-01-case",
    failureClass: "case",
    tier: "normalized",
    source: ATM_FRONTMATTER,
    modelQuote: "Type: prj\nDomain: ccc\nStatus: draft\nDate_created: 2026-07-03\nDate_modified: 2026-07-11\nVersion: 0.8.4",
    trueSourceText: "type: prj\ndomain: ccc\nstatus: draft\ndate_created: 2026-07-03\ndate_modified: 2026-07-11\nversion: 0.8.4",
  },
  {
    id: "agentic-trade-management-02-whitespace",
    failureClass: "whitespace",
    tier: "normalized",
    source: ATM_FRONTMATTER,
    modelQuote: "Aliases:\n - Agentic Trade Management PRD v0.8.4\n - ATM PRD v0.8.4",
    trueSourceText: "aliases:\n  - Agentic Trade Management PRD v0.8.4\n  - ATM PRD v0.8.4",
  },
  {
    id: "route-bench-16-emphasis",
    failureClass: "emphasis",
    tier: "normalized",
    source: ROUTE_BENCH,
    modelQuote: "Tasks must be replayable: each pins a repo, a base commit, and a revert path, so every route starts from identical state.",
    trueSourceText: "Tasks must be **replayable**: each pins a repo, a base commit, and a revert path, so every route starts from identical state.",
  },
  {
    id: "session-recall-unit-17-punctuation",
    failureClass: "punctuation",
    tier: "normalized",
    source: SRU_TABLE,
    modelQuote: "Introspect the live `agent-session-search` tool through MCP metadata (`tools/list` / input schema) on the resolved route and serialize it to `tests/fixtures/agent_session_search.schema.json`. Treat th",
    trueSourceText: "Introspect the live `agent-session-search` tool through MCP metadata (`tools/list` / input schema) on the resolved route and serialize it to `tests/fixtures/agent_session_search.schema.json`. | Treat th",
  },
];

/** Need tier 2, so they resolve ONLY when the operator has enabled fuzzy matching. */
const FUZZY_FIXTURES: DriftFixture[] = [
  {
    id: "session-recall-unit-19-tense",
    failureClass: "tense",
    tier: "fuzzy",
    source: SRU_TABLE,
    modelQuote: "Hold raw output in memory only, deep-replace or structurally redacted every raw string value before display, logging, report inclusion, model exposure, or disk write, then persist only shape-safe fixt",
    trueSourceText: "Hold raw output in memory only, deep-replace or structurally redact every raw string value before display, logging, report inclusion, model exposure, or disk write, then persist only shape-safe fixt",
  },
  {
    id: "skill-hook-authoring-18-other",
    failureClass: "word substitution",
    tier: "fuzzy",
    source: SKILL_HOOK_METRICS,
    modelQuote: "The router chooses one of `skill_only`, `hook_only`, `skill_plus_hook`, `neither`, or `clarify` per fixture without free-form fallback.",
    trueSourceText: "The router chooses one of `skill_only`, `hook_only`, `skill_plus_hook`, `neither`, or `clarify` for every fixture without free-form fallback.",
  },
];

const ALL_FIXTURES = [...DETERMINISTIC_FIXTURES, ...FUZZY_FIXTURES];

/**
 * The one drift class no tier recovers, and the reason is structural rather
 * than a matter of tuning: the minimum-distance window that spans a
 * 135-character elision always loses to one that matches a fragment of the
 * tail, so lowering the threshold admits a WRONG span rather than the right
 * one. Pinned here as well as in the locator's own suite so a later session
 * cannot "fix" it by turning fuzzy on.
 */
const ELISION_QUOTE = "the four build-time probes I1–I4 stay open and labeled `[needs probe]`. Everything marked `[needs probe]` must be verified against the running system before a builder relies on it.";

const INVENTED_QUOTE = "Every route must publish a signed provenance receipt to the CCC ledger before its result is admitted.";

/** Drops the row ordinal, landing exactly one edit from both C2 and C3. */
const AMBIGUOUS_QUOTE = "| C | [Cause] → [effect] | [How the effect should appear in data or price.] | [Timing.] | [Failure condition.] |";

// --- helpers ----------------------------------------------------------------

const SOURCE_PATH = "corpus-source.md";

/** Mirrors how chunk-verification.ts calls the resolver, with the whole excerpt as the slice. */
function anchor(quote: string, sourceText: string, quoteMatchPolicy?: CccPrdQuoteMatchPolicy) {
  const source = Buffer.from(sourceText, "utf8");
  return resolveCccPrdAnchor({
    sourcePath: SOURCE_PATH,
    source,
    quote,
    entityId: "REQ-quote-drift",
    policy: "select",
    sliceBounds: { byteStart: 0, byteEnd: source.byteLength },
    quoteMatchPolicy,
  });
}

/**
 * The bytes a reader gets by slicing the source at the resolved coordinates.
 * No quote text is ever persisted, so this -- not any stored string -- is what
 * the quote resolves to for every downstream consumer.
 */
function sourceTextAtSpan(sourceText: string, span: { byteStart: number; byteEnd: number }): string {
  return Buffer.from(sourceText, "utf8").subarray(span.byteStart, span.byteEnd).toString("utf8");
}

/** Mirrors compiler.ts:409 exactly: the excerpt hash re-derived from real source bytes. */
function compilerDerivedExcerptHash(
  sourceText: string,
  span: { byteStart: number; byteEnd: number },
): string {
  return sha256(Buffer.from(sourceText, "utf8").subarray(span.byteStart, span.byteEnd));
}

function caughtError(run: () => unknown): unknown {
  try {
    run();
    return null;
  } catch (error) {
    return error;
  }
}

/** Minimal well-shaped fragment carrying a single source-bound row. */
function fragmentCiting(quote: string) {
  const empty = Object.fromEntries(IDENTITY_COLLECTIONS.map((key) => [key, []]));
  return {
    ...empty,
    schema: CCC_PRD_AUTHORING_PROPOSAL_FRAGMENT_SCHEMA_VERSION,
    requirements: [{
      id: "REQ-quote-drift",
      sourceRefs: [{ path: SOURCE_PATH, exactQuote: quote }],
    }],
  };
}

/** Drives the real §3 pipeline: containment gate, then span resolution, then coverage. */
function verifyFragment(quote: string, sourceText: string, quoteMatchPolicy?: CccPrdQuoteMatchPolicy) {
  const fullSourceBytes = Buffer.from(sourceText, "utf8");
  return verifyCccPrdChunkFragment({
    fragment: fragmentCiting(quote),
    sourcePath: SOURCE_PATH,
    fullSourceBytes,
    sliceBounds: { byteStart: 0, byteEnd: fullSourceBytes.byteLength },
    assignedMaterialItemIds: [],
    quoteMatchPolicy,
  });
}

function gateViolations(quote: string, sourceText: string, quoteMatchPolicy?: CccPrdQuoteMatchPolicy) {
  return describeCccPrdChunkQuoteOutsideSliceViolations(
    fragmentCiting(quote) as never,
    Buffer.from(sourceText, "utf8"),
    quoteMatchPolicy,
  );
}

// --- fixture self-check -----------------------------------------------------

describe("chunked-lane quote drift fixtures", () => {
  it("every fixture really is a drift: the true text is present and the model's bytes are not", () => {
    for (const fixture of ALL_FIXTURES) {
      expect(fixture.source, `${fixture.id} excerpt must hold the true text`)
        .toContain(fixture.trueSourceText);
      expect(fixture.source.includes(fixture.modelQuote), `${fixture.id} must not already match`)
        .toBe(false);
      expect(fixture.modelQuote).not.toBe(fixture.trueSourceText);
    }
  });

  it("the default policy is deterministic-only, so fuzzy is opt-in", () => {
    expect(DEFAULT_CCC_PRD_QUOTE_MATCH_POLICY.allowFuzzy).toBe(false);
    expect(DEFAULT_CCC_PRD_QUOTE_MATCH_POLICY.recordFuzzyForReview).toBe(false);
  });
});

// --- the substitution invariant, per drift class ----------------------------

describe.each(ALL_FIXTURES)(
  "$id [$failureClass, recovered at tier $tier]",
  (fixture: DriftFixture) => {
    // The deterministic fixtures must hold under the SHIPPING default; the
    // fuzzy ones are asserted with fuzzy explicitly enabled and are separately
    // proven to refuse under the default further down.
    const policy = fixture.tier === "fuzzy" ? FUZZY_SILENT : undefined;

    it("(a) the resolver returns a span instead of rejecting the quote", () => {
      expect(() => anchor(fixture.modelQuote, fixture.source, policy)).not.toThrow();
    });

    it("(b) slicing the source at the resolved coordinates yields the TRUE text", () => {
      const { span } = anchor(fixture.modelQuote, fixture.source, policy);

      expect(sourceTextAtSpan(fixture.source, span)).toBe(fixture.trueSourceText);
      expect(sourceTextAtSpan(fixture.source, span)).not.toBe(fixture.modelQuote);
      // byteEnd must come from the matched true text, never from the model's
      // quote length -- those differ for every fixture with a length drift.
      expect(span.byteEnd - span.byteStart).toBe(Buffer.byteLength(fixture.trueSourceText, "utf8"));
    });

    it("(c) the excerpt hash the compiler re-derives matches the true text, not the model's", () => {
      const { span } = anchor(fixture.modelQuote, fixture.source, policy);
      const derived = compilerDerivedExcerptHash(fixture.source, span);

      expect(derived).toBe(sha256(Buffer.from(fixture.trueSourceText, "utf8")));
      // compiler.ts:410 -- a span whose recorded hash disagrees with the hash of
      // its own source bytes is CCC_PRD_SOURCE_SPAN_STALE. Loosening the match
      // without substituting would trip exactly this.
      expect(span.excerptSha256, `${fixture.id} would go CCC_PRD_SOURCE_SPAN_STALE`).toBe(derived);
    });

    it("(d) the containment gate lets it through, or the resolver never runs", () => {
      expect(gateViolations(fixture.modelQuote, fixture.source, policy)).toEqual([]);
    });

    it("(e) the whole §3 verification pipeline resolves it end to end", () => {
      const outcome = verifyFragment(fixture.modelQuote, fixture.source, policy);

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      const span = outcome.resolved.requirements[0]!.spans[0]!;
      expect(sourceTextAtSpan(fixture.source, span)).toBe(fixture.trueSourceText);
      expect(span.excerptSha256).toBe(compilerDerivedExcerptHash(fixture.source, span));
    });
  },
);

// --- the switch: three reachable states -------------------------------------

describe("quoteMatchPolicy state 1 of 3: deterministic only (the default)", () => {
  it.each(DETERMINISTIC_FIXTURES)("recovers $id without any fuzzy matching", (fixture) => {
    const { span, receipt } = anchor(fixture.modelQuote, fixture.source);

    expect(receipt.matchStrategy).toBe("normalized");
    expect(receipt.fuzzyDrift).toBeUndefined();
    expect(sourceTextAtSpan(fixture.source, span)).toBe(fixture.trueSourceText);
  });

  it.each(FUZZY_FIXTURES)("refuses $id, because tier 2 is off by default", (fixture) => {
    const error = caughtError(() => anchor(fixture.modelQuote, fixture.source));

    expect(error).toBeInstanceOf(CccPrdCustodyError);
    expect((error as CccPrdCustodyError).code).toBe("CCC_PRD_SOURCE_QUOTE_MISSING");
  });

  it("refuses a fuzzy-only quote at the containment gate too, and says why", () => {
    const [tense] = FUZZY_FIXTURES as [DriftFixture];
    const violations = gateViolations(tense.modelQuote, tense.source);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("absent from its chunk slice");
    expect(violations[0], "the retry prompt must learn that fuzzy was disabled")
      .toContain("fuzzy matching is disabled");
  });

  it("leaves a byte-exact quote resolving exactly as it always did", () => {
    const quote = "brainstorm_status: complete";
    const { span, receipt } = anchor(quote, ATM_FRONTMATTER);

    expect(receipt.matchStrategy).toBe("exact");
    expect(receipt.appliedNormalizations).toEqual([]);
    expect(sourceTextAtSpan(ATM_FRONTMATTER, span)).toBe(quote);
    expect(span.excerptSha256).toBe(sha256(Buffer.from(quote, "utf8")));
  });
});

describe("quoteMatchPolicy state 2 of 3: fuzzy enabled, accepted silently", () => {
  it.each(FUZZY_FIXTURES)("recovers $id and records the drift without flagging it", (fixture) => {
    const { span, receipt } = anchor(fixture.modelQuote, fixture.source, FUZZY_SILENT);

    expect(receipt.matchStrategy).toBe("fuzzy");
    expect(sourceTextAtSpan(fixture.source, span)).toBe(fixture.trueSourceText);
    expect(receipt.fuzzyDrift).toBeDefined();
    // Diagnostics are always recorded; only the review FLAG is policy-driven.
    expect(receipt.fuzzyDrift!.quoteAsModelWrote).toBe(fixture.modelQuote);
    expect(receipt.fuzzyDrift!.matchedSourceText).toBe(fixture.trueSourceText);
    expect(receipt.fuzzyDrift!.score).toBeGreaterThan(0.85);
    expect(receipt.fuzzyDrift!.requiresReview).toBe(false);
  });

  it("surfaces no review notices through the verification outcome", () => {
    const [tense] = FUZZY_FIXTURES as [DriftFixture];
    const outcome = verifyFragment(tense.modelQuote, tense.source, FUZZY_SILENT);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.fuzzyReviewNotices).toEqual([]);
    expect(outcome.anchorReceipts[0]!.matchStrategy).toBe("fuzzy");
  });
});

describe("quoteMatchPolicy state 3 of 3: fuzzy enabled, every match recorded for review", () => {
  it("flags each fuzzy match on its receipt", () => {
    const [tense] = FUZZY_FIXTURES as [DriftFixture];
    const { receipt } = anchor(tense.modelQuote, tense.source, FUZZY_RECORDED);

    expect(receipt.matchStrategy).toBe("fuzzy");
    expect(receipt.fuzzyDrift!.requiresReview).toBe(true);
  });

  it("renders a notice naming BOTH the model's quote and the true source text", () => {
    const [tense] = FUZZY_FIXTURES as [DriftFixture];
    const outcome = verifyFragment(tense.modelQuote, tense.source, FUZZY_RECORDED);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.fuzzyReviewNotices).toHaveLength(1);
    const notice = outcome.fuzzyReviewNotices[0]!;
    expect(notice).toContain("REQ-quote-drift");
    expect(notice).toContain(SOURCE_PATH);
    // The whole point of recording: the two texts are side by side, so the
    // one-word difference a similarity score cannot judge stays visible.
    expect(notice, "the model's wording must survive into the notice")
      .toContain("structurally redacted every");
    expect(notice, "the true source wording must survive into the notice")
      .toContain("structurally redact every");
  });

  it("emits nothing for a deterministic match, which needs no review", () => {
    const [caseDrift] = DETERMINISTIC_FIXTURES as [DriftFixture];
    const outcome = verifyFragment(caseDrift.modelQuote, caseDrift.source, FUZZY_RECORDED);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.fuzzyReviewNotices).toEqual([]);
    expect(outcome.anchorReceipts[0]!.matchStrategy).toBe("normalized");
  });
});

// --- the receipt actually reaches a consumer --------------------------------

describe("anchor receipts reach a consumer instead of being dropped", () => {
  it("verifyCccPrdChunkFragment returns one receipt per resolved sourceRef", () => {
    const [caseDrift] = DETERMINISTIC_FIXTURES as [DriftFixture];
    const outcome = verifyFragment(caseDrift.modelQuote, caseDrift.source);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.anchorReceipts).toHaveLength(1);
    const receipt = outcome.anchorReceipts[0]!;
    expect(receipt.entityId).toBe("REQ-quote-drift");
    expect(receipt.sourcePath).toBe(SOURCE_PATH);
    expect(receipt.matchStrategy).toBe("normalized");
    expect(receipt.appliedNormalizations).toContain("lowercase");
    // Zero BYTE-EXACT occurrences is what sent this quote to the looser tier.
    expect(receipt.fileWideOccurrenceCount).toBe(0);
  });

  it("names the normalization that actually mattered, not every one it applied", () => {
    const { receipt } = anchor(
      "Tasks must be replayable: each pins a repo, a base commit, and a revert path, so every route starts from identical state.",
      ROUTE_BENCH,
    );

    expect(receipt.appliedNormalizations).toEqual(["stripEmphasis"]);
  });
});

// --- refusals that must stay refusals ---------------------------------------

describe("chunked-lane quote drift: negative controls", () => {
  it("returns notFound for an invented quote, in every switch state", () => {
    for (const policy of [undefined, FUZZY_SILENT, FUZZY_RECORDED]) {
      const error = caughtError(() => anchor(INVENTED_QUOTE, ROUTE_BENCH, policy));

      expect(error).toBeInstanceOf(CccPrdCustodyError);
      expect((error as CccPrdCustodyError).code).toBe("CCC_PRD_SOURCE_QUOTE_MISSING");
    }
  });

  it("still refuses the ~135-character elision even with fuzzy fully enabled", () => {
    const trueSpan = "the four build-time probes I1–I4 stay open and labeled `[needs probe]`. Everything marked `[SSOT-derived]` comes from [[00_MAIN/00_RyanSSOT/REF-HUM-RyanFinalStackSSOT|Ryan Stack SSOT]] without a live probe; everything marked `[needs probe]` must be verified against the running system before a builder relies on it.";
    expect(EXPANSION_PARAGRAPH).toContain(trueSpan);

    const error = caughtError(() => anchor(ELISION_QUOTE, EXPANSION_PARAGRAPH, FUZZY_RECORDED));

    expect(error).toBeInstanceOf(CccPrdCustodyError);
    expect((error as CccPrdCustodyError).code).toBe("CCC_PRD_SOURCE_QUOTE_MISSING");
  });

  it("refuses an ambiguous fuzzy match loudly, naming BOTH candidates with previews", () => {
    let resolved: string | null = null;
    const error = caughtError(() => {
      const { span } = anchor(AMBIGUOUS_QUOTE, TPL_THESIS_TABLE, FUZZY_SILENT);
      resolved = sourceTextAtSpan(TPL_THESIS_TABLE, span);
      return resolved;
    });

    expect(resolved, "silently picking one candidate would fabricate the model's intent").toBeNull();
    expect(error).toBeInstanceOf(CccPrdCustodyError);
    expect((error as CccPrdCustodyError).code).toBe("CCC_PRD_ANCHOR_QUOTE_AMBIGUOUS_MATCH");

    const message = (error as CccPrdCustodyError).message;
    // Pipe stripping means a table-row span opens at the cell content, so the
    // preview starts at the ordinal rather than at the leading "|".
    expect(message, "the refusal must show the first competing candidate")
      .toContain("C2 | [Cause] → [effect]");
    expect(message, "the refusal must show the second competing candidate")
      .toContain("C3 | [Cause] → [effect]");
    expect(message).toContain("candidate 1");
    expect(message).toContain("candidate 2");
  });

  it("refuses an ambiguous NORMALIZED match too, with fuzzy off", () => {
    const error = caughtError(() => anchor("the gate MUST fail closed.", CASE_COLLISION));

    expect(error).toBeInstanceOf(CccPrdCustodyError);
    expect((error as CccPrdCustodyError).code).toBe("CCC_PRD_ANCHOR_QUOTE_AMBIGUOUS_MATCH");
    const message = (error as CccPrdCustodyError).message;
    expect(message).toContain("The gate must fail closed.");
    expect(message).toContain("The Gate must fail closed.");
  });

  it("carries the ambiguity refusal out as a RETRY-ELIGIBLE verification failure", () => {
    // A model can fix this by quoting whatever distinguishes the rows, so the
    // chunk must retry rather than die -- the code has to be in the
    // retry-eligible set alongside the older ambiguity code.
    const outcome = verifyFragment(AMBIGUOUS_QUOTE, TPL_THESIS_TABLE, FUZZY_SILENT);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("CCC_PRD_ANCHOR_QUOTE_AMBIGUOUS_MATCH");
    expect(outcome.retryEligible).toBe(true);
    expect(outcome.violations.join(" ")).toContain("C3 | [Cause] → [effect]");
  });
});
