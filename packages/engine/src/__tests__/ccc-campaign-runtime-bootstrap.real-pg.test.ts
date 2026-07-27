import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import type { TaskStore, WorkflowWorkItem } from "@fusion/core";
import {
  CCC_PRD_PROOF_ADMISSION_SCHEMA_VERSION,
  computeCccPrdProofDefinitionSha256,
  deriveWorkflowExtensionHostProvenance,
  getWorkflowExtensionHostProvenanceBinding,
  importCccPrdBundle,
  TaskStore as FreshTaskStore,
} from "@fusion/core";
import {
  createCccPrdImportTestBundle,
  createCccPrdImportTestExecutionPolicy,
  rehashCccPrdImportTestBundle,
} from "../../../core/src/__test-utils__/ccc-prd-import-fixture.js";
import { createSharedPgTaskStoreTestHarness, pgDescribe, type SharedPgTaskStoreHarness } from "../../../core/src/__test-utils__/pg-test-harness.js";
import { InProcessRuntime } from "../runtimes/in-process-runtime.js";
import { bootstrapCccCampaignProofAdmissionHost } from "../ccc-campaign-proof-host.js";
import { isImportedCccCampaignWorkItem } from "../ccc-campaign-routing.js";
import { WorkflowTaskRuntime } from "../workflow-task-runtime.js";
import { processDueWorkflowWorkItem } from "../workflow-work-processor.js";
import {
  CCC_CAMPAIGN_PROOF_ADMISSION_EXTENSION_ID,
  CCC_CAMPAIGN_PROOF_ADMISSION_PLUGIN_ID,
  CCC_CAMPAIGN_PROOF_ADMISSION_PLUGIN_VERSION,
  CCC_CAMPAIGN_PROOF_ADMISSION_PROOF_VERSION,
} from "../ccc-campaign-proof-admission.js";

type RuntimeHarness = InProcessRuntime & {
  status: "active";
  taskStore: TaskStore;
  executor: {
    execute: ReturnType<typeof vi.fn>;
    createAuthoritativeWorkflowPrimitives: ReturnType<typeof vi.fn>;
    createAuthoritativeWorkflowCustomNodeRunner: ReturnType<typeof vi.fn>;
  };
  cccCampaignProofBootstrapPromise?: Promise<void>;
  cccCampaignProofBootstrapError?: Error;
  drainWorkflowContinuations: () => Promise<void>;
};

const ENGINE_DIST_ROOT = fileURLToPath(new URL("../../dist/", import.meta.url));

const pgTest = pgDescribe;

function runtimeWithStore(store: TaskStore, rootDir: string): RuntimeHarness {
  const runtime = new InProcessRuntime({
    projectId: "runtime-real-pg",
    workingDirectory: rootDir,
    isolationMode: "in-process",
    maxConcurrent: 1,
    maxWorktrees: 1,
  } as never, {} as never) as unknown as RuntimeHarness;
  runtime.status = "active";
  runtime.taskStore = store;
  runtime.executor = {
    execute: vi.fn(async () => undefined),
    createAuthoritativeWorkflowPrimitives: vi.fn(() => ({})),
    createAuthoritativeWorkflowCustomNodeRunner: vi.fn(() => vi.fn(async () => ({
      outcome: "success" as const,
      value: "mocked-provider-effect",
    }))),
  };
  runtime.cccCampaignProofBootstrapPromise = bootstrapCccCampaignProofAdmissionHost({
    builtRootPath: ENGINE_DIST_ROOT,
  }).then(() => undefined);
  return runtime;
}

async function importCampaignFixture(h: SharedPgTaskStoreHarness, suffix: string): Promise<WorkflowWorkItem> {
  const source = await createAdmittedCampaignBundle(h.rootDir(), suffix);
  await importCccPrdBundle({
    bundle: source,
    idempotencyKey: `runtime-real-pg-${suffix}`,
    store: h.store(),
    layer: h.layer(),
    rootDir: h.rootDir(),
    executionPolicy: createCccPrdImportTestExecutionPolicy(source),
  });
  const items = await h.store().listWorkflowWorkItemsForTask(`TASK-${suffix}`);
  const item = items.find((candidate) => candidate.id === `WORK-${suffix}`);
  if (!item) throw new Error(`missing campaign work item for ${suffix}`);
  return h.store().upsertWorkflowWorkItem({
    id: item.id,
    runId: item.runId,
    taskId: item.taskId,
    nodeId: item.nodeId,
    kind: item.kind,
    state: "runnable",
    attempt: 0,
    waitReason: "planning",
    sourceColumn: "todo",
    targetColumn: "todo",
    irHash: item.irHash ?? "1".repeat(64),
  });
}

