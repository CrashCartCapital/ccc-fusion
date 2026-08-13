import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  CliSessionStore,
  computeCccPrdProofDefinitionSha256,
  deriveWorkflowExtensionHostProvenance,
  getWorkflowExtensionHostProvenanceBinding,
  getWorkflowExtensionRegistry,
  importCccPrdBundle,
  inspectCccPrdProductStatus,
  reconcileCccPrdImport,
  type CccNativeCliRoute,
  type CccPrdProof,
  type WorkflowProofAdmissionEvaluator,
  CCC_PRD_PROOF_ADMISSION_SCHEMA_VERSION,
  WORKFLOW_EXTENSION_SCHEMA_VERSION,
  __resetWorkflowExtensionRegistryForTests,
} from "@fusion/core";
import { claimCccCampaignApproval, getApprovalRequest, issueCccCampaignApproval } from "../../../core/src/async-approval-request-store.js";
import { createCccPrdImportTestBundle, rehashCccPrdImportTestBundle } from "../../../core/src/__test-utils__/ccc-prd-import-fixture.js";
import { createTaskStoreForTest, pgDescribe } from "../../../core/src/__test-utils__/pg-test-harness.js";
import { type CliAgentAdapter } from "../cli-agent/adapter.js";
import { type CccNativeCliBinding } from "../cli-agent/ccc-native-cli-binding.js";
import { createCliAgentRuntime } from "../cli-agent/runtime.js";
import { TaskExecutor } from "../executor.js";
import { WorkflowTaskRuntime } from "../workflow-task-runtime.js";
import { processDueWorkflowWorkItem } from "../workflow-work-processor.js";
import { CCC_CAMPAIGN_PROOF_ADMISSION_EXTENSION_ID, CCC_CAMPAIGN_PROOF_ADMISSION_PLUGIN_ID, CCC_CAMPAIGN_PROOF_ADMISSION_PLUGIN_VERSION, CCC_CAMPAIGN_PROOF_ADMISSION_PROOF_VERSION } from "../ccc-campaign-proof-admission.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function createCleanGitRepository(root: string): { root: string; base: string } {
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.name", "CCC test"]);
  git(root, ["config", "user.email", "ccc-test@example.invalid"]);
  writeFileSync(join(root, ".gitignore"), "*\n!.gitignore\n!tracked.txt\n");
  writeFileSync(join(root, "tracked.txt"), "base\n");
  git(root, ["add", ".gitignore", "tracked.txt"]);
  git(root, ["commit", "-q", "-m", "base"]);
  return { root: realpathSync(root), base: git(root, ["rev-parse", "HEAD"]) };
}

function fakePty() {
  let data: ((value: string) => void) | undefined;
  let exited = false;
  let onExit: ((value: { exitCode: number; signal: number }) => void) | undefined;
  const pty = {
    pid: 7123,
    onData: vi.fn((listener: (value: string) => void) => { data = listener; return () => { data = undefined; }; }),
    onExit: vi.fn((listener: (value: { exitCode: number; signal: number }) => void) => { onExit = listener; return () => { onExit = undefined; }; }),
    write: vi.fn(),
    resize: vi.fn(), pause: vi.fn(), resume: vi.fn(), kill: vi.fn(() => { if (!exited) { exited = true; queueMicrotask(() => onExit?.({ exitCode: 0, signal: 0 })); } }),
  };
  return {
    pty,
    ready: () => data?.("READY"),
    exit: (exitCode: number, signal = 0) => {
      if (exited) return;
      exited = true;
      queueMicrotask(() => onExit?.({ exitCode, signal }));
    },
  };
}

async function admittedBundle(source: ReturnType<typeof createCccPrdImportTestBundle>, proofRoot: string) {
  const entry = "export async function evaluateTestProof(input) { return Object.freeze({ outcome: 'pass', evaluatedInputSha256: input.inputSha256, summary: 'public route proof' }); }\n";
  await mkdir(join(proofRoot, "dist"), { recursive: true });
  await writeFile(join(proofRoot, "dist", "proof.mjs"), entry);
  await writeFile(join(proofRoot, "plugin.json"), `${JSON.stringify({ id: CCC_CAMPAIGN_PROOF_ADMISSION_PLUGIN_ID, version: CCC_CAMPAIGN_PROOF_ADMISSION_PLUGIN_VERSION })}\n`);
  const provenance = await deriveWorkflowExtensionHostProvenance({ pluginId: CCC_CAMPAIGN_PROOF_ADMISSION_PLUGIN_ID, pluginVersion: CCC_CAMPAIGN_PROOF_ADMISSION_PLUGIN_VERSION, trustedRootPath: proofRoot, entryRelativePath: "dist/proof.mjs", manifestRelativePath: "plugin.json" });
  const binding = getWorkflowExtensionHostProvenanceBinding(provenance);
  const definition: CccPrdProof = { ...source.proofs[0]!, command: "ccc-test:public-route.v1", positiveOracle: "public route proof", negativeControls: ["refuse altered public route proof"] };
  const proof: CccPrdProof = { ...definition, admission: { schema: CCC_PRD_PROOF_ADMISSION_SCHEMA_VERSION, pluginId: binding.pluginId, pluginVersion: binding.pluginVersion, extensionId: CCC_CAMPAIGN_PROOF_ADMISSION_EXTENSION_ID, proofVersion: CCC_CAMPAIGN_PROOF_ADMISSION_PROOF_VERSION, extensionRootRelativeSource: binding.extensionRootRelativeSource, extensionSourceSha256: binding.extensionSourceSha256, extensionManifestSha256: binding.extensionManifestSha256, definitionSha256: computeCccPrdProofDefinitionSha256(definition) } };
  __resetWorkflowExtensionRegistryForTests();
  const module = await import(`data:text/javascript;base64,${Buffer.from(entry).toString("base64")}`) as { evaluateTestProof: WorkflowProofAdmissionEvaluator };
  getWorkflowExtensionRegistry().register(CCC_CAMPAIGN_PROOF_ADMISSION_PLUGIN_ID, { extensionId: CCC_CAMPAIGN_PROOF_ADMISSION_EXTENSION_ID, name: "public route proof", kind: "proof-admission", schemaVersion: WORKFLOW_EXTENSION_SCHEMA_VERSION, fallback: "failClosed", proofVersion: CCC_CAMPAIGN_PROOF_ADMISSION_PROOF_VERSION, evaluate: module.evaluateTestProof }, provenance);
  return rehashCccPrdImportTestBundle({ ...source, proofs: [proof] });
}

