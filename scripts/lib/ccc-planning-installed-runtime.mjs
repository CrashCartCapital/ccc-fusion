/*
FNXC:CccPlanningInstalledRuntime 2026-10-14-21:13:
Installed-runtime receipt for the planning proof (card IP, CONTRACT-v3.3 section 3.2 IP, section 2.20, D26, D48, 0.25; ADR D Q2). It packs the CLI from a committed tree, installs the tarball with `--ignore-scripts` under an isolated HOME, and writes `ccc-planning.installed-runtime.v1`. Four claims are derived from bytes and never assumed:
- `distManifestSha256` is the SHA-256 of the canonical JSON of the sorted `[relativePath, sha256]` pairs of every installed js file under `dist`, so one changed byte in one installed file changes it.
- `piAi.workspacePatch` is read from the installed pi-ai `openai-completions.js`: the pnpm patch adds the `identitySubstantive` marker, an npm install of the registry copy does not carry it. (CCC_PI_AI_PATCH_MARKER is pinned to the checked-in patch by a test.)
- `piAi.shipping` is `external` only when the packed manifest lists pi-ai as an exactly pinned runtime dependency, no tsup `noExternal` rule would bundle it, and the packed receipt adapter still imports it instead of inlining it.
- `piAi.keepaliveModelSource` is always `fusion-receipt-adapter` and is refused unless the installed adapter exists: the keepalive model rule lives in Fusion's adapter (`dist/ccc-route-receipt-adapter.js`), not in a pi-ai patch the packed install does not carry.
The verifier recomputes every digest from the installed tree and refuses unknown or missing keys. It cannot see the tsup config, so for `shipping` it uses the packed manifest and the adapter bytes; the capture step additionally applies the `noExternal` rules.

Layout (E9 IP item 1, section 4.2 step 1 literally: `node scripts/ccc-planning-install-runtime.mjs "$ROOT/install"`): the argument is the INSTALL directory and the runtime root is its parent. fn lands at `<installDir>/node_modules/.bin/fn`, the packed tarball in `<root>/evidence/pack`, HOME at `<root>/home`, and the receipt at `<root>/evidence/installed-runtime.json`. Only the install directory must be missing or empty (the root may already hold other things), and the run refuses before any git, pnpm or npm step when the receipt file already exists.
*/
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  CCC_INSTALLED_FN_ENV_ALLOWLIST,
  packAndInstallFusionCli,
  runCheckedCommand,
  runInstalledFnProcess,
} from "./ccc-installed-cli.mjs";

const execFileAsync = promisify(execFile);

export const CCC_PLANNING_INSTALLED_RUNTIME_SCHEMA = "ccc-planning.installed-runtime.v1";
export const CCC_PLANNING_INSTALLED_RUNTIME_INVALID = "CCC_PLANNING_INSTALLED_RUNTIME_INVALID";
export const CCC_PLANNING_INSTALLED_SOURCE_DIRTY = "CCC_PLANNING_INSTALLED_SOURCE_DIRTY";
/** A line the checked-in pi-ai patch adds and the registry copy lacks. */
export const CCC_PI_AI_PATCH_MARKER = "identitySubstantive";

const PI_AI_NAME = "@earendil-works/pi-ai";
const PI_AI_PINNED_VERSION = "0.81.1";
const KEEPALIVE_MODEL_SOURCE = "fusion-receipt-adapter";
const ADAPTER_API_MARKER = "ccc-terminal-route-receipt.v1";
const ADAPTER_ROUTE_COMMENT_MARKER = "x-omniroute-";
/** A hang bound for one `fn --version` or `fn plan` probe of the installed CLI, not a measured duration. */
const FN_PROBE_TIMEOUT_MS = 60_000;

const RECEIPT_KEYS = Object.freeze([
  "distManifestSha256", "executablePath", "executableSha256", "installedRoot", "packageName", "packageVersion",
  "piAi", "planCommand", "runtimeBoundary", "schema", "source", "tarballPath", "tarballSha256", "toolchain",
  "versionOutput", "versionOutputSha256",
]);
const PI_AI_KEYS = Object.freeze(["keepaliveModelSource", "openaiCompletionsSha256", "shipping", "version", "workspacePatch"]);
const SOURCE_KEYS = Object.freeze(["capturedBeforeBuild", "gitHead", "gitTree", "workingTreeDirty"]);
const TOOLCHAIN_KEYS = Object.freeze(["node", "npm", "pnpm"]);
const RUNTIME_BOUNDARY = Object.freeze({ fullInstalledRuntime: "daemon_process", sourceInProcessScheduler: "not_used" });
const PLAN_COMMAND = Object.freeze({ helpExitCode: 0, usageExitCode: 2 });

