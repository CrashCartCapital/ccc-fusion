import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canonicalCccPrdJson,
  createCccPrdProductExecutionPlan,
  type CustomProvider,
} from "@fusion/core";
import { compileCccPrdPacket, understandCccPrdPacket } from "@fusion/engine";
import type { CccPrdNativeAuthoringTransport } from "@fusion/engine";
import { bootstrapCccCampaignProofAdmissionHost } from "../ccc-native-proof-host.js";
import {
  MAX_OPERATOR_CONTEXT_BYTES,
  readBoundedPrdStdin,
} from "../prd-stdin.js";
import { runPrdCommand } from "../prd.js";
import {
  cleanupPacketRoots,
  createPacketRoot,
  repoRoot,
} from "./prd-built-cli-fixture.js";

afterEach(cleanupPacketRoots);
const bootstrapProofAdmission = () => bootstrapCccCampaignProofAdmissionHost({
  builtRootPath: join(repoRoot, "packages/cli/dist"),
});

async function createExecutionPlan(
  packet: ReturnType<typeof createPacketRoot>,
  name = "execution-plan.json",
): Promise<string> {
  const outputPath = join(packet.root, name);
  const output: string[] = [];
  const exit = await runPrdCommand([
    "policy",
    packet.root,
    packet.manifest,
    packet.sidecar,
    packet.target,
    packet.base,
    outputPath,
    "--provider",
    "deterministic-fake",
    "--model",
    "fixture-v2",
    "--transport",
    "pi",
  ], { write: (line) => output.push(line) });
  expect(exit, output.join("\n")).toBe(0);
  return outputPath;
}

function createLegacyExecutionPlan(
  packet: ReturnType<typeof createPacketRoot>,
): { bundleHash: string; outputPath: string } {
  const bundle = compileCccPrdPacket({
    rootDir: packet.root,
    manifestPath: packet.manifest,
    sidecarPath: packet.sidecar,
    expectedTarget: packet.target,
    expectedBase: packet.base,
    requireMaterialCoverage: true,
  });
  if (bundle.kind === "refusal") {
    throw new Error(`legacy fixture did not compile: ${JSON.stringify(bundle.diagnostics)}`);
  }
  const plan = createCccPrdProductExecutionPlan({
    bundle,
    route: {
      providerId: "deterministic-fake",
      modelId: "fixture-v1",
      transport: "pi",
    },
  });
  const outputPath = join(packet.root, "legacy-execution-plan.json");
  writeFileSync(outputPath, `${canonicalCccPrdJson(plan)}\n`);
  return { bundleHash: bundle.bundleHash, outputPath };
}

async function authorSemanticV2Packet(
  packet: ReturnType<typeof createPacketRoot>,
): Promise<void> {
  if (!packet.semanticProofToolchainPaths) {
    throw new Error("semantic-v2 packet fixture is missing controller toolchain paths");
  }
  const output: string[] = [];
  const exit = await runPrdCommand(
    ["author", packet.root, packet.manifest, packet.proposal, packet.sidecar],
    { write: (line) => output.push(line) },
    {
      bootstrapProofAdmission,
      resolveSemanticProofToolchainPaths: () => packet.semanticProofToolchainPaths!,
    },
  );
  expect(exit, output.join("\n")).toBe(0);
  expect(JSON.parse(readFileSync(packet.sidecar, "utf8"))).toMatchObject({
    schema: "ccc-prd.sidecar.v2",
    provenance: { authoringModel: "proposal-file-v2" },
  });
}

/**
 * The operator loop prints human-readable prose by default. These assertions
 * pin the machine-readable contract, so they ask for it explicitly.
 */
async function runPrdJson(
  args: string[],
  io: Parameters<typeof runPrdCommand>[1],
  dependencies?: Parameters<typeof runPrdCommand>[2],
  commandContext?: Parameters<typeof runPrdCommand>[3],
): Promise<number> {
  return runPrdCommand([...args, "--json"], io, dependencies, commandContext);
}

function sealedExecutionAuthorization(status: "issued" | "claimed" | "settled" = "issued") {
  const authorizationDigest = "9".repeat(64);
  const member = (
    ordinal: number,
    nativeTaskId: string,
    semanticTaskId: string,
    digest: string,
  ) => ({
    ordinal,
    nativeTaskId,
    semanticTaskId,
    actionId: `ACTION-live-${ordinal + 1}`,
    actionTarget: `provider://fixture/${semanticTaskId}`,
    providerId: "fixture",
    modelId: "fixture-v2",
    transport: "pi" as const,
    promptSchema: "ccc-prd.execution-prompt.v1" as const,
    promptSha256: digest.repeat(64),
    routeSha256: digest.repeat(64),
    bindingHash: digest.repeat(64),
    approvalRequestId: `ccc-approval-${digest.repeat(64)}`,
    memberHash: digest.repeat(64),
  });
  const members = [
    member(0, "TASK-coding", "TASK-1", "a"),
    member(1, "TASK-review", "TASK-2", "b"),
  ];
  return {
    schemaVersion: "ccc-campaign.execution-authorization.v1" as const,
    projectId: "project-1",
    importId: "import-1",
    campaignId: "campaign-1",
    idempotencyKey: "operator-key",
    workflowId: "workflow-1",
    workItemId: "work-item-1",
    workflowIrHash: "1".repeat(64),
    packetHash: "2".repeat(64),
    sidecarHash: "3".repeat(64),
    bundleHash: "4".repeat(64),
    manifestHash: "5".repeat(64),
    executionPolicySha256: "6".repeat(64),
    targetRepository: "/tmp/product-target",
    targetBase: "d".repeat(40),
    campaignStartedAt: "2999-01-01T00:00:00.000Z",
    campaignDeadlineAt: "2999-01-01T02:00:00.000Z",
    maxRequests: 24,
    maxConcurrency: 1,
    authorizationId: `ccc-execution-authorization-${authorizationDigest}`,
    authorizationDigest,
    memberSetHash: "7".repeat(64),
    members,
    memberCustody: members.map((entry) => ({
      ordinal: entry.ordinal,
      nativeTaskId: entry.nativeTaskId,
      semanticTaskId: entry.semanticTaskId,
      actionId: entry.actionId,
      actionTarget: entry.actionTarget,
      approvalRequestId: entry.approvalRequestId,
      status: status === "issued"
        ? "issued"
        : status === "claimed"
          ? "claimed"
          : "consumed",
      approvalTaskId: entry.nativeTaskId,
      approvalRunId: "RUN-product",
      bindingHash: entry.bindingHash,
    })),
    expectedRequestCount: 0,
    status,
    requester: {
      actorId: "ccc-campaign-runtime",
      actorType: "agent" as const,
      actorName: "CCC Campaign Runtime",
    },
    notBeforeAt: "2999-01-01T00:00:00.000Z",
    expiresAt: "2999-01-01T01:00:00.000Z",
    createdAt: "2999-01-01T00:00:00.000Z",
    updatedAt: "2999-01-01T00:00:00.000Z",
  };
}

function diagnosticLiveApproval(id: string, taskId: string) {
  return {
    id,
    status: "issued",
    taskId,
    runId: "RUN-product",
    requester: {
      actorId: "ccc-campaign-runtime",
      actorType: "agent",
      actorName: "CCC Campaign Runtime",
    },
    targetAction: {
      category: "command_execution",
      action: `ACTION-${taskId}`,
      summary: "Run one exact admitted provider action",
      resourceType: "ccc-campaign-live_execution",
      resourceId: `provider://fixture/${taskId}`,
      context: {
        protectedActionKind: "live_execution",
        operatorDecision: "approve_live_execution",
      },
    },
    requestedAt: "2026-07-31T00:00:00.000Z",
    createdAt: "2026-07-31T00:00:00.000Z",
    updatedAt: "2026-07-31T00:00:00.000Z",
    campaign: {
      binding: {
        projectId: "project-1",
        importId: "import-1",
        campaignId: "campaign-1",
        taskId,
        actionId: `ACTION-${taskId}`,
        actionTarget: `provider://fixture/${taskId}`,
        idempotencyKey: "operator-key",
        packetHash: "2".repeat(64),
        sidecarHash: "3".repeat(64),
        bundleHash: "4".repeat(64),
        targetRepository: "/tmp/product-target",
        targetBase: "d".repeat(40),
        providerId: "fixture",
        modelId: "fixture-v2",
        transport: "pi",
        manifestHash: "5".repeat(64),
        bindingHash: taskId === "TASK-coding" ? "a".repeat(64) : "b".repeat(64),
      },
      notBeforeAt: "2026-07-31T00:00:00.000Z",
      expiresAt: "2026-07-31T01:00:00.000Z",
    },
  };
}

