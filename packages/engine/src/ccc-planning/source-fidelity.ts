import { createHash } from "node:crypto";
import type { CccPlanningAcceptanceCasesV1, CccPlanningRequirementMapV1 } from "@fusion/core";
import { computeCccPrdSourceLines } from "../ccc-prd/material-coverage.js";

/*
FNXC:CccPlanningSourceFidelity 2026-10-14-18:50:
Card GG (ADR B Q2 item 5, T2.6 and T2.7). Provenance and meaning are checked separately: a model review judges what the plan means, and this pure check proves where its claims come from, against the sealed request bytes, by exact substring only (never the fuzzy locator). It runs two checks. The anchor: the request bytes being checked, and the custody hash of the packet's original-request.md, must both equal the G0 `original_request` artifact's outputDigest, which was published at admission before any model ran. Attribution and coverage: every request-derived clause quotes the request exactly once per quote and links G1 acceptance cases; annex-derived clauses cite annex `DEC-` ids and nothing in the request; every request unit (a non-blank, non-heading line outside code fences, or a whole fenced block) is overlapped by a G1 quote; every G1 case maps to a request-derived clause and every G1 exclusion to a non-goal that cites its request text. Compile's material coverage cannot do this for a plain request, because a request without headings or requirement tokens has no material items at all.
FNXC:CccPlanningSourceFidelity 2026-10-14-18:50:
Two shapes of "an annex clause citing the request" are refused with ANNEX_ATTRIBUTED_TO_REQUEST: an annex derivation that carries request quotes or acceptance-case links (a shape the K1 schema refuses, caught here too because this check never assumes the schema ran), and a decision id that is not an annex `DEC-` id but is text found in the request, which is the schema-valid way to launder a request quote into an engineering decision. A decision id that is neither is ANNEX_DECISION_UNKNOWN. A request-derived clause with no request quote, or no acceptance-case link, is REQUEST_DERIVATION_MISSING.
*/

export type CccPlanningFidelityCode =
  | "CCC_PLANNING_REQUEST_ANCHOR_MISMATCH" | "CCC_PLANNING_REQUEST_QUOTE_UNRESOLVED"
  | "CCC_PLANNING_REQUEST_QUOTE_AMBIGUOUS" | "CCC_PLANNING_REQUEST_UNIT_UNDISPOSITIONED"
  | "CCC_PLANNING_REQUEST_DERIVATION_MISSING" | "CCC_PLANNING_ANNEX_ATTRIBUTED_TO_REQUEST"
  | "CCC_PLANNING_ACCEPTANCE_CASE_UNMAPPED" | "CCC_PLANNING_EXCLUSION_UNMAPPED"
  | "CCC_PLANNING_ANNEX_DECISION_UNKNOWN";

export type CccPlanningFidelityDiagnostic = Readonly<{ code: CccPlanningFidelityCode; message: string }>;

export type CccPlanningSourceFidelityInput = Readonly<{
  requestBytes: Buffer;
  /** The G0 `original_request` artifact's outputDigest. */
  requestArtifactDigest: string;
  /** Custody's sha256 of the packet's original-request.md (`readCccPrdPacketCustody`). */
  packetRequestSha256: string;
  acceptanceCases: CccPlanningAcceptanceCasesV1;
  requirementMap: CccPlanningRequirementMapV1;
  annexBytes: Buffer;
}>;

type Range = Readonly<{ start: number; end: number }>;
type Resolution = Readonly<{ kind: "resolved"; range: Range }> | Readonly<{ kind: "unresolved" | "ambiguous" }>;

