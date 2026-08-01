import {
  CCC_CAMPAIGN_CONTEXT_SCHEMA_VERSION,
  CCC_CAMPAIGN_EXECUTION_POLICY_SCHEMA_VERSION,
  CccProviderAttemptDispatchDecision,
  CccProviderAttemptScope,
  createCccCampaignAuthorityBinding,
  type CccCampaignTaskContext,
} from "@fusion/core";
import * as nativeCliBinding from "../cli-agent/ccc-native-cli-binding.js";
import {
  CCC_NATIVE_CLI_BINDING_ID,
  CCC_NATIVE_CLI_BINDING_KIND,
  CCC_NATIVE_CLI_BINDING_VERSION,
  CCC_NATIVE_CLI_DISPATCH_KEY,
  CCC_NATIVE_CLI_SESSION_POLICY_KIND,
  CCC_NATIVE_CLI_SESSION_POLICY_VERSION,
  CCC_NATIVE_CLI_BINDING_REFUSED_CODE,
  CCC_NATIVE_CLI_OBSERVER_ID,
  CCC_NATIVE_CLI_PRE_PROVIDER_OBSERVER_ID,
  CCC_NATIVE_CLI_OBSERVATION_KIND,
  CCC_NATIVE_CLI_OBSERVATION_VERSION,
  buildCccNativeCliSessionPolicy,
  validateCccNativeCliPermitScope,
  validateCccNativeCliSessionPolicy,
  validateCccNativeCliObservation,
  validateCccNativeCliBinding,
} from "../cli-agent/ccc-native-cli-binding.js";
import { describe, expect, it } from "vitest";

const validateCccNativeCliTerminalScope = nativeCliBinding["validateCccNativeCliTerminalScope"] as (
  value: unknown,
  input: { permitScope: CccProviderAttemptScope; observation: { outcome: string; evidenceDigest: string }; observerId?: string },
) => CccProviderAttemptDispatchDecision & { terminal: { kind: string; state: string; evidenceDigest: string; observerId: string } };

