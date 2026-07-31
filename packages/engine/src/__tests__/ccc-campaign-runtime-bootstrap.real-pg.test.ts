import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { execFile as execFileCallback } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { TaskStore, WorkflowWorkItem } from "@fusion/core";
import {
  CCC_PRD_PROOF_ADMISSION_SCHEMA_VERSION,
  computeCccPrdProofDefinitionSha256,
  deriveWorkflowExtensionHostProvenance,
  getWorkflowExtensionHostProvenanceBinding,
  importCccPrdBundle,
  inspectCccPrdProductStatus,
  queryRunAuditEvents,
  registerTaskMoveDisposer,
  TaskStore as FreshTaskStore,
} from "@fusion/core";
import {
  claimCccCampaignApproval,
  getApprovalRequest,
  issueCccCampaignApproval,
} from "../../../core/src/async-approval-request-store.js";
import {
  createCccPrdImportTestBundle,
  createCccPrdImportTestExecutionPolicy,
  createCccPrdImportTestProductExecutionPolicy,
  rehashCccPrdImportTestBundle,
} from "../../../core/src/__test-utils__/ccc-prd-import-fixture.js";
import { createSharedPgTaskStoreTestHarness, pgDescribe, type SharedPgTaskStoreHarness } from "../../../core/src/__test-utils__/pg-test-harness.js";
import { InProcessRuntime } from "../runtimes/in-process-runtime.js";
import { bootstrapCccCampaignProofAdmissionHost } from "../ccc-campaign-proof-host.js";
import { isImportedCccCampaignWorkItem } from "../ccc-campaign-routing.js";
import { WorkflowTaskRuntime } from "../workflow-task-runtime.js";
import { TaskExecutor } from "../executor.js";
import { WorkflowGraphTaskRunner } from "../workflow-graph-task-runner.js";
import { createCccCampaignProviderAttemptBinding } from "../ccc-campaign-provider-controller.js";
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
    createAuthoritativeWorkflowNodePreparation: ReturnType<typeof vi.fn>;
    createAuthoritativeWorkflowBranchPersistence: ReturnType<typeof vi.fn>;
    createCccCampaignWorkflowNodeProviderControllerResolver: ReturnType<typeof vi.fn>;
  };
  cccCampaignProofBootstrapPromise?: Promise<void>;
  cccCampaignProofBootstrapError?: Error;
  drainWorkflowContinuations: () => Promise<void>;
};

const ENGINE_DIST_ROOT = fileURLToPath(new URL("../../dist/", import.meta.url));
const execFile = promisify(execFileCallback);
const providerWorker = Object.freeze({
  actorId: "runtime-provider-worker",
  actorType: "agent" as const,
  actorName: "Runtime provider worker",
});

async function initializeGitRoot(rootDir: string): Promise<string> {
  await execFile("git", ["init", "--initial-branch=main", rootDir]);
  await commitGitRoot(rootDir, "fixture");
  const { stdout } = await execFile("git", ["-C", rootDir, "rev-parse", "HEAD"]);
  return stdout.trim();
}

async function commitGitRoot(rootDir: string, message: string): Promise<void> {
  await execFile("git", ["-C", rootDir, "add", "--all"]);
  await execFile("git", ["-C", rootDir, "-c", "user.name=Fusion Test", "-c", "user.email=fusion-test@example.invalid", "commit", "--allow-empty", "-m", message]);
}

const pgTest = pgDescribe;

function runtimeWithStore(
  store: TaskStore,
  rootDir: string,
  prepareNodeExecution = vi.fn(async () => undefined),
): RuntimeHarness {
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
    createAuthoritativeWorkflowNodePreparation: vi.fn(() => prepareNodeExecution),
    createAuthoritativeWorkflowBranchPersistence: vi.fn(() => ({
      saveBranchState: (state) => store.saveWorkflowRunBranch(state),
      loadBranchStates: (taskId, runId) => store.loadWorkflowRunBranches(taskId, runId),
      clearStaleBranchStates: (taskId, keepRunId) =>
        store.clearWorkflowRunBranches(taskId, keepRunId),
    })),
    createCccCampaignWorkflowNodeProviderControllerResolver: vi.fn(() => undefined),
  };
  runtime.cccCampaignProofBootstrapPromise = bootstrapCccCampaignProofAdmissionHost({
    builtRootPath: ENGINE_DIST_ROOT,
  }).then(() => undefined);
  return runtime;
}

