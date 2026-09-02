import { describe, expect, it } from "vitest";
import { createCccPrdImportTestBundle } from "../__test-utils__/ccc-prd-import-fixture.js";
import {
  computeCccPrdProofDefinitionSha256,
  computeCccPrdSemanticBundleSha256,
} from "../ccc-prd/contract.js";
import * as cccPrdContract from "../ccc-prd/contract.js";
import * as cccPrdPublic from "../ccc-prd/index.js";
import * as cccPrdTypes from "../ccc-prd/types.js";
import type { CccPrdSemanticBundle } from "../ccc-prd/types.js";
import { assertCccPrdImportBundle } from "../ccc-prd/import-admission.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);

function span(path: string, byteStart: number, text: string, excerptSha256 = HASH_A) {
  return {
    path,
    byteStart,
    byteEnd: byteStart + Buffer.byteLength(text),
    line: 10,
    column: 4,
    endLine: 10,
    endColumn: 4 + Array.from(text).length,
    sha256: HASH_B,
    excerptSha256,
  };
}

function proofV2(overrides: Record<string, unknown> = {}) {
  return {
    schema: "ccc-prd.proof.v2",
    id: "PROOF-slugify",
    requirementIds: ["REQ-slugify"],
    clauseIds: ["AC-REQ-slugify-002", "AC-REQ-slugify-001"],
    phases: ["final_integrated", "task"],
    command: "task verify:slugify",
    positiveOracle: "all declared semantic cases pass",
    positiveCases: [
      { id: "CASE-basic", description: "ordinary words become a slug" },
      { id: "CASE-empty", description: "empty input stays empty" },
    ],
    negativeControls: [
      { id: "CONTROL-punctuation", description: "a punctuation-preserving defect fails" },
      { id: "CONTROL-separators", description: "a repeated-separator defect fails" },
    ],
    verifierClosure: [
      {
        role: "harness",
        path: "verify/slugify.acceptance.test.js",
        baseGitBlobOid: "1".repeat(40),
        sha256: HASH_A,
      },
      {
        role: "task_runner",
        path: "Taskfile.yml",
        baseGitBlobOid: "2".repeat(40),
        sha256: HASH_B,
      },
    ],
    candidateInputs: ["test/slugify.test.js", "src/slugify.js"],
    executionToolchain: {
      task: {
        executablePath: "/opt/ccc/bin/task",
        executableSha256: HASH_A,
        version: "3.44.1",
        versionOutputSha256: HASH_B,
      },
      node: {
        executablePath: "/opt/ccc/bin/node",
        executableSha256: HASH_C,
        version: "24.6.0",
        versionOutputSha256: HASH_D,
      },
      proofHost: {
        id: "ccc-proof-host",
        executablePath: "/opt/ccc/bin/proof-host",
        executableSha256: HASH_D,
        version: "2.0.0",
        versionOutputSha256: HASH_C,
      },
      linkedRuntime: [{
        platform: "darwin",
        loaderRole: "node",
        loaderPath: "/opt/ccc/bin/node",
        requestedPath: "@rpath/libnode.137.dylib",
        canonicalPath: "/opt/ccc/lib/libnode.137.dylib",
        sha256: HASH_A,
      }],
    },
    spans: [],
    confidence: "high",
    ...overrides,
  };
}

