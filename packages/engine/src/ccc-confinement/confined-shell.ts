/*
FNXC:CccConfinedShell 2026-10-14-08:30:
Card X1 (request-to-code PRD v3 §8, D12, ADR C Q3). Today the Build writer's
bash tool is Pi's raw host shell: detached, full host environment, no default
timeout. Every model-authored shell command must instead run under the
`ccc-writer-shell.v1` sandbox-exec profile with a sealed toolchain, a sealed
environment and a proven descendant closure. There is no fallback: any
condition the profile cannot enforce is a `CCC_CONFINEMENT_REFUSED` before a
process exists, and an unproven closure is `CCC_CONFINEMENT_CLOSURE_UNCONFIRMED`.

Reuse, not a parallel spawner (challenge 25): the process runs through
`runCccDarwinSandboxedProcess`, the runner behind the semantic-proof sandbox
(`runCccSemanticProofSandboxedProcess`), and the profile is assembled from that
file's canonicalisation, SBPL escaping, ancestor-metadata pattern, dylib closure
discovery and `localhost:<port>` loopback form. Only the writer-specific rules
differ: exec confined to the per-instance clone, worktree and write roots,
denies emitted after allows (probe P9), `(target same-sandbox)` signals (P6),
and no mach, shm or system-socket grants (P1, P2).

FNXC:CccConfinedShell 2026-10-14-11:10:
Errata E1-18 (ADR X1-R): closure authority is the controller, outside the
sandbox. An in-sandbox reaper cannot be the authority, because the profile's
`(allow signal (target same-sandbox))` lets the confined command kill or freeze
it, after which its descendants keep running (review probes P4, P6).

- Each operations instance clones the sealed executables (APFS clonefile, full
  copy across volumes) into its own `<scratch>/.ccc-exec-<random>` directory,
  mirroring their absolute paths so `@loader_path` dylibs resolve, with a `bin/`
  of role-named symlinks as PATH. `process-exec` is admitted only under that
  directory, and the profile denies every write to it, so a hard link out of it
  is refused, a copy cannot run, and a symlink still runs the clone. Every
  sandboxed process therefore runs from that directory.
- macOS kills an Apple platform binary (`/bin/bash`, `/bin/cat`, ...) copied off
  the system volume, so platform binaries cannot be sealed. The toolchain is
  Homebrew-style: a non-platform bash (sealed as `sh` too: bash run as `sh` is
  POSIX mode), node, git and utilities, which appear in PATH under their own
  real names (coreutils' `gcat`, not `cat`). Absolute-path shebangs such as
  `#!/bin/sh` and `#!/usr/bin/env` cannot run inside; invoke the interpreter.
- After every exec that started a process (normal, error, timeout and
  qualification-failure paths) the controller finds every same-uid process
  whose `lsof` txt mapping is one of the clone's inodes (argv[0] spoofing with
  `exec -a` cannot hide it; `ps comm` can be fooled), SIGSTOPs each, re-scans
  until no new pid appears, SIGKILLs the confirmed set, and requires two
  consecutive empty scans, within a bounded number of scans. A converged sweep
  confirms closure even when the reaper died or froze. A sweep that does not
  converge is CLOSURE_UNCONFIRMED: descendants may still be running with write
  access to the write roots and scratch and network access to the admitted
  loopback port, so quarantine means moving the write roots out of place and
  closing the admitted loopback listener, not only flagging the worktree.
  Cost: every exec pays at least two lsof scans (about 0.3 s each measured on
  the M5 Max), and a command that leaves a survivor pays about four.
- The in-sandbox reaper stays as the fast first line. Launch shape:
  `sandbox-exec -p <profile> <cloned node> -e REAPER_SOURCE -- ...`. It spawns
  bash detached with its own pipes, relays at most `maxOutputBytes`, and on
  bash exit, controller `reap`, or stdin EOF kills bash's group, then sweeps pid
  2..99999 with signal 0 and SIGKILLs every answer until two consecutive passes
  find nothing new (P6-P8). It never sweeps unless signalling the controller
  fails with EPERM, so it cannot run outside a sandbox, and it never uses
  kill(-1). It writes one framed closure record to fd 3. Its `killed` list can
  name a foreign zombie (P7: a zombie answers signal 0).
- Execs on one instance are serialized, so the last-closure record and the
  shared scratch home and tmp belong to one command at a time (E1-20).

Residual (recorded, not closed here): a process that forks and exits faster
than one lsof pass can evade a snapshot scan; the per-user process limit
bounds it, and the sweep stops what it sees before killing it.
*/
import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { connect as netConnect, createServer, type Server } from "node:net";
import { constants as osConstants } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { superviseSpawn, type SupervisedChild } from "@fusion/core";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import {
  acquireCccSemanticProofLoopbackPort,
  cccCanonicalExistingPath,
  cccDarwinLinkedRuntimeFiles,
  cccIsSameOrWithin,
  cccPathAncestors,
  cccSbplLiteral,
  cccSbplLoopbackPortRules,
  cccSbplSubpath,
  cccUniqueSortedPaths,
  readCccSemanticProofSandboxReadiness,
  runCccDarwinSandboxedProcess,
} from "../ccc-campaign-proof-sandbox.js";

export type CccSealedExecutable = Readonly<{ path: string; sha256: string }>;
export type CccSealedToolchain = Readonly<{
  bash: CccSealedExecutable;
  sh: CccSealedExecutable;
  node: CccSealedExecutable;
  git: CccSealedExecutable & Readonly<{ execPath: string }>;
  utilities: readonly CccSealedExecutable[];
  toolchainSha256: string;
}>;
export type CccConfinementLimits = Readonly<{
  wallMsCeiling: number; // 600_000
  cpuSeconds: number; // 600
  fileSizeBlocks: number; // 512-byte blocks
  maxOutputBytes: number; // 1_048_576
  maxReapPasses: number; // 20
}>;
export type CccConfinedShellInput = Readonly<{
  profileId: "ccc-writer-shell.v1";
  worktreeRoot: string;
  gitDirs: readonly string[];
  writeRoots: readonly string[];
  deniedNames: readonly string[];
  deniedRoots: readonly string[];
  scratchRoot: string;
  toolchain: CccSealedToolchain;
  taskEnv: Readonly<Record<string, string>>;
  loopbackPort?: number;
  limits: CccConfinementLimits;
  qualification: Readonly<{ receiptSha256: string; profileTemplateSha256: string; osBuild: string }>;
}>;
export type CccClosureRecord = Readonly<{ passes: number; killed: readonly number[]; persistent: readonly number[] }>;

export type CccConfinementRefusalReason =
  | "platform-unsupported"
  | "sandbox-exec-missing"
  | "toolchain-digest-drift"
  | "root-overlap"
  | "qualification-missing"
  | "taskenv-not-allowlisted";

export class CccConfinementRefusedError extends Error {
  readonly code = "CCC_CONFINEMENT_REFUSED" as const;
  readonly reason: CccConfinementRefusalReason;
  constructor(reason: CccConfinementRefusalReason, message: string) {
    super(`CCC_CONFINEMENT_REFUSED (${reason}): ${message}`);
    this.name = "CccConfinementRefusedError";
    this.reason = reason;
  }
}

export class CccConfinementClosureError extends Error {
  readonly code = "CCC_CONFINEMENT_CLOSURE_UNCONFIRMED" as const;
  readonly record: CccClosureRecord | null;
  constructor(record: CccClosureRecord | null, message: string) {
    super(`CCC_CONFINEMENT_CLOSURE_UNCONFIRMED: ${message}`);
    this.name = "CccConfinementClosureError";
    this.record = record;
  }
}

export type CccConfinementQualificationProbe =
  | "network-denied"
  | "loopback-port-allowed"
  | "outside-read-denied"
  | "sibling-signal-denied"
  | "denied-name-in-root"
  | "env-scrubbed"
  | "escaper-reaped";

export type CccConfinementQualificationV1 = Readonly<{
  schema: "ccc-confinement-qualification.v1";
  osBuild: string;
  profileTemplateSha256: string;
  toolchainSha256: string;
  probes: readonly Readonly<{ probe: CccConfinementQualificationProbe; passed: boolean }>[];
}>;

