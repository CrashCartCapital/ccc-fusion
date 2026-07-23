import { beforeEach, describe, expect, it, vi } from "vitest";
import "./executor-test-helpers.js";
import { AgentLogger } from "../agent-logger.js";
import { connectMcpSessionTools } from "../mcp-session-tools.js";
import { TaskExecutor } from "../executor.js";
import { createMockStore, mockedCreateFnAgent, mockedExecSync, resetExecutorMocks } from "./executor-test-helpers.js";

const CCC_PROFILE = "ccc-fusion";
const SCOPE_FAILURE_MESSAGE = "CCC Fusion scope verification unavailable — fn_task_done blocked to preserve ccc-fusion scope safety.";

function baseTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "FN-CCC-WAVE-1",
    title: "CCC scope policy",
    description: "",
    prompt: "## Review Level: 1",
    column: "in-progress",
    worktree: "/repo/.worktrees/ccc-wave-1",
    branch: "fusion/fn-ccc-wave-1",
    baseCommitSha: "abc123",
    taskDoneRetryCount: 0,
    steps: [{ name: "Step 1", status: "in-progress" as const }],
    currentStep: 0,
    dependencies: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

async function setupScopeTask(overrides: Record<string, unknown> = {}, scope = ["docs/allowed.md"], enforcement: "off" | "warn" | "block" = "warn") {
  const store = createMockStore();
  const task = baseTask(overrides);
  let tool: any;
  store.getTask.mockResolvedValue(task);
  store.parseFileScopeFromPrompt.mockResolvedValue(scope);
  store.getSettings.mockResolvedValue({ autoMerge: false, planOnlyScopeLeakEnforcement: enforcement });
  mockedExecSync.mockImplementation((cmd: string) => {
    if (cmd.includes("rev-parse --show-toplevel")) return Buffer.from("/repo/.worktrees/ccc-wave-1\n");
    if (cmd.includes("rev-parse --abbrev-ref HEAD")) return Buffer.from("fusion/fn-ccc-wave-1\n");
    if (cmd.includes("rev-list --count")) return Buffer.from("1\n");
    if (cmd.includes("git diff --name-only")) return Buffer.from("docs/off-scope.md\n");
    return Buffer.from("");
  });
  mockedCreateFnAgent.mockImplementation(async ({ customTools }: any) => {
    tool = customTools.find((candidate: any) => candidate.name === "fn_task_done");
    return { session: { prompt: vi.fn().mockResolvedValue(undefined), dispose: vi.fn() } } as any;
  });
  const executor = new TaskExecutor(store as any, "/repo");
  await executor.execute(task as any);
  return { executor, store, tool };
}

