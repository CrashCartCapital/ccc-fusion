import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentSession, ModelRuntime, type AgentSession } from "@earendil-works/pi-coding-agent";
import {
  canonicalCccPrdJson,
  CCC_PLANNING_DENIED_NAMES,
  CCC_PLANNING_LINKED_WRITER_TOOLSET,
  CCC_PLANNING_TOOLSETS,
  type CccPlanningCallScope,
  type CccPlanningRouteBinding,
  type CccProviderAttemptScope,
  type CccProviderAttemptScopeView,
  type CustomProvider,
} from "@fusion/core";
import { CCC_PROVIDER_ATTEMPT_ROUTE_MARKER, createFnAgent, CccProviderRouteReceiptError } from "../pi.js";
import { createCccPlanningProviderAttemptBinding } from "../ccc-planning/provider-binding.js";
import { CCC_TERMINAL_ROUTE_RECEIPT_API, streamCccTerminalRouteReceipt } from "../ccc-route-receipt-adapter.js";
import type { CccConfinement, CccProviderAttemptBinding, CccSessionToolPolicy } from "../agent-runtime.js";

/*
FNXC:CccPlanningProviderSeam 2026-10-14-14:20:
Card P1 proof for the planning-scope settlement rule (CONTRACT-v3 section 2.12, D10, verify-v2 item 42, errata E2-1). In planning and planning-linked-writer scope a missing or mismatched terminal route receipt settles the attempt exactly once as proved_failed, with the refusal evidence and no effective route, and then throws out of the slot loop, so a later stream on the same session never reaches a second slot. A provider error event also settles proved_failed, but a retry may take the next slot. Campaign scope keeps today's behaviour (pi.test.ts stays unchanged). The fixture is pi.test.ts's bound-agent fixture with the receipt adapter selected, which D48 makes mandatory for planning.
*/
/*
FNXC:CccPlanningProviderSeam 2026-10-14-17:22:
Repair 1 (errata E5-P1). The refused slot is remembered before the settlement is awaited, so a lost reconcile response cannot let a later stream move past it (item 1). The receipt adapter's own abort shape stays dispatched_unknown (item 2). The real adapter, driven over a loopback SSE server this file owns on port 0, marks a terminal-receipt failure as a route refusal (settled once, keys [pi-stream:1], one upstream request), a lost connection or adapter timeout as a transport failure (never settled, re-entry holds), and an upstream HTTP error as neither, which settles provider-error-event and lets a retry take pi-stream:2 (item 4); a provider error keeps an observed receipt in its evidence (item 10). A planning controller's scope under a session binding without the planning scopeKind is refused before any provider call (item 7). Linked writers run on campaign-shaped scopes (card BF), so their fixture uses a campaign authority binding.
*/

vi.mock("../skill-resolver.js", () => ({
  resolveSessionSkills: vi.fn(),
  createSkillsOverrideFromSelection: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  LegacyCredentialStorage: { create: vi.fn(() => ({ getCredentials: vi.fn().mockResolvedValue({}) })) },
  createAgentSession: vi.fn(),
  createCodingTools: vi.fn(() => []),
  createReadOnlyTools: vi.fn(() => []),
  createReadTool: vi.fn(() => ({ name: "read" })),
  createBashTool: vi.fn(() => ({ name: "bash" })),
  createEditTool: vi.fn(() => ({ name: "edit" })),
  createWriteTool: vi.fn(() => ({ name: "write" })),
  createGrepTool: vi.fn(() => ({ name: "grep" })),
  createFindTool: vi.fn(() => ({ name: "find" })),
  createLsTool: vi.fn(() => ({ name: "ls" })),
  createExtensionRuntime: vi.fn(),
  DefaultResourceLoader: vi.fn().mockImplementation(function () {
    return {
      reload: vi.fn().mockResolvedValue(undefined),
      getExtensions: vi.fn(() => ({ extensions: [], errors: [], runtime: {} })),
      getSkills: vi.fn(() => ({ skills: [], diagnostics: [] })),
      getPrompts: vi.fn(() => ({ prompts: [], diagnostics: [] })),
      getThemes: vi.fn(() => ({ themes: [], diagnostics: [] })),
      getAgentsFiles: vi.fn(() => ({ agentsFiles: [] })),
      getSystemPrompt: vi.fn(() => undefined),
      getAppendSystemPrompt: vi.fn(() => []),
      extendResources: vi.fn(),
      skillsOverride: undefined,
    };
  }),
  DefaultPackageManager: vi.fn(),
  discoverAndLoadExtensions: vi.fn().mockResolvedValue({ errors: [], runtime: { pendingProviderRegistrations: [] } }),
  getAgentDir: vi.fn(() => "/test/agent-dir"),
  ModelRuntime: { create: vi.fn() },
  ModelRegistry: vi.fn().mockImplementation(function () {
    return {
      find: vi.fn((provider: string, id: string) => ({ provider, id, name: id })),
      getAll: vi.fn().mockReturnValue([]),
      registerProvider: vi.fn(),
      refresh: vi.fn(),
    };
  }),
  SessionManager: { inMemory: vi.fn(() => ({})) },
  SettingsManager: { inMemory: vi.fn(() => ({})) },
}));

vi.mock("../mcp-session-tools.js", () => ({
  connectMcpSessionTools: vi.fn().mockResolvedValue({ tools: [], connected: [], skipped: [], toolSources: [], dispose: vi.fn() }),
  buildMcpCapabilityPrompt: vi.fn(() => ""),
}));

