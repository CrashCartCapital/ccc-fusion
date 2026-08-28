import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import { CliSessionStore, customProviderRegistryKey, drizzleSql as sql, resolveEffectiveAgentPermissionPolicy, type CustomProvider } from "@fusion/core";
import { registerCustomProviders } from "../custom-provider-registry.js";
import { activeSessionRegistry } from "../active-session-registry.js";
import { TaskExecutor } from "../executor.js";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../../core/src/__test-utils__/pg-test-harness.js";

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
  createAgentSession: vi.fn(),
  actualCreateAgentSession: undefined as typeof import("@earendil-works/pi-coding-agent").createAgentSession | undefined,
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

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  // The spy delegates to the real in-memory pi agent loop by default. Individual
  // identity-error tests may still install a one-shot synthetic session.
  harness.actualCreateAgentSession = actual.createAgentSession;
  harness.createAgentSession.mockImplementation(actual.createAgentSession);
  const inertTool = (name: string) => ({
    name,
    label: name,
    description: `Inert ${name} fixture`,
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    execute: vi.fn(async () => ({
      content: [{ type: "text", text: "inert fixture" }],
      details: {},
    })),
  });

  return {
    ...actual,
    createAgentSession: harness.createAgentSession,
    createBashTool: () => inertTool("bash"),
    createCodingTools: () => [],
    createEditTool: () => inertTool("edit"),
    createFindTool: () => inertTool("find"),
    createGrepTool: () => inertTool("grep"),
    createLsTool: () => inertTool("ls"),
    createReadOnlyTools: () => [],
    createReadTool: () => inertTool("read"),
    createWriteTool: () => inertTool("write"),
    DefaultResourceLoader: class {
      private readonly extensions = {
        extensions: [],
        errors: [],
        runtime: actual.createExtensionRuntime(),
      };

      async reload() {}
      getExtensions() { return this.extensions; }
      getSkills() { return { skills: [], diagnostics: [] }; }
      getPrompts() { return { prompts: [], diagnostics: [] }; }
      getThemes() { return { themes: [], diagnostics: [] }; }
      getAgentsFiles() { return { agentsFiles: [] }; }
      getSystemPrompt() { return undefined; }
      getAppendSystemPrompt() { return []; }
      extendResources() {}
    },
    DefaultPackageManager: class {
      async resolve() {
        return { extensions: [] };
      }
    },
    discoverAndLoadExtensions: async () => ({
      extensions: [],
      errors: [],
      runtime: actual.createExtensionRuntime(),
    }),
  };
});

