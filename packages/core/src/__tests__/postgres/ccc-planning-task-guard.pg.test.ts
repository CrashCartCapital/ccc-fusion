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
  async function seedMarkedTask(id: string, column: "triage" | "todo"): Promise<string> {
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
    column: "triage" | "todo" = "triage",
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
});
