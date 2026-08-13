// @ts-nocheck
/*
FNXC:WorkflowCancellation 2026-07-15-10:42:
Regression cover for the graph-cancellation invariant: a cancelled graph walk must collapse an in-flight merge IMMEDIATELY, never sit inside the merge node until its own 30-minute timeout fires.

Original symptom: a hard-cancel aborted the graph controller while the `merge` node was in flight. The merge primitive raced the merge only against `GRAPH_MERGE_TIMEOUT_MS` (30 min) using a controller it owned, so it never observed the cancel. Thirty minutes later the timeout fired, aborted the still-running AI merge ("Manual-merge failed: Request was aborted"), and the walk finally discovered it had been cancelled half an hour earlier — reported as `value=merge-timeout`. An abort landing between merger-ai's `worktree: null` write and `mergeConfirmed` then stranded the card as `no-worktree-no-merge-confirmed`.

Surface enumeration (engine-only; no UI, so desktop/mobile breakpoints are N/A):
- Both merge surfaces: the `requestMerge` runtime primitive AND the legacy merge seam (`createAuthoritativeWorkflowSeams().merge`), which had the identical unguarded 30-minute race.
- Both cancel timings: signal already aborted at entry (pre-flight) and aborted mid-flight.
- Data states: signal present vs absent (absent must preserve pre-fix behavior).
- The plumbing that feeds both: `primitiveNodeContext` / the node-handler context builder / the merge runner — an unthreaded signal silently reintroduces the stall with no type error.
- The classification boundary: `merge-cancelled` must not be read as a retryable merge failure.
*/
import { describe, it, expect, vi, beforeEach } from "vitest";

const { issuePersistedCccCampaignApprovalMock } = vi.hoisted(() => ({
  issuePersistedCccCampaignApprovalMock: vi.fn(),
}));

vi.mock("@fusion/core", async (importOriginal) => ({
  ...await importOriginal<typeof import("@fusion/core")>(),
  issueCccCampaignApproval: issuePersistedCccCampaignApprovalMock,
}));

import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import { primitiveNodeContext } from "../runtime-primitives.js";
import { classifyMergePrimitiveResult } from "../workflow-merge-nodes.js";
import { createMergeAttemptHandler } from "../workflow-node-runners/merge-runner.js";
import { createCccCampaignMergeControl, matchesCccCampaignMergeControl } from "../ccc-campaign-merge-control.js";
import { CCC_CAMPAIGN_MERGE_APPROVAL_REQUIRED_CODE } from "../ccc-campaign-product-control.js";
import { executorLog } from "../logger.js";
import { createMockStore, mockedExistsSync, resetExecutorMocks } from "./executor-test-helpers.js";

const now = "2026-07-15T00:00:00.000Z";

/** A task shaped to clear the merge boundary's implementation-proof gates, so the
 *  cancellation race — not a pre-flight rejection — is what the assertion observes. */
