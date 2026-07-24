import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import {
  prepareCccEffectReceipt,
  reserveCccEffectReceipt,
  type CccEffectReceiptStore,
} from "@fusion/core";
import type { CccNativeMcpServerDefinition } from "./ccc-native-mcp-policy.js";

type ToolResult = Record<string, unknown>;

type ReceiptPayload = { result: unknown } | { error: unknown };

function isUntrustedToolFailure(result: ToolResult): boolean {
  if (result.error !== undefined) return true;
  const rpcResult = result.result;
  return Boolean(rpcResult && typeof rpcResult === "object" && (rpcResult as Record<string, unknown>).isError === true);
}

function receiptPayloadFromRpc(result: ToolResult): ReceiptPayload {
  if (result.error !== undefined) return { error: result.error };
  if (result.result !== undefined) return { result: result.result };
  throw new Error("CCC native MCP effect response is missing its JSON-RPC result/error payload");
}

function rpcEnvelope(payload: unknown, id: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object") {
    throw new Error("CCC native MCP durable receipt is not a structured JSON-RPC payload");
  }
  const record = payload as Record<string, unknown>;
  if (record.error !== undefined) return { jsonrpc: "2.0", error: record.error, id };
  if (record.result !== undefined) return { jsonrpc: "2.0", result: record.result, id };
  throw new Error("CCC native MCP durable receipt is missing its JSON-RPC result/error payload");
}

function toolRouteKey(server: CccNativeMcpServerDefinition, toolName: string): string {
  // The literal configured loopback route is the durable native-server identity;
  // a same-named tool on another route must never inherit this classification.
  return `${server.url}\u0000${toolName}`;
}

