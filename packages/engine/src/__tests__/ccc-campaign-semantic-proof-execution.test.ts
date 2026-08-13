import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  CccCampaignProofAttemptLimitError,
  canonicalCccPrdJson,
  computeCccPrdProofDefinitionSha256,
  computeCccPrdProofV2AdmissionDigests,
  type CccCampaignTaskContext,
  type CccPrdProofV2,
  type TaskDetail,
  type WorkflowIrNode,
} from "@fusion/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CCC_CAMPAIGN_PROOF_ADMISSION_EXTENSION_ID,
  CCC_CAMPAIGN_PROOF_ADMISSION_PLUGIN_ID,
  CCC_CAMPAIGN_PROOF_ADMISSION_PLUGIN_VERSION,
  CCC_CAMPAIGN_PROOF_ADMISSION_PROOF_VERSION,
} from "../ccc-campaign-proof-admission.js";
import { createCccCampaignProofSuiteHandler } from "../ccc-campaign-proof-execution.js";
import { ensureCccCampaignJoinBaseBranch } from "../ccc-campaign-join-base.js";
import {
  inspectCccSemanticProofExecutable,
  inspectCccSemanticProofLinkedRuntime,
} from "../ccc-campaign-proof-materialization.js";

const execFile = promisify(execFileCallback);
const scratchRoots: string[] = [];
const itSemanticHost = process.platform === "darwin"
  && existsSync("/usr/bin/sandbox-exec")
  && existsSync("/opt/homebrew/bin/task")
  ? it
  : it.skip;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function commit(repo: string, message: string): Promise<string> {
  await execFile("git", ["-C", repo, "add", "--all"]);
  await execFile("git", [
    "-C",
    repo,
    "-c",
    "user.name=Fusion Test",
    "-c",
    "user.email=fusion-test@example.invalid",
    "commit",
    "-m",
    message,
  ]);
  return (await execFile("git", ["-C", repo, "rev-parse", "HEAD"])).stdout.trim();
}

function admittedProof(): CccPrdProofV2 {
  const proof = {
    schema: "ccc-prd.proof.v2",
    id: "PROOF-value-v2",
    requirementIds: ["REQ-value"],
    clauseIds: ["CLAUSE-value"],
    phases: ["task", "final_integrated"],
    command: "task verify:value",
    positiveOracle: "The exact value is accepted.",
    positiveCases: [{ id: "CASE-good", description: "The expected value passes." }],
    negativeControls: [{ id: "CONTROL-bad", description: "A planted bad value fails." }],
    verifierClosure: [{
      role: "task_runner",
      path: "Taskfile.yml",
      baseGitBlobOid: "1".repeat(40),
      sha256: "2".repeat(64),
    }, {
      role: "harness",
      path: "proof/value.mjs",
      baseGitBlobOid: "3".repeat(40),
      sha256: "4".repeat(64),
    }],
    candidateInputs: ["src/value.txt"],
    executionToolchain: {
      task: {
        executablePath: "/usr/bin/true",
        executableSha256: "5".repeat(64),
        version: "task fixture",
        versionOutputSha256: "6".repeat(64),
      },
      node: {
        executablePath: "/usr/bin/true",
        executableSha256: "7".repeat(64),
        version: "node fixture",
        versionOutputSha256: "8".repeat(64),
      },
      proofHost: {
        id: "proof-host-fixture",
        executablePath: "/usr/bin/true",
        executableSha256: "9".repeat(64),
        version: "proof host fixture",
        versionOutputSha256: "a".repeat(64),
      },
      linkedRuntime: [],
    },
    spans: [],
    confidence: "high",
  } satisfies Omit<CccPrdProofV2, "admission">;
  const definitionSha256 = computeCccPrdProofDefinitionSha256(proof);
  const digests = computeCccPrdProofV2AdmissionDigests(proof);
  return {
    ...proof,
    admission: {
      schema: "ccc-prd.proof-admission.v2",
      pluginId: CCC_CAMPAIGN_PROOF_ADMISSION_PLUGIN_ID,
      pluginVersion: CCC_CAMPAIGN_PROOF_ADMISSION_PLUGIN_VERSION,
      extensionId: CCC_CAMPAIGN_PROOF_ADMISSION_EXTENSION_ID,
      proofVersion: CCC_CAMPAIGN_PROOF_ADMISSION_PROOF_VERSION,
      extensionRootRelativeSource: "src/ccc-campaign-proof-admission.ts",
      extensionSourceSha256: "b".repeat(64),
      extensionManifestSha256: "c".repeat(64),
      definitionSha256,
      ...digests,
    },
  };
}

