/*
FNXC:CccPlanningCustody 2026-10-14-13:41:
Store-level custody for request-to-code planning tasks (card G1, D22, critic 1, challenges 11 and 24). A planning task is held when two facts agree: the pure K1 marker (`isCccPlanningCustodyTask`: lineage is a `ccc-plan:` run id, `paused` is true, `userPaused` is not true) and the database fact that an anchor row in `project.ccc_planning_runs` names the task as its planning task. The marker alone is only suspicion, the same contract as the imported campaign lineage; the anchor is the proof. Every guard site asks the pure marker first, so an ordinary task never pays for the anchor query.

A held task may still take non-custody writes (a summary, a log line, a status the native host records), but no store path may release it (clear `paused`, set `userPaused`), move it, archive it or delete it. Those paths throw `CccPlanningTaskCustodyError`, named after the refused operation, before any write. A failed anchor lookup propagates, so the guarded operation fails closed instead of proceeding unguarded.
*/
import { and, eq, type SQL } from "drizzle-orm";
import { CccPlanningTaskCustodyError } from "../ccc-planning/errors.js";
import { isCccPlanningCustodyTask } from "../ccc-planning/marker.js";
import { projectOwnershipPartition, type AsyncDataLayer } from "../postgres/data-layer.js";
import { cccPlanningRuns } from "../postgres/schema/ccc-planning.js";
import * as schema from "../postgres/schema/index.js";
import type { Task } from "../types.js";

/** The store operations a held planning task refuses. The custody error carries the name. */
export type CccPlanningCustodyOperation = "move" | "unpause" | "update" | "update-columns" | "archive" | "delete";

/** The data-layer surface the custody checks need: the Drizzle handle and the bound project, if any. */
export type CccPlanningCustodyLayer = Pick<AsyncDataLayer, "db" | "projectId">;

type CustodyTaskView = Pick<Task, "id" | "lineageId" | "paused" | "userPaused">;

/** Fields whose change would release, move, archive or delete a held task. */
export type CccPlanningCustodySnapshot = Readonly<{
  paused: boolean;
  userPaused: boolean;
  lineageId: string | null;
  column: string;
  deletedAt: string | null;
}>;

/**
 * Task-table columns (Drizzle property names) that carry custody. A raw `updateTaskColumns` write that changes
 * any of them on a held task is refused.
 */
export const CCC_PLANNING_CUSTODY_TASK_COLUMNS = Object.freeze(["paused", "userPaused", "column", "lineageId", "deletedAt"] as const);

