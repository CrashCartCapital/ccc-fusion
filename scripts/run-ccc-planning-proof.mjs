#!/usr/bin/env node
/*
FNXC:CccPlanningProof 2026-10-14-09:50:
Closed-inventory proof runner for the CCC-Fusion request-to-code planning work (card P0; CONTRACT-v2 section 2.20, ADR D Q1/Q2, decisions D25, D50, D51). One command, three modes:
- `targeted`  runs every TARGETED command of the inventory (`scripts/lib/ccc-planning-proof-inventory`). Darwin-only entries make it refuse on a non-Darwin host.
- `offline`   runs every OFFLINE command and is Darwin-only: the lane also needs a working `sandbox-exec`, probed before anything is spawned.
- `ci-linux`  runs TARGETED then OFFLINE, restricted to `platform: "any"` and PostgreSQL-free entries, with no dedupe, and needs no sandbox. It is the one extra Gate step in pr-checks.yml.

What a pass means. Each command runs a real test runner (vitest through pnpm, or `node --test` with this repo's closed-results reporter) with a JSON result file. The run passes only when, for every command: the supervisor row is the one the runner planned (right id, the result path the runner chose, no timeout, signal, forced kill or spawn error); the machine result closes (every expected name passed, no skipped/pending/todo/failed/extra/duplicate name, or, for a files closure, every listed file executed at least one test and nothing unlisted ran); the exit status is zero; no non-loopback network attempt was recorded; and the Git snapshot after the run equals the snapshot before it. An empty or all-skipped suite fails by the same rule `decideDarwinProofLaneOutcome` (scripts/ci-darwin-proof-lane.mjs) applies to the Darwin lane, which this file reuses on purpose.

Honest limits:
- The offline guard (`scripts/lib/ccc-planning-offline-network-guard.mjs`) is a tripwire preloaded with NODE_OPTIONS, not a sandbox. `PI_OFFLINE=1` is a convention the suites read, not an enforcement.
- The foreign-Git-mutation check sees HEAD, the tracked/untracked status lines and the worktree list. It cannot see an edit to a file that was already modified before the run, and another process using the same repository during the run can trip it.
- PostgreSQL is OWNED, never borrowed: every PostgreSQL setting in the caller's environment is dropped. When a selected command declares `needsPostgres`, a disposable embedded cluster is started inside a supervisor child and only those commands see its URL (FUSION_PG_TEST_URL_BASE, and CCC_PG_URL_BASE for later engine real-pg cards). Every other command runs with FUSION_PG_TEST_SKIP=1, which stops the vitest global setup from probing a server on the default shared port; a PostgreSQL test hiding in such a command shows up as a skipped test, and the closed-results check fails the run. The caller's own FUSION_PG_TEST_SKIP=1 is refused outright. `ci-linux` selects no PostgreSQL command, so it never starts a cluster.
- `scripts/run-ccc-pg-proof.mjs` is the model for the supervisor, but it runs side effects on import and is frozen evidence, so its policy is re-implemented here rather than imported.

Exit codes: 0 pass, 1 refusal or failed proof, 2 usage error. On a pass the scratch directory is removed and the report stays; on a failure everything is preserved and the report names the directory.
*/
import { spawn, execFile, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { decideDarwinProofLaneOutcome } from "./ci-darwin-proof-lane.mjs";
import {
  CCC_PLANNING_PACKAGE_DIRS,
  CccPlanningProofError,
  assertCccPlanningSuiteSkipPolicy,
  assertMachineResultInventory,
  assertMachineResultJson,
  tallyVitestReport,
} from "./lib/ccc-closed-vitest-results.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = path.resolve(here, "..");
const defaultGuardPath = path.join(here, "lib", "ccc-planning-offline-network-guard.mjs");
const reporterPath = path.join(here, "lib", "ccc-closed-vitest-results.mjs");
const inventoryIndexPath = path.join(here, "lib", "ccc-planning-proof-inventory", "index.mjs");

export const CCC_PLANNING_PROOF_CODES = Object.freeze({
  USAGE: "CCC_PLANNING_PROOF_USAGE",
  PG_SKIP: "CCC_PLANNING_PROOF_PG_SKIP_REFUSED",
  INVENTORY: "CCC_PLANNING_PROOF_INVENTORY_INVALID",
  PLATFORM: "CCC_PLANNING_OFFLINE_PLATFORM_UNSUPPORTED",
  SANDBOX: "CCC_PLANNING_OFFLINE_SANDBOX_UNAVAILABLE",
  SUPERVISOR: "CCC_PLANNING_PROOF_SUPERVISOR_FAILED",
  RESULTS: "CCC_PLANNING_PROOF_RESULTS_NOT_CLOSED",
  FOREIGN_GIT: "CCC_PLANNING_PROOF_FOREIGN_GIT_MUTATION",
  NETWORK: "CCC_PLANNING_OFFLINE_NETWORK_ATTEMPT",
});
const CODE = CCC_PLANNING_PROOF_CODES;

/** Which refusal is reported first when several apply. The rest stay in `report.failures`. */
const REFUSAL_PRECEDENCE = Object.freeze([CODE.SUPERVISOR, CODE.NETWORK, CODE.FOREIGN_GIT, CODE.RESULTS]);

export const CCC_PLANNING_PROOF_MODES = Object.freeze(["targeted", "offline", "ci-linux"]);

const TERMINATE_GRACE_MS = 2_000;
const PG_STOP_TIMEOUT_MS = 10_000;
const PARENT_SHUTDOWN_MARGIN_MS = 3_000;
const SUPERVISOR_RESULT_MARKER = "CCC_PLANNING_SUPERVISOR_RESULT=";

/** Settings that could point a suite at a PostgreSQL server the runner does not own. */
const PG_ENV_PATTERN = /^(?:PG[A-Z0-9_]*|DATABASE_URL|POSTGRES(?:QL)?_[A-Z0-9_]*|FUSION_PG_[A-Z0-9_]*|CCC_PG_[A-Z0-9_]*)$/;

/**
 * @param {string[]} argv arguments after the script name
 * @returns {{ mode: "targeted" | "offline" | "ci-linux" } | { usageError: string, mode?: undefined }}
 */
export function parseCccPlanningProofArgs(argv) {
  const usage = (usageError) => ({ usageError });
  const tokens = [...argv];
  if (tokens[0] === "--") tokens.shift();
  let mode;
  let seen = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    let value;
    if (token === "--mode") {
      value = tokens[index + 1];
      index += 1;
      if (value === undefined) return usage("--mode needs a value");
    } else if (token.startsWith("--mode=")) {
      value = token.slice("--mode=".length);
    } else {
      return usage(`unexpected argument: ${token}`);
    }
    if (seen) return usage("--mode was given more than once");
    seen = true;
    if (!CCC_PLANNING_PROOF_MODES.includes(value)) return usage(`unknown mode ${JSON.stringify(value)}; expected one of ${CCC_PLANNING_PROOF_MODES.join(", ")}`);
    mode = value;
  }
  if (!seen) return usage("--mode is required");
  return { mode };
}

