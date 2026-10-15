import { Type } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { CccPlanningArtifactRef, CccReviewFindingRef, CccReviewVerdict } from "@fusion/core";

/*
FNXC:CccVerdictTool 2026-10-14-21:10:
Card C2 (CONTRACT-v3 section 2.13, verify-v2 item 34). A critic records its review through ccc_submit_verdict, once. The tool refuses an accept that carries a blocking finding, a requirement ref when the session has no requirement ids or names an unknown one, an artifact or source ref to anything but the session's input artifacts, a finding path outside the reviewed paths (any path when there are none), a summary or counterexample longer than 600 characters, an unknown key and a second call after an accepted submission (latched before the store is awaited). The finding and verdict types are K1's in @fusion/core, because core's objection schema and the engine stage host use them too and core cannot import the engine; this file declares no copy.
*/

const MAX_TEXT_LENGTH = 600;
const VERDICT_KEYS: ReadonlySet<string> = new Set(["findings", "verdict"]);
const FINDING_KEYS: ReadonlySet<string> = new Set(["line", "path", "ref", "severity", "summary"]);
const REF_KEYS: Readonly<Record<CccReviewFindingRef["kind"], ReadonlySet<string>>> = Object.freeze({
  requirement: new Set(["kind", "requirementId"]),
  source: new Set(["artifactKey", "kind", "quote"]),
  artifact: new Set(["artifactKey", "kind"]),
  counterexample: new Set(["kind", "text"]),
});

type Finding = CccReviewVerdict["findings"][number];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function verdictParameters() {
  const text = (description: string) => Type.String({ maxLength: MAX_TEXT_LENGTH, description });
  const ref = Type.Union([
    Type.Object({ kind: Type.Literal("requirement"), requirementId: Type.String() }, { additionalProperties: false }),
    Type.Object({ kind: Type.Literal("source"), artifactKey: Type.String(), quote: Type.Optional(Type.String()) }, { additionalProperties: false }),
    Type.Object({ kind: Type.Literal("artifact"), artifactKey: Type.String() }, { additionalProperties: false }),
    Type.Object({ kind: Type.Literal("counterexample"), text: text("A concrete counterexample") }, { additionalProperties: false }),
  ]);
  return Type.Object({
    verdict: Type.Union([Type.Literal("accept"), Type.Literal("reject")]),
    findings: Type.Array(Type.Object({
      ref,
      severity: Type.Union([Type.Literal("blocking"), Type.Literal("advisory")]),
      path: Type.Optional(Type.String({ description: "A reviewed path" })),
      line: Type.Optional(Type.Integer({ minimum: 1 })),
      summary: text("What the finding is"),
    }, { additionalProperties: false })),
  }, { additionalProperties: false });
}

