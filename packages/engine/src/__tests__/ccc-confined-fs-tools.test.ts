import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createEditTool, createFindTool, createLsTool, createReadTool, createWriteTool } from "@earendil-works/pi-coding-agent";
import { CCC_PLANNING_DENIED_NAMES } from "@fusion/core";
import { cccConfinedEffectiveDeniedNames, cccConfinedWriteRefusal } from "../ccc-confinement/confined-shell.js";
import { createCccConfinedFsOperations } from "../ccc-confinement/confined-fs-tools.js";

/*
FNXC:CccConfinedFsTools 2026-10-14-20:55:
Card C2 proof for the confined file operations (CONTRACT-v3 section 2.13, D11, errata E2-7). Every path is resolved to its real path and must stay inside the session's roots: a parent-directory step, an absolute escape and a symlink that resolves outside are refused, and a denied name is never read. Writes and edits go through card X1's shared write predicate, cccConfinedWriteRefusal, so they refuse a .git path segment and every effective denied name exactly as the confined shell does. Each refusal has a positive control on the same fixture: the escaping target is readable without the confinement, and a sibling ordinary file is written and edited.
*/

vi.mock("../ccc-confinement/confined-shell.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ccc-confinement/confined-shell.js")>();
  return { ...actual, cccConfinedWriteRefusal: vi.fn(actual.cccConfinedWriteRefusal) };
});

const parent = realpathSync(mkdtempSync(join(tmpdir(), "ccc-c2-fs-")));
const root = join(parent, "root");
const outsideFile = join(parent, "x");
mkdirSync(join(root, "src"), { recursive: true });
mkdirSync(join(root, "sub", ".git"), { recursive: true });
writeFileSync(join(root, "src", "a.txt"), "alpha\n");
writeFileSync(join(root, "sub", ".git", "config"), "secret-config\n");
writeFileSync(join(root, "sub", "ok.txt"), "sibling\n");
writeFileSync(join(root, ".env"), "SECRET=root\n");
writeFileSync(outsideFile, "outside-bytes\n");
symlinkSync(outsideFile, join(root, "escape"));
symlinkSync(join(root, "src", "a.txt"), join(root, "link-in"));

afterAll(() => {
  rmSync(parent, { recursive: true, force: true });
});

const DENIED = [...CCC_PLANNING_DENIED_NAMES];

function readOnlyOps() {
  return createCccConfinedFsOperations({ readRoots: [root], writeRoots: [], deniedNames: DENIED });
}

function writerOps() {
  return createCccConfinedFsOperations({ readRoots: [root], writeRoots: [root], deniedNames: DENIED });
}

function text(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.map((block) => block.text ?? "").join("\n");
}