async function fixture() {
  const scratch = await mkdtemp(join(tmpdir(), "ccc-semantic-proof-execution-"));
  scratchRoots.push(scratch);
  const repo = join(scratch, "target");
  const worktree = join(scratch, "task-worktree");
  await Promise.all([
    mkdir(join(repo, "src"), { recursive: true }),
    mkdir(join(repo, "proof"), { recursive: true }),
  ]);
  await execFile("git", ["init", "--initial-branch=main", repo]);
  await writeFile(join(repo, "README.md"), "fixture repository\n", "utf8");
  const preBaseCommit = await commit(repo, "repository genesis");
  await writeFile(join(repo, "src", "value.txt"), "base\n", "utf8");
  await writeFile(join(repo, "Taskfile.yml"), [
    "version: '3'",
    "tasks:",
    "  verify:value:",
    "    cmds:",
    "      - node proof/value.mjs src/value.txt",
    "",
  ].join("\n"), "utf8");
  await writeFile(join(repo, "proof", "value.mjs"), [
    "import { readFile } from 'node:fs/promises';",
    "const value = await readFile(process.argv[2], 'utf8');",
    "const passed = value === 'good\\n';",
    "const evidence = {",
    "  clauseResults: [{ clauseId: 'CLAUSE-value', passed }],",
    "  negativeControlResults: [{ controlId: 'CONTROL-bad', passed }],",
    "  passed,",
    "  phase: process.env.CCC_PROOF_PHASE,",
    "  positiveCaseResults: [{ caseId: 'CASE-good', passed }],",
    "  proofId: process.env.CCC_PROOF_ID,",
    "  schema: 'ccc-prd.proof-evidence.v2',",
    "  sourceCommit: process.env.CCC_PROOF_SOURCE_COMMIT,",
    "  sourceTree: process.env.CCC_PROOF_SOURCE_TREE,",
    "};",
    "process.stdout.write(`${JSON.stringify(evidence)}\\n`);",
    "process.exitCode = passed ? 0 : 1;",
    "",
  ].join("\n"), "utf8");
  const baseCommit = await commit(repo, "base");
  await execFile("git", ["-C", repo, "worktree", "add", "-b", "campaign/task", worktree, baseCommit]);
  await writeFile(join(worktree, "src", "value.txt"), "good\n", "utf8");
  const sourceCommit = await commit(worktree, "campaign task result");
  const sourceTree = (await execFile("git", ["-C", worktree, "rev-parse", "HEAD^{tree}"])).stdout.trim();
  const proof = admittedProof();
  const semanticTaskId = "TASK-value";
  const task = {
    id: "FN-value",
    worktree,
    branch: "campaign/task",
    baseCommitSha: baseCommit,
    customFields: { cccFusionProfile: "ccc-fusion" },
  } as unknown as TaskDetail;
  const campaign = {
    schema: "ccc-campaign.context.v1",
    projectId: "__legacy_unscoped__",
    importId: "IMPORT-semantic-proof",
    idempotencyKey: "semantic-proof-execution",
    campaignId: "CAMPAIGN-semantic-proof",
    packetHash: "d".repeat(64),
    sidecarHash: "e".repeat(64),
    bundleHash: "f".repeat(64),
    sourceVersion: "fixture",
    targetRepository: { path: repo, baseCommit },
    targetBase: baseCommit,
    bounds: { maxRequests: 10, maxDurationMs: 60_000, maxConcurrency: 1 },
    campaignStartedAt: "2026-08-12T00:00:00.000Z",
    campaignDeadlineAt: "2099-08-13T00:00:00.000Z",
    admittedWriteRoots: [{ path: repo, purpose: "fixture" }],
    proofs: [proof],
    protectedActions: [],
    executionPolicy: {
      schema: "ccc-campaign.execution-policy.v2",
      routes: [{
        taskId: semanticTaskId,
        providerId: "fixture",
        modelId: "fixture-v2",
        transport: "pi",
        executor: "model",
        toolMode: "coding",
        worktreeMode: "isolated",
        ownedPaths: ["src"],
        allowedWriteRoots: ["src"],
        commitPolicy: "required",
      }],
    },
    taskId: task.id,
    semanticTaskId,
    proofIds: [proof.id],
    protectedActionIds: [],
    route: {
      taskId: semanticTaskId,
      providerId: "fixture",
      modelId: "fixture-v2",
      transport: "pi",
      executor: "model",
      toolMode: "coding",
      worktreeMode: "isolated",
      ownedPaths: ["src"],
      allowedWriteRoots: ["src"],
      commitPolicy: "required",
    },
    manifestHash: "0".repeat(64),
    requestCount: 0,
    activeActionLeases: {},
  } as unknown as CccCampaignTaskContext;
  const node = {
    id: "task-proof-gate",
    kind: "gate",
    config: {
      cccProofGate: true,
      cccProofPhase: "task",
      cccProofIds: [proof.id],
      cccPrdTaskId: semanticTaskId,
      cccNativeTaskId: task.id,
    },
  } as WorkflowIrNode;
  const context = {
    task,
    settings: { verificationCommandTimeoutMs: 30_000 },
    context: {},
    execution: {
      originTaskId: task.id,
      semanticTaskId,
      nativeTaskId: task.id,
      semanticTask: task,
      runId: "RUN-semantic-proof",
      visitIdentity: { nodeId: node.id, materializedNodeId: node.id },
      executionFence: {
        workItemId: "WORK-semantic-proof",
        leaseOwner: "proof-worker",
        attempt: 1,
        runId: "RUN-semantic-proof",
      },
    },
  } as never;
  return {
    repo,
    worktree,
    preBaseCommit,
    baseCommit,
    sourceCommit,
    sourceTree,
    proof,
    task,
    campaign,
    node,
    context,
  };
}

type SemanticFixture = Awaited<ReturnType<typeof fixture>>;

async function removeFixtureTaskWorktree(f: SemanticFixture): Promise<void> {
  await execFile("git", ["-C", f.repo, "worktree", "remove", f.worktree]);
}

async function serialSuccessorFixture(options: { commitSuccessor?: boolean } = {}) {
  const f = await fixture();
  await removeFixtureTaskWorktree(f);
  const predecessorWorktree = join(f.repo, "..", "predecessor-worktree");
  const predecessorId = "FN-predecessor";
  const predecessorBranch = "campaign/predecessor";
  await execFile("git", [
    "-C",
    f.repo,
    "worktree",
    "add",
    "-b",
    predecessorBranch,
    predecessorWorktree,
    f.baseCommit,
  ]);
  await mkdir(join(predecessorWorktree, "predecessor"), { recursive: true });
  await writeFile(join(predecessorWorktree, "predecessor", "result.txt"), "first\n", "utf8");
  const predecessorCommit = await commit(predecessorWorktree, "campaign predecessor result");

  const successorBranch = "campaign/task-successor";
  await execFile("git", [
    "-C",
    f.repo,
    "worktree",
    "add",
    "-b",
    successorBranch,
    f.worktree,
    predecessorCommit,
  ]);
  if (options.commitSuccessor !== false) {
    await writeFile(join(f.worktree, "src", "value.txt"), "good\n", "utf8");
  }
  const sourceCommit = options.commitSuccessor === false
    ? predecessorCommit
    : await commit(f.worktree, "campaign successor result");
  const sourceTree = (
    await execFile("git", ["-C", f.worktree, "rev-parse", "HEAD^{tree}"])
  ).stdout.trim();
  const predecessor = {
    ...f.task,
    id: predecessorId,
    lineageId: `ccc-prd:0123456789abcdef01234567:${predecessorId}`,
    dependencies: [],
    worktree: predecessorWorktree,
    branch: predecessorBranch,
  } as TaskDetail;
  Object.assign(f.task, {
    lineageId: `ccc-prd:0123456789abcdef01234567:${f.task.id}`,
    dependencies: [predecessorId],
    branch: successorBranch,
  });
  return {
    ...f,
    sourceCommit,
    sourceTree,
    predecessor,
    predecessorCommit,
    tasks: new Map<string, TaskDetail>([
      [predecessor.id, predecessor],
      [f.task.id, f.task],
    ]),
  };
}

async function joinSuccessorFixture() {
  const f = await fixture();
  await removeFixtureTaskWorktree(f);
  const predecessors: TaskDetail[] = [];
  const predecessorCommits: string[] = [];
  for (const suffix of ["a", "b"] as const) {
    const predecessorId = `FN-predecessor-${suffix}`;
    const predecessorBranch = `campaign/predecessor-${suffix}`;
    const predecessorWorktree = join(f.repo, "..", `predecessor-${suffix}-worktree`);
    await execFile("git", [
      "-C",
      f.repo,
      "worktree",
      "add",
      "-b",
      predecessorBranch,
      predecessorWorktree,
      f.baseCommit,
    ]);
    await mkdir(join(predecessorWorktree, `predecessor-${suffix}`), { recursive: true });
    await writeFile(
      join(predecessorWorktree, `predecessor-${suffix}`, "result.txt"),
      `${suffix}\n`,
      "utf8",
    );
    predecessorCommits.push(await commit(predecessorWorktree, `campaign predecessor ${suffix}`));
    predecessors.push({
      ...f.task,
      id: predecessorId,
      lineageId: `ccc-prd:0123456789abcdef01234567:${predecessorId}`,
      dependencies: [],
      worktree: predecessorWorktree,
      branch: predecessorBranch,
    } as TaskDetail);
  }
  const joinBranch = await ensureCccCampaignJoinBaseBranch({
    rootDir: f.repo,
    taskId: f.task.id,
    predecessors: predecessors.map((predecessor) => ({
      taskId: predecessor.id,
      branch: predecessor.branch!,
    })),
  });
  const joinTip = (
    await execFile("git", ["-C", f.repo, "rev-parse", `refs/heads/${joinBranch}`])
  ).stdout.trim();
  const successorBranch = "campaign/task-join";
  await execFile("git", [
    "-C",
    f.repo,
    "worktree",
    "add",
    "-b",
    successorBranch,
    f.worktree,
    joinTip,
  ]);
  await writeFile(join(f.worktree, "src", "value.txt"), "good\n", "utf8");
  const sourceCommit = await commit(f.worktree, "campaign join successor result");
  const sourceTree = (
    await execFile("git", ["-C", f.worktree, "rev-parse", "HEAD^{tree}"])
  ).stdout.trim();
  Object.assign(f.task, {
    lineageId: `ccc-prd:0123456789abcdef01234567:${f.task.id}`,
    dependencies: predecessors.map(({ id }) => id),
    branch: successorBranch,
  });
  return {
    ...f,
    sourceCommit,
    sourceTree,
    predecessors,
    predecessorCommits,
    joinBranch,
    joinTip,
    tasks: new Map<string, TaskDetail>([
      ...predecessors.map((predecessor) => [predecessor.id, predecessor] as const),
      [f.task.id, f.task],
    ]),
  };
}

