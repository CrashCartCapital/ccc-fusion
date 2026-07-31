import { execFile as execFileCallback, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CccCampaignProductExecutionRoute,
  CccCampaignTaskContext,
  Settings,
  TaskDetail,
  TaskStore,
  WorkflowIrNode,
} from "@fusion/core";
import { TaskExecutor } from "../executor.js";
import type {
  WorkflowNodeExecutionContext,
  WorkflowNodeResult,
} from "../workflow-graph-executor.js";

const execFile = promisify(execFileCallback);
const hasGit = spawnSync("git", ["--version"], { stdio: "pipe" }).status === 0;
const describeIfGit = hasGit ? describe : describe.skip;
const REFUSAL_CODE = "CCC_CAMPAIGN_REQUIRED_COMMIT_REFUSED";

type ExecutorShape = "model" | "cli-agent";

type Fixture = {
  baseCommit: string;
  branch: string;
  context: CccCampaignTaskContext;
  rootDir: string;
  store: TaskStore;
  task: TaskDetail;
  worktree: string;
};

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFile("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  return result.stdout.trim();
}

function route(taskId: string, shape: ExecutorShape): CccCampaignProductExecutionRoute {
  return {
    taskId,
    providerId: "deterministic-fake",
    modelId: "fixture-v2",
    transport: shape === "cli-agent" ? "cli" : "pi",
    executor: shape,
    toolMode: "coding",
    worktreeMode: "isolated",
    ownedPaths: ["src/task-0"],
    allowedWriteRoots: ["src/task-0"],
    commitPolicy: "required",
    ...(shape === "cli-agent" ? { cliAdapterId: "test-cli-adapter" } : {}),
  };
}

function campaignContext(
  taskId: string,
  rootDir: string,
  baseCommit: string,
  executionRoute: CccCampaignProductExecutionRoute,
): CccCampaignTaskContext {
  return {
    schema: "ccc-campaign.context.v1",
    projectId: "project-1",
    importId: "import-1",
    idempotencyKey: "idem-1",
    campaignId: "campaign-1",
    taskId,
    semanticTaskId: taskId,
    proofIds: ["proof-1"],
    protectedActionIds: [],
    packetHash: "a".repeat(64),
    sidecarHash: "b".repeat(64),
    bundleHash: "c".repeat(64),
    manifestHash: "d".repeat(64),
    sourceVersion: "required-commit-test",
    targetRepository: { path: rootDir, baseCommit },
    bounds: { maxRequests: 1, maxDurationMs: 60_000, maxConcurrency: 1 },
    campaignStartedAt: "2026-07-30T00:00:00.000Z",
    campaignDeadlineAt: "2026-07-30T00:01:00.000Z",
    admittedWriteRoots: [{ path: rootDir, purpose: "disposable test target" }],
    proofs: [],
    protectedActions: [],
    executionPolicy: {
      schema: "ccc-campaign.execution-policy.v2",
      routes: [executionRoute],
    },
    route: executionRoute,
    requestCount: 0,
    activeActionLeases: {},
  };
}

function sealedExecutionContext(task: TaskDetail): WorkflowNodeExecutionContext {
  const executionFence = Object.freeze({
    workItemId: "work-item-1",
    leaseOwner: "lease-owner-1",
    attempt: 1,
    runId: "run-1",
  });
  const visitIdentity = Object.freeze({
    nodeId: "coding-node",
    materializedNodeId: "coding-node",
  });
  return Object.freeze({
    task,
    settings: undefined,
    context: {},
    execution: Object.freeze({
      originTaskId: task.id,
      semanticTaskId: task.id,
      nativeTaskId: task.id,
      semanticTask: task,
      runId: "run-1",
      visitIdentity,
      executionFence,
    }),
  });
}

