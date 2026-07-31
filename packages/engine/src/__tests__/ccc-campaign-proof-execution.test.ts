import { execFile as execFileCallback, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CccCampaignTaskContext,
  CccPrdProof,
  TaskDetail,
  WorkflowIrNode,
} from "@fusion/core";
import { PermanentError } from "../engine-errors.js";
import { createCccCampaignProofSuiteHandler } from "../ccc-campaign-proof-execution.js";
import { __testOnlyDetectTrustedVerifierBwrap } from "../run-verification-tool.js";

const execFile = promisify(execFileCallback);
const scratchRoots: string[] = [];

function canExecuteVerifierSandbox(): boolean {
  if (process.platform === "darwin") return existsSync("/usr/bin/sandbox-exec");
  if (process.platform !== "linux") return false;
  const detected = __testOnlyDetectTrustedVerifierBwrap();
  if (!detected.available || !detected.path) return false;
  const probe = spawnSync(detected.path, [
    "--die-with-parent",
    "--unshare-net",
    "--ro-bind",
    "/",
    "/",
    "--",
    "/bin/true",
  ], { stdio: "ignore", timeout: 5_000 });
  return probe.status === 0;
}

const itVerifierHost = canExecuteVerifierSandbox() ? it : it.skip;

async function commit(repo: string, message: string): Promise<string> {
  await execFile("git", ["-C", repo, "add", "--all"]);
  await execFile("git", [
    "-C",
    repo,
    "-c",
    "user.name=Fusion Test",
    "-c",
    "user.email=fusion-test@example.invalid",
    "commit",
    "-m",
    message,
  ]);
  return (await execFile("git", ["-C", repo, "rev-parse", "HEAD"])).stdout.trim();
}

async function fixture() {
  const scratch = await mkdtemp(join(tmpdir(), "ccc-proof-execution-"));
  scratchRoots.push(scratch);
  const repo = join(scratch, "target");
  const worktree = join(scratch, "campaign-worktree");
  await mkdir(repo, { recursive: true });
  await execFile("git", ["init", "--initial-branch=main", repo]);
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "src", "value.txt"), "base\n", "utf8");
  const baseCommit = await commit(repo, "base");
  await execFile("git", [
    "-C",
    repo,
    "worktree",
    "add",
    "-b",
    "campaign/integration",
    worktree,
    baseCommit,
  ]);
  await writeFile(join(worktree, "src", "value.txt"), "bad\n", "utf8");
  const badCommit = await commit(worktree, "campaign planted defect");

  const proof: CccPrdProof = {
    id: "PROOF-value",
    requirementIds: ["REQ-value"],
    command: "test \"$(cat src/value.txt)\" = good",
    positiveOracle: "src/value.txt contains good",
    negativeControls: ["bad content exits non-zero"],
    spans: [],
    confidence: "high",
  };
  const task = {
    id: "FN-401",
    worktree,
    branch: "campaign/integration",
    baseCommitSha: baseCommit,
    customFields: { cccFusionProfile: "ccc-fusion" },
  } as unknown as TaskDetail;
  const semanticTaskId = "TASK-integration";
  const campaign = {
    schema: "ccc-campaign.context.v1",
    projectId: "__legacy_unscoped__",
    importId: "IMPORT-proof",
    idempotencyKey: "proof-execution",
    campaignId: "CAMPAIGN-proof",
    packetHash: "1".repeat(64),
    sidecarHash: "2".repeat(64),
    bundleHash: "3".repeat(64),
    sourceVersion: "fixture",
    targetRepository: { path: repo, baseCommit },
    targetBase: baseCommit,
    bounds: { maxRequests: 10, maxDurationMs: 60_000, maxConcurrency: 1 },
    campaignStartedAt: "2026-07-30T00:00:00.000Z",
    campaignDeadlineAt: "2099-07-31T00:00:00.000Z",
    admittedWriteRoots: [{
      path: repo,
      purpose: "import projection root; source writes remain route-scoped",
    }],
    proofs: [proof],
    protectedActions: [],
    executionPolicy: {
      schema: "ccc-campaign.execution-policy.v2",
      routes: [{
        taskId: semanticTaskId,
        providerId: "fixture",
        modelId: "fixture-v1",
        transport: "pi",
        executor: "model",
        toolMode: "coding",
        worktreeMode: "isolated",
        ownedPaths: ["src"],
        allowedWriteRoots: ["src"],
        commitPolicy: "required",
      }],
    },
    taskId: task.id,
    semanticTaskId,
    proofIds: [proof.id],
    protectedActionIds: [],
    route: {
      taskId: semanticTaskId,
      providerId: "fixture",
      modelId: "fixture-v1",
      transport: "pi",
      executor: "model",
      toolMode: "coding",
      worktreeMode: "isolated",
      ownedPaths: ["src"],
      allowedWriteRoots: ["src"],
      commitPolicy: "required",
    },
    manifestHash: "4".repeat(64),
    requestCount: 0,
    activeActionLeases: {},
  } as unknown as CccCampaignTaskContext;
  const node = {
    id: "proof-suite",
    kind: "gate",
    config: {
      cccProofSuite: true,
      cccProofIds: [proof.id],
      cccPrdTaskIds: [semanticTaskId],
      cccNativeTaskIds: [task.id],
      cccPrdTaskId: semanticTaskId,
      cccNativeTaskId: task.id,
    },
  } as WorkflowIrNode;
  return {
    repo,
    worktree,
    task,
    semanticTaskId,
    campaign,
    proof,
    node,
    baseCommit,
    badCommit,
  };
}

