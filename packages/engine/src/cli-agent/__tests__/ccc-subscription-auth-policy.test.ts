import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IPty } from "node-pty";
import { CliAdapterRegistry } from "../adapter.js";
import { claudeCodeAdapter } from "../adapters/claude-code.js";
import { codexAdapter } from "../adapters/codex.js";
import { CliSessionManager } from "../session-manager.js";
import { TelemetryHub } from "../telemetry-hub.js";

const CCC_PROFILE = "ccc-fusion";
const CLAUDE_FORBIDDEN = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
];
const CODEX_FORBIDDEN = ["OPENAI_API_KEY", "OPENAI_BASE_URL"];

type SpawnCapture = { command: string; args: string[]; options: { env: Record<string, string | undefined> } };

function makeStore() {
  const sessions = new Map<string, any>();
  let nextId = 0;
  return Object.assign(new EventEmitter(), {
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
    getSession: vi.fn((id: string) => sessions.get(id)),
    listSessions: vi.fn(() => [...sessions.values()]),
    flush: vi.fn(async () => {}),
  });
}

function makePty(): IPty {
  const emitter = new EventEmitter();
  let onExit: ((event: { exitCode: number; signal: number }) => void) | undefined;
  return Object.assign(emitter, {
    pid: 4242,
    onData: vi.fn(() => () => {}),
    onExit: vi.fn((listener: (event: { exitCode: number; signal: number }) => void) => {
      onExit = listener;
      return () => {
        if (onExit === listener) onExit = undefined;
      };
    }),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(() => {
      queueMicrotask(() => onExit?.({ exitCode: -1, signal: 9 }));
    }),
    pause: vi.fn(),
    resume: vi.fn(),
  }) as unknown as IPty;
}

function makeManager(store: ReturnType<typeof makeStore>) {
  const captures: SpawnCapture[] = [];
  const registry = new CliAdapterRegistry();
  registry.register(claudeCodeAdapter);
  registry.register(codexAdapter);
  const manager = new CliSessionManager({
    registry,
    store: store as any,
    loadPty: vi.fn(async () => ({
      spawn: (command: string, args: string[], options: SpawnCapture["options"]) => {
        captures.push({ command, args, options });
        return makePty();
      },
    })) as any,
  });
  return { manager, captures };
}

/** Inspect the real provider argv carried inside the manager-owned CCC bridge. */
function providerLaunchArgs(args: string[]): string[] {
  if (args[0] !== "-e" || typeof args[2] !== "string") return args;
  const decoded = JSON.parse(Buffer.from(args[2], "base64").toString("utf8")) as { args?: unknown };
  return Array.isArray(decoded.args) && decoded.args.every((arg) => typeof arg === "string")
    ? decoded.args
    : args;
}

function installFakeChildEnv(): void {
  vi.stubEnv("HOME", "/fake/home");
  vi.stubEnv("PATH", "/fake/bin");
  vi.stubEnv("TERM", "xterm-fake");
  vi.stubEnv("CODEX_HOME", "/fake/codex-home");
  vi.stubEnv("ANTHROPIC_API_KEY", "fake-anthropic-key");
  vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "fake-anthropic-auth");
  vi.stubEnv("ANTHROPIC_BASE_URL", "https://fake-anthropic.invalid");
  vi.stubEnv("CLAUDE_CODE_USE_BEDROCK", "1");
  vi.stubEnv("CLAUDE_CODE_USE_VERTEX", "1");
  vi.stubEnv("OPENAI_API_KEY", "fake-openai-key");
  vi.stubEnv("OPENAI_BASE_URL", "https://fake-openai.invalid");
}

function captureNativeSessionId(
  store: ReturnType<typeof makeStore>,
  sessionId: string,
  nativeSessionId: string,
): void {
  const telemetry = new TelemetryHub({ store: store as any });
  telemetry.issueToken(sessionId);
  telemetry.ingest(sessionId, { kind: "sessionStart", payload: { nativeSessionId } });
}

