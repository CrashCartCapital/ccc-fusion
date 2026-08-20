import { accessSync, constants, existsSync, readFileSync, realpathSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";

export interface TrustedTestGitContext {
  cwd: string;
  workerRoot: string;
  env?: NodeJS.ProcessEnv;
  trustedGitBinary?: string;
  enableTrustedGitBypass?: boolean;
}

const GIT_PATH_ENV_KEYS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
] as const;

const GIT_PATH_OPTIONS = new Set([
  "-C",
  "--git-dir",
  "--work-tree",
  "--separate-git-dir",
]);

const GIT_EXECUTION_ENV_KEYS = [
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_PROXY_COMMAND",
  "GIT_ASKPASS",
  "SSH_ASKPASS",
  "GIT_SEQUENCE_EDITOR",
  "GIT_EXTERNAL_DIFF",
] as const;

export function pathUsesSafeExecGitShim(pathValue: string): boolean {
  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    const candidate = join(directory, process.platform === "win32" ? "git.exe" : "git");
    try {
      accessSync(candidate, constants.X_OK);
      const physical = realpathSync(candidate);
      const separator = process.platform === "win32" ? "\\" : "/";
      if (physical.includes(`${separator}safeexec${separator}`)) return true;
      return /safeexec/i.test(readFileSync(candidate, "utf8").slice(0, 1024));
    } catch {
      continue;
    }
  }
  return false;
}

function resolvedPhysicalPath(path: string): string {
  const absolute = resolve(path);
  if (existsSync(absolute)) return realpathSync(absolute);

  const missing: string[] = [];
  let cursor = absolute;
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) return absolute;
    missing.unshift(relative(parent, cursor));
    cursor = parent;
  }
  return resolve(realpathSync(cursor), ...missing);
}

function isWithin(root: string, path: string): boolean {
  const physicalRoot = resolvedPhysicalPath(root);
  const physicalPath = resolvedPhysicalPath(path);
  const rel = relative(physicalRoot, physicalPath);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function resolveGitPath(value: string, cwd: string): string {
  return isAbsolute(value) ? value : resolve(cwd, value);
}

function tokenPathValue(token: string): string | null {
  const equals = token.indexOf("=");
  if (equals <= 0) return null;
  const option = token.slice(0, equals);
  return GIT_PATH_OPTIONS.has(option) ? token.slice(equals + 1) : null;
}

function invocationStaysWithinWorker(args: readonly string[], context: TrustedTestGitContext): boolean {
  if (!context.workerRoot) return false;
  let effectiveCwd = context.cwd;

  for (const key of GIT_PATH_ENV_KEYS) {
    const value = context.env?.[key];
    const paths = key === "GIT_ALTERNATE_OBJECT_DIRECTORIES"
      ? value ? value.split(delimiter) : []
      : value ? [value] : [];
    if (paths.some((path) => path && !isWithin(context.workerRoot, resolveGitPath(path, context.cwd)))) return false;
  }
  if (GIT_EXECUTION_ENV_KEYS.some((key) => Boolean(context.env?.[key]))) return false;
  if (context.env?.GIT_EDITOR && context.env.GIT_EDITOR !== "true") return false;
  if (context.env?.GIT_PAGER && context.env.GIT_PAGER !== "cat") return false;
  if (context.env?.PAGER && context.env.PAGER !== "cat") return false;
  if (context.env?.GIT_CONFIG_GLOBAL || context.env?.GIT_CONFIG_SYSTEM || context.env?.GIT_CONFIG_PARAMETERS) return false;
  const configCountText = context.env?.GIT_CONFIG_COUNT;
  if (configCountText) {
    const configCount = Number.parseInt(configCountText, 10);
    if (!Number.isInteger(configCount) || configCount < 0 || String(configCount) !== configCountText) return false;
    for (let configIndex = 0; configIndex < configCount; configIndex += 1) {
      if (context.env?.[`GIT_CONFIG_KEY_${configIndex}`] !== "init.defaultBranch"
        || context.env?.[`GIT_CONFIG_VALUE_${configIndex}`] !== "main") {
        return false;
      }
    }
  }
  for (const homeKey of ["HOME", "USERPROFILE", "XDG_CONFIG_HOME"] as const) {
    const home = context.env?.[homeKey];
    if (home && !isWithin(context.workerRoot, home)) return false;
  }

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token.startsWith("-C") && token.length > 2) {
      const target = resolveGitPath(token.slice(2), effectiveCwd);
      if (!isWithin(context.workerRoot, target)) return false;
      effectiveCwd = target;
      continue;
    }
    if (token.startsWith("-c") && token.length > 2) {
      if (token !== "-ccore.quotePath=false") return false;
      continue;
    }
    if (token === "-c") {
      if (args[index + 1] !== "core.quotePath=false") return false;
      index += 1;
      continue;
    }
    if (token.startsWith("--config-env") || token === "--exec-path" || token.startsWith("--exec-path=")) return false;
    if (GIT_PATH_OPTIONS.has(token)) {
      const value = args[index + 1];
      const target = value ? resolveGitPath(value, effectiveCwd) : null;
      if (!target || !isWithin(context.workerRoot, target)) return false;
      if (token === "-C") effectiveCwd = target;
      index += 1;
      continue;
    }

    const assignedPath = tokenPathValue(token);
    if (assignedPath !== null) {
      if (!assignedPath || !isWithin(context.workerRoot, resolveGitPath(assignedPath, effectiveCwd))) return false;
      continue;
    }

    const equals = token.indexOf("=");
    if (equals >= 0) {
      const value = token.slice(equals + 1);
      if ((isAbsolute(value) || /(^|[\\/])\.\.([\\/]|$)/.test(value))
        && !isWithin(context.workerRoot, resolve(effectiveCwd, value))) {
        return false;
      }
    }

    if (isAbsolute(token)) {
      if (!isWithin(context.workerRoot, token)) return false;
      continue;
    }

    if (token.split(/[\\/]+/).includes("..")
      && !isWithin(context.workerRoot, resolve(effectiveCwd, token))) {
      return false;
    }
  }

  return isWithin(context.workerRoot, effectiveCwd);
}

