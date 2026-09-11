/**
 * O1: the PostgreSQL orphan-cancellation operation must classify the child and
 * terminal parent from one raw, project-bound transaction. The tests deliberately
 * exercise the real TaskStore, Drizzle rows, transition audit, FK cascade, and
 * PostgreSQL row-lock behavior. Test-local layer/builder proxies only create
 * deterministic barriers; no production test hook is added.
 */

import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import * as schema from "../../postgres/schema/index.js";
import type { AsyncDataLayer, DbTransaction } from "../../postgres/data-layer.js";
import type { WorkflowWorkItem, WorkflowWorkItemKind, WorkflowWorkItemState } from "../../types/merge-queue.js";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";

const PROJECT_ID = "__legacy_unscoped__";
const OTHER_PROJECT_ID = "o1-project-fence-other";

type RawWorkItem = {
  projectId: string;
  id: string;
  runId: string;
  taskId: string;
  nodeId: string;
  kind: string;
  state: string;
  attempt: number;
  retryAfter: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  lastError: string | null;
  blockedReason: string | null;
  stableWorkflowRunId: string | null;
  continuationSequence: number | null;
  waitReason: string | null;
  sourceColumn: string | null;
  targetColumn: string | null;
  irHash: string | null;
  createdAt: string;
  updatedAt: string;
};

type RawTask = {
  projectId: string;
  id: string;
  column: string;
  deletedAt: string | null;
  updatedAt: string | null;
};

type MutableProjectLayer = { projectId?: string };

type LayerProxyOptions = {
  readonly firstForUpdate: { value: boolean };
  readonly hold?: {
    readonly entered: () => void;
    readonly until: Promise<void>;
  };
  readonly reject?: { readonly error: unknown };
};

interface Fixture {
  readonly task: Awaited<ReturnType<SharedPgTaskStoreHarness["createTestTask"]>>;
  readonly item: WorkflowWorkItem;
}

function mutableProjectLayer(layer: AsyncDataLayer): MutableProjectLayer {
  return layer as unknown as MutableProjectLayer;
}

async function bindFixtureProject(h: SharedPgTaskStoreHarness): Promise<void> {
  const layer = h.layer();
  mutableProjectLayer(layer).projectId = PROJECT_ID;
  expect(h.store().asyncLayer).toBe(layer);
  expect(layer.projectId?.trim()).toBe(PROJECT_ID);
  await seedProjectConfig(h, PROJECT_ID);
}

async function seedProjectConfig(h: SharedPgTaskStoreHarness, projectId: string): Promise<void> {
  // The shared harness resets only the blank compatibility config row. Copy it
  // into the explicit test partition so TaskStore config reads and task writes
  // use the same project identity without relying on a session GUC.
  await h.adminDb().execute(sql`
    INSERT INTO project.config (
      id, project_id, next_id, next_workflow_step_id,
      next_workflow_definition_id, settings, workflow_steps, updated_at
    )
    SELECT
      id, ${projectId}, next_id, next_workflow_step_id,
      next_workflow_definition_id, settings, workflow_steps, updated_at
    FROM project.config
    WHERE project_id = ''
    ON CONFLICT (project_id) DO UPDATE SET
      id = EXCLUDED.id,
      next_id = EXCLUDED.next_id,
      next_workflow_step_id = EXCLUDED.next_workflow_step_id,
      next_workflow_definition_id = EXCLUDED.next_workflow_definition_id,
      settings = EXCLUDED.settings,
      workflow_steps = EXCLUDED.workflow_steps,
      updated_at = EXCLUDED.updated_at
  `);
}

async function readRawWorkItem(
  h: SharedPgTaskStoreHarness,
  id: string,
): Promise<RawWorkItem | undefined> {
  const table = schema.project.workflowWorkItems;
  const rows = await h.adminDb()
    .select({
      projectId: table.projectId,
      id: table.id,
      runId: table.runId,
      taskId: table.taskId,
      nodeId: table.nodeId,
      kind: table.kind,
      state: table.state,
      attempt: table.attempt,
      retryAfter: table.retryAfter,
      leaseOwner: table.leaseOwner,
      leaseExpiresAt: table.leaseExpiresAt,
      lastError: table.lastError,
      blockedReason: table.blockedReason,
      stableWorkflowRunId: table.stableWorkflowRunId,
      continuationSequence: table.continuationSequence,
      waitReason: table.waitReason,
      sourceColumn: table.sourceColumn,
      targetColumn: table.targetColumn,
      irHash: table.irHash,
      createdAt: table.createdAt,
      updatedAt: table.updatedAt,
    })
    .from(table)
    .where(and(eq(table.projectId, PROJECT_ID), eq(table.id, id)))
    .limit(1);
  return rows[0] as RawWorkItem | undefined;
}

