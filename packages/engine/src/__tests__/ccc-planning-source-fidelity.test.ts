import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { CccPlanningAcceptanceCasesV1, CccPlanningRequirementMapV1 } from "@fusion/core";
import { analyzeCccPrdMaterialCoverage, computeCccPrdMaterialInventory } from "../ccc-prd/material-coverage.js";
import {
  checkCccPlanningSourceFidelity,
  type CccPlanningSourceFidelityInput,
} from "../ccc-planning/source-fidelity.js";

/*
FNXC:CccPlanningSourceFidelity 2026-10-14-18:40:
Card GG, T2.6 and T2.7 (ADR B Q2 item 5). The request a run was admitted with is the one source no model wrote, so the plan's claims about it are checked against its sealed bytes by exact substring match, never by a fuzzy locator, and separately from the model review of meaning. These tests drive `checkCccPlanningSourceFidelity` with one correctly attributed fixture (the positive control) and change exactly one thing per refusal, so each refusal is caused by the change and not by a broken fixture.
*/

const REQUEST_PATH = "sources/__fusion__/planning/original-request.md";

const REQUEST = [
  "Build a small text statistics tool for plain text.",
  "Provide a tokenizer that splits text into lowercase words.",
  "Count word frequency from the tokens.",
  "Estimate reading time in whole minutes at 200 words per minute.",
  "Provide a CLI that prints JSON and exits 2 on error.",
  "Use node --test tests, no dependencies, no package.json change and no network.",
  "",
].join("\n");

const FINAL_PRD = [
  "# Text statistics",
  "",
  "## Requirement REQ-1 tokenizer",
  "The tokenizer returns an array of lowercase words.",
  "",
].join("\n");

const ANNEX = [
  "# Technical annex",
  "",
  "## DEC-1 Tokenizer module",
  "Task T1 owns src/tokenizer.mjs.",
  "",
  "## DEC-4 CLI exit codes",
  "The CLI exits with code 2 when it cannot read its input.",
  "",
].join("\n");

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function acceptanceCases(): CccPlanningAcceptanceCasesV1 {
  return {
    schema: "ccc-planning.acceptance-cases.v1",
    cases: [
      { id: "AC-1", statement: "Tokenize text.", requestQuotes: ["Build a small text statistics tool for plain text.", "splits text into lowercase words"] },
      { id: "AC-2", statement: "Count words.", requestQuotes: ["Count word frequency from the tokens."] },
      { id: "AC-3", statement: "Reading time.", requestQuotes: ["Estimate reading time in whole minutes"] },
      { id: "AC-4", statement: "CLI.", requestQuotes: ["prints JSON and exits 2 on error"] },
      { id: "AC-5", statement: "Node tests.", requestQuotes: ["Use node --test tests"] },
    ],
    exclusions: [
      { id: "EX-1", statement: "No dependencies or network.", requestQuotes: ["no dependencies, no package.json change and no network"] },
    ],
  };
}

type MutableMap = {
  schema: "ccc-planning.requirement-map.v1";
  requirements: Array<{
    id: string; title: string; statement: string; proofIds: string[];
    clauses: Array<{ id: string; text: string; derivation: Record<string, unknown> }>;
  }>;
  nonGoals: Array<{ id: string; text: string; requestQuotes: string[]; exclusionIds: string[] }>;
};

function requestClause(id: string, quote: string, caseId: string) {
  return { id, text: `clause ${id}`, derivation: { kind: "request", requestQuotes: [quote], acceptanceCaseIds: [caseId] } };
}

function mutableMap(): MutableMap {
  return {
    schema: "ccc-planning.requirement-map.v1",
    requirements: [
      { id: "REQ-1", title: "Tokenizer", statement: "Tokenize.", proofIds: ["tokenizer"], clauses: [
        requestClause("REQ-1-C1", "splits text into lowercase words", "AC-1"),
        requestClause("REQ-1-C2", "Use node --test tests", "AC-5"),
      ] },
      { id: "REQ-2", title: "Frequency", statement: "Count.", proofIds: ["word-frequency"], clauses: [
        requestClause("REQ-2-C1", "Count word frequency from the tokens.", "AC-2"),
      ] },
      { id: "REQ-3", title: "Reading time", statement: "Time.", proofIds: ["reading-time"], clauses: [
        requestClause("REQ-3-C1", "Estimate reading time in whole minutes", "AC-3"),
      ] },
      { id: "REQ-4", title: "CLI", statement: "CLI.", proofIds: ["cli"], clauses: [
        requestClause("REQ-4-C1", "prints JSON and exits 2 on error", "AC-4"),
        { id: "REQ-4-C2", text: "Exit code 2 when input cannot be read.", derivation: { kind: "annex", decisionIds: ["DEC-4"] } },
      ] },
    ],
    nonGoals: [{ id: "NG-1", text: "No network access.", requestQuotes: ["no network"], exclusionIds: ["EX-1"] }],
  };
}

