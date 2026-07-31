import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  beginCccCampaignProofAttemptDispatch,
  importCccPrdBundle,
  inspectCccPrdProductStatus,
  queryRunAuditEvents,
  reserveCccCampaignProofAttempt,
  settleCccCampaignProofAttempt,
  type ApprovalRequestActorSnapshot,
  type CccCampaignTaskContext,
  type Settings,
  type Task,
  type TaskStore,
} from "@fusion/core";
import {
  claimCccCampaignApproval,
  getApprovalRequest,
  issueCccCampaignApproval,
} from "../../../core/src/async-approval-request-store.js";
import {
  createCccPrdImportTestBundle,
  createCccPrdImportTestExecutionPolicy,
  createCccPrdImportTestProductExecutionPolicy,
  rehashCccPrdImportTestBundle,
} from "../../../core/src/__test-utils__/ccc-prd-import-fixture.js";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
} from "../../../core/src/__test-utils__/pg-test-harness.js";
import {
  casCccCampaignGitRef,
  materializeCccCampaignGitCheckout,
  prepareCccCampaignGitObjects,
  recheckCccCampaignGitObjects,
  type PrepareCccCampaignGitObjectsInput,
} from "../ccc-campaign-git-objects.js";
import {
  inspectCccCampaignLocalGit,
  runControlledCccCampaignGit,
} from "../ccc-campaign-local-git.js";
import { createCccCampaignMergeControl } from "../ccc-campaign-merge-control.js";
import { runAiMerge } from "../merger-ai.js";
import { resolveTaskWorkingBranch } from "../worktree-names.js";

function campaignContext(taskId: string, targetRoot: string): CccCampaignTaskContext {
  return {
    schema: "ccc-campaign.context.v1",
    projectId: "project-1",
    importId: "import-1",
    campaignId: "campaign-1",
    taskId,
    semanticTaskId: taskId,
    route: {
      kind: "local",
      provider: "native",
      transport: "native",
    },
    proofIds: ["proof-1"],
    requestCount: 0,
    activeActionLeases: {},
    manifestHash: "a".repeat(64),
    bundleHash: "b".repeat(64),
    sidecarHash: "c".repeat(64),
    packetHash: "d".repeat(64),
    targetRepository: {
      path: targetRoot,
      baseCommit: "e".repeat(40),
    },
    executionPolicy: {
      mode: "admitted",
      protectedActionIds: ["protected-merge-main"],
      providerMaxRequests: 0,
      maxRuntimeMs: 30_000,
      deadlineAt: "2099-01-01T00:00:00.000Z",
    },
    idempotencyKey: "campaign-merge-main",
    providerId: "native",
    modelId: "native-git",
    transport: "native",
  } as CccCampaignTaskContext;
}

function task(taskId: string): Task {
  return {
    id: taskId,
    lineageId: "lineage-1",
    title: "Campaign task",
    description: "Campaign task",
    column: "in-review",
    dependencies: [],
    steps: [],
    currentStep: 0,
    protectedActions: [],
    executionPolicy: "provider-capable",
    branch: "campaign-task",
    baseCommitSha: "e".repeat(40),
  } as Task;
}

function importedTaskWithoutCustody(taskId: string): Task {
  return {
    ...task(taskId),
    lineageId: "ccc-prd:0123456789abcdef01234567:semantic-task",
  } as Task;
}

function fakeStore(input: { task: Task; context: CccCampaignTaskContext }): TaskStore {
  return {
    getTask: async () => input.task,
    getSettings: async () => ({
      merger: { maxReviewPasses: 0 },
      defaultBranch: "main",
    } as Settings),
    getCccCampaignContextForTask: async (taskId: string) =>
      taskId === input.context.taskId ? input.context : null,
    logEntry: async () => undefined,
    appendAgentLog: async () => undefined,
    updateTask: async () => input.task,
  } as unknown as TaskStore;
}

const trackedTmpDirs = new Set<string>();
const requester: ApprovalRequestActorSnapshot = {
  actorId: "operator-1",
  actorType: "user",
  actorName: "Operator",
};
const worker: ApprovalRequestActorSnapshot = {
  actorId: "worker-1",
  actorType: "agent",
  actorName: "Worker",
};

function createForbiddenEffectRecorder() {
  const effects: string[] = [];
  return {
    effects,
    deps: {
      mergeAgent: async () => {
        effects.push("provider:mergeAgent");
        throw new Error("provider merger must not run");
      },
      reviewAgent: async () => {
        effects.push("provider:reviewAgent");
        throw new Error("provider reviewer must not run");
      },
      stashResolveAgent: async () => {
        effects.push("legacy:stashResolveAgent");
        throw new Error("legacy stash resolver must not run");
      },
    },
  };
}

function expectNoForbiddenEffects(recorder: ReturnType<typeof createForbiddenEffectRecorder>): void {
  expect(recorder.effects).toEqual([]);
}

function cleanupObjectTestRepos(): void {
  for (const dir of Array.from(trackedTmpDirs)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    trackedTmpDirs.delete(dir);
  }
}

afterAll(cleanupObjectTestRepos);

function sh(cwd: string, command: string, args: readonly string[] = []): string {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function git(cwd: string, args: readonly string[]): string {
  return sh(cwd, "git", args);
}

function makeObjectRepo(prefix = "ccc-campaign-git-objects-"): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  trackedTmpDirs.add(root);
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.name", "Test User"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(root, "README.md"), "base\n");
  git(root, ["add", "README.md"]);
  git(root, ["commit", "-m", "base"]);
  return root;
}

function makeObjectFeature(root: string, path = "src/change.txt", content = "feature\n"): string {
  git(root, ["switch", "-c", "feature"]);
  const absolutePath = join(root, path);
  if (!existsSync(dirname(absolutePath))) {
    execFileSync("mkdir", ["-p", dirname(absolutePath)]);
  }
  writeFileSync(absolutePath, content);
  git(root, ["add", path]);
  git(root, ["commit", "-m", "feature"]);
  const source = git(root, ["rev-parse", "HEAD"]);
  git(root, ["switch", "--detach", "main"]);
  execFileSync("mkdir", ["-p", join(root, "src")]);
  return source;
}

function objectInput(
  root: string,
  overrides: Partial<PrepareCccCampaignGitObjectsInput> = {},
): PrepareCccCampaignGitObjectsInput {
  return {
    targetRoot: root,
    expectedBaseObject: git(root, ["rev-parse", "refs/heads/main"]),
    sourceRef: "refs/heads/feature",
    targetRef: "refs/heads/main",
    admittedWriteRoots: [join(root, "src")],
    identity: {
      name: "CCC Campaign",
      email: "ccc-campaign@example.com",
      timestamp: "2026-07-26T00:00:00Z",
    },
    message: "CCC campaign deterministic landing",
    ...overrides,
  };
}

