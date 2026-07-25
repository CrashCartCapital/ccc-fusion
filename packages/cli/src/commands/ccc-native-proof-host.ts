import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  deriveWorkflowExtensionHostProvenance,
  getWorkflowExtensionRegistry,
  verifyWorkflowExtensionHostProvenance,
  type WorkflowExtensionRegistry,
  type WorkflowProofAdmissionExtensionContribution,
} from "@fusion/core";

const PLUGIN_ID = "fusion-native";
const PLUGIN_VERSION = "1.0.0";
const EXTENSION_ID = "ccc-proof-admission";
const PROOF_VERSION = "ccc-proof-admission.v1";
const REGISTRY_ID = "plugin:fusion-native:ccc-proof-admission";
const MANIFEST_SCHEMA = "ccc-fusion.native-proof-admission-manifest.v1";
const ENTRY_FILE = "ccc-campaign-proof-admission.js";
const MANIFEST_FILE = "plugins/fusion-native-proof-admission/manifest.json";
const MANIFEST_KEYS = [
  "schema",
  "pluginId",
  "pluginVersion",
  "extensionId",
  "proofVersion",
  "registryId",
  "entry",
] as const;

type FixedProofManifest = {
  schema: typeof MANIFEST_SCHEMA;
  pluginId: typeof PLUGIN_ID;
  pluginVersion: typeof PLUGIN_VERSION;
  extensionId: typeof EXTENSION_ID;
  proofVersion: typeof PROOF_VERSION;
  registryId: typeof REGISTRY_ID;
  entry: typeof ENTRY_FILE;
};

type FixedProofModule = {
  CCC_CAMPAIGN_PROOF_ADMISSION_PLUGIN_ID: string;
  CCC_CAMPAIGN_PROOF_ADMISSION_PLUGIN_VERSION: string;
  CCC_CAMPAIGN_PROOF_ADMISSION_EXTENSION_ID: string;
  CCC_CAMPAIGN_PROOF_ADMISSION_PROOF_VERSION: string;
  CCC_CAMPAIGN_PROOF_ADMISSION_REGISTRY_ID: string;
  CCC_CAMPAIGN_PROOF_ADMISSION_CONTRIBUTION:
  WorkflowProofAdmissionExtensionContribution;
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseFixedProofManifest(bytes: Buffer): FixedProofManifest {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("fixed proof-admission manifest is not valid JSON");
  }
  if (
    !isPlainRecord(value)
    || Object.keys(value).sort().join("\0") !== [...MANIFEST_KEYS].sort().join("\0")
    || value.schema !== MANIFEST_SCHEMA
    || value.pluginId !== PLUGIN_ID
    || value.pluginVersion !== PLUGIN_VERSION
    || value.extensionId !== EXTENSION_ID
    || value.proofVersion !== PROOF_VERSION
    || value.registryId !== REGISTRY_ID
    || value.entry !== ENTRY_FILE
  ) {
    throw new Error("fixed proof-admission manifest identity is inconsistent");
  }
  return value as FixedProofManifest;
}

function requireFixedProofModule(value: unknown): FixedProofModule {
  if (!isPlainRecord(value)) {
    throw new Error("fixed proof-admission entry did not export a module");
  }
  const module = value as Partial<FixedProofModule>;
  const contribution = module.CCC_CAMPAIGN_PROOF_ADMISSION_CONTRIBUTION;
  if (
    module.CCC_CAMPAIGN_PROOF_ADMISSION_PLUGIN_ID !== PLUGIN_ID
    || module.CCC_CAMPAIGN_PROOF_ADMISSION_PLUGIN_VERSION !== PLUGIN_VERSION
    || module.CCC_CAMPAIGN_PROOF_ADMISSION_EXTENSION_ID !== EXTENSION_ID
    || module.CCC_CAMPAIGN_PROOF_ADMISSION_PROOF_VERSION !== PROOF_VERSION
    || module.CCC_CAMPAIGN_PROOF_ADMISSION_REGISTRY_ID !== REGISTRY_ID
    || !contribution
    || contribution.kind !== "proof-admission"
    || contribution.extensionId !== EXTENSION_ID
    || contribution.proofVersion !== PROOF_VERSION
    || contribution.fallback !== "failClosed"
    || typeof contribution.evaluate !== "function"
  ) {
    throw new Error("fixed proof-admission entry identity is inconsistent");
  }
  return module as FixedProofModule;
}

export type BootstrapCccCampaignProofAdmissionHostInput = {
  builtRootPath?: string;
  registry?: WorkflowExtensionRegistry;
};

export async function bootstrapCccCampaignProofAdmissionHost(
  input: BootstrapCccCampaignProofAdmissionHostInput = {},
): Promise<WorkflowExtensionRegistry> {
  const builtRootPath = input.builtRootPath
    ?? dirname(fileURLToPath(import.meta.url));
  const manifestPath = join(builtRootPath, MANIFEST_FILE);
  const manifestBytes = await readFile(manifestPath);
  const manifest = parseFixedProofManifest(manifestBytes);
  const entryPath = join(builtRootPath, manifest.entry);
  const entryBytes = await readFile(entryPath);
  const expectedEntrySha256 = sha256(entryBytes);
  const expectedManifestSha256 = sha256(manifestBytes);
  const provenance = await deriveWorkflowExtensionHostProvenance({
    pluginId: manifest.pluginId,
    pluginVersion: manifest.pluginVersion,
    trustedRootPath: builtRootPath,
    entryRelativePath: manifest.entry,
    manifestRelativePath: MANIFEST_FILE,
  });
  const binding = await verifyWorkflowExtensionHostProvenance(provenance);
  if (
    binding.extensionRootRelativeSource !== manifest.entry
    || binding.extensionSourceSha256 !== expectedEntrySha256
    || binding.extensionManifestSha256 !== expectedManifestSha256
  ) {
    throw new Error(
      "fixed proof-admission entry or manifest changed between custody read and provenance binding",
    );
  }
  const sourceUrl = (
    `data:text/javascript;base64,${entryBytes.toString("base64")}`
    + `#sha256=${expectedEntrySha256}`
  );
  const loaded = requireFixedProofModule(await import(sourceUrl));
  const registry = input.registry ?? getWorkflowExtensionRegistry();
  registry.upsert(
    manifest.pluginId,
    loaded.CCC_CAMPAIGN_PROOF_ADMISSION_CONTRIBUTION,
    provenance,
  );
  const verifiedBinding = await registry.reverifyHostProvenance(manifest.registryId);
  if (
    verifiedBinding.extensionSourceSha256 !== expectedEntrySha256
    || verifiedBinding.extensionManifestSha256 !== expectedManifestSha256
  ) {
    throw new Error("fixed proof-admission host provenance changed after registration");
  }
  return registry;
}
