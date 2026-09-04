import { createHash } from "node:crypto";
import { constants as fsConstants, type BigIntStats } from "node:fs";
import {
  access,
  lstat,
  open,
  readlink,
  realpath,
  stat,
} from "node:fs/promises";
import { devNull } from "node:os";
import {
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  superviseSpawn,
  type SupervisedChild,
  wellKnownGitBinaryPaths,
} from "@fusion/core";

const GIT_TIMEOUT_MS = 5_000;
const GIT_MAX_BUFFER_BYTES = 1024 * 1024;
const GIT_TERMINATION_GRACE_MS = 250;
const GIT_CLOSE_CONFIRM_MS = 750;
const PROCESS_EXIT_POLL_MS = 10;
// Thirty seconds bounds a complete local admission while leaving ample headroom
// above the subsecond clean-checkout probes exercised by the focused suite.
const LOCAL_GIT_INSPECTION_TIMEOUT_MS = 30_000;
const OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const KNOWN_GIT_BUILTINS = new Set([
  "cat-file",
  "config",
  "commit-tree",
  "diff-tree",
  "ls-files",
  "ls-tree",
  "merge-base",
  "merge-tree",
  "read-tree",
  "rev-parse",
  "update-ref",
  "worktree",
]);
const CONTROLLED_GIT_CALLER_ENV_KEYS = new Set([
  "GIT_AUTHOR_DATE",
  "GIT_AUTHOR_EMAIL",
  "GIT_AUTHOR_NAME",
  "GIT_COMMITTER_DATE",
  "GIT_COMMITTER_EMAIL",
  "GIT_COMMITTER_NAME",
]);

type CccCampaignStatIdentity = Readonly<{
  path: string;
  dev: bigint;
  ino: bigint;
  mode: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  birthtimeNs: bigint;
}>;

type CccCampaignPhysicalIdentity = Readonly<{
  targetRoot: CccCampaignStatIdentity;
  gitControlPath: CccCampaignStatIdentity;
  gitDir: CccCampaignStatIdentity;
  gitCommonDir: CccCampaignStatIdentity;
  indexPath: CccCampaignStatIdentity;
  gitBinary: CccCampaignStatIdentity;
}>;

/**
 * Which tree the caller is inspecting, and therefore whose untracked paths the
 * observation is entitled to refuse.
 *
 * Every other check -- expected base object, HEAD descent, index-matches-HEAD,
 * tracked bytes matching the index, Git filters, physical identity -- is
 * unaffected by this choice and applies identically under both values.
 */
export type CccCampaignUntrackedPathCustody =
  /**
   * Default. The inspected tree is under campaign custody: the campaign
   * worktree Fusion creates, or a repository whose checkout a landing is about
   * to materialize into. It must hold no nonignored untracked path.
   */
  | "pristine"
  /**
   * The inspected tree is the owner's repository, observed only for base/HEAD
   * object identity. The campaign writes its linked worktree, never this tree,
   * so ordinary untracked developer files here are outside campaign custody
   * and must not refuse the campaign.
   */
  | "owner-repository";

export type InspectCccCampaignLocalGitInput = Readonly<{
  targetRoot: string;
  expectedBaseObject: string;
  expectedHeadObject?: string;
  expectedCheckoutObject?: string;
  /** Defaults to "pristine"; an omitted value never widens what is admitted. */
  untrackedPathCustody?: CccCampaignUntrackedPathCustody;
}>;

export type CccCampaignLocalGitSnapshot = Readonly<{
  targetRoot: string;
  gitDir: string;
  gitCommonDir: string;
  gitBinary: string;
  expectedBaseObject: string;
  head: string;
  headDescendsFromExpectedBase: true;
  dirty: false;
  untrackedPathCustody: CccCampaignUntrackedPathCustody;
  physicalIdentity: CccCampaignPhysicalIdentity;
}>;

export class CccCampaignLocalGitError extends Error {
  public readonly code = "CCC_CAMPAIGN_LOCAL_GIT_REFUSED";

  public constructor(message: string) {
    super(message);
    this.name = "CccCampaignLocalGitError";
  }
}

function controlledGitEnvironment(
  gitBinary: string,
  targetRoot: string,
  extraEnv: Readonly<NodeJS.ProcessEnv> = {},
): Readonly<NodeJS.ProcessEnv> {
  const supportPath = process.platform === "win32"
    ? [
      dirname(gitBinary),
      dirname(process.execPath),
      process.env.SystemRoot ? join(process.env.SystemRoot, "System32") : undefined,
    ]
    : [dirname(gitBinary), "/usr/bin", "/bin"];
  const env: NodeJS.ProcessEnv = {
    HOME: targetRoot,
    USERPROFILE: targetRoot,
    XDG_CONFIG_HOME: join(targetRoot, ".ccc-git-no-config"),
    PATH: supportPath.filter((value): value is string => Boolean(value)).join(delimiter),
    GIT_ATTR_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: devNull,
    GIT_GRAFT_FILE: devNull,
    GIT_NO_LAZY_FETCH: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    LANG: "C",
    LC_ALL: "C",
    ...controlledGitCallerEnvironment(extraEnv),
  };
  for (const key of [
    "SystemRoot",
    "WINDIR",
    "ComSpec",
    "PATHEXT",
    "TEMP",
    "TMP",
    "TMPDIR",
  ] as const) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return Object.freeze(env);
}