async function rewindPredecessorToBase(
  repo: string,
  predecessor: TaskDetail,
  frozenBase: string,
): Promise<void> {
  await execFile("git", ["-C", repo, "worktree", "remove", predecessor.worktree!]);
  await execFile("git", ["-C", repo, "branch", "-f", predecessor.branch!, frozenBase]);
  await execFile("git", [
    "-C",
    repo,
    "worktree",
    "add",
    predecessor.worktree!,
    predecessor.branch!,
  ]);
}

async function verifierClosureEntry(
  repo: string,
  baseCommit: string,
  path: string,
  role: "task_runner" | "harness",
) {
  const tree = (await execFile("git", ["-C", repo, "ls-tree", baseCommit, "--", path])).stdout;
  const match = /^(?:100644|100755) blob ([0-9a-f]{40}|[0-9a-f]{64})\t/u.exec(tree);
  if (!match) throw new Error(`fixture cannot resolve verifier blob ${path}`);
  return {
    role,
    path,
    baseGitBlobOid: match[1]!,
    sha256: createHash("sha256").update(await readFile(join(repo, path))).digest("hex"),
  } as const;
}

async function liveAdmittedProof(
  f: Awaited<ReturnType<typeof fixture>>,
): Promise<CccPrdProofV2> {
  const taskPath = (await execFile("which", ["task"])).stdout.trim();
  const [taskIdentity, nodeIdentity, taskRunner, harness] = await Promise.all([
    inspectCccSemanticProofExecutable(taskPath, ["--version"]),
    inspectCccSemanticProofExecutable(process.execPath, ["--version"]),
    verifierClosureEntry(f.repo, f.baseCommit, "Taskfile.yml", "task_runner"),
    verifierClosureEntry(f.repo, f.baseCommit, "proof/value.mjs", "harness"),
  ]);
  const proofHostIdentity = { id: "proof-host-node", ...nodeIdentity };
  const linkedRuntime = await inspectCccSemanticProofLinkedRuntime({
    task: taskIdentity,
    node: nodeIdentity,
    proofHost: proofHostIdentity,
  });
  const proof = {
    schema: "ccc-prd.proof.v2",
    id: f.proof.id,
    requirementIds: [...f.proof.requirementIds],
    clauseIds: [...f.proof.clauseIds],
    phases: [...f.proof.phases],
    command: f.proof.command,
    positiveOracle: f.proof.positiveOracle,
    positiveCases: [...f.proof.positiveCases],
    negativeControls: [...f.proof.negativeControls],
    verifierClosure: [taskRunner, harness],
    candidateInputs: [...f.proof.candidateInputs],
    executionToolchain: {
      task: taskIdentity,
      node: nodeIdentity,
      proofHost: proofHostIdentity,
      linkedRuntime,
    },
    spans: [...f.proof.spans],
    confidence: f.proof.confidence,
  } satisfies Omit<CccPrdProofV2, "admission">;
  const digests = computeCccPrdProofV2AdmissionDigests(proof);
  return {
    ...proof,
    admission: {
      schema: "ccc-prd.proof-admission.v2",
      pluginId: CCC_CAMPAIGN_PROOF_ADMISSION_PLUGIN_ID,
      pluginVersion: CCC_CAMPAIGN_PROOF_ADMISSION_PLUGIN_VERSION,
      extensionId: CCC_CAMPAIGN_PROOF_ADMISSION_EXTENSION_ID,
      proofVersion: CCC_CAMPAIGN_PROOF_ADMISSION_PROOF_VERSION,
      extensionRootRelativeSource: "src/ccc-campaign-proof-admission.ts",
      extensionSourceSha256: "b".repeat(64),
      extensionManifestSha256: "c".repeat(64),
      definitionSha256: computeCccPrdProofDefinitionSha256(proof),
      ...digests,
    },
  };
}

function evidenceFor(
  f: Awaited<ReturnType<typeof fixture>>,
  passed: boolean,
  phase: "task" | "final_integrated" = "task",
) {
  return {
    schema: "ccc-prd.proof-evidence.v2" as const,
    proofId: f.proof.id,
    phase,
    sourceCommit: f.sourceCommit,
    sourceTree: f.sourceTree,
    passed,
    clauseResults: [{ clauseId: "CLAUSE-value", passed }],
    positiveCaseResults: [{ caseId: "CASE-good", passed }],
    negativeControlResults: [{ controlId: "CONTROL-bad", passed }],
  };
}

function processResult(stdout: string, exitCode: number | null = 0) {
  return {
    exitCode,
    signal: null,
    stdout,
    stderr: "",
    stdoutSha256: sha256(stdout),
    stderrSha256: sha256(""),
    timedOut: false,
    killed: false,
    outputOverLimit: false,
  };
}

function materializedFixture(
  outputRoot: string,
  admission: NonNullable<CccPrdProofV2["admission"]>,
  executionToolchain: CccPrdProofV2["executionToolchain"],
) {
  const sealedExecutionToolchain = {
    task: {
      ...executionToolchain.task,
      executablePath: join(outputRoot, "toolchain", "bin", "task"),
    },
    node: {
      ...executionToolchain.node,
      executablePath: join(outputRoot, "toolchain", "bin", "node"),
    },
    proofHost: {
      ...executionToolchain.proofHost,
      executablePath: join(outputRoot, "toolchain", "proof-host.mjs"),
    },
    linkedRuntime: executionToolchain.linkedRuntime,
  };
  return {
    proofRoot: join(outputRoot, "proof"),
    scratchRoot: join(outputRoot, "scratch"),
    taskTarget: "verify:value",
    taskArgv: ["verify:value"],
    closureSha256: admission.verifierClosureSha256,
    candidateInputsSha256: admission.candidateInputsSha256,
    sealedToolchain: {
      taskExecutable: sealedExecutionToolchain.task.executablePath,
      nodeExecutable: sealedExecutionToolchain.node.executablePath,
      proofHostExecutable: sealedExecutionToolchain.proofHost.executablePath,
    },
    sealedExecutionToolchain,
  };
}

