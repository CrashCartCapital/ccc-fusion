import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  getApprovalRequest,
  importCccPrdBundle,
  inspectCccPrdProductStatus,
  queryRunAuditEvents,
  type ApprovalRequest,
  type ApprovalRequestActorSnapshot,
  type CccPrdProductApprovalStatus,
  type CccPrdProtectedActionIntent,
  type Settings,
  type WorkflowIrNode,
} from "@fusion/core";
import {
  createCccPrdImportTestBundle,
  createCccPrdImportTestProductExecutionPolicy,
  rehashCccPrdImportTestBundle,
} from "../../../core/src/__test-utils__/ccc-prd-import-fixture.js";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
} from "../../../core/src/__test-utils__/pg-test-harness.js";
import * as productControl from "../ccc-campaign-product-control.js";
import { TaskExecutor } from "../executor.js";
import type { WorkflowNodeExecutionContext } from "../workflow-graph-executor.js";

const execFile = promisify(execFileCallback);
const pgTest = pgDescribe;

const OPERATOR: ApprovalRequestActorSnapshot = Object.freeze({
  actorId: "operator-live-execution-test",
  actorType: "user",
  actorName: "Live Execution Test Operator",
});

type LiveExecutionApprovalApi = Readonly<{
  issueCccCampaignLiveExecutionApproval(input: Readonly<{
    store: ReturnType<ReturnType<typeof createSharedPgTaskStoreTestHarness>["store"]>;
    rootDir: string;
    taskId: string;
    runId: string;
  }>): Promise<CccPrdProductApprovalStatus>;
  computeCccCampaignLiveExecutionApprovalConfirmation(
    approval: ApprovalRequest,
  ): string;
  approveCccCampaignLiveExecution(input: Readonly<{
    store: ReturnType<ReturnType<typeof createSharedPgTaskStoreTestHarness>["store"]>;
    rootDir: string;
    taskId: string;
    approvalRequestId: string;
    confirmation: string;
    actor: ApprovalRequestActorSnapshot;
  }>): Promise<CccPrdProductApprovalStatus>;
}>;

type LiveExecutionRequireApi = Readonly<{
  CCC_CAMPAIGN_LIVE_EXECUTION_APPROVAL_REQUIRED_CODE: string;
  CCC_CAMPAIGN_LIVE_EXECUTION_APPROVAL_REQUIRED_REASON: string;
  requireCccCampaignLiveExecutionApproval(input: Readonly<{
    store: ReturnType<ReturnType<typeof createSharedPgTaskStoreTestHarness>["store"]>;
    rootDir: string;
    taskId: string;
    runId: string;
  }>): Promise<CccPrdProductApprovalStatus>;
}>;

function liveExecutionApprovalApi(): LiveExecutionApprovalApi {
  const candidate = productControl as unknown as Partial<LiveExecutionApprovalApi>;
  expect(candidate.issueCccCampaignLiveExecutionApproval)
    .toBeTypeOf("function");
  expect(candidate.computeCccCampaignLiveExecutionApprovalConfirmation)
    .toBeTypeOf("function");
  expect(candidate.approveCccCampaignLiveExecution)
    .toBeTypeOf("function");
  return candidate as LiveExecutionApprovalApi;
}

function liveExecutionRequireApi(): LiveExecutionRequireApi {
  const candidate = productControl as unknown as Partial<LiveExecutionRequireApi>;
  expect(candidate.requireCccCampaignLiveExecutionApproval)
    .toBeTypeOf("function");
  expect(candidate.CCC_CAMPAIGN_LIVE_EXECUTION_APPROVAL_REQUIRED_CODE)
    .toBe("CCC_CAMPAIGN_LIVE_EXECUTION_APPROVAL_REQUIRED");
  expect(candidate.CCC_CAMPAIGN_LIVE_EXECUTION_APPROVAL_REQUIRED_REASON)
    .toBe("ccc-permanent:CCC_CAMPAIGN_LIVE_EXECUTION_APPROVAL_REQUIRED");
  return candidate as LiveExecutionRequireApi;
}

