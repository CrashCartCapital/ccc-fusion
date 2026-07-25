import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginLoader } from "../plugin-loader.js";
import type { PluginInstallation } from "../plugin-types.js";
import { type WorkflowExtensionHostProvenance } from "../workflow-extension-provenance.js";
import type { WorkflowExtensionContribution } from "../workflow-extension-types.js";

type EnumeratedWorkflowExtension = {
  pluginId: string;
  extension: WorkflowExtensionContribution;
  hostProvenance?: WorkflowExtensionHostProvenance;
};

type FixtureOptions = {
  version?: string;
  summary?: string;
  onLoadSource?: string;
  onUnloadSource?: string;
  writeManifest?: boolean;
  diskManifestId?: string;
  diskManifestVersion?: string;
  ambiguousManifest?: boolean;
  mutateCanonicalOnImport?: boolean;
};

const roots: string[] = [];
const loaders: PluginLoader[] = [];

function pluginSource(options: FixtureOptions = {}): string {
  const version = options.version ?? "1.0.0";
  const summary = options.summary ?? "proof-v1";
  return `
globalThis.__fusionMutateProofEntry?.();
const evaluate = async (input) => ({
  outcome: "pass",
  evaluatedInputSha256: input.inputSha256,
  summary: ${JSON.stringify(summary)},
});
export default {
  manifest: {
    id: "proof-plugin",
    name: "Proof Plugin",
    version: ${JSON.stringify(version)},
    description: "fixture",
  },
  state: "installed",
  hooks: {
    ${options.onLoadSource ? `onLoad: ${options.onLoadSource},` : ""}
    ${options.onUnloadSource ? `onUnload: ${options.onUnloadSource},` : ""}
  },
  workflowExtensions: [
    {
      extensionId: "native-proof",
      name: "Native proof",
      kind: "proof-admission",
      schemaVersion: 1,
      fallback: "failClosed",
      proofVersion: "1",
      evaluate,
    },
    {
      extensionId: "ordinary-policy",
      name: "Ordinary policy",
      kind: "move-policy",
      schemaVersion: 1,
      fallback: "degradeToDefault",
    },
  ],
};
`;
}

async function createFixture(options: FixtureOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), "fusion-plugin-proof-provenance-"));
  roots.push(root);
  const dist = join(root, "dist");
  await mkdir(dist, { recursive: true });
  const entry = join(dist, "index.mjs");
  const source = pluginSource(options);
  await writeFile(entry, source);

  const version = options.version ?? "1.0.0";
  if (options.writeManifest !== false) {
    await writeFile(join(root, "manifest.json"), JSON.stringify({
      id: options.diskManifestId ?? "proof-plugin",
      name: "Proof Plugin",
      version: options.diskManifestVersion ?? version,
      description: "fixture",
    }));
  }
  if (options.ambiguousManifest) {
    await writeFile(join(dist, "manifest.json"), JSON.stringify({
      id: "proof-plugin",
      name: "Proof Plugin",
      version,
      description: "ambiguous fixture",
    }));
  }

  const installation: PluginInstallation = {
    id: "proof-plugin",
    name: "Proof Plugin",
    version,
    description: "fixture",
    path: entry,
    enabled: true,
    state: "installed",
    settings: {},
    dependencies: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const events = new EventEmitter();
  const pluginStore = {
    getPlugin: vi.fn(async () => ({ ...installation })),
    listPlugins: vi.fn(async () => [{ ...installation }]),
    updatePlugin: vi.fn(async () => ({ ...installation })),
    updatePluginState: vi.fn(async (_id: string, state: PluginInstallation["state"]) => ({
      ...installation,
      state,
    })),
    on: events.on.bind(events),
    off: events.off.bind(events),
  };
  const taskStore = {
    getRootDir: () => root,
    preflightPluginSchema: vi.fn(() => null),
    runPluginSchemaInits: vi.fn(async () => undefined),
  };
  const loader = new PluginLoader({
    pluginStore: pluginStore as never,
    taskStore: taskStore as never,
  });
  loaders.push(loader);

  if (options.mutateCanonicalOnImport) {
    const replacement = pluginSource({ summary: "mutated-canonical" });
    (globalThis as typeof globalThis & { __fusionMutateProofEntry?: () => void })
      .__fusionMutateProofEntry = () => {
        writeFileSync(entry, replacement);
        delete (globalThis as typeof globalThis & { __fusionMutateProofEntry?: () => void })
          .__fusionMutateProofEntry;
      };
  }

  return { root, entry, loader };
}

