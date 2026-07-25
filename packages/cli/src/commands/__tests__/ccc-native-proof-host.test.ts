import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkflowExtensionRegistry } from "@fusion/core";
import { bootstrapCccCampaignProofAdmissionHost } from "../ccc-native-proof-host.js";

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
});
