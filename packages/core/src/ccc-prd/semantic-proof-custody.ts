import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants, existsSync } from "node:fs";
import { access, chmod, lstat, mkdir, mkdtemp, open, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, isAbsolute, normalize, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { isAlias, isMap, isScalar, isSeq, parseDocument, type Node, type Pair } from "yaml";
import { resolveGitBinary } from "../git-binary.js";
import {
  canonicalCccPrdJson,
  computeCccPrdCandidateInputsSha256,
  computeCccPrdProofDefinitionSha256,
  computeCccPrdProofExecutionToolchainSha256,
  computeCccPrdProofV2AdmissionDigests,
} from "./contract.js";
import type {
  CccPrdExecutableIdentity,
  CccPrdLinkedRuntimeEntry,
  CccPrdPythonExecutionToolchain,
  CccPrdPythonRuntimeFile,
  CccPrdProofExecutionToolchain,
  CccPrdProofV2,
  CccPrdVerifierClosureEntry,
} from "./types.js";

const execFile = promisify(execFileCallback);
const VERIFY_TARGET = /^verify:[a-z0-9][a-z0-9:-]{0,63}$/u;
const PROOF_COMMAND = /^task (verify:[a-z0-9][a-z0-9:-]{0,63})$/u;
const TARGET_COMMAND_TOKEN = /^[A-Za-z0-9._/-]+$/u;
const TOP_LEVEL_TASKFILE_KEYS = new Set(["version", "tasks"]);
const TARGET_KEYS = new Set(["cmds"]);
const LOWER_SHA256 = /^[0-9a-f]{64}$/u;
const GIT_COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const EXECUTABLE_VERSION_ARGS = Object.freeze(["--version"] as const);
const PYTHON_VERSION_ARGS = Object.freeze(["-S", "--version"] as const);
const OTOOL_TIMEOUT_MS = 10_000;
const MAX_PYTHON_RUNTIME_ROOTS = 16;
const MAX_PYTHON_RUNTIME_FILES = 200_000;
const MAX_PYTHON_RUNTIME_BYTES = 1024 * 1024 * 1024;
const MAX_PYTHON_DISCOVERY_BYTES = 64 * 1024 * 1024;
const MAX_PYTHON_DYLIB_CLOSURE_FILES = 256;
const PYTHON_REQUESTED_PATH = /^(?:\/|@(rpath|loader_path|executable_path)\/)[^\0\\\s]+$/u;
const MACH_O_MAGICS = new Set([
  0xfeedface,
  0xcefaedfe,
  0xfeedfacf,
  0xcffaedfe,
  0xcafebabe,
  0xbebafeca,
  0xcafebabf,
  0xbfbafeca,
]);

export const CCC_PRD_SEMANTIC_PROOF_HOST_ID =
  "fusion-cli-semantic-proof-host.v1" as const;
export const CCC_PRD_SEMANTIC_PROOF_CUSTODY_REFUSED =
  "CCC_PRD_SEMANTIC_PROOF_CUSTODY_REFUSED" as const;

export class CccPrdSemanticProofCustodyError extends Error {
  readonly code = CCC_PRD_SEMANTIC_PROOF_CUSTODY_REFUSED;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CccPrdSemanticProofCustodyError";
  }
}

export type CccPrdSemanticProofToolchainPaths = Readonly<{
  taskExecutablePath: string;
  nodeExecutablePath: string;
  /** Required only when a proof opts into verifierProfile/python-adapter.v1. */
  pythonExecutablePath?: string;
  /** Controller-selected absolute import roots, such as a target .venv site-packages directory. */
  pythonPathRoots?: readonly string[];
  proofHost: Readonly<{
    id: typeof CCC_PRD_SEMANTIC_PROOF_HOST_ID;
    executablePath: string;
  }>;
}>;

export type CccPrdSemanticProofCustodyInput = Readonly<{
  repositoryRoot: string;
  baseCommit: string;
  proofs: readonly CccPrdProofV2[];
  modelWriteRoots: readonly string[];
  toolchainPaths: CccPrdSemanticProofToolchainPaths;
}>;

function custodyRefusal(message: string, cause?: unknown): never {
  throw new CccPrdSemanticProofCustodyError(
    message,
    cause === undefined ? undefined : { cause },
  );
}

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalRelativePath(path: string, label: string): string {
  if (
    path.length === 0
    || path.includes("\\")
    || isAbsolute(path)
    || normalize(path) !== path
    || path === "."
    || path === ".."
    || path.startsWith(`..${sep}`)
    || path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    custodyRefusal(`${label} must be a canonical target-relative path: ${path}`);
  }
  return path;
}

function isSameOrWithin(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

function scrubbedGitEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  ]) {
    delete env[key];
  }
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
  return env;
}

async function gitBytes(
  repositoryRoot: string,
  baseCommit: string,
  path: string,
): Promise<{ bytes: Buffer; oid: string }> {
  if (!GIT_COMMIT.test(baseCommit)) {
    custodyRefusal(`CCC semantic-proof base commit is malformed: ${baseCommit}`);
  }
  const git = await resolveGitBinary();
  let treeOutput: Buffer;
  try {
    const result = await execFile(
      git,
      ["-C", repositoryRoot, "ls-tree", "-z", "--full-tree", baseCommit, "--", path],
      {
        encoding: "buffer",
        env: scrubbedGitEnvironment(),
        maxBuffer: 1024 * 1024,
        timeout: 10_000,
        windowsHide: true,
      },
    );
    treeOutput = result.stdout;
  } catch (error) {
    custodyRefusal(`CCC semantic-proof could not read frozen Git custody for ${path}`, error);
  }
  const tree = treeOutput.toString("utf8");
  const match = /^(100644|100755) blob ([0-9a-f]{40}|[0-9a-f]{64})\t([^\0]+)\0$/u.exec(tree);
  if (!match || match[3] !== path) {
    custodyRefusal(
      `CCC semantic-proof path is missing, non-regular, or ambiguous at ${baseCommit}: ${path}`,
    );
  }
  const oid = match[2]!;
  try {
    const result = await execFile(
      git,
      ["-C", repositoryRoot, "cat-file", "blob", oid],
      {
        encoding: "buffer",
        env: scrubbedGitEnvironment(),
        maxBuffer: 16 * 1024 * 1024,
        timeout: 10_000,
        windowsHide: true,
      },
    );
    return { bytes: result.stdout, oid };
  } catch (error) {
    custodyRefusal(`CCC semantic-proof could not read frozen Git blob ${oid} for ${path}`, error);
  }
}

function plainScalar(node: Node | null | undefined, label: string): string {
  if (!isScalar(node) || typeof node.value !== "string" || node.anchor) {
    custodyRefusal(`CCC semantic-proof Taskfile ${label} must be one literal string`);
  }
  return node.value;
}

function mapEntries(node: Node | null | undefined, label: string): Map<string, Node | null> {
  if (!isMap(node) || node.anchor) {
    custodyRefusal(`CCC semantic-proof Taskfile ${label} must be a literal mapping`);
  }
  const result = new Map<string, Node | null>();
  for (const pair of node.items) {
    const key = plainScalar(pair.key as Node, `${label} key`);
    if (result.has(key)) {
      custodyRefusal(`CCC semantic-proof Taskfile ${label} duplicates ${key}`);
    }
    result.set(key, pair.value as Node | null);
  }
  return result;
}

