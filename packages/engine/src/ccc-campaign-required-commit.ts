import { execFile as execFileCallback } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, posix } from "node:path";
import { promisify } from "node:util";
import type {
  CccCampaignTaskContext,
  TaskDetail,
  TaskStore,
} from "@fusion/core";
import { cccCampaignJoinBaseBranchName } from "./ccc-campaign-join-base.js";
import { isImportedCccCampaignTask } from "./ccc-campaign-routing.js";
import { PermanentError } from "./engine-errors.js";
import type {
  WorkflowNodeExecutionContext,
  WorkflowNodeResult,
} from "./workflow-graph-executor.js";
import { classifyTaskWorktree } from "./worktree-pool.js";

const execFile = promisify(execFileCallback);
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const MAX_GIT_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_GIT_ATTRIBUTE_ARGUMENT_BYTES = 512 * 1024;
const GIT_TIMEOUT_MS = 10_000;
const CONTROLLER_GIT_CONFIG = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "gc.auto=0",
] as const;

export const CCC_CAMPAIGN_REQUIRED_COMMIT_REFUSED_CODE =
  "CCC_CAMPAIGN_REQUIRED_COMMIT_REFUSED";

type RequiredCommitStore = Pick<
  TaskStore,
  | "getTask"
  | "getCccCampaignContextForTask"
  | "assertCccCampaignWorkflowLeaseFence"
>;

export interface EnforceCccCampaignRequiredCommitInput {
  rootDir: string;
  store: RequiredCommitStore;
  taskId: string;
  result: WorkflowNodeResult;
  executionContext?: WorkflowNodeExecutionContext;
}

function refusal(
  message: string,
  details?: Record<string, unknown>,
  cause?: Error,
): never {
  throw new PermanentError(
    message,
    CCC_CAMPAIGN_REQUIRED_COMMIT_REFUSED_CODE,
    details,
    cause,
  );
}

function errorCause(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
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
    const { stdout } = await execFile(
      "git",
      ["-C", cwd, ...CONTROLLER_GIT_CONFIG, ...args],
      {
        encoding: "utf8",
        env: scrubGitEnvironment(),
        maxBuffer: MAX_GIT_OUTPUT_BYTES,
        timeout: GIT_TIMEOUT_MS,
      },
    );
    return stdout;
  } catch (error) {
    refusal(
      `CCC campaign required-commit Git check failed (${args[0] ?? "git"})`,
      { cwd, gitCommand: args[0] },
      errorCause(error),
    );
  }
}

async function gitObject(cwd: string, revision: string): Promise<string> {
  const object = (
    await git(cwd, ["rev-parse", "--verify", `${revision}^{commit}`])
  ).trim();
  if (!GIT_OBJECT_ID.test(object)) {
    refusal("CCC campaign required-commit check resolved a non-canonical Git commit");
  }
  return object;
}

async function canonicalPath(path: string, label: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    refusal(
      `CCC campaign required-commit ${label} is missing or inaccessible`,
      { path },
      errorCause(error),
    );
  }
}

function canonicalGitPath(path: string, label: string): string {
  if (
    path.length === 0
    || path.includes("\0")
    || path.includes("\\")
    || isAbsolute(path)
    || posix.normalize(path) !== path
    || path === "."
    || path === ".."
    || path.startsWith("../")
  ) {
    refusal(
      `CCC campaign required-commit ${label} contains a non-canonical Git path`,
      { path },
    );
  }
  return path;
}

