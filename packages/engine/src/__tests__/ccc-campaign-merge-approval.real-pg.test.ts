import { execFile as execFileCallback } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  CCC_PRD_PROOF_ADMISSION_SCHEMA_VERSION,
  computeCccPrdProofDefinitionSha256,
  deriveWorkflowExtensionHostProvenance,
  getApprovalRequest,
  getWorkflowExtensionHostProvenanceBinding,
  importCccPrdBundle,
  inspectCccPrdProductStatus,
  type CccPrdSemanticBundle,
} from "@fusion/core";
import {
  createCccPrdImportTestProductBundle,
  createCccPrdImportTestProductExecutionPolicy,
  rehashCccPrdImportTestBundle,
} from "../../../core/src/__test-utils__/ccc-prd-import-fixture.js";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
} from "../../../core/src/__test-utils__/pg-test-harness.js";
import {
  CCC_CAMPAIGN_PROOF_ADMISSION_EXTENSION_ID,
  CCC_CAMPAIGN_PROOF_ADMISSION_PLUGIN_ID,
  CCC_CAMPAIGN_PROOF_ADMISSION_PLUGIN_VERSION,
  CCC_CAMPAIGN_PROOF_ADMISSION_PROOF_VERSION,
} from "../ccc-campaign-proof-admission.js";
import { bootstrapCccCampaignProofAdmissionHost } from "../ccc-campaign-proof-host.js";
import { TaskExecutor } from "../executor.js";
import {
  CCC_CAMPAIGN_MERGE_APPROVAL_REQUIRED_CODE,
  approveCccCampaignMerge,
  computeCccCampaignMergeApprovalConfirmation,
  issueCccCampaignMergeApproval,
} from "../ccc-campaign-product-control.js";

const execFile = promisify(execFileCallback);
const ENGINE_DIST_ROOT = fileURLToPath(new URL("../../dist/", import.meta.url));
const pgTest = pgDescribe;

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

async function admittedMergeBundle(
  rootDir: string,
  baseCommit: string,
  suffix: string,
): Promise<CccPrdSemanticBundle> {
  const source = createCccPrdImportTestProductBundle(rootDir, suffix);
  const terminalTask = source.tasks[1]!;
  const mergeAction = {
    id: `ACTION-${suffix}-MERGE`,
    kind: "merge" as const,
    target: "refs/heads/main",
    requiresOperatorDecision: true as const,
    operatorDecision: "approve_merge" as const,
    spans: [terminalTask.spans[0]!],
  };
  const provenance = await deriveWorkflowExtensionHostProvenance({
    pluginId: CCC_CAMPAIGN_PROOF_ADMISSION_PLUGIN_ID,
    pluginVersion: CCC_CAMPAIGN_PROOF_ADMISSION_PLUGIN_VERSION,
    trustedRootPath: ENGINE_DIST_ROOT,
    entryRelativePath: "ccc-campaign-proof-admission.js",
    manifestRelativePath: "ccc-campaign-proof-admission.manifest.json",
  });
  const binding = getWorkflowExtensionHostProvenanceBinding(provenance);
  return rehashCccPrdImportTestBundle({
    ...source,
    targetRepository: { path: rootDir, baseCommit },
    admittedWriteRoots: [{
      path: rootDir,
      purpose: "import projection and disposable product source",
    }],
    tasks: source.tasks.map((task) => task.id === terminalTask.id
      ? { ...task, protectedActionIds: [mergeAction.id] }
      : task),
    protectedActions: [mergeAction],
    proofs: source.proofs.map((proof) => {
      const definition = {
        ...proof,
        command: "test -f src/product.txt",
        positiveOracle: "campaign-created source exists",
        negativeControls: ["missing source exits non-zero"],
      };
      return {
        ...definition,
        admission: {
          schema: CCC_PRD_PROOF_ADMISSION_SCHEMA_VERSION,
          pluginId: binding.pluginId,
          pluginVersion: binding.pluginVersion,
          extensionId: CCC_CAMPAIGN_PROOF_ADMISSION_EXTENSION_ID,
          proofVersion: CCC_CAMPAIGN_PROOF_ADMISSION_PROOF_VERSION,
          extensionRootRelativeSource: binding.extensionRootRelativeSource,
          extensionSourceSha256: binding.extensionSourceSha256,
          extensionManifestSha256: binding.extensionManifestSha256,
          definitionSha256: computeCccPrdProofDefinitionSha256(definition),
        },
      };
    }),
  });
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
    const rootDir = h.rootDir();
    const baseCommit = await initializeGitRoot(rootDir);
    const bundle = await admittedMergeBundle(rootDir, baseCommit, suffix);
    const imported = await importCccPrdBundle({
      bundle,
      executionPolicy: createCccPrdImportTestProductExecutionPolicy(bundle),
      idempotencyKey: suffix,
      store: h.store(),
      layer: h.layer(),
      rootDir,
    });
    const semanticTaskId = bundle.workflows[0]!.terminalTaskIds[0]!;
    const productStatus = await inspectCccPrdProductStatus({
      idempotencyKey: suffix,
      layer: h.layer(),
      rootDir,
    });
    if (!productStatus) {
      throw new Error(`missing product status for ${suffix}`);
    }
    expect(productStatus.import.importId).toBe(imported.importId);
    const taskStatuses = productStatus.tasks.filter(
      (status) => status.semanticTaskId === semanticTaskId,
    );
    expect(taskStatuses).toHaveLength(1);
    const taskId = taskStatuses[0]!.nativeTaskId;
    expect(taskId).not.toBe(semanticTaskId);
    return { rootDir, baseCommit, bundle, imported, taskId };
  }

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
