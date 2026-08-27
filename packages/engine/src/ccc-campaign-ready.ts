import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, posix } from "node:path";
import { promisify } from "node:util";
import { Type } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { CccCampaignTaskContext } from "@fusion/core";
import { runVerificationCommand } from "./run-verification-tool.js";

const MAX_READY_FEEDBACK_CHARS = 4_000;
const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;
const GIT_TIMEOUT_MS = 30_000;
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const execFile = promisify(execFileCallback);

export function resolveCccCampaignReadyTimeoutMs(value: unknown): number {
  return typeof value === "number" && value > 0
    ? Math.min(value, 1_800_000)
    : 900_000;
}

export type CccCampaignReadyVerification =
  | Readonly<{
    ready: false;
    summary: string;
  }>
  | Readonly<{
    ready: true;
    summary: string;
    taskId: string;
    verifiedWorktreePath: string;
    verifiedStartCommit: string;
    frozenBaseCommit: string;
    allowedRoots: readonly string[];
    candidateFingerprint: string;
  }>;

export type CccCampaignReadyCommitHandoff = Readonly<{
  taskId: string;
  verifiedWorktreePath: string;
  verifiedStartCommit: string;
  frozenBaseCommit: string;
  allowedRoots: readonly string[];
  candidateFingerprint: string;
  executionFence: Readonly<{
    workItemId: string;
    leaseOwner: string;
    attempt: number;
    runId: string;
  }>;
}>;

export type CreateCccCampaignReadyToolOptions = Readonly<
  | {
    mode?: "verify";
    assertCandidateCommittable: () => Promise<void>;
    verifyCandidate: () => Promise<CccCampaignReadyVerification>;
  }
  | {
    mode: "phase-signal";
    signalPhaseCompletion: () => void;
  }
>;

export type VerifyCccCampaignReadyCandidateInput = Readonly<{
  taskId: string;
  worktreePath: string;
  campaign: CccCampaignTaskContext;
  timeoutMs: number;
  signal?: AbortSignal;
  onHeartbeat?: () => void;
}>;

function boundedFeedback(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value);
  const trimmed = text.trim() || "controller verification returned no diagnostic";
  return trimmed.slice(0, MAX_READY_FEEDBACK_CHARS);
}

function scrubGitEnvironment(): NodeJS.ProcessEnv {
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
  return env;
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFile("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: scrubGitEnvironment(),
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
    timeout: GIT_TIMEOUT_MS,
  });
  return stdout;
}

function canonicalGitPath(path: string): string {
  if (
    path.length === 0
    || path.includes("\0")
    || path.includes("\\")
    || isAbsolute(path)
    || posix.normalize(path) !== path
    || path === "."
    || path === ".."
    || path.startsWith("../")
  ) {
    throw new Error(`readiness check found a non-canonical Git path: ${path}`);
  }
  return path;
}

function pathWithinRoot(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

function nulPaths(output: string): string[] {
  return output.split("\0").filter(Boolean).map(canonicalGitPath);
}

async function listCandidatePaths(worktreePath: string): Promise<{
  changedPaths: string[];
  untrackedPaths: string[];
}> {
  const [tracked, untracked, unmerged] = await Promise.all([
    git(worktreePath, ["diff", "--name-only", "-z", "--no-renames", "HEAD", "--"]),
    git(worktreePath, ["ls-files", "--others", "--exclude-standard", "-z", "--"]),
    git(worktreePath, ["diff", "--name-only", "-z", "--diff-filter=U", "--"]),
  ]);
  const unmergedPaths = nulPaths(unmerged);
  if (unmergedPaths.length > 0) {
    throw new Error(`readiness check found unmerged paths: ${unmergedPaths.join(", ")}`);
  }
  const untrackedPaths = nulPaths(untracked);
  const changedPaths = [...new Set([...nulPaths(tracked), ...untrackedPaths])].sort();
  return { changedPaths, untrackedPaths };
}

async function fingerprintCandidate(
  worktreePath: string,
  allowedRoots: readonly string[],
  untrackedPaths: readonly string[],
): Promise<string> {
  const patch = await git(worktreePath, [
    "diff",
    "--binary",
    "--no-ext-diff",
    "HEAD",
    "--",
    ...allowedRoots,
  ]);
  const hash = createHash("sha256");
  const updateFramed = (label: string, value: string | Buffer): void => {
    const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
    const length = Buffer.allocUnsafe(8);
    length.writeBigUInt64BE(BigInt(bytes.length));
    hash.update(label, "utf8");
    hash.update("\0");
    hash.update(length);
    hash.update(bytes);
  };
  updateFramed("tracked-patch", patch);
  updateFramed("untracked-count", String(untrackedPaths.length));
  for (const path of [...untrackedPaths].sort()) {
    const source = join(worktreePath, path);
    const stat = await lstat(source);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`readiness check refuses non-regular untracked path: ${path}`);
    }
    updateFramed("untracked-path", path);
    updateFramed("untracked-executable-mode", String(stat.mode & 0o111));
    updateFramed("untracked-bytes", await readFile(source));
  }
  return hash.digest("hex");
}

