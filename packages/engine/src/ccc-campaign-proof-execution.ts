import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, posix } from "node:path";
import { promisify } from "node:util";
import {
  beginCccCampaignProofAttemptDispatch,
  reserveCccCampaignProofAttempt,
  settleCccCampaignProofAttempt,
  type AsyncDataLayer,
  type CccCampaignTaskContext,
  type TaskDetail,
  type TaskStore,
} from "@fusion/core";
import { PermanentError } from "./engine-errors.js";
import {
  MAX_TIMEOUT_SEC,
  runVerificationCommand,
  type RunVerificationOptions,
  type VerificationResult,
} from "./run-verification-tool.js";
import type {
  WorkflowNodeExecutionContext,
  WorkflowNodeHandler,
  WorkflowNodeResult,
} from "./workflow-graph-executor.js";

const execFile = promisify(execFileCallback);
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const MAX_GIT_OUTPUT_BYTES = 8 * 1024 * 1024;

type ProofAttemptSnapshot = Readonly<{
  attemptKey: string;
  controllerToken: string;
  state: "reserved" | "dispatched_unknown" | "committed" | "proved_failed";
}>;

type ProofAttemptDispatchDecision =
  | Readonly<{ kind: "dispatch-permit"; attempt: ProofAttemptSnapshot }>
  | Readonly<{ kind: "dispatched-unknown" | "terminal"; attempt: ProofAttemptSnapshot }>;

export type CccCampaignProofAttemptApi = Readonly<{
  reserve(input: {
    layer: AsyncDataLayer;
    rootDir: string;
    taskId: string;
    proofId: string;
    scope?: "task" | "campaign";
    sourceCommit: string;
    sourceTree: string;
    workItemFence: {
      workItemId: string;
      runId: string;
      attempt: number;
    };
  }): Promise<ProofAttemptSnapshot>;
  begin(input: {
    layer: AsyncDataLayer;
    attemptKey: string;
    controllerToken: string;
  }): Promise<ProofAttemptDispatchDecision>;
  settle(input: {
    layer: AsyncDataLayer;
    attemptKey: string;
    controllerToken: string;
    result: {
      success: boolean;
      exitCode: number | null;
      durationMs: number;
      stdout: string;
      stderr: string;
      timedOut: boolean;
      killed: boolean;
      warnings: string[];
      changedPathsSha256?: string;
      negativeControlLabel?: string;
    };
  }): Promise<ProofAttemptSnapshot>;
}>;

type ProofExecutionStore = Pick<
  TaskStore,
  | "getTask"
  | "getCccCampaignContextForTask"
  | "getAsyncLayer"
  | "assertCccCampaignWorkflowLeaseFence"
>;

export interface CreateCccCampaignProofSuiteHandlerInput {
  rootDir: string;
  store: ProofExecutionStore;
  proofAttempts?: CccCampaignProofAttemptApi;
  runVerification?: (options: RunVerificationOptions) => Promise<VerificationResult>;
}

type GitSnapshot = Readonly<{
  targetRoot: string;
  worktreeRoot: string;
  sourceCommit: string;
  sourceTree: string;
  mutationPaths: readonly string[];
}>;

function proofRefusal(message: string, code = "CCC_CAMPAIGN_PROOF_EXECUTION_REFUSED"): never {
  throw new PermanentError(message, code);
}

function requiredStrings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    proofRefusal(`CCC campaign proof suite ${label} must be a non-empty array`);
  }
  const strings = value.map((entry) => {
    if (typeof entry !== "string" || entry.length === 0 || entry !== entry.trim()) {
      proofRefusal(`CCC campaign proof suite ${label} contains a non-canonical value`);
    }
    return entry;
  });
  if (new Set(strings).size !== strings.length) {
    proofRefusal(`CCC campaign proof suite ${label} contains duplicates`);
  }
  return strings;
}

