/**
 * FNXC:CliAgentPostgres 2026-07-14-12:00:
 * The experimental CLI Agent Executor must persist and rehydrate its session
 * lifecycle through PostgreSQL; no SQLite database is available at runtime.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { CliSessionStore } from "../../cli-session-store.js";
import {
  abandonCccEffectReceipt,
  cccEffectReceiptIdentity,
  commitCccEffectReceipt,
  hasCccEffectReceipt,
  markCccEffectReceiptDispatched,
  reserveCccEffectReceipt,
} from "../../ccc-effect-receipts.js";
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
      controllerToken: "controller-initial",
      toolName: "commit_synthetic_effect",
      arguments: { target: "loopback", revision: 1, __fusion_effect: { key: "effect-initial" } },
    };
    let executions = 0;
    const executeIfUncommitted = async (store: CliSessionStore) => {
      if (await hasCccEffectReceipt(store, effectInput)) return "replayed" as const;
      await reserveCccEffectReceipt(store, effectInput);
      await markCccEffectReceiptDispatched(store, effectInput);
      executions += 1;
      await commitCccEffectReceipt(store, effectInput);
      return "executed" as const;
    };

    expect(await executeIfUncommitted(first)).toBe("executed");
    const restarted = await CliSessionStore.create(h.layer(), "project-a");
    expect(await executeIfUncommitted(restarted)).toBe("replayed");
    expect(executions).toBe(1);
    expect(restarted.getSession("cli-pg-effect-receipt")?.autonomyPosture).toMatchObject({
      cccFusionProfile: "ccc-fusion",
    });
  });

  it("keys one logical effect across provider call-id drift and requires repeatOf for an intentional identical repeat", async () => {
    const first = {
      sessionId: "cli-pg-logical-effect",
      toolCallId: "provider-request-001",
      controllerToken: "controller-logical",
      toolName: "commit_synthetic_effect",
      arguments: {
        target: "loopback",
        __fusion_effect: { key: "logical-effect-001" },
      },
    };
    const retry = {
      ...first,
      toolCallId: "provider-request-retried-999",
    };

    // Provider request IDs are fencing evidence, not the durable logical
    // effect address. Current v1 incorrectly hashes this value into identity.
    expect(cccEffectReceiptIdentity(retry)).toBe(cccEffectReceiptIdentity(first));
  });

  it("single-flights one effect across two independently hydrated CliSessionStore controllers", async () => {
    const bootstrap = await CliSessionStore.create(h.layer(), "project-a");
    bootstrap.createSession({
      id: "cli-pg-two-controller-effect",
      projectId: "project-a",
      adapterId: "pi",
      purpose: "execute",
      taskId: "FN-CCC-TWO-CONTROLLER",
      autonomyPosture: { cccFusionProfile: "ccc-fusion" },
    });
    await bootstrap.flush();

    const left = await CliSessionStore.create(h.layer(), "project-a");
    const right = await CliSessionStore.create(h.layer(), "project-a");
    const input = {
      sessionId: "cli-pg-two-controller-effect",
      toolCallId: "provider-call-one",
      controllerToken: "controller-left",
      toolName: "commit_synthetic_effect",
      arguments: { target: "loopback", __fusion_effect: { key: "effect-two-controller" } },
    };
    let handlerCount = 0;
    const dispatch = async (store: CliSessionStore, controllerToken: string) => {
      const command = { ...input, controllerToken };
      await reserveCccEffectReceipt(store, command);
      await markCccEffectReceiptDispatched(store, command);
      handlerCount += 1;
      await commitCccEffectReceipt(store, command);
    };

    await Promise.allSettled([dispatch(left, "controller-left"), dispatch(right, "controller-right")]);

    expect(handlerCount).toBe(1);
  });

  it("keeps post-dispatch crash unknown across reopen until authoritative reconciliation", async () => {
    const first = await CliSessionStore.create(h.layer(), "project-a");
    first.createSession({
      id: "cli-pg-post-dispatch-unknown",
      projectId: "project-a",
      adapterId: "pi",
      purpose: "execute",
      taskId: "FN-CCC-UNKNOWN",
      autonomyPosture: { cccFusionProfile: "ccc-fusion" },
    });
    await first.flush();
    const input = {
      sessionId: "cli-pg-post-dispatch-unknown",
      toolCallId: "provider-call-unknown",
      controllerToken: "controller-unknown",
      toolName: "commit_synthetic_effect",
      arguments: { target: "loopback", __fusion_effect: { key: "effect-unknown" } },
    };

    await reserveCccEffectReceipt(first, input);
    await markCccEffectReceiptDispatched(first, input);
    // An untrusted post-dispatch throw is not proof that the downstream effect
    // did not happen. The v1 helper nevertheless clears the pending claim.
    await expect(abandonCccEffectReceipt(first, input))
      .rejects.toMatchObject({ code: "CCC_EFFECT_RECONCILIATION_REQUIRED" });

    const reopened = await CliSessionStore.create(h.layer(), "project-a");
    await expect(reopened.getCccEffectReceipt(input.sessionId, "effect-unknown"))
      .resolves.toMatchObject({ state: "dispatched_unknown" });
  });

  it("reclaims a reserved receipt only after the prior controller is explicitly fenced", async () => {
    const store = await CliSessionStore.create(h.layer(), "project-a");
    store.createSession({ id: "cli-pg-fenced-reservation", projectId: "project-a", adapterId: "pi", purpose: "execute" });
    await store.flush();
    const prior = {
      sessionId: "cli-pg-fenced-reservation", controllerToken: "generation-one", toolName: "commit_synthetic_effect",
      arguments: { target: "loopback", __fusion_effect: { key: "fenced-effect" } },
    };
    await reserveCccEffectReceipt(store, prior);
    // This is a durable, explicit controller decision; no elapsed-time input is
    // supplied or inferred anywhere in the takeover proof.
    await abandonCccEffectReceipt(store, prior);

    await expect(reserveCccEffectReceipt(await CliSessionStore.create(h.layer(), "project-a"), {
      ...prior,
      controllerToken: "generation-two",
    })).resolves.toMatchObject({ state: "reserved", controllerToken: "generation-two" });
  });

  it("blocks an entire effectful scope after dispatched_unknown until reconciliation", async () => {
    const store = await CliSessionStore.create(h.layer(), "project-a");
    store.createSession({ id: "cli-pg-scope-barrier", projectId: "project-a", adapterId: "pi", purpose: "execute" });
    await store.flush();
    const unknown = {
      sessionId: "cli-pg-scope-barrier", controllerToken: "generation-one", toolName: "commit_synthetic_effect",
      arguments: { target: "loopback-a", __fusion_effect: { key: "unknown-effect" } },
    };
    await reserveCccEffectReceipt(store, unknown);
    await markCccEffectReceiptDispatched(store, unknown);

    await expect(reserveCccEffectReceipt(await CliSessionStore.create(h.layer(), "project-a"), {
      sessionId: unknown.sessionId,
      controllerToken: "generation-two",
      toolName: "commit_synthetic_effect",
      arguments: { target: "loopback-b", __fusion_effect: { key: "different-effect" } },
    })).rejects.toMatchObject({ code: "CCC_EFFECT_RECONCILIATION_REQUIRED" });
  });

  it("rejects ambiguous same-payload keys and commits an explicit repeatOf receipt", async () => {
    const store = await CliSessionStore.create(h.layer(), "project-a");
    store.createSession({ id: "cli-pg-repeat-of", projectId: "project-a", adapterId: "pi", purpose: "execute" });
    await store.flush();
    const first = {
      sessionId: "cli-pg-repeat-of", controllerToken: "generation-one", toolName: "commit_synthetic_effect",
      arguments: { target: "loopback", __fusion_effect: { key: "original-effect" } },
    };
    await reserveCccEffectReceipt(store, first);
    await markCccEffectReceiptDispatched(store, first);
    await commitCccEffectReceipt(store, first);

    await expect(reserveCccEffectReceipt(store, {
      ...first,
      controllerToken: "generation-two",
      arguments: { target: "loopback", __fusion_effect: { key: "ambiguous-copy" } },
    })).rejects.toMatchObject({ code: "CCC_EFFECT_AMBIGUOUS_DUPLICATE" });

    const repeat = {
      ...first,
      controllerToken: "generation-three",
      arguments: { target: "loopback", __fusion_effect: { key: "intentional-repeat", repeatOf: "original-effect" } },
    };
    await reserveCccEffectReceipt(store, repeat);
    await markCccEffectReceiptDispatched(store, repeat);
    await expect(commitCccEffectReceipt(store, repeat)).resolves.toMatchObject({ state: "committed", logicalKey: "intentional-repeat" });
  });

  it("reopens committed effect and suppresses replay despite changed provider request id", async () => {
    const first = await CliSessionStore.create(h.layer(), "project-a");
    first.createSession({
      id: "cli-pg-request-id-drift",
      projectId: "project-a",
      adapterId: "pi",
      purpose: "execute",
      taskId: "FN-CCC-REQUEST-ID-DRIFT",
      autonomyPosture: { cccFusionProfile: "ccc-fusion" },
    });
    await first.flush();
    const committed = {
      sessionId: "cli-pg-request-id-drift",
      toolCallId: "provider-request-original",
      controllerToken: "controller-committed",
      toolName: "commit_synthetic_effect",
      arguments: { target: "loopback", revision: 1, __fusion_effect: { key: "effect-request-drift" } },
    };
    await reserveCccEffectReceipt(first, committed);
    await markCccEffectReceiptDispatched(first, committed);
    await commitCccEffectReceipt(first, committed);

    const reopened = await CliSessionStore.create(h.layer(), "project-a");
    expect(await hasCccEffectReceipt(reopened, {
      ...committed,
      toolCallId: "provider-request-after-restart",
    })).toBe(true);
  });

  it("rejects non-JSON arguments and distinguishes undefined from string undefined", () => {
    const input = {
      sessionId: "cli-pg-non-json",
      toolCallId: "provider-call-non-json",
      controllerToken: "controller-non-json",
      toolName: "commit_synthetic_effect",
      arguments: { target: undefined, __fusion_effect: { key: "effect-non-json" } },
    };
    expect(() => cccEffectReceiptIdentity(input)).toThrow(/JSON|undefined|canonical/i);
    expect(() => cccEffectReceiptIdentity({ ...input, arguments: { target: "undefined", __fusion_effect: { key: "effect-non-json" } } })).not.toThrow();
  });

  it("stale independent CliSessionStore posture flush cannot erase authoritative receipt state", async () => {
    const bootstrap = await CliSessionStore.create(h.layer(), "project-a");
    bootstrap.createSession({
      id: "cli-pg-stale-posture",
      projectId: "project-a",
      adapterId: "pi",
      purpose: "execute",
      taskId: "FN-CCC-STALE-POSTURE",
      autonomyPosture: { cccFusionProfile: "ccc-fusion" },
    });
    await bootstrap.flush();
    const authoritative = await CliSessionStore.create(h.layer(), "project-a");
    const stale = await CliSessionStore.create(h.layer(), "project-a");
    const input = {
      sessionId: "cli-pg-stale-posture",
      toolCallId: "provider-call-stale",
      controllerToken: "controller-stale",
      toolName: "commit_synthetic_effect",
      arguments: { target: "loopback", __fusion_effect: { key: "effect-stale" } },
    };
    await reserveCccEffectReceipt(authoritative, input);
    await markCccEffectReceiptDispatched(authoritative, input);
    await commitCccEffectReceipt(authoritative, input);
    stale.updateSession(input.sessionId, { autonomyPosture: { unrelated: "stale-cache-write" } });
    await stale.flush();

    expect(await hasCccEffectReceipt(await CliSessionStore.create(h.layer(), "project-a"), input)).toBe(true);
  });

  it("fresh baseline exposes the dedicated v2 receipt table", async () => {
    const rows = await h.layer().db.execute(sql`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'project' AND table_name = 'ccc_effect_receipts'
    `) as unknown as Array<{ table_name: string }>;
    expect(rows.map((row) => row.table_name)).toEqual(["ccc_effect_receipts"]);
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
