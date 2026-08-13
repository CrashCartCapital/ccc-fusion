import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { superviseSpawn } from "@fusion/core";

const DARWIN_SANDBOX_EXECUTABLE = "/usr/bin/sandbox-exec";
const DARWIN_SHELL_EXECUTABLE = "/bin/sh";
const DARWIN_SELECTED_SHELL_EXECUTABLE = "/bin/bash";
const DARWIN_SHELL_SELECTION_PATH = "/private/var/select/sh";
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const TERMINATION_GRACE_MS = 1_000;
const OTOOL_TIMEOUT_MS = 10_000;
const SEALED_OPENSSL_CONF = ".ccc-empty-openssl.cnf";
const execFile = promisify(execFileCallback);

export type CccSemanticProofSandboxPolicyInput = {
  proofRoot: string;
  scratchRoot: string;
  taskExecutable: string;
  nodeExecutable: string;
  deniedReadRoots: readonly string[];
};

export type RunCccSemanticProofSandboxedProcessInput =
  CccSemanticProofSandboxPolicyInput & {
    executable: string;
    args: readonly string[];
    proofEnvironment?: CccSemanticProofControllerEnvironment;
    timeoutMs?: number;
    maxOutputBytes?: number;
  };

export type CccSemanticProofControllerEnvironment = Readonly<{
  CCC_PROOF_ID: string;
  CCC_PROOF_PHASE: "task" | "final_integrated";
  CCC_PROOF_SOURCE_COMMIT: string;
  CCC_PROOF_SOURCE_TREE: string;
}>;

export type CccSemanticProofSandboxedProcessResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutSha256: string;
  stderrSha256: string;
  timedOut: boolean;
  killed: boolean;
  outputOverLimit: boolean;
  spawnError?: string;
};

function sbplString(value: string): string {
  const bytes = Buffer.from(value, "utf8");
  let escaped = "";
  for (const byte of bytes) {
    if (byte === 0x22) escaped += '\\"';
    else if (byte === 0x5c) escaped += "\\\\";
    else if (byte >= 0x20 && byte <= 0x7e) escaped += String.fromCharCode(byte);
    else escaped += `\\x${byte.toString(16).padStart(2, "0")}`;
  }
  return `"${escaped}"`;
}

function sbplLiteral(path: string): string {
  return `(literal ${sbplString(path)})`;
}

function sbplSubpath(path: string): string {
  return `(subpath ${sbplString(path)})`;
}

function canonicalExistingPath(path: string, label: string): string {
  if (!isAbsolute(path)) throw new Error(`${label} must be absolute`);
  try {
    return realpathSync(path);
  } catch {
    throw new Error(`${label} is missing or cannot be resolved: ${path}`);
  }
}

function isSameOrWithin(path: string, parent: string): boolean {
  const fromParent = relative(parent, path);
  return fromParent === ""
    || (!fromParent.startsWith(`..${sep}`) && fromParent !== ".." && !isAbsolute(fromParent));
}

function uniqueSorted(paths: readonly string[]): string[] {
  return [...new Set(paths)].sort((left, right) => (
    left < right ? -1 : left > right ? 1 : 0
  ));
}

function pathAncestors(path: string): string[] {
  const ancestors: string[] = [];
  let current = path;
  while (current !== sep) {
    current = dirname(current);
    ancestors.push(current);
  }
  return ancestors;
}

function executableInstallRoot(executable: string): string {
  const binDirectory = dirname(executable);
  return dirname(binDirectory);
}

function sealedToolchainRoot(path: string): string | undefined {
  const marker = `${sep}toolchain${sep}`;
  const index = path.indexOf(marker);
  if (index < 0) return undefined;
  return path.slice(0, index + marker.length - 1);
}