function input(overrides: {
  request?: string; map?: MutableMap; cases?: CccPlanningAcceptanceCasesV1; artifactDigest?: string;
} = {}): CccPlanningSourceFidelityInput {
  const requestBytes = Buffer.from(overrides.request ?? REQUEST, "utf8");
  return {
    requestBytes,
    requestArtifactDigest: overrides.artifactDigest ?? sha256(requestBytes),
    packetRequestSha256: sha256(requestBytes),
    acceptanceCases: overrides.cases ?? acceptanceCases(),
    requirementMap: (overrides.map ?? mutableMap()) as unknown as CccPlanningRequirementMapV1,
    annexBytes: Buffer.from(ANNEX, "utf8"),
  };
}

function codes(diagnostics: readonly { code: string }[]): string[] {
  return diagnostics.map(({ code }) => code);
}

describe("checkCccPlanningSourceFidelity", () => {
  it("positive control: a correctly attributed map yields zero diagnostics", () => {
    expect(checkCccPlanningSourceFidelity(input())).toEqual([]);
  });

  it("one changed request byte gives an anchor mismatch", () => {
    const changed = REQUEST.replace("at 200 words", "at 250 words");
    expect(Buffer.byteLength(changed)).toBe(Buffer.byteLength(REQUEST));
    const sealed = sha256(Buffer.from(REQUEST, "utf8"));
    const diagnostics = checkCccPlanningSourceFidelity(input({ request: changed, artifactDigest: sealed }));
    expect(codes(diagnostics)).toEqual(["CCC_PLANNING_REQUEST_ANCHOR_MISMATCH"]);
    expect(diagnostics[0]!.message).toContain(sealed);
    // Control: the same changed bytes anchored to their own digest raise nothing, so only the anchor refused.
    expect(checkCccPlanningSourceFidelity(input({ request: changed }))).toEqual([]);
  });

  it("a quote that exists only in the final PRD gives REQUEST_QUOTE_UNRESOLVED", () => {
    const prdOnly = "The tokenizer returns an array of lowercase words.";
    const prd = Buffer.from(FINAL_PRD, "utf8");
    const at = prd.indexOf(Buffer.from(prdOnly, "utf8"));
    expect(at).toBeGreaterThanOrEqual(0);
    expect(prd.indexOf(Buffer.from(prdOnly, "utf8"), at + 1)).toBe(-1); // it does resolve, once, in the PRD source
    const map = mutableMap();
    map.requirements[0]!.clauses[0] = requestClause("REQ-1-C1", prdOnly, "AC-1");
    const diagnostics = checkCccPlanningSourceFidelity(input({ map }));
    expect(codes(diagnostics)).toEqual(["CCC_PLANNING_REQUEST_QUOTE_UNRESOLVED"]);
    expect(diagnostics[0]!.message).toContain("REQ-1-C1");
  });

  it("an uncovered line of a heading-free request gives REQUEST_UNIT_UNDISPOSITIONED, where compile alone sees zero items", () => {
    const request = `${REQUEST}Also report the longest word.\n`;
    const bytes = Buffer.from(request, "utf8");
    expect(computeCccPrdMaterialInventory(REQUEST_PATH, bytes)).toEqual([]);
    const analysis = analyzeCccPrdMaterialCoverage({
      sourceBytes: new Map([[REQUEST_PATH, bytes]]), requirements: [], tasks: [], unresolvedDecisions: [],
    });
    expect(analysis.inventory).toHaveLength(0);
    expect(analysis.missing).toHaveLength(0);
    const diagnostics = checkCccPlanningSourceFidelity(input({ request }));
    expect(codes(diagnostics)).toEqual(["CCC_PLANNING_REQUEST_UNIT_UNDISPOSITIONED"]);
    expect(diagnostics[0]!.message).toContain("line 7");
  });

  it("a fenced block is one unit: one quote inside it covers the whole block", () => {
    const fenced = `${REQUEST}\`\`\`text\nhello world\nsecond line\n\`\`\`\n`;
    expect(codes(checkCccPlanningSourceFidelity(input({ request: fenced })))).toEqual(["CCC_PLANNING_REQUEST_UNIT_UNDISPOSITIONED"]);
    const cases = acceptanceCases();
    const covered: CccPlanningAcceptanceCasesV1 = {
      ...cases,
      cases: [...cases.cases, { id: "AC-6", statement: "Example.", requestQuotes: ["second line"] }],
    };
    const map = mutableMap();
    map.requirements[0]!.clauses.push(requestClause("REQ-1-C3", "second line", "AC-6"));
    expect(checkCccPlanningSourceFidelity(input({ request: fenced, cases: covered, map }))).toEqual([]);
  });

  it("an annex clause citing the request gives ANNEX_ATTRIBUTED_TO_REQUEST", () => {
    const map = mutableMap();
    map.requirements[3]!.clauses[1] = {
      id: "REQ-4-C2", text: "Exit code 2.", derivation: { kind: "annex", decisionIds: ["prints JSON and exits 2 on error"] },
    };
    const diagnostics = checkCccPlanningSourceFidelity(input({ map }));
    expect(codes(diagnostics)).toEqual(["CCC_PLANNING_ANNEX_ATTRIBUTED_TO_REQUEST"]);
    expect(diagnostics[0]!.message).toContain("REQ-4-C2");
  });

  it("an annex clause carrying request quotes gives ANNEX_ATTRIBUTED_TO_REQUEST", () => {
    const map = mutableMap();
    map.requirements[3]!.clauses[1] = {
      id: "REQ-4-C2", text: "Exit code 2.",
      derivation: { kind: "annex", decisionIds: ["DEC-4"], requestQuotes: ["prints JSON and exits 2 on error"] },
    };
    expect(codes(checkCccPlanningSourceFidelity(input({ map })))).toEqual(["CCC_PLANNING_ANNEX_ATTRIBUTED_TO_REQUEST"]);
  });

  it("an annex clause citing a decision the annex does not declare gives ANNEX_DECISION_UNKNOWN", () => {
    const map = mutableMap();
    map.requirements[3]!.clauses[1] = { id: "REQ-4-C2", text: "Exit code 2.", derivation: { kind: "annex", decisionIds: ["DEC-9"] } };
    expect(codes(checkCccPlanningSourceFidelity(input({ map })))).toEqual(["CCC_PLANNING_ANNEX_DECISION_UNKNOWN"]);
  });

  it("a request quote that occurs twice gives REQUEST_QUOTE_AMBIGUOUS", () => {
    const map = mutableMap();
    map.requirements[2]!.clauses[0] = requestClause("REQ-3-C1", "words", "AC-3");
    const diagnostics = checkCccPlanningSourceFidelity(input({ map }));
    expect(codes(diagnostics)).toEqual(["CCC_PLANNING_REQUEST_QUOTE_AMBIGUOUS"]);
  });

  it("a request-derived clause with no request quote gives REQUEST_DERIVATION_MISSING", () => {
    const map = mutableMap();
    map.requirements[2]!.clauses[0] = {
      id: "REQ-3-C1", text: "Time.", derivation: { kind: "request", requestQuotes: [], acceptanceCaseIds: ["AC-3"] },
    };
    expect(codes(checkCccPlanningSourceFidelity(input({ map })))).toEqual(["CCC_PLANNING_REQUEST_DERIVATION_MISSING"]);
  });

  it("an acceptance case no request-derived clause maps gives ACCEPTANCE_CASE_UNMAPPED", () => {
    const map = mutableMap();
    map.requirements[0]!.clauses.pop();
    const diagnostics = checkCccPlanningSourceFidelity(input({ map }));
    expect(codes(diagnostics)).toEqual(["CCC_PLANNING_ACCEPTANCE_CASE_UNMAPPED"]);
    expect(diagnostics[0]!.message).toContain("AC-5");
  });

  it("an exclusion with no non-goal citing its request quote gives EXCLUSION_UNMAPPED", () => {
    const map = mutableMap();
    map.nonGoals[0]!.requestQuotes = ["Count word frequency"];
    const diagnostics = checkCccPlanningSourceFidelity(input({ map }));
    expect(codes(diagnostics)).toEqual(["CCC_PLANNING_EXCLUSION_UNMAPPED"]);
    expect(diagnostics[0]!.message).toContain("EX-1");
  });
});
