import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { canonicalCccPrdJson } from "@fusion/core";
import type {
  CccCampaignTaskContext,
  Settings,
  TaskDetail,
  WorkflowIr,
  WorkflowWorkItem,
  WorkflowWorkItemState,
} from "@fusion/core";

import { WorkflowTaskRuntime, type WorkflowTaskRuntimeDeps } from "../workflow-task-runtime.js";
import type { WorkflowNodeResult } from "../workflow-graph-executor.js";
import type { PreparedWorktree, WorkflowRuntimePrimitives } from "../runtime-primitives.js";
import { PermanentError } from "../engine-errors.js";

const task = { id: "FN-9002" } as TaskDetail;
const nativeSemanticTaskId = "FN-9003";
const flagOff = { experimentalFeatures: {} } as unknown as Pick<Settings, "experimentalFeatures">;
const promptWithOneStep = "# Task: FN-9002 - Runtime default\n\n## Steps\n\n### Step 1: Implement runtime default\n- Exercise the default workflow.\n";

const parseStepsDeps = {
  readArtifact: async (_task: TaskDetail, key: string) => key === "PROMPT.md" ? promptWithOneStep : undefined,
  writeSteps: async (target: TaskDetail, steps: TaskDetail["steps"]) => {
    target.steps = steps;
  },
};

function selectedIr(): WorkflowIr {
  return {
    version: "v1",
    name: "selected",
    nodes: [
      { id: "start", kind: "start" },
      { id: "prepare", kind: "prompt", config: { prompt: "prepare" } },
      { id: "execute", kind: "prompt", config: { seam: "execute" } },
      { id: "zend", kind: "end" },
    ],
    edges: [
      { from: "start", to: "prepare", condition: "success" },
      { from: "prepare", to: "execute", condition: "success" },
      { from: "execute", to: "zend", condition: "success" },
      { from: "execute", to: "zend", condition: "failure" },
    ],
  };
}

function selectedSemanticIr(): WorkflowIr {
  return {
    version: "v1",
    name: "selected-semantic",
    nodes: [
      { id: "start", kind: "start" },
      {
        id: "semantic",
        kind: "prompt",
        config: {
          cccPrdTaskId: "TASK-SEMANTIC",
          cccNativeTaskId: nativeSemanticTaskId,
        },
      },
      { id: "end", kind: "end" },
    ],
    edges: [
      { from: "start", to: "semantic", condition: "success" },
      { from: "semantic", to: "end", condition: "success" },
      { from: "semantic", to: "end", condition: "failure" },
    ],
  };
}

function workflowIrSha256(ir: WorkflowIr): string {
  return createHash("sha256")
    .update(canonicalCccPrdJson(ir), "utf8")
    .digest("hex");
}

function selectedProofSuiteIr(): WorkflowIr {
  return {
    version: "v1",
    name: "selected-proof-suite",
    nodes: [
      { id: "start", kind: "start" },
      {
        id: "proof-suite",
        kind: "gate",
        config: {
          cccProofSuite: true,
          cccProofIds: ["PROOF-1"],
          cccPrdTaskIds: [task.id],
          cccPrdTaskId: task.id,
        },
      },
      { id: "end", kind: "end" },
    ],
    edges: [
      { from: "start", to: "proof-suite", condition: "success" },
      { from: "proof-suite", to: "end", condition: "success" },
    ],
  };
}

function selectedFinalProofPhaseIr(): WorkflowIr {
  const ir = selectedProofSuiteIr();
  return {
    ...ir,
    version: "v2",
    columns: [],
    name: "selected-final-proof-phase",
    nodes: ir.nodes.map((node) => node.id === "proof-suite"
      ? {
        ...node,
        config: {
          ...node.config,
          cccProofPhase: "final_integrated",
        },
      }
      : node),
  };
}

function selectedTaskProofGateIr(): WorkflowIr {
  return {
    version: "v2",
    name: "selected-task-proof-gate",
    columns: [],
    nodes: [
      { id: "start", kind: "start" },
      { id: "implementation", kind: "prompt", config: { prompt: "implement" } },
      {
        id: "task-proof",
        kind: "gate",
        config: {
          cccProofGate: true,
          cccProofPhase: "task",
          cccProofIds: ["PROOF-1"],
          cccPrdTaskId: "TASK-1",
          cccNativeTaskId: task.id,
        },
      },
      { id: "downstream", kind: "prompt", config: { prompt: "dependent" } },
      { id: "end", kind: "end" },
    ],
    edges: [
      { from: "start", to: "implementation", condition: "success" },
      { from: "implementation", to: "task-proof", condition: "success" },
      { from: "task-proof", to: "downstream", condition: "success" },
      { from: "downstream", to: "end", condition: "success" },
    ],
  };
}

function campaignProofContext(
  taskId: string,
  semanticTaskId = taskId === nativeSemanticTaskId ? "TASK-SEMANTIC" : taskId,
): CccCampaignTaskContext {
  return {
    schema: "ccc-campaign.context.v1" as CccCampaignTaskContext["schema"],
    taskId,
    semanticTaskId,
    proofIds: [],
    proofs: [],
    admittedWriteRoots: [],
    protectedActions: [],
    requestCount: 0,
    activeActionLeases: {},
  } as unknown as CccCampaignTaskContext;
}

function recordingPrimitives(
  calls: string[],
  overrides: Partial<Record<"prepare" | "execute" | "workflowStep", WorkflowNodeResult>> & {
    prepareData?: PreparedWorktree | null;
  } = {},
  observed: {
    prepared?: PreparedWorktree;
    executedTasks?: TaskDetail[];
    stepTasks?: TaskDetail[];
    mergeAttempt?: number;
    mergeRunId?: string;
    mergeWorkflowId?: string;
  } = {},
): WorkflowRuntimePrimitives {
  const prepared: PreparedWorktree = { worktreePath: "/tmp/fusion-worktree" };
  return {
    prepareWorktree: async () => {
      calls.push("prepare-worktree");
      return {
        outcome: overrides.prepare?.outcome ?? "success",
        value: overrides.prepare?.value,
        contextPatch: overrides.prepare?.contextPatch,
        data: overrides.prepare?.outcome === "failure"
          ? undefined
          : overrides.prepareData === null
            ? undefined
            : overrides.prepareData ?? prepared,
      };
    },
    readArtifact: async (_ctx, _task, key) => key === "PROMPT.md" ? promptWithOneStep : undefined,
    writeArtifact: async (_ctx, _task, key) => ({ outcome: "success", data: { key } }),
    runPlanningSession: async () => {
      calls.push("planning");
      return { outcome: "success", data: { approved: true, artifactKeys: [] } };
    },
    runCodingSession: async (_ctx, _task, preparedWorktree) => {
      calls.push("execute");
      observed.prepared = preparedWorktree;
      observed.executedTasks?.push(_task);
      const override = overrides.execute;
      return {
        outcome: override?.outcome ?? "success",
        value: override?.value ?? "implemented",
        contextPatch: override?.contextPatch,
        data: { taskDone: override?.outcome !== "failure", modifiedFiles: [] },
      };
    },
    runTaskStep: async (_ctx, _task, stepIndex) => {
      calls.push(`step:${stepIndex}`);
      observed.stepTasks?.push(_task);
      observed.executedTasks?.push(_task);
      return { outcome: "success" };
    },
    resetTaskStep: async () => ({ ok: true }),
    runReview: async (_ctx, _task, input) => {
      calls.push(input.stepIndex === undefined ? "review" : "step-review");
      return {
        outcome: "success",
        value: input.stepIndex === undefined ? "in-review" : "approve",
        data: { verdict: "APPROVE" },
      };
    },
    runVerification: async () => ({ outcome: "success", data: { verdict: "skipped" } }),
    runWorkflowStep: async () => {
      calls.push("workflow-step");
      const override = overrides.workflowStep;
      return {
        outcome: override?.outcome ?? "success",
        value: override?.value ?? "workflow-steps-passed",
        contextPatch: override?.contextPatch,
        data: { allPassed: override?.value !== "remediation-scheduled" },
      };
    },
    updateSteps: async (_ctx, _task, steps) => {
      _task.steps = steps;
      return { outcome: "success", data: { count: steps.length } };
    },
    transitionTask: async () => {
      calls.push("schedule");
      return { outcome: "success" };
    },
    requestMerge: async (ctx) => {
      calls.push("merge");
      observed.mergeAttempt = ctx.node.attempt;
      observed.mergeRunId = ctx.run.runId;
      observed.mergeWorkflowId = ctx.run.workflowId;
      return { outcome: "success", value: "merged", data: { status: "merged" } };
    },
    abortRun: async () => ({ outcome: "success" }),
    audit: () => undefined,
  };
}

