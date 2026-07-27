import { describe, expect, it } from "vitest";
import * as core from "../index.js";
import * as coreGate from "../index.gate.js";

describe("proof-admission core exports", () => {
  it("exports proof hashing and host custody from the public core barrel", () => {
    expect(core.computeCccPrdProofDefinitionSha256).toBeTypeOf("function");
    expect(core.computeCccPrdSemanticBundleSha256).toBeTypeOf("function");
    expect(core.deriveWorkflowExtensionHostProvenance).toBeTypeOf("function");
    expect(core.verifyWorkflowExtensionHostProvenance).toBeTypeOf("function");
  });

  it("mirrors workflow host custody through the engine gate barrel", () => {
    expect(coreGate.deriveWorkflowExtensionHostProvenance).toBeTypeOf("function");
    expect(coreGate.verifyWorkflowExtensionHostProvenance).toBeTypeOf("function");
  });
});