function parseLiteralCommand(command: string): string[] {
  if (
    command.trim() !== command
    || /[;&|`$<>\n\r\t'"\\*?{}()[\]!~]/u.test(command)
  ) {
    custodyRefusal("CCC semantic-proof Task target command must be literal and substitution-free");
  }
  const tokens = command.split(" ");
  if (
    tokens.some((token) => token.length === 0 || !TARGET_COMMAND_TOKEN.test(token))
    || tokens.length < 3
    || tokens[0] !== "node"
  ) {
    custodyRefusal(
      "CCC semantic-proof Task target must invoke Node, one harness, and literal candidates",
    );
  }
  return tokens;
}

function parsePythonLiteralCommand(command: string): string[] {
  if (
    command.trim() !== command
    || /[;&|`$<>\n\r\t'"\\*?{}()[\]!~]/u.test(command)
  ) {
    custodyRefusal("CCC semantic-proof Python Task target command must be literal and substitution-free");
  }
  const tokens = command.split(" ");
  if (
    tokens.length !== 4
    || tokens[0] !== "python3"
    || tokens[2] !== "--target"
    || tokens.some((token) => token.length === 0 || !TARGET_COMMAND_TOKEN.test(token))
  ) {
    custodyRefusal(
      "CCC semantic-proof Python Task target must be exactly python3 <adapter> --target <target>",
    );
  }
  return tokens;
}

function assertNoAliases(node: unknown): void {
  if (isAlias(node) || (node && typeof node === "object" && "anchor" in node && node.anchor)) {
    custodyRefusal("CCC semantic-proof Taskfile aliases and anchors are forbidden");
  }
  if (isMap(node)) {
    for (const item of node.items as readonly Pair[]) {
      assertNoAliases(item.key);
      assertNoAliases(item.value);
    }
  } else if (isSeq(node)) {
    for (const item of node.items as readonly unknown[]) assertNoAliases(item);
  }
}

function verifyStrictTaskTarget(
  targetName: string,
  targetNode: Node | null | undefined,
  pythonProfile = false,
): string[] {
  if (!VERIFY_TARGET.test(targetName)) {
    custodyRefusal(`CCC semantic-proof Taskfile target must be verify:* only: ${targetName}`);
  }
  const target = mapEntries(targetNode, `target ${targetName}`);
  for (const key of target.keys()) {
    if (!TARGET_KEYS.has(key)) {
      const noun = key === "deps" ? "dependencies" : key;
      custodyRefusal(`CCC semantic-proof Task target ${noun} behavior is forbidden`);
    }
  }
  const commands = target.get("cmds");
  if (!isSeq(commands) || commands.anchor || commands.items.length !== 1) {
    custodyRefusal("CCC semantic-proof Task target must contain exactly one literal command");
  }
  const tokens = pythonProfile
    ? parsePythonLiteralCommand(plainScalar(commands.items[0] as Node, "command"))
    : parseLiteralCommand(plainScalar(commands.items[0] as Node, "command"));
  return [
    tokens[0]!,
    ...tokens.slice(1).map((path) => canonicalRelativePath(
      path,
      `CCC semantic-proof Task target ${targetName} path`,
    )),
  ];
}

function verifyTaskfile(bytes: Buffer, proof: CccPrdProofV2): void {
  const commandMatch = PROOF_COMMAND.exec(proof.command);
  if (!commandMatch) {
    custodyRefusal("CCC semantic-proof command must name exactly one task verify target");
  }
  const document = parseDocument(bytes.toString("utf8"), {
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0 || document.warnings.length > 0 || !document.contents) {
    custodyRefusal("CCC semantic-proof Taskfile is malformed or ambiguous YAML");
  }
  assertNoAliases(document.contents);
  const root = mapEntries(document.contents, "root");
  for (const key of root.keys()) {
    if (!TOP_LEVEL_TASKFILE_KEYS.has(key)) {
      custodyRefusal(`CCC semantic-proof Taskfile ${key} behavior is forbidden`);
    }
  }
  plainScalar(root.get("version"), "version");
  const tasks = mapEntries(root.get("tasks"), "tasks");
  const selectedTarget = commandMatch[1]!;
  if (!tasks.has(selectedTarget)) {
    custodyRefusal("CCC semantic-proof Taskfile does not declare the selected verify target");
  }
  const pythonProfile = proof.verifierProfile?.schema === "ccc-prd.verifier.python-adapter.v1";
  const tokens = verifyStrictTaskTarget(selectedTarget, tasks.get(selectedTarget), pythonProfile);
  const harnesses = proof.verifierClosure
    .filter((entry) => entry.role === "harness")
    .map((entry) => entry.path);
  if (pythonProfile) {
    const profile = proof.verifierProfile!;
    const fixtures = proof.verifierClosure
      .filter((entry) => entry.role === "fixture")
      .map((entry) => entry.path);
    if (
      tokens.length !== 4
      || tokens[1] !== profile.adapterPath
      || tokens[3] !== profile.targetPath
      || harnesses.length !== 1
      || !harnesses.includes(profile.adapterPath)
      || !fixtures.some((path) => path.startsWith(`${profile.targetPath}/`))
    ) {
      custodyRefusal("CCC semantic-proof Python adapter and target must be closure-owned");
    }
    return;
  }
  if (harnesses.length !== 1 || tokens[1] !== harnesses[0]) {
    custodyRefusal("CCC semantic-proof Task target must invoke the one declared harness");
  }
  const candidates = tokens.slice(2);
  if (
    candidates.length !== proof.candidateInputs.length
    || computeCccPrdCandidateInputsSha256(candidates)
      !== computeCccPrdCandidateInputsSha256(proof.candidateInputs)
  ) {
    custodyRefusal("CCC semantic-proof Task target candidate arguments differ from declared inputs");
  }
}

async function inspectSealedExecutableVersion(
  identity: StaticExecutableIdentity,
  sealedPath: string,
  launch: (path: string) => Promise<{ stdout: Buffer; stderr: Buffer }>,
): Promise<CccPrdExecutableIdentity> {
  let stdout: Buffer;
  let stderr: Buffer;
  try {
    ({ stdout, stderr } = await launch(sealedPath));
  } catch (error) {
    custodyRefusal(`CCC semantic-proof executable --version probe failed: ${identity.executablePath}`, error);
  }
  const versionOutput = Buffer.concat([stdout, stderr]);
  const version = versionOutput.toString("utf8").trim();
  if (version.length === 0) {
    custodyRefusal(`CCC semantic-proof executable version output is empty: ${identity.executablePath}`);
  }
  return {
    ...identity,
    version,
    versionOutputSha256: sha256(versionOutput),
  };
}

type StaticExecutableIdentity = Pick<
  CccPrdExecutableIdentity,
  "executablePath" | "executableSha256"
>;

type StaticToolchainIdentity = {
  task: StaticExecutableIdentity;
  node: StaticExecutableIdentity;
  proofHost: StaticExecutableIdentity & { id: typeof CCC_PRD_SEMANTIC_PROOF_HOST_ID };
  python?: StaticExecutableIdentity & {
    runtimeManifest: CccPrdPythonExecutionToolchain["runtimeManifest"];
  };
};

async function inspectExecutableBytes(
  executablePath: string,
): Promise<StaticExecutableIdentity & { executableBytes: Buffer }> {
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(executablePath);
    const metadata = await lstat(canonicalPath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("not a regular file");
    await access(canonicalPath, fsConstants.X_OK);
  } catch (error) {
    custodyRefusal(`CCC semantic-proof executable is unavailable: ${executablePath}`, error);
  }
  const handle = await open(canonicalPath, "r");
  let bytes: Buffer;
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error("not a regular file");
    bytes = await handle.readFile();
  } catch (error) {
    custodyRefusal(`CCC semantic-proof executable bytes could not be read: ${canonicalPath}`, error);
  } finally {
    await handle.close();
  }
  return {
    executablePath: canonicalPath,
    executableSha256: sha256(bytes),
    executableBytes: bytes,
  };
}

async function resolveControllerPythonExecutable(
  requestedPath: string,
): Promise<StaticExecutableIdentity & { executableBytes: Buffer }> {
  let stdout: Buffer;
  try {
    ({ stdout } = await execFile(
      requestedPath,
      ["-S", "-c", "import os,sys; print(os.path.realpath(sys.executable))"],
      {
        ...versionOptions(),
        env: {
          ...versionOptions().env,
          PYTHONNOUSERSITE: "1",
        },
      },
    ));
  } catch (error) {
    custodyRefusal(`CCC semantic-proof Python controller executable could not resolve its interpreter: ${requestedPath}`, error);
  }
  const resolvedPath = stdout.toString("utf8").trim().split("\n").at(-1)?.trim() ?? "";
  if (!isAbsolute(resolvedPath) || !/^(?:python3(?:\.\d+)*|Python)$/u.test(basename(resolvedPath))) {
    custodyRefusal(`CCC semantic-proof Python controller executable resolved to an unsupported interpreter: ${resolvedPath}`);
  }
  const frameworkExecutable = resolve(
    dirname(resolvedPath),
    "../Resources/Python.app/Contents/MacOS/Python",
  );
  if (existsSync(frameworkExecutable)) return inspectExecutableBytes(frameworkExecutable);
  return inspectExecutableBytes(resolvedPath);
}

async function inspectPythonRuntimeFile(
  entry: CccPrdPythonRuntimeFile,
  label: string,
): Promise<CccPrdPythonRuntimeFile> {
  if (!isAbsolute(entry.path) || !LOWER_SHA256.test(entry.sha256)) {
    custodyRefusal(`CCC semantic-proof Python ${label} manifest entry is malformed`);
  }
  if (
    entry.requestedPaths !== undefined
    && (
      entry.requestedPaths.length === 0
      || entry.requestedPaths.length > 16
      || entry.requestedPaths.some((requestedPath) => (
        !PYTHON_REQUESTED_PATH.test(requestedPath)
      ))
      || new Set(entry.requestedPaths).size !== entry.requestedPaths.length
    )
  ) {
    custodyRefusal(`CCC semantic-proof Python ${label} requested paths are malformed`);
  }
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(entry.path);
    if (canonicalPath !== entry.path) throw new Error("symlinked runtime path");
    const metadata = await lstat(canonicalPath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("not a regular file");
  } catch (error) {
    custodyRefusal(`CCC semantic-proof Python ${label} runtime file is unavailable: ${entry.path}`, error);
  }
  const handle = await open(canonicalPath, "r");
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error("not a regular file");
    const bytes = await handle.readFile();
    const observed = sha256(bytes);
    if (observed !== entry.sha256) {
      custodyRefusal(`CCC semantic-proof Python ${label} runtime digest drifted: ${entry.path}`);
    }
  } catch (error) {
    if (error instanceof CccPrdSemanticProofCustodyError) throw error;
    custodyRefusal(`CCC semantic-proof Python ${label} runtime file could not be read: ${entry.path}`, error);
  } finally {
    await handle.close();
  }
  return {
    path: canonicalPath,
    sha256: entry.sha256,
    ...(entry.requestedPaths ? { requestedPaths: [...entry.requestedPaths].sort() } : {}),
  };
}