afterEach(() => vi.unstubAllEnvs());

describe("ccc-fusion subscription child environment policy", () => {
  it("blocks ccc-fusion without subscription readiness before the real PTY boundary", async () => {
    const store = makeStore();
    const { manager, captures } = makeManager(store);
    try {
      await expect(manager.spawn({
        adapterId: "claude-code",
        projectId: "project-ccc",
        purpose: "execute",
        settings: { profile: CCC_PROFILE, model: "claude-sonnet-4-6" },
      })).rejects.toMatchObject({ code: "CCC_SUBSCRIPTION_PREFLIGHT_REQUIRED" });

      expect(captures).toEqual([]);
      expect(store.createSession).not.toHaveBeenCalled();
    } finally {
      await manager.dispose();
    }
  });

  it("blocks ccc-fusion when subscription readiness is explicitly false before the real PTY boundary", async () => {
    const store = makeStore();
    const { manager, captures } = makeManager(store);
    try {
      await expect(manager.spawn({
        adapterId: "claude-code",
        projectId: "project-ccc",
        purpose: "execute",
        settings: { profile: CCC_PROFILE, model: "claude-sonnet-4-6", subscriptionReady: false },
      })).rejects.toMatchObject({ code: "CCC_SUBSCRIPTION_PREFLIGHT_REQUIRED" });

      expect(captures).toEqual([]);
      expect(store.createSession).not.toHaveBeenCalled();
    } finally {
      await manager.dispose();
    }
  });

  it("strips Claude billing-route variables only for the explicit ccc-fusion profile while retaining safe terminal variables", async () => {
    installFakeChildEnv();
    const store = makeStore();
    const { manager, captures } = makeManager(store);
    try {
      await manager.spawn({
        adapterId: "claude-code",
        projectId: "project-ccc",
        purpose: "execute",
        settings: { profile: CCC_PROFILE, model: "claude-sonnet-4-6", subscriptionReady: true },
      });

      const cccEnv = captures[0].options.env;
      expect(cccEnv).toMatchObject({ HOME: "/fake/home", PATH: "/fake/bin", TERM: "xterm-fake" });
      for (const key of CLAUDE_FORBIDDEN) expect(cccEnv[key]).toBeUndefined();

      await manager.spawn({
        adapterId: "claude-code",
        projectId: "project-fusion",
        purpose: "execute",
        settings: { model: "claude-sonnet-4-6" },
      });
      expect(captures[1].options.env.ANTHROPIC_API_KEY).toBe("fake-anthropic-key");
    } finally {
      await manager.dispose();
    }
  });

  it("persists the ccc resume contract with the exact Codex model and sanitized MCP set, then requires a current ready marker for a fresh manager resume", async () => {
    installFakeChildEnv();
    const store = makeStore();
    const first = makeManager(store);
    let session: any;
    try {
      session = await first.manager.spawn({
        adapterId: "codex",
        projectId: "project-ccc",
        purpose: "execute",
        settings: { profile: CCC_PROFILE, model: "gpt-5.6-sol", subscriptionReady: true },
        posture: {
          autoApprove: true,
          cccFusionSubscriptionReady: true,
          unexpected: "must-not-persist",
          effectivePosture: {
            mode: "elevated",
            elevated: true,
            flags: ["--sandbox", "danger-full-access"],
          },
        },
      });
      const recorded = store.getSession(session.id);
      expect(recorded.autonomyPosture).toMatchObject({
        cccFusionProfile: CCC_PROFILE,
        cccFusionModel: "gpt-5.6-sol",
        cccFusionMcpServers: [],
        effectivePosture: {
          mode: "elevated",
          elevated: true,
          flags: ["--sandbox", "danger-full-access"],
        },
        cccResumeContract: {
          adapterId: "codex",
          nativeSessionId: null,
          requestedModel: "gpt-5.6-sol",
          permissionAutonomy: '{"mode":"elevated","elevated":true,"flags":["--sandbox","danger-full-access"]}',
          effectReceiptContract: "ccc-tool-receipts/v1",
        },
      });
      expect(Object.keys(recorded.autonomyPosture ?? {}).sort()).toEqual([
        "cccFusionMcpServers",
        "cccFusionModel",
        "cccFusionProfile",
        "cccResumeContract",
        "effectivePosture",
      ]);
      expect(first.captures[0].args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
      captureNativeSessionId(store, session.id, "codex-native-session");
    } finally {
      await first.manager.dispose();
    }

    const restarted = makeManager(store);
    try {
      await restarted.manager.spawn({
        adapterId: "codex",
        projectId: "project-ccc",
        purpose: "execute",
        resume: { sessionId: session.id, nativeSessionId: "codex-native-session" },
        settings: { subscriptionReady: true },
      });

      const freshEnv = first.captures[0].options.env;
      const resumed = restarted.captures[0];
      expect(freshEnv).toMatchObject({ CODEX_HOME: "/fake/codex-home", PATH: "/fake/bin", TERM: "xterm-fake" });
      expect(resumed.options.env).toMatchObject({ CODEX_HOME: "/fake/codex-home", PATH: "/fake/bin", TERM: "xterm-fake" });
      for (const key of CODEX_FORBIDDEN) {
        expect(freshEnv[key]).toBeUndefined();
        expect(resumed.options.env[key]).toBeUndefined();
      }
      expect(resumed.command).toBe(process.execPath);
      expect(providerLaunchArgs(resumed.args)).toEqual(expect.arrayContaining(["resume", "codex-native-session", "-c", 'model="gpt-5.6-sol"']));
    } finally {
      await restarted.manager.dispose();
    }
  });

  it("blocks a ccc Codex resume without a current ready marker after a prior ready launch", async () => {
    installFakeChildEnv();
    const store = makeStore();
    const first = makeManager(store);
    let session: any;
    try {
      session = await first.manager.spawn({
        adapterId: "codex",
        projectId: "project-ccc",
        purpose: "execute",
        settings: { profile: CCC_PROFILE, model: "gpt-5.6-sol", subscriptionReady: true },
      });
      captureNativeSessionId(store, session.id, "codex-native-session");
    } finally {
      await first.manager.dispose();
    }

    const restarted = makeManager(store);
    try {
      await expect(restarted.manager.spawn({
        adapterId: "codex",
        projectId: "project-ccc",
        purpose: "execute",
        resume: { sessionId: session.id, nativeSessionId: "codex-native-session" },
      })).rejects.toMatchObject({ code: "CCC_SUBSCRIPTION_PREFLIGHT_REQUIRED" });

      expect(restarted.captures).toEqual([]);
    } finally {
      await restarted.manager.dispose();
    }
  });

  it("keeps pre-Wave non-ccc resume model and autonomy choices permissive", async () => {
    installFakeChildEnv();
    const store = makeStore();
    const first = makeManager(store);
    let session: any;
    try {
      session = await first.manager.spawn({
        adapterId: "codex",
        projectId: "project-fusion",
        purpose: "execute",
        settings: { model: "predecessor-model", permissionAutonomy: "guarded" },
      });
      store.updateSession(session.id, { nativeSessionId: "predecessor-native-session" });
    } finally {
      await first.manager.dispose();
    }

    const restarted = makeManager(store);
    try {
      await expect(restarted.manager.spawn({
        adapterId: "codex",
        projectId: "project-fusion",
        purpose: "execute",
        resume: { sessionId: session.id, nativeSessionId: "predecessor-native-session" },
        settings: { model: "changed-model-is-allowed", permissionAutonomy: "unrestricted" },
      })).resolves.toMatchObject({ id: session.id });

      expect(restarted.captures[0]!.args).toEqual(expect.arrayContaining([
        "resume",
        "predecessor-native-session",
        "-c",
        'model="changed-model-is-allowed"',
      ]));
    } finally {
      await restarted.manager.dispose();
    }
  });
});
