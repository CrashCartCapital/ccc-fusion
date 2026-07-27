import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WORKFLOW_EXTENSION_SCHEMA_VERSION,
  __resetWorkflowExtensionRegistryForTests,
  deriveWorkflowExtensionHostProvenance,
  getWorkflowExtensionRegistry,
  type PluginLoader,
  type PluginStore,
  type WorkflowExtensionContribution,
  type WorkflowExtensionHostProvenance,
  type WorkflowProofAdmissionExtensionContribution,
} from "@fusion/core";
import { PluginRunner } from "../plugin-runner.js";

type LoaderEntry = {
  pluginId: string;
  extension: WorkflowExtensionContribution;
  hostProvenance?: WorkflowExtensionHostProvenance;
};

const roots: string[] = [];

async function provenance(
  source = "export default {};\n",
  pluginId = "proof-plugin",
): Promise<WorkflowExtensionHostProvenance> {
  const root = await mkdtemp(join(tmpdir(), "fusion-proof-runner-"));
  roots.push(root);
  await mkdir(join(root, "dist"), { recursive: true });
  await writeFile(join(root, "dist", "index.mjs"), source);
  await writeFile(join(root, "manifest.json"), JSON.stringify({
    id: pluginId,
    name: "Proof Plugin",
    version: "1.0.0",
  }));
  return deriveWorkflowExtensionHostProvenance({
    pluginId,
    pluginVersion: "1.0.0",
    trustedRootPath: root,
    entryRelativePath: "dist/index.mjs",
    manifestRelativePath: "manifest.json",
  });
}

function proof(
  summary: string,
  extensionId = "native-proof",
): WorkflowProofAdmissionExtensionContribution {
  return {
    extensionId,
    name: "Native proof",
    kind: "proof-admission",
    schemaVersion: WORKFLOW_EXTENSION_SCHEMA_VERSION,
    fallback: "failClosed",
    proofVersion: "1",
    evaluate: async (input) => ({
      outcome: "pass",
      evaluatedInputSha256: input.inputSha256,
      summary,
    }),
  };
}

class LoaderHarness extends EventEmitter {
  public current: LoaderEntry[] = [];
  public readonly reloadPlugin = vi.fn(async (_pluginId: string): Promise<void> => undefined);
  public readonly loadAllPlugins = vi.fn(async () => ({ loaded: 1, errors: 0 }));
  public readonly stopAllPlugins = vi.fn(async () => undefined);
  public readonly invokeHook = vi.fn(async () => undefined);

  getPluginWorkflowExtensions(): LoaderEntry[] {
    return this.current;
  }

  getPluginTools() { return []; }
  getPluginRoutes() { return []; }
  getPluginUiSlots() { return []; }
  getPluginUiContributions() { return []; }
  getPluginRuntimes() { return []; }
  getCliProviderContributions() { return []; }
  getPluginSkills() { return []; }
  getPluginMcpServers() { return []; }
  getPluginWorkflowSteps() { return []; }
  getPluginWorkflowStepTemplates() { return []; }
  getPluginTraits() { return []; }
  getPluginPromptContributions() { return []; }
  getPluginSetupInfo() { return []; }
}

function createRunner(loader: LoaderHarness): PluginRunner {
  const pluginStore = new EventEmitter() as PluginStore;
  const taskStore = Object.assign(new EventEmitter(), {
    recordRunAuditEvent: vi.fn(),
  });
  return new PluginRunner({
    pluginLoader: loader as unknown as PluginLoader,
    pluginStore,
    taskStore: taskStore as never,
    rootDir: "/fixture",
  });
}

