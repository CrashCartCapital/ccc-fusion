import { execFileSync } from "node:child_process";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createFindTool, createGrepTool } from "@earendil-works/pi-coding-agent";
import { CCC_PLANNING_DENIED_NAMES } from "@fusion/core";
import { cccConfinedEffectiveDeniedNames, cccConfinedWriteRefusal } from "../ccc-confinement/confined-shell.js";
import { CCC_CONFINED_TOOL_MARK, createCccConfinedFsOperations } from "../ccc-confinement/confined-fs-tools.js";
import { CCC_CONFINED_GREP_DEFAULT_LIMITS, createCccConfinedGrepTool } from "../ccc-confinement/confined-grep-tool.js";

/*
FNXC:CccConfinedGrepTool 2026-10-14-21:02:
Card C2 proof for the Fusion-owned grep (D11, CONTRACT-v3 section 2.13, verify-v2 item 47, errata E2-7 and E4-10). A planning session's grep and find never spawn a process: under an empty PATH with PI_OFFLINE=1 the confined grep and the confined find still return their matches, while Pi's own grep and find reject because they need rg and fd. Pi's tool directory is pointed at a path that does not exist before Pi loads, so a downloaded rg on the host cannot make the positive control pass. The grep's own path filter calls X1's cccConfinedWriteRefusal with writeRoots equal to the read roots, so a read root is never "outside the write roots" and only the .git and denied-name checks apply; it is proved with file operations that do not filter, so the grep alone keeps .env and .git lines out.
*/

const savedAgentDir = vi.hoisted(() => {
  const saved = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = `${process.env.TMPDIR ?? "/tmp"}/ccc-c2-grep-no-pi-agent-${process.pid}-never-created`;
  return saved;
});

vi.mock("../ccc-confinement/confined-shell.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ccc-confinement/confined-shell.js")>();
  return { ...actual, cccConfinedWriteRefusal: vi.fn(actual.cccConfinedWriteRefusal) };
});

const parent = realpathSync(mkdtempSync(join(tmpdir(), "ccc-c2-grep-")));
const root = join(parent, "root");
const outsideFile = join(parent, "outside.txt");
mkdirSync(join(root, "src", "deep"), { recursive: true });
mkdirSync(join(root, ".git"), { recursive: true });
writeFileSync(join(root, "src", "a.ts"), "needle one\nplain line\n");
writeFileSync(join(root, "src", "deep", "c.ts"), "first\nsecond needle\n");
writeFileSync(join(root, "src", "b.md"), "nothing here\n");
writeFileSync(join(root, ".env"), "NEEDLE_TOKEN=needle-secret\n");
writeFileSync(join(root, ".git", "HEAD"), "needle-in-git\n");
writeFileSync(outsideFile, "needle outside\n");

/*
FNXC:CccConfinedGrepTool 2026-10-14-22:30:
Card C2 repair 1 fixtures. They live under a second root so the main root's whole-tree searches never meet them: a directory with two symlinks to itself (a walk that follows links without remembering where it has been never ends), a real subdirectory beside them, a line on which a backtracking-heavy pattern needs exponential time, and a tree whose file cap is reached before the one file that holds the symbol.
*/
const extra = join(parent, "extra");
mkdirSync(join(extra, "loop", "real"), { recursive: true });
symlinkSync(".", join(extra, "loop", "a"));
symlinkSync(".", join(extra, "loop", "b"));
writeFileSync(join(extra, "loop", "real", "found.txt"), "loopneedle\n");
// 35 identifier characters plus " = 1;": a 40-character line that `^(\w+\s?)+$` cannot match, tried in about 2^35 ways.
const EVIL_IDENTIFIER_LENGTH = 35;
mkdirSync(join(extra, "redos"), { recursive: true });
writeFileSync(join(extra, "redos", "evil.ts"), `${"x".repeat(EVIL_IDENTIFIER_LENGTH)} = 1;\n`);
writeFileSync(join(extra, "redos", "fine.ts"), "alpha beta gamma\n");
mkdirSync(join(extra, "capped", "a"), { recursive: true });
mkdirSync(join(extra, "capped", "src"), { recursive: true });
for (const name of ["1.txt", "2.txt", "3.txt"]) writeFileSync(join(extra, "capped", "a", name), "filler\n");
writeFileSync(join(extra, "capped", "src", "target.ts"), "export const NEEDLE_SYMBOL = 1;\n");

