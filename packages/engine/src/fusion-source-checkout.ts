import { execFile } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const FUSION_SOURCE_MARKER_PATH = ".fusion-source";
export const FUSION_SOURCE_MARKER_CONTENT = "ccc-fusion-source/v1\n";
export const FUSION_SOURCE_CHECKOUT_PROJECT_REFUSED = "FUSION_SOURCE_CHECKOUT_PROJECT_REFUSED" as const;
export const FUSION_SOURCE_CHECKOUT_IDENTITY_INCOMPLETE = "FUSION_SOURCE_CHECKOUT_IDENTITY_INCOMPLETE" as const;
export const FUSION_SOURCE_CHECKOUT_IDENTITY_CONFLICT = "FUSION_SOURCE_CHECKOUT_IDENTITY_CONFLICT" as const;
export const FUSION_SOURCE_CHECKOUT_PROBE_ERROR = "FUSION_SOURCE_CHECKOUT_PROBE_ERROR" as const;
export const FUSION_SOURCE_CHECKOUT_NORMAL = "NORMAL_PROJECT" as const;

const SOURCE_PACKAGE_NAME = "fusion-workspace";
const GIT_PROBE_TIMEOUT_MS = 5_000;
const FILE_PROBE_TIMEOUT_MS = 5_000;
const MAX_PROBE_BYTES = 64 * 1024;

export type FusionSourceProbeStage =
  | "input-path"
  | "git-toplevel"
  | "canonical-root"
  | "package-file"
  | "package-json"
  | "marker-tracking"
  | "marker-file";

export type FusionSourceProbeError = Readonly<{
  stage: FusionSourceProbeStage;
  code?: number | string;
  message: string;
}>;

export type FusionSourceIdentity = Readonly<{
  name: string | null;
  private: boolean | null;
  matches: boolean;
}>;

export type FusionSourceMarkerObservation = Readonly<{
  path: string;
  state: "missing" | "wrong" | "untracked" | "exact" | "probe-error";
  exact: boolean;
  tracked: boolean;
}>;

type SourceRootResult = Readonly<{
  rootPath: string;
}>;

type PackageProbeResult =
  | Readonly<{ ok: true; identity: FusionSourceIdentity }>
  | Readonly<{ ok: false; error: FusionSourceProbeError }>;

type MarkerProbeResult =
  | Readonly<{ ok: true; marker: FusionSourceMarkerObservation }>
  | Readonly<{ ok: false; marker: FusionSourceMarkerObservation; error: FusionSourceProbeError }>;

export type FusionSourceCheckoutResult =
  | Readonly<{
    kind: "source";
    reason: typeof FUSION_SOURCE_CHECKOUT_PROJECT_REFUSED;
    rootPath: string;
    identity: FusionSourceIdentity;
    marker: FusionSourceMarkerObservation;
  }>
  | Readonly<{
    kind: "incomplete";
    reason: typeof FUSION_SOURCE_CHECKOUT_IDENTITY_INCOMPLETE;
    rootPath: string;
    identity: FusionSourceIdentity;
    marker: FusionSourceMarkerObservation;
    error?: FusionSourceProbeError;
  }>
  | Readonly<{
    kind: "conflict";
    reason: typeof FUSION_SOURCE_CHECKOUT_IDENTITY_CONFLICT;
    rootPath: string;
    identity?: FusionSourceIdentity;
    marker: FusionSourceMarkerObservation;
    error?: FusionSourceProbeError;
  }>
  | Readonly<{
    kind: "normal";
    reason: typeof FUSION_SOURCE_CHECKOUT_NORMAL;
    rootPath: string;
    identity: FusionSourceIdentity;
    marker: FusionSourceMarkerObservation;
  }>
  | Readonly<{
    kind: "error";
    reason: typeof FUSION_SOURCE_CHECKOUT_PROBE_ERROR;
    rootPath?: string;
    identity?: FusionSourceIdentity;
    marker?: FusionSourceMarkerObservation;
    error: FusionSourceProbeError;
  }>;

