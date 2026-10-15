import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createEditTool, createFindTool, createLsTool, createReadTool, createWriteTool } from "@earendil-works/pi-coding-agent";
import { CCC_PLANNING_DENIED_NAMES } from "@fusion/core";
import { cccConfinedEffectiveDeniedNames, cccConfinedWriteRefusal } from "../ccc-confinement/confined-shell.js";
import { createCccConfinedFsOperations } from "../ccc-confinement/confined-fs-tools.js";
import { createCccConfinedSessionTools } from "../ccc-confinement/session-tool-policy.js";

/*
FNXC:CccConfinedFsTools 2026-10-14-20:55:
Card C2 proof for the confined file operations (CONTRACT-v3 section 2.13, D11, errata E2-7). Every path is resolved to its real path and must stay inside the session's roots: a parent-directory step, an absolute escape and a symlink that resolves outside are refused, and a denied name is never read. Writes and edits go through card X1's shared write predicate, cccConfinedWriteRefusal, so they refuse a .git path segment and every effective denied name exactly as the confined shell does. Each refusal has a positive control on the same fixture: the escaping target is readable without the confinement, and a sibling ordinary file is written and edited.
*/

vi.mock("../ccc-confinement/confined-shell.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ccc-confinement/confined-shell.js")>();
  return { ...actual, cccConfinedWriteRefusal: vi.fn(actual.cccConfinedWriteRefusal) };
});

/*
FNXC:CccConfinedFsTools 2026-10-14-22:52:
Card C2 repair 1 (time-of-check to time-of-use). The file system calls the confined operations make after their check pass through here unchanged, except that a test can arm one hook that runs just before the next call. The hook swaps an in-root directory for a symlink to a directory outside the root, which is exactly what a concurrent in-session process could do between the check and the open.
*/
const raceHook = vi.hoisted(() => ({ beforeNextOpen: null as null | (() => void) }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const hooked = <F extends (...args: never[]) => unknown>(fn: F): F => ((...args: Parameters<F>) => {
    const hook = raceHook.beforeNextOpen;
    raceHook.beforeNextOpen = null;
    hook?.();
    return fn(...args);
  }) as F;
  return { ...actual, open: hooked(actual.open), readFile: hooked(actual.readFile), writeFile: hooked(actual.writeFile) };
});

