import { describe, it, expect, vi, beforeEach } from "vitest";
import { createAgentSession, type AgentSession } from "@earendil-works/pi-coding-agent";
import { customProviderRegistryKey, type CustomProvider } from "@fusion/core";
import { createFnAgent } from "../pi.js";

/*
FNXC:CCCEgressAllowlist 2026-08-01-19:05:
Under the ccc-fusion profile a provider key that resolved to no configured
custom provider used to be skipped, so a built-in cloud HTTP route (`anthropic`,
`openai`, ...) passed straight through the loopback boundary that this profile
exists to enforce. These tests pin the closed shape: exactly two transports are
admitted -- a configured custom provider whose base URL satisfies the loopback
policy, and an enumerated non-HTTP subscription transport that has no base URL
to validate. Everything else refuses before the model registry, the session, or
any provider dispatch exists. Every provider record here is synthetic; no
request leaves the process and no operator settings file is read.
*/

const hoisted = vi.hoisted(() => ({ customProviders: [] as unknown[] }));

// The CCC egress guard reads this exact seam. Mock it so the suite never
// touches the operator's real ~/.fusion/settings.json.
vi.mock("../custom-providers.js", () => ({
  readCustomProviders: () => hoisted.customProviders,
}));

vi.mock("../skill-resolver.js", () => ({
  resolveSessionSkills: vi.fn(),
  createSkillsOverrideFromSelection: vi.fn(),
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
    toolSources: [],
    dispose: vi.fn().mockResolvedValue(undefined),
  }),
  buildMcpCapabilityPrompt: vi.fn(() => undefined),
}));

const SYNTHETIC_API_KEY = "synthetic-never-read";

function loopbackProvider(overrides: Partial<CustomProvider> = {}): CustomProvider {
  return {
    id: "ccc-loopback-gateway",
    name: "CCC Loopback Gateway",
    apiType: "openai-compatible",
    baseUrl: "http://127.0.0.1:7443/v1",
    apiKey: SYNTHETIC_API_KEY,
    models: [{ id: "primary-model", name: "Primary" }],
    ...overrides,
  } as CustomProvider;
}

function synthSession(provider: string, id: string) {
  return {
    model: { provider, id },
    prompt: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn(),
    dispose: vi.fn(),
    setThinkingLevel: vi.fn(),
    sessionFile: undefined,
  } as unknown as AgentSession;
}

function cccOptions(overrides: Record<string, unknown> = {}) {
  return {
    cwd: "/test/project",
    systemPrompt: "ccc egress admission",
    tools: "readonly" as const,
    defaultProvider: "ccc-loopback-gateway",
    defaultModelId: "primary-model",
    profile: "ccc-fusion" as const,
    subscriptionReady: true as const,
    ...overrides,
  };
}

async function attempt(options: Record<string, unknown>): Promise<unknown> {
  try {
    await createFnAgent(options as never);
    return undefined;
  } catch (error) {
    return error;
  }
}

describe("ccc-fusion provider egress admits only loopback custom providers and enumerated non-HTTP transports", () => {
  beforeEach(() => {
    hoisted.customProviders = [];
    vi.mocked(createAgentSession).mockReset();
    vi.mocked(createAgentSession).mockResolvedValue({ session: synthSession("ccc-loopback-gateway", "primary-model") } as never);
  });

  it("refuses an unknown provider id that resolves to no configured custom provider", async () => {
    const failure = await attempt(cccOptions({ defaultProvider: "totally-unregistered-provider" }));

    expect(failure).toMatchObject({ code: "CCC_CUSTOM_PROVIDER_EGRESS_POLICY_VIOLATION" });
    const message = failure instanceof Error ? failure.message : String(failure);
    expect(message).toContain("primary");
    expect(message).toContain("totally-unregistered-provider");
    expect(createAgentSession).not.toHaveBeenCalled();
  });

  it.each([
    ["anthropic"],
    ["openai"],
    ["openrouter"],
  ])("refuses the built-in cloud HTTP provider %s when no configured custom provider resolves it", async (builtInProviderId) => {
    hoisted.customProviders = [loopbackProvider()];

    const failure = await attempt(cccOptions({ defaultProvider: builtInProviderId }));

    expect(failure).toMatchObject({ code: "CCC_CUSTOM_PROVIDER_EGRESS_POLICY_VIOLATION" });
    expect(failure instanceof Error ? failure.message : "").toContain(builtInProviderId);
    expect(createAgentSession).not.toHaveBeenCalled();
  });

  it("refuses a built-in cloud HTTP provider selected as the fallback route", async () => {
    hoisted.customProviders = [loopbackProvider()];

    const failure = await attempt(cccOptions({
      fallbackProvider: "anthropic",
      fallbackModelId: "fallback-model",
    }));

    expect(failure).toMatchObject({ code: "CCC_CUSTOM_PROVIDER_EGRESS_POLICY_VIOLATION" });
    const message = failure instanceof Error ? failure.message : String(failure);
    expect(message).toContain("fallback");
    expect(message).toContain("anthropic");
    expect(createAgentSession).not.toHaveBeenCalled();
  });

  it.each([
    ["pi-claude-cli"],
  ])("admits the non-HTTP subscription transport %s with no configured custom provider", async (admittedTransport) => {
    vi.mocked(createAgentSession).mockResolvedValue({ session: synthSession(admittedTransport, "claude-sonnet-4-6") } as never);

    const failure = await attempt(cccOptions({
      defaultProvider: admittedTransport,
      defaultModelId: "claude-sonnet-4-6",
    }));

    expect(failure).toBeUndefined();
    expect(createAgentSession).toHaveBeenCalledTimes(1);
  });

  it("admits a configured custom provider whose base URL satisfies the loopback policy", async () => {
    const provider = loopbackProvider();
    hoisted.customProviders = [provider];

    const failure = await attempt(cccOptions({
      defaultProvider: customProviderRegistryKey(provider, [provider]),
    }));

    expect(failure).toBeUndefined();
    expect(createAgentSession).toHaveBeenCalledTimes(1);
  });

  it("still refuses a configured custom provider whose base URL is outside the loopback boundary", async () => {
    const provider = loopbackProvider({ baseUrl: "https://api.example.invalid/v1" });
    hoisted.customProviders = [provider];
    const registryKey = customProviderRegistryKey(provider, [provider]);

    const failure = await attempt(cccOptions({ defaultProvider: registryKey }));

    expect(failure).toMatchObject({ code: "CCC_CUSTOM_PROVIDER_EGRESS_POLICY_VIOLATION" });
    const message = failure instanceof Error ? failure.message : String(failure);
    expect(message).toContain(registryKey);
    // A refusal log must not become the leak it just prevented.
    expect(message).not.toContain("https://api.example.invalid/v1");
    expect(message).not.toContain(SYNTHETIC_API_KEY);
    expect(createAgentSession).not.toHaveBeenCalled();
  });

  it("leaves ordinary non-ccc sessions on unresolved and built-in provider ids untouched", async () => {
    vi.mocked(createAgentSession).mockResolvedValue({ session: synthSession("anthropic", "primary-model") } as never);

    const failure = await attempt({
      cwd: "/test/project",
      systemPrompt: "ordinary lane",
      tools: "readonly",
      defaultProvider: "anthropic",
      defaultModelId: "primary-model",
      fallbackProvider: "totally-unregistered-provider",
      fallbackModelId: "fallback-model",
    });

    expect(failure).toBeUndefined();
    expect(createAgentSession).toHaveBeenCalledTimes(1);
  });
});
