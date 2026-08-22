import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { Settings } from "@fusion/core";
import type { WorktreeBackendKind } from "./worktree-backend.js";
import { canonicalizePath } from "./worktree-pool.js";

export const AI_MERGE_DIRNAME = ".ai-merge";
const defaultWorktreesBaseDirCache = new Map<string, string>();

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
  const cacheKey = resolve(rootDir);
  const cached = defaultWorktreesBaseDirCache.get(cacheKey);
  if (cached) return cached;
  let baseDir = rootDir;
  try {
    const commonGitDir = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd: rootDir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    }).trim();
    if (basename(commonGitDir) === ".git") {
      baseDir = dirname(commonGitDir);
    }
  } catch {
    // Non-git roots keep the historical default.
  }
  defaultWorktreesBaseDirCache.set(cacheKey, baseDir);
  return baseDir;
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