function node(shape: ExecutorShape): WorkflowIrNode {
  return {
    id: "coding-node",
    kind: "prompt",
    config: shape === "cli-agent"
      ? {
        executor: "cli-agent",
        cliAdapterId: "test-cli-adapter",
        cliSettings: {
          profile: "ccc-fusion",
          providerId: "deterministic-fake",
          model: "fixture-v2",
        },
      }
      : {
        executor: "model",
        modelProvider: "deterministic-fake",
        modelId: "fixture-v2",
      },
  };
}

describeIfGit("CCC campaign required-commit post-node fence", { timeout: 30_000 }, () => {
  const scratchRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(scratchRoots.splice(0).map((path) =>
      rm(path, { recursive: true, force: true })));
  });

  async function fixture(shape: ExecutorShape = "model"): Promise<Fixture> {
    const scratch = await mkdtemp(join(tmpdir(), "fusion-ccc-required-commit-"));
    scratchRoots.push(scratch);
    const rootDir = join(scratch, "target");
    const worktree = join(scratch, "task-worktree");
    const taskId = "TASK-required-commit";
    const branch = "fusion/task-required-commit";

    await mkdir(join(rootDir, "src", "task-0"), { recursive: true });
    await git(rootDir, "init", "-b", "main");
    await git(rootDir, "config", "user.email", "test@example.com");
    await git(rootDir, "config", "user.name", "Test User");
    await writeFile(join(rootDir, "README.md"), "base\n", "utf8");
    await writeFile(join(rootDir, "src", "task-0", "base.txt"), "base\n", "utf8");
    await git(rootDir, "add", "--", "README.md", "src/task-0/base.txt");
    await git(rootDir, "commit", "-m", "base");
    const baseCommit = await git(rootDir, "rev-parse", "HEAD");
    await git(rootDir, "worktree", "add", "-b", branch, worktree, baseCommit);

    const executionRoute = route(taskId, shape);
    const task = {
      id: taskId,
      title: "Required commit task",
      description: "Must produce an admitted commit.",
      column: "in-progress",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      worktree,
      branch,
      baseCommitSha: baseCommit,
      modelProvider: executionRoute.providerId,
      modelId: executionRoute.modelId,
      customFields: { cccFusionProfile: "ccc-fusion" },
      createdAt: "2026-07-30T00:00:00.000Z",
      updatedAt: "2026-07-30T00:00:00.000Z",
    } as TaskDetail;
    const context = campaignContext(taskId, rootDir, baseCommit, executionRoute);
    const store = {
      on: vi.fn(),
      getTask: vi.fn(async (id: string) => id === taskId ? task : undefined),
      getCccCampaignContextForTask: vi.fn(async (id: string) =>
        id === taskId ? context : null),
      assertCccCampaignWorkflowLeaseFence: vi.fn(async () => undefined),
    } as unknown as TaskStore;

    return { baseCommit, branch, context, rootDir, store, task, worktree };
  }

  async function runSuccessfulNode(
    h: Fixture,
    shape: ExecutorShape = "model",
  ): Promise<WorkflowNodeResult> {
    const executor = new TaskExecutor(h.store, h.rootDir);
    const successfulResult: WorkflowNodeResult = {
      outcome: "success",
      value: "passed",
      contextPatch: { modifiedFiles: ["untrusted-node-projection.txt"] },
    };
    vi.spyOn(executor as never, "runGraphCustomNode" as never)
      .mockResolvedValue(successfulResult as never);
    return executor.createAuthoritativeWorkflowCustomNodeRunner({} as Settings)(
      node(shape),
      h.task,
      {},
      sealedExecutionContext(h.task),
    );
  }

  async function commitAdmittedPath(h: Fixture): Promise<string> {
    await writeFile(join(h.worktree, "src", "task-0", "result.txt"), "result\n", "utf8");
    await git(h.worktree, "add", "--", "src/task-0/result.txt");
    await git(h.worktree, "commit", "-m", "campaign task result");
    return git(h.worktree, "rev-parse", "HEAD");
  }

  it.each<ExecutorShape>(["model", "cli-agent"])(
    "refuses successful %s execution with no campaign-created commit",
    async (shape) => {
      const h = await fixture(shape);

      await expect(runSuccessfulNode(h, shape)).rejects.toMatchObject({
        name: "PermanentError",
        code: REFUSAL_CODE,
        message: expect.stringContaining("campaign-created commit"),
      });
    },
  );

  it.each<ExecutorShape>(["model", "cli-agent"])(
    "creates the %s campaign commit from one admitted dirty source change",
    async (shape) => {
      const h = await fixture(shape);
      await writeFile(
        join(h.worktree, "src", "task-0", "result.txt"),
        "result\n",
        "utf8",
      );

      await expect(runSuccessfulNode(h, shape)).resolves.toEqual({
        outcome: "success",
        value: "passed",
        contextPatch: { modifiedFiles: ["untrusted-node-projection.txt"] },
      });

      const campaignHead = await git(h.worktree, "rev-parse", "HEAD");
      expect(campaignHead).not.toBe(h.baseCommit);
      expect(await git(h.rootDir, "rev-parse", "main")).toBe(h.baseCommit);
      expect(await git(h.worktree, "status", "--porcelain=v1")).toBe("");
      expect(
        await git(
          h.worktree,
          "diff",
          "--name-only",
          "--no-renames",
          h.baseCommit,
          campaignHead,
        ),
      ).toBe("src/task-0/result.txt");
      expect(await git(h.worktree, "log", "-1", "--pretty=%s")).toBe(
        `ccc-fusion campaign ${h.task.id}`,
      );
    },
  );

  it("does not run target-repository hooks while creating the controller-owned commit", async () => {
    const h = await fixture();
    const hookMarker = join(h.rootDir, "pre-commit-hook-ran");
    const commonGitDir = await git(h.worktree, "rev-parse", "--git-common-dir");
    const hook = join(
      commonGitDir.startsWith("/") ? commonGitDir : join(h.worktree, commonGitDir),
      "hooks",
      "pre-commit",
    );
    await writeFile(
      hook,
      `#!/bin/sh\n: > ${JSON.stringify(hookMarker)}\nexit 89\n`,
      "utf8",
    );
    await chmod(hook, 0o755);
    await writeFile(
      join(h.worktree, "src", "task-0", "result.txt"),
      "result\n",
      "utf8",
    );

    await expect(runSuccessfulNode(h)).resolves.toMatchObject({
      outcome: "success",
    });
    await expect(import("node:fs/promises").then(({ access }) => access(hookMarker)))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses an active Git clean filter before staging or executing it", async () => {
    const h = await fixture();
    const filterMarker = join(h.rootDir, "clean-filter-ran");
    const filterScript = join(h.rootDir, "planted-clean-filter.sh");
    const attributesPath = await git(
      h.worktree,
      "rev-parse",
      "--git-path",
      "info/attributes",
    );
    await writeFile(
      filterScript,
      `#!/bin/sh\n: > ${JSON.stringify(filterMarker)}\ncat\n`,
      "utf8",
    );
    await chmod(filterScript, 0o755);
    await mkdir(join(attributesPath, ".."), { recursive: true });
    await writeFile(
      attributesPath,
      "src/task-0/result.txt filter=planted\n",
      "utf8",
    );
    await git(h.worktree, "config", "filter.planted.clean", filterScript);
    await git(h.worktree, "config", "filter.planted.required", "true");
    await writeFile(
      join(h.worktree, "src", "task-0", "result.txt"),
      "result\n",
      "utf8",
    );

    await expect(runSuccessfulNode(h)).rejects.toMatchObject({
      name: "PermanentError",
      code: REFUSAL_CODE,
      message: expect.stringContaining("Git filter"),
    });
    await expect(import("node:fs/promises").then(({ access }) => access(filterMarker)))
      .rejects.toMatchObject({ code: "ENOENT" });
    expect(await git(h.worktree, "rev-parse", "HEAD")).toBe(h.baseCommit);
    expect(await git(h.worktree, "diff", "--cached", "--name-only")).toBe("");
  });

  it("rechecks the live work-item fence before mutating Git", async () => {
    const h = await fixture();
    vi.mocked(h.store.assertCccCampaignWorkflowLeaseFence)
      .mockRejectedValueOnce(new Error("lease expired"));
    await writeFile(
      join(h.worktree, "src", "task-0", "result.txt"),
      "result\n",
      "utf8",
    );

    await expect(runSuccessfulNode(h)).rejects.toMatchObject({
      name: "PermanentError",
      code: REFUSAL_CODE,
      message: expect.stringContaining("lease"),
    });
    expect(await git(h.worktree, "rev-parse", "HEAD")).toBe(h.baseCommit);
    expect(await git(h.worktree, "diff", "--cached", "--name-only")).toBe("");
  });

  it("refuses a dirty registered task worktree", async () => {
    const h = await fixture();
    await commitAdmittedPath(h);
    await writeFile(join(h.worktree, "src", "task-0", "dirty.txt"), "dirty\n", "utf8");

    await expect(runSuccessfulNode(h)).rejects.toMatchObject({
      name: "PermanentError",
      code: REFUSAL_CODE,
      message: expect.stringContaining("uncommitted changes"),
    });
  });

  it("refuses mixed admitted and foreign dirty changes without staging or committing either", async () => {
    const h = await fixture();
    await mkdir(join(h.worktree, "foreign"), { recursive: true });
    await writeFile(
      join(h.worktree, "src", "task-0", "result.txt"),
      "result\n",
      "utf8",
    );
    await writeFile(
      join(h.worktree, "foreign", "outside.txt"),
      "foreign\n",
      "utf8",
    );

    await expect(runSuccessfulNode(h)).rejects.toMatchObject({
      name: "PermanentError",
      code: REFUSAL_CODE,
      message: expect.stringContaining("outside allowedWriteRoots"),
    });
    expect(await git(h.worktree, "rev-parse", "HEAD")).toBe(h.baseCommit);
    expect(await git(h.worktree, "diff", "--cached", "--name-only")).toBe("");
    expect(await git(h.worktree, "status", "--porcelain=v1")).toContain(
      "?? foreign/",
    );
  });

  it("refuses a persisted branch ref that is not the checked-out HEAD", async () => {
    const h = await fixture();
    await commitAdmittedPath(h);
    const wrongBranch = "fusion/wrong-task-branch";
    await git(h.rootDir, "branch", wrongBranch, h.baseCommit);
    h.task.branch = wrongBranch;

    await expect(runSuccessfulNode(h)).rejects.toMatchObject({
      name: "PermanentError",
      code: REFUSAL_CODE,
      message: expect.stringContaining("persisted branch"),
    });
  });

  it("refuses a clean campaign commit that changes a foreign path", async () => {
    const h = await fixture();
    await mkdir(join(h.worktree, "foreign"), { recursive: true });
    await writeFile(join(h.worktree, "foreign", "outside.txt"), "foreign\n", "utf8");
    await git(h.worktree, "add", "--", "foreign/outside.txt");
    await git(h.worktree, "commit", "-m", "foreign campaign change");

    await expect(runSuccessfulNode(h)).rejects.toMatchObject({
      name: "PermanentError",
      code: REFUSAL_CODE,
      message: expect.stringContaining("outside allowedWriteRoots"),
    });
  });

  it("accepts one clean admitted campaign-created commit and returns the node result unchanged", async () => {
    const h = await fixture();
    await commitAdmittedPath(h);

    await expect(runSuccessfulNode(h)).resolves.toEqual({
      outcome: "success",
      value: "passed",
      contextPatch: { modifiedFiles: ["untrusted-node-projection.txt"] },
    });
  });
});
