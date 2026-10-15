#!/usr/bin/env node
/*
FNXC:CccPlanningDisposableTarget 2026-10-15-00:43:
Builder for the I2 owned disposable target (card AU4; CONTRACT-v3.5 section 4.1 and section 4.2 step 2; ADR D Q4; D24). Section 4.2 runs `node scripts/lib/ccc-planning-disposable-target.mjs --root "$ROOT"`, so this module is also its own entry. It lays out `$ROOT` (`<scratch>/ccc-planning-i2-<tag>/`) exactly as section 4.1 lists it:
- `target/`: `git init -b main`, local identity, no remote, one baseline commit B0 holding only `package.json`, `README.md`, `.gitignore` and `Taskfile.yml`. The verifier bundle (B1) is VP's, never written here.
- `owner.json` (`ccc-planning.disposable-target-owner.v1`: schema, the target's realpath, a 32-hex nonce, a creation time), written LAST so a build that fails midway leaves a root nothing will admit. Its SHA-256 is what the receipt carries.
- `request/request.md`: ADR D's sealed four-part request, verbatim; its SHA-256 and byte length go into the receipt.
- `home/.fusion/settings.json`: three pinned custom providers on the loopback OmniRoute URL (`modelSync: "disabled"`, the `X-OmniRoute-No-Cache` header, one model each, no apiKey) and `openrouterModelSync` / `opencodeGoModelSync` false. The model ids are read from K1's role policy in core's dist, never typed here; this module reads and writes no credential.
- `install/`, `pg/`, `tmp/`, `authority/`, `evidence/`, created empty. Step 1 (the installed-runtime script) runs first and has already filled `install/`, `evidence/` and parts of `home/`, so those directories may exist; the build refuses only when it would overwrite something it owns (`owner.json`, `target/`, `request/`, `authority/`, a non-empty `pg/`, `home/.fusion/settings.json`). A failed build is never cleaned up here (the rm guard drops recursive deletes without a terminal): move the root to `.archive/` and use a new tag.
- The owned PostgreSQL (TCP-only, a kernel-chosen loopback port that is never 5432 or 4040) is provisioned only with `--provision-postgres`, because starting a server is a side effect that a layout build should not have by default; section 4.2 step 2 therefore needs that flag. The default run starts and stops nothing.

Refusals are `CccPlanningDisposableTargetError` with a `CCC_PLANNING_DISPOSABLE_TARGET_*` code. Nothing here deletes anything.
*/
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { access, constants, lstat, mkdir, open, readdir, realpath, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { URL, fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const defaultRepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const CCC_PLANNING_DISPOSABLE_TARGET_OWNER_SCHEMA = "ccc-planning.disposable-target-owner.v1";
export const CCC_PLANNING_DISPOSABLE_TARGET_REPORT_SCHEMA = "ccc-planning.disposable-target-report.v1";

/** The scratch root's name: `ccc-planning-i2-<tag>` (section 4.1). */
const ROOT_NAME_PATTERN = /^ccc-planning-i2-[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
/** Port 4040 is reserved on this host and 5432 is the shared PostgreSQL: neither may ever be named by anything built here. */
const FORBIDDEN_PORTS = Object.freeze([4040, 5432]);
const POSTGRES_DATABASE = "fusion";
const DEFAULT_PG_BIN_DIR = "/opt/homebrew/opt/postgresql@16/bin";
const PG_READY_ATTEMPTS = 30;
const PG_READY_DELAY_MS = 1000;

/** Directories the layout creates empty (section 4.1), `home/.fusion` and `request` included. */
const LAYOUT_DIRECTORIES = Object.freeze(["home", "install", "pg", "tmp", "request", "authority", "evidence"]);
/** Paths the build owns: it refuses when one already exists, so it can never overwrite earlier work. */
const OWNED_PATHS = Object.freeze(["owner.json", "target", "request", "authority", path.join("home", ".fusion", "settings.json"), path.join("evidence", "pg.log")]);

/**
 * The slot-to-role map that reads K1's policy: the pin for each slot is the model of the role the contract names for it
 * (section 2.7), so the ids are K1's, not typed here.
 */
const PIN_ROLES = Object.freeze({ glm53: "intent-assessor", glm53Flash: "implementation-writer", minimaxM3: "acceptance-reviewer" });
/**
 * The registry key Fusion derives from a custom provider's name is `slugifyProviderName(name)` (core
 * custom-provider-key.ts), so each name here is already its own slug: the receipt's `providerIds` are these names.
 */
export const CCC_PLANNING_DISPOSABLE_TARGET_PROVIDER_IDS = Object.freeze({
  glm53: "ccc-glm53",
  glm53Flash: "ccc-glm53-flash",
  minimaxM3: "ccc-minimax-m3",
});

/** ADR D Q4, verbatim: the sealed request. */
const SEALED_REQUEST_LINES = Object.freeze([
  "Add a small text statistics library and command-line tool to this repository.",
  "",
  "1. A shared tokenizer. `tokenize(text, options)` in `src/tokenize.mjs` returns the words of the text in order. A word is a run of Unicode letters or digits; an apostrophe between two letters stays inside the word, so \"don't\" is one word. Words are lower-cased unless `options.caseSensitive` is true. `options.minLength` (default 1) drops shorter words.",
  "2. `wordFrequency(text, options)` in `src/word-frequency.mjs` returns a `Map` from each word to how many times it appears, using the tokenizer and the same options.",
  "3. `readingTime(text, options)` in `src/reading-time.mjs` returns the whole number of minutes needed to read the text at `options.wordsPerMinute` (default 200), rounded up. Text with no words takes 0 minutes.",
  "4. `bin/text-stats.mjs` takes one file path, reads the file, and prints one JSON object: `{\"words\": <word count>, \"readingMinutes\": <minutes>, \"top\": [[word, count], ...]}` with the five most frequent words, ties broken alphabetically. With no argument, or a file it cannot read, it prints a message to standard error and exits with code 2.",
  "",
  "Each part has tests that run with `node --test`. Put the code in `src/` and `bin/` and the tests in `test/`. Do not add npm dependencies, do not change `package.json`, and do not use the network."
]);
export const CCC_PLANNING_SEALED_REQUEST = `${SEALED_REQUEST_LINES.join("\n")}\n`;

const BASELINE_PACKAGE_JSON = Object.freeze({
  name: "text-stats",
  version: "0.0.0",
  private: true,
  type: "module",
  engines: Object.freeze({ node: ">=20" }),
  scripts: Object.freeze({ test: "node --test" }),
});
/** B0 holds exactly these four files (section 4.1). */
export const CCC_PLANNING_BASELINE_FILES = Object.freeze({
  "package.json": `${JSON.stringify(BASELINE_PACKAGE_JSON, null, 2)}\n`,
  "README.md": "# text-stats\n\nDisposable target repository for the ccc-fusion request-to-code I2 proof. It starts with no source: the proof adds a small text statistics library and command-line tool.\n",
  ".gitignore": "node_modules/\n",
  "Taskfile.yml": 'version: "3"\n\ntasks:\n  test:\n    desc: Run the node test runner\n    cmds:\n      - node --test\n',
});

const GIT_IDENTITY = Object.freeze({ name: "ccc-planning disposable target", email: "disposable-target@ccc-planning.invalid" });

export class CccPlanningDisposableTargetError extends Error {
  constructor(reason, detail) {
    super(`CCC_PLANNING_DISPOSABLE_TARGET_${reason}: ${detail}`);
    this.name = "CccPlanningDisposableTargetError";
    this.code = `CCC_PLANNING_DISPOSABLE_TARGET_${reason}`;
    this.detail = detail;
  }
}

const sha256Of = (value) => createHash("sha256").update(value).digest("hex");

async function pathExists(target) {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Mirrors the engine's `validateCccLoopbackHttpUrl` (`ccc-loopback-policy.ts`, G0 step 8), which the test pins this
 * function against, and additionally refuses port 4040. Returns `{ ok, reason }`.
 */
export function validateCccPlanningOmniRouteBaseUrl(raw) {
  if (typeof raw !== "string") return { ok: false, reason: "the OmniRoute base URL must be a string" };
  const match = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})(\/[^/?#][^?#]*)$/u.exec(raw);
  if (!match) return { ok: false, reason: "the OmniRoute base URL must use literal http://127.0.0.1 with an explicit positive port and a path" };
  const port = Number(match[1]);
  if (!Number.isInteger(port) || port > 65_535) return { ok: false, reason: "the OmniRoute port must be between 1 and 65535" };
  if (FORBIDDEN_PORTS.includes(port)) return { ok: false, reason: `port ${port} is forbidden` };
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: "the OmniRoute base URL is invalid" };
  }
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || parsed.username !== "" || parsed.password !== "" || parsed.search !== "" || parsed.hash !== "") {
    return { ok: false, reason: "the OmniRoute base URL is outside the loopback boundary" };
  }
  return { ok: true };
}

/**
 * The three exact model pins, read from K1's role policy (core dist `ccc-planning/policy.js`), never typed here. Each slot
 * takes the model of the role section 2.7 names for it; every pin must classify as admitted and the policy must name
 * exactly these three models. `options.policy` replaces the dist import (tests).
 */
export async function loadCccPlanningModelPins(options = {}) {
  let policy = options.policy;
  if (policy === undefined) {
    const policyPath = path.join(options.repoRoot ?? defaultRepoRoot, "packages", "core", "dist", "ccc-planning", "policy.js");
    try {
      policy = await import(pathToFileURL(policyPath).href);
    } catch (error) {
      throw new CccPlanningDisposableTargetError("POLICY_UNAVAILABLE", `cannot import ${policyPath} (${error?.message ?? error}); run: pnpm --filter @fusion/core build`);
    }
  }
  const roles = policy?.CCC_PLANNING_ROLE_POLICY_FULL_V2?.roles;
  if (!Array.isArray(roles) || typeof policy?.classifyCccModelIdentity !== "function") {
    throw new CccPlanningDisposableTargetError("POLICY_UNAVAILABLE", "the K1 role policy and classifyCccModelIdentity are not exported by the policy module");
  }
  const pins = {};
  for (const [slot, roleId] of Object.entries(PIN_ROLES)) {
    const modelId = roles.find((role) => role?.roleId === roleId)?.modelId;
    if (typeof modelId !== "string" || policy.classifyCccModelIdentity(modelId)?.admitted !== true) {
      throw new CccPlanningDisposableTargetError("POLICY_UNAVAILABLE", `role ${roleId} does not name an admitted exact model pin`);
    }
    pins[slot] = modelId;
  }
  const policyModels = new Set(roles.map((role) => role?.modelId));
  const pinned = new Set(Object.values(pins));
  if (pinned.size !== 3 || policyModels.size !== 3 || [...policyModels].some((modelId) => !pinned.has(modelId))) {
    throw new CccPlanningDisposableTargetError("POLICY_UNAVAILABLE", "the K1 role policy does not name exactly the three pinned models");
  }
  return Object.freeze(pins);
}

/** The home settings of section 4.2 step 2 as an object; `buildCccPlanningDisposableTarget` serializes it. */
export function buildCccPlanningDisposableTargetSettings({ omniRouteBaseUrl, pins }) {
  const customProviders = Object.keys(PIN_ROLES).map((slot) => {
    const name = CCC_PLANNING_DISPOSABLE_TARGET_PROVIDER_IDS[slot];
    return {
      id: name,
      name,
      apiType: "openai-compatible",
      baseUrl: omniRouteBaseUrl,
      headers: { "X-OmniRoute-No-Cache": "true" },
      modelSync: "disabled",
      models: [{ id: pins[slot], name: `CCC planning ${pins[slot]}` }],
    };
  });
  return { openrouterModelSync: false, opencodeGoModelSync: false, customProviders };
}

// ---------------------------------------------------------------- PostgreSQL

function assertAllowedPort(port) {
  if (!Number.isInteger(port) || port < 1024 || port > 65_535 || FORBIDDEN_PORTS.includes(port)) {
    throw new CccPlanningDisposableTargetError("PORT_FORBIDDEN", `port ${String(port)} cannot be used (an unprivileged port other than ${FORBIDDEN_PORTS.join(" and ")} is required)`);
  }
}

/**
 * The argv of every PostgreSQL command, as the Darwin-lane recipe runs them (`full-suite.yml`, "Start a disposable
 * PostgreSQL"): TCP-only on 127.0.0.1, no Unix socket, `pg_ctl -D <pg> -m fast stop` for teardown. Pure: starts nothing.
 */
export function cccPlanningDisposablePostgresCommands({ pgBinDir, dataDir, logPath, port }) {
  assertAllowedPort(port);
  const bin = (name) => path.join(pgBinDir, name);
  return Object.freeze({
    initdb: { file: bin("initdb"), args: ["-D", dataDir, "-U", "postgres", "-A", "trust", "--no-locale", "-E", "UTF8"] },
    start: { file: bin("pg_ctl"), args: ["-D", dataDir, "-o", `-p ${port} -c listen_addresses=127.0.0.1 -c unix_socket_directories=`, "-l", logPath, "start"] },
    ready: { file: bin("pg_isready"), args: ["-h", "127.0.0.1", "-p", String(port), "-U", "postgres"] },
    createdb: { file: bin("createdb"), args: ["-h", "127.0.0.1", "-p", String(port), "-U", "postgres", POSTGRES_DATABASE] },
    stop: { file: bin("pg_ctl"), args: ["-D", dataDir, "-m", "fast", "stop"] },
  });
}

/** A kernel-chosen loopback port that is not 5432 or 4040 (the listener is closed again before it returns). */
export async function pickCccPlanningFreeLoopbackPort({ attempts = 10 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const port = await new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        server.close(() => resolve(typeof address === "object" && address !== null ? address.port : 0));
      });
    });
    if (Number.isInteger(port) && port >= 1024 && !FORBIDDEN_PORTS.includes(port)) return port;
  }
  throw new CccPlanningDisposableTargetError("PORT_FORBIDDEN", `no loopback port other than ${FORBIDDEN_PORTS.join(" and ")} was offered in ${attempts} attempts`);
}

