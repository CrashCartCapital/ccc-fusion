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
  type DbTransaction,
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
const LIVE_APPROVAL_HOLD = "ccc-permanent:CCC_CAMPAIGN_LIVE_EXECUTION_APPROVAL_REQUIRED";

type CampaignItem = {
  id: string; state: string; attempt: number; blocked_reason: string | null; last_error: string | null;
  lease_owner: string | null; lease_expires_at: string | null; user_paused: number;
};
type CampaignPark = { workItemId: string; importId: string; attempt: number; marker: string };

async function lockCampaignItem(tx: DbTransaction, projectId: string, workItemId: string, importId: string): Promise<CampaignItem> {
  const rows = await tx.execute(sql`
    SELECT w.id, w.state, w.attempt, w.blocked_reason, w.last_error, w.lease_owner, w.lease_expires_at,
      COALESCE(t.user_paused, 0) AS user_paused
      FROM project.workflow_work_items w JOIN project.tasks t ON t.project_id = w.project_id AND t.id = w.task_id
      WHERE w.project_id = ${projectId} AND w.id = ${workItemId} AND w.run_id = ${`ccc-prd:${importId}`}
      FOR UPDATE OF w
  `) as unknown as CampaignItem[];
  const item = rows[0];
  if (rows.length !== 1 || !item || item.user_paused !== 0 || item.lease_owner !== null || item.lease_expires_at !== null) {
    throw new CccPlanningRefusal("CCC_PLANNING_STATE_TRANSITION_REFUSED", "campaign item is paused, leased or outside the import");
  }
  return item;
}

/** Repair 1: claim only after a durable park; never adopt an unrelated manual hold or a later attempt. */
async function parkCampaignItem(layer: AsyncDataLayer, i: ReleaseInput, projectId: string,
  workItemId: string, importId: string): Promise<CampaignPark> {
  return layer.transactionImmediate(async (tx) => {
    const item = await lockCampaignItem(tx, projectId, workItemId, importId);
    const marker = `${LIVE_APPROVAL_HOLD}: ccc-planning:${i.run.runId}:r${i.run.runRevision}:a${item.attempt}`;
    if (item.state === "manual-required" && item.blocked_reason === LIVE_APPROVAL_HOLD && item.last_error === marker) {
      return { workItemId, importId, attempt: item.attempt, marker };
    }
    const nativeHold = item.state === "manual-required"
      && item.blocked_reason === LIVE_APPROVAL_HOLD && item.last_error === LIVE_APPROVAL_HOLD;
    const fresh = item.state === "runnable" && item.blocked_reason === null && item.last_error === null;
    if (!fresh && !nativeHold) {
      throw new CccPlanningRefusal("CCC_PLANNING_STATE_TRANSITION_REFUSED", "campaign item is not a fresh import or native live-approval hold");
    }
    await i.store.transitionWorkflowWorkItem(workItemId, "manual-required", {
      expectedState: fresh ? "runnable" : "manual-required", expectedAttempt: item.attempt, expectedLeaseOwner: null,
      attempt: item.attempt, leaseOwner: null, leaseExpiresAt: null, lastError: marker, blockedReason: LIVE_APPROVAL_HOLD,
    }, tx);
    return { workItemId, importId, attempt: item.attempt, marker };
  });
}

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
 * FNXC:CccPlanningLiveRelease 2026-10-15-06:00 (repair 1): native imports begin runnable. Park the exact imported item
 * durably before claiming approval, then wake only that park's same attempt under a row lock in the publication
 * transaction. Operator holds, foreign leases, running/terminal states and changed attempts fail closed. Keep the
 * native blocked reason; the ownership marker is its permitted lastError suffix, so operator approval stays usable.
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
  const issuedNow = authorization === null;
  if (authorization === null) {
    await (i.deps?.issue ?? issueCccCampaignLiveExecutionApproval)(nativeInput);
    authorization = await getCccCampaignExecutionAuthorizationForImport(layer.db, link.receipt.importId);
  }
  if (authorization === null || !authorization.members.some((member) => member.nativeTaskId === i.entryTaskId)) {
    throw new CccPlanningRefusal("CCC_PLANNING_IMPORT_IDENTITY_DRIFT", "release requires the sealed authorization's entry task");
  }
  const park = await parkCampaignItem(layer, i, anchor.project_id, authorization.workItemId, link.receipt.importId);
  if (issuedNow) await i.hooks?.afterStep?.("issued");
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
    const workItem = await lockCampaignItem(tx, anchor.project_id, park.workItemId, park.importId);
    if (workItem.state !== "manual-required" || workItem.attempt !== park.attempt
      || workItem.blocked_reason !== LIVE_APPROVAL_HOLD || workItem.last_error !== park.marker) {
      throw new CccPlanningRefusal("CCC_PLANNING_STATE_TRANSITION_REFUSED", "campaign work item no longer holds this release's park");
    }
    await i.store.transitionWorkflowWorkItem(workItem.id, "runnable", { expectedState: "manual-required",
      expectedAttempt: park.attempt, expectedLeaseOwner: null, attempt: park.attempt, leaseOwner: null, leaseExpiresAt: null,
      lastError: null, blockedReason: null }, tx);
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
