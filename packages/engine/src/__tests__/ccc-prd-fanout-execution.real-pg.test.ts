/**
 * Series-parallel (fan-out/join) CCC campaign execution through the fenced
 * full-graph processor.
 *
 * Mirrors ccc-prd-import-execution.real-pg.test.ts, with the bundle reshaped
 * into the smallest diamond: TASK-A -> {TASK-B, TASK-C} -> TASK-D. The importer
 * synthesizes explicit split/join IR (pinned by the core import PG test); this
 * test proves the ENGINE side: the imported runnable work item is claimed by
 * the fenced processor and the whole graph executes — entry task first, both
 * branch tasks after it, the join task last — under the campaign's irHash
 * fence, with one proof-admission audit per task.
 */
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
  inspectCccPrdProductStatus,
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

pgDescribe("CCC PRD imported fan-out workflow execution", () => {
  it("claims the imported diamond and executes entry, both branches, then the join", async () => {
    const harness = await createTaskStoreForTest({
      prefix: "fusion_ccc_prd_fanout",
      copyFromGolden: true,
    });
    const proofRoot = await mkdtemp(join(tmpdir(), "fusion-ccc-proof-host-"));
    try {
      const suffix = "engine-fanout";
      const semanticBundle = await admittedFanOutBundle(harness.rootDir, suffix, proofRoot);
      const idempotencyKey = "idem-engine-fanout";
      const imported = await importCccPrdBundle({
        bundle: semanticBundle,
        executionPolicy: createCccPrdImportTestExecutionPolicy(semanticBundle),
        idempotencyKey,
        store: harness.store,
        layer: harness.layer,
        rootDir: harness.rootDir,
      });
      await reconcileCccPrdImport({
        idempotencyKey,
        store: harness.store,
        layer: harness.layer,
        rootDir: harness.rootDir,
      });
      const productStatus = await inspectCccPrdProductStatus({
        idempotencyKey,
        layer: harness.layer,
        rootDir: harness.rootDir,
      });
      if (!productStatus) throw new Error("missing imported product status");
      expect(productStatus.import.importId).toBe(imported.importId);
      const nativeBySemantic = new Map(
        productStatus.tasks.map(({ semanticTaskId, nativeTaskId }) => [
          semanticTaskId,
          nativeTaskId,
        ]),
      );
      const semanticIds = {
        entry: `TASK-${suffix}`,
        branchB: `TASK-${suffix}-B`,
        branchC: `TASK-${suffix}-C`,
        joinTask: `TASK-terminal-${suffix}`,
      };
      const nativeIds = Object.fromEntries(
        Object.entries(semanticIds).map(([key, semanticTaskId]) => {
          const nativeTaskId = nativeBySemantic.get(semanticTaskId);
          expect(nativeTaskId, `native id for ${semanticTaskId}`).toEqual(expect.any(String));
          return [key, nativeTaskId!];
        }),
      ) as Record<keyof typeof semanticIds, string>;
      // The join task's persisted row carries BOTH predecessors — the seam the
      // executor's join-base resolution reads.
      const joinTaskRow = await harness.store.getTask(nativeIds.joinTask);
      expect([...(joinTaskRow.dependencies ?? [])].sort()).toEqual(
        [nativeIds.branchB, nativeIds.branchC].sort(),
      );

      const workItemId = `${imported.importId}--WORK-${suffix}`;
      expect(await harness.store.listDueWorkflowWorkItems({ kinds: ["task"] })).toEqual([
        expect.objectContaining({
          id: workItemId,
          taskId: nativeIds.entry,
          state: "runnable",
        }),
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
        branchPersistence: {
          saveBranchState: (state) =>
            harness.store.saveWorkflowRunBranch(state),
          loadBranchStates: (taskId, runId) =>
            harness.store.loadWorkflowRunBranches(taskId, runId),
          clearStaleBranchStates: (taskId, keepRunId) =>
            harness.store.clearWorkflowRunBranches(taskId, keepRunId),
        },
      });
      const directRunWorkItem = vi.spyOn(runtime, "runWorkItem");
      const processorStore = Object.assign(Object.create(harness.store), {
        getMissionStore: undefined,
        acquireSymbolLocks: undefined,
      });
      const processed = await processDueWorkflowWorkItem(processorStore, runtime, {}, {
        leaseOwner: "ccc-prd-fanout-test-processor",
        leaseDurationMs: 60_000,
        kinds: ["task"],
      });
      const durable = await harness.store.getWorkflowWorkItem(workItemId);
      const audits = await harness.store.getRunAuditEventsAsync({
        mutationType: "ccc-campaign:proof-admission",
        limit: 20,
      });

      expect(processed.runtime?.reason).toBeUndefined();
      expect(processed).toMatchObject({
        claimed: true,
        workItemId,
        taskId: nativeIds.entry,
        runtime: {
          disposition: "completed",
          outcome: "success",
        },
      });
      expect(directRunWorkItem).not.toHaveBeenCalled();

      // Every prompt node executed exactly once; the entry ran first, the join
      // last, and both branches ran between them (branch order is concurrent
      // and deliberately unpinned).
      const executedNodeIds = handler.mock.calls.map(([node]) => node.id);
      expect([...executedNodeIds].sort()).toEqual([
        cccTaskNodeId(semanticIds.entry),
        cccTaskNodeId(semanticIds.branchB),
        cccTaskNodeId(semanticIds.branchC),
        cccTaskNodeId(semanticIds.joinTask),
      ].sort());
      expect(executedNodeIds[0]).toBe(cccTaskNodeId(semanticIds.entry));
      expect(executedNodeIds[3]).toBe(cccTaskNodeId(semanticIds.joinTask));

      // The traversal surfaced the synthesized split/join structure.
      const visited = processed.runtime?.visitedNodeIds ?? [];
      expect(visited[0]).toBe("start");
      expect(visited).toContain(cccSplitNodeId(semanticIds.entry));
      expect(visited).toContain(cccJoinNodeId(semanticIds.joinTask));
      expect(visited.indexOf(cccSplitNodeId(semanticIds.entry)))
        .toBeLessThan(visited.indexOf(cccJoinNodeId(semanticIds.joinTask)));
      expect(visited.indexOf(cccJoinNodeId(semanticIds.joinTask)))
        .toBeLessThan(visited.indexOf(cccTaskNodeId(semanticIds.joinTask)));

      expect(durable).toMatchObject({
        state: "succeeded",
        taskId: nativeIds.entry,
      });
      // One proof-admission audit per campaign task; entry first, join last.
      expect(audits).toHaveLength(4);
      const auditTaskIds = audits.map((event) => event.campaign?.binding.taskId);
      expect(auditTaskIds[0]).toBe(nativeIds.entry);
      expect(auditTaskIds[3]).toBe(nativeIds.joinTask);
      expect([...auditTaskIds].sort()).toEqual(
        [nativeIds.entry, nativeIds.branchB, nativeIds.branchC, nativeIds.joinTask].sort(),
      );
    } finally {
      __resetWorkflowExtensionRegistryForTests();
      await rm(proofRoot, { recursive: true, force: true });
      await harness.teardown();
    }
  });
});

