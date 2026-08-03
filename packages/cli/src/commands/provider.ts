/**
 * `fn provider` -- operator-facing management of custom AI providers.
 *
 * Custom providers live in global settings (`~/.fusion/settings.json`) and are
 * turned into runnable models by `registerCustomProviders`. Before this command
 * the only way to add one was the dashboard's HTTP route, which meant an
 * operator on a headless node had to hand-edit settings JSON and guess the
 * registry key that `--provider` expects.
 *
 * Two things make this command deliberately stricter than the dashboard:
 *
 *  1. **Loopback-only by default.** A custom provider is an egress destination
 *     for prompts. `fn provider add` admits only the single origin shape the
 *     ccc-fusion transport seams accept, unless the operator passes
 *     `--allow-remote` and accepts that CCC PRD authoring will refuse it.
 *  2. **No inline API keys.** A key passed as an argv value leaks into shell
 *     history and `ps` output, so the only accepted input is one line on stdin.
 */

import { randomUUID } from "node:crypto";

import {
  GlobalSettingsStore,
  customProviderRegistryKey,
  type CustomProvider,
  type GlobalSettings,
} from "@fusion/core";

/**
 * Sentinel character the dashboard uses to mask keys for display. A real key is
 * an ASCII/Latin1 credential and never contains it, so its presence means the
 * operator pasted a masked value back instead of the real one. Kept identical
 * to `maskApiKey`/`isMaskedApiKey` in
 * packages/dashboard/src/routes/register-custom-provider-routes.ts -- those
 * helpers are module-private there, so the sentinel is replicated rather than
 * imported.
 */
const API_KEY_MASK_CHAR = "\u2022";

const API_TYPES: readonly CustomProvider["apiType"][] = [
  "openai-compatible",
  "anthropic-compatible",
  "google-generative-ai",
  "openai-responses",
];

export interface ProviderCommandDeps {
  /**
   * Explicit global settings directory. Production omits it so the store
   * resolves `~/.fusion`; tests must pass a temp dir because `resolveGlobalDir`
   * refuses an implicit home under vitest.
   */
  globalDir?: string;
  /** Reads a single line from stdin, for `--api-key-stdin`. */
  readStdinLine?: () => Promise<string>;
}

export type ProviderBaseUrlValidation =
  | { ok: true; url: string }
  | { ok: false; reason: string };

/*
Port of `validateCccLoopbackHttpUrl` from packages/engine/src/ccc-loopback-policy.ts.

The CLI cannot import the original: `@fusion/engine` maps only `.` in its
package `exports`, and the policy module is not re-exported from the engine
barrel. Rather than widen the engine's public surface from this lane, the rule
is duplicated here byte-for-byte, and provider.test.ts pins this function to the
engine original across a table of URLs -- drift fails a test instead of silently
widening what the CLI will admit.
*/
export function validateProviderBaseUrl(raw: unknown): ProviderBaseUrlValidation {
  if (typeof raw !== "string") {
    return { ok: false, reason: "URL must be a string" };
  }
  const match = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})(\/[^/?#][^?#]*)$/.exec(raw);
  if (!match) {
    return {
      ok: false,
      reason: "URL must use literal http://127.0.0.1 with an explicit positive port and path",
    };
  }
  const port = Number(match[1]);
  if (!Number.isInteger(port) || port > 65_535) {
    return { ok: false, reason: "port must be between 1 and 65535" };
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: "URL is invalid" };
  }
  if (
    parsed.protocol !== "http:"
    || parsed.hostname !== "127.0.0.1"
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.search !== ""
    || parsed.hash !== ""
  ) {
    return { ok: false, reason: "URL is outside the ccc-fusion loopback boundary" };
  }
  return { ok: true, url: raw };
}

function isMaskedApiKey(value: string): boolean {
  return value.includes(API_KEY_MASK_CHAR);
}

/** Expand `--flag=value` into `--flag value` so every flag parses one way. */
function normalizeArgs(args: string[]): string[] {
  const normalized: string[] = [];
  for (const arg of args) {
    if (arg.startsWith("--") && arg.includes("=")) {
      const splitAt = arg.indexOf("=");
      normalized.push(arg.slice(0, splitAt), arg.slice(splitAt + 1));
      continue;
    }
    normalized.push(arg);
  }
  return normalized;
}

