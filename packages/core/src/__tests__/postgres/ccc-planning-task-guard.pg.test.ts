/**
 * FNXC:CccPlanningCustody 2026-10-14-13:41 (card G1, D22, critic 1, challenges 11 and 24):
 * Store-level guards for a held request-to-code planning task, against a real PostgreSQL.
 *
 * Every case builds two identical tasks: the same column, the same K1 marker (lineage is a `ccc-plan:` run id,
 * `paused` true, `userPaused` false) and the same status. Only the held one has an anchor row in
 * `project.ccc_planning_runs`. Each refusal is asserted on the held task, with the row read back from
 * PostgreSQL unchanged; the twin then takes the very same call and succeeds, which proves the fixture really
 * reaches the store path and that custody is proved by the anchor, not by the marker alone.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import * as schema from "../../postgres/schema/index.js";
import { cccPlanningRuns, type CccPlanningRunInsert } from "../../postgres/schema/ccc-planning.js";
import { CccPlanningTaskCustodyError } from "../../ccc-planning/errors.js";
import { updateTaskColumns } from "../../task-store/async-persistence.js";
import { assertCccPlanningSnapshotWritePreservesCustody } from "../../task-store/ccc-planning-custody.js";
import type { Task } from "../../types.js";

const NOW = "2026-10-14T12:00:00.000Z";
const FAR = "2999-01-01T00:00:00.000Z";

function sha(label: string): string {
  return createHash("sha256").update(label, "utf8").digest("hex");
}

let ordinal = 0;
function nextRunId(): string {
  ordinal += 1;
  return `ccc-plan:${sha(`r2c-g1-run-${ordinal}-${process.pid}`).slice(0, 24)}`;
}

function anchorValues(projectId: string, runId: string, planningTaskId: string): CccPlanningRunInsert {
  return {
    projectId,
    runId,
    planningTaskId,
    mode: "spec",
    budgetProfile: "standard",
    roleProfile: "full-v2",
    policyVersion: "ccc-planning.budget-policy.v1",
    policyDigest: sha("policy"),
    requestDigest: sha(`request:${runId}`),
    requestBytes: 512,
    targetRepository: "/private/tmp/r2c-g1-target",
    admittedBase: "b".repeat(40),
    grantDigest: sha(`grant:${runId}`),
    authorityReceiptSha256: sha(`receipt:${runId}`),
    authorityReceiptJson: JSON.stringify({ runId }),
    runtimeDistManifestSha256: sha("dist"),
    state: "admitted",
    deadlineAt: FAR,
    planningAllocation: 40,
    implementationAllocation: 0,
    reviewProofAllocation: 0,
    researchFetchAllocation: 5,
    researchBytesAllocation: 1_048_576,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

type SeedColumn = "triage" | "todo" | "in-progress";

type CustodyRow = {
  column: string;
  paused: number | null;
  userPaused: number | null;
  lineageId: string | null;
  deletedAt: string | null;
  status: string | null;
  summary: string | null;
};

pgDescribe("ccc planning task custody guards (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_ccc_planning_g1" });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  async function readRow(id: string): Promise<CustodyRow> {
    const rows = await h
      .adminDb()
      .select({
        column: schema.project.tasks.column,
        paused: schema.project.tasks.paused,
        userPaused: schema.project.tasks.userPaused,
        lineageId: schema.project.tasks.lineageId,
        deletedAt: schema.project.tasks.deletedAt,
        status: schema.project.tasks.status,
        summary: schema.project.tasks.summary,
      })
      .from(schema.project.tasks)
      .where(eq(schema.project.tasks.id, id));
    expect(rows).toHaveLength(1);
    return rows[0] as CustodyRow;
  }

  /** One task in the held shape: the K1 marker, an explicit `user_paused = 0`, and the held status. */
  async function seedMarkedTask(id: string, column: SeedColumn): Promise<string> {
    const store = h.store();
    const runId = nextRunId();
    await store.createTaskWithReservedId(
      { description: `request-to-code planning task ${id}`, column },
      { taskId: id, createdAt: NOW, updatedAt: NOW, applyDefaultWorkflowSteps: false },
    );
    await h
      .adminDb()
      .update(schema.project.tasks)
      .set({ lineageId: runId, paused: 1, userPaused: 0, status: "ccc-planning-held", pausedReason: "ccc-planning-held" })
      .where(eq(schema.project.tasks.id, id));
    store.taskCache.delete(id);
    return runId;
  }

  /** The held planning task (marker plus anchor) and its twin (the same marker, no anchor). */
  async function seedPair(
    label: string,
    column: SeedColumn = "triage",
  ): Promise<{ held: string; twin: string }> {
    const held = `FN-G1-${label}-HELD`;
    const twin = `FN-G1-${label}-TWIN`;
    const heldRunId = await seedMarkedTask(held, column);
    await seedMarkedTask(twin, column);
    const [owner] = await h
      .adminDb()
      .select({ projectId: schema.project.tasks.projectId })
      .from(schema.project.tasks)
      .where(eq(schema.project.tasks.id, held));
    await h.adminDb().insert(cccPlanningRuns).values(anchorValues(owner!.projectId, heldRunId, held));
    return { held, twin };
  }

  async function expectCustodyRefusal(call: Promise<unknown>, taskId: string, operation: string): Promise<void> {
    const error = await call.then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(CccPlanningTaskCustodyError);
    expect(error).toMatchObject({ code: "CCC_PLANNING_TASK_CUSTODY", taskId, operation });
  }

  it("moveTask to todo refuses a held planning task with CccPlanningTaskCustodyError and leaves the row unchanged; the twin without an anchor moves", async () => {
    const { held, twin } = await seedPair("MOVE");
    const before = await readRow(held);

    await expectCustodyRefusal(h.store().moveTask(held, "todo"), held, "move");
    expect(await readRow(held)).toEqual(before);

    await h.store().moveTask(twin, "todo");
    expect((await readRow(twin)).column).toBe("todo");
  });

  it("pauseTask(false) refuses to unpause a held planning task; the twin unpauses", async () => {
    const { held, twin } = await seedPair("UNPAUSE");
    const before = await readRow(held);

    await expectCustodyRefusal(h.store().pauseTask(held, false), held, "unpause");
    expect(await readRow(held)).toEqual(before);

    await h.store().pauseTask(twin, false);
    expect((await readRow(twin)).paused).toBe(0);
  });

  it("updateTask writes a summary on a held planning task but refuses paused:false; the twin unpauses", async () => {
    const { held, twin } = await seedPair("UPDATE");

    await h.store().updateTask(held, { summary: "planning summary" });
    const afterSummary = await readRow(held);
    expect(afterSummary).toMatchObject({ summary: "planning summary", paused: 1, column: "triage" });

    await expectCustodyRefusal(h.store().updateTask(held, { paused: false }), held, "unpause");
    expect(await readRow(held)).toEqual(afterSummary);

    await h.store().updateTask(twin, { paused: false });
    expect((await readRow(twin)).paused).toBe(0);
  });

  it("updateTaskAtomic refuses paused:false on a held planning task through the path that skips updateTaskImpl; the twin unpauses", async () => {
    const { held, twin } = await seedPair("ATOMIC");
    const before = await readRow(held);

    await expectCustodyRefusal(h.store().updateTaskAtomic(held, () => ({ paused: false })), held, "unpause");
    expect(await readRow(held)).toEqual(before);

    await h.store().updateTaskAtomic(twin, () => ({ paused: false }));
    expect((await readRow(twin)).paused).toBe(0);
  });

  it("updateTask refuses reassigning the agent that paused a held planning task and adding a dependency while it sits in todo; the twin takes both", async () => {
    const { held, twin } = await seedPair("RELEASE", "todo");
    const dependency = "FN-G1-RELEASE-DEP";
    await h.store().createTaskWithReservedId(
      { description: "dependency", column: "todo" },
      { taskId: dependency, createdAt: NOW, updatedAt: NOW, applyDefaultWorkflowSteps: false },
    );
    for (const id of [held, twin]) {
      await h
        .adminDb()
        .update(schema.project.tasks)
        .set({ assignedAgentId: "agent-g1", pausedByAgentId: "agent-g1" })
        .where(eq(schema.project.tasks.id, id));
      h.store().taskCache.delete(id);
    }
    const before = await readRow(held);

    await expectCustodyRefusal(h.store().updateTask(held, { assignedAgentId: null }), held, "unpause");
    await expectCustodyRefusal(h.store().updateTask(held, { dependencies: [dependency] }), held, "move");
    expect(await readRow(held)).toEqual(before);

    await h.store().updateTask(twin, { dependencies: [dependency] });
    expect((await readRow(twin)).column).toBe("triage");
    await h.store().updateTask(twin, { assignedAgentId: null });
    expect((await readRow(twin)).paused).toBe(0);
  });

  it("a direct updateTaskColumns write of paused is refused for a held planning task; the twin's write lands", async () => {
    const { held, twin } = await seedPair("COLUMNS");
    const before = await readRow(held);

    await expectCustodyRefusal(updateTaskColumns(h.layer(), held, { paused: 0, updatedAt: NOW }), held, "update-columns");
    expect(await readRow(held)).toEqual(before);

    await updateTaskColumns(h.layer(), held, { summary: "column summary" });
    expect((await readRow(held)).summary).toBe("column summary");

    await updateTaskColumns(h.layer(), twin, { paused: 0, updatedAt: NOW });
    expect((await readRow(twin)).paused).toBe(0);
  });

  it("archiveTask refuses a held planning task; the twin archives", async () => {
    const { held, twin } = await seedPair("ARCHIVE");
    const before = await readRow(held);

    await expectCustodyRefusal(h.store().archiveTask(held, { cleanup: false }), held, "archive");
    expect(await readRow(held)).toEqual(before);

    const archived = await h.store().archiveTask(twin, { cleanup: false });
    expect(archived.column).toBe("archived");
  });

  it("deleteTask refuses a held planning task; the twin deletes", async () => {
    const { held, twin } = await seedPair("DELETE");
    const before = await readRow(held);

    await expectCustodyRefusal(h.store().deleteTask(held), held, "delete");
    expect(await readRow(held)).toEqual(before);

    await h.store().deleteTask(twin);
    expect((await readRow(twin)).deletedAt).not.toBeNull();
  });

  /*
  FNXC:CccPlanningCustody 2026-10-14-17:19 (errata E5-G1 item 1):
  On PostgreSQL, `TaskStore.deleteTaskIf` dispatches straight to `deleteTaskIfBackendImpl` and never enters `deleteTaskIfImpl`, so the custody check must live on the backend leaves. The predicate spy proves the check runs before the predicate, which a guard only inside `deleteTaskBackendImpl` would not.
  */
  it("deleteTaskIf refuses a held planning task before its predicate runs and leaves the row unchanged; the twin is soft-deleted", async () => {
    const { held, twin } = await seedPair("DELETEIF");
    const before = await readRow(held);
    let predicateCalls = 0;
    const predicate = (): boolean => {
      predicateCalls += 1;
      return true;
    };

    await expectCustodyRefusal(h.store().deleteTaskIf(held, predicate), held, "delete");
    expect(predicateCalls).toBe(0);
    expect(await readRow(held)).toEqual(before);

    const result = await h.store().deleteTaskIf(twin, predicate);
    expect(result.deleted).toBe(true);
    expect(predicateCalls).toBe(1);
    expect((await readRow(twin)).deletedAt).not.toBeNull();
  });

  it("direct deleteTaskBackend and archiveTaskBackend calls refuse a held planning task; the twin is deleted and another twin archived", async () => {
    const { held, twin } = await seedPair("BACKEND");
    const archiveTwin = "FN-G1-BACKEND-ARCHIVE-TWIN";
    await seedMarkedTask(archiveTwin, "triage");
    const before = await readRow(held);

    await expectCustodyRefusal(h.store().deleteTaskBackend(held), held, "delete");
    expect(await readRow(held)).toEqual(before);
    await expectCustodyRefusal(h.store().archiveTaskBackend(held, { cleanup: false }), held, "archive");
    expect(await readRow(held)).toEqual(before);

    await h.store().deleteTaskBackend(twin);
    expect((await readRow(twin)).deletedAt).not.toBeNull();
    const archived = await h.store().archiveTaskBackend(archiveTwin, { cleanup: false });
    expect(archived.column).toBe("archived");
  });

  /*
  FNXC:CccPlanningCustody 2026-10-14-17:19 (errata E5-G1 item 2):
  `updateTaskDependencies` writes its todo-to-triage move through the snapshot writer `atomicWriteTaskJsonWithAudit`, never through `updateTaskUnlocked` or `updateTaskColumns`. The backstop inside both snapshot write primitives refuses it inside the write transaction, so the dependency, the log line and the audit row all roll back.
  */
  it("updateTaskDependencies adding a dependency to a held todo planning task is refused and the row is unchanged; the twin moves to triage", async () => {
    const { held, twin } = await seedPair("DEPS", "todo");
    const dependency = "FN-G1-DEPS-DEP";
    await h.store().createTaskWithReservedId(
      { description: "dependency", column: "todo" },
      { taskId: dependency, createdAt: NOW, updatedAt: NOW, applyDefaultWorkflowSteps: false },
    );
    const before = await readRow(held);

    await expectCustodyRefusal(
      h.store().updateTaskDependencies(held, { operation: "add", dependency }),
      held,
      "update-columns",
    );
    expect(await readRow(held)).toEqual(before);
    expect((await h.store().getTask(held)).dependencies ?? []).toEqual([]);

    await h.store().updateTaskDependencies(twin, { operation: "add", dependency });
    expect(await readRow(twin)).toMatchObject({ column: "triage", status: null });
  });

  it("a direct snapshot write that changes any custody column of a held planning task is refused by both snapshot writers; a summary write lands and the twin's column write lands", async () => {
    const { held, twin } = await seedPair("SNAPSHOT");
    const store = h.store();
    const before = await readRow(held);
    const releases: ReadonlyArray<Partial<Task>> = [
      { column: "todo" },
      { paused: false },
      { userPaused: true },
      { lineageId: "lineage-g1-released" },
      { deletedAt: NOW },
    ];

    for (const release of releases) {
      const task = await store.getTask(held);
      await expectCustodyRefusal(store.atomicWriteTaskJson(store.taskDir(held), { ...task, ...release }), held, "update-columns");
      expect(await readRow(held)).toEqual(before);
      await expectCustodyRefusal(
        store.atomicWriteTaskJsonWithAudit(store.taskDir(held), { ...task, ...release }),
        held,
        "update-columns",
      );
      expect(await readRow(held)).toEqual(before);
    }

    const current = await store.getTask(held);
    await store.atomicWriteTaskJson(store.taskDir(held), { ...current, summary: "snapshot summary" });
    expect(await readRow(held)).toEqual({ ...before, summary: "snapshot summary" });
    await store.atomicWriteTaskJsonWithAudit(store.taskDir(held), { ...current, summary: "audited summary" });
    expect(await readRow(held)).toEqual({ ...before, summary: "audited summary" });

    const twinTask = await store.getTask(twin);
    await store.atomicWriteTaskJson(store.taskDir(twin), { ...twinTask, column: "todo" });
    expect((await readRow(twin)).column).toBe("todo");
    await store.atomicWriteTaskJsonWithAudit(store.taskDir(twin), { ...twinTask, column: "todo", userPaused: true });
    expect((await readRow(twin)).userPaused).toBe(1);
  });

  /*
  FNXC:CccPlanningCustody 2026-10-14-17:19 (errata E5-G1 item 3):
  Coverage of the guards round 1 already had. An anchored task whose K1 marker is cleared is not held, which proves the marker half of the custody predicate matters; moveTaskIf and handoffToReview reach only the in-lock guard in moveTaskInternal.
  */
  it("an anchored task whose marker is cleared is not held: pauseTask(false), moveTask and deleteTaskIf go through", async () => {
    const { held } = await seedPair("CLEARED");
    await h.adminDb().update(schema.project.tasks).set({ userPaused: 1 }).where(eq(schema.project.tasks.id, held));
    h.store().taskCache.delete(held);
    const anchors = await h.adminDb().select({ runId: cccPlanningRuns.runId }).from(cccPlanningRuns).where(eq(cccPlanningRuns.planningTaskId, held));
    expect(anchors).toHaveLength(1);

    await h.store().pauseTask(held, false);
    expect(await readRow(held)).toMatchObject({ paused: 0, userPaused: 0 });
    await h.store().moveTask(held, "todo");
    expect((await readRow(held)).column).toBe("todo");
    const result = await h.store().deleteTaskIf(held, () => true);
    expect(result.deleted).toBe(true);
    expect((await readRow(held)).deletedAt).not.toBeNull();
  });

  it("the snapshot backstop queries nothing for an unmarked row or a non-custody change, and looks up the anchor only for a custody change on a marked row", async () => {
    const noQuery = {
      select: () => {
        throw new Error("unexpected anchor query");
      },
    } as unknown as Parameters<typeof assertCccPlanningSnapshotWritePreservesCustody>[0];
    const marked = { lineageId: nextRunId(), paused: 1, userPaused: 0 };
    const ordinary = { lineageId: "lineage-g1-ordinary", paused: 1, userPaused: 0 };

    await expect(assertCccPlanningSnapshotWritePreservesCustody(noQuery, undefined, "FN-G1-PURE", ordinary, new Set(["column", "paused"]))).resolves.toBeUndefined();
    await expect(assertCccPlanningSnapshotWritePreservesCustody(noQuery, undefined, "FN-G1-PURE", { ...marked, userPaused: 1 }, new Set(["column"]))).resolves.toBeUndefined();
    await expect(assertCccPlanningSnapshotWritePreservesCustody(noQuery, undefined, "FN-G1-PURE", marked, new Set(["summary", "log"]))).resolves.toBeUndefined();
    await expect(assertCccPlanningSnapshotWritePreservesCustody(noQuery, undefined, "FN-G1-PURE", marked, new Set(["column"]))).rejects.toThrow("unexpected anchor query");
  });

  it("moveTaskIf and handoffToReview refuse a held planning task under the task lock; the twins move and hand off", async () => {
    const { held, twin } = await seedPair("MOVEIF");
    const handoff = await seedPair("HANDOFF", "in-progress");
    const beforeMove = await readRow(held);
    const beforeHandoff = await readRow(handoff.held);
    const evidence = { reason: "fn_task_done", runId: "run-g1", agentId: "agent-g1" };

    await expectCustodyRefusal(h.store().moveTaskIf(held, "todo", () => true), held, "move");
    expect(await readRow(held)).toEqual(beforeMove);
    await expectCustodyRefusal(h.store().handoffToReview(handoff.held, { ownerAgentId: "agent-g1", evidence }), handoff.held, "move");
    expect(await readRow(handoff.held)).toEqual(beforeHandoff);

    const moved = await h.store().moveTaskIf(twin, "todo", () => true);
    expect(moved.moved).toBe(true);
    expect((await readRow(twin)).column).toBe("todo");
    await h.store().handoffToReview(handoff.twin, { ownerAgentId: "agent-g1", evidence });
    expect((await readRow(handoff.twin)).column).toBe("in-review");
  });
});
