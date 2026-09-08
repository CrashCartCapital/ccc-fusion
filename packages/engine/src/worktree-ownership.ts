import { constants as fsConstants } from "node:fs";
import { execFile as execFileCallback } from "node:child_process";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, resolve } from "node:path";

/** FNXC:WorktreeOwnership 2026-09-07-00:00: Only exact dual v1 markers grant cooperative worktree mutation authority. */

export const WORKTREE_OWNERSHIP_SCHEMA = "fusion.worktree-owner/v1" as const;
export const WORKTREE_OWNERSHIP_OWNER = "ccc-fusion" as const;
export const WORKTREE_OWNERSHIP_MARKER_RELATIVE_PATH = ".fusion/fusion-owner.json" as const;

export type WorktreeOwnershipLifecycle = "creating" | "managed";

export interface EngineMutationAuthority {
  assertHeld(): void;
}

export type WorktreeOwnershipContext = Readonly<{
  projectId: string;
  projectRoot: string;
  engineInstanceId: string;
  mutationAuthority: EngineMutationAuthority;
}>;

export type WorktreeOwnershipCreationReceipt = Readonly<{
  creatingBytes: Buffer;
  adminMarkerPath: string;
  worktreeMarkerPath: string;
}>;

export interface WorktreeOwnershipMarker {
  schema: typeof WORKTREE_OWNERSHIP_SCHEMA;
  owner: typeof WORKTREE_OWNERSHIP_OWNER;
  ownerId: string;
  lifecycle: WorktreeOwnershipLifecycle;
  projectId: string;
  projectRoot: string;
  repositoryCommonDir: string;
  worktreePath: string;
  worktreeGitDir: string;
}

export type WorktreeOwnershipErrorCode =
  | "AUTHORITY_NOT_HELD"
  | "MARKER_ALREADY_EXISTS"
  | "MARKER_PARENT_INVALID"
  | "MARKER_SCHEMA_INVALID"
  | "MARKER_CONTEXT_MISMATCH"
  | "MARKER_WRITE_FAILED"
  | "MARKER_TRANSITION_MISMATCH";

