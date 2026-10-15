import {
  assertCccPlanningExecutionAuthorizationWithinReceipt,
  canonicalCccPrdJson,
  cccPlanningEventId,
  cccPlanningImportKey,
  CccPlanningRefusal,
  drizzleSql as sql,
  encodeCccPlanningArtifactKey,
  getCccCampaignExecutionAuthorizationForImport,
  inspectCccPlanningImportLink,
  publishCccPlanningArtifactWithinTransaction,
  readCccPlanningArtifact,
  recordRunAuditEventWithinTransaction,
  transitionCccPlanningRunState,
  transitionCccPlanningRunStateWithin,
  type AsyncDataLayer,
  type CccPlanningLiveAuthorityReceiptV1,
  type CccPlanningRunState,
  type CccPlanningWorkItemFence,
  type TaskStore,
} from "@fusion/core";
import {
  approveCccCampaignLiveExecution,
  computeCccCampaignLiveExecutionApprovalConfirmation,
  issueCccCampaignLiveExecutionApproval,
  requireCccCampaignLiveExecutionApproval,
} from "../ccc-campaign-product-control.js";

export type CccPlanningLiveExecutionReleaseResult =
  | { kind: "released"; authorizationId: string; authorizationDigest: string }
  | { kind: "awaiting_operator"; authorizationId: string; confirmation: string;
      reason: "receipt_requires_operator" | "envelope_mismatch"; mismatch?: { field: string; detail: string } };

type ReleaseInput = { store: TaskStore; rootDir: string; entryTaskId: string;
  receipt: CccPlanningLiveAuthorityReceiptV1; receiptSha256: string;
  run: { runId: string; runRevision: number; deadlineAt: string; implementationCallsRemaining: number;
         compiledProviderTaskCount: number; writerProviderId: string };
  observeBaseline: (commit: string) => Promise<{ commit: string; firstParent: string; changedPaths: readonly string[] }>;
  deps?: { issue?: typeof issueCccCampaignLiveExecutionApproval; approve?: typeof approveCccCampaignLiveExecution;
           compute?: typeof computeCccCampaignLiveExecutionApprovalConfirmation };
  hooks?: { afterStep?: (step: "issued" | "approved" | "published") => Promise<void> } };

type Anchor = {
  project_id: string; planning_task_id: string; revision: number; state: CccPlanningRunState;
  authority_receipt_sha256: string; authority_receipt_json: string; import_id: string | null;
  import_idempotency_key: string | null; control_request: string | null; now: string;
};

const NO_POLICY = { promptVersion: "none", promptDigest: "none", toolPolicyVersion: "none", toolPolicyDigest: "none" } as const;

async function readAnchor(layer: AsyncDataLayer, i: ReleaseInput): Promise<Anchor> {
  const rows = await layer.db.execute(sql`
    SELECT project_id, planning_task_id, revision, state, authority_receipt_sha256, authority_receipt_json,
      import_id, import_idempotency_key, control_request,
      to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now
      FROM project.ccc_planning_runs WHERE project_id = ${i.receipt.project.projectId} AND run_id = ${i.run.runId}
  `) as unknown as Anchor[];
  if (rows.length !== 1) throw new CccPlanningRefusal("CCC_PLANNING_RUN_NOT_FOUND", "release requires one admitted run");
  const anchor = rows[0]!;
  if (anchor.revision !== i.run.runRevision) {
    throw new CccPlanningRefusal("CCC_PLANNING_REVISION_STALE", "release names another run revision");
  }
  if (anchor.authority_receipt_sha256 !== i.receiptSha256
    || anchor.authority_receipt_json !== canonicalCccPrdJson(i.receipt)) {
    throw new CccPlanningRefusal("CCC_PLANNING_AUTHORITY_RECEIPT_UNCONFIRMED", "release does not name the consumed receipt");
  }
  if (anchor.import_id === null || anchor.import_idempotency_key !== cccPlanningImportKey(i.run.runId, i.run.runRevision)) {
    throw new CccPlanningRefusal("CCC_PLANNING_IMPORT_IDENTITY_DRIFT", "release requires this revision's linked import");
  }
  return anchor;
}

