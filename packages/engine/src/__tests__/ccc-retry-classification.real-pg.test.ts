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
  return new WorkflowTaskRuntime({
    store: Object.assign(store, {
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

      expect(result.disposition).toBe("completed");
      expect(calls).toBe(3);
      expect(durable).toEqual(expect.objectContaining({ state: "succeeded", attempt: 3 }));
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

      expect(result.disposition).toBe("manual-required");
      expect(calls).toBe(1);
      expect(durable).toEqual(expect.objectContaining({
        state: "manual-required",
        attempt: 1,
        blockedReason: "ccc-permanent:CCC_PERMANENT",
      }));
    } finally {
      await harness.teardown();
    }
  });
});