function extensions(loader: PluginLoader): EnumeratedWorkflowExtension[] {
  return loader.getPluginWorkflowExtensions() as EnumeratedWorkflowExtension[];
}

describe("PluginLoader proof provenance custody", () => {
  afterEach(async () => {
    delete (globalThis as typeof globalThis & { __fusionMutateProofEntry?: () => void })
      .__fusionMutateProofEntry;
    await Promise.all(loaders.splice(0).map((loader) => loader.stopAllPlugins()));
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    vi.restoreAllMocks();
  });

  it("withholds external proof contributions while ordinary entries remain unchanged", async () => {
    const { loader } = await createFixture();
    await loader.loadPlugin("proof-plugin");

    expect(extensions(loader).some(({ extension }) => extension.kind === "proof-admission")).toBe(false);

    const ordinary = extensions(loader).find(
      ({ extension }) => extension.kind === "move-policy",
    );
    expect(ordinary).toEqual({
      pluginId: "proof-plugin",
      extension: expect.objectContaining({
        extensionId: "ordinary-policy",
        kind: "move-policy",
      }),
    });
  });

  it.each([
    ["missing", { writeManifest: false }],
    ["ambiguous", { ambiguousManifest: true }],
    ["foreign id", { diskManifestId: "foreign-plugin" }],
    ["foreign version", { diskManifestVersion: "9.9.9" }],
  ] as const)(
    "withholds proof authority for a %s on-disk manifest without blocking ordinary extensions",
    async (_label, options) => {
      const { loader } = await createFixture(options);
      await expect(loader.loadPlugin("proof-plugin")).resolves.toMatchObject({
        manifest: { id: "proof-plugin" },
      });

      expect(extensions(loader).some(({ extension }) => extension.kind === "proof-admission")).toBe(false);
      expect(extensions(loader)).toContainEqual({
        pluginId: "proof-plugin",
        extension: expect.objectContaining({
          extensionId: "ordinary-policy",
          kind: "move-policy",
        }),
      });
    },
  );

  it("withholds proof authority when the imported reload copy no longer matches the custodied canonical entry", async () => {
    const { loader } = await createFixture({ mutateCanonicalOnImport: true });
    await loader.loadPlugin("proof-plugin");

    expect(extensions(loader).some(({ extension }) => extension.kind === "proof-admission")).toBe(false);
  });

  it("restores the original proof provenance after a failed reload rolls back", async () => {
    const { entry, loader } = await createFixture();
    await loader.loadPlugin("proof-plugin");
    const original = extensions(loader);

    await writeFile(entry, pluginSource({
      summary: "replacement",
      onLoadSource: `async () => { throw new Error("replacement failed"); }`,
    }));
    await expect(loader.reloadPlugin("proof-plugin")).rejects.toThrow("replacement failed");

    expect(extensions(loader)).toEqual(original);
  });

  it("removes proof provenance after unload and after reload plus rollback total failure", async () => {
    const unloadFixture = await createFixture();
    await unloadFixture.loader.loadPlugin("proof-plugin");
    await unloadFixture.loader.stopPlugin("proof-plugin");
    expect(extensions(unloadFixture.loader)).toEqual([]);

    const totalFailureFixture = await createFixture({
      onLoadSource: `((() => { let count = 0; return async () => {
        count += 1;
        if (count > 1) throw new Error("rollback failed");
      }; })())`,
    });
    await totalFailureFixture.loader.loadPlugin("proof-plugin");
    await writeFile(totalFailureFixture.entry, pluginSource({
      summary: "replacement",
      onLoadSource: `async () => { throw new Error("replacement failed"); }`,
    }));
    await expect(totalFailureFixture.loader.reloadPlugin("proof-plugin")).rejects.toThrow(
      "replacement failed",
    );

    expect(totalFailureFixture.loader.isPluginLoaded("proof-plugin")).toBe(false);
    expect(extensions(totalFailureFixture.loader)).toEqual([]);
  });
});