export class WorktreeOwnershipError extends Error {
  constructor(public readonly code: WorktreeOwnershipErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "WorktreeOwnershipError";
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

export interface StrictGitWorktreeInventoryEntry {
  path: string;
  head?: string;
  branch?: string;
  bare?: boolean;
  detached?: boolean;
  locked?: string;
  prunable?: string;
}

export type StrictGitWorktreeInventory =
  | { ok: true; entries: StrictGitWorktreeInventoryEntry[] }
  | { ok: false; code: "GIT_INVENTORY_FAILED" | "GIT_INVENTORY_MALFORMED"; error: Error };

export type WorktreeOwnershipClassification =
  | { kind: "owned-managed"; ownerId: string; marker: WorktreeOwnershipMarker }
  | { kind: "owned-dangling-orphan"; ownerId: string; marker: WorktreeOwnershipMarker }
  | { kind: "foreign-unmarked"; reason: "markers-absent" }
  | { kind: "safe-parked"; reason: string; ownerId?: string }
  | { kind: "ambiguous"; reason: string };

const MARKER_KEYS = [
  "schema",
  "owner",
  "ownerId",
  "lifecycle",
  "projectId",
  "projectRoot",
  "repositoryCommonDir",
  "worktreePath",
  "worktreeGitDir",
] as const;
const LOWERCASE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function schemaError(message: string): never {
  throw new WorktreeOwnershipError("MARKER_SCHEMA_INVALID", message);
}

function assertAbsolute(value: unknown, key: string): asserts value is string {
  if (typeof value !== "string" || !isAbsolute(value)) schemaError(`${key} must be an absolute path`);
}

function assertContext(marker: WorktreeOwnershipMarker, context: WorktreeOwnershipContext): void {
  if (marker.projectId !== context.projectId || marker.projectRoot !== context.projectRoot) {
    throw new WorktreeOwnershipError("MARKER_CONTEXT_MISMATCH", "Ownership marker does not match the active project context");
  }
}

export function createWorktreeOwnershipMarker(input: {
  context: WorktreeOwnershipContext;
  ownerId?: string;
  repositoryCommonDir: string;
  worktreePath: string;
  worktreeGitDir: string;
}): WorktreeOwnershipMarker {
  if ((input as { lifecycle?: unknown }).lifecycle !== undefined) {
    schemaError("lifecycle is controlled by the ownership transition");
  }
  if (typeof input.context.projectId !== "string" || input.context.projectId.length === 0) schemaError("projectId must be non-empty");
  assertAbsolute(input.context.projectRoot, "projectRoot");
  assertAbsolute(input.repositoryCommonDir, "repositoryCommonDir");
  assertAbsolute(input.worktreePath, "worktreePath");
  assertAbsolute(input.worktreeGitDir, "worktreeGitDir");
  const ownerId = input.ownerId ?? randomUUID();
  if (!LOWERCASE_UUID.test(ownerId)) schemaError("ownerId must be a lowercase UUID");
  return {
    schema: WORKTREE_OWNERSHIP_SCHEMA,
    owner: WORKTREE_OWNERSHIP_OWNER,
    ownerId,
    lifecycle: "creating",
    projectId: input.context.projectId,
    projectRoot: input.context.projectRoot,
    repositoryCommonDir: input.repositoryCommonDir,
    worktreePath: input.worktreePath,
    worktreeGitDir: input.worktreeGitDir,
  };
}

export function serializeWorktreeOwnershipMarker(marker: WorktreeOwnershipMarker): Buffer {
  return Buffer.from(`${JSON.stringify(marker, null, 2)}\n`, "utf8");
}

export function parseWorktreeOwnershipMarker(bytes: Uint8Array, context?: WorktreeOwnershipContext): WorktreeOwnershipMarker {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch (error) {
    throw new WorktreeOwnershipError("MARKER_SCHEMA_INVALID", "Ownership marker is not valid JSON", error);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) schemaError("Ownership marker must be an object");
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== MARKER_KEYS.length || keys.some((key) => !MARKER_KEYS.includes(key as typeof MARKER_KEYS[number]))) {
    schemaError("Ownership marker has unknown or missing keys");
  }
  if (record.schema !== WORKTREE_OWNERSHIP_SCHEMA || record.owner !== WORKTREE_OWNERSHIP_OWNER) schemaError("Ownership marker literals are invalid");
  if (typeof record.ownerId !== "string" || !LOWERCASE_UUID.test(record.ownerId)) schemaError("ownerId must be a lowercase UUID");
  if (record.lifecycle !== "creating" && record.lifecycle !== "managed") schemaError("lifecycle must be creating or managed");
  if (typeof record.projectId !== "string" || record.projectId.length === 0) schemaError("projectId must be non-empty");
  assertAbsolute(record.projectRoot, "projectRoot");
  assertAbsolute(record.repositoryCommonDir, "repositoryCommonDir");
  assertAbsolute(record.worktreePath, "worktreePath");
  assertAbsolute(record.worktreeGitDir, "worktreeGitDir");
  const marker: WorktreeOwnershipMarker = {
    schema: WORKTREE_OWNERSHIP_SCHEMA,
    owner: WORKTREE_OWNERSHIP_OWNER,
    ownerId: record.ownerId,
    lifecycle: record.lifecycle,
    projectId: record.projectId,
    projectRoot: record.projectRoot,
    repositoryCommonDir: record.repositoryCommonDir,
    worktreePath: record.worktreePath,
    worktreeGitDir: record.worktreeGitDir,
  };
  if (!serializeWorktreeOwnershipMarker(marker).equals(Buffer.from(bytes))) schemaError("Ownership marker bytes are not canonical");
  if (context) assertContext(marker, context);
  return marker;
}

export type GitInventoryRunner = (cwd: string, args: readonly string[]) => Promise<{ stdout: string | Buffer }>;
const execFile = promisify(execFileCallback);

async function defaultGitRunner(cwd: string, args: readonly string[]): Promise<{ stdout: string | Buffer }> {
  const result = await execFile("git", [...args], { cwd, encoding: "buffer", maxBuffer: 8 * 1024 * 1024 });
  return { stdout: result.stdout };
}

function parseInventory(output: string | Buffer): StrictGitWorktreeInventoryEntry[] {
  const fields = Buffer.from(output).toString("utf8").split("\0");
  const entries: StrictGitWorktreeInventoryEntry[] = [];
  let current: StrictGitWorktreeInventoryEntry | undefined;
  let seen = new Set<string>();
  for (const field of fields) {
    if (field === "") {
      current = undefined;
      seen = new Set();
      continue;
    }
    const separator = field.indexOf(" ");
    const key = separator < 0 ? field : field.slice(0, separator);
    const value = separator < 0 ? "" : field.slice(separator + 1);
    if (key === "worktree") {
      if (current) throw new Error("worktree record is missing a terminator");
      if (!isAbsolute(value)) throw new Error("worktree path is not absolute");
      current = { path: value };
      seen = new Set(["worktree"]);
      entries.push(current);
      continue;
    }
    if (!current) throw new Error("inventory field appeared before worktree");
    if (seen.has(key)) throw new Error(`duplicate inventory field: ${key}`);
    seen.add(key);
    if (key === "HEAD") current.head = value;
    else if (key === "branch") current.branch = value;
    else if (key === "bare") current.bare = true;
    else if (key === "detached") current.detached = true;
    else if (key === "locked") current.locked = value;
    else if (key === "prunable") current.prunable = value;
    else throw new Error(`unknown inventory field: ${key}`);
  }
  return entries;
}

export async function inspectStrictGitWorktreeInventory(repositoryRoot: string, runGit: GitInventoryRunner = defaultGitRunner): Promise<StrictGitWorktreeInventory> {
  try {
    const { stdout } = await runGit(repositoryRoot, ["worktree", "list", "--porcelain", "-z"]);
    try {
      return { ok: true, entries: parseInventory(stdout) };
    } catch (error) {
      return { ok: false, code: "GIT_INVENTORY_MALFORMED", error: error instanceof Error ? error : new Error(String(error)) };
    }
  } catch (error) {
    return { ok: false, code: "GIT_INVENTORY_FAILED", error: error instanceof Error ? error : new Error(String(error)) };
  }
}

function singleGitPath(output: string | Buffer, cwd: string): string {
  const value = Buffer.from(output).toString("utf8").trim();
  if (!value || value.includes("\n") || value.includes("\0")) {
    throw new Error("Git path probe returned an invalid value");
  }
  return isAbsolute(value) ? resolve(value) : resolve(cwd, value);
}

function comparableWorktreePath(path: string): string {
  const resolved = resolve(path);
  return resolved.startsWith("/private/var/") ? resolved.slice("/private".length) : resolved;
}

/**
 * Build every input to the strict classifier from live Git state. Any failed
 * or malformed probe returns an ambiguous classification, so maintenance can
 * retain the path instead of guessing ownership.
 */
export async function inspectWorktreeOwnership(input: {
  context: WorktreeOwnershipContext;
  repositoryRoot: string;
  worktreePath: string;
  runGit?: GitInventoryRunner;
}): Promise<WorktreeOwnershipClassification> {
  const repositoryRoot = resolve(input.repositoryRoot);
  const worktreePath = resolve(input.worktreePath);
  if (resolve(input.context.projectRoot) !== repositoryRoot) {
    return { kind: "ambiguous", reason: "project-root-mismatch" };
  }
  const runGit = input.runGit ?? defaultGitRunner;
  const inventory = await inspectStrictGitWorktreeInventory(repositoryRoot, runGit);
  if (!inventory.ok) return { kind: "ambiguous", reason: "inventory-error" };
  const comparableTarget = comparableWorktreePath(worktreePath);
  const normalizedInventory: StrictGitWorktreeInventory = {
    ok: true,
    entries: inventory.entries.map((entry) => comparableWorktreePath(entry.path) === comparableTarget
      ? { ...entry, path: worktreePath }
      : entry),
  };

  let repositoryCommonDir: string;
  let worktreeGitDir: string;
  let markerTrackedOrStaged: boolean;
  try {
    const [commonDirResult, gitDirResult, trackedResult] = await Promise.all([
      runGit(worktreePath, ["rev-parse", "--git-common-dir"]),
      runGit(worktreePath, ["rev-parse", "--absolute-git-dir"]),
      runGit(worktreePath, ["ls-files", "--cached", "--", WORKTREE_OWNERSHIP_MARKER_RELATIVE_PATH]),
    ]);
    repositoryCommonDir = singleGitPath(commonDirResult.stdout, repositoryRoot);
    worktreeGitDir = singleGitPath(gitDirResult.stdout, worktreePath);
    markerTrackedOrStaged = Buffer.from(trackedResult.stdout).toString("utf8").trim().length > 0;
  } catch {
    return { kind: "ambiguous", reason: "ownership-probe-failed" };
  }

  return classifyWorktreeOwnership({
    context: input.context,
    inventory: normalizedInventory,
    repositoryCommonDir,
    worktreePath,
    worktreeGitDir,
    adminMarkerPath: resolve(worktreeGitDir, "fusion-owner.json"),
    worktreeMarkerPath: resolve(worktreePath, WORKTREE_OWNERSHIP_MARKER_RELATIVE_PATH),
    gitFilePath: resolve(worktreePath, ".git"),
    markerTrackedOrStaged,
  });
}

async function assertDirectory(path: string): Promise<void> {
  try {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("not a real directory");
  } catch (error) {
    throw new WorktreeOwnershipError("MARKER_PARENT_INVALID", `Marker parent is invalid: ${path}`, error);
  }
}

async function ensureWorktreeMarkerParent(worktreePath: string, markerParent: string): Promise<void> {
  await assertDirectory(worktreePath);
  if (markerParent !== resolve(worktreePath, ".fusion")) {
    throw new WorktreeOwnershipError("MARKER_CONTEXT_MISMATCH", "Worktree marker parent is outside the canonical .fusion child");
  }
  try {
    await assertDirectory(markerParent);
    return;
  } catch (error) {
    if ((error as WorktreeOwnershipError & { cause?: NodeJS.ErrnoException }).cause?.code !== "ENOENT") throw error;
  }
  try {
    await mkdir(markerParent, { mode: 0o700 });
    await assertDirectory(markerParent);
  } catch (error) {
    if (error instanceof WorktreeOwnershipError) throw error;
    throw new WorktreeOwnershipError("MARKER_PARENT_INVALID", `Marker parent is invalid: ${markerParent}`, error);
  }
}

function assertMutationAuthority(authority: EngineMutationAuthority): void {
  try {
    authority.assertHeld();
  } catch (error) {
    throw new WorktreeOwnershipError("AUTHORITY_NOT_HELD", "Engine mutation authority is not held", error);
  }
}

async function assertAbsent(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new WorktreeOwnershipError("MARKER_WRITE_FAILED", `Unable to inspect marker destination: ${path}`, error);
  }
  throw new WorktreeOwnershipError("MARKER_ALREADY_EXISTS", `Ownership marker already exists: ${path}`);
}

