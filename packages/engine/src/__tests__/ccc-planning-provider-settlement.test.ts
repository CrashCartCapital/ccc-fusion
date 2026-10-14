import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentSession, ModelRuntime, type AgentSession } from "@earendil-works/pi-coding-agent";
import {
  canonicalCccPrdJson,
  CCC_PLANNING_DENIED_NAMES,
  CCC_PLANNING_LINKED_WRITER_TOOLSET,
  CCC_PLANNING_TOOLSETS,
  type CccPlanningCallScope,
  type CccPlanningRouteBinding,
  type CustomProvider,
} from "@fusion/core";
import { createFnAgent, CccProviderRouteReceiptError } from "../pi.js";
import { createCccPlanningProviderAttemptBinding } from "../ccc-planning/provider-binding.js";
import type { CccSessionToolPolicy } from "../agent-runtime.js";

/*
FNXC:CccPlanningProviderSeam 2026-10-14-14:20:
Card P1 proof for the planning-scope settlement rule (CONTRACT-v3 section 2.12, D10, verify-v2 item 42, errata E2-1). In planning and planning-linked-writer scope a missing or mismatched terminal route receipt settles the attempt exactly once as proved_failed, with the refusal evidence and no effective route, and then throws out of the slot loop, so a later stream on the same session never reaches a second slot. A provider error event also settles proved_failed, but a retry may take the next slot. Campaign scope keeps today's behaviour (pi.test.ts stays unchanged). The fixture is pi.test.ts's bound-agent fixture with the receipt adapter selected, which D48 makes mandatory for planning.
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

const CRITIC_POLICY: CccSessionToolPolicy = Object.freeze({
  policyId: "ccc-critic-tools.v1",
  allowedTools: CCC_PLANNING_TOOLSETS.critic,
  toolsetDigest: "6".repeat(64),
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

const FS_OPERATIONS = Object.freeze({ read: {}, write: {}, edit: {}, ls: {}, find: {} });
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

/** Models the ledger: a permitted slot holds as dispatched_unknown until settled, then holds as its terminal. */
function fakeLedgerController() {
  const permitted = new Set<string>();
  const settled = new Map<string, CccPlanningCallScope>();
  const preDispatch = vi.fn(async (input: { dispatchKey: string }) => {
    const terminal = settled.get(input.dispatchKey);
    if (terminal) return { kind: "hold" as const, reason: "terminal" as const, scope: terminal };
    if (permitted.has(input.dispatchKey)) {
      return { kind: "hold" as const, reason: "dispatched-unknown" as const, scope: planningScope(input.dispatchKey) };
    }
    permitted.add(input.dispatchKey);
    return { kind: "dispatch-permit" as const, scope: planningScope(input.dispatchKey) };
  });
  const reconcile = vi.fn(async (input: any) => {
    const terminal: CccPlanningCallScope = {
      ...planningScope(input.dispatchKey),
      state: input.outcome,
      terminal: {
        kind: "reconciled",
        state: input.outcome,
        evidenceDigest: input.evidenceDigest,
        observerId: input.observerId,
        ...(input.effectiveRoute ? { effectiveRoute: input.effectiveRoute } : {}),
      },
    };
    settled.set(input.dispatchKey, terminal);
    return terminal;
  });
  return { preDispatch, reconcile };
}

type FakeController = ReturnType<typeof fakeLedgerController>;

const distinctDispatchKeys = (controller: FakeController): string[] =>
  [...new Set(controller.preDispatch.mock.calls.map(([input]) => input.dispatchKey))];

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

function refusalDigest(reason: string, observed: Readonly<{ provider: string; model: string }> | null): string {
  return createHash("sha256").update(canonicalCccPrdJson({
    schema: "ccc-provider-route-refusal.v1",
    reason,
    requested: REQUESTED_UPSTREAM,
    observed,
    adapter: ADAPTER,
  }), "utf8").digest("hex");
}