const ANNEX_DECISION_ID = /\bDEC-[A-Za-z0-9][A-Za-z0-9._-]*/gu;
const HEADING = /^\s{0,3}#{1,6}\s+\S/u;
const FENCE_MARKER = /^\s*(`{3,}|~{3,})/u;

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Exact byte match only: a quote resolves when it occurs exactly once. An empty quote never resolves. */
function resolveQuote(source: Buffer, quote: unknown): Resolution {
  if (typeof quote !== "string" || quote.length === 0) return { kind: "unresolved" };
  const needle = Buffer.from(quote, "utf8");
  const start = source.indexOf(needle);
  if (start < 0) return { kind: "unresolved" };
  if (source.indexOf(needle, start + 1) >= 0) return { kind: "ambiguous" };
  return { kind: "resolved", range: { start, end: start + needle.byteLength } };
}

function quoted(text: unknown): string {
  const value = typeof text === "string" ? text : String(text);
  return JSON.stringify(value.length > 120 ? `${value.slice(0, 117)}...` : value);
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/** Request units (ADR B Q2 item 5): each non-blank, non-heading line outside code fences, and each fenced block as one unit. */
function requestUnits(bytes: Buffer): Array<Readonly<{ line: number; range: Range; text: string }>> {
  const units: Array<{ line: number; range: Range; text: string }> = [];
  let block: { line: number; start: number; end: number; text: string } | null = null;
  let fence: "`" | "~" | null = null;
  for (const [index, line] of computeCccPrdSourceLines(bytes).entries()) {
    const marker = FENCE_MARKER.exec(line.text)?.[1];
    if (fence !== null || marker) {
      // The same fence state machine as computeCccPrdSourceLines: a marker opens a block, the same kind closes it.
      block ??= { line: index + 1, start: line.byteStart, end: line.contentEnd, text: line.text };
      block.end = line.contentEnd;
      if (marker) {
        const kind = marker[0] as "`" | "~";
        if (fence === null) fence = kind;
        else if (fence === kind) fence = null;
      }
      if (fence === null) {
        units.push({ line: block.line, range: { start: block.start, end: block.end }, text: block.text });
        block = null;
      }
      continue;
    }
    if (line.text.trim().length === 0 || HEADING.test(line.text)) continue;
    units.push({ line: index + 1, range: { start: line.byteStart, end: line.contentEnd }, text: line.text });
  }
  if (block !== null) units.push({ line: block.line, range: { start: block.start, end: block.end }, text: block.text });
  return units;
}

function overlaps(left: Range, right: Range): boolean {
  return left.start < right.end && right.start < left.end;
}

function annexDecisionIds(bytes: Buffer): Set<string> {
  const ids = new Set<string>();
  for (const line of computeCccPrdSourceLines(bytes)) {
    if (line.fenced) continue;
    for (const match of line.text.matchAll(ANNEX_DECISION_ID)) ids.add(match[0]);
  }
  return ids;
}

