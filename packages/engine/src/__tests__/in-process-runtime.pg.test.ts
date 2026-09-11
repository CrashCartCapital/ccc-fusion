/*
FNXC:PostgresRuntimeComposition 2026-07-14-18:49:
The production InProcessRuntime must compose one owned PostgreSQL backend across TaskStore, central claims, and missions, then release that backend exactly once. This real-database lifecycle test guards the wiring seam that component-only tests cannot cover.
*/

import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  createTaskStoreForTest,
  pgDescribe,
} from "../../../core/src/__test-utils__/pg-test-harness.js";

const lifecycle = vi.hoisted(() => ({ shutdownCalls: 0 }));

vi.mock("@fusion/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@fusion/core")>();
  return {
    ...actual,
    createTaskStoreForBackend: async (
      options: Parameters<typeof actual.createTaskStoreForBackend>[0],
    ) => {
      const boot = await actual.createTaskStoreForBackend(options);
      const shutdown = boot.shutdown;
      return {
        ...boot,
        shutdown: async () => {
          lifecycle.shutdownCalls += 1;
          await shutdown();
        },
      };
    },
  };
});

import { CentralCore, createTaskStoreForBackend, drizzleSql as sql, type AsyncCentralClaimStore } from "@fusion/core";
import { InProcessRuntime } from "../runtimes/in-process-runtime.js";

