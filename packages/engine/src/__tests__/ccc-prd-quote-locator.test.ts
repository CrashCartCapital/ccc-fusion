import { describe, expect, it } from "vitest";
import {
  DEFAULT_CCC_PRD_QUOTE_AMBIGUITY_EPSILON,
  DEFAULT_CCC_PRD_QUOTE_FUZZY_THRESHOLD,
  locateCccPrdQuote,
  type CccPrdQuoteLocation,
} from "../ccc-prd/quote-locator.js";

/**
 * Every drift class exercised here is REAL: each model quote was copied out of
 * `.smoke-scratch/wave6/quote-failure-fixtures.json`, which a parallel session
 * extracted from two full corpus runs, and each haystack embeds the verbatim
 * source excerpt the quote drifted away from. The excerpts are inlined rather
 * than read from `.smoke-scratch/` so this file stays hermetic.
 *
 * The scores asserted below were measured with
 * `.smoke-scratch/wave6/measure-locator.mts` against the full corpus documents;
 * see `.smoke-scratch/wave6/locator-report.md` for the derivation of the
 * default threshold and epsilon.
 */

/** The whole point of the module: the span must yield TRUE source bytes. */
function recovered(haystack: Buffer, location: CccPrdQuoteLocation): string {
  if (location.kind === "ambiguous" || location.kind === "notFound") {
    throw new Error(`expected a located span, got ${location.kind}`);
  }
  return haystack.subarray(location.byteStart, location.byteEnd).toString("utf8");
}

/**
 * A span that bisects a UTF-8 sequence decodes with U+FFFD replacement
 * characters, so a clean round trip through the buffer proves the bounds sit on
 * real character boundaries.
 */
function slicesCleanly(haystack: Buffer, byteStart: number, byteEnd: number): boolean {
  const slice = haystack.subarray(byteStart, byteEnd);
  return Buffer.from(slice.toString("utf8"), "utf8").equals(slice);
}

// --- real corpus excerpts ---------------------------------------------------

/** PRODPRD-atm-v0.8.4.md lines 1-28, verbatim. */
const ATM_FRONTMATTER = Buffer.from(
  [
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
    "brainstorm_topic: agentic trade management PRD",
    'source_prd: "[[PRODPRD-atm-v0.8.3]]"',
    'supersedes: "[[PRODPRD-atm-v0.8.3]]"',
    'source_change_plan: "[[REF-AI-AgenticTradeManagement-PRD-ChangePlan-to-v0.8.4-ATM-20260710-C01-R7]]"',
    "---",
    "",
    "## Purpose",
    "",
    "This PRD governs agentic trade management.",
    "",
  ].join("\n"),
  "utf8",
);

/** PRJ-HUM-RouteBench-PRD-v0.1.md lines 38-42, verbatim (note the em dashes). */
const ROUTE_BENCH = Buffer.from(
  [
    "Pinned tasks drawn from real repositories, each with a **mechanical pass condition** — a test that goes red then green. Without that, grading needs a human and the harness dies of friction.",
    "",
    "Target roughly 12–15 tasks across the shapes that actually recur: single-file bug with a failing test; multi-file feature behind an interface.",
    "",
    "Tasks must be **replayable**: each pins a repo, a base commit, and a revert path, so every route starts from identical state.",
    "",
  ].join("\n"),
  "utf8",
);

/** sru-prd-v0.4.0.md lines 76-77, verbatim table rows (truncated to the cells under test). */
const SRU_TABLE = Buffer.from(
  [
    "| Tool schema capture | Introspect the live `agent-session-search` tool through MCP metadata (`tools/list` / input schema) on the resolved route and serialize it to `tests/fixtures/agent_session_search.schema.json`. | Treat the committed live capture as authoritative over field names, but require the minimum capabilities this PRD depends on. |",
    "| Safe response-shape capture | Run exactly one small candidate-scan probe after transport discovery. Hold raw output in memory only, deep-replace or structurally redact every raw string value before display, logging, report inclusion, model exposure, or disk write, then persist only shape-safe fixtures under `tests/fixtures/`. | This throwaway shape-capture utility is not the final sanitizer. |",
    "",
  ].join("\n"),
  "utf8",
);