/** Pure; returns every fidelity problem, an empty list when the plan's attribution holds. */
export function checkCccPlanningSourceFidelity(input: CccPlanningSourceFidelityInput): readonly CccPlanningFidelityDiagnostic[] {
  const diagnostics: CccPlanningFidelityDiagnostic[] = [];
  const add = (code: CccPlanningFidelityCode, message: string) => diagnostics.push({ code, message });
  const request = input.requestBytes;

  // Anchor.
  const checkedSha256 = sha256(request);
  if (input.packetRequestSha256 !== input.requestArtifactDigest || checkedSha256 !== input.requestArtifactDigest) {
    add("CCC_PLANNING_REQUEST_ANCHOR_MISMATCH",
      `the original request is not the sealed one: the G0 original_request digest is ${input.requestArtifactDigest}, `
      + `the packet custody sha256 is ${input.packetRequestSha256} and the checked bytes hash to ${checkedSha256}`);
  }

  /** Resolves a quote in the request; reports an unresolved or ambiguous quote; returns its range when resolved. */
  const requestQuote = (owner: string, quote: unknown): Range | null => {
    const resolution = resolveQuote(request, quote);
    if (resolution.kind === "resolved") return resolution.range;
    add(resolution.kind === "ambiguous" ? "CCC_PLANNING_REQUEST_QUOTE_AMBIGUOUS" : "CCC_PLANNING_REQUEST_QUOTE_UNRESOLVED",
      `${owner} quote ${quoted(quote)} ${resolution.kind === "ambiguous" ? "occurs more than once in" : "does not occur in"} the original request`);
    return null;
  };

  // G1 quotes: they must resolve, and they are what disposes the request units.
  const g1Ranges: Range[] = [];
  const exclusionRanges = new Map<string, Range[]>();
  for (const entry of input.acceptanceCases.cases ?? []) {
    for (const quote of strings(entry.requestQuotes)) {
      const range = requestQuote(`acceptance case ${entry.id}`, quote);
      if (range) g1Ranges.push(range);
    }
  }
  for (const entry of input.acceptanceCases.exclusions ?? []) {
    const ranges: Range[] = [];
    for (const quote of strings(entry.requestQuotes)) {
      const range = requestQuote(`exclusion ${entry.id}`, quote);
      if (range) ranges.push(range);
    }
    g1Ranges.push(...ranges);
    exclusionRanges.set(entry.id, ranges);
  }
  const caseIds = new Set((input.acceptanceCases.cases ?? []).map(({ id }) => id));

  // Clauses.
  const annexIds = annexDecisionIds(input.annexBytes);
  const mappedCases = new Set<string>();
  for (const requirement of input.requirementMap.requirements ?? []) {
    for (const clause of requirement.clauses ?? []) {
      const owner = `requirement ${requirement.id} clause ${clause.id}`;
      const derivation = clause.derivation as unknown as Record<string, unknown> | null | undefined;
      const kind = derivation && typeof derivation === "object" ? derivation.kind : undefined;
      if (kind === "request") {
        const quotes = strings(derivation!.requestQuotes);
        const linked = strings(derivation!.acceptanceCaseIds);
        if (quotes.length === 0) add("CCC_PLANNING_REQUEST_DERIVATION_MISSING", `${owner} is request-derived but quotes nothing from the request`);
        for (const quote of quotes) requestQuote(owner, quote);
        if (linked.length === 0) add("CCC_PLANNING_REQUEST_DERIVATION_MISSING", `${owner} is request-derived but links no G1 acceptance case`);
        for (const caseId of linked) {
          if (caseIds.has(caseId)) mappedCases.add(caseId);
          else add("CCC_PLANNING_REQUEST_DERIVATION_MISSING", `${owner} links acceptance case ${caseId}, which G1 does not declare`);
        }
      } else if (kind === "annex") {
        const carried = [...strings(derivation!.requestQuotes), ...strings(derivation!.acceptanceCaseIds)];
        if (carried.length > 0) {
          add("CCC_PLANNING_ANNEX_ATTRIBUTED_TO_REQUEST",
            `${owner} is annex-derived but cites the request (${carried.map(quoted).join(", ")})`);
        }
        const decisions = strings(derivation!.decisionIds);
        if (decisions.length === 0 && carried.length === 0) {
          add("CCC_PLANNING_ANNEX_DECISION_UNKNOWN", `${owner} is annex-derived but cites no annex decision`);
        }
        for (const decisionId of decisions) {
          if (annexIds.has(decisionId)) continue;
          if (resolveQuote(request, decisionId).kind !== "unresolved") {
            add("CCC_PLANNING_ANNEX_ATTRIBUTED_TO_REQUEST",
              `${owner} is annex-derived but cites request text ${quoted(decisionId)} instead of an annex decision`);
          } else {
            add("CCC_PLANNING_ANNEX_DECISION_UNKNOWN", `${owner} cites decision ${quoted(decisionId)}, which the technical annex does not declare`);
          }
        }
      } else {
        add("CCC_PLANNING_REQUEST_DERIVATION_MISSING", `${owner} declares no request or annex derivation`);
      }
    }
  }

  // Non-goals and exclusions.
  const nonGoalRanges: Array<Readonly<{ exclusionIds: readonly string[]; ranges: readonly Range[] }>> = [];
  for (const nonGoal of input.requirementMap.nonGoals ?? []) {
    const ranges: Range[] = [];
    for (const quote of strings(nonGoal.requestQuotes)) {
      const range = requestQuote(`non-goal ${nonGoal.id}`, quote);
      if (range) ranges.push(range);
    }
    nonGoalRanges.push({ exclusionIds: strings(nonGoal.exclusionIds), ranges });
  }
  for (const [exclusionId, ranges] of exclusionRanges) {
    const mapped = nonGoalRanges.some((nonGoal) => nonGoal.exclusionIds.includes(exclusionId)
      && nonGoal.ranges.some((range) => ranges.some((exclusion) => overlaps(range, exclusion))));
    if (!mapped) {
      add("CCC_PLANNING_EXCLUSION_UNMAPPED",
        `exclusion ${exclusionId} appears in no non-goal that lists it and cites its request text`);
    }
  }
  for (const caseId of caseIds) {
    if (!mappedCases.has(caseId)) add("CCC_PLANNING_ACCEPTANCE_CASE_UNMAPPED", `acceptance case ${caseId} maps to no request-derived clause`);
  }

  // Request units.
  for (const unit of requestUnits(request)) {
    if (!g1Ranges.some((range) => overlaps(range, unit.range))) {
      add("CCC_PLANNING_REQUEST_UNIT_UNDISPOSITIONED",
        `original request line ${unit.line} (${quoted(unit.text.trim())}) is covered by no G1 acceptance case or exclusion quote`);
    }
  }
  return diagnostics;
}