async function observePythonRuntimeFile(
  path: string,
  label: string,
): Promise<CccPrdPythonRuntimeFile> {
  if (!isAbsolute(path)) custodyRefusal(`CCC semantic-proof Python ${label} runtime path is not absolute: ${path}`);
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(path);
    if (canonicalPath !== path) throw new Error("symlinked runtime path");
    const metadata = await lstat(canonicalPath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("not a regular file");
  } catch (error) {
    custodyRefusal(`CCC semantic-proof Python ${label} runtime file is unavailable: ${path}`, error);
  }
  const handle = await open(canonicalPath, "r");
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error("not a regular file");
    return { path: canonicalPath, sha256: sha256(await handle.readFile()) };
  } catch (error) {
    custodyRefusal(`CCC semantic-proof Python ${label} runtime file could not be read: ${path}`, error);
  } finally {
    await handle.close();
  }
}

async function isDarwinMachOFile(path: string): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  const handle = await open(path, "r");
  try {
    const bytes = Buffer.alloc(4);
    const result = await handle.read(bytes, 0, bytes.length, 0);
    if (result.bytesRead < 4) return false;
    return MACH_O_MAGICS.has(bytes.readUInt32BE(0)) || MACH_O_MAGICS.has(bytes.readUInt32LE(0));
  } finally {
    await handle.close();
  }
}

async function inspectPythonRuntimeRoot(
  root: string,
  label: string,
): Promise<string> {
  if (
    !isAbsolute(root)
    || root.length === 0
    || root !== root.trim()
    || root.endsWith(sep)
  ) {
    custodyRefusal(`CCC semantic-proof Python ${label} root is malformed: ${root}`);
  }
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(root);
    if (canonicalRoot !== root) throw new Error("symlinked runtime root");
    const metadata = await lstat(canonicalRoot);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("not a regular directory");
  } catch (error) {
    custodyRefusal(`CCC semantic-proof Python ${label} root is unavailable: ${root}`, error);
  }
  return canonicalRoot;
}

async function inspectControllerPythonPathRoots(
  roots: readonly string[] | undefined,
): Promise<string[]> {
  if (roots === undefined) return [];
  if (!Array.isArray(roots) || roots.length > MAX_PYTHON_RUNTIME_ROOTS) {
    custodyRefusal("CCC semantic-proof Python controller path roots are unbounded");
  }
  const observed: string[] = [];
  for (const [index, root] of roots.entries()) {
    if (typeof root !== "string" || root.includes(delimiter)) {
      custodyRefusal(`CCC semantic-proof Python controller path root is malformed: ${String(root)}`);
    }
    const canonicalRoot = await inspectPythonRuntimeRoot(root, `controller PYTHONPATH[${index}]`);
    if (observed.includes(canonicalRoot)) {
      custodyRefusal(`CCC semantic-proof Python controller path root is duplicated: ${canonicalRoot}`);
    }
    observed.push(canonicalRoot);
  }
  return observed.sort();
}

function assertPythonRuntimeRootMembership(
  manifest: CccPrdPythonExecutionToolchain["runtimeManifest"],
): void {
  const rootSet = [
    manifest.stdlibRoot,
    manifest.pythonHomeRoot,
    ...manifest.sitePackagesRoots,
    ...manifest.extensionModuleRoots,
  ];
  if (
    new Set(manifest.sitePackagesRoots).size !== manifest.sitePackagesRoots.length
    || new Set(manifest.extensionModuleRoots).size !== manifest.extensionModuleRoots.length
    || new Set(rootSet).size > MAX_PYTHON_RUNTIME_ROOTS + 1
  ) {
    custodyRefusal("CCC semantic-proof Python runtime roots are unbounded or duplicated");
  }
  if (!isSameOrWithin(manifest.stdlibRoot, manifest.pythonHomeRoot)) {
    custodyRefusal("CCC semantic-proof Python stdlib root escapes pythonHomeRoot");
  }
  const requireWithin = (
    entries: readonly CccPrdPythonRuntimeFile[],
    roots: readonly string[],
    label: string,
  ): void => {
    for (const entry of entries) {
      if (!roots.some((root) => isSameOrWithin(entry.path, root))) {
        custodyRefusal(`CCC semantic-proof Python ${label} escapes its declared runtime roots: ${entry.path}`);
      }
    }
  };
  requireWithin(manifest.stdlib, [manifest.stdlibRoot], "stdlib");
  requireWithin(manifest.sitePackages, manifest.sitePackagesRoots, "site-packages");
  requireWithin(manifest.extensionModules, manifest.extensionModuleRoots, "extension module");
}

