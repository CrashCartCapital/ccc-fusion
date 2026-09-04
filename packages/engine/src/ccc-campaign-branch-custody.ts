import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Task } from "@fusion/core";
import { branchCarriesCampaignToken, cccCampaignBranchToken } from "./worktree-names.js";

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = 10 * 1024 * 1024;

export const CCC_CAMPAIGN_FOREIGN_BRANCH_REFUSED_CODE = "CCC_CAMPAIGN_FOREIGN_BRANCH_REFUSED";

/*
FNXC:CccCampaignBranchCustody 2026-09-03-01:00:
ONE choke point for "may this campaign task take over this branch?".

The L12 round-2 failure had two halves. Branch names were not campaign-unique,
so a fresh database re-allocating ids collided with a previous campaign's
leftovers; and adoption was decided by name coincidence, so the pool adopted the
owner's registered worktree and relocated it out of the owner's repository
before the frozen-base guard refused.

Scoping the branch name fixes the first half. It does NOT fix the second,
because more than one path writes a branch onto a task row:

  - `acquireTaskWorktree` creates/recycles/relocates a worktree, and
  - `reconcileInReviewBranchRebind` repairs an absent or broken `task.branch`
    on a name + unique-work match, whose trigger (falsy `task.branch`) is
    precisely the fresh-import shape.

A rebind is "only metadata", but the metadata is authority: the persisted branch
becomes the PR head, the push target, and the argument to `git branch -D` in
merge cleanup. So both writers ask the same question here, and both get the same
answer.

Custody requires BOTH halves, and nothing here is decided by name coincidence:

  1. the branch carries THIS campaign's identity token (name-level), and
  2. its tip descends from the sealed base (history-level, git-proven).

Missing proof is refusal, never permission: a campaign task with no sealed base
to compare against returns `custody-unknown` and adopts nothing. Anything that
fails is left completely alone — never adopted, moved, pruned, reset, or
force-created over.
*/

export type CccCampaignBranchCustodyVerdict =
  | { ok: true; reason: "not-a-campaign-task" | "branch-absent" | "descends-from-sealed-base" }
  | { ok: false; reason: "foreign-token" | "not-descended-from-sealed-base" | "custody-unknown"; detail: string };

async function branchExists(repoDir: string, branchName: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branchName}`], {
      cwd: repoDir,
      encoding: "utf-8",
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
    });
    return true;
  } catch {
    return false;
  }
}

async function descendsFrom(repoDir: string, ancestor: string, branchName: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["merge-base", "--is-ancestor", ancestor, branchName], {
      cwd: repoDir,
      encoding: "utf-8",
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * May this task take over `branchName`?
 *
 * Ordinary (non-campaign) tasks are unaffected and always pass: their custody
 * is governed by the existing branch-conflict classification, not by campaign
 * lineage.
 *
 * `requireExistingBranch` distinguishes the two callers. Acquisition is about
 * to CREATE the branch if it is absent, so absence is the normal path and
 * passes. A rebind is about to bind to an EXISTING branch, so an absent branch
 * is not a candidate at all and the caller filters it out beforehand.
 */
export async function inspectCccCampaignBranchCustody(input: {
  task: Pick<Task, "id"> & Partial<Pick<Task, "lineageId">>;
  repoDir: string;
  branchName: string;
  sealedBase: string | null | undefined;
}): Promise<CccCampaignBranchCustodyVerdict> {
  const { task, repoDir, branchName, sealedBase } = input;

  const token = cccCampaignBranchToken(task.lineageId);
  if (!token) return { ok: true, reason: "not-a-campaign-task" };

  if (!branchCarriesCampaignToken(branchName, token)) {
    return {
      ok: false,
      reason: "foreign-token",
      detail: `branch ${branchName} does not carry campaign token ${token}; it belongs to another owner`,
    };
  }

  if (!sealedBase) {
    return {
      ok: false,
      reason: "custody-unknown",
      detail: `campaign task ${task.id} has no sealed base commit, so descent of ${branchName} cannot be proven`,
    };
  }

  if (!await branchExists(repoDir, branchName)) {
    return { ok: true, reason: "branch-absent" };
  }

  if (!await descendsFrom(repoDir, sealedBase, branchName)) {
    return {
      ok: false,
      reason: "not-descended-from-sealed-base",
      detail: `branch ${branchName} exists and does not descend from the sealed base ${sealedBase}`,
    };
  }

  return { ok: true, reason: "descends-from-sealed-base" };
}

/**
 * Custody for a branch a campaign task is about to CREATE or take over during
 * acquisition.
 *
 * Absence is the normal path: the campaign makes its own branch. Only an
 * existing branch that cannot prove descent is refused, and it is refused
 * without being touched. A collision here means a branch carrying THIS
 * campaign's identity token has different history, which no ordinary reuse can
 * produce — so this refuses loudly rather than silently suffixing onto a
 * neighbouring name.
 *
 * `sealedBase` being null means the task is not under campaign custody at all
 * (no frozen base was resolved), which is the pre-campaign path and passes.
 */
export async function assertCccCampaignBranchNotForeign(input: {
  task: Pick<Task, "id"> & Partial<Pick<Task, "lineageId">>;
  repoDir: string;
  branchName: string;
  sealedBase: string | null;
  makeError: (message: string, detail: Record<string, unknown>) => Error;
}): Promise<void> {
  const { task, repoDir, branchName, sealedBase, makeError } = input;
  if (!sealedBase) return;

  const verdict = await inspectCccCampaignBranchCustody({ task, repoDir, branchName, sealedBase });
  if (verdict.ok) return;

  throw makeError(
    `CCC campaign task ${task.id} refuses branch ${branchName}: it already exists and does not descend from the sealed base`,
    { branchName, sealedBase, custodyReason: verdict.reason, custodyDetail: verdict.detail },
  );
}
