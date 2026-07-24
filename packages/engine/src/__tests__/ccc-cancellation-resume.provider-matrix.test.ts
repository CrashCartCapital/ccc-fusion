import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { EventEmitter, once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { CliAdapterRegistry, type CliAgentAdapter } from "../cli-agent/adapter.js";
import { claudeCodeAdapter } from "../cli-agent/adapters/claude-code.js";
import { codexAdapter } from "../cli-agent/adapters/codex.js";
import { CliResumeCoordinator } from "../cli-agent/resume-coordinator.js";
import { CliSessionManager } from "../cli-agent/session-manager.js";

type Session = Record<string, any>;

function makeStore() {
  const sessions = new Map<string, Session>();
  let nextId = 0;
  const order: string[] = [];
  return Object.assign(new EventEmitter(), {
    sessions,
    order,
    createSession: vi.fn((input: Record<string, unknown>) => {
      const session = {
        ...input,
        id: `wave3-${++nextId}`,
        nativeSessionId: null,
        resumeAttempts: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      sessions.set(session.id, session);
      return session;
    }),
    updateSession: vi.fn((id: string, updates: Record<string, unknown>) => {
      const session = sessions.get(id);
      if (!session) return undefined;
      order.push(`persist:${updates.agentState ?? "unchanged"}:${updates.terminationReason ?? "none"}`);
      Object.assign(session, updates);
      return session;
    }),
    getSession: vi.fn((id: string) => sessions.get(id)),
    listSessions: vi.fn(() => [...sessions.values()]),
    listByTask: vi.fn((taskId: string) => [...sessions.values()].filter((session) => session.taskId === taskId)),
    flush: vi.fn(async () => {
      order.push("flush");
    }),
  });
}

function makeAdapter(id: string): CliAgentAdapter {
  return {
    id,
    name: id,
    capabilities: { nativeDone: true, nativeWaiting: true, transcriptSource: "hooks", supportsResume: true },
    defaultCommand: process.execPath,
    buildLaunch: ({ settings }) => ({ command: process.execPath, args: ["-e", String(settings.model ?? "fresh")] }),
    buildResume: ({ settings, nativeSessionId }) => ({
      command: process.execPath,
      args: ["-e", `${String(settings.model ?? "resume")}:${nativeSessionId}`],
    }),
    buildEnvAllowlist: () => [],
    createReadinessDetector: () => ({ observe: () => false }),
    formatInjection: (text) => ({ payload: text }),
  };
}

function makeManager(
  store: ReturnType<typeof makeStore>,
  adapterIds: string[],
  spawnPty: () => any,
  options: { cancellationTimeoutMs?: number } = {},
) {
  const registry = new CliAdapterRegistry();
  for (const id of adapterIds) registry.register(makeAdapter(id));
  return {
    registry,
    manager: new CliSessionManager({
      registry,
      store: store as any,
      loadPty: vi.fn(async () => ({ spawn: () => spawnPty() })) as any,
      ...options,
    }),
  };
}

const LOCAL_PROVIDER_TREE = [
  "const { spawn } = require('node:child_process');",
  "const child = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 500)'], { stdio: 'ignore' });",
  "setTimeout(() => process.stdout.write(String(child.pid) + '\\n'), 10);",
  "setInterval(() => {}, 1_000);",
].join("\n");

function productionAdapterWithDisposableProvider(adapter: CliAgentAdapter): CliAgentAdapter {
  return {
    ...adapter,
    buildLaunch: () => ({ command: process.execPath, args: ["-e", LOCAL_PROVIDER_TREE] }),
    buildResume: () => ({ command: process.execPath, args: ["-e", LOCAL_PROVIDER_TREE] }),
    // The production session-manager seam is under test; no child environment
    // values or vendor command are needed for the disposable local provider.
    buildEnvAllowlist: () => [],
  };
}

function productionAdapterWithNaturalExit(adapter: CliAgentAdapter, exitCode: number): CliAgentAdapter {
  return {
    ...adapter,
    buildLaunch: () => ({ command: process.execPath, args: ["-e", `process.exit(${exitCode})`] }),
    buildResume: () => ({ command: process.execPath, args: ["-e", `process.exit(${exitCode})`] }),
    buildEnvAllowlist: () => [],
  };
}

function rootOnlyProcessPty() {
  return {
    spawn: (command: string, args: string[], options: { cwd: string; env: Record<string, string> }) => {
      const root = spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (!root.pid || !root.stdout) throw new Error("failed to start disposable PTY root");
      const dataListeners = new Set<(data: string) => void>();
      const exitListeners = new Set<(event: { exitCode: number; signal: number }) => void>();
      root.stdout.on("data", (chunk: Buffer) => {
        for (const listener of dataListeners) listener(chunk.toString("utf8"));
      });
      root.once("exit", (exitCode, signal) => {
        for (const listener of exitListeners) listener({ exitCode: exitCode ?? -1, signal: signal ? 9 : 0 });
      });
      return {
        pid: root.pid,
        onData: (listener: (data: string) => void) => {
          dataListeners.add(listener);
          return () => dataListeners.delete(listener);
        },
        onExit: (listener: (event: { exitCode: number; signal: number }) => void) => {
          exitListeners.add(listener);
          return () => exitListeners.delete(listener);
        },
        write: () => {}, resize: () => {}, pause: () => {}, resume: () => {},
        // This bridge deliberately signals only the PTY root. The behavior under
        // test must come from the production-owned supervisor, never the fake.
        kill: (signal: NodeJS.Signals) => process.kill(root.pid!, signal),
      };
    },
  };
}

function makeProductionManager(store: ReturnType<typeof makeStore>, adapter: CliAgentAdapter) {
  const registry = new CliAdapterRegistry();
  registry.register(productionAdapterWithDisposableProvider(adapter));
  return new CliSessionManager({
    registry,
    store: store as any,
    loadPty: vi.fn(async () => rootOnlyProcessPty()) as any,
  });
}

function makeProductionNaturalExitManager(store: ReturnType<typeof makeStore>, adapter: CliAgentAdapter, exitCode: number) {
  const registry = new CliAdapterRegistry();
  registry.register(productionAdapterWithNaturalExit(adapter, exitCode));
  return new CliSessionManager({
    registry,
    store: store as any,
    loadPty: vi.fn(async () => rootOnlyProcessPty()) as any,
  });
}

async function readProviderDescendantPid(manager: CliSessionManager, sessionId: string): Promise<number> {
  const attachment = manager.attach(sessionId);
  const decoder = new TextDecoder();
  let output = decoder.decode(attachment.scrollback);
  for await (const chunk of attachment.stream) {
    output += decoder.decode(chunk, { stream: true });
    const line = output.split(/\r?\n/).find((candidate) => /^\d+$/.test(candidate));
    if (line) {
      attachment.detach();
      return Number(line);
    }
  }
  throw new Error("disposable provider did not report its descendant pid");
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function startLoopbackStream(): Promise<{
  server: Server;
  pty: any;
  requestClosed: () => boolean;
}> {
  let closed = false;
  const server = createServer((request, response) => {
    request.once("close", () => {
      closed = true;
    });
    response.writeHead(200, { "content-type": "text/plain" });
    response.write("stream-open\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing loopback address");

  const controller = new AbortController();
  const response = await fetch(`http://127.0.0.1:${address.port}/stream`, { signal: controller.signal });
  await response.body?.getReader().read();

  const onExitCallbacks: Array<(result: { exitCode: number; signal: number }) => void> = [];
  const pty = {
    pid: 9100,
    onData: () => () => {},
    onExit: (callback: (result: { exitCode: number; signal: number }) => void) => {
      onExitCallbacks.push(callback);
      return () => {};
    },
    write: () => {},
    resize: () => {},
    pause: () => {},
    resume: () => {},
    kill: () => {
      controller.abort();
      void vi.waitFor(() => expect(closed).toBe(true)).then(() => {
        for (const callback of onExitCallbacks) callback({ exitCode: -1, signal: 9 });
      });
    },
  };
  return { server, pty, requestClosed: () => closed };
}

describe("ccc-fusion Wave 3 cancellation and resume provider matrix", () => {
  it.each([claudeCodeAdapter, codexAdapter])("$name owns its provider descendant through the production PTY bridge", async (adapter) => {
    const store = makeStore();
    const manager = makeProductionManager(store, adapter);
    const sibling = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 500)"], { stdio: "ignore" });
    if (!sibling.pid) throw new Error("failed to create unregistered sibling");

    try {
      const session = await manager.spawn({
        adapterId: adapter.id,
        projectId: "ccc",
        purpose: "execute",
        taskId: "FN-W3",
        settings: { profile: "ccc-fusion", subscriptionReady: true },
      });
      const registeredChildPid = await readProviderDescendantPid(manager, session.id);

      await manager.kill(session.id, "killed");

      expect(isAlive(registeredChildPid)).toBe(false);
      expect(isAlive(sibling.pid)).toBe(true);
      expect(store.getSession(session.id)).toMatchObject({
        agentState: "dead",
        terminationReason: "killed",
        autonomyPosture: { cccCancellationState: "CANCELLED" },
      });
      expect(store.flush).toHaveBeenCalledTimes(2);
      expect(store.order.indexOf("persist:dead:killed")).toBeGreaterThanOrEqual(0);
      expect(store.order.lastIndexOf("flush")).toBeGreaterThan(store.order.indexOf("persist:dead:killed"));
      expect(manager.activeCount()).toBe(0);

      await manager.kill(session.id, "killed");
      expect(store.flush).toHaveBeenCalledTimes(2);
    } finally {
      await manager.dispose();
    }
  });

  it.each([claudeCodeAdapter, codexAdapter])("$name preserves a natural nonzero provider exit through the production supervisor", async (adapter) => {
    const store = makeStore();
    const manager = makeProductionNaturalExitManager(store, adapter, 47);
    try {
      const session = await manager.spawn({
        adapterId: adapter.id,
        projectId: "ccc",
        purpose: "execute",
        settings: { profile: "ccc-fusion", subscriptionReady: true },
      });

      await expect(manager.waitForExit(session.id)).resolves.toEqual({ exitCode: 47, signal: 0 });
      await vi.waitFor(() => expect(manager.activeCount()).toBe(0));
      expect(store.getSession(session.id)).toMatchObject({
        agentState: "dead",
        terminationReason: "crashed",
      });
    } finally {
      await manager.dispose();
    }
  });

  it("keeps CCC ownership and returns a typed failure when the registered PTY never closes", async () => {
    const store = makeStore();
    let onExit: ((result: { exitCode: number; signal: number }) => void) | undefined;
    const pty = {
      pid: 9200,
      onData: () => () => {},
      onExit: (callback: (result: { exitCode: number; signal: number }) => void) => {
        onExit = callback;
        return () => {};
      },
      write: () => {}, resize: () => {}, pause: () => {}, resume: () => {},
      // Deliberately accepts the signal but never proves registered-resource
      // closure. This is the production manager's bounded failure seam.
      kill: vi.fn(),
    };
    const { manager } = makeManager(store, ["claude-code"], () => pty, { cancellationTimeoutMs: 15 });
    let result: { status: "fulfilled" } | { status: "rejected"; code?: string } | { status: "deadline-breached" };

    try {
      result = await Promise.race([
        manager.kill((await manager.spawn({
          adapterId: "claude-code",
          projectId: "ccc",
          purpose: "execute",
          settings: { profile: "ccc-fusion", subscriptionReady: true },
        })).id, "killed").then(
          () => ({ status: "fulfilled" as const }),
          (error: unknown) => ({ status: "rejected" as const, code: (error as { code?: string }).code }),
        ),
        new Promise<{ status: "deadline-breached" }>((resolve) => setTimeout(() => resolve({ status: "deadline-breached" }), 80)),
      ]);

      expect(result).toEqual({ status: "rejected", code: "CLI_CANCELLATION_TIMEOUT" });
      expect(pty.kill).toHaveBeenCalledTimes(1);
      expect(manager.activeCount()).toBe(1);
      expect([...store.sessions.values()][0]).toMatchObject({
        agentState: "needsAttention",
        terminationReason: null,
        autonomyPosture: { cccCancellationState: "CANCELLATION_UNCONFIRMED" },
      });
      expect(store.order).not.toContain("persist:dead:killed");
    } finally {
      // This closes only the synthetic registered resource after the assertions;
      // it never targets an OS process and lets the manager remove its exit hook.
      onExit?.({ exitCode: -1, signal: 9 });
      await manager.dispose().catch(() => undefined);
    }
  });

  it("keeps CCC ownership and a non-terminal record when the cancellation flush rejects", async () => {
    const store = makeStore();
    let onExit: ((result: { exitCode: number; signal: number }) => void) | undefined;
    const pty = {
      pid: 9201,
      onData: () => () => {},
      onExit: (callback: (result: { exitCode: number; signal: number }) => void) => {
        onExit = callback;
        return () => {};
      },
      write: () => {}, resize: () => {}, pause: () => {}, resume: () => {},
      kill: vi.fn(() => onExit?.({ exitCode: -1, signal: 9 })),
    };
    const { manager } = makeManager(store, ["claude-code"], () => pty);
    try {
      const session = await manager.spawn({
        adapterId: "claude-code",
        projectId: "ccc",
        purpose: "execute",
        settings: { profile: "ccc-fusion", subscriptionReady: true },
      });
      store.flush.mockRejectedValueOnce(new Error("durable cancellation flush rejected"));

      await expect(manager.kill(session.id, "killed"))
        .rejects.toMatchObject({ code: "CLI_CANCELLATION_PERSISTENCE_FAILED" });

      expect(store.getSession(session.id)).toMatchObject({
        agentState: "needsAttention",
        terminationReason: null,
        autonomyPosture: { cccCancellationState: "CANCELLATION_UNCONFIRMED" },
      });
      expect(manager.activeCount()).toBe(1);
      expect(store.order.at(-2)).toBe("persist:needsAttention:none");
      expect(store.order.at(-1)).toBe("flush");
    } finally {
      await manager.dispose().catch(() => undefined);
    }
  });

  it("custom-provider-pi awaits only its real loopback request closure, then flushes before acknowledgement", async () => {
    const store = makeStore();
    const loopback = await startLoopbackStream();
    const { manager } = makeManager(store, ["custom-provider-pi"], () => loopback.pty);
    try {
      const session = await manager.spawn({ adapterId: "custom-provider-pi", projectId: "ccc", purpose: "execute" });

      await manager.kill(session.id, "killed");

      expect(loopback.requestClosed()).toBe(true);
      expect(store.getSession(session.id)).toMatchObject({
        agentState: "dead",
        terminationReason: "killed",
        autonomyPosture: { cccCancellationState: "CANCELLED" },
      });
      expect(store.flush).toHaveBeenCalledTimes(2);
      expect(manager.activeCount()).toBe(0);
    } finally {
      await new Promise<void>((resolve) => loopback.server.close(() => resolve()));
      await manager.dispose();
    }
  });

  it("rejects a direct resume of a durably killed session before any replacement PTY can spawn", async () => {
    const store = makeStore();
    let exits: Array<(event: { exitCode: number; signal: number }) => void> = [];
    const pty = {
      pid: 9301,
      onData: () => () => {},
      onExit: (callback: (event: { exitCode: number; signal: number }) => void) => {
        exits.push(callback);
        return () => { exits = exits.filter((candidate) => candidate !== callback); };
      },
      write: () => {}, resize: () => {}, pause: () => {}, resume: () => {},
      kill: () => exits.forEach((callback) => callback({ exitCode: -1, signal: 9 })),
    };
    const { manager } = makeManager(store, ["claude-code"], () => pty);
    try {
      const session = await manager.spawn({ adapterId: "claude-code", projectId: "ccc", purpose: "execute" });
      store.updateSession(session.id, { nativeSessionId: "native-killed" });
      await manager.kill(session.id, "killed");

      await expect(manager.spawn({
        adapterId: "claude-code",
        projectId: "ccc",
        purpose: "execute",
        resume: { sessionId: session.id, nativeSessionId: "native-killed" },
      })).rejects.toThrow(/killed|ineligible|resume/i);
      expect(manager.activeCount()).toBe(0);
    } finally {
      await manager.dispose().catch(() => undefined);
    }
  });

  it("rejects a direct resume when the same durable id is already owned live", async () => {
    const store = makeStore();
    const pty = {
      pid: 9302,
      onData: () => () => {},
      onExit: () => () => {},
      write: () => {}, resize: () => {}, pause: () => {}, resume: () => {}, kill: () => {},
    };
    const { manager } = makeManager(store, ["codex"], () => pty);
    try {
      const session = await manager.spawn({ adapterId: "codex", projectId: "ccc", purpose: "execute" });
      store.updateSession(session.id, { nativeSessionId: "native-live", agentState: "ready" });

      await expect(manager.spawn({
        adapterId: "codex",
        projectId: "ccc",
        purpose: "execute",
        resume: { sessionId: session.id, nativeSessionId: "native-live" },
      })).rejects.toThrow(/already live|owned|resume/i);
      expect(manager.activeCount()).toBe(1);
    } finally {
      await manager.dispose().catch(() => undefined);
    }
  });

  it.each(["claude-code", "codex"])("%s enforces exact ccc resume identity", async (adapterId) => {
    await runResumeIdentityMatrix(adapterId);
  });

});

async function runResumeIdentityMatrix(adapterId: string): Promise<void> {
  for (const [_label, mismatch] of [
    ["native session", { nativeSessionId: "native-other" }],
    ["requested model", { model: "model-other" }],
  ] as const) {
    const store = makeStore();
    let onExit: ((result: { exitCode: number; signal: number }) => void) | undefined;
    const pty = {
      pid: 9901,
      onData: () => () => {},
      onExit: (callback: (result: { exitCode: number; signal: number }) => void) => {
        onExit = callback;
        return () => {};
      },
      write: () => {}, resize: () => {}, pause: () => {}, resume: () => {},
      kill: () => onExit?.({ exitCode: -1, signal: 9 }),
    };
    const { manager, registry } = makeManager(store, [adapterId], () => pty);
    try {
      const session = await manager.spawn({
        adapterId,
        projectId: "ccc",
        purpose: "execute",
        settings: { profile: "ccc-fusion", subscriptionReady: true },
      });
      store.updateSession(session.id, {
        agentState: "dead",
        terminationReason: "crashed",
        nativeSessionId: "native-exact",
        autonomyPosture: {
          cccFusionProfile: "ccc-fusion",
          cccFusionMcpServers: [],
          effectivePosture: { mode: "guarded", elevated: false, flags: [] },
          cccResumeContract: {
            adapterId,
            nativeSessionId: "native-exact",
            requestedModel: "model-exact",
            permissionAutonomy: '{"mode":"guarded","elevated":false,"flags":[]}',
            effectReceiptContract: "ccc-tool-receipts/v2",
          },
        },
      });
      // This matrix is a manager-restart/resume case: release the original
      // in-memory owner before asserting durable resume admission.
      onExit?.({ exitCode: 1, signal: 0 });
      await vi.waitFor(() => expect(manager.activeCount()).toBe(0));

      await expect(manager.spawn({
        adapterId,
        projectId: "ccc",
        purpose: "execute",
        settings: { profile: "ccc-fusion", subscriptionReady: true, model: "model-exact" },
        resume: { sessionId: session.id, nativeSessionId: "native-exact" },
      })).resolves.toMatchObject({ id: session.id });
      // Subsequent assertions exercise resume-contract admission, not the
      // separate live-owner guard. Model the resumed provider's real terminal
      // callback before asking the manager to consider another resume.
      onExit?.({ exitCode: 1, signal: 0 });
      await vi.waitFor(() => expect(manager.activeCount()).toBe(0));

      const requested = {
        profile: "ccc-fusion",
        subscriptionReady: true,
        model: "model-exact",
        ...mismatch,
      } as Record<string, string | boolean>;
      const nativeSessionId = typeof requested.nativeSessionId === "string"
        ? requested.nativeSessionId
        : "native-exact";
      delete requested.nativeSessionId;
      await expect(manager.spawn({
        adapterId,
        projectId: "ccc",
        purpose: "execute",
        settings: requested,
        resume: { sessionId: session.id, nativeSessionId },
      })).rejects.toThrow(/resume contract/i);

      const record = store.getSession(session.id);
      store.updateSession(session.id, {
        autonomyPosture: {
          ...(record.autonomyPosture ?? {}),
          effectivePosture: { mode: "unrestricted", elevated: true, flags: ["synthetic"] },
        },
      });
      await expect(manager.spawn({
        adapterId,
        projectId: "ccc",
        purpose: "execute",
        settings: { profile: "ccc-fusion", subscriptionReady: true, model: "model-exact" },
        resume: { sessionId: session.id, nativeSessionId: "native-exact" },
      })).rejects.toThrow(/resume contract/i);

      store.updateSession(session.id, {
        autonomyPosture: {
          ...(record.autonomyPosture ?? {}),
          cccResumeContract: {
            ...(record.autonomyPosture?.cccResumeContract ?? {}),
            effectReceiptContract: "ccc-tool-receipts/v0",
          },
        },
      });
      await expect(manager.spawn({
        adapterId,
        projectId: "ccc",
        purpose: "execute",
        settings: { profile: "ccc-fusion", subscriptionReady: true, model: "model-exact" },
        resume: { sessionId: session.id, nativeSessionId: "native-exact" },
      })).rejects.toThrow(/resume contract/i);

      const coordinator = new CliResumeCoordinator({
        store: store as any,
        manager: { isLive: () => false, availableSlots: () => 1, spawn: vi.fn() } as any,
        registry,
        worktreeExists: () => true,
        isWorktreeDirty: async () => false,
      });
      const killed = { ...store.getSession(session.id), agentState: "dead", terminationReason: "killed" };
      await expect(coordinator.resumeOne(killed)).resolves.toMatchObject({ disposition: "needsAttention-ineligible" });
      expect((coordinator as any).manager.spawn).not.toHaveBeenCalled();
    } finally {
      await manager.dispose();
    }
  }
}
