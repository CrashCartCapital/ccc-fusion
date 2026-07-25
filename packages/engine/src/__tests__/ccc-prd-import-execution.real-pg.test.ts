import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  CCC_PRD_PROOF_ADMISSION_SCHEMA_VERSION,
  WORKFLOW_EXTENSION_SCHEMA_VERSION,
  __resetWorkflowExtensionRegistryForTests,
  computeCccPrdProofDefinitionSha256,
  deriveWorkflowExtensionHostProvenance,
  getWorkflowExtensionHostProvenanceBinding,
  getWorkflowExtensionRegistry,
  importCccPrdBundle,
  reconcileCccPrdImport,
  type CccPrdProof,
  type WorkflowProofAdmissionEvaluator,
} from "@fusion/core";
import {
  createCccPrdImportTestExecutionPolicy,
  createCccPrdImportTestBundle,
  rehashCccPrdImportTestBundle,
} from "../../../core/src/__test-utils__/ccc-prd-import-fixture.js";
import {
  createTaskStoreForTest,
  pgDescribe,
} from "../../../core/src/__test-utils__/pg-test-harness.js";
import {
  CCC_CAMPAIGN_PROOF_ADMISSION_EXTENSION_ID,
  CCC_CAMPAIGN_PROOF_ADMISSION_PLUGIN_ID,
  CCC_CAMPAIGN_PROOF_ADMISSION_PLUGIN_VERSION,
  CCC_CAMPAIGN_PROOF_ADMISSION_PROOF_VERSION,
} from "../ccc-campaign-proof-admission.js";
import { WorkflowTaskRuntime } from "../workflow-task-runtime.js";
import { processDueWorkflowWorkItem } from "../workflow-work-processor.js";

pgDescribe("CCC PRD imported workflow execution", () => {
  it("claims the imported runnable item through the fenced full-graph processor", async () => {
    const harness = await createTaskStoreForTest({
      prefix: "fusion_ccc_prd_execute",
      copyFromGolden: true,
    });
    const proofRoot = await mkdtemp(join(tmpdir(), "fusion-ccc-proof-host-"));
    try {
      const suffix = "engine-execution";
      const semanticBundle = await admittedBundle(harness.rootDir, suffix, proofRoot);
      await importCccPrdBundle({
        bundle: semanticBundle,
        executionPolicy: createCccPrdImportTestExecutionPolicy(semanticBundle),
        idempotencyKey: "idem-engine-execution",
        store: harness.store,
        layer: harness.layer,
        rootDir: harness.rootDir,
      });
      await reconcileCccPrdImport({
        idempotencyKey: "idem-engine-execution",
        store: harness.store,
        layer: harness.layer,
        rootDir: harness.rootDir,
      });
      expect(await harness.store.listDueWorkflowWorkItems({ kinds: ["task"] })).toEqual([
        expect.objectContaining({ id: `WORK-${suffix}`, state: "runnable" }),
      ]);
      const handler = vi.fn(async (node: { id: string }) => ({
        outcome: "success" as const,
        context: { [`handled:${node.id}`]: true },
      }));
      const runtime = new WorkflowTaskRuntime({
        store: harness.store,
        primitives: {} as never,
        runCustomNode: async () => ({ outcome: "success" }),
        handlers: { prompt: handler },
      });
      const directRunWorkItem = vi.spyOn(runtime, "runWorkItem");
      // The imported fixture has no separately admitted Mission lineage. Keep
      // the real TaskStore persistence seam, while taking the scheduler's
      // documented non-mission fallback rather than testing Mission policy here.
      const processorStore = Object.assign(Object.create(harness.store), {
        getMissionStore: undefined,
        acquireSymbolLocks: undefined,
      });
      const processed = await processDueWorkflowWorkItem(processorStore, runtime, {}, {
        leaseOwner: "ccc-prd-test-processor",
        leaseDurationMs: 60_000,
        kinds: ["task"],
      });
      const durable = await harness.store.getWorkflowWorkItem(`WORK-${suffix}`);
      const audits = await harness.store.getRunAuditEventsAsync({
        mutationType: "ccc-campaign:proof-admission",
        limit: 20,
      });

      expect(processed.runtime?.reason).toBeUndefined();
      expect(processed).toMatchObject({
        claimed: true,
        workItemId: `WORK-${suffix}`,
        taskId: `TASK-${suffix}`,
        runtime: {
          disposition: "completed",
          outcome: "success",
        },
      });
      expect(directRunWorkItem).not.toHaveBeenCalled();
      expect(processed.runtime?.visitedNodeIds).toEqual([
        "start",
        cccTaskNodeId(`TASK-${suffix}`),
        cccTaskNodeId(`TASK-terminal-${suffix}`),
      ]);
      expect(handler.mock.calls.map(([node]) => node.id)).toEqual([
        cccTaskNodeId(`TASK-${suffix}`),
        cccTaskNodeId(`TASK-terminal-${suffix}`),
      ]);
      expect(durable).toMatchObject({
        state: "succeeded",
        taskId: `TASK-${suffix}`,
      });
      expect(audits).toHaveLength(2);
      expect(audits.map((event) => event.campaign?.binding.taskId)).toEqual([
        `TASK-${suffix}`,
        `TASK-terminal-${suffix}`,
      ]);
    } finally {
      __resetWorkflowExtensionRegistryForTests();
      await rm(proofRoot, { recursive: true, force: true });
      await harness.teardown();
    }
  });
});

