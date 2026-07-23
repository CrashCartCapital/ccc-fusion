import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import { customProviderRegistryKey, type CustomProvider } from "@fusion/core";
import { registerCustomProviders } from "../custom-provider-registry.js";

/*
FNXC:CCCTransport 2026-07-23-15:45:
Wave 2 proves the ccc OmniRoute-style custom-provider path with a real ephemeral
127.0.0.1 HTTP/SSE server. The fixture records exact request models, emits
incremental text and structured tool-call fragments, accepts a typed tool-result
continuation, and holds an abortable response open. No fetch mock, provider
credential, live service, external network, filesystem tool, shell tool, or Git
tool participates.
*/

const harness = vi.hoisted(() => ({
  customProviders: [] as CustomProvider[],
  modelRegistry: undefined as TestModelRegistry | undefined,
  createAgentSession: vi.fn(async () => ({
    session: {
      prompt: vi.fn(),
      subscribe: vi.fn(() => vi.fn()),
      dispose: vi.fn(),
      setThinkingLevel: vi.fn(),
    },
  })),
}));

vi.mock("@fusion/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@fusion/core")>();
  return {
    ...actual,
    getEnabledPiExtensionPaths: () => [],
    getFusionAgentDir: () => "/tmp/ccc-wave2-fusion-agent",
    getLegacyPiAgentDir: () => "/tmp/ccc-wave2-legacy-agent",
    getProjectRootFromWorktree: () => null,
    reconcileClaudeCliPaths: (paths: string[]) => paths,
    reconcileDroidCliPaths: (paths: string[]) => paths,
    mergeBuiltInGrokProviderModels: vi.fn(),
    mergeBuiltInZaiProviderModels: vi.fn(),
    mergeSupplementalAnthropicModels: vi.fn(),
    mergeSupplementalOpenAiCodexModels: vi.fn(),
    registerBuiltInGrokProvider: vi.fn(),
    registerBuiltInZaiProvider: vi.fn(),
    resolvePiExtensionProjectRoot: (cwd: string) => cwd,
  };
});

vi.mock("../auth-storage.js", () => ({
  createFusionAuthStorage: () => ({}),
  createFusionModelRegistry: async () => harness.modelRegistry,
}));

vi.mock("../custom-providers.js", () => ({
  readCustomProviders: () => harness.customProviders,
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  createAgentSession: harness.createAgentSession,
  createBashTool: () => ({ name: "bash", execute: vi.fn() }),
  createCodingTools: () => [],
  createEditTool: () => ({ name: "edit", execute: vi.fn() }),
  createExtensionRuntime: vi.fn(),
  createFindTool: () => ({ name: "find", execute: vi.fn() }),
  createGrepTool: () => ({ name: "grep", execute: vi.fn() }),
  createLsTool: () => ({ name: "ls", execute: vi.fn() }),
  createReadOnlyTools: () => [],
  createReadTool: () => ({ name: "read", execute: vi.fn() }),
  createWriteTool: () => ({ name: "write", execute: vi.fn() }),
  DefaultResourceLoader: class {
    async reload() {}
  },
  DefaultPackageManager: class {
    async resolve() {
      return { extensions: [] };
    }
  },
  discoverAndLoadExtensions: async () => ({
    errors: [],
    runtime: { pendingProviderRegistrations: [] },
  }),
  ModelRegistry: class {},
  ModelRuntime: class {},
  SessionManager: {
    inMemory: () => ({}),
  },
  SettingsManager: {
    inMemory: () => ({}),
  },
}));

type ProviderConfig = {
  baseUrl: string;
  api: string;
  apiKey?: string;
  models: Array<{
    id: string;
    name: string;
    reasoning: boolean;
    input: ("text" | "image")[];
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
    contextWindow: number;
    maxTokens: number;
    compat?: Record<string, unknown>;
  }>;
};

class TestModelRegistry {
  readonly configs = new Map<string, ProviderConfig>();
  readonly modelRuntime = {
    getAuth: vi.fn(async () => ({ auth: { headers: {} } })),
    refresh: vi.fn(async () => undefined),
    stream: vi.fn(),
    streamSimple: vi.fn(),
  };

  registerProvider(name: string, config: ProviderConfig): void {
    this.configs.set(name, structuredClone(config));
  }

  async refresh(): Promise<void> {}

  getAll(): Model[] {
    return [...this.configs.entries()].flatMap(([provider, config]) =>
      config.models.map((model) => ({
        ...model,
        provider,
        api: config.api,
        baseUrl: config.baseUrl,
      } as Model)));
  }

  find(provider: string, modelId: string): Model | undefined {
    return this.getAll().find((model) => model.provider === provider && model.id === modelId);
  }
}

