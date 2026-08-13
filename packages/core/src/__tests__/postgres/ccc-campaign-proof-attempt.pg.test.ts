import { sql } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  beginCccCampaignProofAttemptDispatch,
  canonicalCccPrdJson,
  computeCccPrdProofDefinitionSha256,
  createCccCampaignAuthorityBinding,
  importCccPrdBundle,
  inspectCccCampaignProofAttempt,
  listCccCampaignProofAttemptsForCommit,
  reserveCccCampaignProofAttempt,
  settleCccCampaignProofAttempt,
} from "../../index.js";
import {
  createAdmittedCccPrdImportTestProductFixture,
  createCccPrdImportTestBundle,
  createCccPrdImportTestExecutionPolicy,
  createCccPrdImportTestProductBundle,
  createCccPrdImportTestProductExecutionPolicy,
  rehashCccPrdImportTestBundle,
} from "../../__test-utils__/ccc-prd-import-fixture.js";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";

const COMMIT_A = "a".repeat(40);
const TREE_A = "b".repeat(40);
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

async function expectPgConstraint(
  promise: Promise<unknown>,
  matcher: RegExp,
): Promise<void> {
  let rejection: unknown;
  try {
    await promise;
  } catch (error) {
    rejection = error;
  }
  if (rejection === undefined) {
    throw new Error(`Expected PostgreSQL refusal matching ${matcher}`);
  }
  const failure = rejection as Error & { cause?: Error };
  expect(`${failure.message} ${failure.cause?.message ?? ""}`).toMatch(matcher);
}

