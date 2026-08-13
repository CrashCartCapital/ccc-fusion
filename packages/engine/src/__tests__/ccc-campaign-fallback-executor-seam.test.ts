// @ts-nocheck
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
const { createCccCampaignProviderAttemptBindingMock } = vi.hoisted(() => ({
  createCccCampaignProviderAttemptBindingMock: vi.fn(),
}));
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import {
  createMockStore,
  mockedCreateFnAgent,
  mockedExistsSync,
  resetExecutorMocks,
} from "./executor-test-helpers.js";

vi.mock("../ccc-campaign-provider-controller.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../ccc-campaign-provider-controller.js")>(),
  createCccCampaignProviderAttemptBinding: createCccCampaignProviderAttemptBindingMock,
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

function installOutputSession(output: string, userPrompts: string[] = []) {
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
        }),
        dispose: vi.fn(),
      },
    };
  });
  return userPrompts;
}

function makeCampaignNodeHarness(output: string, worktree: string) {
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
  const userPrompts = installOutputSession(output);
  const execution = sealedExecution(nodeTask);
  return { binding, execution, executor, nodeTask, store, userPrompts };
}

describe("CCC campaign workflow steps never inherit the executor fallback pair", () => {
  beforeEach(() => {
    resetExecutorMocks();
    mockedExistsSync.mockReturnValue(true);
    createCccCampaignProviderAttemptBindingMock.mockReset();
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

  it("TSK-001 runs an exact fenced CCC Pi coding node as implementation without a reviewer verdict", async () => {
    const { binding, execution, executor, nodeTask, store, userPrompts } = makeCampaignNodeHarness(
      "Files written and targeted verification passed.",
      "/tmp/ccc-campaign-implementation",
    );
    const node = campaignModelNode(execution);

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
