/**
 * RED-M1: product-status must not silently anchor provider-attempt lookup on
 * `nativeTaskIds[0]` and swallow the result into `providerAttempts: []` when
 * that anchor cannot be resolved. `resolveCccPrdProductStatusProviderAttemptAnchorTaskId`
 * and `providerAttemptStatusesForCampaign` are the pure, database-free units
 * `inspectCccPrdProductStatus` now delegates to (same pattern as the pure
 * `providerAttemptStatus` transform proved in
 * ccc-prd-product-status-effective-route.test.ts), so the anchor-refusal and
 * multi-task surfacing behavior are proved directly here without a
 * PostgreSQL harness.
 *
 * Query-scoping reality found: `listCccProviderAttemptsForCampaign` ->
 * `loadHistory` (packages/core/src/ccc-campaign/provider-attempt.ts:844-867)
 * filters its `runAuditEvents` query only by `projectId` and
 * `campaignImportId` -- never by `taskId` -- and `assembleHistory`
 * (provider-attempt.ts:738-820) validates the fetched rows against
 * `context.requestCount`, which is the campaign-wide counter persisted on
 * `cccPrdImports.requestCount` (packages/core/src/ccc-campaign/store.ts:337,
 * :497), not a per-task counter. So any one resolvable campaign task can
 * anchor the lookup and the FULL multi-task attempt history returns
 * regardless of which task's ID is passed as `taskId`; the `taskId` argument
 * only resolves the anchor task's own context (route, deadline, custody
 * validity) via `loadCccCampaignContextForTask`
 * (packages/core/src/ccc-campaign/store.ts:308-513). The only silent gap is
 * that `loadCccCampaignContextForTask` returns `null` (rather than throwing)
 * when the anchor task's own row is absent from persisted custody
 * (store.ts:371), and `listCccProviderAttemptsForCampaign` turns that `null`
 * into an honestly-empty-looking `[]` (provider-attempt.ts:1303). The fix is
 * therefore anchor-refusal in product-status.ts, not a query-scoping change
 * in provider-attempt.ts.
 */
import { describe, expect, it } from "vitest";
import {
  providerAttemptStatusesForCampaign,
  resolveCccPrdProductStatusProviderAttemptAnchorTaskId,
  type CccPrdProductTaskStatus,
} from "../ccc-prd/product-status.js";
import { CccCampaignContextError } from "../ccc-campaign/types.js";
import type { CccProviderAttemptScope } from "../ccc-campaign/types.js";

function taskStatus(
  overrides: Partial<CccPrdProductTaskStatus> = {},
): CccPrdProductTaskStatus {
  return {
    ordinal: 0,
    semanticTaskId: "TASK-1",
    nativeTaskId: "task-1",
    present: true,
    title: "Task 1",
    description: null,
    route: null,
    worktree: null,
    branch: null,
    baseCommit: null,
    mergeCommit: null,
    state: {
      column: null,
      status: null,
      paused: null,
      userPaused: null,
      pausedReason: null,
      error: null,
      updatedAt: null,
    },
    ...overrides,
  };
}

const binding = Object.freeze({
  projectId: "project-1",
  importId: "import-1",
  campaignId: "campaign-1",
  taskId: "task-1",
  actionId: "task-1",
  actionTarget: "/repo",
  idempotencyKey: "idem-1",
  packetHash: "0".repeat(64),
  sidecarHash: "1".repeat(64),
  bundleHash: "2".repeat(64),
  targetRepository: "org/repo",
  targetBase: "main",
  providerId: "anthropic",
  modelId: "claude-sonnet-5",
  transport: "pi" as const,
  manifestHash: "3".repeat(64),
  bindingHash: "4".repeat(64),
});

function scope(overrides: Partial<CccProviderAttemptScope> = {}): CccProviderAttemptScope {
  return {
    attemptKey: `ccc-provider-attempt-${"a".repeat(64)}`,
    controllerToken: "ccc-provider-controller-00000000-0000-0000-0000-000000000000",
    taskId: "task-1",
    semanticTaskId: "TASK-1",
    campaignDeadlineAt: "2999-01-01T00:00:00.000Z",
    turnKey: "turn-1",
    dispatchKey: "dispatch-1",
    attemptOrdinal: 1,
    requestCount: 1,
    workItemFence: null,
    state: "dispatched_unknown",
    binding: { ...binding, taskId: overrides.taskId ?? "task-1", actionId: overrides.taskId ?? "task-1" },
    ...overrides,
  };
}

describe("resolveCccPrdProductStatusProviderAttemptAnchorTaskId", () => {
  it("RED-M1a: refuses (does not silently pick no anchor) when the campaign has no persisted task at all", () => {
    expect(() => resolveCccPrdProductStatusProviderAttemptAnchorTaskId([]))
      .toThrow(CccCampaignContextError);
  });

  it("RED-M1a: refuses when the first persisted task entity's own row is absent from custody", () => {
    const taskStatuses = [taskStatus({ present: false })];

    let thrown: unknown;
    try {
      resolveCccPrdProductStatusProviderAttemptAnchorTaskId(taskStatuses);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(CccCampaignContextError);
    expect((thrown as CccCampaignContextError).code).toBe("CCC_CAMPAIGN_CONTEXT_REFUSED");
  });

  it("resolves the first present task's native ID as the anchor (no false-positive refusal)", () => {
    const taskStatuses = [
      taskStatus({ nativeTaskId: "task-1", present: true }),
      taskStatus({ nativeTaskId: "task-2", present: true, ordinal: 1 }),
    ];

    expect(resolveCccPrdProductStatusProviderAttemptAnchorTaskId(taskStatuses)).toBe("task-1");
  });
});

describe("providerAttemptStatusesForCampaign multi-task surfacing", () => {
  it("RED-M1b: surfaces provider attempts belonging to a second, non-anchor task rather than dropping them", () => {
    const firstTaskAttempt = scope({ taskId: "task-1", attemptKey: `ccc-provider-attempt-${"a".repeat(64)}`, requestCount: 1 });
    const secondTaskAttempt = scope({ taskId: "task-2", attemptKey: `ccc-provider-attempt-${"b".repeat(64)}`, requestCount: 2 });

    const statuses = providerAttemptStatusesForCampaign([firstTaskAttempt, secondTaskAttempt]);

    const taskIds = statuses.map((status) => status.taskId);
    expect(taskIds).toContain("task-1");
    expect(taskIds).toContain("task-2");
    expect(statuses).toHaveLength(2);
  });

  it("sorts multi-task attempts by task ID, then request count, then attempt key", () => {
    const laterTask = scope({ taskId: "task-2", attemptKey: `ccc-provider-attempt-${"b".repeat(64)}`, requestCount: 2 });
    const earlierTask = scope({ taskId: "task-1", attemptKey: `ccc-provider-attempt-${"a".repeat(64)}`, requestCount: 1 });

    const statuses = providerAttemptStatusesForCampaign([laterTask, earlierTask]);

    expect(statuses.map((status) => status.taskId)).toEqual(["task-1", "task-2"]);
  });
});