function parseSimpleShellWords(command: string): string[] | null {
  if (/[\r\n;&|<>`$()*?[\]{}]/.test(command) || /(^|[\s=])~/.test(command)) return null;
  const words: string[] = [];
  let word = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (const char of command) {
    if (escaped) {
      word += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else word += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (word) {
        words.push(word);
        word = "";
      }
      continue;
    }
    word += char;
  }

  if (escaped || quote) return null;
  if (word) words.push(word);
  return words;
}

function requiresTrustedGitBypass(args: readonly string[]): boolean {
  let index = 0;
  while (index < args.length) {
    const token = args[index]!;
    if ((token.startsWith("-C") && token.length > 2) || (token.startsWith("-c") && token.length > 2)) {
      index += 1;
      continue;
    }
    if (token === "-C" || token === "-c" || GIT_PATH_OPTIONS.has(token)) {
      index += 2;
      continue;
    }
    if (tokenPathValue(token) !== null || token.startsWith("--")) {
      index += 1;
      continue;
    }
    break;
  }

  const subcommand = args[index];
  if (["checkout", "clean", "reset", "restore", "switch"].includes(subcommand ?? "")) {
    return true;
  }
  if (subcommand === "stash") {
    return ["apply", "clear", "drop", "pop"].includes(args[index + 1] ?? "");
  }
  return false;
}

export function resolveTrustedTestGitFile(
  file: string,
  args: readonly string[],
  context: TrustedTestGitContext,
): string {
  const trusted = context.trustedGitBinary ?? "/usr/bin/git";
  const explicitTrusted = file === trusted;
  if (file !== "git" && !explicitTrusted) return file;
  const safeTarget = invocationStaysWithinWorker(args, context);
  if (explicitTrusted && !safeTarget) {
    throw new Error(`Explicit trusted git target is outside the Vitest worker root: ${args.join(" ")}`);
  }
  if (explicitTrusted || !context.enableTrustedGitBypass || !existsSync(trusted) || !safeTarget || !requiresTrustedGitBypass(args)) return file;
  return trusted;
}

export function resolveTrustedTestGitShell(
  command: string,
  context: TrustedTestGitContext,
): string {
  const trustedBinary = context.trustedGitBinary ?? "/usr/bin/git";
  const trimmed = command.trimStart();
  const beginsWithTrusted = trimmed.startsWith(trustedBinary)
    || trimmed.startsWith(`"${trustedBinary}"`)
    || trimmed.startsWith(`'${trustedBinary}'`);
  if (command.includes(trustedBinary) && !beginsWithTrusted) {
    throw new Error("Unsupported explicit trusted git shell command");
  }
  const words = parseSimpleShellWords(command);
  if (!words) {
    if (beginsWithTrusted) {
      throw new Error("Unsupported explicit trusted git shell command");
    }
    return command;
  }
  const executable = words[0];
  if (executable !== "git" && executable !== trustedBinary) return command;
  const trusted = resolveTrustedTestGitFile(executable, words.slice(1), context);
  if (executable === trustedBinary || trusted === "git") return command;
  return command.replace(/^(\s*)git(?=\s|$)/, `$1${trusted}`);
}