export async function fingerprintCccCampaignReadyCandidate(input: {
  worktreePath: string;
  allowedRoots: readonly string[];
}): Promise<string> {
  const { untrackedPaths } = await listCandidatePaths(input.worktreePath);
  return fingerprintCandidate(input.worktreePath, input.allowedRoots, untrackedPaths);
}

/** Fingerprint only bytes admitted to drive a live phase transition. */
export async function fingerprintCccCampaignAllowedCandidate(input: {
  worktreePath: string;
  allowedRoots: readonly string[];
}): Promise<string> {
  const allowedRoots = input.allowedRoots.map(canonicalGitPath);
  const { untrackedPaths } = await listCandidatePaths(input.worktreePath);
  const admittedUntrackedPaths = untrackedPaths.filter((path) =>
    allowedRoots.some((root) => pathWithinRoot(path, root))
  );
  return fingerprintCandidate(input.worktreePath, allowedRoots, admittedUntrackedPaths);
}

function taskProofCommands(campaign: CccCampaignTaskContext): string[] {
  const ids = new Set(campaign.proofIds);
  return campaign.proofs
    .filter((proof) => ids.has(proof.id))
    .filter((proof) => !("phases" in proof) || proof.phases.includes("task"))
    .map((proof) => proof.command);
}

async function materializeCandidateShadow(input: {
  worktreePath: string;
  allowedRoots: readonly string[];
  untrackedPaths: readonly string[];
}): Promise<{ cwd: string; cleanup: () => Promise<void> }> {
  const shadowRoot = await mkdtemp(join(tmpdir(), "fusion-campaign-ready-shadow-"));
  const candidateRoot = join(shadowRoot, "candidate");
  try {
    await execFile(
      "git",
      ["clone", "--quiet", "--shared", "--no-checkout", "--", input.worktreePath, candidateRoot],
      {
        env: scrubGitEnvironment(),
        maxBuffer: MAX_GIT_OUTPUT_BYTES,
        timeout: GIT_TIMEOUT_MS,
      },
    );
    // `switch --detach` materializes the no-checkout clone without requiring an
    // interactive prompt from command-name guards that gate every `checkout`.
    await git(candidateRoot, ["switch", "--quiet", "--detach", "HEAD"]);
    const patch = await git(input.worktreePath, [
      "diff",
      "--binary",
      "--no-ext-diff",
      "HEAD",
      "--",
      ...input.allowedRoots,
    ]);
    if (patch.length > 0) {
      const patchPath = join(shadowRoot, "candidate.patch");
      await writeFile(patchPath, patch);
      await git(candidateRoot, ["apply", "--binary", "--whitespace=nowarn", patchPath]);
    }
    for (const path of input.untrackedPaths) {
      const source = join(input.worktreePath, path);
      const destination = join(candidateRoot, path);
      const stat = await lstat(source);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error(`readiness check refuses non-regular untracked path: ${path}`);
      }
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(source, destination);
      await chmod(destination, stat.mode);
    }
    return {
      cwd: candidateRoot,
      cleanup: () => rm(shadowRoot, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(shadowRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function verifyCccCampaignReadyCandidate(
  input: VerifyCccCampaignReadyCandidateInput,
): Promise<CccCampaignReadyVerification> {
  if (
    input.campaign.taskId !== input.taskId
    || input.campaign.route.taskId !== input.campaign.semanticTaskId
  ) {
    return { ready: false, summary: "sealed campaign task identity does not match readiness custody" };
  }
  const configuredRoots = input.campaign.route.allowedWriteRoots;
  if (!Array.isArray(configuredRoots) || configuredRoots.length === 0) {
    return { ready: false, summary: "the sealed route has no allowed write roots" };
  }
  const allowedRoots = configuredRoots.map(canonicalGitPath);
  let verifiedWorktreePath: string;
  let verifiedStartCommit: string;
  try {
    verifiedWorktreePath = await realpath(input.worktreePath);
    verifiedStartCommit = (
      await git(verifiedWorktreePath, ["rev-parse", "--verify", "HEAD^{commit}"])
    ).trim();
  } catch (error) {
    return {
      ready: false,
      summary: `readiness could not resolve the candidate worktree and HEAD: ${boundedFeedback(error)}`,
    };
  }
  if (!GIT_OBJECT_ID.test(verifiedStartCommit)) {
    return { ready: false, summary: "readiness resolved a non-canonical candidate HEAD" };
  }
  const commands = taskProofCommands(input.campaign);
  if (commands.length === 0) {
    return { ready: false, summary: "no task-phase sealed proof command is admitted" };
  }

  const { changedPaths, untrackedPaths } = await listCandidatePaths(verifiedWorktreePath);
  if (changedPaths.length === 0) {
    return { ready: false, summary: "the candidate worktree has no implementation diff" };
  }
  const foreignPaths = changedPaths.filter(
    (path) => !allowedRoots.some((root) => pathWithinRoot(path, root)),
  );
  if (foreignPaths.length > 0) {
    return {
      ready: false,
      summary: `remove generated or foreign paths before readiness: ${foreignPaths.join(", ")}`,
    };
  }
  const candidateFingerprint = await fingerprintCandidate(
    verifiedWorktreePath,
    allowedRoots,
    untrackedPaths,
  );

  const shadow = await materializeCandidateShadow({
    worktreePath: verifiedWorktreePath,
    allowedRoots,
    untrackedPaths,
  });
  try {
    const shadowFingerprint = await fingerprintCccCampaignReadyCandidate({
      worktreePath: shadow.cwd,
      allowedRoots,
    });
    if (shadowFingerprint !== candidateFingerprint) {
      return {
        ready: false,
        summary: "candidate changed while the isolated readiness snapshot was materialized",
      };
    }
    for (const command of commands) {
      const result = await runVerificationCommand({
        command,
        cwd: shadow.cwd,
        timeoutMs: input.timeoutMs,
        signal: input.signal,
        onHeartbeat: input.onHeartbeat ?? (() => undefined),
      });
      if (!result.success) {
        const diagnostic = [result.stderr, result.stdout]
          .filter((value) => value.trim().length > 0)
          .join("\n")
          .slice(-2_000);
        return {
          ready: false,
          summary: `sealed verifier ${command} exited ${result.exitCode ?? "without an exit code"}${diagnostic ? `: ${diagnostic}` : ""}`,
        };
      }
    }
    const currentFingerprint = await fingerprintCccCampaignReadyCandidate({
      worktreePath: verifiedWorktreePath,
      allowedRoots,
    });
    if (currentFingerprint !== candidateFingerprint) {
      return {
        ready: false,
        summary: "candidate changed while the sealed readiness verifier was running",
      };
    }
    return {
      ready: true,
      summary: `sealed verifier passed in isolated candidate: ${commands.join(", ")}`,
      taskId: input.taskId,
      verifiedWorktreePath,
      verifiedStartCommit,
      frozenBaseCommit: input.campaign.targetRepository.baseCommit,
      allowedRoots,
      candidateFingerprint,
    };
  } finally {
    await shadow.cleanup();
  }
}

export function createCccCampaignReadyTool(
  options: CreateCccCampaignReadyToolOptions,
): ToolDefinition {
  if (options.mode === "phase-signal") {
    return {
      name: "fn_complete_phase",
      label: "Complete Campaign Phase",
      description:
        "Signal that the current campaign phase is complete. The controller will "
        + "decide the next phase after this model turn has fully settled.",
      executionMode: "sequential",
      parameters: Type.Object({}),
      execute: async () => {
        options.signalPhaseCompletion();
        return {
          content: [{
            type: "text" as const,
            text: "Campaign phase completion requested; controller decision pending.",
          }],
          details: { phaseCompletionRequested: true },
          isError: false,
          terminate: true,
        };
      },
    };
  }
  return {
    name: "fn_campaign_ready",
    label: "Submit Campaign Candidate",
    description:
      "Signal that the sealed campaign implementation is ready for independent controller verification. " +
      "Call this tool by itself only after the admitted implementation and targeted verification are complete.",
    executionMode: "sequential",
    parameters: Type.Object({}),
    execute: async () => {
      try {
        await options.assertCandidateCommittable();
        const verification = await options.verifyCandidate();
        const summary = boundedFeedback(verification.summary);
        if (!verification.ready) {
          return {
            content: [{
              type: "text" as const,
              text: `Controller verification refused readiness: ${summary}`,
            }],
            details: { ready: false, reason: "controller-verification-failed" },
            isError: true,
            terminate: false,
          };
        }
        return {
          content: [{
            type: "text" as const,
            text: `Controller verification passed: ${summary}`,
          }],
          details: { ready: true },
          isError: false,
          terminate: true,
        };
      } catch (error) {
        return {
          content: [{
            type: "text" as const,
            text: `Controller verification could not prove readiness: ${boundedFeedback(error)}`,
          }],
          details: { ready: false, reason: "controller-verification-error" },
          isError: true,
          terminate: false,
        };
      }
    },
  };
}
