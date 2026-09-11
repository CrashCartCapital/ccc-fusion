/**
 * CLI session startup deadline (CLI Agent Executor).
 *
 * An engine-owned CLI session that never reports readiness previously waited
 * forever: `waitForReady()` was a bare promise with no timeout, and the only
 * ceiling (armCccNativeCliLifetimeTimer) is CCC-campaign-only and measured in
 * hours. This covers the default startup deadline, its env override, the
 * per-spawn opt-out, settling readiness waiters when the child exits before
 * ready, and clearing the deadline timer once readiness lands.
 *
 * Mocks the PTY entirely via the `loadPty` test seam (no real node-pty, no
 * real subprocess) — same harness shape as ccc-native-cli-lifecycle.test.ts.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { IPty } from "node-pty";
import { CliAdapterRegistry, type CliAgentAdapter } from "../adapter.js";
import {
  CliSessionManager,
  CliSessionExitBeforeReadyError,
  CliSessionReadyTimeoutError,
  DEFAULT_CLI_READY_TIMEOUT_MS,
  sanitizeCliReadyTail,
} from "../session-manager.js";

// ── Fakes ────────────────────────────────────────────────────────────────

type StoredSession = Record<string, unknown> & {
  id: string;
  agentState: string;
  terminationReason: string | null;
  autonomyPosture: Record<string, unknown>;
};

function createStore() {
  const rows = new Map<string, StoredSession>();
  let nextId = 0;
  return {
    rows,
    createSession: vi.fn((input: Record<string, unknown>) => {
      const row = {
        autonomyPosture: {},
        ...input,
        id: `ready-deadline-${++nextId}`,
        terminationReason: null,
        nativeSessionId: null,
        resumeAttempts: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as StoredSession;
      rows.set(row.id, row);
      return row;
    }),
    updateSession: vi.fn((id: string, patch: Record<string, unknown>) => {
      const row = rows.get(id);
      if (!row) return undefined;
      Object.assign(row, patch);
      return row;
    }),
    getSession: vi.fn((id: string) => rows.get(id)),
    flush: vi.fn(async () => {}),
  };
}

function createPtyHarness() {
  let onExit: ((event: { exitCode: number; signal: number }) => void) | undefined;
  let onData: ((data: string) => void) | undefined;
  const pty = {
    pid: 4242,
    onData: vi.fn((listener: (data: string) => void) => {
      onData = listener;
      return () => { onData = undefined; };
    }),
    onExit: vi.fn((listener: (event: { exitCode: number; signal: number }) => void) => {
      onExit = listener;
      return () => { onExit = undefined; };
    }),
    write: vi.fn(),
    resize: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    kill: vi.fn(),
  } as unknown as IPty;
  return {
    pty,
    emitData: (data: string) => onData?.(data),
    exit: (exitCode = 0, signal = 0) => onExit?.({ exitCode, signal }),
  };
}

const adapter: CliAgentAdapter = {
  id: "ready-deadline-test-adapter",
  name: "Ready-deadline test adapter",
  capabilities: { nativeDone: false, nativeWaiting: false, transcriptSource: "none", supportsResume: false },
  buildLaunch: () => ({ command: "ready-deadline-test", args: [] }),
  buildEnvAllowlist: () => [],
  createReadinessDetector: () => ({ observe: (data: string) => data.includes("READY") }),
  formatInjection: (text) => ({ payload: text }),
};

function createHarness() {
  const store = createStore();
  const pty = createPtyHarness();
  const registry = new CliAdapterRegistry();
  registry.register(adapter);
  const manager = new CliSessionManager({
    registry,
    store: store as unknown as ConstructorParameters<typeof CliSessionManager>[0]["store"],
    concurrencyCeiling: 4,
    loadPty: async () => ({ spawn: () => pty.pty }) as never,
  });
  const spawn = (readyTimeoutMs?: number | null) => manager.spawn({
    adapterId: adapter.id,
    projectId: "proj-1",
    purpose: "execute",
    ...(readyTimeoutMs === undefined ? {} : { readyTimeoutMs }),
  });
  return { manager, pty, spawn, store };
}

afterEach(() => {
  vi.useRealTimers();
  delete process.env.FUSION_CLI_AGENT_READY_TIMEOUT_MS;
});

describe("CliSessionManager startup deadline", () => {
  it("RED: a never-ready session fails waitForReady after the default deadline and kills the PTY", async () => {
    vi.useFakeTimers();
    const { manager, pty, spawn } = createHarness();
    const session = await spawn();

    const readyPromise = manager.waitForReady(session.id);
    const observed: { rejected?: unknown } = {};
    readyPromise.catch((error) => { observed.rejected = error; });

    await vi.advanceTimersByTimeAsync(DEFAULT_CLI_READY_TIMEOUT_MS - 1);
    expect(pty.pty.kill).not.toHaveBeenCalled();
    expect(observed.rejected).toBeUndefined();

    await vi.advanceTimersByTimeAsync(1);

    await expect(readyPromise).rejects.toThrow(CliSessionReadyTimeoutError);
    await expect(readyPromise).rejects.toThrow(/never became ready/i);
    expect(pty.pty.kill).toHaveBeenCalled();
  });

  it("RED: FUSION_CLI_AGENT_READY_TIMEOUT_MS overrides the default deadline", async () => {
    process.env.FUSION_CLI_AGENT_READY_TIMEOUT_MS = "5000";
    vi.useFakeTimers();
    const { manager, pty, spawn } = createHarness();
    const session = await spawn();
    const readyPromise = manager.waitForReady(session.id);
    readyPromise.catch(() => {});

    await vi.advanceTimersByTimeAsync(4_999);
    expect(pty.pty.kill).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await expect(readyPromise).rejects.toThrow(CliSessionReadyTimeoutError);
  });

  it("RED: a non-positive-integer env override falls back to the default", async () => {
    process.env.FUSION_CLI_AGENT_READY_TIMEOUT_MS = "not-a-number";
    vi.useFakeTimers();
    const { manager, pty, spawn } = createHarness();
    const session = await spawn();
    const readyPromise = manager.waitForReady(session.id);
    readyPromise.catch(() => {});

    await vi.advanceTimersByTimeAsync(DEFAULT_CLI_READY_TIMEOUT_MS - 1);
    expect(pty.pty.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(readyPromise).rejects.toThrow(CliSessionReadyTimeoutError);
  });

  it("RED: readyTimeoutMs: null disables the deadline for this spawn", async () => {
    vi.useFakeTimers();
    const { manager, pty, spawn } = createHarness();
    const session = await spawn(null);
    const readyPromise = manager.waitForReady(session.id);
    let settled = false;
    readyPromise.then(() => { settled = true; }, () => { settled = true; });

    // Advance far past the default deadline — nothing should fire.
    await vi.advanceTimersByTimeAsync(DEFAULT_CLI_READY_TIMEOUT_MS * 5);
    expect(pty.pty.kill).not.toHaveBeenCalled();
    expect(settled).toBe(false);
  });

  it("RED: the child exiting before readiness settles pending waitForReady callers", async () => {
    const { manager, pty, spawn } = createHarness();
    // Disable the deadline so only exit-before-ready is under test here.
    const session = await spawn(null);
    const readyPromise = manager.waitForReady(session.id);

    pty.exit(1, 0);

    await expect(readyPromise).rejects.toThrow(CliSessionExitBeforeReadyError);
  });

  it("RED: the deadline timer is cleared once readiness lands (no late kill)", async () => {
    vi.useFakeTimers();
    const { manager, pty, spawn } = createHarness();
    const session = await spawn();
    const readyPromise = manager.waitForReady(session.id);

    pty.emitData("READY\n");
    await readyPromise;

    // Advance well past the original deadline — a leaked timer would kill here.
    await vi.advanceTimersByTimeAsync(DEFAULT_CLI_READY_TIMEOUT_MS * 5);
    expect(pty.pty.kill).not.toHaveBeenCalled();
  });

  it("sanitizeCliReadyTail strips escape/OSC sequences and caps length", () => {
    const raw = `${"x".repeat(600)}\x1b[2J\x1b[1;1Hpress \x1b]0;title\x07enter to continue`;
    const tail = sanitizeCliReadyTail(raw);
    expect(tail).not.toContain("\x1b");
    expect(tail).not.toContain("\x07");
    expect(tail.length).toBeLessThanOrEqual(500);
    expect(tail).toContain("enter to continue");
  });
});
