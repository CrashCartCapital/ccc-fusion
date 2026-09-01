import { createHash } from "node:crypto";
import type { CccCampaignTaskContext, RunAuditEventInput, Settings, TaskDetail, WorkflowIr, WorkflowIrArtifact, WorkflowIrNode, WorkflowWorkItem, WorkflowWorkItemState } from "@fusion/core";
import {
  canonicalCccPrdJson,
  getBuiltinWorkflow,
  isBuiltinWorkflowId,
  parseWorkflowIr,
  type WorkflowIrResolverStore,
} from "@fusion/core";

import {
  CCC_BRANCH_PERSISTENCE_ERROR_CONTEXT_KEY,
  CCC_BRANCH_PERSISTENCE_FAILURE_CONTEXT_KEY,
  CCC_RETRY_CLASSIFICATION_CONTEXT_KEY,
  WorkflowGraphExecutor,
  type WorkflowNodeExecutionFence,
  type WorkflowGraphExecutorDeps,
  type WorkflowNodeHandler,
  type WorkflowNodeOutcome,
} from "./workflow-graph-executor.js";
import {
  WORKFLOW_ID_CONTEXT_KEY,
  WORKFLOW_RUN_ID_CONTEXT_KEY,
  createDefaultNodeHandlers,
  createNoopLegacySeams,
  type WorkflowCustomNodeRunner,
} from "./workflow-node-handlers.js";
import type { WorkflowRuntimePrimitives } from "./runtime-primitives.js";
import { ensureWorkflowCompletionSummary } from "./workflow-completion-summary.js";
import { requiresNonEmptyWorkflowArtifact } from "./required-workflow-artifacts.js";
import { PermanentError, TransientError } from "./engine-errors.js";
import {
  createCccCampaignProofNodeAdmission,
  type CccCampaignProofNodeAdmission,
} from "./ccc-campaign-proof-workflow.js";
import {
  isCccCampaignTask,
  isImportedCccCampaignTask,
  isImportedCccCampaignWorkItem,
} from "./ccc-campaign-routing.js";

export type WorkflowTaskRuntimeDisposition = "completed" | "failed" | "manual-required" | "cancelled";

export interface WorkflowWorkItemFence {
  workItemId: string;
  leaseOwner: string;
  attempt: number;
  runId: string;
  eventTimestamp: string;
  /** Exact canonical native workflow IR admitted by the importer. */
  irHash?: string;
}

export interface WorkflowTaskRuntimeRunOptions {
  signal?: AbortSignal;
  workItemFence?: WorkflowWorkItemFence;
  deferCompletionSummary?: boolean;
}

export interface WorkflowTaskRuntimeResult {
  disposition: WorkflowTaskRuntimeDisposition;
  outcome: WorkflowNodeOutcome;
  visitedNodeIds: string[];
  context: Record<string, unknown>;
  reason?: string;
}

