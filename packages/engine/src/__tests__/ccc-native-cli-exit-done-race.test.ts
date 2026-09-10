import { afterEach, describe, expect, it, vi } from "vitest";
import type { IPty } from "node-pty";
import {
  CCC_CAMPAIGN_CONTEXT_SCHEMA_VERSION,
  CCC_CAMPAIGN_EXECUTION_POLICY_SCHEMA_VERSION,
  createCccCampaignAuthorityBinding,
  type CccCampaignTaskContext,
} from "@fusion/core";
import { CliAdapterRegistry, type CliAgentAdapter } from "../cli-agent/adapter.js";
import { CCC_NATIVE_CLI_DISPATCH_KEY } from "../cli-agent/ccc-native-cli-binding.js";
import { CliSessionManager } from "../cli-agent/session-manager.js";

/**
 * A campaign turn's positive completion is OUT OF BAND: the provider runs a
 * `notify` program, which posts to the engine, which drives the state machine to
 * `done`, which closes the session with trigger `"done"`. The child process
 * exiting is a SEPARATE, in-band event.
 *
 * With a non-interactive provider (`codex exec`) both happen within a couple of
 * seconds of each other, and the child exits on its own. Measured against
 * codex-cli 0.147.0 the notify fired ~1.55s BEFORE the process exit — but that
 * ordering is incidental, not contractual.
 *
 * If the exit is closed on immediately it stamps trigger `"exit"`, which the
 * campaign observer reads as `proved_failed`. That would turn a turn whose work
 * actually landed into a failed one purely on scheduling luck. A clean exit
 * therefore yields, for a bounded window, to a `done` that is already in flight.
 *
 * This never accepts an exit AS a done: with no done, the close still stamps
 * `"exit"` and the turn still proves failed.
 */

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
  executionPolicy: {
    schema: CCC_CAMPAIGN_EXECUTION_POLICY_SCHEMA_VERSION,
    routes: [{ taskId: "REQ-9", providerId: "openai", modelId: "gpt-4o", transport: "cli" }],
  },
  route: { taskId: "REQ-9", providerId: "openai", modelId: "gpt-4o", transport: "cli" },
  manifestHash: "d".repeat(64),
  requestCount: 1,
  bounds: { maxRequests: 3, maxDurationMs: 60_000, maxConcurrency: 1 },
  sourceVersion: "semantic-bundle.v1",
  activeActionLeases: {},
});

const authorityBinding = Object.freeze(
  createCccCampaignAuthorityBinding(context, {
    actionId: "provider:direct",
    actionTarget: context.taskId,
  }),
);

const TERM_GRACE_MS = 5_000;

const policy = Object.freeze({
  kind: "ccc-fusion.native-cli-session-policy",
  version: 1,
  attemptKey:
    "ccc-provider-attempt-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  controllerToken: "ccc-provider-controller-01234567-89ab-cdef-0123-456789abcdef",
  taskId: context.taskId,
  authorityBindingHash: authorityBinding.bindingHash,
  turnKey: "ccc-cli-turn-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  dispatchKey: CCC_NATIVE_CLI_DISPATCH_KEY,
  route: Object.freeze({
    adapterId: "exit-race-test-adapter",
    providerId: "openai",
    modelId: "gpt-4o",
    transport: "cli",
  }),
  deadlineAtMs: Date.parse(context.campaignDeadlineAt),
  limits: Object.freeze({
    maxRequests: 1,
    lifetimeMs: 60_000,
    termGraceMs: TERM_GRACE_MS,
    killClosureMs: 5_000,
  }),
});

