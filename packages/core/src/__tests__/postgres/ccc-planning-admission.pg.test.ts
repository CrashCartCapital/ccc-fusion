/**
 * FNXC:CccPlanningAdmission 2026-10-14-20:49 (card AD1):
 * The admission transaction of a request-to-code run against a real PostgreSQL (CONTRACT-v3.4 section 2.11,
 * `admitCccPlanningRun`): one transaction writes, in foreign-key-safe order, the held planning task, the anchor, the
 * planning workflow and its selection, the planning work item with the K1 IR hash, the three admission artifacts and
 * the admitted state event. The run id is K1's derivation over the receipt (errata E5-K2 item 4, E8-W3).
 *
 * Admission runs through a layer bound to one project as the application role (`fusion_runtime`), so row-level
 * security, the 0042 anchor trigger and the 0043 artifact trigger are all live. Rows are read back from PostgreSQL
 * through the separate admin connection, never from the function's return value alone.
 *
 * Non-vacuity of the rollback cases: each hook first proves that its step's insert is in flight. From the admin
 * connection it reads the admitting transaction's relation locks: an INSERT holds RowExclusiveLock on its table until
 * the transaction ends, and the hook only runs after the insert returned. So every step's table is locked at its own
 * hook, and no later step's table is locked yet. Only a real rollback can then leave zero rows. The second proof is
 * the composite task foreign key: the v1 order (anchor before task) fails at the anchor insert.
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
import type { ResolvedBackend } from "../../postgres/backend-resolver.js";
import { createConnectionSetFromUrl, type PostgresConnections } from "../../postgres/connection.js";
import { createAsyncDataLayer, type AsyncDataLayer } from "../../postgres/data-layer.js";
import { cccPlanningRuns, type CccPlanningRunInsert } from "../../postgres/schema/ccc-planning.js";
import { canonicalCccPrdJson } from "../../ccc-prd/contract.js";
import { parseCccPlanningLiveAuthorityReceipt } from "../../ccc-planning/authority.js";
import { CCC_PLANNING_BUDGET_POLICY_V1 } from "../../ccc-planning/budget-fit.js";
import { CccPlanningRefusal, CccPlanningTaskCustodyError, type CccPlanningRefusalCode } from "../../ccc-planning/errors.js";
import { isCccPlanningCustodyTask } from "../../ccc-planning/marker.js";
import {
  CCC_PLANNING_SOURCE_POLICY_I2,
  cccPlanningGrantDigest,
  cccPlanningPolicyDigest,
  cccPlanningRunId,
  cccPlanningSourcePolicySha256,
} from "../../ccc-planning/policy.js";
import type { CccPlanningGrantV1, CccPlanningMode } from "../../ccc-planning/types.js";
import { buildCccPlanningWorkflowIr, cccPlanningWorkflowIrHash } from "../../ccc-planning/workflow-ir.js";
import type { WorkflowIr } from "../../workflow-ir-types.js";
import { hasCccPlanningAnchorForTask } from "../../task-store/ccc-planning-custody.js";
import { admitCccPlanningRun, type CccPlanningAdmissionInput } from "../../task-store/ccc-planning-admission-ops.js";

const PROJECT = "r2c-ad1-project";
const OTHER_PROJECT = "r2c-ad1-other-project";
const ISSUED = "2026-10-14T12:00:00.000Z";
const PARSE_NOW = "2026-10-14T13:00:00.000Z";
const EXPIRES = "2026-10-20T12:00:00.000Z";
const DEADLINES: Readonly<Record<CccPlanningMode, string>> = {
  spec: "2026-10-15T00:00:00.000Z",    // Spec Standard: 12 h
  build: "2026-10-16T12:00:00.000Z",   // Build Standard: 48 h
};
const SCRATCH = "/private/tmp/r2c-ad1-scratch";
const REPOSITORY = `${SCRATCH}/target`;
const BASE = "a".repeat(40);
const DIST = "f".repeat(64);
const FIXTURE_NOW = "2026-10-14T12:00:00.000Z";

const STEPS = ["task", "anchor", "workflow", "work-item", "artifacts"] as const;
type Step = (typeof STEPS)[number];
/** The tables each step inserts into, in the project schema. */
const STEP_TABLES: Readonly<Record<Step, readonly string[]>> = {
  task: ["tasks"],
  anchor: ["ccc_planning_runs"],
  workflow: ["workflows", "task_workflow_selection"],
  "work-item": ["workflow_work_items"],
  artifacts: ["task_documents", "run_audit_events"],
};

