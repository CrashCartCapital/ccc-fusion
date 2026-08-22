import { lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { Settings } from "@fusion/core";
import type { WorktreeBackendKind } from "./worktree-backend.js";
import { canonicalizePath } from "./worktree-pool.js";

export const AI_MERGE_DIRNAME = ".ai-merge";

export function isAiMergeContainerDir(name: string): boolean {
  return name === AI_MERGE_DIRNAME;
}

export function resolveAiMergeRootPath(
  rootDir: string,
  settings: Pick<Settings, "worktreesDir"> | undefined,
): string {
  return join(resolveWorktreesDir(rootDir, settings), AI_MERGE_DIRNAME);
}

export function resolveLegacyAiMergeRootPath(rootDir: string): string {
  return join(rootDir, ".fusion", "ai-merge");
}

export function resolveWorktreesDir(
  rootDir: string,
  settings: Pick<Settings, "worktreesDir"> | undefined,
): string {
  const configured = settings?.worktreesDir;
  if (!configured) {
    return join(resolveDefaultWorktreesBaseDir(rootDir), ".worktrees");
  }

  const expandedHome = configured.replace(/^~(?=$|[\\/])/, homedir());
  const expandedRepo = expandedHome.replaceAll("{repo}", basename(rootDir));
  return resolve(rootDir, expandedRepo);
}

function resolveDefaultWorktreesBaseDir(rootDir: string): string {
  try {
    const dotGit = join(rootDir, ".git");
    const dotGitState = lstatSync(dotGit);
    if (dotGitState.isDirectory()) return rootDir;
    if (!dotGitState.isFile()) return rootDir;
    const gitDirLine = readFileSync(dotGit, "utf-8").trim();
    if (!gitDirLine.startsWith("gitdir: ")) return rootDir;
    const gitDir = resolve(rootDir, gitDirLine.slice("gitdir: ".length).trim());
    const commonDir = resolve(gitDir, readFileSync(join(gitDir, "commondir"), "utf-8").trim());
    return basename(commonDir) === ".git" ? dirname(commonDir) : rootDir;
  } catch {
    // Non-git roots keep the historical default.
    return rootDir;
  }
}

export function resolveTaskWorktreePath(
  rootDir: string,
  settings: Pick<Settings, "worktreesDir"> | undefined,
  worktreeName: string,
): string {
  return join(resolveWorktreesDir(rootDir, settings), worktreeName);
}

// Structural backend input avoids importing the full WorktreeBackend interface here.
export async function resolveTaskWorktreePathForBackend(
  rootDir: string,
  worktreeName: string,
  settings: Pick<Settings, "worktreesDir"> | undefined,
  backend: {
    kind: WorktreeBackendKind;
    resolveWorktreePath?: (input: { rootDir: string; worktreeName: string; branch: string }) => Promise<string>;
  },
  branch: string,
): Promise<string> {
  if (backend.kind === "worktrunk" && backend.resolveWorktreePath) {
    return backend.resolveWorktreePath({ rootDir, worktreeName, branch });
  }
  return resolveTaskWorktreePath(rootDir, settings, worktreeName);
}

export function isInsideConfiguredWorktreesDir(
  rootDir: string,
  settings: Pick<Settings, "worktreesDir"> | undefined,
  candidate: string,
): boolean {
  const worktreesDir = canonicalizePath(resolveWorktreesDir(rootDir, settings));
  const target = canonicalizePath(candidate);
  const rel = relative(worktreesDir, target);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}
