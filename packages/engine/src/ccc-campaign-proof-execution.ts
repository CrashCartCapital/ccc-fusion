import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, chmod, lstat, mkdtemp, realpath, readdir, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, posix, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  CCC_PRD_PROOF_TERMINAL_ENVELOPE_V2_SCHEMA_VERSION,
  CCC_CAMPAIGN_PROOF_DEADLINE_EXPIRED_CODE,
  CccCampaignProofAttemptLimitError,
  beginCccCampaignProofAttemptDispatch,
  canonicalCccPrdJson,
  computeCccPrdProofDefinitionSha256,
  computeCccPrdProofV2AdmissionDigests,
  wellKnownGitBinaryPaths,
  reserveCccCampaignProofAttempt,
  settleCccCampaignProofAttempt,
  type AsyncDataLayer,
  type CccCampaignProofEvidenceV2,
  type CccCampaignProofExecutionRefusalCode,
  type CccCampaignProofTerminalEnvelopeV2,
  type CccCampaignTaskContext,
  type CccPrdProofPhase,
  type CccPrdProofV2,
  type TaskDetail,
  type TaskStore,
} from "@fusion/core";
import {
  admitAndMaterializeCccSemanticProof,
  verifyCccSemanticProofToolchainBeforeSpawn,
  type CccSemanticProofMaterialization,
  type CccSemanticProofMaterializationInput,
} from "./ccc-campaign-proof-materialization.js";
import {
  assertCccSemanticProofSandboxReady,
  runCccSemanticProofSandboxedProcess,
  type CccSemanticProofSandboxPolicyInput,
  type CccSemanticProofSandboxedProcessResult,
  type RunCccSemanticProofSandboxedProcessInput,
} from "./ccc-campaign-proof-sandbox.js";
import { resolveCccCampaignExpectedStartCommit } from "./ccc-campaign-required-commit.js";
import { PermanentError } from "./engine-errors.js";
import {
  MAX_TIMEOUT_SEC,
  inspectVerifierConfinementReadiness,
  isVerifierConfinementReady,
  runVerificationCommand,
  type RunVerificationOptions,
  type VerifierConfinementReadiness,
  type VerificationResult,
} from "./run-verification-tool.js";
import type {
  WorkflowNodeExecutionContext,
  WorkflowNodeHandler,
  WorkflowNodeResult,
} from "./workflow-graph-executor.js";

const execFile = promisify(execFileCallback);
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const MAX_GIT_OUTPUT_BYTES = 8 * 1024 * 1024;
const GIT_TIMEOUT_MS = 10_000;
const MAX_SEMANTIC_PROOF_OUTPUT_BYTES = 128 * 1024;
const PROOF_OUTPUT_TAIL_CHARS = 8_000;

type ProofAttemptSnapshot = Readonly<{
  attemptKey: string;
  controllerToken: string;
  state: "reserved" | "dispatched_unknown" | "committed" | "proved_failed";
}>;

type ProofAttemptDispatchDecision =
  | Readonly<{ kind: "dispatch-permit"; attempt: ProofAttemptSnapshot }>
  | Readonly<{ kind: "dispatched-unknown" | "terminal"; attempt: ProofAttemptSnapshot }>;

export type CccCampaignProofAttemptApi = Readonly<{
  reserve(input: {
    layer: AsyncDataLayer;
    rootDir: string;
    taskId: string;
    proofId: string;
    scope?: "task" | "campaign";
    sourceCommit: string;
    sourceTree: string;
    workItemFence: {
      workItemId: string;
      runId: string;
      attempt: number;
    };
  }): Promise<ProofAttemptSnapshot>;
  begin(input: {
    layer: AsyncDataLayer;
    attemptKey: string;
    controllerToken: string;
  }): Promise<ProofAttemptDispatchDecision>;
  settle(input: {
    layer: AsyncDataLayer;
    attemptKey: string;
    controllerToken: string;
    result: {
      success: boolean;
      exitCode: number | null;
      durationMs: number;
      stdout: string;
      stderr: string;
      timedOut: boolean;
      killed: boolean;
      warnings: string[];
      changedPathsSha256?: string;
      negativeControlLabel?: string;
    };
  }): Promise<ProofAttemptSnapshot>;
}>;

export type CccCampaignSemanticProofAttemptApi = Readonly<{
  reserve(input: {
    layer: AsyncDataLayer;
    rootDir: string;
    taskId: string;
    proofId: string;
    attemptContractVersion: "v2";
    phase: CccPrdProofPhase;
    sourceCommit: string;
    sourceTree: string;
    workItemFence: {
      workItemId: string;
      runId: string;
      attempt: number;
    };
    verifierClosureSha256: string;
    candidateInputsSha256: string;
    executionToolchainSha256: string;
  }): Promise<ProofAttemptSnapshot>;
  begin(input: {
    layer: AsyncDataLayer;
    attemptKey: string;
    controllerToken: string;
  }): Promise<ProofAttemptDispatchDecision>;
  settle(input: {
    layer: AsyncDataLayer;
    attemptKey: string;
    controllerToken: string;
    terminalEnvelope: CccCampaignProofTerminalEnvelopeV2;
  }): Promise<ProofAttemptSnapshot>;
}>;

type ProofExecutionStore = Pick<
  TaskStore,
  | "getTask"
  | "getCccCampaignContextForTask"
  | "getAsyncLayer"
  | "assertCccCampaignWorkflowLeaseFence"
>;

export interface CreateCccCampaignProofSuiteHandlerInput {
  rootDir: string;
  store: ProofExecutionStore;
  proofAttempts?: CccCampaignProofAttemptApi;
  semanticProofAttempts?: CccCampaignSemanticProofAttemptApi;
  runVerification?: (options: RunVerificationOptions) => Promise<VerificationResult>;
  inspectVerifierConfinementReadiness?: () => Promise<VerifierConfinementReadiness>;
  materializeSemanticProof?: (
    input: CccSemanticProofMaterializationInput,
  ) => Promise<CccSemanticProofMaterialization>;
  verifySemanticProofToolchain?: (toolchain: CccPrdProofV2["executionToolchain"]) => Promise<void>;
  preflightSemanticProofSandbox?: (
    input: CccSemanticProofSandboxPolicyInput,
  ) => void | Promise<void>;
  runSemanticProofSandbox?: (
    input: RunCccSemanticProofSandboxedProcessInput,
  ) => Promise<CccSemanticProofSandboxedProcessResult>;
  engineRootDir?: string;
}

type GitSnapshot = Readonly<{
  targetRoot: string;
  worktreeRoot: string;
  sourceCommit: string;
  sourceTree: string;
  mutationPaths: readonly string[];
}>;

function proofRefusal(message: string, code = "CCC_CAMPAIGN_PROOF_EXECUTION_REFUSED"): never {
  throw new PermanentError(message, code);
}

async function withSemanticProofDeadlineTranslation<T>(
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (
      error instanceof CccCampaignProofAttemptLimitError
      && error.reason === "deadline"
    ) {
      proofRefusal(
        "CCC campaign proof deadline has expired",
        CCC_CAMPAIGN_PROOF_DEADLINE_EXPIRED_CODE,
      );
    }
    throw error;
  }
}

