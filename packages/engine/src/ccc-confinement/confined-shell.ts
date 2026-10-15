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
  copy across volumes) into its own `<scratch>/toolchains/<instanceId>/bin/`,
  one file per PATH name (E2-24, E2-25). A dylib the executable loads relative
  to itself (`@rpath`, `@loader_path`) is cloned to the same place relative to
  `bin/` (Homebrew node's `../lib/libnode`). `process-exec` is admitted only
  under the instance directory, and the profile denies every write under
  `<scratch>/toolchains/`, so a hard link out of it is refused, a copy cannot
  run, and a symlink still runs the clone. Every sandboxed process therefore
  runs from that directory.
- macOS kills an Apple platform binary (`/bin/bash`, `/bin/cat`, ...) copied off
  the system volume, so platform binaries cannot be sealed
  (`platform-binary-in-toolchain`). The toolchain is Homebrew-style: a
  non-platform bash (sealed as `sh` too: bash run as `sh` is POSIX mode), node,
  git and utilities. A utility appears in PATH under its sealed `name`, or else
  its real file name (coreutils' `gcat` sealed with name `cat` runs as `cat`).
  Absolute-path shebangs such as `#!/bin/sh` and `#!/usr/bin/env` cannot run
  inside; invoke the interpreter (toolchain discovery and shims are card X1b).
- After every exec that started a process (normal, error, timeout and
  qualification-failure paths) the controller finds every same-uid process
  whose `lsof` txt mapping is one of the clone's inodes (argv[0] spoofing with
  `exec -a` cannot hide it; `ps comm` can be fooled), SIGSTOPs each, re-scans
  until no new pid appears, SIGKILLs the confirmed set, and requires two
  consecutive empty scans, within a bounded number of scans. A converged sweep
  confirms closure even when the reaper died or froze. A sweep that does not
  converge is CLOSURE_UNCONFIRMED: descendants may still be running with write
  access to the write roots and scratch and network access to the admitted
  loopback port, so the caller quarantines (errata E2-5: WR moves the write
  roots out of place). Cost: every exec pays at least two lsof scans (about
  0.3 s each measured on the M5 Max), and a command that leaves a survivor
  pays about four.
- The in-sandbox reaper stays as the fast first line. Launch shape:
  `sandbox-exec -p <profile> <cloned node> -e REAPER_SOURCE -- ...`. It spawns
  bash detached with its own pipes, relays at most `maxOutputBytes`, and on
  bash exit, controller `reap`, or stdin EOF SIGSTOPs bash's group, then sweeps
  pid 2..99999 with signal 0 and SIGSTOPs every answer until two consecutive
  passes find nothing new (P6-P8), so nothing it found can run, fork or exit
  before the controller sees it. It never sweeps unless signalling the
  controller fails with EPERM, so it cannot run outside a sandbox, and it never
  uses kill(-1). It writes one framed record to fd 3.
- Execs on one instance are serialized, so the last-closure record and the
  shared scratch home and tmp belong to one command at a time (E1-20).

Residual (recorded, not closed here): a process that forks and exits faster
than one lsof pass can evade a snapshot scan; the per-user process limit
bounds it, and the sweep stops what it sees before killing it.

FNXC:CccConfinedShell 2026-10-14-13:43:
Errata E2 (final repair of X1).
- E2-21/E2-11: `qualifyCccConfinedShell` takes a `testOnly` seam
  (`sealedEnvironment`, `lsofPath`); production never passes it. It exists so
  a test can prove the env-scrubbed probe fails on a leaked environment.
  `createCccConfinedBashOperations` takes the same seam as an optional second
  argument, which keeps the contract type `CccConfinedShellInput` unchanged.
- E2-22: the sweep spawns `/usr/sbin/lsof` by absolute path through the
  supervised async capture. Creation refuses with `closure-sweep-unavailable`
  when it is not an absolute executable file. A scan that fails, times out,
  prints a line that is not an lsof field, or does not list the controller is
  unconfirmed, never a confirmation.
- E2-23: one exported write predicate (`cccConfinedWriteRefusal`) and the
  effective denied names (`cccConfinedEffectiveDeniedNames`, always a superset
  of `CCC_CONFINED_DEFAULT_DENIED_NAMES`) decide `.git` segments and denied
  names for this shell's validation and for C2's file tools. Names compare
  under K1's fold (E2-40). The defaults add `.envrc`, so they stay a superset
  of K1's `CCC_PLANNING_DENIED_NAMES` after E2-42 (the INT-1 check, E2-81).
  Measured here: sandbox-exec's path regexes already match case-insensitively,
  Unicode folds included, on this APFS volume (`.ENV`, `.NPMRC`, `_ſecrets`
  are all refused), so the profile keeps its plain regexes.
- E2-24: `dispose()` sweeps once more, removes exactly this instance's
  directory, and later execs refuse with `instance-disposed` (a reason this
  repair adds; E2-24 names none).
- E2-26c: the closure record's `killed` lists only pids the controller saw
  with a txt mapping in the clone. The reaper therefore stops rather than
  kills, so the controller sees, kills and records every instance process,
  and a foreign zombie that answers the reaper's signal 0 (P7) is left out.
- E2-26a, measured on this host (M5 Max, macOS 26): RLIMIT_CPU stops a pure
  user-mode loop (`node -e 'for(;;){}'` under `ulimit -t 2` dies of SIGXCPU
  after about 2.0 s), but a loop that makes a system call on every pass
  (`process.cpuUsage()`, `process.getuid()`, `fs.fstatSync`) is never stopped by
  it (still running at 15-20 s). A loop that makes one every 1,000 passes is
  stopped, about 1 s late. The binding CPU bound is therefore the wall ceiling
  (`wallMsCeiling`, enforced by the controller), not `cpuSeconds`. The risk row
  lives in the contract (section 6, risk 44, per errata E4 X1c item 11): a
  per-pass syscall loop is bounded by the wall timer, not by RLIMIT_CPU.

FNXC:CccConfinedShell 2026-10-14-14:07:
The command's wall timer starts when the reaper reports the command spawned
(a `CCC-STARTED` frame on fd 3, before the exited frame), not when the
controller spawns sandbox-exec. Measured: the first exec of a freshly cloned
binary inside the sandbox costs 1 to 3 s on a loaded host (about 0.2 s
outside it), which made a 1 s model timeout fire before a 10 ms command ran.
The runner's own timeout, counted from spawn, still bounds the whole exec.
Under a load average of 16 to 33 each lsof scan costs 0.5 to 0.9 s, not the
0.3 s quoted above for a quiet host.

FNXC:CccConfinedShell 2026-10-14-15:20:
Errata E4, card X1c (X1 residuals). Signatures change only where E4 allows:
`dispose()` returns `CccConfinedDisposeResult`, the factory's `testOnly` is
narrowed to `{ lsofPath? }`, and `CccSealedToolchain` gains `libraries`, which
`sealCccToolchain` computes.
- Item 4, seal coverage: the clone copies every sealed executable and every
  library an executable loads from inside its own install root (Homebrew
  node's `lib/libnode.*.dylib`). `sealCccToolchain` now finds those libraries,
  hashes them and records each with its place in the clone (`clonePath`), and
  the toolchain digest covers them. Creation re-hashes them, the clone copies
  exactly the sealed list and hashes every copied file, and every exec
  re-checks every source and clone file (size, mtime, ctime and inode, with a
  full re-hash when any of them moved). A drifted library is
  `toolchain-digest-drift`.
- Item 5: `createCccConfinedBashOperations` accepts only `{ lsofPath? }` as its
  test seam; any other key, `sealedEnvironment` included, is a TypeError. The
  environment seam stays on `qualifyCccConfinedShell` (E2-11).
- Item 6: `dispose()` returns `{ closure: "unconfirmed" }` when its final sweep
  does not converge or any earlier exec ended CLOSURE_UNCONFIRMED, otherwise
  `{ closure: "confirmed" }`, and returns the same result on every call.
- Item 7: the template material also binds `SYSTEM_RUNTIME_READ_ROOTS`,
  `DEVICE_READ_FILES` and a rendering of the whole writer-profile assembly for
  sentinel inputs, so widening any input of the assembly changes the digest.
- Item 8: when closure cannot be confirmed, the controller SIGKILLs every pid
  the reaper reported stopping before it refuses, so no stopped orphan is left.
  The foreign-pid filter (E2-26c): a pid a controller scan saw running from the
  clone is an instance process; any other reported pid is killed only when
  `ps` shows it is ours (same uid) and stopped (`T`), so the foreign zombie
  (`Z`, P7) the reaper can signal, or a pid since recycled by a running
  process, is never signalled. A failed sweep also kills the pids it stopped.
- Item 9 (E4-7): the exit status of an lsof scan never decides; a scan is
  trusted only when its output parses and lists the controller's own pid. This
  was already the E2-22 behaviour; X1c pins it with tests.

FNXC:CccConfinedShell 2026-10-14-17:30:
Errata E6-X, card X1c repair 1. No exported signature changes.
- Item 1: the reaper-stopped orphan kill is best effort. A throw from it (a
  /bin/ps spawn can throw synchronously, for example ENOMEM) is recorded in the
  message and never replaces the CLOSURE_UNCONFIRMED error, and `execOnce` sets
  the instance's unconfirmed latch itself on both closure-error paths before
  anything else can throw.
- Item 2: `dispose()` also reports unconfirmed when its final sweep finds any
  process running from the clone: every exec has ended by then, so a survivor
  proves an earlier confirmation wrong.
- Item 3 (v3.2 F3): a reaper-reported pid no scan saw is killed only when `ps`
  shows the same uid, a stopped state and a start time no earlier than the
  second the exec started. macOS gives no executable path without lsof that
  `exec -a` cannot spoof (`ps -o comm` is argv[0], `ps -o ucomm` a 16-character
  file name), so that fourth condition is not used.
- Item 5: every sweep scan runs `lsof -b`. Without it lsof stats every mount
  point first, including this host's smbfs Time Machine mount over Tailscale
  (`/Volumes/.timemachine/...`), and that stat most likely blocks while the
  server is unreachable: the X1b adversary saw scans stall at the 11 s capture limit in
  bursts (3 of 13 tests in one closed check; one standalone scan of 11.24 s;
  0 of 90 later samples), and X1c round 1 saw hand scans of 10.3 s and 11.1 s
  and two whole-file runs fail. Measured here (120 interleaved rounds, load
  8.1 to 13.3): no stall with or without `-b` in that window; without `-b`
  all 120 scans warned that lsof could not stat the smbfs mount, while `-b`
  makes lsof report "avoiding stat(...): -b was specified" for each mount
  point; median 0.194 s with `-b` against 0.225 s without, worst 0.34 s
  against 0.47 s. Apple's lsof 4.91 rejects `-e` (illegal option), so a mount
  cannot be exempted alone. One bounded retry of a timed-out scan was not
  applied: the stalls came in bursts, so a retry would mostly double the wait
  before the same failure. `-b` keeps the E4-7 trust rule: the scan still
  parses, lists the controller and matches clone inodes (txt device and inode
  are identical with and without `-b`, measured on a cloned bash).
- Item 6: names and path segments use K1's `cccPlanningPathComparisonKey`
  (the K1b form that merges U+1E9E with "ss"); the private fold is gone.
- Item 7: the template material binds the dylib-closure discovery: the source
  of `darwinLinkedRuntimeFiles`, `resolveLinkedPath` and its helpers, and of
  this file's steps from the sealed executables to a read root, so any change
  to a rule that could widen a read root changes the template digest.
*/
import { createHash, randomBytes } from "node:crypto";
import { accessSync, constants as fsConstants, existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect as netConnect, createServer, type Server } from "node:net";
import { constants as osConstants } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Readable, Writable } from "node:stream";
import { cccPlanningPathComparisonKey, superviseSpawn, type SupervisedChild } from "@fusion/core";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import {
  acquireCccSemanticProofLoopbackPort,
  cccCanonicalExistingPath,
  cccDarwinLinkedRuntimeFiles,
  cccExecutableInstallRoot,
  cccIsHomebrewRuntimePath,
  cccIsSameOrWithin,
  cccResolveLinkedPath,
  cccSealedToolchainRoot,
  cccPathAncestors,
  cccSbplLiteral,
  cccSbplLoopbackPortRules,
  cccSbplSubpath,
  cccUniqueSortedPaths,
  readCccSemanticProofSandboxReadiness,
  runCccDarwinSandboxedProcess,
} from "../ccc-campaign-proof-sandbox.js";

/** `name` (E2-25, `^[A-Za-z0-9._+-]{1,64}$`) is the PATH name of a utility's clone; it defaults to the file's basename. */
export type CccSealedExecutable = Readonly<{ path: string; sha256: string; name?: string }>;
/**
 * E4 X1c item 4: a library the per-instance clone copies (an executable loads
 * it from inside its own install root, such as Homebrew node's
 * `lib/libnode.*.dylib`). `clonePath` is where the copy sits relative to the
 * instance directory (`lib/libnode.137.dylib`). Only `sealCccToolchain` builds it.
 */
export type CccSealedLibrary = Readonly<{ path: string; sha256: string; clonePath: string }>;
export type CccSealedToolchain = Readonly<{
  bash: CccSealedExecutable;
  sh: CccSealedExecutable;
  node: CccSealedExecutable;
  git: CccSealedExecutable & Readonly<{ execPath: string }>;
  utilities: readonly CccSealedExecutable[];
  /** E4 X1c item 4: every library the clone copies, computed and hashed by `sealCccToolchain` and covered by the digest. */
  libraries: readonly CccSealedLibrary[];
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
  | "taskenv-not-allowlisted"
  | "closure-sweep-unavailable"
  | "platform-binary-in-toolchain"
  | "instance-disposed";

/**
 * Test-only seams of `qualifyCccConfinedShell` (E2-11, E2-21, E2-22).
 * Production never passes them. `sealedEnvironment` rewrites the sealed
 * environment just before each exec; `lsofPath` replaces the absolute
 * `/usr/sbin/lsof` the controller sweep runs.
 */
export type CccConfinedShellTestOnly = Readonly<{
  sealedEnvironment?: (sealed: Readonly<Record<string, string>>) => Readonly<Record<string, string>>;
  lsofPath?: string;
}>;

/**
 * E4 X1c item 5: the operations factory's only test seam. Any other key,
 * `sealedEnvironment` included, is a TypeError at creation.
 */
export type CccConfinedBashOperationsTestOnly = Readonly<{ lsofPath?: string }>;

/**
 * E4-9: what `dispose()` learned about closure. "unconfirmed" when its final
 * sweep did not converge or any earlier exec ended CLOSURE_UNCONFIRMED.
 */
export type CccConfinedDisposeResult = Readonly<{ closure: "confirmed" | "unconfirmed" }>;

/** E2-24: the operations own their toolchain clone; `dispose` removes it and later execs refuse. */
export type CccConfinedBashOperations = BashOperations & Readonly<{ dispose(): Promise<CccConfinedDisposeResult> }>;

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
/** E2-22: the sweep runs this exact file, never a PATH lookup. */
const LSOF_EXECUTABLE = "/usr/sbin/lsof";
const PS_EXECUTABLE = "/bin/ps";
/** E2-24: every instance clone lives at `<scratch>/toolchains/<instanceId>/`; the whole directory is write-denied. */
const TOOLCHAINS_DIR_NAME = "toolchains";
const CONTROLLER_SWEEP_MAX_SCANS = 20;
const CONTROLLER_SWEEP_SETTLE_MS = 50;
const CLOSURE_FRAME_PREFIX = "CCC-CLOSURE ";
const EXITED_FRAME_PREFIX = "CCC-EXITED ";
const STARTED_FRAME_PREFIX = "CCC-STARTED ";
const SHA256_HEX = /^[0-9a-f]{64}$/u;
/** E2-25: the PATH name a sealed utility may carry. */
const SEALED_NAME_SHAPE = /^[A-Za-z0-9._+-]{1,64}$/u;
const DENIED_NAME_SHAPE = /^[A-Za-z0-9._*-]+$/u;
const SYSTEM_RUNTIME_READ_ROOTS = [
  "/System/Library",
  "/usr/lib",
  "/private/var/db/dyld",
  "/usr/share/zoneinfo",
  "/private/var/db/timezone",
] as const;
const DEVICE_READ_FILES = ["/dev/null", "/dev/urandom"] as const;
/**
 * E2-23: the names every confined shell denies, whatever the caller passes. A
 * superset of K1's `CCC_PLANNING_DENIED_NAMES` including E2-42's `.envrc`
 * (INT-1 asserts it, E2-81).
 */
export const CCC_CONFINED_DEFAULT_DENIED_NAMES: readonly string[] = Object.freeze([
  ".agentsecrets",
  ".env",
  ".env.*",
  ".envrc",
  ".npmrc",
  "_secrets",
]);
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
// The controller's command timer starts here, so this reaper's own launch is not charged to the command.
child.on("spawn", () => {
  if (!reaping) writeFrame("${STARTED_FRAME_PREFIX}" + JSON.stringify({ pid: child.pid }) + "\n");
});
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
  // Stop, never kill: a stopped process cannot run, fork or exit, so the
  // controller still sees it running from the clone, kills it and records it.
  if (typeof child.pid === "number") {
    try {
      process.kill(-child.pid, "SIGSTOP");
    } catch {}
  }
  const stopped = new Set();
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
        if (!stopped.has(pid)) {
          fresh = true;
          stopped.add(pid);
        }
        try {
          process.kill(pid, "SIGSTOP");
        } catch {}
      }
      clean = fresh ? 0 : clean + 1;
      last = found;
    }
  }
  writeFrame("${CLOSURE_FRAME_PREFIX}" + JSON.stringify({
    v: 2,
    sandboxed,
    converged: clean >= 2,
    outputCapped,
    exit: exitInfo,
    record: { passes, stopped: [...stopped].sort((a, b) => a - b), persistent: last },
  }) + "\n");
  // The stopped bash never exits; unref it so this process can end.
  child.unref();
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
    refuse(
      "platform-binary-in-toolchain",
      `sealed ${label} ${real} is an Apple platform binary, which macOS kills when it runs from the per-instance clone (ADR X1-R); seal a non-platform build such as Homebrew's`,
    );
  }
  return { path: real, sha256: fileSha256(real) };
}

