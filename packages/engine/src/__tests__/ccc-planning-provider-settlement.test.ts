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
/*
FNXC:CccPlanningProviderSeam 2026-10-14-18:32:
Repair 2 (errata E7-P, final). Through the real adapter, any error raised after the body began and before [DONE] is a transport failure: a cut inside the last data line, a clean end with no [DONE] and no receipt, a refused connection and a malformed data line mid-stream all leave the attempt dispatched_unknown, with one upstream request (items 1 and 2). A finish_reason error whose terminal receipt names another model refuses receipt-mismatch and never retries; the same error with the bound model's receipt still settles provider-error-event (item 3, E7-0). A conflicting receipt keeps the conflicting provider and model, bounded, in its receipt-mismatch evidence (item 4). The item-7 refusal of a dispatch permit settles the reserved call once with no upstream request, so the slot is left neither reserved nor dispatched_unknown (item 6). The adapter's own timeout is a transport failure even when it fires after the body completed (item 8, fake timers, fetch stubbed to a body the adapter's abort cannot touch).
*/
/*
FNXC:CccPlanningProviderSeam 2026-10-14-20:44:
Card P1z (errata E8-P items 1-3). A body that fails to process after [DONE] (a data line cut mid-JSON, or a malformed one) and an HTTP 200 whose content type is not text/event-stream both leave the route unverified: no terminal receipt was ever checked. Through the real adapter each settles exactly one route refusal (receipt-missing), never provider-error-event, so the session never reaches pi-stream:2 and the upstream sees one request (probes B1, B2, B3 and A7). Each RED has a control on the same fixture without the failure: B0 (the drifted receipt of B1 with a clean end) settles receipt-mismatch, B5 (a valid data line after [DONE]) settles receipt-missing as before, the missing-receipt case above is B2 without its cut line, the E7-P item 3 case above is B3 without its malformed line, and the HTTP 500 control above is A7 with a non-2xx status, which stays provider-error-event.
*/
/*
FNXC:CccPlanningProviderSeam 2026-10-14-21:09:
P1z repair 1 (E8-P item 2). A 2xx with no body is never read either: a 204 or a 205 whose content type is text/event-stream settles one receipt-missing refusal (detail non-sse-response), keys [pi-stream:1], one upstream request, like A7. Controls: a bare 204 with no content type is refused the same way by the content-type check, and the same empty text/event-stream reply with HTTP 503 stays an upstream error that settles provider-error-event and retries on pi-stream:2.
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

/** E7-P item 4: an observed receipt value over 256 characters keeps a prefix and the sha256 of the whole value. */
function boundedRouteValue(value: string): string {
  if (value.length <= 256) return value;
  const suffix = `...sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
  return `${value.slice(0, 256 - suffix.length)}${suffix}`;
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
    // E7-P item 6: a permit reserved the call, so it is settled once; a hold reserved nothing, so nothing is settled.
    expect(controller.reconcile).toHaveBeenCalledTimes(hold ? 0 : 1);
    expect(dispatchKeys(controller)).toEqual(["pi-stream:1"]);
  });

  it("the item-7 refusal of a dispatch permit settles the reserved call once with no upstream request, so the slot is left neither reserved nor dispatched_unknown (E7-P item 6)", async () => {
    const controller = fakeLedgerController();
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
    expect(controller.reconcile).toHaveBeenCalledTimes(1);
    const settlement = controller.reconcile.mock.calls[0]![0];
    expect(settlement).toMatchObject({
      dispatchKey: "pi-stream:1",
      turnKey: TURN_KEY,
      outcome: "proved_failed",
      refusalReason: "effective-route-drift",
      observerId: "pi",
      evidenceDigest: refusalDigest("effective-route-drift", null),
    });
    expect(settlement).not.toHaveProperty("effectiveRoute");

    // The ledger now answers slot 1 with its proved_failed terminal, not with a dispatched_unknown hold.
    const second = await drain(agent.stream());
    expect(second.outcome.ok).toBe(false);
    expect(String(outcomeError(second.outcome))).not.toMatch(/dispatched_unknown/);
    await expect(controller.preDispatch.mock.results[1]!.value).resolves.toMatchObject({
      kind: "hold",
      reason: "terminal",
      scope: { dispatchKey: "pi-stream:1", state: "proved_failed" },
    });
    expect(dispatchKeys(controller)).toEqual(["pi-stream:1", "pi-stream:1"]);
    expect(providerStream).not.toHaveBeenCalled();
    expect(controller.reconcile).toHaveBeenCalledTimes(1);
  });
});

describe("planning-scope settlement through the real receipt adapter over a loopback upstream (E5-P1 item 4)", () => {
  beforeEach(() => {
    vi.mocked(ModelRuntime.create).mockReset();
  });

  // E7-P item 4: a conflicting receipt keeps the value that conflicts with the bound route; the item-9 ruling keeps an
  // incomplete or non-terminal receipt as receipt-missing with no observed route.
  const RECEIPT_FAILURE_CASES = [
    { label: "missing", tail: "", reason: "receipt-missing", observed: null },
    {
      label: "conflicting",
      tail: `${receiptComments("minimax", "MiniMax-M3")}: x-omniroute-model=MiniMax-M2.7\n`,
      reason: "receipt-mismatch",
      observed: { provider: "minimax", model: "MiniMax-M2.7" },
    },
    { label: "incomplete", tail: ": x-omniroute-model=MiniMax-M3\n", reason: "receipt-missing", observed: null },
    {
      label: "non-terminal",
      tail: `${receiptComments("minimax", "MiniMax-M3")}data: ${JSON.stringify({ id: "c1", choices: [] })}\n\n`,
      reason: "receipt-missing",
      observed: null,
    },
  ];

  for (const { label, tail, reason, observed } of RECEIPT_FAILURE_CASES) it(`a ${label} terminal receipt settles once as ${reason}, refuses with CccProviderRouteReceiptError, keeps dispatch keys [pi-stream:1] and sends one upstream request`, async () => {
    await withLoopback(sseReply(tail), async (baseUrl, requests) => {
      const controller = fakeLedgerController();
      const providerStream = realAdapterStream(baseUrl);
      const agent = await createPlanningAgent({ controller, providerStream });

      const first = await drain(agent.stream());
      expect(outcomeError(first.outcome)).toBeInstanceOf(CccProviderRouteReceiptError);
      expect(outcomeError(first.outcome)).toMatchObject({ reason, requested: REQUESTED_UPSTREAM, observed });
      expect(controller.reconcile).toHaveBeenCalledTimes(1);
      const settlement = controller.reconcile.mock.calls[0]![0];
      expect(settlement).toMatchObject({
        dispatchKey: "pi-stream:1",
        outcome: "proved_failed",
        refusalReason: reason,
        evidenceDigest: refusalDigest(reason, observed),
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

  it("a finish_reason error whose terminal receipt names another model settles once as receipt-mismatch and never retries: keys [pi-stream:1] and one upstream request (E7-P item 3)", async () => {
    const observed = { provider: "minimax", model: "MiniMax-M2.7" } as const;
    await withLoopback(sseReply(receiptComments(observed.provider, observed.model), "error"), async (baseUrl, requests) => {
      const controller = fakeLedgerController();
      const agent = await createPlanningAgent({ controller, providerStream: realAdapterStream(baseUrl) });

      const first = await drain(agent.stream());
      expect(outcomeError(first.outcome)).toBeInstanceOf(CccProviderRouteReceiptError);
      expect(outcomeError(first.outcome)).toMatchObject({ reason: "receipt-mismatch", requested: REQUESTED_UPSTREAM, observed });
      expect(controller.reconcile).toHaveBeenCalledTimes(1);
      const settlement = controller.reconcile.mock.calls[0]![0];
      expect(settlement).toMatchObject({
        dispatchKey: "pi-stream:1",
        outcome: "proved_failed",
        refusalReason: "receipt-mismatch",
        evidenceDigest: refusalDigest("receipt-mismatch", observed),
      });
      expect(settlement).not.toHaveProperty("effectiveRoute");

      const second = await drain(agent.stream());
      expect(outcomeError(second.outcome)).toBeInstanceOf(CccProviderRouteReceiptError);
      expect(distinctDispatchKeys(controller)).toEqual(["pi-stream:1"]);
      expect(controller.reconcile).toHaveBeenCalledTimes(1);
      expect(requests()).toBe(1);
    });
  });

  it("control (E7-P item 3): the same finish_reason error with the bound model's receipt settles provider-error-event, keeps that receipt in its evidence (E5-P1 item 10), and the retry advances to pi-stream:2", async () => {
    const reply: LoopbackReply = (request, response, ordinal) =>
      sseReply(receiptComments("minimax", "MiniMax-M3"), ordinal === 1 ? "error" : "stop")(request, response, ordinal);
    await withLoopback(reply, async (baseUrl, requests) => {
      const controller = fakeLedgerController();
      const agent = await createPlanningAgent({ controller, providerStream: realAdapterStream(baseUrl) });

      const first = await drain(agent.stream());
      expect(first.outcome.ok).toBe(false);
      expect(outcomeError(first.outcome)).not.toBeInstanceOf(CccProviderRouteReceiptError);
      expect(String(outcomeError(first.outcome))).toMatch(/finish_reason: error/);
      expect(controller.reconcile).toHaveBeenCalledTimes(1);
      expect(controller.reconcile.mock.calls[0]![0]).toMatchObject({
        dispatchKey: "pi-stream:1",
        outcome: "proved_failed",
        refusalReason: "provider-error-event",
        evidenceDigest: refusalDigest("provider-error-event", REQUESTED_UPSTREAM),
      });

      const retry = await drain(agent.stream());
      expect(retry.outcome.ok).toBe(true);
      expect(dispatchKeys(controller)).toEqual(["pi-stream:1", "pi-stream:2"]);
      expect(controller.reconcile.mock.calls[1]![0]).toMatchObject({ dispatchKey: "pi-stream:2", outcome: "committed" });
      expect(requests()).toBe(2);
    });
  });

  const BOUNDED_OBSERVED_CASES = [
    {
      label: "the bound model announced first and another model after it",
      tail: `${receiptComments("minimax", "MiniMax-M3")}: x-omniroute-model=MiniMax-M2.7\n`,
      reason: "receipt-mismatch",
      observed: { provider: "minimax", model: "MiniMax-M2.7" },
    },
    {
      label: "another model announced first and the bound model after it",
      tail: `${receiptComments("minimax", "MiniMax-M2.7")}: x-omniroute-model=MiniMax-M3\n`,
      reason: "receipt-mismatch",
      observed: { provider: "minimax", model: "MiniMax-M2.7" },
    },
    {
      label: "a conflicting provider",
      tail: `${receiptComments("minimax", "MiniMax-M3")}: x-omniroute-provider=glm\n`,
      reason: "receipt-mismatch",
      observed: { provider: "glm", model: "MiniMax-M3" },
    },
    {
      label: "a conflicting model of 10000 characters",
      tail: `${receiptComments("minimax", "MiniMax-M3")}: x-omniroute-model=${"M".repeat(10_000)}\n`,
      reason: "receipt-mismatch",
      observed: { provider: "minimax", model: boundedRouteValue("M".repeat(10_000)) },
    },
    {
      label: "a single mismatched receipt whose model has 10000 characters",
      tail: receiptComments("minimax", "Z".repeat(10_000)),
      reason: "receipt-mismatch",
      observed: { provider: "minimax", model: boundedRouteValue("Z".repeat(10_000)) },
    },
  ];

  for (const { label, tail, reason, observed } of BOUNDED_OBSERVED_CASES) it(`keeps the observed route, bounded to 256 characters, in the ${reason} evidence for ${label} (E7-P item 4)`, async () => {
    await withLoopback(sseReply(tail), async (baseUrl, requests) => {
      const controller = fakeLedgerController();
      const agent = await createPlanningAgent({ controller, providerStream: realAdapterStream(baseUrl) });

      const first = await drain(agent.stream());
      const error = outcomeError(first.outcome) as CccProviderRouteReceiptError;
      expect(error).toBeInstanceOf(CccProviderRouteReceiptError);
      expect(error).toMatchObject({ reason, requested: REQUESTED_UPSTREAM, observed });
      expect(error.observed!.provider.length).toBeLessThanOrEqual(256);
      expect(error.observed!.model.length).toBeLessThanOrEqual(256);
      expect(controller.reconcile).toHaveBeenCalledTimes(1);
      expect(controller.reconcile.mock.calls[0]![0]).toMatchObject({
        dispatchKey: "pi-stream:1",
        outcome: "proved_failed",
        refusalReason: reason,
        evidenceDigest: refusalDigest(reason, observed),
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

describe("an error before [DONE] is a transport failure through the real receipt adapter (E7-P items 1, 2 and 8)", () => {
  beforeEach(() => {
    vi.mocked(ModelRuntime.create).mockReset();
  });

  /**
   * What section 2.12 requires of a transport failure: the error event carries cccTransportFailure and no route marker,
   * nothing is settled, re-entry holds the same slot as dispatched_unknown, and one upstream request was made.
   */
  async function expectTransportHold(
    agent: Awaited<ReturnType<typeof createPlanningAgent>>,
    controller: FakeController,
    upstreamRequests: () => number,
  ) {
    const first = await drain(agent.stream());
    expect(first.outcome.ok).toBe(false);
    expect(outcomeError(first.outcome)).not.toBeInstanceOf(CccProviderRouteReceiptError);
    const errorEvent = first.events.find((event) => event?.type === "error");
    expect(errorEvent).toMatchObject({ type: "error", reason: "error", cccTransportFailure: true });
    expect(errorEvent).not.toHaveProperty("cccRouteFailure");
    expect(controller.reconcile).not.toHaveBeenCalled();

    const second = await drain(agent.stream());
    expect(String(outcomeError(second.outcome))).toMatch(/dispatched_unknown/);
    expect(dispatchKeys(controller)).toEqual(["pi-stream:1", "pi-stream:1"]);
    expect(controller.reconcile).not.toHaveBeenCalled();
    expect(upstreamRequests()).toBe(1);
    return errorEvent;
  }

  it("(a) a last data line cut mid-JSON at a clean end of stream is a transport failure: no reconcile, re-entry holds with keys [pi-stream:1, pi-stream:1], one upstream request", async () => {
    const reply: LoopbackReply = (_request, response) => {
      response.writeHead(200, SSE_HEADERS);
      response.write(CONTENT_CHUNK);
      response.end('data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"wor');
    };
    await withLoopback(reply, async (baseUrl, requests) => {
      const controller = fakeLedgerController();
      const agent = await createPlanningAgent({ controller, providerStream: realAdapterStream(baseUrl) });

      const errorEvent = await expectTransportHold(agent, controller, requests);
      expect(errorEvent.error.errorMessage).toMatch(/JSON/);
    });
  });

  it("(b) a clean end after a complete line with no [DONE] and no receipt stays a transport failure, not receipt-missing: no reconcile, re-entry holds, one upstream request", async () => {
    const reply: LoopbackReply = (_request, response) => {
      response.writeHead(200, SSE_HEADERS);
      response.write(CONTENT_CHUNK);
      response.end();
    };
    await withLoopback(reply, async (baseUrl, requests) => {
      const controller = fakeLedgerController();
      const agent = await createPlanningAgent({ controller, providerStream: realAdapterStream(baseUrl) });

      await expectTransportHold(agent, controller, requests);
    });
  });

  it("(c) a refused connection is a transport failure: no reconcile, re-entry holds with keys [pi-stream:1, pi-stream:1], one upstream request", async () => {
    // A loopback port this test binds and then closes, so nothing listens on it.
    const port = await new Promise<number>((resolve, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const chosen = (server.address() as AddressInfo).port;
        server.close(() => resolve(chosen));
      });
    });
    const baseUrl = `http://127.0.0.1:${port}/v1`;
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const controller = fakeLedgerController();
      const providerStream = realAdapterStream(baseUrl);
      const agent = await createPlanningAgent({ controller, providerStream });
      const upstreamRequests = () =>
        fetchSpy.mock.calls.filter(([target]) => String(target).startsWith(baseUrl)).length;

      await expectTransportHold(agent, controller, upstreamRequests);
      expect(providerStream).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("(d) a malformed data line mid-stream, followed by a valid finish, receipt and [DONE], is a transport failure: the adapter abandoned the stream, so nothing is settled", async () => {
    const reply: LoopbackReply = (_request, response) => {
      response.writeHead(200, SSE_HEADERS);
      response.write(CONTENT_CHUNK);
      response.write("data: {not-json}\n\n");
      response.write(finishChunk("stop"));
      response.end(`${receiptComments("minimax", "MiniMax-M3")}data: [DONE]\n\n`);
    };
    await withLoopback(reply, async (baseUrl, requests) => {
      const controller = fakeLedgerController();
      const agent = await createPlanningAgent({ controller, providerStream: realAdapterStream(baseUrl) });

      await expectTransportHold(agent, controller, requests);
    });
  });

  it("the adapter's own timeout firing after the body completed is a transport failure, not an upstream error (E7-P item 8)", async () => {
    const TIMEOUT_MS = 60_000;
    const body = [
      CONTENT_CHUNK,
      finishChunk("stop"),
      receiptComments("minimax", "MiniMax-M3"),
      "data: [DONE]\n\n",
    ].join("");
    // Any request that escapes the fetch stub lands on this file's own loopback server and fails the count below.
    await withLoopback((_request, response) => response.end(), async (baseUrl, requests) => {
      let pulls = 0;
      const stubbed = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1;
          if (pulls === 1) {
            controller.enqueue(new TextEncoder().encode(body));
            return;
          }
          // The whole body, [DONE] included, has been read: only now does the adapter's timer fire.
          vi.advanceTimersByTime(TIMEOUT_MS);
          controller.close();
        },
      });
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(stubbed, { status: 200, headers: SSE_HEADERS }),
      );
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const stream = realAdapterStream(baseUrl)(MODEL, { messages: [] }, { timeoutMs: TIMEOUT_MS });
        const events: any[] = [];
        for await (const event of stream as AsyncIterable<any>) events.push(event);

        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(pulls).toBe(2);
        const errorEvent = events.find((event) => event?.type === "error");
        expect(errorEvent).toMatchObject({ type: "error", reason: "error", cccTransportFailure: true });
        expect(errorEvent).not.toHaveProperty("cccRouteFailure");
        expect(errorEvent.error.errorMessage).toMatch(/aborted/);
        expect(events.some((event) => event?.type === "done")).toBe(false);
        expect(requests()).toBe(0);
      } finally {
        vi.useRealTimers();
        fetchSpy.mockRestore();
      }
    });
  });
});

