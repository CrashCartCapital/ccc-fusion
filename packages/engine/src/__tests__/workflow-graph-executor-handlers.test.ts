import { describe, expect, it, vi } from "vitest";
import { BUILTIN_CODING_WORKFLOW_IR } from "@fusion/core";
import type { TaskDetail, WorkflowIr } from "@fusion/core";
import { PermanentError, TransientError } from "../engine-errors.js";

import { WorkflowGraphExecutor, type WorkflowGraphExecutorDeps } from "../workflow-graph-executor.js";

const task = { id: "FN-5767" } as TaskDetail;

function settingsOn() {
  return { experimentalFeatures: { workflowGraphExecutor: true } };
}

describe("WorkflowGraphExecutor traversal", () => {
  it("classifies an imported PRD task's permanent failure", async () => {
    const ir: WorkflowIr = {
      version: "v1",
      name: "imported-prd-permanent-failure",
      nodes: [
        { id: "start", kind: "start" },
        { id: "execute", kind: "script" },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "execute" },
        { from: "execute", to: "end", condition: "success" },
      ],
    };
    const executor = new WorkflowGraphExecutor({
      handlers: {
        script: async () => {
          throw new PermanentError(
            "Live execution requires explicit approval.",
            "CCC_CAMPAIGN_LIVE_EXECUTION_APPROVAL_REQUIRED",
          );
        },
      },
    });

    const result = await executor.run({
      id: "FN-IMPORTED",
      lineageId: "ccc-prd:0123456789abcdef01234567:TASK-1",
    } as TaskDetail, settingsOn(), ir);

    expect(result).toMatchObject({
      outcome: "failure",
      context: {
        "ccc:retry-classification":
          "ccc-permanent:CCC_CAMPAIGN_LIVE_EXECUTION_APPROVAL_REQUIRED",
      },
    });
  });

  it("runs pre-node admission before preparation and the handler, excluding start/end", async () => {
    const ir: WorkflowIr = {
      version: "v1",
      name: "pre-node-admission",
      nodes: [
        { id: "start", kind: "start" },
        { id: "a", kind: "script", config: { cccPrdTaskId: "TASK-A" } },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "a" },
        { from: "a", to: "end", condition: "success" },
      ],
    };
    const order: string[] = [];
    const executor = new WorkflowGraphExecutor({
      admitNodeExecution: async (node) => {
        order.push(`admit:${node.id}`);
      },
      prepareNodeExecution: async (node) => {
        order.push(`prepare:${node.id}`);
      },
      handlers: {
        script: async (node) => {
          order.push(`handler:${node.id}`);
          return { outcome: "success" };
        },
      },
    });

    await executor.run(task, settingsOn(), ir);

    expect(order).toEqual(["admit:a", "prepare:a", "handler:a"]);
  });

  it("walks linear graph", async () => {
    const ir: WorkflowIr = {
      version: "v1",
      name: "linear",
      nodes: [
        { id: "start", kind: "start" },
        { id: "a", kind: "prompt" },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "a" },
        { from: "a", to: "end", condition: "success" },
      ],
    };
    const handler = vi.fn(async () => ({ outcome: "success" as const }));
    const executor = new WorkflowGraphExecutor({ handlers: { prompt: handler } });

    const result = await executor.run(task, settingsOn(), ir);
    expect(result.outcome).toBe("success");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("routes failure edges", async () => {
    const ir: WorkflowIr = {
      version: "v1",
      name: "failure-route",
      nodes: [
        { id: "start", kind: "start" },
        { id: "a", kind: "prompt" },
        { id: "b", kind: "script" },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "a" },
        { from: "a", to: "b", condition: "failure" },
        { from: "b", to: "end", condition: "success" },
      ],
    };
    const executor = new WorkflowGraphExecutor({
      handlers: {
        prompt: async () => ({ outcome: "failure" }),
        script: async () => ({ outcome: "success" }),
      },
    });

    const result = await executor.run(task, settingsOn(), ir);
    expect(result.visitedNodeIds).toContain("b");
  });

  it("supports outcome:value conditions", async () => {
    const ir: WorkflowIr = {
      version: "v1",
      name: "outcome-value",
      nodes: [
        { id: "start", kind: "start" },
        { id: "a", kind: "prompt" },
        { id: "left", kind: "script" },
        { id: "right", kind: "script" },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "a" },
        { from: "a", to: "left", condition: "outcome:left" },
        { from: "a", to: "right", condition: "outcome:right" },
        { from: "left", to: "end" },
        { from: "right", to: "end" },
      ],
    };
    const script = vi.fn(async () => ({ outcome: "success" as const }));
    const executor = new WorkflowGraphExecutor({
      handlers: {
        prompt: async () => ({ outcome: "success", value: "right" }),
        script,
      },
    });

    const result = await executor.run(task, settingsOn(), ir);
    expect(result.visitedNodeIds).toContain("right");
    expect(result.visitedNodeIds).not.toContain("left");
  });

  it("leaves outcome unchanged when outcome:value does not match any edge", async () => {
    const ir: WorkflowIr = {
      version: "v1",
      name: "outcome-miss",
      nodes: [
        { id: "start", kind: "start" },
        { id: "a", kind: "prompt" },
        { id: "left", kind: "script" },
        { id: "right", kind: "script" },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "a" },
        { from: "a", to: "left", condition: "outcome:left" },
        { from: "a", to: "right", condition: "outcome:right" },
      ],
    };

    const executor = new WorkflowGraphExecutor({ handlers: { prompt: async () => ({ outcome: "success", value: "miss" }) } });
    const result = await executor.run(task, settingsOn(), ir);
    expect(result.outcome).toBe("success");
    expect(result.visitedNodeIds).not.toContain("left");
    expect(result.visitedNodeIds).not.toContain("right");
  });

  it("publishes workflow node task projections for dispatcher and UI", async () => {
    const ir: WorkflowIr = {
      version: "v1",
      name: "projection",
      nodes: [
        { id: "start", kind: "start" },
        { id: "a", kind: "prompt" },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "a" },
        { from: "a", to: "end", condition: "success" },
      ],
    };
    const publishTaskProjection = vi.fn();
    const executor = new WorkflowGraphExecutor({
      handlers: {
        prompt: async () => ({
          outcome: "success",
          contextPatch: {
            touchedFiles: ["./packages/engine/src/workflow-graph-executor.ts", "packages\\core\\src\\store.ts"],
            filesChanged: 2,
            summary: "workflow published task metadata",
          },
        }),
      },
      publishTaskProjection,
    });

    await executor.run(task, settingsOn(), ir);

    expect(publishTaskProjection).toHaveBeenCalledWith(
      task.id,
      {
        modifiedFiles: ["packages/core/src/store.ts", "packages/engine/src/workflow-graph-executor.ts"],
        mergeDetails: { filesChanged: 2 },
        summary: "workflow published task metadata",
      },
      { nodeId: "a", nodeKind: "prompt" },
    );
  });

  it("keeps projection writes to safe task metadata fields", async () => {
    const ir: WorkflowIr = {
      version: "v1",
      name: "safe-projection",
      nodes: [
        { id: "start", kind: "start" },
        { id: "a", kind: "prompt" },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "a" },
        { from: "a", to: "end", condition: "success" },
      ],
    };
    const publishTaskProjection = vi.fn();
    const executor = new WorkflowGraphExecutor({
      handlers: {
        prompt: async () => ({
          outcome: "success",
          contextPatch: {
            modifiedFiles: ["src/index.ts"],
            mergeDetails: {
              commitSha: "engine-owned",
              mergeConfirmed: true,
              filesChanged: 3,
              insertions: 12.8,
              deletions: 1,
            },
            status: "done",
            error: "bypass",
            review: {},
            reviewState: {},
            workflowStepResults: [{}],
            tokenUsage: {},
          },
        }),
      },
      publishTaskProjection,
    });

    await executor.run(task, settingsOn(), ir);

    expect(publishTaskProjection).toHaveBeenCalledWith(
      task.id,
      {
        modifiedFiles: ["src/index.ts"],
        mergeDetails: { filesChanged: 3, insertions: 12, deletions: 1 },
      },
      { nodeId: "a", nodeKind: "prompt" },
    );
  });

  it("publishes projections from loop template nodes", async () => {
    const ir: WorkflowIr = {
      version: "v2",
      name: "loop-projection",
      columns: [
        { id: "todo", name: "Todo", traits: [] },
        { id: "done", name: "Done", traits: [{ trait: "complete" }] },
      ],
      nodes: [
        { id: "start", kind: "start", column: "todo" },
        {
          id: "loop",
          kind: "loop",
          column: "todo",
          config: {
            maxIterations: 1,
            exitWhen: { type: "output-contains", value: "done" },
            template: {
              nodes: [{ id: "inner", kind: "prompt" }],
              edges: [],
            },
          },
        },
        { id: "end", kind: "end", column: "done" },
      ],
      edges: [
        { from: "start", to: "loop" },
        { from: "loop", to: "end", condition: "success" },
      ],
    };
    const publishTaskProjection = vi.fn();
    const executor = new WorkflowGraphExecutor({
      handlers: {
        prompt: async () => ({
          outcome: "success",
          value: "done",
          contextPatch: { modifiedFiles: ["src/from-loop.ts"] },
        }),
      },
      publishTaskProjection,
    });

    await executor.run(task, settingsOn(), ir);

    expect(publishTaskProjection).toHaveBeenCalledWith(
      task.id,
      { modifiedFiles: ["src/from-loop.ts"] },
      { nodeId: "inner", nodeKind: "prompt" },
    );
  });

  it("passes materialized visit identity to foreach template handlers", async () => {
    const ir: WorkflowIr = {
      version: "v2",
      name: "foreach-visit-identity",
      nodes: [
        { id: "start", kind: "start" },
        {
          id: "each-step",
          kind: "foreach",
          config: {
            source: "task-steps",
            template: {
              nodes: [{ id: "do-step", kind: "script" }],
              edges: [],
            },
          },
        },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "each-step" },
        { from: "each-step", to: "end", condition: "success" },
      ],
    };
    const admittedVisitIdentities: unknown[] = [];
    const preparedVisitIdentities: unknown[] = [];
    const handledVisitIdentities: unknown[] = [];
    const executor = new WorkflowGraphExecutor({
      admitNodeExecution: (async (_node, _task, _signal, visitIdentity?: unknown) => {
        admittedVisitIdentities.push(visitIdentity);
      }) as unknown as WorkflowGraphExecutorDeps["admitNodeExecution"],
      prepareNodeExecution: (async (_node, _task, _requirement, visitIdentity?: unknown) => {
        preparedVisitIdentities.push(visitIdentity);
      }) as unknown as WorkflowGraphExecutorDeps["prepareNodeExecution"],
      getTaskSteps: () => [{ name: "Do step", status: "pending" }],
      handlers: {
        script: async (_node, ctx) => {
          handledVisitIdentities.push((ctx as { visitIdentity?: unknown }).visitIdentity);
          return { outcome: "success" };
        },
      },
    });

    await executor.run(task, settingsOn(), ir);

    const expectedIdentity = expect.objectContaining({
      nodeId: "do-step",
      foreachNodeId: "each-step",
      stepIndex: 0,
      instanceId: "each-step#0",
      materializedNodeId: "each-step#0:do-step",
      reworkPass: 0,
    });
    expect.soft(admittedVisitIdentities).toEqual([expectedIdentity]);
    expect.soft(preparedVisitIdentities).toEqual([expectedIdentity]);
    expect.soft(handledVisitIdentities).toEqual([
      expect.objectContaining({
        nodeId: "do-step",
        foreachNodeId: "each-step",
        stepIndex: 0,
        instanceId: "each-step#0",
        materializedNodeId: "each-step#0:do-step",
        reworkPass: 0,
      }),
    ]);
  });

  it("reuses the same foreach visit identity across a transient handler retry", async () => {
    const ir: WorkflowIr = {
      version: "v2",
      name: "foreach-visit-identity-retry",
      nodes: [
        { id: "start", kind: "start" },
        {
          id: "each-step",
          kind: "foreach",
          config: {
            source: "task-steps",
            template: {
              nodes: [{ id: "do-step", kind: "script" }],
              edges: [],
            },
          },
        },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "each-step" },
        { from: "each-step", to: "end", condition: "success" },
      ],
    };
    const admittedVisitIdentities: unknown[] = [];
    const preparedVisitIdentities: unknown[] = [];
    const handledVisitIdentities: unknown[] = [];
    let attempts = 0;
    const executor = new WorkflowGraphExecutor({
      maxRetriesPerNode: 2,
      admitNodeExecution: (async (_node, _task, _signal, visitIdentity?: unknown) => {
        admittedVisitIdentities.push(visitIdentity);
      }) as unknown as WorkflowGraphExecutorDeps["admitNodeExecution"],
      prepareNodeExecution: (async (_node, _task, _requirement, visitIdentity?: unknown) => {
        preparedVisitIdentities.push(visitIdentity);
      }) as unknown as WorkflowGraphExecutorDeps["prepareNodeExecution"],
      getTaskSteps: () => [{ name: "Do step", status: "pending" }],
      handlers: {
        script: async (_node, ctx) => {
          handledVisitIdentities.push((ctx as { visitIdentity?: unknown }).visitIdentity);
          attempts += 1;
          if (attempts === 1) {
            throw new TransientError("provider blip", "CCC_TRANSIENT");
          }
          return { outcome: "success" };
        },
      },
    });

    await executor.run(task, settingsOn(), ir);

    const expectedIdentity = expect.objectContaining({
      nodeId: "do-step",
      foreachNodeId: "each-step",
      stepIndex: 0,
      instanceId: "each-step#0",
      materializedNodeId: "each-step#0:do-step",
      reworkPass: 0,
    });
    expect.soft(admittedVisitIdentities).toHaveLength(1);
    expect.soft(preparedVisitIdentities).toHaveLength(2);
    expect.soft(handledVisitIdentities).toHaveLength(2);
    expect.soft(handledVisitIdentities[0]).toEqual(expectedIdentity);
    expect.soft(handledVisitIdentities[1]).toEqual(expectedIdentity);
    expect.soft(handledVisitIdentities[0]).toBe(handledVisitIdentities[1]);
    expect.soft(Object.isFrozen(handledVisitIdentities[0])).toBe(true);
    expect.soft(admittedVisitIdentities[0]).toBe(handledVisitIdentities[0]);
    expect.soft(preparedVisitIdentities[0]).toBe(handledVisitIdentities[0]);
    expect.soft(preparedVisitIdentities[1]).toBe(handledVisitIdentities[0]);
    expect.soft(attempts).toBe(2);
  });

  it("Task 4 RED: resolves top-level semantic execution into a sealed admission context", async () => {
    const ORIGIN = "ORIGIN";
    const SEMANTIC = "SEMANTIC";
    const runId = "RUN-TASK-4-RED";
    const originTask = { ...task, id: ORIGIN } as TaskDetail;
    const semanticTask = { ...task, id: SEMANTIC } as TaskDetail;
    const resolveNodeExecution = vi.fn(async (_input: unknown) => {
      return {
        semanticTask,
        originTaskId: "forged-origin",
        runId: "forged-run",
        visitIdentity: {
          nodeId: "forged-node",
          materializedNodeId: "forged-node",
        },
      };
    });
    const admissions: unknown[] = [];
    const preparations: unknown[] = [];
    const handlerExecutions: unknown[] = [];
    const admissionTaskIds: string[] = [];
    const preparationTaskIds: string[] = [];
    const handlerContextTaskIds: string[] = [];
    const progressTaskIds: string[] = [];
    const projectionTaskIds: string[] = [];
    const projectionSources: unknown[] = [];
    const projectionPatches: unknown[] = [];
    const resolveVisitIdentities: unknown[] = [];
    const resolveInputs: Array<{
      nodeId: string;
      runId: string;
      visitIdentity: unknown;
      originTaskId: string;
    }> = [];

    const ir: WorkflowIr = {
      version: "v1",
      name: "top-level-semantics-red",
      nodes: [
        { id: "start", kind: "start" },
        {
          id: "a",
          kind: "prompt",
          config: {
            toolMode: "coding",
            skillName: "compound-engineering:ce-plan",
            cccPrdTaskId: SEMANTIC,
          },
        },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "a" },
        { from: "a", to: "end", condition: "success" },
      ],
    };

    let attempts = 0;
    const executor = new WorkflowGraphExecutor({
      runId,
      maxRetriesPerNode: 2,
      resolveNodeExecution: (async (input: unknown) => {
        const typedInput = input as {
          node: { id: string };
          originTask: { id: string };
          runId: string;
          visitIdentity: { nodeId: string; materializedNodeId: string };
        };
        resolveInputs.push({
          nodeId: typedInput.node.id,
          runId: typedInput.runId,
          visitIdentity: typedInput.visitIdentity,
          originTaskId: typedInput.originTask.id,
        });
        resolveVisitIdentities.push(typedInput.visitIdentity);
        return resolveNodeExecution();
      }) as unknown,
      admitNodeExecution: (async (
        _node,
        taskArg,
        _signal,
        _visitIdentity,
        resolvedExecution,
      ) => {
        admissions.push(resolvedExecution);
        admissionTaskIds.push((taskArg as { id: string }).id);
      }) as unknown as WorkflowGraphExecutorDeps["admitNodeExecution"],
      prepareNodeExecution: (async (
        _node,
        taskArg,
        _requirement,
        _visitIdentity,
        resolvedExecution,
      ) => {
        preparations.push(resolvedExecution);
        preparationTaskIds.push((taskArg as { id: string }).id);
      }) as unknown as WorkflowGraphExecutorDeps["prepareNodeExecution"],
      recordWorkflowStepResult: vi.fn(async (_taskId) => {
        progressTaskIds.push(_taskId);
      }),
      handlers: {
        prompt: async (_node, ctx) => {
          attempts += 1;
          const execution = (ctx as { execution?: unknown }).execution;
          handlerExecutions.push(execution);
          handlerContextTaskIds.push((ctx as { task?: { id: string } }).task?.id as string);
          expect((ctx as { originTask?: unknown }).originTask).toBeUndefined();
          if (attempts === 1) {
            throw new TransientError("provider down", "CCC_TRANSIENT");
          }
          return {
            outcome: "success",
            contextPatch: { modifiedFiles: ["src/graph-output.ts"] },
          };
        },
      },
      publishTaskProjection: vi.fn(async (_taskId, patch, source) => {
        projectionPatches.push(patch as Record<string, unknown>);
        projectionSources.push(source);
        projectionTaskIds.push(_taskId);
      }),
    } as unknown as WorkflowGraphExecutorDeps);

    const result = await executor.run(originTask, settingsOn(), ir);
    const expectedExecution = admissions[0] as {
      originTaskId?: string;
      semanticTaskId?: string;
      semanticTask?: unknown;
      runId?: string;
      visitIdentity?: unknown;
    };

    expect(result.outcome).toBe("success");
    expect(resolveNodeExecution).toHaveBeenCalledTimes(1);
    expect(resolveInputs).toEqual([
      {
        nodeId: "a",
        runId,
        visitIdentity: expect.objectContaining({
          nodeId: "a",
          materializedNodeId: "a",
        }),
        originTaskId: ORIGIN,
      },
    ]);
    expect(admissions).toHaveLength(1);
    expect(preparations).toHaveLength(2);
    expect(handlerExecutions).toHaveLength(2);
    expect(progressTaskIds).toEqual([SEMANTIC, SEMANTIC, SEMANTIC]);
    expect(projectionPatches).toHaveLength(1);
    expect(projectionSources).toHaveLength(1);
    expect(projectionTaskIds).toEqual([SEMANTIC]);
    expect(admissionTaskIds).toEqual([SEMANTIC]);
    expect(preparationTaskIds).toEqual([SEMANTIC, SEMANTIC]);
    expect(handlerContextTaskIds).toEqual([SEMANTIC, SEMANTIC]);
    expect.soft(expectedExecution?.originTaskId).toBe(ORIGIN);
    expect.soft(expectedExecution?.semanticTaskId).toBe(SEMANTIC);
    expect.soft(expectedExecution?.runId).toBe(runId);
    expect.soft(Object.isFrozen(expectedExecution?.visitIdentity)).toBe(true);
    expect.soft((expectedExecution as { semanticTask?: unknown }).semanticTask).not.toBe(semanticTask);
    expect.soft((expectedExecution as { semanticTask?: unknown }).semanticTask).toEqual(semanticTask);
    expect.soft(resolveVisitIdentities[0]).toBe(expectedExecution?.visitIdentity);
    expect(admissions[0]).toBe(expectedExecution);
    expect(preparations[0]).toBe(expectedExecution);
    expect(preparations[1]).toBe(expectedExecution);
    expect(handlerExecutions[0]).toBe(expectedExecution);
    expect(handlerExecutions[1]).toBe(expectedExecution);
    expect.soft((projectionSources[0] as { execution?: unknown }).execution).toBe(expectedExecution);
    expect.soft(Object.isFrozen(expectedExecution as object)).toBe(true);
  });

  it("Task 4 RED: seals top-level semantic task identity from handler mutation", async () => {
    const ORIGIN = "ORIGIN";
    const SEMANTIC = "SEMANTIC";
    const runId = "RUN-TASK-4-SEAL";
    const originTask = { ...task, id: ORIGIN } as TaskDetail;
    const semanticTask = { ...task, id: SEMANTIC } as TaskDetail;
    const resolveNodeExecution = vi.fn(async () => ({ semanticTask }));
    const publishTaskIds: string[] = [];
    const publishedExecution: unknown[] = [];

    let handlerTask: TaskDetail | undefined;
    let handlerTaskSnapshot: TaskDetail | undefined;
    let execution: unknown;
    let reflectSetResult: boolean | undefined;

    const ir: WorkflowIr = {
      version: "v1",
      name: "top-level-semantics-red-seal",
      nodes: [
        { id: "start", kind: "start" },
        {
          id: "a",
          kind: "prompt",
          config: {
            toolMode: "coding",
            skillName: "compound-engineering:ce-plan",
            cccPrdTaskId: SEMANTIC,
          },
        },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "a" },
        { from: "a", to: "end", condition: "success" },
      ],
    };

    const executor = new WorkflowGraphExecutor({
      runId,
      maxRetriesPerNode: 1,
      resolveNodeExecution: (async () => resolveNodeExecution()) as unknown,
      admitNodeExecution: async (_node, _task, _signal, _visitIdentity, resolvedExecution) => {
        expect((resolvedExecution as { task: unknown } | undefined)?.task).toBeUndefined();
      },
      prepareNodeExecution: async (_node, _task, _requirement, _visitIdentity, resolvedExecution) => {
        expect((resolvedExecution as { task: unknown } | undefined)?.task).toBeUndefined();
      },
      handlers: {
        prompt: async (_node, ctx) => {
          handlerTask = (ctx as { task: TaskDetail }).task;
          handlerTaskSnapshot = { ...handlerTask } as TaskDetail;
          execution = (ctx as { execution: unknown }).execution;
          reflectSetResult = Reflect.set(handlerTask, "id", "DRIFT");
          return {
            outcome: "success",
            contextPatch: { modifiedFiles: ["src/graph-output.ts"] },
          };
        },
      },
      publishTaskProjection: async (taskId, _patch, source) => {
        publishTaskIds.push(taskId);
        publishedExecution.push((source as { execution?: unknown }).execution);
      },
      recordWorkflowStepResult: async () => {
        return Promise.resolve();
      },
    } as unknown as WorkflowGraphExecutorDeps);

    const result = await executor.run(originTask, settingsOn(), ir);

    expect(result.outcome).toBe("success");
    expect(resolveNodeExecution).toHaveBeenCalledTimes(1);
    expect(reflectSetResult).toBe(false);
    expect((handlerTask as { semanticTaskId?: unknown }).semanticTaskId).toBeUndefined();
    expect(semanticTask.id).toBe(SEMANTIC);
    expect(handlerTask).not.toBe(semanticTask);
    expect(handlerTaskSnapshot).toEqual(semanticTask);
    expect(execution).toBe(publishedExecution[0]);
    expect((execution as { semanticTask: TaskDetail }).semanticTask).toBe(handlerTask);
    expect((execution as { semanticTaskId: string }).semanticTaskId).toBe(SEMANTIC);
    expect(publishTaskIds).toEqual([SEMANTIC]);
  });



  it("Task 4 RED: seals one provider turn identity across a handler retry", async () => {
    const runAttempt = async (attempt: number) => {
      const executionFence = Object.freeze({
        workItemId: "WORK-TURN-1",
        attempt,
        runId: "ccc-prd:turn-1",
      });

      const originTask = { ...task, id: "FN-ONE" } as TaskDetail;
      const capturedExecutions: unknown[] = [];
      let calls = 0;

      const executor = new WorkflowGraphExecutor({
        runId: executionFence.runId,
        maxRetriesPerNode: 2,
        executionFence,
        resolveNodeExecution: (async () => {
          return { semanticTask: { ...task, id: "TASK-TURN-1" } as TaskDetail };
        }) as WorkflowGraphExecutorDeps["resolveNodeExecution"],
        handlers: {
          prompt: async (_node, ctx) => {
            capturedExecutions.push((ctx as { execution: unknown }).execution);
            calls += 1;
            if (calls === 1) {
              throw new TransientError("retry");
            }
            return { outcome: "success" };
          },
        },
      } as unknown as WorkflowGraphExecutorDeps);

      const ir: WorkflowIr = {
        version: "v1",
        name: "provider-turn-red",
        nodes: [
          { id: "start", kind: "start" },
          { id: "prompt", kind: "prompt", config: { cccPrdTaskId: "TASK-TURN-1" } },
          { id: "end", kind: "end" },
        ],
        edges: [
          { from: "start", to: "prompt", condition: "success" },
          { from: "prompt", to: "end", condition: "success" },
        ],
      };

      return {
        attempt,
        executionFence,
        result: await executor.run(originTask, settingsOn(), ir),
        capturedExecutions,
      };
    };

    const first = await runAttempt(2);
    const second = await runAttempt(3);

    expect(first.result.outcome).toBe("success");
    expect(second.result.outcome).toBe("success");

    expect(first.capturedExecutions).toHaveLength(2);
    expect(second.capturedExecutions).toHaveLength(2);

    const firstAttemptExecutionOne = first.capturedExecutions[0] as {
      executionFence: typeof first.executionFence;
      providerAttemptTurnKey?: string;
    };
    const firstAttemptExecutionTwo = first.capturedExecutions[1] as {
      executionFence: typeof first.executionFence;
      providerAttemptTurnKey?: string;
    };
    const secondAttemptExecutionOne = second.capturedExecutions[0] as {
      executionFence: typeof second.executionFence;
      providerAttemptTurnKey?: string;
    };

    expect(firstAttemptExecutionOne).toBe(firstAttemptExecutionTwo);
    expect(Object.isFrozen(firstAttemptExecutionOne)).toBe(true);
    expect(Object.isFrozen(firstAttemptExecutionOne.executionFence)).toBe(true);
    expect(firstAttemptExecutionOne.executionFence).toBe(first.executionFence);

    expect(firstAttemptExecutionOne.providerAttemptTurnKey).toMatch(/^ccc-cli-turn-[a-f0-9]{64}$/);
    expect(firstAttemptExecutionTwo.providerAttemptTurnKey).toMatch(/^ccc-cli-turn-[a-f0-9]{64}$/);
    expect(firstAttemptExecutionOne.providerAttemptTurnKey).not.toBe(secondAttemptExecutionOne.providerAttemptTurnKey);
  });

  it("Task 4 RED: refuses an explicitly malformed provider execution fence before effects", async () => {
    const resolveNodeExecution = vi.fn(async () => ({ semanticTask: { ...task, id: "SEMANTIC" } }));
    const prepareNodeExecution = vi.fn();
    const handler = vi.fn(async () => ({ outcome: "success" as const }));
    const ir: WorkflowIr = {
      version: "v1",
      name: "malformed-fence-red",
      nodes: [
        { id: "start", kind: "start" },
        { id: "prompt", kind: "prompt", config: { cccPrdTaskId: "SEMANTIC" } },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "prompt", condition: "success" },
        { from: "prompt", to: "end", condition: "success" },
      ],
    };
    const executor = new WorkflowGraphExecutor({
      runId: "ccc-prd:malformed-fence",
      resolveNodeExecution: resolveNodeExecution as unknown as WorkflowGraphExecutorDeps["resolveNodeExecution"],
      prepareNodeExecution: prepareNodeExecution as unknown as WorkflowGraphExecutorDeps["prepareNodeExecution"],
      handlers: {
        prompt: handler,
      },
      executionFence: null as unknown as WorkflowGraphExecutorDeps["executionFence"],
    } as unknown as WorkflowGraphExecutorDeps);

    await expect(executor.run(task, settingsOn(), ir)).rejects.toThrowError(
      /WORKFLOW_EXECUTION_FENCE_REFUSED|execution fence/i,
    );
    expect(resolveNodeExecution).toHaveBeenCalledTimes(0);
    expect(prepareNodeExecution).toHaveBeenCalledTimes(0);
    expect(handler).toHaveBeenCalledTimes(0);
  });

  it.each([
    ["undefined output", undefined],
    ["empty object", {}],
    ["blank semanticTask id", { semanticTask: { id: "" } }],
    ["whitespace semanticTask id", { semanticTask: { id: " SEMANTIC " } }],
  ])("Task 4: rejects non-canonical semantic task outputs (%s)", async (_label, resolverResult) => {
    const SEMANTIC = "SEMANTIC";
    const runId = "RUN-TASK-4-INVALID";
    const originTask = { ...task, id: "ORIGIN" } as TaskDetail;
    const resolveNodeExecution = vi.fn(async () => resolverResult);
    const admitNodeExecution = vi.fn();
    const prepareNodeExecution = vi.fn();
    const handler = vi.fn();
    const recordWorkflowStepResult = vi.fn();
    const publishTaskProjection = vi.fn();

    const ir: WorkflowIr = {
      version: "v1",
      name: "top-level-semantics-red-invalid",
      nodes: [
        { id: "start", kind: "start" },
        {
          id: "a",
          kind: "prompt",
          config: {
            toolMode: "coding",
            skillName: "compound-engineering:ce-plan",
            cccPrdTaskId: SEMANTIC,
          },
        },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "a" },
        { from: "a", to: "end", condition: "success" },
      ],
    };

    const executor = new WorkflowGraphExecutor({
      runId,
      resolveNodeExecution: (async () => resolveNodeExecution()) as unknown,
      admitNodeExecution: admitNodeExecution as unknown as WorkflowGraphExecutorDeps["admitNodeExecution"],
      prepareNodeExecution:
        prepareNodeExecution as unknown as WorkflowGraphExecutorDeps["prepareNodeExecution"],
      handlers: {
        prompt: handler,
      },
      recordWorkflowStepResult: recordWorkflowStepResult as unknown as WorkflowGraphExecutorDeps["recordWorkflowStepResult"],
      publishTaskProjection: publishTaskProjection as unknown as WorkflowGraphExecutorDeps["publishTaskProjection"],
    } as unknown as WorkflowGraphExecutorDeps);

    await expect(executor.run(originTask, settingsOn(), ir)).rejects.toThrowError(
      "resolved a task without a canonical native id",
    );
    expect(resolveNodeExecution).toHaveBeenCalledTimes(1);
    expect(admitNodeExecution).toHaveBeenCalledTimes(0);
    expect(prepareNodeExecution).toHaveBeenCalledTimes(0);
    expect(handler).toHaveBeenCalledTimes(0);
    expect(recordWorkflowStepResult).toHaveBeenCalledTimes(0);
    expect(publishTaskProjection).toHaveBeenCalledTimes(0);
  });

  it("Task 4 RED: skips semantic resolver when abort signal is pre-cancelled", async () => {
    const SEMANTIC = "SEMANTIC";
    const runId = "RUN-TASK-4-ABORT";
    const originTask = { ...task, id: "ORIGIN" } as TaskDetail;
    const resolveNodeExecution = vi.fn(async () => ({ semanticTask: { ...task, id: SEMANTIC } }));
    const admitNodeExecution = vi.fn();
    const prepareNodeExecution = vi.fn();
    const handler = vi.fn();
    const recordWorkflowStepResult = vi.fn();
    const publishTaskProjection = vi.fn();

    const abortController = new AbortController();
    abortController.abort();

    const ir: WorkflowIr = {
      version: "v1",
      name: "top-level-semantics-red-abort",
      nodes: [
        { id: "start", kind: "start" },
        {
          id: "a",
          kind: "prompt",
          config: {
            toolMode: "coding",
            skillName: "compound-engineering:ce-plan",
            cccPrdTaskId: SEMANTIC,
          },
        },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "a" },
        { from: "a", to: "end", condition: "success" },
      ],
    };

    const executor = new WorkflowGraphExecutor({
      runId,
      signal: abortController.signal,
      resolveNodeExecution: (async () => resolveNodeExecution()) as unknown,
      admitNodeExecution: admitNodeExecution as unknown as WorkflowGraphExecutorDeps["admitNodeExecution"],
      prepareNodeExecution:
        prepareNodeExecution as unknown as WorkflowGraphExecutorDeps["prepareNodeExecution"],
      handlers: {
        prompt: handler,
      },
      recordWorkflowStepResult: recordWorkflowStepResult as unknown as WorkflowGraphExecutorDeps["recordWorkflowStepResult"],
      publishTaskProjection: publishTaskProjection as unknown as WorkflowGraphExecutorDeps["publishTaskProjection"],
    } as unknown as WorkflowGraphExecutorDeps);

    const result = await executor.run(originTask, settingsOn(), ir);
    expect(result.outcome).toBe("failure");
    expect(result.context["node:a:value"]).toBe("aborted");
    expect(resolveNodeExecution).toHaveBeenCalledTimes(0);
    expect(admitNodeExecution).toHaveBeenCalledTimes(0);
    expect(prepareNodeExecution).toHaveBeenCalledTimes(0);
    expect(handler).toHaveBeenCalledTimes(0);
    expect(recordWorkflowStepResult).toHaveBeenCalledTimes(0);
    expect(publishTaskProjection).toHaveBeenCalledTimes(0);
  });

  it("Task 4 RED: preserves origin provenance against resolver task mutation", async () => {
    const ORIGIN = "ORIGIN";
    const SEMANTIC = "SEMANTIC";
    const originTask = {
      ...task,
      id: ORIGIN,
      customFields: { marker: "original" },
    } as TaskDetail;
    const resolveNodeExecution = vi.fn(async (input: unknown) => {
      const typedInput = input as {
        originTask: {
          id: string;
          execution?: unknown;
          customFields?: { marker: string };
        };
      };
      originTaskFrozen = Object.isFrozen(typedInput.originTask);
      originTaskCustomFieldsFrozen = Object.isFrozen(typedInput.originTask.customFields ?? {});
      originTaskCustomFieldsMutation = Reflect.set(
        typedInput.originTask.customFields,
        "marker",
        "FORGED",
      );
      reflectSetResult = Reflect.set(typedInput.originTask, "id", "FORGED");
      resolverInputOriginTask = typedInput.originTask as TaskDetail;
      return { semanticTask: { ...task, id: SEMANTIC } };
    });
    const admitNodeExecution = vi.fn();
    const prepareNodeExecution = vi.fn();
    const handler = vi.fn(async (_node, ctx) => {
      execution = (ctx as { execution: unknown }).execution;
      return {
        outcome: "success",
        contextPatch: { modifiedFiles: ["src/graph-output.ts"] },
      };
    });
    const recordWorkflowStepResult = vi.fn();
    const publishTaskProjection = vi.fn();

    let resolverInputOriginTask: TaskDetail | undefined;
    let originTaskFrozen = false;
    let originTaskCustomFieldsFrozen = false;
    let originTaskCustomFieldsMutation = false;
    let reflectSetResult: boolean | undefined;
    let execution: unknown;

    const ir: WorkflowIr = {
      version: "v1",
      name: "top-level-semantics-origin-provenance-red",
      nodes: [
        { id: "start", kind: "start" },
        {
          id: "a",
          kind: "prompt",
          config: {
            toolMode: "coding",
            skillName: "compound-engineering:ce-plan",
            cccPrdTaskId: SEMANTIC,
          },
        },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "a" },
        { from: "a", to: "end", condition: "success" },
      ],
    };

    const executor = new WorkflowGraphExecutor({
      resolveNodeExecution: (async (input) => resolveNodeExecution(input)) as unknown,
      admitNodeExecution: admitNodeExecution as unknown as WorkflowGraphExecutorDeps["admitNodeExecution"],
      prepareNodeExecution: prepareNodeExecution as unknown as WorkflowGraphExecutorDeps["prepareNodeExecution"],
      handlers: {
        prompt: handler,
      },
      recordWorkflowStepResult: recordWorkflowStepResult as unknown as WorkflowGraphExecutorDeps["recordWorkflowStepResult"],
      publishTaskProjection: publishTaskProjection as unknown as WorkflowGraphExecutorDeps["publishTaskProjection"],
    } as unknown as WorkflowGraphExecutorDeps);

    const result = await executor.run(originTask, settingsOn(), ir);

    expect(result.outcome).toBe("success");
    expect(resolveNodeExecution).toHaveBeenCalledTimes(1);
    expect(originTask.id).toBe(ORIGIN);
    expect(resolverInputOriginTask).not.toBe(originTask);
    expect.soft(resolverInputOriginTask).toEqual(originTask);
    expect(originTaskFrozen).toBe(true);
    expect(originTaskCustomFieldsFrozen).toBe(true);
    expect(originTaskCustomFieldsMutation).toBe(false);
    expect(reflectSetResult).toBe(false);
    expect.soft((resolverInputOriginTask as { execution?: unknown }).execution).toBeUndefined();
    expect(originTask.customFields).toEqual({ marker: "original" });
    expect.soft(((execution as { semanticTaskId?: unknown }).semanticTaskId)).toBe(SEMANTIC);
    expect.soft((execution as { semanticTask?: unknown }).semanticTask).toBeDefined();
    expect.soft((execution as { originTaskId?: unknown }).originTaskId).toBe(ORIGIN);
    expect.soft((execution as { runId?: unknown }).runId).toBe("ORIGIN:run");
    expect(publishTaskProjection).toHaveBeenCalledTimes(1);
    expect(admitNodeExecution).toHaveBeenCalledTimes(1);
    expect(prepareNodeExecution).toHaveBeenCalledTimes(1);
    expect(recordWorkflowStepResult).toHaveBeenCalledTimes(2);
    expect(admitNodeExecution.mock.calls[0]?.[1]?.id).toBe(SEMANTIC);
    expect(prepareNodeExecution.mock.calls[0]?.[1]?.id).toBe(SEMANTIC);
    expect(publishTaskProjection.mock.calls[0]?.[0]).toBe(SEMANTIC);
  });

  it("Task 4 RED: resolveNodeExecution receives an immutable node snapshot", async () => {
    const ORIGIN = "ORIGIN";
    const SEMANTIC = "SEMANTIC";
    const originTask = { ...task, id: ORIGIN } as TaskDetail;
    const resolveNodeExecution = vi.fn(async (input: unknown) => {
      const typedInput = input as {
        node: {
          id: string;
          kind: string;
          config?: { extensions?: { provenance: string } };
        };
        visitIdentity: unknown;
      };
      inputNodeFrozen = Object.isFrozen(typedInput.node);
      inputConfigFrozen = Object.isFrozen(typedInput.node.config ?? {});
      inputExtensionsFrozen = Object.isFrozen(typedInput.node.config?.extensions ?? {});
      resolverInputNode = {
        id: typedInput.node.id,
        kind: typedInput.node.kind,
        config: typedInput.node.config ? { extensions: { ...typedInput.node.config.extensions } } : undefined,
      };
      nodeIdMutation = Reflect.set(typedInput.node, "id", "MUTATED");
      if (typedInput.node.config?.extensions) {
        extensionMutation = Reflect.set(typedInput.node.config.extensions, "forged", "yes");
      }
      resolveVisitIdentities.push(typedInput.visitIdentity);
      return { semanticTask: { ...task, id: SEMANTIC } };
    }) as unknown as WorkflowGraphExecutorDeps["resolveNodeExecution"];
    const admitNodeExecution = vi.fn();
    const prepareNodeExecution = vi.fn();
    const publishTaskProjection = vi.fn();
    const resolveVisitIdentities: unknown[] = [];
    const projectedSources: unknown[] = [];
    const handlerNodes: Array<{ id: string; kind: string; extensions?: { provenance: string } }> = [];
    let inputNodeFrozen = false;
    let inputConfigFrozen = false;
    let inputExtensionsFrozen = false;
    let resolverInputNode: { id: string; kind: string; config?: { extensions?: { provenance: string } } } | undefined;
    let nodeIdMutation = false;
    let extensionMutation = false;

    const ir: WorkflowIr = {
      version: "v1",
      name: "top-level-semantics-red-immutable-node",
      nodes: [
        { id: "start", kind: "start" },
        {
          id: "a",
          kind: "prompt",
          config: {
            toolMode: "coding",
            skillName: "compound-engineering:ce-plan",
            cccPrdTaskId: SEMANTIC,
            extensions: { provenance: "prompt-node" },
          },
        },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "a" },
        { from: "a", to: "end", condition: "success" },
      ],
    };

    const executor = new WorkflowGraphExecutor({
      runId: "RUN-TASK-4-IMMUTABLE",
      resolveNodeExecution,
      admitNodeExecution: admitNodeExecution as unknown as WorkflowGraphExecutorDeps["admitNodeExecution"],
      prepareNodeExecution:
        prepareNodeExecution as unknown as WorkflowGraphExecutorDeps["prepareNodeExecution"],
      handlers: {
        prompt: async (node) => {
          handlerNodes.push({
            id: node.id,
            kind: node.kind,
            extensions: node.config ? { ...(node.config as { extensions?: { provenance: string } }).extensions! } : undefined,
          });
          return {
            outcome: "success",
            contextPatch: { modifiedFiles: ["src/graph-output.ts"] },
          };
        },
      },
      publishTaskProjection: async (_taskId, _patch, source) => {
        publishTaskProjection();
        projectedSources.push(source);
      },
      publishTouchedFiles: vi.fn(),
    } as unknown as WorkflowGraphExecutorDeps);

    const result = await executor.run(originTask, settingsOn(), ir);

    expect(result.outcome).toBe("success");
    expect(resolveNodeExecution).toHaveBeenCalledTimes(1);
    expect(publishTaskProjection).toHaveBeenCalledTimes(1);
    expect(admitNodeExecution).toHaveBeenCalledTimes(1);
    expect(prepareNodeExecution).toHaveBeenCalledTimes(1);
    expect(handlerNodes).toEqual([{ id: "a", kind: "prompt", extensions: { provenance: "prompt-node" } }]);
    expect(resolveVisitIdentities).toHaveLength(1);
    expect((resolveVisitIdentities[0] as { nodeId: string; materializedNodeId: string }).nodeId).toBe("a");
    expect((resolveVisitIdentities[0] as { materializedNodeId: string }).materializedNodeId).toBe("a");
    expect((projectedSources[0] as { nodeId: string; nodeKind: string }).nodeId).toBe("a");
    expect((projectedSources[0] as { nodeId: string; nodeKind: string }).nodeKind).toBe("prompt");
    expect(resolverInputNode).toEqual({
      id: "a",
      kind: "prompt",
      config: { extensions: { provenance: "prompt-node" } },
    });
    expect(inputNodeFrozen).toBe(true);
    expect(inputConfigFrozen).toBe(true);
    expect(inputExtensionsFrozen).toBe(true);
    expect(nodeIdMutation).toBe(false);
    expect(extensionMutation).toBe(false);
  });

  it("Task 4 RED: publishTouchedFiles receives node metadata without execution", async () => {
    const SEMANTIC = "SEMANTIC";
    const originTask = { ...task, id: "ORIGIN" } as TaskDetail;
    const resolveNodeExecution = vi.fn(async () => ({ semanticTask: { ...task, id: SEMANTIC } }));
    const publishTouchedFiles = vi.fn();
    const publishTaskProjection = vi.fn();
    const publishTouchPayloads: Array<{ taskId: string; files: string[]; source: unknown }> = [];

    const ir: WorkflowIr = {
      version: "v1",
      name: "top-level-semantics-red-legacy-touch",
      nodes: [
        { id: "start", kind: "start" },
        {
          id: "a",
          kind: "prompt",
          config: {
            toolMode: "coding",
            skillName: "compound-engineering:ce-plan",
            cccPrdTaskId: SEMANTIC,
          },
        },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "a" },
        { from: "a", to: "end", condition: "success" },
      ],
    };

    const executor = new WorkflowGraphExecutor({
      runId: "RUN-TASK-4-LEGACY-TOUCH",
      resolveNodeExecution: resolveNodeExecution as unknown,
      handlers: {
        prompt: async () => ({
          outcome: "success",
          contextPatch: { modifiedFiles: ["src/top-level-touched.ts"] },
        }),
      },
      publishTaskProjection: publishTaskProjection as unknown as WorkflowGraphExecutorDeps["publishTaskProjection"],
      publishTouchedFiles: async (taskId, files, source) => {
        publishTouchedFiles(taskId, files, source);
        publishTouchPayloads.push({ taskId, files, source });
      },
    });

    const result = await executor.run(originTask, settingsOn(), ir);

    expect(result.outcome).toBe("success");
    expect(resolveNodeExecution).toHaveBeenCalledTimes(1);
    expect(publishTaskProjection).toHaveBeenCalledTimes(1);
    expect(publishTouchedFiles).toHaveBeenCalledTimes(1);
    expect(publishTaskProjection).toHaveBeenCalledWith(
      SEMANTIC,
      { modifiedFiles: ["src/top-level-touched.ts"] },
      expect.objectContaining({ nodeId: "a", nodeKind: "prompt", execution: expect.any(Object) }),
    );
    expect(publishTouchPayloads[0]).toEqual({
      taskId: SEMANTIC,
      files: ["src/top-level-touched.ts"],
      source: { nodeId: "a", nodeKind: "prompt" },
    });
  });

  it("increments foreach rework pass across a bounded rework loop", async () => {
    const ir: WorkflowIr = {
      version: "v2",
      name: "foreach-visit-identity-rework",
      nodes: [
        { id: "start", kind: "start" },
        {
          id: "each-step",
          kind: "foreach",
          config: {
            source: "task-steps",
            maxReworkCycles: 1,
            template: {
              nodes: [{ id: "do-step", kind: "script" }],
              edges: [{ from: "do-step", to: "do-step", kind: "rework", condition: "outcome:revise" }],
            },
          },
        },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "each-step" },
        { from: "each-step", to: "end", condition: "success" },
      ],
    };
    const handledVisitIdentities: unknown[] = [];
    let attempts = 0;
    const executor = new WorkflowGraphExecutor({
      getTaskSteps: () => [{ name: "Do step", status: "pending" }],
      handlers: {
        script: async (_node, ctx) => {
          handledVisitIdentities.push((ctx as { visitIdentity?: unknown }).visitIdentity);
          attempts += 1;
          if (attempts === 1) return { outcome: "success", value: "revise" };
          return { outcome: "success" };
        },
      },
    });

    await executor.run(task, settingsOn(), ir);

    expect.soft(handledVisitIdentities).toHaveLength(2);
    expect.soft(handledVisitIdentities[0]).toEqual(
      expect.objectContaining({
        nodeId: "do-step",
        foreachNodeId: "each-step",
        stepIndex: 0,
        instanceId: "each-step#0",
        materializedNodeId: "each-step#0:do-step",
        reworkPass: 0,
      }),
    );
    expect.soft(handledVisitIdentities[1]).toEqual(
      expect.objectContaining({
        nodeId: "do-step",
        foreachNodeId: "each-step",
        stepIndex: 0,
        instanceId: "each-step#0",
        materializedNodeId: "each-step#0:do-step",
        reworkPass: 1,
      }),
    );
    expect.soft(handledVisitIdentities[0]).not.toBe(handledVisitIdentities[1]);
    expect.soft(attempts).toBe(2);
  });

  it("passes materialized visit identity to loop template handlers", async () => {
    const ir: WorkflowIr = {
      version: "v2",
      name: "loop-visit-identity",
      nodes: [
        { id: "start", kind: "start" },
        {
          id: "wait-loop",
          kind: "loop",
          config: {
            maxIterations: 2,
            exitWhen: { type: "output-contains", value: "done" },
            template: {
              nodes: [{ id: "poll", kind: "script" }],
              edges: [],
            },
          },
        },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "wait-loop" },
        { from: "wait-loop", to: "end", condition: "success" },
      ],
    };
    const admittedVisitIdentities: unknown[] = [];
    const preparedVisitIdentities: unknown[] = [];
    const handledVisitIdentities: unknown[] = [];
    const executor = new WorkflowGraphExecutor({
      admitNodeExecution: (async (_node, _task, _signal, visitIdentity?: unknown) => {
        admittedVisitIdentities.push(visitIdentity);
      }) as unknown as WorkflowGraphExecutorDeps["admitNodeExecution"],
      prepareNodeExecution: (async (_node, _task, _requirement, visitIdentity?: unknown) => {
        preparedVisitIdentities.push(visitIdentity);
      }) as unknown as WorkflowGraphExecutorDeps["prepareNodeExecution"],
      handlers: {
        script: async (_node, ctx) => {
          handledVisitIdentities.push((ctx as { visitIdentity?: unknown }).visitIdentity);
          return { outcome: "success", value: "done" };
        },
      },
    });

    await executor.run(task, settingsOn(), ir);

    const expectedIdentity = expect.objectContaining({
      nodeId: "poll",
      loopNodeId: "wait-loop",
      iteration: 1,
      materializedNodeId: "wait-loop#1:poll",
    });
    expect.soft(admittedVisitIdentities).toEqual([expectedIdentity]);
    expect.soft(preparedVisitIdentities).toEqual([expectedIdentity]);
    expect.soft(handledVisitIdentities).toEqual([
      expect.objectContaining({
        nodeId: "poll",
        loopNodeId: "wait-loop",
        iteration: 1,
        materializedNodeId: "wait-loop#1:poll",
      }),
    ]);
  });

  it("does not retry an already-executed node when projection publishing fails", async () => {
    const ir: WorkflowIr = {
      version: "v1",
      name: "projection-failure",
      nodes: [
        { id: "start", kind: "start" },
        { id: "a", kind: "prompt" },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "a" },
        { from: "a", to: "end", condition: "failure" },
      ],
    };
    const handler = vi.fn(async () => ({
      outcome: "success" as const,
      contextPatch: { modifiedFiles: ["src/once.ts"] },
    }));
    const publishTaskProjection = vi.fn(async () => {
      throw new Error("store unavailable");
    });
    const executor = new WorkflowGraphExecutor({
      handlers: { prompt: handler },
      maxRetriesPerNode: 3,
      publishTaskProjection,
    });

    const result = await executor.run(task, settingsOn(), ir);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(publishTaskProjection).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe("failure");
    expect(result.context["node:a:projectionError"]).toBe("store unavailable");
  });

  it("does not fail the node when the deprecated touched-files hook fails", async () => {
    const ir: WorkflowIr = {
      version: "v1",
      name: "legacy-touched-files-failure",
      nodes: [
        { id: "start", kind: "start" },
        { id: "a", kind: "prompt" },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "a" },
        { from: "a", to: "end", condition: "success" },
      ],
    };
    const publishTaskProjection = vi.fn();
    const publishTouchedFiles = vi.fn(async () => {
      throw new Error("legacy sink unavailable");
    });
    const executor = new WorkflowGraphExecutor({
      handlers: {
        prompt: async () => ({
          outcome: "success",
          contextPatch: { modifiedFiles: ["src/projected.ts"] },
        }),
      },
      publishTaskProjection,
      publishTouchedFiles,
    });

    const result = await executor.run(task, settingsOn(), ir);

    expect(publishTaskProjection).toHaveBeenCalledTimes(1);
    expect(publishTouchedFiles).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe("success");
    expect(result.context["node:a:projectionError"]).toBeUndefined();
  });

  it("caps retries and converts exceptions to failure", async () => {
    const ir: WorkflowIr = {
      version: "v1",
      name: "retry",
      nodes: [
        { id: "start", kind: "start" },
        { id: "a", kind: "prompt" },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "a" },
        { from: "a", to: "end", condition: "failure" },
      ],
    };
    const handler = vi.fn(async () => {
      throw new Error("boom");
    });
    const executor = new WorkflowGraphExecutor({ handlers: { prompt: handler }, maxRetriesPerNode: 3 });

    const result = await executor.run(task, settingsOn(), ir);
    expect(handler).toHaveBeenCalledTimes(3);
    expect(result.outcome).toBe("failure");
  });

  it("fan-out executes deterministic sorted order", async () => {
    const ir: WorkflowIr = {
      version: "v1",
      name: "fanout",
      nodes: [
        { id: "start", kind: "start" },
        { id: "a", kind: "prompt" },
        { id: "b", kind: "script" },
        { id: "c", kind: "script" },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "a" },
        { from: "a", to: "c" },
        { from: "a", to: "b" },
        { from: "b", to: "end" },
        { from: "c", to: "end" },
      ],
    };
    const order: string[] = [];
    const executor = new WorkflowGraphExecutor({
      handlers: {
        prompt: async () => ({ outcome: "success" }),
        script: async (node) => {
          order.push(node.id);
          return { outcome: "success" };
        },
      },
    });
    await executor.run(task, settingsOn(), ir);
    expect(order).toEqual(["b", "c"]);
  });

  it("builtin coding workflow ir exposes expected lifecycle and merge-policy nodes", () => {
    expect(BUILTIN_CODING_WORKFLOW_IR.nodes.map((node) => node.id)).toEqual(
      expect.arrayContaining([
        "start",
        "execute",
        "review",
        "merge-gate",
        "branch-group-member-integration",
        "branch-group-promotion",
        "merge-attempt",
        "end",
      ]),
    );
  });

  it("rejects malformed cyclic graphs", async () => {
    const ir: WorkflowIr = {
      version: "v1",
      name: "cycle",
      nodes: [
        { id: "start", kind: "start" },
        { id: "a", kind: "prompt" },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "a" },
        { from: "a", to: "a" },
      ],
    };
    const executor = new WorkflowGraphExecutor({ handlers: { prompt: async () => ({ outcome: "success" }) } });

    await expect(executor.run(task, settingsOn(), ir)).rejects.toThrow("Cycle detected");
  });

  // FN-7579: ask-user (chat reach-out) + exit-gate (early termination) end-to-end
  // through the real registered handlers (no override), using deps.runCustomNode
  // exactly as the ask-user node is dispatched in production.
  describe("ask-user / exit-gate (FN-7579)", () => {
    it("ask-user node parks the task awaiting-user-input via the custom-node runner", async () => {
      const ir: WorkflowIr = {
        version: "v1",
        name: "ask-user",
        nodes: [
          { id: "start", kind: "start" },
          { id: "ask", kind: "ask-user", config: { question: "Looks good?" } },
          { id: "end", kind: "end" },
        ],
        edges: [
          { from: "start", to: "ask" },
          { from: "ask", to: "end", condition: "success" },
        ],
      };
      const runCustomNode = vi.fn(async () => ({ outcome: "failure" as const, value: "awaiting-user-input" }));
      const executor = new WorkflowGraphExecutor({ runCustomNode });

      const result = await executor.run(task, settingsOn(), ir);
      expect(runCustomNode).toHaveBeenCalledOnce();
      expect(runCustomNode.mock.calls[0][0]).toMatchObject({ id: "ask", kind: "ask-user" });
      expect(result.outcome).toBe("failure");
      expect(result.visitedNodeIds).not.toContain("end");
    });

    it("unconditional exit-gate terminates early, skipping downstream nodes", async () => {
      const ir: WorkflowIr = {
        version: "v1",
        name: "exit-gate-unconditional",
        nodes: [
          { id: "start", kind: "start" },
          { id: "exit", kind: "exit-gate" },
          { id: "never", kind: "prompt" },
          { id: "end", kind: "end" },
        ],
        edges: [
          { from: "start", to: "exit" },
          { from: "exit", to: "end", condition: "outcome:exit" },
          { from: "exit", to: "never", condition: "outcome:continue" },
        ],
      };
      const never = vi.fn(async () => ({ outcome: "success" as const }));
      const executor = new WorkflowGraphExecutor({ handlers: { prompt: never } });

      const result = await executor.run(task, settingsOn(), ir);
      expect(never).not.toHaveBeenCalled();
      expect(result.outcome).toBe("success");
      expect(result.visitedNodeIds).toContain("exit");
      expect(result.visitedNodeIds).not.toContain("never");
    });

    it("conditional exit-gate falls through to the next node when the condition does not match", async () => {
      const ir: WorkflowIr = {
        version: "v1",
        name: "exit-gate-conditional",
        nodes: [
          { id: "start", kind: "start" },
          { id: "exit", kind: "exit-gate", config: { condition: { type: "output-contains", nodeId: "ask", value: "looks good" } } },
          { id: "refine", kind: "prompt" },
          { id: "end", kind: "end" },
        ],
        edges: [
          { from: "start", to: "exit" },
          { from: "exit", to: "end", condition: "outcome:exit" },
          { from: "exit", to: "refine", condition: "outcome:continue" },
        ],
      };
      const refine = vi.fn(async () => ({ outcome: "success" as const }));
      const executor = new WorkflowGraphExecutor({
        handlers: { prompt: refine },
      });

      const result = await executor.run(task, settingsOn(), ir);
      expect(refine).toHaveBeenCalledOnce();
      expect(result.visitedNodeIds).toContain("refine");
    });

    it("conditional exit-gate exits early when the referenced context value matches", async () => {
      // Seed the ask-user answer via runCustomNode's contextPatch by running a
      // graph that first visits an ask-user node, then the exit-gate reads its
      // published `input:ask` context key.
      const irWithAsk: WorkflowIr = {
        version: "v1",
        name: "exit-gate-conditional-match-full",
        nodes: [
          { id: "start", kind: "start" },
          { id: "ask", kind: "ask-user", config: { question: "Anything to refine?" } },
          { id: "exit", kind: "exit-gate", config: { condition: { type: "output-contains", nodeId: "ask", value: "looks good" } } },
          { id: "refine", kind: "prompt" },
          { id: "end", kind: "end" },
        ],
        edges: [
          { from: "start", to: "ask" },
          { from: "ask", to: "exit", condition: "success" },
          { from: "exit", to: "end", condition: "outcome:exit" },
          { from: "exit", to: "refine", condition: "outcome:continue" },
        ],
      };
      const refine = vi.fn(async () => ({ outcome: "success" as const }));
      const runCustomNode = vi.fn(async () => ({
        outcome: "success" as const,
        contextPatch: { "input:ask": "yes, looks good to me" },
      }));
      const executor2 = new WorkflowGraphExecutor({ runCustomNode, handlers: { prompt: refine } });

      const result = await executor2.run(task, settingsOn(), irWithAsk);
      expect(refine).not.toHaveBeenCalled();
      expect(result.visitedNodeIds).toContain("exit");
      expect(result.visitedNodeIds).not.toContain("refine");
    });
  });
});
