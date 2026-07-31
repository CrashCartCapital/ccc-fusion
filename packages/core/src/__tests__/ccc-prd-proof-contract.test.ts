import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createCccPrdImportTestBundle } from "../__test-utils__/ccc-prd-import-fixture.js";
import * as contract from "../ccc-prd/contract.js";
import * as cccPrdTypes from "../ccc-prd/types.js";
import type { CccPrdProof, CccPrdSemanticBundle } from "../ccc-prd/types.js";

type ProofContractExports = {
  computeCccPrdProofDefinitionSha256?: (proof: CccPrdProof) => string;
  computeCccPrdSemanticBundleSha256?: (bundle: CccPrdSemanticBundle) => string;
};

function proof(): CccPrdProof {
  return {
    id: "PROOF-contract",
    requirementIds: ["REQ-contract"],
    command: "pnpm test",
    positiveOracle: "the named test passes",
    negativeControls: ["the planted defect fails"],
    spans: [],
    confidence: "high",
  };
}

describe("CCC PRD proof identity contract", () => {
  it("publishes the exact proof-admission schema version", () => {
    expect(
      (cccPrdTypes as Record<string, unknown>).CCC_PRD_PROOF_ADMISSION_SCHEMA_VERSION,
    ).toBe("ccc-prd.proof-admission.v1");
  });

  it("hashes a proof definition with the entire admission omitted", () => {
    const compute = (contract as ProofContractExports).computeCccPrdProofDefinitionSha256;
    expect(compute).toBeTypeOf("function");

    const definition = proof();
    const expected = createHash("sha256")
      .update(contract.canonicalCccPrdJson(definition), "utf8")
      .digest("hex");
    const admitted = {
      ...definition,
      admission: {
        schema: "ccc-prd.proof-admission.v1",
        pluginId: "fusion-native",
        pluginVersion: "1.0.0",
        extensionId: "ccc-proof-admission",
        proofVersion: "v1",
        extensionRootRelativeSource: "dist/ccc-proof.js",
        extensionSourceSha256: "a".repeat(64),
        extensionManifestSha256: "b".repeat(64),
        definitionSha256: "c".repeat(64),
      },
    } as CccPrdProof;

    expect(compute!(admitted)).toBe(expected);
    expect(compute!({
      ...admitted,
      admission: {
        ...admitted.admission!,
        extensionSourceSha256: "d".repeat(64),
        definitionSha256: "e".repeat(64),
      },
    })).toBe(expected);
    expect(compute!({ ...definition, command: "pnpm test --changed" })).not.toBe(expected);
  });

  it("hashes only the compiler bundleWithoutHash projection", () => {
    const compute = (contract as ProofContractExports).computeCccPrdSemanticBundleSha256;
    expect(compute).toBeTypeOf("function");

    const bundle = createCccPrdImportTestBundle("/tmp/ccc-proof-contract");
    expect(compute!(bundle)).toBe(bundle.bundleHash);
    expect(compute!({
      ...bundle,
      callerInjectedAuthority: "must-not-enter-canonical-hash",
    } as CccPrdSemanticBundle)).toBe(bundle.bundleHash);
    expect(compute!({ ...bundle, sourceVersion: "changed" })).not.toBe(bundle.bundleHash);
    expect(compute!({
      ...bundle,
      materialCoverage: [{
        id: "MAT-contract",
        sourcePath: "prd.md",
        materialKind: "requirement",
        headingPath: ["Requirements"],
        title: "REQ-contract",
        spans: [],
        disposition: {
          kind: "task",
          taskIds: [bundle.tasks[0]!.id],
          requirementIds: [bundle.requirements[0]!.id],
        },
      }],
    })).not.toBe(bundle.bundleHash);
  });
});