/** No `PG*` variable and nothing else from the caller: a command must never reach a server other than the one named by its own flags. */
function postgresEnvironment(root) {
  return { PATH: process.env.PATH ?? "", HOME: path.join(root, "home"), LANG: "C", LC_ALL: "C" };
}

async function defaultPostgresRun(file, args, environment) {
  return execFileAsync(file, args, { env: environment, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 120_000 });
}

function postgresRunner(root, run) {
  return run ?? ((file, args) => defaultPostgresRun(file, args, postgresEnvironment(root)));
}

/** FNXC:CccPlanningDisposableTarget 2026-10-15-05:08: A failed startup or seal must relinquish only its own cluster; teardown failure remains visible alongside the original failure. */
async function failAfterPostgresCleanup(error, stop) {
  try {
    await stop();
  } catch (stopError) {
    const failure = new CccPlanningDisposableTargetError("POSTGRES_CLEANUP_FAILED", `${error?.message ?? String(error)}; owned PostgreSQL teardown failed: ${stopError?.message ?? String(stopError)}`);
    failure.cause = error;
    throw failure;
  }
  throw error;
}

/**
 * initdb, start, wait until ready, create the database. When anything after `start` fails the server this call started
 * is stopped again (only its own data directory), then the error is rethrown. Returns what step 3 and step 6 need.
 */
