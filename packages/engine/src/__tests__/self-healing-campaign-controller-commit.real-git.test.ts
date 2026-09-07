import { afterEach, describe, expect, it, vi } from "vitest";
import { execSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { Settings, Task, TaskStore } from "@fusion/core";
import { SelfHealingManager } from "../self-healing.js";

/*
Companion to self-healing-stale-merge-stats.real-git.test.ts's real-git harness.

Covers the gap recorded in .archive/l28-landing-readiness/01-audit-findings.md
("Fix sizing"): `commitOwnedByTask` (self-healing.ts) recognizes a lineage
trailer, a `Fusion-Task-Id:` trailer, or a `type(id): ...` / `id: ...` subject
anchor — but NOT the literal CCC campaign controller commit produced by
`ccc-campaign-required-commit.ts` (`git commit -m "ccc-fusion campaign <id>"`
with author `ccc-fusion <ccc-fusion@localhost>`), which carries none of those
three shapes. `worktree-acquisition.ts`'s `isCccCampaignTaskOwnedCommit`
already recognizes this exact shape; the fix reuses that predicate rather than
duplicating the regex.
*/

const hasGit = spawnSync("git", ["--version"], { stdio: "pipe" }).status === 0;
const describeIfGit = hasGit ? describe : describe.skip;

function git(repo: string, command: string): string {
  return execSync(command, { cwd: repo, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function makeDoneTask(id: string, repo: string, baseCommitSha: string): Task {
  return {
    id,
    title: id,
    description: id,
    column: "done",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    baseBranch: "main",
    worktree: repo,
    baseCommitSha,
  } as Task;
}

function createStore(tasks: Map<string, Task>): TaskStore & EventEmitter {
  const emitter = new EventEmitter();
  const settings = { globalPause: false, enginePaused: false, maintenanceIntervalMs: 0, taskStuckTimeoutMs: 60_000, autoMerge: false } as Settings;
  return Object.assign(emitter, {
    getSettings: vi.fn(async () => settings),
    listTasks: vi.fn(async ({ column }: { column?: string } = {}) => [...tasks.values()].filter((t) => !column || t.column === column)),
    getTask: vi.fn(async (id: string) => tasks.get(id)),
    updateTask: vi.fn(async (id: string, updates: Partial<Task>) => {
      const cur = tasks.get(id)!;
      const next = { ...cur, ...updates, mergeDetails: updates.mergeDetails ?? cur.mergeDetails, updatedAt: new Date().toISOString() } as Task;
      tasks.set(id, next);
      return next;
    }),
    logEntry: vi.fn(async (id: string, message: string) => {
      const cur = tasks.get(id)!;
      tasks.set(id, { ...cur, log: [...(cur.log ?? []), { timestamp: new Date().toISOString(), action: message }] as any });
    }),
    moveTask: vi.fn(),
    walCheckpoint: vi.fn(() => ({ busy: 0, log: 0, checkpointed: 0 })),
    clearStaleExecutionStartBranchReferences: vi.fn(() => []),
    updateSettings: vi.fn(),
    mergeTask: vi.fn(),
    getRootDir: vi.fn(() => ""),
    recordRunAuditEvent: vi.fn(),
  }) as unknown as TaskStore & EventEmitter;
}

describeIfGit("SelfHealingManager findLandedTaskCommit — CCC campaign controller commit", () => {
  const repos: string[] = [];
  afterEach(() => {
    for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true });
  });

  function setupCampaignRepo(taskId: string) {
    const repo = mkdtempSync(path.join(os.tmpdir(), "campaign-controller-"));
    repos.push(repo);
    git(repo, "git init -b main");
    git(repo, 'git config user.email "test@example.com"');
    git(repo, 'git config user.name "Test"');
    writeFileSync(path.join(repo, "a.ts"), "const a = 1;\n", "utf-8");
    git(repo, "git add a.ts && git commit -m 'init'");
    const baseCommitSha = git(repo, "git rev-parse HEAD");

    writeFileSync(path.join(repo, "a.ts"), "const a = 2;\n", "utf-8");
    git(repo, "git add a.ts");
    // Mirrors ccc-campaign-required-commit.ts's exact commit shape: a bare
    // subject with no trailer, authored with the per-commit `-c` identity
    // override (NOT the repo-wide git config set above).
    git(
      repo,
      `git -c user.name=ccc-fusion -c user.email=ccc-fusion@localhost commit -m "ccc-fusion campaign ${taskId}"`,
    );
    const controllerSha = git(repo, "git rev-parse HEAD");

    return { repo, baseCommitSha, controllerSha };
  }

  it("recognizes a CCC campaign controller commit for KB-023 as task-owned (GREEN after fix)", async () => {
    const { repo, baseCommitSha, controllerSha } = setupCampaignRepo("KB-023");
    const task = makeDoneTask("KB-023", repo, baseCommitSha);
    const tasks = new Map([[task.id, task]]);
    const store = createStore(tasks);
    const manager = new SelfHealingManager(store, { rootDir: repo, getExecutingTaskIds: () => new Set() });

    const landed = await (manager as any).findLandedTaskCommit(task);

    // RED (pre-fix) signature: commitOwnedByTask recognizes only a lineage
    // trailer, a `Fusion-Task-Id:` trailer, or a `type(id): ...` / `id: ...`
    // subject anchor. The literal `ccc-fusion campaign KB-023` subject with
    // author `ccc-fusion <ccc-fusion@localhost>` matches none of those three,
    // so findLandedTaskCommit returned `null` even though the grep fallback
    // (subject contains the literal task id as a substring) located the
    // commit as a *candidate* — ownership was rejected at the anchor check.
    expect(landed).toEqual(expect.objectContaining({ sha: controllerSha }));
  });

  it("does not attribute an unrelated commit to a task it does not own (negative)", async () => {
    const { repo, baseCommitSha } = setupCampaignRepo("KB-023");
    // KB-999 has no commit in this repo at all — the campaign controller
    // commit above belongs to KB-023, not KB-999.
    const task = makeDoneTask("KB-999", repo, baseCommitSha);
    const tasks = new Map([[task.id, task]]);
    const store = createStore(tasks);
    const manager = new SelfHealingManager(store, { rootDir: repo, getExecutingTaskIds: () => new Set() });

    const landed = await (manager as any).findLandedTaskCommit(task);

    expect(landed).toBeNull();
  });

  it("does not adopt a campaign-shaped subject when the author identity does not match (exact-shape negative)", async () => {
    const repo = mkdtempSync(path.join(os.tmpdir(), "campaign-controller-mismatch-"));
    repos.push(repo);
    git(repo, "git init -b main");
    git(repo, 'git config user.email "test@example.com"');
    git(repo, 'git config user.name "Test"');
    writeFileSync(path.join(repo, "a.ts"), "const a = 1;\n", "utf-8");
    git(repo, "git add a.ts && git commit -m 'init'");
    const baseCommitSha = git(repo, "git rev-parse HEAD");

    writeFileSync(path.join(repo, "a.ts"), "const a = 2;\n", "utf-8");
    git(repo, "git add a.ts");
    // Same subject shape as the real controller commit, but a foreign
    // author identity — must NOT be recognized as task-owned. Proves the
    // fix does not broaden ownership beyond the exact controller-commit
    // shape (subject AND author name AND author email).
    git(
      repo,
      'git -c user.name="Someone Else" -c user.email="someone-else@example.com" commit -m "ccc-fusion campaign KB-030"',
    );

    const task = makeDoneTask("KB-030", repo, baseCommitSha);
    const tasks = new Map([[task.id, task]]);
    const store = createStore(tasks);
    const manager = new SelfHealingManager(store, { rootDir: repo, getExecutingTaskIds: () => new Set() });

    const landed = await (manager as any).findLandedTaskCommit(task);

    expect(landed).toBeNull();
  });
});