export class CccPlanningInstalledRuntimeError extends Error {
  constructor(code, field, detail) {
    super(`${code}: ${field}: ${detail}`);
    this.name = "CccPlanningInstalledRuntimeError";
    this.code = code;
    this.field = field;
  }
}

const invalid = (field, detail) => new CccPlanningInstalledRuntimeError(CCC_PLANNING_INSTALLED_RUNTIME_INVALID, field, detail);
const sha256Of = (value) => createHash("sha256").update(value).digest("hex");
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const GIT_OBJECT_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

async function sha256File(filePath, field) {
  try {
    return sha256Of(await readFile(filePath));
  } catch (error) {
    throw invalid(field, `cannot read ${filePath}: ${error.message}`);
  }
}

async function collectJsFiles(distRoot, relative, found) {
  const entries = await readdir(path.join(distRoot, relative), { withFileTypes: true });
  for (const entry of entries) {
    const entryRelative = relative === "" ? entry.name : `${relative}/${entry.name}`;
    if (entry.isSymbolicLink()) throw invalid("distManifestSha256", `dist holds a symbolic link: ${entryRelative}`);
    if (entry.isDirectory()) await collectJsFiles(distRoot, entryRelative, found);
    else if (entry.isFile() && entry.name.endsWith(".js")) found.push(entryRelative);
  }
}

/** SHA-256 over the canonical JSON of the sorted `[relativePath, sha256]` pairs of every `*.js` file under `distRoot`. */
export async function computeCccInstalledDistManifestSha256(distRoot) {
  const files = [];
  try {
    await collectJsFiles(distRoot, "", files);
  } catch (error) {
    if (error instanceof CccPlanningInstalledRuntimeError) throw error;
    throw invalid("distManifestSha256", `cannot read the installed dist at ${distRoot}: ${error.message}`);
  }
  if (files.length === 0) throw invalid("distManifestSha256", `the installed dist at ${distRoot} holds no js file`);
  files.sort();
  const pairs = [];
  for (const relative of files) pairs.push([relative, await sha256File(path.join(distRoot, relative), "distManifestSha256")]);
  return sha256Of(JSON.stringify(pairs));
}

/** `carried` only when the installed pi-ai file bytes hold the marker the pnpm patch adds. */
export function classifyCccPiAiWorkspacePatch(openaiCompletionsText) {
  return typeof openaiCompletionsText === "string" && openaiCompletionsText.includes(CCC_PI_AI_PATCH_MARKER) ? "carried" : "not_carried";
}

function skipTrivia(text, start) {
  let index = start;
  for (;;) {
    while (index < text.length && /\s/u.test(text[index])) index += 1;
    if (text.startsWith("//", index)) {
      const end = text.indexOf("\n", index);
      index = end === -1 ? text.length : end + 1;
    } else if (text.startsWith("/*", index)) {
      const end = text.indexOf("*/", index + 2);
      if (end === -1) throw invalid("noExternal", "unterminated comment inside a noExternal array");
      index = end + 2;
    } else {
      return index;
    }
  }
}

function readQuoted(text, start) {
  const quote = text[start];
  let value = "";
  let index = start + 1;
  while (index < text.length && text[index] !== quote) {
    if (text[index] === "\\") index += 1;
    if (text[index] === "\n") break;
    value += text[index];
    index += 1;
  }
  if (text[index] !== quote) throw invalid("noExternal", "unterminated string inside a noExternal array");
  return { value, next: index + 1 };
}

