/**
 * Chained CCC campaign task worktrees (M1 multi-task execution).
 *
 * A multi-task campaign import produces one native task per semantic task,
 * linked by `dependencies` (native ids, written by the importer). M1 executes
 * that chain serially. The importer never writes `executionStartBranch`, so
 * every task worktree is created from the resolved integration branch
 * (worktree-acquisition.ts:265-270) — which means at N=2 task B's branch does
 * not contain task A's commit, and the campaign proof gate's per-task ancestry
 * loop (ccc-campaign-proof-execution.ts:317-326) refuses the whole campaign.
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
import { createMockStore, mockedExistsSync, resetExecutorMocks } from "./executor-test-helpers.js";

const IMPORT_ID = "0123456789abcdef01234567";

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

  it("leaves an entry campaign task (no predecessor) on the integration branch", async () => {
    const { store, executor, createWorktree } = makeHarness({
      "FN-1001": taskRow({
        lineageId: campaignLineage("TASK-A"),
        dependencies: [],
      }),
    }, ["main"]);

    await prepare(executor, store, codingNode("TASK-A"), "FN-1001");

    expect(capturedStartPoint(createWorktree)).not.toBe("fusion/fn-1001");
    expect(createWorktree).toHaveBeenCalledTimes(1);
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
});
