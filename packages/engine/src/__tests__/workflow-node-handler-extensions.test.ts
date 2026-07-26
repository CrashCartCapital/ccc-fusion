// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WORKFLOW_EXTENSION_SCHEMA_VERSION,
  __resetWorkflowExtensionRegistryForTests,
  getWorkflowExtensionRegistry,
  workflowExtensionRegistryId,
  type TaskDetail,
  type WorkflowIr,
} from "@fusion/core";
import { WorkflowGraphExecutor } from "../workflow-graph-executor.js";

const settingsOn = { experimentalFeatures: { workflowGraphExecutor: true } };

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
});
