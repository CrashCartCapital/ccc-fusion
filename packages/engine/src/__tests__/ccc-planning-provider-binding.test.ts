import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { createAgentSession, ModelRegistry, ModelRuntime, type AgentSession } from "@earendil-works/pi-coding-agent";
import {
  CCC_PLANNING_DENIED_NAMES,
  CCC_PLANNING_LINKED_WRITER_TOOLSET,
  CCC_PLANNING_PROBE_TOOL,
  CCC_PLANNING_TOOLSETS,
  CccProviderAttemptIdentityError,
  type CccCampaignProviderDispatchInput,
  type CccPlanningCallScope,
  type CccPlanningRouteBinding,
  type CustomProvider,
} from "@fusion/core";
import { attachCccProviderAttemptBoundRoute, CCC_PROVIDER_ATTEMPT_ROUTE_MARKER, createFnAgent } from "../pi.js";
import { createCccPlanningProviderAttemptBinding } from "../ccc-planning/provider-binding.js";
import type { CccConfinement, CccProviderAttemptController, CccProviderPinCheck, CccSessionToolPolicy } from "../agent-runtime.js";

/*
FNXC:CccPlanningProviderSeam 2026-10-14-14:30:
Card P1 proof for binding a planning session to one exact route (CONTRACT-v3 section 2.12, D48). The binding factory refuses any dispatch whose provider, model or transport differs from the planning route binding, and records that route on the frozen controller under a symbol key. Session creation refuses a planning binding whose provider is not the session's default provider, because Pi selects the Fusion receipt adapter only for the default provider and any other provider would stream through unpatched pi-ai. It also refuses a planning binding without a tool policy, the receipt adapter, a stream guard, a provider pin check or a confinement. Each refusal has a positive control on the same fixture.
*/
/*
FNXC:CccPlanningProviderSeam 2026-10-14-17:22:
Repair 1 (errata E5-P1). D48 fails closed for linked writers too: a planning-linked-writer binding without the bound-route marker, or with a bound provider that is not the default provider, is refused at session creation (item 3; card BF attaches the marker). When the tool policy allows bash the confinement must carry a confined bash with exec and dispose, and the confined file operations are shape-checked (items 8 and 12). The tool policy must match the binding: allowed tools equal K1's cccPlanningSessionToolNames, denied names include CCC_PLANNING_DENIED_NAMES, and the toolset digest and role class equal the route binding's (item 9). The bound-route marker therefore carries the route binding's role class and toolset digest, and the fixtures pair matching digests.
*/
/*
FNXC:CccPlanningProviderSeam 2026-10-14-18:35:
Repair 2 (errata E7-P, final). A bound route's model must be the session's default model as well as its provider, so a linked writer (and a planning binding) naming another model is refused at session creation, before any provider call (item 5). The 5-key bound route has one exported type, CccProviderAttemptBoundRoute, and one writer, attachCccProviderAttemptBoundRoute, which card WR uses for a linked writer's controller and the planning factory uses for its own (item 7).
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
  PROVIDERS: [
    {
      id: "provider-m3",
      name: "OmniRoute MiniMax M3 Pinned",
      apiType: "openai-compatible",
      baseUrl: "http://127.0.0.1:8092/v1",
      models: [{ id: "minimax/MiniMax-M3", name: "MiniMax M3" }],
    },
    {
      id: "provider-glm",
      name: "OmniRoute GLM Pinned",
      apiType: "openai-compatible",
      baseUrl: "http://127.0.0.1:8093/v1",
      models: [{ id: "glm/glm-5.3", name: "GLM 5.3" }],
    },
  ] as CustomProvider[],
}));

vi.mock("../custom-providers.js", () => ({ readCustomProviders: vi.fn(() => PROVIDERS) }));

const M3_KEY = "omniroute-minimax-m3-pinned";
const GLM_KEY = "omniroute-glm-pinned";
const ADAPTER = "terminal-route-sse-comments.v1" as const;
const TURN_KEY = "ccc-plan-turn:intent:acceptance-reviewer:1";

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
  providerId: M3_KEY,
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
  return {
    attemptKey: "ccc-plan-attempt:1",
    controllerToken: "token-1",
    taskId: ROUTE.taskId,
    semanticTaskId: ROUTE.lineageId,
    campaignDeadlineAt: "2026-10-15T00:00:00.000Z",
    turnKey: TURN_KEY,
    dispatchKey,
    attemptOrdinal: 1,
    requestCount: 1,
    workItemFence: { workItemId: "wi-plan-1", runId: "wr-plan-1", attempt: 1 },
    state: "dispatched_unknown",
    binding: ROUTE,
  };
}

function innerController() {
  const decision = Object.freeze({ kind: "dispatch-permit" as const, scope: planningScope("pi-stream:1") });
  const settled = Object.freeze({ ...planningScope("pi-stream:1"), state: "committed" as const });
  return {
    decision,
    settled,
    preDispatch: vi.fn(async (_input: CccCampaignProviderDispatchInput) => decision),
    reconcile: vi.fn(async (_input: unknown) => settled),
  };
}

function planningBinding(
  inner = innerController(),
  toolPolicy: CccSessionToolPolicy = CRITIC_POLICY,
  route: CccPlanningRouteBinding = ROUTE,
) {
  return createCccPlanningProviderAttemptBinding({
    controller: Object.freeze({ preDispatch: inner.preDispatch, reconcile: inner.reconcile }),
    binding: route,
    turnKey: TURN_KEY,
    toolPolicy,
  });
}

type BoundRouteMarker = Readonly<{ providerId: string; modelId: string; transport: string; roleClass: string; toolsetDigest: string }>;

const LINKED_WRITER_ROUTE: BoundRouteMarker = Object.freeze({
  providerId: M3_KEY,
  modelId: "minimax/MiniMax-M3",
  transport: "pi",
  roleClass: "writer",
  toolsetDigest: LINKED_WRITER_POLICY.toolsetDigest,
});

/** A planning-linked writer binding as card BF builds it: the linked writer policy, plus the bound-route marker unless `route` is null. */
function linkedWriterBinding(route: BoundRouteMarker | null = LINKED_WRITER_ROUTE, toolPolicy: CccSessionToolPolicy = LINKED_WRITER_POLICY) {
  const inner = innerController();
  return Object.freeze({
    turnKey: TURN_KEY,
    controller: Object.freeze({
      preDispatch: inner.preDispatch,
      reconcile: inner.reconcile,
      ...(route === null ? {} : { [CCC_PROVIDER_ATTEMPT_ROUTE_MARKER]: route }),
    }),
    receiptAdapterId: ADAPTER,
    scopeKind: "planning-linked-writer" as const,
    toolPolicy,
  });
}

