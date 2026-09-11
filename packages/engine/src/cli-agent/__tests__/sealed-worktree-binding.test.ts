import { describe, expect, it } from "vitest";

import {
  CCC_SEALED_WORKTREE_BINDING_HEADING,
  appendSealedWorktreeBinding,
} from "../sealed-worktree-binding.js";

/*
 * A sealed CCC execution prompt is frozen at import time, so it can only name
 * the campaign's TARGET REPOSITORY. The per-task isolated worktree is allocated
 * at launch, minutes later, at a different path — and the sandbox grants write
 * to that worktree only.
 *
 * Observed 2026-09-11 (campaign attempt `ccc-provider-attempt-a5d66ba9…`): the
 * provider read "Target repository: …/round11-target-20260908" plus "work only
 * in the isolated task worktree", found itself in "…/.worktrees/hazy-reef", and
 * refused to edit anything — correctly, because from inside the session those
 * instructions contradict each other. The turn exited 0 with a `done` receipt
 * and produced no diff.
 *
 * This binding is the missing half: an UNSEALED runtime addendum that tells the
 * agent its cwd IS the authorized worktree. It must never alter the sealed bytes
 * that precede it (the packet hash covers those).
 */
describe("appendSealedWorktreeBinding", () => {
  const SEALED = "# CCC Fusion sealed execution task\n\n- Target repository: /repo/target";
  const WORKTREE = "/repo/.worktrees/hazy-reef";

  it("preserves the sealed prompt byte-for-byte as a prefix", () => {
    const bound = appendSealedWorktreeBinding(SEALED, WORKTREE);

    expect(bound.startsWith(SEALED)).toBe(true);
  });

  it("names the worktree as the authorized working directory", () => {
    const bound = appendSealedWorktreeBinding(SEALED, WORKTREE);

    expect(bound).toContain(CCC_SEALED_WORKTREE_BINDING_HEADING);
    expect(bound).toContain(WORKTREE);
  });

  it("tells the agent the target-repository path is not its working directory", () => {
    const bound = appendSealedWorktreeBinding(SEALED, WORKTREE);
    const addendum = bound.slice(SEALED.length);

    // The exact confusion that blocked the first real turn: the agent must not
    // read the sealed `Target repository` line as a directory to write into, nor
    // treat its inaccessibility as a blocker.
    expect(addendum).toMatch(/not the directory you work in/i);
    expect(addendum).toMatch(/do not .*(read|write)/i);
  });

  it("tells the agent to create owned paths that do not exist yet", () => {
    // The first real turn also reported the owned file "does not exist" as a
    // reason to stop. A new file is the normal case for an implementation task.
    const addendum = appendSealedWorktreeBinding(SEALED, WORKTREE).slice(SEALED.length);

    expect(addendum).toMatch(/create/i);
  });

  it("is idempotent — a re-dispatched prompt gains no second binding", () => {
    const once = appendSealedWorktreeBinding(SEALED, WORKTREE);
    const twice = appendSealedWorktreeBinding(once, WORKTREE);

    expect(twice).toBe(once);
  });

  it("returns the prompt unchanged when no worktree path is known", () => {
    // Never assert a binding we cannot back: a blank path would tell the agent
    // its cwd is authorized without naming it.
    expect(appendSealedWorktreeBinding(SEALED, "")).toBe(SEALED);
    expect(appendSealedWorktreeBinding(SEALED, "   ")).toBe(SEALED);
  });
});