async function readRawTask(
  h: SharedPgTaskStoreHarness,
  id: string,
): Promise<RawTask | undefined> {
  const table = schema.project.tasks;
  const rows = await h.adminDb()
    .select({
      projectId: table.projectId,
      id: table.id,
      column: table.column,
      deletedAt: table.deletedAt,
      updatedAt: table.updatedAt,
    })
    .from(table)
    .where(and(eq(table.projectId, PROJECT_ID), eq(table.id, id)))
    .limit(1);
  return rows[0] as RawTask | undefined;
}

async function auditCount(h: SharedPgTaskStoreHarness, target: string): Promise<number> {
  return auditCountForProject(h, PROJECT_ID, target);
}

async function auditCountForProject(
  h: SharedPgTaskStoreHarness,
  projectId: string,
  target: string,
): Promise<number> {
  const rows = await h.adminDb().execute(sql`
    SELECT count(*)::int AS count
    FROM project.run_audit_events
    WHERE project_id = ${projectId} AND target = ${target}
  `) as unknown as Array<{ count: number }>;
  return Number(rows[0]?.count ?? 0);
}

function snapshotFromRaw(raw: RawWorkItem): WorkflowWorkItem {
  return {
    id: raw.id,
    runId: raw.runId,
    taskId: raw.taskId,
    nodeId: raw.nodeId,
    kind: raw.kind as WorkflowWorkItem["kind"],
    state: raw.state as WorkflowWorkItem["state"],
    attempt: raw.attempt,
    retryAfter: raw.retryAfter,
    leaseOwner: raw.leaseOwner,
    leaseExpiresAt: raw.leaseExpiresAt,
    lastError: raw.lastError,
    blockedReason: raw.blockedReason,
    stableWorkflowRunId: raw.stableWorkflowRunId,
    continuationSequence: raw.continuationSequence,
    waitReason: raw.waitReason as WorkflowWorkItem["waitReason"],
    sourceColumn: raw.sourceColumn,
    targetColumn: raw.targetColumn,
    irHash: raw.irHash,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}

async function createFixture(
  h: SharedPgTaskStoreHarness,
  options: {
    readonly column?: string;
    readonly kind?: WorkflowWorkItemKind;
    readonly state?: WorkflowWorkItemState;
    readonly leaseOwner?: string | null;
    readonly id?: string;
  } = {},
): Promise<Fixture> {
  const store = h.store();
  const task = await store.createTask({
    description: "O1 orphan-cancellation fixture",
    column: options.column ?? "todo",
  });
  const item = await store.upsertWorkflowWorkItem({
    id: options.id ?? `WW-o1-${task.id}`,
    runId: `run-o1-${task.id}`,
    taskId: task.id,
    nodeId: "o1-node",
    kind: options.kind ?? "task",
    state: options.state ?? "runnable",
    attempt: 0,
    leaseOwner: options.leaseOwner ?? null,
    leaseExpiresAt: options.leaseOwner ? "2999-01-01T00:00:00.000Z" : null,
    retryAfter: null,
    lastError: null,
    blockedReason: null,
    stableWorkflowRunId: `run-o1-${task.id}`,
    continuationSequence: 0,
    waitReason: null,
    sourceColumn: "todo",
    targetColumn: "in-progress",
    irHash: "o1".repeat(32),
  });
  const rawItem = await readRawWorkItem(h, item.id);
  const rawTask = await readRawTask(h, task.id);
  expect(rawItem?.projectId).toBe(PROJECT_ID);
  expect(rawTask?.projectId).toBe(PROJECT_ID);
  return {task, item};
}

async function expectNoOp(
  h: SharedPgTaskStoreHarness,
  expected: WorkflowWorkItem,
  reason: "work-item-missing" | "work-item-changed" | "work-item-ineligible" | "task-reactivated" | "task-lock-busy",
): Promise<void> {
  const before = await readRawWorkItem(h, expected.id);
  const auditsBefore = await auditCount(h, expected.id);
  const result = await h.store().cancelOrphanedWorkflowWorkItemIfExact(expected);
  expect(result).toEqual({kind: "no-op", reason});
  const after = await readRawWorkItem(h, expected.id);
  expect(after).toEqual(before);
  expect(await auditCount(h, expected.id)).toBe(auditsBefore);
}

async function holdWorkItem(
  h: SharedPgTaskStoreHarness,
  id: string,
): Promise<{ release: () => void; promise: Promise<void> }> {
  let release!: () => void;
  let signal!: () => void;
  const until = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { signal = resolve; });
  const table = schema.project.workflowWorkItems;
  const promise = h.layer().transactionImmediate(async (tx) => {
    await tx.select({id: table.id})
      .from(table)
      .where(and(eq(table.projectId, PROJECT_ID), eq(table.id, id)))
      .for("update");
    signal();
    await until;
  });
  await entered;
  return {release, promise};
}

