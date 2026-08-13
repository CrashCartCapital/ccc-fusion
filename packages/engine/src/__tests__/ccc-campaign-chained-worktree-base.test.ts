/**
 * Chained CCC campaign task worktrees (M1 multi-task execution).
 *
 * A multi-task campaign import produces one native task per semantic task,
 * linked by `dependencies` (native ids, written by the importer). M1 executes
 * that chain serially. Entry tasks must start from the campaign's sealed base;
 * each successor must then start from its predecessor's exact branch so its
 * worktree contains the already-proved history without rewriting custody.
 *
 * These tests pin the worktree START POINT the executor hands to
 * `createWorktree` — the real observable, since acquisition passes
 * `freshStartPoint` straight through (worktree-acquisition.ts:827).
 *
 * HARNESS NOTE: no PostgreSQL and no real git. `createWorktree` is spied so the
 * assertion is on the start point the executor CHOSE, and
 * `resolveWorktreeStartPoint` is spied to model "this ref exists / does not
 * exist" without shelling out.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import {
  createMockStore,
  mockedExecSync,
  mockedExistsSync,
  resetExecutorMocks,
} from "./executor-test-helpers.js";

const IMPORT_ID = "0123456789abcdef01234567";
const FROZEN_BASE = "1111111111111111111111111111111111111111";
const STALE_REMOTE_BASE = "2222222222222222222222222222222222222222";

function campaignLineage(semanticTaskId: string): string {
  return `ccc-prd:${IMPORT_ID}:${semanticTaskId}`;
}

/** The imported CCC coding node shape: a semantic task id plus coding tool mode. */
function codingNode(semanticTaskId: string) {
  return {
    id: `ccc-exec-${semanticTaskId}`,
    kind: "prompt",
    column: "in-progress",
    config: {
      cccPrdTaskId: semanticTaskId,
      executor: "model",
      toolMode: "coding",
      worktreeMode: "isolated",
      commitPolicy: "required",
      prompt: "Do the campaign task.",
    },
  };
}

type Row = Record<string, unknown>;