function createContext(): CccCampaignTaskContext {
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
    campaignStartedAt: "2026-07-25T19:00:00.000Z",
    campaignDeadlineAt: "2026-07-25T21:00:00.000Z",
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

function createPermitScope(): CccProviderAttemptScope {
  const context = createContext();
  return Object.freeze({
    attemptKey: "ccc-provider-attempt-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    controllerToken: "ccc-provider-controller-01234567-89ab-cdef-0123-456789abcdef",
    taskId: "REQ-9",
    semanticTaskId: "REQ-9",
    campaignDeadlineAt: context.campaignDeadlineAt,
    turnKey: "ccc-cli-turn-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    dispatchKey: CCC_NATIVE_CLI_DISPATCH_KEY,
    attemptOrdinal: 1,
    requestCount: 1,
    state: "dispatched_unknown",
    workItemFence: Object.freeze({
      workItemId: "work-item-native-cli-1",
      runId: "run-native-cli-1",
      attempt: 1,
    }),
    binding: Object.freeze(
      createCccCampaignAuthorityBinding(context, {
        actionId: "provider:direct",
        actionTarget: "REQ-9",
      }),
    ),
  }) satisfies CccProviderAttemptScope;
}

function permitScopeExpectation(
  scope: CccProviderAttemptScope,
  executionFence: object = scope.workItemFence as object,
) {
  return {
    dispatchRequest: Object.freeze({
      turnKey: scope.turnKey,
      dispatchKey: scope.dispatchKey,
      providerId: scope.binding.providerId,
      modelId: scope.binding.modelId,
      transport: scope.binding.transport,
    }),
    semanticTaskId: scope.semanticTaskId,
    nativeTaskId: scope.taskId,
    authorityBindingHash: scope.binding.bindingHash,
    executionFence,
  } as const;
}

function createObservation(overrides: Partial<{
  outcome: "committed" | "proved_failed";
  evidenceDigest: string;
}> = {}) {
  return Object.freeze({
    kind: CCC_NATIVE_CLI_OBSERVATION_KIND,
    version: CCC_NATIVE_CLI_OBSERVATION_VERSION,
    outcome: "committed",
    evidenceDigest: "a".repeat(64),
    ...overrides,
  });
}

function createSessionPolicy(overrides: Partial<{
  deadlineAtMs: number;
  termGraceMs: number;
  killClosureMs: number;
  lifetimeMs: number;
}> = {}) {
  return Object.freeze({
    kind: CCC_NATIVE_CLI_SESSION_POLICY_KIND,
    version: CCC_NATIVE_CLI_SESSION_POLICY_VERSION,
    attemptKey: "ccc-provider-attempt-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    controllerToken: "ccc-provider-controller-01234567-89ab-cdef-0123-456789abcdef",
    taskId: "REQ-9",
    authorityBindingHash: "a".repeat(64),
    turnKey: "ccc-cli-turn-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    dispatchKey: CCC_NATIVE_CLI_DISPATCH_KEY,
    route: Object.freeze({
      adapterId: "test-cli-adapter",
      providerId: "openai",
      modelId: "gpt-4o",
      transport: "cli",
    }),
    deadlineAtMs: 2_000,
    limits: Object.freeze({
      maxRequests: 1,
      lifetimeMs: 12_000,
      termGraceMs: 6_000,
      killClosureMs: 5_000,
    }),
    ...overrides,
  });
}

function createTerminalScope(
  permitScope: CccProviderAttemptScope,
  observation: ReturnType<typeof createObservation>,
  observerId = CCC_NATIVE_CLI_OBSERVER_ID,
): unknown {
  return Object.freeze({
    ...permitScope,
    state: observation.outcome,
    terminal: Object.freeze({
      kind: "reconciled",
      state: observation.outcome,
      evidenceDigest: observation.evidenceDigest,
      observerId,
    }),
  });
}

describe("CCC native CLI binding", () => {
  it("Task provider-fence RED: requires one frozen exact work-item fence matching sealed execution", () => {
    const scope = createPermitScope();
    const sealedExecutionFence = Object.freeze({
      ...scope.workItemFence,
      leaseOwner: "native-cli-worker",
    });
    expect(validateCccNativeCliPermitScope(scope, permitScopeExpectation(scope, sealedExecutionFence))).toBe(scope);

    for (const [label, candidate] of [
      ["missing", Object.freeze(Object.fromEntries(Object.entries(scope).filter(([key]) => key !== "workItemFence")))],
      ["mutable", Object.freeze({ ...scope, workItemFence: { ...scope.workItemFence } })],
      ["extra-key", Object.freeze({ ...scope, workItemFence: Object.freeze({ ...scope.workItemFence, extra: true }) })],
      ["mismatch", Object.freeze({ ...scope, workItemFence: Object.freeze({ ...scope.workItemFence, attempt: 2 }) })],
    ] as const) {
      expect(() => validateCccNativeCliPermitScope(candidate, permitScopeExpectation(scope, sealedExecutionFence)), label)
        .toThrow(/work-item fence|workItemFence|exact keys/i);
    }
  });

  it("Task 4 GREEN: host policy preserves the frozen route and limits and caps lifetime at observation", () => {
    const permitScope = createPermitScope();
    const route = Object.freeze({ adapterId: "test-cli-adapter", providerId: "openai", modelId: "gpt-4o", transport: "cli" as const });
    const limits = Object.freeze({ maxRequests: 1 as const, lifetimeMs: 12_000, termGraceMs: 6_000, killClosureMs: 5_000 });
    const binding = Object.freeze({
      kind: CCC_NATIVE_CLI_BINDING_KIND,
      version: CCC_NATIVE_CLI_BINDING_VERSION,
      id: CCC_NATIVE_CLI_BINDING_ID,
      turnKey: permitScope.turnKey,
      dispatchKey: CCC_NATIVE_CLI_DISPATCH_KEY,
      authorityBindingHash: (permitScope.binding as { bindingHash: string }).bindingHash,
      route,
      limits,
      followUp: false as const,
      observer: Object.freeze({ id: CCC_NATIVE_CLI_OBSERVER_ID, observe: () => undefined }),
      controller: Object.freeze({ preDispatch: async () => undefined as never, reconcile: async () => permitScope }),
    });

    const policy = buildCccNativeCliSessionPolicy(binding, permitScope, 1_000);

    expect(policy.route).toBe(route);
    expect(policy.limits).toBe(limits);
    expect(policy.deadlineAtMs).toBe(13_000);
  });

  it("Task 4 RED: refuses session policy when remaining shutdown budget is insufficient", () => {
    const policy = createSessionPolicy({
      deadlineAtMs: 9_500,
    });
    let failure: unknown;

    try {
      validateCccNativeCliSessionPolicy(policy, {
        adapterId: "test-cli-adapter",
        taskId: "REQ-9",
        nowMs: 3_000,
      });
    } catch (err) {
      failure = err;
    }

    expect(failure).toMatchObject({
      code: CCC_NATIVE_CLI_BINDING_REFUSED_CODE,
    });
  });

  it("Task 4 RED: validates exact frozen native CLI terminal scope", () => {
    const permitScope = createPermitScope();
    const observation = createObservation();
    const terminalScope = createTerminalScope(permitScope, observation);

    const validated = validateCccNativeCliTerminalScope(terminalScope, {
      permitScope,
      observation,
    });

    expect(validated).toBe(terminalScope);
  });

  it("Task 4 RED: admits the fixed pre-provider observer only when explicitly expected", () => {
    const permitScope = createPermitScope();
    const observation = createObservation({ outcome: "proved_failed" });
    const terminalScope = createTerminalScope(permitScope, observation, CCC_NATIVE_CLI_PRE_PROVIDER_OBSERVER_ID);

    const validated = validateCccNativeCliTerminalScope(terminalScope, {
      permitScope,
      observation,
      observerId: CCC_NATIVE_CLI_PRE_PROVIDER_OBSERVER_ID,
    });

    expect(validated).toBe(terminalScope);
  });

  it.each([
    "mutable terminal scope",
    "extra root key",
    "wrong attemptKey",
    "wrong controllerToken",
    "wrong taskId",
    "wrong authority binding",
    "mutable authority binding",
    "synthetic terminal sentinel state",
    "nonterminal scope state",
    "missing terminal",
    "evidence digest mismatch",
    "observer mismatch",
  ] satisfies readonly string[])("Task 4 RED: refuses %s native CLI terminal scope", (mode) => {
    const permitScope = createPermitScope();
    const observation = createObservation();

    let terminalScope: Record<string, unknown> = {
      ...(createTerminalScope(permitScope, observation) as Record<string, unknown>),
    };
    if (mode === "mutable terminal scope") {
      const terminal = terminalScope.terminal as Record<string, unknown>;
      terminalScope = {
        ...terminalScope,
        terminal: {
          kind: "reconciled",
          state: terminal.state,
          evidenceDigest: terminal.evidenceDigest,
          observerId: terminal.observerId,
        },
      };
    }
    if (mode === "mutable authority binding") {
      terminalScope = {
        ...terminalScope,
        binding: {
          ...terminalScope.binding,
        },
      };
    }
    if (mode === "extra root key") {
      terminalScope = {
        ...terminalScope,
        extra: "unexpected",
      };
    }
    if (mode === "wrong attemptKey") {
      terminalScope = {
        ...terminalScope,
        attemptKey: "ccc-provider-attempt-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      };
    }
    if (mode === "wrong controllerToken") {
      terminalScope = {
        ...terminalScope,
        controllerToken: "ccc-provider-controller-aaaaaaaa-89ab-cdef-0123-456789abcdef",
      };
    }
    if (mode === "wrong taskId") {
      terminalScope = {
        ...terminalScope,
        taskId: "REQ-10",
      };
    }
    if (mode === "wrong authority binding") {
      terminalScope = {
        ...terminalScope,
        binding: createCccCampaignAuthorityBinding(createContext(), {
          actionId: "provider:direct",
          actionTarget: "REQ-10",
        }),
      };
    }
    if (mode === "synthetic terminal sentinel state") {
      terminalScope = {
        ...terminalScope,
        state: "terminal",
      };
    }
    if (mode === "nonterminal scope state") {
      terminalScope = {
        ...terminalScope,
        state: "dispatched_unknown",
      };
    }
    if (mode === "missing terminal") {
      terminalScope = {
        ...terminalScope,
      };
      delete terminalScope.terminal;
    }
    if (mode === "evidence digest mismatch") {
      terminalScope = {
        ...terminalScope,
        terminal: Object.freeze({
          ...terminalScope.terminal,
          evidenceDigest: "b".repeat(64),
        }),
      };
    }
    if (mode === "observer mismatch") {
      terminalScope = {
        ...terminalScope,
        terminal: Object.freeze({
          ...terminalScope.terminal,
          observerId: "other-observer",
        }),
      };
    }
    let candidateScope = terminalScope;
    if (mode !== "mutable terminal scope") {
      candidateScope = Object.freeze(terminalScope);
    }

    let failure: unknown;
    try {
      validateCccNativeCliTerminalScope(candidateScope, {
        permitScope,
        observation,
      });
    } catch (err) {
      failure = err;
    }

    if (mode === "mutable terminal scope" || mode === "mutable authority binding") {
      expect(failure).toMatchObject({
        code: CCC_NATIVE_CLI_BINDING_REFUSED_CODE,
      });
      return;
    }

    expect(failure).toMatchObject({
      code: CCC_NATIVE_CLI_BINDING_REFUSED_CODE,
    });
  });

  it("Task 4 RED: validates exact frozen native CLI observation", () => {
    const observation = Object.freeze({
      kind: CCC_NATIVE_CLI_OBSERVATION_KIND,
      version: CCC_NATIVE_CLI_OBSERVATION_VERSION,
      outcome: "committed",
      evidenceDigest: "a".repeat(64),
    });

    const validated = validateCccNativeCliObservation(observation);

    expect(validated).toBe(observation);
  });

  it("Task 4 RED: admits exact host-owned authority binding hash into the native CLI binding", async () => {
    const turnKey = "ccc-cli-turn-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const route = Object.freeze({
      adapterId: "test-cli-adapter",
      providerId: "openai",
      modelId: "gpt-4o",
      transport: "cli",
    });

    const authorityBindingHash = "a".repeat(64);

    const controllerPreDispatch = () => undefined;
    const controllerReconcile = () => undefined;
    const observerObserve = () => undefined;

    const binding = Object.freeze({
      kind: CCC_NATIVE_CLI_BINDING_KIND,
      version: CCC_NATIVE_CLI_BINDING_VERSION,
      id: CCC_NATIVE_CLI_BINDING_ID,
      turnKey,
      dispatchKey: CCC_NATIVE_CLI_DISPATCH_KEY,
      route,
      limits: Object.freeze({
        maxRequests: 1,
        lifetimeMs: 60000,
        termGraceMs: 5000,
        killClosureMs: 5000,
      }),
      followUp: false,
      observer: Object.freeze({
        id: CCC_NATIVE_CLI_OBSERVER_ID,
        observe: observerObserve,
      }),
      controller: Object.freeze({
        preDispatch: controllerPreDispatch,
        reconcile: controllerReconcile,
      }),
      authorityBindingHash,
    });

    const validated = validateCccNativeCliBinding(binding, {
      turnKey,
      route,
      dispatchKey: CCC_NATIVE_CLI_DISPATCH_KEY,
    });

    expect(validated).toBe(binding);
    expect(validated.authorityBindingHash).toBe(authorityBindingHash);
  });

  it("Task 4 RED: refuses mutable native CLI observation before terminal validation", () => {
    type ObservationShape = {
      kind: string;
      version: number;
      outcome: "committed" | "proved_failed";
      evidenceDigest: string;
    };

    let failure: unknown;
    try {
      validateCccNativeCliObservation({
        kind: CCC_NATIVE_CLI_OBSERVATION_KIND,
        version: CCC_NATIVE_CLI_OBSERVATION_VERSION,
        outcome: "committed",
        evidenceDigest: "a".repeat(64),
      } as unknown as ObservationShape);
    } catch (err) {
      failure = err;
    }

    expect(failure).toMatchObject({ code: CCC_NATIVE_CLI_BINDING_REFUSED_CODE });
  });

  it("Task 4 RED: refuses extra key in native CLI observation", () => {
    const observation = {
      kind: CCC_NATIVE_CLI_OBSERVATION_KIND,
      version: CCC_NATIVE_CLI_OBSERVATION_VERSION,
      outcome: "committed" as const,
      evidenceDigest: "a".repeat(64),
      extraKey: "unexpected",
    };

    let failure: unknown;
    try {
      validateCccNativeCliObservation(observation as unknown as {
        kind: string;
        version: number;
        outcome: "committed" | "proved_failed";
        evidenceDigest: string;
      });
    } catch (err) {
      failure = err;
    }

    expect(failure).toMatchObject({
      code: CCC_NATIVE_CLI_BINDING_REFUSED_CODE,
    });
  });

  it("Task 4 RED: refuses uppercase or non-hex evidenceDigest in native CLI observation", () => {
    let failure: unknown;
    try {
      validateCccNativeCliObservation({
        kind: CCC_NATIVE_CLI_OBSERVATION_KIND,
        version: CCC_NATIVE_CLI_OBSERVATION_VERSION,
        outcome: "committed",
        evidenceDigest: "G".repeat(64),
      });
    } catch (err) {
      failure = err;
    }

    expect(failure).toMatchObject({
      code: CCC_NATIVE_CLI_BINDING_REFUSED_CODE,
    });
  });

  it("Task 4 RED: refuses nonterminal outcome in native CLI observation", () => {
    let failure: unknown;
    try {
      validateCccNativeCliObservation({
        kind: CCC_NATIVE_CLI_OBSERVATION_KIND,
        version: CCC_NATIVE_CLI_OBSERVATION_VERSION,
        outcome: "needs-attention",
        evidenceDigest: "a".repeat(64),
      });
    } catch (err) {
      failure = err;
    }

    expect(failure).toMatchObject({
      code: CCC_NATIVE_CLI_BINDING_REFUSED_CODE,
    });
  });
});