describe("Task 5 native CCC campaign Git landing", () => {
  it("branches from merger-ai before legacy landing and binds the structured campaign marker", async () => {
    const targetRoot = mkdtempSync(join(tmpdir(), "ccc-campaign-git-landing-red-"));
    const taskId = "TASK-campaign-git-landing";
    const persistedContext = campaignContext(taskId, targetRoot);
    try {
      await expect(runAiMerge(fakeStore({
        task: task(taskId),
        context: persistedContext,
      }), targetRoot, taskId)).rejects.toThrow(/getAsyncLayer|AsyncDataLayer/i);
      expect(createCccCampaignMergeControl(persistedContext).taskId).toBe(taskId);
    } finally {
      rmSync(targetRoot, { recursive: true, force: true });
    }
  });

  it("leaves ordinary merger behavior on the legacy branch", async () => {
    const targetRoot = mkdtempSync(join(tmpdir(), "ccc-campaign-git-ordinary-"));
    const taskId = "TASK-ordinary-git-landing";
    try {
      await expect(runAiMerge({
        ...fakeStore({
          task: task(taskId),
          context: campaignContext("other-task", targetRoot),
        }),
        getCccCampaignContextForTask: async () => null,
      } as unknown as TaskStore, targetRoot, taskId)).rejects.toThrow(
        'AI merge for TASK-ordinary-git-landing: branch "campaign-task" is missing',
      );
    } finally {
      rmSync(targetRoot, { recursive: true, force: true });
    }
  });

  it("fails closed for imported campaign markers without persisted custody", async () => {
    const targetRoot = mkdtempSync(join(tmpdir(), "ccc-campaign-git-marker-only-"));
    const taskId = "TASK-marker-only-git-landing";
    try {
      await expect(runAiMerge({
        ...fakeStore({
          task: importedTaskWithoutCustody(taskId),
          context: campaignContext("other-task", targetRoot),
        }),
        getCccCampaignContextForTask: async () => null,
      } as unknown as TaskStore, targetRoot, taskId)).rejects.toMatchObject({
        code: "ccc-campaign-custody-missing",
      });
    } finally {
      rmSync(targetRoot, { recursive: true, force: true });
    }
  });
});