const { PROVIDERS } = vi.hoisted(() => ({
  PROVIDERS: [{
    id: "provider-m3",
    name: "OmniRoute MiniMax M3 Pinned",
    apiType: "openai-compatible",
    baseUrl: "http://127.0.0.1:8092/v1",
    models: [{ id: "minimax/MiniMax-M3", name: "MiniMax M3" }],
  }] as CustomProvider[],
}));

vi.mock("../custom-providers.js", () => ({ readCustomProviders: vi.fn(() => PROVIDERS) }));

const PROVIDER_KEY = "omniroute-minimax-m3-pinned";
const MODEL = { provider: PROVIDER_KEY, id: "minimax/MiniMax-M3" } as const;
const ADAPTER = "terminal-route-sse-comments.v1" as const;
const TURN_KEY = "ccc-plan-turn:intent:acceptance-reviewer:1";
const REQUESTED_UPSTREAM = { provider: "minimax", model: "MiniMax-M3" } as const;

const ROUTE: CccPlanningRouteBinding = Object.freeze({
  kind: "ccc-planning-route.v1",
  projectId: "project-plan",
  runId: `ccc-plan:${"a".repeat(24)}`,
  runRevision: 1,
  taskId: "FN-PLAN-1",
  stageId: "intent",
  roleId: "acceptance-reviewer",
  roleClass: "critic",
  lineageId: "intent:acceptance-reviewer",
  nodeAttemptOrdinal: 1,
  phase: "planning",
  providerId: PROVIDER_KEY,
  modelId: "minimax/MiniMax-M3",
  transport: "pi",
  receiptAdapterId: ADAPTER,
  toolsetDigest: "1".repeat(64),
  promptDigest: "2".repeat(64),
  policyDigest: "3".repeat(64),
  grantDigest: "4".repeat(64),
  bindingHash: "5".repeat(64),
});

/** The critic policy carries the route binding's own toolset digest (E5-P1 item 9). */
const CRITIC_POLICY: CccSessionToolPolicy = Object.freeze({
  policyId: "ccc-critic-tools.v1",
  allowedTools: CCC_PLANNING_TOOLSETS.critic,
  toolsetDigest: ROUTE.toolsetDigest,
  readRoots: Object.freeze(["/test/project"]),
  writeRoots: Object.freeze([]),
  deniedNames: Object.freeze([...CCC_PLANNING_DENIED_NAMES]),
});

const LINKED_WRITER_POLICY: CccSessionToolPolicy = Object.freeze({
  policyId: "ccc-linked-writer-tools.v1",
  allowedTools: CCC_PLANNING_LINKED_WRITER_TOOLSET,
  toolsetDigest: "7".repeat(64),
  readRoots: Object.freeze(["/test/project"]),
  writeRoots: Object.freeze(["/test/project/src"]),
  deniedNames: Object.freeze([...CCC_PLANNING_DENIED_NAMES]),
});

/** The confined file operations, shaped as Pi 0.81.1's seams; nothing here touches a file. */
const FS_OPERATIONS: CccConfinement["fs"] = Object.freeze({
  read: Object.freeze({ readFile: async () => Buffer.alloc(0), access: async () => undefined }),
  write: Object.freeze({ writeFile: async () => undefined, mkdir: async () => undefined }),
  edit: Object.freeze({ readFile: async () => Buffer.alloc(0), writeFile: async () => undefined, access: async () => undefined }),
  ls: Object.freeze({ exists: () => true, stat: () => ({ isDirectory: () => true }), readdir: () => [] }),
  find: Object.freeze({ exists: () => true, glob: () => [] }),
});
const CONFINED_BASH: NonNullable<CccConfinement["bash"]> = Object.freeze({
  exec: async () => ({ exitCode: 0 }),
  dispose: async () => Object.freeze({ closure: "confirmed" as const }),
});
const STREAM_GUARD = Object.freeze({
  observeDelta: () => ({ degenerate: false as const }),
  observeMessage: () => ({ degenerate: false as const }),
});

function planningScope(dispatchKey: string): CccPlanningCallScope {
  const ordinal = Number(dispatchKey.replace(/^pi-stream:/, ""));
  return {
    attemptKey: `ccc-plan-attempt:${ordinal}`,
    controllerToken: `token-${ordinal}`,
    taskId: ROUTE.taskId,
    semanticTaskId: ROUTE.lineageId,
    campaignDeadlineAt: "2026-10-15T00:00:00.000Z",
    turnKey: TURN_KEY,
    dispatchKey,
    attemptOrdinal: ordinal,
    requestCount: ordinal,
    workItemFence: { workItemId: "wi-plan-1", runId: "wr-plan-1", attempt: 1 },
    state: "dispatched_unknown",
    binding: ROUTE,
  };
}

/** A campaign authority binding: campaign scopes and planning-linked writer scopes (card BF) both carry one. */
const CAMPAIGN_AUTHORITY = Object.freeze({
  projectId: "project-plan",
  importId: "import-plan",
  campaignId: "campaign-plan",
  taskId: "FN-LINKED-1",
  actionId: "ACTION-LIVE-EXECUTION",
  actionTarget: "ccc-plan:linked-writer",
  idempotencyKey: "idempotency-plan",
  packetHash: "a".repeat(64),
  sidecarHash: "b".repeat(64),
  bundleHash: "c".repeat(64),
  targetRepository: "/test/project",
  targetBase: "d".repeat(40),
  providerId: PROVIDER_KEY,
  modelId: MODEL.id,
  transport: "pi" as const,
  manifestHash: "e".repeat(64),
  bindingHash: "f".repeat(64),
});

