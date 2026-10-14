/*
FNXC:CccToolchainDiscovery 2026-10-14-15:20:
Card X1b (request-to-code PRD v3 §8, D12; errata E2-25, E4-5, E4-15, E4-B).
Discovery finds a non-platform toolchain on a search path and seals it through
X1's `sealCccToolchain`, each tool under its unprefixed name. X1 refuses an
Apple platform binary (`platform-binary-in-toolchain`), so a discovery that
falls back to `/bin` or `/usr/bin` cannot yield a toolchain X1 accepts: every
fixture search path below starts with the real `/bin` and `/usr/bin`, which
hold platform `bash`, `sh`, `dash`, `cat`, `grep`, `git` and friends.

The discovery REDs use fixture directories of stub executables (E4-15): a stub
is a file that starts with the 64-bit Mach-O magic and names its tool, so each
seals with its own digest, and the fixture `git` is a byte copy of the host's
real git, because sealing asks git for its exec path. A script shim shaped like
the host's SafeExec git shim sits earlier on the path, so a discovery that
accepts scripts seals a file that cannot run inside the sandbox. The real host
scan is the positive control; it stays Darwin-only and its full-catalogue
result is reported as evidence, not asserted (E4-15).

The single `skipIf(process.platform !== "darwin")` is the only skip form a
Darwin-tagged planning suite may carry (ADR D, skip policy).
*/
import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants, existsSync, readFileSync, realpathSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CccPlanningRefusal } from "@fusion/core";
import {
  CCC_WRITER_SHELL_PROFILE_TEMPLATE_SHA256,
  createCccConfinedBashOperations,
  readCccConfinementOsBuild,
  type CccSealedToolchain,
} from "../ccc-confinement/confined-shell.js";
import {
  CCC_TOOLCHAIN_GNU_TOOLS,
  CCC_TOOLCHAIN_REQUIRED_TOOLS,
  CCC_TOOLCHAIN_ROLE_TOOLS,
  cccToolchainDefaultSearchPath,
  discoverCccToolchain,
} from "../ccc-confinement/toolchain-discovery.js";

const MACH_O_64 = Buffer.from([0xcf, 0xfa, 0xed, 0xfe]);
const APPLE_PLATFORM = /^\/(?:bin|sbin|usr\/bin|usr\/sbin|usr\/libexec|usr\/lib|System)\//u;
/** The real platform directories every fixture search path starts with. */
const PLATFORM_DIRS = ["/bin", "/usr/bin"] as const;

/** The file name a Homebrew-style prefix gives each GNU tool: coreutils, grep, sed and findutils carry a `g`. */
function brewFileName(tool: string): string {
  if (tool === "awk") return "gawk";
  if (tool === "diff" || tool === "cmp") return tool;
  return `g${tool}`;
}