pgDescribe("CCC campaign proof-attempt receipts (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_ccc_proof_attempt",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  async function nativeTaskIdForImport(
    importId: string,
    semanticTaskId: string,
  ): Promise<string> {
    const rows = await h.layer().db.execute(sql`
      SELECT native_id
      FROM project.ccc_prd_import_entities
      WHERE import_id = ${importId}
        AND entity_type = 'task'
        AND entity_id = ${semanticTaskId}
    `) as unknown as Array<{ native_id: string }>;
    expect(rows).toHaveLength(1);
    return rows[0]!.native_id;
  }

  async function campaign(suffix: string) {
    const source = createCccPrdImportTestProductBundle(h.rootDir(), suffix);
    const imported = await importCccPrdBundle({
      bundle: source,
      idempotencyKey: `proof-attempt-${suffix}`,
      store: h.store(),
      layer: h.layer(),
      rootDir: h.rootDir(),
      executionPolicy: createCccPrdImportTestExecutionPolicy(source),
    });
    const semanticTaskId = `TASK-${suffix}`;
    const taskId = await nativeTaskIdForImport(imported.importId, semanticTaskId);
    expect(taskId).not.toBe(semanticTaskId);
    return {
      source,
      semanticTaskId,
      taskId,
      proof: source.proofs[0]!,
    };
  }

  async function semanticV2Campaign(suffix: string) {
    const fixture = await createAdmittedCccPrdImportTestProductFixture(
      h.rootDir(),
      suffix,
    );
    const source = fixture.bundle;
    const imported = await importCccPrdBundle({
      bundle: source,
      idempotencyKey: `proof-attempt-v2-${suffix}`,
      store: h.store(),
      layer: h.layer(),
      rootDir: h.rootDir(),
      executionPolicy: createCccPrdImportTestProductExecutionPolicy(source),
      semanticProofToolchainPaths: fixture.semanticProofToolchainPaths,
    });
    const semanticTaskId = source.tasks[0]!.id;
    const taskId = await nativeTaskIdForImport(imported.importId, semanticTaskId);
    const campaign = await h.store().getCccCampaignContextForTask(taskId);
    if (!campaign) throw new Error(`missing semantic-v2 campaign context for ${taskId}`);
    const proof = source.proofs.find((candidate) =>
      source.tasks[0]!.proofIds.includes(candidate.id) &&
      candidate.phases.includes("task"));
    if (!proof) throw new Error(`missing task proof for ${semanticTaskId}`);
    const custody = {
      verifierClosureSha256: proof.admission.verifierClosureSha256,
      candidateInputsSha256: proof.admission.candidateInputsSha256,
      executionToolchainSha256: proof.admission.executionToolchainSha256,
    } as const;
    const finalProof = source.proofs.find((candidate) =>
      candidate.phases.includes("final_integrated"));
    if (!finalProof) throw new Error(`missing final proof for ${semanticTaskId}`);
    const finalCustody = {
      verifierClosureSha256: finalProof.admission.verifierClosureSha256,
      candidateInputsSha256: finalProof.admission.candidateInputsSha256,
      executionToolchainSha256: finalProof.admission.executionToolchainSha256,
    } as const;
    return {
      source,
      semanticTaskId,
      taskId,
      campaign,
      proof,
      custody,
      finalProof,
      finalCustody,
      clauseId: proof.clauseIds[0]!,
    };
  }

  async function expiredSemanticV2Campaign(suffix: string) {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2020-01-01T00:00:00.000Z"));
    try {
      return await semanticV2Campaign(suffix);
    } finally {
      vi.useRealTimers();
    }
  }

  async function withApplicationClockBeforeDeadline<T>(
    fixture: Awaited<ReturnType<typeof expiredSemanticV2Campaign>>,
    operation: () => Promise<T>,
  ): Promise<T> {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(fixture.campaign.campaignStartedAt));
    try {
      return await operation();
    } finally {
      vi.useRealTimers();
    }
  }

  async function seedExpiredSemanticV2Attempt(
    fixture: Awaited<ReturnType<typeof expiredSemanticV2Campaign>>,
    state: "reserved" | "dispatched_unknown",
    suffix: string,
  ) {
    const controllerToken = `ccc-proof-controller-${randomUUID()}`;
    const workItemId = `WORK-proof-deadline-${suffix}`;
    const runId = `RUN-proof-deadline-${suffix}`;
    const workItemFence = { workItemId, runId, attempt: 1 } as const;
    const attemptKey = `ccc-proof-attempt-${sha256(canonicalCccPrdJson({
      schema: "ccc-campaign.proof-attempt.v2",
      attemptContractVersion: "v2",
      projectId: fixture.campaign.projectId,
      importId: fixture.campaign.importId,
      campaignId: fixture.campaign.campaignId,
      semanticTaskId: fixture.semanticTaskId,
      proofId: fixture.proof.id,
      phase: "task",
      sourceCommit: COMMIT_A,
      definitionSha256: computeCccPrdProofDefinitionSha256(fixture.proof),
      workItemFence,
    }))}`;
    const binding = createCccCampaignAuthorityBinding(fixture.campaign, {
      actionId: `proof:${fixture.proof.id}`,
      actionTarget: COMMIT_A,
    });
    await h.layer().db.execute(sql`
      INSERT INTO project.ccc_campaign_proof_attempts (
        project_id, attempt_key, controller_token, import_id, campaign_id,
        task_id, semantic_task_id, proof_id, packet_hash, sidecar_hash,
        bundle_hash, manifest_hash, campaign_binding_hash, target_repository,
        target_base, source_commit, source_tree, definition_sha256, command,
        command_sha256, work_item_id, run_id, work_item_attempt, state,
        created_at, updated_at, dispatched_at, attempt_contract_version, phase,
        verifier_closure_sha256, candidate_inputs_sha256,
        execution_toolchain_sha256
      ) VALUES (
        ${fixture.campaign.projectId}, ${attemptKey}, ${controllerToken},
        ${fixture.campaign.importId}, ${fixture.campaign.campaignId},
        ${fixture.taskId}, ${fixture.semanticTaskId}, ${fixture.proof.id},
        ${fixture.campaign.packetHash}, ${fixture.campaign.sidecarHash},
        ${fixture.campaign.bundleHash}, ${fixture.campaign.manifestHash},
        ${binding.bindingHash}, ${fixture.campaign.targetRepository.path},
        ${fixture.campaign.targetRepository.baseCommit}, ${COMMIT_A}, ${TREE_A},
        ${computeCccPrdProofDefinitionSha256(fixture.proof)},
        ${fixture.proof.command}, ${sha256(fixture.proof.command)},
        ${workItemId}, ${runId}, 1, ${state},
        ${fixture.campaign.campaignStartedAt}, ${fixture.campaign.campaignStartedAt},
        ${state === "dispatched_unknown" ? fixture.campaign.campaignStartedAt : null},
        'v2', 'task', ${fixture.custody.verifierClosureSha256},
        ${fixture.custody.candidateInputsSha256},
        ${fixture.custody.executionToolchainSha256}
      )
    `);
    return { attemptKey, controllerToken, workItemFence } as const;
  }

  it("RED-S5-DEADLINE-RESERVE: refuses v2 reservation after the database campaign deadline with zero attempt rows", async () => {
    const fixture = await expiredSemanticV2Campaign("deadline-reserve");

    await withApplicationClockBeforeDeadline(fixture, async () => {
      await expect(reserveCccCampaignProofAttempt({
        layer: h.layer(),
        rootDir: h.rootDir(),
        taskId: fixture.taskId,
        proofId: fixture.proof.id,
        attemptContractVersion: "v2",
        phase: "task",
        sourceCommit: COMMIT_A,
        sourceTree: TREE_A,
        workItemFence: {
          workItemId: "WORK-proof-deadline-reserve",
          runId: "RUN-proof-deadline-reserve",
          attempt: 1,
        },
        ...fixture.custody,
      })).rejects.toMatchObject({
        code: "CCC_CAMPAIGN_PROOF_ATTEMPT_LIMIT_REFUSED",
        reason: "deadline",
      });
    });
    const rows = await h.layer().db.execute(sql`
      SELECT attempt_key
      FROM project.ccc_campaign_proof_attempts
      WHERE project_id = ${fixture.campaign.projectId}
        AND import_id = ${fixture.campaign.importId}
    `) as unknown as Array<{ attempt_key: string }>;
    expect(rows).toEqual([]);
  });

  it("RED-S5-DEADLINE-REPLAY: returns an exact existing v2 reservation after the deadline without creating another row", async () => {
    const fixture = await expiredSemanticV2Campaign("deadline-replay");
    const seeded = await seedExpiredSemanticV2Attempt(
      fixture,
      "reserved",
      "replay",
    );

    await withApplicationClockBeforeDeadline(fixture, async () => {
      await expect(reserveCccCampaignProofAttempt({
        layer: h.layer(),
        rootDir: h.rootDir(),
        taskId: fixture.taskId,
        proofId: fixture.proof.id,
        attemptContractVersion: "v2",
        phase: "task",
        sourceCommit: COMMIT_A,
        sourceTree: TREE_A,
        workItemFence: seeded.workItemFence,
        ...fixture.custody,
      })).resolves.toMatchObject({
        attemptKey: seeded.attemptKey,
        controllerToken: seeded.controllerToken,
        state: "reserved",
      });
    });
    const rows = await h.layer().db.execute(sql`
      SELECT attempt_key, state
      FROM project.ccc_campaign_proof_attempts
      WHERE project_id = ${fixture.campaign.projectId}
        AND import_id = ${fixture.campaign.importId}
    `) as unknown as Array<{ attempt_key: string; state: string }>;
    expect(rows).toEqual([{
      attempt_key: seeded.attemptKey,
      state: "reserved",
    }]);
  });

  it("RED-S5-DEADLINE-BEGIN: refuses v2 begin after the database campaign deadline and leaves the reservation byte-for-byte unadvanced", async () => {
    const fixture = await expiredSemanticV2Campaign("deadline-begin");
    const seeded = await seedExpiredSemanticV2Attempt(
      fixture,
      "reserved",
      "begin",
    );
    const before = await inspectCccCampaignProofAttempt({
      layer: h.layer(),
      attemptKey: seeded.attemptKey,
    });

    await withApplicationClockBeforeDeadline(fixture, async () => {
      await expect(beginCccCampaignProofAttemptDispatch({
        layer: h.layer(),
        ...seeded,
      })).rejects.toMatchObject({
        code: "CCC_CAMPAIGN_PROOF_ATTEMPT_LIMIT_REFUSED",
        reason: "deadline",
      });
    });
    const after = await inspectCccCampaignProofAttempt({
      layer: h.layer(),
      attemptKey: seeded.attemptKey,
    });
    expect(after).toEqual(before);
    expect(after).toMatchObject({ state: "reserved" });
    expect(after).not.toHaveProperty("dispatchedAt");
    expect(after).not.toHaveProperty("settledAt");
  });

  it("RED-S5-DEADLINE-SETTLE: permits exact v2 settlement after the database campaign deadline once dispatch is durable", async () => {
    const fixture = await expiredSemanticV2Campaign("deadline-settle");
    const seeded = await seedExpiredSemanticV2Attempt(
      fixture,
      "dispatched_unknown",
      "settle",
    );
    const evidence = {
      schema: "ccc-prd.proof-evidence.v2",
      proofId: fixture.proof.id,
      phase: "task",
      sourceCommit: COMMIT_A,
      sourceTree: TREE_A,
      passed: true,
      clauseResults: fixture.proof.clauseIds.map((clauseId) => ({
        clauseId,
        passed: true,
      })),
      positiveCaseResults: fixture.proof.positiveCases.map(({ id: caseId }) => ({
        caseId,
        passed: true,
      })),
      negativeControlResults: fixture.proof.negativeControls.map(
        ({ id: controlId }) => ({ controlId, passed: true }),
      ),
    } as const;
    const envelope = {
      schema: "ccc-prd.proof-terminal-envelope.v2",
      kind: "verified",
      proofId: fixture.proof.id,
      phase: "task",
      sourceCommit: COMMIT_A,
      sourceTree: TREE_A,
      exitCode: 0,
      durationMs: 5,
      stdoutSha256: sha256(canonicalCccPrdJson(evidence)),
      stderrSha256: sha256(""),
      changedPathsSha256: sha256(canonicalCccPrdJson(fixture.proof.candidateInputs)),
      stdoutTail: canonicalCccPrdJson(evidence),
      stderrTail: "",
      timedOut: false,
      killed: false,
      warnings: [],
      passed: true,
      evidence,
      evidenceSha256: sha256(canonicalCccPrdJson(evidence)),
    } as const;

    await expect(settleCccCampaignProofAttempt({
      layer: h.layer(),
      ...seeded,
      terminalEnvelope: envelope,
    })).resolves.toMatchObject({
      state: "committed",
      terminalEnvelope: envelope,
      result: { success: true },
    });
    const rows = await h.layer().db.execute(sql`
      SELECT state, dispatched_at, settled_at, terminal_envelope_sha256
      FROM project.ccc_campaign_proof_attempts
      WHERE project_id = ${fixture.campaign.projectId}
        AND attempt_key = ${seeded.attemptKey}
    `) as unknown as Array<{
      state: string;
      dispatched_at: string | null;
      settled_at: string | null;
      terminal_envelope_sha256: string | null;
    }>;
    expect(rows).toEqual([{
      state: "committed",
      dispatched_at: fixture.campaign.campaignStartedAt,
      settled_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      terminal_envelope_sha256: sha256(canonicalCccPrdJson(envelope)),
    }]);
  });

  it("RED-S5-DEADLINE-LEGACY: preserves v1 reservation and dispatch replay after its original campaign deadline", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2020-01-01T00:00:00.000Z"));
    let fixture: Awaited<ReturnType<typeof campaign>>;
    try {
      fixture = await campaign("deadline-v1-compatibility");
    } finally {
      vi.useRealTimers();
    }
    const request = {
      layer: h.layer(),
      rootDir: h.rootDir(),
      taskId: fixture.taskId,
      proofId: fixture.proof.id,
      sourceCommit: COMMIT_A,
      sourceTree: TREE_A,
      workItemFence: {
        workItemId: "WORK-proof-deadline-v1-compatibility",
        runId: "RUN-proof-deadline-v1-compatibility",
        attempt: 1,
      },
    } as const;

    const reserved = await reserveCccCampaignProofAttempt(request);
    await expect(reserveCccCampaignProofAttempt(request)).resolves.toEqual(reserved);
    await expect(beginCccCampaignProofAttemptDispatch({
      layer: h.layer(),
      attemptKey: reserved.attemptKey,
      controllerToken: reserved.controllerToken,
    })).resolves.toMatchObject({
      kind: "dispatch-permit",
      attempt: {
        attemptContractVersion: "v1",
        state: "dispatched_unknown",
      },
    });
  });

  it("RED-S5-LEGACY: omitted contract version preserves the v1 key and result contract", async () => {
    const { semanticTaskId, taskId, proof } = await campaign("legacy-contract");
    const request = {
      layer: h.layer(),
      rootDir: h.rootDir(),
      taskId,
      proofId: proof.id,
      sourceCommit: COMMIT_A,
      sourceTree: TREE_A,
      workItemFence: {
        workItemId: "WORK-proof-attempt-legacy-contract",
        runId: "RUN-proof-attempt-legacy-contract",
        attempt: 7,
      },
    } as const;

    const reserved = await reserveCccCampaignProofAttempt(request);
    const expectedKey = `ccc-proof-attempt-${createHash("sha256")
      .update(canonicalCccPrdJson({
        schema: "ccc-campaign.proof-attempt.v1",
        projectId: reserved.projectId,
        importId: reserved.importId,
        campaignId: reserved.campaignId,
        semanticTaskId,
        proofId: proof.id,
        sourceCommit: COMMIT_A,
        definitionSha256: computeCccPrdProofDefinitionSha256(proof),
      }), "utf8")
      .digest("hex")}`;
    expect(reserved).toMatchObject({
      schema: "ccc-campaign.proof-attempt.v1",
      attemptContractVersion: "v1",
      attemptKey: expectedKey,
    });
    expect(reserved).not.toHaveProperty("phase");
    expect(reserved).not.toHaveProperty("terminalEnvelope");
    expect(reserved).not.toHaveProperty("proofEvidence");

    await beginCccCampaignProofAttemptDispatch({
      layer: h.layer(),
      attemptKey: reserved.attemptKey,
      controllerToken: reserved.controllerToken,
    });
    const terminal = await settleCccCampaignProofAttempt({
      layer: h.layer(),
      attemptKey: reserved.attemptKey,
      controllerToken: reserved.controllerToken,
      result: {
        success: false,
        exitCode: 1,
        durationMs: 9,
        stdout: "legacy stdout\n",
        stderr: "legacy stderr\n",
        timedOut: false,
        killed: false,
        warnings: ["legacy warning"],
      },
    });
    expect(terminal.result).toEqual({
      success: false,
      exitCode: 1,
      durationMs: 9,
      stdoutSha256: createHash("sha256").update("legacy stdout\n").digest("hex"),
      stderrSha256: createHash("sha256").update("legacy stderr\n").digest("hex"),
      stdoutTail: "legacy stdout\n",
      stderrTail: "legacy stderr\n",
      timedOut: false,
      killed: false,
      warnings: ["legacy warning"],
    });
  });

  it("RED-S5-PHASE-IDENTITY: v2 hashes phase and the exact work-item fence while same-phase replay is stable", async () => {
    const { taskId, proof, custody, finalProof, finalCustody } =
      await semanticV2Campaign("phase-identity");
    await expect(reserveCccCampaignProofAttempt({
      layer: h.layer(),
      rootDir: h.rootDir(),
      taskId,
      proofId: proof.id,
      sourceCommit: COMMIT_A,
      sourceTree: TREE_A,
      workItemFence: {
        workItemId: "WORK-proof-attempt-phase-identity-downgrade",
        runId: "RUN-proof-attempt-phase-identity",
        attempt: 1,
      },
    })).rejects.toThrow(/semantic proof v2 .*requires proof-attempt contract v2/i);
    const common = {
      layer: h.layer(),
      rootDir: h.rootDir(),
      taskId,
      proofId: proof.id,
      attemptContractVersion: "v2",
      sourceCommit: COMMIT_A,
      sourceTree: TREE_A,
      workItemFence: {
        workItemId: "WORK-proof-attempt-phase-identity",
        runId: "RUN-proof-attempt-phase-identity",
        attempt: 1,
      },
      ...custody,
    } as const;

    await expect(reserveCccCampaignProofAttempt({
      ...common,
      phase: "task",
      candidateInputsSha256: "f".repeat(64),
    })).rejects.toThrow(/custody digests.*immutable admission/i);

    const taskPhase = await reserveCccCampaignProofAttempt({
      ...common,
      phase: "task",
    });
    const taskReplay = await reserveCccCampaignProofAttempt({
      ...common,
      phase: "task",
    });
    const finalPhase = await reserveCccCampaignProofAttempt({
      ...common,
      proofId: finalProof.id,
      phase: "final_integrated",
      ...finalCustody,
    });
    const nextFence = await reserveCccCampaignProofAttempt({
      ...common,
      phase: "task",
      workItemFence: { ...common.workItemFence, attempt: 2 },
    });

    expect(taskReplay).toEqual(taskPhase);
    expect(taskPhase).toMatchObject({
      schema: "ccc-campaign.proof-attempt.v2",
      attemptContractVersion: "v2",
      phase: "task",
      ...custody,
    });
    expect(finalPhase).toMatchObject({
      schema: "ccc-campaign.proof-attempt.v2",
      attemptContractVersion: "v2",
      phase: "final_integrated",
      ...finalCustody,
    });
    expect(new Set([
      taskPhase.attemptKey,
      finalPhase.attemptKey,
      nextFence.attemptKey,
    ])).toHaveLength(3);
    const listed = await listCccCampaignProofAttemptsForCommit({
      layer: h.layer(),
      importId: taskPhase.importId,
      campaignId: taskPhase.campaignId,
      taskId,
      sourceCommit: COMMIT_A,
    });
    expect(listed.map(({ attemptKey }) => attemptKey)).toEqual([
      finalPhase.attemptKey,
      taskPhase.attemptKey,
      nextFence.attemptKey,
    ]);
  });

  it("RED-S5-CONSTRAINTS: PostgreSQL rejects version, phase, lifecycle, and same-phase identity drift", async () => {
    const { taskId, proof, custody } = await semanticV2Campaign("v2-constraints");
    const legacyCampaign = await campaign("v1-constraints");
    const legacy = await reserveCccCampaignProofAttempt({
      layer: h.layer(),
      rootDir: h.rootDir(),
      taskId: legacyCampaign.taskId,
      proofId: legacyCampaign.proof.id,
      sourceCommit: COMMIT_A,
      sourceTree: TREE_A,
      workItemFence: {
        workItemId: "WORK-proof-attempt-v1-constraints",
        runId: "RUN-proof-attempt-v1-constraints",
        attempt: 1,
      },
    });
    const v2 = await reserveCccCampaignProofAttempt({
      layer: h.layer(),
      rootDir: h.rootDir(),
      taskId,
      proofId: proof.id,
      attemptContractVersion: "v2",
      phase: "task",
      sourceCommit: COMMIT_A,
      sourceTree: TREE_A,
      workItemFence: {
        workItemId: "WORK-proof-attempt-v2-constraints",
        runId: "RUN-proof-attempt-v2-constraints",
        attempt: 1,
      },
      ...custody,
    });

    await expectPgConstraint(h.layer().db.execute(sql`
      UPDATE project.ccc_campaign_proof_attempts
      SET phase = 'task', verifier_closure_sha256 = ${"1".repeat(64)}
      WHERE attempt_key = ${legacy.attemptKey}
    `), /ccc_campaign_proof_attempts_v2_custody_check/i);
    await expectPgConstraint(h.layer().db.execute(sql`
      UPDATE project.ccc_campaign_proof_attempts
      SET phase = NULL
      WHERE attempt_key = ${v2.attemptKey}
    `), /ccc_campaign_proof_attempts_v2_custody_check/i);
    await expectPgConstraint(h.layer().db.execute(sql`
      UPDATE project.ccc_campaign_proof_attempts
      SET terminal_envelope = '{}'::jsonb,
          terminal_envelope_sha256 = ${"4".repeat(64)}
      WHERE attempt_key = ${v2.attemptKey}
    `), /ccc_campaign_proof_attempts_result_shape_check/i);

    const duplicateKey = `ccc-proof-attempt-${"f".repeat(64)}`;
    await expectPgConstraint(h.layer().db.execute(sql`
      INSERT INTO project.ccc_campaign_proof_attempts (
        project_id, attempt_key, controller_token, import_id, campaign_id,
        task_id, semantic_task_id, proof_id, packet_hash, sidecar_hash,
        bundle_hash, manifest_hash, campaign_binding_hash, target_repository,
        target_base, source_commit, source_tree, definition_sha256, command,
        command_sha256, work_item_id, run_id, work_item_attempt, state,
        created_at, updated_at, attempt_contract_version, phase,
        verifier_closure_sha256, candidate_inputs_sha256,
        execution_toolchain_sha256
      )
      SELECT project_id, ${duplicateKey},
        'ccc-proof-controller-00000000-0000-4000-8000-000000000099',
        import_id, campaign_id, task_id, semantic_task_id, proof_id, packet_hash,
        sidecar_hash, bundle_hash, manifest_hash, campaign_binding_hash,
        target_repository, target_base, source_commit, source_tree,
        definition_sha256, command, command_sha256, work_item_id, run_id,
        work_item_attempt, state, created_at, updated_at,
        attempt_contract_version, phase, verifier_closure_sha256,
        candidate_inputs_sha256, execution_toolchain_sha256
      FROM project.ccc_campaign_proof_attempts
      WHERE attempt_key = ${v2.attemptKey}
    `), /ccc_campaign_proof_attempts_v2_phase_fence_unique|duplicate key/i);
  });

  it("RED-S5-TERMINAL-REPLAY: timeout, no output, malformed output, and verified failure replay exactly", async () => {
    const { taskId, proof, custody, clauseId } =
      await semanticV2Campaign("v2-terminal-replay");
    const cases = [
      {
        code: "timeout",
        exitCode: null,
        stdout: "",
        stderr: "deadline exceeded",
        timedOut: true,
        killed: true,
      },
      {
        code: "no_output",
        exitCode: 0,
        stdout: "",
        stderr: "",
        timedOut: false,
        killed: false,
      },
      {
        code: "malformed_output",
        exitCode: 0,
        stdout: "{not-json",
        stderr: "",
        timedOut: false,
        killed: false,
      },
    ] as const;

    for (const [index, refusal] of cases.entries()) {
      const reserved = await reserveCccCampaignProofAttempt({
        layer: h.layer(),
        rootDir: h.rootDir(),
        taskId,
        proofId: proof.id,
        attemptContractVersion: "v2",
        phase: "task",
        sourceCommit: COMMIT_A,
        sourceTree: TREE_A,
        workItemFence: {
          workItemId: `WORK-proof-attempt-refusal-${index}`,
          runId: "RUN-proof-attempt-refusal",
          attempt: index + 1,
        },
        ...custody,
      });
      await beginCccCampaignProofAttemptDispatch({
        layer: h.layer(),
        attemptKey: reserved.attemptKey,
        controllerToken: reserved.controllerToken,
      });
      const envelope = {
        schema: "ccc-prd.proof-terminal-envelope.v2",
        kind: "execution_refused",
        code: refusal.code,
        proofId: proof.id,
        phase: "task",
        sourceCommit: COMMIT_A,
        sourceTree: TREE_A,
        exitCode: refusal.exitCode,
        durationMs: index + 10,
        stdoutSha256: sha256(refusal.stdout),
        stderrSha256: sha256(refusal.stderr),
        changedPathsSha256: sha256("[]"),
        stdoutTail: refusal.stdout,
        stderrTail: refusal.stderr,
        timedOut: refusal.timedOut,
        killed: refusal.killed,
        warnings: [],
      } as const;
      const terminal = await settleCccCampaignProofAttempt({
        layer: h.layer(),
        attemptKey: reserved.attemptKey,
        controllerToken: reserved.controllerToken,
        terminalEnvelope: envelope,
      });
      expect(terminal).toMatchObject({
        state: "proved_failed",
        terminalEnvelope: envelope,
        terminalEnvelopeSha256: sha256(canonicalCccPrdJson(envelope)),
        result: { changedPathsSha256: envelope.changedPathsSha256 },
      });
      expect(terminal).not.toHaveProperty("proofEvidence");
      await expect(settleCccCampaignProofAttempt({
        layer: h.layer(),
        attemptKey: reserved.attemptKey,
        controllerToken: reserved.controllerToken,
        terminalEnvelope: envelope,
      })).resolves.toEqual(terminal);
      if (index === 0) {
        await expectPgConstraint(h.layer().db.execute(sql`
          UPDATE project.ccc_campaign_proof_attempts
          SET terminal_envelope = jsonb_set(
            terminal_envelope,
            '{code}',
            '"toolchain_drift"'::jsonb
          )
          WHERE attempt_key = ${reserved.attemptKey}
        `), /ccc_campaign_proof_attempts_result_shape_check/i);
      }
    }

    const reserved = await reserveCccCampaignProofAttempt({
      layer: h.layer(),
      rootDir: h.rootDir(),
      taskId,
      proofId: proof.id,
      attemptContractVersion: "v2",
      phase: "task",
      sourceCommit: COMMIT_A,
      sourceTree: TREE_A,
      workItemFence: {
        workItemId: "WORK-proof-attempt-verified-failure",
        runId: "RUN-proof-attempt-refusal",
        attempt: 4,
      },
      ...custody,
    });
    await beginCccCampaignProofAttemptDispatch({
      layer: h.layer(),
      attemptKey: reserved.attemptKey,
      controllerToken: reserved.controllerToken,
    });
    const evidence = {
      schema: "ccc-prd.proof-evidence.v2",
      proofId: proof.id,
      phase: "task",
      sourceCommit: COMMIT_A,
      sourceTree: TREE_A,
      passed: false,
      clauseResults: [{ clauseId, passed: false }],
      positiveCaseResults: proof.positiveCases.map(({ id: caseId }) => ({
        caseId,
        passed: false,
      })),
      negativeControlResults: proof.negativeControls.map(({ id: controlId }) => ({
        controlId,
        passed: true,
      })),
    } as const;
    const evidenceSha256 = sha256(canonicalCccPrdJson(evidence));
    const envelope = {
      schema: "ccc-prd.proof-terminal-envelope.v2",
      kind: "verified",
      proofId: proof.id,
      phase: "task",
      sourceCommit: COMMIT_A,
      sourceTree: TREE_A,
      exitCode: 1,
      durationMs: 21,
      stdoutSha256: sha256(canonicalCccPrdJson(evidence)),
      stderrSha256: sha256("semantic failure"),
      changedPathsSha256: sha256('["src/v2-terminal-replay.ts"]'),
      stdoutTail: canonicalCccPrdJson(evidence),
      stderrTail: "semantic failure",
      timedOut: false,
      killed: false,
      warnings: [],
      passed: false,
      evidence,
      evidenceSha256,
    } as const;
    const undeclaredEvidence = {
      ...evidence,
      clauseResults: [{ clauseId: "AC-UNDECLARED", passed: false }],
    } as const;
    const undeclaredEnvelope = {
      ...envelope,
      evidence: undeclaredEvidence,
      evidenceSha256: sha256(canonicalCccPrdJson(undeclaredEvidence)),
    } as const;
    const { changedPathsSha256: _missingChangedPaths, ...missingChangedPathsEnvelope } =
      envelope;
    const {
      passed: _passed,
      evidence: _evidence,
      evidenceSha256: _evidenceSha256,
      ...processEnvelope
    } = envelope;
    await expect(settleCccCampaignProofAttempt({
      layer: h.layer(),
      attemptKey: reserved.attemptKey,
      controllerToken: reserved.controllerToken,
      terminalEnvelope: {
        ...processEnvelope,
        kind: "execution_refused",
        code: "toolchain_drift",
      },
    } as never)).rejects.toThrow(/refusal code is unsupported/i);
    await expect(settleCccCampaignProofAttempt({
      layer: h.layer(),
      attemptKey: reserved.attemptKey,
      controllerToken: reserved.controllerToken,
      terminalEnvelope: missingChangedPathsEnvelope,
    } as never)).rejects.toThrow(/unknown or missing fields/i);
    await expect(settleCccCampaignProofAttempt({
      layer: h.layer(),
      attemptKey: reserved.attemptKey,
      controllerToken: reserved.controllerToken,
      terminalEnvelope: { ...envelope, changedPathsSha256: "not-a-digest" },
    })).rejects.toThrow(/changed-path digest.*SHA-256/i);
    await expect(settleCccCampaignProofAttempt({
      layer: h.layer(),
      attemptKey: reserved.attemptKey,
      controllerToken: reserved.controllerToken,
      terminalEnvelope: undeclaredEnvelope,
    })).rejects.toThrow(/evidence.*exactly match.*expected result sets/i);
    await expect(settleCccCampaignProofAttempt({
      layer: h.layer(),
      attemptKey: reserved.attemptKey,
      controllerToken: reserved.controllerToken,
      terminalEnvelope: { ...envelope, undeclaredField: true },
    } as never)).rejects.toThrow(/unknown or missing fields/i);
    await expect(settleCccCampaignProofAttempt({
      layer: h.layer(),
      attemptKey: reserved.attemptKey,
      controllerToken: reserved.controllerToken,
      terminalEnvelope: { ...envelope, stderrTail: "x".repeat(8_001) },
    })).rejects.toThrow(/output tail exceeds its limit/i);

    const failed = await settleCccCampaignProofAttempt({
      layer: h.layer(),
      attemptKey: reserved.attemptKey,
      controllerToken: reserved.controllerToken,
      terminalEnvelope: envelope,
    });
    expect(failed).toMatchObject({
      state: "proved_failed",
      terminalEnvelope: envelope,
      terminalEnvelopeSha256: sha256(canonicalCccPrdJson(envelope)),
      proofEvidence: evidence,
      proofEvidenceSha256: evidenceSha256,
    });
    await expect(settleCccCampaignProofAttempt({
      layer: h.layer(),
      attemptKey: reserved.attemptKey,
      controllerToken: reserved.controllerToken,
      terminalEnvelope: envelope,
    })).resolves.toEqual(failed);
    await expect(settleCccCampaignProofAttempt({
      layer: h.layer(),
      attemptKey: reserved.attemptKey,
      controllerToken: reserved.controllerToken,
      terminalEnvelope: { ...envelope, changedPathsSha256: "f".repeat(64) },
    })).rejects.toThrow(/terminal envelope.*collides/i);

    await expect(settleCccCampaignProofAttempt({
      layer: h.layer(),
      attemptKey: reserved.attemptKey,
      controllerToken: reserved.controllerToken,
      result: {
        success: false,
        exitCode: 1,
        durationMs: 1,
        stdout: "legacy bypass",
        stderr: "",
        timedOut: false,
        killed: false,
        warnings: [],
      },
    })).rejects.toThrow(/v2.*terminal envelope|legacy.*v2/i);

    const passingReservation = await reserveCccCampaignProofAttempt({
      layer: h.layer(),
      rootDir: h.rootDir(),
      taskId,
      proofId: proof.id,
      attemptContractVersion: "v2",
      phase: "task",
      sourceCommit: COMMIT_A,
      sourceTree: TREE_A,
      workItemFence: {
        workItemId: "WORK-proof-attempt-verified-passing",
        runId: "RUN-proof-attempt-refusal",
        attempt: 5,
      },
      ...custody,
    });
    await beginCccCampaignProofAttemptDispatch({
      layer: h.layer(),
      attemptKey: passingReservation.attemptKey,
      controllerToken: passingReservation.controllerToken,
    });
    const passingEvidence = {
      ...evidence,
      passed: true,
      clauseResults: evidence.clauseResults.map((result) => ({ ...result, passed: true })),
      positiveCaseResults: evidence.positiveCaseResults.map((result) => ({
        ...result,
        passed: true,
      })),
    } as const;
    const passingEnvelope = {
      ...envelope,
      exitCode: 0,
      durationMs: 22,
      stdoutSha256: sha256(canonicalCccPrdJson(passingEvidence)),
      stdoutTail: canonicalCccPrdJson(passingEvidence),
      stderrSha256: sha256(""),
      stderrTail: "",
      passed: true,
      evidence: passingEvidence,
      evidenceSha256: sha256(canonicalCccPrdJson(passingEvidence)),
    } as const;
    const passed = await settleCccCampaignProofAttempt({
      layer: h.layer(),
      attemptKey: passingReservation.attemptKey,
      controllerToken: passingReservation.controllerToken,
      terminalEnvelope: passingEnvelope,
    });
    expect(passed).toMatchObject({
      state: "committed",
      terminalEnvelope: passingEnvelope,
      proofEvidence: passingEvidence,
      result: { changedPathsSha256: passingEnvelope.changedPathsSha256 },
    });
    await expectPgConstraint(h.layer().db.execute(sql`
      UPDATE project.ccc_campaign_proof_attempts
      SET stdout_tail = 'tampered output'
      WHERE attempt_key = ${passingReservation.attemptKey}
    `), /ccc_campaign_proof_attempts_result_shape_check/i);
    await expectPgConstraint(h.layer().db.execute(sql`
      UPDATE project.ccc_campaign_proof_attempts
      SET changed_paths_sha256 = ${"f".repeat(64)}
      WHERE attempt_key = ${passingReservation.attemptKey}
    `), /ccc_campaign_proof_attempts_result_shape_check/i);
    await expectPgConstraint(h.layer().db.execute(sql`
      UPDATE project.ccc_campaign_proof_attempts
      SET proof_evidence_sha256 = ${"f".repeat(64)}
      WHERE attempt_key = ${passingReservation.attemptKey}
    `), /ccc_campaign_proof_attempts_result_shape_check/i);
  });

  it("persists reserved -> dispatched_unknown -> terminal proof separately from definition admission", async () => {
    const { semanticTaskId, taskId, proof } = await campaign("lifecycle");
    const request = {
      layer: h.layer(),
      rootDir: h.rootDir(),
      taskId,
      proofId: proof.id,
      sourceCommit: COMMIT_A,
      sourceTree: TREE_A,
      workItemFence: {
        workItemId: "WORK-proof-attempt-lifecycle",
        runId: "RUN-proof-attempt-lifecycle",
        attempt: 1,
      },
    } as const;

    const reserved = await reserveCccCampaignProofAttempt(request);
    const replay = await reserveCccCampaignProofAttempt(request);
    expect(replay).toEqual(reserved);
    expect(reserved).toMatchObject({
      state: "reserved",
      taskId,
      semanticTaskId,
      proofId: proof.id,
      sourceCommit: COMMIT_A,
      sourceTree: TREE_A,
      definitionSha256: computeCccPrdProofDefinitionSha256(proof),
      command: proof.command,
      workItemId: request.workItemFence.workItemId,
      runId: request.workItemFence.runId,
      workItemAttempt: request.workItemFence.attempt,
    });

    const dispatch = await beginCccCampaignProofAttemptDispatch({
      layer: h.layer(),
      attemptKey: reserved.attemptKey,
      controllerToken: reserved.controllerToken,
    });
    expect(dispatch).toMatchObject({
      kind: "dispatch-permit",
      attempt: { state: "dispatched_unknown" },
    });

    const restartDecision = await beginCccCampaignProofAttemptDispatch({
      layer: h.layer(),
      attemptKey: reserved.attemptKey,
      controllerToken: reserved.controllerToken,
    });
    expect(restartDecision).toMatchObject({
      kind: "dispatched-unknown",
      attempt: { state: "dispatched_unknown" },
    });

    const failed = await settleCccCampaignProofAttempt({
      layer: h.layer(),
      attemptKey: reserved.attemptKey,
      controllerToken: reserved.controllerToken,
      result: {
        success: false,
        exitCode: 1,
        durationMs: 42,
        stdout: "one failing test\n",
        stderr: "AssertionError: planted defect\n",
        timedOut: false,
        killed: false,
        warnings: [],
      },
    });
    expect(failed).toMatchObject({
      state: "proved_failed",
      result: {
        success: false,
        exitCode: 1,
        stdoutSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        stderrSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        stdoutTail: "one failing test\n",
        stderrTail: "AssertionError: planted defect\n",
      },
    });
    await expect(inspectCccCampaignProofAttempt({
      layer: h.layer(),
      attemptKey: reserved.attemptKey,
    })).resolves.toEqual(failed);
  });

  it("commits a passing receipt and refuses settlement with the wrong controller", async () => {
    const { semanticTaskId, taskId, proof } = await campaign("pass");
    const reserved = await reserveCccCampaignProofAttempt({
      layer: h.layer(),
      rootDir: h.rootDir(),
      taskId,
      proofId: proof.id,
      sourceCommit: COMMIT_A,
      sourceTree: TREE_A,
      workItemFence: {
        workItemId: "WORK-proof-attempt-pass",
        runId: "RUN-proof-attempt-pass",
        attempt: 2,
      },
    });
    await beginCccCampaignProofAttemptDispatch({
      layer: h.layer(),
      attemptKey: reserved.attemptKey,
      controllerToken: reserved.controllerToken,
    });
    await expect(settleCccCampaignProofAttempt({
      layer: h.layer(),
      attemptKey: reserved.attemptKey,
      controllerToken: "ccc-proof-controller-00000000-0000-4000-8000-000000000000",
      result: {
        success: true,
        exitCode: 0,
        durationMs: 7,
        stdout: "ok\n",
        stderr: "",
        timedOut: false,
        killed: false,
        warnings: [],
      },
    })).rejects.toThrow(/controller/i);

    const passed = await settleCccCampaignProofAttempt({
      layer: h.layer(),
      attemptKey: reserved.attemptKey,
      controllerToken: reserved.controllerToken,
      result: {
        success: true,
        exitCode: 0,
        durationMs: 7,
        stdout: "ok\n",
        stderr: "",
        timedOut: false,
        killed: false,
        warnings: [],
      },
    });
    expect(passed).toMatchObject({
      state: "committed",
      taskId,
      semanticTaskId,
      result: {
        success: true,
        exitCode: 0,
        durationMs: 7,
      },
    });
  });

  it("reserves every campaign proof on the final integration task even when task-local proof ids differ", async () => {
    const initial = createCccPrdImportTestBundle(h.rootDir(), "campaign-suite");
    const firstProof = initial.proofs[0]!;
    const secondProof = {
      ...firstProof,
      id: "PROOF-campaign-suite-terminal",
      command: "pnpm test -- terminal",
      positiveOracle: "terminal verifier passes",
    };
    const source = rehashCccPrdImportTestBundle({
      ...initial,
      bounds: { ...initial.bounds, maxRequests: initial.tasks.length },
      requirements: initial.requirements.map((requirement) => ({
        ...requirement,
        proofIds: [firstProof.id, secondProof.id],
      })),
      proofs: [firstProof, secondProof],
      tasks: initial.tasks.map((task, index) =>
        index === initial.tasks.length - 1
          ? { ...task, proofIds: [secondProof.id] }
          : { ...task, proofIds: [firstProof.id] }),
    });
    const imported = await importCccPrdBundle({
      bundle: source,
      idempotencyKey: "proof-attempt-campaign-suite",
      store: h.store(),
      layer: h.layer(),
      rootDir: h.rootDir(),
      executionPolicy: createCccPrdImportTestExecutionPolicy(source),
    });
    const terminalTask = source.tasks[source.tasks.length - 1]!;
    const taskId = await nativeTaskIdForImport(imported.importId, terminalTask.id);
    expect(taskId).not.toBe(terminalTask.id);
    const proof = firstProof;

    const reserved = await reserveCccCampaignProofAttempt({
      layer: h.layer(),
      rootDir: h.rootDir(),
      taskId,
      proofId: proof.id,
      scope: "campaign",
      sourceCommit: COMMIT_A,
      sourceTree: TREE_A,
      workItemFence: {
        workItemId: "WORK-proof-attempt-campaign-suite",
        runId: "RUN-proof-attempt-campaign-suite",
        attempt: 1,
      },
    });

    expect(reserved).toMatchObject({
      state: "reserved",
      taskId,
      semanticTaskId: terminalTask.id,
      proofId: proof.id,
      definitionSha256: computeCccPrdProofDefinitionSha256(proof),
    });
  });
});
