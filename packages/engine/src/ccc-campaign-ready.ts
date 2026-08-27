import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, posix } from "node:path";
import { promisify } from "node:util";
import { Type } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { CccCampaignProofEvidenceV2, CccCampaignTaskContext } from "@fusion/core";
import { runVerificationCommand } from "./run-verification-tool.js";

const MAX_READY_FEEDBACK_CHARS = 4_000;
const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;
const GIT_TIMEOUT_MS = 30_000;
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const execFile = promisify(execFileCallback);

// --- REPAIR feedback envelope -----------------------------------------------
//
// Data-driven, position-independent facts the controller hands back on a
// failed sealed-verifier run: a fixed-shape verdict, whatever canonical
// `ccc-prd.proof-evidence.v2` JSON the verifier printed (parsed defensively),
// the exact bytes the controller itself read from the isolated candidate
// snapshot *before* the verifier command ran, and a bounded raw diagnostic
// tail. Every collection/string here is capped at its own layer so the
// rendered envelope is bounded by construction, never by slicing the whole
// rendered string.
const MAX_REPAIR_DIAGNOSTIC_TAIL_CHARS = 2_000;
const MAX_REPAIR_OBSERVED_FILES = 12;
const MAX_REPAIR_FAILING_IDS_PER_CATEGORY = 5;
const MAX_REPAIR_PARSE_ISSUE_CHARS = 300;
const MAX_REPAIR_COMMAND_CHARS = 200;
const MAX_REPAIR_PATH_CHARS = 80;
const MAX_REPAIR_ID_CHARS = 40;
export const MAX_CCC_CAMPAIGN_REPAIR_FEEDBACK_RENDER_CHARS = 6_000;

export type CccCampaignRepairObservedCandidateFile =
  | Readonly<{ path: string; kind: "file"; bytes: number; sha256: string; endsWithNewline: boolean }>
  | Readonly<{ path: string; kind: "deleted" }>
  | Readonly<{ path: string; kind: "non-regular" }>;

export type CccCampaignRepairFeedback = Readonly<{
  verdict: "failed";
  verifierCommand: string;
  exitCode: number | undefined;
  proofEvidence: CccCampaignProofEvidenceV2 | undefined;
  proofEvidenceParseIssue: string | undefined;
  observedCandidate: readonly CccCampaignRepairObservedCandidateFile[];
  omittedPaths: number;
  diagnosticTail: string;
  diagnosticTruncated: boolean;
}>;

function capText(value: string, maxChars: number): { text: string; truncated: boolean } {
  if (value.length <= maxChars) {
    return { text: value, truncated: false };
  }
  const marker = "…[+truncated]";
  const keep = Math.max(0, maxChars - marker.length);
  return { text: `${value.slice(0, keep)}${marker}`, truncated: true };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactRecordKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isValidEvidenceResultArray(value: unknown, idKey: string): boolean {
  return Array.isArray(value) && value.every((entry) => (
    isPlainRecord(entry)
    && hasExactRecordKeys(entry, [idKey, "passed"])
    && typeof entry[idKey] === "string"
    && typeof entry.passed === "boolean"
  ));
}

/**
 * Defensively locates a `ccc-prd.proof-evidence.v2` JSON object inside
 * verifier stdout that may contain other, unrelated lines (the document must
 * occupy the whole stdout or one line). Mirrors the
 * exact-key/shape checks `parseSemanticProofEvidence`
 * (ccc-campaign-proof-execution.ts) uses for canonical proof custody, but
 * intentionally does not require proof/phase/commit identity to match a
 * specific sealed proof spec: this is supplementary REPAIR-turn display
 * evidence, not a custody re-derivation. Any parse or shape failure is
 * recorded as a labeled issue string rather than silently swallowed.
 */
function parseCccCampaignRepairProofEvidence(stdout: string): {
  proofEvidence: CccCampaignProofEvidenceV2 | undefined;
  proofEvidenceParseIssue: string | undefined;
} {
  let lastIssue = "no ccc-prd.proof-evidence.v2 JSON object found in verifier stdout";
  // Linear scan: canonical verifiers print the evidence as one JSON document
  // (the whole stdout or one line). Each candidate is parsed at most once, so
  // the cost is O(total stdout length) regardless of how many `{` characters a
  // noisy or adversarial verifier prints.
  const candidates: string[] = [];
  const whole = stdout.trim();
  if (whole.startsWith("{") && whole.endsWith("}")) candidates.push(whole);
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}") && trimmed !== whole) candidates.push(trimmed);
  }
  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      lastIssue = "a JSON-looking line in verifier stdout did not parse";
      continue;
    }
    if (!isPlainRecord(parsed) || parsed.schema !== "ccc-prd.proof-evidence.v2") continue;
    if (
      !hasExactRecordKeys(parsed, [
        "schema",
        "proofId",
        "phase",
        "sourceCommit",
        "sourceTree",
        "passed",
        "clauseResults",
        "positiveCaseResults",
        "negativeControlResults",
      ])
      || typeof parsed.proofId !== "string"
      || (parsed.phase !== "task" && parsed.phase !== "final_integrated")
      || typeof parsed.sourceCommit !== "string"
      || typeof parsed.sourceTree !== "string"
      || typeof parsed.passed !== "boolean"
      || !isValidEvidenceResultArray(parsed.clauseResults, "clauseId")
      || !isValidEvidenceResultArray(parsed.positiveCaseResults, "caseId")
      || !isValidEvidenceResultArray(parsed.negativeControlResults, "controlId")
    ) {
      lastIssue = "matched the proof-evidence.v2 schema field but the payload shape is malformed";
      continue;
    }
    const resultEntries = [
      ...(parsed.clauseResults as Array<{ passed: boolean }>),
      ...(parsed.positiveCaseResults as Array<{ passed: boolean }>),
      ...(parsed.negativeControlResults as Array<{ passed: boolean }>),
    ];
    if (parsed.passed !== resultEntries.every(({ passed }) => passed)) {
      lastIssue =
        "matched the proof-evidence.v2 schema field but the aggregate 'passed' value is inconsistent with its result arrays";
      continue;
    }
    return { proofEvidence: parsed as CccCampaignProofEvidenceV2, proofEvidenceParseIssue: undefined };
  }
  return {
    proofEvidence: undefined,
    proofEvidenceParseIssue: capText(lastIssue, MAX_REPAIR_PARSE_ISSUE_CHARS).text,
  };
}

