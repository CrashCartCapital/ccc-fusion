import { beforeEach, describe, expect, it, vi } from "vitest";

const effects = vi.hoisted(() => ({
  git: vi.fn(),
  core: vi.fn(),
}));

vi.mock("../ccc-campaign-local-git.js", () => ({ recheckCccCampaignLocalGit: effects.git }));
vi.mock("@fusion/core", () => ({ atomicReserveCccCampaignProviderDispatch: effects.core }));

import { preDispatchCccCampaignProviderFromEngine, type CccCampaignEngineProviderControllerInput } from "../ccc-campaign-provider-controller.js";

const snapshot = Object.freeze({ targetRoot: "/tmp/target", expectedBaseObject: "a".repeat(40), head: "a".repeat(40), gitDir: "/tmp/target/.git", gitCommonDir: "/tmp/target/.git", gitBinary: "/usr/bin/git", headDescendsFromExpectedBase: true, dirty: false, physicalIdentity: {} });
const recheckedSnapshot = Object.freeze({ ...snapshot, expectedBaseObject: "b".repeat(40), head: "c".repeat(40) });
const preDispatch = Object.freeze({
  layer: {},
  rootDir: "/tmp/store",
  authorityStore: {},
  taskId: "TASK-1",
  approvalRequestId: "approval-1",
  claimToken: "claim-1",
  turnKey: "turn-1",
  dispatchKey: "dispatch-1",
}) as never;

describe("CCC campaign provider controller", () => {
  beforeEach(() => {
    effects.git.mockReset();
    effects.core.mockReset();
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
});