async function initializeGitRoot(rootDir: string): Promise<string> {
  await execFile("git", ["init", "--initial-branch=main", rootDir]);
  await execFile("git", ["-C", rootDir, "config", "user.name", "Fusion Test"]);
  await execFile("git", ["-C", rootDir, "config", "user.email", "fusion-test@example.invalid"]);
  await execFile("git", ["-C", rootDir, "commit", "--allow-empty", "-m", "base"]);
  return (await execFile("git", ["-C", rootDir, "rev-parse", "HEAD"], {
    encoding: "utf8",
  })).stdout.trim();
}

type FixtureMode = "live" | "two-live" | "wrong-action" | "missing-action";

pgTest("CCC campaign live-execution approval", () => {
  const h = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_ccc_live_execution_approval",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterAll(h.afterAll);

  async function importFixture(suffix: string, mode: FixtureMode = "live") {
    const rootDir = h.rootDir();
    const baseCommit = await initializeGitRoot(rootDir);
    const source = createCccPrdImportTestBundle(rootDir, suffix);
    const firstTask = source.tasks[0]!;
    const secondTask = source.tasks[1]!;
    const firstLiveAction = {
      id: `ACTION-${suffix}-LIVE-A`,
      kind: "live_execution" as const,
      target: `provider://${suffix}/task-a`,
      requiresOperatorDecision: true as const,
      operatorDecision: "approve_live_execution" as const,
      spans: [firstTask.spans[0]!],
    };
    const secondLiveAction = {
      id: `ACTION-${suffix}-LIVE-B`,
      kind: "live_execution" as const,
      target: `provider://${suffix}/task-b`,
      requiresOperatorDecision: true as const,
      operatorDecision: "approve_live_execution" as const,
      spans: [secondTask.spans[0]!],
    };
    const wrongAction = {
      id: `ACTION-${suffix}-MERGE`,
      kind: "merge" as const,
      target: "refs/heads/main",
      requiresOperatorDecision: true as const,
      operatorDecision: "approve_merge" as const,
      spans: [firstTask.spans[0]!],
    };
    const protectedActions: CccPrdProtectedActionIntent[] =
      mode === "live"
        ? [firstLiveAction]
        : mode === "two-live"
          ? [firstLiveAction, secondLiveAction]
          : mode === "wrong-action"
            ? [wrongAction]
            : [];
    const bundle = rehashCccPrdImportTestBundle({
      ...source,
      targetRepository: { path: rootDir, baseCommit },
      tasks: source.tasks.map((task) => {
        if (task.id === firstTask.id) {
          return {
            ...task,
            protectedActionIds:
              mode === "missing-action"
                ? []
                : [mode === "wrong-action" ? wrongAction.id : firstLiveAction.id],
          };
        }
        if (task.id === secondTask.id && mode === "two-live") {
          return { ...task, protectedActionIds: [secondLiveAction.id] };
        }
        return task;
      }),
      protectedActions,
    });
    const imported = await importCccPrdBundle({
      bundle,
      executionPolicy: createCccPrdImportTestProductExecutionPolicy(bundle),
      idempotencyKey: `live-execution-approval-${suffix}`,
      store: h.store(),
      layer: h.layer(),
      rootDir,
    });
    const idempotencyKey = `live-execution-approval-${suffix}`;
    const productStatus = await inspectCccPrdProductStatus({
      idempotencyKey,
      layer: h.layer(),
      rootDir,
    });
    if (!productStatus) throw new Error("missing live-execution product status");
    expect(productStatus.import.importId).toBe(imported.importId);
    const nativeBySemantic = new Map(
      productStatus.tasks.map(({ semanticTaskId, nativeTaskId }) => [
        semanticTaskId,
        nativeTaskId,
      ]),
    );
    const firstTaskId = nativeBySemantic.get(firstTask.id);
    const secondTaskId = nativeBySemantic.get(secondTask.id);
    expect(firstTaskId).toEqual(expect.any(String));
    expect(secondTaskId).toEqual(expect.any(String));
    expect(firstTaskId).not.toBe(firstTask.id);
    expect(secondTaskId).not.toBe(secondTask.id);
    const workItemId = `${imported.importId}--WORK-${suffix}`;
    const workItem = await h.store().getWorkflowWorkItem(workItemId);
    if (!workItem) throw new Error(`missing workflow work item ${workItemId}`);
    return {
      rootDir,
      imported,
      workItem,
      firstTaskId: firstTaskId as string,
      secondTaskId: secondTaskId as string,
      firstSemanticTaskId: firstTask.id,
      secondSemanticTaskId: secondTask.id,
      firstLiveAction,
      secondLiveAction,
    };
  }

  it("issues one immutable, idempotent, redacted approval without execution side effects", async () => {
    const api = liveExecutionApprovalApi();
    const fixture = await importFixture("issue");
    const beforeWorkItem = await h.store().getWorkflowWorkItem(fixture.workItem.id);

    const first = await api.issueCccCampaignLiveExecutionApproval({
      store: h.store(),
      rootDir: fixture.rootDir,
      taskId: fixture.firstTaskId,
      runId: "RUN-live-execution-issue",
    });
    const replay = await api.issueCccCampaignLiveExecutionApproval({
      store: h.store(),
      rootDir: fixture.rootDir,
      taskId: fixture.firstTaskId,
      runId: "RUN-live-execution-issue",
    });

    expect(first).toMatchObject({
      status: "issued",
      taskId: fixture.firstTaskId,
      actionId: fixture.firstLiveAction.id,
      actionTarget: fixture.firstLiveAction.target,
      targetAction: {
        category: "command_execution",
        action: fixture.firstLiveAction.id,
        resourceType: "ccc-campaign-live_execution",
        resourceId: fixture.firstLiveAction.target,
        context: {
          protectedActionKind: "live_execution",
          operatorDecision: "approve_live_execution",
        },
      },
      campaign: {
        binding: {
          importId: fixture.imported.importId,
          taskId: fixture.firstTaskId,
          actionId: fixture.firstLiveAction.id,
          actionTarget: fixture.firstLiveAction.target,
        },
      },
    });
    expect(replay).toEqual(first);
    expect(api.computeCccCampaignLiveExecutionApprovalConfirmation(first))
      .toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.stringify({
      approval: first,
      confirmation:
        api.computeCccCampaignLiveExecutionApprovalConfirmation(first),
    })).not.toContain("claimToken");
    await expect(api.issueCccCampaignLiveExecutionApproval({
      store: h.store(),
      rootDir: fixture.rootDir,
      taskId: fixture.firstTaskId,
      runId: "RUN-live-execution-issue-drifted",
    })).rejects.toThrow(/collision or drift/u);

    await expect(h.store().getWorkflowWorkItem(fixture.workItem.id))
      .resolves.toEqual(beforeWorkItem);
    await expect(h.store().getCccCampaignContextForTask(fixture.firstTaskId))
      .resolves.toMatchObject({ requestCount: 0, activeActionLeases: {} });
    const audits = await queryRunAuditEvents(h.layer().db, {
      taskId: fixture.firstTaskId,
    });
    expect(audits.filter(({ mutationType }) =>
      mutationType.startsWith("ccc-campaign:provider-attempt:"))).toEqual([]);
  });

  it("requires an exact claimed live-execution lease without exposing or performing the effect", async () => {
    const api = liveExecutionApprovalApi();
    const requiredApi = liveExecutionRequireApi();
    const fixture = await importFixture("required");
    const input = {
      store: h.store(),
      rootDir: fixture.rootDir,
      taskId: fixture.firstTaskId,
      runId: "RUN-live-execution-required",
    } as const;
    const beforeWorkItem = await h.store().getWorkflowWorkItem(fixture.workItem.id);

    await expect(requiredApi.requireCccCampaignLiveExecutionApproval(input))
      .rejects.toMatchObject({
        code: "CCC_CAMPAIGN_LIVE_EXECUTION_APPROVAL_REQUIRED",
      });
    await expect(requiredApi.requireCccCampaignLiveExecutionApproval(input))
      .rejects.toMatchObject({
        code: "CCC_CAMPAIGN_LIVE_EXECUTION_APPROVAL_REQUIRED",
      });

    const issued = await api.issueCccCampaignLiveExecutionApproval(input);
    expect(issued).toMatchObject({
      status: "issued",
      taskId: fixture.firstTaskId,
      actionId: fixture.firstLiveAction.id,
      actionTarget: fixture.firstLiveAction.target,
    });
    expect(JSON.stringify(issued)).not.toContain("claimToken");
    await expect(h.store().getCccCampaignContextForTask(fixture.firstTaskId))
      .resolves.toMatchObject({ requestCount: 0, activeActionLeases: {} });
    await expect(h.store().getWorkflowWorkItem(fixture.workItem.id))
      .resolves.toEqual(beforeWorkItem);
    const issuanceAudits = (await queryRunAuditEvents(h.layer().db, {
      taskId: fixture.firstTaskId,
    })).filter(({ mutationType }) => mutationType === "approval:issued");
    expect(issuanceAudits).toHaveLength(1);

    const confirmation =
      api.computeCccCampaignLiveExecutionApprovalConfirmation(issued);
    const claimed = await api.approveCccCampaignLiveExecution({
      store: h.store(),
      rootDir: fixture.rootDir,
      taskId: fixture.firstTaskId,
      approvalRequestId: issued.id,
      confirmation,
      actor: OPERATOR,
    });
    const exactLease = await h.store().inspectCccCampaignActionLease(
      fixture.firstTaskId,
      {
        actionId: fixture.firstLiveAction.id,
        actionTarget: fixture.firstLiveAction.target,
      },
    );
    if (!exactLease) throw new Error("missing exact claimed live-execution lease");
    const mismatchedBindingHash = "0".repeat(64);
    const inspectLease = vi.spyOn(
      h.store(),
      "inspectCccCampaignActionLease",
    ).mockResolvedValue({
      binding: {
        ...exactLease.binding,
        bindingHash: mismatchedBindingHash,
      },
      lease: {
        ...exactLease.lease,
        approvalRequestId: "ccc-approval-wrong-request",
        bindingHash: mismatchedBindingHash,
      },
    });
    await expect(requiredApi.requireCccCampaignLiveExecutionApproval(input))
      .rejects.toMatchObject({
        code: "CCC_CAMPAIGN_LIVE_EXECUTION_APPROVAL_REQUIRED",
      });
    inspectLease.mockRestore();

    const replay =
      await requiredApi.requireCccCampaignLiveExecutionApproval(input);
    expect(replay).toEqual(claimed);
    expect(JSON.stringify(replay)).not.toContain("claimToken");
    await expect(h.store().getWorkflowWorkItem(fixture.workItem.id))
      .resolves.toEqual(beforeWorkItem);
    await expect(h.store().getCccCampaignContextForTask(fixture.firstTaskId))
      .resolves.toMatchObject({ requestCount: 0 });
    const providerAudits = (await queryRunAuditEvents(h.layer().db, {
      taskId: fixture.firstTaskId,
    })).filter(({ mutationType }) =>
      mutationType.startsWith("ccc-campaign:provider-attempt:"));
    expect(providerAudits).toEqual([]);
  });

  it("parks the authoritative coding runner before provider dispatch until exact live approval is claimed", async () => {
    const api = liveExecutionApprovalApi();
    const fixture = await importFixture("runner-gate");
    const task = await h.store().getTask(fixture.firstTaskId);
    if (!task) throw new Error("missing imported live-execution task");
    const node: WorkflowIrNode = {
      id: "ccc-live-execution-node",
      kind: "prompt",
      config: {
        cccPrdTaskId: fixture.firstSemanticTaskId,
        executor: "model",
        toolMode: "coding",
        modelProvider: "deterministic-fake",
        modelId: "fixture-v2",
      },
    };
    const executionContext: WorkflowNodeExecutionContext = Object.freeze({
      task,
      settings: undefined,
      context: {},
      execution: Object.freeze({
        originTaskId: fixture.firstTaskId,
        semanticTaskId: fixture.firstSemanticTaskId,
        nativeTaskId: fixture.firstTaskId,
        semanticTask: task,
        runId: fixture.workItem.runId,
        visitIdentity: Object.freeze({
          nodeId: node.id,
          materializedNodeId: node.id,
        }),
        executionFence: Object.freeze({
          workItemId: fixture.workItem.id,
          leaseOwner: "runner-gate-owner",
          attempt: 1,
          runId: fixture.workItem.runId,
        }),
      }),
    });
    const executor = new TaskExecutor(h.store(), fixture.rootDir);
    const providerEffect = vi.spyOn(
      executor as never,
      "runGraphCustomNode" as never,
    ).mockResolvedValue({ outcome: "failure", value: "provider-ran" } as never);
    const runner =
      executor.createAuthoritativeWorkflowCustomNodeRunner({} as Settings);

    await expect(runner(node, task, {}, executionContext)).rejects.toMatchObject({
      code: "CCC_CAMPAIGN_LIVE_EXECUTION_APPROVAL_REQUIRED",
    });
    expect(providerEffect).not.toHaveBeenCalled();
    const issued = await api.issueCccCampaignLiveExecutionApproval({
      store: h.store(),
      rootDir: fixture.rootDir,
      taskId: fixture.firstTaskId,
      runId: fixture.workItem.runId,
    });
    const confirmation =
      api.computeCccCampaignLiveExecutionApprovalConfirmation(issued);
    await api.approveCccCampaignLiveExecution({
      store: h.store(),
      rootDir: fixture.rootDir,
      taskId: fixture.firstTaskId,
      approvalRequestId: issued.id,
      confirmation,
      actor: OPERATOR,
    });

    await expect(runner(node, task, {}, executionContext)).resolves.toMatchObject({
      outcome: "failure",
      value: "provider-ran",
    });
    expect(providerEffect).toHaveBeenCalledTimes(1);
  });

  it("refuses missing and non-live declared actions", async () => {
    const api = liveExecutionApprovalApi();
    const missing = await importFixture("missing-action", "missing-action");

    await expect(api.issueCccCampaignLiveExecutionApproval({
      store: h.store(),
      rootDir: missing.rootDir,
      taskId: missing.firstTaskId,
      runId: "RUN-missing-live-execution-action",
    })).rejects.toMatchObject({
      code: "CCC_CAMPAIGN_LIVE_EXECUTION_ACTION_REFUSED",
    });
  });

  it("refuses the wrong protected-action kind as live execution", async () => {
    const api = liveExecutionApprovalApi();
    const wrong = await importFixture("wrong-action", "wrong-action");

    await expect(api.issueCccCampaignLiveExecutionApproval({
      store: h.store(),
      rootDir: wrong.rootDir,
      taskId: wrong.firstTaskId,
      runId: "RUN-wrong-live-execution-action",
    })).rejects.toMatchObject({
      code: "CCC_CAMPAIGN_LIVE_EXECUTION_ACTION_REFUSED",
    });
  });

  it("refuses a wrong task/action binding and a stale digest before any claim", async () => {
    const api = liveExecutionApprovalApi();
    const fixture = await importFixture("binding", "two-live");
    const approval = await api.issueCccCampaignLiveExecutionApproval({
      store: h.store(),
      rootDir: fixture.rootDir,
      taskId: fixture.firstTaskId,
      runId: "RUN-live-execution-binding",
    });
    const confirmation =
      api.computeCccCampaignLiveExecutionApprovalConfirmation(approval);
    const beforeWorkItem = await h.store().getWorkflowWorkItem(fixture.workItem.id);

    await expect(api.approveCccCampaignLiveExecution({
      store: h.store(),
      rootDir: fixture.rootDir,
      taskId: fixture.secondTaskId,
      approvalRequestId: approval.id,
      confirmation,
      actor: OPERATOR,
    })).rejects.toMatchObject({
      code: "CCC_CAMPAIGN_LIVE_EXECUTION_APPROVAL_DRIFT",
    });
    await expect(api.approveCccCampaignLiveExecution({
      store: h.store(),
      rootDir: fixture.rootDir,
      taskId: fixture.firstTaskId,
      approvalRequestId: approval.id,
      confirmation: "0".repeat(64),
      actor: OPERATOR,
    })).rejects.toMatchObject({
      code: "CCC_CAMPAIGN_LIVE_EXECUTION_CONFIRMATION_REFUSED",
    });

    await expect(getApprovalRequest(h.layer().db, approval.id))
      .resolves.toMatchObject({ status: "issued" });
    await expect(h.store().getCccCampaignContextForTask(fixture.firstTaskId))
      .resolves.toMatchObject({ requestCount: 0, activeActionLeases: {} });
    await expect(h.store().getCccCampaignContextForTask(fixture.secondTaskId))
      .resolves.toMatchObject({ requestCount: 0, activeActionLeases: {} });
    await expect(h.store().getWorkflowWorkItem(fixture.workItem.id))
      .resolves.toEqual(beforeWorkItem);
    const audits = await queryRunAuditEvents(h.layer().db, {
      taskId: fixture.firstTaskId,
    });
    expect(audits.filter(({ mutationType }) =>
      mutationType.startsWith("ccc-campaign:provider-attempt:"))).toEqual([]);
  });

  it("claims only the exact live-execution lease and returns no hidden claim material", async () => {
    const api = liveExecutionApprovalApi();
    const fixture = await importFixture("claim");
    const approval = await api.issueCccCampaignLiveExecutionApproval({
      store: h.store(),
      rootDir: fixture.rootDir,
      taskId: fixture.firstTaskId,
      runId: "RUN-live-execution-claim",
    });
    const confirmation =
      api.computeCccCampaignLiveExecutionApprovalConfirmation(approval);
    const beforeWorkItem = await h.store().getWorkflowWorkItem(fixture.workItem.id);
    const providerAuditsBefore = (await queryRunAuditEvents(h.layer().db, {
      taskId: fixture.firstTaskId,
    })).filter(({ mutationType }) =>
      mutationType.startsWith("ccc-campaign:provider-attempt:"));

    const claimed = await api.approveCccCampaignLiveExecution({
      store: h.store(),
      rootDir: fixture.rootDir,
      taskId: fixture.firstTaskId,
      approvalRequestId: approval.id,
      confirmation,
      actor: OPERATOR,
    });
    await expect(api.approveCccCampaignLiveExecution({
      store: h.store(),
      rootDir: `${fixture.rootDir}-stale`,
      taskId: fixture.firstTaskId,
      approvalRequestId: approval.id,
      confirmation,
      actor: OPERATOR,
    })).rejects.toMatchObject({
      code: "CCC_CAMPAIGN_LIVE_EXECUTION_CUSTODY_REFUSED",
    });
    const replay = await api.approveCccCampaignLiveExecution({
      store: h.store(),
      rootDir: fixture.rootDir,
      taskId: fixture.firstTaskId,
      approvalRequestId: approval.id,
      confirmation,
      actor: OPERATOR,
    });
    const persisted = await getApprovalRequest(h.layer().db, approval.id);
    const lease = await h.store().inspectCccCampaignActionLease(
      fixture.firstTaskId,
      {
        actionId: fixture.firstLiveAction.id,
        actionTarget: fixture.firstLiveAction.target,
      },
    );

    expect(claimed).toMatchObject({
      status: "claimed",
      actionId: fixture.firstLiveAction.id,
      actionTarget: fixture.firstLiveAction.target,
    });
    expect(replay).toEqual(claimed);
    expect(JSON.stringify(claimed)).not.toContain("claimToken");
    expect(persisted).toMatchObject({
      id: approval.id,
      status: "claimed",
      campaign: {
        binding: {
          bindingHash: claimed.campaign.binding.bindingHash,
          actionId: fixture.firstLiveAction.id,
          actionTarget: fixture.firstLiveAction.target,
        },
        claimToken: expect.any(String),
      },
    });
    expect(lease).toMatchObject({
      binding: {
        bindingHash: claimed.campaign.binding.bindingHash,
      },
      lease: {
        approvalRequestId: approval.id,
        claimToken: persisted?.campaign?.claimToken,
        actionId: fixture.firstLiveAction.id,
        actionTarget: fixture.firstLiveAction.target,
        bindingHash: claimed.campaign.binding.bindingHash,
      },
    });
    await expect(h.store().getWorkflowWorkItem(fixture.workItem.id))
      .resolves.toEqual(beforeWorkItem);
    await expect(h.store().getCccCampaignContextForTask(fixture.firstTaskId))
      .resolves.toMatchObject({ requestCount: 0 });
    const providerAuditsAfter = (await queryRunAuditEvents(h.layer().db, {
      taskId: fixture.firstTaskId,
    })).filter(({ mutationType }) =>
      mutationType.startsWith("ccc-campaign:provider-attempt:"));
    expect(providerAuditsAfter).toEqual(providerAuditsBefore);

    const issueReplay = await api.issueCccCampaignLiveExecutionApproval({
      store: h.store(),
      rootDir: fixture.rootDir,
      taskId: fixture.firstTaskId,
      runId: "RUN-live-execution-claim",
    });
    expect(issueReplay).toEqual(claimed);
    expect(JSON.stringify(issueReplay)).not.toContain("claimToken");
  });
});
