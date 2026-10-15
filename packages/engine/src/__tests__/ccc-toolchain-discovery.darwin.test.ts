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
scan is the positive control; it stays Darwin-only, and since repair 1 it
asserts the default discovery (every required tool sealed, nothing outside
the required and optional sets, every file under /opt/homebrew) rather than
reporting a full-catalogue result as evidence (E6-B item 4, E7-B item 6).

The single `skipIf(process.platform !== "darwin")` is the only skip form a
Darwin-tagged planning suite may carry (ADR D, skip policy).

FNXC:CccToolchainDiscovery 2026-10-14-17:15:
Repair 1 (errata E6-B items 2-4, E6-0). The default `required` set is the
minimal set (the roles, task, rg, GNU coreutils); GNU grep, sed, findutils,
gawk and diffutils are optional, sealed when found and silently left out
otherwise, and a caller may pass its own `optional` list. The default search
path is Homebrew only, so a tool that sits only in a user-writable PATH
directory (~/.local/bin, ~/go/bin, ...) is missing by default and found only
when the caller passes that directory; that test and the host scan read this
host's Homebrew. Directory-first lookup is pinned by an unprefixed `cat` in a
directory after the one holding `gcat` (loops-swapped mutant D12), and the
missing bash and node roles and the execute-permission check have tests.

FNXC:CccToolchainDiscovery 2026-10-14-18:33:
Repair 2 (errata E7-B items 5 and 6; test-only, discovery's source is
unchanged). Recorded limits of the default discovery, none of them a defect:
- Inside the sandbox `id -un` fails the way the dropped `whoami` did ("id:
  cannot find name for user ID 501", exit 1; re-probed on the M5 Max on
  2026-10-14), so only numeric `id` and `id -u` are supported, although `id`
  is in the required coreutils.
- `/opt/homebrew` is owned and writable by the operator account (on this host
  the SafeExec git shim lives in `/opt/homebrew/bin`), so "Homebrew only"
  keeps user-writable home directories off the path but does not mean
  protected. Sealing records each file's digest, so a binary changed after
  sealing fails closed.
- A keg-only `node@NN` that is not linked into `/opt/homebrew/bin` is not found
  by default: of node's directories the default path lists only
  `/opt/homebrew/opt/node/bin`. A caller passes the keg's `bin` explicitly.
- An optional tool that is found but that `sealCccToolchain` then rejects
  refuses the whole discovery instead of being left out (fails closed).
- Inside one directory the unprefixed name wins over the `g` name, so a
  Homebrew formula that installs an unprefixed coreutils or awk name in
  `/opt/homebrew/bin` (BWK `awk`, md5sha1sum's `md5sum`) would be sealed in
  place of the GNU build found by its `g` name in that same directory.
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
  CCC_TOOLCHAIN_OPTIONAL_TOOLS,
  CCC_TOOLCHAIN_REQUIRED_TOOLS,
  CCC_TOOLCHAIN_ROLE_TOOLS,
  cccToolchainDefaultSearchPath,
  discoverCccToolchain,
} from "../ccc-confinement/toolchain-discovery.js";

