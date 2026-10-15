import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { CccPlanningArtifactKind, CccReviewVerdict } from "@fusion/core";
import { createCccVerdictTool } from "../ccc-confinement/verdict-tool.js";
import { createCccSubmitArtifactTool } from "../ccc-confinement/submit-artifact-tool.js";

/*
FNXC:CccVerdictTool 2026-10-14-21:02:
Card C2 proof for the critic's ccc_submit_verdict tool (CONTRACT-v3 section 2.13, verify-v2 item 34). It refuses an accept that carries a blocking finding, a requirement ref when the session has no requirement ids or names an unknown one, an artifact or source ref outside the session's input artifacts, a path outside the reviewed paths, an over-long summary or counterexample, an unknown key and a second call after an accepted submission. Each refusal has a positive control that the same tool records. Its finding and verdict types are K1's in @fusion/core; the tool declares no copy of either, which the source assertion proves against a pattern shown to match core's own declarations.
*/

const REF = Object.freeze({ artifactKey: "cccplan-r001-intent-verdict-v01", digest: "d".repeat(64) });
const INPUT_KEY = "cccplan-r001-intent-cases-v01";

function verdictTool(overrides: Partial<Parameters<typeof createCccVerdictTool>[0]> = {}) {
  const onVerdict = vi.fn(async (_verdict: CccReviewVerdict) => REF);
  const tool = createCccVerdictTool({
    requirementIds: ["REQ-1", "REQ-2"],
    artifactKeys: [INPUT_KEY],
    reviewedPaths: ["src/a.ts"],
    onVerdict,
    ...overrides,
  });
  return { tool, onVerdict };
}

const call = (tool: { execute: (...args: never[]) => Promise<unknown> }, params: unknown) =>
  (tool.execute as (...args: unknown[]) => Promise<unknown>)("verdict-call", params, undefined, undefined, undefined);

function text(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.map((block) => block.text ?? "").join("\n");
}

const finding = (fields: Record<string, unknown>) => ({ severity: "advisory", summary: "looks fine", ...fields });

describe("ccc_submit_verdict (card C2)", () => {
  it("refuses accept with a blocking finding; positive control: reject with the same finding is recorded", async () => {
    const blocking = finding({ ref: { kind: "artifact", artifactKey: INPUT_KEY }, severity: "blocking" });
    const refused = verdictTool();
    await expect(call(refused.tool, { verdict: "accept", findings: [blocking] })).rejects.toThrow(/blocking/);
    expect(refused.onVerdict).not.toHaveBeenCalled();

    const recorded = verdictTool();
    expect(recorded.tool.name).toBe("ccc_submit_verdict");
    expect(text(await call(recorded.tool, { verdict: "reject", findings: [blocking] }))).toContain(REF.artifactKey);
    expect(recorded.onVerdict).toHaveBeenCalledWith({ verdict: "reject", findings: [blocking] });
  });

  it("refuses a requirement ref when requirementIds is null or the id is unknown; positive control: a known requirement id is recorded", async () => {
    const ref = (requirementId: string) => finding({ ref: { kind: "requirement", requirementId } });
    const noRequirements = verdictTool({ requirementIds: null });
    await expect(call(noRequirements.tool, { verdict: "accept", findings: [ref("REQ-1")] })).rejects.toThrow(/requirement/);
    const unknown = verdictTool();
    await expect(call(unknown.tool, { verdict: "accept", findings: [ref("REQ-9")] })).rejects.toThrow(/REQ-9/);
    expect(noRequirements.onVerdict).not.toHaveBeenCalled();
    expect(unknown.onVerdict).not.toHaveBeenCalled();

    const known = verdictTool();
    await call(known.tool, { verdict: "accept", findings: [ref("REQ-2")] });
    expect(known.onVerdict).toHaveBeenCalledTimes(1);
  });

  it("refuses an artifact or source ref outside the session inputs; positive control: an input artifact, an input source and a counterexample ref are recorded", async () => {
    for (const ref of [{ kind: "artifact", artifactKey: "cccplan-r001-intent-other-v01" }, { kind: "source", artifactKey: "cccplan-r001-research-x-v01", quote: "q" }]) {
      const outside = verdictTool();
      await expect(call(outside.tool, { verdict: "reject", findings: [finding({ ref })] })).rejects.toThrow(/outside the session inputs/);
      expect(outside.onVerdict).not.toHaveBeenCalled();
    }

    const inside = verdictTool();
    await call(inside.tool, {
      verdict: "reject",
      findings: [
        finding({ ref: { kind: "artifact", artifactKey: INPUT_KEY } }),
        finding({ ref: { kind: "source", artifactKey: INPUT_KEY, quote: "exact words" } }),
        finding({ ref: { kind: "counterexample", text: "an empty request still admits" }, severity: "blocking" }),
      ],
    });
    expect(inside.onVerdict).toHaveBeenCalledTimes(1);
  });

  it("refuses a path outside reviewedPaths, any path when reviewedPaths is null, a summary or counterexample over 600 characters, and an unknown key; positive control: a reviewed path at 600 characters is recorded", async () => {
    const artifactRef = { kind: "artifact", artifactKey: INPUT_KEY };
    const cases: Array<[Parameters<typeof verdictTool>[0], unknown, RegExp]> = [
      [{}, { verdict: "accept", findings: [finding({ ref: artifactRef, path: "src/b.ts", line: 3 })] }, /reviewed paths/],
      [{ reviewedPaths: null }, { verdict: "accept", findings: [finding({ ref: artifactRef, path: "src/a.ts" })] }, /reviewed paths/],
      [{}, { verdict: "accept", findings: [finding({ ref: artifactRef, summary: "x".repeat(601) })] }, /600/],
      [{}, { verdict: "reject", findings: [finding({ ref: { kind: "counterexample", text: "y".repeat(601) } })] }, /600/],
      [{}, { verdict: "accept", findings: [], extra: true }, /unknown key/],
      [{}, { verdict: "accept", findings: [finding({ ref: artifactRef, mood: "meh" })] }, /unknown key/],
      [{}, { verdict: "maybe", findings: [] }, /verdict/],
    ];
    for (const [overrides, params, message] of cases) {
      const refused = verdictTool(overrides);
      await expect(call(refused.tool, params)).rejects.toThrow(message);
      expect(refused.onVerdict).not.toHaveBeenCalled();
    }

    const accepted = verdictTool();
    await call(accepted.tool, { verdict: "accept", findings: [finding({ ref: artifactRef, path: "src/a.ts", line: 3, summary: "z".repeat(600) })] });
    expect(accepted.onVerdict).toHaveBeenCalledTimes(1);
  });

  it("refuses a second call after an accepted submission", async () => {
    const { tool, onVerdict } = verdictTool();
    await call(tool, { verdict: "accept", findings: [] });
    await expect(call(tool, { verdict: "reject", findings: [] })).rejects.toThrow(/second/);
    expect(onVerdict).toHaveBeenCalledTimes(1);
  });

  it("declares no copy of CccReviewFindingRef or CccReviewVerdict and imports both from @fusion/core", () => {
    const declaration = /^\s*(export\s+)?(type|interface)\s+CccReview(FindingRef|Verdict)\b/m;
    const source = readFileSync(new URL("../ccc-confinement/verdict-tool.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(declaration);
    expect(source).toMatch(/import type \{[^}]*\bCccReviewFindingRef\b[^}]*\} from "@fusion\/core"/);
    expect(source).toMatch(/import type \{[^}]*\bCccReviewVerdict\b[^}]*\} from "@fusion\/core"/);
    // Positive control: the same pattern finds K1's declarations in core.
    const core = readFileSync(new URL("../../../core/src/ccc-planning/types.ts", import.meta.url), "utf8");
    expect(core).toMatch(declaration);
  });
});

