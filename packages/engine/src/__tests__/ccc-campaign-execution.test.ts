import { describe, expect, it, vi } from "vitest";
import {
  CCC_CAMPAIGN_CONTEXT_SCHEMA_VERSION,
  CCC_CAMPAIGN_EXECUTION_POLICY_SCHEMA_VERSION,
  canonicalCccPrdJson,
  createCccCampaignAuthorityBinding,
  type CccCampaignAuthorityBinding,
  type CccCampaignTaskContext,
} from "@fusion/core";
import {
  CccCampaignAdmissionError,
  admitCccCampaignAction,
} from "../ccc-campaign-admission.js";

/**
 * This is deliberately a local structural contract: Task 4 is defining a new
 * engine boundary while the public engine types are still being written.  The
 * tests call the real admission function and use only fakes for persistence,
 * live Git observation, and later transport dispatch.
 */
type AdmissionInput = Record<string, unknown>;

const admit = admitCccCampaignAction as unknown as (
  input: AdmissionInput,
) => Promise<Record<string, unknown>>;

const BASE_OID = "0123456789abcdef0123456789abcdef01234567";

describe("CCC campaign coarse pre-provider admission", () => {
  it("refuses a task without an explicit imported-marker snapshot instead of treating absent custody as ordinary", async () => {
    const effects = effectsFor(undefined);

    await expect(admit(inputFor(effects))).rejects.toMatchObject({
      name: "CccCampaignAdmissionError",
      reason: "missing-imported-marker",
    });

    expect(effects.proof).not.toHaveBeenCalled();
    expect(effects.claim).not.toHaveBeenCalled();
    expect(effects.reserve).not.toHaveBeenCalled();
    expect(effects.provider).not.toHaveBeenCalled();
  });

  it("permits an explicitly ordinary task without proof, approval, reservation, or provider effects", async () => {
    const effects = effectsFor(null);

    await expect(admit(inputFor(effects, {
      importedMarker: { state: "ordinary" },
    }))).resolves.toEqual({ kind: "ordinary" });

    expect(effects.git).not.toHaveBeenCalled();
    expect(effects.proof).not.toHaveBeenCalled();
    expect(effects.claim).not.toHaveBeenCalled();
    expect(effects.reserve).not.toHaveBeenCalled();
    expect(effects.provider).not.toHaveBeenCalled();
  });

  it("fails closed when an imported marker has no persisted campaign custody", async () => {
    const effects = effectsFor(null);

    await expect(admit(inputFor(effects, {
      importedMarker: { state: "imported" },
    }))).rejects.toMatchObject({
      name: "CccCampaignAdmissionError",
      reason: "imported-custody-missing",
    });

    expect(effects.git).not.toHaveBeenCalled();
    expect(effects.proof).not.toHaveBeenCalled();
    expect(effects.claim).not.toHaveBeenCalled();
    expect(effects.reserve).not.toHaveBeenCalled();
    expect(effects.provider).not.toHaveBeenCalled();
  });

  it("fails closed when imported campaign custody lookup errors", async () => {
    const effects = effectsFor(new Error("database unavailable"));

    await expect(admit(inputFor(effects, {
      importedMarker: { state: "imported" },
    }))).rejects.toMatchObject({
      name: "CccCampaignAdmissionError",
      reason: "imported-custody-unavailable",
    });

    expect(effects.git).not.toHaveBeenCalled();
    expect(effects.proof).not.toHaveBeenCalled();
    expect(effects.claim).not.toHaveBeenCalled();
    expect(effects.reserve).not.toHaveBeenCalled();
    expect(effects.provider).not.toHaveBeenCalled();
  });

  it("keeps native and semantic task identities distinct and observes exact clean Git state before proof", async () => {
    const sequence: string[] = [];
    const admittedContext = context({
      protectedActions: [protectedMergeAction()],
    });
    const effects = effectsFor(admittedContext, sequence);
    const admission = await admit(inputFor(effects, {
      importedMarker: { state: "imported" },
      task: task(),
      action: { actionId: "protected:merge", actionTarget: "refs/heads/main" },
    }));

    expect(effects.git).toHaveBeenCalledWith(
      {
        targetRoot: "/tmp/ccc-target",
        expectedBaseObject: BASE_OID,
        nativeTaskId: "TASK-native-1",
        semanticTaskId: "REQ-semantic-7",
      },
      expect.any(AbortSignal),
    );
    expect(sequence).toEqual(["git", "proof", "claim"]);
    expect(admission).toMatchObject({
      kind: "campaign",
      authority: {
        context: {
          taskId: "TASK-native-1",
          semanticTaskId: "REQ-semantic-7",
        },
        binding: effects.binding,
        approval: effects.lease,
      },
    });
  });

  it.each([
    {
      name: "resolved target root mismatch",
      inspection: { targetRoot: "/tmp/foreign-target" },
      reason: "git-target-root-drift",
    },
    {
      name: "expected-base object mismatch",
      inspection: { expectedBaseObject: "foreign-base-object" },
      reason: "git-base-drift",
    },
    {
      name: "foreign HEAD outside the expected-base ancestry",
      inspection: { head: "foreign-head", headDescendsFromExpectedBase: false },
      reason: "git-foreign-head",
    },
    {
      name: "empty noncanonical HEAD despite a caller-asserted ancestry result",
      inspection: { head: "", headDescendsFromExpectedBase: true },
      reason: "git-foreign-head",
    },
    {
      name: "noncanonical HEAD despite a caller-asserted ancestry result",
      inspection: {
        head: "not-a-git-object",
        headDescendsFromExpectedBase: true,
        dirty: false,
      },
      reason: "git-foreign-head",
    },
    {
      name: "dirty target repository",
      inspection: { dirty: true },
      reason: "git-dirty",
    },
    {
      name: "missing clean-state observation",
      inspection: { dirty: undefined },
      reason: "git-dirty",
    },
  ])("fails closed after Git inspection for $name and before all later effects", async ({ inspection, reason }) => {
    const sequence: string[] = [];
    const effects = effectsFor(context(), sequence);
    effects.git.mockImplementation(async () => {
      sequence.push("git");
      return {
        targetRoot: "/tmp/ccc-target",
        expectedBaseObject: BASE_OID,
        head: BASE_OID,
        headDescendsFromExpectedBase: true,
        dirty: false,
        ...inspection,
      } as {
        targetRoot: string;
        expectedBaseObject: string;
        head: string;
        headDescendsFromExpectedBase: boolean;
        dirty: boolean;
      };
    });

    await expect(admit(inputFor(effects, {
      importedMarker: { state: "imported" },
    }))).rejects.toMatchObject({
      name: "CccCampaignAdmissionError",
      reason,
    });

    expect(effects.git).toHaveBeenCalledOnce();
    expect(sequence).toEqual(["git"]);
    expect(effects.proof).not.toHaveBeenCalled();
    expect(effects.claim).not.toHaveBeenCalled();
    expect(effects.reserve).not.toHaveBeenCalled();
    expect(effects.provider).not.toHaveBeenCalled();
  });

  it("wraps a live-Git inspection failure as an admission refusal before proof, claim, reservation, or provider dispatch", async () => {
    const sequence: string[] = [];
    const effects = effectsFor(context(), sequence);
    effects.git.mockImplementation(async () => {
      sequence.push("git");
      throw new Error("git executable unavailable");
    });

    await expect(admit(inputFor(effects, {
      importedMarker: { state: "imported" },
    }))).rejects.toMatchObject({
      name: "CccCampaignAdmissionError",
      reason: "git-inspection-failed",
    });

    expect(effects.git).toHaveBeenCalledOnce();
    expect(sequence).toEqual(["git"]);
    expect(effects.proof).not.toHaveBeenCalled();
    expect(effects.claim).not.toHaveBeenCalled();
    expect(effects.reserve).not.toHaveBeenCalled();
    expect(effects.provider).not.toHaveBeenCalled();
  });

  it("wraps a null live-Git inspection result as an admission refusal before all later effects", async () => {
    const sequence: string[] = [];
    const effects = effectsFor(context(), sequence);
    effects.git.mockImplementation(async () => {
      sequence.push("git");
      return null as never;
    });

    await expect(admit(inputFor(effects, {
      importedMarker: { state: "imported" },
    }))).rejects.toMatchObject({
      name: "CccCampaignAdmissionError",
      reason: "git-inspection-failed",
    });

    expect(effects.git).toHaveBeenCalledOnce();
    expect(sequence).toEqual(["git"]);
    expect(effects.proof).not.toHaveBeenCalled();
    expect(effects.claim).not.toHaveBeenCalled();
    expect(effects.reserve).not.toHaveBeenCalled();
    expect(effects.provider).not.toHaveBeenCalled();
  });

  it("uses context.route as the authority and refuses provider, model, or transport drift before all effects", async () => {
    const effects = effectsFor(context());

    await expect(admit(inputFor(effects, {
      importedMarker: { state: "imported" },
      route: { transport: "cli", providerId: "anthropic", modelId: "claude-opus-5" },
    }))).rejects.toMatchObject({
      name: "CccCampaignAdmissionError",
      reason: "route-drift",
    });

    expect(effects.git).not.toHaveBeenCalled();
    expect(effects.proof).not.toHaveBeenCalled();
    expect(effects.claim).not.toHaveBeenCalled();
    expect(effects.reserve).not.toHaveBeenCalled();
    expect(effects.provider).not.toHaveBeenCalled();
  });

  it("derives protectedness only from the declared action and preserves the store's exact binding and lease", async () => {
    const sequence: string[] = [];
    const effects = effectsFor(context({
      protectedActions: [protectedMergeAction()],
    }), sequence);
    const admission = await admit(inputFor(effects, {
      importedMarker: { state: "imported" },
      action: {
        actionId: "protected:merge",
        actionTarget: "refs/heads/main",
        requireProtected: false,
      },
    }));

    expect(sequence).toEqual(["git", "proof", "claim"]);
    expect(effects.claim).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "TASK-native-1" }),
      { actionId: "protected:merge", actionTarget: "refs/heads/main" },
      expect.any(AbortSignal),
    );
    expect(admission).toMatchObject({
      authority: {
        binding: effects.binding,
        approval: effects.lease,
      },
    });

    const undeclared = effectsFor(context());
    await expect(admit(inputFor(undeclared, {
      importedMarker: { state: "imported" },
      action: {
        actionId: "provider:direct",
        actionTarget: "TASK-native-1",
        requireProtected: true,
      },
    }))).resolves.toMatchObject({ kind: "campaign", authority: { approval: null } });
    expect(undeclared.claim).not.toHaveBeenCalled();
  });

  it("wraps a declared protected action target mismatch as action-drift before approval or transport effects", async () => {
    const sequence: string[] = [];
    const effects = effectsFor(context({
      protectedActions: [protectedMergeAction()],
    }), sequence);

    await expect(admit(inputFor(effects, {
      importedMarker: { state: "imported" },
      action: {
        actionId: "protected:merge",
        actionTarget: "refs/heads/foreign",
      },
    }))).rejects.toMatchObject({
      name: "CccCampaignAdmissionError",
      reason: "action-drift",
    });

    expect(sequence).toEqual(["git", "proof"]);
    expect(effects.claim).not.toHaveBeenCalled();
    expect(effects.reserve).not.toHaveBeenCalled();
    expect(effects.provider).not.toHaveBeenCalled();
  });

  it("revalidates a protected claim's returned binding provenance before transport effects", async () => {
    const sequence: string[] = [];
    const effects = effectsFor(context({
      protectedActions: [protectedMergeAction()],
    }), sequence);
    effects.claim.mockResolvedValue({
      binding: effects.binding,
      lease: {
        ...effects.lease,
        bindingHash: "f".repeat(64),
      },
    });

    await expect(admit(inputFor(effects, {
      importedMarker: { state: "imported" },
      action: { actionId: "protected:merge", actionTarget: "refs/heads/main" },
    }))).rejects.toMatchObject({
      name: "CccCampaignAdmissionError",
      reason: "approval-refused",
    });

    expect(sequence).toEqual(["git", "proof"]);
    expect(effects.claim).toHaveBeenCalledOnce();
    expect(effects.reserve).not.toHaveBeenCalled();
    expect(effects.provider).not.toHaveBeenCalled();
  });

  it("refuses a protected claim with an empty noncanonical claim token", async () => {
    const sequence: string[] = [];
    const effects = effectsFor(context({
      protectedActions: [protectedMergeAction()],
    }), sequence);
    effects.claim.mockImplementation(async () => {
      sequence.push("claim");
      return {
        binding: effects.binding,
        lease: {
          ...effects.lease,
          claimToken: "",
        },
      };
    });

    await expect(admit(inputFor(effects, {
      importedMarker: { state: "imported" },
      action: { actionId: "protected:merge", actionTarget: "refs/heads/main" },
    }))).rejects.toMatchObject({
      name: "CccCampaignAdmissionError",
      reason: "approval-refused",
    });

    expect(sequence).toEqual(["git", "proof", "claim"]);
    expect(effects.reserve).not.toHaveBeenCalled();
    expect(effects.provider).not.toHaveBeenCalled();
  });

  it("returns frozen protected authority snapshots that do not alias the claim fake's lease", async () => {
    const sequence: string[] = [];
    const effects = effectsFor(context({
      protectedActions: [protectedMergeAction()],
    }), sequence);
    const mutableLease = { ...effects.lease };
    effects.claim.mockImplementation(async () => {
      sequence.push("claim");
      return { binding: effects.binding, lease: mutableLease };
    });

    const admission = await admit(inputFor(effects, {
      importedMarker: { state: "imported" },
      action: { actionId: "protected:merge", actionTarget: "refs/heads/main" },
    }));
    const authority = admission.authority as {
      binding: Readonly<Record<string, unknown>>;
      approval: Readonly<Record<string, unknown>> | null;
    };
    const admittedApproval = authority.approval;
    expect(admittedApproval).not.toBeNull();
    if (!admittedApproval) throw new Error("expected protected admission approval");
    const approvalBeforeMutation = { ...admittedApproval };

    expect(() => {
      (mutableLease as { claimToken: string }).claimToken = "mutated-after-admission";
    }).not.toThrow();
    expect(admittedApproval).toEqual(approvalBeforeMutation);
    expect(Object.isFrozen(authority.binding)).toBe(true);
    expect(Object.isFrozen(admittedApproval)).toBe(true);
  });

  it("admits proof before a protected claim and leaves reservation and provider dispatch to the transport boundary", async () => {
    const sequence: string[] = [];
    const effects = effectsFor(context({
      protectedActions: [protectedMergeAction()],
    }), sequence);

    await expect(admit(inputFor(effects, {
      importedMarker: { state: "imported" },
      action: { actionId: "protected:merge", actionTarget: "refs/heads/main" },
    }))).resolves.toMatchObject({ kind: "campaign" });

    expect(sequence).toEqual(["git", "proof", "claim"]);
    expect(effects.reserve).not.toHaveBeenCalled();
    expect(effects.provider).not.toHaveBeenCalled();
  });

  it("returns a frozen unprotected authority binding whose canonical bytes cannot be mutated", async () => {
    const sequence: string[] = [];
    const effects = effectsFor(context(), sequence);
    const admission = await admit(inputFor(effects, {
      importedMarker: { state: "imported" },
    }));
    const authority = admission.authority as {
      binding: Readonly<CccCampaignAuthorityBinding>;
    };
    const canonicalBeforeMutation = canonicalCccPrdJson(authority.binding);

    expect.soft(Object.isFrozen(authority.binding)).toBe(true);
    try {
      (authority.binding as { actionTarget: string }).actionTarget = "mutated-after-admission";
    } catch {
      // A frozen snapshot rejects the attempted mutation in strict mode.
    }
    expect(canonicalCccPrdJson(authority.binding)).toBe(canonicalBeforeMutation);
    expect(sequence).toEqual(["git", "proof"]);
    expect(effects.claim).not.toHaveBeenCalled();
    expect(effects.reserve).not.toHaveBeenCalled();
    expect(effects.provider).not.toHaveBeenCalled();
  });

  it("returns a detached recursively frozen campaign context snapshot", async () => {
    const sequence: string[] = [];
    const sourceContext = context();
    const effects = effectsFor(sourceContext, sequence);
    const admission = await admit(inputFor(effects, {
      importedMarker: { state: "imported" },
    }));
    const authority = admission.authority as {
      context: CccCampaignTaskContext;
    };
    const admittedContext = authority.context;
    const canonicalBeforeSourceMutation = canonicalCccPrdJson(admittedContext);
    const mutableSource = sourceContext as {
      route: { modelId: string };
      targetRepository: { path: string };
      bounds: { maxRequests: number };
      proofIds: string[];
    };

    mutableSource.route.modelId = "mutated-source-model";
    mutableSource.targetRepository.path = "/tmp/mutated-source-target";
    mutableSource.bounds.maxRequests = 99;
    mutableSource.proofIds.push("PROOF-mutated-source");

    expect.soft(admittedContext).not.toBe(sourceContext);
    expect.soft(canonicalCccPrdJson(admittedContext)).toBe(canonicalBeforeSourceMutation);
    expect.soft(Object.isFrozen(admittedContext)).toBe(true);
    expect.soft(Object.isFrozen(admittedContext.route)).toBe(true);
    expect.soft(Object.isFrozen(admittedContext.targetRepository)).toBe(true);
    expect.soft(Object.isFrozen(admittedContext.bounds)).toBe(true);
    expect.soft(Object.isFrozen(admittedContext.proofIds)).toBe(true);

    const canonicalBeforeAdmittedMutation = canonicalCccPrdJson(admittedContext);
    try {
      (admittedContext.route as { modelId: string }).modelId = "mutated-admitted-model";
      (admittedContext.targetRepository as { path: string }).path = "/tmp/mutated-admitted-target";
      (admittedContext.bounds as { maxRequests: number }).maxRequests = 100;
      (admittedContext.proofIds as string[]).push("PROOF-mutated-admitted");
    } catch {
      // Recursively frozen snapshots reject nested mutation in strict mode.
    }
    expect(canonicalCccPrdJson(admittedContext)).toBe(canonicalBeforeAdmittedMutation);
    expect(sequence).toEqual(["git", "proof"]);
    expect(effects.claim).not.toHaveBeenCalled();
    expect(effects.reserve).not.toHaveBeenCalled();
    expect(effects.provider).not.toHaveBeenCalled();
  });

  it("passes a detached recursively frozen campaign context snapshot to proof callbacks", async () => {
    const sequence: string[] = [];
    const sourceContext = context();
    const canonicalBeforeAdmission = canonicalCccPrdJson(sourceContext);
    const effects = effectsFor(sourceContext, sequence);
    let proofContext: CccCampaignTaskContext | undefined;
    effects.proof.mockImplementation(async (observed) => {
      sequence.push("proof");
      proofContext = observed;
      try {
        (observed.route as { modelId: string }).modelId = "mutated-proof-model";
        (observed.targetRepository as { path: string }).path = "/tmp/mutated-proof-target";
        (observed.bounds as { maxRequests: number }).maxRequests = 77;
        (observed.proofIds as string[]).push("PROOF-mutated-proof");
      } catch {
        // Recursively frozen snapshots reject nested mutation in strict mode.
      }
    });

    const admission = await admit(inputFor(effects, {
      importedMarker: { state: "imported" },
    }));
    const authority = admission.authority as {
      context: CccCampaignTaskContext;
    };

    expect(proofContext).toBeDefined();
    expect.soft(proofContext).not.toBe(sourceContext);
    expect.soft(canonicalCccPrdJson(authority.context)).toBe(canonicalBeforeAdmission);
    expect.soft(Object.isFrozen(proofContext)).toBe(true);
    expect.soft(Object.isFrozen(proofContext?.route)).toBe(true);
    expect.soft(Object.isFrozen(proofContext?.targetRepository)).toBe(true);
    expect.soft(Object.isFrozen(proofContext?.bounds)).toBe(true);
    expect.soft(Object.isFrozen(proofContext?.proofIds)).toBe(true);
    expect(sequence).toEqual(["git", "proof"]);
    expect(effects.claim).not.toHaveBeenCalled();
    expect(effects.reserve).not.toHaveBeenCalled();
    expect(effects.provider).not.toHaveBeenCalled();
  });

  it("prevents callback-time source context mutation from changing admitted protected authority", async () => {
    const sequence: string[] = [];
    const sourceContext = context({
      protectedActions: [protectedMergeAction()],
    });
    const canonicalBeforeAdmission = canonicalCccPrdJson(sourceContext);
    const expectedBinding = createCccCampaignAuthorityBinding(sourceContext, {
      actionId: "protected:merge",
      actionTarget: "refs/heads/main",
    });
    const effects = effectsFor(sourceContext, sequence);
    const mutableSource = sourceContext as {
      route: { providerId: string; modelId: string };
      targetRepository: { path: string; baseCommit: string };
      bounds: { maxRequests: number };
      protectedActions: Array<{ target: string }>;
    };
    let claimContext: CccCampaignTaskContext | undefined;

    effects.proof.mockImplementation(async () => {
      sequence.push("proof");
      mutableSource.route.providerId = "mutated-provider";
      mutableSource.route.modelId = "mutated-model";
      mutableSource.targetRepository.path = "/tmp/mutated-target";
      mutableSource.targetRepository.baseCommit = "f".repeat(40);
      mutableSource.bounds.maxRequests = 99;
      mutableSource.protectedActions[0]!.target = "refs/heads/mutated";
    });
    effects.claim.mockImplementation(async (observed, action) => {
      sequence.push("claim");
      claimContext = observed;
      try {
        (observed.route as { modelId: string }).modelId = "mutated-claim-model";
        (observed.targetRepository as { path: string }).path = "/tmp/mutated-claim-target";
        (observed.bounds as { maxRequests: number }).maxRequests = 100;
        (observed.protectedActions as Array<{ target: string }>)[0]!.target = "refs/heads/mutated-claim";
      } catch {
        // Recursively frozen snapshots reject nested mutation in strict mode.
      }
      return {
        binding: createCccCampaignAuthorityBinding(observed, action),
        lease: {
          ...effects.lease,
          bindingHash: createCccCampaignAuthorityBinding(observed, action).bindingHash,
        },
      };
    });

    const admission = await admit(inputFor(effects, {
      importedMarker: { state: "imported" },
      action: { actionId: "protected:merge", actionTarget: "refs/heads/main" },
    }));
    const authority = admission.authority as {
      context: CccCampaignTaskContext;
      binding: CccCampaignAuthorityBinding;
    };

    expect(claimContext).toBeDefined();
    expect.soft(claimContext).not.toBe(sourceContext);
    expect.soft(canonicalCccPrdJson(authority.context)).toBe(canonicalBeforeAdmission);
    expect.soft(authority.binding.bindingHash).toBe(expectedBinding.bindingHash);
    expect.soft(authority.binding.targetRepository).toBe("/tmp/ccc-target");
    expect.soft(Object.isFrozen(claimContext)).toBe(true);
    expect.soft(Object.isFrozen(claimContext?.route)).toBe(true);
    expect.soft(Object.isFrozen(claimContext?.targetRepository)).toBe(true);
    expect.soft(Object.isFrozen(claimContext?.bounds)).toBe(true);
    expect.soft(Object.isFrozen(claimContext?.protectedActions)).toBe(true);
    expect.soft(Object.isFrozen(claimContext?.protectedActions[0])).toBe(true);
    expect(sequence).toEqual(["git", "proof", "claim"]);
    expect(effects.reserve).not.toHaveBeenCalled();
    expect(effects.provider).not.toHaveBeenCalled();
  });

  it("honors abort during asynchronous proof before claim, reservation, or provider dispatch", async () => {
    const controller = new AbortController();
    const effects = effectsFor(context());
    effects.proof.mockImplementation(async () => {
      controller.abort();
    });

    await expect(admit(inputFor(effects, {
      importedMarker: { state: "imported" },
      signal: controller.signal,
    }))).rejects.toBeInstanceOf(CccCampaignAdmissionError);

    expect(effects.claim).not.toHaveBeenCalled();
    expect(effects.reserve).not.toHaveBeenCalled();
    expect(effects.provider).not.toHaveBeenCalled();
  });
});

