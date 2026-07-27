import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  WorkflowExtensionRegistry,
  WorkflowExtensionRegistrationError,
} from "../workflow-extension-registry.js";
import {
  deriveWorkflowExtensionHostProvenance,
  getWorkflowExtensionHostProvenanceBinding,
  type WorkflowExtensionHostProvenance,
} from "../workflow-extension-provenance.js";
import type {
  WorkflowExtensionContribution,
  WorkflowProofAdmissionEvaluator,
  WorkflowProofAdmissionExtensionContribution,
} from "../workflow-extension-types.js";

function extension(
  extensionId = "move-policy",
  kind: WorkflowExtensionContribution["kind"] = "move-policy",
): WorkflowExtensionContribution {
  return {
    extensionId,
    name: "Move Policy",
    kind,
    schemaVersion: 1,
    fallback: "degradeToDefault",
  };
}

function proofExtension(
  evaluate: WorkflowProofAdmissionEvaluator,
  proofVersion = "v1",
): WorkflowProofAdmissionExtensionContribution {
  return {
    extensionId: "campaign-proof",
    name: "Campaign Proof",
    kind: "proof-admission",
    schemaVersion: 1,
    fallback: "failClosed",
    proofVersion,
    evaluate,
  };
}

async function hostProvenance(
  input: {
    pluginId?: string;
    pluginVersion?: string;
    entrySource?: string;
  } = {},
): Promise<WorkflowExtensionHostProvenance> {
  const root = await mkdtemp(join(tmpdir(), "workflow-extension-registry-"));
  await mkdir(join(root, "dist"), { recursive: true });
  await writeFile(
    join(root, "dist", "proof.mjs"),
    input.entrySource ?? "export const proof = true;\n",
  );
  await writeFile(join(root, "plugin.json"), '{"name":"proof-plugin"}\n');
  return deriveWorkflowExtensionHostProvenance({
    pluginId: input.pluginId ?? "campaign-proof-plugin",
    pluginVersion: input.pluginVersion ?? "1.0.0",
    trustedRootPath: root,
    entryRelativePath: "dist/proof.mjs",
    manifestRelativePath: "plugin.json",
  });
}

