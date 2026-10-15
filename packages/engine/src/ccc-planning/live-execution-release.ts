import type { TaskStore } from "@fusion/core";
import type { CccPlanningLiveAuthorityReceiptV1 } from "../../../core/dist/ccc-planning/authority.js";
import {
  approveCccCampaignLiveExecution,
  computeCccCampaignLiveExecutionApprovalConfirmation,
  issueCccCampaignLiveExecutionApproval,
} from "../ccc-campaign-product-control.js";

export type CccPlanningLiveExecutionReleaseResult =
  | { kind: "released"; authorizationId: string; authorizationDigest: string }
  | { kind: "awaiting_operator"; authorizationId: string; confirmation: string;
      reason: "receipt_requires_operator" | "envelope_mismatch"; mismatch?: { field: string; detail: string } };

export async function releaseCccPlanningLiveExecution(i: { store: TaskStore; rootDir: string; entryTaskId: string;
  receipt: CccPlanningLiveAuthorityReceiptV1; receiptSha256: string;
  run: { runId: string; runRevision: number; deadlineAt: string; implementationCallsRemaining: number;
         compiledProviderTaskCount: number; writerProviderId: string };
  observeBaseline: (commit: string) => Promise<{ commit: string; firstParent: string; changedPaths: readonly string[] }>;
  deps?: { issue?: typeof issueCccCampaignLiveExecutionApproval; approve?: typeof approveCccCampaignLiveExecution;
           compute?: typeof computeCccCampaignLiveExecutionApprovalConfirmation };
  hooks?: { afterStep?: (step: "issued" | "approved" | "published") => Promise<void> } }): Promise<CccPlanningLiveExecutionReleaseResult> {
  void i;
  return { kind: "awaiting_operator", authorizationId: "", confirmation: "", reason: "receipt_requires_operator" };
}