const PROFILE_ID = "ccc-writer-shell.v1";
const PID_SWEEP_MAX = 99_999;
const REAP_PASS_BUDGET_MS = 1_000;
const REAP_BASE_BUDGET_MS = 5_000;
const CAPTURE_TIMEOUT_MS = 10_000;
const CAPTURE_KILL_GRACE_MS = 1_000;
const CAPTURE_MAX_OUTPUT_BYTES = 16 * 1_024 * 1_024;
const CAPTURE_ENV: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C" };
const LSOF_EXECUTABLE = "/usr/sbin/lsof";
const PS_EXECUTABLE = "/bin/ps";
const CLONE_DIR_PREFIX = ".ccc-exec-";
const CONTROLLER_SWEEP_MAX_SCANS = 20;
const CONTROLLER_SWEEP_SETTLE_MS = 50;
const CLOSURE_FRAME_PREFIX = "CCC-CLOSURE ";
const EXITED_FRAME_PREFIX = "CCC-EXITED ";
const SHA256_HEX = /^[0-9a-f]{64}$/u;
const SYSTEM_RUNTIME_READ_ROOTS = [
  "/System/Library",
  "/usr/lib",
  "/private/var/db/dyld",
  "/usr/share/zoneinfo",
  "/private/var/db/timezone",
] as const;
const DEVICE_READ_FILES = ["/dev/null", "/dev/urandom"] as const;
const DEFAULT_DENIED_NAMES = [".env", ".env.*", ".agentsecrets", "_secrets", ".npmrc"] as const;
/** Names bash itself exports to every child, beyond the sealed and task keys. */
const SHELL_ADDED_ENV_KEYS = ["PWD", "SHLVL", "_", "OLDPWD"] as const;
/**
 * Apple platform binaries live on the sealed system volume; macOS kills a copy
 * of one that runs from anywhere else, so they cannot join a per-instance clone.
 */
const APPLE_PLATFORM_PREFIXES = ["/bin/", "/sbin/", "/usr/bin/", "/usr/sbin/", "/usr/libexec/", "/usr/lib/", "/System/"] as const;
/** Any `.git` path segment, inside a write root or anywhere else (E1-20). */
const GIT_SEGMENT_WRITE_DENY = '(deny file-write* (regex #"/\\.git(/.*)?$"))';

/**
 * Bash wrapper: `$0` is the sealed bash, `$1` the CPU seconds, `$2` the file-size
 * limit in 512-byte blocks (POSIX mode), `$3` the model command, passed as an
 * argument and never interpolated. fd 3 (the closure pipe) is closed first so no
 * descendant can write a forged closure frame.
 */
const WRAPPER_SOURCE = [
  "exec 3>&-",
  "set -o posix",
  'ulimit -t "$1" || exit 125',
  'ulimit -f "$2" || exit 125',
  "set +o posix",
  'exec "$0" -c "$3"',
].join("\n");

/** Runs as the cloned node inside the sandbox; see the file header. */
const REAPER_SOURCE = String.raw`"use strict";
const { spawn } = require("node:child_process");
const { writeSync } = require("node:fs");
const argv = process.argv.slice(1);
const controllerPid = Number(argv[0]);
const maxOutput = Number(argv[5]);
const maxPasses = Number(argv[6]);
let relayed = 0;
let outputCapped = false;
let reaping = false;
let exitInfo = null;
let drainTimer = null;
const child = spawn(argv[1], ["-c", argv[2], argv[1], argv[3], argv[4], argv[7]], {
  detached: true,
  stdio: ["ignore", "pipe", "pipe"],
});
function relay(stream, sink) {
  if (!stream) return;
  stream.on("error", () => {});
  stream.on("data", (chunk) => {
    if (reaping) return;
    const room = maxOutput - relayed;
    if (chunk.length > room) {
      if (room > 0) sink.write(chunk.subarray(0, room));
      relayed = maxOutput;
      outputCapped = true;
      reap();
      return;
    }
    relayed += chunk.length;
    sink.write(chunk);
  });
}
process.stdout.on("error", () => {});
process.stderr.on("error", () => {});
relay(child.stdout, process.stdout);
relay(child.stderr, process.stderr);
child.on("error", (error) => {
  if (reaping) return;
  exitInfo = { code: null, signal: null, error: String((error && error.code) || error) };
  writeFrame("${EXITED_FRAME_PREFIX}" + JSON.stringify(exitInfo) + "\n");
  reap();
});
child.on("exit", (code, signal) => {
  if (reaping) return;
  exitInfo = { code, signal };
  writeFrame("${EXITED_FRAME_PREFIX}" + JSON.stringify(exitInfo) + "\n");
  let open = 2;
  const closed = () => {
    open -= 1;
    if (open === 0) reap();
  };
  for (const stream of [child.stdout, child.stderr]) {
    if (!stream || stream.destroyed || stream.readableEnded) closed();
    else stream.once("close", closed);
  }
  drainTimer = setTimeout(reap, 250);
});
process.stdin.on("data", (data) => {
  if (String(data).includes("reap")) reap();
});
process.stdin.on("end", reap);
process.stdin.on("error", reap);
// process._kill returns 0 or a negative errno without building an exception,
// which makes a full sweep about twenty times cheaper; process.kill is the
// documented fallback.
const signalZeroAnswers = typeof process._kill === "function"
  ? (pid) => process._kill(pid, 0) === 0
  : (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
function writeFrame(text) {
  const bytes = Buffer.from(text, "utf8");
  let offset = 0;
  while (offset < bytes.length) {
    try {
      offset += writeSync(3, bytes, offset, bytes.length - offset);
    } catch (error) {
      if (!error || error.code !== "EAGAIN") throw error;
    }
  }
}
function reap() {
  if (reaping) return;
  reaping = true;
  if (drainTimer) clearTimeout(drainTimer);
  for (const stream of [child.stdout, child.stderr]) {
    if (!stream) continue;
    stream.removeAllListeners("data");
    stream.destroy();
  }
  let sandboxed = false;
  try {
    process.kill(controllerPid, 0);
  } catch (error) {
    sandboxed = Boolean(error && error.code === "EPERM");
  }
  if (typeof child.pid === "number") {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  }
  const killed = new Set();
  let passes = 0;
  let clean = 0;
  let last = [];
  if (sandboxed) {
    while (passes < maxPasses && clean < 2) {
      passes += 1;
      const found = [];
      for (let pid = 2; pid <= ${PID_SWEEP_MAX}; pid += 1) {
        if (pid !== process.pid && signalZeroAnswers(pid)) found.push(pid);
      }
      let fresh = false;
      for (const pid of found) {
        if (!killed.has(pid)) {
          fresh = true;
          killed.add(pid);
        }
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
      clean = fresh ? 0 : clean + 1;
      last = found;
    }
  }
  writeFrame("${CLOSURE_FRAME_PREFIX}" + JSON.stringify({
    v: 1,
    sandboxed,
    converged: clean >= 2,
    outputCapped,
    exit: exitInfo,
    record: { passes, killed: [...killed].sort((a, b) => a - b), persistent: last },
  }) + "\n");
  process.stdin.destroy();
  process.exitCode = 0;
}
`;

/** One line per rule family; `{{...}}` slots are filled by `renderWriterProfile`. */
const PROFILE_TEMPLATE = [
  "(version 1)",
  '(import "/System/Library/Sandbox/Profiles/dyld-support.sb")',
  "(deny default)",
  "(allow process-fork)",
  "(allow process-exec {{EXEC}})",
  "(allow signal (target same-sandbox))",
  "(allow sysctl-read)",
  "(deny network*)",
  "{{LOOPBACK}}",
  "(allow file-read-metadata {{METADATA}})",
  "{{READ}}",
  "{{WRITE}}",
  "{{DENY}}",
].join("\n");

const SYSTEM_VERSION_PLIST = "/System/Library/CoreServices/SystemVersion.plist";
let cachedOsBuild: string | undefined;

/**
 * The macOS build a qualification receipt is bound to (what `sw_vers
 * -buildVersion` prints), read from SystemVersion.plist so the synchronous
 * refusal path never shells out (engine-no-blocking-shellout invariant).
 */
export function readCccConfinementOsBuild(): string {
  if (cachedOsBuild === undefined) {
    let build: string | undefined;
    try {
      build = /<key>ProductBuildVersion<\/key>\s*<string>([^<]+)<\/string>/u.exec(readFileSync(SYSTEM_VERSION_PLIST, "utf8"))?.[1]?.trim();
    } catch {
      build = undefined;
    }
    cachedOsBuild = build && build.length > 0 ? build : `${process.platform}-build-unknown`;
  }
  return cachedOsBuild;
}

type CaptureResult = Readonly<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  overLimit: boolean;
  spawnError: string | null;
}>;

/**
 * Bounded asynchronous capture of a short host command (lsof, ps, git
 * --exec-path) under the process supervisor: never execSync or spawnSync
 * (engine-no-blocking-shellout), a wall timeout, and an output cap.
 */
async function captureSupervised(
  executable: string,
  args: readonly string[],
  options: Readonly<{ label: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; maxOutputBytes?: number }>,
): Promise<CaptureResult> {
  const timeoutMs = options.timeoutMs ?? CAPTURE_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? CAPTURE_MAX_OUTPUT_BYTES;
  const supervised = superviseSpawn(executable, args, {
    env: options.env ?? CAPTURE_ENV,
    stdio: ["ignore", "pipe", "pipe"],
    killGraceMs: CAPTURE_KILL_GRACE_MS,
    maxLifetimeMs: timeoutMs + CAPTURE_KILL_GRACE_MS,
    diagnosticLabel: options.label,
  });
  const stdout: Buffer[] = [];
  let stdoutBytes = 0;
  let stderr = "";
  let timedOut = false;
  let overLimit = false;
  let spawnError: string | null = null;
  supervised.child.stdout?.on("data", (chunk: Buffer) => {
    if (overLimit) return;
    stdoutBytes += chunk.length;
    if (stdoutBytes > maxOutputBytes) {
      overLimit = true;
      supervised.kill("SIGKILL");
      return;
    }
    stdout.push(chunk);
  });
  supervised.child.stderr?.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4_096);
  });
  supervised.child.once("error", (error) => {
    spawnError = error.message;
  });
  const timer = setTimeout(() => {
    timedOut = true;
    supervised.kill("SIGKILL");
  }, timeoutMs);
  timer.unref?.();
  const exit = await supervised.waitExit();
  clearTimeout(timer);
  return {
    code: exit.code,
    signal: exit.signal,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr,
    timedOut,
    overLimit,
    spawnError,
  };
}

