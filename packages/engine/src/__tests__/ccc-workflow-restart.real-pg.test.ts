import { once } from "node:events";
import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import type { TaskDetail, WorkflowIr } from "@fusion/core";
import { createTaskStoreForTest, pgDescribe } from "../../../core/src/__test-utils__/pg-test-harness.js";
import { WorkflowGraphExecutor } from "../workflow-graph-executor.js";
import type { WorkflowBranchPersistence } from "../workflow-graph-branches.js";

const wave4Ir: WorkflowIr = {
  version: "v2",
  name: "ccc-wave-4",
  columns: [{ id: "work", name: "Work", traits: [] }],
  nodes: [
    { id: "start", kind: "start" },
    { id: "A", kind: "prompt", config: {} },
    { id: "split", kind: "split", config: {} },
    { id: "B", kind: "prompt", config: {} },
    { id: "C", kind: "prompt", config: {} },
    { id: "join", kind: "join", config: { mode: "all" } },
    { id: "D", kind: "prompt", config: {} },
    { id: "end", kind: "end" },
  ],
  edges: [
    { from: "start", to: "A" },
    { from: "A", to: "split" },
    { from: "split", to: "B" },
    { from: "split", to: "C" },
    { from: "B", to: "join", condition: "success" },
    { from: "C", to: "join", condition: "success" },
    { from: "join", to: "D", condition: "success" },
    { from: "D", to: "end" },
  ],
};

function pgBranchPersistence(store: {
  saveWorkflowRunBranch(state: { taskId: string; runId: string; branchId: string; currentNodeId: string; status: string }): Promise<void>;
  loadWorkflowRunBranches(taskId: string, runId: string): Promise<Array<{ taskId: string; runId: string; branchId: string; currentNodeId: string; status: "running" | "completed" | "failed" | "aborted" }>>;
  clearWorkflowRunBranches(taskId: string, keepRunId: string): Promise<void>;
}): WorkflowBranchPersistence {
  return {
    saveBranchState: (state) => store.saveWorkflowRunBranch(state),
    loadBranchStates: (taskId, runId) => store.loadWorkflowRunBranches(taskId, runId),
    clearStaleBranchStates: (taskId, runId) => store.clearWorkflowRunBranches(taskId, runId),
  };
}

function asCccTask(task: TaskDetail): TaskDetail {
  return { ...task, customFields: { ...task.customFields, cccFusionProfile: "ccc-fusion" } };
}

function controllerProgram(repoRoot: string): string {
  return `
    try {
    const { TaskStore } = await import(${JSON.stringify(`${repoRoot}/packages/core/src/store.ts`)});
    const { createConnectionSetFromUrl } = await import(${JSON.stringify(`${repoRoot}/packages/core/src/postgres/connection.ts`)});
    const { createAsyncDataLayer } = await import(${JSON.stringify(`${repoRoot}/packages/core/src/postgres/data-layer.ts`)});
    const { WorkflowGraphExecutor } = await import(${JSON.stringify(`${repoRoot}/packages/engine/src/workflow-graph-executor.ts`)});
    const [url, rootDir, taskId, runId, mode] = process.argv.slice(1);
    const connections = await createConnectionSetFromUrl({ mode: "external", runtimeUrl: url, migrationUrl: url, migrationUrlOverridden: false }, { poolMax: 2, connectTimeoutSeconds: 5 });
    const layer = createAsyncDataLayer(connections);
    const store = new TaskStore(rootDir, undefined, { asyncLayer: layer });
    await store.init();
    const persisted = {
      saveBranchState: async (state) => {
        await store.saveWorkflowRunBranch(state);
        if (mode === "hold-after-frontier" && state.branchId === "__ccc_frontier__:A") {
          emit("frontier-committed", "A");
          await new Promise(() => {});
        }
      },
      loadBranchStates: (id, stableRunId) => store.loadWorkflowRunBranches(id, stableRunId),
      clearStaleBranchStates: (id, stableRunId) => store.clearWorkflowRunBranches(id, stableRunId),
    };
    const loaded = await store.getTask(taskId);
    const task = { ...loaded, customFields: { ...loaded.customFields, cccFusionProfile: "ccc-fusion" } };
    const emit = (event, node) => process.stdout.write(JSON.stringify({ event, node }) + "\\n");
    const executor = new WorkflowGraphExecutor({
      runId,
      branchPersistence: persisted,
      handlers: {
        prompt: async (node) => {
          if (node.id === "C") {
            emit("held-before-effect", node.id);
            await new Promise(() => {});
          }
          emit("effect", node.id);
          return { outcome: "success" };
        },
      },
    });
    await executor.run(task, {}, ${JSON.stringify(wave4Ir)});
    } catch (error) {
      process.stderr.write(error instanceof Error ? error.stack + "\\n" : String(error) + "\\n");
      process.exitCode = 1;
    }
  `;
}

