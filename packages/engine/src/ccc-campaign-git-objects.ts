import { realpath, lstat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  inspectCccCampaignLocalGit,
  runControlledCccCampaignGit,
  recheckCccCampaignLocalGit,
  type CccCampaignLocalGitSnapshot,
} from "./ccc-campaign-local-git.js";

const OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const REF_PATTERN = /^refs\/heads\/[A-Za-z0-9._/-]+$/u;
const PRINTABLE_ASCII_PATTERN = /^[\x20-\x7e]+$/u;

export type CccCampaignGitCommitIdentity = Readonly<{
  name: string;
  email: string;
  timestamp: string;
}>;

export type PrepareCccCampaignGitObjectsInput = Readonly<{
  targetRoot: string;
  expectedBaseObject: string;
  sourceRef: string;
  targetRef: string;
  admittedWriteRoots: readonly string[];
  identity: CccCampaignGitCommitIdentity;
  message: string;
  signal?: AbortSignal;
}>;

export type CccCampaignTargetCheckout =
  | Readonly<{
    mode: "not-checked-out";
    rootBranch: string | null;
  }>
  | Readonly<{
    mode: "target-root";
    path: string;
  }>;

type StableStatIdentity = Readonly<{
  path: string;
  dev: string;
  ino: string;
  mode: string;
  birthtimeNs: string;
}>;

export type CccCampaignGitCustodyIdentity = Readonly<{
  targetRoot: StableStatIdentity;
  gitControlPath: StableStatIdentity;
  gitDir: StableStatIdentity;
  gitCommonDir: StableStatIdentity;
  gitBinary: StableStatIdentity;
  indexPath: string;
}>;

export type PreparedCccCampaignGitObjects = Readonly<{
  snapshot: CccCampaignLocalGitSnapshot;
  targetRef: string;
  sourceRef: string;
  expectedTarget: string;
  sourceCommit: string;
  treeObject: string;
  commitObject: string;
  mutationPaths: readonly string[];
  admittedWriteRoots: readonly string[];
  identity: CccCampaignGitCommitIdentity;
  message: string;
  postObjectSnapshot: CccCampaignLocalGitSnapshot;
  objectBaselineBefore: readonly string[];
  expectedGeneratedObjectIds: readonly string[];
  targetCheckout: CccCampaignTargetCheckout;
  custodyIdentity: CccCampaignGitCustodyIdentity;
}>;

export type RestoreCccCampaignGitObjectsInput = Readonly<
  Omit<PreparedCccCampaignGitObjects, "snapshot" | "postObjectSnapshot">
  & { targetRoot: string; signal?: AbortSignal }
>;

export type CccCampaignGitLandingState =
  | "base-clean"
  | "checkout-materialized"
  | "landed-clean";

export type CccCampaignGitCasResult =
  | Readonly<{ advanced: true; ref: string; previous: string; current: string }>
  | Readonly<{ advanced: false; reason: "stale-ref"; ref: string; expected: string; observed: string }>;

export class CccCampaignGitObjectsError extends Error {
  public readonly code = "CCC_CAMPAIGN_GIT_OBJECTS_REFUSED";

  public constructor(message: string) {
    super(message);
    this.name = "CccCampaignGitObjectsError";
  }
}

function requireCanonicalObjectId(value: string, label: string): string {
  if (!OBJECT_ID_PATTERN.test(value)) {
    throw new CccCampaignGitObjectsError(`CCC campaign ${label} is not a canonical Git object id`);
  }
  return value;
}

function requireRef(value: string, label: string): string {
  if (!REF_PATTERN.test(value) || value.includes("..") || value.endsWith("/") || value.includes("//")) {
    throw new CccCampaignGitObjectsError(`CCC campaign ${label} is not an exact refs/heads ref`);
  }
  return value;
}

function validateIdentity(identity: CccCampaignGitCommitIdentity): void {
  const parsedTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(identity.timestamp)
    ? new Date(identity.timestamp)
    : null;
  const canonicalTimestamp = parsedTimestamp && !Number.isNaN(parsedTimestamp.getTime())
    ? parsedTimestamp.toISOString().replace(".000Z", "Z")
    : null;
  if (
    identity.name.length === 0
    || identity.name.length > 128
    || identity.name !== identity.name.trim()
    || !PRINTABLE_ASCII_PATTERN.test(identity.name)
    || identity.email.length === 0
    || identity.email.length > 254
    || identity.email !== identity.email.trim()
    || !PRINTABLE_ASCII_PATTERN.test(identity.email)
    || !/^[^\s@<>]+@[^\s@<>]+$/u.test(identity.email)
    || canonicalTimestamp !== identity.timestamp
  ) {
    throw new CccCampaignGitObjectsError("CCC campaign commit identity or timestamp is not bounded and canonical");
  }
}

function validateMessage(message: string): void {
  if (
    message.length === 0
    || message.length > 4096
    || message !== message.trim()
    || hasAsciiControl(message)
  ) {
    throw new CccCampaignGitObjectsError("CCC campaign commit message is not bounded and canonical");
  }
}

function isMissingPathError(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === "object"
    && ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? ""),
  );
}

function hasAsciiControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function pathIsInsideRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function decodePath(pathBytes: Buffer): string {
  let value: string;
  try {
    value = new TextDecoder("utf-8", { fatal: true }).decode(pathBytes);
  } catch {
    throw new CccCampaignGitObjectsError("CCC campaign refused a mutation path that is not canonical UTF-8");
  }
  if (value.length === 0 || value.includes("\0") || isAbsolute(value)) {
    throw new CccCampaignGitObjectsError("CCC campaign refused an invalid mutation path");
  }
  const normalized = relative(".", value);
  if (normalized === ".." || normalized.startsWith(`..${sep}`) || normalized !== value) {
    throw new CccCampaignGitObjectsError("CCC campaign refused a non-normal mutation path");
  }
  return value;
}