/**
 * The admitted two-task bundle from the shared fixture, reshaped into
 * TASK-<suffix> -> {TASK-<suffix>-B, TASK-<suffix>-C} -> TASK-terminal-<suffix>
 * with mirrored edges/dependencyTaskIds/import intents, plus the same
 * registered in-memory proof-admission evaluator the linear execution test
 * uses.
 */
async function admittedFanOutBundle(targetRoot: string, suffix: string, proofRoot: string) {
  const baseSource = createCccPrdImportTestBundle(targetRoot, suffix);
  const source = {
    ...baseSource,
    requirements: baseSource.requirements.map((requirement) => ({
      ...requirement,
      statement: "Verify the synthetic imported-workflow proof binding.",
      acceptance: "The exact synthetic proof declaration is evaluated before workflow execution.",
    })),
  };
  const [taskA, taskD] = source.tasks;
  if (!taskA || !taskD) throw new Error("fixture bundle must carry two tasks");
  const workflow = source.workflows[0];
  if (!workflow) throw new Error("fixture bundle must carry one workflow");
  const taskB = {
    ...taskD,
    id: `TASK-${suffix}-B`,
    title: "Diamond branch B",
    description: "First parallel branch.",
    dependencyTaskIds: [taskA.id],
    documentIds: [],
    artifactIds: [],
  };
  const taskC = {
    ...taskD,
    id: `TASK-${suffix}-C`,
    title: "Diamond branch C",
    description: "Second parallel branch.",
    dependencyTaskIds: [taskA.id],
    documentIds: [],
    artifactIds: [],
  };
  const edges = [
    { id: `EDGE-${suffix}-B-A`, fromTaskId: taskB.id, toTaskId: taskA.id, kind: "depends_on" as const },
    { id: `EDGE-${suffix}-C-A`, fromTaskId: taskC.id, toTaskId: taskA.id, kind: "depends_on" as const },
    { id: `EDGE-${suffix}-D-B`, fromTaskId: taskD.id, toTaskId: taskB.id, kind: "depends_on" as const },
    { id: `EDGE-${suffix}-D-C`, fromTaskId: taskD.id, toTaskId: taskC.id, kind: "depends_on" as const },
  ];
  const fanOutSource = {
    ...source,
    tasks: [
      { ...taskA, dependencyTaskIds: [] },
      { ...taskB, workflowId: workflow.id },
      { ...taskC, workflowId: workflow.id },
      { ...taskD, dependencyTaskIds: [taskB.id, taskC.id] },
    ],
    edges,
    workflows: [{
      ...workflow,
      taskIds: [taskA.id, taskB.id, taskC.id, taskD.id],
      entryTaskIds: [taskA.id],
      terminalTaskIds: [taskD.id],
    }],
    importIntents: [
      ...source.importIntents.filter((intent) =>
        intent.entityType !== "task" && intent.entityType !== "dependency_edge"),
      ...[taskA.id, taskB.id, taskC.id, taskD.id].map((entityId) => ({
        id: entityId,
        entityType: "task" as const,
        entityId,
        operation: "create" as const,
        target: targetRoot,
      })),
      ...edges.map((edge) => ({
        id: edge.id,
        entityType: "dependency_edge" as const,
        entityId: edge.id,
        operation: "create" as const,
        target: targetRoot,
      })),
    ],
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
  const definition = fanOutSource.proofs[0]!;
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
  return rehashCccPrdImportTestBundle({ ...fanOutSource, proofs: [proof] });
}

function shortSha(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 24);
}

function cccTaskNodeId(taskId: string): string {
  return `ccc-task-${shortSha(taskId)}`;
}

function cccSplitNodeId(taskId: string): string {
  return `ccc-split-${shortSha(taskId)}`;
}

function cccJoinNodeId(taskId: string): string {
  return `ccc-join-${shortSha(taskId)}`;
}