function bundleV2(): CccPrdSemanticBundle {
  const base = createCccPrdImportTestBundle("/tmp/ccc-semantic-v2", "semantic-v2");
  const clauseOne = {
    id: "AC-REQ-semantic-v2-001",
    requirementId: base.requirements[0]!.id,
    text: "Return an empty string for empty input.",
    proofIds: ["PROOF-slugify"],
    span: span("PRD.md", 100, "Return an empty string for empty input."),
  };
  const clauseTwo = {
    id: "AC-REQ-semantic-v2-002",
    requirementId: base.requirements[0]!.id,
    text: "Collapse repeated separators.",
    proofIds: ["PROOF-slugify"],
    span: span("PRD.md", 200, "Collapse repeated separators.", HASH_C),
  };
  const withoutHash = {
    ...base,
    schema: "ccc-prd.bundle.v2",
    requirements: [{
      ...base.requirements[0]!,
      proofIds: ["PROOF-slugify"],
      acceptanceClauses: [clauseTwo, clauseOne],
      acceptanceDispositions: [],
    }],
    proofs: [proofV2({
      requirementIds: [base.requirements[0]!.id],
      clauseIds: [clauseTwo.id, clauseOne.id],
    })],
    tasks: [{
      ...base.tasks[0]!,
      proofIds: ["PROOF-slugify"],
    }],
  } as unknown as CccPrdSemanticBundle;
  return {
    ...withoutHash,
    bundleHash: computeCccPrdSemanticBundleSha256(withoutHash),
  } as CccPrdSemanticBundle;
}

