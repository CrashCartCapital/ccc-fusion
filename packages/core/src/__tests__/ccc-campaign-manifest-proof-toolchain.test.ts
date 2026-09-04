import { describe, expect, it } from "vitest";
import {
  canonicalCccPrdJson,
  computeCccPrdProofDefinitionSha256,
  computeCccPrdProofV2AdmissionDigests,
} from "../ccc-prd/contract.js";
import type {
  CccPrdProofV2,
  CccPrdPythonExecutionToolchain,
  CccPrdSemanticBundle,
  CccPrdSemanticBundleV2,
} from "../ccc-prd/types.js";
import { createCccPrdImportTestProductBundle } from "../__test-utils__/ccc-prd-import-fixture.js";
import { createCccCampaignManifest } from "../ccc-campaign/canonical.js";
import type { CccCampaignProductExecutionPolicy } from "../ccc-campaign/types.js";

/*
Regression shape taken from the live Gate 3 campaign against the owner's Python
target repository (archive run r3). The halted proof was PROOF-EVIDENCE-LABELS,
schema ccc-prd.proof.v2, verifierProfile ccc-prd.verifier.python-adapter.v1,
with a populated executionToolchain.python block. Its compile-time pin was
ce6dbec894db5380b4faff8e37ad87397b2338b6a70d1c98f6a0d1a6e2ad9f47, while the
proof the engine held at admission time recomputed to
be34f3c0f3a8f73dd14f92aa4177ce5564fe1c55b28f95615fe05eac7c5cce11 -- the exact
drift this file pins. Paths below are neutralized; only the structure matters,
because the defect drops the whole python sub-object regardless of its contents.
*/

const targetRoot = "/tmp/ccc-fusion-manifest-proof-toolchain";
const campaignStartedAt = "2026-09-03T12:00:00.000Z";
const pythonRoot = "/tmp/ccc-fusion-python/cpython-3.12.11";

function pythonExecutionToolchain(): CccPrdPythonExecutionToolchain {
  return {
    executablePath: `${pythonRoot}/bin/python3.12`,
    executableSha256: "2".repeat(64),
    version: "Python 3.12.11",
    versionOutputSha256: "3".repeat(64),
    runtimeManifest: {
      schema: "ccc-prd.python-runtime-manifest.v1",
      interpreter: { path: `${pythonRoot}/bin/python3.12`, sha256: "2".repeat(64) },
      stdlibRoot: `${pythonRoot}/lib/python3.12`,
      pythonHomeRoot: pythonRoot,
      sitePackagesRoots: [`${pythonRoot}/lib/python3.12/site-packages`],
      extensionModuleRoots: [`${pythonRoot}/lib/python3.12`],
      runtimeSupport: [],
      stdlib: [{ path: `${pythonRoot}/lib/python3.12/EXTERNALLY-MANAGED`, sha256: "4".repeat(64) }],
      sitePackages: [
        { path: `${pythonRoot}/lib/python3.12/site-packages/README.txt`, sha256: "5".repeat(64) },
      ],
      extensionModules: [
        {
          path: `${pythonRoot}/lib/python3.12/lib-dynload/_crypt.cpython-312-darwin.so`,
          sha256: "6".repeat(64),
        },
      ],
      dylibClosure: [
        {
          path: `${pythonRoot}/lib/libpython3.12.dylib`,
          requestedPaths: [
            `${pythonRoot}/lib/libpython3.12.dylib`,
            "@executable_path/../lib/libpython3.12.dylib",
          ],
          sha256: "7".repeat(64),
        },
      ],
    },
  };
}

function pythonAdapterProof(): CccPrdProofV2 {
  const identity = {
    executablePath: "/tmp/ccc-fusion-toolchain/task",
    executableSha256: "0".repeat(64),
    version: "task 3.44.1",
    versionOutputSha256: "1".repeat(64),
  };
  const withoutAdmission: CccPrdProofV2 = {
    schema: "ccc-prd.proof.v2",
    id: "PROOF-EVIDENCE-LABELS",
    requirementIds: ["REQ-EVIDENCE-LABELS"],
    clauseIds: ["AC-REQ-EVIDENCE-LABELS-001"],
    phases: ["task"],
    command: "task verify:evidence-labels",
    positiveOracle: "the declared candidate passes the frozen verifier",
    positiveCases: [{ id: "POS-EVIDENCE-LABELS-1", description: "labelled evidence passes" }],
    negativeControls: [{ id: "NEG-EVIDENCE-LABELS-1", description: "unlabelled evidence fails" }],
    verifierClosure: [
      {
        role: "task_runner",
        path: "Taskfile.yml",
        baseGitBlobOid: "a".repeat(40),
        sha256: "8".repeat(64),
      },
      {
        role: "harness",
        path: "verify/qe_evidence_adapter.py",
        baseGitBlobOid: "b".repeat(40),
        sha256: "9".repeat(64),
      },
    ],
    candidateInputs: ["src/evidence/labels.py"],
    executionToolchain: {
      task: { ...identity },
      node: { ...identity, executablePath: "/tmp/ccc-fusion-toolchain/node" },
      proofHost: {
        ...identity,
        id: "fusion-cli-semantic-proof-host.v1",
        executablePath: "/tmp/ccc-fusion-toolchain/ccc-campaign-proof-admission.js",
      },
      linkedRuntime: [],
      python: pythonExecutionToolchain(),
    },
    verifierProfile: {
      schema: "ccc-prd.verifier.python-adapter.v1",
      adapterPath: "verify/qe_evidence_adapter.py",
      targetPath: "verify/cases/labels",
    },
    spans: [{
      documentId: "DOC-EVIDENCE",
      path: "docs/prd.md",
      startLine: 1,
      endLine: 1,
      startColumn: 1,
      endColumn: 2,
      excerptSha256: "c".repeat(64),
    }],
    confidence: "high",
  };
  return {
    ...withoutAdmission,
    admission: {
      schema: "ccc-prd.proof-admission.v2",
      pluginId: "fusion-native",
      pluginVersion: "1.0.0",
      extensionId: "ccc-proof-admission",
      proofVersion: "ccc-proof-admission.v1",
      extensionRootRelativeSource: "verify/qe_evidence_adapter.py",
      extensionSourceSha256: "9".repeat(64),
      extensionManifestSha256: "d".repeat(64),
      definitionSha256: computeCccPrdProofDefinitionSha256(withoutAdmission),
      ...computeCccPrdProofV2AdmissionDigests(withoutAdmission),
    },
  };
}