/** PRJ-PRDExpansionEngine-ExecutionPRD-v0.2.md line 30, verbatim (en dashes in C1–C5 / I1–I4). */
const EXPANSION_PARAGRAPH = Buffer.from(
  [
    "Status: draft; this version is the **implementation contract**. It applies the Ryan-approved B2 change plan (2026-07-08): all five product decisions C1–C5 are resolved and folded in, and the four build-time probes I1–I4 stay open and labeled `[needs probe]`. Everything marked `[SSOT-derived]` comes from [[00_MAIN/00_RyanSSOT/REF-HUM-RyanFinalStackSSOT|Ryan Stack SSOT]] without a live probe; everything marked `[needs probe]` must be verified against the running system before a builder relies on it.",
    "",
  ].join("\n"),
  "utf8",
);

/** v0.1.6-SkillHookAuthoringPipeline-PRODPRD.md line 71, verbatim. */
const SKILL_HOOK_METRICS = Buffer.from(
  [
    "Success metrics for MVP:",
    "",
    "- The router chooses one of `skill_only`, `hook_only`, `skill_plus_hook`, `neither`, or `clarify` for every fixture without free-form fallback.",
    "- Every generated readiness packet has valid frontmatter, exactly one H1, and no unvalidated runtime claim marked ready.",
    "",
  ].join("\n"),
  "utf8",
);

/** TPL-Thesis.md lines 115-119, verbatim. Rows C2 and C3 differ only by ordinal. */
const TPL_THESIS_TABLE = Buffer.from(
  [
    "| ID | Causal link | Expected transmission | Lag / timing | What would break this link |",
    "|---|---|---|---|---|",
    "| C1 | [Cause] → [effect] | [How the effect should appear in data or price.] | [Immediate, days, weeks, quarters.] | [Specific failure condition.] |",
    "| C2 | [Cause] → [effect] | [How the effect should appear in data or price.] | [Timing.] | [Failure condition.] |",
    "| C3 | [Cause] → [effect] | [How the effect should appear in data or price.] | [Timing.] | [Failure condition.] |",
    "",
  ].join("\n"),
  "utf8",
);

// --- tier 0 -----------------------------------------------------------------

describe("locateCccPrdQuote tier 0 (exact bytes)", () => {
  it("returns exact bounds for a byte-identical quote", () => {
    const quote = "source_prd: \"[[PRODPRD-atm-v0.8.3]]\"";
    const result = locateCccPrdQuote(ATM_FRONTMATTER, quote);

    expect(result.kind).toBe("exact");
    expect(recovered(ATM_FRONTMATTER, result)).toBe(quote);
    expect(ATM_FRONTMATTER.indexOf(Buffer.from(quote, "utf8"))).toBe(
      result.kind === "exact" ? result.byteStart : -1,
    );
  });
});

// --- tier 1: the four normalizations, one real drift class each -------------

