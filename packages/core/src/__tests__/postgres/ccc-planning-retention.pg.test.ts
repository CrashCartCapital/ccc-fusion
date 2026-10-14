/**
 * FNXC:CccPlanningRetention 2026-10-14-13:51 (card L1, D5):
 * Operational retention never deletes request-to-code planning audit rows (`run_id LIKE 'ccc-plan:%'`), because the
 * planning call ledger, control history and repair counters are folded from them. The control row proves the prune
 * really ran: an equally old non-planning event on the same task is deleted.
 *
 * "0 days" is the smallest positive window here (1 ms): `pruneOperationalLogsAsync` treats a window <= 0 as
 * "retention disabled" (operationalLogRetentionDays 0), so a literal 0 would delete nothing and prove nothing.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  createTaskStoreForTest,
  pgDescribe,
  type PgTestHarness,
} from "../../__test-utils__/pg-test-harness.js";
import { pruneOperationalLogsAsync } from "../../task-store/async-maintenance.js";

const PROJECT = "r2c-l1-retention";
const OLD = "2020-01-01T00:00:00.000Z";
const PLANNING_RUN = "ccc-plan:0123456789abcdef01234567";
const SMALLEST_WINDOW_MS = 1;

pgDescribe("ccc planning retention exclusion (card L1, PostgreSQL)", () => {
  let harness: PgTestHarness;
  let db: PostgresJsDatabase;

  beforeAll(async () => {
    harness = await createTaskStoreForTest({ prefix: "fusion_ccc_planning_l1_retention", copyFromGolden: true });
    db = harness.adminDb;
  });

  afterAll(async () => {
    await harness?.teardown();
  });

  async function insertEvent(id: string, taskId: string, runId: string, mutationType: string): Promise<void> {
    await db.execute(sql`
      INSERT INTO project.run_audit_events (project_id, id, timestamp, task_id, agent_id, run_id, domain, mutation_type, target, metadata)
      VALUES (${PROJECT}, ${id}, ${OLD}, ${taskId}, 'ccc-planning-controller', ${runId}, 'database', ${mutationType}, ${id},
              '{}'::jsonb)
    `);
  }

  async function eventIds(): Promise<string[]> {
    const rows = (await db.execute(sql`
      SELECT id FROM project.run_audit_events WHERE project_id = ${PROJECT} ORDER BY id
    `)) as unknown as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  it("keeps an old ccc-plan: audit row and deletes an equally old non-planning row on the same task", async () => {
    await db.execute(sql`
      INSERT INTO project.tasks (project_id, id, description, "column", created_at, updated_at)
      VALUES (${PROJECT}, 'R2C-L1-RETENTION', 'request-to-code retention fixture', 'todo', ${OLD}, ${OLD})
    `);
    await insertEvent("evt-planning", "R2C-L1-RETENTION", PLANNING_RUN, "ccc-planning:call:reserved");
    await insertEvent("evt-ordinary", "R2C-L1-RETENTION", "run-ordinary-1", "task:update");
    expect(await eventIds()).toEqual(["evt-ordinary", "evt-planning"]);

    const result = await pruneOperationalLogsAsync({ ...harness.layer, projectId: PROJECT }, SMALLEST_WINDOW_MS);

    expect(result.deletedByTable.runAuditEvents).toBe(1);
    expect(await eventIds()).toEqual(["evt-planning"]);
  });
});
