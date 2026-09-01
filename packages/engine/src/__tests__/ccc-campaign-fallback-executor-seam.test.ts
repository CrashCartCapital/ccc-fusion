// @ts-nocheck
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
const { createCccCampaignProviderAttemptBindingMock } = vi.hoisted(() => ({
  createCccCampaignProviderAttemptBindingMock: vi.fn(),
}));
const {
  assertCccCampaignRejectedTurnCustodyMock,
  assertCccCampaignRequiredCommitCandidateMock,
  enforceCccCampaignRequiredCommitAfterNodeMock,
  fingerprintCccCampaignAllowedCandidateMock,
  fingerprintCccCampaignReadyCandidateMock,
  snapshotCccCampaignIgnoredBaselineMock,
  snapshotCccCampaignWriteEnvelopeMock,
  verifyCccCampaignReadyCandidateMock,
} = vi.hoisted(() => ({
  assertCccCampaignRejectedTurnCustodyMock: vi.fn(),
  assertCccCampaignRequiredCommitCandidateMock: vi.fn(),
  enforceCccCampaignRequiredCommitAfterNodeMock: vi.fn(),
  fingerprintCccCampaignAllowedCandidateMock: vi.fn(),
  fingerprintCccCampaignReadyCandidateMock: vi.fn(),
  snapshotCccCampaignIgnoredBaselineMock: vi.fn(),
  snapshotCccCampaignWriteEnvelopeMock: vi.fn(),
  verifyCccCampaignReadyCandidateMock: vi.fn(),
}));
const { requireCccCampaignLiveExecutionApprovalMock } = vi.hoisted(() => ({
  requireCccCampaignLiveExecutionApprovalMock: vi.fn(),
}));
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import {
  createMockStore,
  mockedCreateFnAgent,
  mockedExec,
  mockedExistsSync,
  resetExecutorMocks,
} from "./executor-test-helpers.js";

vi.mock("../ccc-campaign-provider-controller.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../ccc-campaign-provider-controller.js")>(),
  createCccCampaignProviderAttemptBinding: createCccCampaignProviderAttemptBindingMock,
}));
vi.mock("../ccc-campaign-required-commit.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../ccc-campaign-required-commit.js")>(),
  assertCccCampaignRejectedTurnCustody: assertCccCampaignRejectedTurnCustodyMock,
  assertCccCampaignRequiredCommitCandidate: assertCccCampaignRequiredCommitCandidateMock,
  enforceCccCampaignRequiredCommitAfterNode: enforceCccCampaignRequiredCommitAfterNodeMock,
}));
vi.mock("../ccc-campaign-product-control.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../ccc-campaign-product-control.js")>(),
  requireCccCampaignLiveExecutionApproval: requireCccCampaignLiveExecutionApprovalMock,
}));
vi.mock("../ccc-campaign-ready.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../ccc-campaign-ready.js")>(),
  fingerprintCccCampaignAllowedCandidate: fingerprintCccCampaignAllowedCandidateMock,
  fingerprintCccCampaignReadyCandidate: fingerprintCccCampaignReadyCandidateMock,
  snapshotCccCampaignIgnoredBaseline: snapshotCccCampaignIgnoredBaselineMock,
  snapshotCccCampaignWriteEnvelope: snapshotCccCampaignWriteEnvelopeMock,
  verifyCccCampaignReadyCandidate: verifyCccCampaignReadyCandidateMock,
}));

/*
FNXC:CCCCampaignFallback 2026-08-01-17:10:
The executor is the seam that decides which models a workflow-step session is
even allowed to consider. A sealed CCC campaign attempt binds one provider/model
route, so the executor's settings-derived fallback pair must never reach that
session; offering it is what let pi swap identities inside a sealed turn. The
ordinary (unfenced) workflow step keeps its fallback pair unchanged.
*/

const now = "2026-08-01T00:00:00.000Z";
const TURN_KEY = "ccc-provider-turn-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function readyVerification(
  candidateFingerprint = "f".repeat(64),
  verifiedWorktreePath = "/tmp/ccc-campaign",
) {
  return {
    ready: true,
    summary: "sealed verifier passed",
    taskId: "FN-CCC-FALLBACK",
    verifiedWorktreePath,
    verifiedStartCommit: "a".repeat(40),
    frozenBaseCommit: "a".repeat(40),
    allowedRoots: ["src", "test"],
    candidateFingerprint,
  };
}

