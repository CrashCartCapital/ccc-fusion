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
*/
import { createHash, randomBytes } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { acquireCccSemanticProofLoopbackPort } from "../ccc-campaign-proof-sandbox.js";
import {
  CCC_CONFINED_SHELL_SEALED_ENV_KEYS,
  CCC_WRITER_SHELL_PROFILE_TEMPLATE_MATERIAL,
  CCC_WRITER_SHELL_PROFILE_TEMPLATE_SHA256,
  CccConfinementClosureError,
  CccConfinementRefusedError,
  buildCccWriterShellDarwinProfile,
  cccConfinedShellLastClosure,
  createCccConfinedBashOperations,
  qualifyCccConfinedShell,
  readCccConfinementOsBuild,
  sealCccToolchain,
  type CccClosureRecord,
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

  /** Records every escaper pid announced in output or written to a pid file, before any assertion runs. */
  function track(output: string, pidFile?: string): number[] {
    const fromFile = pidFile && existsSync(pidFile) ? readFileSync(pidFile, "utf8") : "";
    const pids = [...`${output}\n${fromFile}`.matchAll(/(?:ESCAPER|SPOOFED|LINKED) (\d+)/gu)].map((match) => Number(match[1]));
    escapees.push(...pids);
    return pids;
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
  });

  afterEach(async () => {
    for (const sleeper of sleepers.splice(0)) sleeper.kill("SIGKILL");
    for (const pid of escapees.splice(0)) killIfOurs(pid);
  });

  afterAll(async () => {
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
      // heartbeat file in the write root and carries this run's token.
      writeFile(join(worktree, "esc.js"), [
        'const { spawn } = require("node:child_process");',
        "const target = process.argv[2];",
        `const child = spawn(process.execPath, ["-e", "setInterval(()=>require('node:fs').appendFileSync(" + JSON.stringify(target) + ",'x'),50)/*${RUN_TOKEN}*/"], { detached: true, stdio: "ignore" });`,
        'require("node:fs").appendFileSync("src/pids", "ESCAPER " + child.pid + "\\n");',
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
    let admitted: Listener | undefined;
    let unadmitted: Listener | undefined;
    let fx: Fixture;
    let ops: BashOperations;

    beforeAll(async () => {
      admitted = await listen(await acquireCccSemanticProofLoopbackPort());
      unadmitted = await listen(0);
      fx = await fixture({ loopbackPort: admitted.port });
      ops = createCccConfinedBashOperations(fx.input);
    });

    afterAll(async () => {
      await closeListener(admitted);
      await closeListener(unadmitted);
    });

    it("(a) refuses a connect to an unadmitted 127.0.0.1 listener with EPERM while the same connect outside succeeds", async () => {
      const port = unadmitted!.port;
      expect(port).not.toBe(admitted!.port);
      const control = outside(connectCommand(port), fx.worktree);
      expect(control.output).toContain(`CONNECT-OK ${port}`);
      const seenByControl = await settledConnections(unadmitted!, 1);
      expect(seenByControl).toBeGreaterThanOrEqual(1);

      const confined = await run(ops, connectCommand(port), fx.worktree);
      expect(confined.output).toContain(`CONNECT-ERR ${port} EPERM`);
      expect(confined.output).not.toContain("CONNECT-OK");
      expect(unadmitted!.connections()).toBe(seenByControl);
    });

    it("(h) connects to the one admitted loopback port from acquireCccSemanticProofLoopbackPort while an unadmitted port in the same command is refused", async () => {
      const before = admitted!.connections();
      const confined = await run(
        ops,
        `${connectCommand(admitted!.port)}; ${connectCommand(unadmitted!.port)}`,
        fx.worktree,
      );
      expect(confined.output).toContain(`CONNECT-OK ${admitted!.port}`);
      expect(confined.output).toContain(`CONNECT-ERR ${unadmitted!.port} EPERM`);
      expect(await settledConnections(admitted!, before + 1)).toBe(before + 1);
    });
  });

  it("(b) denies reading a file outside the roots while the same read outside the sandbox prints it", async () => {
    const fx = await fixture();
    const command = readCommand(fx.canaryPath, "cat");
    const control = outside(command, fx.worktree);
    expect(control.output).toContain(fx.canaryToken);
    expect(control.output).toContain("cat-rc=0");

    const ops = createCccConfinedBashOperations(fx.input);
    const confined = await run(ops, command, fx.worktree);
    expect(confined.output).not.toContain(fx.canaryToken);
    expect(confined.output).toContain("Operation not permitted");
    expect(confined.output).toContain("cat-rc=1");
  });

  it("(c) denies kill -0 of a same-user sibling spawned outside the sandbox while the same kill outside succeeds, and the sibling survives", async () => {
    const fx = await fixture();
    const sleeper = spawn("/bin/sleep", ["60"], { stdio: "ignore" });
    sleepers.push(sleeper);
    const pid = sleeper.pid!;
    const command = `kill -0 ${pid}; echo "kill-rc=$?"`;
    const control = outside(command, fx.worktree);
    expect(control.output).toContain("kill-rc=0");

    const ops = createCccConfinedBashOperations(fx.input);
    const confined = await run(ops, command, fx.worktree);
    expect(confined.output).toContain("Operation not permitted");
    expect(confined.output).toContain("kill-rc=1");
    expect(confined.closure?.killed ?? []).not.toContain(pid);
    expect(processState(pid)).toBe("alive");
  });

  it("(d) drops parent credentials from the environment and passes only the sealed and task keys", async () => {
    const fx = await fixture();
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

      const ops = createCccConfinedBashOperations(fx.input);
      const confined = await run(ops, ENV_DUMP, fx.worktree, { env: { ...process.env } });
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
    const fx = await fixture();
    const command = "node esc.js src/hb-e";
    const control = outside(command, fx.worktree);
    const [controlPid] = track(control.output);
    expect(controlPid).toBeGreaterThan(1);
    expect(processState(controlPid!)).toBe("alive");

    const ops = createCccConfinedBashOperations(fx.input);
    const confined = await settle(ops, command, fx.worktree);
    const [escaperPid] = track(confined.output);
    expect(confined.error).toBeNull();
    expect(escaperPid).toBeGreaterThan(1);
    expect(confined.closure).not.toBeNull();
    expect(confined.closure!.killed).toContain(escaperPid);
    expect(await waitUntilNotAlive(escaperPid!, 2_000)).not.toBe("alive");
  });

  it("(f) denies .env inside the worktree while README in the same directory reads", async () => {
    const fx = await fixture();
    const command = `${readCommand(".env", "env")}; ${readCommand("README", "readme")}`;
    const control = outside(command, fx.worktree);
    expect(control.output).toContain(fx.envToken);
    expect(control.output).toContain("env-rc=0");

    const ops = createCccConfinedBashOperations(fx.input);
    const confined = await run(ops, command, fx.worktree);
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

  it("writes inside a write root and scratch, and is refused in the worktree outside the write roots", async () => {
    const fx = await fixture();
    // The scratch write is guarded so an unconfined shell (the stub) cannot write into the host TMPDIR.
    const command = [
      `echo src > src/x.txt; echo "src-rc=$?"`,
      `echo docs > docs/x.txt; echo "docs-rc=$?"`,
      `case "$TMPDIR" in ${fx.input.scratchRoot}/*) echo tmp > "$TMPDIR/x.txt"; echo "tmp-rc=$?";; *) echo tmp-unsealed;; esac`,
      `echo up > ../x.txt; echo "up-rc=$?"`,
    ].join("; ");
    const ops = createCccConfinedBashOperations(fx.input);
    const confined = await run(ops, command, fx.worktree);
    expect(confined.output).toContain("src-rc=0");
    expect(confined.output).toContain("tmp-rc=0");
    expect(confined.output).toContain("docs-rc=1");
    expect(confined.output).toContain("up-rc=1");
    expect(existsSync(join(fx.worktree, "src/x.txt"))).toBe(true);
    expect(existsSync(join(fx.worktree, "docs/x.txt"))).toBe(false);
    expect(existsSync(join(fx.root, "x.txt"))).toBe(false);
  });

  it("denies writes to any .git path segment inside a write root while a sibling file in the same root writes", async () => {
    const fx = await fixture();
    await mkdir(join(fx.worktree, "src", "pre", ".git"), { recursive: true });
    const command = [
      `node -e 'const fs=require("fs");for (const p of ["src/sub/.git","src/.git"]) {try{fs.mkdirSync(p,{recursive:true});console.log("mkdir-ok "+p)}catch(e){console.log("mkdir-err "+p+" "+e.code)}}'`,
      `echo "[core]" > src/pre/.git/config; echo "config-rc=$?"`,
      `echo sibling > src/pre/x.txt; echo "sibling-rc=$?"`,
    ].join("; ");
    const control = outside(`echo "[core]" > src/pre/.git/probe; echo "control-rc=$?"`, fx.worktree);
    expect(control.output).toContain("control-rc=0");

    const ops = createCccConfinedBashOperations(fx.input);
    const confined = await run(ops, command, fx.worktree);
    expect(confined.output).toContain("mkdir-err src/sub/.git EPERM");
    expect(confined.output).toContain("mkdir-err src/.git EPERM");
    expect(confined.output).toContain("config-rc=1");
    expect(confined.output).toContain("sibling-rc=0");
    expect(existsSync(join(fx.worktree, "src", "pre", ".git", "config"))).toBe(false);
    expect(existsSync(join(fx.worktree, "src", "sub", ".git"))).toBe(false);
    expect(existsSync(join(fx.worktree, "src", "pre", "x.txt"))).toBe(true);
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
    const fx = await fixture();
    const ops = createCccConfinedBashOperations(fx.input);
    const command = [
      `node -e 'try{require("fs").linkSync(process.execPath,"src/hn");console.log("hardlink-ok")}catch(e){console.log("hardlink-err "+e.code)}'`,
      `node -e 'const fs=require("fs");fs.copyFileSync(process.execPath,"src/cn");fs.chmodSync("src/cn",0o755);console.log("copy-ok")'`,
      `./src/cn -e 'console.log("copy-ran")'; echo "copy-exec-rc=$?"`,
      // Positive control for the hard-link refusal: a file the command owns in the write root links.
      `node -e 'try{require("fs").linkSync("src/cn","src/cn-link");console.log("rootlink-ok")}catch(e){console.log("rootlink-err "+e.code)}'`,
      `node -e 'require("fs").symlinkSync(process.execPath,"src/sn")'`,
      `./src/sn -e 'console.log("SYMLINK-EXEC "+process.execPath)'; echo "symlink-exec-rc=$?"`,
    ].join("; ");
    const confined = await run(ops, command, fx.worktree);
    expect(confined.output).toContain("hardlink-err EPERM");
    expect(existsSync(join(fx.worktree, "src", "hn"))).toBe(false);
    expect(confined.output).toContain("copy-ok");
    expect(confined.output).not.toContain("copy-ran");
    expect(confined.output).toContain("copy-exec-rc=126");
    expect(confined.output).toContain("rootlink-ok");
    expect(existsSync(join(fx.worktree, "src", "cn-link"))).toBe(true);
    expect(confined.output).toContain("symlink-exec-rc=0");
    const launched = /SYMLINK-EXEC (\S+)/u.exec(confined.output)?.[1] ?? "";
    // The symlink resolves to this instance's clone, never the shared host binary.
    expect(launched.startsWith(`${fx.input.scratchRoot}/`)).toBe(true);
    expect(launched).not.toBe(toolchain.node.path);
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
    const fx = await fixture();
    const ops = createCccConfinedBashOperations(fx.input);
    const quick = await run(ops, `node -e 'setTimeout(()=>console.log("quick-done"),10)'`, fx.worktree, { timeout: 1 });
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
    const fx = await fixture({ limits: { ...LIMITS, cpuSeconds: 1 } });
    const ops = createCccConfinedBashOperations(fx.input);
    // The loops count consumed CPU time, not wall time, so a starved host cannot end them early (E1-20).
    const busy = await run(ops, `node -e '${cpuLoop(4e6)}'; echo "loop-rc=$?"`, fx.worktree);
    // bash's job report echoes the command text, so match the program's own output line only.
    expect(busy.output).not.toMatch(/^loop-finished$/mu);
    expect(busy.output).toContain("loop-rc=152");

    const control = createCccConfinedBashOperations({ ...fx.input, limits: LIMITS });
    const short = await run(control, `node -e '${cpuLoop(1.5e6)}'; echo "loop-rc=$?"`, fx.worktree);
    expect(short.output).toMatch(/^loop-finished$/mu);
    expect(short.output).toContain("loop-rc=0");
  });

  it("confirms a normal command's closure with zero survivors", async () => {
    const fx = await fixture();
    const ops = createCccConfinedBashOperations(fx.input);
    const confined = await run(ops, "echo reaper-intact", fx.worktree);
    expect(confined.output).toBe("reaper-intact\n");
    expect(confined.closure).not.toBeNull();
    expect(confined.closure!.passes).toBeGreaterThanOrEqual(2);
    expect(confined.closure!.persistent).toEqual([]);
    // The in-sandbox reaper can list a foreign zombie, which answers signal 0 (review probe P7);
    // what matters is that nothing it or the controller listed is still running.
    for (const pid of confined.closure!.killed) expect(processState(pid)).not.toBe("alive");
  });

  it("kills a setsid escaper, an argv[0]-spoofed escaper and a symlink-launched escaper from outside the sandbox after the command kills its reaper", async () => {
    const fx = await fixture();
    const ops = createCccConfinedBashOperations(fx.input);
    const heartbeats = ["hb1", "hb2", "hb3"].map((name) => join(fx.worktree, "src", name));
    const command = [
      "node esc.js src/hb1",
      `(exec -a ccc-spoofed-${RUN_TOKEN} node hb.js src/hb2 & echo "SPOOFED $!" >> src/pids)`,
      `node -e 'require("fs").symlinkSync(process.execPath,"src/sn")'`,
      `(./src/sn hb.js src/hb3 & echo "LINKED $!" >> src/pids)`,
      // Every escaper is writing before the reaper dies.
      "while [ ! -s src/hb1 ] || [ ! -s src/hb2 ] || [ ! -s src/hb3 ]; do :; done",
      "kill -9 $PPID",
      "echo after-kill",
    ].join("; ");
    const confined = await settle(ops, command, fx.worktree);
    const pids = [...new Set(track(confined.output, join(fx.worktree, "src", "pids")))];
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
    const fx = await fixture();
    const ops = createCccConfinedBashOperations(fx.input);
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
