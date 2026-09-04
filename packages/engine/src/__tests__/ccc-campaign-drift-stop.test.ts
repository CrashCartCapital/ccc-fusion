import { describe, expect, it, vi } from "vitest";
import type { CccPrdCampaignDriftStopPlan } from "@fusion/core";
import {
  CccCampaignDriftStopError,
  applyCccCampaignDriftStop,
  computeCccCampaignDriftStopConfirmation,
} from "../ccc-campaign-drift-stop.js";

const markImportStopped = vi.hoisted(() => vi.fn());

vi.mock("@fusion/core", async (importOriginal) => ({
  ...await importOriginal<typeof import("@fusion/core")>(),
  markCccPrdImportStopped: markImportStopped,
}));

const STOPPED_PREFIX = "ccc-operator:campaign-stopped:";
const DRIFT_REASON = "campaign manifest drift";

function plan(
  overrides: Partial<CccPrdCampaignDriftStopPlan> = {},
): CccPrdCampaignDriftStopPlan {
  return {
    schema: "ccc-prd.campaign-drift-stop-plan.v1",
    projectId: "project-1",
    importId: "import-1",
    idempotencyKey: "ccc-gate3-quant-engine-l12-20260903",
    importState: "active",
    targetRepository: "/tmp/ccc-quant-engine",
    driftReason: DRIFT_REASON,
    workItem: {
      id: "work-1",
      runId: "ccc-prd:import-1",
      stableWorkflowRunId: "ccc-prd:import-1",
      kind: "task",
      state: "runnable",
      attempt: 2,
    },
    taskIds: ["KB-005", "KB-006"],
    ...overrides,
  } as CccPrdCampaignDriftStopPlan;
}

/**
 * A store that answers only the two calls a drifted-campaign close is allowed
 * to make. Anything that disposes a worktree, deletes a branch, or resolves an
 * approval fails the test by name rather than silently succeeding.
 */
function recordingStore() {
  const forbidden = [
    "removeWorktree",
    "disposeWorktree",
    "releaseWorktree",
    "deleteBranch",
    "pruneWorktrees",
    "resolveApprovalRequest",
    "settleApprovalRequest",
    "approveActionRequest",
    "closeExecutionAuthorization",
    "updateTask",
    "deleteTask",
  ] as const;
  const calls: Array<{ method: string; args: readonly unknown[] }> = [];
  const store = {
    rootDir: "/tmp/ccc-quant-engine",
    getAsyncLayer: () => ({ projectId: "project-1" }),
    transitionWorkflowWorkItem: vi.fn(
      (...args: readonly unknown[]) => {
        calls.push({ method: "transitionWorkflowWorkItem", args });
        return Promise.resolve();
      },
    ),
    pauseTask: vi.fn((...args: readonly unknown[]) => {
      calls.push({ method: "pauseTask", args });
      return Promise.resolve();
    }),
  } as Record<string, unknown>;
  for (const method of forbidden) {
    store[method] = vi.fn(() => {
      throw new Error(`forbidden store call: ${method}`);
    });
  }
  return { store, calls, forbidden };
}

const layer = { projectId: "project-1" } as never;

describe("closing a drifted CCC campaign", () => {
  it("RED-L16-b: stops without disposing worktrees, branches, or approvals", async () => {
    markImportStopped.mockReset().mockResolvedValue(undefined);
    const { store, calls, forbidden } = recordingStore();
    const current = plan();

    const result = await applyCccCampaignDriftStop({
      plan: current,
      reason: "campaign manifest drift blocks every ordinary control",
      confirmation: computeCccCampaignDriftStopConfirmation(current),
      store: store as never,
      layer,
    });

    expect(result.workItemState).toBe("cancelled");
    expect(result.taskIds).toEqual(["KB-005", "KB-006"]);
    // Uncertain effects stay where the operator can still inspect them.
    expect(result.unresolvedEffectsPreserved).toBe(true);
    for (const method of forbidden) {
      expect(store[method]).not.toHaveBeenCalled();
    }
    expect(calls.map(({ method }) => method)).toEqual([
      "transitionWorkflowWorkItem",
      "pauseTask",
      "pauseTask",
    ]);
  });

  it("RED-L16-c: records the drift reason in the terminal state", async () => {
    markImportStopped.mockReset().mockResolvedValue(undefined);
    const { store, calls } = recordingStore();
    const current = plan();

    await applyCccCampaignDriftStop({
      plan: current,
      reason: "campaign manifest drift blocks every ordinary control",
      confirmation: computeCccCampaignDriftStopConfirmation(current),
      store: store as never,
      layer,
    });

    const [transition] = calls;
    const patch = transition!.args[2] as Record<string, unknown>;
    expect(transition!.args[1]).toBe("cancelled");
    expect(String(patch.lastError)).toMatch(
      new RegExp(`^${STOPPED_PREFIX}[0-9a-f]{64}$`),
    );
    expect(String(patch.blockedReason)).toContain(
      `custody-drift: ${DRIFT_REASON}`,
    );
    // The import row carries the same closure, so the reason survives even
    // where custody can never be rebuilt.
    expect(markImportStopped).toHaveBeenCalledTimes(1);
    const [importCall] = markImportStopped.mock.calls;
    expect(String((importCall![0] as { stoppedReason: string }).stoppedReason))
      .toContain(`custody-drift: ${DRIFT_REASON}`);
  });

  it("RED-L16-b: refuses a stale confirmation and writes nothing", async () => {
    markImportStopped.mockReset().mockResolvedValue(undefined);
    const { store, calls } = recordingStore();

    const rejection = await applyCccCampaignDriftStop({
      plan: plan(),
      reason: "campaign manifest drift blocks every ordinary control",
      confirmation: "0".repeat(64),
      store: store as never,
      layer,
    }).catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(CccCampaignDriftStopError);
    expect((rejection as CccCampaignDriftStopError).code)
      .toBe("CCC_CAMPAIGN_DRIFT_STOP_CONFIRMATION_REFUSED");
    expect(calls).toEqual([]);
    expect(markImportStopped).not.toHaveBeenCalled();
  });

  it("RED-L16-d: marks the import terminal only after the workflow is cancelled", async () => {
    markImportStopped.mockReset().mockResolvedValue(undefined);
    const { store } = recordingStore();
    const order: string[] = [];
    (store.transitionWorkflowWorkItem as ReturnType<typeof vi.fn>)
      .mockImplementation(() => {
        order.push("transition");
        return Promise.resolve();
      });
    markImportStopped.mockImplementation(() => {
      order.push("mark-import-stopped");
      return Promise.resolve();
    });
    const current = plan();

    await applyCccCampaignDriftStop({
      plan: current,
      reason: "campaign manifest drift blocks every ordinary control",
      confirmation: computeCccCampaignDriftStopConfirmation(current),
      store: store as never,
      layer,
    });

    expect(order).toEqual(["transition", "mark-import-stopped"]);
  });

  it("RED-L16-b: a confirmation cannot be replayed across campaigns", () => {
    const first = computeCccCampaignDriftStopConfirmation(plan());
    const second = computeCccCampaignDriftStopConfirmation(
      plan({ idempotencyKey: "ccc-gate3-quant-engine-l12r2-20260903" }),
    );
    const repaired = computeCccCampaignDriftStopConfirmation(
      plan({ driftReason: "campaign custody cannot reconstruct a canonical manifest" }),
    );

    expect(first).not.toBe(second);
    expect(first).not.toBe(repaired);
  });
});
