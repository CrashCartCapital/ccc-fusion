import { expect, it } from "vitest";
import type { TaskDetail, WorkflowIr } from "@fusion/core";
import { createTaskStoreForTest, pgDescribe } from "../../../core/src/__test-utils__/pg-test-harness.js";
import { PermanentError, TransientError } from "../engine-errors.js";
import { WorkflowTaskRuntime } from "../workflow-task-runtime.js";

const retryIr: WorkflowIr = {
  version: "v2",
  name: "ccc-wave-4-retry",
  columns: [],
  nodes: [{ id: "retry", kind: "prompt", config: { maxRetries: 3 } }],
  edges: [],
};

function runtimeFor(store: any, handler: () => Promise<{ outcome: "success" }>): WorkflowTaskRuntime {
  const getTask = store.getTask.bind(store);
  return new WorkflowTaskRuntime({
    store: Object.assign(store, {
      getTask: async (taskId: string) => ({ ...await getTask(taskId), customFields: { cccFusionProfile: "ccc-fusion" } }),
      getTaskWorkflowSelection: () => ({ workflowId: "ccc-wave-4-retry" }),
      getTaskWorkflowSelectionAsync: async () => ({ workflowId: "ccc-wave-4-retry" }),
      getWorkflowDefinition: async () => ({ id: "ccc-wave-4-retry", ir: retryIr }),
    }),
    primitives: {} as never,
    runCustomNode: async () => ({ outcome: "success" }),
    handlers: { prompt: async () => handler() },
  });
}

