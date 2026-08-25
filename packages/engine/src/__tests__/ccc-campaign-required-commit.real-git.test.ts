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
import { ensureCccCampaignJoinBaseBranch } from "../ccc-campaign-join-base.js";
import {
  type CccCampaignReadyCommitHandoff,
  verifyCccCampaignReadyCandidate,
} from "../ccc-campaign-ready.js";
import { enforceCccCampaignRequiredCommitAfterNode } from "../ccc-campaign-required-commit.js";
import { TransientError } from "../engine-errors.js";
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

function route(
  taskId: string,
  shape: ExecutorShape,
  writeRoot = "src/task-0",
): CccCampaignProductExecutionRoute {
  return {
    taskId,
    providerId: "deterministic-fake",
    modelId: "fixture-v2",
    transport: shape === "cli-agent" ? "cli" : "pi",
    executor: shape,
    toolMode: "coding",
    worktreeMode: "isolated",
    ownedPaths: [writeRoot],
    allowedWriteRoots: [writeRoot],
    commitPolicy: "required",
    ...(shape === "cli-agent" ? { cliAdapterId: "test-cli-adapter" } : {}),
  };
}

function campaignContext(
  taskId: string,
  rootDir: string,
  baseCommit: string,
  executionRoute: CccCampaignProductExecutionRoute,
  policyRoutes: readonly CccCampaignProductExecutionRoute[] = [executionRoute],
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
    proofs: [{
      id: "proof-1",
      requirementIds: ["REQ-required-commit"],
      command: "node -e \"process.exit(0)\"",
      positiveOracle: "candidate verifier exits zero",
      negativeControls: [],
      spans: [],
      confidence: "high",
    }],
    protectedActions: [],
    executionPolicy: {
      schema: "ccc-campaign.execution-policy.v2",
      routes: [...policyRoutes],
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

  it("reuses an exact controller-verified fingerprint without rerunning the sealed verifier", async () => {
    const h = await fixture();
    await writeFile(
      join(h.worktree, "src", "task-0", "result.txt"),
      "verified once\n",
      "utf8",
    );
    const verification = await verifyCccCampaignReadyCandidate({
      taskId: h.task.id,
      worktreePath: h.worktree,
      campaign: h.context,
      timeoutMs: 30_000,
    });
    expect(verification.ready).toBe(true);
    if (!verification.ready) throw new Error(verification.summary);
    const executionContext = sealedExecutionContext(h.task);
    const fence = executionContext.execution!.executionFence!;
    const verifiedCandidateHandoff = Object.freeze({
      taskId: verification.taskId,
      verifiedWorktreePath: verification.verifiedWorktreePath,
      verifiedStartCommit: verification.verifiedStartCommit,
      frozenBaseCommit: verification.frozenBaseCommit,
      allowedRoots: Object.freeze([...verification.allowedRoots]),
      candidateFingerprint: verification.candidateFingerprint,
      executionFence: Object.freeze({
        workItemId: fence.workItemId,
        leaseOwner: fence.leaseOwner,
        attempt: fence.attempt,
        runId: fence.runId,
      }),
    });
    h.context.proofs[0]!.command = "node -e \"process.exit(17)\"";

    await expect(enforceCccCampaignRequiredCommitAfterNode({
      rootDir: h.rootDir,
      store: h.store,
      taskId: h.task.id,
      result: { outcome: "success", value: "passed" },
      executionContext,
      verifiedCandidateHandoff,
    } as any)).resolves.toBeUndefined();

    expect(await git(h.worktree, "status", "--porcelain=v1")).toBe("");
    expect(await git(h.worktree, "rev-parse", "HEAD")).not.toBe(h.baseCommit);
  });

  it.each<[
    string,
    (handoff: CccCampaignReadyCommitHandoff) => CccCampaignReadyCommitHandoff,
  ]>([
    ["task id", (handoff) => Object.freeze({ ...handoff, taskId: "TASK-other" })],
    ["worktree", (handoff) => Object.freeze({
      ...handoff,
      verifiedWorktreePath: `${handoff.verifiedWorktreePath}-other`,
    })],
    ["start commit", (handoff) => Object.freeze({
      ...handoff,
      verifiedStartCommit: "0".repeat(40),
    })],
    ["frozen base", (handoff) => Object.freeze({
      ...handoff,
      frozenBaseCommit: "0".repeat(40),
    })],
    ["allowed roots", (handoff) => Object.freeze({
      ...handoff,
      allowedRoots: Object.freeze(["src/other"]),
    })],
    ["execution fence", (handoff) => Object.freeze({
      ...handoff,
      executionFence: Object.freeze({
        ...handoff.executionFence,
        attempt: handoff.executionFence.attempt + 1,
      }),
    })],
    ["fingerprint", (handoff) => Object.freeze({
      ...handoff,
      candidateFingerprint: "not-a-sha256",
    })],
    ["top-level freeze", (handoff) => ({ ...handoff })],
    ["nested freeze", (handoff) => Object.freeze({
      ...handoff,
      executionFence: { ...handoff.executionFence },
    })],
    ["allowed-roots freeze", (handoff) => Object.freeze({
      ...handoff,
      allowedRoots: [...handoff.allowedRoots],
    })],
  ])("refuses a verified candidate handoff with mismatched %s", async (_label, mutate) => {
    const h = await fixture();
    await writeFile(
      join(h.worktree, "src", "task-0", "result.txt"),
      "verified once\n",
      "utf8",
    );
    const verification = await verifyCccCampaignReadyCandidate({
      taskId: h.task.id,
      worktreePath: h.worktree,
      campaign: h.context,
      timeoutMs: 30_000,
    });
    expect(verification.ready).toBe(true);
    if (!verification.ready) throw new Error(verification.summary);
    const executionContext = sealedExecutionContext(h.task);
    const fence = executionContext.execution!.executionFence!;
    const validHandoff = Object.freeze({
      taskId: verification.taskId,
      verifiedWorktreePath: verification.verifiedWorktreePath,
      verifiedStartCommit: verification.verifiedStartCommit,
      frozenBaseCommit: verification.frozenBaseCommit,
      allowedRoots: Object.freeze([...verification.allowedRoots]),
      candidateFingerprint: verification.candidateFingerprint,
      executionFence: Object.freeze({
        workItemId: fence.workItemId,
        leaseOwner: fence.leaseOwner,
        attempt: fence.attempt,
        runId: fence.runId,
      }),
    });

    await expect(enforceCccCampaignRequiredCommitAfterNode({
      rootDir: h.rootDir,
      store: h.store,
      taskId: h.task.id,
      result: { outcome: "success", value: "passed" },
      executionContext,
      verifiedCandidateHandoff: mutate(validHandoff),
    })).rejects.toMatchObject({
      name: "PermanentError",
      code: REFUSAL_CODE,
    });

    expect(await git(h.worktree, "rev-parse", "HEAD")).toBe(h.baseCommit);
    expect(await git(h.worktree, "diff", "--cached", "--name-only")).toBe("");
  });

  it(
    "unresolved_mutating_turn_never_commits: refuses to commit a dirty diff "
      + "left behind by a turn whose provider session never settled",
    async () => {
      const h = await fixture();
      await writeFile(
        join(h.worktree, "src", "task-0", "result.txt"),
        "result\n",
        "utf8",
      );

      // Model a turn that mutated the tree (the writeFile above already landed
      // it) and then ended UNRESOLVED -- failed, timed out, or cancelled --
      // instead of settling into a WorkflowNodeResult. WorkflowNodeOutcome
      // (workflow-graph-executor.ts:55) is only ever "success" | "failure"; an
      // unresolved turn has no outcome value to report at all, so the only way
      // to represent it here is a REJECTED runGraphCustomNode promise instead
      // of a resolved one. runGraphCustomNodeWithRequiredCommitFence
      // (executor.ts:9503-9547) awaits that call with no try/catch, so this
      // rejection skips enforceCccCampaignRequiredCommitAfterNode entirely --
      // the one gate that ever inspects a dirty diff before committing it --
      // leaving the tool's already-written file completely unvetted.
      const executor = new TaskExecutor(h.store, h.rootDir);
      vi.spyOn(executor as never, "runGraphCustomNode" as never)
        .mockRejectedValue(new Error("workflow step timed out after 60000ms"));

      await expect(
        executor.createAuthoritativeWorkflowCustomNodeRunner({} as Settings)(
          node("model"),
          h.task,
          {},
          sealedExecutionContext(h.task),
        ),
      ).rejects.toMatchObject({
        name: "PermanentError",
        code: REFUSAL_CODE,
        message: expect.stringMatching(/turn|attempt/i),
      });
    },
  );

  it(
    "classified_mutating_turn_binds_custody_without_erasing_retry_classification",
    async () => {
      const h = await fixture();
      await writeFile(
        join(h.worktree, "src", "task-0", "result.txt"),
        "result\n",
        "utf8",
      );
      const rejection = new TransientError(
        "provider retry",
        "CCC_TRANSIENT",
      );
      const executor = new TaskExecutor(h.store, h.rootDir);
      vi.spyOn(executor as never, "runGraphCustomNode" as never)
        .mockRejectedValue(rejection);

      await expect(
        executor.createAuthoritativeWorkflowCustomNodeRunner({} as Settings)(
          node("model"),
          h.task,
          {},
          sealedExecutionContext(h.task),
        ),
      ).rejects.toBe(rejection);

      expect(rejection).toMatchObject({
        name: "TransientError",
        code: "CCC_TRANSIENT",
        retryable: true,
        message: "provider retry",
      });
      expect(h.store.assertCccCampaignWorkflowLeaseFence).toHaveBeenCalledTimes(1);
      expect(await git(h.worktree, "rev-parse", "HEAD")).toBe(h.baseCommit);
      expect(await git(h.worktree, "status", "--porcelain=v1")).toContain(
        "?? src/task-0/result.txt",
      );
    },
  );

  it(
    "classified_mutating_turn_refuses_out_of_scope_candidate_before_rethrow",
    async () => {
      const h = await fixture();
      await writeFile(
        join(h.worktree, "README.md"),
        "out-of-scope mutation\n",
        "utf8",
      );
      const executor = new TaskExecutor(h.store, h.rootDir);
      vi.spyOn(executor as never, "runGraphCustomNode" as never)
        .mockRejectedValue(new TransientError("provider retry", "CCC_TRANSIENT"));

      await expect(
        executor.createAuthoritativeWorkflowCustomNodeRunner({} as Settings)(
          node("model"),
          h.task,
          {},
          sealedExecutionContext(h.task),
        ),
      ).rejects.toMatchObject({
        name: "PermanentError",
        code: REFUSAL_CODE,
        message: expect.stringMatching(/outside allowedWriteRoots/i),
      });

      expect(await git(h.worktree, "rev-parse", "HEAD")).toBe(h.baseCommit);
      expect(await git(h.worktree, "status", "--porcelain=v1")).toContain(
        "M README.md",
      );
    },
  );

  it(
    "resolved_failed_turn_refuses_out_of_scope_candidate_before_return",
    async () => {
      const h = await fixture();
      await writeFile(
        join(h.worktree, "README.md"),
        "out-of-scope mutation\n",
        "utf8",
      );
      const executor = new TaskExecutor(h.store, h.rootDir);
      vi.spyOn(executor as never, "runGraphCustomNode" as never)
        .mockResolvedValue({ outcome: "failure", value: "failed" } as never);

      await expect(
        executor.createAuthoritativeWorkflowCustomNodeRunner({} as Settings)(
          node("model"),
          h.task,
          {},
          sealedExecutionContext(h.task),
        ),
      ).rejects.toMatchObject({
        name: "PermanentError",
        code: REFUSAL_CODE,
        message: expect.stringMatching(/outside allowedWriteRoots/i),
      });

      expect(await git(h.worktree, "rev-parse", "HEAD")).toBe(h.baseCommit);
      expect(await git(h.worktree, "status", "--porcelain=v1")).toContain(
        "M README.md",
      );
    },
  );

  it("refuses to stage a dirty candidate when the fresh sealed readiness verifier fails", async () => {
    const h = await fixture();
    h.context.proofs[0]!.command = "node -e \"process.exit(17)\"";
    await writeFile(
      join(h.worktree, "src", "task-0", "result.txt"),
      "result\n",
      "utf8",
    );

    await expect(runSuccessfulNode(h)).rejects.toMatchObject({
      name: "PermanentError",
      code: REFUSAL_CODE,
      message: expect.stringMatching(/readiness|verifier/i),
    });
    expect(await git(h.worktree, "rev-parse", "HEAD")).toBe(h.baseCommit);
    expect(await git(h.worktree, "diff", "--cached", "--name-only")).toBe("");
  });

  it("refuses an admitted mutation that lands after readiness proof but before staging", async () => {
    const h = await fixture();
    const candidatePath = join(h.worktree, "src", "task-0", "result.txt");
    await writeFile(candidatePath, "verified bytes\n", "utf8");
    vi.mocked(h.store.assertCccCampaignWorkflowLeaseFence)
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(async () => {
        await writeFile(candidatePath, "late unverified bytes\n", "utf8");
      });

    await expect(runSuccessfulNode(h)).rejects.toMatchObject({
      name: "PermanentError",
      code: REFUSAL_CODE,
      message: expect.stringMatching(/changed after readiness|fingerprint/i),
    });
    expect(await git(h.worktree, "rev-parse", "HEAD")).toBe(h.baseCommit);
    expect(await git(h.worktree, "diff", "--cached", "--name-only")).toBe("");
  });

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

  /*
   * Chained M1 campaign tasks.
   *
   * A multi-task import links native tasks through `dependencies` and the
   * executor forks a successor's worktree directly from its predecessor's tip
   * (executor.ts:9272-9299) so the campaign proof gate's per-task ancestry loop
   * holds. That makes the frozen campaign base the WRONG reference for a
   * successor: its worktree legitimately starts at the predecessor's campaign
   * commit, and every check that compares against the frozen base is either too
   * strict (refuses a legitimate successor) or too weak (accepts a successor
   * that committed nothing of its own).
   */
  const CHAIN_IMPORT_ID = "0123456789abcdef01234567";

  type ChainFixture = {
    baseCommit: string;
    commitA: string;
    rootDir: string;
    store: TaskStore;
    taskA: TaskDetail;
    taskB: TaskDetail;
    worktreeA: string;
    worktreeB: string;
  };

  async function chainFixture(): Promise<ChainFixture> {
    const scratch = await mkdtemp(join(tmpdir(), "fusion-ccc-required-commit-chain-"));
    scratchRoots.push(scratch);
    const rootDir = join(scratch, "target");
    const worktreeA = join(scratch, "task-a-worktree");
    const worktreeB = join(scratch, "task-b-worktree");
    const taskAId = "TASK-chain-a";
    const taskBId = "TASK-chain-b";
    const branchA = "fusion/task-chain-a";
    const branchB = "fusion/task-chain-b";

    await mkdir(rootDir, { recursive: true });
    await git(rootDir, "init", "-b", "main");
    await git(rootDir, "config", "user.email", "test@example.com");
    await git(rootDir, "config", "user.name", "Test User");
    await writeFile(join(rootDir, "README.md"), "base\n", "utf8");
    await git(rootDir, "add", "--", "README.md");
    await git(rootDir, "commit", "-m", "base");
    const baseCommit = await git(rootDir, "rev-parse", "HEAD");

    // Predecessor: its own worktree from the frozen base, with its campaign commit.
    await git(rootDir, "worktree", "add", "-b", branchA, worktreeA, baseCommit);
    await mkdir(join(worktreeA, "src", "task-a"), { recursive: true });
    await writeFile(join(worktreeA, "src", "task-a", "result.txt"), "a\n", "utf8");
    await git(worktreeA, "add", "--", "src/task-a/result.txt");
    await git(worktreeA, "commit", "-m", `ccc-fusion campaign ${taskAId}`);
    const commitA = await git(worktreeA, "rev-parse", "HEAD");

    // Successor: forked from the predecessor's tip, exactly as the executor does.
    await git(rootDir, "worktree", "add", "-b", branchB, worktreeB, commitA);
    await mkdir(join(worktreeB, "src", "task-b"), { recursive: true });

    const routeA = route(taskAId, "model", "src/task-a");
    const routeB = route(taskBId, "model", "src/task-b");
    const policyRoutes = [routeA, routeB];

    const taskA = {
      id: taskAId,
      title: "Chain predecessor",
      description: "First task in the serial campaign chain.",
      column: "in-review",
      lineageId: `ccc-prd:${CHAIN_IMPORT_ID}:${taskAId}`,
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      worktree: worktreeA,
      branch: branchA,
      baseCommitSha: baseCommit,
      modelProvider: routeA.providerId,
      modelId: routeA.modelId,
      customFields: { cccFusionProfile: "ccc-fusion" },
      createdAt: "2026-07-30T00:00:00.000Z",
      updatedAt: "2026-07-30T00:00:00.000Z",
    } as TaskDetail;
    const taskB = {
      ...taskA,
      id: taskBId,
      title: "Chain successor",
      description: "Second task in the serial campaign chain.",
      column: "in-progress",
      lineageId: `ccc-prd:${CHAIN_IMPORT_ID}:${taskBId}`,
      dependencies: [taskAId],
      worktree: worktreeB,
      branch: branchB,
    } as TaskDetail;

    const tasks = new Map([[taskAId, taskA], [taskBId, taskB]]);
    const contexts = new Map([
      [taskAId, campaignContext(taskAId, rootDir, baseCommit, routeA, policyRoutes)],
      [taskBId, campaignContext(taskBId, rootDir, baseCommit, routeB, policyRoutes)],
    ]);
    const store = {
      on: vi.fn(),
      getTask: vi.fn(async (id: string) => tasks.get(id)),
      getCccCampaignContextForTask: vi.fn(async (id: string) => contexts.get(id) ?? null),
      assertCccCampaignWorkflowLeaseFence: vi.fn(async () => undefined),
    } as unknown as TaskStore;

    return { baseCommit, commitA, rootDir, store, taskA, taskB, worktreeA, worktreeB };
  }

  async function runSuccessfulChainNode(
    h: ChainFixture,
    task: TaskDetail,
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
      node("model"),
      task,
      {},
      sealedExecutionContext(task),
    );
  }

  it("commits a chained successor's dirty change when its worktree starts at the predecessor's tip", async () => {
    const h = await chainFixture();
    await writeFile(join(h.worktreeB, "src", "task-b", "result.txt"), "b\n", "utf8");

    await expect(runSuccessfulChainNode(h, h.taskB)).resolves.toEqual({
      outcome: "success",
      value: "passed",
      contextPatch: { modifiedFiles: ["untrusted-node-projection.txt"] },
    });

    const successorHead = await git(h.worktreeB, "rev-parse", "HEAD");
    expect(successorHead).not.toBe(h.commitA);
    expect(await git(h.worktreeB, "status", "--porcelain=v1")).toBe("");
    // The successor's own commit changes only its own admitted root.
    expect(
      await git(
        h.worktreeB,
        "diff",
        "--name-only",
        "--no-renames",
        h.commitA,
        successorHead,
      ),
    ).toBe("src/task-b/result.txt");
    expect(await git(h.worktreeB, "log", "-1", "--pretty=%s")).toBe(
      `ccc-fusion campaign ${h.taskB.id}`,
    );
  });

  it("refuses a chained successor that produced no campaign-created commit of its own", async () => {
    const h = await chainFixture();

    await expect(runSuccessfulChainNode(h, h.taskB)).rejects.toMatchObject({
      name: "PermanentError",
      code: REFUSAL_CODE,
      message: expect.stringContaining("no campaign-created commit"),
    });
    expect(await git(h.worktreeB, "rev-parse", "HEAD")).toBe(h.commitA);
  });

  it("names the predecessor and its campaign commit when refusing a chained successor", async () => {
    const h = await chainFixture();

    await expect(runSuccessfulChainNode(h, h.taskB)).rejects.toMatchObject({
      message: expect.stringContaining(h.commitA),
    });
    await expect(runSuccessfulChainNode(h, h.taskB)).rejects.toMatchObject({
      message: expect.stringContaining(h.taskA.id),
    });
  });

  it("refuses a chained successor whose worktree does not start at the predecessor's commit", async () => {
    const h = await chainFixture();
    // Model a successor wrongly forked from the frozen base: dirty, off-chain.
    await git(h.rootDir, "worktree", "remove", "--force", h.worktreeB);
    await git(h.rootDir, "branch", "-D", h.taskB.branch as string);
    await git(h.rootDir, "worktree", "add", "-b", h.taskB.branch as string, h.worktreeB, h.baseCommit);
    await mkdir(join(h.worktreeB, "src", "task-b"), { recursive: true });
    await writeFile(join(h.worktreeB, "src", "task-b", "result.txt"), "b\n", "utf8");

    await expect(runSuccessfulChainNode(h, h.taskB)).rejects.toMatchObject({
      name: "PermanentError",
      code: REFUSAL_CODE,
      message: expect.stringContaining("uncommitted changes"),
    });
    expect(await git(h.worktreeB, "rev-parse", "HEAD")).toBe(h.baseCommit);
    expect(await git(h.worktreeB, "diff", "--cached", "--name-only")).toBe("");
  });

  it("refuses a chained successor whose predecessor campaign commit cannot be derived", async () => {
    const h = await chainFixture();
    h.taskA.worktree = join(h.rootDir, "..", "worktree-that-does-not-exist");
    h.taskA.branch = undefined;
    await writeFile(join(h.worktreeB, "src", "task-b", "result.txt"), "b\n", "utf8");

    await expect(runSuccessfulChainNode(h, h.taskB)).rejects.toMatchObject({
      name: "PermanentError",
      code: REFUSAL_CODE,
      message: expect.stringContaining(h.taskA.id),
    });
    expect(await git(h.worktreeB, "rev-parse", "HEAD")).toBe(h.commitA);
    expect(await git(h.worktreeB, "diff", "--cached", "--name-only")).toBe("");
  });

  it("refuses a join successor whose declared predecessor row cannot be loaded", async () => {
    const h = await chainFixture();
    h.taskB.dependencies = [h.taskA.id, "TASK-chain-other"];
    await writeFile(join(h.worktreeB, "src", "task-b", "result.txt"), "b\n", "utf8");

    await expect(runSuccessfulChainNode(h, h.taskB)).rejects.toMatchObject({
      name: "PermanentError",
      code: REFUSAL_CODE,
      message: expect.stringContaining("TASK-chain-other"),
    });
    expect(await git(h.worktreeB, "rev-parse", "HEAD")).toBe(h.commitA);
  });

  /*
   * Fan-in join tasks (series-parallel campaigns). A join task declares more
   * than one dependency predecessor and its worktree starts from the merged
   * join base branch the executor built (ccc-campaign-join-base.ts). The
   * expected start commit is that join base tip — which must itself contain
   * EVERY predecessor's campaign commit, or the campaign silently lost a
   * branch's work.
   */
  type JoinFixture = {
    baseCommit: string;
    commitB: string;
    commitC: string;
    joinBranch: string;
    joinTip: string;
    rootDir: string;
    store: TaskStore;
    taskB: TaskDetail;
    taskC: TaskDetail;
    taskD: TaskDetail;
    worktreeD: string;
  };

  async function joinFixture(): Promise<JoinFixture> {
    const scratch = await mkdtemp(join(tmpdir(), "fusion-ccc-required-commit-join-"));
    scratchRoots.push(scratch);
    const rootDir = join(scratch, "target");
    const worktreeB = join(scratch, "task-b-worktree");
    const worktreeC = join(scratch, "task-c-worktree");
    const worktreeD = join(scratch, "task-d-worktree");
    const taskBId = "TASK-join-b";
    const taskCId = "TASK-join-c";
    const taskDId = "TASK-join-d";
    const branchB = "fusion/task-join-b";
    const branchC = "fusion/task-join-c";
    const branchD = "fusion/task-join-d";

    await mkdir(rootDir, { recursive: true });
    await git(rootDir, "init", "-b", "main");
    await git(rootDir, "config", "user.email", "test@example.com");
    await git(rootDir, "config", "user.name", "Test User");
    await writeFile(join(rootDir, "README.md"), "base\n", "utf8");
    await git(rootDir, "add", "--", "README.md");
    await git(rootDir, "commit", "-m", "base");
    const baseCommit = await git(rootDir, "rev-parse", "HEAD");

    // Two parallel branch tasks, each with its own campaign commit.
    await git(rootDir, "worktree", "add", "-b", branchB, worktreeB, baseCommit);
    await mkdir(join(worktreeB, "src", "task-b"), { recursive: true });
    await writeFile(join(worktreeB, "src", "task-b", "result.txt"), "b\n", "utf8");
    await git(worktreeB, "add", "--", "src/task-b/result.txt");
    await git(worktreeB, "commit", "-m", `ccc-fusion campaign ${taskBId}`);
    const commitB = await git(worktreeB, "rev-parse", "HEAD");

    await git(rootDir, "worktree", "add", "-b", branchC, worktreeC, baseCommit);
    await mkdir(join(worktreeC, "src", "task-c"), { recursive: true });
    await writeFile(join(worktreeC, "src", "task-c", "result.txt"), "c\n", "utf8");
    await git(worktreeC, "add", "--", "src/task-c/result.txt");
    await git(worktreeC, "commit", "-m", `ccc-fusion campaign ${taskCId}`);
    const commitC = await git(worktreeC, "rev-parse", "HEAD");

    // The executor's join base: merge of both predecessor branches.
    const joinBranch = await ensureCccCampaignJoinBaseBranch({
      rootDir,
      taskId: taskDId,
      predecessors: [
        { taskId: taskBId, branch: branchB },
        { taskId: taskCId, branch: branchC },
      ],
    });
    const joinTip = await git(rootDir, "rev-parse", `refs/heads/${joinBranch}`);

    // The join task's worktree forks from the join base tip.
    await git(rootDir, "worktree", "add", "-b", branchD, worktreeD, joinTip);
    await mkdir(join(worktreeD, "src", "task-d"), { recursive: true });

    const routeB = route(taskBId, "model", "src/task-b");
    const routeC = route(taskCId, "model", "src/task-c");
    const routeD = route(taskDId, "model", "src/task-d");
    const policyRoutes = [routeB, routeC, routeD];

    const common = {
      steps: [],
      currentStep: 0,
      log: [],
      baseCommitSha: baseCommit,
      customFields: { cccFusionProfile: "ccc-fusion" },
      createdAt: "2026-07-30T00:00:00.000Z",
      updatedAt: "2026-07-30T00:00:00.000Z",
    };
    const taskB = {
      ...common,
      id: taskBId,
      title: "Join predecessor B",
      description: "First parallel branch task.",
      column: "in-review",
      lineageId: `ccc-prd:${CHAIN_IMPORT_ID}:${taskBId}`,
      dependencies: [],
      worktree: worktreeB,
      branch: branchB,
      modelProvider: routeB.providerId,
      modelId: routeB.modelId,
    } as TaskDetail;
    const taskC = {
      ...common,
      id: taskCId,
      title: "Join predecessor C",
      description: "Second parallel branch task.",
      column: "in-review",
      lineageId: `ccc-prd:${CHAIN_IMPORT_ID}:${taskCId}`,
      dependencies: [],
      worktree: worktreeC,
      branch: branchC,
      modelProvider: routeC.providerId,
      modelId: routeC.modelId,
    } as TaskDetail;
    const taskD = {
      ...common,
      id: taskDId,
      title: "Join task",
      description: "Fan-in join task depending on both branches.",
      column: "in-progress",
      lineageId: `ccc-prd:${CHAIN_IMPORT_ID}:${taskDId}`,
      dependencies: [taskBId, taskCId],
      worktree: worktreeD,
      branch: branchD,
      modelProvider: routeD.providerId,
      modelId: routeD.modelId,
    } as TaskDetail;

    const tasks = new Map([[taskBId, taskB], [taskCId, taskC], [taskDId, taskD]]);
    const contexts = new Map([
      [taskBId, campaignContext(taskBId, rootDir, baseCommit, routeB, policyRoutes)],
      [taskCId, campaignContext(taskCId, rootDir, baseCommit, routeC, policyRoutes)],
      [taskDId, campaignContext(taskDId, rootDir, baseCommit, routeD, policyRoutes)],
    ]);
    const store = {
      on: vi.fn(),
      getTask: vi.fn(async (id: string) => tasks.get(id)),
      getCccCampaignContextForTask: vi.fn(async (id: string) => contexts.get(id) ?? null),
      assertCccCampaignWorkflowLeaseFence: vi.fn(async () => undefined),
    } as unknown as TaskStore;

    return {
      baseCommit,
      commitB,
      commitC,
      joinBranch,
      joinTip,
      rootDir,
      store,
      taskB,
      taskC,
      taskD,
      worktreeD,
    };
  }

  async function runSuccessfulJoinNode(
    h: JoinFixture,
    task: TaskDetail,
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
      node("model"),
      task,
      {},
      sealedExecutionContext(task),
    );
  }

  it("commits a join successor's dirty change when its worktree starts at the merged join base", async () => {
    const h = await joinFixture();
    await writeFile(join(h.worktreeD, "src", "task-d", "result.txt"), "d\n", "utf8");

    await expect(runSuccessfulJoinNode(h, h.taskD)).resolves.toEqual({
      outcome: "success",
      value: "passed",
      contextPatch: { modifiedFiles: ["untrusted-node-projection.txt"] },
    });

    const joinHead = await git(h.worktreeD, "rev-parse", "HEAD");
    expect(joinHead).not.toBe(h.joinTip);
    expect(await git(h.worktreeD, "status", "--porcelain=v1")).toBe("");
    // The join task's own commit changes only its own admitted root — the
    // predecessors' work arrived through the join base merge, not this diff.
    expect(
      await git(
        h.worktreeD,
        "diff",
        "--name-only",
        "--no-renames",
        h.joinTip,
        joinHead,
      ),
    ).toBe("src/task-d/result.txt");
    // Both predecessors' campaign commits are ancestors of the join HEAD.
    await git(h.worktreeD, "merge-base", "--is-ancestor", h.commitB, joinHead);
    await git(h.worktreeD, "merge-base", "--is-ancestor", h.commitC, joinHead);
  });

  it("refuses a join successor that produced no campaign-created commit of its own", async () => {
    const h = await joinFixture();

    await expect(runSuccessfulJoinNode(h, h.taskD)).rejects.toMatchObject({
      name: "PermanentError",
      code: REFUSAL_CODE,
      message: expect.stringContaining("no campaign-created commit"),
    });
    expect(await git(h.worktreeD, "rev-parse", "HEAD")).toBe(h.joinTip);
  });

  it("refuses a join successor whose join base branch is unresolvable", async () => {
    const h = await joinFixture();
    await git(h.rootDir, "branch", "-D", h.joinBranch);
    await writeFile(join(h.worktreeD, "src", "task-d", "result.txt"), "d\n", "utf8");

    await expect(runSuccessfulJoinNode(h, h.taskD)).rejects.toMatchObject({
      name: "PermanentError",
      code: REFUSAL_CODE,
      message: expect.stringContaining(h.joinBranch),
    });
    expect(await git(h.worktreeD, "rev-parse", "HEAD")).toBe(h.joinTip);
    expect(await git(h.worktreeD, "diff", "--cached", "--name-only")).toBe("");
  });

  it("refuses a join successor whose join base is missing a predecessor's campaign commit", async () => {
    const h = await joinFixture();
    // Corrupt the join base: point it at just one predecessor's tip.
    await git(h.rootDir, "branch", "-f", h.joinBranch, h.commitB);
    await writeFile(join(h.worktreeD, "src", "task-d", "result.txt"), "d\n", "utf8");

    await expect(runSuccessfulJoinNode(h, h.taskD)).rejects.toMatchObject({
      name: "PermanentError",
      code: REFUSAL_CODE,
      message: expect.stringContaining(h.taskC.id),
    });
  });

  it("accepts the chain entry task against the frozen base", async () => {
    const h = await chainFixture();

    await expect(runSuccessfulChainNode(h, h.taskA)).resolves.toEqual({
      outcome: "success",
      value: "passed",
      contextPatch: { modifiedFiles: ["untrusted-node-projection.txt"] },
    });
  });

  it("keeps imported-lineage entry-task no-commit refusal identical", async () => {
    const h = await fixture();
    h.task.lineageId = `ccc-prd:${CHAIN_IMPORT_ID}:${h.task.id}`;

    await expect(runSuccessfulNode(h)).rejects.toMatchObject({
      name: "PermanentError",
      code: REFUSAL_CODE,
      message: expect.stringContaining("campaign-created commit"),
    });
  });

  it("keeps imported-lineage entry-task commit creation identical", async () => {
    const h = await fixture();
    h.task.lineageId = `ccc-prd:${CHAIN_IMPORT_ID}:${h.task.id}`;
    await writeFile(
      join(h.worktree, "src", "task-0", "result.txt"),
      "result\n",
      "utf8",
    );

    await expect(runSuccessfulNode(h)).resolves.toEqual({
      outcome: "success",
      value: "passed",
      contextPatch: { modifiedFiles: ["untrusted-node-projection.txt"] },
    });
    expect(await git(h.worktree, "rev-parse", "HEAD")).not.toBe(h.baseCommit);
  });
});