function controlledGitCallerEnvironment(
  extraEnv: Readonly<NodeJS.ProcessEnv>,
): Readonly<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(extraEnv)) {
    if (value === undefined) continue;
    if (!CONTROLLED_GIT_CALLER_ENV_KEYS.has(key)) {
      throw new CccCampaignLocalGitError(
        "CCC campaign refused unsupported Git environment override",
      );
    }
    if (value.length === 0 || value.length > 512 || /[\0\r\n]/u.test(value)) {
      throw new CccCampaignLocalGitError(
        "CCC campaign refused unsafe Git identity environment value",
      );
    }
    env[key] = value;
  }
  return Object.freeze(env);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, milliseconds);
  });
}

function finiteInspectionSignal(callerSignal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(LOCAL_GIT_INSPECTION_TIMEOUT_MS);
  return callerSignal
    ? AbortSignal.any([callerSignal, timeoutSignal])
    : timeoutSignal;
}

function ownedProcessGroupIsAlive(supervised: SupervisedChild): boolean {
  if (process.platform === "win32" || supervised.pgid === null) return false;
  try {
    process.kill(-supervised.pgid, 0);
    return true;
  } catch (error) {
    return Boolean(
      error
      && typeof error === "object"
      && (error as NodeJS.ErrnoException).code !== "ESRCH",
    );
  }
}

async function waitForOwnedTreeExit(
  supervised: SupervisedChild,
  timeoutMs: number,
): Promise<boolean> {
  let childClosed = false;
  void supervised.waitExit().then(() => {
    childClosed = true;
  });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (childClosed && !ownedProcessGroupIsAlive(supervised)) return true;
    await sleep(Math.min(PROCESS_EXIT_POLL_MS, Math.max(1, deadline - Date.now())));
  }
  return childClosed && !ownedProcessGroupIsAlive(supervised);
}

async function terminateSupervisedGit(supervised: SupervisedChild): Promise<boolean> {
  supervised.kill("SIGTERM");
  if (await waitForOwnedTreeExit(supervised, GIT_TERMINATION_GRACE_MS)) return true;
  supervised.kill("SIGKILL");
  return waitForOwnedTreeExit(supervised, GIT_CLOSE_CONFIRM_MS);
}

async function reapSupervisedGitDescendants(supervised: SupervisedChild): Promise<boolean> {
  if (!ownedProcessGroupIsAlive(supervised)) return true;
  return terminateSupervisedGit(supervised);
}

function gitCommandLabel(args: readonly string[]): string {
  return args[0] ?? "command";
}

function requireKnownGitBuiltin(args: readonly string[]): void {
  if (!KNOWN_GIT_BUILTINS.has(gitCommandLabel(args))) {
    throw new CccCampaignLocalGitError(
      "CCC campaign refused an unsupported Git command",
    );
  }
}

function runGitRaw(
  gitBinary: string,
  targetRoot: string,
  args: readonly string[],
  environment: Readonly<NodeJS.ProcessEnv>,
  signal?: AbortSignal,
  stdin?: string | Buffer,
): Promise<Buffer> {
  signal?.throwIfAborted();
  requireKnownGitBuiltin(args);
  return new Promise((resolveOutput, reject) => {
    const gitArgs = [
      "-c",
      "core.fsmonitor=false",
      "-c",
      `core.hooksPath=${devNull}`,
    ];
    if (args[0] === "ls-files" && args.includes("--others")) {
      gitArgs.push("-c", "core.untrackedCache=false");
    }
    gitArgs.push("-C", targetRoot, ...args);
    const supervised = superviseSpawn(
      gitBinary,
      gitArgs,
      {
        cwd: targetRoot,
        env: environment,
        killGraceMs: GIT_TERMINATION_GRACE_MS,
        maxLifetimeMs:
          GIT_TIMEOUT_MS + GIT_TERMINATION_GRACE_MS + GIT_CLOSE_CONFIRM_MS,
        stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    const child = supervised.child;
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let stopping = false;

    const cleanup = (): void => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    };
    const finishReject = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const terminateAndReject = (error: unknown): void => {
      if (settled || stopping) return;
      stopping = true;
      cleanup();
      void terminateSupervisedGit(supervised).then((closed) => {
        if (closed) {
          finishReject(error);
          return;
        }
        finishReject(new CccCampaignLocalGitError(
          `Git ${gitCommandLabel(args)} timed out and its process tree did not close after SIGKILL`,
        ));
      });
    };
    const appendStdout = (chunk: Buffer): void => {
      if (stopping) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > GIT_MAX_BUFFER_BYTES) {
        terminateAndReject(new CccCampaignLocalGitError(
          `Git ${gitCommandLabel(args)} exceeded the output limit`,
        ));
        return;
      }
      stdout.push(chunk);
    };
    const observeStderr = (chunk: Buffer): void => {
      if (stopping) return;
      stderrBytes += chunk.length;
      if (stderrBytes > GIT_MAX_BUFFER_BYTES) {
        terminateAndReject(new CccCampaignLocalGitError(
          `Git ${gitCommandLabel(args)} exceeded the error-output limit`,
        ));
      }
    };
    const onAbort = (): void => {
      const reason = signal?.reason;
      terminateAndReject(
        reason instanceof Error
          ? reason
          : Object.assign(new Error("The operation was aborted"), { name: "AbortError" }),
      );
    };
    const timeout = setTimeout(() => {
      terminateAndReject(new CccCampaignLocalGitError(
        `Git ${gitCommandLabel(args)} timed out after ${GIT_TIMEOUT_MS}ms`,
      ));
    }, GIT_TIMEOUT_MS);
    timeout.unref();

    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    child.stdout?.on("data", appendStdout);
    child.stderr?.on("data", observeStderr);
    if (stdin !== undefined) {
      child.stdin?.end(stdin);
    }
    child.once("error", (error) => {
      terminateAndReject(new CccCampaignLocalGitError(
        `Git ${gitCommandLabel(args)} could not be started: ${
          (error as NodeJS.ErrnoException).code ?? error.name
        }`,
      ));
    });
    child.once("close", (code) => {
      if (settled || stopping) return;
      cleanup();
      void reapSupervisedGitDescendants(supervised).then((reaped) => {
        if (!reaped) {
          finishReject(new CccCampaignLocalGitError(
            `Git ${gitCommandLabel(args)} left a process tree after exit`,
          ));
          return;
        }
        if (code !== 0) {
          finishReject(new CccCampaignLocalGitError(
            `Git ${gitCommandLabel(args)} failed`,
          ));
          return;
        }
        if (!settled) {
          settled = true;
          resolveOutput(Buffer.concat(stdout, stdoutBytes));
        }
      });
    });
  });
}