async function publishNoClobber(path: string, bytes: Buffer, authority: EngineMutationAuthority): Promise<void> {
  await assertDirectory(dirname(path));
  await assertAbsent(path);
  const temp = resolve(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temp, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temp, 0o600);
    assertMutationAuthority(authority);
    await assertAbsent(path);
    await link(temp, path);
  } catch (error) {
    if (error instanceof WorktreeOwnershipError) throw error;
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new WorktreeOwnershipError("MARKER_ALREADY_EXISTS", `Ownership marker already exists: ${path}`, error);
    }
    throw new WorktreeOwnershipError("MARKER_WRITE_FAILED", `Unable to publish ownership marker: ${path}`, error);
  } finally {
    await handle?.close().catch(() => {});
    await unlink(temp).catch(() => {});
  }
}

export async function writeWorktreeOwnershipMarkers(input: {
  authority: EngineMutationAuthority;
  marker: WorktreeOwnershipMarker;
  adminMarkerPath: string;
  worktreeMarkerPath: string;
}): Promise<Buffer> {
  assertMutationAuthority(input.authority);
  if (input.marker.lifecycle !== "creating") {
    throw new WorktreeOwnershipError("MARKER_TRANSITION_MISMATCH", "Only creating ownership markers may be published");
  }
  const bytes = serializeWorktreeOwnershipMarker(input.marker);
  parseWorktreeOwnershipMarker(bytes);
  if (input.adminMarkerPath !== resolve(input.marker.worktreeGitDir, "fusion-owner.json")
    || input.worktreeMarkerPath !== resolve(input.marker.worktreePath, WORKTREE_OWNERSHIP_MARKER_RELATIVE_PATH)) {
    throw new WorktreeOwnershipError("MARKER_CONTEXT_MISMATCH", "Marker destinations do not match the ownership marker paths");
  }
  await ensureWorktreeMarkerParent(input.marker.worktreePath, dirname(input.worktreeMarkerPath));
  await Promise.all([
    assertDirectory(input.marker.repositoryCommonDir),
    assertDirectory(input.marker.worktreePath),
    assertDirectory(input.marker.worktreeGitDir),
    assertDirectory(dirname(input.worktreeMarkerPath)),
  ]);
  await publishNoClobber(input.adminMarkerPath, bytes, input.authority);
  await publishNoClobber(input.worktreeMarkerPath, bytes, input.authority);
  assertMutationAuthority(input.authority);
  const [admin, worktree] = await Promise.all([readFile(input.adminMarkerPath), readFile(input.worktreeMarkerPath)]);
  if (!admin.equals(bytes) || !worktree.equals(bytes)) throw new WorktreeOwnershipError("MARKER_WRITE_FAILED", "Ownership marker copies differ after publication");
  return bytes;
}