pgDescribe("Task 5 native CCC campaign Git landing real PG/Git", () => {
  const h = createSharedPgTaskStoreTestHarness({ prefix: "fusion_ccc_campaign_git_landing" });
  const mergeApprovalRequired = "ccc-permanent:CCC_CAMPAIGN_MERGE_APPROVAL_REQUIRED";

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  async function importedMergeFixture(
    suffix: string,
    options: {
      proofReceipt?: "passing" | "missing" | "failed" | "dispatched-unknown" | "wrong-commit" | "wrong-tree" | "wrong-paths";
      proofFence?: "exact" | "fake-work-item" | "stale-run" | "stale-attempt";
      workItemState?: "manual-required" | "running" | "failed" | "succeeded";
      executionPolicy?: "v1" | "v2";
      sourcePath?: string;
      targetCheckout?: "detached" | "checked-out";
    } = {},
  ) {
    const root = h.rootDir();
    rmSync(root, { recursive: true, force: true });
    await mkdir(root, { recursive: true });
    git(root, ["init", "-b", "main"]);
    git(root, ["config", "user.name", "Test User"]);
    git(root, ["config", "user.email", "test@example.com"]);
    git(root, ["config", "commit.gpgsign", "false"]);
    writeFileSync(join(root, "README.md"), "base\n");
    git(root, ["add", "README.md"]);
    git(root, ["commit", "-m", "base"]);
    const base = git(root, ["rev-parse", "HEAD"]);
    const action = { actionId: "PA-merge-main", actionTarget: "refs/heads/main" };
    const initial = createCccPrdImportTestBundle(root, suffix);
    const source = rehashCccPrdImportTestBundle({
      ...initial,
      bounds: { maxRequests: 2, maxDurationMs: 120_000, maxConcurrency: 1 },
      targetRepository: { path: root, baseCommit: base },
      tasks: initial.tasks.map((task, index) => index === 0
        ? { ...task, protectedActionIds: [action.actionId] }
        : task),
      protectedActions: [{
        id: action.actionId,
        kind: "merge" as const,
        target: action.actionTarget,
        operatorDecision: "approve_merge" as const,
        requiresOperatorDecision: true as const,
        spans: [initial.tasks[0]!.spans[0]!],
      }],
    });
    const idempotencyKey = `git-landing-${suffix}`;
    const imported = await importCccPrdBundle({
      bundle: source,
      idempotencyKey,
      store: h.store(),
      layer: h.layer(),
      rootDir: root,
      executionPolicy: options.executionPolicy === "v1"
        ? createCccPrdImportTestExecutionPolicy(source)
        : createCccPrdImportTestProductExecutionPolicy(source),
    });
    const semanticTaskId = `TASK-${suffix}`;
    const productStatus = await inspectCccPrdProductStatus({
      idempotencyKey,
      layer: h.layer(),
      rootDir: root,
    });
    if (!productStatus) throw new Error(`missing product status for ${idempotencyKey}`);
    expect(productStatus.import.importId).toBe(imported.importId);
    const taskStatuses = productStatus.tasks.filter(
      (status) => status.semanticTaskId === semanticTaskId,
    );
    expect(taskStatuses).toHaveLength(1);
    const taskId = taskStatuses[0]!.nativeTaskId;
    const workItemIntent = source.importIntents.find(({ entityType }) => entityType === "work_item");
    if (!workItemIntent) throw new Error("missing imported workflow work-item intent");
    const nativeWorkItemId = `${imported.importId}--${workItemIntent.id}`;
    const importedWorkItem = await h.store().getWorkflowWorkItem(nativeWorkItemId);
    if (!importedWorkItem) throw new Error(`missing imported workflow work item ${nativeWorkItemId}`);
    const workItemState = options.workItemState ?? "manual-required";
    const parkedWorkItem = await h.store().transitionWorkflowWorkItem(
      importedWorkItem.id,
      workItemState,
      {
        attempt: 1,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: workItemState === "manual-required" ? mergeApprovalRequired : null,
        blockedReason: workItemState === "manual-required" ? mergeApprovalRequired : null,
      },
    );
    const task = await h.store().getTask(taskId);
    const branch = resolveTaskWorkingBranch(task);
    const sourcePath = options.sourcePath ?? "src/task-0/change.txt";
    git(root, ["switch", "-c", branch, "main"]);
    await mkdir(dirname(join(root, sourcePath)), { recursive: true });
    writeFileSync(join(root, sourcePath), "feature\n");
    git(root, ["add", sourcePath]);
    git(root, ["commit", "-m", "feature"]);
    if (options.targetCheckout === "checked-out") {
      git(root, ["switch", "main"]);
    } else {
      git(root, ["switch", "--detach", "main"]);
    }
    writeFileSync(join(root, ".git", "info", "exclude"), "*\n");
    const context = await h.store().getCccCampaignContextForTask(taskId);
    if (!context) throw new Error(`missing campaign context for ${taskId}`);
    expect(context).toMatchObject({
      taskId,
      semanticTaskId,
    });
    const proofReceipt = options.proofReceipt ?? "passing";
    if (proofReceipt !== "missing") {
      const branchCommit = git(root, ["rev-parse", `refs/heads/${branch}`]);
      const sourceCommit = proofReceipt === "wrong-commit" ? base : branchCommit;
      const sourceTree = proofReceipt === "wrong-tree"
        ? git(root, ["rev-parse", `${base}^{tree}`])
        : git(root, ["rev-parse", `${sourceCommit}^{tree}`]);
      const exactChangedPathsSha256 = createHash("sha256")
        .update(JSON.stringify([sourcePath]), "utf8")
        .digest("hex");
      const changedPathsSha256 = proofReceipt === "wrong-paths"
        ? "0".repeat(64)
        : exactChangedPathsSha256;
      for (const proof of context.proofs) {
        const reserved = await reserveCccCampaignProofAttempt({
          layer: h.layer(),
          rootDir: root,
          taskId,
          proofId: proof.id,
          sourceCommit,
          sourceTree,
          workItemFence: {
            workItemId: options.proofFence === "fake-work-item"
              ? `WORK-fake-proof-${suffix}-${proof.id}`
              : parkedWorkItem.id,
            runId: options.proofFence === "stale-run"
              ? `${parkedWorkItem.runId}:stale`
              : parkedWorkItem.runId,
            attempt: options.proofFence === "stale-attempt"
              ? parkedWorkItem.attempt + 1
              : parkedWorkItem.attempt,
          },
        });
        await beginCccCampaignProofAttemptDispatch({
          layer: h.layer(),
          attemptKey: reserved.attemptKey,
          controllerToken: reserved.controllerToken,
        });
        if (proofReceipt === "dispatched-unknown") continue;
        await settleCccCampaignProofAttempt({
          layer: h.layer(),
          attemptKey: reserved.attemptKey,
          controllerToken: reserved.controllerToken,
          result: {
            success: proofReceipt !== "failed",
            exitCode: proofReceipt === "failed" ? 1 : 0,
            durationMs: 1,
            stdout: proofReceipt === "failed" ? "" : "proof passed\n",
            stderr: proofReceipt === "failed" ? "proof failed\n" : "",
            timedOut: false,
            killed: false,
            warnings: [],
            changedPathsSha256,
          },
        });
      }
    }
    const issued = await issueCccCampaignApproval(h.layer(), {
      authorityStore: h.store(),
      rootDir: root,
      taskId,
      action,
      requester,
      runId: `approval-issue:${suffix}`,
      notBeforeAt: context.campaignStartedAt,
      expiresAt: context.campaignDeadlineAt,
    });
    const claimed = await claimCccCampaignApproval(h.layer(), {
      authorityStore: h.store(),
      rootDir: root,
      taskId,
      action,
      claimant: worker,
      runId: `approval-claim:${suffix}`,
      claimToken: `claim-${suffix}`,
    });
    return {
      root,
      taskId,
      action,
      issued,
      claimed,
      parkedWorkItem,
      claimToken: `claim-${suffix}`,
    };
  }

  const landingMutationTypes = async (taskId: string) => (await queryRunAuditEvents(h.layer().db, {
    taskId,
    domain: "git",
  }))
    .map((event) => event.mutationType)
    .filter((mutationType) => mutationType.startsWith("ccc-campaign-git-landing:"))
    .sort();

  async function expectClaimedApprovalAndLease(fixture: Awaited<ReturnType<typeof importedMergeFixture>>) {
    await expect(getApprovalRequest(h.layer().db, fixture.issued.id)).resolves.toMatchObject({ status: "claimed" });
    const context = await h.store().getCccCampaignContextForTask(fixture.taskId);
    expect(context?.activeActionLeases[fixture.action.actionId]).toMatchObject({
      approvalRequestId: fixture.issued.id,
      claimToken: fixture.claimToken,
    });
  }

  async function expectedPreparedCommit(fixture: Awaited<ReturnType<typeof importedMergeFixture>>): Promise<string> {
    const branch = resolveTaskWorkingBranch(await h.store().getTask(fixture.taskId));
    const prepared = await prepareCccCampaignGitObjects({
      targetRoot: fixture.root,
      expectedBaseObject: fixture.claimed.campaign!.binding.targetBase,
      sourceRef: `refs/heads/${branch}`,
      targetRef: fixture.action.actionTarget,
      admittedWriteRoots: [join(fixture.root, "src")],
      identity: {
        name: "CCC Campaign",
        email: "ccc-campaign@example.com",
        timestamp: "2026-07-26T00:00:00Z",
      },
      message: `CCC campaign native Git landing ${fixture.taskId}`,
    });
    return prepared.commitObject;
  }

  it("refuses landing without exact passing proof receipts and preserves human approval", async () => {
    const fixture = await importedMergeFixture("missing-proof-receipt", {
      proofReceipt: "missing",
    });
    const forbidden = createForbiddenEffectRecorder();

    await expect(runAiMerge(
      h.store(),
      fixture.root,
      fixture.taskId,
      {},
      forbidden.deps,
    )).rejects.toThrow(/proof receipt|proof execution|exact commit|passing receipt/i);

    expect(git(fixture.root, ["rev-parse", "refs/heads/main"]))
      .toBe(fixture.claimed.campaign!.binding.targetBase);
    await expectClaimedApprovalAndLease(fixture);
    await expect(landingMutationTypes(fixture.taskId)).resolves.toEqual([]);
    expectNoForbiddenEffects(forbidden);
  });

  it("refuses a bundle-admitted source change outside every product route write root", async () => {
    const fixture = await importedMergeFixture("route-source-root", {
      sourcePath: "src/foreign/change.txt",
    });
    const forbidden = createForbiddenEffectRecorder();

    await expect(runAiMerge(
      h.store(),
      fixture.root,
      fixture.taskId,
      {},
      forbidden.deps,
    )).rejects.toThrow(/admitted|undeclared|write root|ownership/i);

    expect(git(fixture.root, ["rev-parse", "refs/heads/main"]))
      .toBe(fixture.claimed.campaign!.binding.targetBase);
    await expectClaimedApprovalAndLease(fixture);
    await expect(landingMutationTypes(fixture.taskId)).resolves.toEqual([]);
    expectNoForbiddenEffects(forbidden);
  });

  it.each([
    ["failed", "failed proof"],
    ["dispatched-unknown", "uncertain dispatched proof"],
    ["wrong-commit", "stale commit"],
    ["wrong-tree", "wrong tree"],
    ["wrong-paths", "wrong changed paths"],
  ] as const)(
    "refuses %s proof receipts before intent and leaves approval reusable",
    async (proofReceipt, suffix) => {
      const fixture = await importedMergeFixture(
        `proof-receipt-${suffix.replaceAll(" ", "-")}`,
        { proofReceipt },
      );
      const forbidden = createForbiddenEffectRecorder();

      await expect(runAiMerge(
        h.store(),
        fixture.root,
        fixture.taskId,
        {},
        forbidden.deps,
      )).rejects.toThrow(/proof|receipt|source/i);

      expect(git(fixture.root, ["rev-parse", "refs/heads/main"]))
        .toBe(fixture.claimed.campaign!.binding.targetBase);
      await expectClaimedApprovalAndLease(fixture);
      await expect(landingMutationTypes(fixture.taskId)).resolves.toEqual([]);
      expectNoForbiddenEffects(forbidden);
    },
  );

  it.each([
    ["fake receipt work-item fence", { proofFence: "fake-work-item" as const }],
    ["stale receipt run fence", { proofFence: "stale-run" as const }],
    ["stale receipt attempt fence", { proofFence: "stale-attempt" as const }],
    ["incomplete imported workflow work item", { workItemState: "running" as const }],
    ["failed imported workflow work item", { workItemState: "failed" as const }],
    ["premature succeeded imported workflow work item", { workItemState: "succeeded" as const }],
  ])(
    "refuses otherwise-valid proof receipts with %s before intent and leaves approval reusable",
    async (suffix, options) => {
      const fixture = await importedMergeFixture(
        `proof-work-item-${suffix.replaceAll(" ", "-")}`,
        options,
      );
      const forbidden = createForbiddenEffectRecorder();

      await expect(runAiMerge(
        h.store(),
        fixture.root,
        fixture.taskId,
        {},
        forbidden.deps,
      )).rejects.toThrow(/proof|receipt|work item|workflow|fence|campaign/i);

      expect(git(fixture.root, ["rev-parse", "refs/heads/main"]))
        .toBe(fixture.claimed.campaign!.binding.targetBase);
      await expectClaimedApprovalAndLease(fixture);
      await expect(landingMutationTypes(fixture.taskId)).resolves.toEqual([]);
      expectNoForbiddenEffects(forbidden);
    },
  );

  it("keeps v1 landing fail-closed even with otherwise-valid synthetic proof receipts", async () => {
    const fixture = await importedMergeFixture("v1-landing-fail-closed", {
      executionPolicy: "v1",
    });
    const forbidden = createForbiddenEffectRecorder();

    await expect(runAiMerge(
      h.store(),
      fixture.root,
      fixture.taskId,
      {},
      forbidden.deps,
    )).rejects.toThrow(/product-v2|proof execution/i);

    expect(git(fixture.root, ["rev-parse", "refs/heads/main"]))
      .toBe(fixture.claimed.campaign!.binding.targetBase);
    await expectClaimedApprovalAndLease(fixture);
    await expect(landingMutationTypes(fixture.taskId)).resolves.toEqual([]);
    expectNoForbiddenEffects(forbidden);
  });

  it("refuses after deterministic objects before durable intent with ref unchanged and replayable commit identity", async () => {
    const fixture = await importedMergeFixture("after-objects-before-intent");
    const forbidden = createForbiddenEffectRecorder();

    await expect(runAiMerge(h.store(), fixture.root, fixture.taskId, {}, {
      ...forbidden.deps,
      cccCampaignGitLandingFault: "after-objects-before-intent",
    })).rejects.toThrow(/after deterministic objects before durable intent/);

    expect(git(fixture.root, ["rev-parse", "refs/heads/main"])).toBe(fixture.claimed.campaign!.binding.targetBase);
    await expectClaimedApprovalAndLease(fixture);
    await expect(landingMutationTypes(fixture.taskId)).resolves.toEqual([]);
    expectNoForbiddenEffects(forbidden);

    const expectedCommit = await expectedPreparedCommit(fixture);
    const replay = createForbiddenEffectRecorder();
    await expect(runAiMerge(h.store(), fixture.root, fixture.taskId, {}, replay.deps)).resolves.toMatchObject({
      merged: true,
      noOp: false,
      worktreeRemoved: false,
      branchDeleted: false,
    });
    expect(git(fixture.root, ["rev-parse", "refs/heads/main"])).toBe(expectedCommit);
    await expect(getApprovalRequest(h.layer().db, fixture.issued.id)).resolves.toMatchObject({ status: "consumed" });
    await expect(landingMutationTypes(fixture.taskId)).resolves.toEqual([
      "ccc-campaign-git-landing:intent",
      "ccc-campaign-git-landing:terminal",
    ]);
    expectNoForbiddenEffects(replay);
  });

  it("Task 5 RED: rolls back intent persistence failure before ref mutation and replays exact commit identity", async () => {
    const fixture = await importedMergeFixture("after-intent-write-before-commit");
    const forbidden = createForbiddenEffectRecorder();
    const expectedCommit = await expectedPreparedCommit(fixture);

    await expect(runAiMerge(h.store(), fixture.root, fixture.taskId, {}, {
      ...forbidden.deps,
      cccCampaignGitLandingFault: "after-intent-write-before-commit",
    })).rejects.toThrow(/intent write before commit/);

    expect(git(fixture.root, ["rev-parse", "refs/heads/main"])).toBe(fixture.claimed.campaign!.binding.targetBase);
    await expectClaimedApprovalAndLease(fixture);
    await expect(landingMutationTypes(fixture.taskId)).resolves.toEqual([]);
    expectNoForbiddenEffects(forbidden);

    const replay = createForbiddenEffectRecorder();
    await expect(runAiMerge(h.store(), fixture.root, fixture.taskId, {}, replay.deps)).resolves.toMatchObject({
      merged: true,
      noOp: false,
      worktreeRemoved: false,
      branchDeleted: false,
    });
    expect(git(fixture.root, ["rev-parse", "refs/heads/main"])).toBe(expectedCommit);
    await expect(getApprovalRequest(h.layer().db, fixture.issued.id)).resolves.toMatchObject({ status: "consumed" });
    await expect(landingMutationTypes(fixture.taskId)).resolves.toEqual([
      "ccc-campaign-git-landing:intent",
      "ccc-campaign-git-landing:terminal",
    ]);
    expectNoForbiddenEffects(replay);
  });

  it("Task 5 RED: reconciles interruption at each CAS boundary and consumes one exact approval", async () => {
    const fixture = await importedMergeFixture("git-landing-success");
    const forbidden = createForbiddenEffectRecorder();

    await expect(runAiMerge(h.store(), fixture.root, fixture.taskId, {}, {
      ...forbidden.deps,
      cccCampaignGitLandingFault: "after-intent",
    })).rejects.toThrow(/test fault after durable intent/);
    expect(git(fixture.root, ["rev-parse", "refs/heads/main"])).toBe(fixture.claimed.campaign!.binding.targetBase);
    await expect(getApprovalRequest(h.layer().db, fixture.issued.id)).resolves.toMatchObject({ status: "claimed" });
    await expect(landingMutationTypes(fixture.taskId)).resolves.toEqual(["ccc-campaign-git-landing:intent"]);

    await expect(runAiMerge(h.store(), fixture.root, fixture.taskId, {}, {
      ...forbidden.deps,
      cccCampaignGitLandingFault: "after-cas",
    })).rejects.toThrow(/test fault after CAS/);
    expect(git(fixture.root, ["rev-parse", "refs/heads/main"])).not.toBe(fixture.claimed.campaign!.binding.targetBase);
    await expect(getApprovalRequest(h.layer().db, fixture.issued.id)).resolves.toMatchObject({ status: "claimed" });
    await expect(landingMutationTypes(fixture.taskId)).resolves.toEqual(["ccc-campaign-git-landing:intent"]);

    const result = await runAiMerge(h.store(), fixture.root, fixture.taskId, {}, {
      ...forbidden.deps,
    });

    expect(result).toMatchObject({
      merged: true,
      noOp: false,
      worktreeRemoved: false,
      branchDeleted: false,
    });
    expect(git(fixture.root, ["rev-parse", "refs/heads/main"])).not.toBe(fixture.claimed.campaign!.binding.targetBase);
    const approval = await getApprovalRequest(h.layer().db, fixture.issued.id);
    expect(approval?.status).toBe("consumed");

    const replay = await runAiMerge(h.store(), fixture.root, fixture.taskId, {}, {
      ...forbidden.deps,
    });
    expect(replay).toMatchObject({
      merged: true,
      noOp: false,
      worktreeRemoved: false,
      branchDeleted: false,
    });

    await expect(landingMutationTypes(fixture.taskId)).resolves.toEqual([
      "ccc-campaign-git-landing:intent",
      "ccc-campaign-git-landing:terminal",
    ]);
    expectNoForbiddenEffects(forbidden);
  });

  it("lands onto the exact clean target branch checked out at the canonical target root", async () => {
    const fixture = await importedMergeFixture("checked-out-target-root", {
      targetCheckout: "checked-out",
    });
    const branch = resolveTaskWorkingBranch(await h.store().getTask(fixture.taskId));
    const sourceCommit = git(fixture.root, ["rev-parse", `refs/heads/${branch}`]);
    const baseCommit = fixture.claimed.campaign!.binding.targetBase;
    const forbidden = createForbiddenEffectRecorder();

    await expect(runAiMerge(
      h.store(),
      fixture.root,
      fixture.taskId,
      {},
      forbidden.deps,
    )).resolves.toMatchObject({
      merged: true,
      noOp: false,
    });

    expect(git(fixture.root, ["symbolic-ref", "HEAD"])).toBe("refs/heads/main");
    const landedCommit = git(fixture.root, ["rev-parse", "HEAD"]);
    expect(landedCommit).not.toBe(baseCommit);
    expect(landedCommit).not.toBe(sourceCommit);
    expect(git(fixture.root, ["rev-parse", "refs/heads/main"])).toBe(landedCommit);
    expect(git(fixture.root, ["rev-parse", `${landedCommit}^{tree}`]))
      .toBe(git(fixture.root, ["rev-parse", `${sourceCommit}^{tree}`]));
    expect(git(fixture.root, ["status", "--short"])).toBe("");
    expectNoForbiddenEffects(forbidden);
  });

  it("recovers exact checked-out landing materialization without replaying an uncertain filesystem effect", async () => {
    const fixture = await importedMergeFixture("checked-out-materialization-recovery", {
      targetCheckout: "checked-out",
    });
    const baseCommit = fixture.claimed.campaign!.binding.targetBase;
    const forbidden = createForbiddenEffectRecorder();

    await expect(runAiMerge(h.store(), fixture.root, fixture.taskId, {}, {
      ...forbidden.deps,
      cccCampaignGitLandingFault: "after-checkout-materialization" as never,
    })).rejects.toThrow(/after checkout materialization/i);

    const intentEvents = await queryRunAuditEvents(h.layer().db, {
      taskId: fixture.taskId,
      domain: "git",
      mutationType: "ccc-campaign-git-landing:intent",
    });
    const intent = intentEvents[0]?.metadata as { commitObject?: unknown } | null | undefined;
    expect(intent?.commitObject).toEqual(expect.stringMatching(/^[a-f0-9]{40}$/u));
    const commitObject = intent!.commitObject as string;
    expect(git(fixture.root, ["rev-parse", "refs/heads/main"])).toBe(baseCommit);
    expect(git(fixture.root, ["write-tree"])).toBe(git(fixture.root, ["rev-parse", `${commitObject}^{tree}`]));
    expect(git(fixture.root, ["status", "--short"])).not.toBe("");
    await expectClaimedApprovalAndLease(fixture);
    await expect(landingMutationTypes(fixture.taskId)).resolves.toEqual([
      "ccc-campaign-git-landing:intent",
    ]);

    await expect(runAiMerge(h.store(), fixture.root, fixture.taskId, {}, {
      ...forbidden.deps,
      cccCampaignGitLandingFault: "after-checkout-receipt" as never,
    })).rejects.toThrow(/after checkout materialization receipt/i);
    expect(git(fixture.root, ["rev-parse", "refs/heads/main"])).toBe(baseCommit);
    expect(git(fixture.root, ["write-tree"])).toBe(git(fixture.root, ["rev-parse", `${commitObject}^{tree}`]));
    await expectClaimedApprovalAndLease(fixture);
    await expect(landingMutationTypes(fixture.taskId)).resolves.toEqual([
      "ccc-campaign-git-landing:checkout-materialized",
      "ccc-campaign-git-landing:intent",
    ]);

    await expect(runAiMerge(
      h.store(),
      fixture.root,
      fixture.taskId,
      {},
      forbidden.deps,
    )).resolves.toMatchObject({ merged: true, noOp: false });
    expect(git(fixture.root, ["rev-parse", "HEAD"])).toBe(commitObject);
    expect(git(fixture.root, ["status", "--short"])).toBe("");
    await expect(getApprovalRequest(h.layer().db, fixture.issued.id))
      .resolves.toMatchObject({ status: "consumed" });
    await expect(landingMutationTypes(fixture.taskId)).resolves.toEqual([
      "ccc-campaign-git-landing:checkout-materialized",
      "ccc-campaign-git-landing:intent",
      "ccc-campaign-git-landing:terminal",
    ]);
    expectNoForbiddenEffects(forbidden);
  });

  it("requires manual recovery when a durable checkout receipt exists without its filesystem effect", async () => {
    const fixture = await importedMergeFixture("checked-out-materialization-missing", {
      targetCheckout: "checked-out",
    });
    const baseCommit = fixture.claimed.campaign!.binding.targetBase;
    const forbidden = createForbiddenEffectRecorder();

    await expect(runAiMerge(h.store(), fixture.root, fixture.taskId, {}, {
      ...forbidden.deps,
      cccCampaignGitLandingFault: "after-checkout-receipt" as never,
    })).rejects.toThrow(/after checkout materialization receipt/i);

    const intentEvents = await queryRunAuditEvents(h.layer().db, {
      taskId: fixture.taskId,
      domain: "git",
      mutationType: "ccc-campaign-git-landing:intent",
    });
    const intent = intentEvents[0]?.metadata as {
      commitObject?: unknown;
    } | null | undefined;
    expect(intent?.commitObject).toEqual(expect.stringMatching(/^[a-f0-9]{40}$/u));
    const commitObject = intent!.commitObject as string;
    git(fixture.root, [
      "read-tree",
      "--no-sparse-checkout",
      "-u",
      "-m",
      commitObject,
      baseCommit,
    ]);
    expect(git(fixture.root, ["rev-parse", "HEAD"])).toBe(baseCommit);
    expect(git(fixture.root, ["status", "--short"])).toBe("");

    await expect(runAiMerge(
      h.store(),
      fixture.root,
      fixture.taskId,
      {},
      forbidden.deps,
    )).rejects.toThrow(/receipt exists.*filesystem effect is absent.*manual recovery/i);
    await expectClaimedApprovalAndLease(fixture);
    await expect(landingMutationTypes(fixture.taskId)).resolves.toEqual([
      "ccc-campaign-git-landing:checkout-materialized",
      "ccc-campaign-git-landing:intent",
    ]);
    expect(git(fixture.root, ["rev-parse", "HEAD"])).toBe(baseCommit);
    expect(git(fixture.root, ["status", "--short"])).toBe("");
    expectNoForbiddenEffects(forbidden);
  });

  it.each([
    "tracked dirty",
    "untracked",
    "mixed index/worktree",
  ] as const)(
    "refuses %s checked-out restart state without overwriting operator bytes",
    async (mode) => {
      const fixture = await importedMergeFixture(
        `checked-out-${mode.replaceAll(/[^a-z]+/gu, "-")}`,
        { targetCheckout: "checked-out" },
      );
      const baseCommit = fixture.claimed.campaign!.binding.targetBase;
      const forbidden = createForbiddenEffectRecorder();

      await expect(runAiMerge(h.store(), fixture.root, fixture.taskId, {}, {
        ...forbidden.deps,
        cccCampaignGitLandingFault: "after-intent",
      })).rejects.toThrow(/after durable intent/i);

      let observedPath = join(fixture.root, "README.md");
      if (mode === "tracked dirty") {
        writeFileSync(observedPath, "operator dirty bytes\n");
      } else if (mode === "untracked") {
        writeFileSync(join(fixture.root, ".git", "info", "exclude"), "\n");
        observedPath = join(fixture.root, "operator-untracked.txt");
        writeFileSync(observedPath, "operator untracked bytes\n");
      } else {
        writeFileSync(observedPath, "operator staged bytes\n");
        git(fixture.root, ["add", "README.md"]);
        writeFileSync(observedPath, "operator worktree bytes\n");
      }
      const statusBefore = git(fixture.root, [
        "status",
        "--short",
        "--untracked-files=all",
      ]);
      const indexBefore = git(fixture.root, ["write-tree"]);
      const bytesBefore = readFileSync(observedPath, "utf8");
      expect(statusBefore).not.toBe("");

      await expect(runAiMerge(
        h.store(),
        fixture.root,
        fixture.taskId,
        {},
        forbidden.deps,
      )).rejects.toThrow(/dirty|untracked|index|worktree|manual recovery/i);
      expect(git(fixture.root, ["rev-parse", "HEAD"])).toBe(baseCommit);
      expect(git(fixture.root, [
        "status",
        "--short",
        "--untracked-files=all",
      ])).toBe(statusBefore);
      expect(git(fixture.root, ["write-tree"])).toBe(indexBefore);
      expect(readFileSync(observedPath, "utf8")).toBe(bytesBefore);
      await expectClaimedApprovalAndLease(fixture);
      await expect(landingMutationTypes(fixture.taskId)).resolves.toEqual([
        "ccc-campaign-git-landing:intent",
      ]);
      expectNoForbiddenEffects(forbidden);
    },
  );

  it("recovers a checked-out target after CAS without repeating landing or approval", async () => {
    const fixture = await importedMergeFixture("checked-out-after-cas-recovery", {
      targetCheckout: "checked-out",
    });
    const baseCommit = fixture.claimed.campaign!.binding.targetBase;
    const forbidden = createForbiddenEffectRecorder();

    await expect(runAiMerge(h.store(), fixture.root, fixture.taskId, {}, {
      ...forbidden.deps,
      cccCampaignGitLandingFault: "after-cas",
    })).rejects.toThrow(/test fault after CAS/i);
    const landedCommit = git(fixture.root, ["rev-parse", "HEAD"]);
    expect(landedCommit).not.toBe(baseCommit);
    expect(git(fixture.root, ["rev-parse", "refs/heads/main"])).toBe(landedCommit);
    expect(git(fixture.root, ["status", "--short"])).toBe("");
    await expectClaimedApprovalAndLease(fixture);
    await expect(landingMutationTypes(fixture.taskId)).resolves.toEqual([
      "ccc-campaign-git-landing:checkout-materialized",
      "ccc-campaign-git-landing:intent",
    ]);

    await expect(runAiMerge(
      h.store(),
      fixture.root,
      fixture.taskId,
      {},
      forbidden.deps,
    )).resolves.toMatchObject({ merged: true, noOp: false });
    expect(git(fixture.root, ["rev-parse", "HEAD"])).toBe(landedCommit);
    expect(git(fixture.root, ["rev-parse", "refs/heads/main"])).toBe(landedCommit);
    expect(git(fixture.root, ["status", "--short"])).toBe("");
    await expect(getApprovalRequest(h.layer().db, fixture.issued.id))
      .resolves.toMatchObject({ status: "consumed" });
    await expect(landingMutationTypes(fixture.taskId)).resolves.toEqual([
      "ccc-campaign-git-landing:checkout-materialized",
      "ccc-campaign-git-landing:intent",
      "ccc-campaign-git-landing:terminal",
    ]);

    await expect(runAiMerge(
      h.store(),
      fixture.root,
      fixture.taskId,
      {},
      forbidden.deps,
    )).resolves.toMatchObject({ merged: true, noOp: false });
    await expect(landingMutationTypes(fixture.taskId)).resolves.toEqual([
      "ccc-campaign-git-landing:checkout-materialized",
      "ccc-campaign-git-landing:intent",
      "ccc-campaign-git-landing:terminal",
    ]);
    expectNoForbiddenEffects(forbidden);
  });

  it("accepts a succeeded imported workflow work item only on durable terminal replay", async () => {
    const fixture = await importedMergeFixture("succeeded-work-item-terminal-replay");
    const forbidden = createForbiddenEffectRecorder();

    await expect(runAiMerge(
      h.store(),
      fixture.root,
      fixture.taskId,
      {},
      forbidden.deps,
    )).resolves.toMatchObject({ merged: true, noOp: false });
    await expect(landingMutationTypes(fixture.taskId)).resolves.toEqual([
      "ccc-campaign-git-landing:intent",
      "ccc-campaign-git-landing:terminal",
    ]);

    await h.store().transitionWorkflowWorkItem(
      fixture.parkedWorkItem.id,
      "succeeded",
      {
        expectedState: "manual-required",
        expectedAttempt: fixture.parkedWorkItem.attempt,
        attempt: fixture.parkedWorkItem.attempt,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: null,
        blockedReason: null,
      },
    );
    await expect(runAiMerge(
      h.store(),
      fixture.root,
      fixture.taskId,
      {},
      forbidden.deps,
    )).resolves.toMatchObject({ merged: true, noOp: false });

    await expect(getApprovalRequest(h.layer().db, fixture.issued.id))
      .resolves.toMatchObject({ status: "consumed" });
    await expect(landingMutationTypes(fixture.taskId)).resolves.toEqual([
      "ccc-campaign-git-landing:intent",
      "ccc-campaign-git-landing:terminal",
    ]);
    expectNoForbiddenEffects(forbidden);
  });

  it("Task 5 RED: refuses a foreign target ref race before CAS without terminal audit or approval consume", async () => {
    const fixture = await importedMergeFixture("foreign-before-cas");
    const branch = resolveTaskWorkingBranch(await h.store().getTask(fixture.taskId));
    const foreign = git(fixture.root, ["rev-parse", `refs/heads/${branch}`]);
    const forbidden = createForbiddenEffectRecorder();

    await expect(runAiMerge(h.store(), fixture.root, fixture.taskId, {}, {
      ...forbidden.deps,
      cccCampaignGitLandingFault: "foreign-before-cas",
    })).rejects.toThrow(/target ref drifted|CAS|stale/i);

    expect(git(fixture.root, ["rev-parse", "refs/heads/main"])).toBe(foreign);
    await expectClaimedApprovalAndLease(fixture);
    await expect(landingMutationTypes(fixture.taskId)).resolves.toEqual(["ccc-campaign-git-landing:intent"]);
    expectNoForbiddenEffects(forbidden);
  });

  it("Task 5 RED: refuses a foreign target ref race before terminal audit or approval consume", async () => {
    const fixture = await importedMergeFixture("foreign-after-cas");
    const branch = resolveTaskWorkingBranch(await h.store().getTask(fixture.taskId));
    const foreign = git(fixture.root, ["rev-parse", `refs/heads/${branch}`]);
    const forbidden = createForbiddenEffectRecorder();

    await expect(runAiMerge(h.store(), fixture.root, fixture.taskId, {}, {
      ...forbidden.deps,
      cccCampaignGitLandingFault: "foreign-after-cas",
    })).rejects.toThrow(/terminal|target ref/i);

    expect(git(fixture.root, ["rev-parse", "refs/heads/main"])).toBe(foreign);
    await expectClaimedApprovalAndLease(fixture);
    await expect(landingMutationTypes(fixture.taskId)).resolves.toEqual(["ccc-campaign-git-landing:intent"]);
    expectNoForbiddenEffects(forbidden);
  });
});

