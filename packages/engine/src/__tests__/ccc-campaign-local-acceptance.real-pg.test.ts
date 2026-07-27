import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  CCC_PRD_PROOF_ADMISSION_SCHEMA_VERSION,
  computeCccPrdProofDefinitionSha256,
  deriveWorkflowExtensionHostProvenance,
  getWorkflowExtensionHostProvenanceBinding,
  getWorkflowExtensionRegistry,
  importCccPrdBundle,
  queryRunAuditEvents,
  WORKFLOW_EXTENSION_SCHEMA_VERSION,
  type WorkflowNodeHandlerInput,
} from "@fusion/core";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { rehashCccPrdImportTestBundle } from "../../../core/src/__test-utils__/ccc-prd-import-fixture.js";
import { createSharedPgTaskStoreTestHarness, pgDescribe } from "../../../core/src/__test-utils__/pg-test-harness.js";
import { claimCccCampaignApproval, getApprovalRequest, issueCccCampaignApproval } from "../../../core/src/async-approval-request-store.js";
import { bootstrapCccCampaignProofAdmissionHost } from "../ccc-campaign-proof-host.js";
import {
  CCC_CAMPAIGN_PROOF_ADMISSION_EXTENSION_ID,
  CCC_CAMPAIGN_PROOF_ADMISSION_PLUGIN_ID,
  CCC_CAMPAIGN_PROOF_ADMISSION_PLUGIN_VERSION,
  CCC_CAMPAIGN_PROOF_ADMISSION_PROOF_VERSION,
} from "../ccc-campaign-proof-admission.js";
import { TaskExecutor } from "../executor.js";
import { runAiMerge } from "../merger-ai.js";
import { WorkflowTaskRuntime } from "../workflow-task-runtime.js";
import { processDueWorkflowWorkItem } from "../workflow-work-processor.js";
import { resolveTaskWorkingBranch } from "../worktree-names.js";
import { createJoinedLocalCampaignScenario } from "./fixtures/ccc-campaign/joined-local-campaign.js";

const ENGINE_DIST_ROOT = fileURLToPath(new URL("../../dist/", import.meta.url));
const APPROVE_OUTPUT = '{"verdict":"APPROVE","notes":""}';

const piHarness = vi.hoisted(() => ({
  createAgentSession: vi.fn(),
  sessions: [] as Array<{ model: { provider?: string; id?: string }; options: Record<string, unknown> }>,
}));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return { ...actual, createAgentSession: piHarness.createAgentSession };
});

