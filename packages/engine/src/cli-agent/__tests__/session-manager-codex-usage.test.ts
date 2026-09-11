/**
 * End-to-end (fake PTY) coverage for the glue between session-manager.ts's
 * `handleData` -> `codexExecUsage.observe()` and `closeCccNativeCliSessionLive`
 * -> `codexExecUsage.flush()` for codex exec-mode sessions — usage-lane
 * review-round-2 items A and C. No prior test drove this path at all: the
 * narrower ccc-native-cli-lifecycle.test.ts harness uses a non-codex fake
 * adapter, so it never attaches a usage observer.
 *
 * Findings that motivate what's exercised here (live probe, codex-cli
 * 0.147.0, node-pty 0.13.1, 5 runs + 2 adversarial, see the round-2 report):
 *  - `turn.completed` was observed on the PTY data stream BEFORE the notify
 *    hook fired in every run, including an adversarial run that SIGTERM'd the
 *    child the instant the notify hook was detected starting up. So usage
 *    capture itself was never observed at risk from the "done"-triggers-
 *    before-turn.completed ordering hazard the review raised.
 *  - notify-to-natural-exit gaps were large and variable (1.9s-21.2s across 5
 *    runs) -- a done-triggered close that SIGTERMs immediately routinely
 *    kills a process still doing legitimate post-turn work. Fixed below by
 *    giving exec-mode Codex sessions their termGraceMs to exit naturally on a
 *    "done" close before reaching for SIGTERM at all. This half of item A
 *    changes PR #80's held-closure timing (see this commit's message).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IPty } from "node-pty";
import {
  CCC_CAMPAIGN_CONTEXT_SCHEMA_VERSION,
  CCC_CAMPAIGN_EXECUTION_POLICY_SCHEMA_VERSION,
  createCccCampaignAuthorityBinding,
  type CccCampaignTaskContext,
} from "@fusion/core";
import { CliAdapterRegistry } from "../adapter.js";
import { codexAdapter } from "../adapters/codex.js";
import { CCC_NATIVE_CLI_DISPATCH_KEY } from "../ccc-native-cli-binding.js";
import {
  CCC_NATIVE_CLI_POST_DONE_EXIT_GRACE_MS,
  CliSessionManager,
} from "../session-manager.js";

const nowMs = Date.now();
const context: CccCampaignTaskContext = Object.freeze({
  schema: CCC_CAMPAIGN_CONTEXT_SCHEMA_VERSION,
  projectId: "project-1",
  importId: "import-1",
  campaignId: "campaign-1",
  taskId: "REQ-9",
  semanticTaskId: "REQ-9",
  proofIds: [],
  idempotencyKey: "idem-1",
  packetHash: "a".repeat(64),
  sidecarHash: "b".repeat(64),
  bundleHash: "c".repeat(64),
  targetRepository: { path: "/tmp/target", baseCommit: "0".repeat(40) },
  campaignStartedAt: new Date(nowMs).toISOString(),
  campaignDeadlineAt: new Date(nowMs + 24 * 60 * 60 * 1000).toISOString(),
  admittedWriteRoots: [],
  proofs: [],
  protectedActions: [],
  executionPolicy: { schema: CCC_CAMPAIGN_EXECUTION_POLICY_SCHEMA_VERSION, routes: [{ taskId: "REQ-9", providerId: "openai", modelId: "gpt-5-codex", transport: "cli" }] },
  route: { taskId: "REQ-9", providerId: "openai", modelId: "gpt-5-codex", transport: "cli" },
  manifestHash: "d".repeat(64),
  requestCount: 1,
  bounds: { maxRequests: 3, maxDurationMs: 60_000, maxConcurrency: 1 },
  sourceVersion: "semantic-bundle.v1",
  activeActionLeases: {},
});
const authorityBinding = Object.freeze(createCccCampaignAuthorityBinding(context, {
  actionId: "provider:direct",
  actionTarget: context.taskId,
}));

function buildPolicy(termGraceMs: number, deadlineAtMs?: number, killClosureMs = 5_000) {
  return Object.freeze({
    kind: "ccc-fusion.native-cli-session-policy",
    version: 1,
    attemptKey: "ccc-provider-attempt-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    controllerToken: "ccc-provider-controller-01234567-89ab-cdef-0123-456789abcdef",
    taskId: context.taskId,
    authorityBindingHash: authorityBinding.bindingHash,
    turnKey: "ccc-cli-turn-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    dispatchKey: CCC_NATIVE_CLI_DISPATCH_KEY,
    route: Object.freeze({
      adapterId: "codex",
      providerId: "openai",
      modelId: "gpt-5-codex",
      transport: "cli",
    }),
    deadlineAtMs: deadlineAtMs ?? Date.parse(context.campaignDeadlineAt),
    limits: Object.freeze({ maxRequests: 1, lifetimeMs: 60_000, termGraceMs, killClosureMs }),
  });
}

type StoredSession = Record<string, unknown> & {
  id: string;
  agentState: string;
  terminationReason: string | null;
  autonomyPosture: Record<string, unknown>;
};

type CccLifecycleManager = CliSessionManager & {
  closeCccNativeCliSession(sessionId: string, trigger: string): Promise<{
    usage: { inputTokens: number; outputTokens: number } | null;
    exitCode: number;
    exitSignal: number;
  }>;
};

function createStore() {
  const rows = new Map<string, StoredSession>();
  let nextId = 0;
  const createSession = vi.fn((input: Record<string, unknown>) => {
    const row = {
      ...input,
      id: `codex-usage-session-${++nextId}`,
      terminationReason: null,
      nativeSessionId: null,
      resumeAttempts: 0,
      createdAt: new Date(nowMs).toISOString(),
      updatedAt: new Date(nowMs).toISOString(),
    } as StoredSession;
    rows.set(row.id, row);
    return row;
  });
  const updateSession = vi.fn((id: string, patch: Record<string, unknown>) => {
    const row = rows.get(id);
    if (!row) return undefined;
    Object.assign(row, patch);
    return row;
  });
  const updateCccSessionForController = vi.fn(async (id: string, expectedGeneration: string, patch: Record<string, unknown>) => {
    const row = rows.get(id);
    if (!row || row.autonomyPosture.cccControllerGeneration !== expectedGeneration) return undefined;
    Object.assign(row, patch, {
      autonomyPosture: {
        ...row.autonomyPosture,
        ...(patch.controllerToken === undefined ? {} : { cccControllerGeneration: patch.controllerToken }),
        ...(patch.controllerFenced === undefined ? {} : { cccControllerFenced: patch.controllerFenced }),
        ...(patch.nativeCliClosureState === undefined ? {} : { cccNativeCliClosureState: patch.nativeCliClosureState }),
        ...(patch.nativeCliHeldClosureEvidence === undefined
          ? {}
          : { cccNativeCliHeldClosureEvidence: patch.nativeCliHeldClosureEvidence }),
      },
    });
    return row;
  });
  return { rows, createSession, updateSession, updateCccSessionForController, getSession: vi.fn((id: string) => rows.get(id)), flush: vi.fn(async () => {}) };
}

/** A fake PTY that actually captures and lets the test drive onData/onExit,
 * unlike ccc-native-cli-lifecycle.test.ts's harness (which never wires
 * onData — it has no need to, since its fake adapter is never codex exec-mode). */