describe("CCC campaign deterministic Git object primitives", () => {
  it("prepares deterministic object-only squash output and replays the same commit", async () => {
    const root = makeObjectRepo();
    makeObjectFeature(root);

    const first = await prepareCccCampaignGitObjects(objectInput(root));
    await expect(recheckCccCampaignGitObjects(first)).resolves.toEqual(first);
    const second = await prepareCccCampaignGitObjects(objectInput(root));

    expect(first.commitObject).toMatch(/^[0-9a-f]{40}$/);
    expect(first.treeObject).toMatch(/^[0-9a-f]{40}$/);
    expect(first.commitObject).toBe(second.commitObject);
    expect(first.treeObject).toBe(second.treeObject);
    expect(first.mutationPaths).toEqual(["src/change.txt"]);
    expect(git(root, ["rev-parse", "refs/heads/main"])).toBe(first.expectedTarget);
    expect(git(root, ["rev-parse", "HEAD"])).toBe(first.expectedTarget);
    expect(git(root, ["status", "--short"])).toBe("");
  });

  it("Task 5 RED: refuses drift dirty overlap and undeclared paths before mutation", async () => {
    const dirty = makeObjectRepo("ccc-campaign-git-dirty-");
    makeObjectFeature(dirty);
    writeFileSync(join(dirty, "dirty.txt"), "dirty\n");
    await expect(prepareCccCampaignGitObjects(objectInput(dirty))).rejects.toThrow(/untracked|dirty|index differs|worktree/i);

    const foreignHead = makeObjectRepo("ccc-campaign-git-foreign-head-");
    makeObjectFeature(foreignHead);
    git(foreignHead, ["switch", "--detach", "feature"]);
    await expect(prepareCccCampaignGitObjects(objectInput(foreignHead))).rejects.toThrow(/HEAD|checked out/i);

    const foreignRef = makeObjectRepo("ccc-campaign-git-foreign-ref-");
    makeObjectFeature(foreignRef);
    const foreignRefBase = git(foreignRef, ["rev-parse", "HEAD"]);
    git(foreignRef, ["branch", "-f", "main", "feature"]);
    await expect(prepareCccCampaignGitObjects(objectInput(foreignRef, {
      expectedBaseObject: foreignRefBase,
    }))).rejects.toThrow(/target ref|expected base|deterministic commit|overlap/i);

    const checkedOut = makeObjectRepo("ccc-campaign-git-checked-out-");
    makeObjectFeature(checkedOut);
    git(checkedOut, ["switch", "main"]);
    await expect(prepareCccCampaignGitObjects(objectInput(checkedOut))).resolves.toMatchObject({
      targetCheckout: {
        mode: "target-root",
        path: realpathSync(checkedOut),
      },
    });

    const conflict = makeObjectRepo("ccc-campaign-git-conflict-");
    writeFileSync(join(conflict, "README.md"), "main\n");
    git(conflict, ["add", "README.md"]);
    git(conflict, ["commit", "-m", "main change"]);
    const expected = git(conflict, ["rev-parse", "HEAD"]);
    git(conflict, ["switch", "-c", "feature", "HEAD~1"]);
    writeFileSync(join(conflict, "README.md"), "feature\n");
    git(conflict, ["add", "README.md"]);
    git(conflict, ["commit", "-m", "feature conflict"]);
    git(conflict, ["switch", "--detach", "main"]);
    await expect(prepareCccCampaignGitObjects(objectInput(conflict, {
      expectedBaseObject: expected,
      admittedWriteRoots: [conflict],
    }))).rejects.toThrow(/source ref does not descend from target ref/i);
  });

  it("refuses undeclared paths, bad admitted roots, symlinks, and gitlinks", async () => {
    const undeclared = makeObjectRepo("ccc-campaign-git-undeclared-");
    makeObjectFeature(undeclared, "outside.txt");
    await expect(prepareCccCampaignGitObjects(objectInput(undeclared))).rejects.toThrow(/admitted|outside|undeclared/i);

    const absoluteRoot = makeObjectRepo("ccc-campaign-git-absolute-root-");
    makeObjectFeature(absoluteRoot);
    await expect(prepareCccCampaignGitObjects(objectInput(absoluteRoot, {
      admittedWriteRoots: ["/"],
    }))).rejects.toThrow(/admitted write root/i);

    const newRoot = makeObjectRepo("ccc-campaign-git-new-root-");
    makeObjectFeature(newRoot, "src/new/change.txt");
    await expect(prepareCccCampaignGitObjects(objectInput(newRoot, {
      admittedWriteRoots: [join(newRoot, "src", "new")],
    }))).resolves.toMatchObject({
      mutationPaths: ["src/new/change.txt"],
    });

    const symlinkRepo = makeObjectRepo("ccc-campaign-git-symlink-");
    git(symlinkRepo, ["switch", "-c", "feature"]);
    await symlink("../escape", join(symlinkRepo, "src"));
    git(symlinkRepo, ["add", "src"]);
    git(symlinkRepo, ["commit", "-m", "symlink"]);
    git(symlinkRepo, ["switch", "--detach", "main"]);
    execFileSync("mkdir", ["-p", join(symlinkRepo, "src-parent")]);
    await expect(prepareCccCampaignGitObjects(objectInput(symlinkRepo, {
      admittedWriteRoots: [symlinkRepo],
    }))).rejects.toThrow(/symlink|unsupported/i);

    const gitlinkRepo = makeObjectRepo("ccc-campaign-gitlink-");
    const nested = join(gitlinkRepo, "src", "nested");
    await mkdir(nested, { recursive: true });
    git(nested, ["init", "-b", "main"]);
    git(nested, ["config", "user.name", "Nested"]);
    git(nested, ["config", "user.email", "nested@example.com"]);
    await writeFile(join(nested, "file.txt"), "nested\n");
    git(nested, ["add", "file.txt"]);
    git(nested, ["commit", "-m", "nested"]);
    git(gitlinkRepo, ["switch", "-c", "feature"]);
    git(gitlinkRepo, ["add", "src/nested"]);
    git(gitlinkRepo, ["commit", "-m", "gitlink"]);
    git(gitlinkRepo, ["switch", "--detach", "main"]);
    rmSync(join(gitlinkRepo, "src", "nested"), { recursive: true, force: true });
    execFileSync("mkdir", ["-p", join(gitlinkRepo, "src")]);
    await expect(prepareCccCampaignGitObjects(objectInput(gitlinkRepo))).rejects.toThrow(/submodule|gitlink|unsupported/i);
  });

  it("refuses unsafe controlled Git environment overrides", async () => {
    const root = makeObjectRepo("ccc-campaign-git-env-");
    const snapshot = await inspectCccCampaignLocalGit({
      targetRoot: root,
      expectedBaseObject: git(root, ["rev-parse", "HEAD"]),
    });
    const injectedConfig = join(root, "injected-config");
    writeFileSync(injectedConfig, "[user]\n\tname = Injected User\n");

    await expect(runControlledCccCampaignGit(snapshot, ["config", "--global", "user.name"], {
      env: {
        GIT_CONFIG_GLOBAL: injectedConfig,
      },
    })).rejects.toThrow(/environment|env|refused/i);
  });

  it("rejects noncanonical identity and message fields before writing objects", async () => {
    const root = makeObjectRepo("ccc-campaign-git-identity-");
    makeObjectFeature(root);

    await expect(prepareCccCampaignGitObjects(objectInput(root, {
      identity: {
        name: " CCC Campaign",
        email: "ccc-campaign@example.com",
        timestamp: "2026-07-26T00:00:00Z",
      },
    }))).rejects.toThrow(/identity|timestamp|message/i);
    await expect(prepareCccCampaignGitObjects(objectInput(root, {
      identity: {
        name: "CCC Campaign",
        email: "ccc-campaign@example.com\r",
        timestamp: "2026-07-26T00:00:00Z",
      },
    }))).rejects.toThrow(/identity|timestamp|message/i);
    await expect(prepareCccCampaignGitObjects(objectInput(root, {
      identity: {
        name: "CCC Campaign",
        email: "ccc-campaign@example.com",
        timestamp: "2026-99-26T00:00:00Z",
      },
    }))).rejects.toThrow(/identity|timestamp|message/i);
    await expect(prepareCccCampaignGitObjects(objectInput(root, {
      message: " CCC campaign deterministic landing",
    }))).rejects.toThrow(/identity|timestamp|message/i);
    await expect(prepareCccCampaignGitObjects(objectInput(root, {
      message: "CCC campaign\rlanding",
    }))).rejects.toThrow(/identity|timestamp|message/i);
  });

  it("refuses unrelated object drift before recheck or CAS", async () => {
    const root = makeObjectRepo("ccc-campaign-git-drift-");
    makeObjectFeature(root);
    const prepared = await prepareCccCampaignGitObjects(objectInput(root));

    execFileSync("git", ["hash-object", "-w", "--stdin"], {
      cwd: root,
      input: "foreign\n",
      encoding: "utf8",
    });

    await expect(recheckCccCampaignGitObjects(prepared)).rejects.toThrow(/object drift|self-written/i);
    await expect(casCccCampaignGitRef(prepared)).rejects.toThrow(/object drift|self-written/i);
  });

  it("refuses packed unrelated object drift before recheck or CAS", async () => {
    const root = makeObjectRepo("ccc-campaign-git-packed-drift-");
    makeObjectFeature(root);
    const prepared = await prepareCccCampaignGitObjects(objectInput(root));

    const objectId = execFileSync("git", ["hash-object", "-w", "--stdin"], {
      cwd: root,
      input: "packed foreign\n",
      encoding: "utf8",
    }).trim();
    execFileSync("git", ["pack-objects", join(root, ".git", "objects", "pack", "pack-drift")], {
      cwd: root,
      input: `${objectId}\n`,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    rmSync(join(root, ".git", "objects", objectId.slice(0, 2), objectId.slice(2)), { force: true });

    await expect(recheckCccCampaignGitObjects(prepared)).rejects.toThrow(/object drift|self-written/i);
    await expect(casCccCampaignGitRef(prepared)).rejects.toThrow(/object drift|self-written/i);
  });

  it("performs exact update-ref CAS once, refuses stale CAS, and prepare accepts exact-new restart state", async () => {
    const root = makeObjectRepo("ccc-campaign-git-cas-");
    makeObjectFeature(root);
    const prepared = await prepareCccCampaignGitObjects(objectInput(root));

    await expect(casCccCampaignGitRef(prepared)).resolves.toEqual({
      advanced: true,
      ref: "refs/heads/main",
      previous: prepared.expectedTarget,
      current: prepared.commitObject,
    });
    expect(git(root, ["rev-parse", "refs/heads/main"])).toBe(prepared.commitObject);

    await expect(casCccCampaignGitRef(prepared)).resolves.toEqual({
      advanced: false,
      reason: "stale-ref",
      ref: "refs/heads/main",
      expected: prepared.expectedTarget,
      observed: prepared.commitObject,
    });
    await expect(prepareCccCampaignGitObjects(objectInput(root, {
      expectedBaseObject: prepared.expectedTarget,
    }))).resolves.toMatchObject({
      commitObject: prepared.commitObject,
      treeObject: prepared.treeObject,
      expectedTarget: prepared.expectedTarget,
    });
  });

  it("never executes repository hooks during checked-out prepare, materialization, or CAS", async () => {
    const root = makeObjectRepo("ccc-campaign-git-hook-canary-");
    makeObjectFeature(root);
    git(root, ["switch", "main"]);
    const hookRoot = join(root, ".git", "test-hooks");
    const marker = join(root, ".git", "hook-executed");
    mkdirSync(hookRoot);
    const hookSource = [
      "#!/bin/sh",
      `/usr/bin/touch ${JSON.stringify(marker)}`,
      "",
    ].join("\n");
    for (const hookName of [
      "post-checkout",
      "pre-commit",
      "reference-transaction",
    ]) {
      const hookPath = join(hookRoot, hookName);
      writeFileSync(hookPath, hookSource);
      chmodSync(hookPath, 0o755);
    }
    git(root, ["config", "core.hooksPath", hookRoot]);

    const prepared = await prepareCccCampaignGitObjects(objectInput(root));
    expect(prepared.targetCheckout).toMatchObject({ mode: "target-root" });
    await materializeCccCampaignGitCheckout(prepared);
    await expect(casCccCampaignGitRef(prepared)).resolves.toMatchObject({
      advanced: true,
      current: prepared.commitObject,
    });

    expect(git(root, ["rev-parse", "HEAD"])).toBe(prepared.commitObject);
    expect(git(root, ["status", "--short"])).toBe("");
    expect(existsSync(marker)).toBe(false);
  });

  it("detects target checked out by a sibling worktree", async () => {
    const root = makeObjectRepo("ccc-campaign-git-worktree-");
    makeObjectFeature(root);
    const sibling = `${root}-sibling`;
    trackedTmpDirs.add(sibling);
    git(root, ["worktree", "add", sibling, "main"]);

    await expect(prepareCccCampaignGitObjects(objectInput(root))).rejects.toThrow(/checked out/i);
  });

  it("refuses a target branch checked out by more than one sibling worktree", async () => {
    const root = makeObjectRepo("ccc-campaign-git-multiple-worktrees-");
    makeObjectFeature(root);
    const firstSibling = `${root}-sibling-a`;
    const secondSibling = `${root}-sibling-b`;
    trackedTmpDirs.add(firstSibling);
    trackedTmpDirs.add(secondSibling);
    git(root, ["worktree", "add", firstSibling, "main"]);
    git(root, ["worktree", "add", "--force", secondSibling, "main"]);

    await expect(prepareCccCampaignGitObjects(objectInput(root)))
      .rejects.toThrow(/checked out more than once/i);
  });
});
