/*
FNXC:CccConfinedShell 2026-10-14-08:30:
Card X1 (request-to-code PRD v3 §8, D12, ADR C Q3). Every model-authored shell
command runs under `sandbox-exec` with the `ccc-writer-shell.v1` profile, a
sealed toolchain and environment, and a reaper that proves descendant closure.
These tests run the real sandbox, never a mock, and every denial is paired with
a positive control that runs the same command outside the sandbox (critic 8 C5),
so a denial cannot come from a broken fixture. Check (h) proves the profile is
not simply "deny all network": the one admitted loopback port connects while an
unadmitted loopback port in the same command is refused (challenge 23).

The single `skipIf(process.platform !== "darwin")` is the only skip form a
Darwin-tagged planning suite may carry (ADR D, skip policy). Refusal tests that
need another platform redefine `process.platform` instead of skipping.

FNXC:CccConfinedShell 2026-10-14-10:28:
Errata E1-18 (ADR X1-R) moves closure authority to the controller: each
operations instance runs only a private clone of the sealed toolchain, and the
controller kills every process running from that clone after each exec. macOS
kills Apple platform binaries copied off the system volume, so the sealed
toolchain is Homebrew bash (also sealed as `sh`), node, git and coreutils. The
host must have them; `FUSION_CCC_SEALED_BASH` and `FUSION_CCC_SEALED_GIT`
override the bash and git lookups. Commands use bash builtins and node where a
platform utility used to serve, because coreutils' sealed names carry their `g`
prefix. Escapers carry a per-run token so cleanup kills only processes this file
started, and their pids are recorded outside any throwing helper (E1-20).

FNXC:CccConfinedShell 2026-10-14-13:36:
Errata E2 (final repair). The env probe's ability to catch a leak is proven with
the test-only `sealedEnvironment` seam (E2-21). The sweep's lsof is absolute and
a missing, failing or garbled lsof can never confirm a closure (E2-22, through
the test-only `lsofPath` seam). One exported write predicate decides `.git`
segments and denied names for both shells (E2-23). The clone lives at
`<scratch>/toolchains/<instance>/bin`, is write-denied, and `dispose` removes it
(E2-24). Sealed utilities may carry a PATH name, so `gcat` runs as `cat`, and
platform binaries refuse with their own reason (E2-25). The closure record lists
only processes the controller saw running from the clone, so the foreign zombie
the in-sandbox reaper can signal (P7) never appears in it (E2-26c).

FNXC:CccConfinedShell 2026-10-14-15:05:
Errata E4, card X1c (the X1 residuals).
- Item 1: the layout test uses only bash builtins and node, and asserts whole
  lines (`bin-write-rc=1`) and `toolchains-mkdir-err EPERM`. The old version
  called `dirname` and `mkdir`, which are not on the sealed PATH (coreutils are
  sealed with their `g` names), and matched the substring `rc=1`, which the
  missing-utility status `rc=127` also contains, so it could never fail.
- Item 2: the timeout test's quick positive control runs with a 30 s model
  timeout; only the command that must time out keeps 1 s.
- Item 3: tests that do not test isolation, lifecycle, qualification or a
  non-default input share one operations instance (`sharedOps` on the `shared`
  fixture), so the per-instance clone, its hash and the first launch of a fresh
  clone (1 to 3 s on a loaded host) are paid once. They keep their files apart
  by name. The CPU-limit tests share one `cpuSeconds: 1` instance.
- Items 4 to 9: the sealed library coverage (a fixture toolchain copied from
  Homebrew node, whose libnode is the library), the factory's narrowed test
  seam, the dispose result, the template material, no stopped orphans, and the
  sweep trust rule. A mode-file lsof stub lets one instance switch between the
  real lsof and each untrusted answer.
*/
import { createHash, randomBytes } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { constants as fsConstants, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { appendFile, chmod, copyFile, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { acquireCccSemanticProofLoopbackPort } from "../ccc-campaign-proof-sandbox.js";
import {
  CCC_CONFINED_DEFAULT_DENIED_NAMES,
  CCC_CONFINED_SHELL_SEALED_ENV_KEYS,
  CCC_WRITER_SHELL_PROFILE_TEMPLATE_MATERIAL,
  CCC_WRITER_SHELL_PROFILE_TEMPLATE_SHA256,
  CccConfinementClosureError,
  CccConfinementRefusedError,
  buildCccWriterShellDarwinProfile,
  cccConfinedEffectiveDeniedNames,
  cccConfinedShellLastClosure,
  cccConfinedWriteRefusal,
  createCccConfinedBashOperations,
  qualifyCccConfinedShell,
  readCccConfinementOsBuild,
  sealCccToolchain,
  type CccClosureRecord,
  type CccConfinedBashOperations,
  type CccConfinedShellInput,
  type CccConfinementLimits,
  type CccSealedToolchain,
} from "../ccc-confinement/confined-shell.js";

const COREUTILS = ["cat", "ls", "env", "sleep", "mkdir", "rm"] as const;
const DENIED_NAMES = [".env", ".env.*", ".agentsecrets", "_secrets", ".npmrc"] as const;
const LIMITS: CccConfinementLimits = {
  wallMsCeiling: 600_000,
  cpuSeconds: 600,
  fileSizeBlocks: 2_097_152,
  maxOutputBytes: 1_048_576,
  maxReapPasses: 20,
};
/** Marks every process this file starts, so cleanup never signals anything else. */
const RUN_TOKEN = `cccx1${randomBytes(6).toString("hex")}`;
const BASH_ADDED_ENV_KEYS = ["PWD", "SHLVL", "_", "OLDPWD"] as const;

function firstRealPath(label: string, candidates: readonly (string | undefined)[]): string {
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return realpathSync(candidate);
  }
  throw new Error(`no ${label} found for the sealed toolchain (tried ${candidates.filter(Boolean).join(", ")})`);
}

/** A non-platform bash: macOS kills /bin/bash when it runs from the per-instance clone. */
function hostBash(): string {
  return firstRealPath("Homebrew bash", [
    process.env.FUSION_CCC_SEALED_BASH,
    "/opt/homebrew/opt/bash/bin/bash",
    "/usr/local/opt/bash/bin/bash",
  ]);
}

function hostCoreutil(name: string): string {
  return firstRealPath(`coreutils ${name}`, [
    `/opt/homebrew/opt/coreutils/libexec/gnubin/${name}`,
    `/usr/local/opt/coreutils/libexec/gnubin/${name}`,
  ]);
}

/** A real git binary, never the Homebrew SafeExec shim script or the /usr/bin xcrun shim. */
function hostGit(): string {
  const candidates = [
    process.env.FUSION_CCC_SEALED_GIT,
    "/opt/homebrew/opt/git/bin/git",
    "/usr/local/opt/git/bin/git",
    "/Library/Developer/CommandLineTools/usr/bin/git",
    "/Applications/Xcode.app/Contents/Developer/usr/bin/git",
  ];
  for (const candidate of candidates) {
    if (!candidate || !existsSync(candidate)) continue;
    const real = realpathSync(candidate);
    if (readFileSync(real).subarray(0, 2).toString("latin1") !== "#!") return real;
  }
  throw new Error("no real git binary found for the sealed toolchain");
}

function connectCommand(port: number): string {
  return `node -e 'require("net").connect(${port},"127.0.0.1")`
    + `.on("connect",function(){console.log("CONNECT-OK ${port}");this.destroy()})`
    + `.on("error",(e)=>console.log("CONNECT-ERR ${port} "+e.code))'`;
}

/** Bash builtin read, so no utility is involved: `$(< file)` fails with the open error. */
function readCommand(path: string, label: string): string {
  return `${label}_text=$(< ${JSON.stringify(path)}); echo "${label}-rc=$?"; printf '%s\\n' "$${label}_text"`;
}

/**
 * A CPU-bound loop that ends after `userMicros` of user CPU time. It checks the
 * clock only every 2^20 iterations: a loop that calls process.cpuUsage() on
 * every pass spends its time in the kernel and is not stopped by RLIMIT_CPU on
 * macOS, inside or outside the sandbox.
 */
function cpuLoop(userMicros: number): string {
  return `const t=process.cpuUsage();let i=0;for(;;){if((++i&0xfffff)===0&&process.cpuUsage(t).user>=${userMicros})break}console.log("loop-finished")`;
}
const ENV_DUMP = `node -e 'for (const [k,v] of Object.entries(process.env)) console.log(k+"="+v)'`;

function outside(command: string, cwd: string): { status: number | null; output: string } {
  const result = spawnSync("/bin/bash", ["-c", command], { cwd, env: process.env, encoding: "utf8" });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

type Listener = { server: Server; port: number; connections: () => number };

async function listen(port: number): Promise<Listener> {
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
  if (!address || typeof address === "string") throw new Error("listener has no port");
  return { server, port: address.port, connections: () => connections };
}

/** spawnSync blocks this event loop, so the accept callback can run only after it returns. */
async function settledConnections(listener: Listener, atLeast: number): Promise<number> {
  const deadline = Date.now() + 2_000;
  while (listener.connections() < atLeast && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  return listener.connections();
}

async function closeListener(listener: Listener | undefined): Promise<void> {
  if (!listener) return;
  await new Promise<void>((resolveClose) => listener.server.close(() => resolveClose()));
}

function processState(pid: number): "alive" | "zombie" | "gone" {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return "gone";
    throw error;
  }
  const ps = spawnSync("/bin/ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
  return ps.stdout.trim().startsWith("Z") ? "zombie" : ps.stdout.trim() === "" ? "gone" : "alive";
}

async function waitUntilNotAlive(pid: number, deadlineMs: number): Promise<"zombie" | "gone" | "alive"> {
  const deadline = Date.now() + deadlineMs;
  let state = processState(pid);
  while (state === "alive" && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    state = processState(pid);
  }
  return state;
}

/** SIGKILL only a live pid whose command line carries this run's token. */
function killIfOurs(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) return;
  const ps = spawnSync("/bin/ps", ["-o", "args=", "-p", String(pid)], { encoding: "utf8" });
  if (!ps.stdout.includes(RUN_TOKEN)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
}

type Settled = { exitCode: number | null; output: string; closure: CccClosureRecord | null; error: unknown };

/** Never throws: output collected before a failure stays readable, so escaper pids are never lost. */
async function settle(
  ops: BashOperations,
  command: string,
  cwd: string,
  options: { timeout?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<Settled> {
  const chunks: Buffer[] = [];
  let exitCode: number | null = null;
  let error: unknown = null;
  try {
    ({ exitCode } = await ops.exec(command, cwd, {
      onData: (data) => chunks.push(data),
      ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
      env: options.env ?? { ...process.env },
    }));
  } catch (caught) {
    error = caught;
  }
  return { exitCode, output: Buffer.concat(chunks).toString("utf8"), closure: cccConfinedShellLastClosure(ops), error };
}

async function run(
  ops: BashOperations,
  command: string,
  cwd: string,
  options: { timeout?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<Settled> {
  const result = await settle(ops, command, cwd, options);
  if (result.error) throw result.error;
  return result;
}

function withPlatform<T>(platform: NodeJS.Platform, action: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...original, value: platform });
  try {
    return action();
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}

function refusalReason(action: () => unknown): string | null {
  try {
    action();
  } catch (error) {
    if (error instanceof CccConfinementRefusedError) {
      expect(error.code).toBe("CCC_CONFINEMENT_REFUSED");
      return error.reason;
    }
    throw error;
  }
  return null;
}

function parseEnv(text: string): Map<string, string> {
  return new Map(text.split("\n").flatMap((line) => {
    const index = line.indexOf("=");
    return index > 0 ? [[line.slice(0, index), line.slice(index + 1)] as [string, string]] : [];
  }));
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return -1;
  }
}

/** The per-instance clone node the command ran, as printed by `EXEC <path>`. */
const PRINT_EXEC = `node -e 'console.log("EXEC "+process.execPath)'`;
function printedExec(output: string): string {
  return /EXEC (\S+)/u.exec(output)?.[1] ?? "";
}

/**
 * A zombie outside the sandbox: bash forks a child that exits at once, then
 * execs sleep, which never waits for it. The holder is returned for cleanup.
 */
async function holdForeignZombie(): Promise<{ holder: ChildProcess; zombie: number }> {
  const holder = spawn("/bin/bash", ["-c", `(exit 0) & echo "ZOMBIE $!"; exec /bin/sleep 60 # ${RUN_TOKEN}`], { stdio: ["ignore", "pipe", "ignore"] });
  const zombie = await new Promise<number>((resolveZombie, reject) => {
    let text = "";
    holder.stdout!.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
      const match = /ZOMBIE (\d+)/u.exec(text);
      if (match) resolveZombie(Number(match[1]));
    });
    holder.once("exit", () => reject(new Error("zombie holder exited early")));
  });
  const deadline = Date.now() + 2_000;
  while (processState(zombie) !== "zombie" && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  return { holder, zombie };
}

/** True once `process.kill(pid, 0)` throws ESRCH (the pid is gone, not stopped and not a zombie), within the deadline. */
async function esrchWithin(pid: number, deadlineMs: number): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
      throw error;
    }
    if (Date.now() >= deadline) return false;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
}

type LsofMode = "real" | "real-exit-1" | "empty-exit-1" | "omit-self";

/**
 * A stand-in for the sweep's lsof, which the controller runs outside the
 * sandbox. A mode file picks its answer per scan: "real" execs /usr/sbin/lsof,
 * "real-exit-1" runs it and then exits 1, "empty-exit-1" prints nothing and
 * exits 1, and "omit-self" prints well-formed fields for pid 1 only, so the
 * controller's own pid is missing.
 */
async function modeLsof(dir: string): Promise<{ path: string; setMode: (mode: LsofMode) => Promise<void> }> {
  const path = join(dir, `lsof-mode-${randomBytes(4).toString("hex")}`);
  const modeFile = `${path}.mode`;
  await writeFile(modeFile, "real\n");
  await writeFile(path, [
    "#!/bin/sh",
    `read -r mode < '${modeFile}'`,
    'case "$mode" in',
    "  empty-exit-1) exit 1 ;;",
    "  omit-self) printf 'p1\\nftxt\\nD0x1\\ni2\\n'; exit 0 ;;",
    '  real-exit-1) /usr/sbin/lsof "$@"; exit 1 ;;',
    '  *) exec /usr/sbin/lsof "$@" ;;',
    "esac",
    "",
  ].join("\n"), { mode: 0o755 });
  return { path, setMode: (mode) => writeFile(modeFile, `${mode}\n`) };
}

type Fixture = {
  root: string;
  worktree: string;
  outsideDir: string;
  canaryPath: string;
  canaryToken: string;
  envToken: string;
  readmeToken: string;
  input: CccConfinedShellInput;
};

describe.skipIf(process.platform !== "darwin")("CCC confined writer shell (Darwin sandbox-exec)", () => {
  const roots: string[] = [];
  const sleepers: ChildProcess[] = [];
  const escapees: number[] = [];
  let toolchain: CccSealedToolchain;
  let qualification: CccConfinedShellInput["qualification"];
  /** E4-X item 3: one fixture and one operations instance for every test that needs neither isolation nor a non-default input. */
  let shared: Fixture;
  let sharedOps: CccConfinedBashOperations;
  let admitted: Listener | undefined;
  let unadmitted: Listener | undefined;
  let cpuOneShared: { fx: Fixture; ops: CccConfinedBashOperations } | undefined;

  /** Records every escaper pid announced in output or written to a pid file, before any assertion runs. */
  function track(output: string, pidFile?: string): number[] {
    const fromFile = pidFile && existsSync(pidFile) ? readFileSync(pidFile, "utf8") : "";
    const pids = [...`${output}\n${fromFile}`.matchAll(/(?:ESCAPER|SPOOFED|LINKED|ORPHAN) (\d+)/gu)].map((match) => Number(match[1]));
    escapees.push(...pids);
    return pids;
  }

  /** The one `cpuSeconds: 1` instance the two CPU-limit tests share. */
  async function cpuOne(): Promise<{ fx: Fixture; ops: CccConfinedBashOperations }> {
    if (!cpuOneShared) {
      const fx = await fixture({ limits: { ...LIMITS, cpuSeconds: 1 } });
      cpuOneShared = { fx, ops: createCccConfinedBashOperations(fx.input) };
    }
    return cpuOneShared;
  }

  beforeAll(async () => {
    const bash = hostBash();
    toolchain = await sealCccToolchain({
      bash,
      sh: bash,
      node: process.execPath,
      git: hostGit(),
      utilities: COREUTILS.map(hostCoreutil),
    });
    qualification = {
      receiptSha256: createHash("sha256").update("x1-test-receipt").digest("hex"),
      profileTemplateSha256: CCC_WRITER_SHELL_PROFILE_TEMPLATE_SHA256,
      osBuild: readCccConfinementOsBuild(),
    };
    admitted = await listen(await acquireCccSemanticProofLoopbackPort());
    unadmitted = await listen(0);
    // The shared fixture admits the loopback port and adds one caller name, so
    // the network and caller-name tests can use the shared instance too.
    shared = await fixture({ loopbackPort: admitted.port, deniedNames: [...DENIED_NAMES, "custom.key"] });
    sharedOps = createCccConfinedBashOperations(shared.input);
  });

  afterEach(async () => {
    for (const sleeper of sleepers.splice(0)) sleeper.kill("SIGKILL");
    for (const pid of escapees.splice(0)) killIfOurs(pid);
  });

  afterAll(async () => {
    await sharedOps?.dispose();
    await cpuOneShared?.ops.dispose();
    await closeListener(admitted);
    await closeListener(unadmitted);
    await Promise.all(roots.splice(0).map(async (root) => {
      await chmod(root, 0o755).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }));
  });

  async function fixture(overrides: Partial<CccConfinedShellInput> = {}): Promise<Fixture> {
    const root = realpathSync(await mkdtemp(join(tmpdir(), "ccc-confined-shell-")));
    roots.push(root);
    const worktree = join(root, "worktree");
    const outsideDir = join(root, "outside");
    const scratchRoot = join(root, "scratch");
    await Promise.all([
      mkdir(join(worktree, "src"), { recursive: true }),
      mkdir(join(worktree, "docs"), { recursive: true }),
      mkdir(outsideDir, { recursive: true }),
      mkdir(scratchRoot, { recursive: true }),
    ]);
    const canaryToken = `outside-canary-${randomBytes(6).toString("hex")}`;
    const envToken = `env-canary-${randomBytes(6).toString("hex")}`;
    const readmeToken = `readme-token-${randomBytes(6).toString("hex")}`;
    const canaryPath = join(outsideDir, "canary.txt");
    await Promise.all([
      writeFile(canaryPath, `${canaryToken}\n`),
      writeFile(join(worktree, ".env"), `SECRET=${envToken}\n`),
      writeFile(join(worktree, "README"), `${readmeToken}\n`),
      // Escaper programs live in the worktree (readable inside); each appends to a
      // heartbeat file in the write root and carries this run's token. The pid
      // file is the optional second argument, so tests sharing a worktree keep
      // their pid lists apart.
      writeFile(join(worktree, "esc.js"), [
        'const { spawn } = require("node:child_process");',
        "const target = process.argv[2];",
        'const pidFile = process.argv[3] || "src/pids";',
        `const child = spawn(process.execPath, ["-e", "setInterval(()=>require('node:fs').appendFileSync(" + JSON.stringify(target) + ",'x'),50)/*${RUN_TOKEN}*/"], { detached: true, stdio: "ignore" });`,
        'require("node:fs").appendFileSync(pidFile, "ESCAPER " + child.pid + "\\n");',
        'console.log("ESCAPER " + child.pid);',
        "child.unref();",
      ].join("\n")),
      writeFile(join(worktree, "hb.js"), `setInterval(()=>require("node:fs").appendFileSync(process.argv[2],"y"),50)/*${RUN_TOKEN}*/\n`),
    ]);
    const input: CccConfinedShellInput = {
      profileId: "ccc-writer-shell.v1",
      worktreeRoot: worktree,
      gitDirs: [],
      writeRoots: [join(worktree, "src")],
      deniedNames: DENIED_NAMES,
      deniedRoots: [],
      scratchRoot,
      toolchain,
      taskEnv: { CCC_TASK_HINT: "task-hint-ok" },
      limits: LIMITS,
      qualification,
      ...overrides,
    };
    return { root, worktree, outsideDir, canaryPath, canaryToken, envToken, readmeToken, input };
  }

  describe("network", () => {
    // The shared fixture admits `admitted.port` (acquireCccSemanticProofLoopbackPort) and nothing else.
    it("(a) refuses a connect to an unadmitted 127.0.0.1 listener with EPERM while the same connect outside succeeds", async () => {
      const port = unadmitted!.port;
      expect(port).not.toBe(admitted!.port);
      const control = outside(connectCommand(port), shared.worktree);
      expect(control.output).toContain(`CONNECT-OK ${port}`);
      const seenByControl = await settledConnections(unadmitted!, 1);
      expect(seenByControl).toBeGreaterThanOrEqual(1);

      const confined = await run(sharedOps, connectCommand(port), shared.worktree);
      expect(confined.output).toContain(`CONNECT-ERR ${port} EPERM`);
      expect(confined.output).not.toContain("CONNECT-OK");
      expect(unadmitted!.connections()).toBe(seenByControl);
    });

    it("(h) connects to the one admitted loopback port from acquireCccSemanticProofLoopbackPort while an unadmitted port in the same command is refused", async () => {
      const before = admitted!.connections();
      const confined = await run(
        sharedOps,
        `${connectCommand(admitted!.port)}; ${connectCommand(unadmitted!.port)}`,
        shared.worktree,
      );
      expect(confined.output).toContain(`CONNECT-OK ${admitted!.port}`);
      expect(confined.output).toContain(`CONNECT-ERR ${unadmitted!.port} EPERM`);
      expect(await settledConnections(admitted!, before + 1)).toBe(before + 1);
    });
  });

  it("(b) denies reading a file outside the roots while the same read outside the sandbox prints it", async () => {
    const fx = shared;
    const command = readCommand(fx.canaryPath, "cat");
    const control = outside(command, fx.worktree);
    expect(control.output).toContain(fx.canaryToken);
    expect(control.output).toContain("cat-rc=0");

    const confined = await run(sharedOps, command, fx.worktree);
    expect(confined.output).not.toContain(fx.canaryToken);
    expect(confined.output).toContain("Operation not permitted");
    expect(confined.output).toContain("cat-rc=1");
  });

  it("(c) denies kill -0 of a same-user sibling spawned outside the sandbox while the same kill outside succeeds, and the sibling survives", async () => {
    const fx = shared;
    const sleeper = spawn("/bin/sleep", ["60"], { stdio: "ignore" });
    sleepers.push(sleeper);
    const pid = sleeper.pid!;
    const command = `kill -0 ${pid}; echo "kill-rc=$?"`;
    const control = outside(command, fx.worktree);
    expect(control.output).toContain("kill-rc=0");

    const confined = await run(sharedOps, command, fx.worktree);
    expect(confined.output).toContain("Operation not permitted");
    expect(confined.output).toContain("kill-rc=1");
    expect(confined.closure?.killed ?? []).not.toContain(pid);
    expect(processState(pid)).toBe("alive");
  });

  it("(d) drops parent credentials from the environment and passes only the sealed and task keys", async () => {
    const fx = shared;
    const omniroute = `canary-${randomBytes(6).toString("hex")}`;
    const fusion = `fusion-canary-${randomBytes(6).toString("hex")}`;
    const saved = { OMNIROUTE_API_KEY: process.env.OMNIROUTE_API_KEY, FUSION_CANARY_SECRET: process.env.FUSION_CANARY_SECRET };
    process.env.OMNIROUTE_API_KEY = omniroute;
    process.env.FUSION_CANARY_SECRET = fusion;
    // Assertions read single keys or booleans, never the whole env dump, so a
    // failing run (for example an unconfined shell) cannot print host secrets.
    try {
      const control = parseEnv(outside(ENV_DUMP, fx.worktree).output);
      expect(control.get("OMNIROUTE_API_KEY") === omniroute).toBe(true);
      expect(control.get("FUSION_CANARY_SECRET") === fusion).toBe(true);

      const confined = await run(sharedOps, ENV_DUMP, fx.worktree, { env: { ...process.env } });
      const inside = parseEnv(confined.output);
      expect(confined.output.includes(omniroute)).toBe(false);
      expect(confined.output.includes(fusion)).toBe(false);
      expect(inside.has("OMNIROUTE_API_KEY")).toBe(false);
      expect(inside.has("FUSION_CANARY_SECRET")).toBe(false);
      expect(inside.get("HOME")).toBe(join(fx.input.scratchRoot, "home"));
      expect(inside.get("TMPDIR")).toBe(join(fx.input.scratchRoot, "tmp"));
      expect(inside.get("CCC_TASK_HINT")).toBe("task-hint-ok");
      expect(inside.get("GIT_CONFIG_GLOBAL")).toBe("/dev/null");
      const admitted = new Set<string>([...CCC_CONFINED_SHELL_SEALED_ENV_KEYS, "CCC_TASK_HINT", ...BASH_ADDED_ENV_KEYS]);
      const unexpected = [...inside.keys()].filter((key) => !admitted.has(key));
      expect(unexpected.length === 0 ? "names admitted" : `${unexpected.length} unadmitted names`).toBe("names admitted");
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("(e) reaps a setsid escaper after the command returns and lists it in the closure record", async () => {
    const fx = shared;
    const command = "node esc.js src/hb-e src/pids-e";
    const control = outside(command, fx.worktree);
    const [controlPid] = track(control.output);
    expect(controlPid).toBeGreaterThan(1);
    expect(processState(controlPid!)).toBe("alive");

    const confined = await settle(sharedOps, command, fx.worktree);
    const [escaperPid] = track(confined.output);
    expect(confined.error).toBeNull();
    expect(escaperPid).toBeGreaterThan(1);
    expect(confined.closure).not.toBeNull();
    expect(confined.closure!.killed).toContain(escaperPid);
    expect(await waitUntilNotAlive(escaperPid!, 2_000)).not.toBe("alive");
  });

  it("(f) denies .env inside the worktree while README in the same directory reads", async () => {
    const fx = shared;
    const command = `${readCommand(".env", "env")}; ${readCommand("README", "readme")}`;
    const control = outside(command, fx.worktree);
    expect(control.output).toContain(fx.envToken);
    expect(control.output).toContain("env-rc=0");

    const confined = await run(sharedOps, command, fx.worktree);
    expect(confined.output).not.toContain(fx.envToken);
    expect(confined.output).toContain("env-rc=1");
    expect(confined.output).toContain(fx.readmeToken);
    expect(confined.output).toContain("readme-rc=0");
  });

  it("(g) qualifyCccConfinedShell reports all seven probes passed for this toolchain and OS build", async () => {
    const root = realpathSync(await mkdtemp(join(tmpdir(), "ccc-confined-shell-qual-")));
    roots.push(root);
    const receipt = await qualifyCccConfinedShell({ toolchain, scratchRoot: root });
    expect(receipt.schema).toBe("ccc-confinement-qualification.v1");
    expect(receipt.osBuild).toBe(readCccConfinementOsBuild());
    expect(receipt.toolchainSha256).toBe(toolchain.toolchainSha256);
    expect(receipt.profileTemplateSha256).toBe(CCC_WRITER_SHELL_PROFILE_TEMPLATE_SHA256);
    expect(receipt.probes).toEqual([
      { probe: "network-denied", passed: true },
      { probe: "loopback-port-allowed", passed: true },
      { probe: "outside-read-denied", passed: true },
      { probe: "sibling-signal-denied", passed: true },
      { probe: "denied-name-in-root", passed: true },
      { probe: "env-scrubbed", passed: true },
      { probe: "escaper-reaped", passed: true },
    ]);
  });

  it("fails env-scrubbed, and so the qualification, when a test-only sealed-environment builder spreads process.env, while the other six probes still pass", async () => {
    const root = realpathSync(await mkdtemp(join(tmpdir(), "ccc-confined-shell-qual-leak-")));
    roots.push(root);
    // E2-21: the builder runs at exec time, after the probe planted its canary in process.env.
    // FNXC:CccConfinedShell 2026-10-14-15:40: the leak keeps every parent key, the canary
    // included, except NODE_OPTIONS. The planning proof runner sets NODE_OPTIONS to
    // `--import <repo>/scripts/lib/ccc-planning-offline-network-guard.mjs`, a file the
    // sandbox cannot read, so a leaked copy stops every sandboxed node from starting and
    // fails all seven probes, not only env-scrubbed (reproduced under the runner, E4 X1c item 3).
    const receipt = await qualifyCccConfinedShell({
      toolchain,
      scratchRoot: root,
      testOnly: {
        sealedEnvironment: (sealed) => {
          const { NODE_OPTIONS: _hostNodeOptions, ...parent } = process.env as Record<string, string>;
          return { ...parent, ...sealed };
        },
      },
    });
    const passed = new Map(receipt.probes.map((entry) => [entry.probe, entry.passed]));
    expect(passed.get("env-scrubbed")).toBe(false);
    expect(receipt.probes.every((entry) => entry.passed)).toBe(false);
    // Non-vacuity: node still runs under the leaked environment, so only the leak decides env-scrubbed.
    for (const probe of ["network-denied", "loopback-port-allowed", "outside-read-denied", "sibling-signal-denied", "denied-name-in-root", "escaper-reaped"] as const) {
      expect(passed.get(probe)).toBe(true);
    }
  });

  it("writes inside a write root and scratch, and is refused in the worktree outside the write roots", async () => {
    const fx = shared;
    // The scratch write is guarded so an unconfined shell (the stub) cannot write into the host TMPDIR.
    const command = [
      `echo src > src/x.txt; echo "src-rc=$?"`,
      `echo docs > docs/x.txt; echo "docs-rc=$?"`,
      `case "$TMPDIR" in ${fx.input.scratchRoot}/*) echo tmp > "$TMPDIR/x.txt"; echo "tmp-rc=$?";; *) echo tmp-unsealed;; esac`,
      `echo up > ../x.txt; echo "up-rc=$?"`,
    ].join("; ");
    const confined = await run(sharedOps, command, fx.worktree);
    expect(confined.output).toContain("src-rc=0");
    expect(confined.output).toContain("tmp-rc=0");
    expect(confined.output).toContain("docs-rc=1");
    expect(confined.output).toContain("up-rc=1");
    expect(existsSync(join(fx.worktree, "src/x.txt"))).toBe(true);
    expect(existsSync(join(fx.worktree, "docs/x.txt"))).toBe(false);
    expect(existsSync(join(fx.root, "x.txt"))).toBe(false);
  });

  it("denies writes to any .git path segment inside a write root while a sibling file in the same root writes", async () => {
    const fx = shared;
    await mkdir(join(fx.worktree, "src", "pre", ".git"), { recursive: true });
    const command = [
      `node -e 'const fs=require("fs");for (const p of ["src/sub/.git","src/.git"]) {try{fs.mkdirSync(p,{recursive:true});console.log("mkdir-ok "+p)}catch(e){console.log("mkdir-err "+p+" "+e.code)}}'`,
      `echo "[core]" > src/pre/.git/config; echo "config-rc=$?"`,
      `echo sibling > src/pre/x.txt; echo "sibling-rc=$?"`,
    ].join("; ");
    const control = outside(`echo "[core]" > src/pre/.git/probe; echo "control-rc=$?"`, fx.worktree);
    expect(control.output).toContain("control-rc=0");

    const confined = await run(sharedOps, command, fx.worktree);
    expect(confined.output).toContain("mkdir-err src/sub/.git EPERM");
    expect(confined.output).toContain("mkdir-err src/.git EPERM");
    expect(confined.output).toContain("config-rc=1");
    expect(confined.output).toContain("sibling-rc=0");
    expect(existsSync(join(fx.worktree, "src", "pre", ".git", "config"))).toBe(false);
    expect(existsSync(join(fx.worktree, "src", "sub", ".git"))).toBe(false);
    expect(existsSync(join(fx.worktree, "src", "pre", "x.txt"))).toBe(true);
  });

  it("denies .envrc, a default name, and a caller-added name inside the sandbox, while README reads", async () => {
    // The shared fixture's caller names add custom.key to the defaults.
    const fx = shared;
    const envrcToken = `envrc-${randomBytes(6).toString("hex")}`;
    const customToken = `custom-${randomBytes(6).toString("hex")}`;
    await writeFile(join(fx.worktree, ".envrc"), `export X=${envrcToken}\n`);
    await writeFile(join(fx.worktree, "custom.key"), `${customToken}\n`);
    const command = `${readCommand(".envrc", "envrc")}; ${readCommand("custom.key", "custom")}; ${readCommand("README", "readme")}`;
    const control = outside(command, fx.worktree);
    expect(control.output).toContain(envrcToken);
    expect(control.output).toContain(customToken);

    const confined = await run(sharedOps, command, fx.worktree);
    expect(confined.output).not.toContain(envrcToken);
    expect(confined.output).toContain("envrc-rc=1");
    expect(confined.output).not.toContain(customToken);
    expect(confined.output).toContain("custom-rc=1");
    expect(confined.output).toContain(fx.readmeToken);
    expect(confined.output).toContain("readme-rc=0");
  });

  it("keeps .env unreadable when the caller passes no denied names, while README reads", async () => {
    const fx = await fixture({ deniedNames: [] });
    const command = `${readCommand(".env", "env")}; ${readCommand("README", "readme")}`;
    const ops = createCccConfinedBashOperations(fx.input);
    const confined = await run(ops, command, fx.worktree);
    expect(confined.output).not.toContain(fx.envToken);
    expect(confined.output).toContain("env-rc=1");
    expect(confined.output).toContain(fx.readmeToken);
    expect(confined.output).toContain("readme-rc=0");
  });

  it("runs the sealed git and a node child with a worker thread under the profile", async () => {
    const fx = await fixture();
    const git = toolchain.git.path;
    const init = spawnSync(git, ["init", "-q", fx.worktree], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
    expect(init.status).toBe(0);
    const gitDir = realpathSync(join(fx.worktree, ".git"));
    const ops = createCccConfinedBashOperations({ ...fx.input, gitDirs: [gitDir] });
    const confined = await run(
      ops,
      `git status --porcelain; echo "git-rc=$?"; node -e 'const {Worker}=require("worker_threads");new Worker("require(\\"worker_threads\\").parentPort.postMessage(7)",{eval:true}).on("message",(m)=>console.log("worker-"+m))'; echo "node-rc=$?"; echo nope > .git/x; echo "gitdir-write-rc=$?"`,
      fx.worktree,
    );
    expect(confined.output).toContain("git-rc=0");
    expect(confined.output).toContain("?? README");
    expect(confined.output).toContain("worker-7");
    expect(confined.output).toContain("node-rc=0");
    expect(confined.output).toContain("gitdir-write-rc=1");
    expect(existsSync(join(gitDir, "x"))).toBe(false);
  });

  it("refuses hard-linking a toolchain binary into a write root and cannot execute a copy, while a symlinked launch still runs the per-instance clone", async () => {
    const fx = shared;
    const command = [
      `node -e 'try{require("fs").linkSync(process.execPath,"src/hl-hn");console.log("hardlink-ok")}catch(e){console.log("hardlink-err "+e.code)}'`,
      `node -e 'const fs=require("fs");fs.copyFileSync(process.execPath,"src/hl-cn");fs.chmodSync("src/hl-cn",0o755);console.log("copy-ok")'`,
      `./src/hl-cn -e 'console.log("copy-ran")'; echo "copy-exec-rc=$?"`,
      // Positive control for the hard-link refusal: a file the command owns in the write root links.
      `node -e 'try{require("fs").linkSync("src/hl-cn","src/hl-cn-link");console.log("rootlink-ok")}catch(e){console.log("rootlink-err "+e.code)}'`,
      `node -e 'require("fs").symlinkSync(process.execPath,"src/hl-sn")'`,
      `./src/hl-sn -e 'console.log("SYMLINK-EXEC "+process.execPath)'; echo "symlink-exec-rc=$?"`,
    ].join("; ");
    const confined = await run(sharedOps, command, fx.worktree);
    expect(confined.output).toContain("hardlink-err EPERM");
    expect(existsSync(join(fx.worktree, "src", "hl-hn"))).toBe(false);
    expect(confined.output).toContain("copy-ok");
    expect(confined.output).not.toContain("copy-ran");
    expect(confined.output).toContain("copy-exec-rc=126");
    expect(confined.output).toContain("rootlink-ok");
    expect(existsSync(join(fx.worktree, "src", "hl-cn-link"))).toBe(true);
    expect(confined.output).toContain("symlink-exec-rc=0");
    const launched = /SYMLINK-EXEC (\S+)/u.exec(confined.output)?.[1] ?? "";
    // The symlink resolves to this instance's clone, never the shared host binary.
    expect(launched.startsWith(`${fx.input.scratchRoot}/`)).toBe(true);
    expect(launched).not.toBe(toolchain.node.path);
  });

  it("lays the per-instance clone out at <scratch>/toolchains/<instance>/bin and denies writes anywhere under toolchains from inside, while the scratch home writes", async () => {
    // E4-X item 1: bash builtins and node only (no utility the sealed PATH lacks), and whole-line assertions.
    const fx = shared;
    const command = [
      PRINT_EXEC,
      `n="$(command -v node)"; echo planted > "\${n%/*}/planted"; echo "bin-write-rc=$?"`,
      `node -e 'try{require("fs").mkdirSync(process.env.HOME+"/../toolchains/other");console.log("toolchains-mkdir-ok")}catch(e){console.log("toolchains-mkdir-err "+e.code)}'`,
      `node -e 'const p=require("path").dirname(process.execPath)+"/node";try{require("fs").writeFileSync(p,"x");console.log("node-overwrite-ok")}catch(e){console.log("node-overwrite-err "+e.code)}'`,
      `echo home > "$HOME/ok.txt"; echo "home-rc=$?"`,
    ].join("; ");
    const confined = await run(sharedOps, command, fx.worktree);
    const execPath = printedExec(confined.output);
    const toolchains = join(fx.input.scratchRoot, "toolchains");
    expect(execPath).toMatch(new RegExp(`^${toolchains.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}/[0-9a-f]{16}/bin/node$`, "u"));
    expect(confined.output).toMatch(/^bin-write-rc=1$/mu);
    expect(confined.output).toContain("toolchains-mkdir-err EPERM");
    expect(confined.output).not.toContain("toolchains-mkdir-ok");
    expect(confined.output).toMatch(/^node-overwrite-err E(?:PERM|ACCES)$/mu);
    // Positive control: the same shell writes the scratch home, beside the toolchains directory.
    expect(confined.output).toMatch(/^home-rc=0$/mu);
    expect(existsSync(join(dirname(execPath), "planted"))).toBe(false);
    expect(existsSync(join(toolchains, "other"))).toBe(false);
    expect(readFileSync(join(fx.input.scratchRoot, "home", "ok.txt"), "utf8")).toBe("home\n");
    // The node clone still runs, so the overwrite attempt changed nothing.
    expect((await run(sharedOps, PRINT_EXEC, fx.worktree)).output).toBe(`EXEC ${execPath}\n`);
  });

  it("dispose removes only its own instance clone, is idempotent, and makes a later exec refuse, while another instance on the same scratch keeps running", async () => {
    const fx = await fixture();
    const ops = createCccConfinedBashOperations(fx.input);
    const sibling = createCccConfinedBashOperations(fx.input);
    const instanceDir = dirname(dirname(printedExec((await run(ops, PRINT_EXEC, fx.worktree)).output)));
    const siblingDir = dirname(dirname(printedExec((await run(sibling, PRINT_EXEC, fx.worktree)).output)));
    expect(instanceDir).not.toBe(siblingDir);
    expect(existsSync(instanceDir)).toBe(true);

    // E4-9: with the real /usr/sbin/lsof the final sweep confirms closure, and a second dispose returns the same result.
    expect(await ops.dispose()).toEqual({ closure: "confirmed" });
    expect(await ops.dispose()).toEqual({ closure: "confirmed" });
    expect(existsSync(instanceDir)).toBe(false);
    expect(existsSync(siblingDir)).toBe(true);
    const after = await settle(ops, "echo after-dispose", fx.worktree);
    expect(after.error).toBeInstanceOf(CccConfinementRefusedError);
    expect((after.error as CccConfinementRefusedError).reason).toBe("instance-disposed");
    expect(after.output).toBe("");
    expect((await run(sibling, "echo sibling-runs", fx.worktree)).output).toBe("sibling-runs\n");
    expect(await sibling.dispose()).toEqual({ closure: "confirmed" });
    expect(existsSync(siblingDir)).toBe(false);
  });

  it("dispose reports unconfirmed when its final sweep cannot be trusted or an earlier exec ended unconfirmed, and returns that result again", async () => {
    // Final sweep: every exec confirmed, then the sweep dispose runs gets an untrusted answer.
    const finalSweep = await modeLsof(shared.root);
    const finalFails = createCccConfinedBashOperations(shared.input, { lsofPath: finalSweep.path });
    const confirmedExec = await settle(finalFails, "echo before-dispose", shared.worktree);
    expect(confirmedExec.error).toBeNull();
    expect(confirmedExec.closure).not.toBeNull();
    await finalSweep.setMode("empty-exit-1");
    expect(await finalFails.dispose()).toEqual({ closure: "unconfirmed" });
    await finalSweep.setMode("real");
    expect(await finalFails.dispose()).toEqual({ closure: "unconfirmed" });

    // Earlier exec: one exec ended CLOSURE_UNCONFIRMED; a later exec and the final sweep both work.
    const latch = await modeLsof(shared.root);
    const earlier = createCccConfinedBashOperations(shared.input, { lsofPath: latch.path });
    await latch.setMode("empty-exit-1");
    expect((await settle(earlier, "echo unconfirmed-exec", shared.worktree)).error).toBeInstanceOf(CccConfinementClosureError);
    await latch.setMode("real");
    const laterExec = await settle(earlier, "echo confirmed-exec", shared.worktree);
    expect(laterExec.error).toBeNull();
    expect(laterExec.closure).not.toBeNull();
    expect(await earlier.dispose()).toEqual({ closure: "unconfirmed" });
    expect(await earlier.dispose()).toEqual({ closure: "unconfirmed" });
  });

  it("runs a utility sealed from gcat under the name cat, while without the name only gcat is on PATH", async () => {
    const gcat = hostCoreutil("cat");
    const named = await sealCccToolchain({
      bash: toolchain.bash.path,
      sh: toolchain.sh.path,
      node: process.execPath,
      git: toolchain.git.path,
      utilities: [{ path: gcat, name: "cat" }],
    });
    expect(named.utilities).toEqual([{ path: gcat, sha256: createHash("sha256").update(readFileSync(gcat)).digest("hex"), name: "cat" }]);
    expect(named.toolchainSha256).not.toBe(toolchain.toolchainSha256);
    const command = `cat README; echo "cat-rc=$?"; command -v gcat; echo "gcat-lookup-rc=$?"`;

    const fx = await fixture({ toolchain: named });
    const confined = await run(createCccConfinedBashOperations(fx.input), command, fx.worktree);
    expect(confined.output).toContain(fx.readmeToken);
    expect(confined.output).toContain("cat-rc=0");
    expect(confined.output).toContain("gcat-lookup-rc=1");

    // Control: the unnamed seal of the same binary (the shared toolchain) appears only as gcat.
    const unnamed = await run(sharedOps, command, shared.worktree);
    expect(unnamed.output).not.toContain(shared.readmeToken);
    expect(unnamed.output).toContain("cat-rc=127");
    expect(unnamed.output).toContain("gcat-lookup-rc=0");
  });

  it("seals every library the clone copies, so a libnode that changes after sealing, in its source or in the per-instance clone, refuses as toolchain-digest-drift, while the unchanged fixture toolchain runs", async () => {
    // Fixture toolchain: a copy of Homebrew node's install root, whose node loads @rpath/libnode from ../lib.
    const fx = await fixture();
    const hostNode = realpathSync(process.execPath);
    const hostLibDir = join(dirname(dirname(hostNode)), "lib");
    const libName = (await readdir(hostLibDir)).find((name) => /^libnode\.[0-9]+\.dylib$/u.test(name));
    expect(libName).toBeDefined();
    const nodeRoot = join(fx.root, "tools", "node-root");
    await Promise.all([mkdir(join(nodeRoot, "bin"), { recursive: true }), mkdir(join(nodeRoot, "lib"), { recursive: true })]);
    const fixtureNode = join(nodeRoot, "bin", "node");
    const fixtureLib = join(nodeRoot, "lib", libName!);
    await copyFile(hostNode, fixtureNode, fsConstants.COPYFILE_FICLONE);
    await copyFile(join(hostLibDir, libName!), fixtureLib, fsConstants.COPYFILE_FICLONE);
    await chmod(fixtureLib, 0o644);
    const libSha256 = createHash("sha256").update(readFileSync(fixtureLib)).digest("hex");
    const sealed = await sealCccToolchain({
      bash: toolchain.bash.path,
      sh: toolchain.sh.path,
      node: fixtureNode,
      git: toolchain.git.path,
      utilities: [],
    });
    const input: CccConfinedShellInput = { ...fx.input, toolchain: sealed };

    // Control: the unchanged fixture toolchain runs, from a clone that carries its libnode.
    const ops = createCccConfinedBashOperations(input);
    const control = await run(ops, PRINT_EXEC, fx.worktree);
    const instanceDir = dirname(dirname(printedExec(control.output)));
    const clonedLib = join(instanceDir, "lib", libName!);
    expect(existsSync(clonedLib)).toBe(true);
    expect((await run(ops, "echo unchanged-runs", fx.worktree)).output).toBe("unchanged-runs\n");

    // RED: the per-instance clone of the library changes after the clone was hashed.
    await chmod(clonedLib, 0o644);
    await appendFile(clonedLib, "drift");
    const cloneDrift = await settle(ops, "echo after-clone-drift", fx.worktree);
    expect(cloneDrift.output).toBe("");
    expect(cloneDrift.error).toBeInstanceOf(CccConfinementRefusedError);
    expect((cloneDrift.error as CccConfinementRefusedError).reason).toBe("toolchain-digest-drift");

    // RED: the sealed source library changes after sealing.
    expect(refusalReason(() => createCccConfinedBashOperations(input))).toBeNull();
    await appendFile(fixtureLib, "drift");
    expect(refusalReason(() => createCccConfinedBashOperations(input))).toBe("toolchain-digest-drift");

    // The seal names the library with its pre-drift bytes and its place in the clone, and the digest covers it:
    // a record rewritten to the drifted bytes passes the byte check but not the toolchain digest.
    expect(sealed.libraries).toEqual([{ path: fixtureLib, sha256: libSha256, clonePath: `lib/${libName}` }]);
    const drifted = createHash("sha256").update(readFileSync(fixtureLib)).digest("hex");
    const forged: CccSealedToolchain = { ...sealed, libraries: [{ ...sealed.libraries[0]!, sha256: drifted }] };
    expect(refusalReason(() => createCccConfinedBashOperations({ ...input, toolchain: forged }))).toBe("toolchain-digest-drift");
  });

  it("keeps a foreign zombie the in-sandbox reaper can signal out of the closure record, while a real escaper in the same command is listed", async () => {
    const fx = shared;
    const { holder, zombie } = await holdForeignZombie();
    sleepers.push(holder);
    expect(processState(zombie)).toBe("zombie");
    // Positive control for P7: from inside, the foreign zombie answers signal 0, so the reaper's sweep sees it,
    // while its live parent outside the sandbox does not.
    const confined = await settle(sharedOps, `kill -0 ${zombie}; echo "zombie-rc=$?"; kill -0 ${holder.pid}; echo "holder-rc=$?"; node esc.js src/hb-z src/pids-z`, fx.worktree);
    const [escaperPid] = track(confined.output);
    expect(confined.error).toBeNull();
    expect(confined.output).toContain("zombie-rc=0");
    expect(confined.output).toContain("holder-rc=1");
    expect(escaperPid).toBeGreaterThan(1);
    expect(confined.closure!.killed).toContain(escaperPid);
    expect(confined.closure!.killed).not.toContain(zombie);
    expect(processState(zombie)).toBe("zombie");
    expect(await waitUntilNotAlive(escaperPid!, 2_000)).not.toBe("alive");
  });

  it("caps output at maxOutputBytes with a truncation marker and still confirms closure", async () => {
    const fx = await fixture({ limits: { ...LIMITS, maxOutputBytes: 4_096 } });
    const ops = createCccConfinedBashOperations(fx.input);
    const small = await run(ops, "echo small-output", fx.worktree);
    expect(small.output).toBe("small-output\n");

    // 1 MiB in 16 writes: far above the 4 KiB cap, yet bounded so an uncapped shell cannot exhaust memory.
    const flood = await run(
      ops,
      `node -e 'const b=Buffer.alloc(65536,121);let n=0;(function w(){if(n++<16)process.stdout.write(b,w)})()'`,
      fx.worktree,
    );
    expect(flood.output).toContain("\n[ccc-confined-shell: output truncated at 4096 bytes]");
    expect(flood.output.split("\n[ccc-confined-shell")[0]).toBe("y".repeat(4_096));
    expect(flood.closure).not.toBeNull();
  });

  it("reaps a command that outlives the model-requested timeout and reports the timeout", async () => {
    const fx = shared;
    const ops = sharedOps;
    // E4-X item 2: the quick positive control gets a 30 s model timeout, so host load cannot fail it;
    // only the command that must time out keeps 1 s.
    const quick = await run(ops, `node -e 'setTimeout(()=>console.log("quick-done"),10)'`, fx.worktree, { timeout: 30 });
    expect(quick.output).toContain("quick-done");

    const started = Date.now();
    await expect(run(ops, `node -e 'console.log("SLOW "+process.pid);setInterval(()=>{},1000)'`, fx.worktree, { timeout: 1 }))
      .rejects.toThrow(/^timeout:1$/u);
    expect(Date.now() - started).toBeLessThan(15_000);
    const closure = cccConfinedShellLastClosure(ops);
    expect(closure).not.toBeNull();
    expect(closure!.killed.length).toBeGreaterThan(0);
  });

  it("kills a CPU loop at the cpuSeconds rlimit while the same loop under the default limit is not killed early", async () => {
    const { fx, ops } = await cpuOne();
    // The loops count consumed CPU time, not wall time, so a starved host cannot end them early (E1-20).
    const busy = await run(ops, `node -e '${cpuLoop(4e6)}'; echo "loop-rc=$?"`, fx.worktree);
    // bash's job report echoes the command text, so match the program's own output line only.
    expect(busy.output).not.toMatch(/^loop-finished$/mu);
    expect(busy.output).toContain("loop-rc=152");
    // E2-26a: a pure user-mode loop that never ends by itself is also stopped by SIGXCPU (128 + 24),
    // well before the 20 s wall bound this exec sets.
    const pure = await run(ops, `node -e 'for(;;){}'; echo "pure-rc=$?"`, fx.worktree, { timeout: 20 });
    expect(pure.output).toContain("pure-rc=152");

    // Control: the shared instance runs under the default limits.
    const short = await run(sharedOps, `node -e '${cpuLoop(1.5e6)}'; echo "loop-rc=$?"`, shared.worktree);
    expect(short.output).toMatch(/^loop-finished$/mu);
    expect(short.output).toContain("loop-rc=0");
  });

  it("stops a loop that makes a syscall on every pass, which RLIMIT_CPU does not stop on macOS, at the wall timeout with closure confirmed", async () => {
    const { fx, ops } = await cpuOne();
    const started = Date.now();
    const result = await settle(ops, `node -e 'console.log("BURNER "+process.pid);for(;;){process.getuid()}'`, fx.worktree, { timeout: 3 });
    expect(result.error).toBeInstanceOf(Error);
    expect(String((result.error as Error).message)).toBe("timeout:3");
    expect(Date.now() - started).toBeLessThan(20_000);
    const burner = Number(/BURNER (\d+)/u.exec(result.output)?.[1]);
    expect(burner).toBeGreaterThan(1);
    expect(result.closure).not.toBeNull();
    expect(result.closure!.killed).toContain(burner);
    expect(await waitUntilNotAlive(burner, 2_000)).not.toBe("alive");
  });

  it("confirms a normal command's closure with zero survivors", async () => {
    const confined = await run(sharedOps, "echo reaper-intact", shared.worktree);
    expect(confined.output).toBe("reaper-intact\n");
    expect(confined.closure).not.toBeNull();
    expect(confined.closure!.passes).toBeGreaterThanOrEqual(2);
    expect(confined.closure!.persistent).toEqual([]);
    // The record lists only processes the controller saw running from the clone (E2-26c); none survives.
    for (const pid of confined.closure!.killed) expect(processState(pid)).not.toBe("alive");
  });

  it("reports CLOSURE_UNCONFIRMED when the sweep's lsof exits 1 or prints unparseable output, while the real lsof confirms the same command", async () => {
    const fx = shared;
    const exitOne = join(fx.root, "lsof-exit-1");
    const garbled = join(fx.root, "lsof-garbled");
    await writeFile(exitOne, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    await writeFile(garbled, `#!/bin/sh\necho "p$PPID"\necho "not an lsof field"\nexit 1\n`, { mode: 0o755 });

    const control = await settle(sharedOps, "echo sweep-real", fx.worktree);
    expect(control.error).toBeNull();
    expect(control.output).toBe("sweep-real\n");
    expect(control.closure).not.toBeNull();

    for (const lsofPath of [exitOne, garbled]) {
      const ops = createCccConfinedBashOperations(fx.input, { lsofPath });
      const result = await settle(ops, "echo sweep-stub", fx.worktree);
      expect(result.output).toBe("sweep-stub\n");
      expect(result.error).toBeInstanceOf(CccConfinementClosureError);
      expect((result.error as CccConfinementClosureError).code).toBe("CCC_CONFINEMENT_CLOSURE_UNCONFIRMED");
      expect(result.closure).toBeNull();
    }
  });

  it("trusts a sweep only when its output parses and lists the controller: exit 1 with empty output and output without the controller are unconfirmed, while parsed real output is trusted even when the stub exits 1", async () => {
    const lsof = await modeLsof(shared.root);
    const ops = createCccConfinedBashOperations(shared.input, { lsofPath: lsof.path });
    // Positive controls (E4-7): the exit status never decides, so real output followed by exit 1 still confirms.
    for (const mode of ["real", "real-exit-1"] as const) {
      await lsof.setMode(mode);
      const trusted = await settle(ops, `echo trusted-${mode}`, shared.worktree);
      expect(trusted.error).toBeNull();
      expect(trusted.output).toBe(`trusted-${mode}\n`);
      expect(trusted.closure).not.toBeNull();
    }
    for (const mode of ["empty-exit-1", "omit-self"] as const) {
      await lsof.setMode(mode);
      const untrusted = await settle(ops, `echo untrusted-${mode}`, shared.worktree);
      expect(untrusted.output).toBe(`untrusted-${mode}\n`);
      expect(untrusted.error).toBeInstanceOf(CccConfinementClosureError);
      expect(String((untrusted.error as Error).message)).toMatch(/did not list the controller/u);
      expect(untrusted.closure).toBeNull();
    }
  });

  it("SIGKILLs every process the reaper stopped when the controller cannot confirm closure, so no stopped orphan remains, while the same command under the real lsof is confirmed", async () => {
    const command = `node -e 'setInterval(()=>{},1000)/*${RUN_TOKEN}*/' & echo "ORPHAN $!"`;
    // Control: the real lsof sees the background child running from the clone, kills it and lists it.
    const control = await settle(sharedOps, command, shared.worktree);
    const [controlPid] = track(control.output);
    expect(control.error).toBeNull();
    expect(controlPid).toBeGreaterThan(1);
    expect(control.closure!.killed).toContain(controlPid);
    expect(await esrchWithin(controlPid!, 2_000)).toBe(true);

    // The sweep's lsof answers nothing: the reaper still stopped the child, and the controller must not leave it stopped.
    const lsof = await modeLsof(shared.root);
    await lsof.setMode("empty-exit-1");
    const ops = createCccConfinedBashOperations(shared.input, { lsofPath: lsof.path });
    const refused = await settle(ops, command, shared.worktree);
    const [orphan] = track(refused.output);
    expect(orphan).toBeGreaterThan(1);
    expect(refused.error).toBeInstanceOf(CccConfinementClosureError);
    expect(await esrchWithin(orphan!, 2_000)).toBe(true);
  });

  it("kills a setsid escaper, an argv[0]-spoofed escaper and a symlink-launched escaper from outside the sandbox after the command kills its reaper", async () => {
    const fx = shared;
    const ops = sharedOps;
    const heartbeats = ["hb-s1", "hb-s2", "hb-s3"].map((name) => join(fx.worktree, "src", name));
    const command = [
      "node esc.js src/hb-s1 src/pids-s",
      `(exec -a ccc-spoofed-${RUN_TOKEN} node hb.js src/hb-s2 & echo "SPOOFED $!" >> src/pids-s)`,
      `node -e 'require("fs").symlinkSync(process.execPath,"src/sp-sn")'`,
      `(./src/sp-sn hb.js src/hb-s3 & echo "LINKED $!" >> src/pids-s)`,
      // Every escaper is writing before the reaper dies.
      "while [ ! -s src/hb-s1 ] || [ ! -s src/hb-s2 ] || [ ! -s src/hb-s3 ]; do :; done",
      "kill -9 $PPID",
      "echo after-kill",
    ].join("; ");
    const confined = await settle(ops, command, fx.worktree);
    const pids = [...new Set(track(confined.output, join(fx.worktree, "src", "pids-s")))];
    expect(pids).toHaveLength(3);
    for (const heartbeat of heartbeats) expect(fileSize(heartbeat)).toBeGreaterThan(0);

    for (const pid of pids) expect(await waitUntilNotAlive(pid, 2_000)).not.toBe("alive");
    const sizes = heartbeats.map(fileSize);
    await new Promise((resolveWait) => setTimeout(resolveWait, 400));
    expect(heartbeats.map(fileSize)).toEqual(sizes);
    expect(confined.closure).not.toBeNull();
    for (const pid of pids) expect(confined.closure!.killed).toContain(pid);
    expect(confined.error).toBeInstanceOf(Error);
    expect(confined.error).not.toBeInstanceOf(CccConfinementClosureError);
    expect(String((confined.error as Error).message)).toMatch(/reaper/u);
  });

  it("kills a setsid escaper from outside the sandbox after the command freezes its reaper past a 2 s timeout", async () => {
    const fx = await fixture({ limits: { ...LIMITS, maxReapPasses: 2 } });
    const ops = createCccConfinedBashOperations(fx.input);
    const heartbeat = join(fx.worktree, "src", "hb1");
    const command = "node esc.js src/hb1; while [ ! -s src/hb1 ]; do :; done; kill -STOP $PPID; echo after-stop";
    const confined = await settle(ops, command, fx.worktree, { timeout: 2 });
    const [escaperPid] = track(confined.output, join(fx.worktree, "src", "pids"));
    expect(escaperPid).toBeGreaterThan(1);
    expect(fileSize(heartbeat)).toBeGreaterThan(0);

    expect(await waitUntilNotAlive(escaperPid!, 2_000)).not.toBe("alive");
    const size = fileSize(heartbeat);
    await new Promise((resolveWait) => setTimeout(resolveWait, 400));
    expect(fileSize(heartbeat)).toBe(size);
    expect(confined.error).toBeInstanceOf(Error);
    expect(String((confined.error as Error).message)).toBe("timeout:2");
    expect(confined.closure).not.toBeNull();
    expect(confined.closure!.killed).toContain(escaperPid);
  });

  it("serializes concurrent execs on one instance so the later command starts after the earlier one ends", async () => {
    const fx = shared;
    const ops = sharedOps;
    const first = settle(ops, `node -e 'setTimeout(()=>console.log("A-DONE "+Date.now()),700)'`, fx.worktree);
    const second = settle(ops, `node -e 'console.log("B-START "+Date.now())'`, fx.worktree);
    const [a, b] = await Promise.all([first, second]);
    expect(a.error).toBeNull();
    expect(b.error).toBeNull();
    const aDone = Number(/A-DONE (\d+)/u.exec(a.output)?.[1]);
    const bStart = Number(/B-START (\d+)/u.exec(b.output)?.[1]);
    expect(aDone).toBeGreaterThan(0);
    expect(bStart).toBeGreaterThanOrEqual(aDone);
    expect(cccConfinedShellLastClosure(ops)).toBe(b.closure);
  });

  it("emits every deny after the allows, admits loopback only for the owned port, and grants no mach, shm or system-socket", async () => {
    const fx = await fixture({ loopbackPort: 47_123, deniedRoots: [] });
    const withPort = await buildCccWriterShellDarwinProfile(fx.input);
    const withoutPort = await buildCccWriterShellDarwinProfile({ ...fx.input, loopbackPort: undefined });
    expect(withPort.profileSha256).toBe(createHash("sha256").update(withPort.profile).digest("hex"));
    expect((await buildCccWriterShellDarwinProfile(fx.input)).profileSha256).toBe(withPort.profileSha256);

    const lines = withPort.profile.split("\n");
    expect(lines).toContain("(deny default)");
    expect(lines).toContain("(deny network*)");
    expect(lines).toContain("(allow signal (target same-sandbox))");
    expect(lines).toContain('(allow network-outbound (remote tcp "localhost:47123"))');
    expect(withoutPort.profile).not.toContain("network-outbound");
    expect(withoutPort.profile).not.toContain("network-bind");
    for (const forbidden of ["(allow mach", "ipc-posix-shm", "system-socket", "(allow default)", "(allow process-exec)", "(allow file-read*)", "(allow network*)"]) {
      expect(withPort.profile).not.toContain(forbidden);
    }
    const lastAllowRead = Math.max(...lines.flatMap((line, index) => (/^\(allow file-(?:read|write)\*/u.test(line) ? [index] : [])));
    const denyIndexes = lines.flatMap((line, index) => (/^\(deny file-/u.test(line) ? [index] : []));
    expect(denyIndexes.length).toBeGreaterThan(0);
    expect(Math.min(...denyIndexes)).toBeGreaterThan(lastAllowRead);
  });

  it("binds the template digest to the denied-name pattern, the sealed environment and the loopback rule", () => {
    const material = CCC_WRITER_SHELL_PROFILE_TEMPLATE_MATERIAL;
    expect(CCC_WRITER_SHELL_PROFILE_TEMPLATE_SHA256)
      .toBe(createHash("sha256").update(material.join("\u0000")).digest("hex"));
    expect(material.some((part) => part.includes('#"/\\.env(/.*)?$"'))).toBe(true);
    expect(material.some((part) => part.includes('"GIT_CONFIG_GLOBAL":"/dev/null"'))).toBe(true);
    expect(material.some((part) => part.includes("(allow network-outbound (remote tcp \"localhost:"))).toBe(true);
    expect(material.some((part) => part.includes('(deny file-write* (subpath "/ccc-sentinel/scratch/toolchains"))'))).toBe(true);
  });

  it("binds the template digest to the system runtime read roots, the device read files and a sentinel rendering of every rule the writer-profile assembly emits", async () => {
    const material = CCC_WRITER_SHELL_PROFILE_TEMPLATE_MATERIAL;
    const part = (prefix: string): string => material.find((entry) => entry.startsWith(prefix)) ?? "";
    for (const root of ["/System/Library", "/usr/lib", "/private/var/db/dyld", "/usr/share/zoneinfo", "/private/var/db/timezone"]) {
      expect(part("system-runtime-read-roots ")).toContain(JSON.stringify(root));
    }
    for (const file of ["/dev/null", "/dev/urandom"]) expect(part("device-read-files ")).toContain(JSON.stringify(file));
    const sentinel = part("writer-profile-sentinel ");
    expect(sentinel).toContain('(allow file-read* (subpath "/usr/share/zoneinfo"))');
    expect(sentinel).toContain('(literal "/dev/urandom")');
    // Every rule family a real profile emits (the text before its first quoted path) is in the sentinel rendering,
    // so widening any input of the assembly changes the digest a qualification binds.
    const heads = (profile: string): Set<string> => new Set(profile.split("\n").filter((line) => line.length > 0).map((line) => line.split('"')[0]!));
    const real = await buildCccWriterShellDarwinProfile({ ...shared.input, gitDirs: [], deniedRoots: [shared.outsideDir] });
    const sentinelHeads = heads(sentinel.slice("writer-profile-sentinel ".length));
    const realHeads = [...heads(real.profile)];
    expect(realHeads.length).toBeGreaterThan(10);
    expect(realHeads.filter((head) => !sentinelHeads.has(head))).toEqual([]);
    expect(CCC_WRITER_SHELL_PROFILE_TEMPLATE_SHA256).toBe(createHash("sha256").update(material.join("\u0000")).digest("hex"));
  });

  describe("shared write predicate", () => {
    let root: string;
    let srcRoot: string;

    beforeAll(async () => {
      root = realpathSync(await mkdtemp(join(tmpdir(), "ccc-confined-shell-predicate-")));
      roots.push(root);
      srcRoot = join(root, "wt", "src");
      await Promise.all([mkdir(srcRoot, { recursive: true }), mkdir(join(root, "outside"), { recursive: true })]);
      await symlink(join(root, "outside"), join(srcRoot, "escape"));
    });

    it("exports the default denied names as a frozen superset of the planning list plus .envrc", () => {
      expect([...CCC_CONFINED_DEFAULT_DENIED_NAMES]).toEqual([".agentsecrets", ".env", ".env.*", ".envrc", ".npmrc", "_secrets"]);
      expect(Object.isFrozen(CCC_CONFINED_DEFAULT_DENIED_NAMES)).toBe(true);
    });

    it("unions caller names with the defaults, folding case and de-duplicating, so a caller cannot drop .env", () => {
      expect(cccConfinedEffectiveDeniedNames([])).toEqual(CCC_CONFINED_DEFAULT_DENIED_NAMES);
      expect(cccConfinedEffectiveDeniedNames([".ENV", "Custom.Key", "custom.key", ".npmrc"]))
        .toEqual([".agentsecrets", ".env", ".env.*", ".envrc", ".npmrc", "_secrets", "custom.key"]);
      expect(() => cccConfinedEffectiveDeniedNames(["a/b"])).toThrow(/single path component/u);
      expect(() => cccConfinedEffectiveDeniedNames([".."])).toThrow(/single path component/u);
    });

    it("refuses a path outside the write roots, including through .., a symlink or a relative spelling, while a path inside a root is admitted", () => {
      const refusal = (path: string) => cccConfinedWriteRefusal({ path, writeRoots: [srcRoot], deniedNames: [] });
      expect(refusal(join(srcRoot, "a.mjs"))).toBeNull();
      expect(refusal(join(srcRoot, "new-dir", "b.mjs"))).toBeNull();
      expect(refusal(join(root, "wt", "SRC", "case.mjs"))).toBeNull();
      expect(refusal(join(root, "wt", "docs", "a.md"))).toBe("outside-write-roots");
      expect(refusal(`${srcRoot}/../docs/a.md`)).toBe("outside-write-roots");
      expect(refusal(join(srcRoot, "escape", "a.txt"))).toBe("outside-write-roots");
      expect(refusal("src/a.mjs")).toBe("outside-write-roots");
      expect(cccConfinedWriteRefusal({ path: join(srcRoot, "a.mjs"), writeRoots: [], deniedNames: [] })).toBe("outside-write-roots");
    });

    it("refuses a .git segment in any case, while a sibling ordinary file is admitted", () => {
      const refusal = (path: string) => cccConfinedWriteRefusal({ path, writeRoots: [srcRoot], deniedNames: [] });
      expect(refusal(join(srcRoot, "sub", ".git", "config"))).toBe("git-segment");
      expect(refusal(join(srcRoot, ".git"))).toBe("git-segment");
      expect(refusal(join(srcRoot, "sub", ".GIT", "hooks", "post-checkout"))).toBe("git-segment");
      expect(refusal(join(srcRoot, "sub", "config"))).toBeNull();
      expect(refusal(join(srcRoot, ".gitignore"))).toBeNull();
      expect(refusal(join(srcRoot, "x.git"))).toBeNull();
    });

    it("refuses every effective denied name as the basename or any segment, folding case like K1, while near-miss names are admitted", () => {
      const refusal = (path: string, deniedNames: readonly string[] = []) => cccConfinedWriteRefusal({ path, writeRoots: [srcRoot], deniedNames });
      for (const denied of [".env", ".env.local", ".ENV.Production", ".envrc", ".npmrc", ".NPMRC", ".agentsecrets", "_secrets/x", "_SECRETS/deep/x", "_ſecrets/x"]) {
        expect(refusal(join(srcRoot, denied))).toBe("denied-name");
      }
      expect(refusal(join(srcRoot, "keys", "custom.key"), ["custom.key"])).toBe("denied-name");
      expect(refusal(join(srcRoot, "keys", "CUSTOM.KEY"), ["custom.key"])).toBe("denied-name");
      for (const admitted of ["env.mjs", "secrets-guide.md", ".environment", "my.env", "npmrc.txt", "_secrets_note.md"]) {
        expect(refusal(join(srcRoot, admitted))).toBeNull();
      }
      expect(refusal(join(srcRoot, "keys", "custom.key"))).toBeNull();
    });
  });

  describe("refuses before any spawn", () => {
    it("refuses a non-Darwin platform as platform-unsupported, while the same input on Darwin is admitted", async () => {
      const fx = await fixture();
      expect(refusalReason(() => createCccConfinedBashOperations(fx.input))).toBeNull();
      expect(withPlatform("linux", () => refusalReason(() => createCccConfinedBashOperations(fx.input))))
        .toBe("platform-unsupported");
    });

    it("refuses a toolchain executable whose bytes changed after sealing, while the unchanged toolchain is admitted", async () => {
      const fx = await fixture();
      const tools = join(fx.root, "tools");
      await mkdir(tools);
      const helper = join(tools, "helper");
      await writeFile(helper, "#!/bin/sh\necho helper\n", { mode: 0o755 });
      const sealed = await sealCccToolchain({
        bash: toolchain.bash.path,
        sh: toolchain.sh.path,
        node: process.execPath,
        git: toolchain.git.path,
        utilities: [...toolchain.utilities.map((utility) => utility.path), helper],
      });
      expect(refusalReason(() => createCccConfinedBashOperations({ ...fx.input, toolchain: sealed }))).toBeNull();
      await writeFile(helper, "#!/bin/sh\necho drifted\n", { mode: 0o755 });
      expect(refusalReason(() => createCccConfinedBashOperations({ ...fx.input, toolchain: sealed })))
        .toBe("toolchain-digest-drift");
    });

    it("refuses to seal an Apple platform binary, which macOS kills when it runs from a clone, while the Homebrew toolchain seals", async () => {
      const inputs = {
        bash: toolchain.bash.path,
        sh: toolchain.sh.path,
        node: process.execPath,
        git: toolchain.git.path,
        utilities: toolchain.utilities.map((utility) => utility.path),
      };
      expect((await sealCccToolchain(inputs)).toolchainSha256).toBe(toolchain.toolchainSha256);
      await expect(sealCccToolchain({ ...inputs, bash: "/bin/bash" })).rejects.toThrow(/platform binary/u);
      await expect(sealCccToolchain({ ...inputs, utilities: ["/bin/cat"] })).rejects.toThrow(/platform binary/u);
      await expect(sealCccToolchain({ ...inputs, utilities: ["/bin/cat"] })).rejects.toMatchObject({
        code: "CCC_CONFINEMENT_REFUSED",
        reason: "platform-binary-in-toolchain",
      });
    });

    it("refuses a sealed record naming an Apple platform binary as platform-binary-in-toolchain, while the Homebrew toolchain is admitted", async () => {
      const fx = await fixture();
      expect(refusalReason(() => createCccConfinedBashOperations(fx.input))).toBeNull();
      const platformCat = { path: "/bin/cat", sha256: createHash("sha256").update(readFileSync("/bin/cat")).digest("hex") };
      const forged: CccSealedToolchain = { ...toolchain, utilities: [...toolchain.utilities, platformCat] };
      expect(refusalReason(() => createCccConfinedBashOperations({ ...fx.input, toolchain: forged })))
        .toBe("platform-binary-in-toolchain");
    });

    it("refuses a duplicate effective PATH name, a role collision and a malformed name as toolchain-digest-drift, while distinct names seal", async () => {
      const inputs = {
        bash: toolchain.bash.path,
        sh: toolchain.sh.path,
        node: process.execPath,
        git: toolchain.git.path,
      };
      const gcat = hostCoreutil("cat");
      const gls = hostCoreutil("ls");
      const distinct = await sealCccToolchain({ ...inputs, utilities: [{ path: gcat, name: "cat" }, { path: gls, name: "ls" }, gcat] });
      expect(distinct.utilities.map((utility) => utility.name ?? utility.path)).toEqual(expect.arrayContaining(["cat", "ls", gcat]));
      for (const utilities of [
        [{ path: gcat, name: "ls" }, { path: gls, name: "ls" }],
        [{ path: gcat, name: "gls" }, gls],
        [{ path: gcat, name: "bash" }],
      ]) {
        await expect(sealCccToolchain({ ...inputs, utilities })).rejects.toMatchObject({ reason: "toolchain-digest-drift" });
      }
      for (const name of ["", ".", "..", "a/b", "x".repeat(65), "cat\u0000"]) {
        await expect(sealCccToolchain({ ...inputs, utilities: [{ path: gcat, name }] })).rejects.toMatchObject({ reason: "toolchain-digest-drift" });
      }
    });

    it("refuses creation as closure-sweep-unavailable when the sweep's lsof is missing, relative or not executable, while the absolute /usr/sbin/lsof is admitted", async () => {
      const fx = await fixture();
      expect(refusalReason(() => createCccConfinedBashOperations(fx.input))).toBeNull();
      const notExecutable = join(fx.root, "lsof-not-executable");
      await writeFile(notExecutable, "#!/bin/sh\nexit 0\n", { mode: 0o644 });
      for (const lsofPath of [join(fx.root, "lsof-missing"), "lsof", notExecutable, fx.root]) {
        expect(refusalReason(() => createCccConfinedBashOperations(fx.input, { lsofPath }))).toBe("closure-sweep-unavailable");
      }
      const qualificationRoot = realpathSync(await mkdtemp(join(tmpdir(), "ccc-confined-shell-qual-nolsof-")));
      roots.push(qualificationRoot);
      await expect(qualifyCccConfinedShell({ toolchain, scratchRoot: qualificationRoot, testOnly: { lsofPath: join(fx.root, "lsof-missing") } }))
        .rejects.toMatchObject({ reason: "closure-sweep-unavailable" });
    });

    it("refuses an operations testOnly key other than lsofPath, sealedEnvironment included, with a TypeError, while lsofPath alone and no testOnly are admitted", async () => {
      const fx = await fixture();
      expect(refusalReason(() => createCccConfinedBashOperations(fx.input))).toBeNull();
      expect(refusalReason(() => createCccConfinedBashOperations(fx.input, {}))).toBeNull();
      expect(refusalReason(() => createCccConfinedBashOperations(fx.input, { lsofPath: "/usr/sbin/lsof" }))).toBeNull();
      // E4-X item 5: the environment seam lives on qualifyCccConfinedShell only (E2-11).
      const leaky = { sealedEnvironment: (sealed: Readonly<Record<string, string>>) => ({ ...(process.env as Record<string, string>), ...sealed }) };
      for (const testOnly of [leaky, { lsofPath: "/usr/sbin/lsof", ...leaky }, { lsofPath: "/usr/sbin/lsof", extra: true }]) {
        expect(() => createCccConfinedBashOperations(fx.input, testOnly as never)).toThrow(TypeError);
      }
    });

    it("refuses a write root that carries a denied-name or .git segment as root-overlap, while an ordinary write root is admitted", async () => {
      const fx = await fixture();
      await Promise.all([
        mkdir(join(fx.worktree, "src", "_secrets"), { recursive: true }),
        mkdir(join(fx.worktree, "src", "pkg", ".GIT"), { recursive: true }),
        mkdir(join(fx.worktree, "src", "pkg", "lib"), { recursive: true }),
      ]);
      expect(refusalReason(() => createCccConfinedBashOperations({ ...fx.input, writeRoots: [join(fx.worktree, "src", "pkg", "lib")] })))
        .toBeNull();
      expect(refusalReason(() => createCccConfinedBashOperations({ ...fx.input, writeRoots: [join(fx.worktree, "src", "_secrets")] })))
        .toBe("root-overlap");
      expect(refusalReason(() => createCccConfinedBashOperations({ ...fx.input, writeRoots: [join(fx.worktree, "src", "pkg", ".GIT")] })))
        .toBe("root-overlap");
    });

    it("refuses a qualification for another OS build or profile template, while the live one is admitted", async () => {
      const fx = await fixture();
      expect(refusalReason(() => createCccConfinedBashOperations(fx.input))).toBeNull();
      expect(refusalReason(() => createCccConfinedBashOperations({
        ...fx.input,
        qualification: { ...qualification, osBuild: "0Z000" },
      }))).toBe("qualification-missing");
      expect(refusalReason(() => createCccConfinedBashOperations({
        ...fx.input,
        qualification: { ...qualification, profileTemplateSha256: "0".repeat(64) },
      }))).toBe("qualification-missing");
    });

    it("refuses a write root outside the worktree and a scratch root inside it, while the contained layout is admitted", async () => {
      const fx = await fixture();
      expect(refusalReason(() => createCccConfinedBashOperations(fx.input))).toBeNull();
      expect(refusalReason(() => createCccConfinedBashOperations({ ...fx.input, writeRoots: [fx.outsideDir] })))
        .toBe("root-overlap");
      const innerScratch = join(fx.worktree, "docs");
      expect(refusalReason(() => createCccConfinedBashOperations({ ...fx.input, scratchRoot: innerScratch })))
        .toBe("root-overlap");
    });

    it("refuses credential-shaped and sealed taskEnv keys, while a plain task key is admitted", async () => {
      const fx = await fixture();
      expect(refusalReason(() => createCccConfinedBashOperations({ ...fx.input, taskEnv: { CCC_TASK_HINT: "x" } }))).toBeNull();
      expect(refusalReason(() => createCccConfinedBashOperations({ ...fx.input, taskEnv: { OMNIROUTE_API_KEY: "x" } })))
        .toBe("taskenv-not-allowlisted");
      expect(refusalReason(() => createCccConfinedBashOperations({ ...fx.input, taskEnv: { PATH: "/tmp" } })))
        .toBe("taskenv-not-allowlisted");
    });
  });
});