afterEach(async () => {
  await Promise.all(scratchRoots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

describe("CCC campaign proof-suite execution", () => {
  itVerifierHost("executes the declared verifier on the exact campaign commit: planted defect fails, corrected commit passes", async () => {
    const f = await fixture();
    const settled: Array<{
      attemptKey: string;
      success: boolean;
      changedPathsSha256?: string;
    }> = [];
    const reserve = vi.fn(async (input: { sourceCommit: string; proofId: string }) => ({
      attemptKey: `ccc-proof-attempt-${input.sourceCommit}`,
      controllerToken: `ccc-proof-controller-${input.sourceCommit.slice(0, 8)}`,
      state: "reserved" as const,
      proofId: input.proofId,
      sourceCommit: input.sourceCommit,
    }));
    const begin = vi.fn(async (input: { attemptKey: string }) => ({
      kind: "dispatch-permit" as const,
      attempt: { attemptKey: input.attemptKey, state: "dispatched_unknown" as const },
    }));
    const settle = vi.fn(async (input: {
      attemptKey: string;
      result: { success: boolean; changedPathsSha256?: string };
    }) => {
      settled.push({
        attemptKey: input.attemptKey,
        success: input.result.success,
        changedPathsSha256: input.result.changedPathsSha256,
      });
      return {
        attemptKey: input.attemptKey,
        state: input.result.success ? "committed" as const : "proved_failed" as const,
      };
    });
    const handler = createCccCampaignProofSuiteHandler({
      rootDir: f.repo,
      store: {
        getTask: async () => f.task,
        getCccCampaignContextForTask: async () => f.campaign,
        getAsyncLayer: () => ({}) as never,
        assertCccCampaignWorkflowLeaseFence: async () => undefined,
      },
      proofAttempts: { reserve, begin, settle },
    });
    const executionContext = {
      task: f.task,
      settings: { verificationCommandTimeoutMs: 30_000 },
      context: {},
      execution: {
        originTaskId: f.task.id,
        semanticTaskId: f.semanticTaskId,
        nativeTaskId: f.task.id,
        semanticTask: f.task,
        runId: "RUN-proof",
        visitIdentity: { nodeId: f.node.id, materializedNodeId: f.node.id },
        executionFence: {
          workItemId: "WORK-proof",
          leaseOwner: "proof-worker",
          attempt: 1,
          runId: "RUN-proof",
        },
      },
    } as never;

    await expect(handler(f.node, executionContext)).resolves.toMatchObject({
      outcome: "failure",
      value: `ccc-proof-failed:${f.proof.id}`,
    });
    expect(settled).toEqual([
      {
        attemptKey: `ccc-proof-attempt-${f.badCommit}`,
        success: false,
        changedPathsSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    ]);

    await writeFile(join(f.worktree, "src", "value.txt"), "good\n", "utf8");
    const goodCommit = await commit(f.worktree, "campaign correction");
    await expect(handler(f.node, executionContext)).resolves.toMatchObject({
      outcome: "success",
      value: "ccc-proof-suite-passed",
      contextPatch: {
        "ccc:proof:source-commit": goodCommit,
        "ccc:proof:ids": [f.proof.id],
      },
    });
    expect(settled).toEqual([
      {
        attemptKey: `ccc-proof-attempt-${f.badCommit}`,
        success: false,
        changedPathsSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
      {
        attemptKey: `ccc-proof-attempt-${goodCommit}`,
        success: true,
        changedPathsSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    ]);
    expect(settled[0]?.changedPathsSha256).toBe(settled[1]?.changedPathsSha256);
    expect(reserve).toHaveBeenCalledTimes(2);
    expect(begin).toHaveBeenCalledTimes(2);
  });

  it("settles an otherwise successful verifier as failed when it mutates the inspected worktree", async () => {
    const f = await fixture();
    const settle = vi.fn(async (input: {
      attemptKey: string;
      result: { success: boolean };
    }) => ({
      attemptKey: input.attemptKey,
      controllerToken: "ccc-proof-controller-mutation",
      state: input.result.success ? "committed" as const : "proved_failed" as const,
    }));
    const runVerification = vi.fn(async (options: { cwd: string; command: string }) => {
      await writeFile(join(options.cwd, "src", "verifier-side-effect.txt"), "unexpected\n", "utf8");
      return {
        success: true,
        exitCode: 0,
        durationMs: 5,
        stdout: "declared verifier passed\n",
        stderr: "",
        timedOut: false,
        killed: false,
        command: options.command,
        cwd: options.cwd,
        warnings: [],
      };
    });
    const handler = createCccCampaignProofSuiteHandler({
      rootDir: f.repo,
      store: {
        getTask: async () => f.task,
        getCccCampaignContextForTask: async () => f.campaign,
        getAsyncLayer: () => ({}) as never,
        assertCccCampaignWorkflowLeaseFence: async () => undefined,
      },
      proofAttempts: {
        reserve: async () => ({
          attemptKey: "ccc-proof-attempt-mutation",
          controllerToken: "ccc-proof-controller-mutation",
          state: "reserved" as const,
        }),
        begin: async () => ({
          kind: "dispatch-permit" as const,
          attempt: {
            attemptKey: "ccc-proof-attempt-mutation",
            controllerToken: "ccc-proof-controller-mutation",
            state: "dispatched_unknown" as const,
          },
        }),
        settle,
      },
      runVerification: runVerification as never,
    });

    await expect(handler(f.node, {
      task: f.task,
      settings: { verificationCommandTimeoutMs: 30_000 },
      context: {},
      execution: {
        originTaskId: f.task.id,
        semanticTaskId: f.semanticTaskId,
        nativeTaskId: f.task.id,
        semanticTask: f.task,
        runId: "RUN-proof",
        visitIdentity: { nodeId: f.node.id, materializedNodeId: f.node.id },
        executionFence: {
          workItemId: "WORK-proof",
          leaseOwner: "proof-worker",
          attempt: 1,
          runId: "RUN-proof",
        },
      },
    } as never)).resolves.toMatchObject({
      outcome: "failure",
      value: `ccc-proof-failed:${f.proof.id}`,
    });
    expect(settle).toHaveBeenCalledWith(expect.objectContaining({
      result: expect.objectContaining({
        success: false,
        warnings: expect.arrayContaining([
          expect.stringContaining("CCC_CAMPAIGN_PROOF_VERIFIER_MUTATION"),
        ]),
      }),
    }));
  });

  it("leaves a dispatched verifier uncertain when its work-item fence expires before settlement", async () => {
    const f = await fixture();
    const settle = vi.fn();
    const assertCccCampaignWorkflowLeaseFence = vi.fn(async () => {
      if (assertCccCampaignWorkflowLeaseFence.mock.calls.length >= 3) {
        throw new Error("lease expired while verifier ran");
      }
    });
    const handler = createCccCampaignProofSuiteHandler({
      rootDir: f.repo,
      store: {
        getTask: async () => f.task,
        getCccCampaignContextForTask: async () => f.campaign,
        getAsyncLayer: () => ({}) as never,
        assertCccCampaignWorkflowLeaseFence,
      },
      proofAttempts: {
        reserve: async () => ({
          attemptKey: "ccc-proof-attempt-expired-after-dispatch",
          controllerToken: "ccc-proof-controller-expired-after-dispatch",
          state: "reserved" as const,
        }),
        begin: async () => ({
          kind: "dispatch-permit" as const,
          attempt: {
            attemptKey: "ccc-proof-attempt-expired-after-dispatch",
            controllerToken: "ccc-proof-controller-expired-after-dispatch",
            state: "dispatched_unknown" as const,
          },
        }),
        settle,
      },
      runVerification: async (options) => ({
        success: true,
        exitCode: 0,
        durationMs: 5,
        stdout: "passed\n",
        stderr: "",
        timedOut: false,
        killed: false,
        command: options.command,
        cwd: options.cwd,
        warnings: [],
      }),
    });

    await expect(handler(f.node, {
      task: f.task,
      settings: { verificationCommandTimeoutMs: 30_000 },
      context: {},
      execution: {
        originTaskId: f.task.id,
        semanticTaskId: f.semanticTaskId,
        nativeTaskId: f.task.id,
        semanticTask: f.task,
        runId: "RUN-proof",
        visitIdentity: { nodeId: f.node.id, materializedNodeId: f.node.id },
        executionFence: {
          workItemId: "WORK-proof",
          leaseOwner: "proof-worker",
          attempt: 1,
          runId: "RUN-proof",
        },
      },
    } as never)).rejects.toMatchObject({
      name: PermanentError.name,
      code: "CCC_CAMPAIGN_PROOF_FENCE_REFUSED",
    });
    expect(assertCccCampaignWorkflowLeaseFence).toHaveBeenCalledTimes(3);
    expect(settle).not.toHaveBeenCalled();
  });

  it("turns a durable dispatched-without-terminal receipt into manual intervention without rerunning", async () => {
    const f = await fixture();
    const runVerification = vi.fn();
    const handler = createCccCampaignProofSuiteHandler({
      rootDir: f.repo,
      store: {
        getTask: async () => f.task,
        getCccCampaignContextForTask: async () => f.campaign,
        getAsyncLayer: () => ({}) as never,
        assertCccCampaignWorkflowLeaseFence: async () => undefined,
      },
      proofAttempts: {
        reserve: async () => ({
          attemptKey: "ccc-proof-attempt-unknown",
          controllerToken: "ccc-proof-controller-unknown",
          state: "dispatched_unknown" as const,
        }),
        begin: async () => ({
          kind: "dispatched-unknown" as const,
          attempt: { state: "dispatched_unknown" as const },
        }),
        settle: vi.fn(),
      },
      runVerification,
    });

    await expect(handler(f.node, {
      task: f.task,
      settings: {},
      context: {},
      execution: {
        originTaskId: f.task.id,
        semanticTaskId: f.semanticTaskId,
        nativeTaskId: f.task.id,
        semanticTask: f.task,
        runId: "RUN-proof",
        visitIdentity: { nodeId: f.node.id, materializedNodeId: f.node.id },
        executionFence: {
          workItemId: "WORK-proof",
          leaseOwner: "proof-worker",
          attempt: 1,
          runId: "RUN-proof",
        },
      },
    } as never)).rejects.toMatchObject({
      name: PermanentError.name,
      code: "CCC_CAMPAIGN_PROOF_DISPATCH_UNKNOWN",
    });
    expect(runVerification).not.toHaveBeenCalled();
  });

  it("refuses a stale live work-item lease before reserving or dispatching a verifier", async () => {
    const f = await fixture();
    const reserve = vi.fn();
    const assertCccCampaignWorkflowLeaseFence = vi.fn(async () => {
      throw new Error("expired lease");
    });
    const handler = createCccCampaignProofSuiteHandler({
      rootDir: f.repo,
      store: {
        getTask: async () => f.task,
        getCccCampaignContextForTask: async () => f.campaign,
        getAsyncLayer: () => ({}) as never,
        assertCccCampaignWorkflowLeaseFence,
      },
      proofAttempts: {
        reserve,
        begin: vi.fn(),
        settle: vi.fn(),
      },
    });

    await expect(handler(f.node, {
      task: f.task,
      settings: {},
      context: {},
      execution: {
        originTaskId: f.task.id,
        semanticTaskId: f.semanticTaskId,
        nativeTaskId: f.task.id,
        semanticTask: f.task,
        runId: "RUN-proof",
        visitIdentity: { nodeId: f.node.id, materializedNodeId: f.node.id },
        executionFence: {
          workItemId: "WORK-proof",
          leaseOwner: "proof-worker",
          attempt: 1,
          runId: "RUN-proof",
        },
      },
    } as never)).rejects.toMatchObject({
      name: PermanentError.name,
      code: "CCC_CAMPAIGN_PROOF_FENCE_REFUSED",
    });
    expect(assertCccCampaignWorkflowLeaseFence).toHaveBeenCalledWith({
      workItemId: "WORK-proof",
      originTaskId: f.task.id,
      leaseOwner: "proof-worker",
      attempt: 1,
      runId: "RUN-proof",
    });
    expect(reserve).not.toHaveBeenCalled();
  });
});