describe("ccc_submit_artifact (card C2)", () => {
  const ARTIFACT_REF = Object.freeze({ artifactKey: "cccplan-r001-intent-cases-v02", digest: "e".repeat(64) });

  function artifactTool() {
    const onSubmit = vi.fn(async () => ARTIFACT_REF);
    const tool = createCccSubmitArtifactTool({
      allowedKinds: ["acceptance_cases", "objection"] as CccPlanningArtifactKind[],
      contentSchemas: {
        "ccc-planning.acceptance-cases.v1": (value) => (Array.isArray((value as { cases?: unknown })?.cases) ? [] : ["cases must be an array"]),
        "text/markdown": (value) => (typeof value === "string" && value.length > 0 ? [] : ["empty text"]),
      },
      onSubmit,
    });
    return { tool, onSubmit };
  }

  it("refuses a kind outside allowedKinds, an unknown contentSchema, validator problems and a bad status; positive control: an allowed json submission is recorded", async () => {
    const valid = { kind: "acceptance_cases", contentSchema: "ccc-planning.acceptance-cases.v1", content: { type: "json", value: { cases: [] } }, status: "complete" };
    const cases: Array<[unknown, RegExp]> = [
      [{ ...valid, kind: "final_prd" }, /kind/],
      [{ ...valid, contentSchema: "ccc-planning.unknown.v1" }, /contentSchema/],
      [{ ...valid, content: { type: "json", value: { cases: "no" } } }, /cases must be an array/],
      [{ ...valid, status: "done" }, /status/],
      [{ ...valid, extra: 1 }, /unknown key/],
    ];
    for (const [params, message] of cases) {
      const refused = artifactTool();
      await expect(call(refused.tool, params)).rejects.toThrow(message);
      expect(refused.onSubmit).not.toHaveBeenCalled();
    }

    const accepted = artifactTool();
    expect(accepted.tool.name).toBe("ccc_submit_artifact");
    expect(text(await call(accepted.tool, valid))).toContain(ARTIFACT_REF.artifactKey);
    expect(accepted.onSubmit).toHaveBeenCalledWith({
      kind: "acceptance_cases",
      contentSchema: "ccc-planning.acceptance-cases.v1",
      content: { type: "json", value: { cases: [] } },
      status: "complete",
    });
  });

  it("submits text content as its UTF-8 bytes", async () => {
    const { tool, onSubmit } = artifactTool();
    await call(tool, { kind: "objection", contentSchema: "text/markdown", content: { type: "text", text: "café" }, status: "complete" });
    const submitted = (onSubmit.mock.calls[0] as unknown[])[0] as { content: { type: string; bytes: Uint8Array } };
    expect(submitted.content.type).toBe("text");
    expect(submitted.content.bytes).toBeInstanceOf(Uint8Array);
    expect(Array.from(submitted.content.bytes)).toEqual([0x63, 0x61, 0x66, 0xc3, 0xa9]);
  });
});
