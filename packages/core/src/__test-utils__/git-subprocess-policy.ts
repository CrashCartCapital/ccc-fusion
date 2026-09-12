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
  "GIT_EXEC_PATH",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_PROXY_COMMAND",
  "GIT_ASKPASS",
  "SSH_ASKPASS",
  "GIT_SEQUENCE_EDITOR",
  "GIT_EXTERNAL_DIFF",
  "GIT_TEMPLATE_DIR",
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

export function isolateTrustedTestGitEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
  return {
    ...env,
    GIT_CONFIG_GLOBAL: nullDevice,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: nullDevice,
    // Display-only variables. These cannot move an invocation outside the worker
    // root, so they are sanitized here rather than vetoing the reroute upstream.
    // A worker has no controlling terminal, so an inherited pager or editor would
    // hang or fail rather than page anything.
    GIT_EDITOR: "true",
    GIT_PAGER: "cat",
    PAGER: "cat",
  };
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

function isTrustedGitExecutable(file: string, trusted: string, cwd: string = process.cwd()): boolean {
  if (file === trusted) return true;
  if (!isAbsolute(file) && !file.includes("/") && !file.includes("\\")) return false;
  const candidate = isAbsolute(file) ? file : resolve(cwd, file);
  try {
    return realpathSync(candidate) === realpathSync(trusted);
  } catch {
    return false;
  }
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

/**
 * Which containment rule refused an invocation. One throw site serves every
 * rule, so without this tag a refusal cannot be triaged: "outside the Vitest
 * worker root" reads identically whether a `-C` target escaped, an environment
 * variable pointed at the host, or a `-c` option simply was not on the
 * allowlist. Keep these ids stable; CI triage greps for them.
 */
export type GitContainmentRuleId =
  | "missing-worker-root"
  | "git-path-env-outside-worker-root"
  | "git-execution-env-set"
  | "git-trace-env-outside-worker-root"
  | "git-config-env-not-isolated"
  | "git-config-count-not-allowlisted"
  | "home-env-outside-worker-root"
  | "attached-directory-option-outside-worker-root"
  | "attached-config-option-not-allowlisted"
  | "config-option-not-allowlisted"
  | "config-env-or-exec-path-option"
  | "path-option-outside-worker-root"
  | "assigned-path-option-outside-worker-root"
  | "assigned-value-outside-worker-root"
  | "absolute-argument-outside-worker-root"
  | "traversal-argument-outside-worker-root"
  | "effective-cwd-outside-worker-root";

export type GitContainmentVerdict =
  | { ok: true }
  | { ok: false; ruleId: GitContainmentRuleId; detail: string };

const CONTAINED: GitContainmentVerdict = { ok: true };

function refuse(ruleId: GitContainmentRuleId, detail: string): GitContainmentVerdict {
  return { ok: false, ruleId, detail };
}

function gitTraceEnvironmentStaysWithinWorker(context: TrustedTestGitContext): GitContainmentVerdict {
  for (const [key, value] of Object.entries(context.env ?? {})) {
    if (!key.startsWith("GIT_TRACE") || !value) continue;
    const normalized = value.toLowerCase();
    if (key.endsWith("_NO_DATA") || key.endsWith("_REDACT")) {
      if (!["0", "1", "false", "true"].includes(normalized)) {
        return refuse("git-trace-env-outside-worker-root", `${key}=${value} is not a boolean flag`);
      }
      continue;
    }
    if (["0", "false"].includes(normalized)) continue;
    if (/^(?:true|[1-9])$/u.test(normalized) || value.startsWith("~") || value.includes("\0")) {
      return refuse("git-trace-env-outside-worker-root", `${key}=${value} names an unbounded trace sink`);
    }
    if (!isWithin(context.workerRoot, resolveGitPath(value, context.cwd))) {
      return refuse(
        "git-trace-env-outside-worker-root",
        `${key}=${value} -> ${resolveGitPath(value, context.cwd)}`,
      );
    }
  }
  return CONTAINED;
}

function tokenPathValue(token: string): string | null {
  const equals = token.indexOf("=");
  if (equals <= 0) return null;
  const option = token.slice(0, equals);
  return GIT_PATH_OPTIONS.has(option) ? token.slice(equals + 1) : null;
}

/**
 * Decide whether one git invocation stays inside the Vitest worker root, and say
 * exactly which rule refused it when it does not. Behaviour is unchanged from
 * the boolean version this replaced: every `ok: false` here was a `return false`
 * there, in the same order.
 */
export function inspectTrustedTestGitContainment(
  args: readonly string[],
  context: TrustedTestGitContext,
): GitContainmentVerdict {
  if (!context.workerRoot) return refuse("missing-worker-root", "context.workerRoot is empty");
  let effectiveCwd = context.cwd;

  for (const key of GIT_PATH_ENV_KEYS) {
    const value = context.env?.[key];
    const paths = key === "GIT_ALTERNATE_OBJECT_DIRECTORIES"
      ? value ? value.split(delimiter) : []
      : value ? [value] : [];
    for (const path of paths) {
      if (!path) continue;
      const resolved = resolveGitPath(path, context.cwd);
      if (!isWithin(context.workerRoot, resolved)) {
        return refuse("git-path-env-outside-worker-root", `${key}=${path} -> ${resolved}`);
      }
    }
  }
  const executionEnvKey = GIT_EXECUTION_ENV_KEYS.find((key) => Boolean(context.env?.[key]));
  if (executionEnvKey) {
    return refuse("git-execution-env-set", `${executionEnvKey}=${context.env?.[executionEnvKey] ?? ""}`);
  }
  const trace = gitTraceEnvironmentStaysWithinWorker(context);
  if (!trace.ok) return trace;
  // GIT_EDITOR, GIT_PAGER and PAGER are deliberately not tested here. They name a
  // program that displays or edits text, which is not a containment property, and
  // isolateTrustedTestGitEnvironment pins all three on every reroute path.
  const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
  if (context.env?.GIT_CONFIG_GLOBAL && context.env.GIT_CONFIG_GLOBAL !== nullDevice) {
    return refuse("git-config-env-not-isolated", `GIT_CONFIG_GLOBAL=${context.env.GIT_CONFIG_GLOBAL}`);
  }
  if (context.env?.GIT_CONFIG_SYSTEM && context.env.GIT_CONFIG_SYSTEM !== nullDevice) {
    return refuse("git-config-env-not-isolated", `GIT_CONFIG_SYSTEM=${context.env.GIT_CONFIG_SYSTEM}`);
  }
  if (context.env?.GIT_CONFIG_NOSYSTEM && context.env.GIT_CONFIG_NOSYSTEM !== "1") {
    return refuse("git-config-env-not-isolated", `GIT_CONFIG_NOSYSTEM=${context.env.GIT_CONFIG_NOSYSTEM}`);
  }
  if (context.env?.GIT_CONFIG_PARAMETERS) {
    return refuse("git-config-env-not-isolated", `GIT_CONFIG_PARAMETERS=${context.env.GIT_CONFIG_PARAMETERS}`);
  }
  const configCountText = context.env?.GIT_CONFIG_COUNT;
  if (configCountText) {
    const configCount = Number.parseInt(configCountText, 10);
    if (!Number.isInteger(configCount) || configCount < 0 || String(configCount) !== configCountText) {
      return refuse("git-config-count-not-allowlisted", `GIT_CONFIG_COUNT=${configCountText}`);
    }
    for (let configIndex = 0; configIndex < configCount; configIndex += 1) {
      const key = context.env?.[`GIT_CONFIG_KEY_${configIndex}`];
      const value = context.env?.[`GIT_CONFIG_VALUE_${configIndex}`];
      if (key !== "init.defaultBranch" || value !== "main") {
        return refuse(
          "git-config-count-not-allowlisted",
          `GIT_CONFIG_KEY_${configIndex}=${key ?? ""} GIT_CONFIG_VALUE_${configIndex}=${value ?? ""}`,
        );
      }
    }
  }
  for (const homeKey of ["HOME", "USERPROFILE", "XDG_CONFIG_HOME"] as const) {
    const home = context.env?.[homeKey];
    if (home && !isWithin(context.workerRoot, home)) {
      return refuse("home-env-outside-worker-root", `${homeKey}=${home}`);
    }
  }

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token.startsWith("-C") && token.length > 2) {
      const target = resolveGitPath(token.slice(2), effectiveCwd);
      if (!isWithin(context.workerRoot, target)) {
        return refuse("attached-directory-option-outside-worker-root", `${token} -> ${target}`);
      }
      effectiveCwd = target;
      continue;
    }
    if (token.startsWith("-c") && token.length > 2) {
      if (token !== "-ccore.quotePath=false") {
        return refuse("attached-config-option-not-allowlisted", token);
      }
      continue;
    }
    if (token === "-c") {
      const config = args[index + 1] ?? "";
      if (config !== "core.quotePath=false"
        && config !== "core.fsmonitor=false"
        && config !== "core.untrackedCache=false"
        && config !== `core.hooksPath=${nullDevice}`
        && !config.startsWith("user.name=")
        && !config.startsWith("user.email=")) {
        return refuse("config-option-not-allowlisted", `-c ${config}`);
      }
      index += 1;
      continue;
    }
    if (token.startsWith("--config-env") || token === "--exec-path" || token.startsWith("--exec-path=")) {
      return refuse("config-env-or-exec-path-option", token);
    }
    if (GIT_PATH_OPTIONS.has(token)) {
      const value = args[index + 1];
      const target = value ? resolveGitPath(value, effectiveCwd) : null;
      if (!target) return refuse("path-option-outside-worker-root", `${token} (no value)`);
      if (!isWithin(context.workerRoot, target)) {
        return refuse("path-option-outside-worker-root", `${token} ${value ?? ""} -> ${target}`);
      }
      if (token === "-C") effectiveCwd = target;
      index += 1;
      continue;
    }

    const assignedPath = tokenPathValue(token);
    if (assignedPath !== null) {
      if (!assignedPath) {
        return refuse("assigned-path-option-outside-worker-root", `${token} (empty value)`);
      }
      const resolved = resolveGitPath(assignedPath, effectiveCwd);
      if (!isWithin(context.workerRoot, resolved)) {
        return refuse("assigned-path-option-outside-worker-root", `${token} -> ${resolved}`);
      }
      continue;
    }

    const equals = token.indexOf("=");
    if (equals >= 0) {
      const value = token.slice(equals + 1);
      if ((isAbsolute(value) || /(^|[\\/])\.\.([\\/]|$)/.test(value))
        && !isWithin(context.workerRoot, resolve(effectiveCwd, value))) {
        return refuse(
          "assigned-value-outside-worker-root",
          `${token} -> ${resolve(effectiveCwd, value)}`,
        );
      }
    }

    if (isAbsolute(token)) {
      if (!isWithin(context.workerRoot, token)) {
        return refuse("absolute-argument-outside-worker-root", token);
      }
      continue;
    }

    if (token.split(/[\\/]+/).includes("..")
      && !isWithin(context.workerRoot, resolve(effectiveCwd, token))) {
      return refuse(
        "traversal-argument-outside-worker-root",
        `${token} -> ${resolve(effectiveCwd, token)}`,
      );
    }
  }

  if (!isWithin(context.workerRoot, effectiveCwd)) {
    return refuse("effective-cwd-outside-worker-root", effectiveCwd);
  }
  return CONTAINED;
}