async function replaceFrozen(path: string, frozen: Buffer, replacement: Buffer, authority: EngineMutationAuthority): Promise<void> {
  const current = await readFile(path);
  if (!current.equals(frozen)) throw new WorktreeOwnershipError("MARKER_TRANSITION_MISMATCH", `Ownership marker changed before transition: ${path}`);
  const temp = resolve(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    const handle = await open(temp, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    await handle.writeFile(replacement);
    await handle.sync();
    await handle.close();
    await chmod(temp, 0o600);
    assertMutationAuthority(authority);
    if (!(await readFile(path)).equals(frozen)) throw new WorktreeOwnershipError("MARKER_TRANSITION_MISMATCH", `Ownership marker changed before transition: ${path}`);
    await rename(temp, path);
  } finally {
    await unlink(temp).catch(() => {});
  }
}

export async function transitionWorktreeOwnershipMarkers(input: {
  authority: EngineMutationAuthority;
  creatingBytes: Buffer;
  adminMarkerPath: string;
  worktreeMarkerPath: string;
}): Promise<Buffer> {
  assertMutationAuthority(input.authority);
  const creating = parseWorktreeOwnershipMarker(input.creatingBytes);
  if (creating.lifecycle !== "creating") throw new WorktreeOwnershipError("MARKER_TRANSITION_MISMATCH", "Only creating markers may transition to managed");
  if (input.adminMarkerPath !== resolve(creating.worktreeGitDir, "fusion-owner.json")
    || input.worktreeMarkerPath !== resolve(creating.worktreePath, WORKTREE_OWNERSHIP_MARKER_RELATIVE_PATH)) {
    throw new WorktreeOwnershipError("MARKER_CONTEXT_MISMATCH", "Marker destinations do not match the ownership marker paths");
  }
  const current = await Promise.all([readFile(input.adminMarkerPath), readFile(input.worktreeMarkerPath)]);
  if (!current.every((bytes) => bytes.equals(input.creatingBytes))) throw new WorktreeOwnershipError("MARKER_TRANSITION_MISMATCH", "Creating marker copies do not match frozen bytes");
  const managedBytes = serializeWorktreeOwnershipMarker({ ...creating, lifecycle: "managed" });
  await replaceFrozen(input.adminMarkerPath, input.creatingBytes, managedBytes, input.authority);
  await replaceFrozen(input.worktreeMarkerPath, input.creatingBytes, managedBytes, input.authority);
  assertMutationAuthority(input.authority);
  const final = await Promise.all([readFile(input.adminMarkerPath), readFile(input.worktreeMarkerPath)]);
  if (!final.every((bytes) => bytes.equals(managedBytes))) throw new WorktreeOwnershipError("MARKER_TRANSITION_MISMATCH", "Managed marker copies differ after transition");
  return managedBytes;
}

async function readOptional(path: string): Promise<{ exists: false } | { exists: true; bytes: Buffer; mode: number }> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("marker is not a regular file");
    return { exists: true, bytes: await readFile(path), mode: stat.mode & 0o777 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false };
    throw error;
  }
}