describe("confined file operations (card C2)", () => {
  beforeEach(() => {
    vi.mocked(cccConfinedWriteRefusal).mockClear();
  });

  it("refuses a confined read of ../x and of an escaping symlink; a read inside the root, also through an in-root symlink, returns the bytes", async () => {
    const read = createReadTool(root, { operations: readOnlyOps().read });

    await expect(read.execute("t1", { path: "../x" })).rejects.toThrow(/refused/);
    await expect(read.execute("t2", { path: "escape" })).rejects.toThrow(/refused/);
    await expect(readOnlyOps().read.readFile(`${root}/../x`)).rejects.toThrow(/refused/);
    await expect(readOnlyOps().read.readFile(outsideFile)).rejects.toThrow(/refused/);

    // Positive control: the same targets are readable without the confinement, so the refusals are not vacuous.
    const unconfined = createReadTool(root);
    expect(text(await unconfined.execute("t3", { path: "../x" }))).toContain("outside-bytes");
    expect(text(await unconfined.execute("t4", { path: "escape" }))).toContain("outside-bytes");
    expect(text(await read.execute("t5", { path: "src/a.txt" }))).toContain("alpha");
    expect(text(await read.execute("t6", { path: "link-in" }))).toContain("alpha");
  });

  it("never reads, lists or finds a denied name or a .git segment inside a root", async () => {
    const ops = readOnlyOps();
    const read = createReadTool(root, { operations: ops.read });
    const ls = createLsTool(root, { operations: ops.ls });
    const find = createFindTool(root, { operations: ops.find });

    await expect(read.execute("t1", { path: ".env" })).rejects.toThrow(/refused/);
    await expect(read.execute("t2", { path: "sub/.git/config" })).rejects.toThrow(/refused/);
    const listing = text(await ls.execute("t3", {}));
    expect(listing).toContain("src/");
    expect(listing).not.toContain(".env");
    const found = text(await find.execute("t4", { pattern: "*" }));
    expect(found).toContain("src/a.txt");
    expect(found).toContain("sub/ok.txt");
    expect(found).not.toContain(".env");
    expect(found).not.toContain("config");
    const entries = await ops.ls.readdir(root);
    expect(entries).toEqual(expect.arrayContaining(["link-in", "src", "sub"]));
    expect(entries).not.toContain(".env");
    expect(entries).not.toContain("escape");
    expect(await ops.ls.readdir(join(root, "sub"))).toEqual(["ok.txt"]);
    // Positive control: the hidden entries are really there.
    expect(readdirSync(root)).toEqual(expect.arrayContaining([".env", "escape"]));
    expect(readdirSync(join(root, "sub")).sort()).toEqual([".git", "ok.txt"]);
    expect(readFileSync(join(root, ".env"), "utf8")).toContain("SECRET=root");
    expect(readFileSync(join(root, "sub", ".git", "config"), "utf8")).toContain("secret-config");
  });

  it("refuses a write or edit to <root>/sub/.git/config and to a denied-name file through X1's shared cccConfinedWriteRefusal; a sibling ordinary file is accepted", async () => {
    const ops = writerOps();
    const write = createWriteTool(root, { operations: ops.write });
    const edit = createEditTool(root, { operations: ops.edit });

    await expect(write.execute("t1", { path: "sub/.git/config", content: "pwned\n" })).rejects.toThrow(/git-segment/);
    await expect(edit.execute("t2", { path: "sub/.git/config", edits: [{ oldText: "secret", newText: "pwned" }] }))
      .rejects.toThrow(/git-segment/);
    await expect(write.execute("t3", { path: ".env", content: "SECRET=pwned\n" })).rejects.toThrow(/denied-name/);
    await expect(edit.execute("t4", { path: ".env", edits: [{ oldText: "root", newText: "pwned" }] }))
      .rejects.toThrow(/denied-name/);
    await expect(write.execute("t5", { path: "src/.env.local", content: "SECRET=pwned\n" })).rejects.toThrow(/denied-name/);

    const effective = cccConfinedEffectiveDeniedNames(DENIED);
    expect(cccConfinedWriteRefusal).toHaveBeenCalledWith({
      path: join(root, "sub", ".git", "config"),
      writeRoots: [root],
      deniedNames: effective,
    });
    expect(cccConfinedWriteRefusal).toHaveBeenCalledWith({ path: join(root, ".env"), writeRoots: [root], deniedNames: effective });
    expect(vi.mocked(cccConfinedWriteRefusal).mock.results.map((result) => result.value))
      .toEqual(expect.arrayContaining(["git-segment", "denied-name"]));
    expect(readFileSync(join(root, "sub", ".git", "config"), "utf8")).toBe("secret-config\n");
    expect(readFileSync(join(root, ".env"), "utf8")).toBe("SECRET=root\n");

    // Positive control: the sibling ordinary files next to the refused paths are written and edited.
    await write.execute("t6", { path: "sub/new.txt", content: "fresh\n" });
    await edit.execute("t7", { path: "sub/ok.txt", edits: [{ oldText: "sibling", newText: "edited" }] });
    expect(readFileSync(join(root, "sub", "new.txt"), "utf8")).toBe("fresh\n");
    expect(readFileSync(join(root, "sub", "ok.txt"), "utf8")).toBe("edited\n");
    expect(vi.mocked(cccConfinedWriteRefusal).mock.results.map((result) => result.value)).toContain(null);
  });

  it("refuses every write when the session has no write roots, and a write through an escaping symlink", async () => {
    const write = createWriteTool(root, { operations: readOnlyOps().write });
    const edit = createEditTool(root, { operations: readOnlyOps().edit });

    await expect(write.execute("t1", { path: "src/b.txt", content: "nope\n" })).rejects.toThrow(/outside-write-roots/);
    await expect(edit.execute("t2", { path: "src/a.txt", edits: [{ oldText: "alpha", newText: "beta" }] }))
      .rejects.toThrow(/outside-write-roots/);
    const writer = createWriteTool(root, { operations: writerOps().write });
    await expect(writer.execute("t3", { path: "escape", content: "pwned\n" })).rejects.toThrow(/outside-write-roots/);
    expect(readFileSync(outsideFile, "utf8")).toBe("outside-bytes\n");
    expect(readFileSync(join(root, "src", "a.txt"), "utf8")).toBe("alpha\n");
  });

  it("validates denied names against [A-Za-z0-9._*-] with a TypeError before any predicate call", () => {
    expect(() => createCccConfinedFsOperations({ readRoots: [root], writeRoots: [], deniedNames: ["bad/name"] }))
      .toThrow(TypeError);
    expect(() => createCccConfinedFsOperations({ readRoots: [root], writeRoots: [], deniedNames: ["bad/name"] }))
      .toThrow(/\[A-Za-z0-9\._\*-\]/);
    expect(cccConfinedWriteRefusal).not.toHaveBeenCalled();
  });
});