function parseSimpleShellWords(command: string): string[] | null {
  const syntaxProbe = command.replace(/stash@\{\d+\}/g, "stash-ref");
  if (/[\r\n;&|<>`$()*?[\]{}]/.test(syntaxProbe) || /(^|[\s=])~/.test(syntaxProbe)) return null;
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

function leadingShellExecutable(command: string): { end: number; start: number; value: string } | null {
  const leadingWhitespace = command.match(/^\s*/u)?.[0].length ?? 0;
  const rest = command.slice(leadingWhitespace);
  const match = /^(?:"([^"]+)"|'([^']+)'|([^\s;&|<>`$()*?[\]{}]+))/u.exec(rest);
  if (!match) return null;
  return {
    start: leadingWhitespace,
    end: leadingWhitespace + match[0].length,
    value: match[1] ?? match[2] ?? match[3]!,
  };
}

function shellMentionsTrustedGit(command: string, trusted: string, cwd: string): boolean {
  const pathTokens = Array.from(
    command.matchAll(/(?:^|[\s'"=;&|<>`$()])((?:\/|\.\.?[\\/])[^\s'";&|<>`$()*?[\]{}]+)/gu),
    (match) => match[1]!,
  );
  return pathTokens.some((token) => isTrustedGitExecutable(token, trusted, cwd));
}

export function shellUsesTrustedTestGit(
  command: string,
  trusted: string = "/usr/bin/git",
  cwd: string = process.cwd(),
): boolean {
  const executable = leadingShellExecutable(command);
  return executable !== null && isTrustedGitExecutable(executable.value, trusted, cwd);
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
  if (["checkout", "reset", "restore", "revert"].includes(subcommand ?? "")) {
    return true;
  }
  if (subcommand === "clean") {
    return args.slice(index + 1).some((arg) => arg === "-f" || arg === "--force");
  }
  if (subcommand === "switch") {
    return args.slice(index + 1).some((arg) => arg === "-f" || arg === "--force" || arg === "--discard-changes");
  }
  if (subcommand === "stash") {
    return ["clear", "drop", "pop"].includes(args[index + 1] ?? "");
  }
  return false;
}

export function resolveTrustedTestGitFile(
  file: string,
  args: readonly string[],
  context: TrustedTestGitContext,
): string {
  const trusted = context.trustedGitBinary ?? "/usr/bin/git";
  const explicitTrusted = isTrustedGitExecutable(file, trusted, context.cwd);
  if (file !== "git" && !explicitTrusted) return file;
  const containment = inspectTrustedTestGitContainment(args, context);
  if (explicitTrusted && !containment.ok) {
    /*
    Name the rule, the resolved offending value and the full invocation. One
    throw site serves seventeen rules, and a message that only repeats the argv
    forces a reader to re-derive the whole policy by hand before they can tell a
    mis-rooted fixture apart from an option the allowlist never covered.
    */
    throw new Error([
      "Explicit trusted git target is outside the Vitest worker root:",
      `rule=${containment.ruleId}`,
      `detail=${containment.detail}`,
      `executable=${file}`,
      `args=${args.join(" ")}`,
      `cwd=${context.cwd}`,
      `workerRoot=${context.workerRoot}`,
    ].join(" "));
  }
  if (explicitTrusted) return trusted;
  if (!context.enableTrustedGitBypass || !existsSync(trusted) || !containment.ok || !requiresTrustedGitBypass(args)) return file;
  return trusted;
}

export function resolveTrustedTestGitShell(
  command: string,
  context: TrustedTestGitContext,
): string {
  const trustedBinary = context.trustedGitBinary ?? "/usr/bin/git";
  const leadingExecutable = leadingShellExecutable(command);
  const beginsWithTrusted = leadingExecutable !== null
    && isTrustedGitExecutable(leadingExecutable.value, trustedBinary, context.cwd);
  if (shellMentionsTrustedGit(command, trustedBinary, context.cwd) && !beginsWithTrusted) {
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
  if (executable !== "git" && !isTrustedGitExecutable(executable, trustedBinary, context.cwd)) return command;
  const trusted = resolveTrustedTestGitFile(executable, words.slice(1), context);
  if (trusted === "git") return command;
  if (!leadingExecutable) return command;
  return `${command.slice(0, leadingExecutable.start)}${trusted}${command.slice(leadingExecutable.end)}`;
}