export async function provisionCccPlanningDisposablePostgres({ root, pgBinDir = DEFAULT_PG_BIN_DIR, run, pickPort, sleep, binariesPresent } = {}) {
  const dataDir = path.join(root, "pg");
  const logPath = path.join(root, "evidence", "pg.log");
  const exec = postgresRunner(root, run);
  const wait = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const choosePort = pickPort ?? (() => pickCccPlanningFreeLoopbackPort());

  const present = binariesPresent ?? (async (files) => {
    for (const file of files) {
      try {
        await access(file, constants.X_OK);
      } catch {
        return file;
      }
    }
    return null;
  });
  const names = ["initdb", "pg_ctl", "pg_isready", "createdb"].map((name) => path.join(pgBinDir, name));
  const missing = await present(names);
  if (missing !== null && missing !== undefined) {
    throw new CccPlanningDisposableTargetError("POSTGRES_FAILED", `${String(missing)} is not an executable; pass --pg-bin <dir of the PostgreSQL 16 binaries>`);
  }

  const port = await choosePort();
  const commands = cccPlanningDisposablePostgresCommands({ pgBinDir, dataDir, logPath, port });
  /*
  FNXC:CccPlanningDisposableTarget 2026-10-15-05:25:
  AU4 repair 2: pg_ctl follows its log path, so reserve this owned leaf exclusively before initdb or startup. wx refuses a file or symlink created after the layout preflight; failure leaves every PostgreSQL command uncalled.
  */
  try {
    const log = await open(logPath, "wx", 0o600);
    await log.close();
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new CccPlanningDisposableTargetError("EXISTS", `${logPath} already exists; the owned PostgreSQL log must be a fresh file`);
    }
    throw error;
  }
  await exec(commands.initdb.file, commands.initdb.args);
  try {
    // pg_ctl can start the server and still report failure (for example, a readiness timeout).
    await exec(commands.start.file, commands.start.args);
    let ready = false;
    for (let attempt = 0; attempt < PG_READY_ATTEMPTS && !ready; attempt += 1) {
      try {
        await exec(commands.ready.file, commands.ready.args);
        ready = true;
      } catch {
        await wait(PG_READY_DELAY_MS);
      }
    }
    if (!ready) throw new CccPlanningDisposableTargetError("POSTGRES_FAILED", `the owned PostgreSQL on 127.0.0.1:${port} never became ready; see ${logPath}`);
    await exec(commands.createdb.file, commands.createdb.args);
  } catch (error) {
    await failAfterPostgresCleanup(error, () => exec(commands.stop.file, commands.stop.args));
  }
  return { dataDir, logPath, port, databaseUrl: `postgresql://postgres@127.0.0.1:${port}/${POSTGRES_DATABASE}`, pgBinDir };
}

