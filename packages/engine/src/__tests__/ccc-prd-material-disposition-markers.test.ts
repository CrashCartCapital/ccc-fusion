import { describe, expect, it } from "vitest";
import { analyzeCccPrdMaterialCoverage } from "../ccc-prd/material-coverage.js";

/**
 * Every heading string below is copied verbatim from the real vault corpus
 * (`01_ActiveProjects/ccc-lab-super` and `.../ccc-fusion`, 144 files / 2965
 * headings). A corpus scan found 221 headings matching the disposition markers,
 * of which 176 matched only because an ancestor heading mentioned a marker word
 * and 7 more because the marker was one conjunct of a compound heading.
 *
 * A disposition marker is load-bearing: matching it makes the item vanish from
 * `missing` with no task, requirement, or unresolved decision behind it. A false
 * positive is therefore silent under-coverage, while a false negative only
 * pushes the item into `missing`, which refuses loudly and is recoverable.
 */

const SOURCE_PATH = "doc.md";

function analyze(markdown: string) {
  const bytes = Buffer.from(markdown, "utf8");
  return analyzeCccPrdMaterialCoverage({
    sourceBytes: new Map([[SOURCE_PATH, bytes]]),
    requirements: [],
    tasks: [],
    unresolvedDecisions: [],
  });
}

/** "explicit_deferral" | "out_of_scope" | "missing" | ... for one section heading. */
function dispositionOf(markdown: string, title: string): string {
  const analysis = analyze(markdown);
  const covered = analysis.coverage.find(
    (item) => item.materialKind === "section" && item.title === title,
  );
  if (covered) return covered.disposition.kind;
  if (analysis.missing.some((item) => item.materialKind === "section" && item.title === title)) {
    return "missing";
  }
  if (analysis.conflicts.some((item) => item.materialKind === "section" && item.title === title)) {
    return "conflicted";
  }
  return "absent-from-inventory";
}