export interface CccNativeMcpProxy {
  servers: CccNativeMcpServerDefinition[];
  /** Advance only when the owning task accepts a real new prompt/follow-up. */
  rotateEffectTurn(): Promise<void>;
  dispose(): Promise<void>;
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function copyHeaders(source: Headers): Record<string, string> {
  const headers: Record<string, string> = {};
  source.forEach((value, key) => {
    if (!/^(connection|keep-alive|transfer-encoding|content-length)$/i.test(key)) headers[key] = value;
  });
  return headers;
}

/**
 * A session-owned, literal-loopback MCP bridge. It deliberately has no route
 * to arbitrary URLs: each path segment selects one already policy-validated
 * upstream definition captured at session creation.
 */
export async function startCccNativeMcpProxy(options: {
  servers: readonly CccNativeMcpServerDefinition[];
  receiptStore?: CccEffectReceiptStore;
  effectScopeId?: string;
  controllerToken?: string;
}): Promise<CccNativeMcpProxy> {
  const upstream = new Map(options.servers.map((server) => [server.name, server]));
  const aborts = new Set<AbortController>();
  const toolReadOnly = new Map<string, boolean>();
  const sockets = new Set<Socket>();
  let turnKey: string | undefined;
  let slot = 0;
  if (options.receiptStore && options.effectScopeId && options.controllerToken) {
    turnKey = (await options.receiptStore.openCccEffectTurn(options.effectScopeId, options.controllerToken)).turnKey;
  }

  const server = createServer(async (request, response) => {
    const name = request.url?.match(/^\/mcp\/([^/?#]+)/)?.[1];
    const target = name ? upstream.get(decodeURIComponent(name)) : undefined;
    if (!target) {
      writeJson(response, 404, { error: "CCC native MCP proxy route not found" });
      return;
    }
    const body = await readBody(request);
    let rpc: Record<string, unknown> | undefined;
    try { rpc = JSON.parse(body.toString("utf8")) as Record<string, unknown>; } catch { /* upstream receives invalid protocol bytes unchanged */ }
    const params = rpc?.params as Record<string, unknown> | undefined;
    const isList = rpc?.method === "tools/list";
    const isCall = rpc?.method === "tools/call";
    const toolName = typeof params?.name === "string" ? params.name : undefined;
    const args = params?.arguments;

    if (isCall && toolName && toolReadOnly.get(toolRouteKey(target, toolName)) !== true && options.receiptStore && options.effectScopeId && options.controllerToken && turnKey) {
      const prepared = prepareCccEffectReceipt({
        sessionId: options.effectScopeId,
        toolName,
        arguments: args,
        controllerToken: options.controllerToken,
        turnKey,
        slotOrdinal: slot++,
      });
      const reservation = await reserveCccEffectReceipt(options.receiptStore, {
        sessionId: prepared.effectScopeId,
        toolName: prepared.toolAuthority,
        arguments: prepared.forwardedArguments,
        controllerToken: prepared.controllerToken,
        turnKey: prepared.turnKey,
        slotOrdinal: prepared.slotOrdinal,
      });
      if (reservation.state === "committed") {
        writeJson(response, 200, rpcEnvelope(reservation.result, rpc?.id ?? null));
        return;
      }
      await options.receiptStore.markCccEffectReceiptDispatched(reservation);
      const abort = new AbortController();
      aborts.add(abort);
      try {
        const upstreamResponse = await fetch(target.url, {
          method: request.method,
          headers: Object.fromEntries(Object.entries(request.headers).filter(([, value]) => typeof value === "string")) as Record<string, string>,
          body: body.length > 0 ? new Uint8Array(body) : undefined,
          signal: abort.signal,
        });
        const bytes = Buffer.from(await upstreamResponse.arrayBuffer());
        let result: ToolResult;
        try { result = JSON.parse(bytes.toString("utf8")) as ToolResult; } catch {
          throw new Error("CCC native MCP effect response is not a bounded structured result");
        }
        // A provider-declared generic failure is not authoritative proof that
        // no side effect occurred. The `dispatched_unknown` barrier remains
        // durable and the caller receives the untouched structured failure.
        if (isUntrustedToolFailure(result)) {
          response.writeHead(upstreamResponse.status, copyHeaders(upstreamResponse.headers));
          response.end(bytes);
          return;
        }
        await options.receiptStore.commitCccEffectReceipt(reservation, receiptPayloadFromRpc(result));
        response.writeHead(upstreamResponse.status, copyHeaders(upstreamResponse.headers));
        response.end(bytes);
        return;
      } catch (error) {
        // Cancellation must close the request/stream before its owner can make
        // terminal durability claims. A handler that merely rejects leaves the
        // loopback socket open and lets that owner observe a false closure.
        if (!response.writableEnded && !response.destroyed) {
          writeJson(response, 502, { jsonrpc: "2.0", error: { code: -32000, message: error instanceof Error ? error.message : "CCC native MCP proxy request failed" }, id: rpc?.id ?? null });
        }
      } finally {
        aborts.delete(abort);
      }
    }

    const abort = new AbortController();
    aborts.add(abort);
    try {
      const upstreamResponse = await fetch(target.url, {
        method: request.method,
        headers: Object.fromEntries(Object.entries(request.headers).filter(([, value]) => typeof value === "string")) as Record<string, string>,
        body: body.length > 0 ? new Uint8Array(body) : undefined,
        signal: abort.signal,
      });
      const bytes = Buffer.from(await upstreamResponse.arrayBuffer());
      if (isList) {
        try {
          const payload = JSON.parse(bytes.toString("utf8")) as { result?: { tools?: Array<{ name?: string; annotations?: { readOnlyHint?: boolean } }> } };
          for (const tool of payload.result?.tools ?? []) {
            if (typeof tool.name === "string") toolReadOnly.set(toolRouteKey(target, tool.name), tool.annotations?.readOnlyHint === true);
          }
        } catch { /* protocol response remains authoritative; unknown metadata fails effectful */ }
      }
      response.writeHead(upstreamResponse.status, copyHeaders(upstreamResponse.headers));
      response.end(bytes);
    } catch (error) {
      if (!response.writableEnded && !response.destroyed) {
        writeJson(response, 502, { jsonrpc: "2.0", error: { code: -32000, message: error instanceof Error ? error.message : "CCC native MCP proxy request failed" }, id: rpc?.id ?? null });
      }
    } finally {
      aborts.delete(abort);
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  const address = server.address() as AddressInfo;
  return {
    servers: options.servers.map((entry) => ({
      ...entry,
      url: `http://127.0.0.1:${address.port}/mcp/${encodeURIComponent(entry.name)}`,
    })),
    async rotateEffectTurn() {
      if (!options.receiptStore || !options.effectScopeId || !options.controllerToken || !turnKey) return;
      await options.receiptStore.closeCccEffectTurn(options.effectScopeId, turnKey, options.controllerToken);
      turnKey = (await options.receiptStore.openCccEffectTurn(options.effectScopeId, options.controllerToken)).turnKey;
      slot = 0;
    },
    async dispose() {
      for (const abort of aborts) abort.abort();
      // Explicitly close registered downstream sockets after aborting their
      // owned upstream fetches. `server.close()` alone waits indefinitely for a
      // request handler that is itself awaiting the aborted transport.
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