async function planningFence(layer: AsyncDataLayer, anchor: Anchor, runId: string): Promise<CccPlanningWorkItemFence> {
  if (anchor.control_request !== null) {
    throw new CccPlanningRefusal("CCC_PLANNING_CONTROL_PENDING", "release waits for the pending planning control");
  }
  const items = await layer.db.execute(sql`
    SELECT id, lease_owner, attempt FROM project.workflow_work_items
      WHERE project_id = ${anchor.project_id} AND task_id = ${anchor.planning_task_id} AND run_id = ${runId}
        AND state = 'running' AND lease_owner IS NOT NULL AND lease_expires_at::timestamptz > clock_timestamp()
  `) as unknown as Array<{ id: string; lease_owner: string; attempt: number }>;
  if (items.length !== 1) throw new CccPlanningRefusal("CCC_PLANNING_FENCE_STALE", "release requires one live planning lease");
  const item = items[0]!;
  return { kind: "planning", workItemId: item.id, leaseOwner: item.lease_owner, attempt: item.attempt,
    runId, originTaskId: anchor.planning_task_id };
}

/**
 * FNXC:CccPlanningLiveRelease 2026-10-15-05:35:
 * D36/AU2 composes the native issue/envelope/claim gate inside Ryan's already consumed receipt. Issuance creates
 * pending rows; a refusal claims none (E18), and supplies the existing operator confirmation instead. Replay reads
 * the native authorization and immutable artifact first. Publication, the bounded audit, the planning state and the
 * guarded campaign wake share one transaction, so a crash never exposes runnable work without its release receipt.
 */