describe("locateCccPrdQuote tier 1 (normalized projection)", () => {
  it("recovers capitalization drift and reports lowercase as the only strategy that mattered", () => {
    // fixture agentic-trade-management-01-case: the model title-cased every key.
    const modelQuote =
      "Type: prj\nDomain: ccc\nStatus: draft\nDate_created: 2026-07-03\nDate_modified: 2026-07-11\nVersion: 0.8.4";
    const trueSource =
      "type: prj\ndomain: ccc\nstatus: draft\ndate_created: 2026-07-03\ndate_modified: 2026-07-11\nversion: 0.8.4";

    const result = locateCccPrdQuote(ATM_FRONTMATTER, modelQuote);

    expect(result.kind).toBe("normalized");
    expect(recovered(ATM_FRONTMATTER, result)).toBe(trueSource);
    // Substitution actually happened: the stored bytes are NOT the model's.
    expect(recovered(ATM_FRONTMATTER, result)).not.toBe(modelQuote);
    if (result.kind === "normalized") {
      expect(result.appliedStrategies).toEqual(["lowercase"]);
    }
  });

  it("recovers a v0.5.0 -> V0.5.0 style single-letter capitalization drift", () => {
    const haystack = Buffer.from(
      "## Version history\n\nv0.5.0 is the bounded convergence repair: it unifies requirement IDs.\n",
      "utf8",
    );
    const result = locateCccPrdQuote(
      haystack,
      "V0.5.0 is the bounded convergence repair: it unifies requirement IDs.",
    );

    expect(result.kind).toBe("normalized");
    expect(recovered(haystack, result)).toBe(
      "v0.5.0 is the bounded convergence repair: it unifies requirement IDs.",
    );
  });

  it("recovers whitespace drift where the model reindented a YAML list", () => {
    // fixture agentic-trade-management-02-whitespace: two-space indent became one.
    const modelQuote = "Aliases:\n - Agentic Trade Management PRD v0.8.4\n - ATM PRD v0.8.4";
    const trueSource = "aliases:\n  - Agentic Trade Management PRD v0.8.4\n  - ATM PRD v0.8.4";

    const result = locateCccPrdQuote(ATM_FRONTMATTER, modelQuote);

    expect(result.kind).toBe("normalized");
    expect(recovered(ATM_FRONTMATTER, result)).toBe(trueSource);
    if (result.kind === "normalized") {
      expect(result.appliedStrategies).toEqual(["lowercase", "collapseWhitespace"]);
    }
  });

  it("recovers a tags: -> Tags: drift together with its reindented list", () => {
    // fixture agentic-trade-management-03-whitespace.
    const result = locateCccPrdQuote(
      ATM_FRONTMATTER,
      "Tags:\n - trading\n - trade-management\n - agentic-trade-management\n - prd",
    );

    expect(result.kind).toBe("normalized");
    expect(recovered(ATM_FRONTMATTER, result)).toBe(
      "tags:\n  - trading\n  - trade-management\n  - agentic-trade-management\n  - prd",
    );
  });

  it("recovers stripped markdown emphasis and restores the ** markers", () => {
    // fixture route-bench-16-emphasis: **replayable** came back as replayable.
    const modelQuote =
      "Tasks must be replayable: each pins a repo, a base commit, and a revert path, so every route starts from identical state.";
    const trueSource =
      "Tasks must be **replayable**: each pins a repo, a base commit, and a revert path, so every route starts from identical state.";

    const result = locateCccPrdQuote(ROUTE_BENCH, modelQuote);

    expect(result.kind).toBe("normalized");
    expect(recovered(ROUTE_BENCH, result)).toBe(trueSource);
    expect(recovered(ROUTE_BENCH, result)).toContain("**replayable**");
    if (result.kind === "normalized") {
      expect(result.appliedStrategies).toEqual(["stripEmphasis"]);
    }
  });

  it("recovers a swallowed table pipe after ~192 verbatim characters", () => {
    // fixture session-recall-unit-17-punctuation: ". | Treat" came back as ". Treat".
    const modelQuote =
      "Introspect the live `agent-session-search` tool through MCP metadata (`tools/list` / input schema) on the resolved route and serialize it to `tests/fixtures/agent_session_search.schema.json`. Treat the committed live capture as authoritative over field names";
    const trueSource =
      "Introspect the live `agent-session-search` tool through MCP metadata (`tools/list` / input schema) on the resolved route and serialize it to `tests/fixtures/agent_session_search.schema.json`. | Treat the committed live capture as authoritative over field names";

    const result = locateCccPrdQuote(SRU_TABLE, modelQuote);

    expect(result.kind).toBe("normalized");
    expect(recovered(SRU_TABLE, result)).toBe(trueSource);
    expect(recovered(SRU_TABLE, result)).toContain(". | Treat");
    if (result.kind === "normalized") {
      expect(result.appliedStrategies).toEqual(["collapseWhitespace", "stripTablePipes"]);
    }
  });
});

// --- tier 2 -----------------------------------------------------------------

