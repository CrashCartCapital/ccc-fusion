/**
 * FNXC:TestMigrationTail 2026-06-24-16:30:
 * Tests for the reusable createTaskStoreForTest() PG fixture helper.
 * Verifies the helper creates a working PG-backed TaskStore, applies the
 * schema, and tears down cleanly.
 */

import { describe, it, expect, afterEach } from "vitest";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createTaskStoreForTest,
  PG_AVAILABLE,
  type PgTestHarness,
} from "../../__test-utils__/pg-test-harness.js";
import { insertTaskRow } from "../../task-store/async-persistence.js";

const testDescribe = PG_AVAILABLE ? describe : describe.skip;

testDescribe("createTaskStoreForTest (PG fixture helper)", () => {
  let harness: PgTestHarness | null = null;

  afterEach(async () => {
    if (harness) {
      await harness.teardown();
      harness = null;
    }
  });

  it("creates a PG-backed TaskStore in backend mode", async () => {
    harness = await createTaskStoreForTest();
    expect(harness.store.isBackendMode()).toBe(true);
    expect(harness.store.getAsyncLayer()).not.toBeNull();
  });

  it("applies the schema baseline so tasks can be created", async () => {
    harness = await createTaskStoreForTest();
    const task = await harness.store.createTask({ description: "fixture test" });
    expect(task.id).toBeTruthy();
    const fetched = await harness.store.getTask(task.id);
    expect(fetched.description).toBe("fixture test");
  });

  it("tears down cleanly (drops database, closes connections)", async () => {
    const h = await createTaskStoreForTest();
    await h.teardown();
    // After teardown, calling it again is a no-op (idempotent).
    await h.teardown();
  });

  it("exposes the adminDb for direct row seeding", async () => {
    harness = await createTaskStoreForTest();
    const now = new Date().toISOString();
    await insertTaskRow(
      harness.layer,
      {
        id: "FIX-001",
        description: "seeded via helper",
        column: "todo",
        currentStep: 0,
        createdAt: now,
        updatedAt: now,
      },
      { lineageId: null },
    );
    const tasks = await harness.store.listTasks();
    expect(tasks.some((t) => t.id === "FIX-001")).toBe(true);
  });

  it("supports a custom prefix for database naming", async () => {
    harness = await createTaskStoreForTest({ prefix: "custom_prefix" });
    expect(harness.dbName.startsWith("custom_prefix")).toBe(true);
  });

  it("Wave 4 RED: preserves an earlier teardown failure packet before root cleanup", async () => {
    const h = await createTaskStoreForTest({ teardownFault: "store-close" });
    harness = null;

    await expect(h.teardown()).rejects.toThrow("teardown failed at store-close");
    await expect(access(h.rootDir)).resolves.toBeUndefined();
    const packet = JSON.parse(await readFile(join(h.rootDir, "pg-teardown-diagnostic.json"), "utf8"));
    expect(packet).toEqual(expect.objectContaining({ stage: "store-close" }));
    expect(JSON.stringify(packet)).not.toContain(h.testUrl);
  });

  it("Wave 4 RED: packet-write failure preserves the original teardown stage", async () => {
    const h = await createTaskStoreForTest({ teardownFault: "store-close", diagnosticWriteFault: true });
    harness = null;

    await expect(h.teardown()).rejects.toThrow("teardown failed at store-close");
    await expect(access(h.rootDir)).resolves.toBeUndefined();
  });
});