function fileSha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function isApplePlatformPath(path: string): boolean {
  return APPLE_PLATFORM_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function sealedExecutable(path: string, label: string): CccSealedExecutable {
  const real = cccCanonicalExistingPath(path, `sealed ${label}`);
  if (!statSync(real).isFile()) throw new Error(`sealed ${label} is not a regular file: ${real}`);
  if (isApplePlatformPath(real)) {
    throw new Error(`sealed ${label} ${real} is an Apple platform binary, which macOS kills when it runs from the per-instance clone (ADR X1-R); seal a non-platform build such as Homebrew's`);
  }
  return { path: real, sha256: fileSha256(real) };
}

type ToolchainBody = Omit<CccSealedToolchain, "toolchainSha256">;

function toolchainDigest(body: ToolchainBody): string {
  const entry = (value: CccSealedExecutable) => ({ path: value.path, sha256: value.sha256 });
  return createHash("sha256").update(JSON.stringify({
    schema: "ccc-sealed-toolchain.v1",
    bash: entry(body.bash),
    sh: entry(body.sh),
    node: entry(body.node),
    git: { ...entry(body.git), execPath: body.git.execPath },
    utilities: body.utilities.map(entry),
  })).digest("hex");
}

/**
 * Seals real-path executables with their sha256 and the toolchain digest. Never
 * pass Homebrew `bin/` shims or `/usr/bin/git` (an xcrun shim), and never an
 * Apple platform binary: only non-platform builds run from the per-instance clone.
 */
export async function sealCccToolchain(i: Readonly<{
  bash: string;
  sh: string;
  node: string;
  git: string;
  utilities: readonly string[];
}>): Promise<CccSealedToolchain> {
  const git = sealedExecutable(i.git, "git");
  const execPath = await captureSupervised(git.path, ["--exec-path"], {
    label: "ccc-confined-shell-git-exec-path",
    env: { PATH: "/usr/bin:/bin", LANG: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  });
  if (execPath.code !== 0 || execPath.timedOut || execPath.overLimit || execPath.spawnError !== null) {
    throw new Error(`sealed git ${git.path} did not report its exec path`);
  }
  const utilities = new Map<string, CccSealedExecutable>();
  for (const utility of i.utilities) {
    const sealed = sealedExecutable(utility, "utility");
    utilities.set(sealed.path, sealed);
  }
  const body: ToolchainBody = {
    bash: sealedExecutable(i.bash, "bash"),
    sh: sealedExecutable(i.sh, "sh"),
    node: sealedExecutable(i.node, "node"),
    git: { ...git, execPath: cccCanonicalExistingPath(execPath.stdout.trim(), "sealed git exec path") },
    utilities: [...utilities.values()].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)),
  };
  const toolchain = { ...body, toolchainSha256: toolchainDigest(body) };
  toolchainPathNames(toolchain);
  return toolchain;
}

function toolchainExecutables(toolchain: CccSealedToolchain): CccSealedExecutable[] {
  return [toolchain.bash, toolchain.sh, toolchain.node, toolchain.git, ...toolchain.utilities];
}

/**
 * The PATH names inside the sandbox: the four roles, then each utility under the
 * basename of its real path. Two different files under one name are refused.
 */
function toolchainPathNames(toolchain: CccSealedToolchain): Map<string, string> {
  const names = new Map<string, string>();
  const add = (name: string, path: string) => {
    const existing = names.get(name);
    if (existing !== undefined && existing !== path) {
      refuse("toolchain-digest-drift", `two sealed executables share the PATH name ${name}: ${existing} and ${path}`);
    }
    names.set(name, path);
  };
  add("bash", toolchain.bash.path);
  add("sh", toolchain.sh.path);
  add("node", toolchain.node.path);
  add("git", toolchain.git.path);
  for (const utility of toolchain.utilities) add(basename(utility.path), utility.path);
  return names;
}

type FileIdentity = Readonly<{ path: string; sha256: string; dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }>;

function refuse(reason: CccConfinementRefusalReason, message: string): never {
  throw new CccConfinementRefusedError(reason, message);
}

