/**
 * FNXC:PostgresCutover 2026-07-10:
 * Regression coverage for the two production-readiness blockers flagged in the
 * PG-mode review:
 *
 * Blocker 1 — `recoverStaleTransitionPendingImpl` previously threw
 * "SQLite Database is not available in backend mode" on every startup and
 * maintenance sweep (unported `store.db.prepare`). These tests pin the ported
 * backend path: a flag-ON move writes the crash-safe marker inside the move
 * transaction and clears it post-commit; a stale marker (crash simulation) is
 * recovered and cleared by the sweep without throwing.
 *
 * Blocker 2 — triage's `status: "planning"` clear reportedly never took effect
 * in PG mode, leaving cards permanently "unplanned" so the scheduler refused
 * to dispatch them. These tests pin the exact store seam triage drives:
 * set-planning → clear(status:null) → moveTask(todo) → a FRESH read shows the
 * status cleared; plus interleaved same-task writers on different fields must
 * both persist (the full-row-upsert lost-update class fixed by the
 * changed-columns port in atomicWriteTaskJson/WithAudit).
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import * as schema from "../../postgres/schema/index.js";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import {
  listTransitionPendingTaskIdsAsync,
  readTransitionPendingAsync,
  writeTransitionPendingAsync,
} from "../../task-store/async-transition-pending.js";
import { makeTransitionPending } from "../../transition-types.js";

const pgTest = pgDescribe;

async function seedStaleTransitionPending(
  h: SharedPgTaskStoreHarness,
  description: string,
) {
  const task = await h.store().createTask({ description });
  await writeTransitionPendingAsync(
    h.layer().db,
    task.id,
    makeTransitionPending("todo", ["default-workflow:postCommit"], Date.now()),
  );
  expect(await listTransitionPendingTaskIdsAsync(h.layer().db)).toContain(task.id);
  return task;
}

pgTest("transitionPending marker + status-clear durability (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_tp_status",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  it("recoverStaleTransitionPending recovers and clears a stale marker without throwing (Blocker 1)", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "crash-recovery target" });

    // Simulate a crash mid-transition: marker written, post-commit clear never ran.
    await writeTransitionPendingAsync(
      h.layer().db,
      task.id,
      makeTransitionPending("todo", ["default-workflow:postCommit"], Date.now()),
    );
    expect(await listTransitionPendingTaskIdsAsync(h.layer().db)).toContain(task.id);

    const result = await store.recoverStaleTransitionPending();

    expect(result.scanned).toBeGreaterThanOrEqual(1);
    expect(result.recovered).toBeGreaterThanOrEqual(1);
    expect(await readTransitionPendingAsync(h.layer().db, task.id)).toBeNull();
  });

  it("holds recovery open behind its audit while releasing the task lock, then persists the success audit", async () => {
    const store = h.store();
    const task = await seedStaleTransitionPending(h, "audit-gated recovery target");
    const storeOverride = store as unknown as {
      recordRunAuditEvent: (
        input: Parameters<typeof store.recordRunAuditEvent>[0],
      ) => ReturnType<typeof store.recordRunAuditEvent>;
    };
    const originalAudit = storeOverride.recordRunAuditEvent.bind(store);
    let releaseAudit!: () => void;
    const auditGate = new Promise<void>((resolve) => {
      releaseAudit = resolve;
    });
    let signalAuditStarted!: () => void;
    const auditStarted = new Promise<void>((resolve) => {
      signalAuditStarted = resolve;
    });
    let auditCall: Promise<unknown> | undefined;
    storeOverride.recordRunAuditEvent = (input) => {
      auditCall = (async () => {
        await Promise.resolve();
        signalAuditStarted();
        await auditGate;
        return originalAudit(input);
      })();
      return auditCall as ReturnType<typeof store.recordRunAuditEvent>;
    };

    const recovery = store.recoverStaleTransitionPending();
    let recoverySettled = false;
    void recovery.then(
      () => {
        recoverySettled = true;
      },
      () => {
        recoverySettled = true;
      },
    );
    let lockProbeSettled = false;
    let lockProbe: Promise<void> | undefined;

    try {
      await auditStarted;
      lockProbe = store.withTaskLock(task.id, async () => "released").then(() => {
        lockProbeSettled = true;
      });
      expect(await readTransitionPendingAsync(h.layer().db, task.id)).toBeNull();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(recoverySettled).toBe(false);
      expect(lockProbeSettled).toBe(true);
    } finally {
      releaseAudit();
      await Promise.allSettled([recovery, lockProbe, auditCall]);
      storeOverride.recordRunAuditEvent = originalAudit;
    }

    const auditRows = await h.layer().db
      .select({ mutationType: schema.project.runAuditEvents.mutationType })
      .from(schema.project.runAuditEvents)
      .where(and(
        eq(schema.project.runAuditEvents.taskId, task.id),
        eq(schema.project.runAuditEvents.mutationType, "task:transition-pending-recovered"),
      ));
    expect(auditRows).toHaveLength(1);
  });

  it("propagates a recovery audit rejection to the caller", async () => {
    const store = h.store();
    await seedStaleTransitionPending(h, "audit rejection target");
    const storeOverride = store as unknown as {
      recordRunAuditEvent: (
        input: Parameters<typeof store.recordRunAuditEvent>[0],
      ) => ReturnType<typeof store.recordRunAuditEvent>;
    };
    const originalAudit = storeOverride.recordRunAuditEvent.bind(store);
    let auditCall: Promise<unknown> | undefined;
    storeOverride.recordRunAuditEvent = () => {
      const rejected = Promise.reject(new Error("injected recovery audit failure"));
      auditCall = rejected;
      void rejected.catch(() => undefined);
      return rejected as ReturnType<typeof store.recordRunAuditEvent>;
    };

    try {
      await expect(store.recoverStaleTransitionPending()).rejects.toThrow(
        "injected recovery audit failure",
      );
    } finally {
      await auditCall?.catch(() => undefined);
      storeOverride.recordRunAuditEvent = originalAudit;
    }
  });

  it("leaves a marker and reports no recovery when clearing the marker fails", async () => {
    const store = h.store();
    const task = await seedStaleTransitionPending(h, "clear failure target");
    const clearFailure = new Error("injected transition marker clear failure");
    const updateSpy = vi.spyOn(h.layer().db, "update").mockImplementationOnce(() => {
      throw clearFailure;
    });
    const storeOverride = store as unknown as {
      recordRunAuditEvent: (
        input: Parameters<typeof store.recordRunAuditEvent>[0],
      ) => ReturnType<typeof store.recordRunAuditEvent>;
    };
    const originalAudit = storeOverride.recordRunAuditEvent.bind(store);
    let auditCalls = 0;
    const auditPromises: Array<Promise<unknown>> = [];
    storeOverride.recordRunAuditEvent = async (input) => {
      auditCalls += 1;
      const auditPromise = originalAudit(input);
      auditPromises.push(auditPromise);
      return auditPromise;
    };

    try {
      const result = await store.recoverStaleTransitionPending();
      expect(result.recovered).toBe(0);
      expect(auditCalls).toBe(0);
      expect(await readTransitionPendingAsync(h.layer().db, task.id)).not.toBeNull();
      const auditRows = await h.layer().db
        .select({ mutationType: schema.project.runAuditEvents.mutationType })
        .from(schema.project.runAuditEvents)
        .where(and(
          eq(schema.project.runAuditEvents.taskId, task.id),
          eq(schema.project.runAuditEvents.mutationType, "task:transition-pending-recovered"),
        ));
      expect(auditRows).toHaveLength(0);
    } finally {
      await Promise.allSettled(auditPromises);
      storeOverride.recordRunAuditEvent = originalAudit;
      updateSpy.mockRestore();
    }
  });

  it("a completed moveTask leaves no pending marker behind (write + post-commit clear round trip)", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "marker round trip" });

    await store.moveTask(task.id, "todo", { moveSource: "user" });

    expect(await readTransitionPendingAsync(h.layer().db, task.id)).toBeNull();
  });

  it("triage status lifecycle: planning → clear → move survives a fresh read (Blocker 2 seam)", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "triage status target" });

    // Exactly what TriageService does around specification:
    await store.updateTask(task.id, { status: "planning" });
    expect((await store.getTask(task.id)).status).toBe("planning");

    await store.updateTask(task.id, { status: null, error: null });
    await store.moveTask(task.id, "todo", { moveSource: "engine" });

    const fresh = await store.getTask(task.id);
    expect(fresh.status).toBeUndefined();
    expect(fresh.column).toBe("todo");

    // And directly at the row level — the scheduler's listTasks sweep must not
    // see a resurrected "planning".
    const listed = (await store.listTasks({ slim: true })).find((t) => t.id === task.id);
    expect(listed?.status).toBeUndefined();
  });

  it("interleaved writers on different fields both persist (lost-update class)", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "interleave target" });
    await store.updateTask(task.id, { status: "planning" });

    // Two logically-concurrent writers touching DIFFERENT fields. Each reads
    // fresh inside its own lock; neither may clobber the other's committed
    // column (the old full-row upsert stamped the whole row from each
    // writer's snapshot).
    await Promise.all([
      store.updateTask(task.id, { status: null }),
      store.updateTask(task.id, { priority: "high" }),
      store.updateTask(task.id, { summary: "interleave summary" }),
    ]);

    const fresh = await store.getTask(task.id);
    expect(fresh.status).toBeUndefined();
    expect(fresh.priority).toBe("high");
    expect(fresh.summary).toBe("interleave summary");
  });

  it("a SECOND store instance's field write does not resurrect a status another instance cleared (cross-instance lost update)", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "cross-instance target" });
    await store.updateTask(task.id, { status: "planning" });

    /*
     * Two TaskStore instances over the same PostgreSQL database — the shape of
     * a dashboard route store + engine store (separate in-memory task locks,
     * so their read-modify-write cycles genuinely interleave). Instance A
     * clears the status (triage); instance B then writes an unrelated field.
     * Under the old full-row upsert, B's write stamped its whole snapshot
     * back — including any stale column — so interleavings could resurrect
     * "planning" and permanently strand the card as "unplanned".
     */
    const { TaskStore } = await import("../../store.js");
    const storeB = new TaskStore(h.rootDir(), undefined, { asyncLayer: h.layer() });
    await store.updateTask(task.id, { status: null });
    await storeB.updateTask(task.id, { summary: "written by instance B" });

    const fresh = await store.getTask(task.id);
    expect(fresh.status).toBeUndefined();
    expect(fresh.summary).toBe("written by instance B");
  });
});
