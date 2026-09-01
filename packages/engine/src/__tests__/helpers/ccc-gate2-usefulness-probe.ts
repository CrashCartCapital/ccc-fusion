import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { dirname, resolve } from "node:path";

import { superviseSpawn } from "@fusion/core";

import { sbplEscape } from "../../sandbox/sandbox-exec-policy.js";
import { acquireNonReservedPort, resolveReservedPorts } from "../../mission-verification-app-harness.js";

export const GATE2_USEFULNESS_CASE_IDS = [
  "valid-event-post",
  "invalid-event-4xx",
  "sse-delivery",
  "audit-survives-restart",
  "cli-healthy",
  "cli-unavailable",
] as const;

export type Gate2UsefulnessCaseId = typeof GATE2_USEFULNESS_CASE_IDS[number];

export interface Gate2UsefulnessEvidence {
  schema: "ccc-gate2.usefulness-evidence.v1";
  installedRuntimeReceiptDigest: string;
  sourceCommit: string;
  sourceTree: string;
  detachedCheckout: {
    clean: true;
    headCommit: string;
    headTree: string;
  };
  reservedPort: number;
  cases: Array<{ caseId: Gate2UsefulnessCaseId; passed: boolean; detail?: string }>;
  process: {
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    durationMs: number;
    stdoutTail: string;
    stdoutSha256: string;
    stderrTail: string;
    stderrSha256: string;
  };
  sandboxProfileSha256: string;
  cleanup: {
    processGroupStopped: boolean;
    processGroupVerification: {
      platform: "darwin";
      method: "posix-kill-zero";
      pgid: number;
      absentAfterExit: boolean;
    };
    checkoutRemoved: boolean;
    scratchRemoved: boolean;
  };
  finalTargetStatus: "passed" | "failed";
}

export interface Gate2LoopbackSandboxProfileInput {
  checkoutRoot: string;
  scratchRoot: string;
  nodeExecutable: string;
  port: number;
  runtimeReadFiles?: readonly string[];
}

function literal(value: string): string {
  return `(literal "${sbplEscape(resolve(value))}")`;
}

function subpath(value: string): string {
  return `(subpath "${sbplEscape(resolve(value))}")`;
}

function ancestors(value: string): string[] {
  const paths: string[] = [];
  let current = resolve(value);
  while (true) {
    paths.push(current);
    const parent = dirname(current);
    if (parent === current) return paths;
    current = parent;
  }
}

function assertAllowedPort(port: number): void {
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) {
    throw new Error("Gate 2 usefulness port must be an integer from 1 through 65535");
  }
  if (port === 4_040) throw new Error("Gate 2 usefulness port 4040 is reserved");
}

export function buildGate2LoopbackSandboxProfile(input: Gate2LoopbackSandboxProfileInput): string {
  assertAllowedPort(input.port);
  const checkoutRoot = resolve(input.checkoutRoot);
  const scratchRoot = resolve(input.scratchRoot);
  const nodeExecutable = resolve(input.nodeExecutable);
  if (checkoutRoot === scratchRoot || checkoutRoot.startsWith(`${scratchRoot}/`) || scratchRoot.startsWith(`${checkoutRoot}/`)) {
    throw new Error("Gate 2 checkout and scratch roots must be disjoint");
  }
  const nodeRuntimeRoot = dirname(dirname(nodeExecutable));
  const metadataPaths = [...new Set([
    ...ancestors(checkoutRoot),
    ...ancestors(scratchRoot),
    ...ancestors(nodeExecutable),
    ...(input.runtimeReadFiles ?? []).flatMap(ancestors),
    "/System/Library",
    "/usr/lib",
    "/private/var/db/dyld",
    "/private/var/db/timezone",
  ])].sort();
  const lines = [
    "(version 1)",
    '(import "/System/Library/Sandbox/Profiles/dyld-support.sb")',
    "(deny default)",
    "(allow process-fork)",
    `(allow process-exec ${literal(nodeExecutable)})`,
    "(allow signal (target self))",
    "(allow signal (target children))",
    "(allow sysctl-read)",
    "(allow mach*)",
    "(allow ipc-posix-shm*)",
    "(allow system-socket)",
    "(deny network*)",
    `(allow network-bind (local tcp "localhost:${input.port}"))`,
    `(allow network-inbound (local tcp "localhost:${input.port}"))`,
    `(allow network-outbound (remote tcp "localhost:${input.port}"))`,
    `(allow file-read-metadata ${metadataPaths.map(literal).join(" ")})`,
    `(allow file-read* ${subpath("/System/Library")})`,
    `(allow file-read* ${subpath("/usr/lib")})`,
    `(allow file-read* ${subpath("/usr/share/zoneinfo")})`,
    `(allow file-read* ${subpath("/private/var/db/dyld")})`,
    `(allow file-read* ${subpath("/private/var/db/timezone")})`,
    `(allow file-read* ${subpath(nodeRuntimeRoot)})`,
    ...[...new Set((input.runtimeReadFiles ?? []).map((file) => dirname(file)))].sort()
      .map((root) => `(allow file-read* ${subpath(root)})`),
    `(allow file-read* ${subpath(checkoutRoot)})`,
    `(allow file-read* ${subpath(scratchRoot)})`,
    `(allow file-read* ${literal("/dev/null")})`,
    `(allow file-read* ${literal("/dev/random")})`,
    `(allow file-read* ${literal("/dev/urandom")})`,
    `(allow file-read* ${literal("/etc/localtime")})`,
    ...(input.runtimeReadFiles ?? []).map((file) => `(allow file-read* ${literal(file)})`),
    `(allow file-write* ${subpath(scratchRoot)})`,
    `(allow file-write* ${literal("/dev/null")})`,
  ];
  return `${lines.join("\n")}\n`;
}

