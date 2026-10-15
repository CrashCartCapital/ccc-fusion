import { describe, expect, it } from "vitest";
import {
  validateCccPlanningObjectionV1,
  type CccPlanningArtifactRef,
  type CccPlanningDecisionRecordV1,
  type CccReviewVerdict,
} from "@fusion/core";
import {
  assessCccPlanningObjectionDispositions,
  cccPlanningObjectionsFromVerdict,
  type CccPlanningKeyedObjection,
} from "../ccc-planning/objections.js";

/*
FNXC:CccPlanningObjections 2026-10-14-18:40:
Card GG, G3 and D47. Every reviewer finding becomes an `objection` in the reviewer's stage, and spec-ready is refused while any blocking objection lacks a resolving decision record: `accepted`, or `rejected` with at least one evidence ref. `deferred` resolves only advisory objections. The positive control is a resolved set on the same fixture, so the refusals come from the dispositions and not from the fixture.
*/

const REVIEWED: CccPlanningArtifactRef = { artifactKey: "cccplan-r001-spec-a-v01", digest: "a".repeat(64) };
const DESIGN_REF = "cccplan-r001-design-a-v01";

function objection(key: string, severity: "blocking" | "advisory"): CccPlanningKeyedObjection {
  return {
    artifactKey: key,
    objection: {
      stageId: "review", reviewerRoleId: "technical-critic", severity,
      ref: { kind: "requirement", requirementId: "REQ-1" }, summary: `objection ${key}`, reviewedRef: REVIEWED,
    },
  };
}

function record(objectionKey: string, disposition: CccPlanningDecisionRecordV1["disposition"],
  evidence: CccPlanningDecisionRecordV1["evidence"] = [{ kind: "artifact", artifactKey: DESIGN_REF }]): CccPlanningDecisionRecordV1 {
  return {
    objectionKey, proposal: "Change the tokenizer.", evidence, objection: "The tokenizer drops digits.",
    discriminatingObservation: "A digit-only input returns no tokens.", disposition, remainingUncertainty: "None known.",
  };
}

const BLOCKING_A = "cccplan-r001-review-a-v01";
const BLOCKING_B = "cccplan-r001-review-b-v01";
const ADVISORY_C = "cccplan-r001-review-c-v01";

function codes(diagnostics: readonly { code: string }[]): string[] {
  return diagnostics.map(({ code }) => code);
}

describe("cccPlanningObjectionsFromVerdict", () => {
  it("turns a reject verdict with a counterexample finding and an artifact finding into two objections with those refs", () => {
    const verdict: CccReviewVerdict = {
      verdict: "reject",
      findings: [
        { ref: { kind: "counterexample", text: "tokenize('A1') returns []" }, severity: "blocking", summary: "Digits are dropped." },
        { ref: { kind: "artifact", artifactKey: DESIGN_REF }, severity: "advisory", summary: "Design A names no tie-break." },
      ],
    };
    const objections = cccPlanningObjectionsFromVerdict(verdict, {
      stageId: "review", reviewerRoleId: "technical-critic", reviewedRef: REVIEWED,
    });
    expect(objections).toHaveLength(2);
    expect(objections.map(({ ref }) => ref)).toEqual([
      { kind: "counterexample", text: "tokenize('A1') returns []" },
      { kind: "artifact", artifactKey: DESIGN_REF },
    ]);
    expect(objections.map(({ severity }) => severity)).toEqual(["blocking", "advisory"]);
    for (const entry of objections) {
      expect(entry.stageId).toBe("review");
      expect(entry.reviewerRoleId).toBe("technical-critic");
      expect(entry.reviewedRef).toEqual(REVIEWED);
      expect(validateCccPlanningObjectionV1(entry)).toEqual([]);
    }
  });

  it("refuses a stage that may not publish objections", () => {
    const verdict: CccReviewVerdict = {
      verdict: "reject",
      findings: [{ ref: { kind: "requirement", requirementId: "REQ-1" }, severity: "blocking", summary: "Missing." }],
    };
    expect(() => cccPlanningObjectionsFromVerdict(verdict, {
      stageId: "plan", reviewerRoleId: "technical-critic", reviewedRef: REVIEWED,
    })).toThrow(/objection/u);
  });
});

describe("assessCccPlanningObjectionDispositions", () => {
  it("positive control: a resolved objection set yields zero diagnostics", () => {
    const objections = [objection(BLOCKING_A, "blocking"), objection(BLOCKING_B, "blocking"), objection(ADVISORY_C, "advisory")];
    const records = [record(BLOCKING_A, "accepted"), record(BLOCKING_B, "rejected"), record(ADVISORY_C, "deferred")];
    expect(assessCccPlanningObjectionDispositions(objections, records)).toEqual([]);
  });

  it("a blocking objection with no decision_record gives OBJECTION_UNRESOLVED", () => {
    const objections = [objection(BLOCKING_A, "blocking"), objection(BLOCKING_B, "blocking")];
    const diagnostics = assessCccPlanningObjectionDispositions(objections, [record(BLOCKING_A, "accepted")]);
    expect(codes(diagnostics)).toEqual(["CCC_PLANNING_OBJECTION_UNRESOLVED"]);
    expect(diagnostics[0]!.message).toContain(BLOCKING_B);
  });

  it("a deferred disposition on a blocking objection gives OBJECTION_UNRESOLVED", () => {
    const diagnostics = assessCccPlanningObjectionDispositions([objection(BLOCKING_A, "blocking")], [record(BLOCKING_A, "deferred")]);
    expect(codes(diagnostics)).toEqual(["CCC_PLANNING_OBJECTION_UNRESOLVED"]);
    expect(diagnostics[0]!.message).toContain("deferred");
  });

  it("a rejected disposition with no evidence ref gives OBJECTION_UNRESOLVED", () => {
    const diagnostics = assessCccPlanningObjectionDispositions([objection(BLOCKING_A, "blocking")], [record(BLOCKING_A, "rejected", [])]);
    expect(codes(diagnostics)).toEqual(["CCC_PLANNING_OBJECTION_UNRESOLVED"]);
  });

  it("a decision record for another objection does not resolve a blocking objection", () => {
    const diagnostics = assessCccPlanningObjectionDispositions([objection(BLOCKING_A, "blocking")], [record(BLOCKING_B, "accepted")]);
    expect(codes(diagnostics)).toEqual(["CCC_PLANNING_OBJECTION_UNRESOLVED"]);
  });

  it("an advisory objection needs no decision record", () => {
    expect(assessCccPlanningObjectionDispositions([objection(ADVISORY_C, "advisory")], [])).toEqual([]);
  });
});