async function withTimeout<T>(operation: Promise<T>, stage: FusionSourceProbeStage, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await new Promise<T>((resolveOperation, rejectOperation) => {
      timer = setTimeout(() => {
        rejectOperation(new Error(`${stage} probe timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      operation.then(resolveOperation, rejectOperation);
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function errorCode(error: unknown): number | string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "number" || typeof code === "string" ? code : undefined;
}

function probeError(stage: FusionSourceProbeStage, error: unknown): FusionSourceProbeError {
  const message = error instanceof Error ? error.message : String(error);
  const code = errorCode(error);
  return code === undefined ? { stage, message } : { stage, code, message };
}

async function runGit(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: GIT_PROBE_TIMEOUT_MS,
    maxBuffer: MAX_PROBE_BYTES,
  });
  if (typeof result === "string") return { stdout: result, stderr: "" };
  return {
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

async function resolveCanonicalGitRoot(inputPath: string): Promise<SourceRootResult | FusionSourceProbeError> {
  if (typeof inputPath !== "string" || inputPath.trim().length === 0) {
    return { stage: "input-path", message: "A non-empty checkout path is required." };
  }

  let canonicalInput: string;
  try {
    canonicalInput = await withTimeout(realpath(inputPath), "input-path", FILE_PROBE_TIMEOUT_MS);
  } catch (error) {
    return probeError("input-path", error);
  }

  let topLevelRaw: string;
  try {
    topLevelRaw = (await runGit(["rev-parse", "--show-toplevel"], canonicalInput)).stdout.trim();
  } catch (error) {
    return probeError("git-toplevel", error);
  }
  if (topLevelRaw.length === 0) {
    return { stage: "git-toplevel", message: "git rev-parse returned an empty toplevel." };
  }

  try {
    const canonicalRoot = await withTimeout(realpath(resolve(topLevelRaw)), "canonical-root", FILE_PROBE_TIMEOUT_MS);
    return { rootPath: canonicalRoot };
  } catch (error) {
    return probeError("canonical-root", error);
  }
}

function markerObservation(
  rootPath: string,
  state: FusionSourceMarkerObservation["state"],
  tracked: boolean,
  exact: boolean,
): FusionSourceMarkerObservation {
  return { path: join(rootPath, FUSION_SOURCE_MARKER_PATH), state, tracked, exact };
}

async function readBoundedFile(path: string, stage: FusionSourceProbeStage): Promise<string> {
  const stats = await withTimeout(lstat(path), stage, FILE_PROBE_TIMEOUT_MS);
  if (!stats.isFile()) {
    throw new Error(`${path} is not a regular file`);
  }
  if (stats.size > MAX_PROBE_BYTES) {
    throw new Error(`${path} exceeds the ${MAX_PROBE_BYTES}-byte probe limit`);
  }
  return await withTimeout(readFile(path, "utf8"), stage, FILE_PROBE_TIMEOUT_MS);
}

async function probePackageIdentity(rootPath: string): Promise<PackageProbeResult> {
  const packagePath = join(rootPath, "package.json");
  let packageText: string;
  try {
    packageText = await readBoundedFile(packagePath, "package-file");
  } catch (error) {
    return { ok: false, error: probeError("package-file", error) };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(packageText) as unknown;
  } catch (error) {
    return { ok: false, error: probeError("package-json", error) };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      error: { stage: "package-json", message: "Root package.json must contain a JSON object." },
    };
  }

  const packageRecord = parsed as { name?: unknown; private?: unknown };
  const name = typeof packageRecord.name === "string" ? packageRecord.name : null;
  const privateValue = typeof packageRecord.private === "boolean" ? packageRecord.private : null;
  return {
    ok: true,
    identity: {
      name,
      private: privateValue,
      matches: name === SOURCE_PACKAGE_NAME && privateValue === true,
    },
  };
}

async function markerIsTracked(rootPath: string): Promise<boolean> {
  try {
    const result = await runGit(["ls-files", "--error-unmatch", "--", FUSION_SOURCE_MARKER_PATH], rootPath);
    return result.stdout.split(/\r?\n/u).some((line) => line.trim() === FUSION_SOURCE_MARKER_PATH);
  } catch (error) {
    if (errorCode(error) === 1) return false;
    throw error;
  }
}

async function probeMarker(rootPath: string): Promise<MarkerProbeResult> {
  let tracked: boolean;
  try {
    tracked = await markerIsTracked(rootPath);
  } catch (error) {
    const marker = markerObservation(rootPath, "probe-error", false, false);
    return { ok: false, marker, error: probeError("marker-tracking", error) };
  }

  const markerPath = join(rootPath, FUSION_SOURCE_MARKER_PATH);
  let markerText: string;
  try {
    markerText = await readBoundedFile(markerPath, "marker-file");
  } catch (error) {
    const candidate = errorCode(error) === "ENOENT"
      ? markerObservation(rootPath, "missing", tracked, false)
      : markerObservation(rootPath, "probe-error", tracked, false);
    if (candidate.state === "missing") return { ok: true, marker: candidate };
    return { ok: false, marker: candidate, error: probeError("marker-file", error) };
  }

  const exact = markerText === FUSION_SOURCE_MARKER_CONTENT;
  const state = exact ? (tracked ? "exact" : "untracked") : (tracked ? "wrong" : "untracked");
  return { ok: true, marker: markerObservation(rootPath, state, tracked, exact) };
}

function classifyProbeResults(
  rootPath: string,
  packageProbe: PackageProbeResult,
  markerProbe: MarkerProbeResult,
): FusionSourceCheckoutResult {
  const markerError = markerProbe.ok ? undefined : markerProbe.error;
  const marker = markerProbe.marker;
  const exactTracked = marker.exact && marker.tracked;

  if (!packageProbe.ok) {
    if (exactTracked) {
      return {
        kind: "conflict",
        reason: FUSION_SOURCE_CHECKOUT_IDENTITY_CONFLICT,
        rootPath,
        marker,
        error: packageProbe.error,
      };
    }
    return {
      kind: "error",
      reason: FUSION_SOURCE_CHECKOUT_PROBE_ERROR,
      rootPath,
      marker,
      error: packageProbe.error,
    };
  }

  const { identity } = packageProbe;
  if (markerError) {
    if (identity.matches) {
      return {
        kind: "incomplete",
        reason: FUSION_SOURCE_CHECKOUT_IDENTITY_INCOMPLETE,
        rootPath,
        identity,
        marker,
        error: markerError,
      };
    }
    return {
      kind: "error",
      reason: FUSION_SOURCE_CHECKOUT_PROBE_ERROR,
      rootPath,
      identity,
      marker,
      error: markerError,
    };
  }

  if (identity.matches && exactTracked) {
    return { kind: "source", reason: FUSION_SOURCE_CHECKOUT_PROJECT_REFUSED, rootPath, identity, marker };
  }
  if (identity.matches) {
    return { kind: "incomplete", reason: FUSION_SOURCE_CHECKOUT_IDENTITY_INCOMPLETE, rootPath, identity, marker };
  }
  if (exactTracked) {
    return { kind: "conflict", reason: FUSION_SOURCE_CHECKOUT_IDENTITY_CONFLICT, rootPath, identity, marker };
  }
  return { kind: "normal", reason: FUSION_SOURCE_CHECKOUT_NORMAL, rootPath, identity, marker };
}

export async function detectFusionSourceCheckout(inputPath: string): Promise<FusionSourceCheckoutResult> {
  const rootResult = await resolveCanonicalGitRoot(inputPath);
  if (!("rootPath" in rootResult)) {
    return {
      kind: "error",
      reason: FUSION_SOURCE_CHECKOUT_PROBE_ERROR,
      error: rootResult,
    };
  }

  const { rootPath } = rootResult;
  const [packageProbe, markerProbe] = await Promise.all([
    probePackageIdentity(rootPath),
    probeMarker(rootPath),
  ]);
  return classifyProbeResults(rootPath, packageProbe, markerProbe);
}
