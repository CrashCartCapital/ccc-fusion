/*
FNXC:CccPlanningAdmission 2026-10-14-20:58:
The admission transaction of a request-to-code run (CONTRACT-v3 section 2.11, card AD1; G0 step 15). One PostgreSQL
transaction writes, in foreign-key-safe order: (1) the held planning task, (2) the anchor in state `admitted`, whose
composite foreign key needs the task first, (3) the planning workflow with the K1 IR and the task's workflow selection,
(4) the planning work item, pinned to the hash of that IR, (5) the three admission artifacts through A1's publisher
under the admission fence, and (6) the `admitted` state event. Any failure, an injected `afterStep` failure included,
rolls back every row, so a run either exists completely or not at all.

Decisions worth stating where the code is:
- The run id is K1's `cccPlanningRunId` over the receipt's project, the receipt's request digest and the receipt
  sha256 (E5-K2 item 4, E8-W3), the derivation K2's envelope check binds a run to, so a run admitted here always passes
  that binding for its own receipt. Because the receipt sha256 is part of the run id, a reused receipt collides on the
  anchor key or on the receipt's unique key; either one is `CCC_PLANNING_AUTHORITY_RECEIPT_CONSUMED`, and the race
  between two admissions of one receipt is settled by PostgreSQL, not by a read before the write.
- The input's parts must agree with each other and with the layer's project before anything is written: the caller
  (G0) already proved each fact, so a disagreement is a caller bug and refuses `CCC_PLANNING_INTERNAL_ERROR` naming the
  field. This also closes a receipt for one project being admitted into another, where the per-project receipt key
  could not see the reuse.
- The held task is the K1 marker shape (lineage = run id, paused, not user-paused) in `triage`, which triage excludes
  for a `ccc-plan:` lineage; status and pause reason carry the machine-readable `ccc-planning-held`, following the
  `ccc-prd-import-prepared` precedent. The work item is `runnable` at the first stage node, so the existing acquire path
  picks the run up (D3); its id and the workflow id are derived from the run id.
- The `admitted` state event has no prior state, so its section 2.1 subject `${from}->${to}@${OLD.updated_at}` is read
  as `->admitted@<created_at>`, with `from: null` in the metadata.
*/
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { canonicalCccPrdJson } from "../ccc-prd/contract.js";
import * as schema from "../postgres/schema/index.js";
import {
  projectOwnershipPartition,
  recordRunAuditEventWithinTransaction,
  type AsyncDataLayer,
  type DbTransaction,
} from "../postgres/data-layer.js";
import type { CccPlanningLiveAuthorityReceiptV1 } from "../ccc-planning/authority.js";
import { CccPlanningRefusal, cccPlanningRefusalFromDatabaseError } from "../ccc-planning/errors.js";
import { cccPlanningEventId, cccPlanningGrantDigest, cccPlanningRunId } from "../ccc-planning/policy.js";
import { buildCccPlanningWorkflowIr, cccPlanningWorkflowIrHash } from "../ccc-planning/workflow-ir.js";
import {
  CCC_PLANNING_IR_STAGES,
  type CccPlanningBudgetProfile,
  type CccPlanningGrantV1,
  type CccPlanningMode,
  type CccPlanningRunCustody,
} from "../ccc-planning/types.js";
import { allocateCommittedTaskIdsInTransaction } from "./async-allocator.js";
import { publishCccPlanningArtifactWithinTransaction, type PublishCccPlanningArtifactInput } from "./ccc-planning-artifact-ops.js";

export type CccPlanningAdmissionInput = Readonly<{
  projectId: string; mode: CccPlanningMode; budgetProfile: CccPlanningBudgetProfile;
  request: Readonly<{ bytes: Uint8Array; sha256: string }>;
  receipt: CccPlanningLiveAuthorityReceiptV1; receiptSha256: string; receiptCanonicalJson: string;
  runtimeDistManifestSha256: string; targetRepository: string; admittedBase: string;
  grant: CccPlanningGrantV1; policyDigest: string; plannedLeaves: 0;
}>;

type AdmissionStep = "task" | "anchor" | "workflow" | "work-item" | "artifacts";

const CONTROLLER_AGENT = "ccc-planning-controller";
const HELD = "ccc-planning-held";
const RECEIPT_CONSUMED_CONSTRAINTS: ReadonlySet<string> = new Set([
  "ccc_planning_runs_pkey", "ccc_planning_runs_authority_receipt_unique",
]);
const MAX_CAUSE_DEPTH = 4;
const NO_POLICY = { promptVersion: "none", promptDigest: "none", toolPolicyVersion: "none", toolPolicyDigest: "none" } as const;

function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function disagree(field: string, detail: string): never {
  throw new CccPlanningRefusal("CCC_PLANNING_INTERNAL_ERROR", `admission input disagrees: ${detail}`, field);
}