async function createAdmittedCampaignBundle(rootDir: string, suffix: string) {
  const source = createCccPrdImportTestBundle(rootDir, suffix);
  const provenance = await deriveWorkflowExtensionHostProvenance({
    pluginId: CCC_CAMPAIGN_PROOF_ADMISSION_PLUGIN_ID,
    pluginVersion: CCC_CAMPAIGN_PROOF_ADMISSION_PLUGIN_VERSION,
    trustedRootPath: ENGINE_DIST_ROOT,
    entryRelativePath: "ccc-campaign-proof-admission.js",
    manifestRelativePath: "ccc-campaign-proof-admission.manifest.json",
  });
  const binding = getWorkflowExtensionHostProvenanceBinding(provenance);
  return rehashCccPrdImportTestBundle({
    ...source,
    proofs: source.proofs.map((proof) => {
      const definition = {
        ...proof,
        command: `task verify:${suffix}`,
        positiveOracle: "workflow work item reaches a persisted terminal state",
        negativeControls: ["stale proof definition is rejected"],
      };
      return {
        ...definition,
        admission: {
          schema: CCC_PRD_PROOF_ADMISSION_SCHEMA_VERSION,
          pluginId: binding.pluginId,
          pluginVersion: binding.pluginVersion,
          extensionId: CCC_CAMPAIGN_PROOF_ADMISSION_EXTENSION_ID,
          proofVersion: CCC_CAMPAIGN_PROOF_ADMISSION_PROOF_VERSION,
          extensionRootRelativeSource: binding.extensionRootRelativeSource,
          extensionSourceSha256: binding.extensionSourceSha256,
          extensionManifestSha256: binding.extensionManifestSha256,
          definitionSha256: computeCccPrdProofDefinitionSha256(definition),
        },
      };
    }),
  });
}

