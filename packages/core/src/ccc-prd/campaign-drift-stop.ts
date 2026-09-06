import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import * as schema from "../postgres/schema/index.js";
import type { AsyncDataLayer, DbTransaction } from "../postgres/data-layer.js";
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
 * This module reaches that campaign directly. It reads only columns the
 * import row already holds and proves drift with the unchanged custody
 * reconstruction, and refuses outright (`CCC_PRD_CAMPAIGN_CUSTODY_INTACT`)
 * for any campaign whose custody still reconstructs -- whatever state its
 * workflow work item is in. A campaign whose custody is intact can always
 * reach `fn prd stop`, which handles its own separate gap: once that one
 * workflow work item has reached `failed` or `cancelled` on its own (a proof
 * that was proved failed, for instance), there is nothing left to cancel, so
 * the ordinary stop control closes the import instead of refusing it.
 *
 * This module never disposes a worktree, deletes a branch, resolves an
 * approval, or closes an execution authorization; every unresolved effect is
 * left exactly where the operator can still inspect it.
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
  /** Recorded verbatim into the close-out reason; never overwritten. */
  lastError: string | null;
  blockedReason: string | null;
}>;

/**
 * `"cancel"` transitions the workflow work item to `cancelled` and pauses its
 * tasks, exactly as before.
 *
 * `"close-out"` writes only the import row. The workflow work item has
 * already ended terminally (`failed` or `cancelled`) on its own; there is
 * nothing to cancel, and touching it would overwrite the only durable record
 * of why it ended. Its `lastError`/`blockedReason` are carried through
 * verbatim instead.
 */
export type CccPrdCampaignDriftStopPlanKind = "cancel" | "close-out";

