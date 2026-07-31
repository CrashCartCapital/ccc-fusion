// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import express from "express";
import type { TaskStore } from "@fusion/core";
import { createApiRoutes } from "../../routes.js";
import { request as REQUEST } from "../../test-request.js";

describe("task workflow merge route", () => {
  it("invokes engine.onMerge for manual merge requests", async () => {
    const store: TaskStore = {
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

    const res = await REQUEST(app, "POST", "/api/tasks/FN-5438/merge");

    expect(res.status).toBe(200);
    expect(onMerge).toHaveBeenCalledWith("FN-5438");
    expect((res.body as { merged: boolean }).merged).toBe(true);
  });
});
