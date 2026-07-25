import { createHash } from "node:crypto";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

type ProvenanceBinding = {
  pluginId: string;
  pluginVersion: string;
  extensionRootRelativeSource: string;
  extensionSourceSha256: string;
  extensionManifestSha256: string;
};

type ProvenanceModule = {
  deriveWorkflowExtensionHostProvenance?: (input: {
    pluginId: string;
    pluginVersion: string;
    trustedRootPath: string;
    entryRelativePath: string;
    manifestRelativePath: string;
  }) => Promise<object>;
  getWorkflowExtensionHostProvenanceBinding?: (provenance: object) => ProvenanceBinding;
  verifyWorkflowExtensionHostProvenance?: (provenance: object) => Promise<ProvenanceBinding>;
};

async function loadProvenanceModule(): Promise<ProvenanceModule> {
  const modulePath = "../workflow-extension-provenance.js";
  try {
    return await import(modulePath) as ProvenanceModule;
  } catch {
    return {};
  }
}

async function createFixture(entry: string): Promise<{
  root: string;
  entryBytes: Buffer;
  manifestBytes: Buffer;
}> {
  const root = await mkdtemp(join(tmpdir(), "workflow-extension-provenance-"));
  const entryBytes = Buffer.from(entry, "utf8");
  const manifestBytes = Buffer.from('{"id":"proof-plugin","version":"1.2.3"}\n', "utf8");
  await mkdir(join(root, "dist"), { recursive: true });
  await writeFile(join(root, "dist", "proof.mjs"), entryBytes);
  await writeFile(join(root, "plugin.json"), manifestBytes);
  return { root, entryBytes, manifestBytes };
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("workflow extension host provenance", () => {
  it("derives a path-private binding by hashing entry and manifest through custody", async () => {
    const module = await loadProvenanceModule();
    expect(module.deriveWorkflowExtensionHostProvenance).toBeTypeOf("function");
    expect(module.getWorkflowExtensionHostProvenanceBinding).toBeTypeOf("function");
    expect(module.verifyWorkflowExtensionHostProvenance).toBeTypeOf("function");
    const fixture = await createFixture(
      'import { createHash } from "node:crypto";\nexport const digest = createHash;\n',
    );

    const provenance = await module.deriveWorkflowExtensionHostProvenance!({
      pluginId: "proof-plugin",
      pluginVersion: "1.2.3",
      trustedRootPath: fixture.root,
      entryRelativePath: "dist/proof.mjs",
      manifestRelativePath: "plugin.json",
    });
    const expected = {
      pluginId: "proof-plugin",
      pluginVersion: "1.2.3",
      extensionRootRelativeSource: "dist/proof.mjs",
      extensionSourceSha256: sha256(fixture.entryBytes),
      extensionManifestSha256: sha256(fixture.manifestBytes),
    };

    expect(module.getWorkflowExtensionHostProvenanceBinding!(provenance)).toEqual(expected);
    expect(await module.verifyWorkflowExtensionHostProvenance!(provenance)).toEqual(expected);
    expect(JSON.stringify(provenance)).not.toContain(fixture.root);
    expect(Object.isFrozen(provenance)).toBe(true);
  });

  it("rejects lexical and real-path escapes from the trusted root", async () => {
    const module = await loadProvenanceModule();
    expect(module.deriveWorkflowExtensionHostProvenance).toBeTypeOf("function");
    const fixture = await createFixture("export const proof = true;\n");
    const outside = join(dirname(fixture.root), `${fixture.root.split("/").at(-1)}-outside`);
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "proof.mjs"), "export const outside = true;\n");
    await symlink(outside, join(fixture.root, "linked"));
    await symlink(join(outside, "proof.mjs"), join(fixture.root, "final-link.mjs"));

    await expect(module.deriveWorkflowExtensionHostProvenance!({
      pluginId: "proof-plugin",
      pluginVersion: "1.2.3",
      trustedRootPath: fixture.root,
      entryRelativePath: "../outside.mjs",
      manifestRelativePath: "plugin.json",
    })).rejects.toThrow(/trusted root/i);
    await expect(module.deriveWorkflowExtensionHostProvenance!({
      pluginId: "proof-plugin",
      pluginVersion: "1.2.3",
      trustedRootPath: fixture.root,
      entryRelativePath: "linked/proof.mjs",
      manifestRelativePath: "plugin.json",
    })).rejects.toThrow(/trusted root/i);
    await expect(module.deriveWorkflowExtensionHostProvenance!({
      pluginId: "proof-plugin",
      pluginVersion: "1.2.3",
      trustedRootPath: fixture.root,
      entryRelativePath: "final-link.mjs",
      manifestRelativePath: "plugin.json",
    })).rejects.toMatchObject({ reason: "outside-trusted-root" });
  });

  it.each([
    ["FiLe:proof.mjs", "mixed-case file URL scheme"],
    ["dist\\proof.mjs", "backslash-containing source path"],
  ])("rejects a lexical %s before resolving an in-root POSIX file", async (entryRelativePath) => {
    const module = await loadProvenanceModule();
    expect(module.deriveWorkflowExtensionHostProvenance).toBeTypeOf("function");
    const fixture = await createFixture("export const proof = true;\n");
    await writeFile(join(fixture.root, entryRelativePath), "export const lexicalProof = true;\n");

    await expect(module.deriveWorkflowExtensionHostProvenance!({
      pluginId: "proof-plugin",
      pluginVersion: "1.2.3",
      trustedRootPath: fixture.root,
      entryRelativePath,
      manifestRelativePath: "plugin.json",
    })).rejects.toMatchObject({ reason: "invalid-relative-path" });
  });

  it("detects source drift when reverifying the sealed provenance", async () => {
    const module = await loadProvenanceModule();
    expect(module.deriveWorkflowExtensionHostProvenance).toBeTypeOf("function");
    const fixture = await createFixture("export const proof = true;\n");
    const provenance = await module.deriveWorkflowExtensionHostProvenance!({
      pluginId: "proof-plugin",
      pluginVersion: "1.2.3",
      trustedRootPath: fixture.root,
      entryRelativePath: "dist/proof.mjs",
      manifestRelativePath: "plugin.json",
    });

    await writeFile(join(fixture.root, "dist", "proof.mjs"), "export const proof = false;\n");

    await expect(
      module.verifyWorkflowExtensionHostProvenance!(provenance),
    ).rejects.toThrow(/source.*changed/i);
  });

  it("detects manifest drift when reverifying the sealed provenance", async () => {
    const module = await loadProvenanceModule();
    expect(module.deriveWorkflowExtensionHostProvenance).toBeTypeOf("function");
    const fixture = await createFixture("export const proof = true;\n");
    const provenance = await module.deriveWorkflowExtensionHostProvenance!({
      pluginId: "proof-plugin",
      pluginVersion: "1.2.3",
      trustedRootPath: fixture.root,
      entryRelativePath: "dist/proof.mjs",
      manifestRelativePath: "plugin.json",
    });

    await writeFile(join(fixture.root, "plugin.json"), '{"id":"proof-plugin","version":"1.2.4"}\n');

    await expect(
      module.verifyWorkflowExtensionHostProvenance!(provenance),
    ).rejects.toThrow(/manifest.*changed/i);
  });

  it("binds the canonical real entry path rather than a symlink alias", async () => {
    const module = await loadProvenanceModule();
    expect(module.deriveWorkflowExtensionHostProvenance).toBeTypeOf("function");
    const fixture = await createFixture("export const ignored = true;\n");
    await mkdir(join(fixture.root, "real"), { recursive: true });
    await writeFile(join(fixture.root, "real", "proof.mjs"), "export const proof = true;\n");
    await symlink(join(fixture.root, "real"), join(fixture.root, "alias"));

    const provenance = await module.deriveWorkflowExtensionHostProvenance!({
      pluginId: "proof-plugin",
      pluginVersion: "1.2.3",
      trustedRootPath: fixture.root,
      entryRelativePath: "alias/proof.mjs",
      manifestRelativePath: "plugin.json",
    });

    expect(
      module.getWorkflowExtensionHostProvenanceBinding!(provenance).extensionRootRelativeSource,
    ).toBe("real/proof.mjs");
  });

  it.each([
    ['import { helper } from "./helper.js";\nexport { helper };\n', "relative import"],
    ['export { helper } from "file:///tmp/helper.js";\n', "file URL"],
    ['const helper = await import("./helper.js");\nexport { helper };\n', "dynamic local import"],
    ['const helper = require("third-party");\nexport { helper };\n', "bare runtime import"],
  ])("rejects a fixed entry with a %s", async (entry) => {
    const module = await loadProvenanceModule();
    expect(module.deriveWorkflowExtensionHostProvenance).toBeTypeOf("function");
    const fixture = await createFixture(entry);

    await expect(module.deriveWorkflowExtensionHostProvenance!({
      pluginId: "proof-plugin",
      pluginVersion: "1.2.3",
      trustedRootPath: fixture.root,
      entryRelativePath: "dist/proof.mjs",
      manifestRelativePath: "plugin.json",
    })).rejects.toThrow(/self-contained/i);
  });

  it("allows compiled-away type imports and Node built-ins", async () => {
    const module = await loadProvenanceModule();
    expect(module.deriveWorkflowExtensionHostProvenance).toBeTypeOf("function");
    const fixture = await createFixture(
      'import type { Proof } from "./types.js";\n'
      + 'import { type InlineProof } from "./inline-types.js";\n'
      + 'export type { ProofResult } from "./types.js";\n'
      + 'export { type InlineResult } from "./inline-types.js";\n'
      + 'import { createHash } from "node:crypto";\n'
      + 'export const proof = createHash("sha256");\n',
    );

    await expect(module.deriveWorkflowExtensionHostProvenance!({
      pluginId: "proof-plugin",
      pluginVersion: "1.2.3",
      trustedRootPath: fixture.root,
      entryRelativePath: "dist/proof.mjs",
      manifestRelativePath: "plugin.json",
    })).resolves.toBeDefined();
  });
});