// ---------------------------------------------------------------- the target

function gitEnvironment(root) {
  return {
    PATH: process.env.PATH ?? "",
    HOME: path.join(root, "home"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    LANG: "C",
    LC_ALL: "C",
  };
}

async function git(root, cwd, args) {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, env: gitEnvironment(root), encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 60_000 });
    return stdout;
  } catch (error) {
    throw new CccPlanningDisposableTargetError("GIT_FAILED", `git ${args.join(" ")} failed in ${cwd}: ${error?.stderr?.trim?.() || error?.message || error}`);
  }
}

/** git exits 128 for "not a git repository"; any other failure proves nothing about nesting. */
async function insideAnotherRepository(root) {
  try {
    await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd: root, env: gitEnvironment(root), encoding: "utf8", timeout: 60_000 });
    return true;
  } catch (error) {
    if (error?.code === 128) return false;
    throw new CccPlanningDisposableTargetError("GIT_FAILED", `git rev-parse --show-toplevel failed in ${root} with ${String(error?.code)}: ${error?.stderr?.trim?.() || error?.message || error}`);
  }
}

function preflight(root, { pins, omniRouteBaseUrl }) {
  if (typeof root !== "string" || !path.isAbsolute(root)) {
    throw new CccPlanningDisposableTargetError("ROOT_INVALID", "--root must be an absolute path");
  }
  if (!ROOT_NAME_PATTERN.test(path.basename(path.resolve(root)))) {
    throw new CccPlanningDisposableTargetError("ROOT_INVALID", `the scratch root must be named ccc-planning-i2-<tag> (section 4.1), got ${path.basename(path.resolve(root))}`);
  }
  const url = validateCccPlanningOmniRouteBaseUrl(omniRouteBaseUrl);
  if (!url.ok) throw new CccPlanningDisposableTargetError("OMNIROUTE_URL_INVALID", url.reason);
  if (pins === undefined) throw new CccPlanningDisposableTargetError("POLICY_UNAVAILABLE", "the model pins are required");
}

