import { beforeEach, describe, expect, it, vi } from "vitest";

const authorizationMocks = vi.hoisted(() => ({
  closeUnopened: vi.fn(),
  getForImport: vi.fn(),
}));

vi.mock("@fusion/core", async (importOriginal) => ({
  ...await importOriginal<typeof import("@fusion/core")>(),
  closeUnopenedCccCampaignExecutionAuthorizationMembers:
    authorizationMocks.closeUnopened,
  getCccCampaignExecutionAuthorizationForImport:
    authorizationMocks.getForImport,
}));

import { processDueWorkflowWorkItem } from "../workflow-work-processor.js";

const workItem = {
  id: "ccc-work-item-1",
  taskId: "ccc-task-1",
  runId: "ccc-prd:import-1",
  stableWorkflowRunId: "ccc-prd:import-1",
  irHash: "a".repeat(64),
  nodeId: "execute",
  kind: "task",
  state: "running",
  attempt: 1,
  leaseOwner: "worker-1",
  leaseExpiresAt: "2026-08-12T20:01:00.000Z",
  lastError: null,
  blockedReason: null,
  createdAt: "2026-08-12T20:00:00.000Z",
  updatedAt: "2026-08-12T20:00:01.000Z",
} as const;

const sealedContext = {
  schema: "ccc-campaign-context/v1",
  executionAuthorizationMode: "sealed_bundle_v1",
  projectId: "project-1",
  importId: "import-1",
  taskId: workItem.taskId,
  route: { taskId: "TSK-001", transport: "pi" },
  manifestHash: "b".repeat(64),
  requestCount: 0,
  activeActionLeases: {},
};

const claimedAuthorization = {
  authorizationId: "ccc-execution-authorization-1",
  status: "claimed",
};

function processorStore() {
  const layer = { db: { querySurface: "postgres" } };
  const transitionWorkflowWorkItem = vi.fn(async (
    _id: string,
    state: string,
  ) => ({ ...workItem, state }));
  const logEntry = vi.fn(async () => undefined);
  const store = {
    rootDir: "/tmp/ccc-campaign-target",
    listDueWorkflowWorkItems: vi.fn(async () => [workItem]),
    acquireWorkflowWorkItemLease: vi.fn(async () => workItem),
    transitionWorkflowWorkItem,
    renewWorkflowWorkItemLease: vi.fn(async () => workItem),
    getCccCampaignContextForTask: vi.fn(async () => sealedContext),
    getTask: vi.fn(async () => ({ id: workItem.taskId, title: "Campaign task" })),
    getAsyncLayer: vi.fn(() => layer),
    logEntry,
  };
  return { layer, logEntry, store, transitionWorkflowWorkItem };
}