function fileIdentity(path: string, sha256: string): FileIdentity {
  const stat = statSync(path);
  return { path, sha256, dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
}

/** Every sealed path must still be its own non-platform real path with the sealed bytes. */
function verifyToolchain(toolchain: CccSealedToolchain): FileIdentity[] {
  const identities: FileIdentity[] = [];
  for (const executable of toolchainExecutables(toolchain)) {
    if (!isAbsolute(executable.path) || !SHA256_HEX.test(executable.sha256)) {
      refuse("toolchain-digest-drift", `sealed executable record is malformed: ${executable.path}`);
    }
    if (isApplePlatformPath(executable.path)) {
      refuse("toolchain-digest-drift", `sealed executable ${executable.path} is an Apple platform binary, which cannot run from the per-instance clone`);
    }
    let real: string;
    try {
      real = realpathSync(executable.path);
    } catch {
      return refuse("toolchain-digest-drift", `sealed executable is missing: ${executable.path}`);
    }
    if (real !== executable.path) refuse("toolchain-digest-drift", `sealed executable is not a real path: ${executable.path}`);
    if (!statSync(real).isFile()) refuse("toolchain-digest-drift", `sealed executable is not a regular file: ${real}`);
    if (fileSha256(real) !== executable.sha256) refuse("toolchain-digest-drift", `sealed executable bytes changed: ${real}`);
    identities.push(fileIdentity(real, executable.sha256));
  }
  let execPathReal: string | undefined;
  try {
    execPathReal = realpathSync(toolchain.git.execPath);
  } catch {
    execPathReal = undefined;
  }
  if (
    typeof toolchain.git.execPath !== "string"
    || execPathReal === undefined
    || execPathReal !== toolchain.git.execPath
    || !statSync(execPathReal).isDirectory()
  ) {
    refuse("toolchain-digest-drift", `sealed git exec path is not a real directory: ${toolchain.git.execPath}`);
  }
  const { toolchainSha256, ...body } = toolchain;
  if (!SHA256_HEX.test(toolchainSha256) || toolchainDigest(body) !== toolchainSha256) {
    refuse("toolchain-digest-drift", "toolchainSha256 does not match the sealed executables");
  }
  toolchainPathNames(toolchain);
  return identities;
}

/** Cheap per-command re-check: re-hash only a file whose identity changed since it was verified. */
function recheckToolchain(identities: readonly FileIdentity[]): void {
  for (const identity of identities) {
    let stat;
    try {
      stat = statSync(identity.path);
    } catch {
      refuse("toolchain-digest-drift", `sealed executable disappeared: ${identity.path}`);
    }
    if (
      stat.dev === identity.dev && stat.ino === identity.ino && stat.size === identity.size
      && stat.mtimeMs === identity.mtimeMs && stat.ctimeMs === identity.ctimeMs
    ) {
      continue;
    }
    if (fileSha256(identity.path) !== identity.sha256) {
      refuse("toolchain-digest-drift", `sealed executable bytes changed: ${identity.path}`);
    }
  }
}

const SEALED_ENV_KEYS = new Set([
  "PATH", "HOME", "TMPDIR", "USER", "LOGNAME", "LANG", "TERM", "NO_COLOR", "CI", "GIT_OPTIONAL_LOCKS",
  "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL", "GIT_CEILING_DIRECTORIES", "GIT_TERMINAL_PROMPT",
  "npm_config_offline", "OPENSSL_CONF",
]);
export const CCC_CONFINED_SHELL_SEALED_ENV_KEYS: readonly string[] = Object.freeze([...SEALED_ENV_KEYS]);
const CONTROL_ENV_KEYS = new Set([
  "ENV", "SHELLOPTS", "BASHOPTS", "PS4", "PROMPT_COMMAND", "IFS", "CDPATH", "GLOBIGNORE", "PERL5LIB",
  "PERL5OPT", "PERLLIB", "RUBYOPT", "RUBYLIB", "PYTHONPATH", "PYTHONSTARTUP", "PYTHONHOME", "SSL_CERT_FILE",
  "SSL_CERT_DIR", "HOSTALIASES", "LOCALDOMAIN", "RES_OPTIONS", "LC_ALL", "TZDIR", "SHELL",
]);
const CONTROL_ENV_PREFIX = /^(?:DYLD_|LD_|NODE_|BASH_|GIT_|NPM_CONFIG_|COREPACK_|MALLOC)/iu;
const CREDENTIAL_ENV_NAME = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|CREDENTIAL|AUTH|COOKIE|SESSION|PRIVATE|CERT/iu;

/**
 * `taskEnv` arrives already filtered by the task contract's allowlist; this is
 * the shell's own fail-closed check of what any such allowlist may never admit:
 * sealed keys, loader or shell control variables, and credential-shaped names.
 */
function assertTaskEnvAllowlisted(taskEnv: Readonly<Record<string, string>>): void {
  for (const [key, value] of Object.entries(taskEnv)) {
    const problem = !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(key)
      ? "is not a plain variable name"
      : SEALED_ENV_KEYS.has(key)
        ? "would override a sealed variable"
        : CONTROL_ENV_KEYS.has(key.toUpperCase()) || CONTROL_ENV_PREFIX.test(key)
          ? "controls a loader, shell or tool"
          : CREDENTIAL_ENV_NAME.test(key)
            ? "is credential-shaped"
            : typeof value !== "string" || value.includes("\u0000") || value.length > 4_096
              ? "has a value that is not a bounded string"
              : null;
    if (problem) refuse("taskenv-not-allowlisted", `taskEnv key ${key} ${problem}`);
  }
}

function canonicalPossiblyMissingPath(path: string, label: string): string {
  if (!isAbsolute(path)) throw new Error(`${label} must be absolute`);
  const resolved = resolve(path);
  if (existsSync(resolved)) return realpathSync(resolved);
  const parent = dirname(resolved);
  if (parent === resolved) return resolved;
  return join(canonicalPossiblyMissingPath(parent, label), basename(resolved));
}

function deniedNamePattern(name: string): string {
  if (!/^[A-Za-z0-9._*-]+$/u.test(name) || name === "." || name === "..") {
    throw new Error(`denied name must be a single path component of [A-Za-z0-9._*-]: ${name}`);
  }
  const body = [...name].map((character) => (character === "*" ? "[^/]*" : character === "." ? "\\." : character)).join("");
  return `#"/${body}(/.*)?$"`;
}

type CanonicalShellInput = Readonly<{
  worktreeRoot: string;
  gitDirs: string[];
  writeRoots: string[];
  deniedRoots: string[];
  deniedNames: string[];
  scratchRoot: string;
  loopbackPort?: number;
}>;

function canonicalShellInput(input: CccConfinedShellInput): CanonicalShellInput {
  if (input.profileId !== PROFILE_ID) throw new Error(`unsupported confinement profile ${String(input.profileId)}`);
  if (
    input.loopbackPort !== undefined
    && (!Number.isSafeInteger(input.loopbackPort) || input.loopbackPort <= 0 || input.loopbackPort > 65_535 || input.loopbackPort === 4_040)
  ) {
    throw new Error("confined-shell loopback port must be an integer from 1 through 65535 and port 4040 is reserved");
  }
  const worktreeRoot = cccCanonicalExistingPath(input.worktreeRoot, "confined-shell worktree root");
  const gitDirs = cccUniqueSortedPaths(input.gitDirs.map((path) => cccCanonicalExistingPath(path, "confined-shell git dir")));
  const writeRoots = cccUniqueSortedPaths(input.writeRoots.map((path) => cccCanonicalExistingPath(path, "confined-shell write root")));
  const deniedRoots = cccUniqueSortedPaths(input.deniedRoots.map((path) => canonicalPossiblyMissingPath(path, "confined-shell denied root")));
  const scratchRoot = cccCanonicalExistingPath(input.scratchRoot, "confined-shell scratch root");
  const overlaps = (left: string, right: string) => cccIsSameOrWithin(left, right) || cccIsSameOrWithin(right, left);
  const toolchainPaths = [...toolchainExecutables(input.toolchain).map((entry) => entry.path), input.toolchain.git.execPath];
  for (const writeRoot of writeRoots) {
    if (!cccIsSameOrWithin(writeRoot, worktreeRoot)) refuse("root-overlap", `write root is outside the worktree: ${writeRoot}`);
    if (gitDirs.some((gitDir) => overlaps(writeRoot, gitDir))) refuse("root-overlap", `write root overlaps a git dir: ${writeRoot}`);
  }
  for (const root of [worktreeRoot, ...gitDirs, ...deniedRoots]) {
    if (overlaps(scratchRoot, root)) refuse("root-overlap", `scratch root overlaps ${root}`);
  }
  for (const deniedRoot of deniedRoots) {
    if ([worktreeRoot, ...writeRoots].some((root) => cccIsSameOrWithin(root, deniedRoot))) {
      refuse("root-overlap", `denied root contains an admitted root: ${deniedRoot}`);
    }
  }
  for (const path of toolchainPaths) {
    if ([...writeRoots, scratchRoot, ...deniedRoots].some((root) => cccIsSameOrWithin(path, root))) {
      refuse("root-overlap", `sealed toolchain path is writable or denied: ${path}`);
    }
  }
  assertTaskEnvAllowlisted(input.taskEnv);
  return {
    worktreeRoot,
    gitDirs,
    writeRoots,
    deniedRoots,
    // E1-20: the defaults always apply; a caller can add names, never remove `.env`.
    deniedNames: cccUniqueSortedPaths([...DEFAULT_DENIED_NAMES, ...input.deniedNames]),
    scratchRoot,
    ...(input.loopbackPort !== undefined ? { loopbackPort: input.loopbackPort } : {}),
  };
}

function renderWriterProfile(slots: Readonly<Record<"EXEC" | "LOOPBACK" | "METADATA" | "READ" | "WRITE" | "DENY", string>>): string {
  const rendered = PROFILE_TEMPLATE.replace(/\{\{(EXEC|LOOPBACK|METADATA|READ|WRITE|DENY)\}\}/gu, (_match, slot: keyof typeof slots) => slots[slot]);
  return `${rendered.split("\n").filter((line) => line.trim() !== "").join("\n")}\n`;
}

/**
 * The dylib closure depends only on the sealed executables, so it is discovered
 * once per toolchain digest per process (about 1.5 s of otool calls). A stale
 * entry can only under-admit: dyld then fails to load inside the sandbox.
 */
const linkedRuntimeFilesByToolchain = new Map<string, Promise<string[]>>();

function linkedRuntimeFilesFor(toolchain: CccSealedToolchain): Promise<string[]> {
  const executables = toolchainExecutables(toolchain).map((entry) => entry.path);
  const key = `${toolchain.toolchainSha256}\u0000${executables.join("\u0000")}`;
  let files = linkedRuntimeFilesByToolchain.get(key);
  if (!files) {
    files = cccDarwinLinkedRuntimeFiles(executables);
    files.catch(() => linkedRuntimeFilesByToolchain.delete(key));
    linkedRuntimeFilesByToolchain.set(key, files);
  }
  return files;
}

/** Placeholder clone directory for a profile rendered without an operations instance. */
function placeholderCloneDir(scratchRoot: string): string {
  return join(scratchRoot, `${CLONE_DIR_PREFIX}instance`);
}

async function writerProfile(
  input: CccConfinedShellInput,
  canonical: CanonicalShellInput,
  cloneDir: string,
): Promise<Readonly<{ profile: string; profileSha256: string }>> {
  const toolchain = input.toolchain;
  const linkedRuntimeFiles = await linkedRuntimeFilesFor(toolchain);
  const readRoots = cccUniqueSortedPaths([
    ...SYSTEM_RUNTIME_READ_ROOTS.filter((path) => existsSync(path)),
    ...linkedRuntimeFiles.map((path) => dirname(path)),
    toolchain.git.execPath,
    canonical.worktreeRoot,
    ...canonical.gitDirs,
    canonical.scratchRoot,
  ]);
  const readFiles = cccUniqueSortedPaths([...DEVICE_READ_FILES, ...linkedRuntimeFiles].filter((path) => existsSync(path)));
  const metadata = cccUniqueSortedPaths([...readRoots, ...readFiles].flatMap(cccPathAncestors));
  const writeRoots = cccUniqueSortedPaths([...canonical.writeRoots, canonical.scratchRoot]);
  const deny: string[] = [];
  if (canonical.deniedNames.length > 0) {
    deny.push(`(deny file-read* file-write* (regex ${canonical.deniedNames.map(deniedNamePattern).join(" ")}))`);
  }
  for (const deniedRoot of canonical.deniedRoots) deny.push(`(deny file-read* file-write* ${cccSbplSubpath(deniedRoot)})`);
  const gitWriteDenied = cccUniqueSortedPaths([...canonical.gitDirs, join(canonical.worktreeRoot, ".git")]);
  deny.push(`(deny file-write* ${gitWriteDenied.map(cccSbplSubpath).join(" ")})`);
  deny.push(GIT_SEGMENT_WRITE_DENY);
  // The clone lies inside the writable scratch root; this later deny makes it read-only (P9 order).
  deny.push(`(deny file-write* ${cccSbplSubpath(cloneDir)})`);
  const profile = renderWriterProfile({
    EXEC: cccSbplSubpath(cloneDir),
    LOOPBACK: canonical.loopbackPort !== undefined ? cccSbplLoopbackPortRules(canonical.loopbackPort).join("\n") : "",
    METADATA: metadata.map(cccSbplLiteral).join(" "),
    READ: [
      ...readRoots.map((root) => `(allow file-read* ${cccSbplSubpath(root)})`),
      `(allow file-read* ${readFiles.map(cccSbplLiteral).join(" ")})`,
    ].join("\n"),
    WRITE: `(allow file-write* ${[...writeRoots.map(cccSbplSubpath), cccSbplLiteral("/dev/null")].join(" ")})`,
    DENY: deny.join("\n"),
  });
  return { profile, profileSha256: createHash("sha256").update(profile).digest("hex") };
}

/**
 * The profile for `input`, rendered with a placeholder per-instance clone
 * directory (`<scratch>/.ccc-exec-instance`); each operations instance renders
 * the same rules with its own random clone directory.
 */
export async function buildCccWriterShellDarwinProfile(
  input: CccConfinedShellInput,
): Promise<Readonly<{ profile: string; profileSha256: string }>> {
  const canonical = canonicalShellInput(input);
  return writerProfile(input, canonical, placeholderCloneDir(canonical.scratchRoot));
}

type SealedEnvironmentInput = Readonly<{
  binDir: string;
  scratchRoot: string;
  worktreeRoot: string;
  taskEnv: Readonly<Record<string, string>>;
}>;

function sealedEnvironment(i: SealedEnvironmentInput): NodeJS.ProcessEnv {
  return {
    PATH: i.binDir,
    HOME: join(i.scratchRoot, "home"),
    TMPDIR: join(i.scratchRoot, "tmp"),
    USER: "ccc",
    LOGNAME: "ccc",
    LANG: "C",
    TERM: "dumb",
    NO_COLOR: "1",
    CI: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CEILING_DIRECTORIES: dirname(i.worktreeRoot),
    GIT_TERMINAL_PROMPT: "0",
    npm_config_offline: "true",
    // Homebrew node aborts at startup when it cannot read its openssl.cnf, which
    // the profile does not admit; an empty config is what the semantic-proof
    // sandbox seals too.
    OPENSSL_CONF: "/dev/null",
    ...i.taskEnv,
  };
}

const TEMPLATE_SENTINEL_PORT = 47_999;

/**
 * Everything that decides what the sandbox admits apart from the per-run paths:
 * the profile template, the bash wrapper, the reaper, the denied-name pattern,
 * the `.git` segment rule, the sealed environment, the loopback rule and the
 * controller sweep. The functions are rendered for sentinel inputs, so a change
 * to any of their outputs changes the digest a qualification receipt binds and
 * every earlier qualification becomes stale (`qualification-missing`, E1-20).
 */
export const CCC_WRITER_SHELL_PROFILE_TEMPLATE_MATERIAL: readonly string[] = Object.freeze([
  PROFILE_ID,
  PROFILE_TEMPLATE,
  WRAPPER_SOURCE,
  REAPER_SOURCE,
  `denied-names ${[...DEFAULT_DENIED_NAMES, "sample*.name"].map(deniedNamePattern).join(" ")}`,
  `git-segment ${GIT_SEGMENT_WRITE_DENY}`,
  `sealed-env ${JSON.stringify(sealedEnvironment({
    binDir: "/ccc-sentinel/scratch/.ccc-exec-sentinel/bin",
    scratchRoot: "/ccc-sentinel/scratch",
    worktreeRoot: "/ccc-sentinel/worktree",
    taskEnv: {},
  }))} shell-added ${SHELL_ADDED_ENV_KEYS.join(",")}`,
  `loopback ${cccSbplLoopbackPortRules(TEMPLATE_SENTINEL_PORT).join("\n")}`,
  `controller-sweep lsof txt by clone inode; stop, rescan, kill, two empty scans; at most ${CONTROLLER_SWEEP_MAX_SCANS} scans`,
]);
export const CCC_WRITER_SHELL_PROFILE_TEMPLATE_SHA256 = createHash("sha256")
  .update(CCC_WRITER_SHELL_PROFILE_TEMPLATE_MATERIAL.join("\u0000"))
  .digest("hex");

type ToolchainClone = Readonly<{
  dir: string;
  binDir: string;
  node: string;
  bash: string;
  /** The cloned executables with their sealed digests, re-checked before every exec. */
  identities: readonly FileIdentity[];
  /** `<dev>:<ino>` of every cloned file, which is how the controller recognises a sandboxed process. */
  inodes: ReadonlySet<string>;
}>;

/**
 * Clones the sealed executables (and any dylib they load relative to their own
 * install root) into a fresh `<scratch>/.ccc-exec-<random>` directory, mirroring
 * absolute paths under `root/`, plus `bin/` role-named symlinks for PATH.
 */
async function cloneToolchain(toolchain: CccSealedToolchain, scratchRoot: string): Promise<ToolchainClone> {
  const dir = join(scratchRoot, `${CLONE_DIR_PREFIX}${randomBytes(8).toString("hex")}`);
  const root = join(dir, "root");
  const binDir = join(dir, "bin");
  await mkdir(dir);
  await mkdir(binDir);
  const clones = new Map<string, string>();
  const cloneFile = async (original: string): Promise<string> => {
    const existing = clones.get(original);
    if (existing !== undefined) return existing;
    const target = join(root, original);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(original, target, fsConstants.COPYFILE_FICLONE);
    await chmod(target, 0o555);
    clones.set(original, target);
    return target;
  };
  const executables = toolchainExecutables(toolchain);
  for (const executable of executables) await cloneFile(executable.path);
  const installRoots = executables.map((executable) => dirname(dirname(executable.path)));
  for (const file of await linkedRuntimeFilesFor(toolchain)) {
    if (isApplePlatformPath(file) || !installRoots.some((installRoot) => cccIsSameOrWithin(file, installRoot))) continue;
    if (statSync(file).isFile()) await cloneFile(file);
  }
  for (const [name, original] of toolchainPathNames(toolchain)) {
    await symlink(clones.get(original)!, join(binDir, name));
  }
  const identities: FileIdentity[] = [];
  for (const executable of executables) {
    const target = clones.get(executable.path)!;
    if (identities.some((identity) => identity.path === target)) continue;
    if (fileSha256(target) !== executable.sha256) {
      refuse("toolchain-digest-drift", `the per-instance clone of ${executable.path} does not carry the sealed bytes`);
    }
    identities.push(fileIdentity(target, executable.sha256));
  }
  const inodes = new Set<string>();
  for (const target of clones.values()) {
    const stat = statSync(target, { bigint: true });
    inodes.add(`${stat.dev.toString()}:${stat.ino.toString()}`);
  }
  return { dir, binDir, node: clones.get(toolchain.node.path)!, bash: clones.get(toolchain.bash.path)!, identities, inodes };
}

type ClosureFrame = Readonly<{
  sandboxed: boolean;
  converged: boolean;
  outputCapped: boolean;
  exit: Readonly<{ code: number | null; signal: string | null }> | null;
  record: CccClosureRecord;
}>;

function isPidList(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((pid) => Number.isSafeInteger(pid) && pid > 1);
}

/**
 * fd 3 carries at most one exited frame and exactly one closure frame, in that
 * order, and nothing else; any other shape is unconfirmed.
 */
function parseClosureFrame(text: string): ClosureFrame | null {
  if (!text.endsWith("\n")) return null;
  const lines = text.slice(0, -1).split("\n");
  const closureLine = lines.at(-1) ?? "";
  if (
    lines.length > 2
    || (lines.length === 2 && !lines[0]!.startsWith(EXITED_FRAME_PREFIX))
    || !closureLine.startsWith(CLOSURE_FRAME_PREFIX)
  ) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(closureLine.slice(CLOSURE_FRAME_PREFIX.length));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const frame = parsed as Record<string, unknown>;
  const record = frame.record as Record<string, unknown> | undefined;
  const exit = frame.exit as Record<string, unknown> | null | undefined;
  if (
    frame.v !== 1
    || typeof frame.sandboxed !== "boolean"
    || typeof frame.converged !== "boolean"
    || typeof frame.outputCapped !== "boolean"
    || record === null || typeof record !== "object"
    || !Number.isSafeInteger(record.passes) || (record.passes as number) < 0
    || !isPidList(record.killed) || !isPidList(record.persistent)
    || (exit !== null && (typeof exit !== "object" || exit === undefined
      || !(exit.code === null || Number.isSafeInteger(exit.code))
      || !(exit.signal === null || typeof exit.signal === "string")))
  ) {
    return null;
  }
  return {
    sandboxed: frame.sandboxed,
    converged: frame.converged,
    outputCapped: frame.outputCapped,
    exit: exit === null ? null : { code: exit.code as number | null, signal: exit.signal as string | null },
    record: { passes: record.passes as number, killed: record.killed, persistent: record.persistent },
  };
}

/**
 * Outside the sandbox: every same-uid pid whose lsof txt mapping is one of the
 * clone's inodes. The scan must list the controller itself, or it is not trusted.
 */
async function scanCloneProcesses(clone: ToolchainClone): Promise<number[]> {
  const uid = typeof process.getuid === "function" ? process.getuid() : -1;
  const scan = await captureSupervised(
    LSOF_EXECUTABLE,
    ["-n", "-P", "-w", "-a", "-u", String(uid), "-d", "txt", "-F", "pDi"],
    { label: "ccc-confined-shell-sweep" },
  );
  if (scan.timedOut || scan.overLimit || scan.spawnError !== null) {
    throw new Error(`lsof scan failed (${scan.spawnError ?? (scan.timedOut ? "timed out" : "output over limit")})`);
  }
  const found = new Set<number>();
  let sawSelf = false;
  let pid = -1;
  let dev: string | null = null;
  for (const line of scan.stdout.split("\n")) {
    const value = line.slice(1);
    switch (line[0]) {
      case "p":
        pid = Number(value);
        dev = null;
        if (pid === process.pid) sawSelf = true;
        break;
      case "f":
        dev = null;
        break;
      case "D":
        dev = /^0x[0-9a-f]+$/iu.test(value) ? BigInt(value).toString() : null;
        break;
      case "i":
        if (dev !== null && clone.inodes.has(`${dev}:${value}`) && Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid) {
          found.add(pid);
        }
        break;
      default:
        break;
    }
  }
  if (!sawSelf) throw new Error(`lsof did not list the controller itself (exit ${String(scan.code)}), so its scan cannot be trusted`);
  return [...found].sort((left, right) => left - right);
}

type ControllerSweep = Readonly<{
  converged: boolean;
  scans: number;
  killed: readonly number[];
  remaining: readonly number[];
  failure: string | null;
}>;

function signalClonePid(pid: number, signal: NodeJS.Signals): void {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) return;
  try {
    process.kill(pid, signal);
  } catch {
    // ESRCH: it exited between the scan and the signal
  }
}

