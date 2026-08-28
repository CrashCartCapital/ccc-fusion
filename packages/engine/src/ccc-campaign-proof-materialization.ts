import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { constants as fsConstants, existsSync } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import {
  CCC_PRD_SEMANTIC_PROOF_HOST_ID,
  computeCccPrdCandidateInputsSha256,
  computeCccPrdVerifierClosureSha256,
  wellKnownGitBinaryPaths,
  type CccPrdExecutableIdentity,
  type CccPrdLinkedRuntimeEntry,
  type CccPrdPythonExecutionToolchain,
  type CccPrdPythonRuntimeFile,
  type CccPrdProofExecutionToolchain,
  type CccPrdProofV2,
  type CccPrdVerifierClosureEntry,
} from "@fusion/core";
import { isAlias, isMap, isScalar, isSeq, parseDocument, type Node, type Pair } from "yaml";

const execFile = promisify(execFileCallback);
const LOWER_SHA256 = /^[0-9a-f]{64}$/u;
const GIT_BLOB_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const PROOF_COMMAND = /^task (verify:[a-z0-9][a-z0-9:-]{0,63})$/u;
const VERIFY_TARGET = /^verify:[a-z0-9][a-z0-9:-]{0,63}$/u;
const TARGET_COMMAND_TOKEN = /^[A-Za-z0-9._/-]+$/u;
const TOP_LEVEL_TASKFILE_KEYS = new Set(["version", "tasks"]);
const TARGET_KEYS = new Set(["cmds"]);
const EXECUTABLE_VERSION_ARGS = Object.freeze(["--version"] as const);
const EXECUTABLE_PROBE_TIMEOUT_MS = 10_000;
const GIT_TIMEOUT_MS = 10_000;
const OTOOL_TIMEOUT_MS = 10_000;
const INSTALL_NAME_TOOL_TIMEOUT_MS = 10_000;
const SEALED_OPENSSL_CONF = ".ccc-empty-openssl.cnf";
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

export type CccSemanticProofMaterializationInput = {
  repositoryRoot: string;
  baseCommit: string;
  sourceCommit: string;
  proof: CccPrdProofV2;
  modelWriteRoots: readonly string[];
  outputRoot: string;
};

export type CccSemanticProofMaterialization = {
  proofRoot: string;
  scratchRoot: string;
  taskTarget: string;
  taskArgv: readonly string[];
  closureSha256: string;
  candidateInputsSha256: string;
  sealedToolchain: {
    taskExecutable: string;
    nodeExecutable: string;
    proofHostExecutable: string;
  };
  sealedExecutionToolchain: CccPrdProofExecutionToolchain;
};

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
    throw new Error(`${label} must be a canonical target-relative path: ${path}`);
  }
  return path;
}

function isSameOrWithin(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

function assertDisjointClosure(
  entry: CccPrdVerifierClosureEntry,
  modelWriteRoots: readonly string[],
): void {
  for (const rawRoot of modelWriteRoots) {
    const root = canonicalRelativePath(rawRoot, "CCC semantic-proof model-write root");
    if (isSameOrWithin(entry.path, root) || isSameOrWithin(root, entry.path)) {
      throw new Error(
        `CCC semantic-proof verifier closure ${entry.path} overlaps model-writeable root ${root}`,
      );
    }
  }
}

async function gitBytes(
  repositoryRoot: string,
  commit: string,
  path: string,
): Promise<{ bytes: Buffer; oid: string }> {
  const git = await resolveCccSemanticProofGitBinary();
  const { stdout: treeOutput } = await execFile(
    git,
    ["-C", repositoryRoot, "ls-tree", "-z", commit, "--", path],
    {
      encoding: "buffer",
      env: scrubbedGitEnvironment(),
      maxBuffer: 1024 * 1024,
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
    },
  );
  const tree = treeOutput.toString("utf8");
  const match = /^(100644|100755) blob ([0-9a-f]{40}|[0-9a-f]{64})\t([^\0]+)\0$/u.exec(tree);
  if (!match || match[3] !== path) {
    throw new Error(`CCC semantic-proof path is missing, non-regular, or ambiguous at ${commit}: ${path}`);
  }
  const oid = match[2]!;
  const { stdout } = await execFile(
    git,
    ["-C", repositoryRoot, "cat-file", "blob", oid],
    {
      encoding: "buffer",
      env: scrubbedGitEnvironment(),
      maxBuffer: 16 * 1024 * 1024,
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
    },
  );
  return { bytes: stdout, oid };
}

function scrubbedGitEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_COMMON_DIR",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  ]) {
    delete env[key];
  }
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
  return env;
}

async function resolveCccSemanticProofGitBinary(): Promise<string> {
  const candidates = process.platform === "darwin"
    ? ["/usr/bin/git", ...wellKnownGitBinaryPaths().filter((path) => path !== "/usr/bin/git")]
    : wellKnownGitBinaryPaths();
  for (const candidate of candidates) {
    if (!isAbsolute(candidate)) continue;
    try {
      const canonicalPath = await realpath(candidate);
      const metadata = await lstat(canonicalPath);
      if (!metadata.isFile() || metadata.isSymbolicLink()) continue;
      await access(canonicalPath, fsConstants.X_OK);
      return canonicalPath;
    } catch {
      // Try the next controller-known absolute Git location.
    }
  }
  throw new Error("CCC semantic-proof could not resolve a controller-owned Git binary");
}

function plainScalar(node: Node | null | undefined, label: string): string {
  if (!isScalar(node) || typeof node.value !== "string" || node.anchor) {
    throw new Error(`CCC semantic-proof Taskfile ${label} must be one literal string`);
  }
  return node.value;
}

function mapEntries(node: Node | null | undefined, label: string): Map<string, Node | null> {
  if (!isMap(node) || node.anchor) {
    throw new Error(`CCC semantic-proof Taskfile ${label} must be a literal mapping`);
  }
  const result = new Map<string, Node | null>();
  for (const pair of node.items) {
    const key = plainScalar(pair.key as Node, `${label} key`);
    if (result.has(key)) throw new Error(`CCC semantic-proof Taskfile ${label} duplicates ${key}`);
    result.set(key, pair.value as Node | null);
  }
  return result;
}