function readRegexLiteral(text, start) {
  let index = start + 1;
  let inClass = false;
  while (index < text.length) {
    const char = text[index];
    if (char === "\n") break;
    if (char === "\\") index += 2;
    else if (char === "[") { inClass = true; index += 1; }
    else if (char === "]") { inClass = false; index += 1; }
    else if (char === "/" && !inClass) break;
    else index += 1;
  }
  if (text[index] !== "/") throw invalid("noExternal", "unterminated regular expression inside a noExternal array");
  const source = text.slice(start + 1, index);
  let flagsEnd = index + 1;
  while (flagsEnd < text.length && /[a-z]/u.test(text[flagsEnd])) flagsEnd += 1;
  try {
    return { value: new RegExp(source, text.slice(index + 1, flagsEnd)), next: flagsEnd };
  } catch (error) {
    throw invalid("noExternal", `unreadable regular expression /${source}/: ${error.message}`);
  }
}

/** Every string and regular-expression rule of every `noExternal: [...]` array in the tsup config text; anything else in an array is refused. */
export function parseCccCliNoExternalRules(tsupConfigText) {
  const rules = [];
  const opener = /noExternal\s*:\s*\[/gu;
  let match;
  let arrays = 0;
  while ((match = opener.exec(tsupConfigText)) !== null) {
    arrays += 1;
    let index = match.index + match[0].length;
    for (;;) {
      index = skipTrivia(tsupConfigText, index);
      const char = tsupConfigText[index];
      if (char === "]") { index += 1; break; }
      let element;
      if (char === "'" || char === '"') element = readQuoted(tsupConfigText, index);
      else if (char === "/") element = readRegexLiteral(tsupConfigText, index);
      else throw invalid("noExternal", `a noExternal rule is neither a string nor a regular expression literal near: ${tsupConfigText.slice(index, index + 40).split("\n")[0]}`);
      rules.push(element.value);
      index = skipTrivia(tsupConfigText, element.next);
      if (tsupConfigText[index] === ",") index += 1;
      else if (tsupConfigText[index] !== "]") throw invalid("noExternal", "a noExternal array is not a plain list of literals");
    }
    opener.lastIndex = index;
  }
  if (arrays === 0) throw invalid("noExternal", "the tsup config holds no noExternal array to read");
  return rules;
}

function ruleBundles(rule, name) {
  if (typeof rule === "string") return rule === name || name.startsWith(`${rule}/`);
  if (rule instanceof RegExp) return new RegExp(rule.source, rule.flags.replace(/[gy]/gu, "")).test(name);
  return false;
}

/**
 * `external` | `not_declared` | `version_not_pinned` | `bundled`, from the packed manifest and the tsup rules.
 * A runtime dependency with an exact version that no `noExternal` rule matches is what a registry install resolves on its own.
 */
export function deriveCccPiAiShipping(input) {
  const declared = input.packageJson?.dependencies?.[PI_AI_NAME];
  if (typeof declared !== "string") return "not_declared";
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(declared)) return "version_not_pinned";
  if ((input.noExternal ?? []).some((rule) => ruleBundles(rule, PI_AI_NAME))) return "bundled";
  return "external";
}

async function readJson(file, field) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw invalid(field, `cannot read ${file}: ${error.message}`);
  }
}

async function locatePiAiRoot(installedRoot) {
  const candidates = [
    path.join(installedRoot, "node_modules", "@earendil-works", "pi-ai"),
    path.join(path.dirname(path.dirname(installedRoot)), "@earendil-works", "pi-ai"),
  ];
  for (const candidate of candidates) {
    try {
      await readFile(path.join(candidate, "package.json"));
      return candidate;
    } catch {
      // try the next candidate
    }
  }
  throw invalid("piAi.version", "the installed tree holds no @earendil-works/pi-ai package");
}