/**
 * E1-18 kill order: SIGSTOP every match, re-scan until no new pid appears,
 * SIGKILL the set the last scan confirmed (a stopped process cannot exit or
 * change its executable, so its pid cannot be recycled meanwhile), then require
 * two consecutive empty scans. Never kill(-1), never a pid the scan did not list.
 */
async function sweepCloneProcesses(clone: ToolchainClone): Promise<ControllerSweep> {
  const stopped = new Set<number>();
  const killed = new Set<number>();
  let scans = 0;
  let clean = 0;
  let last: number[] = [];
  const outcome = (converged: boolean, failure: string | null): ControllerSweep => ({
    converged,
    scans,
    killed: [...killed].sort((left, right) => left - right),
    remaining: converged ? [] : last,
    failure,
  });
  try {
    while (scans < CONTROLLER_SWEEP_MAX_SCANS) {
      scans += 1;
      const found = await scanCloneProcesses(clone);
      last = found;
      if (found.length === 0) {
        clean += 1;
        if (clean >= 2) return outcome(true, null);
        continue;
      }
      clean = 0;
      const fresh = found.filter((pid) => !stopped.has(pid));
      for (const pid of fresh) {
        signalClonePid(pid, "SIGSTOP");
        stopped.add(pid);
      }
      if (fresh.length > 0) continue;
      for (const pid of found) {
        signalClonePid(pid, "SIGKILL");
        killed.add(pid);
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, CONTROLLER_SWEEP_SETTLE_MS));
    }
    return outcome(false, `still finding processes after ${CONTROLLER_SWEEP_MAX_SCANS} scans`);
  } catch (error) {
    return outcome(false, error instanceof Error ? error.message : String(error));
  }
}

