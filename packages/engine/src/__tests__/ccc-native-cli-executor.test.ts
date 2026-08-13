import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CCC_CAMPAIGN_CONTEXT_SCHEMA_VERSION,
  CCC_CAMPAIGN_EXECUTION_POLICY_SCHEMA_VERSION,
  CccProviderAttemptDispatchDecision,
  CccProviderAttemptScope,
  createCccCampaignAuthorityBinding,
  type CccCampaignTaskContext,
  type CccNativeCliRoute,
} from "@fusion/core";
import {
  TaskExecutor,
  type TaskExecutorOptions,
} from "../executor.js";
import {
  CCC_NATIVE_CLI_BINDING_REFUSED_CODE,
  CCC_NATIVE_CLI_DISPATCH_KEY,
  CCC_NATIVE_CLI_PRE_PROVIDER_OBSERVER_ID,
  CCC_NATIVE_CLI_TRANSPORT,
  type CccNativeCliBinding,
  validateCccNativeCliBinding,
} from "../cli-agent/ccc-native-cli-binding.js";
import { CliConcurrencyLimitError } from "../cli-agent/session-manager.js";
import {
  createMockStore,
  resetExecutorMocks,
} from "./executor-test-helpers.js";

const launchCliTaskSessionMock = vi.hoisted(() => vi.fn());
const killLiveTaskSessionsMock = vi.hoisted(() => vi.fn());

vi.mock("../cli-agent/task-session.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../cli-agent/task-session.js")>();
  return {
    ...actual,
    launchCliTaskSession: launchCliTaskSessionMock,
    killLiveTaskSessions: killLiveTaskSessionsMock,
  };
});

const EXECUTION_FENCE = Object.freeze({
  workItemId: "wi-cli-binding-red",
  leaseOwner: "native-cli-worker",
  attempt: 1,
  runId: "FN-6226-run",
});
const WORK_ITEM_FENCE = Object.freeze({
  workItemId: EXECUTION_FENCE.workItemId,
  runId: EXECUTION_FENCE.runId,
  attempt: EXECUTION_FENCE.attempt,
});

type ExecutorPrivate = {
  resolveMcpServers: (agentId?: string) => Promise<unknown[]>;
  runGraphCustomNode: (node: unknown, nodeTask: unknown, settings: unknown, columnBinding: unknown, graphContext: unknown, executionContext: unknown) => Promise<unknown>;
};

type CliExecutorHarness = {
  authorityBinding: ReturnType<typeof createCccCampaignAuthorityBinding>;
  binding: CccNativeCliBinding;
  context: CccCampaignTaskContext;
  cliSettings: Record<string, unknown> | undefined;
  executionFence: Readonly<{
    workItemId: string;
    attempt: number;
    runId: string;
  }>;
  activeCliTaskSessions: Map<string, unknown>;
  launchCliTaskSession: typeof launchCliTaskSessionMock;
  killLiveTaskSessions: typeof killLiveTaskSessionsMock;
  preflightPtyRuntime: ReturnType<typeof vi.fn>;
  preDispatch: ReturnType<typeof vi.fn>;
  reconcile: ReturnType<typeof vi.fn>;
  settleCccProviderAttemptAndFence: ReturnType<typeof vi.fn>;
  runtimeSessions: unknown[];
  resolver: ReturnType<typeof vi.fn>;
  resolveMcpServers: ReturnType<typeof vi.fn>;
  resolveMcpServersSpy: ReturnType<typeof vi.spyOn<ExecutorPrivate, "resolveMcpServers">>;
  route: CccNativeCliRoute;
  run: () => Promise<unknown>;
  sequence: string[];
  store: ReturnType<typeof createMockStore>;
  turnKey: string;
};

type RefusedPermitCase = {
  name: string;
  createScope: (input: {
    authorityBinding: ReturnType<typeof createCccCampaignAuthorityBinding>;
    context: CccCampaignTaskContext;
    scope: CccProviderAttemptScope;
    turnKey: string;
  }) => CccProviderAttemptScope;
};

function createContext(): CccCampaignTaskContext {
  const nowMs = Date.now();
  return {
    schema: CCC_CAMPAIGN_CONTEXT_SCHEMA_VERSION,
    projectId: "project-1",
    importId: "import-1",
    campaignId: "campaign-1",
    taskId: "REQ-9",
    idempotencyKey: "idem-1",
    packetHash: "a".repeat(64),
    sidecarHash: "b".repeat(64),
    bundleHash: "c".repeat(64),
    targetRepository: { path: "/tmp/target", baseCommit: "0".repeat(40) },
    campaignStartedAt: new Date(nowMs).toISOString(),
    campaignDeadlineAt: new Date(nowMs + 5 * 60_000).toISOString(),
    admittedWriteRoots: [],
    proofs: [],
    protectedActions: [],
    executionPolicy: {
      schema: CCC_CAMPAIGN_EXECUTION_POLICY_SCHEMA_VERSION,
      routes: [
        {
          taskId: "REQ-9",
          transport: "cli",
          providerId: "openai",
          modelId: "gpt-4o",
        },
      ],
    },
    route: {
      taskId: "REQ-9",
      transport: "cli",
      providerId: "openai",
      modelId: "gpt-4o",
    },
    manifestHash: "d".repeat(64),
    requestCount: 1,
    bounds: {
      maxRequests: 3,
      maxDurationMs: 60_000,
      maxConcurrency: 1,
    },
    sourceVersion: "semantic-bundle.v1",
    activeActionLeases: {},
  };
}

function createPermitScope(
  context: CccCampaignTaskContext,
  turnKey: string,
  binding: ReturnType<typeof createCccCampaignAuthorityBinding>,
): CccProviderAttemptScope {
  return Object.freeze({
    attemptKey: "ccc-provider-attempt-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    controllerToken: "ccc-provider-controller-01234567-89ab-cdef-0123-456789abcdef",
    taskId: "REQ-9",
    semanticTaskId: "REQ-9",
    campaignDeadlineAt: context.campaignDeadlineAt,
    turnKey,
    dispatchKey: CCC_NATIVE_CLI_DISPATCH_KEY,
    attemptOrdinal: 1,
    requestCount: 1,
    state: "dispatched_unknown",
    workItemFence: WORK_ITEM_FENCE,
    binding,
  }) satisfies CccProviderAttemptScope;
}

function createTerminalScope(
  permitScope: CccProviderAttemptScope,
  input: { outcome: "committed" | "proved_failed"; evidenceDigest: string; observerId: string },
): CccProviderAttemptScope {
  return Object.freeze({
    ...permitScope,
    state: input.outcome,
    terminal: Object.freeze({
      kind: "reconciled",
      state: input.outcome,
      evidenceDigest: input.evidenceDigest,
      observerId: input.observerId,
    }),
  });
}

function createHeldClosureReceipt(
  permitScope: CccProviderAttemptScope,
  authorityBindingHash: string,
  trigger: "done" | "exit" | "cancel" | "lifetime" = "done",
  sessionId = "cli-session-1",
) {
  return Object.freeze({
    kind: "ccc-fusion.native-cli-held-closure",
    version: 1,
    sessionId,
    attemptKey: permitScope.attemptKey,
    controllerToken: permitScope.controllerToken,
    taskId: permitScope.taskId,
    authorityBindingHash,
    turnKey: permitScope.turnKey,
    dispatchKey: CCC_NATIVE_CLI_DISPATCH_KEY,
    trigger,
    exitCode: 0,
    exitSignal: 0,
    processGroupClosed: true,
    proxyClosed: true,
    durableFloorFlushed: true,
    slotHeld: true,
  });
}