function attemptApi() {
  const reserve = vi.fn(async () => ({
    attemptKey: "ccc-proof-attempt-v2",
    controllerToken: "ccc-proof-controller-v2",
    state: "reserved" as const,
  }));
  const begin = vi.fn(async () => ({
    kind: "dispatch-permit" as const,
    attempt: {
      attemptKey: "ccc-proof-attempt-v2",
      controllerToken: "ccc-proof-controller-v2",
      state: "dispatched_unknown" as const,
    },
  }));
  const settle = vi.fn(async (input: { terminalEnvelope: { kind: string; passed?: boolean } }) => ({
    attemptKey: "ccc-proof-attempt-v2",
    controllerToken: "ccc-proof-controller-v2",
    state: input.terminalEnvelope.kind === "verified" && input.terminalEnvelope.passed
      ? "committed" as const
      : "proved_failed" as const,
  }));
  return { reserve, begin, settle };
}

function semanticHandler(
  f: Awaited<ReturnType<typeof fixture>>,
  options: {
    attempts?: ReturnType<typeof attemptApi>;
    tasks?: ReadonlyMap<string, TaskDetail>;
    verifyToolchain?: () => Promise<void>;
    runSandbox?: () => Promise<ReturnType<typeof processResult>>;
  } = {},
) {
  const attempts = options.attempts ?? attemptApi();
  const admission = f.proof.admission!;
  const runSandbox = vi.fn(options.runSandbox ?? (async () => {
    const stdout = `${canonicalCccPrdJson(evidenceFor(f, true))}\n`;
    return processResult(stdout);
  }));
  const handler = createCccCampaignProofSuiteHandler({
    rootDir: f.repo,
    store: {
      getTask: async (taskId: string) => {
        if (!options.tasks) return f.task;
        const task = options.tasks.get(taskId);
        if (!task) throw new Error(`missing fixture task ${taskId}`);
        return task;
      },
      getCccCampaignContextForTask: async () => f.campaign,
      getAsyncLayer: () => ({}) as never,
      assertCccCampaignWorkflowLeaseFence: async () => undefined,
    },
    semanticProofAttempts: attempts,
    materializeSemanticProof: async ({ outputRoot }: { outputRoot: string }) =>
      materializedFixture(outputRoot, admission, f.proof.executionToolchain),
    verifySemanticProofToolchain: options.verifyToolchain ?? (async () => undefined),
    preflightSemanticProofSandbox: async () => undefined,
    runSemanticProofSandbox: runSandbox,
  } as never);
  return { handler, attempts, runSandbox };
}