/** The `piAi` receipt block, derived from the packed manifest, the tsup rules, the installed adapter and the installed pi-ai bytes. */
export async function deriveCccPiAiReceiptBlock(input) {
  const packageJson = await readJson(path.join(input.installedRoot, "package.json"), "packageName");
  const shipping = deriveCccPiAiShipping({ packageJson, noExternal: input.noExternal });
  if (shipping !== "external") {
    throw invalid("piAi.shipping", `pi-ai ships as ${shipping}; the packed manifest must list ${PI_AI_NAME} as an exactly pinned dependency that no noExternal rule bundles`);
  }
  const adapterPath = path.join(input.installedRoot, "dist", "ccc-route-receipt-adapter.js");
  let adapterText;
  try {
    adapterText = await readFile(adapterPath, "utf8");
  } catch (error) {
    throw invalid("piAi.keepaliveModelSource", `the installed receipt adapter is missing (${error.message})`);
  }
  if (!adapterText.includes(ADAPTER_API_MARKER) || !adapterText.includes(ADAPTER_ROUTE_COMMENT_MARKER)) {
    throw invalid("piAi.keepaliveModelSource", "the installed receipt adapter does not carry the terminal route receipt rule");
  }
  if (!adapterText.includes(PI_AI_NAME)) {
    throw invalid("piAi.shipping", "the installed receipt adapter does not import pi-ai, so pi-ai is bundled into it");
  }
  const piAiRoot = await locatePiAiRoot(input.installedRoot);
  const piAiManifest = await readJson(path.join(piAiRoot, "package.json"), "piAi.version");
  if (piAiManifest.version !== PI_AI_PINNED_VERSION) {
    throw invalid("piAi.version", `installed pi-ai is ${String(piAiManifest.version)}, expected ${PI_AI_PINNED_VERSION}`);
  }
  const completionsPath = path.join(piAiRoot, "dist", "api", "openai-completions.js");
  let completionsBytes;
  try {
    completionsBytes = await readFile(completionsPath);
  } catch (error) {
    throw invalid("piAi.openaiCompletionsSha256", `cannot read ${completionsPath}: ${error.message}`);
  }
  return {
    version: PI_AI_PINNED_VERSION,
    shipping,
    workspacePatch: classifyCccPiAiWorkspacePatch(completionsBytes.toString("utf8")),
    keepaliveModelSource: KEEPALIVE_MODEL_SOURCE,
    openaiCompletionsSha256: sha256Of(completionsBytes),
  };
}

async function probeInstalledFn(executablePath, home, args) {
  await mkdir(home, { recursive: true });
  return runInstalledFnProcess({ executablePath, args, cwd: home, home, extraEnv: {}, timeoutMs: FN_PROBE_TIMEOUT_MS });
}

async function readInstalledVersionOutput(executablePath, home) {
  const result = await probeInstalledFn(executablePath, home, ["--version"]);
  const versionOutput = result.stdout.trim();
  if (result.exitCode !== 0 || versionOutput === "") {
    throw invalid("versionOutput", `installed fn --version exited ${result.exitCode} with ${versionOutput === "" ? "no output" : "output"}`);
  }
  return versionOutput;
}

function assertSource(source, fieldPrefix) {
  if (!isRecord(source)) throw invalid(fieldPrefix, "source provenance is not an object");
  for (const key of Object.keys(source)) {
    if (!SOURCE_KEYS.includes(key)) throw invalid(`${fieldPrefix}.${key}`, "unknown source key");
  }
  for (const key of SOURCE_KEYS) {
    if (!(key in source)) throw invalid(`${fieldPrefix}.${key}`, "missing source key");
  }
  if (!GIT_OBJECT_PATTERN.test(source.gitHead)) throw invalid(`${fieldPrefix}.gitHead`, "not a git object id");
  if (!GIT_OBJECT_PATTERN.test(source.gitTree)) throw invalid(`${fieldPrefix}.gitTree`, "not a git object id");
  if (source.workingTreeDirty !== false) throw invalid(`${fieldPrefix}.workingTreeDirty`, "an exact candidate must be a committed tree");
  if (source.capturedBeforeBuild !== true) throw invalid(`${fieldPrefix}.capturedBeforeBuild`, "provenance must be captured before the build");
}

function assertToolchain(toolchain, fieldPrefix) {
  if (!isRecord(toolchain)) throw invalid(fieldPrefix, "toolchain is not an object");
  for (const key of Object.keys(toolchain)) {
    if (!TOOLCHAIN_KEYS.includes(key)) throw invalid(`${fieldPrefix}.${key}`, "unknown toolchain key");
  }
  for (const key of TOOLCHAIN_KEYS) {
    if (typeof toolchain[key] !== "string" || toolchain[key] === "") throw invalid(`${fieldPrefix}.${key}`, "missing toolchain version");
  }
}