function resolveLinkedPath(
  dependency: string,
  loaderPath: string,
  executablePath: string,
): string | undefined {
  const suffix = dependency.replace(/^@(loader_path|executable_path|rpath)\//u, "");
  const toolchainRoot = sealedToolchainRoot(executablePath) ?? sealedToolchainRoot(loaderPath);
  const sealedAbsoluteDependency = toolchainRoot && dependency.startsWith("/opt/homebrew/")
    ? [resolve(toolchainRoot, dependency.slice(1))]
    : [];
  const candidates = dependency.startsWith("/")
    ? sealedAbsoluteDependency.length > 0 ? sealedAbsoluteDependency : [dependency]
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

function isHomebrewRuntimePath(path: string): boolean {
  return path.startsWith("/opt/homebrew/") || path.includes(`${sep}toolchain${sep}opt${sep}homebrew${sep}`);
}

/** Discover only the concrete dynamic-library files needed by the sealed tools. */
async function darwinLinkedRuntimeFiles(executables: readonly string[]): Promise<string[]> {
  const allowed = new Set<string>();
  const visited = new Set<string>();
  for (const rootExecutable of executables) {
    const queue = [rootExecutable];
    while (queue.length > 0) {
      const loader = queue.shift()!;
      if (visited.has(loader)) continue;
      visited.add(loader);
      let output: string;
      try {
        const result = await execFile("/usr/bin/otool", ["-L", loader], {
          encoding: "utf8",
          maxBuffer: 1024 * 1024,
          timeout: OTOOL_TIMEOUT_MS,
          killSignal: "SIGKILL",
        });
        output = result.stdout;
      } catch {
        continue;
      }
      for (const line of output.split("\n").slice(1)) {
        const dependency = line.trim().split(/\s+/u)[0];
        if (!dependency) continue;
        const requestedPath = resolveLinkedPath(dependency, loader, rootExecutable);
        if (!requestedPath) continue;
        allowed.add(requestedPath);
        let canonicalPath: string;
        try {
          canonicalPath = realpathSync(requestedPath);
        } catch {
          continue;
        }
        allowed.add(canonicalPath);
        if (isHomebrewRuntimePath(canonicalPath) && !visited.has(canonicalPath)) {
          queue.push(canonicalPath);
        }
      }
    }
  }
  return uniqueSorted([...allowed]);
}

function sealedPath(canonical: ReturnType<typeof canonicalPolicyInput>): string {
  return dirname(canonical.nodeExecutable);
}

function assertSealedNodeResolution(
  canonical: ReturnType<typeof canonicalPolicyInput>,
): void {
  const resolvedNode = canonicalExistingPath(
    resolve(sealedPath(canonical), "node"),
    "semantic-proof PATH Node executable",
  );
  if (resolvedNode !== canonical.nodeExecutable) {
    throw new Error("semantic-proof PATH does not resolve bare node to the sealed Node executable");
  }
}

function validateProofEnvironment(
  environment: CccSemanticProofControllerEnvironment | undefined,
): CccSemanticProofControllerEnvironment | undefined {
  if (environment === undefined) return undefined;
  const keys = Object.keys(environment).sort();
  const expected = [
    "CCC_PROOF_ID",
    "CCC_PROOF_PHASE",
    "CCC_PROOF_SOURCE_COMMIT",
    "CCC_PROOF_SOURCE_TREE",
  ];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error("semantic-proof controller environment contains unsupported variables");
  }
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(environment.CCC_PROOF_ID)
    || !["task", "final_integrated"].includes(environment.CCC_PROOF_PHASE)
    || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(environment.CCC_PROOF_SOURCE_COMMIT)
    || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(environment.CCC_PROOF_SOURCE_TREE)
  ) {
    throw new Error("semantic-proof controller environment identity is malformed");
  }
  return environment;
}

function canonicalPolicyInput(input: CccSemanticProofSandboxPolicyInput): {
  proofRoot: string;
  scratchRoot: string;
  taskExecutable: string;
  nodeExecutable: string;
  deniedReadRoots: string[];
} {
  const canonical = {
    proofRoot: canonicalExistingPath(input.proofRoot, "semantic-proof root"),
    scratchRoot: canonicalExistingPath(input.scratchRoot, "semantic-proof scratch root"),
    taskExecutable: canonicalExistingPath(input.taskExecutable, "semantic-proof Task executable"),
    nodeExecutable: canonicalExistingPath(input.nodeExecutable, "semantic-proof Node executable"),
    deniedReadRoots: uniqueSorted(input.deniedReadRoots.map((path) => (
      canonicalExistingPath(path, "semantic-proof denied repository root")
    ))),
  };
  if (
    isSameOrWithin(canonical.proofRoot, canonical.scratchRoot)
    || isSameOrWithin(canonical.scratchRoot, canonical.proofRoot)
  ) {
    throw new Error("semantic-proof root and scratch root must be disjoint");
  }
  for (const deniedRoot of canonical.deniedReadRoots) {
    if (
      isSameOrWithin(canonical.proofRoot, deniedRoot)
      || isSameOrWithin(canonical.scratchRoot, deniedRoot)
      || isSameOrWithin(canonical.taskExecutable, deniedRoot)
      || isSameOrWithin(canonical.nodeExecutable, deniedRoot)
    ) {
      throw new Error("semantic-proof denied roots must be disjoint from materialized and toolchain paths");
    }
  }
  return canonical;
}