function isSealedName(name: unknown): name is string {
  return typeof name === "string" && SEALED_NAME_SHAPE.test(name) && name !== "." && name !== "..";
}

type ToolchainBody = Omit<CccSealedToolchain, "toolchainSha256">;
/** The executables of a toolchain, before or after its libraries are sealed. */
type ToolchainExecutables = Pick<CccSealedToolchain, "bash" | "sh" | "node" | "git" | "utilities">;

function toolchainDigest(body: ToolchainBody): string {
  // A nameless entry hashes exactly as before E2-25.
  const entry = (value: CccSealedExecutable) => ({
    path: value.path,
    sha256: value.sha256,
    ...(value.name !== undefined ? { name: value.name } : {}),
  });
  return createHash("sha256").update(JSON.stringify({
    schema: "ccc-sealed-toolchain.v1",
    bash: entry(body.bash),
    sh: entry(body.sh),
    node: entry(body.node),
    git: { ...entry(body.git), execPath: body.git.execPath },
    utilities: body.utilities.map(entry),
    // E4 X1c item 4: every file the clone copies is in the digest, libraries included.
    libraries: body.libraries.map((library) => ({ path: library.path, sha256: library.sha256, clonePath: library.clonePath })),
  })).digest("hex");
}

/** A library's place in the clone: a relative path inside the instance directory with no empty, `.` or `..` segment. */
function isCloneRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096 || value.includes("\u0000") || isAbsolute(value)) {
    return false;
  }
  return value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * E4 X1c item 4: the libraries the per-instance clone copies, found with the
 * same rule the clone used before X1c: a linked runtime file an executable
 * loads from inside its own install root (the directory above its `bin/`),
 * placed at the same position relative to the clone's `bin/` (Homebrew node's
 * `@rpath/libnode` becomes `lib/libnode.*.dylib`). Each is hashed here, so the
 * digest, the post-clone check and the per-exec check all cover it. A library
 * that would land outside the instance directory, on a sealed PATH name, or on
 * the same place as another library is `toolchain-digest-drift`.
 */