function git(rootDir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: rootDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function initializeDisposableGitRoot(rootDir: string): string {
  rmSync(join(rootDir, ".git"), { recursive: true, force: true });
  rmSync(join(rootDir, "src"), { recursive: true, force: true });
  git(rootDir, ["init", "-q", "-b", "main"]);
  git(rootDir, ["config", "user.name", "CCC local acceptance"]);
  git(rootDir, ["config", "user.email", "ccc-local-acceptance@example.invalid"]);
  writeFileSync(join(rootDir, ".gitignore"), ".fusion/\nnode_modules/\n");
  writeFileSync(join(rootDir, "README.md"), "base\n");
  git(rootDir, ["add", ".gitignore", "README.md"]);
  git(rootDir, ["commit", "-q", "--allow-empty", "-m", "base"]);
  return git(rootDir, ["rev-parse", "HEAD"]);
}

function createForbiddenEffectRecorder() {
  const effects: string[] = [];
  return {
    effects,
    deps: {
      mergeAgent: async () => { effects.push("provider:mergeAgent"); throw new Error("provider merger must not run"); },
      reviewAgent: async () => { effects.push("provider:reviewAgent"); throw new Error("provider reviewer must not run"); },
      stashResolveAgent: async () => { effects.push("legacy:stashResolveAgent"); throw new Error("legacy stash resolver must not run"); },
    },
  };
}

function waitForAbort(signal: AbortSignal | undefined): Promise<void> {
  if (!signal || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

async function admitBundle<T extends Parameters<typeof rehashCccPrdImportTestBundle>[0]>(bundle: T) {
  const provenance = await deriveWorkflowExtensionHostProvenance({
    pluginId: CCC_CAMPAIGN_PROOF_ADMISSION_PLUGIN_ID,
    pluginVersion: CCC_CAMPAIGN_PROOF_ADMISSION_PLUGIN_VERSION,
    trustedRootPath: ENGINE_DIST_ROOT,
    entryRelativePath: "ccc-campaign-proof-admission.js",
    manifestRelativePath: "ccc-campaign-proof-admission.manifest.json",
  });
  const binding = getWorkflowExtensionHostProvenanceBinding(provenance);
  return rehashCccPrdImportTestBundle({
    ...bundle,
    proofs: bundle.proofs.map((proof) => {
      const definition = {
        ...proof,
        command: "task verify:ccc-local-acceptance",
        positiveOracle: "all diamond branches and joined terminal task complete",
        negativeControls: ["joined task has no dispatch until every branch completes"],
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

function configurePiBottomRuntime(input: {
  blockModelId?: string;
  entered?: (model: { provider?: string; id?: string }) => void;
}) {
  const modelCalls: Array<{ provider?: string; id?: string }> = [];
  const enteredModelIds = new Set<string>();
  const modelWaiters = new Map<string, () => void>();
  const localModels = [
    { provider: "local-pi-a", id: "pi-fixture-a", name: "pi-fixture-a", api: "openai-completions" },
    { provider: "local-pi-b", id: "pi-fixture-b", name: "pi-fixture-b", api: "openai-completions" },
    { provider: "local-pi-d", id: "pi-fixture-d", name: "pi-fixture-d", api: "openai-completions" },
  ];
  let releaseBlocked!: () => void;
  const blocked = new Promise<void>((resolve) => { releaseBlocked = resolve; });
  const bottomRuntime = {
    getAuth: vi.fn(async () => ({ auth: { headers: {} } })),
    getModel: vi.fn((provider: string, id: string) => localModels.find((model) => model.provider === provider && model.id === id)),
    getModels: vi.fn((provider?: string) => provider ? localModels.filter((model) => model.provider === provider) : localModels),
    getAvailableSnapshot: vi.fn(() => localModels),
    getError: vi.fn(() => undefined),
    hasConfiguredAuth: vi.fn(() => true),
    getCompatibilityRequestConfig: vi.fn(() => ({})),
    getProvider: vi.fn(() => undefined),
    getProviderAuthStatus: vi.fn(() => ({ status: "connected" })),
    registerProvider: vi.fn(),
    registerNativeProvider: vi.fn(),
    refresh: vi.fn(async () => ({ results: [] })),
    reloadConfig: vi.fn(async () => {}),
    stream: vi.fn((model: { provider?: string; id?: string }) => {
      const requestedModel = {
        provider: model.provider,
        id: model.id?.replace("__fusion_ccc_response_probe__", ""),
      };
      modelCalls.push(requestedModel);
      if (requestedModel.id) {
        enteredModelIds.add(requestedModel.id);
        modelWaiters.get(requestedModel.id)?.();
        modelWaiters.delete(requestedModel.id);
      }
      input.entered?.(requestedModel);
      const complete = async () => {
        if (requestedModel.id === input.blockModelId) await blocked;
        return { role: "assistant", content: [{ type: "text", text: APPROVE_OUTPUT }] };
      };
      const finalMessage = complete();
      return {
        result: vi.fn(() => finalMessage),
        async *[Symbol.asyncIterator]() {
          const message = await finalMessage;
          yield { type: "done", reason: "stop", message };
        },
      };
    }),
    streamSimple: vi.fn(),
    complete: vi.fn(async () => ({ role: "assistant", content: [] })),
    completeSimple: vi.fn(async () => ({ role: "assistant", content: [] })),
  };
  vi.spyOn(ModelRuntime, "create").mockImplementation(async () => ({ ...bottomRuntime }) as never);
  piHarness.createAgentSession.mockImplementation(async (options: Record<string, unknown>) => {
    const model = (options.model ?? { provider: "missing", id: "missing" }) as { provider?: string; id?: string };
    const subscribers = new Set<(event: unknown) => void>();
    const messages: Array<Record<string, unknown>> = [];
    const session = {
      model,
      messages,
      state: { messages },
      error: undefined,
      subscribe(callback: (event: unknown) => void) { subscribers.add(callback); return () => subscribers.delete(callback); },
      async prompt() {
        const runtime = options.modelRuntime as { stream: (model: unknown, context: unknown, streamOptions: unknown) => AsyncIterable<unknown> & { result: () => Promise<unknown> } };
        const source = runtime.stream(model, { messages: [] }, {});
        for await (const _event of source) { /* run the real wrapper through its terminal event */ }
        const message = await source.result();
        messages.push({ ...(message as Record<string, unknown>), responseModel: model.id });
        for (const subscriber of subscribers) {
          subscriber({
            type: "message_update",
            assistantMessageEvent: {
              type: "text_delta",
              contentIndex: 0,
              delta: APPROVE_OUTPUT,
              partial: APPROVE_OUTPUT,
            },
          });
        }
      },
      async dispose() {},
    };
    piHarness.sessions.push({ model, options });
    return { session };
  });
  return {
    bottomRuntime,
    modelCalls,
    releaseBlocked,
    waitForModel: (modelId: string) => enteredModelIds.has(modelId)
      ? Promise.resolve()
      : new Promise<void>((resolve) => modelWaiters.set(modelId, resolve)),
  };
}

function installLoopbackOnlyNetworkGuard() {
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    throw new Error("local acceptance forbids fetch outside the Pi bottom runtime");
  });
  const originalConnect = net.Socket.prototype.connect;
  const socketSpy = vi.spyOn(net.Socket.prototype, "connect").mockImplementation(function (this: net.Socket, ...args: unknown[]) {
    const first = args[0];
    const host = typeof first === "object" && first !== null && "host" in first
      ? String((first as { host?: string }).host)
      : typeof args[1] === "string" ? args[1] : undefined;
    if (host !== undefined && !["127.0.0.1", "::1", "localhost"].includes(host)) {
      throw new Error(`local acceptance blocked non-loopback socket ${host}`);
    }
    return originalConnect.apply(this, args as Parameters<typeof originalConnect>);
  });
  return { fetchSpy, socketSpy };
}

const pgTest = pgDescribe;

pgTest("Task 6 local CCC campaign acceptance (real PostgreSQL)", () => {
  const h = createSharedPgTaskStoreTestHarness({ prefix: "fusion_ccc_local_acceptance" });
  const registeredScopedExtensionIds = new Set<string>();

  beforeAll(h.beforeAll);
  beforeEach(() => {
    piHarness.sessions.length = 0;
    piHarness.createAgentSession.mockReset();
  });
  beforeEach(h.beforeEach);
  afterEach(() => {
    vi.restoreAllMocks();
    piHarness.createAgentSession.mockReset();
    for (const extensionId of registeredScopedExtensionIds) getWorkflowExtensionRegistry().unregister(extensionId);
    registeredScopedExtensionIds.clear();
  });
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  async function importCampaign(
    suffix: string,
    registerScoped?: (scenario: ReturnType<typeof createJoinedLocalCampaignScenario>) => unknown,
  ) {
    const rootDir = h.rootDir();
    const mainAtStart = initializeDisposableGitRoot(rootDir);
    const scenario = createJoinedLocalCampaignScenario(rootDir, suffix, mainAtStart);
    const scoped = registerScoped?.(scenario);
    await bootstrapCccCampaignProofAdmissionHost({ builtRootPath: ENGINE_DIST_ROOT });
    const imported = await importCccPrdBundle({
      bundle: await admitBundle(scenario.bundle),
      idempotencyKey: suffix,
      store: h.store(),
      layer: h.layer(),
      rootDir,
      executionPolicy: { schema: "ccc-campaign.execution-policy.v1", routes: scenario.routes },
    });
    const workflow = await h.store().getWorkflowDefinition(`${imported.importId}--WF-${suffix}`);
    const campaign = await h.store().getWorkflowWorkItem(`WORK-${suffix}`);
    if (!workflow || !campaign) throw new Error("imported local campaign is incomplete");
    const taskD = await h.store().getTask(scenario.taskIds.d);
    const branchD = resolveTaskWorkingBranch(taskD);
    mkdirSync(join(rootDir, "src"), { recursive: true });
    git(rootDir, ["update-ref", `refs/heads/${branchD}`, "main"]);
    writeFileSync(join(rootDir, "src", "campaign-landing.ts"), `export const campaign = ${JSON.stringify(suffix)};\n`);
    git(rootDir, ["add", "src/campaign-landing.ts"]);
    const sourceTree = git(rootDir, ["write-tree"]);
    const sourceCommit = git(rootDir, ["commit-tree", sourceTree, "-p", "main", "-m", "admitted campaign change"]);
    git(rootDir, ["update-ref", `refs/heads/${branchD}`, sourceCommit]);
    git(rootDir, ["read-tree", "--reset", "main"]);
    rmSync(join(rootDir, "src"), { recursive: true, force: true });
    git(rootDir, ["update-ref", "--no-deref", "HEAD", mainAtStart]);
    expect(git(rootDir, ["status", "--porcelain"])).toBe("");
    return { rootDir, mainAtStart, scenario, imported, workflow, campaign, branchD, scoped };
  }

  async function issueAndClaimAll(scenario: ReturnType<typeof createJoinedLocalCampaignScenario>, suffix: string) {
    const actor = { actorId: `local-${suffix}-worker`, actorType: "agent" as const, actorName: "Local acceptance worker" };
    const bindings = [
      [scenario.taskIds.a, scenario.actions.liveExecution.a],
      [scenario.taskIds.b, scenario.actions.liveExecution.b],
      [scenario.taskIds.c, scenario.actions.liveExecution.c],
      [scenario.taskIds.d, scenario.actions.liveExecution.d],
      [scenario.taskIds.d, scenario.actions.merge],
    ] as const;
    const approvals = new Map<string, { id: string; taskId: string; actionId: string }>();
    const issuedBindings: Array<{ taskId: string; action: (typeof bindings)[number][1]; key: string }> = [];
    for (const [taskId, action] of bindings) {
      const context = await h.store().getCccCampaignContextForTask(taskId);
      if (!context) throw new Error(`missing campaign context for ${taskId}`);
      const key = `${taskId}:${action.actionId}`;
      const issued = await issueCccCampaignApproval(h.layer(), {
        authorityStore: h.store(), rootDir: h.rootDir(), taskId, action, requester: actor,
        runId: `issue:${suffix}:${action.actionId}`, notBeforeAt: context.campaignStartedAt, expiresAt: context.campaignDeadlineAt,
      });
      issuedBindings.push({ taskId, action, key });
      approvals.set(key, { id: issued.id, taskId, actionId: action.actionId });
    }
    for (const { taskId, action, key } of issuedBindings) {
      await claimCccCampaignApproval(h.layer(), {
        authorityStore: h.store(), rootDir: h.rootDir(), taskId, action, claimant: actor,
        runId: `claim:${suffix}:${action.actionId}`, claimToken: `claim:${suffix}:${taskId}:${action.actionId}`,
      });
      expect(approvals.get(key)).toMatchObject({ taskId, actionId: action.actionId });
    }
    return approvals;
  }

  function installScopedProvider(scenario: ReturnType<typeof createJoinedLocalCampaignScenario>, mode: "complete" | "cancel") {
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    let settled!: () => void;
    const settledPromise = new Promise<void>((resolve) => { settled = resolve; });
    const scopes: Array<Record<string, unknown>> = [];
    const handler = vi.fn(async (input: WorkflowNodeHandlerInput) => {
      expect(input.task.id).toBe(scenario.taskIds.c);
      expect(input.providerController).toBeDefined();
      expect(input.providerDispatch).toMatchObject({
        providerId: "local-scoped-c",
        modelId: "workflow-fixture-c",
        transport: "workflow",
      });
      if (!input.providerController || !input.providerDispatch) throw new Error("scoped provider binding is missing");
      const permit = await input.providerController.preDispatch(input.providerDispatch);
      if (permit.kind !== "dispatch-permit") throw new Error("scoped local provider was not admitted");
      scopes.push(permit.scope);
      entered();
      if (mode === "cancel") {
        await waitForAbort(input.signal);
        await input.providerController.reconcile({
          ...permit.scope,
          outcome: "proved_failed",
          evidenceDigest: "c".repeat(64),
          observerId: "local-cancel-provider",
        });
        settled();
        return { outcome: "failure" as const, value: "local-provider-observed-abort" };
      }
      await input.providerController.reconcile({
        ...permit.scope,
        outcome: "committed",
        evidenceDigest: "f".repeat(64),
        observerId: "local-acceptance-provider",
      });
      settled();
      return { outcome: "success" as const, value: "local-scoped-committed" };
    });
    getWorkflowExtensionRegistry().register(scenario.scopedExtension.pluginId, {
      extensionId: scenario.scopedExtension.extensionId,
      name: "Local scoped provider",
      kind: "node-handler",
      nodeKind: "prompt",
      schemaVersion: WORKFLOW_EXTENSION_SCHEMA_VERSION,
      fallback: "failClosed",
      handle: handler,
    }, undefined, { providerPosture: "scoped-provider" });
    registeredScopedExtensionIds.add(scenario.scopedExtension.registryId);
    return { handler, scopes, entered: enteredPromise, settled: settledPromise, unregister: () => {
      getWorkflowExtensionRegistry().unregister(scenario.scopedExtension.registryId);
      registeredScopedExtensionIds.delete(scenario.scopedExtension.registryId);
    } };
  }

  it("completes an imported mixed-provider split/join campaign through real Pi admission, a scoped handler, and native Git landing", async () => {
    const fixture = await importCampaign("local-acceptance", (scenario) => installScopedProvider(scenario, "complete"));
    const { scenario, workflow, campaign, rootDir } = fixture;
    expect(workflow.ir.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "split" }),
      expect.objectContaining({ kind: "join" }),
      expect.objectContaining({ extensions: expect.objectContaining({ [scenario.scopedExtension.registryId]: {} }) }),
    ]));
    const approvals = await issueAndClaimAll(scenario, "local-acceptance");
    const scoped = fixture.scoped as ReturnType<typeof installScopedProvider>;
    const pi = configurePiBottomRuntime({ blockModelId: "pi-fixture-b" });
    const network = installLoopbackOnlyNetworkGuard();
    const forbidden = createForbiddenEffectRecorder();
    const executor = new TaskExecutor(h.store(), rootDir);
    executor.setMergeRequester(async (taskId, { signal } = {}) => {
      expect(taskId).toBe(scenario.taskIds.d);
      expect(signal).toBeInstanceOf(AbortSignal);
      return runAiMerge(h.store(), rootDir, taskId, { signal }, forbidden.deps);
    });
    const settings = await h.store().getSettings();
    const runtime = new WorkflowTaskRuntime({
      store: h.store(),
      primitives: executor.createAuthoritativeWorkflowPrimitives(settings),
      runCustomNode: executor.createAuthoritativeWorkflowCustomNodeRunner(settings),
      resolveNodeProviderController: executor.createCccCampaignWorkflowNodeProviderControllerResolver(),
    });
    const sourceRefD = `refs/heads/${fixture.branchD}`;
    const sourceCommitBeforeProcessing = git(rootDir, ["rev-parse", sourceRefD]);
    const expectedBaseObjectBeforeProcessing = git(rootDir, ["rev-parse", "refs/heads/main"]);
    expect(expectedBaseObjectBeforeProcessing).toBe(fixture.mainAtStart);
    const processing = processDueWorkflowWorkItem(h.store(), runtime, settings, {
      leaseOwner: "local-acceptance-processor", leaseDurationMs: 60_000, kinds: ["task"], campaignRequired: true,
      exactCandidate: { id: campaign.id, runId: campaign.runId, attempt: campaign.attempt },
    });
    const firstProgress = await Promise.race([
      scoped.entered.then(() => ({ kind: "scoped-entered" as const })),
      processing.then(async (result) => ({
        kind: "processing-completed" as const,
        result,
        workItem: await h.store().getWorkflowWorkItem(campaign.id),
      })),
    ]);
    if (firstProgress.kind === "processing-completed") {
      throw new Error(`campaign processing completed before scoped C entered: ${JSON.stringify(firstProgress)}`);
    }
    await scoped.settled;
    const branchBProgress = await Promise.race([
      pi.waitForModel("pi-fixture-b").then(() => ({ kind: "branch-b-dispatched" as const })),
      processing.then(async (result) => ({
        kind: "processing-completed-before-branch-b" as const,
        result,
        workItem: await h.store().getWorkflowWorkItem(campaign.id),
        piModelCalls: pi.modelCalls,
      })),
    ]);
    if (branchBProgress.kind === "processing-completed-before-branch-b") {
      throw new Error(`campaign processing completed before Pi branch B dispatched: ${JSON.stringify(branchBProgress)}`);
    }
    expect(pi.modelCalls).toEqual(expect.arrayContaining([
      { provider: "local-pi-a", id: "pi-fixture-a" },
      { provider: "local-pi-b", id: "pi-fixture-b" },
    ]));
    expect(pi.modelCalls.some(({ id }) => id === "pi-fixture-d")).toBe(false);
    expect(git(rootDir, ["rev-parse", "refs/heads/main"])).toBe(fixture.mainAtStart);
    pi.releaseBlocked();
    await expect(processing).resolves.toMatchObject({ runtime: { disposition: "completed", outcome: "success" } });
    expect(pi.modelCalls).toEqual(expect.arrayContaining([{ provider: "local-pi-d", id: "pi-fixture-d" }]));
    expect(scoped.handler).toHaveBeenCalledTimes(1);
    expect(scoped.scopes).toHaveLength(1);
    await expect(h.store().inspectCccProviderAttempt({ taskId: scenario.taskIds.c, attemptKey: scoped.scopes[0].attemptKey as string }))
      .resolves.toMatchObject({ state: "committed", terminal: { state: "committed" }, binding: expect.objectContaining({ providerId: "local-scoped-c", modelId: "workflow-fixture-c", transport: "workflow" }) });
    await expect(h.store().getWorkflowWorkItem(campaign.id)).resolves.toMatchObject({ state: "succeeded", attempt: 1 });
    const mainAfter = git(rootDir, ["rev-parse", "refs/heads/main"]);
    expect(mainAfter).not.toBe(fixture.mainAtStart);
    expect(git(rootDir, ["rev-parse", sourceRefD])).toBe(sourceCommitBeforeProcessing);
    expect(forbidden.effects).toEqual([]);
    for (const approval of approvals.values()) await expect(getApprovalRequest(h.layer().db, approval.id)).resolves.toMatchObject({ status: "consumed" });
    const landingEvents = (await queryRunAuditEvents(h.layer().db, { taskId: scenario.taskIds.d, domain: "git" }))
      .filter((event) => event.mutationType === "ccc-campaign-git-landing:intent" || event.mutationType === "ccc-campaign-git-landing:terminal")
      .sort((left, right) => left.mutationType.localeCompare(right.mutationType));
    expect(landingEvents.map((event) => event.mutationType)).toEqual(["ccc-campaign-git-landing:intent", "ccc-campaign-git-landing:terminal"]);
    const [intentEvent, terminalEvent] = landingEvents;
    if (!intentEvent || !terminalEvent) throw new Error("missing Git landing intent or terminal receipt");
    expect(intentEvent.metadata).toEqual(terminalEvent.metadata);
    expect(intentEvent).toMatchObject({
      target: scenario.actions.merge.actionTarget,
      campaign: { binding: expect.objectContaining({ actionId: scenario.actions.merge.actionId, actionTarget: scenario.actions.merge.actionTarget }) },
      metadata: expect.objectContaining({
        schema: "ccc-campaign.git-landing.intent.v1",
        sourceRef: sourceRefD,
        targetRef: "refs/heads/main",
        expectedBaseObject: expectedBaseObjectBeforeProcessing,
        sourceCommit: sourceCommitBeforeProcessing,
        commitObject: mainAfter,
      }),
    });
    const campaignContext = await h.store().getCccCampaignContextForTask(scenario.taskIds.d);
    expect(campaignContext).toMatchObject({
      taskId: scenario.taskIds.d,
      semanticTaskId: scenario.taskIds.d,
      protectedActionIds: expect.arrayContaining([scenario.actions.merge.actionId]),
    });
    expect(await h.store().getTaskDocument(scenario.taskIds.a, "PROMPT.md")).toMatchObject({ content: expect.any(String) });
    expect((await h.store().listArtifacts()).some((artifact) => artifact.taskId === scenario.taskIds.a)).toBe(true);
    const taskAProviderAttemptMutations = (await queryRunAuditEvents(h.layer().db, { taskId: scenario.taskIds.a }))
      .map((event) => event.mutationType)
      .filter((mutationType) => mutationType.startsWith("ccc-campaign:provider-attempt:"))
      .sort();
    expect(taskAProviderAttemptMutations).toEqual([
      "ccc-campaign:provider-attempt:dispatched",
      "ccc-campaign:provider-attempt:reserved",
      "ccc-campaign:provider-attempt:terminal",
    ]);
    expect(network.fetchSpy).not.toHaveBeenCalled();
    const nonLoopbackSockets = network.socketSpy.mock.calls.filter((args) => {
      const first = args[0];
      const host = typeof first === "object" && first !== null && "host" in first
        ? String((first as { host?: string }).host)
        : typeof args[1] === "string" ? args[1] : undefined;
      return host !== undefined && !["127.0.0.1", "::1", "localhost"].includes(host);
    });
    expect(nonLoopbackSockets).toEqual([]);
    scoped.unregister();
  });

  it("durably cancels an admitted scoped-provider branch through the real graph signal and never redispatches it after restart", async () => {
    const fixture = await importCampaign("local-cancel", (scenario) => installScopedProvider(scenario, "cancel"));
    const { scenario, campaign, rootDir } = fixture;
    const approvals = await issueAndClaimAll(scenario, "local-cancel");
    const scoped = fixture.scoped as ReturnType<typeof installScopedProvider>;
    const pi = configurePiBottomRuntime({});
    const network = installLoopbackOnlyNetworkGuard();
    await h.store().moveTask(scenario.taskIds.a, "in-progress", { moveSource: "scheduler" });
    const executor = new TaskExecutor(h.store(), rootDir);
    const settings = await h.store().getSettings();
    const runtime = new WorkflowTaskRuntime({
      store: h.store(),
      primitives: executor.createAuthoritativeWorkflowPrimitives(settings),
      runCustomNode: executor.createAuthoritativeWorkflowCustomNodeRunner(settings),
      resolveNodeProviderController: executor.createCccCampaignWorkflowNodeProviderControllerResolver(),
    });
    const processing = processDueWorkflowWorkItem(h.store(), runtime, settings, {
      leaseOwner: "local-cancel-processor", leaseDurationMs: 60_000, kinds: ["task"], campaignRequired: true,
      exactCandidate: { id: campaign.id, runId: campaign.runId, attempt: campaign.attempt },
    });
    const scopedEntry = await Promise.race([
      scoped.entered.then(() => ({ kind: "scoped-entered" as const })),
      processing.then((result) => ({ kind: "processing-completed" as const, result })),
      new Promise<{ kind: "timed-out" }>((resolve) => setTimeout(() => resolve({ kind: "timed-out" }), 12_000)),
    ]);
    if (scopedEntry.kind !== "scoped-entered") {
      throw new Error(`campaign cancellation did not enter scoped C: ${JSON.stringify({
        stage: scopedEntry.kind,
        processing: "result" in scopedEntry ? scopedEntry.result : undefined,
        piModelCalls: pi.modelCalls,
      })}`);
    }
    expect(pi.modelCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "pi-fixture-a" }),
    ]));
    const userCancellationMove = h.store().moveTask(scenario.taskIds.a, "todo", { moveSource: "user" });
    const cancellation = await Promise.race([
      processing.then((result) => ({ kind: "completed" as const, result })),
      new Promise<{ kind: "timed-out" }>((resolve) => setTimeout(() => resolve({ kind: "timed-out" }), 5_000)),
    ]);
    if (cancellation.kind === "timed-out") {
      throw new Error(`campaign cancellation timed out: ${JSON.stringify({
        workItem: await h.store().getWorkflowWorkItem(campaign.id),
        taskA: await h.store().getTask(scenario.taskIds.a),
        taskC: await h.store().getTask(scenario.taskIds.c),
        scopes: scoped.scopes,
      })}`);
    }
    expect(cancellation.result).toMatchObject({ claimed: true, runtime: { disposition: "cancelled", reason: "workflow-user-cancelled" } });
    await expect(userCancellationMove).resolves.toMatchObject({ column: "todo", userPaused: true });
    await expect(h.store().getWorkflowWorkItem(campaign.id)).resolves.toMatchObject({ state: "cancelled", attempt: 1, leaseOwner: null, leaseExpiresAt: null, lastError: "workflow-user-cancelled" });
    await expect(h.store().getTask(scenario.taskIds.a)).resolves.toMatchObject({ column: "todo", userPaused: true });
    expect(pi.modelCalls.some(({ id }) => id === "pi-fixture-d")).toBe(false);
    expect(network.fetchSpy).not.toHaveBeenCalled();
    const cancellationNonLoopbackSockets = network.socketSpy.mock.calls.filter((args) => {
      const first = args[0];
      const host = typeof first === "object" && first !== null && "host" in first
        ? String((first as { host?: string }).host)
        : typeof args[1] === "string" ? args[1] : undefined;
      return host !== undefined && !["127.0.0.1", "::1", "localhost"].includes(host);
    });
    expect(cancellationNonLoopbackSockets).toEqual([]);
    expect(git(rootDir, ["rev-parse", "refs/heads/main"])).toBe(fixture.mainAtStart);
    expect(scoped.scopes).toHaveLength(1);
    await expect(h.store().inspectCccProviderAttempt({ taskId: scenario.taskIds.c, attemptKey: scoped.scopes[0].attemptKey as string }))
      .resolves.toMatchObject({ state: "proved_failed", terminal: { state: "proved_failed" } });
    const scopedApproval = approvals.get(`${scenario.taskIds.c}:${scenario.actions.liveExecution.c.actionId}`);
    if (!scopedApproval) throw new Error("missing C approval");
    await expect(getApprovalRequest(h.layer().db, scopedApproval.id)).resolves.toMatchObject({ status: "claimed" });
    const { TaskStore: FreshTaskStore } = await import("@fusion/core");
    const restarted = new FreshTaskStore(rootDir, undefined, { asyncLayer: h.layer() });
    await restarted.init();
    try {
      const restartRuntime = { run: vi.fn() } as unknown as WorkflowTaskRuntime;
      await expect(processDueWorkflowWorkItem(restarted, restartRuntime, await restarted.getSettings(), {
        leaseOwner: "local-cancel-restart", leaseDurationMs: 60_000, kinds: ["task"],
        exactCandidate: { id: campaign.id, runId: campaign.runId, attempt: 1 },
      })).resolves.toMatchObject({ claimed: false });
      expect(restartRuntime.run).not.toHaveBeenCalled();
      await expect(restarted.listDueWorkflowWorkItems({ kinds: ["task"], states: ["runnable", "retrying"], limit: 20 }))
        .resolves.not.toEqual(expect.arrayContaining([expect.objectContaining({ id: campaign.id })]));
    } finally {
      restarted.stopWatching();
    }
    scoped.unregister();
  });
});
