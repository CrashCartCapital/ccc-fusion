import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
    lifecycle: "creating",
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

  it("transitions both frozen creating copies to managed", async () => {
    const f = await fixture();
    const creatingBytes = await writeWorktreeOwnershipMarkers({ authority: f.authority, marker: f.marker, adminMarkerPath: f.adminMarkerPath, worktreeMarkerPath: f.worktreeMarkerPath });
    const managedBytes = await transitionWorktreeOwnershipMarkers({ authority: f.authority, creatingBytes, adminMarkerPath: f.adminMarkerPath, worktreeMarkerPath: f.worktreeMarkerPath });
    expect(parseWorktreeOwnershipMarker(managedBytes, f.context).lifecycle).toBe("managed");
    expect(await readFile(f.adminMarkerPath)).toEqual(managedBytes);
    expect(await readFile(f.worktreeMarkerPath)).toEqual(managedBytes);
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
    };
    expect(await classifyWorktreeOwnership(common)).toEqual(expect.objectContaining({ kind: "safe-parked" }));

    await writeFile(f.worktreeMarkerPath, serializeWorktreeOwnershipMarker({ ...f.marker, lifecycle: "managed" }), { mode: 0o600 });
    expect(await classifyWorktreeOwnership(common)).toEqual(expect.objectContaining({ kind: "ambiguous", reason: "git-file-invalid" }));
  });
});
