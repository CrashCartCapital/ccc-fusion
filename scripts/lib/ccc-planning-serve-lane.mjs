// port-4040-allowlist: this module refuses port 4040 (FORBIDDEN_PORT) and never binds or kills it; every mention is that refusal or its documentation.
/*
FNXC:CccPlanningServeLane 2026-10-14-19:00:
Serve lane for the planning proof (card IP, CONTRACT-v3.3 section 4.2 step 5a, D26, ADR D Q2 decision 4). It launches the installed `fn serve` under a dedicated Pueue group and proves, from the serve log and the kernel, that exactly one serve bound exactly one loopback port that is not 4040:
- The Pueue payload is `echo pid=$$; cd <target> && exec /usr/bin/env -i ... fn serve --port 0 --host 127.0.0.1 --no-auto-register --project <id>`. `env -i` keeps every inherited credential out and removes `PORT`, which serve would otherwise substitute for `--port 0`; `--no-auto-register` plus the target as the working directory stops the cwd auto-registration that let self-healing sweep `.worktrees/`; the announced `$$` survives the exec chain, so the pid is the serve process and its process group is the Pueue task's.
- Pueue copies the caller's environment into the task, so every Pueue client call gets a scrubbed environment too.
- Liveness is the log: one `HTTP layer bound to project <name> (<projectId>)` line, one listening banner on 127.0.0.1, no `Auto-registered` line and a port that is not 4040. A listener check (`lsof` on that pid) must then show the announced port on loopback and no non-loopback listener.
- Teardown kills only the named Pueue task, then looks for survivors by process group and refuses (no second signal) if any remain.
The PostgreSQL helper starts an owned, TCP-only cluster on a kernel-chosen port that is neither 5432 nor 4040. Every external command goes through an injectable `run`, so the sequence is proved against a fake host; the real shapes of `pueue group --json`, `pueue add --print-task-id`, `pueue log --json --full <id>` and `pueue kill` were read from the installed Pueue 4.0.4 in a throwaway group.
*/
import { execFile } from "node:child_process";
import { mkdir, readdir } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { URL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const FORBIDDEN_PORT = 4040;
const SHARED_PG_PORT = 5432;
const LANE_PID_PREFIX = "ccc-planning-serve-lane pid=";
const DEFAULT_START_TIMEOUT_MS = 180_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_STOP_TIMEOUT_MS = 10_000;
const STOP_POLL_INTERVAL_MS = 250;
/** A hang bound for one external command (pueue, lsof, pgrep, initdb, pg_ctl), not a measured duration. */
const COMMAND_TIMEOUT_MS = 120_000;
const PUEUE_ENV_NAMES = Object.freeze(["PATH", "HOME", "LANG", "LC_ALL", "TZ", "USER", "LOGNAME", "TMPDIR", "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "PUEUE_CONFIG_PATH"]);

export class CccPlanningServeLaneError extends Error {
  constructor(code, field, detail) {
    super(`${code}: ${detail}`);
    this.name = "CccPlanningServeLaneError";
    this.code = code;
    this.field = field;
  }
}

const launchInvalid = (field, detail) => new CccPlanningServeLaneError("CCC_PLANNING_SERVE_LAUNCH_INVALID", field, detail);
const pgFailed = (field, detail) => new CccPlanningServeLaneError("CCC_PLANNING_SERVE_PG_FAILED", field, detail);

/** The log verdict the lane needs, in the order the failures must win: auto-registration, a doubled binding, a forbidden port, then "not bound yet". */
export function parseCccPlanningServeLog(log, projectId) {
  const lines = String(log).replaceAll("\r\n", "\n").split("\n");
  if (lines.some((line) => /^\[serve\] Auto-registered project\b/u.test(line))) {
    return { ok: false, code: "CCC_PLANNING_SERVE_AUTO_REGISTERED" };
  }
  let bound = 0;
  const banners = [];
  for (const line of lines) {
    const boundMatch = /^\[serve\] HTTP layer bound to project .*\(([^()\s]+)\)(?: \[source: [^\]]*\])?\s*$/u.exec(line);
    if (boundMatch && boundMatch[1] === projectId) bound += 1;
    const bannerMatch = /^\s*→ http:\/\/([^:\s/]+):(\d+)\s*$/u.exec(line);
    if (bannerMatch) banners.push({ host: bannerMatch[1], port: Number(bannerMatch[2]) });
  }
  if (bound > 1 || banners.length > 1) return { ok: false, code: "CCC_PLANNING_SERVE_MULTIPLE_BINDINGS" };
  if (banners.some((banner) => banner.port === FORBIDDEN_PORT || banner.port === 0)) {
    return { ok: false, code: "CCC_PLANNING_SERVE_PORT_FORBIDDEN" };
  }
  if (bound === 0 || banners.length === 0 || banners[0].host !== "127.0.0.1") {
    return { ok: false, code: "CCC_PLANNING_SERVE_NOT_BOUND" };
  }
  return { ok: true, port: banners[0].port };
}

/** The pid the launch payload prints before it execs; two pid lines or a malformed one is no pid. */
export function parseCccPlanningServePid(log) {
  const pids = [];
  for (const line of String(log).replaceAll("\r\n", "\n").split("\n")) {
    if (!line.startsWith(LANE_PID_PREFIX)) continue;
    const digits = line.slice(LANE_PID_PREFIX.length).trimEnd();
    pids.push(/^[1-9]\d*$/u.test(digits) ? Number(digits) : null);
  }
  return pids.length === 1 && Number.isSafeInteger(pids[0]) ? pids[0] : null;
}

function hasControlCharacter(value) {
  for (const char of value) {
    const code = char.codePointAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function assertAbsolutePath(field, value) {
  if (typeof value !== "string" || !path.isAbsolute(value) || hasControlCharacter(value)) {
    throw launchInvalid(field, `${field} must be an absolute path without control characters`);
  }
}

function assertSafeName(field, value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)) {
    throw launchInvalid(field, `${field} must be letters, digits, dot, underscore or dash`);
  }
}

function assertOwnedDatabaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw launchInvalid("databaseUrl", "databaseUrl is not a URL");
  }
  const port = Number(url.port);
  const owned = (url.protocol === "postgresql:" || url.protocol === "postgres:")
    && url.hostname === "127.0.0.1"
    && url.port !== ""
    && Number.isInteger(port) && port > 1023 && port !== SHARED_PG_PORT && port !== FORBIDDEN_PORT
    && url.password === ""
    && url.search === "" && url.hash === ""
    && /^\/[A-Za-z0-9_-]+$/u.test(url.pathname);
  if (!owned) {
    throw launchInvalid("databaseUrl", "databaseUrl must name a password-free PostgreSQL on 127.0.0.1 with an owned port (not 5432, not 4040)");
  }
}

