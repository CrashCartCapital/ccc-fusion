import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import {
  CCC_TERMINAL_ROUTE_RECEIPT_API,
  createCccTerminalRouteSseCommentParser,
  streamCccTerminalRouteReceipt,
} from "../ccc-route-receipt-adapter.js";

function receiptModel(baseUrl = "http://127.0.0.1:65535/v1") {
  return {
    provider: "arbitrary-gateway",
    id: "upstream/model-a",
    api: CCC_TERMINAL_ROUTE_RECEIPT_API,
    baseUrl,
    headers: {},
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
  } as never;
}

const receiptContext = {
  messages: [{ role: "user" as const, content: "Hi", timestamp: Date.now() }],
};

describe("CCC terminal route SSE comment parser", () => {
  it("RED-RECEIPT-SSE-1: reconstructs a terminal receipt split across arbitrary byte chunks", () => {
    const parser = createCccTerminalRouteSseCommentParser();
    parser.push(": x-omniroute-pro");
    parser.push("vider=upstream\r\n: x-omniroute-model=mo");
    parser.push("del-a\r\n");

    expect(parser.finish()).toEqual({ provider: "upstream", model: "model-a" });
  });

  it("RED-RECEIPT-SSE-2: ignores unrelated SSE comments and data", () => {
    const parser = createCccTerminalRouteSseCommentParser();
    parser.push(": keepalive\n");
    parser.push("data: {\"choices\":[]}\n\n");
    parser.push(": x-omniroute-provider=upstream\n");
    parser.push(": x-omniroute-model=model-a\n");

    expect(parser.finish()).toEqual({ provider: "upstream", model: "model-a" });
  });

  it.each([
    [": x-omniroute-provider=upstream\n", "model"],
    [": x-omniroute-model=model-a\n", "provider"],
  ])("RED-RECEIPT-SSE-3: refuses a partial terminal receipt missing %s", (bytes) => {
    const parser = createCccTerminalRouteSseCommentParser();
    parser.push(bytes);

    expect(() => parser.finish()).toThrow(/terminal route receipt is incomplete/u);
  });

  it("RED-RECEIPT-SSE-4: refuses conflicting repeated observations", () => {
    const parser = createCccTerminalRouteSseCommentParser();
    parser.push(": x-omniroute-provider=upstream\n");
    parser.push(": x-omniroute-provider=other\n");
    parser.push(": x-omniroute-model=model-a\n");

    expect(() => parser.finish()).toThrow(/conflicting terminal route receipt/u);
  });

  it("RED-RECEIPT-SSE-5: refuses missing terminal evidence", () => {
    const parser = createCccTerminalRouteSseCommentParser();
    parser.push("data: [DONE]\n\n");

    expect(() => parser.finish()).toThrow(/terminal route receipt is missing/u);
  });

  it("RED-RECEIPT-SSE-6: refuses a receipt followed by a later response event", () => {
    const parser = createCccTerminalRouteSseCommentParser();
    parser.push(": x-omniroute-provider=upstream\n: x-omniroute-model=model-a\n");
    parser.push("data: {\"choices\":[{\"delta\":{\"content\":\"later\"}}]}\n\n");

    expect(() => parser.finish()).toThrow(/receipt is not terminal/u);
  });

  it("RED-RECEIPT-SSE-7: accepts SSE lines delimited by a bare carriage return", () => {
    const parser = createCccTerminalRouteSseCommentParser();
    parser.push(": x-omniroute-provider=upstream\r: x-omniroute-model=model-a\r");

    expect(parser.finish()).toEqual({ provider: "upstream", model: "model-a" });
  });
});

