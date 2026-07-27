import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupPacketRoots,
  createPacketRoot,
  repoRoot,
  runFn,
} from "./prd-built-cli-fixture.js";

afterEach(cleanupPacketRoots);
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

describe("prd built CLI user contract", () => {
  it("advertises author, validate, and compile from top-level help", () => {
    const result = runFn(["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("fn prd author <root-dir> <manifest-path> <sidecar-output> --target <repository> --base <40-hex-commit> --provider <provider> --model <model>");
    expect(result.stdout).toContain("fn prd author <root-dir> <manifest-path> <proposal-path> <sidecar-output>");
    expect(result.stdout).toContain("fn prd validate <root-dir> <manifest-path> <sidecar-path> <expected-target> <expected-base>");
    expect(result.stdout).toContain("fn prd compile <root-dir> <manifest-path> <sidecar-path> <expected-target> <expected-base>");
  });

  it("author writes the requested sidecar and validate/compile are zero-store user commands", () => {
    const packet = createPacketRoot();
    const tempPrefix = join(packet.root, ".fusion-prd-tmp");
    const author = runFn(["prd", "author", packet.root, packet.manifest, packet.proposal, packet.sidecar]);
    expect(author.status, `${author.stdout}\n${author.stderr}`).toBe(0);
    expect(existsSync(packet.sidecar)).toBe(true);
    const sidecar = JSON.parse(readFileSync(packet.sidecar, "utf8")) as {
      proofs: Array<{ admission?: Record<string, unknown> }>;
    };
    expect(sidecar.proofs[0]?.admission).toMatchObject({
      schema: "ccc-prd.proof-admission.v1",
      pluginId: "fusion-native",
      pluginVersion: "1.0.0",
      extensionId: "ccc-proof-admission",
      proofVersion: "ccc-proof-admission.v1",
      extensionRootRelativeSource: "ccc-campaign-proof-admission.js",
      extensionSourceSha256: sha256(readFileSync(join(
        repoRoot,
        "packages/cli/dist/ccc-campaign-proof-admission.js",
      ))),
      extensionManifestSha256: sha256(readFileSync(join(
        repoRoot,
        "packages/cli/dist/plugins/fusion-native-proof-admission/manifest.json",
      ))),
    });
    const validate = runFn(["prd", "validate", packet.root, packet.manifest, packet.sidecar, packet.target, packet.base]);
    expect(validate.status).toBe(0);
    expect(JSON.parse(validate.stdout)).toMatchObject({ kind: "diagnostics" });
    expect(JSON.parse(validate.stdout)).not.toHaveProperty("requirements");
    const compile = runFn(["prd", "compile", packet.root, packet.manifest, packet.sidecar, packet.target, packet.base]);
    expect(compile.status).toBe(0);
    expect(JSON.parse(compile.stdout)).toMatchObject({ kind: "bundle" });
    expect(JSON.parse(compile.stdout)).toHaveProperty("requirements");
    expect(existsSync(tempPrefix)).toBe(false);
    expect(readFileSync(join(packet.root, "packet.md"), "utf8")).toContain("Dense PRD Packet");
  });

  it("returns stable usage and semantic-refusal exit codes", () => {
    const usage = runFn(["prd", "compile"]);
    expect(usage.status, `${usage.stdout}\n${usage.stderr}`).toBe(2);
    const packet = createPacketRoot();
    const semantic = runFn(["prd", "validate", packet.root, packet.manifest, join(packet.root, "missing.sidecar.json"), packet.target, packet.base]);
    expect(semantic.status).toBe(1);
    expect(semantic.stdout).toContain("CCC_PRD_UNDECLARED_COMPANION");
  });

  it("refuses a foreign admitted target through built validate and compile", () => {
    const packet = createPacketRoot();
    expect(runFn(["prd", "author", packet.root, packet.manifest, packet.proposal, packet.sidecar]).status).toBe(0);
    for (const command of ["validate", "compile"]) {
      const result = runFn(["prd", command, packet.root, packet.manifest, packet.sidecar, "foreign/repo", packet.base]);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("CCC_PRD_FOREIGN_TARGET");
    }
  });

  it("refuses a foreign admitted base through built validate and compile", () => {
    const packet = createPacketRoot();
    expect(runFn(["prd", "author", packet.root, packet.manifest, packet.proposal, packet.sidecar]).status).toBe(0);
    for (const command of ["validate", "compile"]) {
      const result = runFn(["prd", command, packet.root, packet.manifest, packet.sidecar, packet.target, "b".repeat(40)]);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("CCC_PRD_FOREIGN_BASE");
    }
  });

  it.each(["packet.md", "manifest.json"])("refuses author output that would overwrite admitted %s bytes", (relativeOutput) => {
    const packet = createPacketRoot();
    const output = join(packet.root, relativeOutput);
    const before = readFileSync(output);
    const result = runFn(["prd", "author", packet.root, packet.manifest, packet.proposal, output]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("CCC_PRD_SIDECAR_WRITE_FAILED");
    expect(readFileSync(output).equals(before)).toBe(true);
  });

  it("refuses author output that would overwrite an unrelated existing file", () => {
    const packet = createPacketRoot();
    const output = join(packet.root, "operator-notes.json");
    writeFileSync(output, "{\"keep\":true}\n");
    const before = readFileSync(output);
    const result = runFn(["prd", "author", packet.root, packet.manifest, packet.proposal, output]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("CCC_PRD_SIDECAR_WRITE_FAILED");
    expect(readFileSync(output).equals(before)).toBe(true);
  });

  it("maintains an existing valid versioned sidecar", () => {
    const packet = createPacketRoot();
    const first = runFn(["prd", "author", packet.root, packet.manifest, packet.proposal, packet.sidecar]);
    expect(first.status, `${first.stdout}\n${first.stderr}`).toBe(0);
    const firstBytes = readFileSync(packet.sidecar);
    const second = runFn(["prd", "author", packet.root, packet.manifest, packet.proposal, packet.sidecar]);
    expect(second.status, `${second.stdout}\n${second.stderr}`).toBe(0);
    expect(readFileSync(packet.sidecar).equals(firstBytes)).toBe(true);
  });
});