pgDescribe("CCC native CLI public workflow route (real PostgreSQL)", () => {
  it("Task 5 RED: public factory installs the persisted native resolver only with complete campaign wiring", async () => {
    const harness = await createTaskStoreForTest({ prefix: "fusion_ccc_public_cli_factory", copyFromGolden: true });
    const repository = createCleanGitRepository(harness.rootDir);
    let runtime: Awaited<ReturnType<typeof createCliAgentRuntime>> | undefined;
    try {
      runtime = await createCliAgentRuntime({
        fusionDir: harness.store.getFusionDir(),
        asyncLayer: harness.layer,
        projectId: "public-cli-factory",
        hookEndpointUrl: "http://127.0.0.1:1/unused",
        rootDir: repository.root,
        campaignAuthorityStore: harness.store,
      });
      expect(runtime.bundle.resolveCccNativeCliBinding).toEqual(expect.any(Function));
    } finally {
      await runtime?.dispose();
      await harness.teardown();
    }
  });

  it("parks campaign-global request exhaustion on the native CLI route before PTY spawn", async () => {
    const harness = await createTaskStoreForTest({
      prefix: "fusion_ccc_public_cli_budget",
      copyFromGolden: true,
    });
    const repository = createCleanGitRepository(harness.rootDir);
    const proofRoot = await mkdtemp(join(tmpdir(), "ccc-public-cli-budget-proof-"));
    const suffix = "public-cli-budget";
    let boot: Awaited<ReturnType<typeof createCliAgentRuntime>> | undefined;
    try {
      const initial = createCccPrdImportTestBundle(repository.root, suffix);
      const semanticTaskId = `TASK-${suffix}`;
      const action = {
        actionId: "ACTION-PROVIDER-BUDGET",
        actionTarget: "ccc:test-public-cli-budget",
        requireProtected: true,
      };
      const bundle = await admittedBundle(rehashCccPrdImportTestBundle({
        ...initial,
        targetRepository: { path: repository.root, baseCommit: repository.base },
        bounds: { maxRequests: 1, maxDurationMs: 60_000, maxConcurrency: 1 },
        protectedActions: [{
          id: action.actionId,
          kind: "live_execution",
          target: action.actionTarget,
          requiresOperatorDecision: true,
          operatorDecision: "approve_live_execution",
          spans: [initial.tasks[0]!.spans[0]!],
        }],
        tasks: initial.tasks.map((task, index) => index === 0
          ? { ...task, protectedActionIds: [action.actionId] }
          : task),
      }), proofRoot);
      const policy = {
        schema: "ccc-campaign.execution-policy.v1" as const,
        routes: bundle.tasks.map((task) => ({
          taskId: task.id,
          providerId: "test-provider",
          modelId: "test-model",
          transport: "cli" as const,
        })),
      };
      const idempotencyKey = `public-cli-${suffix}`;
      const imported = await importCccPrdBundle({
        bundle,
        idempotencyKey,
        store: harness.store,
        layer: harness.layer,
        rootDir: repository.root,
        executionPolicy: policy,
      });
      await reconcileCccPrdImport({
        idempotencyKey,
        store: harness.store,
        layer: harness.layer,
        rootDir: repository.root,
      });
      const status = await inspectCccPrdProductStatus({
        idempotencyKey,
        layer: harness.layer,
        rootDir: repository.root,
      });
      if (!status) throw new Error("missing native CLI budget status");
      const matchingTasks = status.tasks.filter((task) =>
        task.semanticTaskId === semanticTaskId);
      expect(matchingTasks).toHaveLength(1);
      const nativeTaskId = matchingTasks[0]!.nativeTaskId;
      const workItemId = `${imported.importId}--WORK-${suffix}`;
      const workItem = await harness.store.getWorkflowWorkItem(workItemId);
      if (!workItem) throw new Error("missing native CLI budget work item");
      await harness.store.updateTask(nativeTaskId, { worktree: repository.root } as any);
      const campaign = await harness.store.getCccCampaignContextForTask(nativeTaskId);
      if (!campaign) throw new Error("missing native CLI budget campaign");
      const actor = {
        actorId: "public-cli-budget-worker",
        actorType: "agent" as const,
        actorName: "Public CLI budget test",
      };
      await issueCccCampaignApproval(harness.layer, {
        authorityStore: harness.store,
        rootDir: repository.root,
        taskId: nativeTaskId,
        action,
        requester: actor,
        runId: `issue-${suffix}`,
        notBeforeAt: campaign.campaignStartedAt,
        expiresAt: campaign.campaignDeadlineAt,
      });
      await claimCccCampaignApproval(harness.layer, {
        authorityStore: harness.store,
        rootDir: repository.root,
        taskId: nativeTaskId,
        action,
        claimant: actor,
        runId: `claim-${suffix}`,
        claimToken: `claim-${suffix}`,
      });
      const spent = await harness.store.reserveCccProviderAttempt({
        taskId: nativeTaskId,
        actionId: action.actionId,
        actionTarget: action.actionTarget,
        turnKey: "ccc-cli-turn-budget-fixture",
        dispatchKey: "ccc-native-cli:budget-fixture",
        providerId: "test-provider",
        modelId: "test-model",
        transport: "cli",
        workItemFence: {
          workItemId,
          runId: workItem.runId,
          attempt: workItem.attempt + 1,
        },
      });
      await harness.store.proveCccProviderAttemptNotDispatched({
        taskId: nativeTaskId,
        attemptKey: spent.attemptKey,
        controllerToken: spent.controllerToken,
      });

      const route: CccNativeCliRoute = Object.freeze({
        adapterId: "public-route-cli-budget",
        providerId: "test-provider",
        modelId: "test-model",
        transport: "cli",
      });
      const adapter: CliAgentAdapter = {
        id: route.adapterId,
        name: "public route budget fake",
        capabilities: {
          nativeDone: true,
          nativeWaiting: false,
          transcriptSource: "none",
          supportsResume: false,
        },
        buildLaunch: () => ({ command: "local-fake", args: [] }),
        buildEnvAllowlist: () => [],
        createReadinessDetector: () => ({ observe: (value: string) => value === "READY" }),
        formatInjection: (text) => ({ payload: text }),
      };
      const spawn = vi.fn();
      boot = await createCliAgentRuntime({
        fusionDir: harness.store.getFusionDir(),
        asyncLayer: harness.layer,
        projectId: campaign.projectId,
        rootDir: repository.root,
        campaignAuthorityStore: harness.store,
        hookEndpointUrl: "http://127.0.0.1:1/unused",
        managerOptions: {
          concurrencyCeiling: 1,
          loadPty: async () => ({ spawn }) as never,
        },
      });
      boot.bundle.registry.register(adapter);
      const executor = new TaskExecutor(harness.store as any, repository.root, {
        cliAgentRuntime: boot.bundle,
      });
      vi.spyOn(executor as any, "resolveMcpServers").mockResolvedValue([]);
      let semanticNodeCalls = 0;
      const runtime = new WorkflowTaskRuntime({
        store: harness.store,
        primitives: {} as never,
        handlers: {},
        runCustomNode: (node, task, context, execution) => {
          if (semanticNodeCalls++ > 0) {
            return Promise.resolve({ outcome: "success" as const });
          }
          return (executor as any).runGraphCustomNode({
            ...node,
            config: {
              ...(node.config ?? {}),
              executor: "cli-agent",
              cliAdapterId: route.adapterId,
              cliSettings: {
                profile: "ccc-fusion",
                subscriptionReady: true,
                model: route.modelId,
                providerId: route.providerId,
              },
              prompt: "local only",
            },
          }, task, {}, undefined, context, execution);
        },
        branchPersistence: executor.createAuthoritativeWorkflowBranchPersistence(),
      });
      const processorStore = Object.assign(Object.create(harness.store), {
        getMissionStore: undefined,
        acquireSymbolLocks: undefined,
      });
      const processed = await processDueWorkflowWorkItem(
        processorStore,
        runtime,
        {},
        {
          leaseOwner: "public-cli-budget-processor",
          leaseDurationMs: 60_000,
          kinds: ["task"],
        },
      );

      expect(processed).toMatchObject({
        claimed: true,
        workItemId,
        taskId: nativeTaskId,
        runtime: {
          disposition: "manual-required",
          outcome: "failure",
          reason: "ccc-permanent:CCC_CAMPAIGN_REQUEST_BUDGET_EXHAUSTED",
        },
      });
      await expect(harness.store.getWorkflowWorkItem(workItemId)).resolves.toMatchObject({
        state: "manual-required",
        lastError: "ccc-permanent:CCC_CAMPAIGN_REQUEST_BUDGET_EXHAUSTED",
        blockedReason: "ccc-permanent:CCC_CAMPAIGN_REQUEST_BUDGET_EXHAUSTED",
      });
      expect(spawn).not.toHaveBeenCalled();
      expect(boot.bundle.store.listByTask(nativeTaskId)).toEqual([]);
      await expect(harness.store.getCccCampaignContextForTask(nativeTaskId))
        .resolves.toMatchObject({ requestCount: 1 });
    } finally {
      await boot?.dispose();
      __resetWorkflowExtensionRegistryForTests();
      await rm(proofRoot, { recursive: true, force: true });
      await harness.teardown();
    }
  });

  it("Task 5 RED: production native CLI resolver binds persisted route lease and restart settlement", async () => {
    const harness = await createTaskStoreForTest({ prefix: "fusion_ccc_public_cli", copyFromGolden: true });
    const repository = createCleanGitRepository(harness.rootDir);
    const proofRoot = await mkdtemp(join(tmpdir(), "ccc-public-cli-proof-"));
    const suffix = "public-cli";
    let boot: Awaited<ReturnType<typeof createCliAgentRuntime>> | undefined;
    try {
      const initial = createCccPrdImportTestBundle(repository.root, suffix);
      const semanticTaskId = `TASK-${suffix}`;
      const action = { actionId: "ACTION-PROVIDER", actionTarget: "ccc:test-public-cli", requireProtected: true };
      const bundle = await admittedBundle(rehashCccPrdImportTestBundle({
        ...initial,
        targetRepository: { path: repository.root, baseCommit: repository.base },
        bounds: { maxRequests: 1, maxDurationMs: 60_000, maxConcurrency: 1 },
        protectedActions: [{ id: action.actionId, kind: "live_execution", target: action.actionTarget, requiresOperatorDecision: true, operatorDecision: "approve_live_execution", spans: [initial.tasks[0]!.spans[0]!] }],
        tasks: initial.tasks.map((task, index) => index === 0 ? { ...task, protectedActionIds: [action.actionId] } : task),
      }), proofRoot);
      const policy = { schema: "ccc-campaign.execution-policy.v1" as const, routes: bundle.tasks.map((task) => ({ taskId: task.id, providerId: "test-provider", modelId: "test-model", transport: "cli" as const })) };
      const idempotencyKey = `public-cli-${suffix}`;
      const imported = await importCccPrdBundle({ bundle, idempotencyKey, store: harness.store, layer: harness.layer, rootDir: repository.root, executionPolicy: policy });
      await reconcileCccPrdImport({ idempotencyKey, store: harness.store, layer: harness.layer, rootDir: repository.root });
      const productStatus = await inspectCccPrdProductStatus({
        idempotencyKey,
        layer: harness.layer,
        rootDir: repository.root,
      });
      if (!productStatus) throw new Error("missing public CLI product status");
      expect(productStatus.import.importId).toBe(imported.importId);
      const taskStatuses = productStatus.tasks.filter(
        (task) => task.semanticTaskId === semanticTaskId,
      );
      expect(taskStatuses).toHaveLength(1);
      const nativeTaskId = taskStatuses[0]!.nativeTaskId;
      expect(nativeTaskId).not.toBe(semanticTaskId);
      const workItemId = `${imported.importId}--WORK-${suffix}`;
      const importedTask = await harness.store.getTask(nativeTaskId);
      if (!importedTask) throw new Error("missing imported semantic task");
      expect(importedTask.sourceMetadata).toMatchObject({ semanticTaskId });
      await harness.store.updateTask(nativeTaskId, { worktree: repository.root } as any);
      const campaign = await harness.store.getCccCampaignContextForTask(nativeTaskId);
      if (!campaign) throw new Error("missing imported campaign context");
      expect(campaign).toMatchObject({ taskId: nativeTaskId, semanticTaskId });
      const actor = { actorId: "public-cli-worker", actorType: "agent" as const, actorName: "Public CLI test" };
      const issued = await issueCccCampaignApproval(harness.layer, { authorityStore: harness.store, rootDir: repository.root, taskId: nativeTaskId, action, requester: actor, runId: `issue-${suffix}`, notBeforeAt: campaign.campaignStartedAt, expiresAt: campaign.campaignDeadlineAt });
      const claimToken = `claim-${suffix}`;
      await claimCccCampaignApproval(harness.layer, { authorityStore: harness.store, rootDir: repository.root, taskId: nativeTaskId, action, claimant: actor, runId: `claim-${suffix}`, claimToken });

      const route: CccNativeCliRoute = Object.freeze({ adapterId: "public-route-cli", providerId: "test-provider", modelId: "test-model", transport: "cli" });
      const adapter: CliAgentAdapter = { id: route.adapterId, name: "public route fake", capabilities: { nativeDone: true, nativeWaiting: false, transcriptSource: "none", supportsResume: false }, buildLaunch: () => ({ command: "local-fake", args: [] }), buildEnvAllowlist: () => [], createReadinessDetector: () => ({ observe: (value: string) => value === "READY" }), formatInjection: (text) => ({ payload: text }) };
      const pty = fakePty();
      const spawn = vi.fn(() => { queueMicrotask(pty.ready); return pty.pty; });
      const bindingCalls: unknown[] = [];
      let firstBinding: CccNativeCliBinding | undefined;
      let semanticNodeCalls = 0;
      boot = await createCliAgentRuntime({
        fusionDir: harness.store.getFusionDir(), asyncLayer: harness.layer, projectId: campaign.projectId,
        rootDir: repository.root, campaignAuthorityStore: harness.store, hookEndpointUrl: "http://127.0.0.1:1/unused",
        managerOptions: { concurrencyCeiling: 1, loadPty: async () => ({ spawn }) as never },
      });
      boot.bundle.registry.register(adapter);
      const productionResolver = boot.bundle.resolveCccNativeCliBinding;
      if (!productionResolver) throw new Error("public factory omitted production resolver");
      boot.bundle.resolveCccNativeCliBinding = async (input) => {
        bindingCalls.push(input);
        const binding = await productionResolver(input) as CccNativeCliBinding;
        firstBinding ??= binding;
        return binding;
      };
      const cliStore = boot.bundle.store;
      const executor = new TaskExecutor(harness.store as any, repository.root, { cliAgentRuntime: boot.bundle });
      vi.spyOn(executor as any, "resolveMcpServers").mockResolvedValue([]);
      const dispatcher = async (node: any, task: any, context: any, execution: any) => {
        if (semanticNodeCalls++ > 0) return { outcome: "success" as const };
        return (executor as any).runGraphCustomNode({ ...node, config: { ...(node.config ?? {}), executor: "cli-agent", cliAdapterId: route.adapterId, cliSettings: { profile: "ccc-fusion", subscriptionReady: true, model: route.modelId, providerId: route.providerId }, prompt: "local only" } }, task, {}, undefined, context, execution);
      };
      const runtime = new WorkflowTaskRuntime({
        store: harness.store,
        primitives: {} as never,
        handlers: {},
        runCustomNode: dispatcher,
        branchPersistence:
          executor.createAuthoritativeWorkflowBranchPersistence(),
      });
      const processorStore = Object.assign(Object.create(harness.store), { getMissionStore: undefined, acquireSymbolLocks: undefined });
      const processedPromise = processDueWorkflowWorkItem(processorStore, runtime, {}, { leaseOwner: "public-cli-processor", leaseDurationMs: 60_000, kinds: ["task"] });
      let sessionId: string | undefined;
      for (let attempt = 0; attempt < 2_000 && !sessionId; attempt += 1) {
        sessionId = cliStore.listByTask(nativeTaskId)[0]?.id ?? cliStore.listSessions()[0]?.id;
        if (!sessionId) await new Promise((resolve) => setTimeout(resolve, 5));
      }
      if (!sessionId) throw new Error("fake PTY was not admitted before native done");
      await vi.waitFor(() => {
        expect(pty.pty.write).toHaveBeenCalledOnce();
        expect(boot?.bundle.hub.getStateMachine(sessionId)?.getState()).toBe("busy");
      }, { timeout: 10_000, interval: 5 });
      boot.bundle.hub.ingest(sessionId, { kind: "done" });
      const processed = await processedPromise;
      await cliStore.flush();
      const durable = await harness.store.getWorkflowWorkItem(workItemId);
      const sessions = cliStore.listByTask(nativeTaskId);
      const restarted = await CliSessionStore.create(harness.layer, campaign.projectId, { rootDir: repository.root, campaignAuthorityStore: harness.store });
      if (!firstBinding) throw new Error(`native CLI binding was not resolved: ${JSON.stringify({ processed, semanticNodeCalls })}`);
      const replay = await firstBinding.controller.preDispatch({ turnKey: firstBinding.turnKey, dispatchKey: firstBinding.dispatchKey, providerId: route.providerId, modelId: route.modelId, transport: route.transport });
      const replayAttempt = replay.kind === "hold" ? replay.scope : undefined;

      if (processed.runtime?.outcome !== "success") throw new Error(`public workflow failed: ${JSON.stringify(processed.runtime)}`);
      expect(processed).toMatchObject({ claimed: true, workItemId, taskId: nativeTaskId, runtime: { disposition: "completed", outcome: "success" } });
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(bindingCalls).toHaveLength(1);
      expect(pty.pty.write).toHaveBeenCalledOnce();
      expect(durable).toMatchObject({ state: "succeeded" });
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({ agentState: "dead", terminationReason: "completed", autonomyPosture: expect.objectContaining({ cccControllerFenced: true, cccNativeCliClosureState: "settled" }) });
      expect(restarted.getSession(sessions[0]!.id)).toEqual(sessions[0]);
      expect(boot.bundle.manager.activeCount()).toBe(0);
      expect(replay).toMatchObject({ kind: "hold" });
      await expect(getApprovalRequest(harness.layer.db, issued.id)).resolves.toMatchObject({ status: "consumed" });
      await expect(harness.store.inspectCccCampaignActionLease(nativeTaskId, action)).resolves.toBeNull();
      if (!replayAttempt) {
        throw new Error(`replay did not include an attempt scope: ${JSON.stringify(replay)}`);
      }
      await expect(harness.store.inspectCccProviderAttempt({
        taskId: replayAttempt.taskId,
        attemptKey: replayAttempt.attemptKey,
      })).resolves.toMatchObject({
        state: "committed",
        terminal: {
          kind: "reconciled",
          state: "committed",
          evidenceDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      });
    } finally {
      __resetWorkflowExtensionRegistryForTests();
      await boot?.dispose();
      await rm(proofRoot, { recursive: true, force: true });
      await harness.teardown();
    }
  });

  it.each([
    {
      observedOutcome: "committed" as const,
      terminalWorkItemState: "succeeded",
      terminationReason: "completed",
    },
    {
      observedOutcome: "proved_failed" as const,
      terminalWorkItemState: "failed",
      terminationReason: "crashed",
    },
  ])(
    "P1 real-PG crash cut: $observedOutcome held closure rehydrates without provider redispatch",
    async ({
      observedOutcome,
      terminalWorkItemState,
      terminationReason,
    }) => {
      const suffix = `restart-${observedOutcome.replace("_", "-")}`;
      const harness = await createTaskStoreForTest({
        prefix: `fusion_ccc_public_cli_${suffix}`,
        copyFromGolden: true,
      });
      const repository = createCleanGitRepository(harness.rootDir);
      const proofRoot = await mkdtemp(join(tmpdir(), "ccc-public-cli-restart-proof-"));
      let firstBoot: Awaited<ReturnType<typeof createCliAgentRuntime>> | undefined;
      let restartedBoot: Awaited<ReturnType<typeof createCliAgentRuntime>> | undefined;
      let releaseFirstObserver: (() => void) | undefined;
      let firstProcessor:
        | ReturnType<typeof processDueWorkflowWorkItem>
        | undefined;
      try {
        const initial = createCccPrdImportTestBundle(repository.root, suffix);
        const semanticTaskId = `TASK-${suffix}`;
        const action = {
          actionId: "ACTION-PROVIDER",
          actionTarget: `ccc:test-public-cli-${suffix}`,
          requireProtected: true,
        };
        const bundle = await admittedBundle(rehashCccPrdImportTestBundle({
          ...initial,
          targetRepository: {
            path: repository.root,
            baseCommit: repository.base,
          },
          bounds: {
            maxRequests: 1,
            maxDurationMs: 180_000,
            maxConcurrency: 1,
          },
          protectedActions: [{
            id: action.actionId,
            kind: "live_execution",
            target: action.actionTarget,
            requiresOperatorDecision: true,
            operatorDecision: "approve_live_execution",
            spans: [initial.tasks[0]!.spans[0]!],
          }],
          tasks: initial.tasks.map((task, index) => index === 0
            ? { ...task, protectedActionIds: [action.actionId] }
            : task),
        }), proofRoot);
        const policy = {
          schema: "ccc-campaign.execution-policy.v1" as const,
          routes: bundle.tasks.map((task) => ({
            taskId: task.id,
            providerId: "test-provider",
            modelId: "test-model",
            transport: "cli" as const,
          })),
        };
        const idempotencyKey = `public-cli-${suffix}`;
        const imported = await importCccPrdBundle({
          bundle,
          idempotencyKey,
          store: harness.store,
          layer: harness.layer,
          rootDir: repository.root,
          executionPolicy: policy,
        });
        await reconcileCccPrdImport({
          idempotencyKey,
          store: harness.store,
          layer: harness.layer,
          rootDir: repository.root,
        });
        const status = await inspectCccPrdProductStatus({
          idempotencyKey,
          layer: harness.layer,
          rootDir: repository.root,
        });
        if (!status) throw new Error("missing native CLI restart status");
        const matchingTasks = status.tasks.filter(
          (task) => task.semanticTaskId === semanticTaskId,
        );
        expect(matchingTasks).toHaveLength(1);
        const nativeTaskId = matchingTasks[0]!.nativeTaskId;
        const workItemId = `${imported.importId}--WORK-${suffix}`;
        await harness.store.updateTask(nativeTaskId, {
          worktree: repository.root,
        } as any);
        const campaign =
          await harness.store.getCccCampaignContextForTask(nativeTaskId);
        if (!campaign) throw new Error("missing native CLI restart campaign");

        const actor = {
          actorId: `public-cli-${suffix}`,
          actorType: "agent" as const,
          actorName: "Public CLI restart test",
        };
        await issueCccCampaignApproval(harness.layer, {
          authorityStore: harness.store,
          rootDir: repository.root,
          taskId: nativeTaskId,
          action,
          requester: actor,
          runId: `issue-${suffix}`,
          notBeforeAt: campaign.campaignStartedAt,
          expiresAt: campaign.campaignDeadlineAt,
        });
        await claimCccCampaignApproval(harness.layer, {
          authorityStore: harness.store,
          rootDir: repository.root,
          taskId: nativeTaskId,
          action,
          claimant: actor,
          runId: `claim-${suffix}`,
          claimToken: `claim-${suffix}`,
        });

        const route: CccNativeCliRoute = Object.freeze({
          adapterId: `public-route-cli-${suffix}`,
          providerId: "test-provider",
          modelId: "test-model",
          transport: "cli",
        });
        const adapter: CliAgentAdapter = {
          id: route.adapterId,
          name: `public route fake ${suffix}`,
          capabilities: {
            nativeDone: true,
            nativeWaiting: false,
            transcriptSource: "none",
            supportsResume: false,
          },
          buildLaunch: () => ({ command: "local-fake", args: [] }),
          buildEnvAllowlist: () => [],
          createReadinessDetector: () => ({
            observe: (value: string) => value === "READY",
          }),
          formatInjection: (text) => ({ payload: text }),
        };
        const firstPty = fakePty();
        const firstSpawn = vi.fn(() => {
          queueMicrotask(firstPty.ready);
          return firstPty.pty;
        });
        firstBoot = await createCliAgentRuntime({
          fusionDir: harness.store.getFusionDir(),
          asyncLayer: harness.layer,
          projectId: campaign.projectId,
          rootDir: repository.root,
          campaignAuthorityStore: harness.store,
          hookEndpointUrl: "http://127.0.0.1:1/unused",
          managerOptions: {
            concurrencyCeiling: 1,
            loadPty: async () => ({ spawn: firstSpawn }) as never,
          },
        });
        firstBoot.bundle.registry.register(adapter);
        const productionResolver = firstBoot.bundle.resolveCccNativeCliBinding;
        if (!productionResolver) {
          throw new Error("first native CLI runtime omitted production resolver");
        }
        let observerEnteredResolve: (() => void) | undefined;
        const observerEntered = new Promise<void>((resolve) => {
          observerEnteredResolve = resolve;
        });
        const observerRelease = new Promise<void>((resolve) => {
          releaseFirstObserver = resolve;
        });
        firstBoot.bundle.resolveCccNativeCliBinding = async (input) => {
          const binding =
            await productionResolver(input) as CccNativeCliBinding;
          return Object.freeze({
            ...binding,
            observer: Object.freeze({
              id: binding.observer.id,
              observe: async (value: unknown) => {
                observerEnteredResolve?.();
                await observerRelease;
                return binding.observer.observe(value);
              },
            }),
          }) satisfies CccNativeCliBinding;
        };

        const firstExecutor = new TaskExecutor(
          harness.store as any,
          repository.root,
          { cliAgentRuntime: firstBoot.bundle },
        );
        vi.spyOn(firstExecutor as any, "resolveMcpServers")
          .mockResolvedValue([]);
        let firstSemanticNodeCalls = 0;
        const firstRuntime = new WorkflowTaskRuntime({
          store: harness.store,
          primitives: {} as never,
          handlers: {},
          runCustomNode: (node, task, context, execution) => {
            if (firstSemanticNodeCalls++ > 0) {
              return Promise.resolve({ outcome: "success" as const });
            }
            return (firstExecutor as any).runGraphCustomNode({
              ...node,
              config: {
                ...(node.config ?? {}),
                executor: "cli-agent",
                cliAdapterId: route.adapterId,
                cliSettings: {
                  profile: "ccc-fusion",
                  subscriptionReady: true,
                  model: route.modelId,
                  providerId: route.providerId,
                },
                prompt: "local only",
              },
            }, task, {}, undefined, context, execution);
          },
          branchPersistence:
            firstExecutor.createAuthoritativeWorkflowBranchPersistence(),
        });
        const firstProcessorStore = Object.assign(
          Object.create(harness.store),
          {
            getMissionStore: undefined,
            acquireSymbolLocks: undefined,
            renewWorkflowWorkItemLease: vi.fn(
              async (id: string) => harness.store.getWorkflowWorkItem(id),
            ),
          },
        );
        firstProcessor = processDueWorkflowWorkItem(
          firstProcessorStore,
          firstRuntime,
          {},
          {
            leaseOwner: `public-cli-first-${suffix}`,
            // Must outlast the real dispatch chain's fresh-lease liveness check (not just PTY spawn); renewal below is deliberately a no-op so it still expires once disposed.
            leaseDurationMs: 5_000,
            kinds: ["task"],
          },
        );

        let firstSessionId: string | undefined;
        for (
          let attempt = 0;
          attempt < 2_000 && !firstSessionId;
          attempt += 1
        ) {
          firstSessionId =
            firstBoot.bundle.store.listByTask(nativeTaskId)[0]?.id;
          if (!firstSessionId) {
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
        }
        if (!firstSessionId) {
          throw new Error("first runtime never persisted the native CLI session");
        }
        await vi.waitFor(() => {
          expect(firstPty.pty.write).toHaveBeenCalledOnce();
          expect(
            firstBoot?.bundle.hub
              .getStateMachine(firstSessionId!)
              ?.getState(),
          ).toBe("busy");
        }, { timeout: 10_000, interval: 5 });
        if (observedOutcome === "committed") {
          firstBoot.bundle.hub.ingest(firstSessionId, { kind: "done" });
        } else {
          firstPty.exit(1);
        }
        await observerEntered;
        await firstBoot.bundle.store.flush();
        expect(
          firstBoot.bundle.store.getSession(firstSessionId),
        ).toMatchObject({
          agentState: "needsAttention",
          terminationReason: null,
          autonomyPosture: expect.objectContaining({
            cccNativeCliClosureState: "held-closed",
            cccControllerFenced: false,
            cccNativeCliHeldClosureEvidence: expect.objectContaining({
              kind: "ccc-fusion.native-cli-held-closure-evidence",
              trigger: observedOutcome === "committed" ? "done" : "exit",
            }),
          }),
        });
        const crashedWorkItem =
          await harness.store.getWorkflowWorkItem(workItemId);
        expect(crashedWorkItem).toMatchObject({
          state: "running",
          attempt: 1,
          leaseOwner: `public-cli-first-${suffix}`,
        });
        const attemptKey = firstBoot.bundle.store
          .getSession(firstSessionId)
          ?.autonomyPosture?.cccProviderAttemptKey;
        expect(attemptKey).toEqual(
          expect.stringMatching(/^ccc-provider-attempt-[a-f0-9]{64}$/u),
        );

        await firstBoot.dispose();
        firstBoot = undefined;
        const leaseDelay = Math.max(
          0,
          Date.parse(crashedWorkItem!.leaseExpiresAt!) - Date.now() + 20,
        );
        await new Promise((resolve) => setTimeout(resolve, leaseDelay));

        const restartedSpawn = vi.fn();
        restartedBoot = await createCliAgentRuntime({
          fusionDir: harness.store.getFusionDir(),
          asyncLayer: harness.layer,
          projectId: campaign.projectId,
          rootDir: repository.root,
          campaignAuthorityStore: harness.store,
          hookEndpointUrl: "http://127.0.0.1:1/unused",
          managerOptions: {
            concurrencyCeiling: 1,
            loadPty: async () => ({ spawn: restartedSpawn }) as never,
          },
        });
        restartedBoot.bundle.registry.register(adapter);
        expect(
          restartedBoot.bundle.store.getSession(firstSessionId),
        ).toMatchObject({
          agentState: "needsAttention",
          terminationReason: null,
          autonomyPosture: expect.objectContaining({
            cccNativeCliClosureState: "held-closed",
            cccControllerFenced: false,
          }),
        });
        const restartedExecutor = new TaskExecutor(
          harness.store as any,
          repository.root,
          { cliAgentRuntime: restartedBoot.bundle },
        );
        const resolveMcpServers = vi.spyOn(
          restartedExecutor as any,
          "resolveMcpServers",
        ).mockResolvedValue([]);
        let restartedSemanticNodeCalls = 0;
        const restartedRuntime = new WorkflowTaskRuntime({
          store: harness.store,
          primitives: {} as never,
          handlers: {},
          runCustomNode: (node, task, context, execution) => {
            if (restartedSemanticNodeCalls++ > 0) {
              return Promise.resolve({ outcome: "success" as const });
            }
            return (restartedExecutor as any).runGraphCustomNode({
              ...node,
              config: {
                ...(node.config ?? {}),
                executor: "cli-agent",
                cliAdapterId: route.adapterId,
                cliSettings: {
                  profile: "ccc-fusion",
                  subscriptionReady: true,
                  model: route.modelId,
                  providerId: route.providerId,
                },
                prompt: "local only",
              },
            }, task, {}, undefined, context, execution);
          },
          branchPersistence:
            restartedExecutor.createAuthoritativeWorkflowBranchPersistence(),
        });
        const restartedProcessorStore = Object.assign(
          Object.create(harness.store),
          {
            getMissionStore: undefined,
            acquireSymbolLocks: undefined,
          },
        );
        const exactCandidate = {
          id: crashedWorkItem!.id,
          runId: crashedWorkItem!.runId,
          attempt: crashedWorkItem!.attempt,
        };
        const restarted = await processDueWorkflowWorkItem(
          restartedProcessorStore,
          restartedRuntime,
          {},
          {
            leaseOwner: `public-cli-restarted-${suffix}`,
            leaseDurationMs: 60_000,
            kinds: ["task"],
            exactCandidate,
          },
        );
        expect(restarted).toMatchObject({
          claimed: true,
          workItemId,
          taskId: nativeTaskId,
          runtime: {
            disposition: observedOutcome === "committed"
              ? "completed"
              : "failed",
            outcome: observedOutcome === "committed"
              ? "success"
              : "failure",
          },
        });
        expect(restartedSpawn).not.toHaveBeenCalled();
        expect(resolveMcpServers).not.toHaveBeenCalled();
        expect(
          await harness.store.getWorkflowWorkItem(workItemId),
        ).toMatchObject({
          state: terminalWorkItemState,
          attempt: 1,
          leaseOwner: null,
          leaseExpiresAt: null,
        });
        expect(
          restartedBoot.bundle.store.getSession(firstSessionId),
        ).toMatchObject({
          agentState: "dead",
          terminationReason,
          autonomyPosture: expect.objectContaining({
            cccNativeCliClosureState: "settled",
            cccControllerFenced: true,
          }),
        });
        await expect(harness.store.inspectCccProviderAttempt({
          taskId: nativeTaskId,
          attemptKey: attemptKey!,
        })).resolves.toMatchObject({
          state: observedOutcome,
          terminal: {
            kind: "reconciled",
            state: observedOutcome,
            observerId: "ccc-native-cli-observer.v1",
          },
        });
        await expect(
          harness.store.getCccCampaignContextForTask(nativeTaskId),
        ).resolves.toMatchObject({ requestCount: 1 });

        await expect(processDueWorkflowWorkItem(
          restartedProcessorStore,
          restartedRuntime,
          {},
          {
            leaseOwner: `public-cli-second-restart-${suffix}`,
            leaseDurationMs: 60_000,
            kinds: ["task"],
            exactCandidate,
          },
        )).resolves.toEqual({ claimed: false });
        expect(restartedSpawn).not.toHaveBeenCalled();

        releaseFirstObserver?.();
        releaseFirstObserver = undefined;
        await expect(firstProcessor).rejects.toThrow(
          /transition precondition|workflow work item/i,
        );
        firstProcessor = undefined;
        expect(firstSpawn).toHaveBeenCalledTimes(1);
        expect(
          await harness.store.getWorkflowWorkItem(workItemId),
        ).toMatchObject({
          state: terminalWorkItemState,
          attempt: 1,
          leaseOwner: null,
        });
      } finally {
        releaseFirstObserver?.();
        await firstProcessor?.catch(() => undefined);
        await restartedBoot?.dispose();
        await firstBoot?.dispose();
        __resetWorkflowExtensionRegistryForTests();
        await rm(proofRoot, { recursive: true, force: true });
        await harness.teardown();
      }
    },
    60_000,
  );
});
