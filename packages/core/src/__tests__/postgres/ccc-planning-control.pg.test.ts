/**
 * FNXC:CccPlanningControl 2026-10-14-13:51 (card L1):
 * Operator control, decision answers, Build control after the import link and cancellation completion against a real
 * PostgreSQL (D32, D45, D52; errata E2-3/E3-1 build cancel from any linked state, E2-4/E3-3 actor length).
 *
 * The requeue cases read the planning work item back from PostgreSQL: a state-only implementation leaves it `held`.
 * Every refusal is paired with a control that differs in one field and is accepted on the same kind of fixture.
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
import type { AsyncDataLayer } from "../../postgres/data-layer.js";
import { cccPlanningRuns, type CccPlanningRunInsert } from "../../postgres/schema/ccc-planning.js";
import {
  cccPlanningBindingHash,
  cccPlanningDecisionId,
  cccPlanningRole,
  cccPlanningTurnKey,
} from "../../ccc-planning/policy.js";
import type {
  CccPlanningCallRequest,
  CccPlanningRoleId,
  CccPlanningRouteBinding,
  CccPlanningStageId,
  CccPlanningWorkItemFence,
} from "../../ccc-planning/types.js";
import {
  admitCccPlanningDispatch,
  answerCccPlanningDecision,
  completeCccPlanningCancellation,
  getCccPlanningRunForTask,
  recordCccPlanningBuildControl,
  requestCccPlanningControl,
  resolveCccPlanningRunProject,
  transitionCccPlanningRunState,
} from "../../task-store/ccc-planning-ops.js";

const PROJECT = "r2c-l1-control";
const OTHER_PROJECT = "r2c-l1-control-other";
const NOW = "2026-10-14T12:00:00.000Z";
const PAST = "2020-01-01T00:00:00.000Z";
const FAR = "2999-01-01T00:00:00.000Z";
const LEASE_OWNER = "h1-worker";

const STATE_CODES: Readonly<Record<string, string>> = {
  awaiting_intent: "CCC_PLANNING_AWAITING_INTENT",
  awaiting_budget: "CCC_PLANNING_AWAITING_BUDGET",
  blocked_prerequisite: "CCC_PLANNING_RUNTIME_NOT_PERMITTED",
  blocked_provider: "CCC_PROVIDER_PIN_DRIFT",
  budget_exhausted: "CCC_PLANNING_BUILD_FIT_INSUFFICIENT",
  unknown_effect: "CCC_PLANNING_UNRECONCILED_DISPATCH",
  verification_failed: "CCC_PLANNING_REVIEW_REJECTED",
  failed: "CCC_PLANNING_CAMPAIGN_FAILED",
};

function sha(label: string): string {
  return createHash("sha256").update(label, "utf8").digest("hex");
}

type Run = Readonly<{ runId: string; taskId: string; workItemId: string; fence: CccPlanningWorkItemFence; projectId: string }>;
type LinkedRun = Run & Readonly<{ importId: string; campaignFence: CccPlanningWorkItemFence }>;
type Row = Record<string, unknown>;

pgDescribe("ccc planning control (card L1, PostgreSQL)", () => {
  let harness: PgTestHarness;
  let db: PostgresJsDatabase;
  let layer: AsyncDataLayer;

  beforeAll(async () => {
    harness = await createTaskStoreForTest({ prefix: "fusion_ccc_planning_l1_control", copyFromGolden: true });
    db = harness.adminDb;
    layer = harness.layer;
  });

  afterAll(async () => {
    await harness?.teardown();
  });

  let ordinal = 0;
  function next(): number {
    ordinal += 1;
    return ordinal;
  }

  async function insertTask(projectId: string, id: string): Promise<void> {
    await db.execute(sql`
      INSERT INTO project.tasks (project_id, id, description, "column", created_at, updated_at)
      VALUES (${projectId}, ${id}, ${`request-to-code fixture ${id}`}, 'todo', ${NOW}, ${NOW})
    `);
  }

  async function insertWorkItem(i: { projectId: string; id: string; runId: string; taskId: string; nodeId: string; kind: string }):
    Promise<void> {
    await db.execute(sql`
      INSERT INTO project.workflow_work_items
        (project_id, id, run_id, task_id, node_id, kind, state, attempt, lease_owner, lease_expires_at, created_at, updated_at)
      VALUES (${i.projectId}, ${i.id}, ${i.runId}, ${i.taskId}, ${i.nodeId}, ${i.kind}, 'running', 1, ${LEASE_OWNER}, ${FAR},
              ${NOW}, ${NOW})
    `);
  }

  function move(run: Pick<Run, "runId" | "projectId">, to: string): Promise<unknown> {
    return db.execute(sql`
      UPDATE project.ccc_planning_runs SET state = ${to}, state_code = ${STATE_CODES[to] ?? null}, updated_at = ${NOW}
       WHERE project_id = ${run.projectId} AND run_id = ${run.runId}
    `);
  }

  async function walk(run: Run, states: readonly string[]): Promise<void> {
    for (const state of states) await move(run, state);
  }

  /** The work item as H1 leaves it when it parks a run: held, unleased. */
  function holdWorkItem(run: Run): Promise<unknown> {
    return db.execute(sql`
      UPDATE project.workflow_work_items SET state = 'held', lease_owner = NULL, lease_expires_at = NULL
       WHERE project_id = ${run.projectId} AND id = ${run.workItemId}
    `);
  }

  async function seedRun(options: { projectId?: string; runId?: string; overrides?: Partial<CccPlanningRunInsert>;
    state?: "admitted" | "running" } = {}): Promise<Run> {
    const n = next();
    const projectId = options.projectId ?? PROJECT;
    const taskId = `R2C-L1-CONTROL-${n}`;
    const runId = options.runId ?? `ccc-plan:${sha(`r2c-l1-control-run-${n}`).slice(0, 24)}`;
    const workItemId = `wi-${taskId}`;
    await insertTask(projectId, taskId);
    await db.insert(cccPlanningRuns).values({
      projectId, runId, planningTaskId: taskId, mode: "build", budgetProfile: "standard", roleProfile: "full-v2",
      policyVersion: "ccc-planning.budget-policy.v1", policyDigest: sha("policy"), requestDigest: sha(`request:${runId}`),
      requestBytes: 512, targetRepository: "/private/tmp/r2c-l1-target", admittedBase: "b".repeat(40),
      grantDigest: sha(`grant:${runId}`), authorityReceiptSha256: sha(`receipt:${runId}`),
      authorityReceiptJson: JSON.stringify({ runId }), runtimeDistManifestSha256: sha("dist"), state: "admitted",
      deadlineAt: FAR, planningAllocation: 1536, implementationAllocation: 20, reviewProofAllocation: 10,
      researchFetchAllocation: 5, researchBytesAllocation: 1_048_576, createdAt: NOW, updatedAt: NOW,
      ...options.overrides,
    });
    await insertWorkItem({ projectId, id: workItemId, runId, taskId, nodeId: "ccc-planning", kind: "task" });
    const run: Run = {
      runId, taskId, workItemId, projectId,
      fence: { kind: "planning", workItemId, runId, attempt: 1, leaseOwner: LEASE_OWNER, originTaskId: taskId },
    };
    if ((options.state ?? "running") === "running") await move(run, "running");
    return run;
  }

  async function recordIntent(run: Run): Promise<void> {
    await db.execute(sql`
      UPDATE project.ccc_planning_runs
         SET import_intent_digest = ${sha(`intent:${run.runId}`)}, import_idempotency_key = ${`${run.runId}:r1`},
             updated_at = ${NOW}
       WHERE project_id = ${run.projectId} AND run_id = ${run.runId}
    `);
  }

  /** A Build run linked to a seeded import, left in `importing` (link only) or moved on along `path`. */
  async function seedLinkedRun(path: readonly string[] = ["building"]): Promise<LinkedRun> {
    const run = await seedRun();
    const importId = `r2c-l1-import-${run.taskId}`;
    const digest = sha(`import:${importId}`);
    await walk(run, ["spec_ready", "importing"]);
    await db.execute(sql`
      INSERT INTO project.ccc_prd_imports (
        project_id, idempotency_key, import_id, identity_hash, bundle_hash, packet_hash, sidecar_hash,
        source_version, target_repository, target_base, root_dir, staging_relative_path, state,
        canonical_bundle, transaction_witness, projection_digest, created_at, updated_at,
        execution_policy, campaign_manifest, campaign_manifest_hash, campaign_started_at, campaign_deadline_at
      ) VALUES (
        ${PROJECT}, ${`${run.runId}:r1`}, ${importId}, ${digest}, ${digest}, ${digest}, ${digest},
        'v1', '/private/tmp/r2c-l1-target', ${"b".repeat(40)}, '/private/tmp/r2c-l1-root', 'stage', 'prepared',
        '{}'::jsonb, '{}'::jsonb, ${digest}, ${NOW}, ${NOW},
        '{}'::jsonb, '{}'::jsonb, ${digest}, ${NOW}, ${FAR}
      )
    `);
    await recordIntent(run);
    await db.execute(sql`
      UPDATE project.ccc_planning_runs SET import_id = ${importId}, implementation_transferred = 5, updated_at = ${NOW}
       WHERE project_id = ${PROJECT} AND run_id = ${run.runId}
    `);
    await db.execute(sql`
      UPDATE project.workflow_work_items SET state = 'succeeded', lease_owner = NULL, lease_expires_at = NULL
       WHERE project_id = ${PROJECT} AND id = ${run.workItemId}
    `);
    await walk(run, path);
    const campaignTask = `CAMP-${run.taskId}`;
    await insertTask(PROJECT, campaignTask);
    const campaignItem = `cwi-${run.taskId}`;
    await insertWorkItem({ projectId: PROJECT, id: campaignItem, runId: `ccc-prd:${importId}`, taskId: campaignTask,
      nodeId: "g7", kind: "step" });
    return {
      ...run, importId,
      campaignFence: { kind: "campaign", workItemId: campaignItem, runId: `ccc-prd:${importId}`, attempt: 1,
        leaseOwner: LEASE_OWNER, originTaskId: campaignTask },
    };
  }

  function request(run: Run, lineage: Readonly<{ stageId: CccPlanningStageId; roleId: CccPlanningRoleId; lineageId: string }>,
    call: number, fence: CccPlanningWorkItemFence): CccPlanningCallRequest {
    const role = cccPlanningRole(lineage.roleId);
    const base: Omit<CccPlanningRouteBinding, "bindingHash"> = {
      kind: "ccc-planning-route.v1", projectId: run.projectId, runId: run.runId, runRevision: 1, taskId: run.taskId,
      stageId: lineage.stageId, roleId: lineage.roleId, roleClass: role.roleClass, lineageId: lineage.lineageId,
      nodeAttemptOrdinal: 1, phase: role.phase === "review_proof" ? "review_proof" : "planning",
      providerId: `ccc-${role.family}`, modelId: role.modelId, transport: "pi",
      receiptAdapterId: "terminal-route-sse-comments.v1", toolsetDigest: sha("tools"), promptDigest: sha("prompt"),
      policyDigest: sha("policy"), grantDigest: sha(`grant:${run.runId}`),
    };
    return {
      binding: { ...base, bindingHash: cccPlanningBindingHash(base) },
      turnKey: cccPlanningTurnKey({ projectId: run.projectId, runId: run.runId, revision: 1, stageId: lineage.stageId,
        roleId: lineage.roleId, lineageId: lineage.lineageId, nodeAttemptOrdinal: 1 }),
      dispatchKey: `pi-stream:${call}`, fence, preflight: false,
    };
  }

  const SPEC_AUTHOR = { stageId: "spec", roleId: "spec-author", lineageId: "spec:spec-author" } as const;
  const TASK_REVIEWER = { stageId: "g7", roleId: "task-reviewer", lineageId: "review:T-1" } as const;

  /** A controller-published decision_request in stage intent, under the planning work item's lease. */
  async function publishQuestion(run: Run): Promise<{ key: string; digest: string; decisionId: string }> {
    const key = "cccplan-r001-intent-question1-v01";
    const content = JSON.stringify({ schema: "ccc-planning.decision-request.v1", question: "Which flag name?",
      options: ["--version", "-v"], context: [] });
    const digest = sha(content);
    const metadata = {
      schema: "ccc-planning.artifact-envelope.v1", artifactKey: key, runId: run.runId, runRevision: 1, stageId: "intent",
      slot: "question1", version: 1, kind: "decision_request", contentType: "application/json",
      contentSchema: "ccc-planning.decision-request.v1", inputs: [],
      producer: { kind: "controller", roleId: "controller", instanceId: "controller:1" },
      policy: { promptVersion: "none", promptDigest: "none", toolPolicyVersion: "none", toolPolicyDigest: "none" },
      outputDigest: digest, status: "complete",
      fence: { kind: "work_item_lease", workItemId: run.workItemId, leaseOwner: LEASE_OWNER, attempt: 1, runId: run.runId },
      identityDigest: sha(`identity:${key}`), publishedAt: NOW,
    };
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('fusion.ccc_planning_publication', 'on', true)`);
      await tx.execute(sql`
        INSERT INTO project.task_documents
          (project_id, id, task_id, key, content, revision, author, metadata, created_at, updated_at)
        VALUES (${run.projectId}, ${`doc-${run.taskId}-${key}`}, ${run.taskId}, ${key}, ${content}, 1,
                'ccc-planning:controller', ${JSON.stringify(metadata)}::jsonb, ${NOW}, ${NOW})
      `);
    });
    return { key, digest, decisionId: cccPlanningDecisionId({ revision: 1, questionDigest: digest }) };
  }

  /** running -> awaiting_intent exactly as H1 leaves it: decision id set, work item held. */
  async function seedAwaitingIntent(): Promise<Run & { decisionId: string; questionKey: string }> {
    const run = await seedRun();
    const question = await publishQuestion(run);
    await db.execute(sql`
      UPDATE project.ccc_planning_runs
         SET state = 'awaiting_intent', state_code = 'CCC_PLANNING_AWAITING_INTENT',
             awaiting_decision_id = ${question.decisionId}, updated_at = ${NOW}
       WHERE project_id = ${PROJECT} AND run_id = ${run.runId}
    `);
    await holdWorkItem(run);
    return { ...run, decisionId: question.decisionId, questionKey: question.key };
  }

  async function anchor(run: Pick<Run, "runId" | "projectId">): Promise<Row> {
    const rows = (await db.execute(sql`
      SELECT state, state_code, control_seq, control_request, control_revision, awaiting_decision_id, review_proof_spent
        FROM project.ccc_planning_runs WHERE project_id = ${run.projectId} AND run_id = ${run.runId}
    `)) as unknown as Row[];
    expect(rows).toHaveLength(1);
    return rows[0]!;
  }

  async function workItem(run: Run): Promise<Row> {
    const rows = (await db.execute(sql`
      SELECT state, attempt, lease_owner, lease_expires_at FROM project.workflow_work_items
       WHERE project_id = ${run.projectId} AND id = ${run.workItemId}
    `)) as unknown as Row[];
    expect(rows).toHaveLength(1);
    return rows[0]!;
  }

  async function events(runId: string, mutationType: string): Promise<Row[]> {
    return (await db.execute(sql`
      SELECT agent_id, target, metadata FROM project.run_audit_events
       WHERE run_id = ${runId} AND mutation_type = ${mutationType} ORDER BY timestamp, id
    `)) as unknown as Row[];
  }

  async function expectRefusal(promise: Promise<unknown>, code: string): Promise<void> {
    await expect(promise).rejects.toMatchObject({ name: "CccPlanningRefusal", code });
  }

  it("pause while running sets control_request and the next dispatch is refused control-pending; an unpaused run admits", async () => {
    const run = await seedRun();
    const control = await seedRun();
    await expect(admitCccPlanningDispatch(layer, request(control, SPEC_AUTHOR, 1, control.fence)))
      .resolves.toMatchObject({ kind: "dispatch-permit" });

    expect(await requestCccPlanningControl(layer, { runId: run.runId, request: "pause", actor: "ryan" }))
      .toEqual({ controlSeq: 1, appliedDirectly: false });
    expect(await anchor(run)).toMatchObject({ state: "running", control_request: "pause", control_seq: 1, control_revision: 1 });
    await expect(admitCccPlanningDispatch(layer, request(run, SPEC_AUTHOR, 1, run.fence)))
      .rejects.toMatchObject({ name: "CccProviderAttemptLimitError", reason: "control-pending" });
    const controls = await events(run.runId, "ccc-planning:control");
    expect(controls).toHaveLength(1);
    expect(controls[0]).toMatchObject({
      agent_id: "operator:ryan",
      metadata: expect.objectContaining({ request: "pause", controlSeq: 1, actor: "ryan", route: "planning", outcome: "pending" }),
    });
  });

  it("answering the awaited decision moves the run to running and the held work item to runnable in one transaction", async () => {
    const run = await seedAwaitingIntent();
    await expectRefusal(answerCccPlanningDecision(layer, {
      runId: run.runId, decisionId: cccPlanningDecisionId({ revision: 1, questionDigest: sha("another question") }),
      answer: "--version", actor: "ryan",
    }), "CCC_PLANNING_DECISION_NOT_AWAITED");
    expect(await anchor(run)).toMatchObject({ state: "awaiting_intent", control_seq: 0 });
    expect(await workItem(run)).toMatchObject({ state: "held" });

    const answered = await answerCccPlanningDecision(layer, {
      runId: run.runId, decisionId: run.decisionId, answer: "--version", actor: "ryan",
    });
    expect(answered).toEqual({ controlSeq: 1, answerArtifactKey: "cccplan-r001-operator-answer1-v01" });
    expect(await anchor(run)).toMatchObject({ state: "running", state_code: null, control_seq: 1, awaiting_decision_id: null });
    expect(await workItem(run)).toMatchObject({ state: "runnable", attempt: 2, lease_owner: null, lease_expires_at: null });

    const docs = (await db.execute(sql`
      SELECT content, author, metadata FROM project.task_documents
       WHERE project_id = ${PROJECT} AND task_id = ${run.taskId} AND key = ${answered.answerArtifactKey}
    `)) as unknown as Row[];
    expect(docs).toHaveLength(1);
    expect(JSON.parse(docs[0]!.content as string)).toMatchObject({ decisionId: run.decisionId, actor: "ryan", answer: "--version" });
    expect(docs[0]!.metadata).toMatchObject({
      kind: "operator_answer", stageId: "operator", fence: { kind: "operator", runRevision: 1, controlSeq: 1 },
      producer: { kind: "operator", roleId: "operator", instanceId: "operator:1" },
      inputs: [expect.objectContaining({ artifactKey: run.questionKey })],
    });
    expect((await events(run.runId, "ccc-planning:decision:answered")).map((row) => row.agent_id)).toEqual(["operator:ryan"]);
    expect((await events(run.runId, "ccc-planning:artifact-published")).map((row) => row.target))
      .toEqual([answered.answerArtifactKey]);
  });

  it("resume from paused moves the run to running and the held work item to runnable; resume of a running run is refused", async () => {
    const running = await seedRun();
    await expectRefusal(requestCccPlanningControl(layer, { runId: running.runId, request: "resume", actor: "ryan" }),
      "CCC_PLANNING_STATE_TRANSITION_REFUSED");
    expect(await anchor(running)).toMatchObject({ control_seq: 0 });

    const run = await seedRun();
    await move(run, "paused");
    await holdWorkItem(run);
    expect(await requestCccPlanningControl(layer, { runId: run.runId, request: "resume", actor: "ryan" }))
      .toEqual({ controlSeq: 1, appliedDirectly: true });
    expect(await anchor(run)).toMatchObject({ state: "running", control_seq: 1, control_request: null });
    expect(await workItem(run)).toMatchObject({ state: "runnable", attempt: 2 });
    expect((await events(run.runId, "ccc-planning:state")).map((row) => row.metadata))
      .toEqual([expect.objectContaining({ from: "paused", to: "running" })]);
  });

  it("cancel from awaiting_intent with no live holder ends cancelled with the work item cancelled", async () => {
    const run = await seedAwaitingIntent();
    expect(await requestCccPlanningControl(layer, { runId: run.runId, request: "cancel", actor: "ryan" }))
      .toEqual({ controlSeq: 1, appliedDirectly: true });
    expect(await anchor(run)).toMatchObject({ state: "cancelled", state_code: "CCC_PLANNING_CANCELLED", awaiting_decision_id: null });
    expect(await workItem(run)).toMatchObject({ state: "cancelled" });
    expect((await events(run.runId, "ccc-planning:state")).map((row) => (row.metadata as Row).to))
      .toEqual(["cancelling", "cancelled"]);
  });

  it("cancel with a live lease holder stops at cancelling; completion runs once the lease has expired", async () => {
    const run = await seedRun();
    await move(run, "blocked_provider");
    expect(await requestCccPlanningControl(layer, { runId: run.runId, request: "cancel", actor: "ryan" }))
      .toEqual({ controlSeq: 1, appliedDirectly: true });
    expect(await anchor(run)).toMatchObject({ state: "cancelling" });
    expect(await workItem(run)).toMatchObject({ state: "running" });
    expect((await events(run.runId, "ccc-planning:control"))[0]!.metadata).toMatchObject({ outcome: "deferred-leased" });
    expect(await completeCccPlanningCancellation(layer, { runId: run.runId })).toEqual({ completed: false });

    await db.execute(sql`
      UPDATE project.workflow_work_items SET lease_expires_at = ${PAST}
       WHERE project_id = ${PROJECT} AND id = ${run.workItemId}
    `);
    expect(await completeCccPlanningCancellation(layer, { runId: run.runId })).toEqual({ completed: true });
    expect(await anchor(run)).toMatchObject({ state: "cancelled" });
    expect(await workItem(run)).toMatchObject({ state: "cancelled", lease_owner: null });
    expect(await completeCccPlanningCancellation(layer, { runId: run.runId })).toEqual({ completed: true });
  });

  it("refuses planning control on a linked run with CONTROL_REQUIRES_CAMPAIGN_BRIDGE; an unlinked run accepts the same pause", async () => {
    const linked = await seedLinkedRun();
    await expectRefusal(requestCccPlanningControl(layer, { runId: linked.runId, request: "pause", actor: "ryan" }),
      "CCC_PLANNING_CONTROL_REQUIRES_CAMPAIGN_BRIDGE");
    expect(await anchor(linked)).toMatchObject({ control_seq: 0, control_request: null });
    const unlinked = await seedRun();
    expect(await requestCccPlanningControl(layer, { runId: unlinked.runId, request: "pause", actor: "ryan" }))
      .toMatchObject({ controlSeq: 1 });
  });

  it("in importing refuses pause with COMMAND_NOT_SUPPORTED and accepts cancel only before the intent is recorded", async () => {
    const run = await seedRun();
    await walk(run, ["spec_ready", "importing"]);
    await expectRefusal(requestCccPlanningControl(layer, { runId: run.runId, request: "pause", actor: "ryan" }),
      "CCC_PLANNING_COMMAND_NOT_SUPPORTED");
    expect(await anchor(run)).toMatchObject({ state: "importing", control_seq: 0 });
    expect(await requestCccPlanningControl(layer, { runId: run.runId, request: "cancel", actor: "ryan" }))
      .toMatchObject({ controlSeq: 1 });
    expect(await anchor(run)).toMatchObject({ state: "cancelling" });

    const recorded = await seedRun();
    await walk(recorded, ["spec_ready", "importing"]);
    await recordIntent(recorded);
    await expectRefusal(requestCccPlanningControl(layer, { runId: recorded.runId, request: "cancel", actor: "ryan" }),
      "CCC_PLANNING_STATE_TRANSITION_REFUSED");
    expect(await anchor(recorded)).toMatchObject({ state: "importing", control_seq: 0 });
  });

  it("build control in building refuses pause and resume without a write; cancel sets control_request and stops review spend", async () => {
    const run = await seedLinkedRun();
    for (const command of ["pause", "resume"] as const) {
      await expectRefusal(recordCccPlanningBuildControl(layer, { runId: run.runId, request: command, actor: "ryan" }),
        "CCC_PLANNING_COMMAND_NOT_SUPPORTED");
    }
    expect(await anchor(run)).toMatchObject({ control_seq: 0, control_request: null });
    expect(await events(run.runId, "ccc-planning:control")).toHaveLength(0);
    await expect(admitCccPlanningDispatch(layer, request(run, TASK_REVIEWER, 1, run.campaignFence)))
      .resolves.toMatchObject({ kind: "dispatch-permit" });

    expect(await recordCccPlanningBuildControl(layer, { runId: run.runId, request: "cancel", actor: "ryan" }))
      .toEqual({ controlSeq: 1 });
    expect(await anchor(run)).toMatchObject({ state: "building", control_seq: 1, control_request: "cancel", review_proof_spent: 1 });
    expect((await events(run.runId, "ccc-planning:control"))[0]).toMatchObject({
      agent_id: "operator:ryan", metadata: expect.objectContaining({ route: "campaign-bridge", request: "cancel", actor: "ryan" }),
    });
    const reviewer2 = { ...TASK_REVIEWER, lineageId: "review:T-2" };
    await expect(admitCccPlanningDispatch(layer, request(run, reviewer2, 1, run.campaignFence)))
      .rejects.toMatchObject({ name: "CccProviderAttemptLimitError", reason: "control-pending" });
    expect(await anchor(run)).toMatchObject({ review_proof_spent: 1 });
  });

  it("build cancel works from every linked non-building state with a ->cancelling pair (E2-3, E3-1)", async () => {
    const authority = await seedLinkedRun(["awaiting_execution_authority"]);
    expect(await recordCccPlanningBuildControl(layer, { runId: authority.runId, request: "cancel", actor: "ryan" }))
      .toEqual({ controlSeq: 1 });
    expect(await anchor(authority)).toMatchObject({ state: "awaiting_execution_authority", control_request: "cancel" });

    const blocked = await seedLinkedRun(["building", "blocked_provider"]);
    expect(await recordCccPlanningBuildControl(layer, { runId: blocked.runId, request: "cancel", actor: "ryan" }))
      .toEqual({ controlSeq: 1 });
    expect(await anchor(blocked)).toMatchObject({ state: "blocked_provider", control_request: "cancel" });
  });

  it("refuses build cancel in a linked state without a ->cancelling pair with STATE_TRANSITION_REFUSED and writes nothing", async () => {
    const run = await seedLinkedRun(["building", "accepted", "delivering"]);
    await expectRefusal(recordCccPlanningBuildControl(layer, { runId: run.runId, request: "cancel", actor: "ryan" }),
      "CCC_PLANNING_STATE_TRANSITION_REFUSED");
    expect(await anchor(run)).toMatchObject({ state: "delivering", control_seq: 0, control_request: null });
    expect(await events(run.runId, "ccc-planning:control")).toHaveLength(0);
    const accepted = await seedLinkedRun(["building", "accepted"]);
    expect(await recordCccPlanningBuildControl(layer, { runId: accepted.runId, request: "cancel", actor: "ryan" }))
      .toEqual({ controlSeq: 1 });
  });

  it("refuses build control on a run that was never linked with INTERNAL_ERROR", async () => {
    const run = await seedRun();
    await expectRefusal(recordCccPlanningBuildControl(layer, { runId: run.runId, request: "cancel", actor: "ryan" }),
      "CCC_PLANNING_INTERNAL_ERROR");
    expect(await anchor(run)).toMatchObject({ control_seq: 0, control_request: null });
  });

  it("refuses an actor over 200 characters or blank with INTERNAL_ERROR before any write; 200 characters are stored unchanged", async () => {
    const run = await seedRun();
    const linked = await seedLinkedRun();
    for (const actor of ["a".repeat(201), "   "]) {
      await expectRefusal(requestCccPlanningControl(layer, { runId: run.runId, request: "pause", actor }),
        "CCC_PLANNING_INTERNAL_ERROR");
      await expectRefusal(recordCccPlanningBuildControl(layer, { runId: linked.runId, request: "cancel", actor }),
        "CCC_PLANNING_INTERNAL_ERROR");
    }
    expect(await anchor(run)).toMatchObject({ control_seq: 0, control_request: null });
    expect(await anchor(linked)).toMatchObject({ control_seq: 0, control_request: null });

    const actor = "b".repeat(200);
    await requestCccPlanningControl(layer, { runId: run.runId, request: "pause", actor });
    await recordCccPlanningBuildControl(layer, { runId: linked.runId, request: "cancel", actor });
    expect((await events(run.runId, "ccc-planning:control"))[0]!.agent_id).toBe(`operator:${actor}`);
    expect((await events(linked.runId, "ccc-planning:control"))[0]!.agent_id).toBe(`operator:${actor}`);
  });

  it("resolves the run's project and refuses RUN_NOT_FOUND, RUN_AMBIGUOUS and RUN_PROJECT_MISMATCH", async () => {
    const run = await seedRun();
    expect(await resolveCccPlanningRunProject(layer, { runId: run.runId })).toEqual({ projectId: PROJECT });
    expect(await resolveCccPlanningRunProject(layer, { runId: run.runId, projectId: PROJECT })).toEqual({ projectId: PROJECT });
    await expectRefusal(resolveCccPlanningRunProject(layer, { runId: run.runId, projectId: OTHER_PROJECT }),
      "CCC_PLANNING_RUN_PROJECT_MISMATCH");
    await expectRefusal(resolveCccPlanningRunProject(layer, { runId: `ccc-plan:${sha("missing").slice(0, 24)}` }),
      "CCC_PLANNING_RUN_NOT_FOUND");

    const shared = `ccc-plan:${sha("shared-run").slice(0, 24)}`;
    await seedRun({ runId: shared });
    await seedRun({ runId: shared, projectId: OTHER_PROJECT });
    await expectRefusal(resolveCccPlanningRunProject(layer, { runId: shared }), "CCC_PLANNING_RUN_AMBIGUOUS");
  });

  it("returns the custody of a planning task and null for an ordinary task", async () => {
    const run = await seedRun();
    expect(await getCccPlanningRunForTask(layer, run.taskId)).toMatchObject({
      kind: "planning", projectId: PROJECT, runId: run.runId, planningTaskId: run.taskId, state: "running", controlSeq: 0,
      importId: null, mode: "build",
    });
    await insertTask(PROJECT, "R2C-L1-ORDINARY");
    expect(await getCccPlanningRunForTask(layer, "R2C-L1-ORDINARY")).toBeNull();
  });

  it("transitions by CAS on from, derives the awaited decision id, and clears a pending control on pause", async () => {
    const run = await seedRun();
    await expectRefusal(transitionCccPlanningRunState(layer, {
      runId: run.runId, from: "admitted", to: "running", stateCode: null, fence: run.fence,
    }), "CCC_PLANNING_STATE_TRANSITION_REFUSED");
    const question = await publishQuestion(run);
    const custody = await transitionCccPlanningRunState(layer, {
      runId: run.runId, from: "running", to: "awaiting_intent", stateCode: "CCC_PLANNING_AWAITING_INTENT", fence: run.fence,
    });
    expect(custody).toMatchObject({ state: "awaiting_intent", runId: run.runId });
    expect(await anchor(run)).toMatchObject({ state: "awaiting_intent", awaiting_decision_id: question.decisionId });

    const paused = await seedRun();
    await requestCccPlanningControl(layer, { runId: paused.runId, request: "pause", actor: "ryan" });
    await transitionCccPlanningRunState(layer, {
      runId: paused.runId, from: "running", to: "paused", stateCode: null, fence: paused.fence,
    });
    expect(await anchor(paused)).toMatchObject({ state: "paused", control_request: null, control_seq: 1 });
    expect((await events(paused.runId, "ccc-planning:state")).map((row) => row.agent_id)).toEqual(["ccc-planning-controller"]);
  });
});
