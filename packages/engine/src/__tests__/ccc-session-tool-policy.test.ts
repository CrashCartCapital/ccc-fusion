import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Type } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createGrepTool,
  createReadTool,
  DefaultPackageManager,
  DefaultResourceLoader,
  discoverAndLoadExtensions,
  ModelRegistry,
  ModelRuntime,
  type AgentSession,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  CCC_PLANNING_DENIED_NAMES,
  CCC_PLANNING_LINKED_WRITER_TOOLSET,
  CCC_PLANNING_TOOLSETS,
  type CccPlanningRouteBinding,
  type CustomProvider,
} from "@fusion/core";
import { attachCccProviderAttemptBoundRoute, createFnAgent, setHostExtensionPaths } from "../pi.js";
import { createSkillsOverrideFromSelection, resolveSessionSkills } from "../skill-resolver.js";
import { createCccPlanningProviderAttemptBinding } from "../ccc-planning/provider-binding.js";
import { createCccCampaignReadyTool } from "../ccc-campaign-ready.js";
import { connectMcpSessionTools } from "../mcp-session-tools.js";
import { CCC_CONFINED_TOOL_MARK, createCccConfinedFsOperations } from "../ccc-confinement/confined-fs-tools.js";
import {
  assertCccPolicySessionFinalTools,
  assertCccSessionToolSet,
  buildCccSessionToolPolicy,
  cccSessionToolsetDigest,
  createCccConfinedSessionTools,
} from "../ccc-confinement/session-tool-policy.js";
import { createCccVerdictTool } from "../ccc-confinement/verdict-tool.js";
import type { CccConfinement, CccSessionToolPolicy } from "../agent-runtime.js";

/*
FNXC:CccSessionToolPolicy 2026-10-14-21:02:
Card C2 proof for the closed session tool policy (D11, CONTRACT-v3 sections 2.12 and 2.13, verify-v2 item 37). A planning session gets exactly its policy tools: createFnAgent refuses an MCP server, a builtin or tools allowlist entry and a custom tool outside the policy, and an unmarked tool under a confined name, with CCC_SESSION_TOOL_POLICY_REFUSED before any MCP connection or session. The refusal is non-vacuous: the same options without the binding create a session that offers WebFetch today. A critic session's final tools equal its five names, its grep is the confined grep (Pi's grep is never created), and host extensions and skills are off. A linked writer keeps fn_complete_phase through the wrapper chain and is refused without it; buildCccSessionToolPolicy and assertCccSessionToolSet bind names, parameters (the toolset digest) and the confinement mark.
*/

vi.mock("../skill-resolver.js", () => ({
  resolveSessionSkills: vi.fn(),
  createSkillsOverrideFromSelection: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    LegacyCredentialStorage: { create: vi.fn(() => ({ getCredentials: vi.fn().mockResolvedValue({}) })) },
    createAgentSession: vi.fn(),
    createCodingTools: vi.fn(() => []),
    createReadOnlyTools: vi.fn(() => []),
    createReadTool: vi.fn(actual.createReadTool),
    createBashTool: vi.fn(actual.createBashTool),
    createEditTool: vi.fn(actual.createEditTool),
    createWriteTool: vi.fn(actual.createWriteTool),
    createGrepTool: vi.fn(actual.createGrepTool),
    createFindTool: vi.fn(actual.createFindTool),
    createLsTool: vi.fn(actual.createLsTool),
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
    DefaultPackageManager: vi.fn().mockImplementation(function () {
      return {
        resolve: vi.fn().mockResolvedValue({
          extensions: EXTENSION_PATHS.map((path, index) => ({
            path,
            enabled: true,
            metadata: { source: path, scope: index === 0 ? "project" : "user", origin: "package" },
          })),
          skills: [],
          prompts: [],
          themes: [],
        }),
      };
    }),
    discoverAndLoadExtensions: vi.fn().mockImplementation(async () => {
      extensionFactorySideEffect();
      return { extensions: [], errors: [], runtime: { pendingProviderRegistrations: [] } };
    }),
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
  };
});