async function waitForParentLockWait(
  h: SharedPgTaskStoreHarness,
  pid: number,
): Promise<{ blockers: number[] }> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const rows = await h.adminDb().execute(sql`
      SELECT wait_event_type, pg_blocking_pids(pid)::int[] AS blockers
      FROM pg_stat_activity
      WHERE pid = ${pid}
    `) as unknown as Array<{ wait_event_type: string | null; blockers: number[] }>;
    const row = rows[0];
    if (row?.wait_event_type === "Lock" && row.blockers.length > 0) {
      return {blockers: row.blockers};
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`parent delete pid ${pid} did not enter a lock wait`);
}

function wrapQueryBuilder(
  value: unknown,
  options: LayerProxyOptions & { readonly holdThisQuery: boolean },
): unknown {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return value;
  return new Proxy(value as object, {
    get(target, property, receiver) {
      const member = Reflect.get(target, property, receiver);
      if (property === "for" && typeof member === "function") {
        return (...args: unknown[]) => {
          const lockStrength = args[0];
          const lockOptions = args[1] as { noWait?: boolean } | undefined;
          const holdThisQuery = options.firstForUpdate.value
            && lockStrength === "update"
            && lockOptions?.noWait !== true;
          if (holdThisQuery) options.firstForUpdate.value = false;
          const next = Reflect.apply(member, target, args);
          return wrapQueryBuilder(next, {...options, holdThisQuery});
        };
      }
      if (property === "then" && typeof member === "function") {
        if (options.holdThisQuery && options.reject) {
          return (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) =>
            Reflect.apply(member, target, [() => reject(options.reject!.error), reject]);
        }
        if (options.holdThisQuery && options.hold) {
          return (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) =>
            Reflect.apply(member, target, [async (rows: unknown) => {
              options.hold!.entered();
              await options.hold!.until;
              return resolve(rows);
            }, reject]);
        }
        return (...args: unknown[]) => Reflect.apply(member, target, args);
      }
      if (typeof member === "function") {
        return (...args: unknown[]) => wrapQueryBuilder(Reflect.apply(member, target, args), options);
      }
      return member;
    },
  });
}

function wrapTransaction(
  tx: DbTransaction,
  options: LayerProxyOptions,
): DbTransaction {
  return new Proxy(tx as unknown as object, {
    get(target, property, receiver) {
      const member = Reflect.get(target, property, receiver);
      if (property === "select" && typeof member === "function") {
        return (...args: unknown[]) => wrapQueryBuilder(Reflect.apply(member, target, args), {...options, holdThisQuery: false});
      }
      if (typeof member === "function") return (...args: unknown[]) => Reflect.apply(member, target, args);
      return member;
    },
  }) as DbTransaction;
}

