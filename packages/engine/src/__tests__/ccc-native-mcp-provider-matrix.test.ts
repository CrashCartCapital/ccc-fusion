import { EventEmitter } from "node:events";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { ResolvedMcpServerDefinition } from "@fusion/core";
import type { IPty } from "node-pty";
import { CliAdapterRegistry } from "../cli-agent/adapter.js";
import { claudeCodeAdapter } from "../cli-agent/adapters/claude-code.js";
import { codexAdapter } from "../cli-agent/adapters/codex.js";
import { CliResumeCoordinator } from "../cli-agent/resume-coordinator.js";
import { CliSessionManager } from "../cli-agent/session-manager.js";
import { launchCliTaskSession } from "../cli-agent/task-session.js";
import { TelemetryHub } from "../cli-agent/telemetry-hub.js";

/*
FNXC:CCCNativeMcp 2026-07-23-15:45:
Wave 2 proves Claude and Codex native MCP configuration separately. Each adapter
must carry the exact requested model and the same loopback-only streamable-HTTP
server through its native launch configuration. The test then decodes that
adapter-produced configuration, performs a real MCP initialize/list/call against
the local fixture, and verifies typed schema plus structured session/effect
result identity. This proves deterministic serialization plus protocol
compatibility, not acceptance by an actual vendor CLI. No CLI process, prompt
flattening, filesystem, shell, Git, credential, mutation, live provider, or
external-network capability is present.
*/

const TOOL_NAME = "read_session_effect";
const SERVER_NAME = "ccc-readonly-fixture";
const CCC_PROFILE = "ccc-fusion";
const INPUT_SCHEMA = {
  type: "object",
  properties: {
    sessionId: {
      type: "string",
      description: "Opaque synthetic session identity",
    },
    effectId: {
      type: "string",
      description: "Opaque synthetic effect identity",
    },
    selector: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["summary"] },
      },
      required: ["kind"],
      additionalProperties: false,
    },
  },
  required: ["sessionId", "effectId", "selector"],
  additionalProperties: false,
} as const;

interface FixtureCall {
  name: string;
  arguments: Record<string, unknown>;
}

type SpawnCapture = {
  command: string;
  args: string[];
  options: { env: Record<string, string | undefined> };
};

function makeStore() {
  const sessions = new Map<string, any>();
  let nextId = 0;
  return Object.assign(new EventEmitter(), {
    createSession: vi.fn((input: Record<string, unknown>) => {
      const record = {
        ...input,
        id: `ccc-native-session-${++nextId}`,
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
  let onExit: ((event: { exitCode: number; signal: number }) => void) | undefined;
  return {
    pid: 7331,
    onData: vi.fn(() => () => {}),
    onExit: vi.fn((listener: (event: { exitCode: number; signal: number }) => void) => {
      onExit = listener;
      return () => {
        if (onExit === listener) onExit = undefined;
      };
    }),
    write: vi.fn(),
    resize: vi.fn(),
    // CCC cancellation signals the owned bridge with SIGTERM; terminal proof
    // arrives through the same callback a real PTY emits for either signal.
    kill: vi.fn(() => queueMicrotask(() => onExit?.({ exitCode: -1, signal: 15 }))),
    pause: vi.fn(),
    resume: vi.fn(),
  } as unknown as IPty;
}

/** Decode the manager-owned CCC PTY bridge without weakening adapter assertions. */
function providerLaunchArgs(args: string[]): string[] {
  if (args[0] !== "-e" || typeof args[2] !== "string") return args;
  const decoded = JSON.parse(Buffer.from(args[2], "base64").toString("utf8")) as { args?: unknown };
  return Array.isArray(decoded.args) && decoded.args.every((arg) => typeof arg === "string")
    ? decoded.args
    : args;
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
      spawn: (
        command: string,
        args: string[],
        options: SpawnCapture["options"],
      ) => {
        captures.push({
          command,
          args,
          options: {
            env: Object.fromEntries(
              Object.keys(options.env).map((key) => [key, "[present]"]),
            ),
          },
        });
        return makePty();
      },
    })) as any,
  });
  return { manager, registry, captures };
}