describe("locateCccPrdQuote tier 2 (fuzzy)", () => {
  it("recovers the redact -> redacted verb tense drift and substitutes the true tense", () => {
    // fixture session-recall-unit-19-tense.
    const modelQuote =
      "Hold raw output in memory only, deep-replace or structurally redacted every raw string value before display, logging, report inclusion, model exposure, or disk write, then persist only shape-safe fixt";
    const trueSource =
      "Hold raw output in memory only, deep-replace or structurally redact every raw string value before display, logging, report inclusion, model exposure, or disk write, then persist only shape-safe fixt";

    const result = locateCccPrdQuote(SRU_TABLE, modelQuote);

    expect(result.kind).toBe("fuzzy");
    expect(recovered(SRU_TABLE, result)).toBe(trueSource);
    expect(recovered(SRU_TABLE, result)).toContain("structurally redact every");
    if (result.kind === "fuzzy") {
      // Measured against the full corpus document: 0.9900.
      expect(result.score).toBeGreaterThan(0.98);
      expect(result.score).toBeLessThanOrEqual(1);
    }
  });

  it("recovers a multi-word substitution drift (per fixture -> for every fixture)", () => {
    // fixture skill-hook-authoring-18-other, the lowest-scoring drift we accept.
    const modelQuote =
      "The router chooses one of `skill_only`, `hook_only`, `skill_plus_hook`, `neither`, or `clarify` per fixture without free-form fallback.";
    const trueSource =
      "The router chooses one of `skill_only`, `hook_only`, `skill_plus_hook`, `neither`, or `clarify` for every fixture without free-form fallback.";

    const result = locateCccPrdQuote(SKILL_HOOK_METRICS, modelQuote);

    expect(result.kind).toBe("fuzzy");
    expect(recovered(SKILL_HOOK_METRICS, result)).toBe(trueSource);
    if (result.kind === "fuzzy") {
      // Measured 0.9449; it must clear the 0.85 default with room to spare.
      expect(result.score).toBeGreaterThan(DEFAULT_CCC_PRD_QUOTE_FUZZY_THRESHOLD);
    }
  });

  it("refuses the ~135-character elision, which tier 2 cannot recover at ANY threshold", () => {
    // fixture prd-expansion-engine-15-elision. The model spliced two real halves
    // together, dropping 135 characters of real source from the middle.
    //
    // This is the one drift class the approved tiers do not handle, and the
    // reason is structural rather than a matter of tuning. Sellers' algorithm
    // returns the MINIMUM-distance window: spanning the 135-character gap costs
    // 135 insertions, whereas matching only the needle's tail costs far fewer
    // edits. So the best-scoring window is always a fragment, never the spliced
    // whole. Lowering the threshold does not recover the true span -- it admits
    // a wrong one. See locator-report.md.
    const modelQuote =
      "the four build-time probes I1–I4 stay open and labeled `[needs probe]`. Everything marked `[needs probe]` must be verified against the running system before a builder relies on it.";
    const trueSpan =
      "the four build-time probes I1–I4 stay open and labeled `[needs probe]`. Everything marked `[SSOT-derived]` comes from [[00_MAIN/00_RyanSSOT/REF-HUM-RyanFinalStackSSOT|Ryan Stack SSOT]] without a live probe; everything marked `[needs probe]` must be verified against the running system before a builder relies on it.";
    expect(EXPANSION_PARAGRAPH.includes(Buffer.from(trueSpan, "utf8"))).toBe(true);

    // The default refuses, which is the safe outcome.
    expect(locateCccPrdQuote(EXPANSION_PARAGRAPH, modelQuote).kind).toBe("notFound");

    // Relaxing the threshold does NOT rescue it. Pin that, so a later session
    // cannot "fix" the elision by turning the threshold down.
    const relaxed = locateCccPrdQuote(EXPANSION_PARAGRAPH, modelQuote, { fuzzyThreshold: 0.5 });
    expect(relaxed.kind).toBe("fuzzy");
    if (relaxed.kind !== "fuzzy") return;
    const span = recovered(EXPANSION_PARAGRAPH, relaxed);
    expect(span).not.toBe(trueSpan);
    expect(span).not.toContain("the four build-time probes");
    // Measured 0.7216 -- and a paraphrase control scores 0.7196, only 0.0020
    // lower, so no threshold separates this class from outright fabrication.
    expect(relaxed.score).toBeGreaterThan(0.71);
    expect(relaxed.score).toBeLessThan(0.73);
    expect(relaxed.score).toBeLessThan(DEFAULT_CCC_PRD_QUOTE_FUZZY_THRESHOLD);

    // Whatever it does return is still TRUE source bytes -- the invariant holds
    // even when the tier is refusing to be useful.
    expect(EXPANSION_PARAGRAPH.includes(Buffer.from(span, "utf8"))).toBe(true);
  });
});