async function runGit(
  gitBinary: string,
  targetRoot: string,
  args: readonly string[],
  environment: Readonly<NodeJS.ProcessEnv>,
  signal?: AbortSignal,
): Promise<string> {
  return (await runGitRaw(
    gitBinary,
    targetRoot,
    args,
    environment,
    signal,
  )).toString("utf8").trim();
}

export async function runControlledCccCampaignGit(
  snapshot: Pick<CccCampaignLocalGitSnapshot, "gitBinary" | "targetRoot">,
  args: readonly string[],
  options: Readonly<{
    env?: Readonly<NodeJS.ProcessEnv>;
    signal?: AbortSignal;
    stdin?: string | Buffer;
  }> = {},
): Promise<Buffer> {
  return runGitRaw(
    snapshot.gitBinary,
    snapshot.targetRoot,
    args,
    controlledGitEnvironment(snapshot.gitBinary, snapshot.targetRoot, options.env),
    options.signal,
    options.stdin,
  );
}

function requireCanonicalObjectId(value: string, label: string): string {
  if (!OBJECT_ID_PATTERN.test(value)) {
    throw new CccCampaignLocalGitError(
      `CCC campaign ${label} must be a canonical lowercase full Git object ID`,
    );
  }
  return value;
}

async function resolvePhysicalPath(path: string, label: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    throw new CccCampaignLocalGitError(`CCC campaign ${label} cannot be resolved physically`);
  }
}

async function resolvePinnedGitBinary(signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  for (const candidate of wellKnownGitBinaryPaths()) {
    signal.throwIfAborted();
    if (!isAbsolute(candidate)) continue;
    try {
      const physicalPath = await realpath(candidate);
      signal.throwIfAborted();
      if (!isAbsolute(physicalPath)) continue;
      const physicalStat = await stat(physicalPath);
      signal.throwIfAborted();
      if (!physicalStat.isFile()) continue;
      await access(physicalPath, fsConstants.X_OK);
      signal.throwIfAborted();
      return physicalPath;
    } catch {
      signal.throwIfAborted();
      // Try the next declared well-known absolute path.
    }
  }
  signal.throwIfAborted();
  throw new CccCampaignLocalGitError(
    "CCC campaign could not pin Git to an executable physical path",
  );
}

async function captureStatIdentity(
  path: string,
  label: string,
  followSymlink = true,
): Promise<CccCampaignStatIdentity> {
  try {
    const value = followSymlink
      ? await stat(path, { bigint: true })
      : await lstat(path, { bigint: true });
    return Object.freeze({
      path,
      dev: value.dev,
      ino: value.ino,
      mode: value.mode,
      size: value.size,
      mtimeNs: value.mtimeNs,
      ctimeNs: value.ctimeNs,
      birthtimeNs: value.birthtimeNs,
    });
  } catch {
    throw new CccCampaignLocalGitError(
      `CCC campaign ${label} physical identity cannot be read`,
    );
  }
}

async function capturePhysicalIdentity(input: {
  targetRoot: string;
  gitControlPath: string;
  gitDir: string;
  gitCommonDir: string;
  indexPath: string;
  gitBinary: string;
}): Promise<CccCampaignPhysicalIdentity> {
  const [
    targetRoot,
    gitControlPath,
    gitDir,
    gitCommonDir,
    indexPath,
    gitBinary,
  ] = await Promise.all([
    captureStatIdentity(input.targetRoot, "target root", false),
    captureStatIdentity(input.gitControlPath, "Git control path", false),
    captureStatIdentity(input.gitDir, "Git directory"),
    captureStatIdentity(input.gitCommonDir, "Git common directory"),
    captureStatIdentity(input.indexPath, "Git index"),
    captureStatIdentity(input.gitBinary, "Git binary"),
  ]);
  return Object.freeze({
    targetRoot,
    gitControlPath,
    gitDir,
    gitCommonDir,
    indexPath,
    gitBinary,
  });
}

/*
 * FNXC:CampaignGuardObservability 2026-08-24-03:20:
 * Compare inode identity only. `size`, `mtimeNs`, and `ctimeNs` move whenever
 * ordinary content changes -- notably, any read-only `git status` refreshes
 * .git/index's stat cache and rewrites those three fields. Including them made
 * the recheck report "physical identity or HEAD changed" for benign inspection
 * and killed a live campaign mid-run.
 *
 * What this guard is for is detecting the target being substituted: swapped,
 * relinked, or repointed at a different object. Every such substitution creates
 * a new inode, so `dev`/`ino` (plus `mode` and `birthtimeNs`) still catch it --
 * see the same-path checkout and control-directory replacement tests. Dropping
 * the volatile fields costs no real detection and removes a false positive that
 * fires on reads.
 */
function sameStatIdentity(
  left: CccCampaignStatIdentity,
  right: CccCampaignStatIdentity,
): boolean {
  return left.path === right.path
    && left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.birthtimeNs === right.birthtimeNs;
}

