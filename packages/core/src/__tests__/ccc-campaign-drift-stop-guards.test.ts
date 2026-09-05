import { describe, expect, it } from "vitest";
import { assertCccPrdCampaignDriftStopWorkItem } from "../ccc-prd/campaign-drift-stop.js";
import { CccPrdImportError } from "../ccc-prd/import-error.js";

/*
 * Guards on the work item a drifted-campaign close is allowed to touch.
 *
 * The ordinary operator control refuses any work item that still holds runtime
 * lease custody, and it reaches that check through a status the drifted path
 * cannot build. Without the same guard here, closing a drifted campaign could
 * cancel a work item the runtime still owns.
 *
 * The terminal guard is the other half: a second close would overwrite the
 * first one's recorded stop reason, losing the evidence of why the campaign was
 * closed and when.
 */

const runId = "ccc-prd:import-1";

function workItem(overrides: Record<string, unknown> = {}) {
  return {
    id: "work-1",
    runId,
    stableWorkflowRunId: runId,
    kind: "task",
    state: "runnable",
    attempt: 2,
    leaseOwner: null,
    leaseExpiresAt: null,
    ...overrides,
  };
}

function refusalFrom(item: ReturnType<typeof workItem>): CccPrdImportError {
  try {
    assertCccPrdCampaignDriftStopWorkItem(item, runId);
  } catch (error) {
    return error as CccPrdImportError;
  }
  throw new Error("expected a refusal");
}

describe("drifted-campaign stop work-item guards", () => {
  it("RED-L18-1: refuses a work item the runtime still leases", () => {
    expect(refusalFrom(workItem({ leaseOwner: "runtime-1" })).code)
      .toBe("CCC_PRD_CAMPAIGN_DRIFT_STOP_LEASED");
  });

  it("RED-L18-1: refuses a lease expiry even with no owner", () => {
    // A null owner is not proof the lease is gone. The ordinary control refuses
    // on either field, and this path must not be the weaker of the two.
    expect(refusalFrom(workItem({ leaseExpiresAt: "2026-09-04T10:00:00.000Z" })).code)
      .toBe("CCC_PRD_CAMPAIGN_DRIFT_STOP_LEASED");
  });

  it("RED-L18-1: refuses a running work item with a null lease", () => {
    expect(refusalFrom(workItem({ state: "running" })).code)
      .toBe("CCC_PRD_CAMPAIGN_DRIFT_STOP_LEASED");
  });

  it("RED-L18-2: refuses a work item that is already terminal", () => {
    // Re-running the close would overwrite the first stop's blockedReason and
    // lose why the campaign was closed.
    const refusal = refusalFrom(workItem({ state: "cancelled" }));
    expect(refusal.code).toBe("CCC_PRD_CAMPAIGN_DRIFT_STOP_ALREADY_TERMINAL");
    expect(refusal.message).toContain("work-1");
  });

  it("RED-L18-2: refuses a completed work item too", () => {
    expect(refusalFrom(workItem({ state: "completed" })).code)
      .toBe("CCC_PRD_CAMPAIGN_DRIFT_STOP_ALREADY_TERMINAL");
  });

  it("RED-L18-1: still admits an unleased, non-terminal work item", () => {
    // Guards the guards: over-refusing here would make the drifted campaigns
    // unstoppable again, which is the whole defect.
    expect(() => assertCccPrdCampaignDriftStopWorkItem(workItem(), runId)).not.toThrow();
    expect(() =>
      assertCccPrdCampaignDriftStopWorkItem(workItem({ state: "retrying" }), runId)
    ).not.toThrow();
    expect(() =>
      assertCccPrdCampaignDriftStopWorkItem(workItem({ state: "held" }), runId)
    ).not.toThrow();
  });

  it("RED-L18-1: still refuses a work item that is not this import's", () => {
    expect(refusalFrom(workItem({ stableWorkflowRunId: "ccc-prd:other" })).code)
      .toBe("CCC_PRD_CAMPAIGN_DRIFT_STOP_CUSTODY_REFUSED");
    expect(refusalFrom(workItem({ kind: "review" })).code)
      .toBe("CCC_PRD_CAMPAIGN_DRIFT_STOP_CUSTODY_REFUSED");
    expect(refusalFrom(workItem({ attempt: -1 })).code)
      .toBe("CCC_PRD_CAMPAIGN_DRIFT_STOP_CUSTODY_REFUSED");
  });
});
