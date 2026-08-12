import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { PermanentError } from "./engine-errors.js";
import { canonicalFusionBranchName } from "./worktree-names.js";

const execFile = promisify(execFileCallback);
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const MAX_GIT_OUTPUT_BYTES = 8 * 1024 * 1024;
const GIT_TIMEOUT_MS = 60_000;
const CONTROLLER_GIT_CONFIG = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "gc.auto=0",
] as const;
const MERGE_IDENTITY_CONFIG = [
  "-c",
  "user.name=ccc-fusion",
  "-c",
  "user.email=ccc-fusion@localhost",
] as const;

export const CCC_CAMPAIGN_JOIN_MERGE_CONFLICT_CODE =
  "CCC_CAMPAIGN_JOIN_MERGE_CONFLICT";
const CHAINED_WORKTREE_REFUSED_CODE = "CCC_CAMPAIGN_CHAINED_WORKTREE_REFUSED";

export type CccCampaignJoinBasePredecessor = Readonly<{
  taskId: string;
  branch: string;
}>;

export interface EnsureCccCampaignJoinBaseBranchInput {
  /** Campaign target repository root (the executor's rootDir). */
  rootDir: string;
  /** The join task whose worktree start point is being built. */
  taskId: string;
  /** Every dependency predecessor; ordered deterministically by task id here. */
  predecessors: readonly CccCampaignJoinBasePredecessor[];
}

/**
 * Controller-owned branch that holds the merged start point for a fan-in join
 * task. Task working branches are `fusion/<taskid>`; native task ids end in
 * digits, so the `-ccc-join-base` suffix can never collide with another
 * task's working branch.
 */
export function cccCampaignJoinBaseBranchName(taskId: string): string {
  return `${canonicalFusionBranchName(taskId)}-ccc-join-base`;
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
}

async function optionalCommit(cwd: string, revision: string): Promise<string | null> {
  try {
    const object = (
      await git(cwd, ["rev-parse", "--verify", `${revision}^{commit}`])
    ).trim();
    return GIT_OBJECT_ID.test(object) ? object : null;
  } catch {
    return null;
  }
}

async function isAncestor(cwd: string, base: string, head: string): Promise<boolean> {
  try {
    await git(cwd, ["merge-base", "--is-ancestor", base, head]);
    return true;
  } catch {
    return false;
  }
}

/*
FNXC:CccCampaignJoinWorktrees 2026-08-12-00:00:
A fan-in join task declares more than one dependency predecessor, and the campaign
proof gate requires EVERY campaign task's commit to be an ancestor of the final
integration HEAD (ccc-campaign-proof-execution.ts per-task ancestry loop). Starting
the join task from any single predecessor branch silently drops the other branches'
history and the whole campaign is refused much later at proof time. So the join
task's start point is a controller-owned branch that MERGES every predecessor's
result branch: deterministic predecessor order (sorted by native task id), merge
commits created in a disposable scratch worktree, predecessor branches never
mutated. A genuine merge conflict between sibling branches is an operator decision,
never an auto-resolution: the campaign compiler admits only ownership-disjoint
tasks, so a conflict here means custody was violated or an out-of-band edit
happened — park it loudly with a machine reason instead of guessing.
*/
export async function ensureCccCampaignJoinBaseBranch(
  input: EnsureCccCampaignJoinBaseBranchInput,
): Promise<string> {
  const { rootDir, taskId } = input;
  const ordered = [...input.predecessors].sort((a, b) =>
    a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0);
  if (ordered.length < 2) {
    throw new PermanentError(
      `CCC campaign join task ${taskId} requires at least two dependency predecessors to build a join base`,
      CHAINED_WORKTREE_REFUSED_CODE,
    );
  }

  const tips: { taskId: string; branch: string; tip: string }[] = [];
  for (const predecessor of ordered) {
    const tip = await optionalCommit(rootDir, `refs/heads/${predecessor.branch}`);
    if (tip === null) {
      throw new PermanentError(
        `CCC campaign task ${taskId} predecessor ${predecessor.taskId} has no resolvable working branch "${predecessor.branch}"`,
        CHAINED_WORKTREE_REFUSED_CODE,
      );
    }
    tips.push({ ...predecessor, tip });
  }

  const joinBranch = cccCampaignJoinBaseBranchName(taskId);
  const existingTip = await optionalCommit(rootDir, `refs/heads/${joinBranch}`);
  if (existingTip !== null) {
    let complete = true;
    for (const { tip } of tips) {
      if (!(await isAncestor(rootDir, tip, existingTip))) {
        complete = false;
        break;
      }
    }
    // Idempotent reuse: preparation and creation both resolve the start branch,
    // and a crash-resumed work item resolves it again — an already-complete
    // join base must not grow a second merge commit.
    if (complete) return joinBranch;
  }

  const scratch = await mkdtemp(join(tmpdir(), "fusion-ccc-join-base-"));
  let scratchRegistered = false;
  try {
    await git(rootDir, ["worktree", "add", "--detach", "--force", scratch, tips[0]!.tip]);
    scratchRegistered = true;
    for (const { taskId: predecessorTaskId, branch, tip } of tips.slice(1)) {
      try {
        await git(scratch, [
          ...MERGE_IDENTITY_CONFIG,
          "merge",
          "--no-edit",
          "--no-gpg-sign",
          "-m",
          `ccc-fusion campaign ${taskId} join base`,
          tip,
        ]);
      } catch (error) {
        await git(scratch, ["merge", "--abort"]).catch(() => undefined);
        throw new PermanentError(
          `CCC campaign join task ${taskId} cannot merge predecessor ${predecessorTaskId} branch "${branch}": the predecessor branches conflict and campaign joins never auto-resolve conflicts`,
          CCC_CAMPAIGN_JOIN_MERGE_CONFLICT_CODE,
          {
            taskId,
            predecessorTaskId,
            predecessorBranch: branch,
            predecessors: tips.map((entry) => ({
              taskId: entry.taskId,
              branch: entry.branch,
              tip: entry.tip,
            })),
          },
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }
    const mergedTip = (await git(scratch, ["rev-parse", "--verify", "HEAD^{commit}"])).trim();
    if (!GIT_OBJECT_ID.test(mergedTip)) {
      throw new PermanentError(
        `CCC campaign join task ${taskId} join base merge resolved a non-canonical commit`,
        CHAINED_WORKTREE_REFUSED_CODE,
      );
    }
    await git(rootDir, ["branch", "-f", joinBranch, mergedTip]);
    return joinBranch;
  } finally {
    if (scratchRegistered) {
      await git(rootDir, ["worktree", "remove", "--force", scratch])
        .catch(() => undefined);
      await git(rootDir, ["worktree", "prune"]).catch(() => undefined);
    }
  }
}
