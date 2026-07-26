import type { CccCampaignTaskContext, RunAuditEventInput, Settings, TaskDetail, WorkflowIr, WorkflowIrArtifact, WorkflowIrNode, WorkflowWorkItem, WorkflowWorkItemState } from "@fusion/core";
import {
  getBuiltinWorkflow,
  isBuiltinWorkflowId,
  parseWorkflowIr,
  type WorkflowIrResolverStore,
} from "@fusion/core";

import {
  WorkflowGraphExecutor,
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
import { isImportedCccCampaignTask, isImportedCccCampaignWorkItem } from "./ccc-campaign-routing.js";

export type WorkflowTaskRuntimeDisposition = "completed" | "failed" | "manual-required" | "cancelled";

export interface WorkflowWorkItemFence {
  workItemId: string;
  leaseOwner: string;
  attempt: number;
  runId: string;
  eventTimestamp: string;
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

export interface WorkflowTaskRuntimeDeps extends Omit<WorkflowGraphExecutorDeps, "seams" | "runCustomNode"> {
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
  onEvent?: (event: { type: "start" | "terminal"; taskId: string; detail: string }) => void;
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
    const campaignCustodyRefusal = await this.campaignCustodyRefusal(task, options);
    if (campaignCustodyRefusal) return campaignCustodyRefusal;
    const campaignFenceRefusal = await this.campaignFenceRefusal(task, options);
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

    const runtimeRunId = options.workItemFence?.runId ?? this.deps.runId ?? `${task.id}:${target.workflowId}`;
    const invoked: string[] = [];
    const campaignProofAdmission = this.campaignProofAdmission(task, options);
    const {
      store: _store,
      onEvent: _onEvent,
      resolveNodeExecution: ordinaryResolveNodeExecution,
      resolveNodeProviderController: ordinaryResolveNodeProviderController,
      admitNodeExecution: ordinaryAdmitNodeExecution,
      ...graphDeps
    } = this.deps;
    const fencedCampaignRun = options.workItemFence !== undefined;
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
            admitNodeExecution: (node, semanticTask, signal, visitIdentity, execution) =>
              campaignProofAdmission?.(node, signal, execution && visitIdentity
                ? { semanticTask, visitIdentity, execution }
                : undefined),
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
      signal: options.signal,
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
    if (options.signal?.aborted && result.outcome === "success") {
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
      if (options.signal?.aborted) {
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
      if (!options.deferCompletionSummary) {
        const latestTask = await this.deps.store.getTask?.(task.id).catch(() => undefined);
        await ensureWorkflowCompletionSummary(this.deps.store, latestTask ?? task, {
          reason: "workflow-runtime-completed",
          workflowId: target.workflowId,
          runId: runtimeRunId,
        }).catch(() => undefined);
      }
    }

    const disposition: WorkflowTaskRuntimeDisposition = result.outcome === "success" ? "completed" : "failed";
    this.emit("terminal", task.id, disposition);
    const reason = result.outcome === "failure" && options.signal?.aborted ? "workflow-aborted" : undefined;
    return {
      disposition,
      outcome: result.outcome,
      visitedNodeIds: result.visitedNodeIds,
      context: result.context,
      ...(reason ? { reason } : {}),
    };
  }

  private async campaignCustodyRefusal(
    task: TaskDetail,
    options: WorkflowTaskRuntimeRunOptions,
  ): Promise<WorkflowTaskRuntimeResult | undefined> {
    const importedTask = isImportedCccCampaignTask(task);
    const fencedInvocation = options.workItemFence !== undefined;
    const getContext = this.deps.store.getCccCampaignContextForTask;
    if (typeof getContext !== "function") {
      return importedTask || fencedInvocation
        ? this.campaignCustodyFailure(task.id, "ccc-campaign-custody-lookup-unwired")
        : undefined;
    }
    let context: CccCampaignTaskContext | null;
    try {
      context = await getContext.call(this.deps.store, task.id);
    } catch {
      return importedTask || fencedInvocation
        ? this.campaignCustodyFailure(task.id, "ccc-campaign-custody-lookup-error")
        : undefined;
    }
    if (context && !options.workItemFence) {
      return this.campaignCustodyFailure(task.id, "ccc-campaign-work-item-fence-required");
    }
    return (importedTask || fencedInvocation) && !context
      ? this.campaignCustodyFailure(task.id, "ccc-campaign-custody-missing")
      : undefined;
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
      const getTask = this.deps.store.getTask;
      if (typeof getTask !== "function") {
        throw new PermanentError(
          "CCC campaign semantic task store is unwired",
          "CCC_CAMPAIGN_SEMANTIC_TASK_REFUSED",
        );
      }
      let semanticTask: TaskDetail | undefined;
      try {
        semanticTask = await getTask.call(this.deps.store, semanticTaskId);
      } catch {
        throw new PermanentError(
          `CCC campaign semantic task ${semanticTaskId} lookup failed`,
          "CCC_CAMPAIGN_SEMANTIC_TASK_REFUSED",
        );
      }
      if (!semanticTask) {
        throw new PermanentError(
          `CCC campaign semantic task ${semanticTaskId} is missing`,
          "CCC_CAMPAIGN_SEMANTIC_TASK_REFUSED",
        );
      }
      if (semanticTask.id !== semanticTaskId) {
        throw new PermanentError(
          `CCC campaign semantic task identity does not match ${semanticTaskId}`,
          "CCC_CAMPAIGN_SEMANTIC_TASK_REFUSED",
        );
      }
      return { semanticTask };
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
    const cccFusionTask = task.customFields?.cccFusionProfile === "ccc-fusion";
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
            lastError: reason,
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
