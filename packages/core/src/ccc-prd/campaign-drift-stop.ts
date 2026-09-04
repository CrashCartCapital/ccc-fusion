import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import * as schema from "../postgres/schema/index.js";
import type { AsyncDataLayer } from "../postgres/data-layer.js";
import {
  inspectCccCampaignCustodyDrift,
  type CccCampaignCustodyRecord,
} from "../ccc-campaign/custody.js";
import { canonicalCccPrdJson } from "./contract.js";
import { CccPrdImportError } from "./import-error.js";
import { CCC_PRD_IMPORT_STOPPED_STATE } from "./importer.js";
import { physicalCccPrdImportRoot } from "./import-admission.js";

/**
 * Closing a campaign whose persisted custody no longer reconstructs.
 *
 * `fn prd stop` asks for a fresh product status, and product status rebuilds
 * campaign custody from the stored manifest. A campaign imported by a copier
 * that has since been replaced fails that rebuild, so the stop it needs is the
 * one command it can never reach. The campaign then sits active forever and
 * every reconcile re-projects its task directories into the owner's repository.
 *
 * This module is the way out. It reads only columns the import row already
 * holds, proves the drift with the unchanged custody reconstruction, and
 * refuses outright for any campaign whose custody is intact. It never disposes
 * a worktree, deletes a branch, resolves an approval, or closes an execution
 * authorization; every unresolved effect is left exactly where the operator can
 * still inspect it.
 */

export const CCC_PRD_CAMPAIGN_DRIFT_STOP_PLAN_SCHEMA =
  "ccc-prd.campaign-drift-stop-plan.v1";

export type CccPrdCampaignDriftStopWorkItem = Readonly<{
  id: string;
  runId: string;
  stableWorkflowRunId: string;
  kind: string;
  state: string;
  attempt: number;
}>;

export type CccPrdCampaignDriftStopPlan = Readonly<{
  schema: typeof CCC_PRD_CAMPAIGN_DRIFT_STOP_PLAN_SCHEMA;
  projectId: string;
  importId: string;
  idempotencyKey: string;
  importState: string;
  targetRepository: string;
  /** Verbatim refusal from `reconstructCccCampaignCustody`. */
  driftReason: string;
  workItem: CccPrdCampaignDriftStopWorkItem;
  taskIds: readonly string[];
}>;

export type PlanCccPrdCampaignDriftStopInput = Readonly<{
  layer: AsyncDataLayer;
  rootDir: string;
  idempotencyKey: string;
}>;

/** Work-item states nothing transitions out of. */
const TERMINAL_WORK_ITEM_STATES: ReadonlySet<string> = new Set([
  "cancelled",
  "completed",
  "failed",
]);

/**
 * Whether this work item may be closed by the drifted-campaign path.
 *
 * Three refusals, in the order that matters.
 *
 * Custody: the item must be exactly this import's, matched the same way the
 * ordinary operator control matches it.
 *
 * Lease: the ordinary control refuses any item the runtime still owns, and
 * reaches that check through a product status this path cannot build. A null
 * lease owner is not proof the lease is gone, so a lease expiry or a running
 * state refuses just as an owner does.
 *
 * Terminal: a second close would overwrite the first one's recorded stop
 * reason. That reason is the only durable record of why the campaign was ended,
 * so it is written once and never rewritten.
 */
export function assertCccPrdCampaignDriftStopWorkItem(
  workItem: Readonly<{
    id: string;
    kind: string;
    state: string;
    attempt: number;
    stableWorkflowRunId: string | null;
    leaseOwner: string | null;
    leaseExpiresAt: string | null;
  }>,
  runId: string,
): void {
  if (
    workItem.kind !== "task"
    || workItem.stableWorkflowRunId !== runId
    || !Number.isSafeInteger(workItem.attempt)
    || workItem.attempt < 0
  ) {
    throw new CccPrdImportError(
      "CCC_PRD_CAMPAIGN_DRIFT_STOP_CUSTODY_REFUSED",
      `Workflow work item ${workItem.id} does not match exact imported campaign custody.`,
    );
  }
  if (TERMINAL_WORK_ITEM_STATES.has(workItem.state)) {
    throw new CccPrdImportError(
      "CCC_PRD_CAMPAIGN_DRIFT_STOP_ALREADY_TERMINAL",
      `Workflow work item ${workItem.id} is already ${workItem.state}; its recorded stop reason will not be overwritten.`,
    );
  }
  if (
    workItem.leaseOwner !== null
    || workItem.leaseExpiresAt !== null
    || workItem.state === "running"
  ) {
    throw new CccPrdImportError(
      "CCC_PRD_CAMPAIGN_DRIFT_STOP_LEASED",
      `Workflow work item ${workItem.id} still has runtime lease custody; wait for the next unleased safe boundary.`,
    );
  }
}

function projectIdFor(layer: AsyncDataLayer): string {
  return layer.projectId?.trim() || "__legacy_unscoped__";
}

/**
 * The identity an operator confirms before a drifted campaign is closed.
 *
 * It covers the drift reason as well as the rows to be written, so a
 * confirmation cannot be replayed against a campaign whose custody has since
 * been repaired or whose work item has moved.
 */
