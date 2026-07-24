import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import {
  prepareCccEffectReceipt,
  reserveCccEffectReceipt,
  type CccEffectReceiptStore,
} from "@fusion/core";
import type { CccNativeMcpServerDefinition } from "./ccc-native-mcp-policy.js";

type ToolResult = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isUntrustedToolFailure(result: ToolResult): boolean {
  if (result.error !== undefined) return true;
  const rpcResult = result.result;
  return Boolean(rpcResult && typeof rpcResult === "object" && (rpcResult as Record<string, unknown>).isError === true);
}

/** Canonical, redacted receipt authority: policy route and tool, never upstream URL. */
function routeToolAuthority(route: string, tool: string): string {
  return `${encodeURIComponent(route)}:${encodeURIComponent(tool)}`;
}

function routeToolKey(route: string, tool: string): string {
  return JSON.stringify([route, tool]);
}

/**
 * Committed v2 receipts hold the MCP result itself. Older receipts held the
 * whole JSON-RPC envelope; decode only a successful envelope and otherwise
 * fail closed rather than replaying a malformed/error result.
 */
function decodeLegacyEnvelopeResult(candidate: unknown): unknown | undefined {
  if (!isRecord(candidate) || candidate.jsonrpc !== "2.0" || candidate.error !== undefined || !Object.prototype.hasOwnProperty.call(candidate, "result")) return undefined;
  const result = candidate.result;
  return isRecord(result) && result.isError === true ? undefined : result;
}

function decodeCommittedResult(candidate: unknown): unknown | undefined {
  if (!isRecord(candidate) || candidate.isError === true) return undefined;
  return Object.prototype.hasOwnProperty.call(candidate, "jsonrpc")
    ? decodeLegacyEnvelopeResult(candidate)
    : candidate;
}