function taskRow(overrides: Row = {}): Row {
  return {
    title: "Campaign task",
    description: "campaign work",
    column: "in-progress",
    worktree: undefined,
    branch: undefined,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Build an executor over a mock store seeded with the given rows, with the two
 * git-touching seams spied. `existingRefs` decides which refs
 * `resolveWorktreeStartPoint` can resolve.
 */
function makeHarness(rows: Record<string, Row>, existingRefs: readonly string[]) {
  const store = createMockStore();
  for (const [id, row] of Object.entries(rows)) store._setRow(id, row);
  store.getCccCampaignContextForTask = vi.fn(async (taskId: string) => {
    const row = await store.getTask(taskId);
    return typeof row.lineageId === "string" && row.lineageId.startsWith("ccc-prd:")
      && typeof row.baseCommitSha === "string"
      ? { targetRepository: { path: "/tmp/test", baseCommit: row.baseCommitSha } }
      : null;
  }) as never;
  const executor = new TaskExecutor(store as never, "/tmp/test", {
    agentStore: { getAgent: vi.fn().mockResolvedValue(null), createAgent: vi.fn() },
  } as never);

  const createWorktree = vi.fn().mockImplementation(
    async (branch: string, path: string) => ({ path, branch }),
  );
  vi.spyOn(executor as never as { createWorktree: unknown }, "createWorktree")
    .mockImplementation(createWorktree as never);
  vi.spyOn(executor as never as { captureBaseCommitSha: unknown }, "captureBaseCommitSha")
    .mockResolvedValue(undefined as never);
  const resolveWorktreeStartPoint = vi.fn(async (startPoint: string) =>
    existingRefs.includes(startPoint) ? `sha-for-${startPoint}` : null);
  vi.spyOn(executor as never as { resolveWorktreeStartPoint: unknown }, "resolveWorktreeStartPoint")
    .mockImplementation(resolveWorktreeStartPoint as never);

  return { store, executor, createWorktree, resolveWorktreeStartPoint };
}

/** The start point argument acquisition forwards to `createWorktree`. */
function capturedStartPoint(createWorktree: ReturnType<typeof vi.fn>): unknown {
  expect(createWorktree).toHaveBeenCalled();
  return createWorktree.mock.calls[0]![3];
}

async function prepare(
  executor: TaskExecutor,
  store: ReturnType<typeof createMockStore>,
  node: ReturnType<typeof codingNode>,
  taskId: string,
): Promise<void> {
  const settings = await store.getSettings();
  await (executor as never as {
    prepareGraphNodeExecution: (
      node: unknown, task: unknown, settings: unknown, requirement: unknown,
    ) => Promise<void>;
  }).prepareGraphNodeExecution(
    node,
    { id: taskId },
    settings,
    { requiresWorktree: true },
  );
}

describe("CCC campaign chained task worktree base", () => {
  beforeEach(() => {
    resetExecutorMocks();
    // No task worktree exists yet, so preparation always acquires a fresh one.
    mockedExistsSync.mockReturnValue(false);
  });

  it("creates a successor task's worktree from its dependency predecessor's working branch", async () => {
    const { store, executor, createWorktree } = makeHarness({
      "FN-1001": taskRow({
        lineageId: campaignLineage("TASK-A"),
        branch: "fusion/fn-1001",
        column: "in-review",
      }),
      "FN-1002": taskRow({
        lineageId: campaignLineage("TASK-B"),
        dependencies: ["FN-1001"],
      }),
    }, ["fusion/fn-1001", "main"]);

    await prepare(executor, store, codingNode("TASK-B"), "FN-1002");

    // Today: the integration branch, so task A's commit is not an ancestor of
    // task B's branch and the campaign proof ancestry loop refuses.
    expect(capturedStartPoint(createWorktree)).toBe("fusion/fn-1001");
  });

  it("refuses a campaign successor whose predecessor working branch is unresolvable", async () => {
    const { store, executor, createWorktree } = makeHarness({
      "FN-1001": taskRow({
        lineageId: campaignLineage("TASK-A"),
        branch: "fusion/fn-1001",
      }),
      "FN-1002": taskRow({
        lineageId: campaignLineage("TASK-B"),
        dependencies: ["FN-1001"],
      }),
    }, ["main"]); // predecessor branch is absent

    await expect(prepare(executor, store, codingNode("TASK-B"), "FN-1002"))
      .rejects.toThrow(/FN-1001/);
    // The silent integration-branch fallback must not have happened.
    expect(createWorktree).not.toHaveBeenCalled();
  });

  it("RED-R11-frozen-base starts an entry campaign task from its sealed base instead of the integration branch", async () => {
    const { store, executor, createWorktree } = makeHarness({
      "FN-1001": taskRow({
        lineageId: campaignLineage("TASK-A"),
        dependencies: [],
        baseCommitSha: FROZEN_BASE,
      }),
    }, [FROZEN_BASE, "main"]);

    await prepare(executor, store, codingNode("TASK-A"), "FN-1001");

    expect(capturedStartPoint(createWorktree)).toBe(FROZEN_BASE);
    expect(createWorktree).toHaveBeenCalledTimes(1);
  });

  it("RED-R11-frozen-base outranks a stale explicit start-branch hint for an entry campaign task", async () => {
    const { store, executor, createWorktree } = makeHarness({
      "FN-1001": taskRow({
        lineageId: campaignLineage("TASK-A"),
        dependencies: [],
        baseCommitSha: FROZEN_BASE,
        executionStartBranch: "main",
      }),
    }, [FROZEN_BASE, "main"]);

    await prepare(executor, store, codingNode("TASK-A"), "FN-1001");

    expect(capturedStartPoint(createWorktree)).toBe(FROZEN_BASE);
    expect(createWorktree).toHaveBeenCalledTimes(1);
  });

  it("RED-R11-frozen-base refuses entry worktree creation when the task row drifts from sealed custody", async () => {
    const { store, executor, createWorktree } = makeHarness({
      "FN-1001": taskRow({
        lineageId: campaignLineage("TASK-A"),
        dependencies: [],
        baseCommitSha: STALE_REMOTE_BASE,
      }),
    }, [FROZEN_BASE, STALE_REMOTE_BASE, "main"]);
    store.getCccCampaignContextForTask = vi.fn(async () => ({
      targetRepository: { path: "/tmp/test", baseCommit: FROZEN_BASE },
    })) as never;

    await expect(prepare(executor, store, codingNode("TASK-A"), "FN-1001"))
      .rejects.toMatchObject({
        code: "CCC_CAMPAIGN_FROZEN_BASE_REFUSED",
        message: expect.stringMatching(/sealed base/),
      });
    expect(createWorktree).not.toHaveBeenCalled();
  });

  it("RED-R11-frozen-base checks sealed custody before reusing a workflow-node worktree", async () => {
    mockedExistsSync.mockReturnValue(true);
    const { store, executor, createWorktree } = makeHarness({
      "FN-1001": taskRow({
        lineageId: campaignLineage("TASK-A"),
        dependencies: [],
        baseCommitSha: STALE_REMOTE_BASE,
        worktree: "/tmp/existing-campaign-worktree",
        branch: "fusion/fn-1001",
      }),
    }, [FROZEN_BASE, STALE_REMOTE_BASE, "main"]);
    store.getCccCampaignContextForTask = vi.fn(async () => ({
      targetRepository: { path: "/tmp/test", baseCommit: FROZEN_BASE },
    })) as never;

    await expect(prepare(executor, store, codingNode("TASK-A"), "FN-1001"))
      .rejects.toMatchObject({
        code: "CCC_CAMPAIGN_FROZEN_BASE_REFUSED",
        message: expect.stringMatching(/sealed base/),
      });
    expect(createWorktree).not.toHaveBeenCalled();
  });

  it("leaves a non-campaign task with a dependency unchanged", async () => {
    const { store, executor, createWorktree } = makeHarness({
      "FN-2001": taskRow({ branch: "fusion/fn-2001" }),
      "FN-2002": taskRow({ dependencies: ["FN-2001"] }),
    }, ["main"]);

    await prepare(executor, store, codingNode("TASK-B"), "FN-2002");

    expect(capturedStartPoint(createWorktree)).not.toBe("fusion/fn-2001");
    expect(createWorktree).toHaveBeenCalledTimes(1);
  });

  /*
   * Fan-in join tasks (series-parallel campaigns). A join task declares more
   * than one dependency predecessor; its worktree must start from a
   * controller-owned branch that merges EVERY predecessor's result branch
   * (deterministic order), or the campaign proof gate's per-task ancestry loop
   * refuses the whole campaign. The merge mechanics live in
   * ccc-campaign-join-base.ts (real-git tested); here the executor's CHOICE is
   * pinned: which branch it asks for, in what predecessor order, and that the
   * join base becomes the worktree start point.
   */
  function mockJoinBase(executor: TaskExecutor): ReturnType<typeof vi.fn> {
    const ensureJoinBase = vi.fn(async (task: { id: string }) =>
      `fusion/${task.id.toLowerCase()}-ccc-join-base`);
    (executor as never as { ensureCccCampaignJoinBaseBranch: unknown })
      .ensureCccCampaignJoinBaseBranch = ensureJoinBase;
    return ensureJoinBase;
  }

  it("creates a join task's worktree from the merged join base of its predecessors", async () => {
    const { store, executor, createWorktree } = makeHarness({
      "FN-1001": taskRow({
        lineageId: campaignLineage("TASK-B"),
        branch: "fusion/fn-1001",
        column: "in-review",
      }),
      "FN-1003": taskRow({
        lineageId: campaignLineage("TASK-C"),
        branch: "fusion/fn-1003",
        column: "in-review",
      }),
      "FN-1004": taskRow({
        lineageId: campaignLineage("TASK-D"),
        // Deliberately unsorted: the executor must order by task id.
        dependencies: ["FN-1003", "FN-1001"],
      }),
    }, ["fusion/fn-1001", "fusion/fn-1003", "main"]);
    const ensureJoinBase = mockJoinBase(executor);

    await prepare(executor, store, codingNode("TASK-D"), "FN-1004");

    expect(capturedStartPoint(createWorktree)).toBe("fusion/fn-1004-ccc-join-base");
    expect(ensureJoinBase).toHaveBeenCalledTimes(1);
    expect(ensureJoinBase.mock.calls[0]![1]).toEqual([
      { taskId: "FN-1001", branch: "fusion/fn-1001" },
      { taskId: "FN-1003", branch: "fusion/fn-1003" },
    ]);
  });

  it("refuses a join task when any predecessor working branch is unresolvable", async () => {
    const { store, executor, createWorktree } = makeHarness({
      "FN-1001": taskRow({
        lineageId: campaignLineage("TASK-B"),
        branch: "fusion/fn-1001",
      }),
      "FN-1003": taskRow({
        lineageId: campaignLineage("TASK-C"),
        branch: "fusion/fn-1003",
      }),
      "FN-1004": taskRow({
        lineageId: campaignLineage("TASK-D"),
        dependencies: ["FN-1001", "FN-1003"],
      }),
    }, ["fusion/fn-1001", "main"]); // FN-1003's branch is absent
    const ensureJoinBase = mockJoinBase(executor);

    await expect(prepare(executor, store, codingNode("TASK-D"), "FN-1004"))
      .rejects.toThrow(/FN-1003/);
    expect(ensureJoinBase).not.toHaveBeenCalled();
    expect(createWorktree).not.toHaveBeenCalled();
  });

  it("refuses a join task when a predecessor row cannot be loaded", async () => {
    const { store, executor, createWorktree } = makeHarness({
      "FN-1001": taskRow({
        lineageId: campaignLineage("TASK-B"),
        branch: "fusion/fn-1001",
      }),
      "FN-1004": taskRow({
        lineageId: campaignLineage("TASK-D"),
        dependencies: ["FN-1001", "FN-9999"],
      }),
    }, ["fusion/fn-1001", "main"]);
    mockJoinBase(executor);

    await expect(prepare(executor, store, codingNode("TASK-D"), "FN-1004"))
      .rejects.toThrow(/FN-9999/);
    expect(createWorktree).not.toHaveBeenCalled();
  });
});

/**
 * The squash-import rewrite inside `createWorktree` itself.
 *
 * Choosing the predecessor's branch as the start point (above) is not enough:
 * `createWorktree` hands every resolved dep start point to
 * `planSquashImportFromDep`, which — with no remote — resolves `mainBase` to the
 * target repo's HEAD, finds task A's tip is not an ancestor of it, and rewrites
 * the base to that frozen base while re-applying A's content as a NEW commit.
 * Task B then forks from the base, `merge-base --is-ancestor A B` fails, and the
 * campaign proof ancestry loop refuses the campaign.
 *
 * These tests exercise the REAL plan/decide path (`execSync` is the mocked git
 * seam) and assert on the base `tryCreateWorktree` receives.
 */
function makeSquashHarness(rows: Record<string, Row>, existingRefs: readonly string[]) {
  const store = createMockStore();
  for (const [id, row] of Object.entries(rows)) store._setRow(id, row);
  store.getCccCampaignContextForTask = vi.fn(async (taskId: string) => {
    const row = await store.getTask(taskId);
    return typeof row.lineageId === "string" && row.lineageId.startsWith("ccc-prd:")
      && typeof row.baseCommitSha === "string"
      ? { targetRepository: { path: "/tmp/test", baseCommit: row.baseCommitSha } }
      : null;
  }) as never;
  const executor = new TaskExecutor(store as never, "/tmp/test", {
    agentStore: { getAgent: vi.fn().mockResolvedValue(null), createAgent: vi.fn() },
  } as never);

  const tryCreateWorktree = vi.fn(async (branch: string, path: string) => ({ path, branch }));
  vi.spyOn(executor as never as { tryCreateWorktree: unknown }, "tryCreateWorktree")
    .mockImplementation(tryCreateWorktree as never);
  const squashImportDepIntoWorktree = vi.fn(async () => undefined);
  vi.spyOn(executor as never as { squashImportDepIntoWorktree: unknown }, "squashImportDepIntoWorktree")
    .mockImplementation(squashImportDepIntoWorktree as never);
  const rebaseNewWorktreeOntoRemote = vi.fn(async () => undefined);
  vi.spyOn(executor as never as { rebaseNewWorktreeOntoRemote: unknown }, "rebaseNewWorktreeOntoRemote")
    .mockImplementation(rebaseNewWorktreeOntoRemote as never);
  vi.spyOn(executor as never as { resolveWorktreeStartPoint: unknown }, "resolveWorktreeStartPoint")
    .mockImplementation((async (startPoint: string) =>
      existingRefs.includes(startPoint) ? `sha-for-${startPoint}` : null) as never);

  return { store, executor, tryCreateWorktree, squashImportDepIntoWorktree, rebaseNewWorktreeOntoRemote };
}

/** The base `createWorktree` actually forked the new branch from. */
function capturedCreationBase(tryCreateWorktree: ReturnType<typeof vi.fn>): unknown {
  expect(tryCreateWorktree).toHaveBeenCalled();
  return tryCreateWorktree.mock.calls[0]![3];
}

function createWorktreeFor(
  executor: TaskExecutor,
  taskId: string,
  branch: string,
  startPoint: string,
): Promise<{ path: string; branch: string }> {
  return (executor as never as {
    createWorktree: (
      branch: string, path: string, taskId: string, startPoint?: string,
    ) => Promise<{ path: string; branch: string }>;
  }).createWorktree(branch, `/tmp/worktrees/${taskId}`, taskId, startPoint);
}

describe("CCC campaign chained task worktree creation base", () => {
  beforeEach(() => {
    resetExecutorMocks();
    mockedExistsSync.mockReturnValue(false);
    /*
     * Model the campaign target repo: no remote configured, so the squash
     * planner falls back to the target's local HEAD as `mainBase`, and the
     * predecessor tip is not an ancestor of it.
     */
    mockedExecSync.mockImplementation(((command: string) => {
      const cmd = String(command).trim();
      if (cmd === "git remote") return "";
      if (cmd === "git rev-parse HEAD") return `${FROZEN_BASE}\n`;
      if (cmd.startsWith("git merge-base --is-ancestor")) {
        throw new Error("fatal: not an ancestor");
      }
      return "";
    }) as never);
  });

  it("RED-R11-frozen-base preserves an entry campaign's sealed base when the remote is stale", async () => {
    mockedExecSync.mockImplementation(((command: string) => {
      const cmd = String(command).trim();
      if (cmd === "git remote") return "origin\n";
      if (cmd === "git rev-parse --abbrev-ref origin/HEAD") return "origin/main\n";
      if (cmd === "git fetch 'origin' 'main'") return "";
      if (cmd === "git rev-parse --verify \"origin/main^{commit}\"") {
        return `${STALE_REMOTE_BASE}\n`;
      }
      if (cmd.startsWith("git merge-base --is-ancestor")) {
        throw new Error("fatal: not an ancestor");
      }
      return "";
    }) as never);
    const { executor, tryCreateWorktree, squashImportDepIntoWorktree, rebaseNewWorktreeOntoRemote } = makeSquashHarness({
      "FN-1001": taskRow({
        lineageId: campaignLineage("TASK-A"),
        dependencies: [],
        baseCommitSha: FROZEN_BASE,
      }),
    }, [FROZEN_BASE, "main"]);

    await createWorktreeFor(executor, "FN-1001", "fusion/fn-1001", FROZEN_BASE);

    expect(capturedCreationBase(tryCreateWorktree)).toBe(`sha-for-${FROZEN_BASE}`);
    expect(squashImportDepIntoWorktree).not.toHaveBeenCalled();
    expect(rebaseNewWorktreeOntoRemote).not.toHaveBeenCalled();
  });

  it("forks a chained campaign successor directly from its predecessor's tip", async () => {
    const { executor, tryCreateWorktree, squashImportDepIntoWorktree, rebaseNewWorktreeOntoRemote } = makeSquashHarness({
      "FN-1001": taskRow({
        lineageId: campaignLineage("TASK-A"),
        branch: "fusion/fn-1001",
        column: "in-review",
      }),
      "FN-1002": taskRow({
        lineageId: campaignLineage("TASK-B"),
        dependencies: ["FN-1001"],
      }),
    }, ["fusion/fn-1001", "main"]);

    await createWorktreeFor(executor, "FN-1002", "fusion/fn-1002", "fusion/fn-1001");

    // True ancestry is the campaign model: B must fork from A's actual tip, not
    // from the frozen base with A's content re-applied as a new commit.
    expect(capturedCreationBase(tryCreateWorktree)).toBe("sha-for-fusion/fn-1001");
    expect(squashImportDepIntoWorktree).not.toHaveBeenCalled();
    // A post-create rebase onto the remote default branch replays the predecessor's
    // commits under new SHAs, breaking the same ancestry the fork just preserved.
    expect(rebaseNewWorktreeOntoRemote).not.toHaveBeenCalled();
  });

  it("keeps squash-import behavior for a non-campaign dependency task", async () => {
    const { executor, tryCreateWorktree, squashImportDepIntoWorktree } = makeSquashHarness({
      "FN-2001": taskRow({ branch: "fusion/fn-2001", column: "in-review" }),
      "FN-2002": taskRow({ dependencies: ["FN-2001"] }),
    }, ["fusion/fn-2001", "main"]);

    await createWorktreeFor(executor, "FN-2002", "fusion/fn-2002", "fusion/fn-2001");

    expect(capturedCreationBase(tryCreateWorktree)).toBe(FROZEN_BASE);
    expect(squashImportDepIntoWorktree).toHaveBeenCalledTimes(1);
    expect(squashImportDepIntoWorktree.mock.calls[0]![2]).toBe("sha-for-fusion/fn-2001");
  });

  it("refuses an entry campaign task whose requested start has no sealed custody", async () => {
    const { executor, tryCreateWorktree, squashImportDepIntoWorktree } = makeSquashHarness({
      "FN-3001": taskRow({ branch: "fusion/fn-3001", column: "in-review" }),
      "FN-3002": taskRow({
        lineageId: campaignLineage("TASK-B"),
        dependencies: [],
      }),
    }, ["fusion/fn-3001", "main"]);

    await expect(createWorktreeFor(executor, "FN-3002", "fusion/fn-3002", "fusion/fn-3001"))
      .rejects.toMatchObject({
        code: "CCC_CAMPAIGN_FROZEN_BASE_REFUSED",
        message: expect.stringMatching(/no sealed base custody/),
      });

    expect(tryCreateWorktree).not.toHaveBeenCalled();
    expect(squashImportDepIntoWorktree).not.toHaveBeenCalled();
  });

  it("forks a join campaign task directly from its merged join base", async () => {
    // Same ancestry rule as the single-predecessor chain: squash-importing or
    // rebasing the merged join base replays predecessor commits under new SHAs
    // and breaks `merge-base --is-ancestor` for BOTH branches at once.
    const joinBase = "fusion/fn-4003-ccc-join-base";
    const { executor, tryCreateWorktree, squashImportDepIntoWorktree, rebaseNewWorktreeOntoRemote } = makeSquashHarness({
      "FN-4001": taskRow({
        lineageId: campaignLineage("TASK-B"),
        branch: "fusion/fn-4001",
        column: "in-review",
      }),
      "FN-4002": taskRow({
        lineageId: campaignLineage("TASK-C"),
        branch: "fusion/fn-4002",
        column: "in-review",
      }),
      "FN-4003": taskRow({
        lineageId: campaignLineage("TASK-D"),
        dependencies: ["FN-4001", "FN-4002"],
      }),
    }, ["fusion/fn-4001", "fusion/fn-4002", joinBase, "main"]);
    const ensureJoinBase = vi.fn(async () => joinBase);
    (executor as never as { ensureCccCampaignJoinBaseBranch: unknown })
      .ensureCccCampaignJoinBaseBranch = ensureJoinBase;

    await createWorktreeFor(executor, "FN-4003", "fusion/fn-4003", joinBase);

    expect(capturedCreationBase(tryCreateWorktree)).toBe(`sha-for-${joinBase}`);
    expect(squashImportDepIntoWorktree).not.toHaveBeenCalled();
    expect(rebaseNewWorktreeOntoRemote).not.toHaveBeenCalled();
  });
});