async function assertNothingOwnedExists(root) {
  if (!(await pathExists(root))) return;
  for (const owned of OWNED_PATHS) {
    if (await pathExists(path.join(root, owned))) {
      throw new CccPlanningDisposableTargetError("EXISTS", `${path.join(root, owned)} already exists; the build never overwrites it (move the root to .archive/ and use a new tag)`);
    }
  }
  const pgDir = path.join(root, "pg");
  if ((await pathExists(pgDir)) && (await readdir(pgDir)).length > 0) {
    throw new CccPlanningDisposableTargetError("EXISTS", `${pgDir} is not empty; the build never overwrites it`);
  }
}

/** FNXC:CccPlanningDisposableTarget 2026-10-15-05:08: Existing layout directories cannot redirect this builder's writes outside its scratch root, including through a dangling symlink. Run before the first write. */
async function assertExistingLayoutDirectories(root) {
  for (const directory of [root, ...LAYOUT_DIRECTORIES.map((name) => path.join(root, name)), path.join(root, "home", ".fusion")]) {
    let entry;
    try {
      entry = await lstat(directory);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new CccPlanningDisposableTargetError("ROOT_INVALID", `${directory} must be a real directory, never a symlink or another file type`);
    }
  }
}

/**
 * Builds the target and returns the report the parent turns into the receipt's `target` and `request` fields.
 * @param {{ root: string, omniRouteBaseUrl: string, pins: { glm53: string, glm53Flash: string, minimaxM3: string },
 *   provisionPostgres?: boolean, postgres?: object, clock?: () => Date }} options
 */