export async function releaseCccPlanningLiveExecution(i: ReleaseInput): Promise<CccPlanningLiveExecutionReleaseResult> {
  const layer = i.store.getAsyncLayer();
  if (!layer) throw new CccPlanningRefusal("CCC_PLANNING_POSTGRES_REQUIRED", "live release requires PostgreSQL custody");
  const anchor = await readAnchor(layer, i);
  const link = await inspectCccPlanningImportLink(layer, i.run.runId);
  if (link.kind !== "linked" || link.receipt.importId !== anchor.import_id || link.receipt.runRevision !== i.run.runRevision) {
    throw new CccPlanningRefusal("CCC_PLANNING_IMPORT_IDENTITY_DRIFT", "release requires the exact IM1 import receipt");
  }
  const slot = { runRevision: i.run.runRevision, stageId: "import", slot: "release", version: 1 } as const;
  const key = encodeCccPlanningArtifactKey(slot);
  const receiptKey = encodeCccPlanningArtifactKey({ ...slot, slot: "receipt" });
  const importArtifact = await readCccPlanningArtifact(layer, anchor.planning_task_id, receiptKey);
  if (importArtifact === null) throw new CccPlanningRefusal("CCC_PLANNING_IMPORT_IDENTITY_DRIFT", "import receipt artifact is missing");
  const priorRelease = await readCccPlanningArtifact(layer, anchor.planning_task_id, key);
  let authorization = await getCccCampaignExecutionAuthorizationForImport(layer.db, link.receipt.importId);
  if (priorRelease !== null) {
    const result = JSON.parse(priorRelease.text) as CccPlanningLiveExecutionReleaseResult;
    if (priorRelease.record.envelope.kind !== "live_execution_release" || priorRelease.record.envelope.status !== "complete"
      || result.kind !== "released" || authorization === null || result.authorizationId !== authorization.authorizationId
      || result.authorizationDigest !== authorization.authorizationDigest) {
      throw new CccPlanningRefusal("CCC_PLANNING_IMPORT_IDENTITY_DRIFT", "stored release differs from its sealed authorization");
    }
    return result;
  }
  if (anchor.state !== "importing" && anchor.state !== "awaiting_execution_authority") {
    throw new CccPlanningRefusal("CCC_PLANNING_STATE_TRANSITION_REFUSED", `cannot release a run in ${anchor.state}`);
  }
  const fence = await planningFence(layer, anchor, i.run.runId);
  const nativeInput = { store: i.store, rootDir: i.rootDir, taskId: i.entryTaskId, runId: i.run.runId };
  if (authorization === null) {
    await (i.deps?.issue ?? issueCccCampaignLiveExecutionApproval)(nativeInput);
    authorization = await getCccCampaignExecutionAuthorizationForImport(layer.db, link.receipt.importId);
    await i.hooks?.afterStep?.("issued");
  }
  if (authorization === null || !authorization.members.some((member) => member.nativeTaskId === i.entryTaskId)) {
    throw new CccPlanningRefusal("CCC_PLANNING_IMPORT_IDENTITY_DRIFT", "release requires the sealed authorization's entry task");
  }
  const confirmation = (i.deps?.compute ?? computeCccCampaignLiveExecutionApprovalConfirmation)(authorization);
  const permitsController = i.receipt.permittedProtectedActions.length === 1
    && i.receipt.permittedProtectedActions[0]!.kind === "live_execution"
    && i.receipt.permittedProtectedActions[0]!.release === "controller_within_receipt";
  const envelope = permitsController ? assertCccPlanningExecutionAuthorizationWithinReceipt({
    receipt: i.receipt, receiptSha256: i.receiptSha256, run: i.run, authorization,
    baseline: await i.observeBaseline(authorization.targetBase), now: (await readAnchor(layer, i)).now,
  }) : null;
  if (envelope === null || !envelope.ok) {
    if (anchor.state === "importing") {
      await transitionCccPlanningRunState(layer, { runId: i.run.runId, from: "importing", to: "awaiting_execution_authority",
        stateCode: "CCC_PLANNING_AWAITING_EXECUTION_AUTHORITY", fence });
    }
    return { kind: "awaiting_operator", authorizationId: authorization.authorizationId, confirmation,
      reason: envelope === null ? "receipt_requires_operator" : "envelope_mismatch",
      ...(envelope === null ? {} : { mismatch: { field: envelope.field, detail: envelope.detail } }) };
  }
  if (authorization.status === "issued") {
    await (i.deps?.approve ?? approveCccCampaignLiveExecution)({
      ...nativeInput, authorizationId: authorization.authorizationId, confirmation,
      actor: { actorId: "ccc-planning-controller", actorType: "system",
        actorName: `CCC planning receipt ${i.receiptSha256.slice(0, 12)}` },
    });
    await i.hooks?.afterStep?.("approved");
  }
  // The native gate checks persisted parent/child claims and leases; a dependency callback cannot grant authority.
  await requireCccCampaignLiveExecutionApproval(nativeInput);
  const result = { kind: "released", authorizationId: authorization.authorizationId,
    authorizationDigest: authorization.authorizationDigest } as const;
  await layer.transactionImmediate(async (tx) => {
    const published = await publishCccPlanningArtifactWithinTransaction(tx, anchor.project_id, {
      planningTaskId: anchor.planning_task_id, runId: i.run.runId, slot, kind: "live_execution_release",
      contentSchema: "ccc-planning.live-execution-release.v1", content: { type: "json", value: result },
      inputs: [{ artifactKey: receiptKey, digest: importArtifact.record.envelope.outputDigest }],
      producer: { kind: "controller", roleId: "controller", instanceId: cccPlanningImportKey(i.run.runId, i.run.runRevision) },
      policy: NO_POLICY, status: "complete", fence: { kind: "work_item_lease", workItemId: fence.workItemId,
        runId: fence.runId, leaseOwner: fence.leaseOwner, attempt: fence.attempt },
    });
    if (published.replayed) return;
    await transitionCccPlanningRunStateWithin(tx, { projectId: anchor.project_id, runId: i.run.runId,
      from: anchor.state, to: "building", stateCode: null, fence });
    const workItem = await i.store.getWorkflowWorkItem(authorization.workItemId);
    if (!workItem || (workItem.state !== "manual-required" && workItem.state !== "runnable")) {
      throw new CccPlanningRefusal("CCC_PLANNING_STATE_TRANSITION_REFUSED", "campaign work item is not awaiting release");
    }
    if (workItem.state === "manual-required") {
      await i.store.transitionWorkflowWorkItem(workItem.id, "runnable", { expectedState: "manual-required",
        expectedAttempt: workItem.attempt, attempt: workItem.attempt, leaseOwner: null, leaseExpiresAt: null,
        lastError: null, blockedReason: null }, tx);
    }
    await recordRunAuditEventWithinTransaction(tx, {
      taskId: anchor.planning_task_id, agentId: "ccc-planning-controller", runId: i.run.runId, domain: "database",
      mutationType: "ccc-planning:live-execution-released", target: authorization.authorizationId,
      eventId: cccPlanningEventId({ projectId: anchor.project_id, runId: i.run.runId,
        mutationType: "ccc-planning:live-execution-released", subject: authorization.authorizationId }),
      metadata: { receiptSha256: i.receiptSha256, authorizationId: authorization.authorizationId,
        authorizationDigest: authorization.authorizationDigest, memberCount: authorization.members.length },
    }, anchor.project_id);
  });
  await i.hooks?.afterStep?.("published");
  return result;
}
