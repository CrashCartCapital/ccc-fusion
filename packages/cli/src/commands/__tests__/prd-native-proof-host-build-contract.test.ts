import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./prd-built-cli-fixture.js";

describe("CCC native proof host build contract", () => {
  it("emits a dedicated self-contained proof entry and stages its exact manifest", () => {
    const config = readFileSync(
      join(repoRoot, "packages", "cli", "tsup.config.ts"),
      "utf8",
    );
    const packageFiles = (
      JSON.parse(readFileSync(
        join(repoRoot, "packages", "cli", "package.json"),
        "utf8",
      )) as { files?: string[] }
    ).files;

    expect(packageFiles).toContain("dist/plugins/**");
    expect(config).toContain(
      '"ccc-campaign-proof-admission": "../engine/src/ccc-campaign-proof-admission.ts"',
    );
    expect(config).toContain(
      'const cccCampaignProofAdmissionManifestSrc = join(__dirname, "..", "engine", "src", "ccc-campaign-proof-admission.manifest.json")',
    );
    expect(config).toContain(
      'const cccProofAdmissionCoreRuntimeShim = join(__dirname, "src", "ccc-proof-admission-core-runtime-shim.mjs")',
    );
    expect(config).toContain(
      'const cccCampaignProofAdmissionManifestDest = join(__dirname, "dist", "plugins", "fusion-native-proof-admission")',
    );
    const cliConfig = config.slice(
      config.indexOf("const cliBuildConfig = {"),
      config.indexOf("const cccProofAdmissionBuildConfig = {"),
    );
    const proofConfig = config.slice(
      config.indexOf("const cccProofAdmissionBuildConfig = {"),
      config.indexOf("const pluginSdkBuildConfig = {"),
    );
    expect(cliConfig).not.toContain(
      '"ccc-campaign-proof-admission": "../engine/src/ccc-campaign-proof-admission.ts"',
    );
    expect(proofConfig).toContain(
      '"ccc-campaign-proof-admission": "../engine/src/ccc-campaign-proof-admission.ts"',
    );
    expect(proofConfig).toContain("cpSync(");
    expect(proofConfig).toContain("cccCampaignProofAdmissionManifestSrc");
    expect(proofConfig).toContain("cccCampaignProofAdmissionManifestDest");
    expect(proofConfig).toContain(
      '"@fusion/core": cccProofAdmissionCoreRuntimeShim',
    );
    expect(proofConfig).toContain(
      'join(cccCampaignProofAdmissionManifestDest, "manifest.json")',
    );
    expect(proofConfig).not.toContain("banner:");
    expect(config).toMatch(
      /defineConfig\(\[\s*cliBuildConfig,\s*cccProofAdmissionBuildConfig,\s*pluginSdkBuildConfig,\s*\]\)/u,
    );
  });
});
