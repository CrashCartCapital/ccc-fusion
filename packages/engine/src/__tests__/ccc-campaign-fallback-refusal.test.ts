import { describe, it, expect, vi, beforeEach } from "vitest";
import { createAgentSession, type AgentSession } from "@earendil-works/pi-coding-agent";
import { createFnAgent } from "../pi.js";

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
// ~/.fusion/settings.json; the CCC egress guard reads this exact seam.
vi.mock("../custom-providers.js", () => ({
  readCustomProviders: () => [],
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
    dispose: vi.fn().mockResolvedValue(undefined),
  }),
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
