import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import {
  beginCccCampaignProofAttemptDispatch,
  computeCccPrdProofDefinitionSha256,
  importCccPrdBundle,
  inspectCccCampaignProofAttempt,
  reserveCccCampaignProofAttempt,
  settleCccCampaignProofAttempt,
} from "../../index.js";
import {
  createCccPrdImportTestBundle,
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
      executionPolicy: createCccPrdImportTestProductExecutionPolicy(source),
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
      executionPolicy: createCccPrdImportTestProductExecutionPolicy(source),
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