async function discoverPythonRuntimeManifest(
  pythonExecutablePath: string,
  controllerPythonPathRoots: readonly string[] = [],
): Promise<CccPrdPythonExecutionToolchain["runtimeManifest"]> {
  const discoveryRoot = await mkdtemp(join(tmpdir(), "ccc-python-runtime-discovery-"));
  const discoveryPath = join(discoveryRoot, "manifest.json");
  const script = [
    "import json, os, sys, sysconfig",
    "paths = sysconfig.get_paths()",
    "stdlib_root = os.path.realpath(paths.get('stdlib') or '')",
    "python_home_root = os.path.realpath(sys.prefix)",
    "controller_roots = sorted({path for path in os.environ.get('PYTHONPATH', '').split(os.pathsep) if path})",
    "if any(not os.path.isabs(path) or not os.path.isdir(path) for path in controller_roots): raise RuntimeError('controller PYTHONPATH roots must be existing absolute directories')",
    "sys_path_roots = sorted({os.path.realpath(path) for path in sys.path if path and os.path.isabs(path) and os.path.isdir(path) and os.path.realpath(path) in controller_roots})",
    "if sys_path_roots != sorted({os.path.realpath(path) for path in controller_roots}): raise RuntimeError('controller PYTHONPATH roots were not admitted by sys.path')",
    "site_roots = sorted({os.path.realpath(paths[k]) for k in ('purelib', 'platlib') if paths.get(k)} | set(sys_path_roots))",
    "extension_roots = [stdlib_root, *site_roots]",
    "framework_python = os.path.realpath(os.path.join(os.path.dirname(sys.executable), '..', 'Resources', 'Python.app', 'Contents', 'MacOS', 'Python'))",
    "runtime_support = [framework_python] if os.path.isfile(framework_python) and not os.path.islink(framework_python) else []",
    `max_files = ${MAX_PYTHON_RUNTIME_FILES}`,
    `max_bytes = ${MAX_PYTHON_RUNTIME_BYTES}`,
    "seen = set()",
    "total_files = 0",
    "total_bytes = 0",
    "def files(root):",
    "  global total_files, total_bytes",
    "  out = []",
    "  if not root or not os.path.isdir(root): return out",
    "  for base, dirs, names in os.walk(root, followlinks=False):",
    "    dirs[:] = sorted(d for d in dirs if not os.path.islink(os.path.join(base, d)))",
    "    for name in sorted(names):",
    "      path = os.path.join(base, name)",
    "      if os.path.isfile(path) and not os.path.islink(path):",
    "        canonical = os.path.realpath(path)",
    "        if canonical not in seen:",
    "          seen.add(canonical)",
    "          total_files += 1",
    "          total_bytes += os.path.getsize(canonical)",
    "          if total_files > max_files or total_bytes > max_bytes:",
    "            raise RuntimeError('Python runtime exceeds controller sealing bounds')",
    "        out.append(canonical)",
    "  return sorted(set(out))",
    "payload = {'stdlibRoot': stdlib_root, 'pythonHomeRoot': python_home_root, 'sitePackagesRoots': site_roots, 'extensionModuleRoots': extension_roots, 'controllerPathRoots': sys_path_roots, 'runtimeSupport': runtime_support, 'stdlib': files(stdlib_root), 'purelib': files(paths.get('purelib')), 'platlib': files(paths.get('platlib')), 'pythonpath': sorted({path for root in sys_path_roots for path in files(root)})}",
    "with open(sys.argv[1], 'x', encoding='utf-8') as output:",
    "  json.dump(payload, output, separators=(',', ':'))",
  ].join("\n");
  try {
    await execFile(
      pythonExecutablePath,
      ["-S", "-c", script, discoveryPath],
      {
        ...versionOptions(),
        env: {
          ...versionOptions().env,
          PYTHONNOUSERSITE: "1",
          ...(controllerPythonPathRoots.length > 0
            ? { PYTHONPATH: controllerPythonPathRoots.join(delimiter) }
            : {}),
        },
      },
    );
  } catch (error) {
    await rm(discoveryRoot, { recursive: true, force: true });
    custodyRefusal("CCC semantic-proof Python runtime manifest could not be discovered within controller bounds", error);
  }
  let discoveryBytes: Buffer;
  try {
    const metadata = await lstat(discoveryPath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_PYTHON_DISCOVERY_BYTES) {
      throw new Error("discovery manifest is missing, symlinked, or oversized");
    }
    discoveryBytes = await readFile(discoveryPath);
  } catch (error) {
    await rm(discoveryRoot, { recursive: true, force: true });
    custodyRefusal("CCC semantic-proof Python runtime manifest discovery output is unavailable", error);
  }
  await rm(discoveryRoot, { recursive: true, force: true });
  let discovered: Record<string, unknown>;
  try {
    discovered = JSON.parse(discoveryBytes.toString("utf8")) as Record<string, unknown>;
  } catch (error) {
    custodyRefusal("CCC semantic-proof Python runtime manifest discovery was malformed", error);
  }
  const filesFor = async (key: string): Promise<CccPrdPythonRuntimeFile[]> => {
    const values = discovered[key];
    if (!Array.isArray(values)) custodyRefusal(`CCC semantic-proof Python runtime discovery omitted ${key}`);
    const observed: CccPrdPythonRuntimeFile[] = [];
    for (const [index, value] of values.entries()) {
      if (typeof value !== "string") custodyRefusal(`CCC semantic-proof Python runtime discovery ${key}[${index}] is malformed`);
      observed.push(await observePythonRuntimeFile(value, `${key}[${index}]`));
    }
    return observed;
  };
  if (typeof discovered.stdlibRoot !== "string") {
    custodyRefusal("CCC semantic-proof Python runtime discovery omitted stdlibRoot");
  }
  if (!Array.isArray(discovered.sitePackagesRoots) || !Array.isArray(discovered.extensionModuleRoots)) {
    custodyRefusal("CCC semantic-proof Python runtime discovery omitted bounded import roots");
  }
  if (!Array.isArray(discovered.controllerPathRoots) || !Array.isArray(discovered.pythonpath)) {
    custodyRefusal("CCC semantic-proof Python runtime discovery omitted controller PYTHONPATH custody");
  }
  const stdlibRoot = await inspectPythonRuntimeRoot(discovered.stdlibRoot, "stdlib");
  if (typeof discovered.pythonHomeRoot !== "string") {
    custodyRefusal("CCC semantic-proof Python runtime discovery omitted pythonHomeRoot");
  }
  const pythonHomeRoot = await inspectPythonRuntimeRoot(discovered.pythonHomeRoot, "python home");
  const sitePackagesRoots = await Promise.all(discovered.sitePackagesRoots.map((root, index) => {
    if (typeof root !== "string") custodyRefusal(`CCC semantic-proof Python runtime discovery sitePackagesRoots[${index}] is malformed`);
    return inspectPythonRuntimeRoot(root, `site-packages[${index}]`);
  }));
  const extensionModuleRoots = await Promise.all(discovered.extensionModuleRoots.map((root, index) => {
    if (typeof root !== "string") custodyRefusal(`CCC semantic-proof Python runtime discovery extensionModuleRoots[${index}] is malformed`);
    return inspectPythonRuntimeRoot(root, `extension-module[${index}]`);
  }));
  const controllerPathRoots = discovered.controllerPathRoots.map((root, index) => {
    if (typeof root !== "string") custodyRefusal(`CCC semantic-proof Python runtime discovery controllerPathRoots[${index}] is malformed`);
    return root;
  });
  if (canonicalCccPrdJson(controllerPathRoots) !== canonicalCccPrdJson(controllerPythonPathRoots)) {
    custodyRefusal("CCC semantic-proof Python controller PYTHONPATH custody drifted during discovery");
  }
  const runtimeSupport = await filesFor("runtimeSupport");
  const uniqueFiles = (entries: readonly CccPrdPythonRuntimeFile[]): CccPrdPythonRuntimeFile[] => [
    ...new Map(entries.map((entry) => [entry.path, entry])).values(),
  ].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const stdlib = uniqueFiles(await filesFor("stdlib"));
  const purelib = uniqueFiles(await filesFor("purelib"));
  const platlib = uniqueFiles(await filesFor("platlib"));
  const pythonpath = uniqueFiles(await filesFor("pythonpath"));
  const extensionModules = uniqueFiles([...purelib, ...platlib, ...pythonpath, ...stdlib]
    .filter((entry) => /\.(?:so|dylib|pyd|dll)(?:\.[0-9.]+)?$/u.test(entry.path)));
  const extensionSet = new Set(extensionModules.map((entry) => entry.path));
  const sitePackages = uniqueFiles([...purelib, ...platlib, ...pythonpath].filter((entry) => !extensionSet.has(entry.path)));
  const dylibClosure = process.platform === "darwin"
    ? await discoverDarwinPythonDylibClosure(
      pythonExecutablePath,
      [...stdlib, ...sitePackages, ...extensionModules].map((entry) => entry.path),
    )
    : [];
  const interpreterIdentity = await inspectExecutableBytes(pythonExecutablePath);
  const manifest: CccPrdPythonExecutionToolchain["runtimeManifest"] = {
    schema: "ccc-prd.python-runtime-manifest.v1",
    interpreter: {
      path: interpreterIdentity.executablePath,
      sha256: interpreterIdentity.executableSha256,
    },
    stdlibRoot,
    pythonHomeRoot,
    sitePackagesRoots,
      extensionModuleRoots,
      runtimeSupport,
      stdlib,
    sitePackages,
    extensionModules,
    dylibClosure,
  };
  assertPythonRuntimeRootMembership(manifest);
  return manifest;
}