/** The Pueue command for the installed serve: one shell string, sealed environment, loopback only. Validates before it builds. */
export function buildCccPlanningServeLaunch(input) {
  for (const field of ["executablePath", "targetDir", "home", "tmpDir"]) assertAbsolutePath(field, input[field]);
  if (typeof input.pathEnv !== "string" || input.pathEnv === "" || hasControlCharacter(input.pathEnv)) {
    throw launchInvalid("pathEnv", "pathEnv must be a non-empty single-line PATH value");
  }
  assertSafeName("group", input.group);
  assertSafeName("label", input.label);
  if (typeof input.projectId !== "string" || !/^[A-Za-z0-9_-]+$/u.test(input.projectId)) {
    throw launchInvalid("projectId", "projectId must be letters, digits, underscore or dash");
  }
  assertOwnedDatabaseUrl(input.databaseUrl);
  const payload = [
    `echo "${LANE_PID_PREFIX}$$"; `,
    `cd ${shellQuote(input.targetDir)} && exec /usr/bin/env -i `,
    `PATH=${shellQuote(input.pathEnv)} `,
    `HOME=${shellQuote(input.home)} `,
    `FUSION_HOME=${shellQuote(`${input.home}/.fusion`)} `,
    `DATABASE_URL=${shellQuote(input.databaseUrl)} `,
    "NO_COLOR=1 LANG=en_US.UTF-8 ",
    `TMPDIR=${shellQuote(input.tmpDir)} `,
    "PI_OFFLINE=1 ",
    `${shellQuote(input.executablePath)} serve --port 0 --host 127.0.0.1 --no-auto-register --project ${input.projectId}`,
  ].join("");
  return {
    argv: ["pueue", "add", "--group", input.group, "--label", input.label, "--working-directory", input.targetDir, "--print-task-id", "--", payload],
    cwd: input.targetDir,
  };
}