function exitCodeOf(exit: ClosureFrame["exit"]): number | null {
  if (exit === null) return null;
  if (exit.code !== null) return exit.code;
  const signalNumber = exit.signal ? osConstants.signals[exit.signal as NodeJS.Signals] : undefined;
  return typeof signalNumber === "number" ? 128 + signalNumber : null;
}

function mergedClosureRecord(frame: ClosureFrame | null, sweep: ControllerSweep): CccClosureRecord {
  return {
    passes: (frame?.record.passes ?? 0) + sweep.scans,
    killed: cccUniqueSortedNumbers([...(frame?.record.killed ?? []), ...sweep.killed]),
    persistent: sweep.converged ? [] : [...sweep.remaining],
  };
}

function cccUniqueSortedNumbers(values: readonly number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

const QUARANTINE_NOTE = "descendants may still be running with write access to the write roots and the scratch root and network access to the admitted loopback port; quarantine means moving the write roots out of place and closing the admitted loopback listener, not only flagging the worktree";

const lastClosures = new WeakMap<BashOperations, CccClosureRecord | null>();
const instanceSweeps = new WeakMap<BashOperations, () => Promise<ControllerSweep | null>>();

/** The closure record of the most recent command run through these operations, or null when it was not confirmed. */
export function cccConfinedShellLastClosure(operations: BashOperations): CccClosureRecord | null {
  return lastClosures.get(operations) ?? null;
}

function assertBackendReady(): void {
  const readiness = readCccSemanticProofSandboxReadiness();
  if (readiness.ready) return;
  refuse(readiness.backend === null ? "platform-unsupported" : "sandbox-exec-missing", readiness.detail ?? readiness.message);
}

function assertQualified(input: CccConfinedShellInput): void {
  const qualification = input.qualification;
  if (
    !qualification
    || !SHA256_HEX.test(qualification.receiptSha256)
    || qualification.profileTemplateSha256 !== CCC_WRITER_SHELL_PROFILE_TEMPLATE_SHA256
    || qualification.osBuild !== readCccConfinementOsBuild()
  ) {
    refuse(
      "qualification-missing",
      `no qualification receipt for profile template ${CCC_WRITER_SHELL_PROFILE_TEMPLATE_SHA256} on OS build ${readCccConfinementOsBuild()}`,
    );
  }
}

function assertLimits(limits: CccConfinementLimits): void {
  const positive = (value: number) => Number.isSafeInteger(value) && value > 0;
  if (
    !positive(limits.wallMsCeiling) || !positive(limits.cpuSeconds) || !positive(limits.fileSizeBlocks)
    || !positive(limits.maxOutputBytes) || !positive(limits.maxReapPasses) || limits.maxReapPasses < 2
  ) {
    throw new Error("confined-shell limits must be positive safe integers with at least two reap passes");
  }
}

function confinedOperations(input: CccConfinedShellInput, options: Readonly<{ requireQualification: boolean }>): BashOperations {
  assertBackendReady();
  if (options.requireQualification) assertQualified(input);
  assertLimits(input.limits);
  const identities = verifyToolchain(input.toolchain);
  const canonical = canonicalShellInput(input);
  const limits = input.limits;
  const reapBudgetMs = REAP_BASE_BUDGET_MS + limits.maxReapPasses * REAP_PASS_BUDGET_MS;
  let clone: Promise<ToolchainClone> | undefined;
  let profile: Promise<Readonly<{ profile: string; profileSha256: string }>> | undefined;
  let queue: Promise<unknown> = Promise.resolve();

  // E1-20: one exec at a time per instance, so the last-closure record and the
  // shared scratch home and tmp are never shared by two commands.
  const serialized = <T>(task: () => Promise<T>): Promise<T> => {
    const next = queue.then(task, task);
    queue = next.catch(() => undefined);
    return next;
  };
  const ensureClone = (): Promise<ToolchainClone> => {
    if (!clone) {
      clone = cloneToolchain(input.toolchain, canonical.scratchRoot);
      clone.catch(() => {
        clone = undefined;
      });
    }
    return clone;
  };

  const execOnce: BashOperations["exec"] = async (command, cwd, { onData, signal, timeout }) => {
    lastClosures.set(operations, null);
    if (signal?.aborted) throw new Error("aborted");
    if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0)) {
      throw new Error("Invalid timeout: must be a finite number of seconds");
    }
    recheckToolchain(identities);
    const requestedMs = timeout === undefined ? Number.POSITIVE_INFINITY : Math.ceil(timeout * 1_000);
    const wallMs = Math.min(requestedMs, limits.wallMsCeiling);
    const timeoutLabel = requestedMs <= limits.wallMsCeiling ? String(timeout) : String(limits.wallMsCeiling / 1_000);
    const runCwd = cccCanonicalExistingPath(isAbsolute(cwd) ? cwd : resolve(canonical.worktreeRoot, cwd), "confined-shell cwd");
    if (!cccIsSameOrWithin(runCwd, canonical.worktreeRoot)) {
      throw new Error(`confined-shell cwd is outside the worktree: ${runCwd}`);
    }
    const instanceClone = await ensureClone();
    recheckToolchain(instanceClone.identities);
    if (!profile) {
      profile = writerProfile(input, canonical, instanceClone.dir);
      profile.catch(() => {
        profile = undefined;
      });
    }
    const { profile: profileText } = await profile;
    await Promise.all([
      mkdir(join(canonical.scratchRoot, "home"), { recursive: true }),
      mkdir(join(canonical.scratchRoot, "tmp"), { recursive: true }),
    ]);
    const env = sealedEnvironment({
      binDir: instanceClone.binDir,
      scratchRoot: canonical.scratchRoot,
      worktreeRoot: canonical.worktreeRoot,
      taskEnv: input.taskEnv,
    });

    // The wall limit covers the model command only, not the reaper's sweep
    // after it: the command timer stops at the reaper's exited frame, and the
    // runner's own timeout is a backstop that also covers the reap budget.
    const closureChunks: Buffer[] = [];
    const stop = new AbortController();
    let commandExited = false;
    let commandTimedOut = false;
    const commandTimer = setTimeout(() => {
      if (commandExited) return;
      commandTimedOut = true;
      stop.abort();
    }, wallMs);
    commandTimer.unref?.();
    const onCallerAbort = (): void => stop.abort();
    signal?.addEventListener("abort", onCallerAbort, { once: true });
    let reaperStdin: Writable | null = null;
    let forceKill: NodeJS.Timeout | undefined;
    let outcome: Awaited<ReturnType<typeof runCccDarwinSandboxedProcess>> | null = null;
    let runnerError: unknown = null;
    try {
      outcome = await runCccDarwinSandboxedProcess({
        profile: profileText,
        executable: instanceClone.node,
        args: [
          "-e",
          REAPER_SOURCE,
          "--",
          String(process.pid),
          instanceClone.bash,
          WRAPPER_SOURCE,
          String(limits.cpuSeconds),
          String(limits.fileSizeBlocks),
          String(limits.maxOutputBytes),
          String(limits.maxReapPasses),
          command,
        ],
        cwd: runCwd,
        env,
        timeoutMs: wallMs + reapBudgetMs,
        maxOutputBytes: limits.maxOutputBytes,
        diagnosticLabel: PROFILE_ID,
        lifetimeGraceMs: reapBudgetMs,
        stdin: "pipe",
        extraPipes: 1,
        signal: stop.signal,
        onSpawn: (supervised) => {
          reaperStdin = supervised.child.stdin;
          reaperStdin?.on("error", () => undefined);
          const closurePipe = supervised.child.stdio[3] as Readable | null | undefined;
          closurePipe?.on("data", (chunk: Buffer | string) => {
            closureChunks.push(Buffer.from(chunk));
            if (!commandExited && Buffer.concat(closureChunks).toString("utf8").startsWith(EXITED_FRAME_PREFIX)) {
              commandExited = true;
              clearTimeout(commandTimer);
            }
          });
          closurePipe?.on("error", () => undefined);
        },
        onOutput: (accepted) => onData(accepted),
        requestStop: (supervised) => {
          (reaperStdin as Writable | null)?.write("reap\n");
          forceKill = setTimeout(() => supervised.kill("SIGKILL"), reapBudgetMs);
          forceKill.unref?.();
        },
      });
    } catch (error) {
      runnerError = error;
    } finally {
      if (forceKill) clearTimeout(forceKill);
      clearTimeout(commandTimer);
      signal?.removeEventListener("abort", onCallerAbort);
    }

    // E1-18: the controller sweep is the closure authority on every path that
    // may have started a process, whatever the reaper managed to report.
    const sweep = await sweepCloneProcesses(instanceClone);
    const frame = outcome === null ? null : parseClosureFrame(Buffer.concat(closureChunks).toString("utf8"));
    const record = mergedClosureRecord(frame, sweep);
    if (!sweep.converged) {
      throw new CccConfinementClosureError(
        record,
        `the controller sweep did not converge (${sweep.failure ?? "unknown"}; ${sweep.remaining.length} process(es) still running from the per-instance toolchain); ${QUARANTINE_NOTE}`,
      );
    }
    if (runnerError !== null || outcome === null) throw runnerError ?? new Error("confined-shell runner produced no outcome");
    if (frame !== null && !frame.sandboxed) {
      throw new CccConfinementClosureError(record, `the reaper could signal the controller, so the sandbox did not apply; ${QUARANTINE_NOTE}`);
    }
    if (frame?.outputCapped || outcome.result.outputOverLimit) {
      onData(Buffer.from(`\n[ccc-confined-shell: output truncated at ${limits.maxOutputBytes} bytes]\n`));
    }
    lastClosures.set(operations, record);
    if (commandTimedOut || outcome.stopReason === "timeout") throw new Error(`timeout:${timeoutLabel}`);
    if (signal?.aborted) throw new Error("aborted");
    if (frame === null) {
      const detail = outcome.result.spawnError
        ?? `reaper exited with code ${String(outcome.result.exitCode)} signal ${String(outcome.result.signal)}; stderr tail: ${outcome.result.stderr.slice(-400)}`;
      throw new Error(
        `confined-shell: the reaper ended without reporting the command's exit status, so it is unknown (the command may have signalled its own reaper; ${detail}); the controller sweep confirmed closure and killed ${sweep.killed.length} process(es)`,
      );
    }
    return { exitCode: exitCodeOf(frame.exit) };
  };

  const operations: BashOperations = {
    exec: (command, cwd, execOptions) => serialized(() => execOnce(command, cwd, execOptions)),
  };
  instanceSweeps.set(operations, () => serialized(async () => (clone ? sweepCloneProcesses(await clone) : null)));
  return operations;
}