function darwinSystemRuntimePath(path: string): boolean {
  return path.startsWith("/usr/lib/") || path.startsWith("/System/Library/");
}

async function discoverDarwinPythonDylibClosure(
  executablePath: string,
  additionalLoaders: readonly string[] = [],
): Promise<CccPrdPythonRuntimeFile[]> {
  const entries = new Map<string, CccPrdPythonRuntimeFile>();
  const visited = new Set<string>();
  const queue = [executablePath, ...additionalLoaders];
  while (queue.length > 0) {
    const loaderPath = queue.shift()!;
    if (visited.has(loaderPath)) continue;
    visited.add(loaderPath);
    if (!(await isDarwinMachOFile(loaderPath))) continue;
    let stdout: string;
    try {
      ({ stdout } = await execFile("/usr/bin/otool", ["-L", loaderPath], {
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        timeout: OTOOL_TIMEOUT_MS,
        windowsHide: true,
      }));
    } catch (error) {
      custodyRefusal(`CCC semantic-proof Python dylib closure inspection failed: ${loaderPath}`, error);
    }
    for (const line of stdout.split("\n").slice(1)) {
      const requestedPath = line.trim().split(/\s+/u)[0];
      if (!requestedPath || darwinSystemRuntimePath(requestedPath)) continue;
      const linkedPath = resolveDarwinLinkedPath(requestedPath, loaderPath, executablePath);
      if (!linkedPath || darwinSystemRuntimePath(linkedPath)) continue;
      const runtime = await linkedRuntimeIdentity(linkedPath).catch((error: unknown) =>
        custodyRefusal(`CCC semantic-proof Python dylib closure file is unavailable: ${linkedPath}`, error));
      const prior = entries.get(runtime.canonicalPath);
      entries.set(runtime.canonicalPath, {
        path: runtime.canonicalPath,
        sha256: runtime.sha256,
        requestedPaths: [...new Set([
          ...(prior?.requestedPaths ?? []),
          requestedPath,
        ])].sort(),
      });
      if (entries.size > MAX_PYTHON_DYLIB_CLOSURE_FILES) {
        custodyRefusal("CCC semantic-proof Python dylib closure exceeds controller bounds");
      }
      if (!visited.has(runtime.canonicalPath)) queue.push(runtime.canonicalPath);
    }
  }
  return [...entries.values()].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

async function observePythonExecutionToolchain(
  paths: CccPrdSemanticProofToolchainPaths,
  template: CccPrdPythonExecutionToolchain,
): Promise<CccPrdPythonExecutionToolchain> {
  if (!paths.pythonExecutablePath) {
    custodyRefusal("CCC semantic-proof Python verifier requires a controller-owned python3 executable");
  }
  if (template.runtimeManifest.schema !== "ccc-prd.python-runtime-manifest.v1") {
    custodyRefusal("CCC semantic-proof Python runtime manifest schema is unsupported");
  }
  const controllerPythonPathRoots = await inspectControllerPythonPathRoots(paths.pythonPathRoots);
  const executable = await resolveControllerPythonExecutable(paths.pythonExecutablePath);
  if (!/^(?:python3(?:\.\d+)*|Python)$/u.test(basename(executable.executablePath))) {
    custodyRefusal("CCC semantic-proof Python verifier executable must be named python3");
  }
  const runtimeManifest = controllerPythonPathRoots.length > 0
    ? await discoverPythonRuntimeManifest(executable.executablePath, controllerPythonPathRoots)
    : template.runtimeManifest.interpreter.path.length === 0
      ? await discoverPythonRuntimeManifest(executable.executablePath)
      : template.runtimeManifest;
  const stdlibRoot = await inspectPythonRuntimeRoot(runtimeManifest.stdlibRoot, "stdlib");
  const pythonHomeRoot = await inspectPythonRuntimeRoot(runtimeManifest.pythonHomeRoot, "python home");
  const sitePackagesRoots = await Promise.all(runtimeManifest.sitePackagesRoots.map((root, index) => (
    inspectPythonRuntimeRoot(root, `site-packages[${index}]`)
  )));
  const extensionModuleRoots = await Promise.all(runtimeManifest.extensionModuleRoots.map((root, index) => (
    inspectPythonRuntimeRoot(root, `extension-module[${index}]`)
  )));
  const runtimeSupport: CccPrdPythonRuntimeFile[] = [];
  for (const [index, entry] of runtimeManifest.runtimeSupport.entries()) {
    runtimeSupport.push(await inspectPythonRuntimeFile(entry, `runtime-support[${index}]`));
  }
  const expectedFrameworkPython = resolve(
    dirname(executable.executablePath),
    "../Resources/Python.app/Contents/MacOS/Python",
  );
  if (existsSync(expectedFrameworkPython)) {
    const canonicalFrameworkPython = await realpath(expectedFrameworkPython);
    if (!runtimeSupport.some((entry) => entry.path === canonicalFrameworkPython)) {
      custodyRefusal("CCC semantic-proof Python framework interpreter support is not sealed");
    }
  }
  const interpreter = await inspectPythonRuntimeFile(runtimeManifest.interpreter, "interpreter");
  if (
    interpreter.path !== executable.executablePath
    || interpreter.sha256 !== executable.executableSha256
  ) {
    custodyRefusal("CCC semantic-proof Python runtime interpreter does not match controller executable");
  }
  const categories: CccPrdPythonRuntimeFile[][] = [];
  for (const [label, entries] of [
    ["stdlib", runtimeManifest.stdlib] as const,
    ["site-packages", runtimeManifest.sitePackages] as const,
    ["extension module", runtimeManifest.extensionModules] as const,
    ["dylib", runtimeManifest.dylibClosure] as const,
  ]) {
    const observed: CccPrdPythonRuntimeFile[] = [];
    for (const [index, entry] of entries.entries()) {
      observed.push(await inspectPythonRuntimeFile(entry, `${label}[${index}]`));
    }
    categories.push(observed);
  }
  const suppliedDylibClosure = categories[3]!;
  const machOLoaders = [
    ...categories[0]!,
    ...categories[1]!,
    ...categories[2]!,
    ...runtimeSupport,
  ].map((entry) => entry.path);
  const discoveredDylibClosure = process.platform === "darwin"
    && await isDarwinMachOFile(executable.executablePath)
    ? await discoverDarwinPythonDylibClosure(executable.executablePath, machOLoaders)
    : suppliedDylibClosure;
  if (
    runtimeManifest.interpreter.path.length > 0
    && process.platform === "darwin"
    && await isDarwinMachOFile(executable.executablePath)
    && canonicalCccPrdJson(discoveredDylibClosure) !== canonicalCccPrdJson(suppliedDylibClosure)
  ) {
    custodyRefusal("CCC semantic-proof Python dylib closure is incomplete or drifted");
  }
  let versionOutput: Buffer;
  try {
    const result = await execFile(
      executable.executablePath,
      [...PYTHON_VERSION_ARGS],
      versionOptions(),
    );
    versionOutput = Buffer.concat([result.stdout, result.stderr]);
  } catch (error) {
    custodyRefusal(`CCC semantic-proof Python executable --version probe failed: ${executable.executablePath}`, error);
  }
  const versionText = versionOutput.toString("utf8").trim();
  if (versionText.length === 0) {
    custodyRefusal(`CCC semantic-proof Python executable version output is empty: ${executable.executablePath}`);
  }
  const version = {
    version: versionText,
    versionOutputSha256: sha256(versionOutput),
  };
  const manifest = {
    executablePath: executable.executablePath,
    executableSha256: executable.executableSha256,
    ...version,
    runtimeManifest: {
      schema: runtimeManifest.schema,
      interpreter,
      stdlibRoot,
      pythonHomeRoot,
      sitePackagesRoots,
      extensionModuleRoots,
      runtimeSupport,
      stdlib: categories[0]!,
      sitePackages: categories[1]!,
      extensionModules: categories[2]!,
      dylibClosure: discoveredDylibClosure,
    },
  };
  assertPythonRuntimeRootMembership(manifest.runtimeManifest);
  return manifest;
}

function staticExecutableIdentity(
  identity: StaticExecutableIdentity,
): StaticExecutableIdentity {
  return {
    executablePath: identity.executablePath,
    executableSha256: identity.executableSha256,
  };
}

async function writeSealedProbeExecutable(path: string, bytes: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, "wx", 0o555);
  try {
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
  await chmod(path, 0o555);
}

function sealedPathFor(tempRoot: string, canonicalPath: string): string {
  return resolve(tempRoot, canonicalPath.slice(1));
}

function executableInstallRoot(executable: string): string {
  return dirname(dirname(executable));
}

function resolveDarwinLinkedPath(
  dependency: string,
  loaderPath: string,
  executablePath: string,
): string | undefined {
  const suffix = dependency.replace(/^@(loader_path|executable_path|rpath)\//u, "");
  const candidates = dependency.startsWith("/")
    ? [dependency]
    : dependency.startsWith("@loader_path/")
      ? [resolve(dirname(loaderPath), suffix)]
      : dependency.startsWith("@executable_path/")
        ? [resolve(dirname(executablePath), suffix)]
        : dependency.startsWith("@rpath/")
          ? [
              resolve(executableInstallRoot(executablePath), "lib", suffix),
              resolve(dirname(loaderPath), suffix),
            ]
          : [];
  return candidates.find(existsSync);
}

type DarwinRuntimeLoader = {
  loaderRole: CccPrdLinkedRuntimeEntry["loaderRole"];
  loaderPath: string;
  rootExecutablePath: string;
};

async function linkedRuntimeIdentity(
  canonicalPath: string,
): Promise<{ canonicalPath: string; sha256: string }> {
  const resolved = await realpath(canonicalPath);
  const handle = await open(resolved, "r");
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error("not a regular file");
    return {
      canonicalPath: resolved,
      sha256: sha256(await handle.readFile()),
    };
  } finally {
    await handle.close();
  }
}

function linkedRuntimeKey(entry: CccPrdLinkedRuntimeEntry): string {
  return [
    entry.platform,
    entry.loaderRole,
    entry.loaderPath,
    entry.requestedPath,
    entry.canonicalPath,
    entry.sha256,
  ].join("\0");
}

async function darwinHomebrewLinkedRuntimeManifest(
  roots: readonly DarwinRuntimeLoader[],
): Promise<CccPrdLinkedRuntimeEntry[]> {
  if (process.platform !== "darwin") return [];
  const entries = new Map<string, CccPrdLinkedRuntimeEntry>();
  const visited = new Set<string>();
  for (const root of roots) {
    const queue: DarwinRuntimeLoader[] = [root];
    while (queue.length > 0) {
      const loader = queue.shift()!;
      if (visited.has(loader.loaderPath)) continue;
      visited.add(loader.loaderPath);
      let stdout: string;
      try {
        ({ stdout } = await execFile("/usr/bin/otool", ["-L", loader.loaderPath], {
          encoding: "utf8",
          maxBuffer: 1024 * 1024,
          timeout: OTOOL_TIMEOUT_MS,
          windowsHide: true,
        }));
      } catch {
        continue;
      }
      for (const line of stdout.split("\n").slice(1)) {
        const dependency = line.trim().split(/\s+/u)[0];
        if (!dependency) continue;
        const linkedPath = resolveDarwinLinkedPath(
          dependency,
          loader.loaderPath,
          loader.rootExecutablePath,
        );
        if (!linkedPath || !linkedPath.startsWith("/opt/homebrew/")) continue;
        const runtime = await linkedRuntimeIdentity(linkedPath).catch(() => undefined);
        if (!runtime || !runtime.canonicalPath.startsWith("/opt/homebrew/")) continue;
        const entry: CccPrdLinkedRuntimeEntry = {
          platform: "darwin",
          loaderRole: loader.loaderRole,
          loaderPath: loader.loaderPath,
          requestedPath: dependency,
          canonicalPath: runtime.canonicalPath,
          sha256: runtime.sha256,
        };
        entries.set(linkedRuntimeKey(entry), entry);
        if (!visited.has(runtime.canonicalPath)) {
          queue.push({
            loaderRole: "linked_runtime",
            loaderPath: runtime.canonicalPath,
            rootExecutablePath: loader.rootExecutablePath,
          });
        }
      }
    }
  }
  return [...entries.values()].sort((left, right) => (
    linkedRuntimeKey(left) < linkedRuntimeKey(right)
      ? -1
      : linkedRuntimeKey(left) > linkedRuntimeKey(right)
        ? 1
        : 0
  ));
}

async function sealDarwinLinkedRuntime(
  tempRoot: string,
  manifest: readonly CccPrdLinkedRuntimeEntry[],
): Promise<void> {
  for (const entry of manifest) {
    const destination = resolve(tempRoot, entry.canonicalPath.slice(1));
    if (existsSync(destination)) continue;
    const handle = await open(entry.canonicalPath, "r");
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile()) continue;
      await mkdir(dirname(destination), { recursive: true });
      const output = await open(destination, "wx", 0o444);
      try {
        await output.writeFile(await handle.readFile());
      } finally {
        await output.close();
      }
    } finally {
      await handle.close();
    }
  }
}

