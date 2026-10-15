/*
FNXC:CccInstalledCli 2026-10-14-18:53:
Shared pack, install and run helpers for the installed Fusion CLI (card IP, CONTRACT-v3.3 section 3.2 IP, ADR D Q2 decision 1). The build, pack, manifest-restore and install sequence is extracted unchanged from `prepareGate2InstalledRuntime` so Gate 2 and the planning installed-runtime proof pack the CLI the same way; Gate 2 keeps its receipt, its schema and its default arguments, and the planning proof opts into the extension points (`layout`, `npmMode`, `toolCaches`) it needs.

Two safety rules live here and nowhere else:
- `runInstalledFnProcess` and `runInstalledFnJsonCommand` build the child environment from an allowlist (PATH, LANG, LC_ALL, TZ) plus the isolated HOME, so a provider credential, PORT or a VITEST variable in the caller never reaches an installed `fn`. Gate 2's own PRD runner keeps its wider environment; ADR D Q2 rejects reusing it for planning for exactly that reason.
- npm `--offline` is the first choice when a cache is given; the online retry happens only for `offline-first` and only after ENOTCACHED, so a broken registry or a bad tarball is never hidden behind a second attempt.
*/
import { spawn, spawnSync } from "node:child_process";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

/** The only names copied from the caller's environment into an installed `fn` child. */
export const CCC_INSTALLED_FN_ENV_ALLOWLIST = Object.freeze(["PATH", "LANG", "LC_ALL", "TZ"]);
export const CCC_INSTALLED_CLI_NPM_MODES = Object.freeze(["default", "offline", "offline-first"]);

const STEP_MAX_BUFFER = 64 * 1024 * 1024;
/** Names a caller may never push into an installed `fn` through `extraEnv` (credentials, PORT, test-runner state, preload hooks). */
const FORBIDDEN_EXTRA_ENV =
  /(?:^|_)(?:API_KEY|TOKEN|SECRET|PASSWORD)$|^(?:OMNIROUTE|ANTHROPIC|OPENAI|GEMINI|GOOGLE|AWS|AZURE|MINIMAX|ZHIPU|GLM)_|^PORT$|^VITEST(?:_|$)|^NODE_OPTIONS$/u;

/**
 * Run one build step to completion and throw with its output on failure.
 * `allowStderr: false` also fails a zero exit that wrote to stderr, which is how Gate 2 has always treated `pnpm pack` and `fn --version`.
 */
