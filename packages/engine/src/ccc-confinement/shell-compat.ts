/*
FNXC:CccShellCompat 2026-10-14-15:40:
Card X1b (request-to-code PRD v3 §8, D12; errata E2 "out of scope for X1",
E4-B): run package commands through the sealed toolchain inside X1's confined
shell. Required before the I3 held-out cases; I2 (pure `node --test` with
Taskfile) needs only discovery.

The constraint, measured on the M5 Max: inside X1's sandbox `process-exec` is
admitted only under the per-instance clone directory, and macOS checks it on
the script file itself, not only on its interpreter. So a `node_modules/.bin`
shim (`#!/bin/sh` from pnpm, a `#!/usr/bin/env node` link from npm) found by
PATH lookup fails with "bad interpreter: Operation not permitted", whatever
its shebang names, and no wrapper outside the clone can be executed directly.
A wrapper inside the clone would need the per-instance clone path in its
shebang, which does not exist when the toolchain is sealed. The shim layer
therefore never executes a script; it hands each one to a clone interpreter:

- The `BASH_ENV` dispatcher (`CCC_SHELL_COMPAT_BASH_ENV_SOURCE`). Every
  non-interactive bash of the toolchain sources it. It exports
  `npm_config_script_shell` as the clone's own `bash` (so npm and pnpm start
  their script shell from the clone, and that bash sources the dispatcher
  again), moves every `node_modules/.bin` entry out of PATH into
  `CCC_SHELL_COMPAT_SHIM_PATH`, and defines `command_not_found_handle`, which
  finds the command in those directories and then among the wrappers, and runs
  it through the clone interpreter its shebang names: `sh`/`dash` -> the
  toolchain `sh`, `bash` -> `bash`, `node` -> `node` (directly or through
  `env`, with or without `-S`); no shebang -> `sh`, as execve's ENOEXEC
  fallback would. Any other interpreter is refused with status 126 and a
  message naming it; nothing falls back to a platform binary.
- Wrappers: `npm` and `npx`, generated when npm sits next to the sealed node
  (`<node prefix>/lib/node_modules/npm`). Each carries a toolchain shebang (the
  sealed `sh`), never `/usr/bin/env`, and execs npm's own entry with `node`. The
  dispatcher reads that shebang and runs the wrapper through the clone's
  interpreter; outside the sandbox the wrapper runs as an ordinary script.
  npm's files must be readable inside the sandbox: they are on Homebrew node,
  whose `lib/` is a read root because `libnode` lives there.

Where it lives: `<scratch>/toolchains/ccc-shell-compat-<digest>/`. X1's profile
denies every write under `<scratch>/toolchains/` (E2-24) and admits reads of
the scratch root, so the dispatcher is read-only to every confined command.
The directory is published by an atomic rename and its bytes are re-checked
before every exec; a changed or extra file refuses the exec.

`withCccShellCompat(operations, …)` prefixes each command with one line that
exports `BASH_ENV` and sources the dispatcher (the first bash cannot read
`BASH_ENV` from its environment: X1 seals the environment and refuses
`BASH_`-prefixed task variables). It returns the same operations with only
`exec` replaced, so `dispose` is X1's own; `cccConfinedShellLastClosure` must
be read from the inner operations.

Residual, recorded: a shim run by an explicit path (`./node_modules/.bin/x`),
or found through a PATH entry added after the shell started, still fails with
"Operation not permitted", and so does a script spawned by a non-bash parent
(Taskfile's built-in shell, node's `child_process` without a shell): only bash
can consult `command_not_found_handle`. pnpm and yarn have no wrapper: their
Homebrew installs are not readable inside the sandbox and corepack needs the
network.
*/
import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import type { CccSealedToolchain } from "./confined-shell.js";

export const CCC_SHELL_COMPAT_SCHEMA = "ccc-shell-compat.v1" as const;

