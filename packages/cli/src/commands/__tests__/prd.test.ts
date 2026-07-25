import {
  WorkflowExtensionRegistry,
  deriveWorkflowExtensionHostProvenance,
} from "@fusion/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CCC_CAMPAIGN_PROOF_ADMISSION_CONTRIBUTION,
  CCC_CAMPAIGN_PROOF_ADMISSION_PLUGIN_ID,
} from "../../../../engine/src/ccc-campaign-proof-admission.js";
import { runPrdCommand } from "../prd.js";
import {
  cleanupPacketRoots,
  createPacketRoot,
} from "./prd-built-cli-fixture.js";

afterEach(cleanupPacketRoots);

describe("prd command exit contract", () => {
  it("returns usage exit 2 before any compiler or filesystem work", async () => {
    const output: string[] = [];
    expect(await runPrdCommand(["compile"], { write: (line) => output.push(line) })).toBe(2);
    expect(output).toEqual([
      [
        "usage: fn prd author <root-dir> <manifest-path> <sidecar-output> --target <repository> --base <40-hex-commit> --provider <provider> --model <model> --max-requests <n> --max-duration-ms <n> --max-concurrency <n> --max-prompt-bytes <n> --max-response-bytes <n> --max-review-items <n>",
        "       fn prd author <root-dir> <manifest-path> <proposal-path> <sidecar-output> (deterministic compatibility fixture)",
        "       fn prd <validate|compile> <root-dir> <manifest-path> <sidecar-path> <expected-target> <expected-base>",
      ].join("\n"),
    ]);
  });

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
});