function createPtyHarness() {
  let onData: ((data: string) => void) | undefined;
  let onExit: ((event: { exitCode: number; signal: number }) => void) | undefined;
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
    feedData: (data: string) => onData?.(data),
    exit: (exitCode = 0, signal = 0) => onExit?.({ exitCode, signal }),
  };
}

function createHarness(termGraceMs: number, deadlineAtMs?: number, killClosureMs?: number) {
  const policy = buildPolicy(termGraceMs, deadlineAtMs, killClosureMs);
  const store = createStore();
  const pty = createPtyHarness();
  const registry = new CliAdapterRegistry();
  registry.register(codexAdapter);
  const providerSpawn = vi.fn(() => pty.pty);
  const manager = new CliSessionManager({
    registry,
    store: store as unknown as ConstructorParameters<typeof CliSessionManager>[0]["store"],
    concurrencyCeiling: 1,
    loadPty: async () => ({ spawn: providerSpawn }) as never,
  });
  const spawnOptions = {
    adapterId: codexAdapter.id,
    projectId: "ccc",
    purpose: "execute",
    taskId: policy.taskId,
    settings: { oneShot: true, oneShotPrompt: "reply pong" },
    cccNativeCliPolicy: policy,
  } as unknown as Parameters<CliSessionManager["spawn"]>[0];
  const spawn = () => manager.spawn(spawnOptions);
  return { manager: manager as unknown as CccLifecycleManager, pty, spawn, store, policy };
}

