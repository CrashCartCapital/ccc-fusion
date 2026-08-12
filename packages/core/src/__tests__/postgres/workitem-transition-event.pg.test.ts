/**
 * FNXC:CampaignNotifications 2026-08-11-00:00:
 * TaskStore must emit `workitem:transitioned` after a successful, transaction-free
 * `transitionWorkflowWorkItem` so the engine NotificationService can observe campaign
 * work-item parks (manual-required with a ccc-* reason) and terminal failures
 * (failed/exhausted) without hooking every scattered engine call site. The event is
 * the store-level funnel: startup recovery parks, provider-dispatch parks, and
 * workflow runtime terminal transitions all pass through this one method.
 *
 * Transactions are excluded on purpose: a caller-owned tx can still roll back after
 * the transition resolves, and notification listeners must never observe uncommitted
 * state as fact.
 */

import { afterAll, beforeAll, beforeEach, afterEach, expect, it } from "vitest";

import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import type { WorkflowWorkItem } from "../../types/merge-queue.js";

const pgTest = pgDescribe;

pgTest("TaskStore workitem:transitioned event (PostgreSQL backend mode)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_workitem_events",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  it("emits workitem:transitioned with the persisted row on a manual-required park", async () => {
    const store = h.store();
    const task = await h.createTestTask();
    const item = await store.upsertWorkflowWorkItem({
      runId: "ccc-prd:import-evt-1",
      stableWorkflowRunId: "ccc-prd:import-evt-1",
      irHash: "a".repeat(64),
      taskId: task.id,
      nodeId: "node-1",
      kind: "task",
      state: "running",
    });

    const events: WorkflowWorkItem[] = [];
    store.on("workitem:transitioned", (workItem) => events.push(workItem));

    const reason = "ccc-permanent:CCC_CAMPAIGN_MERGE_APPROVAL_REQUIRED";
    await store.transitionWorkflowWorkItem(item.id, "manual-required", {
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: reason,
      blockedReason: reason,
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: item.id,
      taskId: task.id,
      runId: "ccc-prd:import-evt-1",
      state: "manual-required",
      blockedReason: reason,
      lastError: reason,
    });
  });

  it("emits on terminal failed/exhausted transitions too", async () => {
    const store = h.store();
    const task = await h.createTestTask();
    const item = await store.upsertWorkflowWorkItem({
      runId: "ccc-prd:import-evt-2",
      stableWorkflowRunId: "ccc-prd:import-evt-2",
      irHash: "b".repeat(64),
      taskId: task.id,
      nodeId: "node-1",
      kind: "task",
      state: "running",
    });

    const events: WorkflowWorkItem[] = [];
    store.on("workitem:transitioned", (workItem) => events.push(workItem));

    await store.transitionWorkflowWorkItem(item.id, "exhausted", {
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: "ccc-transient-retry-exhausted",
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: item.id,
      state: "exhausted",
      lastError: "ccc-transient-retry-exhausted",
    });
  });

  it("does NOT emit when the transition runs inside a caller-owned transaction", async () => {
    const store = h.store();
    const task = await h.createTestTask();
    const item = await store.upsertWorkflowWorkItem({
      runId: "run-tx-1",
      taskId: task.id,
      nodeId: "node-1",
      kind: "task",
      state: "running",
    });

    const events: WorkflowWorkItem[] = [];
    store.on("workitem:transitioned", (workItem) => events.push(workItem));

    await h.layer().db.transaction(async (tx) => {
      await store.transitionWorkflowWorkItem(
        item.id,
        "failed",
        { leaseOwner: null, leaseExpiresAt: null, lastError: "boom" },
        tx,
      );
    });

    expect(events).toHaveLength(0);
    // The transition itself still landed.
    const persisted = await store.getWorkflowWorkItem(item.id);
    expect(persisted?.state).toBe("failed");
  });

  it("a listener throw never breaks the state transition", async () => {
    const store = h.store();
    const task = await h.createTestTask();
    const item = await store.upsertWorkflowWorkItem({
      runId: "run-listener-throw",
      taskId: task.id,
      nodeId: "node-1",
      kind: "task",
      state: "running",
    });

    store.on("workitem:transitioned", () => {
      throw new Error("listener exploded");
    });

    const transitioned = await store.transitionWorkflowWorkItem(item.id, "succeeded", {
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: null,
    });
    expect(transitioned.state).toBe("succeeded");
  });
});