pgDescribe("CCC Wave 4 PostgreSQL retry classification", () => {
  it("Wave 4 RED: transient failure consumes exactly the configured total attempt count", async () => {
    const harness = await createTaskStoreForTest({ prefix: "fusion_ccc_wave4_retry", copyFromGolden: true });
    try {
      const task = await harness.store.createTask({ description: "CCC transient retry" });
      const item = await harness.store.upsertWorkflowWorkItem({
        runId: "wave4-retry-run",
        taskId: task.id,
        nodeId: "retry",
        kind: "task",
        state: "running",
        attempt: 1,
      });
      let calls = 0;
      const runtime = runtimeFor(harness.store, async () => {
        calls += 1;
        if (calls < 3) throw new TransientError("temporary test failure");
        return { outcome: "success" };
      });

      const result = await runtime.runWorkItem(item, {});
      const durable = await harness.store.getWorkflowWorkItem(item.id);
      const audit = await harness.store.getRunAuditEventsAsync({ runId: "wave4-retry-run" });

      expect(result.disposition).toBe("completed");
      expect(calls).toBe(3);
      expect(durable).toEqual(expect.objectContaining({ state: "succeeded", attempt: 3 }));
      expect(audit.filter((event) => event.mutationType === "workflow:work-item-transition").reverse().map((event) => ({ mutationType: event.mutationType, state: event.metadata?.state, attempt: event.metadata?.attempt, classification: event.metadata?.classification }))).toEqual([
        { mutationType: "workflow:work-item-transition", state: "retrying", attempt: 1, classification: "ccc-transient-retry" },
        { mutationType: "workflow:work-item-transition", state: "running", attempt: 2, classification: "ccc-transient-resume" },
        { mutationType: "workflow:work-item-transition", state: "retrying", attempt: 2, classification: "ccc-transient-retry" },
        { mutationType: "workflow:work-item-transition", state: "running", attempt: 3, classification: "ccc-transient-resume" },
        { mutationType: "workflow:work-item-transition", state: "succeeded", attempt: 3, classification: "ccc-transient-succeeded" },
      ]);
    } finally {
      await harness.teardown();
    }
  });

  it("Wave 4 RED: permanent failure is attempted once and parks manual-required", async () => {
    const harness = await createTaskStoreForTest({ prefix: "fusion_ccc_wave4_permanent", copyFromGolden: true });
    try {
      const task = await harness.store.createTask({ description: "CCC permanent retry classification" });
      const item = await harness.store.upsertWorkflowWorkItem({
        runId: "wave4-permanent-run",
        taskId: task.id,
        nodeId: "retry",
        kind: "task",
        state: "running",
        attempt: 1,
      });
      let calls = 0;
      const runtime = runtimeFor(harness.store, async () => {
        calls += 1;
        throw new PermanentError("permanent test failure", "CCC_PERMANENT");
      });

      const result = await runtime.runWorkItem(item, {});
      const durable = await harness.store.getWorkflowWorkItem(item.id);
      const audit = await harness.store.getRunAuditEventsAsync({ runId: "wave4-permanent-run" });

      expect(result.disposition).toBe("manual-required");
      expect(calls).toBe(1);
      expect(durable).toEqual(expect.objectContaining({
        state: "manual-required",
        attempt: 1,
        blockedReason: "ccc-permanent:CCC_PERMANENT",
      }));
      expect(audit.filter((event) => event.mutationType === "workflow:work-item-transition").map((event) => ({ state: event.metadata?.state, classification: event.metadata?.classification }))).toEqual([{ state: "manual-required", classification: "ccc-permanent" }]);
    } finally {
      await harness.teardown();
    }
  });

  it("Wave 4 RED: transient exhaustion consumes three calls and parks exhausted", async () => {
    const harness = await createTaskStoreForTest({ prefix: "fusion_ccc_wave4_exhausted", copyFromGolden: true });
    try {
      const task = await harness.store.createTask({ description: "CCC transient exhaustion" });
      const item = await harness.store.upsertWorkflowWorkItem({ runId: "wave4-exhausted-run", taskId: task.id, nodeId: "retry", kind: "task", state: "running", attempt: 1 });
      let calls = 0;
      const result = await runtimeFor(harness.store, async () => { calls += 1; throw new TransientError("always transient", "CCC_TRANSIENT"); }).runWorkItem(item, {});
      const durable = await harness.store.getWorkflowWorkItem(item.id);
      expect(calls).toBe(3);
      expect(result.disposition).toBe("failed");
      expect(durable).toEqual(expect.objectContaining({ state: "exhausted", attempt: 3 }));
      const audit = await harness.store.getRunAuditEventsAsync({ runId: "wave4-exhausted-run" });
      expect(audit.filter((event) => event.mutationType === "workflow:work-item-transition").reverse().map((event) => ({ state: event.metadata?.state, attempt: event.metadata?.attempt, classification: event.metadata?.classification }))).toEqual([
        { state: "retrying", attempt: 1, classification: "ccc-transient-retry" },
        { state: "running", attempt: 2, classification: "ccc-transient-resume" },
        { state: "retrying", attempt: 2, classification: "ccc-transient-retry" },
        { state: "running", attempt: 3, classification: "ccc-transient-resume" },
        { state: "exhausted", attempt: 3, classification: "ccc-transient-exhausted" },
      ]);
    } finally { await harness.teardown(); }
  });

  it("Wave 4 RED: consumed retrying cap fails closed without another handler call", async () => {
    const harness = await createTaskStoreForTest({ prefix: "fusion_ccc_wave4_consumed", copyFromGolden: true });
    try {
      const task = await harness.store.createTask({ description: "CCC consumed retry cap" });
      const item = await harness.store.upsertWorkflowWorkItem({ runId: "wave4-consumed-run", taskId: task.id, nodeId: "retry", kind: "task", state: "retrying", attempt: 3 });
      let calls = 0;
      const result = await runtimeFor(harness.store, async () => { calls += 1; return { outcome: "success" }; }).runWorkItem(item, {});
      const durable = await harness.store.getWorkflowWorkItem(item.id);
      expect(result.disposition).toBe("failed");
      expect(calls).toBe(0);
      expect(durable).toEqual(expect.objectContaining({ state: "exhausted", attempt: 3, lastError: "ccc-transient-retry-exhausted" }));
      const audit = await harness.store.getRunAuditEventsAsync({ runId: "wave4-consumed-run" });
      expect(audit.filter((event) => event.mutationType === "workflow:work-item-transition").map((event) => event.metadata)).toEqual([
        { state: "exhausted", attempt: 3, classification: "ccc-transient-exhausted" },
      ]);
    } finally { await harness.teardown(); }
  });
});
