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
