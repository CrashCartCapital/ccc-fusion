import { beforeEach, describe, expect, it, vi } from "vitest";

const effects = vi.hoisted(() => ({
  git: vi.fn(),
  inspectGit: vi.fn(),
  core: vi.fn(),
  action: vi.fn(),
  authorityBinding: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({ realpath: vi.fn(async (path: string) => path) }));
vi.mock("../ccc-campaign-local-git.js", () => ({
  inspectCccCampaignLocalGit: effects.inspectGit,
  recheckCccCampaignLocalGit: effects.git,
}));
vi.mock("@fusion/core", async (importOriginal) => ({
  ...await importOriginal<typeof import("@fusion/core")>(),
  atomicReserveCccCampaignProviderDispatch: effects.core,
  createCccCampaignAuthorityBinding: effects.authorityBinding,
  selectCccCampaignDeclaredLiveExecutionAction: effects.action,
}));

import { createCccCampaignProviderAttemptBinding, preDispatchCccCampaignProviderFromEngine, type CccCampaignEngineProviderControllerInput } from "../ccc-campaign-provider-controller.js";

const snapshot = Object.freeze({ targetRoot: "/tmp/target", expectedBaseObject: "a".repeat(40), head: "a".repeat(40), gitDir: "/tmp/target/.git", gitCommonDir: "/tmp/target/.git", gitBinary: "/usr/bin/git", headDescendsFromExpectedBase: true, dirty: false, physicalIdentity: {} });
const recheckedSnapshot = Object.freeze({ ...snapshot, expectedBaseObject: "b".repeat(40), head: "c".repeat(40) });
const workItemFence = Object.freeze({ workItemId: "work-item-1", runId: "run-1", attempt: 1 });
const workItemLeaseOwner = "provider-worker-1";
const preDispatch = Object.freeze({
  layer: {},
  rootDir: "/tmp/store",
  authorityStore: {},
  originTaskId: "TASK-ORIGIN",
  taskId: "TASK-1",
  approvalRequestId: "approval-1",
  claimToken: "claim-1",
  turnKey: "turn-1",
  dispatchKey: "dispatch-1",
  providerId: "provider-1",
  modelId: "model-1",
  transport: "pi",
  workItemFence,
  workItemLeaseOwner,
}) as never;

const action = Object.freeze({ actionId: "ACTION-1", actionTarget: "target", requireProtected: true });
const authority = Object.freeze({ bindingHash: "binding-hash" });
const semanticTaskId = "TASK-1";
const nativeTaskId = "FN-1";
const originTaskId = "FN-ORIGIN";
const lease = Object.freeze({
  binding: authority,
  lease: Object.freeze({ bindingHash: authority.bindingHash, actionId: action.actionId, actionTarget: action.actionTarget, approvalRequestId: "approval-1", claimToken: "claim-1" }),
});
const contextFor = (route: Readonly<{ transport: "pi" | "workflow" | "cli"; providerId: string; modelId: string; workflowExtensionId?: string }>) => Object.freeze({
  taskId: nativeTaskId,
  semanticTaskId,
  targetRepository: Object.freeze({ path: "/tmp/target", baseCommit: "a".repeat(40) }),
  route: Object.freeze({ taskId: semanticTaskId, ...route }),
  protectedActions: [],
  protectedActionIds: [action.actionId],
});
const dispatch = Object.freeze({ turnKey: "turn-1", dispatchKey: "dispatch-1", providerId: "provider-1", modelId: "model-1", transport: "pi" as const });

function bindingInput(route: Readonly<{ transport: "pi" | "workflow" | "cli"; providerId: string; modelId: string; workflowExtensionId?: string }>, expectedRoute: Readonly<{ transport: "workflow" }> | Readonly<{ transport: "pi"; providerId: string; modelId: string }>) {
  const authorityStore = {
    getCccCampaignContextForTaskWithinTransaction: vi.fn(async () => contextFor(route)),
    inspectCccCampaignActionLease: vi.fn(async () => lease),
    settleCccProviderAttemptAndApproval: vi.fn(),
  };
  return {
    authorityStore,
    input: { layer: { transaction: async (fn: (tx: unknown) => unknown) => fn({}) }, rootDir: "/tmp/target", authorityStore, originTaskId, semanticTaskId, nativeTaskId, turnKey: "turn-1", workItemFence, workItemLeaseOwner, expectedRoute } as never,
  };
}

describe("CCC campaign provider controller", () => {
  beforeEach(() => {
    effects.git.mockReset();
    effects.inspectGit.mockReset();
    effects.core.mockReset();
    effects.action.mockReset();
    effects.authorityBinding.mockReset();
    effects.action.mockReturnValue(action);
    effects.authorityBinding.mockReturnValue(authority);
    effects.inspectGit.mockResolvedValue(snapshot);
  });

  it("rechecks the immutable Git snapshot before asking core for a permit", async () => {
    const order: string[] = [];
    effects.git.mockImplementation(async () => { order.push("git"); return recheckedSnapshot; });
    effects.core.mockImplementation(async () => { order.push("core"); return { kind: "dispatch-permit" }; });

    await expect(preDispatchCccCampaignProviderFromEngine({ initialGitSnapshot: snapshot, preDispatch }))
      .resolves.toEqual({ kind: "dispatch-permit" });
    expect(order).toEqual(["git", "core"]);
    expect(effects.git).toHaveBeenCalledWith(snapshot, undefined);
    expect(effects.core).toHaveBeenCalledWith(expect.objectContaining({
      gitObservation: {
        targetRoot: "/tmp/target",
        expectedBaseObject: "b".repeat(40),
        head: "c".repeat(40),
        headDescendsFromExpectedBase: true,
      },
      providerId: "provider-1",
      modelId: "model-1",
      transport: "pi",
      originTaskId: "TASK-ORIGIN",
    }));
    expect(snapshot).toEqual(expect.objectContaining({ head: "a".repeat(40) }));
  });

  it("does not call core when the Git recheck refuses", async () => {
    effects.git.mockRejectedValue(new Error("dirty"));
    await expect(preDispatchCccCampaignProviderFromEngine({ initialGitSnapshot: snapshot, preDispatch }))
      .rejects.toThrow("dirty");
    expect(effects.core).not.toHaveBeenCalled();
  });

  it("has no routeKind admission label on the engine pre-dispatch input", () => {
    type HasRouteKind = "routeKind" extends keyof CccCampaignEngineProviderControllerInput["preDispatch"] ? true : false;
    const hasRouteKind: HasRouteKind = false;
    expect(hasRouteKind).toBe(false);
  });

  it("refuses an abort observed after Git recheck before core reservation", async () => {
    const controller = new AbortController();
    effects.git.mockImplementation(async () => {
      controller.abort(new Error("aborted-after-git"));
      return snapshot;
    });
    effects.core.mockResolvedValue({ kind: "dispatch-permit" });
    await expect(preDispatchCccCampaignProviderFromEngine({
      initialGitSnapshot: snapshot,
      signal: controller.signal,
      preDispatch,
    })).rejects.toThrow("aborted-after-git");
    expect(effects.git).toHaveBeenCalledWith(snapshot, controller.signal);
    expect(effects.core).not.toHaveBeenCalled();
  });

  it("refuses persisted pi or cli routes for a workflow binding before lease or Git work", async () => {
    for (const persisted of [
      { transport: "pi" as const, providerId: "provider-1", modelId: "model-1" },
      { transport: "cli" as const, providerId: "provider-1", modelId: "model-1" },
    ]) {
      const { input, authorityStore } = bindingInput(persisted, { transport: "workflow" });
      await expect(createCccCampaignProviderAttemptBinding(input)).rejects.toThrow(/workflow binding route/i);
      expect(authorityStore.inspectCccCampaignActionLease).not.toHaveBeenCalled();
    }
    expect(effects.action).not.toHaveBeenCalled();
    expect(effects.inspectGit).not.toHaveBeenCalled();
    expect(effects.core).not.toHaveBeenCalled();
  });

  it("Task 6 P1 RED: refuses a persisted workflow extension mismatch before lease, Git, or provider permit work", async () => {
    const { input, authorityStore } = bindingInput(
      {
        transport: "workflow",
        providerId: "provider-1",
        modelId: "model-1",
        workflowExtensionId: "plugin:ccc-campaign:persisted-extension",
      },
      { transport: "workflow" },
    );

    await expect(createCccCampaignProviderAttemptBinding({
      ...input,
      expectedRoute: Object.freeze({
        transport: "workflow" as const,
        workflowExtensionId: "plugin:ccc-campaign:runtime-extension",
      }),
      workflowProviderBinding: true,
    })).rejects.toThrow(/workflow extension/i);

    expect(authorityStore.inspectCccCampaignActionLease).not.toHaveBeenCalled();
    expect(effects.action).not.toHaveBeenCalled();
    expect(effects.inspectGit).not.toHaveBeenCalled();
    expect(effects.core).not.toHaveBeenCalled();
  });

  it("refuses persisted Pi provider or model drift before lease or Git work", async () => {
    for (const persisted of [
      { transport: "pi" as const, providerId: "other-provider", modelId: "model-1" },
      { transport: "pi" as const, providerId: "provider-1", modelId: "other-model" },
    ]) {
      const { input, authorityStore } = bindingInput(persisted, { transport: "pi", providerId: "provider-1", modelId: "model-1" });
      await expect(createCccCampaignProviderAttemptBinding(input)).rejects.toThrow(/resolved route/i);
      expect(authorityStore.inspectCccCampaignActionLease).not.toHaveBeenCalled();
    }
    expect(effects.action).not.toHaveBeenCalled();
    expect(effects.inspectGit).not.toHaveBeenCalled();
    expect(effects.core).not.toHaveBeenCalled();
  });

  it("creates a frozen exact workflow binding and refuses a wrong dispatch turn or transport before core", async () => {
    const { input } = bindingInput({ transport: "workflow", providerId: "provider-1", modelId: "model-1" }, { transport: "workflow" });
    const binding = await createCccCampaignProviderAttemptBinding(input);
    expect(Object.isFrozen(binding)).toBe(true);
    expect(binding.turnKey).toBe("turn-1");
    expect(Object.keys(binding.controller).sort()).toEqual(["preDispatch", "reconcile"]);
    await expect(binding.controller.preDispatch({ ...dispatch, transport: "pi" })).rejects.toThrow(/turn or transport drift/i);
    await expect(binding.controller.preDispatch({ ...dispatch, transport: "workflow", turnKey: "other-turn" })).rejects.toThrow(/turn or transport drift/i);
    expect(effects.core).not.toHaveBeenCalled();
  });

  it("Task provider-fence RED: injects the sealed work-item fence after provider-controlled Pi dispatch fields", async () => {
    effects.git.mockResolvedValue(snapshot);
    effects.core.mockResolvedValue({ kind: "dispatch-permit" });
    const { input } = bindingInput({ transport: "pi", providerId: "provider-1", modelId: "model-1" }, { transport: "pi", providerId: "provider-1", modelId: "model-1" });
    const binding = await createCccCampaignProviderAttemptBinding(input);
    const providerChosenFence = Object.freeze({ workItemId: "provider-chosen", runId: "provider-run", attempt: 99 });
    await expect(binding.controller.preDispatch({
      ...dispatch,
      workItemFence: providerChosenFence,
      workItemLeaseOwner: "provider-chosen-owner",
    } as never))
      .resolves.toEqual({ kind: "dispatch-permit" });
    expect(effects.core).toHaveBeenCalledWith(expect.objectContaining({
      ...dispatch,
      originTaskId,
      taskId: nativeTaskId,
      workItemFence,
      workItemLeaseOwner,
    }));
    expect(effects.core.mock.calls[0]?.[0]?.workItemFence).toBe(workItemFence);
    expect(effects.core.mock.calls[0]?.[0]?.workItemLeaseOwner).toBe(workItemLeaseOwner);
  });

  it("Task 6 P1 RED: refuses a reconciliation whose submitted turn is not the binding's sealed turn", async () => {
    const { input, authorityStore } = bindingInput(
      { transport: "pi", providerId: "provider-1", modelId: "model-1" },
      { transport: "pi", providerId: "provider-1", modelId: "model-1" },
    );
    const binding = await createCccCampaignProviderAttemptBinding(input);
    authorityStore.settleCccProviderAttemptAndApproval.mockResolvedValue({});

    await expect(binding.controller.reconcile({
      taskId: nativeTaskId,
      attemptKey: "attempt-B",
      controllerToken: "controller-B",
      outcome: "committed",
      evidenceDigest: "e".repeat(64),
      observerId: "task6-provider-identity",
      turnKey: "turn-B",
    } as never)).rejects.toThrow(/turn drift/i);

    expect(authorityStore.settleCccProviderAttemptAndApproval).not.toHaveBeenCalled();
  });
});