// --- uniqueness guard -------------------------------------------------------

describe("locateCccPrdQuote uniqueness guard", () => {
  it("returns ambiguous naming BOTH adjacent table rows rather than picking one", () => {
    // negative fixture negative-02-ambiguous: the model dropped the row ordinal,
    // landing exactly one edit from both C2 and C3.
    const modelQuote =
      "| C | [Cause] → [effect] | [How the effect should appear in data or price.] | [Timing.] | [Failure condition.] |";

    const result = locateCccPrdQuote(TPL_THESIS_TABLE, modelQuote);

    expect(result.kind).toBe("ambiguous");
    if (result.kind !== "ambiguous") return;
    expect(result.candidates.length).toBeGreaterThanOrEqual(2);

    // The leading "|" is not part of the span: pipe stripping means the first
    // matchable character of the row is the ordinal itself.
    const previews = result.candidates.map((candidate) => candidate.preview);
    expect(previews.some((preview) => preview.startsWith("C2 |"))).toBe(true);
    expect(previews.some((preview) => preview.startsWith("C3 |"))).toBe(true);

    // Both candidates must be real, disjoint, true-source spans.
    for (const candidate of result.candidates) {
      const text = TPL_THESIS_TABLE.subarray(candidate.byteStart, candidate.byteEnd).toString("utf8");
      expect(TPL_THESIS_TABLE.includes(Buffer.from(text, "utf8"))).toBe(true);
      expect(candidate.score).toBeGreaterThan(DEFAULT_CCC_PRD_QUOTE_FUZZY_THRESHOLD);
    }
    const [first, second] = result.candidates as [
      { byteStart: number; byteEnd: number; score: number },
      { byteStart: number; byteEnd: number; score: number },
    ];
    expect(first.byteEnd).toBeLessThanOrEqual(second.byteStart);
    expect(Math.abs(first.score - second.score)).toBeLessThanOrEqual(
      DEFAULT_CCC_PRD_QUOTE_AMBIGUITY_EPSILON,
    );
  });

  it("returns ambiguous when a normalized quote lands on two identical regions", () => {
    const haystack = Buffer.from(
      "## Alpha\n\nThe gate must fail closed.\n\n## Beta\n\nThe Gate must fail closed.\n",
      "utf8",
    );
    const result = locateCccPrdQuote(haystack, "the gate MUST fail closed.");

    expect(result.kind).toBe("ambiguous");
    if (result.kind !== "ambiguous") return;
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.map((candidate) => candidate.preview)).toEqual([
      "The gate must fail closed.",
      "The Gate must fail closed.",
    ]);
  });
});

// --- invented quotes --------------------------------------------------------

describe("locateCccPrdQuote refusals", () => {
  it("returns notFound for an invented quote that appears nowhere in the source", () => {
    // negative fixture negative-01-invented: plausible PRD prose, measured 0.3366.
    const result = locateCccPrdQuote(
      ROUTE_BENCH,
      "Every route must publish a signed provenance receipt to the CCC ledger before its result is admitted.",
    );
    expect(result.kind).toBe("notFound");
  });

  it("returns notFound for a real sentence taken from a different document", () => {
    const result = locateCccPrdQuote(
      ROUTE_BENCH,
      "everything marked `[needs probe]` must be verified against the running system before a builder relies on it.",
    );
    expect(result.kind).toBe("notFound");
  });

  it("returns notFound for an empty needle and for an empty haystack", () => {
    expect(locateCccPrdQuote(ROUTE_BENCH, "").kind).toBe("notFound");
    expect(locateCccPrdQuote(Buffer.alloc(0), "anything").kind).toBe("notFound");
  });
});

