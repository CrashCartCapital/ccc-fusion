import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createAgentSession,
  createBashTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import {
  createFnAgent,
  isCccCampaignDiscoveryToolCall,
  wrapToolsWithCccCampaignPhaseToolPolicy,
} from "../pi.js";
import { connectMcpSessionTools } from "../mcp-session-tools.js";

/*
FNXC:CCCCampaignFallback 2026-08-01-17:10:
A ccc-fusion campaign turn is a sealed provider/model route: the executor seals
one attempt binding for exactly one provider identity. A settings-derived
fallback model is outside that admitted route, so this suite proves the pi seam
refuses the swap instead of silently re-pinning the expected-identity marker to
the fallback. Every session here is a synthetic in-memory object; no provider,
credential, network, or filesystem effect participates.
*/

vi.mock("../skill-resolver.js", () => ({
  resolveSessionSkills: vi.fn(),
  createSkillsOverrideFromSelection: vi.fn(),
}));

// Keep custom-provider resolution deterministic and off the operator's real
// ~/.fusion/settings.json; the CCC egress guard reads this exact seam. Both
// selections this suite dispatches must resolve to configured loopback custom
// providers, because the egress guard now fails closed on any provider key
// that resolves to nothing (slugifyProviderName derives the registry keys
// "ccc-loopback" and "settings-fallback" from these names).
vi.mock("../custom-providers.js", () => ({
  readCustomProviders: () => [
    {
      id: "ccc-loopback",
      name: "CCC Loopback",
      apiType: "openai-compatible",
      baseUrl: "http://127.0.0.1:18080/v1",
    },
    {
      id: "settings-fallback",
      name: "Settings Fallback",
      apiType: "openai-compatible",
      baseUrl: "http://127.0.0.1:18081/v1",
    },
  ],
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  LegacyCredentialStorage: {
    create: vi.fn(() => ({
      getCredentials: vi.fn().mockResolvedValue({}),
    })),
  },
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
  ModelRuntime: {
    create: vi.fn(async () => ({
      getAuth: vi.fn(async () => undefined),
      stream: vi.fn(() => ({ result: vi.fn(async () => ({})) })),
      streamSimple: vi.fn(() => ({ result: vi.fn(async () => ({})) })),
      complete: vi.fn(async () => ({ role: "assistant", content: [] })),
      completeSimple: vi.fn(async () => ({ role: "assistant", content: [] })),
    })),
  },
  ModelRegistry: vi.fn().mockImplementation(function () {
    return {
      find: vi.fn((provider: string, id: string) => ({ provider, id, name: id })),
      getAll: vi.fn().mockReturnValue([]),
      registerProvider: vi.fn(),
      refresh: vi.fn(),
    };
  }),
  SessionManager: {
    inMemory: vi.fn(() => ({})),
  },
  SettingsManager: {
    inMemory: vi.fn(() => ({})),
  },
}));

vi.mock("../mcp-session-tools.js", () => ({
  connectMcpSessionTools: vi.fn().mockResolvedValue({
    tools: [],
    connected: [],
    skipped: [],
    toolSources: [],
    dispose: vi.fn().mockResolvedValue(undefined),
  }),
  buildMcpCapabilityPrompt: vi.fn(() => undefined),
}));

const CAMPAIGN_TURN_KEY = "ccc-provider-turn-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function campaignAttemptBinding() {
  return Object.freeze({
    turnKey: CAMPAIGN_TURN_KEY,
    controller: Object.freeze({
      preDispatch: vi.fn(),
      reconcile: vi.fn(),
    }),
  });
}

function synthSession(provider: string, id: string, prompt = vi.fn().mockResolvedValue(undefined)) {
  return {
    model: { provider, id },
    prompt,
    subscribe: vi.fn(),
    dispose: vi.fn(),
    setThinkingLevel: vi.fn(),
    sessionFile: undefined,
  } as unknown as AgentSession;
}

const RETRYABLE_PRIMARY_FAILURE = "Provider is not configured: ccc-loopback";

function campaignOptions(overrides: Record<string, unknown> = {}) {
  return {
    cwd: "/test/project",
    systemPrompt: "sealed campaign step",
    tools: "readonly" as const,
    defaultProvider: "ccc-loopback",
    defaultModelId: "primary-model",
    fallbackProvider: "settings-fallback",
    fallbackModelId: "fallback-model",
    profile: "ccc-fusion" as const,
    subscriptionReady: true as const,
    cccProviderAttemptBinding: campaignAttemptBinding(),
    ...overrides,
  };
}

