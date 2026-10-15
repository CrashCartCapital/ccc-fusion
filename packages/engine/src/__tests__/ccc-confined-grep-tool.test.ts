import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
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

  it("bounds matches by the call limit and by limits.maxMatches, and skips a file larger than limits.maxBytesPerFile", async () => {
    const limited = text(await runGrep(confinedGrep(), { pattern: "needle", limit: 1 }));
    expect(limited.match(/: .*needle/g)).toHaveLength(1);

    const capped = text(await runGrep(confinedGrep(confinedOps(), { maxFiles: 100, maxBytesPerFile: 1024, maxMatches: 1 }), { pattern: "needle", limit: 50 }));
    expect(capped.match(/: .*needle/g)).toHaveLength(1);

    const small = text(await runGrep(confinedGrep(confinedOps(), { maxFiles: 100, maxBytesPerFile: 12, maxMatches: 100 }), { pattern: "needle" }));
    expect(small).not.toContain("a.ts:1");
    expect(small).not.toContain("second needle");
    // Positive control: the same files match under the default byte limit.
    expect(text(await runGrep(confinedGrep(), { pattern: "needle" }))).toContain("a.ts:1");
  });
});