/**
 * Builds the fail-closed macOS policy used only for semantic proof v2.
 * Unlike the generic developer verifier, this policy has no repository read
 * grant and no writable worktree. The controller supplies a stripped proof
 * root and a separate scratch root.
 */
export async function buildCccSemanticProofDarwinProfile(
  input: CccSemanticProofSandboxPolicyInput,
): Promise<string> {
  const canonical = canonicalPolicyInput(input);
  const linkedRuntimeFiles = await darwinLinkedRuntimeFiles([
    canonical.taskExecutable,
    canonical.nodeExecutable,
    DARWIN_SHELL_EXECUTABLE,
    DARWIN_SELECTED_SHELL_EXECUTABLE,
  ]);
  const linkedRuntimeRoots = linkedRuntimeFiles.flatMap((path) => {
    return [dirname(path)];
  });
  const runtimeReadRoots = uniqueSorted([
    "/System/Library",
    "/usr/lib",
    "/usr/share/zoneinfo",
    "/private/var/db/dyld",
    "/private/var/db/timezone",
    canonical.proofRoot,
    canonical.scratchRoot,
    ...linkedRuntimeRoots,
  ].filter(existsSync));
  const runtimeReadFiles = uniqueSorted([
    DARWIN_SHELL_EXECUTABLE,
    DARWIN_SELECTED_SHELL_EXECUTABLE,
    DARWIN_SHELL_SELECTION_PATH,
    "/dev/null",
    "/dev/random",
    "/dev/urandom",
    "/etc/localtime",
    canonical.taskExecutable,
    canonical.nodeExecutable,
    ...linkedRuntimeFiles,
  ].filter(existsSync));
  const runtimeMetadataPaths = uniqueSorted([
    ...runtimeReadRoots.flatMap(pathAncestors),
    ...runtimeReadFiles.flatMap(pathAncestors),
  ]);

  const lines = [
    "(version 1)",
    '(import "/System/Library/Sandbox/Profiles/dyld-support.sb")',
    "(deny default)",
    "(allow process-fork)",
    `(allow process-exec ${[
      canonical.taskExecutable,
      canonical.nodeExecutable,
      realpathSync(DARWIN_SHELL_EXECUTABLE),
      realpathSync(DARWIN_SELECTED_SHELL_EXECUTABLE),
    ].map(sbplLiteral).join(" ")})`,
    "(allow signal (target self))",
    "(allow sysctl-read)",
    "(allow mach*)",
    "(allow ipc-posix-shm*)",
    "(allow system-socket)",
    "(deny network*)",
  ];
  for (const deniedRoot of canonical.deniedReadRoots) {
    lines.push(`(deny file-read* ${sbplSubpath(deniedRoot)})`);
  }
  lines.push(`(allow file-read-metadata ${runtimeMetadataPaths.map(sbplLiteral).join(" ")})`);
  for (const root of runtimeReadRoots) {
    lines.push(`(allow file-read* ${sbplSubpath(root)})`);
  }
  for (const file of runtimeReadFiles) {
    lines.push(`(allow file-read* ${sbplLiteral(file)})`);
  }
  lines.push(`(allow file-write* ${sbplSubpath(canonical.scratchRoot)})`);
  lines.push(`(allow file-write* ${sbplLiteral("/dev/null")})`);
  return `${lines.join("\n")}\n`;
}

export async function assertCccSemanticProofSandboxReady(
  input: CccSemanticProofSandboxPolicyInput,
): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error(`semantic-proof sandbox backend is unavailable on ${process.platform}`);
  }
  if (!existsSync(DARWIN_SANDBOX_EXECUTABLE)) {
    throw new Error("semantic-proof sandbox-exec backend is unavailable");
  }
  const canonical = canonicalPolicyInput(input);
  assertSealedNodeResolution(canonical);
  await buildCccSemanticProofDarwinProfile(input);
}

function boundedOutputAppend(
  chunks: Buffer[],
  chunk: Buffer,
  currentBytes: number,
  maximumBytes: number,
): number {
  const remaining = Math.max(0, maximumBytes - currentBytes);
  if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
  return currentBytes + chunk.byteLength;
}