async function disposeManager(manager: CliSessionManager): Promise<void> {
  await manager.dispose();
  expect(manager.activeCount()).toBe(0);
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

function assertLoopbackTarget(raw: string): URL {
  const url = new URL(raw);
  if (
    url.protocol !== "http:"
    || url.hostname !== "127.0.0.1"
    || url.port.length === 0
  ) {
    throw new Error(`Wave 2 MCP egress guard rejected non-loopback target: ${url.origin}`);
  }
  return url;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function makeProtocolServer(calls: FixtureCall[]): Server {
  const server = new Server(
    { name: "ccc-wave2-readonly-fixture", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{
      name: TOOL_NAME,
      title: "Read session effect",
      description: "Read one synthetic in-memory session/effect record",
      inputSchema: INPUT_SCHEMA,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    }],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    calls.push({ name: request.params.name, arguments: structuredClone(args) });
    return {
      content: [{ type: "text", text: "synthetic read-only result" }],
      structuredContent: {
        session: { id: args.sessionId },
        effect: { id: args.effectId },
        record: {
          selector: args.selector,
          status: "observed",
          revision: 11,
        },
      },
      isError: false,
    };
  });
  return server;
}

function claudeConfiguredUrl(args: string[], serverName = SERVER_NAME): string {
  args = providerLaunchArgs(args);
  const index = args.indexOf("--mcp-config");
  expect(index).toBeGreaterThanOrEqual(0);
  const raw = args[index + 1];
  expect(raw).toBeDefined();
  const config = JSON.parse(raw!) as {
    mcpServers?: Record<string, { type?: string; url?: string }>;
  };
  expect(config.mcpServers?.[serverName]).toMatchObject({
    type: "http",
  });
  return config.mcpServers?.[serverName]?.url ?? "";
}

function codexConfiguredUrl(args: string[], serverName = SERVER_NAME): string {
  args = providerLaunchArgs(args);
  const assignments = args
    .map((arg, index) => args[index - 1] === "-c" ? arg : undefined)
    .filter((arg): arg is string => typeof arg === "string");
  const prefix = `mcp_servers.${JSON.stringify(serverName)}.url=`;
  const assignment = assignments.find((value) => value.startsWith(prefix));
  expect(assignment).toBeDefined();
  return JSON.parse(assignment!.slice(prefix.length)) as string;
}

async function exerciseNativeMcpConfig(url: string, calls: FixtureCall[]) {
  const guardedUrl = assertLoopbackTarget(url);
  const client = new Client(
    { name: "ccc-wave2-native-mcp-test", version: "1.0.0" },
    { capabilities: {} },
  );
  await client.connect(new StreamableHTTPClientTransport(guardedUrl));
  try {
    const catalog = await client.listTools();
    expect(catalog.tools).toEqual([expect.objectContaining({
      name: TOOL_NAME,
      inputSchema: INPUT_SCHEMA,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    })]);
    expect(catalog.tools.map(({ name }) => name)).toEqual([TOOL_NAME]);

    const callArguments = {
      sessionId: "session-native-wave2",
      effectId: "effect-native-wave2",
      selector: { kind: "summary" },
    };
    const result = await client.callTool({
      name: TOOL_NAME,
      arguments: callArguments,
    });
    expect(result).toMatchObject({
      content: [{ type: "text", text: "synthetic read-only result" }],
      structuredContent: {
        session: { id: "session-native-wave2" },
        effect: { id: "effect-native-wave2" },
        record: {
          selector: { kind: "summary" },
          status: "observed",
          revision: 11,
        },
      },
      isError: false,
    });
    expect(calls.at(-1)).toEqual({
      name: TOOL_NAME,
      arguments: callArguments,
    });
    return { catalog, result };
  } finally {
    await client.close();
  }
}

describe("ccc native MCP provider matrix", () => {
  let httpServer: ReturnType<typeof createServer>;
  let mcpUrl: string;
  let calls: FixtureCall[];
  const sockets = new Set<Socket>();

  beforeAll(async () => {
    calls = [];
    httpServer = createServer(async (request, response) => {
      if (request.url !== "/mcp" || request.method !== "POST") {
        response.writeHead(405, { "content-type": "application/json" });
        response.end(JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Method not allowed" },
          id: null,
        }));
        return;
      }
      const body = await readJsonBody(request);
      const protocolServer = makeProtocolServer(calls);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await protocolServer.connect(transport);
      try {
        await transport.handleRequest(request, response, body);
      } finally {
        await protocolServer.close();
      }
    });
    httpServer.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(0, "127.0.0.1", resolve);
    });
    const address = httpServer.address() as AddressInfo;
    mcpUrl = `http://127.0.0.1:${address.port}/mcp`;
    assertLoopbackTarget(mcpUrl);
  });

  afterAll(async () => {
    httpServer.closeAllConnections?.();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => error ? reject(error) : resolve());
    });
  });

  beforeEach(() => {
    calls.length = 0;
  });

  const nativeMcpServer = (name = SERVER_NAME): ResolvedMcpServerDefinition => ({
    name,
    transport: "streamable-http",
    url: mcpUrl,
    enabled: true,
  });

  it("Claude ccc serialization is protocol-compatible with typed schema, native call, and structured result", async () => {
    const requestedModel = "claude-native-wave2-exact";
    const launch = claudeCodeAdapter.buildLaunch({
      posture: null,
      settings: {
        profile: CCC_PROFILE,
        subscriptionReady: true,
        model: requestedModel,
        mcpServers: [nativeMcpServer()],
      },
    });

    expect(launch.command).toBe("claude");
    expect(launch.args.slice(0, 2)).toEqual(["--model", requestedModel]);
    expect(launch.args).toContain("--strict-mcp-config");
    const configuredUrl = claudeConfiguredUrl(launch.args);
    await exerciseNativeMcpConfig(configuredUrl, calls);

    const flattened = launch.args.join(" ");
    expect(flattened).not.toContain("session-native-wave2");
    expect(flattened).not.toContain("effect-native-wave2");
    expect(flattened).not.toContain("structuredContent");
  });

  it("Codex ccc serialization is protocol-compatible with typed schema, native call, and structured result", async () => {
    const requestedModel = "gpt-native-wave2-exact";
    const launch = codexAdapter.buildLaunch({
      posture: null,
      settings: {
        profile: CCC_PROFILE,
        subscriptionReady: true,
        model: requestedModel,
        mcpServers: [nativeMcpServer()],
      },
    });

    expect(launch.command).toBe("codex");
    expect(launch.args.slice(0, 2)).toEqual([
      "-c",
      `model=${JSON.stringify(requestedModel)}`,
    ]);
    const configuredUrl = codexConfiguredUrl(launch.args);
    await exerciseNativeMcpConfig(configuredUrl, calls);

    const flattened = launch.args.join(" ");
    expect(flattened).not.toContain("session-native-wave2");
    expect(flattened).not.toContain("effect-native-wave2");
    expect(flattened).not.toContain("structuredContent");
  });

  const adapterCases = [
    {
      label: "Claude",
      adapterId: "claude-code",
      model: "claude-production-wave2-exact",
      configuredUrl: claudeConfiguredUrl,
      assertModel(args: string[]) {
        args = providerLaunchArgs(args);
        expect(args.slice(0, 2)).toEqual(["--model", "claude-production-wave2-exact"]);
      },
    },
    {
      label: "Codex",
      adapterId: "codex",
      model: "gpt-production-wave2-exact",
      configuredUrl: codexConfiguredUrl,
      assertModel(args: string[]) {
        args = providerLaunchArgs(args);
        expect(args).toEqual(expect.arrayContaining([
          "-c",
          'model="gpt-production-wave2-exact"',
        ]));
      },
    },
  ] as const;

  it.each(adapterCases)(
    "$label production manager spawn preserves exact ccc model and validated MCP on fresh and resume",
    async ({ adapterId, model, configuredUrl, assertModel }) => {
      const store = makeStore();
      const first = makeManager(store);
      let record: any;
      try {
        record = await first.manager.spawn({
          adapterId,
          projectId: "ccc-native-project",
          purpose: "execute",
          settings: {
            profile: CCC_PROFILE,
            subscriptionReady: true,
            model,
            mcpServers: [nativeMcpServer()],
          },
        });
        expect(first.captures).toHaveLength(1);
        assertModel(first.captures[0]!.args);
        expect(configuredUrl(first.captures[0]!.args)).toBe(mcpUrl);
        captureNativeSessionId(store, record.id, `${adapterId}-native-wave2`);
      } finally {
        await disposeManager(first.manager);
      }

      const resumed = makeManager(store);
      try {
        await resumed.manager.spawn({
          adapterId,
          projectId: "ccc-native-project",
          purpose: "execute",
          resume: {
            sessionId: record.id,
            nativeSessionId: record.nativeSessionId,
          },
          settings: {
            subscriptionReady: true,
            mcpServers: [nativeMcpServer()],
          },
        });
        expect(resumed.captures).toHaveLength(1);
        assertModel(resumed.captures[0]!.args);
        expect(configuredUrl(resumed.captures[0]!.args)).toBe(mcpUrl);
      } finally {
        await disposeManager(resumed.manager);
      }
    },
  );

  it.each(adapterCases)(
    "$label coordinator rehydrates exact sanitized ccc MCP posture on engineDeath resume",
    async ({ adapterId, model, configuredUrl, assertModel }) => {
      const store = makeStore();
      const first = makeManager(store);
      const record = await first.manager.spawn({
        adapterId,
        projectId: "ccc-native-project",
        purpose: "execute",
        taskId: `task-resume-${adapterId}`,
        worktreePath: "/tmp/ccc-native-resume-worktree",
        settings: {
          profile: CCC_PROFILE,
          subscriptionReady: true,
          model,
          mcpServers: [nativeMcpServer()],
        },
      });
      await disposeManager(first.manager);
      store.updateSession(record.id, {
        agentState: "ready",
        terminationReason: null,
      });
      captureNativeSessionId(store, record.id, `${adapterId}-native-recovery-wave2`);

      const restarted = makeManager(store);
      const logs: string[] = [];
      const coordinator = new CliResumeCoordinator({
        store: store as any,
        manager: restarted.manager,
        registry: restarted.registry,
        worktreeExists: () => true,
        isWorktreeDirty: async () => false,
        log: (message) => logs.push(message),
      });
      try {
        const results = await coordinator.recoverOnStart();

        expect(results).toEqual([{
          sessionId: record.id,
          taskId: `task-resume-${adapterId}`,
          disposition: "resumed",
          dirtyWorktree: false,
        }]);
        expect(restarted.captures).toHaveLength(1);
        assertModel(restarted.captures[0]!.args);
        expect(configuredUrl(restarted.captures[0]!.args)).toBe(mcpUrl);
        expect(store.createSession).toHaveBeenCalledTimes(1);
        expect(record.autonomyPosture).toEqual({
          cccFusionProfile: CCC_PROFILE,
          cccFusionModel: model,
          cccFusionMcpServers: [nativeMcpServer()],
          cccResumeContract: {
            adapterId,
            nativeSessionId: `${adapterId}-native-recovery-wave2`,
            requestedModel: model,
            permissionAutonomy: null,
            effectReceiptContract: "ccc-tool-receipts/v1",
          },
        });
        const serializedPosture = JSON.stringify(record.autonomyPosture);
        expect(serializedPosture).not.toContain("subscriptionReady");
        expect(serializedPosture).not.toContain("headers");
        expect(serializedPosture).not.toContain("env");
        expect(serializedPosture).not.toContain("synthetic-loopback-only");
        expect(JSON.stringify(logs)).not.toContain("synthetic-loopback-only");
      } finally {
        await disposeManager(restarted.manager);
      }
    },
  );

  it.each(adapterCases)(
    "$label coordinator keeps killed ccc sessions ineligible without spawning",
    async ({ adapterId, model }) => {
      const store = makeStore();
      const runtime = makeManager(store);
      const record = store.createSession({
        adapterId,
        projectId: "ccc-native-project",
        purpose: "execute",
        taskId: `task-killed-${adapterId}`,
        chatSessionId: null,
        worktreePath: "/tmp/ccc-native-resume-worktree",
        autonomyPosture: {
          cccFusionProfile: CCC_PROFILE,
          cccFusionModel: model,
          cccFusionMcpServers: [nativeMcpServer()],
        },
        agentState: "dead",
        terminationReason: "killed",
      });
      record.nativeSessionId = `${adapterId}-native-killed-wave2`;
      const coordinator = new CliResumeCoordinator({
        store: store as any,
        manager: runtime.manager,
        registry: runtime.registry,
        worktreeExists: () => true,
        isWorktreeDirty: async () => false,
      });
      try {
        await expect(coordinator.resumeOne(record)).resolves.toMatchObject({
          disposition: "needsAttention-ineligible",
          reason: "killed",
        });
        expect(runtime.captures).toEqual([]);
      } finally {
        await disposeManager(runtime.manager);
      }
    },
  );

  it.each(adapterCases)(
    "$label coordinator rejects unsafe or missing persisted ccc MCP material without spawn or leak",
    async ({ adapterId, model }) => {
      for (const fixture of [
        {
          label: "missing",
          posture: {
            cccFusionProfile: CCC_PROFILE,
            cccFusionModel: model,
          },
        },
        {
          label: "unsafe",
          posture: {
            cccFusionProfile: CCC_PROFILE,
            cccFusionModel: model,
            cccFusionMcpServers: [{
              name: SERVER_NAME,
              transport: "streamable-http",
              url: "https://never-forward.invalid/mcp",
              headers: { Authorization: "Bearer never-forward-this-value" },
              enabled: true,
            }],
          },
        },
      ]) {
        const store = makeStore();
        const runtime = makeManager(store);
        const logs: string[] = [];
        const record = store.createSession({
          adapterId,
          projectId: "ccc-native-project",
          purpose: "execute",
          taskId: `task-${fixture.label}-${adapterId}`,
          chatSessionId: null,
          worktreePath: "/tmp/ccc-native-resume-worktree",
          autonomyPosture: fixture.posture,
          agentState: "ready",
          terminationReason: null,
        });
        record.nativeSessionId = `${adapterId}-native-${fixture.label}-wave2`;
        const coordinator = new CliResumeCoordinator({
          store: store as any,
          manager: runtime.manager,
          registry: runtime.registry,
          worktreeExists: () => true,
          isWorktreeDirty: async () => false,
          log: (message) => logs.push(message),
        });
        try {
          const results = await coordinator.recoverOnStart();
          expect(results, fixture.label).toEqual([
            expect.objectContaining({
              disposition: "needsAttention-spawnError",
              reason: expect.stringContaining("ccc-fusion native MCP"),
            }),
          ]);
          expect(runtime.captures, fixture.label).toEqual([]);
          const observable = JSON.stringify({ results, logs, captures: runtime.captures });
          expect(observable, fixture.label).not.toContain("never-forward-this-value");
          expect(observable, fixture.label).not.toContain("never-forward.invalid");
        } finally {
          await disposeManager(runtime.manager);
        }
      }
    },
  );

  it.each(adapterCases)(
    "$label task-session forwards the production-resolved ccc MCP set before spawn",
    async ({ adapterId, model, configuredUrl }) => {
      const store = makeStore();
      const runtime = makeManager(store);
      const hub = new TelemetryHub({ store: store as any });
      let session: Awaited<ReturnType<typeof launchCliTaskSession>> | undefined;
      try {
        session = await launchCliTaskSession({
          taskId: `task-${adapterId}`,
          projectId: "ccc-native-project",
          worktreePath: tmpdir(),
          prompt: "synthetic native MCP task",
          config: {
            cliAdapterId: adapterId,
            settings: {
              profile: CCC_PROFILE,
              subscriptionReady: true,
              model,
            },
          },
          manager: runtime.manager,
          hub,
          registry: runtime.registry,
          hookEndpointUrl: "http://127.0.0.1:1/unused-hook",
          hookDirRoot: tmpdir(),
          mcpServers: [nativeMcpServer()],
        } as Parameters<typeof launchCliTaskSession>[0] & {
          mcpServers: ResolvedMcpServerDefinition[];
        });

        expect(runtime.captures).toHaveLength(1);
        expect(configuredUrl(runtime.captures[0]!.args)).toBe(mcpUrl);
      } finally {
        if (session) await session.kill();
        await disposeManager(runtime.manager);
      }
    },
  );

  const unsafeServers = () => [
    {
      label: "stdio",
      server: {
        name: SERVER_NAME,
        transport: "stdio",
        command: "synthetic-secret-command",
        env: { SYNTHETIC_SECRET: "never-forward-this-value" },
        enabled: true,
      },
    },
    {
      label: "SSE",
      server: {
        name: SERVER_NAME,
        transport: "sse",
        url: mcpUrl,
        enabled: true,
      },
    },
    {
      label: "https",
      server: {
        name: SERVER_NAME,
        transport: "streamable-http",
        url: "https://127.0.0.1:7443/mcp",
        enabled: true,
      },
    },
    {
      label: "hostname alias",
      server: {
        name: SERVER_NAME,
        transport: "streamable-http",
        url: "http://localhost:7443/mcp",
        enabled: true,
      },
    },
    {
      label: "IPv6",
      server: {
        name: SERVER_NAME,
        transport: "streamable-http",
        url: "http://[::1]:7443/mcp",
        enabled: true,
      },
    },
    {
      label: "missing port",
      server: {
        name: SERVER_NAME,
        transport: "streamable-http",
        url: "http://127.0.0.1/mcp",
        enabled: true,
      },
    },
    {
      label: "zero port",
      server: {
        name: SERVER_NAME,
        transport: "streamable-http",
        url: "http://127.0.0.1:0/mcp",
        enabled: true,
      },
    },
    {
      label: "missing path",
      server: {
        name: SERVER_NAME,
        transport: "streamable-http",
        url: "http://127.0.0.1:7443/",
        enabled: true,
      },
    },
    {
      label: "userinfo",
      server: {
        name: SERVER_NAME,
        transport: "streamable-http",
        url: "http://synthetic-user:synthetic-password@127.0.0.1:7443/mcp",
        enabled: true,
      },
    },
    {
      label: "non-boolean enabled",
      server: {
        ...nativeMcpServer(),
        enabled: "yes",
      },
    },
    {
      label: "env material",
      server: {
        ...nativeMcpServer(),
        env: { SYNTHETIC_SECRET: "never-forward-this-value" },
      },
    },
    {
      label: "headers",
      server: {
        ...nativeMcpServer(),
        headers: { Authorization: "Bearer never-forward-this-value" },
      },
    },
  ] as Array<{ label: string; server: ResolvedMcpServerDefinition }>;

  it.each(adapterCases)(
    "$label rejects every unsafe ccc native MCP shape before session row, PTY, argv, env, or log",
    async ({ adapterId, model }) => {
      for (const { label, server } of unsafeServers()) {
        const store = makeStore();
        const runtime = makeManager(store);
        const logs: string[] = [];
        let failure: unknown;
        try {
          await runtime.manager.spawn({
            adapterId,
            projectId: "ccc-native-project",
            purpose: "execute",
            settings: {
              profile: CCC_PROFILE,
              subscriptionReady: true,
              model,
              mcpServers: [server],
            },
          });
        } catch (error) {
          failure = error;
          logs.push(error instanceof Error ? error.message : String(error));
        } finally {
          await disposeManager(runtime.manager);
        }

        expect(failure, label).toMatchObject({
          code: "CCC_NATIVE_MCP_POLICY_VIOLATION",
        });
        expect(store.createSession, label).not.toHaveBeenCalled();
        expect(runtime.captures, label).toEqual([]);
        expect(JSON.stringify(logs), label).not.toContain("never-forward-this-value");
        expect(JSON.stringify(logs), label).not.toContain("synthetic-password");
      }
    },
  );

  it.each(adapterCases)(
    "$label validates ccc MCP before autonomy evaluation",
    async ({ adapterId, model }) => {
      const store = makeStore();
      const runtime = makeManager(store);
      const hub = new TelemetryHub({ store: store as any });
      const isAutonomyApproved = vi.fn(async () => false);
      const invalid = {
        ...nativeMcpServer(),
        headers: { Authorization: "Bearer never-forward-this-value" },
      } as ResolvedMcpServerDefinition;

      try {
        await expect(launchCliTaskSession({
          taskId: `task-invalid-${adapterId}`,
          projectId: "ccc-native-project",
          worktreePath: tmpdir(),
          prompt: "must never spawn",
          config: {
            cliAdapterId: adapterId,
            cliAgentSettings: {
              extraArgs: adapterId === "claude-code"
                ? ["--dangerously-skip-permissions"]
                : ["--dangerously-bypass-approvals-and-sandbox"],
            },
            settings: {
              profile: CCC_PROFILE,
              subscriptionReady: true,
              model,
              mcpServers: [invalid],
            },
          },
          manager: runtime.manager,
          hub,
          registry: runtime.registry,
          hookEndpointUrl: "http://127.0.0.1:1/unused-hook",
          hookDirRoot: tmpdir(),
          isAutonomyApproved,
        })).rejects.toMatchObject({
          code: "CCC_NATIVE_MCP_POLICY_VIOLATION",
        });
        expect(isAutonomyApproved).not.toHaveBeenCalled();
        expect(store.createSession).not.toHaveBeenCalled();
        expect(runtime.captures).toEqual([]);
      } finally {
        await disposeManager(runtime.manager);
      }
    },
  );

  it.each(adapterCases)(
    "$label keeps disabled-only and non-ccc MCP definitions inert",
    async ({ adapterId, model }) => {
      const disabledSecretServer = {
        name: "disabled-secret-fixture",
        transport: "stdio",
        command: "synthetic-secret-command",
        env: { SYNTHETIC_SECRET: "never-forward-this-value" },
        enabled: false,
      } as ResolvedMcpServerDefinition;
      const store = makeStore();
      const runtime = makeManager(store);
      try {
        await runtime.manager.spawn({
          adapterId,
          projectId: "ccc-native-project",
          purpose: "execute",
          settings: {
            profile: CCC_PROFILE,
            subscriptionReady: true,
            model,
            mcpServers: [disabledSecretServer],
          },
        });
        await runtime.manager.spawn({
          adapterId,
          projectId: "ccc-native-project",
          purpose: "execute",
          settings: {
            profile: CCC_PROFILE,
            subscriptionReady: true,
            model,
            mcpServers: [],
          },
        });
        await runtime.manager.spawn({
          adapterId,
          projectId: "ordinary-project",
          purpose: "execute",
          settings: {
            model,
            mcpServers: [{
              ...nativeMcpServer(),
              headers: { Authorization: "Bearer never-forward-this-value" },
            }],
          },
        });

        expect(runtime.captures).toHaveLength(3);
        for (const capture of runtime.captures) {
          const serialized = JSON.stringify({
            command: capture.command,
            args: providerLaunchArgs(capture.args),
            env: capture.options.env,
          });
          expect(serialized).not.toContain("--mcp-config");
          expect(serialized).not.toContain("mcp_servers.");
          expect(serialized).not.toContain("never-forward-this-value");
          expect(serialized).not.toContain("synthetic-secret-command");
        }
      } finally {
        await disposeManager(runtime.manager);
      }
    },
  );

  it.each(adapterCases)(
    "$label safely quotes a hostile ccc server name without changing its identity",
    async ({ adapterId, model, configuredUrl }) => {
      const hostileName = 'ccc."quoted name".[wave2]';
      const store = makeStore();
      const runtime = makeManager(store);
      try {
        await runtime.manager.spawn({
          adapterId,
          projectId: "ccc-native-project",
          purpose: "execute",
          settings: {
            profile: CCC_PROFILE,
            subscriptionReady: true,
            model,
            mcpServers: [nativeMcpServer(hostileName)],
          },
        });
        expect(configuredUrl(runtime.captures[0]!.args, hostileName)).toBe(mcpUrl);
      } finally {
        await disposeManager(runtime.manager);
      }
    },
  );

  it("fails closed for non-loopback MCP targets and exposes no extra tool capability", () => {
    expect(() => assertLoopbackTarget("https://example.invalid/mcp")).toThrow(
      "Wave 2 MCP egress guard rejected non-loopback target",
    );
    expect(calls).toEqual([]);
  });
});
