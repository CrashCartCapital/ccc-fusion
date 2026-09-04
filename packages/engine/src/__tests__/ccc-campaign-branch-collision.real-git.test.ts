import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireTaskWorktree } from "../worktree-acquisition.js";
import { inspectBareBranchCollision, inspectBranchConflict } from "../branch-conflicts.js";
import {
  campaignScopedFusionBranchName,
  canonicalFusionBranchName,
  cccCampaignBranchToken,
  resolveTaskWorkingBranch,
  resolveTrustedTaskBranchName,
} from "../worktree-names.js";
import { SelfHealingManager } from "../self-healing.js";
import { inspectCccCampaignBranchCustody } from "../ccc-campaign-branch-custody.js";
import { buildIdentityGuardHook } from "../worktree-hooks.js";

/*
FNXC:CccCampaignBranchCollision 2026-09-03-00:00:
A fresh campaign database re-allocates native task ids from the start, so
`fusion/<task-id>` collides with any branch a PREVIOUS campaign left in the
target repository. The live L12 round-2 run allocated KB-005, found the owner's
August `fusion/kb-005` branch with a registered worktree, RELOCATED that worktree
out of the owner's repository, and only then refused on frozen-base custody.

These tests are real-git: they need a genuine branch/worktree registration for
the collision to exist at all.
*/

vi.mock("../worktree-db-hydrate.js", () => ({
  hydrateWorktreeDb: vi.fn().mockResolvedValue({ degraded: false, tasksCopied: 0, documentsCopied: 0, artifactsCopied: 0 }),
}));

vi.mock("../worktree-desktop-artifacts.js", () => ({
  removeDesktopBuildArtifacts: vi.fn().mockResolvedValue({ removed: [], skipped: [], failures: [] }),
}));

vi.mock("../secrets-env-writer.js", () => ({
  writeSecretsEnvFile: vi.fn().mockResolvedValue(undefined),
}));

const CAMPAIGN_IDENTITY_HASH = "f03f47757404104c6aa38579";
const OTHER_CAMPAIGN_IDENTITY_HASH = "0123456789abcdef01234567";
const CAMPAIGN_LINEAGE = `ccc-prd:${CAMPAIGN_IDENTITY_HASH}:TASK-EVIDENCE-LABELS`;