function parseLiteralCommand(command: string): string[] {
  if (
    command.trim() !== command
    || /[;&|`$<>\n\r\t'"\\*?{}()[\]!~]/u.test(command)
  ) {
    throw new Error("CCC semantic-proof Task target command must be literal and substitution-free");
  }
  const tokens = command.split(" ");
  if (
    tokens.some((token) => token.length === 0 || !TARGET_COMMAND_TOKEN.test(token))
    || tokens.length < 3
    || tokens[0] !== "node"
  ) {
    throw new Error("CCC semantic-proof Task target must invoke Node, one harness, and literal candidates");
  }
  return tokens;
}

function parsePythonLiteralCommand(command: string): string[] {
  if (
    command.trim() !== command
    || /[;&|`$<>\n\r\t'"\\*?{}()[\]!~]/u.test(command)
  ) {
    throw new Error("CCC semantic-proof Python Task target command must be literal and substitution-free");
  }
  const tokens = command.split(" ");
  if (
    tokens.length !== 4
    || tokens[0] !== "python3"
    || tokens[2] !== "--target"
    || tokens.some((token) => token.length === 0 || !TARGET_COMMAND_TOKEN.test(token))
  ) {
    throw new Error(
      "CCC semantic-proof Python Task target must be exactly python3 <adapter> --target <target>",
    );
  }
  return tokens;
}

function literalTargetTokens(
  targetName: string,
  node: Node | null,
  pythonProfile = false,
): string[] {
  if (!VERIFY_TARGET.test(targetName)) {
    throw new Error(`CCC semantic-proof Taskfile target is not an admitted verify target: ${targetName}`);
  }
  const target = mapEntries(node, `target ${targetName}`);
  for (const key of target.keys()) {
    if (!TARGET_KEYS.has(key)) {
      const noun = key === "deps" ? "dependencies" : key;
      throw new Error(`CCC semantic-proof Task target ${targetName} ${noun} behavior is forbidden`);
    }
  }
  const commands = target.get("cmds");
  if (!isSeq(commands) || commands.anchor || commands.items.length !== 1) {
    throw new Error(`CCC semantic-proof Task target ${targetName} must contain exactly one literal command`);
  }
  const tokens = (pythonProfile ? parsePythonLiteralCommand : parseLiteralCommand)(
    plainScalar(commands.items[0] as Node, `${targetName} command`),
  );
  for (const path of tokens.slice(1)) {
    canonicalRelativePath(path, `CCC semantic-proof Task target ${targetName} path`);
  }
  return tokens;
}

function verifyTaskfile(
  bytes: Buffer,
  proof: CccPrdProofV2,
): { taskTarget: string; taskArgv: readonly string[] } {
  const commandMatch = PROOF_COMMAND.exec(proof.command);
  if (!commandMatch) {
    throw new Error("CCC semantic-proof command must name exactly one task verify target");
  }
  const document = parseDocument(bytes.toString("utf8"), {
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0 || document.warnings.length > 0 || !document.contents) {
    throw new Error("CCC semantic-proof Taskfile is malformed or ambiguous YAML");
  }
  let hasAlias = false;
  const checkAliases = (node: unknown): void => {
    if (isAlias(node) || (node && typeof node === "object" && "anchor" in node && node.anchor)) {
      hasAlias = true;
    }
    if (isMap(node) || isSeq(node)) {
      for (const item of node.items as readonly unknown[]) {
        if (isMap(node)) {
          const pair = item as Pair;
          checkAliases(pair.key);
          checkAliases(pair.value);
        } else checkAliases(item);
      }
    }
  };
  checkAliases(document.contents);
  if (hasAlias) throw new Error("CCC semantic-proof Taskfile aliases and anchors are forbidden");

  const root = mapEntries(document.contents, "root");
  for (const key of root.keys()) {
    if (!TOP_LEVEL_TASKFILE_KEYS.has(key)) {
      throw new Error(`CCC semantic-proof Taskfile ${key} behavior is forbidden`);
    }
  }
  plainScalar(root.get("version"), "version");
  const tasks = mapEntries(root.get("tasks"), "tasks");
  if (tasks.size === 0 || !tasks.has(commandMatch[1]!)) {
    throw new Error("CCC semantic-proof Taskfile must declare the selected verify target");
  }
  const pythonProfile = proof.verifierProfile?.schema === "ccc-prd.verifier.python-adapter.v1";
  const selectedTarget = commandMatch[1]!;
  const tokens = literalTargetTokens(selectedTarget, tasks.get(selectedTarget)!, pythonProfile);
  if (pythonProfile) {
    const profile = proof.verifierProfile!;
    const adapters = proof.verifierClosure
      .filter((entry) => entry.role === "harness")
      .map((entry) => entry.path);
    const targets = proof.verifierClosure
      .filter((entry) => entry.role === "fixture")
      .map((entry) => entry.path);
    if (
      tokens.length !== 4
      || tokens[1] !== profile.adapterPath
      || tokens[3] !== profile.targetPath
      || adapters.length !== 1
      || adapters[0] !== profile.adapterPath
      || !targets.some((path) => path.startsWith(`${profile.targetPath}/`))
    ) {
      throw new Error("CCC semantic-proof Python adapter and target must be closure-owned");
    }
    return { taskTarget: commandMatch[1]!, taskArgv: [commandMatch[1]!] };
  }
  const harnesses = proof.verifierClosure
    .filter((entry) => entry.role === "harness")
    .map((entry) => entry.path);
  if (harnesses.length !== 1 || tokens[1] !== harnesses[0]) {
    throw new Error("CCC semantic-proof Task target must invoke the one declared harness");
  }
  const candidates = tokens.slice(2);
  if (
    candidates.length !== proof.candidateInputs.length
    || computeCccPrdCandidateInputsSha256(candidates)
      !== computeCccPrdCandidateInputsSha256(proof.candidateInputs)
  ) {
    throw new Error("CCC semantic-proof Task target candidate arguments differ from declared inputs");
  }
  return { taskTarget: commandMatch[1]!, taskArgv: [commandMatch[1]!] };
}

export async function inspectCccSemanticProofExecutable(
  executablePath: string,
  versionArgs: readonly string[],
): Promise<CccPrdExecutableIdentity> {
  if (
    versionArgs.length !== EXECUTABLE_VERSION_ARGS.length
    || versionArgs.some((argument, index) => argument !== EXECUTABLE_VERSION_ARGS[index])
  ) {
    throw new Error("CCC semantic-proof executable identity requires the canonical --version probe");
  }
  const observedBytes = await inspectExecutableBytes(executablePath);
  const version = await inspectExecutableVersion(observedBytes.canonicalPath, versionArgs);
  return {
    executablePath: observedBytes.canonicalPath,
    executableSha256: observedBytes.executableSha256,
    ...version,
  };
}

async function inspectExecutableBytes(executablePath: string): Promise<{
  canonicalPath: string;
  executableSha256: string;
}> {
  const canonicalPath = await realpath(executablePath);
  const metadata = await lstat(canonicalPath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`CCC semantic-proof executable is not a regular file: ${canonicalPath}`);
  }
  await access(canonicalPath, fsConstants.X_OK);
  const bytes = await readFile(canonicalPath);
  return { canonicalPath, executableSha256: sha256(bytes) };
}

async function inspectExecutableVersion(
  canonicalPath: string,
  versionArgs: readonly string[],
): Promise<Pick<CccPrdExecutableIdentity, "version" | "versionOutputSha256">> {
  const { stdout, stderr } = await runExecutableVersionProbe(canonicalPath, versionArgs);
  const versionOutput = Buffer.concat([stdout, stderr]);
  const version = versionOutput.toString("utf8").trim();
  if (version.length === 0) throw new Error("CCC semantic-proof executable version output is empty");
  return {
    version,
    versionOutputSha256: sha256(versionOutput),
  };
}

async function inspectProofHostVersion(
  proofHostPath: string,
  nodePath: string,
  versionArgs: readonly string[],
): Promise<Pick<CccPrdExecutableIdentity, "version" | "versionOutputSha256">> {
  const { stdout, stderr } = await runExecutableVersionProbe(
    nodePath,
    [proofHostPath, ...versionArgs],
  );
  const versionOutput = Buffer.concat([stdout, stderr]);
  const version = versionOutput.toString("utf8").trim();
  if (version.length === 0) throw new Error("CCC semantic-proof proof-host version output is empty");
  return {
    version,
    versionOutputSha256: sha256(versionOutput),
  };
}

function isTransientExecutableProbeTimeout(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; killed?: unknown; signal?: unknown };
  return candidate.code === null
    && candidate.killed === true
    && candidate.signal === "SIGTERM";
}

