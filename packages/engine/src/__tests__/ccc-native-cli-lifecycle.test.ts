import { afterEach, describe, expect, it, vi } from "vitest";
import type { IPty } from "node-pty";
import {
  CCC_CAMPAIGN_CONTEXT_SCHEMA_VERSION,
  CCC_CAMPAIGN_EXECUTION_POLICY_SCHEMA_VERSION,
  createCccCampaignAuthorityBinding,
  type CccCampaignTaskContext,
  type CccProviderAttemptScope,
} from "@fusion/core";
import { CliAdapterRegistry, type CliAgentAdapter } from "../cli-agent/adapter.js";
import { CCC_NATIVE_CLI_DISPATCH_KEY } from "../cli-agent/ccc-native-cli-binding.js";
import { CliSessionManager } from "../cli-agent/session-manager.js";

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
  executionPolicy: { schema: CCC_CAMPAIGN_EXECUTION_POLICY_SCHEMA_VERSION, routes: [{ taskId: "REQ-9", providerId: "openai", modelId: "gpt-4o", transport: "cli" }] },
  route: { taskId: "REQ-9", providerId: "openai", modelId: "gpt-4o", transport: "cli" },
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

const policy = Object.freeze({
  kind: "ccc-fusion.native-cli-session-policy",
  version: 1,
  attemptKey: "ccc-provider-attempt-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  controllerToken: "ccc-provider-controller-01234567-89ab-cdef-0123-456789abcdef",
  taskId: context.taskId,
  authorityBindingHash: authorityBinding.bindingHash,
  turnKey: "ccc-cli-turn-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  dispatchKey: CCC_NATIVE_CLI_DISPATCH_KEY,
  route: Object.freeze({
    adapterId: "lifecycle-test-adapter",
    providerId: "openai",
    modelId: "gpt-4o",
    transport: "cli",
  }),
  deadlineAtMs: Date.parse(context.campaignDeadlineAt),
  limits: Object.freeze({ maxRequests: 1, lifetimeMs: 60_000, termGraceMs: 5_000, killClosureMs: 5_000 }),
});

const terminalScope: CccProviderAttemptScope = Object.freeze({
  attemptKey: policy.attemptKey,
  controllerToken: policy.controllerToken,
  taskId: policy.taskId,
  semanticTaskId: context.semanticTaskId,
  campaignDeadlineAt: context.campaignDeadlineAt,
  turnKey: policy.turnKey,
  dispatchKey: policy.dispatchKey,
  attemptOrdinal: 1,
  requestCount: 1,
  state: "committed",
  binding: authorityBinding,
  terminal: Object.freeze({
    kind: "reconciled",
    state: "committed",
    evidenceDigest: "e".repeat(64),
    observerId: "ccc-native-cli-observer.v1",
  }),
});

type StoredSession = Record<string, unknown> & {
  id: string;
  agentState: string;
  terminationReason: string | null;
  autonomyPosture: Record<string, unknown>;
};

type CccLifecycleManager = CliSessionManager & {
  closeCccNativeCliSession(sessionId: string, trigger: string): Promise<unknown>;
  releaseCccNativeCliSession(receipt: unknown, terminalScope: unknown): Promise<void>;
};

function createStore() {
  const rows = new Map<string, StoredSession>();
  let nextId = 0;
  const createSession = vi.fn((input: Record<string, unknown>) => {
    const row = {
      ...input,
      id: `cli-lifecycle-${++nextId}`,
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
      },
    });
    return row;
  });
  return {
    rows,
    createSession,
    updateSession,
    updateCccSessionForController,
    getSession: vi.fn((id: string) => rows.get(id)),
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
      return () => { onExit = undefined; };
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
  id: "lifecycle-test-adapter",
  name: "Lifecycle test adapter",
  capabilities: { nativeDone: false, nativeWaiting: false, transcriptSource: "none", supportsResume: false },
  buildLaunch: () => ({ command: "lifecycle-test", args: [] }),
  buildEnvAllowlist: () => [],
  createReadinessDetector: () => ({ observe: () => false }),
  formatInjection: (text) => ({ payload: text }),
};

