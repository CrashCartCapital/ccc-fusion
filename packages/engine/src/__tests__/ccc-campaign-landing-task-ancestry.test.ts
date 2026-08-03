/**
 * Landing's INDEPENDENT per-task ancestry gate.
 *
 * CCC campaign landing sources exactly one branch and builds a single-parent
 * commit (ccc-campaign-git-landing.ts:538, :587). Today it inherits "every
 * campaign task's work is included" entirely from the proof gate's ancestry
 * loop (ccc-campaign-proof-execution.ts:317-326). That is a single point of
 * failure: if the proof gate is bypassed, mis-scoped, or its receipt is filed
 * against a different source, landing would happily publish a commit missing an
 * earlier task's work.
 *
 * This pins the defense-in-depth check landing performs itself, against real
 * Git history rather than against a receipt.
 *
 * HARNESS NOTE: no PostgreSQL. The controlled Git runner only needs
 * `{ gitBinary, targetRoot }`, so the gate is exercised against a real
 * throwaway repository. Fixture commits are made with ordinary git; the gate
 * itself only ever runs read-only `merge-base --is-ancestor`.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertCccCampaignLandingIntegratesTaskCommits } from "../ccc-campaign-git-landing.js";

const GIT_BINARY = execFileSync("/usr/bin/env", ["sh", "-c", "command -v git"], {
  encoding: "utf8",
}).trim();

const repos: string[] = [];

function git(cwd: string, args: readonly string[]): string {
  return execFileSync(GIT_BINARY, args, { cwd, encoding: "utf8" }).trim();
}

function commit(cwd: string, name: string): string {
  writeFileSync(join(cwd, `${name}.txt`), `${name}\n`, "utf8");
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-m", name]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

/**
 * base ─ taskA ─ taskB   (landing source branch tip = taskB)
 *      └ strayC          (a task commit that never reached the landing branch)
 *
 * strayC is built with `commit-tree` plumbing rather than a branch checkout:
 * the working tree never has to move, so the fixture stays read-only apart from
 * the three commits it appends to `main`.
 */
let snapshot: { gitBinary: string; targetRoot: string };
let taskA = "";
let taskB = "";
let strayC = "";

beforeAll(() => {
  const root = mkdtempSync(join(tmpdir(), "ccc-landing-ancestry-"));
  repos.push(root);
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.email", "campaign@example.com"]);
  git(root, ["config", "user.name", "CCC Campaign"]);
  const base = commit(root, "base");
  taskA = commit(root, "task-a");
  taskB = commit(root, "task-b");
  strayC = git(root, [
    "commit-tree", `${base}^{tree}`, "-p", base, "-m", "task-c",
  ]);
  snapshot = { gitBinary: GIT_BINARY, targetRoot: root };
});

afterAll(() => {
  for (const root of repos) rmSync(root, { recursive: true, force: true });
});

describe("CCC campaign landing per-task ancestry gate", () => {
  it("accepts a landing commit that integrates every campaign task commit", async () => {
    await expect(assertCccCampaignLandingIntegratesTaskCommits(snapshot, taskB, [
      { taskId: "FN-1001", commit: taskA },
      { taskId: "FN-1002", commit: taskB },
    ])).resolves.toBeUndefined();
  });

  it("refuses a landing commit that omits one task's commit, naming the task and commit", async () => {
    await expect(assertCccCampaignLandingIntegratesTaskCommits(snapshot, taskB, [
      { taskId: "FN-1001", commit: taskA },
      { taskId: "FN-1003", commit: strayC },
    ])).rejects.toThrow(new RegExp(`FN-1003.*${strayC}|${strayC}.*FN-1003`));
  });

  /*
   * The single-task pin. A single-task campaign records no commit for any task
   * OTHER than the landing task, and the landing task's own receipts are pinned
   * to `prepared.sourceCommit` by assertExactCommittedProofReceipts. So the set
   * reaching this gate is empty and the gate must do nothing — refusing here
   * would break every single-task landing, which is exactly the regression this
   * test exists to prevent.
   */
  it("is a no-op for an empty set, leaving receipt existence to the receipt gate", async () => {
    await expect(assertCccCampaignLandingIntegratesTaskCommits(snapshot, taskB, []))
      .resolves.toBeUndefined();
  });

  it("accepts a recorded commit that is the landing source itself", async () => {
    await expect(assertCccCampaignLandingIntegratesTaskCommits(snapshot, taskB, [
      { taskId: "FN-1002", commit: taskB },
    ])).resolves.toBeUndefined();
  });

  it("refuses a recorded commit on a forked line even when the task id is unknown to git", async () => {
    await expect(assertCccCampaignLandingIntegratesTaskCommits(snapshot, taskA, [
      { taskId: "FN-1002", commit: taskB },
    ])).rejects.toThrow(/does not integrate campaign task FN-1002/);
  });

  it("refuses an unknown object id instead of treating the Git failure as success", async () => {
    await expect(assertCccCampaignLandingIntegratesTaskCommits(snapshot, taskB, [
      { taskId: "FN-1009", commit: "0".repeat(40) },
    ])).rejects.toThrow(/FN-1009/);
  });
});