function scrubbedEnv(names) {
  return Object.fromEntries(names.filter((name) => typeof process.env[name] === "string").map((name) => [name, process.env[name]]));
}

async function defaultRun(argv, options = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(argv[0], argv.slice(1), {
      env: options.env ?? scrubbedEnv(PUEUE_ENV_NAMES),
      cwd: options.cwd,
      maxBuffer: 64 * 1024 * 1024,
      timeout: COMMAND_TIMEOUT_MS,
    });
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    if (typeof error?.code === "number") return { exitCode: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
    throw error;
  }
}

async function defaultPickPort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

/** Start an owned, TCP-only PostgreSQL cluster on a free loopback port; `stop()` stops that cluster once and is a no-op afterwards. */
export async function startOwnedPostgres(input, deps = {}) {
  const run = deps.run ?? defaultRun;
  const pickPort = deps.pickPort ?? defaultPickPort;
  for (const field of ["dataDir", "pgBin", "logPath"]) {
    if (typeof input[field] !== "string" || !path.isAbsolute(input[field])) throw pgFailed(field, `${field} must be an absolute path`);
  }
  const port = await pickPort();
  if (!Number.isInteger(port) || port <= 1023 || port === SHARED_PG_PORT || port === FORBIDDEN_PORT) {
    throw pgFailed("port", `refusing PostgreSQL port ${port}: it must be above 1023 and neither ${SHARED_PG_PORT} nor ${FORBIDDEN_PORT}`);
  }
  let entries = [];
  try {
    entries = await readdir(input.dataDir);
  } catch (error) {
    if (error?.code !== "ENOENT") throw pgFailed("dataDir", `cannot read ${input.dataDir}: ${error.message}`);
  }
  if (entries.length > 0) throw pgFailed("dataDir", `refusing a data directory that already holds files: ${input.dataDir}`);
  await mkdir(path.dirname(input.logPath), { recursive: true });
  const bin = (name) => path.join(input.pgBin, name);
  const stopArgv = [bin("pg_ctl"), "-D", input.dataDir, "-m", "fast", "-w", "stop"];
  const checked = async (argv, what) => {
    const result = await run(argv);
    if (result.exitCode !== 0) throw pgFailed(what, `${what} exited ${result.exitCode}: ${String(result.stderr).trim()}`);
  };
  await checked([bin("initdb"), "-D", input.dataDir, "-U", "postgres", "--auth=trust", "-E", "UTF8", "--no-locale"], "initdb");
  try {
    await checked([
      bin("pg_ctl"), "-D", input.dataDir, "-l", input.logPath, "-w",
      "-o", `-c unix_socket_directories= -c listen_addresses=127.0.0.1 -c max_connections=200 -p ${port}`,
      "start",
    ], "pg_ctl start");
    await checked([bin("createdb"), "-h", "127.0.0.1", "-p", String(port), "-U", "postgres", "fusion"], "createdb");
  } catch (error) {
    await run(stopArgv).catch(() => undefined);
    throw error;
  }
  let stopped = false;
  return {
    port,
    databaseUrl: `postgresql://postgres@127.0.0.1:${port}/fusion`,
    async stop() {
      if (stopped) return;
      stopped = true;
      const result = await run(stopArgv);
      if (result.exitCode !== 0) throw pgFailed("pg_ctl stop", `pg_ctl stop exited ${result.exitCode}: ${String(result.stderr).trim()}`);
    },
  };
}

