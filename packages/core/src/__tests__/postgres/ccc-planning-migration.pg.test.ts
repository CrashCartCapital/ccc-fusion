/**
 * FNXC:CccPlanningRuns 2026-10-14 (card S0):
 * Migrations 0042 (request-to-code planning anchor) and 0043 (immutable
 * planning artifacts on task documents) against a real PostgreSQL.
 *
 * Every refusal is paired with a control that differs by the one offending
 * field and succeeds on the same fixture, so a refusal can never pass because
 * the fixture is broken. Refusals are matched on SQLSTATE plus the
 * CCC_PLANNING_* message prefix that cccPlanningRefusalFromDatabaseError maps.
 *
 * The ownership case boots the applier on an EMPTY database and then boots it
 * again: the project-ownership and relational audit only runs once 0006 is
 * already recorded, so a fresh database audits the anchor on its second boot.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
  createTaskStoreForTest,
  pgDescribe,
  PG_TEST_URL_BASE,
  type PgTestHarness,
} from "../../__test-utils__/pg-test-harness.js";
import {
  applySchemaBaseline,
  CCC_PLANNING_ARTIFACT_GUARD_VERSION,
  CCC_PLANNING_RUNS_VERSION,
  getAppliedMigrations,
  SCHEMA_BASELINE_VERSION,
} from "../../postgres/schema-applier.js";
import { projectTableNames } from "../../postgres/schema/project.js";
import {
  cccPlanningRuns,
  type CccPlanningRunInsert,
} from "../../postgres/schema/ccc-planning.js";

const PROJECT_A = "r2c-s0-project-a";
const PROJECT_B = "r2c-s0-project-b";
const NOW = "2026-10-14T12:00:00.000Z";
const FAR = "2999-01-01T00:00:00.000Z";

const RUN_STATES = [
  "admitted", "running", "awaiting_intent", "awaiting_budget", "awaiting_execution_authority",
  "blocked_prerequisite", "blocked_provider", "budget_exhausted", "unknown_effect", "paused",
  "cancelling", "cancelled", "spec_ready", "importing", "building", "verification_failed",
  "accepted", "delivering", "delivered", "failed",
] as const;

/**
 * The frozen transition list (CONTRACT-v2 section 2.2 plus adjudication item 38,
 * which admits importing -> budget_exhausted for a Build fit that fails after the
 * move to importing). 65 pairs; identity is always allowed and is not listed.
 */
const FROZEN_TRANSITIONS: ReadonlyArray<readonly [string, string]> = [
  ["admitted", "running"], ["admitted", "cancelling"], ["admitted", "failed"], ["admitted", "blocked_prerequisite"],
  ["running", "awaiting_intent"], ["running", "awaiting_budget"], ["running", "blocked_prerequisite"],
  ["running", "blocked_provider"], ["running", "budget_exhausted"], ["running", "unknown_effect"],
  ["running", "paused"], ["running", "cancelling"], ["running", "spec_ready"], ["running", "failed"],
  ["awaiting_intent", "running"], ["awaiting_intent", "cancelling"],
  ["awaiting_budget", "running"], ["awaiting_budget", "building"], ["awaiting_budget", "cancelling"],
  ["blocked_prerequisite", "running"], ["blocked_prerequisite", "building"], ["blocked_prerequisite", "cancelling"],
  ["blocked_provider", "running"], ["blocked_provider", "building"], ["blocked_provider", "cancelling"],
  ["budget_exhausted", "awaiting_budget"], ["budget_exhausted", "cancelling"], ["budget_exhausted", "failed"],
  ["unknown_effect", "running"], ["unknown_effect", "building"], ["unknown_effect", "cancelling"],
  ["paused", "running"], ["paused", "building"], ["paused", "cancelling"],
  ["cancelling", "cancelled"],
  ["spec_ready", "importing"], ["spec_ready", "cancelling"], ["spec_ready", "paused"],
  ["spec_ready", "blocked_prerequisite"], ["spec_ready", "budget_exhausted"], ["spec_ready", "failed"],
  ["importing", "awaiting_execution_authority"], ["importing", "building"],
  ["importing", "blocked_prerequisite"], ["importing", "budget_exhausted"], ["importing", "cancelling"],
  ["importing", "failed"],
  ["awaiting_execution_authority", "building"], ["awaiting_execution_authority", "cancelling"],
  ["awaiting_execution_authority", "failed"],
  ["building", "verification_failed"], ["building", "accepted"], ["building", "paused"],
  ["building", "cancelling"], ["building", "blocked_prerequisite"], ["building", "blocked_provider"],
  ["building", "budget_exhausted"], ["building", "unknown_effect"], ["building", "failed"],
  ["verification_failed", "cancelling"], ["verification_failed", "failed"],
  ["accepted", "delivering"], ["accepted", "cancelling"],
  ["delivering", "delivered"], ["delivering", "failed"],
];