function campaignScope(dispatchKey: string): CccProviderAttemptScope {
  const ordinal = Number(dispatchKey.replace(/^pi-stream:/, ""));
  return {
    attemptKey: `ccc-linked-attempt:${ordinal}`,
    controllerToken: `token-${ordinal}`,
    taskId: CAMPAIGN_AUTHORITY.taskId,
    semanticTaskId: "SEMANTIC-LINKED-1",
    campaignDeadlineAt: "2026-10-15T00:00:00.000Z",
    turnKey: TURN_KEY,
    dispatchKey,
    attemptOrdinal: ordinal,
    requestCount: ordinal,
    workItemFence: { workItemId: "wi-linked-1", runId: "wr-linked-1", attempt: 1 },
    state: "dispatched_unknown",
    binding: CAMPAIGN_AUTHORITY,
  };
}

/** Models the ledger: a permitted slot holds as dispatched_unknown until settled, then holds as its terminal. */
function fakeLedgerController<S extends CccProviderAttemptScopeView = CccPlanningCallScope>(
  scopeFor: (dispatchKey: string) => S = planningScope as unknown as (dispatchKey: string) => S,
) {
  const permitted = new Set<string>();
  const settled = new Map<string, S>();
  const preDispatch = vi.fn(async (input: { dispatchKey: string }) => {
    const terminal = settled.get(input.dispatchKey);
    if (terminal) return { kind: "hold" as const, reason: "terminal" as const, scope: terminal };
    if (permitted.has(input.dispatchKey)) {
      return { kind: "hold" as const, reason: "dispatched-unknown" as const, scope: scopeFor(input.dispatchKey) };
    }
    permitted.add(input.dispatchKey);
    return { kind: "dispatch-permit" as const, scope: scopeFor(input.dispatchKey) };
  });
  const reconcile = vi.fn(async (input: any): Promise<S> => {
    const terminal = {
      ...scopeFor(input.dispatchKey),
      state: input.outcome,
      terminal: {
        kind: "reconciled",
        state: input.outcome,
        evidenceDigest: input.evidenceDigest,
        observerId: input.observerId,
        ...(input.effectiveRoute ? { effectiveRoute: input.effectiveRoute } : {}),
      },
    } as S;
    settled.set(input.dispatchKey, terminal);
    return terminal;
  });
  return { preDispatch, reconcile };
}

type FakeController = Pick<ReturnType<typeof fakeLedgerController<CccProviderAttemptScopeView>>, "preDispatch" | "reconcile">;

const distinctDispatchKeys = (controller: FakeController): string[] =>
  [...new Set(controller.preDispatch.mock.calls.map(([input]) => input.dispatchKey))];

const dispatchKeys = (controller: FakeController): string[] =>
  controller.preDispatch.mock.calls.map(([input]) => input.dispatchKey);

const usage = {
  input: 120,
  output: 340,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 460,
  cost: { input: 0.0012, output: 0.0034, cacheRead: 0, cacheWrite: 0, total: 0.0046 },
};

function terminalMessage(omniRoute: Readonly<{ provider: string; model: string }> | undefined) {
  return {
    role: "assistant",
    content: [{ type: "text", text: "planning answer" }],
    provider: PROVIDER_KEY,
    model: MODEL.id,
    usage,
    ...(omniRoute ? { omniRoute } : {}),
  };
}

function doneStream(message: unknown) {
  return {
    result: vi.fn(async () => message),
    async *[Symbol.asyncIterator]() {
      yield { type: "done", reason: "stop", message };
    },
  };
}

function providerErrorStream() {
  const errorMessage = { role: "assistant", content: [], stopReason: "error", errorMessage: "upstream 500 from provider" };
  return {
    result: vi.fn(async () => errorMessage),
    async *[Symbol.asyncIterator]() {
      yield { type: "error", reason: "error", error: errorMessage };
    },
  };
}

/** The shape the receipt adapter emits when the caller aborts (ccc-route-receipt-adapter.ts catch block). */
function adapterAbortStream() {
  const aborted = { role: "assistant", content: [], stopReason: "aborted", errorMessage: "CCC terminal route receipt request was aborted" };
  return {
    result: vi.fn(async () => aborted),
    async *[Symbol.asyncIterator]() {
      yield { type: "error", reason: "aborted", error: aborted };
    },
  };
}

function refusalDigest(reason: string, observed: Readonly<{ provider: string; model: string }> | null): string {
  return createHash("sha256").update(canonicalCccPrdJson({
    schema: "ccc-provider-route-refusal.v1",
    reason,
    requested: REQUESTED_UPSTREAM,
    observed,
    adapter: ADAPTER,
  }), "utf8").digest("hex");
}

/** A planning-linked writer binding as card BF builds it: campaign scopes, the linked writer policy and the bound-route marker. */
function linkedWriterBinding(controller: FakeController) {
  return Object.freeze({
    turnKey: TURN_KEY,
    controller: Object.freeze({
      preDispatch: controller.preDispatch,
      reconcile: controller.reconcile,
      [CCC_PROVIDER_ATTEMPT_ROUTE_MARKER]: Object.freeze({
        providerId: PROVIDER_KEY,
        modelId: MODEL.id,
        transport: "pi",
        roleClass: "writer",
        toolsetDigest: LINKED_WRITER_POLICY.toolsetDigest,
      }),
    }),
    receiptAdapterId: ADAPTER,
    scopeKind: "planning-linked-writer" as const,
    toolPolicy: LINKED_WRITER_POLICY,
  });
}

