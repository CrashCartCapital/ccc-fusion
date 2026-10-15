/*
FNXC:CccPrdImportPreflight 2026-10-14-18:44:
Card B3 (CONTRACT-v3.3 W6, D18, ADR B Q2 T2.1). `fn prd preview|import` and the planning import bridge share one import preflight, `packages/engine/src/ccc-prd/product-import-preflight.ts`. These tests prove the extraction keeps the CLI's identity and refusal order:
- parity: for one packet, execution plan and project, `fn prd preview --json` and `preflightCccPrdProductTarget` give the same confirmation digest, and both equal the sha256 of an identity this file derives on its own from the compiled bundle, so the comparison cannot pass by both sides calling one broken function;
- an injected verifier-conformance failure refuses before any identity or digest exists, in the shared preflight and through the CLI (preview and import, with the importer never called); a conforming verifier admits the same packet (positive control);
- HEAD drift, the missing semantic-proof sandbox and the preview-only v1 refusal keep their CLI order.

The packet comes from the CLI's own fixture (`prd-built-cli-fixture.ts`) and is authored and planned through the CLI, so both sides read the same bytes. Proof admission uses a test registry rooted at the packet (as ccc-prd-multi-task-graph-admission.test.ts does), so no built CLI or engine dist is needed. Readiness, custody and conformance are injected, so the file runs on any platform without a sandbox, a database or the network.

The `@fusion/engine` mock below adds the shared preflight to the engine barrel the CLI reads it from. The barrels are parent-owned (D34), so until the parent exports `./ccc-prd/product-import-preflight.js` from `packages/engine/src/ccc-prd/index.ts`, the CLI side of this file can only reach the module through this overlay. After that export lands the overlay adds nothing (same module, same functions) and can be dropped.
*/
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  WorkflowExtensionRegistry,
  canonicalCccPrdJson,
  deriveWorkflowExtensionHostProvenance,
  parseCccPrdProductExecutionPlan,
  type AsyncDataLayer,
} from "@fusion/core";
import {
  CCC_CAMPAIGN_PROOF_ADMISSION_CONTRIBUTION,
  CCC_CAMPAIGN_PROOF_ADMISSION_PLUGIN_ID,
} from "../ccc-campaign-proof-admission.js";
import { CccPrdProofVerifierNonconformingError } from "../ccc-campaign-proof-execution.js";
import { compileCccPrdPacket } from "../ccc-prd/compiler.js";
import {
  preflightCccPrdProductPacket,
  preflightCccPrdProductTarget,
  type CccPrdProductImportPreflightDependencies,
  type CccPrdProductPacketPreflight,
} from "../ccc-prd/product-import-preflight.js";
import { runPrdCommand } from "../../../cli/src/commands/prd.js";
import {
  cleanupPacketRoots,
  createPacketRoot,
} from "../../../cli/src/commands/__tests__/prd-built-cli-fixture.js";

vi.mock("@fusion/engine", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...(await import("../ccc-prd/product-import-preflight.js")),
}));

type Packet = ReturnType<typeof createPacketRoot>;

const PROJECT_ID = "project-1";

const readyConfinement = {
  ready: true,
  backend: "sandbox-exec" as const,
  code: "VERIFIER_CONFINEMENT_READY",
  message: "test confinement is ready",
  trustedPaths: ["/usr/bin/sandbox-exec"] as const,
  detail: "test-injected ready confinement",
};

const readySandbox = {
  ready: true,
  backend: "sandbox-exec" as const,
  code: "CCC_SEMANTIC_PROOF_SANDBOX_READY",
  message: "test semantic-proof sandbox is ready",
  trustedPaths: ["/usr/bin/sandbox-exec"] as const,
};

const missingSandbox = {
  ready: false,
  backend: null,
  code: "CCC_SEMANTIC_PROOF_SANDBOX_UNSUPPORTED_PLATFORM",
  message: "test semantic-proof sandbox is missing",
  trustedPaths: [] as const,
};

async function proofAdmissionRegistry(packet: Packet): Promise<WorkflowExtensionRegistry> {
  const registry = new WorkflowExtensionRegistry();
  registry.register(
    CCC_CAMPAIGN_PROOF_ADMISSION_PLUGIN_ID,
    CCC_CAMPAIGN_PROOF_ADMISSION_CONTRIBUTION,
    await deriveWorkflowExtensionHostProvenance({
      pluginId: CCC_CAMPAIGN_PROOF_ADMISSION_PLUGIN_ID,
      pluginVersion: "1.0.0",
      trustedRootPath: packet.root,
      entryRelativePath: "packet.md",
      manifestRelativePath: "manifest.json",
    }),
  );
  return registry;
}