const MACH_O_64 = Buffer.from([0xcf, 0xfa, 0xed, 0xfe]);
/** E6-0: GNU grep, sed, findutils (find, xargs), gawk (awk) and diffutils (diff, cmp) are optional. */
const OPTIONAL_TOOLS: readonly string[] = ["grep", "sed", "find", "xargs", "awk", "diff", "cmp"];
const REFUSAL_CODE = "CCC_PLANNING_CONFINEMENT_UNQUALIFIED";
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

  function utilityNames(toolchain: CccSealedToolchain): string[] {
    return [...utilityByName(toolchain).keys()].sort();
  }

  /** The default required utilities: the required list without the four roles. */
  function requiredUtilities(): string[] {
    return CCC_TOOLCHAIN_REQUIRED_TOOLS.filter((tool) => !CCC_TOOLCHAIN_ROLE_TOOLS.includes(tool));
  }

  describe("fixture search path", () => {
    it("seals every required tool and every optional tool it finds from the non-platform directory under its unprefixed name, gcat as cat and gawk as awk, skipping the platform binaries in /bin and /usr/bin and a script shim earlier on the path", async () => {
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
      expect([...utilities.keys()].sort()).toEqual([...new Set([...requiredUtilities(), ...OPTIONAL_TOOLS])].sort());
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

    it("refuses a missing bash role as toolchain-missing:bash and a missing node role as toolchain-missing:node, skipping the platform /bin/bash, while the same paths with those binaries added seal them", async () => {
      expect(existsSync("/bin/bash")).toBe(true);
      const root = await fixtureRoot();
      const noBash = await brewDir(root, { omit: ["bash"] });
      const noNode = await brewDir(root, { omit: ["node"] });
      const later = join(root, "later-roles");
      await mkdir(later);
      const discover = (dir: string) => settle(discoverCccToolchain({
        searchPath: [...PLATFORM_DIRS, dir, later],
        required: ["cat"],
        optional: [],
      }));

      const bashMissing = await discover(noBash);
      const nodeMissing = await discover(noNode);
      await stub(later, "bash");
      await stub(later, "node");
      const bashFound = await discover(noBash);
      const nodeFound = await discover(noNode);

      expect(refusalOf(bashMissing.error)).toEqual({ code: REFUSAL_CODE, detail: "toolchain-missing:bash" });
      expect(refusalOf(nodeMissing.error)).toEqual({ code: REFUSAL_CODE, detail: "toolchain-missing:node" });
      expect(bashFound.error).toBeNull();
      expect(bashFound.value!.bash.path).toBe(join(later, "bash"));
      expect(bashFound.value!.sh.path).toBe(join(later, "bash"));
      expect(nodeFound.error).toBeNull();
      expect(nodeFound.value!.node.path).toBe(join(later, "node"));
    });

    it("skips a candidate without execute permission and takes the binary in a later directory, while the same candidate made executable is taken", async () => {
      const root = await fixtureRoot();
      const brew = await brewDir(root);
      const earlier = join(root, "no-exec");
      await mkdir(earlier);
      const unexecutable = await stub(earlier, "gcat");
      await chmod(unexecutable, 0o644);
      const discover = () => settle(discoverCccToolchain({ searchPath: [...PLATFORM_DIRS, earlier, brew], required: ["cat"], optional: [] }));

      const skipped = await discover();
      await chmod(unexecutable, 0o755);
      const taken = await discover();

      expect(skipped.error).toBeNull();
      expect(utilityByName(skipped.value!).get("cat")?.path).toBe(join(brew, "gcat"));
      expect(taken.error).toBeNull();
      expect(utilityByName(taken.value!).get("cat")?.path).toBe(unexecutable);
    });

    it("seals exactly the required tools plus the four roles when optional is empty, adds each optional tool it finds when optional is left at its default or named, and so seals a path without gawk without awk", async () => {
      const root = await fixtureRoot();
      const brew = await brewDir(root, { omit: ["awk"] });
      const searchPath = [...PLATFORM_DIRS, brew];

      const narrow = await settle(discoverCccToolchain({ searchPath, required: ["task", "cat", "sed"], optional: [] }));
      const narrowDefault = await settle(discoverCccToolchain({ searchPath, required: ["task", "cat"] }));
      const chosen = await settle(discoverCccToolchain({ searchPath, required: ["task"], optional: ["grep", "awk"] }));
      const full = await settle(discoverCccToolchain({ searchPath }));

      expect(narrow.error).toBeNull();
      expect(utilityNames(narrow.value!)).toEqual(["cat", "sed", "task"]);
      expect(narrow.value!.bash.path).toBe(join(brew, "bash"));
      expect(narrow.value!.git.path).toBe(join(brew, "git"));
      expect(narrowDefault.error).toBeNull();
      expect(utilityNames(narrowDefault.value!)).toEqual(["cat", "task", ...OPTIONAL_TOOLS.filter((tool) => tool !== "awk")].sort());
      expect(utilityByName(narrowDefault.value!).get("grep")).toEqual({ path: join(brew, "ggrep"), sha256: sha256(join(brew, "ggrep")), name: "grep" });
      expect(chosen.error).toBeNull();
      expect(utilityNames(chosen.value!)).toEqual(["grep", "task"]);
      expect(full.error).toBeNull();
      expect(utilityByName(full.value!).has("awk")).toBe(false);
    });

    it("treats GNU grep, sed, findutils, gawk and diffutils as optional by default, so a path without any of them still seals a toolchain without those names, while a missing coreutil still refuses toolchain-missing:dirname", async () => {
      const root = await fixtureRoot();
      const noOptional = await brewDir(root, { omit: OPTIONAL_TOOLS });
      const noDirname = await brewDir(root, { omit: [...OPTIONAL_TOOLS, "dirname"] });
      // The platform directories offer every optional tool, which discovery must still skip.
      for (const tool of OPTIONAL_TOOLS) expect(existsSync(`/usr/bin/${tool}`), `platform ${tool}`).toBe(true);

      const sealed = await settle(discoverCccToolchain({ searchPath: [...PLATFORM_DIRS, noOptional] }));
      const refused = await settle(discoverCccToolchain({ searchPath: [...PLATFORM_DIRS, noDirname] }));

      expect(sealed.error).toBeNull();
      expect(utilityNames(sealed.value!)).toEqual([...requiredUtilities()].sort());
      for (const tool of OPTIONAL_TOOLS) expect(utilityByName(sealed.value!).has(tool), tool).toBe(false);
      expect(refusalOf(refused.error)).toEqual({ code: REFUSAL_CODE, detail: "toolchain-missing:dirname" });
      // The default lists themselves: the optional set, and a required set without it or whoami (E6-0).
      expect(CCC_TOOLCHAIN_OPTIONAL_TOOLS).toEqual(OPTIONAL_TOOLS);
      expect(CCC_TOOLCHAIN_REQUIRED_TOOLS.filter((tool) => OPTIONAL_TOOLS.includes(tool) || tool === "whoami")).toEqual([]);
      expect(CCC_TOOLCHAIN_GNU_TOOLS).not.toContain("whoami");
      expect(CCC_TOOLCHAIN_REQUIRED_TOOLS.slice(0, 6)).toEqual(["bash", "sh", "node", "git", "task", "rg"]);
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
      // An unprefixed cat in a later directory: a name-first search would take it over earlier/gcat.
      await stub(gnubin, "cat");

      const { value: toolchain, error } = await settle(discoverCccToolchain({
        searchPath: [...PLATFORM_DIRS, earlier, gnubin, brew],
        required: ["cat", "sed"],
        optional: [],
      }));

      expect(error).toBeNull();
      const utilities = utilityByName(toolchain!);
      expect(utilities.get("sed")).toMatchObject({ path: join(brew, "gsed"), name: "sed" });
      expect(utilities.get("cat")).toEqual({ path: join(earlier, "gcat"), sha256: sha256(join(earlier, "gcat")), name: "cat" });
    });

    it("rejects a malformed required or optional name with a TypeError before any search, and ignores relative search-path entries, while the absolute entry is searched", async () => {
      const root = await fixtureRoot();
      const brew = await brewDir(root);
      // A relative entry that would resolve, from this process's cwd, to a directory holding another gcat.
      const elsewhere = join(root, "elsewhere");
      await mkdir(elsewhere);
      await stub(elsewhere, "gcat");
      const relativeEntry = relative(process.cwd(), elsewhere);
      expect(isAbsolute(relativeEntry)).toBe(false);

      const malformed = await settle(discoverCccToolchain({ searchPath: [brew], required: ["../cat"] }));
      const malformedOptional = await settle(discoverCccToolchain({ searchPath: [brew], required: ["cat"], optional: ["../grep"] }));
      const relativeFirst = await settle(discoverCccToolchain({ searchPath: [relativeEntry, brew], required: ["cat"] }));
      const absoluteFirst = await settle(discoverCccToolchain({ searchPath: [elsewhere, brew], required: ["cat"] }));

      expect(malformed.error).toBeInstanceOf(TypeError);
      expect(malformedOptional.error).toBeInstanceOf(TypeError);
      expect((malformedOptional.error as Error).message).toContain('"../grep"');
      expect(relativeFirst.error).toBeNull();
      expect(utilityByName(relativeFirst.value!).get("cat")?.path).toBe(join(brew, "gcat"));
      expect(utilityByName(absoluteFirst.value!).get("cat")?.path).toBe(join(elsewhere, "gcat"));
    });
  });

  describe("default search path (this host's Homebrew)", () => {
    it("keeps user-writable directories off the default search path, so a tool found only in a PATH directory such as ~/.local/bin is missing by default and found when the caller passes that directory explicitly", async () => {
      const root = await fixtureRoot();
      const userBin = join(root, "home", ".local", "bin");
      await mkdir(userBin, { recursive: true });
      const tool = `ccc-x1b-user-tool-${randomBytes(4).toString("hex")}`;
      await stub(userBin, tool);
      // The operator's PATH names the user-writable directory first, as this host's ~/.local/bin and ~/go/bin are.
      const savedPath = process.env.PATH;
      process.env.PATH = `${userBin}:${savedPath ?? ""}`;
      let defaults: readonly string[];
      try {
        defaults = cccToolchainDefaultSearchPath();
      } finally {
        if (savedPath === undefined) delete process.env.PATH;
        else process.env.PATH = savedPath;
      }

      const byDefault = await settle(discoverCccToolchain({ searchPath: defaults, required: [tool], optional: [] }));
      const explicit = await settle(discoverCccToolchain({ searchPath: [...defaults, userBin], required: [tool], optional: [] }));

      expect(refusalOf(byDefault.error)).toEqual({ code: REFUSAL_CODE, detail: `toolchain-missing:${tool}` });
      expect(explicit.error).toBeNull();
      expect(utilityByName(explicit.value!).get(tool)?.path).toBe(join(userBin, tool));
      expect(defaults).not.toContain(userBin);
      expect(defaults[0]).toBe("/opt/homebrew/bin");
      expect(defaults.filter((entry) => !entry.startsWith("/opt/homebrew/"))).toEqual([]);
    });
  });

  describe("host scan (positive control)", () => {
    it("discovers the default toolchain on this host from the Homebrew-only default search path, every sealed file under /opt/homebrew, and the sealed cat (from gcat) runs as cat inside X1's sandbox with task, rg and git", async () => {
      const scan = await settle(discoverCccToolchain({ searchPath: cccToolchainDefaultSearchPath() }));
      expect(scan.error).toBeNull();
      const toolchain = scan.value!;
      const utilities = utilityByName(toolchain);
      for (const tool of requiredUtilities()) expect(utilities.has(tool), tool).toBe(true);
      for (const name of utilities.keys()) expect(requiredUtilities().includes(name) || OPTIONAL_TOOLS.includes(name), name).toBe(true);
      expect(utilities.has("whoami")).toBe(false);
      const cat = utilities.get("cat");
      expect(cat?.name).toBe("cat");
      expect(basename(cat!.path)).toBe("gcat");
      for (const executable of [toolchain.bash, toolchain.sh, toolchain.node, toolchain.git, ...toolchain.utilities]) {
        expect(executable.path.startsWith("/opt/homebrew/"), executable.path).toBe(true);
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