class ProviderCommandError extends Error {}

function fail(message: string): never {
  throw new ProviderCommandError(message);
}

interface ParsedFlags {
  values: Map<string, string[]>;
  booleans: Set<string>;
  positionals: string[];
}

/**
 * Parse argv against an explicit flag allowlist. Unknown flags are refused
 * rather than dropped, so a typo can never quietly produce a provider that
 * differs from what the operator asked for.
 */
function parseFlags(
  args: string[],
  valueFlags: readonly string[],
  booleanFlags: readonly string[],
): ParsedFlags {
  const values = new Map<string, string[]>();
  const booleans = new Set<string>();
  const positionals: string[] = [];

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;

    if (arg === "--api-key") {
      fail(
        "--api-key is never accepted: an argv value leaks into shell history and ps output. "
          + "Pipe the key on stdin with --api-key-stdin instead.",
      );
    }
    if (arg === "--id") {
      fail("--id is not accepted: provider ids are generated so they stay globally unique.");
    }

    if (!arg.startsWith("-")) {
      positionals.push(arg);
      continue;
    }

    if (booleanFlags.includes(arg)) {
      booleans.add(arg);
      continue;
    }

    if (!valueFlags.includes(arg)) {
      fail(`unknown flag ${arg}`);
    }

    const value = args[index + 1];
    if (value === undefined || value.startsWith("-")) {
      fail(`${arg} requires a value`);
    }
    values.set(arg, [...(values.get(arg) ?? []), value]);
    index += 1;
  }

  return { values, booleans, positionals };
}

function singleValue(parsed: ParsedFlags, flag: string): string | undefined {
  const found = parsed.values.get(flag);
  if (!found) {
    return undefined;
  }
  if (found.length > 1) {
    fail(`${flag} may only be given once`);
  }
  return found[0];
}

/**
 * Parse `--model <id>[:<name>]`. Model ids commonly contain a colon
 * (`gpt-oss:20b`), so a literal colon inside an id is written `\:`.
 */
function parseModelSpec(
  spec: string,
): { id: string; name: string; maxTokens?: number; contextWindow?: number } {
  let id = "";
  let name: string | undefined;

  for (let index = 0; index < spec.length; index++) {
    const char = spec[index]!;
    if (char === "\\" && spec[index + 1] === ":") {
      id += ":";
      index += 1;
      continue;
    }
    if (char === ":") {
      name = spec.slice(index + 1);
      break;
    }
    id += char;
  }

  if (id.trim().length === 0) {
    fail(`--model ${spec} is missing a model id`);
  }
  const resolvedName = name?.trim();
  if (name !== undefined && (resolvedName === undefined || resolvedName.length === 0)) {
    fail(`--model ${spec} has an empty display name`);
  }

  return { id: id.trim(), name: resolvedName ?? id.trim() };
}

/**
 * Parse an optional positive-integer limit flag. A malformed value fails the
 * command rather than being dropped, so the stored provider always matches
 * what the operator asked for.
 */
function parseModelLimit(parsed: ParsedFlags, flag: string): number | undefined {
  const raw = singleValue(parsed, flag);
  if (raw === undefined) {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail(`${flag} must be a positive integer, got ${raw}`);
  }
  return value;
}

async function readStdinLineDefault(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk as Buffer));
    const joined = Buffer.concat(chunks);
    const newline = joined.indexOf(0x0a);
    if (newline !== -1) {
      return joined.subarray(0, newline).toString("utf-8");
    }
  }
  return Buffer.concat(chunks).toString("utf-8");
}

async function openSettingsStore(deps: ProviderCommandDeps): Promise<GlobalSettingsStore> {
  const store = new GlobalSettingsStore(deps.globalDir);
  await store.init();
  return store;
}

function readProviders(settings: GlobalSettings): CustomProvider[] {
  return Array.isArray(settings.customProviders) ? [...settings.customProviders] : [];
}

function describeModels(provider: CustomProvider): string {
  if (!provider.models || provider.models.length === 0) {
    return "none";
  }
  return provider.models
    .map((model) => (model.name === model.id ? model.id : `${model.id} (${model.name})`))
    .join(", ");
}

/**
 * Print one provider. The API key is reported only as present or absent -- the
 * CLI never prints key fragments, not even the dashboard's partial mask.
 */
