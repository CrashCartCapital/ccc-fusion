// @vitest-environment node
/**
 * FNXC:CccPlanningCustody 2026-10-14-13:41 (card G1, D22):
 * The dashboard's per-task mutation guard also fronts held request-to-code planning tasks, and it fails closed:
 * when the custody lookup itself throws, the mutation is refused instead of reaching a route that would then act
 * on a task whose custody nobody checked. A missing task still passes through, because the `/tasks/:id` prefix
 * also matches collection routes such as `/tasks/batch-update-models`, where the real store's getTask throws
 * "Task <segment> not found". Every refusal is paired with the same request on a twin task that succeeds.
 */
import { describe, expect, it, vi } from "vitest";
import express from "express";
import type { TaskStore } from "@fusion/core";
import { createApiRoutes } from "../../routes.js";
import { request as REQUEST } from "../../test-request.js";

const GUARD_CODE = "CCC_CAMPAIGN_TASK_MUTATION_BLOCKED";
const LOOKUP_FAILED_CODE = "CCC_TASK_CUSTODY_LOOKUP_FAILED";
const RUN_ID = "ccc-plan:0123456789abcdef01234567";
const JSON_HEADERS = { "content-type": "application/json" };

const baseTask = (overrides: Record<string, unknown> = {}) => ({
  id: "FN-TWIN",
  title: "task",
  description: "",
  column: "triage",
  dependencies: [],
  steps: [],
  currentStep: 0,
  log: [],
  comments: [],
  paused: true,
  status: "ccc-planning-held",
  createdAt: "2026-10-14T00:00:00.000Z",
  updatedAt: "2026-10-14T00:00:00.000Z",
  ...overrides,
});

const planningTask = (overrides: Record<string, unknown> = {}) =>
  baseTask({ id: "FN-PLAN", lineageId: RUN_ID, userPaused: false, ...overrides });

/** A store shaped like the real one: getTask throws "Task <id> not found" for an unknown id. */
function harness(
  taskList: Array<Record<string, unknown>>,
  getTaskOverride?: (id: string) => Promise<unknown>,
) {
  const tasks = new Map(taskList.map((task) => [task.id as string, task]));
  const store = {
    getRootDir: vi.fn(() => process.cwd()),
    getPluginStore: vi.fn(() => ({
      init: vi.fn().mockResolvedValue(undefined),
      listPlugins: vi.fn().mockResolvedValue([]),
    })),
    getSettings: vi.fn(async () => ({})),
    getTask: vi.fn(getTaskOverride ?? (async (id: string) => {
      const task = tasks.get(id);
      if (!task) throw new Error(`Task ${id} not found`);
      return task;
    })),
    moveTask: vi.fn(async (id: string, column: string) => ({ ...tasks.get(id), column })),
    deleteTask: vi.fn(async (id: string) => tasks.get(id)),
    pauseTask: vi.fn(async (id: string, paused: boolean) => ({ ...tasks.get(id), paused })),
    updateTask: vi.fn(async (id: string, patch: Record<string, unknown>) => ({ ...tasks.get(id), ...patch })),
    logEntry: vi.fn(async () => undefined),
    listTasks: vi.fn(async () => []),
    archiveTask: vi.fn(async (id: string) => ({ ...tasks.get(id), column: "archived" })),
  } as unknown as TaskStore;

  const app = express();
  app.use(express.json());
  app.use("/api", createApiRoutes(store));
  return { app, store };
}

function expectPlanningRefusal(res: { status: number; body: unknown }, taskId: string): void {
  expect(res.status).toBe(409);
  const body = res.body as { error?: string; details?: { code?: string; taskIds?: string[]; custody?: string } };
  expect(body.details).toMatchObject({ code: GUARD_CODE, taskIds: [taskId], custody: "planning" });
  expect(body.error).toContain("fn plan");
}