async function runExecutableVersionProbe(
  executablePath: string,
  args: readonly string[],
) {
  const run = () => execFile(executablePath, [...args], {
    encoding: "buffer",
    maxBuffer: 1024 * 1024,
    env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
    timeout: EXECUTABLE_PROBE_TIMEOUT_MS,
    windowsHide: true,
  });
  try {
    return await run();
  } catch (error) {
    if (!isTransientExecutableProbeTimeout(error)) throw error;
    return run();
  }
}

export async function verifyCccSemanticProofToolchainBeforeSpawn(
  toolchain: CccPrdProofExecutionToolchain,
): Promise<void> {
  const identities = [
    ["Task", toolchain.task],
    ["Node", toolchain.node],
    ["proof host", toolchain.proofHost],
  ] as const;
  const verifiedPaths = new Map<(typeof identities)[number][0], string>();
  for (const [name, identity] of identities) {
    if (!LOWER_SHA256.test(identity.executableSha256) || !LOWER_SHA256.test(identity.versionOutputSha256)) {
      throw new Error(`CCC semantic-proof ${name} identity is malformed`);
    }
    try {
      const observed = await inspectExecutableBytes(identity.executablePath);
      if (observed.canonicalPath !== identity.executablePath) {
        throw new Error("non-canonical executable path");
      }
      if (observed.executableSha256 !== identity.executableSha256) {
        throw new Error("executable bytes differ");
      }
      verifiedPaths.set(name, observed.canonicalPath);
    } catch {
      throw new Error(`CCC semantic-proof toolchain drift detected for ${name}`);
    }
  }
  for (const [name, identity] of identities) {
    try {
      const canonicalPath = verifiedPaths.get(name)!;
      const immediateBytes = await inspectExecutableBytes(canonicalPath);
      if (
        immediateBytes.canonicalPath !== canonicalPath
        || immediateBytes.executableSha256 !== identity.executableSha256
      ) {
        throw new Error("executable bytes changed before version probe");
      }
      const observedVersion = name === "proof host"
        && toolchain.proofHost.id === CCC_PRD_SEMANTIC_PROOF_HOST_ID
        ? await (async () => {
          const nodePath = verifiedPaths.get("Node")!;
          const immediateNodeBytes = await inspectExecutableBytes(nodePath);
          if (
            immediateNodeBytes.canonicalPath !== nodePath
            || immediateNodeBytes.executableSha256 !== toolchain.node.executableSha256
          ) {
            throw new Error("sealed Node bytes changed before proof-host version probe");
          }
          return inspectProofHostVersion(canonicalPath, nodePath, EXECUTABLE_VERSION_ARGS);
        })()
        : await inspectExecutableVersion(canonicalPath, EXECUTABLE_VERSION_ARGS);
      if (
        observedVersion.version !== identity.version
        || observedVersion.versionOutputSha256 !== identity.versionOutputSha256
      ) {
        throw new Error("version output differs");
      }
    } catch {
      throw new Error(`CCC semantic-proof toolchain drift detected for ${name}`);
    }
  }
  if (toolchain.python) {
    const python = toolchain.python;
    try {
      const observed = await inspectCccSemanticProofExecutable(
        python.executablePath,
        EXECUTABLE_VERSION_ARGS,
      );
      if (
        observed.executablePath !== python.executablePath
        || observed.executableSha256 !== python.executableSha256
        || observed.version !== python.version
        || observed.versionOutputSha256 !== python.versionOutputSha256
      ) {
        throw new Error("Python executable identity drifted");
      }
      if (basename(python.executablePath) !== "python3") {
        const aliasPath = resolve(dirname(python.executablePath), "python3");
        const alias = await readFile(aliasPath);
        if (sha256(alias) !== python.executableSha256) {
          throw new Error("Python bare interpreter alias drifted");
        }
      }
      const manifest = python.runtimeManifest;
      if (
        manifest.interpreter.path !== python.executablePath
        || manifest.interpreter.sha256 !== python.executableSha256
      ) {
        throw new Error("Python interpreter manifest identity drifted");
      }
      const runtimeRoots = [
        manifest.stdlibRoot,
        manifest.pythonHomeRoot,
        ...manifest.sitePackagesRoots,
        ...manifest.extensionModuleRoots,
      ];
      if (
        runtimeRoots.length > 17
        || new Set(manifest.sitePackagesRoots).size !== manifest.sitePackagesRoots.length
        || new Set(manifest.extensionModuleRoots).size !== manifest.extensionModuleRoots.length
        || new Set(runtimeRoots).size > 17
        || runtimeRoots.some((root) => !isAbsolute(root) || root.endsWith(sep))
        || !isSameOrWithin(manifest.stdlibRoot, manifest.pythonHomeRoot)
      ) {
        throw new Error("Python runtime roots are unbounded or malformed");
      }
      for (const root of runtimeRoots) {
        const canonicalRoot = await realpath(root);
        const metadata = await lstat(canonicalRoot);
        if (canonicalRoot !== root || !metadata.isDirectory() || metadata.isSymbolicLink()) {
          throw new Error("Python runtime root is not sealed");
        }
      }
      const requireWithin = (
        entries: readonly CccPrdPythonRuntimeFile[],
        roots: readonly string[],
        label: string,
      ): void => {
        for (const entry of entries) {
          if (!roots.some((root) => isSameOrWithin(entry.path, root))) {
            throw new Error(`${label} runtime escaped its sealed root`);
          }
        }
      };
      requireWithin(manifest.stdlib, [manifest.stdlibRoot], "stdlib");
      requireWithin(manifest.sitePackages, manifest.sitePackagesRoots, "site-packages");
      requireWithin(manifest.extensionModules, manifest.extensionModuleRoots, "extension module");
      for (const [label, entries] of [
        ["stdlib", manifest.stdlib],
        ["site-packages", manifest.sitePackages],
        ["extension module", manifest.extensionModules],
        ["dylib", manifest.dylibClosure],
        ["runtime support", manifest.runtimeSupport],
      ] as const) {
        for (const entry of entries) {
          const current = await readPythonRuntimeByHandle(entry, label);
          if (current.canonicalPath !== entry.path || sha256(current.bytes) !== entry.sha256) {
            throw new Error(`${label} runtime drifted`);
          }
        }
      }
    } catch {
      throw new Error("CCC semantic-proof Python runtime manifest drift detected before spawn");
    }
  }
  for (const entry of toolchain.linkedRuntime) {
    if (!LOWER_SHA256.test(entry.sha256)) {
      throw new Error("CCC semantic-proof linked runtime identity is malformed");
    }
    try {
      await readLinkedRuntimeByHandle(entry);
    } catch {
      throw new Error("CCC semantic-proof linked runtime drift detected before spawn");
    }
  }
}

