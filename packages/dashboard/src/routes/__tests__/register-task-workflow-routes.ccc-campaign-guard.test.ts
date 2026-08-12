// @vitest-environment node
//
// 2026-08-11 top-down audit, Lane A: imported CCC campaign tasks appear as
// ordinary board cards, but their lifecycle (pause receipts, digest-confirmed
// approvals, hard-cancel semantics) is owned by the `fn prd` CLI. Every generic
// dashboard task mutation endpoint must therefore refuse campaign-custody tasks
// with a 409 + stable code (mirroring the approvals-surface refusal in
// register-approval-routes.ts), while read-only endpoints stay open so campaign
// tasks remain visible on the board.

import { describe, it, expect, vi } from "vitest";
import express from "express";
import type { TaskStore } from "@fusion/core";
import { createApiRoutes } from "../../routes.js";
import { request as REQUEST } from "../../test-request.js";

const GUARD_CODE = "CCC_CAMPAIGN_TASK_MUTATION_BLOCKED";

// Same compiler-owned lineage shape the engine's isCccCampaignTask matches
// (ccc-prd:<24-hex identity>:<semantic id>), mirroring engine test fixtures.
const CAMPAIGN_LINEAGE = "ccc-prd:0123456789abcdef01234567:TASK-1";

const baseTask = (overrides: Record<string, unknown> = {}) => ({
  id: "FN-001",
  title: "task",
  description: "",
  column: "todo",
  dependencies: [],
  steps: [],
  currentStep: 0,
  log: [],
  comments: [],
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  ...overrides,
});

const campaignTask = (overrides: Record<string, unknown> = {}) =>
  baseTask({
    id: "FN-CCC",
    lineageId: CAMPAIGN_LINEAGE,
    column: "triage",
    status: "ccc-prd-import-prepared",
    paused: true,
    userPaused: true,
    ...overrides,
  });

function harness(taskList: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) {
  const tasks = new Map(taskList.map((task) => [task.id as string, task]));
  const store = {
    getRootDir: vi.fn(() => process.cwd()),
    getPluginStore: vi.fn(() => ({
      init: vi.fn().mockResolvedValue(undefined),
      listPlugins: vi.fn().mockResolvedValue([]),
    })),
    getSettings: vi.fn(async () => ({})),
    getTask: vi.fn(async (id: string) => tasks.get(id)),
    moveTask: vi.fn(async (id: string, column: string) => ({ ...tasks.get(id), column })),
    deleteTask: vi.fn(async (id: string) => tasks.get(id)),
    mergeTask: vi.fn(async (id: string) => ({ ...tasks.get(id), column: "done" })),
    pauseTask: vi.fn(async (id: string, paused: boolean) => ({ ...tasks.get(id), paused })),
    updateTask: vi.fn(async (id: string, patch: Record<string, unknown>) => ({ ...tasks.get(id), ...patch })),
    logEntry: vi.fn(async () => undefined),
    listTasks: vi.fn(async () => []),
    archiveAllDone: vi.fn(async () => []),
    archiveTask: vi.fn(async (id: string) => ({ ...tasks.get(id), column: "archived" })),
    ...extra,
  } as unknown as TaskStore;

  const app = express();
  app.use(express.json());
  app.use("/api", createApiRoutes(store));
  return { app, store };
}

function expectGuardRefusal(res: { status: number; body: unknown }): void {
  expect(res.status).toBe(409);
  const body = res.body as { error?: string; details?: { code?: string } };
  expect(body.details?.code).toBe(GUARD_CODE);
  expect(body.error).toContain("fn prd");
}

