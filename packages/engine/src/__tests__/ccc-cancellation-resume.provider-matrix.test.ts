import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { EventEmitter, once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CliAdapterRegistry, type CliAgentAdapter } from "../cli-agent/adapter.js";
import { CliResumeCoordinator } from "../cli-agent/resume-coordinator.js";
import { CliSessionManager } from "../cli-agent/session-manager.js";
import { TelemetryHub } from "../cli-agent/telemetry-hub.js";

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

function makeManager(store: ReturnType<typeof makeStore>, adapterIds: string[], spawnPty: () => any) {
  const registry = new CliAdapterRegistry();
  for (const id of adapterIds) registry.register(makeAdapter(id));
  return {
    registry,
    manager: new CliSessionManager({
      registry,
      store: store as any,
      loadPty: vi.fn(async () => ({ spawn: () => spawnPty() })) as any,
    }),
  };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

const spawnedPids = new Set<number>();

function stopIfAlive(pid: number | undefined): void {
  if (pid === undefined || !isAlive(pid)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // The process exited between the liveness probe and cleanup.
  }
}

async function waitForDead(pid: number): Promise<void> {
  await vi.waitFor(() => expect(isAlive(pid)).toBe(false));
}

function spawnRegisteredNativeTree(order: string[]) {
  const root: ChildProcess = spawn(process.execPath, ["-e", [
    "const { spawn } = require('node:child_process');",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], { stdio: 'ignore' });",
    "process.stdout.write(String(child.pid) + '\\n');",
    "setInterval(() => {}, 1_000);",
  ].join("\n")], { stdio: ["ignore", "pipe", "ignore"] });
  if (!root.pid || !root.stdout) throw new Error("failed to create disposable registered provider root");
  spawnedPids.add(root.pid);

  const childPid = new Promise<number>((resolve, reject) => {
    let output = "";
    root.stdout!.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      const firstLine = output.split("\n")[0];
      if (/^\d+$/.test(firstLine)) {
        const pid = Number(firstLine);
        spawnedPids.add(pid);
        resolve(pid);
      }
    });
    root.once("error", reject);
  });
  const rootExited = once(root, "exit");
  root.once("exit", () => order.push("registered-root-exited"));

  const onExitCallbacks: Array<(result: { exitCode: number; signal: number }) => void> = [];
  root.once("exit", (code, signal) => {
    for (const callback of onExitCallbacks) callback({ exitCode: code ?? -1, signal: signal ? 9 : 0 });
  });

  return {
    rootPid: root.pid,
    childPid,
    rootExited,
    pty: {
      pid: root.pid,
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
        // The injected PTY supervisor knows only this registered root and its
        // registered child. It never enumerates or signals sibling processes.
        void childPid.then((pid) => stopIfAlive(pid));
        stopIfAlive(root.pid!);
      },
    },
  };
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

afterEach(async () => {
  for (const pid of spawnedPids) stopIfAlive(pid);
  spawnedPids.clear();
});

