import { constants as fsConstants } from "node:fs";
import { accessSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CCC_PRD_SEMANTIC_PROOF_HOST_ID,
  type CccPrdSemanticProofToolchainPaths,
} from "@fusion/core";

function regularExecutable(path: string): string | null {
  try {
    const canonical = realpathSync(path);
    const metadata = lstatSync(canonical);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return null;
    accessSync(canonical, fsConstants.X_OK);
    return canonical;
  } catch {
    return null;
  }
}

function resolvePathExecutable(name: string, label: string, env: NodeJS.ProcessEnv): string {
  const pathValue = env.PATH;
  if (!pathValue) throw new Error(`CCC semantic-proof ${label} executable is absent from PATH`);
  const suffixes = process.platform === "win32"
    ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];
  for (const root of pathValue.split(delimiter)) {
    if (!root) continue;
    for (const suffix of suffixes) {
      const candidate = regularExecutable(join(root, `${name}${suffix}`));
      if (candidate) return candidate;
    }
  }
  throw new Error(`CCC semantic-proof ${label} executable is absent from PATH`);
}

function resolveBuiltProofHost(moduleUrl: string): string {
  const modulePath = fileURLToPath(moduleUrl);
  const moduleDir = dirname(modulePath);
  const candidates = [
    join(moduleDir, "ccc-campaign-proof-admission.js"),
    resolve(moduleDir, "../../dist/ccc-campaign-proof-admission.js"),
  ];
  for (const candidate of candidates) {
    const executable = regularExecutable(candidate);
    if (executable) return executable;
  }
  throw new Error(
    "CCC semantic-proof dedicated proof host is unavailable; build packages/cli/dist/ccc-campaign-proof-admission.js before executable authoring",
  );
}

function resolvePythonPathRoots(roots: readonly string[] | undefined): string[] {
  if (roots === undefined) return [];
  if (!Array.isArray(roots) || roots.length > 16) {
    throw new Error("CCC semantic-proof Python path roots are unbounded");
  }
  const resolved: string[] = [];
  for (const [index, root] of roots.entries()) {
    if (
      typeof root !== "string"
      || root.length === 0
      || root !== root.trim()
      || !isAbsolute(root)
      || root.endsWith(sep)
      || root.includes(delimiter)
    ) {
      throw new Error(`CCC semantic-proof Python path root ${index} must be an existing canonical absolute directory`);
    }
    let canonical: string;
    try {
      canonical = realpathSync(root);
      const metadata = lstatSync(canonical);
      if (canonical !== root || !metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("not canonical");
    } catch {
      throw new Error(`CCC semantic-proof Python path root ${index} is unavailable: ${root}`);
    }
    if (resolved.includes(canonical)) {
      throw new Error(`CCC semantic-proof Python path root ${index} is duplicated: ${canonical}`);
    }
    resolved.push(canonical);
  }
  return resolved.sort();
}

export function resolveCccPrdTargetPythonPathRoots(targetRoot: string): string[] {
  return resolveCccPrdTargetPythonRuntime(targetRoot).pythonPathRoots;
}

type CccPrdTargetPythonRuntime = Readonly<{
  pythonExecutablePath: string;
  pythonPathRoots: string[];
}>;

function canonicalDirectory(path: string, label: string): string {
  let direct;
  try {
    direct = lstatSync(path);
  } catch {
    throw new Error(`CCC semantic-proof ${label} is unavailable: ${path}`);
  }
  if (direct.isSymbolicLink() || !direct.isDirectory()) {
    throw new Error(`CCC semantic-proof ${label} must be a canonical directory: ${path}`);
  }
  let canonical: string;
  try {
    canonical = realpathSync(path);
  } catch {
    throw new Error(`CCC semantic-proof ${label} could not be canonicalized: ${path}`);
  }
  if (canonical !== path) {
    throw new Error(`CCC semantic-proof ${label} must not contain symlink components: ${path}`);
  }
  return canonical;
}

function resolvedCanonicalDirectory(path: string, label: string): string {
  try {
    const canonical = realpathSync(path);
    const metadata = lstatSync(canonical);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("not a directory");
    return canonical;
  } catch {
    throw new Error(`CCC semantic-proof ${label} could not be resolved to a canonical directory: ${path}`);
  }
}

function parseTargetVenvConfig(configPath: string): { version: string; home: string } {
  let contents: string;
  try {
    const metadata = lstatSync(configPath);
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error("not a regular file");
    if (realpathSync(configPath) !== configPath) throw new Error("non-canonical path");
    contents = readFileSync(configPath, "utf8");
  } catch {
    throw new Error(`CCC semantic-proof active Python venv config is unavailable: ${configPath}`);
  }
  const values = new Map<string, string>();
  for (const line of contents.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) throw new Error(`CCC semantic-proof active Python venv config is malformed: ${configPath}`);
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    if (!key || !value || values.has(key)) {
      throw new Error(`CCC semantic-proof active Python venv config is ambiguous: ${configPath}`);
    }
    values.set(key, value);
  }
  const versionValues = [values.get("version_info"), values.get("version")].filter(
    (value): value is string => value !== undefined,
  );
  if (versionValues.length !== 1) {
    throw new Error(`CCC semantic-proof active Python venv config is ambiguous: ${configPath}`);
  }
  const versionValue = versionValues[0];
  const version = versionValue?.match(/^(\d+\.\d+)(?:\.\d+)?$/u)?.[1];
  const home = values.get("home");
  if (!version || !home || !isAbsolute(home) || values.get("include-system-site-packages") !== "false") {
    throw new Error(`CCC semantic-proof active Python venv config is mismatched: ${configPath}`);
  }
  // uv writes a stable version alias into pyvenv.cfg (for example,
  // cpython-3.12-macos-aarch64-none -> cpython-3.12.11-macos-aarch64-none).
  // Persist and compare only its resolved directory; execution and sealing use
  // the same canonical interpreter path, so the mutable alias is not authority.
  const canonicalHome = resolvedCanonicalDirectory(home, "active Python venv home");
  return { version, home: canonicalHome };
}