/** Recursive content-hash snapshot of a packet root, used to prove a run left zero residue. */
function snapshotPacketRoot(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (dir: string, prefix: string) => {
    for (const name of readdirSync(dir).sort()) {
      const absolute = join(dir, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const stat = statSync(absolute);
      if (stat.isDirectory()) {
        walk(absolute, relative);
      } else {
        files[relative] = createHash("sha256").update(readFileSync(absolute)).digest("hex");
      }
    }
  };
  walk(root, "");
  return files;
}

describe("prd command exit contract", () => {
  it("RED-S4-executable-author: generated author defers controller toolchain custody until proposal parsing", async () => {
    const packet = createPacketRoot();
    const adapter = {
      id: "fusion-native-model-runtime-v1",
      model: "loopback/fixture",
      generateCandidate: vi.fn(),
    };
    const toolchainPaths = {
      taskExecutablePath: "/controller/task",
      nodeExecutablePath: "/controller/node",
      proofHost: {
        id: "fusion-cli-semantic-proof-host.v1" as const,
        executablePath: "/controller/fusion-cli",
      },
    };
    const resolveToolchain = vi.fn(() => toolchainPaths);
    const authorCccPrdPacket = vi.fn(async () => ({
      kind: "candidate" as const,
      sidecar: { schema: "ccc-prd.sidecar.v2" },
      review: { ambiguities: [], unresolvedDecisions: [], exceptions: [], protectedActions: [] },
    }));
    const output: string[] = [];

    expect(await runPrdCommand([
      "author",
      packet.root,
      packet.manifest,
      packet.sidecar,
      "--target", packet.target,
      "--base", packet.base,
      "--provider", "loopback",
      "--model", "fixture",
      "--max-requests", "1",
      "--max-duration-ms", "30000",
      "--max-concurrency", "1",
      "--max-prompt-bytes", "1000000",
      "--max-response-bytes", "262144",
      "--max-review-items", "8",
    ], { write: (line) => output.push(line) }, {
      authorCccPrdPacket: authorCccPrdPacket as never,
      bootstrapProofAdmission: async () => ({}) as never,
      createNativeCccPrdAuthoringAdapter: () => adapter as never,
      resolveSemanticProofToolchainPaths: resolveToolchain,
    })).toBe(0);

    expect(resolveToolchain).not.toHaveBeenCalled();
    expect(authorCccPrdPacket).toHaveBeenCalledWith(expect.objectContaining({
      semanticProofContract: "v2",
      resolveSemanticProofToolchainPaths: expect.any(Function),
      adapter,
      constraints: expect.objectContaining({
        targetRepository: { path: packet.target, baseCommit: packet.base },
      }),
    }));
    expect(JSON.parse(readFileSync(packet.sidecar, "utf8"))).toEqual({
      schema: "ccc-prd.sidecar.v2",
    });
  });

  it("RED-R1-generated-author-python: resolves the target Python venv after the model proposal", async () => {
    const packet = createPacketRoot({ semanticV2: true });
    const proposal = JSON.parse(readFileSync(packet.proposal, "utf8")) as {
      proofs: Array<{
        executionToolchain: Record<string, unknown>;
        verifierProfile?: unknown;
      }>;
    };
    const proof = proposal.proofs[0]!;
    proof.executionToolchain.python = {
      executablePath: "",
      executableSha256: "",
      version: "",
      versionOutputSha256: "",
      runtimeManifest: {
        schema: "ccc-prd.python-runtime-manifest.v1",
        interpreter: { path: "", sha256: "" },
        stdlibRoot: "",
        pythonHomeRoot: "",
        sitePackagesRoots: [],
        extensionModuleRoots: [],
        runtimeSupport: [],
        stdlib: [],
        sitePackages: [],
        extensionModules: [],
        dylibClosure: [],
      },
    };
    proof.verifierProfile = {
      schema: "ccc-prd.verifier.python-adapter.v1",
      adapterPath: "verify/python_adapter.py",
      targetPath: "fixtures/python-target",
    };
    writeFileSync(packet.proposal, JSON.stringify(proposal, null, 2));

    const adapter = {
      id: "fusion-native-model-runtime-v1",
      model: "loopback/fixture",
      generateCandidate: vi.fn(async () => proposal),
    };
    const resolveToolchain = vi.fn(() => {
      throw new Error("CCC semantic-proof active Python venv is unavailable: target/.venv");
    });
    const output: string[] = [];

    expect(await runPrdCommand([
      "author",
      packet.root,
      packet.manifest,
      packet.sidecar,
      "--target", packet.target,
      "--base", packet.base,
      "--provider", "loopback",
      "--model", "fixture",
      "--max-requests", "1",
      "--max-duration-ms", "30000",
      "--max-concurrency", "1",
      "--max-prompt-bytes", "1000000",
      "--max-response-bytes", "262144",
      "--max-review-items", "8",
    ], { write: (line) => output.push(line) }, {
      bootstrapProofAdmission,
      createNativeCccPrdAuthoringAdapter: () => adapter as never,
      resolveSemanticProofToolchainPaths: resolveToolchain,
    })).toBe(1);

    expect(adapter.generateCandidate).toHaveBeenCalledTimes(1);
    expect(resolveToolchain).toHaveBeenCalledWith({
      pythonRequired: true,
      targetRoot: packet.target,
    });
    expect(JSON.parse(output[0]!)).toMatchObject({
      kind: "refusal",
      diagnostics: [{
        code: "CCC_PRD_SEMANTIC_PROOF_CUSTODY_REFUSED",
        message: "CCC semantic-proof active Python venv is unavailable: target/.venv",
      }],
    });
  });

  it("RED-R1-deterministic-author-python-semantic-v2-toolchain: requests and forwards controller-owned python3 custody", async () => {
    const packet = createPacketRoot({ semanticV2: true });
    const proposal = JSON.parse(readFileSync(packet.proposal, "utf8")) as {
      proofs: Array<{
        executionToolchain: Record<string, unknown>;
        verifierProfile?: unknown;
      }>;
    };
    const proof = proposal.proofs[0]!;
    proof.executionToolchain.python = {
      executablePath: "",
      executableSha256: "",
      version: "",
      versionOutputSha256: "",
      runtimeManifest: {
        schema: "ccc-prd.python-runtime-manifest.v1",
        interpreter: { path: "", sha256: "" },
        stdlibRoot: "",
        pythonHomeRoot: "",
        sitePackagesRoots: [],
        extensionModuleRoots: [],
        runtimeSupport: [],
        stdlib: [],
        sitePackages: [],
        extensionModules: [],
        dylibClosure: [],
      },
    };
    proof.verifierProfile = {
      schema: "ccc-prd.verifier.python-adapter.v1",
      adapterPath: "verify/python_adapter.py",
      targetPath: "fixtures/python-target",
    };
    writeFileSync(packet.proposal, JSON.stringify(proposal, null, 2));

    const toolchainPaths = {
      taskExecutablePath: "/controller/task",
      nodeExecutablePath: "/controller/node",
      pythonExecutablePath: "/controller/python3",
      proofHost: {
        id: "fusion-cli-semantic-proof-host.v1" as const,
        executablePath: "/controller/proof-host",
      },
    };
    const resolveToolchain = vi.fn(() => toolchainPaths);
    const authorCccPrdPacket = vi.fn(async () => ({
      kind: "candidate" as const,
      sidecar: { schema: "ccc-prd.sidecar.v2" },
      review: { ambiguities: [], unresolvedDecisions: [], exceptions: [], protectedActions: [] },
    }));
    const output: string[] = [];

    expect(await runPrdCommand(
      ["author", packet.root, packet.manifest, packet.proposal, packet.sidecar],
      { write: (line) => output.push(line) },
      {
        authorCccPrdPacket: authorCccPrdPacket as never,
        bootstrapProofAdmission: async () => ({}) as never,
        resolveSemanticProofToolchainPaths: resolveToolchain,
      },
    )).toBe(0);

    expect(resolveToolchain).toHaveBeenCalledWith({
      pythonRequired: true,
      targetRoot: packet.target,
    });
    expect(authorCccPrdPacket).toHaveBeenCalledWith(expect.objectContaining({
      semanticProofContract: "v2",
      semanticProofToolchainPaths: toolchainPaths,
    }));
  });

  it("refuses generated executable authoring after model setup when controller toolchain custody is unavailable", async () => {
    const packet = createPacketRoot({ semanticV2: true });
    const proposal = JSON.parse(readFileSync(packet.proposal, "utf8"));
    const createAdapter = vi.fn(() => ({
      id: "fusion-native-model-runtime-v1",
      model: "loopback/fixture",
      generateCandidate: vi.fn(async () => proposal),
    }));
    const output: string[] = [];

    expect(await runPrdCommand([
      "author",
      packet.root,
      packet.manifest,
      packet.sidecar,
      "--target", packet.target,
      "--base", packet.base,
      "--provider", "loopback",
      "--model", "fixture",
      "--max-requests", "1",
      "--max-duration-ms", "30000",
      "--max-concurrency", "1",
      "--max-prompt-bytes", "1000000",
      "--max-response-bytes", "262144",
      "--max-review-items", "8",
    ], { write: (line) => output.push(line) }, {
      createNativeCccPrdAuthoringAdapter: createAdapter,
      bootstrapProofAdmission,
      resolveSemanticProofToolchainPaths: () => {
        throw new Error("built proof host missing");
      },
    })).toBe(1);

    expect(createAdapter).toHaveBeenCalledTimes(1);
    expect(JSON.parse(output[0]!)).toMatchObject({
      kind: "refusal",
      diagnostics: [{
        code: "CCC_PRD_SEMANTIC_PROOF_CUSTODY_REFUSED",
        message: "built proof host missing",
      }],
    });
  });

  it("RED-S4-product-preview-v1: refuses a fresh legacy semantic packet before toolchain or project access", async () => {
    const packet = createPacketRoot();
    expect(await runPrdCommand(
      ["author", packet.root, packet.manifest, packet.proposal, packet.sidecar],
      { write: () => undefined },
      { bootstrapProofAdmission },
    )).toBe(0);
    const output: string[] = [];
    const resolveToolchain = vi.fn();
    const resolveProject = vi.fn();

    expect(await runPrdJson([
      "preview",
      packet.root,
      packet.manifest,
      packet.sidecar,
      join(packet.root, "not-read.execution-plan.json"),
      packet.target,
      packet.base,
    ], { write: (line) => output.push(line) }, {
      resolveSemanticProofToolchainPaths: resolveToolchain,
      resolveProject,
    })).toBe(1);

    expect(JSON.parse(output[0]!)).toMatchObject({
      kind: "refusal",
      diagnostics: [{ code: "CCC_PRD_PRODUCT_SEMANTIC_V2_REQUIRED" }],
    });
    expect(resolveToolchain).not.toHaveBeenCalled();
    expect(resolveProject).not.toHaveBeenCalled();
  });

  it("RED-S5-product-preview-fabricated-custody: refuses changed controller executable bytes before the executable can run", async () => {
    const packet = createPacketRoot({ semanticV2: true });
    await authorSemanticV2Packet(packet);
    const executionPlanPath = await createExecutionPlan(packet);
    const markerPath = join(packet.root, "swapped-task-ran.marker");
    writeFileSync(
      packet.semanticProofToolchainPaths!.taskExecutablePath,
      `#!/bin/sh\nprintf swapped > '${markerPath}'\nprintf 'Task fixture swapped\n'\n`,
    );
    const context = {
      projectId: "project-1",
      projectPath: resolve(packet.target),
      projectName: "Fixture",
      isRegistered: true,
      store: { getAsyncLayer: vi.fn(() => ({})) },
    };
    const output: string[] = [];

    expect(await runPrdJson([
      "preview",
      packet.root,
      packet.manifest,
      packet.sidecar,
      executionPlanPath,
      packet.target,
      packet.base,
    ], { write: (line) => output.push(line) }, {
      resolveProject: vi.fn(async () => context),
      closeProjectStore: vi.fn(async () => undefined),
      readTargetHead: vi.fn(async () => packet.base),
      resolveSemanticProofToolchainPaths: () => packet.semanticProofToolchainPaths!,
      inspectVerifierConfinementReadiness: vi.fn(async () => ({
        ready: true,
        backend: "sandbox-exec" as const,
        code: "VERIFIER_CONFINEMENT_READY",
        message: "test confinement is ready",
        trustedPaths: ["/usr/bin/sandbox-exec"] as const,
        detail: "test-injected ready confinement",
      })),
    })).toBe(1);

    expect(JSON.parse(output[0]!)).toMatchObject({
      kind: "refusal",
      diagnostics: [{ code: "CCC_PRD_SEMANTIC_PROOF_CUSTODY_REFUSED" }],
    });
    expect(existsSync(markerPath)).toBe(false);
  });

  it("RED-S4-exact-legacy-replay: reaches core replay without resolving semantic-v2 toolchain custody", async () => {
    const packet = createPacketRoot();
    expect(await runPrdCommand(
      ["author", packet.root, packet.manifest, packet.proposal, packet.sidecar],
      { write: () => undefined },
      { bootstrapProofAdmission },
    )).toBe(0);
    const legacyPlan = createLegacyExecutionPlan(packet);
    const layer = {};
    const context = {
      projectId: "project-1",
      projectPath: resolve(packet.target),
      projectName: "Fixture",
      isRegistered: true,
      store: { getAsyncLayer: vi.fn(() => layer) },
    };
    const resolveToolchain = vi.fn();
    const assertCustody = vi.fn();
    const inspectImport = vi.fn(async () => ({
      bundleHash: legacyPlan.bundleHash,
      targetRepository: packet.target,
      targetBase: packet.base,
    }));
    const importBundle = vi.fn(async () => ({
      importId: "legacy-import-1",
      idempotencyKey: "legacy-key",
      bundleHash: legacyPlan.bundleHash,
      identityHash: "identity-hash",
      targetRepository: packet.target,
      targetBase: packet.base,
      state: "active",
      runnable: true,
      stagingRelativePath: ".fusion/ccc-prd-import-staging/legacy-import-1",
      transactionWitness: {},
      directCounts: {},
      replayed: true,
    }));
    const dependencies = {
      resolveProject: vi.fn(async () => context),
      closeProjectStore: vi.fn(async () => undefined),
      readTargetHead: vi.fn(async () => packet.base),
      resolveSemanticProofToolchainPaths: resolveToolchain,
      assertSemanticProofV2Custody: assertCustody,
      inspectCccPrdImport: inspectImport as never,
      importCccPrdBundle: importBundle,
      inspectVerifierConfinementReadiness: vi.fn(async () => ({
        ready: true,
        backend: "sandbox-exec" as const,
        code: "VERIFIER_CONFINEMENT_READY",
        message: "test confinement is ready",
        trustedPaths: ["/usr/bin/sandbox-exec"] as const,
        detail: "test-injected ready confinement",
      })),
    };
    const common = [
      packet.root,
      packet.manifest,
      packet.sidecar,
      legacyPlan.outputPath,
      packet.target,
      packet.base,
      "legacy-key",
      "--confirm",
    ];
    const mismatchOutput: string[] = [];
    expect(await runPrdJson(
      ["import", ...common, "0".repeat(64)],
      { write: (line) => mismatchOutput.push(line) },
      dependencies,
    )).toBe(1);
    const mismatch = JSON.parse(mismatchOutput[0]!) as {
      diagnostics: Array<{ code: string; message: string }>;
    };
    expect(mismatch.diagnostics[0]).toMatchObject({ code: "CCC_PRD_CONFIRMATION_MISMATCH" });
    const confirmation = mismatch.diagnostics[0]!.message.match(/[0-9a-f]{64}$/u)?.[0];
    expect(confirmation).toMatch(/^[0-9a-f]{64}$/u);

    const replayOutput: string[] = [];
    expect(await runPrdJson(
      ["import", ...common, confirmation!],
      { write: (line) => replayOutput.push(line) },
      dependencies,
    )).toBe(0);
    expect(JSON.parse(replayOutput[0]!)).toMatchObject({
      kind: "imported",
      result: { importId: "legacy-import-1", replayed: true },
    });
    expect(resolveToolchain).not.toHaveBeenCalled();
    expect(assertCustody).not.toHaveBeenCalled();
    expect(importBundle).toHaveBeenCalledWith(expect.not.objectContaining({
      semanticProofToolchainPaths: expect.anything(),
    }));
  });

  it("stops reading typed operator context as soon as the byte limit is crossed", async () => {
    let chunksRead = 0;
    async function* chunks(): AsyncGenerator<Buffer> {
      chunksRead += 1;
      yield Buffer.alloc(MAX_OPERATOR_CONTEXT_BYTES, "a");
      chunksRead += 1;
      yield Buffer.from("b");
      chunksRead += 1;
      yield Buffer.from("c");
    }

    await expect(readBoundedPrdStdin(chunks())).rejects.toMatchObject({
      code: "CCC_PRD_OPERATOR_CONTEXT_INVALID",
      message: "typed operator context exceeds 262144 bytes",
    });
    expect(chunksRead).toBe(2);
  });

  it("refuses malformed typed operator context before calling packet freeze", async () => {
    const freeze = vi.fn();
    const output: string[] = [];

    expect(await runPrdCommand(
      [
        "freeze",
        "/vault/active",
        "/vault/active/alpha/PRD-v1.0.0.md",
        "/tmp/frozen-alpha",
        "--context-stdin",
      ],
      {
        write: (line) => output.push(line),
        readStdin: async () => "{",
      },
      { freezeCccPrdPacket: freeze },
    )).toBe(1);
    expect(freeze).not.toHaveBeenCalled();
    expect(JSON.parse(output[0]!)).toMatchObject({
      kind: "refusal",
      diagnostics: [{ code: "CCC_PRD_OPERATOR_CONTEXT_INVALID" }],
    });
  });

  it("returns usage exit 2 before any compiler or filesystem work", async () => {
    const output: string[] = [];
    expect(await runPrdCommand(["compile"], { write: (line) => output.push(line) })).toBe(2);
    expect(output).toEqual([
      [
        "usage: fn prd author <root-dir> <manifest-path> <sidecar-output> --target <repository> --base <40-hex-commit> --provider <provider> --model <model> --max-requests <n> --max-duration-ms <n> --max-concurrency <n> --max-prompt-bytes <n> --max-response-bytes <n> --max-review-items <n>",
        "       fn prd author <root-dir> <manifest-path> <proposal-path> <sidecar-output> (deterministic compatibility fixture)",
        "       fn prd understand <root-dir> <manifest-path> <review-output> --provider <provider> --model <model> --max-duration-ms <n> --max-prompt-bytes <n> --max-response-bytes <n> --max-review-items <n> [--lane auto|single|chunked] [--max-chunk-attempts <n>]",
        "       fn prd corpus <active-projects-root>",
        "       fn prd discover <active-projects-root>",
        "       fn prd freeze <active-projects-root> <selected-prd-path> <output-dir>",
        "       fn prd freeze <active-projects-root> <selected-prd-path> <output-dir> --target <repository> --base <40-hex-commit> --owned-path <path> --write-root <path> --write-purpose <purpose> --max-requests <n> --max-duration-ms <n> --max-concurrency <n>",
        "       fn prd freeze <active-projects-root> <selected-prd-path> <output-dir> --context-stdin",
        "       fn prd policy <root-dir> <manifest-path> <sidecar-path> <expected-target> <expected-base> <output-path> --provider <provider> --model <model> --transport <pi|cli> [--cli-adapter <id>] [--receipt-adapter <id>]",
        "       fn prd policy <root-dir> <manifest-path> <sidecar-path> <expected-target> <expected-base> <output-path> --routes-file <path> (mutually exclusive with --provider/--model/--transport/--cli-adapter/--receipt-adapter; exactly one form required)",
        "       fn prd template",
        "       fn prd lint <prd-path>",
        "       fn prd <validate|compile> <root-dir> <manifest-path> <sidecar-path> <expected-target> <expected-base>",
        "       fn prd preview <root-dir> <manifest-path> <sidecar-path> <execution-plan-path> <expected-target> <expected-base> [--project <id|name>]",
        "       fn prd import <root-dir> <manifest-path> <sidecar-path> <execution-plan-path> <expected-target> <expected-base> <idempotency-key> --confirm <preview-digest> [--project <id|name>]",
        "       fn prd new-key",
        "       fn prd <inspect|reconcile> <idempotency-key> [--project <id|name>]",
        "       fn prd status <idempotency-key> [--project <id|name>]",
        "       fn prd <pause|resume> <idempotency-key> --confirm <status-digest> [--project <id|name>]",
        "       fn prd <stop|abandon> <idempotency-key> --reason <reason> --confirm <status-digest> [--project <id|name>]",
        "       fn prd resolve-proof <idempotency-key> <attempt-key> <evidence-path> [--confirm <resolution-digest>] [--project <id|name>]",
        "       fn prd resolve-provider <idempotency-key> <attempt-key> <committed|proved-failed> <observer-id> <evidence-sha256> [--confirm <resolution-digest>] [--project <id|name>]",
        "       fn prd approve-execution <idempotency-key> <execution-authorization-or-legacy-approval-id> --confirm <approval-digest> [--project <id|name>]",
        "       fn prd approve-merge <idempotency-key> <approval-request-id> --confirm <approval-digest> [--project <id|name>]",
        "       add --json to any command above for the exact machine-readable payload instead of operator prose",
      ].join("\n"),
    ]);
  });

  it("discovers project-local current PRDs and freezes the operator-selected packet through engine APIs", async () => {
    const discovery = {
      schema: "ccc-prd.discovery.v1",
      activeProjectsRoot: "/vault/active",
      projects: [{
        project: "alpha",
        projectRoot: "/vault/active/alpha",
        candidates: [{
          path: "/vault/active/alpha/PRJ-HUM-Alpha-PRD-v2.0.0.md",
          projectRelativePath: "PRJ-HUM-Alpha-PRD-v2.0.0.md",
          version: "2.0.0",
          status: "approved",
          score: { semver: [2, 0, 0], status: 4, signal: 2 },
        }],
        selection: {
          kind: "selected",
          selectedPrdPath: "/vault/active/alpha/PRJ-HUM-Alpha-PRD-v2.0.0.md",
        },
      }],
    };
    const frozen = {
      schema: "ccc-prd.freeze-result.v1",
      rootDir: "/tmp/frozen-alpha",
      manifestPath: "/tmp/frozen-alpha/manifest.json",
      receiptPath: "/tmp/frozen-alpha/freeze-receipt.json",
      selectedPrdPath: "/vault/active/alpha/PRJ-HUM-Alpha-PRD-v2.0.0.md",
      packet: {
        schema: "ccc-prd.packet.v1",
        sourceVersion: "v2.0.0",
        manifestSha256: "a".repeat(64),
        packetHash: "b".repeat(64),
        receiptSha256: "c".repeat(64),
        fileCount: 3,
        totalBytes: 1234,
        unresolvedReferenceCount: 0,
        project: "alpha",
        selectedPrdPath: "/vault/active/alpha/PRJ-HUM-Alpha-PRD-v2.0.0.md",
      },
      unresolvedReferences: [],
    };
    const discover = vi.fn(() => discovery);
    const freeze = vi.fn(() => frozen);
    const discoveredOutput: string[] = [];
    expect(await runPrdCommand(
      ["discover", "/vault/active"],
      { write: (line) => discoveredOutput.push(line) },
      { discoverCccPrdCandidates: discover },
    )).toBe(0);
    expect(JSON.parse(discoveredOutput[0]!)).toEqual(discovery);
    expect(discover).toHaveBeenCalledWith({ activeProjectsRoot: "/vault/active" });

    const frozenOutput: string[] = [];
    expect(await runPrdCommand(
      [
        "freeze",
        "/vault/active",
        "/vault/active/alpha/PRJ-HUM-Alpha-PRD-v2.0.0.md",
        "/tmp/frozen-alpha",
      ],
      { write: (line) => frozenOutput.push(line) },
      { freezeCccPrdPacket: freeze },
    )).toBe(0);
    expect(JSON.parse(frozenOutput[0]!)).toEqual(frozen);
    expect(freeze).toHaveBeenCalledWith({
      activeProjectsRoot: "/vault/active",
      selectedPrdPath: "/vault/active/alpha/PRJ-HUM-Alpha-PRD-v2.0.0.md",
      outputDir: "/tmp/frozen-alpha",
    });

    const operatorContext = {
      schema: "ccc-prd.operator-context.v1" as const,
      targetRepository: {
        path: "/workspace/alpha",
        baseCommit: "d".repeat(40),
      },
      taskCustody: {
        ownedPaths: ["src/alpha", "tests/alpha"],
        allowedWriteRoots: ["src/alpha", "tests/alpha"],
      },
      writeRootPurpose: "implement and verify Alpha",
      bounds: {
        maxRequests: 4,
        maxDurationMs: 120000,
        maxConcurrency: 2,
      },
    };
    expect(await runPrdCommand(
      [
        "freeze",
        "/vault/active",
        "/vault/active/alpha/PRJ-HUM-Alpha-PRD-v2.0.0.md",
        "/tmp/frozen-alpha",
        "--target",
        "/workspace/alpha",
        "--base",
        "d".repeat(40),
        "--owned-path",
        "src/alpha",
        "--owned-path",
        "tests/alpha",
        "--write-root",
        "src/alpha",
        "--write-root",
        "tests/alpha",
        "--write-purpose",
        "implement and verify Alpha",
        "--max-requests",
        "4",
        "--max-duration-ms",
        "120000",
        "--max-concurrency",
        "2",
      ],
      { write: () => undefined },
      { freezeCccPrdPacket: freeze },
    )).toBe(0);
    expect(freeze).toHaveBeenLastCalledWith({
      activeProjectsRoot: "/vault/active",
      selectedPrdPath: "/vault/active/alpha/PRJ-HUM-Alpha-PRD-v2.0.0.md",
      outputDir: "/tmp/frozen-alpha",
      operatorContext,
    });

    expect(await runPrdCommand(
      [
        "freeze",
        "/vault/active",
        "/vault/active/alpha/PRJ-HUM-Alpha-PRD-v2.0.0.md",
        "/tmp/frozen-alpha",
        "--context-stdin",
      ],
      {
        write: () => undefined,
        readStdin: async () => JSON.stringify(operatorContext),
      },
      { freezeCccPrdPacket: freeze },
    )).toBe(0);
    expect(freeze).toHaveBeenLastCalledWith({
      activeProjectsRoot: "/vault/active",
      selectedPrdPath: "/vault/active/alpha/PRJ-HUM-Alpha-PRD-v2.0.0.md",
      outputDir: "/tmp/frozen-alpha",
      operatorContext,
    });
  });

  it("prints the read-only corpus manifest through the normal CLI", async () => {
    const manifest = {
      schema: "ccc-prd.corpus-manifest.v1",
      activeProjectsRoot: "/vault/active",
      summary: {
        projectCount: 1,
        selectedCount: 1,
        ambiguousCount: 0,
        noPrdCount: 0,
        readyForIntakeCount: 0,
        blockingQuestionCount: 2,
      },
      projects: [],
    };
    const buildCorpus = vi.fn(() => manifest);
    const output: string[] = [];

    expect(await runPrdCommand(
      ["corpus", "/vault/active"],
      { write: (line) => output.push(line) },
      { buildCccPrdCorpusManifest: buildCorpus } as never,
    )).toBe(0);
    expect(JSON.parse(output[0]!)).toEqual(manifest);
    expect(buildCorpus).toHaveBeenCalledWith({ activeProjectsRoot: "/vault/active" });
  });

  it("writes a non-executable understanding review through one bounded native adapter", async () => {
    const packet = createPacketRoot();
    const reviewPath = join(packet.root, "understanding-review.json");
    const review = {
      schema: "ccc-prd.understanding-review.v1",
      kind: "understanding-review",
      executable: false,
      requirements: [{ id: "REQ-REVIEW", statement: "Understand the PRD." }],
      proofs: [],
      tasks: [],
      implementationContext: {
        approvalStatus: "unapproved",
        targetRepository: { path: null, baseCommit: null },
        bounds: {
          maxRequests: null,
          maxDurationMs: null,
          maxConcurrency: null,
        },
        admittedWriteRoots: [],
        missingFacts: [{
          code: "CCC_PRD_TARGET_REPOSITORY_REQUIRED",
          question: "Which target repository should this PRD change?",
        }],
      },
      coverage: {
        inventoryCount: 2,
        dispositionCount: 1,
        dispositions: [],
        missing: [{ id: "MAT-1", title: "Unmapped section" }],
        conflicts: [],
      },
      review: {
        ambiguities: [],
        unresolvedDecisions: [],
        exceptions: [],
        protectedActions: [],
      },
    };
    const understand = vi.fn(async () => review);
    const adapter = {
      id: "fusion-native-model-runtime-v1",
      model: "loopback/fixture",
      generateCandidate: vi.fn(),
    };
    const createAdapter = vi.fn(() => adapter);
    const resolveCustomProviderModelLimits = vi.fn(() => ({
      contextWindow: 65_536,
      maxTokens: 32_768,
    }));
    const output: string[] = [];

    expect(await runPrdCommand([
      "understand",
      packet.root,
      packet.manifest,
      reviewPath,
      "--provider",
      "loopback",
      "--model",
      "fixture",
      "--max-duration-ms",
      "30000",
      "--max-prompt-bytes",
      "1000000",
      "--max-response-bytes",
      "262144",
      "--max-review-items",
      "8",
    ], { write: (line) => output.push(line) }, {
      bootstrapProofAdmission: async () => ({}) as never,
      createNativeCccPrdAuthoringAdapter: createAdapter,
      resolveCustomProviderModelLimits,
      understandCccPrdPacket: understand,
    } as never)).toBe(0);

    expect(resolveCustomProviderModelLimits).toHaveBeenCalledWith("loopback", "fixture");
    expect(createAdapter).toHaveBeenCalledWith({
      provider: "loopback",
      model: "fixture",
      maxDurationMs: 30000,
      maxPromptBytes: 1000000,
      maxResponseBytes: 262144,
      mode: "understanding",
    });
    expect(understand).toHaveBeenCalledWith({
      rootDir: packet.root,
      manifestPath: packet.manifest,
      adapter,
      maxReviewItems: 8,
      workflowExtensionRegistry: {},
      requestedLane: "auto",
      provider: "loopback",
      model: "fixture",
      maxDurationMs: 30000,
      maxPromptBytes: 1000000,
      maxResponseBytes: 262144,
      contextWindow: 65536,
      reservedOutputTokens: 32768,
    });
    expect(JSON.parse(readFileSync(reviewPath, "utf8"))).toEqual(review);
    expect(JSON.parse(output[0]!)).toMatchObject({
      ...review,
      reviewPath,
    });
    expect(JSON.parse(output[0]!).executable).toBe(false);
  });

  it("refuses understanding admission when the selected provider model limits cannot be resolved", async () => {
    const packet = createPacketRoot();
    const reviewPath = join(packet.root, "understanding-review.json");
    const output: string[] = [];
    const resolveCustomProviderModelLimits = vi.fn(() => {
      throw new Error("CCC custom provider model is not configured: loopback/missing");
    });
    const createAdapter = vi.fn();
    const bootstrap = vi.fn(async () => ({}) as never);
    const understand = vi.fn();

    const exit = await runPrdCommand([
      "understand",
      packet.root,
      packet.manifest,
      reviewPath,
      "--provider",
      "loopback",
      "--model",
      "missing",
      "--max-duration-ms",
      "30000",
      "--max-prompt-bytes",
      "1000000",
      "--max-response-bytes",
      "262144",
      "--max-review-items",
      "8",
    ], { write: (line) => output.push(line) }, {
      bootstrapProofAdmission: bootstrap,
      createNativeCccPrdAuthoringAdapter: createAdapter,
      resolveCustomProviderModelLimits,
      understandCccPrdPacket: understand,
    } as never);

    expect(exit).toBe(1);
    expect(resolveCustomProviderModelLimits).toHaveBeenCalledWith("loopback", "missing");
    expect(createAdapter).not.toHaveBeenCalled();
    expect(bootstrap).not.toHaveBeenCalled();
    expect(understand).not.toHaveBeenCalled();
    expect(existsSync(reviewPath)).toBe(false);
    expect(JSON.parse(output[0]!)).toMatchObject({
      kind: "refusal",
      diagnostics: [{
        code: "CCC_PRD_UNDERSTANDING_ADMISSION_FAILED",
        message: "CCC custom provider model is not configured: loopback/missing",
      }],
    });
  });

  it("test 44: a real chunked-lane mid-run failure through the CLI caller leaves the packet root byte-identical", async () => {
    const packet = createPacketRoot();
    const content = [
      "# Alpha",
      "- REQ-1: alpha requirement text.",
      "",
      "# Beta",
      "- REQ-2: beta requirement text.",
    ].join("\n") + "\n";
    // Overwrite the fixture's single-chunk content with a two-heading packet
    // so the chunk planner (chunk-planner.ts) produces exactly two chunks --
    // one per top-level heading -- and a second-chunk failure is reachable.
    writeFileSync(join(packet.root, "packet.md"), content);
    writeFileSync(packet.manifest, JSON.stringify({
      schema: "ccc-prd.packet.v1",
      source_version: "chunked-caller-residue-test",
      entries: [{
        relative_path: "packet.md",
        role: "root",
        authoritative: true,
        sha256: createHash("sha256").update(content).digest("hex"),
      }],
    }));

    const alphaFragment = {
      schema: "ccc-prd.authoring-proposal-fragment.v1",
      authorityRoles: [],
      requirements: [{
        id: "REQ-1",
        statement: "alpha requirement",
        acceptance: "alpha acceptance",
        accountableProducer: "team-a",
        dependencies: [],
        proofIds: [],
        confidence: "high",
        sourceRefs: [{ path: "packet.md", exactQuote: "- REQ-1: alpha requirement text." }],
      }],
      proofs: [],
      tasks: [{
        id: "TASK-ALPHA",
        title: "Ship alpha",
        description: "Implement alpha",
        accountableProducer: "team-a",
        requirementIds: ["REQ-1"],
        dependencyTaskIds: [],
        proofIds: [],
        workflowId: "",
        documentIds: [],
        artifactIds: [],
        protectedActionIds: [],
        ownedPaths: ["src/alpha.ts"],
        allowedWriteRoots: ["src/alpha.ts"],
        sourceRefs: [{ path: "packet.md", exactQuote: "# Alpha\n- REQ-1: alpha requirement text." }],
      }],
      edges: [],
      workflows: [],
      documents: [],
      artifacts: [],
      importIntents: [],
      protectedActions: [],
      unresolvedDecisions: [],
      ambiguities: [],
      exceptions: [],
    };

    let transportCallCount = 0;
    const chunkTransport: CccPrdNativeAuthoringTransport = async ({ provider, model }) => {
      transportCallCount += 1;
      if (transportCallCount === 1) {
        return { text: JSON.stringify(alphaFragment), provider, model };
      }
      throw new Error("simulated transport failure: chunk 2 network drop");
    };
    const verbatimCapableProviders: CustomProvider[] = [{
      id: "ccc-loopback-chunked",
      name: "Loopback Chunked",
      apiType: "openai-compatible",
      baseUrl: "http://127.0.0.1:7999/v1",
      apiKey: "synthetic-never-read",
      models: [{ id: "fixture-model", name: "Fixture", verbatimCapable: true }],
    }];

    const reviewPath = join(packet.root, "understanding-review.json");
    const output: string[] = [];

    const before = snapshotPacketRoot(packet.root);
    const exit = await runPrdCommand(
      [
        "understand", packet.root, packet.manifest, reviewPath,
        "--provider", "loopback-chunked",
        "--model", "fixture-model",
        "--max-duration-ms", "5000",
        "--max-prompt-bytes", "1000000",
        "--max-response-bytes", "262144",
        "--max-review-items", "8",
        "--lane", "chunked",
      ],
      { write: (line) => output.push(line) },
      {
        bootstrapProofAdmission: async () => ({}) as never,
        createNativeCccPrdAuthoringAdapter: () => ({
          id: "unused",
          generateCandidate: async () => { throw new Error("single-shot path must not run"); },
        }) as never,
        resolveCustomProviderModelLimits: () => ({
          contextWindow: 128_000,
          maxTokens: 16_384,
        }),
        // The CALLER path under test (prd.ts's runGeneratedUnderstanding) --
        // this wrapper runs the REAL engine chunk orchestrator (not a
        // mocked refusal), only supplying the test-only transport seam
        // (chunk-orchestrator.ts's `transport` option) so the second chunk
        // fails mid-flight through the real pipeline.
        understandCccPrdPacket: (input) => understandCccPrdPacket({
          ...input,
          chunkTransport,
          customProviders: verbatimCapableProviders,
        }),
      } as never,
    );
    const after = snapshotPacketRoot(packet.root);

    expect(transportCallCount, output.join("\n")).toBe(2);
    expect(exit, output.join("\n")).toBe(1);
    expect(JSON.parse(output[0]!).kind).toBe("refusal");
    expect(existsSync(reviewPath)).toBe(false);
    expect(after).toEqual(before);
  });

  describe("fn prd understand -- optionalUnderstandingFlags (design §6)", () => {
    const requiredFlags = (extra: string[] = []) => [
      "--provider", "loopback",
      "--model", "fixture",
      "--max-duration-ms", "30000",
      "--max-prompt-bytes", "1000000",
      "--max-response-bytes", "262144",
      "--max-review-items", "8",
      ...extra,
    ];

    it("test 53: accepts the required flags plus --lane chunked", async () => {
      const packet = createPacketRoot();
      const reviewPath = join(packet.root, "understanding-review.json");
      const understand = vi.fn(async () => ({ kind: "refusal", diagnostics: [] }) as never);
      const output: string[] = [];

      await runPrdCommand(
        ["understand", packet.root, packet.manifest, reviewPath, ...requiredFlags(["--lane", "chunked"])],
        { write: (line) => output.push(line) },
        {
          bootstrapProofAdmission: async () => ({}) as never,
          createNativeCccPrdAuthoringAdapter: vi.fn(() => ({ id: "x", generateCandidate: vi.fn() })) as never,
          resolveCustomProviderModelLimits: () => ({
            contextWindow: 128_000,
            maxTokens: 16_384,
          }),
          understandCccPrdPacket: understand,
        } as never,
      );

      expect(understand).toHaveBeenCalledWith(expect.objectContaining({ requestedLane: "chunked" }));
    });

    it("test 53b: accepts the required flags plus --max-chunk-attempts", async () => {
      const packet = createPacketRoot();
      const reviewPath = join(packet.root, "understanding-review.json");
      const understand = vi.fn(async () => ({ kind: "refusal", diagnostics: [] }) as never);

      await runPrdCommand(
        ["understand", packet.root, packet.manifest, reviewPath, ...requiredFlags(["--max-chunk-attempts", "3"])],
        { write: () => {} },
        {
          bootstrapProofAdmission: async () => ({}) as never,
          createNativeCccPrdAuthoringAdapter: vi.fn(() => ({ id: "x", generateCandidate: vi.fn() })) as never,
          resolveCustomProviderModelLimits: () => ({
            contextWindow: 128_000,
            maxTokens: 16_384,
          }),
          understandCccPrdPacket: understand,
        } as never,
      );

      expect(understand).toHaveBeenCalledWith(expect.objectContaining({ maxChunkAttempts: 3 }));
    });

    it("test 54: rejects an unknown flag rather than silently dropping it", async () => {
      const packet = createPacketRoot();
      const reviewPath = join(packet.root, "understanding-review.json");
      const output: string[] = [];
      const code = await runPrdCommand(
        ["understand", packet.root, packet.manifest, reviewPath, ...requiredFlags(["--not-a-real-flag", "x"])],
        { write: (line) => output.push(line) },
      );
      expect(code).toBe(2);
    });

    it("test 54b: rejects a duplicate flag", async () => {
      const packet = createPacketRoot();
      const reviewPath = join(packet.root, "understanding-review.json");
      const code = await runPrdCommand(
        ["understand", packet.root, packet.manifest, reviewPath, ...requiredFlags(["--lane", "single", "--lane", "chunked"])],
        { write: () => {} },
      );
      expect(code).toBe(2);
    });

    it("test 54c: rejects an odd arg count", async () => {
      const packet = createPacketRoot();
      const reviewPath = join(packet.root, "understanding-review.json");
      const code = await runPrdCommand(
        ["understand", packet.root, packet.manifest, reviewPath, ...requiredFlags(["--lane"])],
        { write: () => {} },
      );
      expect(code).toBe(2);
    });

    it.each([
      ["--chunk-journal", "/tmp/journal.json"],
      ["--resume", "/tmp/journal.json"],
    ])("rejects %s as not-yet-implemented, distinctly from an unknown flag", async (flag, value) => {
      const packet = createPacketRoot();
      const reviewPath = join(packet.root, "understanding-review.json");
      const output: string[] = [];
      const code = await runPrdCommand(
        ["understand", packet.root, packet.manifest, reviewPath, ...requiredFlags([flag, value])],
        { write: (line) => output.push(line) },
      );
      expect(code).toBe(2);
      expect(output).toEqual([
        `${flag} is not yet implemented (the chunked understanding resume journal does not exist in this build)`,
      ]);
    });

    it.each([
      ["--chunk-journal", "/tmp/journal.json"],
      ["--resume", "/tmp/journal.json"],
    ])("rejects %s explicitly before generic option-count handling", async (flag, value) => {
      const packet = createPacketRoot();
      const reviewPath = join(packet.root, "understanding-review.json");
      const output: string[] = [];
      const code = await runPrdCommand(
        [
          "understand",
          packet.root,
          packet.manifest,
          reviewPath,
          ...requiredFlags([
            "--lane", "chunked",
            "--max-chunk-attempts", "3",
            flag, value,
          ]),
        ],
        { write: (line) => output.push(line) },
      );
      expect(code).toBe(2);
      expect(output).toEqual([
        `${flag} is not yet implemented (the chunked understanding resume journal does not exist in this build)`,
      ]);
    });

    it("rejects an invalid --lane value", async () => {
      const packet = createPacketRoot();
      const reviewPath = join(packet.root, "understanding-review.json");
      const output: string[] = [];
      const code = await runPrdCommand(
        ["understand", packet.root, packet.manifest, reviewPath, ...requiredFlags(["--lane", "bogus"])],
        { write: (line) => output.push(line) },
      );
      expect(code).toBe(2);
      expect(output.join("\n")).toContain("--lane must be one of");
    });
  });

  it("generates a hash-bound execution plan without operator-authored policy JSON", async () => {
    const packet = createPacketRoot({ semanticV2: true });
    await authorSemanticV2Packet(packet);

    const executionPlanPath = join(packet.root, "execution-plan.json");
    const output: string[] = [];
    const policyExit = await runPrdCommand(
      [
        "policy",
        packet.root,
        packet.manifest,
        packet.sidecar,
        packet.target,
        packet.base,
        executionPlanPath,
        "--provider",
        "deterministic-fake",
        "--model",
        "upstream/fixture-v2",
        "--transport",
        "pi",
        "--receipt-adapter",
        "terminal-route-sse-comments.v1",
      ],
      { write: (line) => output.push(line) },
      { bootstrapProofAdmission },
    );
    expect(policyExit, output.join("\n")).toBe(0);

    expect(existsSync(executionPlanPath)).toBe(true);
    expect(JSON.parse(readFileSync(executionPlanPath, "utf8"))).toMatchObject({
      schema: "ccc-prd.execution-plan.v1",
      packetHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      sidecarHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      bundleHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      policy: {
        schema: "ccc-campaign.execution-policy.v2",
        routes: [{
          taskId: "TASK-CLI-001",
          providerId: "deterministic-fake",
          modelId: "upstream/fixture-v2",
          transport: "pi",
          receiptAdapterId: "terminal-route-sse-comments.v1",
          executor: "model",
          toolMode: "coding",
          worktreeMode: "isolated",
          ownedPaths: ["src/task-1"],
          allowedWriteRoots: ["src/task-1"],
          commitPolicy: "required",
        }],
      },
    });
    expect(JSON.parse(output[0]!)).toMatchObject({
      kind: "execution-plan",
      path: executionPlanPath,
    });
  });

  it("prints the optional intake template and lints implementation-changing facts without rewriting the PRD", async () => {
    const templateOutput: string[] = [];
    expect(await runPrdCommand(
      ["template"],
      { write: (line) => templateOutput.push(line) },
    )).toBe(0);
    const template = JSON.parse(templateOutput[0]!) as {
      kind: string;
      schema: string;
      markdown: string;
    };
    expect(template).toMatchObject({
      kind: "prd-intake-template",
      schema: "ccc-prd.intake-contract.v2",
    });
    expect(template.markdown).toContain("Target repository:");
    expect(template.markdown).toContain("### Requirement REQ-001");
    expect(template.markdown).toContain("#### Acceptance clauses");
    expect(template.markdown).toContain("the verifier command task verify:<slug>");

    const packet = createPacketRoot();
    const prdPath = join(packet.root, "future-prd.md");
    writeFileSync(prdPath, `# Future PRD

## Requirements

- Make the operator route work.
`);
    const before = readFileSync(prdPath, "utf8");
    const lintOutput: string[] = [];
    expect(await runPrdCommand(
      ["lint", prdPath],
      { write: (line) => lintOutput.push(line) },
    )).toBe(1);
    expect(JSON.parse(lintOutput[0]!)).toMatchObject({
      schema: "ccc-prd.intake-contract.v2",
      optionalContract: true,
      readyForIntake: false,
      blockingQuestions: [
        expect.objectContaining({ code: "CCC_PRD_TARGET_REPOSITORY_REQUIRED" }),
        expect.objectContaining({ code: "CCC_PRD_BASELINE_REQUIRED" }),
        expect.objectContaining({ code: "CCC_PRD_ALLOWED_PATHS_REQUIRED" }),
        expect.objectContaining({ code: "CCC_PRD_ACCEPTANCE_BEHAVIOR_REQUIRED" }),
        expect.objectContaining({ code: "CCC_PRD_ACCEPTANCE_CLAUSES_REQUIRED" }),
        expect.objectContaining({ code: "CCC_PRD_EXPECTED_PROOF_REQUIRED" }),
        expect.objectContaining({ code: "CCC_PRD_PROOF_DECLARATION_REQUIRED" }),
        expect.objectContaining({ code: "CCC_PRD_PROTECTED_ACTIONS_REQUIRED" }),
      ],
    });
    expect(readFileSync(prdPath, "utf8")).toBe(before);
  });

  it("previews and imports one hash-bound product bundle through the production service seam", async () => {
    const packet = createPacketRoot({ semanticV2: true });
    await authorSemanticV2Packet(packet);
    const policyPath = join(packet.root, "execution-plan.json");
    expect(await runPrdCommand([
      "policy",
      packet.root,
      packet.manifest,
      packet.sidecar,
      packet.target,
      packet.base,
      policyPath,
      "--provider",
      "deterministic-fake",
      "--model",
      "fixture-v2",
      "--transport",
      "pi",
    ], { write: () => undefined })).toBe(0);
    const layer = {};
    const store = { getAsyncLayer: vi.fn(() => layer) };
    const context = {
      projectId: "project-1",
      projectPath: resolve(packet.target),
      projectName: "Fixture",
      isRegistered: true,
      store,
    };
    const importBundle = vi.fn(async () => ({
      importId: "import-1",
      idempotencyKey: "operator-key",
      bundleHash: "bundle-hash",
      identityHash: "identity-hash",
      targetRepository: packet.target,
      targetBase: packet.base,
      state: "active",
      runnable: true,
      stagingRelativePath: ".fusion/ccc-prd-import-staging/import-1",
      transactionWitness: {},
      directCounts: {},
      replayed: false,
    }));
    const closeProjectStore = vi.fn(async () => undefined);
    const inspectVerifierConfinementReadiness = vi.fn(async () => ({
      ready: true,
      backend: "sandbox-exec" as const,
      code: "VERIFIER_CONFINEMENT_READY",
      message: "verifier confinement readiness probe executed successfully",
      trustedPaths: ["/usr/bin/sandbox-exec"] as const,
      detail: "test-injected ready confinement",
    }));
    const dependencies = {
      resolveProject: vi.fn(async () => context),
      closeProjectStore,
      readTargetHead: vi.fn(async () => packet.base),
      importCccPrdBundle: importBundle,
      inspectVerifierConfinementReadiness,
      resolveSemanticProofToolchainPaths: () => packet.semanticProofToolchainPaths!,
      // Controller custody is exercised by the dedicated changed-executable
      // regression above. This service-seam test starts from that admitted
      // sidecar and stays focused on preview/import identity and delegation.
      assertSemanticProofV2Custody: vi.fn(async () => undefined),
    };
    const common = [
      packet.root,
      packet.manifest,
      packet.sidecar,
      policyPath,
      packet.target,
      packet.base,
    ];
    const previewOutput: string[] = [];
    const previewExit = await runPrdJson(
      ["preview", ...common],
      { write: (line) => previewOutput.push(line) },
      dependencies,
      { projectName: "fixture" },
    );
    expect(previewExit, previewOutput.join("\n")).toBe(0);
    const preview = JSON.parse(previewOutput[0]!) as {
      kind: string;
      schema: string;
      confirmationDigest: string;
      projectId: string;
      projectPath: string;
      bundleHash: string;
      packetHash: string;
      sidecarHash: string;
      targetRepository: string;
      targetBase: string;
      targetHead: string;
      executionPolicy: unknown;
      requirements: unknown[];
      tasks: unknown[];
      proofs: unknown[];
      requestBudget: {
        scope: string;
        maximum: number;
        providerTasks: number;
        deterministicMinimum: number;
        headroomAboveMinimum: number;
        completionAdequacy: string;
        explanation: string;
      };
    };
    expect(preview).toMatchObject({
      kind: "preview",
      projectId: "project-1",
      requirements: [expect.objectContaining({ id: "CF-CLI-001" })],
      tasks: [
        expect.objectContaining({ id: "TASK-CLI-001" }),
      ],
      proofs: [expect.objectContaining({ id: "PF-CLI-001" })],
      requestBudget: {
        scope: "campaign-global",
        maximum: 1,
        providerTasks: 1,
        deterministicMinimum: 1,
        headroomAboveMinimum: 0,
        completionAdequacy: "unproven",
        explanation:
          "One first-time provider-attempt reservation slot per provider task is only a static admission floor: it creates no per-task quota or reservation, earlier tasks may exhaust the global cap, and completion adequacy remains unproven.",
      },
      verifierConfinement: {
        ready: true,
        backend: "sandbox-exec",
        code: "VERIFIER_CONFINEMENT_READY",
        message: "verifier confinement readiness probe executed successfully",
        trustedPaths: ["/usr/bin/sandbox-exec"],
      },
    });
    expect(preview.confirmationDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(preview.confirmationDigest).toBe(createHash("sha256").update(canonicalCccPrdJson({
      schema: preview.schema,
      projectId: preview.projectId,
      projectPath: preview.projectPath,
      bundleHash: preview.bundleHash,
      packetHash: preview.packetHash,
      sidecarHash: preview.sidecarHash,
      targetRepository: preview.targetRepository,
      targetBase: preview.targetBase,
      targetHead: preview.targetHead,
      executionPolicy: preview.executionPolicy,
    }), "utf8").digest("hex"));
    expect(closeProjectStore).toHaveBeenCalledTimes(1);

    const importOutput: string[] = [];
    expect(await runPrdJson(
      ["import", ...common, "operator-key", "--confirm", preview.confirmationDigest],
      { write: (line) => importOutput.push(line) },
      dependencies,
      { projectName: "fixture" },
    )).toBe(0);
    expect(JSON.parse(importOutput[0]!)).toMatchObject({
      kind: "imported",
      confirmationDigest: preview.confirmationDigest,
      result: { importId: "import-1", state: "active", runnable: true },
    });
    expect(importBundle).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: "operator-key",
      rootDir: context.projectPath,
      layer,
      store,
      executionPolicy: expect.objectContaining({
        schema: "ccc-campaign.execution-policy.v2",
      }),
      semanticProofToolchainPaths: packet.semanticProofToolchainPaths,
    }));
    expect(closeProjectStore).toHaveBeenCalledTimes(2);
    expect(inspectVerifierConfinementReadiness).toHaveBeenCalledTimes(2);
  });

  it("shows extracted PRD work and actionable verifier guidance when confinement is unavailable", async () => {
    const packet = createPacketRoot({ semanticV2: true });
    await authorSemanticV2Packet(packet);
    const policyPath = await createExecutionPlan(packet);
    const context = {
      projectId: "project-1",
      projectPath: resolve(packet.target),
      projectName: "Fixture",
      isRegistered: true,
      store: { getAsyncLayer: vi.fn(() => ({})) },
    };
    const output: string[] = [];

    expect(await runPrdJson(
      [
        "preview",
        packet.root,
        packet.manifest,
        packet.sidecar,
        policyPath,
        packet.target,
        packet.base,
      ],
      { write: (line) => output.push(line) },
      {
        resolveProject: vi.fn(async () => context),
        closeProjectStore: vi.fn(async () => undefined),
        readTargetHead: vi.fn(async () => packet.base),
        resolveSemanticProofToolchainPaths: () => packet.semanticProofToolchainPaths!,
        inspectVerifierConfinementReadiness: vi.fn(async () => ({
          ready: false,
          backend: "bubblewrap" as const,
          code: "VERIFIER_CONFINEMENT_UNAVAILABLE",
          message: "trusted bubblewrap confinement is unavailable",
          trustedPaths: ["/usr/bin/bwrap", "/bin/bwrap"] as const,
          detail: "private runner detail must not reach operator output",
        })),
      },
      { projectName: "fixture" },
    )).toBe(0);

    const preview = JSON.parse(output[0]!);
    expect(preview).toMatchObject({
      kind: "preview",
      requirements: [expect.objectContaining({ id: "CF-CLI-001" })],
      tasks: [expect.objectContaining({ id: "TASK-CLI-001" })],
      verifierConfinement: {
        ready: false,
        backend: "bubblewrap",
        code: "VERIFIER_CONFINEMENT_UNAVAILABLE",
        safeState: "The frozen PRD preview is intact; no campaign, approval, provider effect, or source change was created.",
        decisionOwner: "Fusion host or CI runner operator",
        consequence: "Campaign import and live execution remain blocked because exact requirement proof cannot run safely.",
        recoveryOptions: [
          "Provision and functionally verify the trusted verifier confinement backend on this host.",
          "Keep the packet as a review-only preview until confinement is ready.",
        ],
        nextSafeAction: "Repair the trusted verifier confinement backend, then rerun fn prd preview before import.",
      },
    });
    expect(output[0]).not.toContain("private runner detail");
  }, 60_000);

  it("refuses import before project or importer residue when readiness has no admitted backend", async () => {
    const packet = createPacketRoot({ semanticV2: true });
    await authorSemanticV2Packet(packet);
    const policyPath = await createExecutionPlan(packet);
    const context = {
      projectId: "project-1",
      projectPath: resolve(packet.target),
      projectName: "Fixture",
      isRegistered: true,
      store: { getAsyncLayer: vi.fn(() => ({})) },
    };
    const resolveProject = vi.fn(async () => context);
    const importBundle = vi.fn();
    const inspectVerifierConfinementReadiness = vi.fn()
      .mockResolvedValueOnce({
        ready: true,
        backend: "sandbox-exec" as const,
        code: "VERIFIER_CONFINEMENT_READY",
        message: "verifier confinement readiness probe executed successfully",
        trustedPaths: ["/usr/bin/sandbox-exec"] as const,
      })
      .mockResolvedValueOnce({
        ready: true,
        backend: "native" as never,
        code: "VERIFIER_CONFINEMENT_INVALID_RESULT",
        message: "readiness result named an unadmitted backend",
        trustedPaths: [] as const,
        detail: "private runner detail must not reach operator output",
      });
    const dependencies = {
      resolveProject,
      closeProjectStore: vi.fn(async () => undefined),
      readTargetHead: vi.fn(async () => packet.base),
      importCccPrdBundle: importBundle,
      inspectVerifierConfinementReadiness,
      resolveSemanticProofToolchainPaths: () => packet.semanticProofToolchainPaths!,
      // The dedicated executable-drift tests own the real custody probe. This
      // case isolates confinement refusal without re-running toolchain probes.
      assertSemanticProofV2Custody: vi.fn(async () => undefined),
    };
    const common = [
      packet.root,
      packet.manifest,
      packet.sidecar,
      policyPath,
      packet.target,
      packet.base,
    ];
    const previewOutput: string[] = [];
    expect(await runPrdJson(
      ["preview", ...common],
      { write: (line) => previewOutput.push(line) },
      dependencies,
      { projectName: "fixture" },
    )).toBe(0);
    const preview = JSON.parse(previewOutput[0]!) as {
      confirmationDigest: string;
    };
    const importOutput: string[] = [];

    expect(await runPrdJson(
      ["import", ...common, "operator-key", "--confirm", preview.confirmationDigest],
      { write: (line) => importOutput.push(line) },
      dependencies,
      { projectName: "fixture" },
    )).toBe(1);

    expect(JSON.parse(importOutput[0]!)).toMatchObject({
      kind: "refusal",
      diagnostics: [{
        code: "CCC_CAMPAIGN_VERIFIER_CONFINEMENT_UNAVAILABLE",
        message: "Exact requirement verification is unavailable: readiness result named an unadmitted backend",
      }],
      safeState: "This import created no campaign rows, staging files, approvals, provider effects, or source changes.",
      decisionOwner: "Fusion host or CI runner operator",
      consequence: "The PRD packet remains reviewable, but Fusion cannot safely import or execute it on this host.",
      approvalExpiresAt: null,
      recoveryOptions: [
        "Provision and functionally verify the trusted verifier confinement backend at one trusted system path.",
        "Keep the frozen packet unchanged and rerun preview after the host is repaired.",
      ],
      nextSafeAction: "Repair verifier confinement, rerun fn prd preview, then issue a fresh import confirmation.",
    });
    expect(importOutput[0]).not.toContain("private runner detail");
    expect(resolveProject).toHaveBeenCalledTimes(1);
    expect(importBundle).not.toHaveBeenCalled();
    expect(inspectVerifierConfinementReadiness).toHaveBeenCalledTimes(2);
  });

  it("recomputes preview identity and refuses a stale confirmation before import residue", async () => {
    const packet = createPacketRoot({ semanticV2: true });
    await authorSemanticV2Packet(packet);
    const policyPath = await createExecutionPlan(packet);
    const importBundle = vi.fn();
    const closeProjectStore = vi.fn(async () => undefined);
    const context = {
      projectId: "project-1",
      projectPath: resolve(packet.target),
      projectName: "Fixture",
      isRegistered: true,
      store: { getAsyncLayer: () => ({}) },
    };
    const output: string[] = [];
    const inspectVerifierConfinementReadiness = vi.fn(async () => ({
      ready: true,
      backend: "sandbox-exec" as const,
      code: "VERIFIER_CONFINEMENT_READY",
      message: "verifier confinement readiness probe executed successfully",
      trustedPaths: ["/usr/bin/sandbox-exec"] as const,
    }));
    expect(await runPrdJson(
      [
        "import",
        packet.root,
        packet.manifest,
        packet.sidecar,
        policyPath,
        packet.target,
        packet.base,
        "operator-key",
        "--confirm",
        "f".repeat(64),
      ],
      { write: (line) => output.push(line) },
      {
        resolveProject: vi.fn(async () => context),
        closeProjectStore,
        readTargetHead: vi.fn(async () => packet.base),
        importCccPrdBundle: importBundle,
        inspectVerifierConfinementReadiness,
        resolveSemanticProofToolchainPaths: () => packet.semanticProofToolchainPaths!,
        // Digest mismatch is the authority under test; executable custody has
        // dedicated drift and pre-launch coverage elsewhere in this suite.
        assertSemanticProofV2Custody: vi.fn(async () => undefined),
      },
      { projectName: "fixture" },
    )).toBe(1);
    expect(JSON.parse(output[0]!)).toMatchObject({
      kind: "refusal",
      diagnostics: [expect.objectContaining({ code: "CCC_PRD_CONFIRMATION_MISMATCH" })],
    });
    expect(importBundle).not.toHaveBeenCalled();
    expect(closeProjectStore).toHaveBeenCalledTimes(1);
    expect(inspectVerifierConfinementReadiness).toHaveBeenCalledTimes(1);
  });

  it("refuses product preview/import when implementation facts are not source-bound before import residue", async () => {
    const packet = createPacketRoot();
    expect(await runPrdCommand(
      ["author", packet.root, packet.manifest, packet.proposal, packet.sidecar],
      { write: () => undefined },
      { bootstrapProofAdmission },
    )).toBe(0);
    const sidecar = JSON.parse(readFileSync(packet.sidecar, "utf8")) as {
      admittedWriteRoots: Array<{ path: string; purpose: string }>;
    };
    sidecar.admittedWriteRoots = [{ path: `${packet.target}/src/not-in-prd`, purpose: "tampered path" }];
    writeFileSync(packet.sidecar, JSON.stringify(sidecar));

    const policyPath = join(packet.root, "execution-policy.json");
    writeFileSync(policyPath, JSON.stringify({
      schema: "ccc-campaign.execution-policy.v2",
      routes: [
        {
          taskId: "TASK-CLI-001",
          providerId: "deterministic-fake",
          modelId: "fixture-v2",
          transport: "pi",
          executor: "model",
          toolMode: "coding",
          worktreeMode: "isolated",
          ownedPaths: ["src/not-in-prd"],
          allowedWriteRoots: ["src/not-in-prd"],
          commitPolicy: "required",
        },
      ],
    }));
    const importBundle = vi.fn();
    const closeProjectStore = vi.fn(async () => undefined);
    const dependencies = {
      resolveProject: vi.fn(async () => ({
        projectId: "project-1",
        projectPath: resolve(packet.target),
        projectName: "Fixture",
        isRegistered: true,
        store: { getAsyncLayer: vi.fn(() => ({})) },
      })),
      closeProjectStore,
      readTargetHead: vi.fn(async () => packet.base),
      importCccPrdBundle: importBundle,
    };
    const output: string[] = [];
    expect(await runPrdJson(
      [
        "import",
        packet.root,
        packet.manifest,
        packet.sidecar,
        policyPath,
        packet.target,
        packet.base,
        "operator-key",
        "--confirm",
        "0".repeat(64),
      ],
      { write: (line) => output.push(line) },
      dependencies,
      { projectName: "fixture" },
    )).toBe(1);

    expect(JSON.parse(output[0]!)).toMatchObject({
      kind: "refusal",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "CCC_PRD_ALLOWED_WRITE_ROOT_PROVENANCE_REQUIRED" }),
      ]),
    });
    expect(importBundle).not.toHaveBeenCalled();
    expect(dependencies.resolveProject).not.toHaveBeenCalled();
    expect(closeProjectStore).not.toHaveBeenCalled();
  });

  it("shows one redacted product status with an exact merge confirmation", async () => {
    const confirmation = "c".repeat(64);
    const approval = {
      id: "approval-1",
      status: "issued",
      requester: {
        actorId: "ccc-campaign-runtime",
        actorType: "agent",
        actorName: "CCC Campaign Runtime",
      },
      targetAction: {
        category: "git_write",
        action: "ACTION-merge",
        summary: "Merge the campaign result",
        resourceType: "ccc-campaign-merge",
        resourceId: "refs/heads/main",
        context: {
          protectedActionKind: "merge",
          operatorDecision: "approve_merge",
        },
      },
      taskId: "TASK-terminal",
      runId: "RUN-product",
      requestedAt: "2026-07-31T00:00:00.000Z",
      createdAt: "2026-07-31T00:00:00.000Z",
      updatedAt: "2026-07-31T00:00:00.000Z",
      campaign: {
        binding: {
          projectId: "project-1",
          importId: "import-1",
          campaignId: "campaign-1",
          taskId: "TASK-terminal",
          actionId: "ACTION-merge",
          actionTarget: "refs/heads/main",
          idempotencyKey: "operator-key",
          packetHash: "a".repeat(64),
          sidecarHash: "b".repeat(64),
          bundleHash: "c".repeat(64),
          targetRepository: "/tmp/product-target",
          targetBase: "d".repeat(40),
          providerId: "fixture",
          modelId: "fixture-v2",
          transport: "pi",
          manifestHash: "e".repeat(64),
          bindingHash: "f".repeat(64),
        },
        notBeforeAt: "2026-07-31T00:00:00.000Z",
        expiresAt: "2026-07-31T01:00:00.000Z",
        claimToken: "must-never-serialize",
      },
    };
    const status = {
      schema: "ccc-prd.product-status.v1",
      projectId: "project-1",
      import: {
        importId: "import-1",
        idempotencyKey: "operator-key",
        targetRepository: "/tmp/product-target",
        targetBase: "d".repeat(40),
        state: "active",
        runnable: true,
      },
      tasks: [],
      workItems: [{
        id: "work-item-1",
        runId: "ccc-prd:import-1",
        taskId: "TASK-entry",
        nodeId: "node-entry",
        kind: "task",
        state: "manual-required",
        attempt: 1,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: "ccc-permanent:CCC_CAMPAIGN_MERGE_APPROVAL_REQUIRED",
        blockedReason: "ccc-permanent:CCC_CAMPAIGN_MERGE_APPROVAL_REQUIRED",
        stableWorkflowRunId: "ccc-prd:import-1",
      }],
      proofs: [],
      orphanProofAttempts: [],
      approvals: [approval],
      landing: { intents: [], terminals: [] },
      nextAction: {
        kind: "approve-merge",
        reason: "Executed proof is complete; exact human merge approval is next.",
      },
      controllerToken: "must-never-serialize",
    };
    const layer = {};
    const context = {
      projectId: "project-1",
      projectPath: "/tmp/product-target",
      projectName: "Fixture",
      isRegistered: true,
      store: { getAsyncLayer: () => layer },
    };
    const output: string[] = [];

    expect(await runPrdJson(
      ["status", "operator-key"],
      { write: (line) => output.push(line) },
      {
        resolveProject: vi.fn(async () => context),
        closeProjectStore: vi.fn(async () => undefined),
        inspectCccPrdProductStatus: vi.fn(async () => status),
        computeCccCampaignMergeApprovalConfirmation: vi.fn(() => confirmation),
      },
      { projectName: "fixture" },
    )).toBe(0);

    expect(JSON.parse(output[0]!)).toMatchObject({
      kind: "product-status",
      found: true,
      status: {
        nextAction: { kind: "approve-merge" },
      },
      mergeApprovalConfirmations: [{
        approvalRequestId: "approval-1",
        confirmation,
      }],
      operatorControls: expect.arrayContaining([
        expect.objectContaining({ action: "pause" }),
        expect.objectContaining({ action: "resume" }),
        expect.objectContaining({ action: "stop" }),
      ]),
    });
    expect(output[0]).not.toContain("claimToken");
    expect(output[0]).not.toContain("controllerToken");
    expect(output[0]).not.toContain("must-never-serialize");
  });

  it("shows one sealed execution-authorization confirmation while retaining child diagnostics", async () => {
    const confirmation = "8".repeat(64);
    const authorization = sealedExecutionAuthorization();
    const childApprovals = [
      diagnosticLiveApproval(authorization.members[0]!.approvalRequestId, "TASK-coding"),
      diagnosticLiveApproval(authorization.members[1]!.approvalRequestId, "TASK-review"),
    ];
    const status = {
      schema: "ccc-prd.product-status.v1",
      projectId: "project-1",
      import: {
        importId: "import-1",
        idempotencyKey: "operator-key",
        targetRepository: "/tmp/product-target",
        targetBase: "d".repeat(40),
        state: "active",
        runnable: true,
      },
      tasks: [],
      workItems: [],
      proofs: [],
      orphanProofAttempts: [],
      providerAttempts: [],
      executionAuthorizationMode: "sealed_bundle_v1" as const,
      executionAuthorization: authorization,
      approvals: childApprovals,
      landing: { intents: [], materializations: [], terminals: [] },
      nextAction: {
        kind: "approve-execution",
        reason: "Approve the one sealed campaign launch.",
        executionAuthorizationId: authorization.authorizationId,
        executionAuthorizationStatus: "issued",
      },
    };
    const computeConfirmation = vi.fn(() => confirmation);
    const output: string[] = [];

    expect(await runPrdJson(
      ["status", "operator-key"],
      { write: (line) => output.push(line) },
      {
        resolveProject: vi.fn(async () => ({
          projectId: "project-1",
          projectPath: "/tmp/product-target",
          projectName: "Fixture",
          isRegistered: true,
          store: { getAsyncLayer: () => ({}) },
        })),
        closeProjectStore: vi.fn(async () => undefined),
        inspectCccPrdProductStatus: vi.fn(async () => status),
        computeCccCampaignLiveExecutionApprovalConfirmation: computeConfirmation,
      },
      { projectName: "fixture" },
    )).toBe(0);

    const payload = JSON.parse(output[0]!);
    expect(payload).toMatchObject({
      kind: "product-status",
      found: true,
      status: {
        executionAuthorization: {
          authorizationId: authorization.authorizationId,
          status: "issued",
          members: [
            { approvalRequestId: authorization.members[0]!.approvalRequestId },
            { approvalRequestId: authorization.members[1]!.approvalRequestId },
          ],
          memberCustody: [
            {
              approvalRequestId: authorization.members[0]!.approvalRequestId,
              status: "issued",
              nativeTaskId: "TASK-coding",
            },
            {
              approvalRequestId: authorization.members[1]!.approvalRequestId,
              status: "issued",
              nativeTaskId: "TASK-review",
            },
          ],
        },
        approvals: [
          { id: authorization.members[0]!.approvalRequestId },
          { id: authorization.members[1]!.approvalRequestId },
        ],
      },
      liveExecutionAuthorizationConfirmation: {
        authorizationId: authorization.authorizationId,
        confirmation,
        expiresAt: authorization.expiresAt,
        status: "issued",
      },
      liveExecutionApprovalConfirmations: [],
    });
    expect(computeConfirmation).toHaveBeenCalledTimes(1);
    expect(computeConfirmation).toHaveBeenCalledWith(authorization);
  });

  it("emits no live execution confirmation after the sealed authorization settles", async () => {
    const authorization = sealedExecutionAuthorization("settled");
    const computeConfirmation = vi.fn(() => "8".repeat(64));
    const output: string[] = [];

    expect(await runPrdJson(
      ["status", "operator-key"],
      { write: (line) => output.push(line) },
      {
        resolveProject: vi.fn(async () => ({
          projectId: "project-1",
          projectPath: "/tmp/product-target",
          projectName: "Fixture",
          isRegistered: true,
          store: { getAsyncLayer: () => ({}) },
        })),
        closeProjectStore: vi.fn(async () => undefined),
        inspectCccPrdProductStatus: vi.fn(async () => ({
          schema: "ccc-prd.product-status.v1",
          projectId: "project-1",
          import: {
            importId: "import-1",
            idempotencyKey: "operator-key",
            targetRepository: "/tmp/product-target",
            targetBase: "d".repeat(40),
            state: "active",
            runnable: true,
          },
          tasks: [],
          workItems: [],
          proofs: [],
          orphanProofAttempts: [],
          providerAttempts: [],
          executionAuthorizationMode: "sealed_bundle_v1",
          executionAuthorization: authorization,
          approvals: [],
          landing: { intents: [], materializations: [], terminals: [] },
          nextAction: {
            kind: "blocked",
            reason: "The sealed execution authorization is already settled.",
          },
        })),
        computeCccCampaignLiveExecutionApprovalConfirmation: computeConfirmation,
      },
      { projectName: "fixture" },
    )).toBe(0);

    const payload = JSON.parse(output[0]!);
    expect(payload).not.toHaveProperty("liveExecutionAuthorizationConfirmation");
    expect(payload.liveExecutionApprovalConfirmations).toEqual([]);
    expect(computeConfirmation).not.toHaveBeenCalled();
  });

  it("RED-R11-expired-parent-status: emits no confirmation for an expired issued parent authorization", async () => {
    const authorization = {
      ...sealedExecutionAuthorization(),
      expiresAt: "2000-01-01T00:00:00.000Z",
    };
    const computeConfirmation = vi.fn(() => "8".repeat(64));
    const output: string[] = [];

    expect(await runPrdJson(
      ["status", "operator-key"],
      { write: (line) => output.push(line) },
      {
        resolveProject: vi.fn(async () => ({
          projectId: "project-1",
          projectPath: "/tmp/product-target",
          projectName: "Fixture",
          isRegistered: true,
          store: { getAsyncLayer: () => ({}) },
        })),
        closeProjectStore: vi.fn(async () => undefined),
        inspectCccPrdProductStatus: vi.fn(async () => ({
          schema: "ccc-prd.product-status.v1",
          projectId: "project-1",
          import: {
            importId: "import-1",
            idempotencyKey: "operator-key",
            targetRepository: "/tmp/product-target",
            targetBase: "d".repeat(40),
            state: "active",
            runnable: true,
          },
          tasks: [],
          workItems: [],
          proofs: [],
          orphanProofAttempts: [],
          providerAttempts: [],
          executionAuthorizationMode: "sealed_bundle_v1",
          executionAuthorization: authorization,
          approvals: [],
          landing: { intents: [], materializations: [], terminals: [] },
          nextAction: {
            kind: "blocked",
            reason: "The sealed execution authorization expired.",
            diagnostic: "CCC_CAMPAIGN_LIVE_EXECUTION_AUTHORIZATION_EXPIRED",
          },
        })),
        computeCccCampaignLiveExecutionApprovalConfirmation: computeConfirmation,
      },
      { projectName: "fixture" },
    )).toBe(0);

    const payload = JSON.parse(output[0]!);
    expect(payload).not.toHaveProperty("liveExecutionAuthorizationConfirmation");
    expect(payload.liveExecutionApprovalConfirmations).toEqual([]);
    expect(computeConfirmation).not.toHaveBeenCalled();
  });

  it("emits no child execution confirmations when sealed parent custody is missing", async () => {
    const childApproval = diagnosticLiveApproval(
      `ccc-approval-${"a".repeat(64)}`,
      "TASK-coding",
    );
    const computeConfirmation = vi.fn(() => "8".repeat(64));
    const output: string[] = [];

    expect(await runPrdJson(
      ["status", "operator-key"],
      { write: (line) => output.push(line) },
      {
        resolveProject: vi.fn(async () => ({
          projectId: "project-1",
          projectPath: "/tmp/product-target",
          projectName: "Fixture",
          isRegistered: true,
          store: { getAsyncLayer: () => ({}) },
        })),
        closeProjectStore: vi.fn(async () => undefined),
        inspectCccPrdProductStatus: vi.fn(async () => ({
          schema: "ccc-prd.product-status.v1",
          projectId: "project-1",
          import: {
            importId: "import-1",
            idempotencyKey: "operator-key",
            targetRepository: "/tmp/product-target",
            targetBase: "d".repeat(40),
            state: "active",
            runnable: true,
          },
          tasks: [],
          workItems: [],
          proofs: [],
          orphanProofAttempts: [],
          providerAttempts: [],
          executionAuthorizationMode: "sealed_bundle_v1",
          executionAuthorization: null,
          approvals: [childApproval],
          landing: { intents: [], materializations: [], terminals: [] },
          nextAction: {
            kind: "blocked",
            reason: "The single sealed campaign authorization is missing.",
          },
        })),
        computeCccCampaignLiveExecutionApprovalConfirmation: computeConfirmation,
      },
      { projectName: "fixture" },
    )).toBe(0);

    const payload = JSON.parse(output[0]!);
    expect(payload.status.approvals).toEqual([
      expect.objectContaining({ id: childApproval.id }),
    ]);
    expect(payload.liveExecutionApprovalConfirmations).toEqual([]);
    expect(payload).not.toHaveProperty("liveExecutionAuthorizationConfirmation");
    expect(computeConfirmation).not.toHaveBeenCalled();
  });

  it("pauses and resumes only the exact confirmed unleased campaign status", async () => {
    const confirmation = "6".repeat(64);
    const workItem = {
      id: "work-item-1",
      runId: "ccc-prd:import-1",
      taskId: "FN-entry",
      nodeId: "node-entry",
      kind: "task",
      state: "runnable",
      attempt: 2,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: null,
      blockedReason: null,
      stableWorkflowRunId: "ccc-prd:import-1",
    };
    const before = {
      schema: "ccc-prd.product-status.v1",
      projectId: "project-1",
      import: {
        importId: "import-1",
        idempotencyKey: "operator-key",
        targetRepository: "/tmp/product-target",
        targetBase: "d".repeat(40),
        state: "active",
        runnable: true,
      },
      tasks: [{
        semanticTaskId: "TASK-1",
        nativeTaskId: "FN-1",
        present: true,
      }],
      workItems: [workItem],
      proofs: [],
      orphanProofAttempts: [],
      approvals: [],
      landing: { intents: [], terminals: [] },
      nextAction: { kind: "wait-for-runtime", reason: "Running." },
    };
    const afterPause = {
      ...before,
      workItems: [{
        ...workItem,
        state: "held",
        blockedReason: "ccc-operator:campaign-paused",
      }],
      nextAction: { kind: "blocked", reason: "Paused." },
    };
    const transitionWorkflowWorkItem = vi.fn();
    const pauseTask = vi.fn();
    const layer = {};
    const context = {
      projectId: "project-1",
      projectPath: "/tmp/product-target",
      projectName: "Fixture",
      isRegistered: true,
      store: {
        getAsyncLayer: () => layer,
        transitionWorkflowWorkItem,
        pauseTask,
      },
    };
    const applyControl = vi.fn(async () => ({
      action: "pause",
      workItemId: "work-item-1",
      workItemState: "held",
      taskIds: ["FN-1"],
      unresolvedEffectsPreserved: false,
    }));
    const inspectStatus = vi.fn()
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(afterPause);
    const output: string[] = [];

    expect(await runPrdJson(
      ["pause", "operator-key", "--confirm", confirmation],
      { write: (line) => output.push(line) },
      {
        resolveProject: vi.fn(async () => context),
        closeProjectStore: vi.fn(async () => undefined),
        inspectCccPrdProductStatus: inspectStatus,
        computeCccCampaignOperatorControlConfirmation: vi.fn(
          () => confirmation,
        ),
        applyCccCampaignOperatorControl: applyControl,
        describeCccCampaignOperatorControls: vi.fn(() => []),
      },
      { projectName: "fixture" },
    )).toBe(0);

    expect(applyControl).toHaveBeenCalledWith({
      action: "pause",
      status: before,
      store: context.store,
    });
    expect(JSON.parse(output[0]!)).toMatchObject({
      kind: "campaign-paused",
      result: {
        workItemId: "work-item-1",
        workItemState: "held",
      },
      status: {
        workItems: [expect.objectContaining({ state: "held" })],
      },
    });
  });

  it("terminally stops a campaign only with a fresh digest and explicit reason", async () => {
    const confirmation = "7".repeat(64);
    const reason = "Operator abandons this run after preserving all receipts.";
    const workItem = {
      id: "work-item-1",
      runId: "ccc-prd:import-1",
      taskId: "FN-1",
      nodeId: "node-entry",
      kind: "task",
      state: "manual-required",
      attempt: 3,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: "ccc-permanent:CCC_CAMPAIGN_PROOF_DISPATCH_UNKNOWN",
      blockedReason: "ccc-permanent:CCC_CAMPAIGN_PROOF_DISPATCH_UNKNOWN",
      stableWorkflowRunId: "ccc-prd:import-1",
    };
    const before = {
      schema: "ccc-prd.product-status.v1",
      projectId: "project-1",
      import: {
        importId: "import-1",
        idempotencyKey: "operator-key",
        targetRepository: "/tmp/product-target",
        targetBase: "d".repeat(40),
        state: "active",
        runnable: true,
      },
      tasks: [{
        semanticTaskId: "TASK-1",
        nativeTaskId: "FN-1",
        present: true,
      }],
      workItems: [workItem],
      proofs: [{
        definition: { id: "PROOF-1" },
        attempts: [{
          attemptKey: `ccc-proof-attempt-${"a".repeat(64)}`,
          state: "dispatched_unknown",
        }],
      }],
      orphanProofAttempts: [],
      approvals: [],
      landing: { intents: [], terminals: [] },
      nextAction: {
        kind: "resolve-manual-required",
        reason: "Proof effect is uncertain.",
      },
    };
    const afterStop = {
      ...before,
      workItems: [{
        ...workItem,
        state: "cancelled",
        lastError: `ccc-operator:campaign-stopped:${"f".repeat(64)}`,
        blockedReason: reason,
      }],
      nextAction: { kind: "abandoned", reason: "Stopped by operator." },
    };
    const layer = {};
    const context = {
      projectId: "project-1",
      projectPath: "/tmp/product-target",
      projectName: "Fixture",
      isRegistered: true,
      store: {
        getAsyncLayer: () => layer,
        transitionWorkflowWorkItem: vi.fn(),
        pauseTask: vi.fn(),
      },
    };
    const applyControl = vi.fn(async () => ({
      action: "stop",
      workItemId: "work-item-1",
      workItemState: "cancelled",
      taskIds: ["FN-1"],
      unresolvedEffectsPreserved: true,
    }));
    const inspectStatus = vi.fn()
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(afterStop);
    const output: string[] = [];

    expect(await runPrdJson(
      [
        "stop",
        "operator-key",
        "--reason",
        reason,
        "--confirm",
        confirmation,
      ],
      { write: (line) => output.push(line) },
      {
        resolveProject: vi.fn(async () => context),
        closeProjectStore: vi.fn(async () => undefined),
        inspectCccPrdProductStatus: inspectStatus,
        computeCccCampaignOperatorControlConfirmation: vi.fn(
          () => confirmation,
        ),
        applyCccCampaignOperatorControl: applyControl,
        describeCccCampaignOperatorControls: vi.fn(() => []),
      },
      { projectName: "fixture" },
    )).toBe(0);

    expect(applyControl).toHaveBeenCalledWith({
      action: "stop",
      reason,
      status: before,
      store: context.store,
    });
    expect(JSON.parse(output[0]!)).toMatchObject({
      kind: "campaign-stopped",
      result: {
        workItemState: "cancelled",
        unresolvedEffectsPreserved: true,
      },
      status: {
        nextAction: { kind: "abandoned" },
      },
    });
  });

  it("previews and settles one uncertain proof before requeueing its exact work item", async () => {
    const packet = createPacketRoot();
    const evidencePath = join(packet.root, "proof-resolution.json");
    writeFileSync(evidencePath, JSON.stringify({
      schema: "ccc-campaign.proof-resolution.v1",
      observerId: "operator-local-1",
      summary: "Observed the verifier process exit zero and captured its output.",
      result: {
        success: true,
        exitCode: 0,
        durationMs: 42,
        stdout: "POSITIVE_ORACLE_PASS\n",
        stderr: "",
        timedOut: false,
        killed: false,
        warnings: [],
        negativeControlLabel: "planted-defect-failed",
      },
    }));
    const attemptKey = `ccc-proof-attempt-${"a".repeat(64)}`;
    const workItem = {
      id: "work-item-1",
      runId: "ccc-prd:import-1",
      taskId: "FN-1",
      nodeId: "node-proof",
      kind: "task",
      state: "manual-required",
      attempt: 4,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: "ccc-permanent:CCC_CAMPAIGN_PROOF_DISPATCH_UNKNOWN",
      blockedReason: "ccc-permanent:CCC_CAMPAIGN_PROOF_DISPATCH_UNKNOWN",
      stableWorkflowRunId: "ccc-prd:import-1",
    };
    const proofAttempt = {
      attemptKey,
      importId: "import-1",
      campaignId: "campaign-1",
      taskId: "FN-1",
      semanticTaskId: "TASK-1",
      proofId: "PROOF-1",
      packetHash: "a".repeat(64),
      sidecarHash: "b".repeat(64),
      bundleHash: "c".repeat(64),
      manifestHash: "d".repeat(64),
      campaignBindingHash: "e".repeat(64),
      targetRepository: "/tmp/product-target",
      targetBase: "f".repeat(40),
      sourceCommit: "1".repeat(40),
      sourceTree: "2".repeat(40),
      definitionSha256: "3".repeat(64),
      commandSha256: "4".repeat(64),
      workItemId: workItem.id,
      runId: workItem.runId,
      workItemAttempt: workItem.attempt,
      state: "dispatched_unknown",
      result: null,
      createdAt: "2026-07-31T00:00:00.000Z",
      updatedAt: "2026-07-31T00:00:01.000Z",
      dispatchedAt: "2026-07-31T00:00:01.000Z",
      settledAt: null,
    };
    const before = {
      schema: "ccc-prd.product-status.v1",
      projectId: "project-1",
      import: {
        importId: "import-1",
        idempotencyKey: "operator-key",
        packetHash: "a".repeat(64),
        sidecarHash: "b".repeat(64),
        bundleHash: "c".repeat(64),
        targetRepository: "/tmp/product-target",
        targetBase: "f".repeat(40),
        state: "active",
        runnable: true,
      },
      tasks: [{
        semanticTaskId: "TASK-1",
        nativeTaskId: "FN-1",
        present: true,
      }],
      workItems: [workItem],
      proofs: [{
        definition: { id: "PROOF-1" },
        definitionSha256: "3".repeat(64),
        attempts: [proofAttempt],
      }],
      orphanProofAttempts: [],
      approvals: [],
      landing: { intents: [], terminals: [] },
      nextAction: {
        kind: "resolve-manual-required",
        reason: "Proof effect is uncertain.",
      },
    };
    const after = {
      ...before,
      workItems: [{
        ...workItem,
        state: "runnable",
        lastError: null,
        blockedReason: null,
      }],
      proofs: [{
        ...before.proofs[0],
        attempts: [{
          ...proofAttempt,
          state: "committed",
          result: { success: true, exitCode: 0 },
        }],
      }],
      nextAction: { kind: "wait-for-runtime", reason: "Ready." },
    };
    const transitionWorkflowWorkItem = vi.fn(async () => after.workItems[0]);
    const layer = {};
    const context = {
      projectId: "project-1",
      projectPath: "/tmp/product-target",
      projectName: "Fixture",
      isRegistered: true,
      store: {
        getAsyncLayer: () => layer,
        transitionWorkflowWorkItem,
      },
    };
    const inspectStatus = vi.fn()
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(after);
    const persistedAttempt = {
      ...proofAttempt,
      controllerToken:
        "ccc-proof-controller-00000000-0000-4000-8000-000000000001",
    };
    const inspectAttempt = vi.fn(async () => persistedAttempt);
    const settleAttempt = vi.fn(async () => ({
      ...persistedAttempt,
      state: "committed",
      result: { success: true },
    }));
    const previewOutput: string[] = [];

    const previewExit = await runPrdJson(
      ["resolve-proof", "operator-key", attemptKey, evidencePath],
      { write: (line) => previewOutput.push(line) },
      {
        resolveProject: vi.fn(async () => context),
        closeProjectStore: vi.fn(async () => undefined),
        inspectCccPrdProductStatus: inspectStatus,
        inspectCccCampaignProofAttempt: inspectAttempt,
        settleCccCampaignProofAttempt: settleAttempt,
      },
      { projectName: "fixture" },
    );
    expect(previewExit, previewOutput.join("\n")).toBe(0);
    const preview = JSON.parse(previewOutput[0]!);
    expect(preview).toMatchObject({
      kind: "proof-resolution-preview",
      attemptKey,
      decision: "settle",
      consequence: expect.stringContaining("requeue"),
      confirmation: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(inspectAttempt).not.toHaveBeenCalled();
    expect(settleAttempt).not.toHaveBeenCalled();
    expect(transitionWorkflowWorkItem).not.toHaveBeenCalled();

    const settleOutput: string[] = [];
    expect(await runPrdJson(
      [
        "resolve-proof",
        "operator-key",
        attemptKey,
        evidencePath,
        "--confirm",
        preview.confirmation,
      ],
      { write: (line) => settleOutput.push(line) },
      {
        resolveProject: vi.fn(async () => context),
        closeProjectStore: vi.fn(async () => undefined),
        inspectCccPrdProductStatus: inspectStatus,
        inspectCccCampaignProofAttempt: inspectAttempt,
        settleCccCampaignProofAttempt: settleAttempt,
      },
      { projectName: "fixture" },
    )).toBe(0);

    expect(inspectAttempt).toHaveBeenCalledWith({
      attemptKey,
      layer,
    });
    expect(settleAttempt).toHaveBeenCalledWith(expect.objectContaining({
      attemptKey,
      controllerToken: persistedAttempt.controllerToken,
      layer,
      result: expect.objectContaining({
        success: true,
        stdout: "POSITIVE_ORACLE_PASS\n",
        warnings: [
          "operator-reconciliation:operator-local-1: Observed the verifier process exit zero and captured its output.",
        ],
      }),
    }));
    expect(transitionWorkflowWorkItem).toHaveBeenCalledWith(
      workItem.id,
      "runnable",
      {
        expectedState: "manual-required",
        expectedAttempt: workItem.attempt,
        expectedLeaseOwner: null,
        attempt: workItem.attempt,
        leaseOwner: null,
        leaseExpiresAt: null,
        retryAfter: null,
        lastError: null,
        blockedReason: null,
      },
    );
    expect(JSON.parse(settleOutput[0]!)).toMatchObject({
      kind: "proof-resolved",
      attempt: {
        attemptKey,
        state: "committed",
      },
      status: {
        workItems: [expect.objectContaining({ state: "runnable" })],
      },
    });
    expect(settleOutput[0]).not.toContain("controllerToken");
    expect(settleOutput[0]).not.toContain(persistedAttempt.controllerToken);
  });

  it("RED-S5-RESOLVE-V2: refuses manual fabrication for semantic proof v2 attempts", async () => {
    const packet = createPacketRoot();
    const evidencePath = join(packet.root, "proof-resolution-v2.json");
    writeFileSync(evidencePath, JSON.stringify({
      schema: "ccc-campaign.proof-resolution.v1",
      observerId: "operator-local-v2",
      summary: "A generic process result cannot fabricate semantic proof evidence.",
      result: {
        success: true,
        exitCode: 0,
        durationMs: 1,
        stdout: "PASS\n",
        stderr: "",
        timedOut: false,
        killed: false,
        warnings: [],
        negativeControlLabel: "generic-only",
      },
    }));
    const attemptKey = `ccc-proof-attempt-${"b".repeat(64)}`;
    const workItem = {
      id: "work-item-v2",
      runId: "ccc-prd:import-v2",
      taskId: "FN-v2",
      nodeId: "node-proof-v2",
      kind: "task",
      state: "manual-required",
      attempt: 1,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: "ccc-permanent:CCC_CAMPAIGN_PROOF_DISPATCH_UNKNOWN",
      blockedReason: "ccc-permanent:CCC_CAMPAIGN_PROOF_DISPATCH_UNKNOWN",
    };
    const proofAttempt = {
      attemptKey,
      attemptContractVersion: "v2",
      phase: "final_integrated",
      importId: "import-v2",
      campaignId: "campaign-v2",
      taskId: "FN-v2",
      semanticTaskId: "TASK-v2",
      proofId: "PROOF-v2",
      packetHash: "a".repeat(64),
      sidecarHash: "b".repeat(64),
      bundleHash: "c".repeat(64),
      manifestHash: "d".repeat(64),
      campaignBindingHash: "e".repeat(64),
      targetRepository: "/tmp/product-target-v2",
      targetBase: "f".repeat(40),
      sourceCommit: "1".repeat(40),
      sourceTree: "2".repeat(40),
      definitionSha256: "3".repeat(64),
      commandSha256: "4".repeat(64),
      workItemId: workItem.id,
      runId: workItem.runId,
      workItemAttempt: workItem.attempt,
      state: "dispatched_unknown",
      result: null,
    };
    const status = {
      schema: "ccc-prd.product-status.v1",
      projectId: "project-v2",
      import: {
        importId: "import-v2",
        idempotencyKey: "operator-key-v2",
        packetHash: "a".repeat(64),
        sidecarHash: "b".repeat(64),
        bundleHash: "c".repeat(64),
        targetRepository: "/tmp/product-target-v2",
        targetBase: "f".repeat(40),
      },
      tasks: [],
      workItems: [workItem],
      proofs: [{
        definition: { schema: "ccc-prd.proof.v2", id: "PROOF-v2" },
        definitionSha256: "3".repeat(64),
        attempts: [proofAttempt],
      }],
      orphanProofAttempts: [],
      approvals: [],
      landing: { intents: [], materializations: [], terminals: [] },
    };
    const settleAttempt = vi.fn();
    const output: string[] = [];

    expect(await runPrdJson(
      ["resolve-proof", "operator-key-v2", attemptKey, evidencePath],
      { write: (line) => output.push(line) },
      {
        resolveProject: vi.fn(async () => ({
          projectId: "project-v2",
          projectPath: "/tmp/product-target-v2",
          projectName: "Fixture v2",
          isRegistered: true,
          store: { getAsyncLayer: () => ({}) },
        })),
        closeProjectStore: vi.fn(async () => undefined),
        inspectCccPrdProductStatus: vi.fn(async () => status),
        settleCccCampaignProofAttempt: settleAttempt,
      },
      { projectName: "fixture-v2" },
    )).toBe(1);
    expect(JSON.parse(output[0]!)).toMatchObject({
      kind: "refusal",
      diagnostics: [{ code: "CCC_PRD_PROOF_RESOLUTION_V2_REFUSED" }],
    });
    expect(settleAttempt).not.toHaveBeenCalled();
  });

  async function exerciseNonCliProviderResolution(
    parkedState: "manual-required" | "failed",
  ): Promise<void> {
    const attemptKey = `ccc-provider-attempt-${"a".repeat(64)}`;
    const controllerToken =
      "ccc-provider-controller-00000000-0000-4000-8000-000000000001";
    const evidenceDigest = "7".repeat(64);
    const workItemFence = {
      workItemId: "work-item-1",
      runId: "ccc-prd:import-1",
      attempt: 2,
    } as const;
    const binding = {
      projectId: "project-1",
      importId: "import-1",
      campaignId: "campaign-1",
      taskId: "FN-1",
      actionId: "ACTION-1",
      actionTarget: "provider://fixture/FN-1",
      idempotencyKey: "operator-key",
      packetHash: "a".repeat(64),
      sidecarHash: "b".repeat(64),
      bundleHash: "c".repeat(64),
      targetRepository: "/tmp/product-target",
      targetBase: "d".repeat(40),
      providerId: "fixture-provider",
      modelId: "fixture-model",
      transport: "pi",
      manifestHash: "e".repeat(64),
      bindingHash: "f".repeat(64),
    } as const;
    const providerAttempt = {
      attemptKey,
      taskId: "FN-1",
      semanticTaskId: "TASK-1",
      campaignDeadlineAt: "2026-07-31T01:00:00.000Z",
      turnKey: "turn-1",
      dispatchKey: "dispatch-1",
      attemptOrdinal: 1,
      requestCount: 1,
      workItemFence,
      state: "dispatched_unknown",
      binding,
    } as const;
    const workItem = {
      id: workItemFence.workItemId,
      runId: workItemFence.runId,
      taskId: "FN-1",
      nodeId: "node-provider",
      kind: "task",
      state: parkedState,
      attempt: workItemFence.attempt,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: parkedState === "failed"
        ? "workflow-node-error:node-provider:workflow step timed out after 900000ms"
        : "ccc-permanent:CCC_PROVIDER_DISPATCH_UNKNOWN",
      blockedReason: parkedState === "failed"
        ? null
        : "ccc-permanent:CCC_PROVIDER_DISPATCH_UNKNOWN",
      stableWorkflowRunId: "ccc-prd:import-1",
    };
    const before = {
      schema: "ccc-prd.product-status.v1",
      projectId: "project-1",
      import: {
        importId: "import-1",
        idempotencyKey: "operator-key",
        packetHash: binding.packetHash,
        sidecarHash: binding.sidecarHash,
        bundleHash: binding.bundleHash,
        targetRepository: binding.targetRepository,
        targetBase: binding.targetBase,
        campaignId: binding.campaignId,
        state: "active",
        runnable: true,
      },
      tasks: [
        {
          semanticTaskId: "TASK-entry",
          nativeTaskId: "FN-entry",
          present: true,
          route: {
            providerId: "entry-provider",
            modelId: "entry-model",
            transport: "pi",
          },
        },
        {
          semanticTaskId: "TASK-1",
          nativeTaskId: "FN-1",
          present: true,
          route: {
            providerId: binding.providerId,
            modelId: binding.modelId,
            transport: binding.transport,
          },
        },
      ],
      workItems: [workItem],
      proofs: [],
      orphanProofAttempts: [],
      providerAttempts: [providerAttempt],
      approvals: [],
      landing: { intents: [], terminals: [] },
      nextAction: {
        kind: "resolve-manual-required",
        reason: "Provider effect is uncertain.",
      },
    };
    const after = {
      ...before,
      workItems: [{
        ...workItem,
        state: parkedState === "manual-required" ? "runnable" : "failed",
        lastError: parkedState === "manual-required" ? null : workItem.lastError,
        blockedReason: parkedState === "manual-required" ? null : workItem.blockedReason,
      }],
      providerAttempts: [{
        ...providerAttempt,
        state: "committed",
        terminal: {
          kind: "reconciled",
          state: "committed",
          evidenceDigest,
          observerId: "operator-local-1",
        },
      }],
      nextAction: { kind: "wait-for-runtime", reason: "Ready." },
    };
    const inspectAttempt = vi.fn(async () => ({
      ...providerAttempt,
      controllerToken,
    }));
    const settleAttempt = vi.fn(async () => ({
      ...after.providerAttempts[0],
      controllerToken,
    }));
    const transitionWorkflowWorkItem = vi.fn(async () => after.workItems[0]);
    const layer = {};
    const context = {
      projectId: "project-1",
      projectPath: "/tmp/product-target",
      projectName: "Fixture",
      isRegistered: true,
      store: {
        getAsyncLayer: () => layer,
        inspectCccProviderAttempt: inspectAttempt,
        settleCccProviderAttemptAndApproval: settleAttempt,
        transitionWorkflowWorkItem,
      },
    };
    const inspectStatus = vi.fn()
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(after);
    const previewOutput: string[] = [];

    expect(await runPrdJson(
      [
        "resolve-provider",
        "operator-key",
        attemptKey,
        "committed",
        "operator-local-1",
        evidenceDigest,
      ],
      { write: (line) => previewOutput.push(line) },
      {
        resolveProject: vi.fn(async () => context),
        closeProjectStore: vi.fn(async () => undefined),
        inspectCccPrdProductStatus: inspectStatus,
      },
      { projectName: "fixture" },
    )).toBe(0);
    const preview = JSON.parse(previewOutput[0]!);
    expect(preview).toMatchObject({
      kind: "provider-resolution-preview",
      attemptKey,
      outcome: "committed",
      consequence: expect.stringContaining(
        parkedState === "manual-required" ? "requeue" : "terminal failed",
      ),
      confirmation: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(inspectAttempt).not.toHaveBeenCalled();
    expect(settleAttempt).not.toHaveBeenCalled();
    expect(transitionWorkflowWorkItem).not.toHaveBeenCalled();

    const settleOutput: string[] = [];
    expect(await runPrdJson(
      [
        "resolve-provider",
        "operator-key",
        attemptKey,
        "committed",
        "operator-local-1",
        evidenceDigest,
        "--confirm",
        preview.confirmation,
      ],
      { write: (line) => settleOutput.push(line) },
      {
        resolveProject: vi.fn(async () => context),
        closeProjectStore: vi.fn(async () => undefined),
        inspectCccPrdProductStatus: inspectStatus,
      },
      { projectName: "fixture" },
    )).toBe(0);
    expect(inspectAttempt).toHaveBeenCalledWith({
      taskId: "FN-1",
      attemptKey,
    });
    expect(settleAttempt).toHaveBeenCalledWith(expect.objectContaining({
      attemptKey,
      controllerToken,
      outcome: "committed",
      evidenceDigest,
      observerId: "operator-local-1",
    }));
    if (parkedState === "manual-required") {
      expect(transitionWorkflowWorkItem).toHaveBeenCalledWith(
        workItem.id,
        "runnable",
        {
          expectedState: "manual-required",
          expectedAttempt: workItem.attempt,
          expectedLeaseOwner: null,
          attempt: workItem.attempt,
          leaseOwner: null,
          leaseExpiresAt: null,
          retryAfter: null,
          lastError: null,
          blockedReason: null,
        },
      );
    } else {
      expect(transitionWorkflowWorkItem).not.toHaveBeenCalled();
    }
    expect(JSON.parse(settleOutput[0]!)).toMatchObject({
      kind: "provider-resolved",
      attempt: { attemptKey, state: "committed" },
      status: {
        workItems: [expect.objectContaining({
          state: parkedState === "manual-required" ? "runnable" : "failed",
        })],
      },
    });
    expect(settleOutput[0]).not.toContain("controllerToken");
    expect(settleOutput[0]).not.toContain(controllerToken);

    const cliStatus = {
      ...before,
      tasks: [{
        ...before.tasks[0],
      }, {
        ...before.tasks[1],
        route: { ...before.tasks[1].route, transport: "cli" },
      }],
      providerAttempts: [{
        ...providerAttempt,
        binding: { ...binding, transport: "cli" },
      }],
    };
    const cliOutput: string[] = [];
    expect(await runPrdJson(
      [
        "resolve-provider",
        "operator-key",
        attemptKey,
        "committed",
        "operator-local-1",
        evidenceDigest,
      ],
      { write: (line) => cliOutput.push(line) },
      {
        resolveProject: vi.fn(async () => context),
        closeProjectStore: vi.fn(async () => undefined),
        inspectCccPrdProductStatus: vi.fn(async () => cliStatus),
      },
      { projectName: "fixture" },
    )).toBe(1);
    expect(JSON.parse(cliOutput[0]!)).toMatchObject({
      kind: "refusal",
      diagnostics: [{
        code: "CCC_PRD_PROVIDER_RESOLUTION_CLI_FENCE_REQUIRED",
        message: expect.stringMatching(/native CLI.*recovery/i),
      }],
      safeState: expect.stringContaining("inspect"),
      decisionOwner: "human operator",
      consequence: expect.stringContaining("not complete"),
      approvalExpiresAt: null,
      recoveryOptions: expect.arrayContaining([
        expect.stringContaining("status"),
        expect.stringContaining("stop"),
      ]),
      nextSafeAction: expect.stringContaining("fn prd status"),
    });
  }

  it.each(["manual-required", "failed"] as const)(
    "previews and settles one non-CLI provider effect from an unleased %s boundary while routing CLI recovery to its native fence",
    exerciseNonCliProviderResolution,
  );

  it("claims exact merge approval, lands, and settles only its parked imported work item", async () => {
    const confirmation = "9".repeat(64);
    const approval = {
      id: "approval-1",
      status: "issued",
      taskId: "TASK-terminal",
      runId: "RUN-product",
      requester: {
        actorId: "ccc-campaign-runtime",
        actorType: "agent",
        actorName: "CCC Campaign Runtime",
      },
      targetAction: {
        category: "git_write",
        action: "ACTION-merge",
        summary: "Merge",
        resourceType: "ccc-campaign-merge",
        resourceId: "refs/heads/main",
        context: {
          protectedActionKind: "merge",
          operatorDecision: "approve_merge",
        },
      },
      requestedAt: "2026-07-31T00:00:00.000Z",
      createdAt: "2026-07-31T00:00:00.000Z",
      updatedAt: "2026-07-31T00:00:00.000Z",
      campaign: {
        binding: {
          projectId: "project-1",
          importId: "import-1",
          campaignId: "campaign-1",
          taskId: "TASK-terminal",
          actionId: "ACTION-merge",
          actionTarget: "refs/heads/main",
          idempotencyKey: "operator-key",
          packetHash: "a".repeat(64),
          sidecarHash: "b".repeat(64),
          bundleHash: "c".repeat(64),
          targetRepository: "/tmp/product-target",
          targetBase: "d".repeat(40),
          providerId: "fixture",
          modelId: "fixture-v2",
          transport: "pi",
          manifestHash: "e".repeat(64),
          bindingHash: "f".repeat(64),
        },
        notBeforeAt: "2026-07-31T00:00:00.000Z",
        expiresAt: "2026-07-31T01:00:00.000Z",
      },
    };
    const workItem = {
      id: "work-item-1",
      runId: "ccc-prd:import-1",
      taskId: "TASK-entry",
      nodeId: "node-entry",
      kind: "task",
      state: "manual-required",
      attempt: 3,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: "ccc-permanent:CCC_CAMPAIGN_MERGE_APPROVAL_REQUIRED",
      blockedReason: "ccc-permanent:CCC_CAMPAIGN_MERGE_APPROVAL_REQUIRED",
      stableWorkflowRunId: "ccc-prd:import-1",
    };
    const before = {
      schema: "ccc-prd.product-status.v1",
      projectId: "project-1",
      import: {
        importId: "import-1",
        idempotencyKey: "operator-key",
        targetRepository: "/tmp/product-target",
        targetBase: "d".repeat(40),
        state: "active",
        runnable: true,
      },
      tasks: [],
      workItems: [workItem],
      proofs: [],
      orphanProofAttempts: [],
      approvals: [approval],
      landing: { intents: [], terminals: [] },
      nextAction: { kind: "approve-merge", reason: "Approve exact merge." },
    };
    const after = {
      ...before,
      workItems: [{ ...workItem, state: "succeeded", lastError: null, blockedReason: null }],
      landing: { intents: [{}], terminals: [{}] },
      nextAction: { kind: "complete", reason: "Campaign landed." },
    };
    const transitionWorkflowWorkItem = vi.fn(async () => after.workItems[0]);
    const layer = {};
    const context = {
      projectId: "project-1",
      projectPath: "/tmp/product-target",
      projectName: "Fixture",
      isRegistered: true,
      store: {
        getAsyncLayer: () => layer,
        transitionWorkflowWorkItem,
      },
    };
    const inspectStatus = vi.fn()
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(after);
    const approveMerge = vi.fn(async () => ({
      merged: true,
      noOp: false,
      reason: "ccc-campaign-native-git-landed",
      campaignControlled: { kind: "ccc-campaign-controlled" },
    }));
    const output: string[] = [];

    expect(await runPrdJson(
      ["approve-merge", "operator-key", "approval-1", "--confirm", confirmation],
      { write: (line) => output.push(line) },
      {
        resolveProject: vi.fn(async () => context),
        closeProjectStore: vi.fn(async () => undefined),
        inspectCccPrdProductStatus: inspectStatus,
        computeCccCampaignMergeApprovalConfirmation: vi.fn(() => confirmation),
        approveCccCampaignMerge: approveMerge,
      },
      { projectName: "fixture" },
    )).toBe(0);

    expect(approveMerge).toHaveBeenCalledWith(expect.objectContaining({
      store: context.store,
      rootDir: context.projectPath,
      taskId: "TASK-terminal",
      approvalRequestId: "approval-1",
      confirmation,
      actor: {
        actorId: "ccc-fusion-local-operator",
        actorType: "user",
        actorName: "CCC Fusion Local Operator",
      },
    }));
    expect(transitionWorkflowWorkItem).toHaveBeenCalledWith(
      "work-item-1",
      "succeeded",
      {
        expectedState: "manual-required",
        expectedAttempt: 3,
        attempt: 3,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: null,
        blockedReason: null,
      },
    );
    expect(JSON.parse(output[0]!)).toMatchObject({
      kind: "merge-approved",
      approvalRequestId: "approval-1",
      result: { merged: true, noOp: false },
      status: { nextAction: { kind: "complete" } },
    });
  });

  it("claims one sealed execution authorization by parent ID and requeues the parked campaign", async () => {
    const confirmation = "8".repeat(64);
    const authorization = sealedExecutionAuthorization();
    const childApprovals = [
      diagnosticLiveApproval(authorization.members[0]!.approvalRequestId, "TASK-coding"),
      diagnosticLiveApproval(authorization.members[1]!.approvalRequestId, "TASK-review"),
    ];
    const workItem = {
      id: "work-item-1",
      runId: "ccc-prd:import-1",
      taskId: "TASK-coding",
      nodeId: "node-coding",
      kind: "task",
      state: "manual-required",
      attempt: 1,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: "ccc-permanent:CCC_CAMPAIGN_LIVE_EXECUTION_APPROVAL_REQUIRED",
      blockedReason: "ccc-permanent:CCC_CAMPAIGN_LIVE_EXECUTION_APPROVAL_REQUIRED",
      stableWorkflowRunId: "ccc-prd:import-1",
    };
    const before = {
      schema: "ccc-prd.product-status.v1",
      observedAt: "2026-08-14T00:00:00.000Z",
      projectId: "project-1",
      import: {
        importId: "import-1",
        idempotencyKey: "operator-key",
        targetRepository: "/tmp/product-target",
        targetBase: "d".repeat(40),
        state: "active",
        runnable: true,
      },
      tasks: [],
      workItems: [workItem],
      proofs: [],
      orphanProofAttempts: [],
      providerAttempts: [],
      executionAuthorization: authorization,
      approvals: childApprovals,
      landing: { intents: [], materializations: [], terminals: [] },
      nextAction: {
        kind: "approve-execution",
        reason: "Approve the one sealed campaign launch.",
        executionAuthorizationId: authorization.authorizationId,
        executionAuthorizationStatus: "issued",
      },
    };
    const claimedAuthorization = sealedExecutionAuthorization("claimed");
    const after = {
      ...before,
      executionAuthorization: claimedAuthorization,
      workItems: [{
        ...workItem,
        state: "runnable",
        lastError: null,
        blockedReason: null,
      }],
      nextAction: {
        kind: "wait-for-runtime",
        reason: "Campaign work is admitted and ready for the runtime.",
      },
    };
    const transitionWorkflowWorkItem = vi.fn(async () => after.workItems[0]);
    const context = {
      projectId: "project-1",
      projectPath: "/tmp/product-target",
      projectName: "Fixture",
      isRegistered: true,
      store: {
        getAsyncLayer: () => ({}),
        transitionWorkflowWorkItem,
      },
    };
    const inspectStatus = vi.fn()
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(after);
    const approveExecution = vi.fn(async () => claimedAuthorization);
    const output: string[] = [];

    expect(await runPrdJson(
      ["approve-execution", "operator-key", authorization.authorizationId, "--confirm", confirmation],
      { write: (line) => output.push(line) },
      {
        resolveProject: vi.fn(async () => context),
        closeProjectStore: vi.fn(async () => undefined),
        inspectCccPrdProductStatus: inspectStatus,
        computeCccCampaignLiveExecutionApprovalConfirmation: vi.fn(() => confirmation),
        approveCccCampaignLiveExecution: approveExecution,
        inspectVerifierConfinementReadiness: vi.fn(async () => ({
          ready: true,
          backend: "sandbox-exec" as const,
          code: "VERIFIER_CONFINEMENT_READY",
          message: "verifier confinement readiness probe executed successfully",
          trustedPaths: ["/usr/bin/sandbox-exec"] as const,
        })),
      },
      { projectName: "fixture" },
    )).toBe(0);

    expect(approveExecution).toHaveBeenCalledWith({
      store: context.store,
      rootDir: context.projectPath,
      taskId: "TASK-coding",
      authorizationId: authorization.authorizationId,
      confirmation,
      actor: {
        actorId: "ccc-fusion-local-operator",
        actorType: "user",
        actorName: "CCC Fusion Local Operator",
      },
    });
    expect(transitionWorkflowWorkItem).toHaveBeenCalledTimes(1);
    expect(JSON.parse(output[0]!)).toMatchObject({
      kind: "execution-approved",
      executionAuthorizationId: authorization.authorizationId,
      approval: { status: "claimed" },
      status: { nextAction: { kind: "wait-for-runtime" } },
    });
    expect(JSON.parse(output[0]!)).not.toHaveProperty("approvalRequestId");
  });

  it("RED-W1-structural-digest: refuses a stale parent confirmation before preflight or claim", async () => {
    const currentConfirmation = "8".repeat(64);
    const staleConfirmation = "7".repeat(64);
    const authorization = sealedExecutionAuthorization();
    const workItem = {
      id: "work-item-1",
      runId: "ccc-prd:import-1",
      taskId: "TASK-coding",
      nodeId: "node-coding",
      kind: "task",
      state: "manual-required",
      attempt: 1,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: "ccc-permanent:CCC_CAMPAIGN_LIVE_EXECUTION_APPROVAL_REQUIRED",
      blockedReason: "ccc-permanent:CCC_CAMPAIGN_LIVE_EXECUTION_APPROVAL_REQUIRED",
      stableWorkflowRunId: "ccc-prd:import-1",
    };
    const approveExecution = vi.fn();
    const inspectReadiness = vi.fn();
    const output: string[] = [];

    expect(await runPrdJson(
      ["approve-execution", "operator-key", authorization.authorizationId, "--confirm", staleConfirmation],
      { write: (line) => output.push(line) },
      {
        resolveProject: vi.fn(async () => ({
          projectId: "project-1",
          projectPath: "/tmp/product-target",
          projectName: "Fixture",
          isRegistered: true,
          store: { getAsyncLayer: () => ({}) },
        })),
        closeProjectStore: vi.fn(async () => undefined),
        inspectCccPrdProductStatus: vi.fn(async () => ({
          schema: "ccc-prd.product-status.v1",
          observedAt: "2026-07-31T00:00:00.000Z",
          projectId: "project-1",
          import: {
            importId: "import-1",
            idempotencyKey: "operator-key",
            targetRepository: "/tmp/product-target",
            targetBase: "d".repeat(40),
            state: "active",
            runnable: true,
          },
          tasks: [],
          workItems: [workItem],
          proofs: [],
          orphanProofAttempts: [],
          providerAttempts: [],
          executionAuthorizationMode: "sealed_bundle_v1",
          executionAuthorization: authorization,
          approvals: [],
          landing: { intents: [], materializations: [], terminals: [] },
          nextAction: {
            kind: "approve-execution",
            reason: "Approve the one sealed campaign launch.",
            executionAuthorizationId: authorization.authorizationId,
            executionAuthorizationStatus: "issued",
          },
        })),
        computeCccCampaignLiveExecutionApprovalConfirmation: vi.fn(() => currentConfirmation),
        approveCccCampaignLiveExecution: approveExecution,
        inspectVerifierConfinementReadiness: inspectReadiness,
      },
      { projectName: "fixture" },
    )).toBe(1);

    expect(JSON.parse(output[0]!)).toMatchObject({
      kind: "refusal",
      diagnostics: [{
        code: "CCC_PRD_LIVE_EXECUTION_CONFIRMATION_REFUSED",
        message: expect.stringContaining("stale or does not match"),
      }],
    });
    expect(inspectReadiness).not.toHaveBeenCalled();
    expect(approveExecution).not.toHaveBeenCalled();
  });

  it("RED-R11-expired-parent-approve: refuses an expired parent before verifier preflight or engine claim", async () => {
    const confirmation = "8".repeat(64);
    const authorization = {
      ...sealedExecutionAuthorization(),
      expiresAt: "2000-01-01T00:00:00.000Z",
    };
    const workItem = {
      id: "work-item-1",
      runId: "ccc-prd:import-1",
      taskId: "TASK-coding",
      nodeId: "node-coding",
      kind: "task",
      state: "manual-required",
      attempt: 1,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: "ccc-permanent:CCC_CAMPAIGN_LIVE_EXECUTION_APPROVAL_REQUIRED",
      blockedReason: "ccc-permanent:CCC_CAMPAIGN_LIVE_EXECUTION_APPROVAL_REQUIRED",
      stableWorkflowRunId: "ccc-prd:import-1",
    };
    const approveExecution = vi.fn(async () => {
      throw new Error("expired authorization reached the engine");
    });
    const inspectReadiness = vi.fn(async () => ({
      ready: true,
      backend: "sandbox-exec" as const,
      code: "VERIFIER_CONFINEMENT_READY",
      message: "verifier confinement readiness probe executed successfully",
      trustedPaths: ["/usr/bin/sandbox-exec"] as const,
    }));
    const output: string[] = [];

    expect(await runPrdJson(
      ["approve-execution", "operator-key", authorization.authorizationId, "--confirm", confirmation],
      { write: (line) => output.push(line) },
      {
        resolveProject: vi.fn(async () => ({
          projectId: "project-1",
          projectPath: "/tmp/product-target",
          projectName: "Fixture",
          isRegistered: true,
          store: { getAsyncLayer: () => ({}) },
        })),
        closeProjectStore: vi.fn(async () => undefined),
        inspectCccPrdProductStatus: vi.fn(async () => ({
          schema: "ccc-prd.product-status.v1",
          projectId: "project-1",
          import: {
            importId: "import-1",
            idempotencyKey: "operator-key",
            targetRepository: "/tmp/product-target",
            targetBase: "d".repeat(40),
            state: "active",
            runnable: true,
          },
          tasks: [],
          workItems: [workItem],
          proofs: [],
          orphanProofAttempts: [],
          providerAttempts: [],
          executionAuthorizationMode: "sealed_bundle_v1",
          executionAuthorization: authorization,
          approvals: [],
          landing: { intents: [], materializations: [], terminals: [] },
          nextAction: {
            kind: "blocked",
            reason: "The sealed execution authorization expired.",
            diagnostic: "CCC_CAMPAIGN_LIVE_EXECUTION_AUTHORIZATION_EXPIRED",
          },
        })),
        computeCccCampaignLiveExecutionApprovalConfirmation: vi.fn(() => confirmation),
        approveCccCampaignLiveExecution: approveExecution,
        inspectVerifierConfinementReadiness: inspectReadiness,
      },
      { projectName: "fixture" },
    )).toBe(1);

    expect(JSON.parse(output[0]!)).toMatchObject({
      kind: "refusal",
      diagnostics: [{
        code: "CCC_PRD_LIVE_EXECUTION_AUTHORIZATION_EXPIRED",
        message: expect.stringContaining("fresh semantic-v2 import"),
      }],
    });
    expect(inspectReadiness).not.toHaveBeenCalled();
    expect(approveExecution).not.toHaveBeenCalled();
  });

  it("RED-R11-expired-claimed-parent: refuses an expired claimed parent after runtime requeue", async () => {
    const confirmation = "8".repeat(64);
    const authorization = {
      ...sealedExecutionAuthorization("claimed"),
      expiresAt: "2000-01-01T00:00:00.000Z",
    };
    const workItem = {
      id: "work-item-1",
      runId: "ccc-prd:import-1",
      taskId: "TASK-coding",
      nodeId: "node-coding",
      kind: "task",
      state: "runnable",
      attempt: 1,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: null,
      blockedReason: null,
      stableWorkflowRunId: "ccc-prd:import-1",
    };
    const approveExecution = vi.fn(async () => {
      throw new Error("expired claimed authorization reached the engine");
    });
    const inspectReadiness = vi.fn(async () => ({
      ready: true,
      backend: "sandbox-exec" as const,
      code: "VERIFIER_CONFINEMENT_READY",
      message: "verifier confinement readiness probe executed successfully",
      trustedPaths: ["/usr/bin/sandbox-exec"] as const,
    }));
    const output: string[] = [];

    expect(await runPrdJson(
      ["approve-execution", "operator-key", authorization.authorizationId, "--confirm", confirmation],
      { write: (line) => output.push(line) },
      {
        resolveProject: vi.fn(async () => ({
          projectId: "project-1",
          projectPath: "/tmp/product-target",
          projectName: "Fixture",
          isRegistered: true,
          store: { getAsyncLayer: () => ({}) },
        })),
        closeProjectStore: vi.fn(async () => undefined),
        inspectCccPrdProductStatus: vi.fn(async () => ({
          schema: "ccc-prd.product-status.v1",
          observedAt: "2026-08-14T14:30:00.000Z",
          projectId: "project-1",
          import: {
            importId: "import-1",
            idempotencyKey: "operator-key",
            targetRepository: "/tmp/product-target",
            targetBase: "d".repeat(40),
            state: "active",
            runnable: true,
          },
          tasks: [],
          workItems: [workItem],
          proofs: [],
          orphanProofAttempts: [],
          providerAttempts: [],
          executionAuthorizationMode: "sealed_bundle_v1",
          executionAuthorization: authorization,
          approvals: [],
          landing: { intents: [], materializations: [], terminals: [] },
          nextAction: {
            kind: "wait-for-runtime",
            reason: "Campaign work was already requeued.",
          },
        })),
        computeCccCampaignLiveExecutionApprovalConfirmation: vi.fn(() => confirmation),
        approveCccCampaignLiveExecution: approveExecution,
        inspectVerifierConfinementReadiness: inspectReadiness,
      },
      { projectName: "fixture" },
    )).toBe(1);

    expect(JSON.parse(output[0]!)).toMatchObject({
      kind: "refusal",
      diagnostics: [{
        code: "CCC_PRD_LIVE_EXECUTION_AUTHORIZATION_EXPIRED",
        message: expect.stringContaining("fresh semantic-v2 import"),
      }],
    });
    expect(inspectReadiness).not.toHaveBeenCalled();
    expect(approveExecution).not.toHaveBeenCalled();
  });

  it("refuses a diagnostic child approval ID when a sealed parent authorization exists", async () => {
    const confirmation = "8".repeat(64);
    const authorization = sealedExecutionAuthorization();
    const childApproval = diagnosticLiveApproval(
      authorization.members[0]!.approvalRequestId,
      "TASK-coding",
    );
    const approveExecution = vi.fn();
    const output: string[] = [];

    expect(await runPrdJson(
      ["approve-execution", "operator-key", childApproval.id, "--confirm", confirmation],
      { write: (line) => output.push(line) },
      {
        resolveProject: vi.fn(async () => ({
          projectId: "project-1",
          projectPath: "/tmp/product-target",
          projectName: "Fixture",
          isRegistered: true,
          store: { getAsyncLayer: () => ({}) },
        })),
        closeProjectStore: vi.fn(async () => undefined),
        inspectCccPrdProductStatus: vi.fn(async () => ({
          schema: "ccc-prd.product-status.v1",
          projectId: "project-1",
          import: {
            importId: "import-1",
            idempotencyKey: "operator-key",
            targetRepository: "/tmp/product-target",
            targetBase: "d".repeat(40),
            state: "active",
            runnable: true,
          },
          tasks: [],
          workItems: [],
          proofs: [],
          orphanProofAttempts: [],
          providerAttempts: [],
          executionAuthorization: authorization,
          approvals: [childApproval],
          landing: { intents: [], materializations: [], terminals: [] },
          nextAction: {
            kind: "approve-execution",
            reason: "Approve the one sealed campaign launch.",
            executionAuthorizationId: authorization.authorizationId,
            executionAuthorizationStatus: "issued",
          },
        })),
        approveCccCampaignLiveExecution: approveExecution,
      },
      { projectName: "fixture" },
    )).toBe(1);

    expect(approveExecution).not.toHaveBeenCalled();
    expect(JSON.parse(output[0]!)).toMatchObject({
      kind: "refusal",
      diagnostics: [{
        code: "CCC_PRD_LIVE_EXECUTION_APPROVAL_MISSING",
        message: expect.stringContaining(authorization.members[0]!.approvalRequestId),
      }],
    });
  });

  it("keeps live-execution approval issued and work parked when verifier confinement is unavailable", async () => {
    const confirmation = "8".repeat(64);
    const approval = {
      id: "approval-live-1",
      status: "issued",
      taskId: "TASK-coding",
      runId: "RUN-product",
      requester: {
        actorId: "ccc-campaign-runtime",
        actorType: "agent",
        actorName: "CCC Campaign Runtime",
      },
      targetAction: {
        category: "command_execution",
        action: "ACTION-live",
        summary: "Run the admitted coding provider",
        resourceType: "ccc-campaign-live_execution",
        resourceId: "provider://fixture/TASK-coding",
        context: {
          protectedActionKind: "live_execution",
          operatorDecision: "approve_live_execution",
        },
      },
      requestedAt: "2026-07-31T00:00:00.000Z",
      createdAt: "2026-07-31T00:00:00.000Z",
      updatedAt: "2026-07-31T00:00:00.000Z",
      campaign: {
        binding: {
          projectId: "project-1",
          importId: "import-1",
          campaignId: "campaign-1",
          taskId: "TASK-coding",
          actionId: "ACTION-live",
          actionTarget: "provider://fixture/TASK-coding",
          idempotencyKey: "operator-key",
          packetHash: "a".repeat(64),
          sidecarHash: "b".repeat(64),
          bundleHash: "c".repeat(64),
          targetRepository: "/tmp/product-target",
          targetBase: "d".repeat(40),
          providerId: "fixture",
          modelId: "fixture-v2",
          transport: "cli",
          manifestHash: "e".repeat(64),
          bindingHash: "f".repeat(64),
        },
        notBeforeAt: "2026-07-31T00:00:00.000Z",
        expiresAt: "2026-07-31T01:00:00.000Z",
      },
    };
    const workItem = {
      id: "work-item-1",
      runId: "ccc-prd:import-1",
      taskId: "TASK-coding",
      nodeId: "node-coding",
      kind: "task",
      state: "manual-required",
      attempt: 1,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: "ccc-permanent:CCC_CAMPAIGN_LIVE_EXECUTION_APPROVAL_REQUIRED",
      blockedReason: "ccc-permanent:CCC_CAMPAIGN_LIVE_EXECUTION_APPROVAL_REQUIRED",
      stableWorkflowRunId: "ccc-prd:import-1",
    };
    const status = {
      schema: "ccc-prd.product-status.v1",
      projectId: "project-1",
      import: {
        importId: "import-1",
        idempotencyKey: "operator-key",
        targetRepository: "/tmp/product-target",
        targetBase: "d".repeat(40),
        state: "active",
        runnable: true,
      },
      tasks: [],
      workItems: [workItem],
      proofs: [],
      orphanProofAttempts: [],
      approvals: [approval],
      landing: { intents: [], terminals: [] },
      nextAction: {
        kind: "approve-execution",
        reason: "Approve exact live execution.",
      },
    };
    const transitionWorkflowWorkItem = vi.fn();
    const context = {
      projectId: "project-1",
      projectPath: "/tmp/product-target",
      projectName: "Fixture",
      isRegistered: true,
      store: {
        getAsyncLayer: () => ({}),
        transitionWorkflowWorkItem,
      },
    };
    const approveExecution = vi.fn();
    const output: string[] = [];

    expect(await runPrdJson(
      ["approve-execution", "operator-key", "approval-live-1", "--confirm", confirmation],
      { write: (line) => output.push(line) },
      {
        resolveProject: vi.fn(async () => context),
        closeProjectStore: vi.fn(async () => undefined),
        inspectCccPrdProductStatus: vi.fn(async () => status),
        computeCccCampaignLiveExecutionApprovalConfirmation: vi.fn(() => confirmation),
        approveCccCampaignLiveExecution: approveExecution,
        inspectVerifierConfinementReadiness: vi.fn(async () => ({
          ready: true,
          backend: "native" as never,
          code: "VERIFIER_CONFINEMENT_INVALID_RESULT",
          message: "readiness result named an unadmitted backend",
          trustedPaths: [] as const,
          detail: "private runner detail must not reach operator output",
        })),
      },
      { projectName: "fixture" },
    )).toBe(1);

    const refusal = JSON.parse(output[0]!);
    expect(refusal).toMatchObject({
      kind: "refusal",
      diagnostics: [{
        code: "CCC_CAMPAIGN_VERIFIER_CONFINEMENT_UNAVAILABLE",
        message: "Exact requirement verification is unavailable: readiness result named an unadmitted backend",
      }],
      safeState: "Approval approval-live-1 remains issued and workflow work-item-1 remains manual-required; this command started no provider, source, or proof effect.",
      decisionOwner: "Fusion host or CI runner operator",
      consequence: "Live coding cannot start because Fusion could not prove exact requirement tests can run under enforced confinement.",
      approvalExpiresAt: "2026-07-31T01:00:00.000Z",
      recoveryOptions: [
        "Repair and functionally verify the trusted verifier confinement backend before this approval expires.",
        "If the approval expires, request a fresh exact live-execution approval after the host is ready.",
        "Stop the campaign with a fresh status digest if the operator does not want to continue.",
      ],
      nextSafeAction: "Repair verifier confinement, rerun fn prd status operator-key, then submit a still-current exact approval.",
    });
    expect(JSON.stringify(refusal.verifierConfinement)).not.toContain(
      "no campaign",
    );
    expect(output[0]).not.toContain("private runner detail");
    expect(approveExecution).not.toHaveBeenCalled();
    expect(transitionWorkflowWorkItem).not.toHaveBeenCalled();
  });

  it("claims exact live-execution approval and requeues only its parked imported work item", async () => {
    const confirmation = "8".repeat(64);
    const approval = {
      id: "approval-live-1",
      status: "issued",
      taskId: "TASK-coding",
      runId: "RUN-product",
      requester: {
        actorId: "ccc-campaign-runtime",
        actorType: "agent",
        actorName: "CCC Campaign Runtime",
      },
      targetAction: {
        category: "command_execution",
        action: "ACTION-live",
        summary: "Run the admitted coding provider",
        resourceType: "ccc-campaign-live_execution",
        resourceId: "provider://fixture/TASK-coding",
        context: {
          protectedActionKind: "live_execution",
          operatorDecision: "approve_live_execution",
        },
      },
      requestedAt: "2026-07-31T00:00:00.000Z",
      createdAt: "2026-07-31T00:00:00.000Z",
      updatedAt: "2026-07-31T00:00:00.000Z",
      campaign: {
        binding: {
          projectId: "project-1",
          importId: "import-1",
          campaignId: "campaign-1",
          taskId: "TASK-coding",
          actionId: "ACTION-live",
          actionTarget: "provider://fixture/TASK-coding",
          idempotencyKey: "operator-key",
          packetHash: "a".repeat(64),
          sidecarHash: "b".repeat(64),
          bundleHash: "c".repeat(64),
          targetRepository: "/tmp/product-target",
          targetBase: "d".repeat(40),
          providerId: "fixture",
          modelId: "fixture-v2",
          transport: "cli",
          manifestHash: "e".repeat(64),
          bindingHash: "f".repeat(64),
        },
        notBeforeAt: "2026-07-31T00:00:00.000Z",
        expiresAt: "2026-07-31T01:00:00.000Z",
      },
    };
    const workItem = {
      id: "work-item-1",
      runId: "ccc-prd:import-1",
      taskId: "TASK-coding",
      nodeId: "node-coding",
      kind: "task",
      state: "manual-required",
      attempt: 1,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: "ccc-permanent:CCC_CAMPAIGN_LIVE_EXECUTION_APPROVAL_REQUIRED",
      blockedReason: "ccc-permanent:CCC_CAMPAIGN_LIVE_EXECUTION_APPROVAL_REQUIRED",
      stableWorkflowRunId: "ccc-prd:import-1",
    };
    const before = {
      schema: "ccc-prd.product-status.v1",
      projectId: "project-1",
      import: {
        importId: "import-1",
        idempotencyKey: "operator-key",
        targetRepository: "/tmp/product-target",
        targetBase: "d".repeat(40),
        state: "active",
        runnable: true,
      },
      tasks: [],
      workItems: [workItem],
      proofs: [],
      orphanProofAttempts: [],
      approvals: [approval],
      landing: { intents: [], terminals: [] },
      nextAction: {
        kind: "approve-execution",
        reason: "Approve exact live execution.",
      },
    };
    const after = {
      ...before,
      workItems: [{
        ...workItem,
        state: "runnable",
        lastError: null,
        blockedReason: null,
      }],
      approvals: [{ ...approval, status: "claimed" }],
      nextAction: {
        kind: "wait-for-runtime",
        reason: "Campaign work is admitted and ready for the runtime.",
      },
    };
    const transitionWorkflowWorkItem = vi.fn(async () => after.workItems[0]);
    const layer = {};
    const context = {
      projectId: "project-1",
      projectPath: "/tmp/product-target",
      projectName: "Fixture",
      isRegistered: true,
      store: {
        getAsyncLayer: () => layer,
        transitionWorkflowWorkItem,
      },
    };
    const inspectStatus = vi.fn()
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(after);
    const approveExecution = vi.fn(async () => after.approvals[0]);
    const inspectVerifierConfinementReadiness = vi.fn(async () => ({
      ready: true,
      backend: "sandbox-exec" as const,
      code: "VERIFIER_CONFINEMENT_READY",
      message: "verifier confinement readiness probe executed successfully",
      trustedPaths: ["/usr/bin/sandbox-exec"] as const,
    }));
    const output: string[] = [];

    expect(await runPrdJson(
      ["approve-execution", "operator-key", "approval-live-1", "--confirm", confirmation],
      { write: (line) => output.push(line) },
      {
        resolveProject: vi.fn(async () => context),
        closeProjectStore: vi.fn(async () => undefined),
        inspectCccPrdProductStatus: inspectStatus,
        computeCccCampaignLiveExecutionApprovalConfirmation: vi.fn(() => confirmation),
        approveCccCampaignLiveExecution: approveExecution,
        inspectVerifierConfinementReadiness,
      },
      { projectName: "fixture" },
    )).toBe(0);

    expect(approveExecution).toHaveBeenCalledWith(expect.objectContaining({
      store: context.store,
      rootDir: context.projectPath,
      taskId: "TASK-coding",
      approvalRequestId: "approval-live-1",
      confirmation,
      actor: {
        actorId: "ccc-fusion-local-operator",
        actorType: "user",
        actorName: "CCC Fusion Local Operator",
      },
    }));
    expect(transitionWorkflowWorkItem).toHaveBeenCalledWith(
      "work-item-1",
      "runnable",
      {
        expectedState: "manual-required",
        expectedAttempt: 1,
        attempt: 1,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: null,
        blockedReason: null,
      },
    );
    expect(JSON.parse(output[0]!)).toMatchObject({
      kind: "execution-approved",
      approvalRequestId: "approval-live-1",
      approval: { status: "claimed" },
      status: { nextAction: { kind: "wait-for-runtime" } },
    });
    expect(inspectVerifierConfinementReadiness).toHaveBeenCalledTimes(1);
  });
});
