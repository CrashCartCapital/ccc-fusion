import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CCC_CAMPAIGN_CONTEXT_SCHEMA_VERSION,
  CCC_CAMPAIGN_EXECUTION_POLICY_SCHEMA_VERSION,
  createCccCampaignAuthorityBinding,
  type CccCampaignTaskContext,
  type CccProviderAttemptScope,
  type CliSessionStore,
  type CliSession,
  type CccNativeCliHeldClosureReceipt,
  type CccNativeCliHeldClosureTrigger,
} from "@fusion/core";
import { CliAdapterRegistry } from "../cli-agent/adapter.js";
import type { CliSessionManager } from "../cli-agent/session-manager.js";
import type { TelemetryHub } from "../cli-agent/telemetry-hub.js";
import {
  launchCliTaskSession,
  type LaunchCliTaskSessionOptions,
  type CliTaskSession,
} from "../cli-agent/task-session.js";
import { buildCccNativeCliSessionPolicy, CCC_NATIVE_CLI_DISPATCH_KEY } from "../cli-agent/ccc-native-cli-binding.js";

const contextBase: CccCampaignTaskContext = {
  schema: CCC_CAMPAIGN_CONTEXT_SCHEMA_VERSION,
  projectId: "project-1",
  importId: "import-1",
  campaignId: "campaign-1",
  taskId: "REQ-9",
  semanticTaskId: "REQ-9",
  idempotencyKey: "idem-1",
  packetHash: "a".repeat(64),
  sidecarHash: "b".repeat(64),
  bundleHash: "c".repeat(64),
  targetRepository: { path: "/tmp/target", baseCommit: "0".repeat(40) },
  campaignStartedAt: "2026-07-26T00:00:00.000Z",
  campaignDeadlineAt: "2026-07-27T00:00:00.000Z",
  admittedWriteRoots: [],
  proofs: [],
  protectedActions: [],
  executionPolicy: {
    schema: CCC_CAMPAIGN_EXECUTION_POLICY_SCHEMA_VERSION,
    routes: [{ taskId: "REQ-9", transport: "cli", providerId: "openai", modelId: "gpt-4o" }],
  },
  route: { taskId: "REQ-9", transport: "cli", providerId: "openai", modelId: "gpt-4o" },
  manifestHash: "d".repeat(64),
  requestCount: 1,
  bounds: { maxRequests: 3, maxDurationMs: 60_000, maxConcurrency: 1 },
  sourceVersion: "semantic-bundle.v1",
  activeActionLeases: {},
};

const authorityBinding = createCccCampaignAuthorityBinding(contextBase, {
  actionId: "provider:direct",
  actionTarget: "REQ-9",
});

function createPermitScope(lifetimeMs: number, campaignDeadlineAt = "2026-07-27T00:00:00.000Z"): CccProviderAttemptScope {
  return {
    attemptKey: "ccc-provider-attempt-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    controllerToken: "ccc-provider-controller-01234567-89ab-cdef-0123-456789abcdef",
    taskId: contextBase.taskId,
    semanticTaskId: contextBase.semanticTaskId,
    campaignDeadlineAt,
    turnKey: "ccc-cli-turn-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    dispatchKey: CCC_NATIVE_CLI_DISPATCH_KEY,
    attemptOrdinal: 1,
    requestCount: 1,
    state: "dispatched_unknown",
    binding: authorityBinding,
    limits: {
      lifetimeMs,
    } as never,
  } as CccProviderAttemptScope;
}

function createBinding() {
  return {
    kind: "ccc-fusion.native-cli-binding",
    version: 1,
    id: "fusion-native:ccc-cli-one-shot",
    turnKey: "ccc-cli-turn-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    dispatchKey: CCC_NATIVE_CLI_DISPATCH_KEY,
    authorityBindingHash: authorityBinding.bindingHash,
    route: Object.freeze({
      adapterId: "task-session-cli",
      providerId: "openai",
      modelId: "gpt-4o",
      transport: "cli",
    }),
    limits: Object.freeze({
      maxRequests: 1,
      lifetimeMs: 30_000,
      termGraceMs: 3_000,
      killClosureMs: 2_000,
    }),
    followUp: false,
    observer: Object.freeze({ id: "ccc-native-cli-observer.v1", observe: vi.fn(() => ({
      kind: "ccc-fusion.native-cli-observation",
      version: 1,
      outcome: "committed",
      evidenceDigest: "e".repeat(64),
    })) }),
    controller: Object.freeze({ preDispatch: vi.fn(), reconcile: vi.fn() }),
  };
}