async function runCli(
  args: string[],
  dependencies: Parameters<typeof runPrdCommand>[2] = {},
): Promise<{ exit: number; lines: string[] }> {
  const lines: string[] = [];
  const exit = await runPrdCommand(args, { write: (line) => lines.push(line) }, dependencies);
  return { exit, lines };
}

async function authorPacket(packet: Packet): Promise<void> {
  const authored = await runCli(
    ["author", packet.root, packet.manifest, packet.proposal, packet.sidecar],
    {
      bootstrapProofAdmission: () => proofAdmissionRegistry(packet),
      ...(packet.semanticProofToolchainPaths
        ? { resolveSemanticProofToolchainPaths: () => packet.semanticProofToolchainPaths! }
        : {}),
    },
  );
  expect(authored.exit, authored.lines.join("\n")).toBe(0);
}

async function planPacket(packet: Packet): Promise<string> {
  const planPath = join(packet.root, "execution-plan.json");
  const planned = await runCli([
    "policy", packet.root, packet.manifest, packet.sidecar, packet.target, packet.base, planPath,
    "--provider", "deterministic-fake", "--model", "fixture-v2", "--transport", "pi",
  ]);
  expect(planned.exit, planned.lines.join("\n")).toBe(0);
  return planPath;
}

type Overrides = Readonly<{
  readTargetHead?: (targetRoot: string) => Promise<string>;
  sandbox?: typeof readySandbox | typeof missingSandbox;
  conformance?: () => Promise<void>;
}>;

function fakes(packet: Packet, overrides: Overrides = {}) {
  return {
    readTargetHead: vi.fn(overrides.readTargetHead ?? (async () => packet.base)),
    resolveSemanticProofToolchainPaths: vi.fn(() => packet.semanticProofToolchainPaths!),
    inspectVerifierConfinementReadiness: vi.fn(async () => readyConfinement),
    inspectSemanticProofSandboxReadiness: vi.fn(async () => overrides.sandbox ?? readySandbox),
    assertSemanticProofV2Custody: vi.fn(async () => undefined),
    assertSemanticProofVerifierConformance: vi.fn(overrides.conformance ?? (async () => undefined)),
  };
}

function cliDependencies(packet: Packet, f: ReturnType<typeof fakes>) {
  return {
    ...f,
    resolveProject: vi.fn(async () => ({
      projectId: PROJECT_ID,
      projectPath: resolve(packet.target),
      projectName: "Fixture",
      isRegistered: true,
      store: { getAsyncLayer: () => ({}) },
    })),
    closeProjectStore: vi.fn(async () => undefined),
    importCccPrdBundle: vi.fn(async () => {
      throw new Error("the importer must not be reached in these tests");
    }),
  } as unknown as Parameters<typeof runPrdCommand>[2];
}

function packetInput(
  packet: Packet,
  planPath: string,
  mode: "preview" | "import",
  executionPlan: unknown = JSON.parse(readFileSync(planPath, "utf8")),
) {
  return {
    mode,
    packet: { rootDir: packet.root, manifestPath: packet.manifest, sidecarPath: packet.sidecar },
    expectedTarget: packet.target,
    expectedBase: packet.base,
    executionPlan,
    requestFloor: mode === "preview" ? "check" as const : "importer" as const,
  };
}

function project(packet: Packet) {
  return { projectId: PROJECT_ID, projectPath: resolve(packet.target), layer: {} as AsyncDataLayer };
}

function admittedPacket(result: CccPrdProductPacketPreflight) {
  expect(result.kind, JSON.stringify(result)).toBe("packet_admitted");
  return result as Extract<CccPrdProductPacketPreflight, { kind: "packet_admitted" }>;
}