function task(overrides: Record<string, unknown> = {}) {
  return {
    id: "TASK-native-1",
    semanticTaskId: "REQ-semantic-7",
    targetRoot: "/tmp/ccc-target",
    baseCommitSha: BASE_OID,
    modelProvider: "openai",
    modelId: "gpt-5.6-sol",
    ...overrides,
  };
}

function inputFor(
  effects: ReturnType<typeof effectsFor>,
  overrides: Record<string, unknown> = {},
): AdmissionInput {
  return {
    store: {
      getCccCampaignContextForTask: effects.lookup,
    },
    task: task(),
    action: { actionId: "provider:direct", actionTarget: "TASK-native-1" },
    route: { transport: "pi", providerId: "openai", modelId: "gpt-5.6-sol" },
    signal: new AbortController().signal,
    // Intentionally not an authority for reservations; a provider-attempt store
    // owns database-backed request/time/concurrency accounting.
    now: new Date("2026-07-25T20:00:00.000Z"),
    admitProofs: effects.proof,
    claimProtectedAction: effects.claim,
    inspectLiveGit: effects.git,
    reserveProviderAttempt: effects.reserve,
    beforeProviderDispatch: effects.provider,
    ...overrides,
  };
}

function effectsFor(
  custody: CccCampaignTaskContext | Error | null | undefined,
  sequence: string[] = [],
) {
  const authorityContext = custody && !(custody instanceof Error)
    ? custody
    : context();
  const binding = createCccCampaignAuthorityBinding(authorityContext, {
    actionId: "protected:merge",
    actionTarget: "refs/heads/main",
  });
  const lease = {
    actionId: "protected:merge",
    actionTarget: "refs/heads/main",
    approvalRequestId: "APPROVAL-1",
    claimToken: "claim-token",
    claimedAt: "2026-07-25T20:00:00.000Z",
    expiresAt: "2026-07-25T21:00:00.000Z",
    bindingHash: binding.bindingHash,
  } as const;
  return {
    binding,
    lease,
    lookup: vi.fn(async () => {
      if (custody instanceof Error) throw custody;
      return custody ?? null;
    }),
    git: vi.fn(async () => {
      sequence.push("git");
      return {
        targetRoot: "/tmp/ccc-target",
        expectedBaseObject: BASE_OID,
        head: BASE_OID,
        headDescendsFromExpectedBase: true,
        dirty: false,
      };
    }),
    proof: vi.fn(async () => {
      sequence.push("proof");
    }),
    claim: vi.fn(async () => {
      sequence.push("claim");
      return { binding, lease };
    }),
    reserve: vi.fn(async () => {
      sequence.push("reserve");
    }),
    provider: vi.fn(() => {
      sequence.push("provider");
    }),
  };
}

