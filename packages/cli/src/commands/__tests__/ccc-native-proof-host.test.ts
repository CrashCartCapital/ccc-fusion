import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WorkflowExtensionRegistry,
  CCC_PRD_PROOF_ADMISSION_SCHEMA_VERSION,
  computeCccPrdProofDefinitionSha256,
  deriveWorkflowExtensionHostProvenance,
} from "@fusion/core";
import {
  CCC_CAMPAIGN_PROOF_ADMISSION_CONTRIBUTION,
  CCC_CAMPAIGN_PROOF_ADMISSION_PLUGIN_ID,
  CCC_CAMPAIGN_PROOF_ADMISSION_PLUGIN_VERSION,
  CCC_CAMPAIGN_PROOF_ADMISSION_EXTENSION_ID,
  CCC_CAMPAIGN_PROOF_ADMISSION_PROOF_VERSION,
  CCC_CAMPAIGN_PROOF_ADMISSION_SELF_CHECK,
  createCccCampaignProofAdmissionEvaluatorInput,
} from "../../../../engine/src/ccc-campaign-proof-admission.js";
import { bootstrapCccCampaignProofAdmissionHost } from "../ccc-native-proof-host.js";
import { runPrdCommand } from "../prd.js";
import { createPacketRoot, repoRoot } from "./prd-built-cli-fixture.js";

const REGISTRY_ID = "plugin:fusion-native:ccc-proof-admission";
const ENTRY_FILE = "ccc-campaign-proof-admission.js";
const MANIFEST_FILE = "plugins/fusion-native-proof-admission/manifest.json";
const roots: string[] = [];
const sha256 = (bytes: Buffer | string) => (
  createHash("sha256").update(bytes).digest("hex")
);

function entrySource(marker: string): string {
  return [
    'export const CCC_CAMPAIGN_PROOF_ADMISSION_PLUGIN_ID = "fusion-native";',
    'export const CCC_CAMPAIGN_PROOF_ADMISSION_PLUGIN_VERSION = "1.0.0";',
    'export const CCC_CAMPAIGN_PROOF_ADMISSION_EXTENSION_ID = "ccc-proof-admission";',
    'export const CCC_CAMPAIGN_PROOF_ADMISSION_PROOF_VERSION = "ccc-proof-admission.v1";',
    'export const CCC_CAMPAIGN_PROOF_ADMISSION_REGISTRY_ID = "plugin:fusion-native:ccc-proof-admission";',
    "export const CCC_CAMPAIGN_PROOF_ADMISSION_CONTRIBUTION = Object.freeze({",
    '  extensionId: "ccc-proof-admission",',
    '  name: "CCC proof admission",',
    '  description: "Self-contained test entry",',
    '  kind: "proof-admission",',
    "  schemaVersion: 1,",
    '  fallback: "failClosed",',
    '  proofVersion: "ccc-proof-admission.v1",',
    `  evaluate: async (input) => Object.freeze({ outcome: "pass", evaluatedInputSha256: input.inputSha256, summary: "marker:${marker}" }),`,
    "});",
    "",
  ].join("\n");
}