export function buildGate2UsefulnessProbeSource(): string {
  return String.raw`import { spawn, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

const CASE_IDS = ["valid-event-post", "invalid-event-4xx", "sse-delivery", "audit-survives-restart", "cli-healthy", "cli-unavailable"];
const valueFor = (flag) => { const index = process.argv.indexOf(flag); const value = index >= 0 ? process.argv[index + 1] : undefined; if (!value) throw new Error("missing " + flag); return value; };
const checkoutRoot = valueFor("--checkout");
const scratchRoot = valueFor("--scratch");
const port = Number(valueFor("--port"));
if (!Number.isSafeInteger(port) || port <= 0 || port > 65535 || port === 4040) throw new Error("invalid probe port");
const baseUrl = "http://127.0.0.1:" + port;
const auditPath = path.join(scratchRoot, "audit.jsonl");
const fixture = JSON.parse(await readFile(path.join(checkoutRoot, "fixtures/events.json"), "utf8"));
const results = new Map(CASE_IDS.map((caseId) => [caseId, { caseId, passed: false, detail: "not reached" }]));
const pass = (caseId) => results.set(caseId, { caseId, passed: true });
let service;
let failure;

const delay = (durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs));
const within = async (promise, label, durationMs = 5000) => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + " timed out")), durationMs); })]); }
  finally { clearTimeout(timer); }
};
const forward = (stream, destination) => stream?.on("data", (chunk) => destination.write(chunk));

async function stopService() {
  const child = service;
  service = undefined;
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([new Promise((resolve) => child.once("exit", resolve)), delay(2000)]);
  if (child.exitCode === null) {
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
  }
}

async function startService() {
  const child = spawn(process.execPath, ["--experimental-strip-types", path.join(checkoutRoot, "src/app.ts"), "--port", String(port), "--audit", auditPath], {
    cwd: checkoutRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  service = child;
  forward(child.stdout, process.stdout);
  forward(child.stderr, process.stderr);
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("service exited during startup with " + child.exitCode);
    try { const response = await fetch(baseUrl + "/health"); if (response.ok) return; } catch {}
    await delay(50);
  }
  throw new Error("service did not become healthy");
}

async function readSseFrame(reader) {
  const decoder = new TextDecoder();
  let received = "";
  while (!received.includes("\n\n")) {
    const next = await reader.read();
    if (next.done) break;
    received += decoder.decode(next.value, { stream: true });
  }
  return received;
}

try {
  await startService();
  const stream = await within(fetch(baseUrl + "/stream"), "SSE connect");
  if (!stream.ok || !stream.body) throw new Error("SSE endpoint was unavailable");
  const reader = stream.body.getReader();
  const pendingFrame = readSseFrame(reader);

  const invalid = await fetch(baseUrl + "/events", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(fixture.invalid) });
  if (invalid.status < 400 || invalid.status >= 500) throw new Error("invalid event did not return 4xx");
  pass("invalid-event-4xx");

  const accepted = await fetch(baseUrl + "/events", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(fixture.valid) });
  if (!accepted.ok) throw new Error("valid event was rejected with " + accepted.status);
  const acceptedBody = await accepted.json();
  if (acceptedBody.id !== fixture.valid.id) throw new Error("valid event response omitted the event id");
  pass("valid-event-post");

  const frame = await within(pendingFrame, "SSE frame");
  if (!frame.includes(fixture.valid.id) || frame.includes(fixture.invalid.id)) throw new Error("SSE emitted the wrong event: " + JSON.stringify(frame.slice(0, 512)));
  pass("sse-delivery");
  await reader.cancel();

  const healthyCli = spawnSync(process.execPath, ["--experimental-strip-types", path.join(checkoutRoot, "src/health-cli.ts"), baseUrl], { cwd: checkoutRoot, env: process.env, encoding: "utf8" });
  if (healthyCli.status !== 0) throw new Error("health CLI failed against the running service");
  pass("cli-healthy");

  await stopService();
  const beforeRestart = (await readFile(auditPath, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
  if (beforeRestart.length !== 1 || beforeRestart[0].id !== fixture.valid.id) throw new Error("audit did not contain the accepted event exactly once");
  await startService();
  const duplicate = await fetch(baseUrl + "/events", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(fixture.valid) });
  if (!duplicate.ok) throw new Error("duplicate request failed after restart");
  await stopService();
  const afterRestart = (await readFile(auditPath, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
  if (afterRestart.length !== 1 || afterRestart[0].id !== fixture.valid.id) throw new Error("audit did not survive restart exactly once");
  pass("audit-survives-restart");

  const unavailableCli = spawnSync(process.execPath, ["--experimental-strip-types", path.join(checkoutRoot, "src/health-cli.ts"), baseUrl], { cwd: checkoutRoot, env: process.env, encoding: "utf8" });
  if (unavailableCli.status === 0) throw new Error("health CLI succeeded while the service was unavailable");
  pass("cli-unavailable");
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
} finally {
  await stopService();
}

process.stdout.write(JSON.stringify({ schema: "ccc-gate2.loopback-probe-result.v1", cases: CASE_IDS.map((caseId) => results.get(caseId)), failure: failure ?? null }) + "\n");
if (failure || [...results.values()].some(({ passed }) => !passed)) process.exitCode = 1;
`;
}