describe("PluginRunner proof provenance lifecycle", () => {
  afterEach(async () => {
    __resetWorkflowExtensionRegistryForTests();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    vi.restoreAllMocks();
  });

  it("does not ambiently register an external proof after reload", async () => {
    const oldProvenance = await provenance("export const evaluator = 'old';\n");
    const newProvenance = await provenance("export const evaluator = 'new';\n");
    const oldProof = proof("old evaluator");
    const newProof = proof("new evaluator");
    const loader = new LoaderHarness();
    loader.current = [{
      pluginId: "proof-plugin",
      extension: oldProof,
      hostProvenance: oldProvenance,
    }];
    loader.reloadPlugin.mockImplementation(async () => {
      loader.current = [{
        pluginId: "proof-plugin",
        extension: newProof,
        hostProvenance: newProvenance,
      }];
    });
    const runner = createRunner(loader);
    runner.syncPluginWorkflowExtensions();

    await runner.reloadPlugin("proof-plugin");

    expect(getWorkflowExtensionRegistry().get("plugin:proof-plugin:native-proof")).toBeUndefined();
  });

  it("leaves a preloaded fixed-native proof untouched through ambient sync, unload, and force-disable", async () => {
    const nativeProvenance = await provenance("export const fixed = true;\n", "fusion-native");
    const fixed = proof("fixed evaluator", "ccc-proof-admission");
    const registry = getWorkflowExtensionRegistry();
    registry.register("fusion-native", fixed, nativeProvenance);
    const loader = new LoaderHarness();
    loader.current = [{
      pluginId: "fusion-native",
      extension: proof("ambient collision", "ccc-proof-admission"),
      hostProvenance: nativeProvenance,
    }, {
      pluginId: "fusion-native",
      extension: {
        extensionId: "ordinary-policy",
        name: "Ordinary policy",
        kind: "move-policy",
        schemaVersion: WORKFLOW_EXTENSION_SCHEMA_VERSION,
        fallback: "degradeToDefault",
      },
    }];
    const runner = createRunner(loader);

    await runner.init();
    expect(registry.get("plugin:fusion-native:ordinary-policy")).toBeDefined();
    loader.current = [];
    loader.emit("plugin:unloaded", { pluginId: "fusion-native" });
    expect(registry.get("plugin:fusion-native:ordinary-policy")).toBeUndefined();
    loader.current = [{
      pluginId: "fusion-native",
      extension: proof("ambient collision", "ccc-proof-admission"),
      hostProvenance: nativeProvenance,
    }, {
      pluginId: "fusion-native",
      extension: {
        extensionId: "ordinary-policy", name: "Ordinary policy", kind: "move-policy",
        schemaVersion: WORKFLOW_EXTENSION_SCHEMA_VERSION, fallback: "degradeToDefault",
      },
    }];
    runner.syncPluginWorkflowExtensions();
    expect(runner.disablePluginWorkflowExtensions("fusion-native", { force: true }).degraded)
      .toEqual([]);
    expect(registry.get("plugin:fusion-native:ordinary-policy")).toBeUndefined();
    expect(registry.get("plugin:fusion-native:ccc-proof-admission")?.extension.evaluate)
      .toBe(fixed.evaluate);
    expect(registry.get("plugin:fusion-native:ccc-proof-admission")?.degraded).toBeUndefined();
    await runner.shutdown();
  });

  it("does not ambiently register an external proof on a byte-identical reload", async () => {
    const hostProvenance = await provenance();
    const oldProof = proof("same source");
    const reimportedProof = proof("same source");
    const loader = new LoaderHarness();
    loader.current = [{ pluginId: "proof-plugin", extension: oldProof, hostProvenance }];
    loader.reloadPlugin.mockImplementation(async () => {
      loader.current = [{
        pluginId: "proof-plugin",
        extension: reimportedProof,
        hostProvenance,
      }];
    });
    const runner = createRunner(loader);
    runner.syncPluginWorkflowExtensions();

    await runner.reloadPlugin("proof-plugin");

    expect(getWorkflowExtensionRegistry().get("plugin:proof-plugin:native-proof")).toBeUndefined();
  });

  it("does not ambiently restore proof authority when reload rolls back", async () => {
    const hostProvenance = await provenance();
    const oldProof = proof("old evaluator");
    const loader = new LoaderHarness();
    loader.current = [{ pluginId: "proof-plugin", extension: oldProof, hostProvenance }];
    loader.reloadPlugin.mockRejectedValue(new Error("reload rolled back"));
    const runner = createRunner(loader);
    runner.syncPluginWorkflowExtensions();

    await expect(runner.reloadPlugin("proof-plugin")).rejects.toThrow("reload rolled back");

    expect(getWorkflowExtensionRegistry().get("plugin:proof-plugin:native-proof")).toBeUndefined();
  });

  it("keeps external proof authority absent after total reload failure", async () => {
    const hostProvenance = await provenance();
    const loader = new LoaderHarness();
    loader.current = [{
      pluginId: "proof-plugin",
      extension: proof("old evaluator"),
      hostProvenance,
    }];
    loader.reloadPlugin.mockImplementation(async () => {
      loader.current = [];
      throw new Error("reload and rollback failed");
    });
    const runner = createRunner(loader);
    runner.syncPluginWorkflowExtensions();

    await expect(runner.reloadPlugin("proof-plugin")).rejects.toThrow(
      "reload and rollback failed",
    );

    expect(
      getWorkflowExtensionRegistry().get("plugin:proof-plugin:native-proof"),
    ).toBeUndefined();
  });

  it("keeps external proof authority absent when the loader emits plugin:unloaded", async () => {
    const hostProvenance = await provenance();
    const loader = new LoaderHarness();
    loader.current = [{
      pluginId: "proof-plugin",
      extension: proof("old evaluator"),
      hostProvenance,
    }];
    const runner = createRunner(loader);
    await runner.init();
    expect(getWorkflowExtensionRegistry().get("plugin:proof-plugin:native-proof")).toBeUndefined();

    loader.current = [];
    loader.emit("plugin:unloaded", { pluginId: "proof-plugin" });

    expect(
      getWorkflowExtensionRegistry().get("plugin:proof-plugin:native-proof"),
    ).toBeUndefined();
  });

  it("removes a previously tracked ambient proof id on resync while retaining ordinary extensions", async () => {
    const hostProvenance = await provenance();
    const loader = new LoaderHarness();
    loader.current = [{
      pluginId: "proof-plugin",
      extension: proof("old evaluator"),
      hostProvenance,
    }];
    const runner = createRunner(loader);
    getWorkflowExtensionRegistry().register("proof-plugin", proof("old evaluator"), hostProvenance);
    (runner as unknown as {
      registeredPluginWorkflowExtensionIds: Map<string, string[]>;
    }).registeredPluginWorkflowExtensionIds.set("proof-plugin", ["plugin:proof-plugin:native-proof"]);

    loader.current = [{
      pluginId: "proof-plugin",
      extension: proof("ambient replacement"),
      hostProvenance,
    }, {
      pluginId: "proof-plugin",
      extension: {
        extensionId: "ordinary-policy",
        name: "Ordinary policy",
        kind: "move-policy",
        schemaVersion: WORKFLOW_EXTENSION_SCHEMA_VERSION,
        fallback: "degradeToDefault",
      },
    }];
    runner.syncPluginWorkflowExtensions();

    expect(
      getWorkflowExtensionRegistry().get("plugin:proof-plugin:native-proof"),
    ).toBeUndefined();
    expect(
      getWorkflowExtensionRegistry().get("plugin:proof-plugin:ordinary-policy"),
    ).toBeDefined();
  });

  it("keeps an ambient proof absent when a current contribution lacks provenance", async () => {
    const hostProvenance = await provenance();
    const oldProof = proof("old evaluator");
    const loader = new LoaderHarness();
    loader.current = [{
      pluginId: "proof-plugin",
      extension: oldProof,
      hostProvenance,
    }];
    const runner = createRunner(loader);
    runner.syncPluginWorkflowExtensions();

    loader.current = [{
      pluginId: "proof-plugin",
      extension: proof("old evaluator"),
    }];
    (runner as unknown as {
      invalidateWorkflowExtensionsCache(): void;
    }).invalidateWorkflowExtensionsCache();

    expect(getWorkflowExtensionRegistry().get("plugin:proof-plugin:native-proof")).toBeUndefined();
  });
});
