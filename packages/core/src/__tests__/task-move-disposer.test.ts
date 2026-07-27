import { describe, expect, it, vi } from "vitest";
import {
  __setTaskMoveDisposalTimeoutForTesting,
  beginTaskMoveDisposal,
  disposeTaskBeforeMove,
  isTaskMoveDisposalActive,
  registerTaskMoveDisposer,
} from "../task-move-disposer.js";

describe("task move disposer", () => {
  it("Task 6 P1 RED: move intent is active before disposer snapshot and through explicit release", async () => {
    const store = {} as never;
    let settle!: () => void;
    registerTaskMoveDisposer(store, () => new Promise<void>((resolve) => { settle = resolve; }));
    const beginning = beginTaskMoveDisposal(store, {
      task: { id: "FN-LINEARIZE" }, from: "in-progress", to: "todo", source: "user",
    });
    await Promise.resolve();
    expect(isTaskMoveDisposalActive(store, "FN-LINEARIZE")).toBe(true);
    settle();
    const release = await beginning;
    expect(isTaskMoveDisposalActive(store, "FN-LINEARIZE")).toBe(true);
    release();
    release();
    expect(isTaskMoveDisposalActive(store, "FN-LINEARIZE")).toBe(false);
  });

  it("treats an explicit custom-column hard cancel as an active disposal intent", async () => {
    const store = {} as never;
    let settle = () => undefined;
    const disposer = vi.fn(() => new Promise<void>((resolve) => { settle = resolve; }));
    registerTaskMoveDisposer(store, disposer);
    const input = {
      task: { id: "FN-CUSTOM-LINEARIZE" } as never,
      from: "implementing",
      to: "todo",
      source: "user",
      hardCancel: true,
    } satisfies Parameters<typeof beginTaskMoveDisposal>[1];

    const beginning = beginTaskMoveDisposal(store, input);
    await Promise.resolve();
    expect(disposer).toHaveBeenCalledOnce();
    expect(isTaskMoveDisposalActive(store, "FN-CUSTOM-LINEARIZE")).toBe(true);

    settle();
    const release = await beginning;
    expect(isTaskMoveDisposalActive(store, "FN-CUSTOM-LINEARIZE")).toBe(true);
    release();
    expect(isTaskMoveDisposalActive(store, "FN-CUSTOM-LINEARIZE")).toBe(false);
  });

  it("does not let an explicit false suppress the legacy literal hard-cancel rule", async () => {
    const store = {} as never;
    const disposer = vi.fn().mockResolvedValue(undefined);
    registerTaskMoveDisposer(store, disposer);

    await disposeTaskBeforeMove(store, {
      task: { id: "FN-LEGACY-HARD-CANCEL" } as never,
      from: "in-progress",
      to: "todo",
      source: "user",
      hardCancel: false,
    });

    expect(disposer).toHaveBeenCalledOnce();
  });

  it("Task 6 P1 RED: move intent clears when disposer preparation fails", async () => {
    const store = {} as never;
    registerTaskMoveDisposer(store, async () => { throw new Error("stop failed"); });
    await expect(beginTaskMoveDisposal(store, {
      task: { id: "FN-LINEARIZE-ERROR" }, from: "in-progress", to: "todo", source: "user",
    })).rejects.toThrow("stop failed");
    expect(isTaskMoveDisposalActive(store, "FN-LINEARIZE-ERROR")).toBe(false);
  });

  it("does not complete a user in-progress to todo move until cancellation settles", async () => {
    const store = {} as never;
    let resolveCancellation: (() => void) | undefined;
    const cancellation = new Promise<void>((resolve) => {
      resolveCancellation = resolve;
    });
    const disposer = vi.fn(() => cancellation);
    registerTaskMoveDisposer(store, disposer);

    let moveReady = false;
    const preparation = disposeTaskBeforeMove(store, {
      task: { id: "FN-CANCEL" } as never,
      from: "in-progress",
      to: "todo",
      source: "user",
    }).then(() => {
      moveReady = true;
    });

    await Promise.resolve();
    expect(disposer).toHaveBeenCalledOnce();
    expect(moveReady).toBe(false);

    resolveCancellation?.();
    await preparation;
    expect(moveReady).toBe(true);
  });

  it("awaits every executor registered to the same store", async () => {
    const store = {} as never;
    const first = vi.fn().mockResolvedValue(undefined);
    const second = vi.fn().mockResolvedValue(undefined);
    const unregisterFirst = registerTaskMoveDisposer(store, first);
    registerTaskMoveDisposer(store, second);

    await disposeTaskBeforeMove(store, {
      task: { id: "FN-MULTI-OWNER" } as never,
      from: "in-progress",
      to: "todo",
      source: "user",
    });

    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();

    unregisterFirst();
    await disposeTaskBeforeMove(store, {
      task: { id: "FN-ONE-OWNER" } as never,
      from: "in-progress",
      to: "todo",
      source: "user",
    });
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledTimes(2);
  });

  it("fails closed and releases the move when cancellation does not settle", async () => {
    __setTaskMoveDisposalTimeoutForTesting(1);
    try {
      const store = {} as never;
      registerTaskMoveDisposer(store, () => new Promise<void>(() => {}));

      const preparation = disposeTaskBeforeMove(store, {
        task: { id: "FN-WEDGED" } as never,
        from: "in-progress",
        to: "todo",
        source: "user",
      });
      await expect(preparation).rejects.toThrow(
        "Timed out stopping active work for FN-WEDGED before moving to Todo",
      );
    } finally {
      __setTaskMoveDisposalTimeoutForTesting();
    }
  });

  it.each([
    { from: "in-progress", to: "todo", source: "engine" },
    { from: "todo", to: "in-progress", source: "user" },
    { from: "in-progress", to: "in-review", source: "user" },
  ] as const)("does not cancel for $source $from to $to moves", async (move) => {
    const store = {} as never;
    const disposer = vi.fn();
    registerTaskMoveDisposer(store, disposer);

    await disposeTaskBeforeMove(store, {
      task: { id: "FN-UNCHANGED" } as never,
      ...move,
    });

    expect(disposer).not.toHaveBeenCalled();
  });
});
