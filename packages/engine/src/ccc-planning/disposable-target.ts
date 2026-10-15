import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";

/*
FNXC:CccPlanningDisposableTarget 2026-10-15-00:43:
Card AU4 (D24, PRD section 7, ADR D Q3, CONTRACT-v3.5 section 2.18 G0 step 10). Before a qualification certificate exists (I6), G0 admits only an owned disposable target: `decideCccPlanningTargetAdmission` with the null port says that the receipt's class may be admitted, and this check proves the directory on disk really is that target. It trusts neither the receipt nor the registered project path: each claim is read back from the disk and from git. A refusal names the first check that failed and is never thrown; a dependency that throws, a git command that fails and a marker that cannot be read are all refusals, because a check that cannot be answered proves nothing.

The checks run in this order, and git runs only after every path and marker check has passed, so no git command ever executes inside a repository that has not yet been tied to the receipt's ownership marker by its digest (a repository's own config can name a program for git to run):
1. Receipt shape, class `owned_disposable` and no declared remote.
2. `scratchRoot`, `repositoryRealpath` and the registered project path are spelled as their own realpaths, and the repository is a direct child of the scratch root.
3. `owner.json` sits exactly at `<scratchRoot>/owner.json` (outside the repository), its bytes hash to the receipt's SHA-256, and it names this repository.
4. `git remote` prints nothing and `git config --get-regexp '^remote\.'` finds nothing.
5. `HEAD` and its tree equal the receipt, and the working tree is clean. `status` runs with `core.fsmonitor` forced off, because that setting names a program git would run.
6. `git rev-parse --show-toplevel` from the scratch root fails, so the scratch root is not itself inside another repository.

The receipt type is a structural subset: `CccPlanningLiveAuthorityReceiptV1` (core `ccc-planning/authority.ts`) is assignable to it, but core's planning barrel does not export that type at INT-3b (barrels are parent-owned, D34), so naming it here would not compile.
*/

/** The part of the live-authority receipt (K2, `CccPlanningLiveAuthorityReceiptV1`) that this check reads. */
export type CccPlanningDisposableTargetReceipt = Readonly<{
  target: Readonly<{
    class: string;
    scratchRoot: string;
    repositoryRealpath: string;
    baseCommit: string;
    baseTree: string;
    ownershipMarker: Readonly<{ path: string; sha256: string }>;
    remotes: readonly unknown[];
  }>;
}>;

export type CccPlanningOwnedDisposableTargetInput = Readonly<{
  receipt: CccPlanningDisposableTargetReceipt;
  registeredProjectPath: string;
  /** The existing supervised git runner, never execSync: `code` is the git exit code. */
  git: (args: readonly string[], cwd: string) => Promise<{ code: number; stdout: string }>;
  readFile: (path: string) => Promise<Uint8Array>;
  realpath: (path: string) => Promise<string>;
}>;

export type CccPlanningOwnedDisposableTargetResult =
  | { ok: true }
  | { ok: false; code: "CCC_PLANNING_TARGET_NOT_DISPOSABLE"; check: string };

/** Every name `check` can take, in the order the checks run. */
export const CCC_PLANNING_DISPOSABLE_TARGET_CHECKS = Object.freeze({
  receiptShape: "receipt-shape",
  targetClass: "target-class",
  receiptRemotes: "receipt-remotes",
  scratchRootRealpath: "scratch-root-realpath",
  repositoryRealpath: "repository-realpath",
  registeredProjectPath: "registered-project-path",
  directChild: "direct-child-of-scratch-root",
  ownerMarkerPath: "owner-marker-path",
  ownerMarkerMissing: "owner-marker-missing",
  ownerMarkerDigest: "owner-marker-digest",
  ownerMarkerInvalid: "owner-marker-invalid",
  ownerMarkerRepository: "owner-marker-repository",
  gitDirectory: "git-directory-owned",
  noRemote: "no-remote",
  noRemoteConfig: "no-remote-config",
  headCommit: "head-commit",
  headTree: "head-tree",
  cleanWorktree: "clean-worktree",
  notNested: "not-nested",
} as const);