/*
 * FNXC:CampaignGuardObservability 2026-08-24-03:20:
 * The index is the one entry here that Git itself replaces during ordinary use:
 * `git status` writes index.lock and renames it over .git/index, so the file
 * gets a brand-new inode even though nothing about the repository's identity
 * moved. Anchoring on its inode therefore reports a substitution on every read.
 *
 * Location is the durable property worth asserting: the index still resolves to
 * the same path on the same device. Substitution of the repository is caught by
 * the surrounding entries -- swapping the checkout or the control directory
 * gives targetRoot/gitControlPath/gitDir/gitCommonDir new inodes -- so the index
 * carries no unique detection weight that this loosening gives up.
 */
function sameIndexLocation(
  left: CccCampaignStatIdentity,
  right: CccCampaignStatIdentity,
): boolean {
  return left.path === right.path && left.dev === right.dev;
}

function samePhysicalIdentity(
  left: CccCampaignPhysicalIdentity,
  right: CccCampaignPhysicalIdentity,
): boolean {
  return sameStatIdentity(left.targetRoot, right.targetRoot)
    && sameStatIdentity(left.gitControlPath, right.gitControlPath)
    && sameStatIdentity(left.gitDir, right.gitDir)
    && sameStatIdentity(left.gitCommonDir, right.gitCommonDir)
    && sameIndexLocation(left.indexPath, right.indexPath)
    && sameStatIdentity(left.gitBinary, right.gitBinary);
}

type GitObjectFormat = Readonly<{
  algorithm: "sha1" | "sha256";
  objectIdLength: 40 | 64;
}>;

type GitIndexEntry = Readonly<{
  mode: "100644" | "100755" | "120000";
  objectId: string;
  path: string;
}>;

function splitNullRecords(output: Buffer, label: string): Buffer[] {
  if (output.length === 0) return [];
  if (output[output.length - 1] !== 0) {
    throw new CccCampaignLocalGitError(
      `CCC campaign ${label} output was not NUL terminated`,
    );
  }
  const records: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < output.length; index += 1) {
    if (output[index] !== 0) continue;
    records.push(output.subarray(start, index));
    start = index + 1;
  }
  return records;
}

function decodeRepositoryPath(pathBytes: Buffer): string {
  let path: string;
  try {
    path = new TextDecoder("utf-8", { fatal: true }).decode(pathBytes);
  } catch {
    throw new CccCampaignLocalGitError(
      "CCC campaign refused a tracked path that is not canonical UTF-8",
    );
  }
  if (path.length === 0 || path.includes("\0")) {
    throw new CccCampaignLocalGitError(
      "CCC campaign refused an invalid tracked path",
    );
  }
  return path;
}

function pathIsInsideRoot(targetRoot: string, candidate: string): boolean {
  const relativePath = relative(targetRoot, candidate);
  return relativePath === ""
    || (
      relativePath !== ".."
      && !relativePath.startsWith(`..${sep}`)
      && !isAbsolute(relativePath)
    );
}

function resolveTrackedWorktreePath(targetRoot: string, path: string): string {
  const candidate = resolve(targetRoot, path);
  if (candidate === targetRoot || !pathIsInsideRoot(targetRoot, candidate)) {
    throw new CccCampaignLocalGitError(
      "CCC campaign refused a tracked path outside the target root",
    );
  }
  return candidate;
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
    && left.birthtimeNs === right.birthtimeNs;
}

function modeMatchesIndex(mode: GitIndexEntry["mode"], value: BigIntStats): boolean {
  if (mode === "120000") return value.isSymbolicLink();
  if (!value.isFile()) return false;
  const ownerExecutable = (value.mode & 0o100n) !== 0n;
  return mode === "100755" ? ownerExecutable : !ownerExecutable;
}

function hashGitBlob(
  objectFormat: GitObjectFormat,
  bytes: Buffer,
): string {
  return createHash(objectFormat.algorithm)
    .update(Buffer.from(`blob ${bytes.length}\0`, "utf8"))
    .update(bytes)
    .digest("hex");
}

