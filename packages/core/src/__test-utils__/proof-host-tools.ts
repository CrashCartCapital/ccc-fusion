/**
 * Shared host-capability gates for the semantic-proof suites.
 *
 * Three problems this file exists to solve:
 *
 *  1. `/opt/homebrew/bin/task` was hardcoded in 32 places across the engine and
 *     CLI test suites. That path only exists on a Homebrew-managed macOS host,
 *     so every Linux runner failed those tests with a bare ENOENT on a path it
 *     was never going to have. `resolveTaskBinary()` is the one place that
 *     decides where the Task runner lives: `FUSION_TASK_BIN` first (so CI can
 *     pin a downloaded toolchain), then a PATH lookup, then the Homebrew path
 *     as a last Darwin-only candidate.
 *
 *  2. A test that needs a capability the host does not have must say so. The
 *     gates below skip with an explicit "NOT RUN: ..." reason and print that
 *     reason once per test file, so a lane that cannot run a suite is visibly
 *     not running it rather than quietly reporting green.
 *
 *  3. The proof suites need *confinement*, not just a platform. Darwin confines
 *     with `sandbox-exec`; Linux confines with bubblewrap installed at a trusted
 *     system path (mirroring `TRUSTED_VERIFIER_BWRAP_PATHS` in the engine's
 *     `run-verification-tool.ts`). The semantic-proof sandbox specifically has
 *     no Linux backend at all, so it gets its own stricter Darwin-only gate.
 *
 * Confinement and the Task runner are two separate capabilities and the gates
 * keep them separate. A suite whose sealed proof command is plain `node` needs
 * `itConfinedVerifierHost` (backend only); a suite that materialises or executes
 * a Taskfile target needs `itRequiresTask` as well, which is why
 * `itSemanticProofHost` — whose suites all embed `TASK_BIN` — demands both.
 * Folding Task into the confinement gate would skip suites for a capability
 * they never use.
 *
 * Skip reasons state the missing capability and how to supply it, and nothing
 * else. They deliberately make no claim about which CI lane covers the suite:
 * this module cannot see the caller's Vitest project, so any such claim is
 * unverifiable from here and drifts silently when lanes change. Where a suite
 * is covered is recorded at the gate site, next to the tests it applies to.
 *
 * Every inspection takes an injectable probe (platform, `exists`, PATH lookup,
 * env) so the unit test can state a verdict for a host it is not running on.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { basename } from "node:path";
import { describe as vitestDescribe, it as vitestIt } from "vitest";

/** Operator/CI override naming the exact Task runner to use. */
export const FUSION_TASK_BIN_ENV = "FUSION_TASK_BIN";

/** Last-resort Darwin candidate: the Homebrew `go-task` install location. */
export const DARWIN_FALLBACK_TASK_BIN = "/opt/homebrew/bin/task";

/** Darwin confinement backend used by the semantic-proof sandbox. */
export const DARWIN_SANDBOX_EXEC_PATH = "/usr/bin/sandbox-exec";

/**
 * Linux confinement backend. Kept in lockstep with
 * `TRUSTED_VERIFIER_BWRAP_PATHS` in `packages/engine/src/run-verification-tool.ts`:
 * a bubblewrap binary found anywhere else is deliberately not trusted.
 */
export const TRUSTED_LINUX_SANDBOX_PATHS = ["/usr/bin/bwrap", "/bin/bwrap"] as const;

const CONFINED_VERIFIER_NOT_RUN_REASON =
  `NOT RUN: requires a verifier confinement backend (darwin ${DARWIN_SANDBOX_EXEC_PATH}, or linux `
  + `bubblewrap at ${TRUSTED_LINUX_SANDBOX_PATHS.join(" or ")}); install bubblewrap to enable it `
  + "on Linux";

const SEMANTIC_PROOF_HOST_NOT_RUN_REASON =
  `NOT RUN: requires the Darwin semantic-proof sandbox (${DARWIN_SANDBOX_EXEC_PATH}), which has no `
  + "Linux backend; only a Darwin host can run it";

const TASK_NOT_RUN_REASON =
  `NOT RUN: requires the Task runner (set ${FUSION_TASK_BIN_ENV} or put \`task\` on PATH)`;