describe("ccc planning task mutation guard", () => {
  it("refuses move, unpause, PATCH and delete of a held planning task with 409 naming fn plan; the twin moves", async () => {
    const { app, store } = harness([planningTask(), baseTask()]);

    expectPlanningRefusal(await REQUEST(app, "POST", "/api/tasks/FN-PLAN/move", JSON.stringify({ column: "todo" }), JSON_HEADERS), "FN-PLAN");
    expectPlanningRefusal(await REQUEST(app, "POST", "/api/tasks/FN-PLAN/unpause", JSON.stringify({}), JSON_HEADERS), "FN-PLAN");
    expectPlanningRefusal(await REQUEST(app, "PATCH", "/api/tasks/FN-PLAN", JSON.stringify({ title: "renamed" }), JSON_HEADERS), "FN-PLAN");
    expectPlanningRefusal(await REQUEST(app, "DELETE", "/api/tasks/FN-PLAN"), "FN-PLAN");
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(store.pauseTask).not.toHaveBeenCalled();
    expect(store.updateTask).not.toHaveBeenCalled();
    expect(store.deleteTask).not.toHaveBeenCalled();

    const res = await REQUEST(app, "POST", "/api/tasks/FN-TWIN/move", JSON.stringify({ column: "todo" }), JSON_HEADERS);
    expect(res.status).toBe(200);
    expect(store.moveTask).toHaveBeenCalledWith("FN-TWIN", "todo", expect.anything());
  });

  it("refuses a mutation when the custody lookup throws (fail-closed); the same request with a working lookup moves", async () => {
    // Only the first read fails, as a transient store error would: the route's own later read then succeeds,
    // which is exactly how a fail-open guard lets an unchecked mutation through.
    let reads = 0;
    const failing = harness([baseTask()], async (id: string) => {
      reads += 1;
      if (reads === 1) throw new Error("connection terminated unexpectedly");
      return baseTask({ id });
    });
    const res = await REQUEST(failing.app, "POST", "/api/tasks/FN-TWIN/move", JSON.stringify({ column: "todo" }), JSON_HEADERS);
    expect(res.status).toBe(500);
    const body = res.body as { error?: string; details?: { code?: string; taskIds?: string[] } };
    expect(body.error).toBe("connection terminated unexpectedly");
    expect(body.details).toMatchObject({ code: LOOKUP_FAILED_CODE, taskIds: ["FN-TWIN"] });
    expect(failing.store.moveTask).not.toHaveBeenCalled();
    expect(reads).toBe(1);

    const working = harness([baseTask()]);
    const control = await REQUEST(working.app, "POST", "/api/tasks/FN-TWIN/move", JSON.stringify({ column: "todo" }), JSON_HEADERS);
    expect(control.status).toBe(200);
    expect(working.store.moveTask).toHaveBeenCalledTimes(1);
  });

  it("lets a not-found lookup through, so collection routes under /tasks keep working", async () => {
    const { app, store } = harness([baseTask({ paused: false, status: undefined })]);
    const res = await REQUEST(
      app,
      "POST",
      "/api/tasks/batch-update-models",
      JSON.stringify({ taskIds: ["FN-TWIN"], modelProvider: "anthropic", modelId: "claude-x" }),
      JSON_HEADERS,
    );
    expect(res.status).toBe(200);
    expect(store.updateTask).toHaveBeenCalledTimes(1);
  });

  it("lets a store with no task read through, as the partial stores of route tests are", async () => {
    const store = {
      getRootDir: vi.fn(() => process.cwd()),
      getPluginStore: vi.fn(() => ({
        init: vi.fn().mockResolvedValue(undefined),
        listPlugins: vi.fn().mockResolvedValue([]),
      })),
      mergeTask: vi.fn(),
    } as unknown as TaskStore;
    const onMerge = vi.fn(async (id: string) => ({
      task: { id, column: "done" },
      branch: `fusion/${id.toLowerCase()}`,
      merged: true,
      worktreeRemoved: false,
      branchDeleted: false,
    }));
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store, { onMerge }));
    const res = await REQUEST(app, "POST", "/api/tasks/FN-TWIN/merge");
    expect(res.status).toBe(200);
    expect(onMerge).toHaveBeenCalledWith("FN-TWIN");
  });

  it("lets an ENOENT-coded not-found lookup through, so the route still answers its own 404 for a missing task", async () => {
    const { app, store } = harness([], async () => {
      throw Object.assign(new Error("Task not found"), { code: "ENOENT" });
    });
    const res = await REQUEST(app, "POST", "/api/tasks/FN-GONE/approve-plan");
    expect(res.status).toBe(404);
    expect((res.body as { details?: { code?: string } }).details?.code).not.toBe(LOOKUP_FAILED_CODE);
    // The guard's read and the route's own read: the request reached the route.
    expect(store.getTask).toHaveBeenCalledTimes(2);
  });
});
