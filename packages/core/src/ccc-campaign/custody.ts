import {
  canonicalCccPrdJson,
  computeCccPrdSemanticBundleSha256,
} from "../ccc-prd/contract.js";
import {
  CCC_PRD_BUNDLE_V1_SCHEMA_VERSION,
  CCC_PRD_BUNDLE_V2_SCHEMA_VERSION,
  type CccPrdSemanticBundle,
} from "../ccc-prd/types.js";
import {
  createCccCampaignManifest,
  executionAuthorizationModeFromManifest,
  hashCccCampaignManifest,
  parseCccCampaignExecutionPolicy,
} from "./canonical.js";
import {
  CCC_CAMPAIGN_EXECUTION_AUTHORIZATION_MODE_SEALED_BUNDLE_V1,
  CCC_CAMPAIGN_MANIFEST_V1_SCHEMA_VERSION,
  CCC_CAMPAIGN_MANIFEST_V2_SCHEMA_VERSION,
  type CccCampaignExecutionAuthorizationMode,
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
  executionAuthorizationMode: CccCampaignExecutionAuthorizationMode;
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
    || (
      value.schema !== CCC_CAMPAIGN_MANIFEST_V1_SCHEMA_VERSION
      && value.schema !== CCC_CAMPAIGN_MANIFEST_V2_SCHEMA_VERSION
    )
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
  const manifest = value as CccCampaignManifest;
  try {
    executionAuthorizationModeFromManifest(manifest);
  } catch {
    throw new CccCampaignCustodyError(
      "campaign manifest schema and execution authorization mode disagree",
    );
  }
  return manifest;
}

function storedBundle(value: unknown): CccPrdSemanticBundle {
  if (
    !isRecord(value)
    || value.kind !== "bundle"
    || (
      value.schema !== CCC_PRD_BUNDLE_V1_SCHEMA_VERSION
      && value.schema !== CCC_PRD_BUNDLE_V2_SCHEMA_VERSION
    )
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
    const manifestInput = {
      projectId: row.projectId,
      importId: row.importId,
      idempotencyKey: row.idempotencyKey,
      campaignId: persistedManifest.campaignId,
      bundle,
      executionPolicy,
      targetRepositoryPath: row.targetRepository,
      campaignStartedAt: persistedManifest.campaignStartedAt,
    };
    const manifest = persistedManifest.schema === CCC_CAMPAIGN_MANIFEST_V2_SCHEMA_VERSION
      ? createCccCampaignManifest({
        ...manifestInput,
        manifestSchema: CCC_CAMPAIGN_MANIFEST_V2_SCHEMA_VERSION,
        executionAuthorizationMode:
          CCC_CAMPAIGN_EXECUTION_AUTHORIZATION_MODE_SEALED_BUNDLE_V1,
      })
      : createCccCampaignManifest({
        ...manifestInput,
        manifestSchema: CCC_CAMPAIGN_MANIFEST_V1_SCHEMA_VERSION,
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
    return {
      bundle,
      executionPolicy,
      manifest,
      manifestHash,
      executionAuthorizationMode: executionAuthorizationModeFromManifest(manifest),
    };
  } catch (error) {
    if (error instanceof CccCampaignCustodyError) throw error;
    throw new CccCampaignCustodyError(
      "campaign custody cannot reconstruct a canonical manifest",
    );
  }
}

/**
 * Whether a campaign's persisted custody can still be reconstructed.
 *
 * This is a read-only probe around the unchanged reconstruction above. It adds
 * no tolerance of its own: a campaign counts as drifted here only when
 * `reconstructCccCampaignCustody` refuses it, and the refusal message is
 * carried through verbatim so a terminal state can record why.
 *
 * It exists because refusal is the one state an operator cannot act on. Stop
 * needs a fresh status digest, status reconstructs custody, and custody
 * refuses, so a campaign whose manifest was written by a superseded copier can
 * neither run nor be closed. Callers may use this to reach a terminal state.
 * None may use it to admit work.
 */
export type CccCampaignCustodyDrift =
  | Readonly<{ drifted: false }>
  | Readonly<{ drifted: true; reason: string }>;

export function inspectCccCampaignCustodyDrift(
  row: CccCampaignCustodyRecord,
): CccCampaignCustodyDrift {
  try {
    reconstructCccCampaignCustody(row);
    return { drifted: false };
  } catch (error) {
    if (error instanceof CccCampaignCustodyError) {
      return { drifted: true, reason: error.message };
    }
    throw error;
  }
}