interface CapturedRequest {
  body: Record<string, unknown>;
  responseModel: string;
}

interface Deferred<T = void> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function assertLoopbackTarget(raw: string): URL {
  const url = new URL(raw);
  if (
    url.protocol !== "http:"
    || url.hostname !== "127.0.0.1"
    || url.port.length === 0
  ) {
    throw new Error(`Wave 2 egress guard rejected non-loopback target: ${url.origin}`);
  }
  return url;
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function writeSse(response: ServerResponse, payload: unknown): void {
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function finishSse(response: ServerResponse): void {
  response.end("data: [DONE]\n\n");
}

function userText(body: Record<string, unknown>): string {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  return messages
    .filter((message): message is Record<string, unknown> => Boolean(message) && typeof message === "object")
    .filter((message) => message.role === "user")
    .map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content))
    .join("\n");
}

function hasToolResult(body: Record<string, unknown>): boolean {
  return (Array.isArray(body.messages) ? body.messages : []).some(
    (message) => Boolean(message) && typeof message === "object" && (message as Record<string, unknown>).role === "tool",
  );
}

function startChunk(model: string, delta: Record<string, unknown>, finishReason: string | null = null) {
  return {
    id: `chatcmpl-${model}`,
    object: "chat.completion.chunk",
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

describe("ccc OmniRoute-style custom-provider transport", () => {
  let server: ReturnType<typeof createServer>;
  let baseUrl: string;
  let providers: CustomProvider[];
  let registry: TestModelRegistry;
  let capturedRequests: CapturedRequest[];
  let incrementalRelease: Deferred;
  let incrementalFirstChunk: Deferred;
  let abortClosed: Deferred;

  beforeAll(async () => {
    server = createServer(async (request, response) => {
      const body = await readJsonBody(request);
      const model = String(body.model);
      capturedRequests.push({ body, responseModel: model });
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });

      if (userText(body).includes("CCC_INCREMENTAL")) {
        writeSse(response, startChunk(model, { role: "assistant", content: "first-" }));
        incrementalFirstChunk.resolve();
        await incrementalRelease.promise;
        writeSse(response, startChunk(model, { content: "second" }));
        writeSse(response, startChunk(model, {}, "stop"));
        finishSse(response);
        return;
      }

      if (userText(body).includes("CCC_ABORT")) {
        response.once("close", () => abortClosed.resolve());
        writeSse(response, startChunk(model, { role: "assistant", content: "before-abort" }));
        return;
      }

      if (userText(body).includes("CCC_RESPONSE_MODEL_MISMATCH")) {
        const responseModel = "wire-alias-not-configured";
        capturedRequests.at(-1)!.responseModel = responseModel;
        writeSse(response, startChunk(responseModel, {
          role: "assistant",
          content: "mismatched-response-model",
        }));
        writeSse(response, startChunk(responseModel, {}, "stop"));
        finishSse(response);
        return;
      }

      if (hasToolResult(body)) {
        writeSse(response, startChunk(model, { role: "assistant", content: "continued-after-tool" }));
        writeSse(response, startChunk(model, {}, "stop"));
        finishSse(response);
        return;
      }

      if (userText(body).includes("CCC_TOOL_LOOP")) {
        writeSse(response, startChunk(model, {
          role: "assistant",
          tool_calls: [{
            index: 0,
            id: "call-wave2-read",
            type: "function",
            function: {
              name: "read_session_effect",
              arguments: "{\"sessionId\":\"session-",
            },
          }],
        }));
        writeSse(response, startChunk(model, {
          tool_calls: [{
            index: 0,
            function: {
              arguments: "wave2\",\"effectId\":\"effect-777\",\"query\":{\"kind\":\"summary\"}}",
            },
          }],
        }, "tool_calls"));
        finishSse(response);
        return;
      }

      writeSse(response, startChunk(model, { role: "assistant", content: `identity:${model}` }));
      writeSse(response, startChunk(model, {}, "stop"));
      finishSse(response);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}/v1`;
    assertLoopbackTarget(baseUrl);
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  });

  beforeEach(async () => {
    capturedRequests = [];
    incrementalRelease = deferred();
    incrementalFirstChunk = deferred();
    abortClosed = deferred();
    registry = new TestModelRegistry();
    providers = [
      {
        id: "ccc-provider-01-needle",
        name: "CCC North Needle",
        apiType: "openai-compatible",
        baseUrl,
        apiKey: "synthetic-loopback-only",
        models: [{ id: "route/alpha-7b-exact", name: "Alpha Exact" }],
      },
      {
        id: "9f3d7a22-ccc-south-orbit",
        name: "CCC South Orbit",
        apiType: "openai-compatible",
        baseUrl,
        apiKey: "synthetic-loopback-only",
        models: [{ id: "vendor.beta:model-Z9", name: "Beta Exact" }],
      },
    ];
    await registerCustomProviders(registry, providers, vi.fn());
    harness.customProviders = providers;
    harness.modelRegistry = registry;
    harness.createAgentSession.mockClear();
  });

  function registeredModel(provider: CustomProvider): Model {
    const registryKey = customProviderRegistryKey(provider, providers);
    const model = registry.find(registryKey, provider.models![0]!.id);
    expect(model).toBeDefined();
    expect(model?.baseUrl).toBe(baseUrl);
    return model!;
  }

  async function collect(
    model: Model,
    context: Context,
    options: { signal?: AbortSignal } = {},
    onEvent?: (event: AssistantMessageEvent) => void,
  ): Promise<{ events: AssistantMessageEvent[]; result: AssistantMessage }> {
    const events: AssistantMessageEvent[] = [];
    const stream = streamSimple(model, context, {
      apiKey: "synthetic-loopback-only",
      maxRetries: 0,
      ...options,
    });
    for await (const event of stream) {
      events.push(event);
      onEvent?.(event);
    }
    return { events, result: await stream.result() };
  }

  it("observes the first SSE text delta before the server releases the second chunk", async () => {
    const model = registeredModel(providers[0]!);
    const firstDeltaObserved = deferred();
    const run = collect(
      model,
      {
        messages: [{ role: "user", content: "CCC_INCREMENTAL", timestamp: Date.now() }],
      },
      {},
      (event) => {
        if (event.type === "text_delta" && event.delta === "first-") {
          firstDeltaObserved.resolve();
        }
      },
    );

    await incrementalFirstChunk.promise;
    await firstDeltaObserved.promise;
    expect(capturedRequests).toHaveLength(1);
    incrementalRelease.resolve();

    const { events, result } = await run;
    expect(events.filter((event) => event.type === "text_delta")).toMatchObject([
      { type: "text_delta", delta: "first-" },
      { type: "text_delta", delta: "second" },
    ]);
    expect(result.content).toEqual([{ type: "text", text: "first-second" }]);
  });

  it("preserves structured tool-call deltas and continues with a typed tool result", async () => {
    const model = registeredModel(providers[0]!);
    const initialContext: Context = {
      messages: [{ role: "user", content: "CCC_TOOL_LOOP", timestamp: Date.now() }],
      tools: [{
        name: "read_session_effect",
        description: "Read one in-memory session/effect record",
        parameters: {
          type: "object",
          properties: {
            sessionId: { type: "string" },
            effectId: { type: "string" },
            query: {
              type: "object",
              properties: { kind: { type: "string", enum: ["summary"] } },
              required: ["kind"],
              additionalProperties: false,
            },
          },
          required: ["sessionId", "effectId", "query"],
          additionalProperties: false,
        } as never,
      }],
    };

    const first = await collect(model, initialContext);
    const toolCallDeltas = first.events.filter((event) => event.type === "toolcall_delta");
    const toolCallEnd = first.events.find((event) => event.type === "toolcall_end");
    expect(toolCallDeltas).toMatchObject([
      { type: "toolcall_delta", delta: "{\"sessionId\":\"session-" },
      { type: "toolcall_delta", delta: "wave2\",\"effectId\":\"effect-777\",\"query\":{\"kind\":\"summary\"}}" },
    ]);
    expect(toolCallEnd).toMatchObject({
      type: "toolcall_end",
      toolCall: {
        id: "call-wave2-read",
        name: "read_session_effect",
        arguments: {
          sessionId: "session-wave2",
          effectId: "effect-777",
          query: { kind: "summary" },
        },
      },
    });
    expect(first.result.stopReason).toBe("toolUse");

    const structuredResult = {
      sessionId: "session-wave2",
      effectId: "effect-777",
      record: { status: "observed", revision: 3 },
    };
    const toolResult: ToolResultMessage = {
      role: "toolResult",
      toolCallId: "call-wave2-read",
      toolName: "read_session_effect",
      content: [{ type: "text", text: JSON.stringify(structuredResult) }],
      details: { structuredContent: structuredResult },
      isError: false,
      timestamp: Date.now(),
    };
    const continuation = await collect(model, {
      ...initialContext,
      messages: [...initialContext.messages, first.result, toolResult],
    });

    expect(continuation.result.content).toEqual([
      { type: "text", text: "continued-after-tool" },
    ]);
    const continuationBody = capturedRequests.at(-1)!.body;
    const wireMessages = continuationBody.messages as Array<Record<string, unknown>>;
    expect(wireMessages).toContainEqual(expect.objectContaining({
      role: "tool",
      tool_call_id: "call-wave2-read",
      content: JSON.stringify(structuredResult),
    }));
    expect(wireMessages.filter((message) => message.role === "user")).toHaveLength(1);
  });

  it("keeps both dissimilar configured model IDs exact on request and response wires", async () => {
    for (const provider of providers) {
      const model = registeredModel(provider);
      const result = await collect(model, {
        messages: [{ role: "user", content: `CCC_IDENTITY:${model.id}`, timestamp: Date.now() }],
      });
      const captured = capturedRequests.at(-1)!;
      expect(captured.body.model).toBe(model.id);
      expect(captured.responseModel).toBe(model.id);
      expect(result.result.model).toBe(model.id);
      expect(result.result.responseModel).toBeUndefined();
      expect(result.result.content).toEqual([{ type: "text", text: `identity:${model.id}` }]);
    }

    expect(capturedRequests.map(({ body }) => body.model)).toEqual([
      "route/alpha-7b-exact",
      "vendor.beta:model-Z9",
    ]);
  });

  it("refuses a ccc response model that differs from the configured request model", async () => {
    const provider = providers[0]!;
    const model = registeredModel(provider);
    const sessionMessages: AssistantMessage[] = [];
    const session = {
      model,
      messages: sessionMessages,
      state: {},
      prompt: vi.fn(async () => {
        const response = await collect(model, {
          messages: [{
            role: "user",
            content: "CCC_RESPONSE_MODEL_MISMATCH",
            timestamp: Date.now(),
          }],
        });
        sessionMessages.push(response.result);
      }),
      subscribe: vi.fn(() => vi.fn()),
      dispose: vi.fn(),
      setThinkingLevel: vi.fn(),
    };
    harness.createAgentSession.mockResolvedValueOnce({ session });

    const registryKey = customProviderRegistryKey(provider, providers);
    const { createFnAgent } = await import("../pi.js");
    const result = await createFnAgent({
      cwd: "/tmp/ccc-wave2-readonly",
      systemPrompt: "synthetic loopback only",
      tools: "readonly",
      defaultProvider: registryKey,
      defaultModelId: model.id,
      profile: "ccc-fusion",
      subscriptionReady: true,
    });
    const prompt = (result.session as unknown as {
      promptWithFallback: (value: string) => Promise<void>;
    }).promptWithFallback;

    await expect(prompt("CCC_RESPONSE_MODEL_MISMATCH")).rejects.toThrow(
      `ccc-fusion response model mismatch: configured ${registryKey}/${model.id}, provider reported wire-alias-not-configured`,
    );
    expect(capturedRequests).toEqual([
      expect.objectContaining({
        body: expect.objectContaining({ model: model.id }),
        responseModel: "wire-alias-not-configured",
      }),
    ]);
  });

  it("returns an aborted stream result and closes the held loopback request", async () => {
    const model = registeredModel(providers[1]!);
    const controller = new AbortController();
    const firstDeltaObserved = deferred();
    const run = collect(
      model,
      {
        messages: [{ role: "user", content: "CCC_ABORT", timestamp: Date.now() }],
      },
      { signal: controller.signal },
      (event) => {
        if (event.type === "text_delta") firstDeltaObserved.resolve();
      },
    );

    await firstDeltaObserved.promise;
    controller.abort();
    const { events, result } = await run;
    await abortClosed.promise;

    expect(events.at(-1)).toMatchObject({ type: "error", reason: "aborted" });
    expect(result.stopReason).toBe("aborted");
  });

  it("refuses non-loopback egress and alias or mismatched ccc model IDs", async () => {
    expect(() => assertLoopbackTarget("https://example.invalid/v1")).toThrow(
      "Wave 2 egress guard rejected non-loopback target",
    );

    const registryKey = customProviderRegistryKey(providers[0]!, providers);
    const { createFnAgent } = await import("../pi.js");
    await expect(createFnAgent({
      cwd: "/tmp/ccc-wave2-readonly",
      systemPrompt: "synthetic loopback only",
      tools: "readonly",
      defaultProvider: registryKey,
      defaultModelId: "alpha-7b-alias",
      profile: "ccc-fusion",
      subscriptionReady: true,
    })).rejects.toThrow(
      `Configured model ${registryKey}/alpha-7b-alias (primary selection) was not found in the pi model registry`,
    );
    expect(harness.createAgentSession).not.toHaveBeenCalled();
    expect(capturedRequests).toHaveLength(0);
  });
});
