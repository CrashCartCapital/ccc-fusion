import { beforeEach, describe, expect, it, vi } from "vitest";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import { executorLog } from "../logger.js";
import type { Task } from "@fusion/core";
import { createMockStore, mockedExec, mockedExecFile, resetExecutorMocks } from "./executor-test-helpers.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-4383",
    title: "Test",
    description: "Test",
    column: "in-progress",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Task;
}

describe("captureBaseCommitSha", () => {
  beforeEach(() => {
    resetExecutorMocks();
  });

  it("captures merge-base for fresh worktree", async () => {
    mockedExec.mockImplementation(((cmd: any, _opts: any, cb: any) => {
      cb(null, cmd.includes("merge-base") ? "abc1234\n" : "");
      return {} as any;
    }) as any);
    const store = createMockStore();
    const executor = new TaskExecutor(store, "/tmp/test");
    const audit = { git: vi.fn().mockResolvedValue(undefined) };

    await (executor as any).captureBaseCommitSha(makeTask(), "/tmp/test/.worktrees/fn-4383", audit);

    expect(store.updateTask).toHaveBeenCalledWith("FN-4383", { baseCommitSha: "abc1234" });
    expect(audit.git).toHaveBeenCalledWith(expect.objectContaining({ metadata: { purpose: "base", preserved: false } }));
  });

  it("preserves existing valid baseCommitSha across resumed sessions", async () => {
    const store = createMockStore();
    const executor = new TaskExecutor(store, "/tmp/test");
    const audit = { git: vi.fn().mockResolvedValue(undefined) };

    await (executor as any).captureBaseCommitSha(
      makeTask({ baseCommitSha: "old123" }),
      "/tmp/test/.worktrees/fn-4383",
      audit,
      { isResume: true },
    );

    expect(store.updateTask).not.toHaveBeenCalled();
    expect(audit.git).toHaveBeenCalledWith(expect.objectContaining({ metadata: { purpose: "base", preserved: true } }));
  });

  it("recaptures baseCommitSha on non-resume acquisitions even when stored value is ancestor (FN-4417)", async () => {
    // FN-4417 regression: on a fresh pool acquisition the branch was just
    // force-reset to current main, so any stored baseCommitSha is stale
    // relative to the new merge-base. Preserving it would re-introduce the
    // false-positive contamination cascade.
    mockedExec.mockImplementation(((cmd: any, _opts: any, cb: any) => {
      cb(null, cmd.includes("merge-base") ? "freshmainSHA\n" : "");
      return {} as any;
    }) as any);
    const store = createMockStore();
    const executor = new TaskExecutor(store, "/tmp/test");
    const audit = { git: vi.fn().mockResolvedValue(undefined) };

    await (executor as any).captureBaseCommitSha(
      makeTask({ baseCommitSha: "stale_main_sha" }),
      "/tmp/test/.worktrees/fn-4383",
      audit,
      { isResume: false },
    );

    expect(store.updateTask).toHaveBeenCalledWith("FN-4383", { baseCommitSha: "freshmainSHA" });
    expect(audit.git).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { purpose: "base", preserved: false } }),
    );
    // Critically: is-ancestor must NOT have been the deciding factor.
    // Even if it would have passed, non-resume always recaptures.
  });

  it("preserves the sealed frozen base on a fresh imported campaign worktree", async () => {
    mockedExec.mockImplementation(((cmd: any, _opts: any, cb: any) => {
      cb(null, cmd.includes("merge-base") ? "ambient-main-base\n" : "");
      return {} as any;
    }) as any);
    const store = createMockStore();
    store.getCccCampaignContextForTask = vi.fn().mockResolvedValue({
      targetRepository: { baseCommit: "sealed-frozen-base" },
    } as any);
    const executor = new TaskExecutor(store, "/tmp/test");
    const audit = { git: vi.fn().mockResolvedValue(undefined) };

    await (executor as any).captureBaseCommitSha(
      makeTask({
        lineageId: "ccc-prd:0123456789abcdef01234567:REQ-1",
        baseCommitSha: "sealed-frozen-base",
      }),
      "/tmp/test/.worktrees/campaign",
      audit,
      { isResume: false },
    );

    expect(store.updateTask).not.toHaveBeenCalled();
    expect(audit.git).toHaveBeenCalledWith(expect.objectContaining({
      target: "sealed-frozen-base",
      metadata: {
        purpose: "base",
        preserved: true,
        custody: "campaign-frozen-base",
      },
    }));
  });

  it("recaptures when existing baseCommitSha is not ancestor", async () => {
    mockedExecFile.mockImplementation(((_file: string, _args: string[] | undefined, _opts: unknown, cb: unknown) => {
      if (typeof cb === "function") cb(new Error("not ancestor"), "", "");
    }) as typeof mockedExecFile);
    mockedExec.mockImplementation(((cmd: any, _opts: any, cb: any) => {
      cb(null, cmd.includes("merge-base") ? "new456\n" : "");
      return {} as any;
    }) as any);
    const store = createMockStore();
    const executor = new TaskExecutor(store, "/tmp/test");
    const audit = { git: vi.fn().mockResolvedValue(undefined) };

    await (executor as any).captureBaseCommitSha(makeTask({ baseCommitSha: "stale999" }), "/tmp/test/.worktrees/fn-4383", audit);

    expect(store.updateTask).toHaveBeenCalledWith("FN-4383", { baseCommitSha: "new456" });
  });

  it("preserves prior merge base on resume for FN-4309/FN-4383 multi-session regression", async () => {
    const store = createMockStore();
    const executor = new TaskExecutor(store, "/tmp/test");
    const audit = { git: vi.fn().mockResolvedValue(undefined) };

    await (executor as any).captureBaseCommitSha(
      makeTask({ baseCommitSha: "merge_base_sha" }),
      "/tmp/test/.worktrees/fn-4383",
      audit,
      { isResume: true },
    );

    expect(store.updateTask).not.toHaveBeenCalled();
    expect(audit.git).toHaveBeenCalledWith(expect.objectContaining({ metadata: { purpose: "base", preserved: true } }));
  });

  it("falls back to HEAD when merge-base fails", async () => {
    mockedExec.mockImplementation(((cmd: any, _opts: any, cb: any) => {
      if (String(cmd).includes("merge-base")) {
        cb(new Error("merge-base failed"), "", "merge-base failed");
        return {} as any;
      }
      cb(null, "head777\n", "");
      return {} as any;
    }) as any);
    const store = createMockStore();
    const executor = new TaskExecutor(store, "/tmp/test");
    const audit = { git: vi.fn().mockResolvedValue(undefined) };

    await (executor as any).captureBaseCommitSha(makeTask(), "/tmp/test/.worktrees/fn-4383", audit);

    expect(store.updateTask).toHaveBeenCalledWith("FN-4383", { baseCommitSha: "head777" });
    expect(vi.mocked(executorLog.warn)).toHaveBeenCalledWith(expect.stringContaining("falling back to HEAD"));
  });
});