// --- multi-byte UTF-8 -------------------------------------------------------

describe("locateCccPrdQuote multi-byte UTF-8 safety", () => {
  it("returns byte offsets, not character offsets, past a run of multi-byte characters", () => {
    // Em dash (3 bytes), en dash (3 bytes), CJK (3 bytes each), emoji (4 bytes).
    const haystack = Buffer.from(
      "Preface — 12–15 任务 🚀 marker.\nTarget line must fail closed.\n",
      "utf8",
    );
    const target = "Target line must fail closed.";
    const result = locateCccPrdQuote(haystack, "target LINE must fail closed.");

    expect(result.kind).toBe("normalized");
    expect(recovered(haystack, result)).toBe(target);
    if (result.kind !== "normalized") return;
    // The byte offset must exceed the character offset, or the offset map is
    // silently treating multi-byte characters as one byte wide.
    const charOffset = haystack.toString("utf8").indexOf(target);
    expect(result.byteStart).toBeGreaterThan(charOffset);
    expect(result.byteStart).toBe(haystack.indexOf(Buffer.from(target, "utf8")));
    expect(slicesCleanly(haystack, result.byteStart, result.byteEnd)).toBe(true);
  });

  it("never bisects a multi-byte character when the span starts or ends on one", () => {
    const haystack = Buffer.from("prefix 🚀 — 任务 suffix\n", "utf8");
    const result = locateCccPrdQuote(haystack, "🚀 — 任务");

    expect(result.kind).toBe("exact");
    expect(recovered(haystack, result)).toBe("🚀 — 任务");
    if (result.kind !== "exact") return;
    expect(slicesCleanly(haystack, result.byteStart, result.byteEnd)).toBe(true);
    // A 4-byte emoji at the span head: byteEnd - byteStart must count bytes.
    expect(result.byteEnd - result.byteStart).toBe(Buffer.byteLength("🚀 — 任务", "utf8"));
    expect(result.byteEnd - result.byteStart).toBeGreaterThan("🚀 — 任务".length);
  });

  it("keeps offsets clean through normalization that deletes multi-byte neighbours", () => {
    // The stripped characters sit directly against multi-byte content, so a
    // sloppy offset map would land byteStart inside the en dash.
    const haystack = Buffer.from("row: **12–15 任务** per week\n", "utf8");
    const result = locateCccPrdQuote(haystack, "12–15 任务");

    expect(result.kind).toBe("exact");
    expect(recovered(haystack, result)).toBe("12–15 任务");

    const drifted = locateCccPrdQuote(haystack, "12–15 任务 PER week");
    expect(drifted.kind).toBe("normalized");
    expect(recovered(haystack, drifted)).toBe("12–15 任务** per week");
    if (drifted.kind !== "normalized") return;
    expect(slicesCleanly(haystack, drifted.byteStart, drifted.byteEnd)).toBe(true);
  });

  it("keeps real en-dash-bearing corpus prose intact through a drifted match", () => {
    // Two en dashes (C1–C5, I1–I4) inside the matched region, plus stripped
    // emphasis and case drift, all in one real sentence.
    const result = locateCccPrdQuote(
      EXPANSION_PARAGRAPH,
      "all five product decisions C1–C5 are RESOLVED and folded in, and the four build-time probes I1–I4 stay open",
    );

    expect(result.kind).toBe("normalized");
    expect(recovered(EXPANSION_PARAGRAPH, result)).toBe(
      "all five product decisions C1–C5 are resolved and folded in, and the four build-time probes I1–I4 stay open",
    );
    if (result.kind !== "normalized") return;
    expect(slicesCleanly(EXPANSION_PARAGRAPH, result.byteStart, result.byteEnd)).toBe(true);
    expect(recovered(EXPANSION_PARAGRAPH, result)).toContain("I1–I4");
    expect(recovered(EXPANSION_PARAGRAPH, result)).toContain("C1–C5");
  });
});