function printProvider(provider: CustomProvider, registryKey: string): void {
  console.log(`  ${provider.name}`);
  console.log(`    registry key: ${registryKey} - pass this as --provider`);
  console.log(`    id: ${provider.id}`);
  console.log(`    apiType: ${provider.apiType}`);
  console.log(`    baseUrl: ${provider.baseUrl}`);
  console.log(`    apiKey: ${provider.apiKey ? "set (masked)" : "not set"}`);
  console.log(`    models: ${describeModels(provider)}`);
}

function printReregistrationHint(): void {
  console.log(
    "Restart a running fn serve, daemon, or dashboard to pick this up: those processes "
      + "re-register custom providers from their own settings writes, and do not watch this file.",
  );
}

async function runProviderList(args: string[], deps: ProviderCommandDeps): Promise<number> {
  const parsed = parseFlags(args, [], ["--json"]);
  if (parsed.positionals.length > 0) {
    fail(`fn provider list takes no arguments (got ${parsed.positionals[0]})`);
  }

  const store = await openSettingsStore(deps);
  const providers = readProviders(await store.getSettings());

  if (parsed.booleans.has("--json")) {
    console.log(JSON.stringify({
      providers: providers.map((provider) => ({
        registryKey: customProviderRegistryKey(provider, providers),
        id: provider.id,
        name: provider.name,
        apiType: provider.apiType,
        baseUrl: provider.baseUrl,
        apiKeySet: Boolean(provider.apiKey),
        models: provider.models ?? [],
      })),
    }, null, 2));
    return 0;
  }

  if (providers.length === 0) {
    console.log("No custom providers configured. Add one with: fn provider add --name <name> --base-url <url>");
    return 0;
  }

  console.log(`Custom providers (${providers.length}):`);
  console.log();
  for (const provider of providers) {
    printProvider(provider, customProviderRegistryKey(provider, providers));
    console.log();
  }
  return 0;
}

async function runProviderAdd(args: string[], deps: ProviderCommandDeps): Promise<number> {
  const parsed = parseFlags(
    args,
    ["--name", "--base-url", "--api-type", "--model", "--max-tokens", "--context-window"],
    ["--api-key-stdin", "--allow-remote"],
  );
  if (parsed.positionals.length > 0) {
    fail(`unexpected argument ${parsed.positionals[0]}`);
  }

  const name = singleValue(parsed, "--name")?.trim();
  if (!name) {
    fail("--name is required");
  }

  const baseUrl = singleValue(parsed, "--base-url")?.trim();
  if (!baseUrl) {
    fail("--base-url is required");
  }

  const allowRemote = parsed.booleans.has("--allow-remote");
  const validation = validateProviderBaseUrl(baseUrl);
  if (!validation.ok && !allowRemote) {
    fail(
      `--base-url ${baseUrl} is outside the ccc-fusion loopback boundary: ${validation.reason}. `
        + "Pass --allow-remote to add it anyway.",
    );
  }

  const apiTypeValue = singleValue(parsed, "--api-type") ?? "openai-compatible";
  if (!API_TYPES.includes(apiTypeValue as CustomProvider["apiType"])) {
    fail(`--api-type must be one of: ${API_TYPES.join(", ")}`);
  }
  const apiType = apiTypeValue as CustomProvider["apiType"];

  const models = (parsed.values.get("--model") ?? []).map(parseModelSpec);

  // Stage 4 finding (2026-08-02): the registry hardcoded 16384/128000 for every
  // custom-provider model, truncating long structured responses against local
  // backends with different real windows. These provider-level flags stamp the
  // declared limits onto every model entry of this registration.
  const maxTokens = parseModelLimit(parsed, "--max-tokens");
  const contextWindow = parseModelLimit(parsed, "--context-window");
  if ((maxTokens !== undefined || contextWindow !== undefined) && models.length === 0) {
    fail("--max-tokens/--context-window apply to model entries; pass at least one --model");
  }
  for (const model of models) {
    if (maxTokens !== undefined) model.maxTokens = maxTokens;
    if (contextWindow !== undefined) model.contextWindow = contextWindow;
  }

  let apiKey: string | undefined;
  if (parsed.booleans.has("--api-key-stdin")) {
    const raw = await (deps.readStdinLine ?? readStdinLineDefault)();
    const trimmed = raw.replace(/\r?\n$/, "").trim();
    if (trimmed.length === 0) {
      fail("--api-key-stdin was given but stdin contained no key");
    }
    if (isMaskedApiKey(trimmed)) {
      fail("the value on stdin looks like a masked key copied from the dashboard; paste the real key");
    }
    apiKey = trimmed;
  }

  const provider: CustomProvider = {
    id: randomUUID(),
    name,
    apiType,
    baseUrl,
  };
  if (apiKey) {
    provider.apiKey = apiKey;
  }
  if (models.length > 0) {
    provider.models = models;
  }

  const store = await openSettingsStore(deps);
  const existing = readProviders(await store.getSettings());
  const next = [...existing, provider];
  await store.updateSettings({ customProviders: next });

  // Recompute over the full list: a name that collides with an existing
  // provider is suffixed, so the key echoed here must come from the same
  // derivation the model registry will use.
  const registryKey = customProviderRegistryKey(provider, next);

  console.log(`Added custom provider "${provider.name}"`);
  console.log();
  printProvider(provider, registryKey);
  console.log();

  if (!validation.ok) {
    console.log(
      `warning: ${baseUrl} is not a loopback address (${validation.reason}). `
        + "CCC PRD authoring and understanding will refuse this provider, because only "
        + "loopback custom providers are admitted there.",
    );
    console.log();
  }

  printReregistrationHint();
  return 0;
}

