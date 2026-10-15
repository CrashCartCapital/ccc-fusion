/*
FNXC:CccToolchainDiscovery 2026-10-14-17:20:
Card X1b (request-to-code PRD v3 §8, D12; errata E2-25, E4-5, E4-15, E4-B;
repair 1 per E6-0 and E6-B).
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
  Cellar git further along the path (the default search path below lists
  the Homebrew formula directories after `/opt/homebrew/bin` for exactly
  that reason).

Names. GNU tools on macOS come `g`-prefixed (`gcat`, `gsed`, `gawk`). For
every GNU tool discovery tries the unprefixed name, then the `g` name, in each
directory in order, and seals a file whose own name differs under the
unprefixed one (`{ path: .../gcat, name: "cat" }`), so it runs as `cat` inside.
`sh` comes from a non-platform `dash` when one is found, else from the
non-platform `bash` (E4-15). It is passed as `sealCccToolchain`'s `sh` path,
which always appears in PATH as `sh` (its clone is `bin/sh`), so no name field
is passed for it (E6-B item 7, v3.2 F4).

What is sealed (E6-0). The four roles (bash, sh, node, git), every tool in
`required`, and every tool in `optional` that is found. `required` defaults to
the minimal set every Fusion command needs (`CCC_TOOLCHAIN_REQUIRED_TOOLS`:
the roles, task, rg and a fixed set of GNU coreutils); the first required tool
in that order that is missing refuses with `CccPlanningRefusal`
`CCC_PLANNING_CONFINEMENT_UNQUALIFIED`, detail `toolchain-missing:<tool>`
(E4-5). `optional` defaults to GNU grep, sed, findutils, gawk and diffutils
(`CCC_TOOLCHAIN_OPTIONAL_TOOLS`): each is sealed under its unprefixed name
when found and silently left out when not, so a caller (the qualification
receipt, the planning prompts) names the missing ones by comparing that list
with the sealed utility names. Relative search-path entries depend on the cwd
and are ignored.

Default search path (E6-0). Homebrew only: `/opt/homebrew/bin`, then the
`opt/<formula>/bin` and `libexec/gnubin` directories of the formulae this
catalogue names. User-writable directories (`~/.local/bin`, `~/go/bin`,
`~/.cargo/bin` and the like) and the operator's PATH are never on it, nor is
Intel Homebrew's `/usr/local`; a caller may still pass any of them in an
explicit `searchPath`. `whoami` is not in the catalogue, because it fails
inside the sandbox.

Host evidence (M5 Max, 2026-10-14, a probe of the default discovery): Homebrew
bash, node@24, git (behind the SafeExec shim script in `/opt/homebrew/bin`),
ripgrep, go-task, coreutils and gnu-sed are present; GNU grep, findutils, gawk,
diffutils and dash are not. The default discovery took 1.1 s and sealed 54
utilities (task from go-task 3.48.0, no longer `~/go/bin/task`; rg; the 51
coreutils; and `sed`), every file under `/opt/homebrew/`; it left grep, find,
xargs, awk, diff and cmp out, and sealed `sh` from bash.
*/
import { accessSync, closeSync, constants as fsConstants, openSync, readSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { CccPlanningRefusal } from "@fusion/core";
import { sealCccToolchain, type CccSealedToolchain, type CccToolchainUtilitySpec } from "./confined-shell.js";

/** The four roles every sealed toolchain carries. */
export const CCC_TOOLCHAIN_ROLE_TOOLS: readonly string[] = Object.freeze(["bash", "sh", "node", "git"]);

/**
 * The GNU coreutils every sealed toolchain carries, under their unprefixed
 * names: a fixed set that package scripts and pnpm's sh shims use (`dirname`,
 * `uname`, ...). `[` is left out: its name is not a valid sealed name (E2-25);
 * so is `whoami`, which fails inside the sandbox (E6-0).
 */
const GNU_COREUTILS: readonly string[] = Object.freeze([
  "basename", "cat", "chmod", "comm", "cp", "cut", "date", "dirname", "du", "echo", "env", "expr", "false", "head",
  "id", "install", "ln", "ls", "md5sum", "mkdir", "mktemp", "mv", "nl", "nproc", "od", "paste", "printf", "pwd",
  "readlink", "realpath", "rm", "rmdir", "seq", "sha1sum", "sha256sum", "sleep", "sort", "split", "stat", "tac",
  "tail", "tee", "test", "timeout", "touch", "tr", "true", "uname", "uniq", "wc", "yes",
]);

/**
 * The default `optional` list (E6-0): GNU grep, sed, findutils (find, xargs),
 * gawk (awk) and diffutils (diff, cmp), sealed under their unprefixed names
 * when found and silently left out when not.
 */
export const CCC_TOOLCHAIN_OPTIONAL_TOOLS: readonly string[] = Object.freeze(["grep", "sed", "find", "xargs", "awk", "diff", "cmp"]);

/** Every GNU tool discovery looks for under its unprefixed name, then its `g` name: the coreutils, then the optional tools. */
export const CCC_TOOLCHAIN_GNU_TOOLS: readonly string[] = Object.freeze([...GNU_COREUTILS, ...CCC_TOOLCHAIN_OPTIONAL_TOOLS]);

/**
 * The default `required` list (E6-0), the minimal set every Fusion command
 * needs: the roles, task, rg and the GNU coreutils, in the order a missing
 * tool is reported.
 */
export const CCC_TOOLCHAIN_REQUIRED_TOOLS: readonly string[] = Object.freeze([
  ...CCC_TOOLCHAIN_ROLE_TOOLS, "task", "rg", ...GNU_COREUTILS,
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
const HOMEBREW_PREFIX = "/opt/homebrew";
/**
 * The Homebrew formulae this catalogue names, each with the directories under
 * `opt/<formula>/` that hold its real binaries: `bin`, plus `libexec/gnubin`
 * (the unprefixed names) for the GNU formulae that install `g`-prefixed tools.
 */
const HOMEBREW_FORMULA_DIRS: readonly (readonly [string, readonly string[]])[] = [
  ["bash", ["bin"]], ["dash", ["bin"]], ["node", ["bin"]], ["git", ["bin"]], ["go-task", ["bin"]], ["ripgrep", ["bin"]],
  ["coreutils", ["bin", "libexec/gnubin"]], ["grep", ["bin", "libexec/gnubin"]], ["gnu-sed", ["bin", "libexec/gnubin"]],
  ["findutils", ["bin", "libexec/gnubin"]], ["gawk", ["bin", "libexec/gnubin"]], ["diffutils", ["bin"]],
];

/**
 * The search path G0, SF and WR use (E6-0): Homebrew only, `/opt/homebrew/bin`
 * and then each catalogue formula's own directories, so a host whose
 * `/opt/homebrew/bin/git` is a shim script (as on the M5 Max) still finds the
 * real binary. Never the operator's PATH, and never a user-writable directory
 * such as `~/.local/bin`, `~/go/bin` or `~/.cargo/bin`; a caller that wants one
 * passes it in an explicit `searchPath`.
 */
export function cccToolchainDefaultSearchPath(): readonly string[] {
  return Object.freeze([
    `${HOMEBREW_PREFIX}/bin`,
    ...HOMEBREW_FORMULA_DIRS.flatMap(([formula, dirs]) => dirs.map((dir) => `${HOMEBREW_PREFIX}/opt/${formula}/${dir}`)),
  ]);
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

/** A caller's tool list, checked before any search: an array of names in E2-25's sealed-name shape. */
function toolList(value: unknown, label: "required" | "optional"): readonly string[] {
  if (!Array.isArray(value)) throw new TypeError(`discoverCccToolchain: ${label} must be an array of tool names`);
  for (const tool of value) {
    if (typeof tool !== "string" || !TOOL_NAME_SHAPE.test(tool) || tool === "." || tool === "..") {
      throw new TypeError(`discoverCccToolchain: ${label} tool ${JSON.stringify(tool)} must match ${TOOL_NAME_SHAPE.source}`);
    }
  }
  return value as readonly string[];
}

/**
 * Finds and seals the writer shell's toolchain on `searchPath` (see the file
 * header). Refuses a missing role or required tool with
 * `CCC_PLANNING_CONFINEMENT_UNQUALIFIED` / `toolchain-missing:<tool>`, and
 * seals each optional tool only when it is found; a malformed `searchPath` or
 * tool name is a caller bug (`TypeError`). Errors from `sealCccToolchain` (for
 * example a git that cannot report its exec path) pass through unchanged.
 */
export async function discoverCccToolchain(i: Readonly<{
  searchPath: readonly string[];
  required?: readonly string[];
  optional?: readonly string[];
}>): Promise<CccSealedToolchain> {
  if (!Array.isArray(i.searchPath) || i.searchPath.some((entry) => typeof entry !== "string")) {
    throw new TypeError("discoverCccToolchain: searchPath must be an array of strings");
  }
  const required = toolList(i.required ?? CCC_TOOLCHAIN_REQUIRED_TOOLS, "required");
  const optional = toolList(i.optional ?? CCC_TOOLCHAIN_OPTIONAL_TOOLS, "optional");
  const dirs = [...new Set(i.searchPath.filter((entry) => isAbsolute(entry)))];

  const bash = findTool(dirs, "bash") ?? missing("bash");
  const sh = findTool(dirs, "dash") ?? bash;
  const node = findTool(dirs, "node") ?? missing("node");
  const git = findTool(dirs, "git") ?? missing("git");
  const utilities: CccToolchainUtilitySpec[] = [];
  const sealed = new Set(CCC_TOOLCHAIN_ROLE_TOOLS);
  const add = (tool: string, path: string) => {
    sealed.add(tool);
    utilities.push(basename(path) === tool ? path : { path, name: tool });
  };
  for (const tool of required) {
    if (!sealed.has(tool)) add(tool, findTool(dirs, tool) ?? missing(tool));
  }
  // E6-0: an optional tool is sealed when it is found and silently left out when it is not.
  for (const tool of optional) {
    if (sealed.has(tool)) continue;
    const path = findTool(dirs, tool);
    if (path !== null) add(tool, path);
  }
  return sealCccToolchain({ bash, sh, node, git, utilities });
}