const cleanupPaths: string[] = [];
function track(path: string): string {
  cleanupPaths.push(path);
  return path;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function commit(cwd: string, file: string, body: string, message: string): string {
  writeFileSync(join(cwd, file), body, "utf-8");
  git(cwd, ["add", file]);
  git(cwd, ["commit", "-m", message]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

/**
 * A developer repository that already ran an EARLIER campaign: `fusion/kb-005`
 * exists, is checked out in `.worktrees/sleek-robin`, and its tip does NOT
 * descend from the new campaign's sealed base.
 */
function makeOwnerRepoWithPriorCampaignBranch(): {
  rootDir: string;
  sealedBase: string;
  foreignWorktreePath: string;
  foreignHead: string;
  campaignWorktreesDir: string;
} {
  const fixtureRoot = track(mkdtempSync(join(tmpdir(), "ccc-branch-collision-")));
  const rootDir = join(fixtureRoot, "ccc-quant-engine");
  mkdirSync(rootDir, { recursive: true });
  git(rootDir, ["init", "-b", "main"]);
  git(rootDir, ["config", "user.email", "owner@example.com"]);
  git(rootDir, ["config", "user.name", "Repo Owner"]);
  const priorTip = commit(rootDir, "README.md", "owner repo\n", "chore: init");

  // The owner's August campaign branch, forked BEFORE the new sealed base.
  const foreignWorktreePath = join(rootDir, ".worktrees", "sleek-robin");
  mkdirSync(join(rootDir, ".worktrees"), { recursive: true });
  git(rootDir, ["worktree", "add", "-b", "fusion/kb-005", foreignWorktreePath, priorTip]);
  const foreignHead = commit(foreignWorktreePath, "august.txt", "august campaign work\n", "feat(KB-005): august campaign work");

  // The new campaign seals a base on main, AFTER the fork point.
  const sealedBase = commit(rootDir, "sealed.txt", "sealed\n", "chore: sealed campaign base");
  expect(() => git(rootDir, ["merge-base", "--is-ancestor", sealedBase, "fusion/kb-005"])).toThrow();

  // Campaigns place their worktrees in a run-scoped pool OUTSIDE `.worktrees/`,
  // which is what made the buggy path relocate the owner's checkout.
  const campaignWorktreesDir = join(fixtureRoot, "campaign-worktrees");
  mkdirSync(campaignWorktreesDir, { recursive: true });

  return { rootDir, sealedBase, foreignWorktreePath, foreignHead, campaignWorktreesDir };
}

function campaignTask(overrides: Record<string, unknown> = {}): any {
  return {
    id: "KB-005",
    title: "Label the evidence rows",
    description: "Label the evidence rows",
    lineageId: CAMPAIGN_LINEAGE,
    dependencies: [],
    branch: null,
    worktree: null,
    ...overrides,
  };
}

afterEach(() => {
  for (const path of cleanupPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("campaign branch names are campaign-unique", () => {
  it("RED-L13-a scopes an imported campaign task's branch with its campaign identity token", () => {
    const branch = resolveTaskWorkingBranch(campaignTask());
    expect(branch).toBe("fusion/kb-005-f03f47757404");
    expect(branch).not.toBe(canonicalFusionBranchName("KB-005"));
  });

  it("RED-L13-c re-derives the same branch on restart and recovery", () => {
    // First dispatch: no branch persisted yet.
    const first = resolveTaskWorkingBranch(campaignTask());
    // Restart with the branch persisted by the first acquisition.
    const second = resolveTaskWorkingBranch(campaignTask({ branch: first }));
    // Recovery cleared the pointer; the lineage row still re-derives the name.
    const third = resolveTaskWorkingBranch(campaignTask({ branch: null, worktree: null }));
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it("RED-L13-c gives two campaigns that reuse task id KB-005 different branches", () => {
    const a = resolveTaskWorkingBranch(campaignTask());
    const b = resolveTaskWorkingBranch(campaignTask({
      lineageId: `ccc-prd:${OTHER_CAMPAIGN_IDENTITY_HASH}:TASK-EVIDENCE-LABELS`,
    }));
    expect(a).not.toBe(b);
  });

  it("leaves ordinary non-campaign tasks on the canonical branch", () => {
    expect(resolveTaskWorkingBranch({ id: "FN-1234", branch: null } as any)).toBe("fusion/fn-1234");
    expect(cccCampaignBranchToken("api")).toBeNull();
    expect(cccCampaignBranchToken(null)).toBeNull();
    expect(campaignScopedFusionBranchName({ id: "FN-1234" } as any)).toBe("fusion/fn-1234");
  });
});

describe("acquisition against a repository that already owns fusion/kb-005", () => {
  let store: any;

  beforeEach(() => {
    store = {
      updateTask: vi.fn().mockResolvedValue(undefined),
      logEntry: vi.fn().mockResolvedValue(undefined),
    };
  });

  it("RED-L13-a creates a fresh worktree on a non-colliding branch and never touches the owner's worktree", async () => {
    const { rootDir, sealedBase, foreignWorktreePath, foreignHead, campaignWorktreesDir } =
      makeOwnerRepoWithPriorCampaignBranch();
    const registrationsBefore = git(rootDir, ["worktree", "list", "--porcelain"]);
    store.getCccCampaignContextForTask = vi.fn(async () => ({
      targetRepository: { path: rootDir, baseCommit: sealedBase },
      campaignStartedAt: "2000-01-01T00:00:00.000Z",
    }));

    const result = await acquireTaskWorktree({
      task: campaignTask({ baseCommitSha: sealedBase }),
      rootDir,
      store,
      settings: { worktreesDir: campaignWorktreesDir },
    });

    // The campaign works on its own branch.
    expect(result.branch).toBe("fusion/kb-005-f03f47757404");
    expect(result.source).toBe("fresh");
    expect(git(result.worktreePath, ["rev-parse", "HEAD"])).toBe(sealedBase);
    expect(git(result.worktreePath, ["branch", "--show-current"])).toBe("fusion/kb-005-f03f47757404");

    // The owner's worktree is untouched: same path, same HEAD, same registration.
    expect(existsSync(foreignWorktreePath)).toBe(true);
    expect(git(foreignWorktreePath, ["rev-parse", "HEAD"])).toBe(foreignHead);
    expect(git(foreignWorktreePath, ["branch", "--show-current"])).toBe("fusion/kb-005");
    expect(readFileSync(join(foreignWorktreePath, "august.txt"), "utf8")).toBe("august campaign work\n");
    expect(git(rootDir, ["worktree", "list", "--porcelain"])).toContain(registrationsBefore.split("\n")[0]);
    expect(git(rootDir, ["rev-parse", "fusion/kb-005"])).toBe(foreignHead);
  });

  it("RED-L13-a lets an agent commit on the campaign-scoped branch", async () => {
    const { rootDir, sealedBase, campaignWorktreesDir } = makeOwnerRepoWithPriorCampaignBranch();
    store.getCccCampaignContextForTask = vi.fn(async () => ({
      targetRepository: { path: rootDir, baseCommit: sealedBase },
      campaignStartedAt: "2000-01-01T00:00:00.000Z",
    }));

    const result = await acquireTaskWorktree({
      task: campaignTask({ baseCommitSha: sealedBase }),
      rootDir,
      store,
      settings: { worktreesDir: campaignWorktreesDir },
    });

    // Prove the guard is actually installed and live in this worktree before
    // reading anything into the commit succeeding: a foreign branch is refused.
    git(result.worktreePath, ["checkout", "-b", "someone-elses-branch"]);
    expect(() => commit(result.worktreePath, "intruder.txt", "x\n", "chore: intruder")).toThrow(
      /refusing commit/,
    );
    git(result.worktreePath, ["checkout", "--force", "fusion/kb-005-f03f47757404"]);

    // The shared pre-commit identity guard must accept the campaign-scoped
    // branch, or the campaign can acquire a worktree and never commit in it.
    expect(() => commit(result.worktreePath, "labels.py", "rows\n", "feat(KB-005): label rows")).not.toThrow();
  });

  it("RED-L13-a refuses, without touching it, a campaign-scoped branch that has foreign history", async () => {
    const { rootDir, sealedBase, campaignWorktreesDir } = makeOwnerRepoWithPriorCampaignBranch();
    // Someone else already holds the campaign-token branch, forked before the base.
    const squatterFork = git(rootDir, ["rev-parse", `${sealedBase}~1`]);
    git(rootDir, ["branch", "fusion/kb-005-f03f47757404", squatterFork]);
    const squatterTip = git(rootDir, ["rev-parse", "fusion/kb-005-f03f47757404"]);
    store.getCccCampaignContextForTask = vi.fn(async () => ({
      targetRepository: { path: rootDir, baseCommit: sealedBase },
      campaignStartedAt: "2000-01-01T00:00:00.000Z",
    }));

    await expect(acquireTaskWorktree({
      task: campaignTask({ baseCommitSha: sealedBase }),
      rootDir,
      store,
      settings: { worktreesDir: campaignWorktreesDir },
    })).rejects.toMatchObject({
      code: "CCC_CAMPAIGN_FOREIGN_BRANCH_REFUSED",
      message: expect.stringMatching(/does not descend from the sealed base/),
    });

    // Refused, not rewritten: the squatter's ref is exactly where it was.
    expect(git(rootDir, ["rev-parse", "fusion/kb-005-f03f47757404"])).toBe(squatterTip);
  });

  /*
   * The real residue, from
   * .archive/l12-live-campaign/target-residue-inventory.txt: FIFTEEN `fusion/kb-*`
   * branches in the owner's repository, every one of them checked out in a
   * registered worktree. Fourteen sit at d1314bb, which does not descend from the
   * sealed base dabe4181. The single exception is `fusion/kb-002`, left at the
   * sealed base by the campaign's own previous run — which is why round 1
   * dispatched at all: it collided with its own lineage by luck. Both shapes
   * therefore coexist in ONE repository, and they must be told apart there.
   */
  it("RED-L13-a/b tells a foreign collision from its own lineage inside one repository", async () => {
    const { rootDir, sealedBase, foreignWorktreePath, foreignHead, campaignWorktreesDir } =
      makeOwnerRepoWithPriorCampaignBranch();

    // The campaign's own previous run, preserved at the sealed base.
    const ownPreservedPath = join(campaignWorktreesDir, "maple-trout");
    git(rootDir, ["worktree", "add", "-b", "fusion/kb-002-f03f47757404", ownPreservedPath, sealedBase]);
    const ownPreservedHead = git(ownPreservedPath, ["rev-parse", "HEAD"]);

    store.getCccCampaignContextForTask = vi.fn(async () => ({
      targetRepository: { path: rootDir, baseCommit: sealedBase },
      campaignStartedAt: "2000-01-01T00:00:00.000Z",
    }));

    // The foreign collision: a fresh worktree on the campaign's own branch.
    const result = await acquireTaskWorktree({
      task: campaignTask({ baseCommitSha: sealedBase }),
      rootDir,
      store,
      settings: { worktreesDir: campaignWorktreesDir },
    });
    expect(result.branch).toBe("fusion/kb-005-f03f47757404");

    // Neither neighbour moved: not the owner's, and not the campaign's own.
    expect(existsSync(foreignWorktreePath)).toBe(true);
    expect(git(foreignWorktreePath, ["rev-parse", "HEAD"])).toBe(foreignHead);
    expect(existsSync(ownPreservedPath)).toBe(true);
    expect(git(ownPreservedPath, ["rev-parse", "HEAD"])).toBe(ownPreservedHead);

    // The campaign's own lineage is still adoptable in that same repository.
    const own = await inspectBranchConflict({
      repoDir: rootDir,
      branchName: "fusion/kb-002-f03f47757404",
      conflictingWorktreePath: ownPreservedPath,
      requestingTaskId: "KB-002",
      ownerTaskId: "KB-002",
      startPoint: sealedBase,
      integrationRef: "main",
      requiredAncestorSha: sealedBase,
    });
    expect(own.kind).not.toBe("live-foreign");

    // The stranger's is not.
    const stranger = await inspectBranchConflict({
      repoDir: rootDir,
      branchName: "fusion/kb-005",
      conflictingWorktreePath: foreignWorktreePath,
      requestingTaskId: "KB-005",
      ownerTaskId: "KB-005",
      startPoint: sealedBase,
      integrationRef: "main",
      requiredAncestorSha: sealedBase,
    });
    expect(stranger.kind).toBe("live-foreign");
  });

  it("RED-L13-a keeps the identity guard hook refusing a genuinely foreign branch", () => {
    const hook = buildIdentityGuardHook("KB-005");
    expect(hook).toContain("fusion/kb-005");
    // The campaign token is 12 lowercase hex characters; nothing else is allowed.
    expect(hook).not.toContain("fusion/kb-005-*");
  });
});

describe("adoption is gated on provable lineage, not branch-name coincidence", () => {
  it("RED-L13-a refuses to reclaim a branch whose tip does not descend from the sealed base", async () => {
    const { rootDir, sealedBase, foreignWorktreePath } = makeOwnerRepoWithPriorCampaignBranch();

    const inspection = await inspectBranchConflict({
      repoDir: rootDir,
      branchName: "fusion/kb-005",
      conflictingWorktreePath: foreignWorktreePath,
      requestingTaskId: "KB-005",
      ownerTaskId: "KB-005",
      startPoint: sealedBase,
      integrationRef: "main",
      requiredAncestorSha: sealedBase,
    });

    expect(inspection.kind).toBe("live-foreign");
    expect(existsSync(foreignWorktreePath)).toBe(true);
  });

  it("RED-L13-b still adopts a preserved worktree from this campaign's own lineage", async () => {
    const { rootDir, sealedBase, campaignWorktreesDir } = makeOwnerRepoWithPriorCampaignBranch();
    const campaignBranch = "fusion/kb-005-f03f47757404";
    const preservedPath = join(campaignWorktreesDir, "merry-fern");
    git(rootDir, ["worktree", "add", "-b", campaignBranch, preservedPath, sealedBase]);
    const preservedTip = commit(preservedPath, "labels.py", "rows\n", "feat(KB-005): label rows");

    const inspection = await inspectBranchConflict({
      repoDir: rootDir,
      branchName: campaignBranch,
      conflictingWorktreePath: preservedPath,
      requestingTaskId: "KB-005",
      ownerTaskId: "KB-005",
      startPoint: sealedBase,
      integrationRef: "main",
      requiredAncestorSha: sealedBase,
    });

    expect(inspection.kind).toBe("reclaimable");
    expect(inspection).toMatchObject({ livePath: realpathSync(preservedPath), tipSha: preservedTip });
  });

  it("RED-L13-b adopts a preserved worktree that is exactly at the sealed base", async () => {
    const { rootDir, sealedBase, campaignWorktreesDir } = makeOwnerRepoWithPriorCampaignBranch();
    const campaignBranch = "fusion/kb-005-f03f47757404";
    const preservedPath = join(campaignWorktreesDir, "merry-fern");
    git(rootDir, ["worktree", "add", "-b", campaignBranch, preservedPath, sealedBase]);

    const inspection = await inspectBranchConflict({
      repoDir: rootDir,
      branchName: campaignBranch,
      conflictingWorktreePath: preservedPath,
      requestingTaskId: "KB-005",
      ownerTaskId: "KB-005",
      startPoint: sealedBase,
      integrationRef: "main",
      requiredAncestorSha: sealedBase,
    });

    // The sealed base IS main's tip in this fixture, so a branch sitting exactly
    // on it classifies as already-merged. What matters is that it stays an
    // ADOPTION verdict and is not pushed onto the foreign path by the new gate.
    expect(inspection.kind).toBe("tip-already-merged");
  });

  it("RED-L13-a refuses the same lineage in the bare branch-collision classifier", async () => {
    const { rootDir, sealedBase, foreignWorktreePath } = makeOwnerRepoWithPriorCampaignBranch();
    // Unregister the worktree so this is a bare branch collision, not a live one.
    git(rootDir, ["worktree", "remove", "--force", foreignWorktreePath]);

    const gated = await inspectBareBranchCollision({
      repoDir: rootDir,
      branchName: "fusion/kb-005",
      conflictingWorktreePath: foreignWorktreePath,
      requestingTaskId: "KB-005",
      ownerTaskId: "KB-005",
      startPoint: sealedBase,
      integrationRef: "main",
      requiredAncestorSha: sealedBase,
    });
    expect(gated.kind).toBe("foreign-unmerged");

    /*
     * The same call WITHOUT a sealed base also refuses here, but for an
     * unrelated pre-existing reason: reportBranchAttribution's subject/trailer
     * patterns only recognise `FN-<digits>` task ids, so a `KB-` campaign commit
     * counts as unattributed and never reaches the reclaimable verdict. That is
     * a safe default, and it is why the branch-name-coincidence defect showed up
     * in inspectBranchConflict (whose self-owned check is path-based) rather than
     * here. Pinned so a future widening of the attribution patterns cannot
     * silently turn this into an adoption.
     */
    const ungated = await inspectBareBranchCollision({
      repoDir: rootDir,
      branchName: "fusion/kb-005",
      conflictingWorktreePath: foreignWorktreePath,
      requestingTaskId: "KB-005",
      ownerTaskId: "KB-005",
      startPoint: sealedBase,
      integrationRef: "main",
    });
    expect(ungated.kind).toBe("foreign-unmerged");
  });

  it("leaves non-campaign conflict classification unchanged when no sealed base is supplied", async () => {
    const { rootDir, sealedBase, foreignWorktreePath } = makeOwnerRepoWithPriorCampaignBranch();

    const inspection = await inspectBranchConflict({
      repoDir: rootDir,
      branchName: "fusion/kb-005",
      conflictingWorktreePath: foreignWorktreePath,
      requestingTaskId: "KB-005",
      ownerTaskId: "KB-005",
      startPoint: sealedBase,
      integrationRef: "main",
    });

    expect(inspection.kind).toBe("reclaimable");
  });
});

/*
FNXC:CccCampaignBranchCustody 2026-09-03-01:00:
Making four consumers PREFER `task.branch` only moved the trust boundary; it did
not establish one. `reconcileInReviewBranchRebind` writes `task.branch` on a
name+SHA match, and its candidate set still contains the BARE canonical name —
which for a campaign task is precisely the stranger's branch. Its trigger is a
falsy `task.branch`, i.e. the fresh-import case. Once poisoned, the persisted
pointer flows into `git branch -D` at merge cleanup and into PR head/push.

So custody has to hold at the write, not only at acquisition, and the consumers
have to re-check what they read. These are the RED tests for that.
*/
describe("branch custody holds at the rebind write, not only at acquisition", () => {
  function rebindStore(task: Record<string, unknown>) {
    const updateTask = vi.fn().mockResolvedValue(undefined);
    return {
      updateTask,
      getSettings: vi.fn().mockResolvedValue({ globalPause: false, enginePaused: false }),
      listTasks: vi.fn().mockResolvedValue([task]),
      recordRunAuditEvent: vi.fn().mockResolvedValue(undefined),
      logEntry: vi.fn().mockResolvedValue(undefined),
    } as any;
  }

  it("RED-L13-1 refuses to rebind a fresh-import campaign task onto a stranger's branch", async () => {
    const { rootDir, sealedBase, foreignHead } = makeOwnerRepoWithPriorCampaignBranch();

    // Exactly the fresh-import shape the rebinder triggers on: in-review, no
    // branch pointer yet. The only live `fusion/*` branch carrying unique work
    // is the owner's `fusion/kb-005`, which does not descend from the sealed base.
    const task = campaignTask({
      column: "in-review",
      branch: null,
      baseBranch: "main",
      baseCommitSha: sealedBase,
    });
    const store = rebindStore(task);
    const manager = new SelfHealingManager(store, { rootDir } as any);

    const result = await manager.reconcileInReviewBranchRebind();

    // The stranger's branch must never become this task's branch.
    expect(store.updateTask).not.toHaveBeenCalled();
    expect(result.repaired).toBe(0);
    expect(result.outcomes[0]).toMatchObject({
      taskId: "KB-005",
      result: "skipped",
      reason: expect.stringContaining("custody"),
    });
    // And the branch itself is untouched.
    expect(git(rootDir, ["rev-parse", "fusion/kb-005"])).toBe(foreignHead);
  });

  it("RED-L13-1 still rebinds a campaign task onto its own campaign-scoped branch", async () => {
    const { rootDir, sealedBase } = makeOwnerRepoWithPriorCampaignBranch();

    // The campaign's own branch, descending from the sealed base, with work on it.
    git(rootDir, ["branch", "fusion/kb-005-f03f47757404", sealedBase]);
    const ownWorktree = join(rootDir, ".worktrees", "own-lineage");
    git(rootDir, ["worktree", "add", ownWorktree, "fusion/kb-005-f03f47757404"]);
    const ownTip = commit(ownWorktree, "labels.py", "rows\n", "feat(KB-005): label rows");

    const task = campaignTask({
      column: "in-review",
      branch: null,
      baseBranch: "main",
      baseCommitSha: sealedBase,
    });
    const store = rebindStore(task);
    const manager = new SelfHealingManager(store, { rootDir } as any);

    const result = await manager.reconcileInReviewBranchRebind();

    expect(result.repaired).toBe(1);
    expect(store.updateTask).toHaveBeenCalledWith(
      "KB-005",
      expect.objectContaining({ branch: "fusion/kb-005-f03f47757404" }),
    );
    expect(git(rootDir, ["rev-parse", "fusion/kb-005-f03f47757404"])).toBe(ownTip);
  });

  it("RED-L13-1 fails closed when a campaign task has no sealed base to prove custody against", async () => {
    const { rootDir, sealedBase } = makeOwnerRepoWithPriorCampaignBranch();
    git(rootDir, ["branch", "fusion/kb-005-f03f47757404", sealedBase]);
    const ownWorktree = join(rootDir, ".worktrees", "own-lineage");
    git(rootDir, ["worktree", "add", ownWorktree, "fusion/kb-005-f03f47757404"]);
    commit(ownWorktree, "labels.py", "rows\n", "feat(KB-005): label rows");

    // Same repository, same correctly-named branch — but nothing to prove
    // descent against. Custody is unknown, so the rebind must not happen.
    const task = campaignTask({
      column: "in-review",
      branch: null,
      baseBranch: "main",
      baseCommitSha: null,
    });
    const store = rebindStore(task);
    const manager = new SelfHealingManager(store, { rootDir } as any);

    const result = await manager.reconcileInReviewBranchRebind();

    expect(store.updateTask).not.toHaveBeenCalled();
    expect(result.outcomes[0]).toMatchObject({ result: "skipped", reason: expect.stringContaining("custody") });
  });

  it("leaves ordinary non-campaign rebind behaviour unchanged", async () => {
    const { rootDir, sealedBase } = makeOwnerRepoWithPriorCampaignBranch();
    git(rootDir, ["branch", "fusion/fn-4242", sealedBase]);
    const wt = join(rootDir, ".worktrees", "fn-4242");
    git(rootDir, ["worktree", "add", wt, "fusion/fn-4242"]);
    commit(wt, "work.txt", "work\n", "feat(FN-4242): work");

    const task = {
      id: "FN-4242",
      column: "in-review",
      branch: null,
      baseBranch: "main",
      dependencies: [],
      worktree: null,
    };
    const store = rebindStore(task);
    const manager = new SelfHealingManager(store, { rootDir } as any);

    const result = await manager.reconcileInReviewBranchRebind();

    expect(result.repaired).toBe(1);
    expect(store.updateTask).toHaveBeenCalledWith("FN-4242", expect.objectContaining({ branch: "fusion/fn-4242" }));
  });
});

describe("consumers re-check the persisted branch before trusting it", () => {
  it("RED-L13-1 ignores a poisoned branch pointer on a campaign task", () => {
    // A rebind (or any other writer) put a stranger's branch on the row.
    const poisoned = campaignTask({ branch: "fusion/kb-005" });
    expect(resolveTrustedTaskBranchName(poisoned)).toBe("fusion/kb-005-f03f47757404");
    expect(resolveTrustedTaskBranchName(poisoned)).not.toBe("fusion/kb-005");
  });

  it("RED-L13-1 honours a campaign task's own persisted branch", () => {
    const healthy = campaignTask({ branch: "fusion/kb-005-f03f47757404" });
    expect(resolveTrustedTaskBranchName(healthy)).toBe("fusion/kb-005-f03f47757404");
  });

  it("RED-L13-1 falls back to the campaign-scoped name when nothing is persisted", () => {
    expect(resolveTrustedTaskBranchName(campaignTask({ branch: null }))).toBe("fusion/kb-005-f03f47757404");
  });

  it("keeps operator-chosen and canonical branches for non-campaign tasks", () => {
    expect(resolveTrustedTaskBranchName({ id: "FN-1234", branch: "release/hotfix" } as any)).toBe("release/hotfix");
    expect(resolveTrustedTaskBranchName({ id: "FN-1234", branch: null } as any)).toBe("fusion/fn-1234");
  });
});

describe("the classifier fails closed on a campaign branch with no proof of custody", () => {
  /*
   * `requiredAncestorSha` is threaded through exactly one caller chain. The
   * older `handleWorktreeConflict` in executor.ts calls `inspectBranchConflict`
   * with no ancestor at all, and executor.ts is off-limits. So the safety
   * property cannot live in the caller: a campaign-scoped branch name with no
   * sealed base supplied must be non-adoptable in the CLASSIFIER.
   */
  it("RED-L13-2 refuses to reclaim a campaign-scoped branch when no sealed base is supplied", async () => {
    const { rootDir, sealedBase } = makeOwnerRepoWithPriorCampaignBranch();
    const squatterFork = git(rootDir, ["rev-parse", `${sealedBase}~1`]);
    git(rootDir, ["branch", "fusion/kb-005-f03f47757404", squatterFork]);
    const squatterWorktree = join(rootDir, ".worktrees", "squatter");
    git(rootDir, ["worktree", "add", squatterWorktree, "fusion/kb-005-f03f47757404"]);
    commit(squatterWorktree, "squat.txt", "squat\n", "feat(KB-005): squatter work");

    const inspection = await inspectBranchConflict({
      repoDir: rootDir,
      branchName: "fusion/kb-005-f03f47757404",
      conflictingWorktreePath: squatterWorktree,
      requestingTaskId: "KB-005",
      ownerTaskId: "KB-005",
      startPoint: sealedBase,
      integrationRef: "main",
      // deliberately no requiredAncestorSha — the executor.ts call shape
    });

    expect(inspection.kind).not.toBe("reclaimable");
    expect(inspection.kind).not.toBe("fully-subsumed");
    expect(inspection.kind).toBe("live-foreign");
  });

  it("RED-L13-2 refuses the same in the bare branch-collision classifier", async () => {
    const { rootDir, sealedBase } = makeOwnerRepoWithPriorCampaignBranch();
    const squatterFork = git(rootDir, ["rev-parse", `${sealedBase}~1`]);
    git(rootDir, ["branch", "fusion/kb-005-f03f47757404", squatterFork]);

    const inspection = await inspectBareBranchCollision({
      repoDir: rootDir,
      branchName: "fusion/kb-005-f03f47757404",
      conflictingWorktreePath: null as unknown as string,
      requestingTaskId: "KB-005",
      ownerTaskId: "KB-005",
      startPoint: sealedBase,
      integrationRef: "main",
    });

    expect(inspection.kind).not.toBe("reclaimable");
    expect(inspection.kind).not.toBe("fully-subsumed");
  });

  it("still adopts a campaign-scoped branch when the sealed base IS supplied and proves descent", async () => {
    const { rootDir, sealedBase } = makeOwnerRepoWithPriorCampaignBranch();
    git(rootDir, ["branch", "fusion/kb-005-f03f47757404", sealedBase]);
    const ownWorktree = join(rootDir, ".worktrees", "own-lineage");
    git(rootDir, ["worktree", "add", ownWorktree, "fusion/kb-005-f03f47757404"]);

    const inspection = await inspectBranchConflict({
      repoDir: rootDir,
      branchName: "fusion/kb-005-f03f47757404",
      conflictingWorktreePath: ownWorktree,
      requestingTaskId: "KB-005",
      ownerTaskId: "KB-005",
      startPoint: sealedBase,
      integrationRef: "main",
      requiredAncestorSha: sealedBase,
    });

    expect(inspection.kind).not.toBe("live-foreign");
  });

  it("leaves ordinary fusion branch names classifying exactly as before", async () => {
    const { rootDir, sealedBase, foreignWorktreePath } = makeOwnerRepoWithPriorCampaignBranch();

    const inspection = await inspectBranchConflict({
      repoDir: rootDir,
      branchName: "fusion/kb-005",
      conflictingWorktreePath: foreignWorktreePath,
      requestingTaskId: "KB-005",
      ownerTaskId: "KB-005",
      startPoint: sealedBase,
      integrationRef: "main",
    });

    expect(inspection.kind).toBe("reclaimable");
  });
});

describe("the refusal gate against a REGISTERED foreign worktree", () => {
  let store: any;

  beforeEach(() => {
    store = {
      updateTask: vi.fn().mockResolvedValue(undefined),
      logEntry: vi.fn().mockResolvedValue(undefined),
    };
  });

  /*
   * The L12 failure needed a REGISTERED worktree, not a bare ref: that is what
   * made the pool adopt and then relocate the owner's checkout. This is that
   * exact shape aimed at the campaign-token branch, so the acquisition gate is
   * the thing under test rather than the pool's own conflict handling.
   */
  it("RED-L13-3 refuses a registered foreign worktree and leaves it byte-identical", async () => {
    const { rootDir, sealedBase, campaignWorktreesDir } = makeOwnerRepoWithPriorCampaignBranch();

    // A stranger holds the campaign-token branch AND has it checked out.
    const squatterFork = git(rootDir, ["rev-parse", `${sealedBase}~1`]);
    git(rootDir, ["branch", "fusion/kb-005-f03f47757404", squatterFork]);
    const squatterWorktree = join(rootDir, ".worktrees", "squatter");
    git(rootDir, ["worktree", "add", squatterWorktree, "fusion/kb-005-f03f47757404"]);
    const squatterHead = commit(squatterWorktree, "squat.txt", "squat\n", "feat(KB-005): squatter work");
    expect(() => git(rootDir, ["merge-base", "--is-ancestor", sealedBase, "fusion/kb-005-f03f47757404"])).toThrow();

    const registrationsBefore = git(rootDir, ["worktree", "list", "--porcelain"]);
    const squatFileBefore = readFileSync(join(squatterWorktree, "squat.txt"), "utf8");
    store.getCccCampaignContextForTask = vi.fn(async () => ({
      targetRepository: { path: rootDir, baseCommit: sealedBase },
      campaignStartedAt: "2000-01-01T00:00:00.000Z",
    }));

    await expect(acquireTaskWorktree({
      task: campaignTask({ baseCommitSha: sealedBase }),
      rootDir,
      store,
      settings: { worktreesDir: campaignWorktreesDir },
    })).rejects.toMatchObject({ code: "CCC_CAMPAIGN_FOREIGN_BRANCH_REFUSED" });

    // Path, HEAD, branch, contents and registration are all exactly as they were.
    expect(existsSync(squatterWorktree)).toBe(true);
    expect(git(squatterWorktree, ["rev-parse", "HEAD"])).toBe(squatterHead);
    expect(git(squatterWorktree, ["branch", "--show-current"])).toBe("fusion/kb-005-f03f47757404");
    expect(readFileSync(join(squatterWorktree, "squat.txt"), "utf8")).toBe(squatFileBefore);
    expect(git(rootDir, ["worktree", "list", "--porcelain"])).toBe(registrationsBefore);
    expect(git(rootDir, ["rev-parse", "fusion/kb-005-f03f47757404"])).toBe(squatterHead);

    // Nothing was relocated. The L12 log line must not exist.
    const logged = store.logEntry.mock.calls.map((call: unknown[]) => String(call[1] ?? "")).join("\n");
    expect(logged).not.toMatch(/relocated preserved worktree/i);
    expect(logged).not.toMatch(/relocat/i);
  });
});

/*
FNXC:CccCampaignBranchCustody 2026-09-03-02:00:
Acquisition-level custody was reachable only by ENTRY tasks.

`assertCccCampaignEntryFrozenBaseCustody` returns null for any campaign task
with dependencies, and `assertCccCampaignBranchNotForeign` then returned early
on that null sealed base. So every non-entry campaign task — the majority of a
real campaign — got no acquisition-level check at all, not even the cheap
name-level token test, while the in-review rebinder refused the very same
situation as `custody-unknown`. The docstring claimed a token test that never
ran.

That gap is reachable: with recycling on, `prepareForTask` force-resets an
existing branch with `git checkout -B <branch> <base>`, so an unattached
leftover branch carrying the same campaign token is destroyed rather than
refused.
*/
describe("non-entry campaign tasks get the same acquisition custody as entry tasks", () => {
  let store: any;

  beforeEach(() => {
    store = {
      updateTask: vi.fn().mockResolvedValue(undefined),
      logEntry: vi.fn().mockResolvedValue(undefined),
    };
  });

  /** A campaign task with dependencies: NOT the entry task, so no sealed base is re-derived. */
  function dependentCampaignTask(overrides: Record<string, unknown> = {}): any {
    return campaignTask({ dependencies: ["KB-001"], ...overrides });
  }

  it("RED-L14 refuses an unattached tokened branch at a non-descendant commit", async () => {
    const { rootDir, sealedBase, campaignWorktreesDir } = makeOwnerRepoWithPriorCampaignBranch();

    // A leftover branch carrying THIS campaign's token, forked before the base,
    // with no worktree attached — exactly what `git checkout -B` would reset.
    const leftoverFork = git(rootDir, ["rev-parse", `${sealedBase}~1`]);
    git(rootDir, ["branch", "fusion/kb-005-f03f47757404", leftoverFork]);
    const leftoverTip = git(rootDir, ["rev-parse", "fusion/kb-005-f03f47757404"]);
    expect(() => git(rootDir, ["merge-base", "--is-ancestor", sealedBase, "fusion/kb-005-f03f47757404"])).toThrow();

    store.getCccCampaignContextForTask = vi.fn(async () => ({
      targetRepository: { path: rootDir, baseCommit: sealedBase },
      campaignStartedAt: "2000-01-01T00:00:00.000Z",
    }));

    await expect(acquireTaskWorktree({
      task: dependentCampaignTask({ baseCommitSha: sealedBase }),
      rootDir,
      store,
      settings: { worktreesDir: campaignWorktreesDir, recycleWorktrees: true },
    })).rejects.toMatchObject({ code: "CCC_CAMPAIGN_FOREIGN_BRANCH_REFUSED" });

    // Refused, not force-reset: the leftover tip is exactly where it was.
    expect(git(rootDir, ["rev-parse", "fusion/kb-005-f03f47757404"])).toBe(leftoverTip);
    expect(leftoverTip).toBe(leftoverFork);
  });

  it("RED-L14 runs the token test for a non-entry task even with no sealed base", async () => {
    const { rootDir, sealedBase, foreignHead, campaignWorktreesDir } = makeOwnerRepoWithPriorCampaignBranch();

    // A poisoned pointer: the bare canonical name, which is the STRANGER's branch.
    // The token test alone is enough to refuse this, with or without a sealed base.
    store.getCccCampaignContextForTask = vi.fn(async () => ({
      targetRepository: { path: rootDir, baseCommit: sealedBase },
      campaignStartedAt: "2000-01-01T00:00:00.000Z",
    }));

    await expect(acquireTaskWorktree({
      task: dependentCampaignTask({ branch: "fusion/kb-005", baseCommitSha: sealedBase }),
      rootDir,
      store,
      settings: { worktreesDir: campaignWorktreesDir, recycleWorktrees: true },
    })).rejects.toMatchObject({ code: "CCC_CAMPAIGN_FOREIGN_BRANCH_REFUSED" });

    // The stranger's branch is untouched.
    expect(git(rootDir, ["rev-parse", "fusion/kb-005"])).toBe(foreignHead);
  });

  it("RED-L14 still dispatches a non-entry campaign task when nothing collides", async () => {
    const { rootDir, sealedBase, campaignWorktreesDir } = makeOwnerRepoWithPriorCampaignBranch();
    store.getCccCampaignContextForTask = vi.fn(async () => ({
      targetRepository: { path: rootDir, baseCommit: sealedBase },
      campaignStartedAt: "2000-01-01T00:00:00.000Z",
    }));

    // Absent branch is the normal path and must NOT be refused just because a
    // non-entry task has no sealed base to compare against.
    const result = await acquireTaskWorktree({
      task: dependentCampaignTask({ baseCommitSha: sealedBase }),
      rootDir,
      store,
      settings: { worktreesDir: campaignWorktreesDir },
    });

    expect(result.branch).toBe("fusion/kb-005-f03f47757404");
    expect(git(result.worktreePath, ["branch", "--show-current"])).toBe("fusion/kb-005-f03f47757404");
  });

  it("RED-L14 matches the rebinder: an existing branch with no sealed base is custody-unknown", async () => {
    const { rootDir, sealedBase } = makeOwnerRepoWithPriorCampaignBranch();
    git(rootDir, ["branch", "fusion/kb-005-f03f47757404", sealedBase]);

    // Same shape the in-review rebinder already refuses. The two writers must
    // agree, which was the whole point of the shared choke point.
    const verdict = await inspectCccCampaignBranchCustody({
      task: dependentCampaignTask(),
      repoDir: rootDir,
      branchName: "fusion/kb-005-f03f47757404",
      sealedBase: null,
    });

    expect(verdict.ok).toBe(false);
    expect(verdict).toMatchObject({ reason: "custody-unknown" });
  });

  it("RED-L14 leaves an absent branch adoptable with no sealed base, so dispatch is not blocked", async () => {
    const { rootDir } = makeOwnerRepoWithPriorCampaignBranch();

    const verdict = await inspectCccCampaignBranchCustody({
      task: dependentCampaignTask(),
      repoDir: rootDir,
      branchName: "fusion/kb-005-f03f47757404",
      sealedBase: null,
    });

    expect(verdict).toMatchObject({ ok: true, reason: "branch-absent" });
  });

  it("leaves ordinary non-campaign tasks unaffected by the always-on token test", async () => {
    const { rootDir } = makeOwnerRepoWithPriorCampaignBranch();

    const verdict = await inspectCccCampaignBranchCustody({
      task: { id: "FN-1234" } as any,
      repoDir: rootDir,
      branchName: "fusion/fn-1234",
      sealedBase: null,
    });

    expect(verdict).toMatchObject({ ok: true, reason: "not-a-campaign-task" });
  });
});

/*
FNXC:CccCampaignBranchCustody 2026-09-03-03:00:
Custody for a non-entry campaign task was proven against the TASK ROW's
`baseCommitSha`, while the entry path and the executor both prove against the
SEAL (`store.getCccCampaignContextForTask`). The row is mutable state; the seal
is compiler-owned. A row carrying an arbitrary commit A therefore let
acquisition adopt — or, with recycling on, `git checkout -B` over — a branch
that descends from A but not from the sealed base, and the refusal only landed
later in the executor, after the branch had already been taken.

The row is not an independent source of truth: the executor already requires
`task.baseCommitSha === frozenBase` for every imported campaign task. These
tests pin that same invariant at acquisition, which is the first writer that can
touch a branch.
*/
describe("non-entry custody is proven against the seal, not the task row", () => {
  let store: any;

  beforeEach(() => {
    store = {
      updateTask: vi.fn().mockResolvedValue(undefined),
      logEntry: vi.fn().mockResolvedValue(undefined),
    };
  });

  function dependentCampaignTask(overrides: Record<string, unknown> = {}): any {
    return campaignTask({ dependencies: ["KB-001"], ...overrides });
  }

  /**
   * A repository where a branch carrying this campaign's token descends from
   * `poisonBase` — a real commit that the seal does not name.
   */
  function repoWithBranchOffAForeignBase() {
    const fixture = makeOwnerRepoWithPriorCampaignBranch();
    const { rootDir, sealedBase } = fixture;
    // The commit the sealed base was built on. Real, reachable, and NOT the seal.
    const poisonBase = git(rootDir, ["rev-parse", `${sealedBase}~1`]);
    const sideWorktree = join(rootDir, ".worktrees", "off-base");
    git(rootDir, ["worktree", "add", "-b", "fusion/kb-005-f03f47757404", sideWorktree, poisonBase]);
    const branchTip = commit(sideWorktree, "offbase.txt", "off base\n", "feat(KB-005): work off a foreign base");
    // Descends from the poisoned row value, but not from the seal.
    expect(() => git(rootDir, ["merge-base", "--is-ancestor", poisonBase, "fusion/kb-005-f03f47757404"])).not.toThrow();
    expect(() => git(rootDir, ["merge-base", "--is-ancestor", sealedBase, "fusion/kb-005-f03f47757404"])).toThrow();
    return { ...fixture, poisonBase, branchTip, sideWorktree };
  }

  it("RED-L15 refuses a poisoned row whose base the seal does not name", async () => {
    const { rootDir, sealedBase, poisonBase, branchTip, campaignWorktreesDir } = repoWithBranchOffAForeignBase();

    // The seal names the real base. The row has been poisoned to an arbitrary commit.
    store.getCccCampaignContextForTask = vi.fn(async () => ({
      targetRepository: { path: rootDir, baseCommit: sealedBase },
      campaignStartedAt: "2000-01-01T00:00:00.000Z",
    }));

    await expect(acquireTaskWorktree({
      task: dependentCampaignTask({ baseCommitSha: poisonBase }),
      rootDir,
      store,
      settings: { worktreesDir: campaignWorktreesDir, recycleWorktrees: true },
    })).rejects.toMatchObject({ code: "CCC_CAMPAIGN_FROZEN_BASE_REFUSED" });

    // Refused before anything touched it.
    expect(git(rootDir, ["rev-parse", "fusion/kb-005-f03f47757404"])).toBe(branchTip);
    expect(readFileSync(join(rootDir, ".worktrees", "off-base", "offbase.txt"), "utf8")).toBe("off base\n");
  });

  it("RED-L15 still refuses when the row is absent and only the seal can decide", async () => {
    const { rootDir, sealedBase, branchTip, campaignWorktreesDir } = repoWithBranchOffAForeignBase();
    store.getCccCampaignContextForTask = vi.fn(async () => ({
      targetRepository: { path: rootDir, baseCommit: sealedBase },
      campaignStartedAt: "2000-01-01T00:00:00.000Z",
    }));

    // No row value at all: the seal is the only base, and the branch does not
    // descend from it.
    await expect(acquireTaskWorktree({
      task: dependentCampaignTask({ baseCommitSha: null }),
      rootDir,
      store,
      settings: { worktreesDir: campaignWorktreesDir, recycleWorktrees: true },
    })).rejects.toMatchObject({ code: "CCC_CAMPAIGN_FOREIGN_BRANCH_REFUSED" });

    expect(git(rootDir, ["rev-parse", "fusion/kb-005-f03f47757404"])).toBe(branchTip);
  });

  it("RED-L15 clears custody for a non-entry task whose row agrees with the seal", async () => {
    const { rootDir, sealedBase } = makeOwnerRepoWithPriorCampaignBranch();
    // The campaign's own branch, descending from the seal.
    git(rootDir, ["branch", "fusion/kb-005-f03f47757404", sealedBase]);

    const verdict = await inspectCccCampaignBranchCustody({
      task: dependentCampaignTask({ baseCommitSha: sealedBase }),
      repoDir: rootDir,
      branchName: "fusion/kb-005-f03f47757404",
      sealedBase,
    });

    expect(verdict).toMatchObject({ ok: true, reason: "descends-from-sealed-base" });
  });

  /*
   * KNOWN GAP, pinned deliberately rather than hidden.
   *
   * Custody now clears the case above, but a FRESH create still cannot adopt
   * that branch: `WorktreeBackend` runs its own `inspectBranchConflict` /
   * `inspectBareBranchCollision` without an ancestor, so the fail-closed
   * classifier refuses any campaign-scoped name. Threading the sealed base into
   * that call means widening `WorktreeCreateInput` AND the positional
   * `createWorktree(branch, path, taskId, startPoint, allowRename)` signature
   * the executor owns and supplies — i.e. it requires editing executor.ts,
   * which is out of scope here.
   *
   * The pool path is already correct: acquisition passes the seal-derived base
   * as `requiredAncestorSha`. Only the fresh-create path is affected, and only
   * when the branch already exists.
   *
   * Replace this test with a success assertion when the backend learns the
   * ancestor. It exists so the gap cannot drift silently.
   */
  it("documents that fresh create still refuses an existing campaign branch (needs executor.ts)", async () => {
    const { rootDir, sealedBase, campaignWorktreesDir } = makeOwnerRepoWithPriorCampaignBranch();
    git(rootDir, ["branch", "fusion/kb-005-f03f47757404", sealedBase]);
    const tipBefore = git(rootDir, ["rev-parse", "fusion/kb-005-f03f47757404"]);
    store.getCccCampaignContextForTask = vi.fn(async () => ({
      targetRepository: { path: rootDir, baseCommit: sealedBase },
      campaignStartedAt: "2000-01-01T00:00:00.000Z",
    }));

    await expect(acquireTaskWorktree({
      task: dependentCampaignTask({ baseCommitSha: sealedBase }),
      rootDir,
      store,
      settings: { worktreesDir: campaignWorktreesDir },
    })).rejects.toThrow(/no sealed base was supplied to prove custody/);

    // Refusing is the safe direction, and it costs the branch nothing.
    expect(git(rootDir, ["rev-parse", "fusion/kb-005-f03f47757404"])).toBe(tipBefore);
  });

  it("RED-L15 reads the seal for a non-entry task rather than trusting the row", async () => {
    const { rootDir, sealedBase, campaignWorktreesDir } = makeOwnerRepoWithPriorCampaignBranch();
    const getContext = vi.fn(async () => ({
      targetRepository: { path: rootDir, baseCommit: sealedBase },
      campaignStartedAt: "2000-01-01T00:00:00.000Z",
    }));
    store.getCccCampaignContextForTask = getContext;

    await acquireTaskWorktree({
      task: dependentCampaignTask({ baseCommitSha: sealedBase }),
      rootDir,
      store,
      settings: { worktreesDir: campaignWorktreesDir },
    });

    // The entry path returns null for a dependent task, so the ONLY way custody
    // can be seal-derived is an explicit read here.
    expect(getContext).toHaveBeenCalledWith("KB-005");
  });

  it("RED-L15 fails closed on an existing branch when the seal cannot be read", async () => {
    const { rootDir, branchTip, campaignWorktreesDir } = repoWithBranchOffAForeignBase();
    store.getCccCampaignContextForTask = vi.fn(async () => {
      throw new Error("sealed campaign storage unavailable");
    });

    await expect(acquireTaskWorktree({
      task: dependentCampaignTask({ baseCommitSha: null }),
      rootDir,
      store,
      settings: { worktreesDir: campaignWorktreesDir, recycleWorktrees: true },
    })).rejects.toMatchObject({ code: "CCC_CAMPAIGN_FOREIGN_BRANCH_REFUSED" });

    expect(git(rootDir, ["rev-parse", "fusion/kb-005-f03f47757404"])).toBe(branchTip);
  });

  it("leaves ordinary non-campaign tasks off the seal path entirely", async () => {
    const { rootDir, campaignWorktreesDir } = makeOwnerRepoWithPriorCampaignBranch();
    const getContext = vi.fn(async () => null);
    store.getCccCampaignContextForTask = getContext;

    const result = await acquireTaskWorktree({
      task: { id: "FN-4242", dependencies: ["FN-1"], branch: null, worktree: null } as any,
      rootDir,
      store,
      settings: { worktreesDir: campaignWorktreesDir },
    });

    expect(result.branch).toBe("fusion/fn-4242");
  });
});