function mergeReadyTask(overrides = {}) {
  return {
    id: "FN-CANCEL",
    title: "Cancellable merge task",
    description: "exercise graph cancellation at the merge node",
    column: "in-progress",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    noCommitsExpected: true,
    branch: null,
    worktree: null,
    enabledWorkflowSteps: [],
    prompt: "# Task\n\n## Steps\n\n### Step 1: Decide\n- [ ] Record no-code decision",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function executorFor(liveTask) {
  const store = createMockStore();
  store.getTask.mockResolvedValue(liveTask);
  store.moveTask.mockResolvedValue({ ...liveTask, column: "in-review" });
  const executor = new TaskExecutor(store, "/tmp/test");
  return { store, executor };
}

function mergeCtx(signal) {
  return primitiveNodeContext(
    { runId: "FN-CANCEL:run", taskId: "FN-CANCEL", workflowId: "builtin:coding" },
    { id: "merge", kind: "prompt" },
    {},
    signal,
  );
}

/** A merge requester that never settles — it stands in for an AI merge still in
 *  flight. If cancellation is not observed, awaiting the primitive hangs and the
 *  test times out, which is exactly the production stall. */
function pendingMergeRequester() {
  const calls = [];
  const requester = vi.fn((taskId, options) => {
    calls.push({ taskId, signal: options?.signal });
    return new Promise(() => {});
  });
  return { requester, calls };
}

describe("workflow merge cancellation", () => {
  beforeEach(() => {
    resetExecutorMocks();
    mockedExistsSync.mockReturnValue(true);
  });

  it("rejects campaign merge authority objects carrying hidden extra keys", () => {
    const context = {
      taskId: "FN-CAMPAIGN-AUTHORITY",
      projectId: "project-1",
      importId: "import-1",
      campaignId: "campaign-1",
      bundleHash: "bundle-1",
      manifestHash: "manifest-1",
      targetRepository: { path: "/tmp/campaign-repo", baseCommit: "base-1" },
    };
    const authority = {
      ...createCccCampaignMergeControl(context as any),
      [Symbol("caller-authority")]: true,
    };

    expect(matchesCccCampaignMergeControl(authority, context as any)).toBe(false);
  });

  describe("requestMerge primitive", () => {
    it("parks persisted campaign custody at human approval without a workflow boundary or merge dispatch", async () => {
      const liveTask = mergeReadyTask({
        id: "FN-CAMPAIGN",
        lineageId: "ccc-prd:0123456789abcdef01234567:merge",
      });
      const { store, executor } = executorFor(liveTask);
      const semanticTaskId = "TASK-CAMPAIGN";
      const mergeAction = {
        id: "ACTION-CAMPAIGN-MERGE",
        kind: "merge",
        target: "refs/heads/main",
        requiresOperatorDecision: true,
        operatorDecision: "approve_merge",
        spans: [],
      };
      const context = {
        taskId: liveTask.id,
        semanticTaskId,
        projectId: "project-1",
        importId: "import-1",
        campaignId: "campaign-1",
        bundleHash: "bundle-1",
        manifestHash: "manifest-1",
        packetHash: "packet-1",
        sidecarHash: "sidecar-1",
        idempotencyKey: "campaign-merge",
        targetRepository: { path: "/tmp/test", baseCommit: "base-1" },
        route: {
          taskId: semanticTaskId,
          kind: "local",
          providerId: "native",
          modelId: "native-git",
          transport: "native",
        },
        executionPolicy: { schema: "ccc-campaign.execution-policy.v2" },
        // This cancellation regression exercises the persisted legacy proof
        // lane. Keep the semantic-proof contract explicit so the production
        // merge gate does not mistake an incomplete mock for semantic v2.
        proofs: [],
        protectedActionIds: [mergeAction.id],
        protectedActions: [mergeAction],
        activeActionLeases: {},
        campaignStartedAt: "2026-07-15T00:00:00.000Z",
        campaignDeadlineAt: "2026-07-16T00:00:00.000Z",
      };
      store.getCccCampaignContextForTask = vi.fn(async () => context);
      const layer = { projectId: "project-1" };
      store.getAsyncLayer = vi.fn(() => layer);
      issuePersistedCccCampaignApprovalMock.mockResolvedValueOnce({
        id: "ccc-approval-campaign-merge",
        status: "issued",
        taskId: liveTask.id,
        runId: "FN-CANCEL:run",
        campaign: {
          binding: {
            projectId: context.projectId,
            importId: context.importId,
            campaignId: context.campaignId,
            taskId: liveTask.id,
            actionId: mergeAction.id,
            actionTarget: mergeAction.target,
          },
          notBeforeAt: context.campaignStartedAt,
          expiresAt: context.campaignDeadlineAt,
        },
      });
      const requester = vi.fn();
      executor.setMergeRequester(requester);

      await expect(executor
        .createAuthoritativeWorkflowPrimitives({ autoMerge: true })
        .requestMerge(mergeCtx(undefined), liveTask)).rejects.toMatchObject({
          code: CCC_CAMPAIGN_MERGE_APPROVAL_REQUIRED_CODE,
        });

      expect(issuePersistedCccCampaignApprovalMock).toHaveBeenCalledWith(
        layer,
        expect.objectContaining({
          authorityStore: store,
          rootDir: "/tmp/test",
          taskId: liveTask.id,
          action: expect.objectContaining({
            actionId: mergeAction.id,
            actionTarget: mergeAction.target,
          }),
          runId: "FN-CANCEL:run",
        }),
      );
      expect(requester).not.toHaveBeenCalled();
      expect(store.moveTask).not.toHaveBeenCalled();
    });

    it("collapses immediately when the graph aborts mid-merge instead of waiting for the 30-minute timeout", async () => {
      const liveTask = mergeReadyTask();
      const { executor } = executorFor(liveTask);
      const { requester, calls } = pendingMergeRequester();
      executor.setMergeRequester(requester);
      const controller = new AbortController();

      const pending = executor
        .createAuthoritativeWorkflowPrimitives({ autoMerge: true })
        .requestMerge(mergeCtx(controller.signal), liveTask);

      // Let the primitive reach the merge requester before cancelling.
      await vi.waitFor(() => expect(requester).toHaveBeenCalled());
      controller.abort();

      // No timer advance: the walk must return on the abort itself.
      await expect(pending).resolves.toMatchObject({ outcome: "failure", value: "merge-cancelled" });
      // The in-flight merge is told to stop rather than being left running.
      expect(calls[0].signal.aborted).toBe(true);
    });

    it("fails fast with no side effects when the graph is already aborted at entry", async () => {
      const liveTask = mergeReadyTask();
      const { store, executor } = executorFor(liveTask);
      const { requester } = pendingMergeRequester();
      executor.setMergeRequester(requester);
      const controller = new AbortController();
      controller.abort();

      const result = await executor
        .createAuthoritativeWorkflowPrimitives({ autoMerge: true })
        .requestMerge(mergeCtx(controller.signal), liveTask);

      expect(result).toMatchObject({ outcome: "failure", value: "merge-cancelled" });
      // An abandoned walk must not enqueue a merge or mutate the boundary row.
      expect(requester).not.toHaveBeenCalled();
      expect(store.moveTask).not.toHaveBeenCalled();
    });

    it("still passes a live signal to the merger when the graph provides none", async () => {
      const liveTask = mergeReadyTask();
      const { executor } = executorFor(liveTask);
      const inReview = { ...liveTask, column: "in-review" };
      const requester = vi.fn(async () => ({ task: inReview, merged: true, noOp: true, mergeConfirmed: true }));
      executor.setMergeRequester(requester);

      const result = await executor
        .createAuthoritativeWorkflowPrimitives({ autoMerge: true })
        .requestMerge(mergeCtx(undefined), liveTask);

      expect(result).toMatchObject({ outcome: "success" });
      // The timeout controller's signal survives the AbortSignal.any linking.
      expect(requester).toHaveBeenCalledWith("FN-CANCEL", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    });
  });

  describe("legacy merge seam", () => {
    it("refuses persisted campaign custody before boundary mutation or requester dispatch", async () => {
      const liveTask = mergeReadyTask({
        id: "FN-CAMPAIGN-LEGACY",
        lineageId: "ccc-prd:0123456789abcdef01234567:legacy",
      });
      const { store, executor } = executorFor(liveTask);
      store.getCccCampaignContextForTask = vi.fn(async () => ({
        taskId: liveTask.id,
        projectId: "project-1",
        importId: "import-1",
        campaignId: "campaign-1",
        bundleHash: "bundle-1",
        manifestHash: "manifest-1",
        targetRepository: { path: "/tmp/campaign-repo", baseCommit: "base-1" },
      }));
      const requester = vi.fn();
      executor.setMergeRequester(requester);

      const result = await executor
        .createAuthoritativeWorkflowSeams({ autoMerge: true })
        .merge(liveTask, {}, undefined);

      expect(result).toEqual({
        outcome: "failure",
        value: "ccc-campaign-authoritative-merge-required",
      });
      expect(requester).not.toHaveBeenCalled();
      expect(store.moveTask).not.toHaveBeenCalled();
      expect(store.logEntry).not.toHaveBeenCalled();
    });

    it("collapses immediately when the graph aborts mid-merge", async () => {
      const liveTask = mergeReadyTask();
      const { executor } = executorFor(liveTask);
      const { requester, calls } = pendingMergeRequester();
      executor.setMergeRequester(requester);
      const controller = new AbortController();

      const pending = executor
        .createAuthoritativeWorkflowSeams({ autoMerge: true })
        .merge(liveTask, {}, controller.signal);

      await vi.waitFor(() => expect(requester).toHaveBeenCalled());
      controller.abort();

      await expect(pending).resolves.toMatchObject({ outcome: "failure", value: "merge-cancelled" });
      expect(calls[0].signal.aborted).toBe(true);
    });

    it("fails fast with no side effects when already aborted at entry", async () => {
      const liveTask = mergeReadyTask();
      const { store, executor } = executorFor(liveTask);
      const { requester } = pendingMergeRequester();
      executor.setMergeRequester(requester);
      const controller = new AbortController();
      controller.abort();

      const result = await executor
        .createAuthoritativeWorkflowSeams({ autoMerge: true })
        .merge(liveTask, {}, controller.signal);

      expect(result).toMatchObject({ outcome: "failure", value: "merge-cancelled" });
      expect(requester).not.toHaveBeenCalled();
      expect(store.moveTask).not.toHaveBeenCalled();
    });
  });

  describe("graph merge retry custody", () => {
    it("classifies custody before logs, boundary mutation, or requester dispatch", async () => {
      const liveTask = mergeReadyTask({ id: "FN-CUSTODY-LOOKUP-ERROR" });
      const { store, executor } = executorFor(liveTask);
      store.getCccCampaignContextForTask = vi.fn(async () => {
        throw new Error("custody store unavailable");
      });
      const requester = vi.fn();
      executor.setMergeRequester(requester);
      const warnSpy = vi.spyOn(executorLog, "warn").mockImplementation(() => undefined);

      const routed = await executor.routeGraphMergeFailureToRetry(
        liveTask,
        {
          disposition: "failed",
          outcome: "failure",
          visitedNodeIds: ["requestMerge"],
          context: {},
        },
        "merge-seam",
      );

      expect(routed).toBe(false);
      expect(warnSpy).not.toHaveBeenCalled();
      expect(store.logEntry).not.toHaveBeenCalled();
      expect(store.moveTask).not.toHaveBeenCalled();
      expect(requester).not.toHaveBeenCalled();
    });

    it("Task 5 RED: campaign graph retry refuses requester failure or missing exact custody authority", async () => {
      const cases = [
        {
          name: "requester failure",
          requester: vi.fn(async () => {
            throw new Error("campaign requester rejected retry");
          }),
          error: "campaign requester rejected retry",
        },
        {
          name: "missing exact custody authority",
          requester: vi.fn(async () => ({})),
          error: "CCC campaign retry merge result is missing an exact persisted custody authority",
        },
      ];

      for (const testCase of cases) {
        const liveTask = mergeReadyTask({
          id: `FN-CAMPAIGN-RETRY-${testCase.name}`,
          lineageId: "ccc-prd:0123456789abcdef01234567:retry",
        });
        const { store, executor } = executorFor(liveTask);
        store.getCccCampaignContextForTask = vi.fn(async () => ({
          taskId: liveTask.id,
          projectId: "project-1",
          importId: "import-1",
          campaignId: "campaign-1",
          bundleHash: "bundle-1",
          manifestHash: "manifest-1",
          targetRepository: { path: "/tmp/campaign-repo", baseCommit: "base-1" },
        }));
        const warnSpy = vi.spyOn(executorLog, "warn").mockImplementation(() => undefined);
        const persistSpy = vi.spyOn(executor as unknown as { persistTokenUsage(taskId: string): Promise<void> }, "persistTokenUsage").mockImplementation(async () => undefined);
        executor.setMergeRequester(testCase.requester);

        await expect(executor.routeGraphMergeFailureToRetry(
          liveTask,
          { disposition: "failed", outcome: "failure", visitedNodeIds: ["requestMerge"], context: {} },
          "merge-seam",
        )).rejects.toThrow(testCase.error);

        expect(testCase.requester).toHaveBeenCalledTimes(1);
        expect(testCase.requester).toHaveBeenCalledWith(liveTask.id);
        expect(warnSpy).not.toHaveBeenCalled();
        expect(store.logEntry).not.toHaveBeenCalled();
        expect(store.moveTask).not.toHaveBeenCalled();
        expect(persistSpy).not.toHaveBeenCalled();
        warnSpy.mockRestore();
      }
    });

    it("dispatches campaign retry with exact custody before mutable bookkeeping", async () => {
      const liveTask = mergeReadyTask({
        id: "FN-CAMPAIGN-RETRY",
        lineageId: "ccc-prd:0123456789abcdef01234567:retry",
      });
      const { store, executor } = executorFor(liveTask);
      const context = {
        taskId: liveTask.id,
        projectId: "project-1",
        importId: "import-1",
        campaignId: "campaign-1",
        bundleHash: "bundle-1",
        manifestHash: "manifest-1",
        targetRepository: { path: "/tmp/campaign-repo", baseCommit: "base-1" },
      };
      const events: string[] = [];
      store.getCccCampaignContextForTask = vi.fn(async () => context);
      store.logEntry.mockImplementation(async () => {
        events.push("log");
      });
      store.moveTask.mockImplementation(async () => {
        events.push("boundary");
        return liveTask;
      });
      const warnSpy = vi.spyOn(executorLog, "warn").mockImplementation(() => {
        events.push("warn");
      });
      const persistSpy = vi.spyOn(executor as any, "persistTokenUsage").mockImplementation(async () => {
        events.push("persist");
      });
      const requester = vi.fn(async (taskId: string) => {
        expect(taskId).toBe(liveTask.id);
        expect(events).toEqual([]);
        return { campaignControlled: createCccCampaignMergeControl(context as any) };
      });
      executor.setMergeRequester(requester);

      const routed = await executor.routeGraphMergeFailureToRetry(
        liveTask,
        {
          disposition: "failed",
          outcome: "failure",
          visitedNodeIds: ["requestMerge"],
          context: {},
        },
        "merge-seam",
      );

      expect(routed).toBe(true);
      expect(requester).toHaveBeenCalledTimes(1);
      expect(requester).toHaveBeenCalledWith(liveTask.id);
      expect(warnSpy).not.toHaveBeenCalled();
      expect(store.logEntry).not.toHaveBeenCalled();
      expect(store.moveTask).not.toHaveBeenCalled();
      expect(persistSpy).toHaveBeenCalledWith(liveTask.id);
      expect(events).toEqual(["persist"]);
    });
  });

  describe("signal plumbing", () => {
    it("carries the graph signal onto the primitive context", () => {
      const controller = new AbortController();
      const ctx = primitiveNodeContext(
        { runId: "run-1", taskId: "FN-1", workflowId: "coding" },
        { id: "merge", kind: "prompt" },
        {},
        controller.signal,
      );

      expect(ctx.signal).toBe(controller.signal);
    });

    it("forwards the node execution signal through the merge runner to the primitive", async () => {
      const controller = new AbortController();
      const requestMerge = vi.fn(async () => ({ outcome: "success", data: { status: "merged" } }));
      const handler = createMergeAttemptHandler({
        primitives: { requestMerge, audit: vi.fn() },
        seams: { merge: vi.fn() },
        buildPrimitiveContext: (node, ctx, attempt) =>
          primitiveNodeContext({ runId: "r", taskId: "FN-1", workflowId: "w" }, node, { attempt }, ctx.signal),
      });

      await handler({ id: "merge", kind: "prompt" }, {
        task: { id: "FN-1" },
        settings: undefined,
        context: {},
        signal: controller.signal,
      });

      expect(requestMerge).toHaveBeenCalledWith(
        expect.objectContaining({ signal: controller.signal }),
        expect.anything(),
      );
    });

    it("forwards the node execution signal to the legacy seam when no primitives are wired", async () => {
      const controller = new AbortController();
      const merge = vi.fn(async () => ({ outcome: "success" }));
      const handler = createMergeAttemptHandler({
        primitives: undefined,
        seams: { merge },
        buildPrimitiveContext: () => ({ run: {}, node: {} }),
      });

      await handler({ id: "merge", kind: "prompt" }, {
        task: { id: "FN-1" },
        settings: undefined,
        context: {},
        signal: controller.signal,
      });

      expect(merge).toHaveBeenCalledWith(expect.anything(), expect.anything(), controller.signal);
    });
  });

  describe("classification", () => {
    /* A cancellation routed into bounded auto-merge retry would re-request the merge the
       operator just cancelled. `merge-cancelled` must stay a plain failure the graph's own
       abort handling owns — never `transient-failure` (retry) or `merge-failed`. */
    it("does not classify a cancellation as a retryable merge failure", () => {
      expect(classifyMergePrimitiveResult(undefined, "merge-cancelled", "failure")).toEqual({
        outcome: "failure",
        value: "merge-cancelled",
      });
    });
  });
});