/**
 * The BASH_ENV dispatcher; see the file header. It depends on nothing but its own location and `$BASH`.
 * Written with `%{` for bash's `${` so the template literal does not interpolate; the dispatcher has no other `%{`.
 */
export const CCC_SHELL_COMPAT_BASH_ENV_SOURCE = String.raw`# ccc-shell-compat.v1 BASH_ENV dispatcher (card X1b). Sourced by every non-interactive bash of the
# sealed toolchain inside the confined shell, where only the toolchain clone can be executed.
__ccc_compat_bin=%{BASH%/*}
__ccc_compat_home=%{BASH_SOURCE[0]%/*}
export npm_config_script_shell="$__ccc_compat_bin/bash"

# Move node_modules/.bin entries out of PATH, newest first, so a shim reaches command_not_found_handle.
__ccc_compat_split_path() {
  local rest="$PATH:" dir keep= sep= shims=
  while [ -n "$rest" ]; do
    dir=%{rest%%:*}
    rest=%{rest#*:}
    case $dir in
      node_modules/.bin|*/node_modules/.bin|node_modules/.bin/|*/node_modules/.bin/)
        case ":$shims:" in *":$dir:"*) ;; *) shims=%{shims:+$shims:}$dir ;; esac ;;
      *) keep=$keep$sep$dir; sep=: ;;
    esac
  done
  rest=%{CCC_SHELL_COMPAT_SHIM_PATH:+$CCC_SHELL_COMPAT_SHIM_PATH:}
  while [ -n "$rest" ]; do
    dir=%{rest%%:*}
    rest=%{rest#*:}
    [ -n "$dir" ] || continue
    case ":$shims:" in *":$dir:"*) ;; *) shims=%{shims:+$shims:}$dir ;; esac
  done
  PATH=$keep
  export CCC_SHELL_COMPAT_SHIM_PATH="$shims"
}

__ccc_compat_find() {
  local rest dir
  rest=%{CCC_SHELL_COMPAT_SHIM_PATH:+$CCC_SHELL_COMPAT_SHIM_PATH:}
  while [ -n "$rest" ]; do
    dir=%{rest%%:*}
    rest=%{rest#*:}
    [ -n "$dir" ] || continue
    # Not -x: inside the sandbox access(X_OK) fails for every file outside the clone.
    if [ -f "$dir/$1" ] && [ -r "$dir/$1" ]; then
      __ccc_compat_found=$dir/$1
      return 0
    fi
  done
  if [ -f "$__ccc_compat_home/wrappers/$1" ]; then
    __ccc_compat_found=$__ccc_compat_home/wrappers/$1
    return 0
  fi
  return 1
}

# Runs a script through the toolchain interpreter its shebang names; never executes the script itself.
__ccc_compat_run() {
  local -
  local file=$1 first= prog= tool=
  local -a words=()
  shift
  set -f
  IFS= read -r first < "$file" || :
  case $first in
    '#!'*)
      first=%{first#'#!'}
      first=%{first%$'\r'}
      IFS=$' \t' read -r -a words <<< "$first" || :
      prog=%{words[0]-}
      words=("%{words[@]:1}")
      if [ "%{prog##*/}" = env ]; then
        prog=%{words[0]-}
        words=("%{words[@]:1}")
        if [ "$prog" = -S ]; then
          prog=%{words[0]-}
          words=("%{words[@]:1}")
        fi
      fi
      case %{prog##*/} in
        node|nodejs) tool=node ;;
        sh|dash) tool=sh ;;
        bash) tool=bash ;;
        *)
          printf 'ccc-shell-compat: %s needs %s, which the sealed toolchain does not provide\n' "$file" "%{prog:-an interpreter}" >&2
          return 126 ;;
      esac ;;
    *) tool=sh ;;
  esac
  "$__ccc_compat_bin/$tool" "%{words[@]}" "$file" "$@"
}

command_not_found_handle() {
  local __ccc_compat_found=
  if __ccc_compat_find "$1"; then
    shift
    __ccc_compat_run "$__ccc_compat_found" "$@"
    return
  fi
  printf 'bash: %s: command not found\n' "$1" >&2
  return 127
}

__ccc_compat_split_path
`.replaceAll("%{", "${");

