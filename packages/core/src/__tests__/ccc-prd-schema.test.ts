import { describe, expect, it } from "vitest";
import * as core from "@fusion/core";

type Contract = {
  normalizeProtectedAction(input: { kind: string; target: string }): { kind: string; target: string; operatorDecision: string; requiresOperatorDecision: true };
  createRefusalBundle(input: { code: string; message: string; source?: { path: string; line: number; column: number } }): { kind: "refusal"; diagnostics: Array<{ code: string; message: string; span?: { path: string; line: number; column: number } }> };
};
const ccc = core as typeof core & Contract;

describe("ccc-prd public schema", () => {
  it("normalizes each protected action to a specific operator decision", () => {
    const expected = { promotion: "approve_promotion", live_execution: "approve_live_execution", deletion: "approve_deletion", merge: "approve_merge", publication: "approve_publication", credential: "approve_credential_use", billing: "approve_billing", upstream_write: "approve_upstream_write" };
    for (const [kind, operatorDecision] of Object.entries(expected)) expect(ccc.normalizeProtectedAction({ kind, target: "target" })).toEqual({ kind, target: "target", operatorDecision, requiresOperatorDecision: true });
  });

  it("makes source-addressable refusal bundles", () => {
    expect(ccc.createRefusalBundle({ code: "CCC_PRD_PROTECTED_PATH", message: "not read", source: { path: "_secrets/nope", line: 1, column: 1 } })).toEqual({ kind: "refusal", diagnostics: [{ code: "CCC_PRD_PROTECTED_PATH", message: "not read", span: { path: "_secrets/nope", line: 1, column: 1 } }] });
  });
});
