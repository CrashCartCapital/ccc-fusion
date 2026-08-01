import { beforeEach, describe, expect, it, vi } from "vitest";

const effects = vi.hoisted(() => ({
  authorityBinding: vi.fn(),
  inspectGit: vi.fn(),
  preDispatch: vi.fn(),
  selectAction: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  realpath: vi.fn(async (path: string) => path),
}));
vi.mock("../ccc-campaign-local-git.js", () => ({
  inspectCccCampaignLocalGit: effects.inspectGit,
}));
vi.mock("../ccc-campaign-provider-controller.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../ccc-campaign-provider-controller.js")>(),
  preDispatchCccCampaignProviderFromEngine: effects.preDispatch,
}));
vi.mock("@fusion/core", async (importOriginal) => ({
  ...await importOriginal<typeof import("@fusion/core")>(),
  createCccCampaignAuthorityBinding: effects.authorityBinding,
  selectCccCampaignDeclaredLiveExecutionAction: effects.selectAction,
}));

import { createCccNativeCliProductionResolver } from "../cli-agent/ccc-native-cli-production-resolver.js";
import { CCC_NATIVE_CLI_DISPATCH_KEY } from "../cli-agent/ccc-native-cli-binding.js";

const executionFence = Object.freeze({
  workItemId: "work-item-native-production-1",
  runId: "run-native-production-1",
  attempt: 3,
  leaseOwner: "native-production-worker",
});
const workItemFence = Object.freeze({
  workItemId: executionFence.workItemId,
  runId: executionFence.runId,
  attempt: executionFence.attempt,
});
const action = Object.freeze({ actionId: "provider:direct", actionTarget: "REQ-9" });
const authorityBinding = Object.freeze({ bindingHash: "a".repeat(64) });
const gitSnapshot = Object.freeze({
  targetRoot: "/tmp/native-production",
  expectedBaseObject: "b".repeat(40),
  head: "b".repeat(40),
});

describe("CCC native CLI production resolver", () => {
  beforeEach(() => {
    effects.authorityBinding.mockReset().mockReturnValue(authorityBinding);
    effects.inspectGit.mockReset().mockResolvedValue(gitSnapshot);
    effects.preDispatch.mockReset().mockResolvedValue({ kind: "dispatch-permit" });
    effects.selectAction.mockReset().mockReturnValue(action);
  });

  it("Task provider-fence RED: captures the sealed execution fence and overrides provider-controlled lookalikes", async () => {
    const context = Object.freeze({
      taskId: "FN-9",
      semanticTaskId: "REQ-9",
      targetRepository: Object.freeze({
        path: "/tmp/native-production",
        baseCommit: "b".repeat(40),
      }),
      route: Object.freeze({
        taskId: "REQ-9",
        transport: "cli",
        providerId: "openai",
        modelId: "gpt-4o",
      }),
      protectedActions: Object.freeze([]),
      protectedActionIds: Object.freeze([action.actionId]),
      bounds: Object.freeze({ maxDurationMs: 60_000 }),
    });
    const lease = Object.freeze({
      binding: authorityBinding,
      lease: Object.freeze({
        bindingHash: authorityBinding.bindingHash,
        actionId: action.actionId,
        actionTarget: action.actionTarget,
        approvalRequestId: "approval-1",
        claimToken: "claim-1",
      }),
    });
    const campaignAuthorityStore = {
      getCccCampaignContextForTaskWithinTransaction: vi.fn(async () => context),
      inspectCccCampaignActionLease: vi.fn(async () => lease),
    };
    const resolver = createCccNativeCliProductionResolver({
      layer: { transaction: async (fn: (tx: unknown) => unknown) => fn({}) },
      rootDir: "/tmp/native-production",
      campaignAuthorityStore,
      cliSessionStore: { settleCccProviderAttemptAndFence: vi.fn() },
    } as never);
    const resolverInput = Object.freeze({
      nodeId: "native-node",
      originTaskId: "FN-9",
      semanticTaskId: "REQ-9",
      nativeTaskId: "FN-9",
      executionFence,
      visitIdentity: Object.freeze({ nodeId: "native-node", materializedNodeId: "native-node" }),
      turnKey: `ccc-cli-turn-${"c".repeat(64)}`,
      expectedRoute: Object.freeze({
        adapterId: "codex",
        providerId: "openai",
        modelId: "gpt-4o",
        transport: "cli",
      }),
    });
    const binding = await resolver(resolverInput) as any;
    const providerChosenFence = Object.freeze({
      workItemId: "provider-chosen",
      runId: "provider-run",
      attempt: 99,
    });

    await expect(binding.controller.preDispatch({
      turnKey: binding.turnKey,
      dispatchKey: CCC_NATIVE_CLI_DISPATCH_KEY,
      providerId: binding.route.providerId,
      modelId: binding.route.modelId,
      transport: "cli",
      workItemFence: providerChosenFence,
      workItemLeaseOwner: "provider-chosen-owner",
    })).resolves.toEqual({ kind: "dispatch-permit" });

    expect(effects.preDispatch).toHaveBeenCalledWith(expect.objectContaining({
      initialGitSnapshot: gitSnapshot,
      preDispatch: expect.objectContaining({
        originTaskId: "FN-9",
        taskId: "FN-9",
        workItemFence,
        workItemLeaseOwner: executionFence.leaseOwner,
      }),
    }));
    const forwardedFence = effects.preDispatch.mock.calls[0]?.[0]?.preDispatch.workItemFence;
    expect(forwardedFence).toEqual(workItemFence);
    expect(Object.keys(forwardedFence).sort()).toEqual(["attempt", "runId", "workItemId"]);
    expect(Object.isFrozen(forwardedFence)).toBe(true);
    expect(forwardedFence).not.toBe(executionFence);
    expect(effects.preDispatch.mock.calls[0]?.[0]?.preDispatch.workItemLeaseOwner)
      .toBe(executionFence.leaseOwner);

    for (const leaseOwner of [undefined, " bad-owner "] as const) {
      await expect(resolver(Object.freeze({
        ...resolverInput,
        executionFence: Object.freeze({
          workItemId: executionFence.workItemId,
          runId: executionFence.runId,
          attempt: executionFence.attempt,
          ...(leaseOwner === undefined ? {} : { leaseOwner }),
        }),
      }))).rejects.toThrow(/lease owner/i);
    }
  });
});
