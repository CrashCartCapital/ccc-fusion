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
} from "../worktree-names.js";
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