/**
 * The exact program, arguments and working directory for one inventory command.
 * @param {import("./lib/ccc-closed-vitest-results.mjs").ClosedSuiteCommand} command
 * @param {{ repoRoot: string, outputFile: string }} options
 * @returns {{ file: string, args: string[], cwd: string }}
 */
export function buildCccPlanningCommandArgv(command, options) {
  if (command.packageFilter === "node-test") {
    return {
      file: process.execPath,
      cwd: options.repoRoot,
      args: ["--test", `--test-reporter=${reporterPath}`, `--test-reporter-destination=${options.outputFile}`, ...command.files],
    };
  }
  return {
    file: "pnpm",
    cwd: options.repoRoot,
    args: [
      "--filter",
      command.packageFilter,
      "exec",
      "vitest",
      "run",
      ...(command.config ? ["--config", command.config] : []),
      ...(command.project ? [`--project=${command.project}`] : []),
      "--silent=passed-only",
      "--reporter=dot",
      "--reporter=json",
      "--outputFile",
      options.outputFile,
      ...command.files,
    ],
  };
}

function quoteNodeOption(value) {
  return /[\s"\\]/.test(value) ? `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : value;
}

/**
 * The environment every proof child gets. `NODE_OPTIONS=--import <guard>` is what loads the offline tripwire into every Node process the command starts, vitest workers and `node --test` children included.
 * @returns {{ childEnv: Record<string, string>, supervisorEnv: Record<string, string> }}
 */
function buildProofEnv({ callerEnv, guardPath, guardReportFile, scratchRoot }) {
  const base = {};
  for (const [key, value] of Object.entries(callerEnv)) {
    if (value === undefined || PG_ENV_PATTERN.test(key)) continue;
    base[key] = String(value);
  }
  const guardImport = `--import ${quoteNodeOption(guardPath)}`;
  const baseNodeOptions = base.NODE_OPTIONS ?? "";
  const withGuard = baseNodeOptions.includes(guardImport) ? baseNodeOptions : [baseNodeOptions, guardImport].filter(Boolean).join(" ");
  const childEnv = {
    ...base,
    PI_OFFLINE: "1",
    NODE_OPTIONS: withGuard,
    CCC_PLANNING_OFFLINE_GUARD_REPORT: guardReportFile,
    CCC_PLANNING_PROOF_SCRATCH: scratchRoot,
    TMPDIR: scratchRoot,
  };
  const supervisorEnv = { ...childEnv };
  if (baseNodeOptions === "") delete supervisorEnv.NODE_OPTIONS;
  else supervisorEnv.NODE_OPTIONS = baseNodeOptions;
  delete supervisorEnv.CCC_PLANNING_OFFLINE_GUARD_REPORT;
  return { childEnv, supervisorEnv };
}

function redact(text) {
  return String(text)
    .replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, "[redacted-postgresql-url]")
    .replace(/password=[^\s&]+/gi, "password=[redacted]");
}