vi.mock("../mcp-session-tools.js", () => ({
  connectMcpSessionTools: vi.fn().mockResolvedValue({ tools: [], connected: [], skipped: [], toolSources: [], dispose: vi.fn() }),
  buildMcpCapabilityPrompt: vi.fn(() => ""),
}));

const { PROVIDERS, EXTENSION_PATHS, extensionFactorySideEffect } = vi.hoisted(() => ({
  EXTENSION_PATHS: ["/synthetic/c2-project-extension.ts", "/synthetic/c2-user-extension.ts"],
  extensionFactorySideEffect: vi.fn(),
  PROVIDERS: [
    {
      id: "provider-m3",
      name: "OmniRoute MiniMax M3 Pinned",
      apiType: "openai-compatible",
      baseUrl: "http://127.0.0.1:8092/v1",
      models: [{ id: "minimax/MiniMax-M3", name: "MiniMax M3" }],
    },
  ] as CustomProvider[],
}));

vi.mock("../custom-providers.js", () => ({ readCustomProviders: vi.fn(() => PROVIDERS) }));

const M3_KEY = "omniroute-minimax-m3-pinned";
const MODEL_ID = "minimax/MiniMax-M3";
const ADAPTER = "terminal-route-sse-comments.v1" as const;
const TURN_KEY = "ccc-plan-turn:intent:acceptance-reviewer:1";
const DENIED = [...CCC_PLANNING_DENIED_NAMES];
const MCP_SERVER = { name: "docs", transport: "stdio", command: "/bin/false", args: [] };

const parent = realpathSync(mkdtempSync(join(tmpdir(), "ccc-c2-policy-")));
const root = join(parent, "project");
mkdirSync(join(root, "src"), { recursive: true });
afterAll(() => {
  rmSync(parent, { recursive: true, force: true });
});

const readOnlyConfinement: CccConfinement = Object.freeze({
  bash: null,
  fs: createCccConfinedFsOperations({ readRoots: [root], writeRoots: [], deniedNames: DENIED }),
});
const writerConfinement: CccConfinement = Object.freeze({
  bash: Object.freeze({
    exec: async () => ({ exitCode: 0 }),
    dispose: async () => Object.freeze({ closure: "confirmed" as const }),
  }),
  fs: createCccConfinedFsOperations({ readRoots: [root], writeRoots: [join(root, "src")], deniedNames: DENIED }),
});

const verdictTool = createCccVerdictTool({ requirementIds: null, artifactKeys: [], reviewedPaths: null, onVerdict: vi.fn() });
const readyTool = () => createCccCampaignReadyTool({ mode: "phase-signal", signalPhaseCompletion: vi.fn() });

const confinedTools = (names: readonly string[], confinement: CccConfinement) =>
  createCccConfinedSessionTools({ names, confinement, cwd: root, readRoots: [root], deniedNames: DENIED });
const criticTools = (): ToolDefinition[] => [...confinedTools(["find", "grep", "ls", "read"], readOnlyConfinement), verdictTool];
const writerTools = (): ToolDefinition[] => confinedTools(CCC_PLANNING_TOOLSETS.writer, writerConfinement);

const CRITIC_POLICY = buildCccSessionToolPolicy({ roleClass: "critic", readRoots: [root], writeRoots: [], tools: criticTools() });

function criticRoute(toolsetDigest: string): CccPlanningRouteBinding {
  return Object.freeze({
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
    modelId: MODEL_ID,
    transport: "pi",
    receiptAdapterId: ADAPTER,
    toolsetDigest,
    promptDigest: "2".repeat(64),
    policyDigest: "3".repeat(64),
    grantDigest: "4".repeat(64),
    bindingHash: "5".repeat(64),
  }) as CccPlanningRouteBinding;
}

const plainController = () => Object.freeze({ preDispatch: vi.fn(), reconcile: vi.fn() });

function criticBinding(policy: CccSessionToolPolicy = CRITIC_POLICY) {
  return createCccPlanningProviderAttemptBinding({
    controller: plainController() as never,
    binding: criticRoute(policy.toolsetDigest),
    turnKey: TURN_KEY,
    toolPolicy: policy,
  });
}

