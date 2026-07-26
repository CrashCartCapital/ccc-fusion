import { describe, expect, it, vi } from "vitest";
import type { Settings, TaskDetail, WorkflowColumnAgent, WorkflowIrNode } from "@fusion/core";

import type { WorkflowNodeExecutionContext } from "../workflow-graph-executor.js";
import { WorkflowCustomNodeExecutionService } from "../workflow-custom-node-execution.js";

describe("WorkflowCustomNodeExecutionService", () => {
  it("adapts a custom-node executor into the graph runner contract with column binding", async () => {
    const binding = { agentId: "agent-reviewer", mode: "override" } as WorkflowColumnAgent;
    const execute = vi.fn(async () => ({ outcome: "success" as const, value: "ran" }));
    const service = new WorkflowCustomNodeExecutionService({
      execute,
      resolveColumnBinding: (nodeId) => (nodeId === "review-node" ? binding : undefined),
    });
    const settings = { experimentalFeatures: { workflowGraphExecutor: true } } as Settings;
    const node = { id: "review-node", kind: "prompt", config: { prompt: "review" } } as WorkflowIrNode;
    const task = { id: "FN-7301" } as TaskDetail;
    const context = { "workflow:optionalGroupActive": "review-node" };

    const result = await service.runner(settings)(node, task, context);

    expect(result).toEqual({ outcome: "success", value: "ran" });
    expect(execute).toHaveBeenCalledWith(node, task, settings, binding, context);
  });

  it("forwards sealed workflow execution context to cli-agent custom runner", async () => {
    const execute = vi.fn(async () => ({ outcome: "success" as const, value: "ran" }));
    const service = new WorkflowCustomNodeExecutionService({ execute });

    const settings = { experimentalFeatures: { workflowGraphExecutor: true } } as Settings;
    const node = { id: "cli-task", kind: "prompt", config: { prompt: "run" } } as WorkflowIrNode;
    const task = { id: "FN-7302" } as TaskDetail;
    const context = { "workflow:optionalGroupActive": "cli-task" };

    const semanticTask = { id: "FN-7302-semantics", description: "semantic" } as TaskDetail;
    const visitIdentity = Object.freeze({
      nodeId: "cli-task",
      materializedNodeId: "cli-task",
      foreachNodeId: "foreach-cli",
      stepIndex: 2,
      instanceId: "inst-cli",
      reworkPass: 0,
      loopNodeId: "loop-cli",
      iteration: 1,
      optionalGroupNodeId: "og-cli",
    });

    const executionFence = Object.freeze({
      workItemId: "w-item-001",
      attempt: 2,
      runId: "run-cli-001",
    });
    const nativeCliBinding = Object.freeze({ bindingKind: "native-cli-seam" });

    const sealedContext = Object.freeze({
      task,
      settings: undefined,
      context,
      execution: Object.freeze({
        originTaskId: "FN-7302",
        semanticTaskId: semanticTask.id,
        semanticTask,
        runId: "run-cli-001",
        visitIdentity,
        executionFence,
        providerAttemptTurnKey: "ccc-cli-turn-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      }),
      nativeCliBinding,
      signal: undefined,
    } as WorkflowNodeExecutionContext & {
      nativeCliBinding: { bindingKind: string };
    });

    const result = await service.runner(settings)(node, task, context, sealedContext);

    expect(result).toEqual({ outcome: "success", value: "ran" });
    expect(execute).toHaveBeenCalledWith(
      node,
      task,
      settings,
      undefined,
      context,
      sealedContext,
    );
  });
});
