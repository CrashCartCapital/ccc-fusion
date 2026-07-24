/**
 * FNXC:CliAgentPostgres 2026-07-14-12:00:
 * The experimental CLI Agent Executor must persist and rehydrate its session
 * lifecycle through PostgreSQL; no SQLite database is available at runtime.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { CliSessionStore } from "../../cli-session-store.js";
import { commitCccEffectReceipt, hasCccEffectReceipt } from "../../ccc-effect-receipts.js";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";

pgDescribe("CliSessionStore PostgreSQL persistence", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_cli_session_store",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  it("persists, updates, filters, deletes, and rehydrates project sessions", async () => {
    const store = await CliSessionStore.create(h.layer(), "project-a");
    const created = store.createSession({
      id: "cli-pg-1",
      projectId: "project-a",
      adapterId: "codex",
      purpose: "execute",
      taskId: "FN-9000",
      autonomyPosture: { autoApprove: true },
    });
    await store.flush();

    expect(created.agentState).toBe("starting");
    expect(store.listByTask("FN-9000")).toHaveLength(1);
    store.updateSession(created.id, {
      agentState: "waitingOnInput",
      nativeSessionId: "native-1",
      resumeAttempts: 2,
    });
    await store.flush();

    const rehydrated = await CliSessionStore.create(h.layer(), "project-a");
    expect(rehydrated.getSession(created.id)).toMatchObject({
      agentState: "waitingOnInput",
      nativeSessionId: "native-1",
      resumeAttempts: 2,
      autonomyPosture: { autoApprove: true },
    });
    expect(rehydrated.listSessions({ agentState: "waitingOnInput" })).toHaveLength(1);
    expect((await CliSessionStore.create(h.layer(), "project-b")).listSessions()).toEqual([]);

    expect(rehydrated.deleteSession(created.id)).toBe(true);
    await rehydrated.flush();
    expect((await CliSessionStore.create(h.layer(), "project-a")).getSession(created.id)).toBeUndefined();
  });

  it("does not reissue a committed CCC effect after PostgreSQL store rehydration", async () => {
    const first = await CliSessionStore.create(h.layer(), "project-a");
    first.createSession({
      id: "cli-pg-effect-receipt",
      projectId: "project-a",
      adapterId: "custom-provider-pi",
      purpose: "execute",
      taskId: "FN-CCC-EFFECT",
      autonomyPosture: { cccFusionProfile: "ccc-fusion" },
    });
    await first.flush();
    const effectInput = {
      sessionId: "cli-pg-effect-receipt",
      toolCallId: "provider-call-001",
      toolName: "commit_synthetic_effect",
      arguments: { target: "loopback", revision: 1 },
    };
    let executions = 0;
    const executeIfUncommitted = async (store: CliSessionStore) => {
      if (hasCccEffectReceipt(store, effectInput)) return "replayed" as const;
      executions += 1;
      await commitCccEffectReceipt(store, effectInput);
      return "executed" as const;
    };

    expect(await executeIfUncommitted(first)).toBe("executed");
    const restarted = await CliSessionStore.create(h.layer(), "project-a");
    expect(await executeIfUncommitted(restarted)).toBe("replayed");
    expect(executions).toBe(1);
    expect(restarted.getSession("cli-pg-effect-receipt")?.autonomyPosture).toMatchObject({
      cccEffectReceiptContract: "ccc-tool-receipts/v1",
      cccEffectReceipts: [expect.any(String)],
    });
  });

  it("surfaces a queued PostgreSQL write failure at every durability boundary", async () => {
    /*
    FNXC:CliAgentPostgresDurability 2026-07-14-19:00:
    Session mutations are synchronous for event-driven callers, but a rejected queued write must remain observable at flush instead of becoming an unhandled rejection or a false durability success.
    */
    const layer = h.layer();
    const store = await CliSessionStore.create(layer, "project-a");
    const failure = new Error("forced queued write failure");
    const insert = vi.spyOn(layer.db, "insert").mockImplementationOnce(() => ({
      values: () => Promise.reject(failure),
    }) as never);
    try {
      store.createSession({
        id: "cli-pg-write-failure",
        projectId: "project-a",
        adapterId: "codex",
        purpose: "execute",
      });

      await expect(store.flush()).rejects.toBe(failure);
      await expect(store.flush()).rejects.toBe(failure);
      expect(store.getSession("cli-pg-write-failure")).toBeDefined();
    } finally {
      insert.mockRestore();
    }
  });
});