function splitNullRecords(output: Buffer, label: string): Buffer[] {
  if (output.length === 0) return [];
  if (output[output.length - 1] !== 0) {
    throw new CccCampaignGitObjectsError(`CCC campaign ${label} output was not NUL terminated`);
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

async function runGitBuffer(
  snapshot: Pick<CccCampaignLocalGitSnapshot, "gitBinary" | "targetRoot">,
  args: readonly string[],
  options: Readonly<{ input?: string; identity?: CccCampaignGitCommitIdentity; signal?: AbortSignal }> = {},
): Promise<Buffer> {
  options.signal?.throwIfAborted();
  try {
    return await runControlledCccCampaignGit(snapshot, args, {
      signal: options.signal,
      stdin: options.input,
      env: options.identity
        ? {
          GIT_AUTHOR_NAME: options.identity.name,
          GIT_AUTHOR_EMAIL: options.identity.email,
          GIT_AUTHOR_DATE: options.identity.timestamp,
          GIT_COMMITTER_NAME: options.identity.name,
          GIT_COMMITTER_EMAIL: options.identity.email,
          GIT_COMMITTER_DATE: options.identity.timestamp,
        }
        : undefined,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CccCampaignGitObjectsError(`CCC campaign Git command refused: ${args[0] ?? "git"} ${message}`);
  }
}

async function runGitText(
  snapshot: Pick<CccCampaignLocalGitSnapshot, "gitBinary" | "targetRoot">,
  args: readonly string[],
  options: Readonly<{ input?: string; identity?: CccCampaignGitCommitIdentity; signal?: AbortSignal }> = {},
): Promise<string> {
  const output = await runGitBuffer(snapshot, args, options);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(output).trim();
  } catch {
    throw new CccCampaignGitObjectsError("CCC campaign refused non-UTF-8 Git output");
  }
}

async function resolveCommit(snapshot: CccCampaignLocalGitSnapshot, ref: string, signal?: AbortSignal): Promise<string> {
  return requireCanonicalObjectId(
    await runGitText(snapshot, ["rev-parse", "--verify", `${ref}^{commit}`], { signal }),
    ref,
  );
}

async function listRepositoryObjectIds(
  snapshot: Pick<CccCampaignLocalGitSnapshot, "gitBinary" | "targetRoot">,
  signal?: AbortSignal,
): Promise<readonly string[]> {
  const output = await runGitBuffer(
    snapshot,
    ["cat-file", "--batch-all-objects", "--batch-check=%(objectname)"],
    { signal },
  );
  const ids = new Set<string>();
  const decoded = new TextDecoder("utf-8", { fatal: true }).decode(output);
  for (const line of decoded.split("\n")) {
    if (line.length === 0) continue;
    ids.add(requireCanonicalObjectId(line, "object baseline entry"));
  }
  return Object.freeze([...ids].sort());
}

function difference(left: readonly string[], right: readonly string[]): string[] {
  const rightSet = new Set(right);
  return left.filter((value) => !rightSet.has(value));
}

async function reachableGeneratedObjectIds(
  snapshot: CccCampaignLocalGitSnapshot,
  treeObject: string,
  commitObject: string,
  signal?: AbortSignal,
): Promise<readonly string[]> {
  const ids = new Set<string>([treeObject, commitObject]);
  const output = await runGitBuffer(snapshot, ["ls-tree", "-r", "-t", "-z", "--full-tree", treeObject], { signal });
  for (const record of splitNullRecords(output, "generated tree")) {
    const separator = record.indexOf(0x09);
    if (separator < 0) {
      throw new CccCampaignGitObjectsError("CCC campaign refused malformed generated tree output");
    }
    const header = record.subarray(0, separator).toString("ascii");
    const match = /^[0-7]{6} (tree|blob) ([0-9a-f]{40}|[0-9a-f]{64})$/u.exec(header);
    if (!match) {
      throw new CccCampaignGitObjectsError("CCC campaign refused malformed generated tree entry");
    }
    if (match[1] === "tree") ids.add(match[2]!);
  }
  return Object.freeze([...ids].sort());
}

type WorktreeRecord = Readonly<{
  path: string;
  head: string;
  branch: string | null;
}>;

async function parseWorktrees(snapshot: CccCampaignLocalGitSnapshot, signal?: AbortSignal): Promise<readonly WorktreeRecord[]> {
  const output = await runGitBuffer(snapshot, ["worktree", "list", "--porcelain", "-z"], { signal });
  const worktrees: WorktreeRecord[] = [];
  let path: string | null = null;
  let head: string | null = null;
  let branch: string | null = null;
  const finish = (): void => {
    if (path === null && head === null && branch === null) return;
    if (path === null || head === null) {
      throw new CccCampaignGitObjectsError("CCC campaign refused malformed worktree topology");
    }
    worktrees.push(Object.freeze({
      path,
      head: requireCanonicalObjectId(head, "worktree HEAD"),
      branch,
    }));
    path = null;
    head = null;
    branch = null;
  };
  for (const record of splitNullRecords(output, "worktree list")) {
    if (record.length === 0) {
      finish();
      continue;
    }
    let line: string;
    try {
      line = new TextDecoder("utf-8", { fatal: true }).decode(record);
    } catch {
      throw new CccCampaignGitObjectsError("CCC campaign refused non-UTF-8 worktree topology");
    }
    if (line.startsWith("worktree ")) {
      if (path !== null) {
        throw new CccCampaignGitObjectsError("CCC campaign refused duplicate worktree path fields");
      }
      path = line.slice("worktree ".length);
    } else if (line.startsWith("HEAD ")) {
      if (head !== null) {
        throw new CccCampaignGitObjectsError("CCC campaign refused duplicate worktree HEAD fields");
      }
      head = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ")) {
      if (branch !== null) {
        throw new CccCampaignGitObjectsError("CCC campaign refused duplicate worktree branch fields");
      }
      branch = requireRef(line.slice("branch ".length), "worktree branch");
    } else if (
      line !== "detached"
      && line !== "bare"
      && !line.startsWith("locked")
      && !line.startsWith("prunable")
    ) {
      throw new CccCampaignGitObjectsError("CCC campaign refused unknown worktree topology");
    }
  }
  finish();
  return Object.freeze(worktrees);
}

async function inspectTargetCheckout(
  snapshot: CccCampaignLocalGitSnapshot,
  targetRef: string,
  signal?: AbortSignal,
): Promise<CccCampaignTargetCheckout> {
  const worktrees = await parseWorktrees(snapshot, signal);
  const targetRootEntries: WorktreeRecord[] = [];
  for (const worktree of worktrees) {
    let physicalPath: string;
    try {
      physicalPath = await realpath(worktree.path);
    } catch {
      throw new CccCampaignGitObjectsError("CCC campaign could not resolve a registered worktree path");
    }
    if (physicalPath === snapshot.targetRoot) targetRootEntries.push(worktree);
  }
  if (targetRootEntries.length !== 1) {
    throw new CccCampaignGitObjectsError("CCC campaign target root is not exactly one registered worktree");
  }
  const targetEntries = worktrees.filter(({ branch }) => branch === targetRef);
  if (targetEntries.length > 1) {
    throw new CccCampaignGitObjectsError(`CCC campaign target ref ${targetRef} is checked out more than once`);
  }
  if (targetEntries.length === 1) {
    let physicalPath: string;
    try {
      physicalPath = await realpath(targetEntries[0]!.path);
    } catch {
      throw new CccCampaignGitObjectsError("CCC campaign could not resolve the target-ref worktree path");
    }
    if (physicalPath !== snapshot.targetRoot) {
      throw new CccCampaignGitObjectsError(`CCC campaign target ref ${targetRef} is checked out in a sibling worktree`);
    }
    return Object.freeze({ mode: "target-root" as const, path: physicalPath });
  }
  return Object.freeze({
    mode: "not-checked-out" as const,
    rootBranch: targetRootEntries[0]!.branch,
  });
}

function targetCheckoutsEqual(
  left: CccCampaignTargetCheckout,
  right: CccCampaignTargetCheckout,
): boolean {
  return left.mode === right.mode
    && (
      left.mode === "target-root"
        ? right.mode === "target-root" && left.path === right.path
        : right.mode === "not-checked-out" && left.rootBranch === right.rootBranch
    );
}

async function assertTargetCheckoutMatches(
  snapshot: CccCampaignLocalGitSnapshot,
  targetRef: string,
  expected: CccCampaignTargetCheckout,
  signal?: AbortSignal,
): Promise<void> {
  const observed = await inspectTargetCheckout(snapshot, targetRef, signal);
  if (!targetCheckoutsEqual(observed, expected)) {
    throw new CccCampaignGitObjectsError("CCC campaign target checkout topology drifted");
  }
}

async function mutationPaths(snapshot: CccCampaignLocalGitSnapshot, expectedTarget: string, sourceCommit: string, signal?: AbortSignal): Promise<readonly string[]> {
  const output = await runGitBuffer(snapshot, ["diff-tree", "-r", "-z", "--no-commit-id", "--name-status", expectedTarget, sourceCommit], { signal });
  const records = splitNullRecords(output, "mutation path");
  const paths: string[] = [];
  for (let index = 0; index < records.length; index += 2) {
    const status = records[index]?.toString("ascii");
    const pathRecord = records[index + 1];
    if (!status || !pathRecord) {
      throw new CccCampaignGitObjectsError("CCC campaign refused malformed mutation path status output");
    }
    if (status === "D") {
      throw new CccCampaignGitObjectsError("CCC campaign refused delete mutations in object preparation");
    }
    if (!/^[AMT]$/u.test(status)) {
      throw new CccCampaignGitObjectsError(`CCC campaign refused unsupported mutation status ${status}`);
    }
    paths.push(decodePath(pathRecord));
  }
  return Object.freeze([...new Set(paths)].sort());
}

async function assertNoTargetOverlap(snapshot: CccCampaignLocalGitSnapshot, expectedBaseObject: string, expectedTarget: string, sourcePaths: readonly string[], signal?: AbortSignal): Promise<void> {
  const output = await runGitBuffer(snapshot, ["diff-tree", "-r", "-z", "--no-commit-id", "--name-only", expectedBaseObject, expectedTarget], { signal });
  const targetPaths = new Set(splitNullRecords(output, "target mutation path").map((record) => decodePath(record)));
  for (const path of sourcePaths) {
    if (targetPaths.has(path)) {
      throw new CccCampaignGitObjectsError(`CCC campaign refused source/target overlap at ${path}`);
    }
  }
}

async function normalizeAdmittedRoots(targetRoot: string, roots: readonly string[]): Promise<readonly string[]> {
  if (roots.length === 0) {
    throw new CccCampaignGitObjectsError("CCC campaign requires at least one admitted write root");
  }
  const normalized: string[] = [];
  for (const root of roots) {
    if (!isAbsolute(root)) {
      throw new CccCampaignGitObjectsError("CCC campaign admitted write root must be absolute");
    }
    const lexical = resolve(root);
    const nearestExisting = await nearestExistingAncestor(lexical);
    const physical = await realpath(nearestExisting);
    const missingSuffix = relative(nearestExisting, lexical);
    const canonical = resolve(physical, missingSuffix);
    if (!pathIsInsideRoot(targetRoot, physical) || !pathIsInsideRoot(targetRoot, canonical)) {
      throw new CccCampaignGitObjectsError("CCC campaign admitted write root must resolve inside the target root");
    }
    normalized.push(canonical);
  }
  return Object.freeze([...new Set(normalized)].sort());
}

async function nearestExistingAncestor(absolutePath: string): Promise<string> {
  let current = absolutePath;
  while (current !== dirname(current)) {
    try {
      await lstat(current);
      return current;
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw new CccCampaignGitObjectsError(`CCC campaign could not inspect path ancestor ${current}`);
      }
      current = dirname(current);
    }
  }
  try {
    await lstat(current);
    return current;
  } catch (error) {
    if (!isMissingPathError(error)) {
      throw new CccCampaignGitObjectsError(`CCC campaign could not inspect path ancestor ${current}`);
    }
  }
  throw new CccCampaignGitObjectsError("CCC campaign path has no existing ancestor");
}

async function assertNoSymlinkAncestors(targetRoot: string, absolutePath: string): Promise<void> {
  let current = dirname(absolutePath);
  while (pathIsInsideRoot(targetRoot, current) && current !== targetRoot) {
    try {
      const entry = await lstat(current);
      if (entry.isSymbolicLink()) {
        throw new CccCampaignGitObjectsError(`CCC campaign refused symlink ancestor ${current}`);
      }
    } catch (error) {
      if (error instanceof CccCampaignGitObjectsError) throw error;
      if (!isMissingPathError(error)) {
        throw new CccCampaignGitObjectsError(`CCC campaign could not inspect symlink ancestor ${current}`);
      }
    }
    current = dirname(current);
  }
}

async function assertPathsAdmitted(targetRoot: string, paths: readonly string[], admittedRoots: readonly string[]): Promise<void> {
  for (const path of paths) {
    const absolutePath = resolve(targetRoot, path);
    if (!pathIsInsideRoot(targetRoot, absolutePath)) {
      throw new CccCampaignGitObjectsError(`CCC campaign refused path outside target root: ${path}`);
    }
    await assertNoSymlinkAncestors(targetRoot, absolutePath);
    const lexicalAdmittedRoot = admittedRoots.find((root) => absolutePath === root || pathIsInsideRoot(root, absolutePath));
    if (!lexicalAdmittedRoot) {
      throw new CccCampaignGitObjectsError(`CCC campaign refused undeclared path outside admitted roots: ${path}`);
    }
    const nearestExisting = await nearestExistingAncestor(dirname(absolutePath));
    const physicalParent = await realpath(nearestExisting);
    if (!pathIsInsideRoot(targetRoot, physicalParent)) {
      throw new CccCampaignGitObjectsError(`CCC campaign refused undeclared path outside admitted roots: ${path}`);
    }
  }
}

async function assertSourceTreeSafe(snapshot: CccCampaignLocalGitSnapshot, sourceCommit: string, paths: readonly string[], signal?: AbortSignal): Promise<void> {
  for (const path of paths) {
    const output = await runGitBuffer(snapshot, ["ls-tree", "-z", "--full-tree", sourceCommit, "--", path], { signal });
    const records = splitNullRecords(output, "source tree entry");
    if (records.length !== 1) {
      throw new CccCampaignGitObjectsError(`CCC campaign refused missing or ambiguous source tree entry: ${path}`);
    }
    const separator = records[0]!.indexOf(0x09);
    if (separator < 0) {
      throw new CccCampaignGitObjectsError("CCC campaign refused malformed source tree entry");
    }
    const header = records[0]!.subarray(0, separator).toString("ascii");
    if (header.startsWith("120000 ") || header.startsWith("160000 ") || header.includes(" commit ")) {
      throw new CccCampaignGitObjectsError(`CCC campaign refused symlink or submodule mutation: ${path}`);
    }
  }
}

async function assertGeneratedObjects(prepared: PreparedCccCampaignGitObjects, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const currentObjects = await listRepositoryObjectIds(prepared.postObjectSnapshot, signal);
  const newObjects = difference(currentObjects, prepared.objectBaselineBefore);
  const allowed = new Set(prepared.expectedGeneratedObjectIds);
  const extra = newObjects.filter((value) => !allowed.has(value));
  if (extra.length > 0) {
    throw new CccCampaignGitObjectsError("CCC campaign refused unrelated object drift outside the self-written baseline");
  }
  for (const objectId of prepared.expectedGeneratedObjectIds) {
    await runGitText(prepared.postObjectSnapshot, ["cat-file", "-e", objectId], { signal });
  }
  await runGitText(prepared.postObjectSnapshot, ["cat-file", "-e", `${prepared.treeObject}^{tree}`], { signal });
  await runGitText(prepared.postObjectSnapshot, ["cat-file", "-e", `${prepared.commitObject}^{commit}`], { signal });
}

function stableCustodyIdentity(
  snapshot: CccCampaignLocalGitSnapshot,
): CccCampaignGitCustodyIdentity {
  const stableStat = (
    value: CccCampaignLocalGitSnapshot["physicalIdentity"]["targetRoot"],
  ): StableStatIdentity => Object.freeze({
    path: value.path,
    dev: value.dev.toString(10),
    ino: value.ino.toString(10),
    mode: value.mode.toString(10),
    birthtimeNs: value.birthtimeNs.toString(10),
  });
  const identity = snapshot.physicalIdentity;
  return Object.freeze({
    targetRoot: stableStat(identity.targetRoot),
    gitControlPath: stableStat(identity.gitControlPath),
    gitDir: stableStat(identity.gitDir),
    gitCommonDir: stableStat(identity.gitCommonDir),
    gitBinary: stableStat(identity.gitBinary),
    indexPath: identity.indexPath.path,
  });
}

function stableCustodyIdentityMatches(
  expected: CccCampaignGitCustodyIdentity,
  snapshot: CccCampaignLocalGitSnapshot,
): boolean {
  const observed = stableCustodyIdentity(snapshot);
  const statMatches = (left: StableStatIdentity, right: StableStatIdentity): boolean =>
    left.path === right.path
    && left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.birthtimeNs === right.birthtimeNs;
  return statMatches(expected.targetRoot, observed.targetRoot)
    && statMatches(expected.gitControlPath, observed.gitControlPath)
    && statMatches(expected.gitDir, observed.gitDir)
    && statMatches(expected.gitCommonDir, observed.gitCommonDir)
    && statMatches(expected.gitBinary, observed.gitBinary)
    && expected.indexPath === observed.indexPath;
}

function stableCustodyIdentityMismatches(
  expected: CccCampaignGitCustodyIdentity,
  snapshot: CccCampaignLocalGitSnapshot,
): readonly string[] {
  const observed = stableCustodyIdentity(snapshot);
  const mismatches: string[] = [];
  for (const key of [
    "targetRoot",
    "gitControlPath",
    "gitDir",
    "gitCommonDir",
    "gitBinary",
    "indexPath",
  ] as const) {
    const matches = key === "indexPath"
      ? expected[key] === observed[key]
      : expected[key].path === observed[key].path
        && expected[key].dev === observed[key].dev
        && expected[key].ino === observed[key].ino
        && expected[key].mode === observed[key].mode
        && expected[key].birthtimeNs === observed[key].birthtimeNs;
    if (!matches) {
      mismatches.push(key);
    }
  }
  return Object.freeze(mismatches);
}

async function inspectExactLandingSnapshot(
  prepared: PreparedCccCampaignGitObjects,
  expectedHeadObject: string,
  expectedCheckoutObject: string,
  signal?: AbortSignal,
): Promise<CccCampaignLocalGitSnapshot> {
  const snapshot = await inspectCccCampaignLocalGit({
    targetRoot: prepared.snapshot.targetRoot,
    expectedBaseObject: prepared.expectedTarget,
    expectedHeadObject,
    expectedCheckoutObject,
  }, signal);
  if (!stableCustodyIdentityMatches(prepared.custodyIdentity, snapshot)) {
    throw new CccCampaignGitObjectsError("CCC campaign Git custody identity drifted during landing");
  }
  await assertTargetCheckoutMatches(snapshot, prepared.targetRef, prepared.targetCheckout, signal);
  const source = await resolveCommit(snapshot, prepared.sourceRef, signal);
  if (source !== prepared.sourceCommit) {
    throw new CccCampaignGitObjectsError("CCC campaign source ref drifted during landing");
  }
  const paths = await mutationPaths(snapshot, prepared.expectedTarget, prepared.sourceCommit, signal);
  if (paths.length !== prepared.mutationPaths.length || paths.some((value, index) => value !== prepared.mutationPaths[index])) {
    throw new CccCampaignGitObjectsError("CCC campaign mutation path set drifted during landing");
  }
  await assertPathsAdmitted(snapshot.targetRoot, paths, prepared.admittedWriteRoots);
  await assertSourceTreeSafe(snapshot, prepared.sourceCommit, paths, signal);
  await assertGeneratedObjects(prepared, signal);
  return snapshot;
}

async function tryInspectExactLandingSnapshot(
  prepared: PreparedCccCampaignGitObjects,
  expectedHeadObject: string,
  expectedCheckoutObject: string,
  signal?: AbortSignal,
): Promise<CccCampaignLocalGitSnapshot | null> {
  try {
    return await inspectExactLandingSnapshot(
      prepared,
      expectedHeadObject,
      expectedCheckoutObject,
      signal,
    );
  } catch (error) {
    if (signal?.aborted) signal.throwIfAborted();
    if (error instanceof Error && error.name === "AbortError") throw error;
    return null;
  }
}

async function inspectLandingStateWithSnapshot(
  prepared: PreparedCccCampaignGitObjects,
  signal?: AbortSignal,
): Promise<Readonly<{
  state: CccCampaignGitLandingState;
  snapshot: CccCampaignLocalGitSnapshot;
}>> {
  const target = await resolveCommit(prepared.postObjectSnapshot, prepared.targetRef, signal);
  if (target !== prepared.expectedTarget && target !== prepared.commitObject) {
    throw new CccCampaignGitObjectsError("CCC campaign target ref drifted to a foreign value during landing");
  }
  if (prepared.targetCheckout.mode === "not-checked-out") {
    const snapshot = await inspectExactLandingSnapshot(
      prepared,
      prepared.expectedTarget,
      prepared.expectedTarget,
      signal,
    );
    return Object.freeze({
      state: target === prepared.expectedTarget ? "base-clean" as const : "landed-clean" as const,
      snapshot,
    });
  }
  if (target === prepared.commitObject) {
    return Object.freeze({
      state: "landed-clean" as const,
      snapshot: await inspectExactLandingSnapshot(
        prepared,
        prepared.commitObject,
        prepared.commitObject,
        signal,
      ),
    });
  }
  const baseSnapshot = await tryInspectExactLandingSnapshot(
    prepared,
    prepared.expectedTarget,
    prepared.expectedTarget,
    signal,
  );
  if (baseSnapshot) {
    return Object.freeze({ state: "base-clean" as const, snapshot: baseSnapshot });
  }
  const materializedSnapshot = await tryInspectExactLandingSnapshot(
    prepared,
    prepared.expectedTarget,
    prepared.commitObject,
    signal,
  );
  if (materializedSnapshot) {
    return Object.freeze({
      state: "checkout-materialized" as const,
      snapshot: materializedSnapshot,
    });
  }
  throw new CccCampaignGitObjectsError(
    "CCC campaign checked-out target is in a mixed or foreign state; manual recovery is required",
  );
}

async function recheckPreparedFields(prepared: PreparedCccCampaignGitObjects, signal?: AbortSignal): Promise<void> {
  const admissionSnapshot = await inspectCccCampaignLocalGit({
    targetRoot: prepared.snapshot.targetRoot,
    expectedBaseObject: prepared.expectedTarget,
  }, signal);
  if (
    admissionSnapshot.targetRoot !== prepared.snapshot.targetRoot
    || admissionSnapshot.gitDir !== prepared.snapshot.gitDir
    || admissionSnapshot.gitCommonDir !== prepared.snapshot.gitCommonDir
    || admissionSnapshot.gitBinary !== prepared.snapshot.gitBinary
    || admissionSnapshot.head !== prepared.expectedTarget
  ) {
    throw new CccCampaignGitObjectsError("CCC campaign admission identity drifted before object CAS");
  }
  const snapshot = await recheckCccCampaignLocalGit(prepared.postObjectSnapshot, signal);
  const target = await resolveCommit(snapshot, prepared.targetRef, signal);
  const source = await resolveCommit(snapshot, prepared.sourceRef, signal);
  if (target !== prepared.expectedTarget && target !== prepared.commitObject) {
    throw new CccCampaignGitObjectsError("CCC campaign target ref drifted to a foreign value before object CAS");
  }
  if (source !== prepared.sourceCommit) {
    throw new CccCampaignGitObjectsError("CCC campaign source ref drifted before object CAS");
  }
  if (snapshot.head !== prepared.expectedTarget) {
    throw new CccCampaignGitObjectsError("CCC campaign HEAD drifted before object CAS");
  }
  await assertTargetCheckoutMatches(snapshot, prepared.targetRef, prepared.targetCheckout, signal);
  const paths = await mutationPaths(snapshot, prepared.expectedTarget, prepared.sourceCommit, signal);
  if (paths.length !== prepared.mutationPaths.length || paths.some((value, index) => value !== prepared.mutationPaths[index])) {
    throw new CccCampaignGitObjectsError("CCC campaign mutation path set drifted before object CAS");
  }
  await assertPathsAdmitted(snapshot.targetRoot, paths, prepared.admittedWriteRoots);
  await assertSourceTreeSafe(snapshot, prepared.sourceCommit, paths, signal);
  await assertGeneratedObjects(prepared, signal);
}

export async function prepareCccCampaignGitObjects(
  input: PrepareCccCampaignGitObjectsInput,
): Promise<PreparedCccCampaignGitObjects> {
  input.signal?.throwIfAborted();
  validateIdentity(input.identity);
  validateMessage(input.message);
  const targetRef = requireRef(input.targetRef, "target ref");
  const sourceRef = requireRef(input.sourceRef, "source ref");
  if (sourceRef === targetRef) {
    throw new CccCampaignGitObjectsError("CCC campaign source ref must differ from target ref");
  }
  const snapshot = await inspectCccCampaignLocalGit({
    targetRoot: input.targetRoot,
    expectedBaseObject: input.expectedBaseObject,
  }, input.signal);
  const expectedBaseObject = requireCanonicalObjectId(input.expectedBaseObject, "expected base");
  const admittedWriteRoots = await normalizeAdmittedRoots(snapshot.targetRoot, input.admittedWriteRoots);
  const observedTarget = await resolveCommit(snapshot, targetRef, input.signal);
  const sourceCommit = await resolveCommit(snapshot, sourceRef, input.signal);
  if (snapshot.head !== expectedBaseObject) {
    throw new CccCampaignGitObjectsError("CCC campaign HEAD does not match expected base");
  }
  try {
    await runGitText(snapshot, ["merge-base", "--is-ancestor", expectedBaseObject, sourceCommit], { signal: input.signal });
  } catch {
    throw new CccCampaignGitObjectsError("CCC campaign source ref does not descend from target ref");
  }
  const targetCheckout = await inspectTargetCheckout(snapshot, targetRef, input.signal);
  const paths = await mutationPaths(snapshot, expectedBaseObject, sourceCommit, input.signal);
  if (paths.length === 0) {
    throw new CccCampaignGitObjectsError("CCC campaign source ref has no mutation paths");
  }
  await assertPathsAdmitted(snapshot.targetRoot, paths, admittedWriteRoots);
  await assertSourceTreeSafe(snapshot, sourceCommit, paths, input.signal);

  const objectBaselineBefore = await listRepositoryObjectIds(snapshot, input.signal);
  let treeObject: string;
  try {
    treeObject = requireCanonicalObjectId(
      await runGitText(snapshot, ["merge-tree", "--write-tree", expectedBaseObject, sourceCommit], { signal: input.signal }),
      "merge-tree output",
    );
  } catch (error) {
    if (error instanceof CccCampaignGitObjectsError) {
      throw new CccCampaignGitObjectsError(`CCC campaign manual conflict or merge-tree refusal: ${error.message}`);
    }
    throw error;
  }
  const commitObject = requireCanonicalObjectId(
    await runGitText(snapshot, ["commit-tree", treeObject, "-p", expectedBaseObject], {
      input: `${input.message}\n`,
      identity: input.identity,
      signal: input.signal,
    }),
    "commit-tree output",
  );
  if (observedTarget !== expectedBaseObject && observedTarget !== commitObject) {
    await assertNoTargetOverlap(snapshot, expectedBaseObject, observedTarget, paths, input.signal);
    throw new CccCampaignGitObjectsError("CCC campaign target ref is neither expected base nor exact deterministic commit");
  }
  const objectBaselineAfter = await listRepositoryObjectIds(snapshot, input.signal);
  const expectedGeneratedObjectIds = await reachableGeneratedObjectIds(snapshot, treeObject, commitObject, input.signal);
  const observedObjectDelta = difference(objectBaselineAfter, objectBaselineBefore);
  const generatedSet = new Set(expectedGeneratedObjectIds);
  const extraObjectDelta = observedObjectDelta.filter((objectId) => !generatedSet.has(objectId));
  if (extraObjectDelta.length > 0) {
    throw new CccCampaignGitObjectsError("CCC campaign object preparation wrote unrelated objects");
  }
  if (!expectedGeneratedObjectIds.includes(treeObject) || !expectedGeneratedObjectIds.includes(commitObject)) {
    throw new CccCampaignGitObjectsError("CCC campaign self-write baseline does not contain the generated tree and commit");
  }
  const postObjectSnapshot = await inspectCccCampaignLocalGit({
    targetRoot: snapshot.targetRoot,
    expectedBaseObject,
  }, input.signal);
  const prepared: PreparedCccCampaignGitObjects = Object.freeze({
    snapshot,
    targetRef,
    sourceRef,
    expectedTarget: expectedBaseObject,
    sourceCommit,
    treeObject,
    commitObject,
    mutationPaths: paths,
    admittedWriteRoots,
    identity: Object.freeze({ ...input.identity }),
    message: input.message,
    postObjectSnapshot,
    objectBaselineBefore,
    expectedGeneratedObjectIds,
    targetCheckout,
    custodyIdentity: stableCustodyIdentity(postObjectSnapshot),
  });
  return prepared;
}

export async function restoreCccCampaignGitObjects(
  input: RestoreCccCampaignGitObjectsInput,
): Promise<PreparedCccCampaignGitObjects> {
  input.signal?.throwIfAborted();
  validateIdentity(input.identity);
  validateMessage(input.message);
  const expectedTarget = requireCanonicalObjectId(input.expectedTarget, "restored expected target");
  const sourceCommit = requireCanonicalObjectId(input.sourceCommit, "restored source commit");
  const treeObject = requireCanonicalObjectId(input.treeObject, "restored tree object");
  const commitObject = requireCanonicalObjectId(input.commitObject, "restored commit object");
  const sourceRef = requireRef(input.sourceRef, "restored source ref");
  const targetRef = requireRef(input.targetRef, "restored target ref");
  if (sourceRef === targetRef) {
    throw new CccCampaignGitObjectsError("CCC campaign restored source ref must differ from target ref");
  }
  if (
    !input.objectBaselineBefore.every((value) => OBJECT_ID_PATTERN.test(value))
    || !input.expectedGeneratedObjectIds.every((value) => OBJECT_ID_PATTERN.test(value))
  ) {
    throw new CccCampaignGitObjectsError("CCC campaign restored object baseline is malformed");
  }
  const admittedWriteRoots = await normalizeAdmittedRoots(
    await realpath(input.targetRoot),
    input.admittedWriteRoots,
  );
  if (JSON.stringify(admittedWriteRoots) !== JSON.stringify(input.admittedWriteRoots)) {
    throw new CccCampaignGitObjectsError("CCC campaign restored admitted write roots are not canonical");
  }

  const candidates = input.targetCheckout.mode === "target-root"
    ? [
      [expectedTarget, expectedTarget] as const,
      [expectedTarget, commitObject] as const,
      [commitObject, commitObject] as const,
    ]
    : [[expectedTarget, expectedTarget] as const];
  const errors: string[] = [];
  for (const [expectedHeadObject, expectedCheckoutObject] of candidates) {
    let snapshot: CccCampaignLocalGitSnapshot;
    try {
      snapshot = await inspectCccCampaignLocalGit({
        targetRoot: input.targetRoot,
        expectedBaseObject: expectedTarget,
        expectedHeadObject,
        expectedCheckoutObject,
      }, input.signal);
    } catch (error) {
      if (input.signal?.aborted) input.signal.throwIfAborted();
      errors.push(error instanceof Error ? error.message : String(error));
      continue;
    }
    const prepared: PreparedCccCampaignGitObjects = Object.freeze({
      snapshot,
      targetRef,
      sourceRef,
      expectedTarget,
      sourceCommit,
      treeObject,
      commitObject,
      mutationPaths: Object.freeze([...input.mutationPaths]),
      admittedWriteRoots,
      identity: Object.freeze({ ...input.identity }),
      message: input.message,
      postObjectSnapshot: snapshot,
      objectBaselineBefore: Object.freeze([...input.objectBaselineBefore]),
      expectedGeneratedObjectIds: Object.freeze([...input.expectedGeneratedObjectIds]),
      targetCheckout: Object.freeze({ ...input.targetCheckout }) as CccCampaignTargetCheckout,
      custodyIdentity: input.custodyIdentity,
    });
    try {
      if (!stableCustodyIdentityMatches(input.custodyIdentity, snapshot)) {
        throw new CccCampaignGitObjectsError(
          `CCC campaign restored Git custody identity drifted at ${
            stableCustodyIdentityMismatches(input.custodyIdentity, snapshot).join(",")
          }`,
        );
      }
      await assertTargetCheckoutMatches(snapshot, targetRef, input.targetCheckout, input.signal);
      if (await resolveCommit(snapshot, sourceRef, input.signal) !== sourceCommit) {
        throw new CccCampaignGitObjectsError("CCC campaign restored source ref drifted");
      }
      const restoredTree = requireCanonicalObjectId(
        await runGitText(
          snapshot,
          ["merge-tree", "--write-tree", expectedTarget, sourceCommit],
          { signal: input.signal },
        ),
        "restored merge tree",
      );
      if (restoredTree !== treeObject) {
        throw new CccCampaignGitObjectsError("CCC campaign restored deterministic tree drifted");
      }
      const restoredCommit = requireCanonicalObjectId(
        await runGitText(snapshot, ["commit-tree", treeObject, "-p", expectedTarget], {
          input: `${input.message}\n`,
          identity: input.identity,
          signal: input.signal,
        }),
        "restored deterministic commit",
      );
      if (restoredCommit !== commitObject) {
        throw new CccCampaignGitObjectsError("CCC campaign restored deterministic commit drifted");
      }
      const paths = await mutationPaths(snapshot, expectedTarget, sourceCommit, input.signal);
      if (
        paths.length !== input.mutationPaths.length
        || paths.some((value, index) => value !== input.mutationPaths[index])
      ) {
        throw new CccCampaignGitObjectsError("CCC campaign restored mutation path set drifted");
      }
      await assertPathsAdmitted(snapshot.targetRoot, paths, admittedWriteRoots);
      await assertSourceTreeSafe(snapshot, sourceCommit, paths, input.signal);
      await assertGeneratedObjects(prepared, input.signal);
      await inspectLandingStateWithSnapshot(prepared, input.signal);
      return prepared;
    } catch (error) {
      if (input.signal?.aborted) input.signal.throwIfAborted();
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  throw new CccCampaignGitObjectsError(
    `CCC campaign could not restore an exact Git landing state; manual recovery is required${
      errors.length > 0 ? `: ${errors.join(" | ")}` : ""
    }`,
  );
}

export async function recheckCccCampaignGitObjects(
  prepared: PreparedCccCampaignGitObjects,
  signal?: AbortSignal,
): Promise<PreparedCccCampaignGitObjects> {
  await recheckPreparedFields(prepared, signal);
  return prepared;
}

export async function inspectCccCampaignGitLandingState(
  prepared: PreparedCccCampaignGitObjects,
  signal?: AbortSignal,
): Promise<CccCampaignGitLandingState> {
  return (await inspectLandingStateWithSnapshot(prepared, signal)).state;
}

export async function materializeCccCampaignGitCheckout(
  prepared: PreparedCccCampaignGitObjects,
  signal?: AbortSignal,
): Promise<CccCampaignGitLandingState> {
  const observed = await inspectLandingStateWithSnapshot(prepared, signal);
  if (prepared.targetCheckout.mode === "not-checked-out" || observed.state !== "base-clean") {
    return observed.state;
  }
  await recheckPreparedFields(prepared, signal);
  try {
    await runGitText(
      prepared.postObjectSnapshot,
      [
        "read-tree",
        "--no-sparse-checkout",
        "-u",
        "-m",
        prepared.expectedTarget,
        prepared.commitObject,
      ],
      { signal },
    );
  } catch (error) {
    const state = await inspectLandingStateWithSnapshot(prepared, signal).catch(() => null);
    if (state?.state === "base-clean") {
      throw new CccCampaignGitObjectsError(
        `CCC campaign checkout materialization was refused without a filesystem effect: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    throw new CccCampaignGitObjectsError(
      "CCC campaign checkout materialization ended in a mixed or uncertain state; manual recovery is required",
    );
  }
  const materialized = await inspectLandingStateWithSnapshot(prepared, signal);
  if (materialized.state !== "checkout-materialized") {
    throw new CccCampaignGitObjectsError(
      "CCC campaign checkout materialization did not produce the exact expected state",
    );
  }
  return materialized.state;
}

export async function casCccCampaignGitRef(
  prepared: PreparedCccCampaignGitObjects,
  signal?: AbortSignal,
): Promise<CccCampaignGitCasResult> {
  const landing = await inspectLandingStateWithSnapshot(prepared, signal);
  if (landing.state === "landed-clean") {
    return Object.freeze({
      advanced: false as const,
      reason: "stale-ref" as const,
      ref: prepared.targetRef,
      expected: prepared.expectedTarget,
      observed: prepared.commitObject,
    });
  }
  if (prepared.targetCheckout.mode === "target-root" && landing.state !== "checkout-materialized") {
    throw new CccCampaignGitObjectsError(
      "CCC campaign checked-out target must be exactly materialized before ref CAS",
    );
  }
  if (prepared.targetCheckout.mode === "not-checked-out") {
    await recheckPreparedFields(prepared, signal);
  }
  try {
    await runGitText(prepared.snapshot, ["update-ref", prepared.targetRef, prepared.commitObject, prepared.expectedTarget], { signal });
    const landed = await inspectLandingStateWithSnapshot(prepared, signal);
    if (landed.state !== "landed-clean") {
      throw new CccCampaignGitObjectsError(
        "CCC campaign ref CAS advanced without an exact landed checkout; manual recovery is required",
      );
    }
    return Object.freeze({
      advanced: true as const,
      ref: prepared.targetRef,
      previous: prepared.expectedTarget,
      current: prepared.commitObject,
    });
  } catch {
    const afterFailure = await resolveCommit(prepared.snapshot, prepared.targetRef, signal);
    if (afterFailure !== prepared.expectedTarget) {
      return Object.freeze({
        advanced: false as const,
        reason: "stale-ref" as const,
        ref: prepared.targetRef,
        expected: prepared.expectedTarget,
        observed: afterFailure,
      });
    }
    throw new CccCampaignGitObjectsError("CCC campaign update-ref CAS was refused without ref movement");
  }
}