type HarnessOptions = {
  unfenced?: boolean;
  nodeTaskWorktree?: string;
  omitNodeTaskWorktree?: boolean;
  persistedNodeTaskWorktree?: string;
  sealedSignal?: AbortSignal;
  cliProfile?: string;
  cliProviderId?: string;
  cliModel?: string;
  omitCliSettings?: boolean;
  legacyRootProfile?: string;
};

function createHarness(
  createDecision?: (input: {
    authorityBinding: ReturnType<typeof createCccCampaignAuthorityBinding>;
    context: CccCampaignTaskContext;
    scope: CccProviderAttemptScope;
    turnKey: string;
  }) => CccProviderAttemptDispatchDecision,
  options: HarnessOptions = {},
): CliExecutorHarness {
  const sequence: string[] = [];
  const context = createContext();
  const authorityBinding = Object.freeze(createCccCampaignAuthorityBinding(context, {
    actionId: "provider:direct",
    actionTarget: "REQ-9",
  }));
  const turnKey = "ccc-cli-turn-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const preDispatchScope = createPermitScope(context, turnKey, authorityBinding);
  const preDispatchDecision = createDecision?.({
    authorityBinding,
    context,
    scope: preDispatchScope,
    turnKey,
  }) ?? Object.freeze({
    kind: "dispatch-permit",
    scope: preDispatchScope,
  });

  const preDispatch = vi.fn(async () => {
    sequence.push("preDispatch");
    return preDispatchDecision;
  });
  const reconcile = vi.fn(async (input: {
    outcome: "committed" | "proved_failed";
    evidenceDigest: string;
    observerId: string;
  }) => {
    sequence.push("reconcile");
    return createTerminalScope(preDispatchScope, input);
  });
  const settleCccProviderAttemptAndFence = vi.fn(async (input: {
    reconciliation: {
      outcome: "committed" | "proved_failed";
      evidenceDigest: string;
      observerId: string;
    };
  }) => {
    sequence.push("settle");
    return Object.freeze({
      ...preDispatchScope,
      state: input.reconciliation.outcome,
      terminal: Object.freeze({
        kind: "reconciled",
        state: input.reconciliation.outcome,
        evidenceDigest: input.reconciliation.evidenceDigest,
        observerId: input.reconciliation.observerId,
      }),
    });
  });
  const route: CccNativeCliRoute = Object.freeze({
    adapterId: "test-cli-adapter",
    providerId: "openai",
    modelId: "gpt-4o",
    transport: CCC_NATIVE_CLI_TRANSPORT,
  });

  const binding = Object.freeze({
    kind: "ccc-fusion.native-cli-binding",
    version: 1,
    id: "fusion-native:ccc-cli-one-shot",
    turnKey,
    dispatchKey: CCC_NATIVE_CLI_DISPATCH_KEY,
    authorityBindingHash: authorityBinding.bindingHash,
    route,
    limits: Object.freeze({
      maxRequests: 1,
      lifetimeMs: 60_000,
      termGraceMs: 5_000,
      killClosureMs: 5_000,
    }),
    followUp: false,
    observer: Object.freeze({
      id: "ccc-native-cli-observer.v1",
      observe: vi.fn(),
    }),
    controller: Object.freeze({
      preDispatch,
      reconcile,
    }),
  }) as CccNativeCliBinding;

  const resolver = vi.fn(async () => {
    sequence.push("resolver");
    return binding;
  });

  const store = createMockStore();
  const runtimeSessions: unknown[] = [];
  const runtimeStore = {
    listByTask: () => runtimeSessions,
    settleCccProviderAttemptAndFence,
  };
  const preflightPtyRuntime = vi.fn(async () => {
    sequence.push("pty-preflight");
  });
  const runtime: TaskExecutorOptions["cliAgentRuntime"] = {
    manager: {
      preflightPtyRuntime,
    } as unknown as TaskExecutorOptions["cliAgentRuntime"]["manager"],
    hub: {} as TaskExecutorOptions["cliAgentRuntime"]["hub"],
    registry: {} as TaskExecutorOptions["cliAgentRuntime"]["registry"],
    store: runtimeStore as TaskExecutorOptions["cliAgentRuntime"]["store"],
    projectId: "project-1",
    hookEndpointUrl: "http://127.0.0.1:1/unused",
    resolveCccNativeCliBinding: resolver,
  };
  const executor = new TaskExecutor(store, "/tmp/test", { cliAgentRuntime: runtime });

  launchCliTaskSessionMock.mockImplementation(async () => {
    sequence.push("launch");
    return {
      result: async () => ({ kind: "needs-attention" as const }),
      reap: async () => undefined,
    };
  });
  killLiveTaskSessionsMock.mockImplementation(async () => {
    sequence.push("kill");
    return undefined;
  });

  const executorPrivate = executor as unknown as ExecutorPrivate;
  const resolveMcpServers = vi.fn(async () => {
    sequence.push("mcp");
    return [];
  });
  const resolveMcpServersSpy = vi.spyOn(executorPrivate, "resolveMcpServers").mockImplementation(resolveMcpServers);

  const executionFence = EXECUTION_FENCE;
  const execution = Object.freeze({
    originTaskId: "FN-6226",
    semanticTaskId: "REQ-9",
    nativeTaskId: "REQ-9",
    semanticTask: { id: "REQ-9", executionMode: "fast" },
    runId: "FN-6226-run",
    visitIdentity: Object.freeze({ nodeId: "cli-node", materializedNodeId: "cli-node" }),
    executionFence,
    providerAttemptTurnKey: turnKey,
  });

  const sealedExecutionContext = Object.freeze({
    task: {
      id: "REQ-9",
      modelProvider: "openai",
      modelId: "gpt-4o",
    },
    settings: undefined,
    context: {},
    execution,
    signal: options.sealedSignal ?? new AbortController().signal,
  });

  const nodeTask = {
    id: "REQ-9",
    ...(
      options.omitNodeTaskWorktree
        ? {}
        : {
          worktree: options.nodeTaskWorktree ?? "/tmp/cli-test",
        }
    ),
    executionMode: "fast",
    modelProvider: "openai",
    modelId: "gpt-4o",
    title: "CLI test",
    description: "desc",
    column: "in-progress",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    prompt: "# Task\n",
    createdAt: "2026-07-25T19:00:00.000Z",
    updatedAt: "2026-07-25T19:00:00.000Z",
  };
  store.getTask.mockResolvedValue(options.persistedNodeTaskWorktree
    ? { ...nodeTask, worktree: options.persistedNodeTaskWorktree }
    : nodeTask);
  const cliSettings = options.omitCliSettings
    ? undefined
    : {
      profile: options.cliProfile ?? "ccc-fusion",
      providerId: options.cliProviderId ?? "openai",
      model: options.cliModel ?? "gpt-4o",
    };

  return {
    authorityBinding,
    binding,
    cliSettings,
    context,
    executionFence,
    activeCliTaskSessions: executor["activeCliTaskSessions"] as Map<string, unknown>,
    launchCliTaskSession: launchCliTaskSessionMock,
    killLiveTaskSessions: killLiveTaskSessionsMock,
    preflightPtyRuntime,
    preDispatch,
    reconcile,
    settleCccProviderAttemptAndFence,
    runtimeSessions,
    resolver,
    resolveMcpServers,
    resolveMcpServersSpy,
    route,
    run: () => executorPrivate.runGraphCustomNode(
      {
        id: "cli-native-node",
        kind: "prompt",
        config: {
          executor: "cli-agent",
          cliAdapterId: "test-cli-adapter",
          ...(options.legacyRootProfile
            ? { profile: options.legacyRootProfile }
            : {}),
          ...(cliSettings ? { cliSettings } : {}),
          prompt: "Run ccc native CLI task",
        },
      },
      nodeTask,
      {},
      undefined,
      Object.freeze({}),
      options.unfenced ? undefined : sealedExecutionContext,
    ),
    sequence,
    store,
    turnKey,
  };
}