export function createCccVerdictTool(i: Readonly<{ requirementIds: readonly string[] | null; artifactKeys: readonly string[];
  reviewedPaths: readonly string[] | null; onVerdict: (v: CccReviewVerdict) => Promise<CccPlanningArtifactRef> }>): ToolDefinition {
  const requirementIds = i.requirementIds === null ? null : new Set(i.requirementIds);
  const artifactKeys = new Set(i.artifactKeys);
  const reviewedPaths = i.reviewedPaths === null ? null : new Set(i.reviewedPaths);
  let submitted = false;

  const refProblems = (ref: unknown, at: string): string[] => {
    if (!isPlainObject(ref) || typeof ref.kind !== "string" || !Object.hasOwn(REF_KEYS, ref.kind)) {
      return [`${at} must be a requirement, source, artifact or counterexample ref`];
    }
    const kind = ref.kind as CccReviewFindingRef["kind"];
    const problems = Object.keys(ref).filter((key) => !REF_KEYS[kind].has(key)).map((key) => `${at} has unknown key ${key}`);
    if (kind === "requirement") {
      if (typeof ref.requirementId !== "string") problems.push(`${at}.requirementId must be a string`);
      else if (requirementIds === null) problems.push(`${at}: this session has no requirement ids, so a requirement ref is refused`);
      else if (!requirementIds.has(ref.requirementId)) problems.push(`${at}: unknown requirement id ${JSON.stringify(ref.requirementId)}`);
    } else if (kind === "source" || kind === "artifact") {
      if (typeof ref.artifactKey !== "string") problems.push(`${at}.artifactKey must be a string`);
      else if (!artifactKeys.has(ref.artifactKey)) problems.push(`${at}: ${kind} ${ref.artifactKey} is outside the session inputs`);
      if (kind === "source" && ref.quote !== undefined && typeof ref.quote !== "string") problems.push(`${at}.quote must be a string`);
    } else if (typeof ref.text !== "string") {
      problems.push(`${at}.text must be a string`);
    } else if (ref.text.length > MAX_TEXT_LENGTH) {
      problems.push(`${at}.text exceeds ${MAX_TEXT_LENGTH} characters`);
    }
    return problems;
  };

  const findingProblems = (finding: unknown, at: string): string[] => {
    if (!isPlainObject(finding)) return [`${at} must be an object`];
    const problems = Object.keys(finding).filter((key) => !FINDING_KEYS.has(key)).map((key) => `${at} has unknown key ${key}`);
    problems.push(...refProblems(finding.ref, `${at}.ref`));
    if (finding.severity !== "blocking" && finding.severity !== "advisory") problems.push(`${at}.severity must be blocking or advisory`);
    if (typeof finding.summary !== "string") problems.push(`${at}.summary must be a string`);
    else if (finding.summary.length > MAX_TEXT_LENGTH) problems.push(`${at}.summary exceeds ${MAX_TEXT_LENGTH} characters`);
    if (finding.path !== undefined) {
      if (typeof finding.path !== "string") problems.push(`${at}.path must be a string`);
      else if (reviewedPaths === null) problems.push(`${at}.path: this session has no reviewed paths`);
      else if (!reviewedPaths.has(finding.path)) problems.push(`${at}.path ${finding.path} is outside the reviewed paths`);
    }
    if (finding.line !== undefined && (typeof finding.line !== "number" || !Number.isSafeInteger(finding.line) || finding.line < 1)) {
      problems.push(`${at}.line must be a positive integer`);
    }
    return problems;
  };

  const execute = async (params: unknown) => {
    if (submitted) throw new Error("ccc_submit_verdict refused: a verdict was already submitted; a second call is refused");
    if (!isPlainObject(params)) throw new Error("ccc_submit_verdict refused: the arguments must be an object");
    const problems = Object.keys(params).filter((key) => !VERDICT_KEYS.has(key)).map((key) => `unknown key ${key}`);
    if (params.verdict !== "accept" && params.verdict !== "reject") problems.push(`verdict must be "accept" or "reject"`);
    const findings = Array.isArray(params.findings) ? params.findings : null;
    if (findings === null) problems.push("findings must be an array");
    else {
      findings.forEach((finding, index) => problems.push(...findingProblems(finding, `findings[${index}]`)));
      if (params.verdict === "accept") {
        findings.forEach((finding, index) => {
          if (isPlainObject(finding) && finding.severity === "blocking") {
            problems.push(`an accept verdict cannot carry a blocking finding (findings[${index}])`);
          }
        });
      }
    }
    if (problems.length > 0) throw new Error(`ccc_submit_verdict refused: ${problems.join("; ")}`);
    const verdict: CccReviewVerdict = Object.freeze({
      verdict: params.verdict as CccReviewVerdict["verdict"],
      findings: Object.freeze((findings ?? []).map((raw) => {
        const finding = raw as Record<string, unknown>;
        return Object.freeze({
          ref: Object.freeze({ ...(finding.ref as CccReviewFindingRef) }),
          severity: finding.severity as Finding["severity"],
          ...(finding.path !== undefined ? { path: finding.path as string } : {}),
          ...(finding.line !== undefined ? { line: finding.line as number } : {}),
          summary: finding.summary as string,
        });
      })),
    });
    submitted = true;
    const ref = await i.onVerdict(verdict);
    return {
      content: [{ type: "text" as const, text: `Verdict recorded as ${ref.artifactKey}.` }],
      details: { artifactRef: ref },
    };
  };

  return {
    name: "ccc_submit_verdict",
    label: "Submit Review Verdict",
    description: "Submit this review's verdict exactly once: accept or reject, with findings that cite requirements, input artifacts, "
      + `sources or counterexamples. An accept cannot carry a blocking finding. Summaries are at most ${MAX_TEXT_LENGTH} characters.`,
    executionMode: "sequential",
    parameters: verdictParameters(),
    execute: (_toolCallId, params) => execute(params),
  };
}
