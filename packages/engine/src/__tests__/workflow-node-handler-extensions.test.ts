// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WORKFLOW_EXTENSION_SCHEMA_VERSION,
  __resetWorkflowExtensionRegistryForTests,
  getWorkflowExtensionRegistry,
  workflowExtensionRegistryId,
  type CccCampaignProviderControllerDecision,
  type TaskDetail,
  type WorkflowIr,
  type WorkflowNodeHandlerInput,
  type WorkflowNodeProviderController,
} from "@fusion/core";
import { WorkflowGraphExecutor } from "../workflow-graph-executor.js";

const settingsOn = { experimentalFeatures: { workflowGraphExecutor: true } };

function providerController(): WorkflowNodeProviderController {
  return Object.freeze({
    preDispatch: vi.fn(async (): Promise<CccCampaignProviderControllerDecision> => {
      throw new Error("Provider controller must not run in graph posture tests");
    }),
  });
}

describe("workflow node-handler extensions", () => {
  afterEach(() => {
    __resetWorkflowExtensionRegistryForTests();
  });

  it("executes an extension-marked node and routes custom outcomes", async () => {
    const extensionKey = workflowExtensionRegistryId("node-plugin", "decision");
    const handle = vi.fn().mockResolvedValue({
      outcome: "outcome:needs-human",
      contextPatch: { decidedBy: "plugin" },
    });
    getWorkflowExtensionRegistry().register("node-plugin", {
      extensionId: "decision",
      name: "Decision",
      kind: "node-handler",
      nodeKind: "prompt",
      schemaVersion: WORKFLOW_EXTENSION_SCHEMA_VERSION,
      fallback: "failClosed",
      handle,
    });
    const workflow: WorkflowIr = {
      version: "v2",
      name: "node-extension",
      columns: [{ id: "work", name: "Work", traits: [] }],
      nodes: [
        { id: "start", kind: "start" },
        { id: "decide", kind: "prompt", column: "work", extensions: { [extensionKey]: {} } },
        { id: "human", kind: "prompt", column: "work", config: { prompt: "human" } },
        { id: "default", kind: "end" },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "decide" },
        { from: "decide", to: "human", condition: "outcome:needs-human" },
        { from: "decide", to: "default", condition: "success" },
        { from: "human", to: "end" },
      ],
    };
    const prompt = vi.fn(async () => ({ outcome: "success" as const }));
    const executor = new WorkflowGraphExecutor({ handlers: { prompt } });

    const result = await executor.run({ id: "FN-NODE" } as TaskDetail, settingsOn, workflow);

    expect(result.outcome).toBe("success");
    expect(result.visitedNodeIds).toEqual(["start", "decide", "human"]);
    expect(result.context).toMatchObject({ decidedBy: "plugin" });
    expect(handle).toHaveBeenCalledWith(expect.objectContaining({
      node: expect.objectContaining({ id: "decide" }),
      workflow,
    }));
    expect(prompt).toHaveBeenCalledWith(expect.objectContaining({ id: "human" }), expect.any(Object));
  });

  it("preserves plugin-provided values for custom outcomes", async () => {
    const extensionKey = workflowExtensionRegistryId("node-plugin", "decision");
    getWorkflowExtensionRegistry().register("node-plugin", {
      extensionId: "decision",
      name: "Decision",
      kind: "node-handler",
      nodeKind: "prompt",
      schemaVersion: WORKFLOW_EXTENSION_SCHEMA_VERSION,
      fallback: "failClosed",
      handle: vi.fn().mockResolvedValue({
        outcome: "outcome:ignored-route",
        value: "needs-human",
      }),
    });
    const workflow: WorkflowIr = {
      version: "v2",
      name: "node-extension",
      columns: [{ id: "work", name: "Work", traits: [] }],
      nodes: [
        { id: "start", kind: "start" },
        { id: "decide", kind: "prompt", column: "work", extensions: { [extensionKey]: {} } },
        { id: "human", kind: "prompt", column: "work", config: { prompt: "human" } },
        { id: "default", kind: "end" },
      ],
      edges: [
        { from: "start", to: "decide" },
        { from: "decide", to: "human", condition: "outcome:needs-human" },
        { from: "decide", to: "default", condition: "outcome:ignored-route" },
      ],
    };
    const prompt = vi.fn(async () => ({ outcome: "success" as const }));
    const executor = new WorkflowGraphExecutor({ handlers: { prompt } });

    const result = await executor.run({ id: "FN-NODE" } as TaskDetail, settingsOn, workflow);

    expect(result.outcome).toBe("success");
    expect(result.visitedNodeIds).toEqual(["start", "decide", "human"]);
  });

  it("degrades faulty node handlers before falling through to default handler", async () => {
    const extensionKey = workflowExtensionRegistryId("node-plugin", "decision");
    getWorkflowExtensionRegistry().register("node-plugin", {
      extensionId: "decision",
      name: "Decision",
      kind: "node-handler",
      nodeKind: "prompt",
      schemaVersion: WORKFLOW_EXTENSION_SCHEMA_VERSION,
      fallback: "degradeToDefault",
      handle: vi.fn().mockRejectedValue(new Error("handler failed")),
    });
    const workflow: WorkflowIr = {
      version: "v2",
      name: "node-extension",
      columns: [{ id: "work", name: "Work", traits: [] }],
      nodes: [
        { id: "start", kind: "start" },
        { id: "decide", kind: "prompt", column: "work", extensions: { [extensionKey]: {} } },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "decide" },
        { from: "decide", to: "end" },
      ],
    };
    const prompt = vi.fn(async () => ({ outcome: "success" as const }));
    const executor = new WorkflowGraphExecutor({ handlers: { prompt } });

    const result = await executor.run({ id: "FN-NODE" } as TaskDetail, settingsOn, workflow);

    expect(result.outcome).toBe("success");
    expect(prompt).toHaveBeenCalledWith(expect.objectContaining({ id: "decide" }), expect.any(Object));
    expect(getWorkflowExtensionRegistry().get(extensionKey)?.degraded).toMatchObject({
      reason: "runtime-fault",
      message: "handler failed",
    });
  });

  it("Task 4 maps resolver output to semantic task before plugin handling", async () => {
    const ORIGIN = "REQ-origin-1";
    const SEMANTIC = "REQ-semantic-1";
    const extensionKey = workflowExtensionRegistryId("node-plugin", "decision");

    const resolveNodeExecution = vi.fn(async () => ({ semanticTask: { id: SEMANTIC } as TaskDetail }));
    const admitNodeExecution = vi.fn();
    const prepareNodeExecution = vi.fn();
    const publishTaskProjection = vi.fn();
    let pluginInputTask: TaskDetail | undefined;
    let admitExecution: unknown;
    let prepareExecution: unknown;
    let projectedExecution: unknown;
    const handle = vi.fn(async ({ task }) => {
      pluginInputTask = task;
      return {
        outcome: "success",
        contextPatch: { modifiedFiles: ["src/semantic-output.ts"] },
      };
    });

    getWorkflowExtensionRegistry().register("node-plugin", {
      extensionId: "decision",
      name: "Decision",
      kind: "node-handler",
      nodeKind: "prompt",
      schemaVersion: WORKFLOW_EXTENSION_SCHEMA_VERSION,
      fallback: "failClosed",
      handle,
    }, undefined, { providerPosture: "no-provider" });

    const workflow: WorkflowIr = {
      version: "v2",
      name: "node-extension-semantic-task",
      columns: [{ id: "work", name: "Work", traits: [] }],
      nodes: [
        { id: "start", kind: "start" },
        {
          id: "decide",
          kind: "prompt",
          column: "work",
          extensions: { [extensionKey]: {} },
          config: { toolMode: "coding" },
        },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "decide" },
        { from: "decide", to: "end" },
      ],
    };

    const prompt = vi.fn(async () => ({ outcome: "success" as const }));
    const executor = new WorkflowGraphExecutor({
      handlers: { prompt },
      resolveNodeExecution,
      admitNodeExecution: (_node, task, _signal, _visitIdentity, execution) => {
        admitExecution = execution;
        admitNodeExecution(task, execution);
      },
      prepareNodeExecution: (_node, task, _requirement, _visitIdentity, execution) => {
        prepareExecution = execution;
        prepareNodeExecution(task, execution);
      },
      publishTaskProjection: async (taskId, _patch, source) => {
        projectedExecution = source.execution;
        publishTaskProjection(taskId, _patch, source);
      },
    });

    const result = await executor.run({ id: ORIGIN } as TaskDetail, settingsOn, workflow);

    expect(result.outcome).toBe("success");
    expect(resolveNodeExecution).toHaveBeenCalledTimes(1);
    expect(handle).toHaveBeenCalledTimes(1);
    expect(pluginInputTask?.id).toBe(SEMANTIC);
    expect(prompt).toHaveBeenCalledTimes(0);
    expect(admitNodeExecution).toHaveBeenCalledTimes(1);
    expect(prepareNodeExecution).toHaveBeenCalledTimes(1);
    expect(admitNodeExecution.mock.calls[0]?.[0]?.id).toBe(SEMANTIC);
    expect(prepareNodeExecution.mock.calls[0]?.[0]?.id).toBe(SEMANTIC);
    expect(publishTaskProjection).toHaveBeenCalledWith(SEMANTIC, expect.any(Object), expect.objectContaining({ execution: expect.any(Object) }));
    expect(publishTaskProjection.mock.calls[0]?.[1]).toMatchObject({
      modifiedFiles: ["src/semantic-output.ts"],
    });
    expect(projectedExecution).toBe(admitExecution);
    expect(projectedExecution).toBe(prepareExecution);
  });

  it("rejects opaque host posture before plugin/default handler when provider resolution is available", async () => {
    const extensionKey = workflowExtensionRegistryId("node-plugin", "decision");
    const handle = vi.fn().mockRejectedValue(new Error("provider required"));
    const prompt = vi.fn(async () => ({ outcome: "success" as const }));
    const resolveNodeProviderController = vi.fn(async () => providerController());
    const prepareNodeExecution = vi.fn();

    getWorkflowExtensionRegistry().register("node-plugin", {
      extensionId: "decision",
      name: "Decision",
      kind: "node-handler",
      nodeKind: "prompt",
      schemaVersion: WORKFLOW_EXTENSION_SCHEMA_VERSION,
      fallback: "degradeToDefault",
      handle,
    }, undefined, { providerPosture: "opaque" });

    const workflow: WorkflowIr = {
      version: "v2",
      name: "node-extension-opaque-refusal",
      columns: [{ id: "work", name: "Work", traits: [] }],
      nodes: [
        { id: "start", kind: "start" },
        { id: "decide", kind: "prompt", column: "work", config: { toolMode: "coding" }, extensions: { [extensionKey]: {} } },
        { id: "default", kind: "end" },
      ],
      edges: [
        { from: "start", to: "decide" },
        { from: "decide", to: "default" },
      ],
    };

    const executor = new WorkflowGraphExecutor({
      handlers: { prompt },
      resolveNodeProviderController,
      prepareNodeExecution,
    });

    const result = await executor.run({ id: "FN-NODE" } as TaskDetail, settingsOn, workflow);

    expect(result.outcome).toBe("failure");
    expect(handle).toHaveBeenCalledTimes(0);
    expect(prompt).toHaveBeenCalledTimes(0);
    expect(getWorkflowExtensionRegistry().get(extensionKey)?.degraded).toBeUndefined();
    expect(resolveNodeProviderController).toHaveBeenCalledTimes(0);
    expect(prepareNodeExecution).toHaveBeenCalledTimes(0);
    expect(result.visitedNodeIds).toEqual(["start", "decide"]);
  });

  it("passes through no-provider posture without controller and without provider-controller resolution", async () => {
    const extensionKey = workflowExtensionRegistryId("node-plugin", "decision");
    const resolveNodeProviderController = vi.fn(async () => providerController());
    let hasProviderController: boolean | undefined;
    let providerControllerValue: unknown;
    const handle = vi.fn(async (input: WorkflowNodeHandlerInput) => {
      hasProviderController = Object.hasOwn(input, "providerController");
      providerControllerValue = input.providerController;
      return { outcome: "success" as const };
    });
    const prompt = vi.fn(async () => ({ outcome: "success" as const }));

    getWorkflowExtensionRegistry().register("node-plugin", {
      extensionId: "decision",
      name: "Decision",
      kind: "node-handler",
      nodeKind: "prompt",
      schemaVersion: WORKFLOW_EXTENSION_SCHEMA_VERSION,
      fallback: "degradeToDefault",
      handle,
    }, undefined, { providerPosture: "no-provider" });

    const workflow: WorkflowIr = {
      version: "v2",
      name: "node-extension-no-provider",
      columns: [{ id: "work", name: "Work", traits: [] }],
      nodes: [
        { id: "start", kind: "start" },
        { id: "decide", kind: "prompt", column: "work", extensions: { [extensionKey]: {} } },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "decide" },
        { from: "decide", to: "end" },
      ],
    };

    const executor = new WorkflowGraphExecutor({
      handlers: { prompt },
      resolveNodeProviderController,
    });

    const result = await executor.run({ id: "FN-NODE" } as TaskDetail, settingsOn, workflow);

    expect(result.outcome).toBe("success");
    expect(handle).toHaveBeenCalledTimes(1);
    expect(hasProviderController).toBe(false);
    expect(providerControllerValue).toBeUndefined();
    expect(resolveNodeProviderController).toHaveBeenCalledTimes(0);
    expect(prompt).toHaveBeenCalledTimes(0);
  });

  it("passes scoped provider controller through to plugin input", async () => {
    const extensionKey = workflowExtensionRegistryId("node-plugin", "decision");
    const controller = providerController();
    const resolveNodeProviderController = vi.fn(async () => controller);
    let receivedController: WorkflowNodeProviderController | undefined;
    const handle = vi.fn(async (input: WorkflowNodeHandlerInput) => {
      receivedController = input.providerController;
      return { outcome: "success" as const };
    });
    const prompt = vi.fn(async () => ({ outcome: "success" as const }));

    getWorkflowExtensionRegistry().register("node-plugin", {
      extensionId: "decision",
      name: "Decision",
      kind: "node-handler",
      nodeKind: "prompt",
      schemaVersion: WORKFLOW_EXTENSION_SCHEMA_VERSION,
      fallback: "degradeToDefault",
      handle,
    }, undefined, { providerPosture: "scoped-provider" });

    const workflow: WorkflowIr = {
      version: "v2",
      name: "node-extension-scoped-provider",
      columns: [{ id: "work", name: "Work", traits: [] }],
      nodes: [
        { id: "start", kind: "start" },
        { id: "decide", kind: "prompt", column: "work", extensions: { [extensionKey]: {} } },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "decide" },
        { from: "decide", to: "end" },
      ],
    };

    const executor = new WorkflowGraphExecutor({
      handlers: { prompt },
      resolveNodeProviderController,
    });

    const result = await executor.run({ id: "FN-NODE" } as TaskDetail, settingsOn, workflow);

    expect(result.outcome).toBe("success");
    expect(resolveNodeProviderController).toHaveBeenCalledTimes(1);
    expect(handle).toHaveBeenCalledTimes(1);
    expect(receivedController).toBe(controller);
    expect(prompt).toHaveBeenCalledTimes(0);
  });

  it("fails closed when scoped-provider resolver returns undefined", async () => {
    const extensionKey = workflowExtensionRegistryId("node-plugin", "decision");
    const resolveNodeProviderController = vi.fn(async () => undefined);
    const handle = vi.fn(async () => ({ outcome: "success" as const }));
    const prompt = vi.fn(async () => ({ outcome: "success" as const }));
    const prepareNodeExecution = vi.fn();

    getWorkflowExtensionRegistry().register("node-plugin", {
      extensionId: "decision",
      name: "Decision",
      kind: "node-handler",
      nodeKind: "prompt",
      schemaVersion: WORKFLOW_EXTENSION_SCHEMA_VERSION,
      fallback: "degradeToDefault",
      handle,
    }, undefined, { providerPosture: "scoped-provider" });

    const workflow: WorkflowIr = {
      version: "v2",
      name: "node-extension-scoped-provider-missing",
      columns: [{ id: "work", name: "Work", traits: [] }],
      nodes: [
        { id: "start", kind: "start" },
        { id: "decide", kind: "prompt", column: "work", config: { toolMode: "coding" }, extensions: { [extensionKey]: {} } },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "decide" },
        { from: "decide", to: "end" },
      ],
    };

    const executor = new WorkflowGraphExecutor({
      handlers: { prompt },
      resolveNodeProviderController,
      prepareNodeExecution,
    });

    const result = await executor.run({ id: "FN-NODE" } as TaskDetail, settingsOn, workflow);

    expect(result.outcome).toBe("failure");
    expect(resolveNodeProviderController).toHaveBeenCalledTimes(1);
    expect(prepareNodeExecution).toHaveBeenCalledTimes(0);
    expect(handle).toHaveBeenCalledTimes(0);
    expect(prompt).toHaveBeenCalledTimes(0);
  });

  it("fails closed when scoped-provider resolver returns malformed controller", async () => {
    const extensionKey = workflowExtensionRegistryId("node-plugin", "decision");
    const resolveNodeProviderController = vi.fn(async () => ({ preDispatch: true }));
    const handle = vi.fn(async () => ({ outcome: "success" as const }));
    const prompt = vi.fn(async () => ({ outcome: "success" as const }));
    const prepareNodeExecution = vi.fn();

    getWorkflowExtensionRegistry().register("node-plugin", {
      extensionId: "decision",
      name: "Decision",
      kind: "node-handler",
      nodeKind: "prompt",
      schemaVersion: WORKFLOW_EXTENSION_SCHEMA_VERSION,
      fallback: "degradeToDefault",
      handle,
    }, undefined, { providerPosture: "scoped-provider" });

    const workflow: WorkflowIr = {
      version: "v2",
      name: "node-extension-scoped-provider-malformed",
      columns: [{ id: "work", name: "Work", traits: [] }],
      nodes: [
        { id: "start", kind: "start" },
        { id: "decide", kind: "prompt", column: "work", config: { toolMode: "coding" }, extensions: { [extensionKey]: {} } },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "decide" },
        { from: "decide", to: "end" },
      ],
    };

    const executor = new WorkflowGraphExecutor({
      handlers: { prompt },
      resolveNodeProviderController,
      prepareNodeExecution,
    });

    const result = await executor.run({ id: "FN-NODE" } as TaskDetail, settingsOn, workflow);

    expect(result.outcome).toBe("failure");
    expect(resolveNodeProviderController).toHaveBeenCalledTimes(1);
    expect(prepareNodeExecution).toHaveBeenCalledTimes(0);
    expect(handle).toHaveBeenCalledTimes(0);
    expect(prompt).toHaveBeenCalledTimes(0);
  });
});