async function materialize(
  root: string,
  path: string,
  bytes: Buffer,
): Promise<void> {
  const destination = resolve(root, path);
  const fromRoot = relative(root, destination);
  if (fromRoot.startsWith(`..${sep}`) || fromRoot === ".." || isAbsolute(fromRoot)) {
    throw new Error("CCC semantic-proof materialization escaped its isolated root");
  }
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, bytes, { flag: "wx", mode: 0o444 });
  await chmod(destination, 0o444);
}

function sealedRelativeExecutablePath(canonicalPath: string, label: string): string {
  if (!isAbsolute(canonicalPath) || canonicalPath.includes("\0")) {
    throw new Error(`CCC semantic-proof ${label} path must be absolute`);
  }
  return canonicalPath.split(sep).filter(Boolean).join(sep);
}

function executableInstallRoot(executable: string): string {
  const binDirectory = dirname(executable);
  return dirname(binDirectory);
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

async function readExecutableByHandle(
  executablePath: string,
  expectedSha256: string,
): Promise<{ canonicalPath: string; bytes: Buffer }> {
  const canonicalPath = await realpath(executablePath);
  const handle = await open(canonicalPath, "r");
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new Error(`CCC semantic-proof executable is not a regular file: ${canonicalPath}`);
    }
    await access(canonicalPath, fsConstants.X_OK);
    const bytes = await handle.readFile();
    if (sha256(bytes) !== expectedSha256) {
      throw new Error(`CCC semantic-proof executable bytes drifted while sealing: ${canonicalPath}`);
    }
    return { canonicalPath, bytes };
  } finally {
    await handle.close();
  }
}

