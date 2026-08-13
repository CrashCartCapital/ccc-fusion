import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createPacketRoot,
  repoRoot,
} from "./prd-built-cli-fixture.js";

describe("CCC native proof host build contract", () => {
  it("emits a dedicated self-contained proof entry and stages its exact manifest", () => {
    const config = readFileSync(
      join(repoRoot, "packages", "cli", "tsup.config.ts"),
      "utf8",
    );
    const proofCoreShim = readFileSync(
      join(repoRoot, "packages", "cli", "src", "ccc-proof-admission-core-runtime-shim.mjs"),
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
      '"ccc-campaign-proof-admission": "ccc-semantic-proof-host.mjs"',
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
      '"ccc-campaign-proof-admission": "ccc-semantic-proof-host.mjs"',
    );
    expect(proofConfig).toContain(
      '"ccc-campaign-proof-admission": "ccc-semantic-proof-host.mjs"',
    );
    expect(proofConfig).toContain("cpSync(");
    expect(proofConfig).toContain("cccCampaignProofAdmissionManifestSrc");
    expect(proofConfig).toContain("cccCampaignProofAdmissionManifestDest");
    expect(proofConfig).toContain(
      '"@fusion/core": cccProofAdmissionCoreRuntimeShim',
    );
    expect(proofCoreShim).toContain("CCC_PRD_PROOF_V2_SCHEMA_VERSION");
    expect(proofConfig).toContain(
      'join(cccCampaignProofAdmissionManifestDest, "manifest.json")',
    );
    expect(proofConfig).toContain(
      "chmodSync(cccCampaignProofAdmissionEntryDest, 0o755)",
    );
    expect(proofConfig).not.toContain("banner:");
    expect(config).toContain("function selectCliTsupConfigs");
    expect(config).toContain('case "cli":');
    expect(config).toContain('case "proof-admission":');
    expect(config).toContain('case "plugin-sdk":');
    expect(config).toMatch(/default:\s*\{\s*throw new Error/u);
    expect(config).toContain("export default defineConfig(selectCliTsupConfigs());");
    expect(config).not.toMatch(
      /defineConfig\(\[\s*cliBuildConfig,\s*cccProofAdmissionBuildConfig,\s*pluginSdkBuildConfig,\s*\]\)/u,
    );
  });

  it("cannot author successfully when the built proof entry and manifest are absent", () => {
    const packet = createPacketRoot();
    const isolatedRoot = mkdtempSync(join(tmpdir(), "ccc-prd-built-host-missing-"));
    try {
      const isolatedBin = join(isolatedRoot, "bin.js");
      copyFileSync(join(repoRoot, "packages/cli/dist/bin.js"), isolatedBin);
      symlinkSync(
        join(repoRoot, "packages/cli/node_modules"),
        join(isolatedRoot, "node_modules"),
        "dir",
      );
      const result = spawnSync(process.execPath, [
        isolatedBin,
        "prd",
        "author",
        packet.root,
        packet.manifest,
        packet.proposal,
        packet.sidecar,
      ], {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, CI: "1", FUSION_SKIP_ONBOARDING: "1" },
      });
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("CCC_PRD_PROOF_ADMISSION_BOOTSTRAP_FAILED");
      expect(existsSync(packet.sidecar)).toBe(false);
    } finally {
      rmSync(isolatedRoot, { recursive: true, force: true });
    }
  });
});
