import {
  CCC_PRD_PROOF_ADMISSION_SCHEMA_VERSION,
  computeCccPrdProofV2AdmissionDigests,
  computeCccPrdProofDefinitionSha256,
  type CccPrdProof,
  type CccPrdProofV2,
} from "@fusion/core";
import { describe, expect, it } from "vitest";
import {
  CCC_CAMPAIGN_PROOF_ADMISSION_EXTENSION_ID,
  CCC_CAMPAIGN_PROOF_ADMISSION_PLUGIN_ID,
  CCC_CAMPAIGN_PROOF_ADMISSION_PLUGIN_VERSION,
  CCC_CAMPAIGN_PROOF_ADMISSION_PROOF_VERSION,
  CCC_CAMPAIGN_PROOF_ADMISSION_SELF_CHECK,
  createCccCampaignProofAdmissionEvaluatorInput,
  computeCccCampaignProofAdmissionInputSha256,
  evaluateCccCampaignProofAdmission,
} from "../ccc-campaign-proof-admission.js";

function admittedProof(
  overrides: Partial<CccPrdProof> = {},
): CccPrdProof {
  const definition: CccPrdProof = {
    id: "PROOF-ADMISSION-1",
    requirementIds: ["REQ-ADMISSION-1"],
    command: CCC_CAMPAIGN_PROOF_ADMISSION_SELF_CHECK.command,
    positiveOracle: CCC_CAMPAIGN_PROOF_ADMISSION_SELF_CHECK.positiveOracle,
    negativeControls: [...CCC_CAMPAIGN_PROOF_ADMISSION_SELF_CHECK.negativeControls],
    spans: [],
    confidence: "high",
    ...overrides,
  };
  return {
    ...definition,
    admission: {
      schema: CCC_PRD_PROOF_ADMISSION_SCHEMA_VERSION,
      pluginId: CCC_CAMPAIGN_PROOF_ADMISSION_PLUGIN_ID,
      pluginVersion: CCC_CAMPAIGN_PROOF_ADMISSION_PLUGIN_VERSION,
      extensionId: CCC_CAMPAIGN_PROOF_ADMISSION_EXTENSION_ID,
      proofVersion: CCC_CAMPAIGN_PROOF_ADMISSION_PROOF_VERSION,
      extensionRootRelativeSource: "ccc-campaign-proof-admission.js",
      extensionSourceSha256: "a".repeat(64),
      extensionManifestSha256: "b".repeat(64),
      definitionSha256: computeCccPrdProofDefinitionSha256(definition),
    },
  };
}

function evaluatorInput(proof = admittedProof(), signal = new AbortController().signal) {
  return createCccCampaignProofAdmissionEvaluatorInput({
    campaignId: "campaign-1",
    importId: "import-1",
    bundleHash: "c".repeat(64),
    manifestHash: "d".repeat(64),
    taskId: "task-1",
    nodeId: "node-1",
    workItemId: "work-item-1",
    owner: "worker-1",
    attempt: 1,
    proofDefinitionSha256: computeCccPrdProofDefinitionSha256(proof),
    proof,
    signal,
  });
}

function semanticProofV2(overrides: Partial<CccPrdProofV2> = {}): CccPrdProofV2 {
  const definition: CccPrdProofV2 = {
    schema: "ccc-prd.proof.v2",
    id: "PROOF-SEMANTIC-1",
    requirementIds: ["REQ-SEMANTIC-1"],
    clauseIds: ["AC-REQ-SEMANTIC-1-001"],
    phases: ["final_integrated", "task"],
    command: "task verify:semantic",
    positiveOracle: "the exact candidate passes",
    positiveCases: [{ id: "CASE-PASS", description: "candidate passes" }],
    negativeControls: [{ id: "CONTROL-BAD", description: "bad candidate fails" }],
    verifierClosure: [
      { role: "harness", path: "verify/harness.mjs", baseGitBlobOid: "1".repeat(40), sha256: "2".repeat(64) },
      { role: "task_runner", path: "Taskfile.yml", baseGitBlobOid: "3".repeat(40), sha256: "4".repeat(64) },
    ],
    candidateInputs: ["src/value.js"],
    executionToolchain: {
      task: { executablePath: "/tool/task", executableSha256: "5".repeat(64), version: "task 1", versionOutputSha256: "6".repeat(64) },
      node: { executablePath: "/tool/node", executableSha256: "7".repeat(64), version: "node 24", versionOutputSha256: "8".repeat(64) },
      proofHost: { id: "fusion-proof-host", executablePath: "/tool/host", executableSha256: "9".repeat(64), version: "host 1", versionOutputSha256: "a".repeat(64) },
      linkedRuntime: [],
    },
    spans: [],
    confidence: "high",
    ...overrides,
  };
  return {
    ...definition,
    admission: {
      schema: "ccc-prd.proof-admission.v2",
      pluginId: CCC_CAMPAIGN_PROOF_ADMISSION_PLUGIN_ID,
      pluginVersion: CCC_CAMPAIGN_PROOF_ADMISSION_PLUGIN_VERSION,
      extensionId: CCC_CAMPAIGN_PROOF_ADMISSION_EXTENSION_ID,
      proofVersion: CCC_CAMPAIGN_PROOF_ADMISSION_PROOF_VERSION,
      extensionRootRelativeSource: "ccc-campaign-proof-admission.js",
      extensionSourceSha256: "b".repeat(64),
      extensionManifestSha256: "c".repeat(64),
      definitionSha256: computeCccPrdProofDefinitionSha256(definition),
      ...computeCccPrdProofV2AdmissionDigests(definition),
    },
  };
}

