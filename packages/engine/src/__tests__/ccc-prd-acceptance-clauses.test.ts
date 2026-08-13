import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  assertCccPrdAcceptanceClauseCustody,
  reconcileCccPrdAcceptanceClauseManifest,
  reconcileCccPrdAcceptanceProofCoverage,
  stampCccPrdAcceptanceClauseLinks,
  parseCccPrdAcceptanceClauseInventory,
} from "../ccc-prd/acceptance-clauses.js";

const sha256 = (value: Buffer): string => createHash("sha256").update(value).digest("hex");

function parse(source: string | Buffer) {
  return parseCccPrdAcceptanceClauseInventory({
    sourcePath: "prd.md",
    sourceBytes: Buffer.isBuffer(source) ? source : Buffer.from(source, "utf8"),
  });
}

function refusalCode(source: string | Buffer): string | undefined {
  try {
    parse(source);
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

describe("parseCccPrdAcceptanceClauseInventory", () => {
  it("RED-S4-raw-byte-span: preserves exact UTF-8 clause bytes and excludes CRLF terminators", () => {
    const source = [
      "# Product",
      "### Requirement REQ-SLUG",
      "#### Acceptance clauses",
      "- [AC-REQ-SLUG-001] Café slugs preserve 漢字.",
      "- [AC-REQ-SLUG-002] Empty input returns an empty string.",
      "",
    ].join("\r\n");
    const sourceBytes = Buffer.from(source, "utf8");
    const parsed = parse(sourceBytes);

    expect(parsed.clauses.map(({ id, requirementId, text }) => ({ id, requirementId, text }))).toEqual([
      {
        id: "AC-REQ-SLUG-001",
        requirementId: "REQ-SLUG",
        text: "Café slugs preserve 漢字.",
      },
      {
        id: "AC-REQ-SLUG-002",
        requirementId: "REQ-SLUG",
        text: "Empty input returns an empty string.",
      },
    ]);
    for (const clause of parsed.clauses) {
      const bytes = sourceBytes.subarray(clause.span.byteStart, clause.span.byteEnd);
      expect(bytes.toString("utf8")).toBe(clause.text);
      expect(clause.span.sha256).toBe(sha256(sourceBytes));
      expect(clause.span.excerptSha256).toBe(sha256(bytes));
      expect(bytes.includes(0x0d)).toBe(false);
      expect(bytes.includes(0x0a)).toBe(false);
    }
  });

  it("RED-S4-exact-dispositions: parses only exact same-requirement dispositions", () => {
    const source = [
      "### Requirement REQ-001",
      "#### Acceptance clauses",
      "- [AC-REQ-001-001] Implemented behavior.",
      "- [AC-REQ-001-002] Later behavior.",
      "#### Acceptance dispositions",
      "- [AC-REQ-001-002] deferred: Depends on the next API version.",
    ].join("\n");

    expect(parse(source).dispositions.map(({ clauseId, requirementId, kind, reason }) => ({
      clauseId,
      requirementId,
      kind,
      reason,
    }))).toEqual([{
      clauseId: "AC-REQ-001-002",
      requirementId: "REQ-001",
      kind: "deferred",
      reason: "Depends on the next API version.",
    }]);
  });

  it("RED-S4-disposition-order: validates ownership against the whole requirement, not declaration order", () => {
    const source = [
      "### Requirement REQ-001",
      "#### Acceptance dispositions",
      "- [AC-REQ-001-002] deferred: Depends on the next API version.",
      "#### Acceptance clauses",
      "- [AC-REQ-001-002] Later behavior.",
    ].join("\n");

    expect(parse(source).dispositions).toEqual([
      expect.objectContaining({ clauseId: "AC-REQ-001-002", requirementId: "REQ-001" }),
    ]);
  });

  it.each([
    [
      "duplicate clause IDs",
      [
        "### Requirement REQ-001",
        "#### Acceptance clauses",
        "- [AC-REQ-001-001] First.",
        "- [AC-REQ-001-001] Duplicate.",
      ].join("\n"),
    ],
    [
      "foreign clause prefixes",
      [
        "### Requirement REQ-001",
        "#### Acceptance clauses",
        "- [AC-REQ-002-001] Wrong owner.",
      ].join("\n"),
    ],
    [
      "continued physical lines",
      [
        "### Requirement REQ-001",
        "#### Acceptance clauses",
        "- [AC-REQ-001-001] First line.",
        "  continued text",
      ].join("\n"),
    ],
    [
      "trailing whitespace",
      [
        "### Requirement REQ-001",
        "#### Acceptance clauses",
        "- [AC-REQ-001-001] Trailing space. ",
      ].join("\n"),
    ],
    [
      "nested lists",
      [
        "### Requirement REQ-001",
        "#### Acceptance clauses",
        "  - [AC-REQ-001-001] Nested.",
      ].join("\n"),
    ],
    [
      "clause bullets outside the exact subsection",
      [
        "### Requirement REQ-001",
        "#### Notes",
        "- [AC-REQ-001-001] Outside.",
      ].join("\n"),
    ],
    [
      "duplicate acceptance headings",
      [
        "### Requirement REQ-001",
        "#### Acceptance clauses",
        "- [AC-REQ-001-001] First.",
        "#### Acceptance clauses",
      ].join("\n"),
    ],
    [
      "clauses under an unknown requirement",
      [
        "### Requirements REQ-001",
        "#### Acceptance clauses",
        "- [AC-REQ-001-001] Unknown owner.",
      ].join("\n"),
    ],
    [
      "foreign disposition references",
      [
        "### Requirement REQ-001",
        "#### Acceptance clauses",
        "- [AC-REQ-001-001] First.",
        "#### Acceptance dispositions",
        "- [AC-REQ-999-001] excluded: Wrong requirement.",
      ].join("\n"),
    ],
    [
      "malformed disposition kinds",
      [
        "### Requirement REQ-001",
        "#### Acceptance clauses",
        "- [AC-REQ-001-001] First.",
        "#### Acceptance dispositions",
        "- [AC-REQ-001-001] done: Not admitted.",
      ].join("\n"),
    ],
    [
      "unmarked continuation text",
      [
        "### Requirement REQ-001",
        "#### Acceptance clauses",
        "- [AC-REQ-001-001] First line.",
        "This second physical line is not a clause.",
      ].join("\n"),
    ],
    [
      "malformed non-AC bullets",
      [
        "### Requirement REQ-001",
        "#### Acceptance clauses",
        "- [A-REQ-001-001] Typo in the clause prefix.",
      ].join("\n"),
    ],
  ])("RED-S4-malformed-grammar: refuses %s", (_label, source) => {
    expect(refusalCode(source)).toBe("CCC_PRD_ACCEPTANCE_CLAUSE_MALFORMED");
  });

  it("RED-S4-no-heuristic-splitting: ordinary acceptance prose declares no clauses", () => {
    const source = [
      "### Requirement REQ-001",
      "The slugifier lowercases text. It also replaces whitespace. Empty strings stay empty.",
    ].join("\n");

    expect(parse(source)).toEqual({ clauses: [], dispositions: [] });
  });

  it("RED-S4-global-identity: refuses duplicate requirement headings and duplicate dispositions", () => {
    const duplicateRequirement = [
      "### Requirement REQ-001",
      "#### Acceptance clauses",
      "- [AC-REQ-001-001] First.",
      "### Requirement REQ-001",
    ].join("\n");
    const duplicateDisposition = [
      "### Requirement REQ-001",
      "#### Acceptance clauses",
      "- [AC-REQ-001-001] First.",
      "#### Acceptance dispositions",
      "- [AC-REQ-001-001] deferred: Later.",
      "- [AC-REQ-001-001] excluded: Never.",
    ].join("\n");

    expect(refusalCode(duplicateRequirement)).toBe("CCC_PRD_ACCEPTANCE_CLAUSE_MALFORMED");
    expect(refusalCode(duplicateDisposition)).toBe("CCC_PRD_ACCEPTANCE_CLAUSE_MALFORMED");
  });

  it("RED-S4-existing-id-grammar: accepts mixed-case canonical IDs while keeping the AC prefix exact", () => {
    const result = parse([
      "### Requirement Req.slug:1",
      "#### Acceptance clauses",
      "- [AC-Req.slug:1-case_a] Mixed-case IDs use the existing bounded grammar.",
    ].join("\n"));

    expect(result.clauses[0]).toMatchObject({
      id: "AC-Req.slug:1-case_a",
      requirementId: "Req.slug:1",
    });
  });

  it("RED-S4-raw-utf8: refuses invalid UTF-8 instead of inventing replacement text", () => {
    const prefix = Buffer.from([
      "### Requirement REQ-001",
      "#### Acceptance clauses",
      "- [AC-REQ-001-001] ",
    ].join("\n"), "utf8");
    const invalid = Buffer.concat([prefix, Buffer.from([0xc3, 0x28])]);

    expect(refusalCode(invalid)).toBe("CCC_PRD_ACCEPTANCE_CLAUSE_MALFORMED");
  });

  it("RED-S4-global-inventory: refuses duplicate clause and requirement IDs across sources", () => {
    const source = [
      "### Requirement REQ-001",
      "#### Acceptance clauses",
      "- [AC-REQ-001-001] First.",
    ].join("\n");

    expect(() => reconcileCccPrdAcceptanceClauseManifest({
      sourceBytes: new Map([
        ["a.md", Buffer.from(source)],
        ["b.md", Buffer.from(source)],
      ]),
      requirements: [],
    })).toThrowError(expect.objectContaining({ code: "CCC_PRD_ACCEPTANCE_CLAUSE_MALFORMED" }));
  });

  it("RED-S4-model-links-only: stamps parser-owned text and spans while preserving exact proof links", () => {
    const source = [
      "### Requirement REQ-001",
      "#### Acceptance clauses",
      "- [AC-REQ-001-001] Exact source text.",
    ].join("\n");
    const result = reconcileCccPrdAcceptanceClauseManifest({
      sourceBytes: new Map([["prd.md", Buffer.from(source)]]),
      requirements: [{
        id: "REQ-001",
        acceptanceClauses: [{
          id: "AC-REQ-001-001",
          requirementId: "REQ-001",
          text: "Exact source text.",
          proofIds: ["PROOF-2", "PROOF-1"],
          sourceRefs: [{ path: "prd.md", exactQuote: "Exact source text." }],
        }],
        acceptanceDispositions: [],
      }],
    });

    expect(result.requirements).toEqual([{
      requirementId: "REQ-001",
      acceptanceClauses: [expect.objectContaining({
        id: "AC-REQ-001-001",
        requirementId: "REQ-001",
        text: "Exact source text.",
        proofIds: ["PROOF-1", "PROOF-2"],
        span: expect.objectContaining({ excerptSha256: sha256(Buffer.from("Exact source text.")) }),
      })],
      acceptanceDispositions: [],
    }]);
  });

  it("RED-S4-compiler-coverage: refuses duplicate, foreign, wrong-requirement, and uncovered proof clause links", () => {
    const source = [
      "### Requirement REQ-001",
      "#### Acceptance clauses",
      "- [AC-REQ-001-001] Exact source text.",
    ].join("\n");
    const reconciliation = reconcileCccPrdAcceptanceClauseManifest({
      sourceBytes: new Map([["prd.md", Buffer.from(source)]]),
      requirements: [{
        id: "REQ-001",
        acceptanceClauses: [{
          id: "AC-REQ-001-001",
          requirementId: "REQ-001",
          text: "Exact source text.",
          proofIds: ["PROOF-1"],
          sourceRefs: [{ path: "prd.md", exactQuote: "Exact source text." }],
        }],
        acceptanceDispositions: [],
      }],
    });

    expect(() => reconcileCccPrdAcceptanceProofCoverage({
      requirements: reconciliation.requirements,
      proofs: [{ id: "PROOF-1", requirementIds: ["REQ-002"], clauseIds: ["AC-REQ-001-001"] }],
    })).toThrowError(expect.objectContaining({ code: "CCC_PRD_ACCEPTANCE_CLAUSE_MANIFEST_INVALID" }));
    expect(() => reconcileCccPrdAcceptanceProofCoverage({
      requirements: reconciliation.requirements,
      proofs: [{ id: "PROOF-1", requirementIds: ["REQ-001"], clauseIds: ["AC-REQ-001-001", "AC-REQ-001-001"] }],
    })).toThrowError(expect.objectContaining({ code: "CCC_PRD_ACCEPTANCE_CLAUSE_MANIFEST_INVALID" }));
    expect(() => reconcileCccPrdAcceptanceProofCoverage({
      requirements: reconciliation.requirements,
      proofs: [{ id: "PROOF-1", requirementIds: ["REQ-001"], clauseIds: ["AC-REQ-001-999"] }],
    })).toThrowError(expect.objectContaining({ code: "CCC_PRD_ACCEPTANCE_CLAUSE_MANIFEST_INVALID" }));
    expect(() => reconcileCccPrdAcceptanceProofCoverage({
      requirements: reconciliation.requirements,
      proofs: [{ id: "PROOF-1", requirementIds: ["REQ-001"], clauseIds: [] }],
    })).toThrowError(expect.objectContaining({ code: "CCC_PRD_ACCEPTANCE_CLAUSE_UNDISPOSITIONED" }));
  });

  it("RED-S4-chunk-partial-inventory: stamps exact links without requiring another chunk's clauses", () => {
    const source = [
      "### Requirement REQ-001",
      "#### Acceptance clauses",
      "- [AC-REQ-001-001] First exact clause.",
      "### Requirement REQ-002",
      "#### Acceptance clauses",
      "- [AC-REQ-002-001] Second exact clause.",
    ].join("\n");

    expect(stampCccPrdAcceptanceClauseLinks({
      sourcePath: "prd.md",
      sourceBytes: Buffer.from(source),
      requirements: [{
        id: "REQ-001",
        acceptanceClauses: [{
          id: "AC-REQ-001-001",
          requirementId: "REQ-001",
          text: "First exact clause.",
          proofIds: ["PROOF-1"],
          sourceRefs: [{ path: "prd.md", exactQuote: "First exact clause." }],
        }],
        acceptanceDispositions: [],
      }],
    }).requirements).toEqual([{
      requirementId: "REQ-001",
      acceptanceClauses: [expect.objectContaining({ id: "AC-REQ-001-001" })],
      acceptanceDispositions: [],
    }]);
  });

  it("RED-S4-compiler-source-drift: persisted text/span/order must equal the parser-owned inventory", () => {
    const source = [
      "### Requirement REQ-001",
      "#### Acceptance clauses",
      "- [AC-REQ-001-001] Exact source text.",
    ].join("\n");
    const sourceBytes = new Map([["prd.md", Buffer.from(source)]]);
    const canonical = reconcileCccPrdAcceptanceClauseManifest({
      sourceBytes,
      requirements: [{
        id: "REQ-001",
        acceptanceClauses: [{
          id: "AC-REQ-001-001",
          requirementId: "REQ-001",
          text: "Exact source text.",
          proofIds: ["PROOF-1"],
          sourceRefs: [{ path: "prd.md", exactQuote: "Exact source text." }],
        }],
        acceptanceDispositions: [],
      }],
    });
    const proofs = [{ id: "PROOF-1", requirementIds: ["REQ-001"], clauseIds: ["AC-REQ-001-001"] }];
    expect(() => assertCccPrdAcceptanceClauseCustody({
      sourceBytes,
      requirements: canonical.requirements,
      proofs,
    })).not.toThrow();

    const drifted = structuredClone(canonical.requirements);
    drifted[0]!.acceptanceClauses[0]!.span.byteEnd -= 1;
    expect(() => assertCccPrdAcceptanceClauseCustody({
      sourceBytes,
      requirements: drifted,
      proofs,
    })).toThrowError(expect.objectContaining({ code: "CCC_PRD_ACCEPTANCE_CLAUSE_MANIFEST_INVALID" }));
  });

  it.each([
    ["omitted accepted clause", [], [], "CCC_PRD_ACCEPTANCE_CLAUSE_UNDISPOSITIONED"],
    [
      "unresolved source disposition",
      [],
      [{
        clauseId: "AC-REQ-001-001",
        requirementId: "REQ-001",
        kind: "unresolved",
        reason: "Needs a product decision.",
        sourceRefs: [{ path: "prd.md", exactQuote: "Needs a product decision." }],
      }],
      "CCC_PRD_ACCEPTANCE_CLAUSE_UNDISPOSITIONED",
    ],
    [
      "foreign model clause",
      [{
        id: "AC-REQ-001-999",
        requirementId: "REQ-001",
        text: "Invented.",
        proofIds: ["PROOF-1"],
        sourceRefs: [{ path: "prd.md", exactQuote: "Exact source text." }],
      }],
      [],
      "CCC_PRD_ACCEPTANCE_CLAUSE_MANIFEST_INVALID",
    ],
    [
      "wrong model text",
      [{
        id: "AC-REQ-001-001",
        requirementId: "REQ-001",
        text: "Paraphrased source text.",
        proofIds: ["PROOF-1"],
        sourceRefs: [{ path: "prd.md", exactQuote: "Exact source text." }],
      }],
      [],
      "CCC_PRD_ACCEPTANCE_CLAUSE_MANIFEST_INVALID",
    ],
    [
      "fuzzy clause quote",
      [{
        id: "AC-REQ-001-001",
        requirementId: "REQ-001",
        text: "Exact source text.",
        proofIds: ["PROOF-1"],
        sourceRefs: [{ path: "prd.md", exactQuote: "Exact  source text." }],
      }],
      [],
      "CCC_PRD_ACCEPTANCE_CLAUSE_MANIFEST_INVALID",
    ],
    [
      "accepted clause without proof links",
      [{
        id: "AC-REQ-001-001",
        requirementId: "REQ-001",
        text: "Exact source text.",
        proofIds: [],
        sourceRefs: [{ path: "prd.md", exactQuote: "Exact source text." }],
      }],
      [],
      "CCC_PRD_ACCEPTANCE_CLAUSE_UNDISPOSITIONED",
    ],
  ])("RED-S4-manifest-reconciliation: refuses %s", (_label, clauses, dispositions, code) => {
    const sourceDisposition = _label === "unresolved source disposition"
      ? [
          "#### Acceptance dispositions",
          "- [AC-REQ-001-001] unresolved: Needs a product decision.",
        ]
      : [];
    const source = [
      "### Requirement REQ-001",
      "#### Acceptance clauses",
      "- [AC-REQ-001-001] Exact source text.",
      ...sourceDisposition,
    ].join("\n");

    expect(() => reconcileCccPrdAcceptanceClauseManifest({
      sourceBytes: new Map([["prd.md", Buffer.from(source)]]),
      requirements: [{
        id: "REQ-001",
        acceptanceClauses: clauses,
        acceptanceDispositions: dispositions,
      }],
    })).toThrowError(expect.objectContaining({ code }));
  });

  it("RED-S4-no-structured-clauses: refuses a v2 requirement backed only by ordinary prose", () => {
    expect(() => reconcileCccPrdAcceptanceClauseManifest({
      sourceBytes: new Map([["prd.md", Buffer.from([
        "### Requirement REQ-001",
        "The slugifier lowercases text. Empty strings stay empty.",
      ].join("\n"))]]),
      requirements: [{ id: "REQ-001", acceptanceClauses: [], acceptanceDispositions: [] }],
    })).toThrowError(expect.objectContaining({ code: "CCC_PRD_ACCEPTANCE_CLAUSE_UNDISPOSITIONED" }));
  });
});