export async function runCccSemanticProofSandboxedProcess(
  input: RunCccSemanticProofSandboxedProcessInput,
): Promise<CccSemanticProofSandboxedProcessResult> {
  await assertCccSemanticProofSandboxReady(input);
  const canonical = canonicalPolicyInput(input);
  assertSealedNodeResolution(canonical);
  const proofEnvironment = validateProofEnvironment(input.proofEnvironment);
  const executable = canonicalExistingPath(input.executable, "semantic-proof process executable");
  if (executable !== canonical.taskExecutable && executable !== canonical.nodeExecutable) {
    throw new Error("semantic-proof process executable is outside the sealed Task/Node toolchain");
  }
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("semantic-proof timeout must be a positive safe integer");
  }
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    throw new Error("semantic-proof output limit must be a positive safe integer");
  }

  const sandboxHome = resolve(canonical.scratchRoot, "home");
  const sandboxTmp = resolve(canonical.scratchRoot, "tmp");
  await Promise.all([
    mkdir(sandboxHome, { recursive: true }),
    mkdir(sandboxTmp, { recursive: true }),
  ]);
  const profile = await buildCccSemanticProofDarwinProfile(input);
  const env: NodeJS.ProcessEnv = {
    CI: "1",
    HOME: sandboxHome,
    TMPDIR: sandboxTmp,
    PATH: sealedPath(canonical),
    LANG: "C",
    LC_ALL: "C",
    OPENSSL_CONF: resolve(canonical.proofRoot, SEALED_OPENSSL_CONF),
    GIT_TERMINAL_PROMPT: "0",
    ...proofEnvironment,
  };
  // This repeats the preflight at the last possible point before dispatch so a
  // replaced PATH entry cannot silently select a different Node executable.
  assertSealedNodeResolution(canonical);
  const supervised = superviseSpawn(
    DARWIN_SANDBOX_EXECUTABLE,
    ["-p", profile, executable, ...input.args],
    {
      cwd: canonical.proofRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      maxLifetimeMs: timeoutMs + TERMINATION_GRACE_MS * 2,
      diagnosticLabel: "ccc-semantic-proof-v2",
    },
  );
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  const stdoutHash = createHash("sha256");
  const stderrHash = createHash("sha256");
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let outputOverLimit = false;
  let timedOut = false;
  let killed = false;
  let spawnError: string | undefined;
  let forceKillTimer: NodeJS.Timeout | undefined;

  const stop = (): void => {
    if (killed) return;
    killed = true;
    supervised.kill("SIGTERM");
    forceKillTimer = setTimeout(() => supervised.kill("SIGKILL"), TERMINATION_GRACE_MS);
    forceKillTimer.unref?.();
  };
  const onOutput = (kind: "stdout" | "stderr", chunkValue: string | Buffer): void => {
    const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue);
    if (kind === "stdout") {
      stdoutHash.update(chunk);
      stdoutBytes = boundedOutputAppend(
        stdoutChunks,
        chunk,
        stdoutBytes,
        Math.max(0, maxOutputBytes - Math.min(stderrBytes, maxOutputBytes)),
      );
    } else {
      stderrHash.update(chunk);
      stderrBytes = boundedOutputAppend(
        stderrChunks,
        chunk,
        stderrBytes,
        Math.max(0, maxOutputBytes - Math.min(stdoutBytes, maxOutputBytes)),
      );
    }
    if (stdoutBytes + stderrBytes > maxOutputBytes) {
      outputOverLimit = true;
      stop();
    }
  };
  supervised.child.stdout?.on("data", (chunk) => onOutput("stdout", chunk));
  supervised.child.stderr?.on("data", (chunk) => onOutput("stderr", chunk));
  supervised.child.once("error", (error) => {
    spawnError = error.message;
  });
  const timeout = setTimeout(() => {
    timedOut = true;
    stop();
  }, timeoutMs);
  timeout.unref?.();

  const exit = await supervised.waitExit();
  clearTimeout(timeout);
  if (forceKillTimer) clearTimeout(forceKillTimer);
  return {
    exitCode: exit.code,
    signal: exit.signal,
    stdout: Buffer.concat(stdoutChunks).toString("utf8"),
    stderr: Buffer.concat(stderrChunks).toString("utf8"),
    stdoutSha256: stdoutHash.digest("hex"),
    stderrSha256: stderrHash.digest("hex"),
    timedOut,
    killed,
    outputOverLimit,
    ...(spawnError ? { spawnError } : {}),
  };
}