export async function classifyWorktreeOwnership(input: {
  context: WorktreeOwnershipContext;
  inventory: StrictGitWorktreeInventory;
  repositoryCommonDir: string;
  worktreePath: string;
  worktreeGitDir: string;
  adminMarkerPath: string;
  worktreeMarkerPath: string;
  gitFilePath: string;
  markerTrackedOrStaged: boolean;
}): Promise<WorktreeOwnershipClassification> {
  if (!input.inventory.ok) return { kind: "ambiguous", reason: "inventory-error" };
  if (typeof input.markerTrackedOrStaged !== "boolean") return { kind: "ambiguous", reason: "marker-tracking-unproved" };
  if (input.markerTrackedOrStaged) return { kind: "ambiguous", reason: "marker-tracked-or-staged" };
  if (input.adminMarkerPath !== resolve(input.worktreeGitDir, "fusion-owner.json")
    || input.worktreeMarkerPath !== resolve(input.worktreePath, WORKTREE_OWNERSHIP_MARKER_RELATIVE_PATH)
    || input.gitFilePath !== resolve(input.worktreePath, ".git")) {
    return { kind: "ambiguous", reason: "probe-path-mismatch" };
  }
  try {
    await Promise.all([
      assertDirectory(input.repositoryCommonDir),
      assertDirectory(input.worktreePath),
      assertDirectory(dirname(input.worktreeMarkerPath)),
    ]);
  } catch {
    return { kind: "ambiguous", reason: "path-parent-invalid" };
  }
  let admin: Awaited<ReturnType<typeof readOptional>>;
  let worktree: Awaited<ReturnType<typeof readOptional>>;
  try {
    [admin, worktree] = await Promise.all([readOptional(input.adminMarkerPath), readOptional(input.worktreeMarkerPath)]);
  } catch {
    return { kind: "ambiguous", reason: "marker-read-failed" };
  }
  if ((admin.exists && admin.mode !== 0o600) || (worktree.exists && worktree.mode !== 0o600)) {
    return { kind: "ambiguous", reason: "marker-mode-invalid" };
  }
  if (!admin.exists && !worktree.exists) return { kind: "foreign-unmarked", reason: "markers-absent" };
  const expected = (marker: WorktreeOwnershipMarker) => marker.repositoryCommonDir === input.repositoryCommonDir
    && marker.worktreePath === input.worktreePath
    && marker.worktreeGitDir === input.worktreeGitDir;
  const parse = (candidate: typeof admin) => {
    if (!candidate.exists) return undefined;
    try { return parseWorktreeOwnershipMarker(candidate.bytes, input.context); } catch { return null; }
  };
  const adminMarker = parse(admin);
  const worktreeMarker = parse(worktree);
  const creating = [adminMarker, worktreeMarker].find((marker) => marker && marker.lifecycle === "creating" && expected(marker));
  if (creating) return { kind: "safe-parked", reason: "creating-or-partial-marker", ownerId: creating.ownerId };
  const registered = input.inventory.entries.some((entry) => entry.path === input.worktreePath);
  if (registered) {
    if (admin.exists && worktree.exists && admin.bytes.equals(worktree.bytes)
      && adminMarker && worktreeMarker && adminMarker.lifecycle === "managed" && expected(adminMarker)) {
      try { input.context.mutationAuthority.assertHeld(); } catch { return { kind: "ambiguous", reason: "authority-not-held" }; }
      return { kind: "owned-managed", ownerId: adminMarker.ownerId, marker: adminMarker };
    }
    return { kind: "ambiguous", reason: "registered-marker-invalid" };
  }
  if (admin.exists || !worktree.exists || !worktreeMarker || worktreeMarker.lifecycle !== "managed" || !expected(worktreeMarker)) {
    return { kind: "ambiguous", reason: "unregistered-marker-invalid" };
  }
  let gitFile: Buffer;
  try {
    const stat = await lstat(input.gitFilePath);
    if (!stat.isFile() || stat.isSymbolicLink()) return { kind: "ambiguous", reason: "git-file-invalid" };
    gitFile = await readFile(input.gitFilePath);
  } catch {
    return { kind: "ambiguous", reason: "git-file-invalid" };
  }
  const match = /^gitdir: ([^\r\n]+)\n?$/u.exec(gitFile.toString("utf8"));
  if (!match || resolve(dirname(input.gitFilePath), match[1]!) !== input.worktreeGitDir) return { kind: "ambiguous", reason: "git-file-invalid" };
  try {
    await lstat(input.worktreeGitDir);
    return { kind: "ambiguous", reason: "git-admin-dir-still-live" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { kind: "ambiguous", reason: "git-admin-dir-inspection-failed" };
  }
  try { input.context.mutationAuthority.assertHeld(); } catch { return { kind: "ambiguous", reason: "authority-not-held" }; }
  return { kind: "owned-dangling-orphan", ownerId: worktreeMarker.ownerId, marker: worktreeMarker };
}