function createStore() {
  const sessions = new Map<string, Record<string, unknown>>();
  let nextId = 0;
  return {
    createSession: vi.fn((input: Record<string, unknown>) => {
      const record = {
        ...input,
        id: `session-${++nextId}`,
        nativeSessionId: null,
        resumeAttempts: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      sessions.set(record.id, record);
      return record;
    }),
    updateSession: vi.fn((id: string, updates: Record<string, unknown>) => {
      const record = sessions.get(id);
      if (!record) return undefined;
      Object.assign(record, updates);
      return record;
    }),
    updateCccSessionForController: vi.fn(
      (id: string, _generation: string, patch: Record<string, unknown>) => {
        const record = sessions.get(id);
        if (!record) return undefined;
        const posture = (record.autonomyPosture ?? {}) as Record<string, unknown>;
        Object.assign(record, {
          agentState: patch.agentState,
          terminationReason: patch.terminationReason,
          autonomyPosture: {
            ...posture,
            cccControllerGeneration: patch.controllerToken,
            cccControllerFenced: patch.controllerFenced,
            cccNativeCliClosureState: "settled",
            cccNativeCliHeldClosureEvidence: patch.nativeCliHeldClosureEvidence,
          },
        });
        return record;
      },
    ),
    getSession: vi.fn((id: string) => sessions.get(id)),
    listSessions: vi.fn(() => [...sessions.values()]),
    flush: vi.fn(async () => {}),
  };
}

function createPtyHarness() {
  let onExit: ((event: { exitCode: number; signal: number }) => void) | undefined;
  const pty = {
    pid: 7123,
    onData: vi.fn(() => () => {}),
    onExit: vi.fn((listener: (event: { exitCode: number; signal: number }) => void) => {
      onExit = listener;
      return () => {
        onExit = undefined;
      };
    }),
    write: vi.fn(),
    resize: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    kill: vi.fn(),
  } as unknown as IPty;
  return { pty, exit: (exitCode = 0, signal = 0) => onExit?.({ exitCode, signal }) };
}

const adapter: CliAgentAdapter = {
  id: "exit-race-test-adapter",
  name: "Exit race test adapter",
  capabilities: {
    nativeDone: true,
    nativeWaiting: false,
    transcriptSource: "none",
    supportsResume: false,
  },
  buildLaunch: () => ({ command: "exit-race-test", args: [] }),
  buildEnvAllowlist: () => [],
  createReadinessDetector: () => ({ observe: () => false }),
  formatInjection: (text) => ({ payload: text }),
};

type ClosableManager = CliSessionManager & {
  closeCccNativeCliSession(
    sessionId: string,
    trigger: "done" | "exit" | "cancel" | "lifetime",
  ): Promise<{ trigger: string; exitCode: number; exitSignal: number }>;
};

function createHarness() {
  const store = createStore();
  const pty = createPtyHarness();
  const registry = new CliAdapterRegistry();
  registry.register(adapter);
  const manager = new CliSessionManager({
    registry,
    store: store as unknown as ConstructorParameters<typeof CliSessionManager>[0]["store"],
    concurrencyCeiling: 1,
    loadPty: async () => ({ spawn: () => pty.pty }) as never,
  });
  const spawn = () =>
    manager.spawn({
      adapterId: adapter.id,
      projectId: "ccc",
      purpose: "execute",
      taskId: policy.taskId,
      settings: { profile: "ccc-fusion", subscriptionReady: true, model: policy.route.modelId },
      cccNativeCliPolicy: policy,
    } as unknown as Parameters<CliSessionManager["spawn"]>[0]);
  return { manager: manager as ClosableManager, pty, spawn };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("CCC native CLI clean-exit / done race", () => {
  it("lets a done that arrives just after a clean exit take the close", async () => {
    const { manager, pty, spawn } = createHarness();
    const session = await spawn();

    // The child completed its turn and exited 0 on its own — the shape of every
    // `codex exec` run. The out-of-band done has not been observed yet.
    pty.exit(0, 0);
    await new Promise((resolve) => queueMicrotask(resolve));

    // The notify round-trip lands a moment later and the task session closes.
    const receipt = await manager.closeCccNativeCliSession(session.id, "done");

    expect(receipt.trigger).toBe("done");
    expect(receipt.exitCode).toBe(0);
    expect(receipt.exitSignal).toBe(0);
    // The child was already gone; nothing should have been signalled.
    expect(pty.pty.kill).not.toHaveBeenCalled();
  });

  it("still closes a clean exit as `exit` once the grace elapses with no done", async () => {
    vi.useFakeTimers();
    const { manager, pty, spawn } = createHarness();
    const session = await spawn();

    pty.exit(0, 0);
    await vi.advanceTimersByTimeAsync(TERM_GRACE_MS + 10);

    // No done ever arrived: the turn is closed on the exit alone, which the
    // campaign observer reads as proved_failed. The grace delays this verdict;
    // it never replaces it.
    const receipt = await manager.closeCccNativeCliSession(session.id, "exit");
    expect(receipt.trigger).toBe("exit");
    expect(receipt.exitCode).toBe(0);
  });

  it("does not grant a grace to a crash", async () => {
    vi.useFakeTimers();
    const { manager, pty, spawn } = createHarness();
    const session = await spawn();

    // A nonzero exit is not a completed turn under any ordering, so there is no
    // in-flight done worth waiting for.
    pty.exit(3, 0);
    await vi.advanceTimersByTimeAsync(0);

    const receipt = await manager.closeCccNativeCliSession(session.id, "done");
    expect(receipt.trigger).toBe("exit");
    expect(receipt.exitCode).toBe(3);
  });
});
