import { describe, expect, it, vi } from "vitest";
import type { CccPrdProductStatus } from "@fusion/core";
import {
  applyCccCampaignOperatorControl,
  computeCccCampaignOperatorControlConfirmation,
  describeCccCampaignOperatorControls,
} from "../ccc-campaign-operator-control.js";

const PAUSED_REASON = "ccc-operator:campaign-paused";

function status(
  state: "runnable" | "held" | "manual-required" | "cancelled" = "runnable",
  overrides: Record<string, unknown> = {},
): CccPrdProductStatus {
  const workItem = {
    id: "work-1",
    runId: "ccc-prd:import-1",
    taskId: "FN-1",
    nodeId: "node-1",
    kind: "task",
    state,
    attempt: 2,
    retryAfter: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    lastError: state === "manual-required"
      ? "ccc-permanent:CCC_CAMPAIGN_PROOF_DISPATCH_UNKNOWN"
      : null,
    blockedReason: state === "held" ? PAUSED_REASON : null,
    waitReason: null,
    stableWorkflowRunId: "ccc-prd:import-1",
    continuationSequence: null,
    createdAt: "2026-07-31T00:00:00.000Z",
    updatedAt: "2026-07-31T00:00:00.000Z",
    ...overrides,
  };
  return {
    schema: "ccc-prd.product-status.v1",
    projectId: "project-1",
    import: {
      importId: "import-1",
      idempotencyKey: "operator-key",
      packetHash: "a".repeat(64),
      sidecarHash: "b".repeat(64),
      bundleHash: "c".repeat(64),
      targetRepository: "/tmp/product-target",
      targetBase: "d".repeat(40),
      state: "active",
      runnable: true,
      createdAt: "2026-07-31T00:00:00.000Z",
      updatedAt: "2026-07-31T00:00:00.000Z",
    },
    tasks: [
      {
        ordinal: 0,
        semanticTaskId: "TASK-1",
        nativeTaskId: "FN-1",
        present: true,
        title: "Coding task",
        description: "Change one owned file.",
        route: {
          providerId: "fixture",
          modelId: "fixture-v2",
          transport: "pi",
          executor: "model",
          toolMode: "coding",
          worktreeMode: "isolated",
          ownedPaths: ["src/value.txt"],
          allowedWriteRoots: ["src/value.txt"],
          commitPolicy: "required",
        },
        worktree: "/tmp/worktree",
        branch: "agent/task-1",
        baseCommit: "d".repeat(40),
        mergeCommit: null,
        state: {
          column: "todo",
          status: null,
          paused: state === "held" || state === "cancelled",
          userPaused: false,
          pausedReason: state === "held" ? PAUSED_REASON : null,
          error: null,
          updatedAt: "2026-07-31T00:00:00.000Z",
        },
      },
    ],
    workItems: [workItem],
    proofs: [],
    orphanProofAttempts: [],
    providerAttempts: [],
    approvals: [],
    landing: {
      intents: [],
      materializations: [],
      terminals: [],
    },
    nextAction: {
      kind: state === "cancelled" ? "blocked" : "wait-for-runtime",
      reason: "fixture",
    },
  } as unknown as CccPrdProductStatus;
}

function store() {
  return {
    transitionWorkflowWorkItem: vi.fn(async (
      id: string,
      state: string,
      patch: Record<string, unknown>,
    ) => ({ id, state, ...patch })),
    pauseTask: vi.fn(async (id: string, paused: boolean) => ({ id, paused })),
  };
}