/*
FNXC:CccPlanningProofGit 2026-10-14-09:55:
The Git snapshot is HEAD, its tree, the porcelain status (tracked changes and untracked paths, default untracked mode) and the worktree list with HEAD lines removed (another worktree's HEAD moving is not this run's doing; a worktree appearing or a branch changing is). GIT_OPTIONAL_LOCKS=0 stops `git status` from taking the index lock, so taking a snapshot can never block or race a suite's own Git work. A repository that is not a Git checkout yields nulls; equal nulls pass, and the report says the provenance is unknown.
*/
async function defaultGitSnapshot(repoRoot) {
  const gitEnv = { PATH: process.env.PATH, HOME: process.env.HOME, GIT_OPTIONAL_LOCKS: "0" };
  const git = (args) => {
    try {
      return execFileSync("git", args, { cwd: repoRoot, env: gitEnv, encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return null;
    }
  };
  const head = git(["rev-parse", "HEAD"])?.trim() ?? null;
  const tree = git(["rev-parse", "HEAD^{tree}"])?.trim() ?? null;
  const statusPorcelain = git(["status", "--porcelain"]);
  const worktreeList = git(["worktree", "list", "--porcelain"]);
  const worktrees = worktreeList === null ? null : worktreeList.split("\n").filter((line) => !line.startsWith("HEAD ")).join("\n");
  const trackedDirtyPaths = statusPorcelain === null ? null : statusPorcelain.split("\n").filter((line) => line.length > 0 && !line.startsWith("??")).length;
  return { head, tree, trackedDirtyPaths, statusPorcelain, worktrees };
}

function differingGitFields(before, after) {
  if (!before || !after) return [];
  return ["head", "tree", "statusPorcelain", "worktrees"].filter((field) => before[field] !== after[field]);
}

async function hashFile(filePath) {
  try {
    return createHash("sha256").update(await readFile(filePath)).digest("hex");
  } catch {
    return null;
  }
}

async function defaultInspectSandboxReadiness() {
  return new Promise((resolve) => {
    execFile("sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"], { timeout: 5_000, encoding: "utf8" }, (error, _stdout, stderr) => {
      if (error) resolve({ ready: false, detail: `sandbox-exec could not run a trivial profile: ${redact(stderr || error.message).trim()}` });
      else resolve({ ready: true, detail: "sandbox-exec ran a trivial profile" });
    });
  });
}

async function defaultLoadInventory() {
  const inventory = await import(inventoryIndexPath);
  return inventory.loadCccPlanningInventory();
}

function stopWithinBudgetPolicy(lifecycle, stopTimeoutMs) {
  return new Promise((resolve, reject) => {
    let timeoutLatched = false;
    let settled = false;
    const finish = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); fn(value); };
    const stopPromise = Promise.resolve().then(() => lifecycle.stop());
    const timer = setTimeout(() => {
      timeoutLatched = true;
      const timeout = new Error("embedded PostgreSQL stop timed out");
      const forcedCleanupPromise = Promise.resolve().then(() => lifecycle.terminateOwnedPostmaster());
      void Promise.allSettled([stopPromise, forcedCleanupPromise]).then(([stopResult, forcedResult]) => {
        const errors = [
          timeout,
          ...(stopResult.status === "rejected" ? [stopResult.reason] : []),
          ...(forcedResult.status === "rejected" ? [forcedResult.reason] : []),
        ];
        finish(reject, new AggregateError(errors, "embedded PostgreSQL stop timed out and shutdown settlement failed"));
      });
    }, stopTimeoutMs);
    stopPromise.then(
      () => { if (!timeoutLatched) finish(resolve); },
      (error) => { if (!timeoutLatched) finish(reject, error); },
    );
  });
}

function stopFailureText(error) {
  const errors = error instanceof AggregateError ? error.errors : [error];
  return errors.map((entry) => String(entry instanceof Error ? entry.message : entry)
    .replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, "[redacted-postgresql-url]")
    .replace(/password=[^\s&]+/gi, "password=[redacted]")).join(" | ");
}