function pathWithinRoot(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

interface WorktreeStatusEntry {
  path: string;
  xy: string;
}

function parseWorktreeStatus(
  output: string,
  taskId: string,
): WorktreeStatusEntry[] {
  return output
    .split("\0")
    .filter(Boolean)
    .map((record) => {
      if (record.length < 4 || record[2] !== " ") {
        refusal(
          `CCC campaign required-commit task ${taskId} produced malformed Git status`,
        );
      }
      const xy = record.slice(0, 2);
      if (
        xy === "DD"
        || xy === "AU"
        || xy === "UD"
        || xy === "UA"
        || xy === "DU"
        || xy === "AA"
        || xy === "UU"
      ) {
        refusal(
          `CCC campaign required-commit task ${taskId} worktree has an unmerged path`,
          { xy },
        );
      }
      return {
        path: canonicalGitPath(record.slice(3), "worktree status"),
        xy,
      };
    });
}

async function readWorktreeStatus(
  worktreeRoot: string,
  taskId: string,
): Promise<WorktreeStatusEntry[]> {
  return parseWorktreeStatus(
    await git(worktreeRoot, [
      "-c",
      "status.renames=false",
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ]),
    taskId,
  );
}

function canonicalAllowedWriteRoots(
  taskId: string,
  campaign: CccCampaignTaskContext,
): string[] {
  const allowedWriteRoots = campaign.route.allowedWriteRoots;
  if (!Array.isArray(allowedWriteRoots) || allowedWriteRoots.length === 0) {
    refusal(
      `CCC campaign required-commit task ${taskId} route has no allowedWriteRoots`,
    );
  }
  return allowedWriteRoots.map((root) =>
    canonicalGitPath(root, "allowedWriteRoots"));
}

function assertPathsWithinAllowedRoots(
  taskId: string,
  paths: readonly string[],
  canonicalRoots: readonly string[],
): void {
  for (const path of paths) {
    if (!canonicalRoots.some((root) => pathWithinRoot(path, root))) {
      refusal(
        `CCC campaign required-commit task ${taskId} changes path outside allowedWriteRoots: ${path}`,
        { path, allowedWriteRoots: canonicalRoots },
      );
    }
  }
}

async function assertNoActiveGitFilters(
  worktreeRoot: string,
  taskId: string,
  paths: readonly string[],
): Promise<void> {
  const argumentBytes = paths.reduce(
    (total, path) => total + Buffer.byteLength(path, "utf8") + 1,
    0,
  );
  if (argumentBytes > MAX_GIT_ATTRIBUTE_ARGUMENT_BYTES) {
    refusal(
      `CCC campaign required-commit task ${taskId} Git filter check exceeds its bounded input`,
      { argumentBytes, maximumBytes: MAX_GIT_ATTRIBUTE_ARGUMENT_BYTES },
    );
  }
  const output = await git(worktreeRoot, [
    "check-attr",
    "-z",
    "filter",
    "--",
    ...paths,
  ]);
  const fields = output.split("\0");
  if (fields.at(-1) === "") fields.pop();
  if (fields.length !== paths.length * 3) {
    refusal(
      `CCC campaign required-commit task ${taskId} Git filter check returned malformed output`,
    );
  }
  for (let index = 0; index < fields.length; index += 3) {
    const path = canonicalGitPath(fields[index]!, "Git filter path");
    const attribute = fields[index + 1];
    const value = fields[index + 2];
    if (attribute !== "filter" || !value) {
      refusal(
        `CCC campaign required-commit task ${taskId} Git filter check returned malformed output`,
      );
    }
    if (value !== "unspecified" && value !== "unset") {
      refusal(
        `CCC campaign required-commit task ${taskId} refuses active Git filter ${value} for ${path}`,
        { path, filter: value },
      );
    }
  }
}

function isRequiredProductRoute(campaign: CccCampaignTaskContext): boolean {
  return campaign.executionPolicy.schema === "ccc-campaign.execution-policy.v2"
    && campaign.route.toolMode === "coding"
    && campaign.route.commitPolicy === "required";
}

function assertExactCustody(
  taskId: string,
  task: TaskDetail,
  campaign: CccCampaignTaskContext,
  executionContext: WorkflowNodeExecutionContext,
): void {
  const execution = executionContext.execution;
  if (
    !execution
    || !Object.isFrozen(execution)
    || !execution.executionFence
    || !Object.isFrozen(execution.executionFence)
    || execution.nativeTaskId !== taskId
    || execution.semanticTask.id !== taskId
    || executionContext.task.id !== taskId
    || task.id !== taskId
    || campaign.taskId !== taskId
    || execution.semanticTaskId !== campaign.semanticTaskId
    || campaign.route.taskId !== campaign.semanticTaskId
  ) {
    refusal(
      `CCC campaign required-commit custody does not match sealed task ${taskId}`,
    );
  }
}

async function assertLiveWorkItemFence(
  store: RequiredCommitStore,
  taskId: string,
  executionContext: WorkflowNodeExecutionContext,
): Promise<void> {
  const execution = executionContext.execution;
  const fence = execution?.executionFence;
  if (
    !execution
    || !fence
    || typeof execution.originTaskId !== "string"
    || execution.originTaskId.length === 0
    || typeof fence.workItemId !== "string"
    || fence.workItemId.length === 0
    || typeof fence.leaseOwner !== "string"
    || fence.leaseOwner.length === 0
    || typeof fence.runId !== "string"
    || fence.runId.length === 0
    || !Number.isSafeInteger(fence.attempt)
    || fence.attempt < 1
  ) {
    refusal(
      `CCC campaign required-commit task ${taskId} has no canonical live-work fence`,
    );
  }
  try {
    await store.assertCccCampaignWorkflowLeaseFence({
      workItemId: fence.workItemId,
      originTaskId: execution.originTaskId,
      leaseOwner: fence.leaseOwner,
      attempt: fence.attempt,
      runId: fence.runId,
    });
  } catch (error) {
    refusal(
      `CCC campaign required-commit task ${taskId} work-item lease is no longer live`,
      { taskId, workItemId: fence.workItemId },
      errorCause(error),
    );
  }
}

async function loadExactTaskCustody(
  store: RequiredCommitStore,
  taskId: string,
): Promise<{
  task: TaskDetail;
  campaign: CccCampaignTaskContext | null;
}> {
  try {
    const [task, campaign] = await Promise.all([
      store.getTask(taskId),
      store.getCccCampaignContextForTask(taskId),
    ]);
    return { task, campaign };
  } catch (error) {
    refusal(
      `CCC campaign required-commit could not reload exact task ${taskId}`,
      { taskId },
      errorCause(error),
    );
  }
}

async function assertRegisteredIsolatedWorktree(
  targetRoot: string,
  task: TaskDetail,
): Promise<string> {
  if (typeof task.worktree !== "string" || task.worktree.length === 0) {
    refusal(
      `CCC campaign required-commit task ${task.id} has no persisted isolated worktree`,
    );
  }
  const worktreeRoot = await canonicalPath(task.worktree, "task worktree");
  if (worktreeRoot === targetRoot) {
    refusal(
      `CCC campaign required-commit task ${task.id} must use an isolated worktree`,
    );
  }
  let classification: Awaited<ReturnType<typeof classifyTaskWorktree>>;
  try {
    classification = await classifyTaskWorktree(targetRoot, worktreeRoot);
  } catch (error) {
    refusal(
      `CCC campaign required-commit task ${task.id} worktree classification failed`,
      undefined,
      errorCause(error),
    );
  }
  if (!classification.ok) {
    refusal(
      `CCC campaign required-commit task ${task.id} worktree is not a registered isolated worktree: ${classification.reason}`,
      { classification: classification.classification },
    );
  }
  return worktreeRoot;
}

async function assertPersistedBranchAtHead(
  worktreeRoot: string,
  task: TaskDetail,
  head: string,
): Promise<void> {
  if (
    typeof task.branch !== "string"
    || task.branch.length === 0
    || task.branch !== task.branch.trim()
  ) {
    refusal(
      `CCC campaign required-commit task ${task.id} has no canonical persisted branch`,
    );
  }

  let checkedOutBranch: string;
  try {
    const { stdout } = await execFile(
      "git",
      [
        "-C",
        worktreeRoot,
        ...CONTROLLER_GIT_CONFIG,
        "symbolic-ref",
        "--quiet",
        "--short",
        "HEAD",
      ],
      {
        encoding: "utf8",
        env: scrubGitEnvironment(),
        maxBuffer: MAX_GIT_OUTPUT_BYTES,
        timeout: GIT_TIMEOUT_MS,
      },
    );
    checkedOutBranch = stdout.trim();
  } catch (error) {
    refusal(
      `CCC campaign required-commit task ${task.id} HEAD is not on its persisted branch`,
      undefined,
      errorCause(error),
    );
  }

  if (checkedOutBranch !== task.branch) {
    refusal(
      `CCC campaign required-commit task ${task.id} checked-out branch differs from its persisted branch`,
      { checkedOutBranch, persistedBranch: task.branch },
    );
  }
  const persistedBranchHead = await gitObject(
    worktreeRoot,
    `refs/heads/${task.branch}`,
  );
  if (persistedBranchHead !== head) {
    refusal(
      `CCC campaign required-commit task ${task.id} persisted branch ref is not HEAD`,
      { head, persistedBranchHead },
    );
  }
}

/*
FNXC:CccCampaignChainedRequiredCommit 2026-08-01-00:00:
A serial campaign chain forks each successor's worktree from its predecessor's tip
(executor.ts:9272-9299), so a successor's worktree legitimately STARTS at the
predecessor's campaign commit rather than the frozen campaign base. Comparing a
successor against the frozen base is wrong in both directions: it refuses a
legitimate successor whose agent left its change uncommitted, and it accepts a
successor that created no commit at all (the predecessor's commit already moved
HEAD off the frozen base). Every such comparison must use the task's OWN start.
*/
type ExpectedStartCommit = Readonly<{
  commit: string;
  reference: "frozen-base" | "predecessor-commit" | "join-base-commit";
  predecessorTaskId?: string;
  predecessorTaskIds?: readonly string[];
}>;

function describeExpectedStart(expected: ExpectedStartCommit): string {
  if (expected.reference === "frozen-base") return "the frozen campaign base";
  if (expected.reference === "join-base-commit") {
    return `the merged join base of dependency predecessors ${(expected.predecessorTaskIds ?? []).join(", ")}`;
  }
  return `the campaign commit of dependency predecessor ${expected.predecessorTaskId}`;
}

function expectedStartDetails(
  expected: ExpectedStartCommit,
): Record<string, unknown> {
  return {
    expectedStartCommit: expected.commit,
    expectedStartReference: expected.reference,
    ...(expected.predecessorTaskId === undefined
      ? {}
      : { predecessorTaskId: expected.predecessorTaskId }),
    ...(expected.predecessorTaskIds === undefined
      ? {}
      : { predecessorTaskIds: [...expected.predecessorTaskIds] }),
  };
}

/** Resolves a revision without refusing, so callers can name what was missing. */
async function optionalGitObject(
  cwd: string,
  revision: string,
): Promise<string | null> {
  try {
    const { stdout } = await execFile(
      "git",
      ["-C", cwd, ...CONTROLLER_GIT_CONFIG, "rev-parse", "--verify", `${revision}^{commit}`],
      {
        encoding: "utf8",
        env: scrubGitEnvironment(),
        maxBuffer: MAX_GIT_OUTPUT_BYTES,
        timeout: GIT_TIMEOUT_MS,
      },
    );
    const object = stdout.trim();
    return GIT_OBJECT_ID.test(object) ? object : null;
  } catch {
    return null;
  }
}

/*
The proof gate's per-task commit ladder (ccc-campaign-proof-execution.ts:236-269):
isolated worktree HEAD, then the recorded merge commit, then the persisted branch.
This walks the same durable sources but falls through a source that no longer
resolves instead of refusing on it, because a disposed predecessor worktree still
has an authoritative branch ref. Exhausting the ladder is a refusal: a task that
declares a predecessor must never silently fall back to the frozen base.
*/
async function derivePredecessorCampaignCommit(
  targetRoot: string,
  taskId: string,
  predecessor: TaskDetail,
): Promise<string> {
  if (typeof predecessor.worktree === "string" && predecessor.worktree.length > 0) {
    const predecessorWorktree = await realpath(predecessor.worktree)
      .catch(() => undefined);
    const commit = predecessorWorktree === undefined
      ? null
      : await optionalGitObject(predecessorWorktree, "HEAD");
    if (commit) return commit;
  }
  const mergeCommit = predecessor.mergeDetails?.commitSha;
  if (typeof mergeCommit === "string" && GIT_OBJECT_ID.test(mergeCommit)) {
    const commit = await optionalGitObject(targetRoot, mergeCommit);
    if (commit) return commit;
  }
  if (typeof predecessor.branch === "string" && predecessor.branch.length > 0) {
    const commit = await optionalGitObject(
      targetRoot,
      `refs/heads/${predecessor.branch}`,
    );
    if (commit) return commit;
  }
  refusal(
    `CCC campaign required-commit task ${taskId} cannot derive the campaign commit of its dependency predecessor ${predecessor.id} from durable state`,
    {
      taskId,
      predecessorTaskId: predecessor.id,
      predecessorWorktree: predecessor.worktree,
      predecessorBranch: predecessor.branch,
      predecessorMergeCommit: predecessor.mergeDetails?.commitSha,
    },
  );
}

/** True when `base` is an ancestor of `head`, without refusing on its own. */
async function optionalIsAncestor(
  cwd: string,
  base: string,
  head: string,
): Promise<boolean> {
  try {
    await execFile(
      "git",
      ["-C", cwd, ...CONTROLLER_GIT_CONFIG, "merge-base", "--is-ancestor", base, head],
      {
        env: scrubGitEnvironment(),
        maxBuffer: MAX_GIT_OUTPUT_BYTES,
        timeout: GIT_TIMEOUT_MS,
      },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Mirrors the executor's chain gating exactly (resolveCccCampaignChainedStartBranch):
 * a single predecessor starts at that predecessor's campaign commit; a fan-in
 * join task starts at the controller-owned join base branch that merged every
 * predecessor branch (ccc-campaign-join-base.ts) — and that join base must
 * still contain every predecessor's campaign commit, or a branch's work was
 * silently lost before the join task ran.
 */
async function resolveExpectedStartCommit(
  store: RequiredCommitStore,
  targetRoot: string,
  task: TaskDetail,
  frozenBase: string,
): Promise<ExpectedStartCommit> {
  const frozenStart: ExpectedStartCommit = {
    commit: frozenBase,
    reference: "frozen-base",
  };
  if (!isImportedCccCampaignTask(task)) return frozenStart;
  const dependencies = (task.dependencies ?? []).filter((id): id is string =>
    typeof id === "string" && id.length > 0);
  if (dependencies.length === 0) return frozenStart;
  if (dependencies.length > 1) {
    const predecessorTaskIds = [...dependencies].sort();
    const predecessors: TaskDetail[] = [];
    for (const predecessorTaskId of predecessorTaskIds) {
      const predecessor = await store.getTask(predecessorTaskId).catch(() => undefined);
      if (!predecessor || predecessor.id !== predecessorTaskId) {
        refusal(
          `CCC campaign required-commit task ${task.id} cannot load its dependency predecessor ${predecessorTaskId}`,
          { taskId: task.id, predecessorTaskId },
        );
      }
      predecessors.push(predecessor);
    }
    const joinBranch = cccCampaignJoinBaseBranchName(task.id);
    const joinTip = await optionalGitObject(targetRoot, `refs/heads/${joinBranch}`);
    if (joinTip === null) {
      refusal(
        `CCC campaign required-commit task ${task.id} declares ${dependencies.length} dependency predecessors but its join base branch "${joinBranch}" is unresolvable`,
        { taskId: task.id, joinBranch, predecessorTaskIds },
      );
    }
    for (const predecessor of predecessors) {
      const predecessorCommit = await derivePredecessorCampaignCommit(
        targetRoot,
        task.id,
        predecessor,
      );
      if (!(await optionalIsAncestor(targetRoot, predecessorCommit, joinTip))) {
        refusal(
          `CCC campaign required-commit task ${task.id} join base "${joinBranch}" does not contain the campaign commit of dependency predecessor ${predecessor.id}`,
          {
            taskId: task.id,
            joinBranch,
            joinTip,
            predecessorTaskId: predecessor.id,
            predecessorCommit,
          },
        );
      }
    }
    return {
      commit: joinTip,
      reference: "join-base-commit",
      predecessorTaskIds,
    };
  }
  const predecessorTaskId = dependencies[0]!;
  const predecessor = await store.getTask(predecessorTaskId).catch(() => undefined);
  if (!predecessor || predecessor.id !== predecessorTaskId) {
    refusal(
      `CCC campaign required-commit task ${task.id} cannot load its dependency predecessor ${predecessorTaskId}`,
      { taskId: task.id, predecessorTaskId },
    );
  }
  return {
    commit: await derivePredecessorCampaignCommit(
      targetRoot,
      task.id,
      predecessor,
    ),
    reference: "predecessor-commit",
    predecessorTaskId,
  };
}

async function assertBaseAncestor(
  worktreeRoot: string,
  base: string,
  head: string,
): Promise<void> {
  try {
    await execFile(
      "git",
      [
        "-C",
        worktreeRoot,
        ...CONTROLLER_GIT_CONFIG,
        "merge-base",
        "--is-ancestor",
        base,
        head,
      ],
      {
        env: scrubGitEnvironment(),
        maxBuffer: MAX_GIT_OUTPUT_BYTES,
        timeout: GIT_TIMEOUT_MS,
      },
    );
  } catch (error) {
    refusal(
      "CCC campaign required-commit HEAD does not descend from the frozen campaign base",
      { base, head },
      errorCause(error),
    );
  }
}

async function createControllerOwnedCommit(
  worktreeRoot: string,
  task: TaskDetail,
  canonicalRoots: readonly string[],
  status: readonly WorktreeStatusEntry[],
  assertFence: () => Promise<void>,
): Promise<void> {
  assertPathsWithinAllowedRoots(
    task.id,
    status.map((entry) => entry.path),
    canonicalRoots,
  );
  await assertNoActiveGitFilters(
    worktreeRoot,
    task.id,
    status.map((entry) => entry.path),
  );
  await assertFence();
  await git(worktreeRoot, ["add", "-A", "--", ...canonicalRoots]);

  const stagedStatus = await readWorktreeStatus(worktreeRoot, task.id);
  if (
    stagedStatus.length === 0
    || stagedStatus.some(({ xy }) => xy === "??" || xy[1] !== " ")
  ) {
    refusal(
      `CCC campaign required-commit task ${task.id} could not stage one exact admitted change set`,
    );
  }
  assertPathsWithinAllowedRoots(
    task.id,
    stagedStatus.map((entry) => entry.path),
    canonicalRoots,
  );

  const stagedPaths = (
    await git(worktreeRoot, [
      "diff",
      "--cached",
      "--name-only",
      "-z",
      "--no-renames",
      "--diff-filter=ACDMRTUXB",
      "--",
    ])
  )
    .split("\0")
    .filter(Boolean)
    .map((path) => canonicalGitPath(path, "staged commit"));
  if (stagedPaths.length === 0) {
    refusal(
      `CCC campaign required-commit task ${task.id} has no staged admitted source change`,
    );
  }
  assertPathsWithinAllowedRoots(task.id, stagedPaths, canonicalRoots);

  await assertFence();
  await git(worktreeRoot, [
    "-c",
    "user.name=ccc-fusion",
    "-c",
    "user.email=ccc-fusion@localhost",
    "commit",
    "--no-gpg-sign",
    "-m",
    `ccc-fusion campaign ${task.id}`,
  ]);
}

async function inspectRequiredCommit(
  rootDir: string,
  store: RequiredCommitStore,
  task: TaskDetail,
  campaign: CccCampaignTaskContext,
  assertFence: () => Promise<void>,
): Promise<void> {
  if (campaign.route.worktreeMode !== "isolated") {
    refusal("CCC campaign required-commit route does not require an isolated worktree");
  }
  const [targetRoot, admittedTargetRoot] = await Promise.all([
    canonicalPath(rootDir, "executor repository"),
    canonicalPath(campaign.targetRepository.path, "admitted target repository"),
  ]);
  if (targetRoot !== admittedTargetRoot) {
    refusal(
      "CCC campaign required-commit executor repository differs from imported custody",
      { targetRoot, admittedTargetRoot },
    );
  }
  const frozenBase = campaign.targetRepository.baseCommit;
  if (
    !GIT_OBJECT_ID.test(frozenBase)
    || task.baseCommitSha !== frozenBase
  ) {
    refusal(
      `CCC campaign required-commit task ${task.id} base differs from the frozen campaign base`,
      { frozenBase, persistedBase: task.baseCommitSha },
    );
  }

  const expectedStart = await resolveExpectedStartCommit(
    store,
    targetRoot,
    task,
    frozenBase,
  );

  const worktreeRoot = await assertRegisteredIsolatedWorktree(targetRoot, task);
  const [initialHead, resolvedBase] = await Promise.all([
    gitObject(worktreeRoot, "HEAD"),
    gitObject(worktreeRoot, frozenBase),
  ]);
  if (resolvedBase !== frozenBase) {
    refusal(
      `CCC campaign required-commit task ${task.id} frozen base is not canonical`,
      { frozenBase, resolvedBase },
    );
  }
  await assertBaseAncestor(worktreeRoot, frozenBase, initialHead);
  await assertPersistedBranchAtHead(worktreeRoot, task, initialHead);

  const canonicalRoots = canonicalAllowedWriteRoots(task.id, campaign);
  const initialStatus = await readWorktreeStatus(worktreeRoot, task.id);
  if (initialStatus.length > 0 && initialHead !== expectedStart.commit) {
    refusal(
      `CCC campaign required-commit task ${task.id} worktree has uncommitted changes at HEAD ${initialHead}, which is not its expected start commit ${expectedStart.commit} (${describeExpectedStart(expectedStart)})`,
      {
        taskId: task.id,
        head: initialHead,
        frozenBase,
        ...expectedStartDetails(expectedStart),
      },
    );
  }
  if (initialStatus.length > 0) {
    await createControllerOwnedCommit(
      worktreeRoot,
      task,
      canonicalRoots,
      initialStatus,
      assertFence,
    );
  }

  const finalStatus = await readWorktreeStatus(worktreeRoot, task.id);
  if (finalStatus.length > 0) {
    refusal(
      `CCC campaign required-commit task ${task.id} worktree has uncommitted changes`,
    );
  }
  const head = await gitObject(worktreeRoot, "HEAD");
  if (head === expectedStart.commit) {
    refusal(
      `CCC campaign required-commit task ${task.id} has no campaign-created commit: HEAD is still its expected start commit ${expectedStart.commit} (${describeExpectedStart(expectedStart)})`,
      { taskId: task.id, head, frozenBase, ...expectedStartDetails(expectedStart) },
    );
  }
  await assertBaseAncestor(worktreeRoot, frozenBase, head);
  await assertPersistedBranchAtHead(worktreeRoot, task, head);

  /*
  Diff from this task's OWN start, not the frozen base: a chained successor's
  frozen-base diff also contains every predecessor's paths, which the successor's
  route never admits, so a frozen-base comparison refuses each legitimate
  successor for its predecessor's work. The campaign-wide frozen-base diff is the
  proof gate's job, against the union of route roots
  (ccc-campaign-proof-execution.ts:328-360).
  */
  const changedPaths = (
    await git(worktreeRoot, [
      "diff",
      "--name-only",
      "-z",
      "--no-renames",
      "--diff-filter=ACDMRTUXB",
      expectedStart.commit,
      head,
      "--",
    ])
  )
    .split("\0")
    .filter(Boolean)
    .map((path) => canonicalGitPath(path, "commit"));
  if (changedPaths.length === 0) {
    refusal(
      `CCC campaign required-commit task ${task.id} campaign-created commit has no changed paths since its expected start commit ${expectedStart.commit} (${describeExpectedStart(expectedStart)})`,
      { taskId: task.id, head, ...expectedStartDetails(expectedStart) },
    );
  }
  assertPathsWithinAllowedRoots(task.id, changedPaths, canonicalRoots);
}

export async function enforceCccCampaignRequiredCommitAfterNode(
  input: EnforceCccCampaignRequiredCommitInput,
): Promise<void> {
  if (
    input.result.outcome !== "success"
    || !input.executionContext?.execution?.executionFence
  ) {
    return;
  }
  const taskId = input.executionContext.execution.nativeTaskId;
  if (taskId !== input.taskId) {
    refusal(
      `CCC campaign required-commit invocation task ${input.taskId} differs from sealed task ${taskId}`,
    );
  }
  const { task, campaign } = await loadExactTaskCustody(input.store, taskId);
  if (!campaign || !isRequiredProductRoute(campaign)) {
    return;
  }
  assertExactCustody(
    taskId,
    task,
    campaign,
    input.executionContext,
  );
  const assertFence = () =>
    assertLiveWorkItemFence(input.store, taskId, input.executionContext!);
  await assertFence();
  await inspectRequiredCommit(
    input.rootDir,
    input.store,
    task,
    campaign,
    assertFence,
  );
}