export function graphFailureReason(result: {
  visitedNodeIds: readonly string[];
  context: Readonly<Record<string, unknown>>;
}): string {
  const branchPersistenceFailure = result.context[CCC_BRANCH_PERSISTENCE_FAILURE_CONTEXT_KEY];
  if (typeof branchPersistenceFailure === "string" && branchPersistenceFailure.trim().length > 0) {
    const branchPersistenceError = result.context[CCC_BRANCH_PERSISTENCE_ERROR_CONTEXT_KEY];
    return typeof branchPersistenceError === "string" && branchPersistenceError.trim().length > 0
      ? `${branchPersistenceFailure.trim()}:${branchPersistenceError.trim()}`
      : branchPersistenceFailure.trim();
  }

  let failedNodeId: string | undefined;
  for (const nodeId of [...result.visitedNodeIds].reverse()) {
    if (result.context[`node:${nodeId}:outcome`] !== "failure") continue;
    failedNodeId ??= nodeId;
    const error = result.context[`node:${nodeId}:error`];
    if (typeof error === "string" && error.trim().length > 0) {
      return `workflow-node-error:${nodeId}:${error.trim()}`;
    }
    const value = result.context[`node:${nodeId}:value`];
    if (typeof value === "string" && value.trim().length > 0) {
      return `workflow-node-failed:${nodeId}:${value.trim()}`;
    }
  }
  for (const [key, value] of Object.entries(result.context).reverse()) {
    const match = /^node:(.+):error$/u.exec(key);
    if (
      match
      && typeof value === "string"
      && value.trim().length > 0
      && result.context[`node:${match[1]}:outcome`] === "failure"
    ) {
      return `workflow-node-error:${match[1]}:${value.trim()}`;
    }
  }
  if (failedNodeId) return `workflow-node-failed:${failedNodeId}`;

  const nodeState = Object.fromEntries(
    Object.entries(result.context)
      .filter(([key, value]) =>
        /^node:.+:(?:outcome|value|error)$/u.test(key)
        && (value === null || ["string", "number", "boolean"].includes(typeof value)))
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(-12)
      .map(([key, value]) => [
        key,
        typeof value === "string" && value.length > 240
          ? `${value.slice(0, 237)}...`
          : value,
      ]),
  );
  return `workflow-graph-failed:${JSON.stringify({
    visitedNodeIds: result.visitedNodeIds.slice(-12),
    nodeState,
  })}`;
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalDigest(value: unknown): string {
  return sha256Text(canonicalCccPrdJson(value));
}

function importedProductRouteFromNode(node: WorkflowIrNode): Record<string, unknown> | null {
  const config = node.config;
  if (
    !config
    || typeof config.cccPrdTaskId !== "string"
    || typeof config.cccExecutionProviderId !== "string"
    || typeof config.cccExecutionModelId !== "string"
    || (config.cccExecutionTransport !== "pi" && config.cccExecutionTransport !== "cli")
    || (config.executor !== "model" && config.executor !== "cli-agent")
    || config.toolMode !== "coding"
    || config.worktreeMode !== "isolated"
    || !Array.isArray(config.ownedPaths)
    || config.ownedPaths.some((path) => typeof path !== "string")
    || !Array.isArray(config.allowedWriteRoots)
    || config.allowedWriteRoots.some((path) => typeof path !== "string")
    || config.commitPolicy !== "required"
    || (config.cliAdapterId !== undefined && typeof config.cliAdapterId !== "string")
    || (
      config.cccExecutionReceiptAdapterId !== undefined
      && config.cccExecutionReceiptAdapterId !== "terminal-route-sse-comments.v1"
    )
    || (
      config.cccExecutionTerminalRouteMembers !== undefined
      && !Array.isArray(config.cccExecutionTerminalRouteMembers)
    )
  ) {
    return null;
  }
  return {
    taskId: config.cccPrdTaskId,
    providerId: config.cccExecutionProviderId,
    modelId: config.cccExecutionModelId,
    transport: config.cccExecutionTransport,
    executor: config.executor,
    toolMode: config.toolMode,
    worktreeMode: config.worktreeMode,
    ownedPaths: [...config.ownedPaths],
    allowedWriteRoots: [...config.allowedWriteRoots],
    commitPolicy: config.commitPolicy,
    ...(config.cliAdapterId !== undefined
      ? { cliAdapterId: config.cliAdapterId }
      : {}),
    ...(config.cccExecutionReceiptAdapterId !== undefined
      ? { receiptAdapterId: config.cccExecutionReceiptAdapterId }
      : {}),
    ...(config.cccExecutionTerminalRouteMembers !== undefined
      ? {
        terminalRouteMembers: config.cccExecutionTerminalRouteMembers.map((member) => (
          member && typeof member === "object" && !Array.isArray(member)
            ? { ...(member as Record<string, unknown>) }
            : member
        )),
      }
      : {}),
  };
}

export interface WorkflowTaskRuntimeDeps extends Omit<WorkflowGraphExecutorDeps, "seams" | "runCustomNode" | "executionFence"> {
  store: WorkflowIrResolverStore & {
    getTask?: (taskId: string) => Promise<TaskDetail>;
    getTaskDocument?: (taskId: string, key: string) => Promise<unknown | null>;
    updateTask?: (taskId: string, updates: { summary: string }) => Promise<unknown> | unknown;
    logEntry?: (taskId: string, action: string, detail?: string) => Promise<unknown> | unknown;
    getCccCampaignContextForTask?: (
      taskId: string,
    ) => CccCampaignTaskContext | null | Promise<CccCampaignTaskContext | null>;
    assertCccCampaignWorkflowLeaseFence?: (input: {
      workItemId: string;
      originTaskId: string;
      leaseOwner: string;
      attempt: number;
      runId: string;
    }) => Promise<void> | void;
    transitionWorkflowWorkItem?: (
      id: string,
      state: WorkflowWorkItemState,
      patch?: { now?: string; expectedState?: WorkflowWorkItemState; expectedLeaseOwner?: string | null; expectedAttempt?: number; attempt?: number; lastError?: string | null; blockedReason?: string | null; leaseOwner?: string | null; leaseExpiresAt?: string | null },
    ) => WorkflowWorkItem | Promise<WorkflowWorkItem>;
    recordRunAuditEvent?: (input: RunAuditEventInput) => Promise<unknown> | unknown;
    recordFencedCccCampaignProofAudit?: (input: {
      workItemId: string;
      originTaskId: string;
      leaseOwner: string;
      attempt: number;
      runId: string;
      event: RunAuditEventInput;
    }) => Promise<unknown> | unknown;
  };
  primitives: WorkflowRuntimePrimitives;
  runCustomNode: WorkflowCustomNodeRunner;
  /**
   * Campaign-only live-provider gate. The runtime invokes this during graph
   * admission, before provider preflight or worktree preparation.
   */
  requireCccCampaignLiveExecutionApproval?: (input: {
    taskId: string;
    runId: string;
  }) => Promise<unknown>;
  /** Campaign-only executor for the final PRD proof-suite gate. */
  runCccProofSuite?: WorkflowNodeHandler;
  onEvent?: (event: { type: "start" | "terminal"; taskId: string; detail: string }) => void;
}

type WorkflowTaskRuntimeRunOptionsSnapshot = Readonly<{
  signal?: AbortSignal;
  workItemFence?: WorkflowWorkItemFence;
  deferCompletionSummary?: boolean;
}>;

function snapshotWorkItemFence(fence: WorkflowWorkItemFence | undefined): WorkflowWorkItemFence | undefined {
  if (!fence) return undefined;
  return Object.freeze({
    workItemId: fence.workItemId,
    leaseOwner: fence.leaseOwner,
    attempt: fence.attempt,
    runId: fence.runId,
    eventTimestamp: fence.eventTimestamp,
    irHash: fence.irHash,
  });
}

function snapshotRunOptions(options: WorkflowTaskRuntimeRunOptions): WorkflowTaskRuntimeRunOptionsSnapshot {
  return Object.freeze({
    signal: options.signal,
    workItemFence: snapshotWorkItemFence(options.workItemFence),
    deferCompletionSummary: options.deferCompletionSummary,
  });
}

function createGraphExecutionFence(fence: WorkflowWorkItemFence): WorkflowNodeExecutionFence {
  return Object.freeze({
    workItemId: fence.workItemId,
    leaseOwner: fence.leaseOwner,
    attempt: fence.attempt,
    runId: fence.runId,
  });
}

const CCC_PERMANENT_WORK_ITEM_ERROR_MAX_CHARS = 512;

export function formatCccPermanentWorkItemError(
  reason: string,
  error: PermanentError,
): string {
  const detail = error.message.replace(/\s+/gu, " ").trim();
  if (detail.length === 0) return reason;
  const prefix = `${reason}: `;
  return `${prefix}${detail.slice(
    0,
    Math.max(0, CCC_PERMANENT_WORK_ITEM_ERROR_MAX_CHARS - prefix.length),
  )}`;
}

/**
 * WorkflowTaskRuntime is the workflow-engine execution facade.
 *
 * It always resolves a task to a workflow IR: explicit selections resolve only
 * to their selected workflow, and tasks without a selection resolve to the
 * built-in coding workflow. This is intentionally different from
 * `WorkflowGraphTaskRunner`, whose current contract still models "no selection"
 * as legacy fallback.
 */
export class WorkflowTaskRuntime {
  public constructor(private readonly deps: WorkflowTaskRuntimeDeps) {}

  private emit(type: "start" | "terminal", taskId: string, detail: string): void {
    try {
      this.deps.onEvent?.({ type, taskId, detail });
    } catch {
      // Diagnostics must never affect execution.
    }
  }

  public async run(
    task: TaskDetail,
    settings: (Pick<Settings, "experimentalFeatures"> & Partial<Settings>) | undefined,
    options: WorkflowTaskRuntimeRunOptions = {},
  ): Promise<WorkflowTaskRuntimeResult> {
    const runOptions = snapshotRunOptions(options);
    const campaignCustody = await this.campaignCustodyAdmission(task, runOptions);
    if (campaignCustody.refusal) return campaignCustody.refusal;
    const campaignFenceRefusal = await this.campaignFenceRefusal(task, runOptions);
    if (campaignFenceRefusal) return campaignFenceRefusal;
    this.emit("start", task.id, "resolve-workflow");

    let target: WorkflowRuntimeTarget;
    try {
      target = await this.resolveRuntimeTarget(task.id);
    } catch (err) {
      const reason = `workflow-resolution-error: ${err instanceof Error ? err.message : String(err)}`;
      this.emit("terminal", task.id, `failed:${reason}`);
      return {
        disposition: "failed",
        outcome: "failure",
        visitedNodeIds: [],
        context: {},
        reason,
      };
    }

    const importedExecutionRefusal = this.importedCampaignExecutionRefusal(
      task,
      runOptions,
      target,
      campaignCustody.context,
    );
    if (importedExecutionRefusal) return importedExecutionRefusal;

    const runtimeRunId = runOptions.workItemFence?.runId ?? this.deps.runId ?? `${task.id}:${target.workflowId}`;
    const invoked: string[] = [];
    const campaignProofAdmission = this.campaignProofAdmission(task, runOptions);
    const campaignLiveExecutionAdmission = this.campaignLiveExecutionAdmission(runOptions);
    const graphExecutionFence = runOptions.workItemFence
      ? createGraphExecutionFence(runOptions.workItemFence)
      : undefined;
    const {
      store: _store,
      onEvent: _onEvent,
      resolveNodeExecution: ordinaryResolveNodeExecution,
      resolveNodeProviderController: ordinaryResolveNodeProviderController,
      admitNodeExecution: ordinaryAdmitNodeExecution,
      executionFence: _executionFence,
      ...graphDeps
    } = this.deps as WorkflowTaskRuntimeDeps & { executionFence?: unknown };
    const fencedCampaignRun = runOptions.workItemFence !== undefined;
    const executor = new WorkflowGraphExecutor({
      ...graphDeps,
      primitives: this.deps.primitives,
      handlers: this.recordingHandlers(invoked),
      ...(fencedCampaignRun
        ? {
            resolveNodeExecution: this.campaignNodeExecutionResolver(task),
            // Presence is the native campaign enforcement marker. A missing
            // producer remains a closed capability, not an ordinary plugin run.
            resolveNodeProviderController: async (input) =>
              ordinaryResolveNodeProviderController?.(input),
            admitNodeExecution: async (node, semanticTask, signal, visitIdentity, execution) => {
              await campaignProofAdmission?.(node, signal, execution && visitIdentity
                ? { semanticTask, visitIdentity, execution }
                : undefined);
              await campaignLiveExecutionAdmission(node, execution);
            },
            executionFence: graphExecutionFence,
          }
        : {
            ...(ordinaryResolveNodeExecution ? { resolveNodeExecution: ordinaryResolveNodeExecution } : {}),
            ...(ordinaryResolveNodeProviderController
              ? { resolveNodeProviderController: ordinaryResolveNodeProviderController }
              : {}),
            ...(ordinaryAdmitNodeExecution ? { admitNodeExecution: ordinaryAdmitNodeExecution } : {}),
          }),
      // WorkflowTaskRuntime is the execution engine, so internally the graph
      // executor is authoritative even before the old feature flag plumbing is
      // deleted from legacy entry points.
      runId: runtimeRunId,
      signal: runOptions.signal,
    });

    const runtimeSettings = buildWorkflowRuntimeSettings(settings);
    let result: Awaited<ReturnType<WorkflowGraphExecutor["run"]>>;
    try {
      result = await executor.run(task, runtimeSettings, target.ir);
    } catch (err) {
      const reason = `workflow-execution-error: ${err instanceof Error ? err.message : String(err)}`;
      this.emit("terminal", task.id, `failed:${reason}`);
      return {
        disposition: "failed",
        outcome: "failure",
        visitedNodeIds: invoked,
        context: {},
        reason,
      };
    }
    if (runOptions.signal?.aborted && result.outcome === "success") {
      const reason = "workflow-aborted";
      this.emit("terminal", task.id, `failed:${reason}`);
      return {
        disposition: "failed",
        outcome: "failure",
        visitedNodeIds: result.visitedNodeIds,
        context: result.context,
        reason,
      };
    }
    if (result.outcome === "success") {
      const missingArtifactKeys = await this.findMissingRequiredArtifacts(task.id, target.ir);
      if (runOptions.signal?.aborted) {
        const reason = "workflow-aborted";
        this.emit("terminal", task.id, `failed:${reason}`);
        return {
          disposition: "failed",
          outcome: "failure",
          visitedNodeIds: result.visitedNodeIds,
          context: result.context,
          reason,
        };
      }
      if (missingArtifactKeys.length > 0) {
        const reason = `workflow-required-artifacts-missing:${missingArtifactKeys.join(",")}`;
        const context = {
          ...result.context,
          "workflow:required-artifacts:missing": missingArtifactKeys,
        };
        this.emit("terminal", task.id, `failed:${reason}`);
        return {
          disposition: "failed",
          outcome: "failure",
          visitedNodeIds: result.visitedNodeIds,
          context,
          reason,
        };
      }
      if (!runOptions.deferCompletionSummary) {
        const latestTask = await this.deps.store.getTask?.(task.id).catch(() => undefined);
        await ensureWorkflowCompletionSummary(this.deps.store, latestTask ?? task, {
          reason: "workflow-runtime-completed",
          workflowId: target.workflowId,
          runId: runtimeRunId,
        }).catch(() => undefined);
      }
    }

    const retryClassification = result.context[CCC_RETRY_CLASSIFICATION_CONTEXT_KEY];
    const permanentCampaignReason =
      result.outcome === "failure"
      && typeof retryClassification === "string"
      && retryClassification.startsWith("ccc-permanent:")
        ? retryClassification
        : undefined;
    const disposition: WorkflowTaskRuntimeDisposition = result.outcome === "success"
      ? "completed"
      : permanentCampaignReason
        ? "manual-required"
        : "failed";
    this.emit("terminal", task.id, disposition);
    const reason = permanentCampaignReason
      ?? (result.outcome === "failure" && runOptions.signal?.aborted
        ? "workflow-aborted"
        : result.outcome === "failure"
          ? graphFailureReason(result)
          : undefined);
    return {
      disposition,
      outcome: result.outcome,
      visitedNodeIds: result.visitedNodeIds,
      context: result.context,
      ...(reason ? { reason } : {}),
    };
  }

  private async campaignCustodyAdmission(
    task: TaskDetail,
    options: WorkflowTaskRuntimeRunOptions,
  ): Promise<{
    context: CccCampaignTaskContext | null;
    refusal?: WorkflowTaskRuntimeResult;
  }> {
    const importedTask = isImportedCccCampaignTask(task);
    const fencedInvocation = options.workItemFence !== undefined;
    const getContext = this.deps.store.getCccCampaignContextForTask;
    if (typeof getContext !== "function") {
      return {
        context: null,
        ...(importedTask || fencedInvocation
          ? { refusal: this.campaignCustodyFailure(task.id, "ccc-campaign-custody-lookup-unwired") }
          : {}),
      };
    }
    let context: CccCampaignTaskContext | null;
    try {
      context = await getContext.call(this.deps.store, task.id);
    } catch {
      return {
        context: null,
        ...(importedTask || fencedInvocation
          ? { refusal: this.campaignCustodyFailure(task.id, "ccc-campaign-custody-lookup-error") }
          : {}),
      };
    }
    if (context && !options.workItemFence) {
      return {
        context,
        refusal: this.campaignCustodyFailure(task.id, "ccc-campaign-work-item-fence-required"),
      };
    }
    return {
      context,
      ...((importedTask || fencedInvocation) && !context
        ? { refusal: this.campaignCustodyFailure(task.id, "ccc-campaign-custody-missing") }
        : {}),
    };
  }

  private campaignCustodyFailure(taskId: string, reason: string): WorkflowTaskRuntimeResult {
    this.emit("terminal", taskId, `failed:${reason}`);
    return {
      disposition: "failed",
      outcome: "failure",
      visitedNodeIds: [],
      context: {},
      reason,
    };
  }

  private campaignManualRequired(taskId: string, reason: string): WorkflowTaskRuntimeResult {
    this.emit("terminal", taskId, `manual-required:${reason}`);
    return {
      disposition: "manual-required",
      outcome: "failure",
      visitedNodeIds: [],
      context: {
        [CCC_RETRY_CLASSIFICATION_CONTEXT_KEY]: reason,
      },
      reason,
    };
  }

  private importedCampaignExecutionRefusal(
    task: TaskDetail,
    options: WorkflowTaskRuntimeRunOptions,
    target: WorkflowRuntimeTarget,
    context: CccCampaignTaskContext | null,
  ): WorkflowTaskRuntimeResult | undefined {
    if (!isImportedCccCampaignTask(task)) return undefined;
    const admittedIrHash = options.workItemFence?.irHash;
    if (
      typeof admittedIrHash !== "string"
      || !/^[0-9a-f]{64}$/u.test(admittedIrHash)
      || canonicalDigest(target.ir) !== admittedIrHash
    ) {
      return this.campaignManualRequired(
        task.id,
        "ccc-permanent:CCC_CAMPAIGN_NATIVE_IR_DRIFT",
      );
    }
    if (context?.executionPolicy.schema !== "ccc-campaign.execution-policy.v2") {
      return undefined;
    }
    const custody = context.executionCustody;
    if (!custody || canonicalDigest(context.route) !== custody.routeSha256) {
      return this.campaignManualRequired(
        task.id,
        "ccc-permanent:CCC_CAMPAIGN_EXECUTION_CUSTODY_DRIFT",
      );
    }
    const matchingNodes = target.ir.nodes.filter((node) =>
      node.kind === "prompt"
      && node.config?.cccPrdTaskId === context.semanticTaskId
      && node.config?.cccNativeTaskId === context.taskId
      && typeof node.config?.cccExecutionPromptSha256 === "string");
    if (matchingNodes.length !== 1) {
      return this.campaignManualRequired(
        task.id,
        "ccc-permanent:CCC_CAMPAIGN_EXECUTION_CUSTODY_DRIFT",
      );
    }
    const node = matchingNodes[0]!;
    const prompt = node.config?.prompt;
    const route = importedProductRouteFromNode(node);
    if (
      typeof prompt !== "string"
      || node.config?.cccExecutionPromptSchema !== custody.promptSchema
      || node.config?.cccExecutionPromptSha256 !== custody.promptSha256
      || sha256Text(prompt) !== custody.promptSha256
      || node.config?.cccExecutionRouteSha256 !== custody.routeSha256
      || !route
      || canonicalDigest(route) !== custody.routeSha256
    ) {
      return this.campaignManualRequired(
        task.id,
        "ccc-permanent:CCC_CAMPAIGN_EXECUTION_CUSTODY_DRIFT",
      );
    }
    return undefined;
  }

  private async campaignFenceRefusal(
    task: TaskDetail,
    options: WorkflowTaskRuntimeRunOptions,
  ): Promise<WorkflowTaskRuntimeResult | undefined> {
    const fence = options.workItemFence;
    if (!fence) return undefined;
    const assertFence = this.deps.store.assertCccCampaignWorkflowLeaseFence;
    if (typeof assertFence !== "function") {
      return this.campaignCustodyFailure(task.id, "ccc-campaign-work-item-fence-validator-unwired");
    }
    try {
      await assertFence.call(this.deps.store, {
        workItemId: fence.workItemId,
        originTaskId: task.id,
        leaseOwner: fence.leaseOwner,
        attempt: fence.attempt,
        runId: fence.runId,
      });
      return undefined;
    } catch {
      return this.campaignCustodyFailure(task.id, "ccc-campaign-work-item-fence-refused");
    }
  }

  private campaignProofAdmission(
    task: TaskDetail,
    options: WorkflowTaskRuntimeRunOptions,
  ): CccCampaignProofNodeAdmission | undefined {
    if (!options.workItemFence) return undefined;
    const getContext = this.deps.store.getCccCampaignContextForTask;
    const recordAudit = this.deps.store.recordFencedCccCampaignProofAudit;
    if (typeof getContext !== "function" || typeof recordAudit !== "function") {
      return async () => {
        throw new PermanentError(
          "CCC campaign proof admission store is unwired",
          "CCC_PROOF_ADMISSION_REFUSED",
        );
      };
    }
    return createCccCampaignProofNodeAdmission({
      store: {
        getCccCampaignContextForTask: (taskId) =>
          getContext.call(this.deps.store, taskId),
        recordFencedCccCampaignProofAudit: (input) =>
          recordAudit.call(this.deps.store, input),
      },
      originTaskId: task.id,
      fence: options.workItemFence,
      requireExecutionBinding: true,
    });
  }

  private campaignLiveExecutionAdmission(
    options: WorkflowTaskRuntimeRunOptions,
  ): (
    node: WorkflowIrNode,
    execution: Parameters<NonNullable<WorkflowGraphExecutorDeps["admitNodeExecution"]>>[4],
  ) => Promise<void> {
    return async (node, execution) => {
      const config = node.config;
      if (
        !options.workItemFence
        || !execution?.executionFence
        || node.kind !== "prompt"
        || config?.cccPrdTaskId !== execution.semanticTaskId
        || config?.cccNativeTaskId !== execution.nativeTaskId
        || config.toolMode !== "coding"
        || (config.executor !== "model" && config.executor !== "cli-agent")
      ) {
        return;
      }
      const requireApproval = this.deps.requireCccCampaignLiveExecutionApproval;
      if (!requireApproval) {
        throw new PermanentError(
          "CCC campaign live-execution admission is unwired",
          "CCC_CAMPAIGN_LIVE_EXECUTION_APPROVAL_REQUIRED",
        );
      }
      await requireApproval({
        taskId: execution.nativeTaskId,
        runId: execution.runId,
      });
    };
  }

  private campaignNodeExecutionResolver(originTask: TaskDetail): NonNullable<WorkflowGraphExecutorDeps["resolveNodeExecution"]> {
    return async ({ node }) => {
      const semanticTaskId = node.config?.cccPrdTaskId;
      // Structural graph nodes do not execute a campaign task or proof and retain
      // the origin task as their sealed semantic identity.
      if (semanticTaskId === undefined && (node.kind === "start" || node.kind === "end" || node.kind === "split" || node.kind === "join" || node.kind === "foreach" || node.kind === "loop" || node.kind === "optional-group")) {
        return { semanticTask: originTask };
      }
      if (typeof semanticTaskId !== "string" || semanticTaskId.length === 0 || semanticTaskId !== semanticTaskId.trim()) {
        throw new PermanentError(
          `CCC campaign semantic task id for node ${node.id} is missing or invalid`,
          "CCC_CAMPAIGN_SEMANTIC_TASK_REFUSED",
        );
      }
      const nativeTaskId = node.config?.cccNativeTaskId ?? semanticTaskId;
      if (
        typeof nativeTaskId !== "string"
        || nativeTaskId.length === 0
        || nativeTaskId !== nativeTaskId.trim()
      ) {
        throw new PermanentError(
          `CCC campaign native task id for node ${node.id} is missing or invalid`,
          "CCC_CAMPAIGN_SEMANTIC_TASK_REFUSED",
        );
      }
      const getTask = this.deps.store.getTask;
      if (typeof getTask !== "function") {
        throw new PermanentError(
          "CCC campaign semantic task store is unwired",
          "CCC_CAMPAIGN_SEMANTIC_TASK_REFUSED",
        );
      }
      let semanticTask: TaskDetail | undefined;
      try {
        semanticTask = await getTask.call(this.deps.store, nativeTaskId);
      } catch {
        throw new PermanentError(
          `CCC campaign native task ${nativeTaskId} lookup failed for semantic task ${semanticTaskId}`,
          "CCC_CAMPAIGN_SEMANTIC_TASK_REFUSED",
        );
      }
      if (!semanticTask) {
        throw new PermanentError(
          `CCC campaign native task ${nativeTaskId} is missing for semantic task ${semanticTaskId}`,
          "CCC_CAMPAIGN_SEMANTIC_TASK_REFUSED",
        );
      }
      if (semanticTask.id !== nativeTaskId) {
        throw new PermanentError(
          `CCC campaign native task identity does not match ${nativeTaskId}`,
          "CCC_CAMPAIGN_SEMANTIC_TASK_REFUSED",
        );
      }
      const context = await this.deps.store.getCccCampaignContextForTask?.(nativeTaskId);
      if (
        !context
        || context.taskId !== nativeTaskId
        || context.semanticTaskId !== semanticTaskId
      ) {
        throw new PermanentError(
          `CCC campaign task mapping ${semanticTaskId} -> ${nativeTaskId} does not match persisted custody`,
          "CCC_CAMPAIGN_SEMANTIC_TASK_REFUSED",
        );
      }
      return { semanticTask, semanticTaskId, nativeTaskId };
    };
  }

  public async runWorkItem(
    workItem: WorkflowWorkItem,
    settings: (Pick<Settings, "experimentalFeatures"> & Partial<Settings>) | undefined,
  ): Promise<WorkflowTaskRuntimeResult> {
    const campaignCustodyRefusal = await this.campaignWorkItemCustodyRefusal(workItem);
    if (campaignCustodyRefusal) return campaignCustodyRefusal;
    if (!this.deps.store.getTask || !this.deps.store.transitionWorkflowWorkItem) {
      const reason = "workflow-work-item-store-unwired";
      this.emit("terminal", workItem.taskId, `work-item:failed:${reason}`);
      return {
        disposition: "failed",
        outcome: "failure",
        visitedNodeIds: [],
        context: {},
        reason,
      };
    }
    let task: TaskDetail;
    try {
      task = await this.deps.store.getTask(workItem.taskId);
    } catch (err) {
      return await this.failWorkItem(workItem, `workflow-work-item-task-missing:${err instanceof Error ? err.message : String(err)}`);
    }

    let target: WorkflowRuntimeTarget;
    try {
      target = await this.resolveRuntimeTarget(workItem.taskId);
    } catch (err) {
      return await this.failWorkItem(workItem, `workflow-resolution-error: ${err instanceof Error ? err.message : String(err)}`);
    }

    const node = target.ir.nodes.find((candidate) => candidate.id === workItem.nodeId);
    if (!node) {
      return await this.failWorkItem(workItem, `workflow-work-item-node-missing:${workItem.nodeId}`);
    }

    const configuredRetries = Number(node.config?.maxRetries);
    const cccFusionTask = isCccCampaignTask(task);
    const maxAttempts = Number.isFinite(configuredRetries) && configuredRetries >= 1
      ? Math.min(10, Math.floor(configuredRetries))
      : 1;
    const currentAttempt = Math.max(1, workItem.attempt);
    const claimedCccTransient = cccFusionTask
      && workItem.state === "running"
      && workItem.lastError?.startsWith("ccc-transient:") === true;
    if (claimedCccTransient && currentAttempt >= maxAttempts) {
      const reason = "ccc-transient-retry-exhausted";
      await this.deps.store.transitionWorkflowWorkItem(workItem.id, "exhausted", {
        attempt: currentAttempt,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: reason,
      });
      await this.recordWorkItemTransition(workItem, "exhausted", currentAttempt, "ccc-transient-exhausted");
      this.emit("terminal", workItem.taskId, "work-item:failed");
      return { disposition: "failed", outcome: "failure", visitedNodeIds: [], context: {}, reason };
    }
    if (workItem.state !== "running") {
      if (cccFusionTask && workItem.state === "retrying" && currentAttempt >= maxAttempts) {
        const reason = "ccc-transient-retry-exhausted";
        await this.deps.store.transitionWorkflowWorkItem(workItem.id, "exhausted", {
          attempt: currentAttempt,
          leaseOwner: null,
          leaseExpiresAt: null,
          lastError: reason,
        });
        await this.recordWorkItemTransition(workItem, "exhausted", currentAttempt, "ccc-transient-exhausted");
        this.emit("terminal", workItem.taskId, "work-item:failed");
        return { disposition: "failed", outcome: "failure", visitedNodeIds: [], context: {}, reason };
      }
      return await this.failWorkItem(workItem, `workflow-work-item-not-running:${workItem.state}`);
    }

    if (workItem.kind === "merge" || workItem.kind === "manual-hold") {
      await ensureWorkflowCompletionSummary(this.deps.store, task, {
        reason: `workflow-work-item:${workItem.kind}`,
        workflowId: target.workflowId,
        runId: workItem.runId,
      }).catch(() => undefined);
    }

    const invoked: string[] = [];
    const handler = this.recordingHandlers(invoked)[node.kind];
    if (!handler && node.kind !== "start" && node.kind !== "end") {
      return await this.failWorkItem(workItem, `workflow-work-item-node-unhandled:${node.kind}`);
    }

    const runtimeSettings = buildWorkflowRuntimeSettings(settings);
    let outcome: WorkflowNodeOutcome = "success";
    let reason: string | undefined;
    let context: Record<string, unknown> = {
      [WORKFLOW_RUN_ID_CONTEXT_KEY]: workItem.runId,
      [WORKFLOW_ID_CONTEXT_KEY]: target.workflowId,
      "workflow:work-item-id": workItem.id,
      "workflow:work-item-kind": workItem.kind,
      "workflow:work-item-attempt": workItem.attempt,
    };

    /*
    FNXC:CCCWorkItemRetry 2026-07-24-11:52:
    `maxRetries` is the total invocation cap, including the first attempt. Only
    native TransientError failures consume another bounded attempt; a
    PermanentError is classified once and durably parked for operator action.
    */
    let attempt = currentAttempt;
    if (claimedCccTransient) {
      attempt += 1;
      await this.deps.store.transitionWorkflowWorkItem(workItem.id, "running", { attempt, lastError: null });
      await this.recordWorkItemTransition(workItem, "running", attempt, "ccc-transient-resume");
    }
    for (;;) {
      try {
        const result = handler
          ? await handler(node, { task, settings: runtimeSettings, context })
          : { outcome: "success" as const };
        outcome = result.outcome;
        if (result.value !== undefined) context[`node:${node.id}:value`] = result.value;
        context = { ...context, ...(result.contextPatch ?? {}) };
        reason = result.outcome === "failure" ? result.value ?? "workflow-work-item-node-failed" : undefined;
        break;
      } catch (err) {
        if (cccFusionTask && err instanceof PermanentError) {
          const reason = `ccc-permanent:${err.code}`;
          await this.deps.store.transitionWorkflowWorkItem(workItem.id, "manual-required", {
            attempt,
            leaseOwner: null,
            leaseExpiresAt: null,
            lastError: formatCccPermanentWorkItemError(reason, err),
            blockedReason: reason,
          });
          await this.recordWorkItemTransition(workItem, "manual-required", attempt, "ccc-permanent");
          this.emit("terminal", workItem.taskId, "work-item:manual-required");
          return { disposition: "manual-required", outcome: "failure", visitedNodeIds: invoked, context, reason };
        }
        if (cccFusionTask && err instanceof TransientError && attempt < maxAttempts) {
          await this.deps.store.transitionWorkflowWorkItem(workItem.id, "retrying", {
            attempt,
            lastError: `ccc-transient:${err.code}`,
          });
          await this.recordWorkItemTransition(workItem, "retrying", attempt, "ccc-transient-retry");
          attempt += 1;
          await this.deps.store.transitionWorkflowWorkItem(workItem.id, "running", {
            attempt,
            lastError: null,
          });
          await this.recordWorkItemTransition(workItem, "running", attempt, "ccc-transient-resume");
          continue;
        }
        outcome = "failure";
        reason = cccFusionTask && err instanceof TransientError
          ? `ccc-transient-retry-exhausted:${err.code}`
          : `workflow-work-item-node-error:${err instanceof Error ? err.message : String(err)}`;
        break;
      }
    }

    const disposition: WorkflowTaskRuntimeDisposition = outcome === "success"
      ? "completed"
      : reason === "manual-required"
        ? "manual-required"
        : "failed";
    const terminalState: WorkflowWorkItemState = cccFusionTask && reason?.startsWith("ccc-transient-retry-exhausted:")
      ? "exhausted"
      : disposition === "completed"
      ? "succeeded"
      : disposition === "manual-required"
        ? "manual-required"
        : "failed";
    await this.deps.store.transitionWorkflowWorkItem(workItem.id, terminalState, {
      attempt,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: reason ?? null,
    });
    if (cccFusionTask) {
      const classification = terminalState === "exhausted"
        ? "ccc-transient-exhausted"
        : terminalState === "succeeded"
          ? "ccc-transient-succeeded"
          : "ccc-work-item-failed";
      await this.recordWorkItemTransition(workItem, terminalState, attempt, classification);
    }
    this.emit("terminal", workItem.taskId, `work-item:${disposition}`);
    return {
      disposition,
      outcome,
      visitedNodeIds: invoked.length > 0 ? invoked : [node.id],
      context,
      reason,
    };
  }

  private async campaignWorkItemCustodyRefusal(
    workItem: WorkflowWorkItem,
  ): Promise<WorkflowTaskRuntimeResult | undefined> {
    const importedWorkItem = isImportedCccCampaignWorkItem(workItem);
    const getContext = this.deps.store.getCccCampaignContextForTask;
    if (typeof getContext !== "function") {
      return importedWorkItem
        ? this.campaignCustodyFailure(workItem.taskId, "ccc-campaign-full-graph-processor-required")
        : undefined;
    }
    try {
      const context = await getContext.call(this.deps.store, workItem.taskId);
      return context || importedWorkItem
        ? this.campaignCustodyFailure(workItem.taskId, "ccc-campaign-full-graph-processor-required")
        : undefined;
    } catch {
      return importedWorkItem
        ? this.campaignCustodyFailure(workItem.taskId, "ccc-campaign-full-graph-processor-required")
        : undefined;
    }
  }

  private async failWorkItem(workItem: WorkflowWorkItem, reason: string): Promise<WorkflowTaskRuntimeResult> {
    await this.deps.store.transitionWorkflowWorkItem!(workItem.id, "failed", {
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: reason,
    });
    this.emit("terminal", workItem.taskId, `work-item:failed:${reason}`);
    return {
      disposition: "failed",
      outcome: "failure",
      visitedNodeIds: [],
      context: {},
      reason,
    };
  }

  private async recordWorkItemTransition(
    workItem: WorkflowWorkItem,
    state: WorkflowWorkItemState,
    attempt: number,
    classification: string,
  ): Promise<void> {
    await this.deps.store.recordRunAuditEvent?.({
      taskId: workItem.taskId,
      agentId: "workflow-task-runtime",
      runId: workItem.runId,
      domain: "database",
      mutationType: "workflow:work-item-transition",
      target: workItem.id,
      metadata: { state, attempt, classification },
    });
  }

  /**
   * FNXC:WorkflowGates 2026-06-17-18:20:
   * Custom workflow success criteria require every declared task-document artifact key to exist before terminal success. Planning-owned and step-source artifacts must also be non-empty because they are executable inputs, not presence-only context.
   */
  private async findMissingRequiredArtifacts(taskId: string, ir: WorkflowIr): Promise<string[]> {
    const declaredArtifacts: WorkflowIrArtifact[] = "artifacts" in ir && Array.isArray(ir.artifacts) ? ir.artifacts : [];
    if (declaredArtifacts.length === 0) return [];
    if (!this.deps.store.getTaskDocument) {
      return declaredArtifacts.map((artifact) => artifact.key);
    }

    const missing: string[] = [];
    for (const artifact of declaredArtifacts) {
      const document = await this.deps.store.getTaskDocument(taskId, artifact.key);
      const content = document && typeof (document as { content?: unknown }).content === "string"
        ? (document as { content: string }).content
        : undefined;
      if (!document || (requiresNonEmptyWorkflowArtifact(artifact) && !content?.trim())) {
        missing.push(artifact.key);
      }
    }
    return missing;
  }

  private async resolveRuntimeTarget(taskId: string): Promise<WorkflowRuntimeTarget> {
    let workflowId: string | undefined;
    try {
      const selection = this.deps.store.getTaskWorkflowSelectionAsync
        ? await this.deps.store.getTaskWorkflowSelectionAsync(taskId)
        : this.deps.store.getTaskWorkflowSelection(taskId);
      workflowId = selection?.workflowId;
    } catch (err) {
      throw new Error(`workflow-selection-failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!workflowId) return builtinCodingTarget();

    if (isBuiltinWorkflowId(workflowId)) {
      const builtin = getBuiltinWorkflow(workflowId);
      if (!builtin) throw new Error(`workflow-missing: ${workflowId}`);
      const ir = typeof builtin.ir === "string" ? parseWorkflowIr(builtin.ir) : builtin.ir;
      return { workflowId, ir };
    }

    const def = await this.deps.store.getWorkflowDefinition(workflowId);
    if (!def) throw new Error(`workflow-missing: ${workflowId}`);
    const ir = typeof def.ir === "string" ? parseWorkflowIr(def.ir) : def.ir;
    return { workflowId, ir };
  }

  private recordingHandlers(invoked: string[]): Partial<Record<WorkflowIrNode["kind"], WorkflowNodeHandler>> {
    const defaultHandlers = createDefaultNodeHandlers(createNoopLegacySeams(), this.deps.runCustomNode, {
      primitives: this.deps.primitives,
      parseSteps: this.deps.parseStepsDeps,
      runCode: this.deps.runCode,
      prNodes: this.deps.prNodes,
    });
    const handlers = { ...defaultHandlers, ...(this.deps.handlers ?? {}) };
    const ordinaryGate = handlers.gate;
    handlers.gate = (node, context) => {
      const isCccProofGate = node.config?.cccProofSuite === true
        || node.config?.cccProofGate === true
        || node.config?.cccProofPhase !== undefined;
      if (!isCccProofGate) {
        return ordinaryGate(node, context);
      }
      if (!this.deps.runCccProofSuite) {
        return Promise.resolve({
          outcome: "failure" as const,
          value: "ccc-proof-suite-execution-unwired",
        });
      }
      return this.deps.runCccProofSuite(node, context);
    };
    const wrapped: Partial<Record<WorkflowIrNode["kind"], WorkflowNodeHandler>> = {};
    for (const [kind, handler] of Object.entries(handlers) as Array<[WorkflowIrNode["kind"], WorkflowNodeHandler]>) {
      wrapped[kind] = async (node, context) => {
        invoked.push(node.id);
        return handler(node, context);
      };
    }
    return wrapped;
  }
}

interface WorkflowRuntimeTarget {
  workflowId: string;
  ir: WorkflowIr;
}

function builtinCodingTarget(): WorkflowRuntimeTarget {
  /*
   * FNXC:WorkflowBuiltins 2026-06-29-02:18:
   * Runtime defaulting must follow the built-in catalog entry for `builtin:coding`; importing the legacy coding IR here would bypass the renamed default workflow and strand unselected tasks on the old monolithic graph.
   */
  const builtin = getBuiltinWorkflow("builtin:coding");
  if (!builtin) throw new Error("workflow-missing: builtin:coding");
  const ir = typeof builtin.ir === "string" ? parseWorkflowIr(builtin.ir) : builtin.ir;
  return { workflowId: "builtin:coding", ir };
}

function buildWorkflowRuntimeSettings(
  settings: (Pick<Settings, "experimentalFeatures"> & Partial<Settings>) | undefined,
): Pick<Settings, "experimentalFeatures"> & Partial<Settings> {
  return { ...(settings ?? {}) };
}