export async function buildCccPlanningDisposableTarget(options) {
  const { omniRouteBaseUrl, pins, provisionPostgres = false, postgres = {}, clock = () => new Date() } = options;
  preflight(options.root, { pins, omniRouteBaseUrl });
  const root = path.resolve(options.root);
  await assertExistingLayoutDirectories(root);
  await assertNothingOwnedExists(root);

  // The nested check runs before anything is created: from the root if it exists, else from its nearest existing ancestor.
  let probe = root;
  while (!(await pathExists(probe))) probe = path.dirname(probe);
  const probeRealpath = await realpath(probe);
  if (await insideAnotherRepository(probeRealpath)) {
    throw new CccPlanningDisposableTargetError("NESTED", `${probeRealpath} is inside another git repository; the target must not be nested`);
  }

  await mkdir(root, { recursive: true });
  const scratchRoot = await realpath(root);

  const directories = {};
  for (const name of LAYOUT_DIRECTORIES) {
    directories[name] = path.join(scratchRoot, name);
    await mkdir(directories[name], { recursive: true, ...(name === "pg" ? { mode: 0o700 } : {}) });
  }
  await mkdir(path.join(scratchRoot, "home", ".fusion"), { recursive: true });

  // target/: git init, local identity, no remote, baseline B0.
  const repositoryPath = path.join(scratchRoot, "target");
  await mkdir(repositoryPath);
  const repositoryRealpath = await realpath(repositoryPath);
  await git(scratchRoot, repositoryRealpath, ["init", "-b", "main"]);
  await git(scratchRoot, repositoryRealpath, ["config", "user.name", GIT_IDENTITY.name]);
  await git(scratchRoot, repositoryRealpath, ["config", "user.email", GIT_IDENTITY.email]);
  for (const [name, content] of Object.entries(CCC_PLANNING_BASELINE_FILES)) {
    await writeFile(path.join(repositoryRealpath, name), content, "utf8");
  }
  await git(scratchRoot, repositoryRealpath, ["add", "--", ...Object.keys(CCC_PLANNING_BASELINE_FILES)]);
  await git(scratchRoot, repositoryRealpath, ["commit", "-m", "baseline B0: text-stats"]);
  const baseCommit = (await git(scratchRoot, repositoryRealpath, ["rev-parse", "HEAD"])).trim();
  const baseTree = (await git(scratchRoot, repositoryRealpath, ["rev-parse", "HEAD^{tree}"])).trim();
  const remotes = (await git(scratchRoot, repositoryRealpath, ["remote"])).trim();
  const status = (await git(scratchRoot, repositoryRealpath, ["status", "--porcelain", "-uall"])).trim();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(baseCommit) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(baseTree) || remotes !== "" || status !== "") {
    throw new CccPlanningDisposableTargetError("GIT_FAILED", "the baseline repository is not a clean one-commit repository without a remote");
  }

  // request/request.md
  const requestPath = path.join(scratchRoot, "request", "request.md");
  const requestBytes = Buffer.from(CCC_PLANNING_SEALED_REQUEST, "utf8");
  await writeFile(requestPath, requestBytes);

  // home/.fusion/settings.json
  const settingsPath = path.join(scratchRoot, "home", ".fusion", "settings.json");
  const settingsBytes = Buffer.from(`${JSON.stringify(buildCccPlanningDisposableTargetSettings({ omniRouteBaseUrl, pins }), null, 2)}\n`, "utf8");
  await writeFile(settingsPath, settingsBytes);

  // The owned PostgreSQL, only when asked.
  const provisioned = provisionPostgres ? await provisionCccPlanningDisposablePostgres({ ...postgres, root: scratchRoot }) : null;

  // owner.json last: the seal.
  try {
    const ownerPath = path.join(scratchRoot, "owner.json");
    const ownerBytes = Buffer.from(`${JSON.stringify({
      schema: CCC_PLANNING_DISPOSABLE_TARGET_OWNER_SCHEMA,
      repositoryRealpath,
      nonce: randomBytes(16).toString("hex"),
      createdAt: clock().toISOString(),
    }, null, 2)}\n`, "utf8");
    await writeFile(ownerPath, ownerBytes, { flag: "wx" });

    return {
      schema: CCC_PLANNING_DISPOSABLE_TARGET_REPORT_SCHEMA,
      scratchRoot,
      repositoryRealpath,
      branch: "main",
      baseCommit,
      baseTree,
      remotes: [],
      ownershipMarker: { path: ownerPath, sha256: sha256Of(ownerBytes) },
      request: { path: requestPath, sha256: sha256Of(requestBytes), byteLength: requestBytes.length },
      settings: {
        path: settingsPath,
        sha256: sha256Of(settingsBytes),
        omniRouteBaseUrl,
        providerIds: { ...CCC_PLANNING_DISPOSABLE_TARGET_PROVIDER_IDS },
        models: { ...pins },
      },
      directories: { ...directories, target: repositoryRealpath },
      postgres: provisioned,
    };
  } catch (error) {
    if (provisioned === null) throw error;
    const { stop } = cccPlanningDisposablePostgresCommands(provisioned);
    const exec = postgresRunner(scratchRoot, postgres.run);
    await failAfterPostgresCleanup(error, () => exec(stop.file, stop.args));
  }
}