/** Every part of the input must name the same run facts as the receipt and the layer's project; nothing is written yet. */
function assertInputAgrees(layer: AsyncDataLayer, input: CccPlanningAdmissionInput): void {
  const { receipt, grant } = input;
  if (input.projectId !== projectOwnershipPartition(layer.projectId)) {
    disagree("projectId", `project ${input.projectId} is not the layer's project`);
  }
  if (receipt.project.projectId !== input.projectId) disagree("receipt.project.projectId", "the receipt names another project");
  if (sha256Hex(input.request.bytes) !== input.request.sha256 || input.request.sha256 !== receipt.request.sha256
    || input.request.bytes.byteLength !== receipt.request.byteLength) {
    disagree("request.sha256", "the request bytes, their digest and the receipt's request do not match");
  }
  if (canonicalCccPrdJson(receipt) !== input.receiptCanonicalJson) {
    disagree("receiptCanonicalJson", "the canonical receipt JSON is not the receipt's canonical form");
  }
  if (sha256Hex(input.receiptCanonicalJson) !== input.receiptSha256) disagree("receiptSha256", "the receipt digest does not match its bytes");
  if (input.mode !== receipt.mode) disagree("mode", "the mode is not the receipt's mode");
  if (input.budgetProfile !== receipt.budgetProfile) disagree("budgetProfile", "the budget profile is not the receipt's");
  if (grant.mode !== input.mode) disagree("grant.mode", "the grant is for another mode");
  if (grant.budgetProfile !== input.budgetProfile) disagree("grant.budgetProfile", "the grant is for another budget profile");
  if (grant.amendmentSeq !== 0) disagree("grant.amendmentSeq", "an admission grant has amendment sequence 0");
  if (input.targetRepository !== receipt.target.repositoryRealpath) disagree("targetRepository", "the target is not the receipt's repository");
  if (input.admittedBase !== receipt.target.baseCommit) disagree("admittedBase", "the base is not the receipt's base commit");
  if (input.runtimeDistManifestSha256 !== receipt.runtime.distManifestSha256) {
    disagree("runtimeDistManifestSha256", "the runtime dist manifest is not the receipt's");
  }
  if (input.plannedLeaves !== 0) disagree("plannedLeaves", "admission plans zero research leaves");
}

function causeChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current: unknown = error;
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH && current !== undefined && current !== null; depth += 1) {
    chain.push(current);
    current = (current as { cause?: unknown }).cause;
  }
  return chain;
}

/** A unique violation of the anchor key or the receipt key: this receipt already admitted a run in this project. */
function isReceiptConsumed(error: unknown): boolean {
  return causeChain(error).some((link) => {
    const candidate = link as { code?: unknown; constraint_name?: unknown };
    return candidate.code === "23505" && typeof candidate.constraint_name === "string"
      && RECEIPT_CONSUMED_CONSTRAINTS.has(candidate.constraint_name);
  });
}

async function databaseNow(tx: DbTransaction): Promise<string> {
  const result = (await tx.execute(sql`
    SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now
  `)) as unknown as Array<{ now: string }>;
  return result[0]!.now;
}

function admissionArtifacts(input: CccPlanningAdmissionInput, runId: string, planningTaskId: string, now: string):
  PublishCccPlanningArtifactInput[] {
  const common = {
    planningTaskId, runId, inputs: [], policy: NO_POLICY, status: "complete", fence: { kind: "admission" }, now,
    producer: { kind: "controller", roleId: "controller", instanceId: `controller:admission:${runId}` },
  } as const;
  const slot = (name: string) => ({ runRevision: 1, stageId: "admission", slot: name, version: 1 }) as const;
  return [
    { ...common, slot: slot("request"), kind: "original_request", contentSchema: "ccc-planning.original-request.v1",
      content: { type: "text", bytes: input.request.bytes } },
    { ...common, slot: slot("grant"), kind: "admission_grant", contentSchema: input.grant.schema,
      content: { type: "json", value: input.grant } },
    { ...common, slot: slot("receipt"), kind: "authority_receipt", contentSchema: input.receipt.schema,
      content: { type: "json", value: input.receipt } },
  ];
}