describe("WorkflowExtensionRegistry", () => {
  it("degrades and refuses a proof-admission upsert that changes pinned host identity", async () => {
    const registry = new WorkflowExtensionRegistry();
    const originalEvaluator: WorkflowProofAdmissionEvaluator = async ({ inputSha256 }) => ({
      outcome: "pass",
      evaluatedInputSha256: inputSha256,
      summary: "original",
    });
    const originalProvenance = await hostProvenance();
    const replacementProvenance = await hostProvenance({
      pluginVersion: "1.1.0",
      entrySource: "export const proof = false;\n",
    });
    registry.register(
      "campaign-proof-plugin",
      proofExtension(originalEvaluator),
      originalProvenance,
    );

    expect(() => registry.upsert(
      "campaign-proof-plugin",
      proofExtension(originalEvaluator),
      replacementProvenance,
    )).toThrowError(expect.objectContaining({ reason: "identity-drift" }));

    const retained = registry.get("plugin:campaign-proof-plugin:campaign-proof");
    expect(retained?.degraded).toMatchObject({
      reason: "runtime-fault",
    });
    expect(retained?.extension.kind).toBe("proof-admission");
    if (retained?.extension.kind !== "proof-admission") throw new Error("proof extension missing");
    expect(retained.extension.evaluate).toBe(originalEvaluator);
    expect(retained.hostProvenance).toEqual(
      getWorkflowExtensionHostProvenanceBinding(originalProvenance),
    );
  });

  it("requires helper-created host provenance for proof-admission registration", async () => {
    const registry = new WorkflowExtensionRegistry();
    const evaluate: WorkflowProofAdmissionEvaluator = async ({ inputSha256 }) => ({
      outcome: "fail",
      evaluatedInputSha256: inputSha256,
      summary: "not evaluated",
    });

    expect(() => registry.register(
      "campaign-proof-plugin",
      proofExtension(evaluate),
    )).toThrowError(expect.objectContaining({ reason: "missing-host-provenance" }));
    expect(() => registry.register(
      "campaign-proof-plugin",
      proofExtension(evaluate),
      {} as WorkflowExtensionHostProvenance,
    )).toThrowError(expect.objectContaining({ reason: "invalid-host-provenance" }));
    const mismatchedProvenance = await hostProvenance();
    expect(() => registry.register(
      "other-plugin",
      proofExtension(evaluate),
      mismatchedProvenance,
    )).toThrowError(expect.objectContaining({ reason: "host-identity-mismatch" }));
  });

  it("rejects proof contributions that try to carry host identity fields", async () => {
    const registry = new WorkflowExtensionRegistry();
    const evaluator: WorkflowProofAdmissionEvaluator = async ({ inputSha256 }) => ({
      outcome: "fail",
      evaluatedInputSha256: inputSha256,
      summary: "not evaluated",
    });
    const contribution = {
      ...proofExtension(evaluator),
      pluginVersion: "caller-owned",
      extensionSourceSha256: "a".repeat(64),
    } as WorkflowProofAdmissionExtensionContribution;
    const provenance = await hostProvenance();

    expect(() => registry.register(
      "campaign-proof-plugin",
      contribution,
      provenance,
    )).toThrowError(expect.objectContaining({ reason: "invalid-proof-contribution" }));
  });

  it("seals proof identity and evaluator against original, get, and list mutation", async () => {
    const registry = new WorkflowExtensionRegistry();
    const originalEvaluator: WorkflowProofAdmissionEvaluator = async ({ inputSha256 }) => ({
      outcome: "pass",
      evaluatedInputSha256: inputSha256,
      summary: "original",
    });
    const replacementEvaluator: WorkflowProofAdmissionEvaluator = async ({ inputSha256 }) => ({
      outcome: "fail",
      evaluatedInputSha256: inputSha256,
      summary: "replacement",
    });
    const contribution = proofExtension(originalEvaluator);
    const provenance = await hostProvenance();
    registry.register("campaign-proof-plugin", contribution, provenance);

    contribution.proofVersion = "caller-mutated";
    contribution.evaluate = replacementEvaluator;
    const fromGet = registry.get("plugin:campaign-proof-plugin:campaign-proof");
    const fromList = registry.list("proof-admission");
    expect(Object.isFrozen(fromGet)).toBe(true);
    expect(Object.isFrozen(fromGet?.extension)).toBe(true);
    expect(Object.isFrozen(fromGet?.hostProvenance)).toBe(true);
    expect(Object.isFrozen(fromList)).toBe(true);
    expect(() => {
      (fromGet!.extension as { proofVersion?: string }).proofVersion = "snapshot-mutated";
    }).toThrow(TypeError);
    expect(() => {
      (fromList as unknown as unknown[]).push(fromGet);
    }).toThrow(TypeError);

    const retained = registry.get("plugin:campaign-proof-plugin:campaign-proof");
    expect(retained?.extension.kind).toBe("proof-admission");
    if (retained?.extension.kind !== "proof-admission") throw new Error("proof extension missing");
    expect(retained.extension.proofVersion).toBe("v1");
    expect(retained.extension.evaluate).toBe(originalEvaluator);
  });

  it("keeps an identical proof-admission upsert healthy without replacing its sealed record", async () => {
    const registry = new WorkflowExtensionRegistry();
    const evaluator: WorkflowProofAdmissionEvaluator = async ({ inputSha256 }) => ({
      outcome: "pass",
      evaluatedInputSha256: inputSha256,
      summary: "same",
    });
    const provenance = await hostProvenance();
    const registered = registry.register(
      "campaign-proof-plugin",
      proofExtension(evaluator),
      provenance,
    );

    const upserted = registry.upsert(
      "campaign-proof-plugin",
      proofExtension(evaluator),
      provenance,
    );

    expect(upserted).toBe(registered);
    expect(upserted.degraded).toBeUndefined();
  });

  it("reverifies sealed proof provenance without exposing custody paths", async () => {
    const registry = new WorkflowExtensionRegistry();
    const evaluator: WorkflowProofAdmissionEvaluator = async ({ inputSha256 }) => ({
      outcome: "pass",
      evaluatedInputSha256: inputSha256,
      summary: "same",
    });
    const provenance = await hostProvenance();
    registry.register("campaign-proof-plugin", proofExtension(evaluator), provenance);

    await expect(
      registry.reverifyHostProvenance("plugin:campaign-proof-plugin:campaign-proof"),
    ).resolves.toEqual(getWorkflowExtensionHostProvenanceBinding(provenance));
  });

  it("accepts a fresh evaluator function under unchanged sealed host identity without replacing the evaluator", async () => {
    const registry = new WorkflowExtensionRegistry();
    const first: WorkflowProofAdmissionEvaluator = async ({ inputSha256 }) => ({
      outcome: "pass",
      evaluatedInputSha256: inputSha256,
      summary: "first",
    });
    const second: WorkflowProofAdmissionEvaluator = async ({ inputSha256 }) => ({
      outcome: "pass",
      evaluatedInputSha256: inputSha256,
      summary: "second",
    });
    const provenance = await hostProvenance();
    const registered = registry.register(
      "campaign-proof-plugin",
      proofExtension(first),
      provenance,
    );

    const upserted = registry.upsert(
      "campaign-proof-plugin",
      proofExtension(second),
      provenance,
    );

    const retained = registry.get("plugin:campaign-proof-plugin:campaign-proof");
    expect(upserted).toBe(registered);
    expect(retained?.extension.kind).toBe("proof-admission");
    if (retained?.extension.kind !== "proof-admission") throw new Error("proof extension missing");
    expect(retained.extension.evaluate).toBe(first);
    expect(retained.degraded).toBeUndefined();
  });

  it("degrades and refuses an identical public binding derived from a different trusted root", async () => {
    const registry = new WorkflowExtensionRegistry();
    const evaluator: WorkflowProofAdmissionEvaluator = async ({ inputSha256 }) => ({
      outcome: "pass",
      evaluatedInputSha256: inputSha256,
      summary: "same",
    });
    const firstRoot = await hostProvenance();
    const secondRoot = await hostProvenance();
    expect(getWorkflowExtensionHostProvenanceBinding(secondRoot)).toEqual(
      getWorkflowExtensionHostProvenanceBinding(firstRoot),
    );
    registry.register("campaign-proof-plugin", proofExtension(evaluator), firstRoot);

    expect(() => registry.upsert(
      "campaign-proof-plugin",
      proofExtension(evaluator),
      secondRoot,
    )).toThrowError(expect.objectContaining({ reason: "identity-drift" }));
    expect(
      registry.get("plugin:campaign-proof-plugin:campaign-proof")?.degraded?.reason,
    ).toBe("runtime-fault");
  });

  it("registers and lists plugin-namespaced workflow extensions", () => {
    const registry = new WorkflowExtensionRegistry();

    const registered = registry.register("plugin-a", extension());

    expect(registered.id).toBe("plugin:plugin-a:move-policy");
    expect(registry.get("plugin:plugin-a:move-policy")).toBe(registered);
    expect(registry.list("move-policy")).toEqual([registered]);
    expect(registry.list("work-engine")).toEqual([]);
  });

  it("defaults ordinary contributions to host-owned opaque provider posture", () => {
    const registry = new WorkflowExtensionRegistry();
    const registered = registry.register("plugin-a", extension());

    expect((registered as { providerPosture?: string }).providerPosture).toBe("opaque");
    expect(Object.getOwnPropertyDescriptor(registered, "providerPosture")?.writable).toBe(false);
    expect(() => {
      (registered as { providerPosture?: string }).providerPosture = "scoped-provider";
    }).toThrow(TypeError);
  });

  it("accepts fixed-host provider posture through registration metadata and rejects posture drift", async () => {
    const registry = new WorkflowExtensionRegistry();
    const fixedPosture = "scoped-provider" as const;
    const driftedPosture = "no-provider" as const;
    const pluginProvenance = await hostProvenance({ pluginId: "plugin-a" });
    const stable = registry.register(
      "plugin-a",
      extension("posture-policy", "move-policy"),
      pluginProvenance,
      { providerPosture: fixedPosture },
    );

    expect(stable.providerPosture).toBe(fixedPosture);

    const samePostureUpsert = registry.upsert(
      "plugin-a",
      {
        ...extension("posture-policy", "move-policy"),
        name: "Updated posture policy",
      },
      pluginProvenance,
      { providerPosture: fixedPosture },
    );
    expect(samePostureUpsert.extension.name).toBe("Updated posture policy");
    expect((samePostureUpsert as { providerPosture?: string }).providerPosture).toBe(fixedPosture);

    const driftPostureUpsert = () => registry.upsert(
      "plugin-a",
      {
        ...extension("posture-policy", "move-policy"),
      },
      pluginProvenance,
      { providerPosture: driftedPosture },
    );
    expect(driftPostureUpsert).toThrowError(expect.objectContaining({ reason: "identity-drift" }));
    expect(registry.get("plugin:plugin-a:posture-policy")?.degraded).toMatchObject({
      reason: "runtime-fault",
    });
  });

  it("rejects invalid host registration posture and creates no entry", async () => {
    const registry = new WorkflowExtensionRegistry();
    const pluginProvenance = await hostProvenance({ pluginId: "plugin-a" });

    expect(() =>
      (registry as { register: (...args: unknown[]) => unknown }).register(
        "plugin-a",
        extension("invalid-posture-policy"),
        pluginProvenance,
        { providerPosture: "provider-capable" },
      ),
    ).toThrowError(expect.objectContaining({ reason: "invalid-provider-posture" }));
    expect(registry.get("plugin:plugin-a:invalid-posture-policy")).toBeUndefined();
  });

  it("preserves ordinary extension upsert replacement behavior", () => {
    const registry = new WorkflowExtensionRegistry();
    const original = extension();
    const registered = registry.register("plugin-a", original);
    expect(registered.extension).toBe(original);
    original.name = "Caller Updated Move Policy";
    expect(registry.get(registered.id)?.extension.name).toBe("Caller Updated Move Policy");
    const listed = registry.list();
    expect(Object.isFrozen(listed)).toBe(false);
    listed.pop();
    expect(registry.get(registered.id)).toBe(registered);

    const replacement = {
      ...extension(),
      name: "Updated Move Policy",
    };

    const upserted = registry.upsert("plugin-a", replacement);

    expect(upserted).toBe(registered);
    expect(upserted.extension).toBe(replacement);
    expect(upserted.extension.name).toBe("Updated Move Policy");
    expect(upserted.degraded).toBeUndefined();
  });

  it("rejects duplicate ids", () => {
    const registry = new WorkflowExtensionRegistry();
    registry.register("plugin-a", extension());

    expect(() => registry.register("plugin-a", extension())).toThrow(WorkflowExtensionRegistrationError);
  });

  it("unregisters all extensions for a plugin", () => {
    const registry = new WorkflowExtensionRegistry();
    registry.register("plugin-a", extension("move-policy"));
    registry.register("plugin-a", extension("work-engine", "work-engine"));
    registry.register("plugin-b", extension("move-policy"));

    expect(registry.unregisterPlugin("plugin-a")).toEqual([
      "plugin:plugin-a:move-policy",
      "plugin:plugin-a:work-engine",
    ]);
    expect(registry.list()).toHaveLength(1);
  });

  it("marks extensions degraded without removing definitions", () => {
    const registry = new WorkflowExtensionRegistry();
    registry.register("plugin-a", extension());

    expect(registry.degrade(["plugin:plugin-a:move-policy"], "force-disabled", "disabled")).toEqual([
      "plugin:plugin-a:move-policy",
    ]);
    expect(registry.get("plugin:plugin-a:move-policy")?.degraded).toEqual({
      reason: "force-disabled",
      message: "disabled",
    });
  });
});