/** Capture the receipt from an installed tree. Refuses any claim it cannot derive from the installed bytes. */
export async function captureCccPlanningInstalledRuntimeReceipt(input) {
  assertSource(input.source, "source");
  assertToolchain(input.toolchain, "toolchain");
  const packageJson = await readJson(path.join(input.installedRoot, "package.json"), "packageName");
  if (packageJson.name !== "@runfusion/fusion" || typeof packageJson.version !== "string") {
    throw invalid("packageName", "the installed package is not @runfusion/fusion");
  }
  const piAi = await deriveCccPiAiReceiptBlock({ installedRoot: input.installedRoot, noExternal: input.noExternal });
  const distManifestSha256 = await computeCccInstalledDistManifestSha256(path.join(input.installedRoot, "dist"));
  const versionOutput = await readInstalledVersionOutput(input.executablePath, input.home);
  const help = await probeInstalledFn(input.executablePath, input.home, ["plan", "--help"]);
  const usage = await probeInstalledFn(input.executablePath, input.home, ["plan"]);
  if (help.exitCode !== PLAN_COMMAND.helpExitCode || usage.exitCode !== PLAN_COMMAND.usageExitCode) {
    throw invalid("planCommand", `installed fn plan --help exited ${help.exitCode} (want 0) and fn plan exited ${usage.exitCode} (want 2)`);
  }
  return {
    schema: CCC_PLANNING_INSTALLED_RUNTIME_SCHEMA,
    source: { ...input.source },
    toolchain: { ...input.toolchain },
    tarballPath: input.tarballPath,
    tarballSha256: await sha256File(input.tarballPath, "tarballSha256"),
    installedRoot: input.installedRoot,
    packageName: packageJson.name,
    packageVersion: packageJson.version,
    executablePath: input.executablePath,
    executableSha256: await sha256File(input.executablePath, "executableSha256"),
    distManifestSha256,
    versionOutput,
    versionOutputSha256: sha256Of(versionOutput),
    planCommand: { ...PLAN_COMMAND },
    piAi,
    runtimeBoundary: { ...RUNTIME_BOUNDARY },
  };
}

function assertReceiptShape(receipt) {
  if (!isRecord(receipt)) throw invalid("receipt", "the receipt is not a JSON object");
  for (const key of Object.keys(receipt)) {
    if (!RECEIPT_KEYS.includes(key)) throw invalid(key, "unknown receipt key");
  }
  for (const key of RECEIPT_KEYS) {
    if (!(key in receipt)) throw invalid(key, "missing receipt key");
  }
  if (receipt.schema !== CCC_PLANNING_INSTALLED_RUNTIME_SCHEMA) throw invalid("schema", `expected ${CCC_PLANNING_INSTALLED_RUNTIME_SCHEMA}`);
  if (!isRecord(receipt.piAi)) throw invalid("piAi", "the piAi block is not an object");
  for (const key of Object.keys(receipt.piAi)) {
    if (!PI_AI_KEYS.includes(key)) throw invalid(`piAi.${key}`, "unknown piAi key");
  }
  for (const key of PI_AI_KEYS) {
    if (!(key in receipt.piAi)) throw invalid(`piAi.${key}`, "missing piAi key");
  }
  if (receipt.piAi.keepaliveModelSource !== KEEPALIVE_MODEL_SOURCE) {
    throw invalid("piAi.keepaliveModelSource", `must be ${KEEPALIVE_MODEL_SOURCE}`);
  }
  assertSource(receipt.source, "source");
  assertToolchain(receipt.toolchain, "toolchain");
  for (const key of ["tarballPath", "installedRoot", "executablePath"]) {
    if (typeof receipt[key] !== "string" || !path.isAbsolute(receipt[key])) throw invalid(key, "must be an absolute path");
  }
  for (const key of ["tarballSha256", "executableSha256", "distManifestSha256", "versionOutputSha256"]) {
    if (typeof receipt[key] !== "string" || !SHA256_PATTERN.test(receipt[key])) throw invalid(key, "must be a lowercase SHA-256");
  }
  if (!SHA256_PATTERN.test(receipt.piAi.openaiCompletionsSha256 ?? "")) throw invalid("piAi.openaiCompletionsSha256", "must be a lowercase SHA-256");
  if (receipt.packageName !== "@runfusion/fusion") throw invalid("packageName", "must be @runfusion/fusion");
  if (typeof receipt.packageVersion !== "string" || receipt.packageVersion === "") throw invalid("packageVersion", "must be a version string");
  if (typeof receipt.versionOutput !== "string" || receipt.versionOutput === "") throw invalid("versionOutput", "must be the installed fn --version output");
  if (sha256Of(receipt.versionOutput) !== receipt.versionOutputSha256) throw invalid("versionOutputSha256", "does not match versionOutput");
  if (JSON.stringify(receipt.planCommand) !== JSON.stringify(PLAN_COMMAND)) throw invalid("planCommand", "must record help exit 0 and usage exit 2");
  if (JSON.stringify(receipt.runtimeBoundary) !== JSON.stringify(RUNTIME_BOUNDARY)) throw invalid("runtimeBoundary", "must record the daemon process boundary");
  if (receipt.piAi.shipping !== "external") throw invalid("piAi.shipping", "must be external");
  if (receipt.piAi.version !== PI_AI_PINNED_VERSION) throw invalid("piAi.version", `must be ${PI_AI_PINNED_VERSION}`);
  if (receipt.piAi.workspacePatch !== "carried" && receipt.piAi.workspacePatch !== "not_carried") {
    throw invalid("piAi.workspacePatch", "must be carried or not_carried");
  }
}

