// @vitest-environment node

import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WORKFLOW_EXTENSION_SCHEMA_VERSION,
  __resetWorkflowExtensionRegistryForTests,
  canonicalCccPrdJson,
  getWorkflowExtensionRegistry,
  workflowExtensionRegistryId,
  type CccCampaignProviderControllerDecision,
  type CccProviderAttemptReconciliation,
  type CccProviderAttemptScope,
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
    reconcile: vi.fn(async (_input: CccProviderAttemptReconciliation): Promise<CccProviderAttemptScope> => {
      throw new Error("Provider controller must not run in graph posture tests");
    }),
  });
}

function providerBinding(controller: WorkflowNodeProviderController, workflowExtensionId: string) {
  return Object.freeze({
    providerController: controller,
    providerRoute: Object.freeze({
      providerId: "claude",
      modelId: "claude-sonnet",
      transport: "workflow" as const,
      workflowExtensionId,
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
    }, undefined, { providerPosture: "no-provider" });
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
    }, undefined, { providerPosture: "no-provider" });
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
    }, undefined, { providerPosture: "no-provider" });
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

  it("passes through no-provider posture without provider capability and without provider-binding resolution", async () => {
    const extensionKey = workflowExtensionRegistryId("node-plugin", "decision");
    const resolveNodeProviderController = vi.fn(async () => providerController());
    let hasProviderController: boolean | undefined;
    let providerControllerValue: unknown;
    let hasProviderDispatch: boolean | undefined;
    let providerDispatchValue: unknown;
    const handle = vi.fn(async (input: WorkflowNodeHandlerInput) => {
      hasProviderController = Object.hasOwn(input, "providerController");
      providerControllerValue = input.providerController;
      hasProviderDispatch = Object.hasOwn(input, "providerDispatch");
      providerDispatchValue = input.providerDispatch;
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
    expect(hasProviderDispatch).toBe(false);
    expect(providerDispatchValue).toBeUndefined();
    expect(resolveNodeProviderController).toHaveBeenCalledTimes(0);
    expect(prompt).toHaveBeenCalledTimes(0);
  });

  it("passes each scoped extension a sealed provider dispatch rooted in one resolver binding", async () => {
    const firstExtensionKey = workflowExtensionRegistryId("node-plugin", "decision-one");
    const secondExtensionKey = workflowExtensionRegistryId("node-plugin", "decision-two");
    const controller = providerController();
    const resolveNodeProviderController = vi.fn(async (input) => providerBinding(controller, input.extensionId));
    const inputs: WorkflowNodeHandlerInput[] = [];
    const firstHandle = vi.fn(async (input: WorkflowNodeHandlerInput) => {
      inputs.push(input);
      return { outcome: "success" as const };
    });
    const secondHandle = vi.fn(async (input: WorkflowNodeHandlerInput) => {
      inputs.push(input);
      return { outcome: "success" as const };
    });
    const prompt = vi.fn(async () => ({ outcome: "success" as const }));

    getWorkflowExtensionRegistry().register("node-plugin", {
      extensionId: "decision-one",
      name: "Decision one",
      kind: "node-handler",
      nodeKind: "prompt",
      schemaVersion: WORKFLOW_EXTENSION_SCHEMA_VERSION,
      fallback: "degradeToDefault",
      handle: firstHandle,
    }, undefined, { providerPosture: "scoped-provider" });
    getWorkflowExtensionRegistry().register("node-plugin", {
      extensionId: "decision-two",
      name: "Decision two",
      kind: "node-handler",
      nodeKind: "prompt",
      schemaVersion: WORKFLOW_EXTENSION_SCHEMA_VERSION,
      fallback: "degradeToDefault",
      handle: secondHandle,
    }, undefined, { providerPosture: "scoped-provider" });

    const workflowFor = (extensionKey: string): WorkflowIr => ({
      version: "v2",
      name: "node-extension-scoped-provider",
      columns: [{ id: "work", name: "Work", traits: [] }],
      nodes: [
        { id: "start", kind: "start" },
        {
          id: "decide",
          kind: "prompt",
          column: "work",
          extensions: { [extensionKey]: {} },
        },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "decide" },
        { from: "decide", to: "end" },
      ],
    });

    const executor = new WorkflowGraphExecutor({
      handlers: { prompt },
      resolveNodeProviderController,
      runId: "run-provider-dispatch",
      executionFence: Object.freeze({
        workItemId: "work-item-provider-dispatch",
        attempt: 1,
        runId: "run-provider-dispatch",
      }),
    });

    const firstResult = await executor.run({ id: "FN-NODE" } as TaskDetail, settingsOn, workflowFor(firstExtensionKey));
    const secondResult = await executor.run({ id: "FN-NODE" } as TaskDetail, settingsOn, workflowFor(secondExtensionKey));

    expect(firstResult.outcome).toBe("success");
    expect(secondResult.outcome).toBe("success");
    expect(resolveNodeProviderController).toHaveBeenCalledTimes(2);
    expect(firstHandle).toHaveBeenCalledTimes(1);
    expect(secondHandle).toHaveBeenCalledTimes(1);
    expect(inputs).toHaveLength(2);
    expect(inputs[0]?.providerController).not.toBe(controller);
    expect(inputs[1]?.providerController).not.toBe(controller);
    expect(Object.isFrozen(inputs[0]?.providerController)).toBe(true);
    expect(Object.isFrozen(inputs[1]?.providerController)).toBe(true);
    expect(Object.isFrozen(inputs[0]?.providerDispatch)).toBe(true);
    expect(Object.isFrozen(inputs[1]?.providerDispatch)).toBe(true);
    expect(inputs[0]?.providerDispatch).toMatchObject({
      providerId: "claude",
      modelId: "claude-sonnet",
      transport: "workflow",
    });
    expect(inputs[0]?.providerDispatch?.turnKey).toBe(inputs[1]?.providerDispatch?.turnKey);
    expect(inputs[0]?.providerDispatch?.turnKey).toMatch(/^ccc-cli-turn-[a-f0-9]{64}$/);
    expect(inputs[0]?.providerDispatch?.dispatchKey).not.toBe(inputs[1]?.providerDispatch?.dispatchKey);
    expect(inputs[0]?.providerDispatch?.dispatchKey).toBe(
      `ccc-workflow-node-dispatch-${createHash("sha256")
        .update(canonicalCccPrdJson({
          schema: "ccc-workflow-node-dispatch",
          version: 1,
          nodeId: "decide",
          extensionId: firstExtensionKey,
        }), "utf8")
        .digest("hex")}`,
    );
    expect(prompt).toHaveBeenCalledTimes(0);
  });

  it("refuses forged scoped-provider dispatch before raw provider preDispatch", async () => {
    const extensionKey = workflowExtensionRegistryId("node-plugin", "decision");
    const rawPreDispatch = vi.fn(async (_input): Promise<CccCampaignProviderControllerDecision> => {
      throw new Error("raw provider preDispatch invoked");
    });
    const controller = Object.freeze({
      preDispatch: rawPreDispatch,
      reconcile: vi.fn(async (_input: CccProviderAttemptReconciliation): Promise<CccProviderAttemptScope> => {
        throw new Error("raw provider reconcile invoked");
      }),
    });
    const resolveNodeProviderController = vi.fn(async (input) => providerBinding(controller, input.extensionId));
    const handle = vi.fn(async (input: WorkflowNodeHandlerInput) => {
      expect(Object.isFrozen(input.providerDispatch)).toBe(true);
      expect(() => Object.assign(input.providerDispatch!, { dispatchKey: "ccc-forged-dispatch" })).toThrow();
      await input.providerController!.preDispatch({
        ...input.providerDispatch!,
        dispatchKey: "ccc-forged-dispatch",
      });
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
      name: "node-extension-scoped-provider-forged-dispatch",
      columns: [{ id: "work", name: "Work", traits: [] }],
      nodes: [
        { id: "start", kind: "start" },
        {
          id: "decide",
          kind: "prompt",
          column: "work",
          extensions: { [extensionKey]: {} },
        },
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
      runId: "run-provider-dispatch-forgery",
      executionFence: Object.freeze({
        workItemId: "work-item-provider-dispatch-forgery",
        attempt: 1,
        runId: "run-provider-dispatch-forgery",
      }),
    });

    const result = await executor.run({ id: "FN-NODE" } as TaskDetail, settingsOn, workflow);

    expect(result.outcome).toBe("failure");
    expect(result.context).toMatchObject({
      "node:decide:error": expect.stringContaining("does not match sealed provider dispatch"),
      "node:decide:extensionId": extensionKey,
    });
    expect(rawPreDispatch).toHaveBeenCalledTimes(0);
    expect(handle).toHaveBeenCalledTimes(1);
    expect(prompt).toHaveBeenCalledTimes(0);
  });

  it("delegates exact scoped-provider dispatch clones with the sealed descriptor", async () => {
    const extensionKey = workflowExtensionRegistryId("node-plugin", "decision");
    let sealedDispatchFromHandler: WorkflowNodeHandlerInput["providerDispatch"];
    const rawPreDispatch = vi.fn(async (_input): Promise<CccCampaignProviderControllerDecision> => Object.freeze({
      kind: "dispatch-permit",
      scope: Object.freeze({ state: "dispatched_unknown" }) as unknown as CccProviderAttemptScope,
    }));
    const controller = Object.freeze({
      preDispatch: rawPreDispatch,
      reconcile: vi.fn(async (_input: CccProviderAttemptReconciliation): Promise<CccProviderAttemptScope> => {
        throw new Error("raw provider reconcile invoked");
      }),
    });
    const resolveNodeProviderController = vi.fn(async (input) => providerBinding(controller, input.extensionId));
    const handle = vi.fn(async (input: WorkflowNodeHandlerInput) => {
      sealedDispatchFromHandler = input.providerDispatch;
      await input.providerController!.preDispatch({ ...input.providerDispatch! });
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
      name: "node-extension-scoped-provider-cloned-dispatch",
      columns: [{ id: "work", name: "Work", traits: [] }],
      nodes: [
        { id: "start", kind: "start" },
        {
          id: "decide",
          kind: "prompt",
          column: "work",
          extensions: { [extensionKey]: {} },
        },
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
      runId: "run-provider-dispatch-clone",
      executionFence: Object.freeze({
        workItemId: "work-item-provider-dispatch-clone",
        attempt: 1,
        runId: "run-provider-dispatch-clone",
      }),
    });

    const result = await executor.run({ id: "FN-NODE" } as TaskDetail, settingsOn, workflow);

    expect(result.outcome).toBe("success");
    expect(rawPreDispatch).toHaveBeenCalledTimes(1);
    expect(rawPreDispatch.mock.calls[0]?.[0]).toBe(sealedDispatchFromHandler);
    expect(handle).toHaveBeenCalledTimes(1);
    expect(prompt).toHaveBeenCalledTimes(0);
  });

  it("fails closed when a scoped-provider handler throws, without later scoped or default dispatch", async () => {
    const failingExtensionKey = workflowExtensionRegistryId("node-plugin", "failing-decision");
    const laterExtensionKey = workflowExtensionRegistryId("node-plugin", "later-decision");
    const controller = providerController();
    const resolveNodeProviderController = vi.fn(async (input) => providerBinding(controller, input.extensionId));
    const failingHandle = vi.fn(async () => {
      throw new Error("scoped provider failure");
    });
    const laterHandle = vi.fn(async () => ({ outcome: "success" as const }));
    const prompt = vi.fn(async () => ({ outcome: "success" as const }));

    getWorkflowExtensionRegistry().register("node-plugin", {
      extensionId: "failing-decision",
      name: "Failing decision",
      kind: "node-handler",
      nodeKind: "prompt",
      schemaVersion: WORKFLOW_EXTENSION_SCHEMA_VERSION,
      fallback: "degradeToDefault",
      handle: failingHandle,
    }, undefined, { providerPosture: "scoped-provider" });
    getWorkflowExtensionRegistry().register("node-plugin", {
      extensionId: "later-decision",
      name: "Later decision",
      kind: "node-handler",
      nodeKind: "prompt",
      schemaVersion: WORKFLOW_EXTENSION_SCHEMA_VERSION,
      fallback: "degradeToDefault",
      handle: laterHandle,
    }, undefined, { providerPosture: "scoped-provider" });

    const workflow: WorkflowIr = {
      version: "v2",
      name: "node-extension-scoped-provider-failure",
      columns: [{ id: "work", name: "Work", traits: [] }],
      nodes: [
        { id: "start", kind: "start" },
        {
          id: "decide",
          kind: "prompt",
          column: "work",
          extensions: {
            [failingExtensionKey]: {},
            [laterExtensionKey]: {},
          },
        },
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
      runId: "run-provider-dispatch-failure",
      executionFence: Object.freeze({
        workItemId: "work-item-provider-dispatch-failure",
        attempt: 1,
        runId: "run-provider-dispatch-failure",
      }),
    });

    const result = await executor.run({ id: "FN-NODE" } as TaskDetail, settingsOn, workflow);

    expect(result.outcome).toBe("failure");
    expect(failingHandle).toHaveBeenCalledTimes(1);
    expect(laterHandle).toHaveBeenCalledTimes(0);
    expect(prompt).toHaveBeenCalledTimes(0);
    expect(getWorkflowExtensionRegistry().get(failingExtensionKey)?.degraded).toBeUndefined();
  });

  it("fails closed before scoped or default dispatch when the provider-binding resolver seam is absent", async () => {
    const extensionKey = workflowExtensionRegistryId("node-plugin", "decision");
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
      name: "node-extension-scoped-provider-resolver-absent",
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
      prepareNodeExecution,
    });

    const result = await executor.run({ id: "FN-NODE" } as TaskDetail, settingsOn, workflow);

    expect(result.outcome).toBe("failure");
    expect(prepareNodeExecution).toHaveBeenCalledTimes(0);
    expect(handle).toHaveBeenCalledTimes(0);
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

  it("fails closed when scoped-provider resolver returns a malformed binding", async () => {
    const extensionKey = workflowExtensionRegistryId("node-plugin", "decision");
    const resolveNodeProviderController = vi.fn(async () => Object.freeze({ preDispatch: vi.fn() }));
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