const PYTHON3_NOT_RUN_REASON =
  "NOT RUN: requires an executable python3 on PATH; install python3 in the test environment";

const VERSIONED_PYTHON3_NOT_RUN_REASON =
  "NOT RUN: requires a python3 on PATH whose canonical (realpath) form is a versioned "
  + "pythonX.Y binary; a shim or wrapper (for example a pyenv shim) that does not resolve to a "
  + "versioned interpreter cannot build these fixtures";

export interface HostProbe {
  /** Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Defaults to `node:fs` `existsSync`. */
  exists?: (path: string) => boolean;
  /** Defaults to a real `which`/`where` lookup. Returns an absolute path or null. */
  which?: (name: string) => string | null;
  /** Defaults to `node:fs` `realpathSync`. */
  realpath?: (path: string) => string;
}

export type ProofHostBackend = "sandbox-exec" | "bubblewrap";

export interface HostCapability {
  available: boolean;
  /** Absolute path to the resolved executable, when one was found. */
  path: string | null;
  /** Human-readable verdict. Starts with "NOT RUN:" when unavailable. */
  reason: string;
}

export interface ProofHostInspection extends HostCapability {
  backend: ProofHostBackend | null;
}

function probeEnv(probe: HostProbe): NodeJS.ProcessEnv {
  return probe.env ?? process.env;
}

function probePlatform(probe: HostProbe): NodeJS.Platform {
  return probe.platform ?? process.platform;
}

function probeExists(probe: HostProbe): (path: string) => boolean {
  return probe.exists ?? existsSync;
}

function probeRealpath(probe: HostProbe): (path: string) => string {
  return probe.realpath ?? realpathSync;
}

/**
 * PATH lookup through the platform's own resolver. `execFileSync` (not a shell)
 * keeps the executable name from being re-interpreted, and a non-zero exit or a
 * spawn failure simply means "not on PATH".
 */