async function waitFor<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  label: string,
): Promise<T> {
  let latest: T | undefined;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    latest = await read();
    if (accept(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${label} timed out; latest=${JSON.stringify(latest)}`);
}

pgTest("Task 5 RED: bootstraps one fixed proof host and one authoritative campaign runtime", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_ccc_runtime_realpg",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  it("Task 5 RED: mixed due queue preserves ordinary dispatch and claims campaign work only through the fenced processor", async () => {
    const store = h.store();
    const campaign = await importCampaignFixture(h, "runtime-realpg");
    const ordinaryTask = await store.createTask({
      title: "Ordinary due continuation",
      description: "Ordinary task stays on executor route.",
      column: "todo",
    });
    const ordinary = await store.upsertWorkflowWorkItem({
      id: "WORK-ordinary-runtime-realpg",
      runId: "ordinary-runtime-realpg",
      taskId: ordinaryTask.id,
      nodeId: "ordinary-node",
      kind: "task",
      state: "runnable",
      attempt: 0,
      waitReason: "planning",
      sourceColumn: "todo",
      targetColumn: "todo",
      irHash: "0".repeat(64),
    });
    const runtime = runtimeWithStore(store, h.rootDir());
    const listDueSpy = vi.spyOn(store, "listDueWorkflowWorkItems");
    const campaignContextSpy = vi.spyOn(store, "getCccCampaignContextForTask");
    const logEntrySpy = vi.spyOn(store, "logEntry");

    expect(campaign).toMatchObject({
      id: "WORK-runtime-realpg",
      taskId: "TASK-runtime-realpg",
      state: "runnable",
      attempt: 0,
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    expect(ordinary).toMatchObject({
      state: "runnable",
      attempt: 0,
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    expect(isImportedCccCampaignWorkItem(campaign)).toBe(true);
    await expect(store.getTask(campaign.taskId)).resolves.toMatchObject({
      id: campaign.taskId,
      column: "todo",
    });
    await expect(store.listDueWorkflowWorkItems({
      kinds: ["task"],
      states: ["runnable", "retrying"],
      limit: 20,
    })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: campaign.id, waitReason: "planning" }),
      expect.objectContaining({ id: ordinary.id, waitReason: "planning" }),
    ]));

    await runtime.drainWorkflowContinuations();
    expect(listDueSpy).toHaveBeenCalledWith({
      kinds: ["task"],
      states: ["runnable", "retrying"],
      limit: 20,
    });

    const terminal = await waitFor(
      () => store.getWorkflowWorkItem(campaign.id),
      (item): item is WorkflowWorkItem => item?.state === "succeeded",
      "campaign terminal state",
    );
    expect(terminal).toMatchObject({
      id: campaign.id,
      runId: campaign.runId,
      taskId: campaign.taskId,
      state: "succeeded",
      attempt: 1,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: null,
    });
    expect(campaignContextSpy).toHaveBeenCalledWith(campaign.taskId);
    expect(logEntrySpy).not.toHaveBeenCalledWith(
      campaign.taskId,
      expect.stringContaining("workflow work not claimed"),
    );
    expect(runtime.executor.createAuthoritativeWorkflowPrimitives).toHaveBeenCalledTimes(1);
    expect(runtime.executor.createAuthoritativeWorkflowCustomNodeRunner).toHaveBeenCalledTimes(1);
    await waitFor(
      async () => runtime.executor.execute.mock.calls.length,
      (count) => count === 1,
      "ordinary executor dispatch",
    );
    expect(runtime.executor.execute).toHaveBeenCalledWith(expect.objectContaining({
      id: ordinaryTask.id,
      title: "Ordinary due continuation",
    }));
    await expect(store.acquireWorkflowWorkItemLease(campaign.id, "second-owner", {
      leaseDurationMs: 60_000,
      expectedRunId: campaign.runId,
      expectedAttempt: 0,
    })).resolves.toBeNull();

    const restartedStore = new FreshTaskStore(h.rootDir(), undefined, {
      asyncLayer: h.layer(),
    });
    await restartedStore.init();
    const restartVisible = await restartedStore.getWorkflowWorkItem(campaign.id);
    restartedStore.stopWatching();
    expect(restartVisible).toMatchObject({
      id: campaign.id,
      runId: campaign.runId,
      taskId: campaign.taskId,
      state: "succeeded",
      attempt: 1,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: null,
    });
  });

  it("keeps campaignRequired fail-closed after a real PostgreSQL claim when custody is absent", async () => {
    const store = h.store();
    const task = await store.createTask({
      title: "Required campaign custody",
      description: "Processor must not fall through to ordinary work-item runtime.",
      column: "todo",
    });
    const item = await store.upsertWorkflowWorkItem({
      id: "WORK-campaign-required-runtime-realpg",
      runId: "campaign-required-runtime-realpg",
      taskId: task.id,
      nodeId: "campaign-required-node",
      kind: "task",
      state: "runnable",
      attempt: 0,
      waitReason: "planning",
      sourceColumn: "todo",
      targetColumn: "todo",
      irHash: "2".repeat(64),
    });
    const runtime = new WorkflowTaskRuntime({
      store,
      primitives: {},
      runCustomNode: vi.fn(async () => ({ outcome: "success" as const })),
      handlers: {},
    });

    const result = await processDueWorkflowWorkItem(store, runtime, await store.getSettings(), {
      leaseOwner: "campaign-required-realpg",
      leaseDurationMs: 60_000,
      kinds: ["task"],
      campaignRequired: true,
      exactCandidate: {
        id: item.id,
        runId: item.runId,
        attempt: item.attempt,
      },
    });

    expect(result).toMatchObject({
      claimed: true,
      workItemId: item.id,
      taskId: task.id,
      runtime: {
        disposition: "failed",
        outcome: "failure",
        reason: expect.stringContaining("workflow required campaign custody is missing"),
      },
    });
    await expect(store.getWorkflowWorkItem(item.id)).resolves.toMatchObject({
      id: item.id,
      runId: item.runId,
      taskId: task.id,
      state: "failed",
      attempt: 0,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: expect.stringContaining("workflow required campaign custody is missing"),
    });
  });

  it("does not clear a rival lease when fixed proof-host bootstrap fails after selection", async () => {
    const store = h.store();
    const campaign = await importCampaignFixture(h, "bootstrap-race");
    const runtime = runtimeWithStore(store, h.rootDir());
    let resolveBootstrap: (() => void) | undefined;
    runtime.cccCampaignProofBootstrapPromise = new Promise<void>((resolve) => {
      resolveBootstrap = resolve;
    });
    const originalGetSettings = store.getSettings.bind(store);
    let rivalLease: WorkflowWorkItem | null = null;
    vi.spyOn(store, "getSettings").mockImplementation(async () => {
      rivalLease = await store.acquireWorkflowWorkItemLease(campaign.id, "rival-runtime", {
        leaseDurationMs: 60_000,
        expectedRunId: campaign.runId,
        expectedAttempt: campaign.attempt,
      });
      return originalGetSettings();
    });

    const drain = runtime.drainWorkflowContinuations();
    await waitFor(
      async () => rivalLease,
      (lease): lease is WorkflowWorkItem => lease !== null,
      "rival campaign lease",
    );
    runtime.cccCampaignProofBootstrapError = new Error("fixture-bootstrap-failure");
    resolveBootstrap!();
    await drain;

    expect(await store.getWorkflowWorkItem(campaign.id)).toMatchObject({
      id: campaign.id,
      state: "running",
      attempt: campaign.attempt,
      leaseOwner: "rival-runtime",
      lastError: null,
    });
    expect(runtime.executor.execute).not.toHaveBeenCalled();
    expect(runtime.executor.createAuthoritativeWorkflowCustomNodeRunner).not.toHaveBeenCalled();
  });

  it("fails a still-unclaimed campaign item only after taking its exact bootstrap-refusal lease", async () => {
    const store = h.store();
    const campaign = await importCampaignFixture(h, "bootstrap-refusal");
    const runtime = runtimeWithStore(store, h.rootDir());
    runtime.cccCampaignProofBootstrapError = new Error("fixture-bootstrap-failure");
    runtime.cccCampaignProofBootstrapPromise = Promise.resolve();

    await runtime.drainWorkflowContinuations();

    await expect(store.getWorkflowWorkItem(campaign.id)).resolves.toMatchObject({
      id: campaign.id,
      state: "failed",
      attempt: campaign.attempt,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: expect.stringContaining("ccc-campaign-proof-host-bootstrap-failed:fixture-bootstrap-failure"),
    });
    expect(runtime.executor.execute).not.toHaveBeenCalled();
    expect(runtime.executor.createAuthoritativeWorkflowCustomNodeRunner).not.toHaveBeenCalled();
  });
});