function sameSorted(left: readonly string[], right: readonly string[]): boolean {
  return [...left].sort().join("\0") === [...right].sort().join("\0");
}

function sha256CanonicalStrings(values: readonly string[]): string {
  return createHash("sha256")
    .update(JSON.stringify([...values].sort()), "utf8")
    .digest("hex");
}

function sameCampaign(left: CccCampaignTaskContext, right: CccCampaignTaskContext): boolean {
  return left.projectId === right.projectId
    && left.importId === right.importId
    && left.campaignId === right.campaignId
    && left.idempotencyKey === right.idempotencyKey
    && left.packetHash === right.packetHash
    && left.sidecarHash === right.sidecarHash
    && left.bundleHash === right.bundleHash
    && left.manifestHash === right.manifestHash
    && left.targetRepository.path === right.targetRepository.path
    && left.targetRepository.baseCommit === right.targetRepository.baseCommit;
}

function canonicalGitPath(value: string): string {
  if (
    value.length === 0
    || value.includes("\0")
    || value.includes("\\")
    || isAbsolute(value)
    || posix.normalize(value) !== value
    || value === ".."
    || value.startsWith("../")
  ) {
    proofRefusal(`CCC campaign proof refused non-canonical Git path ${JSON.stringify(value)}`);
  }
  return value;
}

function pathWithinRoot(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

function scrubGitEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_COMMON_DIR",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  ]) {
    delete env[key];
  }
  return env;
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  try {
    const { stdout } = await execFile("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      env: scrubGitEnvironment(),
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
    });
    return stdout;
  } catch (error) {
    proofRefusal(
      `CCC campaign proof Git check failed (${args[0] ?? "git"}): ${
        error instanceof Error ? error.message : String(error)
      }`,
      "CCC_CAMPAIGN_PROOF_GIT_REFUSED",
    );
  }
}

async function gitObject(cwd: string, revision: string, kind: "commit" | "tree"): Promise<string> {
  const suffix = kind === "commit" ? "^{commit}" : "^{tree}";
  const object = (await git(cwd, ["rev-parse", "--verify", `${revision}${suffix}`])).trim();
  if (!GIT_OBJECT_ID.test(object)) {
    proofRefusal(`CCC campaign proof ${kind} is not a canonical Git object id`);
  }
  return object;
}

async function registeredWorktreePaths(targetRoot: string): Promise<readonly string[]> {
  const output = await git(targetRoot, ["worktree", "list", "--porcelain"]);
  const paths: string[] = [];
  for (const line of output.split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    paths.push(await realpath(line.slice("worktree ".length)));
  }
  return paths;
}

async function assertAncestor(cwd: string, ancestor: string, descendant: string, label: string): Promise<void> {
  try {
    await execFile("git", ["-C", cwd, "merge-base", "--is-ancestor", ancestor, descendant], {
      env: scrubGitEnvironment(),
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
    });
  } catch {
    proofRefusal(
      `CCC campaign proof final commit does not integrate ${label} ${ancestor}`,
      "CCC_CAMPAIGN_PROOF_INTEGRATION_REFUSED",
    );
  }
}