function task(overrides: Record<string, unknown> = {}) {
  return {
    id: "FN-CCC-FALLBACK",
    title: "Campaign workflow step",
    description: "sealed campaign step",
    column: "in-progress",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    prompt: "# Task\n## Steps\n### Step 1\n- [ ] do it",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeExecutorForTask(liveTask = task()) {
  const store = createMockStore();
  store.getTask.mockImplementation(async (id: string) => ({ ...liveTask, id }));
  store.readTaskForMove = vi.fn(async (id: string) => store.getTask(id));
  store.getSettings.mockResolvedValue({
    autoMerge: false,
    experimentalFeatures: { workflowGraphExecutor: true },
    // Settings-derived executor fallback pair: the exact material a sealed
    // campaign attempt must not inherit.
    executorFallbackProvider: "anthropic",
    executorFallbackModel: "claude-sonnet-4-6",
  });
  return { store, executor: new TaskExecutor(store, "/tmp/test") };
}

function workflowStep() {
  return {
    id: "provider-model",
    name: "Provider model",
    mode: "prompt",
    phase: "pre-merge",
    gateMode: "advisory",
    prompt: "Do the bounded work.",
    toolMode: "readonly",
    enabled: true,
  };
}

function sealedExecution(nodeTask: ReturnType<typeof task>) {
  return Object.freeze({
    originTaskId: nodeTask.id,
    semanticTaskId: "FN-CCC-FALLBACK-semantic",
    nativeTaskId: nodeTask.id,
    semanticTask: task({ id: "FN-CCC-FALLBACK-semantic" }),
    runId: "FN-CCC-FALLBACK-run",
    visitIdentity: Object.freeze({ nodeId: "provider-node", materializedNodeId: "provider-node" }),
    executionFence: Object.freeze({
      workItemId: "wi-provider-binding",
      leaseOwner: "pi-provider-worker",
      attempt: 1,
      runId: "FN-CCC-FALLBACK-run",
    }),
    providerAttemptTurnKey: TURN_KEY,
  });
}

function campaignModelNode(
  execution: ReturnType<typeof sealedExecution>,
  overrides: Record<string, unknown> = {},
) {
  return {
    id: "ccc-task-implementation",
    kind: "prompt",
    config: {
      name: "Implement the admitted task",
      prompt: "Create src/slugify.js and test/slugify.test.js inside the admitted roots.",
      cccPrdTaskId: execution.semanticTaskId,
      cccNativeTaskId: execution.nativeTaskId,
      cccExecutionPromptSchema: "ccc-prd.execution-prompt.v1",
      cccExecutionPromptSha256: "a".repeat(64),
      cccExecutionTransport: "pi",
      cccExecutionProviderId: "provider-approved",
      cccExecutionModelId: "model-approved",
      cccExecutionRouteSha256: "b".repeat(64),
      executor: "model",
      toolMode: "coding",
      worktreeMode: "isolated",
      ownedPaths: ["src/slugify.js", "test/slugify.test.js"],
      allowedWriteRoots: ["src", "test"],
      commitPolicy: "required",
      gateMode: "gate",
      ...overrides,
    },
  };
}

function installOutputSession(
  output: string,
  userPrompts: string[] = [],
  signalPhaseCompletion = true,
) {
  mockedCreateFnAgent.mockImplementation(async (options: any) => {
    const subscribers = new Set<(event: any) => void>();
    const phaseTool = options.customTools?.find(
      (tool: { name: string }) => tool.name === "fn_complete_phase",
    );
    return {
      session: {
        subscribe: vi.fn((subscriber: (event: any) => void) => {
          subscribers.add(subscriber);
          return () => subscribers.delete(subscriber);
        }),
        prompt: vi.fn(async (prompt: string) => {
          userPrompts.push(prompt);
          for (const subscriber of subscribers) {
            subscriber({
              type: "message_update",
              assistantMessageEvent: {
                type: "text_delta",
                contentIndex: 0,
                delta: output,
                partial: output,
              },
            });
          }
          if (phaseTool && signalPhaseCompletion) {
            await phaseTool.execute("complete-phase", {}, undefined, () => undefined);
          }
        }),
        dispose: vi.fn(),
      },
    };
  });
  return userPrompts;
}

function makeCampaignNodeHarness(
  output: string,
  worktree: string,
  options: { signalPhaseCompletion?: boolean } = {},
) {
  const nodeTask = task({
    executionMode: "standard",
    worktree,
    modelProvider: "openai",
    modelId: "gpt-4o",
  });
  const { store, executor } = makeExecutorForTask(nodeTask);
  store.getAsyncLayer = vi.fn(() => ({}) as any);
  const binding = Object.freeze({
    turnKey: TURN_KEY,
    controller: Object.freeze({ preDispatch: vi.fn(), reconcile: vi.fn() }),
  });
  createCccCampaignProviderAttemptBindingMock.mockResolvedValue(binding);
  const userPrompts = installOutputSession(
    output,
    [],
    options.signalPhaseCompletion ?? true,
  );
  mockedExec.mockImplementation(((command: string, _options: unknown, callback: any) => {
    if (command === "git status --porcelain=v1 --untracked-files=all") {
      callback(null, " M src/slugify.js\n", "");
      return {} as any;
    }
    callback(null, "", "");
    return {} as any;
  }) as any);
  const execution = sealedExecution(nodeTask);
  store.getCccCampaignContextForTask = vi.fn().mockResolvedValue({
    semanticTaskId: execution.semanticTaskId,
    proofIds: ["PROOF-READY"],
    targetRepository: { path: worktree, baseCommit: "a".repeat(40) },
    bounds: { maxRequests: 4, maxDurationMs: 120_000, maxConcurrency: 1 },
    requestCount: 0,
    executionPolicy: {
      schema: "ccc-campaign.execution-policy.v2",
      routes: [{
        taskId: execution.semanticTaskId,
        providerId: "provider-approved",
        modelId: "model-approved",
        transport: "pi",
      }],
    },
    route: {
      taskId: execution.semanticTaskId,
      providerId: "provider-approved",
      modelId: "model-approved",
      transport: "pi",
      executor: "model",
      toolMode: "coding",
      worktreeMode: "isolated",
      ownedPaths: ["src/slugify.js", "test/slugify.test.js"],
      allowedWriteRoots: ["src", "test"],
      commitPolicy: "required",
    },
    proofs: [{
      id: "PROOF-READY",
      requirementIds: ["REQ-READY"],
      command: "task verify:ready",
      positiveOracle: "ready",
      negativeControls: [],
      spans: [],
      confidence: "high",
    }],
  });
  return { binding, execution, executor, nodeTask, store, userPrompts };
}

describe("CCC campaign workflow steps never inherit the executor fallback pair", () => {
  beforeEach(() => {
    resetExecutorMocks();
    mockedExistsSync.mockReturnValue(true);
    createCccCampaignProviderAttemptBindingMock.mockReset();
    assertCccCampaignRejectedTurnCustodyMock.mockReset();
    assertCccCampaignRejectedTurnCustodyMock.mockResolvedValue(undefined);
    assertCccCampaignRequiredCommitCandidateMock.mockReset();
    assertCccCampaignRequiredCommitCandidateMock.mockResolvedValue(undefined);
    enforceCccCampaignRequiredCommitAfterNodeMock.mockReset();
    enforceCccCampaignRequiredCommitAfterNodeMock.mockResolvedValue(undefined);
    requireCccCampaignLiveExecutionApprovalMock.mockReset();
    requireCccCampaignLiveExecutionApprovalMock.mockResolvedValue(undefined);
    fingerprintCccCampaignReadyCandidateMock.mockReset();
    fingerprintCccCampaignReadyCandidateMock
      .mockResolvedValueOnce("a".repeat(64))
      .mockResolvedValue("b".repeat(64));
    fingerprintCccCampaignAllowedCandidateMock.mockReset();
    fingerprintCccCampaignAllowedCandidateMock
      .mockResolvedValueOnce("a".repeat(64))
      .mockResolvedValue("b".repeat(64));
    snapshotCccCampaignIgnoredBaselineMock.mockReset();
    snapshotCccCampaignIgnoredBaselineMock.mockResolvedValue(Object.freeze({
      roots: Object.freeze([]),
      fingerprint: "0".repeat(64),
    }));
    snapshotCccCampaignWriteEnvelopeMock.mockReset();
    snapshotCccCampaignWriteEnvelopeMock.mockResolvedValue({
      changedPaths: ["src/slugify.js"],
      foreignPaths: [],
      allowedRoots: ["src", "test"],
    });
    verifyCccCampaignReadyCandidateMock.mockReset();
    verifyCccCampaignReadyCandidateMock.mockResolvedValue(readyVerification());
    mockedCreateFnAgent.mockResolvedValue({
      session: {
        subscribe: vi.fn(() => vi.fn()),
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("omits fallbackProvider and fallbackModelId from a sealed campaign session", async () => {
    const nodeTask = task({
      executionMode: "fast",
      worktree: "/tmp/ccc-provider-binding",
      modelProvider: "openai",
      modelId: "gpt-4o",
    });
    const { store, executor } = makeExecutorForTask(nodeTask);
    store.getAsyncLayer = vi.fn(() => ({}) as any);
    const binding = Object.freeze({
      turnKey: TURN_KEY,
      controller: Object.freeze({ preDispatch: vi.fn(), reconcile: vi.fn() }),
    });
    createCccCampaignProviderAttemptBindingMock.mockResolvedValueOnce(binding);

    await (executor as any).executeWorkflowStep(
      nodeTask,
      workflowStep(),
      "/tmp/ccc-provider-binding",
      { executionProvider: "openai", executionModelId: "gpt-4o" },
      undefined,
      { execution: sealedExecution(nodeTask) },
    );

    const sealedCall = mockedCreateFnAgent.mock.calls.find(
      ([options]: any[]) => options?.cccProviderAttemptBinding === binding,
    )?.[0] as Record<string, unknown>;
    expect(sealedCall).toBeDefined();
    expect(sealedCall.profile).toBe("ccc-fusion");
    expect(sealedCall).not.toHaveProperty("fallbackProvider");
    expect(sealedCall).not.toHaveProperty("fallbackModelId");
  });

  it("does not retry a fenced campaign step with the executor fallback route", async () => {
    const nodeTask = task({
      executionMode: "standard",
      worktree: "/tmp/ccc-provider-no-outer-fallback",
      modelProvider: "openai",
      modelId: "gpt-4o",
    });
    const { store, executor } = makeExecutorForTask(nodeTask);
    store.getAsyncLayer = vi.fn(() => ({}) as any);
    const binding = Object.freeze({
      turnKey: TURN_KEY,
      controller: Object.freeze({ preDispatch: vi.fn(), reconcile: vi.fn() }),
    });
    createCccCampaignProviderAttemptBindingMock.mockResolvedValue(binding);
    installOutputSession("unstructured campaign output");

    const result = await (executor as any).executeWorkflowStep(
      nodeTask,
      workflowStep(),
      "/tmp/ccc-provider-no-outer-fallback",
      {
        executionProvider: "openai",
        executionModelId: "gpt-4o",
        executorFallbackProvider: "anthropic",
        executorFallbackModel: "claude-sonnet-4-6",
      },
      undefined,
      { execution: sealedExecution(nodeTask) },
    );

    expect(result).toMatchObject({
      success: false,
      malformed: true,
      error: "malformed output — no verdict extracted",
    });
    expect(createCccCampaignProviderAttemptBindingMock).toHaveBeenCalledTimes(1);
    expect(mockedCreateFnAgent).toHaveBeenCalledTimes(1);
  });

  it("fails one fenced campaign session on timeout without fallback or self-retry", async () => {
    vi.useFakeTimers();
    const nodeTask = task({
      executionMode: "standard",
      worktree: "/tmp/ccc-provider-timeout",
      modelProvider: "openai",
      modelId: "gpt-4o",
    });
    const { store, executor } = makeExecutorForTask(nodeTask);
    store.getAsyncLayer = vi.fn(() => ({}) as any);
    const binding = Object.freeze({
      turnKey: TURN_KEY,
      controller: Object.freeze({ preDispatch: vi.fn(), reconcile: vi.fn() }),
    });
    createCccCampaignProviderAttemptBindingMock.mockResolvedValue(binding);
    let markPromptEntered!: () => void;
    const promptEntered = new Promise<void>((resolve) => { markPromptEntered = resolve; });
    mockedCreateFnAgent.mockResolvedValue({
      session: {
        subscribe: vi.fn(() => vi.fn()),
        prompt: vi.fn(async () => {
          markPromptEntered();
          await new Promise<void>(() => {});
        }),
        dispose: vi.fn(),
      },
    });

    const execution = (executor as any).executeWorkflowStep(
      nodeTask,
      workflowStep(),
      "/tmp/ccc-provider-timeout",
      {
        executionProvider: "openai",
        executionModelId: "gpt-4o",
        executorFallbackProvider: "anthropic",
        executorFallbackModel: "claude-sonnet-4-6",
        workflowStepTimeoutMs: 60_000,
      },
      undefined,
      { execution: sealedExecution(nodeTask) },
    );
    await promptEntered;
    await vi.advanceTimersByTimeAsync(60_000);

    await expect(execution).resolves.toMatchObject({
      success: false,
      timedOut: true,
      error: "workflow step timed out after 60000ms",
    });
    expect(createCccCampaignProviderAttemptBindingMock).toHaveBeenCalledTimes(1);
    expect(mockedCreateFnAgent).toHaveBeenCalledTimes(1);
  });

  it("campaign implementation timeout is funded by persisted campaign maxDurationMs", async () => {
    vi.useFakeTimers();
    const { execution, executor, nodeTask, store } = makeCampaignNodeHarness(
      "",
      "/tmp/ccc-campaign-duration-funded-timeout",
    );
    let markPromptEntered!: () => void;
    const promptEntered = new Promise<void>((resolve) => { markPromptEntered = resolve; });
    mockedCreateFnAgent.mockResolvedValue({
      session: {
        subscribe: vi.fn(() => vi.fn()),
        prompt: vi.fn(async () => {
          markPromptEntered();
          await new Promise<void>(() => {});
        }),
        dispose: vi.fn(),
      },
    });
    const abort = new AbortController();
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const running = (executor as any).executeWorkflowStep(
      nodeTask,
      { ...workflowStep(), toolMode: "coding" },
      "/tmp/ccc-campaign-duration-funded-timeout",
      await store.getSettings(),
      undefined,
      {
        execution,
        cccCampaignImplementation: true,
        signal: abort.signal,
      },
    );
    await promptEntered;

    try {
      expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 120_000);
    } finally {
      abort.abort();
      await expect(running).resolves.toMatchObject({
        success: false,
        error: "workflow step cancelled",
      });
    }
  });

  it.each([
    "ccc-prd.execution-prompt.v1",
    "ccc-prd.execution-prompt.v2",
  ])("TSK-001 runs an exact fenced CCC Pi coding node with %s as implementation without a reviewer verdict", async (promptSchema) => {
    const { binding, execution, executor, nodeTask, store, userPrompts } = makeCampaignNodeHarness(
      "Files written and targeted verification passed.",
      "/tmp/ccc-campaign-implementation",
    );
    const node = campaignModelNode(execution, { cccExecutionPromptSchema: promptSchema });

    const result = await (executor as any).runGraphCustomNode(
      node,
      nodeTask,
      await store.getSettings(),
      undefined,
      undefined,
      { task: nodeTask, settings: undefined, context: {}, execution },
    );

    expect(result).toMatchObject({
      outcome: "success",
      value: "passed",
      contextPatch: { output: "Files written and targeted verification passed." },
    });
    expect(userPrompts).toHaveLength(1);
    expect(userPrompts[0]).toContain("Implement the sealed campaign task");
    expect(userPrompts[0]).not.toContain("Review the work done in this worktree");

    const sessionCall = mockedCreateFnAgent.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sessionCall.systemPrompt).toContain("You are a campaign implementation agent");
    expect(sessionCall.systemPrompt).not.toContain("Diff Scope (files changed by THIS task vs base)");
    expect(sessionCall.systemPrompt).not.toContain("When your review is complete");
    expect(sessionCall.tools).toBe("coding");
    expect(sessionCall.cccProviderAttemptBinding).toBe(binding);
    expect(sessionCall).not.toHaveProperty("fallbackProvider");
    expect(sessionCall).not.toHaveProperty("fallbackModelId");
  });

  it("exposes one phase-completion intent tool only to a required-commit campaign", async () => {
    const { execution, executor, nodeTask, store } = makeCampaignNodeHarness(
      "Files written and targeted verification passed.",
      "/tmp/ccc-campaign-ready-tool",
    );

    await (executor as any).runGraphCustomNode(
      campaignModelNode(execution),
      nodeTask,
      await store.getSettings(),
      undefined,
      undefined,
      { task: nodeTask, settings: undefined, context: {}, execution },
    );

    const sessionCall = mockedCreateFnAgent.mock.calls[0]?.[0] as Record<string, any>;
    expect(sessionCall.customTools?.map((tool: { name: string }) => tool.name)).toContain(
      "fn_complete_phase",
    );
    expect(sessionCall.customTools?.map((tool: { name: string }) => tool.name)).not.toContain(
      "fn_campaign_ready",
    );
    expect(String(sessionCall.systemPrompt)).toMatch(/call fn_complete_phase by itself/i);
  });

  it("verify_is_engine_driven: verifies only after the phase-signal turn settles", async () => {
    const { execution, executor, nodeTask, store } = makeCampaignNodeHarness(
      "",
      "/tmp/ccc-campaign-engine-verify",
    );
    const order: string[] = [];
    const trustedIgnoredBaseline = Object.freeze({
      roots: Object.freeze(["node_modules"]),
      fingerprint: "c".repeat(64),
    });
    (executor as any).cccControllerIgnoredBaselines.set(
      nodeTask.id,
      trustedIgnoredBaseline,
    );
    snapshotCccCampaignIgnoredBaselineMock.mockResolvedValue(trustedIgnoredBaseline);
    assertCccCampaignRequiredCommitCandidateMock.mockImplementation(async () => {
      order.push("assert-candidate");
    });
    verifyCccCampaignReadyCandidateMock.mockImplementation(async () => {
      order.push("verify-candidate");
      return readyVerification("f".repeat(64), "/tmp/ccc-campaign-engine-verify");
    });
    mockedCreateFnAgent.mockImplementation(async (options: any) => {
      const phaseTool = options.customTools.find(
        (tool: { name: string }) => tool.name === "fn_complete_phase",
      );
      return {
        session: {
          subscribe: vi.fn(() => vi.fn()),
          prompt: vi.fn(async () => {
            order.push("prompt-active");
            await phaseTool.execute("complete-phase", {}, undefined, () => undefined);
            order.push("prompt-settled");
          }),
          dispose: vi.fn(),
        },
      };
    });

    await (executor as any).runGraphCustomNode(
      campaignModelNode(execution),
      nodeTask,
      await store.getSettings(),
      undefined,
      undefined,
      { task: nodeTask, settings: undefined, context: {}, execution },
    );

    expect(order).toEqual([
      "prompt-active",
      "prompt-settled",
      "assert-candidate",
      "verify-candidate",
    ]);
    expect(assertCccCampaignRequiredCommitCandidateMock).toHaveBeenCalledTimes(1);
    expect(verifyCccCampaignReadyCandidateMock).toHaveBeenCalledTimes(1);
    expect(snapshotCccCampaignWriteEnvelopeMock).toHaveBeenCalledWith({
      worktreePath: "/tmp/ccc-campaign-engine-verify",
      allowedRoots: ["src", "test"],
      trustedIgnoredBaseline,
    });
    expect(verifyCccCampaignReadyCandidateMock).toHaveBeenCalledWith(expect.objectContaining({
      trustedIgnoredBaseline,
    }));
  });

  it("RED-G2-PHASE-DIAGNOSTIC: persists the exact controller verification failure before graph collapse", async () => {
    const { execution, executor, nodeTask, store } = makeCampaignNodeHarness(
      "",
      "/tmp/ccc-campaign-phase-diagnostic",
    );
    verifyCccCampaignReadyCandidateMock.mockRejectedValueOnce(
      new Error("semantic sandbox startup failed: exact fixture cause"),
    );
    mockedCreateFnAgent.mockImplementation(async (options: any) => {
      const phaseTool = options.customTools.find(
        (tool: { name: string }) => tool.name === "fn_complete_phase",
      );
      return {
        session: {
          subscribe: vi.fn(() => vi.fn()),
          prompt: vi.fn(async () => {
            await phaseTool.execute("complete-phase", {}, undefined, () => undefined);
          }),
          dispose: vi.fn(),
        },
      };
    });

    const result = await (executor as any).runGraphCustomNode(
      campaignModelNode(execution),
      nodeTask,
      await store.getSettings(),
      undefined,
      undefined,
      { task: nodeTask, settings: undefined, context: {}, execution },
    );

    expect(result).toMatchObject({
      outcome: "failure",
      value: expect.stringContaining(
        "semantic sandbox startup failed: exact fixture cause",
      ),
      contextPatch: {
        "node:ccc-task-implementation:error": expect.stringContaining(
          "semantic sandbox startup failed: exact fixture cause",
        ),
      },
    });
    expect(store.logEntry).toHaveBeenCalledWith(
      nodeTask.id,
      expect.stringContaining(
        "[ccc-campaign:phase-verification-failed] Controller verification could not prove phase completion: semantic sandbox startup failed: exact fixture cause",
      ),
    );
  });

  it("clears a trusted ignored baseline when the fenced campaign node throws", async () => {
    const { execution, executor, nodeTask, store } = makeCampaignNodeHarness(
      "",
      "/tmp/ccc-campaign-thrown-baseline",
    );
    (executor as any).cccControllerIgnoredBaselines.set(nodeTask.id, Object.freeze({
      roots: Object.freeze(["node_modules"]),
      fingerprint: "c".repeat(64),
    }));
    vi.spyOn(executor as any, "runGraphCustomNode").mockRejectedValueOnce(
      new Error("provider dispatch failed"),
    );

    await expect((executor as any).runGraphCustomNodeWithRequiredCommitFence(
      campaignModelNode(execution),
      nodeTask,
      await store.getSettings(),
      undefined,
      undefined,
      { task: nodeTask, settings: undefined, context: {}, execution },
    )).rejects.toThrow(/turn rejected before commit custody/i);

    expect((executor as any).cccControllerIgnoredBaselines.has(nodeTask.id)).toBe(false);
  });

  it("clears a trusted ignored baseline when required-commit enforcement throws", async () => {
    const { execution, executor, nodeTask, store } = makeCampaignNodeHarness(
      "",
      "/tmp/ccc-campaign-enforcement-baseline",
    );
    (executor as any).cccControllerIgnoredBaselines.set(nodeTask.id, Object.freeze({
      roots: Object.freeze(["node_modules"]),
      fingerprint: "c".repeat(64),
    }));
    vi.spyOn(executor as any, "runGraphCustomNode").mockResolvedValueOnce({
      outcome: "success",
      value: "campaign implementation complete",
    });
    enforceCccCampaignRequiredCommitAfterNodeMock.mockRejectedValueOnce(
      new Error("required commit enforcement failed"),
    );

    let refusal: unknown;
    try {
      await (executor as any).runGraphCustomNodeWithRequiredCommitFence(
        campaignModelNode(execution),
        nodeTask,
        await store.getSettings(),
        undefined,
        undefined,
        { task: nodeTask, settings: undefined, context: {}, execution },
      );
    } catch (error) {
      refusal = error;
    }

    expect(refusal).toMatchObject({
      code: "CCC_CAMPAIGN_REQUIRED_COMMIT_REFUSED",
      cause: expect.objectContaining({ message: "required commit enforcement failed" }),
    });
    expect(store.logEntry).toHaveBeenCalledWith(
      nodeTask.id,
      expect.stringContaining(
        "[ccc-campaign:required-commit-refused] required commit enforcement failed",
      ),
    );

    expect((executor as any).cccControllerIgnoredBaselines.has(nodeTask.id)).toBe(false);
  });

  it("clears a trusted ignored baseline when live execution approval throws", async () => {
    const { execution, executor, nodeTask, store } = makeCampaignNodeHarness(
      "",
      "/tmp/ccc-campaign-approval-baseline",
    );
    (executor as any).cccControllerIgnoredBaselines.set(nodeTask.id, Object.freeze({
      roots: Object.freeze(["node_modules"]),
      fingerprint: "c".repeat(64),
    }));
    requireCccCampaignLiveExecutionApprovalMock.mockRejectedValueOnce(
      new Error("live execution approval failed"),
    );

    await expect((executor as any).runGraphCustomNodeWithRequiredCommitFence(
      campaignModelNode(execution),
      nodeTask,
      await store.getSettings(),
      undefined,
      undefined,
      { task: nodeTask, settings: undefined, context: {}, execution },
    )).rejects.toThrow(/live execution approval failed/i);

    expect((executor as any).cccControllerIgnoredBaselines.has(nodeTask.id)).toBe(false);
    expect(mockedCreateFnAgent).not.toHaveBeenCalled();
  });

  it("hands the exact phase-verification fingerprint to post-node commit custody", async () => {
    const { execution, executor, nodeTask, store } = makeCampaignNodeHarness(
      "",
      "/tmp/ccc-campaign-fingerprint-handoff",
    );
    const candidateFingerprint = "d".repeat(64);
    verifyCccCampaignReadyCandidateMock.mockResolvedValue(
      readyVerification(candidateFingerprint, "/tmp/ccc-campaign-fingerprint-handoff"),
    );
    mockedCreateFnAgent.mockImplementation(async (options: any) => {
      const phaseTool = options.customTools.find(
        (tool: { name: string }) => tool.name === "fn_complete_phase",
      );
      return {
        session: {
          subscribe: vi.fn(() => vi.fn()),
          prompt: vi.fn(async () => {
            await phaseTool.execute("complete-phase", {}, undefined, () => undefined);
          }),
          dispose: vi.fn(),
        },
      };
    });

    await executor.createAuthoritativeWorkflowCustomNodeRunner(
      await store.getSettings(),
    )(
      campaignModelNode(execution),
      nodeTask,
      {},
      { task: nodeTask, settings: undefined, context: {}, execution },
    );

    expect(verifyCccCampaignReadyCandidateMock).toHaveBeenCalledTimes(1);
    expect(enforceCccCampaignRequiredCommitAfterNodeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        verifiedCandidateHandoff: expect.objectContaining({
          taskId: nodeTask.id,
          candidateFingerprint,
          executionFence: execution.executionFence,
        }),
      }),
    );
  });

  it("verify_is_engine_driven: fails closed when settled controller verification fails", async () => {
    const { execution, executor, nodeTask, store } = makeCampaignNodeHarness(
      "",
      "/tmp/ccc-campaign-engine-verify-failure",
    );
    verifyCccCampaignReadyCandidateMock.mockResolvedValue({
      ready: false,
      summary: "sealed verifier exit 1: AC-002 failed",
    });
    mockedCreateFnAgent.mockImplementation(async (options: any) => {
      const phaseTool = options.customTools.find(
        (tool: { name: string }) => tool.name === "fn_complete_phase",
      );
      return {
        session: {
          subscribe: vi.fn(() => vi.fn()),
          prompt: vi.fn(async () => {
            await phaseTool.execute("complete-phase", {}, undefined, () => undefined);
          }),
          dispose: vi.fn(),
        },
      };
    });

    const result = await (executor as any).runGraphCustomNode(
      campaignModelNode(execution),
      nodeTask,
      await store.getSettings(),
      undefined,
      undefined,
      { task: nodeTask, settings: undefined, context: {}, execution },
    );

    expect(result).toMatchObject({
      outcome: "failure",
      value: expect.stringContaining("AC-002 failed"),
      contextPatch: {
        "node:ccc-task-implementation:error": expect.stringContaining("AC-002 failed"),
      },
    });
  });

  it("runs exactly one same-session REPAIR turn after verification failure", async () => {
    const { execution, executor, nodeTask, store } = makeCampaignNodeHarness(
      "",
      "/tmp/ccc-campaign-repair-once",
    );
    fingerprintCccCampaignReadyCandidateMock.mockReset();
    fingerprintCccCampaignReadyCandidateMock
      .mockResolvedValueOnce("a".repeat(64))
      .mockResolvedValueOnce("b".repeat(64))
      .mockResolvedValueOnce("b".repeat(64))
      .mockResolvedValue("c".repeat(64));
    fingerprintCccCampaignAllowedCandidateMock.mockReset();
    fingerprintCccCampaignAllowedCandidateMock
      .mockResolvedValueOnce("a".repeat(64))
      .mockResolvedValueOnce("b".repeat(64))
      .mockResolvedValueOnce("b".repeat(64))
      .mockResolvedValue("c".repeat(64));
    verifyCccCampaignReadyCandidateMock
      .mockResolvedValueOnce({
        ready: false,
        summary: "sealed verifier exit 1: AC-002 failed",
      })
      .mockResolvedValueOnce(
        readyVerification("c".repeat(64), "/tmp/ccc-campaign-repair-once"),
      );
    const prompts: string[] = [];
    let promptCount = 0;
    mockedCreateFnAgent.mockImplementation(async (options: any) => {
      const subscribers = new Set<(event: any) => void>();
      const phaseTool = options.customTools.find(
        (tool: { name: string }) => tool.name === "fn_complete_phase",
      );
      return {
        session: {
          subscribe: vi.fn((subscriber: (event: any) => void) => {
            subscribers.add(subscriber);
            return () => subscribers.delete(subscriber);
          }),
          prompt: vi.fn(async (prompt: string) => {
            prompts.push(prompt);
            promptCount += 1;
            if (promptCount === 2) {
              for (const subscriber of subscribers) {
                subscriber({
                  type: "tool_execution_start",
                  toolName: "edit",
                  args: { path: "src/slugify.js" },
                });
                subscriber({
                  type: "tool_execution_end",
                  toolName: "edit",
                  isError: false,
                  result: { content: [{ type: "text", text: "repair edit returned" }] },
                });
              }
            }
            await phaseTool.execute(`complete-phase-${promptCount}`, {}, undefined, () => undefined);
          }),
          dispose: vi.fn(),
        },
      };
    });

    const result = await (executor as any).runGraphCustomNode(
      campaignModelNode(execution),
      nodeTask,
      await store.getSettings(),
      undefined,
      undefined,
      { task: nodeTask, settings: undefined, context: {}, execution },
    );

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toMatch(/CCC_CAMPAIGN_REPAIR/);
    expect(verifyCccCampaignReadyCandidateMock).toHaveBeenCalledTimes(2);
    expect(result.outcome).toBe("success");
  });

  it("carries the rendered repair-feedback envelope, verdict-first, into the REPAIR log entry and prompt", async () => {
    const { execution, executor, nodeTask, store } = makeCampaignNodeHarness(
      "",
      "/tmp/ccc-campaign-repair-envelope",
    );
    fingerprintCccCampaignReadyCandidateMock.mockReset();
    fingerprintCccCampaignReadyCandidateMock
      .mockResolvedValueOnce("a".repeat(64))
      .mockResolvedValueOnce("b".repeat(64))
      .mockResolvedValueOnce("b".repeat(64))
      .mockResolvedValue("c".repeat(64));
    fingerprintCccCampaignAllowedCandidateMock.mockReset();
    fingerprintCccCampaignAllowedCandidateMock
      .mockResolvedValueOnce("a".repeat(64))
      .mockResolvedValueOnce("b".repeat(64))
      .mockResolvedValueOnce("b".repeat(64))
      .mockResolvedValue("c".repeat(64));
    const largeDiagnosticTail = "x".repeat(2_000);
    verifyCccCampaignReadyCandidateMock
      .mockResolvedValueOnce({
        ready: false,
        summary: "sealed verifier exit 1: AC-002 failed",
        repairFeedback: {
          verdict: "failed",
          verifierCommand: "task verify:ready",
          exitCode: 1,
          proofEvidence: {
            schema: "ccc-prd.proof-evidence.v2",
            proofId: "PROOF-READY",
            phase: "task",
            sourceCommit: "a".repeat(40),
            sourceTree: "a".repeat(40),
            passed: false,
            clauseResults: [{ clauseId: "AC-002", passed: false }],
            positiveCaseResults: [],
            negativeControlResults: [],
          },
          proofEvidenceParseIssue: undefined,
          observedCandidate: [
            {
              path: "src/slugify.js",
              kind: "file",
              bytes: 42,
              sha256: "f".repeat(64),
              endsWithNewline: false,
            },
          ],
          omittedPaths: 0,
          diagnosticTail: largeDiagnosticTail,
          diagnosticTruncated: true,
        },
      })
      .mockResolvedValueOnce(
        readyVerification("c".repeat(64), "/tmp/ccc-campaign-repair-envelope"),
      );
    const prompts: string[] = [];
    let promptCount = 0;
    mockedCreateFnAgent.mockImplementation(async (options: any) => {
      const subscribers = new Set<(event: any) => void>();
      const phaseTool = options.customTools.find(
        (tool: { name: string }) => tool.name === "fn_complete_phase",
      );
      return {
        session: {
          subscribe: vi.fn((subscriber: (event: any) => void) => {
            subscribers.add(subscriber);
            return () => subscribers.delete(subscriber);
          }),
          prompt: vi.fn(async (prompt: string) => {
            prompts.push(prompt);
            promptCount += 1;
            if (promptCount === 2) {
              for (const subscriber of subscribers) {
                subscriber({
                  type: "tool_execution_start",
                  toolName: "edit",
                  args: { path: "src/slugify.js" },
                });
                subscriber({
                  type: "tool_execution_end",
                  toolName: "edit",
                  isError: false,
                  result: { content: [{ type: "text", text: "repair edit returned" }] },
                });
              }
            }
            await phaseTool.execute(`complete-phase-${promptCount}`, {}, undefined, () => undefined);
          }),
          dispose: vi.fn(),
        },
      };
    });

    const result = await (executor as any).runGraphCustomNode(
      campaignModelNode(execution),
      nodeTask,
      await store.getSettings(),
      undefined,
      undefined,
      { task: nodeTask, settings: undefined, context: {}, execution },
    );

    expect(prompts).toHaveLength(2);
    const repairPrompt = prompts[1];
    expect(repairPrompt).toMatch(/CCC_CAMPAIGN_REPAIR/);
    // Verdict-first: the rendered verdict marker must precede the raw diagnostic
    // tail inside the prompt, proving the prompt is not built by a tail slice
    // that could drop the verdict.
    const verdictIndex = repairPrompt.search(/FAILED/i);
    const commandIndex = repairPrompt.indexOf("task verify:ready");
    const exitCodeIndex = repairPrompt.indexOf("AC-002");
    const diagnosticIndex = repairPrompt.indexOf(largeDiagnosticTail);
    expect(verdictIndex).toBeGreaterThanOrEqual(0);
    expect(commandIndex).toBeGreaterThan(verdictIndex);
    expect(exitCodeIndex).toBeGreaterThan(-1);
    expect(diagnosticIndex).toBeGreaterThan(exitCodeIndex);
    expect(repairPrompt).toContain("src/slugify.js");
    expect(repairPrompt).toContain("42 bytes");
    expect(repairPrompt).toContain("endsWithNewline=false");

    const repairLogCall = (store.logEntry as any).mock.calls.find(
      ([, message]: [string, string]) => message.includes("[ccc-campaign:repair]"),
    );
    expect(repairLogCall).toBeDefined();
    expect(repairLogCall[1]).toMatch(/FAILED/i);
    expect(repairLogCall[1]).toContain("task verify:ready");
    expect(repairLogCall[1]).toContain("AC-002");

    expect(result.outcome).toBe("success");
  });

  it("falls back to the plain summary in the REPAIR prompt when the verification failure carries no repair-feedback envelope", async () => {
    const { execution, executor, nodeTask, store } = makeCampaignNodeHarness(
      "",
      "/tmp/ccc-campaign-repair-fallback",
    );
    fingerprintCccCampaignReadyCandidateMock.mockReset();
    fingerprintCccCampaignReadyCandidateMock
      .mockResolvedValueOnce("a".repeat(64))
      .mockResolvedValueOnce("b".repeat(64))
      .mockResolvedValueOnce("b".repeat(64))
      .mockResolvedValue("c".repeat(64));
    fingerprintCccCampaignAllowedCandidateMock.mockReset();
    fingerprintCccCampaignAllowedCandidateMock
      .mockResolvedValueOnce("a".repeat(64))
      .mockResolvedValueOnce("b".repeat(64))
      .mockResolvedValueOnce("b".repeat(64))
      .mockResolvedValue("c".repeat(64));
    // A pre-command verifyCccCampaignReadyCandidate failure (e.g. "no
    // implementation diff") never populates repairFeedback — only the
    // sealed-verifier-failure branch does. The executor must still surface
    // the plain summary text in the REPAIR prompt/log in that case.
    verifyCccCampaignReadyCandidateMock
      .mockResolvedValueOnce({
        ready: false,
        summary: "the candidate worktree has no implementation diff",
      })
      .mockResolvedValueOnce(
        readyVerification("c".repeat(64), "/tmp/ccc-campaign-repair-fallback"),
      );
    const prompts: string[] = [];
    let promptCount = 0;
    mockedCreateFnAgent.mockImplementation(async (options: any) => {
      const subscribers = new Set<(event: any) => void>();
      const phaseTool = options.customTools.find(
        (tool: { name: string }) => tool.name === "fn_complete_phase",
      );
      return {
        session: {
          subscribe: vi.fn((subscriber: (event: any) => void) => {
            subscribers.add(subscriber);
            return () => subscribers.delete(subscriber);
          }),
          prompt: vi.fn(async (prompt: string) => {
            prompts.push(prompt);
            promptCount += 1;
            if (promptCount === 2) {
              for (const subscriber of subscribers) {
                subscriber({
                  type: "tool_execution_start",
                  toolName: "edit",
                  args: { path: "src/slugify.js" },
                });
                subscriber({
                  type: "tool_execution_end",
                  toolName: "edit",
                  isError: false,
                  result: { content: [{ type: "text", text: "repair edit returned" }] },
                });
              }
            }
            await phaseTool.execute(`complete-phase-${promptCount}`, {}, undefined, () => undefined);
          }),
          dispose: vi.fn(),
        },
      };
    });

    const result = await (executor as any).runGraphCustomNode(
      campaignModelNode(execution),
      nodeTask,
      await store.getSettings(),
      undefined,
      undefined,
      { task: nodeTask, settings: undefined, context: {}, execution },
    );

    expect(prompts).toHaveLength(2);
    const repairPrompt = prompts[1];
    expect(repairPrompt).toMatch(/CCC_CAMPAIGN_REPAIR/);
    expect(repairPrompt).toContain("the candidate worktree has no implementation diff");
    const repairLogCall = (store.logEntry as any).mock.calls.find(
      ([, message]: [string, string]) => message.includes("[ccc-campaign:repair]"),
    );
    expect(repairLogCall).toBeDefined();
    expect(repairLogCall[1]).toContain("the candidate worktree has no implementation diff");
    expect(result.outcome).toBe("success");
  });

  it("eager_verify_blocked: invalidates a phase signal followed by same-turn tool activity", async () => {
    const { execution, executor, nodeTask, store } = makeCampaignNodeHarness(
      "",
      "/tmp/ccc-campaign-eager-verify",
    );
    mockedCreateFnAgent.mockImplementation(async (options: any) => {
      const subscribers = new Set<(event: any) => void>();
      const phaseTool = options.customTools.find(
        (tool: { name: string }) => tool.name === "fn_complete_phase",
      );
      return {
        session: {
          subscribe: vi.fn((subscriber: (event: any) => void) => {
            subscribers.add(subscriber);
            return () => subscribers.delete(subscriber);
          }),
          prompt: vi.fn(async () => {
            await phaseTool.execute("complete-phase", {}, undefined, () => undefined);
            for (const subscriber of subscribers) {
              subscriber({
                type: "tool_execution_start",
                toolName: "edit",
                args: { path: "src/slugify.js" },
              });
              subscriber({
                type: "tool_execution_end",
                toolName: "edit",
                isError: false,
                result: { content: [{ type: "text", text: "edit returned" }] },
              });
            }
          }),
          dispose: vi.fn(),
        },
      };
    });

    const result = await (executor as any).runGraphCustomNode(
      campaignModelNode(execution),
      nodeTask,
      await store.getSettings(),
      undefined,
      undefined,
      { task: nodeTask, settings: undefined, context: {}, execution },
    );

    expect(assertCccCampaignRequiredCommitCandidateMock).not.toHaveBeenCalled();
    expect(verifyCccCampaignReadyCandidateMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      outcome: "failure",
      value: expect.stringMatching(/phase completion signal.*later tool activity/i),
      contextPatch: {
        "node:ccc-task-implementation:error": expect.stringMatching(/phase completion signal.*later tool activity/i),
      },
    });
  });

  it("discover_exit_requires_explicit_signal: warns at 33 reads and fails after one quiet continuation", async () => {
    const { execution, executor, nodeTask, store } = makeCampaignNodeHarness(
      "",
      "/tmp/ccc-campaign-discover-quiet",
    );
    const userPrompts: string[] = [];
    let promptCount = 0;
    mockedExec.mockImplementation(((command: string, _options: unknown, callback: any) => {
      if (command === "git status --porcelain=v1 --untracked-files=all") {
        callback(null, "", "");
        return {} as any;
      }
      callback(null, "", "");
      return {} as any;
    }) as any);
    mockedCreateFnAgent.mockImplementation(async () => {
      const subscribers = new Set<(event: any) => void>();
      return {
        session: {
          subscribe: vi.fn((subscriber: (event: any) => void) => {
            subscribers.add(subscriber);
            return () => subscribers.delete(subscriber);
          }),
          prompt: vi.fn(async (prompt: string) => {
            userPrompts.push(prompt);
            promptCount += 1;
            if (promptCount !== 1) return;
            for (let index = 0; index < 33; index += 1) {
              for (const subscriber of subscribers) {
                const bashDiscovery = index % 3 === 0;
                subscriber({
                  type: "tool_execution_start",
                  toolName: bashDiscovery ? "bash" : "read",
                  args: bashDiscovery
                    ? { command: "FUSION_TEST=1 git grep bounded" }
                    : { path: `src/file-${index}.ts` },
                });
                subscriber({
                  type: "tool_execution_end",
                  toolName: bashDiscovery ? "bash" : "read",
                  isError: false,
                  result: { content: [{ type: "text", text: "bounded read" }] },
                });
              }
            }
          }),
          dispose: vi.fn(),
        },
      };
    });

    const result = await (executor as any).runGraphCustomNode(
      campaignModelNode(execution),
      nodeTask,
      await store.getSettings(),
      undefined,
      undefined,
      { task: nodeTask, settings: undefined, context: {}, execution },
    );

    expect(userPrompts).toHaveLength(2);
    expect(userPrompts[1]).toContain("CCC_CAMPAIGN_DISCOVER_CESSATION");
    expect(store.logEntry).toHaveBeenCalledWith(
      nodeTask.id,
      expect.stringMatching(/read-cap-warning.*33/i),
    );
    expect(assertCccCampaignRequiredCommitCandidateMock).not.toHaveBeenCalled();
    expect(verifyCccCampaignReadyCandidateMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      outcome: "failure",
      value: expect.stringMatching(/DISCOVER.*explicit phase signal/i),
      contextPatch: {
        "node:ccc-task-implementation:error": expect.stringMatching(/DISCOVER.*explicit phase signal/i),
      },
    });
  });

  it("RED-G2-discover-envelope: gives a large remaining request envelope eight bounded quiet continuations", async () => {
    const { execution, executor, nodeTask, store, userPrompts } = makeCampaignNodeHarness(
      "Still inspecting the admitted task.",
      "/tmp/ccc-campaign-generous-discover",
      { signalPhaseCompletion: false },
    );
    store.getCccCampaignContextForTask.mockResolvedValueOnce({
      ...(await store.getCccCampaignContextForTask(nodeTask.id)),
      bounds: { maxRequests: 2_304, maxDurationMs: 21_600_000, maxConcurrency: 3 },
      requestCount: 1,
    });
    mockedExec.mockImplementation(((command: string, _options: unknown, callback: any) => {
      if (command === "git status --porcelain=v1 --untracked-files=all") {
        callback(null, "", "");
        return {} as any;
      }
      callback(null, "", "");
      return {} as any;
    }) as any);

    const result = await (executor as any).runGraphCustomNode(
      campaignModelNode(execution),
      nodeTask,
      await store.getSettings(),
      undefined,
      undefined,
      { task: nodeTask, settings: undefined, context: {}, execution },
    );

    expect(userPrompts).toHaveLength(9);
    expect(userPrompts.slice(1)).toEqual(
      Array.from({ length: 8 }, (_, index) =>
        expect.stringMatching(new RegExp(`DISCOVER_CESSATION.*continuation ${index + 1} of 8`, "is"))),
    );
    expect(result).toMatchObject({
      outcome: "failure",
      value: expect.stringMatching(/DISCOVER.*explicit phase signal/i),
      contextPatch: {
        "node:ccc-task-implementation:error": expect.stringMatching(/DISCOVER.*explicit phase signal/i),
      },
    });
  });

  it("campaign implementation sessions receive a request-budget-derived discovery tool boundary", async () => {
    const { execution, executor, nodeTask, store, userPrompts } = makeCampaignNodeHarness(
      "",
      "/tmp/ccc-campaign-discover-tool-boundary",
    );
    store.getCccCampaignContextForTask.mockResolvedValueOnce({
      ...(await store.getCccCampaignContextForTask(nodeTask.id)),
      bounds: { maxRequests: 4, maxDurationMs: 120_000, maxConcurrency: 1 },
      requestCount: 0,
    });

    await (executor as any).runGraphCustomNode(
      campaignModelNode(execution),
      nodeTask,
      await store.getSettings(),
      undefined,
      undefined,
      { task: nodeTask, settings: undefined, context: {}, execution },
    );

    const sessionCall = mockedCreateFnAgent.mock.calls[0]?.[0] as Record<string, any>;
    expect(sessionCall.cccCampaignPhaseToolPolicy).toMatchObject({
      readOnlyToolNames: ["read", "grep", "find", "ls", "glob", "bash"],
      maxReadOnlyToolCallsBeforeGuidance: 4,
      maxReadOnlyToolCallsBeforeRefusal: 8,
    });
    expect(sessionCall.cccCampaignPhaseToolPolicy.approvedMcpDiscoveryTools).toHaveLength(28);
    expect(sessionCall.cccCampaignPhaseToolPolicy.approvedMcpDiscoveryTools).toEqual(
      expect.arrayContaining([
        { serverName: "fusion-code-core", toolName: "smart-tree__search" },
        { serverName: "fusion-code-core", toolName: "brave-search__brave_web_search" },
        { serverName: "fusion-code-core", toolName: "serper-mcp__google_search_scholar" },
        { serverName: "fusion-code-core", toolName: "fetch-guard__fetch" },
      ]),
    );
    expect(sessionCall.cccCampaignPhaseToolPolicy.onApprovedMcpDiscoveryToolCall).toEqual(expect.any(Function));
    expect(userPrompts[0]).toContain("CCC_CAMPAIGN_DISCOVER_BOUNDARY");
    expect(userPrompts[0]).toContain("at most 4 read/search/list discovery tool call");
    expect(userPrompts[0]).toContain("Do not read the sealed verifier before the first targeted proof failure");
    expect(userPrompts[0]).toContain("Do not redirect verifier or test output to files");
    expect(userPrompts[0]).toContain("call fn_complete_phase as the next and only tool");
  });

  it("fails closed to the minimum discovery boundary when persisted request bounds are absent", async () => {
    const { execution, executor, nodeTask, store } = makeCampaignNodeHarness(
      "",
      "/tmp/ccc-campaign-missing-request-bounds",
    );
    store.getCccCampaignContextForTask.mockResolvedValueOnce({
      ...(await store.getCccCampaignContextForTask(nodeTask.id)),
      bounds: undefined,
      requestCount: 0,
    } as never);

    await (executor as any).runGraphCustomNode(
      campaignModelNode(execution),
      nodeTask,
      await store.getSettings(),
      undefined,
      undefined,
      { task: nodeTask, settings: undefined, context: {}, execution },
    );

    expect((mockedCreateFnAgent.mock.calls[0]?.[0] as Record<string, any>).cccCampaignPhaseToolPolicy)
      .toMatchObject({
        maxReadOnlyToolCallsBeforeGuidance: 1,
        maxReadOnlyToolCallsBeforeRefusal: 2,
      });
  });

  it("keeps discovery generous and bounded when the whole-product request envelope is generous", async () => {
    const { execution, executor, nodeTask, store, userPrompts } = makeCampaignNodeHarness(
      "",
      "/tmp/ccc-campaign-generous-request-bounds",
    );
    store.getCccCampaignContextForTask.mockResolvedValueOnce({
      ...(await store.getCccCampaignContextForTask(nodeTask.id)),
      bounds: { maxRequests: 2_304, maxDurationMs: 21_600_000, maxConcurrency: 3 },
      requestCount: 0,
    });

    await (executor as any).runGraphCustomNode(
      campaignModelNode(execution),
      nodeTask,
      await store.getSettings(),
      undefined,
      undefined,
      { task: nodeTask, settings: undefined, context: {}, execution },
    );

    expect((mockedCreateFnAgent.mock.calls[0]?.[0] as Record<string, any>).cccCampaignPhaseToolPolicy)
      .toMatchObject({
        maxReadOnlyToolCallsBeforeGuidance: 96,
        maxReadOnlyToolCallsBeforeRefusal: 192,
      });
    expect(userPrompts[0]).toContain("at most 96 read/search/list discovery tool call");
  });

  it("moves the live controller policy to MUTATE only after admitted candidate bytes change", async () => {
    const { execution, executor, nodeTask, store } = makeCampaignNodeHarness(
      "",
      "/tmp/ccc-campaign-live-mutation-phase",
    );
    let observedBefore: string | undefined;
    let observedAfter: string | undefined;
    mockedCreateFnAgent.mockImplementation(async (options: any) => ({
      session: {
        subscribe: vi.fn(() => vi.fn()),
        prompt: vi.fn(async () => {
          observedBefore = options.cccCampaignPhaseToolPolicy.currentPhase();
          await options.cccCampaignPhaseToolPolicy.onPotentialMutationCompleted("write", {
            path: "src/slugify.js",
          });
          observedAfter = options.cccCampaignPhaseToolPolicy.currentPhase();
          const phaseTool = options.customTools.find((tool: any) => tool.name === "fn_complete_phase");
          await phaseTool.execute("complete-phase", {}, undefined, () => undefined);
        }),
        dispose: vi.fn(),
      },
    }));

    await (executor as any).runGraphCustomNode(
      campaignModelNode(execution),
      nodeTask,
      await store.getSettings(),
      undefined,
      undefined,
      { task: nodeTask, settings: undefined, context: {}, execution },
    );

    expect(observedBefore).toBe("DISCOVER");
    expect(observedAfter).toBe("MUTATE");
  });

  it("passes exact admitted roots and full write-set custody callbacks into Pi", async () => {
    const { execution, executor, nodeTask, store, userPrompts } = makeCampaignNodeHarness(
      "completed",
      "/tmp/ccc-campaign-write-envelope-policy",
    );

    await (executor as any).runGraphCustomNode(
      campaignModelNode(execution),
      nodeTask,
      await store.getSettings(),
      undefined,
      undefined,
      { task: nodeTask, settings: undefined, context: {}, execution },
    );

    const sessionCall = mockedCreateFnAgent.mock.calls[0]?.[0] as Record<string, any>;
    expect(sessionCall.systemPrompt).toMatch(/exact admitted write roots/i);
    expect(sessionCall.systemPrompt).toContain("- src");
    expect(sessionCall.systemPrompt).toContain("- test");
    expect(sessionCall.systemPrompt).toMatch(
      /read sealed verifier\/support files in place or use OS temp outside the worktree/i,
    );
    expect(userPrompts[0]).toMatch(
      /never copy scratch\/helper files into the candidate worktree outside the exact admitted roots/i,
    );
    expect(sessionCall.cccCampaignPhaseToolPolicy).toMatchObject({
      worktreePath: "/tmp/ccc-campaign-write-envelope-policy",
      allowedWriteRoots: ["src", "test"],
      capturePotentialMutationBaseline: expect.any(Function),
      onPotentialMutationSettled: expect.any(Function),
      completionSignalOnly: expect.any(Function),
      onSignalOnlyViolation: expect.any(Function),
    });
    expect(snapshotCccCampaignWriteEnvelopeMock).toHaveBeenCalledWith({
      worktreePath: "/tmp/ccc-campaign-write-envelope-policy",
      allowedRoots: ["src", "test"],
    });

    snapshotCccCampaignWriteEnvelopeMock
      .mockResolvedValueOnce({
        changedPaths: ["src/slugify.js"],
        foreignPaths: [],
        allowedRoots: ["src", "test"],
      })
      .mockResolvedValueOnce({
        changedPaths: [".fusion-tmp/h2.txt", "src/slugify.js"],
        foreignPaths: [".fusion-tmp/h2.txt"],
        allowedRoots: ["src", "test"],
      });
    const baseline = await sessionCall.cccCampaignPhaseToolPolicy.capturePotentialMutationBaseline();
    await expect(sessionCall.cccCampaignPhaseToolPolicy.onPotentialMutationSettled(
      "bash",
      { command: "printf x > .fusion-tmp/h2.txt" },
      baseline,
      { content: [{ type: "text", text: "done" }], isError: false },
    )).resolves.toMatchObject({
      violation: {
        message: expect.stringContaining("CCC_CAMPAIGN_WRITE_ENVELOPE_VIOLATION"),
        details: {
          toolName: "bash",
          newForeignPaths: [".fusion-tmp/h2.txt"],
          allowedWriteRoots: ["src", "test"],
        },
      },
    });
  });

  it("refuses a foreign write-set baseline before the first provider prompt", async () => {
    const { execution, executor, nodeTask, store } = makeCampaignNodeHarness(
      "",
      "/tmp/ccc-campaign-foreign-baseline",
    );
    snapshotCccCampaignWriteEnvelopeMock.mockResolvedValue({
      changedPaths: [".fusion-tmp/h2.txt"],
      foreignPaths: [".fusion-tmp/h2.txt"],
      allowedRoots: ["src", "test"],
    });
    const prompt = vi.fn().mockResolvedValue(undefined);
    mockedCreateFnAgent.mockResolvedValue({
      session: {
        subscribe: vi.fn(() => vi.fn()),
        prompt,
        dispose: vi.fn(),
      },
    });

    const result = await (executor as any).runGraphCustomNode(
      campaignModelNode(execution),
      nodeTask,
      await store.getSettings(),
      undefined,
      undefined,
      { task: nodeTask, settings: undefined, context: {}, execution },
    );

    expect(prompt).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      outcome: "failure",
      contextPatch: {
        "node:ccc-task-implementation:error": expect.stringMatching(/WRITE_ENVELOPE_BASELINE_REFUSED.*fusion-tmp\/h2\.txt/i),
      },
    });
  });

  it("refuses provider dispatch when the write-envelope baseline is unavailable", async () => {
    const { execution, executor, nodeTask, store } = makeCampaignNodeHarness(
      "",
      "/tmp/ccc-campaign-baseline-unavailable",
    );
    snapshotCccCampaignWriteEnvelopeMock.mockRejectedValue(
      new Error("git candidate snapshot unavailable"),
    );
    const prompt = vi.fn().mockResolvedValue(undefined);
    mockedCreateFnAgent.mockResolvedValue({
      session: {
        subscribe: vi.fn(() => vi.fn()),
        prompt,
        dispose: vi.fn(),
      },
    });

    const result = await (executor as any).runGraphCustomNode(
      campaignModelNode(execution),
      nodeTask,
      await store.getSettings(),
      undefined,
      undefined,
      { task: nodeTask, settings: undefined, context: {}, execution },
    );

    expect(prompt).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      outcome: "failure",
      contextPatch: {
        "node:ccc-task-implementation:error": expect.stringMatching(
          /WRITE_ENVELOPE_BASELINE_UNAVAILABLE.*git candidate snapshot unavailable/i,
        ),
      },
    });
  });

  it("mutate_exit_requires_explicit_signal: a dirty quiet turn cannot return success", async () => {
    const { execution, executor, nodeTask, store } = makeCampaignNodeHarness(
      "",
      "/tmp/ccc-campaign-mutate-quiet",
    );
    const userPrompts: string[] = [];
    mockedCreateFnAgent.mockImplementation(async () => ({
      session: {
        subscribe: vi.fn(() => vi.fn()),
        prompt: vi.fn(async (prompt: string) => {
          userPrompts.push(prompt);
        }),
        dispose: vi.fn(),
      },
    }));

    const result = await (executor as any).runGraphCustomNode(
      campaignModelNode(execution),
      nodeTask,
      await store.getSettings(),
      undefined,
      undefined,
      { task: nodeTask, settings: undefined, context: {}, execution },
    );

    expect(userPrompts).toHaveLength(3);
    expect(userPrompts[1]).toContain("CCC_CAMPAIGN_MUTATE_CESSATION");
    expect(userPrompts[2]).toContain("CCC_CAMPAIGN_PHASE_SIGNAL_REQUIRED");
    expect(assertCccCampaignRequiredCommitCandidateMock).not.toHaveBeenCalled();
    expect(verifyCccCampaignReadyCandidateMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      outcome: "failure",
      value: expect.stringMatching(/signal-only.*fn_complete_phase/i),
      contextPatch: {
        "node:ccc-task-implementation:error": expect.stringMatching(/signal-only.*fn_complete_phase/i),
      },
    });
  });

  it("phase_signal_handshake_gives_glm_shaped_prose_completion_one tool-only request", async () => {
    const { execution, executor, nodeTask, store } = makeCampaignNodeHarness(
      "",
      "/tmp/ccc-campaign-phase-signal-handshake",
    );
    const userPrompts: string[] = [];
    mockedCreateFnAgent.mockImplementation(async (options: any) => {
      const phaseTool = options.customTools.find((tool: any) => tool.name === "fn_complete_phase");
      return {
        session: {
          subscribe: vi.fn(() => vi.fn()),
          prompt: vi.fn(async (prompt: string) => {
            userPrompts.push(prompt);
            if (userPrompts.length === 3) {
              await phaseTool.execute("complete-phase", {}, undefined, () => undefined);
            }
          }),
          dispose: vi.fn(),
        },
      };
    });

    const result = await (executor as any).runGraphCustomNode(
      campaignModelNode(execution),
      nodeTask,
      await store.getSettings(),
      undefined,
      undefined,
      { task: nodeTask, settings: undefined, context: {}, execution },
    );

    expect(userPrompts).toHaveLength(3);
    expect(userPrompts[1]).toContain("CCC_CAMPAIGN_MUTATE_CESSATION");
    expect(userPrompts[2]).toContain("CCC_CAMPAIGN_PHASE_SIGNAL_REQUIRED");
    expect(userPrompts[2]).toMatch(/next action must be exactly one fn_complete_phase tool call/i);
    expect(verifyCccCampaignReadyCandidateMock).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe("success");
  });

  it("signal_only_sibling_tool_attempt cannot be laundered by a later phase signal", async () => {
    const { execution, executor, nodeTask, store } = makeCampaignNodeHarness(
      "",
      "/tmp/ccc-campaign-phase-signal-sibling",
    );
    const userPrompts: string[] = [];
    mockedCreateFnAgent.mockImplementation(async (options: any) => {
      const phaseTool = options.customTools.find((tool: any) => tool.name === "fn_complete_phase");
      return {
        session: {
          subscribe: vi.fn(() => vi.fn()),
          prompt: vi.fn(async (prompt: string) => {
            userPrompts.push(prompt);
            if (userPrompts.length === 3) {
              options.cccCampaignPhaseToolPolicy.onSignalOnlyViolation("write");
              await phaseTool.execute("complete-phase", {}, undefined, () => undefined);
            }
          }),
          dispose: vi.fn(),
        },
      };
    });

    const result = await (executor as any).runGraphCustomNode(
      campaignModelNode(execution),
      nodeTask,
      await store.getSettings(),
      undefined,
      undefined,
      { task: nodeTask, settings: undefined, context: {}, execution },
    );

    expect(userPrompts).toHaveLength(3);
    expect(verifyCccCampaignReadyCandidateMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      outcome: "failure",
      contextPatch: {
        "node:ccc-task-implementation:error": expect.stringMatching(/invalidated.*write/i),
      },
    });
  });

  it("does not treat an unchanged pre-existing dirty candidate as this turn's mutation", async () => {
    const { execution, executor, nodeTask, store, userPrompts } = makeCampaignNodeHarness(
      "quiet turn",
      "/tmp/ccc-campaign-preexisting-dirty",
      { signalPhaseCompletion: false },
    );
    fingerprintCccCampaignReadyCandidateMock.mockReset();
    fingerprintCccCampaignReadyCandidateMock.mockResolvedValue("a".repeat(64));
    fingerprintCccCampaignAllowedCandidateMock.mockReset();
    fingerprintCccCampaignAllowedCandidateMock.mockResolvedValue("a".repeat(64));

    const result = await (executor as any).runGraphCustomNode(
      campaignModelNode(execution),
      nodeTask,
      await store.getSettings(),
      undefined,
      undefined,
      { task: nodeTask, settings: undefined, context: {}, execution },
    );

    expect(userPrompts).toHaveLength(2);
    expect(userPrompts[1]).toMatch(/CCC_CAMPAIGN_DISCOVER_CESSATION/);
    expect(userPrompts[1]).not.toMatch(/CCC_CAMPAIGN_MUTATE_CESSATION/);
    expect(result.outcome).toBe("failure");
  });

  it("refuses a phase signal that would launder an unchanged pre-existing candidate", async () => {
    const { execution, executor, nodeTask, store } = makeCampaignNodeHarness(
      "signalled without changing prior bytes",
      "/tmp/ccc-campaign-preexisting-dirty-signal",
    );
    fingerprintCccCampaignReadyCandidateMock.mockReset();
    fingerprintCccCampaignReadyCandidateMock.mockResolvedValue("a".repeat(64));
    fingerprintCccCampaignAllowedCandidateMock.mockReset();
    fingerprintCccCampaignAllowedCandidateMock.mockResolvedValue("a".repeat(64));

    const result = await (executor as any).runGraphCustomNode(
      campaignModelNode(execution),
      nodeTask,
      await store.getSettings(),
      undefined,
      undefined,
      { task: nodeTask, settings: undefined, context: {}, execution },
    );

    expect(assertCccCampaignRequiredCommitCandidateMock).not.toHaveBeenCalled();
    expect(verifyCccCampaignReadyCandidateMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      outcome: "failure",
      value: expect.stringMatching(/unchanged pre-existing candidate/i),
      contextPatch: {
        "node:ccc-task-implementation:error": expect.stringMatching(/unchanged pre-existing candidate/i),
      },
    });
  });

  it("persists bounded tool evidence for a campaign even when the project default is off", async () => {
    const { execution, executor, nodeTask, store } = makeCampaignNodeHarness(
      "Files written and targeted verification passed.",
      "/tmp/ccc-campaign-tool-evidence",
    );
    mockedCreateFnAgent.mockImplementation(async () => {
      const subscribers = new Set<(event: any) => void>();
      return {
        session: {
          subscribe: vi.fn((subscriber: (event: any) => void) => {
            subscribers.add(subscriber);
            return () => subscribers.delete(subscriber);
          }),
          prompt: vi.fn(async () => {
            for (const subscriber of subscribers) {
              subscriber({
                type: "tool_execution_start",
                toolName: "read",
                args: { path: "src/slugify.js" },
              });
              subscriber({
                type: "tool_execution_end",
                toolName: "read",
                isError: false,
                result: { content: [{ type: "text", text: "bounded file preview" }] },
              });
            }
          }),
          dispose: vi.fn(),
        },
      };
    });

    await (executor as any).runGraphCustomNode(
      campaignModelNode(execution),
      nodeTask,
      await store.getSettings(),
      undefined,
      undefined,
      { task: nodeTask, settings: undefined, context: {}, execution },
    );

    const toolStart = store.appendAgentLog.mock.calls.find((call: any[]) => call[2] === "tool");
    const toolResult = store.appendAgentLog.mock.calls.find((call: any[]) => call[2] === "tool_result");
    expect(toolStart?.[3]).toContain("src/slugify.js");
    expect(toolResult?.[3]).toContain("bounded file preview");
  });

  /*
   * FNXC:CampaignWorktreeIdentity 2026-08-24-14:45:
   * The sealed instructions name the campaign's custody repository as "Target
   * repository", but an `isolated` route runs the agent in a freshly created
   * worktree with a different absolute path. Nothing previously told the agent
   * those two paths hold the same content, so five consecutive MiniMax M3 runs
   * spent their whole request budget trying to reconcile them and never edited
   * a file -- one run explicitly planned to "copy the files into light-marsh
   * where I can edit them". The sealed prompt bytes are hash-checked against
   * executionCustody.promptSha256, so the reconciliation has to live in the
   * system prompt, which is outside the seal.
   */
  it("tells a campaign agent its worktree is the sealed target's isolated checkout", async () => {
    const { execution, executor, nodeTask, store } = makeCampaignNodeHarness(
      "Files written and targeted verification passed.",
      "/tmp/ccc-campaign-worktree-identity",
    );
    const node = campaignModelNode(execution);

    await (executor as any).runGraphCustomNode(
      node,
      nodeTask,
      await store.getSettings(),
      undefined,
      undefined,
      { task: nodeTask, settings: undefined, context: {}, execution },
    );

    const sessionCall = mockedCreateFnAgent.mock.calls[0]?.[0] as Record<string, unknown>;
    const systemPrompt = String(sessionCall.systemPrompt);
    expect(systemPrompt).toContain("/tmp/ccc-campaign-worktree-identity");
    expect(systemPrompt).toMatch(/isolated checkout of the sealed target repository/i);
    expect(systemPrompt).toMatch(/never copy files between checkouts/i);
  });

  it.each([
    { status: "", marker: /CCC_CAMPAIGN_DISCOVER_CESSATION/, label: "clean" },
    { status: " M src/slugify.js\n", marker: /CCC_CAMPAIGN_MUTATE_CESSATION/, label: "dirty" },
  ])("gives a $label unsignaled campaign one bounded work continuation and a dirty candidate one signal handshake", async ({
    status,
    marker,
    label,
  }) => {
    const { execution, executor, nodeTask, store, userPrompts } = makeCampaignNodeHarness(
      "Implementation turn completed.",
      "/tmp/ccc-campaign-no-diff-continuation",
      { signalPhaseCompletion: false },
    );
    mockedExec.mockImplementation(((command: string, _options: unknown, callback: any) => {
      if (command === "git status --porcelain=v1 --untracked-files=all") {
        callback(null, status, "");
        return {} as any;
      }
      callback(null, "", "");
      return {} as any;
    }) as any);

    const result = await (executor as any).runGraphCustomNode(
      campaignModelNode(execution),
      nodeTask,
      await store.getSettings(),
      undefined,
      undefined,
      { task: nodeTask, settings: undefined, context: {}, execution },
    );

    expect(userPrompts).toHaveLength(label === "dirty" ? 3 : 2);
    expect(userPrompts[1]).toMatch(marker);
    if (label === "dirty") {
      expect(userPrompts[2]).toMatch(/CCC_CAMPAIGN_PHASE_SIGNAL_REQUIRED/);
    }
    expect(result.outcome).toBe("failure");
  });

  it("does not let a no-diff continuation run model verification after creating a diff", async () => {
    const { execution, executor, nodeTask, store, userPrompts } = makeCampaignNodeHarness(
      "Implementation turn completed.",
      "/tmp/ccc-campaign-no-diff-verification-handoff",
      { signalPhaseCompletion: false },
    );
    const statuses = ["", " M src/slugify.js\n"];
    mockedExec.mockImplementation(((command: string, _options: unknown, callback: any) => {
      if (command === "git status --porcelain=v1 --untracked-files=all") {
        callback(null, statuses.shift() ?? " M src/slugify.js\n", "");
        return {} as any;
      }
      callback(null, "", "");
      return {} as any;
    }) as any);

    const result = await (executor as any).runGraphCustomNode(
      campaignModelNode(execution),
      nodeTask,
      await store.getSettings(),
      undefined,
      undefined,
      { task: nodeTask, settings: undefined, context: {}, execution },
    );

    expect(userPrompts).toHaveLength(4);
    expect(userPrompts[1]).toMatch(/CCC_CAMPAIGN_DISCOVER_CESSATION/);
    expect(userPrompts[2]).toMatch(/CCC_CAMPAIGN_MUTATE_CESSATION/);
    expect(userPrompts[2]).not.toMatch(/run the exact sealed verifier/i);
    expect(userPrompts[3]).toMatch(/CCC_CAMPAIGN_PHASE_SIGNAL_REQUIRED/);
    expect(assertCccCampaignRequiredCommitCandidateMock).not.toHaveBeenCalled();
    expect(verifyCccCampaignReadyCandidateMock).not.toHaveBeenCalled();
    expect(result.outcome).toBe("failure");
  });

  it("keeps a fenced lookalike with non-required commit policy in reviewer mode", async () => {
    const { execution, executor, nodeTask, store, userPrompts } = makeCampaignNodeHarness(
      '{"verdict":"APPROVE","notes":""}',
      "/tmp/ccc-campaign-lookalike",
    );

    const result = await (executor as any).runGraphCustomNode(
      campaignModelNode(execution, { commitPolicy: "optional" }),
      nodeTask,
      await store.getSettings(),
      undefined,
      undefined,
      { task: nodeTask, settings: undefined, context: {}, execution },
    );

    expect(result).toMatchObject({ outcome: "success", value: "APPROVE" });
    expect(userPrompts).toHaveLength(1);
    expect(userPrompts[0]).toContain("Review the work done in this worktree");
    expect(userPrompts[0]).not.toContain("Implement the sealed campaign task");
    const sessionCall = mockedCreateFnAgent.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sessionCall.systemPrompt).toContain("You are a workflow step agent");
    expect(sessionCall.systemPrompt).not.toContain("You are a campaign implementation agent");
  });

  it("keeps a frozen lookalike with missing campaign task identities in reviewer mode", async () => {
    const { execution: validExecution, executor, nodeTask, store, userPrompts } = makeCampaignNodeHarness(
      '{"verdict":"APPROVE","notes":""}',
      "/tmp/ccc-campaign-missing-identities",
    );
    const malformedExecution = Object.freeze({
      ...validExecution,
      semanticTaskId: undefined,
      nativeTaskId: undefined,
    });

    await (executor as any).runGraphCustomNode(
      campaignModelNode(malformedExecution as any, {
        cccPrdTaskId: undefined,
        cccNativeTaskId: undefined,
      }),
      nodeTask,
      await store.getSettings(),
      undefined,
      undefined,
      { task: nodeTask, settings: undefined, context: {}, execution: malformedExecution },
    );

    expect(userPrompts).toHaveLength(1);
    expect(userPrompts[0]).toContain("Review the work done in this worktree");
    expect(userPrompts[0]).not.toContain("Implement the sealed campaign task");
  });

  it.each([
    ["an invalid execution-prompt digest", { cccExecutionPromptSha256: "not-a-sha256" }],
    ["an invalid route digest", { cccExecutionRouteSha256: "not-a-sha256" }],
    ["a non-Pi transport", { cccExecutionTransport: "workflow" }],
  ])("keeps a fenced lookalike with %s in reviewer mode", async (_case, overrides) => {
    const { execution, executor, nodeTask, store, userPrompts } = makeCampaignNodeHarness(
      '{"verdict":"APPROVE","notes":""}',
      "/tmp/ccc-campaign-invalid-custody",
    );

    await (executor as any).runGraphCustomNode(
      campaignModelNode(execution, overrides),
      nodeTask,
      await store.getSettings(),
      undefined,
      undefined,
      { task: nodeTask, settings: undefined, context: {}, execution },
    );

    expect(userPrompts).toHaveLength(1);
    expect(userPrompts[0]).toContain("Review the work done in this worktree");
    expect(userPrompts[0]).not.toContain("Implement the sealed campaign task");
  });

  it("keeps the fallback pair on an ordinary unfenced workflow step", async () => {
    const nodeTask = task({
      executionMode: "fast",
      worktree: "/tmp/ordinary-step",
      modelProvider: "openai",
      modelId: "gpt-4o",
    });
    const { executor } = makeExecutorForTask(nodeTask);
    const userPrompts = installOutputSession("");

    await (executor as any).executeWorkflowStep(
      nodeTask,
      workflowStep(),
      "/tmp/ordinary-step",
      { executionProvider: "openai", executionModelId: "gpt-4o" },
      undefined,
      undefined,
    );

    const ordinaryCall = mockedCreateFnAgent.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(ordinaryCall).toBeDefined();
    expect(ordinaryCall.cccProviderAttemptBinding).toBeUndefined();
    expect(ordinaryCall).toHaveProperty("fallbackProvider");
    expect(ordinaryCall).toHaveProperty("fallbackModelId");
    expect(ordinaryCall.systemPrompt).toContain("You are a workflow step agent");
    expect(ordinaryCall.systemPrompt).not.toContain("You are a campaign implementation agent");
    expect(userPrompts[0]).toContain("Review the work done in this worktree");
    expect(createCccCampaignProviderAttemptBindingMock).not.toHaveBeenCalled();
  });
});
