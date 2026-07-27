import { rmSync, mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn as spawnChild } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CCC_CAMPAIGN_CONTEXT_SCHEMA_VERSION,
  CCC_CAMPAIGN_EXECUTION_POLICY_SCHEMA_VERSION,
  createCccCampaignAuthorityBinding,
  type CccCampaignTaskContext,
} from "@fusion/core";
import type { IPty } from "node-pty";
import type { CliAgentAdapter } from "../cli-agent/adapter.js";
import { CliAdapterRegistry } from "../cli-agent/adapter.js";
import { CCC_NATIVE_CLI_DISPATCH_KEY } from "../cli-agent/ccc-native-cli-binding.js";
import { CliSessionManager } from "../cli-agent/session-manager.js";

const CCC_PROFILE = "ccc-fusion";
const contextNowMs = Date.now();
const CONTEXT: CccCampaignTaskContext = Object.freeze({
  schema: CCC_CAMPAIGN_CONTEXT_SCHEMA_VERSION,
  projectId: "project-1",
  importId: "import-1",
  campaignId: "campaign-1",
  taskId: "REQ-9",
  semanticTaskId: "REQ-9",
  proofIds: [],
  idempotencyKey: "idem-real-1",
  packetHash: "a".repeat(64),
  sidecarHash: "b".repeat(64),
  bundleHash: "c".repeat(64),
  targetRepository: { path: "/tmp/target", baseCommit: "0".repeat(40) },
  campaignStartedAt: new Date(contextNowMs).toISOString(),
  campaignDeadlineAt: new Date(contextNowMs + 24 * 60 * 60 * 1000).toISOString(),
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
const AUTH_BINDING = Object.freeze(createCccCampaignAuthorityBinding(CONTEXT, {
  actionId: "provider:real",
  actionTarget: CONTEXT.taskId,
}));

type SessionRow = Record<string, unknown> & {
  id: string;
  agentState: string;
  terminationReason: string | null;
  autonomyPosture: Record<string, unknown>;
};

type StoreLike = {
  rows: Map<string, SessionRow>;
  createSession: ReturnType<typeof vi.fn>;
  getSession: ReturnType<typeof vi.fn>;
  updateSession: ReturnType<typeof vi.fn>;
  updateCccSessionForController: ReturnType<typeof vi.fn>;
  flush: ReturnType<typeof vi.fn>;
};

type RealPolicy = {
  limits: { maxRequests: number; lifetimeMs: number; termGraceMs: number; killClosureMs: number };
  route: { adapterId: string; providerId: string; modelId: string; transport: string };
  [key: string]: unknown;
};

function createStore(): StoreLike {
  const rows = new Map<string, SessionRow>();
  let nextId = 0;
  return {
    rows,
    createSession: vi.fn((input: Record<string, unknown>) => {
      const row: SessionRow = {
        ...input,
        id: `ccc-native-real-${++nextId}`,
        nativeSessionId: null,
        resumeAttempts: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        agentState: "running",
        terminationReason: null,
        autonomyPosture: input.autonomyPosture as Record<string, unknown> ?? {},
      } as SessionRow;
      rows.set(row.id, row);
      return row;
    }),
    getSession: vi.fn((id: string) => rows.get(id)),
    updateSession: vi.fn((id: string, patch: Record<string, unknown>) => {
      const row = rows.get(id);
      if (!row) return undefined;
      Object.assign(row, patch);
      return row;
    }),
    updateCccSessionForController: vi.fn(async (id: string, expectedGeneration: string, patch: Record<string, unknown>) => {
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
    }),
    flush: vi.fn(async () => {}),
  };
}

function createRealPtyLoader() {
  return {
    spawn(command: string, args: string[], spawnOptions: { cwd: string; env: NodeJS.ProcessEnv }) {
      const child = spawnChild(command, args, {
        cwd: spawnOptions.cwd,
        env: spawnOptions.env,
        stdio: ["ignore", "ignore", "ignore"],
      });
      if (!child.pid) throw new Error("disposable native child launch failed");
      const exitListeners = new Set<(event: { exitCode: number; signal: number }) => void>();
      child.once("exit", (exitCode, signal) => {
        const event = { exitCode: exitCode ?? -1, signal: signal ? 9 : 0 };
        for (const listener of exitListeners) listener(event);
      });
      return {
        pid: child.pid,
        onData(listener: (data: string) => void) {
          if (!child.stdout) return () => {};
          const onData = (chunk: Buffer) => listener(chunk.toString("utf8"));
          child.stdout.on("data", onData);
          return () => {
            child.stdout?.off("data", onData);
          };
        },
        onExit(listener: (event: { exitCode: number; signal: number }) => void) {
          exitListeners.add(listener);
          return () => exitListeners.delete(listener);
        },
        write() {},
        resize() {},
        pause() {},
        resume() {},
        kill(signal: NodeJS.Signals) {
          child.kill(signal);
        },
      } as unknown as IPty;
    },
  };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    if (error && typeof error === "object" && (error as { code?: string }).code === "EPERM") return true;
    return false;
  }
}

function waitMs(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForFile(path: string, timeoutMs: number): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (existsSync(path)) return true;
    await waitMs(25);
  }
  return false;
}