/** A wrapper: `name` on the dispatcher's lookup, `target` the entry it runs with `node`, `source` its bytes. */
export type CccShellCompatWrapper = Readonly<{ name: string; target: string; source: string }>;
/** An installed shim layer under `<scratch>/toolchains/`. `sha256` digests every file it holds. */
export type CccShellCompatInstall = Readonly<{ dir: string; bashEnv: string; wrapperDir: string; sha256: string }>;

/** npm's own entries, relative to the npm package that ships next to node. */
const NPM_WRAPPERS = [
  ["npm", "bin/npm-cli.js"],
  ["npx", "bin/npx-cli.js"],
] as const;
const BASH_ENV_FILE = "bash-env";
const WRAPPER_DIR = "wrappers";
const INSTALL_PREFIX = "ccc-shell-compat-";

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, "'\\''")}'`;
}

/**
 * The wrappers for this toolchain: `npm` and `npx` when npm ships next to the
 * sealed node, each starting `#!<sealed sh>` and exec'ing npm's entry with
 * `node`. Empty when the node install carries no npm.
 */
export function cccShellCompatWrappers(toolchain: CccSealedToolchain): readonly CccShellCompatWrapper[] {
  const shebang = toolchain.sh.path;
  if (!/^\/\S+$/u.test(shebang)) {
    throw new TypeError(`ccc-shell-compat: the sealed sh path ${JSON.stringify(shebang)} cannot appear in a shebang`);
  }
  const npmRoot = join(dirname(dirname(toolchain.node.path)), "lib", "node_modules", "npm");
  const wrappers: CccShellCompatWrapper[] = [];
  for (const [name, entry] of NPM_WRAPPERS) {
    const candidate = join(npmRoot, entry);
    if (!existsSync(candidate)) continue;
    const target = realpathSync(candidate);
    wrappers.push(Object.freeze({
      name,
      target,
      source: [
        `#!${shebang}`,
        `# ${CCC_SHELL_COMPAT_SCHEMA} wrapper for ${name}: npm's own entry, run by the toolchain node.`,
        `exec node ${shellQuote(target)} "$@"`,
        "",
      ].join("\n"),
    }));
  }
  return Object.freeze(wrappers);
}

type CompatFile = Readonly<{ path: string; content: string; mode: number }>;

function compatFiles(toolchain: CccSealedToolchain): readonly CompatFile[] {
  return [
    { path: BASH_ENV_FILE, content: CCC_SHELL_COMPAT_BASH_ENV_SOURCE, mode: 0o444 },
    ...cccShellCompatWrappers(toolchain).map((wrapper) => ({ path: `${WRAPPER_DIR}/${wrapper.name}`, content: wrapper.source, mode: 0o555 })),
  ];
}

function compatDigest(files: readonly CompatFile[]): string {
  return createHash("sha256")
    .update(JSON.stringify({ schema: CCC_SHELL_COMPAT_SCHEMA, files: files.map((file) => [file.path, file.mode, file.content]) }))
    .digest("hex");
}

function isRealDirectory(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink() && realpathSync(path) === path;
  } catch {
    return false;
  }
}

/**
 * Re-checks an install against the bytes this toolchain implies: the directory
 * is a real directory, every file holds its bytes, and the wrappers directory
 * holds nothing else. Throws on any difference.
 */