export interface RunGate2TelemetryUsefulnessProbeInput {
  targetRepositoryRoot: string;
  sourceCommit: string;
  sourceTree: string;
  installedRuntimeReceiptDigest: string;
  nodeExecutable?: string;
  sandboxExecutable?: string;
  timeoutMs?: number;
}

function gitText(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function appendTail(current: Buffer, chunk: Buffer, maximumBytes = 16_384): Buffer {
  const combined = Buffer.concat([current, chunk]);
  return combined.byteLength <= maximumBytes ? combined : combined.subarray(combined.byteLength - maximumBytes);
}

function discoverDarwinRuntimeFiles(executable: string): string[] {
  const files = new Set<string>();
  const visited = new Set<string>();
  const queue = [executable];
  while (queue.length > 0) {
    const loader = queue.shift()!;
    if (visited.has(loader)) continue;
    visited.add(loader);
    let output: string;
    try {
      output = execFileSync("/usr/bin/otool", ["-L", loader], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      continue;
    }
    for (const line of output.split("\n").slice(1)) {
      const dependency = line.trim().split(/\s+/u)[0];
      if (!dependency) continue;
      const suffix = dependency.replace(/^@(loader_path|executable_path|rpath)\//u, "");
      const candidates = dependency.startsWith("/")
        ? [dependency]
        : dependency.startsWith("@loader_path/")
          ? [path.resolve(dirname(loader), suffix)]
          : dependency.startsWith("@executable_path/")
            ? [path.resolve(dirname(executable), suffix)]
            : dependency.startsWith("@rpath/")
              ? [path.resolve(dirname(dirname(loader)), "lib", suffix), path.resolve(dirname(loader), suffix)]
              : [];
      const requested = candidates.find(existsSync);
      if (!requested) continue;
      files.add(requested);
      const canonical = realpathSync(requested);
      files.add(canonical);
      if (canonical.startsWith("/opt/homebrew/") && !visited.has(canonical)) queue.push(canonical);
    }
  }
  return [...files].sort();
}

interface ProbeResult {
  schema: "ccc-gate2.loopback-probe-result.v1";
  cases: Array<{ caseId: Gate2UsefulnessCaseId; passed: boolean; detail?: string }>;
  failure: string | null;
}

function parseProbeResult(stdout: string): ProbeResult | undefined {
  for (const line of stdout.trim().split("\n").reverse()) {
    try {
      const parsed = JSON.parse(line) as ProbeResult;
      if (parsed?.schema === "ccc-gate2.loopback-probe-result.v1") return parsed;
    } catch {}
  }
  return undefined;
}

async function pathIsAbsent(value: string): Promise<boolean> {
  try {
    await access(value);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

function isPosixProcessGroupAbsent(pgid: number): boolean {
  if (process.platform === "win32") {
    throw new Error("POSIX process-group verification is unavailable on win32");
  }
  try {
    process.kill(-pgid, 0);
    return false;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return true;
    if (code === "EPERM") return false;
    throw error;
  }
}

async function waitForPosixProcessGroupAbsence(pgid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isPosixProcessGroupAbsent(pgid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return isPosixProcessGroupAbsent(pgid);
}

export async function runGate2TelemetryUsefulnessProbe(
  input: RunGate2TelemetryUsefulnessProbeInput,
): Promise<Gate2UsefulnessEvidence> {
  if (process.platform !== "darwin") throw new Error(`Gate 2 usefulness sandbox is unavailable on ${process.platform}`);
  const targetRepositoryRoot = resolve(input.targetRepositoryRoot);
  const nodeExecutable = realpathSync(input.nodeExecutable ?? process.execPath);
  const sandboxExecutable = realpathSync(input.sandboxExecutable ?? "/usr/bin/sandbox-exec");
  const runRoot = realpathSync(await mkdtemp(path.join(tmpdir(), "ccc-gate2-usefulness-")));
  const checkoutRoot = path.join(runRoot, "checkout");
  const scratchRoot = path.join(runRoot, "scratch");
  const sandboxHome = path.join(scratchRoot, "home");
  const sandboxTmp = path.join(scratchRoot, "tmp");
  let checkoutRegistered = false;
  let checkoutRemoved = false;
  let scratchRemoved = false;
  let processGroupStopped = false;

  try {
    gitText(targetRepositoryRoot, ["worktree", "add", "--detach", checkoutRoot, input.sourceCommit]);
    checkoutRegistered = true;
    const headCommit = gitText(checkoutRoot, ["rev-parse", "HEAD"]);
    const headTree = gitText(checkoutRoot, ["rev-parse", "HEAD^{tree}"]);
    const clean = gitText(checkoutRoot, ["status", "--porcelain=v1"]) === "";
    if (headCommit !== input.sourceCommit || headTree !== input.sourceTree || !clean) {
      throw new Error("Gate 2 detached checkout does not match the admitted clean source commit/tree");
    }
    await Promise.all([
      mkdir(sandboxHome, { recursive: true }),
      mkdir(sandboxTmp, { recursive: true }),
    ]);
    const port = await acquireNonReservedPort(resolveReservedPorts());
    const runtimeReadFiles = discoverDarwinRuntimeFiles(nodeExecutable);
    const profile = buildGate2LoopbackSandboxProfile({ checkoutRoot, scratchRoot, nodeExecutable, port, runtimeReadFiles });
    const profileSha256 = createHash("sha256").update(profile).digest("hex");
    const probePath = path.join(scratchRoot, "controller-probe.mjs");
    const opensslConfigPath = path.join(scratchRoot, "openssl.cnf");
    await writeFile(probePath, buildGate2UsefulnessProbeSource(), { flag: "wx" });
    await writeFile(opensslConfigPath, "", { flag: "wx" });
    const env: NodeJS.ProcessEnv = {
      CI: "1",
      HOME: sandboxHome,
      TMPDIR: sandboxTmp,
      PATH: dirname(nodeExecutable),
      LANG: "C",
      LC_ALL: "C",
      OPENSSL_CONF: opensslConfigPath,
    };
    const stdoutHash = createHash("sha256");
    const stderrHash = createHash("sha256");
    let stdoutTail = Buffer.alloc(0);
    let stderrTail = Buffer.alloc(0);
    const startedAt = Date.now();
    const supervised = superviseSpawn(sandboxExecutable, [
      "-p", profile,
      nodeExecutable,
      probePath,
      "--checkout", checkoutRoot,
      "--scratch", scratchRoot,
      "--port", String(port),
    ], {
      cwd: checkoutRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      maxLifetimeMs: input.timeoutMs ?? 60_000,
      diagnosticLabel: "ccc-gate2-loopback-usefulness",
    });
    supervised.child.stdout?.on("data", (value: string | Buffer) => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      stdoutHash.update(chunk);
      stdoutTail = appendTail(stdoutTail, chunk);
    });
    supervised.child.stderr?.on("data", (value: string | Buffer) => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      stderrHash.update(chunk);
      stderrTail = appendTail(stderrTail, chunk);
    });
    const exit = await supervised.waitExit();
    if (supervised.pgid === null || !Number.isSafeInteger(supervised.pgid) || supervised.pgid <= 0) {
      throw new Error("Gate 2 usefulness probe did not receive a POSIX process-group id");
    }
    const processGroupVerification = {
      platform: "darwin" as const,
      method: "posix-kill-zero" as const,
      pgid: supervised.pgid,
      absentAfterExit: isPosixProcessGroupAbsent(supervised.pgid),
    };
    processGroupStopped = processGroupVerification.absentAfterExit;
    if (!processGroupStopped) {
      supervised.kill("SIGTERM");
      processGroupStopped = await waitForPosixProcessGroupAbsence(supervised.pgid, 2_000);
    }
    if (!processGroupStopped) {
      supervised.kill("SIGKILL");
      processGroupStopped = await waitForPosixProcessGroupAbsence(supervised.pgid, 1_000);
    }
    const durationMs = Date.now() - startedAt;
    const parsed = parseProbeResult(stdoutTail.toString("utf8"));
    const cases = GATE2_USEFULNESS_CASE_IDS.map((caseId) => parsed?.cases.find((entry) => entry.caseId === caseId)
      ?? { caseId, passed: false, detail: parsed?.failure ?? "probe result missing" });

    gitText(targetRepositoryRoot, ["worktree", "remove", checkoutRoot]);
    checkoutRegistered = false;
    checkoutRemoved = await pathIsAbsent(checkoutRoot);
    await rm(runRoot, { recursive: true, force: true });
    scratchRemoved = await pathIsAbsent(scratchRoot);
    const passed = exit.code === 0
      && exit.signal === null
      && cases.every(({ passed: casePassed }) => casePassed)
      && processGroupStopped
      && processGroupVerification.absentAfterExit
      && checkoutRemoved
      && scratchRemoved;
    return assertGate2UsefulnessEvidence({
      schema: "ccc-gate2.usefulness-evidence.v1",
      installedRuntimeReceiptDigest: input.installedRuntimeReceiptDigest,
      sourceCommit: input.sourceCommit,
      sourceTree: input.sourceTree,
      detachedCheckout: { clean: true, headCommit, headTree },
      reservedPort: port,
      cases,
      process: {
        exitCode: exit.code,
        signal: exit.signal,
        durationMs,
        stdoutTail: stdoutTail.toString("utf8"),
        stdoutSha256: stdoutHash.digest("hex"),
        stderrTail: stderrTail.toString("utf8"),
        stderrSha256: stderrHash.digest("hex"),
      },
      sandboxProfileSha256: profileSha256,
      cleanup: { processGroupStopped, processGroupVerification, checkoutRemoved, scratchRemoved },
      finalTargetStatus: passed ? "passed" : "failed",
    });
  } finally {
    if (checkoutRegistered) {
      try {
        gitText(targetRepositoryRoot, ["worktree", "remove", checkoutRoot]);
        checkoutRemoved = await pathIsAbsent(checkoutRoot);
      } catch {}
    }
    if (!checkoutRegistered || checkoutRemoved) {
      await rm(runRoot, { recursive: true, force: true }).catch(() => undefined);
      scratchRemoved = await pathIsAbsent(scratchRoot).catch(() => false);
    }
    void processGroupStopped;
    void scratchRemoved;
  }
}

function isHash(value: unknown, lengths: readonly number[]): value is string {
  return typeof value === "string"
    && lengths.includes(value.length)
    && /^[0-9a-f]+$/u.test(value);
}

export function assertGate2UsefulnessEvidence(value: unknown): Gate2UsefulnessEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Gate 2 usefulness evidence must be an object");
  }
  const evidence = value as Partial<Gate2UsefulnessEvidence>;
  if (evidence.schema !== "ccc-gate2.usefulness-evidence.v1") throw new Error("invalid Gate 2 usefulness evidence schema");
  if (!isHash(evidence.installedRuntimeReceiptDigest, [64])) throw new Error("invalid installed runtime receipt digest");
  if (!isHash(evidence.sourceCommit, [40, 64]) || !isHash(evidence.sourceTree, [40, 64])) throw new Error("invalid source commit or tree");
  if (evidence.detachedCheckout?.clean !== true || evidence.detachedCheckout.headCommit !== evidence.sourceCommit) {
    throw new Error("detached checkout is not clean at the source commit");
  }
  if (evidence.detachedCheckout.headTree !== evidence.sourceTree) {
    throw new Error("detached checkout tree does not match the source tree");
  }
  assertAllowedPort(evidence.reservedPort ?? 0);
  const observedCases = evidence.cases;
  if (!Array.isArray(observedCases)
    || observedCases.length !== GATE2_USEFULNESS_CASE_IDS.length
    || new Set(observedCases.map(({ caseId }) => caseId)).size !== GATE2_USEFULNESS_CASE_IDS.length
    || !GATE2_USEFULNESS_CASE_IDS.every((caseId) => observedCases.some((entry) => entry.caseId === caseId && typeof entry.passed === "boolean"))) {
    throw new Error("Gate 2 usefulness evidence must contain all six named cases exactly once");
  }
  if (!evidence.process || (evidence.process.exitCode !== null && !Number.isInteger(evidence.process.exitCode))
    || (evidence.process.signal !== null && typeof evidence.process.signal !== "string")
    || !Number.isSafeInteger(evidence.process.durationMs) || evidence.process.durationMs < 0) {
    throw new Error("Gate 2 usefulness probe process evidence is invalid");
  }
  if (typeof evidence.process.stdoutTail !== "string" || typeof evidence.process.stderrTail !== "string"
    || !isHash(evidence.process.stdoutSha256, [64]) || !isHash(evidence.process.stderrSha256, [64])) {
    throw new Error("Gate 2 usefulness process output evidence is invalid");
  }
  if (!isHash(evidence.sandboxProfileSha256, [64])) throw new Error("invalid Gate 2 sandbox profile digest");
  const processGroupVerification = evidence.cleanup?.processGroupVerification;
  if (!evidence.cleanup || ![evidence.cleanup.processGroupStopped, evidence.cleanup.checkoutRemoved, evidence.cleanup.scratchRemoved]
    .every((entry) => typeof entry === "boolean")) {
    throw new Error("Gate 2 usefulness cleanup evidence is invalid");
  }
  if (processGroupVerification?.platform !== "darwin"
    || processGroupVerification.method !== "posix-kill-zero"
    || !Number.isSafeInteger(processGroupVerification.pgid)
    || processGroupVerification.pgid <= 0
    || typeof processGroupVerification.absentAfterExit !== "boolean") {
    throw new Error("Gate 2 usefulness POSIX process-group verification is invalid");
  }
  if (!(["passed", "failed"] as const).includes(evidence.finalTargetStatus as "passed" | "failed")) {
    throw new Error("Gate 2 usefulness final target status is invalid");
  }
  if (evidence.finalTargetStatus === "passed" && (
    evidence.process.exitCode !== 0
    || evidence.process.signal !== null
    || observedCases.some(({ passed }) => !passed)
    || !evidence.cleanup.processGroupStopped
    || !processGroupVerification.absentAfterExit
    || !evidence.cleanup.checkoutRemoved
    || !evidence.cleanup.scratchRemoved
  )) {
    throw new Error("Gate 2 usefulness evidence claims passed without the process group proven absent after exit, clean cases, and cleanup");
  }
  return evidence as Gate2UsefulnessEvidence;
}