async function nativeTaskIdForImport(
  h: SharedPgTaskStoreHarness,
  input: Readonly<{
    idempotencyKey: string;
    importId: string;
    semanticTaskId: string;
  }>,
): Promise<string> {
  const productStatus = await inspectCccPrdProductStatus({
    idempotencyKey: input.idempotencyKey,
    layer: h.layer(),
    rootDir: h.rootDir(),
  });
  if (!productStatus) {
    throw new Error(`missing product status for ${input.idempotencyKey}`);
  }
  expect(productStatus.import.importId).toBe(input.importId);
  const taskStatuses = productStatus.tasks.filter(
    ({ semanticTaskId }) => semanticTaskId === input.semanticTaskId,
  );
  expect(taskStatuses).toHaveLength(1);
  const nativeTaskId = taskStatuses[0]!.nativeTaskId;
  expect(nativeTaskId).not.toBe(input.semanticTaskId);
  return nativeTaskId;
}

async function importCampaignFixture(
  h: SharedPgTaskStoreHarness,
  suffix: string,
  productExecution = false,
): Promise<WorkflowWorkItem> {
  const source = await createAdmittedCampaignBundle(h.rootDir(), suffix);
  const idempotencyKey = `runtime-real-pg-${suffix}`;
  const imported = await importCccPrdBundle({
    bundle: source,
    idempotencyKey,
    store: h.store(),
    layer: h.layer(),
    rootDir: h.rootDir(),
    executionPolicy: productExecution
      ? createCccPrdImportTestProductExecutionPolicy(source)
      : createCccPrdImportTestExecutionPolicy(source),
  });
  const semanticTaskId = `TASK-${suffix}`;
  const nativeTaskId = await nativeTaskIdForImport(h, {
    idempotencyKey,
    importId: imported.importId,
    semanticTaskId,
  });
  await expect(h.store().getCccCampaignContextForTask(nativeTaskId)).resolves.toMatchObject({
    taskId: nativeTaskId,
    semanticTaskId,
  });
  const items = await h.store().listWorkflowWorkItemsForTask(nativeTaskId);
  const nativeWorkItemId = `${imported.importId}--WORK-${suffix}`;
  const item = items.find((candidate) => candidate.id === nativeWorkItemId);
  if (!item) throw new Error(`missing campaign work item for ${suffix}`);
  expect(item.id).toBe(nativeWorkItemId);
  expect(item.taskId).toBe(nativeTaskId);
  const runnable = await h.store().upsertWorkflowWorkItem({
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
  expect(runnable.taskId).toBe(nativeTaskId);
  return runnable;
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
      id: expect.stringMatching(
        /^ccc-prd-[0-9a-f]{32}--WORK-runtime-realpg$/u,
      ),
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

  it("product v2 RED: the in-process campaign runtime prepares coding nodes before provider dispatch", async () => {
    const store = h.store();
    const campaign = await importCampaignFixture(h, "product-v2-preparation", true);
    const prepareNodeExecution = vi.fn(async () => undefined);
    const runtime = runtimeWithStore(store, h.rootDir(), prepareNodeExecution);

    await runtime.drainWorkflowContinuations();
    await waitFor(
      async () => prepareNodeExecution.mock.calls.length,
      (calls) => calls === 2,
      "authoritative coding-node preparation",
    );

    expect(runtime.executor.createAuthoritativeWorkflowNodePreparation).toHaveBeenCalledTimes(1);
    expect(prepareNodeExecution).toHaveBeenCalledTimes(2);
    expect(prepareNodeExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "prompt",
        config: expect.objectContaining({
          cccPrdTaskId: "TASK-product-v2-preparation",
          toolMode: "coding",
          worktreeMode: "isolated",
          commitPolicy: "required",
        }),
      }),
      expect.objectContaining({ id: campaign.taskId }),
      expect.objectContaining({ requiresWorktree: true }),
      expect.objectContaining({
        nodeId: expect.any(String),
        materializedNodeId: expect.any(String),
      }),
      expect.objectContaining({
        executionFence: expect.objectContaining({
          workItemId: campaign.id,
          runId: campaign.runId,
        }),
      }),
    );
    expect(prepareNodeExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "prompt",
        config: expect.objectContaining({
          cccPrdTaskId: "TASK-terminal-product-v2-preparation",
          toolMode: "coding",
          worktreeMode: "isolated",
          ownedPaths: ["src/task-1"],
          allowedWriteRoots: ["src/task-1"],
          commitPolicy: "required",
        }),
      }),
      expect.objectContaining({ id: expect.any(String) }),
      expect.objectContaining({ requiresWorktree: true }),
      expect.objectContaining({
        nodeId: expect.any(String),
        materializedNodeId: expect.any(String),
      }),
      expect.objectContaining({
        executionFence: expect.objectContaining({
          workItemId: campaign.id,
          runId: campaign.runId,
        }),
      }),
    );
    const terminal = await waitFor(
      () => store.getWorkflowWorkItem(campaign.id),
      (item): item is WorkflowWorkItem => item?.state === "manual-required",
      "product-v2 preparation campaign terminal state",
    );
    expect(terminal).toMatchObject({
      blockedReason: "ccc-permanent:CCC_CAMPAIGN_PROOF_EXECUTION_REFUSED",
      leaseOwner: null,
      leaseExpiresAt: null,
    });
  });

  it("product v2 RED: a restarted claim parks mutated imported IR before any graph or provider effect", async () => {
    const campaign = await importCampaignFixture(h, "product-v2-ir-drift", true);
    const selection = await h.store().getTaskWorkflowSelectionAsync(campaign.taskId);
    if (!selection) throw new Error("missing imported workflow selection");
    const workflow = await h.store().getWorkflowDefinition(selection.workflowId);
    if (!workflow) throw new Error("missing imported workflow");
    const mutatedIr = structuredClone(workflow.ir);
    const promptNode = mutatedIr.nodes.find((node) =>
      node.kind === "prompt" && node.config?.cccPrdTaskId === "TASK-product-v2-ir-drift");
    if (!promptNode?.config) throw new Error("missing imported prompt node");
    promptNode.config.prompt = "tampered-after-import";
    await h.store().updateWorkflowDefinition(workflow.id, { ir: mutatedIr });
    const mutatedCandidate = await h.store().upsertWorkflowWorkItem({
      id: campaign.id,
      runId: campaign.runId,
      taskId: campaign.taskId,
      nodeId: campaign.nodeId,
      kind: campaign.kind,
      state: "runnable",
      attempt: campaign.attempt,
      waitReason: "planning",
      sourceColumn: "todo",
      targetColumn: "todo",
      irHash: campaign.irHash!,
    });

    const restartedStore = new FreshTaskStore(h.rootDir(), undefined, {
      asyncLayer: h.layer(),
    });
    await restartedStore.init();
    try {
      const promptEffect = vi.fn(async () => ({ outcome: "success" as const }));
      const runtime = new WorkflowTaskRuntime({
        store: restartedStore,
        primitives: {},
        runCustomNode: promptEffect,
        handlers: { prompt: promptEffect },
      });

      const result = await processDueWorkflowWorkItem(
        restartedStore,
        runtime,
        await restartedStore.getSettings(),
        {
          leaseOwner: "product-v2-ir-drift-restart",
          leaseDurationMs: 60_000,
          kinds: ["task"],
          campaignRequired: true,
          exactCandidate: {
            id: mutatedCandidate.id,
            runId: mutatedCandidate.runId,
            attempt: mutatedCandidate.attempt,
          },
        },
      );

      expect(result).toMatchObject({
        claimed: true,
        runtime: {
          disposition: "manual-required",
          outcome: "failure",
          visitedNodeIds: [],
          reason: "ccc-permanent:CCC_CAMPAIGN_NATIVE_IR_DRIFT",
        },
      });
      expect(promptEffect).not.toHaveBeenCalled();
      await expect(restartedStore.getWorkflowWorkItem(campaign.id)).resolves.toMatchObject({
        state: "manual-required",
        attempt: 1,
        leaseOwner: null,
        leaseExpiresAt: null,
        blockedReason: "ccc-permanent:CCC_CAMPAIGN_NATIVE_IR_DRIFT",
      });

      const secondRestart = new FreshTaskStore(h.rootDir(), undefined, {
        asyncLayer: h.layer(),
      });
      await secondRestart.init();
      try {
        const redispatch = vi.fn();
        await expect(processDueWorkflowWorkItem(
          secondRestart,
          { run: redispatch } as unknown as WorkflowTaskRuntime,
          await secondRestart.getSettings(),
          {
            leaseOwner: "product-v2-ir-drift-second-restart",
            leaseDurationMs: 60_000,
            kinds: ["task"],
            exactCandidate: {
              id: campaign.id,
              runId: campaign.runId,
              attempt: 1,
            },
          },
        )).resolves.toMatchObject({ claimed: false });
        expect(redispatch).not.toHaveBeenCalled();
      } finally {
        secondRestart.stopWatching();
      }
    } finally {
      restartedStore.stopWatching();
    }
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

  it("Task 6: public user cancellation durably parks a real campaign and restart cannot redispatch it", async () => {
    const store = h.store();
    const campaign = await importCampaignFixture(h, "task6-user-cancel");
    await store.moveTask(campaign.taskId, "in-progress", { moveSource: "scheduler" });
    const afterMove = await store.getWorkflowWorkItem(campaign.id);
    if (!afterMove) throw new Error("campaign item vanished after scheduler move");
    expect(afterMove).toMatchObject({ id: campaign.id, runId: campaign.runId, state: "runnable", attempt: campaign.attempt, retryAfter: null, leaseOwner: null, leaseExpiresAt: null });
    let observedSignal: AbortSignal | undefined;
    const runtime = {
      run: vi.fn((_task: unknown, _settings: unknown, options: { signal: AbortSignal }) => new Promise<Awaited<ReturnType<WorkflowTaskRuntime["run"]>>>((resolve) => {
        observedSignal = options.signal;
        options.signal.addEventListener("abort", () => resolve({
          disposition: "failed",
          outcome: "failure",
          visitedNodeIds: [],
          context: {},
          reason: "provider-observed-abort",
        }), { once: true });
      })),
    } as unknown as WorkflowTaskRuntime;

    const processing = processDueWorkflowWorkItem(store, runtime, await store.getSettings(), {
      leaseOwner: "task6-user-cancel",
      leaseDurationMs: 60_000,
      kinds: ["task"],
      campaignRequired: true,
      exactCandidate: { id: afterMove.id, runId: afterMove.runId, attempt: afterMove.attempt },
    });
    await waitFor(async () => runtime.run.mock.calls.length, (count) => count === 1, "campaign runtime dispatch");

    await store.moveTask(campaign.taskId, "todo", { moveSource: "user" });
    expect(observedSignal?.aborted).toBe(true);
    await expect(processing).resolves.toMatchObject({
      runtime: { disposition: "cancelled", reason: "workflow-user-cancelled" },
    });
    await expect(store.getWorkflowWorkItem(campaign.id)).resolves.toMatchObject({
      state: "cancelled",
      attempt: 1,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: "workflow-user-cancelled",
    });
    await expect(store.getTask(campaign.taskId)).resolves.toMatchObject({
      id: campaign.taskId,
      column: "todo",
      userPaused: true,
    });

    const restartedStore = new FreshTaskStore(h.rootDir(), undefined, { asyncLayer: h.layer() });
    await restartedStore.init();
    try {
      const restartRuntime = { run: vi.fn() } as unknown as WorkflowTaskRuntime;
      await expect(processDueWorkflowWorkItem(restartedStore, restartRuntime, await restartedStore.getSettings(), {
        leaseOwner: "task6-user-cancel-restart",
        leaseDurationMs: 60_000,
        kinds: ["task"],
        exactCandidate: { id: campaign.id, runId: campaign.runId, attempt: 1 },
      })).resolves.toMatchObject({ claimed: false });
      expect(restartRuntime.run).not.toHaveBeenCalled();
      await expect(restartedStore.getWorkflowWorkItem(campaign.id)).resolves.toMatchObject({
        state: "cancelled",
        attempt: 1,
        leaseOwner: null,
      });
      await expect(restartedStore.getTask(campaign.taskId)).resolves.toMatchObject({
        column: "todo",
        userPaused: true,
      });
    } finally {
      restartedStore.stopWatching();
    }
  });

  it("Task 6 P1 RED: a claim that lands during a public move is cancelled and cannot redispatch after restart", async () => {
    const store = h.store();
    const campaign = await importCampaignFixture(h, "task6-late-claim");
    await store.moveTask(campaign.taskId, "in-progress", { moveSource: "scheduler" });
    const candidate = await store.getWorkflowWorkItem(campaign.id);
    if (!candidate) throw new Error("late-claim campaign item vanished");

    let releaseClaim!: () => void;
    const claimHeld = new Promise<void>((resolve) => { releaseClaim = resolve; });
    let signalClaimEntered!: () => void;
    const claimEntered = new Promise<void>((resolve) => { signalClaimEntered = resolve; });
    const originalAcquire = store.acquireWorkflowWorkItemLease.bind(store);
    const acquireSpy = vi.spyOn(store, "acquireWorkflowWorkItemLease").mockImplementation(async (id, leaseOwner, opts) => {
      if (id === candidate.id && leaseOwner === "task6-late-claim-owner") {
        signalClaimEntered();
        await claimHeld;
      }
      return originalAcquire(id, leaseOwner, opts);
    });

    let releaseMoveDisposer!: () => void;
    const moveDisposerHeld = new Promise<void>((resolve) => { releaseMoveDisposer = resolve; });
    let signalMoveDisposerEntered!: () => void;
    const moveDisposerEntered = new Promise<void>((resolve) => { signalMoveDisposerEntered = resolve; });
    const unregisterMoveDisposer = registerTaskMoveDisposer(store, async (task) => {
      if (task.id !== campaign.taskId) return;
      signalMoveDisposerEntered();
      await moveDisposerHeld;
    });

    let releaseTerminalCas!: () => void;
    const terminalCasHeld = new Promise<void>((resolve) => { releaseTerminalCas = resolve; });
    let signalTerminalCasEntered!: () => void;
    const terminalCasEntered = new Promise<void>((resolve) => { signalTerminalCasEntered = resolve; });
    const originalTransition = store.transitionWorkflowWorkItem.bind(store);
    const transitionSpy = vi.spyOn(store, "transitionWorkflowWorkItem").mockImplementation(async (id, state, patch, tx) => {
      if (
        id === candidate.id
        && state === "cancelled"
        && patch.expectedLeaseOwner === "task6-late-claim-owner"
      ) {
        signalTerminalCasEntered();
        await terminalCasHeld;
      }
      return originalTransition(id, state, patch, tx);
    });

    const runtime = { run: vi.fn() } as unknown as WorkflowTaskRuntime;
    const processing = processDueWorkflowWorkItem(store, runtime, await store.getSettings(), {
      leaseOwner: "task6-late-claim-owner",
      leaseDurationMs: 60_000,
      kinds: ["task"],
      campaignRequired: true,
      exactCandidate: { id: candidate.id, runId: candidate.runId, attempt: candidate.attempt },
    });

    let move: Promise<unknown> | undefined;
    try {
      await claimEntered;
      move = store.moveTask(campaign.taskId, "todo", { moveSource: "user" });
      await moveDisposerEntered;
      releaseClaim();
      await terminalCasEntered;
      expect(runtime.run).not.toHaveBeenCalled();

      releaseMoveDisposer();
      await expect(move).resolves.toMatchObject({ column: "todo", userPaused: true });
      await expect(store.getWorkflowWorkItem(candidate.id)).resolves.toMatchObject({
        state: "cancelled",
        leaseOwner: null,
        leaseExpiresAt: null,
      });
      expect(runtime.run).not.toHaveBeenCalled();

      releaseTerminalCas();
      await expect(processing).resolves.toMatchObject({
        runtime: { disposition: "cancelled" },
      });

      const terminal = await store.getWorkflowWorkItem(candidate.id);
      if (!terminal) throw new Error("late-claim campaign terminal item vanished");
      const restartedStore = new FreshTaskStore(h.rootDir(), undefined, { asyncLayer: h.layer() });
      await restartedStore.init();
      try {
        const restartRuntime = { run: vi.fn() } as unknown as WorkflowTaskRuntime;
        await expect(processDueWorkflowWorkItem(restartedStore, restartRuntime, await restartedStore.getSettings(), {
          leaseOwner: "task6-late-claim-restart",
          leaseDurationMs: 60_000,
          kinds: ["task"],
          exactCandidate: { id: terminal.id, runId: terminal.runId, attempt: terminal.attempt },
        })).resolves.toMatchObject({ claimed: false });
        expect(restartRuntime.run).not.toHaveBeenCalled();
      } finally {
        restartedStore.stopWatching();
      }
    } finally {
      releaseClaim();
      releaseMoveDisposer();
      releaseTerminalCas();
      unregisterMoveDisposer();
      await move?.catch(() => undefined);
      await processing.catch(() => undefined);
      transitionSpy.mockRestore();
      acquireSpy.mockRestore();
    }
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

  it("Task 6 RED: recreates a real committed provider binding and holds its exact replay without another provider effect", async () => {
    const store = h.store();
    const rootDir = h.rootDir();
    const baseCommit = await initializeGitRoot(rootDir);
    const initial = createCccPrdImportTestBundle(rootDir, "task6-committed-replay");
    const action = Object.freeze({
      actionId: "ACTION-LIVE-EXECUTION",
      actionTarget: "ccc-lab-super:pre-live-provider-gate",
      requireProtected: true as const,
    });
    const source = rehashCccPrdImportTestBundle({
      ...initial,
      targetRepository: { ...initial.targetRepository, baseCommit },
      bounds: { maxRequests: 3, maxDurationMs: 60_000, maxConcurrency: 1 },
      tasks: initial.tasks.map((task, index) => index === 0
        ? { ...task, protectedActionIds: [action.actionId] }
        : task),
      protectedActions: [{
        id: action.actionId,
        kind: "live_execution",
        target: action.actionTarget,
        requiresOperatorDecision: true,
        operatorDecision: "approve_live_execution",
        spans: [initial.tasks[0]!.spans[0]!],
      }],
    });
    const idempotencyKey = "runtime-real-pg-task6-committed-replay";
    const imported = await importCccPrdBundle({
      bundle: source,
      idempotencyKey,
      store,
      layer: h.layer(),
      rootDir,
      executionPolicy: createCccPrdImportTestExecutionPolicy(source),
    });
    await commitGitRoot(rootDir, "campaign import");
    const semanticTaskId = "TASK-task6-committed-replay";
    const taskId = await nativeTaskIdForImport(h, {
      idempotencyKey,
      importId: imported.importId,
      semanticTaskId,
    });
    const campaign = await store.getCccCampaignContextForTask(taskId);
    if (!campaign) throw new Error("missing Task 6 campaign context");
    expect(campaign).toMatchObject({ taskId, semanticTaskId });
    const issued = await issueCccCampaignApproval(h.layer(), {
      authorityStore: store,
      rootDir,
      taskId,
      action,
      requester: providerWorker,
      runId: "issue-task6-committed-replay",
      notBeforeAt: campaign.campaignStartedAt,
      expiresAt: campaign.campaignDeadlineAt,
    });
    const claimToken = "claim-task6-committed-replay";
    await claimCccCampaignApproval(h.layer(), {
      authorityStore: store,
      rootDir,
      taskId,
      action,
      claimant: providerWorker,
      runId: "claim-task6-committed-replay",
      claimToken,
    });
    const dispatch = Object.freeze({
      turnKey: "turn-task6-committed-replay",
      dispatchKey: "dispatch-task6-committed-replay",
      providerId: campaign.route.providerId,
      modelId: campaign.route.modelId,
      transport: campaign.route.transport,
    });
    const reserved = await store.reserveCccProviderAttempt({
      taskId,
      actionId: action.actionId,
      actionTarget: action.actionTarget,
      ...dispatch,
    });
    await expect(store.beginCccProviderAttemptDispatch({
      taskId,
      attemptKey: reserved.attemptKey,
      controllerToken: reserved.controllerToken,
    })).resolves.toMatchObject({ kind: "dispatch-permit" });
    await expect(store.settleCccProviderAttemptAndApproval({
      ...reserved,
      outcome: "committed",
      evidenceDigest: "d".repeat(64),
      observerId: "task6-committed-replay",
    })).resolves.toMatchObject({ state: "committed" });
    await expect(getApprovalRequest(h.layer().db, issued.id)).resolves.toMatchObject({
      status: "consumed",
      campaign: { claimToken },
    });
    await expect(store.inspectCccCampaignActionLease(taskId, action)).resolves.toBeNull();

    const attemptsBeforeReplay = await queryRunAuditEvents(h.layer().db, { taskId });
    const binding = await createCccCampaignProviderAttemptBinding({
      layer: h.layer(),
      rootDir,
      authorityStore: store,
      semanticTaskId,
      nativeTaskId: taskId,
      turnKey: dispatch.turnKey,
      expectedRoute: {
        transport: "pi",
        providerId: campaign.route.providerId,
        modelId: campaign.route.modelId,
      },
    });
    await expect(binding.controller.preDispatch(dispatch)).resolves.toMatchObject({
      kind: "hold",
      reason: "terminal",
      scope: { attemptKey: reserved.attemptKey, state: "committed" },
    });
    await expect(store.getCccCampaignContextForTask(taskId)).resolves.toMatchObject({ requestCount: 1 });
    const attemptsAfterReplay = await queryRunAuditEvents(h.layer().db, { taskId });
    expect(attemptsAfterReplay).toHaveLength(attemptsBeforeReplay.length);
  });

  it("Task 6 P1 RED: refuses a cross-wired same-task settlement before consuming its approval", async () => {
    const store = h.store();
    const rootDir = h.rootDir();
    const baseCommit = await initializeGitRoot(rootDir);
    const initial = createCccPrdImportTestBundle(rootDir, "task6-provider-identity");
    const action = Object.freeze({
      actionId: "ACTION-LIVE-EXECUTION",
      actionTarget: "ccc-lab-super:pre-live-provider-gate",
      requireProtected: true as const,
    });
    const source = rehashCccPrdImportTestBundle({
      ...initial,
      targetRepository: { ...initial.targetRepository, baseCommit },
      bounds: { maxRequests: 3, maxDurationMs: 60_000, maxConcurrency: 1 },
      tasks: initial.tasks.map((task, index) => index === 0
        ? { ...task, protectedActionIds: [action.actionId] }
        : task),
      protectedActions: [{
        id: action.actionId,
        kind: "live_execution",
        target: action.actionTarget,
        requiresOperatorDecision: true,
        operatorDecision: "approve_live_execution",
        spans: [initial.tasks[0]!.spans[0]!],
      }],
    });
    const idempotencyKey = "runtime-real-pg-task6-provider-identity";
    const imported = await importCccPrdBundle({
      bundle: source,
      idempotencyKey,
      store,
      layer: h.layer(),
      rootDir,
      executionPolicy: createCccPrdImportTestExecutionPolicy(source),
    });
    await commitGitRoot(rootDir, "campaign import");
    const semanticTaskId = "TASK-task6-provider-identity";
    const taskId = await nativeTaskIdForImport(h, {
      idempotencyKey,
      importId: imported.importId,
      semanticTaskId,
    });
    const campaign = await store.getCccCampaignContextForTask(taskId);
    if (!campaign) throw new Error("missing Task 6 provider-identity campaign context");
    expect(campaign).toMatchObject({ taskId, semanticTaskId });
    const issued = await issueCccCampaignApproval(h.layer(), {
      authorityStore: store,
      rootDir,
      taskId,
      action,
      requester: providerWorker,
      runId: "issue-task6-provider-identity",
      notBeforeAt: campaign.campaignStartedAt,
      expiresAt: campaign.campaignDeadlineAt,
    });
    const claimToken = "claim-task6-provider-identity";
    await claimCccCampaignApproval(h.layer(), {
      authorityStore: store,
      rootDir,
      taskId,
      action,
      claimant: providerWorker,
      runId: "claim-task6-provider-identity",
      claimToken,
    });
    const dispatchA = Object.freeze({
      turnKey: "turn-task6-provider-identity-A",
      dispatchKey: "dispatch-task6-provider-identity-A",
      providerId: campaign.route.providerId,
      modelId: campaign.route.modelId,
      transport: campaign.route.transport,
    });
    const dispatchB = Object.freeze({
      turnKey: "turn-task6-provider-identity-B",
      dispatchKey: "dispatch-task6-provider-identity-B",
      providerId: campaign.route.providerId,
      modelId: campaign.route.modelId,
      transport: campaign.route.transport,
    });
    const bindingA = await createCccCampaignProviderAttemptBinding({
      layer: h.layer(), rootDir, authorityStore: store, semanticTaskId, nativeTaskId: taskId, turnKey: dispatchA.turnKey,
      expectedRoute: { transport: "pi", providerId: campaign.route.providerId, modelId: campaign.route.modelId },
    });
    const bindingB = await createCccCampaignProviderAttemptBinding({
      layer: h.layer(), rootDir, authorityStore: store, semanticTaskId, nativeTaskId: taskId, turnKey: dispatchB.turnKey,
      expectedRoute: { transport: "pi", providerId: campaign.route.providerId, modelId: campaign.route.modelId },
    });
    const permitB = await bindingB.controller.preDispatch(dispatchB);
    if (permitB.kind !== "dispatch-permit") throw new Error("expected Task 6 B dispatch permit");
    const auditsBefore = await queryRunAuditEvents(h.layer().db, { taskId });

    await expect(bindingA.controller.reconcile({
      ...permitB.scope,
      turnKey: dispatchA.turnKey,
      dispatchKey: dispatchA.dispatchKey,
      outcome: "committed",
      evidenceDigest: "e".repeat(64),
      observerId: "task6-provider-identity",
    })).rejects.toThrow(/identity|turn/i);

    await expect(store.inspectCccProviderAttempt({ taskId, attemptKey: permitB.scope.attemptKey })).resolves.toMatchObject({
      state: "dispatched_unknown",
      controllerToken: permitB.scope.controllerToken,
    });
    await expect(getApprovalRequest(h.layer().db, issued.id)).resolves.toMatchObject({
      status: "claimed",
      campaign: { claimToken },
    });
    await expect(store.inspectCccCampaignActionLease(taskId, action)).resolves.toMatchObject({
      lease: { claimToken },
    });
    expect(await queryRunAuditEvents(h.layer().db, { taskId })).toHaveLength(auditsBefore.length);
  });
});

pgTest("Task 6 real PostgreSQL: a user cancellation wins before a first-run CCC terminal result can publish work", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_ccc_terminal_race_realpg",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  it("keeps Todo/userPaused and no workflow task work across a fresh store restart", async () => {
    const store = h.store();
    const task = await store.createTask({
      title: "Terminal publication race",
      description: "A user move must fence the late terminal publication.",
      column: "in-progress",
      customFields: { cccFusionProfile: "ccc-fusion" },
    });
    await store.writeTaskWorkflowSelection(task.id, "builtin:coding", []);

    let resolveGraph!: (result: {
      disposition: "failed";
      outcome: "failure";
      reason: string;
      context: Record<string, unknown>;
      visitedNodeIds: string[];
    }) => void;
    const delayedGraph = new Promise<Parameters<typeof resolveGraph>[0]>((resolve) => {
      resolveGraph = resolve;
    });
    const runSpy = vi.spyOn(WorkflowGraphTaskRunner.prototype, "run").mockReturnValue(delayedGraph);
    const withTaskLockSpy = vi.spyOn(store, "withTaskLock");
    const upsertSpy = vi.spyOn(store, "upsertWorkflowWorkItem");
    const executor = new TaskExecutor(store, h.rootDir());
    let releaseMoveDisposer!: () => void;
    const moveDisposerEntered = new Promise<void>((resolve) => {
      releaseMoveDisposer = resolve;
    });
    let notifyMoveDisposerEntered!: () => void;
    const moveDisposerHasEntered = new Promise<void>((resolve) => {
      notifyMoveDisposerEntered = resolve;
    });
    const unregisterBlocker = registerTaskMoveDisposer(store, async (movingTask) => {
      if (movingTask.id !== task.id) return;
      notifyMoveDisposerEntered();
      await moveDisposerEntered;
    });
    let execution: Promise<void> | undefined;
    let userMove: Promise<unknown> | undefined;

    try {
      execution = executor.execute(task);
      await vi.waitFor(() => expect(runSpy).toHaveBeenCalledOnce());

      userMove = store.moveTask(task.id, "todo", { moveSource: "user" });
      await moveDisposerHasEntered;
      const withTaskLockBaseline = withTaskLockSpy.mock.calls.length;

      resolveGraph({
        disposition: "failed",
        outcome: "failure",
        reason: "ccc-branch-persistence-terminal-failed",
        context: { "ccc:branch-persistence-failure": "ccc-branch-persistence-terminal-failed" },
        visitedNodeIds: ["start", "A", "fanout", "B"],
      });

      await waitFor(
        async () => ({
          publisherEntered: withTaskLockSpy.mock.calls.length > withTaskLockBaseline,
          upserted: upsertSpy.mock.calls.length > 0,
        }),
        (state) => state.publisherEntered || state.upserted,
        "terminal publisher lock attempt",
      );
      expect(upsertSpy).not.toHaveBeenCalled();
      await expect(store.listWorkflowWorkItemsForTask(task.id, { kinds: ["task"] })).resolves.toEqual([]);

      releaseMoveDisposer();
      await userMove;
      await execution;

      await expect(store.getTask(task.id)).resolves.toMatchObject({
        id: task.id,
        column: "todo",
        userPaused: true,
      });
      await expect(store.listWorkflowWorkItemsForTask(task.id, { kinds: ["task"] })).resolves.toEqual([]);

      const restartedStore = new FreshTaskStore(h.rootDir(), undefined, { asyncLayer: h.layer() });
      await restartedStore.init();
      try {
        await expect(restartedStore.listWorkflowWorkItemsForTask(task.id, { kinds: ["task"] })).resolves.toEqual([]);
        await expect(restartedStore.listDueWorkflowWorkItems({
          kinds: ["task"],
          states: ["runnable", "retrying"],
          limit: 20,
        })).resolves.toEqual([]);
      } finally {
        restartedStore.stopWatching();
      }
    } finally {
      releaseMoveDisposer();
      await userMove?.catch(() => undefined);
      await execution?.catch(() => undefined);
      executor.disposeStoreLifecycleDisposers();
      unregisterBlocker();
      runSpy.mockRestore();
      withTaskLockSpy.mockRestore();
      upsertSpy.mockRestore();
    }
  });
});