/**
 * The confined bash operations for one writer session. Refuses, before any
 * process exists, on a non-Darwin host, a missing sandbox-exec, a qualification
 * for another profile template or OS build, toolchain drift (including an Apple
 * platform binary), a root layout the profile cannot enforce, or a taskEnv key
 * no allowlist may admit. The per-instance toolchain clone is made on first exec.
 */
export function createCccConfinedBashOperations(input: CccConfinedShellInput): BashOperations {
  return confinedOperations(input, { requireQualification: true });
}

const QUALIFICATION_LIMITS: CccConfinementLimits = {
  wallMsCeiling: 60_000,
  cpuSeconds: 60,
  fileSizeBlocks: 20_480,
  maxOutputBytes: 65_536,
  maxReapPasses: 20,
};
const QUALIFICATION_CANARY_NAME = "CCC_QUALIFICATION_CANARY";

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, "'\\''")}'`;
}

function connectProbeCommand(port: number): string {
  return `node -e 'require("net").connect(${port},"127.0.0.1")`
    + `.on("connect",function(){console.log("CONNECT-OK ${port}");this.destroy()})`
    + `.on("error",(e)=>console.log("CONNECT-ERR ${port} "+e.code))'`;
}

/** A bash-builtin read (`$(< file)`), so the probe needs no utility from the toolchain. */
function readProbeCommand(path: string, label: string): string {
  return `${label}_text=$(< ${shellQuote(path)}); echo "${label}-rc=$?"; printf '%s\\n' "$${label}_text"`;
}

function escaperProbeCommand(pidFile: string): string {
  return `node -e 'const c=require("child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{detached:true,stdio:"ignore"});`
    + `require("fs").writeFileSync(${JSON.stringify(pidFile)},String(c.pid));console.log("ESCAPER "+c.pid);c.unref()'`;
}

type CountingListener = Readonly<{ server: Server; port: number; connections: () => number }>;

async function countingListener(port: number): Promise<CountingListener> {
  let connections = 0;
  const server = createServer((socket) => {
    connections += 1;
    socket.end();
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("qualification listener has no port");
  return { server, port: address.port, connections: () => connections };
}

async function settledCount(listener: CountingListener, atLeast: number): Promise<number> {
  const deadline = Date.now() + 2_000;
  while (listener.connections() < atLeast && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  return listener.connections();
}

async function connectsOutside(port: number): Promise<boolean> {
  return new Promise((resolveConnect) => {
    const socket = netConnect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      resolveConnect(true);
    });
    socket.once("error", () => resolveConnect(false));
  });
}

async function pidAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  const ps = await captureSupervised(PS_EXECUTABLE, ["-o", "stat=", "-p", String(pid)], { label: "ccc-confined-shell-ps" });
  return ps.code === 0 && ps.stdout.trim() !== "" && !ps.stdout.trim().startsWith("Z");
}

async function pidGoneWithin(pid: number, deadlineMs: number): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (await pidAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  return true;
}

/** SIGKILL a recorded escaper only while its command line still names this qualification's scratch. */
async function killRecordedEscaper(pid: number, marker: string): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) return;
  const ps = await captureSupervised(PS_EXECUTABLE, ["-o", "args=", "-p", String(pid)], { label: "ccc-confined-shell-ps" });
  if (ps.code !== 0 || !ps.stdout.includes(marker)) return;
  signalClonePid(pid, "SIGKILL");
}

/**
 * G0 self-qualification of the exact profile template and toolchain on this OS
 * build. Seven probes run through the real confined operations; each pairs the
 * sandboxed result with a control outside the sandbox, so a probe passes only
 * when the control works and the confinement decides the difference. A failed
 * probe is reported, never thrown; the caller maps any failure to
 * CCC_PLANNING_CONFINEMENT_UNQUALIFIED. Never uses kill(-1).
 *
 * E1-19: the env probe plants its canary in the controller's own environment
 * and requires every name inside to be sealed or added by bash. E1-20: escaper
 * pids are recorded outside the throwing helper, and `finally` sweeps the
 * instance and kills any recorded pid that still runs from this scratch.
 */