async function createPlanningAgent(input: {
  controller: FakeController;
  providerStream: ReturnType<typeof vi.fn>;
  scopeKind?: "campaign" | "planning" | "planning-linked-writer";
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

  const binding = scopeKind === "planning"
    ? createCccPlanningProviderAttemptBinding({
      controller: Object.freeze({ preDispatch: input.controller.preDispatch, reconcile: input.controller.reconcile }) as any,
      binding: ROUTE,
      turnKey: TURN_KEY,
      toolPolicy: CRITIC_POLICY,
    })
    : Object.freeze({
      turnKey: TURN_KEY,
      controller: Object.freeze({ preDispatch: input.controller.preDispatch, reconcile: input.controller.reconcile }),
      receiptAdapterId: ADAPTER,
      ...(scopeKind === "planning-linked-writer" ? { scopeKind, toolPolicy: LINKED_WRITER_POLICY } : { scopeKind }),
    });

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
        cccConfinement: Object.freeze({ bash: scopeKind === "planning-linked-writer" ? {} : null, fs: FS_OPERATIONS }),
        cccStreamGuard: STREAM_GUARD,
        cccProviderPinCheck: vi.fn(),
      }),
  } as any);

  const wrapped = vi.mocked(createAgentSession).mock.calls[0]?.[0]?.modelRuntime as unknown as typeof modelRuntime;
  return { stream: () => wrapped.stream(MODEL, { messages: [] }, {}) };
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
    const controller = fakeLedgerController();
    const providerStream = vi.fn(() => doneStream(terminalMessage(receipt)));
    const agent = await createPlanningAgent({ controller, providerStream, scopeKind });

    const first = await drain(agent.stream());

    expect(first.outcome.ok).toBe(false);
    const error = (first.outcome as { error: unknown }).error;
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
    expect((second.outcome as { error?: unknown }).error).toBeInstanceOf(CccProviderRouteReceiptError);
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
    expect((first.outcome as { error: unknown }).error).not.toBeInstanceOf(CccProviderRouteReceiptError);
    expect(String((first.outcome as { error: unknown }).error)).toMatch(/upstream 500 from provider/);
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
    expect(controller.preDispatch.mock.calls.map(([input]) => input.dispatchKey)).toEqual(["pi-stream:1", "pi-stream:2"]);
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
    expect((first.outcome as { error: unknown }).error).toBe(aborted);
    expect(controller.reconcile).not.toHaveBeenCalled();

    const second = await drain(agent.stream());
    expect(String((second.outcome as { error: unknown }).error)).toMatch(/dispatched_unknown/);
    expect(controller.preDispatch.mock.calls.map(([input]) => input.dispatchKey)).toEqual(["pi-stream:1", "pi-stream:1"]);
    expect(providerStream).toHaveBeenCalledTimes(1);
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
    expect(controller.preDispatch.mock.calls.map(([input]) => input.dispatchKey)).toEqual(["pi-stream:1", "pi-stream:2"]);
    expect(controller.reconcile.mock.calls[0]![0]).toMatchObject({ dispatchKey: "pi-stream:2", outcome: "committed" });
  });

  it("control: campaign scope with the same mismatched receipt keeps today's refusal before reconcile", async () => {
    const controller = fakeLedgerController();
    const providerStream = vi.fn(() => doneStream(terminalMessage({ provider: "minimax", model: "MiniMax-M2.7" })));
    const agent = await createPlanningAgent({ controller, providerStream, scopeKind: "campaign" });

    const first = await drain(agent.stream());
    const error = (first.outcome as { error: unknown }).error;
    expect(error).not.toBeInstanceOf(CccProviderRouteReceiptError);
    expect(String(error)).toMatch(/final route mismatch/);
    expect(controller.reconcile).not.toHaveBeenCalled();

    const second = await drain(agent.stream());
    expect(String((second.outcome as { error: unknown }).error)).toMatch(/dispatched_unknown/);
    expect(controller.preDispatch.mock.calls.map(([input]) => input.dispatchKey)).toEqual(["pi-stream:1", "pi-stream:1"]);
    expect(providerStream).toHaveBeenCalledTimes(1);
  });
});