async function sealedLibraries(executables: ToolchainExecutables): Promise<CccSealedLibrary[]> {
  const pathNames = toolchainPathNames(executables);
  const reserved = new Set([...pathNames.keys()].map((name) => `bin/${name}`));
  const linked = await linkedRuntimeFilesForExecutables(toolchainExecutables(executables));
  const byClonePath = new Map<string, CccSealedLibrary>();
  for (const executable of new Set([...pathNames.values()].map((entry) => entry.path))) {
    const installRoot = dirname(dirname(executable));
    for (const file of linked) {
      if (file === executable || isApplePlatformPath(file) || !cccIsSameOrWithin(file, installRoot) || !isRegularFile(file)) continue;
      const clonePath = join("bin", relative(dirname(executable), file));
      if (!isCloneRelativePath(clonePath)) {
        refuse("toolchain-digest-drift", `${file} would be cloned outside the instance directory (${clonePath})`);
      }
      if (reserved.has(clonePath)) refuse("toolchain-digest-drift", `${file} would be cloned onto the sealed PATH name ${clonePath}`);
      const existing = byClonePath.get(clonePath);
      if (existing !== undefined && existing.path !== file) {
        refuse("toolchain-digest-drift", `${existing.path} and ${file} would both be cloned to ${clonePath}`);
      }
      byClonePath.set(clonePath, { path: file, sha256: existing?.sha256 ?? fileSha256(file), clonePath });
    }
  }
  return [...byClonePath.values()].sort((left, right) => (
    compareCodeUnits(left.clonePath, right.clonePath) || compareCodeUnits(left.path, right.path)
  ));
}

/** A utility to seal: its path, or its path and the PATH name its clone takes (E2-25). */
export type CccToolchainUtilitySpec = string | Readonly<{ path: string; name?: string }>;

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Seals real-path executables with their sha256 and the toolchain digest. Never
 * pass Homebrew `bin/` shims or `/usr/bin/git` (an xcrun shim), and never an
 * Apple platform binary: only non-platform builds run from the per-instance clone.
 * A utility given as `{ path, name }` appears in PATH as `name` (GNU `gcat` as `cat`).
 */
export async function sealCccToolchain(i: Readonly<{
  bash: string;
  sh: string;
  node: string;
  git: string;
  utilities: readonly CccToolchainUtilitySpec[];
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
    const spec = typeof utility === "string" ? { path: utility } : utility;
    if (spec.name !== undefined && !isSealedName(spec.name)) {
      refuse("toolchain-digest-drift", `sealed utility name ${JSON.stringify(spec.name)} must match ${SEALED_NAME_SHAPE.source} and not be . or ..`);
    }
    const sealed = sealedExecutable(spec.path, "utility");
    const entry: CccSealedExecutable = spec.name === undefined ? sealed : { ...sealed, name: spec.name };
    // The same file under the same name twice is one entry; anything else that shares a name refuses below.
    utilities.set(`${entry.path}\u0000${entry.name ?? ""}`, entry);
  }
  const executables: ToolchainExecutables = {
    bash: sealedExecutable(i.bash, "bash"),
    sh: sealedExecutable(i.sh, "sh"),
    node: sealedExecutable(i.node, "node"),
    git: { ...git, execPath: cccCanonicalExistingPath(execPath.stdout.trim(), "sealed git exec path") },
    utilities: [...utilities.values()].sort((left, right) => (
      compareCodeUnits(left.path, right.path) || compareCodeUnits(left.name ?? "", right.name ?? "")
    )),
  };
  // Names are checked before the (slower) library discovery, which needs them.
  toolchainPathNames(executables);
  const body: ToolchainBody = { ...executables, libraries: await sealedLibraries(executables) };
  return { ...body, toolchainSha256: toolchainDigest(body) };
}

function toolchainExecutables(toolchain: ToolchainExecutables): CccSealedExecutable[] {
  return [toolchain.bash, toolchain.sh, toolchain.node, toolchain.git, ...toolchain.utilities];
}

/**
 * The PATH names inside the sandbox, each naming one clone file: the four roles
 * under their role names, then each utility under `name ?? basename(path)`
 * (E2-25). A duplicate effective name, a role carrying another name, or a
 * malformed name is `toolchain-digest-drift`.
 */
