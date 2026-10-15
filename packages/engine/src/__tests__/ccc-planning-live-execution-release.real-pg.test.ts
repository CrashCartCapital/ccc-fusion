/**
 * FNXC:CccPlanningLiveRelease 2026-10-15-05:30:
 * AU2 releases the existing sealed campaign gate only inside the consumed operator receipt. Real PostgreSQL import,
 * IM1 link, approval rows, fenced artifact publication and state events make replay and refusal assertions observable.
 * No provider is contacted: imports use the native deterministic admission fixture and never dispatch a work item.
 */
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import {
  canonicalCccPrdJson,
  cccPlanningImportKey,
  cccPlanningRunId,
  computeCccPlanningAuthorityReceiptDigest,
  drizzleSql as sql,
  importCccPrdBundle,
  inspectCccPrdProductStatus,
  linkCccPlanningImport,
  publishCccPlanningArtifact,
  recordCccPlanningImportIntent,
  type CccPlanningArtifactRef,
  type CccPlanningImportClosure,
  type CccPlanningLiveAuthorityReceiptV1,
  type CccPlanningWorkItemFence,
} from "@fusion/core";
import {
  admitCccPrdImportTestProductBundle,
  createCccPrdImportTestProductBundle,
  createCccPrdImportTestProductExecutionPolicy,
  rehashCccPrdImportTestBundle,
} from "../../../core/src/__test-utils__/ccc-prd-import-fixture.js";
import { createSharedPgTaskStoreTestHarness, pgDescribe } from "../../../core/src/__test-utils__/pg-test-harness.js";
import { cccPlanningRuns } from "../../../core/src/postgres/schema/ccc-planning.js";
import { releaseCccPlanningLiveExecution } from "../ccc-planning/live-execution-release.js";

const execFile = promisify(execFileCallback);
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const POLICY = { promptVersion: "none", promptDigest: "none", toolPolicyVersion: "none", toolPolicyDigest: "none" } as const;
const SUITE = "ccc planning live-execution release (card AU2, PostgreSQL)";