// ---------------------------------------------------------------- entry

const USAGE = "usage: node scripts/lib/ccc-planning-disposable-target.mjs --root <ROOT> --omniroute-base-url <http://127.0.0.1:PORT/PATH> [--provision-postgres] [--pg-bin <dir>]";

function parseArguments(argv) {
  const values = {};
  const flags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--provision-postgres") {
      if (flags.has(argument)) return null;
      flags.add(argument);
    } else if (argument === "--root" || argument === "--omniroute-base-url" || argument === "--pg-bin") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--") || Object.hasOwn(values, argument)) return null;
      values[argument] = value;
      index += 1;
    } else {
      return null;
    }
  }
  if (values["--root"] === undefined || values["--omniroute-base-url"] === undefined) return null;
  if (values["--pg-bin"] !== undefined && !flags.has("--provision-postgres")) return null;
  return { root: values["--root"], omniRouteBaseUrl: values["--omniroute-base-url"], provisionPostgres: flags.has("--provision-postgres"), pgBinDir: values["--pg-bin"] };
}

export async function main(argv) {
  const parsed = parseArguments(argv);
  if (parsed === null) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  try {
    const pins = await loadCccPlanningModelPins();
    const report = await buildCccPlanningDisposableTarget({
      root: parsed.root,
      omniRouteBaseUrl: parsed.omniRouteBaseUrl,
      pins,
      provisionPostgres: parsed.provisionPostgres,
      postgres: parsed.pgBinDir === undefined ? {} : { pgBinDir: parsed.pgBinDir },
    });
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${error?.message ?? String(error)}\n`);
    return 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
