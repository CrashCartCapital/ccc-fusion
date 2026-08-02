// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from "vitest";
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

  it("keeps the fallback pair on an ordinary unfenced workflow step", async () => {
    const nodeTask = task({
      executionMode: "fast",
      worktree: "/tmp/ordinary-step",
      modelProvider: "openai",
      modelId: "gpt-4o",
    });
    const { executor } = makeExecutorForTask(nodeTask);

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
    expect(createCccCampaignProviderAttemptBindingMock).not.toHaveBeenCalled();
  });
});
