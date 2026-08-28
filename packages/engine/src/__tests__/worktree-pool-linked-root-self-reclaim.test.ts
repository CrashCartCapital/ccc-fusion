import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskStore } from "@fusion/core";
import { cleanupOrphanedWorktrees, reapOrphanWorktrees, scanIdleWorktrees } from "../worktree-pool.js";

/*
 * A linked-worktree project root resolves its pool directory by walking to the
 * shared common dir (resolveDefaultWorktreesBaseDir), so the root lives INSIDE
 * the very directory every pool sweep enumerates. Without an explicit guard the
 * engine sees its own project root as just another reclaimable sibling and
 * deletes the checkout it is serving — observed live against the sealed R1
 * campaign target, which git-registered cleanly and was then removed by
 * self-healing's "Cleaned 1 orphaned worktree(s)" step.
 */
describe("worktree pool sweeps never reclaim the engine's own project root", () => {
  function git(cwd: string, command: string): string {
    return execSync(command, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  }

  function emptyTaskStore(): TaskStore {
    return { listTasks: async () => [] } as unknown as TaskStore;
  }

  /**
   * Builds a primary checkout plus a shared `.worktrees/` pool holding two
   * linked worktrees: the engine's own project root, and a genuinely idle one.
   */
  function createLinkedRootFixture(): {
    fixtureRoot: string;
    engineRoot: string;
    idleWorktree: string;
  } {
    // realpath the fixture root so every expectation compares the same form the
    // pool resolver produces; on macOS the tmpdir is reached through a symlink.
    const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "fusion-linked-root-reclaim-")));
    const primaryRoot = join(fixtureRoot, "primary");
    mkdirSync(primaryRoot, { recursive: true });
    git(primaryRoot, "git init -b main");
    git(primaryRoot, 'git config user.email "test@example.com"');
    git(primaryRoot, 'git config user.name "Test User"');
    writeFileSync(join(primaryRoot, "README.md"), "primary\n", "utf-8");
    git(primaryRoot, "git add README.md");
    git(primaryRoot, 'git commit -q -m "init"');

    const engineRoot = join(primaryRoot, ".worktrees", "engine-root");
    const idleWorktree = join(primaryRoot, ".worktrees", "idle-task");
    git(primaryRoot, `git worktree add -b engine-root ${JSON.stringify(engineRoot)} HEAD`);
    git(primaryRoot, `git worktree add -b idle-task ${JSON.stringify(idleWorktree)} HEAD`);

    return { fixtureRoot, engineRoot, idleWorktree };
  }

  it("excludes the engine's own linked project root from the idle-worktree scan", async () => {
    const { fixtureRoot, engineRoot, idleWorktree } = createLinkedRootFixture();
    try {
      const idle = (await scanIdleWorktrees(engineRoot, emptyTaskStore(), undefined))
        .map((path) => realpathSync(path));

      expect(idle).not.toContain(engineRoot);
      // The guard must stay narrow: a genuinely idle sibling is still reclaimable.
      expect(idle).toContain(idleWorktree);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("never deletes the engine's own project root when it is not in the registered set", async () => {
    /*
     * cleanupOrphanedWorktrees builds an `unregistered` candidate list by
     * re-enumerating the pool itself, independently of scanIdleWorktrees, and
     * removes those with a direct rmSync. `describeRegisteredWorktrees` fails
     * OPEN — a failing `git worktree list` (observed live as
     * "Failed to list registered worktrees: spawn /bin/sh ENOENT") returns an
     * empty set, so every pool entry including the engine's own root becomes a
     * deletion candidate. A configured worktreesDir reproduces that exposure
     * deterministically: the pool is the root's parent and the plain, wholly
     * unregistered root sits inside it.
     */
    const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "fusion-unregistered-root-")));
    const engineRoot = join(fixtureRoot, "pool", "engine-root");
    const staleSibling = join(fixtureRoot, "pool", "stale-sibling");
    mkdirSync(engineRoot, { recursive: true });
    mkdirSync(staleSibling, { recursive: true });
    writeFileSync(join(engineRoot, "serving.txt"), "engine root\n", "utf-8");
    writeFileSync(join(staleSibling, "junk.txt"), "stale\n", "utf-8");

    try {
      await cleanupOrphanedWorktrees(engineRoot, emptyTaskStore(), { worktreesDir: ".." });

      expect(existsSync(join(engineRoot, "serving.txt"))).toBe(true);
      // The unregistered sweep still works on everything that is not the root.
      expect(existsSync(join(staleSibling, "junk.txt"))).toBe(false);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("never reaps the engine's own project root as a half-initialized orphan", async () => {
    /*
     * reapOrphanWorktrees is a THIRD independent enumeration of the pool. It
     * normally spares a real worktree via its `.git` backstop, so the guard
     * only matters once that signal is gone too — which is exactly the state a
     * root is left in after an earlier sweep has already started deleting it,
     * or on a host where `git worktree list` cannot run at all. Reproduce that
     * worst case: pool = the root's parent, root is plain and unregistered.
     */
    const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "fusion-reap-orphan-root-")));
    const engineRoot = join(fixtureRoot, "pool", "engine-root");
    const staleSibling = join(fixtureRoot, "pool", "stale-sibling");
    mkdirSync(engineRoot, { recursive: true });
    mkdirSync(staleSibling, { recursive: true });
    writeFileSync(join(engineRoot, "serving.txt"), "engine root\n", "utf-8");
    writeFileSync(join(staleSibling, "junk.txt"), "stale\n", "utf-8");

    try {
      const removed = await reapOrphanWorktrees(engineRoot, { worktreesDir: ".." });

      expect(existsSync(join(engineRoot, "serving.txt"))).toBe(true);
      // The sweep still reaps everything that is not the root, so the guard
      // cannot be passing merely because reaping stopped altogether.
      expect(existsSync(join(staleSibling, "junk.txt"))).toBe(false);
      expect(removed).toBe(1);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("never deletes the engine's own linked project root during orphan cleanup", async () => {
    const { fixtureRoot, engineRoot, idleWorktree } = createLinkedRootFixture();
    try {
      await cleanupOrphanedWorktrees(engineRoot, emptyTaskStore(), undefined);

      expect(existsSync(join(engineRoot, "README.md"))).toBe(true);
      expect(existsSync(join(engineRoot, ".git"))).toBe(true);
      // The idle sibling is still reclaimed, so cleanup has not simply stopped.
      expect(existsSync(join(idleWorktree, "README.md"))).toBe(false);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});
