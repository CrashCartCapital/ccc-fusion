/**
 * FNXC:CliBoardMutation 2026-07-09-00:00:
 * Regression coverage for FN-7731 — `fn task show`/`fn task move` must
 * retry through a momentarily-locked SQLite board database instead of
 * surfacing a raw `database is locked` error or hanging, and must always
 * close the resolved `TaskStore` so the CLI process exits promptly.
 *
 * Unit-level and CLI-boundary mocked-store coverage use fake timers to prove
 * the bounded-backoff/fast-fail/non-lock-passthrough contract without a
 * database-specific writer lock.
 *
 * FNXC:CliTests 2026-07-16-07:49:
 * FN-8081 removes the obsolete spawned `DatabaseSync` writer-lock helper.
 * PostgreSQL has no portable whole-database writer lock; the retained fake-timer
 * and mocked-store tests cover retry, error, and close-on-every-exit behavior.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { retryOnLock, LockRetryExhaustedError, DEFAULT_CLI_LOCK_RETRY_MS } from "../../lock-retry.js";
import {
  closeBoardContextAndExitWithCustody,
  resolveBoardContextWithCustody,
  retryBoardCallWithCustody,
  withBoardWriteCustody,
  type BoardCommandCustodyDependencies,
} from "../task-board-custody.js";

describe("retryOnLock", () => {
  it("retries PostgreSQL serialization failures", async () => {
    vi.useFakeTimers();
    try {
      const op = vi.fn()
        .mockRejectedValueOnce(Object.assign(new Error("could not serialize access"), { code: "40001" }))
        .mockResolvedValue("ok");
      const pending = retryOnLock(op, { id: "FN-PG", action: "move task" }, 1_000);
      await vi.runAllTimersAsync();
      await expect(pending).resolves.toBe("ok");
      expect(op).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
  it("returns immediately on first-try success (no added latency)", async () => {
    const op = vi.fn().mockResolvedValue("ok");
    const result = await retryOnLock(op, { id: "FN-1", action: "read task" });
    expect(result).toBe("ok");
    expect(op).toHaveBeenCalledTimes(1);
  });

  it("retries through a transient lock error and succeeds once it clears", async () => {
    vi.useFakeTimers();
    try {
      const lockError = new Error("database is locked");
      const op = vi
        .fn()
        .mockRejectedValueOnce(lockError)
        .mockRejectedValueOnce(lockError)
        .mockResolvedValueOnce("recovered");

      const promise = retryOnLock(op, { id: "FN-2", action: "move task" }, 5_000);
      // Drain backoff timers as they're scheduled without a fixed count,
      // since exact intervals are an implementation detail.
      for (let i = 0; i < 10 && op.mock.calls.length < 3; i++) {
        await vi.advanceTimersByTimeAsync(1_000);
      }

      const result = await promise;
      expect(result).toBe("recovered");
      expect(op).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails fast with an actionable error when the lock never clears within the bound", async () => {
    vi.useFakeTimers();
    try {
      const lockError = new Error("SQLITE_BUSY: database is locked");
      const op = vi.fn().mockRejectedValue(lockError);

      const promise = retryOnLock(op, { id: "FN-3", action: "move task" }, 1_000);
      const assertion = expect(promise).rejects.toBeInstanceOf(LockRetryExhaustedError);
      await vi.advanceTimersByTimeAsync(5_000);
      await assertion;

      await expect(promise).rejects.toThrow(/FN-3/);
      await expect(promise).rejects.toThrow(/move task/);
      await expect(promise).rejects.toThrow(/FUSION_CLI_LOCK_RETRY_MS/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("propagates a non-lock error immediately without retrying", async () => {
    const notFound = new Error("Task FN-4 not found");
    const op = vi.fn().mockRejectedValue(notFound);

    await expect(retryOnLock(op, { id: "FN-4", action: "read task" }, 10_000)).rejects.toThrow(
      "Task FN-4 not found",
    );
    expect(op).toHaveBeenCalledTimes(1);
  });

  it("uses the default deadline when no override is supplied", () => {
    expect(DEFAULT_CLI_LOCK_RETRY_MS).toBeGreaterThan(0);
  });
});

type TestContext = { store: Record<string, unknown> };

function dependencies(resolveContext: () => Promise<TestContext>) {
  const closeContext = vi.fn().mockResolvedValue(undefined);
  const fail = vi.fn((error: unknown): never => {
    throw error;
  });
  const exit = vi.fn((code: number): never => {
    throw new Error(`process.exit(${code})`);
  });
  return {
    value: { resolveContext, closeContext, fail, exit } satisfies BoardCommandCustodyDependencies<TestContext>,
    closeContext,
    fail,
    exit,
  };
}

describe("board command retry and teardown custody", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete process.env.FUSION_CLI_LOCK_RETRY_MS;
  });

  it("retries the whole single-unit interaction and closes every resolved context", async () => {
    vi.useFakeTimers();
    process.env.FUSION_CLI_LOCK_RETRY_MS = "5000";
    const first = { store: { update: vi.fn().mockRejectedValue(new Error("database is locked")) } };
    const second = { store: { update: vi.fn().mockResolvedValue("done") } };
    const resolveContext = vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const deps = dependencies(resolveContext);

    const pending = withBoardWriteCustody(
      deps.value,
      undefined,
      { id: "FN-20", action: "update task" },
      async (context) => (context.store.update as ReturnType<typeof vi.fn>)(),
    );
    for (let i = 0; i < 10 && resolveContext.mock.calls.length < 2; i++) {
      await vi.advanceTimersByTimeAsync(1_000);
    }

    await expect(pending).resolves.toBe("done");
    expect(resolveContext).toHaveBeenCalledTimes(2);
    expect(deps.closeContext).toHaveBeenCalledTimes(2);
  });

  it("propagates a non-lock failure without retrying and still closes the context", async () => {
    const context = { store: { read: vi.fn().mockRejectedValue(new Error("Task FN-404 not found")) } };
    const resolveContext = vi.fn().mockResolvedValue(context);
    const deps = dependencies(resolveContext);

    await expect(withBoardWriteCustody(
      deps.value,
      undefined,
      { id: "FN-404", action: "read task" },
      async (resolved) => (resolved.store.read as ReturnType<typeof vi.fn>)(),
    )).rejects.toThrow("Task FN-404 not found");

    expect(resolveContext).toHaveBeenCalledTimes(1);
    expect(deps.closeContext).toHaveBeenCalledTimes(1);
    expect(deps.fail).not.toHaveBeenCalled();
  });

  it("fails closed after bounded lock exhaustion and closes every attempt", async () => {
    vi.useFakeTimers();
    process.env.FUSION_CLI_LOCK_RETRY_MS = "500";
    const context = { store: { write: vi.fn().mockRejectedValue(new Error("database is locked")) } };
    const resolveContext = vi.fn().mockResolvedValue(context);
    const deps = dependencies(resolveContext);

    const pending = withBoardWriteCustody(
      deps.value,
      undefined,
      { id: "FN-21", action: "update task" },
      async (resolved) => (resolved.store.write as ReturnType<typeof vi.fn>)(),
    );
    const assertion = expect(pending).rejects.toBeInstanceOf(LockRetryExhaustedError);
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;

    expect(resolveContext.mock.calls.length).toBeGreaterThan(1);
    expect(deps.closeContext).toHaveBeenCalledTimes(resolveContext.mock.calls.length);
    expect(deps.fail).toHaveBeenCalledTimes(1);
  });

  it("retries only a discrete later write without re-resolving the context", async () => {
    vi.useFakeTimers();
    process.env.FUSION_CLI_LOCK_RETRY_MS = "5000";
    const context = { store: {} };
    const resolveContext = vi.fn().mockResolvedValue(context);
    const deps = dependencies(resolveContext);
    const operation = vi.fn()
      .mockRejectedValueOnce(new Error("database is locked"))
      .mockResolvedValueOnce("deleted");

    const resolved = await resolveBoardContextWithCustody(deps.value, undefined, "FN-25");
    const pending = retryBoardCallWithCustody(deps.value, resolved, "FN-25", "delete task", operation);
    for (let i = 0; i < 10 && operation.mock.calls.length < 2; i++) {
      await vi.advanceTimersByTimeAsync(1_000);
    }

    await expect(pending).resolves.toBe("deleted");
    expect(resolveContext).toHaveBeenCalledTimes(1);
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("closes a resolved context before an explicit command exit", async () => {
    const context = { store: {} };
    const deps = dependencies(vi.fn().mockResolvedValue(context));

    await expect(closeBoardContextAndExitWithCustody(deps.value, context, 1)).rejects.toThrow(
      "process.exit(1)",
    );

    expect(deps.closeContext).toHaveBeenCalledWith(context);
    expect(deps.exit).toHaveBeenCalledWith(1);
  });
});