function protectedMergeAction() {
  return {
    id: "protected:merge",
    kind: "approve_merge" as const,
    target: "refs/heads/main",
    operatorDecision: "not_yet_requested" as const,
    requiresOperatorDecision: true as const,
    spans: [],
  };
}

function context(overrides: Partial<CccCampaignTaskContext> = {}): CccCampaignTaskContext {
  return {
    schema: CCC_CAMPAIGN_CONTEXT_SCHEMA_VERSION,
    projectId: "project",
    importId: "import",
    idempotencyKey: "idem",
    campaignId: "campaign",
    packetHash: "1".repeat(64),
    sidecarHash: "2".repeat(64),
    bundleHash: "3".repeat(64),
    sourceVersion: "sidecar.v1",
    targetRepository: { path: "/tmp/ccc-target", baseCommit: BASE_OID },
    bounds: { maxRequests: 3, maxDurationMs: 60_000, maxConcurrency: 1 },
    campaignStartedAt: "2026-07-25T19:00:00.000Z",
    campaignDeadlineAt: "2026-07-25T21:00:00.000Z",
    admittedWriteRoots: [{ path: "/tmp/ccc-target", purpose: "test" }],
    proofs: [],
    protectedActions: [],
    executionPolicy: {
      schema: CCC_CAMPAIGN_EXECUTION_POLICY_SCHEMA_VERSION,
      routes: [{ taskId: "TASK-native-1", transport: "pi", providerId: "openai", modelId: "gpt-5.6-sol" }],
    },
    taskId: "TASK-native-1",
    route: { taskId: "TASK-native-1", transport: "pi", providerId: "openai", modelId: "gpt-5.6-sol" },
    manifestHash: "4".repeat(64),
    requestCount: 0,
    activeActionLeases: {},
    semanticTaskId: "REQ-semantic-7",
    proofIds: ["PROOF-1"],
    ...overrides,
  };
}