/** A hand-built binding with no scopeKind (so, campaign semantics) around whatever controller it is given. */
function handBuiltCampaignBinding(controller: FakeController) {
  return Object.freeze({
    turnKey: TURN_KEY,
    controller: Object.freeze({ preDispatch: controller.preDispatch, reconcile: controller.reconcile }),
    receiptAdapterId: ADAPTER,
  });
}

async function createPlanningAgent(input: {
  controller: FakeController;
  providerStream: ReturnType<typeof vi.fn>;
  scopeKind?: "campaign" | "planning" | "planning-linked-writer";
  binding?: CccProviderAttemptBinding<CccProviderAttemptScopeView>;
}) {
  const scopeKind = input.scopeKind ?? "planning";
  const modelRuntime = {
    getAuth: vi.fn(async () => ({ auth: { headers: {} } })),
    stream: input.providerStream,
    streamSimple: input.providerStream,
    complete: vi.fn(),
    completeSimple: vi.fn(),
  };
  const session = { model: MODEL, prompt: vi.fn(), subscribe: vi.fn(), dispose: vi.fn(), sessionFile: undefined } as unknown as AgentSession;
  vi.mocked(ModelRuntime.create).mockResolvedValueOnce(modelRuntime as any);
  vi.mocked(createAgentSession).mockReset();
  vi.mocked(createAgentSession).mockResolvedValueOnce({ session } as any);

  const binding = input.binding ?? (scopeKind === "planning"
    ? createCccPlanningProviderAttemptBinding({
      controller: Object.freeze({
        preDispatch: input.controller.preDispatch,
        reconcile: input.controller.reconcile,
      }) as unknown as Parameters<typeof createCccPlanningProviderAttemptBinding>[0]["controller"],
      binding: ROUTE,
      turnKey: TURN_KEY,
      toolPolicy: CRITIC_POLICY,
    })
    : scopeKind === "planning-linked-writer"
      ? linkedWriterBinding(input.controller)
      : Object.freeze({ ...handBuiltCampaignBinding(input.controller), scopeKind: "campaign" as const }));

  await createFnAgent({
    cwd: "/test/project",
    systemPrompt: "planning provider settlement",
    defaultProvider: PROVIDER_KEY,
    defaultModelId: MODEL.id,
    profile: "ccc-fusion",
    subscriptionReady: true,
    cccProviderAttemptBinding: binding,
    ...(scopeKind === "campaign"
      ? {}
      : {
        cccConfinement: Object.freeze({ bash: scopeKind === "planning-linked-writer" ? CONFINED_BASH : null, fs: FS_OPERATIONS }),
        cccStreamGuard: STREAM_GUARD,
        cccProviderPinCheck: vi.fn(),
      }),
  });

  const wrapped = vi.mocked(createAgentSession).mock.calls[0]?.[0]?.modelRuntime as unknown as typeof modelRuntime;
  return {
    stream: (options: Record<string, unknown> = {}) =>
      (wrapped.stream as unknown as (...args: unknown[]) => AsyncIterable<unknown> & { result(): Promise<unknown> })(MODEL, { messages: [] }, options),
  };
}

async function drain(handle: AsyncIterable<unknown> & { result(): Promise<unknown> }) {
  const events: any[] = [];
  for await (const event of handle) events.push(event);
  const outcome = await handle.result().then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  return { events, outcome };
}

const outcomeError = (outcome: { ok: boolean }): unknown => (outcome as { error?: unknown }).error;

// ------------------------------------------------------------ loopback upstream for the real receipt adapter

type LoopbackReply = (request: IncomingMessage, response: ServerResponse, ordinal: number) => void;