/** A real git binary, never the Homebrew SafeExec shim script or the /usr/bin xcrun shim. */
function hostGit(): string {
  for (const candidate of [process.env.FUSION_CCC_SEALED_GIT, "/opt/homebrew/opt/git/bin/git", "/usr/local/opt/git/bin/git"]) {
    if (!candidate || !existsSync(candidate)) continue;
    const real = realpathSync(candidate);
    if (readFileSync(real).subarray(0, 2).toString("latin1") !== "#!") return real;
  }
  throw new Error("no real git binary found for the fixture git");
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function refusalOf(error: unknown): { code: string; detail: string } | null {
  return error instanceof CccPlanningRefusal ? { code: error.code, detail: error.detail } : null;
}

async function settle<T>(promise: Promise<T>): Promise<{ value: T | null; error: unknown }> {
  try {
    return { value: await promise, error: null };
  } catch (error) {
    return { value: null, error };
  }
}

describe.skipIf(process.platform !== "darwin")("CCC toolchain discovery (Darwin)", () => {
  const roots: string[] = [];
  let gitSource: string;

  beforeAll(() => {
    gitSource = hostGit();
  });

  afterAll(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function fixtureRoot(): Promise<string> {
    const root = realpathSync(await mkdtemp(join(tmpdir(), "ccc-toolchain-discovery-")));
    roots.push(root);
    return root;
  }

  /** A stub executable: Mach-O magic plus its own name, so each one has its own digest. */
  async function stub(dir: string, file: string): Promise<string> {
    const path = join(dir, file);
    await writeFile(path, Buffer.concat([MACH_O_64, Buffer.from(`\nccc-x1b-stub ${file} ${randomBytes(4).toString("hex")}\n`)]));
    await chmod(path, 0o755);
    return path;
  }

  /**
   * A Homebrew-style bin directory holding every required tool: bash, node, a
   * copy of the real git, task and rg unprefixed, the GNU tools under their
   * `g` names (gawk for awk, diffutils unprefixed). `omit` leaves tools out.
   */
  async function brewDir(root: string, options: { omit?: readonly string[]; dash?: boolean } = {}): Promise<string> {
    const dir = join(root, `brew-${randomBytes(3).toString("hex")}`, "bin");
    await mkdir(dir, { recursive: true });
    const omit = new Set(options.omit ?? []);
    for (const tool of ["bash", "node", "task", "rg"]) if (!omit.has(tool)) await stub(dir, tool);
    if (!omit.has("git")) {
      await copyFile(gitSource, join(dir, "git"), fsConstants.COPYFILE_FICLONE);
      await chmod(join(dir, "git"), 0o755);
    }
    for (const tool of CCC_TOOLCHAIN_GNU_TOOLS) if (!omit.has(tool)) await stub(dir, brewFileName(tool));
    if (options.dash) await stub(dir, "dash");
    return dir;
  }

  /** A directory of script shims shaped like the host's SafeExec git shim: `#!/usr/bin/env bash`, then exec the real tool. */
  async function scriptShimDir(root: string, tools: Readonly<Record<string, string>>): Promise<string> {
    const dir = join(root, "shims");
    await mkdir(dir, { recursive: true });
    for (const [tool, target] of Object.entries(tools)) {
      await writeFile(join(dir, tool), `#!/usr/bin/env bash\n# fixture shim\nexec ${JSON.stringify(target)} "$@"\n`);
      await chmod(join(dir, tool), 0o755);
    }
    return dir;
  }

  function utilityByName(toolchain: CccSealedToolchain): Map<string, { path: string; name?: string }> {
    return new Map(toolchain.utilities.map((utility) => [utility.name ?? basename(utility.path), utility]));
  }

  describe("fixture search path", () => {
    it("seals every required tool from the non-platform directory under its unprefixed name, gcat as cat and gawk as awk, skipping the platform binaries in /bin and /usr/bin and a script shim earlier on the path", async () => {
      const root = await fixtureRoot();
      const brew = await brewDir(root);
      const shims = await scriptShimDir(root, { git: gitSource, cat: "/bin/cat" });
      const searchPath = [...PLATFORM_DIRS, shims, brew];
      // The fixture really offers the wrong answers first: platform binaries and script shims.
      for (const tool of ["bash", "sh", "cat", "grep", "sed", "find", "awk", "diff", "git"]) {
        expect(existsSync(`/bin/${tool}`) || existsSync(`/usr/bin/${tool}`), `platform ${tool}`).toBe(true);
      }

      const { value: toolchain, error } = await settle(discoverCccToolchain({ searchPath }));

      expect(error).toBeNull();
      expect(toolchain!.bash.path).toBe(join(brew, "bash"));
      expect(toolchain!.sh.path).toBe(join(brew, "bash"));
      expect(toolchain!.node.path).toBe(join(brew, "node"));
      expect(toolchain!.git.path).toBe(join(brew, "git"));
      expect(toolchain!.git.execPath).toBe(realpathSync(toolchain!.git.execPath));
      const utilities = utilityByName(toolchain!);
      const expectedUtilities = CCC_TOOLCHAIN_REQUIRED_TOOLS.filter((tool) => !CCC_TOOLCHAIN_ROLE_TOOLS.includes(tool));
      expect([...utilities.keys()].sort()).toEqual([...expectedUtilities].sort());
      expect(utilities.get("cat")).toEqual({ path: join(brew, "gcat"), sha256: sha256(join(brew, "gcat")), name: "cat" });
      expect(utilities.get("awk")).toEqual({ path: join(brew, "gawk"), sha256: sha256(join(brew, "gawk")), name: "awk" });
      // A tool whose file already carries its name is sealed without one, so its digest entry is unchanged.
      expect(utilities.get("task")).toEqual({ path: join(brew, "task"), sha256: sha256(join(brew, "task")) });
      expect(utilities.get("diff")).toEqual({ path: join(brew, "diff"), sha256: sha256(join(brew, "diff")) });
      for (const executable of [toolchain!.bash, toolchain!.sh, toolchain!.node, toolchain!.git, ...toolchain!.utilities]) {
        expect(executable.path).not.toMatch(APPLE_PLATFORM);
        expect(executable.path.startsWith(`${shims}/`)).toBe(false);
      }
    });

    it("seals sh from a non-platform dash when one is found, skipping the platform /bin/dash, and from the non-platform bash otherwise", async () => {
      expect(existsSync("/bin/dash")).toBe(true);
      const root = await fixtureRoot();
      const withDash = await brewDir(root, { dash: true });
      const withoutDash = await brewDir(root);

      const dashed = await settle(discoverCccToolchain({ searchPath: [...PLATFORM_DIRS, withDash] }));
      const plain = await settle(discoverCccToolchain({ searchPath: [...PLATFORM_DIRS, withoutDash] }));

      expect(dashed.error).toBeNull();
      expect(dashed.value!.sh).toEqual({ path: join(withDash, "dash"), sha256: sha256(join(withDash, "dash")) });
      expect(dashed.value!.bash.path).toBe(join(withDash, "bash"));
      expect(plain.error).toBeNull();
      expect(plain.value!.sh).toEqual(plain.value!.bash);
      expect(plain.value!.sh.path).toBe(join(withoutDash, "bash"));
    });

    it("refuses a missing required utility as CCC_PLANNING_CONFINEMENT_UNQUALIFIED toolchain-missing:rg, while the same path with rg added seals it", async () => {
      const root = await fixtureRoot();
      const brew = await brewDir(root, { omit: ["rg"] });
      const extra = join(root, "extra");
      await mkdir(extra);

      const missing = await settle(discoverCccToolchain({ searchPath: [...PLATFORM_DIRS, brew, extra] }));
      await stub(extra, "rg");
      const found = await settle(discoverCccToolchain({ searchPath: [...PLATFORM_DIRS, brew, extra] }));

      expect(refusalOf(missing.error)).toEqual({ code: "CCC_PLANNING_CONFINEMENT_UNQUALIFIED", detail: "toolchain-missing:rg" });
      expect(missing.error).toBeInstanceOf(CccPlanningRefusal);
      expect((missing.error as Error).message).toBe("CCC_PLANNING_CONFINEMENT_UNQUALIFIED: toolchain-missing:rg");
      expect(found.error).toBeNull();
      expect(utilityByName(found.value!).get("rg")?.path).toBe(join(extra, "rg"));
    });

    it("refuses a role found only as a platform binary or a script shim as toolchain-missing:git, while a non-platform git binary later on the path is sealed", async () => {
      expect(existsSync("/usr/bin/git")).toBe(true);
      const root = await fixtureRoot();
      const brew = await brewDir(root, { omit: ["git"] });
      const shims = await scriptShimDir(root, { git: gitSource });
      const later = join(root, "later");
      await mkdir(later);

      const missing = await settle(discoverCccToolchain({ searchPath: [...PLATFORM_DIRS, shims, brew, later] }));
      await copyFile(gitSource, join(later, "git"), fsConstants.COPYFILE_FICLONE);
      const found = await settle(discoverCccToolchain({ searchPath: [...PLATFORM_DIRS, shims, brew, later] }));

      expect(refusalOf(missing.error)).toEqual({ code: "CCC_PLANNING_CONFINEMENT_UNQUALIFIED", detail: "toolchain-missing:git" });
      expect(found.error).toBeNull();
      expect(found.value!.git.path).toBe(join(later, "git"));
    });

    it("seals exactly the tools a caller requires plus the four roles, so a path without gawk seals without awk, while the default list refuses toolchain-missing:awk", async () => {
      const root = await fixtureRoot();
      const brew = await brewDir(root, { omit: ["awk"] });
      const searchPath = [...PLATFORM_DIRS, brew];

      const narrow = await settle(discoverCccToolchain({ searchPath, required: ["task", "cat", "sed"] }));
      const full = await settle(discoverCccToolchain({ searchPath }));

      expect(narrow.error).toBeNull();
      expect([...utilityByName(narrow.value!).keys()].sort()).toEqual(["cat", "sed", "task"]);
      expect(narrow.value!.bash.path).toBe(join(brew, "bash"));
      expect(narrow.value!.git.path).toBe(join(brew, "git"));
      expect(refusalOf(full.error)).toEqual({ code: "CCC_PLANNING_CONFINEMENT_UNQUALIFIED", detail: "toolchain-missing:awk" });
    });

    it("takes the first directory on the path that holds a usable candidate, and inside one directory the unprefixed name before the g-prefixed one", async () => {
      const root = await fixtureRoot();
      const brew = await brewDir(root);
      const gnubin = join(root, "gnubin");
      const earlier = join(root, "earlier");
      await mkdir(gnubin);
      await mkdir(earlier);
      // gnubin-style: unprefixed links to the g-prefixed files, plus a stray g-prefixed file.
      await symlink(join(brew, "gsed"), join(gnubin, "sed"));
      await stub(gnubin, "gsed");
      await stub(earlier, "gcat");

      const { value: toolchain, error } = await settle(discoverCccToolchain({
        searchPath: [...PLATFORM_DIRS, earlier, gnubin, brew],
        required: ["cat", "sed"],
      }));

      expect(error).toBeNull();
      const utilities = utilityByName(toolchain!);
      expect(utilities.get("sed")).toMatchObject({ path: join(brew, "gsed"), name: "sed" });
      expect(utilities.get("cat")).toMatchObject({ path: join(earlier, "gcat"), name: "cat" });
    });

    it("rejects a malformed required name with a TypeError before any search, and ignores relative search-path entries, while the absolute entry is searched", async () => {
      const root = await fixtureRoot();
      const brew = await brewDir(root);
      // A relative entry that would resolve, from this process's cwd, to a directory holding another gcat.
      const elsewhere = join(root, "elsewhere");
      await mkdir(elsewhere);
      await stub(elsewhere, "gcat");
      const relativeEntry = relative(process.cwd(), elsewhere);
      expect(isAbsolute(relativeEntry)).toBe(false);

      const malformed = await settle(discoverCccToolchain({ searchPath: [brew], required: ["../cat"] }));
      const relativeFirst = await settle(discoverCccToolchain({ searchPath: [relativeEntry, brew], required: ["cat"] }));
      const absoluteFirst = await settle(discoverCccToolchain({ searchPath: [elsewhere, brew], required: ["cat"] }));

      expect(malformed.error).toBeInstanceOf(TypeError);
      expect(relativeFirst.error).toBeNull();
      expect(utilityByName(relativeFirst.value!).get("cat")?.path).toBe(join(brew, "gcat"));
      expect(utilityByName(absoluteFirst.value!).get("cat")?.path).toBe(join(elsewhere, "gcat"));
    });
  });

  describe("host scan (positive control)", () => {
    it("finds and seals bash, sh, node, git, task, rg and cat on this host from the default search path, and the sealed cat (from gcat) runs as cat inside X1's sandbox with task, rg and git", async () => {
      const scan = await settle(discoverCccToolchain({
        searchPath: cccToolchainDefaultSearchPath(),
        required: ["bash", "sh", "node", "git", "task", "rg", "cat"],
      }));
      expect(scan.error).toBeNull();
      const toolchain = scan.value!;
      const cat = utilityByName(toolchain).get("cat");
      expect(cat?.name).toBe("cat");
      expect(basename(cat!.path)).toBe("gcat");
      for (const executable of [toolchain.bash, toolchain.sh, toolchain.node, toolchain.git, ...toolchain.utilities]) {
        expect(executable.path).not.toMatch(APPLE_PLATFORM);
        expect(readFileSync(executable.path).subarray(0, 2).toString("latin1")).not.toBe("#!");
      }
      expect(["bash", "dash"]).toContain(basename(toolchain.sh.path));

      const root = await fixtureRoot();
      const worktree = join(root, "worktree");
      const scratchRoot = join(root, "scratch");
      await mkdir(join(worktree, "src"), { recursive: true });
      await mkdir(scratchRoot);
      const token = `readme-${randomBytes(6).toString("hex")}`;
      await writeFile(join(worktree, "README"), `${token}\n`);
      const operations = createCccConfinedBashOperations({
        profileId: "ccc-writer-shell.v1",
        worktreeRoot: worktree,
        gitDirs: [],
        writeRoots: [join(worktree, "src")],
        deniedNames: [],
        deniedRoots: [],
        scratchRoot,
        toolchain,
        taskEnv: {},
        limits: { wallMsCeiling: 600_000, cpuSeconds: 600, fileSizeBlocks: 2_097_152, maxOutputBytes: 1_048_576, maxReapPasses: 20 },
        qualification: {
          receiptSha256: createHash("sha256").update("x1b-test-receipt").digest("hex"),
          profileTemplateSha256: CCC_WRITER_SHELL_PROFILE_TEMPLATE_SHA256,
          osBuild: readCccConfinementOsBuild(),
        },
      });
      const chunks: Buffer[] = [];
      try {
        const { exitCode } = await operations.exec(
          `cat README; echo "cat-rc=$?"; command -v gcat; echo "gcat-lookup-rc=$?"; task --version; echo "task-rc=$?"; rg --version; echo "rg-rc=$?"; git --version; echo "git-rc=$?"`,
          worktree,
          { onData: (data) => chunks.push(data), timeout: 60 },
        );
        expect(exitCode).toBe(0);
      } finally {
        await operations.dispose();
      }
      const output = Buffer.concat(chunks).toString("utf8");
      expect(output).toContain(`${token}\ncat-rc=0`);
      expect(output).toContain("gcat-lookup-rc=1");
      expect(output).toMatch(/^task-rc=0$/mu);
      expect(output).toMatch(/^ripgrep \d/mu);
      expect(output).toMatch(/^rg-rc=0$/mu);
      expect(output).toMatch(/^git version \d/mu);
      expect(output).toMatch(/^git-rc=0$/mu);
    });
  });
});