describe("ccc-prd material disposition markers", () => {
  describe("false positives: a heading ABOUT deferred/out-of-scope material is not itself disposed", () => {
    it("does not let a registry H1 blanket-defer every section beneath it", () => {
      // PRJ-AI-CCC-DuckLake-v7.2.3-Deferred-Decision-Registry.md. This single H1
      // currently disposes 116 descendant sections in the live corpus.
      const markdown = [
        "# CCC DuckLake v7.2.3 deferred-decision registry",
        "",
        "Registry of decisions that were deferred, and the rules for reopening them.",
        "",
        "## DD-001 — Committee authority",
        "",
        "The committee holds binding authority over v7.2.3 admission.",
        "",
      ].join("\n");

      expect(dispositionOf(markdown, "DD-001 — Committee authority")).toBe("missing");
      expect(dispositionOf(markdown, "CCC DuckLake v7.2.3 deferred-decision registry")).toBe("missing");
    });

    it("does not let a non-goal guardrail heading blanket-exclude the requirements under it", () => {
      // PRJ-AI-CCC-DuckLake-v7.2.3-Architecture-Context-And-Bootstrap.md.
      // These are real REQ-GUARD requirements, not excluded material.
      const markdown = [
        "# CCC DuckLake v7.2.3 Architecture Context And Bootstrap",
        "",
        "Context preamble.",
        "",
        "## Non-Goal Guardrail Requirements",
        "",
        "Guardrails that keep the build inside its declared envelope.",
        "",
        "### Structural Hygiene Guardrails",
        "",
        "Hygiene rules the implementation must satisfy.",
        "",
      ].join("\n");

      expect(dispositionOf(markdown, "Non-Goal Guardrail Requirements")).toBe("missing");
      expect(dispositionOf(markdown, "Structural Hygiene Guardrails")).toBe("missing");
    });

    it("does not dispose a compound heading where only one conjunct is a marker", () => {
      // PRJ-AI-CCC-DuckLake-v7.2.3-Executive-Contract-And-Authority.md.
      // "Core Decision" is in-scope material sharing a heading with "Non-Goals".
      const markdown = [
        "# CCC DuckLake v7.2.3 Executive Contract And Authority",
        "",
        "Contract preamble.",
        "",
        "## Core Decision And Non-Goals",
        "",
        "The core decision is to adopt DuckLake as the canonical store.",
        "",
        "### Non-Goals",
        "",
        "Realtime tick capture is not part of this release.",
        "",
      ].join("\n");

      expect(dispositionOf(markdown, "Core Decision And Non-Goals")).toBe("missing");
    });
  });

  describe("true positives: a heading that declares disposition and nothing else still disposes", () => {
    it("keeps a standalone Non-Goals section out of scope", () => {
      const markdown = [
        "# CCC DuckLake v7.2.3 Executive Contract And Authority",
        "",
        "Contract preamble.",
        "",
        "## Core Decision And Non-Goals",
        "",
        "The core decision is to adopt DuckLake as the canonical store.",
        "",
        "### Non-Goals",
        "",
        "Realtime tick capture is not part of this release.",
        "",
      ].join("\n");

      expect(dispositionOf(markdown, "Non-Goals")).toBe("out_of_scope");
    });

    it("still inherits disposition from an ancestor that declares it purely", () => {
      const markdown = [
        "# Roadmap",
        "",
        "Roadmap preamble.",
        "",
        "## Out of Scope",
        "",
        "Everything below is excluded from this release.",
        "",
        "### Realtime tick capture",
        "",
        "Not built in this release.",
        "",
      ].join("\n");

      expect(dispositionOf(markdown, "Out of Scope")).toBe("out_of_scope");
      expect(dispositionOf(markdown, "Realtime tick capture")).toBe("out_of_scope");
    });
  });

  describe("false negatives: inflected forms of a marker still declare disposition", () => {
    it("treats a plural 'Later Phases' heading as deferred", () => {
      const markdown = [
        "# Roadmap",
        "",
        "Roadmap preamble.",
        "",
        "## Later Phases",
        "",
        "Pushed beyond the current release.",
        "",
      ].join("\n");

      expect(dispositionOf(markdown, "Later Phases")).toBe("explicit_deferral");
    });

    it("treats a nominalised 'Deferrals' heading as deferred", () => {
      // "Deferrals" appears in REF-AI-DuckLake-v7.2.3-AdjudicationLedger.md and is
      // invisible to a /\bdeferred\b/ match.
      const markdown = [
        "# Adjudication ledger",
        "",
        "Ledger preamble.",
        "",
        "## Deferrals",
        "",
        "Items adjudicated as deferred.",
        "",
      ].join("\n");

      expect(dispositionOf(markdown, "Deferrals")).toBe("explicit_deferral");
    });
  });

  describe("a marker that is not the heading's whole subject never disposes, whatever its position", () => {
    it("does not let a trailing bare marker defer the core requirements nested under it", () => {
      // Verbatim structure from PRJ-AI-CCC-DuckLake-v7.2.3-QDB-Agent-Access-And-SQL-Zero.md.
      // "Phase 2 Retrieval Deferred" reads predicatively and the section really is
      // deferred -- but it is an H2 whose subtree holds the `qdb` SDK layer and every
      // REQ-QDB-* requirement, the document's headline deliverable. Disposition is
      // inherited by the whole subtree, so honouring the trailing marker silently
      // defers ~30 core requirements to rescue one heading. Blast radius beats grammar.
      const markdown = [
        "# CCC DuckLake v7.2.3 QDB Agent Access And SQL Zero",
        "",
        "Access preamble.",
        "",
        "## Phase 2 Retrieval Deferred",
        "",
        "Retrieval is not a blocker for the structured lake.",
        "",
        "### `qdb` SDK And Agent Tool Layer (`REQ-QDB`)",
        "",
        "- REQ-QDB-01: the SDK must expose typed query contracts.",
        "",
      ].join("\n");

      expect(dispositionOf(markdown, "Phase 2 Retrieval Deferred")).toBe("missing");
      expect(dispositionOf(markdown, "`qdb` SDK And Agent Tool Layer (`REQ-QDB`)")).toBe("missing");
    });

    it("does not dispose a heading where the marker only modifies a named artifact", () => {
      // PRJ-AI-CCC-DuckLake-v7.2.3-Modeling-Engine-Interface.md. "Deferred" names a
      // CATEGORY of calls to build -- the body is a spec table with a Phase column --
      // so this material still owes coverage.
      const markdown = [
        "# CCC DuckLake v7.2.3 Modeling Engine Interface",
        "",
        "Interface preamble.",
        "",
        "### Deferred Interface Calls",
        "",
        "Six calls extend the existing seven.",
        "",
      ].join("\n");

      expect(dispositionOf(markdown, "Deferred Interface Calls")).toBe("missing");
    });
  });

  describe("a body Status: field declares disposition; a quoted mention of one does not", () => {
    it("does not defer a section that merely quotes `status: DEFERRED` as code", () => {
      // Real shape from REF-AI-ccc-fusion-PostAuditAdjudicationAndExecutionRoute-2026-07-24.md
      // and conversionplan-v0.1-*.md -- documents describing this very refusal.
      const markdown = [
        "# Audit route",
        "",
        "Route preamble.",
        "",
        "## Recommendation Disposition Ledger",
        "",
        "Refusal on `while true` and `status: DEFERRED` in prose should become a structural check.",
        "",
      ].join("\n");

      expect(dispositionOf(markdown, "Recommendation Disposition Ledger")).toBe("missing");
    });

    it("still defers a section carrying a real Status field", () => {
      const markdown = [
        "# Roadmap",
        "",
        "Roadmap preamble.",
        "",
        "## Realtime tick capture",
        "",
        "Status: deferred",
        "",
        "Pushed beyond the current release.",
        "",
      ].join("\n");

      expect(dispositionOf(markdown, "Realtime tick capture")).toBe("explicit_deferral");
    });
  });

  describe("marker phrases must not form across a heading-path join seam", () => {
    it("does not defer a section because an ancestor ends where the child begins", () => {
      // headingPath joins to "... Roadmap Later Phase 2 ..." under the old
      // blob-join, so /\blater phase\b/ matched text that exists in no heading.
      const markdown = [
        "# Roadmap Later",
        "",
        "Roadmap preamble.",
        "",
        "## Phase 2 delivery",
        "",
        "Phase 2 ships the ingest path.",
        "",
      ].join("\n");

      expect(dispositionOf(markdown, "Phase 2 delivery")).toBe("missing");
    });
  });
});
