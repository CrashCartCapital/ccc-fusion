const DISCOVERY_TOOL_NAMES = new Set(["read", "grep", "find", "ls", "glob", "bash"]);

function unwrapSimpleShellPrefix(raw: string): string {
  let command = raw.trim();
  while (true) {
    const before = command;
    command = command.replace(/^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+/, "").trim();
    command = command.replace(/^(?:env|command)\s+/, "").trim();
    if (command === before) return command;
  }
}

function withoutStderrDiscard(command: string): string {
  return command.replace(/\s+2>>?\s*\/dev\/null\b/g, "");
}

function hasExplicitFileMutation(command: string): boolean {
  if (/>/.test(withoutStderrDiscard(command))) return true;
  if (/\bsed\b[^\n]*(?:(?:^|\s)-i\S*(?=\s|$)|--in-place\b)/.test(command)) return true;
  if (/\bfind\b[^\n]*(?:-delete|-exec(?:dir)?|-ok(?:dir)?|-fprint0?|-fprintf|-fls)\b/.test(command)) return true;
  return /^\S*git\s+(?:grep|diff|log|show|status|ls-files)\b/.test(command)
    && /(?:^|\s)--output(?:=|\s)/.test(command);
}

/** One provably read-only shell command; compound/unknown syntax is fingerprinted after execution. */
function isReadOnlyBashCommand(raw: string): boolean {
  const command = unwrapSimpleShellPrefix(raw);
  if (!command) return false;
  if (/(?:&&|\|\||[;&|\n`]|\$\(|<\(|>\()/.test(command)) return false;
  if (hasExplicitFileMutation(command)) return false;

  const executable = command.match(/^(\S+)/)?.[1]?.split("/").pop()?.toLowerCase();
  if (!executable) return false;
  if (executable === "git") {
    return /^\S*git\s+(?:grep|diff|log|show|status|ls-files)\b/.test(command);
  }
  return new Set(["ls", "pwd", "find", "grep", "rg", "sed", "cat", "head", "tail", "stat", "wc", "file"])
    .has(executable);
}

export function isCccCampaignExplicitMutationToolCall(
  toolName: string,
  params: Record<string, unknown> | undefined,
): boolean {
  const normalizedToolName = toolName.trim().toLowerCase();
  if (normalizedToolName === "write" || normalizedToolName === "edit") return true;
  if (normalizedToolName !== "bash") return false;
  return hasExplicitFileMutation(unwrapSimpleShellPrefix(
    typeof params?.command === "string" ? params.command : "",
  ));
}

export function isCccCampaignDiscoveryToolCall(
  toolName: string,
  params: Record<string, unknown> | undefined,
): boolean {
  const normalizedToolName = toolName.trim().toLowerCase();
  if (!DISCOVERY_TOOL_NAMES.has(normalizedToolName)) return false;
  if (normalizedToolName !== "bash") return true;
  return isReadOnlyBashCommand(typeof params?.command === "string" ? params.command : "");
}

export function isCccCampaignPotentialMutationToolCall(
  toolName: string,
  params: Record<string, unknown> | undefined,
): boolean {
  // Bash is never custody-safe merely because its surface syntax looks
  // read-only. Shell expansion, aliases, wrappers, and command behavior can
  // still write, so every Bash call receives a before/after write-set check.
  if (toolName.trim().toLowerCase() === "bash") return true;
  return !isCccCampaignDiscoveryToolCall(toolName, params);
}

export type CccCampaignUnsafeBashProcessReason = "background_process" | "process_kill";

/**
 * Reject process shapes that can outlive a Bash tool's before/after custody
 * snapshot or kill an unrelated controller/verifier process. Quoted program
 * text and descriptor redirections are ignored; direct shell control remains
 * foreground-only for campaign workers.
 */
function classifyCccCampaignUnsafeBashProcess(
  raw: string,
  recursionDepth: number,
): CccCampaignUnsafeBashProcessReason | undefined {
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let word = "";
  let segment: string[] = [];
  const segments: string[][] = [];
  const finishWord = (): void => {
    if (word.length > 0) segment.push(word);
    word = "";
  };
  const finishSegment = (): void => {
    finishWord();
    if (segment.length > 0) segments.push(segment);
    segment = [];
  };
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index]!;
    if (escaped) {
      word += character;
      escaped = false;
      continue;
    }
    if (quote) {
      if (quote === '"' && character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = undefined;
      } else {
        word += character;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      // Bash/Zsh ANSI-C and locale-translated quotes pass only the quoted
      // payload as the argument; the `$` prefix is not part of argv.
      if (word === "$") word = "";
      quote = character;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    const commandBoundary = /[;&|(){}]/u.test(character) || character === "\n" || character === "\r";
    if (/\s/u.test(character) || /[;&|(){}<>]/u.test(character)) finishWord();
    if (character === "&") {
      const previous = raw[index - 1];
      const next = raw[index + 1];
      if (
        previous !== "&"
        && next !== "&"
        && previous !== ">"
        && previous !== "<"
        && next !== ">"
      ) {
        return "background_process";
      }
    }
    if (commandBoundary) {
      finishSegment();
      continue;
    }
    if (!/\s/u.test(character) && !/[;&|(){}<>]/u.test(character)) word += character;
  }
  if (escaped) word += "\\";
  finishSegment();
  const processKillCommands = new Set(["kill", "killall", "pkill"]);
  const executableName = (candidate: string): string | undefined =>
    candidate.split("/").at(-1)?.toLowerCase();
  const isProcessKill = (candidate: string): boolean => {
    const executable = executableName(candidate);
    return executable !== undefined && processKillCommands.has(executable);
  };
  const shellCommandFlag = /^-[A-Za-z]*c[A-Za-z]*$/u;
  const nestedShellKills = (tokens: string[]): boolean => {
    for (let shellIndex = 0; shellIndex < tokens.length; shellIndex += 1) {
      const shell = executableName(tokens[shellIndex] ?? "");
      if (!shell || !["bash", "sh", "zsh"].includes(shell)) continue;
      const relativeFlagIndex = tokens
        .slice(shellIndex + 1)
        .findIndex((token) => shellCommandFlag.test(token));
      if (relativeFlagIndex < 0) continue;
      const nested = tokens[shellIndex + relativeFlagIndex + 2];
      if (!nested) continue;
      // Fail closed on deliberately deep nested shell command strings rather
      // than allowing recursion to become an evasion or resource sink.
      if (recursionDepth >= 8) return true;
      if (classifyCccCampaignUnsafeBashProcess(nested, recursionDepth + 1) === "process_kill") {
        return true;
      }
    }
    return false;
  };
  const assignment = /^[A-Za-z_][A-Za-z0-9_]*=/u;
  const controlPrefixes = new Set(["!", "do", "elif", "else", "if", "then", "until", "while"]);
  const commandWrappers = new Set([
    "builtin", "command", "env", "exec", "parallel", "sudo", "time", "xargs",
  ]);
  const isCommandWrapper = (command: string): boolean =>
    commandWrappers.has(command) || /^nohu[p]$/u.test(command);
  const wrapperOptionsWithSeparateValue: Readonly<Record<string, ReadonlySet<string>>> = {
    env: new Set(["-C", "-S", "-u", "--chdir", "--split-string", "--unset"]),
    exec: new Set(["-a"]),
    parallel: new Set(["-a", "-j", "-L", "-N", "--arg-file", "--jobs", "--max-args", "--max-lines"]),
    sudo: new Set([
      "-C", "-D", "-R", "-T", "-a", "-c", "-g", "-h", "-p", "-r", "-t", "-u",
      "--chdir", "--close-from", "--group", "--host", "--other-user", "--prompt", "--role",
      "--type", "--user",
    ]),
    time: new Set(["-f", "-o", "--format", "--output"]),
    xargs: new Set([
      "-E", "-I", "-L", "-P", "-S", "-a", "-d", "-n", "-s",
      "--arg-file", "--delimiter", "--eof", "--max-args", "--max-chars", "--max-lines",
      "--max-procs", "--process-slot-var", "--replace",
    ]),
  };
  const unwrapCommandWrapper = (wrapper: string, tokens: string[]): string[] => {
    const optionsWithValue = wrapperOptionsWithSeparateValue[wrapper] ?? new Set<string>();
    let index = 0;
    while (index < tokens.length) {
      const token = tokens[index]!;
      if (token === "--") {
        index += 1;
        break;
      }
      if (wrapper === "env" && assignment.test(token)) {
        index += 1;
        continue;
      }
      if (!token.startsWith("-") || token === "-") break;
      const optionName = token.includes("=") ? token.slice(0, token.indexOf("=")) : token;
      const hasInlineValue = token.includes("=")
        || [...optionsWithValue].some((option) => option.length === 2
          && token.startsWith(option)
          && token.length > option.length);
      index += optionsWithValue.has(optionName) && !hasInlineValue ? 2 : 1;
    }
    return tokens.slice(index);
  };
  const commandTokensKill = (tokens: string[], wrapperDepth = 0): boolean => {
    if (wrapperDepth >= 8 || tokens.length === 0) return wrapperDepth >= 8;
    const command = executableName(tokens[0] ?? "");
    if (!command) return false;
    if (isProcessKill(tokens[0]!)) return true;
    if (["bash", "sh", "zsh"].includes(command)) return nestedShellKills(tokens);
    const remaining = tokens.slice(1);
    if (isCommandWrapper(command)) {
      if (command === "command" && remaining.some((token) => token === "-v" || token === "-V")) {
        return false;
      }
      return commandTokensKill(unwrapCommandWrapper(command, remaining), wrapperDepth + 1);
    }
    if (command === "find") {
      return remaining.some((token, index) => /^-(?:exec|execdir|ok|okdir)$/u.test(token)
        && commandTokensKill(remaining.slice(index + 1), wrapperDepth + 1));
    }
    return false;
  };
  for (const commandSegment of segments) {
    let commandIndex = 0;
    while (assignment.test(commandSegment[commandIndex] ?? "")) commandIndex += 1;
    while (controlPrefixes.has(executableName(commandSegment[commandIndex] ?? "") ?? "")) {
      commandIndex += 1;
      while (assignment.test(commandSegment[commandIndex] ?? "")) commandIndex += 1;
    }
    if (commandTokensKill(commandSegment.slice(commandIndex))) return "process_kill";
  }
  return undefined;
}

export function cccCampaignUnsafeBashProcessReason(
  raw: string,
): CccCampaignUnsafeBashProcessReason | undefined {
  return classifyCccCampaignUnsafeBashProcess(raw, 0);
}

/**
 * Conservatively extract literal filesystem destinations from inline JS run
 * through Bash. Opaque or computed targets remain covered by the mandatory
 * post-execution write-envelope snapshot.
 */
export function cccCampaignVisibleBashWriteTargets(raw: string): string[] {
  const command = raw.replace(/\\(["'])/gu, "$1");
  const targets: string[] = [];
  const redirectTarget = /(?:^|[\s;|])\d*>>?\s*(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s;&|]+))/gu;
  for (const match of command.matchAll(redirectTarget)) {
    const target = match[1] ?? match[2] ?? match[3];
    if (!target || target === "/dev/null" || /^&\d+$/u.test(target) || target.startsWith("(")) continue;
    targets.push(target);
  }
  if (/\b(?:node|bun|deno)\b/u.test(raw)) {
    const singleTarget = /\b(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|mkdir|mkdirSync|rm|rmSync|unlink|unlinkSync|truncate|truncateSync)\s*\(\s*(["'])([^"'\\\r\n]+)\1/gu;
    for (const match of command.matchAll(singleTarget)) targets.push(match[2]!);
    const destinationTarget = /\b(?:copyFile|copyFileSync|cp|cpSync|rename|renameSync)\s*\(\s*(["'])([^"'\\\r\n]+)\1\s*,\s*(["'])([^"'\\\r\n]+)\3/gu;
    for (const match of command.matchAll(destinationTarget)) targets.push(match[4]!);
  }
  const shellCopy = /(?:^|[;&|]\s*|[\r\n]\s*)(?:(?:env|command)\s+)*(?:\S*\/)?cp\s+([^;&|\r\n]+)/gu;
  const shellToken = /"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s]+)/gu;
  for (const match of command.matchAll(shellCopy)) {
    const tokens: string[] = [];
    for (const tokenMatch of (match[1] ?? "").matchAll(shellToken)) {
      const quoted = tokenMatch[1] !== undefined || tokenMatch[2] !== undefined;
      const token = tokenMatch[1] ?? tokenMatch[2] ?? tokenMatch[3] ?? "";
      if (!token) continue;
      const redirectIndex = quoted ? -1 : token.search(/[<>]/u);
      if (redirectIndex < 0) {
        tokens.push(token);
        continue;
      }
      const prefix = token.slice(0, redirectIndex);
      if (prefix && !/^\d+$/u.test(prefix)) tokens.push(prefix);
      break;
    }
    let optionsEnded = false;
    let target: string | undefined;
    const operands: string[] = [];
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index]!;
      if (!optionsEnded && token === "--") {
        optionsEnded = true;
      } else if (!optionsEnded && (token === "-t" || token === "--target-directory")) {
        target = tokens[index + 1];
        break;
      } else if (!optionsEnded && /^-t.+/u.test(token)) {
        target = token.slice(2);
        break;
      } else if (!optionsEnded && token.startsWith("--target-directory=")) {
        target = token.slice("--target-directory=".length);
        break;
      } else if (optionsEnded || token === "-" || !token.startsWith("-")) {
        operands.push(token);
      }
    }
    target ??= operands.length >= 2 ? operands.at(-1) : undefined;
    if (target && !/[`$*?{}()[\]]/u.test(target)) targets.push(target);
  }
  return [...new Set(targets)];
}