afterEach(async () => {
  await Promise.all(scratchRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("CCC semantic proof v2 execution", () => {
  it("RED-S5-task-delta proves a serial successor from full HEAD but binds only its own delta", async () => {
    const f = await serialSuccessorFixture();
    const { handler, attempts } = semanticHandler(f, { tasks: f.tasks });

    await expect(handler(f.node, f.context)).resolves.toMatchObject({
      outcome: "success",
      contextPatch: {
        "ccc:proof:source-commit": f.sourceCommit,
        "ccc:proof:source-tree": f.sourceTree,
        "ccc:proof:mutation-paths": ["src/value.txt"],
      },
    });
    expect(attempts.reserve).toHaveBeenCalledWith(expect.objectContaining({
      sourceCommit: f.sourceCommit,
      sourceTree: f.sourceTree,
    }));
    expect(attempts.settle).toHaveBeenCalledWith(expect.objectContaining({
      terminalEnvelope: expect.objectContaining({
        changedPathsSha256: sha256(JSON.stringify(["src/value.txt"])),
      }),
    }));
  });

  it("RED-S5-controller-git-custody: proof execution refuses to spawn a fake git earlier on PATH", async () => {
    const f = await fixture();
    const fakeBin = await mkdtemp(join(tmpdir(), "ccc-semantic-proof-fake-git-"));
    scratchRoots.push(fakeBin);
    const marker = join(fakeBin, "fake-git-ran");
    await writeFile(join(fakeBin, "git"), [
      "#!/bin/sh",
      `printf hit > ${marker}`,
      "if [ \"$1\" = \"--version\" ]; then printf 'git version hostile\\n'; exit 0; fi",
      "exit 42",
      "",
    ].join("\n"), "utf8");
    await chmod(join(fakeBin, "git"), 0o755);
    const { handler, attempts } = semanticHandler(f);
    const originalPath = process.env.PATH;
    process.env.PATH = `${fakeBin}:${originalPath ?? ""}`;
    try {
      await expect(handler(f.node, f.context)).resolves.toMatchObject({
        outcome: "success",
        contextPatch: {
          "ccc:proof:source-commit": f.sourceCommit,
          "ccc:proof:source-tree": f.sourceTree,
        },
      });
      expect(attempts.reserve).toHaveBeenCalledTimes(1);
      await expect(lstat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  });

  it("RED-S5-task-delta proves a join successor from full integrated HEAD but binds only its own delta", async () => {
    const f = await joinSuccessorFixture();
    const { handler, attempts } = semanticHandler(f, { tasks: f.tasks });

    await expect(handler(f.node, f.context)).resolves.toMatchObject({
      outcome: "success",
      contextPatch: {
        "ccc:proof:source-commit": f.sourceCommit,
        "ccc:proof:source-tree": f.sourceTree,
        "ccc:proof:mutation-paths": ["src/value.txt"],
      },
    });
    for (const predecessorCommit of f.predecessorCommits) {
      await expect(execFile("git", [
        "-C",
        f.worktree,
        "merge-base",
        "--is-ancestor",
        predecessorCommit,
        f.sourceCommit,
      ])).resolves.toBeDefined();
    }
    expect(attempts.settle).toHaveBeenCalledWith(expect.objectContaining({
      terminalEnvelope: expect.objectContaining({
        changedPathsSha256: sha256(JSON.stringify(["src/value.txt"])),
      }),
    }));
  });

  it("RED-S5-task-delta refuses a serial successor when predecessor custody is missing", async () => {
    const f = await serialSuccessorFixture();
    f.tasks.delete(f.predecessor.id);
    const { handler, attempts } = semanticHandler(f, { tasks: f.tasks });

    await expect(handler(f.node, f.context)).rejects.toMatchObject({
      code: "CCC_CAMPAIGN_PROOF_INTEGRATION_REFUSED",
      message: expect.stringContaining(f.predecessor.id),
    });
    expect(attempts.reserve).not.toHaveBeenCalled();
  });

  it("RED-S5-task-delta refuses a serial successor with unresolvable predecessor commit custody", async () => {
    const f = await serialSuccessorFixture();
    f.predecessor.worktree = join(f.repo, "..", "missing-predecessor-worktree");
    f.predecessor.branch = undefined;
    const { handler, attempts } = semanticHandler(f, { tasks: f.tasks });

    await expect(handler(f.node, f.context)).rejects.toMatchObject({
      code: "CCC_CAMPAIGN_PROOF_INTEGRATION_REFUSED",
      message: expect.stringContaining(f.predecessor.id),
    });
    expect(attempts.reserve).not.toHaveBeenCalled();
  });

  it("RED-S5-predecessor-custody refuses a serial predecessor rewound to the frozen base", async () => {
    const f = await serialSuccessorFixture();
    await rewindPredecessorToBase(f.repo, f.predecessor, f.baseCommit);
    const { handler, attempts } = semanticHandler(f, { tasks: f.tasks });

    await expect(handler(f.node, f.context)).rejects.toMatchObject({
      code: "CCC_CAMPAIGN_PROOF_INTEGRATION_REFUSED",
      message: expect.stringContaining(f.predecessor.id),
    });
    expect(attempts.reserve).not.toHaveBeenCalled();
  });

  it("RED-S5-predecessor-before-base refuses a serial predecessor rewound before the frozen base", async () => {
    const f = await serialSuccessorFixture();
    await rewindPredecessorToBase(f.repo, f.predecessor, f.preBaseCommit);
    const { handler, attempts } = semanticHandler(f, { tasks: f.tasks });

    await expect(handler(f.node, f.context)).rejects.toMatchObject({
      code: "CCC_CAMPAIGN_PROOF_INTEGRATION_REFUSED",
      message: expect.stringContaining(f.predecessor.id),
    });
    expect(attempts.reserve).not.toHaveBeenCalled();
  });

  it("RED-S5-predecessor-custody refuses disagreeing live predecessor custody sources", async () => {
    const f = await serialSuccessorFixture();
    f.predecessor.mergeDetails = { commitSha: f.baseCommit };
    const { handler, attempts } = semanticHandler(f, { tasks: f.tasks });

    await expect(handler(f.node, f.context)).rejects.toMatchObject({
      code: "CCC_CAMPAIGN_PROOF_INTEGRATION_REFUSED",
      message: expect.stringContaining("disagree"),
    });
    expect(attempts.reserve).not.toHaveBeenCalled();
  });

  it("keeps durable branch fallback when the predecessor worktree was disposed", async () => {
    const f = await serialSuccessorFixture();
    f.predecessor.worktree = join(f.repo, "..", "disposed-predecessor-worktree");
    const { handler, attempts } = semanticHandler(f, { tasks: f.tasks });

    await expect(handler(f.node, f.context)).resolves.toMatchObject({
      outcome: "success",
      contextPatch: { "ccc:proof:mutation-paths": ["src/value.txt"] },
    });
    expect(attempts.reserve).toHaveBeenCalledTimes(1);
  });

  it("RED-S5-task-delta refuses a join successor whose join base loses one predecessor", async () => {
    const f = await joinSuccessorFixture();
    await execFile("git", [
      "-C",
      f.repo,
      "branch",
      "-f",
      f.joinBranch,
      f.predecessorCommits[0]!,
    ]);
    const { handler, attempts } = semanticHandler(f, { tasks: f.tasks });

    await expect(handler(f.node, f.context)).rejects.toMatchObject({
      code: "CCC_CAMPAIGN_PROOF_INTEGRATION_REFUSED",
      message: expect.stringContaining(f.predecessors[1]!.id),
    });
    expect(attempts.reserve).not.toHaveBeenCalled();
  });

  it("RED-S5-predecessor-custody refuses a join predecessor rewound to the frozen base", async () => {
    const f = await joinSuccessorFixture();
    const rewound = f.predecessors[1]!;
    await rewindPredecessorToBase(f.repo, rewound, f.baseCommit);
    const { handler, attempts } = semanticHandler(f, { tasks: f.tasks });

    await expect(handler(f.node, f.context)).rejects.toMatchObject({
      code: "CCC_CAMPAIGN_PROOF_INTEGRATION_REFUSED",
      message: expect.stringContaining(rewound.id),
    });
    expect(attempts.reserve).not.toHaveBeenCalled();
  });

  it("RED-S5-predecessor-before-base refuses a join predecessor rewound before the frozen base", async () => {
    const f = await joinSuccessorFixture();
    const rewound = f.predecessors[1]!;
    await rewindPredecessorToBase(f.repo, rewound, f.preBaseCommit);
    const { handler, attempts } = semanticHandler(f, { tasks: f.tasks });

    await expect(handler(f.node, f.context)).rejects.toMatchObject({
      code: "CCC_CAMPAIGN_PROOF_INTEGRATION_REFUSED",
      message: expect.stringContaining(rewound.id),
    });
    expect(attempts.reserve).not.toHaveBeenCalled();
  });

  it("RED-S5-task-delta refuses a successor that made no commit after its predecessor", async () => {
    const f = await serialSuccessorFixture({ commitSuccessor: false });
    const { handler, attempts } = semanticHandler(f, { tasks: f.tasks });

    await expect(handler(f.node, f.context)).rejects.toMatchObject({
      code: "CCC_CAMPAIGN_PROOF_COMMIT_REQUIRED",
      message: expect.stringContaining("requires a commit created by the campaign task"),
    });
    expect(attempts.reserve).not.toHaveBeenCalled();
  });

  it("runs a task-phase proof from the sealed commit and settles canonical passing evidence", async () => {
    const f = await fixture();
    const admission = f.proof.admission!;
    const reserve = vi.fn(async () => ({
      attemptKey: "ccc-proof-attempt-v2",
      controllerToken: "ccc-proof-controller-v2",
      state: "reserved" as const,
    }));
    const begin = vi.fn(async () => ({
      kind: "dispatch-permit" as const,
      attempt: {
        attemptKey: "ccc-proof-attempt-v2",
        controllerToken: "ccc-proof-controller-v2",
        state: "dispatched_unknown" as const,
      },
    }));
    const settle = vi.fn(async (input: { terminalEnvelope: { kind: string; passed?: boolean } }) => ({
      attemptKey: "ccc-proof-attempt-v2",
      controllerToken: "ccc-proof-controller-v2",
      state: input.terminalEnvelope.kind === "verified" && input.terminalEnvelope.passed
        ? "committed" as const
        : "proved_failed" as const,
    }));
    const runSemanticProofSandbox = vi.fn(async () => {
      const evidence = {
        schema: "ccc-prd.proof-evidence.v2",
        proofId: f.proof.id,
        phase: "task",
        sourceCommit: f.sourceCommit,
        sourceTree: f.sourceTree,
        passed: true,
        clauseResults: [{ clauseId: "CLAUSE-value", passed: true }],
        positiveCaseResults: [{ caseId: "CASE-good", passed: true }],
        negativeControlResults: [{ controlId: "CONTROL-bad", passed: true }],
      };
      const stdout = `${canonicalCccPrdJson(evidence)}\n`;
      return {
        exitCode: 0,
        signal: null,
        stdout,
        stderr: "",
        stdoutSha256: sha256(stdout),
        stderrSha256: sha256(""),
        timedOut: false,
        killed: false,
        outputOverLimit: false,
      };
    });
    const handler = createCccCampaignProofSuiteHandler({
      rootDir: f.repo,
      store: {
        getTask: async () => f.task,
        getCccCampaignContextForTask: async () => f.campaign,
        getAsyncLayer: () => ({}) as never,
        assertCccCampaignWorkflowLeaseFence: async () => undefined,
      },
      semanticProofAttempts: { reserve, begin, settle },
      materializeSemanticProof: async ({ outputRoot }: { outputRoot: string }) =>
        materializedFixture(outputRoot, admission, f.proof.executionToolchain),
      verifySemanticProofToolchain: async () => undefined,
      preflightSemanticProofSandbox: async () => undefined,
      runSemanticProofSandbox,
    } as never);

    await expect(handler(f.node, f.context)).resolves.toMatchObject({
      outcome: "success",
      value: "ccc-proof-suite-passed",
      contextPatch: {
        "ccc:proof:source-commit": f.sourceCommit,
        "ccc:proof:source-tree": f.sourceTree,
        "ccc:proof:ids": [f.proof.id],
        "ccc:proof:phase": "task",
      },
    });
    expect(reserve).toHaveBeenCalledWith(expect.objectContaining({
      attemptContractVersion: "v2",
      phase: "task",
      taskId: f.task.id,
      proofId: f.proof.id,
      sourceCommit: f.sourceCommit,
      sourceTree: f.sourceTree,
      verifierClosureSha256: admission.verifierClosureSha256,
      candidateInputsSha256: admission.candidateInputsSha256,
      executionToolchainSha256: admission.executionToolchainSha256,
    }));
    expect(begin).toHaveBeenCalledTimes(1);
    expect(runSemanticProofSandbox).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledWith(expect.objectContaining({
      terminalEnvelope: expect.objectContaining({
        schema: "ccc-prd.proof-terminal-envelope.v2",
        kind: "verified",
        proofId: f.proof.id,
        phase: "task",
        passed: true,
        evidenceSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    }));
  });

  it("RED-S5-sealed-toolchain-wiring: preflights and launches with materialized sealed toolchain paths only", async () => {
    const f = await fixture();
    const admission = f.proof.admission!;
    const originalTask = f.proof.executionToolchain.task.executablePath;
    const originalNode = f.proof.executionToolchain.node.executablePath;
    const sealedTask = join(f.repo, "..", "sealed-toolchain", "bin", "task");
    const sealedNode = join(f.repo, "..", "sealed-toolchain", "bin", "node");
    const sealedProofHost = join(f.repo, "..", "sealed-toolchain", "proof-host.mjs");
    const attempts = attemptApi();
    const verifySemanticProofToolchain = vi.fn(async (toolchain: CccPrdProofV2["executionToolchain"]) => {
      expect(toolchain.task.executablePath).toBe(sealedTask);
      expect(toolchain.node.executablePath).toBe(sealedNode);
      expect(toolchain.proofHost.executablePath).toBe(sealedProofHost);
    });
    const preflightSemanticProofSandbox = vi.fn(async (policy: {
      taskExecutable: string;
      nodeExecutable: string;
    }) => {
      expect(policy.taskExecutable).toBe(sealedTask);
      expect(policy.nodeExecutable).toBe(sealedNode);
    });
    const runSemanticProofSandbox = vi.fn(async (policy: {
      taskExecutable: string;
      nodeExecutable: string;
      executable: string;
    }) => {
      expect(policy.taskExecutable).toBe(sealedTask);
      expect(policy.nodeExecutable).toBe(sealedNode);
      expect(policy.executable).toBe(sealedTask);
      const stdout = `${canonicalCccPrdJson(evidenceFor(f, true))}\n`;
      return processResult(stdout);
    });
    const handler = createCccCampaignProofSuiteHandler({
      rootDir: f.repo,
      store: {
        getTask: async () => f.task,
        getCccCampaignContextForTask: async () => f.campaign,
        getAsyncLayer: () => ({}) as never,
        assertCccCampaignWorkflowLeaseFence: async () => undefined,
      },
      semanticProofAttempts: attempts,
      materializeSemanticProof: async ({ outputRoot }: { outputRoot: string }) => ({
        proofRoot: join(outputRoot, "proof"),
        scratchRoot: join(outputRoot, "scratch"),
        taskTarget: "verify:value",
        taskArgv: ["verify:value"],
        closureSha256: admission.verifierClosureSha256,
        candidateInputsSha256: admission.candidateInputsSha256,
        sealedToolchain: {
          taskExecutable: sealedTask,
          nodeExecutable: sealedNode,
          proofHostExecutable: sealedProofHost,
        },
        sealedExecutionToolchain: {
          task: { ...f.proof.executionToolchain.task, executablePath: sealedTask },
          node: { ...f.proof.executionToolchain.node, executablePath: sealedNode },
          proofHost: { ...f.proof.executionToolchain.proofHost, executablePath: sealedProofHost },
        },
      }),
      verifySemanticProofToolchain,
      preflightSemanticProofSandbox,
      runSemanticProofSandbox,
    } as never);

    await expect(handler(f.node, f.context)).resolves.toMatchObject({
      outcome: "success",
      value: "ccc-proof-suite-passed",
    });
    expect(verifySemanticProofToolchain).toHaveBeenCalledTimes(1);
    expect(preflightSemanticProofSandbox).toHaveBeenCalledTimes(1);
    expect(runSemanticProofSandbox).toHaveBeenCalledTimes(1);
    expect(originalTask).not.toBe(sealedTask);
    expect(originalNode).not.toBe(sealedNode);
  });

  it("blocks downstream work when canonical task evidence reports a semantic failure", async () => {
    const f = await fixture();
    const stdout = `${canonicalCccPrdJson(evidenceFor(f, false))}\n`;
    const { handler, attempts } = semanticHandler(f, {
      runSandbox: async () => processResult(stdout, 1),
    });

    await expect(handler(f.node, f.context)).resolves.toEqual({
      outcome: "failure",
      value: `ccc-proof-failed:${f.proof.id}`,
    });
    expect(attempts.settle).toHaveBeenCalledWith(expect.objectContaining({
      terminalEnvelope: expect.objectContaining({
        kind: "verified",
        phase: "task",
        passed: false,
      }),
    }));
  });

  it("durably refuses malformed stdout instead of treating exit zero as proof", async () => {
    const f = await fixture();
    const stdout = "{}\n";
    const { handler, attempts } = semanticHandler(f, {
      runSandbox: async () => processResult(stdout),
    });

    await expect(handler(f.node, f.context)).resolves.toEqual({
      outcome: "failure",
      value: `ccc-proof-failed:${f.proof.id}`,
    });
    expect(attempts.settle).toHaveBeenCalledWith(expect.objectContaining({
      terminalEnvelope: expect.objectContaining({
        kind: "execution_refused",
        code: "malformed_output",
      }),
    }));
  });

  it.each([
    ["timeout", { timedOut: true, killed: true }],
    ["killed", { killed: true }],
    ["no_output", {}],
    ["output_over_limit", { outputOverLimit: true, killed: true }],
    ["spawn_refused", { spawnError: "spawn failed" }],
  ] as const)("settles the %s process terminal with its exact stable refusal code", async (
    code,
    overrides,
  ) => {
    const f = await fixture();
    const { handler, attempts } = semanticHandler(f, {
      runSandbox: async () => ({ ...processResult("", null), ...overrides }),
    });

    await expect(handler(f.node, f.context)).resolves.toEqual({
      outcome: "failure",
      value: `ccc-proof-failed:${f.proof.id}`,
    });
    expect(attempts.settle).toHaveBeenCalledWith(expect.objectContaining({
      terminalEnvelope: expect.objectContaining({ kind: "execution_refused", code }),
    }));
  });

  it("settles a post-preflight sandbox launch refusal without inventing evidence", async () => {
    const f = await fixture();
    const { handler, attempts } = semanticHandler(f, {
      runSandbox: async () => {
        throw new Error("sandbox backend refused launch");
      },
    });

    await expect(handler(f.node, f.context)).resolves.toEqual({
      outcome: "failure",
      value: `ccc-proof-failed:${f.proof.id}`,
    });
    expect(attempts.settle).toHaveBeenCalledWith(expect.objectContaining({
      terminalEnvelope: expect.objectContaining({
        kind: "execution_refused",
        code: "sandbox_refused",
      }),
    }));
  });

  it("RED-S5-temp-cleanup-symlink: does not chmod an external target through a scratch symlink", async () => {
    const f = await fixture();
    const admission = f.proof.admission!;
    const externalRoot = await mkdtemp(join(tmpdir(), "ccc-semantic-proof-external-"));
    scratchRoots.push(externalRoot);
    const externalTarget = join(externalRoot, "target.txt");
    await writeFile(externalTarget, "external\n");
    await chmod(externalTarget, 0o444);
    const attempts = attemptApi();
    const stdout = `${canonicalCccPrdJson(evidenceFor(f, true))}\n`;
    const handler = createCccCampaignProofSuiteHandler({
      rootDir: f.repo,
      store: {
        getTask: async () => f.task,
        getCccCampaignContextForTask: async () => f.campaign,
        getAsyncLayer: () => ({}) as never,
        assertCccCampaignWorkflowLeaseFence: async () => undefined,
      },
      semanticProofAttempts: attempts,
      materializeSemanticProof: async ({ outputRoot }: { outputRoot: string }) => {
        const materialized = materializedFixture(outputRoot, admission, f.proof.executionToolchain);
        await mkdir(materialized.scratchRoot, { recursive: true });
        await symlink(externalTarget, join(materialized.scratchRoot, "external-link"));
        return materialized;
      },
      verifySemanticProofToolchain: async () => undefined,
      preflightSemanticProofSandbox: async () => undefined,
      runSemanticProofSandbox: async () => processResult(stdout),
    } as never);

    await expect(handler(f.node, f.context)).resolves.toMatchObject({
      outcome: "success",
      value: "ccc-proof-suite-passed",
    });
    expect((await lstat(externalTarget)).mode & 0o777).toBe(0o444);
  });

  it("refuses sealed toolchain drift before reserving, beginning, or spawning", async () => {
    const f = await fixture();
    const attempts = attemptApi();
    const { handler, runSandbox } = semanticHandler(f, {
      attempts,
      verifyToolchain: async () => {
        throw new Error("tool bytes differ from admitted identity");
      },
    });

    await expect(handler(f.node, f.context)).rejects.toMatchObject({
      code: "CCC_CAMPAIGN_PROOF_CUSTODY_REFUSED",
    });
    expect(attempts.reserve).not.toHaveBeenCalled();
    expect(attempts.begin).not.toHaveBeenCalled();
    expect(runSandbox).not.toHaveBeenCalled();
    expect(attempts.settle).not.toHaveBeenCalled();
  });

  it("rechecks the app-clock deadline after persisted replay lookup and refuses before dispatch", async () => {
    const f = await fixture();
    const now = new Date("2026-08-13T08:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const attempts = attemptApi();
    const campaign = {
      ...f.campaign,
      campaignDeadlineAt: new Date(now.getTime() + 1_000).toISOString(),
    } as CccCampaignTaskContext;
    const admission = f.proof.admission!;
    const runSandbox = vi.fn(async () => processResult(""));
    const handler = createCccCampaignProofSuiteHandler({
      rootDir: f.repo,
      store: {
        getTask: async () => f.task,
        getCccCampaignContextForTask: async () => campaign,
        getAsyncLayer: () => ({}) as never,
        assertCccCampaignWorkflowLeaseFence: async () => undefined,
      },
      semanticProofAttempts: attempts,
      materializeSemanticProof: async ({ outputRoot }) =>
        materializedFixture(outputRoot, admission, f.proof.executionToolchain),
      verifySemanticProofToolchain: async () => {
        vi.setSystemTime(new Date(now.getTime() + 2_000));
      },
      preflightSemanticProofSandbox: async () => undefined,
      runSemanticProofSandbox: runSandbox,
    });

    try {
      await expect(handler(f.node, f.context)).rejects.toMatchObject({
        code: "CCC_CAMPAIGN_PROOF_DEADLINE_EXPIRED",
        message: "CCC campaign proof deadline has expired",
      });
      expect(attempts.reserve).toHaveBeenCalledTimes(1);
      expect(attempts.begin).not.toHaveBeenCalled();
      expect(runSandbox).not.toHaveBeenCalled();
      expect(attempts.settle).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("refreshes the verifier timeout after preflight instead of spending stale campaign time", async () => {
    const f = await fixture();
    const now = new Date("2026-08-13T08:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    Object.assign(f.campaign, {
      campaignDeadlineAt: new Date(now.getTime() + 10_000).toISOString(),
    });
    const attempts = attemptApi();
    const { handler, runSandbox } = semanticHandler(f, {
      attempts,
      verifyToolchain: async () => {
        vi.setSystemTime(new Date(now.getTime() + 4_000));
      },
    });

    try {
      await expect(handler(f.node, f.context)).resolves.toMatchObject({
        outcome: "success",
        value: "ccc-proof-suite-passed",
      });
      expect(attempts.reserve).toHaveBeenCalledTimes(1);
      expect(runSandbox).toHaveBeenCalledWith(expect.objectContaining({
        timeoutMs: 6_000,
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("rechecks the campaign deadline after reservation and refuses before beginning dispatch", async () => {
    const f = await fixture();
    const now = new Date("2026-08-13T08:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    Object.assign(f.campaign, {
      campaignDeadlineAt: new Date(now.getTime() + 1_000).toISOString(),
    });
    const attempts = attemptApi();
    attempts.reserve.mockImplementationOnce(async () => {
      vi.setSystemTime(new Date(now.getTime() + 2_000));
      return {
        attemptKey: "ccc-proof-attempt-v2",
        controllerToken: "ccc-proof-controller-v2",
        state: "reserved" as const,
      };
    });
    const { handler, runSandbox } = semanticHandler(f, { attempts });

    try {
      await expect(handler(f.node, f.context)).rejects.toThrow(/deadline has expired/);
      expect(attempts.reserve).toHaveBeenCalledTimes(1);
      expect(attempts.begin).not.toHaveBeenCalled();
      expect(runSandbox).not.toHaveBeenCalled();
      expect(attempts.settle).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("RED-S5-db-deadline translates a database-clock reservation refusal into a stable permanent campaign hold", async () => {
    const f = await fixture();
    const attempts = attemptApi();
    attempts.reserve.mockRejectedValueOnce(new CccCampaignProofAttemptLimitError(
      "deadline",
      "CCC campaign proof deadline has expired",
    ));
    const { handler, runSandbox } = semanticHandler(f, { attempts });

    await expect(handler(f.node, f.context)).rejects.toMatchObject({
      code: "CCC_CAMPAIGN_PROOF_DEADLINE_EXPIRED",
      message: "CCC campaign proof deadline has expired",
    });
    expect(attempts.reserve).toHaveBeenCalledTimes(1);
    expect(attempts.begin).not.toHaveBeenCalled();
    expect(runSandbox).not.toHaveBeenCalled();
    expect(attempts.settle).not.toHaveBeenCalled();
  });

  it("RED-S5-db-deadline translates a database-clock begin refusal without stranding a false dispatched effect", async () => {
    const f = await fixture();
    const attempts = attemptApi();
    attempts.begin.mockRejectedValueOnce(new CccCampaignProofAttemptLimitError(
      "deadline",
      "CCC campaign proof deadline has expired",
    ));
    const { handler, runSandbox } = semanticHandler(f, { attempts });

    await expect(handler(f.node, f.context)).rejects.toMatchObject({
      code: "CCC_CAMPAIGN_PROOF_DEADLINE_EXPIRED",
      message: "CCC campaign proof deadline has expired",
    });
    expect(attempts.reserve).toHaveBeenCalledTimes(1);
    expect(attempts.begin).toHaveBeenCalledTimes(1);
    expect(runSandbox).not.toHaveBeenCalled();
    expect(attempts.settle).not.toHaveBeenCalled();
  });

  it("settles a dispatched proof after the deadline so its durable effect is not stranded", async () => {
    const f = await fixture();
    const now = new Date("2026-08-13T08:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    Object.assign(f.campaign, {
      campaignDeadlineAt: new Date(now.getTime() + 1_000).toISOString(),
    });
    const attempts = attemptApi();
    const stdout = `${canonicalCccPrdJson(evidenceFor(f, true))}\n`;
    const { handler } = semanticHandler(f, {
      attempts,
      runSandbox: async () => {
        vi.setSystemTime(new Date(now.getTime() + 2_000));
        return processResult(stdout);
      },
    });

    try {
      await expect(handler(f.node, f.context)).resolves.toMatchObject({
        outcome: "success",
        value: "ccc-proof-suite-passed",
      });
      expect(attempts.begin).toHaveBeenCalledTimes(1);
      expect(attempts.settle).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reserves the exact final-integrated phase for the final proof suite", async () => {
    const f = await fixture();
    const finalNode = {
      ...f.node,
      id: "final-proof-suite",
      config: {
        cccProofSuite: true,
        cccProofPhase: "final_integrated",
        cccProofIds: [f.proof.id],
        cccPrdTaskIds: [f.campaign.semanticTaskId],
        cccNativeTaskIds: [f.task.id],
        cccPrdTaskId: f.campaign.semanticTaskId,
        cccNativeTaskId: f.task.id,
      },
    } as WorkflowIrNode;
    const finalContext = {
      ...f.context,
      execution: {
        ...(f.context as { execution: Record<string, unknown> }).execution,
        visitIdentity: { nodeId: finalNode.id, materializedNodeId: finalNode.id },
      },
    } as never;
    const stdout = `${canonicalCccPrdJson(evidenceFor(f, true, "final_integrated"))}\n`;
    const { handler, attempts } = semanticHandler(f, {
      runSandbox: async () => processResult(stdout),
    });

    await expect(handler(finalNode, finalContext)).resolves.toMatchObject({
      outcome: "success",
      contextPatch: { "ccc:proof:phase": "final_integrated" },
    });
    expect(attempts.reserve).toHaveBeenCalledWith(expect.objectContaining({
      attemptContractVersion: "v2",
      phase: "final_integrated",
      sourceCommit: f.sourceCommit,
      sourceTree: f.sourceTree,
    }));
  });

  it("replays a committed terminal attempt without beginning or spawning again", async () => {
    const f = await fixture();
    const attempts = attemptApi();
    attempts.reserve.mockResolvedValueOnce({
      attemptKey: "ccc-proof-attempt-v2",
      controllerToken: "ccc-proof-controller-v2",
      state: "committed",
    });
    const { handler, runSandbox } = semanticHandler(f, { attempts });

    await expect(handler(f.node, f.context)).resolves.toMatchObject({
      outcome: "success",
      value: "ccc-proof-suite-passed",
    });
    expect(attempts.begin).not.toHaveBeenCalled();
    expect(runSandbox).not.toHaveBeenCalled();
    expect(attempts.settle).not.toHaveBeenCalled();
  });

  it("RED-S5-db-deadline replays an exact committed terminal receipt after campaign expiry", async () => {
    const f = await fixture();
    const now = new Date("2026-08-13T08:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    Object.assign(f.campaign, {
      campaignDeadlineAt: new Date(now.getTime() - 1_000).toISOString(),
    });
    const attempts = attemptApi();
    attempts.reserve.mockResolvedValueOnce({
      attemptKey: "ccc-proof-attempt-v2",
      controllerToken: "ccc-proof-controller-v2",
      state: "committed" as const,
    });
    const { handler, runSandbox } = semanticHandler(f, { attempts });

    try {
      await expect(handler(f.node, f.context)).resolves.toMatchObject({
        outcome: "success",
        value: "ccc-proof-suite-passed",
      });
      expect(attempts.reserve).toHaveBeenCalledTimes(1);
      expect(attempts.begin).not.toHaveBeenCalled();
      expect(runSandbox).not.toHaveBeenCalled();
      expect(attempts.settle).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  itSemanticHost("runs the real admitted Task and Node toolchain inside the semantic sandbox", async () => {
    const f = await fixture();
    const proof = await liveAdmittedProof(f);
    const campaign = { ...f.campaign, proofs: [proof] } as CccCampaignTaskContext;
    const attempts = attemptApi();
    const handler = createCccCampaignProofSuiteHandler({
      rootDir: f.repo,
      store: {
        getTask: async () => f.task,
        getCccCampaignContextForTask: async () => campaign,
        getAsyncLayer: () => ({}) as never,
        assertCccCampaignWorkflowLeaseFence: async () => undefined,
      },
      semanticProofAttempts: attempts,
    });

    await expect(handler(f.node, f.context)).resolves.toMatchObject({
      outcome: "success",
      value: "ccc-proof-suite-passed",
      contextPatch: {
        "ccc:proof:source-commit": f.sourceCommit,
        "ccc:proof:source-tree": f.sourceTree,
        "ccc:proof:phase": "task",
      },
    });
    expect(attempts.settle).toHaveBeenCalledWith(expect.objectContaining({
      terminalEnvelope: expect.objectContaining({
        kind: "verified",
        passed: true,
        evidence: expect.objectContaining({
          proofId: proof.id,
          phase: "task",
          sourceCommit: f.sourceCommit,
          sourceTree: f.sourceTree,
        }),
      }),
    }));
  });

  itSemanticHost("refuses a verifier closure owned by any campaign task before reservation", async () => {
    const f = await fixture();
    const proof = await liveAdmittedProof(f);
    const currentRoutes = f.campaign.executionPolicy.routes;
    const campaign = {
      ...f.campaign,
      proofs: [proof],
      executionPolicy: {
        ...f.campaign.executionPolicy,
        routes: [...currentRoutes, {
          ...currentRoutes[0]!,
          taskId: "TASK-verifier-owner",
          ownedPaths: ["proof"],
          allowedWriteRoots: ["proof/generated"],
        }],
      },
    } as CccCampaignTaskContext;
    const attempts = attemptApi();
    const handler = createCccCampaignProofSuiteHandler({
      rootDir: f.repo,
      store: {
        getTask: async () => f.task,
        getCccCampaignContextForTask: async () => campaign,
        getAsyncLayer: () => ({}) as never,
        assertCccCampaignWorkflowLeaseFence: async () => undefined,
      },
      semanticProofAttempts: attempts,
    });

    await expect(handler(f.node, f.context)).rejects.toMatchObject({
      code: "CCC_CAMPAIGN_PROOF_CUSTODY_REFUSED",
    });
    expect(attempts.reserve).not.toHaveBeenCalled();
    expect(attempts.begin).not.toHaveBeenCalled();
    expect(attempts.settle).not.toHaveBeenCalled();
  });
});