/** One loopback HTTP server this test owns, on a kernel-chosen port; it counts upstream requests. */
async function withLoopback(reply: LoopbackReply, run: (baseUrl: string, requests: () => number) => Promise<void>) {
  let requests = 0;
  const server = createServer((request, response) => {
    requests += 1;
    const ordinal = requests;
    request.resume();
    request.once("end", () => reply(request, response, ordinal));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}/v1`, () => requests);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** The real Fusion receipt adapter (D48), pointed at the loopback upstream. */
function realAdapterStream(baseUrl: string) {
  return vi.fn((model: { provider: string; id: string }, context: { messages?: unknown[] }, options: Record<string, unknown>) =>
    streamCccTerminalRouteReceipt({
      provider: model.provider,
      id: model.id,
      api: CCC_TERMINAL_ROUTE_RECEIPT_API,
      baseUrl,
      headers: {},
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 16_384,
    } as never, { messages: context?.messages ?? [] } as never, { ...options, apiKey: "loopback" }));
}

const SSE_HEADERS = { "content-type": "text/event-stream" };
const CONTENT_CHUNK = `data: ${JSON.stringify({
  id: "c1", object: "chat.completion.chunk", model: MODEL.id,
  choices: [{ index: 0, delta: { role: "assistant", content: "hello" }, finish_reason: null }],
})}\n\n`;
const finishChunk = (finishReason: string) => `data: ${JSON.stringify({
  id: "c1", object: "chat.completion.chunk", model: MODEL.id,
  choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
  usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
})}\n\n`;
const receiptComments = (provider: string, model: string) => `: x-omniroute-provider=${provider}\n: x-omniroute-model=${model}\n`;

/** A complete SSE response: content, a finish_reason, the given receipt tail, then [DONE]. */
function sseReply(tail: string, finishReason = "stop"): LoopbackReply {
  return (_request, response) => {
    response.writeHead(200, SSE_HEADERS);
    response.write(CONTENT_CHUNK);
    response.write(finishChunk(finishReason));
    response.end(`${tail}data: [DONE]\n\n`);
  };
}

describe("planning-scope route refusal settles once and leaves the slot loop (D10, item 42)", () => {
  beforeEach(() => {
    vi.mocked(ModelRuntime.create).mockReset();
  });

  const REFUSAL_CASES = [
    {
      label: "a mismatched terminal receipt in planning scope",
      scopeKind: "planning" as const,
      receipt: { provider: "minimax", model: "MiniMax-M2.7" },
      reason: "receipt-mismatch",
    },
    {
      label: "a missing terminal receipt in planning scope",
      scopeKind: "planning" as const,
      receipt: undefined,
      reason: "receipt-missing",
    },
    {
      label: "a mismatched terminal receipt in planning-linked-writer scope",
      scopeKind: "planning-linked-writer" as const,
      receipt: { provider: "glm", model: "glm-5.3" },
      reason: "receipt-mismatch",
    },
  ];

  // A loop rather than it.each, so each test name carries its whole label for the name-closed proof inventory.
  for (const { label, scopeKind, receipt, reason } of REFUSAL_CASES) it(`${label}: one proved_failed reconcile, a CccProviderRouteReceiptError, and dispatch keys [pi-stream:1]`, async () => {
    const controller = scopeKind === "planning-linked-writer" ? fakeLedgerController(campaignScope) : fakeLedgerController();
    const providerStream = vi.fn(() => doneStream(terminalMessage(receipt)));
    const agent = await createPlanningAgent({ controller, providerStream, scopeKind });

    const first = await drain(agent.stream());

    expect(first.outcome.ok).toBe(false);
    const error = outcomeError(first.outcome);
    expect(error).toBeInstanceOf(CccProviderRouteReceiptError);
    expect(error).toMatchObject({
      code: "CCC_PROVIDER_ROUTE_RECEIPT_REFUSED",
      reason,
      requested: REQUESTED_UPSTREAM,
      observed: receipt ?? null,
    });
    expect(controller.reconcile).toHaveBeenCalledTimes(1);
    const settlement = controller.reconcile.mock.calls[0]![0];
    expect(settlement).toMatchObject({
      dispatchKey: "pi-stream:1",
      turnKey: TURN_KEY,
      outcome: "proved_failed",
      refusalReason: reason,
      observerId: "pi",
      evidenceDigest: refusalDigest(reason, receipt ?? null),
    });
    expect(settlement).not.toHaveProperty("effectiveRoute");
    // The response is discarded: the terminal done event is never delivered.
    expect(first.events.some((event) => event?.type === "done")).toBe(false);

    // Re-entry gets the proved_failed hold for the refused slot and throws instead of moving to slot 2.
    const second = await drain(agent.stream());
    expect(outcomeError(second.outcome)).toBeInstanceOf(CccProviderRouteReceiptError);
    expect(distinctDispatchKeys(controller)).toEqual(["pi-stream:1"]);
    expect(providerStream).toHaveBeenCalledTimes(1);
    expect(controller.reconcile).toHaveBeenCalledTimes(1);
  });

  const LOST_SETTLEMENT_CASES = [
    { label: "the reconcile persists the refusal and then rejects", answer: "reject" as const },
    { label: "the reconcile persists the refusal and then answers with terminal evidence Pi did not submit", answer: "extra-evidence" as const },
  ];

  for (const { label, answer } of LOST_SETTLEMENT_CASES) it(`refusal memory comes first (E5-P1 item 1): when ${label}, a second stream still refuses slot 1 and the provider is called once`, async () => {
    const controller = fakeLedgerController();
    const persist = controller.reconcile.getMockImplementation()!;
    controller.reconcile.mockImplementationOnce(async (input: any) => {
      const persisted = await persist(input);
      if (answer === "reject") throw new Error("ccc-fusion test: reconcile response lost after commit");
      return { ...persisted, terminal: { ...persisted.terminal!, extra: "not submitted" } } as unknown as CccPlanningCallScope;
    });
    const providerStream = vi.fn()
      .mockImplementationOnce(() => doneStream(terminalMessage({ provider: "minimax", model: "MiniMax-M2.7" })))
      .mockImplementation(() => doneStream(terminalMessage(REQUESTED_UPSTREAM)));
    const agent = await createPlanningAgent({ controller, providerStream });

    const first = await drain(agent.stream());
    expect(first.outcome.ok).toBe(false);
    expect(controller.reconcile).toHaveBeenCalledTimes(1);
    expect(controller.reconcile.mock.calls[0]![0]).toMatchObject({ outcome: "proved_failed", refusalReason: "receipt-mismatch" });

    const second = await drain(agent.stream());
    expect(outcomeError(second.outcome)).toBeInstanceOf(CccProviderRouteReceiptError);
    expect(outcomeError(second.outcome)).toMatchObject({ reason: "receipt-mismatch" });
    expect(distinctDispatchKeys(controller)).toEqual(["pi-stream:1"]);
    expect(providerStream).toHaveBeenCalledTimes(1);
    expect(controller.reconcile).toHaveBeenCalledTimes(1);
  });

  it("settles a provider error event as proved_failed provider-error-event, and a retry takes the next slot (E2-1)", async () => {
    const controller = fakeLedgerController();
    const providerStream = vi.fn()
      .mockImplementationOnce(providerErrorStream)
      .mockImplementationOnce(() => doneStream(terminalMessage(REQUESTED_UPSTREAM)));
    const agent = await createPlanningAgent({ controller, providerStream });

    const first = await drain(agent.stream());
    expect(first.events.some((event) => event?.type === "error" && event?.reason === "error")).toBe(true);
    // The provider's own failure still surfaces, so Pi's retry classification sees the upstream error.
    expect(first.outcome.ok).toBe(false);
    expect(outcomeError(first.outcome)).not.toBeInstanceOf(CccProviderRouteReceiptError);
    expect(String(outcomeError(first.outcome))).toMatch(/upstream 500 from provider/);
    expect(controller.reconcile).toHaveBeenCalledTimes(1);
    const settlement = controller.reconcile.mock.calls[0]![0];
    expect(settlement).toMatchObject({
      dispatchKey: "pi-stream:1",
      outcome: "proved_failed",
      refusalReason: "provider-error-event",
      observerId: "pi",
      evidenceDigest: refusalDigest("provider-error-event", null),
    });
    expect(settlement).not.toHaveProperty("effectiveRoute");

    const retry = await drain(agent.stream());
    expect(retry.outcome.ok).toBe(true);
    expect(distinctDispatchKeys(controller)).toEqual(["pi-stream:1", "pi-stream:2"]);
    // The settled error slot is known locally, so the retry goes straight to the next slot.
    expect(dispatchKeys(controller)).toEqual(["pi-stream:1", "pi-stream:2"]);
    expect(providerStream).toHaveBeenCalledTimes(2);
    expect(controller.reconcile).toHaveBeenCalledTimes(2);
    expect(controller.reconcile.mock.calls[1]![0]).toMatchObject({ dispatchKey: "pi-stream:2", outcome: "committed" });
  });

  it("positive control: an exact terminal receipt in planning scope commits with the requested Pi route and no refusal", async () => {
    const controller = fakeLedgerController();
    const providerStream = vi.fn(() => doneStream(terminalMessage(REQUESTED_UPSTREAM)));
    const agent = await createPlanningAgent({ controller, providerStream });

    const first = await drain(agent.stream());

    expect(first.outcome.ok).toBe(true);
    expect(first.events.some((event) => event?.type === "done")).toBe(true);
    expect(controller.reconcile).toHaveBeenCalledTimes(1);
    const settlement = controller.reconcile.mock.calls[0]![0];
    expect(settlement).toMatchObject({
      dispatchKey: "pi-stream:1",
      outcome: "committed",
      effectiveRoute: {
        effectiveProvider: PROVIDER_KEY,
        effectiveModel: MODEL.id,
        omniRoute: { final: REQUESTED_UPSTREAM },
      },
    });
    expect(settlement).not.toHaveProperty("refusalReason");
    await drain(agent.stream());
    expect(distinctDispatchKeys(controller)).toEqual(["pi-stream:1", "pi-stream:2"]);
  });

  it("positive control: an abort with no terminal event stays dispatched_unknown in planning scope", async () => {
    const controller = fakeLedgerController();
    const aborted = Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
    const providerStream = vi.fn(() => ({
      result: vi.fn(async () => { throw aborted; }),
      async *[Symbol.asyncIterator]() {
        throw aborted;
      },
    }));
    const agent = await createPlanningAgent({ controller, providerStream });

    const first = await drain(agent.stream());
    expect(first.outcome.ok).toBe(false);
    expect(outcomeError(first.outcome)).toBe(aborted);
    expect(controller.reconcile).not.toHaveBeenCalled();

    const second = await drain(agent.stream());
    expect(String(outcomeError(second.outcome))).toMatch(/dispatched_unknown/);
    expect(dispatchKeys(controller)).toEqual(["pi-stream:1", "pi-stream:1"]);
    expect(providerStream).toHaveBeenCalledTimes(1);
  });

  it("positive control (E5-P1 item 2): the receipt adapter's abort shape, an error event with reason aborted, gets no reconcile and re-entry holds as dispatched_unknown", async () => {
    const controller = fakeLedgerController();
    const providerStream = vi.fn(adapterAbortStream);
    const agent = await createPlanningAgent({ controller, providerStream });

    const first = await drain(agent.stream());
    expect(first.outcome.ok).toBe(false);
    expect(first.events.some((event) => event?.type === "error" && event?.reason === "aborted")).toBe(true);
    expect(controller.reconcile).not.toHaveBeenCalled();

    const second = await drain(agent.stream());
    expect(String(outcomeError(second.outcome))).toMatch(/dispatched_unknown/);
    expect(dispatchKeys(controller)).toEqual(["pi-stream:1", "pi-stream:1"]);
    expect(providerStream).toHaveBeenCalledTimes(1);
    expect(controller.reconcile).not.toHaveBeenCalled();
  });

  it("positive control: a proved_failed hold this session did not refuse still advances to the next slot (E2-1)", async () => {
    const controller = fakeLedgerController();
    controller.preDispatch.mockImplementationOnce(async (input: { dispatchKey: string }) => ({
      kind: "hold" as const,
      reason: "terminal" as const,
      scope: {
        ...planningScope(input.dispatchKey),
        state: "proved_failed",
        terminal: { kind: "reconciled", state: "proved_failed", evidenceDigest: "8".repeat(64), observerId: "pi" },
      } as CccPlanningCallScope,
    }));
    const providerStream = vi.fn(() => doneStream(terminalMessage(REQUESTED_UPSTREAM)));
    const agent = await createPlanningAgent({ controller, providerStream });

    const first = await drain(agent.stream());

    expect(first.outcome.ok).toBe(true);
    expect(dispatchKeys(controller)).toEqual(["pi-stream:1", "pi-stream:2"]);
    expect(controller.reconcile.mock.calls[0]![0]).toMatchObject({ dispatchKey: "pi-stream:2", outcome: "committed" });
  });

  it("control: campaign scope with the same mismatched receipt keeps today's refusal before reconcile", async () => {
    const controller = fakeLedgerController(campaignScope);
    const providerStream = vi.fn(() => doneStream(terminalMessage({ provider: "minimax", model: "MiniMax-M2.7" })));
    const agent = await createPlanningAgent({ controller, providerStream, scopeKind: "campaign" });

    const first = await drain(agent.stream());
    const error = outcomeError(first.outcome);
    expect(error).not.toBeInstanceOf(CccProviderRouteReceiptError);
    expect(String(error)).toMatch(/final route mismatch/);
    expect(controller.reconcile).not.toHaveBeenCalled();

    const second = await drain(agent.stream());
    expect(String(outcomeError(second.outcome))).toMatch(/dispatched_unknown/);
    expect(dispatchKeys(controller)).toEqual(["pi-stream:1", "pi-stream:1"]);
    expect(providerStream).toHaveBeenCalledTimes(1);
  });

  const SCOPE_KIND_CASES = [
    { label: "a dispatch permit", hold: false },
    { label: "a proved_failed terminal hold", hold: true },
  ];

  for (const { label, hold } of SCOPE_KIND_CASES) it(`refuses ${label} carrying a planning scope under a hand-built binding without scopeKind, before any provider call (E5-P1 item 7)`, async () => {
    const controller = fakeLedgerController();
    if (hold) {
      controller.preDispatch.mockImplementationOnce(async (input: { dispatchKey: string }) => ({
        kind: "hold" as const,
        reason: "terminal" as const,
        scope: {
          ...planningScope(input.dispatchKey),
          state: "proved_failed",
          terminal: { kind: "reconciled", state: "proved_failed", evidenceDigest: "8".repeat(64), observerId: "pi" },
        } as CccPlanningCallScope,
      }));
    }
    const providerStream = vi.fn(() => doneStream(terminalMessage(REQUESTED_UPSTREAM)));
    const agent = await createPlanningAgent({
      controller,
      providerStream,
      scopeKind: "campaign",
      binding: handBuiltCampaignBinding(controller),
    });

    const first = await drain(agent.stream());

    expect(first.outcome.ok).toBe(false);
    expect(String(outcomeError(first.outcome))).toMatch(/planning scope.*campaign session binding/);
    expect(providerStream).not.toHaveBeenCalled();
    expect(controller.reconcile).not.toHaveBeenCalled();
    expect(dispatchKeys(controller)).toEqual(["pi-stream:1"]);
  });
});

describe("planning-scope settlement through the real receipt adapter over a loopback upstream (E5-P1 item 4)", () => {
  beforeEach(() => {
    vi.mocked(ModelRuntime.create).mockReset();
  });

  const RECEIPT_FAILURE_CASES = [
    { label: "missing", tail: "", reason: "receipt-missing" },
    {
      label: "conflicting",
      tail: `${receiptComments("minimax", "MiniMax-M3")}: x-omniroute-model=MiniMax-M2.7\n`,
      reason: "receipt-mismatch",
    },
    { label: "incomplete", tail: ": x-omniroute-model=MiniMax-M3\n", reason: "receipt-missing" },
    {
      label: "non-terminal",
      tail: `${receiptComments("minimax", "MiniMax-M3")}data: ${JSON.stringify({ id: "c1", choices: [] })}\n\n`,
      reason: "receipt-missing",
    },
  ];

  for (const { label, tail, reason } of RECEIPT_FAILURE_CASES) it(`a ${label} terminal receipt settles once as ${reason}, refuses with CccProviderRouteReceiptError, keeps dispatch keys [pi-stream:1] and sends one upstream request`, async () => {
    await withLoopback(sseReply(tail), async (baseUrl, requests) => {
      const controller = fakeLedgerController();
      const providerStream = realAdapterStream(baseUrl);
      const agent = await createPlanningAgent({ controller, providerStream });

      const first = await drain(agent.stream());
      expect(outcomeError(first.outcome)).toBeInstanceOf(CccProviderRouteReceiptError);
      expect(outcomeError(first.outcome)).toMatchObject({ reason, requested: REQUESTED_UPSTREAM, observed: null });
      expect(controller.reconcile).toHaveBeenCalledTimes(1);
      const settlement = controller.reconcile.mock.calls[0]![0];
      expect(settlement).toMatchObject({
        dispatchKey: "pi-stream:1",
        outcome: "proved_failed",
        refusalReason: reason,
        evidenceDigest: refusalDigest(reason, null),
      });
      expect(settlement).not.toHaveProperty("effectiveRoute");

      const second = await drain(agent.stream());
      expect(outcomeError(second.outcome)).toBeInstanceOf(CccProviderRouteReceiptError);
      expect(distinctDispatchKeys(controller)).toEqual(["pi-stream:1"]);
      expect(controller.reconcile).toHaveBeenCalledTimes(1);
      expect(requests()).toBe(1);
    });
  });

  it("a socket destroyed mid-stream is a transport failure: no reconcile, and re-entry holds as dispatched_unknown with keys [pi-stream:1, pi-stream:1]", async () => {
    const reply: LoopbackReply = (_request, response) => {
      response.writeHead(200, SSE_HEADERS);
      response.write(CONTENT_CHUNK, () => response.socket?.destroy());
    };
    await withLoopback(reply, async (baseUrl, requests) => {
      const controller = fakeLedgerController();
      const agent = await createPlanningAgent({ controller, providerStream: realAdapterStream(baseUrl) });

      const first = await drain(agent.stream());
      expect(first.outcome.ok).toBe(false);
      expect(first.events.some((event) => event?.type === "error" && event?.cccTransportFailure === true)).toBe(true);
      expect(controller.reconcile).not.toHaveBeenCalled();

      const second = await drain(agent.stream());
      expect(String(outcomeError(second.outcome))).toMatch(/dispatched_unknown/);
      expect(dispatchKeys(controller)).toEqual(["pi-stream:1", "pi-stream:1"]);
      expect(controller.reconcile).not.toHaveBeenCalled();
      expect(requests()).toBe(1);
    });
  });

  it("an adapter timeout is a transport failure: no reconcile, and re-entry holds as dispatched_unknown", async () => {
    const reply: LoopbackReply = (_request, response) => {
      response.writeHead(200, SSE_HEADERS);
      response.write(CONTENT_CHUNK);
      // The upstream then stalls; the adapter's own timeoutMs ends the request.
    };
    await withLoopback(reply, async (baseUrl, requests) => {
      const controller = fakeLedgerController();
      const agent = await createPlanningAgent({ controller, providerStream: realAdapterStream(baseUrl) });

      const first = await drain(agent.stream({ timeoutMs: 300 }));
      expect(first.outcome.ok).toBe(false);
      expect(first.events.some((event) => event?.type === "error" && event?.cccTransportFailure === true)).toBe(true);
      expect(controller.reconcile).not.toHaveBeenCalled();

      const second = await drain(agent.stream());
      expect(String(outcomeError(second.outcome))).toMatch(/dispatched_unknown/);
      expect(dispatchKeys(controller)).toEqual(["pi-stream:1", "pi-stream:1"]);
      expect(requests()).toBe(1);
    });
  });

  it("control: an upstream HTTP 500 settles provider-error-event and the retry advances to pi-stream:2", async () => {
    const reply: LoopbackReply = (request, response, ordinal) => {
      if (ordinal === 1) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "upstream exploded" } }));
        return;
      }
      sseReply(receiptComments("minimax", "MiniMax-M3"))(request, response, ordinal);
    };
    await withLoopback(reply, async (baseUrl, requests) => {
      const controller = fakeLedgerController();
      const agent = await createPlanningAgent({ controller, providerStream: realAdapterStream(baseUrl) });

      const first = await drain(agent.stream());
      expect(first.outcome.ok).toBe(false);
      expect(outcomeError(first.outcome)).not.toBeInstanceOf(CccProviderRouteReceiptError);
      expect(String(outcomeError(first.outcome))).toMatch(/HTTP 500/);
      const errorEvent = first.events.find((event) => event?.type === "error");
      expect(errorEvent).toBeDefined();
      expect(errorEvent).not.toHaveProperty("cccRouteFailure");
      expect(errorEvent).not.toHaveProperty("cccTransportFailure");
      expect(controller.reconcile.mock.calls[0]![0]).toMatchObject({
        dispatchKey: "pi-stream:1",
        outcome: "proved_failed",
        refusalReason: "provider-error-event",
        evidenceDigest: refusalDigest("provider-error-event", null),
      });

      const retry = await drain(agent.stream());
      expect(retry.outcome.ok).toBe(true);
      expect(dispatchKeys(controller)).toEqual(["pi-stream:1", "pi-stream:2"]);
      expect(controller.reconcile).toHaveBeenCalledTimes(2);
      expect(controller.reconcile.mock.calls[1]![0]).toMatchObject({ dispatchKey: "pi-stream:2", outcome: "committed" });
      expect(requests()).toBe(2);
    });
  });

  it("a provider error that carries an observed receipt keeps that receipt in its provider-error-event evidence (E5-P1 item 10)", async () => {
    const observed = { provider: "minimax", model: "MiniMax-M2.7" } as const;
    await withLoopback(sseReply(receiptComments(observed.provider, observed.model), "error"), async (baseUrl, requests) => {
      const controller = fakeLedgerController();
      const agent = await createPlanningAgent({ controller, providerStream: realAdapterStream(baseUrl) });

      const first = await drain(agent.stream());
      expect(first.outcome.ok).toBe(false);
      expect(outcomeError(first.outcome)).not.toBeInstanceOf(CccProviderRouteReceiptError);
      expect(controller.reconcile).toHaveBeenCalledTimes(1);
      expect(controller.reconcile.mock.calls[0]![0]).toMatchObject({
        dispatchKey: "pi-stream:1",
        outcome: "proved_failed",
        refusalReason: "provider-error-event",
        evidenceDigest: refusalDigest("provider-error-event", observed),
      });
      expect(requests()).toBe(1);
    });
  });

  it("positive control: an exact terminal receipt through the real adapter commits on pi-stream:1 with one upstream request", async () => {
    await withLoopback(sseReply(receiptComments("minimax", "MiniMax-M3")), async (baseUrl, requests) => {
      const controller = fakeLedgerController();
      const agent = await createPlanningAgent({ controller, providerStream: realAdapterStream(baseUrl) });

      const first = await drain(agent.stream());
      expect(first.outcome.ok).toBe(true);
      expect(controller.reconcile).toHaveBeenCalledTimes(1);
      expect(controller.reconcile.mock.calls[0]![0]).toMatchObject({
        dispatchKey: "pi-stream:1",
        outcome: "committed",
        effectiveRoute: { omniRoute: { final: REQUESTED_UPSTREAM } },
      });
      expect(requests()).toBe(1);
    });
  });
});