describe("CCC terminal route receipt request transport", () => {
  it("RED-RECEIPT-TRANSPORT-1: one loopback SSE response produces normal text plus the terminal receipt", async () => {
    let requestCount = 0;
    const server = createServer((request, response) => {
      requestCount += 1;
      request.resume();
      request.once("end", () => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write("data: {\"id\":\"chatcmpl-receipt\",\"object\":\"chat.completion.chunk\",\"model\":\"upstream/model-a\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"hello\"},\"finish_reason\":null}]}\n\n");
        response.write("data: {\"id\":\"chatcmpl-receipt\",\"object\":\"chat.completion.chunk\",\"model\":\"upstream/model-a\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":2,\"completion_tokens\":1,\"total_tokens\":3}}\n\n");
        response.end(": x-omniroute-provider=upstream\n: x-omniroute-model=model-a\ndata: [DONE]\n\n");
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;

    try {
      const stream = streamCccTerminalRouteReceipt({
        provider: "arbitrary-gateway",
        id: "upstream/model-a",
        api: CCC_TERMINAL_ROUTE_RECEIPT_API,
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        headers: {},
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 16_384,
      } as never, {
        messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
      }, { apiKey: "fixture-key", maxRetries: 0 });
      const deltas: string[] = [];
      for await (const event of stream) {
        if (event.type === "text_delta") deltas.push(event.delta);
      }
      const result = await stream.result();

      expect(deltas).toEqual(["hello"]);
      expect(result).toMatchObject({
        stopReason: "stop",
        omniRoute: { provider: "upstream", model: "model-a" },
        usage: { input: 2, output: 1, totalTokens: 3 },
      });
      expect(requestCount).toBe(1);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("RED-RECEIPT-TRANSPORT-2: cancels the owned reader and aborts the request after a parser failure", async () => {
    const originalFetch = globalThis.fetch;
    let cancelCalls = 0;
    let requestSignal: AbortSignal | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: not-json\n\n"));
      },
      cancel() {
        cancelCalls += 1;
      },
    });
    vi.stubGlobal("fetch", vi.fn(async (_input, init) => {
      requestSignal = init?.signal as AbortSignal | undefined;
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }));

    try {
      const result = await streamCccTerminalRouteReceipt({
        provider: "arbitrary-gateway",
        id: "upstream/model-a",
        api: CCC_TERMINAL_ROUTE_RECEIPT_API,
        baseUrl: "http://127.0.0.1:65535/v1",
        headers: {},
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 16_384,
      } as never, {
        messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
      }, { apiKey: "fixture-key", maxRetries: 0 }).result();

      expect(result.stopReason).toBe("error");
      expect(cancelCalls).toBe(1);
      expect(requestSignal?.aborted).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("RED-G2-RECEIPT-CLEANUP: preserves the primary request failure when response cleanup also fails", async () => {
    const originalFetch = globalThis.fetch;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: not-json\n\n"));
      },
      cancel() {
        throw new Error("fixture response cleanup failed");
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })));

    try {
      const result = await streamCccTerminalRouteReceipt(
        receiptModel(),
        receiptContext,
        { apiKey: "fixture-key", maxRetries: 0 },
      ).result() as typeof receiptContext & {
        stopReason: string;
        errorMessage?: string;
        cleanupErrorMessage?: string;
      };

      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).toMatch(/not-json|JSON/u);
      expect(result.cleanupErrorMessage).toBe("fixture response cleanup failed");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("RED-RECEIPT-TRANSPORT-3: closes reasoning and text blocks before starting the next event kind", async () => {
    const server = createServer((request, response) => {
      request.resume();
      request.once("end", () => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write("data: {\"model\":\"upstream/model-a\",\"choices\":[{\"index\":0,\"delta\":{\"reasoning_content\":\"think\"},\"finish_reason\":null}]}\n\n");
        response.write("data: {\"model\":\"upstream/model-a\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"answer\"},\"finish_reason\":null}]}\n\n");
        response.write("data: {\"model\":\"upstream/model-a\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call-1\",\"function\":{\"name\":\"read\",\"arguments\":\"{}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n");
        response.end(": x-omniroute-provider=upstream\n: x-omniroute-model=model-a\ndata: [DONE]\n\n");
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;

    try {
      const stream = streamCccTerminalRouteReceipt({
        provider: "arbitrary-gateway",
        id: "upstream/model-a",
        api: CCC_TERMINAL_ROUTE_RECEIPT_API,
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        headers: {},
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 16_384,
      } as never, {
        messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
      }, { apiKey: "fixture-key", maxRetries: 0 });
      const eventTypes: string[] = [];
      for await (const event of stream) eventTypes.push(event.type);

      expect(eventTypes.indexOf("thinking_end")).toBeLessThan(eventTypes.indexOf("text_start"));
      expect(eventTypes.indexOf("text_end")).toBeLessThan(eventTypes.indexOf("toolcall_start"));
      expect(eventTypes.indexOf("toolcall_end")).toBeLessThan(eventTypes.indexOf("done"));
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("RED-RECEIPT-TRANSPORT-4: refuses an external abort observed with the final response bytes", async () => {
    const originalFetch = globalThis.fetch;
    const abortController = new AbortController();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          "data: {\"model\":\"upstream/model-a\",\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n"
          + ": x-omniroute-provider=upstream\n: x-omniroute-model=model-a\ndata: [DONE]\n\n",
        ));
        controller.close();
        abortController.abort(new Error("operator cancelled"));
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })));

    try {
      const result = await streamCccTerminalRouteReceipt(
        receiptModel(),
        receiptContext,
        { apiKey: "fixture-key", signal: abortController.signal },
      ).result();

      expect(result.stopReason).toBe("aborted");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("RED-RECEIPT-TRANSPORT-5: preserves two tool calls whose provider omits index", async () => {
    const originalFetch = globalThis.fetch;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          "data: {\"model\":\"upstream/model-a\",\"choices\":[{\"delta\":{\"tool_calls\":["
          + "{\"id\":\"call-1\",\"function\":{\"name\":\"read\",\"arguments\":\"{}\"}},"
          + "{\"id\":\"call-2\",\"function\":{\"name\":\"write\",\"arguments\":\"{}\"}}]},"
          + "\"finish_reason\":\"tool_calls\"}]}\n\n"
          + ": x-omniroute-provider=upstream\n: x-omniroute-model=model-a\ndata: [DONE]\n\n",
        ));
        controller.close();
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })));

    try {
      const result = await streamCccTerminalRouteReceipt(
        receiptModel(),
        receiptContext,
        { apiKey: "fixture-key" },
      ).result();
      const toolCalls = result.content.filter((block) => block.type === "toolCall");

      expect(toolCalls).toMatchObject([
        { id: "call-1", name: "read", arguments: {} },
        { id: "call-2", name: "write", arguments: {} },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("RED-RECEIPT-TRANSPORT-6: cancels an unconsumed body when response validation fails", async () => {
    const originalFetch = globalThis.fetch;
    let cancelCalls = 0;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelCalls += 1;
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, {
      status: 200,
      headers: { "content-type": "application/json" },
    })));

    try {
      const result = await streamCccTerminalRouteReceipt(
        receiptModel(),
        receiptContext,
        { apiKey: "fixture-key" },
      ).result();

      expect(result.stopReason).toBe("error");
      expect(cancelCalls).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("RED-RECEIPT-TRANSPORT-7: removes partial tool argument scratch state from error results", async () => {
    const originalFetch = globalThis.fetch;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"id\":\"call-1\",\"function\":{\"name\":\"read\",\"arguments\":\"{\"}}]}}]}\n\n"
          + "data: not-json\n\n",
        ));
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })));

    try {
      const result = await streamCccTerminalRouteReceipt(
        receiptModel(),
        receiptContext,
        { apiKey: "fixture-key" },
      ).result();

      expect(result.stopReason).toBe("error");
      expect(JSON.stringify(result.content)).not.toContain("partialArgs");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
