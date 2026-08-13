import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  beginCccCampaignProofAttemptDispatch,
  canonicalCccPrdJson,
  claimCccCampaignApproval,
  computeCccPrdProofV2AdmissionDigests,
  drizzleSql,
  getApprovalRequest,
  importCccPrdBundle,
  inspectCccPrdProductStatus,
  reserveCccCampaignProofAttempt,
  settleCccCampaignProofAttempt,
  type CccPrdProofV2,
} from "@fusion/core";
import {
  admitCccPrdImportTestProductBundle,
  createCccPrdImportTestProductBundle,
  createCccPrdImportTestProductExecutionPolicy,
  rehashCccPrdImportTestBundle,
} from "../../../core/src/__test-utils__/ccc-prd-import-fixture.js";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
} from "../../../core/src/__test-utils__/pg-test-harness.js";
import { bootstrapCccCampaignProofAdmissionHost } from "../ccc-campaign-proof-host.js";
import { TaskExecutor } from "../executor.js";
import { resolveTaskWorkingBranch } from "../worktree-names.js";
import {
  CCC_CAMPAIGN_MERGE_APPROVAL_REQUIRED_CODE,
  approveCccCampaignMerge,
  computeCccCampaignMergeApprovalConfirmation,
  issueCccCampaignMergeApproval,
} from "../ccc-campaign-product-control.js";

const execFile = promisify(execFileCallback);
const ENGINE_DIST_ROOT = fileURLToPath(new URL("../../dist/", import.meta.url));
const pgTest = pgDescribe;
const sha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

async function git(rootDir: string, ...args: string[]): Promise<string> {
  return (await execFile("git", ["-C", rootDir, ...args], {
    encoding: "utf8",
  })).stdout.trim();
}

async function initializeGitRoot(rootDir: string): Promise<string> {
  await execFile("git", ["init", "--initial-branch=main", rootDir]);
  await execFile("git", ["-C", rootDir, "config", "user.name", "Fusion Test"]);
  await execFile("git", ["-C", rootDir, "config", "user.email", "fusion-test@example.invalid"]);
  await execFile("git", ["-C", rootDir, "commit", "--allow-empty", "-m", "base"]);
  return git(rootDir, "rev-parse", "HEAD");
}

async function admittedMergeBundle(rootDir: string, suffix: string) {
  const baseCommit = await initializeGitRoot(rootDir);
  const source = createCccPrdImportTestProductBundle(rootDir, suffix);
  const terminalTaskId = source.workflows[0]!.terminalTaskIds[0]!;
  const terminalTask = source.tasks.find(({ id }) => id === terminalTaskId)!;
  const mergeAction = {
    id: `ACTION-${suffix}-MERGE`,
    kind: "merge" as const,
    target: "refs/heads/main",
    requiresOperatorDecision: true as const,
    operatorDecision: "approve_merge" as const,
    spans: [terminalTask.spans[0]!],
  };
  const legacy = rehashCccPrdImportTestBundle({
    ...source,
    bounds: {
      ...source.bounds,
      maxDurationMs: 120_000,
    },
    targetRepository: { path: rootDir, baseCommit },
    admittedWriteRoots: [{
      path: rootDir,
      purpose: "import projection and disposable product source",
    }],
    tasks: source.tasks.map((task) => task.id === terminalTask.id
      ? { ...task, protectedActionIds: [mergeAction.id] }
      : task),
    protectedActions: [mergeAction],
  });
  return admitCccPrdImportTestProductBundle(legacy, suffix);
}

