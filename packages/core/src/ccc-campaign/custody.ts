import {
  canonicalCccPrdJson,
  computeCccPrdSemanticBundleSha256,
} from "../ccc-prd/contract.js";
import {
  CCC_PRD_BUNDLE_SCHEMA_VERSION,
  type CccPrdSemanticBundle,
} from "../ccc-prd/types.js";
import {
  createCccCampaignManifest,
  hashCccCampaignManifest,
  parseCccCampaignExecutionPolicy,
} from "./canonical.js";
import {
  CCC_CAMPAIGN_MANIFEST_SCHEMA_VERSION,
  type CccCampaignExecutionPolicy,
  type CccCampaignManifest,
} from "./types.js";

export type CccCampaignCustodyRecord = {
  projectId: string;
  importId: string;
  idempotencyKey: string;
  identityHash: string;
  bundleHash: string;
  packetHash: string;
  sidecarHash: string;
  sourceVersion: string;
  targetRepository: string;
  targetBase: string;
  canonicalBundle: unknown;
  executionPolicy: unknown;
  campaignManifest: unknown;
  campaignManifestHash: string;
  campaignStartedAt: string;
  campaignDeadlineAt: string;
};

export type ReconstructedCccCampaignCustody = {
  bundle: CccPrdSemanticBundle;
  executionPolicy: CccCampaignExecutionPolicy;
  manifest: CccCampaignManifest;
  manifestHash: string;
};

export class CccCampaignCustodyError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CccCampaignCustodyError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function storedManifest(value: unknown): CccCampaignManifest {
  if (
    !isRecord(value)
    || value.schema !== CCC_CAMPAIGN_MANIFEST_SCHEMA_VERSION
    || typeof value.campaignId !== "string"
    || value.campaignId.length === 0
    || !isRecord(value.targetRepository)
    || typeof value.targetRepository.path !== "string"
    || typeof value.targetRepository.baseCommit !== "string"
    || typeof value.campaignStartedAt !== "string"
    || typeof value.campaignDeadlineAt !== "string"
  ) {
    throw new CccCampaignCustodyError("missing admitted campaign manifest");
  }
  return value as CccCampaignManifest;
}

function storedBundle(value: unknown): CccPrdSemanticBundle {
  if (
    !isRecord(value)
    || value.kind !== "bundle"
    || value.schema !== CCC_PRD_BUNDLE_SCHEMA_VERSION
    || !Array.isArray(value.tasks)
    || !Array.isArray(value.proofs)
    || !Array.isArray(value.protectedActions)
    || !Array.isArray(value.admittedWriteRoots)
    || !isRecord(value.targetRepository)
    || !isRecord(value.bounds)
  ) {
    throw new CccCampaignCustodyError("missing admitted semantic bundle");
  }
  return value as CccPrdSemanticBundle;
}

export function reconstructCccCampaignCustody(
  row: CccCampaignCustodyRecord,
): ReconstructedCccCampaignCustody {
  try {
    const persistedManifest = storedManifest(row.campaignManifest);
    const bundle = storedBundle(row.canonicalBundle);
    const computedBundleHash = computeCccPrdSemanticBundleSha256(bundle);
    const executionPolicy = parseCccCampaignExecutionPolicy(
      row.executionPolicy,
      bundle,
    );
    const manifest = createCccCampaignManifest({
      projectId: row.projectId,
      importId: row.importId,
      idempotencyKey: row.idempotencyKey,
      campaignId: persistedManifest.campaignId,
      bundle,
      executionPolicy,
      targetRepositoryPath: row.targetRepository,
      campaignStartedAt: persistedManifest.campaignStartedAt,
    });
    const manifestHash = hashCccCampaignManifest(manifest);
    if (
      canonicalCccPrdJson(persistedManifest) !== canonicalCccPrdJson(manifest)
      || row.campaignManifestHash !== manifestHash
      || row.identityHash !== manifestHash
      || computedBundleHash !== bundle.bundleHash
      || row.bundleHash !== bundle.bundleHash
      || row.packetHash !== bundle.sourceHash
      || row.sidecarHash !== bundle.sidecarHash
      || row.sourceVersion !== bundle.sourceVersion
      || row.targetRepository !== manifest.targetRepository.path
      || row.targetBase !== bundle.targetRepository.baseCommit
      || row.campaignStartedAt !== manifest.campaignStartedAt
      || row.campaignDeadlineAt !== manifest.campaignDeadlineAt
    ) {
      throw new CccCampaignCustodyError("campaign manifest drift");
    }
    return { bundle, executionPolicy, manifest, manifestHash };
  } catch (error) {
    if (error instanceof CccCampaignCustodyError) throw error;
    throw new CccCampaignCustodyError(
      "campaign custody cannot reconstruct a canonical manifest",
    );
  }
}