/** A frozen copy of the critic policy with some fields replaced. */
const criticPolicyWith = (fields: Record<string, unknown>) => Object.freeze({ ...CRITIC_POLICY, ...fields });

const MATCHING_DISPATCH: CccCampaignProviderDispatchInput = Object.freeze({
  turnKey: TURN_KEY,
  dispatchKey: "pi-stream:1",
  providerId: M3_KEY,
  modelId: "minimax/MiniMax-M3",
  transport: "pi",
});

describe("createCccPlanningProviderAttemptBinding binds one exact route", () => {
  const DRIFT_CASES = [
    { label: "a different modelId", input: { modelId: "minimax/MiniMax-M2.7" } },
    { label: "a different providerId", input: { providerId: GLM_KEY } },
    { label: "a different transport", input: { transport: "workflow" } },
  ];

  // Loops rather than it.each in this file, so each test name carries its whole label for the name-closed proof inventory.
  for (const { label, input } of DRIFT_CASES) it(`refuses a dispatch with ${label} as route-drift and never asks the inner controller`, async () => {
    const inner = innerController();
    const binding = planningBinding(inner);

    const refused = binding.controller.preDispatch({ ...MATCHING_DISPATCH, ...input } as CccCampaignProviderDispatchInput);

    await expect(refused).rejects.toBeInstanceOf(CccProviderAttemptIdentityError);
    await expect(refused).rejects.toMatchObject({ code: "CCC_PROVIDER_ATTEMPT_IDENTITY_REFUSED", reason: "route-drift" });
    expect(inner.preDispatch).not.toHaveBeenCalled();
  });

  it("positive control: the exact route is forwarded to the inner controller unchanged", async () => {
    const inner = innerController();
    const binding = planningBinding(inner);

    await expect(binding.controller.preDispatch(MATCHING_DISPATCH)).resolves.toBe(inner.decision);
    expect(inner.preDispatch).toHaveBeenCalledTimes(1);
    expect(inner.preDispatch).toHaveBeenCalledWith(MATCHING_DISPATCH);
    const settlement = { dispatchKey: "pi-stream:1" } as any;
    await expect(binding.controller.reconcile(settlement)).resolves.toBe(inner.settled);
    expect(inner.reconcile).toHaveBeenCalledWith(settlement);
  });

  it("returns a frozen planning binding whose frozen controller carries the bound route under a symbol key", () => {
    const binding = planningBinding();

    expect(Object.isFrozen(binding)).toBe(true);
    expect(Object.keys(binding).sort()).toEqual(["controller", "receiptAdapterId", "scopeKind", "toolPolicy", "turnKey"]);
    expect(binding).toMatchObject({ turnKey: TURN_KEY, receiptAdapterId: ADAPTER, scopeKind: "planning", toolPolicy: CRITIC_POLICY });
    expect(Object.isFrozen(binding.controller)).toBe(true);
    expect(Object.keys(binding.controller).sort()).toEqual(["preDispatch", "reconcile"]);
    expect((binding.controller as unknown as Record<symbol, unknown>)[CCC_PROVIDER_ATTEMPT_ROUTE_MARKER]).toEqual({
      providerId: M3_KEY,
      modelId: "minimax/MiniMax-M3",
      transport: "pi",
      roleClass: "critic",
      toolsetDigest: ROUTE.toolsetDigest,
    });
  });
});