// --- cross-cutting invariants ----------------------------------------------

describe("locateCccPrdQuote invariants", () => {
  const cases: Array<{ label: string; haystack: Buffer; quote: string }> = [
    { label: "exact", haystack: ATM_FRONTMATTER, quote: "brainstorm_status: complete" },
    {
      label: "case drift",
      haystack: ATM_FRONTMATTER,
      quote: "Brainstorm_status: complete\nBrainstorm_topic: agentic trade management PRD",
    },
    {
      label: "whitespace drift",
      haystack: ATM_FRONTMATTER,
      quote: "Aliases:\n - Agentic Trade Management PRD v0.8.4\n - ATM PRD v0.8.4",
    },
    {
      label: "emphasis drift",
      haystack: ROUTE_BENCH,
      quote:
        "Tasks must be replayable: each pins a repo, a base commit, and a revert path, so every route starts from identical state.",
    },
    {
      label: "tense drift",
      haystack: SRU_TABLE,
      quote:
        "Hold raw output in memory only, deep-replace or structurally redacted every raw string value before display, logging, report inclusion, model exposure, or disk write, then persist only shape-safe fixt",
    },
  ];

  for (const testCase of cases) {
    it(`keeps byteStart/byteEnd inside the original haystack for ${testCase.label}`, () => {
      const result = locateCccPrdQuote(testCase.haystack, testCase.quote);
      expect(["exact", "normalized", "fuzzy"]).toContain(result.kind);
      if (result.kind === "ambiguous" || result.kind === "notFound") return;

      expect(result.byteStart).toBeGreaterThanOrEqual(0);
      expect(result.byteEnd).toBeLessThanOrEqual(testCase.haystack.byteLength);
      expect(result.byteStart).toBeLessThan(result.byteEnd);
      expect(slicesCleanly(testCase.haystack, result.byteStart, result.byteEnd)).toBe(true);
      // The recovered text really occurs in the source at those bounds.
      const text = testCase.haystack.subarray(result.byteStart, result.byteEnd);
      expect(testCase.haystack.indexOf(text)).toBeGreaterThanOrEqual(0);
    });
  }

  it("restricts the search to searchBounds while reporting whole-haystack offsets", () => {
    const secondRowStart = TPL_THESIS_TABLE.indexOf(Buffer.from("| C3 |", "utf8"));
    const result = locateCccPrdQuote(
      TPL_THESIS_TABLE,
      "| C | [Cause] → [effect] | [How the effect should appear in data or price.] | [Timing.] | [Failure condition.] |",
      { searchBounds: { byteStart: secondRowStart, byteEnd: TPL_THESIS_TABLE.byteLength } },
    );

    // Scoping away the C2 row resolves the ambiguity that the full table has.
    expect(result.kind).toBe("fuzzy");
    if (result.kind !== "fuzzy") return;
    expect(result.byteStart).toBeGreaterThanOrEqual(secondRowStart);
    expect(recovered(TPL_THESIS_TABLE, result)).toContain("C3 |");
    expect(recovered(TPL_THESIS_TABLE, result)).not.toContain("C2 |");
  });

  it("skips tier 2 entirely when fuzzy matching is disabled", () => {
    const quote =
      "Hold raw output in memory only, deep-replace or structurally redacted every raw string value before display, logging, report inclusion, model exposure, or disk write, then persist only shape-safe fixt";
    expect(locateCccPrdQuote(SRU_TABLE, quote).kind).toBe("fuzzy");
    expect(locateCccPrdQuote(SRU_TABLE, quote, { disableFuzzy: true }).kind).toBe("notFound");
  });

  it("reports no strategy as applied when tier 0 already matched", () => {
    const result = locateCccPrdQuote(ATM_FRONTMATTER, "version: 0.8.4");
    expect(result.kind).toBe("exact");
    expect(result).not.toHaveProperty("appliedStrategies");
  });
});
