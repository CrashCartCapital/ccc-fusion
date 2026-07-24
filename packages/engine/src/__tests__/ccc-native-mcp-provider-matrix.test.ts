import { EventEmitter } from "node:events";
import { spawn as spawnChild } from "node:child_process";
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
import { CliSessionStore, drizzleSql as sql, reserveCccEffectReceipt, type ResolvedMcpServerDefinition } from "@fusion/core";
import type { IPty } from "node-pty";
import { CliAdapterRegistry, type CliAgentAdapter } from "../cli-agent/adapter.js";
import { claudeCodeAdapter } from "../cli-agent/adapters/claude-code.js";
import { codexAdapter } from "../cli-agent/adapters/codex.js";
import { CliResumeCoordinator } from "../cli-agent/resume-coordinator.js";
import { CliSessionManager } from "../cli-agent/session-manager.js";
import { launchCliTaskSession } from "../cli-agent/task-session.js";
import { TelemetryHub } from "../cli-agent/telemetry-hub.js";
import { createTaskStoreForTest, pgDescribe } from "../../../core/src/__test-utils__/pg-test-harness.js";

const syntheticProxyDisposal = vi.hoisted(() => ({
  enabled: false,
  realProxy: undefined as { dispose(): Promise<void> } | undefined,
}));

vi.mock("../cli-agent/ccc-native-mcp-proxy.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../cli-agent/ccc-native-mcp-proxy.js")>();
  return {
    ...actual,
    startCccNativeMcpProxy: async (...args: Parameters<typeof actual.startCccNativeMcpProxy>) => {
      const realProxy = await actual.startCccNativeMcpProxy(...args);
      if (!syntheticProxyDisposal.enabled) return realProxy;
      syntheticProxyDisposal.realProxy = realProxy;
      return {
        ...realProxy,
        async dispose() {
          throw new Error("synthetic proxy disposal rejection");
        },
      };
    },
  };
});

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