const piCodingAgentDir = realpathSync(fileURLToPath(new URL("../../node_modules/@earendil-works/pi-coding-agent", import.meta.url)));
const { agentLoop } = (await import(pathToFileURL(join(piCodingAgentDir, "..", "pi-agent-core", "dist", "agent-loop.js")).href)) as {
  agentLoop: (...args: unknown[]) => AsyncIterable<unknown>;
};
const MODEL = { id: "m", provider: "p", api: "openai-completions", name: "m" };
const USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/** Runs one prompt through Pi 0.81.1's real agent loop; the first model call answers with all of `toolCalls` in one message. */
async function runPiLoop(tools: unknown[], toolCalls: ReadonlyArray<{ name: string; arguments: Record<string, unknown> }>): Promise<string[]> {
  let entries = 0;
  const results: string[] = [];
  const streamFn = () => {
    entries += 1;
    const first = entries === 1;
    const content = first
      ? toolCalls.map((call, index) => ({ type: "toolCall", id: `call-${index + 1}`, name: call.name, arguments: call.arguments }))
      : [{ type: "text", text: "done" }];
    const stopReason = first ? "toolUse" : "stop";
    const message = { role: "assistant", content, api: MODEL.api, provider: MODEL.provider, model: MODEL.id, usage: USAGE, stopReason, timestamp: Date.now() };
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: "done", reason: stopReason, message } as never);
      stream.end();
    });
    return stream;
  };
  const events = agentLoop([{ role: "user", content: "go", timestamp: Date.now() }], { systemPrompt: "", messages: [], tools },
    { model: MODEL, convertToLlm: (messages: unknown[]) => messages }, new AbortController().signal, streamFn);
  for await (const event of events as AsyncIterable<{ type: string; result?: { content?: Array<{ text?: string }> } }>) {
    if (event.type === "tool_execution_end") results.push((event.result?.content ?? []).map((block) => block.text ?? "").join("\n"));
  }
  return results;
}

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

  it("under a tool policy the confined bash, write and edit run one at a time, so a write or read sent with a shell that swaps an in-root directory for an outside symlink lands inside the root and nothing lands outside", async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "ccc-c2-race-")));
    const raceRoot = join(base, "root");
    const outside = join(base, "outside");
    mkdirSync(join(raceRoot, "d"), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(raceRoot, "d", "f.txt"), "inside\n");
    writeFileSync(join(outside, "f.txt"), "outside-secret\n");
    try {
      const events: string[] = [];
      const confined = createCccConfinedFsOperations({ readRoots: [raceRoot], writeRoots: [raceRoot], deniedNames: DENIED });
      const fs = {
        ...confined,
        write: {
          mkdir: async (directory: string) => {
            events.push("write:mkdir");
            return confined.write.mkdir(directory);
          },
          writeFile: async (path: string, content: string) => {
            events.push("write:writeFile");
            return confined.write.writeFile(path, content);
          },
        },
        read: {
          ...confined.read,
          readFile: async (path: string) => {
            events.push("read:readFile");
            return confined.read.readFile(path);
          },
        },
      };
      // The shell holds the swap for its whole run, as a background loop in a confined command could.
      const bash = {
        exec: async () => {
          events.push("bash:start");
          renameSync(join(raceRoot, "d"), join(raceRoot, "d.parked"));
          symlinkSync(outside, join(raceRoot, "d"));
          await new Promise((resolve) => setTimeout(resolve, 50));
          unlinkSync(join(raceRoot, "d"));
          renameSync(join(raceRoot, "d.parked"), join(raceRoot, "d"));
          events.push("bash:end");
          return { exitCode: 0 };
        },
        dispose: async () => Object.freeze({ closure: "confirmed" as const }),
      };
      const tools = createCccConfinedSessionTools({
        names: ["bash", "read", "write", "edit"],
        confinement: { fs, bash } as never,
        cwd: raceRoot,
        readRoots: [raceRoot],
        deniedNames: DENIED,
      });
      await runPiLoop(tools, [
        { name: "bash", arguments: { command: "swap d" } },
        { name: "write", arguments: { path: "d/t.txt", content: "planted\n" } },
      ]);

      // The write's first file operation comes after the shell has finished and put the directory back.
      expect(events).toEqual(["bash:start", "bash:end", "write:mkdir", "write:writeFile"]);
      expect(readdirSync(outside).sort()).toEqual(["f.txt"]);
      const landed = join(raceRoot, "d", "t.txt");
      expect(existsSync(landed) ? readFileSync(landed, "utf8") : "missing").toBe("planted\n");

      // read is not sequential itself; the shell is, so a message holding both runs one call at a time.
      events.length = 0;
      const results = await runPiLoop(tools, [
        { name: "bash", arguments: { command: "swap d" } },
        { name: "read", arguments: { path: "d/f.txt" } },
      ]);
      expect(events).toEqual(["bash:start", "bash:end", "read:readFile"]);
      expect(results.join("\n")).toContain("inside");
      expect(results.join("\n")).not.toContain("outside-secret");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("a read or write whose checked directory is swapped for an outside symlink before the open is refused, and no outside bytes are returned or written", async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "ccc-c2-swap-")));
    const swapRoot = join(base, "root");
    const outside = join(base, "outside");
    mkdirSync(join(swapRoot, "d"), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(swapRoot, "d", "f.txt"), "inside\n");
    writeFileSync(join(outside, "f.txt"), "outside-secret\n");
    const swap = () => {
      renameSync(join(swapRoot, "d"), join(swapRoot, "d.parked"));
      symlinkSync(outside, join(swapRoot, "d"));
    };
    const restore = () => {
      unlinkSync(join(swapRoot, "d"));
      renameSync(join(swapRoot, "d.parked"), join(swapRoot, "d"));
    };
    try {
      const ops = createCccConfinedFsOperations({ readRoots: [swapRoot], writeRoots: [swapRoot], deniedNames: DENIED });
      raceHook.beforeNextOpen = swap;
      const read = ops.read.readFile(join(swapRoot, "d", "f.txt")).then((bytes) => `resolved: ${bytes.toString("utf8")}`, (error: Error) => error.message);
      expect(await read).toMatch(/confined path refused \(outside-read-roots\)/);
      restore();

      raceHook.beforeNextOpen = swap;
      const written = ops.write.writeFile(join(swapRoot, "d", "t.txt"), "planted\n").then(() => "resolved", (error: Error) => error.message);
      expect(await written).toMatch(/confined path refused \(outside-write-roots\)/);
      restore();
      expect(existsSync(join(outside, "t.txt")) ? readFileSync(join(outside, "t.txt"), "utf8") : "").toBe("");
      expect(readFileSync(join(outside, "f.txt"), "utf8")).toBe("outside-secret\n");

      // A new file's name made a dangling symlink to an outside path before the open: refused, and nothing is created there.
      raceHook.beforeNextOpen = () => symlinkSync(join(outside, "created.txt"), join(swapRoot, "d", "new.txt"));
      const created = ops.write.writeFile(join(swapRoot, "d", "new.txt"), "planted\n").then(() => "resolved", (error: Error) => error.message);
      expect(await created).toMatch(/confined path refused \(outside-write-roots\)/);
      expect(existsSync(join(outside, "created.txt"))).toBe(false);
      unlinkSync(join(swapRoot, "d", "new.txt"));

      // Positive control: without the swap the same read and write land inside the root.
      expect((await ops.read.readFile(join(swapRoot, "d", "f.txt"))).toString("utf8")).toBe("inside\n");
      await ops.write.writeFile(join(swapRoot, "d", "t.txt"), "planted\n");
      expect(readFileSync(join(swapRoot, "d", "t.txt"), "utf8")).toBe("planted\n");
    } finally {
      raceHook.beforeNextOpen = null;
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("validates denied names against [A-Za-z0-9._*-] with a TypeError before any predicate call", () => {
    expect(() => createCccConfinedFsOperations({ readRoots: [root], writeRoots: [], deniedNames: ["bad/name"] }))
      .toThrow(TypeError);
    expect(() => createCccConfinedFsOperations({ readRoots: [root], writeRoots: [], deniedNames: ["bad/name"] }))
      .toThrow(/\[A-Za-z0-9\._\*-\]/);
    expect(cccConfinedWriteRefusal).not.toHaveBeenCalled();
  });
});
