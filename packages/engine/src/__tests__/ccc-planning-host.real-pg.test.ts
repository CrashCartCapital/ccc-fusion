/**
 * FNXC:CccPlanningHost 2026-10-14-22:17 (card H1):
 * The planning host against a real PostgreSQL: lease reclaim through the existing acquire path (D3), engine-start
 * recovery of cancelling and dispatched runs (D45), and the linked-outcome port (verify-v2 item 35). The L1 and A1
 * functions run unmodified through H1's bound ports; rows are seeded the way the L1 card's own tests seed them.
 *
 * Every refusal or recovery has a control on the same kind of fixture that differs in one field (a live lease, no
 * port, an unlinked run), so an implementation that ignores the field cannot pass both.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  admitCccPlanningDispatch,
  buildCccPlanningWorkflowIr,
  CCC_PLANNING_IR_STAGES,
  cccPlanningBindingHash,
  cccPlanningDecisionId,
  cccPlanningRole,
  cccPlanningTurnKey,
  cccPlanningWorkflowIrHash,
  drizzleSql as sql,
  getCccPlanningRunForTask,
  registerCccRunningRuntimeDistManifest,
  requestCccPlanningControl,
  type CccPlanningCallRequest,
  type CccPlanningIrStageId,
  type CccPlanningRouteBinding,
  type CccPlanningWorkItemFence,
} from "@fusion/core";
import {
  createTaskStoreForTest,
  pgDescribe,
  type PgTestHarness,
} from "../../../core/src/__test-utils__/pg-test-harness.js";
import { cccPlanningRuns } from "../../../core/src/postgres/schema/ccc-planning.js";
import { processDueWorkflowWorkItem } from "../workflow-work-processor.js";
import { WorkflowTaskRuntime } from "../workflow-task-runtime.js";
import { createCccPlanningStageHandler } from "../ccc-planning/controller.js";
import {
  createCccPlanningArtifactPort,
  createCccPlanningLedgerPort,
  type CccPlanningLedgerPort,
  type CccPlanningStageContext,
  type CccPlanningStageFn,
} from "../ccc-planning/ports.js";
import { recoverCccPlanningRuns } from "../ccc-planning/recovery.js";

const PROJECT = "__legacy_unscoped__";
const NOW = "2026-10-14T12:00:00.000Z";
const PAST = "2020-01-01T00:00:00.000Z";
const FAR = "2999-01-01T00:00:00.000Z";
const DEAD_ENGINE = "h1-dead-engine";
const LIVE_ENGINE = "h1-engine-b";

function sha(label: string): string {
  return createHash("sha256").update(label, "utf8").digest("hex");
}

const RUNTIME_DIGEST = sha("r2c-h1-runtime");

type Run = Readonly<{ runId: string; taskId: string; workItemId: string; fence: CccPlanningWorkItemFence }>;
type Row = Record<string, unknown>;

pgDescribe("ccc planning host (card H1, PostgreSQL)", () => {
  let harness: PgTestHarness;
  let db: PgTestHarness["adminDb"];

  beforeAll(async () => {
    harness = await createTaskStoreForTest({ prefix: "fusion_ccc_planning_h1", copyFromGolden: true });
    db = harness.adminDb;
    registerCccRunningRuntimeDistManifest(RUNTIME_DIGEST);
  });

  afterAll(async () => {
    await harness?.teardown();
  });

  let ordinal = 0;

  async function move(run: Pick<Run, "runId">, states: readonly string[]): Promise<void> {
    const codes: Readonly<Record<string, string>> = { unknown_effect: "CCC_PLANNING_UNRECONCILED_DISPATCH" };
    for (const state of states) {
      await db.execute(sql`
        UPDATE project.ccc_planning_runs SET state = ${state}, state_code = ${codes[state] ?? null}, updated_at = ${NOW}
         WHERE project_id = ${PROJECT} AND run_id = ${run.runId}
      `);
    }
  }

  /** A Build run with its task, K1 workflow, selection and planning work item, as admission (AD1) leaves them. */
  async function seedRun(options: { path?: readonly string[]; lease: "live" | "expired"; owner?: string; label?: string;
    mode?: "build" | "spec" }): Promise<Run> {
    ordinal += 1;
    const taskId = `R2C-H1-${ordinal}`;
    const runId = `ccc-plan:${sha(options.label ?? `r2c-h1-run-${ordinal}`).slice(0, 24)}`;
    const workItemId = `${runId.replace(":", "-")}--planning`;
    const workflowId = `${runId.replace(":", "-")}--workflow`;
    const ir = buildCccPlanningWorkflowIr(options.mode ?? "build");
    const owner = options.owner ?? DEAD_ENGINE;
    await db.execute(sql`
      INSERT INTO project.tasks (project_id, id, description, "column", lineage_id, created_at, updated_at)
      VALUES (${PROJECT}, ${taskId}, ${`request-to-code fixture ${taskId}`}, 'todo', ${runId}, ${NOW}, ${NOW})
    `);
    await db.insert(cccPlanningRuns).values({
      projectId: PROJECT, runId, planningTaskId: taskId, mode: options.mode ?? "build", budgetProfile: "standard", roleProfile: "full-v2",
      policyVersion: "ccc-planning.budget-policy.v1", policyDigest: sha("policy"), requestDigest: sha(`request:${runId}`),
      requestBytes: 512, targetRepository: "/private/tmp/r2c-h1-target", admittedBase: "b".repeat(40),
      grantDigest: sha(`grant:${runId}`), authorityReceiptSha256: sha(`receipt:${runId}`),
      authorityReceiptJson: JSON.stringify({ runId }), runtimeDistManifestSha256: RUNTIME_DIGEST, state: "admitted",
      deadlineAt: FAR, planningAllocation: 1536,
      // The anchor CHECK: a Spec run carries no implementation or review-proof allocation.
      implementationAllocation: options.mode === "spec" ? 0 : 20, reviewProofAllocation: options.mode === "spec" ? 0 : 10,
      researchFetchAllocation: 5, researchBytesAllocation: 1_048_576, createdAt: NOW, updatedAt: NOW,
    });
    await db.execute(sql`
      INSERT INTO project.workflows (project_id, id, name, description, ir, layout, kind, created_at, updated_at)
      VALUES (${PROJECT}, ${workflowId}, ${ir.name}, '', ${JSON.stringify(ir)}::jsonb, '{}'::jsonb, 'workflow', ${NOW}, ${NOW})
    `);
    await db.execute(sql`
      INSERT INTO project.task_workflow_selection (project_id, task_id, workflow_id, step_ids, updated_at)
      VALUES (${PROJECT}, ${taskId}, ${workflowId}, '[]'::jsonb, ${NOW})
    `);
    await db.execute(sql`
      INSERT INTO project.workflow_work_items
        (project_id, id, run_id, task_id, node_id, kind, state, attempt, lease_owner, lease_expires_at, ir_hash,
         stable_workflow_run_id, created_at, updated_at)
      VALUES (${PROJECT}, ${workItemId}, ${runId}, ${taskId}, 'preflight', 'task', 'running', 1, ${owner}, ${FAR},
              ${cccPlanningWorkflowIrHash(ir)}, ${runId}, ${NOW}, ${NOW})
    `);
    const run: Run = {
      runId, taskId, workItemId,
      fence: { kind: "planning", workItemId, runId, attempt: 1, leaseOwner: owner, originTaskId: taskId },
    };
    await move(run, options.path ?? ["running"]);
    if (options.lease === "expired") await expireLease(run);
    return run;
  }

  function expireLease(run: Run): Promise<unknown> {
    return db.execute(sql`
      UPDATE project.workflow_work_items SET lease_expires_at = ${PAST} WHERE project_id = ${PROJECT} AND id = ${run.workItemId}
    `);
  }

  /** A controller-published preflight artifact, written under the dead engine's still-live lease. */
  async function publishPreflightReceipt(run: Run): Promise<void> {
    const key = "cccplan-r001-preflight-receipt1-v01";
    const content = JSON.stringify({ schema: "ccc-planning.model-receipt.v1", note: "h1 fixture" });
    const metadata = {
      schema: "ccc-planning.artifact-envelope.v1", artifactKey: key, runId: run.runId, runRevision: 1, stageId: "preflight",
      slot: "receipt1", version: 1, kind: "model_receipt", contentType: "application/json",
      contentSchema: "ccc-planning.model-receipt.v1", inputs: [],
      producer: { kind: "controller", roleId: "controller", instanceId: "controller:1" },
      policy: { promptVersion: "none", promptDigest: "none", toolPolicyVersion: "none", toolPolicyDigest: "none" },
      outputDigest: sha(content), status: "complete",
      fence: { kind: "work_item_lease", workItemId: run.workItemId, leaseOwner: run.fence.leaseOwner, attempt: 1, runId: run.runId },
      identityDigest: sha(`identity:${run.runId}:${key}`), publishedAt: NOW,
    };
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('fusion.ccc_planning_publication', 'on', true)`);
      await tx.execute(sql`
        INSERT INTO project.task_documents
          (project_id, id, task_id, key, content, revision, author, metadata, created_at, updated_at)
        VALUES (${PROJECT}, ${`doc-${run.taskId}-${key}`}, ${run.taskId}, ${key}, ${content}, 1,
                'ccc-planning:controller', ${JSON.stringify(metadata)}::jsonb, ${NOW}, ${NOW})
      `);
    });
  }

  /** One reserved-and-dispatched planning call (L1's dispatch permit), never settled: dispatched_unknown. */
  async function dispatchUnsettledCall(run: Run): Promise<void> {
    const lineage = { stageId: "spec", roleId: "spec-author", lineageId: "spec:spec-author" } as const;
    const role = cccPlanningRole(lineage.roleId);
    const base: Omit<CccPlanningRouteBinding, "bindingHash"> = {
      kind: "ccc-planning-route.v1", projectId: PROJECT, runId: run.runId, runRevision: 1, taskId: run.taskId,
      stageId: lineage.stageId, roleId: lineage.roleId, roleClass: role.roleClass, lineageId: lineage.lineageId,
      nodeAttemptOrdinal: 1, phase: role.phase === "review_proof" ? "review_proof" : "planning",
      providerId: `ccc-${role.family}`, modelId: role.modelId, transport: "pi",
      receiptAdapterId: "terminal-route-sse-comments.v1", toolsetDigest: sha("tools"), promptDigest: sha("prompt"),
      policyDigest: sha("policy"), grantDigest: sha(`grant:${run.runId}`),
    };
    const request: CccPlanningCallRequest = {
      binding: { ...base, bindingHash: cccPlanningBindingHash(base) },
      turnKey: cccPlanningTurnKey({ projectId: PROJECT, runId: run.runId, revision: 1, stageId: lineage.stageId,
        roleId: lineage.roleId, lineageId: lineage.lineageId, nodeAttemptOrdinal: 1 }),
      dispatchKey: "pi-stream:1", fence: run.fence, preflight: false,
    };
    await expect(admitCccPlanningDispatch(harness.layer, request)).resolves.toMatchObject({ kind: "dispatch-permit" });
  }

  async function anchor(run: Pick<Run, "runId">): Promise<Row> {
    const rows = (await db.execute(sql`
      SELECT state, state_code, control_request FROM project.ccc_planning_runs WHERE project_id = ${PROJECT} AND run_id = ${run.runId}
    `)) as unknown as Row[];
    expect(rows).toHaveLength(1);
    return rows[0]!;
  }

  async function workItem(run: Run): Promise<Row> {
    const rows = (await db.execute(sql`
      SELECT state, attempt, lease_owner FROM project.workflow_work_items WHERE project_id = ${PROJECT} AND id = ${run.workItemId}
    `)) as unknown as Row[];
    expect(rows).toHaveLength(1);
    return rows[0]!;
  }

  /**
   * Stages that own their idempotency the way the real ones do: each reads its own committed artifacts through the
   * bound L1 port and does work only when it has none. `entered` is every stage the host started, `calls` (worked) the
   * ones that did work.
   */
  function recordingStages() {
    const calls: Array<{ stageId: CccPlanningIrStageId; fence: CccPlanningWorkItemFence }> = [];
    const entered: Array<{ stageId: CccPlanningIrStageId; fence: CccPlanningWorkItemFence }> = [];
    const stages = Object.fromEntries(CCC_PLANNING_IR_STAGES.map((stageId) => [stageId, async (ctx: CccPlanningStageContext) => {
      entered.push({ stageId: ctx.stageId, fence: ctx.fence });
      const status = await ctx.ledger.inspectCccPlanningRun(ctx.run.runId);
      const mine = status.stages.find((stage) => stage.stageId === ctx.stageId);
      if (mine?.status === "committed") return { kind: "committed", artifactKeys: mine.artifactKeys };
      calls.push({ stageId: ctx.stageId, fence: ctx.fence });
      await sealSpecReady(ctx);
      return { kind: "committed", artifactKeys: [] };
    }])) as Record<CccPlanningIrStageId, CccPlanningStageFn>;
    return { stages, calls, entered };
  }

  /*
  FNXC:CccPlanningHost 2026-10-15-00:04 (W3 repair 2, E14 item 2):
  Like the real specready stage (PRD section 9, D53), the fixture moves a running run to spec_ready under the stage's
  fence: the host now concludes a run that is still admitted or running when the workflow completes.
  */
  async function sealSpecReady(ctx: CccPlanningStageContext): Promise<void> {
    if (ctx.stageId !== "specready" || ctx.run.state !== "running") return;
    await ctx.ledger.transitionCccPlanningRunState({
      runId: ctx.run.runId, from: "running", to: "spec_ready", stateCode: null, fence: ctx.fence,
    });
  }

  function planningRuntime(stages: Record<CccPlanningIrStageId, CccPlanningStageFn>,
    ledger: CccPlanningLedgerPort = createCccPlanningLedgerPort(harness.layer)): WorkflowTaskRuntime {
    return new WorkflowTaskRuntime({
      store: harness.store,
      primitives: {} as never,
      runCustomNode: async () => ({ outcome: "success" }),
      runCccPlanningStage: createCccPlanningStageHandler({
        stages,
        ledger,
        artifacts: createCccPlanningArtifactPort(harness.layer),
        sessions: { open: async () => { throw new Error("no session is expected"); } },
      }),
    });
  }

  function processRun(run: Run, runtime: WorkflowTaskRuntime, store: PgTestHarness["store"] = harness.store) {
    return processDueWorkflowWorkItem(store, runtime, undefined, {
      leaseOwner: LIVE_ENGINE, leaseDurationMs: 60_000, custody: "planning",
      exactCandidate: { id: run.workItemId, runId: run.runId, attempt: 1 },
    });
  }

  function outcomeOf(results: ReadonlyArray<Readonly<{ runId: string; outcome: string }>>, run: Pick<Run, "runId">): string | undefined {
    return results.find((result) => result.runId === run.runId)?.outcome;
  }

  it("H1 RED 3: an expired lease is reclaimed by the existing acquire path and the next stage runs", async () => {
    const run = await seedRun({ lease: "live" });
    await publishPreflightReceipt(run);
    await expireLease(run);

    // Engine-start recovery leaves the expired item exactly where it is: nothing but the acquire path reclaims it.
    const recovered = await recoverCccPlanningRuns({ store: harness.store });
    expect(outcomeOf(recovered, run)).toBe("none");
    expect(await workItem(run)).toMatchObject({ state: "running", attempt: 1, lease_owner: DEAD_ENGINE });

    const { stages, calls, entered } = recordingStages();
    const result = await processRun(run, planningRuntime(stages));

    expect(result).toMatchObject({ claimed: true, runtime: { disposition: "completed" } });
    // The new owner enters every stage under its own fence; preflight finds its committed receipt and does no work.
    expect(entered.map((call) => call.stageId)).toEqual([...CCC_PLANNING_IR_STAGES]);
    expect(calls.map((call) => call.stageId)).toEqual(CCC_PLANNING_IR_STAGES.filter((stageId) => stageId !== "preflight"));
    for (const call of entered) {
      expect(call.fence).toEqual({ ...run.fence, leaseOwner: LIVE_ENGINE });
    }
    expect(await workItem(run)).toMatchObject({ state: "succeeded", attempt: 1, lease_owner: null });
    expect(await anchor(run)).toMatchObject({ state: "spec_ready" });
  });

  it("H1 control: a live lease held by another engine is not reclaimed and no stage runs", async () => {
    const run = await seedRun({ lease: "live" });
    const { stages, calls } = recordingStages();

    const result = await processRun(run, planningRuntime(stages));

    expect(result.claimed).toBe(false);
    expect(calls).toEqual([]);
    expect(await workItem(run)).toMatchObject({ state: "running", lease_owner: DEAD_ENGINE });
  });

  it("H1 RED 3b: recovery.ts contains no requeue of planning work", async () => {
    const source = await readFile(fileURLToPath(new URL("../ccc-planning/recovery.ts", import.meta.url)), "utf8");
    expect(source).not.toMatch(/requeue/iu);
    expect(source).not.toMatch(/["']runnable["']/u);
    expect(source).not.toMatch(/acquireWorkflowWorkItemLease|lease_expires_at\s*=/u);
  });

  it("H1 RED 9: at engine start a cancelling run whose lease expired ends cancelled", async () => {
    const expired = await seedRun({ path: ["running", "cancelling"], lease: "expired" });
    const live = await seedRun({ path: ["running", "cancelling"], lease: "live" });

    const recovered = await recoverCccPlanningRuns({ store: harness.store });

    expect(outcomeOf(recovered, expired)).toBe("cancellation-completed");
    expect(await anchor(expired)).toMatchObject({ state: "cancelled" });
    expect(await workItem(expired)).toMatchObject({ state: "cancelled", lease_owner: null });
    expect(outcomeOf(recovered, live)).toBe("none");
    expect(await anchor(live)).toMatchObject({ state: "cancelling" });
    expect(await workItem(live)).toMatchObject({ state: "running", lease_owner: DEAD_ENGINE });
  });

  it("H1 recovery: a running run with a dispatched_unknown call and no live holder moves to unknown_effect", async () => {
    const expired = await seedRun({ lease: "live" });
    await dispatchUnsettledCall(expired);
    await expireLease(expired);
    const live = await seedRun({ lease: "live" });
    await dispatchUnsettledCall(live);

    const recovered = await recoverCccPlanningRuns({ store: harness.store });

    expect(outcomeOf(recovered, expired)).toBe("unknown-effect");
    expect(await anchor(expired)).toMatchObject({ state: "unknown_effect", state_code: "CCC_PLANNING_UNRECONCILED_DISPATCH" });
    expect(outcomeOf(recovered, live)).toBe("none");
    expect(await anchor(live)).toMatchObject({ state: "running" });
  });

  it("H1 RED 10: recovery calls reconcileLinkedOutcome once per linked run, never for an unlinked one; without ports it reports none", async () => {
    const linked = await seedRun({ path: ["running", "spec_ready", "importing"], lease: "live" });
    const importId = `r2c-h1-import-${linked.taskId}`;
    const digest = sha(`import:${importId}`);
    await db.execute(sql`
      INSERT INTO project.ccc_prd_imports (
        project_id, idempotency_key, import_id, identity_hash, bundle_hash, packet_hash, sidecar_hash,
        source_version, target_repository, target_base, root_dir, staging_relative_path, state,
        canonical_bundle, transaction_witness, projection_digest, created_at, updated_at,
        execution_policy, campaign_manifest, campaign_manifest_hash, campaign_started_at, campaign_deadline_at
      ) VALUES (
        ${PROJECT}, ${`${linked.runId}:r1`}, ${importId}, ${digest}, ${digest}, ${digest}, ${digest},
        'v1', '/private/tmp/r2c-h1-target', ${"b".repeat(40)}, '/private/tmp/r2c-h1-root', 'stage', 'prepared',
        '{}'::jsonb, '{}'::jsonb, ${digest}, ${NOW}, ${NOW},
        '{}'::jsonb, '{}'::jsonb, ${digest}, ${NOW}, ${FAR}
      )
    `);
    await db.execute(sql`
      UPDATE project.ccc_planning_runs
         SET import_intent_digest = ${sha(`intent:${linked.runId}`)}, import_idempotency_key = ${`${linked.runId}:r1`},
             updated_at = ${NOW}
       WHERE project_id = ${PROJECT} AND run_id = ${linked.runId}
    `);
    await db.execute(sql`
      UPDATE project.ccc_planning_runs SET import_id = ${importId}, implementation_transferred = 5, updated_at = ${NOW}
       WHERE project_id = ${PROJECT} AND run_id = ${linked.runId}
    `);
    await db.execute(sql`
      UPDATE project.workflow_work_items SET state = 'succeeded', lease_owner = NULL, lease_expires_at = NULL
       WHERE project_id = ${PROJECT} AND id = ${linked.workItemId}
    `);
    await move(linked, ["building"]);
    const unlinked = await seedRun({ lease: "live" });
    const reconcileLinkedOutcome = vi.fn(async () => undefined);

    const withPorts = await recoverCccPlanningRuns({ store: harness.store, ports: { reconcileLinkedOutcome } });

    expect(reconcileLinkedOutcome).toHaveBeenCalledTimes(1);
    expect(reconcileLinkedOutcome.mock.calls[0]).toEqual([harness.store.getAsyncLayer(), linked.runId]);
    expect(reconcileLinkedOutcome.mock.calls.some((call) => (call as unknown[])[1] === unlinked.runId)).toBe(false);
    expect(outcomeOf(withPorts, linked)).toBe("campaign-reconciled");
    expect(outcomeOf(withPorts, unlinked)).toBe("none");

    const withoutPorts = await recoverCccPlanningRuns({ store: harness.store });
    expect(outcomeOf(withoutPorts, linked)).toBe("none");
    expect(await anchor(linked)).toMatchObject({ state: "building" });
  });

  /*
  FNXC:CccPlanningHost 2026-10-14-23:24 (W3 repair 1):
  The claim never ends with a failed or held planning work item behind a run that could still run, so a run is never
  stranded where nothing moves it again and an operator cancel waits forever. Each failure below is injected the way the
  review reproduced it on PostgreSQL; each asserts the run state, not only the item.
  */
  function plainStages(overrides: Partial<Record<CccPlanningIrStageId, CccPlanningStageFn>> = {}) {
    return Object.fromEntries(CCC_PLANNING_IR_STAGES.map((stageId) => [
      stageId, overrides[stageId] ?? (async (ctx: CccPlanningStageContext) => {
        await sealSpecReady(ctx);
        return { kind: "committed", artifactKeys: [] };
      }),
    ])) as Record<CccPlanningIrStageId, CccPlanningStageFn>;
  }

  /** The bound L1 port whose run reads fail on the chosen calls, like a dropped connection. */
  function flakyLedger(failOn: (read: number) => boolean): CccPlanningLedgerPort {
    const real = createCccPlanningLedgerPort(harness.layer);
    let reads = 0;
    return Object.freeze({
      ...real,
      inspectCccPlanningRun: (...args: Parameters<CccPlanningLedgerPort["inspectCccPlanningRun"]>) => {
        reads += 1;
        return failOn(reads)
          ? Promise.reject(new Error("ECONNRESET (simulated transient ledger read failure)"))
          : real.inspectCccPlanningRun(...args);
      },
    });
  }

  function operatorCancel(run: Pick<Run, "runId">) {
    return requestCccPlanningControl(harness.layer, { runId: run.runId, request: "cancel", actor: "operator" });
  }

  function workflowIdOf(run: Pick<Run, "runId">): string {
    return `${run.runId.replace(":", "-")}--workflow`;
  }

  it("H1 RED 16: one transient ledger read failure moves the run to failed before the item fails", async () => {
    const run = await seedRun({ lease: "expired" });
    // Reads 1-2 are preflight's boundary and post-stage reads, 3-4 intent's: the intent post-stage read fails.
    const result = await processRun(run, planningRuntime(plainStages(), flakyLedger((read) => read === 4)));

    expect(result.runtime?.reason ?? "").toContain("ECONNRESET");
    expect(await anchor(run)).toMatchObject({ state: "failed", state_code: "CCC_PLANNING_INTERNAL_ERROR", control_request: null });
    expect(await workItem(run)).toMatchObject({ state: "failed", lease_owner: null });
    // The run has ended, so there is nothing an operator cancel could be left waiting on.
    await expect(operatorCancel(run)).rejects.toMatchObject({ code: "CCC_PLANNING_RUN_TERMINAL" });
  });

  it("H1 RED 16b: when L1 cannot be reached to fail the run, the item is released and a later operator cancel completes", async () => {
    const run = await seedRun({ lease: "expired" });
    // The processor's own L1 reads and moves fail too, so it cannot conclude the failure on this claim.
    const unreachable = new Proxy(harness.store, {
      get(target, key) {
        if (key === "inspectCccPlanningRun" || key === "transitionCccPlanningRunState") {
          return async () => { throw new Error("ECONNRESET (ledger unreachable)"); };
        }
        const value = Reflect.get(target, key, target) as unknown;
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });

    const first = await processRun(run, planningRuntime(plainStages(), flakyLedger((read) => read === 4)), unreachable);

    expect(first.claimed).toBe(true);
    expect(await anchor(run)).toMatchObject({ state: "running", control_request: null });
    expect(await workItem(run)).toMatchObject({ state: "runnable", attempt: 1, lease_owner: null });

    const cancel = await operatorCancel(run);
    expect(cancel.appliedDirectly).toBe(false);
    const { stages, calls } = recordingStages();
    const second = await processRun(run, planningRuntime(stages));

    expect(second.claimed).toBe(true);
    expect(calls).toEqual([]);
    expect(await anchor(run)).toMatchObject({ state: "cancelled" });
    expect(await workItem(run)).toMatchObject({ state: "cancelled", lease_owner: null });
  });

  it("H1 RED 17: a stored workflow IR that no longer parses fails the run with WORKFLOW_IR_DRIFT", async () => {
    const run = await seedRun({ lease: "expired" });
    await db.execute(sql`
      UPDATE project.workflows SET ir = to_jsonb(${"{\"version\":\"v2\",\"nodes\":"}::text)
       WHERE project_id = ${PROJECT} AND id = ${workflowIdOf(run)}
    `);
    const { stages, entered } = recordingStages();

    const result = await processRun(run, planningRuntime(stages));

    expect(result.runtime?.reason ?? "").toContain("workflow-resolution-error");
    expect(entered).toEqual([]);
    expect(await anchor(run)).toMatchObject({ state: "failed", state_code: "CCC_PLANNING_WORKFLOW_IR_DRIFT" });
    expect(await workItem(run)).toMatchObject({ state: "failed", lease_owner: null });
    await expect(operatorCancel(run)).rejects.toMatchObject({ code: "CCC_PLANNING_RUN_TERMINAL" });
  });

  it("H1 RED 17b: a deleted workflow definition fails the run with WORKFLOW_IR_DRIFT", async () => {
    const run = await seedRun({ lease: "expired" });
    await db.execute(sql`DELETE FROM project.workflows WHERE project_id = ${PROJECT} AND id = ${workflowIdOf(run)}`);
    const { stages, entered } = recordingStages();

    const result = await processRun(run, planningRuntime(stages));

    expect(result.runtime?.reason ?? "").toContain("workflow-missing");
    expect(entered).toEqual([]);
    expect(await anchor(run)).toMatchObject({ state: "failed", state_code: "CCC_PLANNING_WORKFLOW_IR_DRIFT" });
    expect(await workItem(run)).toMatchObject({ state: "failed", lease_owner: null });
    await expect(operatorCancel(run)).rejects.toMatchObject({ code: "CCC_PLANNING_RUN_TERMINAL" });
  });

  it("H1 RED 18: a refused awaiting-intent park fails the run instead of holding the item behind a running run", async () => {
    const run = await seedRun({ lease: "expired" });
    // No decision_request artifact exists, so L1 refuses running -> awaiting_intent (STATE_TRANSITION_REFUSED).
    const stages = plainStages({ intent: async () => ({ kind: "awaiting-intent", decisionId: "d".repeat(64) }) });

    const result = await processRun(run, planningRuntime(stages));

    expect(result.runtime?.disposition).toBe("failed");
    expect(await anchor(run)).toMatchObject({ state: "failed", state_code: "CCC_PLANNING_INTERNAL_ERROR" });
    expect(await workItem(run)).toMatchObject({ state: "failed", lease_owner: null });
    await expect(operatorCancel(run)).rejects.toMatchObject({ code: "CCC_PLANNING_RUN_TERMINAL" });
  });

  it("H1 RED 19: an operator cancel landing between the park and the item release ends cancelled without a restart", async () => {
    const run = await seedRun({ lease: "expired" });
    const real = createCccPlanningLedgerPort(harness.layer);
    let cancel: Awaited<ReturnType<typeof operatorCancel>> | undefined;
    const racing: CccPlanningLedgerPort = Object.freeze({
      ...real,
      transitionCccPlanningRunState: async (i: Parameters<CccPlanningLedgerPort["transitionCccPlanningRunState"]>[0]) => {
        const moved = await real.transitionCccPlanningRunState(i);
        // `fn plan cancel`, after the park committed and before the processor holds the item: L1 defers live-lease.
        if (i.to === "blocked_prerequisite") cancel = await operatorCancel(run);
        return moved;
      },
    });
    const stages = plainStages({
      preflight: async () => ({ kind: "blocked", state: "blocked_prerequisite", code: "CCC_PLANNING_SANDBOX_UNAVAILABLE" }),
    });

    await processRun(run, planningRuntime(stages, racing));

    expect(cancel).toMatchObject({ appliedDirectly: true });
    expect(await anchor(run)).toMatchObject({ state: "cancelled" });
    expect(await workItem(run)).toMatchObject({ state: "cancelled", lease_owner: null });
  });

  /*
  FNXC:CccPlanningHost 2026-10-15-00:04 (W3 repair 2, E14 item 1):
  The planning claim is total. Before this repair a throw from the processor's own run lookup, its getTask read or its
  `held` write reached the shared catch, which failed the item and left the run running (or resting) where nothing
  moves it again: an operator cancel then stayed pending forever. Each case injects one transient failure the way the
  reviewers reproduced it and follows the run to an end an operator can see.
  */
  function proxiedStore(override: (key: PropertyKey) => unknown): PgTestHarness["store"] {
    return new Proxy(harness.store, {
      get(target, key) {
        const replaced = override(key);
        if (replaced !== undefined) return replaced;
        const value = Reflect.get(target, key, target) as unknown;
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
  }

  async function stateEventCount(run: Pick<Run, "runId">): Promise<number> {
    const rows = (await db.execute(sql`
      SELECT count(*)::int AS n FROM project.run_audit_events
       WHERE project_id = ${PROJECT} AND run_id = ${run.runId} AND mutation_type = 'ccc-planning:state'
    `)) as unknown as Array<{ n: number }>;
    return rows[0]!.n;
  }

  it("H1 RED 20: a run lookup that throws once releases the item to runnable and a later operator cancel completes", async () => {
    const run = await seedRun({ lease: "expired" });
    let failures = 0;
    const flaky = proxiedStore((key) => key === "getCccPlanningRunForTask"
      ? async (taskId: string) => {
        failures += 1;
        if (failures === 1) throw new Error("ECONNRESET (simulated transient run lookup failure)");
        return getCccPlanningRunForTask(harness.layer, taskId);
      }
      : undefined);
    const { stages, entered } = recordingStages();

    const first = await processRun(run, planningRuntime(stages), flaky);

    expect(first.claimed).toBe(true);
    expect(first.runtime?.reason ?? "").toContain("ECONNRESET");
    expect(entered).toEqual([]);
    expect(await anchor(run)).toMatchObject({ state: "running", control_request: null });
    expect(await workItem(run)).toMatchObject({ state: "runnable", attempt: 1, lease_owner: null });

    const cancel = await operatorCancel(run);
    expect(cancel.appliedDirectly).toBe(false);
    const second = await processRun(run, planningRuntime(stages));

    expect(second.claimed).toBe(true);
    expect(entered).toEqual([]);
    expect(await anchor(run)).toMatchObject({ state: "cancelled" });
    expect(await workItem(run)).toMatchObject({ state: "cancelled", lease_owner: null });
  });

  it("H1 RED 21: a getTask read that throws once concludes the run under the lease, never a failed item behind a running run", async () => {
    const run = await seedRun({ lease: "expired" });
    let failures = 0;
    const flaky = proxiedStore((key) => key === "getTask"
      ? async (taskId: string) => {
        failures += 1;
        if (failures === 1) throw new Error("ECONNRESET (simulated transient getTask failure)");
        return harness.store.getTask(taskId);
      }
      : undefined);
    const { stages, entered } = recordingStages();

    const result = await processRun(run, planningRuntime(stages), flaky);

    expect(result.claimed).toBe(true);
    expect(result.runtime?.reason ?? "").toContain("ECONNRESET");
    expect(entered).toEqual([]);
    expect(await anchor(run)).toMatchObject({ state: "failed", state_code: "CCC_PLANNING_INTERNAL_ERROR", control_request: null });
    expect(await workItem(run)).toMatchObject({ state: "failed", lease_owner: null });
    // The run has ended, so no operator cancel is left waiting on it.
    await expect(operatorCancel(run)).rejects.toMatchObject({ code: "CCC_PLANNING_RUN_TERMINAL" });
  });

  it("H1 RED 22: a held write that fails once leaves the item leased, the next claim re-holds it and a cancel completes", async () => {
    const run = await seedRun({ lease: "expired" });
    let failures = 0;
    const flaky = proxiedStore((key) => key === "transitionWorkflowWorkItem"
      ? async (...args: Parameters<PgTestHarness["store"]["transitionWorkflowWorkItem"]>) => {
        if (args[1] === "held") {
          failures += 1;
          if (failures === 1) throw new Error("ECONNRESET (simulated transient held write failure)");
        }
        return harness.store.transitionWorkflowWorkItem(...args);
      }
      : undefined);
    const stages = plainStages({
      preflight: async () => ({ kind: "blocked", state: "blocked_prerequisite", code: "CCC_PLANNING_SANDBOX_UNAVAILABLE" }),
    });

    await processRun(run, planningRuntime(stages), flaky);

    expect(await anchor(run)).toMatchObject({ state: "blocked_prerequisite", state_code: "CCC_PLANNING_SANDBOX_UNAVAILABLE" });
    // Never failed: the item stays leased until its lease expires and the acquire path reclaims it.
    expect(await workItem(run)).toMatchObject({ state: "running", attempt: 1, lease_owner: LIVE_ENGINE });

    await expireLease(run);
    const { stages: again, entered } = recordingStages();
    const second = await processRun(run, planningRuntime(again));
    expect(second.claimed).toBe(true);
    expect(entered).toEqual([]);
    expect(await workItem(run)).toMatchObject({ state: "held", attempt: 1, lease_owner: null });

    await operatorCancel(run);
    expect(await anchor(run)).toMatchObject({ state: "cancelled" });
    expect(await workItem(run)).toMatchObject({ state: "cancelled", lease_owner: null });
  });

  /*
  FNXC:CccPlanningHost 2026-10-15-00:04 (W3 repair 2, E14 item 2, D45):
  The success twin of RED 19. In a Spec run the last stage moves the run to spec_ready; an operator cancel that lands
  before the item's `succeeded` write is applied directly (spec_ready -> cancelling) and deferred live-lease by L1.
  After the write the host asks L1 to complete it, so the run ends cancelled, not cancelling until a restart.
  */
  it("H1 RED 23: an operator cancel racing the final succeeded write ends cancelled, not cancelling", async () => {
    const run = await seedRun({ lease: "expired", mode: "spec" });
    let cancel: Awaited<ReturnType<typeof operatorCancel>> | undefined;
    const racing = proxiedStore((key) => key === "transitionWorkflowWorkItem"
      ? async (...args: Parameters<PgTestHarness["store"]["transitionWorkflowWorkItem"]>) => {
        if (args[1] === "succeeded" && cancel === undefined) cancel = await operatorCancel(run);
        return harness.store.transitionWorkflowWorkItem(...args);
      }
      : undefined);

    const result = await processRun(run, planningRuntime(plainStages()), racing);

    expect(result.runtime?.disposition).toBe("completed");
    expect(cancel).toMatchObject({ appliedDirectly: true });
    expect(await anchor(run)).toMatchObject({ state: "cancelled", control_request: null });
    expect(await workItem(run)).toMatchObject({ state: "succeeded", lease_owner: null });
  });

  it("H1 control: the same Spec run without the race ends spec_ready with the item succeeded", async () => {
    const run = await seedRun({ lease: "expired", mode: "spec" });

    const result = await processRun(run, planningRuntime(plainStages()));

    expect(result.runtime?.disposition).toBe("completed");
    expect(await anchor(run)).toMatchObject({ state: "spec_ready", control_request: null });
    expect(await workItem(run)).toMatchObject({ state: "succeeded", lease_owner: null });
  });

  /*
  FNXC:CccPlanningHost 2026-10-15-00:04 (W3 repair 2, E14 item 4):
  The positive control for RED 18. With a published decision_request, L1 admits the park; the run rests in
  awaiting_intent with the state code section 2.3 requires, CCC_PLANNING_AWAITING_INTENT.
  */
  it("H1 RED 18c: an admitted awaiting-intent park rests the run with CCC_PLANNING_AWAITING_INTENT and holds the item", async () => {
    const run = await seedRun({ lease: "live" });
    const key = "cccplan-r001-intent-question1-v01";
    const content = JSON.stringify({ schema: "ccc-planning.decision-request.v1", question: "which target branch?" });
    const metadata = {
      schema: "ccc-planning.artifact-envelope.v1", artifactKey: key, runId: run.runId, runRevision: 1, stageId: "intent",
      slot: "question1", version: 1, kind: "decision_request", contentType: "application/json",
      contentSchema: "ccc-planning.decision-request.v1", inputs: [],
      producer: { kind: "controller", roleId: "controller", instanceId: "controller:1" },
      policy: { promptVersion: "none", promptDigest: "none", toolPolicyVersion: "none", toolPolicyDigest: "none" },
      outputDigest: sha(content), status: "complete",
      fence: { kind: "work_item_lease", workItemId: run.workItemId, leaseOwner: run.fence.leaseOwner, attempt: 1, runId: run.runId },
      identityDigest: sha(`identity:${run.runId}:${key}`), publishedAt: NOW,
    };
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('fusion.ccc_planning_publication', 'on', true)`);
      await tx.execute(sql`
        INSERT INTO project.task_documents
          (project_id, id, task_id, key, content, revision, author, metadata, created_at, updated_at)
        VALUES (${PROJECT}, ${`doc-${run.taskId}-${key}`}, ${run.taskId}, ${key}, ${content}, 1,
                'ccc-planning:controller', ${JSON.stringify(metadata)}::jsonb, ${NOW}, ${NOW})
      `);
    });
    await expireLease(run);
    const decisionId = cccPlanningDecisionId({ revision: 1, questionDigest: sha(content) });
    const stages = plainStages({ intent: async () => ({ kind: "awaiting-intent", decisionId }) });

    const result = await processRun(run, planningRuntime(stages));

    expect(result.runtime?.disposition).toBe("manual-required");
    expect(await anchor(run)).toMatchObject({ state: "awaiting_intent", state_code: "CCC_PLANNING_AWAITING_INTENT" });
    const rows = (await db.execute(sql`
      SELECT r.awaiting_decision_id, w.state, w.lease_owner, w.blocked_reason
        FROM project.ccc_planning_runs r JOIN project.workflow_work_items w
          ON w.project_id = r.project_id AND w.id = ${run.workItemId}
       WHERE r.project_id = ${PROJECT} AND r.run_id = ${run.runId}
    `)) as unknown as Row[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ awaiting_decision_id: decisionId, state: "held", lease_owner: null });
    expect(String(rows[0]!.blocked_reason)).toContain(decisionId);
    expect(await stateEventCount(run)).toBe(1);
  });

  // Last in the file: run A stays running with a pending pause, which every later recovery would report as failed.
  it("H1 RED 15: one run refused at engine start does not stop recovery of the runs after it", async () => {
    // A sorts first: running, a dispatched_unknown call, an operator pause recorded as pending, lease expired.
    const refused = await seedRun({ lease: "live", label: "r2c-h1-isolation-refused-4" });
    await dispatchUnsettledCall(refused);
    await requestCccPlanningControl(harness.layer, { runId: refused.runId, request: "pause", actor: "operator" });
    await expireLease(refused);
    // B sorts later: cancelling with an expired lease, which recovery must complete (D45).
    const cancelling = await seedRun({ path: ["running", "cancelling"], lease: "expired", label: "r2c-h1-isolation-cancelling-4" });
    expect(refused.runId < cancelling.runId).toBe(true);

    const recovery = await recoverCccPlanningRuns({ store: harness.store }).then(
      (results) => ({ results, error: undefined as unknown }),
      (error: unknown) => ({ results: undefined, error }),
    );

    expect(recovery.error).toBeInstanceOf(AggregateError);
    expect((recovery.error as AggregateError).message).toContain(refused.runId);
    expect((recovery.error as AggregateError).errors).toHaveLength(1);
    expect((recovery.error as AggregateError).errors[0]).toMatchObject({ code: "CCC_PLANNING_CONTROL_PENDING" });
    expect(await anchor(cancelling)).toMatchObject({ state: "cancelled" });
    expect(await workItem(cancelling)).toMatchObject({ state: "cancelled", lease_owner: null });
    expect(await anchor(refused)).toMatchObject({ state: "running", control_request: "pause" });
  });
});