async function deriveStaticToolchain(
  paths: CccPrdSemanticProofToolchainPaths,
  pythonTemplate?: CccPrdPythonExecutionToolchain,
): Promise<StaticToolchainIdentity> {
  if (paths.proofHost.id !== CCC_PRD_SEMANTIC_PROOF_HOST_ID) {
    custodyRefusal(
      `CCC semantic-proof host id must be ${CCC_PRD_SEMANTIC_PROOF_HOST_ID}`,
    );
  }
  const [task, node, proofHost] = await Promise.all([
    inspectExecutableBytes(paths.taskExecutablePath),
    inspectExecutableBytes(paths.nodeExecutablePath),
    inspectExecutableBytes(paths.proofHost.executablePath),
  ]);
  const python = pythonTemplate
    ? await observePythonExecutionToolchain(paths, pythonTemplate)
    : undefined;
  return {
    task: staticExecutableIdentity(task),
    node: staticExecutableIdentity(node),
    proofHost: {
      id: CCC_PRD_SEMANTIC_PROOF_HOST_ID,
      ...staticExecutableIdentity(proofHost),
    },
    ...(python ? {
      python: {
        executablePath: python.executablePath,
        executableSha256: python.executableSha256,
        runtimeManifest: python.runtimeManifest,
      },
    } : {}),
  };
}

