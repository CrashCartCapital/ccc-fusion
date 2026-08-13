import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants, existsSync } from "node:fs";
import { access, chmod, lstat, mkdir, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, isAbsolute, normalize, resolve, sep } from "node:path";
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
const OTOOL_TIMEOUT_MS = 10_000;

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
  const tokens = parseLiteralCommand(plainScalar(commands.items[0] as Node, "command"));
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
  let selectedTokens: string[] | undefined;
  for (const [targetName, targetNode] of tasks) {
    const tokens = verifyStrictTaskTarget(targetName, targetNode);
    if (targetName === selectedTarget) selectedTokens = tokens;
  }
  const tokens = selectedTokens!;
  const harnesses = proof.verifierClosure
    .filter((entry) => entry.role === "harness")
    .map((entry) => entry.path);
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
  return {
    task: staticExecutableIdentity(task),
    node: staticExecutableIdentity(node),
    proofHost: {
      id: CCC_PRD_SEMANTIC_PROOF_HOST_ID,
      ...staticExecutableIdentity(proofHost),
    },
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
  let toolchain: CccPrdProofExecutionToolchain;
  try {
    toolchain = await deriveToolchain(input.toolchainPaths, expectedToolchain);
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
  const staticToolchain = await deriveStaticToolchain(input.toolchainPaths);
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