afterEach(() => {
  vi.useRealTimers();
});

function createHarness(options: { omitControllerCas?: boolean; policy?: typeof policy; cancellationTimeoutMs?: number } = {}) {
  const selectedPolicy = Object.freeze(options.policy ?? policy);
  const order: string[] = [];
  const store = createStore();
  if (options.omitControllerCas) {
    delete (store as Partial<typeof store>).updateCccSessionForController;
  }
  store.flush.mockImplementation(async () => { order.push("flush"); });
  const pty = createPtyHarness();
  const registry = new CliAdapterRegistry();
  registry.register(adapter);
  const providerSpawn = vi.fn(() => {
    order.push("provider-spawn");
    return pty.pty;
  });
  const manager = new CliSessionManager({
    registry,
    store: store as unknown as ConstructorParameters<typeof CliSessionManager>[0]["store"],
    concurrencyCeiling: 1,
    loadPty: async () => ({ spawn: providerSpawn }) as never,
    cancellationTimeoutMs: options.cancellationTimeoutMs,
  });
  const spawnOptions = {
    adapterId: adapter.id,
    projectId: "ccc",
    purpose: "execute",
    taskId: policy.taskId,
    settings: { profile: "ccc-fusion", subscriptionReady: true, model: policy.route.modelId },
    cccNativeCliPolicy: selectedPolicy,
  } as unknown as Parameters<CliSessionManager["spawn"]>[0];
  const spawn = () => manager.spawn(spawnOptions);
  return { manager, order, providerSpawn, pty, spawn, store };
}

function expectedReceipt(sessionId: string, trigger: string, exitCode = -1, exitSignal = 15) {
  return {
    kind: "ccc-fusion.native-cli-held-closure",
    version: 1,
    sessionId,
    attemptKey: policy.attemptKey,
    controllerToken: policy.controllerToken,
    taskId: policy.taskId,
    authorityBindingHash: policy.authorityBindingHash,
    turnKey: policy.turnKey,
    dispatchKey: policy.dispatchKey,
    trigger,
    exitCode,
    exitSignal,
    processGroupClosed: true,
    proxyClosed: true,
    durableFloorFlushed: true,
    slotHeld: true,
  };
}

