import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { completeSimple } from "@earendil-works/pi-ai/compat";
/*
FNXC:Dependencies 2026-07-01-08:16:
The pi 0.80 SDK keeps compatibility helpers under ./compat and exposes provider internals through the documented ./api/* export map instead of the previous root-level openai-completions subpath.
*/
import { convertMessages } from "@earendil-works/pi-ai/api/openai-completions";
import { customProviderRegistryKey, type CustomProvider } from "@fusion/core";
import {
  CCC_TERMINAL_ROUTE_RECEIPT_API,
  streamCccTerminalRouteReceipt,
} from "../ccc-route-receipt-adapter.js";

async function createInMemoryModelRegistry(): Promise<ModelRegistry> {
  const runtime = await ModelRuntime.create({
    credentials: { read: async () => undefined, list: async () => [], modify: async (_id, fn) => fn(undefined), delete: async () => undefined },
    modelsPath: null,
    allowModelNetwork: false,
  });
  return new ModelRegistry(runtime);
}

describe("custom providers openai-completions regression", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("registers under slug key and completes a chat round-trip", async () => {
    /*
    FNXC:CCCTransport 2026-07-23-15:45:
    Wave 2 transport proof uses the real Node fetch path against an ephemeral
    127.0.0.1 listener. A mocked fetch could hide base-URL or request-shape drift.
    */
    let capturedModel: unknown;
    const capturedRequestBodies: Array<{ method?: string; url?: string; body?: Record<string, unknown> }> = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const rawBody = Buffer.concat(chunks).toString("utf8");
        const body = rawBody.length > 0
          ? JSON.parse(rawBody) as Record<string, unknown>
          : undefined;
        capturedRequestBodies.push({ method: request.method, url: request.url, body });
        if (request.method === "POST" && body) {
          capturedModel = body.model;
        }
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write("data: {\"id\":\"chatcmpl-test\",\"object\":\"chat.completion.chunk\",\"model\":\"my-model\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"Hello from loopback transport\"},\"finish_reason\":null}]}\n\n");
        response.write("data: {\"id\":\"chatcmpl-test\",\"object\":\"chat.completion.chunk\",\"model\":\"my-model\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":1,\"completion_tokens\":1,\"total_tokens\":2}}\n\n");
        response.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    const modelRegistry = await createInMemoryModelRegistry();
    const providers: CustomProvider[] = [{
      id: "550e8400-e29b-41d4-a716-446655440000",
      name: "My AI Provider",
      apiType: "openai-compatible",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: "CUSTOM_KEY",
      models: [{ id: "my-model", name: "My Model" }],
    }];

    try {
      const provider = providers[0]!;
      modelRegistry.registerProvider(customProviderRegistryKey(provider, providers), {
        baseUrl: provider.baseUrl,
        api: "openai-completions",
        apiKey: provider.apiKey,
        models: [{ id: "my-model", name: "My Model", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 16384 }],
      });
      await modelRegistry.refresh();

      const registered = modelRegistry.getAll().find((model) => model.id === "my-model");
      expect(registered?.provider).toBe("my-ai-provider");

      const model = modelRegistry.find("my-ai-provider", "my-model");
      const response = await completeSimple(
        model!,
        { messages: [{ role: "user", content: "Hi", timestamp: Date.now() }] },
        { apiKey: "CUSTOM_KEY" },
      );
      expect(response.role).toBe("assistant");
      expect(response.model).toBe("my-model");
      expect(capturedRequestBodies).toContainEqual(expect.objectContaining({
        method: "POST",
        body: expect.objectContaining({ model: "my-model" }),
      }));
      expect(capturedModel).toBe("my-model");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  /*
  Stage 4 finding (2026-08-03): oMLX emits SSE keepalive chunks during prompt
  processing whose `model` field is the literal placeholder "keepalive" (and
  whose delta carries only an empty content/role). pi-ai captured responseModel
  from the FIRST chunk whose model differed from the requested id, so the
  placeholder poisoned response identity and the ccc transport-identity gate
  refused every oMLX response as drifted. Identity must be captured only from
  substantive chunks (non-empty content, tool calls, or a finish_reason), and a
  genuinely aliased backend must still be surfaced for the gate to refuse.
  */
  async function streamIdentityProbe(
    sseChunks: string[],
    providerName = "keepalive-probe",
    sseComments: string[] = [],
    signal?: AbortSignal,
    holdOpenMs = 0,
    commentsBeforeChunks = false,
    receiptAdapterSelected = false,
  ): Promise<{ responseModel?: string; model: string; stopReason?: string; errorMessage?: string }> {
    const server = createServer(async (request, response) => {
      request.on("data", () => {});
      request.on("end", () => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        if (commentsBeforeChunks) {
          for (const comment of sseComments) {
            response.write(`: ${comment}\n\n`);
          }
        }
        for (const chunk of sseChunks) {
          response.write(`data: ${chunk}\n\n`);
        }
        if (!commentsBeforeChunks) {
          for (const comment of sseComments) {
            response.write(`: ${comment}\n\n`);
          }
        }
        if (holdOpenMs > 0) {
          setTimeout(() => response.end("data: [DONE]\n\n"), holdOpenMs);
          return;
        }
        response.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    try {
      const modelRegistry = await createInMemoryModelRegistry();
      modelRegistry.registerProvider(providerName, {
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        api: receiptAdapterSelected
          ? CCC_TERMINAL_ROUTE_RECEIPT_API
          : "openai-completions",
        apiKey: "CUSTOM_KEY",
        models: [{
          id: "my-model",
          name: "My Model",
          api: receiptAdapterSelected ? CCC_TERMINAL_ROUTE_RECEIPT_API : "openai-completions",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 16384,
        }],
        ...(receiptAdapterSelected ? { streamSimple: streamCccTerminalRouteReceipt } : {}),
      });
      await modelRegistry.refresh();
      const model = modelRegistry.find(providerName, "my-model");
      const context = { messages: [{ role: "user" as const, content: "Hi", timestamp: Date.now() }] };
      const streamOptions = { apiKey: "CUSTOM_KEY", ...(signal ? { signal } : {}) };
      const response = receiptAdapterSelected
        ? await streamCccTerminalRouteReceipt(model!, context, streamOptions).result()
        : await completeSimple(model!, context, streamOptions);
      return response as { responseModel?: string; model: string; stopReason?: string; errorMessage?: string };
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }

  it("ignores transport keepalive placeholder chunks when capturing response identity", async () => {
    const response = await streamIdentityProbe([
      "{\"id\":\"chatcmpl-ka\",\"object\":\"chat.completion.chunk\",\"created\":0,\"model\":\"keepalive\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"\"},\"finish_reason\":null}]}",
      "{\"id\":\"chatcmpl-ka\",\"object\":\"chat.completion.chunk\",\"model\":\"my-model\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"Hello\"},\"finish_reason\":null}]}",
      "{\"id\":\"chatcmpl-ka\",\"object\":\"chat.completion.chunk\",\"model\":\"my-model\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":1,\"completion_tokens\":1,\"total_tokens\":2}}",
    ]);
    expect(response.responseModel).toBeUndefined();
  });

  it("still surfaces a genuinely aliased backend model for the identity gate", async () => {
    const response = await streamIdentityProbe([
      "{\"id\":\"chatcmpl-alias\",\"object\":\"chat.completion.chunk\",\"model\":\"other-backend-model\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"Hello\"},\"finish_reason\":null}]}",
      "{\"id\":\"chatcmpl-alias\",\"object\":\"chat.completion.chunk\",\"model\":\"other-backend-model\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":1,\"completion_tokens\":1,\"total_tokens\":2}}",
    ]);
    expect(response.responseModel).toBe("other-backend-model");
  });

  it("RED-OMNI-STREAM-1: captures only the allowlisted final OmniRoute SSE comment pair", async () => {
    const response = await streamIdentityProbe([
      "{\"id\":\"chatcmpl-omni\",\"object\":\"chat.completion.chunk\",\"model\":\"my-model\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"Hello\"},\"finish_reason\":null}]}",
      "{\"id\":\"chatcmpl-omni\",\"object\":\"chat.completion.chunk\",\"model\":\"my-model\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":1,\"completion_tokens\":1,\"total_tokens\":2}}",
    ], "omniroute-minimax-m3-pinned", [
      "unrelated=do-not-expose",
      "x-omniroute-provider=minimax",
      "x-omniroute-model=MiniMax-M3",
    ], undefined, 0, false, true);
    expect((response as { omniRoute?: unknown }).omniRoute).toEqual({
      provider: "minimax",
      model: "MiniMax-M3",
    });
    expect(response).not.toHaveProperty("comments");
  });

  it("RED-OMNI-STREAM-2: handles malformed primary SSE plus conflicting comments without unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const response = await streamIdentityProbe(
        ["not-json"],
        "omniroute-minimax-m3-pinned",
        [
          "x-omniroute-provider=minimax",
        "x-omniroute-provider=opencode-go",
          "x-omniroute-model=MiniMax-M3",
        ],
        undefined,
        100,
        true,
        true,
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(response).toMatchObject({ stopReason: "error" });
      expect(response.errorMessage).toMatch(/JSON|Unexpected token/u);
      expect(unhandled).toEqual([]);
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
    }
  });

  it("RED-OMNI-STREAM-3: aborts an in-flight OmniRoute clone without unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    const controller = new AbortController();
    process.on("unhandledRejection", onUnhandled);
    try {
      const responsePromise = streamIdentityProbe(
        [
          "{\"id\":\"chatcmpl-abort\",\"object\":\"chat.completion.chunk\",\"model\":\"my-model\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"Hello\"},\"finish_reason\":null}]}",
        ],
        "omniroute-minimax-m3-pinned",
        ["x-omniroute-provider=minimax", "x-omniroute-model=MiniMax-M3"],
        controller.signal,
        100,
        false,
        true,
      );
      setTimeout(() => controller.abort(), 10);
      const response = await responsePromise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(response).toMatchObject({ stopReason: "aborted" });
      expect(unhandled).toEqual([]);
    } finally {
      controller.abort();
      process.removeListener("unhandledRejection", onUnhandled);
    }
  });

  it("RED-OMNI-STREAM-4: consumes receipt and provider data through one reader without cloning", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    const originalFetch = globalThis.fetch;
    const encoder = new TextEncoder();
    const clone = vi.fn(() => { throw new Error("clone must not be called"); });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(
          "data: not-json\n\n: x-omniroute-provider=minimax\n: x-omniroute-model=MiniMax-M3\n\n",
        ));
        controller.close();
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "text/event-stream" }),
      body,
      clone,
    })));
    process.on("unhandledRejection", onUnhandled);
    try {
      const response = await streamCccTerminalRouteReceipt(
        {
          provider: "arbitrary-gateway",
          id: "my-model",
          api: CCC_TERMINAL_ROUTE_RECEIPT_API,
          baseUrl: "http://127.0.0.1:65535/v1",
          headers: {},
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 16384,
        } as never,
        { messages: [{ role: "user", content: "Hi", timestamp: Date.now() }] },
        { apiKey: "CUSTOM_KEY" },
      ).result();
      expect(response.stopReason).toBe("error");
      expect(response.errorMessage).toMatch(/JSON|Unexpected token/u);
      expect(clone).not.toHaveBeenCalled();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
      process.removeListener("unhandledRejection", onUnhandled);
    }
  });

  it("uses system role when reasoning model explicitly disables developer role compat", () => {
    const params = convertMessages(
      { provider: "openai", reasoning: true, input: ["text"] } as never,
      { systemPrompt: "system instruction", messages: [] } as never,
      { supportsDeveloperRole: false } as never,
    );
    expect(params[0]?.role).toBe("system");
  });

  it("emits developer role when compat allows it on reasoning models", () => {
    const params = convertMessages(
      { provider: "openai", reasoning: true, input: ["text"] } as never,
      { systemPrompt: "system instruction", messages: [] } as never,
      { supportsDeveloperRole: true } as never,
    );
    expect(params[0]?.role).toBe("developer");
  });
});
