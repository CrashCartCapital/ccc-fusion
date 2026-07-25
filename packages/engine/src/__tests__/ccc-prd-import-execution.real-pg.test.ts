import { expect, it, vi } from "vitest";
import { importCccPrdBundle } from "@fusion/core";
import {
  createCccPrdImportTestBundle,
} from "../../../core/src/__test-utils__/ccc-prd-import-fixture.js";
import {
  createTaskStoreForTest,
  pgDescribe,
} from "../../../core/src/__test-utils__/pg-test-harness.js";
import { WorkflowTaskRuntime } from "../workflow-task-runtime.js";

pgDescribe("CCC PRD imported workflow execution", () => {
  it("claims and executes the imported runnable item through the normal engine path", async () => {
    const harness = await createTaskStoreForTest({
      prefix: "fusion_ccc_prd_execute",
      copyFromGolden: true,
    });
    try {
      const suffix = "engine-execution";
      await importCccPrdBundle({
        bundle: createCccPrdImportTestBundle(harness.rootDir, suffix),
        idempotencyKey: "idem-engine-execution",
        store: harness.store,
        layer: harness.layer,
        rootDir: harness.rootDir,
      });
      const handler = vi.fn(async () => ({ outcome: "success" as const }));
      const runtime = new WorkflowTaskRuntime({
        store: harness.store,
        primitives: {} as never,
        runCustomNode: async () => ({ outcome: "success" }),
        handlers: { prompt: handler },
      });

      const claimed = await harness.store.acquireWorkflowWorkItemLease(
        `WORK-${suffix}`,
        "ccc-prd-test-processor",
        { leaseDurationMs: 60_000 },
      );
      expect(claimed).not.toBeNull();
      const result = await runtime.runWorkItem(claimed!, {});
      const durable = await harness.store.getWorkflowWorkItem(`WORK-${suffix}`);

      expect(result.reason).toBeUndefined();
      expect(result).toMatchObject({
        disposition: "completed",
        outcome: "success",
      });
      expect(handler).toHaveBeenCalledTimes(1);
      expect(durable).toMatchObject({
        state: "succeeded",
        taskId: `TASK-${suffix}`,
      });
    } finally {
      await harness.teardown();
    }
  });
});