export async function qualifyCccConfinedShell(i: Readonly<{
  toolchain: CccSealedToolchain;
  scratchRoot: string;
}>): Promise<CccConfinementQualificationV1> {
  const base = realpathSync(await mkdtemp(join(cccCanonicalExistingPath(i.scratchRoot, "qualification scratch root"), "ccc-qual-")));
  const worktree = join(base, "worktree");
  const outsideDir = join(base, "outside");
  const shellScratch = join(base, "scratch");
  const token = (label: string) => `${label}-${createHash("sha256").update(`${base}:${label}:${process.hrtime.bigint()}`).digest("hex").slice(0, 16)}`;
  const canaryToken = token("outside-canary");
  const envToken = token("env-canary");
  const readmeToken = token("readme");
  const envCanary = token("env-scrubbed");
  await Promise.all([
    mkdir(join(worktree, "src"), { recursive: true }),
    mkdir(outsideDir, { recursive: true }),
    mkdir(shellScratch, { recursive: true }),
  ]);
  const canaryPath = join(outsideDir, "canary.txt");
  await Promise.all([
    writeFile(canaryPath, `${canaryToken}\n`),
    writeFile(join(worktree, ".env"), `SECRET=${envToken}\n`),
    writeFile(join(worktree, "README"), `${readmeToken}\n`),
  ]);
  const listeners: CountingListener[] = [];
  let sleeper: SupervisedChild | undefined;
  const escapers: number[] = [];
  let operations: BashOperations | undefined;
  try {
    const admitted = await countingListener(await acquireCccSemanticProofLoopbackPort());
    listeners.push(admitted);
    const unadmitted = await countingListener(0);
    listeners.push(unadmitted);
    const confined = confinedOperations({
      profileId: PROFILE_ID,
      worktreeRoot: worktree,
      gitDirs: [],
      writeRoots: [join(worktree, "src")],
      deniedNames: DEFAULT_DENIED_NAMES,
      deniedRoots: [],
      scratchRoot: shellScratch,
      toolchain: i.toolchain,
      taskEnv: {},
      loopbackPort: admitted.port,
      limits: QUALIFICATION_LIMITS,
      qualification: { receiptSha256: "0".repeat(64), profileTemplateSha256: CCC_WRITER_SHELL_PROFILE_TEMPLATE_SHA256, osBuild: readCccConfinementOsBuild() },
    }, { requireQualification: false });
    operations = confined;
    // Never throws: output gathered before a failure is still scanned for escaper pids.
    const run = async (command: string): Promise<Readonly<{ output: string; error: unknown }>> => {
      const chunks: Buffer[] = [];
      let error: unknown = null;
      try {
        await confined.exec(command, worktree, { onData: (data) => chunks.push(data) });
      } catch (caught) {
        error = caught;
      }
      const output = Buffer.concat(chunks).toString("utf8");
      for (const match of output.matchAll(/ESCAPER (\d+)/gu)) escapers.push(Number(match[1]));
      return { output, error };
    };
    const runOk = async (command: string): Promise<string> => {
      const { output, error } = await run(command);
      if (error !== null) throw error;
      return output;
    };
    const recordedPid = (output: string, pidFile: string): number => {
      let fromFile = Number.NaN;
      try {
        fromFile = Number(readFileSync(join(worktree, pidFile), "utf8").trim());
      } catch {
        // the command never wrote it
      }
      if (Number.isSafeInteger(fromFile) && fromFile > 1) escapers.push(fromFile);
      const fromOutput = Number(/ESCAPER (\d+)/u.exec(output)?.[1]);
      return Number.isSafeInteger(fromOutput) && fromOutput > 1 ? fromOutput : fromFile;
    };
    const probe = async (check: () => Promise<boolean>): Promise<boolean> => {
      try {
        return await check();
      } catch {
        return false;
      }
    };

    const networkDenied = await probe(async () => {
      if (!(await connectsOutside(unadmitted.port))) return false;
      const seen = await settledCount(unadmitted, 1);
      const output = await runOk(connectProbeCommand(unadmitted.port));
      return output.includes(`CONNECT-ERR ${unadmitted.port} EPERM`) && unadmitted.connections() === seen;
    });
    const loopbackAllowed = await probe(async () => {
      const before = admitted.connections();
      const output = await runOk(connectProbeCommand(admitted.port));
      return output.includes(`CONNECT-OK ${admitted.port}`) && (await settledCount(admitted, before + 1)) === before + 1;
    });
    const outsideReadDenied = await probe(async () => {
      if (!readFileSync(canaryPath, "utf8").includes(canaryToken)) return false;
      const output = await runOk(readProbeCommand(canaryPath, "outside"));
      return !output.includes(canaryToken) && output.includes("outside-rc=1");
    });
    const siblingSignalDenied = await probe(async () => {
      sleeper = superviseSpawn("/bin/sleep", ["60"], { stdio: "ignore", maxLifetimeMs: 70_000, diagnosticLabel: "ccc-confined-shell-qualification-sibling" });
      const pid = sleeper.pid;
      if (pid === undefined || !(await pidAlive(pid))) return false;
      const output = await runOk(`kill -0 ${pid}; echo "rc=$?"`);
      return output.includes("rc=1") && (await pidAlive(pid));
    });
    const deniedNameInRoot = await probe(async () => {
      if (!readFileSync(join(worktree, ".env"), "utf8").includes(envToken)) return false;
      const output = await runOk(`${readProbeCommand(".env", "env")}; ${readProbeCommand("README", "readme")}`);
      return !output.includes(envToken) && output.includes("env-rc=1") && output.includes(readmeToken) && output.includes("readme-rc=0");
    });
    const envScrubbed = await probe(async () => {
      const previous = process.env[QUALIFICATION_CANARY_NAME];
      process.env[QUALIFICATION_CANARY_NAME] = envCanary;
      try {
        // Control: the canary is in the controller's own environment, which is what a leak would forward.
        const control = await captureSupervised("/usr/bin/env", [], { label: "ccc-confined-shell-env-control", env: process.env });
        if (control.code !== 0 || !control.stdout.includes(envCanary)) return false;
        const output = await runOk(`node -e 'for (const [k,v] of Object.entries(process.env)) console.log(k+"="+v)'`);
        const inside = new Map(output.split("\n").filter((line) => line.length > 0).map((line) => {
          const index = line.indexOf("=");
          return [index > 0 ? line.slice(0, index) : line, index > 0 ? line.slice(index + 1) : ""] as const;
        }));
        const admittedNames = new Set<string>([...SEALED_ENV_KEYS, ...SHELL_ADDED_ENV_KEYS]);
        return inside.size > 0
          && [...inside.keys()].every((name) => admittedNames.has(name))
          && !output.includes(envCanary)
          && inside.get("HOME") === join(shellScratch, "home");
      } finally {
        if (previous === undefined) delete process.env[QUALIFICATION_CANARY_NAME];
        else process.env[QUALIFICATION_CANARY_NAME] = previous;
      }
    });
    const escaperReaped = await probe(async () => {
      // First line: the in-sandbox reaper kills a detached escaper and lists it.
      const first = await run(escaperProbeCommand("src/qualification-escaper-1.pid"));
      const firstPid = recordedPid(first.output, "src/qualification-escaper-1.pid");
      if (first.error !== null || !Number.isSafeInteger(firstPid) || firstPid <= 1) return false;
      const firstKilled = (cccConfinedShellLastClosure(confined)?.killed ?? []).includes(firstPid);
      if (!firstKilled || !(await pidGoneWithin(firstPid, 2_000))) return false;
      // Authority (ADR X1-R): the command kills its own reaper; the controller sweep must still kill the escaper.
      const second = await run(`${escaperProbeCommand("src/qualification-escaper-2.pid")}; kill -9 $PPID`);
      const secondPid = recordedPid(second.output, "src/qualification-escaper-2.pid");
      if (second.error instanceof CccConfinementClosureError || !Number.isSafeInteger(secondPid) || secondPid <= 1) return false;
      return (cccConfinedShellLastClosure(confined)?.killed ?? []).includes(secondPid) && (await pidGoneWithin(secondPid, 2_000));
    });

    return {
      schema: "ccc-confinement-qualification.v1",
      osBuild: readCccConfinementOsBuild(),
      profileTemplateSha256: CCC_WRITER_SHELL_PROFILE_TEMPLATE_SHA256,
      toolchainSha256: i.toolchain.toolchainSha256,
      probes: [
        { probe: "network-denied", passed: networkDenied },
        { probe: "loopback-port-allowed", passed: loopbackAllowed },
        { probe: "outside-read-denied", passed: outsideReadDenied },
        { probe: "sibling-signal-denied", passed: siblingSignalDenied },
        { probe: "denied-name-in-root", passed: deniedNameInRoot },
        { probe: "env-scrubbed", passed: envScrubbed },
        { probe: "escaper-reaped", passed: escaperReaped },
      ],
    };
  } finally {
    sleeper?.kill("SIGKILL");
    if (operations) await instanceSweeps.get(operations)?.().catch(() => null);
    for (const pid of new Set(escapers)) await killRecordedEscaper(pid, base);
    await Promise.all(listeners.map((listener) => new Promise<void>((resolveClose) => listener.server.close(() => resolveClose()))));
    await rm(base, { recursive: true, force: true });
  }
}