/** Recompute every digest and every derived claim from the installed tree; the first mismatch is named by field. */
export async function verifyCccPlanningInstalledRuntimeReceipt(receiptPath) {
  let text;
  try {
    text = await readFile(receiptPath, "utf8");
  } catch (error) {
    throw invalid("receipt", `cannot read ${receiptPath}: ${error.message}`);
  }
  let receipt;
  try {
    receipt = JSON.parse(text);
  } catch (error) {
    throw invalid("receipt", `${receiptPath} is not JSON: ${error.message}`);
  }
  assertReceiptShape(receipt);
  if (await sha256File(receipt.tarballPath, "tarballSha256") !== receipt.tarballSha256) throw invalid("tarballSha256", "the packed tarball changed");
  const packageJson = await readJson(path.join(receipt.installedRoot, "package.json"), "packageName");
  if (packageJson.name !== receipt.packageName) throw invalid("packageName", "the installed package name changed");
  if (packageJson.version !== receipt.packageVersion) throw invalid("packageVersion", "the installed package version changed");
  if (await sha256File(receipt.executablePath, "executableSha256") !== receipt.executableSha256) throw invalid("executableSha256", "the installed fn executable changed");
  if (await computeCccInstalledDistManifestSha256(path.join(receipt.installedRoot, "dist")) !== receipt.distManifestSha256) {
    throw invalid("distManifestSha256", "an installed dist file changed");
  }
  const piAi = await deriveCccPiAiReceiptBlock({ installedRoot: receipt.installedRoot, noExternal: [] });
  if (piAi.openaiCompletionsSha256 !== receipt.piAi.openaiCompletionsSha256) throw invalid("piAi.openaiCompletionsSha256", "the installed pi-ai openai-completions.js changed");
  if (piAi.workspacePatch !== receipt.piAi.workspacePatch) throw invalid("piAi.workspacePatch", `the installed pi-ai bytes say ${piAi.workspacePatch}`);
  if (piAi.shipping !== receipt.piAi.shipping) throw invalid("piAi.shipping", `the packed manifest says ${piAi.shipping}`);
  if (piAi.version !== receipt.piAi.version) throw invalid("piAi.version", `the installed pi-ai is ${piAi.version}`);
  const scratchHome = await mkdtemp(path.join(tmpdir(), "ccc-planning-verify-home-"));
  try {
    const versionOutput = await readInstalledVersionOutput(receipt.executablePath, scratchHome);
    if (sha256Of(versionOutput) !== receipt.versionOutputSha256) throw invalid("versionOutputSha256", "the installed fn --version output changed");
  } finally {
    await rm(scratchHome, { recursive: true, force: true });
  }
  return receipt;
}

async function defaultGit(args, options) {
  const { stdout } = await execFileAsync("git", args, { cwd: options.cwd, maxBuffer: 16 * 1024 * 1024 });
  return { stdout };
}

function allowlistedEnv() {
  return Object.fromEntries(CCC_INSTALLED_FN_ENV_ALLOWLIST.filter((name) => typeof process.env[name] === "string").map((name) => [name, process.env[name]]));
}

