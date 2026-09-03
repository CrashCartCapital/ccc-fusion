/**
 * FNXC:PgTestHarnessTeardownStraggler 2026-09-02:
 * Regression coverage for pueue 1556: the Gate 2 stop lane drains in-flight
 * tasks for a bounded 2000ms then proceeds, which can leave a straggler
 * backend connected to a per-test database when `teardown()` runs. The
 * per-test drop path (`adminExecAsync` -> `DROP DATABASE ... WITH (FORCE)`,
 * a single 15s attempt with no retry) must still complete promptly even
 * with a straggler connection open, mirroring the template-copy path
 * (:637-659) which already terminates backends and retries.
 */
import { afterEach, expect, it } from "vitest";
import postgres from "postgres";
import {
  pgDescribe,
  createTaskStoreForTest,
  type PgTestHarness,
} from "../../__test-utils__/pg-test-harness.js";

pgDescribe("PG test harness teardown robustness against a straggler connection (PostgreSQL)", () => {
  let harness: PgTestHarness | null = null;
  let straggler: ReturnType<typeof postgres> | null = null;

  afterEach(async () => {
    if (straggler) {
      await straggler.end({ timeout: 0 }).catch(() => {});
      straggler = null;
    }
    if (harness) {
      await harness.teardown().catch(() => {});
      harness = null;
    }
  });

  it("tears down within 20s when a straggler connection is idle in an open transaction", async () => {
    harness = await createTaskStoreForTest({ prefix: "fusion_teardown_straggler_txn" });

    straggler = postgres(harness.testUrl, { max: 1, prepare: false, onnotice: () => {} });
    // Leave the transaction open (idle in transaction) without COMMIT/ROLLBACK,
    // mirroring a drained-but-not-yet-closed worker connection.
    await straggler.unsafe("BEGIN");
    await straggler.unsafe("SELECT 1");

    const start = Date.now();
    await harness.teardown();
    const elapsedMs = Date.now() - start;
    harness = null; // teardown() already ran; afterEach must not double-teardown

    expect(elapsedMs).toBeLessThan(20_000);
  }, 25_000);

  it("tears down within 20s when a straggler connection holds an advisory lock", async () => {
    harness = await createTaskStoreForTest({ prefix: "fusion_teardown_straggler_lock" });

    straggler = postgres(harness.testUrl, { max: 1, prepare: false, onnotice: () => {} });
    // Hold a session-level advisory lock without releasing it, mirroring a
    // straggler backend that never reaches a clean unlock/close.
    await straggler.unsafe("SELECT pg_advisory_lock(424242)");

    const start = Date.now();
    await harness.teardown();
    const elapsedMs = Date.now() - start;
    harness = null;

    expect(elapsedMs).toBeLessThan(20_000);
  }, 25_000);
});