pgDescribe(SUITE, () => {
  const h = createSharedPgTaskStoreTestHarness({ prefix: "fusion_ccc_planning_au2" });
  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterAll(h.afterAll);

  async function fixture(options: { release?: "controller_within_receipt" | "operator_confirm_after_import" | "absent";
    modelId?: string } = {}) {
    const rootDir = await realpath(h.rootDir());
    await execFile("git", ["init", "--initial-branch=main", rootDir]);
    await execFile("git", ["-C", rootDir, "config", "user.name", "Fusion Test"]);
    await execFile("git", ["-C", rootDir, "config", "user.email", "fusion-test@example.invalid"]);
    await execFile("git", ["-C", rootDir, "commit", "--allow-empty", "-m", "admitted base"]);
    const base = (await execFile("git", ["-C", rootDir, "rev-parse", "HEAD"])).stdout.trim();
    await execFile("git", ["-C", rootDir, "commit", "--allow-empty", "-m", "verifier baseline"]);
    const baseline = (await execFile("git", ["-C", rootDir, "rev-parse", "HEAD"])).stdout.trim();
    const now = new Date().toISOString();
    const deadlineAt = new Date(Date.now() + 3_600_000).toISOString();
    const source = rehashCccPrdImportTestBundle({
      ...createCccPrdImportTestProductBundle(rootDir, "AU2"),
      targetRepository: { path: rootDir, baseCommit: baseline },
    });
    const admitted = await admitCccPrdImportTestProductBundle(source, "AU2");
    const bundle = admitted.bundle;
    const policy = createCccPrdImportTestProductExecutionPolicy(bundle);
    const executionPolicy = { ...policy, routes: policy.routes.map((route) => ({
      ...route, providerId: "receipt-flash", modelId: options.modelId ?? "glm/glm-5.3-flash",
    })) };
    const projectId = h.layer().projectId || "__legacy_unscoped__";
    const receiptWithoutConfirmation: Omit<CccPlanningLiveAuthorityReceiptV1, "operatorConfirmation"> = {
      schema: "ccc-planning.live-authority-receipt.v1", receiptId: "au2-test-receipt", issuedAt: now, notBefore: now,
      expiresAt: deadlineAt, operator: { actorId: "au2-operator", actorName: "AU2 operator" }, project: { projectId },
      target: { class: "owned_disposable", scratchRoot: rootDir.slice(0, rootDir.lastIndexOf("/")),
        repositoryRealpath: rootDir, baseCommit: base, baseTree: base,
        ownershipMarker: { path: `${rootDir}/../owner.json`, sha256: sha("owner") }, remotes: [], admittedFusionPaths: ["proof/**"] },
      request: { sha256: sha("AU2 request"), byteLength: 11 }, mode: "build", profile: "full-v2", budgetProfile: "standard",
      budgetPolicyVersion: "ccc-planning.budget-policy.v1", largeAuthorized: false,
      phaseCallCaps: { planning: 1536, implementation: 3072, reviewProof: 512 }, deadlineAt,
      models: { glm53: "glm/glm-5.3", glm53Flash: "glm/glm-5.3-flash", minimaxM3: "minimax/MiniMax-M3" },
      omniRoute: { baseUrl: "http://127.0.0.1:1", receiptAdapterId: "terminal-route-sse-comments.v1",
        providerIds: { glm53: "receipt-glm", glm53Flash: "receipt-flash", minimaxM3: "receipt-minimax" } },
      quota: { accounting: "subscription_unknown", meteredFallback: "forbidden" }, escalation: "forbidden",
      permittedProtectedActions: options.release === "absent" ? [] : [{ kind: "live_execution",
        release: options.release ?? "controller_within_receipt" }],
      sourceToolPolicy: { policyId: "test-policy", sha256: sha("tools") },
      runtime: { installedRuntimeReceiptSha256: sha("runtime"), packageVersion: "test", distManifestSha256: sha("dist") },
    };
    const receipt = { ...receiptWithoutConfirmation,
      operatorConfirmation: computeCccPlanningAuthorityReceiptDigest(receiptWithoutConfirmation) };
    const receiptSha256 = sha(canonicalCccPrdJson(receipt));
    const runId = cccPlanningRunId({ projectId, requestDigest: receipt.request.sha256, receiptSha256 });
    const key = cccPlanningImportKey(runId, 1);
    const planningTaskId = "AU2-PLAN";
    const planningWorkItemId = "AU2-PLAN-WORK";
    const leaseOwner = "au2-planning-host";
    await h.layer().db.execute(sql`
      INSERT INTO project.tasks (project_id, id, description, "column", created_at, updated_at)
      VALUES (${projectId}, ${planningTaskId}, 'AU2 planning task', 'todo', ${now}, ${now})
    `);
    await h.layer().db.insert(cccPlanningRuns).values({
      projectId, runId, planningTaskId, mode: "build", budgetProfile: "standard", roleProfile: "full-v2",
      policyVersion: "ccc-planning.budget-policy.v1", policyDigest: sha("policy"), requestDigest: receipt.request.sha256,
      requestBytes: 11, targetRepository: rootDir, admittedBase: base, grantDigest: sha("grant"),
      authorityReceiptSha256: receiptSha256, authorityReceiptJson: canonicalCccPrdJson(receipt),
      runtimeDistManifestSha256: sha("dist"), state: "admitted", deadlineAt,
      planningAllocation: 1536, implementationAllocation: 3072, reviewProofAllocation: 512,
      researchFetchAllocation: 5, researchBytesAllocation: 1_048_576, createdAt: now, updatedAt: now,
    });
    await h.layer().db.execute(sql`
      INSERT INTO project.workflow_work_items
        (project_id, id, run_id, task_id, node_id, kind, state, attempt, lease_owner, lease_expires_at, created_at, updated_at)
      VALUES (${projectId}, ${planningWorkItemId}, ${runId}, ${planningTaskId}, 'import', 'task', 'running', 1,
        ${leaseOwner}, ${deadlineAt}, ${now}, ${now})
    `);
    for (const state of ["running", "spec_ready", "importing"]) {
      await h.layer().db.execute(sql`UPDATE project.ccc_planning_runs SET state = ${state}
        WHERE project_id = ${projectId} AND run_id = ${runId}`);
    }
    const fence: CccPlanningWorkItemFence = { kind: "planning", workItemId: planningWorkItemId,
      runId, attempt: 1, leaseOwner, originTaskId: planningTaskId };
    const common = { planningTaskId, runId, inputs: [], producer: { kind: "controller", roleId: "controller",
      instanceId: key }, policy: POLICY, status: "complete", fence: { kind: "work_item_lease",
        workItemId: planningWorkItemId, runId, attempt: 1, leaseOwner } } as const;
    const limits = { ...bundle.bounds, maxConcurrency: 1 as const, boundsComputedAt: now, clamps: [] };
    await publishCccPlanningArtifact(h.layer(), { ...common,
      slot: { runRevision: 1, stageId: "import", slot: "facts", version: 1 }, kind: "admission_facts",
      contentSchema: "ccc-planning.admission-facts.v1", content: { type: "json", value: { bounds: limits } } });
    await publishCccPlanningArtifact(h.layer(), { ...common,
      slot: { runRevision: 1, stageId: "import", slot: "bundle", version: 1 }, kind: "bundle",
      contentSchema: "ccc-prd.bundle.v2", content: { type: "json", value: bundle } });
    const ref = (label: string): CccPlanningArtifactRef => ({ artifactKey: `cccplan-r001-import-${label}-v01`, digest: sha(label) });
    const closure = Object.fromEntries(["originalRequest", "admissionGrant", "buildGrant", "buildTransition", "acceptanceCases",
      "requirementMap", "finalPrd", "technicalAnnex", "taskPlan", "routingPlan", "verifierBundle", "oracleAudit",
      "finalAdjudication"].map((name) => [name, ref(name.toLowerCase())])) as CccPlanningImportClosure;
    await recordCccPlanningImportIntent(h.layer(), { runId, fence, intent: {
      schema: "ccc-planning.import-intent.v1", runId, runRevision: 1, idempotencyKey: key,
      bundleHash: bundle.bundleHash, packetHash: bundle.sourceHash, sidecarHash: bundle.sidecarHash,
      executionPolicyDigest: sha(canonicalCccPrdJson(executionPolicy)), targetRepository: rootDir, targetBase: baseline,
      targetHead: baseline, baselineBranchRef: `refs/heads/fusion/r2c-${runId.slice(9)}-r001-baseline`,
      buildTransitionRef: closure.buildTransition, limits, closure, closureDigest: sha("closure"), receiptSha256,
    } });
    const imported = await importCccPrdBundle({ bundle, executionPolicy, idempotencyKey: key, store: h.store(),
      layer: h.layer(), rootDir, semanticProofToolchainPaths: admitted.semanticProofToolchainPaths });
    await linkCccPlanningImport(h.layer(), { runId, fence, release: "awaiting_operator" });
    const status = await inspectCccPrdProductStatus({ idempotencyKey: key, layer: h.layer(), rootDir });
    if (!status) throw new Error("import status missing");
    const entryTaskId = status.tasks[0]!.nativeTaskId;
    const workItemId = `${imported.importId}--WORK-AU2`;
    await h.layer().db.execute(sql`UPDATE project.workflow_work_items SET state = 'manual-required',
      last_error = 'ccc-permanent:CCC_CAMPAIGN_LIVE_EXECUTION_APPROVAL_REQUIRED',
      blocked_reason = 'ccc-permanent:CCC_CAMPAIGN_LIVE_EXECUTION_APPROVAL_REQUIRED'
      WHERE project_id = ${projectId} AND id = ${workItemId}`);
    const input = { store: h.store(), rootDir, entryTaskId, receipt, receiptSha256,
      run: { runId, runRevision: 1, deadlineAt, implementationCallsRemaining: 3072,
        compiledProviderTaskCount: bundle.tasks.length, writerProviderId: "receipt-flash" },
      observeBaseline: async (commit: string) => ({ commit, firstParent: base, changedPaths: [] }) };
    return { input, importId: imported.importId, planningTaskId, workItemId, planningWorkItemId };
  }

  async function facts(f: Awaited<ReturnType<typeof fixture>>) {
    const row = (await h.layer().db.execute(sql`SELECT
      (SELECT count(*)::int FROM project.ccc_campaign_execution_authorizations WHERE import_id = ${f.importId}) AS parents,
      (SELECT count(*)::int FROM project.approval_requests WHERE campaign_import_id = ${f.importId} AND status = 'claimed') AS claimed,
      (SELECT count(*)::int FROM project.approval_requests WHERE campaign_import_id = ${f.importId}
        AND status IN ('approved', 'claimed', 'consumed')) AS authorized,
      (SELECT active_action_leases FROM project.ccc_prd_imports WHERE import_id = ${f.importId}) AS leases,
      (SELECT count(*)::int FROM project.task_documents WHERE task_id = ${f.planningTaskId}
        AND metadata->>'kind' = 'live_execution_release') AS releases,
      (SELECT count(*)::int FROM project.run_audit_events WHERE run_id = ${f.input.run.runId}
        AND mutation_type = 'ccc-planning:live-execution-released') AS audits,
      (SELECT count(*)::int FROM project.run_audit_events WHERE run_id = ${f.input.run.runId}
        AND mutation_type = 'ccc-planning:state' AND metadata->>'to' = 'building') AS transitions,
      (SELECT state FROM project.ccc_planning_runs WHERE run_id = ${f.input.run.runId}) AS state,
      (SELECT state FROM project.workflow_work_items WHERE id = ${f.workItemId}) AS work_state
    `))[0];
    return row;
  }

  it("releases an exact controller envelope with a system actor and one durable release, then replays unchanged", async () => {
    const f = await fixture();
    const result = await releaseCccPlanningLiveExecution(f.input);
    expect(result).toMatchObject({ kind: "released", authorizationId: expect.any(String), authorizationDigest: expect.any(String) });
    expect(await facts(f)).toMatchObject({ parents: 1, claimed: 2, releases: 1, audits: 1, transitions: 1,
      state: "building", work_state: "runnable" });
    const claims = await h.layer().db.execute(sql`SELECT actor_id, actor_type, actor_name
      FROM project.approval_request_audit_events WHERE event_type = 'claimed' AND request_id IN
        (SELECT id FROM project.approval_requests WHERE campaign_import_id = ${f.importId})`);
    expect(claims).toHaveLength(2);
    const actor = { actor_id: "ccc-planning-controller", actor_type: "system",
      actor_name: `CCC planning receipt ${f.input.receiptSha256.slice(0, 12)}` };
    expect(claims).toEqual([actor, actor]);
    expect(await releaseCccPlanningLiveExecution(f.input)).toEqual(result);
    expect(await facts(f)).toMatchObject({ parents: 1, claimed: 2, releases: 1, audits: 1, transitions: 1 });
  });

  it("refuses a MiniMax member without a claimed approval or release; an exact Flash member releases", async () => {
    const f = await fixture({ modelId: "minimax/MiniMax-M3" });
    expect(await releaseCccPlanningLiveExecution(f.input)).toMatchObject({ kind: "awaiting_operator", reason: "envelope_mismatch",
      authorizationId: expect.stringMatching(/^ccc-execution-authorization-/u), confirmation: expect.stringMatching(/^[a-f0-9]{64}$/u),
      mismatch: { field: "authorization.members[0].modelId" } });
    expect(await facts(f)).toMatchObject({ claimed: 0, authorized: 0, leases: {}, releases: 0, audits: 0, transitions: 0,
      state: "awaiting_execution_authority", work_state: "manual-required" });
    await h.beforeEach();
    expect((await releaseCccPlanningLiveExecution((await fixture()).input)).kind).toBe("released");
  });

  for (const release of ["absent", "operator_confirm_after_import"] as const) {
    it(`requires the operator when the receipt release is ${release}`, async () => {
      const f = await fixture({ release });
      expect(await releaseCccPlanningLiveExecution(f.input)).toMatchObject({ kind: "awaiting_operator",
        reason: "receipt_requires_operator", authorizationId: expect.stringMatching(/^ccc-execution-authorization-/u),
        confirmation: expect.stringMatching(/^[a-f0-9]{64}$/u) });
      expect(await facts(f)).toMatchObject({ claimed: 0, authorized: 0, leases: {}, releases: 0, audits: 0, transitions: 0,
        state: "awaiting_execution_authority", work_state: "manual-required" });
      await h.beforeEach();
      expect((await releaseCccPlanningLiveExecution((await fixture()).input)).kind).toBe("released");
    });
  }

  for (const crash of ["issued", "approved", "published"] as const) {
    it(`replays a crash after ${crash} to one sealed approval, one artifact and one state transition`, async () => {
      const f = await fixture();
      let crashed = false;
      const afterStep = async (step: string) => {
        if (step === crash && !crashed) { crashed = true; throw new Error(`AU2 crash after ${crash}`); }
      };
      await expect(releaseCccPlanningLiveExecution({ ...f.input, hooks: { afterStep } }))
        .rejects.toThrow(`AU2 crash after ${crash}`);
      const result = await releaseCccPlanningLiveExecution({ ...f.input, hooks: { afterStep } });
      expect(result.kind).toBe("released");
      expect(await facts(f)).toMatchObject({ parents: 1, claimed: 2, releases: 1, audits: 1, transitions: 1,
        state: "building", work_state: "runnable" });
    });
  }
});