function requiredStrings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    proofRefusal(`CCC campaign proof suite ${label} must be a non-empty array`);
  }
  const strings = value.map((entry) => {
    if (typeof entry !== "string" || entry.length === 0 || entry !== entry.trim()) {
      proofRefusal(`CCC campaign proof suite ${label} contains a non-canonical value`);
    }
    return entry;
  });
  if (new Set(strings).size !== strings.length) {
    proofRefusal(`CCC campaign proof suite ${label} contains duplicates`);
  }
  return strings;
}

function sameSorted(left: readonly string[], right: readonly string[]): boolean {
  return [...left].sort().join("\0") === [...right].sort().join("\0");
}

function sha256CanonicalStrings(values: readonly string[]): string {
  return createHash("sha256")
    .update(JSON.stringify([...values].sort()), "utf8")
    .digest("hex");
}

function sameCampaign(left: CccCampaignTaskContext, right: CccCampaignTaskContext): boolean {
  return left.projectId === right.projectId
    && left.importId === right.importId
    && left.campaignId === right.campaignId
    && left.idempotencyKey === right.idempotencyKey
    && left.packetHash === right.packetHash
    && left.sidecarHash === right.sidecarHash
    && left.bundleHash === right.bundleHash
    && left.manifestHash === right.manifestHash
    && left.targetRepository.path === right.targetRepository.path
    && left.targetRepository.baseCommit === right.targetRepository.baseCommit;
}

function canonicalGitPath(value: string): string {
  if (
    value.length === 0
    || value.includes("\0")
    || value.includes("\\")
    || isAbsolute(value)
    || posix.normalize(value) !== value
    || value === ".."
    || value.startsWith("../")
  ) {
    proofRefusal(`CCC campaign proof refused non-canonical Git path ${JSON.stringify(value)}`);
  }
  return value;
}

function pathWithinRoot(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
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
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
  return env;
}

async function resolveCccCampaignProofGitBinary(): Promise<string> {
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
  proofRefusal(
    "CCC campaign proof could not resolve a controller-owned Git binary",
    "CCC_CAMPAIGN_PROOF_GIT_REFUSED",
  );
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  try {
    const gitBinary = await resolveCccCampaignProofGitBinary();
    const { stdout } = await execFile(gitBinary, ["-C", cwd, ...args], {
      encoding: "utf8",
      env: scrubGitEnvironment(),
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
    });
    return stdout;
  } catch (error) {
    proofRefusal(
      `CCC campaign proof Git check failed (${args[0] ?? "git"}): ${
        error instanceof Error ? error.message : String(error)
      }`,
      "CCC_CAMPAIGN_PROOF_GIT_REFUSED",
    );
  }
}

async function gitObject(cwd: string, revision: string, kind: "commit" | "tree"): Promise<string> {
  const suffix = kind === "commit" ? "^{commit}" : "^{tree}";
  const object = (await git(cwd, ["rev-parse", "--verify", `${revision}${suffix}`])).trim();
  if (!GIT_OBJECT_ID.test(object)) {
    proofRefusal(`CCC campaign proof ${kind} is not a canonical Git object id`);
  }
  return object;
}

async function registeredWorktreePaths(targetRoot: string): Promise<readonly string[]> {
  const output = await git(targetRoot, ["worktree", "list", "--porcelain"]);
  const paths: string[] = [];
  for (const line of output.split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    paths.push(await realpath(line.slice("worktree ".length)));
  }
  return paths;
}

async function assertAncestor(cwd: string, ancestor: string, descendant: string, label: string): Promise<void> {
  try {
    const gitBinary = await resolveCccCampaignProofGitBinary();
    await execFile(gitBinary, ["-C", cwd, "merge-base", "--is-ancestor", ancestor, descendant], {
      env: scrubGitEnvironment(),
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
    });
  } catch {
    proofRefusal(
      `CCC campaign proof final commit does not integrate ${label} ${ancestor}`,
      "CCC_CAMPAIGN_PROOF_INTEGRATION_REFUSED",
    );
  }
}