describe("runGraphCustomNode CLI agent native dispatch", () => {
  beforeEach(() => {
    resetExecutorMocks();
    launchCliTaskSessionMock.mockReset();
    killLiveTaskSessionsMock.mockReset();
  });

  it("RED-PRODUCT-serial-cli: refreshes a task prepared after graph resolution before fenced dispatch", async () => {
    const preparedWorktree = "/tmp/cli-prepared-after-graph-resolution";
    const h = createHarness(undefined, {
      omitNodeTaskWorktree: true,
      persistedNodeTaskWorktree: preparedWorktree,
    });

    try {
      await expect(h.run()).resolves.toEqual({
        outcome: "failure",
        value: "cli-agent-needs-attention",
      });
      expect(h.store.getTask).toHaveBeenCalledWith("REQ-9");
      expect(h.launchCliTaskSession).toHaveBeenCalledWith(expect.objectContaining({
        worktreePath: preparedWorktree,
      }));
      expect(h.sequence).toEqual([
        "pty-preflight",
        "resolver",
        "preDispatch",
        "mcp",
        "kill",
        "launch",
      ]);
    } finally {
      h.resolveMcpServersSpy.mockRestore();
    }
  });

  it("Task 4 RED: valid custody-bound CLI binding earns one permit before one launch", async () => {
    const h = createHarness();

    try {
      const result = await h.run();

      expect(result).toEqual({
        outcome: "failure",
        value: "cli-agent-needs-attention",
      });

      expect(validateCccNativeCliBinding(h.binding, {
        turnKey: h.turnKey,
        route: h.route,
      })).toBe(h.binding);

      expect(h.preDispatch).toHaveBeenCalledOnce();
      expect(h.preDispatch).toHaveBeenCalledWith({
        turnKey: h.turnKey,
        dispatchKey: CCC_NATIVE_CLI_DISPATCH_KEY,
        providerId: "openai",
        modelId: "gpt-4o",
        transport: CCC_NATIVE_CLI_TRANSPORT,
      });
      expect(createPermitScope(h.context, h.turnKey, h.authorityBinding)).toEqual({
        attemptKey: "ccc-provider-attempt-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        controllerToken: "ccc-provider-controller-01234567-89ab-cdef-0123-456789abcdef",
        taskId: "REQ-9",
        semanticTaskId: "REQ-9",
        campaignDeadlineAt: h.context.campaignDeadlineAt,
        turnKey: h.turnKey,
        dispatchKey: CCC_NATIVE_CLI_DISPATCH_KEY,
        attemptOrdinal: 1,
        requestCount: 1,
        state: "dispatched_unknown",
        workItemFence: WORK_ITEM_FENCE,
        binding: h.authorityBinding,
      });
      expect(h.reconcile).toHaveBeenCalledTimes(0);
      expect(h.resolveMcpServers).toHaveBeenCalledOnce();
      expect(h.killLiveTaskSessions).toHaveBeenCalledOnce();
      expect(h.launchCliTaskSession).toHaveBeenCalledOnce();
      expect(h.activeCliTaskSessions.get("REQ-9")).toBeDefined();
      expect(h.launchCliTaskSession.mock.calls.at(0)?.[0]).toEqual(expect.objectContaining({
        config: expect.objectContaining({
          settings: {
            profile: "ccc-fusion",
            providerId: "openai",
            model: "gpt-4o",
            subscriptionReady: true,
          },
        }),
        cccNativeCli: expect.objectContaining({
          attemptKey: createPermitScope(h.context, h.turnKey, h.authorityBinding).attemptKey,
          controllerToken: createPermitScope(h.context, h.turnKey, h.authorityBinding).controllerToken,
          taskId: "REQ-9",
          authorityBindingHash: h.authorityBinding.bindingHash,
          turnKey: h.turnKey,
          dispatchKey: CCC_NATIVE_CLI_DISPATCH_KEY,
        }),
      }));
      expect(h.cliSettings).toEqual({
        profile: "ccc-fusion",
        providerId: "openai",
        model: "gpt-4o",
      });
      expect(h.store.logEntry).not.toHaveBeenCalled();
      expect(h.store.updateTask).not.toHaveBeenCalled();

      const resolverInput = h.resolver.mock.calls.at(0)?.[0] as Record<string, unknown>;
      expect(resolverInput).toMatchObject({
        nodeId: "cli-native-node",
        originTaskId: "FN-6226",
        semanticTaskId: "REQ-9",
        turnKey: h.turnKey,
        expectedRoute: h.route,
        executionFence: h.executionFence,
        visitIdentity: { nodeId: "cli-node", materializedNodeId: "cli-node" },
      });

      expect(h.sequence).toEqual([
        "pty-preflight",
        "resolver",
        "preDispatch",
        "mcp",
        "kill",
        "launch",
      ]);
    } finally {
      h.resolveMcpServersSpy.mockRestore();
      h.launchCliTaskSession.mockReset();
      h.killLiveTaskSessions.mockReset();
    }
  });

  it("P1 RED: restart reconciles one exact durable held-closed CLI receipt without replaying the provider", async () => {
    const h = createHarness(({ scope }) => Object.freeze({
      kind: "hold",
      reason: "dispatched-unknown",
      scope,
    }));
    const permitScope = createPermitScope(h.context, h.turnKey, h.authorityBinding);
    const receipt = createHeldClosureReceipt(
      permitScope,
      h.authorityBinding.bindingHash,
    );
    h.runtimeSessions.push({
      id: receipt.sessionId,
      taskId: permitScope.taskId,
      purpose: "execute",
      adapterId: h.route.adapterId,
      agentState: "needsAttention",
      terminationReason: null,
      worktreePath: "/tmp/cli-test",
      autonomyPosture: {
        cccNativeCliOneShot: true,
        cccProviderAttemptKey: permitScope.attemptKey,
        cccProviderAttemptControllerToken: permitScope.controllerToken,
        cccControllerGeneration: permitScope.controllerToken,
        cccControllerFenced: false,
        cccAuthorityBindingHash: h.authorityBinding.bindingHash,
        cccNativeCliTurnKey: permitScope.turnKey,
        cccNativeCliDispatchKey: permitScope.dispatchKey,
        cccNativeCliClosureState: "held-closed",
        cccNativeCliHeldClosureEvidence: {
          kind: "ccc-fusion.native-cli-held-closure-evidence",
          version: 1,
          sessionId: receipt.sessionId,
          trigger: receipt.trigger,
          exitCode: receipt.exitCode,
          exitSignal: receipt.exitSignal,
          processGroupClosed: true,
          proxyClosed: true,
          durableFloorFlushed: true,
          slotHeld: true,
        },
      },
    });
    vi.mocked(h.binding.observer.observe).mockImplementationOnce(() => {
      h.sequence.push("observe-restart");
      return Object.freeze({
        kind: "ccc-fusion.native-cli-observation",
        version: 1,
        outcome: "committed",
        evidenceDigest: "e".repeat(64),
      });
    });

    try {
      await expect(h.run()).resolves.toEqual({
        outcome: "success",
        value: "cli-agent-done",
      });
      expect(h.sequence).toEqual([
        "pty-preflight",
        "resolver",
        "preDispatch",
        "observe-restart",
        "reconcile",
      ]);
      expect(h.resolveMcpServers).not.toHaveBeenCalled();
      expect(h.killLiveTaskSessions).not.toHaveBeenCalled();
      expect(h.launchCliTaskSession).not.toHaveBeenCalled();
      expect(h.reconcile).toHaveBeenCalledWith(expect.objectContaining({
        taskId: permitScope.taskId,
        attemptKey: permitScope.attemptKey,
        controllerToken: permitScope.controllerToken,
        outcome: "committed",
        observerId: "ccc-native-cli-observer.v1",
        effectiveRoute: {
          effectiveProvider: h.route.providerId,
          effectiveModel: h.route.modelId,
          usage: null,
          cost: { kind: "unknown", reason: "cli-adapter-observes-no-usage-or-identity-telemetry" },
          receiptSource: "none",
        },
      }));
    } finally {
      h.resolveMcpServersSpy.mockRestore();
    }
  });

  it.each([
    { outcome: "committed" as const, expected: { outcome: "success", value: "cli-agent-done" } },
    { outcome: "proved_failed" as const, expected: { outcome: "failure", value: "cli-agent-proved-failed" } },
  ])("P1 RED: restart replays an exact terminal CLI attempt as $outcome without dispatch", async ({ outcome, expected }) => {
    const h = createHarness(({ scope }) => Object.freeze({
      kind: "hold",
      reason: "terminal",
      scope: createTerminalScope(scope, {
        outcome,
        evidenceDigest: "f".repeat(64),
        observerId: "ccc-native-cli-observer.v1",
      }),
    }));

    try {
      await expect(h.run()).resolves.toEqual(expected);
      expect(h.sequence).toEqual([
        "pty-preflight",
        "resolver",
        "preDispatch",
      ]);
      expect(h.resolveMcpServers).not.toHaveBeenCalled();
      expect(h.killLiveTaskSessions).not.toHaveBeenCalled();
      expect(h.launchCliTaskSession).not.toHaveBeenCalled();
      expect(h.reconcile).not.toHaveBeenCalled();
    } finally {
      h.resolveMcpServersSpy.mockRestore();
    }
  });

  it("refuses a missing PTY dependency before binding, permit, session, or provider residue", async () => {
    const h = createHarness();
    const preflightError = Object.assign(
      new Error("CCC native CLI PTY runtime is unavailable"),
      { code: "CCC_NATIVE_CLI_PTY_PREFLIGHT_FAILED" },
    );
    h.preflightPtyRuntime.mockImplementationOnce(async () => {
      h.sequence.push("pty-preflight");
      throw preflightError;
    });

    try {
      await expect(h.run()).rejects.toBe(preflightError);
      expect(h.sequence).toEqual(["pty-preflight"]);
      expect(h.resolver).not.toHaveBeenCalled();
      expect(h.preDispatch).not.toHaveBeenCalled();
      expect(h.resolveMcpServers).not.toHaveBeenCalled();
      expect(h.killLiveTaskSessions).not.toHaveBeenCalled();
      expect(h.launchCliTaskSession).not.toHaveBeenCalled();
      expect(h.reconcile).not.toHaveBeenCalled();
      expect(h.settleCccProviderAttemptAndFence).not.toHaveBeenCalled();
      expect(h.store.logEntry).not.toHaveBeenCalled();
      expect(h.store.updateTask).not.toHaveBeenCalled();
    } finally {
      h.resolveMcpServersSpy.mockRestore();
    }
  });

  it.each([
    {
      name: "provider",
      options: { cliProviderId: "anthropic" },
      message: "CLI settings providerId 'anthropic' does not match execution route providerId 'openai'",
    },
    {
      name: "model",
      options: { cliModel: "gpt-4.1" },
      message: "CLI settings model 'gpt-4.1' does not match execution route modelId 'gpt-4o'",
    },
  ])("refuses stable $name route drift before binding resolution or launch", async ({ options, message }) => {
    const h = createHarness(undefined, options);

    try {
      await expect(h.run()).rejects.toMatchObject({
        code: CCC_NATIVE_CLI_BINDING_REFUSED_CODE,
        message: expect.stringContaining(message),
      });
      expect(h.sequence).toEqual([]);
      expect(h.preDispatch).toHaveBeenCalledTimes(0);
      expect(h.resolveMcpServers).toHaveBeenCalledTimes(0);
      expect(h.killLiveTaskSessions).toHaveBeenCalledTimes(0);
      expect(h.launchCliTaskSession).toHaveBeenCalledTimes(0);
      expect(h.cliSettings).not.toHaveProperty("subscriptionReady");
    } finally {
      h.resolveMcpServersSpy.mockRestore();
    }
  });

  it("snapshots stable route settings before the async permit so launch values cannot drift", async () => {
    const h = createHarness();
    const preDispatchImplementation = h.preDispatch.getMockImplementation();
    h.preDispatch.mockImplementationOnce(async (...args: unknown[]) => {
      h.cliSettings!.providerId = "anthropic";
      h.cliSettings!.model = "gpt-4.1";
      return preDispatchImplementation!(...args);
    });

    try {
      await h.run();

      expect(h.launchCliTaskSession.mock.calls.at(0)?.[0]).toEqual(expect.objectContaining({
        config: expect.objectContaining({
          settings: {
            profile: "ccc-fusion",
            providerId: "openai",
            model: "gpt-4o",
            subscriptionReady: true,
          },
        }),
      }));
      expect(h.sequence).toEqual([
        "pty-preflight",
        "resolver",
        "preDispatch",
        "mcp",
        "kill",
        "launch",
      ]);
    } finally {
      h.resolveMcpServersSpy.mockRestore();
    }
  });

  it("clears ordinary CLI session ownership when session.result rejects", async () => {
    const h = createHarness(undefined, { unfenced: true });
    const resultError = new Error("ordinary result rejected");
    h.launchCliTaskSession.mockImplementationOnce(async () => ({
      result: async () => { throw resultError; },
      reap: async () => undefined,
    }));

    await expect(h.run()).rejects.toThrow("ordinary result rejected");
    expect(h.activeCliTaskSessions.get("REQ-9")).toBeUndefined();
  });

  it.each<{
    name: string;
    arrange: (h: CliExecutorHarness, error: Error) => void;
    sequence: string[];
  }>([
    {
      name: "MCP resolution",
      arrange: (h, error) => {
        h.resolveMcpServers.mockImplementationOnce(async () => {
          h.sequence.push("mcp");
          throw error;
        });
      },
      sequence: ["pty-preflight", "resolver", "preDispatch", "mcp", "reconcile"],
    },
    {
      name: "prior-session kill",
      arrange: (h, error) => {
        h.killLiveTaskSessions.mockImplementationOnce(async () => {
          h.sequence.push("kill");
          throw error;
        });
      },
      sequence: [
        "pty-preflight",
        "resolver",
        "preDispatch",
        "mcp",
        "kill",
        "reconcile",
      ],
    },
  ])("Task 4 RED: terminalizes permit when $name fails before session ownership", async ({ arrange, sequence }) => {
    const h = createHarness();
    const permitScope = createPermitScope(h.context, h.turnKey, h.authorityBinding);
    const error = new Error("pre-provider failed");
    arrange(h, error);

    await expect(h.run()).rejects.toThrow("pre-provider failed");

    expect(h.activeCliTaskSessions.get("REQ-9")).toBeUndefined();
    expect(h.reconcile).toHaveBeenCalledOnce();
    expect(h.reconcile).toHaveBeenCalledWith({
      taskId: permitScope.taskId,
      attemptKey: permitScope.attemptKey,
      controllerToken: permitScope.controllerToken,
      outcome: "proved_failed",
      evidenceDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      observerId: CCC_NATIVE_CLI_PRE_PROVIDER_OBSERVER_ID,
      terminationReason: "crashed",
      cancellationState: null,
    });
    expect(h.sequence).toEqual(sequence);
  });

  it("Task 4 RED: typed launch rejection reconciles permit as proved_failed before caller sees capacity rejection", async () => {
    const h = createHarness();
    const permitScope = createPermitScope(h.context, h.turnKey, h.authorityBinding);
    h.launchCliTaskSession.mockImplementationOnce(async () => {
      h.sequence.push("launch");
      throw new CliConcurrencyLimitError(2, 2);
    });

    await expect(h.run()).resolves.toMatchObject({
      outcome: "failure",
      value: "cli-agent-at-capacity",
    });

    expect(h.activeCliTaskSessions.get("REQ-9")).toBeUndefined();
    expect(h.reconcile).toHaveBeenCalledOnce();
    expect(h.reconcile).toHaveBeenCalledWith({
      taskId: permitScope.taskId,
      attemptKey: permitScope.attemptKey,
      controllerToken: permitScope.controllerToken,
      outcome: "proved_failed",
      evidenceDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      observerId: CCC_NATIVE_CLI_PRE_PROVIDER_OBSERVER_ID,
      terminationReason: "crashed",
      cancellationState: null,
    });
    // Pre-provider failure never dispatched, so it must not carry an effectiveRoute claim.
    expect(h.reconcile.mock.calls.at(0)?.[0]).not.toHaveProperty("effectiveRoute");
    expect(h.sequence).toEqual([
      "pty-preflight",
      "resolver",
      "preDispatch",
      "mcp",
      "kill",
      "launch",
      "reconcile",
    ]);
  });

  it("Task 4 RED: generic launch rejection remains unknown/no auto-reconcile before ownership", async () => {
    const h = createHarness();
    h.launchCliTaskSession.mockImplementationOnce(async () => {
      h.sequence.push("launch");
      throw new Error("generic launch rejected");
    });

    await expect(h.run()).rejects.toThrow("generic launch rejected");

    expect(h.activeCliTaskSessions.get("REQ-9")).toBeUndefined();
    expect(h.reconcile).toHaveBeenCalledTimes(0);
    expect(h.sequence).toEqual([
      "pty-preflight",
      "resolver",
      "preDispatch",
      "mcp",
      "kill",
      "launch",
    ]);
  });

  it("Task 4 GREEN: pre-provider evidence is stable across different thrown messages", async () => {
    const runWith = async (message: string): Promise<string> => {
      const h = createHarness();
      h.resolveMcpServers.mockImplementationOnce(async () => {
        h.sequence.push("mcp");
        throw new Error(message);
      });

      try {
        await expect(h.run()).rejects.toThrow(message);
        const reconciliation = h.reconcile.mock.calls.at(0)?.[0] as { evidenceDigest: string } | undefined;
        expect(reconciliation?.evidenceDigest).toMatch(/^[0-9a-f]{64}$/);
        return reconciliation?.evidenceDigest ?? "";
      } finally {
        h.resolveMcpServersSpy.mockRestore();
      }
    };

    const firstDigest = await runWith("credential-like text must not affect receipt");
    const secondDigest = await runWith("different arbitrary failure detail");

    expect(secondDigest).toBe(firstDigest);
  });

  it.each([
    {
      name: "foreign terminal scope",
      arrange: (h: CliExecutorHarness, permitScope: CccProviderAttemptScope) => {
        h.launchCliTaskSession.mockImplementationOnce(async () => {
          h.sequence.push("launch");
          throw new CliConcurrencyLimitError(2, 2);
        });
        h.reconcile.mockImplementationOnce(async (input) => {
          h.sequence.push("reconcile");
          return createTerminalScope(permitScope, {
            outcome: input.outcome,
            evidenceDigest: input.evidenceDigest,
            observerId: "foreign-observer",
          });
        });
      },
      expected: { code: CCC_NATIVE_CLI_BINDING_REFUSED_CODE },
    },
    {
      name: "reconcile rejection",
      arrange: (h: CliExecutorHarness) => {
        h.launchCliTaskSession.mockImplementationOnce(async () => {
          h.sequence.push("launch");
          throw new CliConcurrencyLimitError(2, 2);
        });
        h.reconcile.mockImplementationOnce(async () => {
          h.sequence.push("reconcile");
          throw new Error("reconcile denied");
        });
      },
      expected: { message: "reconcile denied" },
    },
  ])("Task 4 RED: $name never fabricates at-capacity after pre-provider reconciliation fails", async ({ arrange, expected }) => {
    const h = createHarness();
    arrange(h, createPermitScope(h.context, h.turnKey, h.authorityBinding));

    await expect(h.run()).rejects.toMatchObject(expected);

    expect(h.activeCliTaskSessions.get("REQ-9")).toBeUndefined();
    expect(h.store.logEntry).not.toHaveBeenCalled();
    expect(h.sequence).toEqual([
      "pty-preflight",
      "resolver",
      "preDispatch",
      "mcp",
      "kill",
      "launch",
      "reconcile",
    ]);
  });

  it("Task 4 RED: active session stays owned while held closure observer/reconcile runs", async () => {
    const h = createHarness();
    const permitScope = createPermitScope(h.context, h.turnKey, h.authorityBinding);
    const receipt = Object.freeze({
      kind: "ccc-fusion.native-cli-held-closure",
      version: 1,
      sessionId: "cli-session-1",
      attemptKey: permitScope.attemptKey,
      controllerToken: permitScope.controllerToken,
      taskId: permitScope.taskId,
      authorityBindingHash: h.authorityBinding.bindingHash,
      turnKey: h.turnKey,
      dispatchKey: CCC_NATIVE_CLI_DISPATCH_KEY,
      trigger: "done",
      exitCode: 0,
      exitSignal: 0,
      processGroupClosed: true,
      proxyClosed: true,
      durableFloorFlushed: true,
      slotHeld: true,
    });
    const observation = Object.freeze({
      kind: "ccc-fusion.native-cli-observation",
      version: 1,
      outcome: "committed",
      evidenceDigest: "e".repeat(64),
    });
    vi.mocked(h.binding.observer.observe).mockImplementation(() => {
      h.sequence.push("observe");
      expect(h.activeCliTaskSessions.get("REQ-9")).toBeDefined();
      return observation;
    });
    const releaseCccNativeCli = vi.fn(async () => {
      h.sequence.push("release");
    });
    h.launchCliTaskSession.mockImplementationOnce(async () => {
      h.sequence.push("launch");
      return {
        sessionId: "cli-session-1",
        result: async () => ({
          kind: "ccc-native-held-closed" as const,
          sessionId: "cli-session-1",
          terminationReason: null,
          nativeCliHeldClosureReceipt: receipt,
        }),
        reap: async () => undefined,
        releaseCccNativeCli,
      };
    });

    await expect(h.run()).resolves.toEqual({
      outcome: "success",
      value: "cli-agent-done",
    });

    expect(h.activeCliTaskSessions.get("REQ-9")).toBeUndefined();
    expect(h.sequence).toEqual([
      "pty-preflight",
      "resolver",
      "preDispatch",
      "mcp",
      "kill",
      "launch",
      "observe",
      "reconcile",
      "release",
    ]);
    expect(releaseCccNativeCli).toHaveBeenCalledTimes(1);
    expect(h.reconcile).toHaveBeenCalledWith({
      taskId: permitScope.taskId,
      attemptKey: permitScope.attemptKey,
      controllerToken: permitScope.controllerToken,
      outcome: "committed",
      evidenceDigest: "e".repeat(64),
      observerId: "ccc-native-cli-observer.v1",
      terminationReason: "completed",
      cancellationState: null,
      effectiveRoute: {
        effectiveProvider: h.route.providerId,
        effectiveModel: h.route.modelId,
        usage: null,
        cost: { kind: "unknown", reason: "cli-adapter-observes-no-usage-or-identity-telemetry" },
        receiptSource: "none",
      },
    });
    expect(Object.isFrozen(h.reconcile.mock.calls.at(0)?.[0])).toBe(true);
    expect(h.settleCccProviderAttemptAndFence).not.toHaveBeenCalled();
  });

  it("Task 4 RED: async observer promise must be awaited before terminal settle", async () => {
    const h = createHarness();
    const permitScope = createPermitScope(h.context, h.turnKey, h.authorityBinding);
    const receipt = Object.freeze({
      kind: "ccc-fusion.native-cli-held-closure",
      version: 1,
      sessionId: "cli-session-1",
      attemptKey: permitScope.attemptKey,
      controllerToken: permitScope.controllerToken,
      taskId: permitScope.taskId,
      authorityBindingHash: h.authorityBinding.bindingHash,
      turnKey: h.turnKey,
      dispatchKey: CCC_NATIVE_CLI_DISPATCH_KEY,
      trigger: "done",
      exitCode: 0,
      exitSignal: 0,
      processGroupClosed: true,
      proxyClosed: true,
      durableFloorFlushed: true,
      slotHeld: true,
    });
    const observation = Object.freeze({
      kind: "ccc-fusion.native-cli-observation",
      version: 1,
      outcome: "committed",
      evidenceDigest: "e".repeat(64),
    });
    vi.mocked(h.binding.observer.observe).mockImplementation(async () => {
      h.sequence.push("observe-pending");
      return observation;
    });
    h.launchCliTaskSession.mockImplementationOnce(async () => {
      h.sequence.push("launch");
      return {
        sessionId: "cli-session-1",
        result: async () => ({
          kind: "ccc-native-held-closed" as const,
          sessionId: "cli-session-1",
          terminationReason: null,
          nativeCliHeldClosureReceipt: receipt,
        }),
        reap: async () => undefined,
        releaseCccNativeCli: async () => undefined,
      };
    });

    await expect(h.run()).resolves.toEqual({
      outcome: "success",
      value: "cli-agent-done",
    });
    expect(h.sequence).toEqual([
      "pty-preflight",
      "resolver",
      "preDispatch",
      "mcp",
      "kill",
      "launch",
      "observe-pending",
      "reconcile",
    ]);
    expect(h.reconcile).toHaveBeenCalledTimes(1);
    expect(h.settleCccProviderAttemptAndFence).not.toHaveBeenCalled();
  });

  it("Task 4 RED: held-closure reconciliation must use controller.reconcile not store settle helper", async () => {
    const h = createHarness();
    const permitScope = createPermitScope(h.context, h.turnKey, h.authorityBinding);
    const receipt = Object.freeze({
      kind: "ccc-fusion.native-cli-held-closure",
      version: 1,
      sessionId: "cli-session-1",
      attemptKey: permitScope.attemptKey,
      controllerToken: permitScope.controllerToken,
      taskId: permitScope.taskId,
      authorityBindingHash: h.authorityBinding.bindingHash,
      turnKey: h.turnKey,
      dispatchKey: CCC_NATIVE_CLI_DISPATCH_KEY,
      trigger: "done",
      exitCode: 0,
      exitSignal: 0,
      processGroupClosed: true,
      proxyClosed: true,
      durableFloorFlushed: true,
      slotHeld: true,
    });
    const observation = Object.freeze({
      kind: "ccc-fusion.native-cli-observation",
      version: 1,
      outcome: "committed",
      evidenceDigest: "e".repeat(64),
    });
    vi.mocked(h.binding.observer.observe).mockReturnValueOnce(observation);
    h.launchCliTaskSession.mockImplementationOnce(async () => ({
      sessionId: "cli-session-1",
      result: async () => ({
        kind: "ccc-native-held-closed" as const,
        sessionId: "cli-session-1",
        terminationReason: null,
        nativeCliHeldClosureReceipt: receipt,
      }),
      reap: async () => undefined,
      releaseCccNativeCli: async () => undefined,
    }));

    await expect(h.run()).resolves.toEqual({
      outcome: "success",
      value: "cli-agent-done",
    });
    expect(h.reconcile).toHaveBeenCalledOnce();
    expect(h.reconcile).toHaveBeenCalledWith({
      attemptKey: permitScope.attemptKey,
      controllerToken: permitScope.controllerToken,
      taskId: permitScope.taskId,
      outcome: observation.outcome,
      evidenceDigest: observation.evidenceDigest,
      observerId: "ccc-native-cli-observer.v1",
      terminationReason: "completed",
      cancellationState: null,
      effectiveRoute: {
        effectiveProvider: h.route.providerId,
        effectiveModel: h.route.modelId,
        usage: null,
        cost: { kind: "unknown", reason: "cli-adapter-observes-no-usage-or-identity-telemetry" },
        receiptSource: "none",
      },
    });
    expect(h.settleCccProviderAttemptAndFence).not.toHaveBeenCalled();
  });

  it("Task 4 RED: observer throw/reject should retain activeCliTaskSessions ownership", async () => {
    const h = createHarness();
    const permitScope = createPermitScope(h.context, h.turnKey, h.authorityBinding);
    const receipt = Object.freeze({
      kind: "ccc-fusion.native-cli-held-closure",
      version: 1,
      sessionId: "cli-session-1",
      attemptKey: permitScope.attemptKey,
      controllerToken: permitScope.controllerToken,
      taskId: permitScope.taskId,
      authorityBindingHash: h.authorityBinding.bindingHash,
      turnKey: h.turnKey,
      dispatchKey: CCC_NATIVE_CLI_DISPATCH_KEY,
      trigger: "done",
      exitCode: 0,
      exitSignal: 0,
      processGroupClosed: true,
      proxyClosed: true,
      durableFloorFlushed: true,
      slotHeld: true,
    });
    const observerError = new Error("observer threw");
    vi.mocked(h.binding.observer.observe).mockImplementation(() => {
      h.sequence.push("observe");
      throw observerError;
    });
    const releaseCccNativeCli = vi.fn(async () => {
      h.sequence.push("release");
    });
    h.launchCliTaskSession.mockImplementationOnce(async () => ({
      sessionId: "cli-session-1",
      result: async () => ({
        kind: "ccc-native-held-closed" as const,
        sessionId: "cli-session-1",
        terminationReason: null,
        nativeCliHeldClosureReceipt: receipt,
      }),
      reap: async () => undefined,
      releaseCccNativeCli,
    }));

    await expect(h.run()).rejects.toThrow("observer threw");
    expect(h.activeCliTaskSessions.get("REQ-9")).toBeDefined();
    expect(h.sequence).toEqual([
      "pty-preflight",
      "resolver",
      "preDispatch",
      "mcp",
      "kill",
      "observe",
    ]);
    expect(releaseCccNativeCli).toHaveBeenCalledTimes(0);
  });

  it("Task 4 RED: controller.reconcile throw/reject should retain activeCliTaskSessions ownership and not release", async () => {
    const h = createHarness();
    const permitScope = createPermitScope(h.context, h.turnKey, h.authorityBinding);
    const receipt = Object.freeze({
      kind: "ccc-fusion.native-cli-held-closure",
      version: 1,
      sessionId: "cli-session-1",
      attemptKey: permitScope.attemptKey,
      controllerToken: permitScope.controllerToken,
      taskId: permitScope.taskId,
      authorityBindingHash: h.authorityBinding.bindingHash,
      turnKey: h.turnKey,
      dispatchKey: CCC_NATIVE_CLI_DISPATCH_KEY,
      trigger: "done",
      exitCode: 0,
      exitSignal: 0,
      processGroupClosed: true,
      proxyClosed: true,
      durableFloorFlushed: true,
      slotHeld: true,
    });
    const observation = Object.freeze({
      kind: "ccc-fusion.native-cli-observation",
      version: 1,
      outcome: "committed",
      evidenceDigest: "e".repeat(64),
    });
    const reconcileError = new Error("reconcile exploded");
    vi.mocked(h.binding.observer.observe).mockReturnValue(observation);
    vi.mocked(h.binding.controller.reconcile).mockRejectedValueOnce(reconcileError);
    const releaseCccNativeCli = vi.fn(async () => {
      h.sequence.push("release");
    });
    h.launchCliTaskSession.mockImplementationOnce(async () => ({
      sessionId: "cli-session-1",
      result: async () => ({
        kind: "ccc-native-held-closed" as const,
        sessionId: "cli-session-1",
        terminationReason: null,
        nativeCliHeldClosureReceipt: receipt,
      }),
      reap: async () => undefined,
      releaseCccNativeCli,
    }));

    await expect(h.run()).rejects.toThrow("reconcile exploded");
    expect(h.activeCliTaskSessions.get("REQ-9")).toBeDefined();
    expect(h.reconcile).toHaveBeenCalledOnce();
    expect(h.reconcile).toHaveBeenCalledWith({
      attemptKey: permitScope.attemptKey,
      controllerToken: permitScope.controllerToken,
      taskId: permitScope.taskId,
      outcome: observation.outcome,
      evidenceDigest: observation.evidenceDigest,
      observerId: "ccc-native-cli-observer.v1",
      terminationReason: "completed",
      cancellationState: null,
      effectiveRoute: {
        effectiveProvider: h.route.providerId,
        effectiveModel: h.route.modelId,
        usage: null,
        cost: { kind: "unknown", reason: "cli-adapter-observes-no-usage-or-identity-telemetry" },
        receiptSource: "none",
      },
    });
    expect(releaseCccNativeCli).toHaveBeenCalledTimes(0);
  });

  it("Task 4 RED: observer input must be frozen exact permit scope and held closure receipt only", async () => {
    const h = createHarness();
    const permitScope = createPermitScope(h.context, h.turnKey, h.authorityBinding);
    const receipt = Object.freeze({
      kind: "ccc-fusion.native-cli-held-closure",
      version: 1,
      sessionId: "cli-session-1",
      attemptKey: permitScope.attemptKey,
      controllerToken: permitScope.controllerToken,
      taskId: permitScope.taskId,
      authorityBindingHash: h.authorityBinding.bindingHash,
      turnKey: h.turnKey,
      dispatchKey: CCC_NATIVE_CLI_DISPATCH_KEY,
      trigger: "done",
      exitCode: 0,
      exitSignal: 0,
      processGroupClosed: true,
      proxyClosed: true,
      durableFloorFlushed: true,
      slotHeld: true,
    });
    const observation = Object.freeze({
      kind: "ccc-fusion.native-cli-observation",
      version: 1,
      outcome: "committed",
      evidenceDigest: "e".repeat(64),
    });
    vi.mocked(h.binding.observer.observe).mockImplementation((input: unknown) => {
      const observedInput = input as Record<string, unknown>;
      expect(Object.isFrozen(observedInput)).toBe(true);
      expect(Object.isFrozen(observedInput.permitScope)).toBe(true);
      expect(Object.isFrozen(observedInput.receipt)).toBe(true);
      expect(Object.keys(observedInput)).toEqual(["receipt", "permitScope"]);
      expect(observedInput).toEqual({
        receipt,
        permitScope,
      });
      return observation;
    });
    h.launchCliTaskSession.mockImplementationOnce(async () => ({
      sessionId: "cli-session-1",
      result: async () => ({
        kind: "ccc-native-held-closed" as const,
        sessionId: "cli-session-1",
        terminationReason: null,
        nativeCliHeldClosureReceipt: receipt,
      }),
      reap: async () => undefined,
      releaseCccNativeCli: async () => undefined,
    }));

    await expect(h.run()).resolves.toEqual({
      outcome: "success",
      value: "cli-agent-done",
    });
  });

  it("Task 4 RED: refuses a foreign held session before observer, reconcile, or release", async () => {
    const h = createHarness();
    const permitScope = createPermitScope(h.context, h.turnKey, h.authorityBinding);
    const receipt = createHeldClosureReceipt(permitScope, h.authorityBinding.bindingHash, "done", "foreign-session");
    const releaseCccNativeCli = vi.fn(async () => undefined);
    h.launchCliTaskSession.mockImplementationOnce(async () => ({
      sessionId: "cli-session-1",
      result: async () => ({
        kind: "ccc-native-held-closed" as const,
        sessionId: "foreign-session",
        terminationReason: null,
        nativeCliHeldClosureReceipt: receipt,
      }),
      reap: async () => undefined,
      releaseCccNativeCli,
    }));

    await expect(h.run()).rejects.toMatchObject({ code: CCC_NATIVE_CLI_BINDING_REFUSED_CODE });
    expect(h.activeCliTaskSessions.get("REQ-9")).toBeDefined();
    expect(h.binding.observer.observe).not.toHaveBeenCalled();
    expect(h.reconcile).not.toHaveBeenCalled();
    expect(releaseCccNativeCli).not.toHaveBeenCalled();
  });

  it.each([
    ["committed", "done", "completed", null, "success"],
    ["proved_failed", "done", "crashed", null, "failure"],
    ["proved_failed", "exit", "crashed", null, "failure"],
    ["proved_failed", "cancel", "killed", "CANCELLED", "failure"],
    ["proved_failed", "lifetime", "killed", "CANCELLED", "failure"],
  ] as const)("Task 4 GREEN: reconciles %s/%s held closure as %s/%s", async (outcome, trigger, terminationReason, cancellationState, resultOutcome) => {
    const h = createHarness();
    const permitScope = createPermitScope(h.context, h.turnKey, h.authorityBinding);
    const receipt = createHeldClosureReceipt(permitScope, h.authorityBinding.bindingHash, trigger);
    const observation = Object.freeze({
      kind: "ccc-fusion.native-cli-observation",
      version: 1,
      outcome,
      evidenceDigest: "e".repeat(64),
    });
    vi.mocked(h.binding.observer.observe).mockReturnValueOnce(observation);
    h.launchCliTaskSession.mockImplementationOnce(async () => ({
      sessionId: "cli-session-1",
      result: async () => ({
        kind: "ccc-native-held-closed" as const,
        sessionId: "cli-session-1",
        terminationReason: null,
        nativeCliHeldClosureReceipt: receipt,
      }),
      reap: async () => undefined,
      releaseCccNativeCli: async () => undefined,
    }));

    await expect(h.run()).resolves.toMatchObject({ outcome: resultOutcome });
    expect(h.reconcile).toHaveBeenCalledWith(expect.objectContaining({
      outcome,
      terminationReason,
      cancellationState,
      effectiveRoute: {
        effectiveProvider: h.route.providerId,
        effectiveModel: h.route.modelId,
        usage: null,
        cost: { kind: "unknown", reason: "cli-adapter-observes-no-usage-or-identity-telemetry" },
        receiptSource: "none",
      },
    }));
  });

  it.each<RefusedPermitCase>([
    {
      name: "mutable scope",
      createScope: ({ scope }) => ({
        ...scope,
      }),
    },
    {
      name: "foreign canonical authority binding",
      createScope: ({ context, scope }) => {
        const foreignBinding = Object.freeze(createCccCampaignAuthorityBinding(context, {
          actionId: "provider:direct",
          actionTarget: "REQ-10",
        }));
        return Object.freeze({
          ...scope,
          binding: foreignBinding,
        });
      },
    },
    {
      name: "semanticTaskId mismatch against sealed REQ-9",
      createScope: ({ scope }) => Object.freeze({
        ...scope,
        semanticTaskId: "REQ-10",
      }),
    },
    {
      name: "terminal committed scope",
      createScope: ({ scope }) => Object.freeze({
        ...scope,
        state: "committed",
        terminal: Object.freeze({
          kind: "reconciled",
          state: "committed",
          evidenceDigest: "e".repeat(64),
          observerId: "provider-observer-committed",
        }),
      }),
    },
    {
      /*
       * requestCount is the campaign-wide reservation counter, so a later campaign
       * task legitimately dispatches with requestCount > 1 (core mints it together
       * with attemptOrdinal). What must never dispatch is a scope whose counter and
       * ordinal disagree — that is a permit that no longer describes one request.
       */
      name: "requestCount diverging from attemptOrdinal",
      createScope: ({ scope }) => Object.freeze({
        ...scope,
        attemptOrdinal: 1,
        requestCount: 2,
      }),
    },
  ])("Task 4 RED: refuses $name permit scope before MCP or launch", async ({ createScope }) => {
    const h = createHarness((input) => Object.freeze({
      kind: "dispatch-permit",
      scope: createScope(input),
    }));

    let result: unknown;
    let rejection: unknown;
    try {
      result = await h.run();
    } catch (err) {
      rejection = err;
    } finally {
      h.resolveMcpServersSpy.mockRestore();
    }

    expect.soft(result).toBeUndefined();
    expect.soft(rejection).toMatchObject({
      code: CCC_NATIVE_CLI_BINDING_REFUSED_CODE,
    });
    expect.soft(h.sequence).toEqual([
      "pty-preflight",
      "resolver",
      "preDispatch",
    ]);
    expect.soft(h.reconcile).toHaveBeenCalledTimes(0);
    expect.soft(h.resolveMcpServers).toHaveBeenCalledTimes(0);
    expect.soft(h.killLiveTaskSessions).toHaveBeenCalledTimes(0);
    expect.soft(h.launchCliTaskSession).toHaveBeenCalledTimes(0);
    expect.soft(h.store.logEntry).not.toHaveBeenCalled();
    expect.soft(h.store.updateTask).not.toHaveBeenCalled();
  });

  it.each<{
    name: string;
    createHarness: () => CliExecutorHarness;
  }>([
    {
      name: "missing worktree",
      createHarness: () => createHarness(undefined, { omitNodeTaskWorktree: true }),
    },
    {
      name: "already aborted sealed signal",
      createHarness: () => {
        const controller = new AbortController();
        controller.abort(new Error("pre-aborted"));
        return createHarness(undefined, { sealedSignal: controller.signal });
      },
    },
    {
      name: "CLI profile not exactly ccc-fusion",
      createHarness: () => createHarness(undefined, { cliProfile: "other-profile" }),
    },
    {
      name: "legacy root-only ccc-fusion profile",
      createHarness: () => createHarness(undefined, {
        omitCliSettings: true,
        legacyRootProfile: "ccc-fusion",
      }),
    },
  ])("Task 4 RED: refuses $name before binding resolution or permit", async ({ createHarness: create }) => {
    const h = create();

    let result: unknown;
    let rejection: unknown;
    try {
      result = await h.run();
    } catch (err) {
      rejection = err;
    } finally {
      h.resolveMcpServersSpy.mockRestore();
    }

    expect.soft(result).toBeUndefined();
    expect.soft(rejection).toMatchObject({
      code: CCC_NATIVE_CLI_BINDING_REFUSED_CODE,
    });
    expect.soft(h.sequence).toEqual([]);
    expect.soft(h.reconcile).toHaveBeenCalledTimes(0);
    expect.soft(h.resolveMcpServers).toHaveBeenCalledTimes(0);
    expect.soft(h.killLiveTaskSessions).toHaveBeenCalledTimes(0);
    expect.soft(h.launchCliTaskSession).toHaveBeenCalledTimes(0);
    expect.soft(h.store.logEntry).not.toHaveBeenCalled();
    expect.soft(h.store.updateTask).not.toHaveBeenCalled();
  });
});