async function hashRegularGitBlob(
  targetRoot: string,
  worktreePath: string,
  objectFormat: GitObjectFormat,
  signal: AbortSignal,
): Promise<{ objectId: string; stat: BigIntStats }> {
  signal.throwIfAborted();
  const pathBefore = await lstat(worktreePath, { bigint: true });
  signal.throwIfAborted();
  if (!pathBefore.isFile()) {
    throw new CccCampaignLocalGitError(
      "CCC campaign tracked worktree type differs from the index",
    );
  }
  const physicalPath = await realpath(worktreePath);
  signal.throwIfAborted();
  if (!pathIsInsideRoot(targetRoot, physicalPath)) {
    throw new CccCampaignLocalGitError(
      "CCC campaign refused tracked worktree bytes outside the target root",
    );
  }
  if (physicalPath !== worktreePath) {
    throw new CccCampaignLocalGitError(
      "CCC campaign refused a tracked regular file reached through a noncanonical path",
    );
  }
  const noFollow = process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW;
  const nonBlock = process.platform === "win32" ? 0 : fsConstants.O_NONBLOCK;
  const handle = await open(
    worktreePath,
    fsConstants.O_RDONLY | noFollow | nonBlock,
  );
  try {
    signal.throwIfAborted();
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || !sameFileIdentity(pathBefore, before)) {
      throw new CccCampaignLocalGitError(
        "CCC campaign tracked worktree identity or type changed before hashing",
      );
    }
    if (before.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new CccCampaignLocalGitError(
        "CCC campaign tracked worktree file is too large to hash safely",
      );
    }
    const physicalStat = await stat(physicalPath, { bigint: true });
    if (!sameFileIdentity(before, physicalStat)) {
      throw new CccCampaignLocalGitError(
        "CCC campaign tracked worktree identity changed before hashing",
      );
    }

    const hash = createHash(objectFormat.algorithm);
    hash.update(Buffer.from(`blob ${before.size}\0`, "utf8"));
    const initialByteLength = Number(before.size);
    let hashedBytes = 0;
    if (initialByteLength > 0) {
      const stream = handle.createReadStream({
        autoClose: false,
        start: 0,
        end: initialByteLength - 1,
        signal,
      });
      for await (const chunk of stream) {
        signal.throwIfAborted();
        const bytes = chunk as Buffer;
        hashedBytes += bytes.length;
        if (hashedBytes > initialByteLength) {
          throw new CccCampaignLocalGitError(
            "CCC campaign tracked worktree exceeded its captured byte length",
          );
        }
        hash.update(bytes);
      }
    }
    signal.throwIfAborted();
    if (hashedBytes !== initialByteLength) {
      throw new CccCampaignLocalGitError(
        "CCC campaign tracked worktree byte length changed while hashing",
      );
    }
    const after = await handle.stat({ bigint: true });
    const finalPathStat = await lstat(worktreePath, { bigint: true });
    const finalPhysicalPath = await realpath(worktreePath);
    signal.throwIfAborted();
    if (!pathIsInsideRoot(targetRoot, finalPhysicalPath)) {
      throw new CccCampaignLocalGitError(
        "CCC campaign refused tracked worktree bytes outside the target root",
      );
    }
    if (finalPhysicalPath !== worktreePath) {
      throw new CccCampaignLocalGitError(
        "CCC campaign tracked regular file changed to a noncanonical path while hashing",
      );
    }
    if (
      !sameFileIdentity(before, after)
      || !sameFileIdentity(after, finalPathStat)
    ) {
      throw new CccCampaignLocalGitError(
        "CCC campaign tracked worktree identity changed while hashing",
      );
    }
    return { objectId: hash.digest("hex"), stat: after };
  } finally {
    await handle.close();
  }
}

async function readSymlinkGitBlob(
  targetRoot: string,
  worktreePath: string,
  objectFormat: GitObjectFormat,
  signal: AbortSignal,
): Promise<{ objectId: string; stat: BigIntStats }> {
  signal.throwIfAborted();
  const worktreeParent = dirname(worktreePath);
  const physicalParent = await realpath(worktreeParent);
  signal.throwIfAborted();
  if (!pathIsInsideRoot(targetRoot, physicalParent)) {
    throw new CccCampaignLocalGitError(
      "CCC campaign refused a tracked symlink outside the target root",
    );
  }
  if (physicalParent !== worktreeParent) {
    throw new CccCampaignLocalGitError(
      "CCC campaign refused an indexed symlink whose parent is a noncanonical path",
    );
  }
  const before = await lstat(worktreePath, { bigint: true });
  if (!before.isSymbolicLink()) {
    throw new CccCampaignLocalGitError(
      "CCC campaign tracked worktree type differs from the index",
    );
  }
  const target = await readlink(worktreePath, { encoding: "buffer" });
  signal.throwIfAborted();
  const after = await lstat(worktreePath, { bigint: true });
  const finalPhysicalParent = await realpath(worktreeParent);
  signal.throwIfAborted();
  if (!pathIsInsideRoot(targetRoot, finalPhysicalParent)) {
    throw new CccCampaignLocalGitError(
      "CCC campaign refused a tracked symlink outside the target root",
    );
  }
  if (finalPhysicalParent !== worktreeParent) {
    throw new CccCampaignLocalGitError(
      "CCC campaign indexed symlink parent changed to a noncanonical path while reading",
    );
  }
  if (
    !sameFileIdentity(before, after)
    || physicalParent !== finalPhysicalParent
  ) {
    throw new CccCampaignLocalGitError(
      "CCC campaign tracked symlink identity changed while reading",
    );
  }
  return { objectId: hashGitBlob(objectFormat, target), stat: after };
}

function parseGitObjectFormat(value: string): GitObjectFormat {
  if (value === "sha1") {
    return Object.freeze({ algorithm: "sha1", objectIdLength: 40 });
  }
  if (value === "sha256") {
    return Object.freeze({ algorithm: "sha256", objectIdLength: 64 });
  }
  throw new CccCampaignLocalGitError(
    "CCC campaign refused an unsupported Git object format",
  );
}

function parseStageZeroEntries(
  output: Buffer,
  objectFormat: GitObjectFormat,
): GitIndexEntry[] {
  const entries: GitIndexEntry[] = [];
  const seenPaths = new Set<string>();
  const headerPattern = new RegExp(
    `^([0-7]{6}) ([0-9a-f]{${objectFormat.objectIdLength}}) ([0-3])$`,
  );
  for (const record of splitNullRecords(output, "tracked index")) {
    const separator = record.indexOf(0x09);
    if (separator < 0) {
      throw new CccCampaignLocalGitError(
        "CCC campaign refused malformed tracked index output",
      );
    }
    const match = headerPattern.exec(record.subarray(0, separator).toString("ascii"));
    if (!match || match[3] !== "0") {
      throw new CccCampaignLocalGitError(
        "CCC campaign refused an unmerged or malformed index entry",
      );
    }
    const mode = match[1];
    if (mode === "160000") {
      throw new CccCampaignLocalGitError(
        "CCC campaign refused a tracked submodule entry",
      );
    }
    if (mode !== "100644" && mode !== "100755" && mode !== "120000") {
      throw new CccCampaignLocalGitError(
        "CCC campaign refused an unsupported tracked index mode",
      );
    }
    const path = decodeRepositoryPath(record.subarray(separator + 1));
    if (seenPaths.has(path)) {
      throw new CccCampaignLocalGitError(
        "CCC campaign refused duplicate tracked index paths",
      );
    }
    seenPaths.add(path);
    entries.push(Object.freeze({
      mode,
      objectId: match[2]!,
      path,
    }));
  }
  return entries;
}