describe("CCC PRD semantic contract v2", () => {
  it("RED-S4-schema-contract: publishes explicit v1 and v2 schema discriminators without moving packet or implementation provenance", () => {
    expect(cccPrdTypes).toMatchObject({
      CCC_PRD_PACKET_SCHEMA_VERSION: "ccc-prd.packet.v1",
      CCC_PRD_IMPLEMENTATION_FACT_PROVENANCE_SCHEMA_VERSION:
        "ccc-prd.implementation-fact-provenance.v1",
      CCC_PRD_AUTHORING_PROPOSAL_V1_SCHEMA_VERSION: "ccc-prd.authoring-proposal.v1",
      CCC_PRD_AUTHORING_PROPOSAL_V2_SCHEMA_VERSION: "ccc-prd.authoring-proposal.v2",
      CCC_PRD_AUTHORING_PROPOSAL_FRAGMENT_V1_SCHEMA_VERSION:
        "ccc-prd.authoring-proposal-fragment.v1",
      CCC_PRD_AUTHORING_PROPOSAL_FRAGMENT_V2_SCHEMA_VERSION:
        "ccc-prd.authoring-proposal-fragment.v2",
      CCC_PRD_SIDECAR_V1_SCHEMA_VERSION: "ccc-prd.sidecar.v1",
      CCC_PRD_SIDECAR_V2_SCHEMA_VERSION: "ccc-prd.sidecar.v2",
      CCC_PRD_BUNDLE_V1_SCHEMA_VERSION: "ccc-prd.bundle.v1",
      CCC_PRD_BUNDLE_V2_SCHEMA_VERSION: "ccc-prd.bundle.v2",
      CCC_PRD_PROOF_ADMISSION_V1_SCHEMA_VERSION: "ccc-prd.proof-admission.v1",
      CCC_PRD_PROOF_ADMISSION_V2_SCHEMA_VERSION: "ccc-prd.proof-admission.v2",
      CCC_PRD_PROOF_V2_SCHEMA_VERSION: "ccc-prd.proof.v2",
      CCC_PRD_VERIFIER_NODE_LOOPBACK_V1_SCHEMA_VERSION:
        "ccc-prd.verifier.node-loopback.v1",
    });
    expect(cccPrdTypes.CCC_PRD_AUTHORING_PROPOSAL_SCHEMA_VERSION)
      .toBe("ccc-prd.authoring-proposal.v1");
    expect(cccPrdTypes.CCC_PRD_AUTHORING_PROPOSAL_FRAGMENT_SCHEMA_VERSION)
      .toBe("ccc-prd.authoring-proposal-fragment.v1");
    expect(cccPrdTypes.CCC_PRD_SIDECAR_SCHEMA_VERSION).toBe("ccc-prd.sidecar.v1");
    expect(cccPrdTypes.CCC_PRD_BUNDLE_SCHEMA_VERSION).toBe("ccc-prd.bundle.v1");
    expect(cccPrdTypes.CCC_PRD_PROOF_ADMISSION_SCHEMA_VERSION)
      .toBe("ccc-prd.proof-admission.v1");
    expect(cccPrdPublic).toMatchObject({
      CCC_PRD_BUNDLE_V2_SCHEMA_VERSION: "ccc-prd.bundle.v2",
      CCC_PRD_EXECUTION_PROMPT_V2_SCHEMA_VERSION: "ccc-prd.execution-prompt.v2",
      CCC_PRD_VERIFIER_NODE_LOOPBACK_V1_SCHEMA_VERSION:
        "ccc-prd.verifier.node-loopback.v1",
      computeCccPrdProofDefinitionSha256: expect.any(Function),
      computeCccPrdProofV2AdmissionDigests: expect.any(Function),
      buildCccPrdTaskExecutionPrompt: expect.any(Function),
    });
  });

  it("RED-G2-node-loopback-definition-hash: binds the optional immutable Node loopback profile", () => {
    const base = proofV2();
    const nodeLoopback = {
      ...base,
      verifierProfile: {
        schema: "ccc-prd.verifier.node-loopback.v1",
      },
    };

    expect(computeCccPrdProofDefinitionSha256(nodeLoopback as never)).not.toBe(
      computeCccPrdProofDefinitionSha256(base as never),
    );
  });

  it("RED-S4-proof-custody: v2 proof identity binds every semantic and execution input", () => {
    const base = proofV2();
    const expected = computeCccPrdProofDefinitionSha256(base as never);
    const mutations = [
      { requirementIds: ["REQ-other"] },
      { clauseIds: ["AC-REQ-slugify-001"] },
      { phases: ["task"] },
      { candidateInputs: ["src/slugify.js"] },
      { verifierClosure: [base.verifierClosure[0]] },
      {
        executionToolchain: {
          ...base.executionToolchain,
          task: { ...base.executionToolchain.task, executableSha256: HASH_D },
        },
      },
      {
        executionToolchain: {
          ...base.executionToolchain,
          node: { ...base.executionToolchain.node, version: "24.7.0" },
        },
      },
      {
        executionToolchain: {
          ...base.executionToolchain,
          proofHost: { ...base.executionToolchain.proofHost, id: "other-proof-host" },
        },
      },
      {
        executionToolchain: {
          ...base.executionToolchain,
          linkedRuntime: [{
            ...base.executionToolchain.linkedRuntime[0],
            sha256: HASH_D,
          }],
        },
      },
      { positiveOracle: "changed source-owned oracle" },
      { positiveCases: [{ id: "CASE-basic", description: "changed meaning" }] },
      { negativeControls: [{ id: "CONTROL-punctuation", description: "changed control" }] },
      { command: "task verify:other" },
    ];
    for (const mutation of mutations) {
      expect(computeCccPrdProofDefinitionSha256({
        ...base,
        ...mutation,
      } as never)).not.toBe(expected);
    }
  });

  it("RED-R1-python-semantic-v2-digest: optional Python profile and runtime identity are bound by generic v2 hashes", () => {
    const base = proofV2();
    const python = {
      ...base,
      verifierProfile: {
        schema: "ccc-prd.verifier.python-adapter.v1",
        adapterPath: "verify/python_adapter.py",
        targetPath: "fixtures/python-target",
      },
      executionToolchain: {
        ...base.executionToolchain,
        python: {
          ...base.executionToolchain.python,
          executablePath: "/opt/ccc/bin/python3",
          executableSha256: "e".repeat(64),
          version: "3.12.10",
          versionOutputSha256: "f".repeat(64),
          runtimeManifest: {
            schema: "ccc-prd.python-runtime-manifest.v1",
            interpreter: { path: "/opt/ccc/bin/python3", sha256: "e".repeat(64) },
            stdlibRoot: "/opt/ccc/lib/python3.12",
            pythonHomeRoot: "/opt/ccc",
            sitePackagesRoots: ["/opt/ccc/lib/python3.12/site-packages"],
            extensionModuleRoots: ["/opt/ccc/lib/python3.12/lib-dynload"],
            runtimeSupport: [],
            stdlib: [{ path: "/opt/ccc/lib/python3.12/os.py", sha256: HASH_A }],
            sitePackages: [{ path: "/opt/ccc/lib/python3.12/site-packages/fixture.py", sha256: HASH_B }],
            extensionModules: [{ path: "/opt/ccc/lib/python3.12/lib-dynload/_fixture.so", sha256: HASH_C }],
            dylibClosure: [{ path: "/opt/ccc/lib/libpython3.12.dylib", sha256: HASH_D }],
          },
        },
      },
    } as unknown as typeof base;

    expect(computeCccPrdProofDefinitionSha256(python)).not.toBe(
      computeCccPrdProofDefinitionSha256(base),
    );
    expect(cccPrdContract.computeCccPrdProofExecutionToolchainSha256(python.executionToolchain))
      .not.toBe(cccPrdContract.computeCccPrdProofExecutionToolchainSha256(base.executionToolchain));
  });

  it("RED-S4-proof-canonical-sets: v2 proof identity ignores caller ordering for every semantic set", () => {
    const base = proofV2();
    const reordered = {
      ...base,
      requirementIds: [...base.requirementIds].reverse(),
      clauseIds: [...base.clauseIds].reverse(),
      phases: [...base.phases].reverse(),
      positiveCases: [...base.positiveCases].reverse(),
      negativeControls: [...base.negativeControls].reverse(),
      verifierClosure: [...base.verifierClosure].reverse(),
      candidateInputs: [...base.candidateInputs].reverse(),
    };
    expect(computeCccPrdProofDefinitionSha256(reordered as never))
      .toBe(computeCccPrdProofDefinitionSha256(base as never));
  });

  it("RED-S4-proof-subdigests: publishes one canonical implementation for closure, candidates, and toolchain admission digests", () => {
    const contract = cccPrdContract as typeof cccPrdContract & {
      computeCccPrdVerifierClosureSha256?: (value: unknown[]) => string;
      computeCccPrdCandidateInputsSha256?: (value: string[]) => string;
      computeCccPrdProofExecutionToolchainSha256?: (value: unknown) => string;
      computeCccPrdProofV2AdmissionDigests?: (value: unknown) => {
        verifierClosureSha256: string;
        candidateInputsSha256: string;
        executionToolchainSha256: string;
      };
    };
    const proof = proofV2();
    expect(contract.computeCccPrdVerifierClosureSha256).toBeTypeOf("function");
    expect(contract.computeCccPrdCandidateInputsSha256).toBeTypeOf("function");
    expect(contract.computeCccPrdProofExecutionToolchainSha256).toBeTypeOf("function");
    expect(contract.computeCccPrdProofV2AdmissionDigests).toBeTypeOf("function");
    expect(contract.computeCccPrdProofV2AdmissionDigests!(proof)).toEqual({
      verifierClosureSha256: contract.computeCccPrdVerifierClosureSha256!(
        [...proof.verifierClosure].reverse(),
      ),
      candidateInputsSha256: contract.computeCccPrdCandidateInputsSha256!(
        [...proof.candidateInputs].reverse(),
      ),
      executionToolchainSha256:
        contract.computeCccPrdProofExecutionToolchainSha256!(proof.executionToolchain),
    });
  });

  it("RED-S5-linked-runtime-digest: toolchain digest binds linked runtime bytes and canonicalizes manifest order", () => {
    const proof = proofV2();
    const reversed = {
      ...proof.executionToolchain,
      linkedRuntime: [
        {
          platform: "darwin" as const,
          loaderRole: "proof_host" as const,
          loaderPath: "/opt/ccc/bin/proof-host",
          requestedPath: "/opt/ccc/lib/libhelper.dylib",
          canonicalPath: "/opt/ccc/lib/libhelper.dylib",
          sha256: HASH_B,
        },
        ...proof.executionToolchain.linkedRuntime,
      ].reverse(),
    };
    const canonical = {
      ...proof.executionToolchain,
      linkedRuntime: [...reversed.linkedRuntime].reverse(),
    };
    expect(cccPrdContract.computeCccPrdProofExecutionToolchainSha256(reversed as never))
      .toBe(cccPrdContract.computeCccPrdProofExecutionToolchainSha256(canonical as never));
    expect(cccPrdContract.computeCccPrdProofExecutionToolchainSha256({
      ...canonical,
      linkedRuntime: canonical.linkedRuntime.map((entry, index) => index === 0
        ? { ...entry, sha256: HASH_D }
        : entry),
    } as never)).not.toBe(
      cccPrdContract.computeCccPrdProofExecutionToolchainSha256(canonical as never),
    );
  });

  it("RED-S4-version-dispatch: refuses foreign proof and bundle schemas instead of interpreting them as v1", () => {
    expect(() => computeCccPrdProofDefinitionSha256({
      ...proofV2(),
      schema: "ccc-prd.proof.v3",
    } as never)).toThrow("unsupported CCC PRD proof schema");
    expect(() => computeCccPrdSemanticBundleSha256({
      ...bundleV2(),
      schema: "ccc-prd.bundle.v3",
    } as never)).toThrow("unsupported CCC PRD semantic bundle schema");
  });

  it("RED-S4-import-admission: admits an exact hash-bound v2 bundle through the authoritative core boundary", () => {
    const bundle = bundleV2();

    expect(() => assertCccPrdImportBundle(
      bundle,
      bundle.targetRepository.path,
      "semantic-v2-import",
    )).not.toThrow();
  });

  it("RED-S4-bundle-canonical-sets: v2 bundle identity canonicalizes clauses and proof sets", () => {
    const base = bundleV2();
    const requirement = base.requirements[0] as unknown as {
      acceptanceClauses: unknown[];
      acceptanceDispositions: unknown[];
    };
    const proof = base.proofs[0] as unknown as ReturnType<typeof proofV2>;
    const reordered = {
      ...base,
      requirements: [{
        ...base.requirements[0],
        acceptanceClauses: [...requirement.acceptanceClauses].reverse(),
        acceptanceDispositions: [...requirement.acceptanceDispositions].reverse(),
      }],
      proofs: [{
        ...proof,
        clauseIds: [...proof.clauseIds].reverse(),
        phases: [...proof.phases].reverse(),
        positiveCases: [...proof.positiveCases].reverse(),
        negativeControls: [...proof.negativeControls].reverse(),
        verifierClosure: [...proof.verifierClosure].reverse(),
        candidateInputs: [...proof.candidateInputs].reverse(),
      }],
    } as unknown as CccPrdSemanticBundle;
    expect(computeCccPrdSemanticBundleSha256(reordered))
      .toBe(computeCccPrdSemanticBundleSha256(base));
  });

  it("RED-S4-v1-hash-stability: preserves the frozen v1 proof and bundle hash algorithms byte-for-byte", () => {
    expect(computeCccPrdProofDefinitionSha256({
      id: "PROOF-contract",
      requirementIds: ["REQ-contract"],
      command: "pnpm test",
      positiveOracle: "the named test passes",
      negativeControls: ["the planted defect fails"],
      spans: [],
      confidence: "high",
    })).toBe("7564e50f0bda067437026d3af2a8eac063082aaa2fe5421564fd08d33d2f7084");
    expect(createCccPrdImportTestBundle(
      "/tmp/ccc-v1-byte-stability",
      "v1-byte-stability",
    ).bundleHash).toBe("1a360a2bd771fbf2e6cd3ef2556666f9919fe3b07bc2e90bc2f0b8a4fdca1980");
  });
});