describe("WorkflowTaskRuntime", () => {
  it("requires execution wiring at the type boundary", () => {
    // @ts-expect-error WorkflowTaskRuntime is an execution entry point, so primitives are required.
    const missingPrimitives: WorkflowTaskRuntimeDeps = {
      store: {
        getTaskWorkflowSelection: () => undefined,
        getWorkflowDefinition: async () => undefined,
        getTaskDocument: async (_taskId, key) => key === "PROMPT.md" ? { key, content: promptWithOneStep } : null,
      },
      runCustomNode: async () => ({ outcome: "success" }),
    };
    expect(missingPrimitives).toBeDefined();
  });

  it("refuses a CCC proof-suite gate when its execution handler is unwired", async () => {
    const runtime = new WorkflowTaskRuntime({
      store: {
        getTaskWorkflowSelection: () => ({ workflowId: "WF-PROOF", stepIds: [] }),
        getWorkflowDefinition: async () => ({ ir: selectedProofSuiteIr() }),
      },
      primitives: recordingPrimitives([]),
      runCustomNode: async () => ({ outcome: "success" }),
    });

    const result = await runtime.run(task, flagOff, { deferCompletionSummary: true });

    expect(result).toMatchObject({
      disposition: "failed",
      outcome: "failure",
      context: {
        "node:proof-suite:value": "ccc-proof-suite-execution-unwired",
      },
    });
  });

  it("RED-S5-task-gate-release: refuses a CCC task-proof gate when its execution handler is unwired", async () => {
    const prompt = vi.fn(async () => ({ outcome: "success" as const }));
    const runtime = new WorkflowTaskRuntime({
      store: {
        getTaskWorkflowSelection: () => ({ workflowId: "WF-TASK-PROOF", stepIds: [] }),
        getWorkflowDefinition: async () => ({ ir: selectedTaskProofGateIr() }),
      },
      primitives: recordingPrimitives([]),
      runCustomNode: async () => ({ outcome: "success" }),
      handlers: { prompt },
    });

    const result = await runtime.run(task, flagOff, { deferCompletionSummary: true });

    expect(result).toMatchObject({
      disposition: "failed",
      outcome: "failure",
      context: {
        "node:task-proof:value": "ccc-proof-suite-execution-unwired",
      },
    });
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(prompt.mock.calls[0]![0]).toMatchObject({ id: "implementation" });
  });

  it("RED-S5-task-gate-release: does not invoke a dependent node until the task proof gate passes", async () => {
    let passTaskGate: ((result: WorkflowNodeResult) => void) | undefined;
    const taskGatePending = new Promise<WorkflowNodeResult>((resolve) => {
      passTaskGate = resolve;
    });
    const prompt = vi.fn(async () => ({ outcome: "success" as const }));
    const runCccProofSuite = vi.fn(() => taskGatePending);
    const runtime = new WorkflowTaskRuntime({
      store: {
        getTaskWorkflowSelection: () => ({ workflowId: "WF-TASK-PROOF", stepIds: [] }),
        getWorkflowDefinition: async () => ({ ir: selectedTaskProofGateIr() }),
      },
      primitives: recordingPrimitives([]),
      runCustomNode: async () => ({ outcome: "success" }),
      handlers: { prompt },
      runCccProofSuite,
    });

    const run = runtime.run(task, flagOff, { deferCompletionSummary: true });
    await vi.waitFor(() => expect(runCccProofSuite).toHaveBeenCalledTimes(1));
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(prompt.mock.calls[0]![0]).toMatchObject({ id: "implementation" });

    passTaskGate!({ outcome: "success" });
    await expect(run).resolves.toMatchObject({ disposition: "completed", outcome: "success" });
    expect(prompt).toHaveBeenCalledTimes(2);
    expect(prompt.mock.calls[1]![0]).toMatchObject({ id: "downstream" });
  });

  it("RED-S5-task-gate-release: task proof failure makes zero downstream calls", async () => {
    const prompt = vi.fn(async () => ({ outcome: "success" as const }));
    const runCccProofSuite = vi.fn(async () => ({
      outcome: "failure" as const,
      value: "task-proof-failed",
    }));
    const runtime = new WorkflowTaskRuntime({
      store: {
        getTaskWorkflowSelection: () => ({ workflowId: "WF-TASK-PROOF", stepIds: [] }),
        getWorkflowDefinition: async () => ({ ir: selectedTaskProofGateIr() }),
      },
      primitives: recordingPrimitives([]),
      runCustomNode: async () => ({ outcome: "success" }),
      handlers: { prompt },
      runCccProofSuite,
    });

    const result = await runtime.run(task, flagOff, { deferCompletionSummary: true });

    expect(result).toMatchObject({
      disposition: "failed",
      outcome: "failure",
      context: { "node:task-proof:value": "task-proof-failed" },
    });
    expect(runCccProofSuite).toHaveBeenCalledTimes(1);
    expect(runCccProofSuite.mock.calls[0]![0]).toMatchObject({
      config: {
        cccProofGate: true,
        cccProofPhase: "task",
        cccProofIds: ["PROOF-1"],
        cccPrdTaskId: "TASK-1",
        cccNativeTaskId: task.id,
      },
    });
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(prompt.mock.calls[0]![0]).toMatchObject({ id: "implementation" });
  });

  it("RED-S5-task-gate-release: dispatches a unified final proof-phase marker", async () => {
    const runCccProofSuite = vi.fn(async () => ({ outcome: "success" as const }));
    const runtime = new WorkflowTaskRuntime({
      store: {
        getTaskWorkflowSelection: () => ({ workflowId: "WF-FINAL-PROOF", stepIds: [] }),
        getWorkflowDefinition: async () => ({ ir: selectedFinalProofPhaseIr() }),
      },
      primitives: recordingPrimitives([]),
      runCustomNode: async () => ({ outcome: "success" }),
      runCccProofSuite,
    });

    await expect(runtime.run(task, flagOff, { deferCompletionSummary: true })).resolves.toMatchObject({
      disposition: "completed",
      outcome: "success",
    });
    expect(runCccProofSuite).toHaveBeenCalledTimes(1);
  });

  it("RED-S5-task-gate-release: dispatches a unified proof-phase marker without a legacy boolean", async () => {
    const ir = selectedFinalProofPhaseIr();
    const proofNode = ir.nodes.find((node) => node.id === "proof-suite")!;
    delete proofNode.config!.cccProofSuite;
    const runCccProofSuite = vi.fn(async () => ({ outcome: "success" as const }));
    const runtime = new WorkflowTaskRuntime({
      store: {
        getTaskWorkflowSelection: () => ({ workflowId: "WF-UNIFIED-PROOF", stepIds: [] }),
        getWorkflowDefinition: async () => ({ ir }),
      },
      primitives: recordingPrimitives([]),
      runCustomNode: async () => ({ outcome: "success" }),
      runCccProofSuite,
    });

    await expect(runtime.run(task, flagOff, { deferCompletionSummary: true })).resolves.toMatchObject({
      disposition: "completed",
      outcome: "success",
    });
    expect(runCccProofSuite).toHaveBeenCalledTimes(1);
  });

  it("parks an uncertain CCC proof-suite dispatch for manual reconciliation", async () => {
    const campaignTask = {
      ...task,
      customFields: { cccFusionProfile: "ccc-fusion" },
    } as TaskDetail;
    const runCccProofSuite = vi.fn(async () => {
      throw new PermanentError(
        "A previously dispatched proof command has no terminal receipt.",
        "CCC_CAMPAIGN_PROOF_DISPATCH_UNKNOWN",
      );
    });
    const runtime = new WorkflowTaskRuntime({
      store: {
        getTaskWorkflowSelection: () => ({ workflowId: "WF-PROOF", stepIds: [] }),
        getWorkflowDefinition: async () => ({ ir: selectedProofSuiteIr() }),
      },
      primitives: recordingPrimitives([]),
      runCustomNode: async () => ({ outcome: "success" }),
      runCccProofSuite,
    });

    const result = await runtime.run(campaignTask, flagOff, { deferCompletionSummary: true });

    expect(runCccProofSuite).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      disposition: "manual-required",
      outcome: "failure",
      reason: "ccc-permanent:CCC_CAMPAIGN_PROOF_DISPATCH_UNKNOWN",
      context: {
        "ccc:retry-classification": "ccc-permanent:CCC_CAMPAIGN_PROOF_DISPATCH_UNKNOWN",
      },
    });
  });

  it("runs a selected workflow through the graph engine", async () => {
    const calls: string[] = [];
    const observed: { prepared?: PreparedWorktree } = {};
    let workflowSelectionReads = 0;
    const runtime = new WorkflowTaskRuntime({
      store: {
        getTaskWorkflowSelection: () => {
          workflowSelectionReads += 1;
          return { workflowId: "WF-001", stepIds: [] };
        },
        getWorkflowDefinition: async () => ({ ir: selectedIr() }),
      },
      primitives: recordingPrimitives(
        calls,
        {
          prepare: { outcome: "success", contextPatch: { preparedKey: "from-prepare" } },
          execute: { outcome: "success", contextPatch: { executeKey: "from-execute" } },
        },
        observed,
      ),
      runCustomNode: async (node) => {
        calls.push(`custom:${node.id}`);
        return { outcome: "success" };
      },
      parseStepsDeps,
    });

    const result = await runtime.run(task, flagOff);

    expect(result.disposition).toBe("completed");
    expect(calls).toEqual(["custom:prepare", "prepare-worktree", "execute"]);
    expect(result.visitedNodeIds).toEqual(["start", "prepare", "execute"]);
    expect(observed.prepared).toEqual({ worktreePath: "/tmp/fusion-worktree" });
    expect(result.context.preparedKey).toBe("from-prepare");
    expect(result.context.executeKey).toBe("from-execute");
    expect(workflowSelectionReads).toBe(1);
  });

  it("Task 3 RED: direct persisted campaign execution requires a work-item fence before workflow resolution", async () => {
    const resolve = vi.fn(() => ({ workflowId: "WF-001", stepIds: [] }));
    const runtime = new WorkflowTaskRuntime({
      store: {
        getTaskWorkflowSelection: resolve,
        getWorkflowDefinition: async () => ({ ir: selectedIr() }),
        getCccCampaignContextForTask: async () => ({ campaignId: "CAMPAIGN-1" }),
      },
      primitives: recordingPrimitives([]),
      runCustomNode: async () => ({ outcome: "success" }),
    });

    const result = await runtime.run(task, flagOff);

    expect(result).toMatchObject({
      disposition: "failed",
      outcome: "failure",
      visitedNodeIds: [],
      reason: "ccc-campaign-work-item-fence-required",
    });
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each([
    ["unwired", undefined, "ccc-campaign-custody-lookup-unwired"],
    ["missing", async () => null, "ccc-campaign-custody-missing"],
    ["error", async () => { throw new Error("custody unavailable"); }, "ccc-campaign-custody-lookup-error"],
  ])("Task 3 RED: fenced runtime %s custody refuses before workflow resolution", async (_case, getCccCampaignContextForTask, reason) => {
    const resolve = vi.fn(() => ({ workflowId: "WF-001", stepIds: [] }));
    const handler = vi.fn(async () => ({ outcome: "success" as const }));
    const runtime = new WorkflowTaskRuntime({
      store: {
        getTaskWorkflowSelection: resolve,
        getWorkflowDefinition: async () => ({ ir: selectedIr() }),
        ...(getCccCampaignContextForTask ? { getCccCampaignContextForTask } : {}),
      },
      primitives: recordingPrimitives([]),
      runCustomNode: async () => ({ outcome: "success" }),
      handlers: { prompt: handler },
    });

    const result = await runtime.run(task, flagOff, {
      workItemFence: {
        workItemId: "WORK-UNMARKED-1",
        leaseOwner: "worker-1",
        attempt: 1,
        runId: "ccc-prd:import-1",
        eventTimestamp: "2026-07-25T12:00:00.000Z",
      },
    });

    expect(result).toMatchObject({ disposition: "failed", outcome: "failure", visitedNodeIds: [], reason });
    expect(resolve).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it.each([
    ["wrong owner", "wrong-owner"],
    ["wrong attempt", "wrong-attempt"],
    ["wrong run", "wrong-run"],
    ["expired", "expired"],
    ["validator error", "validator-error"],
  ])("Task 3 RED: campaign fence preflight refuses %s before orchestration-only workflow resolution", async (_case, refusal) => {
    const resolve = vi.fn(() => ({ workflowId: "WF-orchestration", stepIds: [] }));
    const handler = vi.fn(async () => ({ outcome: "success" as const }));
    const assertCccCampaignWorkflowLeaseFence = vi.fn(async () => {
      throw new Error(refusal);
    });
    const runtime = new WorkflowTaskRuntime({
      store: {
        getTaskWorkflowSelection: resolve,
        getWorkflowDefinition: async () => ({
          ir: {
            version: "v1",
            name: "orchestration-only",
            nodes: [{ id: "start", kind: "start" }, { id: "end", kind: "end" }],
            edges: [{ from: "start", to: "end", condition: "success" }],
          },
        }),
        getCccCampaignContextForTask: async () => ({ campaignId: "CAMPAIGN-1" }),
        assertCccCampaignWorkflowLeaseFence,
      } as WorkflowTaskRuntimeDeps["store"],
      primitives: recordingPrimitives([]),
      runCustomNode: handler,
    });

    const result = await runtime.run(task, flagOff, {
      workItemFence: {
        workItemId: "WORK-1",
        leaseOwner: "worker-1",
        attempt: 2,
        runId: "ccc-prd:import-1",
        eventTimestamp: "2026-07-25T12:00:00.000Z",
      },
    });

    expect(result).toMatchObject({
      disposition: "failed",
      outcome: "failure",
      visitedNodeIds: [],
      reason: "ccc-campaign-work-item-fence-refused",
    });
    expect(resolve).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it("Task 3 RED: campaign fence preflight refuses an unwired validator before workflow resolution", async () => {
    const resolve = vi.fn(() => ({ workflowId: "WF-orchestration", stepIds: [] }));
    const runtime = new WorkflowTaskRuntime({
      store: {
        getTaskWorkflowSelection: resolve,
        getWorkflowDefinition: async () => ({ ir: selectedIr() }),
        getCccCampaignContextForTask: async () => ({ campaignId: "CAMPAIGN-1" }),
      },
      primitives: recordingPrimitives([]),
      runCustomNode: async () => ({ outcome: "success" }),
    });

    const result = await runtime.run(task, flagOff, {
      workItemFence: {
        workItemId: "WORK-1",
        leaseOwner: "worker-1",
        attempt: 2,
        runId: "ccc-prd:import-1",
        eventTimestamp: "2026-07-25T12:00:00.000Z",
      },
    });

    expect(result.reason).toBe("ccc-campaign-work-item-fence-validator-unwired");
    expect(result.visitedNodeIds).toEqual([]);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("Task 3 RED: a valid campaign fence preflight admits an orchestration-only workflow", async () => {
    const assertCccCampaignWorkflowLeaseFence = vi.fn(async () => undefined);
    const runtime = new WorkflowTaskRuntime({
      store: {
        getTaskWorkflowSelection: () => ({ workflowId: "WF-orchestration", stepIds: [] }),
        getWorkflowDefinition: async () => ({
          ir: {
            version: "v1",
            name: "orchestration-only",
            nodes: [{ id: "start", kind: "start" }, { id: "end", kind: "end" }],
            edges: [{ from: "start", to: "end", condition: "success" }],
          },
        }),
        getCccCampaignContextForTask: async () => ({ campaignId: "CAMPAIGN-1" }),
        assertCccCampaignWorkflowLeaseFence,
      } as WorkflowTaskRuntimeDeps["store"],
      primitives: recordingPrimitives([]),
      runCustomNode: async () => ({ outcome: "success" }),
    });
    const fence = {
      workItemId: "WORK-1",
      leaseOwner: "worker-1",
      attempt: 2,
      runId: "ccc-prd:import-1",
      eventTimestamp: "2026-07-25T12:00:00.000Z",
    };

    const result = await runtime.run(task, flagOff, { workItemFence: fence });

    expect(result.disposition).toBe("completed");
    expect(assertCccCampaignWorkflowLeaseFence).toHaveBeenCalledWith({
      workItemId: fence.workItemId,
      originTaskId: task.id,
      leaseOwner: fence.leaseOwner,
      attempt: fence.attempt,
      runId: fence.runId,
    });
  });

  it("product v2 RED: removing only the sealed receipt adapter refuses before any graph effect even when the mutable IR hash is rewritten", async () => {
    const semanticTaskId = "TASK-SEALED";
    const nativeTaskId = "FN-SEALED";
    const expectedRoute = {
      taskId: semanticTaskId,
      providerId: "provider-approved",
      modelId: "upstream/model-approved",
      transport: "pi" as const,
      receiptAdapterId: "terminal-route-sse-comments.v1" as const,
      executor: "model" as const,
      toolMode: "coding" as const,
      worktreeMode: "isolated" as const,
      ownedPaths: ["src/owned.ts"],
      allowedWriteRoots: ["src"],
      commitPolicy: "required" as const,
    };
    const expectedRouteSha256 = createHash("sha256")
      .update(canonicalCccPrdJson(expectedRoute), "utf8")
      .digest("hex");
    const expectedPromptSha256 = createHash("sha256")
      .update("sealed prompt", "utf8")
      .digest("hex");
    const driftedIr: WorkflowIr = {
      version: "v1",
      name: "drifted-imported-workflow",
      nodes: [
        { id: "start", kind: "start" },
        {
          id: "execute",
          kind: "prompt",
          config: {
            prompt: "sealed prompt",
            cccPrdTaskId: semanticTaskId,
            cccNativeTaskId: nativeTaskId,
            cccExecutionPromptSchema: "ccc-prd.execution-prompt.v1",
            cccExecutionPromptSha256: expectedPromptSha256,
            cccExecutionTransport: "pi",
            cccExecutionProviderId: expectedRoute.providerId,
            cccExecutionModelId: expectedRoute.modelId,
            // Deliberate custody mutation: the exact sealed adapter is omitted.
            cccExecutionRouteSha256: expectedRouteSha256,
            executor: expectedRoute.executor,
            toolMode: expectedRoute.toolMode,
            worktreeMode: expectedRoute.worktreeMode,
            ownedPaths: expectedRoute.ownedPaths,
            allowedWriteRoots: expectedRoute.allowedWriteRoots,
            commitPolicy: expectedRoute.commitPolicy,
          },
        },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "execute", condition: "success" },
        { from: "execute", to: "end", condition: "success" },
      ],
    };
    const promptEffect = vi.fn(async () => ({ outcome: "success" as const }));
    const importedTask = {
      id: nativeTaskId,
      lineageId: "ccc-prd:0123456789abcdef01234567:TASK-SEALED",
    } as TaskDetail;
    const runtime = new WorkflowTaskRuntime({
      store: {
        getTaskWorkflowSelection: () => ({ workflowId: "WF-SEALED", stepIds: [] }),
        getWorkflowDefinition: async () => ({ ir: driftedIr }),
        getCccCampaignContextForTask: async () => ({
          ...campaignProofContext(nativeTaskId, semanticTaskId),
          executionPolicy: {
            schema: "ccc-campaign.execution-policy.v2",
            routes: [expectedRoute],
          },
          route: expectedRoute,
          executionCustody: {
            promptSchema: "ccc-prd.execution-prompt.v1",
            promptSha256: expectedPromptSha256,
            routeSha256: expectedRouteSha256,
          },
        } as CccCampaignTaskContext),
        assertCccCampaignWorkflowLeaseFence: async () => undefined,
      },
      primitives: recordingPrimitives([]),
      runCustomNode: promptEffect,
      handlers: { prompt: promptEffect },
    });

    const result = await runtime.run(importedTask, flagOff, {
      workItemFence: {
        workItemId: "WORK-SEALED",
        leaseOwner: "worker-1",
        attempt: 1,
        runId: "ccc-prd:import-sealed",
        eventTimestamp: "2026-07-25T12:00:00.000Z",
        irHash: workflowIrSha256(driftedIr),
      },
    });

    expect(result).toMatchObject({
      disposition: "manual-required",
      outcome: "failure",
      visitedNodeIds: [],
      reason: "ccc-permanent:CCC_CAMPAIGN_EXECUTION_CUSTODY_DRIFT",
    });
    expect(promptEffect).not.toHaveBeenCalled();
  });

  it("product v2: requires live execution approval before preparing a campaign worktree", async () => {
    const semanticTaskId = "TASK-LIVE-GATE";
    const nativeTaskId = "FN-LIVE-GATE";
    const route = {
      taskId: semanticTaskId,
      providerId: "provider-approved",
      modelId: "combo/minimax-latest",
      transport: "pi" as const,
      receiptAdapterId: "terminal-route-sse-comments.v1" as const,
      terminalRouteMembers: [
        { provider: "minimax", model: "MiniMax-M3" },
      ] as const,
      executor: "model" as const,
      toolMode: "coding" as const,
      worktreeMode: "isolated" as const,
      ownedPaths: ["src/owned.ts"],
      allowedWriteRoots: ["src/owned.ts"],
      commitPolicy: "required" as const,
    };
    const routeSha256 = createHash("sha256")
      .update(canonicalCccPrdJson(route), "utf8")
      .digest("hex");
    const promptSha256 = createHash("sha256")
      .update("sealed prompt", "utf8")
      .digest("hex");
    const ir: WorkflowIr = {
      version: "v1",
      name: "live-gated-imported-workflow",
      nodes: [
        { id: "start", kind: "start" },
        {
          id: "execute",
          kind: "prompt",
          config: {
            prompt: "sealed prompt",
            cccPrdTaskId: semanticTaskId,
            cccNativeTaskId: nativeTaskId,
            cccExecutionPromptSchema: "ccc-prd.execution-prompt.v1",
            cccExecutionPromptSha256: promptSha256,
            cccExecutionTransport: route.transport,
            cccExecutionProviderId: route.providerId,
            cccExecutionModelId: route.modelId,
            cccExecutionReceiptAdapterId: route.receiptAdapterId,
            cccExecutionTerminalRouteMembers: route.terminalRouteMembers,
            cccExecutionRouteSha256: routeSha256,
            executor: route.executor,
            toolMode: route.toolMode,
            worktreeMode: route.worktreeMode,
            ownedPaths: route.ownedPaths,
            allowedWriteRoots: route.allowedWriteRoots,
            commitPolicy: route.commitPolicy,
          },
        },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "execute", condition: "success" },
        { from: "execute", to: "end", condition: "success" },
      ],
    };
    const prepareNodeExecution = vi.fn(async () => undefined);
    const runCustomNode = vi.fn(async () => ({ outcome: "success" as const }));
    const requireLiveExecution = vi.fn(async () => {
      throw new PermanentError(
        "awaiting exact live execution approval",
        "CCC_CAMPAIGN_LIVE_EXECUTION_APPROVAL_REQUIRED",
      );
    });
    const importedTask = {
      id: nativeTaskId,
      lineageId: "ccc-prd:0123456789abcdef01234567:TASK-LIVE-GATE",
    } as TaskDetail;
    const context = {
      ...campaignProofContext(nativeTaskId, semanticTaskId),
      projectId: "PROJECT-LIVE-GATE",
      importId: "IMPORT-LIVE-GATE",
      idempotencyKey: "IDEMPOTENCY-LIVE-GATE",
      campaignId: "CAMPAIGN-LIVE-GATE",
      packetHash: "1".repeat(64),
      sidecarHash: "2".repeat(64),
      bundleHash: "3".repeat(64),
      manifestHash: "4".repeat(64),
      sourceVersion: "v2",
      targetRepository: {
        path: "/tmp/live-gate",
        baseCommit: "5".repeat(40),
      },
      bounds: {
        maxRequests: 1,
        maxConcurrency: 1,
        maxDurationMs: 60_000,
      },
      executionPolicy: {
        schema: "ccc-campaign.execution-policy.v2",
        routes: [route],
      },
      route,
      executionCustody: {
        promptSchema: "ccc-prd.execution-prompt.v1",
        promptSha256,
        routeSha256,
      },
    } as CccCampaignTaskContext;
    const runtime = new WorkflowTaskRuntime({
      store: {
        getTaskWorkflowSelection: () => ({ workflowId: "WF-LIVE-GATE", stepIds: [] }),
        getWorkflowDefinition: async () => ({ ir }),
        getTask: async () => importedTask,
        getCccCampaignContextForTask: async () => context,
        recordFencedCccCampaignProofAudit: vi.fn(),
        assertCccCampaignWorkflowLeaseFence: async () => undefined,
      },
      primitives: recordingPrimitives([]),
      runCustomNode,
      prepareNodeExecution,
      requireCccCampaignLiveExecutionApproval: requireLiveExecution,
    });
    const fence = {
      workItemId: "WORK-LIVE-GATE",
      leaseOwner: "worker-live-gate",
      attempt: 1,
      runId: "ccc-prd:import-live-gate",
      eventTimestamp: "2026-08-22T16:00:00.000Z",
      irHash: workflowIrSha256(ir),
    };

    const result = await runtime.run(importedTask, flagOff, {
      signal: new AbortController().signal,
      workItemFence: fence,
    });

    expect(result).toMatchObject({
      disposition: "manual-required",
      outcome: "failure",
      reason: "ccc-permanent:CCC_CAMPAIGN_LIVE_EXECUTION_APPROVAL_REQUIRED",
    });
    expect(requireLiveExecution).toHaveBeenCalledWith({
      taskId: nativeTaskId,
      runId: fence.runId,
    });
    expect(prepareNodeExecution).not.toHaveBeenCalled();
    expect(runCustomNode).not.toHaveBeenCalled();
  });

  it("Task 4 RED: fenced campaign run identity comes from the persisted work-item fence", async () => {
    const assertCccCampaignWorkflowLeaseFence = vi.fn(async () => undefined);
    const getCccCampaignContextForTask = vi.fn(async () =>
      ({ campaignId: "CAMPAIGN-1" } as CccCampaignTaskContext),
    );
    const runtime = new WorkflowTaskRuntime({
      runId: "ambient-deps-run-id",
      store: {
        getTaskWorkflowSelection: () => ({ workflowId: "WF-orchestration", stepIds: [] }),
        getWorkflowDefinition: async () => ({
          ir: {
            version: "v1",
            name: "orchestration-only",
            nodes: [{ id: "start", kind: "start" }, { id: "end", kind: "end" }],
            edges: [{ from: "start", to: "end", condition: "success" }],
          },
        }),
        getCccCampaignContextForTask,
        assertCccCampaignWorkflowLeaseFence,
      },
      primitives: recordingPrimitives([]),
      runCustomNode: async () => ({ outcome: "success" }),
    });

    const fence = {
      workItemId: "WORK-FENCE-1",
      leaseOwner: "worker-1",
      attempt: 1,
      runId: "ccc-prd:import-1",
      eventTimestamp: "2026-07-25T12:00:00.000Z",
    };

    const result = await runtime.run(task, flagOff, { workItemFence: fence });

    expect(result.context["workflow:run-id"]).toBe(fence.runId);
    expect(getCccCampaignContextForTask).toHaveBeenCalledTimes(1);
    expect(assertCccCampaignWorkflowLeaseFence).toHaveBeenCalledWith({
      workItemId: fence.workItemId,
      originTaskId: task.id,
      leaseOwner: fence.leaseOwner,
      attempt: fence.attempt,
      runId: fence.runId,
    });
  });


  it("Task 4 RED: freezes the work-item fence before the first await", async () => {
    let releaseLookup!: () => void;
    let lookupEntered = false;
    let capturedFenceInput: {
      workItemId: string;
      originTaskId: string;
      leaseOwner: string;
      attempt: number;
      runId: string;
    } | undefined;

    const getCccCampaignContextForTask = vi.fn(async () => {
      lookupEntered = true;
      await new Promise<void>((resolve) => {
        releaseLookup = resolve;
      });
      return { campaignId: "CAMPAIGN-1" } as CccCampaignTaskContext;
    });
    const assertCccCampaignWorkflowLeaseFence = vi.fn(async (input) => {
      capturedFenceInput = input;
    });

    const resolve = vi.fn(() => ({ workflowId: "WF-orchestration", stepIds: [] }));
    const runtime = new WorkflowTaskRuntime({
      store: {
        getTaskWorkflowSelection: resolve,
        getWorkflowDefinition: async () => ({
          ir: {
            version: "v1",
            name: "orchestration-only",
            nodes: [{ id: "start", kind: "start" }, { id: "end", kind: "end" }],
            edges: [{ from: "start", to: "end", condition: "success" }],
          },
        }),
        getCccCampaignContextForTask,
        assertCccCampaignWorkflowLeaseFence,
      },
      primitives: recordingPrimitives([]),
      runCustomNode: async () => ({ outcome: "success" }),
    });

    const fence = {
      workItemId: "WORK-1",
      leaseOwner: "worker-1",
      attempt: 2,
      runId: "ccc-prd:import-1",
      eventTimestamp: "2026-07-25T12:00:00.000Z",
    };

    const processing = runtime.run(task, flagOff, { workItemFence: fence });

    await vi.waitFor(() => expect(lookupEntered).toBe(true));
    fence.workItemId = "WORK-MUTATED";
    fence.leaseOwner = "worker-2";
    fence.attempt = 9;
    fence.runId = "ccc-prd:import-mutated";
    fence.eventTimestamp = "2026-07-25T13:00:00.000Z";
    releaseLookup();

    const result = await processing;

    expect(result.disposition).toBe("completed");
    expect(capturedFenceInput).toEqual({
      workItemId: "WORK-1",
      originTaskId: task.id,
      leaseOwner: "worker-1",
      attempt: 2,
      runId: "ccc-prd:import-1",
    });
    expect(getCccCampaignContextForTask).toHaveBeenCalledTimes(1);
    expect(assertCccCampaignWorkflowLeaseFence).toHaveBeenCalledTimes(1);
  });

  it("Task 4 RED: resolves semantic task via store.getTask before proof admission", async () => {
    const getTask = vi.fn(async () => ({ id: nativeSemanticTaskId } as TaskDetail));
    const assertCccCampaignWorkflowLeaseFence = vi.fn(async () => undefined);
    const recordFencedCccCampaignProofAudit = vi.fn();
    const handler = vi.fn(async () => ({ outcome: "success" as const }));
    const runtime = new WorkflowTaskRuntime({
      store: {
        getTaskWorkflowSelection: () => ({ workflowId: "WF-SEM", stepIds: [] }),
        getWorkflowDefinition: async () => ({ ir: selectedSemanticIr() }),
        getTask,
        getCccCampaignContextForTask: async (taskId: string) => campaignProofContext(taskId),
        recordFencedCccCampaignProofAudit,
        assertCccCampaignWorkflowLeaseFence,
      },
      primitives: recordingPrimitives([]),
      runCustomNode: handler,
    });
    const fence = {
      workItemId: "WORK-SEM-1",
      leaseOwner: "worker-1",
      attempt: 2,
      runId: "ccc-prd:import-semantic-1",
      eventTimestamp: "2026-07-25T12:00:00.000Z",
    };

    const result = await runtime.run(task, flagOff, {
      workItemFence: fence,
      signal: new AbortController().signal,
    });

    expect(result.disposition).toBe("failed");
    expect(result.outcome).toBe("failure");
    expect(getTask).toHaveBeenCalledTimes(1);
    expect(getTask).toHaveBeenCalledWith(nativeSemanticTaskId);
    expect(handler).not.toHaveBeenCalled();
    expect(assertCccCampaignWorkflowLeaseFence).toHaveBeenCalledTimes(1);
    expect(recordFencedCccCampaignProofAudit).not.toHaveBeenCalled();
  });

  it.each([
    ["unwired", undefined, /CCC campaign semantic task|lookup|semantic/i],
    ["missing", async () => undefined, /CCC campaign native task FN-9003 is missing for semantic task TASK-SEMANTIC/i],
    ["throws", async () => { throw new Error("resolver failed"); }, /CCC campaign native task FN-9003 lookup failed for semantic task TASK-SEMANTIC/i],
    ["mismatched-id", async () => ({ id: "TASK-OTHER" } as TaskDetail), /CCC campaign native task identity does not match FN-9003/i],
  ])("Task 4 RED: semantic resolver refuses before proof/evaluator when getTask is %s", async (_case, getTaskResult, token) => {
    const signal = new AbortController().signal;
    const getTask = getTaskResult
      ? vi.fn(async (_taskId: string) => getTaskResult())
      : undefined;
    const handler = vi.fn(async () => ({ outcome: "success" as const }));
    const assertCccCampaignWorkflowLeaseFence = vi.fn(async () => undefined);
    const recordFencedCccCampaignProofAudit = vi.fn();
    const runtime = new WorkflowTaskRuntime({
      store: {
        getTaskWorkflowSelection: () => ({ workflowId: "WF-SEM", stepIds: [] }),
        getWorkflowDefinition: async () => ({ ir: selectedSemanticIr() }),
        ...(getTask ? { getTask } : {}),
        getCccCampaignContextForTask: async (taskId: string) => campaignProofContext(taskId),
        recordFencedCccCampaignProofAudit,
        assertCccCampaignWorkflowLeaseFence,
      },
      primitives: recordingPrimitives([]),
      runCustomNode: handler,
    });
    const fence = {
      workItemId: "WORK-SEM-1",
      leaseOwner: "worker-1",
      attempt: 2,
      runId: "ccc-prd:import-semantic-1",
      eventTimestamp: "2026-07-25T12:00:00.000Z",
    };

    const result = await runtime.run(task, flagOff, { workItemFence: fence, signal });

    expect(result.disposition).toBe("failed");
    expect(result.outcome).toBe("failure");
    if (getTask) {
      expect(getTask).toHaveBeenCalledTimes(1);
      expect(getTask).toHaveBeenCalledWith(nativeSemanticTaskId);
    }
    expect(handler).not.toHaveBeenCalled();
    expect(recordFencedCccCampaignProofAudit).not.toHaveBeenCalled();
    expect(result.context["node:semantic:error"] ?? result.reason ?? "").toMatch(token);
  });

  it("Task 4 RED: ordinary unfenced workflow does not perform semantic task substitution", async () => {
    const getTask = vi.fn(async () => ({ id: "TASK-SEMANTIC" } as TaskDetail));
    const calls: string[] = [];
    const runtime = new WorkflowTaskRuntime({
      store: {
        getTaskWorkflowSelection: () => ({ workflowId: "WF-SEM", stepIds: [] }),
        getWorkflowDefinition: async () => ({ ir: selectedSemanticIr() }),
        getTask,
      },
      primitives: recordingPrimitives(calls),
      runCustomNode: async (node) => {
        calls.push(`custom:${node.id}`);
        return { outcome: "success" };
      },
    });

    const result = await runtime.run(task, flagOff, { deferCompletionSummary: true });

    expect(result.disposition).toBe("completed");
    expect(result.outcome).toBe("success");
    expect(calls).toContain("custom:semantic");
    expect(calls).not.toContain("custom:prepare");
    expect(calls).not.toContain("custom:workflow-step");
    expect(getTask).not.toHaveBeenCalled();
  });

  it("Task 3 RED: imported campaign lineage fails closed when custody lookup is missing", async () => {
    const resolve = vi.fn(() => ({ workflowId: "WF-001", stepIds: [] }));
    const runtime = new WorkflowTaskRuntime({
      store: {
        getTaskWorkflowSelection: resolve,
        getWorkflowDefinition: async () => ({ ir: selectedIr() }),
      },
      primitives: recordingPrimitives([]),
      runCustomNode: async () => ({ outcome: "success" }),
    });
    const importedTask = {
      ...task,
      lineageId: "ccc-prd:0123456789abcdef01234567:REQ-1",
    } as TaskDetail;

    const result = await runtime.run(importedTask, flagOff, {
      workItemFence: {
        workItemId: "WORK-1",
        leaseOwner: "worker-1",
        attempt: 1,
        runId: "ccc-prd:import-1",
        eventTimestamp: "2026-07-25T12:00:00.000Z",
      },
    });

    expect(result).toMatchObject({
      disposition: "failed",
      outcome: "failure",
      visitedNodeIds: [],
      reason: "ccc-campaign-custody-lookup-unwired",
    });
    expect(resolve).not.toHaveBeenCalled();
  });

  it("Task 3 RED: direct imported work-item execution is reserved for the full campaign processor", async () => {
    const getTask = vi.fn();
    const transitionWorkflowWorkItem = vi.fn();
    const runtime = new WorkflowTaskRuntime({
      store: {
        getTask,
        transitionWorkflowWorkItem,
        getTaskWorkflowSelection: () => ({ workflowId: "WF-001", stepIds: [] }),
        getWorkflowDefinition: async () => ({ ir: selectedIr() }),
        getCccCampaignContextForTask: async () => ({ campaignId: "CAMPAIGN-1" }),
      },
      primitives: recordingPrimitives([]),
      runCustomNode: async () => ({ outcome: "success" }),
    });
    const workItem = {
      id: "WORK-CCC-1",
      taskId: "TASK-ORIGIN",
      kind: "task",
      state: "running",
      attempt: 1,
      runId: "ccc-prd:import-1",
      stableWorkflowRunId: "ccc-prd:import-1",
      irHash: "a".repeat(64),
    } as WorkflowWorkItem;

    const result = await runtime.runWorkItem(workItem, flagOff);

    expect(result).toMatchObject({
      disposition: "failed",
      outcome: "failure",
      visitedNodeIds: [],
      reason: "ccc-campaign-full-graph-processor-required",
    });
    expect(getTask).not.toHaveBeenCalled();
    expect(transitionWorkflowWorkItem).not.toHaveBeenCalled();
  });

  it.each([
    ["unwired", undefined],
    ["missing", async () => null],
    ["error", async () => { throw new Error("custody unavailable"); }],
  ])("Task 3: imported work-item %s custody refuses without mutation", async (_case, getCccCampaignContextForTask) => {
    const getTask = vi.fn();
    const transitionWorkflowWorkItem = vi.fn();
    const runtime = new WorkflowTaskRuntime({
      store: {
        getTask,
        transitionWorkflowWorkItem,
        getTaskWorkflowSelection: () => ({ workflowId: "WF-001", stepIds: [] }),
        getWorkflowDefinition: async () => ({ ir: selectedIr() }),
        ...(getCccCampaignContextForTask ? { getCccCampaignContextForTask } : {}),
      },
      primitives: recordingPrimitives([]),
      runCustomNode: async () => ({ outcome: "success" }),
    });
    const workItem = {
      id: "WORK-CCC-2",
      taskId: "TASK-ORIGIN",
      kind: "task",
      state: "runnable",
      attempt: 1,
      runId: "ccc-prd:import-2",
      stableWorkflowRunId: "ccc-prd:import-2",
      irHash: "b".repeat(64),
    } as WorkflowWorkItem;

    const result = await runtime.runWorkItem(workItem, flagOff);

    expect(result.reason).toBe("ccc-campaign-full-graph-processor-required");
    expect(getTask).not.toHaveBeenCalled();
    expect(transitionWorkflowWorkItem).not.toHaveBeenCalled();
  });

  it("Task 3 RED: a fenced campaign graph refuses a node without semantic proof custody before its handler", async () => {
    const promptHandler = vi.fn(async () => ({ outcome: "success" as const }));
    const getCccCampaignContextForTask = vi.fn();
    const campaignTask = {
      id: "TASK-ORIGIN",
      customFields: { cccFusionProfile: "ccc-fusion" },
    } as TaskDetail;
    const runtime = new WorkflowTaskRuntime({
      store: {
        getTaskWorkflowSelection: () => ({ workflowId: "WF-001", stepIds: [] }),
        getWorkflowDefinition: async () => ({ ir: selectedIr() }),
        getCccCampaignContextForTask,
        recordRunAuditEvent: vi.fn(),
        recordFencedCccCampaignProofAudit: vi.fn(),
      },
      primitives: recordingPrimitives([]),
      runCustomNode: async () => ({ outcome: "success" }),
      handlers: { prompt: promptHandler },
    });

    const result = await runtime.run(campaignTask, flagOff, {
      signal: new AbortController().signal,
      workItemFence: {
        workItemId: "WORK-1",
        leaseOwner: "worker-1",
        attempt: 1,
        runId: "run-1",
        eventTimestamp: "2026-07-25T12:00:00.000Z",
      },
    });

    expect(result.disposition).toBe("failed");
    expect(result.outcome).toBe("failure");
    expect(promptHandler).not.toHaveBeenCalled();
    expect(getCccCampaignContextForTask).toHaveBeenCalledWith("TASK-ORIGIN");
  });

  it("Task 3 RED: external cancellation reaches a long sequential node and prevents late success", async () => {
    const controller = new AbortController();
    const updateTask = vi.fn();
    let observedSignal: AbortSignal | undefined;
    let releaseHandler!: () => void;
    const runtime = new WorkflowTaskRuntime({
      store: {
        getTaskWorkflowSelection: () => ({ workflowId: "WF-001", stepIds: [] }),
        getWorkflowDefinition: async () => ({ ir: selectedIr() }),
        updateTask,
      },
      primitives: recordingPrimitives([]),
      runCustomNode: async () => ({ outcome: "success" }),
      handlers: {
        prompt: async (_node, context) => {
          observedSignal = context.signal;
          await new Promise<void>((resolve) => { releaseHandler = resolve; });
          return { outcome: "success", value: "late-success" };
        },
      },
    });

    const processing = runtime.run(task, flagOff, { signal: controller.signal });
    await vi.waitFor(() => expect(observedSignal).toBe(controller.signal));
    controller.abort();
    releaseHandler();
    const result = await processing;

    expect(result.disposition).toBe("failed");
    expect(result.outcome).toBe("failure");
    expect(result.reason).toContain("workflow-aborted");
    expect(updateTask).not.toHaveBeenCalled();
  });

  it("Task 3 RED: abort during required artifact custody prevents terminal success summary", async () => {
    const controller = new AbortController();
    const updateTask = vi.fn();
    let releaseArtifactRead!: () => void;
    const irWithRequiredArtifact: WorkflowIr = {
      ...selectedIr(),
      artifacts: [{ key: "PROMPT.md", title: "Plan", producedBy: "prepare", role: "step-source" }],
    };
    const runtime = new WorkflowTaskRuntime({
      store: {
        getTaskWorkflowSelection: () => ({ workflowId: "WF-001", stepIds: [] }),
        getWorkflowDefinition: async () => ({ ir: irWithRequiredArtifact }),
        getTaskDocument: async (_taskId, key) => {
          if (key !== "PROMPT.md") return null;
          await new Promise<void>((resolve) => { releaseArtifactRead = resolve; });
          return { key, content: promptWithOneStep };
        },
        updateTask,
      },
      primitives: recordingPrimitives([]),
      runCustomNode: async () => ({ outcome: "success" }),
    });

    const processing = runtime.run(task, flagOff, { signal: controller.signal });
    await vi.waitFor(() => expect(releaseArtifactRead).toBeTypeOf("function"));
    controller.abort();
    releaseArtifactRead();
    const result = await processing;

    expect(result.disposition).toBe("failed");
    expect(result.reason).toBe("workflow-aborted");
    expect(updateTask).not.toHaveBeenCalled();
  });

  it("records a completion summary when a workflow run completes without fn_task_done", async () => {
    const updates: Array<{ taskId: string; summary: string }> = [];
    const logs: Array<{ taskId: string; action: string; detail?: string }> = [];
    const completedTask = {
      ...task,
      title: "Ship workflow summaries",
      steps: [
        { title: "Implement summary persistence", status: "done" },
        { title: "Verify workflow completion", status: "done" },
      ],
      modifiedFiles: ["packages/engine/src/workflow-task-runtime.ts"],
    } as TaskDetail;
    const runtime = new WorkflowTaskRuntime({
      store: {
        getTask: async () => completedTask,
        getTaskWorkflowSelection: () => ({ workflowId: "WF-001", stepIds: [] }),
        getWorkflowDefinition: async () => ({ ir: selectedIr() }),
        updateTask: async (taskId, update) => {
          updates.push({ taskId, summary: update.summary });
        },
        logEntry: async (taskId, action, detail) => {
          logs.push({ taskId, action, detail });
        },
      },
      primitives: recordingPrimitives([]),
      runCustomNode: async () => ({ outcome: "success" }),
      parseStepsDeps,
    });

    const result = await runtime.run(completedTask, flagOff);

    expect(result.disposition).toBe("completed");
    expect(updates).toEqual([
      {
        taskId: task.id,
        summary: expect.stringContaining("Workflow completed: Ship workflow summaries."),
      },
    ]);
    expect(updates[0]?.summary).toContain("Completed 2/2 task steps.");
    expect(updates[0]?.summary).toContain("Changed files: packages/engine/src/workflow-task-runtime.ts.");
    expect(logs).toEqual([
      expect.objectContaining({ taskId: task.id, action: "Workflow completion summary recorded" }),
    ]);
  });

  it("preserves an existing workflow completion summary", async () => {
    const updateTask = vi.fn();
    const summarizedTask = { ...task, summary: "Agent-authored completion summary." } as TaskDetail;
    const runtime = new WorkflowTaskRuntime({
      store: {
        getTask: async () => summarizedTask,
        getTaskWorkflowSelection: () => ({ workflowId: "WF-001", stepIds: [] }),
        getWorkflowDefinition: async () => ({ ir: selectedIr() }),
        updateTask,
      },
      primitives: recordingPrimitives([]),
      runCustomNode: async () => ({ outcome: "success" }),
      parseStepsDeps,
    });

    const result = await runtime.run(summarizedTask, flagOff);

    expect(result.disposition).toBe("completed");
    expect(updateTask).not.toHaveBeenCalled();
  });

  it("preserves attachments through selected workflow execution", async () => {
    const calls: string[] = [];
    const attachments = [
      {
        filename: "abc-shot.png",
        originalName: "shot.png",
        mimeType: "image/png",
        size: 1024,
        createdAt: new Date().toISOString(),
      },
      {
        filename: "def-context.txt",
        originalName: "context.txt",
        mimeType: "text/plain",
        size: 256,
        createdAt: new Date().toISOString(),
      },
    ];
    const attachmentTask = { ...task, attachments } as TaskDetail;
    const observed: { executedTasks: TaskDetail[] } = { executedTasks: [] };
    const runtime = new WorkflowTaskRuntime({
      store: {
        getTaskWorkflowSelection: () => ({ workflowId: "WF-001", stepIds: [] }),
        getWorkflowDefinition: async () => ({ ir: selectedIr() }),
      },
      primitives: recordingPrimitives(calls, undefined, observed),
      runCustomNode: async (node) => {
        calls.push(`custom:${node.id}`);
        return { outcome: "success" };
      },
      parseStepsDeps,
    });

    const result = await runtime.run(attachmentTask, flagOff);

    expect(result.disposition).toBe("completed");
    expect(calls).toEqual(["custom:prepare", "prepare-worktree", "execute"]);
    expect(observed.executedTasks).toHaveLength(1);
    expect(observed.executedTasks[0]?.attachments).toEqual(attachments);
  });

  it("preserves attachments through built-in workflow execution", async () => {
    const calls: string[] = [];
    const attachments = [
      {
        filename: "abc-shot.png",
        originalName: "shot.png",
        mimeType: "image/png",
        size: 1024,
        createdAt: new Date().toISOString(),
      },
    ];
    const attachmentTask = { ...task, attachments } as TaskDetail;
    const observed: { executedTasks: TaskDetail[] } = { executedTasks: [] };
    const runtime = new WorkflowTaskRuntime({
      store: {
        getTaskWorkflowSelection: () => undefined,
        getWorkflowDefinition: async () => undefined,
        getTaskDocument: async (_taskId, key) => key === "PROMPT.md" ? { key, content: promptWithOneStep } : null,
      },
      primitives: recordingPrimitives(calls, undefined, observed),
      runCustomNode: async (node) => {
        calls.push(`custom:${node.id}`);
        return { outcome: "success" };
      },
      parseStepsDeps,
    });

    const result = await runtime.run(attachmentTask, flagOff);

    expect(result.disposition).toBe("completed");
    // Default Coding is stepwise: planning writes PROMPT.md, parse projects steps,
    // then foreach runs `runTaskStep` before merge. No legacy execute/review seam.
    expect(calls).toEqual(["planning", "custom:plan-review-step", "step:0", "custom:code-review-step", "custom:completion-summary", "merge"]);
    expect(observed.executedTasks).toHaveLength(1);
    expect(observed.executedTasks[0]?.attachments).toEqual(attachments);
  });

  it("passes undefined attachments through built-in workflow execution when absent", async () => {
    const observed: { executedTasks: TaskDetail[] } = { executedTasks: [] };
    const runtime = new WorkflowTaskRuntime({
      store: {
        getTaskWorkflowSelection: () => undefined,
        getWorkflowDefinition: async () => undefined,
        getTaskDocument: async (_taskId, key) => key === "PROMPT.md" ? { key, content: promptWithOneStep } : null,
      },
      primitives: recordingPrimitives([], undefined, observed),
      runCustomNode: async () => ({ outcome: "success" }),
      parseStepsDeps,
    });

    const result = await runtime.run(task, flagOff);

    expect(result.disposition).toBe("completed");
    expect(observed.executedTasks).toHaveLength(1);
    expect(observed.executedTasks[0]?.attachments).toBeUndefined();
  });

  it("fails execute instead of skipping coding when prepare succeeds without worktree data", async () => {
    const calls: string[] = [];
    const runtime = new WorkflowTaskRuntime({
      store: {
        getTaskWorkflowSelection: () => ({ workflowId: "WF-001", stepIds: [] }),
        getWorkflowDefinition: async () => ({ ir: selectedIr() }),
      },
      primitives: recordingPrimitives(calls, {
        prepare: { outcome: "success", value: "prepared-without-data" },
        prepareData: null,
      }),
      runCustomNode: async (node) => {
        calls.push(`custom:${node.id}`);
        return { outcome: "success" };
      },
    });

    const result = await runtime.run(task, flagOff);

    expect(result.disposition).toBe("failed");
    expect(calls).toEqual(["custom:prepare", "prepare-worktree"]);
    expect(result.visitedNodeIds).toEqual(["start", "prepare", "execute"]);
  });

  it("resolves an unselected task to the built-in coding workflow instead of falling back", async () => {
    const calls: string[] = [];
    const runtime = new WorkflowTaskRuntime({
      store: {
        getTaskWorkflowSelection: () => undefined,
        getWorkflowDefinition: async () => undefined,
        getTaskDocument: async (_taskId, key) => key === "PROMPT.md" ? { key, content: promptWithOneStep } : null,
      },
      primitives: recordingPrimitives(calls),
      runCustomNode: async (node) => {
        calls.push(`custom:${node.id}`);
        return { outcome: "success" };
      },
      parseStepsDeps,
    });

    const defaultTask = { ...task, enabledWorkflowSteps: ["plan-review", "code-review"] } as TaskDetail;
    const result = await runtime.run(defaultTask, flagOff);

    expect(result.disposition).toBe("completed");
    expect(calls).toEqual(["planning", "custom:plan-review-step", "step:0", "custom:code-review-step", "custom:completion-summary", "merge"]);
    expect(result.visitedNodeIds).toContain("plan");
    expect(result.visitedNodeIds).toContain("plan-review");
    expect(result.visitedNodeIds).toContain("parse");
    expect(result.visitedNodeIds).toContain("steps");
    expect(result.visitedNodeIds).toContain("code-review");
    expect(result.visitedNodeIds).not.toContain("execute");
    expect(result.visitedNodeIds).not.toContain("review");
  });

  it("runs the pre-merge browser-verification optional-group once when enabled, before review", async () => {
    // U6: replaces the prior workflow-step-remediation test. With the group ENABLED
    // (task.enabledWorkflowSteps includes "browser-verification"), the inner
    // browser-verification-step prompt node runs once pre-merge, recorded as a
    // custom-node call; the group then routes success → review → merge.
    const calls: string[] = [];
    const runtime = new WorkflowTaskRuntime({
      store: {
        getTaskWorkflowSelection: () => undefined,
        getWorkflowDefinition: async () => undefined,
        getTaskDocument: async (_taskId, key) => key === "PROMPT.md" ? { key, content: promptWithOneStep } : null,
      },
      primitives: recordingPrimitives(calls),
      runCustomNode: async (node) => {
        calls.push(`custom:${node.id}`);
        return { outcome: "success" };
      },
      parseStepsDeps,
    });

    const enabledTask = { ...task, enabledWorkflowSteps: ["plan-review", "browser-verification", "code-review"] } as TaskDetail;
    const result = await runtime.run(enabledTask, flagOff);

    expect(result.disposition).toBe("completed");
    expect(calls).toEqual([
      "planning",
      "custom:plan-review-step",
      "step:0",
      "custom:browser-verification-step",
      "custom:code-review-step",
      "custom:completion-summary",
      "merge",
    ]);
    expect(result.visitedNodeIds).toContain("plan-review::plan-review-step");
    expect(result.visitedNodeIds).toContain("browser-verification::browser-verification-step");
    expect(result.visitedNodeIds).toContain("code-review::code-review-step");
    expect(result.visitedNodeIds).not.toContain("execute");
    expect(result.visitedNodeIds).not.toContain("review");
  });

  it("fails selected workflow lookup misses instead of running the built-in workflow", async () => {
    const calls: string[] = [];
    const runtime = new WorkflowTaskRuntime({
      store: {
        getTaskWorkflowSelection: () => ({ workflowId: "WF-MISSING", stepIds: [] }),
        getWorkflowDefinition: async () => undefined,
      },
      primitives: recordingPrimitives(calls),
      runCustomNode: async () => ({ outcome: "success" }),
    });

    const result = await runtime.run(task, flagOff);

    expect(result.disposition).toBe("failed");
    expect(result.reason).toContain("workflow-resolution-error: workflow-missing: WF-MISSING");
    expect(calls).toEqual([]);
  });

  it("fails corrupt selected workflow definitions instead of running the built-in workflow", async () => {
    const calls: string[] = [];
    const runtime = new WorkflowTaskRuntime({
      store: {
        getTaskWorkflowSelection: () => ({ workflowId: "WF-CORRUPT", stepIds: [] }),
        getWorkflowDefinition: async () => ({ ir: "not a workflow ir" }),
      },
      primitives: recordingPrimitives(calls),
      runCustomNode: async () => ({ outcome: "success" }),
    });

    const result = await runtime.run(task, flagOff);

    expect(result.disposition).toBe("failed");
    expect(result.reason).toContain("workflow-resolution-error:");
    expect(calls).toEqual([]);
  });

  it("forces only the graph executor flag while preserving other settings", async () => {
    let observedSettings: Pick<Settings, "experimentalFeatures"> | undefined;
    const runtime = new WorkflowTaskRuntime({
      store: {
        getTaskWorkflowSelection: () => ({ workflowId: "WF-001", stepIds: [] }),
        getWorkflowDefinition: async () => ({ ir: selectedIr() }),
      },
      primitives: recordingPrimitives([]),
      runCustomNode: async () => ({ outcome: "success" }),
      handlers: {
        prompt: async (_node, context) => {
          observedSettings = context.settings;
          return { outcome: "success" };
        },
      },
    });
    const settings = {
      experimentalFeatures: { workflowColumns: true },
      testMode: true,
    } as unknown as Settings;

    const result = await runtime.run(task, settings);

    expect(result.disposition).toBe("completed");
    expect(observedSettings?.experimentalFeatures?.workflowGraphExecutor).toBeUndefined();
    expect(observedSettings?.experimentalFeatures?.workflowColumns).toBe(true);
    expect((observedSettings as Settings | undefined)?.testMode).toBe(true);
  });

  it("uses a workflow-specific default run id", async () => {
    const observedRunIds: string[] = [];
    const runtime = new WorkflowTaskRuntime({
      store: {
        getTaskWorkflowSelection: () => ({ workflowId: "WF-001", stepIds: [] }),
        getWorkflowDefinition: async () => ({ ir: selectedIr() }),
      },
      primitives: recordingPrimitives([]),
      runCustomNode: async () => ({ outcome: "success" }),
      parseStepsDeps,
      branchPersistence: {
        loadBranchStates: (_taskId, runId) => {
          observedRunIds.push(runId);
          return [];
        },
      },
    });

    await runtime.run(task, flagOff);

    expect(observedRunIds).toContain("FN-9002:WF-001");
  });

  it("runs a leased workflow work item at its addressed node and persists success", async () => {
    const calls: string[] = [];
    const transitions: Array<{ id: string; state: WorkflowWorkItemState; patch?: Record<string, unknown> }> = [];
    const runtime = new WorkflowTaskRuntime({
      store: {
        getTask: async () => task,
        getTaskWorkflowSelection: () => ({ workflowId: "WF-001", stepIds: [] }),
        getWorkflowDefinition: async () => ({ ir: selectedIr() }),
        transitionWorkflowWorkItem: (id, state, patch) => {
          transitions.push({ id, state, patch });
          return { ...workItem, state };
        },
      },
      primitives: recordingPrimitives(calls),
      runCustomNode: async (node) => {
        calls.push(`custom:${node.id}`);
        return { outcome: "success" };
      },
    });
    const workItem = {
      id: "work-1",
      runId: "run-1",
      taskId: task.id,
      nodeId: "execute",
      kind: "task",
      state: "running",
      attempt: 0,
      retryAfter: null,
      leaseOwner: "scheduler-a",
      leaseExpiresAt: "2026-06-09T00:01:00.000Z",
      lastError: null,
      blockedReason: null,
      createdAt: "2026-06-09T00:00:00.000Z",
      updatedAt: "2026-06-09T00:00:00.000Z",
    } satisfies WorkflowWorkItem;

    const result = await runtime.runWorkItem(workItem, flagOff);

    expect(result.disposition).toBe("completed");
    expect(calls).toEqual(["prepare-worktree", "execute"]);
    expect(result.visitedNodeIds).toEqual(["execute"]);
    expect(transitions).toEqual([
      {
        id: "work-1",
        state: "succeeded",
        patch: { attempt: 1, leaseOwner: null, leaseExpiresAt: null, lastError: null },
      },
    ]);
  });

  it("fails and releases a workflow work item when the addressed node fails", async () => {
    const transitions: Array<{ id: string; state: WorkflowWorkItemState; patch?: Record<string, unknown> }> = [];
    const workItem = {
      id: "work-2",
      runId: "run-1",
      taskId: task.id,
      nodeId: "execute",
      kind: "task",
      state: "running",
      attempt: 0,
      retryAfter: null,
      leaseOwner: "scheduler-a",
      leaseExpiresAt: "2026-06-09T00:01:00.000Z",
      lastError: null,
      blockedReason: null,
      createdAt: "2026-06-09T00:00:00.000Z",
      updatedAt: "2026-06-09T00:00:00.000Z",
    } satisfies WorkflowWorkItem;
    const runtime = new WorkflowTaskRuntime({
      store: {
        getTask: async () => task,
        getTaskWorkflowSelection: () => ({ workflowId: "WF-001", stepIds: [] }),
        getWorkflowDefinition: async () => ({ ir: selectedIr() }),
        transitionWorkflowWorkItem: (id, state, patch) => {
          transitions.push({ id, state, patch });
          return { ...workItem, state };
        },
      },
      primitives: recordingPrimitives([], { execute: { outcome: "failure", value: "implementation-incomplete" } }),
      runCustomNode: async () => ({ outcome: "success" }),
    });

    const result = await runtime.runWorkItem(workItem, flagOff);

    expect(result.disposition).toBe("failed");
    expect(result.reason).toBe("implementation-incomplete");
    expect(transitions).toEqual([
      {
        id: "work-2",
        state: "failed",
        patch: { attempt: 1, leaseOwner: null, leaseExpiresAt: null, lastError: "implementation-incomplete" },
      },
    ]);
  });

  it("routes merge-gate work items off when task auto-merge is disabled", async () => {
    const transitions: Array<{ id: string; state: WorkflowWorkItemState; patch?: Record<string, unknown> }> = [];
    const workItem = {
      id: "work-merge-gate",
      runId: "run-merge-gate",
      taskId: task.id,
      nodeId: "merge-gate",
      kind: "merge",
      state: "running",
      attempt: 0,
      retryAfter: null,
      leaseOwner: "scheduler-a",
      leaseExpiresAt: "2026-06-09T00:01:00.000Z",
      lastError: null,
      blockedReason: null,
      createdAt: "2026-06-09T00:00:00.000Z",
      updatedAt: "2026-06-09T00:00:00.000Z",
    } satisfies WorkflowWorkItem;
    const runtime = new WorkflowTaskRuntime({
      store: {
        getTask: async () => ({ ...task, autoMerge: false } as TaskDetail),
        getTaskWorkflowSelection: () => undefined,
        getWorkflowDefinition: async () => undefined,
        transitionWorkflowWorkItem: (id, state, patch) => {
          transitions.push({ id, state, patch });
          return { ...workItem, state };
        },
      },
      primitives: recordingPrimitives([]),
      runCustomNode: async () => ({ outcome: "success" }),
    });

    const result = await runtime.runWorkItem(workItem, { ...flagOff, autoMerge: true } as Settings);

    expect(result.disposition).toBe("completed");
    expect(result.context["node:merge-gate:value"]).toBe("auto-off");
    expect(transitions).toEqual([
      {
        id: "work-merge-gate",
        state: "succeeded",
        patch: { attempt: 1, leaseOwner: null, leaseExpiresAt: null, lastError: null },
      },
    ]);
  });

  it("persists manual merge holds as manual-required work items", async () => {
    const transitions: Array<{ id: string; state: WorkflowWorkItemState; patch?: Record<string, unknown> }> = [];
    const workItem = {
      id: "work-manual-hold",
      runId: "run-manual-hold",
      taskId: task.id,
      nodeId: "merge-manual-hold",
      kind: "manual-hold",
      state: "running",
      attempt: 0,
      retryAfter: null,
      leaseOwner: "scheduler-a",
      leaseExpiresAt: "2026-06-09T00:01:00.000Z",
      lastError: null,
      blockedReason: null,
      createdAt: "2026-06-09T00:00:00.000Z",
      updatedAt: "2026-06-09T00:00:00.000Z",
    } satisfies WorkflowWorkItem;
    const runtime = new WorkflowTaskRuntime({
      store: {
        getTask: async () => task,
        getTaskWorkflowSelection: () => undefined,
        getWorkflowDefinition: async () => undefined,
        transitionWorkflowWorkItem: (id, state, patch) => {
          transitions.push({ id, state, patch });
          return { ...workItem, state };
        },
      },
      primitives: recordingPrimitives([]),
      runCustomNode: async () => ({ outcome: "success" }),
    });

    const result = await runtime.runWorkItem(workItem, flagOff);

    expect(result.disposition).toBe("manual-required");
    expect(result.reason).toBe("manual-required");
    expect(transitions).toEqual([
      {
        id: "work-manual-hold",
        state: "manual-required",
        patch: { attempt: 1, leaseOwner: null, leaseExpiresAt: null, lastError: "manual-required" },
      },
    ]);
  });

  it("returns failed without persisting when work item store transitions are unwired", async () => {
    const runtime = new WorkflowTaskRuntime({
      store: {
        getTaskWorkflowSelection: () => undefined,
        getWorkflowDefinition: async () => undefined,
      },
      primitives: recordingPrimitives([]),
      runCustomNode: async () => ({ outcome: "success" }),
    });
    const workItem = {
      id: "work-unwired",
      runId: "run-unwired",
      taskId: task.id,
      nodeId: "merge-gate",
      kind: "merge",
      state: "running",
      attempt: 0,
      retryAfter: null,
      leaseOwner: "scheduler-a",
      leaseExpiresAt: "2026-06-09T00:01:00.000Z",
      lastError: null,
      blockedReason: null,
      createdAt: "2026-06-09T00:00:00.000Z",
      updatedAt: "2026-06-09T00:00:00.000Z",
    } satisfies WorkflowWorkItem;

    await expect(runtime.runWorkItem(workItem, flagOff)).resolves.toEqual(expect.objectContaining({
      disposition: "failed",
      reason: "workflow-work-item-store-unwired",
    }));
  });

  it("threads work item attempt into merge primitive context", async () => {
    const observed: { mergeAttempt?: number; mergeRunId?: string; mergeWorkflowId?: string } = {};
    const transitions: Array<{ id: string; state: WorkflowWorkItemState; patch?: Record<string, unknown> }> = [];
    const workItem = {
      id: "work-merge-attempt",
      runId: "run-merge-attempt",
      taskId: task.id,
      nodeId: "merge-attempt",
      kind: "merge",
      state: "running",
      attempt: 3,
      retryAfter: null,
      leaseOwner: "scheduler-a",
      leaseExpiresAt: "2026-06-09T00:01:00.000Z",
      lastError: null,
      blockedReason: null,
      createdAt: "2026-06-09T00:00:00.000Z",
      updatedAt: "2026-06-09T00:00:00.000Z",
    } satisfies WorkflowWorkItem;
    const runtime = new WorkflowTaskRuntime({
      store: {
        getTask: async () => task,
        getTaskWorkflowSelection: () => undefined,
        getWorkflowDefinition: async () => undefined,
        transitionWorkflowWorkItem: (id, state, patch) => {
          transitions.push({ id, state, patch });
          return { ...workItem, state };
        },
      },
      primitives: recordingPrimitives([], {}, observed),
      runCustomNode: async () => ({ outcome: "success" }),
    });

    const result = await runtime.runWorkItem(workItem, flagOff);

    expect(result.disposition).toBe("completed");
    expect(result.context["workflow:work-item-attempt"]).toBe(3);
    expect(observed.mergeAttempt).toBe(3);
    expect(observed.mergeRunId).toBe("run-merge-attempt");
    expect(observed.mergeWorkflowId).toBe("builtin:coding");
    expect(transitions).toEqual([
      expect.objectContaining({ id: "work-merge-attempt", state: "succeeded" }),
    ]);
  });

  it("backfills a workflow completion summary before resumed merge work items run", async () => {
    const observed: { mergeAttempt?: number; mergeRunId?: string; mergeWorkflowId?: string } = {};
    const updates: Array<{ taskId: string; summary: string }> = [];
    const transitions: Array<{ id: string; state: WorkflowWorkItemState; patch?: Record<string, unknown> }> = [];
    const workItem = {
      id: "work-merge-summary",
      runId: "run-merge-summary",
      taskId: task.id,
      nodeId: "merge-attempt",
      kind: "merge",
      state: "running",
      attempt: 0,
      retryAfter: null,
      leaseOwner: "scheduler-a",
      leaseExpiresAt: "2026-06-09T00:01:00.000Z",
      lastError: null,
      blockedReason: null,
      createdAt: "2026-06-09T00:00:00.000Z",
      updatedAt: "2026-06-09T00:00:00.000Z",
    } satisfies WorkflowWorkItem;
    const runtime = new WorkflowTaskRuntime({
      store: {
        getTask: async () => ({
          ...task,
          title: "Resume merge with summary",
          steps: [{ title: "Finish work", status: "done" }],
        } as TaskDetail),
        getTaskWorkflowSelection: () => undefined,
        getWorkflowDefinition: async () => undefined,
        updateTask: async (taskId, update) => {
          updates.push({ taskId, summary: update.summary });
        },
        transitionWorkflowWorkItem: (id, state, patch) => {
          transitions.push({ id, state, patch });
          return { ...workItem, state };
        },
      },
      primitives: recordingPrimitives([], {}, observed),
      runCustomNode: async () => ({ outcome: "success" }),
    });

    const result = await runtime.runWorkItem(workItem, flagOff);

    expect(result.disposition).toBe("completed");
    expect(updates).toEqual([
      {
        taskId: task.id,
        summary: expect.stringContaining("Workflow completed: Resume merge with summary."),
      },
    ]);
    expect(updates[0]?.summary).toContain("Completion source: workflow-work-item:merge (builtin:coding).");
    expect(observed.mergeRunId).toBe("run-merge-summary");
    expect(transitions).toEqual([
      expect.objectContaining({ id: "work-merge-summary", state: "succeeded" }),
    ]);
  });

  it("uses the built-in workflow id in the default run id for unselected tasks", async () => {
    const observedRunIds: string[] = [];
    const runtime = new WorkflowTaskRuntime({
      store: {
        getTaskWorkflowSelection: () => undefined,
        getWorkflowDefinition: async () => undefined,
      },
      primitives: recordingPrimitives([]),
      runCustomNode: async () => ({ outcome: "success" }),
      branchPersistence: {
        loadBranchStates: (_taskId, runId) => {
          observedRunIds.push(runId);
          return [];
        },
      },
    });

    await runtime.run(task, flagOff);

    expect(observedRunIds).toContain("FN-9002:builtin:coding");
  });

  it("surfaces graph failures as workflow-engine failures, not fallback", async () => {
    const calls: string[] = [];
    const runtime = new WorkflowTaskRuntime({
      store: {
        getTaskWorkflowSelection: () => ({ workflowId: "WF-001", stepIds: [] }),
        getWorkflowDefinition: async () => ({ ir: selectedIr() }),
      },
      primitives: recordingPrimitives(calls, { execute: { outcome: "failure", value: "implementation-incomplete" } }),
      runCustomNode: async (node) => {
        calls.push(`custom:${node.id}`);
        return { outcome: "success" };
      },
    });

    const result = await runtime.run(task, flagOff);

    expect(result.disposition).toBe("failed");
    expect(result.outcome).toBe("failure");
    expect(result.reason).toBe(
      "workflow-node-failed:execute:implementation-incomplete",
    );
    expect(calls).toEqual(["custom:prepare", "prepare-worktree", "execute"]);
  });

  it("converts interpreter throws into workflow-engine failures", async () => {
    const badIr: WorkflowIr = {
      version: "v1",
      name: "bad",
      nodes: [
        { id: "start", kind: "start" },
        { id: "zend", kind: "end" },
      ],
      edges: [{ from: "start", to: "ghost" }],
    };
    const runtime = new WorkflowTaskRuntime({
      store: {
        getTaskWorkflowSelection: () => ({ workflowId: "WF-001", stepIds: [] }),
        getWorkflowDefinition: async () => ({ ir: badIr }),
      },
      primitives: recordingPrimitives([]),
      runCustomNode: async () => ({ outcome: "success" }),
    });

    const result = await runtime.run(task, flagOff);

    expect(result.disposition).toBe("failed");
    expect(result.reason).toMatch(/workflow-execution-error/);
  });

  it("preserves graph node ids when the graph throws after seam and custom side effects", async () => {
    const cyclicIr: WorkflowIr = {
      version: "v1",
      name: "cyclic",
      nodes: [
        { id: "start", kind: "start" },
        { id: "do-execute", kind: "prompt", config: { seam: "execute" } },
        { id: "loop", kind: "prompt", config: { prompt: "loop" } },
      ],
      edges: [
        { from: "start", to: "do-execute", condition: "success" },
        { from: "do-execute", to: "loop", condition: "success" },
        { from: "loop", to: "do-execute", condition: "success" },
      ],
    };
    const runtime = new WorkflowTaskRuntime({
      store: {
        getTaskWorkflowSelection: () => ({ workflowId: "WF-001", stepIds: [] }),
        getWorkflowDefinition: async () => ({ ir: cyclicIr }),
      },
      primitives: recordingPrimitives([]),
      runCustomNode: async () => ({ outcome: "success" }),
    });

    const result = await runtime.run(task, flagOff);

    expect(result.disposition).toBe("failed");
    expect(result.reason).toMatch(/workflow-execution-error/);
    expect(result.visitedNodeIds).toEqual(["do-execute", "loop"]);
  });

  it("diagnostic event failures do not affect execution", async () => {
    const runtime = new WorkflowTaskRuntime({
      store: {
        getTaskWorkflowSelection: () => ({ workflowId: "WF-001", stepIds: [] }),
        getWorkflowDefinition: async () => ({ ir: selectedIr() }),
      },
      primitives: recordingPrimitives([]),
      runCustomNode: async () => ({ outcome: "success" }),
      onEvent: () => {
        throw new Error("diagnostics failed");
      },
    });

    const result = await runtime.run(task, flagOff);

    expect(result.disposition).toBe("completed");
  });
});