describe("shared CCC PRD product import preflight (card B3)", () => {
  let packet: Packet;
  let planPath: string;

  beforeAll(async () => {
    packet = createPacketRoot({ semanticV2: true });
    await authorPacket(packet);
    planPath = await planPacket(packet);
  });

  afterAll(cleanupPacketRoots);

  function previewArgs(): string[] {
    return ["preview", packet.root, packet.manifest, packet.sidecar, planPath, packet.target, packet.base, "--json"];
  }

  it("fn prd preview --json and preflightCccPrdProductTarget give one confirmation digest for one packet, plan and project, equal to the digest of an independently derived identity", async () => {
    const cliFakes = fakes(packet);
    const cli = await runCli(previewArgs(), cliDependencies(packet, cliFakes));
    expect(cli.exit, cli.lines.join("\n")).toBe(0);
    const preview = JSON.parse(cli.lines[0]!) as { kind: string; confirmationDigest: string };
    expect(preview.kind).toBe("preview");

    const deps: CccPrdProductImportPreflightDependencies = fakes(packet);
    const admitted = admittedPacket(await preflightCccPrdProductPacket(packetInput(packet, planPath, "preview"), deps));
    const target = await preflightCccPrdProductTarget(admitted, project(packet), { mode: "preview" }, deps);

    // The oracle: the identity rebuilt here from the compiled bundle and the parsed plan, never from either side's output.
    const bundle = compileCccPrdPacket({
      rootDir: packet.root,
      manifestPath: packet.manifest,
      sidecarPath: packet.sidecar,
      expectedTarget: packet.target,
      expectedBase: packet.base,
      requireMaterialCoverage: true,
    });
    if (bundle.kind === "refusal") throw new Error(JSON.stringify(bundle.diagnostics));
    const identity = {
      schema: "ccc-prd.product-preview.v1",
      projectId: PROJECT_ID,
      projectPath: resolve(packet.target),
      bundleHash: bundle.bundleHash,
      packetHash: bundle.sourceHash,
      sidecarHash: bundle.sidecarHash,
      targetRepository: resolve(bundle.targetRepository.path),
      targetBase: packet.base,
      targetHead: packet.base,
      executionPolicy: parseCccPrdProductExecutionPlan(JSON.parse(readFileSync(planPath, "utf8")), bundle).policy,
    };
    const expectedDigest = createHash("sha256").update(canonicalCccPrdJson(identity), "utf8").digest("hex");

    expect(target.kind, JSON.stringify(target)).toBe("admitted");
    if (target.kind !== "admitted") return;
    expect(target.confirmationDigest).toBe(preview.confirmationDigest);
    expect(target.confirmationDigest).toBe(expectedDigest);
    expect(target.identity).toEqual(identity);
    expect(preview).toMatchObject({ ...identity, confirmationDigest: expectedDigest });
    expect(target.targetHead).toBe(packet.base);
    expect(target.verifierConformanceChecked).toBe(true);
    expect(target.importBlocker).toBeUndefined();
  });

  it("an injected verifier-conformance failure refuses before identity in the shared preflight and in fn prd preview and import; a conforming verifier admits the same packet", async () => {
    const nonconforming = async () => {
      throw new CccPrdProofVerifierNonconformingError("PF-CLI-001 verifier printed no proof evidence");
    };

    const deps = fakes(packet, { conformance: nonconforming });
    const admitted = admittedPacket(await preflightCccPrdProductPacket(packetInput(packet, planPath, "import"), deps));
    const refused = await preflightCccPrdProductTarget(
      admitted,
      project(packet),
      { mode: "import", idempotencyKey: "operator-key" },
      deps,
    );
    expect(refused).toEqual({
      kind: "product_refusal",
      code: "CCC_PRD_PROOF_VERIFIER_NONCONFORMING",
      message: "PF-CLI-001 verifier printed no proof evidence",
    });
    expect(refused).not.toHaveProperty("identity");
    expect(refused).not.toHaveProperty("confirmationDigest");
    // The HEAD and custody checks ran first, then conformance on the exact frozen base.
    expect(deps.readTargetHead).toHaveBeenCalledWith(resolve(packet.target));
    expect(deps.assertSemanticProofV2Custody).toHaveBeenCalledTimes(1);
    expect(deps.assertSemanticProofVerifierConformance).toHaveBeenCalledTimes(1);
    expect(deps.assertSemanticProofVerifierConformance).toHaveBeenCalledWith(expect.objectContaining({
      repositoryRoot: resolve(packet.target),
      baseCommit: packet.base,
      modelWriteRoots: ["src/task-1", "src/task-1"],
    }));
    expect(deps.assertSemanticProofV2Custody.mock.invocationCallOrder[0]!)
      .toBeLessThan(deps.assertSemanticProofVerifierConformance.mock.invocationCallOrder[0]!);

    // The CLI refuses with the same code, prints no preview, and never reaches the importer.
    const cliPreview = await runCli(previewArgs(), cliDependencies(packet, fakes(packet, { conformance: nonconforming })));
    expect(cliPreview.exit).toBe(1);
    expect(JSON.parse(cliPreview.lines[0]!)).toMatchObject({
      kind: "refusal",
      diagnostics: [{ code: "CCC_PRD_PROOF_VERIFIER_NONCONFORMING" }],
    });
    const importDependencies = cliDependencies(packet, fakes(packet, { conformance: nonconforming })) as {
      importCccPrdBundle: ReturnType<typeof vi.fn>;
    };
    const cliImport = await runCli([
      "import", packet.root, packet.manifest, packet.sidecar, planPath, packet.target, packet.base,
      "operator-key", "--confirm", "1".repeat(64), "--json",
    ], importDependencies as Parameters<typeof runPrdCommand>[2]);
    expect(cliImport.exit).toBe(1);
    expect(JSON.parse(cliImport.lines[0]!)).toMatchObject({
      kind: "refusal",
      diagnostics: [{ code: "CCC_PRD_PROOF_VERIFIER_NONCONFORMING" }],
    });
    expect(importDependencies.importCccPrdBundle).not.toHaveBeenCalled();

    // Positive control: the same packet with a conforming verifier is admitted with a digest.
    const control = fakes(packet);
    const controlAdmitted = admittedPacket(await preflightCccPrdProductPacket(packetInput(packet, planPath, "import"), control));
    const admittedTarget = await preflightCccPrdProductTarget(
      controlAdmitted,
      project(packet),
      { mode: "import", idempotencyKey: "operator-key" },
      control,
    );
    expect(admittedTarget).toMatchObject({ kind: "admitted", verifierConformanceChecked: true });
    expect(admittedTarget).toHaveProperty("confirmationDigest", expect.stringMatching(/^[0-9a-f]{64}$/u));
  });

  it("a target HEAD that is not the frozen base refuses CCC_PRD_TARGET_HEAD_DRIFT before custody or conformance runs", async () => {
    const drifted = "b".repeat(40);
    const deps = fakes(packet, { readTargetHead: async () => drifted });
    const admitted = admittedPacket(await preflightCccPrdProductPacket(packetInput(packet, planPath, "import"), deps));
    const refused = await preflightCccPrdProductTarget(
      admitted,
      project(packet),
      { mode: "import", idempotencyKey: "operator-key" },
      deps,
    );
    expect(refused).toEqual({
      kind: "product_refusal",
      code: "CCC_PRD_TARGET_HEAD_DRIFT",
      message: `target HEAD ${drifted} does not match frozen base ${packet.base}`,
    });
    expect(deps.assertSemanticProofV2Custody).not.toHaveBeenCalled();
    expect(deps.assertSemanticProofVerifierConformance).not.toHaveBeenCalled();
  });

  it("without the semantic-proof sandbox the conformance check is skipped and reported, import carries the sandbox blocker, and the digest is unchanged", async () => {
    const ready = fakes(packet);
    const readyTarget = await preflightCccPrdProductTarget(
      admittedPacket(await preflightCccPrdProductPacket(packetInput(packet, planPath, "import"), ready)),
      project(packet),
      { mode: "import", idempotencyKey: "operator-key" },
      ready,
    );
    const missing = fakes(packet, { sandbox: missingSandbox });
    const missingAdmitted = admittedPacket(await preflightCccPrdProductPacket(packetInput(packet, planPath, "import"), missing));
    expect(missingAdmitted.semanticProofSandboxReadiness).toEqual(missingSandbox);
    const missingTarget = await preflightCccPrdProductTarget(
      missingAdmitted,
      project(packet),
      { mode: "import", idempotencyKey: "operator-key" },
      missing,
    );
    expect(missingTarget).toMatchObject({
      kind: "admitted",
      verifierConformanceChecked: false,
      importBlocker: { kind: "semantic_proof_sandbox_unavailable", readiness: missingSandbox },
    });
    expect(missing.assertSemanticProofV2Custody).toHaveBeenCalledTimes(1);
    expect(missing.assertSemanticProofVerifierConformance).not.toHaveBeenCalled();
    expect(readyTarget.kind).toBe("admitted");
    expect(missingTarget).toHaveProperty(
      "confirmationDigest",
      (readyTarget as { confirmationDigest: string }).confirmationDigest,
    );
  });

  it("a v1 bundle in preview mode refuses CCC_PRD_PRODUCT_SEMANTIC_V2_REQUIRED before the execution plan is read or the toolchain is resolved", async () => {
    const legacy = createPacketRoot();
    await authorPacket(legacy);
    const readPlan = vi.fn(() => {
      throw new Error("the execution plan must not be read");
    });
    const deps = fakes(legacy);
    const refused = await preflightCccPrdProductPacket({
      mode: "preview",
      packet: { rootDir: legacy.root, manifestPath: legacy.manifest, sidecarPath: legacy.sidecar },
      expectedTarget: legacy.target,
      expectedBase: legacy.base,
      executionPlan: readPlan,
      requestFloor: "check",
    }, deps);
    expect(refused).toEqual({
      kind: "product_refusal",
      code: "CCC_PRD_PRODUCT_SEMANTIC_V2_REQUIRED",
      message: "Fresh CCC PRD product campaigns require a controller-admitted semantic bundle v2; v1 remains inspection and exact-replay only",
    });
    expect(readPlan).not.toHaveBeenCalled();
    expect(deps.resolveSemanticProofToolchainPaths).not.toHaveBeenCalled();
    expect(deps.inspectVerifierConfinementReadiness).not.toHaveBeenCalled();
  });
});