/** A plain frozen controller around the fake inner controller, typed as the seam controller it stands for. */
function plainController(inner = innerController()): CccProviderAttemptController<CccPlanningCallScope> {
  return Object.freeze({ preDispatch: inner.preDispatch, reconcile: inner.reconcile }) as unknown as CccProviderAttemptController<CccPlanningCallScope>;
}

describe("attachCccProviderAttemptBoundRoute writes the 5-key bound route that card WR attaches (E7-P item 7)", () => {
  it("returns a frozen controller that carries exactly the five route values, copied and frozen, and forwards both methods", async () => {
    const inner = innerController();
    // Card BF's core data may carry more than the five values; only the five are recorded.
    const wider: BoundRouteMarker = { ...LINKED_WRITER_ROUTE, bindingHash: "f".repeat(64) } as BoundRouteMarker;

    const marked = attachCccProviderAttemptBoundRoute(plainController(inner), wider);

    expect(Object.isFrozen(marked)).toBe(true);
    expect(Object.keys(marked).sort()).toEqual(["preDispatch", "reconcile"]);
    const recorded = (marked as unknown as Record<symbol, unknown>)[CCC_PROVIDER_ATTEMPT_ROUTE_MARKER];
    expect(recorded).toEqual(LINKED_WRITER_ROUTE);
    expect(recorded).not.toBe(wider);
    expect(Object.isFrozen(recorded)).toBe(true);
    expect(Object.keys(recorded as object).sort()).toEqual(["modelId", "providerId", "roleClass", "toolsetDigest", "transport"]);
    await expect(marked.preDispatch(MATCHING_DISPATCH)).resolves.toBe(inner.decision);
    expect(inner.preDispatch).toHaveBeenCalledWith(MATCHING_DISPATCH);
    const settlement = { dispatchKey: "pi-stream:1" } as any;
    await expect(marked.reconcile(settlement)).resolves.toBe(inner.settled);
    expect(inner.reconcile).toHaveBeenCalledWith(settlement);
  });

  const ATTACH_REFUSALS: ReadonlyArray<Readonly<{
    label: string;
    controller: () => CccProviderAttemptController<CccPlanningCallScope>;
    route: BoundRouteMarker;
    message: RegExp;
  }>> = [
    {
      label: "an empty route value",
      controller: () => plainController(),
      route: Object.freeze({ ...LINKED_WRITER_ROUTE, modelId: "" }),
      message: /bound route modelId must be a non-empty string/,
    },
    {
      label: "a missing route value",
      controller: () => plainController(),
      route: (({ toolsetDigest: _toolsetDigest, ...rest }) => rest)(LINKED_WRITER_ROUTE) as unknown as BoundRouteMarker,
      message: /bound route toolsetDigest must be a non-empty string/,
    },
    {
      label: "a controller that already carries a bound route",
      controller: () => attachCccProviderAttemptBoundRoute(plainController(), LINKED_WRITER_ROUTE),
      route: LINKED_WRITER_ROUTE,
      message: /already carries a bound route/,
    },
    {
      label: "a controller with a key other than preDispatch and reconcile",
      controller: () => {
        const inner = innerController();
        return Object.freeze({ preDispatch: inner.preDispatch, reconcile: inner.reconcile, extra: 1 }) as unknown as CccProviderAttemptController<CccPlanningCallScope>;
      },
      route: LINKED_WRITER_ROUTE,
      message: /must expose exactly preDispatch, reconcile/,
    },
  ];

  for (const { label, controller, route, message } of ATTACH_REFUSALS) it(`refuses ${label}`, () => {
    const target = controller();
    expect(() => attachCccProviderAttemptBoundRoute(target, route)).toThrow(message);
  });
});