export function lookupExecutableOnPath(
  name: string,
  probe: HostProbe = {},
): string | null {
  if (probe.which) return probe.which(name);
  const platform = probePlatform(probe);
  const finder = platform === "win32" ? "where" : "which";
  try {
    const stdout = execFileSync(finder, [name], {
      encoding: "utf8",
      env: probeEnv(probe),
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    });
    const first = stdout.split(/\r?\n/u).map((line) => line.trim()).find((line) => line.length > 0);
    return first ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve the Task runner: explicit override, then PATH, then the Darwin
 * Homebrew path. An override that does not exist resolves to `null` rather than
 * silently falling through, so a mis-set `FUSION_TASK_BIN` fails loudly instead
 * of quietly running a different binary than the operator named.
 */
export function resolveTaskBinary(probe: HostProbe = {}): string | null {
  const exists = probeExists(probe);
  const configured = probeEnv(probe)[FUSION_TASK_BIN_ENV]?.trim();
  if (configured) return exists(configured) ? configured : null;

  const onPath = lookupExecutableOnPath("task", probe);
  if (onPath && exists(onPath)) return onPath;

  if (probePlatform(probe) === "darwin" && exists(DARWIN_FALLBACK_TASK_BIN)) {
    return DARWIN_FALLBACK_TASK_BIN;
  }
  return null;
}

export function inspectTaskRunner(probe: HostProbe = {}): HostCapability {
  const configured = probeEnv(probe)[FUSION_TASK_BIN_ENV]?.trim();
  const resolved = resolveTaskBinary(probe);
  if (resolved) {
    return { available: true, path: resolved, reason: `Task runner: ${resolved}` };
  }
  const detail = configured
    ? `${FUSION_TASK_BIN_ENV}=${configured} does not exist`
    : `no \`task\` on PATH and no ${DARWIN_FALLBACK_TASK_BIN}`;
  return { available: false, path: null, reason: `${TASK_NOT_RUN_REASON} [${detail}]` };
}

export function resolvePython3Binary(probe: HostProbe = {}): string | null {
  const onPath = lookupExecutableOnPath("python3", probe);
  return onPath && probeExists(probe)(onPath) ? onPath : null;
}

export function inspectPython3(probe: HostProbe = {}): HostCapability {
  const resolved = resolvePython3Binary(probe);
  if (!resolved) {
    return {
      available: false,
      path: null,
      reason: `${PYTHON3_NOT_RUN_REASON} [no \`python3\` on PATH]`,
    };
  }
  /*
  Presence on PATH is not proof of an interpreter: `which` also finds a broken
  shim. Mirror `hasPsql`'s `--version` probe so a host with a dead python3 skips
  cleanly instead of failing inside a fixture.
  */
  if (!probe.which && !probe.exists) {
    const version = spawnSync(resolved, ["--version"], { stdio: "ignore", timeout: 10_000 });
    if (version.status !== 0) {
      return {
        available: false,
        path: null,
        reason: `${PYTHON3_NOT_RUN_REASON} [${resolved} --version exited ${String(version.status)}]`,
      };
    }
  }
  return { available: true, path: resolved, reason: `python3: ${resolved}` };
}

export interface VersionedPython3 {
  /** The PATH-resolved python3 launcher, before following symlinks. */
  launcherPath: string;
  /** `realpathSync(launcherPath)`: the canonical, symlink-resolved interpreter. */
  canonicalPath: string;
  /** The `X.Y` version parsed from the canonical basename (`pythonX.Y`). */
  version: string;
}

/**
 * A subset of hosts with an executable python3: one whose canonical
 * (realpath-resolved) form is a versioned `pythonX.Y` binary. Fixtures that
 * build a fake `.venv` around a real interpreter (matching it by version, e.g.
 * `lib/python3.12/site-packages`) need this, not just any executable on PATH.
 * A version manager shim (pyenv, asdf, ...) is real and executable but does
 * not resolve to a versioned binary, so `resolvePython3Binary` alone is not
 * enough for those fixtures.
 */
export function resolveVersionedPython3Binary(probe: HostProbe = {}): VersionedPython3 | null {
  const launcherPath = resolvePython3Binary(probe);
  if (!launcherPath) return null;
  const realpath = probeRealpath(probe);
  let canonicalPath: string;
  try {
    canonicalPath = realpath(launcherPath);
  } catch {
    return null;
  }
  const version = basename(canonicalPath).match(/^python(\d+\.\d+)$/u)?.[1];
  if (!version) return null;
  return { launcherPath, canonicalPath, version };
}

export function inspectVersionedPython3(probe: HostProbe = {}): HostCapability {
  const resolved = resolveVersionedPython3Binary(probe);
  if (resolved) {
    return {
      available: true,
      path: resolved.launcherPath,
      reason: `versioned python3: ${resolved.launcherPath} -> ${resolved.canonicalPath} `
        + `(python${resolved.version})`,
    };
  }
  const python3 = inspectPython3(probe);
  const detail = python3.available
    ? `${python3.path} does not resolve (realpath) to a versioned pythonX.Y binary`
    : "no python3 on PATH";
  return {
    available: false,
    path: null,
    reason: `${VERSIONED_PYTHON3_NOT_RUN_REASON} [${detail}]`,
  };
}

function detectConfinementBackend(
  probe: HostProbe,
): { backend: ProofHostBackend; path: string } | null {
  const exists = probeExists(probe);
  const platform = probePlatform(probe);
  if (platform === "darwin") {
    return exists(DARWIN_SANDBOX_EXEC_PATH)
      ? { backend: "sandbox-exec", path: DARWIN_SANDBOX_EXEC_PATH }
      : null;
  }
  if (platform === "linux") {
    const bwrap = TRUSTED_LINUX_SANDBOX_PATHS.find((path) => exists(path));
    return bwrap ? { backend: "bubblewrap", path: bwrap } : null;
  }
  return null;
}

function backendDetail(probe: HostProbe): string {
  const platform = probePlatform(probe);
  if (platform === "darwin") return `darwin: no ${DARWIN_SANDBOX_EXEC_PATH}`;
  if (platform === "linux") {
    return `linux: no trusted bwrap at ${TRUSTED_LINUX_SANDBOX_PATHS.join(" or ")}`;
  }
  return `${platform}: no confinement backend exists for this platform`;
}

/**
 * A host that can confine a verifier: Darwin `sandbox-exec` or Linux bubblewrap
 * at a trusted system path.
 *
 * Confinement only — deliberately no Task requirement. The suites on this gate
 * reach `runVerificationCommand` (via `verifyCccCampaignReadyCandidate`), which
 * refuses on Linux without bubblewrap, but their sealed proof command is plain
 * `node`. `path` is the confinement binary, not a Task runner; a suite that also
 * needs Task stacks `itRequiresTask` or uses `itSemanticProofHost`.
 */
export function inspectConfinedVerifierHost(probe: HostProbe = {}): ProofHostInspection {
  const detected = detectConfinementBackend(probe);
  if (!detected) {
    return {
      available: false,
      backend: null,
      path: null,
      reason: `${CONFINED_VERIFIER_NOT_RUN_REASON} [${backendDetail(probe)}]`,
    };
  }
  return {
    available: true,
    backend: detected.backend,
    path: detected.path,
    reason: `verifier confinement ready (${detected.backend} at ${detected.path})`,
  };
}

/**
 * The semantic-proof sandbox is stricter than a general proof host: its only
 * backend is Darwin `sandbox-exec` (`ccc-campaign-proof-sandbox.ts`), so a Linux
 * host with bubblewrap still cannot run these suites.
 */
export function inspectSemanticProofHost(probe: HostProbe = {}): ProofHostInspection {
  const platform = probePlatform(probe);
  if (platform !== "darwin" || !probeExists(probe)(DARWIN_SANDBOX_EXEC_PATH)) {
    const detail = platform === "darwin"
      ? `darwin: no ${DARWIN_SANDBOX_EXEC_PATH}`
      : `${platform}: the semantic-proof sandbox has no backend on this platform`;
    return {
      available: false,
      backend: null,
      path: null,
      reason: `${SEMANTIC_PROOF_HOST_NOT_RUN_REASON} [${detail}]`,
    };
  }
  const task = inspectTaskRunner(probe);
  if (!task.available) {
    return { available: false, backend: null, path: null, reason: task.reason };
  }
  return {
    available: true,
    backend: "sandbox-exec",
    path: task.path,
    reason: `semantic proof host ready (sandbox-exec, task=${task.path})`,
  };
}

/* ------------------------------------------------------------------------- *
 * Live host verdicts. Evaluated once per test-file module instance.
 *
 * The Task and python3 probes shell out, so the live verdicts are computed once
 * and the semantic-proof verdict reuses the memoised Task result rather than
 * re-running `which`. The confinement verdict is pure filesystem work and needs
 * no Task probe at all.
 * ------------------------------------------------------------------------- */

const TASK_RUNNER = inspectTaskRunner();
const PYTHON3 = inspectPython3();
const VERSIONED_PYTHON3 = inspectVersionedPython3();
const CONFINED_VERIFIER_HOST = inspectConfinedVerifierHost();

function liveSemanticProofHost(): ProofHostInspection {
  if (process.platform !== "darwin" || !existsSync(DARWIN_SANDBOX_EXEC_PATH)) {
    // Refuses on the platform check, so this never re-probes the Task runner.
    return inspectSemanticProofHost({});
  }
  if (!TASK_RUNNER.available) {
    return { available: false, backend: null, path: null, reason: TASK_RUNNER.reason };
  }
  return {
    available: true,
    backend: "sandbox-exec",
    path: TASK_RUNNER.path,
    reason: `semantic proof host ready (sandbox-exec, task=${TASK_RUNNER.path})`,
  };
}

const SEMANTIC_PROOF_HOST = liveSemanticProofHost();

/**
 * Resolved Task runner path. Always a string so a suite that only embeds the
 * path into a generated sandbox profile keeps a deterministic value; when no
 * Task runner exists this is the Darwin candidate and `hasTask()` is false, so
 * any suite that actually *executes* Task is skipped by its gate first.
 */
export const TASK_BIN: string = TASK_RUNNER.path ?? DARWIN_FALLBACK_TASK_BIN;

export function hasTask(probe?: HostProbe): boolean {
  return probe ? inspectTaskRunner(probe).available : TASK_RUNNER.available;
}

export function hasPython3(probe?: HostProbe): boolean {
  return probe ? inspectPython3(probe).available : PYTHON3.available;
}

export function hasConfinedVerifierHost(probe?: HostProbe): boolean {
  return probe ? inspectConfinedVerifierHost(probe).available : CONFINED_VERIFIER_HOST.available;
}

export function hasSemanticProofHost(probe?: HostProbe): boolean {
  return probe ? inspectSemanticProofHost(probe).available : SEMANTIC_PROOF_HOST.available;
}

/**
 * One console.warn per test-file module instance, naming every capability this
 * host lacks. Vitest isolates modules per test file, so an importing suite emits
 * this once. Only unmet capabilities are listed; a fully equipped host is silent.
 */
function announceMissingCapabilities(): void {
  const missing = [TASK_RUNNER, PYTHON3, VERSIONED_PYTHON3, CONFINED_VERIFIER_HOST, SEMANTIC_PROOF_HOST]
    .filter((capability) => !capability.available)
    .map((capability) => `  - ${capability.reason}`);
  if (missing.length === 0) return;
  console.warn(
    ["[proof-host-tools] this host is missing capabilities; suites that declare them are skipped:"]
      .concat(missing)
      .join("\n"),
  );
}

announceMissingCapabilities();

/* ------------------------------------------------------------------------- *
 * Gates. `it.skip` / `describe.skip` (never a no-op) so Vitest still registers
 * the suite: a file with zero registered tests is a Vitest failure, and
 * `scripts/assert-engine-slow-nonempty.mjs` (full-suite's test-slow job) fails
 * the lane on a zero executed count.
 * ------------------------------------------------------------------------- */

/** Runs only on a host with a trusted confinement backend. No Task requirement. */
export const describeConfinedVerifierHost: typeof vitestDescribe = CONFINED_VERIFIER_HOST.available
  ? vitestDescribe
  : (vitestDescribe.skip as typeof vitestDescribe);

export const itConfinedVerifierHost: typeof vitestIt = CONFINED_VERIFIER_HOST.available
  ? vitestIt
  : (vitestIt.skip as typeof vitestIt);

/** Runs only on Darwin with sandbox-exec and a Task runner. */
export const describeSemanticProofHost: typeof vitestDescribe = SEMANTIC_PROOF_HOST.available
  ? vitestDescribe
  : (vitestDescribe.skip as typeof vitestDescribe);

export const itSemanticProofHost: typeof vitestIt = SEMANTIC_PROOF_HOST.available
  ? vitestIt
  : (vitestIt.skip as typeof vitestIt);

/** Runs only when a Task runner resolves, whatever the platform. */
export const describeRequiresTask: typeof vitestDescribe = TASK_RUNNER.available
  ? vitestDescribe
  : (vitestDescribe.skip as typeof vitestDescribe);

export const itRequiresTask: typeof vitestIt = TASK_RUNNER.available
  ? vitestIt
  : (vitestIt.skip as typeof vitestIt);

/** Runs only when an executable python3 resolves on PATH. */
export const describeRequiresPython3: typeof vitestDescribe = PYTHON3.available
  ? vitestDescribe
  : (vitestDescribe.skip as typeof vitestDescribe);

export const itRequiresPython3: typeof vitestIt = PYTHON3.available
  ? vitestIt
  : (vitestIt.skip as typeof vitestIt);

/**
 * Runs only when the PATH-resolved python3 also resolves (via realpath) to a
 * versioned `pythonX.Y` binary. Strictly narrower than `hasPython3`/
 * `itRequiresPython3`: a version-manager shim (pyenv, asdf, ...) satisfies the
 * plain python3 gate but not this one, because it does not resolve to a
 * versioned binary.
 */
export const describeRequiresVersionedPython3: typeof vitestDescribe = VERSIONED_PYTHON3.available
  ? vitestDescribe
  : (vitestDescribe.skip as typeof vitestDescribe);

export const itRequiresVersionedPython3: typeof vitestIt = VERSIONED_PYTHON3.available
  ? vitestIt
  : (vitestIt.skip as typeof vitestIt);

/** The exact reason strings, for suites that want to assert or log them. */
export const proofHostSkipReasons = {
  confinedVerifierHost: CONFINED_VERIFIER_HOST.reason,
  semanticProofHost: SEMANTIC_PROOF_HOST.reason,
  task: TASK_RUNNER.reason,
  python3: PYTHON3.reason,
  versionedPython3: VERSIONED_PYTHON3.reason,
} as const;