async function taskCommit(
  task: TaskDetail,
  targetRoot: string,
  finalCommit: string,
): Promise<string> {
  if (task.id === undefined) {
    proofRefusal("CCC campaign proof task identity is missing");
  }
  if (task.worktree) {
    const worktree = await realpath(task.worktree).catch(() => undefined);
    if (!worktree) {
      proofRefusal(`CCC campaign proof task ${task.id} worktree is missing`);
    }
    const status = await git(worktree, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    if (status.length > 0) {
      proofRefusal(
        `CCC campaign proof task ${task.id} worktree has uncommitted changes`,
        "CCC_CAMPAIGN_PROOF_DIRTY_WORKTREE",
      );
    }
    return gitObject(worktree, "HEAD", "commit");
  }
  const mergeCommit = task.mergeDetails?.commitSha;
  if (typeof mergeCommit === "string" && GIT_OBJECT_ID.test(mergeCommit)) {
    return gitObject(targetRoot, mergeCommit, "commit");
  }
  if (typeof task.branch === "string" && task.branch.length > 0) {
    return gitObject(targetRoot, task.branch, "commit");
  }
  if (task.id && finalCommit) {
    proofRefusal(`CCC campaign proof cannot resolve campaign-created commit for task ${task.id}`);
  }
  return finalCommit;
}

async function inspectFinalGit(
  rootDir: string,
  finalTask: TaskDetail,
  campaign: CccCampaignTaskContext,
  tasks: readonly TaskDetail[],
  contexts: readonly CccCampaignTaskContext[],
): Promise<GitSnapshot> {
  if (!finalTask.worktree) {
    proofRefusal("CCC campaign proof integration task has no isolated worktree");
  }
  const [targetRoot, campaignTargetRoot, worktreeRoot] = await Promise.all([
    realpath(rootDir),
    realpath(campaign.targetRepository.path),
    realpath(finalTask.worktree),
  ]);
  if (targetRoot !== campaignTargetRoot) {
    proofRefusal("CCC campaign proof target repository differs from admitted custody");
  }
  if (worktreeRoot === targetRoot) {
    proofRefusal("CCC campaign proof requires an isolated task worktree");
  }
  const registered = await registeredWorktreePaths(targetRoot);
  if (!registered.includes(worktreeRoot)) {
    proofRefusal("CCC campaign proof integration worktree is not registered by the target repository");
  }
  const clean = await git(worktreeRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (clean.length > 0) {
    proofRefusal(
      "CCC campaign proof integration worktree has uncommitted changes",
      "CCC_CAMPAIGN_PROOF_DIRTY_WORKTREE",
    );
  }
  const sourceCommit = await gitObject(worktreeRoot, "HEAD", "commit");
  const sourceTree = await gitObject(worktreeRoot, "HEAD", "tree");
  const expectedBase = await gitObject(targetRoot, campaign.targetRepository.baseCommit, "commit");
  if (expectedBase !== campaign.targetRepository.baseCommit) {
    proofRefusal("CCC campaign proof target base differs from imported campaign custody");
  }
  if (sourceCommit === expectedBase) {
    proofRefusal(
      "CCC campaign proof requires a commit created by the campaign",
      "CCC_CAMPAIGN_PROOF_COMMIT_REQUIRED",
    );
  }
  await assertAncestor(worktreeRoot, expectedBase, sourceCommit, "campaign base");

  for (const task of tasks) {
    const commit = await taskCommit(task, targetRoot, sourceCommit);
    if (commit === expectedBase) {
      proofRefusal(
        `CCC campaign proof task ${task.id} has no campaign-created commit`,
        "CCC_CAMPAIGN_PROOF_COMMIT_REQUIRED",
      );
    }
    await assertAncestor(worktreeRoot, commit, sourceCommit, `task ${task.id}`);
  }

  const rawPaths = await git(worktreeRoot, [
    "diff",
    "--name-only",
    "-z",
    "--diff-filter=ACDMRTUXB",
    expectedBase,
    sourceCommit,
    "--",
  ]);
  const mutationPaths = rawPaths.split("\0").filter(Boolean).map(canonicalGitPath);
  if (mutationPaths.length === 0) {
    proofRefusal(
      "CCC campaign proof commit contains no source changes",
      "CCC_CAMPAIGN_PROOF_COMMIT_REQUIRED",
    );
  }
  const routeRoots = contexts
    .flatMap(({ route }) => route.allowedWriteRoots ?? [])
    .map(canonicalGitPath);
  if (routeRoots.length === 0) {
    proofRefusal(
      "CCC campaign proof has no route-scoped source write roots",
      "CCC_CAMPAIGN_PROOF_FOREIGN_PATH",
    );
  }
  for (const path of mutationPaths) {
    if (!routeRoots.some((root) => pathWithinRoot(path, root))) {
      proofRefusal(
        `CCC campaign proof commit changes path outside task ownership ${path}`,
        "CCC_CAMPAIGN_PROOF_FOREIGN_PATH",
      );
    }
  }
  return {
    targetRoot,
    worktreeRoot,
    sourceCommit,
    sourceTree,
    mutationPaths: Object.freeze([...new Set(mutationPaths)].sort()),
  };
}

async function verifierPreservedGitSnapshot(snapshot: GitSnapshot): Promise<boolean> {
  const [status, sourceCommit, sourceTree] = await Promise.all([
    git(snapshot.worktreeRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    gitObject(snapshot.worktreeRoot, "HEAD", "commit"),
    gitObject(snapshot.worktreeRoot, "HEAD", "tree"),
  ]);
  return status.length === 0
    && sourceCommit === snapshot.sourceCommit
    && sourceTree === snapshot.sourceTree;
}

function workItemFence(context: WorkflowNodeExecutionContext) {
  const fence = context.execution?.executionFence;
  if (
    !fence
    || typeof fence.workItemId !== "string"
    || fence.workItemId.length === 0
    || typeof fence.leaseOwner !== "string"
    || fence.leaseOwner.length === 0
    || typeof fence.runId !== "string"
    || fence.runId.length === 0
    || !Number.isSafeInteger(fence.attempt)
    || fence.attempt < 1
  ) {
    proofRefusal(
      "CCC campaign proof execution requires a sealed work-item fence",
      "CCC_CAMPAIGN_PROOF_FENCE_REFUSED",
    );
  }
  return {
    workItemId: fence.workItemId,
    leaseOwner: fence.leaseOwner,
    runId: fence.runId,
    attempt: fence.attempt,
  };
}

async function assertLiveWorkItemFence(
  store: ProofExecutionStore,
  originTaskId: string,
  fence: ReturnType<typeof workItemFence>,
): Promise<void> {
  try {
    await store.assertCccCampaignWorkflowLeaseFence({
      workItemId: fence.workItemId,
      originTaskId,
      leaseOwner: fence.leaseOwner,
      attempt: fence.attempt,
      runId: fence.runId,
    });
  } catch {
    proofRefusal(
      `CCC campaign proof work-item lease is no longer live for ${fence.workItemId}`,
      "CCC_CAMPAIGN_PROOF_FENCE_REFUSED",
    );
  }
}

function verificationTimeoutMs(
  campaign: CccCampaignTaskContext,
  context: WorkflowNodeExecutionContext,
): number {
  const configured = Number(
    (context.settings as { verificationCommandTimeoutMs?: unknown } | undefined)
      ?.verificationCommandTimeoutMs,
  );
  const configuredMs = Number.isFinite(configured) && configured > 0
    ? configured
    : 300_000;
  const deadlineRemaining = Date.parse(campaign.campaignDeadlineAt) - Date.now();
  if (!Number.isFinite(deadlineRemaining) || deadlineRemaining <= 0) {
    proofRefusal("CCC campaign proof deadline has expired");
  }
  return Math.max(
    1,
    Math.min(configuredMs, deadlineRemaining, MAX_TIMEOUT_SEC * 1_000),
  );
}

function defaultProofAttempts(): CccCampaignProofAttemptApi {
  return {
    reserve: (input) =>
      reserveCccCampaignProofAttempt(input) as Promise<ProofAttemptSnapshot>,
    begin: (input) =>
      beginCccCampaignProofAttemptDispatch(input) as Promise<ProofAttemptDispatchDecision>,
    settle: (input) =>
      settleCccCampaignProofAttempt(input) as Promise<ProofAttemptSnapshot>,
  };
}

function terminalAttemptResult(attempt: ProofAttemptSnapshot, proofId: string): WorkflowNodeResult | undefined {
  if (attempt.state === "committed") return undefined;
  if (attempt.state === "proved_failed") {
    return { outcome: "failure", value: `ccc-proof-failed:${proofId}` };
  }
  if (attempt.state === "dispatched_unknown") {
    proofRefusal(
      `CCC campaign proof ${proofId} has an uncertain dispatched verifier effect`,
      "CCC_CAMPAIGN_PROOF_DISPATCH_UNKNOWN",
    );
  }
  return undefined;
}

export function createCccCampaignProofSuiteHandler(
  input: CreateCccCampaignProofSuiteHandlerInput,
): WorkflowNodeHandler {
  const proofAttempts = input.proofAttempts ?? defaultProofAttempts();
  const runVerification = input.runVerification ?? runVerificationCommand;

  return async (node, context): Promise<WorkflowNodeResult> => {
    if (node.config?.cccProofSuite !== true) {
      proofRefusal("CCC campaign proof-suite handler received a non-proof node");
    }
    context.signal?.throwIfAborted();
    const proofIds = requiredStrings(node.config.cccProofIds, "proof ids");
    const semanticTaskIds = requiredStrings(node.config.cccPrdTaskIds, "semantic task ids");
    const nativeTaskIds = node.config.cccNativeTaskIds === undefined
      ? semanticTaskIds
      : requiredStrings(node.config.cccNativeTaskIds, "native task ids");
    const finalSemanticTaskId = node.config.cccPrdTaskId;
    const finalNativeTaskId = node.config.cccNativeTaskId ?? finalSemanticTaskId;
    if (
      nativeTaskIds.length !== semanticTaskIds.length
      || typeof finalSemanticTaskId !== "string"
      || finalSemanticTaskId.length === 0
      || finalSemanticTaskId !== finalSemanticTaskId.trim()
      || typeof finalNativeTaskId !== "string"
      || finalNativeTaskId.length === 0
      || finalNativeTaskId !== finalNativeTaskId.trim()
      || semanticTaskIds.indexOf(finalSemanticTaskId) < 0
      || nativeTaskIds[semanticTaskIds.indexOf(finalSemanticTaskId)] !== finalNativeTaskId
      || context.execution?.semanticTaskId !== finalSemanticTaskId
      || context.execution?.nativeTaskId !== finalNativeTaskId
    ) {
      proofRefusal("CCC campaign proof integration task identity is missing or does not match sealed execution");
    }
    const layer = input.store.getAsyncLayer();
    if (!layer) {
      proofRefusal("CCC campaign proof execution requires PostgreSQL custody");
    }
    const fence = workItemFence(context);
    const originTaskId = context.execution?.originTaskId;
    if (typeof originTaskId !== "string" || originTaskId.length === 0) {
      proofRefusal(
        "CCC campaign proof origin task identity is missing",
        "CCC_CAMPAIGN_PROOF_FENCE_REFUSED",
      );
    }
    await assertLiveWorkItemFence(input.store, originTaskId, fence);
    const tasks = await Promise.all(nativeTaskIds.map((taskId) => input.store.getTask(taskId)));
    const contexts = await Promise.all(nativeTaskIds.map((taskId) =>
      input.store.getCccCampaignContextForTask(taskId)));
    if (contexts.some((campaign) => campaign == null)) {
      proofRefusal("CCC campaign proof task custody is missing");
    }
    const campaigns = contexts as CccCampaignTaskContext[];
    const mappingDrift = campaigns.some((candidate, index) => (
      candidate.taskId !== nativeTaskIds[index]
      || candidate.semanticTaskId !== semanticTaskIds[index]
      || candidate.route.taskId !== semanticTaskIds[index]
    ));
    const campaign = campaigns.find(({ taskId }) => taskId === finalNativeTaskId);
    if (
      mappingDrift
      || !campaign
      || campaigns.some((candidate) => !sameCampaign(campaign, candidate))
    ) {
      proofRefusal("CCC campaign proof tasks do not share one exact imported campaign");
    }
    const declaredProofIds = campaign.proofs.map(({ id }) => id);
    if (!sameSorted(proofIds, declaredProofIds)) {
      proofRefusal("CCC campaign proof node must execute every declared proof exactly once");
    }
    const finalTask = tasks.find(({ id }) => id === finalNativeTaskId);
    if (!finalTask) {
      proofRefusal("CCC campaign proof integration task is missing");
    }
    const gitSnapshot = await inspectFinalGit(
      input.rootDir,
      finalTask,
      campaign,
      tasks,
      campaigns,
    );
    const timeoutMs = verificationTimeoutMs(campaign, context);

    for (const proofId of proofIds) {
      context.signal?.throwIfAborted();
      const proof = campaign.proofs.find(({ id }) => id === proofId);
      if (!proof) {
        proofRefusal(`CCC campaign proof ${proofId} definition is missing`);
      }
      const reserved = await proofAttempts.reserve({
        layer,
        rootDir: input.rootDir,
        taskId: finalNativeTaskId,
        proofId,
        scope: "campaign",
        sourceCommit: gitSnapshot.sourceCommit,
        sourceTree: gitSnapshot.sourceTree,
        workItemFence: fence,
      });
      const terminalReplay = terminalAttemptResult(reserved, proofId);
      if (terminalReplay) return terminalReplay;
      if (reserved.state === "committed") continue;

      await assertLiveWorkItemFence(input.store, originTaskId, fence);
      const dispatch = await proofAttempts.begin({
        layer,
        attemptKey: reserved.attemptKey,
        controllerToken: reserved.controllerToken,
      });
      if (dispatch.kind !== "dispatch-permit") {
        const terminal = terminalAttemptResult(dispatch.attempt, proofId);
        if (terminal) return terminal;
        if (dispatch.attempt.state === "committed") continue;
        proofRefusal(
          `CCC campaign proof ${proofId} dispatch was not permitted`,
          "CCC_CAMPAIGN_PROOF_DISPATCH_REFUSED",
        );
      }

      const result = await runVerification({
        command: proof.command,
        cwd: gitSnapshot.worktreeRoot,
        timeoutMs,
        onHeartbeat: () => undefined,
        signal: context.signal,
      });
      const preservedGitSnapshot = await verifierPreservedGitSnapshot(gitSnapshot);
      const settledResult = preservedGitSnapshot
        ? result
        : {
          ...result,
          success: false,
          warnings: [
            ...result.warnings,
            "CCC_CAMPAIGN_PROOF_VERIFIER_MUTATION: verifier changed the inspected commit, tree, or worktree",
          ],
        };
      await assertLiveWorkItemFence(input.store, originTaskId, fence);
      const settled = await proofAttempts.settle({
        layer,
        attemptKey: reserved.attemptKey,
        controllerToken: reserved.controllerToken,
        result: {
          ...settledResult,
          changedPathsSha256: sha256CanonicalStrings(gitSnapshot.mutationPaths),
        },
      });
      const terminal = terminalAttemptResult(settled, proofId);
      if (terminal) return terminal;
      if (settled.state !== "committed") {
        proofRefusal(
          `CCC campaign proof ${proofId} terminal state is invalid`,
          "CCC_CAMPAIGN_PROOF_SETTLEMENT_REFUSED",
        );
      }
    }

    return {
      outcome: "success",
      value: "ccc-proof-suite-passed",
      contextPatch: {
        "ccc:proof:source-commit": gitSnapshot.sourceCommit,
        "ccc:proof:source-tree": gitSnapshot.sourceTree,
        "ccc:proof:mutation-paths": gitSnapshot.mutationPaths,
        "ccc:proof:ids": proofIds,
      },
    };
  };
}
