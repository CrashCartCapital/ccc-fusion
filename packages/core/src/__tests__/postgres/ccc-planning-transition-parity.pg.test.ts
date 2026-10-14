/**
 * FNXC:CccPlanningTransitionParity 2026-10-14-13:51 (card L1):
 * K1's `cccPlanningTransitionAllowed` must equal `project.ccc_planning_run_transition_allowed` (migration 0042) for all
 * 400 (from, to) pairs, with exactly 65 non-identity pairs allowed. L1's `transitionCccPlanningRunState` refuses a
 * pair outside that table before any write, and the anchor trigger agrees with it on an allowed pair.
 */
import { createHash } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  createTaskStoreForTest,
  pgDescribe,
  type PgTestHarness,
} from "../../__test-utils__/pg-test-harness.js";
import { cccPlanningRuns } from "../../postgres/schema/ccc-planning.js";
import {
  CCC_PLANNING_RUN_STATES,
  cccPlanningTransitionAllowed,
  type CccPlanningRunState,
} from "../../ccc-planning/types.js";
import { transitionCccPlanningRunState } from "../../task-store/ccc-planning-ops.js";

const PROJECT = "r2c-l1-parity";
const NOW = "2026-10-14T12:00:00.000Z";
const FAR = "2999-01-01T00:00:00.000Z";

function sha(label: string): string {
  return createHash("sha256").update(label, "utf8").digest("hex");
}

pgDescribe("ccc planning transition parity (card L1, PostgreSQL)", () => {
  let harness: PgTestHarness;
  let db: PostgresJsDatabase;

  beforeAll(async () => {
    harness = await createTaskStoreForTest({ prefix: "fusion_ccc_planning_l1_parity", copyFromGolden: true });
    db = harness.adminDb;
  });

  afterAll(async () => {
    await harness?.teardown();
  });

  it("K1 and the SQL function agree on all 400 pairs, and exactly 65 non-identity pairs are allowed", async () => {
    const values = CCC_PLANNING_RUN_STATES.map((state) => `('${state}')`).join(", ");
    const rows = (await db.execute(sql.raw(`
      SELECT f.s AS from_state, t.s AS to_state, project.ccc_planning_run_transition_allowed(f.s, t.s) AS allowed
        FROM (VALUES ${values}) AS f(s) CROSS JOIN (VALUES ${values}) AS t(s)
    `))) as unknown as Array<{ from_state: CccPlanningRunState; to_state: CccPlanningRunState; allowed: boolean }>;
    expect(rows).toHaveLength(400);
    const disagreements = rows
      .filter((row) => row.allowed !== cccPlanningTransitionAllowed(row.from_state, row.to_state))
      .map((row) => `${row.from_state}->${row.to_state}`);
    expect(disagreements).toEqual([]);
    expect(rows.filter((row) => row.allowed && row.from_state !== row.to_state)).toHaveLength(65);
    expect(rows.filter((row) => row.allowed && row.from_state === row.to_state)).toHaveLength(20);
  });

  it("refuses a pair outside the table before any write and applies an allowed pair with a state event", async () => {
    const runId = `ccc-plan:${sha("r2c-l1-parity-run").slice(0, 24)}`;
    await db.execute(sql`
      INSERT INTO project.tasks (project_id, id, description, "column", created_at, updated_at)
      VALUES (${PROJECT}, 'R2C-L1-PARITY', 'request-to-code parity fixture', 'todo', ${NOW}, ${NOW})
    `);
    await db.insert(cccPlanningRuns).values({
      projectId: PROJECT, runId, planningTaskId: "R2C-L1-PARITY", mode: "build", budgetProfile: "standard",
      roleProfile: "full-v2", policyVersion: "ccc-planning.budget-policy.v1", policyDigest: sha("policy"),
      requestDigest: sha("request"), requestBytes: 512, targetRepository: "/private/tmp/r2c-l1-target",
      admittedBase: "b".repeat(40), grantDigest: sha("grant"), authorityReceiptSha256: sha("receipt"),
      authorityReceiptJson: "{}", runtimeDistManifestSha256: sha("dist"), state: "admitted", deadlineAt: FAR,
      planningAllocation: 40, implementationAllocation: 20, reviewProofAllocation: 10, researchFetchAllocation: 5,
      researchBytesAllocation: 1_048_576, createdAt: NOW, updatedAt: NOW,
    });
    const read = async () => (await db.execute(sql`
      SELECT state FROM project.ccc_planning_runs WHERE project_id = ${PROJECT} AND run_id = ${runId}
    `)) as unknown as Array<{ state: string }>;
    const stateEvents = async () => (await db.execute(sql`
      SELECT metadata FROM project.run_audit_events WHERE run_id = ${runId} AND mutation_type = 'ccc-planning:state'
    `)) as unknown as Array<{ metadata: Record<string, unknown> }>;

    expect(cccPlanningTransitionAllowed("admitted", "building")).toBe(false);
    await expect(transitionCccPlanningRunState(harness.layer, {
      runId, from: "admitted", to: "building", stateCode: null, fence: null,
    })).rejects.toMatchObject({ name: "CccPlanningRefusal", code: "CCC_PLANNING_STATE_TRANSITION_REFUSED" });
    expect(await read()).toEqual([{ state: "admitted" }]);
    expect(await stateEvents()).toEqual([]);

    await transitionCccPlanningRunState(harness.layer, { runId, from: "admitted", to: "running", stateCode: null, fence: null });
    expect(await read()).toEqual([{ state: "running" }]);
    expect((await stateEvents()).map((row) => row.metadata)).toEqual([
      expect.objectContaining({ from: "admitted", to: "running", stateCode: null }),
    ]);
  });
});