type ProviderConfig = {
  baseUrl: string;
  api: string;
  apiKey?: string;
  streamSimple?: typeof streamSimple;
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
  readonly runtimeOptions: Record<string, unknown>[] = [];
  readonly modelRuntime = {
    getAuth: vi.fn(async () => ({ auth: { headers: {} } })),
    hasConfiguredAuth: vi.fn(() => true),
    refresh: vi.fn(async () => undefined),
    stream: vi.fn(),
    streamSimple: vi.fn((
      model: Model,
      context: Context,
      options: Record<string, unknown> = {},
    ) => {
      this.runtimeOptions.push(options);
      const providerStream = this.configs.get(model.provider)?.streamSimple ?? streamSimple;
      return providerStream(model, context, {
        ...options,
        apiKey: "synthetic-loopback-only",
        maxRetries: 0,
      });
    }),
  };

  registerProvider(name: string, config: ProviderConfig): void {
    this.configs.set(name, {
      ...config,
      models: structuredClone(config.models),
      ...(config.streamSimple ? { streamSimple: config.streamSimple } : {}),
    });
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
  method: string;
  path: string;
  body: Record<string, unknown>;
  responseModel: string;
}

const wave3OrdinaryProviderArgumentChunks = ["{\"value\":\"loop", "back\"}"] as const;

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

function makeCccExecutorStore(
  task: Record<string, any>,
  provider: string,
  modelId: string,
  asyncLayer: unknown,
  profile = "ccc-fusion",
) {
  return {
    on: vi.fn(),
    getAsyncLayer: () => asyncLayer,
    setPluginWorkflowStepTemplates: vi.fn(),
    getFusionDir: () => task.worktree,
    getSettings: vi.fn(async () => ({
      profile,
      subscriptionReady: true,
      executionProvider: provider,
      executionModelId: modelId,
      defaultProvider: provider,
      defaultModelId: modelId,
      groupOverlappingFiles: false,
      autoMerge: false,
      experimentalFeatures: {},
    })),
    getTask: vi.fn(async () => task),
    listTasks: vi.fn(async () => [task]),
    parseStepsFromPrompt: vi.fn(async () => []),
    updateTask: vi.fn(async (_id: string, patch: Record<string, unknown>) => Object.assign(task, patch)),
    moveTask: vi.fn(async (_id: string, column: string) => Object.assign(task, { column })),
    logEntry: vi.fn(async () => undefined),
    appendAgentLog: vi.fn(async () => undefined),
    recordActivity: vi.fn(async () => undefined),
    recordRunAuditEvent: vi.fn(async () => undefined),
    emitUsageEvent: vi.fn(async () => undefined),
    getTaskVerificationRequestAsync: vi.fn(async () => null),
    listWorkflowDefinitions: vi.fn(async () => []),
    getWorkflowDefinition: vi.fn(async () => undefined),
    getWorkflowSelection: vi.fn(async () => undefined),
    getTaskWorkflowSelection: vi.fn(async () => undefined),
    listTraits: vi.fn(async () => []),
    listGoals: vi.fn(async () => []),
    listMessages: vi.fn(async () => []),
  };
}

function noDispatchSession() {
  return {
    model: undefined,
    messages: [],
    state: {},
    prompt: vi.fn(async () => {}),
    subscribe: vi.fn(() => vi.fn()),
    dispose: vi.fn(),
    setThinkingLevel: vi.fn(),
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function offeredToolScope(body: Record<string, unknown>): Array<{ authority: string; parametersSha256: string }> {
  return (Array.isArray(body.tools) ? body.tools : [])
    .filter((tool): tool is Record<string, unknown> => Boolean(tool) && typeof tool === "object")
    .map((tool) => tool.function as Record<string, unknown>)
    .filter((fn): fn is Record<string, unknown> => Boolean(fn) && typeof fn.name === "string")
    .map((fn) => ({
      authority: String(fn.name),
      parametersSha256: createHash("sha256").update(canonicalJson(fn.parameters)).digest("hex"),
    }))
    .sort((left, right) => left.authority.localeCompare(right.authority));
}

async function createDisposableGitTaskFixture(prefix: string, branch: string): Promise<{ rootDir: string; worktreePath: string }> {
  const rootDir = await mkdtemp(join(tmpdir(), prefix));
  execFileSync("git", ["init", "-b", "main"], { cwd: rootDir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "CCC RED"], { cwd: rootDir });
  execFileSync("git", ["config", "user.email", "ccc-red@example.invalid"], { cwd: rootDir });
  await writeFile(join(rootDir, "README.md"), "ccc durable receipt fixture\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: rootDir });
  execFileSync("git", ["commit", "-m", "fixture"], { cwd: rootDir, stdio: "ignore" });
  const worktreePath = join(rootDir, ".worktrees", "task");
  execFileSync("git", ["worktree", "add", "-b", branch, worktreePath], { cwd: rootDir, stdio: "ignore" });
  return { rootDir, worktreePath };
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
  let durableEffectCallSequence: number;
  let incrementalRelease: Deferred;
  let incrementalFirstChunk: Deferred;
  let abortClosed: Deferred;
  let transientRequestCount: number;
  const sockets = new Set<Socket>();
  const durableRestartPg: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_ccc_executor_restart",
  });

  beforeAll(async () => {
    server = createServer(async (request, response) => {
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "unexpected Wave 2 fixture endpoint" }));
        return;
      }
      const body = await readJsonBody(request);
      const reportedModel = String(body.model);
      const model = reportedModel.startsWith("__fusion_ccc_response_probe__")
        ? reportedModel.slice("__fusion_ccc_response_probe__".length)
        : reportedModel;
      capturedRequests.push({
        method: request.method,
        path: request.url,
        body,
        responseModel: reportedModel,
      });
      if (userText(body).includes("CCC_TRANSIENT_RETRY")) {
        transientRequestCount += 1;
        if (transientRequestCount === 1) {
          response.writeHead(503, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { message: "synthetic permanent failure" } }));
          return;
        }
      }
      const isOmniRouteRequest = reportedModel === "minimax/MiniMax-M3";
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        ...(isOmniRouteRequest
          ? {
              "x-omniroute-provider": "minimax",
              "x-omniroute-model": "MiniMax-M3",
            }
          : {}),
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

      if (userText(body).includes("CCC_DURABLE_EFFECT")) {
        durableEffectCallSequence += 1;
        writeSse(response, startChunk(model, {
          role: "assistant",
          tool_calls: [{
            index: 0,
            id: `call-durable-effect-${durableEffectCallSequence}`,
            type: "function",
            function: {
              name: "write_durable_effect",
              // Production providers own the transport call id, not Fusion's
              // durable effect identity. The registered tool schema therefore
              // contains only its ordinary public arguments.
              arguments: '{"value":"loop',
            },
          }],
        }));
        writeSse(response, startChunk(model, {
          tool_calls: [{
            index: 0,
            function: { arguments: 'back"}' },
          }],
        }, "tool_calls"));
        finishSse(response);
        return;
      }

      if (userText(body).includes("CCC_WAVE3_ORDINARY_RESTART")) {
        durableEffectCallSequence += 1;
        writeSse(response, startChunk(model, { role: "assistant", tool_calls: [{
          index: 0, id: `call-wave3-ordinary-${durableEffectCallSequence}`, type: "function",
          function: { name: "write_ordinary_effect", arguments: wave3OrdinaryProviderArgumentChunks[0] },
        }] }));
        writeSse(response, startChunk(model, { tool_calls: [{ index: 0, function: { arguments: wave3OrdinaryProviderArgumentChunks[1] } }] }, "tool_calls"));
        finishSse(response);
        return;
      }

      if (userText(body).includes("CCC_EXECUTOR_RECEIPT")) {
        writeSse(response, startChunk(model, {
          role: "assistant",
          tool_calls: [{
            index: 0,
            id: "call-ccc-executor-receipt",
            type: "function",
            function: {
              name: "fn_workflow_list",
              arguments: '{"__fusion_effect":{"key":"executor-receipt-list"}}',
            },
          }],
        }, "tool_calls"));
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
      if (isOmniRouteRequest) {
        response.end(": x-omniroute-provider=minimax\n: x-omniroute-model=MiniMax-M3\ndata: [DONE]\n\n");
      } else {
        finishSse(response);
      }
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
    baseUrl = `http://127.0.0.1:${address.port}/v1`;
    assertLoopbackTarget(baseUrl);
  });

  afterAll(async () => {
    incrementalRelease?.resolve();
    server.closeAllConnections?.();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  });

  beforeEach(async () => {
    capturedRequests = [];
    durableEffectCallSequence = 0;
    incrementalRelease = deferred();
    incrementalFirstChunk = deferred();
    abortClosed = deferred();
    transientRequestCount = 0;
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
    harness.createAgentSession.mockReset();
    harness.createAgentSession.mockImplementation(harness.actualCreateAgentSession!);
  });

  pgDescribe("CCC durable executor receipt restart", () => {
    beforeAll(durableRestartPg.beforeAll);
    beforeEach(durableRestartPg.beforeEach);
    afterEach(durableRestartPg.afterEach);
    afterAll(durableRestartPg.afterAll);

    it("executes a committed PI ToolDefinition once across a real controller restart and provider call-id drift", async () => {
      const projectId = "ccc-pi-effect-boundary-project";
      const taskId = "FN-CCC-PI-EFFECT-BOUNDARY";
      const firstStore = await CliSessionStore.create(durableRestartPg.layer(), projectId);
      const receiptSession = firstStore.createSession({
        projectId,
        adapterId: "pi",
        purpose: "execute",
        taskId,
        worktreePath: "/tmp/ccc-pi-effect-boundary",
        autonomyPosture: { cccFusionProfile: "ccc-fusion", cccEffectReceiptContract: "ccc-tool-receipts/v2" },
        agentState: "busy",
      });
      const effectScope = receiptSession.id;
      await firstStore.flush();

      const observedProviderCallIds: string[] = [];
      const effect = vi.fn(async (toolCallId: string, args: Record<string, unknown>) => {
        observedProviderCallIds.push(toolCallId);
        expect(args).toEqual({ value: "loopback" });
        return { content: [{ type: "text" as const, text: "committed loopback effect" }] };
      });
      const customTool = {
        name: "write_durable_effect",
        label: "Write durable effect",
        description: "Effectful loopback fixture for the production PI tool boundary",
        parameters: {
          type: "object",
          properties: {
            value: { type: "string" },
          },
          required: ["value"],
          additionalProperties: false,
        },
        execute: effect,
      } as unknown as ToolDefinition;
      const provider = providers[0]!;
      const model = registeredModel(provider);
      const registryKey = customProviderRegistryKey(provider, providers);
      const { createFnAgent } = await import("../pi.js");
      const createController = (store: CliSessionStore, controllerToken: string) => createFnAgent({
        cwd: "/tmp/ccc-pi-effect-boundary",
        systemPrompt: "real loopback durable PI tool effect",
        tools: "coding",
        customTools: [customTool],
        defaultProvider: registryKey,
        defaultModelId: model.id,
        profile: "ccc-fusion",
        subscriptionReady: true,
        cccEffectReceiptStore: store,
        cccEffectReceiptSessionId: effectScope,
        cccEffectReceiptControllerToken: controllerToken,
      });

      const closeFailure = vi.spyOn(firstStore, "closeCccEffectTurn").mockRejectedValueOnce(new Error("simulated controller crash after commit"));
      const first = await createController(firstStore, "controller-one");
      try {
        await expect((first.session as unknown as { promptWithFallback(value: string): Promise<void> })
          .promptWithFallback("CCC_TOOL_LOOP CCC_DURABLE_EFFECT"))
          .rejects.toThrow("simulated controller crash after commit");
        expect(capturedRequests).toHaveLength(2);
        expect(capturedRequests[1]!.body.messages).toContainEqual(expect.objectContaining({
          role: "tool",
          tool_call_id: "call-durable-effect-1",
          content: "committed loopback effect",
        }));
        await expect(durableRestartPg.layer().db.execute(sql`
          SELECT state, result_json FROM project.ccc_effect_receipts
          WHERE owner_project_id = ${projectId} AND effect_scope_id = ${effectScope}
        `)).resolves.toEqual([{ state: "committed", result_json: '{"content":[{"text":"committed loopback effect","type":"text"}]}' }]);
      } finally {
        await first.session.dispose();
        closeFailure.mockRestore();
      }

      firstStore.updateSession(effectScope, {
        agentState: "dead",
        terminationReason: "engineDeath",
        autonomyPosture: {
          cccFusionProfile: "ccc-fusion",
          cccControllerGeneration: "controller-one",
          cccControllerFenced: true,
        },
      });
      await firstStore.flush();

      const restartedStore = await CliSessionStore.create(durableRestartPg.layer(), projectId);
      registry = new TestModelRegistry();
      await registerCustomProviders(registry, providers, vi.fn());
      harness.modelRegistry = registry;
      const restarted = await createController(restartedStore, "controller-two");
      try {
        await (restarted.session as unknown as { promptWithFallback(value: string): Promise<void> })
          .promptWithFallback("CCC_TOOL_LOOP CCC_DURABLE_EFFECT");
      } finally {
        await restarted.session.dispose();
      }

      expect(effect).toHaveBeenCalledTimes(1);
      expect(observedProviderCallIds).toEqual(["call-durable-effect-1"]);
      await expect(durableRestartPg.layer().db.execute(sql`
        SELECT state, result_json FROM project.ccc_effect_receipts
        WHERE owner_project_id = ${projectId} AND effect_scope_id = ${effectScope}
      `)).resolves.toEqual([{ state: "committed", result_json: '{"content":[{"text":"committed loopback effect","type":"text"}]}' }]);
      // Each controller makes one initial prompt request and one tool-result
      // continuation. The second tool call has a new provider call ID but is
      // served from the committed receipt without invoking the handler again.
      expect(capturedRequests.filter(({ body }) => userText(body).includes("CCC_DURABLE_EFFECT"))).toHaveLength(4);

    });

    it("replays an ordinary ToolDefinition result across a controller restart without suppressing the same action in a new durable turn", async () => {
      const projectId = "ccc-wave3-ordinary-tooldefinition-project";
      const taskId = "FN-CCC-WAVE3-ORDINARY-TOOLDEFINITION";
      const firstStore = await CliSessionStore.create(durableRestartPg.layer(), projectId);
      const firstTurn = firstStore.createSession({ projectId, adapterId: "pi", purpose: "execute", taskId, worktreePath: "/tmp/ccc-wave3-ordinary-tooldefinition", autonomyPosture: { cccFusionProfile: "ccc-fusion", cccEffectReceiptContract: "ccc-tool-receipts/v2" }, agentState: "busy" });
      await firstStore.flush();
      const publicParameters = { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false };
      const structuredResult = { effect: { status: "committed", value: "loopback" } };
      const structuredResultText = JSON.stringify(structuredResult);
      const effect = vi.fn(async (_toolCallId: string, args: Record<string, unknown>) => {
        expect(args).toEqual({ value: "loopback" });
        return { content: [{ type: "text" as const, text: structuredResultText }], details: structuredResult };
      });
      const customTool = { name: "write_ordinary_effect", label: "Write ordinary effect", description: "Ordinary public-schema loopback effect for the production PI tool boundary", parameters: publicParameters, execute: effect } as unknown as ToolDefinition;
      const provider = providers[0]!;
      const model = registeredModel(provider);
      const registryKey = customProviderRegistryKey(provider, providers);
      const { createFnAgent } = await import("../pi.js");
      const createController = (store: CliSessionStore, turnId: string, controllerToken: string, keepTurnOpen: boolean) => createFnAgent({
        cwd: "/tmp/ccc-wave3-ordinary-tooldefinition", systemPrompt: "real loopback ordinary PI tool effect", tools: "coding", customTools: [customTool],
        defaultProvider: registryKey, defaultModelId: model.id, profile: "ccc-fusion", subscriptionReady: true,
        cccEffectReceiptStore: store, cccEffectReceiptSessionId: turnId, cccEffectReceiptControllerToken: controllerToken, cccEffectReceiptKeepTurnOpen: keepTurnOpen,
      });
      const first = await createController(firstStore, firstTurn.id, "controller-one", true);
      try { await (first.session as unknown as { promptWithFallback(value: string): Promise<void> }).promptWithFallback("CCC_WAVE3_ORDINARY_RESTART"); }
      finally { await first.session.dispose(); }
      expect(publicParameters).toEqual({ type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false });
      expect(JSON.parse(wave3OrdinaryProviderArgumentChunks.join(""))).toEqual({ value: "loopback" });
      expect(capturedRequests[0]!.body.tools).toContainEqual(expect.objectContaining({ type: "function", function: expect.objectContaining({ name: "write_ordinary_effect", parameters: publicParameters }) }));
      expect(effect).toHaveBeenCalledTimes(1);
      expect(capturedRequests.at(-1)!.body.messages).toContainEqual(expect.objectContaining({ role: "tool", tool_call_id: "call-wave3-ordinary-1", content: structuredResultText }));
      firstStore.updateSession(firstTurn.id, { agentState: "dead", terminationReason: "engineDeath", autonomyPosture: { cccFusionProfile: "ccc-fusion", cccControllerGeneration: "controller-one", cccControllerFenced: true } });
      await firstStore.flush();
      const restartedStore = await CliSessionStore.create(durableRestartPg.layer(), projectId);
      registry = new TestModelRegistry(); await registerCustomProviders(registry, providers, vi.fn()); harness.modelRegistry = registry;
      const restarted = await createController(restartedStore, firstTurn.id, "controller-two", false);
      try { await (restarted.session as unknown as { promptWithFallback(value: string): Promise<void> }).promptWithFallback("CCC_WAVE3_ORDINARY_RESTART"); }
      finally { await restarted.session.dispose(); }
      expect(effect).toHaveBeenCalledTimes(1);
      expect(capturedRequests.at(-1)!.body.messages).toContainEqual(expect.objectContaining({ role: "tool", tool_call_id: "call-wave3-ordinary-2", content: structuredResultText }));
      const newTurn = restartedStore.createSession({ projectId, adapterId: "pi", purpose: "execute", taskId, worktreePath: "/tmp/ccc-wave3-ordinary-tooldefinition", autonomyPosture: { cccFusionProfile: "ccc-fusion", cccEffectReceiptContract: "ccc-tool-receipts/v2" }, agentState: "busy" });
      await restartedStore.flush();
      const next = await createController(restartedStore, newTurn.id, "controller-three", false);
      try { await (next.session as unknown as { promptWithFallback(value: string): Promise<void> }).promptWithFallback("CCC_WAVE3_ORDINARY_RESTART"); }
      finally { await next.session.dispose(); }
      expect(effect).toHaveBeenCalledTimes(2);
      expect(capturedRequests.at(-1)!.body.messages).toContainEqual(expect.objectContaining({ role: "tool", tool_call_id: "call-wave3-ordinary-3", content: structuredResultText }));
    });

    it("reuses the exact durable receipt ledger after a production executor restart", async () => {
      const provider = providers[0]!;
      const model = registeredModel(provider);
      const providerKey = customProviderRegistryKey(provider, providers);
      const worktreePath = await mkdtemp(join(tmpdir(), "ccc-executor-restart-"));
      const taskId = "FN-CCC-RESTART-RECEIPT";
      const task = {
        id: taskId,
        title: "CCC executor durable receipt restart",
        description: "CCC_EXECUTOR_RECEIPT",
        prompt: "CCC_EXECUTOR_RECEIPT",
        column: "in-progress",
        status: "in-progress",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        worktree: worktreePath,
        branch: "fusion/ccc-executor-restart",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      let originalEffects = 0;
      const firstRuntimeStore = await CliSessionStore.create(durableRestartPg.layer(), "ccc-executor-restart-project");
      const run = async (
        durableStore: CliSessionStore,
        runProvider = provider,
        runModel = model,
        runWorktreePath = worktreePath,
        profile = "ccc-fusion",
      ) => {
        const runProviderKey = customProviderRegistryKey(runProvider, providers);
        const taskStore = makeCccExecutorStore(
          task,
          runProviderKey,
          runModel.id,
          durableRestartPg.layer(),
          profile,
        );
        const originalUpdateTask = taskStore.updateTask;
        const originalListWorkflowDefinitions = taskStore.listWorkflowDefinitions;
        taskStore.updateTask = vi.fn(async (id: string, patch: Record<string, unknown>) => {
          return originalUpdateTask(id, patch);
        });
        taskStore.listWorkflowDefinitions = vi.fn(async () => {
          originalEffects += 1;
          return originalListWorkflowDefinitions();
        });
        const executor = new TaskExecutor(taskStore as any, runWorktreePath, {
          cliAgentRuntime: {
            store: durableStore,
            projectId: "ccc-executor-restart-project",
            manager: {} as any,
            hub: {} as any,
            registry: {} as any,
            hookEndpointUrl: "http://127.0.0.1:1/unused",
          },
        });
        (executor as any).workspaceConfig = { repos: ["fixture"] };
        await (executor as any).runImplementation(task, () => undefined);
      };

      try {
        await run(firstRuntimeStore);
        await firstRuntimeStore.flush();
        const firstLedger = firstRuntimeStore.listByTask(taskId);
        expect(firstLedger).toHaveLength(1);
        expect(firstLedger[0]).toMatchObject({
          adapterId: "pi",
          worktreePath,
          autonomyPosture: {
            cccFusionProfile: "ccc-fusion",
            cccFusionProvider: providerKey,
            cccFusionModel: model.id,
            cccEffectReceiptContract: "ccc-tool-receipts/v2",
          },
        });

        const restartedRuntimeStore = await CliSessionStore.create(durableRestartPg.layer(), "ccc-executor-restart-project");
        registry = new TestModelRegistry();
        await registerCustomProviders(registry, providers, vi.fn());
        harness.modelRegistry = registry;
        Object.assign(task, {
          column: "in-progress",
          status: "in-progress",
          worktree: worktreePath,
          branch: "fusion/ccc-executor-restart",
        });
        await run(restartedRuntimeStore);
        await restartedRuntimeStore.flush();

        expect(originalEffects).toBe(1);
        expect(restartedRuntimeStore.listByTask(taskId)).toHaveLength(1);

        const mismatchedProvider = providers[1]!;
        const mismatchedModel = registeredModel(mismatchedProvider);
        const mismatchedWorktreePath = await mkdtemp(join(tmpdir(), "ccc-executor-restart-mismatch-"));
        let ledgerIdsBeforeProfileMismatch: string[];
        try {
          Object.assign(task, {
            column: "in-progress",
            status: "in-progress",
            worktree: mismatchedWorktreePath,
            branch: "fusion/ccc-executor-restart-mismatch",
          });
          const mismatchedRuntimeStore = await CliSessionStore.create(
            durableRestartPg.layer(),
            "ccc-executor-restart-project",
          );
          await run(mismatchedRuntimeStore, mismatchedProvider, mismatchedModel, mismatchedWorktreePath);
          await mismatchedRuntimeStore.flush();

          const ledgersAfterMismatch = mismatchedRuntimeStore.listByTask(taskId);
          expect(originalEffects).toBe(2);
          expect(ledgersAfterMismatch).toHaveLength(2);
          expect(ledgersAfterMismatch.find((ledger) => ledger.worktreePath === mismatchedWorktreePath)).toMatchObject({
            adapterId: "pi",
            worktreePath: mismatchedWorktreePath,
            autonomyPosture: {
              cccFusionProfile: "ccc-fusion",
              cccFusionProvider: customProviderRegistryKey(mismatchedProvider, providers),
              cccFusionModel: mismatchedModel.id,
              cccEffectReceiptContract: "ccc-tool-receipts/v2",
            },
          });
          ledgerIdsBeforeProfileMismatch = ledgersAfterMismatch.map((ledger) => ledger.id).sort();
        } finally {
          await rm(mismatchedWorktreePath, { recursive: true, force: true });
        }

        Object.assign(task, {
          column: "in-progress",
          status: "in-progress",
          worktree: worktreePath,
          branch: "fusion/ccc-executor-restart-profile-mismatch",
          description: "CCC_PROFILE_MISMATCH_NO_TOOL",
          prompt: "CCC_PROFILE_MISMATCH_NO_TOOL",
        });
        const nonCccRuntimeStore = await CliSessionStore.create(
          durableRestartPg.layer(),
          "ccc-executor-restart-project",
        );
        await run(nonCccRuntimeStore, provider, model, worktreePath, "predecessor-compatible-profile");
        await nonCccRuntimeStore.flush();

        expect(originalEffects).toBe(2);
        expect(nonCccRuntimeStore.listByTask(taskId).map((ledger) => ledger.id).sort())
          .toEqual(ledgerIdsBeforeProfileMismatch);
      } finally {
        await rm(worktreePath, { recursive: true, force: true });
      }
    });

    it("admits only an eligible exact CCC execution authority and preserves terminal ledgers", async () => {
      const provider = providers[0]!;
      const model = registeredModel(provider);
      const providerKey = customProviderRegistryKey(provider, providers);
      const projectDefaultPolicy = { rules: { git_write: "allow", file_scope: "allow" } };
      const actorPolicy = { presetId: "custom", rules: { git_write: "allow", file_scope: "allow" } };
      const reorderedActorPolicy = { presetId: "custom", rules: { file_scope: "allow", git_write: "allow" } };
      const normalizedActorPolicy = resolveEffectiveAgentPermissionPolicy(actorPolicy, projectDefaultPolicy);
      const normalizedPermissionMismatch = resolveEffectiveAgentPermissionPolicy(
        { presetId: "custom", rules: { file_scope: "allow", git_write: "block" } },
        projectDefaultPolicy,
      );
      const fixtures: Array<{ rootDir: string; worktreePath: string }> = [];
      type DurableRow = {
        id: string;
        agent_state: string;
        termination_reason: string | null;
        worktree_path: string | null;
        autonomy_posture: string;
        updated_at: string;
      };
      const rowsFor = async (projectId: string, taskId: string): Promise<DurableRow[]> => (
        await durableRestartPg.layer().db.execute(sql`
          SELECT id, agent_state, termination_reason, worktree_path, autonomy_posture, updated_at
          FROM project.cli_sessions
          WHERE owner_project_id = ${projectId} AND task_id = ${taskId}
          ORDER BY id
        `)
      ) as DurableRow[];
      const createCase = async (label: string) => {
        const projectId = `ccc-wave3-exact-authority-${label}`;
        const taskId = `FN-CCC-WAVE3-EXACT-AUTHORITY-${label.toUpperCase()}`;
        const branch = `fusion/ccc-wave3-exact-authority-${label}`;
        const fixture = await createDisposableGitTaskFixture(`ccc-wave3-exact-authority-${label}-`, branch);
        fixtures.push(fixture);
        const task: Record<string, any> = {
          id: taskId,
          title: `exact authority ${label}`,
          description: `CCC_EXACT_AUTHORITY_${label}`,
          prompt: `CCC_EXACT_AUTHORITY_${label}`,
          column: "in-progress",
          status: "in-progress",
          dependencies: [],
          steps: [],
          currentStep: 0,
          log: [],
          worktree: fixture.worktreePath,
          branch,
          assignedAgentId: "actor-a",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        const durable = await CliSessionStore.create(durableRestartPg.layer(), projectId);
        const runPublic = async (actorId: string, policy: Record<string, unknown> = actorPolicy) => {
          task.assignedAgentId = actorId;
          task.column = "in-progress";
          task.status = "in-progress";
          task.worktree = fixture.worktreePath;
          task.branch = branch;
          const store = makeCccExecutorStore(task, providerKey, model.id, durableRestartPg.layer()) as Record<string, any>;
          const baseSettings = store.getSettings;
          store.getSettings = async () => ({ ...(await baseSettings()), defaultAgentPermissionPolicy: projectDefaultPolicy });
          store.getTaskWorkflowSelection = () => ({ workflowId: "ccc-red", stepIds: [] });
          store.getTaskWorkflowSelectionAsync = async () => ({ workflowId: "ccc-red", stepIds: [] });
          store.getWorkflowDefinition = async () => ({ ir: { version: "v2", name: "ccc-red", columns: [{ id: "in-progress", name: "In progress", traits: [{ trait: "wip" }] }], nodes: [{ id: "start", kind: "start", column: "in-progress" }, { id: "execute", kind: "prompt", column: "in-progress", config: { seam: "execute" } }, { id: "end", kind: "end", column: "in-progress" }], edges: [{ from: "start", to: "execute" }, { from: "execute", to: "end", condition: "success" }] } });
          store.updateTaskAtomic = async (_id: string, update: (live: Record<string, unknown>) => Record<string, unknown>) => Object.assign(task, await update(task));
          const executor = new TaskExecutor(store as any, fixture.rootDir, { agentStore: { getAgent: async () => ({ id: actorId, permissionPolicy: policy }), listAgents: async () => [] } as any, cliAgentRuntime: { store: durable, projectId, manager: {} as any, hub: {} as any, registry: {} as any, hookEndpointUrl: "http://127.0.0.1:1/unused" } });
          await executor.execute(task as any).catch(() => undefined);
          await durable.flush();
        };
        return { projectId, taskId, fixture, durable, runPublic };
      };
      try {
        const exact = await createCase("exact");
        await exact.runPublic("actor-a");
        await exact.runPublic("actor-a", reorderedActorPolicy);
        const firstRequest = capturedRequests.find(({ body }) => userText(body).includes("CCC_EXACT_AUTHORITY_exact"));
        expect.soft(firstRequest, "exact authority public dispatch reached the loopback provider").toBeDefined();
        const expectedScope = offeredToolScope(firstRequest!.body);
        const exactRows = await rowsFor(exact.projectId, exact.taskId);
        expect.soft(exactRows, "exact eligible authority reuses one durable ledger").toHaveLength(1);
        expect.soft(JSON.parse(exactRows[0]!.autonomy_posture), "exact authority is durably normalized and redacted").toMatchObject({ cccExecutionAuthority: { actorId: "actor-a", permissionPolicy: normalizedActorPolicy, effectTurnMode: "keep-open", toolScope: expectedScope } });

        const makeSeed = (authority: Record<string, unknown>, terminal = false) => ({
          adapterId: "pi",
          purpose: "execute" as const,
          agentState: terminal ? "dead" as const : "busy" as const,
          ...(terminal ? { terminationReason: "killed" as const } : {}),
          autonomyPosture: {
            cccFusionProfile: "ccc-fusion",
            cccFusionProvider: providerKey,
            cccFusionModel: model.id,
            cccEffectReceiptContract: "ccc-tool-receipts/v2",
            cccExecutionAuthority: authority,
            ...(terminal ? { cccControllerFenced: true, cccCancellationState: "CANCELLED" } : {}),
          },
        });
        const assertIsolatedMismatch = async (
          label: string,
          authority: Record<string, unknown>,
          actorId: string,
          policy: Record<string, unknown>,
          terminal = false,
        ) => {
          const isolated = await createCase(label);
          const seed = isolated.durable.createSession({
            projectId: isolated.projectId,
            taskId: isolated.taskId,
            ...makeSeed(authority, terminal),
            worktreePath: isolated.fixture.worktreePath,
          });
          await isolated.durable.flush();
          const before = await rowsFor(isolated.projectId, isolated.taskId);
          expect.soft(before, `${label} has exactly one seeded candidate before public dispatch`).toHaveLength(1);
          await isolated.runPublic(actorId, policy);
          const after = await rowsFor(isolated.projectId, isolated.taskId);
          expect.soft(after.filter((row) => row.id === seed.id), `${label} preserves the sole seeded ledger byte-for-byte`).toEqual(before);
          expect.soft(after, `${label} rejects its sole seed and admits one distinct fresh ledger`).toHaveLength(2);
          expect.soft(after.some((row) => row.id !== seed.id), `${label} durable result includes a distinct fresh ledger`).toBe(true);
        };
        const exactAuthority = {
          actorId: "actor-a",
          permissionPolicy: normalizedActorPolicy,
          effectTurnMode: "keep-open",
          toolScope: expectedScope,
        };
        await assertIsolatedMismatch("actor", exactAuthority, "actor-b", actorPolicy);
        await assertIsolatedMismatch("permission", exactAuthority, "actor-a", { presetId: "custom", rules: { file_scope: "allow", git_write: "block" } });
        await assertIsolatedMismatch("tool-scope", {
          ...exactAuthority,
          toolScope: expectedScope.map((tool, index) => index === 0
            ? { ...tool, parametersSha256: "0".repeat(64) }
            : tool),
        }, "actor-a", actorPolicy);
        await assertIsolatedMismatch("terminal", exactAuthority, "actor-a", actorPolicy, true);
        expect.soft(normalizedPermissionMismatch, "permission mismatch is derived through the production effective-policy resolver").not.toEqual(normalizedActorPolicy);
      } finally {
        for (const fixture of fixtures) {
          execFileSync("git", ["worktree", "remove", "--force", fixture.worktreePath], { cwd: fixture.rootDir, stdio: "ignore" });
          await rm(fixture.rootDir, { recursive: true, force: true });
        }
      }
    });

    it("fences engine-death recovery to a fresh controller generation and ignores an old late finalizer", async () => {
      const provider = providers[0]!;
      const model = registeredModel(provider);
      const providerKey = customProviderRegistryKey(provider, providers);
      const fixtures: Array<{ rootDir: string; worktreePath: string }> = [];
      const observations: Record<string, unknown> = {};
      const failures: string[] = [];
      type DurableRow = {
        id: string;
        agent_state: string;
        termination_reason: string | null;
        worktree_path: string | null;
        autonomy_posture: string;
      };
      type DurableTurn = {
        effect_scope_id: string;
        turn_key: string;
        state: "open" | "closed";
        controller_token: string;
      };
      const graph = {
        ir: {
          version: "v2",
          name: "ccc-engine-death-red",
          columns: [{ id: "in-progress", name: "In progress", traits: [{ trait: "wip" }] }],
          nodes: [
            { id: "start", kind: "start", column: "in-progress" },
            { id: "execute", kind: "prompt", column: "in-progress", config: { seam: "execute" } },
            { id: "end", kind: "end", column: "in-progress" },
          ],
          edges: [
            { from: "start", to: "execute" },
            { from: "execute", to: "end", condition: "success" },
          ],
        },
      };
      const rowsFor = async (projectId: string, taskId: string): Promise<DurableRow[]> => (
        await durableRestartPg.layer().db.execute(sql`
          SELECT id, agent_state, termination_reason, worktree_path, autonomy_posture
          FROM project.cli_sessions
          WHERE owner_project_id = ${projectId} AND task_id = ${taskId}
          ORDER BY id
        `)
      ) as DurableRow[];
      const turnsFor = async (projectId: string, sessionId: string): Promise<DurableTurn[]> => (
        await durableRestartPg.layer().db.execute(sql`
          SELECT effect_scope_id, turn_key, state, controller_token
          FROM project.ccc_effect_turns
          WHERE owner_project_id = ${projectId} AND effect_scope_id = ${sessionId}
          ORDER BY turn_key
        `)
      ) as DurableTurn[];
      const posture = (row: DurableRow | undefined): Record<string, unknown> | undefined => (
        row ? JSON.parse(row.autonomy_posture) as Record<string, unknown> : undefined
      );
      const settle = async (promise: Promise<unknown>): Promise<{ status: "fulfilled" | "rejected"; detail?: string }> => {
        const result = await Promise.allSettled([promise]);
        const settled = result[0]!;
        return settled.status === "fulfilled"
          ? { status: "fulfilled" }
          : { status: "rejected", detail: settled.reason instanceof Error ? settled.reason.message : String(settled.reason) };
      };
      const within = async <T>(promise: Promise<T>, timeoutMs = 3_000): Promise<{ completed: boolean; value?: T }> => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            promise.then((value) => ({ completed: true, value })),
            new Promise<{ completed: false }>((resolve) => {
              timer = setTimeout(() => resolve({ completed: false }), timeoutMs);
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      };
      const observe = async (label: string, predicate: () => boolean): Promise<boolean> => {
        try {
          await vi.waitFor(() => expect(predicate()).toBe(true), { timeout: 3_000 });
          return true;
        } catch (error) {
          observations[`${label}ObservationError`] = error instanceof Error ? error.message : String(error);
          return false;
        }
      };
      const requestCount = (marker: string) => capturedRequests.filter(({ body }) => userText(body).includes(marker)).length;
      const publicCase = async (label: string) => {
        const projectId = `ccc-wave3-engine-death-${label}`;
        const taskId = `FN-CCC-WAVE3-ENGINE-DEATH-${label.toUpperCase()}`;
        const branch = `fusion/ccc-wave3-engine-death-${label}`;
        const fixture = await createDisposableGitTaskFixture(`ccc-wave3-engine-death-${label}-`, branch);
        fixtures.push(fixture);
        const task: Record<string, any> = {
          id: taskId,
          title: `CCC engine-death ${label}`,
          description: `CCC_ABORT ${label}`,
          prompt: `CCC_ABORT ${label}`,
          column: "in-progress",
          status: "in-progress",
          dependencies: [],
          steps: [],
          currentStep: 0,
          log: [],
          worktree: fixture.worktreePath,
          branch,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        const durable = await CliSessionStore.create(durableRestartPg.layer(), projectId);
        const makeExecutor = (options: Record<string, unknown> = {}) => {
          const taskStore = makeCccExecutorStore(task, providerKey, model.id, durableRestartPg.layer()) as Record<string, any>;
          taskStore.getTaskWorkflowSelection = () => ({ workflowId: "ccc-engine-death-red", stepIds: [] });
          taskStore.getTaskWorkflowSelectionAsync = async () => ({ workflowId: "ccc-engine-death-red", stepIds: [] });
          taskStore.getWorkflowDefinition = async () => graph;
          taskStore.updateTaskAtomic = async (_id: string, update: (live: Record<string, unknown>) => Record<string, unknown>) => (
            Object.assign(task, await update(task))
          );
          return new TaskExecutor(taskStore as any, fixture.rootDir, {
            cliAgentRuntime: {
              store: durable,
              projectId,
              manager: {} as any,
              hub: {} as any,
              registry: {} as any,
              hookEndpointUrl: "http://127.0.0.1:1/unused",
            },
            ...options,
          });
        };
        return { projectId, taskId, task, durable, makeExecutor };
      };
      const cleanupLiveExecutor = async (executor: TaskExecutor, taskId: string, label: string) => {
        observations[`${label}Cleanup`] = await settle(
          executor.awaitAbortInFlightTaskWork(taskId, `${label}-cleanup`, { userCanceled: true }),
        );
      };
      const seedEngineDeath = async (
        current: Awaited<ReturnType<typeof publicCase>>,
        controllerToken: string,
        fenced: boolean,
        openTurn: boolean,
      ) => {
        const seedScope = offeredToolScope(capturedRequests.find(({ body }) => userText(body).includes("CCC_ABORT confirmed-cancellation"))?.body ?? {});
        const seed = current.durable.createSession({
          projectId: current.projectId,
          taskId: current.taskId,
          adapterId: "pi",
          purpose: "execute",
          worktreePath: current.task.worktree,
          agentState: "dead",
          terminationReason: "engineDeath",
          autonomyPosture: {
            cccFusionProfile: "ccc-fusion",
            cccFusionProvider: providerKey,
            cccFusionModel: model.id,
            cccEffectReceiptContract: "ccc-tool-receipts/v2",
            cccExecutionAuthority: {
              actorId: `executor-${current.taskId}`,
              permissionPolicy: resolveEffectiveAgentPermissionPolicy(undefined, undefined),
              effectTurnMode: "keep-open",
              toolScope: seedScope,
            },
            cccControllerGeneration: controllerToken,
            cccControllerFenced: fenced,
          },
        });
        await current.durable.flush();
        if (openTurn) {
          await current.durable.openCccEffectTurn(seed.id, controllerToken);
          await current.durable.flush();
        }
        return seed;
      };

      try {
        // A: real executor admission followed by the public cancellation surface.
        const cancellation = await publicCase("confirmed-cancellation");
        const cancellationExecutor = cancellation.makeExecutor();
        const cancellationExecution = cancellationExecutor.execute(cancellation.task as any);
        const cancellationDispatched = await observe("A dispatch", () => requestCount("CCC_ABORT confirmed-cancellation") > 0);
        const cancellationResult = await settle(
          cancellationExecutor.awaitAbortInFlightTaskWork(cancellation.taskId, "confirmed-cancellation", { userCanceled: true }),
        );
        const cancellationClosed = cancellationDispatched && (await within(abortClosed.promise)).completed;
        await settle(cancellationExecution);
        await cancellation.durable.flush();
        const cancellationRows = await rowsFor(cancellation.projectId, cancellation.taskId);
        const cancellationRow = cancellationRows[0];
        const cancellationPosture = posture(cancellationRow);
        observations.A = { cancellationDispatched, cancellationClosed, cancellationResult, cancellationRows };
        if (!cancellationDispatched) failures.push("A public TaskExecutor/createFnAgent dispatch did not reach loopback");
        if (cancellationResult.status !== "fulfilled") failures.push(`A public cancellation did not confirm closure: ${cancellationResult.detail}`);
        if (cancellationRow?.agent_state !== "dead" || cancellationRow.termination_reason !== "killed") failures.push("A confirmed cancellation did not persist dead/killed");
        if (cancellationPosture?.cccCancellationState !== "CANCELLED") failures.push("A confirmed cancellation did not persist CANCELLED");
        if (cancellationPosture?.cccControllerFenced !== true) failures.push("A confirmed cancellation did not persist cccControllerFenced:true");

        // B: the sole unfenced engine-death candidate must remain untouched and unselected.
        const unfenced = await publicCase("unfenced-engine-death");
        const unfencedSeed = await seedEngineDeath(unfenced, "unfenced-old-generation", false, false);
        const unfencedBefore = await rowsFor(unfenced.projectId, unfenced.taskId);
        const unfencedExecutor = unfenced.makeExecutor();
        await unfencedExecutor.resumeOrphaned();
        const unfencedDispatched = await observe("B dispatch", () => requestCount("CCC_ABORT unfenced-engine-death") > 0);
        await unfenced.durable.flush();
        const unfencedAfterAdmission = await rowsFor(unfenced.projectId, unfenced.taskId);
        observations.B = { unfencedSeed: unfencedSeed.id, unfencedBefore, unfencedDispatched, unfencedAfterAdmission };
        if (unfencedDispatched) await cleanupLiveExecutor(unfencedExecutor, unfenced.taskId, "B");
        if (unfencedDispatched) await settle(new Promise<void>((resolve) => setTimeout(resolve, 20)));
        if (JSON.stringify(unfencedAfterAdmission) !== JSON.stringify(unfencedBefore)) failures.push("B unfenced engineDeath candidate was relabelled or reused");
        if (unfencedDispatched) failures.push("B unfenced engineDeath candidate reached public replacement admission");

        // C: the durable-turn takeover is exercised through resumeOrphaned(), not direct replacement mutation.
        const fenced = await publicCase("fenced-engine-death");
        const fencedSeed = await seedEngineDeath(fenced, "fenced-old-generation", true, true);
        const fencedBefore = await rowsFor(fenced.projectId, fenced.taskId);
        const fencedTurnsBefore = await turnsFor(fenced.projectId, fencedSeed.id);
        const fencedExecutor = fenced.makeExecutor();
        await fencedExecutor.resumeOrphaned();
        const fencedDispatched = await observe("C dispatch", () => requestCount("CCC_ABORT fenced-engine-death") > 0);
        await fenced.durable.flush();
        const fencedAfterAdmission = await rowsFor(fenced.projectId, fenced.taskId);
        const fencedTurnsAfterAdmission = await turnsFor(fenced.projectId, fencedSeed.id);
        const fencedReplacement = fencedAfterAdmission.find((row) => row.id === fencedSeed.id);
        const fencedReplacementPosture = posture(fencedReplacement);
        const fencedOpenTurn = fencedTurnsAfterAdmission.find((turn) => turn.state === "open");
        observations.C = {
          fencedBefore,
          fencedTurnsBefore,
          fencedDispatched,
          fencedAfterAdmission,
          fencedTurnsAfterAdmission,
        };
        if (!fencedDispatched) failures.push("C fenced engineDeath recovery did not reach public TaskExecutor/createFnAgent admission");
        if (!fencedReplacement || !["starting", "busy", "idle", "needsAttention"].includes(fencedReplacement.agent_state)) failures.push("C replacement is not durably nonterminal");
        if (fencedReplacementPosture?.cccControllerGeneration === "fenced-old-generation") failures.push("C fenced engineDeath recovery reused the old controller generation");
        if (fencedOpenTurn?.controller_token !== fencedReplacementPosture?.cccControllerGeneration) failures.push("C open durable turn is not owned by the replacement controller generation");
        if (fencedDispatched) await cleanupLiveExecutor(fencedExecutor, fenced.taskId, "C");
        if (fencedDispatched) await settle(new Promise<void>((resolve) => setTimeout(resolve, 20)));

        // D: delay only the real PI session's owned-transport-close barrier. The old raw abort itself remains real.
        const late = await publicCase("late-finalizer");
        const releaseOldClosure = deferred();
        const oldClosureEntered = deferred();
        const oldClosureReleased = deferred();
        harness.createAgentSession.mockImplementationOnce(async (...args: any[]) => {
          const created = await harness.actualCreateAgentSession!(...args);
          const rawSession = created.session as typeof created.session & { abort?: () => Promise<void> };
          const rawAbort = rawSession.abort?.bind(rawSession);
          if (!rawAbort) throw new Error("real third-party PI AgentSession did not expose abort()");
          rawSession.abort = async () => {
            await rawAbort();
            oldClosureEntered.resolve();
            await releaseOldClosure.promise;
            oldClosureReleased.resolve();
          };
          return created;
        });
        const oldExecutor = late.makeExecutor({ cancellationTimeoutMs: 40 });
        const oldExecution = oldExecutor.execute(late.task as any);
        const oldDispatched = await observe("D old dispatch", () => requestCount("CCC_ABORT late-finalizer") === 1);
        const oldCancellation = await settle(
          oldExecutor.awaitAbortInFlightTaskWork(late.taskId, "late-finalizer", { userCanceled: true }),
        );
        const oldClosureReached = await within(oldClosureEntered.promise);
        await settle(oldExecution);
        await late.durable.flush();
        const beforeReplacement = await rowsFor(late.projectId, late.taskId);
        const oldRow = beforeReplacement[0];
        const seededEngineDeath = oldRow && late.durable.updateSession(oldRow.id, {
          agentState: "dead",
          terminationReason: "engineDeath",
          autonomyPosture: {
            ...(posture(oldRow) ?? {}),
            cccControllerFenced: true,
          },
        });
        await late.durable.flush();
        const engineDeathSeedBeforeReplacement = await rowsFor(late.projectId, late.taskId);
        const oldGeneration = posture(engineDeathSeedBeforeReplacement[0])?.cccControllerGeneration;
        const engineDeathSeedTurns = seededEngineDeath
          ? await turnsFor(late.projectId, seededEngineDeath.id)
          : [];
        const replacementExecutor = late.makeExecutor();
        await replacementExecutor.resumeOrphaned();
        const replacementDispatched = await observe("D replacement dispatch", () => requestCount("CCC_ABORT late-finalizer") >= 2);
        await late.durable.flush();
        const replacementBeforeRelease = await rowsFor(late.projectId, late.taskId);
        const replacementRow = replacementBeforeRelease[0];
        const replacementGeneration = posture(replacementRow)?.cccControllerGeneration;
        const replacementTurnsBeforeRelease = replacementRow ? await turnsFor(late.projectId, replacementRow.id) : [];
        releaseOldClosure.resolve();
        const oldClosureFinished = await within(oldClosureReleased.promise);
        await settle(new Promise<void>((resolve) => setTimeout(resolve, 20)));
        await late.durable.flush();
        const replacementAfterRelease = await rowsFor(late.projectId, late.taskId);
        const replacementAfterReleaseRow = replacementAfterRelease[0];
        const replacementTurnsAfterRelease = replacementAfterReleaseRow
          ? await turnsFor(late.projectId, replacementAfterReleaseRow.id)
          : [];
        observations.D = {
          oldDispatched,
          oldCancellation,
          oldClosureReached,
          beforeReplacement,
          engineDeathSeedBeforeReplacement,
          engineDeathSeedTurns,
          replacementDispatched,
          replacementBeforeRelease,
          replacementTurnsBeforeRelease,
          oldClosureFinished,
          replacementAfterRelease,
          replacementTurnsAfterRelease,
        };
        if (!oldDispatched) failures.push("D old controller did not reach the real loopback PI session");
        if (oldCancellation.status !== "rejected") failures.push("D delayed owned transport closure did not exercise the public cancellation timeout race");
        if (!oldClosureReached.completed || !oldClosureFinished.completed) failures.push("D bounded old owned-transport closure seam did not complete");
        if (!seededEngineDeath || engineDeathSeedBeforeReplacement[0]?.agent_state !== "dead" || posture(engineDeathSeedBeforeReplacement[0])?.cccControllerFenced !== true) failures.push("D allowed engineDeath/fenced restart precondition was not durably seeded");
        if (!replacementDispatched) failures.push("D public resumeOrphaned did not admit a replacement after old execution unwound");
        if (replacementGeneration === oldGeneration) failures.push("D replacement reused the old controller generation");
        if (!replacementAfterReleaseRow || !["starting", "busy", "idle", "needsAttention"].includes(replacementAfterReleaseRow.agent_state)) failures.push("D old late finalizer terminalized or deleted the replacement");
        const replacementOpenTurn = replacementTurnsAfterRelease.find((turn) => turn.state === "open");
        if (replacementOpenTurn?.controller_token !== replacementGeneration) failures.push("D old late finalizer released replacement durable-turn ownership");
        if (replacementDispatched) await cleanupLiveExecutor(replacementExecutor, late.taskId, "D");
        if (replacementDispatched) await settle(new Promise<void>((resolve) => setTimeout(resolve, 20)));

        expect.soft(
          failures,
          `CCC engine-death RED durable observations: ${JSON.stringify(observations)}`,
        ).toEqual([]);
      } finally {
        for (const fixture of fixtures) {
          execFileSync("git", ["worktree", "remove", "--force", fixture.worktreePath], { cwd: fixture.rootDir, stdio: "ignore" });
          await rm(fixture.rootDir, { recursive: true, force: true });
        }
      }
    }, 30_000);

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

  it("createFnAgent executes one registered read-only custom tool and continues with its structured result", async () => {
    const provider = providers[0]!;
    const model = registeredModel(provider);
    const structuredResult = {
      session: { id: "session-wave2" },
      effect: { id: "effect-777" },
      record: {
        selector: { kind: "summary" },
        status: "observed",
        revision: 3,
      },
    };
    let actualToolResult: unknown;
    const execute = vi.fn(async (
      _toolCallId: string,
      args: {
        sessionId: string;
        effectId: string;
        query: { kind: "summary" };
      },
    ) => {
      expect(args).toEqual({
        sessionId: "session-wave2",
        effectId: "effect-777",
        query: { kind: "summary" },
      });
      actualToolResult = {
        content: [{ type: "text" as const, text: JSON.stringify(structuredResult) }],
        details: { structuredContent: structuredResult },
      };
      return actualToolResult;
    });
    const customTool = {
      name: "read_session_effect",
      label: "Read session effect",
      description: "Read one synthetic in-memory session/effect record",
      parameters: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          effectId: { type: "string" },
          query: {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["summary"] },
            },
            required: ["kind"],
            additionalProperties: false,
          },
        },
        required: ["sessionId", "effectId", "query"],
        additionalProperties: false,
      },
      execute,
    } as unknown as ToolDefinition;

    const registryKey = customProviderRegistryKey(provider, providers);
    const { createFnAgent } = await import("../pi.js");
    const result = await createFnAgent({
      cwd: "/tmp/ccc-wave2-readonly",
      systemPrompt: "synthetic loopback and in-memory read-only tool only",
      tools: "coding",
      customTools: [customTool],
      defaultProvider: registryKey,
      defaultModelId: model.id,
      profile: "ccc-fusion",
      subscriptionReady: true,
    });
    const prompt = (result.session as unknown as {
      promptWithFallback: (value: string) => Promise<void>;
    }).promptWithFallback;
    await prompt("CCC_TOOL_LOOP");

    const completedAssistant = [...result.session.messages].reverse().find(
      (message) => message.role === "assistant",
    ) as AssistantMessage | undefined;
    expect(completedAssistant?.model).toBe(model.id);
    expect(completedAssistant?.responseModel).toBe(model.id);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(actualToolResult).toEqual({
      content: [{ type: "text", text: JSON.stringify(structuredResult) }],
      details: { structuredContent: structuredResult },
    });
    expect(capturedRequests).toHaveLength(2);
    expect(capturedRequests.map(({ method, path }) => ({ method, path }))).toEqual([
      { method: "POST", path: "/v1/chat/completions" },
      { method: "POST", path: "/v1/chat/completions" },
    ]);

    const continuationBody = capturedRequests[1]!.body;
    const wireMessages = continuationBody.messages as Array<Record<string, unknown>>;
    expect(wireMessages).toContainEqual(expect.objectContaining({
      role: "tool",
      tool_call_id: "call-wave2-read",
      content: JSON.stringify(structuredResult),
    }));
    expect(wireMessages.filter((message) => message.role === "user")).toEqual([
      expect.objectContaining({
        role: "user",
        content: [{ type: "text", text: "CCC_TOOL_LOOP" }],
      }),
    ]);
    expect(JSON.stringify(
      wireMessages.filter((message) => message.role !== "tool"),
    )).not.toContain(JSON.stringify(structuredResult));
  });

  /*
  FNXC:CCCFusionCancellation 2026-07-23-19:28:
  This drives the real TaskExecutor cancellation seam and the real PI
  AgentSession against the fixture's intentionally open SSE response. The
  fixture only observes its own socket; it does not abort or close the stream.
  */
  it("orders TaskExecutor custom-provider cancellation after loopback stream closure and durable flush", async () => {
    const provider = providers[0]!;
    const model = registeredModel(provider);
    const lifecycle: string[] = [];
    const sessionId = "ccc-executor-cancel-session";
    const durableSessions = new Map<string, any>([[sessionId, {
      id: sessionId,
      agentState: "busy",
      terminationReason: null,
      autonomyPosture: { cccFusionProfile: "ccc-fusion" },
    }]]);
    const durableStore = {
      getSession: (id: string) => durableSessions.get(id),
      updateSession: vi.fn((id: string, updates: Record<string, unknown>) => {
        lifecycle.push("persist");
        const current = durableSessions.get(id);
        if (!current) return undefined;
        Object.assign(current, updates);
        return current;
      }),
      flush: vi.fn(async () => {
        lifecycle.push("flush");
      }),
    };
    const registryKey = customProviderRegistryKey(provider, providers);
    const { createFnAgent } = await import("../pi.js");
    const created = await createFnAgent({
      cwd: "/tmp/ccc-wave2-executor-cancel",
      systemPrompt: "synthetic loopback cancellation only",
      tools: "coding",
      defaultProvider: registryKey,
      defaultModelId: model.id,
      profile: "ccc-fusion",
      subscriptionReady: true,
    });
    const session = created.session as unknown as {
      abort: () => Promise<void>;
      dispose: () => void;
      promptWithFallback: (value: string) => Promise<void>;
    };
    const actualAbort = session.abort.bind(session);
    session.abort = vi.fn(async () => {
      lifecycle.push("agent-abort");
      await actualAbort();
    });
    const prompt = session.promptWithFallback("CCC_ABORT").catch(() => undefined);
    await vi.waitFor(() => expect(capturedRequests).toHaveLength(1));
    const observedClose = abortClosed.promise.then(() => lifecycle.push("loopback-closed"));

    const taskId = "FN-CCC-LOOPBACK-CANCEL";
    const worktreePath = "/tmp/ccc-wave2-executor-cancel";
    const executor = new TaskExecutor({ on: vi.fn() } as any, "/tmp/ccc-wave2-root");
    const internals = executor as unknown as {
      activeWorktrees: Map<string, Set<string>>;
      setActiveSession(task: string, state: unknown, path: string): void;
    };
    internals.activeWorktrees.set(taskId, new Set([worktreePath]));
    internals.setActiveSession(taskId, {
      session,
      seenSteeringIds: new Set<string>(),
      lastResolvedModelProvider: "custom-provider-pi",
      cccDurableSession: { store: durableStore, sessionId },
    }, worktreePath);

    lifecycle.push("task-cancel");
    await executor.awaitAbortInFlightTaskWork(taskId, "user cancellation", { userCanceled: true });
    await observedClose;
    lifecycle.push("acknowledged");
    await prompt;

    expect(lifecycle).toEqual([
      "task-cancel",
      "agent-abort",
      "loopback-closed",
      "persist",
      "flush",
      "acknowledged",
    ]);
    expect(durableSessions.get(sessionId)).toMatchObject({
      agentState: "dead",
      terminationReason: "killed",
      autonomyPosture: { cccCancellationState: "CANCELLED" },
    });
    expect(activeSessionRegistry.lookupByPath(worktreePath)).toBeNull();
    expect(internals.activeWorktrees.has(taskId)).toBe(false);
  });

  it("finalizes a timed-out TaskExecutor cancellation only after the real loopback transport closes", async () => {
    const provider = providers[0]!;
    const model = registeredModel(provider);
    const sessionId = "ccc-executor-late-close-session";
    const durableSessions = new Map<string, any>([[sessionId, {
      id: sessionId,
      agentState: "busy",
      terminationReason: null,
      autonomyPosture: { cccFusionProfile: "ccc-fusion" },
    }]]);
    const durableStore = {
      getSession: (id: string) => durableSessions.get(id),
      updateSession: vi.fn((id: string, updates: Record<string, unknown>) => {
        const current = durableSessions.get(id);
        if (!current) return undefined;
        Object.assign(current, updates);
        return current;
      }),
      flush: vi.fn(async () => undefined),
    };
    const registryKey = customProviderRegistryKey(provider, providers);
    const { createFnAgent } = await import("../pi.js");
    const created = await createFnAgent({
      cwd: "/tmp/ccc-wave2-executor-late-close",
      systemPrompt: "synthetic loopback late cancellation only",
      tools: "coding",
      defaultProvider: registryKey,
      defaultModelId: model.id,
      profile: "ccc-fusion",
      subscriptionReady: true,
    });
    const session = created.session as unknown as {
      abort: () => Promise<void>;
      dispose: () => void;
      promptWithFallback: (value: string) => Promise<void>;
    };
    const actualAbort = session.abort.bind(session);
    const releaseAbort = deferred();
    session.abort = vi.fn(async () => {
      await releaseAbort.promise;
      await actualAbort();
    });
    const prompt = session.promptWithFallback("CCC_ABORT").catch(() => undefined);
    await vi.waitFor(() => expect(capturedRequests).toHaveLength(1));

    const taskId = "FN-CCC-LOOPBACK-LATE-CLOSE";
    const worktreePath = "/tmp/ccc-wave2-executor-late-close";
    const executor = new TaskExecutor({ on: vi.fn() } as any, "/tmp/ccc-wave2-root", { cancellationTimeoutMs: 15 });
    const internals = executor as unknown as {
      activeWorktrees: Map<string, Set<string>>;
      activeSessions: Map<string, { session: unknown }>;
      setActiveSession(task: string, state: unknown, path: string): void;
    };
    internals.activeWorktrees.set(taskId, new Set([worktreePath]));
    internals.setActiveSession(taskId, {
      session,
      seenSteeringIds: new Set<string>(),
      lastResolvedModelProvider: "custom-provider-pi",
      cccDurableSession: { store: durableStore, sessionId },
    }, worktreePath);

    await expect(executor.awaitAbortInFlightTaskWork(taskId, "user cancellation", { userCanceled: true }))
      .rejects.toMatchObject({ code: "TASK_CANCELLATION_TIMEOUT" });
    await expect(executor.awaitAbortInFlightTaskWork(taskId, "user cancellation", { userCanceled: true }))
      .rejects.toMatchObject({ code: "TASK_CANCELLATION_TIMEOUT" });
    expect(session.abort).toHaveBeenCalledOnce();
    expect(internals.activeSessions.get(taskId)?.session).toBe(session);

    releaseAbort.resolve();
    await abortClosed.promise;
    await vi.waitFor(() => expect(durableSessions.get(sessionId)).toMatchObject({
      agentState: "dead",
      terminationReason: "killed",
      autonomyPosture: { cccCancellationState: "CANCELLED" },
    }));
    await prompt;

    expect(durableStore.flush).toHaveBeenCalledTimes(2);
    expect(internals.activeSessions.has(taskId)).toBe(false);
    expect(internals.activeWorktrees.has(taskId)).toBe(false);
    expect(activeSessionRegistry.lookupByPath(worktreePath)).toBeNull();
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

  it("GREEN-RECEIPT-PI-1: explicit adapter binds the terminal SSE receipt for a neutrally named provider", async () => {
    const omniProvider: CustomProvider = {
      id: "route-receipt-gateway-pinned",
      name: "Route Receipt Gateway Pinned",
      apiType: "openai-compatible",
      baseUrl,
      apiKey: "synthetic-loopback-only",
      models: [{ id: "minimax/MiniMax-M3", name: "MiniMax M3" }],
    };
    providers = [omniProvider];
    registry = new TestModelRegistry();
    await registerCustomProviders(registry, providers, vi.fn());
    harness.customProviders = providers;
    harness.modelRegistry = registry;
    harness.createAgentSession.mockReset();
    harness.createAgentSession.mockImplementation(harness.actualCreateAgentSession!);

    const model = registeredModel(omniProvider);
    const registryKey = customProviderRegistryKey(omniProvider, providers);
    const authorityBinding = Object.freeze({
      projectId: "project-receipt",
      importId: "import-receipt",
      campaignId: "campaign-receipt",
      taskId: "TASK-RECEIPT",
      actionId: "ACTION-RECEIPT",
      actionTarget: "provider://receipt",
      idempotencyKey: "receipt-idempotency",
      packetHash: "a".repeat(64),
      sidecarHash: "b".repeat(64),
      bundleHash: "c".repeat(64),
      targetRepository: "/tmp/ccc-omniroute-receipt",
      targetBase: "d".repeat(40),
      providerId: registryKey,
      modelId: model.id,
      transport: "pi" as const,
      manifestHash: "e".repeat(64),
      bindingHash: "f".repeat(64),
    });
    const controller = Object.freeze({
      preDispatch: vi.fn(async (request) => ({
        kind: "dispatch-permit" as const,
        scope: {
          attemptKey: `ccc-provider-attempt-${"1".repeat(64)}`,
          controllerToken: "ccc-provider-controller-00000000-0000-4000-8000-000000000001",
          taskId: authorityBinding.taskId,
          semanticTaskId: "SEMANTIC-RECEIPT",
          campaignDeadlineAt: "2026-08-27T00:00:00.000Z",
          turnKey: request.turnKey,
          dispatchKey: request.dispatchKey,
          attemptOrdinal: 1,
          requestCount: 1,
          workItemFence: null,
          state: "dispatched_unknown" as const,
          binding: authorityBinding,
        },
      })),
      reconcile: vi.fn(async (reconciliation) => ({
        ...reconciliation,
        state: "committed" as const,
        terminal: {
          kind: "reconciled" as const,
          state: "committed" as const,
          evidenceDigest: reconciliation.evidenceDigest,
          observerId: reconciliation.observerId,
          effectiveRoute: reconciliation.effectiveRoute,
        },
      })),
    });
    const { createFnAgent } = await import("../pi.js");
    const created = await createFnAgent({
      cwd: "/tmp/ccc-omniroute-receipt",
      systemPrompt: "synthetic OmniRoute loopback only",
      tools: "readonly",
      defaultProvider: registryKey,
      defaultModelId: model.id,
      profile: "ccc-fusion",
      subscriptionReady: true,
      cccProviderAttemptBinding: Object.freeze({
        turnKey: "turn-receipt-1",
        controller,
        receiptAdapterId: "terminal-route-sse-comments.v1",
      }),
    });

    await expect((created.session as unknown as { promptWithFallback(value: string): Promise<void> })
      .promptWithFallback("CCC_OMNI_ROUTE_RECEIPT"))
      .resolves.toBeUndefined();
    const assistant = [...((created.session as unknown as { messages?: unknown[] }).messages ?? [])]
      .reverse()
      .find((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object" && entry.role === "assistant");
    expect(assistant?.omniRoute).toEqual({ provider: "minimax", model: "MiniMax-M3" });
    expect(assistant).not.toHaveProperty("responseModel");
    expect(registry.runtimeOptions[0]).toMatchObject({ maxRetries: 0 });
    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests.at(-1)?.body.model).toBe("minimax/MiniMax-M3");
    expect(controller.reconcile).toHaveBeenCalledWith(expect.objectContaining({
      effectiveRoute: expect.objectContaining({
        effectiveProvider: registryKey,
        effectiveModel: "minimax/MiniMax-M3",
        omniRoute: {
          final: { provider: "minimax", model: "MiniMax-M3" },
        },
      }),
    }));
  });

  it("RED-CCC-RETRY-1: disables agent lifecycle retries for a ccc transient provider failure", async () => {
    const provider = providers[0]!;
    const model = registeredModel(provider);
    const registryKey = customProviderRegistryKey(provider, providers);
    const { createFnAgent } = await import("../pi.js");
    const created = await createFnAgent({
      cwd: "/tmp/ccc-retry-boundary",
      systemPrompt: "synthetic loopback only",
      tools: "readonly",
      defaultProvider: registryKey,
      defaultModelId: model.id,
      profile: "ccc-fusion",
      subscriptionReady: true,
    });

    await expect((created.session as unknown as { promptWithFallback(value: string): Promise<void> })
      .promptWithFallback("CCC_TRANSIENT_RETRY")).rejects.toThrow();
    expect(transientRequestCount).toBe(1);
    expect(capturedRequests).toHaveLength(1);
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

  it.each([
    { label: "missing", reportedModel: undefined },
    { label: "empty", reportedModel: "" },
  ])("refuses a ccc successful turn with a $label reported response model", async ({ reportedModel }) => {
    const provider = providers[0]!;
    const model = registeredModel(provider);
    const sessionMessages: AssistantMessage[] = [];
    const session = {
      model,
      messages: sessionMessages,
      state: {},
      prompt: vi.fn(async () => {
        sessionMessages.push({
          role: "assistant",
          content: [{ type: "text", text: "unproven response identity" }],
          provider: model.provider,
          model: model.id,
          ...(reportedModel === undefined ? {} : { responseModel: reportedModel }),
          stopReason: "stop",
          timestamp: Date.now(),
        } as unknown as AssistantMessage);
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

    await expect(prompt("CCC_RESPONSE_MODEL_UNPROVEN")).rejects.toThrow(
      `ccc-fusion response model identity missing: configured ${registryKey}/${model.id}`,
    );
    expect(capturedRequests).toHaveLength(0);
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

  it("RED-CCC-FALLBACK-1: refuses missing primary before opening a configured fallback session", async () => {
    const fallback = providers[0]!;
    const fallbackModel = registeredModel(fallback);
    const fallbackKey = customProviderRegistryKey(fallback, providers);
    const { createFnAgent } = await import("../pi.js");

    await expect(createFnAgent({
      cwd: "/tmp/ccc-primary-required",
      systemPrompt: "must fail before fallback session creation",
      tools: "readonly",
      defaultProvider: "pi-claude-cli",
      defaultModelId: "missing-primary-model",
      fallbackProvider: fallbackKey,
      fallbackModelId: fallbackModel.id,
      profile: "ccc-fusion",
      subscriptionReady: true,
    })).rejects.toThrow(
      "Configured model pi-claude-cli/missing-primary-model (primary selection) was not found in the pi model registry",
    );
    expect(harness.createAgentSession).not.toHaveBeenCalled();
    expect(capturedRequests).toHaveLength(0);
  });

  it.each([
    { label: "https", baseUrl: "https://127.0.0.1:7443/v1" },
    { label: "hostname alias", baseUrl: "http://localhost:7443/v1" },
    { label: "IPv6", baseUrl: "http://[::1]:7443/v1" },
    { label: "userinfo", baseUrl: "http://synthetic-user:synthetic-password@127.0.0.1:7443/v1" },
    { label: "query", baseUrl: "http://127.0.0.1:7443/v1?route=unsafe" },
    { label: "hash", baseUrl: "http://127.0.0.1:7443/v1#unsafe" },
    { label: "zero port", baseUrl: "http://127.0.0.1:0/v1" },
    { label: "missing port", baseUrl: "http://127.0.0.1/v1" },
    { label: "missing path", baseUrl: "http://127.0.0.1:7443/" },
  ])("createFnAgent refuses a ccc custom-provider $label base URL before registration, session, or request", async ({ baseUrl: unsafeBaseUrl }) => {
    const unsafeProvider: CustomProvider = {
      id: "ccc-provider-unsafe-egress",
      name: "CCC Unsafe Egress",
      apiType: "openai-compatible",
      baseUrl: unsafeBaseUrl,
      apiKey: "synthetic-never-read",
      models: [{ id: "unsafe-model-exact", name: "Unsafe Exact" }],
    };
    const unsafeRegistry = new TestModelRegistry();
    harness.customProviders = [unsafeProvider];
    harness.modelRegistry = unsafeRegistry;
    harness.createAgentSession.mockResolvedValue({ session: noDispatchSession() });
    const registryKey = customProviderRegistryKey(unsafeProvider, [unsafeProvider]);
    const { createFnAgent } = await import("../pi.js");

    let failure: unknown;
    try {
      await createFnAgent({
        cwd: "/tmp/ccc-wave2-readonly",
        systemPrompt: "must fail before any provider or session effect",
        tools: "readonly",
        defaultProvider: registryKey,
        defaultModelId: "unsafe-model-exact",
        profile: "ccc-fusion",
        subscriptionReady: true,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: "CCC_CUSTOM_PROVIDER_EGRESS_POLICY_VIOLATION",
    });

    const observableFailure = failure instanceof Error ? failure.message : JSON.stringify(failure);
    expect(observableFailure).not.toContain(unsafeBaseUrl);
    expect(observableFailure).not.toContain("synthetic-password");
    expect(observableFailure).not.toContain("synthetic-never-read");
    expect(unsafeRegistry.configs.size).toBe(0);
    expect(harness.createAgentSession).not.toHaveBeenCalled();
    expect(capturedRequests).toHaveLength(0);
  });

  it("preserves ordinary custom-provider base URL behavior without dispatching a request", async () => {
    const ordinaryProvider: CustomProvider = {
      id: "ordinary-provider-remote-shape",
      name: "Ordinary Remote Shape",
      apiType: "openai-compatible",
      baseUrl: "https://ordinary.example.invalid/v1",
      apiKey: "synthetic-never-read",
      models: [{ id: "ordinary-model-exact", name: "Ordinary Exact" }],
    };
    const ordinaryRegistry = new TestModelRegistry();
    harness.customProviders = [ordinaryProvider];
    harness.modelRegistry = ordinaryRegistry;
    harness.createAgentSession.mockResolvedValue({ session: noDispatchSession() });
    const registryKey = customProviderRegistryKey(ordinaryProvider, [ordinaryProvider]);
    const { createFnAgent } = await import("../pi.js");

    const result = await createFnAgent({
      cwd: "/tmp/ccc-wave2-readonly",
      systemPrompt: "ordinary profile registration only",
      tools: "readonly",
      defaultProvider: registryKey,
      defaultModelId: "ordinary-model-exact",
    });
    await result.session.dispose();

    expect(ordinaryRegistry.configs.get(registryKey)?.baseUrl).toBe(ordinaryProvider.baseUrl);
    expect(harness.createAgentSession).toHaveBeenCalledTimes(1);
    expect(capturedRequests).toHaveLength(0);
  });
});
