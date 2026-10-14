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
*/
import { createHash, randomBytes } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { acquireCccSemanticProofLoopbackPort } from "../ccc-campaign-proof-sandbox.js";
import {
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

const UTILITY_NAMES = [
  "cat", "ls", "head", "tail", "wc", "sed", "awk", "grep", "find", "diff", "mkdir", "cp", "mv",
  "rm", "touch", "sort", "uniq", "tr", "cut", "xargs", "env", "basename", "dirname",
] as const;
const DENIED_NAMES = [".env", ".env.*", ".agentsecrets", "_secrets", ".npmrc"] as const;
const LIMITS: CccConfinementLimits = {
  wallMsCeiling: 600_000,
  cpuSeconds: 600,
  fileSizeBlocks: 2_097_152,
  maxOutputBytes: 1_048_576,
  maxReapPasses: 20,
};

function hostUtility(name: string): string {
  for (const directory of ["/bin", "/usr/bin"]) {
    const candidate = join(directory, name);
    if (existsSync(candidate)) return realpathSync(candidate);
  }
  throw new Error(`host utility ${name} is missing from /bin and /usr/bin`);
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

type RunResult = { exitCode: number | null; output: string; closure: CccClosureRecord | null };

async function run(
  ops: BashOperations,
  command: string,
  cwd: string,
  options: { timeout?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<RunResult> {
  const chunks: Buffer[] = [];
  const result = await ops.exec(command, cwd, {
    onData: (data) => chunks.push(data),
    ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
    env: options.env ?? { ...process.env },
  });
  return {
    exitCode: result.exitCode,
    output: Buffer.concat(chunks).toString("utf8"),
    closure: cccConfinedShellLastClosure(ops),
  };
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

  beforeAll(async () => {
    toolchain = await sealCccToolchain({
      bash: "/bin/bash",
      sh: "/bin/sh",
      node: process.execPath,
      git: hostGit(),
      utilities: UTILITY_NAMES.map(hostUtility),
    });
    qualification = {
      receiptSha256: createHash("sha256").update("x1-test-receipt").digest("hex"),
      profileTemplateSha256: CCC_WRITER_SHELL_PROFILE_TEMPLATE_SHA256,
      osBuild: readCccConfinementOsBuild(),
    };
  });

  afterEach(async () => {
    for (const sleeper of sleepers.splice(0)) sleeper.kill("SIGKILL");
    for (const pid of escapees.splice(0)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
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
    const command = `cat ${JSON.stringify(fx.canaryPath)}; echo "cat-rc=$?"`;
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
    const parseEnv = (text: string): Map<string, string> => new Map(text.split("\n").flatMap((line) => {
      const index = line.indexOf("=");
      return index > 0 ? [[line.slice(0, index), line.slice(index + 1)] as [string, string]] : [];
    }));
    try {
      const control = parseEnv(outside("env", fx.worktree).output);
      expect(control.get("OMNIROUTE_API_KEY") === omniroute).toBe(true);
      expect(control.get("FUSION_CANARY_SECRET") === fusion).toBe(true);

      const ops = createCccConfinedBashOperations(fx.input);
      const confined = await run(ops, "env", fx.worktree, { env: { ...process.env } });
      const inside = parseEnv(confined.output);
      expect(confined.output.includes(omniroute)).toBe(false);
      expect(confined.output.includes(fusion)).toBe(false);
      expect(inside.has("OMNIROUTE_API_KEY")).toBe(false);
      expect(inside.has("FUSION_CANARY_SECRET")).toBe(false);
      expect(inside.get("HOME")).toBe(join(fx.input.scratchRoot, "home"));
      expect(inside.get("TMPDIR")).toBe(join(fx.input.scratchRoot, "tmp"));
      expect(inside.get("CCC_TASK_HINT")).toBe("task-hint-ok");
      expect(inside.get("GIT_CONFIG_GLOBAL")).toBe("/dev/null");
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("(e) reaps a setsid escaper after the command returns and lists it in the closure record", async () => {
    const fx = await fixture();
    const command = `node -e 'const c=require("child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{detached:true,stdio:"ignore"});console.log("ESCAPER "+c.pid);c.unref()'`;
    const control = outside(command, fx.worktree);
    const controlPid = Number(/ESCAPER (\d+)/u.exec(control.output)?.[1]);
    expect(controlPid).toBeGreaterThan(1);
    escapees.push(controlPid);
    expect(processState(controlPid)).toBe("alive");

    const ops = createCccConfinedBashOperations(fx.input);
    const confined = await run(ops, command, fx.worktree);
    const escaperPid = Number(/ESCAPER (\d+)/u.exec(confined.output)?.[1]);
    expect(escaperPid).toBeGreaterThan(1);
    escapees.push(escaperPid);
    expect(confined.closure).not.toBeNull();
    expect(confined.closure!.killed).toContain(escaperPid);
    expect(await waitUntilNotAlive(escaperPid, 2_000)).not.toBe("alive");
  });

  it("(f) denies .env inside the worktree while README in the same directory reads", async () => {
    const fx = await fixture();
    const command = `cat .env; echo "env-rc=$?"; cat README; echo "readme-rc=$?"`;
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
    const busy = await run(ops, `node -e 'const t=Date.now();while(Date.now()-t<4000){}console.log("loop-finished")'; echo "loop-rc=$?"`, fx.worktree);
    // bash's job report echoes the command text, so match the program's own output line only.
    expect(busy.output).not.toMatch(/^loop-finished$/mu);
    expect(busy.output).toContain("loop-rc=152");

    const control = createCccConfinedBashOperations({ ...fx.input, limits: LIMITS });
    const short = await run(control, `node -e 'const t=Date.now();while(Date.now()-t<1500){}console.log("loop-finished")'; echo "loop-rc=$?"`, fx.worktree);
    expect(short.output).toMatch(/^loop-finished$/mu);
    expect(short.output).toContain("loop-rc=0");
  });

  it("fails closed with CCC_CONFINEMENT_CLOSURE_UNCONFIRMED when the command kills its reaper", async () => {
    const fx = await fixture();
    const ops = createCccConfinedBashOperations(fx.input);
    const control = await run(ops, "echo reaper-intact", fx.worktree);
    expect(control.output).toContain("reaper-intact");
    expect(control.closure?.passes ?? 0).toBeGreaterThanOrEqual(2);
    // A raw host shell's parent is this test process; never send it the kill below.
    const parent = await run(ops, "echo PARENT=$PPID", fx.worktree);
    const parentPid = Number(/PARENT=(\d+)/u.exec(parent.output)?.[1]);
    expect(parentPid).toBeGreaterThan(1);
    expect(parentPid).not.toBe(process.pid);

    const failure = await run(ops, "kill -9 $PPID; echo after-kill", fx.worktree).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(CccConfinementClosureError);
    expect((failure as CccConfinementClosureError).code).toBe("CCC_CONFINEMENT_CLOSURE_UNCONFIRMED");
    expect((failure as CccConfinementClosureError).record).toBeNull();
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
        bash: "/bin/bash",
        sh: "/bin/sh",
        node: process.execPath,
        git: toolchain.git.path,
        utilities: [...UTILITY_NAMES.map(hostUtility), helper],
      });
      expect(refusalReason(() => createCccConfinedBashOperations({ ...fx.input, toolchain: sealed }))).toBeNull();
      await writeFile(helper, "#!/bin/sh\necho drifted\n", { mode: 0o755 });
      expect(refusalReason(() => createCccConfinedBashOperations({ ...fx.input, toolchain: sealed })))
        .toBe("toolchain-digest-drift");
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