export function verifyCccShellCompat(install: CccShellCompatInstall, toolchain: CccSealedToolchain): void {
  const files = compatFiles(toolchain);
  if (compatDigest(files) !== install.sha256 || !isRealDirectory(install.dir) || !isRealDirectory(install.wrapperDir)) {
    throw new Error(`ccc-shell-compat: ${install.dir} is not the shim layer installed for this toolchain`);
  }
  for (const file of files) {
    const path = join(install.dir, file.path);
    let bytes: string | null;
    try {
      bytes = lstatSync(path).isFile() ? readFileSync(path, "utf8") : null;
    } catch {
      bytes = null;
    }
    if (bytes !== file.content) throw new Error(`ccc-shell-compat: ${path} does not hold the installed bytes`);
  }
  const expected = files.filter((file) => file.path.startsWith(`${WRAPPER_DIR}/`)).map((file) => file.path.slice(WRAPPER_DIR.length + 1)).sort();
  const present = readdirSync(install.wrapperDir).sort();
  if (present.join("\u0000") !== expected.join("\u0000")) {
    throw new Error(`ccc-shell-compat: ${install.wrapperDir} holds ${JSON.stringify(present)}, not ${JSON.stringify(expected)}`);
  }
}

/**
 * Installs (or finds) the shim layer for `toolchain` under
 * `<scratchRoot>/toolchains/ccc-shell-compat-<digest>/`, publishing it with an
 * atomic rename, and verifies its bytes.
 */
export async function installCccShellCompat(i: Readonly<{ toolchain: CccSealedToolchain; scratchRoot: string }>): Promise<CccShellCompatInstall> {
  const scratchRoot = realpathSync(i.scratchRoot);
  const files = compatFiles(i.toolchain);
  const sha256 = compatDigest(files);
  const toolchains = join(scratchRoot, "toolchains");
  await mkdir(toolchains, { recursive: true });
  if (!isRealDirectory(toolchains)) throw new Error(`ccc-shell-compat: ${toolchains} is not a real directory`);
  const dir = join(toolchains, `${INSTALL_PREFIX}${sha256.slice(0, 16)}`);
  if (!existsSync(dir)) {
    const staging = join(toolchains, `.${INSTALL_PREFIX}staging-${randomBytes(8).toString("hex")}`);
    try {
      await mkdir(join(staging, WRAPPER_DIR), { recursive: true });
      for (const file of files) {
        const path = join(staging, file.path);
        await writeFile(path, file.content, { flag: "wx" });
        await chmod(path, file.mode);
      }
      try {
        await rename(staging, dir);
      } catch (error) {
        // Another session on this scratch root published the same digest first; its bytes are verified below.
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
      }
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
  const install: CccShellCompatInstall = Object.freeze({ dir, bashEnv: join(dir, BASH_ENV_FILE), wrapperDir: join(dir, WRAPPER_DIR), sha256 });
  verifyCccShellCompat(install, i.toolchain);
  return install;
}

/** The command with one line in front that exports `BASH_ENV` and sources the dispatcher, or exits 125. */
export function cccShellCompatCommand(install: CccShellCompatInstall, command: string): string {
  return `export BASH_ENV=${shellQuote(install.bashEnv)}; . "$BASH_ENV" || { echo 'ccc-shell-compat: the BASH_ENV dispatcher did not load' >&2; exit 125; }\n${command}`;
}

/**
 * The same operations with `exec` running every command through the shim
 * layer: the layer is installed on first use and re-verified before every exec.
 */
export function withCccShellCompat<T extends BashOperations>(
  operations: T,
  i: Readonly<{ toolchain: CccSealedToolchain; scratchRoot: string }>,
): T {
  let installing: Promise<CccShellCompatInstall> | undefined;
  const exec: BashOperations["exec"] = async (command, cwd, options) => {
    installing ??= installCccShellCompat(i);
    let install: CccShellCompatInstall;
    try {
      install = await installing;
    } catch (error) {
      installing = undefined;
      throw error;
    }
    verifyCccShellCompat(install, i.toolchain);
    return operations.exec(cccShellCompatCommand(install, command), cwd, options);
  };
  return { ...operations, exec } as T;
}
