/*
FNXC:CccToolchainDiscovery 2026-10-14-15:30:
Card X1b (request-to-code PRD v3 §8, D12; errata E2-25, E4-5, E4-15, E4-B).
G0, SF and WR take the writer shell's toolchain from `discoverCccToolchain`:
it finds each tool on a caller-given search path, and seals the result through
X1's `sealCccToolchain` (never by hand), each tool under its unprefixed name.

Why discovery is picky. Inside X1's sandbox only the per-instance clone of the
sealed toolchain can be executed, so a sealed tool must be a non-platform
Mach-O binary:
- an Apple platform binary (`/bin/bash`, `/usr/bin/grep`, ...) is killed by
  macOS when it runs from the clone, and X1 refuses to seal one
  (`platform-binary-in-toolchain`, E2-25). Discovery skips it and keeps
  looking, so a fallback to `/bin` or `/usr/bin` can never reach the seal;
- a script (`#!...`) needs its interpreter, which is not in the clone. On this
  host `/opt/homebrew/bin/git` is the SafeExec shim script
  (`#!/usr/bin/env bash`), so discovery skips scripts too and finds the real
  Cellar git further along the path (the default search path below ends with
  the Homebrew keg directories for exactly that reason).

Names. GNU tools on macOS come `g`-prefixed (`gcat`, `gsed`, `gawk`). For
every GNU tool discovery tries the unprefixed name, then the `g` name, in each
directory in order, and seals a file whose own name differs under the
unprefixed one (`{ path: .../gcat, name: "cat" }`), so it runs as `cat` inside.
`sh` comes from a non-platform `dash` when one is found, else from the
non-platform `bash` (E4-15); its clone is `bin/sh` either way, because X1 names
role clones by role and `sealCccToolchain` takes no name for a role.

What is sealed. Exactly the four roles (bash, sh, node, git) plus the tools the
caller requires; `required` defaults to the full catalogue
(`CCC_TOOLCHAIN_REQUIRED_TOOLS`: task, rg, a fixed set of GNU coreutils, and
GNU grep, sed, findutils, gawk and diffutils). The first required tool in
catalogue order that is missing refuses with `CccPlanningRefusal`
`CCC_PLANNING_CONFINEMENT_UNQUALIFIED`, detail `toolchain-missing:<tool>`
(E4-5). Relative search-path entries depend on the cwd and are ignored.

Host evidence (M5 Max, 2026-10-14): Homebrew bash, node@24, git, ripgrep,
go-task, coreutils and gnu-sed are present; GNU grep, findutils, gawk,
diffutils and dash are not, so the default catalogue refuses with
`toolchain-missing:grep` until they are installed, and `sh` is sealed from bash.
*/
import { accessSync, closeSync, constants as fsConstants, openSync, readSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { CccPlanningRefusal } from "@fusion/core";
import { sealCccToolchain, type CccSealedToolchain, type CccToolchainUtilitySpec } from "./confined-shell.js";

/** The four roles every sealed toolchain carries. */
export const CCC_TOOLCHAIN_ROLE_TOOLS: readonly string[] = Object.freeze(["bash", "sh", "node", "git"]);

/**
 * GNU tools sealed under their unprefixed names: a fixed set of coreutils that
 * package scripts and pnpm's sh shims use (`dirname`, `uname`, ...), then GNU
 * grep, sed, findutils (find, xargs), gawk (awk) and diffutils (diff, cmp).
 * `[` is left out: its name is not a valid sealed name (E2-25).
 */
export const CCC_TOOLCHAIN_GNU_TOOLS: readonly string[] = Object.freeze([
  "basename", "cat", "chmod", "comm", "cp", "cut", "date", "dirname", "du", "echo", "env", "expr", "false", "head",
  "id", "install", "ln", "ls", "md5sum", "mkdir", "mktemp", "mv", "nl", "nproc", "od", "paste", "printf", "pwd",
  "readlink", "realpath", "rm", "rmdir", "seq", "sha1sum", "sha256sum", "sleep", "sort", "split", "stat", "tac",
  "tail", "tee", "test", "timeout", "touch", "tr", "true", "uname", "uniq", "wc", "whoami", "yes",
  "grep", "sed", "find", "xargs", "awk", "diff", "cmp",
]);

/** The default `required` list: the roles, task, rg and the GNU tools, in the order a missing tool is reported. */
export const CCC_TOOLCHAIN_REQUIRED_TOOLS: readonly string[] = Object.freeze([
  ...CCC_TOOLCHAIN_ROLE_TOOLS, "task", "rg", ...CCC_TOOLCHAIN_GNU_TOOLS,
]);

const GNU_TOOLS: ReadonlySet<string> = new Set(CCC_TOOLCHAIN_GNU_TOOLS);
/** E2-25's sealed-name shape. */
const TOOL_NAME_SHAPE = /^[A-Za-z0-9._+-]{1,64}$/u;
/**
 * X1's platform prefixes, plus Apple's other executable homes (cryptexes and
 * `/Library/Apple`), whose binaries are platform binaries too. X1 re-checks its
 * own list when it seals; this list only keeps discovery looking further.
 */
const APPLE_PLATFORM_PREFIXES = [
  "/bin/", "/sbin/", "/usr/bin/", "/usr/sbin/", "/usr/libexec/", "/usr/lib/", "/System/",
  "/Library/Apple/", "/private/var/run/com.apple.security.cryptexd/",
] as const;
/** The first four bytes of a thin (64- or 32-bit, either byte order) or fat Mach-O file. */
const MACH_O_MAGICS: readonly string[] = ["cffaedfe", "cefaedfe", "feedfacf", "feedface", "cafebabe", "cafebabf"];
const HOMEBREW_PREFIXES = ["/opt/homebrew", "/usr/local"] as const;
/** Homebrew keg directories that hold the real binaries behind `<prefix>/bin` links and shims. */
const HOMEBREW_KEG_DIRS = [
  "opt/bash/bin", "opt/dash/bin", "opt/node/bin", "opt/git/bin", "opt/go-task/bin", "opt/ripgrep/bin",
  "opt/coreutils/libexec/gnubin", "opt/grep/libexec/gnubin", "opt/gnu-sed/libexec/gnubin",
  "opt/findutils/libexec/gnubin", "opt/gawk/libexec/gnubin", "opt/diffutils/bin",
] as const;

/**
 * The search path G0 uses: the entries of `env.PATH` in order, then the
 * Homebrew keg directories of both prefixes, so a host whose `<prefix>/bin/git`
 * is a shim script (as on the M5 Max) or whose service PATH is only
 * `/usr/bin:/bin` still finds the real binaries.
 */
export function cccToolchainDefaultSearchPath(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  const kegs = HOMEBREW_PREFIXES.flatMap((prefix) => HOMEBREW_KEG_DIRS.map((dir) => `${prefix}/${dir}`));
  return Object.freeze([...new Set([...(env.PATH ?? "").split(":").filter((entry) => entry !== ""), ...kegs])]);
}

function isApplePlatformPath(path: string): boolean {
  return APPLE_PLATFORM_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function machOMagic(path: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const head = Buffer.alloc(4);
    return readSync(fd, head, 0, 4, 0) === 4 ? head.toString("hex") : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** The real path of `dir/file` when it is an executable, non-platform Mach-O regular file; null otherwise. */
function usableCandidate(dir: string, file: string): string | null {
  let real: string;
  try {
    real = realpathSync(join(dir, file));
    if (!statSync(real).isFile()) return null;
    accessSync(real, fsConstants.X_OK);
  } catch {
    return null;
  }
  if (isApplePlatformPath(real)) return null;
  const magic = machOMagic(real);
  return magic !== null && MACH_O_MAGICS.includes(magic) ? real : null;
}

/** File names tried for `tool` in each directory: unprefixed first, then the GNU `g` name (gawk for awk). */
function candidateNames(tool: string): readonly string[] {
  if (!GNU_TOOLS.has(tool)) return [tool];
  return tool === "awk" ? ["awk", "gawk"] : [tool, `g${tool}`];
}

function findTool(dirs: readonly string[], tool: string): string | null {
  for (const dir of dirs) {
    for (const file of candidateNames(tool)) {
      const found = usableCandidate(dir, file);
      if (found !== null) return found;
    }
  }
  return null;
}

function missing(tool: string): never {
  throw new CccPlanningRefusal("CCC_PLANNING_CONFINEMENT_UNQUALIFIED", `toolchain-missing:${tool}`);
}

/**
 * Finds and seals the writer shell's toolchain on `searchPath` (see the file
 * header). Refuses a missing role or required tool with
 * `CCC_PLANNING_CONFINEMENT_UNQUALIFIED` / `toolchain-missing:<tool>`; a
 * malformed `searchPath` or tool name is a caller bug (`TypeError`). Errors
 * from `sealCccToolchain` (for example a git that cannot report its exec path)
 * pass through unchanged.
 */
export async function discoverCccToolchain(i: Readonly<{
  searchPath: readonly string[];
  required?: readonly string[];
}>): Promise<CccSealedToolchain> {
  if (!Array.isArray(i.searchPath) || i.searchPath.some((entry) => typeof entry !== "string")) {
    throw new TypeError("discoverCccToolchain: searchPath must be an array of strings");
  }
  const required = i.required ?? CCC_TOOLCHAIN_REQUIRED_TOOLS;
  if (!Array.isArray(required)) throw new TypeError("discoverCccToolchain: required must be an array of tool names");
  for (const tool of required) {
    if (typeof tool !== "string" || !TOOL_NAME_SHAPE.test(tool) || tool === "." || tool === "..") {
      throw new TypeError(`discoverCccToolchain: required tool ${JSON.stringify(tool)} must match ${TOOL_NAME_SHAPE.source}`);
    }
  }
  const dirs = [...new Set(i.searchPath.filter((entry) => isAbsolute(entry)))];

  const bash = findTool(dirs, "bash") ?? missing("bash");
  const sh = findTool(dirs, "dash") ?? bash;
  const node = findTool(dirs, "node") ?? missing("node");
  const git = findTool(dirs, "git") ?? missing("git");
  const utilities: CccToolchainUtilitySpec[] = [];
  const sealed = new Set(CCC_TOOLCHAIN_ROLE_TOOLS);
  for (const tool of required) {
    if (sealed.has(tool)) continue;
    sealed.add(tool);
    const path = findTool(dirs, tool) ?? missing(tool);
    utilities.push(basename(path) === tool ? path : { path, name: tool });
  }
  return sealCccToolchain({ bash, sh, node, git, utilities });
}