afterAll(() => {
  rmSync(parent, { recursive: true, force: true });
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
});

const DENIED = [...CCC_PLANNING_DENIED_NAMES];

function confinedOps() {
  return createCccConfinedFsOperations({ readRoots: [root], writeRoots: [], deniedNames: DENIED });
}

function confinedGrep(fs = confinedOps(), limits = CCC_CONFINED_GREP_DEFAULT_LIMITS) {
  return createCccConfinedGrepTool({ fs, readRoots: [root], deniedNames: DENIED, limits });
}

function extraGrep(i: { limits?: typeof CCC_CONFINED_GREP_DEFAULT_LIMITS; matchDeadlineMs?: number } = {}) {
  const fs = createCccConfinedFsOperations({ readRoots: [extra], writeRoots: [], deniedNames: DENIED });
  return createCccConfinedGrepTool({
    fs,
    readRoots: [extra],
    deniedNames: DENIED,
    limits: i.limits ?? CCC_CONFINED_GREP_DEFAULT_LIMITS,
    ...(i.matchDeadlineMs === undefined ? {} : { matchDeadlineMs: i.matchDeadlineMs }),
  } as Parameters<typeof createCccConfinedGrepTool>[0]);
}

/** Confined operations whose readFile is a spy, so a test can tell which files the grep read. */
function spiedReadOps() {
  const confined = confinedOps();
  const readFile = vi.fn((path: string) => confined.read.readFile(path));
  return { ops: { ...confined, read: { ...confined.read, readFile } }, readFile };
}

/** File operations straight from node:fs that filter nothing, so only the grep's own path filter can hide a file. */
function unfilteredOps() {
  const confined = confinedOps();
  return {
    ...confined,
    read: { readFile: (path: string) => readFile(path), access: async () => undefined },
    ls: {
      exists: (path: string) => existsSync(path),
      stat: (path: string) => statSync(path),
      readdir: (path: string) => readdirSync(path),
    },
  };
}

function text(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.map((block) => block.text ?? "").join("\n");
}

type GrepParams = Record<string, unknown>;
const runGrep = (tool: ReturnType<typeof confinedGrep>, params: GrepParams) =>
  tool.execute("grep-call", params as never, undefined, undefined, undefined as never);