function linkedWriterBinding(policy: CccSessionToolPolicy) {
  return Object.freeze({
    turnKey: TURN_KEY,
    controller: attachCccProviderAttemptBoundRoute(plainController() as never, {
      providerId: M3_KEY,
      modelId: MODEL_ID,
      transport: "pi",
      roleClass: "writer",
      toolsetDigest: policy.toolsetDigest,
    }),
    receiptAdapterId: ADAPTER,
    scopeKind: "planning-linked-writer" as const,
    toolPolicy: policy,
  });
}

function prepareSession() {
  const modelRuntime = {
    getAuth: vi.fn(async () => ({ auth: { headers: {} } })),
    stream: vi.fn(),
    streamSimple: vi.fn(),
    complete: vi.fn(),
    completeSimple: vi.fn(),
  };
  const session = { model: { provider: M3_KEY, id: MODEL_ID }, prompt: vi.fn(), subscribe: vi.fn(), dispose: vi.fn(), sessionFile: undefined } as unknown as AgentSession;
  vi.mocked(ModelRuntime.create).mockResolvedValueOnce(modelRuntime as never);
  vi.mocked(createAgentSession).mockReset();
  vi.mocked(createAgentSession).mockResolvedValueOnce({ session } as never);
}

const STREAM_GUARD = Object.freeze({
  observeDelta: () => ({ degenerate: false as const }),
  observeMessage: () => ({ degenerate: false as const }),
});

function sessionOptions(overrides: Record<string, unknown> = {}) {
  return {
    cwd: root,
    systemPrompt: "planning session tools",
    defaultProvider: M3_KEY,
    defaultModelId: MODEL_ID,
    profile: "ccc-fusion",
    subscriptionReady: true,
    cccProviderAttemptBinding: criticBinding(),
    cccConfinement: readOnlyConfinement,
    cccStreamGuard: STREAM_GUARD,
    cccProviderPinCheck: vi.fn(),
    customTools: [verdictTool],
    ...overrides,
  };
}

type SessionArgs = { customTools: ToolDefinition[]; tools?: string[] };
const sessionArgs = (): SessionArgs => vi.mocked(createAgentSession).mock.calls.at(-1)![0] as unknown as SessionArgs;
const finalNames = () => sessionArgs().customTools.map((tool) => tool.name).sort();
const marked = (tool: unknown) => (tool as Record<PropertyKey, unknown>)[CCC_CONFINED_TOOL_MARK] === true;