pgTest("CCC campaign product merge approval", () => {
  const h = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_ccc_merge_approval",
  });

  beforeAll(async () => {
    await h.beforeAll();
    await bootstrapCccCampaignProofAdmissionHost({ builtRootPath: ENGINE_DIST_ROOT });
  });
  beforeEach(h.beforeEach);
  afterAll(h.afterAll);

  async function importFixture(suffix: string) {
    const fixture = await importSemanticV2Fixture(suffix, "final_integrated");
    return { ...fixture, taskId: fixture.terminalTaskId };
  }

  async function settleSemanticProof(
    input: Readonly<{
      rootDir: string;
      taskId: string;
      proof: CccPrdProofV2;
      phase: "task" | "final_integrated";
      sourceCommit: string;
      sourceTree: string;
      workItemFence: Readonly<{
        workItemId: string;
        runId: string;
        attempt: number;
      }>;
      passed: boolean;
    }>,
  ) {
    const custody = computeCccPrdProofV2AdmissionDigests(input.proof);
    const reserved = await reserveCccCampaignProofAttempt({
      layer: h.layer(),
      rootDir: input.rootDir,
      taskId: input.taskId,
      proofId: input.proof.id,
      attemptContractVersion: "v2",
      phase: input.phase,
      sourceCommit: input.sourceCommit,
      sourceTree: input.sourceTree,
      workItemFence: input.workItemFence,
      ...custody,
    });
    await beginCccCampaignProofAttemptDispatch({
      layer: h.layer(),
      attemptKey: reserved.attemptKey,
      controllerToken: reserved.controllerToken,
    });
    const clauseResults = input.proof.clauseIds.map((clauseId) => ({
      clauseId,
      passed: true,
    }));
    const positiveCaseResults = input.proof.positiveCases.map(({ id: caseId }) => ({
      caseId,
      passed: true,
    }));
    const negativeControlResults = input.proof.negativeControls.map(
      ({ id: controlId }) => ({ controlId, passed: true }),
    );
    if (!input.passed) {
      const firstResult = clauseResults[0]
        ?? positiveCaseResults[0]
        ?? negativeControlResults[0];
      if (!firstResult) throw new Error("semantic proof fixture requires evidence results");
      firstResult.passed = false;
    }
    const evidence = {
      schema: "ccc-prd.proof-evidence.v2" as const,
      proofId: input.proof.id,
      phase: input.phase,
      sourceCommit: input.sourceCommit,
      sourceTree: input.sourceTree,
      passed: input.passed,
      clauseResults,
      positiveCaseResults,
      negativeControlResults,
    };
    const canonicalEvidence = canonicalCccPrdJson(evidence);
    const envelope = {
      schema: "ccc-prd.proof-terminal-envelope.v2" as const,
      kind: "verified" as const,
      proofId: input.proof.id,
      phase: input.phase,
      sourceCommit: input.sourceCommit,
      sourceTree: input.sourceTree,
      exitCode: input.passed ? 0 : 1,
      durationMs: 1,
      stdoutSha256: sha256(canonicalEvidence),
      stderrSha256: sha256(""),
      changedPathsSha256: sha256(
        JSON.stringify([...input.proof.candidateInputs].sort()),
      ),
      stdoutTail: canonicalEvidence,
      stderrTail: "",
      timedOut: false,
      killed: false,
      warnings: [],
      passed: input.passed,
      evidence,
      evidenceSha256: sha256(canonicalEvidence),
    };
    await settleCccCampaignProofAttempt({
      layer: h.layer(),
      attemptKey: reserved.attemptKey,
      controllerToken: reserved.controllerToken,
      terminalEnvelope: envelope,
    });
    return reserved;
  }

  async function importSemanticV2Fixture(
    suffix: string,
    phase: "task" | "final_integrated",
    initialProofPassed = true,
  ) {
    const rootDir = h.rootDir();
    const { bundle, semanticProofToolchainPaths } = await admittedMergeBundle(
      rootDir,
      suffix,
    );
    const baseCommit = bundle.targetRepository.baseCommit;
    const imported = await importCccPrdBundle({
      bundle,
      executionPolicy: createCccPrdImportTestProductExecutionPolicy(bundle),
      semanticProofToolchainPaths,
      idempotencyKey: suffix,
      store: h.store(),
      layer: h.layer(),
      rootDir,
    });
    const status = await inspectCccPrdProductStatus({
      idempotencyKey: suffix,
      layer: h.layer(),
      rootDir,
    });
    if (!status) throw new Error(`missing semantic-v2 product status for ${suffix}`);
    const terminalSemanticTaskId = bundle.workflows[0]!.terminalTaskIds[0]!;
    const terminalTaskId = status.tasks.find(
      ({ semanticTaskId }) => semanticTaskId === terminalSemanticTaskId,
    )!.nativeTaskId;
    await h.store().updateTask(terminalTaskId, {
      branch: `fusion/semantic-merge-${suffix}`,
    });
    const terminalTask = await h.store().getTask(terminalTaskId);
    const branch = resolveTaskWorkingBranch(terminalTask);
    const sourcePath = "src/task-1/change.txt";
    const sourcePaths = bundle.proofs
      .filter((proof) =>
        proof.schema === "ccc-prd.proof.v2"
        && proof.phases.includes("final_integrated"))
      .flatMap(({ candidateInputs }) => candidateInputs)
      .sort();
    expect(sourcePaths).toEqual([
      "src/task-0/change.txt",
      sourcePath,
    ]);
    await execFile("git", ["-C", rootDir, "switch", "-c", branch, "main"]);
    for (const candidatePath of sourcePaths) {
      await mkdir(dirname(join(rootDir, candidatePath)), { recursive: true });
      await writeFile(
        join(rootDir, candidatePath),
        `semantic merge candidate ${suffix} ${candidatePath}\n`,
        "utf8",
      );
    }
    await execFile("git", ["-C", rootDir, "add", "--", ...sourcePaths]);
    await execFile("git", ["-C", rootDir, "commit", "-m", "semantic candidate"]);
    const sourceCommit = await git(rootDir, "rev-parse", "HEAD");
    const sourceTree = await git(rootDir, "rev-parse", "HEAD^{tree}");
    await execFile("git", ["-C", rootDir, "switch", "main"]);
    await writeFile(
      join(rootDir, ".git", "info", "exclude"),
      [
        ".worktrees/",
        ".fusion/",
        ".fn/",
        "",
      ].join("\n"),
      "utf8",
    );
    const unexpectedUntracked = await git(
      rootDir,
      "ls-files",
      "--others",
      "--exclude-standard",
    );
    if (unexpectedUntracked) {
      throw new Error(
        `semantic merge fixture left nonignored untracked paths: ${unexpectedUntracked}`,
      );
    }
    const importedWorkItem = status.workItems[0]!;
    const workItem = await h.store().getWorkflowWorkItem(importedWorkItem.id);
    if (!workItem) throw new Error(`missing semantic-v2 work item for ${suffix}`);
    const parked = await h.store().upsertWorkflowWorkItem({
      ...workItem,
      state: "manual-required",
      attempt: 1,
      leaseOwner: null,
      leaseExpiresAt: null,
      retryAfter: null,
      lastError: "ccc-permanent:CCC_CAMPAIGN_MERGE_APPROVAL_REQUIRED",
      blockedReason: "ccc-permanent:CCC_CAMPAIGN_MERGE_APPROVAL_REQUIRED",
      waitReason: null,
    });
    const terminalProofIds = new Set(
      bundle.tasks.find(({ id }) => id === terminalSemanticTaskId)!.proofIds,
    );
    const phaseProofs = bundle.proofs.filter((proof) =>
      proof.schema === "ccc-prd.proof.v2"
      && proof.phases.includes(phase)
      && (phase === "final_integrated" || terminalProofIds.has(proof.id)));
    const reservations = [];
    for (const proof of phaseProofs) {
      if (proof.schema !== "ccc-prd.proof.v2") {
        throw new Error("semantic-v2 fixture did not retain its proof contract");
      }
      const ownerSemanticTaskId = bundle.tasks.find(({ proofIds }) =>
        proofIds.includes(proof.id))!.id;
      const ownerTaskId = status.tasks.find(
        ({ semanticTaskId }) => semanticTaskId === ownerSemanticTaskId,
      )!.nativeTaskId;
      const reserved = await settleSemanticProof({
        rootDir,
        taskId: phase === "task" ? ownerTaskId : terminalTaskId,
        proof,
        phase,
        sourceCommit,
        sourceTree,
        workItemFence: {
          workItemId: parked.id,
          runId: parked.runId,
          attempt: parked.attempt,
        },
        passed: initialProofPassed,
      });
      reservations.push(reserved);
    }
    return {
      rootDir,
      baseCommit,
      bundle,
      imported,
      terminalTaskId,
      branch,
      sourcePath,
      sourceCommit,
      sourceTree,
      parked,
      phaseProofs,
      reservations,
    };
  }

  async function driftSemanticReceiptDuration(
    attemptKey: string,
  ): Promise<void> {
    const [row] = await h.layer().db.execute(drizzleSql`
      SELECT duration_ms, terminal_envelope
      FROM project.ccc_campaign_proof_attempts
      WHERE attempt_key = ${attemptKey}
    `) as unknown as Array<{
      duration_ms: number | string;
      terminal_envelope: Record<string, unknown> | null;
    }>;
    if (
      !row
      || row.duration_ms === null
      || !row.terminal_envelope
      || typeof row.terminal_envelope !== "object"
      || Array.isArray(row.terminal_envelope)
    ) {
      throw new Error(`missing terminal envelope for ${attemptKey}`);
    }
    const durationMs = Number(row.duration_ms) + 1;
    const terminalEnvelope = { ...row.terminal_envelope, durationMs };
    const terminalEnvelopeJson = canonicalCccPrdJson(terminalEnvelope);
    await h.layer().db.execute(drizzleSql`
      UPDATE project.ccc_campaign_proof_attempts
      SET duration_ms = ${durationMs},
          terminal_envelope = ${terminalEnvelopeJson}::jsonb,
          terminal_envelope_sha256 = ${sha256(terminalEnvelopeJson)}
      WHERE attempt_key = ${attemptKey}
    `);
  }

  it("RED-S5-MERGE-PHASE: task-phase proof cannot issue merge approval", async () => {
    const fixture = await importSemanticV2Fixture(
      "semantic-merge-task-phase",
      "task",
    );

    await expect(issueCccCampaignMergeApproval({
      store: h.store(),
      rootDir: fixture.rootDir,
      taskId: fixture.terminalTaskId,
      runId: "RUN-semantic-merge-task-phase",
    })).rejects.toThrow(/final_integrated|final integrated|final proof/i);

    const status = await inspectCccPrdProductStatus({
      idempotencyKey: "semantic-merge-task-phase",
      layer: h.layer(),
      rootDir: fixture.rootDir,
    });
    expect(status?.approvals).toEqual([]);
    expect(await git(fixture.rootDir, "rev-parse", "refs/heads/main"))
      .toBe(fixture.baseCommit);
  });

  it("RED-S5-MERGE-RETRY: a failed final proof does not poison its passing retry", async () => {
    const fixture = await importSemanticV2Fixture(
      "semantic-merge-final-retry",
      "final_integrated",
      false,
    );
    const retryFence = await h.store().upsertWorkflowWorkItem({
      ...fixture.parked,
      state: "manual-required",
      attempt: fixture.parked.attempt + 1,
      leaseOwner: null,
      leaseExpiresAt: null,
      retryAfter: null,
      lastError: "ccc-permanent:CCC_CAMPAIGN_MERGE_APPROVAL_REQUIRED",
      blockedReason: "ccc-permanent:CCC_CAMPAIGN_MERGE_APPROVAL_REQUIRED",
      waitReason: null,
    });
    for (const proof of fixture.phaseProofs) {
      if (proof.schema !== "ccc-prd.proof.v2") {
        throw new Error("semantic-v2 retry fixture did not retain its proof contract");
      }
      await settleSemanticProof({
        rootDir: fixture.rootDir,
        taskId: fixture.terminalTaskId,
        proof,
        phase: "final_integrated",
        sourceCommit: fixture.sourceCommit,
        sourceTree: fixture.sourceTree,
        workItemFence: {
          workItemId: retryFence.id,
          runId: retryFence.runId,
          attempt: retryFence.attempt,
        },
        passed: true,
      });
    }

    await expect(issueCccCampaignMergeApproval({
      store: h.store(),
      rootDir: fixture.rootDir,
      taskId: fixture.terminalTaskId,
      runId: "RUN-semantic-merge-final-retry",
    })).resolves.toMatchObject({
      status: "issued",
      runId: expect.stringMatching(
        new RegExp(
          `^ccc-merge-proof-v2:${fixture.sourceCommit}:${fixture.sourceTree}:[0-9a-f]{64}$`,
          "u",
        ),
      ),
    });
    const status = await inspectCccPrdProductStatus({
      idempotencyKey: "semantic-merge-final-retry",
      layer: h.layer(),
      rootDir: fixture.rootDir,
    });
    expect(status!.proofs.flatMap(({ attempts }) => attempts)
      .map(({ state }) => state)
      .sort()).toEqual(["committed", "proved_failed"]);
    expect(await git(fixture.rootDir, "rev-parse", "refs/heads/main"))
      .toBe(fixture.baseCommit);
  });

  it("RED-S5-MERGE-BINDING: final proof binds approval to exact commit, tree, and receipt digest", async () => {
    const fixture = await importSemanticV2Fixture(
      "semantic-merge-final",
      "final_integrated",
    );

    const approval = await issueCccCampaignMergeApproval({
      store: h.store(),
      rootDir: fixture.rootDir,
      taskId: fixture.terminalTaskId,
      runId: "RUN-semantic-merge-final",
    });

    expect(approval.runId).toMatch(
      new RegExp(
        `^ccc-merge-proof-v2:${fixture.sourceCommit}:${fixture.sourceTree}:[0-9a-f]{64}$`,
        "u",
      ),
    );
    const finalReceiptSetSha256 = approval.runId!.split(":").at(-1)!;
    expect(computeCccCampaignMergeApprovalConfirmation(approval)).toBe(
      sha256(canonicalCccPrdJson({
        schema: "ccc-campaign.merge-approval-confirmation.v2",
        approvalRequestId: approval.id,
        taskId: approval.taskId ?? null,
        runId: approval.runId ?? null,
        targetAction: approval.targetAction,
        binding: approval.campaign!.binding,
        finalProofCustody: {
          schema: "ccc-campaign.final-proof-custody.v2",
          sourceCommit: fixture.sourceCommit,
          sourceTree: fixture.sourceTree,
          finalReceiptSetSha256,
        },
        notBeforeAt: approval.campaign!.notBeforeAt,
        expiresAt: approval.campaign!.expiresAt,
      })),
    );
    const status = await inspectCccPrdProductStatus({
      idempotencyKey: "semantic-merge-final",
      layer: h.layer(),
      rootDir: fixture.rootDir,
    });
    const attempts = status!.proofs.flatMap((proof) => proof.attempts);
    expect(attempts).toHaveLength(fixture.reservations.length);
    expect(attempts).toEqual(expect.arrayContaining(attempts.map(() =>
      expect.objectContaining({
        attemptContractVersion: "v2",
        phase: "final_integrated",
        verifierClosureSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
        candidateInputsSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
        executionToolchainSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
        terminalEnvelope: expect.objectContaining({
          schema: "ccc-prd.proof-terminal-envelope.v2",
          kind: "verified",
          passed: true,
        }),
        terminalEnvelopeSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
        proofEvidence: expect.objectContaining({
          schema: "ccc-prd.proof-evidence.v2",
          phase: "final_integrated",
          passed: true,
        }),
        proofEvidenceSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      }))));
    expect(status?.nextAction).toMatchObject({
      kind: "approve-merge",
      approvalRequestId: approval.id,
      approvalStatus: "issued",
    });
    expect(await git(fixture.rootDir, "rev-parse", "refs/heads/main"))
      .toBe(fixture.baseCommit);
  });

  it("RED-S5-MERGE-DRIFT: source drift after issuance refuses before approval claim", async () => {
    const fixture = await importSemanticV2Fixture(
      "semantic-merge-drift",
      "final_integrated",
    );
    const approval = await issueCccCampaignMergeApproval({
      store: h.store(),
      rootDir: fixture.rootDir,
      taskId: fixture.terminalTaskId,
      runId: "RUN-semantic-merge-drift",
    });
    const confirmation = computeCccCampaignMergeApprovalConfirmation(approval);
    await execFile("git", ["-C", fixture.rootDir, "switch", fixture.branch]);
    await writeFile(
      join(fixture.rootDir, fixture.sourcePath),
      "drifted after approval issuance\n",
      "utf8",
    );
    await execFile("git", ["-C", fixture.rootDir, "add", "-f", fixture.sourcePath]);
    await execFile("git", ["-C", fixture.rootDir, "commit", "-m", "drift"]);
    await execFile("git", ["-C", fixture.rootDir, "switch", "main"]);

    await expect(approveCccCampaignMerge({
      store: h.store(),
      rootDir: fixture.rootDir,
      taskId: fixture.terminalTaskId,
      approvalRequestId: approval.id,
      confirmation,
      actor: {
        actorId: "operator-semantic-drift",
        actorType: "user",
        actorName: "Operator",
      },
    })).rejects.toMatchObject({
      code: "CCC_CAMPAIGN_MERGE_PROOF_CUSTODY_REFUSED",
    });
    await expect(getApprovalRequest(h.layer().db, approval.id))
      .resolves.toMatchObject({ status: "issued" });
    expect(await git(fixture.rootDir, "rev-parse", "refs/heads/main"))
      .toBe(fixture.baseCommit);
  });

  it("RED-S5-MERGE-PREMUTATION: claimed approval refuses receipt drift before Git mutation", async () => {
    const fixture = await importSemanticV2Fixture(
      "semantic-merge-premutation",
      "final_integrated",
    );
    const approval = await issueCccCampaignMergeApproval({
      store: h.store(),
      rootDir: fixture.rootDir,
      taskId: fixture.terminalTaskId,
      runId: "RUN-semantic-merge-premutation",
    });
    const action = fixture.bundle.protectedActions.find(
      (candidate) => candidate.kind === "merge",
    )!;
    await claimCccCampaignApproval(h.layer(), {
      authorityStore: h.store(),
      rootDir: fixture.rootDir,
      taskId: fixture.terminalTaskId,
      action: {
        actionId: action.id,
        actionTarget: action.target,
        requireProtected: true,
      },
      claimant: {
        actorId: "operator-semantic-premutation",
        actorType: "user",
        actorName: "Operator",
      },
      runId: `ccc-merge-approval:${approval.id}`,
      claimToken: "semantic-premutation-claim-token",
    });
    await driftSemanticReceiptDuration(fixture.reservations[0]!.attemptKey);

    await expect(approveCccCampaignMerge({
      store: h.store(),
      rootDir: fixture.rootDir,
      taskId: fixture.terminalTaskId,
      approvalRequestId: approval.id,
      confirmation: computeCccCampaignMergeApprovalConfirmation(approval),
      actor: {
        actorId: "operator-semantic-premutation",
        actorType: "user",
        actorName: "Operator",
      },
    })).rejects.toThrow(/final_integrated proof custody|receipt set|custody/i);
    await expect(getApprovalRequest(h.layer().db, approval.id))
      .resolves.toMatchObject({ status: "claimed" });
    expect(await git(fixture.rootDir, "rev-parse", "refs/heads/main"))
      .toBe(fixture.baseCommit);
  });

  it("RED-S5-MERGE-LANDING: lands and replays only the approval-bound final receipt custody", async () => {
    const fixture = await importSemanticV2Fixture(
      "semantic-merge-landing",
      "final_integrated",
    );
    const approval = await issueCccCampaignMergeApproval({
      store: h.store(),
      rootDir: fixture.rootDir,
      taskId: fixture.terminalTaskId,
      runId: "RUN-semantic-merge-landing",
    });
    const confirmation = computeCccCampaignMergeApprovalConfirmation(approval);
    const input = {
      store: h.store(),
      rootDir: fixture.rootDir,
      taskId: fixture.terminalTaskId,
      approvalRequestId: approval.id,
      confirmation,
      actor: {
        actorId: "operator-semantic-landing",
        actorType: "user" as const,
        actorName: "Operator",
      },
    };

    await expect(approveCccCampaignMerge(input)).resolves.toMatchObject({
      merged: true,
      reason: "ccc-campaign-native-git-landed",
    });
    const landedCommit = await git(fixture.rootDir, "rev-parse", "refs/heads/main");
    expect(landedCommit).not.toBe(fixture.baseCommit);
    await expect(getApprovalRequest(h.layer().db, approval.id))
      .resolves.toMatchObject({ status: "consumed" });
    const status = await inspectCccPrdProductStatus({
      idempotencyKey: "semantic-merge-landing",
      layer: h.layer(),
      rootDir: fixture.rootDir,
    });
    const workItem = status!.workItems[0]!;
    await h.store().transitionWorkflowWorkItem(workItem.id, "succeeded", {
      expectedState: "manual-required",
      expectedAttempt: workItem.attempt,
      attempt: workItem.attempt,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: null,
      blockedReason: null,
    });

    await expect(approveCccCampaignMerge(input)).resolves.toMatchObject({
      merged: true,
      reason: "ccc-campaign-native-git-landed",
    });
    expect(await git(fixture.rootDir, "rev-parse", "refs/heads/main"))
      .toBe(landedCommit);

    await driftSemanticReceiptDuration(fixture.reservations[0]!.attemptKey);
    await expect(approveCccCampaignMerge(input))
      .rejects.toThrow(/final_integrated proof custody|receipt set|custody/i);
    expect(await git(fixture.rootDir, "rev-parse", "refs/heads/main"))
      .toBe(landedCommit);
  });

  it("issues one exact redacted human merge approval and leaves the target ref unchanged", async () => {
    const { rootDir, baseCommit, imported, taskId } =
      await importFixture("merge-approval");

    const first = await issueCccCampaignMergeApproval({
      store: h.store(),
      rootDir,
      taskId,
      runId: "RUN-merge-approval",
    });
    const replay = await issueCccCampaignMergeApproval({
      store: h.store(),
      rootDir,
      taskId,
      runId: "RUN-merge-approval",
    });

    expect(first).toMatchObject({
      status: "issued",
      taskId,
      campaign: {
        binding: {
          importId: imported.importId,
          actionId: "ACTION-merge-approval-MERGE",
          actionTarget: "refs/heads/main",
          targetBase: baseCommit,
        },
      },
    });
    expect(replay).toEqual(first);
    expect(computeCccCampaignMergeApprovalConfirmation(first))
      .toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify({
      approval: first,
      confirmation: computeCccCampaignMergeApprovalConfirmation(first),
    })).not.toContain("claimToken");
    await expect(getApprovalRequest(h.layer().db, first.id))
      .resolves.toMatchObject({ status: "issued" });
    await expect(h.store().getCccCampaignContextForTask(taskId))
      .resolves.toMatchObject({ activeActionLeases: {} });
    expect(await git(rootDir, "rev-parse", "refs/heads/main")).toBe(baseCommit);
    expect(CCC_CAMPAIGN_MERGE_APPROVAL_REQUIRED_CODE)
      .toBe("CCC_CAMPAIGN_MERGE_APPROVAL_REQUIRED");
  });

  it("parks the product graph at an issued approval without invoking the merge requester", async () => {
    const { rootDir, baseCommit, taskId } =
      await importFixture("merge-approval-graph");
    const terminalTask = await h.store().getTask(taskId);
    const executor = new TaskExecutor(h.store(), rootDir);
    const mergeRequester = vi.fn(async () => {
      throw new Error("merge requester must not run before human approval");
    });
    executor.setMergeRequester(mergeRequester);

    await expect(executor.createAuthoritativeWorkflowPrimitives({
      autoMerge: true,
    }).requestMerge({
      run: {
        runId: "RUN-merge-approval-graph",
        taskId,
        workflowId: `WF-merge-approval-graph`,
      },
      node: {
        node: {
          id: "ccc-merge-approval-graph",
          kind: "prompt",
          config: { seam: "merge", cccPrdTaskId: taskId },
        },
      },
    }, terminalTask)).rejects.toMatchObject({
      code: CCC_CAMPAIGN_MERGE_APPROVAL_REQUIRED_CODE,
    });

    expect(mergeRequester).not.toHaveBeenCalled();
    expect(await git(rootDir, "rev-parse", "refs/heads/main")).toBe(baseCommit);
  });

  it("rejects a stale or mistyped human confirmation before claiming authority or touching Git", async () => {
    const { rootDir, baseCommit, taskId } =
      await importFixture("merge-approval-confirmation");
    const approval = await issueCccCampaignMergeApproval({
      store: h.store(),
      rootDir,
      taskId,
      runId: "RUN-merge-approval-confirmation",
    });

    await expect(approveCccCampaignMerge({
      store: h.store(),
      rootDir,
      taskId,
      approvalRequestId: approval.id,
      confirmation: "0".repeat(64),
      actor: {
        actorId: "operator-test",
        actorType: "user",
        actorName: "Operator Test",
      },
    })).rejects.toMatchObject({
      code: "CCC_CAMPAIGN_MERGE_CONFIRMATION_REFUSED",
    });

    await expect(getApprovalRequest(h.layer().db, approval.id))
      .resolves.toMatchObject({ status: "issued" });
    await expect(h.store().getCccCampaignContextForTask(taskId))
      .resolves.toMatchObject({ activeActionLeases: {} });
    expect(await git(rootDir, "rev-parse", "refs/heads/main")).toBe(baseCommit);
  });
});