export function computeCccPrdCampaignDriftStopConfirmation(
  plan: CccPrdCampaignDriftStopPlan,
): string {
  return createHash("sha256")
    .update(
      canonicalCccPrdJson({
        action: "stop-drifted",
        schema: plan.schema,
        projectId: plan.projectId,
        importId: plan.importId,
        idempotencyKey: plan.idempotencyKey,
        importState: plan.importState,
        targetRepository: plan.targetRepository,
        driftReason: plan.driftReason,
        workItem: plan.workItem,
        taskIds: [...plan.taskIds].sort(),
      }),
      "utf8",
    )
    .digest("hex");
}

/**
 * Builds the close plan for a drifted campaign, or refuses.
 *
 * Returns null when no import matches the key. Throws when the campaign's
 * custody still reconstructs: a healthy campaign must be stopped through the
 * ordinary operator control, which carries the full status the drifted path
 * cannot produce.
 */
export async function planCccPrdCampaignDriftStop(
  input: PlanCccPrdCampaignDriftStopInput,
): Promise<CccPrdCampaignDriftStopPlan | null> {
  const rootDir = await physicalCccPrdImportRoot(input.rootDir);
  const projectId = projectIdFor(input.layer);
  return input.layer.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(schema.project.cccPrdImports)
      .where(and(
        eq(schema.project.cccPrdImports.projectId, projectId),
        eq(schema.project.cccPrdImports.idempotencyKey, input.idempotencyKey),
      ))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    if (row.rootDir !== rootDir) {
      throw new CccPrdImportError(
        "CCC_PRD_IMPORT_ROOT_MISMATCH",
        `CCC PRD import ${row.importId} belongs to ${row.rootDir}, not ${rootDir}`,
      );
    }
    if (row.state === CCC_PRD_IMPORT_STOPPED_STATE) {
      throw new CccPrdImportError(
        "CCC_PRD_IMPORT_STOPPED",
        `CCC PRD import ${JSON.stringify(input.idempotencyKey)} is already terminally stopped`,
      );
    }

    const drift = inspectCccCampaignCustodyDrift(
      row as unknown as CccCampaignCustodyRecord,
    );
    if (!drift.drifted) {
      throw new CccPrdImportError(
        "CCC_PRD_CAMPAIGN_CUSTODY_INTACT",
        `CCC PRD import ${JSON.stringify(input.idempotencyKey)} reconstructs its campaign custody; stop it through the ordinary operator control instead`,
      );
    }

    const entities = await tx
      .select()
      .from(schema.project.cccPrdImportEntities)
      .where(and(
        eq(schema.project.cccPrdImportEntities.projectId, projectId),
        eq(schema.project.cccPrdImportEntities.importId, row.importId),
      ));
    const taskIds = entities
      .filter((entity) => entity.entityType === "task")
      .sort((left, right) => left.ordinal - right.ordinal)
      .map((entity) => entity.nativeId);

    const runId = `ccc-prd:${row.importId}`;
    const workItems = await tx
      .select()
      .from(schema.project.workflowWorkItems)
      .where(and(
        eq(schema.project.workflowWorkItems.projectId, projectId),
        eq(schema.project.workflowWorkItems.runId, runId),
      ));
    if (workItems.length !== 1) {
      throw new CccPrdImportError(
        "CCC_PRD_CAMPAIGN_DRIFT_STOP_WORK_ITEM_AMBIGUOUS",
        `Closing a drifted campaign requires exactly one imported workflow work item for ${runId}; found ${workItems.length}.`,
      );
    }
    const workItem = workItems[0]!;
    assertCccPrdCampaignDriftStopWorkItem(workItem, runId);

    return {
      schema: CCC_PRD_CAMPAIGN_DRIFT_STOP_PLAN_SCHEMA,
      projectId,
      importId: row.importId,
      idempotencyKey: row.idempotencyKey,
      importState: row.state,
      targetRepository: row.targetRepository,
      driftReason: drift.reason,
      workItem: {
        id: workItem.id,
        runId: workItem.runId,
        // The guard above proved this equals runId, which TypeScript cannot see
        // through the call.
        stableWorkflowRunId: runId,
        kind: workItem.kind,
        state: workItem.state,
        attempt: workItem.attempt,
      },
      taskIds,
    } satisfies CccPrdCampaignDriftStopPlan;
  });
}

export type MarkCccPrdImportStoppedInput = Readonly<{
  layer: AsyncDataLayer;
  idempotencyKey: string;
  /** Recorded verbatim on the row so the closure survives without custody. */
  stoppedReason: string;
}>;

/**
 * Moves the import row to its terminal state.
 *
 * This is what stops re-projection: `reconcileCccPrdImport` and a replayed
 * `importCccPrdBundle` both refuse a stopped row, so the campaign's task
 * directories are never written back into the owner's repository again.
 */
export async function markCccPrdImportStopped(
  input: MarkCccPrdImportStoppedInput,
): Promise<void> {
  const projectId = projectIdFor(input.layer);
  const now = new Date().toISOString();
  await input.layer.transaction(async (tx) => {
    await tx
      .update(schema.project.cccPrdImports)
      .set({
        state: CCC_PRD_IMPORT_STOPPED_STATE,
        runnable: 0,
        projectionOwner: null,
        projectionLeaseUntil: null,
        lastError: input.stoppedReason.slice(0, 2_000),
        updatedAt: now,
      })
      .where(and(
        eq(schema.project.cccPrdImports.projectId, projectId),
        eq(schema.project.cccPrdImports.idempotencyKey, input.idempotencyKey),
      ));
  });
}