describe("planning session creation enforces the bound route and the planning seams (D48)", () => {
  let pinCheck: Mock<CccProviderPinCheck>;

  beforeEach(() => {
    vi.mocked(ModelRuntime.create).mockReset();
    vi.mocked(ModelRegistry).mockClear();
    pinCheck = vi.fn<CccProviderPinCheck>();
  });

  function prepareSession(model: Readonly<{ provider: string; id: string }>) {
    const modelRuntime = {
      getAuth: vi.fn(async () => ({ auth: { headers: {} } })),
      stream: vi.fn(),
      streamSimple: vi.fn(),
      complete: vi.fn(),
      completeSimple: vi.fn(),
    };
    const session = { model, prompt: vi.fn(), subscribe: vi.fn(), dispose: vi.fn(), sessionFile: undefined } as unknown as AgentSession;
    vi.mocked(ModelRuntime.create).mockResolvedValueOnce(modelRuntime as any);
    vi.mocked(createAgentSession).mockReset();
    vi.mocked(createAgentSession).mockResolvedValueOnce({ session } as any);
  }

  function sessionOptions(overrides: Record<string, unknown> = {}) {
    return {
      cwd: "/test/project",
      systemPrompt: "planning provider binding",
      defaultProvider: M3_KEY,
      defaultModelId: "minimax/MiniMax-M3",
      profile: "ccc-fusion",
      subscriptionReady: true,
      cccProviderAttemptBinding: planningBinding(),
      cccConfinement: Object.freeze({ bash: null, fs: FS_OPERATIONS }),
      cccStreamGuard: STREAM_GUARD,
      cccProviderPinCheck: pinCheck,
      ...overrides,
    };
  }

  function registeredProviders(): Map<string, Record<string, unknown>> {
    const registry = vi.mocked(ModelRegistry).mock.results.at(-1)?.value as { registerProvider: ReturnType<typeof vi.fn> };
    return new Map(registry.registerProvider.mock.calls.map(([key, config]) => [key as string, config as Record<string, unknown>]));
  }

  it("refuses a planning binding whose provider is not the session's default provider, before any provider is registered", async () => {
    prepareSession({ provider: GLM_KEY, id: "glm/glm-5.3" });

    await expect(createFnAgent(sessionOptions({ defaultProvider: GLM_KEY, defaultModelId: "glm/glm-5.3" }) as any))
      .rejects.toThrow(/provider omniroute-minimax-m3-pinned.*default provider omniroute-glm-pinned/);
    expect(ModelRuntime.create).not.toHaveBeenCalled();
    expect(createAgentSession).not.toHaveBeenCalled();
  });

  it("positive control: the bound provider as the default provider creates the session with the receipt adapter on that provider only", async () => {
    prepareSession({ provider: M3_KEY, id: "minimax/MiniMax-M3" });

    await expect(createFnAgent(sessionOptions() as any)).resolves.toBeDefined();
    const registered = registeredProviders();
    expect(registered.get(M3_KEY)).toHaveProperty("streamSimple");
    expect(registered.get(GLM_KEY)).toBeDefined();
    expect(registered.get(GLM_KEY)).not.toHaveProperty("streamSimple");
    expect(pinCheck).toHaveBeenCalledTimes(1);
    expect(pinCheck).toHaveBeenCalledWith(PROVIDERS);
  });

  it("refuses scopeKind planning without a toolPolicy at session creation", async () => {
    prepareSession({ provider: M3_KEY, id: "minimax/MiniMax-M3" });
    const factory = planningBinding();
    const withoutPolicy = Object.freeze({
      turnKey: factory.turnKey,
      controller: factory.controller,
      receiptAdapterId: ADAPTER,
      scopeKind: "planning" as const,
    });

    await expect(createFnAgent(sessionOptions({ cccProviderAttemptBinding: withoutPolicy }) as any))
      .rejects.toThrow(/toolPolicy/);
    expect(ModelRuntime.create).not.toHaveBeenCalled();
  });

  it("propagates a provider pin check refusal before any provider is registered", async () => {
    prepareSession({ provider: M3_KEY, id: "minimax/MiniMax-M3" });
    const pinDrift = Object.assign(new Error("provider pin drift: model-id"), { code: "CCC_PROVIDER_PIN_DRIFT" });
    pinCheck.mockImplementation(() => { throw pinDrift; });

    await expect(createFnAgent(sessionOptions() as any)).rejects.toBe(pinDrift);
    expect(pinCheck).toHaveBeenCalledWith(PROVIDERS);
    expect(ModelRuntime.create).not.toHaveBeenCalled();
  });

  const SESSION_REFUSALS: ReadonlyArray<Readonly<{ label: string; overrides: () => Record<string, unknown>; message: RegExp }>> = [
    {
      label: "a planning binding without the receipt adapter",
      overrides: () => {
        const factory = planningBinding();
        return { cccProviderAttemptBinding: Object.freeze({ turnKey: TURN_KEY, controller: factory.controller, scopeKind: "planning", toolPolicy: CRITIC_POLICY }) };
      },
      message: /receipt adapter/,
    },
    {
      label: "a planning binding with terminal route members",
      overrides: () => {
        const factory = planningBinding();
        return {
          cccProviderAttemptBinding: Object.freeze({
            ...factory,
            terminalRouteMembers: Object.freeze([Object.freeze({ provider: "minimax", model: "MiniMax-M3" })]),
          }),
        };
      },
      message: /terminalRouteMembers/,
    },
    {
      label: "a planning binding whose controller carries no bound route",
      overrides: () => {
        const inner = innerController();
        return {
          cccProviderAttemptBinding: Object.freeze({
            turnKey: TURN_KEY,
            controller: Object.freeze({ preDispatch: inner.preDispatch, reconcile: inner.reconcile }),
            receiptAdapterId: ADAPTER,
            scopeKind: "planning",
            toolPolicy: CRITIC_POLICY,
          }),
        };
      },
      message: /bound route/,
    },
    { label: "a missing stream guard", overrides: () => ({ cccStreamGuard: undefined }), message: /cccStreamGuard/ },
    { label: "a missing provider pin check", overrides: () => ({ cccProviderPinCheck: undefined }), message: /cccProviderPinCheck/ },
    { label: "a missing confinement", overrides: () => ({ cccConfinement: undefined }), message: /cccConfinement/ },
    {
      label: "a linked writer whose policy allows bash without a confined bash",
      overrides: () => ({ cccProviderAttemptBinding: linkedWriterBinding() }),
      message: /bash/,
    },
    {
      label: "an unknown scopeKind",
      overrides: () => ({ cccProviderAttemptBinding: Object.freeze({ ...planningBinding(), scopeKind: "planning-writer" }) }),
      message: /scopeKind/,
    },
    {
      label: "a tool policy that is not frozen",
      overrides: () => ({ cccProviderAttemptBinding: Object.freeze({ ...planningBinding(), toolPolicy: { ...CRITIC_POLICY } }) }),
      message: /toolPolicy/,
    },
    // E5-P1 item 3: D48 fails closed for linked writers.
    {
      label: "a planning-linked-writer binding whose controller carries no bound route",
      overrides: () => ({ cccProviderAttemptBinding: linkedWriterBinding(null), cccConfinement: Object.freeze({ bash: CONFINED_BASH, fs: FS_OPERATIONS }) }),
      message: /no bound route.*CCC_PROVIDER_ATTEMPT_ROUTE_MARKER/,
    },
    {
      label: "a planning-linked-writer binding whose bound provider is not the session's default provider",
      overrides: () => ({
        cccProviderAttemptBinding: linkedWriterBinding(Object.freeze({ ...LINKED_WRITER_ROUTE, providerId: GLM_KEY, modelId: "glm/glm-5.3" })),
        cccConfinement: Object.freeze({ bash: CONFINED_BASH, fs: FS_OPERATIONS }),
      }),
      message: /provider omniroute-glm-pinned.*default provider omniroute-minimax-m3-pinned/,
    },
    // E7-P item 5: the bound model is checked at session creation too, before any provider call.
    {
      label: "a planning-linked-writer binding whose bound model is not the session's default model",
      overrides: () => ({
        cccProviderAttemptBinding: linkedWriterBinding(Object.freeze({ ...LINKED_WRITER_ROUTE, modelId: "minimax/MiniMax-M2.7" })),
        cccConfinement: Object.freeze({ bash: CONFINED_BASH, fs: FS_OPERATIONS }),
      }),
      message: /model minimax\/MiniMax-M2\.7 must be the session default model minimax\/MiniMax-M3/,
    },
    {
      label: "a planning-linked-writer binding when the session names no default model",
      overrides: () => ({
        cccProviderAttemptBinding: linkedWriterBinding(),
        cccConfinement: Object.freeze({ bash: CONFINED_BASH, fs: FS_OPERATIONS }),
        defaultModelId: undefined,
      }),
      message: /model minimax\/MiniMax-M3 must be the session default model undefined/,
    },
    {
      label: "a planning binding whose bound model is not the session's default model",
      // A planning route binding's modelId is a closed set of exact models, so the session default is the one that differs.
      overrides: () => ({ defaultModelId: "minimax/MiniMax-M2.7" }),
      message: /model minimax\/MiniMax-M3 must be the session default model minimax\/MiniMax-M2\.7/,
    },
    // E5-P1 items 8 and 12: the confinement's runtime shape.
    {
      label: "an empty confinement object under a policy that allows bash",
      overrides: () => ({ cccProviderAttemptBinding: linkedWriterBinding(), cccConfinement: Object.freeze({}) }),
      message: /cccConfinement\.fs/,
    },
    {
      label: "a confinement with no bash key under a policy that allows bash",
      overrides: () => ({ cccProviderAttemptBinding: linkedWriterBinding(), cccConfinement: Object.freeze({ fs: FS_OPERATIONS }) }),
      message: /cccConfinement\.bash/,
    },
    {
      label: "a confined bash with no exec function",
      overrides: () => ({
        cccProviderAttemptBinding: linkedWriterBinding(),
        cccConfinement: Object.freeze({ bash: Object.freeze({ dispose: CONFINED_BASH.dispose }), fs: FS_OPERATIONS }),
      }),
      message: /cccConfinement\.bash/,
    },
    {
      label: "a confined bash with no dispose function",
      overrides: () => ({
        cccProviderAttemptBinding: linkedWriterBinding(),
        cccConfinement: Object.freeze({ bash: Object.freeze({ exec: CONFINED_BASH.exec }), fs: FS_OPERATIONS }),
      }),
      message: /cccConfinement\.bash/,
    },
    {
      label: "confined file operations whose find has no glob",
      overrides: () => ({
        cccConfinement: Object.freeze({ bash: null, fs: Object.freeze({ ...FS_OPERATIONS, find: Object.freeze({ exists: () => true }) }) }),
      }),
      message: /cccConfinement\.fs\.find\.glob/,
    },
    {
      label: "confined file operations with a missing operation set",
      overrides: () => ({
        cccConfinement: Object.freeze({ bash: null, fs: Object.freeze({ read: FS_OPERATIONS.read, write: FS_OPERATIONS.write }) }),
      }),
      message: /cccConfinement\.fs/,
    },
    // E5-P1 item 9: the tool policy matches the binding.
    {
      label: "a tool policy whose allowed tools are not the role class toolset",
      overrides: () => ({ cccProviderAttemptBinding: planningBinding(undefined, criticPolicyWith({ allowedTools: CCC_PLANNING_TOOLSETS.author })) }),
      message: /allowedTools/,
    },
    {
      label: "a probe tool policy without the probe tool",
      overrides: () => ({ cccProviderAttemptBinding: planningBinding(undefined, criticPolicyWith({ policyId: "ccc-critic-probe-tools.v1" })) }),
      message: /allowedTools/,
    },
    {
      label: "a tool policy whose denied names omit one of CCC_PLANNING_DENIED_NAMES",
      overrides: () => ({
        cccProviderAttemptBinding: planningBinding(undefined, criticPolicyWith({
          deniedNames: Object.freeze(CCC_PLANNING_DENIED_NAMES.filter((name) => name !== ".envrc")),
        })),
      }),
      message: /deniedNames/,
    },
    {
      label: "a tool policy whose toolset digest is not the route binding's",
      overrides: () => ({ cccProviderAttemptBinding: planningBinding(undefined, criticPolicyWith({ toolsetDigest: "6".repeat(64) })) }),
      message: /toolsetDigest/,
    },
    {
      label: "a tool policy whose role class is not the route binding's",
      overrides: () => ({ cccProviderAttemptBinding: planningBinding(undefined, CRITIC_POLICY, Object.freeze({ ...ROUTE, roleClass: "author" as const })) }),
      message: /role class/,
    },
    {
      label: "a tool policy on a campaign-scope binding",
      overrides: () => {
        const factory = planningBinding();
        return {
          cccProviderAttemptBinding: Object.freeze({
            turnKey: TURN_KEY,
            controller: factory.controller,
            receiptAdapterId: ADAPTER,
            toolPolicy: CRITIC_POLICY,
          }),
        };
      },
      message: /toolPolicy is only for planning/,
    },
  ];

  for (const { label, overrides, message } of SESSION_REFUSALS) it(`refuses ${label} at session creation`, async () => {
    prepareSession({ provider: M3_KEY, id: "minimax/MiniMax-M3" });

    await expect(createFnAgent(sessionOptions(overrides()) as any)).rejects.toThrow(message);
    expect(ModelRuntime.create).not.toHaveBeenCalled();
  });

  it("positive control: a linked writer with a confined bash and the linked writer policy creates its session", async () => {
    prepareSession({ provider: M3_KEY, id: "minimax/MiniMax-M3" });

    await expect(createFnAgent({
      cwd: "/test/project",
      systemPrompt: "planning provider binding",
      defaultProvider: M3_KEY,
      defaultModelId: "minimax/MiniMax-M3",
      profile: "ccc-fusion",
      subscriptionReady: true,
      cccProviderAttemptBinding: linkedWriterBinding(),
      cccConfinement: Object.freeze({ bash: CONFINED_BASH, fs: FS_OPERATIONS }),
      cccStreamGuard: STREAM_GUARD,
      cccProviderPinCheck: pinCheck,
    })).resolves.toBeDefined();
    expect(pinCheck).toHaveBeenCalledWith(PROVIDERS);
  });

  it("positive control (E7-P item 7): a planning-linked-writer controller marked with attachCccProviderAttemptBoundRoute creates its session", async () => {
    prepareSession({ provider: M3_KEY, id: "minimax/MiniMax-M3" });
    const binding = Object.freeze({
      turnKey: TURN_KEY,
      controller: attachCccProviderAttemptBoundRoute(plainController(), LINKED_WRITER_ROUTE),
      receiptAdapterId: ADAPTER,
      scopeKind: "planning-linked-writer" as const,
      toolPolicy: LINKED_WRITER_POLICY,
    });

    await expect(createFnAgent(sessionOptions({
      cccProviderAttemptBinding: binding,
      cccConfinement: Object.freeze({ bash: CONFINED_BASH, fs: FS_OPERATIONS }),
    }) as any)).resolves.toBeDefined();
    expect(pinCheck).toHaveBeenCalledWith(PROVIDERS);
    expect(ModelRuntime.create).toHaveBeenCalledTimes(1);
  });

  it("positive control: a probe tool policy with exactly the role toolset plus the probe tool creates its session", async () => {
    prepareSession({ provider: M3_KEY, id: "minimax/MiniMax-M3" });
    const probePolicy = criticPolicyWith({
      policyId: "ccc-critic-probe-tools.v1",
      allowedTools: Object.freeze([...CCC_PLANNING_TOOLSETS.critic, CCC_PLANNING_PROBE_TOOL].sort()),
    });

    await expect(createFnAgent(sessionOptions({ cccProviderAttemptBinding: planningBinding(undefined, probePolicy) }) as any))
      .resolves.toBeDefined();
    expect(pinCheck).toHaveBeenCalledTimes(1);
  });
});