function makeHarness(fixtureDir: string, mode: "obey" | "ignore", policy: RealPolicy) {
  const policyJson = Object.freeze(policy);
  const termMarker = join(fixtureDir, `${mode}-term-marker.txt`);
  const readyMarker = join(fixtureDir, `${mode}-ready-marker.txt`);
  const providerScript = join(fixtureDir, "provider.js");
  const providerSource = [
    "const fs = require('fs');",
    `const mode = process.argv[2];`,
    `const marker = process.argv[3];`,
    `const ready = process.argv[4];`,
    "fs.appendFileSync(ready, 'ready');",
    "if (mode === 'obey') {",
    "  process.on('SIGTERM', () => {",
    "    fs.appendFileSync(marker, 'term');",
    "    process.exit(17);",
    "  });",
    "  setInterval(() => {}, 1000);",
    "}",
    "if (mode === 'ignore') {",
    "  process.on('SIGTERM', () => {",
    "    fs.appendFileSync(marker, 'term');",
    "  });",
    "  setInterval(() => {}, 1000);",
    "}",
  ].join("\n");
  writeFileSync(providerScript, providerSource);
  const adapter: CliAgentAdapter = {
    id: "codex",
    name: "real process codex adapter",
    capabilities: { nativeDone: false, nativeWaiting: false, transcriptSource: "none", supportsResume: false },
    buildLaunch() {
      return { command: process.execPath, args: [providerScript, mode, termMarker, readyMarker] };
    },
    buildEnvAllowlist: () => [],
    createReadinessDetector: () => ({ observe: () => false }),
    formatInjection: (text: string) => ({ payload: text }),
  };

  const store = createStore();
  const registry = new CliAdapterRegistry();
  registry.register(adapter);
  const manager = new CliSessionManager({
    registry,
    store,
    concurrencyCeiling: 1,
    loadPty: async () => createRealPtyLoader(),
  });

  const spawn = () => manager.spawn({
    adapterId: adapter.id,
    projectId: "ccc",
    purpose: "execute",
    taskId: CONTEXT.taskId,
    settings: { profile: CCC_PROFILE, subscriptionReady: true, model: policy.route.modelId },
    cccNativeCliPolicy: policyJson,
  } as never);
  return { manager, store, spawn, termMarker, readyMarker };
}

function buildPolicy(policyOverrides: Partial<RealPolicy> = {}) {
  return Object.freeze({
    kind: "ccc-fusion.native-cli-session-policy",
    version: 1,
    attemptKey: "ccc-provider-attempt-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    controllerToken: "ccc-provider-controller-01234567-89ab-cdef-0123-456789abcdef",
    taskId: CONTEXT.taskId,
    authorityBindingHash: AUTH_BINDING.bindingHash,
    turnKey: "ccc-cli-turn-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    dispatchKey: CCC_NATIVE_CLI_DISPATCH_KEY,
    route: Object.freeze({
      adapterId: "codex",
      providerId: "openai",
      modelId: "gpt-4o",
      transport: "cli",
    }),
    deadlineAtMs: Date.parse(CONTEXT.campaignDeadlineAt),
    limits: Object.freeze({ maxRequests: 1, lifetimeMs: 60_000, termGraceMs: 5_000, killClosureMs: 5_000 }),
    ...policyOverrides,
  } as const);
}