export async function admitCccPlanningRun(layer: AsyncDataLayer, input: CccPlanningAdmissionInput,
  hooks?: Readonly<{ afterStep?: (step: AdmissionStep) => Promise<void> }>): Promise<CccPlanningRunCustody> {
  assertInputAgrees(layer, input);
  const projectId = input.projectId;
  const runId = cccPlanningRunId({
    projectId: input.receipt.project.projectId, requestDigest: input.receipt.request.sha256, receiptSha256: input.receiptSha256,
  });
  const runHex = runId.slice("ccc-plan:".length);
  const workflowId = `ccc-plan-${runHex}--workflow`;
  const workItemId = `ccc-plan-${runHex}--work-item`;
  const grantDigest = cccPlanningGrantDigest(input.grant);
  const ir = buildCccPlanningWorkflowIr(input.mode);
  const afterStep = async (step: AdmissionStep): Promise<void> => {
    if (hooks?.afterStep) await hooks.afterStep(step);
  };

  try {
    return await layer.transactionImmediate(async (tx) => {
      const now = await databaseNow(tx);

      // (1) The held planning task: the K1 marker shape, in triage (which skips a ccc-plan: lineage).
      const [planningTaskId] = await allocateCommittedTaskIdsInTransaction(tx, {
        projectId, nodeId: `ccc-planning-admission:${runId}`, count: 1, now,
      });
      if (planningTaskId === undefined) {
        throw new CccPlanningRefusal("CCC_PLANNING_INTERNAL_ERROR", "task id allocation returned no id", "planningTaskId");
      }
      await tx.insert(schema.project.tasks).values({
        projectId, id: planningTaskId, lineageId: runId, title: `Request-to-code ${input.mode} planning run ${runId}`,
        description: `Request-to-code planning run ${runId} (${input.mode}, ${input.budgetProfile}); held by the run until it ends.`,
        column: "triage", status: HELD, paused: 1, userPaused: 0, pausedReason: HELD, createdAt: now, updatedAt: now,
      });
      await afterStep("task");

      // (2) The anchor, state admitted, zero counters; its composite foreign key needs the task above.
      await tx.insert(schema.cccPlanningRuns).values({
        projectId, runId, planningTaskId: planningTaskId, mode: input.mode, budgetProfile: input.budgetProfile,
        roleProfile: input.receipt.profile, policyVersion: input.grant.budgetPolicyVersion, policyDigest: input.policyDigest,
        requestDigest: input.request.sha256, requestBytes: input.request.bytes.byteLength,
        targetRepository: input.targetRepository, admittedBase: input.admittedBase, grantDigest,
        authorityReceiptSha256: input.receiptSha256, authorityReceiptJson: input.receiptCanonicalJson,
        runtimeDistManifestSha256: input.runtimeDistManifestSha256, amendmentSeq: 0, revision: 1, state: "admitted",
        deadlineAt: input.grant.deadlineAt, planningAllocation: input.grant.allocations.planning,
        implementationAllocation: input.grant.allocations.implementation,
        reviewProofAllocation: input.grant.allocations.reviewProof, researchFetchAllocation: input.grant.research.fetches,
        researchBytesAllocation: input.grant.research.bytes, createdAt: now, updatedAt: now,
      });
      await afterStep("anchor");

      // (3) The planning workflow with the K1 IR pinned, and the task's selection of it (the importer's pattern).
      await tx.insert(schema.project.workflows).values({
        id: workflowId, name: `ccc-planning-${input.mode} ${runId}`, description: `Request-to-code planning run ${runId}`,
        ir, layout: {}, kind: "workflow", createdAt: now, updatedAt: now,
      });
      await tx.insert(schema.project.taskWorkflowSelection).values({
        projectId, taskId: planningTaskId, workflowId, stepIds: [], updatedAt: now,
      });
      await afterStep("workflow");

      // (4) The planning work item, pinned to the hash of that IR; H1 re-checks the hash at every stage start.
      await tx.insert(schema.project.workflowWorkItems).values({
        projectId, id: workItemId, runId, taskId: planningTaskId, nodeId: CCC_PLANNING_IR_STAGES[0], kind: "task",
        state: "runnable", attempt: 0, stableWorkflowRunId: runId, irHash: cccPlanningWorkflowIrHash(ir),
        createdAt: now, updatedAt: now,
      });
      await afterStep("work-item");

      // (5) The admission artifacts, through A1's publisher under the admission fence (trigger 0043 admits it while
      // the anchor is admitted). Each artifact's digest equals the anchor's digest of the same fact.
      for (const artifact of admissionArtifacts(input, runId, planningTaskId, now)) {
        await publishCccPlanningArtifactWithinTransaction(tx, projectId, artifact);
      }
      await afterStep("artifacts");

      // (6) The admitted state event.
      await recordRunAuditEventWithinTransaction(tx, {
        timestamp: now, taskId: planningTaskId, agentId: CONTROLLER_AGENT, runId, domain: "database",
        mutationType: "ccc-planning:state", target: `->admitted@${now}`,
        metadata: { schema: "ccc-planning-state/v1", runId, revision: 1, from: null, to: "admitted", stateCode: null, controlSeq: 0 },
        eventId: cccPlanningEventId({ projectId, runId, mutationType: "ccc-planning:state", subject: `->admitted@${now}` }),
      }, projectId);

      return {
        kind: "planning", projectId, runId, planningTaskId: planningTaskId, revision: 1, state: "admitted",
        mode: input.mode, budgetProfile: input.budgetProfile, deadlineAt: input.grant.deadlineAt, grantDigest,
        controlSeq: 0, importId: null, runtimeDistManifestSha256: input.runtimeDistManifestSha256,
      };
    });
  } catch (error) {
    if (error instanceof CccPlanningRefusal) throw error;
    if (isReceiptConsumed(error)) {
      throw new CccPlanningRefusal("CCC_PLANNING_AUTHORITY_RECEIPT_CONSUMED",
        `receipt ${input.receiptSha256} already admitted a run in project ${projectId}`, "receipt");
    }
    throw cccPlanningRefusalFromDatabaseError(error) ?? error;
  }
}