function manifestBytes(): Buffer {
  return Buffer.from(`${JSON.stringify({
    schema: "ccc-fusion.native-proof-admission-manifest.v1",
    pluginId: "fusion-native",
    pluginVersion: "1.0.0",
    extensionId: "ccc-proof-admission",
    proofVersion: "ccc-proof-admission.v1",
    registryId: REGISTRY_ID,
    entry: ENTRY_FILE,
  }, null, 2)}\n`);
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("CCC native proof host bootstrap", () => {
  it("bootstraps the fixed native proof host before compatibility authoring", async () => {
    const packet = createPacketRoot();
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
    const bootstrapProofAdmission = vi.fn(async () => registry);
    const output: string[] = [];

    const exit = await runPrdCommand(
      ["author", packet.root, packet.manifest, packet.proposal, packet.sidecar],
      { write: (line) => output.push(line) },
      { bootstrapProofAdmission },
    );

    expect(exit, output.join("\n")).toBe(0);
    expect(bootstrapProofAdmission).toHaveBeenCalledTimes(1);
  });

  it("executes the exact custodied entry bytes instead of a stale path-cached module", async () => {
    const builtRootPath = mkdtempSync(join(tmpdir(), "ccc-native-proof-host-"));
    roots.push(builtRootPath);
    const entryPath = join(builtRootPath, ENTRY_FILE);
    const manifestPath = join(builtRootPath, MANIFEST_FILE);
    const manifest = manifestBytes();
    mkdirSync(dirname(manifestPath), { recursive: true });
    writeFileSync(manifestPath, manifest);

    const firstSource = entrySource("first");
    writeFileSync(entryPath, firstSource);
    const firstRegistry = await bootstrapCccCampaignProofAdmissionHost({
      builtRootPath,
      registry: new WorkflowExtensionRegistry(),
    });
    const firstDefinition = firstRegistry.get(REGISTRY_ID);
    expect(firstDefinition?.hostProvenance).toMatchObject({
      extensionSourceSha256: sha256(firstSource),
      extensionManifestSha256: sha256(manifest),
    });
    if (firstDefinition?.extension.kind !== "proof-admission") {
      throw new Error("first proof-admission extension was not registered");
    }
    expect((await firstDefinition.extension.evaluate({
      inputSha256: "first-input",
    } as never)).summary).toBe("marker:first");

    const secondSource = entrySource("second");
    writeFileSync(entryPath, secondSource);
    const secondRegistry = await bootstrapCccCampaignProofAdmissionHost({
      builtRootPath,
      registry: new WorkflowExtensionRegistry(),
    });
    const secondDefinition = secondRegistry.get(REGISTRY_ID);
    expect(secondDefinition?.hostProvenance).toMatchObject({
      extensionSourceSha256: sha256(secondSource),
      extensionManifestSha256: sha256(manifest),
    });
    if (secondDefinition?.extension.kind !== "proof-admission") {
      throw new Error("second proof-admission extension was not registered");
    }
    expect((await secondDefinition.extension.evaluate({
      inputSha256: "second-input",
    } as never)).summary).toBe("marker:second");
  });

  it("loads the actual built entry with only node crypto imports and confines its evaluator to conformance", async () => {
    const builtRootPath = join(repoRoot, "packages", "cli", "dist");
    const source = readFileSync(join(builtRootPath, ENTRY_FILE), "utf8");
    const staticImports = [...source.matchAll(/(?:from\s+|import\s*)["']([^"']+)["']/gu)]
      .map((match) => match[1]);
    expect(new Set(staticImports)).toEqual(
      new Set(["node:crypto"]),
    );
    expect(source).not.toMatch(/\bimport\s*\(/u);
    const registry = await bootstrapCccCampaignProofAdmissionHost({
      builtRootPath,
      registry: new WorkflowExtensionRegistry(),
    });
    const registered = registry.get(REGISTRY_ID);
    if (registered?.extension.kind !== "proof-admission") {
      throw new Error("built proof-admission extension was not registered");
    }
    const binding = registered.hostProvenance;
    if (!binding) throw new Error("built proof-admission host provenance was not registered");
    const definition = {
      id: "PROOF-CONFORMANCE",
      requirementIds: ["REQ-CONFORMANCE"],
      command: CCC_CAMPAIGN_PROOF_ADMISSION_SELF_CHECK.command,
      positiveOracle: CCC_CAMPAIGN_PROOF_ADMISSION_SELF_CHECK.positiveOracle,
      negativeControls: [...CCC_CAMPAIGN_PROOF_ADMISSION_SELF_CHECK.negativeControls],
      spans: [],
      confidence: "high" as const,
    };
    const proof = {
      ...definition,
      admission: {
        schema: CCC_PRD_PROOF_ADMISSION_SCHEMA_VERSION,
        pluginId: CCC_CAMPAIGN_PROOF_ADMISSION_PLUGIN_ID,
        pluginVersion: CCC_CAMPAIGN_PROOF_ADMISSION_PLUGIN_VERSION,
        extensionId: CCC_CAMPAIGN_PROOF_ADMISSION_EXTENSION_ID,
        proofVersion: CCC_CAMPAIGN_PROOF_ADMISSION_PROOF_VERSION,
        extensionRootRelativeSource: binding.extensionRootRelativeSource,
        extensionSourceSha256: binding.extensionSourceSha256,
        extensionManifestSha256: binding.extensionManifestSha256,
        definitionSha256: computeCccPrdProofDefinitionSha256(definition),
      },
    };
    const input = createCccCampaignProofAdmissionEvaluatorInput({
      campaignId: "campaign", importId: "import", bundleHash: "c".repeat(64), manifestHash: "d".repeat(64),
      taskId: "task", nodeId: "node", workItemId: "work", owner: "owner", attempt: 1,
      proofDefinitionSha256: computeCccPrdProofDefinitionSha256(proof), proof,
      signal: new AbortController().signal,
    });
    await expect(registered.extension.evaluate(input)).resolves.toMatchObject({ outcome: "pass" });
    const bizarreDefinition = {
      ...definition,
      command: "rm -rf /",
      positiveOracle: "the moon is cheese",
      negativeControls: ["unicorn returns purple"],
    };
    const bizarre = {
      ...bizarreDefinition,
      admission: {
        ...proof.admission,
        definitionSha256: computeCccPrdProofDefinitionSha256(bizarreDefinition),
      },
    };
    const bizarreInput = createCccCampaignProofAdmissionEvaluatorInput({
      ...input, proof: bizarre, proofDefinitionSha256: computeCccPrdProofDefinitionSha256(bizarre),
    });
    await expect(registered.extension.evaluate(bizarreInput)).resolves.toMatchObject({ outcome: "fail" });
  });
});