describe("a body failure after [DONE] and a non-SSE 200 refuse the route through the real receipt adapter (E8-P, card P1z)", () => {
  beforeEach(() => {
    vi.mocked(ModelRuntime.create).mockReset();
  });

  const DRIFTED = { provider: "minimax", model: "MiniMax-M2.7" } as const;
  const DRIFTED_RECEIPT = receiptComments(DRIFTED.provider, DRIFTED.model);
  const CUT_DATA_LINE = 'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"wor';

  /** Content, a finish_reason, the receipt tail and [DONE], then the given bytes after [DONE] and a clean end. */
  function afterDoneReply(tail: string, finishReason: string, afterDone: string): LoopbackReply {
    return (_request, response) => {
      response.writeHead(200, SSE_HEADERS);
      response.write(CONTENT_CHUNK);
      response.write(finishChunk(finishReason));
      response.write(`${tail}data: [DONE]\n\n`);
      response.end(afterDone);
    };
  }

  /**
   * A stream and its re-entry on one planning session, and what section 2.12 settles on for them. The real adapter's own
   * events are recorded on their way to pi.ts, because a route refusal reaches the caller as pi.ts's error event, which
   * carries no adapter marker.
   */
  async function observeStreamAndReentry(reply: LoopbackReply) {
    let run: {
      first: Awaited<ReturnType<typeof drain>>;
      second: Awaited<ReturnType<typeof drain>>;
      adapterEvents: any[][];
      settlements: any[];
      distinctKeys: string[];
      upstreamRequests: number;
    } | undefined;
    await withLoopback(reply, async (baseUrl, requests) => {
      const controller = fakeLedgerController();
      const adapter = realAdapterStream(baseUrl);
      const adapterEvents: any[][] = [];
      const providerStream = vi.fn((...args: Parameters<typeof adapter>) => {
        const inner = adapter(...args);
        const recorded: any[] = [];
        adapterEvents.push(recorded);
        return {
          result: () => inner.result(),
          async *[Symbol.asyncIterator]() {
            for await (const event of inner) {
              recorded.push(event);
              yield event;
            }
          },
        };
      });
      const agent = await createPlanningAgent({ controller, providerStream });
      const first = await drain(agent.stream());
      const second = await drain(agent.stream());
      run = {
        first,
        second,
        adapterEvents,
        settlements: controller.reconcile.mock.calls.map(([input]) => input),
        distinctKeys: distinctDispatchKeys(controller),
        upstreamRequests: requests(),
      };
    });
    return run!;
  }

  /** The error event the real adapter emitted for the first dispatch. */
  const firstAdapterErrorEvent = (run: Awaited<ReturnType<typeof observeStreamAndReentry>>) =>
    run.adapterEvents[0]?.find((event) => event?.type === "error");

  /** The four facts every P1z RED pins, in one value, so a RED shows all of them at once. */
  const settlementSummary = (run: Awaited<ReturnType<typeof observeStreamAndReentry>>) => ({
    refusedWithRouteError: outcomeError(run.first.outcome) instanceof CccProviderRouteReceiptError,
    settlements: run.settlements.map((input) => ({
      dispatchKey: input.dispatchKey,
      outcome: input.outcome,
      refusalReason: input.refusalReason,
    })),
    distinctKeys: run.distinctKeys,
    upstreamRequests: run.upstreamRequests,
  });

  const ROUTE_REFUSAL_CASES = [
    {
      name: "B1: a drifted receipt, [DONE], then a data line cut mid-JSON at a clean end",
      reply: afterDoneReply(DRIFTED_RECEIPT, "stop", CUT_DATA_LINE),
      detail: "receipt-not-terminal",
      message: /JSON/,
    },
    {
      name: "B2: no receipt, [DONE], then a data line cut mid-JSON at a clean end",
      reply: afterDoneReply("", "stop", CUT_DATA_LINE),
      detail: "receipt-not-terminal",
      message: /JSON/,
    },
    {
      name: "B3: a drifted receipt after finish_reason error, [DONE], then a malformed data line",
      reply: afterDoneReply(DRIFTED_RECEIPT, "error", "data: {not-json}\n\n"),
      detail: "receipt-not-terminal",
      message: /JSON/,
    },
    {
      name: "A7: an HTTP 200 whose content type is application/json, never read",
      reply: ((_request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "nope" }));
      }) as LoopbackReply,
      detail: "non-sse-response",
      message: /did not return text\/event-stream/,
    },
    // P1z repair 1: a 2xx with no body is never read either, whatever content type it names (review probes P01-P03).
    ...[204, 205].map((status) => ({
      name: `A8 (HTTP ${status}): a 2xx whose content type is text/event-stream but has no body, never read`,
      reply: ((_request, response) => {
        response.writeHead(status, SSE_HEADERS);
        response.end();
      }) as LoopbackReply,
      detail: "non-sse-response",
      message: /returned no response body/,
    })),
    {
      name: "control A8 (HTTP 204, no content type): refused by the content-type check as before",
      reply: ((_request, response) => {
        response.writeHead(204);
        response.end();
      }) as LoopbackReply,
      detail: "non-sse-response",
      message: /did not return text\/event-stream/,
    },
  ];

  for (const { name, reply, detail, message } of ROUTE_REFUSAL_CASES) it(`${name}, settles one receipt-missing route refusal and never provider-error-event: keys [pi-stream:1], one upstream request`, async () => {
    const run = await observeStreamAndReentry(reply);

    expect(settlementSummary(run)).toEqual({
      refusedWithRouteError: true,
      settlements: [{ dispatchKey: "pi-stream:1", outcome: "proved_failed", refusalReason: "receipt-missing" }],
      distinctKeys: ["pi-stream:1"],
      upstreamRequests: 1,
    });
    expect(run.settlements.some((input) => input.refusalReason === "provider-error-event")).toBe(false);
    expect(run.settlements[0]).toMatchObject({ evidenceDigest: refusalDigest("receipt-missing", null), observerId: "pi" });
    expect(run.settlements[0]).not.toHaveProperty("effectiveRoute");
    expect(outcomeError(run.first.outcome)).toMatchObject({ reason: "receipt-missing", requested: REQUESTED_UPSTREAM, observed: null });
    expect(outcomeError(run.second.outcome)).toBeInstanceOf(CccProviderRouteReceiptError);
    expect(run.first.events.some((event) => event?.type === "done")).toBe(false);
    // The adapter's marker: a route failure with its detail, never a transport failure; the message is unchanged.
    expect(run.adapterEvents).toHaveLength(1);
    const errorEvent = firstAdapterErrorEvent(run);
    expect(errorEvent).toMatchObject({ type: "error", reason: "error", cccRouteFailure: "receipt-missing", cccRouteFailureDetail: detail });
    expect(errorEvent).not.toHaveProperty("cccTransportFailure");
    expect(errorEvent.error.errorMessage).toMatch(message);
  });

  it("control B0: the drifted receipt of B1 and [DONE] with a clean end settles one receipt-mismatch refusal, keys [pi-stream:1], one upstream request", async () => {
    const run = await observeStreamAndReentry(afterDoneReply(DRIFTED_RECEIPT, "stop", ""));

    expect(settlementSummary(run)).toEqual({
      refusedWithRouteError: true,
      settlements: [{ dispatchKey: "pi-stream:1", outcome: "proved_failed", refusalReason: "receipt-mismatch" }],
      distinctKeys: ["pi-stream:1"],
      upstreamRequests: 1,
    });
    expect(run.settlements[0]).toMatchObject({ evidenceDigest: refusalDigest("receipt-mismatch", DRIFTED) });
    expect(outcomeError(run.first.outcome)).toMatchObject({ reason: "receipt-mismatch", observed: DRIFTED });
    // The adapter completed the stream; pi.ts refused the receipt it delivered.
    expect(run.adapterEvents[0]!.some((event) => event?.type === "done")).toBe(true);
    expect(firstAdapterErrorEvent(run)).toBeUndefined();
  });

  it("control B5: the drifted receipt of B1, [DONE], then a valid data line still settles one receipt-missing refusal through the unchanged non-terminal marker, keys [pi-stream:1], one upstream request", async () => {
    const run = await observeStreamAndReentry(
      afterDoneReply(DRIFTED_RECEIPT, "stop", `data: ${JSON.stringify({ id: "c1", choices: [] })}\n\n`),
    );

    expect(settlementSummary(run)).toEqual({
      refusedWithRouteError: true,
      settlements: [{ dispatchKey: "pi-stream:1", outcome: "proved_failed", refusalReason: "receipt-missing" }],
      distinctKeys: ["pi-stream:1"],
      upstreamRequests: 1,
    });
    expect(run.settlements[0]).toMatchObject({ evidenceDigest: refusalDigest("receipt-missing", null) });
    const errorEvent = firstAdapterErrorEvent(run);
    expect(errorEvent).toMatchObject({ type: "error", reason: "error", cccRouteFailure: "receipt-not-terminal" });
    expect(errorEvent).not.toHaveProperty("cccRouteFailureDetail");
    expect(errorEvent).not.toHaveProperty("cccTransportFailure");
  });

  it("control A8 (HTTP 503): the same empty text/event-stream reply with a non-2xx status stays an upstream error, settles provider-error-event and the retry advances to pi-stream:2", async () => {
    const reply: LoopbackReply = (request, response, ordinal) => {
      if (ordinal === 1) {
        response.writeHead(503, SSE_HEADERS);
        response.end();
        return;
      }
      sseReply(receiptComments("minimax", "MiniMax-M3"))(request, response, ordinal);
    };
    const run = await observeStreamAndReentry(reply);

    expect(run.first.outcome.ok).toBe(false);
    expect(outcomeError(run.first.outcome)).not.toBeInstanceOf(CccProviderRouteReceiptError);
    expect(String(outcomeError(run.first.outcome))).toMatch(/HTTP 503/);
    const errorEvent = firstAdapterErrorEvent(run);
    expect(errorEvent).toMatchObject({ type: "error", reason: "error" });
    expect(errorEvent).not.toHaveProperty("cccRouteFailure");
    expect(errorEvent).not.toHaveProperty("cccTransportFailure");
    expect(run.second.outcome.ok).toBe(true);
    expect(run.settlements.map((input) => ({
      dispatchKey: input.dispatchKey,
      outcome: input.outcome,
      refusalReason: input.refusalReason,
    }))).toEqual([
      { dispatchKey: "pi-stream:1", outcome: "proved_failed", refusalReason: "provider-error-event" },
      { dispatchKey: "pi-stream:2", outcome: "committed", refusalReason: undefined },
    ]);
    expect(run.settlements[0]).toMatchObject({ evidenceDigest: refusalDigest("provider-error-event", null) });
    expect(run.distinctKeys).toEqual(["pi-stream:1", "pi-stream:2"]);
    expect(run.upstreamRequests).toBe(2);
  });
});
