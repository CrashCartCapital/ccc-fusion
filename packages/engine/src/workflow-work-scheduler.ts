import type { AsyncMissionStore, MissionStore, Task, WorkflowWorkItem, WorkflowWorkItemDueFilter, WorkflowWorkItemKind } from "@fusion/core";
import { decideMissionSymbolAdmission } from "./mission-symbol-admission.js";

const WORKFLOW_SYMBOL_LOCK_LEASE_MS = 10 * 60_000;

export class WorkflowWorkSchedulerExactCandidateInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowWorkSchedulerExactCandidateInvariantError";
  }
}

export interface WorkflowWorkSchedulerStore {
  listDueWorkflowWorkItems(filter?: WorkflowWorkItemDueFilter): WorkflowWorkItem[] | Promise<WorkflowWorkItem[]>;
  getWorkflowWorkItem?(id: string): WorkflowWorkItem | null | Promise<WorkflowWorkItem | null>;
  acquireWorkflowWorkItemLease(
    id: string,
    leaseOwner: string,
    opts: { leaseDurationMs: number; now?: string; expectedRunId?: string; expectedAttempt?: number },
  ): WorkflowWorkItem | null | Promise<WorkflowWorkItem | null>;
  /** TaskStore supplies these optional scheduler-admission capabilities. */
  getTask?(id: string): Promise<Task | undefined>;
  getMissionStore?(): MissionStore | AsyncMissionStore;
  getSettings?(): Promise<{ planApprovalMode?: "workflow" | "auto-approve-all" | "require-all" }>;
  acquireSymbolLocks?(
    symbols: readonly string[],
    owner: { ownerTaskId: string; missionId?: string; featureId?: string; agentId?: string },
    leaseMs: number,
  ): Promise<{ acquired: true; conflicts: [] } | { acquired: false; conflicts: Array<{ symbolKey: string; ownerTaskId: string }> }>;
  releaseSymbolLocks?(symbols: readonly string[], ownerTaskId: string): Promise<unknown>;
  renewSymbolLocks?(symbols: readonly string[], ownerTaskId: string, leaseMs: number): Promise<{ renewed: string[]; lost: string[] }>;
  logEntry?(taskId: string, message: string): Promise<unknown>;
}

export interface WorkflowWorkDispatch {
  workItem: WorkflowWorkItem;
  runId: string;
  taskId: string;
  nodeId: string;
  /** Symbols held by this claim; the processor renews them while runtime work is live. */
  symbolLocks?: string[];
}

export interface ClaimWorkflowWorkOptions {
  now?: string;
  limit?: number;
  leaseOwner: string;
  leaseDurationMs: number;
  kinds?: WorkflowWorkItemKind[];
  exactCandidate?: ExactWorkflowWorkCandidate;
  bypassMissionSymbolAdmission?: boolean;
}

export interface ExactWorkflowWorkCandidate {
  id: string;
  runId: string;
  attempt: number;
}

/**
 * FNXC:MissionSymbolAdmission 2026-07-31-12:00:
 * Workflow work claiming is async because durable symbol acquisition must occur
 * before its work lease is consumed. Unapproved mission work and contention are
 * skipped without a lease, while deployments without the TaskStore admission
 * seam retain their existing coarse workflow-lease behavior.
 */
export async function claimDueWorkflowWorkItem(
  store: WorkflowWorkSchedulerStore,
  opts: ClaimWorkflowWorkOptions,
): Promise<WorkflowWorkDispatch | null> {
  const due = opts.exactCandidate
    ? await resolveExactCandidate(store, opts.exactCandidate, opts)
    : await store.listDueWorkflowWorkItems({
      now: opts.now,
      limit: opts.limit ?? 25,
      kinds: opts.kinds,
    });

  for (const candidate of due) {
    let lockedSymbols: string[] | undefined;
    if (!opts.bypassMissionSymbolAdmission && store.getTask && store.getMissionStore && store.acquireSymbolLocks) {
      const task = await store.getTask(candidate.taskId);
      if (task) {
        const settings = await store.getSettings?.();
        const admission = await decideMissionSymbolAdmission(task, store.getMissionStore(), {
          planApprovalRequired: settings?.planApprovalMode === "require-all",
        });
        if (admission.kind === "lineage-blocked") {
          await store.logEntry?.(task.id, `workflow work not claimed — mission lineage blocked: ${admission.reason}`);
          continue;
        }
        if (admission.kind === "symbol-lock") {
          const result = await store.acquireSymbolLocks(
            admission.symbols,
            { ownerTaskId: task.id, missionId: task.missionId, featureId: admission.feature.id, agentId: opts.leaseOwner },
            WORKFLOW_SYMBOL_LOCK_LEASE_MS,
          );
          if (!result.acquired) {
            const conflict = result.conflicts[0];
            await store.logEntry?.(task.id, `workflow work not claimed — symbol contention: symbol=${conflict?.symbolKey ?? "unknown"} holder=${conflict?.ownerTaskId ?? "unknown"}`);
            continue;
          }
          lockedSymbols = admission.symbols;
        }
      }
    }

    const workItem = await store.acquireWorkflowWorkItemLease(candidate.id, opts.leaseOwner, {
      now: opts.now,
      leaseDurationMs: opts.leaseDurationMs,
      expectedRunId: opts.exactCandidate?.runId,
      expectedAttempt: opts.exactCandidate?.attempt,
    });
    if (!workItem) {
      if (lockedSymbols) await store.releaseSymbolLocks?.(lockedSymbols, candidate.taskId);
      continue;
    }
    if (opts.exactCandidate && (
      workItem.id !== opts.exactCandidate.id
      || workItem.runId !== opts.exactCandidate.runId
      || workItem.attempt !== opts.exactCandidate.attempt
    )) {
      if (lockedSymbols) await store.releaseSymbolLocks?.(lockedSymbols, candidate.taskId);
      throw new WorkflowWorkSchedulerExactCandidateInvariantError(`exact candidate invariant violated: leased work item ${workItem.id} ${workItem.runId} attempt ${workItem.attempt} did not match requested ${opts.exactCandidate.id} ${opts.exactCandidate.runId} attempt ${opts.exactCandidate.attempt}`);
    }
    return {
      workItem,
      runId: workItem.runId,
      taskId: workItem.taskId,
      nodeId: workItem.nodeId,
      symbolLocks: lockedSymbols,
    };
  }

  return null;
}

async function resolveExactCandidate(
  store: WorkflowWorkSchedulerStore,
  exactCandidate: ExactWorkflowWorkCandidate,
  opts: ClaimWorkflowWorkOptions,
): Promise<WorkflowWorkItem[]> {
  if (store.getWorkflowWorkItem) {
    const candidate = await store.getWorkflowWorkItem(exactCandidate.id);
    return candidate
      && candidate.id === exactCandidate.id
      && candidate.runId === exactCandidate.runId
      && candidate.attempt === exactCandidate.attempt
      && (!opts.kinds?.length || opts.kinds.includes(candidate.kind))
      ? [candidate]
      : [];
  }
  const due = await store.listDueWorkflowWorkItems({
    now: opts.now,
    limit: opts.limit ?? 25,
    kinds: opts.kinds,
  });
  return due.filter((candidate) => (
    candidate.id === exactCandidate.id
    && candidate.runId === exactCandidate.runId
    && candidate.attempt === exactCandidate.attempt
    && (!opts.kinds?.length || opts.kinds.includes(candidate.kind))
  ));
}