async function runProviderRemove(args: string[], deps: ProviderCommandDeps): Promise<number> {
  const parsed = parseFlags(args, [], ["--yes"]);
  if (parsed.positionals.length === 0) {
    fail("fn provider remove requires a registry key or id");
  }
  if (parsed.positionals.length > 1) {
    fail(`fn provider remove takes one selector (got ${parsed.positionals.length})`);
  }
  const selector = parsed.positionals[0]!;

  const store = await openSettingsStore(deps);
  const providers = readProviders(await store.getSettings());

  const matches = providers.filter(
    (provider) =>
      provider.id === selector || customProviderRegistryKey(provider, providers) === selector,
  );

  if (matches.length === 0) {
    fail(`no custom provider matches "${selector}". List them with: fn provider list`);
  }
  if (matches.length > 1) {
    console.error(`"${selector}" is ambiguous - it matches ${matches.length} providers:`);
    for (const match of matches) {
      console.error(
        `  ${match.name} (registry key ${customProviderRegistryKey(match, providers)}, id ${match.id})`,
      );
    }
    fail("re-run with the id of the exact provider to remove");
  }

  const target = matches[0]!;
  const registryKey = customProviderRegistryKey(target, providers);

  console.log("Will remove:");
  printProvider(target, registryKey);
  console.log();

  if (!parsed.booleans.has("--yes")) {
    fail(`refusing to remove without confirmation; re-run with --yes to remove "${registryKey}"`);
  }

  await store.updateSettings({
    customProviders: providers.filter((provider) => provider.id !== target.id),
  });

  console.log(`Removed custom provider "${target.name}" (registry key ${registryKey}).`);
  console.log();
  printReregistrationHint();
  return 0;
}

const USAGE = `Usage:
  fn provider list [--json]
  fn provider add --name <name> --base-url <url> [--api-type <type>] [--model <id>[:<name>]]... [--max-tokens <n>] [--context-window <n>] [--api-key-stdin] [--allow-remote]
  fn provider remove <registry-key|id> [--yes]`;

/**
 * Dispatch a `fn provider` invocation. Returns the process exit code rather
 * than calling `process.exit`, so bin.ts owns termination.
 */
export async function runProviderCommand(
  args: string[],
  deps: ProviderCommandDeps = {},
): Promise<number> {
  const normalized = normalizeArgs(args);
  const subcommand = normalized[0] ?? "list";
  const rest = normalized.slice(1);

  try {
    switch (subcommand) {
      case "list":
      case "ls":
        return await runProviderList(rest, deps);
      case "add":
        return await runProviderAdd(rest, deps);
      case "remove":
      case "rm":
        return await runProviderRemove(rest, deps);
      default:
        fail(`unknown provider subcommand "${subcommand}"`);
    }
  } catch (error) {
    if (error instanceof ProviderCommandError) {
      console.error(`Error: ${error.message}`);
      console.error(USAGE);
      return 1;
    }
    throw error;
  }
}