function createTerminalScope(permitScope: CccProviderAttemptScope): CccProviderAttemptScope {
  return Object.freeze({
    ...permitScope,
    state: "proved_failed",
    terminal: Object.freeze({
      kind: "reconciled" as const,
      state: "proved_failed" as const,
      evidenceDigest: "f".repeat(64),
      observerId: "ccc-native-cli-observer.v1",
    }),
  });
}

interface StoredSession extends CliSession {
  id: string;
}

const createdHookDirs: string[] = [];

function createSessionStore() {
  const rows = new Map<string, StoredSession>();
  let nextId = 0;
  return {
    createSession: vi.fn((input: Record<string, unknown>) => {
      const row = {
        ...input,
        id: `cli-task-session-${++nextId}`,
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
    listSessions: vi.fn(() => [...rows.values()]),
    flush: vi.fn(async () => {}),
  } as unknown as CliSessionStore & {
    createSession: ReturnType<typeof vi.fn>;
    updateSession: ReturnType<typeof vi.fn>;
    getSession: ReturnType<typeof vi.fn>;
    listSessions: ReturnType<typeof vi.fn>;
    flush: ReturnType<typeof vi.fn>;
  };
}

function createMachine() {
  type Change = Parameters<
    ReturnType<typeof createFakeHub>["getStateMachine"] extends ((sessionId: string) => infer Machine)
      ? Machine["onStateChange"]
      : never
  >[0];
  let state: "starting" | "ready" | "busy" | "done" | "needsAttention" = "starting";
  const listeners = new Set<(change: Change) => void>();
  function emit(nextState: typeof state): void {
    state = nextState;
    for (const listener of [...listeners]) {
      listener({
        sessionId: "",
        state: nextState,
        terminationReason: null,
        resumeAttempts: 0,
        at: new Date().toISOString(),
      });
    }
  }
  return {
    onStateChange(cb: (change: Change) => void) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    getState: () => state,
    markReady: () => {
      if (state === "starting") emit("ready");
    },
    injectPrompt: () => {
      if (state === "ready") emit("busy");
    },
    followUp: () => {
      emit("busy");
    },
    signalDone: () => emit("done"),
    done: () => emit("done"),
    hasState: (query: string) => state === query,
  } as const;
}

function createFakeHub() {
  const machines = new Map<string, ReturnType<typeof createMachine>>();
  return {
    issueToken: vi.fn(() => "token-aaa"),
    getStateMachine: (sessionId: string) => {
      let machine = machines.get(sessionId);
      if (!machine) {
        machine = createMachine();
        machines.set(sessionId, machine);
      }
      return machine;
    },
    flush: vi.fn((_sessionId: string) => "hook"),
    invalidate: vi.fn(),
    machines,
  };
}

function createFakeManager() {
  const closeCalls: Array<{ sessionId: string; trigger: CccNativeCliHeldClosureTrigger }> = [];
  const heldClosures = new Map<string, CccNativeCliHeldClosureReceipt>();
  const heldWaiters = new Map<string, Array<(receipt: CccNativeCliHeldClosureReceipt) => void>>();
  const settleHeldClosure = (sessionId: string, receipt: CccNativeCliHeldClosureReceipt) => {
    heldClosures.set(sessionId, receipt);
    for (const resolve of heldWaiters.get(sessionId) ?? []) resolve(receipt);
    heldWaiters.delete(sessionId);
  };
  const spawnPolicy: { policy: Record<string, unknown> | undefined } = { policy: undefined };

  const close = vi.fn(async (sessionId: string, trigger: CccNativeCliHeldClosureTrigger) => {
    const policy = spawnPolicy.policy as Record<string, unknown>;
    const receipt: CccNativeCliHeldClosureReceipt = {
      kind: "ccc-fusion.native-cli-held-closure",
      version: 1,
      sessionId,
      attemptKey: String(policy.attemptKey),
      controllerToken: String(policy.controllerToken),
      taskId: String(policy.taskId),
      authorityBindingHash: String(policy.authorityBindingHash),
      turnKey: String(policy.turnKey),
      dispatchKey: String(policy.dispatchKey),
      trigger,
      exitCode: -1,
      exitSignal: 15,
      processGroupClosed: true,
      proxyClosed: true,
      durableFloorFlushed: true,
      slotHeld: true,
    };
    closeCalls.push({ sessionId, trigger });
    settleHeldClosure(sessionId, Object.freeze(receipt));
    return receipt;
  });

  const manager = {
    spawn: vi.fn(async (opts: { cccNativeCliPolicy?: unknown; }) => {
      spawnPolicy.policy = opts.cccNativeCliPolicy as Record<string, unknown>;
      return { id: "cli-task-session-1" } as CliSession;
    }),
    isLive: vi.fn(() => true),
    waitForReady: vi.fn(async () => {}),
    inject: vi.fn(async () => {}),
    beginFollowUpTurn: vi.fn(async () => {}),
    closeCccNativeCliSession: close,
    kill: vi.fn(async () => {}),
    releaseCccNativeCliSession: vi.fn(async () => {}),
    waitForCccNativeCliHeldClosure: vi.fn((sessionId: string) => {
      const receipt = heldClosures.get(sessionId);
      if (receipt) return Promise.resolve(receipt);
      return new Promise<CccNativeCliHeldClosureReceipt>((resolve) => {
        const waiters = heldWaiters.get(sessionId) ?? [];
        waiters.push(resolve);
        heldWaiters.set(sessionId, waiters);
      });
    }),
    _closeCalls: closeCalls,
    _spawnPolicy: spawnPolicy,
    _heldClosures: heldClosures,
    _settleHeldClosure: settleHeldClosure,
  };

  return { manager, close, closeCalls, spawnPolicy: spawnPolicy, heldClosures, settleHeldClosure };
}

const adapter = {
  id: "task-session-cli",
  name: "Task Session CLI",
  capabilities: { nativeDone: false, nativeWaiting: false, transcriptSource: "none", supportsResume: false },
  buildLaunch: () => ({ command: "task-session-cli", args: [] }),
  buildEnvAllowlist: () => [],
  createReadinessDetector: () => ({ observe: () => true }),
  formatInjection: (text: string) => ({ payload: text }),
};

function setupHarness() {
  const hookDirRoot = mkdtempSync(`${join(tmpdir(), "ccc-native-task-session-")}`);
  createdHookDirs.push(hookDirRoot);
  const store = createSessionStore();
  const hub = createFakeHub();
  const registry = new CliAdapterRegistry();
  registry.register(adapter);
  const { manager, close, closeCalls, spawnPolicy, heldClosures, settleHeldClosure } = createFakeManager();

  const permitScope = createPermitScope(30_000);
  const binding = createBinding();
  const policy = buildCccNativeCliSessionPolicy(
    binding as never,
    permitScope,
    Date.parse("2026-07-26T00:00:00.000Z"),
  );

  const opts: LaunchCliTaskSessionOptions = {
    taskId: contextBase.taskId,
    projectId: "project-1",
    worktreePath: "/tmp/task-session",
    prompt: "solve",
    config: {
      cliAdapterId: adapter.id,
      settings: {},
    },
    manager: manager as unknown as CliSessionManager,
    hub: hub as unknown as TelemetryHub,
    registry,
    hookEndpointUrl: "http://127.0.0.1:0/unused",
    hookDirRoot,
    cccNativeCli: policy,
  };

  return {
    hookDirRoot,
    store,
    hub,
    manager,
    close,
    closeCalls,
    spawnPolicy,
    heldClosures,
    settleHeldClosure,
    opts,
    permitScope,
    policy,
  };
}

beforeEach(() => {
  createdHookDirs.length = 0;
});

afterEach(() => {
  try {
    for (const dir of createdHookDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  } catch {
    // ignore
  }
  createdHookDirs.length = 0;
});

describe("Task 4 RED task-session native CLI seam harness", () => {
  it("Task 4 RED: launch passes exact frozen ccc policy to manager.spawn and pre-caps deadline by permit lifetime", async () => {
    const { opts, manager, hookDirRoot, spawnPolicy, policy: expectedPolicy } = setupHarness();

    await launchCliTaskSession(opts);
    expect(manager.spawn).toHaveBeenCalledOnce();
    expect(spawnPolicy.policy).toBeDefined();

    const policy = spawnPolicy.policy!;
    expect(policy).toBe(expectedPolicy);
    expect(Object.isFrozen(policy)).toBe(true);
    expect(policy.dispatchKey).toBe(CCC_NATIVE_CLI_DISPATCH_KEY);
    const expectedDeadlineCap = Date.parse("2026-07-26T00:00:00.000Z") + 30_000;
    expect(policy.deadlineAtMs).toBeLessThanOrEqual(expectedDeadlineCap);
    expect(manager.spawn).toHaveBeenCalledWith(expect.objectContaining({
      cccNativeCliPolicy: expect.objectContaining({
        attemptKey: policy.attemptKey,
      }),
    }));
    expect(hookDirRoot).toContain("ccc-native-task-session-");
  });

  it("Task 4 RED: followUp returns false and does not call manager.beginFollowUpTurn for native CLI sessions", async () => {
    const { opts, manager, hookDirRoot } = setupHarness();
    const session = await launchCliTaskSession(opts);
    manager.isLive.mockReturnValueOnce(true);

    const ok = await (session as CliTaskSession & { followUp: (prompt: string) => Promise<boolean> }).followUp("next");

    expect(ok).toBe(false);
    expect(manager.beginFollowUpTurn).not.toHaveBeenCalled();
    expect(hookDirRoot).toContain("ccc-native-task-session-");
  });

  it("Task 4 RED: native done resolves to held-closure outcome, never generic success", async () => {
    const { opts, hub, manager } = setupHarness();
    const session = await launchCliTaskSession(opts);
    const machine = hub.getStateMachine((session as { sessionId: string }).sessionId);

    const outcomePromise = session.result();
    machine.signalDone();

    const outcome = await outcomePromise;

    expect(outcome.kind).toBe("ccc-native-held-closed");
    expect(outcome.nativeCliHeldClosureReceipt?.trigger).toBe("done");
    expect(manager.closeCccNativeCliSession).toHaveBeenCalledWith(expect.any(String), "done");
  });

  it("Task 4 RED: natural exit path should be modeled as close(..., 'exit') and still return held outcome", async () => {
    const { opts, manager } = setupHarness();
    const session: CliTaskSession = await launchCliTaskSession(opts);

    const closeWithExit = (session as unknown as {
      closeCccNativeCli(trigger: CccNativeCliHeldClosureTrigger): Promise<void>;
    }).closeCccNativeCli;

    await closeWithExit.call(session, "exit");
    const outcome = await session.result();

    expect(outcome.kind).toBe("ccc-native-held-closed");
    expect(outcome.nativeCliHeldClosureReceipt?.trigger).toBe("exit");
    expect((manager as { kill: ReturnType<typeof vi.fn> }).kill).not.toHaveBeenCalled();
    expect((manager as { closeCccNativeCliSession: ReturnType<typeof vi.fn> }).closeCccNativeCliSession).toHaveBeenCalledWith(
      expect.any(String),
      "exit",
    );
  });

  it("Task 4 RED: TaskSession should expose wait-for-held-closure seam and return the manager-held outcome", async () => {
    const { opts } = setupHarness();
    const session: CliTaskSession = await launchCliTaskSession(opts);

    const seam = (session as unknown as { waitForCccNativeCliHeldClosure: unknown }).waitForCccNativeCliHeldClosure;
    expect(typeof seam).toBe("function");
  });

  it("Task 4 RED: campaign kill must use manager.close(...,'cancel') and not manager.kill", async () => {
    const { opts, manager, permitScope } = setupHarness();
    const session = await launchCliTaskSession(opts);

    const killPromise = session.kill("killed");
    const outcome = await session.result();
    await session.releaseCccNativeCli(outcome.nativeCliHeldClosureReceipt!, createTerminalScope(permitScope));
    await killPromise;

    expect((manager as { closeCccNativeCliSession: ReturnType<typeof vi.fn> }).closeCccNativeCliSession).toHaveBeenCalledWith(
      expect.any(String),
      "cancel",
    );
    expect((manager as { kill: ReturnType<typeof vi.fn> }).kill).not.toHaveBeenCalled();
  });

  it("Task 4 RED: campaign kill should close held slot with cancel and await release before settling", async () => {
    const { opts, manager, permitScope, settleHeldClosure } = setupHarness();
    const session = await launchCliTaskSession(opts);
    const receipt: CccNativeCliHeldClosureReceipt = {
      kind: "ccc-fusion.native-cli-held-closure",
      version: 1,
      sessionId: session.sessionId,
      attemptKey: "ccc-provider-attempt-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      controllerToken: "ccc-provider-controller-01234567-89ab-cdef-0123-456789abcdef",
      taskId: "REQ-9",
      authorityBindingHash: "authority-binding-hash",
      turnKey: "ccc-cli-turn-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      dispatchKey: CCC_NATIVE_CLI_DISPATCH_KEY,
      trigger: "done",
      exitCode: 0,
      exitSignal: 0,
      processGroupClosed: true,
      proxyClosed: true,
      durableFloorFlushed: true,
      slotHeld: true,
    };

    const closeGate = (() => {
      let resolve!: () => void;
      const promise = new Promise<void>((res) => {
        resolve = res;
      });
      return { promise, resolve };
    })();

    const trace: string[] = [];
    const close = manager.closeCccNativeCliSession as ReturnType<typeof vi.fn>;
    const release = manager.releaseCccNativeCliSession as ReturnType<typeof vi.fn>;
    close.mockImplementationOnce(async () => {
      trace.push("close");
      await closeGate.promise;
      const cancelledReceipt = Object.freeze({ ...receipt, trigger: "cancel" as const });
      settleHeldClosure(session.sessionId, cancelledReceipt);
      return cancelledReceipt;
    });
    release.mockImplementationOnce(async () => {
      trace.push("release");
    });

    let killedSettled = false;
    const killPromise = session.kill("killed").then(() => {
      killedSettled = true;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(close).toHaveBeenCalledWith(expect.any(String), "cancel");
    expect(trace).toEqual(["close"]);
    expect(killedSettled).toBe(false);

    closeGate.resolve();
    const outcome = await session.result();
    expect(killedSettled).toBe(false);
    await session.releaseCccNativeCli(outcome.nativeCliHeldClosureReceipt!, createTerminalScope(permitScope));
    await killPromise;
    expect(trace).toEqual(["close", "release"]);
    expect(killedSettled).toBe(true);
  });

  it("Task 4 RED: failed release rejects its caller but leaves campaign kill held", async () => {
    const { opts, manager, permitScope } = setupHarness();
    const session = await launchCliTaskSession(opts);
    const releaseFailure = new Error("release reconciliation unavailable");
    (manager.releaseCccNativeCliSession as ReturnType<typeof vi.fn>).mockRejectedValueOnce(releaseFailure);

    let killSettled = false;
    const killCompletion = session.kill("killed");
    void killCompletion.then(
      () => { killSettled = true; },
      () => { killSettled = true; },
    );
    const outcome = await session.result();

    await expect(
      session.releaseCccNativeCli(outcome.nativeCliHeldClosureReceipt!, createTerminalScope(permitScope)),
    ).rejects.toBe(releaseFailure);
    await Promise.resolve();
    await Promise.resolve();

    expect(killSettled).toBe(false);
  });
});
