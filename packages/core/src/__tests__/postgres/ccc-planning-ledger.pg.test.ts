/**
 * FNXC:CccPlanningLedger 2026-10-14-13:51 (card L1):
 * The planning call ledger against a real PostgreSQL: the 11-call iteration cap, the 3-attempt dispatch cap with
 * inherited counts (splits, author repairs, review nodes), the preflight cap, unreconciled-dispatch blocking, the
 * phase allocation under a real two-connection race, D10 route-refusal settlement, review/proof spend under a
 * campaign fence, repair chunks, review epochs, research fetch grants and the linked-outcome port of status reads.
 *
 * Every refusal is paired with a control that differs in one field and is admitted on the same fixture. Run state,
 * counters and audit rows are always read back from PostgreSQL, never from the function's return value alone.
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
  CCC_PLANNING_MAX_REPAIR_CHUNKS,
  cccPlanningBindingHash,
  cccPlanningRole,
  cccPlanningTurnKey,
} from "../../ccc-planning/policy.js";
import type {
  CccPlanningCallRequest,
  CccPlanningCallScope,
  CccPlanningRoleId,
  CccPlanningRouteBinding,
  CccPlanningStageId,
  CccPlanningWorkItemFence,
} from "../../ccc-planning/types.js";
import type { CccProviderAttemptSettlementInputOf } from "../../ccc-campaign/types.js";
import {
  admitCccPlanningDispatch,
  assertCccPlanningDescendantsSettled,
  claimCccPlanningRepairChunk,
  closeCccPlanningRepairEpoch,
  inspectCccPlanningRun,
  proveCccPlanningCallNotDispatched,
  recordCccPlanningLineageSplit,
  recordCccPlanningReviewEpoch,
  reserveCccPlanningResearchFetch,
  settleCccPlanningCall,
  settleCccPlanningResearchFetch,
} from "../../task-store/ccc-planning-ops.js";

const PROJECT = "r2c-l1-ledger";
const NOW = "2026-10-14T12:00:00.000Z";
const FAR = "2999-01-01T00:00:00.000Z";
const LEASE_OWNER = "h1-worker";

const STATE_CODES: Readonly<Record<string, string>> = {
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

type Lineage = Readonly<{ stageId: CccPlanningStageId; roleId: CccPlanningRoleId; lineageId: string }>;
type Run = Readonly<{ runId: string; taskId: string; workItemId: string; fence: CccPlanningWorkItemFence }>;
type Row = Record<string, unknown>;

const SPEC_AUTHOR: Lineage = { stageId: "spec", roleId: "spec-author", lineageId: "spec:spec-author" };
const PLANNER: Lineage = { stageId: "plan", roleId: "execution-planner", lineageId: "plan:execution-planner" };
const ADVERSARY: Lineage = { stageId: "review", roleId: "product-adversary", lineageId: "review:product-adversary" };
const RESEARCHER: Lineage = { stageId: "research", roleId: "researcher", lineageId: "research:researcher" };
const PREFLIGHT_WRITER: Lineage = { stageId: "preflight", roleId: "preflight-writer", lineageId: "preflight:writer" };

pgDescribe("ccc planning ledger (card L1, PostgreSQL)", () => {
  let harness: PgTestHarness;
  let db: PostgresJsDatabase;
  let layer: AsyncDataLayer;

  beforeAll(async () => {
    harness = await createTaskStoreForTest({ prefix: "fusion_ccc_planning_l1_ledger", copyFromGolden: true });
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

  async function insertTask(id: string): Promise<void> {
    await db.execute(sql`
      INSERT INTO project.tasks (project_id, id, description, "column", created_at, updated_at)
      VALUES (${PROJECT}, ${id}, ${`request-to-code fixture ${id}`}, 'todo', ${NOW}, ${NOW})
    `);
  }

  async function insertWorkItem(i: { id: string; runId: string; taskId: string; nodeId: string; kind: string }): Promise<void> {
    await db.execute(sql`
      INSERT INTO project.workflow_work_items
        (project_id, id, run_id, task_id, node_id, kind, state, attempt, lease_owner, lease_expires_at, created_at, updated_at)
      VALUES (${PROJECT}, ${i.id}, ${i.runId}, ${i.taskId}, ${i.nodeId}, ${i.kind}, 'running', 1, ${LEASE_OWNER}, ${FAR},
              ${NOW}, ${NOW})
    `);
  }

  function move(runId: string, to: string): Promise<unknown> {
    return db.execute(sql`
      UPDATE project.ccc_planning_runs SET state = ${to}, state_code = ${STATE_CODES[to] ?? null}, updated_at = ${NOW}
       WHERE project_id = ${PROJECT} AND run_id = ${runId}
    `);
  }

  /** An admitted anchor, its held task and a leased planning work item; the run is moved to `running`. */
  async function seedRun(overrides: Partial<CccPlanningRunInsert> = {}): Promise<Run> {
    const n = next();
    const taskId = `R2C-L1-LEDGER-${n}`;
    const runId = `ccc-plan:${sha(`r2c-l1-ledger-run-${n}`).slice(0, 24)}`;
    const workItemId = `wi-${taskId}`;
    await insertTask(taskId);
    const values: CccPlanningRunInsert = {
      projectId: PROJECT, runId, planningTaskId: taskId, mode: "build", budgetProfile: "standard", roleProfile: "full-v2",
      policyVersion: "ccc-planning.budget-policy.v1", policyDigest: sha("policy"), requestDigest: sha(`request:${runId}`),
      requestBytes: 512, targetRepository: "/private/tmp/r2c-l1-target", admittedBase: "b".repeat(40),
      grantDigest: sha(`grant:${runId}`), authorityReceiptSha256: sha(`receipt:${runId}`),
      authorityReceiptJson: JSON.stringify({ runId }), runtimeDistManifestSha256: sha("dist"), state: "admitted",
      deadlineAt: FAR, planningAllocation: 1536, implementationAllocation: 20, reviewProofAllocation: 10,
      researchFetchAllocation: 5, researchBytesAllocation: 4 * 1_048_576, createdAt: NOW, updatedAt: NOW,
      ...overrides,
    };
    await db.insert(cccPlanningRuns).values(values);
    await insertWorkItem({ id: workItemId, runId, taskId, nodeId: "ccc-planning", kind: "task" });
    await move(runId, "running");
    return {
      runId, taskId, workItemId,
      fence: { kind: "planning", workItemId, runId, attempt: 1, leaseOwner: LEASE_OWNER, originTaskId: taskId },
    };
  }

  /** A Build run linked to a seeded import and moved to `building`, with a leased campaign work item for G7. */
  async function seedLinkedRun(): Promise<Run & { importId: string; campaignFence: CccPlanningWorkItemFence }> {
    const run = await seedRun();
    const importId = `r2c-l1-import-${run.taskId}`;
    const digest = sha(`import:${importId}`);
    for (const state of ["spec_ready", "importing"]) await move(run.runId, state);
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
    await db.execute(sql`
      UPDATE project.ccc_planning_runs
         SET import_intent_digest = ${sha(`intent:${run.runId}`)}, import_idempotency_key = ${`${run.runId}:r1`},
             updated_at = ${NOW}
       WHERE project_id = ${PROJECT} AND run_id = ${run.runId}
    `);
    await db.execute(sql`
      UPDATE project.ccc_planning_runs SET import_id = ${importId}, implementation_transferred = 5, updated_at = ${NOW}
       WHERE project_id = ${PROJECT} AND run_id = ${run.runId}
    `);
    await move(run.runId, "building");
    await db.execute(sql`
      UPDATE project.workflow_work_items SET state = 'succeeded', lease_owner = NULL, lease_expires_at = NULL
       WHERE project_id = ${PROJECT} AND id = ${run.workItemId}
    `);
    const campaignTask = `CAMP-${run.taskId}`;
    await insertTask(campaignTask);
    const campaignItem = `cwi-${run.taskId}`;
    await insertWorkItem({ id: campaignItem, runId: `ccc-prd:${importId}`, taskId: campaignTask, nodeId: "g7", kind: "step" });
    return {
      ...run, importId,
      campaignFence: {
        kind: "campaign", workItemId: campaignItem, runId: `ccc-prd:${importId}`, attempt: 1, leaseOwner: LEASE_OWNER,
        originTaskId: campaignTask,
      },
    };
  }

  /** The run revision each fixture binds to; `fourthTurn` moves a run forward by one revision (an amendment). */
  const revisions = new Map<string, number>();
  function revisionOf(run: Run): number {
    return revisions.get(run.runId) ?? 1;
  }

  type BindingOverrides = Partial<Omit<CccPlanningRouteBinding, "bindingHash">>;

  function binding(run: Run, lineage: Lineage, nodeAttemptOrdinal: 1 | 2 | 3, overrides: BindingOverrides = {}):
    CccPlanningRouteBinding {
    const role = cccPlanningRole(lineage.roleId);
    const base: Omit<CccPlanningRouteBinding, "bindingHash"> = {
      kind: "ccc-planning-route.v1", projectId: PROJECT, runId: run.runId, runRevision: revisionOf(run), taskId: run.taskId,
      stageId: lineage.stageId, roleId: lineage.roleId, roleClass: role.roleClass, lineageId: lineage.lineageId,
      nodeAttemptOrdinal, phase: role.phase === "review_proof" ? "review_proof" : "planning",
      providerId: `ccc-${role.family}`, modelId: role.modelId, transport: "pi",
      receiptAdapterId: "terminal-route-sse-comments.v1", toolsetDigest: sha("tools"), promptDigest: sha("prompt"),
      policyDigest: sha("policy"), grantDigest: sha(`grant:${run.runId}`),
      ...overrides,
    };
    return { ...base, bindingHash: cccPlanningBindingHash(base) };
  }

  function request(run: Run, lineage: Lineage, nodeAttemptOrdinal: 1 | 2 | 3, call: number,
    options: { fence?: CccPlanningWorkItemFence; preflight?: boolean; overrides?: BindingOverrides } = {}): CccPlanningCallRequest {
    const b = binding(run, lineage, nodeAttemptOrdinal, options.overrides);
    return {
      binding: b,
      turnKey: cccPlanningTurnKey({ projectId: PROJECT, runId: run.runId, revision: b.runRevision, stageId: b.stageId,
        roleId: b.roleId, lineageId: b.lineageId, nodeAttemptOrdinal }),
      dispatchKey: `pi-stream:${call}`,
      fence: options.fence ?? run.fence,
      preflight: options.preflight ?? false,
    };
  }

  async function admit(req: CccPlanningCallRequest): Promise<CccPlanningCallScope> {
    const decision = await admitCccPlanningDispatch(layer, req);
    expect(decision.kind).toBe("dispatch-permit");
    return decision.scope;
  }

  function settlement(scope: CccPlanningCallScope, extra: Partial<CccProviderAttemptSettlementInputOf<CccPlanningCallScope>>):
    CccProviderAttemptSettlementInputOf<CccPlanningCallScope> {
    return {
      taskId: scope.taskId, attemptKey: scope.attemptKey, controllerToken: scope.controllerToken, outcome: "committed",
      evidenceDigest: sha(`evidence:${scope.attemptKey}`), observerId: "pi-test", semanticTaskId: scope.semanticTaskId,
      campaignDeadlineAt: scope.campaignDeadlineAt, turnKey: scope.turnKey, dispatchKey: scope.dispatchKey,
      attemptOrdinal: scope.attemptOrdinal, requestCount: scope.requestCount, workItemFence: scope.workItemFence,
      binding: scope.binding, ...extra,
    };
  }

  function route(b: CccPlanningRouteBinding) {
    const [provider, model] = b.modelId.split("/") as [string, string];
    return {
      effectiveProvider: b.providerId, effectiveModel: b.modelId, usage: { inputTokens: 10, outputTokens: 4 },
      cost: { kind: "unknown" as const, reason: "subscription" }, receiptSource: "stream-usage" as const,
      omniRoute: { final: { provider, model } },
    };
  }

  async function commit(scope: CccPlanningCallScope): Promise<CccPlanningCallScope> {
    return settleCccPlanningCall(layer, settlement(scope, { outcome: "committed", effectiveRoute: route(scope.binding) }));
  }

  /** One committed call as one dispatch attempt (turn key) of the lineage. */
  async function oneAttempt(run: Run, lineage: Lineage, nodeAttemptOrdinal: 1 | 2 | 3): Promise<void> {
    await commit(await admit(request(run, lineage, nodeAttemptOrdinal, 1)));
  }

  /**
   * FNXC:CccPlanningLedger 2026-10-14-17:25:
   * A 4th distinct turn key for the same lineage, stage and role. The node-attempt ordinal is typed 1..3, so within one
   * revision a lineage has at most three turn keys; an amendment (revision + 1) gives the same lineage a new turn key at
   * ordinal 1, which is exactly the case the dispatch cap must refuse. Errata E5-L1 item 3 retired the old helper, which
   * switched the lineage to a stage it was never claimed for (now refused as a lineage that does not match its stage).
   */
  async function fourthTurn(run: Run, lineage: Lineage): Promise<CccPlanningCallRequest> {
    await db.execute(sql`
      UPDATE project.ccc_planning_runs SET revision = revision + 1, updated_at = ${NOW}
       WHERE project_id = ${PROJECT} AND run_id = ${run.runId}
    `);
    revisions.set(run.runId, revisionOf(run) + 1);
    return request(run, lineage, 1, 1);
  }

  async function lockWaiters(): Promise<number> {
    const rows = (await db.execute(sql`
      SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock'
    `)) as unknown as Array<{ n: number }>;
    return Number(rows[0]!.n);
  }

  /** Bounded poll (at most 200 x 25 ms) until `count` backends of this database wait on a lock. */
  async function awaitLockWaiters(count: number): Promise<number> {
    let waiters = await lockWaiters();
    for (let poll = 0; poll < 200 && waiters < count; poll += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      waiters = await lockWaiters();
    }
    return waiters;
  }

  async function expectRouteRefusal(promise: Promise<unknown>, detail: RegExp): Promise<void> {
    await expectRefusal(promise, "CCC_PLANNING_ROUTE_NOT_ADMITTED", detail);
  }

  async function forgeLineageEvent(run: Run, metadata: Row): Promise<void> {
    const lineageId = String(metadata.lineageId);
    await db.execute(sql`
      INSERT INTO project.run_audit_events (project_id, id, timestamp, task_id, agent_id, run_id, domain, mutation_type, target, metadata)
      VALUES (${PROJECT}, ${`forged-${run.taskId}-${lineageId}`}, ${NOW}, ${run.taskId}, 'ccc-planning-controller', ${run.runId},
              'database', 'ccc-planning:lineage:created', ${lineageId},
              ${JSON.stringify({ schema: "ccc-planning-lineage/v1", runId: run.runId, ...metadata })}::jsonb)
    `);
  }

  async function expectLimit(promise: Promise<unknown>, reason: string): Promise<void> {
    await expect(promise).rejects.toMatchObject({ name: "CccProviderAttemptLimitError", reason });
  }

  async function expectRefusal(promise: Promise<unknown>, code: string, detail?: RegExp): Promise<void> {
    await expect(promise).rejects.toMatchObject({ name: "CccPlanningRefusal", code });
    if (detail) await expect(promise).rejects.toMatchObject({ detail: expect.stringMatching(detail) });
  }

  async function anchor(runId: string): Promise<Row> {
    const rows = (await db.execute(sql`
      SELECT state, state_code, planning_spent, review_proof_spent, repair_chunks_used, repair_epoch_state, review_epochs,
             stagnant_epochs, research_fetch_spent, research_bytes_spent::int AS research_bytes_spent, control_seq, control_request
        FROM project.ccc_planning_runs WHERE project_id = ${PROJECT} AND run_id = ${runId}
    `)) as unknown as Row[];
    expect(rows).toHaveLength(1);
    return rows[0]!;
  }

  async function events(runId: string, mutationType: string): Promise<Row[]> {
    return (await db.execute(sql`
      SELECT id, agent_id, target, metadata FROM project.run_audit_events
       WHERE project_id = ${PROJECT} AND run_id = ${runId} AND mutation_type = ${mutationType}
       ORDER BY timestamp, id
    `)) as unknown as Row[];
  }

  it("admits pi-stream:11 in one turn key and refuses pi-stream:12 with iteration-cap", async () => {
    const run = await seedRun();
    for (let call = 1; call <= 11; call += 1) {
      const scope = await admit(request(run, SPEC_AUTHOR, 1, call));
      expect(scope.attemptOrdinal).toBe(call);
      await commit(scope);
    }
    await expectLimit(admitCccPlanningDispatch(layer, request(run, SPEC_AUTHOR, 1, 12)), "iteration-cap");
    expect(await anchor(run.runId)).toMatchObject({ planning_spent: 11 });
    const reserved = await events(run.runId, "ccc-planning:call:reserved");
    expect(reserved).toHaveLength(11);
    expect(Object.keys(reserved[0]!.metadata as Row).sort()).toEqual([
      "attemptKey", "bindingHash", "dispatchKey", "fence", "lineageId", "modelId", "nodeAttemptOrdinal", "outcome", "phase",
      "preflight", "promptDigest", "providerId", "revision", "roleId", "runId", "schema", "stageId", "toolsetDigest",
      "transport", "turnKey",
    ]);
    expect(reserved[0]!.agent_id).toBe("ccc-planning-controller");
  });

  it("admits three turn keys in a fresh lineage and refuses the 4th distinct turn key with dispatch-cap", async () => {
    const run = await seedRun();
    for (const attempt of [1, 2, 3] as const) await oneAttempt(run, SPEC_AUTHOR, attempt);
    await expectLimit(admitCccPlanningDispatch(layer, await fourthTurn(run, SPEC_AUTHOR)), "dispatch-cap");
    expect(await anchor(run.runId)).toMatchObject({ planning_spent: 3 });
  });

  it("a split child inheriting 2 attempts has its 2nd attempt refused; a sibling split before any attempt admits it", async () => {
    const run = await seedRun();
    const split = (childLineageId: string) => recordCccPlanningLineageSplit(layer, {
      runId: run.runId, parentLineageId: RESEARCHER.lineageId, childLineageIds: [childLineageId], fence: run.fence,
    });
    // Errata E5-L1 item 3: only a recorded lineage is admitted, so the control sibling is a split child too; it was
    // split before the parent's first attempt and inherits 0 (one field differs from the refused child).
    const sibling: Lineage = { stageId: "research", roleId: "researcher", lineageId: "research:researcher-split-0" };
    await split(sibling.lineageId);
    await oneAttempt(run, RESEARCHER, 1);
    await oneAttempt(run, RESEARCHER, 2);
    const child: Lineage = { stageId: "research", roleId: "researcher", lineageId: "research:researcher-split-1" };
    await split(child.lineageId);
    const created = await events(run.runId, "ccc-planning:lineage:created");
    expect(created.map((row) => row.metadata)).toEqual([
      expect.objectContaining({ kind: "split", lineageId: sibling.lineageId, parentLineageId: RESEARCHER.lineageId,
        roleId: "researcher", stageId: "research", inheritedDispatchAttempts: 0 }),
      expect.objectContaining({ kind: "split", lineageId: child.lineageId, parentLineageId: RESEARCHER.lineageId,
        roleId: "researcher", stageId: "research", inheritedDispatchAttempts: 2 }),
    ]);
    await oneAttempt(run, child, 1);
    await expectLimit(admitCccPlanningDispatch(layer, request(run, child, 2, 1)), "dispatch-cap");
    await oneAttempt(run, sibling, 1);
    await oneAttempt(run, sibling, 2);
  });

  it("a repair lineage claimed after the author used 2 attempts inherits 2 and its 2nd attempt is refused", async () => {
    const run = await seedRun();
    await oneAttempt(run, SPEC_AUTHOR, 1);
    await oneAttempt(run, SPEC_AUTHOR, 2);
    const claim = await claimCccPlanningRepairChunk(layer, {
      runId: run.runId, source: "planning-rejection", candidateDigest: sha("candidate-1"), repairAuthors: ["spec-author"],
      reReviewers: [], fence: run.fence,
    });
    expect(claim).toEqual({
      chunkOrdinal: 1,
      lineages: [{ roleId: "spec-author", lineageId: "repair:1:spec-author", kind: "author-repair",
        parentLineageId: "spec:spec-author", inheritedDispatchAttempts: 2 }],
    });
    const repair: Lineage = { stageId: "repair", roleId: "spec-author", lineageId: "repair:1:spec-author" };
    await oneAttempt(run, repair, 1);
    await expectLimit(admitCccPlanningDispatch(layer, request(run, repair, 2, 1)), "dispatch-cap");
    expect(await anchor(run.runId)).toMatchObject({ repair_chunks_used: 1, repair_epoch_state: "open" });
  });

  it("refuses a chunk with DISPATCH_CAP when a repair author has no attempt left and writes nothing; another author is admitted", async () => {
    const run = await seedRun();
    for (const attempt of [1, 2, 3] as const) await oneAttempt(run, SPEC_AUTHOR, attempt);
    await expectRefusal(claimCccPlanningRepairChunk(layer, {
      runId: run.runId, source: "planning-rejection", candidateDigest: sha("candidate"), repairAuthors: ["spec-author"],
      reReviewers: [], fence: run.fence,
    }), "CCC_PLANNING_DISPATCH_CAP");
    expect(await anchor(run.runId)).toMatchObject({ repair_chunks_used: 0, repair_epoch_state: "unopened" });
    expect(await events(run.runId, "ccc-planning:lineage:created")).toHaveLength(0);
    expect(await events(run.runId, "ccc-planning:repair-chunk")).toHaveLength(0);

    const claim = await claimCccPlanningRepairChunk(layer, {
      runId: run.runId, source: "planning-rejection", candidateDigest: sha("candidate"), repairAuthors: ["execution-planner"],
      reReviewers: [], fence: run.fence,
    });
    expect(claim.chunkOrdinal).toBe(1);
    expect(await anchor(run.runId)).toMatchObject({ repair_chunks_used: 1 });
  });

  it("re-reviews open review nodes with 0 inherited attempts (rv1, rv2) and a 5th chunk is REPAIR_EXHAUSTED", async () => {
    const run = await seedRun();
    for (const attempt of [1, 2, 3] as const) await oneAttempt(run, ADVERSARY, attempt);
    await expectLimit(admitCccPlanningDispatch(layer, await fourthTurn(run, ADVERSARY)), "dispatch-cap");

    const claim = (ordinal: number) => claimCccPlanningRepairChunk(layer, {
      runId: run.runId, source: "planning-rejection", candidateDigest: sha(`candidate-${ordinal}`),
      repairAuthors: ["spec-author"], reReviewers: ["product-adversary"], fence: run.fence,
    });
    const first = await claim(1);
    expect(first.chunkOrdinal).toBe(1);
    expect(first.lineages).toContainEqual({ roleId: "product-adversary", lineageId: "review:product-adversary:rv1",
      kind: "review-node", parentLineageId: "review:product-adversary", inheritedDispatchAttempts: 0 });
    const rv1: Lineage = { stageId: "review", roleId: "product-adversary", lineageId: "review:product-adversary:rv1" };
    for (const attempt of [1, 2, 3] as const) await oneAttempt(run, rv1, attempt);
    await expectLimit(admitCccPlanningDispatch(layer, await fourthTurn(run, rv1)), "dispatch-cap");

    const second = await claim(2);
    expect(second.lineages).toContainEqual({ roleId: "product-adversary", lineageId: "review:product-adversary:rv2",
      kind: "review-node", parentLineageId: "review:product-adversary", inheritedDispatchAttempts: 0 });
    const reviewNode = (await events(run.runId, "ccc-planning:lineage:created"))
      .map((row) => row.metadata as Row).find((meta) => meta.lineageId === "review:product-adversary:rv2");
    expect(reviewNode).toMatchObject({ kind: "review-node", candidateDigest: sha("candidate-2") });
    expect((await claim(3)).chunkOrdinal).toBe(3);
    expect((await claim(4)).chunkOrdinal).toBe(4);
    await expectRefusal(claim(5), "CCC_PLANNING_REPAIR_EXHAUSTED");
    expect(await anchor(run.runId)).toMatchObject({ repair_chunks_used: 4 });
  });

  it("refuses a reReviewers entry that is not reviewer-class with ROUTE_NOT_ADMITTED role-class-mismatch; a critic is admitted", async () => {
    const run = await seedRun();
    await expectRefusal(claimCccPlanningRepairChunk(layer, {
      runId: run.runId, source: "planning-rejection", candidateDigest: sha("c"), repairAuthors: ["spec-author"],
      reReviewers: ["execution-planner"], fence: run.fence,
    }), "CCC_PLANNING_ROUTE_NOT_ADMITTED", /role-class-mismatch/u);
    expect(await anchor(run.runId)).toMatchObject({ repair_chunks_used: 0 });
    const claim = await claimCccPlanningRepairChunk(layer, {
      runId: run.runId, source: "planning-rejection", candidateDigest: sha("c"), repairAuthors: ["spec-author"],
      reReviewers: ["technical-critic"], fence: run.fence,
    });
    expect(claim.chunkOrdinal).toBe(1);
  });

  it("refuses a repairAuthors entry that is not author-class with ROUTE_NOT_ADMITTED role-class-mismatch; an author is admitted", async () => {
    const run = await seedRun();
    await expectRefusal(claimCccPlanningRepairChunk(layer, {
      runId: run.runId, source: "planning-rejection", candidateDigest: sha("c"), repairAuthors: ["product-adversary"],
      reReviewers: [], fence: run.fence,
    }), "CCC_PLANNING_ROUTE_NOT_ADMITTED", /role-class-mismatch/u);
    expect(await events(run.runId, "ccc-planning:repair-chunk")).toHaveLength(0);
    const claim = await claimCccPlanningRepairChunk(layer, {
      runId: run.runId, source: "planning-rejection", candidateDigest: sha("c"), repairAuthors: ["execution-planner"],
      reReviewers: [], fence: run.fence,
    });
    expect(claim.chunkOrdinal).toBe(1);
  });

  it("refuses a claim after the repair epoch is closed with REPAIR_EPOCH_CLOSED", async () => {
    const run = await seedRun();
    await claimCccPlanningRepairChunk(layer, {
      runId: run.runId, source: "planning-rejection", candidateDigest: sha("c"), repairAuthors: ["spec-author"],
      reReviewers: [], fence: run.fence,
    });
    await closeCccPlanningRepairEpoch(layer, { runId: run.runId, fence: run.fence });
    expect(await anchor(run.runId)).toMatchObject({ repair_epoch_state: "closed" });
    await expectRefusal(claimCccPlanningRepairChunk(layer, {
      runId: run.runId, source: "planning-rejection", candidateDigest: sha("c2"), repairAuthors: ["spec-author"],
      reReviewers: [], fence: run.fence,
    }), "CCC_PLANNING_REPAIR_EPOCH_CLOSED");
  });

  it("refuses a preflight attempt's 4th call and a fresh preflight turn key admits 3 more", async () => {
    const run = await seedRun();
    for (const call of [1, 2, 3]) await commit(await admit(request(run, PREFLIGHT_WRITER, 1, call, { preflight: true })));
    await expectLimit(admitCccPlanningDispatch(layer, request(run, PREFLIGHT_WRITER, 1, 4, { preflight: true })),
      "iteration-cap");
    for (const call of [1, 2, 3]) await commit(await admit(request(run, PREFLIGHT_WRITER, 2, call, { preflight: true })));
    const status = await inspectCccPlanningRun(layer, run.runId);
    expect(status.budgets.planning).toMatchObject({ spent: 6, preflightSpent: 6 });
  });

  it("dispatched_unknown in lineage L blocks L while lineage M proceeds", async () => {
    const run = await seedRun();
    const pending = await admit(request(run, SPEC_AUTHOR, 1, 1));
    await expectLimit(admitCccPlanningDispatch(layer, request(run, SPEC_AUTHOR, 1, 2)), "unreconciled-dispatch");
    await commit(await admit(request(run, PLANNER, 1, 1)));
    await expectRefusal(assertCccPlanningDescendantsSettled(layer, run.runId), "CCC_PLANNING_DESCENDANTS_UNSETTLED");
    expect((await inspectCccPlanningRun(layer, run.runId)).unreconciled).toEqual([
      expect.objectContaining({ lineageId: SPEC_AUTHOR.lineageId, attemptKey: pending.attemptKey }),
    ]);
    await commit(pending);
    await assertCccPlanningDescendantsSettled(layer, run.runId);
    await commit(await admit(request(run, SPEC_AUTHOR, 1, 2)));
  });

  it("a proved-not-dispatched call keeps its spend and unblocks the lineage", async () => {
    const run = await seedRun();
    const scope = await admit(request(run, SPEC_AUTHOR, 1, 1));
    const proved = await proveCccPlanningCallNotDispatched(layer, scope, sha("not-dispatched"));
    expect(proved.state).toBe("proved_failed");
    expect((await events(run.runId, "ccc-planning:call:terminal")).map((row) => (row.metadata as Row).outcome))
      .toEqual(["proved_not_dispatched"]);
    expect(await anchor(run.runId)).toMatchObject({ planning_spent: 1 });
    await commit(await admit(request(run, SPEC_AUTHOR, 1, 2)));
  });

  it("two connections racing at spent = allocation - 1 admit exactly one", async () => {
    /*
    FNXC:CccPlanningLedger 2026-10-14-17:25:
    Errata E5-L1 item 1: the two admissions must really overlap. An admin transaction holds the anchor row, both
    admissions start, a bounded poll of pg_stat_activity sees both backends waiting on a lock, and only then does the
    admin transaction commit. Without the forced overlap the second admission simply ran after the first one committed,
    so removing the row locks and the spend compare-and-set went unnoticed.
    */
    const run = await seedRun({ planningAllocation: 2 });
    await oneAttempt(run, SPEC_AUTHOR, 1);
    let race: Promise<PromiseSettledResult<unknown>[]> | undefined;
    let waiters = 0;
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        SELECT 1 FROM project.ccc_planning_runs WHERE project_id = ${PROJECT} AND run_id = ${run.runId} FOR UPDATE
      `);
      race = Promise.allSettled([
        admitCccPlanningDispatch(layer, request(run, PLANNER, 1, 1)),
        admitCccPlanningDispatch(layer, request(run, RESEARCHER, 1, 1)),
      ]);
      waiters = await awaitLockWaiters(2);
    });
    expect(waiters).toBe(2);
    const results = await race!;
    const admitted = results.filter((result) => result.status === "fulfilled");
    const refused = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(admitted).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0]!.reason).toMatchObject({ name: "CccProviderAttemptLimitError", reason: "phase-allocation" });
    expect(await anchor(run.runId)).toMatchObject({ planning_spent: 2 });
    expect(await events(run.runId, "ccc-planning:call:reserved")).toHaveLength(2);
  });

  it("a route-drift settlement records refused_known_effect, keeps the spend, blocks the run in the same tx and replays as a no-op", async () => {
    const run = await seedRun();
    const control = await admit(request(run, PLANNER, 1, 1));
    expect((await commit(control)).state).toBe("committed");
    expect(await anchor(run.runId)).toMatchObject({ state: "running", state_code: null });

    const scope = await admit(request(run, SPEC_AUTHOR, 1, 1));
    const drift = settlement(scope, {
      outcome: "proved_failed", refusalReason: "effective-route-drift",
      effectiveRoute: { ...route(scope.binding), effectiveModel: "glm/glm-5.3-flash" },
    });
    expect((await settleCccPlanningCall(layer, drift)).state).toBe("proved_failed");
    expect(await anchor(run.runId)).toMatchObject({
      state: "blocked_provider", state_code: "CCC_PROVIDER_PIN_DRIFT", planning_spent: 2,
    });
    const terminal = (await events(run.runId, "ccc-planning:call:terminal"))
      .map((row) => row.metadata as Row).find((meta) => meta.attemptKey === scope.attemptKey);
    expect(terminal).toMatchObject({
      outcome: "refused_known_effect",
      refusal: { reason: "effective-route-drift", requested: { provider: "ccc-glm", model: "glm/glm-5.3" },
        observed: { provider: "ccc-glm", model: "glm/glm-5.3-flash" } },
    });
    expect(terminal).not.toHaveProperty("effectiveRoute");
    expect(await events(run.runId, "ccc-planning:state")).toHaveLength(1);
    await expectLimit(admitCccPlanningDispatch(layer, request(run, SPEC_AUTHOR, 1, 2)), "run-not-building");

    await settleCccPlanningCall(layer, drift);
    expect(await events(run.runId, "ccc-planning:call:terminal")).toHaveLength(2);
    expect(await events(run.runId, "ccc-planning:state")).toHaveLength(1);
    expect(await anchor(run.runId)).toMatchObject({ state: "blocked_provider", planning_spent: 2 });
  });

  it("a provider error event settles failed_known_effect and leaves the run running", async () => {
    const run = await seedRun();
    const scope = await admit(request(run, SPEC_AUTHOR, 1, 1));
    await settleCccPlanningCall(layer, settlement(scope, { outcome: "proved_failed", refusalReason: "provider-error-event" }));
    expect((await events(run.runId, "ccc-planning:call:terminal")).map((row) => row.metadata)).toEqual([
      expect.objectContaining({ outcome: "failed_known_effect", refusal: expect.objectContaining({
        reason: "provider-error-event", observed: null }) }),
    ]);
    expect(await anchor(run.runId)).toMatchObject({ state: "running" });
  });

  it("charges a review_proof call under the campaign fence and refuses a planning fence or another import's fence", async () => {
    const run = await seedLinkedRun();
    const reviewer: Lineage = { stageId: "g7", roleId: "task-reviewer", lineageId: "review:T-1" };
    const scope = await admit(request(run, reviewer, 1, 1, { fence: run.campaignFence }));
    expect(scope.workItemFence).toEqual({ workItemId: run.campaignFence.workItemId, runId: `ccc-prd:${run.importId}`, attempt: 1 });
    expect(await anchor(run.runId)).toMatchObject({ review_proof_spent: 1, planning_spent: 0 });
    await commit(scope);

    // Errata E5-L1 item 2: re-lease the planning work item first, so the planning fence would pass the liveness lock
    // and only the fence-kind check (D14: review/proof spend only under the campaign fence) can refuse it.
    await db.execute(sql`
      UPDATE project.workflow_work_items SET state = 'running', lease_owner = ${run.fence.leaseOwner}, lease_expires_at = ${FAR}
       WHERE project_id = ${PROJECT} AND id = ${run.workItemId} AND attempt = ${run.fence.attempt}
    `);
    await expectRefusal(admitCccPlanningDispatch(layer, request(run, reviewer, 1, 2, { fence: run.fence })),
      "CCC_PLANNING_FENCE_STALE", /a campaign fence is required/u);
    const other = await seedLinkedRun();
    await expectRefusal(admitCccPlanningDispatch(layer, request(run, reviewer, 1, 2, { fence: other.campaignFence })),
      "CCC_PLANNING_FENCE_STALE");
    expect(await anchor(run.runId)).toMatchObject({ review_proof_spent: 1 });
    await commit(await admit(request(run, reviewer, 1, 2, { fence: run.campaignFence })));
  });

  it("calls the linked-outcome port exactly once before reading a linked run and never for an unlinked one", async () => {
    const linked = await seedLinkedRun();
    const calls: string[] = [];
    const port = async (_layer: AsyncDataLayer, runId: string): Promise<void> => {
      calls.push(runId);
      await move(runId, "paused");
    };
    const status = await inspectCccPlanningRun(layer, linked.runId, { reconcileLinkedOutcome: port });
    expect(calls).toEqual([linked.runId]);
    expect(status).toMatchObject({ state: "paused", import: expect.objectContaining({ importId: linked.importId }) });

    const unlinked = await seedRun();
    const plain = await inspectCccPlanningRun(layer, unlinked.runId, { reconcileLinkedOutcome: port });
    expect(calls).toEqual([linked.runId]);
    expect(plain).toMatchObject({ runId: unlinked.runId, state: "running", import: null });
    expect(await inspectCccPlanningRun(layer, linked.runId)).toMatchObject({ state: "paused" });
    expect(calls).toEqual([linked.runId]);
  });

  it("two stagnant review epochs in a row give stop: true; an improving epoch resets the count", async () => {
    const run = await seedRun();
    const epoch = (n: number, blockingFindings: number) => recordCccPlanningReviewEpoch(layer, {
      runId: run.runId, fence: run.fence, epochDigest: sha(`epoch-${n}`), blockingFindings,
    });
    expect(await epoch(1, 5)).toEqual({ reviewEpochs: 1, stagnantEpochs: 0, stop: false });
    expect(await epoch(2, 5)).toEqual({ reviewEpochs: 2, stagnantEpochs: 1, stop: false });
    expect(await epoch(3, 4)).toEqual({ reviewEpochs: 3, stagnantEpochs: 0, stop: false });
    expect(await epoch(4, 4)).toEqual({ reviewEpochs: 4, stagnantEpochs: 1, stop: false });
    expect(await epoch(5, 6)).toEqual({ reviewEpochs: 5, stagnantEpochs: 2, stop: true });
    expect(await anchor(run.runId)).toMatchObject({ review_epochs: 5, stagnant_epochs: 2 });
    expect(await epoch(5, 6)).toEqual({ reviewEpochs: 5, stagnantEpochs: 2, stop: true });
    await expectRefusal(epoch(6, 1), "CCC_PLANNING_REVIEW_STAGNATED");
  });

  it("grants one research fetch at a time and charges the settled raw bytes", async () => {
    const run = await seedRun();
    const fetch = (nodeAttempt: number) => reserveCccPlanningResearchFetch(layer, {
      runId: run.runId, nodeId: "research:researcher", nodeAttempt, maxRawBytes: 1_048_576, fence: run.fence,
    });
    const first = await fetch(1);
    expect(first.grantKey).toBe(`${run.runId}:f1`);
    await expectRefusal(fetch(1), "CCC_PLANNING_RESEARCH_GRANT_EXHAUSTED", /unsettled/u);
    await settleCccPlanningResearchFetch(layer, { grantKey: first.grantKey, rawBytes: 2048, outcome: "fetched" });
    await settleCccPlanningResearchFetch(layer, { grantKey: first.grantKey, rawBytes: 2048, outcome: "fetched" });
    expect(await anchor(run.runId)).toMatchObject({ research_fetch_spent: 1, research_bytes_spent: 2048 });
    expect((await fetch(1)).grantKey).toBe(`${run.runId}:f2`);
  });

  async function claimChunk(run: Run, i: { authors?: CccPlanningRoleId[]; reviewers?: CccPlanningRoleId[] } = {}) {
    return claimCccPlanningRepairChunk(layer, {
      runId: run.runId, source: "planning-rejection", candidateDigest: sha("candidate"),
      repairAuthors: i.authors ?? ["spec-author"], reReviewers: i.reviewers ?? [], fence: run.fence,
    });
  }

  const REPAIR_1: Lineage = { stageId: "repair", roleId: "spec-author", lineageId: "repair:1:spec-author" };
  const ADVERSARY_RV1: Lineage = { stageId: "review", roleId: "product-adversary", lineageId: "review:product-adversary:rv1" };

  it("refuses an unclaimed repair lineage, an unclaimed review node and a lineage outside its stage; claimed lineages are admitted (ADV-1)", async () => {
    const run = await seedRun();
    await oneAttempt(run, SPEC_AUTHOR, 1);
    await expectRouteRefusal(admitCccPlanningDispatch(layer, request(run, REPAIR_1, 1, 1)), /lineage-not-admitted/u);
    await expectRouteRefusal(admitCccPlanningDispatch(layer, request(run, ADVERSARY_RV1, 1, 1)), /lineage-not-admitted/u);
    await expectRouteRefusal(admitCccPlanningDispatch(layer, request(run, { ...SPEC_AUTHOR, stageId: "repair" }, 1, 1)),
      /lineage-not-admitted/u);
    expect(await anchor(run.runId)).toMatchObject({ planning_spent: 1, repair_chunks_used: 0 });
    expect(await events(run.runId, "ccc-planning:call:reserved")).toHaveLength(1);

    await claimChunk(run, { reviewers: ["product-adversary"] });
    await expectRouteRefusal(admitCccPlanningDispatch(layer, request(run, { ...REPAIR_1, stageId: "spec" }, 1, 1)),
      /lineage-not-admitted/u);
    await oneAttempt(run, REPAIR_1, 1);
    await oneAttempt(run, ADVERSARY_RV1, 1);
    expect(await anchor(run.runId)).toMatchObject({ planning_spent: 3, repair_chunks_used: 1 });
  });

  it("refuses a repair lineage above CCC_PLANNING_MAX_REPAIR_CHUNKS even with a lineage:created event; the highest allowed ordinal is admitted", async () => {
    const forged = (ordinal: number) => ({
      lineageId: `repair:${ordinal}:spec-author`, kind: "author-repair", roleId: "spec-author", parentLineageId: "spec:spec-author",
      chunkOrdinal: ordinal, inheritedDispatchAttempts: 0,
    });
    const beyond = await seedRun();
    const over = CCC_PLANNING_MAX_REPAIR_CHUNKS + 1;
    await forgeLineageEvent(beyond, forged(over));
    await expectRouteRefusal(admitCccPlanningDispatch(layer,
      request(beyond, { ...REPAIR_1, lineageId: `repair:${over}:spec-author` }, 1, 1)), /lineage-not-admitted/u);
    expect(await anchor(beyond.runId)).toMatchObject({ planning_spent: 0 });

    const highest = await seedRun();
    await forgeLineageEvent(highest, forged(CCC_PLANNING_MAX_REPAIR_CHUNKS));
    await oneAttempt(highest, { ...REPAIR_1, lineageId: `repair:${CCC_PLANNING_MAX_REPAIR_CHUNKS}:spec-author` }, 1);
  });

  it("after a repair chunk claims lineages for a role, earlier lineages of that role take no new turn key (ADV-9)", async () => {
    const twin = await seedRun();
    await oneAttempt(twin, SPEC_AUTHOR, 1);
    await oneAttempt(twin, SPEC_AUTHOR, 2);

    const run = await seedRun();
    await oneAttempt(run, SPEC_AUTHOR, 1);
    await claimChunk(run, { reviewers: ["product-adversary"] });
    await oneAttempt(run, REPAIR_1, 1);
    await oneAttempt(run, REPAIR_1, 2);
    await expectLimit(admitCccPlanningDispatch(layer, request(run, REPAIR_1, 3, 1)), "dispatch-cap");
    await expectRouteRefusal(admitCccPlanningDispatch(layer, request(run, SPEC_AUTHOR, 2, 1)), /lineage-superseded/u);
    await expectRouteRefusal(admitCccPlanningDispatch(layer, request(run, ADVERSARY, 1, 1)), /lineage-superseded/u);
    await oneAttempt(run, ADVERSARY_RV1, 1);
    const authorTurns = new Set((await events(run.runId, "ccc-planning:call:reserved"))
      .map((row) => row.metadata as Row).filter((meta) => meta.roleId === "spec-author").map((meta) => meta.turnKey));
    expect(authorTurns.size).toBe(3);
  });

  it("refuses a repair chunk with UNRECONCILED_DISPATCH while an earlier lineage of the role is dispatched_unknown and writes nothing (ADV-8)", async () => {
    const run = await seedRun();
    const pending = await admit(request(run, SPEC_AUTHOR, 1, 1));
    await expectRefusal(claimChunk(run), "CCC_PLANNING_UNRECONCILED_DISPATCH", /spec-author/u);
    const critic = await seedRun();
    const reviewing = await admit(request(critic, ADVERSARY, 1, 1));
    await expectRefusal(claimChunk(critic, { authors: [], reviewers: ["product-adversary"] }), "CCC_PLANNING_UNRECONCILED_DISPATCH",
      /product-adversary/u);
    for (const target of [run, critic]) {
      expect(await anchor(target.runId)).toMatchObject({ repair_chunks_used: 0, repair_epoch_state: "unopened" });
      expect(await events(target.runId, "ccc-planning:repair-chunk")).toHaveLength(0);
      expect(await events(target.runId, "ccc-planning:lineage:created")).toHaveLength(0);
    }

    await commit(pending);
    expect((await claimChunk(run)).chunkOrdinal).toBe(1);
    await oneAttempt(run, REPAIR_1, 1);
    await commit(reviewing);
    expect((await claimChunk(critic, { authors: [], reviewers: ["product-adversary"] })).chunkOrdinal).toBe(1);
  });

  it("refuses a settlement whose refusal reason is outside the union with INTERNAL_ERROR and writes nothing (ADV-2)", async () => {
    const run = await seedRun();
    const scope = await admit(request(run, SPEC_AUTHOR, 1, 1));
    const drifted = { ...route(scope.binding), effectiveModel: "glm/glm-5.3-flash" };
    await expectRefusal(settleCccPlanningCall(layer, settlement(scope, {
      outcome: "proved_failed", refusalReason: "receipt_mismatch" as never, effectiveRoute: drifted,
    })), "CCC_PLANNING_INTERNAL_ERROR", /refusalReason/u);
    expect(await events(run.runId, "ccc-planning:call:terminal")).toHaveLength(0);
    expect(await anchor(run.runId)).toMatchObject({ state: "running", state_code: null, planning_spent: 1 });
    await expectLimit(admitCccPlanningDispatch(layer, request(run, SPEC_AUTHOR, 1, 2)), "unreconciled-dispatch");

    await settleCccPlanningCall(layer, settlement(scope, {
      outcome: "proved_failed", refusalReason: "receipt-mismatch", effectiveRoute: drifted,
    }));
    expect((await events(run.runId, "ccc-planning:call:terminal")).map((row) => (row.metadata as Row).outcome))
      .toEqual(["refused_known_effect"]);
    expect(await anchor(run.runId)).toMatchObject({ state: "blocked_provider", state_code: "CCC_PROVIDER_PIN_DRIFT" });
  });

  it("an earlier epoch's digest redelivered after a later epoch is a replay that records nothing (ADV-5)", async () => {
    const run = await seedRun();
    const epoch = (n: number, blockingFindings: number) => recordCccPlanningReviewEpoch(layer, {
      runId: run.runId, fence: run.fence, epochDigest: sha(`epoch-${n}`), blockingFindings,
    });
    expect(await epoch(1, 5)).toEqual({ reviewEpochs: 1, stagnantEpochs: 0, stop: false });
    expect(await epoch(2, 5)).toEqual({ reviewEpochs: 2, stagnantEpochs: 1, stop: false });
    expect(await epoch(1, 5)).toEqual({ reviewEpochs: 1, stagnantEpochs: 0, stop: false });
    expect(await anchor(run.runId)).toMatchObject({ review_epochs: 2, stagnant_epochs: 1 });
    expect(await events(run.runId, "ccc-planning:review-epoch")).toHaveLength(2);
    expect(await epoch(3, 5)).toEqual({ reviewEpochs: 3, stagnantEpochs: 2, stop: true });
  });

  it("refuses an audit id over 256 characters or a malformed digest with INTERNAL_ERROR before any write; bounded values are admitted", async () => {
    const run = await seedRun();
    const refused: Array<{ overrides: BindingOverrides; field: RegExp }> = [
      { overrides: { providerId: "p".repeat(257) }, field: /providerId/u },
      { overrides: { lineageId: "l".repeat(257) }, field: /lineageId/u },
      { overrides: { toolsetDigest: sha("tools").toUpperCase() }, field: /toolsetDigest/u },
      { overrides: { promptDigest: sha("prompt").slice(1) }, field: /promptDigest/u },
    ];
    for (const { overrides, field } of refused) {
      await expectRefusal(admitCccPlanningDispatch(layer, request(run, SPEC_AUTHOR, 1, 1, { overrides })),
        "CCC_PLANNING_INTERNAL_ERROR", field);
    }
    expect(await anchor(run.runId)).toMatchObject({ planning_spent: 0 });
    expect(await events(run.runId, "ccc-planning:call:reserved")).toHaveLength(0);

    const scope = await admit(request(run, SPEC_AUTHOR, 1, 1, { overrides: { providerId: "p".repeat(256) } }));
    await expectRefusal(proveCccPlanningCallNotDispatched(layer, scope, "not-a-digest"), "CCC_PLANNING_INTERNAL_ERROR",
      /evidenceDigest/u);
    await expectRefusal(settleCccPlanningCall(layer, settlement(scope, {
      outcome: "proved_failed", refusalReason: "provider-error-event", evidenceDigest: sha("evidence").toUpperCase(),
    })), "CCC_PLANNING_INTERNAL_ERROR", /evidenceDigest/u);
    await expectRefusal(settleCccPlanningCall(layer, settlement(scope, {
      outcome: "proved_failed", refusalReason: "receipt-mismatch",
      effectiveRoute: { ...route(scope.binding), effectiveModel: "m".repeat(257) } as never,
    })), "CCC_PLANNING_INTERNAL_ERROR", /effectiveModel/u);
    expect(await events(run.runId, "ccc-planning:call:terminal")).toHaveLength(0);
    expect((await proveCccPlanningCallNotDispatched(layer, scope, sha("not-dispatched"))).state).toBe("proved_failed");
  });
});
