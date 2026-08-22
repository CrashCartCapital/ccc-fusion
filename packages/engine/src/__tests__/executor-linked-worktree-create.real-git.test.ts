import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskExecutor } from "../executor.js";
import { canonicalizePath, getRegisteredWorktreePaths, isInsideWorktreesDir } from "../worktree-pool.js";

const cleanupPaths: string[] = [];

function track(path: string): string {
  cleanupPaths.push(path);
  return path;
}

function git(cwd: string, command: string): string {
  return execSync(command, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function makeRepo(): string {
  const rootDir = track(mkdtempSync(join(tmpdir(), "fusion-linked-executor-main-")));
  git(rootDir, "git init -b main");
  git(rootDir, 'git config user.email "test@example.com"');
  git(rootDir, 'git config user.name "Test User"');
  writeFileSync(join(rootDir, "README.md"), "root\n", "utf-8");
  git(rootDir, "git add README.md");
  git(rootDir, 'git commit -m "init"');
  return rootDir;
}

afterEach(() => {
  for (const path of cleanupPaths.splice(0).reverse()) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("TaskExecutor linked worktree creation", () => {
  it("creates a task worktree under the primary checkout when rootDir is a linked worktree", async () => {
    const mainRoot = makeRepo();
    const linkedRoot = track(mkdtempSync(join(tmpdir(), "fusion-linked-executor-linked-")));
    rmSync(linkedRoot, { recursive: true, force: true });
    git(mainRoot, `git worktree add -b runner-root ${JSON.stringify(linkedRoot)} HEAD`);
    const primaryRoot = dirname(git(linkedRoot, "git rev-parse --path-format=absolute --git-common-dir"));
    const taskWorktree = join(primaryRoot, ".worktrees", "fn-linked-create");
    await mkdir(dirname(taskWorktree), { recursive: true });

    const store = {
      on: vi.fn(),
      logEntry: vi.fn(async () => undefined),
      getTask: vi.fn(async () => null),
      updateTask: vi.fn(async () => undefined),
    };
    const executor = new TaskExecutor(store as any, linkedRoot);

    await expect(
      (executor as any).tryCreateWorktree(
        "fusion/fn-linked-create",
        taskWorktree,
        "FN-LINKED-CREATE",
        "HEAD",
      ),
    ).resolves.toMatchObject({
      path: taskWorktree,
      branch: "fusion/fn-linked-create",
    });
    expect(git(linkedRoot, "git worktree list --porcelain")).toContain(taskWorktree);
    expect(store.logEntry).not.toHaveBeenCalledWith(
      "FN-LINKED-CREATE",
      "Refusing to create nested worktree",
      expect.any(String),
    );
  });

  it("still refuses arbitrary nested paths outside the configured worktree container", async () => {
    const mainRoot = makeRepo();
    const linkedRoot = track(mkdtempSync(join(tmpdir(), "fusion-linked-executor-linked-")));
    rmSync(linkedRoot, { recursive: true, force: true });
    git(mainRoot, `git worktree add -b runner-root ${JSON.stringify(linkedRoot)} HEAD`);
    const store = {
      on: vi.fn(),
      logEntry: vi.fn(async () => undefined),
      getTask: vi.fn(async () => null),
      updateTask: vi.fn(async () => undefined),
    };
    const executor = new TaskExecutor(store as any, linkedRoot);
    const arbitraryNestedPath = join(mainRoot, "src", "not-a-task-worktree");
    const registered = await getRegisteredWorktreePaths(linkedRoot);
    expect(registered).toContain(canonicalizePath(mainRoot));
    expect(registered).toContain(canonicalizePath(linkedRoot));
    expect(isInsideWorktreesDir(linkedRoot, arbitraryNestedPath, {})).toBe(false);

    await expect(
      (executor as any).assertWorktreePathNotNested(
        arbitraryNestedPath,
        "FN-LINKED-REFUSE",
        {},
      ),
    ).rejects.toThrow("path is nested inside existing worktree");
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-LINKED-REFUSE",
      "Refusing to create nested worktree",
      expect.stringContaining(arbitraryNestedPath),
    );
  });
});