export interface CccNativeMcpProxy {
  servers: CccNativeMcpServerDefinition[];
  /** Semantic boundary used only by a completed public task-session follow-up. */
  beginFollowUpTurn(): Promise<void>;
  dispose(): Promise<void>;
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.writableEnded || response.destroyed) return;
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function writeRpcError(response: ServerResponse, id: unknown, code: number, message: string): void {
  writeJson(response, 200, { jsonrpc: "2.0", id: id ?? null, error: { code, message } });
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
  const handlers = new Set<Promise<void>>();
  const sockets = new Set<Socket>();
  const toolReadOnly = new Map<string, boolean>();
  let turnKey: string | undefined;
  let slot = 0;
  let stopping = false;
  let disposePromise: Promise<void> | undefined;
  let tail = Promise.resolve();
  if (options.receiptStore && options.effectScopeId && options.controllerToken) {
    turnKey = (await options.receiptStore.openCccEffectTurn(options.effectScopeId, options.controllerToken)).turnKey;
  }

  const serialized = async <T>(operation: () => Promise<T>): Promise<T> => {
    let release!: () => void;
    const next = new Promise<void>((resolve) => { release = resolve; });
    const previous = tail;
    tail = next;
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  };

  const beginFollowUpTurn = async (): Promise<void> => {
    const receiptStore = options.receiptStore;
    const effectScopeId = options.effectScopeId;
    const controllerToken = options.controllerToken;
    if (!receiptStore || !effectScopeId || !controllerToken) return;
    await serialized(async () => {
      if (stopping || !turnKey) throw new Error("CCC native MCP effect turn is unavailable");
      const priorTurnKey = turnKey;
      await receiptStore.closeCccEffectTurn(effectScopeId, priorTurnKey, controllerToken);
      // A closed turn may never remain usable if opening its successor fails.
      turnKey = undefined;
      slot = 0;
      turnKey = (await receiptStore.openCccEffectTurn(effectScopeId, controllerToken)).turnKey;
    });
  };

  const forward = async (target: CccNativeMcpServerDefinition, request: IncomingMessage, body: Buffer, abort: AbortController): Promise<{ response: Response; bytes: Buffer }> => {
    const response = await fetch(target.url, {
      method: request.method,
      headers: Object.fromEntries(Object.entries(request.headers).filter(([, value]) => typeof value === "string")) as Record<string, string>,
      body: body.length > 0 ? new Uint8Array(body) : undefined,
      signal: abort.signal,
    });
    return { response, bytes: Buffer.from(await response.arrayBuffer()) };
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const name = request.url?.match(/^\/mcp\/([^/?#]+)/)?.[1];
    const target = name ? upstream.get(decodeURIComponent(name)) : undefined;
    if (!target) {
      writeJson(response, 404, { error: "CCC native MCP proxy route not found" });
      return;
    }
    if (stopping) {
      writeRpcError(response, null, -32000, "CCC native MCP proxy is closing");
      return;
    }
    let rpc: Record<string, unknown> | undefined;
    try {
      const body = await readBody(request);
      try { rpc = JSON.parse(body.toString("utf8")) as Record<string, unknown>; } catch { /* upstream receives invalid protocol bytes unchanged */ }
      const params = rpc?.params as Record<string, unknown> | undefined;
      const isList = rpc?.method === "tools/list";
      const isCall = rpc?.method === "tools/call";
      const toolName = typeof params?.name === "string" ? params.name : undefined;
      const args = params?.arguments;

      if (isCall && toolName && toolReadOnly.get(routeToolKey(target.name, toolName)) !== true && options.receiptStore && options.effectScopeId && options.controllerToken) {
        await serialized(async () => {
          if (stopping || !turnKey) {
            writeRpcError(response, rpc?.id, -32000, "CCC native MCP effect turn is unavailable");
            return;
          }
          const prepared = prepareCccEffectReceipt({
            sessionId: options.effectScopeId!,
            toolName: routeToolAuthority(target.name, toolName),
            arguments: args,
            controllerToken: options.controllerToken!,
            turnKey,
            slotOrdinal: slot++,
          });
          const existing = await options.receiptStore!.getCccEffectReceipt(prepared.effectScopeId, prepared.logicalKey);
          if (existing?.toolAuthority === toolName) {
            const unambiguousLegacyRoute = upstream.size === 1;
            const matchingLegacyReceipt = existing.state === "committed"
              && existing.effectScopeId === prepared.effectScopeId
              && existing.logicalKey === prepared.logicalKey
              && existing.turnKey === prepared.turnKey
              && existing.slotOrdinal === prepared.slotOrdinal
              && existing.repeatOf === prepared.repeatOf
              && existing.argumentsDigest === prepared.argumentsDigest;
            const legacyResult = unambiguousLegacyRoute && matchingLegacyReceipt
              ? decodeLegacyEnvelopeResult(existing.result)
              : undefined;
            if (legacyResult === undefined) {
              writeRpcError(response, rpc?.id, -32000, "CCC native MCP legacy receipt is not safely replayable");
              return;
            }
            writeJson(response, 200, { jsonrpc: "2.0", id: rpc?.id ?? null, result: legacyResult });
            return;
          }
          const reservation = await reserveCccEffectReceipt(options.receiptStore!, {
            sessionId: prepared.effectScopeId,
            toolName: prepared.toolAuthority,
            arguments: prepared.forwardedArguments,
            controllerToken: prepared.controllerToken,
            turnKey: prepared.turnKey,
            slotOrdinal: prepared.slotOrdinal,
          });
          if (reservation.state === "committed") {
            const committedResult = decodeCommittedResult(reservation.result);
            if (committedResult === undefined) {
              writeRpcError(response, rpc?.id, -32000, "CCC native MCP committed receipt is not safely replayable");
              return;
            }
            writeJson(response, 200, { jsonrpc: "2.0", id: rpc?.id ?? null, result: committedResult });
            return;
          }
          await options.receiptStore!.markCccEffectReceiptDispatched(reservation);
          const abort = new AbortController();
          aborts.add(abort);
          try {
            const upstreamResult = await forward(target, request, body, abort);
            let envelope: ToolResult;
            try { envelope = JSON.parse(upstreamResult.bytes.toString("utf8")) as ToolResult; } catch {
              throw new Error("CCC native MCP effect response is not a bounded structured result");
            }
            if (isUntrustedToolFailure(envelope) || !Object.prototype.hasOwnProperty.call(envelope, "result")) {
              response.writeHead(upstreamResult.response.status, copyHeaders(upstreamResult.response.headers));
              response.end(upstreamResult.bytes);
              return;
            }
            await options.receiptStore!.commitCccEffectReceipt(reservation, envelope.result);
            response.writeHead(upstreamResult.response.status, copyHeaders(upstreamResult.response.headers));
            response.end(upstreamResult.bytes);
          } finally {
            aborts.delete(abort);
          }
        });
        return;
      }

      const abort = new AbortController();
      aborts.add(abort);
      try {
        const upstreamResult = await forward(target, request, body, abort);
        if (isList) {
          try {
            const payload = JSON.parse(upstreamResult.bytes.toString("utf8")) as { result?: { tools?: Array<{ name?: string; annotations?: { readOnlyHint?: boolean } }> } };
            for (const tool of payload.result?.tools ?? []) {
              if (typeof tool.name === "string") toolReadOnly.set(routeToolKey(target.name, tool.name), tool.annotations?.readOnlyHint === true);
            }
          } catch { /* protocol response remains authoritative; unknown metadata fails effectful */ }
        }
        response.writeHead(upstreamResult.response.status, copyHeaders(upstreamResult.response.headers));
        response.end(upstreamResult.bytes);
      } finally {
        aborts.delete(abort);
      }
    } catch (error) {
      if (!response.writableEnded && !response.destroyed) {
        writeRpcError(response, rpc?.id, -32000, error instanceof Error ? error.message : "CCC native MCP request failed");
      }
    }
  };

  const server = createServer((request, response) => {
    const handler = handle(request, response);
    handlers.add(handler);
    void handler.then(
      () => handlers.delete(handler),
      (error) => {
        handlers.delete(handler);
        writeRpcError(response, null, -32000, error instanceof Error ? error.message : "CCC native MCP request failed");
      },
    );
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    servers: options.servers.map((entry) => ({
      ...entry,
      url: `http://127.0.0.1:${address.port}/mcp/${encodeURIComponent(entry.name)}`,
    })),
    beginFollowUpTurn,
    dispose() {
      if (!disposePromise) {
        disposePromise = (async () => {
          stopping = true;
          // Stop accepting first, then give every owned downstream request a
          // closure signal before waiting for handlers that may still be in
          // pre-fetch body reads and therefore have no AbortController yet.
          const serverClosed = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
          for (const abort of aborts) abort.abort();
          server.closeAllConnections?.();
          for (const socket of sockets) socket.destroy();
          await tail;
          await Promise.allSettled([...handlers]);
          await serverClosed;
        })();
      }
      return disposePromise;
    },
  };
}