/**
 * Extract literal roots from common shell search commands. Campaign workers are
 * worktree-scoped, so a search rooted outside that worktree is never a valid
 * substitute for targeted project discovery. Keep this deliberately narrow:
 * opaque shell syntax remains governed by the normal tool and custody guards.
 */
export function cccCampaignVisibleBashTraversalRoots(raw: string): string[] {
  const command = raw.replace(/\\(["'])/gu, "$1");
  const roots: string[] = [];
  const searchCommand = /(?:^|[;&|]\s*|\$\(\s*)(?:(?:env|command)\s+)*(?:(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s;&|]+))\s+)*(?:\S*\/)?(cd|find|rg|grep)\s+([^;&|\n]+)/gu;
  const tokenPattern = /"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s]+)/gu;
  const searchOptionsWithValue = new Set([
    "-e", "--regexp",
    "-f", "--file",
    "-g", "--glob",
    "--iglob",
    "--type",
    "-t",
    "-T",
    "--type-not",
    "--context",
    "-C",
    "--before-context",
    "-B",
    "--after-context",
    "-A",
    "--max-count",
    "-m",
  ]);
  const expandToken = (token: string): string => {
    if (token === "~" || token.startsWith("~/")) {
      return `${process.env.HOME ?? "/__ccc_unresolved_shell_home__"}${token.slice(1)}`;
    }
    const environment = token.match(/^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))(\/.*)?$/u);
    if (!environment) return token;
    const name = environment[1] ?? environment[2]!;
    const base = process.env[name] ?? `/__ccc_unresolved_shell_variable__/${name}`;
    return `${base}${environment[3] ?? ""}`;
  };
  for (const match of command.matchAll(searchCommand)) {
    const executable = match[1]!;
    const tail = match[2] ?? "";
    const tokens = [...tail.matchAll(tokenPattern)]
      .map((tokenMatch) => tokenMatch[1] ?? tokenMatch[2] ?? tokenMatch[3] ?? "")
      .filter(Boolean);
    if (executable === "cd") {
      const root = tokens.find((token) => token !== "--" && !token.startsWith("-"));
      if (root) roots.push(expandToken(root));
      continue;
    }
    if (executable === "find") {
      let sawRoot = false;
      for (const token of tokens) {
        if (token === "--") continue;
        if (token.startsWith("-")) {
          if (sawRoot) break;
          continue;
        }
        if (/^[A-Za-z_][A-Za-z0-9_]*=.*/u.test(token)) {
          if (sawRoot) break;
          continue;
        }
        if (token.includes("*") || token.includes("?")) continue;
        roots.push(token);
        sawRoot = true;
      }
      continue;
    }
    let sawPattern = false;
    let skipNextOptionValue = false;
    for (const token of tokens) {
      if (token === "--") continue;
      if (skipNextOptionValue) {
        skipNextOptionValue = false;
        continue;
      }
      if (token.startsWith("-")) {
        const optionName = token.includes("=") ? token.slice(0, token.indexOf("=")) : token;
        if (searchOptionsWithValue.has(optionName) && !token.includes("=")) skipNextOptionValue = true;
        if (optionName === "-e" || optionName === "--regexp" || optionName === "-f" || optionName === "--file") {
          sawPattern = true;
        }
        continue;
      }
      if (!sawPattern) {
        sawPattern = true;
        continue;
      }
      if (token === "/dev/null") continue;
      const expanded = expandToken(token);
      if (
        expanded.startsWith("/")
        || expanded === "."
        || expanded === ".."
        || expanded.startsWith("./")
        || expanded.startsWith("../")
      ) {
        roots.push(expanded);
      }
    }
  }
  return [...new Set(roots)];
}