describe("sealed campaign authorization terminal cleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authorizationMocks.getForImport.mockResolvedValue(claimedAuthorization);
    authorizationMocks.closeUnopened.mockResolvedValue({
      authorization: { ...claimedAuthorization, status: "settled" },
      closedApprovalRequestIds: ["ccc-approval-unopened"],
      openedApprovalRequestIds: [],
    });
  });

  it("Slice 3 RED: durably failing a sealed campaign closes its claimed unopened authorization members", async () => {
    const { layer, store, transitionWorkflowWorkItem } = processorStore();
    const runtimeResult = {
      disposition: "failed" as const,
      outcome: "failure" as const,
      visitedNodeIds: ["execute"],
      context: {},
      reason: "ccc-permanent:CCC_CAMPAIGN_IMPLEMENTATION_FAILED",
    };

    await expect(processDueWorkflowWorkItem(
      store as never,
      { run: vi.fn(async () => runtimeResult) } as never,
      undefined,
      { leaseOwner: "worker-1", leaseDurationMs: 1_000 },
    )).resolves.toMatchObject({ runtime: runtimeResult });

    expect(authorizationMocks.getForImport).toHaveBeenCalledWith(
      layer.db,
      sealedContext.importId,
    );
    expect(authorizationMocks.closeUnopened).toHaveBeenCalledWith(
      layer,
      expect.objectContaining({
        authorityStore: store,
        rootDir: store.rootDir,
        authorizationId: claimedAuthorization.authorizationId,
        runId: workItem.runId,
      }),
    );
    expect(transitionWorkflowWorkItem.mock.invocationCallOrder[0])
      .toBeLessThan(authorizationMocks.closeUnopened.mock.invocationCallOrder[0]!);
  });

  it("Slice 3 RED: closure failure is returned and logged without replacing durable terminal truth", async () => {
    const { logEntry, store, transitionWorkflowWorkItem } = processorStore();
    authorizationMocks.closeUnopened.mockRejectedValueOnce(
      new Error("closure database unavailable"),
    );
    const runtimeResult = {
      disposition: "failed" as const,
      outcome: "failure" as const,
      visitedNodeIds: ["execute"],
      context: {},
      reason: "ccc-permanent:CCC_CAMPAIGN_IMPLEMENTATION_FAILED",
    };
    const diagnostic =
      "[ccc-campaign:execution-authorization-closure-failed] "
      + `workItem=${workItem.id} authorization=${claimedAuthorization.authorizationId} `
      + "terminal=failed error=closure database unavailable";

    const result = await processDueWorkflowWorkItem(
      store as never,
      { run: vi.fn(async () => runtimeResult) } as never,
      undefined,
      { leaseOwner: "worker-1", leaseDurationMs: 1_000 },
    );

    // The terminal-reason diagnostic now follows the closure diagnostic; this
    // assertion still pins the closure one and its leading position.
    expect(result).toMatchObject({ runtime: runtimeResult });
    expect(result.diagnostics?.[0]).toBe(diagnostic);
    expect(transitionWorkflowWorkItem).toHaveBeenCalledWith(
      workItem.id,
      "failed",
      expect.objectContaining({ lastError: runtimeResult.reason }),
    );
    expect(logEntry).toHaveBeenCalledWith(workItem.taskId, diagnostic);
  });

  it("Slice 3 RED: fallback terminal persistence after a runtime exception also closes unopened members", async () => {
    const { store, transitionWorkflowWorkItem } = processorStore();

    const result = await processDueWorkflowWorkItem(
      store as never,
      { run: vi.fn(async () => { throw new Error("runtime exploded"); }) } as never,
      undefined,
      { leaseOwner: "worker-1", leaseDurationMs: 1_000 },
    );

    expect(result.runtime).toMatchObject({
      disposition: "failed",
      reason: "workflow-work-item-runtime-error:runtime exploded",
    });
    expect(transitionWorkflowWorkItem).toHaveBeenCalledWith(
      workItem.id,
      "failed",
      expect.objectContaining({
        lastError: "workflow-work-item-runtime-error:runtime exploded",
      }),
    );
    expect(authorizationMocks.closeUnopened).toHaveBeenCalledOnce();
    expect(transitionWorkflowWorkItem.mock.invocationCallOrder[0])
      .toBeLessThan(authorizationMocks.closeUnopened.mock.invocationCallOrder[0]!);
  });

  it("Slice 3 RED: opened effects stay open and produce an explicit reconciliation diagnostic", async () => {
    const { logEntry, store } = processorStore();
    authorizationMocks.closeUnopened.mockResolvedValueOnce({
      authorization: claimedAuthorization,
      closedApprovalRequestIds: ["ccc-approval-unopened"],
      openedApprovalRequestIds: ["ccc-approval-opened"],
    });
    const diagnostic =
      "[ccc-campaign:execution-authorization-reconciliation-required] "
      + `workItem=${workItem.id} authorization=${claimedAuthorization.authorizationId} `
      + "terminal=failed openedApprovalRequests=ccc-approval-opened";

    const result = await processDueWorkflowWorkItem(
      store as never,
      { run: vi.fn(async () => ({
        disposition: "failed",
        outcome: "failure",
        visitedNodeIds: ["execute"],
        context: {},
        reason: "ccc-permanent:CCC_CAMPAIGN_IMPLEMENTATION_FAILED",
      })) } as never,
      undefined,
      { leaseOwner: "worker-1", leaseDurationMs: 1_000 },
    );

    // Still the leading diagnostic; the terminal-reason line is appended after it.
    expect(result.diagnostics?.[0]).toBe(diagnostic);
    expect(logEntry).toHaveBeenCalledWith(workItem.taskId, diagnostic);
  });

  it("Slice 3 RED: a concurrent durable cancellation still triggers sealed unopened-member closure", async () => {
    const { store, transitionWorkflowWorkItem } = processorStore();
    transitionWorkflowWorkItem.mockRejectedValueOnce(
      new Error("terminal compare-and-swap lost"),
    );
    Object.assign(store, {
      getWorkflowWorkItem: vi.fn(async () => ({
        ...workItem,
        state: "cancelled",
        leaseOwner: null,
        leaseExpiresAt: null,
      })),
    });

    const result = await processDueWorkflowWorkItem(
      store as never,
      { run: vi.fn(async () => ({
        disposition: "failed",
        outcome: "failure",
        visitedNodeIds: ["execute"],
        context: {},
        reason: "workflow-aborted",
      })) } as never,
      undefined,
      { leaseOwner: "worker-1", leaseDurationMs: 1_000 },
    );

    expect(result.runtime).toMatchObject({
      disposition: "cancelled",
      reason: "workflow-work-item-cancelled",
    });
    expect(authorizationMocks.closeUnopened).toHaveBeenCalledOnce();
  });

  it("Slice 3 RED: cancellation before custody lookup closes a persisted sealed parent without waiting on custody", async () => {
    const { store } = processorStore();
    store.getTask.mockResolvedValueOnce({
      id: workItem.taskId,
      title: "Campaign task",
      userPaused: true,
    });
    store.getCccCampaignContextForTask.mockImplementationOnce(
      () => new Promise<never>(() => undefined),
    );

    const result = await processDueWorkflowWorkItem(
      store as never,
      { run: vi.fn() } as never,
      undefined,
      { leaseOwner: "worker-1", leaseDurationMs: 1_000 },
    );

    expect(result.runtime).toMatchObject({
      disposition: "cancelled",
      reason: "workflow-user-cancelled",
    });
    expect(store.getCccCampaignContextForTask).not.toHaveBeenCalled();
    expect(authorizationMocks.getForImport).toHaveBeenCalledWith(
      expect.anything(),
      sealedContext.importId,
    );
    expect(authorizationMocks.closeUnopened).toHaveBeenCalledOnce();
  });

  it("keeps the live-execution approval hold open", async () => {
    const { store } = processorStore();

    const result = await processDueWorkflowWorkItem(
      store as never,
      { run: vi.fn(async () => ({
        disposition: "manual-required",
        outcome: "failure",
        visitedNodeIds: ["execute"],
        context: {},
        reason: "ccc-permanent:CCC_CAMPAIGN_LIVE_EXECUTION_APPROVAL_REQUIRED",
      })) } as never,
      undefined,
      { leaseOwner: "worker-1", leaseDurationMs: 1_000 },
    );

    expect(result.runtime?.disposition).toBe("manual-required");
    expect(authorizationMocks.getForImport).not.toHaveBeenCalled();
    expect(authorizationMocks.closeUnopened).not.toHaveBeenCalled();
  });

  it("closes unopened members for a non-live-approval manual-required terminal", async () => {
    const { store, transitionWorkflowWorkItem } = processorStore();
    const reasonCode = "ccc-permanent:CCC_CAMPAIGN_PROOF_FAILED";
    const diagnosticReason = `${reasonCode}: semantic proof toolchain identity drifted`;

    const result = await processDueWorkflowWorkItem(
      store as never,
      { run: vi.fn(async () => ({
        disposition: "manual-required",
        outcome: "failure",
        visitedNodeIds: ["execute"],
        context: { "ccc:retry-classification": reasonCode },
        reason: diagnosticReason,
      })) } as never,
      undefined,
      { leaseOwner: "worker-1", leaseDurationMs: 1_000 },
    );

    expect(result.runtime?.disposition).toBe("manual-required");
    expect(transitionWorkflowWorkItem).toHaveBeenCalledWith(
      workItem.id,
      "manual-required",
      expect.objectContaining({
        lastError: diagnosticReason,
        blockedReason: reasonCode,
      }),
    );
    expect(authorizationMocks.closeUnopened).toHaveBeenCalledOnce();
  });

  it("leaves legacy per-task campaign approvals unchanged", async () => {
    const { store } = processorStore();
    store.getCccCampaignContextForTask.mockResolvedValue({
      ...sealedContext,
      executionAuthorizationMode: "per_task_v1",
    });

    await processDueWorkflowWorkItem(
      store as never,
      { run: vi.fn(async () => ({
        disposition: "failed",
        outcome: "failure",
        visitedNodeIds: ["execute"],
        context: {},
        reason: "legacy failure",
      })) } as never,
      undefined,
      { leaseOwner: "worker-1", leaseDurationMs: 1_000 },
    );

    expect(authorizationMocks.getForImport).not.toHaveBeenCalled();
    expect(authorizationMocks.closeUnopened).not.toHaveBeenCalled();
  });

  it.each(["issued", "settled"] as const)(
    "does not close a sealed parent in %s status",
    async (status) => {
      const { store } = processorStore();
      authorizationMocks.getForImport.mockResolvedValueOnce({
        ...claimedAuthorization,
        status,
      });

      await processDueWorkflowWorkItem(
        store as never,
        { run: vi.fn(async () => ({
          disposition: "failed",
          outcome: "failure",
          visitedNodeIds: ["execute"],
          context: {},
          reason: "terminal failure",
        })) } as never,
        undefined,
        { leaseOwner: "worker-1", leaseDurationMs: 1_000 },
      );

      expect(authorizationMocks.getForImport).toHaveBeenCalledOnce();
      expect(authorizationMocks.closeUnopened).not.toHaveBeenCalled();
    },
  );

  it("returns the closure diagnostic even when task logging is unavailable", async () => {
    const { logEntry, store } = processorStore();
    authorizationMocks.closeUnopened.mockRejectedValueOnce(new Error("closure failed"));
    logEntry.mockImplementationOnce(() => { throw new Error("task log failed"); });

    const result = await processDueWorkflowWorkItem(
      store as never,
      { run: vi.fn(async () => ({
        disposition: "failed",
        outcome: "failure",
        visitedNodeIds: ["execute"],
        context: {},
        reason: "terminal failure",
      })) } as never,
      undefined,
      { leaseOwner: "worker-1", leaseDurationMs: 1_000 },
    );

    expect(result.runtime?.reason).toBe("terminal failure");
    expect(result.diagnostics?.[0]).toContain(
      "[ccc-campaign:execution-authorization-closure-failed]",
    );
  });

  /*
   * A work item that ends `failed` or `cancelled` writes runtimeResult.reason to
   * the work item's lastError column and NOWHERE else. Reading that column needs
   * either the campaign idempotency key or database credentials, so an operator
   * watching logs sees the item die with no explanation at all. Observed twice
   * live against the R1 campaign: the only line emitted was the downstream
   * authorization cleanup, which reports `terminal=failed` without the reason.
   */
  it("surfaces the terminal reason for a failed work item instead of burying it in lastError", async () => {
    const { logEntry, store } = processorStore();
    const reason = "ccc-permanent:CCC_CAMPAIGN_IMPLEMENTATION_FAILED";

    const result = await processDueWorkflowWorkItem(
      store as never,
      { run: vi.fn(async () => ({
        disposition: "failed",
        outcome: "failure",
        visitedNodeIds: ["execute"],
        context: {},
        reason,
      })) } as never,
      undefined,
      { leaseOwner: "worker-1", leaseDurationMs: 1_000 },
    );

    const expected =
      `[ccc-campaign:work-item-terminal] workItem=${workItem.id} `
      + `terminal=failed reason=${reason}`;
    expect(result.diagnostics).toContain(expected);
    expect(logEntry).toHaveBeenCalledWith(workItem.taskId, expected);
  });

  it("says so explicitly when a failed work item carries no reason at all", async () => {
    const { logEntry, store } = processorStore();

    await processDueWorkflowWorkItem(
      store as never,
      { run: vi.fn(async () => ({
        disposition: "failed",
        outcome: "failure",
        visitedNodeIds: ["execute"],
        context: {},
      })) } as never,
      undefined,
      { leaseOwner: "worker-1", leaseDurationMs: 1_000 },
    );

    expect(logEntry).toHaveBeenCalledWith(
      workItem.taskId,
      `[ccc-campaign:work-item-terminal] workItem=${workItem.id} `
      + "terminal=failed reason=<none recorded>",
    );
  });

  it("stays quiet on the success path, so the diagnostic cannot become noise", async () => {
    const { logEntry, store } = processorStore();

    const result = await processDueWorkflowWorkItem(
      store as never,
      { run: vi.fn(async () => ({
        disposition: "completed",
        outcome: "success",
        visitedNodeIds: ["execute"],
        context: {},
      })) } as never,
      undefined,
      { leaseOwner: "worker-1", leaseDurationMs: 1_000 },
    );

    const emitted = [
      ...(result.diagnostics ?? []),
      ...logEntry.mock.calls.map((call) => String(call[1])),
    ];
    expect(emitted.some((line) => line.includes("[ccc-campaign:work-item-terminal]")))
      .toBe(false);
  });
});