export type CccPrdCampaignDriftStopPlan = Readonly<{
  schema: typeof CCC_PRD_CAMPAIGN_DRIFT_STOP_PLAN_SCHEMA;
  kind: CccPrdCampaignDriftStopPlanKind;
  projectId: string;
  importId: string;
  idempotencyKey: string;
  importState: string;
  targetRepository: string;
  /**
   * Verbatim refusal from `reconstructCccCampaignCustody` when the campaign
   * is drifted. For a close-out reached with intact custody (an already
   * terminal work item under a healthy import), this instead names the
   * terminal work-item state so the confirmation still binds to why the
   * campaign is being closed.
   */
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
 * The terminal-with-failure states a close-out may end an import for. This is
 * narrower than `TERMINAL_WORK_ITEM_STATES`: a `completed` work item ended by
 * succeeding, not failing, and closing that path stays refused so a
 * successful campaign is never silently swept into a failure receipt.
 */
const CLOSE_OUT_ELIGIBLE_STATES: ReadonlySet<string> = new Set([
  "cancelled",
  "failed",
]);

/**
 * Whether this work item matches exactly this import's custody: the same
 * match the ordinary operator control performs, reachable here without the
 * product status that control needs to build it.
 */
export function assertCccPrdCampaignDriftStopWorkItemCustody(
  workItem: Readonly<{
    id: string;
    kind: string;
    attempt: number;
    stableWorkflowRunId: string | null;
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
}

/**
 * Whether this work item may be cancelled by the drifted-campaign path.
 *
 * Three refusals, in the order that matters.
 *
 * Custody: the item must be exactly this import's, matched the same way the
 * ordinary operator control matches it.
 *
 * Terminal: a second close would overwrite the first one's recorded stop
 * reason. That reason is the only durable record of why the campaign was ended,
 * so it is written once and never rewritten. (A terminal-with-failure work
 * item is not refused here in every case: `planCccPrdCampaignDriftStop`
 * routes those to a close-out plan before this guard runs, so reaching this
 * check with a terminal state means the work item is `completed`.)
 *
 * Lease: the ordinary control refuses any item the runtime still owns, and
 * reaches that check through a product status this path cannot build. A null
 * lease owner is not proof the lease is gone, so a lease expiry or a running
 * state refuses just as an owner does.
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
  assertCccPrdCampaignDriftStopWorkItemCustody(workItem, runId);
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
 * It covers the plan kind, the drift reason, and the rows to be written, so a
 * confirmation cannot be replayed against a campaign whose custody has since
 * been repaired, whose work item has moved, or whose close would take a
 * different shape (cancel vs. close-out).
 */
export function computeCccPrdCampaignDriftStopConfirmation(
  plan: CccPrdCampaignDriftStopPlan,
): string {
  return createHash("sha256")
    .update(
      canonicalCccPrdJson({
        action: "stop-drifted",
        schema: plan.schema,
        kind: plan.kind,
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

type ImportRow = typeof schema.project.cccPrdImports.$inferSelect;

async function taskIdsForImport(
  tx: DbTransaction,
  projectId: string,
  importId: string,
): Promise<readonly string[]> {
  const entities = await tx
    .select()
    .from(schema.project.cccPrdImportEntities)
    .where(and(
      eq(schema.project.cccPrdImportEntities.projectId, projectId),
      eq(schema.project.cccPrdImportEntities.importId, importId),
    ));
  return entities
    .filter((entity) => entity.entityType === "task")
    .sort((left, right) => left.ordinal - right.ordinal)
    .map((entity) => entity.nativeId);
}

/**
 * Builds the resumed plan for an import already marked `stopped`.
 *
 * A prior close writes the import row first and the work-item cancel second
 * (see `applyCccCampaignDriftStop`), so a failure between those two writes
 * leaves the import terminally stopped with a work item that never got
 * cancelled. Re-running `stop-drifted` must finish that cancel rather than
 * refuse outright, or the campaign is permanently half-closed.
 *
 * Three distinct outcomes, not one collapsed refusal: zero or more than one
 * matching work item is `CCC_PRD_CAMPAIGN_DRIFT_STOP_WORK_ITEM_AMBIGUOUS` --
 * the same custody ambiguity a fresh plan refuses, and never mistaken for a
 * closed campaign. Exactly one work item that already reached its own
 * terminal state is `CCC_PRD_IMPORT_STOPPED`: the campaign is fully closed
 * already, and this refusal is idempotent. Only a single non-terminal work
 * item has anything left to finish.
 */
async function resumedDriftStopPlan(
  tx: DbTransaction,
  projectId: string,
  row: ImportRow,
  idempotencyKey: string,
): Promise<CccPrdCampaignDriftStopPlan> {
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
  if (TERMINAL_WORK_ITEM_STATES.has(workItem.state)) {
    throw new CccPrdImportError(
      "CCC_PRD_IMPORT_STOPPED",
      `CCC PRD import ${JSON.stringify(idempotencyKey)} is already terminally stopped`,
    );
  }
  assertCccPrdCampaignDriftStopWorkItem(workItem, runId);
  const taskIds = await taskIdsForImport(tx, projectId, row.importId);
  const drift = inspectCccCampaignCustodyDrift(
    row as unknown as CccCampaignCustodyRecord,
  );
  return {
    schema: CCC_PRD_CAMPAIGN_DRIFT_STOP_PLAN_SCHEMA,
    kind: "cancel",
    projectId,
    importId: row.importId,
    idempotencyKey: row.idempotencyKey,
    importState: row.state,
    targetRepository: row.targetRepository,
    driftReason: drift.drifted
      ? drift.reason
      : "campaign import is already terminally stopped; finishing an interrupted close",
    workItem: {
      id: workItem.id,
      runId: workItem.runId,
      stableWorkflowRunId: runId,
      kind: workItem.kind,
      state: workItem.state,
      attempt: workItem.attempt,
      lastError: workItem.lastError ?? null,
      blockedReason: workItem.blockedReason ?? null,
    },
    taskIds,
  } satisfies CccPrdCampaignDriftStopPlan;
}

/**
 * Builds the close plan for a drifted campaign or an already-terminal work
 * item, or refuses.
 *
 * Returns null when no import matches the key. Throws when the campaign's
 * custody still reconstructs AND its workflow work item has not already
 * ended terminally: a healthy, still-running campaign must be stopped through
 * the ordinary operator control, which carries the full status this path
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
      return resumedDriftStopPlan(tx, projectId, row, input.idempotencyKey);
    }

    const drift = inspectCccCampaignCustodyDrift(
      row as unknown as CccCampaignCustodyRecord,
    );
    if (!drift.drifted) {
      // Intact custody means the ordinary operator control can build a full
      // product status and reach every one of its own checks -- terminal
      // work item or not. This path exists only for a campaign that control
      // can never reach.
      throw new CccPrdImportError(
        "CCC_PRD_CAMPAIGN_CUSTODY_INTACT",
        `CCC PRD import ${JSON.stringify(input.idempotencyKey)} reconstructs its campaign custody; stop it through the ordinary operator control instead`,
      );
    }

    const taskIds = await taskIdsForImport(tx, projectId, row.importId);

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

    if (CLOSE_OUT_ELIGIBLE_STATES.has(workItem.state)) {
      // Drifted custody AND a work item that already ended on its own: there
      // is nothing to cancel, and no ordinary control can ever reach this
      // campaign. Match custody and confirm no runtime lease remains -- the
      // terminal check below does not apply to a work item this path will
      // never write.
      assertCccPrdCampaignDriftStopWorkItemCustody(workItem, runId);
      if (workItem.leaseOwner !== null || workItem.leaseExpiresAt !== null) {
        throw new CccPrdImportError(
          "CCC_PRD_CAMPAIGN_DRIFT_STOP_LEASED",
          `Workflow work item ${workItem.id} still has runtime lease custody; wait for the next unleased safe boundary.`,
        );
      }
      return {
        schema: CCC_PRD_CAMPAIGN_DRIFT_STOP_PLAN_SCHEMA,
        kind: "close-out",
        projectId,
        importId: row.importId,
        idempotencyKey: row.idempotencyKey,
        importState: row.state,
        targetRepository: row.targetRepository,
        driftReason: drift.reason,
        workItem: {
          id: workItem.id,
          runId: workItem.runId,
          stableWorkflowRunId: runId,
          kind: workItem.kind,
          state: workItem.state,
          attempt: workItem.attempt,
          lastError: workItem.lastError ?? null,
          blockedReason: workItem.blockedReason ?? null,
        },
        taskIds,
      } satisfies CccPrdCampaignDriftStopPlan;
    }

    assertCccPrdCampaignDriftStopWorkItem(workItem, runId);

    return {
      schema: CCC_PRD_CAMPAIGN_DRIFT_STOP_PLAN_SCHEMA,
      kind: "cancel",
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
        lastError: workItem.lastError ?? null,
        blockedReason: workItem.blockedReason ?? null,
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
 *
 * Idempotent: re-running against a row already `stopped` simply rewrites the
 * same terminal fields, which is exactly what a resumed close needs.
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
