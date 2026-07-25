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
  CCC_PRD_TEST_BASE as BASE,
  createCccPrdImportTestBundle as bundle,
  rehashCccPrdImportTestBundle as rehashBundle,
} from "../../__test-utils__/ccc-prd-import-fixture.js";

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

type EmissionObserver = {
  emissions: unknown[];
  emit: (emission: unknown) => void;
};

function emissionObserver(): EmissionObserver {
  const emissions: unknown[] = [];
  return { emissions, emit: (emission) => emissions.push(emission) };
}

pgTest("CCC PRD import-owned PostgreSQL/filesystem unit of work", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_ccc_prd_import",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  function request(suffix = "base", key = "idem-base", checkpoint?: FailureCheckpoint, observer?: EmissionObserver) {
    return {
      bundle: bundle(h.rootDir(), suffix),
      idempotencyKey: key,
      store: h.store(),
      layer: h.layer(),
      rootDir: h.rootDir(),
      failureInjection: checkpoint ? { checkpoint } : undefined,
      // The importer must not emit events, invoke hooks, schedule actions, or
      // touch providers until an active import is durably reconciled.
      effects: observer,
      events: observer,
    };
  }

  async function assertNoRunnableState(key: string) {
    const inspection = await inspectCccPrdImport({ idempotencyKey: key, layer: h.layer(), rootDir: h.rootDir() });
    expect(inspection?.state ?? "absent").not.toBe("active");
    expect(await h.store().listTasks()).toHaveLength(0);
  }

  function canonicalProjectionPaths(suffix: string, importId?: string) {
    const taskDir = h.store().taskDir(`TASK-${suffix}`);
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
    const projection = canonicalProjectionPaths(suffix, inspection.importId as string);
    const stagingRoot = join(h.rootDir(), ".fusion", "ccc-prd-import-staging");
    expect(inspection.stagingRelativePath).toEqual(expect.any(String));
    const stagingRelativePath = inspection.stagingRelativePath as string;
    expect(isAbsolute(stagingRelativePath)).toBe(false);
    const stagingPath = resolve(h.rootDir(), stagingRelativePath);
    const descendant = relative(stagingRoot, stagingPath);
    expect(descendant && !descendant.startsWith(`..${sep}`) && descendant !== "..").toBe(true);
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
    const observer = emissionObserver();
    await expect(importCccPrdBundle(request("rollback", `idem-${checkpoint}`, checkpoint, observer))).rejects.toMatchObject({ code: "CCC_PRD_IMPORT_INJECTED_FAILURE" });
    await assertNoRunnableState(`idem-${checkpoint}`);
    const projection = canonicalProjectionPaths("rollback");
    expect(await fileExists(projection.taskDir)).toBe(false);
    expect(await fileExists(projection.taskJson)).toBe(false);
    expect(await fileExists(projection.prompt)).toBe(false);
    expect(await fileExists(projection.artifact)).toBe(false);
    expect(observer.emissions).toEqual([]);
  });

  it.each<FailureCheckpoint>(["after_prepared_db_commit", "task_directory", "task_json", "prompt", "artifact_bytes", "canonical_projection_move", "before_activation"])("leaves only a prepared, non-runnable state across projection boundary: %s", async (checkpoint) => {
    const key = `idem-prepared-${checkpoint}`;
    const suffix = `prepared-${checkpoint}`;
    const observer = emissionObserver();
    await expect(importCccPrdBundle(request(suffix, key, checkpoint, observer))).rejects.toMatchObject({ code: "CCC_PRD_IMPORT_INJECTED_FAILURE" });
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
    expect(await h.store().getTask(`TASK-${suffix}`)).toMatchObject({
      column: "triage",
      status: "ccc-prd-import-prepared",
      paused: true,
      userPaused: true,
    });
    expect(await h.store().getWorkflowWorkItem(`WORK-${suffix}`)).toMatchObject({
      state: "held",
      blockedReason: "ccc-prd-import-prepared",
    });
    await assertPreparedStagingOnly(before ?? {}, suffix, checkpoint);
    expect(observer.emissions).toEqual([]);

    // Restart before reconciliation. Normal list/show is intentionally not
    // used as a non-runnable oracle: legacy paused triage tasks may be listed.
    const { TaskStore } = await import("../../store.js");
    const restarted = new TaskStore(h.rootDir(), undefined, { asyncLayer: h.layer() });
    const reconciled = await reconcileCccPrdImport({ idempotencyKey: key, layer: h.layer(), store: restarted, rootDir: h.rootDir(), effects: observer, events: observer });
    expect(reconciled).toMatchObject({ state: "active", runnable: true });
    expect(await restarted.getTask(`TASK-${suffix}`)).toMatchObject({
      column: "todo",
      status: "queued",
    });
    expect(await restarted.getWorkflowWorkItem(`WORK-${suffix}`)).toMatchObject({
      state: "runnable",
      blockedReason: null,
    });
    expect(await fileExists(resolve(h.rootDir(), reconciled.stagingRelativePath))).toBe(false);
    expect(observer.emissions).toEqual([]);
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
    const projection = canonicalProjectionPaths(suffix, committed?.importId);
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

  it("commits exact semantic counts, projects task/document/artifact readers, and remains visible after restart", async () => {
    const key = "idem-success";
    const observer = emissionObserver();
    const imported = await importCccPrdBundle(request("success", key, undefined, observer));
    expect(imported).toMatchObject({ state: "active", replayed: false });
    expect(observer.emissions).toEqual([]);

    const inspection = await inspectCccPrdImport({ idempotencyKey: key, layer: h.layer(), rootDir: h.rootDir() });
    expect(inspection).toMatchObject({
      state: "active",
      runnable: true,
      directCounts: { campaigns: 1, tasks: 2, dependencyEdges: 1, workflows: 1, documents: 1, artifacts: 1, sources: 1, workItems: 1, runAudits: 1 },
    });
    const tasks = await h.store().listTasks();
    expect(tasks).toHaveLength(2);
    expect(tasks[0]?.description).toContain("projected only after commit");
    expect(await h.store().getTask("TASK-success")).toMatchObject({
      id: "TASK-success",
      column: "todo",
      status: "queued",
    });
    expect(await h.store().getTaskDocument("TASK-success", "PROMPT.md")).toMatchObject({
      id: "DOC-success",
      content: "import-owned prompt",
    });
    const nativeArtifactId = `${imported.importId}--ART-success`;
    const nativeWorkflowId = `${imported.importId}--WF-success`;
    expect(await h.store().getArtifact(nativeArtifactId)).toMatchObject({
      id: nativeArtifactId,
      title: "Import evidence",
      content: "artifact bytes",
    });
    expect(await h.store().getWorkflowDefinition(nativeWorkflowId)).toMatchObject({
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
    expect(await h.store().getWorkflowWorkItem("WORK-success")).toMatchObject({
      state: "runnable",
      blockedReason: null,
    });
    const projection = canonicalProjectionPaths("success", imported.importId);
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

  it("rebuilds missing canonical prepared files for an active import after restart", async () => {
    const suffix = "active-repair";
    const key = "idem-active-repair";
    const imported = await importCccPrdBundle(request(suffix, key));
    const projection = canonicalProjectionPaths(suffix, imported.importId);
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
    const projection = canonicalProjectionPaths(suffix, imported.importId);
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

  it("is sequentially and concurrently idempotent, including a lost response after commit", async () => {
    const key = "idem-replay";
    const replayObserver = emissionObserver();
    const first = await importCccPrdBundle(request("replay", key, undefined, replayObserver));
    const replay = await importCccPrdBundle(request("replay", key, undefined, replayObserver));
    expect(first).toMatchObject({ state: "active", replayed: false });
    expect(replay).toMatchObject({ state: "active", replayed: true });
    expect(replayObserver.emissions).toEqual([]);

    const concurrentKey = "idem-concurrent";
    const concurrentObserver = emissionObserver();
    const [left, right] = await Promise.all([
      importCccPrdBundle(request("concurrent", concurrentKey, undefined, concurrentObserver)),
      importCccPrdBundle(request("concurrent", concurrentKey, undefined, concurrentObserver)),
    ]);
    expect([left.replayed, right.replayed].filter(Boolean)).toHaveLength(1);
    expect(concurrentObserver.emissions).toEqual([]);
    const lostObserver = emissionObserver();
    await expect(importCccPrdBundle(request("lost", "idem-lost", "lost_response_after_commit", lostObserver))).rejects.toMatchObject({ code: "CCC_PRD_IMPORT_LOST_RESPONSE" });
    expect(await importCccPrdBundle(request("lost", "idem-lost", undefined, lostObserver))).toMatchObject({ state: "active", replayed: true });
    expect(lostObserver.emissions).toEqual([]);
  });

  it("keeps a live projection claim beyond lease expiry while an identical import waits", async () => {
    const suffix = "lease-renewal";
    const key = "idem-lease-renewal";
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
        projectionLeaseMs: 80,
        pause: {
          checkpoint: "artifact_bytes",
          entered: announceEntered,
          until: holdProjection,
        },
      },
    });
    await entered;
    const readClaim = async () => {
      const rows = (await h.layer().db.execute(sql`
        SELECT state, projection_owner
        FROM project.ccc_prd_imports
        WHERE idempotency_key = ${key}
      `)) as unknown as Array<{ state: string; projection_owner: string | null }>;
      return rows[0];
    };
    const beforeExpiry = await readClaim();
    expect(beforeExpiry).toMatchObject({
      state: "projecting",
      projection_owner: expect.any(String),
    });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 120));
    let secondSettled = false;
    const second = importCccPrdBundle(request(suffix, key))
      .finally(() => {
        secondSettled = true;
      });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 120));

    let assertionError: unknown;
    try {
      expect(await readClaim()).toEqual(beforeExpiry);
      expect(secondSettled).toBe(false);
    } catch (error) {
      assertionError = error;
    } finally {
      releaseProjection();
    }
    const results = await Promise.allSettled([first, second]);
    if (assertionError) throw assertionError;
    expect(results.every(({ status }) => status === "fulfilled")).toBe(true);
    expect(results.map((result) => result.status === "fulfilled" && result.value.replayed))
      .toEqual([false, true]);
  });

  it("keeps renewing through the activation handoff while an identical import waits", async () => {
    const suffix = "activation-handoff";
    const key = "idem-activation-handoff";
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
        projectionLeaseMs: 80,
        pause: {
          checkpoint: "activation_handoff",
          entered: announceEntered,
          until: holdActivation,
        },
      },
    });
    await entered;
    const readClaim = async () => {
      const rows = (await h.layer().db.execute(sql`
        SELECT state, projection_owner
        FROM project.ccc_prd_imports
        WHERE idempotency_key = ${key}
      `)) as unknown as Array<{ state: string; projection_owner: string | null }>;
      return rows[0];
    };
    const beforeExpiry = await readClaim();
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 120));
    let secondSettled = false;
    const second = importCccPrdBundle(request(suffix, key))
      .finally(() => {
        secondSettled = true;
      });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 120));

    let assertionError: unknown;
    try {
      expect(await readClaim()).toEqual(beforeExpiry);
      expect(secondSettled).toBe(false);
    } catch (error) {
      assertionError = error;
    } finally {
      releaseActivation();
    }
    const results = await Promise.allSettled([first, second]);
    if (assertionError) throw assertionError;
    expect(results.every(({ status }) => status === "fulfilled")).toBe(true);
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
        projectionLeaseMs: 40,
        pause: {
          checkpoint: "artifact_bytes",
          entered: announceEntered,
          until: holdProjection,
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
      releaseProjection();
    }
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
    await expect(inspectCccPrdImport({
      idempotencyKey: key,
      layer: h.layer(),
      rootDir: h.rootDir(),
    })).resolves.toMatchObject({
      state: "projecting",
      runnable: false,
    });
    expect(await h.store().getTask(`TASK-${suffix}`)).toMatchObject({
      column: "triage",
      status: "ccc-prd-import-prepared",
      paused: true,
      userPaused: true,
    });
    expect(await h.store().getWorkflowWorkItem(`WORK-${suffix}`)).toMatchObject({
      state: "held",
      blockedReason: "ccc-prd-import-prepared",
    });
    const projection = canonicalProjectionPaths(suffix);
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
      ORDER BY table_name
    `))) as unknown as Array<{ table_name: string; row_count: number }>;
    expect(counts).toEqual([
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
        await expect(inspectCccPrdImport({
          idempotencyKey: key,
          layer: h.layer(),
          rootDir: h.rootDir(),
        })).resolves.toMatchObject({ state: "prepared", runnable: false });
        await expect(h.store().getTask(`TASK-${suffix}`)).resolves.toMatchObject({
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
    const projection = canonicalProjectionPaths(suffix, inspection?.importId);
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
    const projection = canonicalProjectionPaths(suffix, inspection?.importId);
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