type RunRows = Readonly<{
  tasks: number; anchors: number; workflows: number; selections: number; workItems: number; documents: number;
  audit: number; reservations: number;
}>;
const NO_ROWS: RunRows = { tasks: 0, anchors: 0, workflows: 0, selections: 0, workItems: 0, documents: 0, audit: 0, reservations: 0 };
/** One admission: one row per entity, the three admission artifacts, and their three events plus the state event. */
const ONE_ADMISSION: RunRows = {
  tasks: 1, anchors: 1, workflows: 1, selections: 1, workItems: 1, documents: 3, audit: 4, reservations: 1,
};

function sha(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function hexOf(runId: string): string {
  return runId.slice("ccc-plan:".length);
}

function workflowIdOf(runId: string): string {
  return `ccc-plan-${hexOf(runId)}--workflow`;
}

function runIdOf(input: CccPlanningAdmissionInput): string {
  return cccPlanningRunId({
    projectId: input.receipt.project.projectId, requestDigest: input.receipt.request.sha256, receiptSha256: input.receiptSha256,
  });
}

let fixtureOrdinal = 0;

/**
 * A G0-shaped admission input: the receipt is sealed and parsed by K2's own parse, so it is a receipt G0 would accept,
 * and the grant carries the policy allocation of the receipt's profile. Each call makes a new receipt, so a new run.
 */
function admission(options: Readonly<{ mode?: CccPlanningMode; receiptProjectId?: string }> = {}): CccPlanningAdmissionInput {
  fixtureOrdinal += 1;
  const mode = options.mode ?? "build";
  const allocation = CCC_PLANNING_BUDGET_POLICY_V1.profiles[`${mode}:standard`];
  const requestText = `Request ${fixtureOrdinal}: add a --version flag that prints the package version.`;
  const bytes = new TextEncoder().encode(requestText);
  const requestSha256 = sha(requestText);
  const body = {
    schema: "ccc-planning.live-authority-receipt.v1",
    receiptId: `r2c-ad1-receipt-${fixtureOrdinal}`,
    issuedAt: ISSUED, notBefore: ISSUED, expiresAt: EXPIRES,
    operator: { actorId: "ryan", actorName: "Ryan" },
    project: { projectId: options.receiptProjectId ?? PROJECT },
    target: {
      class: "owned_disposable", scratchRoot: SCRATCH, repositoryRealpath: REPOSITORY,
      baseCommit: BASE, baseTree: "b".repeat(40),
      ownershipMarker: { path: `${SCRATCH}/owner.json`, sha256: "c".repeat(64) },
      remotes: [], admittedFusionPaths: ["proof/**", "Taskfile.yml"],
    },
    request: { sha256: requestSha256, byteLength: bytes.byteLength },
    mode, profile: "full-v2", budgetProfile: "standard",
    budgetPolicyVersion: CCC_PLANNING_BUDGET_POLICY_V1.policyVersion, largeAuthorized: false,
    phaseCallCaps: { planning: allocation.planning, implementation: allocation.implementation, reviewProof: allocation.reviewProof },
    deadlineAt: DEADLINES[mode],
    models: { glm53: "glm/glm-5.3", glm53Flash: "glm/glm-5.3-flash", minimaxM3: "minimax/MiniMax-M3" },
    omniRoute: {
      baseUrl: "http://127.0.0.1:20128/v1", receiptAdapterId: "terminal-route-sse-comments.v1",
      providerIds: { glm53: "ccc-glm53", glm53Flash: "ccc-glm53-flash", minimaxM3: "ccc-minimax-m3" },
    },
    quota: { accounting: "subscription_unknown", meteredFallback: "forbidden" },
    escalation: "forbidden",
    permittedProtectedActions: mode === "build" ? [{ kind: "live_execution", release: "controller_within_receipt" }] : [],
    sourceToolPolicy: { policyId: CCC_PLANNING_SOURCE_POLICY_I2.policyId, sha256: cccPlanningSourcePolicySha256() },
    runtime: { installedRuntimeReceiptSha256: "e".repeat(64), packageVersion: "0.43.0", distManifestSha256: DIST },
  };
  const sealed = { ...body, operatorConfirmation: sha(canonicalCccPrdJson(body)) };
  const parsed = parseCccPlanningLiveAuthorityReceipt(new TextEncoder().encode(canonicalCccPrdJson(sealed)), {
    confirmDigest: sealed.operatorConfirmation, now: PARSE_NOW, budgetPolicy: CCC_PLANNING_BUDGET_POLICY_V1,
  });
  if (!parsed.ok) throw new Error(`fixture receipt refused: ${parsed.code} ${parsed.field} ${parsed.detail}`);
  const grant: CccPlanningGrantV1 = {
    schema: "ccc-planning.grant.v1", mode, budgetProfile: "standard",
    budgetPolicyVersion: CCC_PLANNING_BUDGET_POLICY_V1.policyVersion,
    allocations: { planning: allocation.planning, implementation: allocation.implementation, reviewProof: allocation.reviewProof },
    research: { fetches: CCC_PLANNING_SOURCE_POLICY_I2.maxFetchesPerRun, bytes: CCC_PLANNING_SOURCE_POLICY_I2.maxRawBytesPerRun },
    deadlineAt: DEADLINES[mode], sourcePolicyId: CCC_PLANNING_SOURCE_POLICY_I2.policyId, amendmentSeq: 0,
  };
  return {
    projectId: PROJECT, mode, budgetProfile: "standard",
    request: { bytes, sha256: requestSha256 },
    receipt: parsed.receipt, receiptSha256: parsed.receiptSha256, receiptCanonicalJson: canonicalCccPrdJson(parsed.receipt),
    runtimeDistManifestSha256: DIST, targetRepository: REPOSITORY, admittedBase: BASE,
    grant, policyDigest: cccPlanningPolicyDigest(), plannedLeaves: 0,
  };
}

/** A typed refusal with the expected code (and field, when named); message text is never matched. */
async function expectRefusal(attempt: Promise<unknown>, code: CccPlanningRefusalCode, field?: string): Promise<void> {
  const error = await attempt.then(() => null, (failure: unknown) => failure);
  expect(error, `expected a ${code} refusal but the call resolved`).not.toBeNull();
  expect(error).toBeInstanceOf(CccPlanningRefusal);
  expect((error as CccPlanningRefusal).code).toBe(code);
  if (field !== undefined) expect((error as CccPlanningRefusal).field).toBe(field);
}

pgDescribe("ccc planning admission (card AD1, PostgreSQL)", () => {
  let harness: PgTestHarness;
  let db: PostgresJsDatabase;
  let connections: PostgresConnections;
  let layer: AsyncDataLayer;

  beforeAll(async () => {
    harness = await createTaskStoreForTest({ prefix: "fusion_ccc_planning_ad1", copyFromGolden: true });
    db = harness.adminDb;
    const backend: ResolvedBackend = {
      mode: "external", runtimeUrl: harness.testUrl, migrationUrl: harness.testUrl, migrationUrlOverridden: false,
    };
    connections = await createConnectionSetFromUrl(backend, {
      poolMax: 4, connectTimeoutSeconds: 5, projectId: PROJECT, useRuntimeRole: true,
    });
    layer = createAsyncDataLayer(connections, { projectId: PROJECT });
  });

  afterAll(async () => {
    await connections?.close();
    await harness?.teardown();
  });

  async function rows<T = Record<string, unknown>>(query: ReturnType<typeof sql>): Promise<T[]> {
    return (await db.execute(query)) as unknown as T[];
  }

  /** Every row a run can own, counted from the admin connection by the run's own identifiers. */
  async function runRows(runId: string): Promise<RunRows> {
    const [counts] = await rows<RunRows>(sql`
      SELECT
        (SELECT count(*)::int FROM project.tasks WHERE lineage_id = ${runId}) AS "tasks",
        (SELECT count(*)::int FROM project.ccc_planning_runs WHERE run_id = ${runId}) AS "anchors",
        (SELECT count(*)::int FROM project.workflows WHERE id = ${workflowIdOf(runId)}) AS "workflows",
        (SELECT count(*)::int FROM project.task_workflow_selection WHERE workflow_id = ${workflowIdOf(runId)}) AS "selections",
        (SELECT count(*)::int FROM project.workflow_work_items WHERE run_id = ${runId}) AS "workItems",
        (SELECT count(*)::int FROM project.task_documents WHERE metadata->>'runId' = ${runId}) AS "documents",
        (SELECT count(*)::int FROM project.run_audit_events WHERE run_id = ${runId}) AS "audit",
        (SELECT count(*)::int FROM project.distributed_task_id_reservations
          WHERE node_id = ${`ccc-planning-admission:${runId}`}) AS "reservations"
    `);
    return counts!;
  }

  /**
   * The project tables the one open writing transaction in this database holds RowExclusiveLock on: the tables it
   * has inserted into (or updated) and not yet committed. Read from the admin connection while the hook runs.
   */
  async function inFlightTables(): Promise<string[]> {
    const writers = await rows<{ pid: number }>(sql`
      SELECT pid FROM pg_stat_activity
       WHERE datname = current_database() AND pid <> pg_backend_pid() AND backend_xid IS NOT NULL
    `);
    expect(writers, "exactly one open writing transaction (the admission) is expected").toHaveLength(1);
    const locked = await rows<{ relname: string }>(sql`
      SELECT c.relname FROM pg_locks l
        JOIN pg_class c ON c.oid = l.relation
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE l.pid = ${writers[0]!.pid} AND l.locktype = 'relation' AND l.mode = 'RowExclusiveLock' AND l.granted
         AND n.nspname = 'project' AND c.relkind IN ('r', 'p')
    `);
    return locked.map((row) => row.relname).sort();
  }

  function failingAt(failAt: Step, seen: Step[], observe?: (tables: string[]) => void) {
    return {
      afterStep: async (step: Step): Promise<void> => {
        seen.push(step);
        if (step === failAt) {
          observe?.(await inFlightTables());
          throw new Error(`injected failure after the ${failAt} step`);
        }
      },
    };
  }

  it("a clean admission writes one task, anchor, workflow, selection and work item, the three admission artifacts and four audit rows; replaying the receipt refuses RECEIPT_CONSUMED and adds nothing", async () => {
    const input = admission();
    const runId = runIdOf(input);
    const custody = await admitCccPlanningRun(layer, input);

    const grantDigest = cccPlanningGrantDigest(input.grant);
    expect(custody).toEqual({
      kind: "planning", projectId: PROJECT, runId, planningTaskId: custody.planningTaskId, revision: 1, state: "admitted",
      mode: "build", budgetProfile: "standard", deadlineAt: input.grant.deadlineAt, grantDigest, controlSeq: 0,
      importId: null, runtimeDistManifestSha256: DIST,
    });
    expect(await runRows(runId)).toEqual(ONE_ADMISSION);

    const [anchor] = await rows(sql`
      SELECT planning_task_id, state, state_code, mode, budget_profile, role_profile, policy_version, policy_digest,
             request_digest, request_bytes, target_repository, admitted_base, grant_digest, authority_receipt_sha256,
             authority_receipt_json, runtime_dist_manifest_sha256, deadline_at, planning_allocation,
             implementation_allocation, review_proof_allocation, research_fetch_allocation,
             research_bytes_allocation::text AS research_bytes_allocation, revision, control_seq, amendment_seq
        FROM project.ccc_planning_runs WHERE project_id = ${PROJECT} AND run_id = ${runId}
    `);
    expect(anchor).toEqual({
      planning_task_id: custody.planningTaskId, state: "admitted", state_code: null, mode: "build",
      budget_profile: "standard", role_profile: "full-v2", policy_version: CCC_PLANNING_BUDGET_POLICY_V1.policyVersion,
      policy_digest: cccPlanningPolicyDigest(), request_digest: input.request.sha256,
      request_bytes: input.request.bytes.byteLength, target_repository: REPOSITORY, admitted_base: BASE,
      grant_digest: grantDigest, authority_receipt_sha256: input.receiptSha256,
      authority_receipt_json: input.receiptCanonicalJson, runtime_dist_manifest_sha256: DIST,
      deadline_at: input.grant.deadlineAt, planning_allocation: 1536, implementation_allocation: 3072,
      review_proof_allocation: 1536, research_fetch_allocation: 24, research_bytes_allocation: "16777216",
      revision: 1, control_seq: 0, amendment_seq: 0,
    });

    // Each admission artifact's digest is the digest the anchor already holds for the same fact.
    const documents = await rows(sql`
      SELECT key, author, metadata->>'kind' AS kind, metadata->>'outputDigest' AS digest,
             metadata->'fence'->>'kind' AS fence, metadata->>'stageId' AS stage
        FROM project.task_documents WHERE project_id = ${PROJECT} AND task_id = ${custody.planningTaskId} ORDER BY key
    `);
    expect(documents).toEqual([
      { key: "cccplan-r001-admission-grant-v01", author: "ccc-planning:controller", kind: "admission_grant",
        digest: grantDigest, fence: "admission", stage: "admission" },
      { key: "cccplan-r001-admission-receipt-v01", author: "ccc-planning:controller", kind: "authority_receipt",
        digest: input.receiptSha256, fence: "admission", stage: "admission" },
      { key: "cccplan-r001-admission-request-v01", author: "ccc-planning:controller", kind: "original_request",
        digest: input.request.sha256, fence: "admission", stage: "admission" },
    ]);

    const audit = await rows(sql`
      SELECT mutation_type, target, agent_id, domain, task_id, metadata->>'to' AS "to"
        FROM project.run_audit_events WHERE project_id = ${PROJECT} AND run_id = ${runId} ORDER BY mutation_type, target
    `);
    const createdAt = (await rows<{ created_at: string }>(sql`
      SELECT created_at FROM project.ccc_planning_runs WHERE project_id = ${PROJECT} AND run_id = ${runId}
    `))[0]!.created_at;
    const common = { agent_id: "ccc-planning-controller", domain: "database", task_id: custody.planningTaskId };
    expect(audit).toEqual([
      { mutation_type: "ccc-planning:artifact-published", target: "cccplan-r001-admission-grant-v01", to: null, ...common },
      { mutation_type: "ccc-planning:artifact-published", target: "cccplan-r001-admission-receipt-v01", to: null, ...common },
      { mutation_type: "ccc-planning:artifact-published", target: "cccplan-r001-admission-request-v01", to: null, ...common },
      { mutation_type: "ccc-planning:state", target: `->admitted@${createdAt}`, to: "admitted", ...common },
    ]);

    await expectRefusal(admitCccPlanningRun(layer, input), "CCC_PLANNING_AUTHORITY_RECEIPT_CONSUMED");
    expect(await runRows(runId)).toEqual(ONE_ADMISSION);
    const [planningTasks] = await rows<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM project.tasks WHERE project_id = ${PROJECT} AND lineage_id LIKE 'ccc-plan:%'
        AND id NOT IN (SELECT planning_task_id FROM project.ccc_planning_runs WHERE project_id = ${PROJECT})
    `);
    expect(planningTasks!.n, "a refused replay leaves no second planning task behind").toBe(0);
  });

  it.each(STEPS)("afterStep %s: the hook runs while that step's inserts are in flight, and its failure rolls back every row of the run", async (failAt) => {
    const input = admission();
    const runId = runIdOf(input);
    const seen: Step[] = [];
    let locked: string[] | undefined;
    const outcome = await admitCccPlanningRun(layer, input, failingAt(failAt, seen, (tables) => { locked = tables; }))
      .then(() => "resolved", (error: unknown) => (error instanceof Error ? error.message : String(error)));

    expect(outcome).toBe(`injected failure after the ${failAt} step`);
    const reached = STEPS.indexOf(failAt);
    expect(seen).toEqual(STEPS.slice(0, reached + 1));
    for (const step of STEPS.slice(0, reached + 1)) {
      for (const table of STEP_TABLES[step]) expect(locked, `${table} written by the ${step} step`).toContain(table);
    }
    for (const step of STEPS.slice(reached + 1)) {
      for (const table of STEP_TABLES[step]) expect(locked, `${table} not yet written at ${failAt}`).not.toContain(table);
    }
    expect(await runRows(runId)).toEqual(NO_ROWS);
  });

  it("a receipt whose admission failed at every step admits once afterwards, so a failed admission consumes nothing", async () => {
    const input = admission();
    const runId = runIdOf(input);
    for (const failAt of STEPS) {
      await expect(admitCccPlanningRun(layer, input, failingAt(failAt, []))).rejects.toThrow(`injected failure after the ${failAt} step`);
      expect(await runRows(runId)).toEqual(NO_ROWS);
    }
    const custody = await admitCccPlanningRun(layer, input);
    expect(custody.runId).toBe(runId);
    expect(await runRows(runId)).toEqual(ONE_ADMISSION);
  });

  it("the planning task is held (triage, paused, not user-paused, lineage = run id, anchored) and the G1 guard refuses moving it; an ordinary task in the same store moves", async () => {
    const custody = await admitCccPlanningRun(layer, admission());
    const readRow = async () => (await rows(sql`
      SELECT "column", status, paused, user_paused, paused_reason, lineage_id
        FROM project.tasks WHERE project_id = ${PROJECT} AND id = ${custody.planningTaskId}
    `))[0];
    const before = await readRow();
    expect(before).toEqual({
      column: "triage", status: "ccc-planning-held", paused: 1, user_paused: 0, paused_reason: "ccc-planning-held",
      lineage_id: custody.runId,
    });
    const task = await harness.store.getTask(custody.planningTaskId);
    expect(task.paused).toBe(true);
    // The store maps user_paused = 0 to an absent field, which the marker counts as false (E1-14); the row says 0 above.
    expect(task.userPaused ?? false).toBe(false);
    expect(isCccPlanningCustodyTask(task)).toBe(true);
    expect(await hasCccPlanningAnchorForTask(layer, custody.planningTaskId, PROJECT)).toBe(true);

    const refused = await harness.store.moveTask(custody.planningTaskId, "todo").then(() => null, (error: unknown) => error);
    expect(refused).toBeInstanceOf(CccPlanningTaskCustodyError);
    expect(refused).toMatchObject({ code: "CCC_PLANNING_TASK_CUSTODY", taskId: custody.planningTaskId, operation: "move" });
    expect(await readRow()).toEqual(before);

    const ordinary = "FN-AD1-ORDINARY";
    await harness.store.createTaskWithReservedId(
      { description: "an ordinary task beside the planning task", column: "triage" },
      { taskId: ordinary, createdAt: FIXTURE_NOW, updatedAt: FIXTURE_NOW, applyDefaultWorkflowSteps: false },
    );
    await harness.store.moveTask(ordinary, "todo");
    expect((await harness.store.getTask(ordinary)).column).toBe("todo");
  });

  it.each(["build", "spec"] as const)("%s mode: the work item carries the run id and the hash of the K1 IR, and the stored workflow IR deep-equals the K1 IR", async (mode) => {
    const custody = await admitCccPlanningRun(layer, admission({ mode }));
    const ir = buildCccPlanningWorkflowIr(mode);

    const items = await rows(sql`
      SELECT run_id, task_id, kind, state, attempt, ir_hash, stable_workflow_run_id, node_id
        FROM project.workflow_work_items WHERE project_id = ${PROJECT} AND task_id = ${custody.planningTaskId}
    `);
    expect(items).toEqual([{
      run_id: custody.runId, task_id: custody.planningTaskId, kind: "task", state: "runnable", attempt: 0,
      ir_hash: cccPlanningWorkflowIrHash(ir), stable_workflow_run_id: custody.runId, node_id: "preflight",
    }]);

    const selections = await rows<{ workflow_id: string }>(sql`
      SELECT workflow_id FROM project.task_workflow_selection WHERE project_id = ${PROJECT} AND task_id = ${custody.planningTaskId}
    `);
    expect(selections).toEqual([{ workflow_id: workflowIdOf(custody.runId) }]);
    const [workflow] = await rows<{ ir: WorkflowIr; kind: string }>(sql`
      SELECT ir, kind FROM project.workflows WHERE project_id = ${PROJECT} AND id = ${selections[0]!.workflow_id}
    `);
    expect(workflow!.kind).toBe("workflow");
    expect(workflow!.ir).toEqual(ir);
    // H1 hashes the stored IR and compares it with the work item; the other mode's IR would not match.
    expect(cccPlanningWorkflowIrHash(workflow!.ir)).toBe(items[0]!.ir_hash);
    expect(cccPlanningWorkflowIrHash(buildCccPlanningWorkflowIr(mode === "build" ? "spec" : "build"))).not.toBe(items[0]!.ir_hash);
  });

  it("the run id is cccPlanningRunId over the receipt's project, request digest and receipt sha256, the K2 envelope binding", async () => {
    const input = admission();
    const custody = await admitCccPlanningRun(layer, input);
    expect(custody.runId).toBe(cccPlanningRunId({
      projectId: input.receipt.project.projectId, requestDigest: input.receipt.request.sha256, receiptSha256: input.receiptSha256,
    }));
    const anchors = await rows<{ run_id: string }>(sql`
      SELECT run_id FROM project.ccc_planning_runs WHERE project_id = ${PROJECT} AND authority_receipt_sha256 = ${input.receiptSha256}
    `);
    expect(anchors).toEqual([{ run_id: custody.runId }]);
  });

  it("the v1 order, the anchor before its task, fails the composite task foreign key at the anchor insert; the task first is admitted", async () => {
    const runId = `ccc-plan:${sha("r2c-ad1-v1-order").slice(0, 24)}`;
    const taskId = "FN-AD1-V1-ORDER";
    const anchor: CccPlanningRunInsert = {
      projectId: PROJECT, runId, planningTaskId: taskId, mode: "build", budgetProfile: "standard", roleProfile: "full-v2",
      policyVersion: CCC_PLANNING_BUDGET_POLICY_V1.policyVersion, policyDigest: sha("policy"), requestDigest: sha("request"),
      requestBytes: 64, targetRepository: REPOSITORY, admittedBase: BASE, grantDigest: sha("grant"),
      authorityReceiptSha256: sha("receipt-v1-order"), authorityReceiptJson: "{}", runtimeDistManifestSha256: DIST,
      state: "admitted", deadlineAt: DEADLINES.build, planningAllocation: 1536, implementationAllocation: 3072,
      reviewProofAllocation: 1536, researchFetchAllocation: 24, researchBytesAllocation: 16_777_216,
      createdAt: FIXTURE_NOW, updatedAt: FIXTURE_NOW,
    };
    const insertTask = (tx: Parameters<Parameters<PostgresJsDatabase["transaction"]>[0]>[0]) => tx.execute(sql`
      INSERT INTO project.tasks (project_id, id, description, "column", created_at, updated_at)
      VALUES (${PROJECT}, ${taskId}, 'v1-order fixture', 'triage', ${FIXTURE_NOW}, ${FIXTURE_NOW})
    `);

    await expect(db.transaction(async (tx) => {
      await tx.insert(cccPlanningRuns).values(anchor);
      await insertTask(tx);
    })).rejects.toMatchObject({
      cause: expect.objectContaining({ code: "23503", constraint_name: "ccc_planning_runs_task_fkey" }),
    });

    const rollback = new Error("roll back the task-first control");
    await expect(db.transaction(async (tx) => {
      await insertTask(tx);
      await tx.insert(cccPlanningRuns).values(anchor);
      throw rollback;
    })).rejects.toBe(rollback);
    expect(await runRows(runId)).toEqual(NO_ROWS);
  });

  it("refuses CCC_PLANNING_INTERNAL_ERROR naming the field when the input's parts disagree, before any write; the agreeing input is admitted", async () => {
    const base = admission();
    const otherReceipt = admission({ receiptProjectId: OTHER_PROJECT });
    const bytes = new TextEncoder().encode("a different request");
    const cases: ReadonlyArray<readonly [string, CccPlanningAdmissionInput]> = [
      ["projectId", { ...otherReceipt, projectId: OTHER_PROJECT }],
      ["receipt.project.projectId", otherReceipt],
      ["request.sha256", { ...base, request: { bytes: base.request.bytes, sha256: sha("a different request") } }],
      ["request.sha256", { ...base, request: { bytes, sha256: sha("a different request") } }],
      ["receiptSha256", { ...base, receiptSha256: sha("another receipt") }],
      ["receiptCanonicalJson", { ...base, receiptCanonicalJson: `${base.receiptCanonicalJson}\n` }],
      ["mode", { ...base, mode: "spec" }],
      ["budgetProfile", { ...base, budgetProfile: "large" }],
      ["grant.mode", { ...base, grant: { ...base.grant, mode: "spec" } }],
      ["grant.budgetProfile", { ...base, grant: { ...base.grant, budgetProfile: "large" } }],
      ["grant.amendmentSeq", { ...base, grant: { ...base.grant, amendmentSeq: 1 } }],
      ["targetRepository", { ...base, targetRepository: `${SCRATCH}/elsewhere` }],
      ["admittedBase", { ...base, admittedBase: "9".repeat(40) }],
      ["runtimeDistManifestSha256", { ...base, runtimeDistManifestSha256: "0".repeat(64) }],
      ["plannedLeaves", { ...base, plannedLeaves: 1 as unknown as 0 }],
    ];
    for (const [field, input] of cases) {
      await expectRefusal(admitCccPlanningRun(layer, input), "CCC_PLANNING_INTERNAL_ERROR", field);
      expect(await runRows(runIdOf(input)), `nothing written for ${field}`).toEqual(NO_ROWS);
    }
    const custody = await admitCccPlanningRun(layer, base);
    expect(await runRows(custody.runId)).toEqual(ONE_ADMISSION);
  });

  it("two concurrent admissions of one receipt commit one run, and the other refuses RECEIPT_CONSUMED through the unique key", async () => {
    const input = admission();
    const results = await Promise.allSettled([admitCccPlanningRun(layer, input), admitCccPlanningRun(layer, input)]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(CccPlanningRefusal);
    expect((rejected[0]!.reason as CccPlanningRefusal).code).toBe("CCC_PLANNING_AUTHORITY_RECEIPT_CONSUMED");
    expect(await runRows(runIdOf(input))).toEqual(ONE_ADMISSION);
  });
});