/*
FNXC:CccPlanningProofSupervisor 2026-10-14-10:05:
Supervisor child. It reads one JSON payload from stdin (the child environment can hold tokens, so it never touches disk or argv), optionally starts the owned embedded PostgreSQL, runs each planned command in order with its own timeout (SIGTERM, then SIGKILL after a grace period, both counted in the row), sends each command's output to its own log file, always stops PostgreSQL inside a bounded budget, and writes exactly one marker line on stdout before exiting. Unlike the frozen PG proof it keeps running the remaining commands after a failed one, so a single run reports every failure. It exits explicitly because embedded-postgres registers a natural-beforeExit hook that can misfire after an explicit stop.
*/
const SUPERVISOR_SOURCE = `
  import { spawn } from "node:child_process";
  import { closeSync, openSync, writeSync } from "node:fs";
  import { mkdir } from "node:fs/promises";
  import { pathToFileURL } from "node:url";
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const results = [];
  const lifecycleErrors = [];
  let lifecycle = null;
  let interrupted = null;
  let activeTerminate = null;
  let startError = null;
  let stopError = null;
  ${stopWithinBudgetPolicy.toString()}
  ${stopFailureText.toString()}
  const run = (entry, env) => new Promise((resolve) => {
    const logFd = openSync(entry.logFile, "a");
    const child = spawn(entry.file, entry.args, { cwd: entry.cwd, env, stdio: ["ignore", logFd, logFd] });
    closeSync(logFd);
    let settled = false;
    let timedOut = false;
    let forcedKill = false;
    let forceTimer = null;
    const finish = (result) => { if (settled) return; settled = true; clearTimeout(timer); if (forceTimer) clearTimeout(forceTimer); activeTerminate = null; resolve(result); };
    const terminate = (signal = "SIGTERM") => {
      if (settled) return;
      child.kill(signal);
      if (signal === "SIGTERM") {
        forceTimer = setTimeout(() => { if (!settled) { forcedKill = true; child.kill("SIGKILL"); } }, payload.terminateGraceMs);
      }
    };
    activeTerminate = terminate;
    const timer = setTimeout(() => { timedOut = true; terminate("SIGTERM"); }, entry.timeoutMs);
    child.once("error", (error) => finish({ code: 1, signal: null, timedOut, forcedKill, spawnError: error instanceof Error ? error.message : String(error) }));
    child.once("exit", (code, signal) => finish({ code: Number(code ?? 1), signal: signal ?? null, timedOut, forcedKill }));
  });
  const onSignal = (signal) => { interrupted ??= signal; activeTerminate?.("SIGTERM"); };
  const onSigInt = () => onSignal("SIGINT");
  const onSigTerm = () => onSignal("SIGTERM");
  process.once("SIGINT", onSigInt);
  process.once("SIGTERM", onSigTerm);
  try {
    await mkdir(payload.resultRoot, { recursive: true });
    await mkdir(payload.logRoot, { recursive: true });
    let ownedPgBase = null;
    if (payload.needsPostgres) {
      const { EmbeddedPostgresLifecycle } = await import(pathToFileURL(payload.lifecyclePath).href);
      lifecycle = new EmbeddedPostgresLifecycle({
        dataDir: payload.dataRoot,
        database: payload.database,
        installShutdownHooks: false,
        throwOnStopError: true,
        onError: (error) => lifecycleErrors.push(String(error)),
      });
      await lifecycle.start();
      const url = new URL(lifecycle.getConnectionUrl());
      url.pathname = "/";
      ownedPgBase = url.href.slice(0, -1);
    }
    for (const entry of payload.commands) {
      if (interrupted) break;
      // A PostgreSQL command gets only the owned server. Every other command is told PostgreSQL is skipped, which keeps the vitest global setup from probing (and so from ever touching) a server on the default shared port; a PostgreSQL test that sneaks into such a command then shows up as a skipped test, and the closed-results check fails the run.
      const env = entry.needsPostgres
        ? { ...payload.childEnv, FUSION_PG_TEST_URL_BASE: ownedPgBase, CCC_PG_URL_BASE: ownedPgBase }
        : { ...payload.childEnv, FUSION_PG_TEST_SKIP: "1" };
      const outcome = await run(entry, env);
      results.push({ id: entry.id, timeoutMs: entry.timeoutMs, ...outcome, outputFile: entry.outputFile, logFile: entry.logFile });
    }
  } catch (error) {
    startError = stopFailureText(error);
  } finally {
    process.removeListener("SIGINT", onSigInt);
    process.removeListener("SIGTERM", onSigTerm);
    if (lifecycle) {
      try { await stopWithinBudgetPolicy(lifecycle, payload.stopTimeoutMs); } catch (error) { stopError = stopFailureText(error); }
    }
  }
  const failed = startError || stopError || interrupted || results.length !== payload.commands.length || results.some((result) => result.code !== 0);
  writeSync(1, ${JSON.stringify(SUPERVISOR_RESULT_MARKER)} + JSON.stringify({ results, database: payload.database, startError, stopError, lifecycleErrors, interrupted }) + "\\n");
  process.exit(failed ? 1 : 0);
`;

/**
 * Runs the planned commands in a supervisor child and returns its rows. Throws when the supervisor itself misbehaves (no marker, more than one marker, unparsable marker); the runner turns that into a coded refusal.
 * @param {import("./lib/ccc-closed-vitest-results.mjs").ClosedSuiteCommand[]} commands
 * @param {{ repoRoot: string, env: Record<string,string>, supervisorEnv?: Record<string,string>, resultRoot: string, logRoot: string, dataRoot: string, needsPostgres: boolean, postgresDatabase: string | null }} options
 */
