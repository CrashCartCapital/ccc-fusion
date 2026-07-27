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
  return { pty, ready: () => data?.("READY") };
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
      await importCccPrdBundle({ bundle, idempotencyKey: `public-cli-${suffix}`, store: harness.store, layer: harness.layer, rootDir: repository.root, executionPolicy: policy });
      await reconcileCccPrdImport({ idempotencyKey: `public-cli-${suffix}`, store: harness.store, layer: harness.layer, rootDir: repository.root });
      const importedTask = await harness.store.getTask(semanticTaskId);
      if (!importedTask) throw new Error("missing imported semantic task");
      await harness.store.updateTask(semanticTaskId, { worktree: repository.root } as any);
      const campaign = await harness.store.getCccCampaignContextForTask(semanticTaskId);
      if (!campaign) throw new Error("missing imported campaign context");
      const actor = { actorId: "public-cli-worker", actorType: "agent" as const, actorName: "Public CLI test" };
      const issued = await issueCccCampaignApproval(harness.layer, { authorityStore: harness.store, rootDir: repository.root, taskId: semanticTaskId, action, requester: actor, runId: `issue-${suffix}`, notBeforeAt: campaign.campaignStartedAt, expiresAt: campaign.campaignDeadlineAt });
      const claimToken = `claim-${suffix}`;
      await claimCccCampaignApproval(harness.layer, { authorityStore: harness.store, rootDir: repository.root, taskId: semanticTaskId, action, claimant: actor, runId: `claim-${suffix}`, claimToken });

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
      const runtime = new WorkflowTaskRuntime({ store: harness.store, primitives: {} as never, handlers: {}, runCustomNode: dispatcher });
      const processorStore = Object.assign(Object.create(harness.store), { getMissionStore: undefined, acquireSymbolLocks: undefined });
      const processedPromise = processDueWorkflowWorkItem(processorStore, runtime, {}, { leaseOwner: "public-cli-processor", leaseDurationMs: 60_000, kinds: ["task"] });
      let sessionId: string | undefined;
      for (let attempt = 0; attempt < 2_000 && !sessionId; attempt += 1) {
        sessionId = cliStore.listByTask(semanticTaskId)[0]?.id ?? cliStore.listSessions()[0]?.id;
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
      const durable = await harness.store.getWorkflowWorkItem(`WORK-${suffix}`);
      const sessions = cliStore.listByTask(semanticTaskId);
      const restarted = await CliSessionStore.create(harness.layer, campaign.projectId, { rootDir: repository.root, campaignAuthorityStore: harness.store });
      if (!firstBinding) throw new Error(`native CLI binding was not resolved: ${JSON.stringify({ processed, semanticNodeCalls })}`);
      const replay = await firstBinding.controller.preDispatch({ turnKey: firstBinding.turnKey, dispatchKey: firstBinding.dispatchKey, providerId: route.providerId, modelId: route.modelId, transport: route.transport });
      const replayAttempt = replay.kind === "hold" ? replay.scope : undefined;

      if (processed.runtime?.outcome !== "success") throw new Error(`public workflow failed: ${JSON.stringify(processed.runtime)}`);
      expect(processed).toMatchObject({ claimed: true, workItemId: `WORK-${suffix}`, runtime: { disposition: "completed", outcome: "success" } });
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
      await expect(harness.store.inspectCccCampaignActionLease(semanticTaskId, action)).resolves.toBeNull();
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
});
