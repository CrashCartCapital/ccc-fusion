import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createCccPrdImportTestProductBundle,
  createCccPrdImportTestProductExecutionPolicy,
} from "../__test-utils__/ccc-prd-import-fixture.js";
import {
  createCccCampaignManifest,
  hashCccCampaignManifest,
} from "../ccc-campaign/canonical.js";
import {
  reconstructCccCampaignCustody,
  type CccCampaignCustodyRecord,
} from "../ccc-campaign/custody.js";
import type {
  CccCampaignExecutionPolicy,
  CccCampaignManifest,
} from "../ccc-campaign/types.js";

const targetRoot = "/tmp/ccc-fusion-manifest-v2";
const campaignStartedAt = "2026-08-12T12:00:00.000Z";

function fixture(suffix: string) {
  const bundle = createCccPrdImportTestProductBundle(targetRoot, suffix);
  const executionPolicy = createCccPrdImportTestProductExecutionPolicy(bundle);
  const input = {
    projectId: "PROJECT-manifest-v2",
    importId: `IMPORT-${suffix}`,
    idempotencyKey: `IDEMPOTENCY-${suffix}`,
    campaignId: `CAMPAIGN-${suffix}`,
    bundle,
    executionPolicy,
    targetRepositoryPath: targetRoot,
    campaignStartedAt,
  };
  return { bundle, executionPolicy, input };
}

function sealedManifest(
  input: ReturnType<typeof fixture>["input"],
): CccCampaignManifest {
  return createCccCampaignManifest({
    ...input,
    manifestSchema: "ccc-campaign.manifest.v2",
    executionAuthorizationMode: "sealed_bundle_v1",
  });
}

function custodyRecord(
  manifest: CccCampaignManifest,
  bundle: ReturnType<typeof fixture>["bundle"],
  executionPolicy: CccCampaignExecutionPolicy,
): CccCampaignCustodyRecord {
  const manifestHash = hashCccCampaignManifest(manifest);
  return {
    projectId: manifest.projectId,
    importId: manifest.importId,
    idempotencyKey: manifest.idempotencyKey,
    identityHash: manifestHash,
    bundleHash: bundle.bundleHash,
    packetHash: bundle.sourceHash,
    sidecarHash: bundle.sidecarHash,
    sourceVersion: bundle.sourceVersion,
    targetRepository: resolve(targetRoot),
    targetBase: bundle.targetRepository.baseCommit,
    canonicalBundle: bundle,
    executionPolicy,
    campaignManifest: manifest,
    campaignManifestHash: manifestHash,
    campaignStartedAt: manifest.campaignStartedAt,
    campaignDeadlineAt: manifest.campaignDeadlineAt,
  };
}

describe("CCC campaign manifest-v2 custody", () => {
  it("RED-S2-manifest-v2: seals aggregate authorization into manifest v2 and changes the manifest hash", () => {
    const { input } = fixture("version-hash");
    const legacy = createCccCampaignManifest(input);
    const sealed = sealedManifest(input);

    expect(legacy).toMatchObject({ schema: "ccc-campaign.manifest.v1" });
    expect(legacy).not.toHaveProperty("executionAuthorizationMode");
    expect(sealed).toMatchObject({
      schema: "ccc-campaign.manifest.v2",
      executionAuthorizationMode: "sealed_bundle_v1",
    });
    expect(hashCccCampaignManifest(sealed)).not.toBe(hashCccCampaignManifest(legacy));
  });

  it("RED-S2-manifest-v1: normalizes legacy policy-v2/manifest-v1 custody to per_task_v1 byte-identically", () => {
    const { bundle, executionPolicy, input } = fixture("legacy-normalization");
    const legacy = createCccCampaignManifest(input);
    const reconstructed = reconstructCccCampaignCustody(
      custodyRecord(legacy, bundle, executionPolicy),
    );

    expect(reconstructed.manifest).toEqual(legacy);
    expect(reconstructed.manifestHash).toBe(hashCccCampaignManifest(legacy));
    expect(reconstructed.executionAuthorizationMode).toBe("per_task_v1");
  });

  it("RED-S2-manifest-mode: requires sealed_bundle_v1 for manifest v2", () => {
    const { input } = fixture("mode-required");

    expect(() => createCccCampaignManifest({
      ...input,
      manifestSchema: "ccc-campaign.manifest.v2",
    } as unknown as Parameters<typeof createCccCampaignManifest>[0]))
      .toThrow(/manifest v2.*sealed_bundle_v1/i);
  });

  it("RED-S2-manifest-drift: refuses direct schema or authorization-mode mutation", () => {
    const { bundle, executionPolicy, input } = fixture("mode-drift");
    const legacy = createCccCampaignManifest(input);
    const sealed = sealedManifest(input);

    expect(() => reconstructCccCampaignCustody({
      ...custodyRecord(legacy, bundle, executionPolicy),
      campaignManifest: {
        ...legacy,
        schema: "ccc-campaign.manifest.v2",
        executionAuthorizationMode: "sealed_bundle_v1",
      },
    })).toThrow(/manifest|custody/i);
    expect(() => reconstructCccCampaignCustody({
      ...custodyRecord(sealed, bundle, executionPolicy),
      campaignManifest: {
        ...sealed,
        executionAuthorizationMode: "per_task_v1",
      },
    })).toThrow(/manifest|custody/i);
  });
});