const TURN_COMPLETED_LINE = '{"type":"turn.completed","usage":{"input_tokens":24327,"output_tokens":5}}\r\n';

afterEach(() => {
  vi.useRealTimers();
});

describe("session-manager <-> codex-exec-usage glue (usage-lane review-round-2 A)", () => {
  it("RED-A-1: a 'done' close waits for the natural exit within termGraceMs instead of sending SIGTERM immediately, and captures usage observed before the close", async () => {
    const { manager, pty, spawn } = createHarness(2_000);
    const session = await spawn();

    pty.feedData(TURN_COMPLETED_LINE);
    // Simulate the out-of-band notify->done path racing well ahead of the
    // child's own natural exit (matches the live probe: notify fired, then
    // the process kept running for another 1.9s-21.2s before exiting on its
    // own). The natural exit arrives shortly after, comfortably inside the
    // 2s grace.
    queueMicrotask(() => pty.exit(0, 0));

    const receipt = await manager.closeCccNativeCliSession(session.id, "done");

    expect(pty.pty.kill).not.toHaveBeenCalled();
    expect(receipt.exitCode).toBe(0);
    expect(receipt.exitSignal).toBe(0);
    expect(receipt.usage).toEqual({ inputTokens: 24327, outputTokens: 5 });
  });

  /*
   * Retargeted 2026-09-11 alongside CCC_NATIVE_CLI_POST_DONE_EXIT_GRACE_MS.
   * The fallback SIGTERM now fires after the post-done exit grace, not after
   * termGraceMs, and the grace is 30s — far too long to wait in a unit test.
   * Drive the same fallback through the other bound instead: a campaign
   * deadline that lands inside the grace clamps it, and the escalation budget
   * reserved inside that deadline is what SIGTERMs the child.
   */
  it("RED-A-2: a 'done' close falls back to SIGTERM when the exit grace runs out with no natural exit", async () => {
    const { manager, pty, spawn } = createHarness(100, Date.now() + 400, 100);
    const session = await spawn();
    pty.feedData(TURN_COMPLETED_LINE);
    pty.pty.kill.mockImplementationOnce(() => queueMicrotask(() => pty.exit(-1, 15)));

    const receipt = await manager.closeCccNativeCliSession(session.id, "done");

    expect(pty.pty.kill).toHaveBeenCalledTimes(1);
    expect(pty.pty.kill).toHaveBeenCalledWith("SIGTERM");
    expect(receipt.usage).toEqual({ inputTokens: 24327, outputTokens: 5 });
  });

  it("RED-A-3: exit-before-last-data — a trailing chunk delivered on the next PTY tick after exit is still drained before usage is computed", async () => {
    const { manager, pty, spawn } = createHarness(2_000);
    const session = await spawn();

    // The process has already exited (live.exitResult set synchronously)
    // with NO data delivered yet -- the adversarial ordering hazard the
    // review raised (node-pty could, in principle, deliver onExit before the
    // final onData chunk). Schedule the trailing chunk's arrival on the very
    // next PTY-equivalent tick, exactly as a late-arriving chunk would.
    pty.exit(0, 0);
    setImmediate(() => pty.feedData(TURN_COMPLETED_LINE));

    const receipt = await manager.closeCccNativeCliSession(session.id, "done");

    expect(receipt.usage).toEqual({ inputTokens: 24327, outputTokens: 5 });
  });
});

