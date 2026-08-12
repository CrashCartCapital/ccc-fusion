import { execFile as execFileCallback, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  CCC_CAMPAIGN_JOIN_MERGE_CONFLICT_CODE,
  cccCampaignJoinBaseBranchName,
  ensureCccCampaignJoinBaseBranch,
} from "../ccc-campaign-join-base.js";

const execFile = promisify(execFileCallback);
const hasGit = spawnSync("git", ["--version"], { stdio: "pipe" }).status === 0;
const describeIfGit = hasGit ? describe : describe.skip;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFile("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  return result.stdout.trim();
}

async function isAncestor(cwd: string, base: string, head: string): Promise<boolean> {
  try {
    await execFile("git", ["-C", cwd, "merge-base", "--is-ancestor", base, head], {
      encoding: "utf8",
    });
    return true;
  } catch {
    return false;
  }
}

type Fixture = {
  rootDir: string;
  baseCommit: string;
  /** branch name -> tip sha at fixture build time */
  tips: Map<string, string>;
};

describeIfGit("CCC campaign join base branch", { timeout: 30_000 }, () => {
  const scratchRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(scratchRoots.splice(0).map((path) =>
      rm(path, { recursive: true, force: true })));
  });

  /**
   * A campaign target repo with a frozen base plus one branch per predecessor,
   * each carrying one commit that touches only its own file — the shape the
   * executor leaves behind after fan-out branch tasks complete.
   */
  async function fixture(
    branches: Record<string, Record<string, string>>,
  ): Promise<Fixture> {
    const scratch = await mkdtemp(join(tmpdir(), "fusion-ccc-join-base-"));
    scratchRoots.push(scratch);
    const rootDir = join(scratch, "target");
    await mkdir(rootDir, { recursive: true });
    await git(rootDir, "init", "-b", "main");
    await git(rootDir, "config", "user.email", "test@example.com");
    await git(rootDir, "config", "user.name", "Test User");
    await writeFile(join(rootDir, "README.md"), "base\n", "utf8");
    await git(rootDir, "add", "--", "README.md");
    await git(rootDir, "commit", "-m", "base");
    const baseCommit = await git(rootDir, "rev-parse", "HEAD");

    const tips = new Map<string, string>();
    for (const [branch, files] of Object.entries(branches)) {
      const worktree = join(scratch, `wt-${branch.replaceAll("/", "-")}`);
      await git(rootDir, "worktree", "add", "-b", branch, worktree, baseCommit);
      for (const [file, content] of Object.entries(files)) {
        await mkdir(join(worktree, file, ".."), { recursive: true });
        await writeFile(join(worktree, file), content, "utf8");
        await git(worktree, "add", "--", file);
      }
      await git(worktree, "commit", "-m", `work on ${branch}`);
      tips.set(branch, await git(worktree, "rev-parse", "HEAD"));
      await git(rootDir, "worktree", "remove", "--force", worktree);
    }
    return { rootDir, baseCommit, tips };
  }

  async function registeredWorktreeCount(rootDir: string): Promise<number> {
    const list = await git(rootDir, "worktree", "list", "--porcelain");
    return list.split("\n").filter((line) => line.startsWith("worktree ")).length;
  }

  it("merges two predecessor branches into a deterministic join base branch", async () => {
    const h = await fixture({
      "fusion/fn-b": { "src/task-b/result.txt": "b\n" },
      "fusion/fn-c": { "src/task-c/result.txt": "c\n" },
    });

    const branch = await ensureCccCampaignJoinBaseBranch({
      rootDir: h.rootDir,
      taskId: "FN-D",
      predecessors: [
        { taskId: "FN-B", branch: "fusion/fn-b" },
        { taskId: "FN-C", branch: "fusion/fn-c" },
      ],
    });

    expect(branch).toBe(cccCampaignJoinBaseBranchName("FN-D"));
    const joinTip = await git(h.rootDir, "rev-parse", `refs/heads/${branch}`);
    // Both predecessor tips are true ancestors of the join base — the ancestry
    // the campaign proof gate requires of the join task's history.
    expect(await isAncestor(h.rootDir, h.tips.get("fusion/fn-b")!, joinTip)).toBe(true);
    expect(await isAncestor(h.rootDir, h.tips.get("fusion/fn-c")!, joinTip)).toBe(true);
    // Predecessor branches were never mutated.
    expect(await git(h.rootDir, "rev-parse", "refs/heads/fusion/fn-b"))
      .toBe(h.tips.get("fusion/fn-b"));
    expect(await git(h.rootDir, "rev-parse", "refs/heads/fusion/fn-c"))
      .toBe(h.tips.get("fusion/fn-c"));
    // The merge worked in a scratch worktree that is gone afterwards.
    expect(await registeredWorktreeCount(h.rootDir)).toBe(1);
    // The primary checkout never moved.
    expect(await git(h.rootDir, "rev-parse", "HEAD")).toBe(h.baseCommit);
  });

  it("orders predecessors deterministically by task id, not call order", async () => {
    const h = await fixture({
      "fusion/fn-b": { "src/task-b/result.txt": "b\n" },
      "fusion/fn-c": { "src/task-c/result.txt": "c\n" },
    });

    const branch = await ensureCccCampaignJoinBaseBranch({
      rootDir: h.rootDir,
      taskId: "FN-D",
      // Deliberately reversed: FN-C first.
      predecessors: [
        { taskId: "FN-C", branch: "fusion/fn-c" },
        { taskId: "FN-B", branch: "fusion/fn-b" },
      ],
    });

    const joinTip = await git(h.rootDir, "rev-parse", `refs/heads/${branch}`);
    // First parent lineage starts from the lexicographically-first task id (FN-B).
    expect(await git(h.rootDir, "rev-parse", `${joinTip}^1`))
      .toBe(h.tips.get("fusion/fn-b"));
    expect(await git(h.rootDir, "rev-parse", `${joinTip}^2`))
      .toBe(h.tips.get("fusion/fn-c"));
  });

  it("reuses an existing join base that already contains every predecessor tip", async () => {
    const h = await fixture({
      "fusion/fn-b": { "src/task-b/result.txt": "b\n" },
      "fusion/fn-c": { "src/task-c/result.txt": "c\n" },
    });
    const input = {
      rootDir: h.rootDir,
      taskId: "FN-D",
      predecessors: [
        { taskId: "FN-B", branch: "fusion/fn-b" },
        { taskId: "FN-C", branch: "fusion/fn-c" },
      ],
    };

    const branch = await ensureCccCampaignJoinBaseBranch(input);
    const firstTip = await git(h.rootDir, "rev-parse", `refs/heads/${branch}`);
    const again = await ensureCccCampaignJoinBaseBranch(input);
    const secondTip = await git(h.rootDir, "rev-parse", `refs/heads/${branch}`);

    expect(again).toBe(branch);
    // Idempotent: no second merge commit for an already-complete join base.
    expect(secondTip).toBe(firstTip);
  });

  it("rebuilds a stale join base when a predecessor branch has advanced", async () => {
    const h = await fixture({
      "fusion/fn-b": { "src/task-b/result.txt": "b\n" },
      "fusion/fn-c": { "src/task-c/result.txt": "c\n" },
    });
    const input = {
      rootDir: h.rootDir,
      taskId: "FN-D",
      predecessors: [
        { taskId: "FN-B", branch: "fusion/fn-b" },
        { taskId: "FN-C", branch: "fusion/fn-c" },
      ],
    };
    const branch = await ensureCccCampaignJoinBaseBranch(input);

    // Predecessor B advances (e.g. a retried branch task committed again).
    const worktree = join(h.rootDir, "..", "wt-advance");
    await git(h.rootDir, "worktree", "add", "--detach", worktree, "refs/heads/fusion/fn-b");
    await writeFile(join(worktree, "src", "task-b", "more.txt"), "more\n", "utf8");
    await git(worktree, "add", "--", "src/task-b/more.txt");
    await git(worktree, "commit", "-m", "more work on b");
    const advancedTip = await git(worktree, "rev-parse", "HEAD");
    await git(h.rootDir, "branch", "-f", "fusion/fn-b", advancedTip);
    await git(h.rootDir, "worktree", "remove", "--force", worktree);

    const again = await ensureCccCampaignJoinBaseBranch(input);
    const rebuiltTip = await git(h.rootDir, "rev-parse", `refs/heads/${branch}`);

    expect(again).toBe(branch);
    expect(await isAncestor(h.rootDir, advancedTip, rebuiltTip)).toBe(true);
    expect(await isAncestor(h.rootDir, h.tips.get("fusion/fn-c")!, rebuiltTip)).toBe(true);
  });

  it("collapses a transitive shortcut predecessor without an empty merge commit", async () => {
    // C descends from B (an admitted A -> C shortcut alongside A -> B -> C):
    // the join base is just C's tip; no merge commit is required.
    const h = await fixture({
      "fusion/fn-b": { "src/task-b/result.txt": "b\n" },
    });
    const tipB = h.tips.get("fusion/fn-b")!;
    const worktree = join(h.rootDir, "..", "wt-c");
    await git(h.rootDir, "worktree", "add", "-b", "fusion/fn-c", worktree, tipB);
    await writeFile(join(worktree, "src", "task-b", "result.txt"), "bc\n", "utf8");
    await git(worktree, "add", "--", "src/task-b/result.txt");
    await git(worktree, "commit", "-m", "work on c");
    const tipC = await git(worktree, "rev-parse", "HEAD");
    await git(h.rootDir, "worktree", "remove", "--force", worktree);

    const branch = await ensureCccCampaignJoinBaseBranch({
      rootDir: h.rootDir,
      taskId: "FN-D",
      predecessors: [
        { taskId: "FN-B", branch: "fusion/fn-b" },
        { taskId: "FN-C", branch: "fusion/fn-c" },
      ],
    });

    expect(await git(h.rootDir, "rev-parse", `refs/heads/${branch}`)).toBe(tipC);
  });

  it("refuses a genuine merge conflict with the machine reason and mutates nothing", async () => {
    const h = await fixture({
      "fusion/fn-b": { "src/shared.txt": "b version\n" },
      "fusion/fn-c": { "src/shared.txt": "c version\n" },
    });

    await expect(ensureCccCampaignJoinBaseBranch({
      rootDir: h.rootDir,
      taskId: "FN-D",
      predecessors: [
        { taskId: "FN-B", branch: "fusion/fn-b" },
        { taskId: "FN-C", branch: "fusion/fn-c" },
      ],
    })).rejects.toMatchObject({
      name: "PermanentError",
      code: CCC_CAMPAIGN_JOIN_MERGE_CONFLICT_CODE,
      message: expect.stringContaining("FN-D"),
    });

    // The failed merge leaves no join base branch and no scratch worktree.
    await expect(git(h.rootDir, "rev-parse", "--verify", `refs/heads/${cccCampaignJoinBaseBranchName("FN-D")}`))
      .rejects.toThrow();
    expect(await registeredWorktreeCount(h.rootDir)).toBe(1);
    expect(await git(h.rootDir, "rev-parse", "refs/heads/fusion/fn-b"))
      .toBe(h.tips.get("fusion/fn-b"));
    expect(await git(h.rootDir, "rev-parse", "refs/heads/fusion/fn-c"))
      .toBe(h.tips.get("fusion/fn-c"));
  });

  it("refuses an unresolvable predecessor branch before touching any ref", async () => {
    const h = await fixture({
      "fusion/fn-b": { "src/task-b/result.txt": "b\n" },
    });

    await expect(ensureCccCampaignJoinBaseBranch({
      rootDir: h.rootDir,
      taskId: "FN-D",
      predecessors: [
        { taskId: "FN-B", branch: "fusion/fn-b" },
        { taskId: "FN-C", branch: "fusion/fn-missing" },
      ],
    })).rejects.toMatchObject({
      name: "PermanentError",
      code: "CCC_CAMPAIGN_CHAINED_WORKTREE_REFUSED",
      message: expect.stringContaining("fusion/fn-missing"),
    });
    await expect(git(h.rootDir, "rev-parse", "--verify", `refs/heads/${cccCampaignJoinBaseBranchName("FN-D")}`))
      .rejects.toThrow();
  });
});