async function taskCommit(
  task: TaskDetail,
  targetRoot: string,
  finalCommit: string,
): Promise<string> {
  if (task.id === undefined) {
    proofRefusal("CCC campaign proof task identity is missing");
  }
  if (task.worktree) {
    const worktree = await realpath(task.worktree).catch(() => undefined);
    if (!worktree) {
      proofRefusal(`CCC campaign proof task ${task.id} worktree is missing`);
    }
    const status = await git(worktree, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    if (status.length > 0) {
      proofRefusal(
        `CCC campaign proof task ${task.id} worktree has uncommitted changes`,
        "CCC_CAMPAIGN_PROOF_DIRTY_WORKTREE",
      );
    }
    return gitObject(worktree, "HEAD", "commit");
  }
  const mergeCommit = task.mergeDetails?.commitSha;
  if (typeof mergeCommit === "string" && GIT_OBJECT_ID.test(mergeCommit)) {
    return gitObject(targetRoot, mergeCommit, "commit");
  }
  if (typeof task.branch === "string" && task.branch.length > 0) {
    return gitObject(targetRoot, task.branch, "commit");
  }
  if (task.id && finalCommit) {
    proofRefusal(`CCC campaign proof cannot resolve campaign-created commit for task ${task.id}`);
  }
  return finalCommit;
}

async function inspectFinalGit(
  rootDir: string,
  finalTask: TaskDetail,
  campaign: CccCampaignTaskContext,
  tasks: readonly TaskDetail[],
  contexts: readonly CccCampaignTaskContext[],
): Promise<GitSnapshot> {
  if (!finalTask.worktree) {
    proofRefusal("CCC campaign proof integration task has no isolated worktree");
  }
  const [targetRoot, campaignTargetRoot, worktreeRoot] = await Promise.all([
    realpath(rootDir),
    realpath(campaign.targetRepository.path),
    realpath(finalTask.worktree),
  ]);
  if (targetRoot !== campaignTargetRoot) {
    proofRefusal("CCC campaign proof target repository differs from admitted custody");
  }
  if (worktreeRoot === targetRoot) {
    proofRefusal("CCC campaign proof requires an isolated task worktree");
  }
  const registered = await registeredWorktreePaths(targetRoot);
  if (!registered.includes(worktreeRoot)) {
    proofRefusal("CCC campaign proof integration worktree is not registered by the target repository");
  }
  const clean = await git(worktreeRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (clean.length > 0) {
    proofRefusal(
      "CCC campaign proof integration worktree has uncommitted changes",
      "CCC_CAMPAIGN_PROOF_DIRTY_WORKTREE",
    );
  }
  const sourceCommit = await gitObject(worktreeRoot, "HEAD", "commit");
  const sourceTree = await gitObject(worktreeRoot, "HEAD", "tree");
  const expectedBase = await gitObject(targetRoot, campaign.targetRepository.baseCommit, "commit");
  if (expectedBase !== campaign.targetRepository.baseCommit) {
    proofRefusal("CCC campaign proof target base differs from imported campaign custody");
  }
  if (sourceCommit === expectedBase) {
    proofRefusal(
      "CCC campaign proof requires a commit created by the campaign",
      "CCC_CAMPAIGN_PROOF_COMMIT_REQUIRED",
    );
  }
  await assertAncestor(worktreeRoot, expectedBase, sourceCommit, "campaign base");

  for (const task of tasks) {
    const commit = await taskCommit(task, targetRoot, sourceCommit);
    if (commit === expectedBase) {
      proofRefusal(
        `CCC campaign proof task ${task.id} has no campaign-created commit`,
        "CCC_CAMPAIGN_PROOF_COMMIT_REQUIRED",
      );
    }
    await assertAncestor(worktreeRoot, commit, sourceCommit, `task ${task.id}`);
  }

  const rawPaths = await git(worktreeRoot, [
    "diff",
    "--name-only",
    "-z",
    "--diff-filter=ACDMRTUXB",
    expectedBase,
    sourceCommit,
    "--",
  ]);
  const mutationPaths = rawPaths.split("\0").filter(Boolean).map(canonicalGitPath);
  if (mutationPaths.length === 0) {
    proofRefusal(
      "CCC campaign proof commit contains no source changes",
      "CCC_CAMPAIGN_PROOF_COMMIT_REQUIRED",
    );
  }
  const routeRoots = contexts
    .flatMap(({ route }) => route.allowedWriteRoots ?? [])
    .map(canonicalGitPath);
  if (routeRoots.length === 0) {
    proofRefusal(
      "CCC campaign proof has no route-scoped source write roots",
      "CCC_CAMPAIGN_PROOF_FOREIGN_PATH",
    );
  }
  for (const path of mutationPaths) {
    if (!routeRoots.some((root) => pathWithinRoot(path, root))) {
      proofRefusal(
        `CCC campaign proof commit changes path outside task ownership ${path}`,
        "CCC_CAMPAIGN_PROOF_FOREIGN_PATH",
      );
    }
  }
  return {
    targetRoot,
    worktreeRoot,
    sourceCommit,
    sourceTree,
    mutationPaths: Object.freeze([...new Set(mutationPaths)].sort()),
  };
}

async function inspectTaskGit(
  rootDir: string,
  store: ProofExecutionStore,
  task: TaskDetail,
  campaign: CccCampaignTaskContext,
): Promise<GitSnapshot> {
  if (!task.worktree) {
    proofRefusal("CCC campaign task proof has no isolated worktree");
  }
  const [targetRoot, campaignTargetRoot, worktreeRoot] = await Promise.all([
    realpath(rootDir),
    realpath(campaign.targetRepository.path),
    realpath(task.worktree),
  ]);
  if (targetRoot !== campaignTargetRoot) {
    proofRefusal("CCC campaign task proof target repository differs from admitted custody");
  }
  if (worktreeRoot === targetRoot) {
    proofRefusal("CCC campaign task proof requires an isolated task worktree");
  }
  const registered = await registeredWorktreePaths(targetRoot);
  if (!registered.includes(worktreeRoot)) {
    proofRefusal("CCC campaign task proof worktree is not registered by the target repository");
  }
  const clean = await git(worktreeRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (clean.length > 0) {
    proofRefusal(
      "CCC campaign task proof worktree has uncommitted changes",
      "CCC_CAMPAIGN_PROOF_DIRTY_WORKTREE",
    );
  }
  const sourceCommit = await gitObject(worktreeRoot, "HEAD", "commit");
  const sourceTree = await gitObject(worktreeRoot, "HEAD", "tree");
  const expectedBase = await gitObject(targetRoot, campaign.targetRepository.baseCommit, "commit");
  if (expectedBase !== campaign.targetRepository.baseCommit) {
    proofRefusal("CCC campaign task proof target base differs from imported campaign custody");
  }
  const expectedStart = await resolveCccCampaignExpectedStartCommit({
    store,
    targetRoot,
    task,
    frozenBase: expectedBase,
    refusalLabel: "CCC campaign task proof",
    refuse: (message) => proofRefusal(
      message,
      "CCC_CAMPAIGN_PROOF_INTEGRATION_REFUSED",
    ),
  });
  if (sourceCommit === expectedStart.commit) {
    proofRefusal(
      expectedStart.reference === "frozen-base"
        ? "CCC campaign task proof requires a commit created by the campaign"
        : "CCC campaign task proof requires a commit created by the campaign task after its expected dependency start",
      "CCC_CAMPAIGN_PROOF_COMMIT_REQUIRED",
    );
  }
  await assertAncestor(worktreeRoot, expectedBase, sourceCommit, "campaign base");
  if (expectedStart.commit !== expectedBase) {
    await assertAncestor(
      worktreeRoot,
      expectedStart.commit,
      sourceCommit,
      "task dependency start",
    );
  }
  const rawPaths = await git(worktreeRoot, [
    "diff",
    "--name-only",
    "-z",
    "--diff-filter=ACDMRTUXB",
    expectedStart.commit,
    sourceCommit,
    "--",
  ]);
  const mutationPaths = rawPaths.split("\0").filter(Boolean).map(canonicalGitPath);
  if (mutationPaths.length === 0) {
    proofRefusal(
      "CCC campaign task proof commit contains no source changes",
      "CCC_CAMPAIGN_PROOF_COMMIT_REQUIRED",
    );
  }
  const routeRoots = (campaign.route.allowedWriteRoots ?? []).map(canonicalGitPath);
  if (routeRoots.length === 0) {
    proofRefusal(
      "CCC campaign task proof has no route-scoped source write roots",
      "CCC_CAMPAIGN_PROOF_FOREIGN_PATH",
    );
  }
  for (const path of mutationPaths) {
    if (!routeRoots.some((root) => pathWithinRoot(path, root))) {
      proofRefusal(
        `CCC campaign task proof commit changes path outside task ownership ${path}`,
        "CCC_CAMPAIGN_PROOF_FOREIGN_PATH",
      );
    }
  }
  return {
    targetRoot,
    worktreeRoot,
    sourceCommit,
    sourceTree,
    mutationPaths: Object.freeze([...new Set(mutationPaths)].sort()),
  };
}

async function verifierPreservedGitSnapshot(snapshot: GitSnapshot): Promise<boolean> {
  const [status, sourceCommit, sourceTree] = await Promise.all([
    git(snapshot.worktreeRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    gitObject(snapshot.worktreeRoot, "HEAD", "commit"),
    gitObject(snapshot.worktreeRoot, "HEAD", "tree"),
  ]);
  return status.length === 0
    && sourceCommit === snapshot.sourceCommit
    && sourceTree === snapshot.sourceTree;
}

function workItemFence(context: WorkflowNodeExecutionContext) {
  const fence = context.execution?.executionFence;
  if (
    !fence
    || typeof fence.workItemId !== "string"
    || fence.workItemId.length === 0
    || typeof fence.leaseOwner !== "string"
    || fence.leaseOwner.length === 0
    || typeof fence.runId !== "string"
    || fence.runId.length === 0
    || !Number.isSafeInteger(fence.attempt)
    || fence.attempt < 1
  ) {
    proofRefusal(
      "CCC campaign proof execution requires a sealed work-item fence",
      "CCC_CAMPAIGN_PROOF_FENCE_REFUSED",
    );
  }
  return {
    workItemId: fence.workItemId,
    leaseOwner: fence.leaseOwner,
    runId: fence.runId,
    attempt: fence.attempt,
  };
}

async function assertLiveWorkItemFence(
  store: ProofExecutionStore,
  originTaskId: string,
  fence: ReturnType<typeof workItemFence>,
): Promise<void> {
  try {
    await store.assertCccCampaignWorkflowLeaseFence({
      workItemId: fence.workItemId,
      originTaskId,
      leaseOwner: fence.leaseOwner,
      attempt: fence.attempt,
      runId: fence.runId,
    });
  } catch {
    proofRefusal(
      `CCC campaign proof work-item lease is no longer live for ${fence.workItemId}`,
      "CCC_CAMPAIGN_PROOF_FENCE_REFUSED",
    );
  }
}

function verificationTimeoutMs(
  campaign: CccCampaignTaskContext,
  context: WorkflowNodeExecutionContext,
): number {
  const configured = Number(
    (context.settings as { verificationCommandTimeoutMs?: unknown } | undefined)
      ?.verificationCommandTimeoutMs,
  );
  const configuredMs = Number.isFinite(configured) && configured > 0
    ? configured
    : 300_000;
  const deadlineRemaining = Date.parse(campaign.campaignDeadlineAt) - Date.now();
  if (!Number.isFinite(deadlineRemaining) || deadlineRemaining <= 0) {
    proofRefusal(
      "CCC campaign proof deadline has expired",
      CCC_CAMPAIGN_PROOF_DEADLINE_EXPIRED_CODE,
    );
  }
  return Math.max(
    1,
    Math.min(configuredMs, deadlineRemaining, MAX_TIMEOUT_SEC * 1_000),
  );
}

function defaultProofAttempts(): CccCampaignProofAttemptApi {
  return {
    reserve: (input) =>
      reserveCccCampaignProofAttempt(input) as Promise<ProofAttemptSnapshot>,
    begin: (input) =>
      beginCccCampaignProofAttemptDispatch(input) as Promise<ProofAttemptDispatchDecision>,
    settle: (input) =>
      settleCccCampaignProofAttempt(input) as Promise<ProofAttemptSnapshot>,
  };
}

function defaultSemanticProofAttempts(): CccCampaignSemanticProofAttemptApi {
  return {
    reserve: (input) => reserveCccCampaignProofAttempt(input) as Promise<ProofAttemptSnapshot>,
    begin: (input) =>
      beginCccCampaignProofAttemptDispatch(input) as Promise<ProofAttemptDispatchDecision>,
    settle: (input) => settleCccCampaignProofAttempt(input) as Promise<ProofAttemptSnapshot>,
  };
}

function terminalAttemptResult(attempt: ProofAttemptSnapshot, proofId: string): WorkflowNodeResult | undefined {
  if (attempt.state === "committed") return undefined;
  if (attempt.state === "proved_failed") {
    return { outcome: "failure", value: `ccc-proof-failed:${proofId}` };
  }
  if (attempt.state === "dispatched_unknown") {
    proofRefusal(
      `CCC campaign proof ${proofId} has an uncertain dispatched verifier effect`,
      "CCC_CAMPAIGN_PROOF_DISPATCH_UNKNOWN",
    );
  }
  return undefined;
}

type SemanticProofExecution = Readonly<{
  phase: CccPrdProofPhase;
  proofIds: readonly string[];
  nativeTaskId: string;
  campaign: CccCampaignTaskContext;
  snapshot: GitSnapshot;
  candidateOwnershipRoots: readonly string[];
  verifierDisjointRoots: readonly string[];
}>;

function requiredCanonicalString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    proofRefusal(`CCC campaign semantic proof ${label} must be a canonical string`);
  }
  return value;
}

function v2ProofCatalog(campaign: CccCampaignTaskContext): readonly CccPrdProofV2[] {
  if (
    !Array.isArray(campaign.proofs)
    || campaign.proofs.length === 0
    || campaign.proofs.some((proof) => proof.schema !== "ccc-prd.proof.v2")
  ) {
    proofRefusal("CCC campaign semantic proof node requires one semantic proof v2 catalog");
  }
  const proofs = campaign.proofs as CccPrdProofV2[];
  const ids = proofs.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) {
    proofRefusal("CCC campaign semantic proof catalog contains duplicate proof ids");
  }
  return proofs;
}

function campaignModelWriteRoots(campaign: CccCampaignTaskContext): readonly string[] {
  return Object.freeze([
    ...new Set(campaign.executionPolicy.routes.flatMap((route) => [
      ...(route.ownedPaths ?? []),
      ...(route.allowedWriteRoots ?? []),
    ]).map(canonicalGitPath)),
  ].sort());
}

async function resolveSemanticProofExecution(
  input: CreateCccCampaignProofSuiteHandlerInput,
  node: Parameters<WorkflowNodeHandler>[0],
  context: WorkflowNodeExecutionContext,
): Promise<SemanticProofExecution> {
  const config = node.config;
  if (!config) {
    proofRefusal("CCC campaign semantic proof node configuration is missing");
  }
  const phase = config.cccProofPhase;
  if (phase !== "task" && phase !== "final_integrated") {
    proofRefusal("CCC campaign semantic proof node has an unsupported phase");
  }
  const proofIds = requiredStrings(config.cccProofIds, "proof ids");
  if (phase === "task") {
    if (config.cccProofGate !== true || config.cccProofSuite === true) {
      proofRefusal("CCC campaign task proof phase requires exactly one task proof gate");
    }
    const semanticTaskId = requiredCanonicalString(
      config.cccPrdTaskId,
      "task semantic identity",
    );
    const nativeTaskId = requiredCanonicalString(
      config.cccNativeTaskId ?? semanticTaskId,
      "task native identity",
    );
    if (
      context.execution?.semanticTaskId !== semanticTaskId
      || context.execution?.nativeTaskId !== nativeTaskId
    ) {
      proofRefusal("CCC campaign task proof identity does not match sealed execution");
    }
    const [task, campaign] = await Promise.all([
      input.store.getTask(nativeTaskId),
      input.store.getCccCampaignContextForTask(nativeTaskId),
    ]);
    if (
      !campaign
      || campaign.taskId !== nativeTaskId
      || campaign.semanticTaskId !== semanticTaskId
      || campaign.route.taskId !== semanticTaskId
    ) {
      proofRefusal("CCC campaign task proof custody does not match the sealed task identity");
    }
    const catalog = v2ProofCatalog(campaign);
    const expectedProofIds = campaign.proofIds.filter((proofId) =>
      catalog.some((proof) => proof.id === proofId && proof.phases.includes("task")));
    if (!sameSorted(proofIds, expectedProofIds)) {
      proofRefusal("CCC campaign task proof gate must execute its exact admitted task proof set");
    }
    const snapshot = await inspectTaskGit(input.rootDir, input.store, task, campaign);
    return {
      phase,
      proofIds: Object.freeze([...proofIds]),
      nativeTaskId,
      campaign,
      snapshot,
      candidateOwnershipRoots: Object.freeze(
        (campaign.route.allowedWriteRoots ?? []).map(canonicalGitPath),
      ),
      verifierDisjointRoots: campaignModelWriteRoots(campaign),
    };
  }

  if (config.cccProofSuite !== true || config.cccProofGate === true) {
    proofRefusal("CCC campaign final-integrated proof phase requires exactly one proof suite");
  }
  const semanticTaskIds = requiredStrings(config.cccPrdTaskIds, "semantic task ids");
  const nativeTaskIds = config.cccNativeTaskIds === undefined
    ? semanticTaskIds
    : requiredStrings(config.cccNativeTaskIds, "native task ids");
  const finalSemanticTaskId = requiredCanonicalString(
    config.cccPrdTaskId,
    "final semantic identity",
  );
  const finalNativeTaskId = requiredCanonicalString(
    config.cccNativeTaskId ?? finalSemanticTaskId,
    "final native identity",
  );
  if (
    nativeTaskIds.length !== semanticTaskIds.length
    || semanticTaskIds.indexOf(finalSemanticTaskId) < 0
    || nativeTaskIds[semanticTaskIds.indexOf(finalSemanticTaskId)] !== finalNativeTaskId
    || context.execution?.semanticTaskId !== finalSemanticTaskId
    || context.execution?.nativeTaskId !== finalNativeTaskId
  ) {
    proofRefusal("CCC campaign final proof task identity does not match sealed execution");
  }
  const tasks = await Promise.all(nativeTaskIds.map((taskId) => input.store.getTask(taskId)));
  const loadedContexts = await Promise.all(nativeTaskIds.map((taskId) =>
    input.store.getCccCampaignContextForTask(taskId)));
  if (loadedContexts.some((campaign) => campaign == null)) {
    proofRefusal("CCC campaign final proof task custody is missing");
  }
  const campaigns = loadedContexts as CccCampaignTaskContext[];
  const mappingDrift = campaigns.some((candidate, index) => (
    candidate.taskId !== nativeTaskIds[index]
    || candidate.semanticTaskId !== semanticTaskIds[index]
    || candidate.route.taskId !== semanticTaskIds[index]
  ));
  const campaign = campaigns.find(({ taskId }) => taskId === finalNativeTaskId);
  if (
    mappingDrift
    || !campaign
    || campaigns.some((candidate) => !sameCampaign(campaign, candidate))
  ) {
    proofRefusal("CCC campaign final proof tasks do not share one exact imported campaign");
  }
  const catalog = v2ProofCatalog(campaign);
  const expectedProofIds = catalog
    .filter((proof) => proof.phases.includes("final_integrated"))
    .map(({ id }) => id);
  if (!sameSorted(proofIds, expectedProofIds)) {
    proofRefusal("CCC campaign final proof suite must execute its exact final-integrated proof set");
  }
  const finalTask = tasks.find(({ id }) => id === finalNativeTaskId);
  if (!finalTask) {
    proofRefusal("CCC campaign final proof integration task is missing");
  }
  const snapshot = await inspectFinalGit(input.rootDir, finalTask, campaign, tasks, campaigns);
  return {
    phase,
    proofIds: Object.freeze([...proofIds]),
    nativeTaskId: finalNativeTaskId,
    campaign,
    snapshot,
    candidateOwnershipRoots: Object.freeze(
      campaigns.flatMap(({ route }) => route.allowedWriteRoots ?? []).map(canonicalGitPath),
    ),
    verifierDisjointRoots: campaignModelWriteRoots(campaign),
  };
}

function semanticProofDigests(proof: CccPrdProofV2) {
  const admission = proof.admission;
  const digests = computeCccPrdProofV2AdmissionDigests(proof);
  if (
    !admission
    || admission.schema !== "ccc-prd.proof-admission.v2"
    || admission.definitionSha256 !== computeCccPrdProofDefinitionSha256(proof)
    || admission.verifierClosureSha256 !== digests.verifierClosureSha256
    || admission.candidateInputsSha256 !== digests.candidateInputsSha256
    || admission.executionToolchainSha256 !== digests.executionToolchainSha256
  ) {
    proofRefusal(
      `CCC campaign semantic proof ${proof.id} admission custody is stale`,
      "CCC_CAMPAIGN_PROOF_CUSTODY_REFUSED",
    );
  }
  return digests;
}

function assertSemanticProofCandidateOwnership(
  proof: CccPrdProofV2,
  roots: readonly string[],
): void {
  if (roots.length === 0) {
    proofRefusal(
      `CCC campaign semantic proof ${proof.id} has no model-write ownership roots`,
      "CCC_CAMPAIGN_PROOF_FOREIGN_PATH",
    );
  }
  for (const rawPath of proof.candidateInputs) {
    const path = canonicalGitPath(rawPath);
    if (!roots.some((root) => pathWithinRoot(path, root))) {
      proofRefusal(
        `CCC campaign semantic proof ${proof.id} candidate is outside task ownership ${path}`,
        "CCC_CAMPAIGN_PROOF_FOREIGN_PATH",
      );
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function exactEvidenceResults(
  value: unknown,
  idKey: "clauseId" | "caseId" | "controlId",
  expectedIds: readonly string[],
): boolean {
  if (!Array.isArray(value) || value.length !== expectedIds.length) return false;
  const expected = [...expectedIds].sort();
  return value.every((entry, index) => (
    isRecord(entry)
    && hasExactKeys(entry, [idKey, "passed"])
    && entry[idKey] === expected[index]
    && typeof entry.passed === "boolean"
  ));
}

function parseSemanticProofEvidence(
  stdout: string,
  proof: CccPrdProofV2,
  phase: CccPrdProofPhase,
  snapshot: GitSnapshot,
): CccCampaignProofEvidenceV2 {
  const payload = stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
  if (payload.length === 0 || payload.includes("\n")) {
    throw new Error("semantic proof stdout is not one JSON object");
  }
  const parsed: unknown = JSON.parse(payload);
  if (
    !isRecord(parsed)
    || !hasExactKeys(parsed, [
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
    || canonicalCccPrdJson(parsed) !== payload
    || parsed.schema !== "ccc-prd.proof-evidence.v2"
    || parsed.proofId !== proof.id
    || parsed.phase !== phase
    || parsed.sourceCommit !== snapshot.sourceCommit
    || parsed.sourceTree !== snapshot.sourceTree
    || typeof parsed.passed !== "boolean"
    || !exactEvidenceResults(parsed.clauseResults, "clauseId", proof.clauseIds)
    || !exactEvidenceResults(
      parsed.positiveCaseResults,
      "caseId",
      proof.positiveCases.map(({ id }) => id),
    )
    || !exactEvidenceResults(
      parsed.negativeControlResults,
      "controlId",
      proof.negativeControls.map(({ id }) => id),
    )
  ) {
    throw new Error("semantic proof evidence identity or result sets are malformed");
  }
  const resultEntries = [
    ...(parsed.clauseResults as Array<{ passed: boolean }>),
    ...(parsed.positiveCaseResults as Array<{ passed: boolean }>),
    ...(parsed.negativeControlResults as Array<{ passed: boolean }>),
  ];
  if (parsed.passed !== resultEntries.every(({ passed }) => passed)) {
    throw new Error("semantic proof aggregate result is inconsistent");
  }
  return parsed as CccCampaignProofEvidenceV2;
}

function terminalEnvelopeBase(
  proof: CccPrdProofV2,
  phase: CccPrdProofPhase,
  snapshot: GitSnapshot,
  result: CccSemanticProofSandboxedProcessResult,
  durationMs: number,
) {
  return {
    schema: CCC_PRD_PROOF_TERMINAL_ENVELOPE_V2_SCHEMA_VERSION,
    proofId: proof.id,
    phase,
    sourceCommit: snapshot.sourceCommit,
    sourceTree: snapshot.sourceTree,
    exitCode: result.exitCode,
    durationMs,
    stdoutSha256: result.stdoutSha256,
    stderrSha256: result.stderrSha256,
    changedPathsSha256: sha256CanonicalStrings(snapshot.mutationPaths),
    stdoutTail: result.stdout.slice(-PROOF_OUTPUT_TAIL_CHARS),
    stderrTail: result.stderr.slice(-PROOF_OUTPUT_TAIL_CHARS),
    timedOut: result.timedOut,
    killed: result.killed,
    warnings: Object.freeze([] as string[]),
  } as const;
}

function executionRefusalCode(
  result: CccSemanticProofSandboxedProcessResult,
): CccCampaignProofExecutionRefusalCode | undefined {
  if (
    result.outputOverLimit
    || Buffer.byteLength(result.stdout, "utf8") + Buffer.byteLength(result.stderr, "utf8")
      > MAX_SEMANTIC_PROOF_OUTPUT_BYTES
  ) return "output_over_limit";
  if (result.timedOut) return "timeout";
  if (result.killed) return "killed";
  if (result.spawnError) return "spawn_refused";
  if (result.stdout.length === 0) return "no_output";
  return undefined;
}

function executionRefusedEnvelope(
  proof: CccPrdProofV2,
  phase: CccPrdProofPhase,
  snapshot: GitSnapshot,
  result: CccSemanticProofSandboxedProcessResult,
  durationMs: number,
  code: CccCampaignProofExecutionRefusalCode,
): CccCampaignProofTerminalEnvelopeV2 {
  return Object.freeze({
    ...terminalEnvelopeBase(proof, phase, snapshot, result, durationMs),
    kind: "execution_refused",
    code,
  });
}

function semanticProofEnvelope(
  proof: CccPrdProofV2,
  phase: CccPrdProofPhase,
  snapshot: GitSnapshot,
  result: CccSemanticProofSandboxedProcessResult,
  durationMs: number,
): CccCampaignProofTerminalEnvelopeV2 {
  const refused = executionRefusalCode(result);
  if (refused) {
    return executionRefusedEnvelope(proof, phase, snapshot, result, durationMs, refused);
  }
  let evidence: CccCampaignProofEvidenceV2;
  try {
    evidence = parseSemanticProofEvidence(result.stdout, proof, phase, snapshot);
  } catch {
    return executionRefusedEnvelope(
      proof,
      phase,
      snapshot,
      result,
      durationMs,
      "malformed_output",
    );
  }
  if (evidence.passed && result.exitCode !== 0) {
    return executionRefusedEnvelope(
      proof,
      phase,
      snapshot,
      result,
      durationMs,
      "malformed_output",
    );
  }
  const evidenceSha256 = createHash("sha256")
    .update(canonicalCccPrdJson(evidence), "utf8")
    .digest("hex");
  return Object.freeze({
    ...terminalEnvelopeBase(proof, phase, snapshot, result, durationMs),
    kind: "verified",
    passed: evidence.passed,
    evidence,
    evidenceSha256,
  });
}

function sandboxRefusedResult(): CccSemanticProofSandboxedProcessResult {
  const emptySha256 = createHash("sha256").update("", "utf8").digest("hex");
  return {
    exitCode: null,
    signal: null,
    stdout: "",
    stderr: "",
    stdoutSha256: emptySha256,
    stderrSha256: emptySha256,
    timedOut: false,
    killed: false,
    outputOverLimit: false,
  };
}

function assertPathWithinTempRoot(path: string, tempRoot: string): void {
  const fromRoot = relative(tempRoot, path);
  if (fromRoot.startsWith(`..${sep}`) || fromRoot === ".." || isAbsolute(fromRoot)) {
    throw new Error("CCC semantic-proof cleanup path escaped its temp root");
  }
}

async function makeTempTreeWriteable(root: string, tempRoot = root): Promise<void> {
  assertPathWithinTempRoot(root, tempRoot);
  const rootStat = await lstat(root).catch(() => undefined);
  if (!rootStat) return;
  if (rootStat.isSymbolicLink()) {
    await unlink(root).catch(() => undefined);
    return;
  }
  if (!rootStat.isDirectory()) {
    await chmod(root, 0o600).catch(() => undefined);
    return;
  }
  await chmod(root, 0o700).catch(() => undefined);
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  await Promise.all(entries.map(async (entry) => {
    const child = join(root, entry.name);
    if (entry.isSymbolicLink()) await unlink(child).catch(() => undefined);
    else await makeTempTreeWriteable(child, tempRoot);
  }));
}

type SemanticProofRuntimeDependencies = Readonly<{
  proofAttempts: CccCampaignSemanticProofAttemptApi;
  materialize: (
    input: CccSemanticProofMaterializationInput,
  ) => Promise<CccSemanticProofMaterialization>;
  verifyToolchain: (toolchain: CccPrdProofV2["executionToolchain"]) => Promise<void>;
  preflightSandbox: (input: CccSemanticProofSandboxPolicyInput) => void | Promise<void>;
  runSandbox: (
    input: RunCccSemanticProofSandboxedProcessInput,
  ) => Promise<CccSemanticProofSandboxedProcessResult>;
}>;

async function runSemanticProofV2(
  input: CreateCccCampaignProofSuiteHandlerInput,
  dependencies: SemanticProofRuntimeDependencies,
  node: Parameters<WorkflowNodeHandler>[0],
  context: WorkflowNodeExecutionContext,
): Promise<WorkflowNodeResult> {
  context.signal?.throwIfAborted();
  const layer = input.store.getAsyncLayer();
  if (!layer) {
    proofRefusal("CCC campaign semantic proof execution requires PostgreSQL custody");
  }
  const fence = workItemFence(context);
  const originTaskId = context.execution?.originTaskId;
  if (typeof originTaskId !== "string" || originTaskId.length === 0) {
    proofRefusal(
      "CCC campaign semantic proof origin task identity is missing",
      "CCC_CAMPAIGN_PROOF_FENCE_REFUSED",
    );
  }
  await assertLiveWorkItemFence(input.store, originTaskId, fence);
  const execution = await resolveSemanticProofExecution(input, node, context);
  const engineRoot = await realpath(
    input.engineRootDir ?? fileURLToPath(new URL("../../..", import.meta.url)),
  );
  const catalog = v2ProofCatalog(execution.campaign);

  for (const proofId of execution.proofIds) {
    context.signal?.throwIfAborted();
    const proof = catalog.find(({ id }) => id === proofId);
    if (!proof || !proof.phases.includes(execution.phase)) {
      proofRefusal(
        `CCC campaign semantic proof ${proofId} does not admit phase ${execution.phase}`,
        "CCC_CAMPAIGN_PROOF_CUSTODY_REFUSED",
      );
    }
    assertSemanticProofCandidateOwnership(proof, execution.candidateOwnershipRoots);
    let digests: ReturnType<typeof computeCccPrdProofV2AdmissionDigests>;
    try {
      digests = semanticProofDigests(proof);
    } catch (error) {
      if (error instanceof PermanentError) throw error;
      proofRefusal(
        `CCC campaign semantic proof ${proof.id} admission custody is malformed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "CCC_CAMPAIGN_PROOF_CUSTODY_REFUSED",
      );
    }

    const tempRoot = await mkdtemp(join(tmpdir(), "ccc-semantic-proof-execution-"));
    try {
      let materialized: CccSemanticProofMaterialization;
      const sandboxPolicyFor = (
        value: CccSemanticProofMaterialization,
      ): CccSemanticProofSandboxPolicyInput => ({
        proofRoot: value.proofRoot,
        scratchRoot: value.scratchRoot,
        taskExecutable: value.sealedExecutionToolchain.task.executablePath,
        nodeExecutable: value.sealedExecutionToolchain.node.executablePath,
        deniedReadRoots: Object.freeze([
          ...new Set([execution.snapshot.targetRoot, engineRoot]),
        ]),
      });
      try {
        materialized = await dependencies.materialize({
          repositoryRoot: execution.snapshot.targetRoot,
          baseCommit: execution.campaign.targetRepository.baseCommit,
          sourceCommit: execution.snapshot.sourceCommit,
          proof,
          modelWriteRoots: execution.verifierDisjointRoots,
          outputRoot: tempRoot,
        });
        if (
          materialized.closureSha256 !== digests.verifierClosureSha256
          || materialized.candidateInputsSha256 !== digests.candidateInputsSha256
        ) {
          throw new Error("materialized proof digests differ from immutable admission");
        }
        await dependencies.verifyToolchain(materialized.sealedExecutionToolchain);
        await dependencies.preflightSandbox(sandboxPolicyFor(materialized));
      } catch (error) {
        proofRefusal(
          `CCC campaign semantic proof ${proof.id} pre-dispatch custody refused: ${
            error instanceof Error ? error.message : String(error)
          }`,
          "CCC_CAMPAIGN_PROOF_CUSTODY_REFUSED",
        );
      }

      await assertLiveWorkItemFence(input.store, originTaskId, fence);
      const reserved = await withSemanticProofDeadlineTranslation(() => (
        dependencies.proofAttempts.reserve({
        layer,
        rootDir: input.rootDir,
        taskId: execution.nativeTaskId,
        proofId: proof.id,
        attemptContractVersion: "v2",
        phase: execution.phase,
        sourceCommit: execution.snapshot.sourceCommit,
        sourceTree: execution.snapshot.sourceTree,
        workItemFence: {
          workItemId: fence.workItemId,
          runId: fence.runId,
          attempt: fence.attempt,
        },
        verifierClosureSha256: digests.verifierClosureSha256,
        candidateInputsSha256: digests.candidateInputsSha256,
        executionToolchainSha256: digests.executionToolchainSha256,
        })
      ));
      const terminalReplay = terminalAttemptResult(reserved, proof.id);
      if (terminalReplay) return terminalReplay;
      if (reserved.state === "committed") continue;

      await assertLiveWorkItemFence(input.store, originTaskId, fence);
      const timeoutMs = verificationTimeoutMs(execution.campaign, context);
      const dispatch = await withSemanticProofDeadlineTranslation(() => (
        dependencies.proofAttempts.begin({
          layer,
          attemptKey: reserved.attemptKey,
          controllerToken: reserved.controllerToken,
        })
      ));
      if (dispatch.kind !== "dispatch-permit") {
        const terminal = terminalAttemptResult(dispatch.attempt, proof.id);
        if (terminal) return terminal;
        if (dispatch.attempt.state === "committed") continue;
        proofRefusal(
          `CCC campaign semantic proof ${proof.id} dispatch was not permitted`,
          "CCC_CAMPAIGN_PROOF_DISPATCH_REFUSED",
        );
      }

      const startedAt = Date.now();
      let terminalEnvelope: CccCampaignProofTerminalEnvelopeV2;
      try {
        const processResult = await dependencies.runSandbox({
          ...sandboxPolicyFor(materialized),
          executable: materialized.sealedExecutionToolchain.task.executablePath,
          args: materialized.taskArgv,
          proofEnvironment: {
            CCC_PROOF_ID: proof.id,
            CCC_PROOF_PHASE: execution.phase,
            CCC_PROOF_SOURCE_COMMIT: execution.snapshot.sourceCommit,
            CCC_PROOF_SOURCE_TREE: execution.snapshot.sourceTree,
          },
          timeoutMs,
          maxOutputBytes: MAX_SEMANTIC_PROOF_OUTPUT_BYTES,
        });
        terminalEnvelope = semanticProofEnvelope(
          proof,
          execution.phase,
          execution.snapshot,
          processResult,
          Math.max(0, Date.now() - startedAt),
        );
      } catch {
        terminalEnvelope = executionRefusedEnvelope(
          proof,
          execution.phase,
          execution.snapshot,
          sandboxRefusedResult(),
          Math.max(0, Date.now() - startedAt),
          "sandbox_refused",
        );
      }

      await assertLiveWorkItemFence(input.store, originTaskId, fence);
      const settled = await dependencies.proofAttempts.settle({
        layer,
        attemptKey: reserved.attemptKey,
        controllerToken: reserved.controllerToken,
        terminalEnvelope,
      });
      const terminal = terminalAttemptResult(settled, proof.id);
      if (terminal) return terminal;
      if (settled.state !== "committed") {
        proofRefusal(
          `CCC campaign semantic proof ${proof.id} terminal state is invalid`,
          "CCC_CAMPAIGN_PROOF_SETTLEMENT_REFUSED",
        );
      }
    } finally {
      await makeTempTreeWriteable(tempRoot);
      await rm(tempRoot, { recursive: true, force: true });
    }
  }

  return {
    outcome: "success",
    value: "ccc-proof-suite-passed",
    contextPatch: {
      "ccc:proof:source-commit": execution.snapshot.sourceCommit,
      "ccc:proof:source-tree": execution.snapshot.sourceTree,
      "ccc:proof:mutation-paths": execution.snapshot.mutationPaths,
      "ccc:proof:ids": execution.proofIds,
      "ccc:proof:phase": execution.phase,
    },
  };
}

export function createCccCampaignProofSuiteHandler(
  input: CreateCccCampaignProofSuiteHandlerInput,
): WorkflowNodeHandler {
  const proofAttempts = input.proofAttempts ?? defaultProofAttempts();
  const semanticProofDependencies: SemanticProofRuntimeDependencies = {
    proofAttempts: input.semanticProofAttempts ?? defaultSemanticProofAttempts(),
    materialize: input.materializeSemanticProof ?? admitAndMaterializeCccSemanticProof,
    verifyToolchain: input.verifySemanticProofToolchain
      ?? verifyCccSemanticProofToolchainBeforeSpawn,
    preflightSandbox: input.preflightSemanticProofSandbox
      ?? assertCccSemanticProofSandboxReady,
    runSandbox: input.runSemanticProofSandbox ?? runCccSemanticProofSandboxedProcess,
  };
  const runVerification = input.runVerification ?? runVerificationCommand;
  const inspectConfinementReadiness = input.inspectVerifierConfinementReadiness
    ?? inspectVerifierConfinementReadiness;

  return async (node, context): Promise<WorkflowNodeResult> => {
    if (node.config?.cccProofGate === true || node.config?.cccProofPhase !== undefined) {
      return runSemanticProofV2(input, semanticProofDependencies, node, context);
    }
    if (node.config?.cccProofSuite !== true) {
      proofRefusal("CCC campaign proof-suite handler received a non-proof node");
    }
    context.signal?.throwIfAborted();
    const proofIds = requiredStrings(node.config.cccProofIds, "proof ids");
    const semanticTaskIds = requiredStrings(node.config.cccPrdTaskIds, "semantic task ids");
    const nativeTaskIds = node.config.cccNativeTaskIds === undefined
      ? semanticTaskIds
      : requiredStrings(node.config.cccNativeTaskIds, "native task ids");
    const finalSemanticTaskId = node.config.cccPrdTaskId;
    const finalNativeTaskId = node.config.cccNativeTaskId ?? finalSemanticTaskId;
    if (
      nativeTaskIds.length !== semanticTaskIds.length
      || typeof finalSemanticTaskId !== "string"
      || finalSemanticTaskId.length === 0
      || finalSemanticTaskId !== finalSemanticTaskId.trim()
      || typeof finalNativeTaskId !== "string"
      || finalNativeTaskId.length === 0
      || finalNativeTaskId !== finalNativeTaskId.trim()
      || semanticTaskIds.indexOf(finalSemanticTaskId) < 0
      || nativeTaskIds[semanticTaskIds.indexOf(finalSemanticTaskId)] !== finalNativeTaskId
      || context.execution?.semanticTaskId !== finalSemanticTaskId
      || context.execution?.nativeTaskId !== finalNativeTaskId
    ) {
      proofRefusal("CCC campaign proof integration task identity is missing or does not match sealed execution");
    }
    const layer = input.store.getAsyncLayer();
    if (!layer) {
      proofRefusal("CCC campaign proof execution requires PostgreSQL custody");
    }
    const fence = workItemFence(context);
    const originTaskId = context.execution?.originTaskId;
    if (typeof originTaskId !== "string" || originTaskId.length === 0) {
      proofRefusal(
        "CCC campaign proof origin task identity is missing",
        "CCC_CAMPAIGN_PROOF_FENCE_REFUSED",
      );
    }
    await assertLiveWorkItemFence(input.store, originTaskId, fence);
    const tasks = await Promise.all(nativeTaskIds.map((taskId) => input.store.getTask(taskId)));
    const contexts = await Promise.all(nativeTaskIds.map((taskId) =>
      input.store.getCccCampaignContextForTask(taskId)));
    if (contexts.some((campaign) => campaign == null)) {
      proofRefusal("CCC campaign proof task custody is missing");
    }
    const campaigns = contexts as CccCampaignTaskContext[];
    const mappingDrift = campaigns.some((candidate, index) => (
      candidate.taskId !== nativeTaskIds[index]
      || candidate.semanticTaskId !== semanticTaskIds[index]
      || candidate.route.taskId !== semanticTaskIds[index]
    ));
    const campaign = campaigns.find(({ taskId }) => taskId === finalNativeTaskId);
    if (
      mappingDrift
      || !campaign
      || campaigns.some((candidate) => !sameCampaign(campaign, candidate))
    ) {
      proofRefusal("CCC campaign proof tasks do not share one exact imported campaign");
    }
    const declaredProofIds = campaign.proofs.map(({ id }) => id);
    if (!sameSorted(proofIds, declaredProofIds)) {
      proofRefusal("CCC campaign proof node must execute every declared proof exactly once");
    }
    const finalTask = tasks.find(({ id }) => id === finalNativeTaskId);
    if (!finalTask) {
      proofRefusal("CCC campaign proof integration task is missing");
    }
    const gitSnapshot = await inspectFinalGit(
      input.rootDir,
      finalTask,
      campaign,
      tasks,
      campaigns,
    );
    const timeoutMs = verificationTimeoutMs(campaign, context);
    const confinementReadiness = await inspectConfinementReadiness();
    if (!isVerifierConfinementReady(confinementReadiness)) {
      proofRefusal(
        `CCC campaign verifier confinement is unavailable (${confinementReadiness.code}): ${confinementReadiness.message}`,
        "CCC_CAMPAIGN_VERIFIER_CONFINEMENT_UNAVAILABLE",
      );
    }

    for (const proofId of proofIds) {
      context.signal?.throwIfAborted();
      const proof = campaign.proofs.find(({ id }) => id === proofId);
      if (!proof) {
        proofRefusal(`CCC campaign proof ${proofId} definition is missing`);
      }
      const reserved = await proofAttempts.reserve({
        layer,
        rootDir: input.rootDir,
        taskId: finalNativeTaskId,
        proofId,
        scope: "campaign",
        sourceCommit: gitSnapshot.sourceCommit,
        sourceTree: gitSnapshot.sourceTree,
        workItemFence: fence,
      });
      const terminalReplay = terminalAttemptResult(reserved, proofId);
      if (terminalReplay) return terminalReplay;
      if (reserved.state === "committed") continue;

      await assertLiveWorkItemFence(input.store, originTaskId, fence);
      const dispatch = await proofAttempts.begin({
        layer,
        attemptKey: reserved.attemptKey,
        controllerToken: reserved.controllerToken,
      });
      if (dispatch.kind !== "dispatch-permit") {
        const terminal = terminalAttemptResult(dispatch.attempt, proofId);
        if (terminal) return terminal;
        if (dispatch.attempt.state === "committed") continue;
        proofRefusal(
          `CCC campaign proof ${proofId} dispatch was not permitted`,
          "CCC_CAMPAIGN_PROOF_DISPATCH_REFUSED",
        );
      }

      const result = await runVerification({
        command: proof.command,
        cwd: gitSnapshot.worktreeRoot,
        timeoutMs,
        onHeartbeat: () => undefined,
        signal: context.signal,
      });
      const preservedGitSnapshot = await verifierPreservedGitSnapshot(gitSnapshot);
      const settledResult = preservedGitSnapshot
        ? result
        : {
          ...result,
          success: false,
          warnings: [
            ...result.warnings,
            "CCC_CAMPAIGN_PROOF_VERIFIER_MUTATION: verifier changed the inspected commit, tree, or worktree",
          ],
        };
      await assertLiveWorkItemFence(input.store, originTaskId, fence);
      const settled = await proofAttempts.settle({
        layer,
        attemptKey: reserved.attemptKey,
        controllerToken: reserved.controllerToken,
        result: {
          ...settledResult,
          changedPathsSha256: sha256CanonicalStrings(gitSnapshot.mutationPaths),
        },
      });
      const terminal = terminalAttemptResult(settled, proofId);
      if (terminal) return terminal;
      if (settled.state !== "committed") {
        proofRefusal(
          `CCC campaign proof ${proofId} terminal state is invalid`,
          "CCC_CAMPAIGN_PROOF_SETTLEMENT_REFUSED",
        );
      }
    }

    return {
      outcome: "success",
      value: "ccc-proof-suite-passed",
      contextPatch: {
        "ccc:proof:source-commit": gitSnapshot.sourceCommit,
        "ccc:proof:source-tree": gitSnapshot.sourceTree,
        "ccc:proof:mutation-paths": gitSnapshot.mutationPaths,
        "ccc:proof:ids": proofIds,
      },
    };
  };
}