async function defaultReadToolchain(input) {
  const env = allowlistedEnv();
  const cwd = path.resolve(input.cliRoot);
  return {
    node: process.version,
    npm: runCheckedCommand("npm", ["--version"], { cwd, env, label: "npm --version", allowStderr: true }),
    pnpm: runCheckedCommand("corepack", ["pnpm", "--version"], { cwd, env, label: "pnpm --version", allowStderr: true }),
  };
}

async function defaultReadNoExternal(input) {
  return parseCccCliNoExternalRules(await readFile(path.join(path.resolve(input.cliRoot), "tsup.config.ts"), "utf8"));
}

/** Where the planning proof puts everything, from the install directory step 1 receives (its parent is the runtime root). */
export function resolveCccPlanningInstalledRuntimePaths(installDirInput) {
  if (typeof installDirInput !== "string" || installDirInput === "") throw invalid("install", "the install directory is required");
  const installDir = path.resolve(installDirInput);
  const root = path.dirname(installDir);
  return {
    root,
    installDir,
    packDir: path.join(root, "evidence", "pack"),
    homeDir: path.join(root, "home"),
    evidenceDir: path.join(root, "evidence"),
    receiptPath: path.join(root, "evidence", "installed-runtime.json"),
  };
}

async function assertEmptyInstallDir(installDir) {
  let entries;
  try {
    entries = await readdir(installDir);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw invalid("install", `cannot read the install directory ${installDir}: ${error.message}`);
  }
  if (entries.length > 0) throw invalid("install", `the install directory ${installDir} is not empty`);
}

async function assertNoEarlierReceipt(receiptPath) {
  try {
    await lstat(receiptPath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw invalid("receipt", `cannot check ${receiptPath}: ${error.message}`);
  }
  throw invalid("receipt", `${receiptPath} already exists; a receipt is written once, so use a fresh runtime root`);
}

/**
 * Refuse a used install directory, an earlier receipt and a dirty tracked tree, read provenance and toolchain, then pack, install and capture.
 * Everything that can refuse runs before the build starts. `input.installDir` is step 1's argument (its parent is the runtime root).
 * `deps` replaces git, the toolchain read, the tsup read, the pack step and the capture.
 */
export async function prepareCccPlanningInstalledRuntime(input, deps = {}) {
  const resolved = {
    git: defaultGit,
    readToolchain: defaultReadToolchain,
    readNoExternal: defaultReadNoExternal,
    packAndInstall: packAndInstallFusionCli,
    capture: captureCccPlanningInstalledRuntimeReceipt,
    ...deps,
  };
  const paths = resolveCccPlanningInstalledRuntimePaths(input.installDir);
  await assertEmptyInstallDir(paths.installDir);
  await assertNoEarlierReceipt(paths.receiptPath);
  const gitOptions = { cwd: input.repoRoot };
  const status = await resolved.git(["status", "--porcelain", "--untracked-files=no"], gitOptions);
  const gitHead = (await resolved.git(["rev-parse", "HEAD"], gitOptions)).stdout.trim();
  const gitTree = (await resolved.git(["rev-parse", "HEAD^{tree}"], gitOptions)).stdout.trim();
  const toolchain = await resolved.readToolchain(input);
  const noExternal = await resolved.readNoExternal(input);
  if (status.stdout.trim() !== "") {
    throw new CccPlanningInstalledRuntimeError(CCC_PLANNING_INSTALLED_SOURCE_DIRTY, "source", "the tracked source tree has uncommitted changes; an exact candidate must be a committed tree");
  }
  const layout = { packDir: paths.packDir, installDir: paths.installDir, homeDir: paths.homeDir };
  const installed = await resolved.packAndInstall({
    root: paths.root,
    cliRoot: input.cliRoot,
    env: allowlistedEnv(),
    layout,
    npmMode: input.npmMode ?? "offline-first",
    ...(input.toolCaches ? { toolCaches: input.toolCaches } : {}),
    installProjectName: "ccc-planning-installed-runtime",
  });
  return resolved.capture({
    tarballPath: installed.tarballPath,
    installedRoot: installed.installedRoot,
    executablePath: installed.executablePath,
    home: installed.home,
    source: { gitHead, gitTree, workingTreeDirty: false, capturedBeforeBuild: true },
    toolchain,
    noExternal,
  });
}