function versionOptions() {
  return {
    encoding: "buffer" as const,
    env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
    maxBuffer: 1024 * 1024,
    timeout: 10_000,
    windowsHide: true,
  };
}

async function deriveToolchain(
  paths: CccPrdSemanticProofToolchainPaths,
  expected?: StaticToolchainIdentity,
  pythonTemplate?: CccPrdPythonExecutionToolchain,
): Promise<CccPrdProofExecutionToolchain> {
  if (paths.proofHost.id !== CCC_PRD_SEMANTIC_PROOF_HOST_ID) {
    custodyRefusal(
      `CCC semantic-proof host id must be ${CCC_PRD_SEMANTIC_PROOF_HOST_ID}`,
    );
  }
  const [taskBytes, nodeBytes, proofHostBytes] = await Promise.all([
    inspectExecutableBytes(paths.taskExecutablePath),
    inspectExecutableBytes(paths.nodeExecutablePath),
    inspectExecutableBytes(paths.proofHost.executablePath),
  ]);
  const python = pythonTemplate
    ? await observePythonExecutionToolchain(paths, pythonTemplate)
    : undefined;
  const taskIdentity = staticExecutableIdentity(taskBytes);
  const nodeIdentity = staticExecutableIdentity(nodeBytes);
  const proofHostIdentity = staticExecutableIdentity(proofHostBytes);
  if (
    expected
    && (
      canonicalCccPrdJson(taskIdentity) !== canonicalCccPrdJson(expected.task)
      || canonicalCccPrdJson(nodeIdentity) !== canonicalCccPrdJson(expected.node)
      || canonicalCccPrdJson(proofHostIdentity)
        !== canonicalCccPrdJson(staticExecutableIdentity(expected.proofHost))
      || (python && expected.python && canonicalCccPrdJson({
        executablePath: python.executablePath,
        executableSha256: python.executableSha256,
        runtimeManifest: python.runtimeManifest,
      }) !== canonicalCccPrdJson(expected.python))
    )
  ) {
    custodyRefusal("CCC semantic-proof toolchain executable identity drifted");
  }
  const tempRoot = await mkdtemp(join(tmpdir(), "ccc-semantic-proof-authoring-toolchain-"));
  try {
    const sealedTask = sealedPathFor(tempRoot, taskIdentity.executablePath);
    const sealedNode = sealedPathFor(tempRoot, nodeIdentity.executablePath);
    const sealedProofHost = sealedPathFor(tempRoot, proofHostIdentity.executablePath);
    await Promise.all([
      writeSealedProbeExecutable(sealedTask, taskBytes.executableBytes),
      writeSealedProbeExecutable(sealedNode, nodeBytes.executableBytes),
      writeSealedProbeExecutable(sealedProofHost, proofHostBytes.executableBytes),
    ]);
    const linkedRuntime = await darwinHomebrewLinkedRuntimeManifest([
      {
        loaderRole: "task",
        loaderPath: taskIdentity.executablePath,
        rootExecutablePath: taskIdentity.executablePath,
      },
      {
        loaderRole: "node",
        loaderPath: nodeIdentity.executablePath,
        rootExecutablePath: nodeIdentity.executablePath,
      },
      {
        loaderRole: "proof_host",
        loaderPath: proofHostIdentity.executablePath,
        rootExecutablePath: proofHostIdentity.executablePath,
      },
    ]);
    await sealDarwinLinkedRuntime(tempRoot, linkedRuntime);
    const [task, node] = await Promise.all([
      inspectSealedExecutableVersion(taskIdentity, sealedTask, (path) =>
        execFile(path, [...EXECUTABLE_VERSION_ARGS], versionOptions())),
      inspectSealedExecutableVersion(nodeIdentity, sealedNode, (path) =>
        execFile(path, [...EXECUTABLE_VERSION_ARGS], versionOptions())),
    ]);
    const proofHost = await inspectSealedExecutableVersion(
      proofHostIdentity,
      sealedProofHost,
      (path) => execFile(sealedNode, [path, ...EXECUTABLE_VERSION_ARGS], versionOptions()),
    );
    return {
      task,
      node,
      proofHost: {
        id: CCC_PRD_SEMANTIC_PROOF_HOST_ID,
        ...proofHost,
      },
      linkedRuntime,
      ...(python ? { python } : {}),
    };
  } finally {
    await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

function assertClosureDisjoint(
  entry: CccPrdVerifierClosureEntry,
  modelWriteRoots: readonly string[],
): void {
  for (const rawRoot of modelWriteRoots) {
    const root = canonicalRelativePath(rawRoot, "CCC semantic-proof model-write root");
    if (isSameOrWithin(entry.path, root) || isSameOrWithin(root, entry.path)) {
      custodyRefusal(
        `CCC semantic-proof verifier closure ${entry.path} overlaps model-writeable root ${root}`,
      );
    }
  }
}

async function hydrateProof(
  input: Omit<CccPrdSemanticProofCustodyInput, "proofs">,
  proof: CccPrdProofV2,
  toolchain: CccPrdProofExecutionToolchain,
): Promise<CccPrdProofV2> {
  if (proof.schema !== "ccc-prd.proof.v2") {
    custodyRefusal(`CCC semantic-proof controller requires proof.v2: ${proof.id}`);
  }
  const repositoryRoot = await realpath(input.repositoryRoot).catch((error: unknown) =>
    custodyRefusal(`CCC semantic-proof target repository is unavailable: ${input.repositoryRoot}`, error));
  const closurePaths = new Set<string>();
  const verifierClosure: CccPrdVerifierClosureEntry[] = [];
  const closureBytes = new Map<string, Buffer>();
  for (const rawEntry of proof.verifierClosure) {
    const path = canonicalRelativePath(rawEntry.path, "CCC semantic-proof closure path");
    if (closurePaths.has(path)) {
      custodyRefusal(`CCC semantic-proof verifier closure path is duplicated: ${path}`);
    }
    closurePaths.add(path);
    const entry = { ...rawEntry, path };
    assertClosureDisjoint(entry, input.modelWriteRoots);
    const observed = await gitBytes(repositoryRoot, input.baseCommit, path);
    verifierClosure.push({
      role: rawEntry.role,
      path,
      baseGitBlobOid: observed.oid,
      sha256: sha256(observed.bytes),
    });
    closureBytes.set(path, observed.bytes);
  }
  const taskRunners = verifierClosure.filter((entry) => entry.role === "task_runner");
  if (taskRunners.length !== 1 || taskRunners[0]!.path !== "Taskfile.yml") {
    custodyRefusal(
      "CCC semantic-proof closure requires exactly one baseline Taskfile.yml task runner",
    );
  }
  const candidatePaths = new Set<string>();
  const candidateInputs = proof.candidateInputs.map((rawPath) => {
    const path = canonicalRelativePath(rawPath, "CCC semantic-proof candidate path");
    if (candidatePaths.has(path) || closurePaths.has(path)) {
      custodyRefusal(`CCC semantic-proof candidate path is duplicated or overlaps closure: ${path}`);
    }
    candidatePaths.add(path);
    if (!input.modelWriteRoots.some((rawRoot) => (
      isSameOrWithin(path, canonicalRelativePath(rawRoot, "CCC semantic-proof model-write root"))
    ))) {
      custodyRefusal(`CCC semantic-proof candidate path is outside model-write roots: ${path}`);
    }
    return path;
  });
  const { admission: _untrustedAdmission, ...semanticProof } = proof;
  const hydrated: CccPrdProofV2 = {
    ...semanticProof,
    verifierClosure,
    candidateInputs,
    executionToolchain: toolchain,
  };
  verifyTaskfile(closureBytes.get("Taskfile.yml")!, hydrated);
  return hydrated;
}

async function hydrateSemanticProofV2Custody(
  input: CccPrdSemanticProofCustodyInput,
  expectedToolchain?: StaticToolchainIdentity,
): Promise<CccPrdProofV2[]> {
  const pythonProofs = input.proofs.filter((proof) => proof.verifierProfile?.schema === "ccc-prd.verifier.python-adapter.v1");
  const pythonTemplate = pythonProofs[0]?.executionToolchain.python;
  if (pythonProofs.some((proof) => !proof.executionToolchain.python)) {
    custodyRefusal("CCC semantic-proof Python verifier profile requires executionToolchain.python");
  }
  if (pythonProofs.some((proof) => canonicalCccPrdJson(proof.executionToolchain.python?.runtimeManifest)
    !== canonicalCccPrdJson(pythonTemplate?.runtimeManifest))) {
    custodyRefusal("CCC semantic-proof Python proofs must share one exact runtime manifest");
  }
  let toolchain: CccPrdProofExecutionToolchain;
  try {
    toolchain = await deriveToolchain(input.toolchainPaths, expectedToolchain, pythonTemplate);
  } catch (error) {
    if (error instanceof CccPrdSemanticProofCustodyError) throw error;
    custodyRefusal("CCC semantic-proof toolchain identity could not be derived", error);
  }
  return Promise.all(input.proofs.map((proof) => hydrateProof(input, proof, toolchain)));
}

export async function hydrateCccPrdSemanticProofV2Custody(
  input: CccPrdSemanticProofCustodyInput,
): Promise<CccPrdProofV2[]> {
  return hydrateSemanticProofV2Custody(input);
}

export async function assertCccPrdSemanticProofV2Custody(
  input: CccPrdSemanticProofCustodyInput,
): Promise<void> {
  const pythonTemplate = input.proofs.find((proof) => proof.verifierProfile?.schema === "ccc-prd.verifier.python-adapter.v1")?.executionToolchain.python;
  const staticToolchain = await deriveStaticToolchain(input.toolchainPaths, pythonTemplate);
  for (const proof of input.proofs) {
    const admittedStaticToolchain: StaticToolchainIdentity = {
      task: {
        executablePath: proof.executionToolchain.task.executablePath,
        executableSha256: proof.executionToolchain.task.executableSha256,
      },
      node: {
        executablePath: proof.executionToolchain.node.executablePath,
        executableSha256: proof.executionToolchain.node.executableSha256,
      },
      proofHost: {
        id: CCC_PRD_SEMANTIC_PROOF_HOST_ID,
        executablePath: proof.executionToolchain.proofHost.executablePath,
        executableSha256: proof.executionToolchain.proofHost.executableSha256,
      },
      ...(proof.executionToolchain.python ? {
        python: {
          executablePath: proof.executionToolchain.python.executablePath,
          executableSha256: proof.executionToolchain.python.executableSha256,
          runtimeManifest: proof.executionToolchain.python.runtimeManifest,
        },
      } : {}),
    };
    if (
      proof.executionToolchain.proofHost.id !== CCC_PRD_SEMANTIC_PROOF_HOST_ID
      || canonicalCccPrdJson(admittedStaticToolchain)
        !== canonicalCccPrdJson(staticToolchain)
    ) {
      custodyRefusal(`CCC semantic-proof toolchain executable identity drifted for proof ${proof.id}`);
    }
  }
  const hydrated = await hydrateSemanticProofV2Custody(input, staticToolchain);
  if (hydrated.length !== input.proofs.length) {
    custodyRefusal("CCC semantic-proof proof set changed during custody preflight");
  }
  for (const [index, proof] of input.proofs.entries()) {
    const observed = hydrated[index]!;
    if (
      canonicalCccPrdJson(proof.verifierClosure)
        !== canonicalCccPrdJson(observed.verifierClosure)
      || canonicalCccPrdJson(proof.candidateInputs)
        !== canonicalCccPrdJson(observed.candidateInputs)
      || computeCccPrdProofExecutionToolchainSha256(proof.executionToolchain)
        !== computeCccPrdProofExecutionToolchainSha256(observed.executionToolchain)
    ) {
      custodyRefusal(`CCC semantic-proof controller custody drifted for proof ${proof.id}`);
    }
    if (!proof.admission || proof.admission.schema !== "ccc-prd.proof-admission.v2") {
      custodyRefusal(`CCC semantic-proof v2 admission is missing for proof ${proof.id}`);
    }
    const expectedAdmission = {
      definitionSha256: computeCccPrdProofDefinitionSha256(proof),
      ...computeCccPrdProofV2AdmissionDigests(proof),
    };
    if (
      !LOWER_SHA256.test(proof.admission.definitionSha256)
      || canonicalCccPrdJson({
        definitionSha256: proof.admission.definitionSha256,
        verifierClosureSha256: proof.admission.verifierClosureSha256,
        candidateInputsSha256: proof.admission.candidateInputsSha256,
        executionToolchainSha256: proof.admission.executionToolchainSha256,
      }) !== canonicalCccPrdJson(expectedAdmission)
    ) {
      custodyRefusal(`CCC semantic-proof v2 admission digests drifted for proof ${proof.id}`);
    }
  }
}