pgDescribe("CCC Wave 4 PostgreSQL branch persistence", () => {
  it("Wave 4 control: PostgreSQL persists uninterrupted A → {B,C} → D", async () => {
    const harness = await createTaskStoreForTest({ prefix: "fusion_ccc_wave4_control", copyFromGolden: true });
    try {
      const created = await harness.store.createTask({ description: "CCC Wave 4 real PostgreSQL control" });
      const task: TaskDetail = { ...created, customFields: { cccFusionProfile: "ccc-fusion" } };
      const calls: string[] = [];
      const runId = `${task.id}:ccc-wave-4`;
      const executor = new WorkflowGraphExecutor({
        runId,
        branchPersistence: pgBranchPersistence(harness.store),
        handlers: {
          prompt: async (node) => {
            calls.push(node.id);
            return { outcome: "success" as const };
          },
        },
      });

      const result = await executor.run(task as TaskDetail, {}, wave4Ir);

      expect(result.outcome).toBe("success");
      expect(calls).toEqual(expect.arrayContaining(["A", "B", "C", "D"]));
      expect(calls.filter((id) => id === "A")).toHaveLength(1);
      expect(calls.filter((id) => id === "B")).toHaveLength(1);
      expect(calls.filter((id) => id === "C")).toHaveLength(1);
      expect(calls.filter((id) => id === "D")).toHaveLength(1);
      expect(await harness.store.loadWorkflowRunBranches(task.id, runId)).toEqual(expect.arrayContaining([
        expect.objectContaining({ branchId: "B", status: "completed", currentNodeId: "B" }),
        expect.objectContaining({ branchId: "C", status: "completed", currentNodeId: "C" }),
      ]));
    } finally {
      await harness.teardown();
    }
  });

  it("Wave 4 RED: ccc branch admission failure stops before the first branch effect", async () => {
    const harness = await createTaskStoreForTest({ prefix: "fusion_ccc_wave4_admission", copyFromGolden: true });
    try {
      const created = await harness.store.createTask({ description: "CCC branch admission failure" });
      const task: TaskDetail = { ...created, customFields: { cccFusionProfile: "ccc-fusion" } };
      const calls: string[] = [];
      const executor = new WorkflowGraphExecutor({
        runId: `${task.id}:ccc-wave-4`,
        branchPersistence: {
          ...pgBranchPersistence(harness.store),
          saveBranchState: async (state) => {
            if (state.branchId.startsWith("__ccc_frontier__:")) {
              await harness.store.saveWorkflowRunBranch(state);
              return;
            }
            throw new Error("injected durable admission failure");
          },
        },
        handlers: {
          prompt: async (node) => {
            calls.push(node.id);
            return { outcome: "success" as const };
          },
        },
      });

      const result = await executor.run(task as TaskDetail, {}, wave4Ir);

      expect(result.outcome).toBe("failure");
      expect(calls).toEqual(["A"]);
      expect(result.context["ccc:branch-persistence-failure"]).toBe("ccc-branch-persistence-admission-failed");
    } finally {
      await harness.teardown();
    }
  });

  it("Wave 4 RED: ccc terminal branch checkpoint failure blocks the join successor", async () => {
    const harness = await createTaskStoreForTest({ prefix: "fusion_ccc_wave4_terminal", copyFromGolden: true });
    try {
      const created = await harness.store.createTask({ description: "CCC terminal branch checkpoint failure" });
      const task: TaskDetail = { ...created, customFields: { cccFusionProfile: "ccc-fusion" } };
      const calls: string[] = [];
      let terminalWrites = 0;
      const executor = new WorkflowGraphExecutor({
        runId: `${task.id}:ccc-wave-4`,
        branchPersistence: {
          ...pgBranchPersistence(harness.store),
          saveBranchState: async (state) => {
            if (!state.branchId.startsWith("__ccc_frontier__:") && state.status === "completed" && ++terminalWrites === 1) {
              throw new Error("injected terminal checkpoint failure");
            }
            await harness.store.saveWorkflowRunBranch(state);
          },
        },
        handlers: {
          prompt: async (node) => {
            calls.push(node.id);
            return { outcome: "success" as const };
          },
        },
      });

      const result = await executor.run(task as TaskDetail, {}, wave4Ir);

      expect(result.outcome).toBe("failure");
      expect(calls).toContain("B");
      expect(calls).not.toContain("D");
      expect(result.context["ccc:branch-persistence-failure"]).toBe("ccc-branch-persistence-terminal-failed");
    } finally {
      await harness.teardown();
    }
  });

  it("Wave 4 RED: PostgreSQL death during B and C resumes only unfinished branch work", async () => {
    const harness = await createTaskStoreForTest({ prefix: "fusion_ccc_wave4_death", copyFromGolden: true });
    const runId = "wave4-stable-run";
    const events: Array<{ event: string; node: string }> = [];
    let child: ReturnType<typeof spawn> | undefined;
    try {
      const created = await harness.store.createTask({ description: "CCC controller death during fanout" });
      let resolveAEffect!: () => void;
      let rejectChildBarrier!: (error: Error) => void;
      const aEffect = new Promise<void>((resolve, reject) => {
        resolveAEffect = resolve;
        rejectChildBarrier = reject;
      });
      let resolveCHeld!: () => void;
      const cHeld = new Promise<void>((resolve) => {
        resolveCHeld = resolve;
      });
      child = spawn(process.execPath, [
        "--import", "tsx", "--input-type=module", "-e", controllerProgram(process.cwd().replace(/\/packages\/engine$/, "")),
        harness.testUrl,
        harness.rootDir,
        created.id,
        runId,
      ], { stdio: ["ignore", "pipe", "inherit"] });
      child.stdout.setEncoding("utf8");
      let stdout = "";
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        const lines = stdout.split("\n");
        stdout = lines.pop() ?? "";
        for (const line of lines) {
          try {
            const event = JSON.parse(line) as { event: string; node: string };
            events.push(event);
            if (event.event === "effect" && event.node === "A") resolveAEffect();
            if (event.event === "held-before-effect" && event.node === "C") resolveCHeld();
          } catch {
            // The child protocol is newline-delimited JSON; malformed diagnostics are ignored here.
          }
        }
      });
      child.once("exit", (code, signal) => {
        if (!events.some((event) => event.event === "held-before-effect" && event.node === "C")) {
          rejectChildBarrier(new Error(`controller exited before C barrier (code=${code}, signal=${signal})`));
        }
      });

      await aEffect;
      await cHeld;
      await vi.waitFor(async () => {
        expect(await harness.store.loadWorkflowRunBranches(created.id, runId)).toEqual(expect.arrayContaining([
          expect.objectContaining({ branchId: "B", status: "completed", currentNodeId: "B" }),
        ]));
      });
      expect(child.kill("SIGKILL")).toBe(true);
      await once(child, "exit");
      child = undefined;

      const resumedCalls: string[] = [];
      const resumed = new WorkflowGraphExecutor({
        runId,
        branchPersistence: pgBranchPersistence(harness.store),
        handlers: {
          prompt: async (node) => {
            resumedCalls.push(node.id);
            return { outcome: "success" as const };
          },
        },
      });
      const result = await resumed.run(asCccTask(created as TaskDetail), {}, wave4Ir);

      expect(result.outcome).toBe("success");
      expect(events).toContainEqual({ event: "effect", node: "A" });
      expect(events).toContainEqual({ event: "effect", node: "B" });
      expect(events).not.toContainEqual({ event: "effect", node: "C" });
      expect(resumedCalls).not.toContain("A");
      expect(resumedCalls).not.toContain("B");
      expect(resumedCalls).toEqual(expect.arrayContaining(["C", "D"]));
      expect(resumedCalls.indexOf("D")).toBeGreaterThan(resumedCalls.indexOf("C"));
    } finally {
      if (child && child.exitCode === null) {
        child.kill("SIGKILL");
        await once(child, "exit");
      }
      await harness.teardown();
    }
  });

  it("Wave 4 preservation: PostgreSQL restart after durable A resumes at the split without replaying A", async () => {
    const harness = await createTaskStoreForTest({ prefix: "fusion_ccc_wave4_frontier", copyFromGolden: true });
    const runId = "wave4-frontier-run";
    const events: Array<{ event: string; node: string }> = [];
    let child: ReturnType<typeof spawn> | undefined;
    try {
      const created = await harness.store.createTask({ description: "CCC frontier controller death" });
      let resolveFrontier!: () => void;
      const frontier = new Promise<void>((resolve) => { resolveFrontier = resolve; });
      child = spawn(process.execPath, [
        "--import", "tsx", "--input-type=module", "-e", controllerProgram(process.cwd().replace(/\/packages\/engine$/, "")),
        harness.testUrl,
        harness.rootDir,
        created.id,
        runId,
        "hold-after-frontier",
      ], { stdio: ["ignore", "pipe", "inherit"] });
      child.stdout.setEncoding("utf8");
      let stdout = "";
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        const lines = stdout.split("\n");
        stdout = lines.pop() ?? "";
        for (const line of lines) {
          const event = JSON.parse(line) as { event: string; node: string };
          events.push(event);
          if (event.event === "frontier-committed" && event.node === "A") resolveFrontier();
        }
      });
      await frontier;
      await vi.waitFor(async () => {
        expect(await harness.store.loadWorkflowRunBranches(created.id, runId)).toEqual(expect.arrayContaining([
          expect.objectContaining({ branchId: "__ccc_frontier__:A", currentNodeId: "A", status: "completed" }),
        ]));
      });
      expect(events).toContainEqual({ event: "effect", node: "A" });
      expect(child.kill("SIGKILL")).toBe(true);
      await once(child, "exit");
      child = undefined;

      const calls: string[] = [];
      const resumed = new WorkflowGraphExecutor({
        runId,
        branchPersistence: pgBranchPersistence(harness.store),
        handlers: { prompt: async (node) => { calls.push(node.id); return { outcome: "success" as const }; } },
      });
      const result = await resumed.run(asCccTask(created as TaskDetail), {}, wave4Ir);

      expect(result.outcome).toBe("success");
      expect(calls).not.toContain("A");
      expect(calls.filter((node) => node === "B")).toHaveLength(1);
      expect(calls.filter((node) => node === "C")).toHaveLength(1);
      expect(calls.filter((node) => node === "D")).toHaveLength(1);
    } finally {
      if (child && child.exitCode === null) {
        child.kill("SIGKILL");
        await once(child, "exit");
      }
      await harness.teardown();
    }
  });

  it("Wave 4 RED: failed PostgreSQL fixture teardown preserves a redacted diagnostic packet", async () => {
    const harness = await createTaskStoreForTest({
      prefix: "fusion_ccc_wave4_teardown_failure",
      copyFromGolden: true,
      // Deliberately exercise the harness's test-only teardown-failure seam.
      teardownFault: "remove-root-dir",
    } as Parameters<typeof createTaskStoreForTest>[0]);

    await expect(harness.teardown()).rejects.toThrow(/teardown/i);
    const packet = await readFile(`${harness.rootDir}/pg-teardown-diagnostic.json`, "utf8");
    expect(JSON.parse(packet)).toMatchObject({ dbName: harness.dbName, stage: "remove-root-dir" });
    expect(packet).not.toContain(harness.testUrl);
    await expect(access(harness.rootDir)).resolves.toBeUndefined();

    const cleanHarness = await createTaskStoreForTest({ prefix: "fusion_ccc_wave4_teardown_success", copyFromGolden: true });
    const cleanRoot = cleanHarness.rootDir;
    await cleanHarness.teardown();
    await expect(access(cleanRoot)).rejects.toThrow();
  });
});