/** States whose state_code is required by ccc_planning_runs_state_code_check. */
const REQUIRED_STATE_CODES: Readonly<Record<string, string>> = {
  awaiting_budget: "CCC_PLANNING_AWAITING_BUDGET",
  blocked_prerequisite: "CCC_PLANNING_RUNTIME_NOT_PERMITTED",
  blocked_provider: "CCC_BLOCKED_PROVIDER",
  budget_exhausted: "CCC_PLANNING_BUILD_FIT_INSUFFICIENT",
  unknown_effect: "CCC_PLANNING_UNRECONCILED_DISPATCH",
  verification_failed: "CCC_PLANNING_REVIEW_REJECTED",
  failed: "CCC_PLANNING_CAMPAIGN_FAILED",
};

function sha(label: string): string {
  return createHash("sha256").update(label, "utf8").digest("hex");
}

let fixtureOrdinal = 0;
function nextRunId(): string {
  fixtureOrdinal += 1;
  return `ccc-plan:${sha(`r2c-s0-run-${fixtureOrdinal}`).slice(0, 24)}`;
}

function anchorValues(
  runId: string,
  planningTaskId: string,
  overrides: Partial<CccPlanningRunInsert> = {},
): CccPlanningRunInsert {
  return {
    projectId: PROJECT_A,
    runId,
    planningTaskId,
    mode: "build",
    budgetProfile: "standard",
    roleProfile: "full-v2",
    policyVersion: "ccc-planning.budget-policy.v1",
    policyDigest: sha("policy"),
    requestDigest: sha(`request:${runId}`),
    requestBytes: 512,
    targetRepository: "/private/tmp/r2c-s0-target",
    admittedBase: "b".repeat(40),
    grantDigest: sha(`grant:${runId}`),
    authorityReceiptSha256: sha(`receipt:${runId}`),
    authorityReceiptJson: JSON.stringify({ runId }),
    runtimeDistManifestSha256: sha("dist"),
    state: "admitted",
    deadlineAt: FAR,
    planningAllocation: 40,
    implementationAllocation: 20,
    reviewProofAllocation: 10,
    researchFetchAllocation: 5,
    researchBytesAllocation: 1_048_576,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

/** Drizzle wraps driver errors; the PostgresError with code and message is the cause. */
async function expectRefused(statement: Promise<unknown>, sqlState: string, prefix: string): Promise<void> {
  await expect(statement).rejects.toMatchObject({
    cause: expect.objectContaining({
      code: sqlState,
      message: expect.stringMatching(new RegExp(`^${prefix}:`)),
    }),
  });
}

/**
 * FNXC:CccPlanningRuns 2026-10-14-09:24:
 * A refused privilege is SQLSTATE 42501 with PostgreSQL's own message, which
 * carries no CCC_PLANNING_ prefix because no trigger or function raised it.
 */
async function expectPermissionDenied(statement: Promise<unknown>): Promise<void> {
  await expect(statement).rejects.toMatchObject({
    cause: expect.objectContaining({
      code: "42501",
      message: "permission denied for table ccc_planning_runs",
    }),
  });
}

type Transaction = Parameters<Parameters<PostgresJsDatabase["transaction"]>[0]>[0];

interface ArtifactSpec {
  readonly runId: string;
  readonly taskId: string;
  readonly stage: string;
  readonly slot: string;
  readonly kind: string;
  readonly roleId: string;
  readonly producerKind: "model" | "controller" | "operator";
  readonly fence: Record<string, unknown>;
  readonly inputs?: ReadonlyArray<{ readonly artifactKey: string; readonly digest: string }>;
  readonly content?: string;
}

interface Artifact {
  readonly taskId: string;
  readonly key: string;
  readonly content: string;
  readonly author: string;
  readonly digest: string;
  readonly metadata: Record<string, unknown>;
}

/** A v1 envelope (CONTRACT-v2 section 2.6) carrying every field trigger 0043 checks. */
function artifact(spec: ArtifactSpec): Artifact {
  const key = `cccplan-r001-${spec.stage}-${spec.slot}-v01`;
  const content = spec.content ?? JSON.stringify({ artifact: key });
  const digest = sha(content);
  const inputs = [...(spec.inputs ?? [])].sort((a, b) => a.artifactKey.localeCompare(b.artifactKey));
  const metadata = {
    schema: "ccc-planning.artifact-envelope.v1",
    artifactKey: key,
    runId: spec.runId,
    runRevision: 1,
    stageId: spec.stage,
    slot: spec.slot,
    version: 1,
    kind: spec.kind,
    contentType: "application/json",
    contentSchema: `ccc-planning.${spec.kind.replace(/_/g, "-")}.v1`,
    inputs,
    producer: { kind: spec.producerKind, roleId: spec.roleId, instanceId: `${spec.roleId}:1` },
    policy: { promptVersion: "none", promptDigest: "none", toolPolicyVersion: "none", toolPolicyDigest: "none" },
    outputDigest: digest,
    status: "complete",
    fence: spec.fence,
    identityDigest: sha(`identity:${key}:${digest}`),
    publishedAt: NOW,
  };
  return { taskId: spec.taskId, key, content, author: `ccc-planning:${spec.roleId}`, digest, metadata };
}

function ref(a: Artifact): { artifactKey: string; digest: string } {
  return { artifactKey: a.key, digest: a.digest };
}

pgDescribe("ccc planning migrations 0042 and 0043 (PostgreSQL)", () => {
  let harness: PgTestHarness;
  let db: PostgresJsDatabase;

  beforeAll(async () => {
    harness = await createTaskStoreForTest({ prefix: "fusion_ccc_planning_s0", copyFromGolden: true });
    db = harness.adminDb;
  });

  afterAll(async () => {
    await harness?.teardown();
  });

  let taskOrdinal = 0;
  async function insertTask(projectId = PROJECT_A): Promise<string> {
    taskOrdinal += 1;
    const id = `R2C-S0-${taskOrdinal}`;
    await db.execute(sql`
      INSERT INTO project.tasks (project_id, id, description, "column", created_at, updated_at)
      VALUES (${projectId}, ${id}, ${`request-to-code planning task ${id}`}, 'todo', ${NOW}, ${NOW})
    `);
    return id;
  }

  async function admittedRun(overrides: Partial<CccPlanningRunInsert> = {}): Promise<{ runId: string; taskId: string }> {
    const taskId = await insertTask();
    const runId = nextRunId();
    await db.insert(cccPlanningRuns).values(anchorValues(runId, taskId, overrides));
    return { runId, taskId };
  }

  function move(runId: string, to: string): Promise<unknown> {
    return db.execute(sql`
      UPDATE project.ccc_planning_runs
         SET state = ${to}, state_code = ${REQUIRED_STATE_CODES[to] ?? null}, updated_at = ${NOW}
       WHERE project_id = ${PROJECT_A} AND run_id = ${runId}
    `);
  }

  async function walk(runId: string, states: readonly string[]): Promise<void> {
    for (const state of states) await move(runId, state);
  }

  function spendPlanning(runId: string): Promise<unknown> {
    return db.execute(sql`
      UPDATE project.ccc_planning_runs
         SET planning_spent = planning_spent + 1, updated_at = ${NOW}
       WHERE project_id = ${PROJECT_A} AND run_id = ${runId}
    `);
  }

  function setPlanningSpent(runId: string, value: number): Promise<unknown> {
    return db.execute(sql`
      UPDATE project.ccc_planning_runs SET planning_spent = ${value}, updated_at = ${NOW}
       WHERE project_id = ${PROJECT_A} AND run_id = ${runId}
    `);
  }

  function requestPause(runId: string): Promise<unknown> {
    return db.execute(sql`
      UPDATE project.ccc_planning_runs
         SET control_seq = control_seq + 1, control_request = 'pause', control_revision = revision,
             control_requested_at = ${NOW}, updated_at = ${NOW}
       WHERE project_id = ${PROJECT_A} AND run_id = ${runId}
    `);
  }

  /**
   * One transaction as the application's own role: `fusion_runtime`, bound to
   * PROJECT_A with the bypass off. The harness connection is a superuser with
   * the bypass on, so only this wrapper exercises the grants the migration sets.
   */
  function asRuntime<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    return db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE fusion_runtime`);
      await tx.execute(sql`
        SELECT set_config('fusion.project_bypass', 'off', true),
               set_config('fusion.project_id', ${PROJECT_A}, true)
      `);
      return work(tx);
    });
  }

  async function readRun(runId: string): Promise<Record<string, unknown>> {
    const rows = (await db.execute(sql`
      SELECT state, planning_spent, review_epochs, stagnant_epochs, control_seq
        FROM project.ccc_planning_runs WHERE project_id = ${PROJECT_A} AND run_id = ${runId}
    `)) as unknown as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    return rows[0]!;
  }

  function publish(a: Artifact, options: { publisher?: boolean } = {}): Promise<unknown> {
    return db.transaction(async (tx) => {
      if (options.publisher !== false) {
        await tx.execute(sql`SELECT set_config('fusion.ccc_planning_publication', 'on', true)`);
      }
      await tx.execute(sql`
        INSERT INTO project.task_documents
          (project_id, id, task_id, key, content, revision, author, metadata, created_at, updated_at)
        VALUES (${PROJECT_A}, ${`doc-${a.taskId}-${a.key}`}, ${a.taskId}, ${a.key}, ${a.content}, 1,
                ${a.author}, ${JSON.stringify(a.metadata)}::jsonb, ${NOW}, ${NOW})
      `);
    });
  }

  async function insertWorkItem(input: {
    id: string; runId: string; taskId: string; leaseOwner: string; attempt: number;
  }): Promise<void> {
    await db.execute(sql`
      INSERT INTO project.workflow_work_items
        (project_id, id, run_id, task_id, node_id, kind, state, attempt, lease_owner, lease_expires_at,
         created_at, updated_at)
      VALUES (${PROJECT_A}, ${input.id}, ${input.runId}, ${input.taskId}, 'ccc-planning-stage', 'step', 'running',
              ${input.attempt}, ${input.leaseOwner}, ${FAR}, ${NOW}, ${NOW})
    `);
  }

  function originalRequest(runId: string, taskId: string): Artifact {
    return artifact({
      runId, taskId, stage: "admission", slot: "request", kind: "original_request",
      roleId: "controller", producerKind: "controller", fence: { kind: "admission" },
      content: "Add a --version flag that prints the package version.",
    });
  }

  describe("0042 ownership", () => {
    it("refuses an anchor naming a task that exists only in another project; the same-project anchor is admitted", async () => {
      const ownTask = await insertTask(PROJECT_A);
      const foreignTask = await insertTask(PROJECT_B);

      await expect(db.insert(cccPlanningRuns).values(anchorValues(nextRunId(), foreignTask)))
        .rejects.toMatchObject({
          cause: expect.objectContaining({ code: "23503", constraint_name: "ccc_planning_runs_task_fkey" }),
        });

      const runId = nextRunId();
      await db.insert(cccPlanningRuns).values(anchorValues(runId, ownTask));
      expect(await readRun(runId)).toMatchObject({ state: "admitted", planning_spent: 0 });
    });
  });

  describe("0042 anchor guard", () => {
    it("the transition function admits exactly the 65 frozen pairs plus identity over all 400 pairs", async () => {
      const stateList = RUN_STATES.map((state) => `('${state}')`).join(", ");
      const rows = (await db.execute(sql.raw(`
        SELECT f.s AS from_state, t.s AS to_state,
               project.ccc_planning_run_transition_allowed(f.s, t.s) AS allowed
          FROM (VALUES ${stateList}) AS f(s) CROSS JOIN (VALUES ${stateList}) AS t(s)
      `))) as unknown as Array<{ from_state: string; to_state: string; allowed: boolean }>;
      expect(rows).toHaveLength(400);
      expect(new Set(FROZEN_TRANSITIONS.map(([from, to]) => `${from}->${to}`)).size).toBe(65);

      const allowed = rows
        .filter((row) => row.allowed && row.from_state !== row.to_state)
        .map((row) => `${row.from_state}->${row.to_state}`)
        .sort();
      expect(allowed).toEqual(FROZEN_TRANSITIONS.map(([from, to]) => `${from}->${to}`).sort());
      expect(rows.filter((row) => row.from_state === row.to_state).every((row) => row.allowed)).toBe(true);
    });

    it("refuses planning_spent 3 -> 2 with COUNTER_DECREASE; 3 -> 4 is admitted", async () => {
      const { runId } = await admittedRun();
      await move(runId, "running");
      for (let spend = 0; spend < 3; spend += 1) await spendPlanning(runId);
      expect(await readRun(runId)).toMatchObject({ planning_spent: 3 });

      await expectRefused(setPlanningSpent(runId, 2), "23514", "CCC_PLANNING_COUNTER_DECREASE");
      await setPlanningSpent(runId, 4);
      expect(await readRun(runId)).toMatchObject({ planning_spent: 4 });
    });

    it("refuses a spend while control_request is 'pause' with SPEND_REFUSED; the same spend without a control request is admitted", async () => {
      const { runId } = await admittedRun();
      await move(runId, "running");
      await spendPlanning(runId);
      expect(await readRun(runId)).toMatchObject({ planning_spent: 1 });

      await requestPause(runId);
      await expectRefused(spendPlanning(runId), "23514", "CCC_PLANNING_SPEND_REFUSED");
      expect(await readRun(runId)).toMatchObject({ planning_spent: 1, control_seq: 1 });
    });

    it("refuses cancelled -> running with RUN_TERMINAL; paused -> running is admitted", async () => {
      const cancelled = await admittedRun();
      await walk(cancelled.runId, ["running", "cancelling", "cancelled"]);
      await expectRefused(move(cancelled.runId, "running"), "23514", "CCC_PLANNING_RUN_TERMINAL");

      const paused = await admittedRun();
      await walk(paused.runId, ["running", "paused"]);
      await move(paused.runId, "running");
      expect(await readRun(paused.runId)).toMatchObject({ state: "running" });
      expect(await readRun(cancelled.runId)).toMatchObject({ state: "cancelled" });
    });

    it("refuses running -> importing with STATE_TRANSITION_REFUSED; admitted -> blocked_prerequisite and spec_ready -> importing -> budget_exhausted are admitted", async () => {
      const { runId } = await admittedRun();
      await move(runId, "running");
      await expectRefused(move(runId, "importing"), "23514", "CCC_PLANNING_STATE_TRANSITION_REFUSED");

      await walk(runId, ["spec_ready", "importing", "budget_exhausted"]);
      expect(await readRun(runId)).toMatchObject({ state: "budget_exhausted" });

      const blocked = await admittedRun();
      await move(blocked.runId, "blocked_prerequisite");
      expect(await readRun(blocked.runId)).toMatchObject({ state: "blocked_prerequisite" });
    });

    it("refuses stagnant_epochs +1 without review_epochs +1 with REVIEW_EPOCH_INVALID; both +1 is admitted", async () => {
      const { runId } = await admittedRun();
      await move(runId, "running");

      await expectRefused(
        db.execute(sql`
          UPDATE project.ccc_planning_runs SET stagnant_epochs = stagnant_epochs + 1
           WHERE project_id = ${PROJECT_A} AND run_id = ${runId}
        `),
        "23514",
        "CCC_PLANNING_REVIEW_EPOCH_INVALID",
      );
      await db.execute(sql`
        UPDATE project.ccc_planning_runs
           SET stagnant_epochs = stagnant_epochs + 1, review_epochs = review_epochs + 1
         WHERE project_id = ${PROJECT_A} AND run_id = ${runId}
      `);
      expect(await readRun(runId)).toMatchObject({ review_epochs: 1, stagnant_epochs: 1 });
    });
  });

  describe("0042 runtime privileges", () => {
    /*
    FNXC:CccPlanningRuns 2026-10-14-09:24 (errata E1-15):
    The anchor guard fires on INSERT and UPDATE only, and 0006's default
    privileges hand fusion_runtime DELETE on every project table. A DELETE then
    a fresh INSERT would therefore reset planning_spent and the epoch counters
    to zero. 0042 revokes DELETE and TRUNCATE from the runtime role, so the
    reset is a privilege refusal before any row changes.
    */
    it("refuses a delete-and-reinsert counter reset as fusion_runtime with SQLSTATE 42501; the same role's spend UPDATE on the same row is admitted", async () => {
      const { runId, taskId } = await admittedRun();
      await move(runId, "running");
      for (let spend = 0; spend < 5; spend += 1) await spendPlanning(runId);
      expect(await readRun(runId)).toMatchObject({ state: "running", planning_spent: 5 });

      await expectPermissionDenied(asRuntime(async (tx) => {
        await tx.execute(sql`
          DELETE FROM project.ccc_planning_runs WHERE project_id = ${PROJECT_A} AND run_id = ${runId}
        `);
        await tx.insert(cccPlanningRuns).values(anchorValues(runId, taskId));
      }));
      expect(await readRun(runId)).toMatchObject({ state: "running", planning_spent: 5 });

      await asRuntime((tx) => tx.execute(sql`
        UPDATE project.ccc_planning_runs SET planning_spent = planning_spent + 1, updated_at = ${NOW}
         WHERE project_id = ${PROJECT_A} AND run_id = ${runId}
      `));
      expect(await readRun(runId)).toMatchObject({ state: "running", planning_spent: 6 });
    });

    it("refuses DELETE and TRUNCATE of the anchor as fusion_runtime with SQLSTATE 42501; SELECT, INSERT and UPDATE by the same role are admitted", async () => {
      const { runId } = await admittedRun();

      await expectPermissionDenied(asRuntime((tx) => tx.execute(sql`
        DELETE FROM project.ccc_planning_runs WHERE project_id = ${PROJECT_A} AND run_id = ${runId}
      `)));
      await expectPermissionDenied(asRuntime((tx) => tx.execute(sql`TRUNCATE project.ccc_planning_runs`)));
      expect(await readRun(runId)).toMatchObject({ state: "admitted", planning_spent: 0 });

      const selected = await asRuntime((tx) => tx.execute(sql`
        SELECT state FROM project.ccc_planning_runs WHERE project_id = ${PROJECT_A} AND run_id = ${runId}
      `)) as unknown as Array<{ state: string }>;
      expect(selected).toEqual([{ state: "admitted" }]);
      await asRuntime((tx) => tx.execute(sql`
        UPDATE project.ccc_planning_runs SET state = 'running', updated_at = ${NOW}
         WHERE project_id = ${PROJECT_A} AND run_id = ${runId}
      `));
      expect(await readRun(runId)).toMatchObject({ state: "running" });

      const insertedTask = await insertTask();
      const insertedRun = nextRunId();
      await asRuntime((tx) => tx.insert(cccPlanningRuns).values(anchorValues(insertedRun, insertedTask)));
      expect(await readRun(insertedRun)).toMatchObject({ state: "admitted", planning_spent: 0 });
    });
  });

  describe("0043 artifact guard", () => {
    it("refuses a reserved-key insert without the publisher GUC with PUBLISHER_REQUIRED; the same insert with it is admitted", async () => {
      const { runId, taskId } = await admittedRun();
      const request = originalRequest(runId, taskId);

      await expectRefused(publish(request, { publisher: false }), "P0001", "CCC_PLANNING_ARTIFACT_PUBLISHER_REQUIRED");
      await publish(request);
      const rows = (await db.execute(sql`
        SELECT key, author, revision FROM project.task_documents
         WHERE project_id = ${PROJECT_A} AND task_id = ${taskId}
      `)) as unknown as Array<Record<string, unknown>>;
      expect(rows).toEqual([{ key: request.key, author: "ccc-planning:controller", revision: 1 }]);
    });

    it("refuses a design_alternative whose closure holds another one with DESIGN_SEAL_BROKEN, directly and through a review; a closure without one is admitted", async () => {
      const { runId, taskId } = await admittedRun();
      const request = originalRequest(runId, taskId);
      await publish(request);
      await move(runId, "running");
      const leaseOwner = "ccc-planning-host:s0";
      await insertWorkItem({ id: `WI-${taskId}`, runId, taskId, leaseOwner, attempt: 1 });
      const fence = { kind: "work_item_lease", workItemId: `WI-${taskId}`, leaseOwner, attempt: 1, runId };
      const design = (slot: string, inputs: Artifact[]) => artifact({
        runId, taskId, stage: "design", slot, kind: "design_alternative", roleId: `designer-${slot}`,
        producerKind: "model", fence, inputs: inputs.map(ref),
      });

      const designA = design("a", [request]);
      await publish(designA);

      await expectRefused(publish(design("b", [request, designA])), "P0001", "CCC_PLANNING_DESIGN_SEAL_BROKEN");
      await publish(design("b", [request]));

      const review = artifact({
        runId, taskId, stage: "design-review", slot: "a", kind: "design_review", roleId: "design-reviewer",
        producerKind: "model", fence, inputs: [ref(designA)],
      });
      await publish(review);
      await expectRefused(publish(design("c", [review])), "P0001", "CCC_PLANNING_DESIGN_SEAL_BROKEN");
      await publish(design("c", [request]));
    });

    it("refuses UPDATE and DELETE of a planning artifact with IMMUTABLE; the same writes on an ordinary document are admitted", async () => {
      const { runId, taskId } = await admittedRun();
      const request = originalRequest(runId, taskId);
      await publish(request);
      await db.execute(sql`
        INSERT INTO project.task_documents (project_id, id, task_id, key, content, created_at, updated_at)
        VALUES (${PROJECT_A}, ${`doc-${taskId}-notes`}, ${taskId}, 'notes.md', 'draft', ${NOW}, ${NOW})
      `);
      // Built from parts so a secret scanner does not read the literal as a credential.
      const reservedName = ["cccplan", "r001", "admission", "forged", "v01"].join("-");

      await expectRefused(
        db.execute(sql`
          UPDATE project.task_documents SET content = 'rewritten'
           WHERE project_id = ${PROJECT_A} AND task_id = ${taskId} AND key = ${request.key}
        `),
        "P0001",
        "CCC_PLANNING_ARTIFACT_IMMUTABLE",
      );
      await expectRefused(
        db.execute(sql`
          UPDATE project.task_documents SET key = ${reservedName}
           WHERE project_id = ${PROJECT_A} AND task_id = ${taskId} AND key = 'notes.md'
        `),
        "P0001",
        "CCC_PLANNING_ARTIFACT_IMMUTABLE",
      );
      await expectRefused(
        db.execute(sql`
          DELETE FROM project.task_documents
           WHERE project_id = ${PROJECT_A} AND task_id = ${taskId} AND key = ${request.key}
        `),
        "P0001",
        "CCC_PLANNING_ARTIFACT_IMMUTABLE",
      );

      await db.execute(sql`
        UPDATE project.task_documents SET content = 'rewritten'
         WHERE project_id = ${PROJECT_A} AND task_id = ${taskId} AND key = 'notes.md'
      `);
      await db.execute(sql`
        DELETE FROM project.task_documents
         WHERE project_id = ${PROJECT_A} AND task_id = ${taskId} AND key = 'notes.md'
      `);
      const rows = (await db.execute(sql`
        SELECT key, content FROM project.task_documents
         WHERE project_id = ${PROJECT_A} AND task_id = ${taskId}
      `)) as unknown as Array<Record<string, unknown>>;
      expect(rows).toEqual([{ key: request.key, content: request.content }]);
    });

    it("refuses an operator fence with a stale controlSeq with FENCE_REFUSED; the current controlSeq is admitted", async () => {
      const { runId, taskId } = await admittedRun();
      await move(runId, "running");
      await requestPause(runId);
      expect(await readRun(runId)).toMatchObject({ control_seq: 1 });
      const answer = (controlSeq: number) => artifact({
        runId, taskId, stage: "operator", slot: "answer1", kind: "operator_answer", roleId: "operator",
        producerKind: "operator", fence: { kind: "operator", runRevision: 1, controlSeq },
      });

      await expectRefused(publish(answer(0)), "P0001", "CCC_PLANNING_ARTIFACT_FENCE_REFUSED");
      await publish(answer(1));
    });

    it("refuses a campaign fence whose runId is not ccc-prd:<import_id> with FENCE_REFUSED; the campaign's own lease is admitted", async () => {
      const { runId, taskId } = await admittedRun();
      const importId = `r2c-s0-import-${taskId}`;
      const digest = sha(`import:${importId}`);
      await db.execute(sql`
        INSERT INTO project.ccc_prd_imports (
          project_id, idempotency_key, import_id, identity_hash, bundle_hash, packet_hash, sidecar_hash,
          source_version, target_repository, target_base, root_dir, staging_relative_path, state,
          canonical_bundle, transaction_witness, projection_digest, created_at, updated_at,
          execution_policy, campaign_manifest, campaign_manifest_hash, campaign_started_at, campaign_deadline_at
        ) VALUES (
          ${PROJECT_A}, ${`${runId}:r1`}, ${importId}, ${digest}, ${digest}, ${digest}, ${digest},
          'v1', '/private/tmp/r2c-s0-target', ${"b".repeat(40)}, '/private/tmp/r2c-s0-root', 'stage', 'prepared',
          '{}'::jsonb, '{}'::jsonb, ${digest}, ${NOW}, ${NOW},
          '{}'::jsonb, '{}'::jsonb, ${digest}, ${NOW}, ${FAR}
        )
      `);
      await walk(runId, ["running", "spec_ready"]);
      await db.execute(sql`
        UPDATE project.ccc_planning_runs
           SET state = 'importing', import_intent_digest = ${sha(`intent:${runId}`)},
               import_idempotency_key = ${`${runId}:r1`}, updated_at = ${NOW}
         WHERE project_id = ${PROJECT_A} AND run_id = ${runId}
      `);
      await db.execute(sql`
        UPDATE project.ccc_planning_runs
           SET state = 'building', import_id = ${importId}, implementation_transferred = 5, updated_at = ${NOW}
         WHERE project_id = ${PROJECT_A} AND run_id = ${runId}
      `);
      expect(await readRun(runId)).toMatchObject({ state: "building" });

      const leaseOwner = "ccc-campaign-worker:s0";
      const campaignTask = await insertTask();
      await insertWorkItem({
        id: `WI-campaign-${taskId}`, runId: `ccc-prd:${importId}`, taskId: campaignTask, leaseOwner, attempt: 1,
      });
      await insertWorkItem({ id: `WI-planning-${taskId}`, runId, taskId, leaseOwner, attempt: 1 });
      const review = (workItemId: string, fenceRunId: string) => artifact({
        runId, taskId, stage: "g7", slot: "t1", kind: "task_review", roleId: "task-reviewer", producerKind: "model",
        fence: { kind: "campaign_work_item_lease", workItemId, leaseOwner, attempt: 1, runId: fenceRunId },
      });

      // A live, leased work item whose run is the planning run, not the imported campaign.
      await expectRefused(
        publish(review(`WI-planning-${taskId}`, runId)),
        "P0001",
        "CCC_PLANNING_ARTIFACT_FENCE_REFUSED",
      );
      await publish(review(`WI-campaign-${taskId}`, `ccc-prd:${importId}`));
    });
  });
});

/**
 * FNXC:CccPlanningRuns 2026-10-14:
 * Boot the applier on an empty database, then again on the same database. The
 * second boot runs the ownership and relational audit over the anchor. The
 * same test then breaks the anchor's isolation and its key scoping one at a
 * time and requires the audit to name it, so the green boots cannot be green
 * merely because the audit never looked at the table.
 */
pgDescribe("ccc planning migration 0042: fresh database ownership audit", () => {
  it("a fresh database applies 0000-0043, boots a second time through the ownership audit, and the audit refuses the anchor once its policy or key scoping is broken", async () => {
    const dbName = `fusion_ccc_planning_s0_boot_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
    const maintenance = postgres(`${PG_TEST_URL_BASE}/postgres`, { max: 1, prepare: false, onnotice: () => {} });
    let client: ReturnType<typeof postgres> | null = null;
    try {
      await maintenance.unsafe(`CREATE DATABASE "${dbName}"`);
      client = postgres(`${PG_TEST_URL_BASE}/${dbName}`, { max: 2, prepare: false, onnotice: () => {} });
      const fresh = drizzle(client);

      await expect(applySchemaBaseline(fresh)).resolves.toMatchObject({ applied: true });
      const applied = await getAppliedMigrations(fresh);
      expect(applied).toEqual(expect.arrayContaining(["0006", "0041", "0042", "0043"]));
      await expect(applySchemaBaseline(fresh)).resolves.toMatchObject({ applied: false });

      const ownership = (await fresh.execute(sql`
        SELECT c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
          EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'fusion_project_isolation') AS policy,
          EXISTS (SELECT 1 FROM pg_trigger g WHERE g.tgrelid = c.oid AND g.tgname = 'fusion_assign_project_id'
                  AND NOT g.tgisinternal) AS assign_trigger,
          EXISTS (SELECT 1 FROM pg_trigger g WHERE g.tgrelid = c.oid AND g.tgname = 'ccc_planning_runs_guard'
                  AND NOT g.tgisinternal) AS guard_trigger,
          has_table_privilege('fusion_runtime', c.oid, 'SELECT') AS runtime_select,
          has_table_privilege('fusion_runtime', c.oid, 'INSERT') AS runtime_insert,
          has_table_privilege('fusion_runtime', c.oid, 'UPDATE') AS runtime_update,
          has_table_privilege('fusion_runtime', c.oid, 'DELETE') AS runtime_delete,
          has_table_privilege('fusion_runtime', c.oid, 'TRUNCATE') AS runtime_truncate
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'project' AND c.relname = 'ccc_planning_runs'
      `)) as unknown as Array<Record<string, boolean>>;
      // One privilege per column: a multi-privilege has_table_privilege passes when any one is held.
      expect(ownership).toEqual([{
        rls: true, forced: true, policy: true, assign_trigger: true, guard_trigger: true,
        runtime_select: true, runtime_insert: true, runtime_update: true,
        runtime_delete: false, runtime_truncate: false,
      }]);

      const keys = (await fresh.execute(sql`
        SELECT conname, contype, condeferrable, condeferred, pg_get_constraintdef(oid) AS definition
          FROM pg_constraint
         WHERE conrelid = 'project.ccc_planning_runs'::regclass AND contype IN ('p', 'u', 'f')
         ORDER BY conname
      `)) as unknown as Array<{
        conname: string; contype: string; condeferrable: boolean; condeferred: boolean; definition: string;
      }>;
      expect(keys.map(({ conname }) => conname)).toEqual([
        "ccc_planning_runs_authority_receipt_unique",
        "ccc_planning_runs_import_fkey",
        "ccc_planning_runs_import_key_unique",
        "ccc_planning_runs_import_unique",
        "ccc_planning_runs_pkey",
        "ccc_planning_runs_task_fkey",
        "ccc_planning_runs_task_unique",
      ]);
      for (const constraint of keys) {
        expect(constraint.definition).toMatch(/^(PRIMARY KEY|UNIQUE|FOREIGN KEY) \(project_id, /);
      }
      expect(keys.find(({ conname }) => conname === "ccc_planning_runs_task_fkey")).toMatchObject({
        condeferrable: true,
        condeferred: false,
        definition: expect.stringContaining("REFERENCES project.tasks(project_id, id)"),
      });

      const guard = (await fresh.execute(sql`
        SELECT tgname FROM pg_trigger
         WHERE tgrelid = 'project.task_documents'::regclass AND tgname = 'zz_ccc_planning_artifact_guard'
      `)) as unknown as Array<{ tgname: string }>;
      expect(guard).toEqual([{ tgname: "zz_ccc_planning_artifact_guard" }]);

      await fresh.execute(sql`DROP POLICY fusion_project_isolation ON project.ccc_planning_runs`);
      await expect(applySchemaBaseline(fresh)).rejects.toThrow(
        /Project-owned tables are missing required isolation: .*project\.ccc_planning_runs/,
      );
      await fresh.execute(sql`
        CREATE POLICY fusion_project_isolation ON project.ccc_planning_runs
          USING (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true))
          WITH CHECK (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true))
      `);
      await expect(applySchemaBaseline(fresh)).resolves.toMatchObject({ applied: false });

      await fresh.execute(sql`
        ALTER TABLE project.ccc_planning_runs ADD CONSTRAINT ccc_planning_runs_global_run_unique UNIQUE (run_id)
      `);
      await expect(applySchemaBaseline(fresh)).rejects.toThrow(
        /Project-owned keys or relationships are globally scoped: .*ccc_planning_runs\.ccc_planning_runs_global_run_unique/,
      );
    } finally {
      await client?.end({ timeout: 5 });
      await maintenance.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await maintenance.end({ timeout: 5 });
    }
  });
});

describe("ccc planning migrations 0042 and 0043: registration", () => {
  it("registers 0042 and 0043 in order after 0041 and advances the ceiling to 0043", () => {
    expect(CCC_PLANNING_RUNS_VERSION).toBe("0042");
    expect(CCC_PLANNING_ARTIFACT_GUARD_VERSION).toBe("0043");
    expect(SCHEMA_BASELINE_VERSION).toBe("0043");
    const applierSource = readFileSync(
      fileURLToPath(new URL("../../postgres/schema-applier.ts", import.meta.url)),
      "utf8",
    );
    const stopped = applierSource.indexOf("0041_ccc_prd_import_stopped_state.sql");
    const runs = applierSource.indexOf("0042_ccc_planning_runs.sql");
    const guard = applierSource.indexOf("0043_ccc_planning_artifact_guard.sql");
    expect(stopped).toBeGreaterThan(0);
    expect(runs).toBeGreaterThan(stopped);
    expect(guard).toBeGreaterThan(runs);
    expect(applierSource).toMatch(/cccPlanningRunsAlreadyApplied\s*=\s*applied\.includes\(\s*CCC_PLANNING_RUNS_VERSION\s*,?\s*\)/);
    expect(applierSource).toMatch(
      /cccPlanningArtifactGuardAlreadyApplied\s*=\s*applied\.includes\(\s*CCC_PLANNING_ARTIFACT_GUARD_VERSION\s*,?\s*\)/,
    );
    expect(applierSource.indexOf("if (!cccPlanningArtifactGuardAlreadyApplied)"))
      .toBeGreaterThan(applierSource.indexOf("if (!cccPlanningRunsAlreadyApplied)"));
  });

  it("lists ccc_planning_runs among the project-owned tables and mirrors the composite keys in Drizzle", () => {
    expect(projectTableNames).toContain("ccc_planning_runs");
    expect(new Set(projectTableNames).size).toBe(projectTableNames.length);
    const config = getTableConfig(cccPlanningRuns);
    expect(config.schema).toBe("project");
    expect(config.name).toBe("ccc_planning_runs");
    expect(config.primaryKeys.map((primary) => primary.columns.map((column) => column.name)))
      .toEqual([["project_id", "run_id"]]);
    const foreignKeys = config.foreignKeys.map((fk) => {
      const reference = fk.reference();
      return {
        name: fk.getName(),
        columns: reference.columns.map((column) => column.name),
        foreignColumns: reference.foreignColumns.map((column) => column.name),
        foreignTable: getTableConfig(reference.foreignTable).name,
      };
    }).sort((a, b) => a.name.localeCompare(b.name));
    expect(foreignKeys).toEqual([
      {
        name: "ccc_planning_runs_import_fkey",
        columns: ["project_id", "import_id"],
        foreignColumns: ["project_id", "import_id"],
        foreignTable: "ccc_prd_imports",
      },
      {
        name: "ccc_planning_runs_task_fkey",
        columns: ["project_id", "planning_task_id"],
        foreignColumns: ["project_id", "id"],
        foreignTable: "tasks",
      },
    ]);
    for (const constraint of config.uniqueConstraints) {
      expect(constraint.columns[0]?.name).toBe("project_id");
    }
  });
});
