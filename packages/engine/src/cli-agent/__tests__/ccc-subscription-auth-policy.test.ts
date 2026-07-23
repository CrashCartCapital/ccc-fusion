import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IPty } from "node-pty";
import { CliAdapterRegistry } from "../adapter.js";
import { claudeCodeAdapter } from "../adapters/claude-code.js";
import { codexAdapter } from "../adapters/codex.js";
import { CliSessionManager } from "../session-manager.js";

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
    flush: vi.fn(async () => {}),
  });
}

function makePty(): IPty {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    pid: 4242,
    onData: vi.fn(() => () => {}),
    onExit: vi.fn(() => () => {}),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
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
      manager.dispose();
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
      manager.dispose();
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
      manager.dispose();
    }
  });

  it("persists only ccc profile and exact Codex model, then requires a current ready marker for a fresh manager resume", async () => {
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
        },
      });
      const recorded = store.getSession(session.id);
      expect(recorded.autonomyPosture).toMatchObject({
        cccFusionProfile: CCC_PROFILE,
        cccFusionModel: "gpt-5.6-sol",
      });
      expect(Object.keys(recorded.autonomyPosture ?? {}).sort()).toEqual(["cccFusionModel", "cccFusionProfile"]);
      expect(first.captures[0].args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
      recorded.nativeSessionId = "codex-native-session";
    } finally {
      first.manager.dispose();
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
      expect(resumed.args).toEqual(expect.arrayContaining(["resume", "codex-native-session", "-c", 'model="gpt-5.6-sol"']));
    } finally {
      restarted.manager.dispose();
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
      store.getSession(session.id).nativeSessionId = "codex-native-session";
    } finally {
      first.manager.dispose();
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
      restarted.manager.dispose();
    }
  });
});
