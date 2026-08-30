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