describe("ccc campaign task mutation guard — refusals", () => {
  it("refuses move with 409 + stable code and never calls moveTask", async () => {
    const { app, store } = harness([campaignTask()]);
    const res = await REQUEST(app, "POST", "/api/tasks/FN-CCC/move", JSON.stringify({ column: "todo" }), {
      "content-type": "application/json",
    });
    expectGuardRefusal(res);
    expect(store.moveTask).not.toHaveBeenCalled();
  });

  it("refuses delete with 409 + stable code and never calls deleteTask", async () => {
    const { app, store } = harness([campaignTask()]);
    const res = await REQUEST(app, "DELETE", "/api/tasks/FN-CCC");
    expectGuardRefusal(res);
    expect(store.deleteTask).not.toHaveBeenCalled();
  });

  it("refuses retry with 409 + stable code and never mutates the task", async () => {
    const { app, store } = harness([campaignTask({ status: "failed", column: "in-progress" })]);
    const res = await REQUEST(app, "POST", "/api/tasks/FN-CCC/retry", JSON.stringify({}), {
      "content-type": "application/json",
    });
    expectGuardRefusal(res);
    expect(store.updateTask).not.toHaveBeenCalled();
    expect(store.moveTask).not.toHaveBeenCalled();
  });

  it("refuses merge with 409 + stable code and never calls mergeTask", async () => {
    const { app, store } = harness([campaignTask()]);
    const res = await REQUEST(app, "POST", "/api/tasks/FN-CCC/merge", JSON.stringify({}), {
      "content-type": "application/json",
    });
    expectGuardRefusal(res);
    expect(store.mergeTask).not.toHaveBeenCalled();
  });

  it("refuses pause and unpause with 409 + stable code", async () => {
    const { app, store } = harness([campaignTask()]);
    const pauseRes = await REQUEST(app, "POST", "/api/tasks/FN-CCC/pause", JSON.stringify({}), {
      "content-type": "application/json",
    });
    expectGuardRefusal(pauseRes);
    const unpauseRes = await REQUEST(app, "POST", "/api/tasks/FN-CCC/unpause", JSON.stringify({}), {
      "content-type": "application/json",
    });
    expectGuardRefusal(unpauseRes);
    expect(store.pauseTask).not.toHaveBeenCalled();
  });

  it("refuses reset and revert with 409 + stable code", async () => {
    const { app, store } = harness([campaignTask({ column: "done" })]);
    const resetRes = await REQUEST(app, "POST", "/api/tasks/FN-CCC/reset", JSON.stringify({}), {
      "content-type": "application/json",
    });
    expectGuardRefusal(resetRes);
    const revertRes = await REQUEST(app, "POST", "/api/tasks/FN-CCC/revert", JSON.stringify({}), {
      "content-type": "application/json",
    });
    expectGuardRefusal(revertRes);
    expect(store.updateTask).not.toHaveBeenCalled();
  });

  it("refuses generic PATCH /tasks/:id with 409 + stable code", async () => {
    const { app, store } = harness([campaignTask()]);
    const res = await REQUEST(app, "PATCH", "/api/tasks/FN-CCC", JSON.stringify({ title: "renamed" }), {
      "content-type": "application/json",
    });
    expectGuardRefusal(res);
    expect(store.updateTask).not.toHaveBeenCalled();
  });

  it("covers mutation routes registered by later registrars (pr/merge)", async () => {
    const { app } = harness([campaignTask()]);
    const res = await REQUEST(app, "POST", "/api/tasks/FN-CCC/pr/merge", JSON.stringify({}), {
      "content-type": "application/json",
    });
    expectGuardRefusal(res);
  });

  it("also matches the pre-product customFields campaign profile marker", async () => {
    const { app, store } = harness([
      baseTask({ id: "FN-PROF", customFields: { cccFusionProfile: "ccc-fusion" } }),
    ]);
    const res = await REQUEST(app, "POST", "/api/tasks/FN-PROF/move", JSON.stringify({ column: "triage" }), {
      "content-type": "application/json",
    });
    expectGuardRefusal(res);
    expect(store.moveTask).not.toHaveBeenCalled();
  });
});