function parseHeadTreeEntries(
  output: Buffer,
  objectFormat: GitObjectFormat,
): GitIndexEntry[] {
  const entries: GitIndexEntry[] = [];
  const seenPaths = new Set<string>();
  const headerPattern = new RegExp(
    `^([0-7]{6}) (blob|tree|commit) ([0-9a-f]{${objectFormat.objectIdLength}})$`,
  );
  for (const record of splitNullRecords(output, "HEAD tree")) {
    const separator = record.indexOf(0x09);
    if (separator < 0) {
      throw new CccCampaignLocalGitError(
        "CCC campaign refused malformed HEAD tree output",
      );
    }
    const match = headerPattern.exec(record.subarray(0, separator).toString("ascii"));
    if (!match) {
      throw new CccCampaignLocalGitError(
        "CCC campaign refused malformed HEAD tree output",
      );
    }
    const mode = match[1];
    const type = match[2];
    if (mode === "160000" || type === "commit") {
      throw new CccCampaignLocalGitError(
        "CCC campaign refused a submodule in the HEAD tree",
      );
    }
    if (
      type !== "blob"
      || (mode !== "100644" && mode !== "100755" && mode !== "120000")
    ) {
      throw new CccCampaignLocalGitError(
        "CCC campaign refused an unsupported HEAD tree entry",
      );
    }
    const path = decodeRepositoryPath(record.subarray(separator + 1));
    if (seenPaths.has(path)) {
      throw new CccCampaignLocalGitError(
        "CCC campaign refused duplicate HEAD tree paths",
      );
    }
    seenPaths.add(path);
    entries.push(Object.freeze({
      mode,
      objectId: match[3]!,
      path,
    }));
  }
  return entries;
}

function assertIndexMatchesHead(
  indexEntries: readonly GitIndexEntry[],
  headEntries: readonly GitIndexEntry[],
): void {
  if (indexEntries.length !== headEntries.length) {
    throw new CccCampaignLocalGitError(
      "CCC campaign stage-0 index differs from the exact HEAD tree",
    );
  }
  const headByPath = new Map(headEntries.map((entry) => [entry.path, entry]));
  for (const indexEntry of indexEntries) {
    const headEntry = headByPath.get(indexEntry.path);
    if (
      !headEntry
      || headEntry.mode !== indexEntry.mode
      || headEntry.objectId !== indexEntry.objectId
    ) {
      throw new CccCampaignLocalGitError(
        "CCC campaign stage-0 index differs from the exact HEAD tree",
      );
    }
  }
}

async function assertTrackedEntryMatchesIndex(
  targetRoot: string,
  entry: GitIndexEntry,
  objectFormat: GitObjectFormat,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const worktreePath = resolveTrackedWorktreePath(targetRoot, entry.path);
  try {
    const observed = entry.mode === "120000"
      ? await readSymlinkGitBlob(targetRoot, worktreePath, objectFormat, signal)
      : await hashRegularGitBlob(targetRoot, worktreePath, objectFormat, signal);
    signal.throwIfAborted();
    if (
      !modeMatchesIndex(entry.mode, observed.stat)
      || observed.objectId !== entry.objectId
    ) {
      throw new CccCampaignLocalGitError(
        "CCC campaign tracked worktree bytes, type, or mode differ from the index",
      );
    }
  } catch (error) {
    if (signal.aborted) signal.throwIfAborted();
    if (error instanceof CccCampaignLocalGitError) throw error;
    throw new CccCampaignLocalGitError(
      "CCC campaign tracked worktree bytes, type, or mode could not be verified",
    );
  }
}

async function assertCleanGitSample(
  gitBinary: string,
  targetRoot: string,
  head: string,
  environment: Readonly<NodeJS.ProcessEnv>,
  signal: AbortSignal,
  untrackedPathCustody: CccCampaignUntrackedPathCustody,
): Promise<void> {
  const configuredNames = splitNullRecords(
    await runGitRaw(
      gitBinary,
      targetRoot,
      ["config", "--null", "--name-only", "--list", "--includes"],
      environment,
      signal,
    ),
    "Git config names",
  );
  if (configuredNames.some((name) => (
    name.toString("utf8").toLowerCase().startsWith("filter.")
  ))) {
    throw new CccCampaignLocalGitError(
      "CCC campaign refused repository-configured Git filters",
    );
  }

  const indexFlags = await runGitRaw(
    gitBinary,
    targetRoot,
    ["ls-files", "-v", "-z", "--"],
    environment,
    signal,
  );
  if (splitNullRecords(indexFlags, "index flags").some((record) => (
    record.length < 2
    || record[1] !== 0x20
    || record[0] === 0x53
    || (record[0]! >= 0x61 && record[0]! <= 0x7a)
  ))) {
    throw new CccCampaignLocalGitError(
      "CCC campaign target index flags are malformed or include assume-unchanged or skip-worktree",
    );
  }

  const objectFormat = parseGitObjectFormat(await runGit(
    gitBinary,
    targetRoot,
    ["rev-parse", "--show-object-format=storage"],
    environment,
    signal,
  ));
  const trackedEntries = parseStageZeroEntries(
    await runGitRaw(
      gitBinary,
      targetRoot,
      ["ls-files", "--stage", "-z", "--"],
      environment,
      signal,
    ),
    objectFormat,
  );
  const headEntries = parseHeadTreeEntries(
    await runGitRaw(
      gitBinary,
      targetRoot,
      ["ls-tree", "-r", "-z", "--full-tree", head],
      environment,
      signal,
    ),
    objectFormat,
  );
  assertIndexMatchesHead(trackedEntries, headEntries);
  for (const entry of trackedEntries) {
    signal.throwIfAborted();
    await assertTrackedEntryMatchesIndex(
      targetRoot,
      entry,
      objectFormat,
      signal,
    );
    signal.throwIfAborted();
  }

  /*
   * Scoped deliberately. `git ls-files --others` reports the untracked paths of
   * THIS tree only, so the same call means "the campaign worktree is pristine"
   * for a worktree under campaign custody and "the owner may not keep scratch
   * files" for the owner's own checkout. Only the first is a custody rule, so
   * the caller declares which tree it handed us.
   */
  if (untrackedPathCustody === "owner-repository") return;

  const untracked = await runGitRaw(
    gitBinary,
    targetRoot,
    ["ls-files", "--others", "--exclude-standard", "-z", "--"],
    environment,
    signal,
  );
  if (untracked.length > 0) {
    const untrackedPaths = untracked
      .toString("utf8")
      .split("\0")
      .filter((path) => path.length > 0);
    throw new CccCampaignLocalGitError(
      `CCC campaign target worktree has nonignored untracked paths: ${JSON.stringify(untrackedPaths)}`,
    );
  }
}