function toolchainPathNames(toolchain: ToolchainExecutables): Map<string, CccSealedExecutable> {
  const names = new Map<string, CccSealedExecutable>();
  const add = (name: string, executable: CccSealedExecutable) => {
    const existing = names.get(name);
    if (existing !== undefined) {
      refuse("toolchain-digest-drift", `two sealed executables share the PATH name ${name}: ${existing.path} and ${executable.path}`);
    }
    names.set(name, executable);
  };
  const roles = [["bash", toolchain.bash], ["sh", toolchain.sh], ["node", toolchain.node], ["git", toolchain.git]] as const;
  for (const [role, executable] of roles) {
    if (executable.name !== undefined && executable.name !== role) {
      refuse("toolchain-digest-drift", `the sealed ${role} appears under its role name, not ${JSON.stringify(executable.name)}`);
    }
    add(role, executable);
  }
  for (const utility of toolchain.utilities) {
    if (utility.name !== undefined && !isSealedName(utility.name)) {
      refuse("toolchain-digest-drift", `sealed utility name ${JSON.stringify(utility.name)} is malformed`);
    }
    const name = utility.name ?? basename(utility.path);
    if (name === "" || name === "." || name === ".." || name.includes("\u0000")) {
      refuse("toolchain-digest-drift", `sealed utility ${utility.path} has no usable PATH name`);
    }
    add(name, utility);
  }
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

/**
 * Every sealed path must still be its own non-platform real path with the
 * sealed bytes, and every sealed library (E4 X1c item 4) must still hold its
 * sealed bytes at a well-formed place in the clone.
 */
function verifyToolchain(toolchain: CccSealedToolchain): FileIdentity[] {
  const identities: FileIdentity[] = [];
  if (!Array.isArray(toolchain.libraries)) {
    refuse("toolchain-digest-drift", "the sealed toolchain record has no library list; seal it with sealCccToolchain");
  }
  const clonePaths = new Set<string>();
  for (const library of toolchain.libraries) {
    if (
      library === null || typeof library !== "object" || typeof library.path !== "string" || !isAbsolute(library.path)
      || typeof library.sha256 !== "string" || !SHA256_HEX.test(library.sha256) || !isCloneRelativePath(library.clonePath)
      || clonePaths.has(library.clonePath)
    ) {
      refuse("toolchain-digest-drift", `sealed library record is malformed: ${String((library as { path?: unknown } | null)?.path)}`);
    }
    clonePaths.add(library.clonePath);
    if (isApplePlatformPath(library.path)) {
      refuse("platform-binary-in-toolchain", `sealed library ${library.path} is an Apple platform file, which cannot join the per-instance clone`);
    }
    if (!isRegularFile(library.path)) refuse("toolchain-digest-drift", `sealed library is missing or not a regular file: ${library.path}`);
    if (fileSha256(library.path) !== library.sha256) refuse("toolchain-digest-drift", `sealed library bytes changed: ${library.path}`);
    identities.push(fileIdentity(library.path, library.sha256));
  }
  for (const executable of toolchainExecutables(toolchain)) {
    if (
      typeof executable.path !== "string" || !isAbsolute(executable.path) || typeof executable.sha256 !== "string"
      || !SHA256_HEX.test(executable.sha256) || (executable.name !== undefined && !isSealedName(executable.name))
    ) {
      refuse("toolchain-digest-drift", `sealed executable record is malformed: ${String(executable.path)}`);
    }
    if (isApplePlatformPath(executable.path)) {
      refuse("platform-binary-in-toolchain", `sealed executable ${executable.path} is an Apple platform binary, which cannot run from the per-instance clone`);
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
    refuse("toolchain-digest-drift", "toolchainSha256 does not match the sealed executables and libraries");
  }
  for (const name of toolchainPathNames(toolchain).keys()) {
    if (clonePaths.has(`bin/${name}`)) refuse("toolchain-digest-drift", `a sealed library would be cloned onto the sealed PATH name ${name}`);
  }
  return identities;
}

/**
 * Cheap per-command re-check of every sealed file, executables and libraries
 * alike (E4 X1c item 4): re-hash only a file whose size, mtime, ctime, device or
 * inode changed since it was hashed in full.
 */
function recheckToolchain(identities: readonly FileIdentity[]): void {
  for (const identity of identities) {
    let stat;
    try {
      stat = statSync(identity.path);
    } catch {
      refuse("toolchain-digest-drift", `sealed file disappeared: ${identity.path}`);
    }
    if (
      stat.dev === identity.dev && stat.ino === identity.ino && stat.size === identity.size
      && stat.mtimeMs === identity.mtimeMs && stat.ctimeMs === identity.ctimeMs
    ) {
      continue;
    }
    if (fileSha256(identity.path) !== identity.sha256) {
      refuse("toolchain-digest-drift", `sealed file bytes changed: ${identity.path}`);
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

function assertDeniedName(name: unknown): asserts name is string {
  if (typeof name !== "string" || !DENIED_NAME_SHAPE.test(name) || name === "." || name === "..") {
    throw new Error(`denied name must be a single path component of [A-Za-z0-9._*-]: ${String(name)}`);
  }
}

/** sandbox-exec regex for one denied name as any path segment (the sandbox already folds case on APFS). */
function deniedNamePattern(name: string): string {
  assertDeniedName(name);
  const body = [...name].map((character) => (character === "*" ? "[^/]*" : character === "." ? "\\." : character)).join("");
  return `#"/${body}(/.*)?$"`;
}

/**
 * E2-23: the caller's denied names united with `CCC_CONFINED_DEFAULT_DENIED_NAMES`,
 * folded, de-duplicated and sorted. Each name is one path component of
 * `[A-Za-z0-9._*-]`, where `*` matches any run of characters within a segment.
 * A caller can add names, never remove a default. E6-X item 6: names and path
 * segments are folded with K1's `cccPlanningPathComparisonKey` (the K1b form,
 * which also merges U+1E9E with "ss"), the one path key of every planning card.
 */
export function cccConfinedEffectiveDeniedNames(callerNames: readonly string[]): readonly string[] {
  for (const name of callerNames) assertDeniedName(name);
  const folded = new Set([...CCC_CONFINED_DEFAULT_DENIED_NAMES, ...callerNames].map(cccPlanningPathComparisonKey));
  return Object.freeze([...folded].sort(compareCodeUnits));
}

export type CccConfinedWriteRefusal = "outside-write-roots" | "git-segment" | "denied-name";

/**
 * The real path a write to `path` lands on: the longest existing ancestor
 * resolved by the OS (`realpath(3)`, which also restores the on-disk case),
 * then the missing tail. An entry that exists but does not resolve (a dangling
 * or looping symlink) is null, because a write would follow it somewhere unknown.
 */
function writeLandingPath(path: string): string | null {
  const resolved = resolve(path);
  try {
    return realpathSync.native(resolved);
  } catch {
    // missing, or present but unresolvable; told apart below
  }
  try {
    lstatSync(resolved);
    return null;
  } catch {
    // missing: resolve the parent and keep this component
  }
  const parent = dirname(resolved);
  if (parent === resolved) return null;
  const landing = writeLandingPath(parent);
  return landing === null ? null : join(landing, basename(resolved));
}

function pathSegments(path: string): string[] {
  return path.split(sep).filter((segment) => segment.length > 0);
}

function deniedNameRegex(name: string): RegExp {
  const body = [...name].map((character) => (character === "*" ? ".*" : character === "." ? "\\." : character)).join("");
  return new RegExp(`^${body}$`, "su");
}

/**
 * E2-23, the one write predicate both confined shells share (this profile's
 * validation and C2's write, edit and grep paths). `path` must be absolute.
 * It is refused when its real landing path is outside every write root, when
 * its spelled or real path has a `.git` segment, or when any segment of
 * either equals an effective denied name (the defaults always included), all
 * names compared under K1's fold. Returns null when the write is admitted.
 */
export function cccConfinedWriteRefusal(i: Readonly<{
  path: string;
  writeRoots: readonly string[];
  deniedNames: readonly string[];
}>): null | CccConfinedWriteRefusal {
  const deniedNames = cccConfinedEffectiveDeniedNames(i.deniedNames);
  if (typeof i.path !== "string" || !isAbsolute(i.path)) return "outside-write-roots";
  const landing = writeLandingPath(i.path);
  const roots = i.writeRoots.flatMap((root) => {
    if (typeof root !== "string" || !isAbsolute(root)) return [];
    const canonicalRoot = writeLandingPath(root);
    return canonicalRoot === null ? [] : [canonicalRoot];
  });
  if (landing === null || !roots.some((root) => cccIsSameOrWithin(landing, root))) return "outside-write-roots";
  const segments = [...pathSegments(resolve(i.path)), ...pathSegments(landing)].map(cccPlanningPathComparisonKey);
  if (segments.includes(".git")) return "git-segment";
  const patterns = deniedNames.map(deniedNameRegex);
  if (segments.some((segment) => patterns.some((pattern) => pattern.test(segment)))) return "denied-name";
  return null;
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
  // E1-20 and E2-23: the defaults always apply; a caller can add names, never remove `.env`.
  const deniedNames = [...cccConfinedEffectiveDeniedNames(input.deniedNames)];
  const overlaps = (left: string, right: string) => cccIsSameOrWithin(left, right) || cccIsSameOrWithin(right, left);
  const toolchainPaths = [
    ...toolchainExecutables(input.toolchain).map((entry) => entry.path),
    input.toolchain.git.execPath,
    ...(Array.isArray(input.toolchain.libraries) ? input.toolchain.libraries.map((library) => library.path) : []),
  ];
  for (const writeRoot of writeRoots) {
    if (!cccIsSameOrWithin(writeRoot, worktreeRoot)) refuse("root-overlap", `write root is outside the worktree: ${writeRoot}`);
    if (gitDirs.some((gitDir) => overlaps(writeRoot, gitDir))) refuse("root-overlap", `write root overlaps a git dir: ${writeRoot}`);
    // E2-23: a root the shared write predicate refuses would be a root nothing can be written to.
    const refusal = cccConfinedWriteRefusal({ path: writeRoot, writeRoots: [writeRoot], deniedNames });
    if (refusal !== null) refuse("root-overlap", `write root ${writeRoot} is refused by the shared write predicate (${refusal})`);
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
    deniedNames,
    scratchRoot,
    ...(input.loopbackPort !== undefined ? { loopbackPort: input.loopbackPort } : {}),
  };
}

function renderWriterProfile(slots: Readonly<Record<"EXEC" | "LOOPBACK" | "METADATA" | "READ" | "WRITE" | "DENY", string>>): string {
  const rendered = PROFILE_TEMPLATE.replace(/\{\{(EXEC|LOOPBACK|METADATA|READ|WRITE|DENY)\}\}/gu, (_match, slot: keyof typeof slots) => slots[slot]);
  return `${rendered.split("\n").filter((line) => line.trim() !== "").join("\n")}\n`;
}

/**
 * The dylib closure depends only on the sealed executables (their paths, in
 * toolchain order, and their bytes), so it is discovered once per such list per
 * process (about 1.5 s of otool calls), shared by the seal and the profile. A
 * stale entry can only under-admit: dyld then fails to load inside the sandbox.
 */
const linkedRuntimeFilesByExecutables = new Map<string, Promise<string[]>>();

function linkedRuntimeFilesForExecutables(executables: readonly CccSealedExecutable[]): Promise<string[]> {
  const key = executables.map((entry) => `${entry.path}\u0000${entry.sha256}`).join("\u0001");
  let files = linkedRuntimeFilesByExecutables.get(key);
  if (!files) {
    files = cccDarwinLinkedRuntimeFiles(executables.map((entry) => entry.path));
    files.catch(() => linkedRuntimeFilesByExecutables.delete(key));
    linkedRuntimeFilesByExecutables.set(key, files);
  }
  return files;
}

function linkedRuntimeFilesFor(toolchain: CccSealedToolchain): Promise<string[]> {
  return linkedRuntimeFilesForExecutables(toolchainExecutables(toolchain));
}

function toolchainsDir(scratchRoot: string): string {
  return join(scratchRoot, TOOLCHAINS_DIR_NAME);
}

/** E2-24: every instance clone under the scratch root stays read-only to every confined command. */
function toolchainsWriteDeny(scratchRoot: string): string {
  return `(deny file-write* ${cccSbplSubpath(toolchainsDir(scratchRoot))})`;
}

/** Placeholder clone directory for a profile rendered without an operations instance. */
function placeholderCloneDir(scratchRoot: string): string {
  return join(toolchainsDir(scratchRoot), "instance");
}

type WriterProfileAssembly = Readonly<{
  linkedRuntimeFiles: readonly string[];
  gitExecPath: string;
  canonical: CanonicalShellInput;
  cloneDir: string;
  /** The host-existence filter for read roots and files; the template material passes one that admits every path. */
  exists: (path: string) => boolean;
}>;

/**
 * The writer profile from its inputs, with no I/O beyond `exists`. Every
 * operations instance renders through this, and the template material renders
 * it for sentinel inputs (E4 X1c item 7), so any change to an input list or a
 * rule here changes the template digest.
 */
function assembleWriterProfile(i: WriterProfileAssembly): string {
  const canonical = i.canonical;
  const readRoots = cccUniqueSortedPaths([
    ...SYSTEM_RUNTIME_READ_ROOTS.filter((path) => i.exists(path)),
    ...i.linkedRuntimeFiles.map((path) => dirname(path)),
    i.gitExecPath,
    canonical.worktreeRoot,
    ...canonical.gitDirs,
    canonical.scratchRoot,
  ]);
  const readFiles = cccUniqueSortedPaths([...DEVICE_READ_FILES, ...i.linkedRuntimeFiles].filter((path) => i.exists(path)));
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
  // Every clone lies inside the writable scratch root; this later deny makes them all read-only (P9 order).
  deny.push(toolchainsWriteDeny(canonical.scratchRoot));
  return renderWriterProfile({
    EXEC: cccSbplSubpath(i.cloneDir),
    LOOPBACK: canonical.loopbackPort !== undefined ? cccSbplLoopbackPortRules(canonical.loopbackPort).join("\n") : "",
    METADATA: metadata.map(cccSbplLiteral).join(" "),
    READ: [
      ...readRoots.map((root) => `(allow file-read* ${cccSbplSubpath(root)})`),
      `(allow file-read* ${readFiles.map(cccSbplLiteral).join(" ")})`,
    ].join("\n"),
    WRITE: `(allow file-write* ${[...writeRoots.map(cccSbplSubpath), cccSbplLiteral("/dev/null")].join(" ")})`,
    DENY: deny.join("\n"),
  });
}

async function writerProfile(
  input: CccConfinedShellInput,
  canonical: CanonicalShellInput,
  cloneDir: string,
): Promise<Readonly<{ profile: string; profileSha256: string }>> {
  const profile = assembleWriterProfile({
    linkedRuntimeFiles: await linkedRuntimeFilesFor(input.toolchain),
    gitExecPath: input.toolchain.git.execPath,
    canonical,
    cloneDir,
    exists: existsSync,
  });
  return { profile, profileSha256: createHash("sha256").update(profile).digest("hex") };
}

/**
 * The profile for `input`, rendered with a placeholder per-instance clone
 * directory (`<scratch>/toolchains/instance`); each operations instance renders
 * the same rules with its own `<scratch>/toolchains/<instanceId>`.
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

function sealedEnvironment(i: SealedEnvironmentInput): Record<string, string> {
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
 * E4 X1c item 7: the whole writer-profile assembly rendered for sentinel
 * inputs, one of each kind (a linked library, a git exec path, a git dir, a
 * write root, a denied root, a caller denied name and the loopback port), with
 * every system read root and device file admitted, so the rendering does not
 * depend on the host.
 */
const TEMPLATE_SENTINEL_PROFILE = assembleWriterProfile({
  linkedRuntimeFiles: ["/ccc-sentinel/runtime/lib/libsentinel.dylib"],
  gitExecPath: "/ccc-sentinel/git/libexec/git-core",
  canonical: {
    worktreeRoot: "/ccc-sentinel/worktree",
    gitDirs: ["/ccc-sentinel/gitdir"],
    writeRoots: ["/ccc-sentinel/worktree/src"],
    deniedRoots: ["/ccc-sentinel/denied"],
    deniedNames: [...cccConfinedEffectiveDeniedNames(["sample*.name"])],
    scratchRoot: "/ccc-sentinel/scratch",
    loopbackPort: TEMPLATE_SENTINEL_PORT,
  },
  cloneDir: "/ccc-sentinel/scratch/toolchains/sentinel",
  exists: () => true,
});

/**
 * Everything that decides what the sandbox admits apart from the per-run paths:
 * the profile template, the bash wrapper, the reaper, the denied-name pattern,
 * the `.git` segment rule, the toolchains write deny, the sealed environment,
 * the loopback rule, the controller sweep, and (E4 X1c item 7) the system
 * runtime read roots, the device read files and the whole profile assembly
 * rendered for sentinel inputs. The functions are rendered for sentinel inputs,
 * so a change to any of their outputs changes the digest a qualification
 * receipt binds and every earlier qualification becomes stale
 * (`qualification-missing`, E1-20).
 */
export const CCC_WRITER_SHELL_PROFILE_TEMPLATE_MATERIAL: readonly string[] = Object.freeze([
  PROFILE_ID,
  PROFILE_TEMPLATE,
  WRAPPER_SOURCE,
  REAPER_SOURCE,
  `denied-names ${[...CCC_CONFINED_DEFAULT_DENIED_NAMES, "sample*.name"].map(deniedNamePattern).join(" ")}`,
  `git-segment ${GIT_SEGMENT_WRITE_DENY}`,
  `toolchains-write-deny ${toolchainsWriteDeny("/ccc-sentinel/scratch")}`,
  `sealed-env ${JSON.stringify(sealedEnvironment({
    binDir: "/ccc-sentinel/scratch/toolchains/sentinel/bin",
    scratchRoot: "/ccc-sentinel/scratch",
    worktreeRoot: "/ccc-sentinel/worktree",
    taskEnv: {},
  }))} shell-added ${SHELL_ADDED_ENV_KEYS.join(",")}`,
  `loopback ${cccSbplLoopbackPortRules(TEMPLATE_SENTINEL_PORT).join("\n")}`,
  `controller-sweep ${LSOF_EXECUTABLE} ${JSON.stringify(lsofSweepArgs("<uid>"))} txt by clone inode; stop, rescan, kill, two empty scans; at most ${CONTROLLER_SWEEP_MAX_SCANS} scans; killed lists only pids a scan saw`,
  `system-runtime-read-roots ${JSON.stringify(SYSTEM_RUNTIME_READ_ROOTS)}`,
  `device-read-files ${JSON.stringify(DEVICE_READ_FILES)}`,
  `writer-profile-sentinel ${TEMPLATE_SENTINEL_PROFILE}`,
  // E6-X item 7: the libraries the discovery finds become read roots, so its rules (otool's load commands, the
  // @rpath, @loader_path and @executable_path resolution, the Homebrew recursion) and the shell's own steps from the
  // sealed executables to a read root are material: a rule change that widens a read root changes the digest.
  `dylib-closure-rules ${[
    cccDarwinLinkedRuntimeFiles,
    cccResolveLinkedPath,
    cccSealedToolchainRoot,
    cccExecutableInstallRoot,
    cccIsHomebrewRuntimePath,
    toolchainExecutables,
    linkedRuntimeFilesForExecutables,
    linkedRuntimeFilesFor,
    writerProfile,
    assembleWriterProfile,
  ].map((rule) => String(rule)).join("\n")}`,
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
 * E2-24 and E2-25: clones each sealed executable to
 * `<scratch>/toolchains/<instanceId>/bin/<PATH name>` (APFS clonefile, a full
 * copy across volumes), and (E4 X1c item 4) exactly the sealed libraries, each
 * to the `clonePath` the seal recorded (Homebrew node's
 * `@loader_path/../lib/libnode` becomes `<instance>/lib/libnode`). Every copied
 * file, executable or library, must hash to its sealed sha256 before the first
 * exec, and every one is re-checked before each later exec.
 */
async function cloneToolchain(toolchain: CccSealedToolchain, instanceDir: string): Promise<ToolchainClone> {
  const toolchains = dirname(instanceDir);
  await mkdir(toolchains, { recursive: true });
  const toolchainsStat = lstatSync(toolchains);
  if (toolchainsStat.isSymbolicLink() || !toolchainsStat.isDirectory() || realpathSync(toolchains) !== toolchains) {
    refuse("root-overlap", `the toolchains directory is not a real directory: ${toolchains}`);
  }
  await mkdir(instanceDir);
  const binDir = join(instanceDir, "bin");
  await mkdir(binDir);
  const sources = new Map<string, string>();
  const copied: { target: string; source: string; sha256: string }[] = [];
  const place = async (source: string, target: string, sha256: string): Promise<void> => {
    if (target === instanceDir || !cccIsSameOrWithin(target, instanceDir)) {
      refuse("toolchain-digest-drift", `${source} would be cloned outside the instance directory (${target})`);
    }
    const existing = sources.get(target);
    if (existing === source) return;
    if (existing !== undefined) refuse("toolchain-digest-drift", `${existing} and ${source} would both be cloned to ${target}`);
    sources.set(target, source);
    copied.push({ target, source, sha256 });
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target, fsConstants.COPYFILE_FICLONE);
    await chmod(target, 0o555);
  };
  for (const [name, executable] of toolchainPathNames(toolchain)) await place(executable.path, join(binDir, name), executable.sha256);
  for (const library of toolchain.libraries) await place(library.path, join(instanceDir, library.clonePath), library.sha256);
  const identities: FileIdentity[] = [];
  for (const { target, source, sha256 } of copied) {
    if (fileSha256(target) !== sha256) {
      refuse("toolchain-digest-drift", `the per-instance clone ${target} of ${source} does not carry the sealed bytes`);
    }
    identities.push(fileIdentity(target, sha256));
  }
  const inodes = new Set<string>();
  for (const target of sources.keys()) {
    const stat = statSync(target, { bigint: true });
    inodes.add(`${stat.dev.toString()}:${stat.ino.toString()}`);
  }
  return { dir: instanceDir, binDir, node: join(binDir, "node"), bash: join(binDir, "bash"), identities, inodes };
}

/** The reaper's report: `stopped` is every pid its signal-0 sweep stopped (it may include a foreign zombie, P7). */
type ReaperRecord = Readonly<{ passes: number; stopped: readonly number[]; persistent: readonly number[] }>;

type ClosureFrame = Readonly<{
  sandboxed: boolean;
  converged: boolean;
  outputCapped: boolean;
  exit: Readonly<{ code: number | null; signal: string | null }> | null;
  record: ReaperRecord;
}>;

function isPidList(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((pid) => Number.isSafeInteger(pid) && pid > 1);
}

/**
 * fd 3 carries at most one started frame, at most one exited frame and exactly
 * one closure frame, in that order, and nothing else; any other shape is
 * unconfirmed.
 */
function parseClosureFrame(text: string): ClosureFrame | null {
  if (!text.endsWith("\n")) return null;
  const lines = text.slice(0, -1).split("\n");
  let index = 0;
  if (lines[index]?.startsWith(STARTED_FRAME_PREFIX)) index += 1;
  if (lines[index]?.startsWith(EXITED_FRAME_PREFIX)) index += 1;
  const closureLine = lines[index] ?? "";
  if (index !== lines.length - 1 || !closureLine.startsWith(CLOSURE_FRAME_PREFIX)) {
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
    frame.v !== 2
    || typeof frame.sandboxed !== "boolean"
    || typeof frame.converged !== "boolean"
    || typeof frame.outputCapped !== "boolean"
    || record === null || typeof record !== "object"
    || !Number.isSafeInteger(record.passes) || (record.passes as number) < 0
    || !isPidList(record.stopped) || !isPidList(record.persistent)
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
    record: { passes: record.passes as number, stopped: record.stopped, persistent: record.persistent },
  };
}

/**
 * E2-22: the sweep's lsof must be an absolute executable file, checked when an
 * instance is created; without it no closure could ever be confirmed.
 */
function assertSweepExecutable(lsofPath: string): void {
  let usable = false;
  try {
    usable = typeof lsofPath === "string" && isAbsolute(lsofPath) && statSync(lsofPath).isFile();
    if (usable) accessSync(lsofPath, fsConstants.X_OK);
  } catch {
    usable = false;
  }
  if (!usable) {
    refuse("closure-sweep-unavailable", `the controller sweep needs ${String(lsofPath)} as an absolute executable file, so no closure could be confirmed`);
  }
}

const LSOF_FIELD_VALUE: Readonly<Record<string, RegExp>> = {
  p: /^[1-9][0-9]*$/u,
  f: /^\S+$/u,
  D: /^0x[0-9a-f]+$/iu,
  i: /^[0-9]+$/u,
};

/**
 * E6-X item 5: `-b` makes lsof skip the stat(2), lstat(2) and readlink(2) of
 * every mount point it otherwise makes before listing anything; it takes their
 * device numbers from the mount table instead. Without it, each scan stats the
 * smbfs Time Machine mount on this host, and when that server is unreachable
 * the stat most likely blocks past the scan's 11 s lifetime (the X1b
 * adversary's stall). The txt files' device and inode come from the process
 * table either way, so a scan still parses, lists the controller and matches
 * clone inodes (measured, and pinned by a test). Apple's lsof 4.91 has no `-e`
 * to exempt one mount.
 */
function lsofSweepArgs(uid: string): string[] {
  return ["-b", "-n", "-P", "-w", "-a", "-u", uid, "-d", "txt", "-F", "pDi"];
}

/**
 * Outside the sandbox: every same-uid pid whose lsof txt mapping is one of the
 * clone's inodes, from the absolute lsof spawned through the supervised async
 * capture. Any line that is not one of the requested fields, a failed or
 * signalled spawn, or a scan that does not list the controller itself is
 * untrusted (E2-22): it throws, so the closure stays unconfirmed.
 */
async function scanCloneProcesses(clone: ToolchainClone, lsofPath: string): Promise<number[]> {
  const uid = typeof process.getuid === "function" ? process.getuid() : -1;
  const scan = await captureSupervised(lsofPath, lsofSweepArgs(String(uid)), { label: "ccc-confined-shell-sweep" });
  if (scan.timedOut || scan.overLimit || scan.spawnError !== null || scan.signal !== null) {
    throw new Error(`lsof scan failed (${scan.spawnError ?? (scan.timedOut ? "timed out" : scan.overLimit ? "output over limit" : `signal ${String(scan.signal)}`)})`);
  }
  const found = new Set<number>();
  let sawSelf = false;
  let pid = -1;
  let dev: string | null = null;
  for (const line of scan.stdout.split("\n")) {
    if (line === "") continue;
    const field = line[0]!;
    const value = line.slice(1);
    const shape = LSOF_FIELD_VALUE[field];
    if (!shape || !shape.test(value) || (field !== "p" && pid < 0)) {
      throw new Error(`lsof printed a line that is not a requested field (exit ${String(scan.code)}), so its scan cannot be trusted`);
    }
    switch (field) {
      case "p":
        pid = Number(value);
        dev = null;
        if (pid === process.pid) sawSelf = true;
        break;
      case "f":
        dev = null;
        break;
      case "D":
        dev = BigInt(value).toString();
        break;
      default:
        if (dev !== null && clone.inodes.has(`${dev}:${value}`) && Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid) {
          found.add(pid);
        }
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
  /** Every pid any scan listed: the processes the controller confirmed ran from the clone. */
  seen: readonly number[];
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
async function sweepCloneProcesses(clone: ToolchainClone, lsofPath: string): Promise<ControllerSweep> {
  const stopped = new Set<number>();
  const killed = new Set<number>();
  let scans = 0;
  let clean = 0;
  let last: number[] = [];
  const outcome = (converged: boolean, failure: string | null): ControllerSweep => ({
    converged,
    scans,
    killed: [...killed].sort((left, right) => left - right),
    seen: [...stopped].sort((left, right) => left - right),
    remaining: converged ? [] : last,
    failure,
  });
  try {
    while (scans < CONTROLLER_SWEEP_MAX_SCANS) {
      scans += 1;
      const found = await scanCloneProcesses(clone, lsofPath);
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
    killStoppedSeen(stopped, killed);
    return outcome(false, `still finding processes after ${CONTROLLER_SWEEP_MAX_SCANS} scans`);
  } catch (error) {
    killStoppedSeen(stopped, killed);
    return outcome(false, error instanceof Error ? error.message : String(error));
  }
}

/**
 * E4 X1c item 8: a sweep that gives up never leaves behind a process it
 * stopped. Every pid in `stopped` was listed by a scan as running from the
 * clone, so it is an instance process (E2-26c) and is killed.
 */
function killStoppedSeen(stopped: ReadonlySet<number>, killed: Set<number>): void {
  for (const pid of stopped) {
    if (killed.has(pid)) continue;
    signalClonePid(pid, "SIGKILL");
    killed.add(pid);
  }
}

const PS_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
/** `ps -o pid=,uid=,stat=,lstart=` under TZ=UTC0 and LANG=C: `  123   501 T    Wed Oct 14 17:15:02 2026`. */
const PS_ORPHAN_LINE = /^\s*([0-9]+)\s+([0-9]+)\s+(\S+)\s+[A-Z][a-z]{2}\s+([A-Z][a-z]{2})\s+([0-9]{1,2})\s+([0-9]{2}):([0-9]{2}):([0-9]{2})\s+([0-9]{4})\s*$/u;

/**
 * E4 X1c item 8 and E6-X item 3: when the controller cannot confirm closure,
 * nothing the in-sandbox reaper stopped may stay stopped forever. A
 * reaper-reported pid is SIGKILLed only after the foreign-pid filter (E2-26c,
 * v3.2 F3). A pid a controller scan saw running from the clone is an instance
 * process: lsof read its executable's inode, which `exec -a` cannot spoof (and
 * every such pid is already killed by the sweep that gave up). Any other pid
 * is killed only when `ps` lists it with all of: the controller's uid, a
 * stopped state (`T`), and a start time (`lstart`, read in UTC) no earlier than
 * the second this exec started. The fourth condition of item 3, an executable
 * path inside the clone read in a way `exec -a` cannot spoof, is not available
 * without lsof on macOS: `ps -o comm` is argv[0] (`exec -a` sets it) and
 * `ps -o ucomm` is only the first 16 characters of the file name, so it is not
 * used. The foreign zombie the reaper can signal (P7, state `Z`), a pid that has
 * since gone, a pid recycled by a running process, and an older stopped
 * process are never signalled; nor is any unseen pid when `ps` is unusable.
 * Returns the pids it signalled.
 */
async function killReaperStoppedPids(
  reported: readonly number[],
  sweep: ControllerSweep,
  execStartedAtMs: number,
): Promise<number[]> {
  const alreadyKilled = new Set(sweep.killed);
  const seen = new Set(sweep.seen);
  const candidates = cccUniqueSortedNumbers(reported.filter((pid) => (
    Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid && !alreadyKilled.has(pid)
  )));
  const confirmed = candidates.filter((pid) => seen.has(pid));
  const unseen = candidates.filter((pid) => !seen.has(pid));
  if (unseen.length > 0) {
    const ps = await captureSupervised(
      PS_EXECUTABLE,
      ["-o", "pid=,uid=,stat=,lstart=", "-p", unseen.join(",")],
      { label: "ccc-confined-shell-orphans", env: { ...CAPTURE_ENV, TZ: "UTC0" } },
    );
    // ps exits 1 when a listed pid is gone; its lines for the others still count.
    if (!ps.timedOut && !ps.overLimit && ps.spawnError === null && ps.signal === null) {
      const uid = typeof process.getuid === "function" ? process.getuid() : -1;
      // lstart has one-second resolution, so the bound is the start of the second the exec started in.
      const startSecond = Math.floor(execStartedAtMs / 1_000);
      const wanted = new Set(unseen);
      for (const line of ps.stdout.split("\n")) {
        const match = PS_ORPHAN_LINE.exec(line);
        if (!match) continue;
        const pid = Number(match[1]);
        const month = PS_MONTHS.indexOf(match[4] as (typeof PS_MONTHS)[number]);
        const startedSecond = Date.UTC(Number(match[9]), month, Number(match[5]), Number(match[6]), Number(match[7]), Number(match[8])) / 1_000;
        if (
          wanted.has(pid) && Number(match[2]) === uid && match[3]!.startsWith("T")
          && month >= 0 && Number.isSafeInteger(startedSecond) && startedSecond >= startSecond
        ) {
          confirmed.push(pid);
        }
      }
    }
  }
  for (const pid of confirmed) signalClonePid(pid, "SIGKILL");
  return cccUniqueSortedNumbers(confirmed);
}

function exitCodeOf(exit: ClosureFrame["exit"]): number | null {
  if (exit === null) return null;
  if (exit.code !== null) return exit.code;
  const signalNumber = exit.signal ? osConstants.signals[exit.signal as NodeJS.Signals] : undefined;
  return typeof signalNumber === "number" ? 128 + signalNumber : null;
}

/**
 * E2-26c: `killed` lists only pids the controller confirmed as instance
 * processes (a scan saw their txt mapping in the clone): the ones it killed,
 * plus any the reaper stopped that a scan saw before they went. A pid only the
 * reaper reported, such as a foreign zombie answering signal 0 (P7), is left out.
 */
function mergedClosureRecord(frame: ClosureFrame | null, sweep: ControllerSweep): CccClosureRecord {
  const seen = new Set(sweep.seen);
  return {
    passes: (frame?.record.passes ?? 0) + sweep.scans,
    killed: cccUniqueSortedNumbers([...sweep.killed, ...(frame?.record.stopped ?? []).filter((pid) => seen.has(pid))]),
    persistent: sweep.converged ? [] : [...sweep.remaining],
  };
}

function cccUniqueSortedNumbers(values: readonly number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

const QUARANTINE_NOTE = "descendants may still be running with write access to the write roots and the scratch root and network access to the admitted loopback port; the caller must quarantine (move the write roots out of place), not only flag the worktree";

const lastClosures = new WeakMap<BashOperations, CccClosureRecord | null>();

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

function confinedOperations(
  input: CccConfinedShellInput,
  options: Readonly<{ requireQualification: boolean; testOnly?: CccConfinedShellTestOnly }>,
): CccConfinedBashOperations {
  assertBackendReady();
  if (options.requireQualification) assertQualified(input);
  assertLimits(input.limits);
  const lsofPath = options.testOnly?.lsofPath ?? LSOF_EXECUTABLE;
  assertSweepExecutable(lsofPath);
  const identities = verifyToolchain(input.toolchain);
  const canonical = canonicalShellInput(input);
  const limits = input.limits;
  const reapBudgetMs = REAP_BASE_BUDGET_MS + limits.maxReapPasses * REAP_PASS_BUDGET_MS;
  const instanceDir = join(toolchainsDir(canonical.scratchRoot), randomBytes(8).toString("hex"));
  let clone: Promise<ToolchainClone> | undefined;
  let profile: Promise<Readonly<{ profile: string; profileSha256: string }>> | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  let disposed = false;
  let disposal: Promise<CccConfinedDisposeResult> | undefined;
  /** E4-9: set once any exec on this instance ends CLOSURE_UNCONFIRMED; dispose then reports unconfirmed. */
  let closureUnconfirmed = false;

  // E1-20: one exec at a time per instance, so the last-closure record and the
  // shared scratch home and tmp are never shared by two commands.
  const serialized = <T>(task: () => Promise<T>): Promise<T> => {
    const next = queue.then(task, task);
    queue = next.catch(() => undefined);
    return next;
  };
  // A failed clone stays failed: the instance directory may be half made, and
  // only `dispose` removes it. The caller creates a new instance.
  const ensureClone = (): Promise<ToolchainClone> => {
    clone ??= cloneToolchain(input.toolchain, instanceDir);
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
    const sealed = sealedEnvironment({
      binDir: instanceClone.binDir,
      scratchRoot: canonical.scratchRoot,
      worktreeRoot: canonical.worktreeRoot,
      taskEnv: input.taskEnv,
    });
    const env: NodeJS.ProcessEnv = options.testOnly?.sealedEnvironment ? { ...options.testOnly.sealedEnvironment(sealed) } : sealed;

    // The wall limit covers the model command only. The command timer starts
    // at the reaper's started frame, so the reaper's own launch (including the
    // first-launch check macOS makes of a fresh clone, measured at 1-3 s on a
    // loaded host) is not charged to the command, and stops at its exited
    // frame, so the sweep after it is not either. The runner's own timeout,
    // counted from spawn, is a backstop that also covers the reap budget.
    const closureChunks: Buffer[] = [];
    const stop = new AbortController();
    let commandExited = false;
    let commandTimedOut = false;
    let commandTimer: NodeJS.Timeout | undefined;
    const startCommandTimer = (): void => {
      if (commandTimer !== undefined || commandExited) return;
      commandTimer = setTimeout(() => {
        if (commandExited) return;
        commandTimedOut = true;
        stop.abort();
      }, wallMs);
      commandTimer.unref?.();
    };
    const onCallerAbort = (): void => stop.abort();
    signal?.addEventListener("abort", onCallerAbort, { once: true });
    let reaperStdin: Writable | null = null;
    let forceKill: NodeJS.Timeout | undefined;
    let outcome: Awaited<ReturnType<typeof runCccDarwinSandboxedProcess>> | null = null;
    let runnerError: unknown = null;
    // E6-X item 3: no process of this exec started before this instant.
    const execStartedAtMs = Date.now();
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
            const frames = Buffer.concat(closureChunks).toString("utf8").split("\n").slice(0, -1);
            if (frames.some((line) => line.startsWith(STARTED_FRAME_PREFIX))) startCommandTimer();
            if (!commandExited && frames.some((line) => line.startsWith(EXITED_FRAME_PREFIX))) {
              commandExited = true;
              if (commandTimer !== undefined) clearTimeout(commandTimer);
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
      if (commandTimer !== undefined) clearTimeout(commandTimer);
      signal?.removeEventListener("abort", onCallerAbort);
    }

    // E1-18: the controller sweep is the closure authority on every path that
    // may have started a process, whatever the reaper managed to report.
    const sweep = await sweepCloneProcesses(instanceClone, lsofPath);
    const reported = parseClosureFrame(Buffer.concat(closureChunks).toString("utf8"));
    const frame = outcome === null ? null : reported;
    const record = mergedClosureRecord(frame, sweep);
    if (!sweep.converged) {
      // E6-X item 1: the latch is set here, before anything else can throw, so dispose reports unconfirmed
      // whatever this exec ends with.
      closureUnconfirmed = true;
      // E4 X1c item 8: no process the reaper stopped is left stopped behind an unconfirmed closure. E6-X item 1:
      // that kill is best effort and can never replace the closure error (a spawn of /bin/ps can throw
      // synchronously, for example ENOMEM, and the same pressure is a likely reason the sweep failed).
      let orphanNote: string;
      try {
        const orphansKilled = await killReaperStoppedPids(reported?.record.stopped ?? [], sweep, execStartedAtMs);
        orphanNote = `SIGKILLed ${orphansKilled.length} process(es) the reaper had stopped`;
      } catch (error) {
        orphanNote = `killing the processes the reaper had stopped failed: ${error instanceof Error ? error.message : String(error)}`;
      }
      throw new CccConfinementClosureError(
        record,
        `the controller sweep did not converge (${sweep.failure ?? "unknown"}; ${sweep.remaining.length} process(es) still running from the per-instance toolchain; ${orphanNote}); ${QUARANTINE_NOTE}`,
      );
    }
    if (runnerError !== null || outcome === null) throw runnerError ?? new Error("confined-shell runner produced no outcome");
    if (frame !== null && !frame.sandboxed) {
      closureUnconfirmed = true;
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

  const operations: CccConfinedBashOperations = {
    exec: (command, cwd, execOptions) => {
      if (disposed) {
        return Promise.reject(new CccConfinementRefusedError("instance-disposed", "these confined-shell operations were disposed and their toolchain clone removed"));
      }
      // E6-X item 1: execOnce sets the unconfirmed latch itself; nothing here infers it from an error class.
      return serialized(() => execOnce(command, cwd, execOptions));
    },
    // E2-24 and E4-9: after the execs already queued, sweep once more, then
    // remove exactly this instance's clone directory. The result is
    // "unconfirmed" when that sweep does not converge, when it found any
    // process running from the clone (E6-X item 2: every exec had ended, so a
    // survivor proves an earlier confirmation wrong), or when any earlier exec
    // ended CLOSURE_UNCONFIRMED. Idempotent: every call returns the first result.
    dispose: () => {
      disposed = true;
      disposal ??= serialized(async (): Promise<CccConfinedDisposeResult> => {
        const made = clone ? await clone.catch(() => undefined) : undefined;
        // No clone means no exec ever started a process from this instance.
        const finalSweep = made ? await sweepCloneProcesses(made, lsofPath) : null;
        const finalSweepClean = finalSweep === null
          || (finalSweep.converged && finalSweep.seen.length === 0 && finalSweep.killed.length === 0);
        await rm(instanceDir, { recursive: true, force: true });
        return Object.freeze({ closure: finalSweepClean && !closureUnconfirmed ? "confirmed" : "unconfirmed" });
      });
      return disposal;
    },
  };
  return operations;
}

/**
 * The confined bash operations for one writer session. Refuses, before any
 * process exists, on a non-Darwin host, a missing sandbox-exec, a qualification
 * for another profile template or OS build, a missing `/usr/sbin/lsof`
 * (`closure-sweep-unavailable`), toolchain drift, an Apple platform binary, a
 * root layout the profile cannot enforce, or a taskEnv key no allowlist may
 * admit. The per-instance toolchain clone is made on first exec under
 * `<scratch>/toolchains/<instanceId>/`; call `dispose()` to remove it.
 * `testOnly` is the documented test seam of E2-22; production never passes it.
 * E4 X1c item 5: it admits `lsofPath` only. Any other key, `sealedEnvironment`
 * included, own or inherited, throws a TypeError before any check or process,
 * so a leaky environment can reach only `qualifyCccConfinedShell`.
 */
export function createCccConfinedBashOperations(
  input: CccConfinedShellInput,
  testOnly?: CccConfinedBashOperationsTestOnly,
): CccConfinedBashOperations {
  const seam = operationsTestOnly(testOnly);
  return confinedOperations(input, { requireQualification: true, ...(seam ? { testOnly: seam } : {}) });
}

/** E4 X1c item 5: copy the factory's test seam, refusing anything but an optional string `lsofPath`. */
function operationsTestOnly(testOnly: unknown): CccConfinedBashOperationsTestOnly | undefined {
  if (testOnly === undefined) return undefined;
  if (typeof testOnly !== "object" || testOnly === null || Array.isArray(testOnly)) {
    throw new TypeError("createCccConfinedBashOperations: testOnly must be a plain object with at most an lsofPath");
  }
  const keys = new Set<PropertyKey>(Reflect.ownKeys(testOnly));
  for (const key in testOnly) keys.add(key);
  if ("sealedEnvironment" in testOnly) keys.add("sealedEnvironment");
  const extra = [...keys].filter((key) => key !== "lsofPath");
  if (extra.length > 0) {
    throw new TypeError(
      `createCccConfinedBashOperations: testOnly admits only lsofPath; refused ${extra.map((key) => String(key)).join(", ")}`,
    );
  }
  const lsofPath = (testOnly as { lsofPath?: unknown }).lsofPath;
  if (lsofPath === undefined) return {};
  if (typeof lsofPath !== "string") throw new TypeError("createCccConfinedBashOperations: testOnly.lsofPath must be a string");
  return { lsofPath };
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
 * pids are recorded outside the throwing helper, and `finally` disposes the
 * instance (one more sweep, then the clone is removed) and kills any recorded
 * pid that still runs from this scratch.
 *
 * E2-11/E2-21: `testOnly` lets a test swap the sealed-environment builder (to
 * prove env-scrubbed fails on a leak) or the sweep's lsof. Production never
 * passes it; a qualification receipt made with it proves nothing.
 */
export async function qualifyCccConfinedShell(i: Readonly<{
  toolchain: CccSealedToolchain;
  scratchRoot: string;
  testOnly?: CccConfinedShellTestOnly;
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
  let operations: CccConfinedBashOperations | undefined;
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
      deniedNames: CCC_CONFINED_DEFAULT_DENIED_NAMES,
      deniedRoots: [],
      scratchRoot: shellScratch,
      toolchain: i.toolchain,
      taskEnv: {},
      loopbackPort: admitted.port,
      limits: QUALIFICATION_LIMITS,
      qualification: { receiptSha256: "0".repeat(64), profileTemplateSha256: CCC_WRITER_SHELL_PROFILE_TEMPLATE_SHA256, osBuild: readCccConfinementOsBuild() },
    }, { requireQualification: false, ...(i.testOnly ? { testOnly: i.testOnly } : {}) });
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
      // A detached escaper: the in-sandbox reaper stops it, the controller sees it running from the clone,
      // kills it and lists it.
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
    if (operations) await operations.dispose().catch(() => undefined);
    for (const pid of new Set(escapers)) await killRecordedEscaper(pid, base);
    await Promise.all(listeners.map((listener) => new Promise<void>((resolveClose) => listener.server.close(() => resolveClose()))));
    await rm(base, { recursive: true, force: true });
  }
}