describe("ccc campaign task mutation guard — reads stay open", () => {
  it("still serves GET reads for campaign tasks", async () => {
    const { app } = harness([campaignTask()]);
    const res = await REQUEST(app, "GET", "/api/tasks/FN-CCC/comments");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe("ccc campaign task mutation guard — ordinary tasks unaffected", () => {
  it("moves an ordinary task", async () => {
    const { app, store } = harness([baseTask()]);
    const res = await REQUEST(app, "POST", "/api/tasks/FN-001/move", JSON.stringify({ column: "triage" }), {
      "content-type": "application/json",
    });
    expect(res.status).toBe(200);
    expect(store.moveTask).toHaveBeenCalledTimes(1);
  });

  it("deletes an ordinary task", async () => {
    const { app, store } = harness([baseTask()]);
    const res = await REQUEST(app, "DELETE", "/api/tasks/FN-001");
    expect(res.status).toBe(200);
    expect(store.deleteTask).toHaveBeenCalledTimes(1);
  });

  it("retries an ordinary failed task", async () => {
    const { app, store } = harness([baseTask({ column: "in-progress", status: "failed" })]);
    const res = await REQUEST(app, "POST", "/api/tasks/FN-001/retry", JSON.stringify({}), {
      "content-type": "application/json",
    });
    expect(res.status).toBe(200);
    expect(store.updateTask).toHaveBeenCalled();
    expect(store.moveTask).toHaveBeenCalledTimes(1);
  });

  it("merges an ordinary task", async () => {
    const { app, store } = harness([baseTask()]);
    const res = await REQUEST(app, "POST", "/api/tasks/FN-001/merge", JSON.stringify({}), {
      "content-type": "application/json",
    });
    expect(res.status).toBe(200);
    expect(store.mergeTask).toHaveBeenCalledTimes(1);
  });
});

describe("ccc campaign task mutation guard — bulk endpoints", () => {
  it("refuses batch-update-models when any target is a campaign task", async () => {
    const { app, store } = harness([baseTask(), campaignTask()]);
    const res = await REQUEST(
      app,
      "POST",
      "/api/tasks/batch-update-models",
      JSON.stringify({ taskIds: ["FN-001", "FN-CCC"], modelProvider: "anthropic", modelId: "claude-x" }),
      { "content-type": "application/json" },
    );
    expectGuardRefusal(res);
    const body = res.body as { details?: { taskIds?: string[] } };
    expect(body.details?.taskIds).toEqual(["FN-CCC"]);
    expect(store.updateTask).not.toHaveBeenCalled();
  });

  it("still batch-updates models for ordinary tasks only", async () => {
    const { app, store } = harness([baseTask()]);
    const res = await REQUEST(
      app,
      "POST",
      "/api/tasks/batch-update-models",
      JSON.stringify({ taskIds: ["FN-001"], modelProvider: "anthropic", modelId: "claude-x" }),
      { "content-type": "application/json" },
    );
    expect(res.status).toBe(200);
    expect(store.updateTask).toHaveBeenCalledTimes(1);
  });

  it("archive-all-done skips campaign tasks and reports them", async () => {
    const ordinaryDone = baseTask({ id: "FN-002", column: "done" });
    const campaignDone = campaignTask({ id: "FN-CCC-2", lineageId: "ccc-prd:0123456789abcdef01234567:TASK-2", column: "done" });
    const { app, store } = harness([ordinaryDone, campaignDone], {
      listTasks: vi.fn(async () => [ordinaryDone, campaignDone]),
    });
    const res = await REQUEST(app, "POST", "/api/tasks/archive-all-done", JSON.stringify({}), {
      "content-type": "application/json",
    });
    expect(res.status).toBe(200);
    const body = res.body as { archived: Array<{ id: string }>; skippedCccCampaignTaskIds?: string[] };
    expect(body.archived.map((task) => task.id)).toEqual(["FN-002"]);
    expect(body.skippedCccCampaignTaskIds).toEqual(["FN-CCC-2"]);
    expect(store.archiveTask).toHaveBeenCalledTimes(1);
    expect(store.archiveTask).toHaveBeenCalledWith("FN-002", expect.objectContaining({ cleanup: true }));
    expect(store.archiveAllDone).not.toHaveBeenCalled();
  });

  it("archive-all-done delegates to the store when no campaign task is done", async () => {
    const ordinaryDone = baseTask({ id: "FN-002", column: "done" });
    const { app, store } = harness([ordinaryDone], {
      listTasks: vi.fn(async () => [ordinaryDone]),
      archiveAllDone: vi.fn(async () => [{ ...ordinaryDone, column: "archived" }]),
    });
    const res = await REQUEST(app, "POST", "/api/tasks/archive-all-done", JSON.stringify({}), {
      "content-type": "application/json",
    });
    expect(res.status).toBe(200);
    const body = res.body as { archived: Array<{ id: string }>; skippedCccCampaignTaskIds?: string[] };
    expect(body.archived.map((task) => task.id)).toEqual(["FN-002"]);
    expect(body.skippedCccCampaignTaskIds).toBeUndefined();
    expect(store.archiveAllDone).toHaveBeenCalledTimes(1);
    expect(store.archiveTask).not.toHaveBeenCalled();
  });
});