export async function runSupervisedProofCommands(commands, options) {
  const planned = commands.map((command) => {
    const outputFile = path.join(options.resultRoot, `${command.id}.json`);
    const argv = buildCccPlanningCommandArgv(command, { repoRoot: options.repoRoot, outputFile });
    return { id: command.id, file: argv.file, args: argv.args, cwd: argv.cwd, timeoutMs: command.timeoutMs, needsPostgres: command.needsPostgres, outputFile, logFile: path.join(options.logRoot, `${command.id}.log`) };
  });
  const payload = {
    commands: planned,
    childEnv: options.env,
    needsPostgres: options.needsPostgres,
    dataRoot: options.dataRoot,
    database: options.postgresDatabase,
    resultRoot: options.resultRoot,
    logRoot: options.logRoot,
    terminateGraceMs: TERMINATE_GRACE_MS,
    stopTimeoutMs: PG_STOP_TIMEOUT_MS,
    lifecyclePath: path.join(options.repoRoot, "packages", "core", "src", "postgres", "embedded-lifecycle.ts"),
  };
  const nodeArgs = options.needsPostgres
    ? ["--import", "tsx", "--input-type=module", "-e", SUPERVISOR_SOURCE]
    : ["--input-type=module", "-e", SUPERVISOR_SOURCE];
  const child = spawn(process.execPath, nodeArgs, { cwd: options.repoRoot, env: options.supervisorEnv ?? options.env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  child.stdin.on("error", () => {});
  child.stdin.end(JSON.stringify(payload));

  let forwardedSignal = null;
  let forceKillTimer = null;
  const shutdownBoundMs = TERMINATE_GRACE_MS + PG_STOP_TIMEOUT_MS + PARENT_SHUTDOWN_MARGIN_MS;
  const forwardSignal = (signal) => {
    forwardedSignal ??= signal;
    child.kill(signal);
    forceKillTimer ??= setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, shutdownBoundMs);
  };
  const onSigInt = () => forwardSignal("SIGINT");
  const onSigTerm = () => forwardSignal("SIGTERM");
  process.once("SIGINT", onSigInt);
  process.once("SIGTERM", onSigTerm);
  const normalBoundMs = commands.reduce((total, command) => total + command.timeoutMs, 0) + shutdownBoundMs;
  const normalTimer = setTimeout(() => forwardSignal("SIGTERM"), normalBoundMs);

  let spawnError = null;
  const exitCode = await new Promise((resolve) => {
    child.once("error", (error) => {
      spawnError = redact(error instanceof Error ? error.message : String(error));
      resolve(1);
    });
    child.once("exit", resolve);
  });
  process.removeListener("SIGINT", onSigInt);
  process.removeListener("SIGTERM", onSigTerm);
  clearTimeout(normalTimer);
  if (forceKillTimer) clearTimeout(forceKillTimer);
  await mkdir(options.logRoot, { recursive: true });
  await writeFile(path.join(options.logRoot, "supervisor.log"), redact(`${stdout}\n${stderr}`));

  if (spawnError) throw new Error(`supervisor spawn rejected: ${spawnError}`);
  if (forwardedSignal) throw new Error(`proof runner interrupted by ${forwardedSignal}`);
  const markerLines = stdout.split("\n").filter((line) => line.startsWith(SUPERVISOR_RESULT_MARKER));
  if (markerLines.length === 0) throw new Error(`supervisor exited ${exitCode} without a machine result: ${redact(stderr).trim().slice(-400)}`);
  if (markerLines.length > 1) throw new Error(`supervisor emitted the machine-result marker ${markerLines.length} times; expected exactly once`);
  const parsed = JSON.parse(markerLines[0].slice(SUPERVISOR_RESULT_MARKER.length));
  return { ...parsed, supervisorExitCode: exitCode };
}

function emptyReport({ mode, platform }) {
  return {
    schema: "ccc-planning.proof-report.v1",
    mode,
    passed: false,
    refusal: null,
    failures: [],
    gitHead: null,
    gitTree: null,
    workingTreeDirty: null,
    platform,
    nodeVersion: process.version,
    inventorySha256: "",
    manifestHashes: { "package.json": null, "pnpm-workspace.yaml": null, "pnpm-lock.yaml": null },
    perCommand: [],
    postgres: { owned: false },
    offlineGuard: { attempts: 0, reportFile: null, entries: [] },
    scratch: { root: null, cleanup: "not-created" },
  };
}

function selectCommands(mode, inventory) {
  const targeted = Array.isArray(inventory.targeted) ? inventory.targeted : [];
  const offline = Array.isArray(inventory.offline) ? inventory.offline : [];
  if (mode === "targeted") return [...targeted];
  if (mode === "offline") return [...offline];
  return [...targeted, ...offline].filter((command) => command.platform === "any" && command.needsPostgres === false);
}

function validateSelectedCommands(commands, repoRoot) {
  const ids = new Set();
  for (const command of commands) {
    assertMachineResultInventory(command);
    if (ids.has(command.id)) throw new CccPlanningProofError(CODE.INVENTORY, `${command.id}: selected twice`);
    ids.add(command.id);
    const packageRoot = path.join(repoRoot, CCC_PLANNING_PACKAGE_DIRS[command.packageFilter]);
    for (const file of command.files) {
      let text;
      try {
        text = readFileSync(path.join(packageRoot, file), "utf8");
      } catch {
        throw new CccPlanningProofError(CODE.INVENTORY, `${command.id}: listed file does not exist: ${file}`);
      }
      assertCccPlanningSuiteSkipPolicy(text, { file, platform: command.platform, needsPostgres: command.needsPostgres });
    }
  }
}

function readGuardReport(reportFile) {
  let text = "";
  try {
    text = readFileSync(reportFile, "utf8");
  } catch {
    return { attempts: 0, reportFile, entries: [] };
  }
  const lines = text.split("\n").filter((line) => line.length > 0);
  const entries = lines.slice(0, 20).map((line) => {
    try {
      const parsed = JSON.parse(line);
      return { api: parsed.api ?? null, host: parsed.host ?? null, port: parsed.port ?? null, pid: parsed.pid ?? null };
    } catch {
      return { unparsable: line.slice(0, 200) };
    }
  });
  return { attempts: lines.length, reportFile, entries };
}

/**
 * @param {{
 *   mode: string,
 *   repoRoot?: string,
 *   env?: Record<string, string | undefined>,
 *   platform?: string,
 *   inspectSandboxReadiness?: () => Promise<{ ready: boolean, detail: string }>,
 *   runSupervised?: typeof runSupervisedProofCommands,
 *   loadInventory?: () => Promise<{ targeted: readonly object[], offline: readonly object[], sha256: string }>,
 *   scratchParent?: string,
 *   gitSnapshot?: (repoRoot: string) => Promise<object>,
 *   guardPath?: string,
 *   log?: (line: string) => void,
 * }} input
 * @returns {Promise<{ exitCode: number, report: ReturnType<typeof emptyReport> }>}
 */
export async function runCccPlanningProof(input) {
  const mode = input.mode;
  const repoRoot = input.repoRoot ?? defaultRepoRoot;
  const callerEnv = input.env ?? process.env;
  const platform = input.platform ?? process.platform;
  const log = input.log ?? ((line) => console.log(line));
  const runSupervised = input.runSupervised ?? runSupervisedProofCommands;
  const inspectSandboxReadiness = input.inspectSandboxReadiness ?? defaultInspectSandboxReadiness;
  const loadInventory = input.loadInventory ?? defaultLoadInventory;
  const gitSnapshot = input.gitSnapshot ?? defaultGitSnapshot;
  const guardPath = input.guardPath ?? defaultGuardPath;
  const scratchParent = input.scratchParent ?? tmpdir();

  const report = emptyReport({ mode, platform });
  const refuse = (code, detail, exitCode = 1) => {
    report.refusal = { code, detail };
    report.failures = [{ code, detail }];
    log(`ccc-planning-proof: refused (${code}): ${detail}`);
    return { exitCode, report };
  };

  if (!CCC_PLANNING_PROOF_MODES.includes(mode)) {
    return refuse(CODE.USAGE, `unknown mode ${JSON.stringify(mode)}; expected one of ${CCC_PLANNING_PROOF_MODES.join(", ")}`, 2);
  }
  if (callerEnv.FUSION_PG_TEST_SKIP === "1") {
    return refuse(CODE.PG_SKIP, "FUSION_PG_TEST_SKIP=1 turns PostgreSQL-backed tests into silent skips; a skipped test is a failed proof, so the run is refused before any test starts");
  }

  let inventory;
  try {
    inventory = await loadInventory();
  } catch (error) {
    return refuse(CODE.INVENTORY, `inventory did not load: ${error instanceof Error ? error.message : String(error)}`);
  }
  report.inventorySha256 = typeof inventory.sha256 === "string" ? inventory.sha256 : "";

  const commands = selectCommands(mode, inventory);
  if (commands.length === 0) {
    return refuse(CODE.INVENTORY, `mode ${mode} selected no command; an empty inventory proves nothing`);
  }

  if (mode === "offline") {
    if (platform !== "darwin") return refuse(CODE.PLATFORM, `offline mode needs the Darwin sandbox and cannot run on ${platform}`);
    const readiness = await inspectSandboxReadiness();
    if (!readiness?.ready) return refuse(CODE.SANDBOX, `the Darwin sandbox is not ready: ${readiness?.detail ?? "no detail"}`);
  } else if (mode === "targeted" && platform !== "darwin") {
    const darwinOnly = commands.filter((command) => command.platform === "darwin").map((command) => command.id);
    if (darwinOnly.length > 0) return refuse(CODE.PLATFORM, `targeted mode on ${platform} cannot run darwin-only command(s): ${darwinOnly.join(", ")}`);
  }

  try {
    validateSelectedCommands(commands, repoRoot);
  } catch (error) {
    if (error instanceof CccPlanningProofError) return refuse(CODE.INVENTORY, error.message);
    throw error;
  }

  const needsPostgres = commands.some((command) => command.needsPostgres);
  const postgresDatabase = needsPostgres ? `ccc_planning_proof_${randomBytes(4).toString("hex")}` : null;
  report.postgres = needsPostgres ? { owned: true, database: postgresDatabase } : { owned: false };

  const proofRoot = await mkdtemp(path.join(scratchParent, "ccc-planning-proof-"));
  const scratchRoot = path.join(proofRoot, "scratch");
  const resultRoot = path.join(proofRoot, "results");
  const logRoot = path.join(proofRoot, "logs");
  const dataRoot = path.join(scratchRoot, "postgres-data");
  const guardReportFile = path.join(proofRoot, "offline-guard.jsonl");
  for (const directory of [scratchRoot, resultRoot, logRoot]) await mkdir(directory, { recursive: true });
  report.scratch = { root: proofRoot, cleanup: "preserved-on-failure" };

  const { childEnv, supervisorEnv } = buildProofEnv({ callerEnv, guardPath, guardReportFile, scratchRoot });

  report.manifestHashes = {
    "package.json": await hashFile(path.join(repoRoot, "package.json")),
    "pnpm-workspace.yaml": await hashFile(path.join(repoRoot, "pnpm-workspace.yaml")),
    "pnpm-lock.yaml": await hashFile(path.join(repoRoot, "pnpm-lock.yaml")),
  };
  let before = null;
  try {
    before = await gitSnapshot(repoRoot);
  } catch {
    before = null;
  }
  report.gitHead = before?.head ?? null;
  report.gitTree = before?.tree ?? null;
  report.workingTreeDirty = typeof before?.trackedDirtyPaths === "number" ? before.trackedDirtyPaths > 0 : null;

  log(`ccc-planning-proof: mode ${mode}, ${commands.length} command(s): ${commands.map((command) => command.id).join(", ")}`);
  log(`ccc-planning-proof: proof directory ${proofRoot}`);

  const failures = [];
  const fail = (code, detail) => failures.push({ code, detail });
  const rowsFor = new Map(commands.map((command) => [
    command.id,
    {
      id: command.id,
      closure: command.closure,
      passed: 0,
      expected: command.closure === "names" ? command.expectedNames.length : null,
      skipped: 0,
      failed: 0,
      timedOut: false,
      exitCode: null,
      signal: null,
    },
  ]));
  report.perCommand = [...rowsFor.values()];

  let supervised = null;
  try {
    supervised = await runSupervised(commands, {
      repoRoot,
      env: childEnv,
      supervisorEnv,
      scratchRoot,
      resultRoot,
      logRoot,
      dataRoot,
      needsPostgres,
      postgresDatabase,
    });
  } catch (error) {
    fail(CODE.SUPERVISOR, `supervised run failed: ${redact(error instanceof Error ? error.message : String(error))}`);
  }

  if (supervised) {
    if (supervised.startError) fail(CODE.SUPERVISOR, `embedded PostgreSQL did not start: ${supervised.startError}`);
    if (supervised.stopError) fail(CODE.SUPERVISOR, `embedded PostgreSQL stop failed: ${supervised.stopError}`);
    if (supervised.interrupted) fail(CODE.SUPERVISOR, `supervisor interrupted by ${supervised.interrupted}`);
    if (Array.isArray(supervised.lifecycleErrors) && supervised.lifecycleErrors.length > 0) {
      fail(CODE.SUPERVISOR, `embedded PostgreSQL lifecycle reported errors: ${supervised.lifecycleErrors.join(" | ")}`);
    }
    const rowById = new Map();
    for (const row of Array.isArray(supervised.results) ? supervised.results : []) {
      if (!rowsFor.has(row?.id)) {
        fail(CODE.SUPERVISOR, `unexpected command result: ${row?.id}`);
        continue;
      }
      if (rowById.has(row.id)) {
        fail(CODE.SUPERVISOR, `duplicate command result: ${row.id}`);
        continue;
      }
      rowById.set(row.id, row);
    }
    for (const command of commands) {
      const row = rowById.get(command.id);
      const summary = rowsFor.get(command.id);
      if (!row) {
        fail(CODE.SUPERVISOR, `missing command result: ${command.id}`);
        continue;
      }
      summary.timedOut = row.timedOut === true;
      summary.exitCode = typeof row.code === "number" ? row.code : null;
      summary.signal = row.signal ?? null;
      const expectedOutput = path.join(resultRoot, `${command.id}.json`);
      let structural = false;
      if (row.outputFile !== expectedOutput) {
        fail(CODE.SUPERVISOR, `${command.id}: result path ${JSON.stringify(row.outputFile)} is not the one the runner chose`);
        continue;
      }
      if (row.timedOut) { fail(CODE.SUPERVISOR, `${command.id} exceeded its ${command.timeoutMs} ms timeout`); structural = true; }
      if (row.forcedKill) { fail(CODE.SUPERVISOR, `${command.id} needed SIGKILL after graceful termination failed`); structural = true; }
      if (row.spawnError) { fail(CODE.SUPERVISOR, `${command.id} could not be spawned: ${redact(row.spawnError)}`); structural = true; }
      if (row.signal) { fail(CODE.SUPERVISOR, `${command.id} was terminated by ${row.signal}`); structural = true; }

      let json;
      try {
        json = JSON.parse(await readFile(expectedOutput, "utf8"));
      } catch (error) {
        fail(CODE.RESULTS, `${command.id}: wrote no readable machine result (${error instanceof Error ? error.message : String(error)})`);
        continue;
      }
      let resultsClosed = false;
      if (json && typeof json === "object" && Array.isArray(json.testResults)) {
        const tally = tallyVitestReport(json);
        summary.passed = tally.passed;
        summary.skipped = tally.skipped;
        summary.failed = tally.failed;
        const failedAssertions = json.testResults.flatMap((result) => (result.assertionResults ?? []).filter((assertion) => assertion.status === "failed"));
        if (failedAssertions.length > 0) {
          summary.failureDetails = failedAssertions.slice(0, 3).map((assertion) => `${[...(assertion.ancestorTitles ?? []), assertion.title].join(" > ")}: ${redact(String(assertion.failureMessages?.[0] ?? "no message")).slice(0, 300)}`);
        }
        const decision = decideDarwinProofLaneOutcome([
          { suite: command.id, numTotalTests: tally.total, numPendingTests: tally.skipped, numFailedTests: tally.failed, exitStatus: 0 },
        ]);
        if (!decision.ok) {
          fail(CODE.RESULTS, `${command.id}: ${decision.message.replace(/^\S+\s*/, "")}`);
        } else {
          try {
            assertMachineResultJson(json, command, { packageRoot: path.join(repoRoot, CCC_PLANNING_PACKAGE_DIRS[command.packageFilter]) });
            resultsClosed = true;
          } catch (error) {
            fail(CODE.RESULTS, error instanceof Error ? error.message : String(error));
          }
        }
      } else {
        fail(CODE.RESULTS, `${command.id}: machine result is not a test report`);
      }
      if (resultsClosed && !structural && row.code !== 0) {
        fail(CODE.SUPERVISOR, `${command.id} exited ${row.code} after a closed result`);
      }
    }
  }

  report.offlineGuard = readGuardReport(guardReportFile);
  if (report.offlineGuard.attempts > 0) {
    const first = report.offlineGuard.entries[0] ?? {};
    fail(CODE.NETWORK, `${report.offlineGuard.attempts} non-loopback network attempt(s) were recorded; first: ${first.api ?? "unknown api"} to ${first.host ?? "unknown host"}${first.port ? `:${first.port}` : ""}`);
  }

  let after = null;
  try {
    after = await gitSnapshot(repoRoot);
  } catch {
    after = null;
  }
  const changed = differingGitFields(before, after);
  if (changed.length > 0) fail(CODE.FOREIGN_GIT, `the repository's Git state changed during the run (${changed.join(", ")}); a proof run must not touch the checkout`);

  report.failures = failures.map((failure) => ({ ...failure, detail: redact(failure.detail) }));
  const primary = REFUSAL_PRECEDENCE.map((code) => report.failures.find((failure) => failure.code === code)).find(Boolean) ?? null;
  report.refusal = primary;
  report.passed = failures.length === 0;

  if (report.passed) {
    try {
      await rm(scratchRoot, { recursive: true, force: true });
      report.scratch.cleanup = "removed-on-pass";
    } catch (error) {
      report.scratch.cleanup = `removal-failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  await writeFile(path.join(proofRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`);

  for (const row of report.perCommand) {
    log(`ccc-planning-proof: ${row.id}: ${row.passed} passed${row.expected === null ? "" : ` of ${row.expected} expected`}, ${row.skipped} skipped, ${row.failed} failed${row.timedOut ? ", TIMED OUT" : ""}`);
  }
  if (report.passed) log(`ccc-planning-proof: passed; report ${path.join(proofRoot, "report.json")}`);
  else log(`ccc-planning-proof: FAILED (${report.refusal?.code}): ${report.refusal?.detail}; preserved ${proofRoot}`);
  return { exitCode: report.passed ? 0 : 1, report };
}

export async function main(argv = process.argv.slice(2)) {
  const parsed = parseCccPlanningProofArgs(argv);
  if (parsed.usageError !== undefined) {
    process.stderr.write(`${JSON.stringify({ schema: "ccc-planning.proof-refusal.v1", code: CODE.USAGE, detail: parsed.usageError, usage: "node scripts/run-ccc-planning-proof.mjs --mode <targeted|offline|ci-linux>" })}\n`);
    return 2;
  }
  const outcome = await runCccPlanningProof({ mode: parsed.mode, env: process.env, platform: process.platform });
  if (outcome.report.refusal) {
    process.stderr.write(`${JSON.stringify({ schema: "ccc-planning.proof-refusal.v1", code: outcome.report.refusal.code, detail: outcome.report.refusal.detail })}\n`);
  }
  return outcome.exitCode;
}

function isEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  process.exitCode = await main();
}
