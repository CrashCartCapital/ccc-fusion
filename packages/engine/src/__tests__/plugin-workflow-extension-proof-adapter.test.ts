import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  WORKFLOW_EXTENSION_SCHEMA_VERSION,
  WorkflowExtensionRegistry,
  deriveWorkflowExtensionHostProvenance,
  type WorkflowExtensionContribution,
  type WorkflowExtensionHostProvenance,
  type WorkflowProofAdmissionExtensionContribution,
} from "@fusion/core";
import { registerPluginWorkflowExtensions } from "../plugin-workflow-extension-adapter.js";

type RegistrationEntry = {
  extension: WorkflowExtensionContribution;
  hostProvenance?: WorkflowExtensionHostProvenance;
};

const roots: string[] = [];

async function provenance(
  pluginId = "proof-plugin",
  pluginVersion = "1.0.0",
): Promise<WorkflowExtensionHostProvenance> {
  const root = await mkdtemp(join(tmpdir(), "fusion-proof-adapter-"));
  roots.push(root);
  await mkdir(join(root, "dist"), { recursive: true });
  await writeFile(join(root, "dist", "index.mjs"), "export default {};\n");
  await writeFile(join(root, "manifest.json"), JSON.stringify({
    id: pluginId,
    name: "Proof Plugin",
    version: pluginVersion,
  }));
  return deriveWorkflowExtensionHostProvenance({
    pluginId,
    pluginVersion,
    trustedRootPath: root,
    entryRelativePath: "dist/index.mjs",
    manifestRelativePath: "manifest.json",
  });
}

async function byteIdenticalReloadProvenancePair(): Promise<
  [WorkflowExtensionHostProvenance, WorkflowExtensionHostProvenance]
> {
  const root = await mkdtemp(join(tmpdir(), "fusion-proof-adapter-reload-"));
  roots.push(root);
  await mkdir(join(root, "dist"), { recursive: true });
  await writeFile(join(root, "dist", "index.mjs"), "export default {};\n");
  await writeFile(join(root, "manifest.json"), JSON.stringify({
    id: "proof-plugin",
    name: "Proof Plugin",
    version: "1.0.0",
  }));
  const input = {
    pluginId: "proof-plugin",
    pluginVersion: "1.0.0",
    trustedRootPath: root,
    entryRelativePath: "dist/index.mjs",
    manifestRelativePath: "manifest.json",
  } as const;
  return [
    await deriveWorkflowExtensionHostProvenance(input),
    await deriveWorkflowExtensionHostProvenance(input),
  ];
}

function proof(
  extensionId: string,
  summary = extensionId,
): WorkflowProofAdmissionExtensionContribution {
  return {
    extensionId,
    name: extensionId,
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

function ordinary(extensionId = "ordinary-policy"): WorkflowExtensionContribution {
  return {
    extensionId,
    name: extensionId,
    kind: "move-policy",
    schemaVersion: WORKFLOW_EXTENSION_SCHEMA_VERSION,
    fallback: "degradeToDefault",
  };
}

function register(
  registry: WorkflowExtensionRegistry,
  entries: RegistrationEntry[],
): string[] {
  return registerPluginWorkflowExtensions({
    registry,
    pluginId: "proof-plugin",
    contributions: entries,
  } as never);
}

describe("plugin workflow-extension proof adapter", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("passes the exact opaque host provenance into the proof registry", async () => {
    const registry = new WorkflowExtensionRegistry();
    const hostProvenance = await provenance();

    expect(register(registry, [{ extension: proof("proof-a"), hostProvenance }])).toEqual([
      "plugin:proof-plugin:proof-a",
    ]);
    expect(registry.get("plugin:proof-plugin:proof-a")?.hostProvenance).toMatchObject({
      pluginId: "proof-plugin",
      pluginVersion: "1.0.0",
      extensionRootRelativeSource: "dist/index.mjs",
    });
  });

  it("accepts a byte-identical reload with a fresh evaluator function identity", async () => {
    const registry = new WorkflowExtensionRegistry();
    const [loadedProvenance, reloadedProvenance] =
      await byteIdenticalReloadProvenancePair();
    const loaded = proof("native-proof", "same sealed source");
    const reloaded = proof("native-proof", "same sealed source");
    const registered = registry.register("proof-plugin", loaded, loadedProvenance);

    expect(() =>
      registry.upsert("proof-plugin", reloaded, reloadedProvenance)
    ).not.toThrow();
    expect(registry.get("plugin:proof-plugin:native-proof")).toBe(registered);
    expect(registry.get("plugin:proof-plugin:native-proof")?.degraded).toBeUndefined();
  });

  it("processes proofs before ordinary extensions and removes a newly-created proof after a later proof failure", async () => {
    const registry = new WorkflowExtensionRegistry();
    const hostProvenance = await provenance();

    expect(() => register(registry, [
      { extension: ordinary() },
      { extension: proof("proof-a"), hostProvenance },
      { extension: proof("proof-b") },
    ])).toThrow(/host-derived provenance/u);

    expect(registry.get("plugin:proof-plugin:proof-a")).toBeUndefined();
    expect(registry.get("plugin:proof-plugin:proof-b")).toBeUndefined();
    expect(registry.get("plugin:proof-plugin:ordinary-policy")).toBeUndefined();
  });

  it("preserves an existing degraded proof while rolling back only proof records created by the failed batch", async () => {
    const registry = new WorkflowExtensionRegistry();
    const hostProvenance = await provenance();
    const existing = proof("proof-existing");
    registry.register("proof-plugin", existing, hostProvenance);
    registry.degrade(
      ["plugin:proof-plugin:proof-existing"],
      "force-disabled",
      "operator disabled",
    );

    expect(() => register(registry, [
      { extension: existing, hostProvenance },
      { extension: proof("proof-new"), hostProvenance },
      { extension: proof("proof-missing") },
    ])).toThrow(/host-derived provenance/u);

    expect(registry.get("plugin:proof-plugin:proof-new")).toBeUndefined();
    expect(registry.get("plugin:proof-plugin:proof-existing")?.degraded).toEqual({
      reason: "force-disabled",
      message: "operator disabled",
    });
  });

  it("rejects duplicate proof ids before publishing either duplicate", async () => {
    const registry = new WorkflowExtensionRegistry();
    const hostProvenance = await provenance();

    expect(() => register(registry, [
      { extension: proof("proof-duplicate", "first"), hostProvenance },
      { extension: proof("proof-duplicate", "second"), hostProvenance },
    ])).toThrow(/duplicate proof-admission contribution/u);
    expect(registry.get("plugin:proof-plugin:proof-duplicate")).toBeUndefined();
  });

  it("preserves repeated ordinary extension upsert behavior", () => {
    const registry = new WorkflowExtensionRegistry();
    const first = ordinary();
    const second = { ...ordinary(), name: "Updated ordinary policy" };

    expect(register(registry, [{ extension: first }])).toEqual([
      "plugin:proof-plugin:ordinary-policy",
    ]);
    expect(register(registry, [{ extension: second }])).toEqual([
      "plugin:proof-plugin:ordinary-policy",
    ]);
    expect(registry.get("plugin:proof-plugin:ordinary-policy")?.extension).toBe(second);
  });
});