/**
 * Reads observed-candidate facts from the isolated shadow clone the sealed
 * verifier actually ran against — the same bytes `candidateFingerprint`
 * covers. Must be called before any verifier command executes, so a verifier
 * that mutates files inside its own cwd cannot change what is reported here.
 * Non-regular or deleted admitted paths are represented explicitly rather
 * than forcing byte facts that do not exist.
 */
async function observeCccCampaignRepairCandidateFiles(
  shadowCwd: string,
  changedPaths: readonly string[],
  cap: number,
): Promise<{ files: CccCampaignRepairObservedCandidateFile[]; omitted: number }> {
  const capped = changedPaths.slice(0, cap);
  const omitted = Math.max(0, changedPaths.length - capped.length);
  const files: CccCampaignRepairObservedCandidateFile[] = [];
  for (const path of capped) {
    const source = join(shadowCwd, path);
    let stat: Awaited<ReturnType<typeof lstat>>;
    try {
      stat = await lstat(source);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        files.push({ path, kind: "deleted" });
        continue;
      }
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      files.push({ path, kind: "non-regular" });
      continue;
    }
    const bytes = await readFile(source);
    files.push({
      path,
      kind: "file",
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      endsWithNewline: bytes.length > 0 && bytes[bytes.length - 1] === 0x0a,
    });
  }
  return { files, omitted };
}

function renderFailingIds(
  label: string,
  results: readonly Record<string, unknown>[],
  idKey: string,
): string {
  const failingIds = results
    .filter((entry) => entry.passed === false && typeof entry[idKey] === "string")
    .map((entry) => entry[idKey] as string);
  if (failingIds.length === 0) {
    return `  ${label}: none`;
  }
  const capped = failingIds
    .slice(0, MAX_REPAIR_FAILING_IDS_PER_CATEGORY)
    .map((id) => capText(id, MAX_REPAIR_ID_CHARS).text);
  const omitted = Math.max(0, failingIds.length - capped.length);
  return `  ${label}: ${capped.join(", ")}${omitted > 0 ? ` (+${omitted} more)` : ""}`;
}

/**
 * Pure renderer: verdict-first, fixed-shape text. Every section is bounded
 * by its own construction-time cap (never by slicing the assembled string),
 * so the total length is bounded regardless of how oversized the input
 * fields are.
 */