async function writeSealedExecutable(
  toolchainRoot: string,
  canonicalPath: string,
  bytes: Buffer,
): Promise<string> {
  const sealedPath = resolve(
    toolchainRoot,
    sealedRelativeExecutablePath(canonicalPath, "sealed executable"),
  );
  const fromRoot = relative(toolchainRoot, sealedPath);
  if (fromRoot.startsWith(`..${sep}`) || fromRoot === ".." || isAbsolute(fromRoot)) {
    throw new Error("CCC semantic-proof sealed executable escaped its toolchain root");
  }
  await mkdir(dirname(sealedPath), { recursive: true });
  const handle = await open(sealedPath, "wx", 0o555);
  try {
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
  await chmod(sealedPath, 0o555);
  return sealedPath;
}

async function writeSealedFile(
  toolchainRoot: string,
  canonicalPath: string,
  bytes: Buffer,
  mode: number,
): Promise<string> {
  const sealedPath = resolve(
    toolchainRoot,
    sealedRelativeExecutablePath(canonicalPath, "sealed runtime file"),
  );
  const fromRoot = relative(toolchainRoot, sealedPath);
  if (fromRoot.startsWith(`..${sep}`) || fromRoot === ".." || isAbsolute(fromRoot)) {
    throw new Error("CCC semantic-proof sealed runtime file escaped its toolchain root");
  }
  await mkdir(dirname(sealedPath), { recursive: true });
  const handle = await open(sealedPath, "wx", mode);
  try {
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
  await chmod(sealedPath, mode);
  return sealedPath;
}

async function readLinkedRuntimeByHandle(
  entry: CccPrdLinkedRuntimeEntry,
): Promise<Buffer> {
  const canonicalPath = await realpath(entry.canonicalPath);
  if (canonicalPath !== entry.canonicalPath) {
    throw new Error(`CCC semantic-proof linked runtime path is non-canonical: ${entry.canonicalPath}`);
  }
  const handle = await open(canonicalPath, "r");
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new Error(`CCC semantic-proof linked runtime is not a regular file: ${canonicalPath}`);
    }
    const bytes = await handle.readFile();
    if (sha256(bytes) !== entry.sha256) {
      throw new Error(`CCC semantic-proof linked runtime drift detected: ${canonicalPath}`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function readPythonRuntimeByHandle(
  entry: CccPrdPythonRuntimeFile,
  label: string,
): Promise<{ canonicalPath: string; bytes: Buffer }> {
  if (!isAbsolute(entry.path)) {
    throw new Error(`CCC semantic-proof Python ${label} runtime path must be absolute`);
  }
  const directMetadata = await lstat(entry.path, { bigint: true });
  if (directMetadata.isSymbolicLink()) {
    throw new Error(`CCC semantic-proof Python ${label} runtime path must not be a symlink`);
  }
  const canonicalPath = await realpath(entry.path);
  if (canonicalPath !== entry.path) {
    throw new Error(`CCC semantic-proof Python ${label} runtime path must be canonical: ${entry.path}`);
  }
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const handle = await open(entry.path, fsConstants.O_RDONLY | noFollow);
  try {
    const metadata = await handle.stat({ bigint: true });
    if (
      !metadata.isFile()
      || metadata.dev !== directMetadata.dev
      || metadata.ino !== directMetadata.ino
      || metadata.mode !== directMetadata.mode
      || metadata.size !== directMetadata.size
      || metadata.mtimeNs !== directMetadata.mtimeNs
      || metadata.ctimeNs !== directMetadata.ctimeNs
      || metadata.birthtimeNs !== directMetadata.birthtimeNs
    ) {
      throw new Error(`CCC semantic-proof Python ${label} runtime path is not a regular file`);
    }
    const bytes = await handle.readFile();
    if (BigInt(bytes.length) !== metadata.size) {
      throw new Error(`CCC semantic-proof Python ${label} runtime size drifted: ${entry.path}`);
    }
    if (sha256(bytes) !== entry.sha256) {
      throw new Error(`CCC semantic-proof Python ${label} runtime digest drifted: ${entry.path}`);
    }
    return { canonicalPath, bytes };
  } finally {
    await handle.close();
  }
}

async function sealExecutable(
  toolchainRoot: string,
  identity: CccPrdExecutableIdentity,
): Promise<{ canonicalPath: string; sealedPath: string }> {
  const executable = await readExecutableByHandle(
    identity.executablePath,
    identity.executableSha256,
  );
  return {
    canonicalPath: executable.canonicalPath,
    sealedPath: await writeSealedExecutable(toolchainRoot, executable.canonicalPath, executable.bytes),
  };
}

async function sealPythonExecutionToolchain(
  toolchainRoot: string,
  python: CccPrdPythonExecutionToolchain,
  sealedByCanonicalPath: Map<string, string>,
): Promise<CccPrdPythonExecutionToolchain> {
  if (!/^(?:python3(?:\.\d+)*|Python)$/u.test(basename(python.executablePath))) {
    throw new Error("CCC semantic-proof Python verifier executable must be named python3");
  }
  const interpreter = await readPythonRuntimeByHandle(
    python.runtimeManifest.interpreter,
    "interpreter",
  );
  if (
    interpreter.canonicalPath !== python.executablePath
    || sha256(interpreter.bytes) !== python.executableSha256
  ) {
    throw new Error("CCC semantic-proof Python runtime interpreter identity does not match executable");
  }
  const sealRuntimeFile = async (
    entry: CccPrdPythonRuntimeFile,
    label: string,
    mode: number,
  ): Promise<CccPrdPythonRuntimeFile> => {
    const observed = await readPythonRuntimeByHandle(entry, label);
    let sealedPath = sealedByCanonicalPath.get(observed.canonicalPath);
    if (!sealedPath) {
      sealedPath = await writeSealedFile(toolchainRoot, observed.canonicalPath, observed.bytes, mode);
      sealedByCanonicalPath.set(observed.canonicalPath, sealedPath);
    }
    return {
      path: sealedPath,
      sha256: sha256(observed.bytes),
      ...(entry.requestedPaths ? { requestedPaths: [...entry.requestedPaths].sort() } : {}),
    };
  };
  const sealRuntimeRoot = async (root: string, label: string): Promise<string> => {
    if (!isAbsolute(root) || root.endsWith(sep)) {
      throw new Error(`CCC semantic-proof Python ${label} root must be canonical and absolute`);
    }
    const sealedRoot = resolve(toolchainRoot, sealedRelativeExecutablePath(root, `${label} root`));
    await mkdir(sealedRoot, { recursive: true });
    return sealedRoot;
  };
  const sealedInterpreter = await sealRuntimeFile(
    python.runtimeManifest.interpreter,
    "interpreter",
    0o555,
  );
  const sealCategory = async (
    entries: readonly CccPrdPythonRuntimeFile[],
    label: string,
  ) => Promise.all(entries.map((entry, index) => sealRuntimeFile(entry, `${label}[${index}]`, 0o444)));
  // Categories can overlap (stdlib extension modules are also listed in the
  // extension-module category). Seal them in order so the canonical-path map
  // is populated before a second category attempts the same file.
  const stdlib = await sealCategory(python.runtimeManifest.stdlib, "stdlib");
  const sitePackages = await sealCategory(python.runtimeManifest.sitePackages, "site-packages");
  const extensionModules = await sealCategory(python.runtimeManifest.extensionModules, "extension module");
  const dylibClosure = await sealCategory(python.runtimeManifest.dylibClosure, "dylib");
  const runtimeSupport = await Promise.all(python.runtimeManifest.runtimeSupport.map((entry, index) => (
    sealRuntimeFile(entry, `runtime support[${index}]`, 0o555)
  )));
  const [stdlibRoot, pythonHomeRoot, sitePackagesRoots, extensionModuleRoots] = await Promise.all([
    sealRuntimeRoot(python.runtimeManifest.stdlibRoot, "stdlib"),
    sealRuntimeRoot(python.runtimeManifest.pythonHomeRoot, "python home"),
    Promise.all(python.runtimeManifest.sitePackagesRoots.map((root) => sealRuntimeRoot(root, "site-packages"))),
    Promise.all(python.runtimeManifest.extensionModuleRoots.map((root) => sealRuntimeRoot(root, "extension-module"))),
  ]);
  const sealedIdentity = await sealedExecutableIdentity(sealedInterpreter.path, EXECUTABLE_VERSION_ARGS);
  return {
    ...sealedIdentity,
    runtimeManifest: {
      schema: python.runtimeManifest.schema,
      interpreter: sealedInterpreter,
      stdlibRoot,
      pythonHomeRoot,
      sitePackagesRoots,
      extensionModuleRoots,
      runtimeSupport,
      stdlib,
      sitePackages,
      extensionModules,
      dylibClosure,
    },
  };
}

async function refreshSealedPythonExecutionToolchain(
  python: CccPrdPythonExecutionToolchain,
): Promise<CccPrdPythonExecutionToolchain> {
  const identity = await sealedExecutableIdentity(python.executablePath, EXECUTABLE_VERSION_ARGS);
  const refresh = async (entry: CccPrdPythonRuntimeFile): Promise<CccPrdPythonRuntimeFile> => ({
    path: entry.path,
    sha256: sha256(await readFile(entry.path)),
    ...(entry.requestedPaths ? { requestedPaths: [...entry.requestedPaths].sort() } : {}),
  });
  const interpreter = {
    path: identity.executablePath,
    sha256: identity.executableSha256,
  };
  if (basename(identity.executablePath) !== "python3") {
    const aliasPath = resolve(dirname(identity.executablePath), "python3");
    await writeFile(aliasPath, await readFile(identity.executablePath), { flag: "wx", mode: 0o555 });
    await chmod(aliasPath, 0o555);
  }
  return {
    ...identity,
    runtimeManifest: {
      schema: python.runtimeManifest.schema,
      interpreter,
      stdlibRoot: python.runtimeManifest.stdlibRoot,
      pythonHomeRoot: python.runtimeManifest.pythonHomeRoot,
      sitePackagesRoots: [...python.runtimeManifest.sitePackagesRoots],
      extensionModuleRoots: [...python.runtimeManifest.extensionModuleRoots],
      stdlib: await Promise.all(python.runtimeManifest.stdlib.map(refresh)),
      sitePackages: await Promise.all(python.runtimeManifest.sitePackages.map(refresh)),
      extensionModules: await Promise.all(python.runtimeManifest.extensionModules.map(refresh)),
      dylibClosure: await Promise.all(python.runtimeManifest.dylibClosure.map(refresh)),
      runtimeSupport: await Promise.all(python.runtimeManifest.runtimeSupport.map(refresh)),
    },
  };
}

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

async function isDarwinMachOFile(path: string): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  const bytes = await readFile(path);
  if (bytes.length < 4) return false;
  return MACH_O_MAGICS.has(bytes.readUInt32BE(0)) || MACH_O_MAGICS.has(bytes.readUInt32LE(0));
}

async function inspectDarwinLinkedLibraries(path: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFile("/usr/bin/otool", ["-L", path], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: OTOOL_TIMEOUT_MS,
      windowsHide: true,
    });
    return stdout;
  } catch (error) {
    if (await isDarwinMachOFile(path)) {
      throw new Error(`CCC semantic-proof otool inspection failed for Mach-O file: ${path}`, {
        cause: error,
      });
    }
    return undefined;
  }
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
      const stdout = await inspectDarwinLinkedLibraries(loader.loaderPath);
      if (stdout === undefined) continue;
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

export async function inspectCccSemanticProofLinkedRuntime(
  toolchain: Pick<CccPrdProofExecutionToolchain, "task" | "node" | "proofHost">,
): Promise<CccPrdLinkedRuntimeEntry[]> {
  return darwinHomebrewLinkedRuntimeManifest([
    {
      loaderRole: "task",
      loaderPath: toolchain.task.executablePath,
      rootExecutablePath: toolchain.task.executablePath,
    },
    {
      loaderRole: "node",
      loaderPath: toolchain.node.executablePath,
      rootExecutablePath: toolchain.node.executablePath,
    },
    {
      loaderRole: "proof_host",
      loaderPath: toolchain.proofHost.executablePath,
      rootExecutablePath: toolchain.proofHost.executablePath,
    },
  ]);
}

function canonicalLinkedRuntimeJson(entries: readonly CccPrdLinkedRuntimeEntry[]): string {
  const canonicalEntries = entries.map((entry): CccPrdLinkedRuntimeEntry => ({
    platform: entry.platform,
    loaderRole: entry.loaderRole,
    loaderPath: entry.loaderPath,
    requestedPath: entry.requestedPath,
    canonicalPath: entry.canonicalPath,
    sha256: entry.sha256,
  }));
  return JSON.stringify(canonicalEntries.sort((left, right) => (
    linkedRuntimeKey(left) < linkedRuntimeKey(right)
      ? -1
      : linkedRuntimeKey(left) > linkedRuntimeKey(right)
        ? 1
        : 0
  )));
}

async function sealDarwinLinkedRuntime(
  toolchainRoot: string,
  manifest: readonly CccPrdLinkedRuntimeEntry[],
  sealedByCanonicalPath: Map<string, string>,
): Promise<CccPrdLinkedRuntimeEntry[]> {
  const sealedEntries: CccPrdLinkedRuntimeEntry[] = [];
  for (const entry of manifest) {
    const bytes = await readLinkedRuntimeByHandle(entry);
    let sealedPath = sealedByCanonicalPath.get(entry.canonicalPath);
    if (!sealedPath) {
      sealedPath = await writeSealedFile(toolchainRoot, entry.canonicalPath, bytes, 0o444);
      sealedByCanonicalPath.set(entry.canonicalPath, sealedPath);
    }
    if (entry.requestedPath.startsWith("/opt/homebrew/")) {
      const requestedSealedPath = resolve(
        toolchainRoot,
        sealedRelativeExecutablePath(entry.requestedPath, "sealed requested runtime"),
      );
      if (!existsSync(requestedSealedPath)) {
        await writeSealedFile(toolchainRoot, entry.requestedPath, bytes, 0o444);
      }
    }
    sealedEntries.push({
      ...entry,
      loaderPath: sealedByCanonicalPath.get(entry.loaderPath) ?? entry.loaderPath,
      canonicalPath: sealedPath,
      requestedPath: entry.requestedPath.startsWith("/opt/homebrew/")
        ? resolve(toolchainRoot, sealedRelativeExecutablePath(entry.requestedPath, "sealed requested runtime"))
        : entry.requestedPath,
    });
  }
  return sealedEntries.sort((left, right) => (
    linkedRuntimeKey(left) < linkedRuntimeKey(right)
      ? -1
      : linkedRuntimeKey(left) > linkedRuntimeKey(right)
        ? 1
        : 0
  ));
}

async function patchDarwinInstallNames(
  machOPath: string,
  manifest: readonly CccPrdLinkedRuntimeEntry[],
  dylibId?: string,
): Promise<void> {
  if (process.platform !== "darwin") return;
  const output = await inspectDarwinLinkedLibraries(machOPath) ?? "";
  if (output.length === 0) return;
  const linkedNames = new Set(
    output
      .split("\n")
      .slice(1)
      .map((line) => line.trim().split(/\s+/u)[0])
      .filter((name): name is string => Boolean(name)),
  );
  const changes = new Map<string, string>();
  for (const entry of manifest) {
    if (
      linkedNames.has(entry.requestedPath)
      && (
        entry.requestedPath.startsWith("/")
        && !entry.requestedPath.startsWith("/usr/lib/")
        && !entry.requestedPath.startsWith("/System/Library/")
        || entry.requestedPath.startsWith("@rpath/")
        || entry.requestedPath.startsWith("@loader_path/")
        || entry.requestedPath.startsWith("@executable_path/")
      )
    ) {
      changes.set(entry.requestedPath, entry.canonicalPath);
    }
  }
  // Python's extension modules frequently name a dylib through @rpath (for
  // example @rpath/libmpdec.dylib), while the custody manifest records the
  // controller-observed absolute closure path. Match that basename only when
  // custody provides exactly one non-system candidate; ambiguity is a hard
  // refusal rather than a best-effort rewrite.
  for (const linkedName of linkedNames) {
    if (changes.has(linkedName) || linkedName.startsWith("/usr/lib/") || linkedName.startsWith("/System/Library/")) continue;
    const linkedBase = basename(linkedName);
    const candidates = manifest.filter((entry) => (
      basename(entry.requestedPath) === linkedBase
      || basename(entry.canonicalPath) === linkedBase
    ));
    const uniqueCandidates = [...new Map(candidates.map((entry) => [entry.canonicalPath, entry])).values()];
    if (uniqueCandidates.length === 1 && (
      linkedName.startsWith("@rpath/")
      || linkedName.startsWith("@loader_path/")
      || linkedName.startsWith("@executable_path/")
      || linkedName.startsWith("/")
    )) {
      changes.set(linkedName, uniqueCandidates[0]!.canonicalPath);
    } else if (uniqueCandidates.length > 1) {
      throw new Error(`CCC semantic-proof Python dylib dependency is ambiguous: ${linkedName}`);
    }
  }
  if (changes.size === 0 && !dylibId) return;
  await chmod(machOPath, 0o755);
  if (dylibId) {
    await execFile("/usr/bin/install_name_tool", ["-id", dylibId, machOPath], {
      encoding: "buffer",
      maxBuffer: 1024 * 1024,
      timeout: INSTALL_NAME_TOOL_TIMEOUT_MS,
      windowsHide: true,
    });
  }
  for (const [requestedPath, sealedPath] of changes) {
    await execFile("/usr/bin/install_name_tool", ["-change", requestedPath, sealedPath, machOPath], {
      encoding: "buffer",
      maxBuffer: 1024 * 1024,
      timeout: INSTALL_NAME_TOOL_TIMEOUT_MS,
      windowsHide: true,
    });
  }
  await execFile("/usr/bin/codesign", ["--force", "--sign", "-", "--timestamp=none", machOPath], {
    encoding: "buffer",
    maxBuffer: 1024 * 1024,
    timeout: INSTALL_NAME_TOOL_TIMEOUT_MS,
    windowsHide: true,
  });
  await execFile("/usr/bin/codesign", ["--verify", machOPath], {
    encoding: "buffer",
    maxBuffer: 1024 * 1024,
    timeout: INSTALL_NAME_TOOL_TIMEOUT_MS,
    windowsHide: true,
  });
}

async function assertSealedDarwinLinkedRuntimeGraph(
  toolchainRoot: string,
  machOPaths: readonly string[],
): Promise<void> {
  if (process.platform !== "darwin") return;
  for (const machOPath of machOPaths) {
    const output = await inspectDarwinLinkedLibraries(machOPath) ?? "";
    if (output.length === 0) continue;
    for (const line of output.split("\n").slice(1)) {
      const dependency = line.trim().split(/\s+/u)[0];
      if (!dependency) continue;
      if (
        dependency.startsWith("/usr/lib/")
        || dependency.startsWith("/System/Library/")
        || dependency.startsWith(`${toolchainRoot}/`)
      ) {
        continue;
      }
      const resolved = resolveDarwinLinkedPath(dependency, machOPath, machOPath);
      if (resolved?.startsWith(`${toolchainRoot}/`)) continue;
      throw new Error(`CCC semantic-proof sealed runtime graph escaped toolchain root: ${dependency}`);
    }
  }
}

async function sealedExecutableIdentity(
  path: string,
  versionArgs: readonly string[],
): Promise<CccPrdExecutableIdentity> {
  const observed = await inspectExecutableBytes(path);
  const version = await inspectExecutableVersion(observed.canonicalPath, versionArgs);
  return {
    executablePath: observed.canonicalPath,
    executableSha256: observed.executableSha256,
    ...version,
  };
}

async function sealedProofHostIdentity(
  proofHostPath: string,
  sealedNodePath: string,
  id: string,
): Promise<CccPrdProofExecutionToolchain["proofHost"]> {
  const observed = await inspectExecutableBytes(proofHostPath);
  const isMachOProofHost = await isDarwinMachOFile(observed.canonicalPath);
  const version = isMachOProofHost
    ? await inspectExecutableVersion(observed.canonicalPath, EXECUTABLE_VERSION_ARGS)
    : await (async (): Promise<Pick<CccPrdExecutableIdentity, "version" | "versionOutputSha256">> => {
      const { stdout, stderr } = await runExecutableVersionProbe(
        sealedNodePath,
        [observed.canonicalPath, ...EXECUTABLE_VERSION_ARGS],
      );
      const versionOutput = Buffer.concat([stdout, stderr]);
      const versionText = versionOutput.toString("utf8").trim();
      if (versionText.length === 0) throw new Error("CCC semantic-proof proof-host version output is empty");
      return {
        version: versionText,
        versionOutputSha256: sha256(versionOutput),
      };
    })();
  return {
    id,
    executablePath: observed.canonicalPath,
    executableSha256: observed.executableSha256,
    ...version,
  };
}

async function refreshedSealedLinkedRuntimeManifest(
  linkedRuntime: readonly CccPrdLinkedRuntimeEntry[],
): Promise<CccPrdLinkedRuntimeEntry[]> {
  return Promise.all(linkedRuntime.map(async (entry) => ({
    ...entry,
    sha256: sha256(await readFile(entry.canonicalPath)),
  })));
}

async function sealExecutionToolchain(
  outputRoot: string,
  toolchain: CccPrdProofExecutionToolchain,
): Promise<CccSemanticProofMaterialization["sealedExecutionToolchain"]> {
  const toolchainRoot = join(outputRoot, "toolchain");
  await mkdir(toolchainRoot, { mode: 0o755 });
  const sealedByCanonicalPath = new Map<string, string>();
  const sealOnce = async (identity: CccPrdExecutableIdentity): Promise<string> => {
    const canonicalPath = await realpath(identity.executablePath);
    const existing = sealedByCanonicalPath.get(canonicalPath);
    if (existing) return existing;
    const { sealedPath } = await sealExecutable(toolchainRoot, identity);
    sealedByCanonicalPath.set(canonicalPath, sealedPath);
    return sealedPath;
  };
  const taskExecutable = await sealOnce(toolchain.task);
  const nodeExecutable = await sealOnce(toolchain.node);
  const proofHostExecutable = await sealOnce(toolchain.proofHost);
  const python = toolchain.python
    ? await sealPythonExecutionToolchain(toolchainRoot, toolchain.python, sealedByCanonicalPath)
    : undefined;
  const linkedRuntime = await sealDarwinLinkedRuntime(
    toolchainRoot,
    toolchain.linkedRuntime,
    sealedByCanonicalPath,
  );
  const rewriteManifest = toolchain.linkedRuntime.map((entry): CccPrdLinkedRuntimeEntry => ({
    ...entry,
    canonicalPath: sealedByCanonicalPath.get(entry.canonicalPath) ?? entry.canonicalPath,
    loaderPath: sealedByCanonicalPath.get(entry.loaderPath) ?? entry.loaderPath,
  }));
  const pythonRewriteManifest = python
    ? toolchain.python!.runtimeManifest.dylibClosure.flatMap((entry): CccPrdLinkedRuntimeEntry[] => {
      const canonicalPath = sealedByCanonicalPath.get(entry.path) ?? entry.path;
      const requestedPaths = entry.requestedPaths?.length ? entry.requestedPaths : [entry.path];
      return requestedPaths.map((requestedPath) => ({
        platform: "darwin",
        loaderRole: "linked_runtime",
        loaderPath: toolchain.python!.executablePath,
        requestedPath,
        canonicalPath,
        sha256: entry.sha256,
      }));
    })
    : [];
  const allRewriteManifest = [...rewriteManifest, ...pythonRewriteManifest];
  const linkedRuntimeByCanonicalPath = new Map<string, CccPrdLinkedRuntimeEntry>();
  for (const entry of linkedRuntime) linkedRuntimeByCanonicalPath.set(entry.canonicalPath, entry);
  const machOPaths = [
    taskExecutable,
    nodeExecutable,
    proofHostExecutable,
    ...(python ? [python.executablePath, ...[
      ...python.runtimeManifest.stdlib,
      ...python.runtimeManifest.sitePackages,
      ...python.runtimeManifest.extensionModules,
      ...python.runtimeManifest.dylibClosure,
      ...python.runtimeManifest.runtimeSupport,
    ].map((entry) => entry.path)] : []),
    ...linkedRuntimeByCanonicalPath.keys(),
  ];
  const sealedPythonDylibIds = new Set(
    toolchain.python?.runtimeManifest.dylibClosure
      .map((entry) => sealedByCanonicalPath.get(entry.path))
      .filter((path): path is string => path !== undefined) ?? [],
  );
  for (const machOPath of machOPaths) {
    await patchDarwinInstallNames(
      machOPath,
      allRewriteManifest,
      linkedRuntimeByCanonicalPath.get(machOPath)?.canonicalPath
        ?? (sealedPythonDylibIds.has(machOPath) ? machOPath : undefined),
    );
  }
  await assertSealedDarwinLinkedRuntimeGraph(toolchainRoot, machOPaths);
  await Promise.all([
    chmod(taskExecutable, 0o555),
    chmod(nodeExecutable, 0o555),
    chmod(proofHostExecutable, 0o555),
    ...linkedRuntime.map((entry) => chmod(entry.canonicalPath, 0o444)),
    ...(python ? [
      chmod(python.executablePath, 0o555),
      ...[
        ...python.runtimeManifest.stdlib,
        ...python.runtimeManifest.sitePackages,
        ...python.runtimeManifest.extensionModules,
      ].map((entry) => chmod(entry.path, 0o444)),
      ...python.runtimeManifest.dylibClosure.map((entry) => chmod(entry.path, 0o444)),
      ...python.runtimeManifest.runtimeSupport.map((entry) => chmod(entry.path, 0o555)),
    ] : []),
  ]);
  const [sealedTask, sealedNode] = await Promise.all([
    sealedExecutableIdentity(taskExecutable, EXECUTABLE_VERSION_ARGS),
    sealedExecutableIdentity(nodeExecutable, EXECUTABLE_VERSION_ARGS),
  ]);
  const sealedProofHost = await sealedProofHostIdentity(
    proofHostExecutable,
    sealedNode.executablePath,
    toolchain.proofHost.id,
  );
  const refreshedPython = python
    ? await refreshSealedPythonExecutionToolchain(python)
    : undefined;
  await chmod(toolchainRoot, 0o555);
  return {
    task: sealedTask,
    node: sealedNode,
    proofHost: sealedProofHost,
    linkedRuntime: await refreshedSealedLinkedRuntimeManifest(linkedRuntime),
    ...(refreshedPython ? { python: refreshedPython } : {}),
  };
}

export async function admitAndMaterializeCccSemanticProof(
  input: CccSemanticProofMaterializationInput,
): Promise<CccSemanticProofMaterialization> {
  const repositoryRoot = await realpath(input.repositoryRoot);
  const outputRoot = await realpath(input.outputRoot);
  if (input.proof.schema !== "ccc-prd.proof.v2") {
    throw new Error("CCC semantic-proof materialization requires proof.v2");
  }
  const closurePaths = new Set<string>();
  const candidatePaths = new Set<string>();
  const closure: Array<{ entry: CccPrdVerifierClosureEntry; bytes: Buffer }> = [];
  for (const rawEntry of input.proof.verifierClosure) {
    const entry = { ...rawEntry, path: canonicalRelativePath(rawEntry.path, "CCC semantic-proof closure path") };
    if (
      closurePaths.has(entry.path)
      || !GIT_BLOB_OID.test(entry.baseGitBlobOid)
      || !LOWER_SHA256.test(entry.sha256)
    ) {
      throw new Error(`CCC semantic-proof verifier closure entry is duplicated or malformed: ${entry.path}`);
    }
    closurePaths.add(entry.path);
    assertDisjointClosure(entry, input.modelWriteRoots);
    const blob = await gitBytes(repositoryRoot, input.baseCommit, entry.path);
    if (blob.oid !== entry.baseGitBlobOid || sha256(blob.bytes) !== entry.sha256) {
      throw new Error(`CCC semantic-proof frozen verifier custody drifted: ${entry.path}`);
    }
    closure.push({ entry, bytes: blob.bytes });
  }
  const runners = closure.filter(({ entry }) => entry.role === "task_runner");
  if (runners.length !== 1 || runners[0]!.entry.path !== "Taskfile.yml") {
    throw new Error("CCC semantic-proof closure requires exactly one baseline Taskfile.yml task runner");
  }
  const task = verifyTaskfile(runners[0]!.bytes, input.proof);

  const candidates: Array<{ path: string; bytes: Buffer }> = [];
  for (const rawPath of input.proof.candidateInputs) {
    const path = canonicalRelativePath(rawPath, "CCC semantic-proof candidate path");
    if (candidatePaths.has(path) || closurePaths.has(path)) {
      throw new Error(`CCC semantic-proof candidate path is duplicated or overlaps closure: ${path}`);
    }
    candidatePaths.add(path);
    candidates.push({ path, bytes: (await gitBytes(repositoryRoot, input.sourceCommit, path)).bytes });
  }
  const proofRoot = join(outputRoot, "proof");
  const scratchRoot = join(outputRoot, "scratch");
  await Promise.all([mkdir(proofRoot, { mode: 0o755 }), mkdir(scratchRoot, { mode: 0o700 })]);
  await writeFile(join(proofRoot, SEALED_OPENSSL_CONF), "", { flag: "wx", mode: 0o444 });
  await chmod(join(proofRoot, SEALED_OPENSSL_CONF), 0o444);
  for (const item of closure) await materialize(proofRoot, item.entry.path, item.bytes);
  for (const item of candidates) await materialize(proofRoot, item.path, item.bytes);
  const observedLinkedRuntime = await inspectCccSemanticProofLinkedRuntime(input.proof.executionToolchain);
  if (
    canonicalLinkedRuntimeJson(observedLinkedRuntime)
      !== canonicalLinkedRuntimeJson(input.proof.executionToolchain.linkedRuntime)
  ) {
    throw new Error("CCC semantic-proof linked runtime manifest drift detected");
  }
  const sealedExecutionToolchain = await sealExecutionToolchain(outputRoot, input.proof.executionToolchain);
  await chmod(proofRoot, 0o555);
  return {
    proofRoot,
    scratchRoot,
    ...task,
    closureSha256: computeCccPrdVerifierClosureSha256(input.proof.verifierClosure),
    candidateInputsSha256: computeCccPrdCandidateInputsSha256(input.proof.candidateInputs),
    sealedToolchain: {
      taskExecutable: sealedExecutionToolchain.task.executablePath,
      nodeExecutable: sealedExecutionToolchain.node.executablePath,
      proofHostExecutable: sealedExecutionToolchain.proofHost.executablePath,
    },
    sealedExecutionToolchain,
  };
}