function boundProject(layer: CccPlanningCustodyLayer): string | undefined {
  const trimmed = layer.projectId?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Database half of the custody predicate: an anchor row names `taskId` as its planning task.
 * `projectId` scopes the lookup; without one (an unbound compatibility store, whose task reads are not
 * project-scoped either) any project's anchor counts, which fails closed.
 */
export async function hasCccPlanningAnchorForTask(
  layer: CccPlanningCustodyLayer,
  taskId: string,
  projectId?: string,
): Promise<boolean> {
  const conditions: SQL[] = [eq(cccPlanningRuns.planningTaskId, taskId)];
  if (projectId !== undefined) conditions.push(eq(cccPlanningRuns.projectId, projectId));
  const rows = await layer.db
    .select({ runId: cccPlanningRuns.runId })
    .from(cccPlanningRuns)
    .where(and(...conditions))
    .limit(1);
  return rows.length > 0;
}

/** True when the task carries the K1 marker and an anchor row proves the custody. No layer means no anchor. */
export async function isCccPlanningTaskHeld(layer: CccPlanningCustodyLayer | null, task: CustodyTaskView): Promise<boolean> {
  if (!isCccPlanningCustodyTask(task)) return false;
  if (!layer) return false;
  return hasCccPlanningAnchorForTask(layer, task.id, boundProject(layer));
}

/** Throws `CccPlanningTaskCustodyError(task.id, operation)` when the task is held. */
export async function assertCccPlanningTaskNotHeld(
  layer: CccPlanningCustodyLayer | null,
  task: CustodyTaskView,
  operation: CccPlanningCustodyOperation,
): Promise<void> {
  if (await isCccPlanningTaskHeld(layer, task)) {
    throw new CccPlanningTaskCustodyError(task.id, operation);
  }
}

type CustodyRow = {
  lineageId: string | null;
  paused: number | null;
  userPaused: number | null;
  column: string;
  deletedAt: string | null;
};

async function readCustodyRow(layer: CccPlanningCustodyLayer, taskId: string, partition: string | undefined): Promise<CustodyRow | undefined> {
  const conditions: SQL[] = [eq(schema.project.tasks.id, taskId)];
  if (partition !== undefined) conditions.push(eq(schema.project.tasks.projectId, partition));
  const rows = await layer.db
    .select({
      lineageId: schema.project.tasks.lineageId,
      paused: schema.project.tasks.paused,
      userPaused: schema.project.tasks.userPaused,
      column: schema.project.tasks.column,
      deletedAt: schema.project.tasks.deletedAt,
    })
    .from(schema.project.tasks)
    .where(and(...conditions));
  return rows[0] as CustodyRow | undefined;
}

function rowMarkerView(taskId: string, row: CustodyRow): CustodyTaskView {
  return {
    id: taskId,
    lineageId: row.lineageId ?? undefined,
    paused: Boolean(row.paused),
    userPaused: Boolean(row.userPaused),
  };
}

/**
 * Archive and delete reach the store by id. The anchor is checked first (one indexed lookup, and the common
 * answer for ordinary tasks is "none"); only then is the live row's marker read.
 */
export async function assertCccPlanningTaskIdNotHeld(
  layer: CccPlanningCustodyLayer | null,
  taskId: string,
  operation: CccPlanningCustodyOperation,
): Promise<void> {
  if (!layer) return;
  const project = boundProject(layer);
  if (!await hasCccPlanningAnchorForTask(layer, taskId, project)) return;
  const row = await readCustodyRow(layer, taskId, project);
  if (!row) return;
  if (isCccPlanningCustodyTask(rowMarkerView(taskId, row))) {
    throw new CccPlanningTaskCustodyError(taskId, operation);
  }
}

/** Snapshot of the custody fields, taken before an update mutates the task in place. */
export function cccPlanningCustodySnapshot(task: Pick<Task, "paused" | "userPaused" | "lineageId" | "column" | "deletedAt">): CccPlanningCustodySnapshot {
  return {
    paused: task.paused === true,
    userPaused: task.userPaused === true,
    lineageId: task.lineageId ?? null,
    column: task.column,
    deletedAt: task.deletedAt ?? null,
  };
}

/** Throws when the mutated task no longer has the custody fields it had before the update. */
export function assertCccPlanningCustodyPreserved(
  taskId: string,
  before: CccPlanningCustodySnapshot,
  after: Pick<Task, "paused" | "userPaused" | "lineageId" | "column" | "deletedAt">,
): void {
  const next = cccPlanningCustodySnapshot(after);
  if (
    next.paused !== before.paused
    || next.userPaused !== before.userPaused
    || next.lineageId !== before.lineageId
    || next.column !== before.column
    || next.deletedAt !== before.deletedAt
  ) {
    throw new CccPlanningTaskCustodyError(taskId, "update");
  }
}

/**
 * The update inputs that release or move a held task before any field is written, mirroring `updateTaskUnlocked`:
 * `paused` other than true clears the hold; reassigning the agent that paused the task auto-unpauses it; a new
 * dependency on a `todo` task moves it to triage. Returns the refused operation, or null.
 */
export function cccPlanningCustodyReleasingUpdate(
  task: Pick<Task, "paused" | "pausedByAgentId" | "assignedAgentId" | "column" | "dependencies">,
  updates: Readonly<{ paused?: boolean; assignedAgentId?: string | null; dependencies?: string[] }>,
): CccPlanningCustodyOperation | null {
  if (updates.paused !== undefined && updates.paused !== true) return "unpause";
  if (updates.assignedAgentId !== undefined) {
    const nextAssigned = updates.assignedAgentId ?? undefined;
    if (
      nextAssigned !== task.assignedAgentId
      && task.paused
      && task.pausedByAgentId
      && task.pausedByAgentId === task.assignedAgentId
    ) {
      return "unpause";
    }
  }
  if (updates.dependencies !== undefined && task.column === "todo") {
    const existing = new Set((task.dependencies ?? []).map((dependency) => dependency.trim()).filter(Boolean));
    const added = updates.dependencies.map((dependency) => dependency.trim()).filter(Boolean).some((dependency) => !existing.has(dependency));
    if (added) return "move";
  }
  return null;
}

function custodyValueOf(key: (typeof CCC_PLANNING_CUSTODY_TASK_COLUMNS)[number], value: unknown): unknown {
  if (key === "paused" || key === "userPaused") return value === true || value === 1;
  return value ?? null;
}

/**
 * Guard for the raw column writer `updateTaskColumns`. Only a write that touches a custody column is checked;
 * it is refused when the task is held and the write changes that column's value. The row read uses the same
 * project partition as the UPDATE it guards.
 */
export async function assertCccPlanningTaskColumnsPreserveCustody(
  layer: CccPlanningCustodyLayer,
  taskId: string,
  updates: Readonly<Record<string, unknown>>,
): Promise<void> {
  const touched = CCC_PLANNING_CUSTODY_TASK_COLUMNS.filter((key) => Object.hasOwn(updates, key));
  if (touched.length === 0) return;
  const partition = projectOwnershipPartition(layer.projectId);
  const row = await readCustodyRow(layer, taskId, partition);
  if (!row) return;
  if (!isCccPlanningCustodyTask(rowMarkerView(taskId, row))) return;
  if (!await hasCccPlanningAnchorForTask(layer, taskId, partition)) return;
  for (const key of touched) {
    if (custodyValueOf(key, updates[key]) !== custodyValueOf(key, row[key])) {
      throw new CccPlanningTaskCustodyError(taskId, "update-columns");
    }
  }
}