function defaultDeps(deps) {
  return {
    run: deps.run ?? defaultRun,
    now: deps.now ?? (() => Date.now()),
    sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  };
}

function taskStatusName(status) {
  if (typeof status === "string") return status;
  if (status && typeof status === "object") return Object.keys(status)[0] ?? "";
  return "";
}

async function killTask(run, pueueTaskId, env) {
  return run(["pueue", "kill", String(pueueTaskId)], { env });
}

async function ensureGroup(run, group, env) {
  const listing = await run(["pueue", "group", "--json"], { env });
  if (listing.exitCode !== 0) throw new CccPlanningServeLaneError("CCC_PLANNING_SERVE_TASK_FAILED", "group", `pueue group --json exited ${listing.exitCode}: ${String(listing.stderr).trim()}`);
  let groups;
  try {
    groups = JSON.parse(listing.stdout);
  } catch (error) {
    throw new CccPlanningServeLaneError("CCC_PLANNING_SERVE_TASK_FAILED", "group", `pueue group --json was not JSON: ${error.message}`);
  }
  if (!Object.hasOwn(groups, group)) {
    const added = await run(["pueue", "group", "add", group], { env });
    if (added.exitCode !== 0) throw new CccPlanningServeLaneError("CCC_PLANNING_SERVE_TASK_FAILED", "group", `pueue group add exited ${added.exitCode}: ${String(added.stderr).trim()}`);
    const capped = await run(["pueue", "parallel", "1", "--group", group], { env });
    if (capped.exitCode !== 0) throw new CccPlanningServeLaneError("CCC_PLANNING_SERVE_TASK_FAILED", "group", `pueue parallel exited ${capped.exitCode}: ${String(capped.stderr).trim()}`);
    return;
  }
  if (groups[group]?.status !== "Running") throw launchInvalid("group", `the existing Pueue group ${group} is not running, so its task would never start`);
  if (groups[group]?.parallel_tasks !== 1) {
    const capped = await run(["pueue", "parallel", "1", "--group", group], { env });
    if (capped.exitCode !== 0) throw new CccPlanningServeLaneError("CCC_PLANNING_SERVE_TASK_FAILED", "group", `pueue parallel exited ${capped.exitCode}: ${String(capped.stderr).trim()}`);
  }
}

function listenersOf(lsofOutput) {
  return String(lsofOutput).split("\n").filter((line) => line.startsWith("n")).map((line) => line.slice(1).trim());
}

function loopbackAddress(address) {
  return /^(?:127\.0\.0\.1|\[::1\]):\d+$/u.test(address);
}

/**
 * Create the group if it is absent, add the serve task, then poll its Pueue log until the bound line and banner appear.
 * Any refusal after the task exists kills that one task id before it throws.
 */
