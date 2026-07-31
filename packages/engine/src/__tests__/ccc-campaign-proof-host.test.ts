import { describe, expect, it } from "vitest";
import { WorkflowExtensionRegistry } from "@fusion/core";
import { bootstrapCccCampaignProofAdmissionHost } from "../ccc-campaign-proof-host.js";

describe("CCC campaign proof host built-asset resolution", () => {
  it("boots the fixed emitted proof host without a caller-supplied path", async () => {
    const registry = new WorkflowExtensionRegistry();

    await expect(bootstrapCccCampaignProofAdmissionHost({ registry }))
      .resolves.toBe(registry);
    expect(registry.get("plugin:fusion-native:ccc-proof-admission"))
      .toMatchObject({
        extension: {
          kind: "proof-admission",
          extensionId: "ccc-proof-admission",
          fallback: "failClosed",
        },
      });
  });
});
