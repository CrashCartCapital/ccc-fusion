/**
 * One-shot CLI sessions vs. the startup readiness deadline (CLI Agent
 * Executor).
 *
 * runOneShotSession() drives an adapter's NON-INTERACTIVE invocation
 * (`codex exec --json`, `droid exec --output-format json`, `pi --print`) to
 * completion via waitForExit() — it never calls waitForReady(). The bundled
 * adapters' readiness detectors are interactive-TUI signals (bracketed
 * paste / composer glyph) that a one-shot JSON stream never emits, so
 * CliSessionManager's default startup deadline (session-manager-ready-
 * deadline.test.ts) would previously kill any one-shot run that took longer
 * than the deadline to finish — validator/planning/CE runs routinely do.
 * one-shot-session.ts opts out (readyTimeoutMs: null) because completion is
 * governed by exit, not readiness.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { IPty } from "node-pty";
import { CliAdapterRegistry, type CliAgentAdapter } from "../adapter.js";
import { CliSessionManager, DEFAULT_CLI_READY_TIMEOUT_MS } from "../session-manager.js";
import { runOneShotSession } from "../one-shot-session.js";

// ── Fakes (same shape as session-manager-ready-deadline.test.ts) ───────────

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
        id: `one-shot-deadline-${++nextId}`,
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
    pid: 5150,
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

// A one-shot-capable adapter (mirrors codex/droid/pi): its readiness detector
// is the interactive-TUI signal, which a JSON one-shot stream never emits.
const adapter: CliAgentAdapter = {
  id: "codex",
  name: "Codex (test)",
  capabilities: { nativeDone: false, nativeWaiting: false, transcriptSource: "none", supportsResume: false },
  buildLaunch: () => ({ command: "codex-one-shot-test", args: [] }),
  buildEnvAllowlist: () => [],
  createReadinessDetector: () => ({ observe: (data: string) => data.includes("\x1b[?2004h") }),
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
  return { manager, pty, store };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("runOneShotSession vs. the startup readiness deadline", () => {
  it("RED: a validator run whose non-interactive output never satisfies the readiness detector is NOT killed by the default deadline", async () => {
    vi.useFakeTimers();
    const { manager, pty } = createHarness();

    const resultPromise = runOneShotSession({
      manager,
      adapterId: adapter.id,
      projectId: "proj-1",
      purpose: "validator",
      prompt: "check the invariant",
      cwd: "/tmp/one-shot-cwd",
    });

    // The default readiness deadline elapses. The JSON-emitting one-shot
    // process is still legitimately running — it never emits the interactive
    // bracketed-paste signal, so it was never "ready" and, pre-fix, gets
    // killed here even though nothing is actually wrong.
    await vi.advanceTimersByTimeAsync(DEFAULT_CLI_READY_TIMEOUT_MS + 1_000);
    expect(pty.pty.kill).not.toHaveBeenCalled();

    // The run legitimately finishes well after the old deadline would have
    // fired, with an intact successful result.
    pty.emitData(`${JSON.stringify({ verdict: "pass" })}\n`);
    pty.exit(0, 0);
    const result = await resultPromise;
    expect(result.ok).toBe(true);
  });
});