function layerWithTransactionBuilder(
  base: AsyncDataLayer,
  options: LayerProxyOptions,
  capturePid?: (pid: number) => void,
): AsyncDataLayer {
  return {
    ...base,
    transactionImmediate: async <T>(fn: (tx: DbTransaction) => Promise<T>, txOptions) =>
      base.transactionImmediate(async (tx) => {
        if (capturePid) {
          const rows = await tx.execute(sql`SELECT pg_backend_pid()::int AS pid`) as unknown as Array<{ pid: number }>;
          capturePid(rows[0]!.pid);
        }
        return fn(wrapTransaction(tx, options));
      }, txOptions),
  };
}

async function withStoreLayer<T>(
  store: ReturnType<SharedPgTaskStoreHarness["store"]>,
  layer: AsyncDataLayer,
  fn: () => Promise<T>,
): Promise<T> {
  const mutableStore = store as unknown as { asyncLayer: AsyncDataLayer | null };
  const original = mutableStore.asyncLayer;
  mutableStore.asyncLayer = layer;
  try {
    return await fn();
  } finally {
    mutableStore.asyncLayer = original;
  }
}

pgDescribe("atomic orphaned workflow work-item cancellation (PostgreSQL)", () => {
  const h = createSharedPgTaskStoreTestHarness({prefix: "fusion_orphan_o1"});

  beforeAll(h.beforeAll);
  beforeEach(async () => {
    await h.beforeEach();
    await bindFixtureProject(h);
  });
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  it("rejects an unbound project before opening a transaction", async () => {
    const {item} = await createFixture(h);
    const layer = h.layer();
    const mutableLayer = mutableProjectLayer(layer);
    const transaction = vi.spyOn(layer, "transactionImmediate");
    mutableLayer.projectId = "  ";
    try {
      await expect(h.store().cancelOrphanedWorkflowWorkItemIfExact(item))
        .rejects.toMatchObject({
          name: "OrphanCancellationBackendDependencyError",
          code: "ORPHAN_CANCELLATION_BACKEND_DEPENDENCY",
        });
      expect(transaction).not.toHaveBeenCalled();
    } finally {
      mutableLayer.projectId = PROJECT_ID;
      transaction.mockRestore();
    }
  });

  it("returns work-item-changed for raw unknown kind, state, and waitReason", async () => {
    const cases: Array<{column: "kind" | "state" | "waitReason"; value: string}> = [
      {column: "kind", value: "future-kind"},
      {column: "state", value: "future-state"},
      {column: "waitReason", value: "future-wait"},
    ];
    for (const testCase of cases) {
      const {item} = await createFixture(h);
      const table = schema.project.workflowWorkItems;
      await h.adminDb().update(table)
        .set({[testCase.column]: testCase.value} as never)
        .where(and(eq(table.projectId, PROJECT_ID), eq(table.id, item.id)));
      await expectNoOp(h, item, "work-item-changed");
    }
  });

  it("returns work-item-changed for same-state metadata drift", async () => {
    const {item} = await createFixture(h);
    const table = schema.project.workflowWorkItems;
    await h.adminDb().update(table)
      .set({attempt: 1, updatedAt: "2026-09-08T05:00:00.000Z"})
      .where(and(eq(table.projectId, PROJECT_ID), eq(table.id, item.id)));
    await expectNoOp(h, item, "work-item-changed");
  });

  it("classifies missing, claimed, non-task, running, and terminal work items", async () => {
    const missing = await createFixture(h);
    await h.adminDb().delete(schema.project.workflowWorkItems)
      .where(and(eq(schema.project.workflowWorkItems.projectId, PROJECT_ID), eq(schema.project.workflowWorkItems.id, missing.item.id)));
    await expectNoOp(h, missing.item, "work-item-missing");

    const claimed = await createFixture(h, {leaseOwner: "owner-a"});
    await expectNoOp(h, claimed.item, "work-item-ineligible");

    const nonTask = await createFixture(h, {kind: "merge"});
    await expectNoOp(h, nonTask.item, "work-item-ineligible");

    for (const state of ["running", "held", "manual-required", "cancelled"] as const) {
      const fixture = await createFixture(h, {state});
      await expectNoOp(h, fixture.item, "work-item-ineligible");
    }

    const unknown = await createFixture(h);
    await h.adminDb().update(schema.project.workflowWorkItems)
      .set({state: "future-state"} as never)
      .where(and(eq(schema.project.workflowWorkItems.projectId, PROJECT_ID), eq(schema.project.workflowWorkItems.id, unknown.item.id)));
    const raw = await readRawWorkItem(h, unknown.item.id);
    expect(raw).toBeDefined();
    await expectNoOp(h, snapshotFromRaw(raw!), "work-item-ineligible");
  });

  it("cancels only terminal or deleted parents with the exact patch and audit", async () => {
    for (const terminal of ["done", "archived", "deleted"] as const) {
      const fixture = await createFixture(h);
      const taskTable = schema.project.tasks;
      const values = terminal === "deleted"
        ? {column: "todo", deletedAt: "2026-09-08T05:00:00.000Z", updatedAt: "2026-09-08T05:00:00.000Z"}
        : {column: terminal, deletedAt: null};
      await h.adminDb().update(taskTable)
        .set(values)
        .where(and(eq(taskTable.projectId, PROJECT_ID), eq(taskTable.id, fixture.task.id)));
      const beforeTask = await readRawTask(h, fixture.task.id);
      const beforeAudits = await auditCount(h, fixture.item.id);
      const result = await h.store().cancelOrphanedWorkflowWorkItemIfExact(fixture.item);
      expect(result.kind).toBe("cancelled");
      expect(result).toMatchObject({
        kind: "cancelled",
        reason: "task-terminal",
        item: {
          id: fixture.item.id,
          state: "cancelled",
          leaseOwner: null,
          leaseExpiresAt: null,
          lastError: "orphaned-continuation:task-terminal",
          blockedReason: "task-terminal",
        },
      });
      expect(await auditCount(h, fixture.item.id)).toBe(beforeAudits + 1);
      expect(await readRawTask(h, fixture.task.id)).toEqual(beforeTask);
    }

    const live = await createFixture(h, {column: "todo"});
    await expectNoOp(h, live.item, "task-reactivated");
  });

  it("keeps a same-ID orphan cancellation and audit inside the bound project despite a mismatched session GUC", async () => {
    const sharedId = "WW-o1-project-fence-shared";
    const target = await createFixture(h, {id: sharedId});
    await h.adminDb().update(schema.project.tasks)
      .set({column: "done"})
      .where(and(eq(schema.project.tasks.projectId, PROJECT_ID), eq(schema.project.tasks.id, target.task.id)));

    const base = h.layer();
    const mutableLayer = mutableProjectLayer(base);
    const originalProjectId = mutableLayer.projectId;
    let otherTaskId: string;
    mutableLayer.projectId = OTHER_PROJECT_ID;
    try {
      await seedProjectConfig(h, OTHER_PROJECT_ID);
      const task = await h.store().createTask({description: "O1 project-fence other fixture", column: "todo"});
      otherTaskId = task.id;
      const timestamp = "2026-09-08T06:21:58.788Z";
      await h.adminDb().insert(schema.project.workflowWorkItems).values({
        projectId: OTHER_PROJECT_ID,
        id: sharedId,
        runId: `run-o1-other-${task.id}`,
        taskId: task.id,
        nodeId: "o1-other-node",
        kind: "task",
        state: "succeeded",
        attempt: 0,
        leaseOwner: null,
        leaseExpiresAt: null,
        retryAfter: null,
        lastError: null,
        blockedReason: null,
        stableWorkflowRunId: `run-o1-other-${task.id}`,
        continuationSequence: 0,
        waitReason: null,
        sourceColumn: "todo",
        targetColumn: "in-progress",
        irHash: "o1".repeat(32),
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    } finally {
      mutableLayer.projectId = originalProjectId;
    }

    const targetAuditsBefore = await auditCountForProject(h, PROJECT_ID, sharedId);
    const otherAuditsBefore = await auditCountForProject(h, OTHER_PROJECT_ID, sharedId);
    const sessionMismatchedLayer: AsyncDataLayer = {
      ...base,
      transactionImmediate: async (fn, options) => base.transactionImmediate(async (tx) => {
        const roleRows = await tx.execute(sql`
          SELECT rolsuper
          FROM pg_roles
          WHERE rolname = current_user
        `) as unknown as Array<{ rolsuper: boolean }>;
        expect(roleRows[0]?.rolsuper).toBe(true);
        await tx.execute(sql`SELECT set_config('fusion.project_id', ${OTHER_PROJECT_ID}, true)`);
        return fn(tx);
      }, options),
    };

    const result = await withStoreLayer(h.store(), sessionMismatchedLayer, () =>
      h.store().cancelOrphanedWorkflowWorkItemIfExact(target.item),
    );

    expect(result).toMatchObject({kind: "cancelled", item: {id: sharedId, state: "cancelled"}});
    expect((await readRawWorkItem(h, sharedId))?.state).toBe("cancelled");
    const otherRows = await h.adminDb().select({state: schema.project.workflowWorkItems.state})
      .from(schema.project.workflowWorkItems)
      .where(and(
        eq(schema.project.workflowWorkItems.projectId, OTHER_PROJECT_ID),
        eq(schema.project.workflowWorkItems.id, sharedId),
        eq(schema.project.workflowWorkItems.taskId, otherTaskId!),
      ));
    expect(otherRows).toEqual([{state: "succeeded"}]);
    expect(await auditCountForProject(h, PROJECT_ID, sharedId)).toBe(targetAuditsBefore + 1);
    expect(await auditCountForProject(h, OTHER_PROJECT_ID, sharedId)).toBe(otherAuditsBefore);
  });

  it("serializes a lease claim against orphan classification without deadlock", async () => {
    const fixture = await createFixture(h);
    const held = await holdWorkItem(h, fixture.item.id);
    const claim = h.store().acquireWorkflowWorkItemLease(fixture.item.id, "claimer", {
      leaseDurationMs: 60_000,
      now: "2026-09-08T05:00:00.000Z",
    });
    const orphan = h.store().cancelOrphanedWorkflowWorkItemIfExact(fixture.item);
    held.release();
    try {
      const [claimResult, orphanResult] = await Promise.all([claim, orphan]);
      expect(claimResult === null || orphanResult.kind === "no-op").toBe(true);
      expect(orphanResult.kind === "cancelled" || orphanResult.kind === "no-op").toBe(true);
      if (orphanResult.kind === "no-op") {
        expect(["work-item-changed", "task-reactivated"]).toContain(orphanResult.reason);
      }
    } finally {
      held.release();
      await held.promise;
    }
  });

  it("rolls back transition and audit together when the callback fails", async () => {
    const fixture = await createFixture(h);
    await h.adminDb().update(schema.project.tasks)
      .set({column: "done"})
      .where(and(eq(schema.project.tasks.projectId, PROJECT_ID), eq(schema.project.tasks.id, fixture.task.id)));
    const beforeItem = await readRawWorkItem(h, fixture.item.id);
    const beforeTask = await readRawTask(h, fixture.task.id);
    const beforeAudits = await auditCount(h, fixture.item.id);
    const original = h.store().transitionWorkflowWorkItem.bind(h.store());
    const transition = vi.spyOn(h.store(), "transitionWorkflowWorkItem").mockImplementation(async (...args) => {
      await original(...args);
      throw new Error("synthetic post-transition rollback");
    });
    try {
      await expect(h.store().cancelOrphanedWorkflowWorkItemIfExact(fixture.item))
        .rejects.toThrow("synthetic post-transition rollback");
    } finally {
      transition.mockRestore();
    }
    expect(await readRawWorkItem(h, fixture.item.id)).toEqual(beforeItem);
    expect(await readRawTask(h, fixture.task.id)).toEqual(beforeTask);
    expect(await auditCount(h, fixture.item.id)).toBe(beforeAudits);
  });

  it("does not classify a wrong-statement 55P03 as task-lock-busy", async () => {
    const fixture = await createFixture(h);
    const error = Object.assign(new Error("synthetic child lock error"), {code: "55P03"});
    const layer = layerWithTransactionBuilder(h.layer(), {
      firstForUpdate: {value: true},
      reject: {error},
    });
    await expect(withStoreLayer(h.store(), layer, () =>
      h.store().cancelOrphanedWorkflowWorkItemIfExact(fixture.item),
    )).rejects.toMatchObject({code: "55P03"});
  });

  it("propagates a rollback-boundary error instead of classifying it as busy", async () => {
    const fixture = await createFixture(h);
    await h.adminDb().update(schema.project.tasks)
      .set({column: "done"})
      .where(and(eq(schema.project.tasks.projectId, PROJECT_ID), eq(schema.project.tasks.id, fixture.task.id)));
    const original = h.store().transitionWorkflowWorkItem.bind(h.store());
    const beforeAudits = await auditCount(h, fixture.item.id);
    const transition = vi.spyOn(h.store(), "transitionWorkflowWorkItem").mockImplementation(async (...args) => {
      await original(...args);
      throw new Error("synthetic callback failure");
    });
    const base = h.layer();
    const rollbackLayer: AsyncDataLayer = {
      ...base,
      transactionImmediate: async (fn, options) => {
        try {
          return await base.transactionImmediate(fn, options);
        } catch (cause) {
          throw Object.assign(new Error("synthetic rollback boundary", {cause}), {code: "ROLLBACK_BOUNDARY"});
        }
      },
    };
    try {
      await expect(withStoreLayer(h.store(), rollbackLayer, () =>
        h.store().cancelOrphanedWorkflowWorkItemIfExact(fixture.item),
      )).rejects.toMatchObject({code: "ROLLBACK_BOUNDARY"});
    } finally {
      transition.mockRestore();
    }
    expect((await readRawWorkItem(h, fixture.item.id))?.state).toBe("runnable");
    expect(await auditCount(h, fixture.item.id)).toBe(beforeAudits);
  });

  it("proves parent-held cascade waits on the child before task NOWAIT", async () => {
    const store = h.store();
    const task = await store.createTask({description: "O1 physical cascade", column: "done"});
    await store.archiveTask(task.id, {cleanup: false});
    const item = await store.upsertWorkflowWorkItem({
      id: "WW-o1-physical-cascade",
      runId: "run-o1-physical-cascade",
      taskId: task.id,
      nodeId: "o1-node",
      kind: "task",
      state: "runnable",
      attempt: 0,
      leaseOwner: null,
      leaseExpiresAt: null,
      retryAfter: null,
      lastError: null,
      blockedReason: null,
      stableWorkflowRunId: "run-o1-physical-cascade",
      continuationSequence: 0,
      waitReason: null,
      sourceColumn: "done",
      targetColumn: "archived",
      irHash: "o1".repeat(32),
    });
    const expected = await store.getWorkflowWorkItem(item.id);
    expect(expected).toBeDefined();
    const table = schema.project.tasks;
    let parentPid = 0;
    let childPid = 0;
    let parentReady!: () => void;
    let childLocked!: () => void;
    let deleteWaiting!: () => void;
    let releaseChild!: () => void;
    const parentReadyPromise = new Promise<void>((resolve) => { parentReady = resolve; });
    const childLockedPromise = new Promise<void>((resolve) => { childLocked = resolve; });
    const deleteWaitingPromise = new Promise<void>((resolve) => { deleteWaiting = resolve; });
    const childRelease = new Promise<void>((resolve) => { releaseChild = resolve; });
    const parentDelete = h.layer().transactionImmediate(async (tx) => {
      const pidRows = await tx.execute(sql`SELECT pg_backend_pid()::int AS pid`) as unknown as Array<{ pid: number }>;
      parentPid = pidRows[0]!.pid;
      await tx.select({id: table.id})
        .from(table)
        .where(and(eq(table.projectId, PROJECT_ID), eq(table.id, task.id)))
        .for("update");
      parentReady();
      await childLockedPromise;
      const deletion = tx.delete(table)
        .where(and(eq(table.projectId, PROJECT_ID), eq(table.id, task.id)));
      const deletionStarted = deletion.then((rows) => rows);
      const observation = await waitForParentLockWait(h, parentPid);
      expect(observation.blockers).toContain(childPid);
      deleteWaiting();
      await deletionStarted;
    });
    await parentReadyPromise;
    const barrierLayer = layerWithTransactionBuilder(h.layer(), {
      firstForUpdate: {value: true},
      hold: {entered: childLocked, until: childRelease},
    }, (pid) => { childPid = pid; });
    const helper = withStoreLayer(h.store(), barrierLayer, () =>
      h.store().cancelOrphanedWorkflowWorkItemIfExact(expected!),
    );
    await childLockedPromise;
    await deleteWaitingPromise;
    releaseChild();
    try {
      const [result] = await Promise.all([helper, parentDelete]);
      expect(result).toEqual({kind: "no-op", reason: "task-lock-busy"});
      expect(await readRawWorkItem(h, item.id)).toBeUndefined();
    } finally {
      releaseChild();
      await parentDelete.catch(() => undefined);
      await helper.catch(() => undefined);
    }
  });

  it("completes a hard-cancel race without resurrection", async () => {
    const fixture = await createFixture(h, {column: "in-progress"});
    const outcomes = await Promise.allSettled([
      h.store().cancelOrphanedWorkflowWorkItemIfExact(fixture.item),
      h.store().moveTask(fixture.task.id, "todo", {moveSource: "user"}),
    ]);
    expect(outcomes.every((outcome) => outcome.status === "fulfilled")).toBe(true);
    expect((await readRawTask(h, fixture.task.id))?.column).toBe("todo");
    expect((await readRawWorkItem(h, fixture.item.id))?.state).toBe("cancelled");
  });

  it("returns task-lock-busy while parent-first unarchive owns the task row", async () => {
    const store = h.store();
    const task = await store.createTask({description: "O1 unarchive race", column: "done"});
    await store.archiveTask(task.id, {cleanup: false});
    const item = await store.upsertWorkflowWorkItem({
      id: "WW-o1-unarchive",
      runId: "run-o1-unarchive",
      taskId: task.id,
      nodeId: "o1-node",
      kind: "task",
      state: "runnable",
      attempt: 0,
      leaseOwner: null,
      leaseExpiresAt: null,
      retryAfter: null,
      lastError: null,
      blockedReason: null,
      stableWorkflowRunId: "run-o1-unarchive",
      continuationSequence: 0,
      waitReason: null,
      sourceColumn: "done",
      targetColumn: "archived",
      irHash: "o1".repeat(32),
    });
    const table = schema.project.tasks;
    let releaseParent!: () => void;
    let signalParent!: () => void;
    const parentGate = new Promise<void>((resolve) => { releaseParent = resolve; });
    const parentLocked = new Promise<void>((resolve) => { signalParent = resolve; });
    const holder = h.layer().transactionImmediate(async (tx) => {
      await tx.select({id: table.id})
        .from(table)
        .where(and(eq(table.projectId, PROJECT_ID), eq(table.id, task.id)))
        .for("update");
      signalParent();
      await parentGate;
    });
    await parentLocked;
    const unarchive = store.unarchiveTask(task.id);
    const result = await store.cancelOrphanedWorkflowWorkItemIfExact(item);
    expect(result).toEqual({kind: "no-op", reason: "task-lock-busy"});
    releaseParent();
    await Promise.all([holder, unarchive]);
    expect((await readRawTask(h, task.id))?.column).toBe("todo");
    expect((await readRawWorkItem(h, item.id))?.state).toBe("runnable");
  });

  it("allows only one identical helper to commit cancellation", async () => {
    const fixture = await createFixture(h);
    await h.adminDb().update(schema.project.tasks)
      .set({column: "done"})
      .where(and(eq(schema.project.tasks.projectId, PROJECT_ID), eq(schema.project.tasks.id, fixture.task.id)));
    const held = await holdWorkItem(h, fixture.item.id);
    const first = h.store().cancelOrphanedWorkflowWorkItemIfExact(fixture.item);
    const second = h.store().cancelOrphanedWorkflowWorkItemIfExact(fixture.item);
    held.release();
    try {
      const results = await Promise.all([first, second]);
      expect(results.filter((result) => result.kind === "cancelled")).toHaveLength(1);
      expect(results.filter((result) => result.kind === "no-op" && result.reason === "work-item-changed")).toHaveLength(1);
      expect((await readRawWorkItem(h, fixture.item.id))?.state).toBe("cancelled");
      const rows = await h.adminDb().execute(sql`
        SELECT mutation_type
        FROM project.run_audit_events
        WHERE project_id = ${PROJECT_ID} AND target = ${fixture.item.id}
          AND mutation_type = 'workflowWorkItem:transition'
      `) as unknown as Array<{ mutation_type: string }>;
      expect(rows).toHaveLength(1);
    } finally {
      held.release();
      await held.promise;
    }
  });
});