describe("ccc-fusion campaign sessions refuse the settings-derived fallback", () => {
  beforeEach(() => {
    vi.mocked(createAgentSession).mockReset();
  });

  it("refuses fallback at session creation and never creates a second session", async () => {
    const createAgentSessionMock = vi.mocked(createAgentSession);
    const onFallbackModelUsed = vi.fn();
    const binding = campaignAttemptBinding();
    createAgentSessionMock
      .mockRejectedValueOnce(new Error(RETRYABLE_PRIMARY_FAILURE))
      .mockResolvedValueOnce({ session: synthSession("settings-fallback", "fallback-model") } as never);

    let failure: unknown;
    try {
      await createFnAgent(campaignOptions({
        onFallbackModelUsed,
        cccProviderAttemptBinding: binding,
      }) as never);
    } catch (error) {
      failure = error;
    }

    // Settlement evidence: session creation precedes every provider dispatch,
    // so the refused turn leaves no reserved attempt behind to reconcile.
    expect(binding.controller.preDispatch).not.toHaveBeenCalled();
    expect(binding.controller.reconcile).not.toHaveBeenCalled();

    expect(failure).toMatchObject({ code: "CCC_FALLBACK_REFUSED" });
    const message = failure instanceof Error ? failure.message : String(failure);
    expect(message).toContain(CAMPAIGN_TURN_KEY);
    expect(message).toContain("ccc-loopback/primary-model");
    expect(message).toContain("settings-fallback/fallback-model");
    expect(message).toContain(RETRYABLE_PRIMARY_FAILURE);
    expect(createAgentSessionMock).toHaveBeenCalledTimes(1);
    expect(createAgentSessionMock.mock.calls[0]?.[0]).toMatchObject({
      model: { provider: "ccc-loopback", id: "primary-model" },
    });
    expect(onFallbackModelUsed).not.toHaveBeenCalled();
  });

  it("refuses fallback at prompt time without swapping the sealed session", async () => {
    const createAgentSessionMock = vi.mocked(createAgentSession);
    const onFallbackModelUsed = vi.fn();
    const primaryPrompt = vi.fn().mockRejectedValue(new Error("429 Too Many Requests"));
    createAgentSessionMock
      .mockResolvedValueOnce({ session: synthSession("ccc-loopback", "primary-model", primaryPrompt) } as never)
      .mockResolvedValueOnce({ session: synthSession("settings-fallback", "fallback-model") } as never);

    const { session } = await createFnAgent(campaignOptions({ onFallbackModelUsed }) as never);

    let failure: unknown;
    try {
      await (session as unknown as { promptWithFallback: (p: string) => Promise<void> }).promptWithFallback("do the bounded work");
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({ code: "CCC_FALLBACK_REFUSED" });
    expect(failure instanceof Error ? failure.message : "").toContain("429 Too Many Requests");
    expect(createAgentSessionMock).toHaveBeenCalledTimes(1);
    expect(primaryPrompt).toHaveBeenCalledTimes(1);
    expect(onFallbackModelUsed).not.toHaveBeenCalled();
  });

  it("leaves a campaign session without a configured fallback on its ordinary provider failure", async () => {
    const createAgentSessionMock = vi.mocked(createAgentSession);
    createAgentSessionMock.mockRejectedValueOnce(new Error(RETRYABLE_PRIMARY_FAILURE));

    let failure: unknown;
    try {
      await createFnAgent(campaignOptions({
        fallbackProvider: undefined,
        fallbackModelId: undefined,
      }) as never);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as { code?: string }).code).toBeUndefined();
    expect(failure instanceof Error ? failure.message : "").toBe(RETRYABLE_PRIMARY_FAILURE);
    expect(createAgentSessionMock).toHaveBeenCalledTimes(1);
  });

  it("bounds ccc campaign discovery tools before repeated reads consume the provider turn", async () => {
    const createAgentSessionMock = vi.mocked(createAgentSession);
    const bashExecute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "bash result" }] });
    const readExecute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "read result" }] });
    const grepExecute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "grep result" }] });
    const lsExecute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ls result" }] });
    vi.mocked(createBashTool).mockReturnValueOnce({ name: "bash", execute: bashExecute } as never);
    vi.mocked(createReadTool).mockReturnValueOnce({ name: "read", execute: readExecute } as never);
    vi.mocked(createGrepTool).mockReturnValueOnce({ name: "grep", execute: grepExecute } as never);
    vi.mocked(createLsTool).mockReturnValueOnce({ name: "ls", execute: lsExecute } as never);
    createAgentSessionMock.mockResolvedValueOnce({
      session: synthSession("ccc-loopback", "primary-model"),
    } as never);

    await createFnAgent(campaignOptions({
      tools: "coding",
      cccCampaignPhaseToolPolicy: {
        readOnlyToolNames: ["bash", "read", "grep", "ls"],
        maxReadOnlyToolCallsBeforeGuidance: 1,
        maxReadOnlyToolCallsBeforeRefusal: 2,
        guidanceMessage: "CCC_CAMPAIGN_DISCOVER_BOUNDARY: mutate now",
        refusalMessage: "CCC_CAMPAIGN_DISCOVER_BOUNDARY_REFUSED: discovery refused",
      },
    }) as never);

    const sessionOptions = createAgentSessionMock.mock.calls[0]?.[0] as {
      customTools: Array<{
        name: string;
        executionMode?: string;
        execute: (...args: any[]) => Promise<unknown>;
      }>;
    };
    const bashTool = sessionOptions.customTools.find((tool) => tool.name === "bash")!;
    expect(sessionOptions.customTools.every((tool) => tool.executionMode === "sequential")).toBe(true);
    const readTool = sessionOptions.customTools.find((tool) => tool.name === "read")!;
    const grepTool = sessionOptions.customTools.find((tool) => tool.name === "grep")!;
    const lsTool = sessionOptions.customTools.find((tool) => tool.name === "ls")!;

    await expect(bashTool.execute("call-0", { command: "pnpm test" }, undefined)).resolves.toEqual({
      content: [{ type: "text", text: "bash result" }],
    });
    await expect(bashTool.execute("call-1", { command: "git grep needle" }, undefined)).resolves.toMatchObject({
      isError: false,
      content: [
        { type: "text", text: "bash result" },
        { type: "text", text: "CCC_CAMPAIGN_DISCOVER_BOUNDARY: mutate now" },
      ],
    });
    await expect(readTool.execute("call-2", { path: "src/a.ts" }, undefined)).resolves.toMatchObject({
      isError: true,
      error: "CCC_CAMPAIGN_DISCOVER_BOUNDARY_REFUSED: discovery refused",
    });
    await expect(grepTool.execute("call-3", { pattern: "needle" }, undefined)).resolves.toMatchObject({
      isError: true,
      error: "CCC_CAMPAIGN_DISCOVER_BOUNDARY_REFUSED: discovery refused",
    });
    await expect(lsTool.execute("call-4", {}, undefined)).resolves.toMatchObject({
      isError: true,
      error: "CCC_CAMPAIGN_DISCOVER_BOUNDARY_REFUSED: discovery refused",
    });
    expect(bashExecute).toHaveBeenCalledTimes(2);
    expect(readExecute).not.toHaveBeenCalled();
    expect(grepExecute).not.toHaveBeenCalled();
    expect(lsExecute).not.toHaveBeenCalled();
  });

  it("applies the native discovery budget to an exact approved MCP server/tool pair", async () => {
    const createAgentSessionMock = vi.mocked(createAgentSession);
    const mcpExecute = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "semantic result" }],
      isError: false,
    });
    const onReadOnlyToolCall = vi.fn();
    vi.mocked(connectMcpSessionTools).mockResolvedValueOnce({
      tools: [{
        name: "mcp__fusion-code-core__smart-tree_search",
        label: "smart-tree search",
        description: "compressed repository search",
        parameters: { type: "object", properties: {} },
        execute: mcpExecute,
      } as never],
      connected: ["fusion-code-core"],
      skipped: [],
      toolSources: [{
        serverName: "fusion-code-core",
        sourceToolName: "smart-tree__search",
        exposedToolName: "mcp__fusion-code-core__smart-tree_search",
      }],
      dispose: vi.fn().mockResolvedValue(undefined),
    });
    createAgentSessionMock.mockResolvedValueOnce({
      session: synthSession("ccc-loopback", "primary-model"),
    } as never);

    await createFnAgent(campaignOptions({
      tools: "coding",
      mcpServers: [{ name: "fusion-code-core", transport: "stdio", command: "fake-mcp" }],
      cccCampaignPhaseToolPolicy: {
        readOnlyToolNames: ["read"],
        approvedMcpDiscoveryTools: [{
          serverName: "fusion-code-core",
          toolName: "smart-tree__search",
        }],
        maxReadOnlyToolCallsBeforeGuidance: 1,
        maxReadOnlyToolCallsBeforeRefusal: 2,
        guidanceMessage: "CCC_CAMPAIGN_DISCOVER_BOUNDARY: mutate now",
        refusalMessage: "CCC_CAMPAIGN_DISCOVER_BOUNDARY_REFUSED: discovery refused",
        onApprovedMcpDiscoveryToolCall: onReadOnlyToolCall,
      },
    }) as never);

    const sessionOptions = createAgentSessionMock.mock.calls[0]?.[0] as {
      customTools: Array<{ name: string; execute: (...args: any[]) => Promise<unknown> }>;
    };
    const mcpTool = sessionOptions.customTools.find(
      (tool) => tool.name === "mcp__fusion-code-core__smart-tree_search",
    )!;

    await expect(mcpTool.execute("call-1", { query: "router" }, undefined)).resolves.toMatchObject({
      isError: false,
      content: [{ type: "text", text: "semantic result" }],
    });
    await expect(mcpTool.execute("call-2", { query: "budget" }, undefined)).resolves.toMatchObject({
      isError: false,
      content: [
        { type: "text", text: "semantic result" },
        { type: "text", text: "CCC_CAMPAIGN_DISCOVER_BOUNDARY: mutate now" },
      ],
    });
    await expect(mcpTool.execute("call-3", { query: "more" }, undefined)).resolves.toMatchObject({
      isError: true,
      error: "CCC_CAMPAIGN_DISCOVER_BOUNDARY_REFUSED: discovery refused",
    });
    expect(mcpExecute).toHaveBeenCalledTimes(2);
    expect(onReadOnlyToolCall).toHaveBeenCalledTimes(3);
  });

  it("classifies only read-like campaign discovery tool calls", () => {
    expect(isCccCampaignDiscoveryToolCall("read", { path: "src/a.ts" })).toBe(true);
    expect(isCccCampaignDiscoveryToolCall("edit", { path: "src/a.ts" })).toBe(false);
    expect(isCccCampaignDiscoveryToolCall("write", { path: "src/a.ts" })).toBe(false);
    expect(isCccCampaignDiscoveryToolCall("fn_complete_phase", {})).toBe(false);
    expect(isCccCampaignDiscoveryToolCall("bash", { command: "MSG=\"hello world\" git grep needle" })).toBe(true);
    expect(isCccCampaignDiscoveryToolCall("bash", { command: "cat src/a.ts 2>/dev/null" })).toBe(true);
    expect(isCccCampaignDiscoveryToolCall("bash", { command: "cat src/a.ts 1>src/b.ts" })).toBe(false);
    expect(isCccCampaignDiscoveryToolCall("bash", { command: "cat src/a.ts>src/b.ts" })).toBe(false);
    expect(isCccCampaignDiscoveryToolCall("bash", { command: "sed -i '' 's/a/b/' src/a.ts" })).toBe(false);
    expect(isCccCampaignDiscoveryToolCall("bash", { command: "find . -name '*.tmp' -delete" })).toBe(false);
    expect(isCccCampaignDiscoveryToolCall("bash", { command: "git status && pnpm test" })).toBe(false);
    expect(isCccCampaignDiscoveryToolCall("bash", { command: "cat src/a.ts | tee src/b.ts" })).toBe(false);
    expect(isCccCampaignDiscoveryToolCall("bash", { command: "cat < src/a.ts" })).toBe(true);
    expect(isCccCampaignDiscoveryToolCall("bash", { command: "/bin/cat src/a.ts" })).toBe(true);
    expect(isCccCampaignDiscoveryToolCall("bash", { command: "env git grep needle" })).toBe(true);
    expect(isCccCampaignDiscoveryToolCall("bash", { command: "cat /dev/null & touch src/b.ts" })).toBe(false);
    expect(isCccCampaignDiscoveryToolCall("bash", { command: "cat <(touch src/b.ts)" })).toBe(false);
    expect(isCccCampaignDiscoveryToolCall("bash", { command: "sed -i.bak 's/a/b/' src/a.ts" })).toBe(false);
    expect(isCccCampaignDiscoveryToolCall("bash", { command: "sed -i'' 's/a/b/' src/a.ts" })).toBe(false);
    expect(isCccCampaignDiscoveryToolCall("bash", { command: "find . -name '*.ts' -fprint result.txt" })).toBe(false);
    expect(isCccCampaignDiscoveryToolCall("bash", { command: "git diff --output=result.patch" })).toBe(false);
    expect(isCccCampaignDiscoveryToolCall("bash", { command: "git show --output result.patch HEAD" })).toBe(false);
    expect(isCccCampaignDiscoveryToolCall("mcp__fusion-code-core__smart-tree_search", {})).toBe(false);
  });

  it("refuses a renamed or unapproved namespaced MCP tool before it executes", async () => {
    const execute = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "should not execute" }],
      isError: false,
    });
    const [wrapped] = wrapToolsWithCccCampaignPhaseToolPolicy(
      [{ name: "mcp__fusion-code-core__smart-tree_search_v2", execute } as never],
      {
        readOnlyToolNames: ["read"],
        approvedMcpDiscoveryTools: [{
          serverName: "fusion-code-core",
          toolName: "smart-tree__search",
        }],
        maxReadOnlyToolCallsBeforeGuidance: 1,
        maxReadOnlyToolCallsBeforeRefusal: 2,
        guidanceMessage: "mutate now",
        refusalMessage: "discovery refused",
      },
      [],
    );

    await expect(wrapped!.execute("call-1", {}, undefined, undefined, {} as never)).resolves.toMatchObject({
      isError: true,
      error: expect.stringContaining("UNAPPROVED_MCP_TOOL_REFUSED"),
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("executes an unknown Bash probe only within the bounded discovery allowance", async () => {
    const createAgentSessionMock = vi.mocked(createAgentSession);
    const bashExecute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "probe result" }] });
    vi.mocked(createBashTool).mockReturnValueOnce({ name: "bash", execute: bashExecute } as never);
    createAgentSessionMock.mockResolvedValueOnce({ session: synthSession("ccc-loopback", "primary-model") } as never);

    await createFnAgent(campaignOptions({
      tools: "coding",
      cccCampaignPhaseToolPolicy: {
        readOnlyToolNames: ["bash"],
        maxReadOnlyToolCallsBeforeGuidance: 1,
        maxReadOnlyToolCallsBeforeRefusal: 1,
        guidanceMessage: "CCC_CAMPAIGN_DISCOVER_BOUNDARY: mutate now",
        refusalMessage: "CCC_CAMPAIGN_DISCOVER_BOUNDARY_REFUSED: discovery refused",
        currentPhase: () => "DISCOVER",
        onPotentialMutationCompleted: async () => false,
      },
    }) as never);

    const sessionOptions = createAgentSessionMock.mock.calls[0]?.[0] as {
      customTools: Array<{ name: string; execute: (...args: any[]) => Promise<unknown> }>;
    };
    const bashTool = sessionOptions.customTools.find((tool) => tool.name === "bash")!;

    await expect(bashTool.execute("call-1", { command: "pnpm test" }, undefined)).resolves.toEqual({
      content: [{ type: "text", text: "probe result" }],
    });
    await expect(bashTool.execute("call-2", { command: "node inspect.js" }, undefined)).resolves.toMatchObject({
      isError: false,
      content: [
        { type: "text", text: "probe result" },
        { type: "text", text: "CCC_CAMPAIGN_DISCOVER_BOUNDARY: mutate now" },
      ],
    });
    await expect(bashTool.execute("call-3", { command: "python inspect.py" }, undefined)).resolves.toMatchObject({
      isError: true,
      error: "CCC_CAMPAIGN_DISCOVER_BOUNDARY_REFUSED: discovery refused",
    });
    expect(bashExecute).toHaveBeenCalledTimes(2);
  });

  it("phase-bounds an unclassified custom tool instead of letting it bypass DISCOVER", async () => {
    const createAgentSessionMock = vi.mocked(createAgentSession);
    const customExecute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "custom result" }] });
    createAgentSessionMock.mockResolvedValueOnce({ session: synthSession("ccc-loopback", "primary-model") } as never);

    await createFnAgent(campaignOptions({
      tools: "coding",
      customTools: [{ name: "mcp_probe", execute: customExecute }],
      cccCampaignPhaseToolPolicy: {
        readOnlyToolNames: ["bash"],
        exemptToolNames: ["fn_complete_phase"],
        maxReadOnlyToolCallsBeforeGuidance: 1,
        maxReadOnlyToolCallsBeforeRefusal: 2,
        guidanceMessage: "CCC_CAMPAIGN_DISCOVER_BOUNDARY: mutate now",
        refusalMessage: "CCC_CAMPAIGN_DISCOVER_BOUNDARY_REFUSED: discovery refused",
        currentPhase: () => "DISCOVER",
        onPotentialMutationCompleted: async () => false,
      },
    }) as never);

    const sessionOptions = createAgentSessionMock.mock.calls[0]?.[0] as {
      customTools: Array<{ name: string; execute: (...args: any[]) => Promise<unknown> }>;
    };
    const customTool = sessionOptions.customTools.find((tool) => tool.name === "mcp_probe")!;
    await customTool.execute("call-1", {}, undefined);
    await customTool.execute("call-2", {}, undefined);
    await expect(customTool.execute("call-3", {}, undefined)).resolves.toMatchObject({ isError: true });
    expect(customExecute).toHaveBeenCalledTimes(2);
  });

  it("signal_only_handshake_refuses_sibling_tools_before_execution and preserves invalidation", async () => {
    const writeExecute = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "must not write" }],
      isError: false,
    });
    const signalExecute = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "signal accepted" }],
      isError: false,
      terminate: true,
    });
    const onSignalOnlyViolation = vi.fn();
    const wrapped = wrapToolsWithCccCampaignPhaseToolPolicy(
      [
        { name: "write", execute: writeExecute } as never,
        { name: "fn_complete_phase", execute: signalExecute } as never,
      ],
      {
        readOnlyToolNames: ["read"],
        exemptToolNames: ["fn_complete_phase"],
        maxReadOnlyToolCallsBeforeGuidance: 1,
        maxReadOnlyToolCallsBeforeRefusal: 2,
        guidanceMessage: "mutate now",
        refusalMessage: "discovery refused",
        currentPhase: () => "AWAIT_PHASE_SIGNAL",
        completionSignalOnly: () => true,
        signalOnlyRefusalMessage:
          "CCC_CAMPAIGN_PHASE_SIGNAL_ONLY_REFUSED: call fn_complete_phase and no other tool",
        onSignalOnlyViolation,
      } as any,
    );
    const writeTool = wrapped.find((tool) => tool.name === "write")!;
    const signalTool = wrapped.find((tool) => tool.name === "fn_complete_phase")!;

    await expect(writeTool.execute("call-write", { path: "src/a.ts", content: "x" }, undefined))
      .resolves.toMatchObject({
        isError: true,
        terminate: true,
        error: expect.stringContaining("PHASE_SIGNAL_ONLY_REFUSED"),
      });
    expect(writeExecute).not.toHaveBeenCalled();
    expect(onSignalOnlyViolation).toHaveBeenCalledWith("write");
    await expect(signalTool.execute("call-signal", {}, undefined)).resolves.toMatchObject({
      terminate: true,
    });
    expect(signalExecute).toHaveBeenCalledTimes(1);
  });

  it("native_write_preflight_refuses_paths outside exact admitted roots", async () => {
    const writeExecute = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "must not write" }],
      isError: false,
    });
    const [writeTool] = wrapToolsWithCccCampaignPhaseToolPolicy(
      [{ name: "write", execute: writeExecute } as never],
      {
        readOnlyToolNames: ["read"],
        maxReadOnlyToolCallsBeforeGuidance: 1,
        maxReadOnlyToolCallsBeforeRefusal: 2,
        guidanceMessage: "mutate now",
        refusalMessage: "discovery refused",
        currentPhase: () => "MUTATE",
        worktreePath: "/tmp/ccc-candidate",
        allowedWriteRoots: ["src/record.mjs", "src/validation.mjs"],
      } as any,
    );

    await expect(writeTool!.execute(
      "call-write",
      { path: "/tmp/ccc-candidate/.fusion-tmp/h2.txt", content: "scratch" },
      undefined,
    )).resolves.toMatchObject({
      isError: true,
      error: expect.stringContaining("WRITE_ENVELOPE_REFUSED"),
    });
    expect(writeExecute).not.toHaveBeenCalled();
  });

  it("post_tool_write_envelope_guard terminates a MUTATE tool that creates a foreign path", async () => {
    const bashResult = {
      content: [{ type: "text", text: "command completed" }],
      isError: false,
      details: { exitCode: 0 },
    };
    const bashExecute = vi.fn().mockResolvedValue(bashResult);
    const capturePotentialMutationBaseline = vi.fn().mockResolvedValue({
      changedPaths: ["src/record.mjs"],
      foreignPaths: [],
    });
    const onPotentialMutationSettled = vi.fn().mockResolvedValue({
      violation: {
        message:
          "CCC_CAMPAIGN_WRITE_ENVELOPE_VIOLATION: bash created .fusion-tmp/h2.txt outside admitted roots",
        details: {
          toolName: "bash",
          newForeignPaths: [".fusion-tmp/h2.txt"],
          allowedWriteRoots: ["src/record.mjs", "src/validation.mjs"],
        },
      },
    });
    const [bashTool] = wrapToolsWithCccCampaignPhaseToolPolicy(
      [{ name: "bash", execute: bashExecute } as never],
      {
        readOnlyToolNames: ["bash"],
        maxReadOnlyToolCallsBeforeGuidance: 1,
        maxReadOnlyToolCallsBeforeRefusal: 2,
        guidanceMessage: "mutate now",
        refusalMessage: "discovery refused",
        currentPhase: () => "MUTATE",
        capturePotentialMutationBaseline,
        onPotentialMutationSettled,
      } as any,
    );

    await expect(bashTool!.execute(
      "call-bash",
      { command: "mkdir -p .fusion-tmp && printf x > .fusion-tmp/h2.txt" },
      undefined,
    )).resolves.toMatchObject({
      isError: true,
      terminate: true,
      error: expect.stringContaining("WRITE_ENVELOPE_VIOLATION"),
      content: expect.arrayContaining([
        { type: "text", text: "command completed" },
        { type: "text", text: expect.stringContaining(".fusion-tmp/h2.txt") },
      ]),
      details: expect.objectContaining({
        originalToolResult: bashResult,
        newForeignPaths: [".fusion-tmp/h2.txt"],
      }),
    });
    expect(bashExecute).toHaveBeenCalledTimes(1);
    expect(capturePotentialMutationBaseline).toHaveBeenCalledTimes(1);
    expect(onPotentialMutationSettled).toHaveBeenCalledTimes(1);
  });

  it("post_tool_write_envelope_guard observes even Bash commands classified as discovery", async () => {
    const bashResult = {
      content: [{ type: "text", text: "file contents" }],
      isError: false,
      details: { exitCode: 0 },
    };
    const bashExecute = vi.fn().mockResolvedValue(bashResult);
    const capturePotentialMutationBaseline = vi.fn().mockResolvedValue({
      changedPaths: [],
      foreignPaths: [],
    });
    const onPotentialMutationSettled = vi.fn().mockResolvedValue({
      violation: {
        message:
          "CCC_CAMPAIGN_WRITE_ENVELOPE_VIOLATION: bash created .v_part2.txt outside admitted roots",
        details: {
          toolName: "bash",
          newForeignPaths: [".v_part2.txt"],
          allowedWriteRoots: ["src/record.mjs"],
        },
      },
    });
    const [bashTool] = wrapToolsWithCccCampaignPhaseToolPolicy(
      [{ name: "bash", execute: bashExecute } as never],
      {
        readOnlyToolNames: ["bash"],
        maxReadOnlyToolCallsBeforeGuidance: 2,
        maxReadOnlyToolCallsBeforeRefusal: 4,
        guidanceMessage: "mutate now",
        refusalMessage: "discovery refused",
        currentPhase: () => "DISCOVER",
        capturePotentialMutationBaseline,
        onPotentialMutationSettled,
      } as any,
    );

    await expect(bashTool!.execute(
      "call-bash",
      { command: "cat src/record.mjs" },
      undefined,
    )).resolves.toMatchObject({
      isError: true,
      terminate: true,
      error: expect.stringContaining("WRITE_ENVELOPE_VIOLATION"),
      details: expect.objectContaining({
        originalToolResult: bashResult,
        newForeignPaths: [".v_part2.txt"],
      }),
    });
    expect(bashExecute).toHaveBeenCalledTimes(1);
    expect(capturePotentialMutationBaseline).toHaveBeenCalledTimes(1);
    expect(onPotentialMutationSettled).toHaveBeenCalledTimes(1);
  });

  it("leaves DISCOVER after a successful tool mutation so verification reads are not blocked", async () => {
    const createAgentSessionMock = vi.mocked(createAgentSession);
    const readExecute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "read result" }], isError: false });
    const writeExecute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "write result" }], isError: false });
    vi.mocked(createReadTool).mockReturnValueOnce({ name: "read", execute: readExecute } as never);
    vi.mocked(createWriteTool).mockReturnValueOnce({ name: "write", execute: writeExecute } as never);
    createAgentSessionMock.mockResolvedValueOnce({ session: synthSession("ccc-loopback", "primary-model") } as never);
    let phase = "DISCOVER";

    await createFnAgent(campaignOptions({
      tools: "coding",
      cccCampaignPhaseToolPolicy: {
        readOnlyToolNames: ["read", "bash"],
        maxReadOnlyToolCallsBeforeGuidance: 1,
        maxReadOnlyToolCallsBeforeRefusal: 2,
        guidanceMessage: "CCC_CAMPAIGN_DISCOVER_BOUNDARY: mutate now",
        refusalMessage: "CCC_CAMPAIGN_DISCOVER_BOUNDARY_REFUSED: discovery refused",
        currentPhase: () => phase,
        onPotentialMutationCompleted: async () => {
          phase = "MUTATE";
          return true;
        },
      },
    }) as never);

    const sessionOptions = createAgentSessionMock.mock.calls[0]?.[0] as {
      customTools: Array<{ name: string; execute: (...args: any[]) => Promise<unknown> }>;
    };
    const readTool = sessionOptions.customTools.find((tool) => tool.name === "read")!;
    const writeTool = sessionOptions.customTools.find((tool) => tool.name === "write")!;

    await readTool.execute("call-1", { path: "src/a.ts" }, undefined);
    await writeTool.execute("call-2", { path: "src/a.ts", content: "changed" }, undefined);
    await expect(readTool.execute("call-3", { path: "src/a.ts" }, undefined)).resolves.toEqual({
      content: [{ type: "text", text: "read result" }],
      isError: false,
    });
    expect(phase).toBe("MUTATE");
    expect(readExecute).toHaveBeenCalledTimes(2);
  });

  it("allows only one explicit mutation attempt after discovery tools are exhausted", async () => {
    const createAgentSessionMock = vi.mocked(createAgentSession);
    const bashExecute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "bash result" }] });
    const readExecute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "read result" }] });
    vi.mocked(createBashTool).mockReturnValueOnce({ name: "bash", execute: bashExecute } as never);
    vi.mocked(createReadTool).mockReturnValueOnce({ name: "read", execute: readExecute } as never);
    createAgentSessionMock.mockResolvedValueOnce({
      session: synthSession("ccc-loopback", "primary-model"),
    } as never);

    await createFnAgent(campaignOptions({
      tools: "coding",
      cccCampaignPhaseToolPolicy: {
        readOnlyToolNames: ["bash", "read"],
        maxReadOnlyToolCallsBeforeGuidance: 1,
        maxReadOnlyToolCallsBeforeRefusal: 2,
        guidanceMessage: "CCC_CAMPAIGN_DISCOVER_BOUNDARY: mutate now",
        refusalMessage: "CCC_CAMPAIGN_DISCOVER_BOUNDARY_REFUSED: discovery refused",
      },
    }) as never);

    const sessionOptions = createAgentSessionMock.mock.calls[0]?.[0] as {
      customTools: Array<{ name: string; execute: (...args: any[]) => Promise<unknown> }>;
    };
    const bashTool = sessionOptions.customTools.find((tool) => tool.name === "bash")!;
    const readTool = sessionOptions.customTools.find((tool) => tool.name === "read")!;

    await expect(readTool.execute("call-1", { path: "src/a.ts" }, undefined)).resolves.toEqual({
      content: [{ type: "text", text: "read result" }],
    });
    await expect(readTool.execute("call-2", { path: "src/b.ts" }, undefined)).resolves.toMatchObject({
      isError: false,
      content: [
        { type: "text", text: "read result" },
        { type: "text", text: "CCC_CAMPAIGN_DISCOVER_BOUNDARY: mutate now" },
      ],
    });
    await expect(bashTool.execute("call-3", { command: "pnpm test" }, undefined)).resolves.toMatchObject({
      isError: true,
      error: "CCC_CAMPAIGN_DISCOVER_BOUNDARY_REFUSED: discovery refused",
    });
    await expect(bashTool.execute("call-4", { command: "sed -i '' 's/a/b/' src/a.ts" }, undefined)).resolves.toMatchObject({
      isError: true,
      error: "CCC_CAMPAIGN_DISCOVER_BOUNDARY_REFUSED: discovery refused",
    });
    await expect(bashTool.execute("call-5", { command: "cat src/a.ts>src/b.ts" }, undefined)).resolves.toMatchObject({
      isError: true,
      error: "CCC_CAMPAIGN_DISCOVER_BOUNDARY_REFUSED: discovery refused",
    });
    expect(bashExecute).toHaveBeenCalledTimes(1);
    expect(readExecute).toHaveBeenCalledTimes(2);
  });

  it("applies the campaign discovery boundary only during DISCOVER", async () => {
    const createAgentSessionMock = vi.mocked(createAgentSession);
    const readExecute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "read result" }] });
    vi.mocked(createReadTool).mockReturnValueOnce({ name: "read", execute: readExecute } as never);
    createAgentSessionMock.mockResolvedValueOnce({
      session: synthSession("ccc-loopback", "primary-model"),
    } as never);

    await createFnAgent(campaignOptions({
      tools: "coding",
      cccCampaignPhaseToolPolicy: {
        readOnlyToolNames: ["read"],
        maxReadOnlyToolCallsBeforeGuidance: 1,
        maxReadOnlyToolCallsBeforeRefusal: 2,
        guidanceMessage: "CCC_CAMPAIGN_DISCOVER_BOUNDARY: mutate now",
        refusalMessage: "CCC_CAMPAIGN_DISCOVER_BOUNDARY_REFUSED: discovery refused",
        currentPhase: () => "REPAIR",
      },
    }) as never);

    const sessionOptions = createAgentSessionMock.mock.calls[0]?.[0] as {
      customTools: Array<{ name: string; execute: (...args: any[]) => Promise<unknown> }>;
    };
    const readTool = sessionOptions.customTools.find((tool) => tool.name === "read")!;

    await expect(readTool.execute("call-1", { path: "src/a.ts" }, undefined)).resolves.toEqual({
      content: [{ type: "text", text: "read result" }],
    });
    await expect(readTool.execute("call-2", { path: "src/b.ts" }, undefined)).resolves.toEqual({
      content: [{ type: "text", text: "read result" }],
    });
    expect(readExecute).toHaveBeenCalledTimes(2);
  });

  it("keeps ordinary non-ccc sessions falling back to the configured model", async () => {
    const createAgentSessionMock = vi.mocked(createAgentSession);
    const onFallbackModelUsed = vi.fn();
    createAgentSessionMock
      .mockRejectedValueOnce(new Error(RETRYABLE_PRIMARY_FAILURE))
      .mockResolvedValueOnce({ session: synthSession("settings-fallback", "fallback-model") } as never);

    const { session } = await createFnAgent({
      cwd: "/test/project",
      systemPrompt: "ordinary lane",
      tools: "readonly",
      defaultProvider: "ccc-loopback",
      defaultModelId: "primary-model",
      fallbackProvider: "settings-fallback",
      fallbackModelId: "fallback-model",
      onFallbackModelUsed,
    } as never);

    expect((session as unknown as { model: { id: string } }).model.id).toBe("fallback-model");
    expect(createAgentSessionMock).toHaveBeenCalledTimes(2);
    expect(onFallbackModelUsed).toHaveBeenCalledWith(expect.objectContaining({
      primaryModel: "ccc-loopback/primary-model",
      fallbackModel: "settings-fallback/fallback-model",
      triggerPoint: "session-creation",
    }));
  });
});