function resolveCccPrdTargetPythonRuntime(targetRoot: string): CccPrdTargetPythonRuntime {
  let targetMetadata;
  try {
    targetMetadata = lstatSync(targetRoot);
  } catch {
    throw new Error(`CCC semantic-proof target repository is unavailable: ${targetRoot}`);
  }
  if (targetMetadata.isSymbolicLink()) {
    throw new Error(`CCC semantic-proof target repository must not be a symlink: ${targetRoot}`);
  }
  const canonicalTargetRoot = canonicalDirectory(realpathSync(targetRoot), "target repository");
  const venvRoot = canonicalDirectory(join(canonicalTargetRoot, ".venv"), "active Python venv");
  const config = parseTargetVenvConfig(join(venvRoot, "pyvenv.cfg"));
  const binRoot = canonicalDirectory(join(venvRoot, process.platform === "win32" ? "Scripts" : "bin"), "active Python venv executable root");
  const launcher = join(binRoot, process.platform === "win32" ? "python.exe" : "python3");
  const pythonExecutablePath = regularExecutable(launcher);
  if (
    !pythonExecutablePath
    || basename(pythonExecutablePath) !== `python${config.version}`
    || dirname(pythonExecutablePath) !== config.home
  ) {
    throw new Error(`CCC semantic-proof active Python venv interpreter mismatches version ${config.version}`);
  }
  const libraryRoot = canonicalDirectory(
    join(venvRoot, process.platform === "win32" ? "Lib" : "lib"),
    "active Python venv library root",
  );
  const sitePackagesRoots = readdirSync(libraryRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^python\d+\.\d+$/u.test(entry.name))
    .map((entry) => join(libraryRoot, entry.name, "site-packages"))
    .filter((path) => {
      try {
        return lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink();
      } catch {
        return false;
      }
    });
  if (sitePackagesRoots.length !== 1) {
    throw new Error(`CCC semantic-proof active Python venv site-packages root is ambiguous or absent: ${libraryRoot}`);
  }
  const sitePackagesRoot = canonicalDirectory(sitePackagesRoots[0]!, "active Python venv site-packages root");
  if (!sitePackagesRoot.endsWith(`${sep}python${config.version}${sep}site-packages`)) {
    throw new Error(`CCC semantic-proof active Python venv site-packages root mismatches version ${config.version}`);
  }
  return { pythonExecutablePath, pythonPathRoots: [sitePackagesRoot] };
}

/**
 * Resolve only deliberate production identities. In particular this never
 * falls back to process.argv[1], which may be Vitest, tsx, or another caller
 * that has no authority to become the persisted proof host.
 */
export function resolveCccPrdSemanticProofToolchainPaths(input: Readonly<{
  moduleUrl?: string;
  env?: NodeJS.ProcessEnv;
  nodeExecutablePath?: string;
  pythonExecutablePath?: string;
  pythonPathRoots?: readonly string[];
  pythonRequired?: boolean;
  targetRoot?: string;
}> = {}): CccPrdSemanticProofToolchainPaths {
  const nodeExecutablePath = regularExecutable(input.nodeExecutablePath ?? process.execPath);
  if (!nodeExecutablePath || !isAbsolute(nodeExecutablePath)) {
    throw new Error("CCC semantic-proof Node executable identity is unavailable");
  }
  const targetPythonRuntime = input.pythonRequired
    ? (input.targetRoot
      ? resolveCccPrdTargetPythonRuntime(input.targetRoot)
      : (() => {
        throw new Error("CCC semantic-proof Python proof requires an explicit target repository root");
      })())
    : undefined;
  const requestedPythonPath = input.pythonExecutablePath
    ?? targetPythonRuntime?.pythonExecutablePath
    ?? (input.pythonRequired
      ? resolvePathExecutable("python3", "Python", input.env ?? process.env)
      : undefined);
  const pythonExecutablePath = requestedPythonPath
    ? regularExecutable(requestedPythonPath)
    : undefined;
  if (requestedPythonPath && !pythonExecutablePath) {
    throw new Error("CCC semantic-proof Python executable identity is unavailable");
  }
  if (targetPythonRuntime && pythonExecutablePath !== targetPythonRuntime.pythonExecutablePath) {
    throw new Error("CCC semantic-proof Python executable does not match the active target venv");
  }
  const suppliedPythonPathRoots = resolvePythonPathRoots(input.pythonPathRoots);
  if (
    targetPythonRuntime
    && suppliedPythonPathRoots.length > 0
    && JSON.stringify(suppliedPythonPathRoots) !== JSON.stringify(targetPythonRuntime.pythonPathRoots)
  ) {
    throw new Error("CCC semantic-proof Python path roots do not match the active target venv");
  }
  const pythonPathRoots = targetPythonRuntime?.pythonPathRoots ?? suppliedPythonPathRoots;
  return {
    taskExecutablePath: resolvePathExecutable("task", "Task", input.env ?? process.env),
    nodeExecutablePath,
    ...(pythonExecutablePath ? { pythonExecutablePath } : {}),
    ...(pythonPathRoots.length > 0 ? { pythonPathRoots } : {}),
    proofHost: {
      id: CCC_PRD_SEMANTIC_PROOF_HOST_ID,
      executablePath: resolveBuiltProofHost(input.moduleUrl ?? import.meta.url),
    },
  };
}