async function admittedBundle(targetRoot: string, suffix: string, proofRoot: string) {
  const baseSource = createCccPrdImportTestBundle(targetRoot, suffix);
  const source = {
    ...baseSource,
    requirements: baseSource.requirements.map((requirement) => ({
      ...requirement,
      statement: "Verify the synthetic imported-workflow proof binding.",
      acceptance: "The exact synthetic proof declaration is evaluated before workflow execution.",
    })),
  };
  await mkdir(join(proofRoot, "dist"), { recursive: true });
  const entryBytes = Buffer.from([
    "export async function evaluateTestProof(input) {",
    "  const proof = input.proof;",
    "  const matches = proof.command === 'ccc-test:import-workflow-binding.v1'",
    "    && proof.positiveOracle === 'the synthetic imported-workflow binding is verified'",
    "    && Array.isArray(proof.negativeControls)",
    "    && proof.negativeControls.length === 1",
    "    && proof.negativeControls[0] === 'a changed synthetic declaration is refused';",
    "  return Object.freeze({",
    "    outcome: matches ? 'pass' : 'fail',",
    "    evaluatedInputSha256: input.inputSha256,",
    "    summary: matches ? 'synthetic imported-workflow binding verified' : 'synthetic imported-workflow declaration refused',",
    "  });",
    "}",
    "",
  ].join("\n"), "utf8");
  await writeFile(join(proofRoot, "dist", "proof.mjs"), entryBytes);
  await writeFile(
    join(proofRoot, "plugin.json"),
    `${JSON.stringify({ id: CCC_CAMPAIGN_PROOF_ADMISSION_PLUGIN_ID, version: CCC_CAMPAIGN_PROOF_ADMISSION_PLUGIN_VERSION })}\n`,
  );
  const provenance = await deriveWorkflowExtensionHostProvenance({
    pluginId: CCC_CAMPAIGN_PROOF_ADMISSION_PLUGIN_ID,
    pluginVersion: CCC_CAMPAIGN_PROOF_ADMISSION_PLUGIN_VERSION,
    trustedRootPath: proofRoot,
    entryRelativePath: "dist/proof.mjs",
    manifestRelativePath: "plugin.json",
  });
  const binding = getWorkflowExtensionHostProvenanceBinding(provenance);
  const definition = source.proofs[0]!;
  const supportedDefinition: CccPrdProof = {
    ...definition,
    command: "ccc-test:import-workflow-binding.v1",
    positiveOracle: "the synthetic imported-workflow binding is verified",
    negativeControls: ["a changed synthetic declaration is refused"],
  };
  const proof: CccPrdProof = {
    ...supportedDefinition,
    admission: {
      schema: CCC_PRD_PROOF_ADMISSION_SCHEMA_VERSION,
      pluginId: binding.pluginId,
      pluginVersion: binding.pluginVersion,
      extensionId: CCC_CAMPAIGN_PROOF_ADMISSION_EXTENSION_ID,
      proofVersion: CCC_CAMPAIGN_PROOF_ADMISSION_PROOF_VERSION,
      extensionRootRelativeSource: binding.extensionRootRelativeSource,
      extensionSourceSha256: binding.extensionSourceSha256,
      extensionManifestSha256: binding.extensionManifestSha256,
      definitionSha256: computeCccPrdProofDefinitionSha256(supportedDefinition),
    },
  };
  __resetWorkflowExtensionRegistryForTests();
  const entryModule = await import(`data:text/javascript;base64,${entryBytes.toString("base64")}`) as {
    evaluateTestProof?: WorkflowProofAdmissionEvaluator;
  };
  if (typeof entryModule.evaluateTestProof !== "function") {
    throw new Error("test proof entry did not export evaluateTestProof");
  }
  getWorkflowExtensionRegistry().register(
    CCC_CAMPAIGN_PROOF_ADMISSION_PLUGIN_ID,
    {
      extensionId: CCC_CAMPAIGN_PROOF_ADMISSION_EXTENSION_ID,
      name: "CCC proof admission",
      kind: "proof-admission",
      schemaVersion: WORKFLOW_EXTENSION_SCHEMA_VERSION,
      fallback: "failClosed",
      proofVersion: CCC_CAMPAIGN_PROOF_ADMISSION_PROOF_VERSION,
      evaluate: entryModule.evaluateTestProof,
    },
    provenance,
  );
  return rehashCccPrdImportTestBundle({ ...source, proofs: [proof] });
}

function cccTaskNodeId(taskId: string): string {
  return `ccc-task-${createHash("sha256").update(taskId, "utf8").digest("hex").slice(0, 24)}`;
}