export function runCheckedCommand(command, args, options) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env,
    maxBuffer: STEP_MAX_BUFFER,
  });
  if (result.error) {
    throw new Error(`${options.label} failed to start: ${result.error.message}`, { cause: result.error });
  }
  if (result.status !== 0 || (!options.allowStderr && result.stderr !== "")) {
    throw new Error(`${options.label} failed (exit ${result.status})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return result.stdout.trim();
}

/** The sealed child environment for an installed `fn`: allowlisted names, the isolated home, offline and no colour, then the vetted extras. */
export function buildInstalledFnEnv(input) {
  if (typeof input?.home !== "string" || !path.isAbsolute(input.home)) {
    throw new Error("installed fn home must be an absolute path");
  }
  const parentEnv = input.parentEnv ?? process.env;
  const extraEnv = input.extraEnv ?? {};
  const env = {};
  for (const name of CCC_INSTALLED_FN_ENV_ALLOWLIST) {
    if (typeof parentEnv[name] === "string") env[name] = parentEnv[name];
  }
  env.HOME = input.home;
  env.FUSION_HOME = path.join(input.home, ".fusion");
  env.NO_COLOR = "1";
  env.PI_OFFLINE = "1";
  for (const [name, value] of Object.entries(extraEnv)) {
    if (value === undefined || value === null) continue;
    if (name === "HOME" || name === "NO_COLOR" || name === "PI_OFFLINE" || FORBIDDEN_EXTRA_ENV.test(name)) {
      throw new Error(`installed fn extra environment name is not allowed: ${name}`);
    }
    env[name] = String(value);
  }
  return env;
}

/** Run an installed `fn` with the sealed environment; a child that outlives `timeoutMs` is killed (the probes this serves never fork) and its pipes released before the rejection. */
export async function runInstalledFnProcess(input) {
  if (!path.isAbsolute(input.executablePath)) {
    throw new Error("installed fn executable path must be absolute");
  }
  if (!Number.isInteger(input.timeoutMs) || input.timeoutMs <= 0) {
    throw new Error("installed fn timeoutMs must be a positive integer");
  }
  const env = buildInstalledFnEnv({ home: input.home, extraEnv: input.extraEnv, parentEnv: input.parentEnv });
  const child = spawn(input.executablePath, [...input.args], {
    cwd: input.cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (typeof input.onSpawn === "function" && Number.isInteger(child.pid)) input.onSpawn(child.pid);
  const stdout = [];
  const stderr = [];
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
    child.stdout.destroy();
    child.stderr.destroy();
  }, input.timeoutMs);
  try {
    const exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        if (timedOut) {
          reject(new Error(`installed fn timed out after ${input.timeoutMs} ms`));
          return;
        }
        if (signal) {
          reject(new Error(`installed fn terminated by ${signal}`));
          return;
        }
        resolve(code ?? 1);
      });
    });
    return { exitCode, stdout: stdout.join(""), stderr: stderr.join("") };
  } finally {
    clearTimeout(timer);
  }
}

/** Like `runInstalledFnProcess`, but every stdout line must be JSON; the parsed lines come back in order. */
export async function runInstalledFnJsonCommand(input) {
  const { exitCode, stdout, stderr } = await runInstalledFnProcess(input);
  const values = stdout.split("\n").filter(Boolean).map((line) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`installed fn emitted a non-JSON stdout line: ${line}`, { cause: error });
    }
  });
  return { exitCode, values, stderr };
}

async function assertEmptyRoot(root) {
  let entries;
  try {
    entries = await readdir(root);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (entries.length > 0) throw new Error("installed runtime root is not empty");
}

function resolveLayout(root, layout) {
  return {
    packRoot: path.resolve(layout?.packDir ?? path.join(root, "pack")),
    installRoot: path.resolve(layout?.installDir ?? path.join(root, "install")),
    home: path.resolve(layout?.homeDir ?? path.join(root, "home")),
  };
}

function npmInstallArguments(tarballPath, { offline, npmCache }) {
  return [
    "install", "--no-audit", "--no-fund", "--ignore-scripts",
    ...(offline ? ["--offline"] : []),
    ...(npmCache ? ["--cache", npmCache] : []),
    tarballPath,
  ];
}

/**
 * Build the CLI package, pack it, restore the packed manifest and `npm install` the tarball into a clean root.
 * Defaults are Gate 2's: `<root>/{pack,install,home}`, plain `npm install`, the caller's `env` plus HOME and NO_COLOR.
 * `npmMode` is "default" | "offline" | "offline-first"; the offline modes pass `--offline` and need `toolCaches.npmCache` because HOME is isolated.
 */
export async function packAndInstallFusionCli(input) {
  const npmMode = input.npmMode ?? "default";
  if (!CCC_INSTALLED_CLI_NPM_MODES.includes(npmMode)) {
    throw new Error(`unknown npm mode ${String(npmMode)}`);
  }
  const root = path.resolve(input.root);
  await assertEmptyRoot(root);
  const { packRoot, installRoot, home } = resolveLayout(root, input.layout);
  const cliRoot = path.resolve(input.cliRoot);
  await mkdir(packRoot, { recursive: true });
  await mkdir(installRoot, { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFile(path.join(installRoot, "package.json"), `${JSON.stringify({
    name: input.installProjectName ?? "ccc-installed-runtime",
    version: "0.0.0",
    private: true,
  }, null, 2)}\n`);
  const env = { ...input.env, HOME: home, NO_COLOR: "1" };
  const corepackEnv = input.toolCaches?.corepackHome ? { ...env, COREPACK_HOME: input.toolCaches.corepackHome } : env;
  runCheckedCommand("corepack", ["pnpm", "run", "build:package"], {
    cwd: cliRoot, env: corepackEnv, label: "fresh CLI package build", allowStderr: true,
  });
  let packFailure = null;
  let restoreFailure = null;
  try {
    runCheckedCommand("corepack", ["pnpm", "pack", "--pack-destination", packRoot], {
      cwd: cliRoot, env: corepackEnv, label: "pnpm pack",
    });
  } catch (error) {
    packFailure = error;
  } finally {
    try {
      runCheckedCommand(process.execPath, ["./scripts/prepare-publish-manifest.mjs", "postpack"], {
        cwd: cliRoot, env, label: "restore CLI package manifest after pack", allowStderr: true,
      });
    } catch (error) {
      restoreFailure = error;
    }
  }
  if (packFailure && restoreFailure) {
    throw new Error(`${packFailure.message}\npostpack restore failed:\n${restoreFailure.message}`, {
      cause: restoreFailure,
    });
  }
  if (restoreFailure) throw restoreFailure;
  if (packFailure) throw packFailure;
  const tarballs = (await readdir(packRoot)).filter((name) =>
    name.startsWith("runfusion-fusion-") && name.endsWith(".tgz"));
  if (tarballs.length !== 1) throw new Error(`expected one packed Fusion tarball, received ${tarballs.length}`);
  const tarballPath = path.join(packRoot, tarballs[0]);
  const install = (options) => runCheckedCommand("npm", npmInstallArguments(tarballPath, options), {
    cwd: installRoot, env, label: "clean npm install", allowStderr: true,
  });
  const npmCache = npmMode === "default" ? undefined : input.toolCaches?.npmCache;
  let npmFetch = "unrestricted";
  if (npmMode === "offline") {
    install({ offline: true, npmCache });
    npmFetch = "offline-cache";
  } else if (npmMode === "offline-first") {
    try {
      install({ offline: true, npmCache });
      npmFetch = "offline-cache";
    } catch (error) {
      if (!/ENOTCACHED/u.test(error.message)) throw error;
      install({ offline: false, npmCache });
      npmFetch = "registry";
    }
  } else {
    install({ offline: false, npmCache });
  }
  return {
    tarballPath,
    installedRoot: path.join(installRoot, "node_modules/@runfusion/fusion"),
    executablePath: path.join(installRoot, "node_modules/.bin/fn"),
    home,
    npmFetch,
  };
}
