import { describe, expect, it } from "vitest";
import { createCccCampaignAuthorityBinding } from "../ccc-campaign/canonical.js";
import { CCC_CAMPAIGN_CONTEXT_SCHEMA_VERSION } from "../ccc-campaign/types.js";
import type { CccCampaignContext } from "../ccc-campaign/types.js";

function baseContext(): CccCampaignContext {
  return {
    schema: CCC_CAMPAIGN_CONTEXT_SCHEMA_VERSION,
    projectId: "PROJECT-hash-stability",
    importId: "IMPORT-hash-stability",
    idempotencyKey: "IDEMPOTENCY-hash-stability",
    campaignId: "CAMPAIGN-hash-stability",
    packetHash: "a".repeat(64),
    sidecarHash: "b".repeat(64),
    bundleHash: "c".repeat(64),
    sourceVersion: "phase-c-test",
    targetRepository: { path: "/tmp/ccc-fusion-hash-stability", baseCommit: "d".repeat(40) },
    bounds: { maxRequests: 1, maxDurationMs: 1_000, maxConcurrency: 1 },
    campaignStartedAt: "2026-01-01T00:00:00.000Z",
    campaignDeadlineAt: "2026-01-01T00:01:00.000Z",
    admittedWriteRoots: [{ path: "/tmp/ccc-fusion-hash-stability", purpose: "test" }],
    proofs: [],
    protectedActions: [],
    executionPolicy: { schema: "ccc-campaign.execution-policy.v1", routes: [] },
    taskId: "TASK-hash-stability",
    route: {
      taskId: "TASK-hash-stability",
      providerId: "deterministic-fake",
      modelId: "fixture-v1",
      transport: "pi",
    },
    manifestHash: "e".repeat(64),
    requestCount: 0,
    activeActionLeases: {},
  };
}

const action = { actionId: "ACTION-hash-stability", actionTarget: "target-hash-stability" };

describe("CCC campaign authority-binding hash stability (routing-contract v3 guard)", () => {
  /**
   * RED-A5 pinning test. bindingHash is computed today only from
   * AUTHORITY_BINDING_KEYS (identity fields plus requested providerId,
   * modelId, and transport) -- it never reads v3 routing-contract metadata
   * (routeProfileId, reasoningEffort, limits, etc.) because
   * requireAuthorityContext only projects those specific fields off
   * context.route. This test pins that behavior: it passes immediately
   * with no implementation change, and exists as a guard so a future
   * change that widens bindingHash inputs to include effective identity
   * or v3 metadata fails loudly here first.
   */
  it("keeps bindingHash identical when v3-shaped route metadata is attached to the context", () => {
    const withoutV3Metadata = baseContext();
    const withV3Metadata: CccCampaignContext = {
      ...withoutV3Metadata,
      route: {
        ...withoutV3Metadata.route,
        routeProfileId: "profile-x",
        taskArchetype: "refactor",
        reasoningEffort: "high",
        serviceTier: "priority",
        accessTier: "subscription",
        sensitivityClass: "sanitized",
        egressPolicy: { kind: "loopback-only" },
        limits: { maxRequests: 10, maxDurationMs: 60_000, maxConcurrency: 1 },
        fallbackPolicy: { kind: "forbidden" },
        catalogDigest: null,
        decidedAt: "2026-01-01T00:00:00.000Z",
      } as unknown as CccCampaignContext["route"],
    };

    const bindingWithout = createCccCampaignAuthorityBinding(withoutV3Metadata, action);
    const bindingWith = createCccCampaignAuthorityBinding(withV3Metadata, action);

    expect(bindingWith.bindingHash).toBe(bindingWithout.bindingHash);
    expect(bindingWith.providerId).toBe(bindingWithout.providerId);
    expect(bindingWith.modelId).toBe(bindingWithout.modelId);
  });

  it("still varies bindingHash with providerId (sanity check the hash is not vacuously constant)", () => {
    const contextA = baseContext();
    const contextB: CccCampaignContext = {
      ...contextA,
      route: { ...contextA.route, providerId: "a-different-provider" },
    };
    const bindingA = createCccCampaignAuthorityBinding(contextA, action);
    const bindingB = createCccCampaignAuthorityBinding(contextB, action);
    expect(bindingA.bindingHash).not.toBe(bindingB.bindingHash);
  });
});
