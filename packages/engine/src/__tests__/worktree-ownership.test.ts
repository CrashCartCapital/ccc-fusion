import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireTaskWorktree } from "../worktree-acquisition.js";
import { TaskExecutor } from "../executor.js";
import {
  classifyWorktreeOwnership,
  createWorktreeOwnershipMarker,
  inspectStrictGitWorktreeInventory,
  parseWorktreeOwnershipMarker,
  serializeWorktreeOwnershipMarker,
  transitionWorktreeOwnershipMarkers,
  WorktreeOwnershipError,
  writeWorktreeOwnershipMarkers,
  type EngineMutationAuthority,
  type WorktreeOwnershipContext,
} from "../worktree-ownership.js";
import { removeWorktree, RemovalReason } from "../worktree-backend.js";

const roots: string[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "fusion-owner-test-"));
  roots.push(root);
  const projectRoot = join(root, "project");
  const repositoryCommonDir = join(projectRoot, ".git");
  const worktreePath = join(projectRoot, ".worktrees", "fn-1");
  const worktreeGitDir = join(repositoryCommonDir, "worktrees", "fn-1");
  const adminMarkerPath = join(worktreeGitDir, "fusion-owner.json");
  const worktreeMarkerPath = join(worktreePath, ".fusion", "fusion-owner.json");
  await mkdir(join(worktreePath, ".fusion"), { recursive: true });
  await mkdir(worktreeGitDir, { recursive: true });
  const authority: EngineMutationAuthority = { assertHeld: vi.fn() };
  const context: WorktreeOwnershipContext = Object.freeze({
    projectId: "project-test",
    projectRoot,
    engineInstanceId: "engine-test",
    mutationAuthority: authority,
  });
  const marker = createWorktreeOwnershipMarker({
    context,
    ownerId: "9ccf38dc-33e4-4dd4-919d-b88686052147",
      repositoryCommonDir,
    worktreePath,
    worktreeGitDir,
  });
  return { root, projectRoot, repositoryCommonDir, worktreePath, worktreeGitDir, adminMarkerPath, worktreeMarkerPath, authority, context, marker };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("worktree ownership v1", () => {
  it("serializes canonical schema bytes and rejects unknown keys", async () => {
    const f = await fixture();
    const bytes = serializeWorktreeOwnershipMarker(f.marker);
    expect(bytes.toString("utf8")).toBe(`${JSON.stringify(f.marker, null, 2)}\n`);
    expect(parseWorktreeOwnershipMarker(bytes, f.context)).toEqual(f.marker);

    const extra = { ...f.marker, branch: "fusion/fn-1" };
    expect(() => parseWorktreeOwnershipMarker(Buffer.from(`${JSON.stringify(extra)}\n`), f.context)).toThrowError(
      expect.objectContaining({ code: "MARKER_SCHEMA_INVALID" }),
    );
    const reordered = { owner: f.marker.owner, schema: f.marker.schema, ...Object.fromEntries(Object.entries(f.marker).slice(2)) };
    expect(() => parseWorktreeOwnershipMarker(Buffer.from(`${JSON.stringify(reordered, null, 2)}\n`), f.context)).toThrowError(
      expect.objectContaining({ code: "MARKER_SCHEMA_INVALID" }),
    );
  });

  it("allows only the transition API to mint managed ownership", async () => {
    const f = await fixture();
    expect(() => createWorktreeOwnershipMarker({
      context: f.context,
      ownerId: f.marker.ownerId,
      lifecycle: "managed",
      repositoryCommonDir: f.repositoryCommonDir,
      worktreePath: f.worktreePath,
      worktreeGitDir: f.worktreeGitDir,
    } as never)).toThrowError(expect.objectContaining({ code: "MARKER_SCHEMA_INVALID" }));

    await expect(writeWorktreeOwnershipMarkers({
      authority: f.authority,
      marker: { ...f.marker, lifecycle: "managed" },
      adminMarkerPath: f.adminMarkerPath,
      worktreeMarkerPath: f.worktreeMarkerPath,
    })).rejects.toMatchObject({ code: "MARKER_TRANSITION_MISMATCH" });
  });

  it("writes identical 0600 marker copies without clobbering an existing destination", async () => {
    const f = await fixture();
    const bytes = await writeWorktreeOwnershipMarkers({
      authority: f.authority,
      marker: f.marker,
      adminMarkerPath: f.adminMarkerPath,
      worktreeMarkerPath: f.worktreeMarkerPath,
    });
    expect(await readFile(f.adminMarkerPath)).toEqual(bytes);
    expect(await readFile(f.worktreeMarkerPath)).toEqual(bytes);
    expect((await stat(f.adminMarkerPath)).mode & 0o777).toBe(0o600);
    expect((await stat(f.worktreeMarkerPath)).mode & 0o777).toBe(0o600);
    expect(f.authority.assertHeld).toHaveBeenCalled();

    await expect(writeWorktreeOwnershipMarkers({
      authority: f.authority,
      marker: f.marker,
      adminMarkerPath: f.adminMarkerPath,
      worktreeMarkerPath: f.worktreeMarkerPath,
    })).rejects.toBeInstanceOf(WorktreeOwnershipError);
    expect(await readFile(f.adminMarkerPath)).toEqual(bytes);
  });

  it("creates only a missing real .fusion child and preserves partial creating residue", async () => {
    const f = await fixture();
    await rm(join(f.worktreePath, ".fusion"), { recursive: true });
    await writeFile(f.worktreeMarkerPath, "occupied", { recursive: true } as never).catch(() => undefined);
    await mkdir(join(f.worktreePath, ".fusion"));
    await writeFile(f.worktreeMarkerPath, "occupied");

    await expect(writeWorktreeOwnershipMarkers({
      authority: f.authority,
      marker: f.marker,
      adminMarkerPath: f.adminMarkerPath,
      worktreeMarkerPath: f.worktreeMarkerPath,
    })).rejects.toMatchObject({ code: "MARKER_ALREADY_EXISTS" });
    expect(parseWorktreeOwnershipMarker(await readFile(f.adminMarkerPath)).lifecycle).toBe("creating");
    expect(await readFile(f.worktreeMarkerPath, "utf8")).toBe("occupied");

    await rm(f.adminMarkerPath);
    await rm(join(f.worktreePath, ".fusion"), { recursive: true });
    const bytes = await writeWorktreeOwnershipMarkers({
      authority: f.authority,
      marker: f.marker,
      adminMarkerPath: f.adminMarkerPath,
      worktreeMarkerPath: f.worktreeMarkerPath,
    });
    expect((await lstat(join(f.worktreePath, ".fusion"))).isSymbolicLink()).toBe(false);
    expect(await readFile(f.worktreeMarkerPath)).toEqual(bytes);
  });

  it("transitions both frozen creating copies to managed", async () => {
    const f = await fixture();
    const creatingBytes = await writeWorktreeOwnershipMarkers({ authority: f.authority, marker: f.marker, adminMarkerPath: f.adminMarkerPath, worktreeMarkerPath: f.worktreeMarkerPath });
    const managedBytes = await transitionWorktreeOwnershipMarkers({ authority: f.authority, creatingBytes, adminMarkerPath: f.adminMarkerPath, worktreeMarkerPath: f.worktreeMarkerPath });
    expect(parseWorktreeOwnershipMarker(managedBytes, f.context).lifecycle).toBe("managed");
    expect(await readFile(f.adminMarkerPath)).toEqual(managedBytes);
    expect(await readFile(f.worktreeMarkerPath)).toEqual(managedBytes);
  });

  it("wraps transition filesystem failures as typed errors and retains creating residue", async () => {
    const f = await fixture();
    const creatingBytes = await writeWorktreeOwnershipMarkers({ authority: f.authority, marker: f.marker, adminMarkerPath: f.adminMarkerPath, worktreeMarkerPath: f.worktreeMarkerPath });
    await rm(f.adminMarkerPath);

    let failure: unknown;
    try {
      await transitionWorktreeOwnershipMarkers({
        authority: f.authority,
        creatingBytes,
        adminMarkerPath: f.adminMarkerPath,
        worktreeMarkerPath: f.worktreeMarkerPath,
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(WorktreeOwnershipError);
    expect(failure).toMatchObject({
      code: "MARKER_WRITE_FAILED",
      cause: expect.objectContaining({ code: "ENOENT" }),
    });
    expect(await readFile(f.worktreeMarkerPath)).toEqual(creatingBytes);
    await expect(readFile(f.adminMarkerPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("wraps an injected transition rename failure and retains partial marker residue", async () => {
    const f = await fixture();
    const creatingBytes = await writeWorktreeOwnershipMarkers({ authority: f.authority, marker: f.marker, adminMarkerPath: f.adminMarkerPath, worktreeMarkerPath: f.worktreeMarkerPath });
    const injected = Object.assign(new Error("injected rename failure"), { code: "EIO" });
    let renameCalls = 0;
    const injectedRename = vi.fn(async (source: string, destination: string) => {
      renameCalls += 1;
      if (renameCalls === 2) throw injected;
      return rename(source, destination);
    });

    await expect(transitionWorktreeOwnershipMarkers({
      authority: f.authority,
      creatingBytes,
      adminMarkerPath: f.adminMarkerPath,
      worktreeMarkerPath: f.worktreeMarkerPath,
      filesystem: { rename: injectedRename },
    })).rejects.toMatchObject({
      code: "MARKER_WRITE_FAILED",
      cause: injected,
    });
    expect(renameCalls).toBe(2);
    expect(parseWorktreeOwnershipMarker(await readFile(f.adminMarkerPath), f.context).lifecycle).toBe("managed");
    expect(parseWorktreeOwnershipMarker(await readFile(f.worktreeMarkerPath), f.context).lifecycle).toBe("creating");
  });

  it("carries a fresh TaskExecutor worktree through acquisition, managed markers, and guarded removal", async () => {
    const rawRoot = await mkdtemp(join(tmpdir(), "fusion-owner-caller-"));
    const root = await realpath(rawRoot);
    roots.push(root);
    const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
    git(root, ["init", "-b", "main"]);
    git(root, ["config", "user.email", "test@example.com"]);
    git(root, ["config", "user.name", "Test User"]);
    await writeFile(join(root, "README.md"), "root\n");
    git(root, ["add", "README.md"]);
    git(root, ["commit", "-m", "init"]);
    await mkdir(join(root, ".worktrees"));

    const task = {
      id: "FN-401",
      title: "fresh ownership caller",
      description: "fresh ownership caller",
      column: "in-progress",
      branch: null,
      worktree: null,
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as any;
    const persisted: Record<string, unknown> = {};
    const settings = {
      worktreeNaming: "task-id",
      worktreesDir: join(root, ".worktrees"),
      worktreeRebaseBeforeMerge: false,
      secretsEnv: { enabled: false },
    } as any;
    const store = {
      on: vi.fn(),
      getSettings: vi.fn().mockResolvedValue(settings),
      getTask: vi.fn(async () => ({ ...task, ...persisted })),
      updateTask: vi.fn(async (_taskId: string, patch: Record<string, unknown>) => {
        Object.assign(persisted, patch);
        return { ...task, ...persisted };
      }),
      logEntry: vi.fn().mockResolvedValue(undefined),
    } as any;
    const authority: EngineMutationAuthority = { assertHeld: vi.fn() };
    const context: WorktreeOwnershipContext = Object.freeze({
      projectId: "project-real-caller",
      projectRoot: root,
      engineInstanceId: "engine-real-caller",
      mutationAuthority: authority,
    });
    const executor = new TaskExecutor(store, root, {
      worktreeOwnershipContext: context,
      requireWorktreeOwnership: true,
    });

    const acquired = await acquireTaskWorktree({
      task,
      rootDir: root,
      store,
      settings,
      logger: { log: () => {}, warn: () => {} },
      ownershipContext: context,
      requireOwnership: true,
      createWorktree: (branch, path, taskId, startPoint, allowSiblingBranchRename) =>
        (executor as any).createWorktree(branch, path, taskId, startPoint, allowSiblingBranchRename),
    });

    expect(acquired.source).toBe("fresh");
    expect(persisted).toMatchObject({ worktree: acquired.worktreePath, branch: "fusion/fn-401" });
    const worktreeGitDir = git(acquired.worktreePath, ["rev-parse", "--absolute-git-dir"]);
    const adminMarkerPath = join(worktreeGitDir, "fusion-owner.json");
    const worktreeMarkerPath = join(acquired.worktreePath, ".fusion", "fusion-owner.json");
    expect(parseWorktreeOwnershipMarker(await readFile(adminMarkerPath), context).lifecycle).toBe("managed");
    expect(parseWorktreeOwnershipMarker(await readFile(worktreeMarkerPath), context).lifecycle).toBe("managed");

    await expect(removeWorktree({
      rootDir: root,
      worktreePath: acquired.worktreePath,
      settings,
      taskId: task.id,
      reason: RemovalReason.PoolPrune,
      ownershipContext: context,
      requireOwnership: true,
    } as never)).resolves.toMatchObject({ removed: true });
    await expect(lstat(acquired.worktreePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns a typed inventory error instead of treating Git failure as empty", async () => {
    const result = await inspectStrictGitWorktreeInventory("/repo", async () => {
      throw Object.assign(new Error("git failed"), { code: 128 });
    });
    expect(result).toEqual(expect.objectContaining({ ok: false, code: "GIT_INVENTORY_FAILED" }));
  });

  it("parses NUL-delimited Git inventory without dropping registered paths", async () => {
    const result = await inspectStrictGitWorktreeInventory("/repo", async () => ({
      stdout: "worktree /repo\0HEAD abc123\0branch refs/heads/main\0\0worktree /repo/.worktrees/fn-1\0HEAD def456\0detached\0\0",
    }));
    expect(result).toEqual({
      ok: true,
      entries: [
        { path: "/repo", head: "abc123", branch: "refs/heads/main" },
        { path: "/repo/.worktrees/fn-1", head: "def456", detached: true },
      ],
    });
  });

  it("rejects unknown and duplicate inventory records", async () => {
    const unknown = await inspectStrictGitWorktreeInventory("/repo", async () => ({
      stdout: "worktree /repo\0mystery value\0\0",
    }));
    expect(unknown).toMatchObject({ ok: false, code: "GIT_INVENTORY_MALFORMED" });

    const duplicate = await inspectStrictGitWorktreeInventory("/repo", async () => ({
      stdout: "worktree /repo\0HEAD abc\0HEAD def\0\0",
    }));
    expect(duplicate).toMatchObject({ ok: false, code: "GIT_INVENTORY_MALFORMED" });
  });

  it("classifies only exact dual managed registered ownership as owned-managed", async () => {
    const f = await fixture();
    const creatingBytes = await writeWorktreeOwnershipMarkers({ authority: f.authority, marker: f.marker, adminMarkerPath: f.adminMarkerPath, worktreeMarkerPath: f.worktreeMarkerPath });
    await transitionWorktreeOwnershipMarkers({ authority: f.authority, creatingBytes, adminMarkerPath: f.adminMarkerPath, worktreeMarkerPath: f.worktreeMarkerPath });
    const result = await classifyWorktreeOwnership({
      context: f.context,
      inventory: { ok: true, entries: [{ path: f.worktreePath }] },
      repositoryCommonDir: f.repositoryCommonDir,
      worktreePath: f.worktreePath,
      worktreeGitDir: f.worktreeGitDir,
      adminMarkerPath: f.adminMarkerPath,
      worktreeMarkerPath: f.worktreeMarkerPath,
      gitFilePath: join(f.worktreePath, ".git"),
      markerTrackedOrStaged: false,
    });
    expect(result).toEqual(expect.objectContaining({ kind: "owned-managed", ownerId: f.marker.ownerId }));
  });

  it("classifies an exact managed pointer to an absent admin directory as owned-dangling-orphan", async () => {
    const f = await fixture();
    const managed = { ...f.marker, lifecycle: "managed" as const };
    await writeFile(f.worktreeMarkerPath, serializeWorktreeOwnershipMarker(managed), { mode: 0o600 });
    await writeFile(join(f.worktreePath, ".git"), `gitdir: ${f.worktreeGitDir}\n`);
    await rm(f.worktreeGitDir, { recursive: true });

    const result = await classifyWorktreeOwnership({
      context: f.context,
      inventory: { ok: true, entries: [] },
      repositoryCommonDir: f.repositoryCommonDir,
      worktreePath: f.worktreePath,
      worktreeGitDir: f.worktreeGitDir,
      adminMarkerPath: f.adminMarkerPath,
      worktreeMarkerPath: f.worktreeMarkerPath,
      gitFilePath: join(f.worktreePath, ".git"),
      markerTrackedOrStaged: false,
    });
    expect(result).toEqual(expect.objectContaining({ kind: "owned-dangling-orphan", ownerId: f.marker.ownerId }));
  });

  it("parks creating residue and refuses a missing .git dangling claim", async () => {
    const f = await fixture();
    await writeFile(f.worktreeMarkerPath, serializeWorktreeOwnershipMarker(f.marker), { mode: 0o600 });
    await rm(f.worktreeGitDir, { recursive: true });
    const common = {
      context: f.context,
      inventory: { ok: true as const, entries: [] },
      repositoryCommonDir: f.repositoryCommonDir,
      worktreePath: f.worktreePath,
      worktreeGitDir: f.worktreeGitDir,
      adminMarkerPath: f.adminMarkerPath,
      worktreeMarkerPath: f.worktreeMarkerPath,
      gitFilePath: join(f.worktreePath, ".git"),
      markerTrackedOrStaged: false,
    };
    expect(await classifyWorktreeOwnership(common)).toEqual(expect.objectContaining({ kind: "safe-parked" }));

    await writeFile(f.worktreeMarkerPath, serializeWorktreeOwnershipMarker({ ...f.marker, lifecycle: "managed" }), { mode: 0o600 });
    expect(await classifyWorktreeOwnership(common)).toEqual(expect.objectContaining({ kind: "ambiguous", reason: "git-file-invalid" }));
  });

  it("denies maintenance authority when tracked/staged evidence is absent, true, or non-boolean", async () => {
    const f = await fixture();
    const creatingBytes = await writeWorktreeOwnershipMarkers({ authority: f.authority, marker: f.marker, adminMarkerPath: f.adminMarkerPath, worktreeMarkerPath: f.worktreeMarkerPath });
    await transitionWorktreeOwnershipMarkers({ authority: f.authority, creatingBytes, adminMarkerPath: f.adminMarkerPath, worktreeMarkerPath: f.worktreeMarkerPath });
    const common = {
      context: f.context,
      inventory: { ok: true as const, entries: [{ path: f.worktreePath }] },
      repositoryCommonDir: f.repositoryCommonDir,
      worktreePath: f.worktreePath,
      worktreeGitDir: f.worktreeGitDir,
      adminMarkerPath: f.adminMarkerPath,
      worktreeMarkerPath: f.worktreeMarkerPath,
      gitFilePath: join(f.worktreePath, ".git"),
    };
    expect(await classifyWorktreeOwnership(common as never)).toMatchObject({ kind: "ambiguous", reason: "marker-tracking-unproved" });
    expect(await classifyWorktreeOwnership({ ...common, markerTrackedOrStaged: true })).toMatchObject({ kind: "ambiguous", reason: "marker-tracked-or-staged" });
    expect(await classifyWorktreeOwnership({ ...common, markerTrackedOrStaged: "false" } as never)).toMatchObject({ kind: "ambiguous", reason: "marker-tracking-unproved" });
  });

  it("production removal preserves an unmarked foreign Git worktree and accepts exact owned managed state", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-owner-real-git-"));
    roots.push(root);
    const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
    git(root, ["init", "-b", "main"]);
    git(root, ["config", "user.email", "test@example.com"]);
    git(root, ["config", "user.name", "Test User"]);
    await writeFile(join(root, "README.md"), "root\n");
    git(root, ["add", "README.md"]);
    git(root, ["commit", "-m", "init"]);
    const foreign = join(root, ".worktrees", "foreign");
    const owned = join(root, ".worktrees", "owned");
    await mkdir(join(root, ".worktrees"));
    git(root, ["worktree", "add", "-b", "foreign", foreign, "main"]);
    git(root, ["worktree", "add", "-b", "owned", owned, "main"]);
    const authority: EngineMutationAuthority = { assertHeld: vi.fn() };
    const context: WorktreeOwnershipContext = Object.freeze({
      projectId: "project-real-git",
      projectRoot: root,
      engineInstanceId: "engine-real-git",
      mutationAuthority: authority,
    });
    const audit = { git: vi.fn().mockResolvedValue(undefined) };

    await expect(removeWorktree({
      rootDir: root,
      worktreePath: foreign,
      settings: {},
      audit,
      reason: RemovalReason.PoolPrune,
      ownershipContext: context,
    } as never)).rejects.toMatchObject({ code: "WORKTREE_NOT_OWNED" });
    expect((await lstat(foreign)).isDirectory()).toBe(true);
    expect(audit.git).toHaveBeenCalledWith(expect.objectContaining({
      type: "worktree:removal-refused-unowned",
      target: foreign,
      metadata: expect.objectContaining({ classification: expect.any(String), reason: expect.any(String) }),
    }));

    const worktreeGitDir = git(owned, ["rev-parse", "--absolute-git-dir"]);
    const repositoryCommonDirRaw = git(owned, ["rev-parse", "--git-common-dir"]);
    const repositoryCommonDir = repositoryCommonDirRaw.startsWith("/") ? repositoryCommonDirRaw : join(owned, repositoryCommonDirRaw);
    const marker = createWorktreeOwnershipMarker({ context, repositoryCommonDir, worktreePath: owned, worktreeGitDir });
    const adminMarkerPath = join(worktreeGitDir, "fusion-owner.json");
    const worktreeMarkerPath = join(owned, ".fusion", "fusion-owner.json");
    const creatingBytes = await writeWorktreeOwnershipMarkers({ authority, marker, adminMarkerPath, worktreeMarkerPath });
    await transitionWorktreeOwnershipMarkers({ authority, creatingBytes, adminMarkerPath, worktreeMarkerPath });
    await expect(removeWorktree({
      rootDir: root,
      worktreePath: owned,
      settings: {},
      reason: RemovalReason.PoolPrune,
      ownershipContext: context,
    } as never)).resolves.toMatchObject({ removed: true });
    await expect(lstat(owned)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