describe("session-manager codex-exec-usage resume invariant (usage-lane review-round-2 C)", () => {
  it("RED-C-1: a codexExecUsage-bearing session that was somehow flagged as a resume refuses to compute usage rather than silently treating a resumed thread's cumulative total as a fresh attempt's total", async () => {
    const { manager, pty, spawn } = createHarness(2_000);
    const session = await spawn();

    // The real spawn()-time admission check (autonomyPosture.cccNativeCliOneShot
    // === true refuses any `resume`) makes this scenario unreachable through
    // the public API -- codexExecUsage only ever exists on one-shot sessions,
    // and one-shot sessions can never be resumes. This white-box poke exists
    // only to prove the internal invariant guard actually fires if that
    // structural guarantee is ever broken by a future change.
    const sessionsMap = (manager as unknown as { sessions: Map<string, { resumedFromExisting: boolean }> }).sessions;
    const live = sessionsMap.get(session.id);
    if (!live) throw new Error("test setup: live session not found");
    live.resumedFromExisting = true;

    pty.feedData(TURN_COMPLETED_LINE);
    queueMicrotask(() => pty.exit(0, 0));

    await expect(manager.closeCccNativeCliSession(session.id, "done")).rejects.toThrow(
      /resumed session should never carry a codexExecUsage observer/,
    );
  });

  /*
   * Post-done exit grace (2026-09-11).
   *
   * `termGraceMs` is the SIGTERM->SIGKILL escalation budget and production
   * sets it to 1_000ms (ccc-native-cli-production-resolver.ts). Live probes
   * measured codex exec exiting 1.9s-21.2s AFTER its notify hook fires, so a
   * 1s wait changes nothing: the engine still SIGTERMs a finished turn, which
   * records exitSignal 15 and fails the committed-observation predicate
   * (trigger "done" AND exitCode 0 AND exitSignal 0). Waiting for the natural
   * exit is the honest fix — the receipt then states what actually happened —
   * so the done path gets its own, much larger grace, bounded by the campaign
   * deadline. The predicate is NOT relaxed: the same probe showed a mid-flight
   * SIGTERM can also produce 0/0, so exitSignal 0 was never proof of a natural
   * exit, and accepting signal 15 would have made the receipt depend on
   * engine-recorded intent instead of observed process behavior.
   */
  it("waits past termGraceMs for a natural exit after a done close", async () => {
    // Production-shaped escalation budget: 1s, shorter than every measured
    // notify-to-exit gap.
    const { manager, pty, spawn } = createHarness(1_000);
    const session = await spawn();
    pty.feedData(TURN_COMPLETED_LINE);
    const naturalExit = setTimeout(() => pty.exit(0, 0), 1_200);

    const receipt = await manager.closeCccNativeCliSession(session.id, "done");
    clearTimeout(naturalExit);

    expect(pty.pty.kill).not.toHaveBeenCalled();
    expect(receipt.exitCode).toBe(0);
    expect(receipt.exitSignal).toBe(0);
    expect(receipt.trigger).toBe("done");
  }, 20_000);

  it("covers the measured notify-to-natural-exit range", () => {
    // Live probe maximum was 21.2s; the grace must clear it with headroom.
    expect(CCC_NATIVE_CLI_POST_DONE_EXIT_GRACE_MS).toBeGreaterThanOrEqual(25_000);
  });

});
