import { describe, expect, it, vi } from "vitest";
import type { TaskStore } from "@fusion/core";

const proofWiring = vi.hoisted(() => ({
  handler: vi.fn(async () => ({ outcome: "success" as const })),
  create: vi.fn(),
}));

vi.mock("../ccc-campaign-proof-execution.js", () => ({
  createCccCampaignProofSuiteHandler: proofWiring.create,
}));

import { InProcessRuntime } from "../runtimes/in-process-runtime.js";

describe("in-process CCC campaign proof execution wiring", () => {
  it("installs the durable proof-suite executor on the normal campaign runtime", async () => {
    proofWiring.create.mockReturnValue(proofWiring.handler);
    const store = {} as TaskStore;
    const branchPersistence = {};
    const runtime = new InProcessRuntime({
      projectId: "proof-runtime-wiring",
      workingDirectory: "/tmp/proof-runtime-wiring",
      isolationMode: "in-process",
      maxConcurrent: 1,
      maxWorktrees: 1,
    } as never, {} as never) as unknown as {
      taskStore: TaskStore;
      executor: {
        createAuthoritativeWorkflowPrimitives: ReturnType<typeof vi.fn>;
        createAuthoritativeWorkflowCustomNodeRunner: ReturnType<typeof vi.fn>;
        createAuthoritativeWorkflowNodePreparation: ReturnType<typeof vi.fn>;
        createAuthoritativeWorkflowBranchPersistence: ReturnType<typeof vi.fn>;
        createCccCampaignWorkflowNodeProviderControllerResolver: ReturnType<typeof vi.fn>;
      };
      cccCampaignProofBootstrapPromise: Promise<void>;
      ensureCccCampaignWorkflowRuntime(settings: unknown): Promise<unknown>;
    };
    runtime.taskStore = store;
    runtime.executor = {
      createAuthoritativeWorkflowPrimitives: vi.fn(() => ({})),
      createAuthoritativeWorkflowCustomNodeRunner: vi.fn(() =>
        vi.fn(async () => ({ outcome: "success" as const }))),
      createAuthoritativeWorkflowNodePreparation: vi.fn(() =>
        vi.fn(async () => undefined)),
      createAuthoritativeWorkflowBranchPersistence: vi.fn(() => branchPersistence),
      createCccCampaignWorkflowNodeProviderControllerResolver: vi.fn(() => undefined),
    };
    runtime.cccCampaignProofBootstrapPromise = Promise.resolve();

    const campaignRuntime = await runtime.ensureCccCampaignWorkflowRuntime({});

    expect(proofWiring.create).toHaveBeenCalledTimes(1);
    expect(proofWiring.create).toHaveBeenCalledWith({
      rootDir: "/tmp/proof-runtime-wiring",
      store,
    });
    expect(runtime.executor.createAuthoritativeWorkflowBranchPersistence).toHaveBeenCalledTimes(1);
    expect((campaignRuntime as unknown as {
      deps: { branchPersistence?: unknown };
    }).deps.branchPersistence).toBe(branchPersistence);
  });
});