function createSibling(fixtureDir: string) {
  const siblingScript = join(fixtureDir, "sibling.js");
  writeFileSync(siblingScript, "setInterval(() => {}, 1000);\n");
  const p = spawnChild(process.execPath, [siblingScript], { stdio: ["ignore", "ignore", "ignore"], cwd: fixtureDir });
  if (!p.pid) throw new Error("failed to launch sibling process");
  return p;
}

let fixtureDir: string | undefined;
let siblingProcess: ReturnType<typeof createSibling> | null = null;

beforeEach(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), "ccc-native-real-process-"));
});

afterEach(async () => {
  if (siblingProcess) {
    if (isAlive(siblingProcess.pid!)) {
      siblingProcess.kill("SIGKILL");
      await waitMs(50);
    }
    siblingProcess = null;
  }
  if (fixtureDir) {
    rmSync(fixtureDir, { recursive: true, force: true });
    fixtureDir = undefined;
  }
});

describe("CCC native CLI real-process TERM/KILL behavior", () => {
  it("Task 4 RED: TERM-obeying provider should receive TERM and exit before any escalation", async () => {
    const policy = buildPolicy();
    const { manager, readyMarker, termMarker, spawn } = makeHarness(fixtureDir!, "obey", policy);
    const startedAtMs = Date.now();
    try {
      const session = await spawn();
      expect(await waitForFile(readyMarker, 500)).toBe(true);
      const receipt = await manager.closeCccNativeCliSession(session.id, "cancel");

      expect(await waitForFile(termMarker, 200)).toBe(true);
      expect(receipt.slotHeld).toBe(true);
      expect(receipt.processGroupClosed).toBe(true);
      expect(receipt.proxyClosed).toBe(true);
      expect(receipt.durableFloorFlushed).toBe(true);
      expect(receipt.trigger).toBe("cancel");
      expect(receipt.exitSignal).toBeLessThanOrEqual(15);
      expect(Date.now() - startedAtMs).toBeLessThan(policy.limits.termGraceMs + 200);
    } finally {
      await manager.dispose();
    }
  });

  it("Task 4 RED: TERM-ignoring provider should defer termination until graceful boundary, with sibling untouched", async () => {
    siblingProcess = createSibling(fixtureDir!);
    const policy = buildPolicy({
      limits: Object.freeze({ ...buildPolicy().limits, termGraceMs: 500, killClosureMs: 250 }),
    });
    const { manager, readyMarker, termMarker, spawn } = makeHarness(fixtureDir!, "ignore", policy);
    const closeStartedAt = Date.now();
    try {
      const session = await spawn();
      expect(await waitForFile(readyMarker, 500)).toBe(true);
      const receipt = await manager.closeCccNativeCliSession(session.id, "cancel");
      const elapsedMs = Date.now() - closeStartedAt;

      expect(elapsedMs).toBeGreaterThanOrEqual(policy.limits.termGraceMs - 50);
      expect(await waitForFile(termMarker, policy.limits.termGraceMs + 200)).toBe(true);
      expect(isAlive(siblingProcess!.pid!)).toBe(true);
      expect(receipt.slotHeld).toBe(true);
      expect(receipt.processGroupClosed).toBe(true);
      expect(receipt.proxyClosed).toBe(true);
      expect(receipt.durableFloorFlushed).toBe(true);
      expect(elapsedMs).toBeLessThan(policy.limits.termGraceMs + policy.limits.killClosureMs + 1_000);
    } finally {
      await manager.dispose();
      if (siblingProcess && isAlive(siblingProcess.pid!)) {
        siblingProcess.kill("SIGKILL");
        await waitMs(50);
      }
    }
  });
});