function bundleWith(proofs: CccPrdProofV2[]): CccPrdSemanticBundleV2 {
  const base = createCccPrdImportTestProductBundle(targetRoot, "proof-toolchain");
  return {
    ...(base as CccPrdSemanticBundle as unknown as CccPrdSemanticBundleV2),
    schema: "ccc-prd.bundle.v2",
    proofs,
  };
}

const executionPolicy: CccCampaignProductExecutionPolicy = {
  schema: "ccc-campaign.execution-policy.v2",
  routes: [],
};

function manifestFor(bundle: CccPrdSemanticBundleV2) {
  return createCccCampaignManifest({
    projectId: "PROJECT-proof-toolchain",
    importId: "IMPORT-proof-toolchain",
    idempotencyKey: "IDEMPOTENCY-proof-toolchain",
    campaignId: "CAMPAIGN-proof-toolchain",
    bundle,
    executionPolicy,
    targetRepositoryPath: targetRoot,
    campaignStartedAt,
    manifestSchema: "ccc-campaign.manifest.v2",
    executionAuthorizationMode: "sealed_bundle_v1",
  });
}

describe("CCC campaign manifest proof execution toolchain custody", () => {
  it("RED-L14-python-toolchain: keeps the python toolchain so the admission pin still recomputes", () => {
    const proof = pythonAdapterProof();
    const manifest = manifestFor(bundleWith([proof]));
    const carried = manifest.proofs.find(({ id }) => id === proof.id) as CccPrdProofV2 | undefined;

    expect(carried).toBeDefined();
    expect(carried!.executionToolchain.python).toEqual(proof.executionToolchain.python);
    // The exact comparison requireProofEvaluator makes before admitting the proof.
    expect(computeCccPrdProofDefinitionSha256(carried!))
      .toBe(proof.admission!.definitionSha256);
  });

  it("RED-L14-python-toolchain-copy: copies the python toolchain instead of aliasing the bundle", () => {
    const proof = pythonAdapterProof();
    const manifest = manifestFor(bundleWith([proof]));
    const carried = manifest.proofs.find(({ id }) => id === proof.id) as CccPrdProofV2;

    expect(carried.executionToolchain.python).not.toBe(proof.executionToolchain.python);
    expect(carried.executionToolchain.python!.runtimeManifest)
      .not.toBe(proof.executionToolchain.python!.runtimeManifest);
    expect(carried.executionToolchain.python!.runtimeManifest.stdlib[0])
      .not.toBe(proof.executionToolchain.python!.runtimeManifest.stdlib[0]);
  });

  it("RED-L14-proof-copy-unmodelled: carries a toolchain field the copy does not enumerate", () => {
    const proof = pythonAdapterProof();
    const unmodelled = {
      ...proof,
      executionToolchain: {
        ...proof.executionToolchain,
        // Stands in for the next optional toolchain field. A copy that picks
        // fields by name drops this and the campaign halts at proof admission,
        // which is exactly how the python block was lost.
        wasm: { executablePath: "/tmp/ccc-fusion-toolchain/wasm", executableSha256: "e".repeat(64) },
      },
    } as unknown as CccPrdProofV2;
    const manifest = manifestFor(bundleWith([unmodelled]));
    const carried = manifest.proofs.find(({ id }) => id === proof.id) as CccPrdProofV2;

    expect(canonicalCccPrdJson(carried)).toBe(canonicalCccPrdJson(unmodelled));
    expect(computeCccPrdProofDefinitionSha256(carried))
      .toBe(computeCccPrdProofDefinitionSha256(unmodelled));
  });

  it("keeps every non-python proof field byte-identical to the bundle", () => {
    const proof = pythonAdapterProof();
    const bundle = bundleWith([proof]);
    const manifest = manifestFor(bundle);

    expect(canonicalCccPrdJson(manifest.proofs)).toBe(canonicalCccPrdJson(bundle.proofs));
  });
});