export function renderCccCampaignRepairFeedback(feedback: CccCampaignRepairFeedback): string {
  const lines: string[] = [];
  const command = capText(feedback.verifierCommand, MAX_REPAIR_COMMAND_CHARS);
  lines.push(
    `VERDICT: ${feedback.verdict.toUpperCase()} — sealed verifier "${command.text}"`
      + `${command.truncated ? " (command truncated)" : ""} exited `
      + `${feedback.exitCode ?? "without an exit code"}. This controller verification result is `
      + "authoritative for phase completion; the candidate bytes below are what the controller observed.",
  );

  if (feedback.proofEvidence) {
    const evidence = feedback.proofEvidence;
    lines.push(`PROOF EVIDENCE (${evidence.schema}): passed=${evidence.passed}`);
    lines.push(renderFailingIds("failing clauses", evidence.clauseResults, "clauseId"));
    lines.push(renderFailingIds("failing positive cases", evidence.positiveCaseResults, "caseId"));
    lines.push(renderFailingIds("failing negative controls", evidence.negativeControlResults, "controlId"));
  } else {
    const issue = capText(feedback.proofEvidenceParseIssue ?? "not parsed", MAX_REPAIR_PARSE_ISSUE_CHARS);
    lines.push(`PROOF EVIDENCE: unavailable (${issue.text})`);
  }

  lines.push(
    "OBSERVED CANDIDATE (bytes the controller read from the verified snapshot, before the verifier ran):",
  );
  const observedCapped = feedback.observedCandidate.slice(0, MAX_REPAIR_OBSERVED_FILES);
  const observedOmittedFromRender = Math.max(
    0,
    feedback.observedCandidate.length - observedCapped.length,
  );
  if (observedCapped.length === 0) {
    lines.push("  (no admitted files observed)");
  }
  for (const entry of observedCapped) {
    const path = capText(entry.path, MAX_REPAIR_PATH_CHARS);
    const pathText = path.text;
    if (entry.kind === "file") {
      lines.push(
        `  ${pathText}: ${entry.bytes} bytes, sha256=${entry.sha256}, endsWithNewline=${entry.endsWithNewline}`,
      );
    } else {
      lines.push(`  ${pathText}: ${entry.kind}`);
    }
  }
  const totalOmittedPaths = feedback.omittedPaths + observedOmittedFromRender;
  if (totalOmittedPaths > 0) {
    lines.push(`  (${totalOmittedPaths} additional admitted path(s) omitted)`);
  }

  lines.push(`DIAGNOSTIC TAIL${feedback.diagnosticTruncated ? " (truncated)" : ""}:`);
  const tail = capText(feedback.diagnosticTail, MAX_REPAIR_DIAGNOSTIC_TAIL_CHARS);
  lines.push(tail.text.length > 0 ? tail.text : "(empty)");

  return lines.join("\n");
}

export function resolveCccCampaignReadyTimeoutMs(value: unknown): number {
  return typeof value === "number" && value > 0
    ? Math.min(value, 1_800_000)
    : 900_000;
}

export type CccCampaignReadyVerification =
  | Readonly<{
    ready: false;
    summary: string;
    repairFeedback?: CccCampaignRepairFeedback;
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
    // Observed-candidate facts must reflect exactly what the verifier is
    // about to run against — captured here, before any verifier command
    // executes, so a verifier that mutates files inside its own cwd cannot
    // change what REPAIR feedback reports.
    const observedCandidateSnapshot = await observeCccCampaignRepairCandidateFiles(
      shadow.cwd,
      changedPaths,
      MAX_REPAIR_OBSERVED_FILES,
    );
    for (const command of commands) {
      const result = await runVerificationCommand({
        command,
        cwd: shadow.cwd,
        timeoutMs: input.timeoutMs,
        signal: input.signal,
        onHeartbeat: input.onHeartbeat ?? (() => undefined),
      });
      if (!result.success) {
        const diagnosticRaw = [result.stderr, result.stdout]
          .filter((value) => value.trim().length > 0)
          .join("\n");
        const diagnostic = diagnosticRaw.slice(-2_000);
        const { proofEvidence, proofEvidenceParseIssue } =
          parseCccCampaignRepairProofEvidence(result.stdout);
        const repairFeedback: CccCampaignRepairFeedback = {
          verdict: "failed",
          verifierCommand: command,
          exitCode: result.exitCode ?? undefined,
          proofEvidence,
          proofEvidenceParseIssue,
          observedCandidate: observedCandidateSnapshot.files,
          omittedPaths: observedCandidateSnapshot.omitted,
          diagnosticTail: diagnostic,
          diagnosticTruncated: diagnosticRaw.length > diagnostic.length,
        };
        return {
          ready: false,
          summary: `sealed verifier ${command} exited ${result.exitCode ?? "without an exit code"}${diagnostic ? `: ${diagnostic}` : ""}`,
          repairFeedback,
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