describe("CCC native campaign proof admission", () => {
  it("keeps the self-contained evaluator byte-identical to core's semantic-v2 definition hash", async () => {
    const proof = semanticProofV2();
    const input = evaluatorInput(proof);

    expect(input.proofDefinitionSha256).toBe(computeCccPrdProofDefinitionSha256(proof));
    await expect(evaluateCccCampaignProofAdmission(input)).resolves.toEqual({
      outcome: "pass",
      evaluatedInputSha256: input.inputSha256,
      summary: "semantic proof v2 declaration is admissible; command not executed",
    });
  });

  it("keeps the self-contained evaluator byte-identical to core's hash with an unsorted linked runtime and a verifier profile", async () => {
    const linkedRuntime: CccPrdProofV2["executionToolchain"]["linkedRuntime"] = [
      {
        platform: "darwin",
        loaderRole: "proof_host",
        loaderPath: "/tool/host",
        requestedPath: "@rpath/libssl.3.dylib",
        canonicalPath: "/opt/homebrew/opt/openssl@3/lib/libssl.3.dylib",
        sha256: "b".repeat(64),
      },
      {
        platform: "darwin",
        loaderRole: "task",
        loaderPath: "/tool/task",
        requestedPath: "@rpath/libSystem.B.dylib",
        canonicalPath: "/usr/lib/libSystem.B.dylib",
        sha256: "c".repeat(64),
      },
      {
        platform: "darwin",
        loaderRole: "node",
        loaderPath: "/tool/node",
        requestedPath: "@rpath/libicuuc.75.dylib",
        canonicalPath: "/opt/homebrew/opt/icu4c/lib/libicuuc.75.dylib",
        sha256: "d".repeat(64),
      },
    ];
    const proof = semanticProofV2({
      executionToolchain: {
        task: { executablePath: "/tool/task", executableSha256: "5".repeat(64), version: "task 1", versionOutputSha256: "6".repeat(64) },
        node: { executablePath: "/tool/node", executableSha256: "7".repeat(64), version: "node 24", versionOutputSha256: "8".repeat(64) },
        proofHost: { id: "fusion-proof-host", executablePath: "/tool/host", executableSha256: "9".repeat(64), version: "host 1", versionOutputSha256: "a".repeat(64) },
        linkedRuntime,
      },
      verifierProfile: { schema: "ccc-prd.verifier.node-loopback.v1" },
    });
    const input = evaluatorInput(proof);

    expect(input.proofDefinitionSha256).toBe(computeCccPrdProofDefinitionSha256(proof));
    await expect(evaluateCccCampaignProofAdmission(input)).resolves.toEqual({
      outcome: "pass",
      evaluatedInputSha256: input.inputSha256,
      summary: "semantic proof v2 declaration is admissible; command not executed",
    });
  });

  it("accepts the exact CCC lab kernel transaction declaration without executing it", async () => {
    const input = evaluatorInput(admittedProof({
      command: "task verify:phase0 -- kernel-transaction",
      positiveOracle: "Every declared legal transition and crash boundary passes with one recoverable authoritative state.",
      negativeControls: [
        "illegal transition is refused before mutation",
        "duplicate idempotency key cannot create a second publish",
        "crash between boundaries cannot expose a half-published batch",
      ],
    }));

    await expect(evaluateCccCampaignProofAdmission(input)).resolves.toEqual({
      outcome: "pass",
      evaluatedInputSha256: input.inputSha256,
      summary: "proof declaration is admissible; command not executed",
    });
  });

  it("verifies the exact immutable binding self-check without executing a command", async () => {
    const input = evaluatorInput();

    await expect(evaluateCccCampaignProofAdmission(input)).resolves.toEqual({
      outcome: "pass",
      evaluatedInputSha256: input.inputSha256,
      summary: "proof binding semantics verified; command not executed",
    });
  });

  it.each([
    ["blank positive oracle", { command: "task verify:phase0 -- kernel-transaction", positiveOracle: "   ", negativeControls: ["negative control"] }],
    ["oversized positive oracle", { command: "task verify:phase0 -- kernel-transaction", positiveOracle: "o".repeat(513), negativeControls: ["negative control"] }],
    ["empty negative controls", { command: "task verify:phase0 -- kernel-transaction", positiveOracle: "positive oracle", negativeControls: [] }],
    ["duplicate negative controls", { command: "task verify:phase0 -- kernel-transaction", positiveOracle: "positive oracle", negativeControls: ["same", "same"] }],
    ["blank negative control", { command: "task verify:phase0 -- kernel-transaction", positiveOracle: "positive oracle", negativeControls: [" "] }],
    ["oversized negative control", { command: "task verify:phase0 -- kernel-transaction", positiveOracle: "positive oracle", negativeControls: ["n".repeat(513)] }],
  ] as const)("refuses non-self-check declaration with %s", async (_label, overrides) => {
    const input = evaluatorInput(admittedProof(overrides));

    await expect(evaluateCccCampaignProofAdmission(input)).resolves.toMatchObject({
      outcome: "fail",
      summary: expect.stringContaining("command not executed"),
    });
  });

  it("deep-clones and freezes the proof payload while preserving the live abort signal", () => {
    const proof = admittedProof({
      spans: [{
        path: "packet.md",
        byteStart: 0,
        byteEnd: 4,
        line: 1,
        column: 1,
        endLine: 1,
        endColumn: 5,
        sha256: "e".repeat(64),
        excerptSha256: "f".repeat(64),
      }],
    });
    const controller = new AbortController();
    const input = evaluatorInput(proof, controller.signal);
    const sealedProof = structuredClone(input.proof);
    const sealedInputSha256 = input.inputSha256;

    proof.command = "true";
    proof.requirementIds.push("REQ-MUTATED");
    proof.negativeControls[0] = "false";
    proof.admission!.pluginId = "foreign-plugin";
    proof.spans[0]!.path = "foreign.md";

    expect(input.proof).toEqual(sealedProof);
    expect(input.inputSha256).toBe(sealedInputSha256);
    expect(Object.isFrozen(input)).toBe(true);
    expect(Object.isFrozen(input.proof)).toBe(true);
    expect(Object.isFrozen(input.proof.requirementIds)).toBe(true);
    expect(Object.isFrozen(input.proof.negativeControls)).toBe(true);
    expect(Object.isFrozen(input.proof.admission)).toBe(true);
    expect(Object.isFrozen(input.proof.spans)).toBe(true);
    expect(Object.isFrozen(input.proof.spans[0])).toBe(true);
    expect(() => {
      (input.proof as CccPrdProof).command = "false";
    }).toThrow(TypeError);
    expect(() => {
      (input.proof.requirementIds as string[]).push("REQ-DIRECT-MUTATION");
    }).toThrow(TypeError);
    expect(input.signal).toBe(controller.signal);
    controller.abort();
    expect(input.signal.aborted).toBe(true);
  });

  it.each([
    ["constant true command", { command: "true" }],
    ["explicit exit-zero command", { command: "exit 0" }],
    ["echo-ok command", { command: "echo ok" }],
    ["shell-wrapped exit-zero command", { command: "sh -c 'exit 0'" }],
    ["bash-wrapped true command", { command: "bash -c \"true\"" }],
    ["absolute true command", { command: "/usr/bin/true" }],
    ["node explicit zero-exit command", { command: "node -e 'process.exit(0)'" }],
    ["shell substitution", { command: "task verify:phase0 -- $(whoami)" }],
    ["output redirection", { command: "task verify:phase0 -- proof > result" }],
    ["environment assignment", { command: "TOKEN=value task verify:phase0" }],
    ["shell wrapper", { command: "sh -c task verify:phase0" }],
    ["extra executable", { command: "task verify:phase0 -- node -e" }],
    ["recursive removal", { command: "task verify:phase0 -- rm -rf" }],
    ["curl executable", { command: "task verify:phase0 -- curl" }],
    ["python executable", { command: "task verify:phase0 -- python" }],
    ["python3 executable", { command: "task verify:phase0 -- python3" }],
    ["git executable", { command: "task verify:phase0 -- git status" }],
    ["gh executable", { command: "task verify:phase0 -- gh" }],
    ["pnpm executable", { command: "task verify:phase0 -- pnpm" }],
    ["npm executable", { command: "task verify:phase0 -- npm" }],
    ["npx executable", { command: "task verify:phase0 -- npx" }],
    ["bun executable", { command: "task verify:phase0 -- bun" }],
    ["deno executable", { command: "task verify:phase0 -- deno" }],
    ["ruby executable", { command: "task verify:phase0 -- ruby" }],
    ["perl executable", { command: "task verify:phase0 -- perl" }],
    ["java executable", { command: "task verify:phase0 -- java" }],
    ["go executable", { command: "task verify:phase0 -- go" }],
    ["cargo executable", { command: "task verify:phase0 -- cargo" }],
    ["make executable", { command: "task verify:phase0 -- make" }],
    ["oversized declaration", { command: `task verify:phase0 -- ${"a".repeat(513)}` }],
    ["generic positive oracle", { positiveOracle: "exit 0" }],
    ["generic negative control", { negativeControls: ["false"] }],
    ["duplicate requirement ids", { requirementIds: ["REQ-ADMISSION-1", "REQ-ADMISSION-1"] }],
    ["too many requirement ids", { requirementIds: Array.from({ length: 65 }, (_, index) => `REQ-${index}`) }],
    ["oversized requirement id", { requirementIds: ["R".repeat(129)] }],
    ["duplicate negative controls", {
      negativeControls: [
        "a stale definition hash is refused before any command can run",
        "a stale definition hash is refused before any command can run",
      ],
    }],
    ["positive oracle repeated as a negative control", {
      positiveOracle: "the named proof-admission assertions all pass",
      negativeControls: ["the named proof-admission assertions all pass"],
    }],
  ] as const)("refuses %s without executing a command", async (_label, overrides) => {
    const input = evaluatorInput(admittedProof(overrides));

    await expect(evaluateCccCampaignProofAdmission(input)).resolves.toMatchObject({
      outcome: "fail",
      evaluatedInputSha256: input.inputSha256,
      summary: expect.stringContaining("command not executed"),
    });
  });

  it("refuses stale proof-definition and admission-definition hashes", async () => {
    const proof = admittedProof();
    const staleAdmissionProof: CccPrdProof = {
      ...proof,
      admission: {
        ...proof.admission!,
        definitionSha256: "0".repeat(64),
      },
    };
    const staleDefinitionInput = {
      ...evaluatorInput(proof),
      proofDefinitionSha256: "0".repeat(64),
    };
    const { inputSha256: _oldInputSha256, signal, ...digestInput } = staleDefinitionInput;
    const reboundStaleDefinitionInput = {
      ...digestInput,
      inputSha256: computeCccCampaignProofAdmissionInputSha256(digestInput),
      signal,
    };

    await expect(
      evaluateCccCampaignProofAdmission(reboundStaleDefinitionInput),
    ).resolves.toMatchObject({
      outcome: "fail",
      summary: expect.stringContaining("command not executed"),
    });
    await expect(
      evaluateCccCampaignProofAdmission(evaluatorInput(staleAdmissionProof)),
    ).resolves.toMatchObject({
      outcome: "fail",
      summary: expect.stringContaining("command not executed"),
    });
  });

  it("refuses a stale evaluator input digest and echoes the current digest", async () => {
    const input = evaluatorInput();
    const staleInput = { ...input, inputSha256: "0".repeat(64) };
    const { inputSha256: _assertedInputSha256, signal: _signal, ...digestInput } = staleInput;
    const currentDigest = computeCccCampaignProofAdmissionInputSha256(digestInput);

    await expect(evaluateCccCampaignProofAdmission(staleInput)).resolves.toEqual({
      outcome: "fail",
      evaluatedInputSha256: currentDigest,
      summary: "evaluator input hash is stale; command not executed",
    });
  });

  it("refuses a proof admission bound to a different fixed identity", async () => {
    const proof = admittedProof();
    const foreignProof: CccPrdProof = {
      ...proof,
      admission: {
        ...proof.admission!,
        pluginVersion: "2.0.0",
      },
    };

    await expect(
      evaluateCccCampaignProofAdmission(evaluatorInput(foreignProof)),
    ).resolves.toMatchObject({
      outcome: "fail",
      summary: expect.stringContaining("command not executed"),
    });
  });

  it("refuses arbitrary shell and prose declarations without executing them", async () => {
    const input = evaluatorInput(admittedProof({
      command: "rm -rf /",
      positiveOracle: "the moon is cheese",
      negativeControls: ["unicorn returns purple"],
    }));

    await expect(evaluateCccCampaignProofAdmission(input)).resolves.toMatchObject({
      outcome: "fail",
      evaluatedInputSha256: input.inputSha256,
      summary: "unsupported proof binding declaration; command not executed",
    });
  });

  it("stops before evaluation when the invocation is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("cancelled", "AbortError"));

    await expect(
      evaluateCccCampaignProofAdmission(evaluatorInput(admittedProof(), controller.signal)),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
