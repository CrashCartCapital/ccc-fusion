import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { ResolvedMcpServerDefinition } from "@fusion/core";
import { claudeCodeAdapter } from "../cli-agent/adapters/claude-code.js";
import { codexAdapter } from "../cli-agent/adapters/codex.js";

/*
FNXC:CCCNativeMcp 2026-07-23-15:45:
Wave 2 proves Claude and Codex native MCP configuration separately. Each adapter
must carry the exact requested model and the same loopback-only streamable-HTTP
server through its native launch configuration. The test then decodes that
adapter-produced configuration, performs a real MCP initialize/list/call against
the local fixture, and verifies typed schema plus structured session/effect
result identity. No CLI process, prompt flattening, filesystem, shell, Git,
credential, mutation, live provider, or external-network capability is present.
*/

const TOOL_NAME = "read_session_effect";
const SERVER_NAME = "ccc-readonly-fixture";
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

function claudeConfiguredUrl(args: string[]): string {
  const index = args.indexOf("--mcp-config");
  expect(index).toBeGreaterThanOrEqual(0);
  const raw = args[index + 1];
  expect(raw).toBeDefined();
  const config = JSON.parse(raw!) as {
    mcpServers?: Record<string, { type?: string; url?: string }>;
  };
  expect(config.mcpServers?.[SERVER_NAME]).toMatchObject({
    type: "http",
  });
  return config.mcpServers?.[SERVER_NAME]?.url ?? "";
}

function codexConfiguredUrl(args: string[]): string {
  const assignments = args
    .map((arg, index) => args[index - 1] === "-c" ? arg : undefined)
    .filter((arg): arg is string => typeof arg === "string");
  const prefix = `mcp_servers.${JSON.stringify(SERVER_NAME)}.url=`;
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
    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(0, "127.0.0.1", resolve);
    });
    const address = httpServer.address() as AddressInfo;
    mcpUrl = `http://127.0.0.1:${address.port}/mcp`;
    assertLoopbackTarget(mcpUrl);
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => error ? reject(error) : resolve());
    });
  });

  beforeEach(() => {
    calls.length = 0;
  });

  const nativeMcpServer = (): ResolvedMcpServerDefinition => ({
    name: SERVER_NAME,
    transport: "streamable-http",
    url: mcpUrl,
    enabled: true,
  });

  it("Claude preserves requested model, typed schema, native call, and structured result", async () => {
    const requestedModel = "claude-native-wave2-exact";
    const launch = claudeCodeAdapter.buildLaunch({
      posture: null,
      settings: {
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

  it("Codex preserves requested model, typed schema, native call, and structured result", async () => {
    const requestedModel = "gpt-native-wave2-exact";
    const launch = codexAdapter.buildLaunch({
      posture: null,
      settings: {
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

  it("fails closed for non-loopback MCP targets and exposes no extra tool capability", () => {
    expect(() => assertLoopbackTarget("https://example.invalid/mcp")).toThrow(
      "Wave 2 MCP egress guard rejected non-loopback target",
    );
    expect(calls).toEqual([]);
  });
});
