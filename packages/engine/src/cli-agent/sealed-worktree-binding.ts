/**
 * Runtime worktree binding for sealed CCC execution prompts.
 *
 * WHY THIS EXISTS
 *
 * A CCC execution prompt is projected from the frozen packet at import time
 * (`@fusion/core` → `ccc-prd/projection.ts`). Its bytes are covered by the
 * packet hash, so it can only name facts that are already sealed — including
 * the campaign's TARGET REPOSITORY path and the frozen base commit.
 *
 * The directory the provider actually runs in is not one of those facts. In
 * `worktreeMode: "isolated"` the engine allocates a fresh per-task git worktree
 * at launch, at an unrelated path, and the sandbox profile grants write access
 * to THAT directory (`"."`) and nowhere else.
 *
 * So the sealed prompt says "Target repository: /repo/target" and "work only in
 * the isolated task worktree", while the agent finds itself in
 * "/repo/.worktrees/hazy-reef" with the named target unreadable. Nothing in the
 * sealed bytes connects the two. Read literally — which is how a careful agent
 * reads a sealed task — those instructions contradict each other.
 *
 * That is not a hypothetical. The first Round 11 turn that ever executed
 * (2026-09-11, attempt `ccc-provider-attempt-a5d66ba9…`) spent its whole turn
 * establishing the mismatch and then declined to edit anything:
 *
 *   "The active workspace is `hazy-reef`, while the sealed packet names
 *    `round11-target-20260908`; they are different paths. … Blocked before
 *    edits: the sealed task authorizes only `round11-target-20260908`, but this
 *    session is sandboxed to `hazy-reef`."
 *
 * The turn exited 0 and produced a `done` held-closure receipt; the campaign
 * parked at `manual-required` with an empty diff. The provider was right and the
 * prompt was incomplete.
 *
 * THE CONTRACT
 *
 * This module supplies the missing half as an UNSEALED addendum appended at the
 * dispatch seam, where the allocated worktree path is finally known. Two rules
 * keep it safe:
 *
 * 1. It only ever APPENDS. The sealed prompt stays a byte-exact prefix, so the
 *    projected bytes the packet hash covers are never rewritten.
 * 2. It asserts nothing it cannot back. With no worktree path there is no
 *    binding to state, and the prompt is returned untouched rather than telling
 *    the agent its cwd is authorized without naming it.
 *
 * The ordinary (non-CCC) executor path has long had an equivalent runtime
 * addendum for multi-repo workspaces (`executor.ts`, "## Workspace mode"); the
 * sealed path simply never grew one.
 */

/** Heading that marks the runtime binding section. Also the idempotency key. */
export const CCC_SEALED_WORKTREE_BINDING_HEADING = "## Isolated task worktree (runtime binding)";

/**
 * Append the runtime worktree binding to a sealed CCC execution prompt.
 *
 * Idempotent: a prompt that already carries the binding is returned unchanged,
 * so a re-dispatch or resume never stacks duplicate sections.
 *
 * @param prompt The sealed execution prompt, exactly as projected.
 * @param worktreePath Absolute path of the isolated task worktree (the PTY cwd).
 * @returns The prompt with the binding appended, or the prompt unchanged when
 *   there is no worktree path to name or the binding is already present.
 */
export function appendSealedWorktreeBinding(prompt: string, worktreePath: string): string {
  const path = worktreePath.trim();
  if (path.length === 0) return prompt;
  if (prompt.includes(CCC_SEALED_WORKTREE_BINDING_HEADING)) return prompt;

  const binding = [
    "",
    "",
    CCC_SEALED_WORKTREE_BINDING_HEADING,
    "",
    "Your current working directory is:",
    "",
    `    ${path}`,
    "",
    "This directory IS the authorized isolated task worktree for this sealed task. It is a git worktree of the target repository named above, already checked out at the frozen base commit. Do all of your work here. Owned paths and allowed write roots resolve relative to this directory, and an owned path that does not exist yet is yours to create.",
    "",
    "The `Target repository` path recorded above identifies WHICH repository this worktree belongs to. It is not the directory you work in. It is deliberately outside your sandbox, so do not read from it, do not write to it, and do not treat its absence or inaccessibility as a blocker — it is not one. A path mismatch between that line and your working directory is expected and correct.",
  ].join("\n");

  return `${prompt}${binding}`;
}