describe("CCC native CLI campaign-held lifecycle", () => {
  it("Task 4 RED: persists the frozen one-shot policy and uses its permit token as the durable generation before provider spawn", async () => {
    const { order, providerSpawn, spawn, store } = createHarness();

    const session = await spawn();
    const rowAtProviderBoundary = store.rows.get(session.id);

    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.route)).toBe(true);
    expect(Object.isFrozen(policy.limits)).toBe(true);
    expect(Object.isFrozen(authorityBinding)).toBe(true);
    expect(providerSpawn).toHaveBeenCalledOnce();
    expect(order.indexOf("flush")).toBeLessThan(order.indexOf("provider-spawn"));
    expect(rowAtProviderBoundary?.autonomyPosture).toEqual(expect.objectContaining({
      cccControllerGeneration: policy.controllerToken,
      cccNativeCliOneShot: true,
      cccProviderAttemptKey: policy.attemptKey,
      cccProviderAttemptControllerToken: policy.controllerToken,
      cccAuthorityBindingHash: policy.authorityBindingHash,
      cccNativeCliTurnKey: policy.turnKey,
      cccNativeCliDispatchKey: policy.dispatchKey,
      cccNativeCliPolicy: policy,
    }));
    expect(Object.isFrozen(rowAtProviderBoundary?.autonomyPosture.cccNativeCliPolicy)).toBe(true);
    expect(rowAtProviderBoundary?.autonomyPosture.cccNativeCliPolicy).toBe(policy);
  });

  it("Task 4 RED: close sends TERM once, proves closure durably, and holds the campaign slot with an idempotent frozen receipt", async () => {
    const { manager, pty, spawn, store } = createHarness();
    const session = await spawn();
    pty.pty.kill.mockImplementationOnce(() => queueMicrotask(() => pty.exit(-1, 15)));

    const lifecycleManager = manager as unknown as CccLifecycleManager;
    await expect(lifecycleManager.closeCccNativeCliSession(session.id, "operator-magic")).rejects.toThrow(/trigger|cancel|exit/i);
    expect(pty.pty.kill).not.toHaveBeenCalled();
    const receipt = await lifecycleManager.closeCccNativeCliSession(session.id, "cancel");
    const duplicate = await lifecycleManager.closeCccNativeCliSession(session.id, "cancel");

    expect(pty.pty.kill).toHaveBeenCalledTimes(1);
    expect(pty.pty.kill).toHaveBeenCalledWith("SIGTERM");
    expect(store.getSession(session.id)).toEqual(expect.objectContaining({ agentState: "needsAttention", terminationReason: null }));
    expect((store.getSession(session.id) as StoredSession).autonomyPosture.cccNativeCliClosureState).toBe("held-closed");
    expect(store.flush).toHaveBeenCalled();
    expect(receipt).toEqual(expectedReceipt(session.id, "cancel"));
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(duplicate).toBe(receipt);
    expect(manager.activeCount()).toBe(1);

    const unguarded = createHarness({ omitControllerCas: true });
    const unguardedSession = await unguarded.spawn();
    unguarded.pty.pty.kill.mockImplementationOnce(() => queueMicrotask(() => unguarded.pty.exit(-1, 15)));
    await expect((unguarded.manager as unknown as CccLifecycleManager).closeCccNativeCliSession(unguardedSession.id, "cancel")).rejects.toThrow(/controller|generation|CAS|guard/i);
    expect(unguarded.manager.activeCount()).toBe(1);
  });

  it("Task 4 RED: dispose/killAll closes a one-shot CCC session through held-closure (not dead/engineDeath/fenced)", async () => {
    const { manager, pty, spawn, store } = createHarness();
    const session = await spawn();

    pty.pty.kill.mockImplementation((signal?: string) => {
      expect(signal).toBe("SIGTERM");
      queueMicrotask(() => pty.exit(-1, 15));
    });

    await manager.dispose();

    const row = store.getSession(session.id) as StoredSession | undefined;
    expect(row).toEqual(expect.objectContaining({
      agentState: "needsAttention",
      terminationReason: null,
      nativeSessionId: null,
    }));
    expect(row?.autonomyPosture?.cccControllerGeneration).toBe(policy.controllerToken);
    expect(row?.autonomyPosture?.cccControllerFenced).toBe(false);
    expect(row?.autonomyPosture?.cccNativeCliClosureState).toBe("held-closed");
    expect(row?.autonomyPosture?.cccControllerFenced).not.toBe(true);
    expect(row?.terminationReason).not.toBe("engineDeath");
    expect(pty.pty.kill).toHaveBeenCalledWith("SIGTERM");
    expect(manager.activeCount()).toBe(1);
  });

  it("Task 4 RED: release refuses before a durable atomic terminal settlement, then releases only the matching committed terminal scope", async () => {
    const { manager, pty, spawn, store } = createHarness();
    const session = await spawn();
    const lifecycleManager = manager as unknown as CccLifecycleManager;
    pty.pty.kill.mockImplementationOnce(() => queueMicrotask(() => pty.exit(-1, 15)));
    const receipt = await lifecycleManager.closeCccNativeCliSession(session.id, "cancel");
    const receiptClone = Object.freeze({ ...(receipt as Record<string, unknown>) });

    expect(Object.isFrozen(terminalScope)).toBe(true);
    expect(Object.isFrozen(terminalScope.binding)).toBe(true);
    expect(Object.isFrozen(terminalScope.terminal)).toBe(true);
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(receiptClone)).toBe(true);
    expect(receiptClone).toEqual(receipt);
    await expect(lifecycleManager.releaseCccNativeCliSession(receipt, terminalScope)).rejects.toThrow(/terminal|settled|fenced/i);
    expect(manager.activeCount()).toBe(1);

    const row = store.rows.get(session.id)!;
    Object.assign(row, {
      agentState: "dead",
      terminationReason: "completed",
      autonomyPosture: { ...row.autonomyPosture, cccControllerFenced: true, cccNativeCliClosureState: "settled" },
    });

    await expect(lifecycleManager.releaseCccNativeCliSession(receiptClone, terminalScope)).rejects.toThrow(/receipt|identity|issued/i);
    expect(manager.activeCount()).toBe(1);
    await lifecycleManager.releaseCccNativeCliSession(receipt, terminalScope);
    expect(manager.activeCount()).toBe(0);
  });

  it("Task 4 RED: natural exit does not release a campaign-held slot and close-after-exit returns the held receipt without another signal", async () => {
    const { manager, pty, spawn } = createHarness();
    const session = await spawn();
    pty.exit(0, 0);
    await new Promise((resolve) => queueMicrotask(resolve));

    const receipt = await (manager as unknown as CccLifecycleManager).closeCccNativeCliSession(session.id, "exit");

    expect(pty.pty.kill).not.toHaveBeenCalled();
    expect(receipt).toEqual(expectedReceipt(session.id, "exit", 0, 0));
    expect(manager.activeCount()).toBe(1);
  });

  it("Task 4 RED: forged frozen receipt without a manager-held close capability cannot release a settled campaign slot", async () => {
    const { manager, spawn, store } = createHarness();
    const session = await spawn();
    const forgedReceipt = Object.freeze(expectedReceipt(session.id, "cancel"));
    const row = store.rows.get(session.id)!;
    Object.assign(row, {
      agentState: "dead",
      terminationReason: "completed",
      autonomyPosture: { ...row.autonomyPosture, cccControllerFenced: true, cccNativeCliClosureState: "settled" },
    });

    await expect((manager as unknown as CccLifecycleManager).releaseCccNativeCliSession(forgedReceipt, terminalScope)).rejects.toThrow(/receipt|identity|issued/i);
    expect(manager.activeCount()).toBe(1);
  });

  it("Task 4 RED: lifetime fence schedules shutdown at deadline - termGrace - kill and keeps the slot held when process exits", async () => {
    vi.useFakeTimers();

    const lifetimeMs = 30_000;
    const termGraceMs = 5_000;
    const killClosureMs = 10_000;
    const nowMs = Date.now();
    const shutdownBoundaryOffset = lifetimeMs - termGraceMs - killClosureMs;
    const lifetimePolicy = Object.freeze({
      ...policy,
      deadlineAtMs: nowMs + lifetimeMs,
      limits: Object.freeze({
        ...policy.limits,
        lifetimeMs,
        termGraceMs,
        killClosureMs,
      }),
    });

    vi.setSystemTime(nowMs);

    const { manager, pty, spawn } = createHarness({ policy: lifetimePolicy });
    const lifecycleManager = manager as unknown as CccLifecycleManager;
    const session = await spawn();

    pty.pty.kill.mockImplementation(() => queueMicrotask(() => pty.exit(-1, 15)));

    vi.advanceTimersByTime(shutdownBoundaryOffset - 1);
    expect(pty.pty.kill).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(pty.pty.kill).toHaveBeenCalledWith("SIGTERM");
    const firstReceipt = await lifecycleManager.closeCccNativeCliSession(session.id, "lifetime");
    const secondReceipt = await lifecycleManager.closeCccNativeCliSession(session.id, "lifetime");

    expect(firstReceipt).toEqual(expectedReceipt(session.id, "lifetime", -1, 15));
    expect(secondReceipt).toBe(firstReceipt);
    expect(manager.activeCount()).toBe(1);
  });

  it("Task 4 RED: held close uses policy termGrace + killClosure as cancellation bound for lifetime triggers", async () => {
    vi.useFakeTimers();

    const nowMs = Date.now();
    const termGraceMs = 5_000;
    const killClosureMs = 5_000;
    const boundaryMs = 5_000;
    const lifetimePolicy = Object.freeze({
      ...policy,
      deadlineAtMs: nowMs + boundaryMs + termGraceMs + killClosureMs,
      limits: Object.freeze({
        ...policy.limits,
        termGraceMs,
        killClosureMs,
      }),
    });
    const closureBoundMs = termGraceMs + killClosureMs;

    vi.setSystemTime(nowMs);

    const { manager, pty, spawn, store } = createHarness({ policy: lifetimePolicy });
    const lifecycleManager = manager as unknown as CccLifecycleManager;
    const session = await spawn();

    pty.pty.kill.mockImplementation(() => undefined);

    const settled = { done: false, error: undefined as unknown };
    const close = lifecycleManager.closeCccNativeCliSession(session.id, "lifetime");
    close.then(
      () => { settled.done = true; },
      (error) => {
        settled.done = true;
        settled.error = error;
      },
    );

    expect(pty.pty.kill).toHaveBeenCalledWith("SIGTERM");

    vi.advanceTimersByTime(closureBoundMs - 1);
    await Promise.resolve();
    expect(settled.done).toBe(false);
    expect(manager.activeCount()).toBe(1);

    vi.advanceTimersByTime(1);
    await Promise.resolve();
    await expect(close).rejects.toMatchObject({ code: "CLI_CANCELLATION_TIMEOUT" });
    expect((store.getSession(session.id) as StoredSession | undefined)).toEqual(
      expect.objectContaining({
        agentState: "needsAttention",
        terminationReason: null,
      }),
    );
    const finalRow = store.getSession(session.id) as StoredSession;
    expect(finalRow.autonomyPosture.cccControllerFenced).toBe(false);
    expect(finalRow.autonomyPosture.cccCancellationState).toBe("CANCELLATION_UNCONFIRMED");
    expect(store.flush).toHaveBeenCalled();
    expect(manager.activeCount()).toBe(1);
    expect(settled.error).toMatchObject({ code: "CLI_CANCELLATION_TIMEOUT" });
  });

  it.each([["done", "done"], ["cancel", "cancel"]])(
    "Task 4 RED: held close uses policy termGrace + killClosure as closure bound for %s trigger",
    async (_label, trigger) => {
      vi.useFakeTimers();

      const nowMs = Date.now();
      const termGraceMs = 5_000;
      const killClosureMs = 5_000;
      const closureBoundMs = termGraceMs + killClosureMs;
      const cancellationTimeoutMs = 1_000;
      const shortPolicy = Object.freeze({
        ...policy,
        limits: Object.freeze({
          ...policy.limits,
          termGraceMs,
          killClosureMs,
        }),
      });

      vi.setSystemTime(nowMs);

      const { manager, pty, spawn, store } = createHarness({
        policy: shortPolicy,
        cancellationTimeoutMs,
      });
      const lifecycleManager = manager as unknown as CccLifecycleManager;
      const session = await spawn();

      pty.pty.kill.mockImplementation(() => undefined);

      const settled = vi.fn();
      const close = lifecycleManager.closeCccNativeCliSession(session.id, trigger as "done" | "cancel");
      close.then(
        () => { settled("resolved"); },
        (error) => {
          settled("rejected", error);
        },
      );

      expect(pty.pty.kill).toHaveBeenCalledWith("SIGTERM");

      await vi.advanceTimersByTimeAsync(cancellationTimeoutMs - 1);
      expect(settled).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(settled).not.toHaveBeenCalled();
      expect(manager.activeCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(closureBoundMs - cancellationTimeoutMs - 1);
      expect(settled).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await expect(close).rejects.toMatchObject({ code: "CLI_CANCELLATION_TIMEOUT" });
      expect((store.getSession(session.id) as StoredSession | undefined)).toEqual(
        expect.objectContaining({
          agentState: "needsAttention",
          terminationReason: null,
        }),
      );
      const finalRow = store.getSession(session.id) as StoredSession;
      expect(finalRow.autonomyPosture.cccControllerFenced).toBe(false);
      expect(finalRow.autonomyPosture.cccCancellationState).toBe("CANCELLATION_UNCONFIRMED");
      expect(store.flush).toHaveBeenCalled();
      expect(manager.activeCount()).toBe(1);
      const settledCalls = settled.mock.calls;
      expect(settledCalls.at(-1)).toEqual(["rejected", expect.objectContaining({ code: "CLI_CANCELLATION_TIMEOUT" })]);
    },
  );

  it("Task 4 RED: held close is bounded when native MCP proxy disposal blocks", async () => {
    const timeoutMs = policy.limits.termGraceMs + policy.limits.killClosureMs;

    vi.useFakeTimers();

    const { manager, pty, spawn, store } = createHarness();
    const lifecycleManager = manager as unknown as CccLifecycleManager;
    const session = await spawn();
    pty.pty.kill.mockImplementation(() => queueMicrotask(() => pty.exit(-1, 15)));

    const privateManager = manager as unknown as {
      sessions: Map<string, { nativeMcpProxy?: { dispose: () => Promise<void> } }>;
    };
    const live = privateManager.sessions.get(session.id);
    expect(live).toBeDefined();
    const originalProxy = live!.nativeMcpProxy;

    let releaseDispose: (() => void) | undefined;
    const blockedDispose = new Promise<void>((resolve) => {
      releaseDispose = resolve;
    }).then(async () => originalProxy?.dispose());
    live!.nativeMcpProxy = {
      dispose: vi.fn(() => blockedDispose),
    };

    const settled = vi.fn();
    try {
      const close = lifecycleManager.closeCccNativeCliSession(session.id, "cancel");
      close.then(
        (receipt) => {
          settled("resolved", receipt);
        },
        (error) => {
          settled("rejected", error);
        },
      );

      const timeout = new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error("TEST_PROXY_DISPOSAL_BOUND_EXCEEDED"));
        }, timeoutMs + 1);
      });
      const bounded = Promise.race([close, timeout]);
      const boundedAssertion = expect(bounded).rejects.toMatchObject({
        code: "NATIVE_MCP_PROXY_DISPOSAL_TIMEOUT",
        message: expect.stringContaining("total closure budget"),
      });
      await vi.advanceTimersByTimeAsync(timeoutMs);
      await boundedAssertion;
      expect(settled).toHaveBeenCalledWith(
        "rejected",
        expect.objectContaining({
          code: "NATIVE_MCP_PROXY_DISPOSAL_TIMEOUT",
          message: expect.stringContaining("total closure budget"),
        }),
      );
      expect((store.getSession(session.id) as StoredSession | undefined)).toEqual(
        expect.objectContaining({
          agentState: "needsAttention",
          terminationReason: null,
          autonomyPosture: expect.objectContaining({
            cccControllerFenced: false,
            cccCancellationState: "NATIVE_MCP_PROXY_DISPOSAL_FAILED",
          }),
        }),
      );
      expect(manager.activeCount()).toBe(1);
      expect(pty.pty.kill).toHaveBeenCalledWith("SIGTERM");

      const rowClosureState = (store.getSession(session.id) as StoredSession | undefined)?.autonomyPosture?.cccNativeCliClosureState;
      expect(rowClosureState).not.toBe("held-closed");
    } finally {
      expect(typeof releaseDispose).toBe("function");
      releaseDispose?.();
      await blockedDispose;
      await (manager as unknown as CccLifecycleManager).closeCccNativeCliSession(session.id, "cancel").catch(() => undefined);
      expect(manager.activeCount()).toBe(1);
    }
  });
});