export const CCC_PLANNING_DISPOSABLE_TARGET_OWNER_SCHEMA = "ccc-planning.disposable-target-owner.v1" as const;

const NOT_DISPOSABLE = "CCC_PLANNING_TARGET_NOT_DISPOSABLE" as const;
const CHECKS = CCC_PLANNING_DISPOSABLE_TARGET_CHECKS;
const SHA256_HEX = /^[a-f0-9]{64}$/u;
const NONCE_HEX = /^[a-f0-9]{32}$/u;
/** git exits 128 for "not a git repository"; any other failure is not proof that the scratch root is outside a repository. */
const GIT_NOT_A_REPOSITORY = 128;

function refused(check: string): { ok: false; code: typeof NOT_DISPOSABLE; check: string } {
  return { ok: false, code: NOT_DISPOSABLE, check };
}

/** Runs one dependency call; a throw or a rejection is an unanswered check, never an exception. */
async function answer<T>(work: () => Promise<T>): Promise<{ answered: true; value: T } | { answered: false }> {
  try {
    return { answered: true, value: await work() };
  } catch {
    return { answered: false };
  }
}

function isPlainString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0");
}

function receiptShapeIsValid(receipt: CccPlanningDisposableTargetReceipt): boolean {
  const target = (receipt as { target?: unknown } | null | undefined)?.target as Record<string, unknown> | undefined;
  if (typeof target !== "object" || target === null) return false;
  const marker = target.ownershipMarker as Record<string, unknown> | undefined;
  return isPlainString(target.class) && isPlainString(target.scratchRoot) && isPlainString(target.repositoryRealpath)
    && isPlainString(target.baseCommit) && isPlainString(target.baseTree)
    && typeof marker === "object" && marker !== null && isPlainString(marker.path)
    && typeof marker.sha256 === "string" && SHA256_HEX.test(marker.sha256)
    && Array.isArray(target.remotes);
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The marker names this repository, a v1 schema and a 32-hex nonce. Anything unparseable is `owner-marker-invalid`. */
function ownerMarkerVerdict(bytes: Uint8Array, repositoryRealpath: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return CHECKS.ownerMarkerInvalid;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return CHECKS.ownerMarkerInvalid;
  const marker = parsed as Record<string, unknown>;
  if (marker.schema !== CCC_PLANNING_DISPOSABLE_TARGET_OWNER_SCHEMA) return CHECKS.ownerMarkerInvalid;
  if (typeof marker.nonce !== "string" || !NONCE_HEX.test(marker.nonce)) return CHECKS.ownerMarkerInvalid;
  if (typeof marker.createdAt !== "string" || marker.createdAt.length === 0) return CHECKS.ownerMarkerInvalid;
  if (marker.repositoryRealpath !== repositoryRealpath) return CHECKS.ownerMarkerRepository;
  return null;
}

export async function assertCccPlanningOwnedDisposableTarget(
  input: CccPlanningOwnedDisposableTargetInput,
): Promise<CccPlanningOwnedDisposableTargetResult> {
  const { receipt, registeredProjectPath, git, readFile, realpath } = input;

  // 1. The receipt itself.
  if (!receiptShapeIsValid(receipt)) return refused(CHECKS.receiptShape);
  const { target } = receipt;
  if (target.class !== "owned_disposable") return refused(CHECKS.targetClass);
  if (target.remotes.length !== 0) return refused(CHECKS.receiptRemotes);
  if (!isPlainString(registeredProjectPath)) return refused(CHECKS.registeredProjectPath);

  // 2. Paths: every claimed path must be its own realpath, and the repository a direct child of the scratch root.
  const scratch = await answer(() => realpath(target.scratchRoot));
  if (!scratch.answered || scratch.value !== target.scratchRoot) return refused(CHECKS.scratchRootRealpath);
  const repository = await answer(() => realpath(target.repositoryRealpath));
  if (!repository.answered || repository.value !== target.repositoryRealpath) return refused(CHECKS.repositoryRealpath);
  const registered = await answer(() => realpath(registeredProjectPath));
  if (!registered.answered || registered.value !== target.repositoryRealpath) return refused(CHECKS.registeredProjectPath);
  if (basename(target.repositoryRealpath) === "" || dirname(target.repositoryRealpath) !== target.scratchRoot) {
    return refused(CHECKS.directChild);
  }

  // 3. The ownership marker, outside the repository, tied to the receipt by its digest.
  if (target.ownershipMarker.path !== join(target.scratchRoot, "owner.json")) return refused(CHECKS.ownerMarkerPath);
  const marker = await answer(() => readFile(target.ownershipMarker.path));
  if (!marker.answered || !(marker.value instanceof Uint8Array)) return refused(CHECKS.ownerMarkerMissing);
  if (sha256Hex(marker.value) !== target.ownershipMarker.sha256) return refused(CHECKS.ownerMarkerDigest);
  const markerVerdict = ownerMarkerVerdict(marker.value, target.repositoryRealpath);
  if (markerVerdict !== null) return refused(markerVerdict);

  /*
  FNXC:CccPlanningDisposableTarget 2026-10-15-05:25:
  AU4 repair 2: a matching marker and working tree do not own an external Git directory. Reject .git symlinks, gitfiles and shared common directories before git reads their configuration, index or objects. A canonical child HEAD also proves .git is a directory without changing the frozen filesystem dependency API.
  */
  const gitDirectory = join(target.repositoryRealpath, ".git");
  for (const requiredPath of [gitDirectory, join(gitDirectory, "HEAD")]) {
    const resolved = await answer(() => realpath(requiredPath));
    if (!resolved.answered || resolved.value !== requiredPath) return refused(CHECKS.gitDirectory);
  }
  try {
    await realpath(join(gitDirectory, "commondir"));
    return refused(CHECKS.gitDirectory);
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code !== "ENOENT") return refused(CHECKS.gitDirectory);
  }

  // 4. to 6. git. Only now: the repository is tied to a marker the receipt's digest covers.
  const runGit = async (args: readonly string[], cwd: string) => {
    const outcome = await answer(() => git(args, cwd));
    if (!outcome.answered || typeof outcome.value?.code !== "number" || typeof outcome.value.stdout !== "string") return null;
    return outcome.value;
  };
  const repo = target.repositoryRealpath;

  const remotes = await runGit(["remote"], repo);
  if (remotes === null || remotes.code !== 0 || remotes.stdout.trim() !== "") return refused(CHECKS.noRemote);
  // `git config --get-regexp` exits 1 with no output when nothing matches. Anything else is not proof that nothing does.
  const remoteConfig = await runGit(["config", "--get-regexp", "^remote\\."], repo);
  if (remoteConfig === null || remoteConfig.code !== 1 || remoteConfig.stdout.trim() !== "") return refused(CHECKS.noRemoteConfig);

  const head = await runGit(["rev-parse", "HEAD"], repo);
  if (head === null || head.code !== 0 || head.stdout.trim() !== target.baseCommit) return refused(CHECKS.headCommit);
  const tree = await runGit(["rev-parse", "HEAD^{tree}"], repo);
  if (tree === null || tree.code !== 0 || tree.stdout.trim() !== target.baseTree) return refused(CHECKS.headTree);

  const status = await runGit(["-c", "core.fsmonitor=false", "status", "--porcelain", "-uall"], repo);
  if (status === null || status.code !== 0 || status.stdout.trim() !== "") return refused(CHECKS.cleanWorktree);

  const toplevel = await runGit(["rev-parse", "--show-toplevel"], target.scratchRoot);
  if (toplevel === null || toplevel.code !== GIT_NOT_A_REPOSITORY) return refused(CHECKS.notNested);

  return { ok: true };
}