describe("ccc-fusion Wave 3 cancellation and resume provider matrix", () => {
  it.each(["claude-code", "codex"])("%s waits for its registered local root and descendant before flushing and releasing", async (adapterId) => {
    const store = makeStore();
    const tree = spawnRegisteredNativeTree(store.order);
    const sibling = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], { stdio: "ignore" });
    if (!sibling.pid) throw new Error("failed to create unregistered sibling");
    spawnedPids.add(sibling.pid);
    const { manager } = makeManager(store, [adapterId], () => tree.pty);

    try {
      const session = await manager.spawn({ adapterId, projectId: "ccc", purpose: "execute", taskId: "FN-W3" });
      const registeredChildPid = await tree.childPid;

      await manager.kill(session.id, "killed");

      await tree.rootExited;
      await waitForDead(registeredChildPid);
      expect(isAlive(sibling.pid)).toBe(true);
      expect(store.getSession(session.id)).toMatchObject({
        agentState: "dead",
        terminationReason: "killed",
        autonomyPosture: { cccCancellationState: "CANCELLED" },
      });
      expect(store.flush).toHaveBeenCalledTimes(2);
      expect(store.order.indexOf("registered-root-exited")).toBeLessThan(store.order.indexOf("persist:dead:killed"));
      expect(store.order.indexOf("persist:dead:killed")).toBeGreaterThanOrEqual(0);
      expect(store.order.lastIndexOf("flush")).toBeGreaterThan(store.order.indexOf("persist:dead:killed"));
      expect(manager.activeCount()).toBe(0);

      await manager.kill(session.id, "killed");
      expect(store.flush).toHaveBeenCalledTimes(2);
    } finally {
      stopIfAlive(sibling.pid);
      await manager.dispose();
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

  it.each(["claude-code", "codex", "custom-provider-pi"])("%s enforces exact resume identity", async (adapterId) => {
    await runResumeIdentityMatrix(adapterId);
  });

  it.each(["claude-code", "codex", "custom-provider-pi"])("%s records a committed tool effect and suppresses the identical effect after a controller restart", (adapterId) => {
    const store = makeStore();
    store.sessions.set("effect-session", {
      id: "effect-session",
      projectId: "ccc",
      adapterId,
      purpose: "execute",
      taskId: "FN-W3",
      chatSessionId: null,
      agentState: "busy",
      terminationReason: null,
      nativeSessionId: "provider-native",
      resumeAttempts: 0,
      autonomyPosture: null,
      worktreePath: "/tmp/wave3",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const observed = vi.fn();
    const first = new TelemetryHub({ store: store as any, onEvent: observed });
    first.issueToken("effect-session");
    first.ingest("effect-session", { kind: "toolActivity", payload: { effectIdentity: "tool:commit-1" } });

    const restarted = new TelemetryHub({ store: store as any, onEvent: observed });
    restarted.issueToken("effect-session");
    restarted.ingest("effect-session", { kind: "toolActivity", payload: { effectIdentity: "tool:commit-1" } });

    expect(store.getSession("effect-session").autonomyPosture).toMatchObject({
      cccEffectReceipts: ["tool:commit-1"],
    });
    expect(observed).toHaveBeenCalledTimes(1);
  });
});

async function runResumeIdentityMatrix(adapterId: string): Promise<void> {
  for (const [_label, mismatch] of [
    ["native session", { nativeSessionId: "native-other" }],
    ["requested model", { model: "model-other" }],
    ["permission/autonomy", { permissionAutonomy: "unrestricted" }],
    ["effect/tool identity", { effectIdentity: "tool:other" }],
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
      const session = await manager.spawn({ adapterId, projectId: "ccc", purpose: "execute" });
      store.updateSession(session.id, {
        agentState: "dead",
        terminationReason: "crashed",
        nativeSessionId: "native-exact",
        autonomyPosture: {
          cccResumeContract: {
            adapterId,
            nativeSessionId: "native-exact",
            requestedModel: "model-exact",
            permissionAutonomy: "guarded",
            effectIdentity: "tool:exact",
          },
        },
      });

      await expect(manager.spawn({
        adapterId,
        projectId: "ccc",
        purpose: "execute",
        settings: { model: "model-exact", permissionAutonomy: "guarded", effectIdentity: "tool:exact" },
        resume: { sessionId: session.id, nativeSessionId: "native-exact" },
      })).resolves.toMatchObject({ id: session.id });

      const requested = {
        model: "model-exact",
        permissionAutonomy: "guarded",
        effectIdentity: "tool:exact",
        ...mismatch,
      } as Record<string, string>;
      const nativeSessionId = requested.nativeSessionId ?? "native-exact";
      delete requested.nativeSessionId;
      await expect(manager.spawn({
        adapterId,
        projectId: "ccc",
        purpose: "execute",
        settings: requested,
        resume: { sessionId: session.id, nativeSessionId },
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
