/**
 * End-to-end (fake PTY) coverage for the glue between session-manager.ts's
 * `handleData` -> `codexExecUsage.observe()` and `closeCccNativeCliSessionLive`
 * -> `codexExecUsage.flush()` for codex exec-mode sessions — usage-lane
 * review-round-2 items A (drain-before-flush half) and C. No prior test drove
 * this path at all: the narrower ccc-native-cli-lifecycle.test.ts harness
 * uses a non-codex fake adapter, so it never attaches a usage observer.
 *
 * The termGraceMs-wait-before-SIGTERM half of item A (the "done" close racing
 * the child's natural exit) lands in its own follow-up commit, since it
 * changes PR #80's held-closure timing and the reviewer asked for that
 * change to be independently visible.
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
import { CliSessionManager } from "../session-manager.js";

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

function buildPolicy(termGraceMs: number) {
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
    deadlineAtMs: Date.parse(context.campaignDeadlineAt),
    limits: Object.freeze({ maxRequests: 1, lifetimeMs: 60_000, termGraceMs, killClosureMs: 5_000 }),
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

function createHarness(termGraceMs: number) {
  const policy = buildPolicy(termGraceMs);
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
});