export async function startCccPlanningServeLane(input, deps = {}) {
  const { run, now, sleep } = defaultDeps(deps);
  const launch = buildCccPlanningServeLaunch(input);
  const timeoutMs = input.timeoutMs ?? DEFAULT_START_TIMEOUT_MS;
  const pollIntervalMs = input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const env = scrubbedEnv(PUEUE_ENV_NAMES);
  await ensureGroup(run, input.group, env);
  const added = await run(launch.argv, { env });
  const pueueTaskId = Number(String(added.stdout).trim());
  if (added.exitCode !== 0 || !Number.isInteger(pueueTaskId) || pueueTaskId <= 0) {
    throw new CccPlanningServeLaneError("CCC_PLANNING_SERVE_TASK_FAILED", "pueueTaskId", `pueue add exited ${added.exitCode} and printed ${JSON.stringify(String(added.stdout).trim())}: ${String(added.stderr).trim()}`);
  }
  const refuse = async (code, field, detail) => {
    await killTask(run, pueueTaskId, env);
    throw new CccPlanningServeLaneError(code, field, detail);
  };
  const deadline = now() + timeoutMs;
  for (;;) {
    const logResult = await run(["pueue", "log", "--json", "--full", String(pueueTaskId)], { env });
    let task = null;
    let output = "";
    try {
      const parsed = JSON.parse(logResult.stdout);
      task = parsed[String(pueueTaskId)]?.task ?? null;
      output = String(parsed[String(pueueTaskId)]?.output ?? "");
    } catch {
      // an unreadable log is "not bound yet" until the deadline
    }
    const verdict = parseCccPlanningServeLog(output, input.projectId);
    if (verdict.ok) {
      const pid = parseCccPlanningServePid(output);
      if (pid === null) await refuse("CCC_PLANNING_SERVE_TASK_FAILED", "pid", "the serve log carries no single pid line, so the listener cannot be tied to the task");
      const lsof = await run(["lsof", "-b", "-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN", "-Fn"], { env });
      const listeners = lsof.exitCode === 0 ? listenersOf(lsof.stdout) : [];
      if (!listeners.includes(`127.0.0.1:${verdict.port}`) || !listeners.every(loopbackAddress)) {
        await refuse("CCC_PLANNING_SERVE_LISTENER_MISMATCH", "port", `pid ${pid} listens on ${JSON.stringify(listeners)}, not only on loopback including 127.0.0.1:${verdict.port}`);
      }
      return { pueueTaskId, port: verdict.port, pid };
    }
    if (verdict.code !== "CCC_PLANNING_SERVE_NOT_BOUND") {
      await refuse(verdict.code, "log", `the serve log was refused: ${verdict.code}`);
    }
    const status = taskStatusName(task?.status);
    if (status === "Done") {
      throw new CccPlanningServeLaneError("CCC_PLANNING_SERVE_TASK_FAILED", "task", `the serve task ended before it bound a port; last log lines: ${output.trim().split("\n").slice(-3).join(" | ")}`);
    }
    if (now() >= deadline) {
      await refuse("CCC_PLANNING_SERVE_NOT_BOUND", "log", `no bound line and banner within ${timeoutMs} ms`);
    }
    await sleep(pollIntervalMs);
  }
}

/** Kill the named Pueue task only, then require that no process of its group remains. Sends no second signal. */
export async function stopCccPlanningServeLane(lane, deps = {}) {
  if (!Number.isInteger(lane?.pueueTaskId) || lane.pueueTaskId <= 0) throw launchInvalid("pueueTaskId", "pueueTaskId must be a positive integer");
  if (!Number.isInteger(lane?.pid) || lane.pid <= 1) throw launchInvalid("pid", "pid must be an integer above 1");
  const { run, now, sleep } = defaultDeps(deps);
  const env = scrubbedEnv(PUEUE_ENV_NAMES);
  const killed = await killTask(run, lane.pueueTaskId, env);
  const deadline = now() + (deps.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS);
  for (;;) {
    const group = await run(["pgrep", "-g", String(lane.pid)], { env });
    const remaining = group.exitCode === 0 ? String(group.stdout).split("\n").filter(Boolean) : [];
    if (remaining.length === 0) return { stopped: true, descendantsRemaining: 0 };
    if (now() >= deadline) {
      throw new CccPlanningServeLaneError("CCC_PLANNING_SERVE_DESCENDANTS_REMAIN", "pid", `${remaining.length} process(es) of group ${lane.pid} remain after pueue kill ${lane.pueueTaskId} (exit ${killed.exitCode}): ${remaining.join(",")}`);
    }
    await sleep(STOP_POLL_INTERVAL_MS);
  }
}