export async function inspectCccCampaignLocalGit(
  input: InspectCccCampaignLocalGitInput,
  signal?: AbortSignal,
): Promise<CccCampaignLocalGitSnapshot> {
  return inspectCccCampaignLocalGitWithAuthority(
    input,
    finiteInspectionSignal(signal),
  );
}

async function inspectCccCampaignLocalGitWithAuthority(
  input: InspectCccCampaignLocalGitInput,
  signal: AbortSignal,
  pinned?: Readonly<{
    gitBinary: string;
    gitBinaryIdentity: CccCampaignStatIdentity;
  }>,
): Promise<CccCampaignLocalGitSnapshot> {
  signal?.throwIfAborted();
  const expectedBaseObject = requireCanonicalObjectId(
    input.expectedBaseObject,
    "expected base object",
  );
  const expectedHeadObject = input.expectedHeadObject === undefined
    ? undefined
    : requireCanonicalObjectId(input.expectedHeadObject, "expected HEAD object");
  const expectedCheckoutObject = input.expectedCheckoutObject === undefined
    ? undefined
    : requireCanonicalObjectId(input.expectedCheckoutObject, "expected checkout object");
  const untrackedPathCustody = input.untrackedPathCustody ?? "pristine";
  if (untrackedPathCustody !== "pristine" && untrackedPathCustody !== "owner-repository") {
    throw new CccCampaignLocalGitError(
      "CCC campaign untracked-path custody must be pristine or owner-repository",
    );
  }
  const targetRoot = await resolvePhysicalPath(input.targetRoot, "target root");
  const gitControlPath = join(targetRoot, ".git");
  const initialTargetRootIdentity = await captureStatIdentity(
    targetRoot,
    "initial target root",
    false,
  );
  signal?.throwIfAborted();
  const gitBinary = pinned?.gitBinary ?? await resolvePinnedGitBinary(signal);
  if (!isAbsolute(gitBinary) || await resolvePhysicalPath(gitBinary, "Git binary") !== gitBinary) {
    throw new CccCampaignLocalGitError(
      "CCC campaign pinned Git binary must be an absolute physical path",
    );
  }
  const initialGitBinaryIdentity = await captureStatIdentity(gitBinary, "initial Git binary");
  if (
    pinned
    && !sameStatIdentity(initialGitBinaryIdentity, pinned.gitBinaryIdentity)
  ) {
    throw new CccCampaignLocalGitError(
      "CCC campaign pinned Git binary physical identity changed before recheck",
    );
  }
  const environment = controlledGitEnvironment(gitBinary, targetRoot);
  signal?.throwIfAborted();

  const insideWorktree = await runGit(
    gitBinary,
    targetRoot,
    ["rev-parse", "--is-inside-work-tree"],
    environment,
    signal,
  );
  const bare = await runGit(
    gitBinary,
    targetRoot,
    ["rev-parse", "--is-bare-repository"],
    environment,
    signal,
  );
  if (insideWorktree !== "true" || bare !== "false") {
    throw new CccCampaignLocalGitError(
      "CCC campaign target must be a non-bare Git worktree",
    );
  }
  const initialGitControlIdentity = await captureStatIdentity(
    gitControlPath,
    "initial Git control path",
    false,
  );

  const reportedTopLevel = await runGit(
    gitBinary,
    targetRoot,
    ["rev-parse", "--show-toplevel"],
    environment,
    signal,
  );
  const physicalTopLevel = await resolvePhysicalPath(
    reportedTopLevel,
    "Git top-level",
  );
  if (physicalTopLevel !== targetRoot) {
    throw new CccCampaignLocalGitError(
      "CCC campaign target root does not exactly match Git show-toplevel",
    );
  }

  const reportedGitDir = await runGit(
    gitBinary,
    targetRoot,
    ["rev-parse", "--absolute-git-dir"],
    environment,
    signal,
  );
  const gitDir = await resolvePhysicalPath(reportedGitDir, "Git directory");
  const reportedGitCommonDir = await runGit(
    gitBinary,
    targetRoot,
    ["rev-parse", "--git-common-dir"],
    environment,
    signal,
  );
  const gitCommonDir = await resolvePhysicalPath(
    resolve(targetRoot, reportedGitCommonDir),
    "Git common directory",
  );
  const reportedIndexPath = await runGit(
    gitBinary,
    targetRoot,
    ["rev-parse", "--git-path", "index"],
    environment,
    signal,
  );
  const indexPath = await resolvePhysicalPath(
    resolve(targetRoot, reportedIndexPath),
    "Git index",
  );
  const physicalIdentity = await capturePhysicalIdentity({
    targetRoot,
    gitControlPath,
    gitDir,
    gitCommonDir,
    indexPath,
    gitBinary,
  });
  if (
    !sameStatIdentity(physicalIdentity.targetRoot, initialTargetRootIdentity)
    || !sameStatIdentity(physicalIdentity.gitControlPath, initialGitControlIdentity)
    || !sameStatIdentity(physicalIdentity.gitBinary, initialGitBinaryIdentity)
  ) {
    throw new CccCampaignLocalGitError(
      "CCC campaign physical identity changed while resolving Git custody",
    );
  }

  let resolvedBase: string;
  try {
    resolvedBase = await runGit(
      gitBinary,
      targetRoot,
      ["rev-parse", "--verify", `${expectedBaseObject}^{commit}`],
      environment,
      signal,
    );
  } catch (error) {
    if (error instanceof CccCampaignLocalGitError) {
      throw new CccCampaignLocalGitError(
        `CCC campaign could not resolve expected base commit ${expectedBaseObject}`,
      );
    }
    throw error;
  }
  if (resolvedBase !== expectedBaseObject) {
    throw new CccCampaignLocalGitError(
      "CCC campaign expected base does not resolve to that exact commit object",
    );
  }

  const head = requireCanonicalObjectId(
    await runGit(
      gitBinary,
      targetRoot,
      ["rev-parse", "--verify", "HEAD^{commit}"],
      environment,
      signal,
    ),
    "HEAD",
  );
  if (expectedHeadObject !== undefined && head !== expectedHeadObject) {
    throw new CccCampaignLocalGitError(
      "CCC campaign HEAD does not match the exact expected HEAD object",
    );
  }
  try {
    await runGit(
      gitBinary,
      targetRoot,
      ["merge-base", "--is-ancestor", expectedBaseObject, head],
      environment,
      signal,
    );
  } catch (error) {
    if (error instanceof CccCampaignLocalGitError) {
      throw new CccCampaignLocalGitError(
        "CCC campaign HEAD does not descend from the expected base commit",
      );
    }
    throw error;
  }

  await assertCleanGitSample(
    gitBinary,
    targetRoot,
    expectedCheckoutObject ?? head,
    environment,
    signal,
    untrackedPathCustody,
  );

  const stableHead = requireCanonicalObjectId(
    await runGit(
      gitBinary,
      targetRoot,
      ["rev-parse", "--verify", "HEAD^{commit}"],
      environment,
      signal,
    ),
    "stable HEAD",
  );
  if (stableHead !== head) {
    throw new CccCampaignLocalGitError(
      "CCC campaign HEAD changed during local Git inspection",
    );
  }
  await assertCleanGitSample(
    gitBinary,
    targetRoot,
    expectedCheckoutObject ?? head,
    environment,
    signal,
    untrackedPathCustody,
  );
  const finalHead = requireCanonicalObjectId(
    await runGit(
      gitBinary,
      targetRoot,
      ["rev-parse", "--verify", "HEAD^{commit}"],
      environment,
      signal,
    ),
    "final HEAD",
  );
  if (finalHead !== head) {
    throw new CccCampaignLocalGitError(
      "CCC campaign HEAD changed during final local Git inspection",
    );
  }
  const finalPhysicalIdentity = await capturePhysicalIdentity({
    targetRoot,
    gitControlPath,
    gitDir,
    gitCommonDir,
    indexPath,
    gitBinary,
  });
  if (!samePhysicalIdentity(finalPhysicalIdentity, physicalIdentity)) {
    throw new CccCampaignLocalGitError(
      "CCC campaign physical identity changed during local Git inspection",
    );
  }

  return Object.freeze({
    targetRoot,
    gitDir,
    gitCommonDir,
    gitBinary,
    expectedBaseObject,
    head,
    headDescendsFromExpectedBase: true as const,
    dirty: false as const,
    untrackedPathCustody,
    physicalIdentity,
  });
}