describe("ccc-fusion secret and scope boundaries", () => {
  beforeEach(() => resetExecutorMocks());

  it("blocks ccc stdio MCP before the actual transport boundary without subscription readiness", async () => {
    const transportFactory = vi.fn(() => ({} as any));

    await expect(connectMcpSessionTools([{
      name: "fake-stdio",
      transport: "stdio",
      command: "fake-mcp",
      args: [],
    } as any], {
      profile: CCC_PROFILE,
      transportFactory,
    })).rejects.toMatchObject({ code: "CCC_SUBSCRIPTION_PREFLIGHT_REQUIRED" });

    expect(transportFactory).not.toHaveBeenCalled();
  });

  it("blocks ccc stdio MCP before the actual transport boundary when subscription readiness is false", async () => {
    const transportFactory = vi.fn(() => ({} as any));

    await expect(connectMcpSessionTools([{
      name: "fake-stdio",
      transport: "stdio",
      command: "fake-mcp",
      args: [],
    } as any], {
      profile: CCC_PROFILE,
      subscriptionReady: false,
      transportFactory,
    } as any)).rejects.toMatchObject({ code: "CCC_SUBSCRIPTION_PREFLIGHT_REQUIRED" });

    expect(transportFactory).not.toHaveBeenCalled();
  });

  it("constructs a ccc stdio MCP transport env from only allowed configured server values", async () => {
    const captured: Array<Record<string, string | undefined> | undefined> = [];
    await connectMcpSessionTools([
      {
        name: "fake-stdio",
        transport: "stdio",
        command: "fake-mcp",
        args: [],
        env: {
          SAFE_SERVER_VALUE: "safe-value",
          OPENAI_API_KEY: "fake-openai-key",
          CUSTOM_TOKEN: "fake-custom-token",
          CUSTOM_API_KEY_OVERRIDE: "fake-api-key-canary",
          CUSTOM_BASE_URL_OVERRIDE: "https://fake-route.invalid",
          AWS_ACCESS_KEY_ID: "fake-access-key-canary",
        },
      } as any,
    ], {
      profile: CCC_PROFILE,
      subscriptionReady: true,
      maxAttempts: 1,
      retryDelayMs: 0,
      transportFactory: (_server, options: any) => {
        captured.push(options.env);
        return {} as any;
      },
      clientFactory: () => ({
        connect: vi.fn().mockResolvedValue(undefined),
        listTools: vi.fn().mockResolvedValue({ tools: [] }),
        callTool: vi.fn(),
        close: vi.fn().mockResolvedValue(undefined),
      }),
    });

    expect(captured).toEqual([{ SAFE_SERVER_VALUE: "safe-value" }]);
  });

  it("redacts JSON-shaped secrets, escaped values, and protected-path canaries before persistence", async () => {
    const entries: Array<{ text: string; detail?: string }> = [];
    const logger = new AgentLogger({
      persistAgentToolOutput: true,
      appendLog: async (entry) => { entries.push(entry); },
    });
    const jsonToken = "sk_live_example_9Q2";
    const jsonApiKey = "api key value with spaces";
    const escapedSecret = "value with \"quoted text\" and spaces";
    logger.onToolStart("Bash", {
      command: "export API_KEY=fake-secret-canary && cat /fake/_secrets/canary.txt",
      token: jsonToken,
      api_key: jsonApiKey,
    });
    logger.onToolEnd("Bash", false, { secret: escapedSecret, path: "/fake/_KELSEY/canary.txt" });
    logger.onToolEnd("Bash", true, new Error("token=fake-token-canary path=/fake/_secrets/canary.txt"));
    await logger.flush();

    const persisted = JSON.stringify(entries);
    expect(persisted).not.toContain(jsonToken);
    expect(persisted).not.toContain(jsonApiKey);
    expect(persisted).not.toContain("quoted text");
    expect(persisted).not.toContain("fake-secret-canary");
    expect(persisted).not.toContain("fake-token-canary");
    expect(persisted).not.toContain("/fake/_secrets/canary.txt");
    expect(persisted).not.toContain("/fake/_KELSEY/canary.txt");
  });

  it("blocks fn_task_done and records a stable log when ccc scope evaluation throws", async () => {
    const { executor, store, tool } = await setupScopeTask({ customFields: { cccFusionProfile: CCC_PROFILE } });
    vi.spyOn(executor as any, "evaluateTaskDoneScopeLeak").mockRejectedValue(new Error("fake scope evaluation failure"));

    const result = await tool.execute("tool-call", {});

    expect(result.details.error).toBe(SCOPE_FAILURE_MESSAGE);
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-CCC-WAVE-1",
      expect.stringContaining(SCOPE_FAILURE_MESSAGE),
      undefined,
      undefined,
    );
  });

  it("keeps non-ccc scope evaluation failures fail-open for compatibility", async () => {
    const { executor, tool } = await setupScopeTask();
    vi.spyOn(executor as any, "evaluateTaskDoneScopeLeak").mockRejectedValue(new Error("fake scope evaluation failure"));

    const result = await tool.execute("tool-call", {});

    expect(result.content[0].text).toContain("Task marked complete");
  });

  it.each([
    ["scope override", { customFields: { cccFusionProfile: CCC_PROFILE }, scopeOverride: true }, ["docs/allowed.md"], "warn"],
    ["empty declared scope", { customFields: { cccFusionProfile: CCC_PROFILE } }, [], "warn"],
    ["warn-only mode", { customFields: { cccFusionProfile: CCC_PROFILE } }, ["docs/allowed.md"], "warn"],
  ] as const)("does not let ccc %s bypass completion scope verification", async (_label, taskOverrides, scope, enforcement) => {
    const { tool } = await setupScopeTask(taskOverrides, scope, enforcement);
    const result = await tool.execute("tool-call", {});
    expect(result.content[0].text).not.toContain("Task marked complete");
    expect(result.content[0].text).toMatch(/scope/i);
  });
});
