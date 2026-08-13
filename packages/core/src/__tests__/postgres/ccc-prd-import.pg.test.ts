/**
 * Phase C import-owned unit-of-work acceptance suite.
 *
 * This intentionally drives the public @fusion/core import surface against a
 * disposable loopback PostgreSQL database.  The importer owns its database
 * transaction and its staged filesystem projection: public TaskStore helpers
 * must not be called inside that transaction because they may commit, emit an
 * event, reserve an id, or project a runnable task independently.
 */

import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { beforeAll, beforeEach, afterAll, afterEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { CccPrdSemanticBundle } from "../../ccc-prd/index.js";
import {
  createCccCampaignManifest,
  hashCccCampaignManifest,
  canonicalCccPrdJson,
  CCC_PRD_REQUEST_BUDGET_BELOW_PROVIDER_TASK_FLOOR,
  importCccPrdBundle,
  inspectCccPrdImport,
  reconcileCccPrdImport,
} from "../../index.js";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import type { AsyncDataLayer, DbTransaction } from "../../postgres/data-layer.js";
import type { CccPrdImportEntityType } from "../../ccc-prd/types.js";
import {
  __resetWorkflowExtensionRegistryForTests,
  getWorkflowExtensionRegistry,
} from "../../workflow-extension-registry.js";
import { WORKFLOW_EXTENSION_SCHEMA_VERSION } from "../../workflow-extension-types.js";
import {
  CCC_PRD_TEST_BASE as BASE,
  createCccPrdImportTestExecutionPolicy as executionPolicy,
  createCccPrdImportTestProductExecutionPolicy as productExecutionPolicy,
  createCccPrdImportTestBundle as bundle,
  createCccPrdImportTestProductBundle as productBundle,
  rehashCccPrdImportTestBundle as rehashBundle,
} from "../../__test-utils__/ccc-prd-import-fixture.js";
import { buildCccPrdProjection } from "../../ccc-prd/projection.js";

const pgTest = pgDescribe;

// Keep the API contract RED even on a machine whose loopback PostgreSQL user
// is not configured. The PostgreSQL suite below remains the behavioral proof.
describe("CCC PRD import public surface", () => {
  it("exports the import, inspection, and reconciliation entry points", () => {
    expect(importCccPrdBundle).toBeTypeOf("function");
    expect(inspectCccPrdImport).toBeTypeOf("function");
    expect(reconcileCccPrdImport).toBeTypeOf("function");
  });

  it("uses canonical semantic content, not a fixed fixture literal, for bundle identity", () => {
    expect(bundle("/tmp/phase-c", "one").bundleHash).not.toBe(bundle("/tmp/phase-c", "two").bundleHash);
  });
});

function withSharedGlobalIds(
  source: CccPrdSemanticBundle,
  workflowId: string,
  artifactId: string,
): CccPrdSemanticBundle {
  const previousWorkflowId = source.workflows[0]!.id;
  const previousArtifactId = source.artifacts[0]!.id;
  return rehashBundle({
    ...source,
    tasks: source.tasks.map((task) => ({
      ...task,
      workflowId: task.workflowId === previousWorkflowId ? workflowId : task.workflowId,
      artifactIds: task.artifactIds.map((id) => id === previousArtifactId ? artifactId : id),
    })),
    workflows: source.workflows.map((workflow) => ({
      ...workflow,
      id: workflow.id === previousWorkflowId ? workflowId : workflow.id,
    })),
    artifacts: source.artifacts.map((artifact) => ({
      ...artifact,
      id: artifact.id === previousArtifactId ? artifactId : artifact.id,
    })),
    importIntents: source.importIntents.map((intent) => {
      if (intent.entityType === "workflow") {
        return { ...intent, id: workflowId, entityId: workflowId };
      }
      if (intent.entityType === "artifact") {
        return { ...intent, id: artifactId, entityId: artifactId };
      }
      return intent;
    }),
  });
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

type FailureCheckpoint =
  | "campaign"
  | "task"
  | "dependency_edge"
  | "workflow"
  | "document"
  | "artifact"
  | "source"
  | "work_item"
  | "run_audit"
  | "task_directory"
  | "task_json"
  | "prompt"
  | "artifact_bytes"
  | "canonical_projection_move"
  | "after_prepared_db_commit"
  | "before_activation"
  | "activation_handoff"
  | "after_activation"
  | "lost_response_after_commit";

pgTest("CCC PRD import-owned PostgreSQL/filesystem unit of work", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_ccc_prd_import",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterEach(__resetWorkflowExtensionRegistryForTests);
  afterAll(h.afterAll);

  function registerWorkflowProviderExtension(extensionId: string): void {
    __resetWorkflowExtensionRegistryForTests();
    getWorkflowExtensionRegistry().register("ccc-campaign", {
      extensionId: extensionId.replace("plugin:ccc-campaign:", ""),
      name: "CCC campaign provider dispatch",
      kind: "node-handler",
      nodeKind: "prompt",
      schemaVersion: WORKFLOW_EXTENSION_SCHEMA_VERSION,
      fallback: "failClosed",
    });
  }

  function request(suffix = "base", key = "idem-base", checkpoint?: FailureCheckpoint) {
    const semanticBundle = productBundle(h.rootDir(), suffix);
    return {
      bundle: semanticBundle,
      executionPolicy: executionPolicy(semanticBundle),
      idempotencyKey: key,
      store: h.store(),
      layer: h.layer(),
      rootDir: h.rootDir(),
      failureInjection: checkpoint ? { checkpoint } : undefined,
    };
  }

  /**
   * TASK-<suffix> -> {TASK-<suffix>-B, TASK-<suffix>-C} -> TASK-terminal-<suffix>:
   * the base two-task bundle reshaped into the smallest fan-out/join. Ids stay
   * derivable from the suffix so tests can address every task without
   * threading the bundle around.
   */
  function fanOutJoinBundle(suffix: string): CccPrdSemanticBundle {
    const base = bundle(h.rootDir(), suffix);
    const [taskA, taskD] = base.tasks;
    expect(taskA).toBeDefined();
    expect(taskD).toBeDefined();
    const workflow = base.workflows[0]!;
    const taskB = {
      ...taskD!,
      id: `TASK-${suffix}-B`,
      title: "Diamond branch B",
      description: "First parallel branch.",
      dependencyTaskIds: [taskA!.id],
      documentIds: [],
      artifactIds: [],
    };
    const taskC = {
      ...taskD!,
      id: `TASK-${suffix}-C`,
      title: "Diamond branch C",
      description: "Second parallel branch.",
      dependencyTaskIds: [taskA!.id],
      documentIds: [],
      artifactIds: [],
    };
    return rehashBundle({
      ...base,
      bounds: { ...base.bounds, maxRequests: 4 },
      tasks: [
        { ...taskA!, dependencyTaskIds: [] },
        { ...taskB, workflowId: workflow.id },
        { ...taskC, workflowId: workflow.id },
        { ...taskD!, dependencyTaskIds: [taskB.id, taskC.id] },
      ],
      edges: [
        { id: `EDGE-${suffix}-B-A`, fromTaskId: taskB.id, toTaskId: taskA!.id, kind: "depends_on" },
        { id: `EDGE-${suffix}-C-A`, fromTaskId: taskC.id, toTaskId: taskA!.id, kind: "depends_on" },
        { id: `EDGE-${suffix}-D-B`, fromTaskId: taskD!.id, toTaskId: taskB.id, kind: "depends_on" },
        { id: `EDGE-${suffix}-D-C`, fromTaskId: taskD!.id, toTaskId: taskC.id, kind: "depends_on" },
      ],
      workflows: [{
        ...workflow,
        taskIds: [taskA!.id, taskB.id, taskC.id, taskD!.id],
        entryTaskIds: [taskA!.id],
        terminalTaskIds: [taskD!.id],
      }],
      importIntents: [
        ...base.importIntents.filter((intent) => intent.entityType !== "task" && intent.entityType !== "dependency_edge"),
        ...[taskA!.id, taskB.id, taskC.id, taskD!.id].map((entityId) => ({
          id: entityId,
          entityType: "task" as const,
          entityId,
          operation: "create" as const,
          target: h.rootDir(),
        })),
        ...[`EDGE-${suffix}-B-A`, `EDGE-${suffix}-C-A`, `EDGE-${suffix}-D-B`, `EDGE-${suffix}-D-C`].map((entityId) => ({
          id: entityId,
          entityType: "dependency_edge" as const,
          entityId,
          operation: "create" as const,
          target: h.rootDir(),
        })),
      ],
    });
  }

  async function assertNoExternalEffects() {
    const receiptRows = (await h.layer().db.execute(sql`
      SELECT count(*)::int AS count
      FROM project.ccc_effect_receipts
    `)) as unknown as Array<{ count: number }>;
    expect(receiptRows).toEqual([{ count: 0 }]);
    const foreignAuditDomains = (await h.layer().db.execute(sql`
      SELECT DISTINCT domain
      FROM project.run_audit_events
      WHERE domain <> 'database'
      ORDER BY domain
    `)) as unknown as Array<{ domain: string }>;
    expect(foreignAuditDomains).toEqual([]);
  }

  async function assertImportAuditHistory(importId: string) {
    const rows = (await h.layer().db.execute(sql`
      SELECT mutation_type, domain
      FROM project.run_audit_events
      WHERE run_id = ${`ccc-prd:${importId}`}
      ORDER BY mutation_type
    `)) as unknown as Array<{ mutation_type: string; domain: string }>;
    expect(rows).toEqual([
      { mutation_type: "ccc-prd-import:active", domain: "database" },
      { mutation_type: "ccc-prd-import:prepared", domain: "database" },
    ]);
  }

  async function readProjectionClaim(key: string) {
    const rows = (await h.layer().db.execute(sql`
      SELECT state, projection_owner, projection_lease_until
      FROM project.ccc_prd_imports
      WHERE idempotency_key = ${key}
    `)) as unknown as Array<{
      state: string;
      projection_owner: string | null;
      projection_lease_until: string | null;
    }>;
    return rows[0];
  }

  async function waitPastProjectionLease(claim: { projection_lease_until: string | null }): Promise<number> {
    const initialLeaseUntilMs = Date.parse(claim.projection_lease_until ?? "");
    expect(Number.isFinite(initialLeaseUntilMs)).toBe(true);
    await new Promise((resolveDelay) => {
      setTimeout(resolveDelay, Math.max(0, initialLeaseUntilMs - Date.now() + 150));
    });
    return initialLeaseUntilMs;
  }

  async function assertNoRunnableState(key: string) {
    const inspection = await inspectCccPrdImport({ idempotencyKey: key, layer: h.layer(), rootDir: h.rootDir() });
    expect(inspection?.state ?? "absent").not.toBe("active");
    expect(await h.store().listTasks()).toHaveLength(0);
  }

  async function nativeTaskIdForImport(
    importId: string,
    semanticTaskId: string,
  ): Promise<string> {
    const rows = await h.layer().db.execute(sql`
      SELECT native_id
      FROM project.ccc_prd_import_entities
      WHERE import_id = ${importId}
        AND entity_type = 'task'
        AND entity_id = ${semanticTaskId}
    `) as unknown as Array<{ native_id: string }>;
    expect(rows).toHaveLength(1);
    return rows[0]!.native_id;
  }

  async function canonicalProjectionPaths(suffix: string, importId?: string) {
    const semanticTaskId = `TASK-${suffix}`;
    const taskId = importId
      ? await nativeTaskIdForImport(importId, semanticTaskId)
      : semanticTaskId;
    const taskDir = h.store().taskDir(taskId);
    return {
      taskDir,
      taskJson: join(taskDir, "task.json"),
      prompt: join(taskDir, "PROMPT.md"),
      artifact: join(h.store().artifactRegistryDir(), importId ? `${importId}--ART-${suffix}` : `ART-${suffix}`),
    };
  }

  async function assertPreparedStagingOnly(
    inspection: { importId?: unknown; stagingRelativePath?: unknown },
    suffix: string,
    checkpoint: FailureCheckpoint,
  ) {
    expect(inspection.importId).toEqual(expect.any(String));
    const projection = await canonicalProjectionPaths(suffix, inspection.importId as string);
    const stagingRoot = join(h.rootDir(), ".fusion", "ccc-prd-import-staging");
    expect(inspection.stagingRelativePath).toEqual(expect.any(String));
    const stagingRelativePath = inspection.stagingRelativePath as string;
    expect(isAbsolute(stagingRelativePath)).toBe(false);
    const stagingPath = resolve(h.rootDir(), stagingRelativePath);
    const descendant = relative(stagingRoot, stagingPath);
    expect(descendant && !descendant.startsWith(`..${sep}`) && descendant !== "..").toBe(true);
    if (checkpoint === "after_prepared_db_commit") {
      expect(await fileExists(stagingPath)).toBe(false);
      expect(await fileExists(projection.taskDir)).toBe(false);
      expect(await fileExists(projection.artifact)).toBe(false);
      return;
    }
    expect(await fileExists(join(stagingPath, "manifest.json"))).toBe(true);

    const earlyStagingCheckpoint =
      checkpoint !== "canonical_projection_move"
      && checkpoint !== "before_activation"
      && checkpoint !== "after_activation";
    if (earlyStagingCheckpoint) {
      expect(await fileExists(projection.taskDir)).toBe(false);
      expect(await fileExists(projection.taskJson)).toBe(false);
      expect(await fileExists(projection.prompt)).toBe(false);
      expect(await fileExists(projection.artifact)).toBe(false);
      return;
    }

    // The canonical filesystem mirror must never independently advertise
    // runnable work. PostgreSQL is the sole activation authority.
    if (await fileExists(projection.taskJson)) {
      expect(JSON.parse(await readFile(projection.taskJson, "utf8"))).toMatchObject({
        state: "prepared",
        runnable: false,
      });
    }
  }

  it.each<FailureCheckpoint>([
    "campaign", "task", "dependency_edge", "workflow", "document", "artifact", "source", "work_item", "run_audit",
  ])("rolls back every database entity/final-audit boundary without effects: %s", async (checkpoint) => {
    await expect(importCccPrdBundle(request("rollback", `idem-${checkpoint}`, checkpoint))).rejects.toMatchObject({ code: "CCC_PRD_IMPORT_INJECTED_FAILURE" });
    await assertNoRunnableState(`idem-${checkpoint}`);
    const projection = await canonicalProjectionPaths("rollback");
    expect(await fileExists(projection.taskDir)).toBe(false);
    expect(await fileExists(projection.taskJson)).toBe(false);
    expect(await fileExists(projection.prompt)).toBe(false);
    expect(await fileExists(projection.artifact)).toBe(false);
    await assertNoExternalEffects();
  });

  it.each<FailureCheckpoint>(["after_prepared_db_commit", "task_directory", "task_json", "prompt", "artifact_bytes", "canonical_projection_move", "before_activation"])("leaves only a prepared, non-runnable state across projection boundary: %s", async (checkpoint) => {
    const key = `idem-prepared-${checkpoint}`;
    const suffix = `prepared-${checkpoint}`;
    await expect(importCccPrdBundle(request(suffix, key, checkpoint))).rejects.toMatchObject({ code: "CCC_PRD_IMPORT_INJECTED_FAILURE" });
    const before = await inspectCccPrdImport({ idempotencyKey: key, layer: h.layer(), rootDir: h.rootDir() });
    expect(before).toMatchObject({
      state: "prepared",
      runnable: false,
      // This is the smallest feasible same-transaction assertion without
      // wrapping private AsyncDataLayer internals: inspect must expose the one
      // import transaction and all DB writer classes it admitted. A future API
      // may replace this witness with a test-only transaction identity probe.
      transactionWitness: {
        transactionId: expect.any(String),
        writerClasses: ["campaign", "task", "dependency_edge", "workflow", "document", "artifact", "source", "work_item", "run_audit"],
      },
    });
    const nativeTaskId = await nativeTaskIdForImport(
      before!.importId,
      `TASK-${suffix}`,
    );
    expect(await h.store().getTask(nativeTaskId)).toMatchObject({
      column: "triage",
      status: "ccc-prd-import-prepared",
      paused: true,
      userPaused: true,
    });
    const nativeWorkItemId =
      `${before!.importId}--WORK-${suffix}`;
    expect(await h.store().getWorkflowWorkItem(nativeWorkItemId)).toMatchObject({
      state: "held",
      blockedReason: "ccc-prd-import-prepared",
    });
    await assertPreparedStagingOnly(before ?? {}, suffix, checkpoint);
    await assertNoExternalEffects();

    // Restart before reconciliation. Normal list/show is intentionally not
    // used as a non-runnable oracle: legacy paused triage tasks may be listed.
    const { TaskStore } = await import("../../store.js");
    const restarted = new TaskStore(h.rootDir(), undefined, { asyncLayer: h.layer() });
    const reconciled = await reconcileCccPrdImport({ idempotencyKey: key, layer: h.layer(), store: restarted, rootDir: h.rootDir() });
    expect(reconciled).toMatchObject({ state: "active", runnable: true });
    expect(await restarted.getTask(nativeTaskId)).toMatchObject({
      column: "todo",
      status: "queued",
    });
    expect(await restarted.getWorkflowWorkItem(nativeWorkItemId)).toMatchObject({
      state: "runnable",
      blockedReason: null,
    });
    expect(await fileExists(resolve(h.rootDir(), reconciled.stagingRelativePath))).toBe(false);
    await assertNoExternalEffects();
    await assertImportAuditHistory(reconciled.importId);
  });

  it("recovers a lost response after the activation commit without runnable filesystem drift", async () => {
    const key = "idem-after-activation";
    const suffix = "after-activation";
    await expect(importCccPrdBundle(request(suffix, key, "after_activation"))).rejects.toMatchObject({
      code: "CCC_PRD_IMPORT_INJECTED_FAILURE",
    });
    const committed = await inspectCccPrdImport({
      idempotencyKey: key,
      layer: h.layer(),
      rootDir: h.rootDir(),
    });
    expect(committed).toMatchObject({ state: "active", runnable: true });
    const projection = await canonicalProjectionPaths(suffix, committed?.importId);
    expect(JSON.parse(await readFile(projection.taskJson, "utf8"))).toMatchObject({
      state: "prepared",
      runnable: false,
    });
    expect(await fileExists(resolve(h.rootDir(), committed!.stagingRelativePath))).toBe(true);

    const { TaskStore } = await import("../../store.js");
    const restarted = new TaskStore(h.rootDir(), undefined, { asyncLayer: h.layer() });
    await expect(reconcileCccPrdImport({
      idempotencyKey: key,
      layer: h.layer(),
      store: restarted,
      rootDir: h.rootDir(),
    })).resolves.toMatchObject({ state: "active", runnable: true, replayed: true });
    expect(await fileExists(resolve(h.rootDir(), committed!.stagingRelativePath))).toBe(false);
  });

  it("observes every preparation writer on one actual DbTransaction with no nested or top-level writes", async () => {
    const baseLayer = h.layer();
    let preparing = false;
    let prepareTx: DbTransaction | null = null;
    let nestedTransactions = 0;
    let directLayerDbWrites = 0;
    const observedWriters: CccPrdImportEntityType[] = [];
    const mutationMethods = new Set<PropertyKey>(["delete", "execute", "insert", "update"]);
    const guardedDb = new Proxy(baseLayer.db as object, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (mutationMethods.has(property)) {
          return (..._args: unknown[]) => {
            directLayerDbWrites += 1;
            throw new Error(`top-level AsyncDataLayer.db mutation refused: ${String(property)}`);
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as AsyncDataLayer["db"];
    const guardedLayer: AsyncDataLayer = {
      ...baseLayer,
      db: guardedDb,
      transaction: async (fn, options) => {
        if (preparing) nestedTransactions += 1;
        return baseLayer.transaction(fn, options);
      },
      transactionImmediate: async (fn, options) => {
        if (preparing) nestedTransactions += 1;
        return baseLayer.transactionImmediate(fn, options);
      },
    };
    const transactionProbe = {
      onPrepareTransaction(tx: DbTransaction) {
        expect(prepareTx).toBeNull();
        prepareTx = tx;
        preparing = true;
      },
      onWriter(writerClass: CccPrdImportEntityType, tx: DbTransaction) {
        expect(tx).toBe(prepareTx);
        observedWriters.push(writerClass);
      },
      onPrepareComplete(tx: DbTransaction) {
        expect(tx).toBe(prepareTx);
        preparing = false;
      },
    };

    const imported = await importCccPrdBundle({
      ...request("transaction-observed", "idem-transaction-observed"),
      layer: guardedLayer,
      transactionProbe,
    });
    expect(imported.transactionWitness.writerClasses).toEqual(observedWriters);
    expect(observedWriters).toEqual([
      "campaign",
      "task",
      "dependency_edge",
      "workflow",
      "document",
      "artifact",
      "source",
      "work_item",
      "run_audit",
    ]);
    expect(nestedTransactions).toBe(0);
    expect(directLayerDbWrites).toBe(0);
  });

  it("invalidates native workflow caches only after the prepared database transaction commits", async () => {
    const key = "idem-cache-visibility";
    const suffix = "cache-visibility";
    const expectedNativeWorkflowId = `ccc-prd-${createHash("sha256")
      .update(`__legacy_unscoped__\0${key}`)
      .digest("hex")
      .slice(0, 32)}--WF-${suffix}`;
    expect((await h.store().listWorkflowDefinitions()).map(({ id }) => id)).not.toContain(expectedNativeWorkflowId);
    await importCccPrdBundle(request(suffix, key));
    expect((await h.store().listWorkflowDefinitions()).map(({ id }) => id)).toContain(expectedNativeWorkflowId);
  });

  it("Task 6 RED: imports explicit split join topology for a dependency diamond", async () => {
    const suffix = "task6-diamond";
    const key = "idem-task6-diamond";
    const diamond = fanOutJoinBundle(suffix);
    const idA = `TASK-${suffix}`;
    const idB = `TASK-${suffix}-B`;
    const idC = `TASK-${suffix}-C`;
    const idD = `TASK-terminal-${suffix}`;

    const imported = await importCccPrdBundle({
      ...request(suffix, key),
      bundle: diamond,
      executionPolicy: executionPolicy(diamond),
    });
    const stored = await h.store().getWorkflowDefinition(`${imported.importId}--WF-${suffix}`);
    const ir = stored?.ir as {
      version: string;
      columns: unknown[];
      nodes: Array<{ id: string; kind: string; config?: Record<string, unknown> }>;
      edges: Array<{ from: string; to: string }>;
    };
    const split = ir.nodes.find((node) => node.kind === "split");
    const join = ir.nodes.find((node) => node.kind === "join");
    const taskNodeId = (taskId: string) => `ccc-task-${createHash("sha256").update(taskId).digest("hex").slice(0, 24)}`;
    expect(ir.version).toBe("v2");
    expect(ir.columns).toEqual([]);
    expect(split).toBeDefined();
    expect(join).toBeDefined();
    expect(ir.edges).toContainEqual({ from: taskNodeId(idA), to: split!.id, condition: "success" });
    expect(ir.edges).toContainEqual({ from: split!.id, to: taskNodeId(idB), condition: "success" });
    expect(ir.edges).toContainEqual({ from: split!.id, to: taskNodeId(idC), condition: "success" });
    expect(ir.edges).toContainEqual({ from: taskNodeId(idB), to: join!.id, condition: "success" });
    expect(ir.edges).toContainEqual({ from: taskNodeId(idC), to: join!.id, condition: "success" });
    expect(ir.edges).toContainEqual({ from: join!.id, to: taskNodeId(idD), condition: "success" });
    expect(ir.edges).not.toContainEqual({ from: taskNodeId(idB), to: taskNodeId(idD), condition: "success" });
    expect(ir.edges).not.toContainEqual({ from: taskNodeId(idC), to: taskNodeId(idD), condition: "success" });
  });

  it("product v2 imports a fan-out join campaign: split join IR, proof barrier, and multi-predecessor dependencies", async () => {
    const suffix = "product-v2-fanout-join";
    const key = "idem-product-v2-fanout-join";
    const fanOut = fanOutJoinBundle(suffix);
    const policy = productExecutionPolicy(fanOut);
    const idA = `TASK-${suffix}`;
    const idB = `TASK-${suffix}-B`;
    const idC = `TASK-${suffix}-C`;
    const idD = `TASK-terminal-${suffix}`;

    const imported = await importCccPrdBundle({
      ...request(suffix, key),
      bundle: fanOut,
      executionPolicy: policy,
    });

    // Stored product IR: the fan-out is explicit split/join topology and the
    // single terminal still lands on the proof suite barrier before end.
    const stored = await h.store().getWorkflowDefinition(`${imported.importId}--WF-${suffix}`);
    const ir = stored?.ir as {
      version: string;
      nodes: Array<{ id: string; kind: string; config?: Record<string, unknown> }>;
      edges: Array<{ from: string; to: string }>;
    };
    const taskNodeId = (taskId: string) => `ccc-task-${createHash("sha256").update(taskId).digest("hex").slice(0, 24)}`;
    const split = ir.nodes.find((node) => node.kind === "split");
    const join = ir.nodes.find((node) => node.kind === "join");
    const proofGate = ir.nodes.find((node) => node.kind === "gate" && node.config?.cccProofSuite === true);
    expect(split).toMatchObject({ config: { cccPrdTaskId: idA } });
    expect(join).toMatchObject({ config: { mode: "all", cccPrdTaskId: idD } });
    expect(proofGate).toBeDefined();
    expect(ir.edges).toContainEqual({ from: "start", to: taskNodeId(idA), condition: "success" });
    expect(ir.edges).toContainEqual({ from: taskNodeId(idA), to: split!.id, condition: "success" });
    expect(ir.edges).toContainEqual({ from: split!.id, to: taskNodeId(idB), condition: "success" });
    expect(ir.edges).toContainEqual({ from: split!.id, to: taskNodeId(idC), condition: "success" });
    expect(ir.edges).toContainEqual({ from: taskNodeId(idB), to: join!.id, condition: "success" });
    expect(ir.edges).toContainEqual({ from: taskNodeId(idC), to: join!.id, condition: "success" });
    expect(ir.edges).toContainEqual({ from: join!.id, to: taskNodeId(idD), condition: "success" });
    expect(ir.edges).toContainEqual({ from: taskNodeId(idD), to: proofGate!.id, condition: "success" });
    expect(ir.edges).toContainEqual({ from: proofGate!.id, to: "end", condition: "success" });
    expect(ir.edges).not.toContainEqual({ from: taskNodeId(idB), to: taskNodeId(idD), condition: "success" });
    expect(ir.edges).not.toContainEqual({ from: taskNodeId(idC), to: taskNodeId(idD), condition: "success" });

    // The join task's native row persists BOTH predecessors: this is the
    // dependency shape the runtime's chained-start resolution reads.
    const taskEntities = (await h.layer().db.execute(sql`
      SELECT entity_id, native_id
      FROM project.ccc_prd_import_entities
      WHERE import_id = ${imported.importId}
        AND entity_type = 'task'
      ORDER BY ordinal
    `)) as unknown as Array<{ entity_id: string; native_id: string }>;
    const nativeBySemantic = new Map(
      taskEntities.map(({ entity_id, native_id }) => [entity_id, native_id]),
    );
    expect([...nativeBySemantic.keys()].sort()).toEqual([idA, idB, idC, idD].sort());
    await expect(h.store().getTask(nativeBySemantic.get(idD)!)).resolves.toMatchObject({
      dependencies: [nativeBySemantic.get(idB)!, nativeBySemantic.get(idC)!],
    });
    await expect(h.store().getTask(nativeBySemantic.get(idB)!)).resolves.toMatchObject({
      dependencies: [nativeBySemantic.get(idA)!],
    });
    await expect(h.store().getTask(nativeBySemantic.get(idC)!)).resolves.toMatchObject({
      dependencies: [nativeBySemantic.get(idA)!],
    });

    // One held work item, entering at the fan-out's entry task.
    await expect(h.store().getWorkflowWorkItem(
      `${imported.importId}--WORK-${suffix}`,
    )).resolves.toMatchObject({
      taskId: nativeBySemantic.get(idA)!,
    });
  });

  it("Task 6 RED: attaches each workflow transport route extension to its semantic prompt node", async () => {
    const suffix = "task6-workflow-extension";
    const key = "idem-task6-workflow-extension";
    const semanticBundle = productBundle(h.rootDir(), suffix);
    const workflowExtensionId = "plugin:ccc-campaign:provider-dispatch";
    registerWorkflowProviderExtension(workflowExtensionId);
    const imported = await importCccPrdBundle({
      ...request(suffix, key),
      bundle: semanticBundle,
      executionPolicy: {
        ...executionPolicy(semanticBundle),
        routes: executionPolicy(semanticBundle).routes.map((route, index) => index === 0
          ? { ...route, transport: "workflow" as const, workflowExtensionId }
          : route),
      },
    });
    const stored = await h.store().getWorkflowDefinition(`${imported.importId}--WF-${suffix}`);
    const prompt = (stored?.ir as { nodes: Array<{
      kind: string;
      config?: Record<string, unknown>;
      extensions?: Record<string, Record<string, unknown>>;
    }> }).nodes.find((node) => node.config?.cccPrdTaskId === `TASK-${suffix}`);

    expect(prompt).toMatchObject({
      kind: "prompt",
      extensions: { [workflowExtensionId]: {} },
    });
  });

  it("product v2 allocates durable native task ids without rewriting semantic custody", async () => {
    const suffix = "product-v2-native-task-ids";
    const key = "idem-product-v2-native-task-ids";
    const semanticBundle = productBundle(h.rootDir(), suffix);
    const policy = productExecutionPolicy(semanticBundle);

    const imported = await importCccPrdBundle({
      ...request(suffix, key),
      bundle: semanticBundle,
      executionPolicy: policy,
    });
    const taskEntities = (await h.layer().db.execute(sql`
      SELECT entity_id, native_id
      FROM project.ccc_prd_import_entities
      WHERE import_id = ${imported.importId}
        AND entity_type = 'task'
      ORDER BY ordinal
    `)) as unknown as Array<{ entity_id: string; native_id: string }>;
    expect(taskEntities.map(({ entity_id }) => entity_id)).toEqual(
      semanticBundle.tasks.map(({ id }) => id),
    );
    expect(taskEntities.map(({ native_id }) => native_id)).toEqual([
      expect.stringMatching(/^[A-Z][A-Z0-9]*-\d+$/u),
      expect.stringMatching(/^[A-Z][A-Z0-9]*-\d+$/u),
    ]);
    expect(taskEntities.every(({ entity_id, native_id }) => entity_id !== native_id)).toBe(true);
    expect(new Set(taskEntities.map(({ native_id }) => native_id)).size).toBe(taskEntities.length);

    const [campaignCustody] = await h.layer().db.execute(sql`
      SELECT campaign_manifest, campaign_manifest_hash, identity_hash
      FROM project.ccc_prd_imports
      WHERE import_id = ${imported.importId}
    `) as unknown as Array<{
      campaign_manifest: Record<string, unknown>;
      campaign_manifest_hash: string;
      identity_hash: string;
    }>;
    expect(campaignCustody).toMatchObject({
      campaign_manifest: {
        schema: "ccc-campaign.manifest.v2",
        executionAuthorizationMode: "sealed_bundle_v1",
      },
      campaign_manifest_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      identity_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(campaignCustody!.campaign_manifest_hash).toBe(campaignCustody!.identity_hash);

    const nativeBySemantic = new Map(
      taskEntities.map(({ entity_id, native_id }) => [entity_id, native_id]),
    );
    const entryNativeId = nativeBySemantic.get(semanticBundle.tasks[0]!.id)!;
    const terminalNativeId = nativeBySemantic.get(semanticBundle.tasks[1]!.id)!;
    await expect(h.store().getTask(entryNativeId)).resolves.toMatchObject({
      id: entryNativeId,
      dependencies: [],
      sourceMetadata: {
        semanticTaskId: semanticBundle.tasks[0]!.id,
        cccCampaignExecution: policy.routes[0],
      },
    });
    await expect(h.store().getTask(terminalNativeId)).resolves.toMatchObject({
      id: terminalNativeId,
      dependencies: [entryNativeId],
      sourceMetadata: {
        semanticTaskId: semanticBundle.tasks[1]!.id,
        cccCampaignExecution: policy.routes[1],
      },
    });
    await expect(h.store().getWorkflowWorkItem(
      `${imported.importId}--WORK-${suffix}`,
    )).resolves.toMatchObject({
      taskId: entryNativeId,
    });
    await expect(h.store().getCccCampaignContextForTask(entryNativeId)).resolves.toMatchObject({
      executionAuthorizationMode: "sealed_bundle_v1",
    });

    const reservationsBeforeReplay = (await h.layer().db.execute(sql`
      SELECT task_id, status
      FROM project.distributed_task_id_reservations
      WHERE node_id = ${`ccc-prd-import:${imported.importId}`}
      ORDER BY sequence
    `)) as unknown as Array<{ task_id: string; status: string }>;
    expect(reservationsBeforeReplay).toEqual(taskEntities.map(({ native_id }) => ({
      task_id: native_id,
      status: "committed",
    })));

    await expect(importCccPrdBundle({
      ...request(suffix, key),
      bundle: semanticBundle,
      executionPolicy: policy,
    })).resolves.toMatchObject({ replayed: true, importId: imported.importId });
    const reservationsAfterReplay = (await h.layer().db.execute(sql`
      SELECT task_id, status
      FROM project.distributed_task_id_reservations
      WHERE node_id = ${`ccc-prd-import:${imported.importId}`}
      ORDER BY sequence
    `)) as unknown as Array<{ task_id: string; status: string }>;
    expect(reservationsAfterReplay).toEqual(reservationsBeforeReplay);
  });

  it("product v2 rolls native task allocation back with the importer transaction", async () => {
    const suffix = "product-v2-native-task-rollback";
    const key = "idem-product-v2-native-task-rollback";
    const semanticBundle = productBundle(h.rootDir(), suffix);

    await expect(importCccPrdBundle({
      ...request(suffix, key, "task"),
      bundle: semanticBundle,
      executionPolicy: productExecutionPolicy(semanticBundle),
    })).rejects.toMatchObject({ code: "CCC_PRD_IMPORT_INJECTED_FAILURE" });

    const reservations = (await h.layer().db.execute(sql`
      SELECT task_id
      FROM project.distributed_task_id_reservations
    `)) as unknown as Array<{ task_id: string }>;
    expect(reservations).toEqual([]);
    await expect(h.store().listTasks()).resolves.toEqual([]);
  });

  it("RED-S1-import: refuses fresh product v2 imports below the provider-task request floor before mutation", async () => {
    const suffix = "product-v2-request-floor";
    const key = "idem-product-v2-request-floor";
    const semanticBundle = rehashBundle({
      ...bundle(h.rootDir(), suffix),
      bounds: { maxRequests: 1, maxDurationMs: 60_000, maxConcurrency: 1 },
    });

    await expect(importCccPrdBundle({
      ...request(suffix, key),
      bundle: semanticBundle,
      executionPolicy: productExecutionPolicy(semanticBundle),
    })).rejects.toMatchObject({
      code: CCC_PRD_REQUEST_BUDGET_BELOW_PROVIDER_TASK_FLOOR,
      message:
        "CCC PRD product import maxRequests 1 is below the provider-task floor 2",
    });

    await expect(inspectCccPrdImport({
      idempotencyKey: key,
      layer: h.layer(),
      rootDir: h.rootDir(),
    })).resolves.toBeNull();
    expect(await h.store().listTasks()).toEqual([]);
    const importRows = await h.layer().db.execute(sql`
      SELECT import_id
      FROM project.ccc_prd_imports
      WHERE idempotency_key = ${key}
    `) as unknown as Array<{ import_id: string }>;
    expect(importRows).toEqual([]);
  });

  it("RED-S1-import: replays exact legacy product v2 rows even when persisted below the provider-task request floor", async () => {
    const suffix = "product-v2-request-floor-legacy";
    const key = "idem-product-v2-request-floor-legacy";
    const initialBundle = productBundle(h.rootDir(), suffix);
    const initialPolicy = productExecutionPolicy(initialBundle);
    await expect(importCccPrdBundle({
      ...request(suffix, key),
      bundle: initialBundle,
      executionPolicy: initialPolicy,
      failureInjection: { checkpoint: "before_activation" },
    })).rejects.toMatchObject({ code: "CCC_PRD_IMPORT_INJECTED_FAILURE" });
    const seeded = await inspectCccPrdImport({
      idempotencyKey: key,
      layer: h.layer(),
      rootDir: h.rootDir(),
    });
    if (!seeded) throw new Error("missing prepared legacy seed");
    const imported = seeded;
    const legacyBundle = rehashBundle({
      ...initialBundle,
      bounds: { maxRequests: 1, maxDurationMs: 60_000, maxConcurrency: 1 },
    });
    const legacyPolicy = productExecutionPolicy(legacyBundle);
    const [persistedImport] = await h.layer().db.execute(sql`
      SELECT campaign_started_at, created_at
      FROM project.ccc_prd_imports
      WHERE idempotency_key = ${key}
    `) as unknown as Array<{ campaign_started_at: string; created_at: string }>;
    if (!persistedImport) throw new Error("missing seeded import row");
    const manifest = createCccCampaignManifest({
      projectId: "__legacy_unscoped__",
      importId: imported.importId,
      idempotencyKey: key,
      campaignId: `CAMPAIGN-${suffix}`,
      bundle: legacyBundle,
      executionPolicy: legacyPolicy,
      targetRepositoryPath: imported.targetRepository,
      campaignStartedAt: persistedImport.campaign_started_at,
    });
    const manifestHash = hashCccCampaignManifest(manifest);
    const taskEntities = await h.layer().db.execute(sql`
      SELECT entity_id, native_id
      FROM project.ccc_prd_import_entities
      WHERE import_id = ${imported.importId}
        AND entity_type = 'task'
    `) as unknown as Array<{ entity_id: string; native_id: string }>;
    const projection = buildCccPrdProjection({
      bundle: legacyBundle,
      executionPolicy: legacyPolicy,
      importId: imported.importId,
      identityHash: manifestHash,
      campaignId: `CAMPAIGN-${suffix}`,
      now: persistedImport.created_at,
      nativeTaskIds: new Map(taskEntities.map(({ entity_id, native_id }) => [
        entity_id,
        native_id,
      ])),
    });
    const projectionDigest = createHash("sha256")
      .update(canonicalCccPrdJson(projection), "utf8")
      .digest("hex");

    await h.layer().db.execute(sql`
      UPDATE project.ccc_prd_imports
      SET canonical_bundle = ${canonicalCccPrdJson(legacyBundle)}::jsonb,
          bundle_hash = ${legacyBundle.bundleHash},
          execution_policy = ${canonicalCccPrdJson(legacyPolicy)}::jsonb,
          campaign_manifest = ${canonicalCccPrdJson(manifest)}::jsonb,
          campaign_manifest_hash = ${manifestHash},
          identity_hash = ${manifestHash},
          campaign_deadline_at = ${manifest.campaignDeadlineAt},
          projection_digest = ${projectionDigest},
          updated_at = ${new Date().toISOString()}
      WHERE idempotency_key = ${key}
    `);
    const [legacyCustodyBeforeReplay] = await h.layer().db.execute(sql`
      SELECT campaign_manifest, campaign_manifest_hash, identity_hash
      FROM project.ccc_prd_imports
      WHERE idempotency_key = ${key}
    `) as unknown as Array<{
      campaign_manifest: Record<string, unknown>;
      campaign_manifest_hash: string;
      identity_hash: string;
    }>;
    expect(legacyCustodyBeforeReplay).toMatchObject({
      campaign_manifest: { schema: "ccc-campaign.manifest.v1" },
      campaign_manifest_hash: manifestHash,
      identity_hash: manifestHash,
    });
    expect(legacyCustodyBeforeReplay!.campaign_manifest)
      .not.toHaveProperty("executionAuthorizationMode");
    await rm(resolve(h.rootDir(), imported.stagingRelativePath), {
      recursive: true,
      force: true,
    });
    await rm(join(h.rootDir(), ".fusion", "tasks"), {
      recursive: true,
      force: true,
    });
    await rm(join(h.rootDir(), ".fusion", "artifacts"), {
      recursive: true,
      force: true,
    });

    await expect(importCccPrdBundle({
      ...request(suffix, key),
      bundle: legacyBundle,
      executionPolicy: legacyPolicy,
    })).resolves.toMatchObject({
      replayed: true,
      importId: imported.importId,
    });
    const [legacyCustodyAfterReplay] = await h.layer().db.execute(sql`
      SELECT campaign_manifest, campaign_manifest_hash, identity_hash
      FROM project.ccc_prd_imports
      WHERE idempotency_key = ${key}
    `) as unknown as Array<{
      campaign_manifest: Record<string, unknown>;
      campaign_manifest_hash: string;
      identity_hash: string;
    }>;
    expect(legacyCustodyAfterReplay).toEqual(legacyCustodyBeforeReplay);
  });

  it("product v2 RED: projects coding custody and a final proof barrier before human landing", async () => {
    const suffix = "product-v2-coding-proof";
    const key = "idem-product-v2-coding-proof";
    const initial = productBundle(h.rootDir(), suffix);
    const landingTask = initial.tasks[1]!;
    const mergeAction = {
      id: `ACTION-merge-${suffix}`,
      kind: "merge" as const,
      target: "refs/heads/main",
      operatorDecision: "approve_merge" as const,
      requiresOperatorDecision: true as const,
      spans: [landingTask.spans[0]!],
    };
    const semanticBundle = rehashBundle({
      ...initial,
      bounds: { ...initial.bounds, maxRequests: initial.tasks.length },
      tasks: initial.tasks.map((task) => task.id === landingTask.id
        ? { ...task, protectedActionIds: [mergeAction.id] }
        : task),
      protectedActions: [mergeAction],
    });
    const policy = productExecutionPolicy(semanticBundle);

    const imported = await importCccPrdBundle({
      ...request(suffix, key),
      bundle: semanticBundle,
      executionPolicy: policy,
    });
    const stored = await h.store().getWorkflowDefinition(`${imported.importId}--WF-${suffix}`);
    const ir = stored?.ir as {
      nodes: Array<{ id: string; kind: string; config?: Record<string, unknown> }>;
      edges: Array<{ from: string; to: string; condition: string }>;
    };
    const firstTaskNode = ir.nodes.find((node) =>
      node.config?.cccPrdTaskId === semanticBundle.tasks[0]!.id);
    const firstRouteSha256 = createHash("sha256")
      .update(canonicalCccPrdJson(policy.routes[0]), "utf8")
      .digest("hex");
    expect(firstTaskNode).toMatchObject({
      kind: "prompt",
      config: {
        cccExecutionTransport: "pi",
        cccExecutionProviderId: policy.routes[0]!.providerId,
        cccExecutionModelId: policy.routes[0]!.modelId,
        cccExecutionRouteSha256: firstRouteSha256,
        executor: "model",
        toolMode: "coding",
        worktreeMode: "isolated",
        ownedPaths: ["src/task-0"],
        allowedWriteRoots: ["src/task-0"],
        commitPolicy: "required",
      },
    });

    const projectedTask = await h.store().getTask(await nativeTaskIdForImport(
      imported.importId,
      semanticBundle.tasks[0]!.id,
    ));
    expect(projectedTask.sourceMetadata).toMatchObject({
      cccCampaignExecution: policy.routes[0],
    });
    await expect(h.store().getCccCampaignContextForTask(projectedTask.id)).resolves.toMatchObject({
      executionCustody: {
        promptSchema: firstTaskNode!.config!.cccExecutionPromptSchema,
        promptSha256: firstTaskNode!.config!.cccExecutionPromptSha256,
        routeSha256: firstRouteSha256,
      },
    });

    const proofNode = ir.nodes.find((node) => node.config?.cccProofSuite === true);
    const mergeNode = ir.nodes.find((node) => node.config?.seam === "merge");
    const terminalNodeId = `ccc-task-${createHash("sha256").update(landingTask.id).digest("hex").slice(0, 24)}`;
    expect(proofNode).toMatchObject({
      kind: "gate",
      config: {
        name: "CCC PRD proof suite",
        cccProofSuite: true,
        cccProofIds: semanticBundle.proofs.map(({ id }) => id),
        cccPrdTaskIds: semanticBundle.tasks.map(({ id }) => id),
        cccPrdTaskId: landingTask.id,
        gateMode: "gate",
        toolMode: "readonly",
      },
    });
    expect(mergeNode).toBeDefined();
    expect(ir.edges).toContainEqual({
      from: terminalNodeId,
      to: proofNode!.id,
      condition: "success",
    });
    expect(ir.edges).toContainEqual({
      from: proofNode!.id,
      to: mergeNode!.id,
      condition: "success",
    });
    expect(ir.edges).not.toContainEqual({
      from: terminalNodeId,
      to: mergeNode!.id,
      condition: "success",
    });
  });

  it("campaign work items carry an explicit transient-retry budget on every executable node", async () => {
    // 2026-08-11 top-down audit, Lane A: without config.maxRetries the engine
    // falls back to a single total attempt (workflow-task-runtime.ts), so one
    // transient provider error terminal-failed a campaign work item. Operator
    // decision 2026-08-11: campaign work items default to 3 attempts.
    const suffix = "transient-retry-budget";
    const key = "idem-transient-retry-budget";
    const initial = bundle(h.rootDir(), suffix);
    const landingTask = initial.tasks[1]!;
    const mergeAction = {
      id: `ACTION-merge-${suffix}`,
      kind: "merge" as const,
      target: "refs/heads/main",
      operatorDecision: "approve_merge" as const,
      requiresOperatorDecision: true as const,
      spans: [landingTask.spans[0]!],
    };
    const semanticBundle = rehashBundle({
      ...initial,
      bounds: { ...initial.bounds, maxRequests: initial.tasks.length },
      tasks: initial.tasks.map((task) => task.id === landingTask.id
        ? { ...task, protectedActionIds: [mergeAction.id] }
        : task),
      protectedActions: [mergeAction],
    });

    const imported = await importCccPrdBundle({
      ...request(suffix, key),
      bundle: semanticBundle,
      executionPolicy: productExecutionPolicy(semanticBundle),
    });
    const stored = await h.store().getWorkflowDefinition(`${imported.importId}--WF-${suffix}`);
    const ir = stored?.ir as {
      nodes: Array<{ id: string; kind: string; config?: Record<string, unknown> }>;
    };
    const taskNodes = ir.nodes.filter((node) =>
      node.kind === "prompt" && node.config?.seam !== "merge");
    const proofNode = ir.nodes.find((node) => node.config?.cccProofSuite === true);
    const mergeNode = ir.nodes.find((node) => node.config?.seam === "merge");
    expect(taskNodes).toHaveLength(semanticBundle.tasks.length);
    for (const node of taskNodes) {
      expect(node.config?.maxRetries).toBe(3);
    }
    expect(proofNode?.config?.maxRetries).toBe(3);
    expect(mergeNode?.config?.maxRetries).toBe(3);
    // Topology nodes execute no provider work; they must not carry a budget.
    for (const node of ir.nodes.filter(({ kind }) =>
      kind === "start" || kind === "end" || kind === "split" || kind === "join")) {
      expect(node.config?.maxRetries).toBeUndefined();
    }
  });

  it("product v2 CLI route projects stable adapter settings without persisted subscription readiness", async () => {
    const suffix = "product-v2-cli-settings";
    const key = "idem-product-v2-cli-settings";
    const semanticBundle = productBundle(h.rootDir(), suffix);
    const policy = productExecutionPolicy(semanticBundle);
    const cliPolicy = {
      ...policy,
      routes: policy.routes.map((route, index) => index === 0
        ? {
          ...route,
          transport: "cli" as const,
          executor: "cli-agent" as const,
          cliAdapterId: "test-cli-adapter",
        }
        : route),
    };

    const imported = await importCccPrdBundle({
      ...request(suffix, key),
      bundle: semanticBundle,
      executionPolicy: cliPolicy,
    });
    const stored = await h.store().getWorkflowDefinition(`${imported.importId}--WF-${suffix}`);
    const firstTaskNode = (stored?.ir as {
      nodes: Array<{ config?: Record<string, unknown> }>;
    }).nodes.find((node) => node.config?.cccPrdTaskId === semanticBundle.tasks[0]!.id);

    expect(firstTaskNode?.config).toMatchObject({
      executor: "cli-agent",
      cliAdapterId: "test-cli-adapter",
      cliSettings: {
        profile: "ccc-fusion",
        providerId: policy.routes[0]!.providerId,
        model: policy.routes[0]!.modelId,
      },
    });
    expect(firstTaskNode?.config?.cliSettings).not.toHaveProperty("subscriptionReady");
  });

  it("product v2 activation schedules planning continuations through import and reconcile", async () => {
    const importedSuffix = "product-v2-planning-import";
    const importedBundle = productBundle(h.rootDir(), importedSuffix);
    const importedPlanning = await importCccPrdBundle({
      ...request(importedSuffix, "idem-product-v2-planning-import"),
      bundle: importedBundle,
      executionPolicy: productExecutionPolicy(importedBundle),
    });
    expect(await h.store().getWorkflowWorkItem(
      `${importedPlanning.importId}--WORK-${importedSuffix}`,
    )).toMatchObject({
      state: "runnable",
      blockedReason: null,
      waitReason: "planning",
    });

    const reconciledSuffix = "product-v2-planning-reconcile";
    const reconciledKey = "idem-product-v2-planning-reconcile";
    const reconciledBundle = productBundle(h.rootDir(), reconciledSuffix);
    await expect(importCccPrdBundle({
      ...request(reconciledSuffix, reconciledKey, "before_activation"),
      bundle: reconciledBundle,
      executionPolicy: productExecutionPolicy(reconciledBundle),
    })).rejects.toMatchObject({
      code: "CCC_PRD_IMPORT_INJECTED_FAILURE",
    });

    const { TaskStore } = await import("../../store.js");
    const restarted = new TaskStore(h.rootDir(), undefined, { asyncLayer: h.layer() });
    const reconciledPlanning = await reconcileCccPrdImport({
      idempotencyKey: reconciledKey,
      layer: h.layer(),
      store: restarted,
      rootDir: h.rootDir(),
    });
    expect(await restarted.getWorkflowWorkItem(
      `${reconciledPlanning.importId}--WORK-${reconciledSuffix}`,
    )).toMatchObject({
      state: "runnable",
      blockedReason: null,
      waitReason: "planning",
    });
  });

  it("product v2 refuses proof execution without one explicit integration terminal", async () => {
    const suffix = "product-v2-multiple-terminals";
    const initial = bundle(h.rootDir(), suffix);
    const extraTerminal = {
      ...initial.tasks[1]!,
      id: `TASK-extra-terminal-${suffix}`,
      title: "Extra unintegrated terminal",
      dependencyTaskIds: [],
      documentIds: [],
      artifactIds: [],
      protectedActionIds: [],
    };
    const ambiguous = rehashBundle({
      ...initial,
      bounds: { ...initial.bounds, maxRequests: 3 },
      tasks: [...initial.tasks, extraTerminal],
      workflows: initial.workflows.map((workflow) => ({
        ...workflow,
        taskIds: [...workflow.taskIds, extraTerminal.id],
        terminalTaskIds: [...workflow.terminalTaskIds, extraTerminal.id],
      })),
      importIntents: [
        ...initial.importIntents,
        {
          id: extraTerminal.id,
          entityType: "task" as const,
          entityId: extraTerminal.id,
          operation: "create" as const,
          target: h.rootDir(),
        },
      ],
    });

    await expect(importCccPrdBundle({
      ...request(suffix, "idem-product-v2-multiple-terminals"),
      bundle: ambiguous,
      executionPolicy: productExecutionPolicy(ambiguous),
    })).rejects.toMatchObject({
      code: "CCC_PRD_IMPORT_INVALID_BUNDLE",
      message: `CCC PRD product workflow WF-${suffix} requires exactly one integration terminal task before final proof`,
    });
  });

  it("Task 6 RED: refuses an unregistered workflow transport extension without persisted import state", async () => {
    const suffix = "task6-unregistered-workflow-extension";
    const key = "idem-task6-unregistered-workflow-extension";
    const semanticBundle = bundle(h.rootDir(), suffix);
    const workflowExtensionId = "plugin:ccc-campaign:unregistered-provider";
    __resetWorkflowExtensionRegistryForTests();

    await expect(importCccPrdBundle({
      ...request(suffix, key),
      bundle: semanticBundle,
      executionPolicy: {
        ...executionPolicy(semanticBundle),
        routes: executionPolicy(semanticBundle).routes.map((route, index) => index === 0
          ? { ...route, transport: "workflow" as const, workflowExtensionId }
          : route),
      },
    })).rejects.toThrow(
      `Workflow node 'ccc-task-${createHash("sha256").update(`TASK-${suffix}`).digest("hex").slice(0, 24)}' extension key '${workflowExtensionId}' is not registered`,
    );
    await expect(inspectCccPrdImport({
      idempotencyKey: key,
      layer: h.layer(),
      rootDir: h.rootDir(),
    })).resolves.toBeNull();
    const expectedImportId = `ccc-prd-${createHash("sha256")
      .update(`__legacy_unscoped__\0${key}`)
      .digest("hex")
      .slice(0, 32)}`;
    expect((await h.store().listWorkflowDefinitions()).map(({ id }) => id))
      .not.toContain(`${expectedImportId}--WF-${suffix}`);
  });

  it("Task 6 RED: refuses a dangling terminal protected-action reference before emitting workflow IR", async () => {
    const suffix = "task6-dangling-terminal-action";
    const key = "idem-task6-dangling-terminal-action";
    const initial = bundle(h.rootDir(), suffix);
    const landingTask = initial.tasks[1]!;
    const danglingActionId = `ACTION-missing-${suffix}`;
    const danglingBundle = rehashBundle({
      ...initial,
      tasks: initial.tasks.map((task) => task.id === landingTask.id
        ? { ...task, protectedActionIds: [danglingActionId] }
        : task),
      protectedActions: [],
    });

    await expect(importCccPrdBundle({
      ...request(suffix, key),
      bundle: danglingBundle,
      executionPolicy: executionPolicy(danglingBundle),
    })).rejects.toMatchObject({
      code: "CCC_PRD_IMPORT_INVALID_BUNDLE",
      message: `CCC PRD workflow WF-${suffix} terminal task ${landingTask.id} references unknown protected action ${danglingActionId}`,
    });
    await expect(inspectCccPrdImport({
      idempotencyKey: key,
      layer: h.layer(),
      rootDir: h.rootDir(),
    })).resolves.toBeNull();
    const expectedImportId = `ccc-prd-${createHash("sha256")
      .update(`__legacy_unscoped__\0${key}`)
      .digest("hex")
      .slice(0, 32)}`;
    expect((await h.store().listWorkflowDefinitions()).map(({ id }) => id))
      .not.toContain(`${expectedImportId}--WF-${suffix}`);
  });

  it("Task 6 RED: emits one merge seam after one exact terminal merge action and refuses ambiguous landings", async () => {
    const suffix = "task6-merge-seam";
    const key = "idem-task6-merge-seam";
    const initial = bundle(h.rootDir(), suffix);
    const landingTask = initial.tasks[1]!;
    const mergeAction = {
      id: `ACTION-merge-${suffix}`,
      kind: "merge" as const,
      target: "refs/heads/main",
      operatorDecision: "approve_merge" as const,
      requiresOperatorDecision: true as const,
      spans: [landingTask.spans[0]!],
    };
    const mergeBundle = rehashBundle({
      ...initial,
      tasks: initial.tasks.map((task) => task.id === landingTask.id
        ? { ...task, protectedActionIds: [mergeAction.id] }
        : task),
      protectedActions: [mergeAction],
    });
    const extraTerminal = {
      ...landingTask,
      id: `TASK-extra-terminal-${suffix}`,
      title: "Extra terminal",
      dependencyTaskIds: [],
      documentIds: [],
      artifactIds: [],
      protectedActionIds: [],
    };
    const ambiguousLanding = rehashBundle({
      ...mergeBundle,
      bounds: { ...mergeBundle.bounds, maxRequests: 3 },
      tasks: [...mergeBundle.tasks, extraTerminal],
      workflows: mergeBundle.workflows.map((workflow) => ({
        ...workflow,
        taskIds: [...workflow.taskIds, extraTerminal.id],
        terminalTaskIds: [...workflow.terminalTaskIds, extraTerminal.id],
      })),
      importIntents: [
        ...mergeBundle.importIntents.map((intent) => intent.entityType === "campaign"
          ? {
            ...intent,
            id: `${intent.id}-ambiguous`,
            entityId: `${intent.entityId}-ambiguous`,
          }
          : intent),
        { id: extraTerminal.id, entityType: "task" as const, entityId: extraTerminal.id, operation: "create" as const, target: h.rootDir() },
      ],
    });
    await expect(importCccPrdBundle({
      ...request(`${suffix}-ambiguous`, `${key}-ambiguous`),
      bundle: ambiguousLanding,
      executionPolicy: executionPolicy(ambiguousLanding),
    })).rejects.toMatchObject({
      code: "CCC_PRD_IMPORT_INVALID_BUNDLE",
      message: "CCC PRD workflow WF-task6-merge-seam has multiple terminal landing tasks for merge ACTION-merge-task6-merge-seam",
    });

    const secondMergeAction = { ...mergeAction, id: `${mergeAction.id}-second` };
    const ambiguousAction = rehashBundle({
      ...mergeBundle,
      tasks: mergeBundle.tasks.map((task) => task.id === landingTask.id
        ? { ...task, protectedActionIds: [mergeAction.id, secondMergeAction.id] }
        : task),
      protectedActions: [mergeAction, secondMergeAction],
    });
    await expect(importCccPrdBundle({
      ...request(`${suffix}-ambiguous-action`, `${key}-ambiguous-action`),
      bundle: ambiguousAction,
      executionPolicy: executionPolicy(ambiguousAction),
    })).rejects.toMatchObject({
      code: "CCC_PRD_IMPORT_INVALID_BUNDLE",
      message: "CCC PRD workflow WF-task6-merge-seam terminal landing TASK-terminal-task6-merge-seam must reference exactly one declared merge protected action",
    });

    const imported = await importCccPrdBundle({
      ...request(suffix, key),
      bundle: mergeBundle,
      executionPolicy: executionPolicy(mergeBundle),
    });
    const stored = await h.store().getWorkflowDefinition(`${imported.importId}--WF-${suffix}`);
    const ir = stored?.ir as {
      nodes: Array<{ id: string; kind: string; config?: Record<string, unknown> }>;
      edges: Array<{ from: string; to: string; condition: string }>;
    };
    const terminalNodeId = `ccc-task-${createHash("sha256").update(landingTask.id).digest("hex").slice(0, 24)}`;
    const mergeNode = ir.nodes.find((node) => node.config?.seam === "merge");
    expect(mergeNode).toMatchObject({
      kind: "prompt",
      config: { seam: "merge", cccPrdTaskId: landingTask.id },
    });
    expect(ir.edges).toContainEqual({ from: terminalNodeId, to: mergeNode!.id, condition: "success" });
    expect(ir.edges).toContainEqual({ from: mergeNode!.id, to: "end", condition: "success" });
    expect(ir.edges).not.toContainEqual({ from: terminalNodeId, to: "end", condition: "success" });
  });

  it("Task 6 RED: preserves no-merge-action workflow IR bytes", async () => {
    const suffix = "task6-no-merge";
    const key = "idem-task6-no-merge";
    const semanticBundle = bundle(h.rootDir(), suffix);
    const imported = await importCccPrdBundle({
      ...request(suffix, key),
      bundle: semanticBundle,
      executionPolicy: executionPolicy(semanticBundle),
    });
    const stored = await h.store().getWorkflowDefinition(`${imported.importId}--WF-${suffix}`);
    const entryNativeTaskId = await nativeTaskIdForImport(
      imported.importId,
      `TASK-${suffix}`,
    );
    const terminalNativeTaskId = await nativeTaskIdForImport(
      imported.importId,
      `TASK-terminal-${suffix}`,
    );
    expect(stored?.ir).toEqual({
      version: "v2",
      name: "Import workflow",
      columns: [],
      nodes: [
        { id: "start", kind: "start" },
        {
          id: `ccc-task-${createHash("sha256").update(`TASK-${suffix}`).digest("hex").slice(0, 24)}`,
          kind: "prompt",
          config: {
            name: "Import-owned task",
            prompt: "A task projected only after commit.",
            cccPrdTaskId: `TASK-${suffix}`,
            cccNativeTaskId: entryNativeTaskId,
            gateMode: "gate",
            maxRetries: 3,
          },
        },
        {
          id: `ccc-task-${createHash("sha256").update(`TASK-terminal-${suffix}`).digest("hex").slice(0, 24)}`,
          kind: "prompt",
          config: {
            name: "Terminal import-owned task",
            prompt: "Dependent terminal task.",
            cccPrdTaskId: `TASK-terminal-${suffix}`,
            cccNativeTaskId: terminalNativeTaskId,
            gateMode: "gate",
            maxRetries: 3,
          },
        },
        { id: "end", kind: "end" },
      ],
      edges: [
        {
          from: "start",
          to: `ccc-task-${createHash("sha256").update(`TASK-${suffix}`).digest("hex").slice(0, 24)}`,
          condition: "success",
        },
        {
          from: `ccc-task-${createHash("sha256").update(`TASK-${suffix}`).digest("hex").slice(0, 24)}`,
          to: `ccc-task-${createHash("sha256").update(`TASK-terminal-${suffix}`).digest("hex").slice(0, 24)}`,
          condition: "success",
        },
        {
          from: `ccc-task-${createHash("sha256").update(`TASK-terminal-${suffix}`).digest("hex").slice(0, 24)}`,
          to: "end",
          condition: "success",
        },
      ],
    });
  });

  it("commits exact semantic counts, projects task/document/artifact readers, and remains visible after restart", async () => {
    const key = "idem-success";
    const imported = await importCccPrdBundle(request("success", key));
    expect(imported).toMatchObject({ state: "active", replayed: false });
    await assertNoExternalEffects();
    await assertImportAuditHistory(imported.importId);

    const inspection = await inspectCccPrdImport({ idempotencyKey: key, layer: h.layer(), rootDir: h.rootDir() });
    expect(inspection).toMatchObject({
      state: "active",
      runnable: true,
      directCounts: { campaigns: 1, tasks: 2, dependencyEdges: 1, workflows: 1, documents: 1, artifacts: 1, sources: 1, workItems: 1, runAudits: 1 },
    });
    const tasks = await h.store().listTasks();
    expect(tasks).toHaveLength(2);
    expect(tasks[0]?.description).toContain("projected only after commit");
    const nativeTaskId = await nativeTaskIdForImport(
      imported.importId,
      "TASK-success",
    );
    expect(await h.store().getTask(nativeTaskId)).toMatchObject({
      id: nativeTaskId,
      column: "todo",
      status: "queued",
    });
    expect(await h.store().getTaskDocument(nativeTaskId, "PROMPT.md")).toMatchObject({
      id: `${imported.importId}--DOC-success`,
      content: "import-owned prompt",
    });
    const nativeArtifactId = `${imported.importId}--ART-success`;
    const nativeWorkflowId = `${imported.importId}--WF-success`;
    expect(await h.store().getArtifact(nativeArtifactId)).toMatchObject({
      id: nativeArtifactId,
      title: "Import evidence",
      content: "artifact bytes",
    });
    const nativeWorkflow = await h.store().getWorkflowDefinition(nativeWorkflowId);
    expect(nativeWorkflow).toMatchObject({
      id: nativeWorkflowId,
      name: "Import workflow",
      ir: {
        version: "v2",
        nodes: expect.arrayContaining([
          expect.objectContaining({ kind: "start" }),
          expect.objectContaining({ kind: "end" }),
        ]),
      },
    });
    const nativeWorkItem = await h.store().getWorkflowWorkItem(
      `${imported.importId}--WORK-success`,
    );
    expect(nativeWorkItem).toMatchObject({
      state: "runnable",
      blockedReason: null,
      waitReason: null,
      irHash: createHash("sha256")
        .update(canonicalCccPrdJson(nativeWorkflow!.ir), "utf8")
        .digest("hex"),
    });
    const projection = await canonicalProjectionPaths("success", imported.importId);
    expect(JSON.parse(await readFile(projection.taskJson, "utf8"))).toMatchObject({
      state: "prepared",
      runnable: false,
    });
    expect((await h.store().getAllDocuments()).map((document) => document.content)).toContain("import-owned prompt");
    expect((await h.store().listArtifacts()).map((artifact) => artifact.id)).toContain(nativeArtifactId);
    expect((await h.store().listWorkflowDefinitions()).map((workflow) => workflow.id)).toContain(nativeWorkflowId);
    expect(await fileExists(resolve(h.rootDir(), imported.stagingRelativePath))).toBe(false);

    // A new store instance is the restart boundary; it must expose the same active import.
    const { TaskStore } = await import("../../store.js");
    const restarted = new TaskStore(h.rootDir(), undefined, { asyncLayer: h.layer() });
    expect(await restarted.listTasks()).toHaveLength(2);
    expect((await inspectCccPrdImport({ idempotencyKey: key, layer: h.layer(), rootDir: h.rootDir() }))?.state).toBe("active");
  });

  it("admits a new reviewed campaign from the same PRD with distinct native campaign and work-item identities", async () => {
    const suffix = "repeat-campaign";
    const first = await importCccPrdBundle(
      request(suffix, "idem-repeat-campaign-first"),
    );
    const second = await importCccPrdBundle(
      request(suffix, "idem-repeat-campaign-second"),
    );

    const entities = await h.layer().db.execute(sql`
      SELECT import_id AS "importId", entity_type AS "entityType",
        entity_id AS "entityId", native_id AS "nativeId"
      FROM project.ccc_prd_import_entities
      WHERE import_id IN (${first.importId}, ${second.importId})
        AND entity_type IN ('campaign', 'work_item')
      ORDER BY import_id, entity_type
    `) as unknown as Array<{
      importId: string;
      entityType: "campaign" | "work_item";
      entityId: string;
      nativeId: string;
    }>;

    expect(entities).toHaveLength(4);
    expect(new Set(entities.map(({ nativeId }) => nativeId)).size).toBe(4);
    for (const entity of entities) {
      expect(entity.nativeId).toBe(
        `${entity.importId}--${
          entity.entityType === "campaign"
            ? `CAMPAIGN-${suffix}`
            : `WORK-${suffix}`
        }`,
      );
    }
    await expect(inspectCccPrdImport({
      idempotencyKey: "idem-repeat-campaign-first",
      layer: h.layer(),
      rootDir: h.rootDir(),
    })).resolves.toMatchObject({ state: "active", runnable: true });
    await expect(inspectCccPrdImport({
      idempotencyKey: "idem-repeat-campaign-second",
      layer: h.layer(),
      rootDir: h.rootDir(),
    })).resolves.toMatchObject({ state: "active", runnable: true });
  });

  it("rebuilds missing canonical prepared files for an active import after restart", async () => {
    const suffix = "active-repair";
    const key = "idem-active-repair";
    const imported = await importCccPrdBundle(request(suffix, key));
    const projection = await canonicalProjectionPaths(suffix, imported.importId);
    expect(await fileExists(resolve(h.rootDir(), imported.stagingRelativePath))).toBe(false);
    await rm(projection.taskDir, { recursive: true });
    await rm(projection.artifact);
    expect(await fileExists(projection.taskDir)).toBe(false);
    expect(await fileExists(projection.artifact)).toBe(false);

    const { TaskStore } = await import("../../store.js");
    const restarted = new TaskStore(h.rootDir(), undefined, { asyncLayer: h.layer() });
    await expect(reconcileCccPrdImport({
      idempotencyKey: key,
      layer: h.layer(),
      store: restarted,
      rootDir: h.rootDir(),
    })).resolves.toMatchObject({
      state: "active",
      runnable: true,
      replayed: true,
    });
    expect(JSON.parse(await readFile(projection.taskJson, "utf8"))).toMatchObject({
      state: "prepared",
      runnable: false,
    });
    expect(await readFile(projection.artifact, "utf8")).toBe("artifact bytes");
    expect(await fileExists(resolve(h.rootDir(), imported.stagingRelativePath))).toBe(false);
  });

  it("serializes two concurrent active repairs over one staging prefix", async () => {
    const suffix = "active-repair-concurrent";
    const key = "idem-active-repair-concurrent";
    const imported = await importCccPrdBundle(request(suffix, key));
    const projection = await canonicalProjectionPaths(suffix, imported.importId);
    await rm(projection.taskDir, { recursive: true });
    await rm(projection.artifact);
    let announceEntered!: () => void;
    let releaseRepair!: () => void;
    const entered = new Promise<void>((resolveEntered) => {
      announceEntered = resolveEntered;
    });
    const holdRepair = new Promise<void>((resolveRepair) => {
      releaseRepair = resolveRepair;
    });
    const first = importCccPrdBundle({
      ...request(suffix, key),
      failureInjection: {
        pause: {
          checkpoint: "artifact_bytes",
          entered: announceEntered,
          until: holdRepair,
        },
      },
    });
    await entered;
    let secondSettled = false;
    const second = importCccPrdBundle(request(suffix, key))
      .finally(() => {
        secondSettled = true;
      });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));

    let assertionError: unknown;
    try {
      expect(secondSettled).toBe(false);
    } catch (error) {
      assertionError = error;
    } finally {
      releaseRepair();
    }
    const results = await Promise.allSettled([first, second]);
    if (assertionError) throw assertionError;
    expect(results.every(({ status }) => status === "fulfilled")).toBe(true);
    expect(results.map((result) => result.status === "fulfilled" && result.value.replayed))
      .toEqual([true, true]);
    expect(JSON.parse(await readFile(projection.taskJson, "utf8"))).toMatchObject({
      state: "prepared",
      runnable: false,
    });
    expect(await readFile(projection.artifact, "utf8")).toBe("artifact bytes");
    expect(await fileExists(resolve(h.rootDir(), imported.stagingRelativePath))).toBe(false);
  });

  it("bounds active-repair lock waiting by the admitted reconciliation budget", async () => {
    const suffix = "active-repair-timeout";
    const key = "idem-active-repair-timeout";
    const boundedBundle = rehashBundle({
      ...bundle(h.rootDir(), suffix),
      bounds: { maxRequests: 1, maxDurationMs: 40, maxConcurrency: 1 },
    });
    const imported = await importCccPrdBundle({
      ...request(suffix, key),
      bundle: boundedBundle,
    });
    const projection = await canonicalProjectionPaths(suffix, imported.importId);
    await rm(projection.taskDir, { recursive: true });
    await rm(projection.artifact);
    let announceEntered!: () => void;
    let releaseRepair!: () => void;
    const entered = new Promise<void>((resolveEntered) => {
      announceEntered = resolveEntered;
    });
    const holdRepair = new Promise<void>((resolveRepair) => {
      releaseRepair = resolveRepair;
    });
    const first = importCccPrdBundle({
      ...request(suffix, key),
      bundle: boundedBundle,
      failureInjection: {
        pause: {
          checkpoint: "artifact_bytes",
          entered: announceEntered,
          until: holdRepair,
        },
      },
    });
    await entered;
    const secondOutcome = importCccPrdBundle({
      ...request(suffix, key),
      bundle: boundedBundle,
      failureInjection: { reconciliationOverheadMs: 40 },
    }).then(
      (result) => ({ status: "fulfilled" as const, result }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    const observed = await Promise.race([
      secondOutcome,
      new Promise<{ status: "still-waiting" }>((resolveDelay) => {
        setTimeout(() => resolveDelay({ status: "still-waiting" }), 250);
      }),
    ]);
    let assertionError: unknown;
    try {
      expect(observed).toMatchObject({
        status: "rejected",
        error: { code: "CCC_PRD_IMPORT_RECONCILE_TIMEOUT" },
      });
    } catch (error) {
      assertionError = error;
    } finally {
      releaseRepair();
    }
    await first;
    await secondOutcome;
    if (assertionError) throw assertionError;
    expect(await fileExists(resolve(h.rootDir(), imported.stagingRelativePath))).toBe(false);
  });

  it("bounds same-key preparation admission while the creator transaction is uncommitted", async () => {
    const suffix = "preparation-timeout";
    const key = "idem-preparation-timeout";
    const boundedBundle = rehashBundle({
      ...bundle(h.rootDir(), suffix),
      bounds: { maxRequests: 1, maxDurationMs: 40, maxConcurrency: 1 },
    });
    let announceEntered!: () => void;
    let releaseCreator!: () => void;
    const entered = new Promise<void>((resolveEntered) => {
      announceEntered = resolveEntered;
    });
    const holdCreator = new Promise<void>((resolveCreator) => {
      releaseCreator = resolveCreator;
    });
    const creator = importCccPrdBundle({
      ...request(suffix, key),
      bundle: boundedBundle,
      failureInjection: {
        pause: {
          checkpoint: "campaign",
          entered: announceEntered,
          until: holdCreator,
        },
      },
    });
    await entered;
    const waiterOutcome = importCccPrdBundle({
      ...request(suffix, key),
      bundle: boundedBundle,
      failureInjection: { reconciliationOverheadMs: 40 },
    }).then(
      (result) => ({ status: "fulfilled" as const, result }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    const observed = await Promise.race([
      waiterOutcome,
      new Promise<{ status: "still-waiting" }>((resolveDelay) => {
        setTimeout(() => resolveDelay({ status: "still-waiting" }), 250);
      }),
    ]);
    let assertionError: unknown;
    try {
      expect(observed).toMatchObject({
        status: "rejected",
        error: { code: "CCC_PRD_IMPORT_RECONCILE_TIMEOUT" },
      });
    } catch (error) {
      assertionError = error;
    } finally {
      releaseCreator();
    }
    await creator;
    await waiterOutcome;
    if (assertionError) throw assertionError;
    await expect(importCccPrdBundle({
      ...request(suffix, key),
      bundle: boundedBundle,
    })).resolves.toMatchObject({ state: "active", replayed: true });
  });

  it("is sequentially and concurrently idempotent, including a lost response after commit", async () => {
    const key = "idem-replay";
    const first = await importCccPrdBundle(request("replay", key));
    const replay = await importCccPrdBundle(request("replay", key));
    expect(first).toMatchObject({ state: "active", replayed: false });
    expect(replay).toMatchObject({ state: "active", replayed: true });
    await assertNoExternalEffects();
    await assertImportAuditHistory(first.importId);

    const concurrentKey = "idem-concurrent";
    const [left, right] = await Promise.all([
      importCccPrdBundle(request("concurrent", concurrentKey)),
      importCccPrdBundle(request("concurrent", concurrentKey)),
    ]);
    expect([left.replayed, right.replayed].filter(Boolean)).toHaveLength(1);
    await assertNoExternalEffects();
    await assertImportAuditHistory(left.importId);
    await expect(importCccPrdBundle(request("lost", "idem-lost", "lost_response_after_commit"))).rejects.toMatchObject({ code: "CCC_PRD_IMPORT_LOST_RESPONSE" });
    const lostReplay = await importCccPrdBundle(request("lost", "idem-lost"));
    expect(lostReplay).toMatchObject({ state: "active", replayed: true });
    await assertNoExternalEffects();
    await assertImportAuditHistory(lostReplay.importId);
  });

  it("keeps a live projection claim beyond lease expiry while an identical import waits", async () => {
    const suffix = "lease-renewal";
    const key = "idem-lease-renewal";
    const projectionLeaseMs = 1_000;
    let announceEntered!: () => void;
    let releaseProjection!: () => void;
    const entered = new Promise<void>((resolveEntered) => {
      announceEntered = resolveEntered;
    });
    const holdProjection = new Promise<void>((resolveProjection) => {
      releaseProjection = resolveProjection;
    });
    const first = importCccPrdBundle({
      ...request(suffix, key),
      failureInjection: {
        projectionLeaseMs,
        pause: {
          checkpoint: "artifact_bytes",
          entered: announceEntered,
          until: holdProjection,
        },
      },
    });
    await entered;
    const beforeExpiry = await readProjectionClaim(key);
    expect(beforeExpiry).toMatchObject({
      state: "projecting",
      projection_owner: expect.any(String),
    });
    const initialLeaseUntilMs = await waitPastProjectionLease(beforeExpiry);
    let secondSettled = false;
    const second = importCccPrdBundle(request(suffix, key))
      .finally(() => {
        secondSettled = true;
      });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));

    let assertionError: unknown;
    try {
      const renewedClaim = await readProjectionClaim(key);
      expect(renewedClaim).toMatchObject({
        state: "projecting",
        projection_owner: beforeExpiry.projection_owner,
      });
      expect(Date.parse(renewedClaim.projection_lease_until ?? "")).toBeGreaterThan(initialLeaseUntilMs);
      expect(secondSettled).toBe(false);
    } catch (error) {
      assertionError = error;
    } finally {
      releaseProjection();
    }
    const results = await Promise.allSettled([first, second]);
    if (assertionError) throw assertionError;
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (rejected) throw rejected.reason;
    expect(results.map((result) => result.status === "fulfilled" && result.value.replayed))
      .toEqual([false, true]);
  });

  it("lets an in-flight heartbeat renew before reclaiming its just-expired projection lease", async () => {
    const suffix = "lease-renewal-in-flight";
    const key = "idem-lease-renewal-in-flight";
    const baseLayer = h.layer();
    let blockNextTransaction = false;
    let announceRenewalBlocked!: () => void;
    let releaseRenewal!: () => void;
    const renewalBlocked = new Promise<void>((resolveBlocked) => {
      announceRenewalBlocked = resolveBlocked;
    });
    const holdRenewal = new Promise<void>((resolveRenewal) => {
      releaseRenewal = resolveRenewal;
    });
    const ownerLayer: AsyncDataLayer = {
      ...baseLayer,
      transactionImmediate: async (fn, options) => {
        if (blockNextTransaction) {
          blockNextTransaction = false;
          announceRenewalBlocked();
          await holdRenewal;
        }
        return baseLayer.transactionImmediate(fn, options);
      },
    };
    let announceProjectionEntered!: () => void;
    let releaseProjection!: () => void;
    const projectionEntered = new Promise<void>((resolveEntered) => {
      announceProjectionEntered = resolveEntered;
    });
    const holdProjection = new Promise<void>((resolveProjection) => {
      releaseProjection = resolveProjection;
    });
    const first = importCccPrdBundle({
      ...request(suffix, key),
      layer: ownerLayer,
      failureInjection: {
        projectionLeaseMs: 200,
        pause: {
          checkpoint: "artifact_bytes",
          entered: announceProjectionEntered,
          until: holdProjection,
        },
      },
    });
    await projectionEntered;
    blockNextTransaction = true;
    await renewalBlocked;
    const ownerClaim = await readProjectionClaim(key);
    await waitPastProjectionLease(ownerClaim);

    let secondSettled = false;
    const second = importCccPrdBundle(request(suffix, key))
      .finally(() => {
        secondSettled = true;
      });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));

    let assertionError: unknown;
    try {
      expect(await readProjectionClaim(key)).toMatchObject({
        state: "projecting",
        projection_owner: ownerClaim.projection_owner,
      });
      expect(secondSettled).toBe(false);
    } catch (error) {
      assertionError = error;
    } finally {
      releaseRenewal();
      releaseProjection();
    }
    const results = await Promise.allSettled([first, second]);
    if (assertionError) throw assertionError;
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (rejected) throw rejected.reason;
    expect(results.map((result) => result.status === "fulfilled" && result.value.replayed))
      .toEqual([false, true]);
  });

  it("keeps renewing through the activation handoff while an identical import waits", async () => {
    const suffix = "activation-handoff";
    const key = "idem-activation-handoff";
    const projectionLeaseMs = 1_000;
    let announceEntered!: () => void;
    let releaseActivation!: () => void;
    const entered = new Promise<void>((resolveEntered) => {
      announceEntered = resolveEntered;
    });
    const holdActivation = new Promise<void>((resolveActivation) => {
      releaseActivation = resolveActivation;
    });
    const first = importCccPrdBundle({
      ...request(suffix, key),
      failureInjection: {
        projectionLeaseMs,
        pause: {
          checkpoint: "activation_handoff",
          entered: announceEntered,
          until: holdActivation,
        },
      },
    });
    await entered;
    const beforeExpiry = await readProjectionClaim(key);
    const initialLeaseUntilMs = await waitPastProjectionLease(beforeExpiry);
    let secondSettled = false;
    const second = importCccPrdBundle(request(suffix, key))
      .finally(() => {
        secondSettled = true;
      });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));

    let assertionError: unknown;
    try {
      const renewedClaim = await readProjectionClaim(key);
      expect(renewedClaim).toMatchObject({
        state: "projecting",
        projection_owner: beforeExpiry.projection_owner,
      });
      expect(Date.parse(renewedClaim.projection_lease_until ?? "")).toBeGreaterThan(initialLeaseUntilMs);
      expect(secondSettled).toBe(false);
    } catch (error) {
      assertionError = error;
    } finally {
      releaseActivation();
    }
    const results = await Promise.allSettled([first, second]);
    if (assertionError) throw assertionError;
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (rejected) throw rejected.reason;
    expect(results.map((result) => result.status === "fulfilled" && result.value.replayed))
      .toEqual([false, true]);
  });

  it("bounds an identical wait by the admitted bundle duration plus reconciliation overhead", async () => {
    const suffix = "bounded-wait";
    const key = "idem-bounded-wait";
    const boundedBundle = rehashBundle({
      ...bundle(h.rootDir(), suffix),
      bounds: { maxRequests: 1, maxDurationMs: 40, maxConcurrency: 1 },
    });
    let announceEntered!: () => void;
    let releaseProjection!: () => void;
    const entered = new Promise<void>((resolveEntered) => {
      announceEntered = resolveEntered;
    });
    const holdProjection = new Promise<void>((resolveProjection) => {
      releaseProjection = resolveProjection;
    });
    const first = importCccPrdBundle({
      ...request(suffix, key),
      bundle: boundedBundle,
      failureInjection: {
        // Lease expiry is covered separately; this case isolates the shorter
        // admitted waiter deadline even under loaded parallel proof lanes.
        projectionLeaseMs: 1_000,
        pause: {
          checkpoint: "artifact_bytes",
          entered: announceEntered,
          until: holdProjection,
        },
      },
    });
    await entered;
    let announceRowLockEntered!: () => void;
    let releaseRowLock!: () => void;
    const rowLockEntered = new Promise<void>((resolveEntered) => {
      announceRowLockEntered = resolveEntered;
    });
    const holdRowLock = new Promise<void>((resolveLock) => {
      releaseRowLock = resolveLock;
    });
    const rowLock = h.layer().transactionImmediate(async (tx) => {
      await tx.execute(sql`
        SELECT idempotency_key
        FROM project.ccc_prd_imports
        WHERE idempotency_key = ${key}
        FOR UPDATE
      `);
      announceRowLockEntered();
      await holdRowLock;
    });
    await rowLockEntered;
    const secondOutcome = importCccPrdBundle({
      ...request(suffix, key),
      bundle: boundedBundle,
      failureInjection: { reconciliationOverheadMs: 40 },
    }).then(
      (result) => ({ status: "fulfilled" as const, result }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    const observed = await Promise.race([
      secondOutcome,
      new Promise<{ status: "still-waiting" }>((resolveDelay) => {
        setTimeout(() => resolveDelay({ status: "still-waiting" }), 250);
      }),
    ]);
    let assertionError: unknown;
    try {
      expect(observed).toMatchObject({
        status: "rejected",
        error: { code: "CCC_PRD_IMPORT_RECONCILE_TIMEOUT" },
      });
    } catch (error) {
      assertionError = error;
    } finally {
      releaseRowLock();
      releaseProjection();
    }
    await rowLock;
    await first;
    await secondOutcome;
    if (assertionError) throw assertionError;
  });

  it("retries one transient PostgreSQL lease-renewal failure without losing ownership", async () => {
    const suffix = "lease-retry";
    const key = "idem-lease-retry";
    const baseLayer = h.layer();
    let failNextTransaction = false;
    let injectedFailures = 0;
    const retryingLayer: AsyncDataLayer = {
      ...baseLayer,
      transactionImmediate: async (fn, options) => {
        if (failNextTransaction) {
          failNextTransaction = false;
          injectedFailures += 1;
          throw Object.assign(new Error("synthetic serialization failure"), { code: "40001" });
        }
        return baseLayer.transactionImmediate(fn, options);
      },
    };
    let announceEntered!: () => void;
    let releaseProjection!: () => void;
    const entered = new Promise<void>((resolveEntered) => {
      announceEntered = resolveEntered;
    });
    const holdProjection = new Promise<void>((resolveProjection) => {
      releaseProjection = resolveProjection;
    });
    const importing = importCccPrdBundle({
      ...request(suffix, key),
      layer: retryingLayer,
      failureInjection: {
        projectionLeaseMs: 60,
        pause: {
          checkpoint: "artifact_bytes",
          entered: announceEntered,
          until: holdProjection,
        },
      },
    });
    await entered;
    failNextTransaction = true;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 80));
    releaseProjection();

    await expect(importing).resolves.toMatchObject({
      state: "active",
      runnable: true,
      replayed: false,
    });
    expect(injectedFailures).toBe(1);
  });

  it("surfaces projection lease ownership loss as a deterministic reconciliation conflict", async () => {
    const suffix = "lease-ownership-loss";
    const key = "idem-lease-ownership-loss";
    let announceEntered!: () => void;
    let releaseProjection!: () => void;
    const entered = new Promise<void>((resolveEntered) => {
      announceEntered = resolveEntered;
    });
    const holdProjection = new Promise<void>((resolveProjection) => {
      releaseProjection = resolveProjection;
    });
    const importing = importCccPrdBundle({
      ...request(suffix, key),
      failureInjection: {
        projectionLeaseMs: 80,
        pause: {
          checkpoint: "artifact_bytes",
          entered: announceEntered,
          until: holdProjection,
        },
      },
    });
    await entered;
    await h.layer().db.execute(sql`
      UPDATE project.ccc_prd_imports
      SET projection_owner = 'foreign-test-owner'
      WHERE idempotency_key = ${key}
    `);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 60));
    releaseProjection();

    await expect(importing).rejects.toMatchObject({
      code: "CCC_PRD_IMPORT_RECONCILE_CONFLICT",
    });
    const inspection = await inspectCccPrdImport({
      idempotencyKey: key,
      layer: h.layer(),
      rootDir: h.rootDir(),
    });
    expect(inspection).toMatchObject({
      state: "projecting",
      runnable: false,
    });
    const nativeTaskId = await nativeTaskIdForImport(
      inspection!.importId,
      `TASK-${suffix}`,
    );
    expect(await h.store().getTask(nativeTaskId)).toMatchObject({
      column: "triage",
      status: "ccc-prd-import-prepared",
      paused: true,
      userPaused: true,
    });
    expect(await h.store().getWorkflowWorkItem(
      `${inspection!.importId}--WORK-${suffix}`,
    )).toMatchObject({
      state: "held",
      blockedReason: "ccc-prd-import-prepared",
    });
    const projection = await canonicalProjectionPaths(suffix, inspection!.importId);
    expect(await fileExists(projection.taskDir)).toBe(false);
    expect(await fileExists(projection.artifact)).toBe(false);
  });

  it("namespaces global workflow and artifact IDs so independent imports cannot collide", async () => {
    const sharedWorkflowId = "WF-shared-global";
    const sharedArtifactId = "ART-shared-global";
    const leftBundle = withSharedGlobalIds(bundle(h.rootDir(), "global-left"), sharedWorkflowId, sharedArtifactId);
    const rightBundle = withSharedGlobalIds(bundle(h.rootDir(), "global-right"), sharedWorkflowId, sharedArtifactId);
    const left = await importCccPrdBundle({
      ...request("global-left", "idem-global-left"),
      bundle: leftBundle,
    });
    const right = await importCccPrdBundle({
      ...request("global-right", "idem-global-right"),
      bundle: rightBundle,
    });
    expect(left.importId).not.toBe(right.importId);
    await expect(h.store().getWorkflowDefinition(`${left.importId}--${sharedWorkflowId}`)).resolves.toBeDefined();
    await expect(h.store().getWorkflowDefinition(`${right.importId}--${sharedWorkflowId}`)).resolves.toBeDefined();
    await expect(h.store().getArtifact(`${left.importId}--${sharedArtifactId}`)).resolves.toBeDefined();
    await expect(h.store().getArtifact(`${right.importId}--${sharedArtifactId}`)).resolves.toBeDefined();
  });

  it("includes all three import custody tables in the shared PostgreSQL reset", async () => {
    await importCccPrdBundle(request("reset-custody", "idem-reset-custody"));
    await expect(inspectCccPrdImport({
      idempotencyKey: "idem-reset-custody",
      layer: h.layer(),
      rootDir: h.rootDir(),
    })).resolves.not.toBeNull();

    await h.beforeEach();
    const counts = (await h.layer().db.execute(sql.raw(`
      SELECT 'ccc_prd_imports' AS table_name, count(*)::int AS row_count FROM project.ccc_prd_imports
      UNION ALL
      SELECT 'ccc_prd_import_sources', count(*)::int FROM project.ccc_prd_import_sources
      UNION ALL
      SELECT 'ccc_prd_import_entities', count(*)::int FROM project.ccc_prd_import_entities
    `))) as unknown as Array<{ table_name: string; row_count: number }>;
    const normalizedCounts = [...counts].sort((left, right) =>
      left.table_name < right.table_name
        ? -1
        : left.table_name > right.table_name
          ? 1
          : 0);
    expect(normalizedCounts).toEqual([
      { table_name: "ccc_prd_import_entities", row_count: 0 },
      { table_name: "ccc_prd_import_sources", row_count: 0 },
      { table_name: "ccc_prd_imports", row_count: 0 },
    ]);
  });

  it("allows failed-then-retry but refuses idempotency-key collisions on bundle, target, or base", async () => {
    const retryKey = "idem-retry";
    await expect(importCccPrdBundle(request("retry", retryKey, "task"))).rejects.toMatchObject({ code: "CCC_PRD_IMPORT_INJECTED_FAILURE" });
    await expect(importCccPrdBundle(request("retry", retryKey))).resolves.toMatchObject({ state: "active" });

    const key = "idem-collision";
    await importCccPrdBundle(request("collision", key));
    await expect(importCccPrdBundle(request("different-bundle", key))).rejects.toMatchObject({ code: "CCC_PRD_IMPORT_IDEMPOTENCY_COLLISION" });
    const changedTarget = bundle(`${h.rootDir()}-other`, "collision");
    await expect(importCccPrdBundle({ ...request("collision", key), rootDir: `${h.rootDir()}-other`, bundle: rehashBundle({ ...changedTarget, targetRepository: { path: `${h.rootDir()}-other`, baseCommit: BASE } }) })).rejects.toMatchObject({ code: "CCC_PRD_IMPORT_IDEMPOTENCY_COLLISION" });
    const changedBase = bundle(h.rootDir(), "collision");
    await expect(importCccPrdBundle({ ...request("collision", key), bundle: rehashBundle({ ...changedBase, targetRepository: { path: h.rootDir(), baseCommit: "f".repeat(40) } }) })).rejects.toMatchObject({ code: "CCC_PRD_IMPORT_IDEMPOTENCY_COLLISION" });
  });

  it.each(["tasks", "artifacts", "ccc-prd-import-staging"] as const)(
    "refuses a symlink escape through the owned .fusion/%s root without external writes",
    async (ownedChild) => {
      const fusionRoot = join(h.rootDir(), ".fusion");
      const ownedPath = join(fusionRoot, ownedChild);
      const outside = await mkdtemp(join(dirname(h.rootDir()), `fusion-ccc-prd-outside-${ownedChild}-`));
      await mkdir(fusionRoot, { recursive: true });
      await rm(ownedPath, { recursive: true, force: true });
      await symlink(outside, ownedPath, "dir");
      try {
        const suffix = `symlink-${ownedChild}`;
        const key = `idem-${suffix}`;
        await expect(importCccPrdBundle(request(suffix, key))).rejects.toMatchObject({
          code: "CCC_PRD_IMPORT_WRITE_ROOT_REFUSED",
        });
        const inspection = await inspectCccPrdImport({
          idempotencyKey: key,
          layer: h.layer(),
          rootDir: h.rootDir(),
        });
        expect(inspection).toMatchObject({ state: "prepared", runnable: false });
        const nativeTaskId = await nativeTaskIdForImport(
          inspection!.importId,
          `TASK-${suffix}`,
        );
        await expect(h.store().getTask(nativeTaskId)).resolves.toMatchObject({
          column: "triage",
          status: "ccc-prd-import-prepared",
        });
        expect(await readdir(outside)).toEqual([]);
      } finally {
        await rm(ownedPath, { force: true });
        await mkdir(ownedPath, { recursive: true });
        await rm(outside, { recursive: true, force: true });
      }
    },
  );

  it("refuses a dangling symlink at an existing canonical artifact path", async () => {
    const suffix = "symlink-artifact-file";
    const key = "idem-symlink-artifact-file";
    await expect(importCccPrdBundle(
      request(suffix, key, "artifact_bytes"),
    )).rejects.toMatchObject({ code: "CCC_PRD_IMPORT_INJECTED_FAILURE" });
    const inspection = await inspectCccPrdImport({
      idempotencyKey: key,
      layer: h.layer(),
      rootDir: h.rootDir(),
    });
    const projection = await canonicalProjectionPaths(suffix, inspection?.importId);
    const outsideRoot = await mkdtemp(join(dirname(h.rootDir()), "fusion-ccc-prd-outside-artifact-"));
    const outsideFile = join(outsideRoot, "missing-artifact");
    await mkdir(dirname(projection.artifact), { recursive: true });
    await symlink(outsideFile, projection.artifact);
    try {
      await expect(importCccPrdBundle(request(suffix, key))).rejects.toMatchObject({
        code: "CCC_PRD_IMPORT_WRITE_ROOT_REFUSED",
      });
      await expect(inspectCccPrdImport({
        idempotencyKey: key,
        layer: h.layer(),
        rootDir: h.rootDir(),
      })).resolves.toMatchObject({ state: "prepared", runnable: false });
      expect(await fileExists(outsideFile)).toBe(false);
    } finally {
      await rm(projection.artifact, { force: true });
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it("refuses a byte-identical symlink at an existing canonical task directory", async () => {
    const suffix = "symlink-task-directory";
    const key = "idem-symlink-task-directory";
    await expect(importCccPrdBundle(
      request(suffix, key, "canonical_projection_move"),
    )).rejects.toMatchObject({ code: "CCC_PRD_IMPORT_INJECTED_FAILURE" });
    const inspection = await inspectCccPrdImport({
      idempotencyKey: key,
      layer: h.layer(),
      rootDir: h.rootDir(),
    });
    const projection = await canonicalProjectionPaths(suffix, inspection?.importId);
    const outsideRoot = await mkdtemp(join(dirname(h.rootDir()), "fusion-ccc-prd-outside-task-"));
    const outsideTask = join(outsideRoot, "task");
    await rename(projection.taskDir, outsideTask);
    const taskBytes = await readFile(join(outsideTask, "task.json"), "utf8");
    const promptBytes = await readFile(join(outsideTask, "PROMPT.md"), "utf8");
    await symlink(outsideTask, projection.taskDir, "dir");
    try {
      await expect(importCccPrdBundle(request(suffix, key))).rejects.toMatchObject({
        code: "CCC_PRD_IMPORT_WRITE_ROOT_REFUSED",
      });
      await expect(inspectCccPrdImport({
        idempotencyKey: key,
        layer: h.layer(),
        rootDir: h.rootDir(),
      })).resolves.toMatchObject({ state: "prepared", runnable: false });
      expect(await readFile(join(outsideTask, "task.json"), "utf8")).toBe(taskBytes);
      expect(await readFile(join(outsideTask, "PROMPT.md"), "utf8")).toBe(promptBytes);
    } finally {
      await rm(projection.taskDir, { force: true });
      await rename(outsideTask, projection.taskDir);
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });
});