pgDescribe("InProcessRuntime PostgreSQL composition", () => {
  it("shares its PostgreSQL layer with claims and missions and shuts it down once", async () => {
    /*
    FNXC:PostgresRuntimeComposition 2026-07-14-21:33:
    Runtime composition coverage must use the controlled PostgreSQL harness so availability gating and database administration share the repository's bounded asynchronous lifecycle. Runtime and central connections must close in a finally block before the harness drops the database, including when an assertion fails early.
    */
    lifecycle.shutdownCalls = 0;
    const harness = await createTaskStoreForTest({ prefix: "fusion_runtime" });
    const priorDatabaseUrl = process.env.DATABASE_URL;
    let projectDir = "";
    let globalDir = "";
    let central: CentralCore | undefined;
    let runtime: InProcessRuntime | undefined;
    let releaseStartupRecovery: (() => void) | undefined;
    let orderingStop: Promise<void> | undefined;

    try {
      projectDir = await mkdtemp(join(tmpdir(), "fusion-runtime-pg-project-"));
      globalDir = await mkdtemp(join(tmpdir(), "fusion-runtime-pg-global-"));
      execFileSync("git", ["init", "-q", projectDir], { stdio: "pipe" });
      process.env.DATABASE_URL = harness.testUrl;

      central = new CentralCore(globalDir);
      runtime = new InProcessRuntime({
        projectId: "runtime-composition",
        workingDirectory: projectDir,
        isolationMode: "in-process",
        maxConcurrent: 1,
        maxWorktrees: 1,
      }, central);
      runtime.on("error", () => undefined);

      await runtime.start();
      const taskStore = runtime.getTaskStore();
      const layer = taskStore.getAsyncLayer();
      expect(runtime.getStatus()).toBe("active");
      expect(taskStore.isBackendMode()).toBe(true);
      expect(layer?.projectId).toBe("runtime-composition");
      expect(runtime.getMissionExecutionLoop()).toBeDefined();
      const runtimeInternals = runtime as unknown as {
        usageLimitPauser?: unknown;
        triageProcessor?: { options?: { usageLimitPauser?: unknown } };
      };
      expect(runtimeInternals.usageLimitPauser).toBeDefined();
      expect(runtimeInternals.triageProcessor?.options?.usageLimitPauser)
        .toBe(runtimeInternals.usageLimitPauser);

      const missionStore = taskStore.getMissionStore();
      const mission = await missionStore.createMission({ title: "Runtime composition" });
      expect((await missionStore.getMission(mission.id))?.title).toBe("Runtime composition");

      const claimStore = (runtime as unknown as { leaseCentralClaimStore: AsyncCentralClaimStore })
        .leaseCentralClaimStore;
      const claimed = await claimStore.tryClaimTask({
        projectId: "runtime-composition",
        taskId: "FN-RUNTIME-COMPOSITION",
        nodeId: "node-test",
        agentId: "agent-test",
        runId: "run-test",
        renewedAt: new Date().toISOString(),
      });
      expect(claimed.ok).toBe(true);

      await runtime.stop();
      await runtime.stop();
      expect(runtime.getStatus()).toBe("stopped");
      expect(lifecycle.shutdownCalls).toBe(1);

      const startupRecovery = new Promise<void>((resolve) => { releaseStartupRecovery = resolve; });
      const backendShutdown = vi.fn(async () => undefined);
      const shutdownOrderingRuntime = new InProcessRuntime({
        projectId: "runtime-shutdown-ordering",
        workingDirectory: projectDir,
        isolationMode: "in-process",
        maxConcurrent: 1,
        maxWorktrees: 1,
      }, {} as never) as unknown as {
        status: "active";
        startupRecoveryPromise: Promise<void> | undefined;
        backendShutdown: () => Promise<void>;
        selfHealingManager: { stop: () => void };
        stop: () => Promise<void>;
      };
      shutdownOrderingRuntime.status = "active";
      shutdownOrderingRuntime.startupRecoveryPromise = startupRecovery;
      shutdownOrderingRuntime.backendShutdown = backendShutdown;
      shutdownOrderingRuntime.selfHealingManager = {stop: vi.fn()};
      orderingStop = shutdownOrderingRuntime.stop();
      expect(backendShutdown).not.toHaveBeenCalled();
      releaseStartupRecovery();
      await orderingStop;
      expect(backendShutdown).toHaveBeenCalledTimes(1);
    } finally {
      releaseStartupRecovery?.();
      await orderingStop?.catch(() => undefined);
      try {
        await runtime?.stop();
      } finally {
        try {
          await central?.close();
        } finally {
          try {
            await harness.teardown();
          } finally {
            if (priorDatabaseUrl === undefined) delete process.env.DATABASE_URL;
            else process.env.DATABASE_URL = priorDatabaseUrl;
            await Promise.all([
              projectDir ? rm(projectDir, { recursive: true, force: true }) : Promise.resolve(),
              globalDir ? rm(globalDir, { recursive: true, force: true }) : Promise.resolve(),
            ]);
            lifecycle.shutdownCalls = 0;
          }
        }
      }
    }
  }, 30_000);

  it("routes a real due continuation through atomic orphan classification and audit", async () => {
    const harness = await createTaskStoreForTest({ prefix: "fusion_runtime_orphan" });
    const projectId = "runtime-orphan-caller";
    let projectDir = "";
    let globalDir = "";
    let boot: Awaited<ReturnType<typeof createTaskStoreForBackend>> | undefined;
    let helperSpy: { mockRestore: () => void } | undefined;
    let getTaskSpy: { mockRestore: () => void } | undefined;

    try {
      projectDir = await mkdtemp(join(tmpdir(), "fusion-runtime-orphan-project-"));
      globalDir = await mkdtemp(join(tmpdir(), "fusion-runtime-orphan-global-"));
      execFileSync("git", ["init", "-q", projectDir], { stdio: "pipe" });

      boot = await createTaskStoreForBackend({
        rootDir: projectDir,
        globalSettingsDir: globalDir,
        projectId,
        env: { DATABASE_URL: harness.testUrl },
      });
      const store = boot.taskStore;
      expect(store.getAsyncLayer()?.projectId).toBe(projectId);

      const runtime = new InProcessRuntime({
        projectId,
        workingDirectory: projectDir,
        isolationMode: "in-process",
        maxConcurrent: 1,
        maxWorktrees: 1,
      }, {} as never) as unknown as {
        status: "active";
        taskStore: typeof store;
        executor: { execute: ReturnType<typeof vi.fn> };
        drainWorkflowContinuations: () => Promise<void>;
      };
      runtime.status = "active";
      runtime.taskStore = store;
      runtime.executor = { execute: vi.fn(async () => undefined) };

      const transitionAudits = async (target: string): Promise<Array<{
        project_id: string;
        task_id: string | null;
        mutation_type: string;
      }>> => {
        return await harness.adminDb.execute(sql`
          SELECT project_id, task_id, mutation_type
          FROM project.run_audit_events
          WHERE project_id = ${projectId}
            AND target = ${target}
            AND mutation_type = 'workflowWorkItem:transition'
        `) as unknown as Array<{
          project_id: string;
          task_id: string | null;
          mutation_type: string;
        }>;
      };

      const liveTask = await store.createTask({
        description: "O2 live parent after stale task lookup",
        column: "todo",
      });
      const liveItem = await store.upsertWorkflowWorkItem({
        id: "WW-o2-live-parent",
        runId: "run-o2-live-parent",
        taskId: liveTask.id,
        nodeId: "o2-node",
        kind: "task",
        state: "runnable",
        attempt: 0,
        waitReason: "planning",
        sourceColumn: "todo",
        targetColumn: "in-progress",
        irHash: "o2".repeat(32),
      });
      helperSpy = vi.spyOn(store, "cancelOrphanedWorkflowWorkItemIfExact");
      getTaskSpy = vi.spyOn(store, "getTask").mockRejectedValueOnce(
        new Error("synthetic transient task lookup failure"),
      );

      await runtime.drainWorkflowContinuations();

      expect(getTaskSpy).toHaveBeenCalledWith(liveTask.id);
      expect(helperSpy).toHaveBeenCalledWith(expect.objectContaining({id: liveItem.id}));
      expect(await store.getWorkflowWorkItem(liveItem.id)).toMatchObject({
        id: liveItem.id,
        state: "runnable",
        leaseOwner: null,
        lastError: null,
      });
      expect(await transitionAudits(liveItem.id)).toHaveLength(0);

      const terminalTask = await store.createTask({
        description: "O2 terminal parent",
        column: "done",
      });
      const terminalItem = await store.upsertWorkflowWorkItem({
        id: "WW-o2-terminal-parent",
        runId: "run-o2-terminal-parent",
        taskId: terminalTask.id,
        nodeId: "o2-node",
        kind: "task",
        state: "runnable",
        attempt: 0,
        waitReason: "planning",
        sourceColumn: "done",
        targetColumn: "archived",
        irHash: "o2".repeat(32),
      });

      await runtime.drainWorkflowContinuations();

      expect(helperSpy).toHaveBeenCalledWith(expect.objectContaining({id: terminalItem.id}));
      expect(await store.getWorkflowWorkItem(terminalItem.id)).toMatchObject({
        id: terminalItem.id,
        state: "cancelled",
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: "orphaned-continuation:task-terminal",
        blockedReason: "task-terminal",
      });
      await expect(transitionAudits(terminalItem.id)).resolves.toEqual([{
        project_id: projectId,
        task_id: terminalTask.id,
        mutation_type: "workflowWorkItem:transition",
      }]);
    } finally {
      helperSpy?.mockRestore();
      getTaskSpy?.mockRestore();
      await boot?.shutdown();
      await harness.teardown();
      await Promise.all([
        projectDir ? rm(projectDir, { recursive: true, force: true }) : Promise.resolve(),
        globalDir ? rm(globalDir, { recursive: true, force: true }) : Promise.resolve(),
      ]);
    }
  }, 30_000);
});