describe("closed session tool policy (card C2, D11)", () => {
  beforeEach(() => {
    vi.mocked(ModelRuntime.create).mockReset();
    vi.mocked(ModelRegistry).mockClear();
    vi.mocked(createAgentSession).mockReset();
    vi.mocked(createGrepTool).mockClear();
    vi.mocked(connectMcpSessionTools).mockClear();
    vi.mocked(DefaultPackageManager).mockClear();
    vi.mocked(DefaultResourceLoader).mockClear();
    vi.mocked(discoverAndLoadExtensions).mockClear();
    extensionFactorySideEffect.mockClear();
  });

  it("refuses a critic session given tools readonly, builtinToolsAllowlist WebFetch and one MCP server with CCC_SESSION_TOOL_POLICY_REFUSED before any MCP connection or session", async () => {
    prepareSession();
    const refused = createFnAgent(sessionOptions({ tools: "readonly", builtinToolsAllowlist: ["WebFetch"], mcpServers: [MCP_SERVER] }) as never);

    await expect(refused).rejects.toMatchObject({ code: "CCC_SESSION_TOOL_POLICY_REFUSED" });
    await expect(refused).rejects.toThrow(/WebFetch/);
    await expect(refused).rejects.toThrow(/MCP/);
    expect(connectMcpSessionTools).not.toHaveBeenCalled();
    expect(createAgentSession).not.toHaveBeenCalled();
  });

  it("positive control: the same options with no binding policy yield a session containing WebFetch", async () => {
    prepareSession();
    await createFnAgent(sessionOptions({
      tools: "readonly",
      builtinToolsAllowlist: ["WebFetch"],
      mcpServers: [MCP_SERVER],
      cccProviderAttemptBinding: undefined,
    }) as never);

    expect(sessionArgs().tools).toContain("WebFetch");
    expect(createGrepTool).toHaveBeenCalled();
  });

  it("policy-bound critic and linked writer sessions never discover extensions or execute their factories, while the explicit M3 provider still registers", async () => {
    /*
    FNXC:CccSessionToolPolicy 2026-10-15-05:07:
    The C2 extension-boundary successor covers provider bootstrap before the resource loader: enabled project and user package extensions would execute a factory during discovery, so a policy must prevent discovery itself while preserving explicit custom-provider registration.
    */
    const linked = buildCccSessionToolPolicy({
      roleClass: "writer",
      linkedWriter: true,
      readRoots: [root],
      writeRoots: [join(root, "src")],
      tools: [...writerTools(), readyTool()],
    });
    for (const options of [
      sessionOptions(),
      sessionOptions({
        cccProviderAttemptBinding: linkedWriterBinding(linked),
        cccConfinement: writerConfinement,
        customTools: [readyTool()],
      }),
    ]) {
      prepareSession();
      await createFnAgent(options as never);

      expect({
        packageDiscovery: vi.mocked(DefaultPackageManager).mock.calls.length,
        extensionDiscovery: vi.mocked(discoverAndLoadExtensions).mock.calls.length,
        factoryEffects: extensionFactorySideEffect.mock.calls.length,
      }).toEqual({ packageDiscovery: 0, extensionDiscovery: 0, factoryEffects: 0 });
      const registry = vi.mocked(ModelRegistry).mock.results.at(-1)!.value as ModelRegistry;
      expect(registry.registerProvider).toHaveBeenCalledWith(M3_KEY, expect.objectContaining({
        baseUrl: PROVIDERS[0]!.baseUrl,
        models: expect.arrayContaining([expect.objectContaining({ id: MODEL_ID })]),
      }));
      expect(createAgentSession).toHaveBeenCalledTimes(1);
    }
  });

  it("positive control: an unbound legacy session discovers enabled project and user extensions and executes their factories", async () => {
    prepareSession();
    await createFnAgent(sessionOptions({ cccProviderAttemptBinding: undefined }) as never);

    expect(DefaultPackageManager).toHaveBeenCalledTimes(1);
    expect(discoverAndLoadExtensions).toHaveBeenCalledTimes(1);
    expect(discoverAndLoadExtensions).toHaveBeenCalledWith(
      expect.arrayContaining(EXTENSION_PATHS),
      root,
      join(root, ".fusion", "disabled-auto-extension-discovery"),
    );
    expect(extensionFactorySideEffect).toHaveBeenCalledTimes(1);
    expect(createAgentSession).toHaveBeenCalledTimes(1);
  });

  it("a critic session's final tools equal exactly the 5 critic names, its grep carries CCC_CONFINED_TOOL_MARK, Pi's grep is never created, and host extensions and skills are off", async () => {
    /*
    FNXC:CccSessionToolPolicy 2026-10-14-22:48:
    Card C2 repair 1. Pi 0.81.1's noExtensions and noSkills flags do not drop additionalExtensionPaths or additionalSkillPaths, so this test gives the session a host extension path, an additional skill path and a skill selection, and proves none of them reaches the resource loader under a policy; the positive control shows the same inputs do reach it without one.
    */
    const skillsOverride = vi.fn();
    vi.mocked(resolveSessionSkills).mockReturnValue({ skills: [], diagnostics: [] } as never);
    vi.mocked(createSkillsOverrideFromSelection).mockReturnValue(skillsOverride as never);
    setHostExtensionPaths(["/nonexistent/c2-host-ext"]);
    const skillInputs = { additionalSkillPaths: [root], skills: ["c2-skill"] };
    try {
      prepareSession();
      await createFnAgent(sessionOptions(skillInputs) as never);

      expect(finalNames()).toEqual([...CCC_PLANNING_TOOLSETS.critic]);
      expect(sessionArgs().tools).toEqual([...CCC_PLANNING_TOOLSETS.critic]);
      const grep = sessionArgs().customTools.find((tool) => tool.name === "grep");
      expect(marked(grep)).toBe(true);
      for (const name of ["find", "ls", "read"]) expect(marked(sessionArgs().customTools.find((tool) => tool.name === name))).toBe(true);
      expect(createGrepTool).not.toHaveBeenCalled();
      const loaderOptions = vi.mocked(DefaultResourceLoader).mock.calls.at(-1)?.[0] as unknown as Record<string, unknown>;
      expect(loaderOptions).toMatchObject({ noExtensions: true, noSkills: true });
      expect(loaderOptions).not.toHaveProperty("additionalExtensionPaths");
      expect(loaderOptions).not.toHaveProperty("additionalSkillPaths");
      expect(loaderOptions).not.toHaveProperty("skillsOverride");

      // Positive control: without the policy the same host extension path, skill path and skill selection reach the loader.
      prepareSession();
      await createFnAgent(sessionOptions({ ...skillInputs, cccProviderAttemptBinding: undefined }) as never);
      const openOptions = vi.mocked(DefaultResourceLoader).mock.calls.at(-1)?.[0] as unknown as Record<string, unknown>;
      expect(openOptions.additionalExtensionPaths).toEqual(["/nonexistent/c2-host-ext"]);
      expect(openOptions.additionalSkillPaths).toEqual([expect.any(String)]);
      expect(openOptions.skillsOverride).toBe(skillsOverride);
    } finally {
      setHostExtensionPaths([]);
      vi.mocked(resolveSessionSkills).mockReset();
      vi.mocked(createSkillsOverrideFromSelection).mockReset();
    }
  });

  it("refuses an out-of-policy custom tool, toolsAllowlist entry or builtinToolsAllowlist entry, and an unmarked tool named grep; positive control: in-policy entries create the session", async () => {
    const extraTool = { ...verdictTool, name: "fn_task_create" } as ToolDefinition;
    const unmarkedGrep = { ...createGrepTool(root), name: "grep" } as unknown as ToolDefinition;
    const refusals: Array<[Record<string, unknown>, RegExp]> = [
      [{ customTools: [verdictTool, extraTool] }, /fn_task_create/],
      [{ toolsAllowlist: ["read", "bash"] }, /bash/],
      [{ builtinToolsAllowlist: ["WebSearch"] }, /WebSearch/],
      [{ customTools: [verdictTool, unmarkedGrep] }, /grep is not a Fusion confined tool/],
    ];
    for (const [overrides, message] of refusals) {
      prepareSession();
      const refused = createFnAgent(sessionOptions(overrides) as never);
      await expect(refused).rejects.toMatchObject({ code: "CCC_SESSION_TOOL_POLICY_REFUSED" });
      await expect(refused).rejects.toThrow(message);
      expect(createAgentSession).not.toHaveBeenCalled();
    }

    prepareSession();
    await createFnAgent(sessionOptions({ toolsAllowlist: ["read", "grep"], builtinToolsAllowlist: [] }) as never);
    expect(finalNames()).toEqual([...CCC_PLANNING_TOOLSETS.critic]);
  });

  it("buildCccSessionToolPolicy for a linked writer gives ccc-linked-writer-tools.v1 and CCC_PLANNING_LINKED_WRITER_TOOLSET; assertCccSessionToolSet admits the ready tool and refuses the set without it and a plain writer policy with it", () => {
    const linked = buildCccSessionToolPolicy({
      roleClass: "writer",
      linkedWriter: true,
      readRoots: [root],
      writeRoots: [join(root, "src")],
      tools: [...writerTools(), readyTool()],
    });
    expect(linked.policyId).toBe("ccc-linked-writer-tools.v1");
    expect(linked.allowedTools).toEqual([...CCC_PLANNING_LINKED_WRITER_TOOLSET]);
    expect(Object.isFrozen(linked)).toBe(true);
    expect(Object.keys(linked).sort()).toEqual(["allowedTools", "deniedNames", "policyId", "readRoots", "toolsetDigest", "writeRoots"]);

    expect(() => assertCccSessionToolSet(linked, [...writerTools(), readyTool()])).not.toThrow();
    expect(() => assertCccSessionToolSet(linked, writerTools())).toThrow(expect.objectContaining({ code: "CCC_SESSION_TOOL_POLICY_REFUSED" }));
    const plain = buildCccSessionToolPolicy({ roleClass: "writer", readRoots: [root], writeRoots: [join(root, "src")], tools: writerTools() });
    expect(plain.policyId).toBe("ccc-writer-tools.v1");
    expect(() => assertCccSessionToolSet(plain, writerTools())).not.toThrow();
    expect(() => assertCccSessionToolSet(plain, [...writerTools(), readyTool()])).toThrow(expect.objectContaining({ code: "CCC_SESSION_TOOL_POLICY_REFUSED" }));
  });

  it("linkedWriter true with any other role class throws, a critic with write roots throws, and a fn_complete_phase that is not the campaign ready tool is refused", () => {
    for (const roleClass of ["author", "researcher", "critic"] as const) {
      expect(() => buildCccSessionToolPolicy({ roleClass, linkedWriter: true, readRoots: [root], writeRoots: [], tools: criticTools() }))
        .toThrow(/linked/);
    }
    expect(() => buildCccSessionToolPolicy({ roleClass: "critic", readRoots: [root], writeRoots: [root], tools: criticTools() }))
      .toThrow(/writeRoots/);
    const lookalike = { ...readyTool(), description: "Complete anything you like." } as ToolDefinition;
    expect(() => buildCccSessionToolPolicy({ roleClass: "writer", linkedWriter: true, readRoots: [root], writeRoots: [], tools: [...writerTools(), lookalike] }))
      .toThrow(expect.objectContaining({ code: "CCC_SESSION_TOOL_POLICY_REFUSED" }));
  });

  it("assertCccSessionToolSet refuses changed parameters and Pi's own grep under the grep name; positive control: the built tools pass", () => {
    expect(() => assertCccSessionToolSet(CRITIC_POLICY, criticTools())).not.toThrow();
    const reparametered = criticTools().map((tool) => (tool.name === "read" ? { ...tool, parameters: Type.Object({}) } : tool));
    expect(() => assertCccSessionToolSet(CRITIC_POLICY, reparametered)).toThrow(/digest/);
    const piGrep = criticTools().map((tool) => (tool.name === "grep" ? (createGrepTool(root) as unknown as ToolDefinition) : tool));
    expect(() => assertCccSessionToolSet(CRITIC_POLICY, piGrep)).toThrow(expect.objectContaining({ code: "CCC_SESSION_TOOL_POLICY_REFUSED" }));
    expect(() => assertCccSessionToolSet(CRITIC_POLICY, piGrep)).toThrow(/grep is not a Fusion confined tool/);
  });

  it("a frozen structural copy of an issued policy gets the full final check: a critic copy without its verdict tool or with a foreign ccc_submit_verdict, and a linked writer copy without fn_complete_phase, are refused; positive control: the copies with their tools create sessions", async () => {
    /*
    FNXC:CccSessionToolPolicy 2026-10-14-22:48:
    Card C2 repair 1 (D11, verify-v2 item 37). createFnAgent recognises an issued policy by its content, not its object identity, so a caller that spreads, rebuilds or deserializes the policy it was issued still gets the names, digest and Fusion-tool check.
    */
    const criticCopy = Object.freeze({ ...CRITIC_POLICY }) as CccSessionToolPolicy;
    expect(criticCopy).not.toBe(CRITIC_POLICY);
    const foreignVerdict = { ...verdictTool, parameters: Type.Object({ anything: Type.String() }) } as ToolDefinition;
    for (const customTools of [[], [foreignVerdict]]) {
      prepareSession();
      await expect(createFnAgent(sessionOptions({ cccProviderAttemptBinding: criticBinding(criticCopy), customTools }) as never))
        .rejects.toMatchObject({ code: "CCC_SESSION_TOOL_POLICY_REFUSED" });
      expect(createAgentSession).not.toHaveBeenCalled();
    }
    const linked = buildCccSessionToolPolicy({
      roleClass: "writer",
      linkedWriter: true,
      readRoots: [root],
      writeRoots: [join(root, "src")],
      tools: [...writerTools(), readyTool()],
    });
    const linkedCopy = Object.freeze({ ...linked }) as CccSessionToolPolicy;
    const linkedOptions = (customTools: ToolDefinition[]) => sessionOptions({
      cccProviderAttemptBinding: linkedWriterBinding(linkedCopy),
      cccConfinement: writerConfinement,
      customTools,
    });
    prepareSession();
    await expect(createFnAgent(linkedOptions([]) as never)).rejects.toMatchObject({ code: "CCC_SESSION_TOOL_POLICY_REFUSED" });
    expect(createAgentSession).not.toHaveBeenCalled();

    // Positive control: each copy with its own tools creates its session.
    prepareSession();
    await createFnAgent(sessionOptions({ cccProviderAttemptBinding: criticBinding(criticCopy) }) as never);
    expect(finalNames()).toEqual([...CCC_PLANNING_TOOLSETS.critic]);
    prepareSession();
    await createFnAgent(linkedOptions([readyTool()]) as never);
    expect(finalNames()).toEqual([...CCC_PLANNING_LINKED_WRITER_TOOLSET]);
  });

  it("createFnAgent refuses a policy not built by buildCccSessionToolPolicy: a hand-built critic policy without ccc_submit_verdict, with a foreign one or even with its own, and a hand-built linked-writer policy without fn_complete_phase are refused before any MCP connection or session; positive control: the same roles built through buildCccSessionToolPolicy create their sessions", async () => {
    /*
    FNXC:CccSessionToolPolicy 2026-10-15-00:24:
    Card C2 repair 2 (errata E14 item C2-3; D11, verify-v2 item 37). The final tool set is checked in full for every policy, and a policy this process never built is refused: before this repair a hand-built policy got only a names check, so a critic session without its verdict tool, a critic with a foreign ccc_submit_verdict and a linked writer without fn_complete_phase were all created, under a toolset digest that pinned nothing.
    */
    const handCritic: CccSessionToolPolicy = Object.freeze({
      policyId: "ccc-critic-tools.v1",
      allowedTools: Object.freeze([...CCC_PLANNING_TOOLSETS.critic]),
      toolsetDigest: "1".repeat(64),
      readRoots: Object.freeze([root]),
      writeRoots: Object.freeze([]),
      deniedNames: Object.freeze([...DENIED]),
    });
    const handLinked: CccSessionToolPolicy = Object.freeze({
      policyId: "ccc-linked-writer-tools.v1",
      allowedTools: Object.freeze([...CCC_PLANNING_LINKED_WRITER_TOOLSET]),
      toolsetDigest: "7".repeat(64),
      readRoots: Object.freeze([root]),
      writeRoots: Object.freeze([join(root, "src")]),
      deniedNames: Object.freeze([...DENIED]),
    });
    const foreignVerdict = { ...verdictTool, parameters: Type.Object({ anything: Type.String() }) } as ToolDefinition;
    const notBuilt = /not built by buildCccSessionToolPolicy/;

    for (const customTools of [[], [foreignVerdict], [verdictTool]]) {
      prepareSession();
      vi.mocked(createReadTool).mockClear();
      const refused = createFnAgent(sessionOptions({ cccProviderAttemptBinding: criticBinding(handCritic), customTools }) as never);
      await expect(refused).rejects.toMatchObject({ code: "CCC_SESSION_TOOL_POLICY_REFUSED" });
      await expect(refused).rejects.toThrow(notBuilt);
      // Refused while the session tools are resolved: no confined tool is ever built for a policy this process did not build.
      expect(createReadTool).not.toHaveBeenCalled();
      expect(connectMcpSessionTools).not.toHaveBeenCalled();
      expect(createAgentSession).not.toHaveBeenCalled();
    }
    prepareSession();
    const linkedRefused = createFnAgent(sessionOptions({
      cccProviderAttemptBinding: linkedWriterBinding(handLinked),
      cccConfinement: writerConfinement,
      customTools: [],
    }) as never);
    await expect(linkedRefused).rejects.toMatchObject({ code: "CCC_SESSION_TOOL_POLICY_REFUSED" });
    await expect(linkedRefused).rejects.toThrow(notBuilt);
    expect(createAgentSession).not.toHaveBeenCalled();

    // The final check itself holds a hand-built policy to the full set: missing tools are named beside the provenance refusal.
    expect(() => assertCccPolicySessionFinalTools(handCritic, criticTools().filter((tool) => tool.name !== "ccc_submit_verdict")))
      .toThrow(/ccc_submit_verdict is missing/);
    expect(() => assertCccPolicySessionFinalTools(handLinked, writerTools())).toThrow(/fn_complete_phase is missing/);
    expect(() => assertCccPolicySessionFinalTools(handCritic, criticTools())).toThrow(notBuilt);
    // A hand-built policy whose names and digest do match its tools is still refused, on provenance alone. Its read root
    // differs from CRITIC_POLICY's, so its content is not that of the issued policy.
    const handExact: CccSessionToolPolicy = Object.freeze({
      ...handCritic,
      toolsetDigest: cccSessionToolsetDigest(criticTools()),
      readRoots: Object.freeze([parent]),
    });
    expect(() => assertCccSessionToolSet(handExact, criticTools())).not.toThrow();
    expect(() => assertCccPolicySessionFinalTools(handExact, criticTools())).toThrow(notBuilt);

    // Positive control: the same roles built through buildCccSessionToolPolicy create their sessions.
    expect(() => assertCccPolicySessionFinalTools(CRITIC_POLICY, criticTools())).not.toThrow();
    prepareSession();
    vi.mocked(createReadTool).mockClear();
    await createFnAgent(sessionOptions() as never);
    expect(finalNames()).toEqual([...CCC_PLANNING_TOOLSETS.critic]);
    expect(createReadTool).toHaveBeenCalledTimes(1);
    const linked = buildCccSessionToolPolicy({
      roleClass: "writer",
      linkedWriter: true,
      readRoots: [root],
      writeRoots: [join(root, "src")],
      tools: [...writerTools(), readyTool()],
    });
    prepareSession();
    await createFnAgent(sessionOptions({
      cccProviderAttemptBinding: linkedWriterBinding(linked),
      cccConfinement: writerConfinement,
      customTools: [readyTool()],
    }) as never);
    expect(finalNames()).toEqual([...CCC_PLANNING_LINKED_WRITER_TOOLSET]);
  });

  it("a linked writer session through createFnAgent keeps fn_complete_phase through the wrapper chain and is refused without it", async () => {
    const policy = buildCccSessionToolPolicy({
      roleClass: "writer",
      linkedWriter: true,
      readRoots: [root],
      writeRoots: [join(root, "src")],
      tools: [...writerTools(), readyTool()],
    });
    const options = (customTools: ToolDefinition[]) => sessionOptions({
      cccProviderAttemptBinding: linkedWriterBinding(policy),
      cccConfinement: writerConfinement,
      customTools,
    });

    prepareSession();
    await createFnAgent(options([readyTool()]) as never);
    expect(finalNames()).toEqual([...CCC_PLANNING_LINKED_WRITER_TOOLSET]);
    expect(sessionArgs().customTools.find((tool) => tool.name === "fn_complete_phase")?.label).toBe("Complete Campaign Phase");

    prepareSession();
    await expect(createFnAgent(options([]) as never)).rejects.toMatchObject({ code: "CCC_SESSION_TOOL_POLICY_REFUSED" });
    expect(createAgentSession).not.toHaveBeenCalled();
  });
});