function realChildProcessPtyModule(moduleOptions: { onWrite?: (payload: string) => void } = {}) {
  return {
    spawn(command: string, args: string[], spawnOptions: { cwd: string; env: NodeJS.ProcessEnv }) {
      const child = spawnChild(command, args, {
        cwd: spawnOptions.cwd,
        env: spawnOptions.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (!child.pid) throw new Error("failed to start disposable native MCP provider");
      const dataListeners = new Set<(data: string) => void>();
      const exitListeners = new Set<(event: { exitCode: number; signal: number }) => void>();
      const emitData = (chunk: Buffer) => {
        for (const listener of dataListeners) listener(chunk.toString("utf8"));
      };
      child.stdout?.on("data", emitData);
      child.stderr?.on("data", emitData);
      child.once("exit", (exitCode, signal) => {
        for (const listener of exitListeners) listener({ exitCode: exitCode ?? -1, signal: signal ? 9 : 0 });
      });
      return {
        pid: child.pid,
        onData(listener: (data: string) => void) {
          dataListeners.add(listener);
          return () => dataListeners.delete(listener);
        },
        onExit(listener: (event: { exitCode: number; signal: number }) => void) {
          exitListeners.add(listener);
          return () => exitListeners.delete(listener);
        },
        write(payload: string) {
          moduleOptions.onWrite?.(payload);
        },
        resize() {},
        pause() {},
        resume() {},
        kill(signal: NodeJS.Signals) {
          process.kill(child.pid!, signal);
        },
      };
    },
  };
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

const DURABLE_EFFECT_TOOL_NAME = "commit_durable_native_effect";
const DURABLE_EFFECT_SERVER_NAME = "ccc-durable-native-fixture";
const DURABLE_EFFECT_AUTHORITY = `${DURABLE_EFFECT_SERVER_NAME}:${DURABLE_EFFECT_TOOL_NAME}`;
const DURABLE_EFFECT_RESULT = { effect: { slot: "native-restart-slot", revision: 1 }, status: "committed" } as const;
const NATIVE_DISPOSAL_READY = "ccc-native-disposal-ready";

async function startDurableEffectFixture(options: {
  holdResponse?: { requestStarted(): void; requestClosed(): void; setRelease(release: () => void): void };
} = {}): Promise<{ readonly url: string; readonly upstreamExecutions: () => number; close(): Promise<void> }> {
  let upstreamExecutions = 0;
  const sockets = new Set<Socket>();
  const server = createServer(async (request, response) => {
    if (options.holdResponse) {
      const requestClosed = () => {
        if (!response.writableEnded) options.holdResponse?.requestClosed();
      };
      request.once("aborted", requestClosed);
      response.once("close", requestClosed);
      options.holdResponse.setRelease(() => {
        if (response.writableEnded) return;
        const body = JSON.stringify({ jsonrpc: "2.0", id: "held-native-dispose-rejection", result: { structuredContent: DURABLE_EFFECT_RESULT } });
        response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
        response.write(body);
        response.socket?.end();
      });
      await readJsonBody(request);
      options.holdResponse.requestStarted();
      return;
    }
    if (request.url !== "/mcp" || request.method !== "POST") {
      response.writeHead(405, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null }));
      return;
    }
    const protocolServer = new Server({ name: "ccc-wave3-durable-native-fixture", version: "1.0.0" }, { capabilities: { tools: {} } });
    protocolServer.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{
      name: DURABLE_EFFECT_TOOL_NAME, title: "Commit durable native effect", description: "Effectful loopback fixture for native durable receipt recovery",
      inputSchema: { type: "object", properties: { slot: { type: "string", const: "native-restart-slot" } }, required: ["slot"], additionalProperties: false },
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false },
    }] }));
    protocolServer.setRequestHandler(CallToolRequestSchema, async (call) => {
      expect(call.params.name).toBe(DURABLE_EFFECT_TOOL_NAME);
      expect(call.params.arguments).toEqual({ slot: "native-restart-slot" });
      upstreamExecutions += 1;
      return { content: [{ type: "text", text: "durable native effect committed" }], structuredContent: DURABLE_EFFECT_RESULT, isError: false };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await protocolServer.connect(transport);
    try { await transport.handleRequest(request, response, await readJsonBody(request)); } finally { await protocolServer.close(); }
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  assertLoopbackTarget(url);
  return { url, upstreamExecutions: () => upstreamExecutions, async close() {
    server.closeAllConnections?.(); for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  } };
}

async function callDurableEffect(url: string): Promise<unknown> {
  const client = new Client({ name: "ccc-wave3-durable-native-mcp-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(assertLoopbackTarget(url)));
  try {
    const catalog = await client.listTools();
    expect(catalog.tools).toEqual([expect.objectContaining({ name: DURABLE_EFFECT_TOOL_NAME, annotations: expect.not.objectContaining({ readOnlyHint: true }) })]);
    const result = await client.callTool({ name: DURABLE_EFFECT_TOOL_NAME, arguments: { slot: "native-restart-slot" } });
    expect(result).toMatchObject({ content: [{ type: "text", text: "durable native effect committed" }], structuredContent: DURABLE_EFFECT_RESULT, isError: false });
    return result.structuredContent;
  } finally { await client.close(); }
}

async function postNativeJsonRpc(url: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const response = await fetch(assertLoopbackTarget(url), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify(body),
    signal,
  });
  expect(response.status).toBe(200);
  return await response.json() as Record<string, unknown>;
}

function deferred<T = void>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function within<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function readNativeDurableRows(layer: any, projectId: string, sessionId: string): Promise<{
  turns: Array<{ turn_key: string; state: "open" | "closed"; controller_token: string }>;
  receipts: Array<{ logical_key: string; turn_key: string; slot_ordinal: number; tool_authority: string; state: string }>;
}> {
  const turns = await layer.db.execute(sql`
    SELECT turn_key, state, controller_token
    FROM project.ccc_effect_turns
    WHERE owner_project_id = ${projectId} AND effect_scope_id = ${sessionId}
    ORDER BY created_at, turn_key
  `) as Array<{ turn_key: string; state: "open" | "closed"; controller_token: string }>;
  const receipts = await layer.db.execute(sql`
    SELECT logical_key, turn_key, slot_ordinal, tool_authority, state
    FROM project.ccc_effect_receipts
    WHERE owner_project_id = ${projectId} AND effect_scope_id = ${sessionId}
    ORDER BY turn_key, slot_ordinal
  `) as Array<{ logical_key: string; turn_key: string; slot_ordinal: number; tool_authority: string; state: string }>;
  return { turns, receipts };
}

async function startSharedToolFixture(options: {
  name: string;
  readOnly: boolean;
  structuredResult: Record<string, unknown>;
}): Promise<{ readonly url: string; readonly upstreamExecutions: () => number; close(): Promise<void> }> {
  let upstreamExecutions = 0;
  const sockets = new Set<Socket>();
  const server = createServer(async (request, response) => {
    const protocolServer = new Server({ name: options.name, version: "1.0.0" }, { capabilities: { tools: {} } });
    protocolServer.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{
      name: "shared", title: "Shared fixture tool", description: "Read-only/effectful route isolation fixture",
      inputSchema: { type: "object", properties: { slot: { type: "string" } }, required: ["slot"], additionalProperties: false },
      annotations: { readOnlyHint: options.readOnly, destructiveHint: false, idempotentHint: options.readOnly, openWorldHint: false },
    }] }));
    protocolServer.setRequestHandler(CallToolRequestSchema, async () => {
      upstreamExecutions += 1;
      return { content: [{ type: "text", text: `${options.name}:shared` }], structuredContent: options.structuredResult, isError: false };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await protocolServer.connect(transport);
    try { await transport.handleRequest(request, response, await readJsonBody(request)); } finally { await protocolServer.close(); }
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  assertLoopbackTarget(url);
  return { url, upstreamExecutions: () => upstreamExecutions, async close() {
    server.closeAllConnections?.(); for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  } };
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
        // The process-facing native configuration must point at Fusion's
        // session-owned interception proxy, never directly at the admitted
        // upstream loopback MCP server.
        expect(configuredUrl(first.captures[0]!.args)).not.toBe(mcpUrl);
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
        expect(configuredUrl(resumed.captures[0]!.args)).not.toBe(mcpUrl);
      } finally {
        await disposeManager(resumed.manager);
      }
    },
  );

  it.each(adapterCases)(
    "$label production manager routes protocol traffic through its session-owned proxy",
    async ({ adapterId, model, configuredUrl }) => {
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
            mcpServers: [nativeMcpServer()],
          },
        });
        const proxyUrl = configuredUrl(runtime.captures[0]!.args);
        expect(proxyUrl).not.toBe(mcpUrl);
        await exerciseNativeMcpConfig(proxyUrl, calls);
        expect(calls).toHaveLength(1);
      } finally {
        await disposeManager(runtime.manager);
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
        expect(configuredUrl(restarted.captures[0]!.args)).not.toBe(mcpUrl);
        expect(store.createSession).toHaveBeenCalledTimes(1);
        expect(record.autonomyPosture).toEqual(expect.objectContaining({
          cccFusionProfile: CCC_PROFILE,
          cccFusionModel: model,
          cccFusionMcpServers: [nativeMcpServer()],
          cccResumeContract: {
            adapterId,
            nativeSessionId: `${adapterId}-native-recovery-wave2`,
            requestedModel: model,
            permissionAutonomy: null,
            effectReceiptContract: "ccc-tool-receipts/v2",
          },
        }));
        expect(record.autonomyPosture.cccControllerGeneration).toEqual(expect.any(String));
        expect(record.autonomyPosture.cccControllerFenced).toBe(false);
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
        expect(configuredUrl(runtime.captures[0]!.args)).not.toBe(mcpUrl);
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
        expect(configuredUrl(runtime.captures[0]!.args, hostileName)).not.toBe(mcpUrl);
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

pgDescribe("ccc native MCP durable receipt proxy", () => {
  it("replays an unambiguous legacy raw-tool receipt through the current native JSON-RPC request id", async () => {
    const fixture = await startDurableEffectFixture();
    const harness = await createTaskStoreForTest({ prefix: "fusion_wave3_native_legacy_authority" });
    const projectId = "ccc-native-legacy-authority";
    const store = await CliSessionStore.create(harness.layer, projectId);
    const first = makeManager(store as never);
    let resumed: ReturnType<typeof makeManager> | undefined;
    try {
      const record = await first.manager.spawn({
        adapterId: "claude-code", projectId, purpose: "execute", taskId: "task-native-legacy-authority", worktreePath: tmpdir(),
        settings: {
          profile: CCC_PROFILE,
          subscriptionReady: true,
          model: "claude-native-legacy-authority",
          mcpServers: [{ name: DURABLE_EFFECT_SERVER_NAME, transport: "streamable-http", url: fixture.url, enabled: true }],
        },
      });
      const [turn] = (await readNativeDurableRows(harness.layer, projectId, record.id)).turns;
      const controllerToken = (store.getSession(record.id)?.autonomyPosture as Record<string, unknown> | null | undefined)?.cccControllerGeneration;
      expect(turn).toMatchObject({ state: "open" });
      expect(typeof controllerToken).toBe("string");
      if (!turn || typeof controllerToken !== "string") throw new Error("legacy fixture did not expose its durable turn/controller");
      const legacy = await reserveCccEffectReceipt(store as never, {
        sessionId: record.id,
        toolName: DURABLE_EFFECT_TOOL_NAME,
        arguments: { slot: "native-restart-slot" },
        controllerToken,
        turnKey: turn.turn_key,
        slotOrdinal: 0,
      });
      await store.markCccEffectReceiptDispatched(legacy);
      await store.commitCccEffectReceipt(legacy, {
        jsonrpc: "2.0",
        id: "legacy-original-request",
        result: { structuredContent: DURABLE_EFFECT_RESULT },
      });
      captureNativeSessionId(store as never, record.id, "native-legacy-authority");
      await store.flush();
      await disposeManager(first.manager);

      const restartedStore = await CliSessionStore.create(harness.layer, projectId);
      resumed = makeManager(restartedStore as never);
      await resumed.manager.spawn({
        adapterId: "claude-code", projectId, purpose: "execute", taskId: "task-native-legacy-authority", worktreePath: tmpdir(),
        settings: { subscriptionReady: true },
        resume: { sessionId: record.id, nativeSessionId: "native-legacy-authority" },
      });
      const replay = await postNativeJsonRpc(claudeConfiguredUrl(resumed.captures[0]!.args, DURABLE_EFFECT_SERVER_NAME), {
        jsonrpc: "2.0",
        id: "legacy-current-request",
        method: "tools/call",
        params: { name: DURABLE_EFFECT_TOOL_NAME, arguments: { slot: "native-restart-slot" } },
      });
      expect(replay).toEqual({ jsonrpc: "2.0", id: "legacy-current-request", result: { structuredContent: DURABLE_EFFECT_RESULT } });
      expect(fixture.upstreamExecutions()).toBe(0);
      expect((await readNativeDurableRows(harness.layer, projectId, record.id)).receipts).toEqual([
        expect.objectContaining({ logical_key: `${turn.turn_key}:0`, tool_authority: DURABLE_EFFECT_TOOL_NAME, state: "committed" }),
      ]);
    } finally {
      if (resumed) await disposeManager(resumed.manager);
      await disposeManager(first.manager);
      await harness.teardown();
      await fixture.close();
    }
  });

  it("replays a committed native effect through the current JSON-RPC request id after manager restart", async () => {
    const fixture = await startDurableEffectFixture();
    const harness = await createTaskStoreForTest({ prefix: "fusion_wave3_native_rpc_id" });
    const projectId = "ccc-native-rpc-id";
    const store = await CliSessionStore.create(harness.layer, projectId);
    const first = makeManager(store as never);
    try {
      const record = await first.manager.spawn({
        adapterId: "claude-code", projectId, purpose: "execute", taskId: "task-native-rpc-id", worktreePath: tmpdir(),
        settings: { profile: CCC_PROFILE, subscriptionReady: true, model: "claude-native-rpc-id", mcpServers: [{ name: DURABLE_EFFECT_SERVER_NAME, transport: "streamable-http", url: fixture.url, enabled: true }] },
      });
      const firstProxyUrl = claudeConfiguredUrl(first.captures[0]!.args, DURABLE_EFFECT_SERVER_NAME);
      await postNativeJsonRpc(firstProxyUrl, { jsonrpc: "2.0", id: "catalog-first", method: "tools/list", params: {} });
      const firstResponse = await postNativeJsonRpc(firstProxyUrl, { jsonrpc: "2.0", id: "request-first", method: "tools/call", params: { name: DURABLE_EFFECT_TOOL_NAME, arguments: { slot: "native-restart-slot" } } });
      expect(firstResponse).toMatchObject({ jsonrpc: "2.0", id: "request-first", result: { structuredContent: DURABLE_EFFECT_RESULT } });
      captureNativeSessionId(store as never, record.id, "native-rpc-id");
      await store.flush();
      await disposeManager(first.manager);

      const restartedStore = await CliSessionStore.create(harness.layer, projectId);
      const resumed = makeManager(restartedStore as never);
      try {
        await resumed.manager.spawn({
          adapterId: "claude-code", projectId, purpose: "execute", taskId: "task-native-rpc-id", worktreePath: tmpdir(), settings: { subscriptionReady: true },
          resume: { sessionId: record.id, nativeSessionId: "native-rpc-id" },
        });
        const replayResponse = await postNativeJsonRpc(claudeConfiguredUrl(resumed.captures[0]!.args, DURABLE_EFFECT_SERVER_NAME), {
          jsonrpc: "2.0", id: "request-current", method: "tools/call", params: { name: DURABLE_EFFECT_TOOL_NAME, arguments: { slot: "native-restart-slot" } },
        });
        expect(replayResponse).toEqual({ ...firstResponse, id: "request-current" });
        expect(fixture.upstreamExecutions()).toBe(1);
      } finally { await disposeManager(resumed.manager); }
    } finally { await harness.teardown(); await fixture.close(); }
  });

  it("keeps same-named native MCP tools classified by their canonical server route", async () => {
    const readonlyFixture = await startSharedToolFixture({ name: "ccc-native-readonly-shared", readOnly: true, structuredResult: { route: "readonly" } });
    const effectfulFixture = await startSharedToolFixture({ name: "ccc-native-effectful-shared", readOnly: false, structuredResult: { route: "effectful", status: "committed" } });
    const harness = await createTaskStoreForTest({ prefix: "fusion_wave3_native_route_scope" });
    const projectId = "ccc-native-route-scope";
    const store = await CliSessionStore.create(harness.layer, projectId);
    const first = makeManager(store as never);
    const readonlyName = "readonly-shared";
    const effectfulName = "effectful-shared";
    try {
      const record = await first.manager.spawn({
        adapterId: "codex", projectId, purpose: "execute", taskId: "task-native-route-scope", worktreePath: tmpdir(),
        settings: { profile: CCC_PROFILE, subscriptionReady: true, model: "codex-native-route-scope", mcpServers: [
          { name: readonlyName, transport: "streamable-http", url: readonlyFixture.url, enabled: true },
          { name: effectfulName, transport: "streamable-http", url: effectfulFixture.url, enabled: true },
        ] },
      });
      const readonlyUrl = codexConfiguredUrl(first.captures[0]!.args, readonlyName);
      const effectfulUrl = codexConfiguredUrl(first.captures[0]!.args, effectfulName);
      await postNativeJsonRpc(effectfulUrl, { jsonrpc: "2.0", id: "effectful-list", method: "tools/list", params: {} });
      await postNativeJsonRpc(readonlyUrl, { jsonrpc: "2.0", id: "readonly-list", method: "tools/list", params: {} });
      const firstResponse = await postNativeJsonRpc(effectfulUrl, { jsonrpc: "2.0", id: "effectful-first", method: "tools/call", params: { name: "shared", arguments: { slot: "route-scope" } } });
      expect(firstResponse).toMatchObject({ id: "effectful-first", result: { structuredContent: { route: "effectful", status: "committed" } } });
      expect(effectfulFixture.upstreamExecutions()).toBe(1);
      captureNativeSessionId(store as never, record.id, "native-route-scope");
      await store.flush();
      await disposeManager(first.manager);

      const restartedStore = await CliSessionStore.create(harness.layer, projectId);
      const resumed = makeManager(restartedStore as never);
      try {
        await resumed.manager.spawn({
          adapterId: "codex", projectId, purpose: "execute", taskId: "task-native-route-scope", worktreePath: tmpdir(), settings: { subscriptionReady: true },
          resume: { sessionId: record.id, nativeSessionId: "native-route-scope" },
        });
        const replay = await postNativeJsonRpc(codexConfiguredUrl(resumed.captures[0]!.args, effectfulName), { jsonrpc: "2.0", id: "effectful-replay", method: "tools/call", params: { name: "shared", arguments: { slot: "route-scope" } } });
        expect(replay).toEqual({ ...firstResponse, id: "effectful-replay" });
        expect(effectfulFixture.upstreamExecutions()).toBe(1);
      } finally { await disposeManager(resumed.manager); }
    } finally { await harness.teardown(); await readonlyFixture.close(); await effectfulFixture.close(); }
  });

  it("fails closed without terminal fence, flush, release, or acknowledgement while a session-owned native MCP request remains open after proxy disposal rejects", async () => {
    const phases: string[] = [];
    const counters = { ready: 0, upstreamStarted: 0, upstreamClosed: 0, cancellationRejected: 0 };
    let phase = "fixture";
    const mark = (next: string) => {
      phase = next;
      phases.push(next);
    };
    const bounded = <T>(promise: Promise<T>, label: string, timeoutMs = 2_000) =>
      within(promise, timeoutMs, `P1-3 ${phase}: ${label}; phases=${phases.join(",")}`);
    const requestStarted = deferred<void>();
    const requestClosed = deferred<void>();
    let requestIsClosed = false;
    let releaseHeldResponse: (() => void) | undefined;
    const fixture = await bounded(startDurableEffectFixture({
      holdResponse: {
        requestStarted: () => {
          counters.upstreamStarted += 1;
          requestStarted.resolve();
        },
        requestClosed: () => {
          requestIsClosed = true;
          counters.upstreamClosed += 1;
          requestClosed.resolve();
        },
        setRelease: (release) => {
          releaseHeldResponse = release;
        },
      },
    }), "loopback fixture");
    mark("postgres-harness");
    const harness = await bounded(createTaskStoreForTest({ prefix: "fusion_wave3_native_dispose_rejection" }), "PostgreSQL harness", 5_000);
    const projectId = "ccc-native-dispose-rejection";
    mark("store");
    const store = await bounded(CliSessionStore.create(harness.layer, projectId), "session store");
    const originalFlush = store.flush.bind(store);
    let record: Awaited<ReturnType<CliSessionManager["spawn"]>> | undefined;
    let terminalFlushBeforeRequestClosed = false;
    store.flush = async () => {
      const current = record ? store.getSession(record.id) : undefined;
      const posture = current?.autonomyPosture as Record<string, unknown> | null | undefined;
      if ((current?.agentState === "dead" || posture?.cccControllerFenced === true) && !requestIsClosed) {
        terminalFlushBeforeRequestClosed = true;
      }
      await originalFlush();
    };
    let proxyUrl = "";
    const adapter: CliAgentAdapter = {
      id: "native-mcp-disposal-red",
      name: "Native MCP disposal RED adapter",
      capabilities: { nativeDone: false, nativeWaiting: false, transcriptSource: "none", supportsResume: false },
      defaultCommand: process.execPath,
      buildLaunch: ({ settings }) => {
        const configured = settings.mcpServers as Array<{ url?: string }> | undefined;
        proxyUrl = configured?.[0]?.url ?? "";
        return { command: process.execPath, args: ["-e", `process.stdout.write(${JSON.stringify(`${NATIVE_DISPOSAL_READY}\n`)}); setInterval(() => {}, 1000)`] };
      },
      buildEnvAllowlist: () => [],
      createReadinessDetector: () => ({
        observe: (data) => {
          if (!data.includes(NATIVE_DISPOSAL_READY)) return false;
          counters.ready += 1;
          return true;
        },
      }),
      formatInjection: (text) => ({ payload: text }),
    };
    const registry = new CliAdapterRegistry();
    registry.register(adapter);
    const manager = new CliSessionManager({ registry, store, loadPty: async () => realChildProcessPtyModule() as never });
    let request: Promise<"completed" | "aborted"> | undefined;
    try {
      syntheticProxyDisposal.enabled = true;
      mark("spawn");
      record = await bounded(manager.spawn({
        adapterId: adapter.id,
        projectId,
        purpose: "execute",
        taskId: "task-native-dispose-rejection",
        worktreePath: tmpdir(),
        settings: {
          profile: CCC_PROFILE,
          subscriptionReady: true,
          mcpServers: [{ name: DURABLE_EFFECT_SERVER_NAME, transport: "streamable-http", url: fixture.url, enabled: true }],
        },
      }), "manager spawn");
      mark("ready");
      await bounded(manager.waitForReady(record.id), "provider readiness");
      expect(counters.ready).toBe(1);
      mark("upstream-request");
      request = postNativeJsonRpc(proxyUrl, {
        jsonrpc: "2.0",
        id: "held-native-dispose-rejection",
        method: "tools/call",
        params: { name: DURABLE_EFFECT_TOOL_NAME, arguments: { slot: "native-restart-slot" } },
      }).then(
        () => "completed" as const,
        () => "aborted" as const,
      );
      await bounded(requestStarted.promise, "native MCP upstream request start");
      expect(counters.upstreamStarted).toBe(1);
      expect(releaseHeldResponse).toBeTypeOf("function");

      let cancellationAcknowledged = false;
      mark("cancellation");
      const cancellation = manager.kill(record.id, "killed").then(() => {
        cancellationAcknowledged = true;
      });
      await expect(bounded(cancellation, "native MCP cancellation")).rejects.toThrow("synthetic proxy disposal rejection");
      counters.cancellationRejected += 1;
      expect(counters.cancellationRejected).toBe(1);

      expect(requestIsClosed).toBe(false);
      expect(cancellationAcknowledged).toBe(false);
      expect(manager.isLive(record.id)).toBe(true);
      expect(manager.activeCount()).toBe(1);
      expect(manager.availableSlots()).toBe(manager.capacity() - 1);
      expect(terminalFlushBeforeRequestClosed).toBe(false);

      const freshStore = await CliSessionStore.create(harness.layer, projectId);
      expect(freshStore.getSession(record.id)).toMatchObject({
        agentState: "needsAttention",
        terminationReason: null,
        autonomyPosture: expect.objectContaining({ cccControllerFenced: false }),
      });
    } finally {
      syntheticProxyDisposal.enabled = false;
      try {
        if (request) {
          mark("release-held-request");
          releaseHeldResponse?.();
          await bounded(requestClosed.promise, "held native MCP request closure");
          expect(counters.upstreamClosed).toBeGreaterThan(0);
          await bounded(request, "downstream request settlement");
        }
        mark("real-proxy-dispose");
        await bounded(syntheticProxyDisposal.realProxy?.dispose() ?? Promise.resolve(), "real proxy disposal");
      } finally {
        mark("fixture-close");
        await bounded(fixture.close(), "fixture closure");
        mark("postgres-teardown");
        await bounded(harness.teardown(), "PostgreSQL teardown", 5_000);
        store.flush = originalFlush;
        syntheticProxyDisposal.realProxy = undefined;
        mark("manager-dispose");
        await bounded(manager.dispose().catch(() => undefined), "manager disposal");
      }
    }
  });

  it("replays one interrupted launch-turn effect, then the public follow-up opens exactly one new durable turn", async () => {
    const bounded = <T>(promise: Promise<T>, label: string, timeoutMs = 2_000) => within(promise, timeoutMs, `P1-5 ${label}`);

    const interruptedFixture = await bounded(startDurableEffectFixture(), "restart fixture");
    const interruptedHarness = await bounded(createTaskStoreForTest({ prefix: "fusion_wave3_follow_up_restart" }), "restart PostgreSQL harness", 5_000);
    const interruptedProjectId = "ccc-native-follow-up-restart";
    const interruptedStore = await bounded(CliSessionStore.create(interruptedHarness.layer, interruptedProjectId), "restart store");
    const interruptedFirst = makeManager(interruptedStore as never);
    let interruptedResumed: ReturnType<typeof makeManager> | undefined;
    try {
      const interruptedRecord = await bounded(interruptedFirst.manager.spawn({
        adapterId: "claude-code",
        projectId: interruptedProjectId,
        purpose: "execute",
        taskId: "task-native-follow-up-restart",
        worktreePath: tmpdir(),
        settings: {
          profile: CCC_PROFILE,
          subscriptionReady: true,
          model: "claude-native-follow-up-restart",
          mcpServers: [{ name: DURABLE_EFFECT_SERVER_NAME, transport: "streamable-http", url: interruptedFixture.url, enabled: true }],
        },
      }), "restart first manager spawn");
      const firstEndpoint = claudeConfiguredUrl(interruptedFirst.captures[0]!.args, DURABLE_EFFECT_SERVER_NAME);
      await bounded(postNativeJsonRpc(firstEndpoint, { jsonrpc: "2.0", id: "restart-list", method: "tools/list", params: {} }), "restart catalog");
      const firstResult = await bounded(postNativeJsonRpc(firstEndpoint, {
        jsonrpc: "2.0",
        id: "restart-first",
        method: "tools/call",
        params: { name: DURABLE_EFFECT_TOOL_NAME, arguments: { slot: "native-restart-slot" } },
      }), "restart first effect");
      expect(firstResult).toMatchObject({ id: "restart-first", result: { structuredContent: DURABLE_EFFECT_RESULT } });
      const interruptedRows = await bounded(readNativeDurableRows(interruptedHarness.layer, interruptedProjectId, interruptedRecord.id), "restart launch-turn rows");
      expect(interruptedRows.turns).toHaveLength(1);
      const interruptedTurn = interruptedRows.turns[0]!;
      expect(interruptedTurn).toMatchObject({ state: "open" });
      expect(interruptedRows.receipts).toEqual([{ logical_key: `${interruptedTurn.turn_key}:0`, turn_key: interruptedTurn.turn_key, slot_ordinal: 0, tool_authority: DURABLE_EFFECT_AUTHORITY, state: "committed" }]);
      captureNativeSessionId(interruptedStore as never, interruptedRecord.id, "native-follow-up-restart");
      await bounded(interruptedStore.flush(), "restart first-store flush");
      await bounded(disposeManager(interruptedFirst.manager), "restart first-manager disposal");

      const restartedStore = await bounded(CliSessionStore.create(interruptedHarness.layer, interruptedProjectId), "restart rehydrated store");
      interruptedResumed = makeManager(restartedStore as never);
      await bounded(interruptedResumed.manager.spawn({
        adapterId: "claude-code",
        projectId: interruptedProjectId,
        purpose: "execute",
        taskId: "task-native-follow-up-restart",
        worktreePath: tmpdir(),
        settings: { subscriptionReady: true },
        resume: { sessionId: interruptedRecord.id, nativeSessionId: "native-follow-up-restart" },
      }), "restart resumed manager spawn");
      const resumedEndpoint = claudeConfiguredUrl(interruptedResumed.captures[0]!.args, DURABLE_EFFECT_SERVER_NAME);
      const replay = await bounded(postNativeJsonRpc(resumedEndpoint, {
        jsonrpc: "2.0",
        id: "restart-replay",
        method: "tools/call",
        params: { name: DURABLE_EFFECT_TOOL_NAME, arguments: { slot: "native-restart-slot" } },
      }), "restart replay");
      expect(replay).toMatchObject({ jsonrpc: "2.0", result: firstResult.result });
      expect(interruptedFixture.upstreamExecutions()).toBe(1);
      const replayRows = await bounded(readNativeDurableRows(interruptedHarness.layer, interruptedProjectId, interruptedRecord.id), "restart replay rows");
      expect(replayRows.turns).toEqual([expect.objectContaining({ turn_key: interruptedTurn.turn_key, state: "open" })]);
      expect(replayRows.receipts).toEqual(interruptedRows.receipts);
    } finally {
      if (interruptedResumed) await bounded(disposeManager(interruptedResumed.manager), "restart resumed-manager disposal");
      await bounded(disposeManager(interruptedFirst.manager), "restart first-manager disposal");
      await bounded(interruptedHarness.teardown(), "restart PostgreSQL teardown", 5_000);
      await bounded(interruptedFixture.close(), "restart fixture closure");
    }

    const followUpFixture = await bounded(startDurableEffectFixture(), "follow-up fixture");
    const followUpHarness = await bounded(createTaskStoreForTest({ prefix: "fusion_wave3_follow_up_public" }), "follow-up PostgreSQL harness", 5_000);
    const followUpProjectId = "ccc-native-follow-up-public";
    const followUpStore = await bounded(CliSessionStore.create(followUpHarness.layer, followUpProjectId), "follow-up store");
    const writes: string[] = [];
    const firstWrite = deferred<string>();
    let configuredEndpoint = "";
    const adapter: CliAgentAdapter = {
      id: "native-mcp-follow-up-public",
      name: "Native MCP public follow-up adapter",
      capabilities: { nativeDone: true, nativeWaiting: false, transcriptSource: "hooks", supportsResume: true },
      defaultCommand: process.execPath,
      buildLaunch: ({ settings }) => {
        const servers = settings.mcpServers as Array<{ url?: string }> | undefined;
        configuredEndpoint = servers?.[0]?.url ?? configuredEndpoint;
        return { command: process.execPath, args: ["-e", `process.stdout.write(${JSON.stringify(`${NATIVE_DISPOSAL_READY}\n`)}); setInterval(() => {}, 1000)`] };
      },
      buildEnvAllowlist: () => [],
      createReadinessDetector: () => ({ observe: (data) => data.includes(NATIVE_DISPOSAL_READY) }),
      formatInjection: (text) => ({ payload: text }),
    };
    const followUpRegistry = new CliAdapterRegistry();
    followUpRegistry.register(adapter);
    const followUpManager = new CliSessionManager({
      registry: followUpRegistry,
      store: followUpStore,
      loadPty: async () => realChildProcessPtyModule({
        onWrite: (payload) => {
          writes.push(payload);
          if (writes.length === 1) firstWrite.resolve(payload);
        },
      }) as never,
    });
    const followUpHub = new TelemetryHub({ store: followUpStore });
    let publicSession: Awaited<ReturnType<typeof launchCliTaskSession>> | undefined;
    let publicClient: Client | undefined;
    try {
      publicSession = await bounded(launchCliTaskSession({
        taskId: "task-native-follow-up-public",
        projectId: followUpProjectId,
        worktreePath: tmpdir(),
        prompt: "turn one",
        config: {
          cliAdapterId: adapter.id,
          settings: { profile: CCC_PROFILE, subscriptionReady: true },
        },
        manager: followUpManager,
        hub: followUpHub,
        registry: followUpRegistry,
        hookEndpointUrl: "http://127.0.0.1:1/unused-hook",
        hookDirRoot: tmpdir(),
        mcpServers: [{ name: DURABLE_EFFECT_SERVER_NAME, transport: "streamable-http", url: followUpFixture.url, enabled: true }],
      }), "public task-session launch", 3_000);
      await bounded(followUpManager.waitForReady(publicSession.sessionId), "public provider readiness");
      await bounded(firstWrite.promise, "public launch prompt injection");
      await bounded(vi.waitFor(() => expect(followUpHub.getStateMachine(publicSession!.sessionId)?.getState()).toBe("busy"), { timeout: 1_500 }), "public busy state");
      const endpointBeforeFollowUp = assertLoopbackTarget(configuredEndpoint).toString();
      publicClient = new Client({ name: "ccc-wave3-public-follow-up", version: "1.0.0" }, { capabilities: {} });
      await bounded(publicClient.connect(new StreamableHTTPClientTransport(assertLoopbackTarget(endpointBeforeFollowUp))), "public MCP client connect");
      expect((await bounded(publicClient.listTools(), "public MCP catalog")).tools).toEqual([expect.objectContaining({ name: DURABLE_EFFECT_TOOL_NAME })]);
      const launchEffect = await bounded(publicClient.callTool({ name: DURABLE_EFFECT_TOOL_NAME, arguments: { slot: "native-restart-slot" } }), "public launch-turn effect");
      expect(launchEffect.structuredContent).toEqual(DURABLE_EFFECT_RESULT);
      expect(followUpFixture.upstreamExecutions()).toBe(1);
      const launchRows = await bounded(readNativeDurableRows(followUpHarness.layer, followUpProjectId, publicSession.sessionId), "public launch-turn rows");
      expect(launchRows.turns).toHaveLength(1);
      const launchTurn = launchRows.turns[0]!;
      expect(launchTurn).toMatchObject({ state: "open" });
      expect(launchRows.receipts).toEqual([{ logical_key: `${launchTurn.turn_key}:0`, turn_key: launchTurn.turn_key, slot_ordinal: 0, tool_authority: DURABLE_EFFECT_AUTHORITY, state: "committed" }]);

      expect(followUpHub.ingest(publicSession.sessionId, { kind: "done" })).toMatchObject({ kind: "done" });
      await expect(bounded(publicSession.result(), "public done result")).resolves.toMatchObject({ kind: "success", sessionId: publicSession.sessionId });
      expect(followUpManager.isLive(publicSession.sessionId)).toBe(true);
      const connectedClient = publicClient;
      expect(await bounded(publicSession.followUp("turn two"), "public follow-up")).toBe(true);
      expect(writes.at(-1)).toContain("turn two");
      expect(publicClient).toBe(connectedClient);
      expect(configuredEndpoint).toBe(endpointBeforeFollowUp);

      const afterFollowUp = await bounded(readNativeDurableRows(followUpHarness.layer, followUpProjectId, publicSession.sessionId), "public follow-up durable turns");
      expect(afterFollowUp.turns.find((turn) => turn.turn_key === launchTurn.turn_key)).toMatchObject({ state: "closed" });
      const newOpenTurns = afterFollowUp.turns.filter((turn) => turn.state === "open");
      expect(newOpenTurns).toHaveLength(1);
      expect(newOpenTurns[0]!.turn_key).not.toBe(launchTurn.turn_key);
      const secondEffect = await bounded(publicClient.callTool({ name: DURABLE_EFFECT_TOOL_NAME, arguments: { slot: "native-restart-slot" } }), "public follow-up effect");
      expect(secondEffect.structuredContent).toEqual(DURABLE_EFFECT_RESULT);
      expect(followUpFixture.upstreamExecutions()).toBe(2);
      const followUpReceipts = (await bounded(readNativeDurableRows(followUpHarness.layer, followUpProjectId, publicSession.sessionId), "public follow-up receipts")).receipts;
      expect(followUpReceipts).toHaveLength(2);
      expect(followUpReceipts).toEqual(expect.arrayContaining([
        expect.objectContaining({ logical_key: `${launchTurn.turn_key}:0`, turn_key: launchTurn.turn_key, slot_ordinal: 0, tool_authority: DURABLE_EFFECT_AUTHORITY, state: "committed" }),
        expect.objectContaining({ logical_key: `${newOpenTurns[0]!.turn_key}:0`, turn_key: newOpenTurns[0]!.turn_key, slot_ordinal: 0, tool_authority: DURABLE_EFFECT_AUTHORITY, state: "committed" }),
      ]));
    } finally {
      if (publicClient) await bounded(publicClient.close(), "public MCP client closure");
      if (publicSession) await bounded(publicSession.kill(), "public task-session kill");
      await bounded(followUpManager.dispose(), "public manager disposal");
      await bounded(followUpHarness.teardown(), "public PostgreSQL teardown", 5_000);
      await bounded(followUpFixture.close(), "public fixture closure");
    }
  });

  it("native Claude and Codex effectful MCP calls survive manager/store restart through one durable Fusion receipt", async () => {
    const fixture = await startDurableEffectFixture();
    const harness = await createTaskStoreForTest({ prefix: "fusion_wave3_native_mcp" });
    const upstreamExecutions: number[] = [];
    try {
      for (const { adapterId, model, configuredUrl } of [
        { adapterId: "claude-code", model: "claude-wave3-native", configuredUrl: claudeConfiguredUrl },
        { adapterId: "codex", model: "gpt-wave3-native", configuredUrl: codexConfiguredUrl },
      ] as const) {
        const executionsBefore = fixture.upstreamExecutions();
        const projectId = `ccc-native-receipt-${adapterId}`;
        const firstStore = await CliSessionStore.create(harness.layer, projectId);
        const first = makeManager(firstStore as never);
        const record = await first.manager.spawn({
          adapterId, projectId, purpose: "execute", taskId: `task-${adapterId}-native-receipt`, worktreePath: tmpdir(),
          settings: { profile: CCC_PROFILE, subscriptionReady: true, model, mcpServers: [{ name: DURABLE_EFFECT_SERVER_NAME, transport: "streamable-http", url: fixture.url, enabled: true }] },
        });
        const firstResult = await callDurableEffect(configuredUrl(first.captures[0]!.args, DURABLE_EFFECT_SERVER_NAME));
        const nativeSessionId = `${adapterId}-native-receipt-session`;
        captureNativeSessionId(firstStore as never, record.id, nativeSessionId);
        await firstStore.flush();
        await disposeManager(first.manager);
        await firstStore.flush();

        const restartedStore = await CliSessionStore.create(harness.layer, projectId);
        const durableRecord = restartedStore.getSession(record.id);
        expect(durableRecord).toMatchObject({ agentState: "dead", terminationReason: "engineDeath", nativeSessionId });
        const resumed = makeManager(restartedStore as never);
        try {
          await resumed.manager.spawn({
            adapterId, projectId, purpose: "execute", taskId: durableRecord!.taskId, worktreePath: tmpdir(), settings: { subscriptionReady: true },
            resume: { sessionId: record.id, nativeSessionId },
          });
          expect(await callDurableEffect(configuredUrl(resumed.captures[0]!.args, DURABLE_EFFECT_SERVER_NAME))).toEqual(firstResult);
        } finally { await disposeManager(resumed.manager); }
        upstreamExecutions.push(fixture.upstreamExecutions() - executionsBefore);
      }
      expect(upstreamExecutions).toEqual([1, 1]);
    } finally { await harness.teardown(); await fixture.close(); }
  });
});