async function withEmptyPath<T>(run: () => Promise<T>): Promise<T> {
  const saved = { PATH: process.env.PATH, PI_OFFLINE: process.env.PI_OFFLINE };
  process.env.PATH = "";
  process.env.PI_OFFLINE = "1";
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("confined grep (card C2, D11)", () => {
  beforeEach(() => {
    vi.mocked(cccConfinedWriteRefusal).mockClear();
  });

  it("with an empty PATH and PI_OFFLINE=1 the confined grep and find return their matches while Pi's own grep and find reject", async () => {
    await withEmptyPath(async () => {
      const grepped = text(await runGrep(confinedGrep(), { pattern: "needle" }));
      expect(grepped).toContain("src/a.ts:1: needle one");
      expect(grepped).toContain("src/deep/c.ts:2: second needle");
      const found = text(await createFindTool(root, { operations: confinedOps().find }).execute("find-call", { pattern: "*.ts" }));
      expect(found.split("\n").sort()).toEqual(["src/a.ts", "src/deep/c.ts"]);

      // Positive control: under the same empty PATH, Pi's own tools need rg and fd and cannot run.
      await expect(createGrepTool(root).execute("pi-grep", { pattern: "needle" }))
        .rejects.toThrow("ripgrep (rg) is not available");
      await expect(createFindTool(root).execute("pi-find", { pattern: "*.ts" }))
        .rejects.toThrow("fd is not available");
    });
  });

  it("finds a match in an allowed file, refuses a path outside the roots, and never returns lines from .env inside a root", async () => {
    const grep = confinedGrep();

    expect(text(await runGrep(grep, { pattern: "needle", path: "src" }))).toContain("a.ts:1: needle one");
    await expect(runGrep(grep, { pattern: "needle", path: "../outside.txt" })).rejects.toThrow(/refused/);
    await expect(runGrep(grep, { pattern: "needle", path: outsideFile })).rejects.toThrow(/refused/);
    await expect(runGrep(grep, { pattern: "needle", path: ".env" })).rejects.toThrow(/refused/);
    const everything = text(await runGrep(grep, { pattern: "needle" }));
    expect(everything).not.toContain("needle-secret");
    expect(everything).not.toContain(".env");
    expect(everything).not.toContain("needle-in-git");
    expect(everything).not.toContain("outside");
    // Positive control: the denied file and the outside file really contain the pattern.
    expect(readFileSync(join(root, ".env"), "utf8")).toContain("needle");
    expect(readFileSync(outsideFile, "utf8")).toContain("needle");
  });

  it("its own path filter calls X1's cccConfinedWriteRefusal with writeRoots equal to readRoots, so file operations that filter nothing still never yield .env or .git lines", async () => {
    const raw = unfilteredOps();
    // Positive control: the unfiltered operations do list the denied file and the .git directory.
    expect(await raw.ls.readdir(root)).toEqual(expect.arrayContaining([".env", ".git", "src"]));

    const output = text(await runGrep(confinedGrep(raw as never), { pattern: "needle" }));
    expect(output).toContain("src/a.ts:1: needle one");
    expect(output).not.toContain("needle-secret");
    expect(output).not.toContain("needle-in-git");

    const calls = vi.mocked(cccConfinedWriteRefusal).mock.calls.map(([input]) => input);
    expect(calls.length).toBeGreaterThan(0);
    const effective = cccConfinedEffectiveDeniedNames(DENIED);
    for (const input of calls) expect(input).toEqual({ path: expect.any(String), writeRoots: [root], deniedNames: effective });
    expect(calls.map((input) => input.path)).toEqual(expect.arrayContaining([join(root, ".env"), join(root, "src", "a.ts")]));
    const results = vi.mocked(cccConfinedWriteRefusal).mock.results.map((result) => result.value);
    expect(results).toEqual(expect.arrayContaining(["denied-name", "git-segment", null]));
    expect(results).not.toContain("outside-write-roots");
  });

  it("is named grep, carries CCC_CONFINED_TOOL_MARK and Pi's grep parameter names, and refuses an invalid denied name with a TypeError before any predicate call", () => {
    const grep = confinedGrep() as unknown as Record<PropertyKey, unknown> & { name: string; parameters: { properties: object } };
    const piGrep = createGrepTool(root) as unknown as { parameters: { properties: object } };

    expect(grep.name).toBe("grep");
    expect(grep[CCC_CONFINED_TOOL_MARK]).toBe(true);
    expect(Object.keys(grep.parameters.properties).sort()).toEqual(Object.keys(piGrep.parameters.properties).sort());
    expect((piGrep as unknown as Record<PropertyKey, unknown>)[CCC_CONFINED_TOOL_MARK]).toBeUndefined();

    expect(() => createCccConfinedGrepTool({ fs: confinedOps(), readRoots: [root], deniedNames: ["a/b"], limits: CCC_CONFINED_GREP_DEFAULT_LIMITS }))
      .toThrow(TypeError);
    expect(cccConfinedWriteRefusal).not.toHaveBeenCalled();
  });

  it("bounds matches by the call limit and by limits.maxMatches, and skips a file larger than limits.maxBytesPerFile without reading it", async () => {
    const limited = text(await runGrep(confinedGrep(), { pattern: "needle", limit: 1 }));
    expect(limited.match(/: .*needle/g)).toHaveLength(1);

    const capped = text(await runGrep(confinedGrep(confinedOps(), { maxFiles: 100, maxBytesPerFile: 1024, maxMatches: 1 }), { pattern: "needle", limit: 50 }));
    expect(capped.match(/: .*needle/g)).toHaveLength(1);

    const smallLimits = { maxFiles: 100, maxBytesPerFile: 12, maxMatches: 100 };
    const walked = spiedReadOps();
    const small = text(await runGrep(confinedGrep(walked.ops as never, smallLimits), { pattern: "needle" }));
    expect(small).not.toContain("a.ts:1");
    expect(small).not.toContain("second needle");
    // The size from the walk's own stat decides: an oversized file is never read, in a walk or as the single searched file.
    const aTs = join(root, "src", "a.ts");
    const cTs = join(root, "src", "deep", "c.ts");
    expect(walked.readFile).not.toHaveBeenCalledWith(aTs);
    expect(walked.readFile).not.toHaveBeenCalledWith(cTs);
    const single = spiedReadOps();
    expect(text(await runGrep(confinedGrep(single.ops as never, smallLimits), { pattern: "needle", path: "src/a.ts" }))).toBe("No matches found");
    expect(single.readFile).not.toHaveBeenCalled();
    // Operations whose stat carries no size still never search an oversized file: the read bytes are measured instead.
    const sizeless = spiedReadOps();
    const sizelessOps = { ...sizeless.ops, ls: { ...sizeless.ops.ls, stat: async (path: string) => {
      const real = await sizeless.ops.ls.stat(path);
      // Repair 2: no size, but still a file type, because the grep searches only what its stat calls a regular file.
      return { isDirectory: () => real.isDirectory(), isFile: () => (real as { isFile?: () => boolean }).isFile?.() === true };
    } } };
    expect(text(await runGrep(confinedGrep(sizelessOps as never, smallLimits), { pattern: "needle", path: "src/a.ts" }))).toBe("No matches found");
    expect(sizeless.readFile).toHaveBeenCalledWith(aTs);
    // Positive control: under the default byte limit the same files are read and match.
    const full = spiedReadOps();
    expect(text(await runGrep(confinedGrep(full.ops as never), { pattern: "needle" }))).toContain("a.ts:1");
    expect(full.readFile).toHaveBeenCalledWith(aTs);
    expect(full.readFile).toHaveBeenCalledWith(cTs);
  });

  it("runs the pattern off the engine thread: ^(\\w+\\s?)+$ over a 40-character identifier line rejects with grep timed out inside the deadline while an unrelated timer keeps firing; positive control: the same pattern on a matching line returns the match", async () => {
    const deadlineMs = 300;
    const grep = extraGrep({ matchDeadlineMs: deadlineMs });
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 5);
    const started = performance.now();
    let outcome: string;
    let ticksDuringCall: number;
    try {
      outcome = await runGrep(grep, { pattern: "^(\\w+\\s?)+$", path: "redos/evil.ts" }).then(
        (result) => `resolved: ${text(result)}`,
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
      // Read before any later timer phase: a frozen event loop would leave this at 0.
      ticksDuringCall = ticks;
    } finally {
      clearInterval(timer);
    }
    const elapsed = performance.now() - started;
    expect(outcome).toMatch(/^grep timed out/);
    expect(outcome.length).toBeLessThan(300);
    expect(elapsed).toBeGreaterThanOrEqual(deadlineMs - 5);
    // The call ends at its deadline, not when the backtracking would (about 2^35 steps).
    expect(elapsed).toBeLessThan(deadlineMs + 10_000);
    expect(ticksDuringCall).toBeGreaterThan(0);
    expect(readFileSync(join(extra, "redos", "evil.ts"), "utf8")).toHaveLength(EVIL_IDENTIFIER_LENGTH + 6);

    expect(text(await runGrep(grep, { pattern: "^(\\w+\\s?)+$", path: "redos/fine.ts" }))).toBe("fine.ts:1: alpha beta gamma");
  });

  it("an abort ends a call whose pattern is still backtracking", async () => {
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 10);
    try {
      await expect(extraGrep().execute("grep-call", { pattern: "^(\\w+\\s?)+$", path: "redos/evil.ts" } as never, controller.signal, undefined, undefined as never))
        .rejects.toThrow("Operation aborted");
    } finally {
      clearTimeout(abortTimer);
    }
  });

  it("enters each directory once: two symlinks to their own directory end in No matches found without an abort; positive control: a real subdirectory beside them is searched once", async () => {
    const guard = new AbortController();
    const guardTimer = setTimeout(() => guard.abort(), 5_000);
    try {
      const grep = extraGrep();
      const run = (pattern: string) => grep.execute("grep-call", { pattern, path: "loop" } as never, guard.signal, undefined, undefined as never);
      expect(text(await run("absent-from-every-file"))).toBe("No matches found");
      expect(text(await run("loopneedle"))).toBe("real/found.txt:1: loopneedle");
      expect(guard.signal.aborted).toBe(false);
    } finally {
      clearTimeout(guardTimer);
    }
  });

  it("a search stopped by limits.maxFiles says so even when nothing matched; positive control: the narrowed path finds the symbol", async () => {
    const grep = extraGrep({ limits: { maxFiles: 2, maxBytesPerFile: 1024, maxMatches: 100 } });
    const truncated = await runGrep(grep, { pattern: "NEEDLE_SYMBOL", path: "capped" });
    expect(text(truncated)).toMatch(/^No matches found\n\n\[2 files limit reached/);
    expect((truncated as { details?: { fileLimitReached?: boolean } }).details?.fileLimitReached).toBe(true);

    expect(text(await runGrep(grep, { pattern: "NEEDLE_SYMBOL", path: "capped/src" }))).toBe("target.ts:1: export const NEEDLE_SYMBOL = 1;");
  });

  it("skips a FIFO inside a root without opening it: a whole-root search and a search of the FIFO itself settle at once, and the FIFO is never read; positive control: the regular file beside it is read and matched", async () => {
    /*
    FNXC:CccConfinedGrepTool 2026-10-15-00:20:
    Card C2 repair 2 (errata E14 item C2-1). A FIFO a confined writer made inside a root used to hang the grep in its read (no abort could end it) and hold a file-system thread. The walk now searches only regular files, and so does a search of one named path. The read spy shows the skip happens in the walk, before any open. A run on bytes without the fix is freed afterwards by opening the FIFO both ways for a moment.
    */
    const base = realpathSync(mkdtempSync(join(tmpdir(), "ccc-c2-grep-fifo-")));
    const fifoRoot = join(base, "root");
    mkdirSync(join(fifoRoot, "src"), { recursive: true });
    writeFileSync(join(fifoRoot, "src", "a.txt"), "needle alpha\n");
    const fifo = join(fifoRoot, "src", "pipe.txt");
    execFileSync("/usr/bin/mkfifo", [fifo], { stdio: ["ignore", "ignore", "pipe"] });
    const confined = createCccConfinedFsOperations({ readRoots: [fifoRoot], writeRoots: [], deniedNames: DENIED });
    const readFileSpy = vi.fn((path: string) => confined.read.readFile(path));
    const grep = createCccConfinedGrepTool({
      fs: { ...confined, read: { ...confined.read, readFile: readFileSpy } },
      readRoots: [fifoRoot],
      deniedNames: DENIED,
      limits: CCC_CONFINED_GREP_DEFAULT_LIMITS,
    });
    const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    const pending: Promise<string>[] = [];
    const watch = (params: GrepParams) => {
      const outcome = runGrep(grep, params).then((result) => text(result), (error: unknown) => `rejected: ${(error as Error)?.message}`);
      pending.push(outcome);
      return Promise.race([outcome, delay(2_000).then(() => "still pending")]);
    };
    let wholeRoot = "";
    let fifoOnly = "";
    try {
      wholeRoot = await watch({ pattern: "needle" });
      fifoOnly = await watch({ pattern: "needle", path: "src/pipe.txt" });
    } finally {
      const settled = Promise.allSettled(pending).then(() => true);
      for (let round = 0; round < 50 && !(await Promise.race([settled, delay(0).then(() => false)])); round += 1) {
        const descriptor = openSync(fifo, fsConstants.O_RDWR | fsConstants.O_NONBLOCK);
        await delay(50);
        closeSync(descriptor);
        await delay(20);
      }
    }
    try {
      expect(wholeRoot).toBe("src/a.txt:1: needle alpha");
      expect(fifoOnly).toBe("No matches found");
      expect(readFileSpy).not.toHaveBeenCalledWith(fifo);
      // Positive control: the regular file beside the FIFO was read, and the FIFO really is one.
      expect(readFileSpy).toHaveBeenCalledWith(join(fifoRoot, "src", "a.txt"));
      expect(statSync(fifo).isFIFO()).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
