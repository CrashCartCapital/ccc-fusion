/**
 * Per-work-item containment for CCC campaign startup recovery.
 *
 * `recoverCccCampaignUncertainEffectsOnStartup` walks every running campaign
 * work item in the project partition and inspects its campaign's product status.
 * Status inspection now REFUSES with `CccCampaignContextError` when a campaign's
 * provider-attempt anchor task is unresolvable
 * (packages/core/src/ccc-prd/product-status.ts:441-451). Without containment
 * that refusal escapes the loop, escapes the recovery call in
 * `InProcessRuntime.start()` (runtimes/in-process-runtime.ts:467, which has no
 * local catch), and fails the entire engine boot — so one corrupt campaign
 * denies recovery to every other campaign in the partition.
 *
 * HARNESS NOTE: no PostgreSQL. The AsyncDataLayer is faked down to the exact
 * surface the loop uses (`db.select().from().where()`), and
 * `inspectCccPrdProductStatus` is replaced through the `@fusion/core` barrel
 * because the recovery module binds it at import time (no injection seam).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { CccCampaignContextError, type TaskStore } from "@fusion/core";

const { inspectStatusMock } = vi.hoisted(() => ({ inspectStatusMock: vi.fn() }));

vi.mock("@fusion/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@fusion/core")>();
  return { ...actual, inspectCccPrdProductStatus: inspectStatusMock };
});

const {
  CCC_CAMPAIGN_STATUS_REFUSED_RECOVERY_REASON,
  CCC_CAMPAIGN_UNCERTAIN_EFFECT_RECOVERY_REASON,
  recoverCccCampaignUncertainEffectsOnStartup,
} = await import("../ccc-campaign-startup-recovery.js");

const PROJECT_ID = "proj-1";
const PRIOR_OWNER = `in-process-runtime:${PROJECT_ID}:boot-old`;
const CURRENT_OWNER = `in-process-runtime:${PROJECT_ID}:boot-new`;

type WorkItemRow = {
  id: string;
  runId: string;
  taskId: string;
  state: string;
  attempt: number;
  leaseOwner: string | null;
};

function runningItem(id: string, taskId: string): WorkItemRow {
  return {
    id,
    runId: `ccc-prd:${taskId}`,
    taskId,
    state: "running",
    attempt: 1,
    leaseOwner: PRIOR_OWNER,
  };
}

/** A campaign whose provider attempt crossed the durable unknown-effect boundary. */
function uncertainEffectStatus(item: WorkItemRow) {
  return {
    providerAttempts: [{
      attemptKey: `attempt-${item.id}`,
      state: "dispatched_unknown",
      workItemFence: { workItemId: item.id, runId: item.runId, attempt: item.attempt },
    }],
    proofs: [],
  };
}

function makeStore(rows: readonly WorkItemRow[]) {
  const transitionWorkflowWorkItem = vi.fn(async () => undefined);
  const store = {
    getAsyncLayer: () => ({
      projectId: PROJECT_ID,
      db: { select: () => ({ from: () => ({ where: async () => rows }) }) },
    }),
    getCccCampaignContextForTask: vi.fn(async (taskId: string) => ({
      idempotencyKey: `import-${taskId}`,
    })),
    transitionWorkflowWorkItem,
  } as unknown as TaskStore;
  return { store, transitionWorkflowWorkItem };
}

function transitionFor(
  transition: ReturnType<typeof vi.fn>,
  workItemId: string,
): Record<string, unknown> | undefined {
  const call = transition.mock.calls.find(([id]) => id === workItemId);
  return call?.[2] as Record<string, unknown> | undefined;
}

const CORRUPT = runningItem("wi-corrupt", "FN-9001");
const HEALTHY = runningItem("wi-healthy", "FN-9002");

describe("CCC campaign startup recovery per-item containment", () => {
  beforeEach(() => {
    inspectStatusMock.mockReset();
  });

  it("parks the refusing work item and still recovers the healthy campaign behind it", async () => {
    // The corrupt campaign is inspected FIRST; today its refusal aborts the partition.
    inspectStatusMock.mockImplementation(async ({ idempotencyKey }: { idempotencyKey: string }) => {
      if (idempotencyKey === `import-${CORRUPT.taskId}`) {
        throw new CccCampaignContextError(
          "CCC PRD product status has no resolvable campaign context anchor task to load provider attempts",
        );
      }
      return uncertainEffectStatus(HEALTHY);
    });
    const { store, transitionWorkflowWorkItem } = makeStore([CORRUPT, HEALTHY]);

    const recovered = await recoverCccCampaignUncertainEffectsOnStartup({
      store,
      rootDir: "/tmp/project",
      currentLeaseOwner: CURRENT_OWNER,
    });

    // The healthy campaign is still recovered.
    expect(recovered.map(({ workItemId }) => workItemId)).toEqual(["wi-healthy"]);
    expect(transitionFor(transitionWorkflowWorkItem, "wi-healthy")).toMatchObject({
      blockedReason: CCC_CAMPAIGN_UNCERTAIN_EFFECT_RECOVERY_REASON,
    });

    // The refusing campaign parks for an operator, naming the refusal.
    const parked = transitionFor(transitionWorkflowWorkItem, "wi-corrupt");
    expect(parked).toMatchObject({
      blockedReason: CCC_CAMPAIGN_STATUS_REFUSED_RECOVERY_REASON,
      expectedState: "running",
      expectedLeaseOwner: PRIOR_OWNER,
      leaseOwner: null,
    });
    expect(parked?.lastError).toContain("anchor task");
    expect(transitionWorkflowWorkItem.mock.calls.find(([id]) => id === "wi-corrupt")?.[1])
      .toBe("manual-required");
  });

  it("does not blanket-catch: a non-refusal error class still propagates", async () => {
    inspectStatusMock.mockRejectedValue(new TypeError("layer.db is not a function"));
    const { store, transitionWorkflowWorkItem } = makeStore([CORRUPT, HEALTHY]);

    await expect(recoverCccCampaignUncertainEffectsOnStartup({
      store,
      rootDir: "/tmp/project",
      currentLeaseOwner: CURRENT_OWNER,
    })).rejects.toThrow(TypeError);
    expect(transitionWorkflowWorkItem).not.toHaveBeenCalled();
  });

  it("leaves the all-healthy partition unchanged", async () => {
    inspectStatusMock.mockImplementation(async () => uncertainEffectStatus(HEALTHY));
    const { store, transitionWorkflowWorkItem } = makeStore([HEALTHY]);

    const recovered = await recoverCccCampaignUncertainEffectsOnStartup({
      store,
      rootDir: "/tmp/project",
      currentLeaseOwner: CURRENT_OWNER,
    });

    expect(recovered).toHaveLength(1);
    expect(transitionWorkflowWorkItem).toHaveBeenCalledTimes(1);
  });
});