export async function recheckCccCampaignLocalGit(
  snapshot: CccCampaignLocalGitSnapshot,
  signal?: AbortSignal,
): Promise<CccCampaignLocalGitSnapshot> {
  const inspectionSignal = finiteInspectionSignal(signal);
  const current = await inspectCccCampaignLocalGitWithAuthority(
    {
      targetRoot: snapshot.targetRoot,
      expectedBaseObject: snapshot.expectedBaseObject,
      /*
       * Carried, never re-derived. The dispatch path rechecks this snapshot
       * before every provider call; re-deriving strict custody here would
       * refuse mid-campaign the moment the owner touched their own checkout.
       */
      untrackedPathCustody: snapshot.untrackedPathCustody,
    },
    inspectionSignal,
    {
      gitBinary: snapshot.gitBinary,
      gitBinaryIdentity: snapshot.physicalIdentity.gitBinary,
    },
  );
  if (
    current.targetRoot !== snapshot.targetRoot
    || current.gitDir !== snapshot.gitDir
    || current.gitCommonDir !== snapshot.gitCommonDir
    || current.expectedBaseObject !== snapshot.expectedBaseObject
    || current.head !== snapshot.head
    || current.gitBinary !== snapshot.gitBinary
    || current.untrackedPathCustody !== snapshot.untrackedPathCustody
    || !samePhysicalIdentity(current.physicalIdentity, snapshot.physicalIdentity)
  ) {
    throw new CccCampaignLocalGitError(
      "CCC campaign local Git physical identity or HEAD changed after inspection",
    );
  }
  return current;
}