describe("CCC campaign operator lifecycle controls", () => {
  it("binds confirmations to exact persisted status and describes only safe controls", () => {
    const runnable = status();
    const controls = describeCccCampaignOperatorControls(runnable);

    expect(controls).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: "pause",
        allowed: true,
        consequence: expect.stringContaining("safe boundary"),
        confirmation: computeCccCampaignOperatorControlConfirmation(
          runnable,
          "pause",
        ),
      }),
      expect.objectContaining({
        action: "resume",
        allowed: false,
        confirmation: null,
      }),
      expect.objectContaining({
        action: "stop",
        allowed: true,
        consequence: expect.stringMatching(/terminal/i),
      }),
    ]));
    expect(
      computeCccCampaignOperatorControlConfirmation(
        status("runnable", { attempt: 3 }),
        "pause",
      ),
    ).not.toBe(computeCccCampaignOperatorControlConfirmation(runnable, "pause"));
  });

  it("allows an imported attempt-zero work item to pause before first dispatch", () => {
    const imported = status("runnable", { attempt: 0 });
    expect(describeCccCampaignOperatorControls(imported)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "pause",
          allowed: true,
          confirmation: expect.stringMatching(/^[0-9a-f]{64}$/),
        }),
      ]),
    );
  });

  it("parks an unleased campaign before pausing every imported task", async () => {
    const current = status();
    const taskStore = store();

    await expect(applyCccCampaignOperatorControl({
      action: "pause",
      status: current,
      store: taskStore,
    })).resolves.toMatchObject({
      action: "pause",
      workItemId: "work-1",
      workItemState: "held",
      taskIds: ["FN-1"],
    });

    expect(taskStore.transitionWorkflowWorkItem).toHaveBeenCalledWith(
      "work-1",
      "held",
      {
        expectedState: "runnable",
        expectedAttempt: 2,
        expectedLeaseOwner: null,
        attempt: 2,
        retryAfter: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: null,
        blockedReason: PAUSED_REASON,
      },
    );
    expect(taskStore.pauseTask).toHaveBeenCalledWith(
      "FN-1",
      true,
      undefined,
      {
        pausedByAgentId: "ccc-fusion-local-operator",
        pausedReason: PAUSED_REASON,
      },
    );
    expect(taskStore.transitionWorkflowWorkItem.mock.invocationCallOrder[0])
      .toBeLessThan(taskStore.pauseTask.mock.invocationCallOrder[0]!);
  });

  it("unpauses tasks before making a held campaign runnable", async () => {
    const current = status("held");
    const taskStore = store();

    await expect(applyCccCampaignOperatorControl({
      action: "resume",
      status: current,
      store: taskStore,
    })).resolves.toMatchObject({
      action: "resume",
      workItemState: "runnable",
    });

    expect(taskStore.pauseTask).toHaveBeenCalledWith("FN-1", false);
    expect(taskStore.transitionWorkflowWorkItem).toHaveBeenCalledWith(
      "work-1",
      "runnable",
      {
        expectedState: "held",
        expectedAttempt: 2,
        expectedLeaseOwner: null,
        attempt: 2,
        retryAfter: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: null,
        blockedReason: null,
      },
    );
    expect(taskStore.pauseTask.mock.invocationCallOrder[0])
      .toBeLessThan(
        taskStore.transitionWorkflowWorkItem.mock.invocationCallOrder[0]!,
      );
  });

  it("stops an unleased uncertain campaign without claiming the effect was settled", async () => {
    const current = status("manual-required");
    const taskStore = store();

    await expect(applyCccCampaignOperatorControl({
      action: "stop",
      reason: "Operator abandons this run; proof effect remains uncertain.",
      status: current,
      store: taskStore,
    })).resolves.toMatchObject({
      action: "stop",
      workItemState: "cancelled",
      unresolvedEffectsPreserved: true,
    });

    expect(taskStore.transitionWorkflowWorkItem).toHaveBeenCalledWith(
      "work-1",
      "cancelled",
      expect.objectContaining({
        expectedState: "manual-required",
        expectedLeaseOwner: null,
        lastError: expect.stringContaining("ccc-operator:campaign-stopped:"),
        blockedReason: expect.stringContaining(
          "proof effect remains uncertain",
        ),
      }),
    );
    expect(taskStore.pauseTask).toHaveBeenCalledWith(
      "FN-1",
      true,
      undefined,
      expect.objectContaining({
        pausedReason: expect.stringContaining("ccc-operator:campaign-stopped:"),
      }),
    );
  });

  it("binds controls to provider-attempt state and preserves provider uncertainty on stop", async () => {
    const runnable = status();
    const providerUnknown = {
      ...runnable,
      providerAttempts: [{
        attemptKey: `ccc-provider-attempt-${"a".repeat(64)}`,
        state: "dispatched_unknown",
      }],
    } as unknown as CccPrdProductStatus;
    expect(computeCccCampaignOperatorControlConfirmation(
      providerUnknown,
      "stop",
    )).not.toBe(computeCccCampaignOperatorControlConfirmation(
      runnable,
      "stop",
    ));

    await expect(applyCccCampaignOperatorControl({
      action: "stop",
      reason: "Operator abandons this run; provider effect remains uncertain.",
      status: providerUnknown,
      store: store(),
    })).resolves.toMatchObject({
      workItemState: "cancelled",
      unresolvedEffectsPreserved: true,
    });
  });

  it("refuses pause, resume, or stop while runtime lease custody is live", async () => {
    const leased = status("runnable", {
      state: "running",
      leaseOwner: "runtime-1",
      leaseExpiresAt: "2026-07-31T00:01:00.000Z",
    });
    const taskStore = store();

    expect(describeCccCampaignOperatorControls(leased))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          action: "pause",
          allowed: false,
          reason: expect.stringContaining("runtime lease"),
        }),
        expect.objectContaining({
          action: "stop",
          allowed: false,
          confirmation: null,
        }),
      ]));
    await expect(applyCccCampaignOperatorControl({
      action: "stop",
      reason: "Stop after the safe boundary.",
      status: leased,
      store: taskStore,
    })).rejects.toMatchObject({
      code: "CCC_CAMPAIGN_OPERATOR_CONTROL_LEASED",
    });
    expect(taskStore.transitionWorkflowWorkItem).not.toHaveBeenCalled();
    expect(taskStore.pauseTask).not.toHaveBeenCalled();
  });
});
