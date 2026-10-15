import type { AsyncDataLayer, DbTransaction } from "../postgres/data-layer.js";
import type { CccPlanningRunCustody, CccPlanningRunState } from "../ccc-planning/types.js";
import {
  CccProviderAttemptLimitError,
  type CccCampaignWorkItemFence,
} from "../ccc-campaign/types.js";
import type { WorkflowWorkItem, WorkflowWorkItemState } from "../types.js";

/** STUB (card BF, RED phase). */
export async function findCccPlanningRunForImport(_tx: DbTransaction, _projectId: string, _importId: string):
  Promise<CccPlanningRunCustody | null> {
  return null;
}

export type CccPlanningLinkedWriterRoute = Readonly<{
  providerId: string; modelId: string; transport: string; roleClass: string; toolsetDigest: string;
}>;

export async function openCccPlanningLinkedWriterAttempt(_layer: AsyncDataLayer, i: Readonly<{
  importId: string; semanticTaskId: string; baseTurnKey: string; nodeAttemptOrdinal: number; fence: CccCampaignWorkItemFence }>):
  Promise<Readonly<{ turnKey: string; dispatchAttemptOrdinal: 1 | 2 | 3; route: CccPlanningLinkedWriterRoute }>> {
  return { turnKey: i.baseTurnKey, dispatchAttemptOrdinal: 1, route: { providerId: "", modelId: "", transport: "", roleClass: "", toolsetDigest: "" } };
}

export async function applyCccPlanningCampaignOutcomeWithinTransaction(_tx: DbTransaction, _i: Readonly<{
  projectId: string; before: WorkflowWorkItem; workItem: WorkflowWorkItem; fromState: WorkflowWorkItemState;
  toState: WorkflowWorkItemState }>):
  Promise<Readonly<{ kind: "not-linked" } | { kind: "mapped"; runState: CccPlanningRunState } | { kind: "unmapped" }>> {
  return { kind: "not-linked" };
}

export async function reconcileCccPlanningCampaignOutcome(_layer: AsyncDataLayer, _runId: string): Promise<void> {
  return;
}

export type CccPlanningWriterRefusal = Readonly<{ runId: string; importId: string; turnKey: string; dispatchKey: string;
  reason: CccProviderAttemptLimitError["reason"]; refusedAt: string }>;

export class CccPlanningLinkedWriterLimitError extends CccProviderAttemptLimitError {
  public readonly refusal: CccPlanningWriterRefusal;

  public constructor(refusal: CccPlanningWriterRefusal, message: string) {
    super(refusal.reason, message);
    this.name = "CccPlanningLinkedWriterLimitError";
    this.refusal = Object.freeze({ ...refusal });
  }
}

export async function recordCccPlanningWriterRefusal(_layer: AsyncDataLayer, _refusal: CccPlanningWriterRefusal): Promise<void> {
  return;
}

export function __setCccPlanningCampaignOutcomeSeamForTesting(_seam: ((tx: DbTransaction) => Promise<void>) | null): void {
  return;
}
