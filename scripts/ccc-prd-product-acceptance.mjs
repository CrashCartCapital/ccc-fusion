#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createRequire } from "node:module";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { workItemHasCccPermanentReason } from "./lib/ccc-permanent-reason.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const requireCoreDependency = createRequire(
  path.join(repoRoot, "packages/core/package.json"),
);
const postgres = requireCoreDependency("postgres");
const cliBin = path.join(repoRoot, "packages/cli/bin.mjs");
const expectedChecks = Object.freeze([
  "built-cli-current-run",
  "current-prd-corpus-manifest",
  "current-prd-discovered-and-frozen",
  "guided-operator-context-frozen",
  "planted-defect-rejected",
  "native-local-understanding-review",
  "understanding-fast-lane-preserved",
  "chunked-understanding-complete-coverage",
  "chunked-understanding-compile-gates",
  "native-local-authoring",
  "semantic-v2-authority-contract",
  "legacy-v1-readable-fresh-product-refused",
  "frozen-packet-validated",
  "product-owned-execution-plan",
  "per-task-route-profiles",
  "forged-provenance-refused-without-residue",
  "exact-preview-confirmed",
  "wrong-confirmation-refused-without-residue",
  "operator-lifecycle-controls",
  "provider-dispatch-restart-manual-required",
  "proof-dispatch-restart-manual-required",
  "campaign-import-admitted",
  "import-restart-recovery",
  "live-execution-human-hold",
  "single-campaign-execution-authorization",
  "task-phase-proofs-committed",
  "coding-route-and-worktree-custody",
  "chained-task-worktree-custody",
  "campaign-created-commit",
  "commit-bound-proof-executed",
  "integrated-proof-over-two-commits",
  "final-integrated-proof-committed",
  "merge-human-hold",
  "operator-readable-status",
  "git-landing-restart-no-repeated-effect",
  "controlled-landing",
  "terminal-restart-recovery",
  "fanout-campaign-import-admitted",
  "fanout-join-execution-proved",
]);
const commandTimeoutMs = 180_000;
const productTimeoutMs = Number(process.env.FUSION_PRODUCT_TIMEOUT_MS ?? 120_000);
// Campaign time includes cold CLI/session/sandbox setup before a pollable
// provider or proof effect exists. Keep one full product-poll window of
// headroom so a clean post-merge checkout cannot expire at the cutpoint.
const verticalCampaignMaxDurationMs = 240_000;
const verticalCampaignMaxRequests = 4;
const shutdownTimeoutMs = 15_000;
const proofCutpointMarkerName = "ccc-proof-cutpoint.marker.json";
const proofCutpointCandidateValue = "good-proof-cutpoint";

// The series-parallel lane: TASK-FAN-A -> {TASK-FAN-B, TASK-FAN-C} ->
// TASK-FAN-D. One owned file per task, planted "pending" at the frozen
// baseline; the join task's worktree history must merge BOTH branch commits
// before the campaign-wide proof can see all four final values at once.
const fanTasks = Object.freeze([
  Object.freeze({
    taskId: "TASK-FAN-A",
    requirementId: "REQ-FAN-A",
    actionId: "ACTION-FAN-A-LIVE",
    file: "src/fan-a.txt",
    value: "alpha",
    dependencyTaskIds: Object.freeze([]),
    role: "entry",
  }),
  Object.freeze({
    taskId: "TASK-FAN-B",
    requirementId: "REQ-FAN-B",
    actionId: "ACTION-FAN-B-LIVE",
    file: "src/fan-b.txt",
    value: "beta",
    dependencyTaskIds: Object.freeze(["TASK-FAN-A"]),
    role: "branch",
  }),
  Object.freeze({
    taskId: "TASK-FAN-C",
    requirementId: "REQ-FAN-C",
    actionId: "ACTION-FAN-C-LIVE",
    file: "src/fan-c.txt",
    value: "gamma",
    dependencyTaskIds: Object.freeze(["TASK-FAN-A"]),
    role: "branch",
  }),
  Object.freeze({
    taskId: "TASK-FAN-D",
    requirementId: "REQ-FAN-D",
    actionId: "ACTION-FAN-D-LIVE",
    file: "src/fan-d.txt",
    value: "delta-joined",
    dependencyTaskIds: Object.freeze(["TASK-FAN-B", "TASK-FAN-C"]),
    role: "join",
  }),
]);
const fanoutCampaignMaxRequests = fanTasks.length * 4;
const fanoutCampaignMaxDurationMs = 480_000;

const fanoutClauseIdFor = (fanTask) =>
  `AC-${fanTask.requirementId}-001`;
const fanoutTaskProofIdFor = (fanTask) =>
  `PROOF-${fanTask.taskId.slice("TASK-".length)}-TASK`;
const fanoutTaskProofCommandFor = (fanTask) =>
  `task verify:${fanTask.taskId.slice("TASK-".length).toLowerCase()}`;

const semanticProofPlaceholderSha256 = "0".repeat(64);
const semanticProofPlaceholderGitOid = "0".repeat(40);
const executableSha256ByCanonicalPath = new Map();

async function executableSha256(canonicalPath) {
  if (!executableSha256ByCanonicalPath.has(canonicalPath)) {
    executableSha256ByCanonicalPath.set(
      canonicalPath,
      sha256(await readFile(canonicalPath)),
    );
  }
  return executableSha256ByCanonicalPath.get(canonicalPath);
}

function semanticProofProposal(input) {
  return {
    schema: "ccc-prd.proof.v2",
    id: input.id,
    requirementIds: [...input.requirementIds],
    clauseIds: [...input.clauseIds],
    phases: [...input.phases],
    command: input.command,
    positiveOracle: input.positiveOracle,
    positiveCases: input.positiveCases.map((entry) => ({ ...entry })),
    negativeControls: input.negativeControls.map((entry) => ({ ...entry })),
    verifierClosure: [
      {
        role: "task_runner",
        path: "Taskfile.yml",
        baseGitBlobOid: semanticProofPlaceholderGitOid,
        sha256: semanticProofPlaceholderSha256,
      },
      {
        role: "harness",
        path: input.harnessPath,
        baseGitBlobOid: semanticProofPlaceholderGitOid,
        sha256: semanticProofPlaceholderSha256,
      },
    ],
    candidateInputs: [...input.candidateInputs],
    // The model must return the complete v2 shape, but none of these values
    // carry authority. Normal CLI authoring replaces them with direct
    // controller observations before admission and persistence.
    executionToolchain: {
      task: {
        executablePath: "/model-untrusted/task",
        executableSha256: semanticProofPlaceholderSha256,
        version: "model-untrusted",
        versionOutputSha256: semanticProofPlaceholderSha256,
      },
      node: {
        executablePath: "/model-untrusted/node",
        executableSha256: semanticProofPlaceholderSha256,
        version: "model-untrusted",
        versionOutputSha256: semanticProofPlaceholderSha256,
      },
      proofHost: {
        id: "model-untrusted-proof-host",
        executablePath: "/model-untrusted/proof-host",
        executableSha256: semanticProofPlaceholderSha256,
        version: "model-untrusted",
        versionOutputSha256: semanticProofPlaceholderSha256,
      },
      linkedRuntime: [],
    },
    sourceRefs: input.sourceRefs.map((entry) => ({ ...entry })),
    confidence: "high",
  };
}

function legacyV1ProposalFromV2(proposal) {
  return {
    ...proposal,
    schema: "ccc-prd.authoring-proposal.v1",
    requirements: proposal.requirements.map((requirement) => {
      const {
        acceptanceClauses: _acceptanceClauses,
        acceptanceDispositions: _acceptanceDispositions,
        ...legacyRequirement
      } = requirement;
      return legacyRequirement;
    }),
    proofs: proposal.proofs.map((proof) => {
      const {
        schema: _schema,
        clauseIds: _clauseIds,
        phases: _phases,
        positiveCases: _positiveCases,
        verifierClosure: _verifierClosure,
        candidateInputs: _candidateInputs,
        executionToolchain: _executionToolchain,
        negativeControls,
        ...legacyProof
      } = proof;
      return {
        ...legacyProof,
        negativeControls: negativeControls.map(({ description }) => description),
      };
    }),
  };
}

class AcceptanceLedger {
  constructor(expected) {
    this.expected = [...expected];
    this.expectedSet = new Set(expected);
    this.entries = new Map();
  }

  pass(id, evidence) {
    if (!this.expectedSet.has(id)) {
      throw new Error(`CCC_PRODUCT_EXTRA_CHECK: ${id}`);
    }
    if (this.entries.has(id)) {
      throw new Error(`CCC_PRODUCT_DUPLICATE_CHECK: ${id}`);
    }
    this.entries.set(id, {
      id,
      observedAt: new Date().toISOString(),
      evidence,
    });
  }

  finalize() {
    const missing = this.expected.filter((id) => !this.entries.has(id));
    const extra = [...this.entries.keys()].filter((id) => !this.expectedSet.has(id));
    if (missing.length > 0 || extra.length > 0) {
      throw new Error(
        `CCC_PRODUCT_CHECK_SET_MISMATCH: missing=${JSON.stringify(missing)} extra=${JSON.stringify(extra)}`,
      );
    }
    const ordered = this.expected.map((id) => this.entries.get(id));
    if (ordered.some((entry) => !entry)) {
      throw new Error("CCC_PRODUCT_SKIPPED_CHECK: ordered proof ledger is incomplete");
    }
    return ordered;
  }
}

class CommandFailure extends Error {
  constructor(command, result) {
    super(
      `${command} exited ${result.code ?? `signal ${result.signal}`}`
      + `\nstdout:\n${tail(result.stdout)}`
      + `\nstderr:\n${tail(result.stderr)}`,
    );
    this.name = "CommandFailure";
    this.result = result;
  }
}

function tail(value, lines = 120) {
  return String(value ?? "").split("\n").slice(-lines).join("\n");
}

function sha256(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalJson(value) {
  const normalize = (candidate) => {
    if (Array.isArray(candidate)) return candidate.map(normalize);
    if (candidate && typeof candidate === "object") {
      return Object.fromEntries(
        Object.keys(candidate).sort().map((key) => [key, normalize(candidate[key])]),
      );
    }
    return candidate;
  };
  return JSON.stringify(normalize(value));
}

function finalProofReceiptProjection(receipt) {
  return {
    attemptKey: receipt.attemptKey,
    attemptContractVersion: receipt.attemptContractVersion,
    phase: receipt.phase,
    taskId: receipt.taskId,
    semanticTaskId: receipt.semanticTaskId,
    proofId: receipt.proofId,
    packetHash: receipt.packetHash,
    sidecarHash: receipt.sidecarHash,
    bundleHash: receipt.bundleHash,
    manifestHash: receipt.manifestHash,
    campaignBindingHash: receipt.campaignBindingHash,
    targetRepository: receipt.targetRepository,
    targetBase: receipt.targetBase,
    sourceCommit: receipt.sourceCommit,
    sourceTree: receipt.sourceTree,
    definitionSha256: receipt.definitionSha256,
    commandSha256: receipt.commandSha256,
    workItemId: receipt.workItemId,
    runId: receipt.runId,
    workItemAttempt: receipt.workItemAttempt,
    verifierClosureSha256: receipt.verifierClosureSha256,
    candidateInputsSha256: receipt.candidateInputsSha256,
    executionToolchainSha256: receipt.executionToolchainSha256,
    terminalEnvelopeSha256: receipt.terminalEnvelopeSha256,
    proofEvidenceSha256: receipt.proofEvidenceSha256,
  };
}

function finalProofReceiptSetSha256(sourceCommit, sourceTree, receipts) {
  return sha256(canonicalJson({
    schema: "ccc-campaign.final-proof-receipt-set.v2",
    phase: "final_integrated",
    sourceCommit,
    sourceTree,
    receipts: receipts.map(finalProofReceiptProjection),
  }));
}

function changedPathsSha256(paths) {
  return sha256(JSON.stringify([...paths].sort()));
}

function assert(condition, code, detail) {
  if (!condition) {
    throw new Error(`${code}: ${detail}`);
  }
}

async function pathExists(candidate) {
  try {
    await stat(candidate);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function directorySnapshot(root, relativeRoot = "") {
  const entries = [];
  const names = await readdir(path.join(root, relativeRoot), {
    withFileTypes: true,
  });
  names.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of names) {
    const relativePath = relativeRoot
      ? path.join(relativeRoot, entry.name)
      : entry.name;
    if (entry.isDirectory()) {
      entries.push(`directory:${relativePath}`);
      entries.push(...await directorySnapshot(root, relativePath));
      continue;
    }
    assert(
      entry.isFile(),
      "CCC_PRODUCT_RESIDUE_SNAPSHOT_UNSUPPORTED_ENTRY",
      relativePath,
    );
    entries.push(
      `file:${relativePath}:sha256:${sha256(await readFile(path.join(root, relativePath)))}`,
    );
  }
  return entries;
}

function exactArray(actual, expected, code) {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    code,
    `expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
  );
}

function assertExactAcceptanceClauseGrammar(source, proposal, code) {
  const lines = source.split("\n");
  const expectedClauseLines = [];
  for (const requirement of proposal.requirements ?? []) {
    assert(
      requirement.acceptanceClauses?.length === 1,
      code,
      JSON.stringify({
        requirementId: requirement.id,
        acceptanceClauses: requirement.acceptanceClauses,
      }),
    );
    const clause = requirement.acceptanceClauses[0];
    const headingIndex = lines.indexOf(`### Requirement ${requirement.id}`);
    const clauseLine = `- [${clause.id}] ${clause.text}`;
    assert(
      headingIndex >= 0
      && lines[headingIndex + 2] === "#### Acceptance clauses"
      && lines[headingIndex + 3] === clauseLine
      && lines[headingIndex + 4] === "#### Proof declaration",
      code,
      JSON.stringify({
        requirementId: requirement.id,
        headingIndex,
        observed: lines.slice(headingIndex, headingIndex + 5),
        expectedClauseLine: clauseLine,
      }),
    );
    expectedClauseLines.push(clauseLine);
  }
  exactArray(
    lines.filter((line) => /^- \[AC-[A-Z0-9-]+\] /u.test(line)),
    expectedClauseLines,
    code,
  );
}

function exactProofStatus(status, proofId) {
  const matches = (status.proofs ?? []).filter(
    ({ definition }) => definition.id === proofId,
  );
  assert(
    matches.length === 1,
    "CCC_PRODUCT_EXACT_PROOF_STATUS_MISSING",
    JSON.stringify({
      proofId,
      matches: matches.length,
      observed: (status.proofs ?? []).map(({ definition }) => definition.id),
    }),
  );
  return matches[0];
}

function assertPassingSemanticProofAttempt(attempt, expected, code) {
  const evidence = attempt?.proofEvidence;
  const envelope = attempt?.terminalEnvelope;
  const expectedClauses = [...expected.clauseIds].sort().map((clauseId) => ({
    clauseId,
    passed: true,
  }));
  const expectedCases = [...expected.caseIds].sort().map((caseId) => ({
    caseId,
    passed: true,
  }));
  const expectedControls = [...expected.controlIds].sort().map((controlId) => ({
    controlId,
    passed: true,
  }));
  const expectedChangedPathsSha256 = changedPathsSha256(
    expected.mutationPaths,
  );
  assert(
    attempt?.attemptContractVersion === "v2"
    && attempt.phase === expected.phase
    && attempt.state === "committed"
    && attempt.sourceCommit === expected.sourceCommit
    && attempt.sourceTree === expected.sourceTree
    && attempt.result?.success === true
    && attempt.result?.exitCode === 0
    && attempt.result?.changedPathsSha256 === expectedChangedPathsSha256
    && /^[0-9a-f]{64}$/u.test(attempt.verifierClosureSha256 ?? "")
    && /^[0-9a-f]{64}$/u.test(attempt.candidateInputsSha256 ?? "")
    && /^[0-9a-f]{64}$/u.test(attempt.executionToolchainSha256 ?? "")
    && /^[0-9a-f]{64}$/u.test(attempt.terminalEnvelopeSha256 ?? "")
    && /^[0-9a-f]{64}$/u.test(attempt.proofEvidenceSha256 ?? "")
    && envelope?.schema === "ccc-prd.proof-terminal-envelope.v2"
    && envelope.kind === "verified"
    && envelope.proofId === expected.proofId
    && envelope.phase === expected.phase
    && envelope.sourceCommit === expected.sourceCommit
    && envelope.sourceTree === expected.sourceTree
    && envelope.passed === true
    && envelope.evidenceSha256 === attempt.proofEvidenceSha256
    && canonicalJson(envelope.evidence) === canonicalJson(evidence)
    && sha256(canonicalJson(envelope)) === attempt.terminalEnvelopeSha256
    && sha256(canonicalJson(evidence)) === attempt.proofEvidenceSha256
    && envelope.exitCode === 0
    && envelope.timedOut === false
    && envelope.killed === false
    && envelope.changedPathsSha256 === expectedChangedPathsSha256
    && evidence?.schema === "ccc-prd.proof-evidence.v2"
    && evidence.proofId === expected.proofId
    && evidence.phase === expected.phase
    && evidence.sourceCommit === expected.sourceCommit
    && evidence.sourceTree === expected.sourceTree
    && evidence.passed === true
    && JSON.stringify(evidence.clauseResults) === JSON.stringify(expectedClauses)
    && JSON.stringify(evidence.positiveCaseResults) === JSON.stringify(expectedCases)
    && JSON.stringify(evidence.negativeControlResults)
      === JSON.stringify(expectedControls)
    && new Date(attempt.settledAt).getTime()
      >= new Date(attempt.dispatchedAt).getTime(),
    code,
    JSON.stringify({ attempt, expected }),
  );
}

async function assertControllerHydratedProofCustody(input) {
  const {
    proof,
    targetRoot,
    targetBase,
    command,
    phase,
    harnessPath,
    candidateInputs,
  } = input;
  const expectedClosure = [
    { role: "task_runner", path: "Taskfile.yml" },
    { role: "harness", path: harnessPath },
  ];
  assert(
    proof?.schema === "ccc-prd.proof.v2"
    && proof.command === command
    && JSON.stringify(proof.phases) === JSON.stringify([phase])
    && JSON.stringify(proof.candidateInputs) === JSON.stringify(candidateInputs)
    && JSON.stringify(
      proof.verifierClosure?.map(({ role, path: closurePath }) => ({
        role,
        path: closurePath,
      })),
    ) === JSON.stringify(expectedClosure),
    "CCC_PRODUCT_CONTROLLER_HYDRATED_PROOF_SHAPE_DRIFT",
    JSON.stringify({ proof, expectedClosure, command, phase, candidateInputs }),
  );
  for (const [index, closure] of proof.verifierClosure.entries()) {
    const expected = expectedClosure[index];
    const absolutePath = path.join(targetRoot, expected.path);
    const metadata = await stat(absolutePath);
    const baseGitBlobOid = await git(
      targetRoot,
      "rev-parse",
      `${targetBase}:${expected.path}`,
    );
    assert(
      metadata.isFile()
      && closure.baseGitBlobOid === baseGitBlobOid
      && closure.sha256 === sha256(await readFile(absolutePath))
      && !candidateInputs.some((candidateInput) =>
        expected.path === candidateInput
        || expected.path.startsWith(`${candidateInput}/`)
        || candidateInput.startsWith(`${expected.path}/`)),
      "CCC_PRODUCT_CONTROLLER_HYDRATED_CLOSURE_DRIFT",
      JSON.stringify({ closure, expected, baseGitBlobOid }),
    );
  }
  const toolchainEntries = Object.entries(proof.executionToolchain ?? {});
  exactArray(
    toolchainEntries.map(([toolName]) => toolName).sort(),
    ["linkedRuntime", "node", "proofHost", "task"],
    "CCC_PRODUCT_CONTROLLER_HYDRATED_TOOLCHAIN_SET_DRIFT",
  );
  for (const toolName of ["task", "node", "proofHost"]) {
    const tool = proof.executionToolchain?.[toolName];
    const canonicalExecutable = await realpath(tool.executablePath);
    assert(
      tool.executablePath === canonicalExecutable
      && tool.executableSha256 === await executableSha256(canonicalExecutable)
      && typeof tool.version === "string"
      && tool.version.length > 0
      && /^[0-9a-f]{64}$/u.test(tool.versionOutputSha256 ?? ""),
      "CCC_PRODUCT_CONTROLLER_HYDRATED_TOOLCHAIN_DRIFT",
      JSON.stringify({ toolName, tool, canonicalExecutable }),
    );
  }
  assert(
    Array.isArray(proof.executionToolchain?.linkedRuntime)
    && proof.executionToolchain.linkedRuntime.every((entry) =>
      entry.platform === "darwin"
      && typeof entry.loaderRole === "string"
      && typeof entry.loaderPath === "string"
      && typeof entry.requestedPath === "string"
      && typeof entry.canonicalPath === "string"
      && /^[0-9a-f]{64}$/u.test(entry.sha256 ?? "")),
    "CCC_PRODUCT_CONTROLLER_HYDRATED_LINKED_RUNTIME_DRIFT",
    JSON.stringify({ linkedRuntime: proof.executionToolchain?.linkedRuntime }),
  );
  const proofHost = proof.executionToolchain?.proofHost;
  const expectedProofHost = await realpath(
    path.join(repoRoot, "packages/cli/dist/ccc-campaign-proof-admission.js"),
  );
  assert(
    proofHost?.id === "fusion-cli-semantic-proof-host.v1"
    && proofHost.executablePath === expectedProofHost,
    "CCC_PRODUCT_CONTROLLER_HYDRATED_PROOF_HOST_DRIFT",
    JSON.stringify({ proofHost, expectedProofHost }),
  );
}

async function run(command, args, options = {}) {
  const allowedExitCodes = new Set(options.allowedExitCodes ?? [0]);
  const timeoutMs = options.timeoutMs ?? commandTimeoutMs;
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repoRoot,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      const result = { code, signal, stdout, stderr, timedOut };
      if (timedOut || code === null || !allowedExitCodes.has(code)) {
        reject(new CommandFailure(`${command} ${args.join(" ")}`, result));
        return;
      }
      resolve(result);
    });
  });
}

function startOwnedCommand(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise((resolve) => {
    child.once("error", (error) => resolve({
      code: null,
      signal: null,
      error,
    }));
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  return {
    child,
    command,
    args: [...args],
    cwd: options.cwd ?? repoRoot,
    exited,
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

async function crashOwnedCommand(owned, requiredCommandFragments) {
  assert(
    owned
      && Number.isSafeInteger(owned.child.pid)
      && owned.child.pid > 1
      && owned.child.exitCode === null
      && owned.child.signalCode === null,
    "CCC_PRODUCT_OWNED_COMMAND_CRASH_TARGET_INVALID",
    JSON.stringify({
      pid: owned?.child?.pid,
      exitCode: owned?.child?.exitCode,
      signalCode: owned?.child?.signalCode,
    }),
  );
  const inspected = await run(
    "/bin/ps",
    ["-p", String(owned.child.pid), "-o", "command="],
    { allowedExitCodes: [0, 1] },
  );
  assert(
    inspected.code === 0
      && requiredCommandFragments.every((fragment) =>
        inspected.stdout.includes(fragment)),
    "CCC_PRODUCT_OWNED_COMMAND_PROCESS_REFUSED",
    JSON.stringify({
      pid: owned.child.pid,
      requiredCommandFragments,
      command: inspected.stdout.trim(),
    }),
  );
  owned.child.kill("SIGKILL");
  const result = await owned.exited;
  assert(
    result.signal === "SIGKILL",
    "CCC_PRODUCT_OWNED_COMMAND_CRASH_SIGNAL_DRIFT",
    JSON.stringify(result),
  );
  return inspected.stdout.trim();
}

async function cleanupOwnedCommand(owned) {
  if (
    !owned
    || owned.child.exitCode !== null
    || owned.child.signalCode !== null
  ) return;
  owned.child.kill("SIGKILL");
  await owned.exited;
}

async function embeddedPostgresConnectionUrl(isolatedHome) {
  const pidPath = path.join(
    isolatedHome,
    ".fusion",
    "embedded-postgres",
    "default",
    "postmaster.pid",
  );
  const observed = await poll(
    "owned embedded PostgreSQL identity",
    async () => {
      if (!await pathExists(pidPath)) return null;
      const lines = (await readFile(pidPath, "utf8")).split("\n");
      return {
        pid: Number.parseInt(lines[0] ?? "", 10),
        port: Number.parseInt(lines[3] ?? "", 10),
      };
    },
    (value) =>
      Number.isSafeInteger(value?.pid)
      && value.pid > 1
      && Number.isSafeInteger(value?.port)
      && value.port > 0
      && value.port <= 65_535,
    undefined,
    shutdownTimeoutMs,
  );
  return `postgresql://postgres:password@localhost:${observed.port}/fusion`;
}

async function readCampaignAuditRows(
  isolatedHome,
  projectId,
  campaignImportId,
) {
  const sql = postgres(
    await embeddedPostgresConnectionUrl(isolatedHome),
    {
      connect_timeout: 10,
      idle_timeout: 30,
      max: 1,
      onnotice: () => undefined,
    },
  );
  try {
    return await sql`
      SELECT
        id,
        timestamp,
        task_id,
        mutation_type,
        metadata
      FROM project.run_audit_events
      WHERE project_id = ${projectId}
        AND campaign_import_id = ${campaignImportId}
      ORDER BY timestamp, id
    `;
  } finally {
    await sql.end({ timeout: 2 });
  }
}

function assertOrderedInstants(left, right, code, detail) {
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  assert(
    Number.isFinite(leftMs)
      && Number.isFinite(rightMs)
      && leftMs <= rightMs,
    code,
    JSON.stringify({ left, right, ...detail }),
  );
}

function exactProviderDispatchAudit(rows, semanticTaskId) {
  const matches = rows.filter((row) =>
    row.mutation_type === "ccc-campaign:provider-attempt:dispatched"
    && row.metadata?.semanticTaskId === semanticTaskId);
  assert(
    matches.length === 1,
    "CCC_PRODUCT_PROVIDER_DISPATCH_AUDIT_NOT_EXACT",
    JSON.stringify({ semanticTaskId, matches }),
  );
  return matches[0];
}

function assertLandingFinalProofCustody(rows, expectedCustody, expectedPhases) {
  const landingRows = rows.filter(({ mutation_type }) =>
    mutation_type.startsWith("ccc-campaign-git-landing:"));
  assert(
    landingRows.length === expectedPhases.length,
    "CCC_PRODUCT_LANDING_PROOF_CUSTODY_COUNT_DRIFT",
    JSON.stringify({ landingRows, expectedPhases }),
  );
  const landingByPhase = Object.fromEntries(
    landingRows.map((row) => [
      row.mutation_type.slice("ccc-campaign-git-landing:".length),
      row,
    ]),
  );
  exactArray(
    Object.keys(landingByPhase).sort(),
    [...expectedPhases].sort(),
    "CCC_PRODUCT_LANDING_PROOF_CUSTODY_PHASE_DRIFT",
  );
  for (const phase of expectedPhases) {
    const metadata = landingByPhase[phase]?.metadata;
    assert(
      metadata?.schema === "ccc-campaign.git-landing.intent.v3"
      && canonicalJson(metadata.finalProofCustody)
        === canonicalJson(expectedCustody),
      "CCC_PRODUCT_LANDING_FINAL_PROOF_CUSTODY_DRIFT",
      JSON.stringify({ phase, metadata, expectedCustody }),
    );
  }
  return landingByPhase;
}

async function armGitLandingTerminalCutpoint(isolatedHome, marker) {
  assert(
    /^cccp-land-[0-9a-f]{8}$/u.test(marker),
    "CCC_PRODUCT_GIT_LANDING_CUTPOINT_MARKER_INVALID",
    marker,
  );
  const sql = postgres(
    await embeddedPostgresConnectionUrl(isolatedHome),
    {
      connect_timeout: 10,
      idle_timeout: 30,
      max: 1,
      onnotice: () => undefined,
    },
  );
  let closed = false;
  await sql`SELECT 1 AS ready`;
  await sql.unsafe(`
    CREATE TABLE public.ccc_product_git_landing_cutpoint_gate (
      singleton boolean PRIMARY KEY CHECK (singleton),
      armed boolean NOT NULL
    )
  `);
  await sql.unsafe(`
    INSERT INTO public.ccc_product_git_landing_cutpoint_gate
      (singleton, armed)
    VALUES (TRUE, TRUE)
  `);
  await sql.unsafe(`
    CREATE FUNCTION public.ccc_product_git_landing_cutpoint()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $ccc_product_cutpoint$
    BEGIN
      IF NEW.mutation_type = 'ccc-campaign-git-landing:terminal'
        AND EXISTS (
          SELECT 1
          FROM public.ccc_product_git_landing_cutpoint_gate
          WHERE singleton = TRUE AND armed = TRUE
        )
      THEN
        PERFORM pg_sleep(120);
      END IF;
      RETURN NEW;
    END
    $ccc_product_cutpoint$
  `);
  await sql.unsafe(`
    CREATE TRIGGER ccc_product_git_landing_cutpoint
    BEFORE INSERT ON project.run_audit_events
    FOR EACH ROW
    EXECUTE FUNCTION public.ccc_product_git_landing_cutpoint()
  `);
  const sleepingBackends = async () => {
    return await sql`
      SELECT
        activity.pid,
        activity.state,
        activity.wait_event_type,
        activity.wait_event
      FROM pg_stat_activity AS activity
      WHERE activity.pid <> pg_backend_pid()
        AND activity.state = 'active'
        AND activity.wait_event_type = 'Timeout'
        AND activity.wait_event = 'PgSleep'
        AND activity.query ILIKE '%run_audit_events%'
      ORDER BY activity.pid
    `;
  };
  const close = async () => {
    if (closed) return;
    closed = true;
    await sql.unsafe(`
      UPDATE public.ccc_product_git_landing_cutpoint_gate
      SET armed = FALSE
      WHERE singleton = TRUE
    `).catch(() => undefined);
    await sql.unsafe(`
      DROP TRIGGER IF EXISTS ccc_product_git_landing_cutpoint
      ON project.run_audit_events
    `).catch(() => undefined);
    await sql.unsafe(`
      DROP FUNCTION IF EXISTS public.ccc_product_git_landing_cutpoint()
    `).catch(() => undefined);
    await sql.unsafe(`
      DROP TABLE IF EXISTS public.ccc_product_git_landing_cutpoint_gate
    `).catch(() => undefined);
    await sql.end({ timeout: 2 }).catch(() => undefined);
  };
  return { sql, marker, sleepingBackends, close };
}

async function settleOwnedLandingDatabaseBackend(cutpoint) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if ((await cutpoint.sleepingBackends()).length === 0) {
      return { forcedTermination: false, backendPid: null };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const activities = await cutpoint.sleepingBackends();
  assert(
    activities.length === 1,
    "CCC_PRODUCT_GIT_LANDING_BACKEND_OWNERSHIP_REFUSED",
    JSON.stringify({ activities }),
  );
  const expectedPid = activities[0].pid;
  const terminated = await cutpoint.sql`
    SELECT pg_terminate_backend(${expectedPid}) AS terminated
  `;
  assert(
    terminated.length === 1 && terminated[0].terminated === true,
    "CCC_PRODUCT_GIT_LANDING_BACKEND_TERMINATION_FAILED",
    JSON.stringify(terminated),
  );
  await poll(
    "owned Git landing PostgreSQL backend termination",
    cutpoint.sleepingBackends,
    (rows) => rows.length === 0,
    undefined,
    shutdownTimeoutMs,
  );
  return { forcedTermination: true, backendPid: expectedPid };
}

async function git(cwd, ...args) {
  const result = await run("/usr/bin/git", args, { cwd });
  return result.stdout.trim();
}

async function repositorySnapshot() {
  const [headCommit, headTree, status] = await Promise.all([
    git(repoRoot, "rev-parse", "HEAD^{commit}"),
    git(repoRoot, "rev-parse", "HEAD^{tree}"),
    git(
      repoRoot,
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ),
  ]);
  return { headCommit, headTree, status };
}

function assertRepositoryClean(snapshot, phase) {
  assert(
    snapshot.status === "",
    "CCC_PRODUCT_REPOSITORY_DIRTY",
    `${phase} repository status is not clean:\n${snapshot.status}`,
  );
}

function assertRepositoryUnchanged(start, end) {
  assert(
    end.status === "",
    "CCC_PRODUCT_REPOSITORY_STATUS_DRIFT",
    `ending repository status is not clean:\n${end.status}`,
  );
  assert(
    start.headCommit === end.headCommit && start.headTree === end.headTree,
    "CCC_PRODUCT_REPOSITORY_DRIFT",
    JSON.stringify({ start, end }),
  );
}

function jsonOutput(result, label) {
  const candidates = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{") && line.endsWith("}"));
  assert(
    candidates.length === 1,
    "CCC_PRODUCT_JSON_OUTPUT_AMBIGUOUS",
    `${label} emitted ${candidates.length} JSON objects\n${tail(result.stdout)}`,
  );
  try {
    return JSON.parse(candidates[0]);
  } catch (error) {
    throw new Error(
      `CCC_PRODUCT_JSON_OUTPUT_INVALID: ${label}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function availablePort() {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const port = await new Promise((resolve, reject) => {
      const server = createNetServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        server.close(() => resolve(address.port));
      });
    });
    if (port !== 4040) return port;
  }
  throw new Error("CCC_PRODUCT_PORT_UNAVAILABLE");
}

async function poll(label, read, accept, diagnose, timeoutMs = productTimeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  let lastError;
  while (Date.now() < deadline) {
    try {
      latest = await read();
      lastError = undefined;
      if (accept(latest)) return latest;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const diagnostic = diagnose ? await diagnose().catch((error) => String(error)) : undefined;
  throw new Error(
    `CCC_PRODUCT_POLL_TIMEOUT: ${label}; latest=${JSON.stringify(latest)}`
    + `; error=${lastError instanceof Error ? lastError.message : String(lastError ?? "")}`
    + `; diagnostic=${JSON.stringify(diagnostic)}`,
  );
}

function cleanEnvironment(isolatedHome, fakeBin) {
  const env = {
    ...process.env,
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    CODEX_HOME: path.join(isolatedHome, ".codex"),
    PATH: `${fakeBin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    FUSION_SKIP_ONBOARDING: "1",
  };
  for (const key of [
    "DATABASE_URL",
    "FUSION_NO_EMBEDDED_PG",
    "PORT",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "ANTHROPIC_API_KEY",
    "DATABASE_MIGRATION_URL",
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  ]) {
    delete env[key];
  }
  for (const key of Object.keys(env)) {
    if (
      key === "VITEST"
      || key.startsWith("VITEST_")
      || key === "NODE_ENV" && env[key] === "test"
      || key.startsWith("FUSION_TEST_")
    ) {
      delete env[key];
    }
  }
  return env;
}

async function startNativeAuthoringServer(proposalText) {
  const requests = [];
  const server = createHttpServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const rawBody = Buffer.concat(chunks).toString("utf8");
      let body;
      try {
        body = rawBody.length > 0 ? JSON.parse(rawBody) : {};
      } catch (error) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        }));
        return;
      }
      requests.push({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body,
      });
      if (request.method === "GET" && request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          object: "list",
          data: [{
            id: "vertical-authoring-model",
            object: "model",
            owned_by: "ccc-product-authoring",
          }],
        }));
        return;
      }
      if (
        request.method !== "POST"
        || request.url !== "/v1/chat/completions"
      ) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "not found" }));
        return;
      }
      if (body.stream !== true) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({
          error: "CCC_PRODUCT_NATIVE_AUTHORING_STREAM_REQUIRED",
        }));
        return;
      }
      response.writeHead(200, {
        "cache-control": "no-cache",
        connection: "keep-alive",
        "content-type": "text/event-stream",
      });
      response.write(`data: ${JSON.stringify({
        id: "chatcmpl-ccc-product-author",
        object: "chat.completion.chunk",
        model: "vertical-authoring-model",
        choices: [{
          index: 0,
          delta: { role: "assistant", content: proposalText },
          finish_reason: null,
        }],
      })}\n\n`);
      response.write(`data: ${JSON.stringify({
        id: "chatcmpl-ccc-product-author",
        object: "chat.completion.chunk",
        model: "vertical-authoring-model",
        choices: [{
          index: 0,
          delta: {},
          finish_reason: "stop",
        }],
        usage: {
          prompt_tokens: 1,
          completion_tokens: 1,
          total_tokens: 2,
        },
      })}\n\n`);
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(
    address && typeof address === "object",
    "CCC_PRODUCT_AUTHORING_SERVER_ADDRESS_INVALID",
    JSON.stringify(address),
  );
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
  };
}

async function stopNativeAuthoringServer(server) {
  if (!server?.listening) return;
  server.closeAllConnections?.();
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

/*
Chunks run serially (design D-2), so a POST arrives, is answered, and the
next chunk's POST does not begin until the response completes -- a plain
FIFO queue of response bodies is therefore a faithful fake for the chunked
lane, unlike startNativeAuthoringServer's single fixed response.
*/
async function startChunkedFragmentServer(fragmentTextsInOrder) {
  const requests = [];
  const queue = [...fragmentTextsInOrder];
  const server = createHttpServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const rawBody = Buffer.concat(chunks).toString("utf8");
      let body;
      try {
        body = rawBody.length > 0 ? JSON.parse(rawBody) : {};
      } catch (error) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
        return;
      }
      requests.push({ method: request.method, url: request.url, headers: request.headers, body });
      if (request.method === "GET" && request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          object: "list",
          data: [{ id: "vertical-authoring-model", object: "model", owned_by: "ccc-product-authoring" }],
        }));
        return;
      }
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "not found" }));
        return;
      }
      const fragmentText = queue.shift();
      if (fragmentText === undefined) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "CCC_PRODUCT_CHUNKED_FIXTURE_EXHAUSTED" }));
        return;
      }
      response.writeHead(200, {
        "cache-control": "no-cache",
        connection: "keep-alive",
        "content-type": "text/event-stream",
      });
      response.write(`data: ${JSON.stringify({
        id: "chatcmpl-ccc-product-chunk",
        object: "chat.completion.chunk",
        model: "vertical-authoring-model",
        choices: [{ index: 0, delta: { role: "assistant", content: fragmentText }, finish_reason: null }],
      })}\n\n`);
      response.write(`data: ${JSON.stringify({
        id: "chatcmpl-ccc-product-chunk",
        object: "chat.completion.chunk",
        model: "vertical-authoring-model",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })}\n\n`);
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(
    address && typeof address === "object",
    "CCC_PRODUCT_CHUNKED_SERVER_ADDRESS_INVALID",
    JSON.stringify(address),
  );
  return { server, baseUrl: `http://127.0.0.1:${address.port}/v1`, requests };
}

async function assertExactImplementationFactProvenance(
  sidecar,
  packetRoot,
  sourcePath,
  expected,
) {
  const provenance = sidecar.implementationFactProvenance;
  assert(
    provenance?.schema === "ccc-prd.implementation-fact-provenance.v1",
    "CCC_PRODUCT_IMPLEMENTATION_FACT_PROVENANCE_MISSING",
    JSON.stringify(provenance),
  );
  assert(
    Array.isArray(provenance.admittedWriteRoots)
      && provenance.admittedWriteRoots.length === 3
      && Array.isArray(provenance.nonGoals)
      && provenance.nonGoals.length === 1
      && Array.isArray(provenance.requirements)
      && provenance.requirements.length === 2
      && Array.isArray(provenance.proofs)
      && provenance.proofs.length === 3
      && provenance.proofs.every(
        (proof) => Array.isArray(proof.negativeControls)
          && proof.negativeControls.length === 1,
      )
      && Array.isArray(provenance.protectedActions)
      && provenance.protectedActions.length === 3,
    "CCC_PRODUCT_IMPLEMENTATION_FACT_PROVENANCE_CARDINALITY",
    JSON.stringify(provenance),
  );
  exactArray(
    provenance.requirements.map(({ id }) => id),
    ["REQ-VERTICAL", "REQ-VERTICAL-SECOND"],
    "CCC_PRODUCT_IMPLEMENTATION_FACT_REQUIREMENT_DRIFT",
  );
  exactArray(
    provenance.proofs.map(({ id }) => id),
    [
      "PROOF-VERTICAL-INTEGRATED",
      "PROOF-VERTICAL-SECOND-TASK",
      "PROOF-VERTICAL-VALUE-TASK",
    ],
    "CCC_PRODUCT_IMPLEMENTATION_FACT_PROOF_DRIFT",
  );
  exactArray(
    provenance.protectedActions.map(({ id }) => id),
    // Authoring canonicalizes protected actions into sorted id order, so this
    // is the sorted set, not the declaration order.
    [
      "ACTION-VERTICAL-LIVE",
      "ACTION-VERTICAL-MERGE",
      "ACTION-VERTICAL-SECOND-LIVE",
    ],
    "CCC_PRODUCT_IMPLEMENTATION_FACT_ACTION_DRIFT",
  );
  const actionBindings = new Map(
    provenance.protectedActions.map((action) => [action.id, action]),
  );
  const requirementBindings = new Map(
    provenance.requirements.map((requirement) => [requirement.id, requirement]),
  );
  const proofBindings = new Map(
    provenance.proofs.map((proof) => [proof.id, proof]),
  );
  const bindings = [
    ["targetRepository.path", provenance.targetRepository?.path, expected.targetRoot],
    ["targetRepository.baseCommit", provenance.targetRepository?.baseCommit, expected.targetBase],
    ["bounds.maxRequests", provenance.bounds?.maxRequests, verticalCampaignMaxRequests],
    [
      "bounds.maxDurationMs",
      provenance.bounds?.maxDurationMs,
      verticalCampaignMaxDurationMs,
    ],
    ["bounds.maxConcurrency", provenance.bounds?.maxConcurrency, 1],
    [
      "admittedWriteRoots[0].path",
      provenance.admittedWriteRoots[0]?.path,
      expected.fusionStateWriteRoot,
    ],
    [
      "admittedWriteRoots[0].purpose",
      provenance.admittedWriteRoots[0]?.purpose,
      "Fusion-managed campaign state and artifacts",
    ],
    [
      "admittedWriteRoots[1].path",
      provenance.admittedWriteRoots[1]?.path,
      expected.admittedWriteRoot,
    ],
    [
      "admittedWriteRoots[1].purpose",
      provenance.admittedWriteRoots[1]?.purpose,
      "disposable product acceptance repository",
    ],
    [
      "admittedWriteRoots[2].path",
      provenance.admittedWriteRoots[2]?.path,
      expected.admittedSecondWriteRoot,
    ],
    [
      "admittedWriteRoots[2].purpose",
      provenance.admittedWriteRoots[2]?.purpose,
      "disposable product acceptance repository",
    ],
    [
      "nonGoals[0]",
      provenance.nonGoals[0],
      "Modify any path outside the two admitted task write roots.",
    ],
    [
      "requirements[REQ-VERTICAL].acceptance",
      requirementBindings.get("REQ-VERTICAL")?.acceptance,
      "The trusted verifier accepts src/value.txt only when its candidate value is good.",
    ],
    [
      "requirements[REQ-VERTICAL-SECOND].acceptance",
      requirementBindings.get("REQ-VERTICAL-SECOND")?.acceptance,
      "The trusted verifier accepts src/second.txt only when its candidate value is second-good.",
    ],
    [
      "proofs[PROOF-VERTICAL-VALUE-TASK].command",
      proofBindings.get("PROOF-VERTICAL-VALUE-TASK")?.command,
      "task verify:vertical-value",
    ],
    [
      "proofs[PROOF-VERTICAL-VALUE-TASK].positiveOracle",
      proofBindings.get("PROOF-VERTICAL-VALUE-TASK")?.positiveOracle,
      "The baseline-owned harness emits passing canonical evidence for the admitted value clause.",
    ],
    [
      "proofs[PROOF-VERTICAL-VALUE-TASK].negativeControls[0]",
      proofBindings.get("PROOF-VERTICAL-VALUE-TASK")?.negativeControls?.[0],
      "The baseline-owned harness rejects the frozen planted bad value.",
    ],
    [
      "proofs[PROOF-VERTICAL-SECOND-TASK].command",
      proofBindings.get("PROOF-VERTICAL-SECOND-TASK")?.command,
      "task verify:vertical-second",
    ],
    [
      "proofs[PROOF-VERTICAL-SECOND-TASK].positiveOracle",
      proofBindings.get("PROOF-VERTICAL-SECOND-TASK")?.positiveOracle,
      "The baseline-owned harness emits passing canonical evidence for the admitted second-value clause.",
    ],
    [
      "proofs[PROOF-VERTICAL-SECOND-TASK].negativeControls[0]",
      proofBindings.get("PROOF-VERTICAL-SECOND-TASK")?.negativeControls?.[0],
      "The baseline-owned harness rejects the frozen planted pending value.",
    ],
    [
      "proofs[PROOF-VERTICAL-INTEGRATED].command",
      proofBindings.get("PROOF-VERTICAL-INTEGRATED")?.command,
      "task verify:vertical-integrated",
    ],
    [
      "proofs[PROOF-VERTICAL-INTEGRATED].positiveOracle",
      proofBindings.get("PROOF-VERTICAL-INTEGRATED")?.positiveOracle,
      "The baseline-owned harness emits passing canonical evidence for both admitted clauses on one integrated commit.",
    ],
    [
      "proofs[PROOF-VERTICAL-INTEGRATED].negativeControls[0]",
      proofBindings.get("PROOF-VERTICAL-INTEGRATED")?.negativeControls?.[0],
      "The baseline-owned harness rejects the frozen planted bad and pending values.",
    ],
    [
      "protectedActions[ACTION-VERTICAL-LIVE].kind",
      actionBindings.get("ACTION-VERTICAL-LIVE")?.kind,
      "live_execution",
    ],
    [
      "protectedActions[ACTION-VERTICAL-LIVE].target",
      actionBindings.get("ACTION-VERTICAL-LIVE")?.target,
      "provider://openai/TASK-VERTICAL",
    ],
    [
      "protectedActions[ACTION-VERTICAL-SECOND-LIVE].kind",
      actionBindings.get("ACTION-VERTICAL-SECOND-LIVE")?.kind,
      "live_execution",
    ],
    [
      "protectedActions[ACTION-VERTICAL-SECOND-LIVE].target",
      actionBindings.get("ACTION-VERTICAL-SECOND-LIVE")?.target,
      "provider://openai/TASK-VERTICAL-SECOND",
    ],
    [
      "protectedActions[ACTION-VERTICAL-MERGE].kind",
      actionBindings.get("ACTION-VERTICAL-MERGE")?.kind,
      "merge",
    ],
    [
      "protectedActions[ACTION-VERTICAL-MERGE].target",
      actionBindings.get("ACTION-VERTICAL-MERGE")?.target,
      "refs/heads/main",
    ],
  ];
  const contextFacts = new Set([
    "targetRepository.path",
    "targetRepository.baseCommit",
    "bounds.maxRequests",
    "bounds.maxDurationMs",
    "bounds.maxConcurrency",
    "admittedWriteRoots[0].path",
    "admittedWriteRoots[0].purpose",
    "admittedWriteRoots[1].path",
    "admittedWriteRoots[1].purpose",
    "admittedWriteRoots[2].path",
    "admittedWriteRoots[2].purpose",
  ]);
  const sources = new Map();
  const sourceFor = async (sourceRelativePath) => {
    if (!sources.has(sourceRelativePath)) {
      sources.set(
        sourceRelativePath,
        await readFile(path.join(packetRoot, sourceRelativePath)),
      );
    }
    return sources.get(sourceRelativePath);
  };
  const displayPosition = (source, byteOffset) => {
    const lines = source.subarray(0, byteOffset).toString("utf8").split("\n");
    return {
      line: lines.length,
      column: Array.from(lines.at(-1) ?? "").length + 1,
    };
  };
  const spans = [];
  for (const [label, binding, value] of bindings) {
    assert(
      binding?.value === value
        && Array.isArray(binding.spans)
        && binding.spans.length === 1,
      "CCC_PRODUCT_IMPLEMENTATION_FACT_BINDING_INVALID",
      `${label}: ${JSON.stringify(binding)}`,
    );
    const [span] = binding.spans;
    const expectedSourcePath = contextFacts.has(label)
      ? expected.contextSourcePath
      : sourcePath;
    const source = await sourceFor(expectedSourcePath);
    const sourceSha256 = sha256(source);
    const excerpt = source.subarray(span.byteStart, span.byteEnd);
    const expectedStart = displayPosition(source, span.byteStart);
    const expectedEnd = displayPosition(source, span.byteEnd);
    assert(
      span.path === expectedSourcePath
        && Number.isSafeInteger(span.byteStart)
        && Number.isSafeInteger(span.byteEnd)
        && span.byteStart >= 0
        && span.byteEnd > span.byteStart
        && span.byteEnd <= source.length
        && Number.isSafeInteger(span.line)
        && span.line > 0
        && Number.isSafeInteger(span.column)
        && span.column > 0
        && Number.isSafeInteger(span.endLine)
        && Number.isSafeInteger(span.endColumn)
        && span.line === expectedStart.line
        && span.column === expectedStart.column
        && span.endLine === expectedEnd.line
        && span.endColumn === expectedEnd.column
        && span.sha256 === sourceSha256
        && span.excerptSha256 === sha256(excerpt)
        && excerpt.toString("utf8") === String(value),
      "CCC_PRODUCT_IMPLEMENTATION_FACT_SPAN_INVALID",
      `${label}: ${JSON.stringify({ span, excerpt: excerpt.toString("utf8") })}`,
    );
    spans.push({
      fact: label,
      value,
      path: span.path,
      byteStart: span.byteStart,
      byteEnd: span.byteEnd,
      line: span.line,
      column: span.column,
      endLine: span.endLine,
      endColumn: span.endColumn,
      excerptSha256: span.excerptSha256,
    });
  }
  return {
    schema: provenance.schema,
    sourcePaths: [...sources.keys()],
    sourceSha256ByPath: Object.fromEntries(
      [...sources].map(([path, source]) => [path, sha256(source)]),
    ),
    bindingCount: spans.length,
    spans,
  };
}

async function buildCurrentCli(ledger) {
  const startedAt = Date.now();
  process.stdout.write("ccc-prd-product-acceptance: building current workspace outputs\n");
  await run("pnpm", ["build"], {
    cwd: repoRoot,
    timeoutMs: 300_000,
  });
  const outputs = [
    "packages/core/dist/index.js",
    "packages/engine/dist/cli-agent/task-session.js",
    "packages/dashboard/dist/routes/cli-agent-hooks.js",
    "packages/cli/dist/bin.js",
  ];
  const evidence = [];
  for (const relativePath of outputs) {
    const absolutePath = path.join(repoRoot, relativePath);
    const metadata = await stat(absolutePath);
    const bytes = await readFile(absolutePath);
    evidence.push({
      path: relativePath,
      sha256: sha256(bytes),
      mtime: metadata.mtime.toISOString(),
    });
  }
  const engineTaskSession = await readFile(
    path.join(repoRoot, "packages/engine/dist/cli-agent/task-session.js"),
    "utf8",
  );
  const dashboardHooks = await readFile(
    path.join(repoRoot, "packages/dashboard/dist/routes/cli-agent-hooks.js"),
    "utf8",
  );
  assert(
    engineTaskSession.includes("notifyProgram: notifyScriptPath"),
    "CCC_PRODUCT_STALE_ENGINE_BUILD",
    "built task-session lacks the session-scoped Codex notify binding",
  );
  assert(
    dashboardHooks.includes('body.type === "agent-turn-complete"'),
    "CCC_PRODUCT_STALE_DASHBOARD_BUILD",
    "built hook route lacks Codex positive-completion parsing",
  );
  const prdHelp = await run(
    process.execPath,
    [cliBin, "prd", "--help"],
    { cwd: repoRoot },
  );
  const prdProductUsage = await run(
    process.execPath,
    [cliBin, "prd", "preview"],
    { cwd: repoRoot, allowedExitCodes: [2] },
  );
  const prdUsage = `${prdHelp.stdout}\n${prdProductUsage.stdout}`;
  for (const command of [
    "fn prd author",
    "fn prd understand",
    "fn prd corpus",
    "fn prd discover",
    "fn prd freeze",
    "fn prd policy",
    "fn prd validate",
    "fn prd compile",
    "fn prd preview",
    "fn prd import",
    "fn prd inspect",
    "fn prd reconcile",
    "fn prd status",
    "fn prd pause",
    "fn prd resume",
    "fn prd stop",
    "fn prd resolve-proof",
    "fn prd resolve-provider",
    "fn prd approve-execution",
    "fn prd approve-merge",
  ]) {
    assert(
      prdUsage.includes(command),
      "CCC_PRODUCT_STALE_CLI_BUILD",
      `built CLI usage is missing ${command}`,
    );
  }
  const [headCommit, headTree] = (
    await run("/usr/bin/git", ["rev-parse", "HEAD^{commit}", "HEAD^{tree}"], {
      cwd: repoRoot,
    })
  ).stdout.trim().split("\n");
  ledger.pass("built-cli-current-run", {
    startedAt,
    completedAt: Date.now(),
    headCommit,
    headTree,
    outputs: evidence,
    publicPrdCommands: [
      "author",
      "understand",
      "corpus",
      "discover",
      "freeze",
      "policy",
      "validate",
      "compile",
      "preview",
      "import",
      "inspect",
      "reconcile",
      "status",
      "pause",
      "resume",
      "stop",
      "resolve-proof",
      "resolve-provider",
      "approve-execution",
      "approve-merge",
    ],
  });
}

async function initializeTarget(
  targetRoot,
  { proofCutpointToken },
) {
  await mkdir(path.join(targetRoot, "src"), { recursive: true });
  await writeFile(
    path.join(targetRoot, ".gitignore"),
    [".fusion/", ".fusion-global-settings/", ".worktrees/", ""].join("\n"),
  );
  await writeFile(path.join(targetRoot, "src/value.txt"), "bad\n");
  await writeFile(path.join(targetRoot, "src/second.txt"), "pending\n");
  await writeFile(
    path.join(targetRoot, "verify.cjs"),
    [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      `const cutpointToken = ${JSON.stringify(proofCutpointToken)};`,
      `const cutpointMarkerName = ${JSON.stringify(proofCutpointMarkerName)};`,
      "const candidates = Object.fromEntries(process.argv.slice(2).map(candidate => [candidate, fs.readFileSync(candidate, 'utf8').trim()]));",
      "const semanticProofId = process.env.CCC_PROOF_ID;",
      `if (semanticProofId === 'PROOF-VERTICAL-VALUE-TASK' && Object.values(candidates).includes(${JSON.stringify(proofCutpointCandidateValue)})) {`,
      "  const home = process.env.HOME;",
      "  if (!home) {",
      "    console.error('PROOF_CUTPOINT_HOME_MISSING');",
      "    process.exit(9);",
      "  }",
      "  const processTitle = `cccp-${cutpointToken.slice(0, 8)}`;",
      "  process.title = processTitle;",
      "  fs.writeFileSync(",
      "    path.join(home, cutpointMarkerName),",
      "    JSON.stringify({",
      "      token: cutpointToken,",
      "      pid: process.pid,",
      "      cwd: process.cwd(),",
      "      executable: process.execPath,",
      "      argv1: process.argv[1],",
      "      processTitle,",
      "    }),",
      "    { flag: 'wx' },",
      "  );",
      "  console.log('PROOF_CUTPOINT_READY');",
      "  setInterval(() => {}, 1000);",
      "} else {",
      "  const localProofId = ({ 'src/value.txt': 'PROOF-VERTICAL-VALUE-TASK', 'src/second.txt': 'PROOF-VERTICAL-SECOND-TASK', 'src/second.txt,src/value.txt': 'PROOF-VERTICAL-INTEGRATED' })[Object.keys(candidates).sort().join(',')];",
      "  const proofId = semanticProofId || localProofId;",
      `  const acceptedValue = candidates['src/value.txt'] === 'good' || (!semanticProofId && candidates['src/value.txt'] === ${JSON.stringify(proofCutpointCandidateValue)});`,
      "  const definitions = {",
      "    'PROOF-VERTICAL-INTEGRATED': {",
      "      clauses: { 'AC-REQ-VERTICAL-001': acceptedValue, 'AC-REQ-VERTICAL-SECOND-001': candidates['src/second.txt'] === 'second-good' },",
      "      cases: { 'CASE-VERTICAL-INTEGRATED': acceptedValue && candidates['src/second.txt'] === 'second-good' },",
      "      controls: { 'CONTROL-VERTICAL-INTEGRATED': 'bad' !== 'good' && 'pending' !== 'second-good' },",
      "    },",
      "    'PROOF-VERTICAL-SECOND-TASK': {",
      "      clauses: { 'AC-REQ-VERTICAL-SECOND-001': candidates['src/second.txt'] === 'second-good' },",
      "      cases: { 'CASE-VERTICAL-SECOND': candidates['src/second.txt'] === 'second-good' },",
      "      controls: { 'CONTROL-VERTICAL-PENDING': 'pending' !== 'second-good' },",
      "    },",
      "    'PROOF-VERTICAL-VALUE-TASK': {",
      "      clauses: { 'AC-REQ-VERTICAL-001': acceptedValue },",
      "      cases: { 'CASE-VERTICAL-VALUE': acceptedValue },",
      "      controls: { 'CONTROL-VERTICAL-BAD': 'bad' !== 'good' },",
      "    },",
      "  };",
      "  const definition = definitions[proofId];",
      "  if (!definition) { console.error(`UNKNOWN_PROOF:${proofId}`); process.exit(3); }",
      "  const clauseResults = Object.entries(definition.clauses).sort(([left], [right]) => left.localeCompare(right)).map(([clauseId, passed]) => ({ clauseId, passed }));",
      "  const negativeControlResults = Object.entries(definition.controls).sort(([left], [right]) => left.localeCompare(right)).map(([controlId, passed]) => ({ controlId, passed }));",
      "  const positiveCaseResults = Object.entries(definition.cases).sort(([left], [right]) => left.localeCompare(right)).map(([caseId, passed]) => ({ caseId, passed }));",
      "  const passed = [...clauseResults, ...negativeControlResults, ...positiveCaseResults].every(result => result.passed);",
      "  const evidence = { clauseResults, negativeControlResults, passed, phase: process.env.CCC_PROOF_PHASE, positiveCaseResults, proofId, schema: 'ccc-prd.proof-evidence.v2', sourceCommit: process.env.CCC_PROOF_SOURCE_COMMIT, sourceTree: process.env.CCC_PROOF_SOURCE_TREE };",
      "  process.stdout.write(`${JSON.stringify(evidence)}\\n`);",
      "  process.exitCode = passed ? 0 : 1;",
      "}",
      "",
    ].join("\n"),
  );
  for (const { file } of fanTasks) {
    await writeFile(path.join(targetRoot, file), "pending\n");
  }
  await writeFile(
    path.join(targetRoot, "verify-fanout.cjs"),
    [
      "const fs = require('node:fs');",
      `const expectations = ${JSON.stringify(Object.fromEntries(
        fanTasks.map(({ taskId, requirementId, file, value }) => [
          `PROOF-${taskId.slice("TASK-".length)}-TASK`,
          {
            clauses: [`AC-${requirementId}-001`],
            cases: [`CASE-${taskId.slice("TASK-".length)}`],
            controls: [`CONTROL-${taskId.slice("TASK-".length)}-PENDING`],
            files: [{ file, value }],
          },
        ]),
      ))};`,
      `const integrated = ${JSON.stringify({
        clauses: fanTasks.map(({ requirementId }) => `AC-${requirementId}-001`),
        cases: ["CASE-FANOUT-INTEGRATED"],
        controls: ["CONTROL-FANOUT-INTEGRATED-PENDING"],
        files: fanTasks.map(({ file, value }) => ({ file, value })),
      })};`,
      "const candidates = Object.fromEntries(process.argv.slice(2).map(candidate => [candidate, fs.readFileSync(candidate, 'utf8').trim()]));",
      `const localProofIds = ${JSON.stringify({
        ...Object.fromEntries(
          fanTasks.map((fanTask) => [
            fanTask.file,
            fanoutTaskProofIdFor(fanTask),
          ]),
        ),
        [fanTasks.map(({ file }) => file).sort().join(",")]: "PROOF-FANOUT-INTEGRATED",
      })};`,
      "const semanticProofId = process.env.CCC_PROOF_ID;",
      "const localProofId = localProofIds[Object.keys(candidates).sort().join(',')];",
      "const proofId = semanticProofId || localProofId;",
      "const definition = proofId === 'PROOF-FANOUT-INTEGRATED' ? integrated : expectations[proofId];",
      "if (!definition) { console.error(`UNKNOWN_PROOF:${proofId}`); process.exit(3); }",
      "const filePassed = Object.fromEntries(definition.files.map(({ file, value }) => [file, candidates[file] === value]));",
      "const allFilesPassed = Object.values(filePassed).every(Boolean);",
      "const clauseResults = definition.clauses.map((clauseId, index) => ({ clauseId, passed: definition.files.length === 1 ? allFilesPassed : filePassed[definition.files[index].file] })).sort((left, right) => left.clauseId.localeCompare(right.clauseId));",
      "const negativeControlResults = definition.controls.map(controlId => ({ controlId, passed: definition.files.every(({ value }) => value !== 'pending') })).sort((left, right) => left.controlId.localeCompare(right.controlId));",
      "const positiveCaseResults = definition.cases.map(caseId => ({ caseId, passed: allFilesPassed })).sort((left, right) => left.caseId.localeCompare(right.caseId));",
      "const passed = [...clauseResults, ...negativeControlResults, ...positiveCaseResults].every(result => result.passed);",
      "const evidence = { clauseResults, negativeControlResults, passed, phase: process.env.CCC_PROOF_PHASE, positiveCaseResults, proofId, schema: 'ccc-prd.proof-evidence.v2', sourceCommit: process.env.CCC_PROOF_SOURCE_COMMIT, sourceTree: process.env.CCC_PROOF_SOURCE_TREE };",
      "process.stdout.write(`${JSON.stringify(evidence)}\\n`);",
      "process.exitCode = passed ? 0 : 1;",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(targetRoot, "Taskfile.yml"),
    [
      "version: '3'",
      "",
      "tasks:",
      "  verify:vertical-value:",
      "    cmds:",
      "      - node verify.cjs src/value.txt",
      "  verify:vertical-second:",
      "    cmds:",
      "      - node verify.cjs src/second.txt",
      "  verify:vertical-integrated:",
      "    cmds:",
      "      - node verify.cjs src/value.txt src/second.txt",
      "",
    ].join("\n"),
  );
  await git(targetRoot, "init", "-q", "-b", "main");
  await git(targetRoot, "config", "user.name", "CCC Product Acceptance");
  await git(
    targetRoot,
    "config",
    "user.email",
    "ccc-product-acceptance@example.invalid",
  );
  await git(
    targetRoot,
    "add",
    "--",
    ".gitignore",
    "Taskfile.yml",
    ...fanTasks.map(({ file }) => file),
    "src/second.txt",
    "src/value.txt",
    "verify-fanout.cjs",
    "verify.cjs",
  );
  await git(targetRoot, "commit", "-q", "-m", "frozen product baseline");
  return await git(targetRoot, "rev-parse", "HEAD");
}

async function initializeFanoutProofBaseline(targetRoot) {
  const targetLines = fanTasks.flatMap((fanTask) => [
    `  verify:${fanTask.taskId.slice("TASK-".length).toLowerCase()}:`,
    "    cmds:",
    `      - node verify-fanout.cjs ${fanTask.file}`,
  ]);
  await writeFile(
    path.join(targetRoot, "Taskfile.yml"),
    [
      "version: '3'",
      "",
      "tasks:",
      ...targetLines,
      "  verify:fanout-integrated:",
      "    cmds:",
      `      - node verify-fanout.cjs ${fanTasks.map(({ file }) => file).join(" ")}`,
      "",
    ].join("\n"),
  );
  await git(targetRoot, "add", "--", "Taskfile.yml");
  await git(
    targetRoot,
    "commit",
    "-q",
    "-m",
    "Install baseline-owned fan-out semantic verifier target map",
  );
  return await git(targetRoot, "rev-parse", "HEAD");
}

async function createPacket(packetRoot, targetRoot, targetBase, env) {
  const activeProjectsRoot = path.join(path.dirname(packetRoot), "active-projects");
  const projectName = "vertical-slice";
  const projectRoot = path.join(activeProjectsRoot, projectName);
  const prdFileName = "PRJ-HUM-CCCProductVerticalSlice-PRD-v1.0.0.md";
  const prdSourcePath = path.join(projectRoot, prdFileName);
  const supportRelativePath = "support/REF-HUM-VerticalVerifier.md";
  const supportSourcePath = path.join(projectRoot, supportRelativePath);
  const requirementStatement =
    "Change src/value.txt from bad to good in an isolated worktree.";
  const secondRequirementStatement =
    "Change src/second.txt from pending to second-good in a chained isolated worktree that already contains the first task's commit.";
  const acceptanceText =
    "The trusted verifier accepts src/value.txt only when its candidate value is good.";
  const secondAcceptanceText =
    "The trusted verifier accepts src/second.txt only when its candidate value is second-good.";
  const acceptanceClauseId = "AC-REQ-VERTICAL-001";
  const secondAcceptanceClauseId = "AC-REQ-VERTICAL-SECOND-001";
  const valueTaskPositiveOracle =
    "The baseline-owned harness emits passing canonical evidence for the admitted value clause.";
  const valueTaskNegativeControl =
    "The baseline-owned harness rejects the frozen planted bad value.";
  const secondTaskPositiveOracle =
    "The baseline-owned harness emits passing canonical evidence for the admitted second-value clause.";
  const secondTaskNegativeControl =
    "The baseline-owned harness rejects the frozen planted pending value.";
  const integratedPositiveOracle =
    "The baseline-owned harness emits passing canonical evidence for both admitted clauses on one integrated commit.";
  const integratedNegativeControl =
    "The baseline-owned harness rejects the frozen planted bad and pending values.";
  const valueTaskProofLine =
    `For this task, the verifier command task verify:vertical-value establishes the clause. Positive oracle: ${valueTaskPositiveOracle} Negative control: ${valueTaskNegativeControl}`;
  const secondTaskProofLine =
    `For this task, the verifier command task verify:vertical-second establishes the clause. Positive oracle: ${secondTaskPositiveOracle} Negative control: ${secondTaskNegativeControl}`;
  const integratedProofLine =
    `For the combined result, the verifier command task verify:vertical-integrated establishes every admitted clause. Positive oracle: ${integratedPositiveOracle} Negative control: ${integratedNegativeControl}`;
  const requirementLine = `Requirement statement: ${requirementStatement}`;
  const secondRequirementLine =
    `Requirement statement: ${secondRequirementStatement}`;
  const targetRepositoryLine = "- Target repository: " + targetRoot;
  const baselineLine = "- Baseline commit: " + targetBase;
  const taskOwnedPathLine = "- Task owned path: src/value.txt";
  const taskAllowedWriteRootLine = "- Task allowed write root: src/value.txt";
  const secondTaskOwnedPathLine = "- Task owned path: src/second.txt";
  const secondTaskAllowedWriteRootLine =
    "- Task allowed write root: src/second.txt";
  const fusionStateWriteRoot = path.join(targetRoot, ".fusion");
  const admittedWriteRoot = path.join(targetRoot, "src/value.txt");
  const admittedSecondWriteRoot = path.join(targetRoot, "src/second.txt");
  const fusionStateWriteRootLine =
    "- Allowed write root: " + fusionStateWriteRoot;
  const allowedWriteRootLine = "- Allowed write root: " + admittedWriteRoot;
  const allowedSecondWriteRootLine =
    "- Allowed write root: " + admittedSecondWriteRoot;
  const fusionStateWriteRootPurposeLine =
    "- Allowed write root purpose: Fusion-managed campaign state and artifacts";
  const allowedWriteRootPurposeLine =
    "- Allowed write root purpose: disposable product acceptance repository";
  const maxRequestsLine = `- Maximum requests: ${verticalCampaignMaxRequests}`;
  const maxDurationLine =
    `- Maximum duration in milliseconds: ${verticalCampaignMaxDurationMs}`;
  const maxConcurrencyLine = "- Maximum concurrency: 1";
  const nonGoalLine =
    "- Non-goal: Modify any path outside the two admitted task write roots.";
  const liveActionLine =
    "- Protected action: live_execution provider://openai/TASK-VERTICAL requires explicit human approval.";
  const secondLiveActionLine =
    "- Protected action: live_execution provider://openai/TASK-VERTICAL-SECOND requires explicit human approval.";
  const mergeActionLine =
    "- Protected action: merge refs/heads/main requires separate explicit human approval.";
  const supportingContextLine =
    "[[support/REF-HUM-VerticalVerifier]] documents the disposable verifier.";
  const prd = [
    "---",
    "type: prd",
    "status: active",
    "version: 1.0.0",
    "---",
    "",
    "# CCC Fusion Product Vertical Slice",
    "",
    "## Implementation contract",
    "",
    nonGoalLine,
    "",
    "## Protected actions",
    "",
    liveActionLine,
    secondLiveActionLine,
    mergeActionLine,
    "",
    "## Requirement and proof",
    "",
    "### Requirement REQ-VERTICAL",
    requirementLine,
    "#### Acceptance clauses",
    `- [${acceptanceClauseId}] ${acceptanceText}`,
    "#### Proof declaration",
    valueTaskProofLine,
    "",
    "### Requirement REQ-VERTICAL-SECOND",
    secondRequirementLine,
    "#### Acceptance clauses",
    `- [${secondAcceptanceClauseId}] ${secondAcceptanceText}`,
    "#### Proof declaration",
    secondTaskProofLine,
    "",
    "## Final integrated proof",
    "",
    integratedProofLine,
    "",
    "## Supporting context",
    "",
    supportingContextLine,
    "",
  ].join("\n");
  const support = [
    "# Vertical verifier",
    "",
    "The owned verifier reads src/value.txt and accepts only the value good.",
    "",
  ].join("\n");
  await mkdir(path.dirname(supportSourcePath), { recursive: true });
  await writeFile(prdSourcePath, prd);
  await writeFile(supportSourcePath, support);
  const prdSourceSha256 = sha256(await readFile(prdSourcePath));

  const corpus = jsonOutput(
    await run(
      process.execPath,
      [cliBin, "prd", "corpus", activeProjectsRoot],
      { cwd: targetRoot, env },
    ),
    "prd corpus",
  );
  const corpusProject = corpus.projects?.find(
    ({ project }) => project === projectName,
  );
  assert(
    corpus.schema === "ccc-prd.corpus-manifest.v1"
    && corpus.summary?.projectCount === 1
    && corpus.summary?.selectedCount === 1
    && corpusProject?.selection?.kind === "selected"
    && corpusProject.selection.selectedPrdPath === prdSourcePath
    && corpusProject.selection.sourceSha256 === prdSourceSha256
    && corpusProject.selection.sourceBytes === Buffer.byteLength(prd, "utf8"),
    "CCC_PRODUCT_CURRENT_PRD_CORPUS_FAILED",
    JSON.stringify({ summary: corpus.summary, project: corpusProject }),
  );
  assert(
    !JSON.stringify(corpus).includes(requirementLine),
    "CCC_PRODUCT_CORPUS_LEAKED_SOURCE_TEXT",
    projectName,
  );

  const discovery = jsonOutput(
    await run(
      process.execPath,
      [cliBin, "prd", "discover", activeProjectsRoot],
      { cwd: targetRoot, env },
    ),
    "prd discover",
  );
  const discoveredProject = discovery.projects?.find(
    ({ project }) => project === projectName,
  );
  assert(
    discoveredProject?.selection?.kind === "selected"
    && discoveredProject.selection.selectedPrdPath === prdSourcePath,
    "CCC_PRODUCT_CURRENT_PRD_DISCOVERY_FAILED",
    JSON.stringify(discoveredProject),
  );

  const frozen = jsonOutput(
    await run(
      process.execPath,
      [
        cliBin,
        "prd",
        "freeze",
        activeProjectsRoot,
        prdSourcePath,
        packetRoot,
        "--target",
        targetRoot,
        "--base",
        targetBase,
        "--owned-path",
        "src/value.txt",
        "--owned-path",
        "src/second.txt",
        "--write-root",
        "src/value.txt",
        "--write-root",
        "src/second.txt",
        "--write-purpose",
        "disposable product acceptance repository",
        "--max-requests",
        String(verticalCampaignMaxRequests),
        "--max-duration-ms",
        String(verticalCampaignMaxDurationMs),
        "--max-concurrency",
        "1",
      ],
      { cwd: targetRoot, env },
    ),
    "prd freeze",
  );
  assert(
    frozen.schema === "ccc-prd.freeze-result.v1"
    && frozen.packet?.fileCount === 3
    && frozen.packet?.unresolvedReferenceCount === 0
    && frozen.unresolvedReferences?.length === 0,
    "CCC_PRODUCT_CURRENT_PRD_FREEZE_FAILED",
    JSON.stringify(frozen),
  );
  const freezeReceipt = JSON.parse(await readFile(frozen.receiptPath, "utf8"));
  exactArray(
    freezeReceipt.entries?.map(({ projectRelativePath }) => projectRelativePath),
    [
      prdFileName,
      "__fusion__/REF-HUM-FusionOperatorContext.md",
      supportRelativePath,
    ],
    "CCC_PRODUCT_FROZEN_SOURCE_SET_DRIFT",
  );
  const operatorContextReceipt = freezeReceipt.entries?.find(
    ({ projectRelativePath }) =>
      projectRelativePath === "__fusion__/REF-HUM-FusionOperatorContext.md",
  );
  assert(
    operatorContextReceipt?.originPath
      === "operator-context://ccc-prd.operator-context.v1"
      && operatorContextReceipt.role === "support"
      && operatorContextReceipt.authoritative === true,
    "CCC_PRODUCT_GUIDED_CONTEXT_RECEIPT_INVALID",
    JSON.stringify(operatorContextReceipt),
  );
  assert(
    sha256(await readFile(prdSourcePath)) === prdSourceSha256,
    "CCC_PRODUCT_GUIDED_FREEZE_CHANGED_PRD",
    prdSourcePath,
  );

  const manifestPath = frozen.manifestPath;
  const proposalPath = path.join(packetRoot, "authoring-proposal.json");
  const sidecarPath = path.join(packetRoot, "candidate.sidecar.json");
  const executionPlanPath = path.join(packetRoot, "execution-plan.json");
  const frozenPrdRelativePath = `sources/${prdFileName}`;
  const frozenContextRelativePath =
    "sources/__fusion__/REF-HUM-FusionOperatorContext.md";
  const prdRef = (exactQuote) => ({
    path: frozenPrdRelativePath,
    exactQuote,
  });
  const sourceRefs = [
    prdRef(requirementLine),
    prdRef(acceptanceText),
  ];
  const secondSourceRefs = [
    prdRef(secondRequirementLine),
    prdRef(secondAcceptanceText),
  ];
  const valueTaskProofRefs = [prdRef(valueTaskProofLine)];
  const secondTaskProofRefs = [prdRef(secondTaskProofLine)];
  const integratedProofRefs = [prdRef(integratedProofLine)];
  const implementationRefs = [
    targetRepositoryLine,
    baselineLine,
    taskOwnedPathLine,
    taskAllowedWriteRootLine,
    fusionStateWriteRootLine,
    allowedWriteRootLine,
    fusionStateWriteRootPurposeLine,
    allowedWriteRootPurposeLine,
    maxRequestsLine,
    maxDurationLine,
    maxConcurrencyLine,
  ].map((exactQuote) => ({
    path: frozenContextRelativePath,
    exactQuote,
  }));
  // The compiler requires per-task custody once the chain holds more than one
  // task, and authoring additionally requires each task's own quoted evidence
  // to contain that task's paths verbatim. The second task therefore cites its
  // own custody and write-root lines rather than reusing the first task's.
  const secondImplementationRefs = [
    secondTaskOwnedPathLine,
    secondTaskAllowedWriteRootLine,
    allowedSecondWriteRootLine,
  ].map((exactQuote) => ({
    path: frozenContextRelativePath,
    exactQuote,
  }));
  const nonGoalRefs = [{
    path: frozenPrdRelativePath,
    exactQuote: nonGoalLine,
  }];
  const liveActionRefs = [{
    path: frozenPrdRelativePath,
    exactQuote: liveActionLine,
  }];
  const secondLiveActionRefs = [{
    path: frozenPrdRelativePath,
    exactQuote: secondLiveActionLine,
  }];
  const mergeActionRefs = [{
    path: frozenPrdRelativePath,
    exactQuote: mergeActionLine,
  }];
  const supportingRefs = [{
    path: frozenPrdRelativePath,
    exactQuote: supportingContextLine,
  }];
  const proposal = {
    schema: "ccc-prd.authoring-proposal.v2",
    authorityRoles: [
      {
        id: "AUTHORITY-VERTICAL",
        role: "root",
        sourcePaths: [frozenPrdRelativePath],
        accountableProducer: "product-owner",
      },
      {
        id: "AUTHORITY-VERTICAL-CONTEXT",
        role: "support",
        sourcePaths: [frozenContextRelativePath],
        accountableProducer: "operator",
      },
    ],
    requirements: [
      {
        id: "REQ-VERTICAL",
        statement: requirementStatement,
        acceptance: acceptanceText,
        acceptanceClauses: [{
          id: acceptanceClauseId,
          requirementId: "REQ-VERTICAL",
          text: acceptanceText,
          proofIds: [
            "PROOF-VERTICAL-INTEGRATED",
            "PROOF-VERTICAL-VALUE-TASK",
          ],
          sourceRefs: [prdRef(acceptanceText)],
        }],
        acceptanceDispositions: [],
        accountableProducer: "campaign-coding-agent",
        dependencies: [],
        proofIds: [
          "PROOF-VERTICAL-INTEGRATED",
          "PROOF-VERTICAL-VALUE-TASK",
        ],
        sourceRefs,
        confidence: "high",
      },
      {
        id: "REQ-VERTICAL-SECOND",
        statement: secondRequirementStatement,
        acceptance: secondAcceptanceText,
        acceptanceClauses: [{
          id: secondAcceptanceClauseId,
          requirementId: "REQ-VERTICAL-SECOND",
          text: secondAcceptanceText,
          proofIds: [
            "PROOF-VERTICAL-INTEGRATED",
            "PROOF-VERTICAL-SECOND-TASK",
          ],
          sourceRefs: [prdRef(secondAcceptanceText)],
        }],
        acceptanceDispositions: [],
        accountableProducer: "campaign-coding-agent",
        dependencies: ["REQ-VERTICAL"],
        proofIds: [
          "PROOF-VERTICAL-INTEGRATED",
          "PROOF-VERTICAL-SECOND-TASK",
        ],
        sourceRefs: secondSourceRefs,
        confidence: "high",
      },
    ],
    proofs: [
      semanticProofProposal({
        id: "PROOF-VERTICAL-VALUE-TASK",
        requirementIds: ["REQ-VERTICAL"],
        clauseIds: [acceptanceClauseId],
        phases: ["task"],
        command: "task verify:vertical-value",
        positiveOracle: valueTaskPositiveOracle,
        positiveCases: [{
          id: "CASE-VERTICAL-VALUE",
          description: valueTaskPositiveOracle,
        }],
        negativeControls: [{
          id: "CONTROL-VERTICAL-BAD",
          description: valueTaskNegativeControl,
        }],
        harnessPath: "verify.cjs",
        candidateInputs: ["src/value.txt"],
        sourceRefs: valueTaskProofRefs,
      }),
      semanticProofProposal({
        id: "PROOF-VERTICAL-SECOND-TASK",
        requirementIds: ["REQ-VERTICAL-SECOND"],
        clauseIds: [secondAcceptanceClauseId],
        phases: ["task"],
        command: "task verify:vertical-second",
        positiveOracle: secondTaskPositiveOracle,
        positiveCases: [{
          id: "CASE-VERTICAL-SECOND",
          description: secondTaskPositiveOracle,
        }],
        negativeControls: [{
          id: "CONTROL-VERTICAL-PENDING",
          description: secondTaskNegativeControl,
        }],
        harnessPath: "verify.cjs",
        candidateInputs: ["src/second.txt"],
        sourceRefs: secondTaskProofRefs,
      }),
      semanticProofProposal({
        id: "PROOF-VERTICAL-INTEGRATED",
        requirementIds: ["REQ-VERTICAL", "REQ-VERTICAL-SECOND"],
        clauseIds: [acceptanceClauseId, secondAcceptanceClauseId],
        phases: ["final_integrated"],
        command: "task verify:vertical-integrated",
        positiveOracle: integratedPositiveOracle,
        positiveCases: [{
          id: "CASE-VERTICAL-INTEGRATED",
          description: integratedPositiveOracle,
        }],
        negativeControls: [{
          id: "CONTROL-VERTICAL-INTEGRATED",
          description: integratedNegativeControl,
        }],
        harnessPath: "verify.cjs",
        candidateInputs: ["src/value.txt", "src/second.txt"],
        sourceRefs: integratedProofRefs,
      }),
    ],
    tasks: [
      {
        id: "TASK-VERTICAL",
        title: "Implement the admitted value change",
        description:
          "Edit only src/value.txt so the exact verifier passes; the Fusion controller creates the campaign commit.",
        ownedPaths: ["src/value.txt"],
        allowedWriteRoots: ["src/value.txt"],
        accountableProducer: "campaign-coding-agent",
        requirementIds: ["REQ-VERTICAL"],
        dependencyTaskIds: [],
        proofIds: ["PROOF-VERTICAL-VALUE-TASK"],
        workflowId: "WORKFLOW-VERTICAL",
        documentIds: [],
        artifactIds: [],
        protectedActionIds: ["ACTION-VERTICAL-LIVE"],
        sourceRefs: [
          ...implementationRefs,
          ...nonGoalRefs,
          ...sourceRefs,
          ...valueTaskProofRefs,
          ...liveActionRefs,
          ...supportingRefs,
        ],
      },
      {
        id: "TASK-VERTICAL-SECOND",
        title: "Implement the admitted second value change",
        description:
          "Edit only src/second.txt so the exact verifier passes over both admitted files; the Fusion controller creates the campaign commit.",
        ownedPaths: ["src/second.txt"],
        allowedWriteRoots: ["src/second.txt"],
        accountableProducer: "campaign-coding-agent",
        requirementIds: ["REQ-VERTICAL-SECOND"],
        dependencyTaskIds: ["TASK-VERTICAL"],
        proofIds: ["PROOF-VERTICAL-SECOND-TASK"],
        workflowId: "WORKFLOW-VERTICAL",
        documentIds: [],
        artifactIds: [],
        protectedActionIds: [
          "ACTION-VERTICAL-SECOND-LIVE",
          "ACTION-VERTICAL-MERGE",
        ],
        sourceRefs: [
          ...secondImplementationRefs,
          ...secondSourceRefs,
          ...secondTaskProofRefs,
          ...integratedProofRefs,
          ...secondLiveActionRefs,
          ...mergeActionRefs,
        ],
      },
    ],
    // The declared edge must mirror dependencyTaskIds exactly: the compiler
    // reads dependencyTaskIds for ordering while the importer persists
    // dependency rows from edges, so a disagreement would execute an order
    // that was never admitted.
    edges: [{
      id: "EDGE-VERTICAL-CHAIN",
      fromTaskId: "TASK-VERTICAL-SECOND",
      toTaskId: "TASK-VERTICAL",
      kind: "depends_on",
    }],
    workflows: [{
      id: "WORKFLOW-VERTICAL",
      title: "CCC Fusion product vertical slice",
      taskIds: ["TASK-VERTICAL", "TASK-VERTICAL-SECOND"],
      entryTaskIds: ["TASK-VERTICAL"],
      terminalTaskIds: ["TASK-VERTICAL-SECOND"],
      sourceRefs,
    }],
    documents: [],
    artifacts: [],
    importIntents: [
      {
        id: "IMPORT-VERTICAL-TASK",
        entityType: "task",
        entityId: "TASK-VERTICAL",
        operation: "create",
        target: "project.tasks",
      },
      {
        id: "IMPORT-VERTICAL-TASK-SECOND",
        entityType: "task",
        entityId: "TASK-VERTICAL-SECOND",
        operation: "create",
        target: "project.tasks",
      },
      {
        id: "IMPORT-VERTICAL-EDGE",
        entityType: "dependency_edge",
        entityId: "EDGE-VERTICAL-CHAIN",
        operation: "create",
        target: "project.tasks.dependencies",
      },
      {
        id: "IMPORT-VERTICAL-WORKFLOW",
        entityType: "workflow",
        entityId: "WORKFLOW-VERTICAL",
        operation: "create",
        target: "project.workflow_work_items",
      },
      {
        id: "IMPORT-VERTICAL-WORK-ITEM",
        entityType: "work_item",
        entityId: "WORKFLOW-VERTICAL",
        operation: "create",
        target: "project.workflow_work_items",
      },
      {
        id: "IMPORT-VERTICAL-CAMPAIGN",
        entityType: "campaign",
        entityId: "CAMPAIGN-VERTICAL",
        operation: "create",
        target: "project.missions",
      },
      {
        id: "IMPORT-VERTICAL-SOURCE",
        entityType: "source",
        entityId: "SOURCE-VERTICAL",
        operation: "create",
        target: "project.ccc_prd_import_sources",
      },
      {
        id: "IMPORT-VERTICAL-AUDIT",
        entityType: "run_audit",
        entityId: "CAMPAIGN-VERTICAL",
        operation: "create",
        target: "project.run_audit_events",
      },
    ],
    protectedActions: [
      {
        id: "ACTION-VERTICAL-LIVE",
        kind: "live_execution",
        target: "provider://openai/TASK-VERTICAL",
        requiresOperatorDecision: true,
        operatorDecision: "approve_live_execution",
        sourceRefs: liveActionRefs,
      },
      {
        id: "ACTION-VERTICAL-SECOND-LIVE",
        kind: "live_execution",
        target: "provider://openai/TASK-VERTICAL-SECOND",
        requiresOperatorDecision: true,
        operatorDecision: "approve_live_execution",
        sourceRefs: secondLiveActionRefs,
      },
      {
        id: "ACTION-VERTICAL-MERGE",
        kind: "merge",
        target: "refs/heads/main",
        requiresOperatorDecision: true,
        operatorDecision: "approve_merge",
        sourceRefs: mergeActionRefs,
      },
    ],
    bounds: {
      // Two provider tasks each require one MUTATE turn plus the single
      // controller-issued REPAIR turn, so the structural floor is four.
      maxRequests: verticalCampaignMaxRequests,
      maxDurationMs: verticalCampaignMaxDurationMs,
      maxConcurrency: 1,
    },
    admittedWriteRoots: [
      {
        path: fusionStateWriteRoot,
        purpose: "Fusion-managed campaign state and artifacts",
      },
      {
        path: admittedWriteRoot,
        purpose: "disposable product acceptance repository",
      },
      {
        path: admittedSecondWriteRoot,
        purpose: "disposable product acceptance repository",
      },
    ],
    targetRepository: { path: targetRoot, baseCommit: targetBase },
    nonGoals: ["Modify any path outside the two admitted task write roots."],
    unresolvedDecisions: [],
    ambiguities: [],
    exceptions: [],
    confidence: "high",
  };
  await writeFile(proposalPath, `${JSON.stringify(proposal, null, 2)}\n`);
  return {
    manifestPath,
    proposalPath,
    sidecarPath,
    executionPlanPath,
    sourcePath: frozenPrdRelativePath,
    contextSourcePath: frozenContextRelativePath,
    operatorContext: {
      originPath: operatorContextReceipt.originPath,
      sha256: operatorContextReceipt.sha256,
      prdSourceSha256,
      sourceUnchanged: true,
    },
    corpus: {
      schema: corpus.schema,
      summary: corpus.summary,
      project: {
        project: corpusProject.project,
        selectedPrdPath: corpusProject.selection.selectedPrdPath,
        sourceSha256: corpusProject.selection.sourceSha256,
        sourceBytes: corpusProject.selection.sourceBytes,
      },
      sourceTextExcluded: true,
    },
    discovery: {
      project: projectName,
      selectedPrdPath: discoveredProject.selection.selectedPrdPath,
    },
    freeze: {
      packetHash: frozen.packet.packetHash,
      manifestSha256: frozen.packet.manifestSha256,
      receiptSha256: frozen.packet.receiptSha256,
      fileCount: frozen.packet.fileCount,
      entries: freezeReceipt.entries.map((entry) => ({
        relativePath: entry.relativePath,
        role: entry.role,
        authoritative: entry.authoritative,
        sha256: entry.sha256,
      })),
      unresolvedReferenceCount: frozen.packet.unresolvedReferenceCount,
    },
  };
}

/**
 * Freeze and propose the series-parallel packet: TASK-FAN-A ->
 * {TASK-FAN-B, TASK-FAN-C} -> TASK-FAN-D. A separate active-projects root and
 * packet root keep the vertical-slice packet byte-identical; the base commit
 * is whatever the target's main points at when the lane starts (the landed
 * vertical campaign), because fresh entry worktrees fork from the integration
 * branch and the frozen base must match them.
 */
async function createFanoutPacket(
  packetRoot,
  projectsRoot,
  targetRoot,
  targetBase,
  env,
) {
  const projectName = "fanout-slice";
  const projectRoot = path.join(projectsRoot, projectName);
  const prdFileName = "PRJ-HUM-CCCProductFanoutSlice-PRD-v1.0.0.md";
  const prdSourcePath = path.join(projectRoot, prdFileName);
  const supportRelativePath = "support/REF-HUM-FanoutVerifier.md";
  const supportSourcePath = path.join(projectRoot, supportRelativePath);

  const statementFor = (fanTask) => {
    if (fanTask.role === "entry") {
      return `Change ${fanTask.file} from pending to ${fanTask.value} in an isolated worktree.`;
    }
    if (fanTask.role === "join") {
      return `Change ${fanTask.file} from pending to ${fanTask.value} in a join worktree whose history merges both parallel branch commits.`;
    }
    return `Change ${fanTask.file} from pending to ${fanTask.value} in a parallel isolated worktree that already contains the entry task's commit.`;
  };
  const acceptanceFor = (fanTask) =>
    `The trusted verifier accepts ${fanTask.file} only when its candidate value is ${fanTask.value}.`;
  const taskPositiveOracleFor = (fanTask) =>
    `The baseline-owned harness emits passing canonical evidence for ${fanTask.file}.`;
  const taskNegativeControlFor = (fanTask) =>
    `The baseline-owned harness rejects the frozen planted pending value for ${fanTask.file}.`;
  const requirementLineFor = (fanTask) =>
    `Requirement statement: ${statementFor(fanTask)}`;
  const taskProofLineFor = (fanTask) =>
    `For this task, the verifier command ${fanoutTaskProofCommandFor(fanTask)} establishes the clause. Positive oracle: ${taskPositiveOracleFor(fanTask)} Negative control: ${taskNegativeControlFor(fanTask)}`;
  const requirementLines = fanTasks.map(requirementLineFor);
  const integratedPositiveOracle =
    "The baseline-owned harness emits passing canonical evidence for all four fan-out clauses on the joined commit.";
  const integratedNegativeControl =
    "The baseline-owned harness rejects all frozen planted pending fan-out values.";
  const integratedProofLine =
    `For the joined result, the verifier command task verify:fanout-integrated establishes every admitted clause. Positive oracle: ${integratedPositiveOracle} Negative control: ${integratedNegativeControl}`;
  const liveActionLineFor = (fanTask) =>
    `- Protected action: live_execution provider://openai/${fanTask.taskId} requires explicit human approval.`;
  const liveActionLines = fanTasks.map(liveActionLineFor);
  const mergeActionLine =
    "- Protected action: merge refs/heads/main requires separate explicit human approval.";
  const nonGoalText = "Modify any path outside the four admitted task write roots.";
  const nonGoalLine = `- Non-goal: ${nonGoalText}`;
  const supportingContextLine =
    "[[support/REF-HUM-FanoutVerifier]] documents the disposable fan-out verifier.";
  const prd = [
    "---",
    "type: prd",
    "status: active",
    "version: 1.0.0",
    "---",
    "",
    "# CCC Fusion Product Fan-Out Slice",
    "",
    "## Implementation contract",
    "",
    nonGoalLine,
    "",
    "## Protected actions",
    "",
    ...liveActionLines,
    mergeActionLine,
    "",
    "## Requirement and proof",
    "",
    ...fanTasks.flatMap((fanTask, index) => [
      `### Requirement ${fanTask.requirementId}`,
      requirementLines[index],
      "#### Acceptance clauses",
      `- [${fanoutClauseIdFor(fanTask)}] ${acceptanceFor(fanTask)}`,
      "#### Proof declaration",
      taskProofLineFor(fanTask),
      "",
    ]),
    "## Final integrated proof",
    "",
    integratedProofLine,
    "",
    "## Supporting context",
    "",
    supportingContextLine,
    "",
  ].join("\n");
  const support = [
    "# Fan-out verifier",
    "",
    "The owned verifier reads all four fan files and accepts only their joined values.",
    "",
  ].join("\n");
  await mkdir(path.dirname(supportSourcePath), { recursive: true });
  await writeFile(prdSourcePath, prd);
  await writeFile(supportSourcePath, support);

  const maxRequests = String(fanoutCampaignMaxRequests);
  const maxDurationMs = String(fanoutCampaignMaxDurationMs);
  const frozen = jsonOutput(
    await run(
      process.execPath,
      [
        cliBin,
        "prd",
        "freeze",
        projectsRoot,
        prdSourcePath,
        packetRoot,
        "--target",
        targetRoot,
        "--base",
        targetBase,
        ...fanTasks.flatMap(({ file }) => ["--owned-path", file]),
        ...fanTasks.flatMap(({ file }) => ["--write-root", file]),
        "--write-purpose",
        "disposable product acceptance repository",
        "--max-requests",
        maxRequests,
        "--max-duration-ms",
        maxDurationMs,
        "--max-concurrency",
        "1",
      ],
      { cwd: targetRoot, env },
    ),
    "prd fanout freeze",
  );
  assert(
    frozen.schema === "ccc-prd.freeze-result.v1"
    && frozen.packet?.fileCount === 3
    && frozen.packet?.unresolvedReferenceCount === 0
    && frozen.unresolvedReferences?.length === 0,
    "CCC_PRODUCT_FANOUT_FREEZE_FAILED",
    JSON.stringify(frozen),
  );

  const manifestPath = frozen.manifestPath;
  const proposalPath = path.join(packetRoot, "authoring-proposal.json");
  const sidecarPath = path.join(packetRoot, "candidate.sidecar.json");
  const executionPlanPath = path.join(packetRoot, "execution-plan.json");
  const frozenPrdRelativePath = `sources/${prdFileName}`;
  const frozenContextRelativePath =
    "sources/__fusion__/REF-HUM-FusionOperatorContext.md";
  const contextRef = (exactQuote) => ({
    path: frozenContextRelativePath,
    exactQuote,
  });
  const prdRef = (exactQuote) => ({
    path: frozenPrdRelativePath,
    exactQuote,
  });
  const fusionStateWriteRoot = path.join(targetRoot, ".fusion");
  const custodyRefsFor = (fanTask) => [
    contextRef(`- Task owned path: ${fanTask.file}`),
    contextRef(`- Task allowed write root: ${fanTask.file}`),
    contextRef(`- Allowed write root: ${path.join(targetRoot, fanTask.file)}`),
  ];
  const entryImplementationRefs = [
    contextRef(`- Target repository: ${targetRoot}`),
    contextRef(`- Baseline commit: ${targetBase}`),
    contextRef(`- Allowed write root: ${fusionStateWriteRoot}`),
    contextRef(
      "- Allowed write root purpose: Fusion-managed campaign state and artifacts",
    ),
    contextRef(
      "- Allowed write root purpose: disposable product acceptance repository",
    ),
    contextRef(`- Maximum requests: ${maxRequests}`),
    contextRef(`- Maximum duration in milliseconds: ${maxDurationMs}`),
    contextRef("- Maximum concurrency: 1"),
  ];
  const requirementLineByTaskId = new Map(
    fanTasks.map((fanTask, index) => [fanTask.taskId, requirementLines[index]]),
  );
  const taskProofLineByTaskId = new Map(
    fanTasks.map((fanTask) => [fanTask.taskId, taskProofLineFor(fanTask)]),
  );
  const requirementIdByTaskId = new Map(
    fanTasks.map((fanTask) => [fanTask.taskId, fanTask.requirementId]),
  );
  const edges = fanTasks.flatMap((fanTask) =>
    fanTask.dependencyTaskIds.map((dependencyTaskId) => ({
      id: `EDGE-FAN-${fanTask.taskId.slice("TASK-FAN-".length)}-${dependencyTaskId.slice("TASK-FAN-".length)}`,
      fromTaskId: fanTask.taskId,
      toTaskId: dependencyTaskId,
      kind: "depends_on",
    })));
  const proposal = {
    schema: "ccc-prd.authoring-proposal.v2",
    authorityRoles: [
      {
        id: "AUTHORITY-FANOUT",
        role: "root",
        sourcePaths: [frozenPrdRelativePath],
        accountableProducer: "product-owner",
      },
      {
        id: "AUTHORITY-FANOUT-CONTEXT",
        role: "support",
        sourcePaths: [frozenContextRelativePath],
        accountableProducer: "operator",
      },
    ],
    requirements: fanTasks.map((fanTask) => ({
      id: fanTask.requirementId,
      statement: statementFor(fanTask),
      acceptance: acceptanceFor(fanTask),
      acceptanceClauses: [{
        id: fanoutClauseIdFor(fanTask),
        requirementId: fanTask.requirementId,
        text: acceptanceFor(fanTask),
        proofIds: ["PROOF-FANOUT-INTEGRATED", fanoutTaskProofIdFor(fanTask)],
        sourceRefs: [prdRef(acceptanceFor(fanTask))],
      }],
      acceptanceDispositions: [],
      accountableProducer: "campaign-coding-agent",
      dependencies: fanTask.dependencyTaskIds.map((taskId) =>
        requirementIdByTaskId.get(taskId)),
      proofIds: ["PROOF-FANOUT-INTEGRATED", fanoutTaskProofIdFor(fanTask)],
      sourceRefs: [
        prdRef(requirementLineByTaskId.get(fanTask.taskId)),
        prdRef(acceptanceFor(fanTask)),
      ],
      confidence: "high",
    })),
    proofs: [
      ...fanTasks.map((fanTask) => semanticProofProposal({
        id: fanoutTaskProofIdFor(fanTask),
        requirementIds: [fanTask.requirementId],
        clauseIds: [fanoutClauseIdFor(fanTask)],
        phases: ["task"],
        command: fanoutTaskProofCommandFor(fanTask),
        positiveOracle: taskPositiveOracleFor(fanTask),
        positiveCases: [{
          id: `CASE-${fanTask.taskId.slice("TASK-".length)}`,
          description: taskPositiveOracleFor(fanTask),
        }],
        negativeControls: [{
          id: `CONTROL-${fanTask.taskId.slice("TASK-".length)}-PENDING`,
          description: taskNegativeControlFor(fanTask),
        }],
        harnessPath: "verify-fanout.cjs",
        candidateInputs: [fanTask.file],
        sourceRefs: [prdRef(taskProofLineByTaskId.get(fanTask.taskId))],
      })),
      semanticProofProposal({
        id: "PROOF-FANOUT-INTEGRATED",
        requirementIds: fanTasks.map(({ requirementId }) => requirementId),
        clauseIds: fanTasks.map(fanoutClauseIdFor),
        phases: ["final_integrated"],
        command: "task verify:fanout-integrated",
        positiveOracle: integratedPositiveOracle,
        positiveCases: [{
          id: "CASE-FANOUT-INTEGRATED",
          description: integratedPositiveOracle,
        }],
        negativeControls: [{
          id: "CONTROL-FANOUT-INTEGRATED-PENDING",
          description: integratedNegativeControl,
        }],
        harnessPath: "verify-fanout.cjs",
        candidateInputs: fanTasks.map(({ file }) => file),
        sourceRefs: [prdRef(integratedProofLine)],
      }),
    ],
    tasks: fanTasks.map((fanTask) => ({
      id: fanTask.taskId,
      title: `Implement the admitted ${fanTask.file} change`,
      description:
        `Edit only ${fanTask.file} so the exact fan-out verifier passes; the Fusion controller creates the campaign commit.`,
      ownedPaths: [fanTask.file],
      allowedWriteRoots: [fanTask.file],
      accountableProducer: "campaign-coding-agent",
      requirementIds: [fanTask.requirementId],
      dependencyTaskIds: [...fanTask.dependencyTaskIds],
      proofIds: [fanoutTaskProofIdFor(fanTask)],
      workflowId: "WORKFLOW-FANOUT",
      documentIds: [],
      artifactIds: [],
      protectedActionIds: fanTask.role === "join"
        ? [fanTask.actionId, "ACTION-FAN-MERGE"]
        : [fanTask.actionId],
      sourceRefs: [
        ...(fanTask.role === "entry" ? entryImplementationRefs : []),
        ...custodyRefsFor(fanTask),
        prdRef(nonGoalLine),
        prdRef(requirementLineByTaskId.get(fanTask.taskId)),
        prdRef(taskProofLineByTaskId.get(fanTask.taskId)),
        prdRef(liveActionLineFor(fanTask)),
        ...(fanTask.role === "join" ? [prdRef(mergeActionLine)] : []),
        ...(fanTask.role === "join" ? [prdRef(integratedProofLine)] : []),
        ...(fanTask.role === "entry" ? [prdRef(supportingContextLine)] : []),
      ],
    })),
    // Edges must mirror dependencyTaskIds exactly (fromTaskId = dependent):
    // the compiler reads dependencyTaskIds for ordering while the importer
    // persists dependency rows from edges.
    edges,
    workflows: [{
      id: "WORKFLOW-FANOUT",
      title: "CCC Fusion product fan-out slice",
      taskIds: fanTasks.map(({ taskId }) => taskId),
      entryTaskIds: ["TASK-FAN-A"],
      terminalTaskIds: ["TASK-FAN-D"],
      sourceRefs: [prdRef(requirementLineByTaskId.get("TASK-FAN-A"))],
    }],
    documents: [],
    artifacts: [],
    importIntents: [
      ...fanTasks.map((fanTask) => ({
        id: `IMPORT-FAN-${fanTask.taskId.slice("TASK-FAN-".length)}-TASK`,
        entityType: "task",
        entityId: fanTask.taskId,
        operation: "create",
        target: "project.tasks",
      })),
      ...edges.map((edge) => ({
        id: `IMPORT-${edge.id}`,
        entityType: "dependency_edge",
        entityId: edge.id,
        operation: "create",
        target: "project.tasks.dependencies",
      })),
      {
        id: "IMPORT-FANOUT-WORKFLOW",
        entityType: "workflow",
        entityId: "WORKFLOW-FANOUT",
        operation: "create",
        target: "project.workflow_work_items",
      },
      {
        id: "IMPORT-FANOUT-WORK-ITEM",
        entityType: "work_item",
        entityId: "WORKFLOW-FANOUT",
        operation: "create",
        target: "project.workflow_work_items",
      },
      {
        id: "IMPORT-FANOUT-CAMPAIGN",
        entityType: "campaign",
        entityId: "CAMPAIGN-FANOUT",
        operation: "create",
        target: "project.missions",
      },
      {
        id: "IMPORT-FANOUT-SOURCE",
        entityType: "source",
        entityId: "SOURCE-FANOUT",
        operation: "create",
        target: "project.ccc_prd_import_sources",
      },
      {
        id: "IMPORT-FANOUT-AUDIT",
        entityType: "run_audit",
        entityId: "CAMPAIGN-FANOUT",
        operation: "create",
        target: "project.run_audit_events",
      },
    ],
    protectedActions: [
      ...fanTasks.map((fanTask) => ({
        id: fanTask.actionId,
        kind: "live_execution",
        target: `provider://openai/${fanTask.taskId}`,
        requiresOperatorDecision: true,
        operatorDecision: "approve_live_execution",
        sourceRefs: [prdRef(liveActionLineFor(fanTask))],
      })),
      {
        id: "ACTION-FAN-MERGE",
        kind: "merge",
        target: "refs/heads/main",
        requiresOperatorDecision: true,
        operatorDecision: "approve_merge",
        sourceRefs: [prdRef(mergeActionLine)],
      },
    ],
    bounds: {
      // Four provider tasks need an eight-request structural floor. Keep a
      // second full floor of headroom so the fixture exercises the product's
      // generous-envelope policy rather than balancing on minimum admission.
      maxRequests: Number(maxRequests),
      maxDurationMs: Number(maxDurationMs),
      maxConcurrency: 1,
    },
    admittedWriteRoots: [
      {
        path: fusionStateWriteRoot,
        purpose: "Fusion-managed campaign state and artifacts",
      },
      ...fanTasks.map((fanTask) => ({
        path: path.join(targetRoot, fanTask.file),
        purpose: "disposable product acceptance repository",
      })),
    ],
    targetRepository: { path: targetRoot, baseCommit: targetBase },
    nonGoals: [nonGoalText],
    unresolvedDecisions: [],
    ambiguities: [],
    exceptions: [],
    confidence: "high",
  };
  await writeFile(proposalPath, `${JSON.stringify(proposal, null, 2)}\n`);
  return {
    manifestPath,
    proposalPath,
    sidecarPath,
    executionPlanPath,
    freeze: {
      packetHash: frozen.packet.packetHash,
      manifestSha256: frozen.packet.manifestSha256,
      fileCount: frozen.packet.fileCount,
    },
  };
}

async function writeFakeCodex(fakeBin) {
  await mkdir(fakeBin, { recursive: true });
  const fakeCodexPath = path.join(fakeBin, "codex");
  await writeFile(
    fakeCodexPath,
    [
      `#!${process.execPath}`,
      "const fs = require('node:fs');",
      "const { spawnSync } = require('node:child_process');",
      "const args = process.argv.slice(2);",
      "const cutpointActivation = "
        + JSON.stringify(path.join(fakeBin, "provider-cutpoint.activate"))
        + ";",
      "const cutpointMarker = "
        + JSON.stringify(path.join(fakeBin, "provider-cutpoint.marker.json"))
        + ";",
      "const cutpointInvocationLog = "
        + JSON.stringify(path.join(fakeBin, "provider-cutpoint.invocations.jsonl"))
        + ";",
      "const proofCutpointActivation = "
        + JSON.stringify(path.join(fakeBin, "proof-cutpoint.activate"))
        + ";",
      "const cutpointActive = Boolean(cutpointActivation && fs.existsSync(cutpointActivation));",
      "const proofCutpointActive = Boolean(proofCutpointActivation && fs.existsSync(proofCutpointActivation));",
      "if (cutpointActive && cutpointInvocationLog) {",
      "  fs.appendFileSync(cutpointInvocationLog, JSON.stringify({ pid: process.pid, cwd: process.cwd(), executable: process.argv[1] }) + '\\n');",
      "}",
      "let notifyProgram;",
      "for (let index = 0; index < args.length - 1; index += 1) {",
      "  if (args[index] !== '-c' || !args[index + 1].startsWith('notify=')) continue;",
      "  const parsed = JSON.parse(args[index + 1].slice('notify='.length));",
      "  notifyProgram = Array.isArray(parsed) ? parsed[0] : undefined;",
      "}",
      "if (!notifyProgram) {",
      "  process.stderr.write('FAKE_CODEX_NOTIFY_PROGRAM_MISSING\\n');",
      "  process.exit(9);",
      "}",
      "let handled = false;",
      "let injectedPrompt = '';",
      "if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {",
      "  process.stdin.setRawMode(true);",
      "}",
      "process.stdout.write('\\u001b[?2004h>\\n');",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => {",
      "  if (handled) return;",
      "  injectedPrompt += chunk;",
      "  if (!injectedPrompt.includes('\\u001b[201~\\r')) return;",
      "  handled = true;",
      // The sealed prompt is per task, so the required facts are per task too.
      // The branch key is the task's own allowed-write-root block rather than
      // its id, because one semantic task id is a prefix of the other. The
      // non-goal sentence is per profile because the vertical packet admits
      // two write roots while the fan-out packet admits four.
      "  const sharedPromptFacts = [",
      "    'Do not run git add, git commit, or mutate Git refs',",
      "  ];",
      "  const taskProfiles = [",
      "    {",
      "      marker: 'Allowed write roots:\\n- src/second.txt',",
      "      editPath: 'src/second.txt',",
      "      editContent: 'second-good\\n',",
      "      facts: [",
      "        'Modify any path outside the two admitted task write roots.',",
      "        'Semantic task: TASK-VERTICAL-SECOND\\nAccountable producer:',",
      "        'Change src/second.txt from pending to second-good in a chained isolated worktree that already contains the first task\\u0027s commit.',",
      "        'The trusted verifier accepts src/second.txt only when its candidate value is second-good.',",
      "        'Command: task verify:vertical-second',",
      "        '- CONTROL-VERTICAL-PENDING: The baseline-owned harness rejects the frozen planted pending value.',",
      "        'ACTION-VERTICAL-SECOND-LIVE: live_execution on provider://openai/TASK-VERTICAL-SECOND; requires human decision approve_live_execution.',",
      "        'requires human decision approve_merge',",
      "      ],",
      "    },",
      "    {",
      "      marker: 'Allowed write roots:\\n- src/value.txt',",
      "      editPath: 'src/value.txt',",
      "      editContent: 'good\\n',",
      "      facts: [",
      "        'Modify any path outside the two admitted task write roots.',",
      "        'Semantic task: TASK-VERTICAL\\nAccountable producer:',",
      "        'Change src/value.txt from bad to good in an isolated worktree.',",
      "        'The trusted verifier accepts src/value.txt only when its candidate value is good.',",
      "        'Command: task verify:vertical-value',",
      "        '- CONTROL-VERTICAL-BAD: The baseline-owned harness rejects the frozen planted bad value.',",
      "        'ACTION-VERTICAL-LIVE: live_execution on provider://openai/TASK-VERTICAL; requires human decision approve_live_execution.',",
      "      ],",
      "    },",
      ...fanTasks.map((fanTask) => [
        "    {",
        `      marker: 'Allowed write roots:\\n- ${fanTask.file}',`,
        `      editPath: ${JSON.stringify(fanTask.file)},`,
        `      editContent: ${JSON.stringify(`${fanTask.value}\n`)},`,
        "      facts: [",
        "        'Modify any path outside the four admitted task write roots.',",
        `        'Semantic task: ${fanTask.taskId}\\nAccountable producer:',`,
        `        'Change ${fanTask.file} from pending to ${fanTask.value}',`,
        `        'The trusted verifier accepts ${fanTask.file} only when its candidate value is ${fanTask.value}.',`,
        `        'Command: ${fanoutTaskProofCommandFor(fanTask)}',`,
        `        '- CONTROL-${fanTask.taskId.slice("TASK-".length)}-PENDING: The baseline-owned harness rejects the frozen planted pending value for ${fanTask.file}.',`,
        `        '${fanTask.actionId}: live_execution on provider://openai/${fanTask.taskId}; requires human decision approve_live_execution.',`,
        ...(fanTask.role === "join"
          ? ["        'requires human decision approve_merge',"]
          : []),
        "      ],",
        "    },",
      ].join("\n")),
      "  ];",
      "  const profile = taskProfiles.find((candidate) => injectedPrompt.includes(candidate.marker));",
      "  if (!profile) {",
      "    process.stderr.write('FAKE_CODEX_SEALED_PROMPT_TASK_UNRECOGNIZED\\n');",
      "    process.exit(12);",
      "  }",
      "  const requiredPromptFacts = [...sharedPromptFacts, ...profile.facts];",
      "  const missingPromptFacts = requiredPromptFacts.filter((fact) => !injectedPrompt.includes(fact));",
      "  if (missingPromptFacts.length > 0) {",
      "    process.stderr.write(`FAKE_CODEX_SEALED_PROMPT_MISSING:${JSON.stringify(missingPromptFacts)}\\n`);",
      "    process.exit(10);",
      "  }",
      "  if (cutpointActive && cutpointMarker) {",
      "    try {",
      "      fs.writeFileSync(cutpointMarker, JSON.stringify({ pid: process.pid, cwd: process.cwd(), executable: process.argv[1] }), { flag: 'wx' });",
      "    } catch (error) {",
      "      process.stderr.write('FAKE_CODEX_CUTPOINT_MARKER_REFUSED:' + String(error) + '\\n');",
      "      process.exit(11);",
      "    }",
      "    process.stdout.write('CAMPAIGN_PROVIDER_CUTPOINT_READY\\n');",
      "    setInterval(() => {}, 1000);",
      "    return;",
      "  }",
      `  const editContent = proofCutpointActive && profile.editPath === 'src/value.txt' ? ${JSON.stringify(`${proofCutpointCandidateValue}\n`)} : profile.editContent;`,
      "  fs.writeFileSync(profile.editPath, editContent);",
      "  const payload = JSON.stringify({",
      "    type: 'agent-turn-complete',",
      "    'thread-id': `acceptance-${process.pid}`,",
      "    'turn-id': 'turn-1',",
      "    cwd: process.cwd(),",
      "    'last-assistant-message': 'admitted source edit ready for controller commit',",
      "  });",
      "  const notified = spawnSync(notifyProgram, [payload], { encoding: 'utf8' });",
      "  if (notified.status !== 0) {",
      "    process.stderr.write(`FAKE_CODEX_NOTIFY_FAILED:${JSON.stringify(notified)}\\n`);",
      "    process.exit(8);",
      "  }",
      "  process.stdout.write('CAMPAIGN_SOURCE_EDIT_READY\\n');",
      "  setInterval(() => {}, 1000);",
      "});",
      "",
    ].join("\n"),
  );
  await chmod(fakeCodexPath, 0o700);
}

async function startServe(targetRoot, env, port) {
  const child = spawn(
    process.execPath,
    [
      cliBin,
      "serve",
      "--port",
      String(port),
      "--host",
      "127.0.0.1",
    ],
    {
      cwd: targetRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const exited = new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const server = {
    child,
    exited,
    output: () => output,
  };
  const health = `http://127.0.0.1:${port}/api/health`;
  try {
    await poll(
      "fn serve health",
      async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 2_000);
        try {
          const response = await fetch(health, { signal: controller.signal });
          const body = await response.json();
          return { httpStatus: response.status, body };
        } finally {
          clearTimeout(timer);
        }
      },
      (result) =>
        result.httpStatus === 200
        && result.body?.status === "ok"
        && result.body?.holding !== true
        && result.body?.engine?.available === true
        && result.body?.database?.healthy === true
        && result.body?.taskIdIntegrity?.status === "ok",
      async () => ({ output: tail(output), exit: await Promise.race([
        exited,
        new Promise((resolve) => setTimeout(() => resolve("still-running"), 10)),
      ]) }),
      180_000,
    );
  } catch (error) {
    await stopServe(server);
    throw error;
  }
  return server;
}

async function stopServe(server) {
  if (!server || server.child.exitCode !== null) return;
  server.child.kill("SIGTERM");
  const result = await Promise.race([
    server.exited,
    new Promise((resolve) => setTimeout(() => resolve(null), shutdownTimeoutMs)),
  ]);
  if (result === null && server.child.exitCode === null) {
    server.child.kill("SIGKILL");
    await server.exited;
  }
}

async function crashServe(server) {
  assert(
    server && server.child.exitCode === null,
    "CCC_PRODUCT_CRASH_TARGET_INVALID",
    JSON.stringify({ pid: server?.child?.pid, exitCode: server?.child?.exitCode }),
  );
  server.child.kill("SIGKILL");
  const result = await server.exited;
  assert(
    result.signal === "SIGKILL",
    "CCC_PRODUCT_CRASH_SIGNAL_DRIFT",
    JSON.stringify(result),
  );
  return result;
}

async function readJsonLines(filePath) {
  if (!await pathExists(filePath)) return [];
  return (await readFile(filePath, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function terminateOwnedCutpointProcess(marker, fakeCodexPath) {
  assert(
    Number.isSafeInteger(marker?.pid) && marker.pid > 1,
    "CCC_PRODUCT_CUTPOINT_PID_INVALID",
    JSON.stringify(marker),
  );
  const inspected = await run(
    "/bin/ps",
    ["-p", String(marker.pid), "-o", "command="],
    { allowedExitCodes: [0, 1] },
  );
  assert(
    inspected.code === 0
      && marker.executable === fakeCodexPath
      && inspected.stdout.includes(fakeCodexPath),
    "CCC_PRODUCT_CUTPOINT_PROCESS_OWNERSHIP_REFUSED",
    JSON.stringify({ marker, command: inspected.stdout.trim() }),
  );
  process.kill(marker.pid, "SIGKILL");
  await poll(
    "owned cutpoint process termination",
    async () => {
      const result = await run(
        "/bin/ps",
        ["-p", String(marker.pid), "-o", "command="],
        { allowedExitCodes: [0, 1] },
      );
      return result.code === 1;
    },
    (exited) => exited === true,
    undefined,
    shutdownTimeoutMs,
  );
  return inspected.stdout.trim();
}

async function cleanupOwnedCutpointProcess(marker, fakeCodexPath) {
  if (!marker || !fakeCodexPath || !Number.isSafeInteger(marker.pid)) return;
  const inspected = await run(
    "/bin/ps",
    ["-p", String(marker.pid), "-o", "command="],
    { allowedExitCodes: [0, 1] },
  );
  if (
    inspected.code === 0
    && marker.executable === fakeCodexPath
    && inspected.stdout.includes(fakeCodexPath)
  ) {
    process.kill(marker.pid, "SIGKILL");
  }
}

async function readOwnedProofCutpointMarkers(token, proofExecutionTmpRoot = tmpdir()) {
  if (!token) return [];
  const canonicalTmp = await realpath(proofExecutionTmpRoot);
  const executionEntries = await readdir(canonicalTmp, { withFileTypes: true });
  const markers = [];
  for (const executionEntry of executionEntries) {
    if (
      !executionEntry.isDirectory()
      || !executionEntry.name.startsWith("ccc-semantic-proof-execution-")
    ) {
      continue;
    }
    const executionRoot = await realpath(
      path.join(canonicalTmp, executionEntry.name),
    );
    if (path.dirname(executionRoot) !== canonicalTmp) continue;
    const proofRoot = await realpath(path.join(executionRoot, "proof"))
      .catch(() => undefined);
    const scratchRoot = await realpath(path.join(executionRoot, "scratch"))
      .catch(() => undefined);
    if (!proofRoot || !scratchRoot || path.basename(proofRoot) !== "proof") {
      continue;
    }
    const verifierHome = await realpath(path.join(scratchRoot, "home"))
      .catch(() => undefined);
    if (!verifierHome || path.dirname(verifierHome) !== scratchRoot) continue;
    const markerPath = path.join(verifierHome, proofCutpointMarkerName);
    const markerMetadata = await lstat(markerPath).catch(() => undefined);
    if (!markerMetadata?.isFile() || markerMetadata.isSymbolicLink()) continue;
    const marker = JSON.parse(await readFile(markerPath, "utf8"));
    if (marker?.token !== token || typeof marker.cwd !== "string") continue;
    const markerProofRoot = await realpath(marker.cwd).catch(() => undefined);
    if (markerProofRoot !== proofRoot) continue;
    markers.push(Object.freeze({
      ...marker,
      executionRoot,
      proofRoot,
      scratchRoot,
      verifierHome,
      markerPath,
    }));
  }
  return markers.sort((left, right) => left.pid - right.pid);
}

async function terminateOwnedProofCutpointProcess(
  marker,
  token,
  expectedProofRoot,
) {
  const expectedTitle = `cccp-${token.slice(0, 8)}`;
  assert(
    marker?.token === token
      && marker.processTitle === expectedTitle
      && Number.isSafeInteger(marker.pid)
      && marker.pid > 1
      && typeof marker.cwd === "string"
      && await realpath(marker.cwd) === expectedProofRoot
      && await realpath(marker.proofRoot) === expectedProofRoot
      && path.dirname(expectedProofRoot) === marker.executionRoot
      && marker.scratchRoot === path.join(marker.executionRoot, "scratch")
      && marker.verifierHome === path.dirname(marker.markerPath)
      && path.dirname(marker.verifierHome) === marker.scratchRoot,
    "CCC_PRODUCT_PROOF_CUTPOINT_MARKER_INVALID",
    JSON.stringify({ marker, expectedProofRoot }),
  );
  const inspected = await run(
    "/bin/ps",
    ["-p", String(marker.pid), "-o", "command="],
    { allowedExitCodes: [0, 1] },
  );
  assert(
    inspected.code === 0
      && inspected.stdout.trim().startsWith(expectedTitle),
    "CCC_PRODUCT_PROOF_CUTPOINT_PROCESS_OWNERSHIP_REFUSED",
    JSON.stringify({ marker, command: inspected.stdout.trim() }),
  );
  process.kill(marker.pid, "SIGKILL");
  await poll(
    "owned proof cutpoint process termination",
    async () => {
      const result = await run(
        "/bin/ps",
        ["-p", String(marker.pid), "-o", "command="],
        { allowedExitCodes: [0, 1] },
      );
      return result.code === 1;
    },
    (exited) => exited === true,
    undefined,
    shutdownTimeoutMs,
  );
  return inspected.stdout.trim();
}

async function cleanupOwnedProofCutpointMarkers(token, proofExecutionTmpRoot = tmpdir()) {
  const canonicalTmp = await realpath(proofExecutionTmpRoot);
  const markers = await readOwnedProofCutpointMarkers(token, canonicalTmp);
  for (const marker of markers) {
    const inspected = await run(
      "/bin/ps",
      ["-p", String(marker.pid), "-o", "command="],
      { allowedExitCodes: [0, 1] },
    );
    if (inspected.code === 1) continue;
    const expectedTitle = `cccp-${token.slice(0, 8)}`;
    if (
      marker.processTitle === expectedTitle
      && inspected.stdout.trim().startsWith(expectedTitle)
    ) {
      process.kill(marker.pid, "SIGKILL");
      await poll(
        "owned proof cutpoint cleanup",
        async () => {
          const result = await run(
            "/bin/ps",
            ["-p", String(marker.pid), "-o", "command="],
            { allowedExitCodes: [0, 1] },
          );
          return result.code === 1;
        },
        (exited) => exited === true,
        undefined,
        shutdownTimeoutMs,
      );
    }
  }
}

async function cleanupOwnedProofExecutionTmpRoot(proofExecutionTmpRoot) {
  if (!proofExecutionTmpRoot) return;
  const canonicalShortTmpParent = await realpath("/tmp");
  const canonicalRoot = await realpath(proofExecutionTmpRoot).catch(() => undefined);
  if (!canonicalRoot) return;
  if (
    path.dirname(canonicalRoot) !== canonicalShortTmpParent
    || !path.basename(canonicalRoot).startsWith("ccc-prd-proof-")
  ) {
    throw new Error(`CCC_PRODUCT_PROOF_TMP_CLEANUP_ROOT_REFUSED: ${canonicalRoot}`);
  }
  const makeWriteable = async (ownedPath) => {
    const fromRoot = path.relative(canonicalRoot, ownedPath);
    if (
      fromRoot === ".."
      || fromRoot.startsWith(`..${path.sep}`)
      || path.isAbsolute(fromRoot)
    ) {
      throw new Error(`CCC_PRODUCT_PROOF_TMP_CLEANUP_ESCAPE: ${ownedPath}`);
    }
    const metadata = await lstat(ownedPath).catch(() => undefined);
    if (!metadata) return;
    if (metadata.isSymbolicLink()) {
      await unlink(ownedPath);
      return;
    }
    if (!metadata.isDirectory()) {
      await chmod(ownedPath, 0o600);
      return;
    }
    await chmod(ownedPath, 0o700);
    const entries = await readdir(ownedPath, { withFileTypes: true });
    await Promise.all(entries.map((entry) => (
      makeWriteable(path.join(ownedPath, entry.name))
    )));
  };
  await makeWriteable(canonicalRoot);
  await rm(canonicalRoot, { recursive: true, force: true });
}

async function main() {
  const ledger = new AcceptanceLedger(expectedChecks);
  const startedAt = new Date();
  let tempRoot;
  let server;
  let restartedServer;
  let authoringServer;
  let ownedCutpointMarker;
  let ownedFakeCodexPath;
  let ownedProofCutpointToken;
  let proofExecutionTmpRoot;
  let landingCommand;
  let landingCutpoint;
  let repositoryStart;
  try {
    repositoryStart = await repositorySnapshot();
    assertRepositoryClean(repositoryStart, "starting");
    await buildCurrentCli(ledger);
    tempRoot = await mkdtemp(path.join(tmpdir(), "ccc-prd-product-acceptance-"));
    const targetRoot = await realpath(
      await mkdir(path.join(tempRoot, "target"), { recursive: true })
        .then(() => path.join(tempRoot, "target")),
    );
    const packetRoot = path.join(tempRoot, "packet");
    const isolatedHome = await realpath(
      await mkdir(path.join(tempRoot, "home"), { recursive: true })
        .then(() => path.join(tempRoot, "home")),
    );
    const fakeBin = path.join(tempRoot, "fake-bin");
    const worktreesRoot = path.join(tempRoot, "worktrees");
    const shortProofTmpParent = await realpath("/tmp");
    proofExecutionTmpRoot = await realpath(
      await mkdtemp(path.join(shortProofTmpParent, "ccc-prd-proof-")),
    );
    await writeFakeCodex(fakeBin);
    ownedFakeCodexPath = path.join(fakeBin, "codex");
    const env = cleanEnvironment(isolatedHome, fakeBin);
    const serveEnv = Object.freeze({ ...env, TMPDIR: proofExecutionTmpRoot });
    const providerCutpointActivation = path.join(
      fakeBin,
      "provider-cutpoint.activate",
    );
    const providerCutpointMarker = path.join(
      fakeBin,
      "provider-cutpoint.marker.json",
    );
    const providerCutpointInvocations = path.join(
      fakeBin,
      "provider-cutpoint.invocations.jsonl",
    );
    const proofCutpointActivation = path.join(
      fakeBin,
      "proof-cutpoint.activate",
    );
    ownedProofCutpointToken = randomUUID().replaceAll("-", "").slice(0, 16);
    const targetBase = await initializeTarget(targetRoot, {
      proofCutpointToken: ownedProofCutpointToken,
    });
    exactArray(
      (await git(targetRoot, "ls-tree", "--name-only", targetBase))
        .split("\n")
        .filter(Boolean),
      [
        ".gitignore",
        "Taskfile.yml",
        "src",
        "verify-fanout.cjs",
        "verify.cjs",
      ],
      "CCC_PRODUCT_BASELINE_PROOF_CLOSURE_SET_DRIFT",
    );
    const expectedVerticalTaskfile = [
      "version: '3'",
      "",
      "tasks:",
      "  verify:vertical-value:",
      "    cmds:",
      "      - node verify.cjs src/value.txt",
      "  verify:vertical-second:",
      "    cmds:",
      "      - node verify.cjs src/second.txt",
      "  verify:vertical-integrated:",
      "    cmds:",
      "      - node verify.cjs src/value.txt src/second.txt",
    ].join("\n");
    const verticalTaskfileAtBase = await git(
      targetRoot,
      "show",
      `${targetBase}:Taskfile.yml`,
    );
    assert(
      verticalTaskfileAtBase === expectedVerticalTaskfile,
      "CCC_PRODUCT_BASELINE_TASKFILE_CONTRACT_DRIFT",
      verticalTaskfileAtBase,
    );
    const packet = await createPacket(packetRoot, targetRoot, targetBase, env);
    const redSemanticProposal = JSON.parse(
      await readFile(packet.proposalPath, "utf8"),
    );
    const redSemanticSource = await readFile(
      path.join(packetRoot, packet.sourcePath),
      "utf8",
    );
    assertExactAcceptanceClauseGrammar(
      redSemanticSource,
      redSemanticProposal,
      "CCC_PRODUCT_SEMANTIC_V2_SOURCE_CLAUSE_GRAMMAR_INVALID",
    );
    assert(
      redSemanticProposal.schema === "ccc-prd.authoring-proposal.v2"
      && redSemanticSource.includes("- [AC-REQ-VERTICAL-001] "),
      "CCC_PRODUCT_SEMANTIC_V2_AUTHORITY_MISSING",
      JSON.stringify({
        proposalSchema: redSemanticProposal.schema,
        exactClausePresent: redSemanticSource.includes(
          "- [AC-REQ-VERTICAL-001] ",
        ),
      }),
    );
    ledger.pass("current-prd-corpus-manifest", packet.corpus);
    ledger.pass("current-prd-discovered-and-frozen", {
      discovery: packet.discovery,
      freeze: packet.freeze,
    });
    ledger.pass("guided-operator-context-frozen", {
      sourcePath: packet.contextSourcePath,
      ...packet.operatorContext,
    });
    const idempotencyKey = `ccc-product-${randomUUID()}`;

    const targetBaseTree = await git(targetRoot, "rev-parse", `${targetBase}^{tree}`);
    const planted = await run(
      process.execPath,
      ["verify.cjs", "src/value.txt", "src/second.txt"],
      {
      cwd: targetRoot,
      env: {
        ...env,
        CCC_PROOF_ID: "PROOF-VERTICAL-INTEGRATED",
        CCC_PROOF_PHASE: "final_integrated",
        CCC_PROOF_SOURCE_COMMIT: targetBase,
        CCC_PROOF_SOURCE_TREE: targetBaseTree,
      },
      allowedExitCodes: [1],
      },
    );
    const plantedEvidence = JSON.parse(planted.stdout.trim());
    assert(
      plantedEvidence.schema === "ccc-prd.proof-evidence.v2"
      && plantedEvidence.proofId === "PROOF-VERTICAL-INTEGRATED"
      && plantedEvidence.phase === "final_integrated"
      && plantedEvidence.passed === false
      && plantedEvidence.clauseResults.every(({ passed }) => passed === false)
      && plantedEvidence.negativeControlResults.every(
        ({ passed }) => passed === true,
      ),
      "CCC_PRODUCT_NEGATIVE_CONTROL_MISSING",
      planted.stdout,
    );
    ledger.pass("planted-defect-rejected", {
      exitCode: planted.code,
      stdoutSha256: sha256(planted.stdout),
      proofId: plantedEvidence.proofId,
      clauseResults: plantedEvidence.clauseResults,
      negativeControlResults: plantedEvidence.negativeControlResults,
    });

    // Both admitted files stay at their planted values until the campaign is
    // approved and landed, so every residue check covers the whole owned set
    // rather than only the first task's file.
    const plantedSourcesIntact = async () =>
      await readFile(path.join(targetRoot, "src/value.txt"), "utf8") === "bad\n"
      && await readFile(path.join(targetRoot, "src/second.txt"), "utf8")
        === "pending\n";

    // Two tasks mean positional task indexing is no longer meaningful; every
    // task assertion below names the task it is about.
    const taskFor = (status, semanticTaskId) => {
      const found = (status.tasks ?? []).filter((candidate) =>
        candidate?.semanticTaskId === semanticTaskId);
      assert(
        found.length === 1,
        "CCC_PRODUCT_SEMANTIC_TASK_LOOKUP_INVALID",
        JSON.stringify({ semanticTaskId, matched: found.length }),
      );
      return found[0];
    };

    // Semantic-v2 campaigns expose exactly one sealed launch decision. The
    // child approval rows remain visible only as diagnostic member receipts;
    // they never carry confirmations and cannot be spent directly.
    const awaitSealedExecutionAuthorization = async (
      label,
      readKeyStatus,
      expectedMemberCount,
    ) => {
      const issuedFor = (value) => {
        const authorization = value.status?.executionAuthorization;
        const confirmation = value.liveExecutionAuthorizationConfirmation;
        return authorization?.status === "issued"
          && confirmation?.status === "issued"
          && confirmation.authorizationId === authorization.authorizationId
          ? { authorization, confirmation }
          : null;
      };
      const hold = await poll(
        label,
        readKeyStatus,
        (value) => {
          const pending = issuedFor(value);
          return value.status?.workItems?.length === 1
            && value.status.workItems[0]?.state === "manual-required"
            && workItemHasCccPermanentReason(
              value.status.workItems[0],
              "CCC_CAMPAIGN_LIVE_EXECUTION_APPROVAL_REQUIRED",
            )
            && Boolean(pending)
            && value.status.executionAuthorizationMode === "sealed_bundle_v1"
            && value.status.executionAuthorization?.members?.length
              === expectedMemberCount
            && value.status.nextAction?.kind === "approve-execution"
            && value.status.nextAction.executionAuthorizationId
              === pending.authorization.authorizationId;
        },
        async () => ({
          serve: tail(server.output()),
          status: await readKeyStatus(),
        }),
      );
      const pending = issuedFor(hold);
      const authorization = pending?.authorization;
      const confirmation = pending?.confirmation;
      const nextAction = hold.status.nextAction;
      const childApprovalIds = authorization?.members?.map(
        ({ approvalRequestId }) => approvalRequestId,
      ) ?? [];
      const memberCustody = authorization?.memberCustody ?? [];
      const custodyByApprovalId = new Map(memberCustody.map((custody) => [
        custody.approvalRequestId,
        custody,
      ]));
      assert(
        authorization
        && confirmation
        && /^[0-9a-f]{64}$/u.test(confirmation.confirmation)
        && /^ccc-execution-authorization-[0-9a-f]{64}$/u.test(
          authorization.authorizationId,
        )
        && authorization.members.length === expectedMemberCount
        // This is the import-global request counter observed at issuance, not
        // the number of authorized members. A fresh sealed campaign starts at
        // zero and each member later spends against the normal request budget.
        && authorization.expectedRequestCount === 0
        && new Set(childApprovalIds).size === expectedMemberCount
        && memberCustody.length === expectedMemberCount
        && custodyByApprovalId.size === expectedMemberCount
        && authorization.members.every((member) => {
          const custody = custodyByApprovalId.get(member.approvalRequestId);
          return custody?.ordinal === member.ordinal
            && custody.semanticTaskId === member.semanticTaskId
            && custody.nativeTaskId === member.nativeTaskId
            && custody.actionId === member.actionId
            && custody.actionTarget === member.actionTarget
            && custody.bindingHash === member.bindingHash
            && custody.status === "issued";
        })
        && childApprovalIds.every((approvalRequestId) =>
          hold.status.approvals.some(({ id }) => id === approvalRequestId))
        && !JSON.stringify({ authorization, approvals: hold.status.approvals })
          .includes("claimToken")
        && (hold.liveExecutionApprovalConfirmations ?? []).length === 0
        && nextAction?.kind === "approve-execution"
        && nextAction.executionAuthorizationId
          === authorization.authorizationId
        && nextAction.executionAuthorizationStatus === "issued",
        "CCC_PRODUCT_SEALED_EXECUTION_AUTHORIZATION_MISSING",
        JSON.stringify({
          label,
          nextAction,
          authorization,
          parentConfirmation: confirmation,
          childConfirmations: hold.liveExecutionApprovalConfirmations,
        }),
      );
      return {
        hold,
        authorization,
        confirmation,
        childApprovalIds,
        memberCustody,
        nextAction,
      };
    };

    // The operator loop prints human-readable prose by default, so every
    // machine-read assertion below asks for the exact JSON payload.
    const prd = async (args, allowedExitCodes = [0]) => {
      return await run(process.execPath, [cliBin, "prd", ...args, "--json"], {
        cwd: targetRoot,
        env,
        allowedExitCodes,
      });
    };
    const prdHumanReadable = async (args, allowedExitCodes = [0]) => {
      return await run(process.execPath, [cliBin, "prd", ...args], {
        cwd: targetRoot,
        env,
        allowedExitCodes,
      });
    };
    const commonPacketArgs = [
      packetRoot,
      packet.manifestPath,
      packet.sidecarPath,
      packet.executionPlanPath,
      targetRoot,
      targetBase,
    ];

    const proposalText = await readFile(packet.proposalPath, "utf8");
    const loopbackAuthoringApiKey = "ccc-local-loopback-non-secret";
    const globalSettingsDir = path.join(isolatedHome, ".fusion");
    const globalSettingsPath = path.join(globalSettingsDir, "settings.json");
    await mkdir(globalSettingsDir, { recursive: true });
    const configureNativeAuthoring = async (baseUrl) => {
      await writeFile(globalSettingsPath, `${JSON.stringify({
        openrouterModelSync: false,
        opencodeGoModelSync: false,
        customProviders: [{
          id: "550e8400-e29b-41d4-a716-446655440004",
          name: "CCC Product Authoring",
          apiType: "openai-compatible",
          baseUrl,
          apiKey: loopbackAuthoringApiKey,
          models: [{
            id: "vertical-authoring-model",
            name: "Vertical Authoring Model",
            // Design §8 finding 4: a fail-closed verbatimCapable gate would
            // otherwise refuse both frozen native checks with zero POSTs.
            // This is fixture setup (the disposable loopback server does
            // return verbatim quotes), not a claim about a real model.
            verbatimCapable: true,
          }],
        }],
      }, null, 2)}\n`);
    };

    const understandingProposal = legacyV1ProposalFromV2(
      JSON.parse(proposalText),
    );
    understandingProposal.targetRepository = { path: "", baseCommit: "" };
    understandingProposal.bounds = {
      maxRequests: 0,
      maxDurationMs: 0,
      maxConcurrency: 0,
    };
    understandingProposal.admittedWriteRoots = [];
    const nativeUnderstanding = await startNativeAuthoringServer(
      JSON.stringify(understandingProposal),
    );
    authoringServer = nativeUnderstanding.server;
    await configureNativeAuthoring(nativeUnderstanding.baseUrl);
    const understandingReviewPath = path.join(
      packetRoot,
      "understanding-review.json",
    );
    const understood = jsonOutput(
      await prd([
        "understand",
        packetRoot,
        packet.manifestPath,
        understandingReviewPath,
        "--provider",
        "ccc-product-authoring",
        "--model",
        "vertical-authoring-model",
        "--max-duration-ms",
        "120000",
        "--max-prompt-bytes",
        "262144",
        "--max-response-bytes",
        "262144",
        "--max-review-items",
        "4",
      ]),
      "prd native local understand",
    );
    const understandingRequests = nativeUnderstanding.requests.filter(
      ({ method }) => method === "POST",
    );
    const storedUnderstanding = JSON.parse(
      await readFile(understandingReviewPath, "utf8"),
    );
    const understandingValidation = jsonOutput(
      await prd([
        "validate",
        packetRoot,
        packet.manifestPath,
        understandingReviewPath,
        targetRoot,
        targetBase,
      ], [1]),
      "prd validate understanding review",
    );
    const missingImplementationFacts =
      understood.implementationContext?.missingFacts?.map(({ code }) => code)
        ?? [];
    assert(
      understood.schema === "ccc-prd.understanding-review.v1"
        && understood.kind === "understanding-review"
        && understood.executable === false
        && understood.reviewPath === understandingReviewPath
        && understood.implementationContext?.approvalStatus === "unapproved"
        && understood.implementationContext?.targetRepository?.path === null
        && understood.implementationContext?.targetRepository?.baseCommit === null
        && missingImplementationFacts.includes(
          "CCC_PRD_TARGET_REPOSITORY_REQUIRED",
        )
        && missingImplementationFacts.includes("CCC_PRD_BASELINE_REQUIRED")
        && missingImplementationFacts.includes(
          "CCC_PRD_EXECUTION_BOUNDS_REQUIRED",
        )
        && missingImplementationFacts.includes(
          "CCC_PRD_ALLOWED_PATHS_REQUIRED",
        )
        && storedUnderstanding.schema === understood.schema
        && storedUnderstanding.executable === false,
      "CCC_PRODUCT_NATIVE_UNDERSTANDING_REVIEW_INVALID",
      JSON.stringify(understood),
    );
    // Design §7: `lane` is a direct statement of intent in the CLI's JSON
    // wrapper -- not an inference from POST count, which would silently
    // pass if a future two-chunk plan happened to make one call -- and it
    // must never leak into the persisted sidecar (CccPrdUnderstandingReview
    // and its on-disk schema stay exactly as they are today).
    assert(
      understood.lane === "single" && storedUnderstanding.lane === undefined,
      "CCC_PRODUCT_UNDERSTANDING_FAST_LANE_NOT_PRESERVED",
      JSON.stringify({ lane: understood.lane, storedHasLane: "lane" in storedUnderstanding }),
    );
    assert(
      understandingRequests.length === 1
        && understandingRequests[0].url === "/v1/chat/completions"
        && understandingRequests[0].body?.model
          === "vertical-authoring-model"
        && understandingRequests[0].body?.stream === true
        && understandingRequests[0].headers?.authorization
          === `Bearer ${loopbackAuthoringApiKey}`
        && JSON.stringify(
          understandingRequests[0].body?.messages,
        ).includes("review-only")
        && JSON.stringify(
          understandingRequests[0].body?.messages,
        ).includes("CCC Fusion Product Vertical Slice"),
      "CCC_PRODUCT_NATIVE_UNDERSTANDING_REQUEST_INVALID",
      JSON.stringify(understandingRequests),
    );
    assert(
      understandingValidation.kind === "diagnostics"
        && understandingValidation.valid === false
        && understandingValidation.diagnostics?.some(
          ({ code }) => code === "CCC_PRD_UNKNOWN_SIDECAR_SCHEMA",
        ),
      "CCC_PRODUCT_UNDERSTANDING_REVIEW_BECAME_EXECUTABLE",
      JSON.stringify(understandingValidation),
    );
    ledger.pass("native-local-understanding-review", {
      mode: "native-local-loopback-review-only",
      normalCli: true,
      executable: false,
      approvalStatus: understood.implementationContext.approvalStatus,
      externalProviderCalled: false,
      secretConfigured: false,
      credentialMode: "fixed-disposable-non-secret-sentinel",
      requestCount: understandingRequests.length,
      requestSha256: sha256(
        JSON.stringify(understandingRequests[0].body),
      ),
      promptContractObserved: true,
      missingImplementationFacts,
      coverage: {
        inventoryCount: understood.coverage?.inventoryCount,
        dispositionCount: understood.coverage?.dispositionCount,
        missingCount: understood.coverage?.missing?.length,
        conflictCount: understood.coverage?.conflicts?.length,
      },
      storedReviewSha256: sha256(await readFile(understandingReviewPath)),
      executableValidationRefusal:
        "CCC_PRD_UNKNOWN_SIDECAR_SCHEMA",
    });
    ledger.pass("understanding-fast-lane-preserved", {
      lane: understood.lane,
      requestCount: understandingRequests.length,
      laneOmittedFromStoredArtifact: !("lane" in storedUnderstanding),
    });
    await stopNativeAuthoringServer(authoringServer);
    authoringServer = undefined;

    // chunked-understanding-compile-gates (design §9): a two-heading
    // disposable packet, forced onto the chunked lane, run through the
    // compile-side coverage gates with requireMaterialCoverage set
    // (compiler.ts:1376-1448). This check alone would have caught findings
    // 2 and 10 from the design's own adversarial review -- without
    // requireMaterialCoverage the early return at compiler.ts:1391
    // exercises only the two always-on materialCoverage conditions.
    const chunkedPacketRoot = path.join(tempRoot, "chunked-packet");
    await mkdir(chunkedPacketRoot, { recursive: true });
    const chunkedSourceRelativePath = "source.md";
    const chunkedSourceText = [
      "# Alpha",
      "- REQ-1: alpha requirement text.",
      "",
      "# Beta",
      "- REQ-2: beta requirement text.",
    ].join("\n") + "\n";
    await writeFile(
      path.join(chunkedPacketRoot, chunkedSourceRelativePath),
      chunkedSourceText,
    );
    const chunkedManifestPath = path.join(chunkedPacketRoot, "manifest.json");
    await writeFile(chunkedManifestPath, JSON.stringify({
      schema: "ccc-prd.packet.v1",
      source_version: "chunked-gate-fixture",
      entries: [{
        relative_path: chunkedSourceRelativePath,
        role: "root",
        authoritative: true,
        sha256: sha256(chunkedSourceText),
      }],
    }));
    const alphaFragment = JSON.stringify({
      schema: "ccc-prd.authoring-proposal-fragment.v1",
      authorityRoles: [], requirements: [{
        id: "REQ-1",
        statement: "alpha requirement",
        acceptance: "alpha acceptance",
        accountableProducer: "team-a",
        dependencies: [],
        proofIds: [],
        confidence: "high",
        sourceRefs: [{ path: chunkedSourceRelativePath, exactQuote: "- REQ-1: alpha requirement text." }],
      }], proofs: [], tasks: [{
        id: "TASK-ALPHA",
        title: "Ship alpha",
        description: "Implement alpha",
        accountableProducer: "team-a",
        requirementIds: ["REQ-1"],
        dependencyTaskIds: [],
        proofIds: [],
        workflowId: "",
        documentIds: [],
        artifactIds: [],
        protectedActionIds: [],
        ownedPaths: ["src/alpha.ts"],
        allowedWriteRoots: ["src/alpha.ts"],
        sourceRefs: [{ path: chunkedSourceRelativePath, exactQuote: "# Alpha\n- REQ-1: alpha requirement text." }],
      }], edges: [], workflows: [], documents: [], artifacts: [], importIntents: [],
      protectedActions: [], unresolvedDecisions: [], ambiguities: [], exceptions: [],
    });
    const betaFragment = JSON.stringify({
      schema: "ccc-prd.authoring-proposal-fragment.v1",
      authorityRoles: [], requirements: [{
        id: "REQ-2",
        statement: "beta requirement",
        acceptance: "beta acceptance",
        accountableProducer: "team-a",
        dependencies: [],
        proofIds: [],
        confidence: "high",
        sourceRefs: [{ path: chunkedSourceRelativePath, exactQuote: "- REQ-2: beta requirement text." }],
      }], proofs: [], tasks: [{
        id: "TASK-BETA",
        title: "Ship beta",
        description: "Implement beta",
        accountableProducer: "team-a",
        requirementIds: ["REQ-2"],
        dependencyTaskIds: [],
        proofIds: [],
        workflowId: "",
        documentIds: [],
        artifactIds: [],
        protectedActionIds: [],
        ownedPaths: ["src/beta.ts"],
        allowedWriteRoots: ["src/beta.ts"],
        sourceRefs: [{ path: chunkedSourceRelativePath, exactQuote: "# Beta\n- REQ-2: beta requirement text." }],
      }], edges: [], workflows: [], documents: [], artifacts: [], importIntents: [],
      protectedActions: [], unresolvedDecisions: [], ambiguities: [], exceptions: [],
    });
    const chunkedServer = await startChunkedFragmentServer([alphaFragment, betaFragment]);
    let chunkedAuthoringServer = chunkedServer.server;
    await configureNativeAuthoring(chunkedServer.baseUrl);
    const chunkedReviewPath = path.join(chunkedPacketRoot, "understanding-review.json");
    const chunkedUnderstood = jsonOutput(
      await prd([
        "understand",
        chunkedPacketRoot,
        chunkedManifestPath,
        chunkedReviewPath,
        "--provider",
        "ccc-product-authoring",
        "--model",
        "vertical-authoring-model",
        "--max-duration-ms",
        "120000",
        "--max-prompt-bytes",
        "262144",
        "--max-response-bytes",
        "262144",
        "--max-review-items",
        "8",
        "--lane",
        "chunked",
      ]),
      "prd native chunked understand",
    );
    await stopNativeAuthoringServer(chunkedAuthoringServer);
    chunkedAuthoringServer = undefined;
    assert(
      chunkedUnderstood.kind === "understanding-review"
        && chunkedUnderstood.lane === "chunked"
        && chunkedUnderstood.coverage?.missing?.length === 0
        && chunkedUnderstood.coverage?.conflicts?.length === 0
        && chunkedUnderstood.requirements?.length === 2
        && chunkedUnderstood.tasks?.length === 2,
      "CCC_PRODUCT_CHUNKED_UNDERSTANDING_INVALID",
      JSON.stringify(chunkedUnderstood),
    );
    ledger.pass("chunked-understanding-complete-coverage", {
      lane: chunkedUnderstood.lane,
      inventoryCount: chunkedUnderstood.coverage.inventoryCount,
      dispositionCount: chunkedUnderstood.coverage.dispositionCount,
      missingCount: chunkedUnderstood.coverage.missing.length,
      conflictCount: chunkedUnderstood.coverage.conflicts.length,
    });

    // The chunked understanding review carries the ccc-prd.understanding-review.v1
    // schema by design (so it can never be silently compiled as executable),
    // so exercising the compile-side coverage gates means transplanting the
    // SAME material data (requirements/tasks/materialCoverage) into a
    // sidecar-shaped object with target/bounds populated -- the coverage
    // math (compiler.ts:1376-1448) reads only requirements/tasks/
    // materialCoverage/custody, never the executable-approval fields.
    const chunkedSidecarPath = path.join(chunkedPacketRoot, "chunked.sidecar.json");
    await writeFile(chunkedSidecarPath, JSON.stringify({
      schema: "ccc-prd.sidecar.v1",
      sourceVersion: chunkedUnderstood.sourceVersion,
      orderedSources: chunkedUnderstood.orderedSources,
      provenance: chunkedUnderstood.provenance,
      authorityRoles: chunkedUnderstood.authorityRoles,
      requirements: chunkedUnderstood.requirements,
      proofs: chunkedUnderstood.proofs,
      tasks: chunkedUnderstood.tasks,
      edges: chunkedUnderstood.edges,
      workflows: chunkedUnderstood.workflows,
      documents: chunkedUnderstood.documents,
      artifacts: chunkedUnderstood.artifacts,
      importIntents: chunkedUnderstood.proposedImportIntents,
      protectedActions: chunkedUnderstood.protectedActions,
      bounds: { maxRequests: 4, maxDurationMs: 30000, maxConcurrency: 2 },
      admittedWriteRoots: [{ path: targetRoot, purpose: "chunked gate fixture" }],
      targetRepository: { path: targetRoot, baseCommit: targetBase },
      nonGoals: chunkedUnderstood.nonGoals,
      unresolvedDecisions: chunkedUnderstood.unresolvedDecisions,
      ambiguities: chunkedUnderstood.ambiguities,
      exceptions: chunkedUnderstood.exceptions,
      confidence: chunkedUnderstood.confidence,
      materialCoverage: chunkedUnderstood.coverage.dispositions,
    }));
    const chunkedCompileGates = jsonOutput(
      await prd([
        "validate",
        chunkedPacketRoot,
        chunkedManifestPath,
        chunkedSidecarPath,
        targetRoot,
        targetBase,
      ], [0, 1]),
      "prd validate chunked sidecar",
    );
    const chunkedCompileGateCodes = new Set([
      "CCC_PRD_MATERIAL_COVERAGE_REQUIRED",
      "CCC_PRD_MATERIAL_COVERAGE_INVALID",
      "CCC_PRD_MATERIAL_SECTION_UNDISPOSITIONED",
      "CCC_PRD_SOURCE_REQUIREMENT_UNDISPOSITIONED",
      "CCC_PRD_EXTRACTION_IMPLAUSIBLY_SHALLOW",
    ]);
    const chunkedCoverageDiagnostics = (chunkedCompileGates.diagnostics ?? []).filter(
      ({ code }) => chunkedCompileGateCodes.has(code),
    );
    assert(
      chunkedCoverageDiagnostics.length === 0,
      "CCC_PRODUCT_CHUNKED_COMPILE_GATES_FAILED",
      JSON.stringify({ diagnostics: chunkedCompileGates.diagnostics }),
    );
    ledger.pass("chunked-understanding-compile-gates", {
      requireMaterialCoverage: true,
      clearedDiagnosticCodes: [...chunkedCompileGateCodes],
      allDiagnostics: chunkedCompileGates.diagnostics ?? [],
    });

    const nativeAuthoring = await startNativeAuthoringServer(proposalText);
    authoringServer = nativeAuthoring.server;
    await configureNativeAuthoring(nativeAuthoring.baseUrl);
    const authored = jsonOutput(
      await prd([
        "author",
        packetRoot,
        packet.manifestPath,
        packet.sidecarPath,
        "--target",
        targetRoot,
        "--base",
        targetBase,
        "--provider",
        "ccc-product-authoring",
        "--model",
        "vertical-authoring-model",
        "--max-requests",
        String(verticalCampaignMaxRequests),
        "--max-duration-ms",
        String(verticalCampaignMaxDurationMs),
        "--max-concurrency",
        "1",
        "--max-prompt-bytes",
        "262144",
        "--max-response-bytes",
        "262144",
        "--max-review-items",
        "4",
      ]),
      "prd native local author",
    );
    assert(
      authored.kind === "candidate",
      "CCC_PRODUCT_NATIVE_AUTHORING_FAILED",
      JSON.stringify(authored),
    );
    const generationRequests = nativeAuthoring.requests.filter(
      ({ method }) => method === "POST",
    );
    const generationPrompt = (generationRequests[0]?.body?.messages ?? [])
      .map((message) => typeof message?.content === "string" ? message.content : "")
      .join("\n");
    assert(
      generationRequests.length === 1
        && generationRequests[0].url === "/v1/chat/completions"
        && generationRequests[0].body?.model === "vertical-authoring-model"
        && generationRequests[0].body?.stream === true
        && generationRequests[0].headers?.authorization
          === `Bearer ${loopbackAuthoringApiKey}`
        && generationPrompt.includes(
          "Every implementation-changing fact must be source-bound",
        )
        && generationPrompt.includes(
          "CCC Fusion Product Vertical Slice",
        )
        && generationPrompt.includes(
          "Fusion Reviewed Operator Context",
        )
        && generationPrompt.includes(
          '"schema": "ccc-prd.authoring-proposal.v2"',
        )
        && generationPrompt.includes(
          '"acceptanceClauses"',
        ),
      "CCC_PRODUCT_NATIVE_AUTHORING_REQUEST_INVALID",
      JSON.stringify(generationRequests),
    );
    const authoredSidecar = JSON.parse(
      await readFile(packet.sidecarPath, "utf8"),
    );
    const authoredProofsById = new Map(
      (authoredSidecar.proofs ?? []).map((proof) => [proof.id, proof]),
    );
    const semanticProofIds = [
      "PROOF-VERTICAL-INTEGRATED",
      "PROOF-VERTICAL-SECOND-TASK",
      "PROOF-VERTICAL-VALUE-TASK",
    ];
    const semanticClauses = (authoredSidecar.requirements ?? []).flatMap(
      ({ acceptanceClauses = [] }) => acceptanceClauses,
    );
    assert(
      authoredSidecar.schema === "ccc-prd.sidecar.v2"
      && semanticClauses.length === 2
      && semanticClauses.some(({ id }) => id === "AC-REQ-VERTICAL-001")
      && semanticClauses.some(
        ({ id }) => id === "AC-REQ-VERTICAL-SECOND-001",
      )
      && semanticProofIds.every((id) => {
        const proof = authoredProofsById.get(id);
        return proof?.schema === "ccc-prd.proof.v2"
          && proof.admission?.schema === "ccc-prd.proof-admission.v2"
          && proof.verifierClosure?.some(({ role, path, baseGitBlobOid, sha256: digest }) =>
            role === "task_runner"
            && path === "Taskfile.yml"
            && baseGitBlobOid !== semanticProofPlaceholderGitOid
            && digest !== semanticProofPlaceholderSha256)
          && proof.verifierClosure?.some(({ role, path }) =>
            role === "harness" && path === "verify.cjs")
          && proof.executionToolchain?.proofHost?.id
            === "fusion-cli-semantic-proof-host.v1"
          && proof.executionToolchain.proofHost.executablePath
            !== "/model-untrusted/proof-host";
      })
      && authoredProofsById.get("PROOF-VERTICAL-VALUE-TASK")?.phases?.[0]
        === "task"
      && authoredProofsById.get("PROOF-VERTICAL-SECOND-TASK")?.phases?.[0]
        === "task"
      && authoredProofsById.get("PROOF-VERTICAL-INTEGRATED")?.phases?.[0]
        === "final_integrated",
      "CCC_PRODUCT_SEMANTIC_V2_AUTHORITY_INVALID",
      JSON.stringify({
        schema: authoredSidecar.schema,
        clauses: semanticClauses,
        proofs: authoredSidecar.proofs,
      }),
    );
    await assertControllerHydratedProofCustody({
      proof: authoredProofsById.get("PROOF-VERTICAL-VALUE-TASK"),
      targetRoot,
      targetBase,
      command: "task verify:vertical-value",
      phase: "task",
      harnessPath: "verify.cjs",
      candidateInputs: ["src/value.txt"],
    });
    await assertControllerHydratedProofCustody({
      proof: authoredProofsById.get("PROOF-VERTICAL-SECOND-TASK"),
      targetRoot,
      targetBase,
      command: "task verify:vertical-second",
      phase: "task",
      harnessPath: "verify.cjs",
      candidateInputs: ["src/second.txt"],
    });
    await assertControllerHydratedProofCustody({
      proof: authoredProofsById.get("PROOF-VERTICAL-INTEGRATED"),
      targetRoot,
      targetBase,
      command: "task verify:vertical-integrated",
      phase: "final_integrated",
      harnessPath: "verify.cjs",
      candidateInputs: ["src/value.txt", "src/second.txt"],
    });
    assert(
      authoredSidecar.provenance?.authoringAdapterId
        === "fusion-native-model-runtime-v1"
        && authoredSidecar.provenance?.authoringModel
          === "ccc-product-authoring/vertical-authoring-model",
      "CCC_PRODUCT_NATIVE_AUTHORING_PROVENANCE_INVALID",
      JSON.stringify(authoredSidecar.provenance),
    );
    // Both tasks must carry their own source-bound custody: the compiler
    // refuses a multi-task chain whose tasks do not each declare ownedPaths
    // and allowedWriteRoots, and authoring refuses a task whose declared paths
    // are absent from that task's own quoted evidence.
    const taskSpanPathsBySemanticTaskId = Object.fromEntries(
      (authoredSidecar.tasks ?? []).map((authoredTask) => [
        authoredTask.id,
        [...new Set(authoredTask.spans?.map(({ path }) => path) ?? [])].sort(),
      ]),
    );
    exactArray(
      Object.keys(taskSpanPathsBySemanticTaskId).sort(),
      ["TASK-VERTICAL", "TASK-VERTICAL-SECOND"],
      "CCC_PRODUCT_TASK_CUSTODY_TASK_SET_DRIFT",
    );
    for (const [semanticTaskId, spanPaths] of Object.entries(
      taskSpanPathsBySemanticTaskId,
    )) {
      assert(
        spanPaths.includes(packet.sourcePath)
          && spanPaths.includes(packet.contextSourcePath),
        "CCC_PRODUCT_TASK_CUSTODY_SOURCE_BINDING_MISSING",
        JSON.stringify({ semanticTaskId, spanPaths }),
      );
    }
    const taskSpanPaths = taskSpanPathsBySemanticTaskId["TASK-VERTICAL"];
    const implementationFactProvenance =
      await assertExactImplementationFactProvenance(
        authoredSidecar,
        packetRoot,
        packet.sourcePath,
        {
          targetRoot,
          targetBase,
          fusionStateWriteRoot: path.join(targetRoot, ".fusion"),
          admittedWriteRoot: path.join(targetRoot, "src/value.txt"),
          admittedSecondWriteRoot: path.join(targetRoot, "src/second.txt"),
          contextSourcePath: packet.contextSourcePath,
        },
      );
    const nativeAuthoringEvidence = {
      mode: "native-local-loopback",
      normalCli: true,
      proposalCompatibilityArgumentUsed: false,
      externalProviderCalled: false,
      secretConfigured: false,
      credentialMode: "fixed-disposable-non-secret-sentinel",
      provider: "ccc-product-authoring",
      model: "vertical-authoring-model",
      requestCount: generationRequests.length,
      requestSha256: sha256(JSON.stringify(generationRequests[0].body)),
      promptContractObserved: true,
      taskSpanPaths,
      provenance: authoredSidecar.provenance,
      implementationFactProvenance,
    };
    ledger.pass("native-local-authoring", nativeAuthoringEvidence);
    ledger.pass("semantic-v2-authority-contract", {
      sidecarSchema: authoredSidecar.schema,
      clauseIds: semanticClauses.map(({ id }) => id).sort(),
      proofIds: semanticProofIds,
      taskPhaseProofIds: [
        "PROOF-VERTICAL-SECOND-TASK",
        "PROOF-VERTICAL-VALUE-TASK",
      ],
      finalIntegratedProofId: "PROOF-VERTICAL-INTEGRATED",
      controllerHydrated: true,
      exactSourceAcceptanceClauseGrammar: true,
      verifierClosurePaths: ["Taskfile.yml", "verify.cjs"],
      modelPlaceholderAuthorityDiscarded: true,
    });
    await stopNativeAuthoringServer(authoringServer);
    authoringServer = undefined;
    const validated = jsonOutput(
      await prd([
        "validate",
        packetRoot,
        packet.manifestPath,
        packet.sidecarPath,
        targetRoot,
        targetBase,
      ]),
      "prd validate",
    );
    const compiled = jsonOutput(
      await prd([
        "compile",
        packetRoot,
        packet.manifestPath,
        packet.sidecarPath,
        targetRoot,
        targetBase,
      ]),
      "prd compile",
    );
    assert(
      validated.kind === "diagnostics" && validated.valid === true,
      "CCC_PRODUCT_PACKET_VALIDATION_FAILED",
      JSON.stringify(validated),
    );
    exactArray(
      compiled.requirements?.map(({ id }) => id).sort(),
      ["REQ-VERTICAL", "REQ-VERTICAL-SECOND"],
      "CCC_PRODUCT_REQUIREMENT_SET_DRIFT",
    );
    exactArray(
      compiled.tasks?.map(({ id }) => id).sort(),
      ["TASK-VERTICAL", "TASK-VERTICAL-SECOND"],
      "CCC_PRODUCT_TASK_SET_DRIFT",
    );
    exactArray(
      compiled.proofs?.map(({ id }) => id).sort(),
      [
        "PROOF-VERTICAL-INTEGRATED",
        "PROOF-VERTICAL-SECOND-TASK",
        "PROOF-VERTICAL-VALUE-TASK",
      ],
      "CCC_PRODUCT_PROOF_SET_DRIFT",
    );
    assert(
      compiled.schema === "ccc-prd.bundle.v2",
      "CCC_PRODUCT_SEMANTIC_BUNDLE_VERSION_DRIFT",
      compiled.schema,
    );
    ledger.pass("frozen-packet-validated", {
      packetHash: compiled.sourceHash,
      sidecarHash: compiled.sidecarHash,
      bundleHash: compiled.bundleHash,
      requirementIds: ["REQ-VERTICAL", "REQ-VERTICAL-SECOND"],
      taskIds: ["TASK-VERTICAL", "TASK-VERTICAL-SECOND"],
      proofIds: [
        "PROOF-VERTICAL-INTEGRATED",
        "PROOF-VERTICAL-SECOND-TASK",
        "PROOF-VERTICAL-VALUE-TASK",
      ],
    });

    // Compatibility is intentionally asymmetric: v1 remains parseable for
    // inspection and exact persisted replay, but the normal product commands
    // must not let it mint a fresh secure campaign.
    const legacyProposalPath = path.join(packetRoot, "legacy-v1-proposal.json");
    const legacySidecarPath = path.join(packetRoot, "legacy-v1-sidecar.json");
    const legacyExecutionPlanPath = path.join(
      packetRoot,
      "legacy-v1-execution-plan.json",
    );
    await writeFile(
      legacyProposalPath,
      `${JSON.stringify(
        legacyV1ProposalFromV2(JSON.parse(proposalText)),
        null,
        2,
      )}\n`,
    );
    const legacyAuthored = jsonOutput(
      await prd([
        "author",
        packetRoot,
        packet.manifestPath,
        legacyProposalPath,
        legacySidecarPath,
      ]),
      "prd legacy v1 proposal-file author",
    );
    const legacyValidated = jsonOutput(
      await prd([
        "validate",
        packetRoot,
        packet.manifestPath,
        legacySidecarPath,
        targetRoot,
        targetBase,
      ]),
      "prd legacy v1 validate",
    );
    const legacyCompiled = jsonOutput(
      await prd([
        "compile",
        packetRoot,
        packet.manifestPath,
        legacySidecarPath,
        targetRoot,
        targetBase,
      ]),
      "prd legacy v1 compile",
    );
    assert(
      legacyAuthored.kind === "candidate"
      && legacyValidated.kind === "diagnostics"
      && legacyValidated.valid === true
      && legacyCompiled.schema === "ccc-prd.bundle.v1",
      "CCC_PRODUCT_LEGACY_V1_READABILITY_DRIFT",
      JSON.stringify({ legacyAuthored, legacyValidated, legacyCompiled }),
    );

    // One route profile per task, selected through the product's own
    // routes-by-task file rather than a single flag set broadcast to every
    // task. Both profiles are CLI/codex and differ by model; the pi transport
    // is deliberately not exercised here.
    const routesFilePath = path.join(packetRoot, "routes.json");
    const routeProfiles = {
      "TASK-VERTICAL": {
        providerId: "openai",
        modelId: "gpt-5.6-sol",
        transport: "cli",
        cliAdapterId: "codex",
      },
      "TASK-VERTICAL-SECOND": {
        providerId: "openai",
        modelId: "gpt-5.6-terra",
        transport: "cli",
        cliAdapterId: "codex",
      },
    };
    await writeFile(
      routesFilePath,
      `${JSON.stringify({
        schema: "ccc-prd.routes-by-task.v1",
        routes: routeProfiles,
      }, null, 2)}\n`,
    );
    const legacyFreshPolicy = jsonOutput(
      await prd([
        "policy",
        packetRoot,
        packet.manifestPath,
        legacySidecarPath,
        targetRoot,
        targetBase,
        legacyExecutionPlanPath,
        "--routes-file",
        routesFilePath,
      ], [1]),
      "prd legacy v1 fresh product policy",
    );
    assert(
      legacyFreshPolicy.kind === "refusal"
      && legacyFreshPolicy.diagnostics?.some(
        ({ code }) => code === "CCC_PRD_PRODUCT_SEMANTIC_V2_REQUIRED",
      )
      && !await pathExists(legacyExecutionPlanPath),
      "CCC_PRODUCT_LEGACY_V1_FRESH_PRODUCT_ACCEPTED",
      JSON.stringify(legacyFreshPolicy),
    );
    ledger.pass("legacy-v1-readable-fresh-product-refused", {
      legacySidecarSchema: "ccc-prd.sidecar.v1",
      legacyBundleSchema: legacyCompiled.schema,
      readable: true,
      freshProductDiagnostic: "CCC_PRD_PRODUCT_SEMANTIC_V2_REQUIRED",
      freshExecutionPlanCreated: false,
    });
    const generatedExecutionPlan = jsonOutput(
      await prd([
        "policy",
        packetRoot,
        packet.manifestPath,
        packet.sidecarPath,
        targetRoot,
        targetBase,
        packet.executionPlanPath,
        "--routes-file",
        routesFilePath,
      ]),
      "prd policy",
    );
    const executionPlanBytes = await readFile(packet.executionPlanPath);
    const executionPlan = JSON.parse(executionPlanBytes.toString("utf8"));
    const planRoutesByTaskId = new Map(
      (executionPlan.policy?.routes ?? []).map((route) => [route.taskId, route]),
    );
    const executionRoute = planRoutesByTaskId.get("TASK-VERTICAL");
    const secondExecutionRoute = planRoutesByTaskId.get("TASK-VERTICAL-SECOND");
    assert(
      generatedExecutionPlan.kind === "execution-plan"
        && generatedExecutionPlan.path === packet.executionPlanPath
        && generatedExecutionPlan.sha256 === sha256(executionPlanBytes)
        && generatedExecutionPlan.routeCount === 2
        && executionPlan.schema === "ccc-prd.execution-plan.v1"
        && executionPlan.policy?.schema === "ccc-campaign.execution-policy.v2"
        && executionPlan.packetHash === compiled.sourceHash
        && executionPlan.sidecarHash === compiled.sidecarHash
        && executionPlan.bundleHash === compiled.bundleHash
        && executionRoute?.taskId === "TASK-VERTICAL"
        && executionRoute.providerId === "openai"
        && executionRoute.modelId === "gpt-5.6-sol"
        && executionRoute.transport === "cli"
        && executionRoute.cliAdapterId === "codex"
        && executionRoute.executor === "cli-agent"
        && executionRoute.toolMode === "coding"
        && executionRoute.worktreeMode === "isolated"
        && executionRoute.commitPolicy === "required",
      "CCC_PRODUCT_EXECUTION_PLAN_INVALID",
      JSON.stringify(executionPlan),
    );
    exactArray(
      executionRoute.ownedPaths,
      ["src/value.txt"],
      "CCC_PRODUCT_EXECUTION_PLAN_OWNERSHIP_DRIFT",
    );
    exactArray(
      executionRoute.allowedWriteRoots,
      ["src/value.txt"],
      "CCC_PRODUCT_EXECUTION_PLAN_WRITE_ROOT_DRIFT",
    );
    ledger.pass("product-owned-execution-plan", {
      path: generatedExecutionPlan.path,
      sha256: generatedExecutionPlan.sha256,
      packetHash: executionPlan.packetHash,
      sidecarHash: executionPlan.sidecarHash,
      bundleHash: executionPlan.bundleHash,
      route: executionRoute,
    });

    assert(
      secondExecutionRoute?.taskId === "TASK-VERTICAL-SECOND"
        && secondExecutionRoute.providerId === "openai"
        && secondExecutionRoute.modelId === "gpt-5.6-terra"
        && secondExecutionRoute.transport === "cli"
        && secondExecutionRoute.cliAdapterId === "codex"
        && secondExecutionRoute.executor === "cli-agent"
        && secondExecutionRoute.toolMode === "coding"
        && secondExecutionRoute.worktreeMode === "isolated"
        && secondExecutionRoute.commitPolicy === "required"
        && executionRoute.modelId !== secondExecutionRoute.modelId,
      "CCC_PRODUCT_SECOND_EXECUTION_ROUTE_INVALID",
      JSON.stringify({ executionRoute, secondExecutionRoute }),
    );
    exactArray(
      secondExecutionRoute.ownedPaths,
      ["src/second.txt"],
      "CCC_PRODUCT_SECOND_EXECUTION_PLAN_OWNERSHIP_DRIFT",
    );
    exactArray(
      secondExecutionRoute.allowedWriteRoots,
      ["src/second.txt"],
      "CCC_PRODUCT_SECOND_EXECUTION_PLAN_WRITE_ROOT_DRIFT",
    );
    const routeOwnershipOverlap = executionRoute.ownedPaths.filter((ownedPath) =>
      secondExecutionRoute.ownedPaths.includes(ownedPath));
    assert(
      routeOwnershipOverlap.length === 0,
      "CCC_PRODUCT_ROUTE_OWNERSHIP_NOT_DISJOINT",
      JSON.stringify(routeOwnershipOverlap),
    );
    ledger.pass("per-task-route-profiles", {
      routeSelection: "routes-file",
      routesFileSchema: "ccc-prd.routes-by-task.v1",
      routesFileSha256: sha256(await readFile(routesFilePath)),
      routeCount: generatedExecutionPlan.routeCount,
      routes: {
        "TASK-VERTICAL": executionRoute,
        "TASK-VERTICAL-SECOND": secondExecutionRoute,
      },
      distinctModelIds: [executionRoute.modelId, secondExecutionRoute.modelId],
      ownershipDisjoint: true,
      transportCoverage:
        "two CLI route profiles differing by model; the pi transport is deliberately deferred and is not exercised by this canary.",
    });

    const globalSettingsBeforeForgedPreview =
      await directorySnapshot(globalSettingsDir);
    const forgedSidecarPath = path.join(packetRoot, "forged.sidecar.json");
    await cp(packet.sidecarPath, forgedSidecarPath);
    const forged = JSON.parse(await readFile(forgedSidecarPath, "utf8"));
    forged.proofs[0].admission.definitionSha256 = "0".repeat(64);
    await writeFile(forgedSidecarPath, `${JSON.stringify(forged, null, 2)}\n`);
    const forgedPreview = jsonOutput(
      await prd([
        "preview",
        packetRoot,
        packet.manifestPath,
        forgedSidecarPath,
        packet.executionPlanPath,
        targetRoot,
        targetBase,
      ], [1]),
      "forged prd preview",
    );
    assert(
      forgedPreview.kind === "refusal",
      "CCC_PRODUCT_FORGED_PROVENANCE_ACCEPTED",
      JSON.stringify(forgedPreview),
    );
    assert(
      forgedPreview.diagnostics?.some(
        ({ code }) => code === "CCC_PRD_PROOF_ADMISSION_STALE",
      ),
      "CCC_PRODUCT_FORGED_PROVENANCE_DIAGNOSTIC_MISSING",
      JSON.stringify(forgedPreview),
    );
    exactArray(
      await directorySnapshot(globalSettingsDir),
      globalSettingsBeforeForgedPreview,
      "CCC_PRODUCT_FORGED_PREVIEW_LEFT_DATABASE_RESIDUE",
    );
    assert(
      !await pathExists(path.join(targetRoot, ".fusion")),
      "CCC_PRODUCT_FORGED_PREVIEW_LEFT_PROJECT_RESIDUE",
      path.join(targetRoot, ".fusion"),
    );
    assert(
      await git(targetRoot, "status", "--porcelain") === "",
      "CCC_PRODUCT_FORGED_PREVIEW_LEFT_GIT_RESIDUE",
      await git(targetRoot, "status", "--porcelain"),
    );
    assert(
      await plantedSourcesIntact(),
      "CCC_PRODUCT_FORGED_PREVIEW_MUTATED_SOURCE",
      "an admitted source file changed",
    );
    ledger.pass("forged-provenance-refused-without-residue", {
      diagnostics: forgedPreview.diagnostics,
      targetHead: await git(targetRoot, "rev-parse", "HEAD"),
    });

    const settingsPath = path.join(packetRoot, "settings.json");
    await writeFile(settingsPath, `${JSON.stringify({
      version: 2,
      exportedAt: new Date().toISOString(),
      global: {
        openrouterModelSync: false,
        opencodeGoModelSync: false,
        experimentalFeatures: { cliAgentExecutor: true },
      },
      project: {
        // Two worktrees are admitted so the chained second task can hold its
        // own isolated checkout, while maxConcurrent stays at 1 so the two
        // tasks can only ever run one at a time. The pairing is the serialism
        // proof: capacity for two custody roots, permission for one runner.
        maxConcurrent: 1,
        maxWorktrees: 2,
        pollIntervalMs: 500,
        worktreesDir: worktreesRoot,
      },
    }, null, 2)}\n`);
    await run(
      process.execPath,
      [
        cliBin,
        "settings",
        "import",
        settingsPath,
        "--scope",
        "both",
        "--merge",
        "--yes",
      ],
      { cwd: targetRoot, env, timeoutMs: 240_000 },
    );

    const port = await availablePort();
    server = await startServe(targetRoot, serveEnv, port);

    const preview = jsonOutput(
      await prd(["preview", ...commonPacketArgs]),
      "prd preview",
    );
    assert(
      preview.kind === "preview"
      && /^[0-9a-f]{64}$/.test(preview.confirmationDigest),
      "CCC_PRODUCT_PREVIEW_INVALID",
      JSON.stringify(preview),
    );
    exactArray(
      preview.requirements?.map(({ id }) => id).sort(),
      ["REQ-VERTICAL", "REQ-VERTICAL-SECOND"],
      "CCC_PRODUCT_PREVIEW_REQUIREMENTS_DRIFT",
    );
    ledger.pass("exact-preview-confirmed", {
      confirmationDigest: preview.confirmationDigest,
      packetHash: preview.packetHash,
      sidecarHash: preview.sidecarHash,
      bundleHash: preview.bundleHash,
      targetHead: preview.targetHead,
    });

    const wrongConfirmation = jsonOutput(
      await prd([
        "import",
        ...commonPacketArgs,
        idempotencyKey,
        "--confirm",
        "0".repeat(64),
      ], [1]),
      "wrong-confirmation import",
    );
    assert(
      wrongConfirmation.kind === "refusal"
      && wrongConfirmation.diagnostics?.some(
        ({ code }) => code === "CCC_PRD_CONFIRMATION_MISMATCH",
      ),
      "CCC_PRODUCT_WRONG_CONFIRMATION_ACCEPTED",
      JSON.stringify(wrongConfirmation),
    );
    const missingStatus = jsonOutput(
      await prd(["status", idempotencyKey], [1]),
      "status after wrong confirmation",
    );
    assert(
      missingStatus.kind === "product-status" && missingStatus.found === false,
      "CCC_PRODUCT_WRONG_CONFIRMATION_LEFT_DATABASE_RESIDUE",
      JSON.stringify(missingStatus),
    );
    assert(
      await git(targetRoot, "rev-parse", "HEAD") === targetBase
      && await plantedSourcesIntact(),
      "CCC_PRODUCT_WRONG_CONFIRMATION_LEFT_SOURCE_RESIDUE",
      await git(targetRoot, "status", "--porcelain"),
    );
    ledger.pass("wrong-confirmation-refused-without-residue", {
      diagnosticCode: "CCC_PRD_CONFIRMATION_MISMATCH",
      statusFound: false,
      targetHead: targetBase,
    });

    const importedServer = server;
    await stopServe(importedServer);
    server = undefined;
    const readStatusFor = async (key) => {
      return jsonOutput(
        await prd(["status", key]),
        `prd status ${key}`,
      );
    };
    const lifecycleKey = `${idempotencyKey}-lifecycle`;
    const lifecycleImport = jsonOutput(
      await prd([
        "import",
        ...commonPacketArgs,
        lifecycleKey,
        "--confirm",
        preview.confirmationDigest,
      ]),
      "prd lifecycle import",
    );
    assert(
      lifecycleImport.kind === "imported"
      && lifecycleImport.result?.state === "active"
      && lifecycleImport.result?.runnable === true,
      "CCC_PRODUCT_LIFECYCLE_IMPORT_NOT_RUNNABLE",
      JSON.stringify(lifecycleImport),
    );
    const lifecycleReady = await readStatusFor(lifecycleKey);
    const pauseControl = lifecycleReady.operatorControls?.find(
      ({ action }) => action === "pause",
    );
    assert(
      pauseControl?.allowed === true
      && /^[0-9a-f]{64}$/u.test(pauseControl.confirmation),
      "CCC_PRODUCT_PAUSE_CONFIRMATION_MISSING",
      JSON.stringify(lifecycleReady.operatorControls),
    );
    const paused = jsonOutput(
      await prd([
        "pause",
        lifecycleKey,
        "--confirm",
        pauseControl.confirmation,
      ]),
      "prd campaign pause",
    );
    assert(
      paused.kind === "campaign-paused"
      && paused.result?.workItemState === "held"
      && paused.status?.workItems?.[0]?.state === "held",
      "CCC_PRODUCT_CAMPAIGN_PAUSE_FAILED",
      JSON.stringify(paused),
    );
    const stalePause = jsonOutput(
      await prd([
        "pause",
        lifecycleKey,
        "--confirm",
        pauseControl.confirmation,
      ], [1]),
      "stale campaign pause",
    );
    assert(
      stalePause.kind === "refusal"
      && stalePause.diagnostics?.some(
        ({ code }) =>
          code === "CCC_CAMPAIGN_OPERATOR_CONTROL_CONFIRMATION_REFUSED",
      ),
      "CCC_PRODUCT_STALE_PAUSE_CONFIRMATION_ACCEPTED",
      JSON.stringify(stalePause),
    );
    const resumeControl = paused.operatorControls?.find(
      ({ action }) => action === "resume",
    );
    assert(
      resumeControl?.allowed === true
      && /^[0-9a-f]{64}$/u.test(resumeControl.confirmation),
      "CCC_PRODUCT_RESUME_CONFIRMATION_MISSING",
      JSON.stringify(paused.operatorControls),
    );
    const resumed = jsonOutput(
      await prd([
        "resume",
        lifecycleKey,
        "--confirm",
        resumeControl.confirmation,
      ]),
      "prd campaign resume",
    );
    assert(
      resumed.kind === "campaign-resumed"
      && resumed.result?.workItemState === "runnable"
      && resumed.status?.workItems?.[0]?.state === "runnable",
      "CCC_PRODUCT_CAMPAIGN_RESUME_FAILED",
      JSON.stringify(resumed),
    );
    const stopControl = resumed.operatorControls?.find(
      ({ action }) => action === "stop",
    );
    const stopReason =
      "Acceptance canary stops before dispatch and preserves every durable receipt.";
    assert(
      stopControl?.allowed === true
      && /^[0-9a-f]{64}$/u.test(stopControl.confirmation),
      "CCC_PRODUCT_STOP_CONFIRMATION_MISSING",
      JSON.stringify(resumed.operatorControls),
    );
    const stopped = jsonOutput(
      await prd([
        "stop",
        lifecycleKey,
        "--reason",
        stopReason,
        "--confirm",
        stopControl.confirmation,
      ]),
      "prd campaign stop",
    );
    assert(
      stopped.kind === "campaign-stopped"
      && stopped.result?.workItemState === "cancelled"
      && stopped.status?.nextAction?.kind === "abandoned"
      && stopped.status?.workItems?.[0]?.state === "cancelled"
      && stopped.status?.tasks?.every((task) => task.state?.paused === true),
      "CCC_PRODUCT_CAMPAIGN_STOP_FAILED",
      JSON.stringify(stopped),
    );
    assert(
      await git(targetRoot, "rev-parse", "HEAD") === targetBase
      && await plantedSourcesIntact(),
      "CCC_PRODUCT_LIFECYCLE_CONTROL_CHANGED_SOURCE",
      await git(targetRoot, "status", "--porcelain"),
    );
    ledger.pass("operator-lifecycle-controls", {
      importId: lifecycleImport.result.importId,
      pause: paused.result,
      stalePauseDiagnostic: stalePause.diagnostics[0],
      resume: resumed.result,
      stop: stopped.result,
      nextAction: stopped.status.nextAction,
      targetHead: targetBase,
    });

    const providerCutpointKey = `${idempotencyKey}-provider-cutpoint`;
    await writeFile(providerCutpointActivation, "armed\n");
    const providerCutpointImport = jsonOutput(
      await prd([
        "import",
        ...commonPacketArgs,
        providerCutpointKey,
        "--confirm",
        preview.confirmationDigest,
      ]),
      "prd provider-cutpoint import",
    );
    assert(
      providerCutpointImport.kind === "imported"
      && providerCutpointImport.result?.state === "active"
      && providerCutpointImport.result?.runnable === true,
      "CCC_PRODUCT_PROVIDER_CUTPOINT_IMPORT_NOT_RUNNABLE",
      JSON.stringify(providerCutpointImport),
    );
    const readProviderCutpointStatus = async () =>
      readStatusFor(providerCutpointKey);
    server = await startServe(targetRoot, serveEnv, port);
    const providerAuthorizationHold = await awaitSealedExecutionAuthorization(
      "provider cutpoint execution approval",
      readProviderCutpointStatus,
      2,
    );
    const providerExecutionApproved = jsonOutput(
      await prd([
        "approve-execution",
        providerCutpointKey,
        providerAuthorizationHold.authorization.authorizationId,
        "--confirm",
        providerAuthorizationHold.confirmation.confirmation,
      ]),
      "approve provider-cutpoint execution",
    );
    assert(
      providerExecutionApproved.kind === "execution-approved"
      && providerExecutionApproved.executionAuthorizationId
        === providerAuthorizationHold.authorization.authorizationId
      && providerExecutionApproved.approval?.status === "claimed",
      "CCC_PRODUCT_PROVIDER_CUTPOINT_APPROVAL_FAILED",
      JSON.stringify(providerExecutionApproved),
    );
    const providerMarker = await poll(
      "provider process reached post-dispatch cutpoint",
      async () => {
        if (!await pathExists(providerCutpointMarker)) return null;
        return JSON.parse(await readFile(providerCutpointMarker, "utf8"));
      },
      (value) =>
        Number.isSafeInteger(value?.pid)
        && value.pid > 1
        && typeof value.cwd === "string"
        && typeof value.executable === "string",
      async () => ({
        serve: tail(server.output()),
        status: await readProviderCutpointStatus(),
      }),
    );
    ownedCutpointMarker = providerMarker;
    const canonicalProviderWorktree = await realpath(providerMarker.cwd);
    const providerWorktreeRelative = path.relative(
      await realpath(worktreesRoot),
      canonicalProviderWorktree,
    );
    assert(
      providerWorktreeRelative.length > 0
      && providerWorktreeRelative !== ".."
      && !providerWorktreeRelative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(providerWorktreeRelative),
      "CCC_PRODUCT_PROVIDER_CUTPOINT_WORKTREE_INVALID",
      JSON.stringify({ marker: providerMarker, worktreesRoot }),
    );
    const crashedProviderServer = server;
    await crashServe(crashedProviderServer);
    server = undefined;
    const providerProcessCommand = await terminateOwnedCutpointProcess(
      providerMarker,
      ownedFakeCodexPath,
    );
    ownedCutpointMarker = undefined;
    const providerInvocationsBeforeRestart = await readJsonLines(
      providerCutpointInvocations,
    );
    exactArray(
      providerInvocationsBeforeRestart.map(({ pid }) => pid),
      [providerMarker.pid],
      "CCC_PRODUCT_PROVIDER_CUTPOINT_INVOCATION_DRIFT",
    );
    server = await startServe(targetRoot, serveEnv, port);
    const recoveredProviderCutpoint = await poll(
      "provider uncertainty parked after restart",
      readProviderCutpointStatus,
      (value) =>
        value.status?.nextAction?.kind === "resolve-manual-required"
        && value.status?.workItems?.length === 1
        && value.status.workItems[0]?.state === "manual-required",
      async () => ({
        serve: tail(server.output()),
        status: await readProviderCutpointStatus(),
      }),
      180_000,
    );
    assert(
      recoveredProviderCutpoint.status.providerAttempts.length === 1
      && recoveredProviderCutpoint.status.providerAttempts[0]?.state
        === "dispatched_unknown"
      && recoveredProviderCutpoint.status.proofs.every(
        ({ attempts }) => attempts.length === 0,
      ),
      "CCC_PRODUCT_PROVIDER_UNCERTAINTY_NOT_PRESERVED",
      JSON.stringify(recoveredProviderCutpoint.status),
    );
    const recoveredProviderTask = taskFor(
      recoveredProviderCutpoint.status,
      "TASK-VERTICAL",
    );
    assert(
      typeof recoveredProviderTask?.worktree === "string"
      && recoveredProviderTask.worktree.length > 0
      && await pathExists(recoveredProviderTask.worktree),
      "CCC_PRODUCT_PROVIDER_RECOVERY_LOST_WORKTREE",
      JSON.stringify(recoveredProviderTask),
    );
    assert(
      await realpath(recoveredProviderTask.worktree)
        === canonicalProviderWorktree,
      "CCC_PRODUCT_PROVIDER_RECOVERY_WORKTREE_DRIFT",
      JSON.stringify({
        beforeCrash: canonicalProviderWorktree,
        afterRestart: recoveredProviderTask.worktree,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    exactArray(
      (await readJsonLines(providerCutpointInvocations)).map(({ pid }) => pid),
      [providerMarker.pid],
      "CCC_PRODUCT_PROVIDER_EFFECT_RETRIED",
    );
    assert(
      await git(targetRoot, "rev-parse", "HEAD") === targetBase
      && await plantedSourcesIntact(),
      "CCC_PRODUCT_PROVIDER_CUTPOINT_CHANGED_SOURCE",
      await git(targetRoot, "status", "--porcelain"),
    );
    const providerStopControl =
      recoveredProviderCutpoint.operatorControls?.find(
        ({ action }) => action === "stop",
      );
    assert(
      providerStopControl?.allowed === true
      && /^[0-9a-f]{64}$/u.test(providerStopControl.confirmation),
      "CCC_PRODUCT_PROVIDER_CUTPOINT_STOP_MISSING",
      JSON.stringify(recoveredProviderCutpoint.operatorControls),
    );
    const providerStopped = jsonOutput(
      await prd([
        "stop",
        providerCutpointKey,
        "--reason",
        "Acceptance canary abandons one uncertain provider effect after explicit review.",
        "--confirm",
        providerStopControl.confirmation,
      ]),
      "stop provider-cutpoint campaign",
    );
    assert(
      providerStopped.kind === "campaign-stopped"
      && providerStopped.status?.nextAction?.kind === "abandoned"
      && providerStopped.status?.providerAttempts?.length === 1
      && providerStopped.status.providerAttempts[0]?.state
        === "dispatched_unknown",
      "CCC_PRODUCT_PROVIDER_CUTPOINT_ABANDON_FAILED",
      JSON.stringify(providerStopped),
    );
    ledger.pass("provider-dispatch-restart-manual-required", {
      importId: providerCutpointImport.result.importId,
      crashedServePid: crashedProviderServer.child.pid,
      providerPid: providerMarker.pid,
      providerProcessCommand,
      providerAttempt:
        recoveredProviderCutpoint.status.providerAttempts[0],
      recoveredWorkItem: recoveredProviderCutpoint.status.workItems[0],
      recoveredNextAction: recoveredProviderCutpoint.status.nextAction,
      stoppedNextAction: providerStopped.status.nextAction,
      invocationCount: providerInvocationsBeforeRestart.length,
      targetHead: targetBase,
    });
    await stopServe(server);
    server = undefined;
    await rm(providerCutpointActivation, { force: true });

    const proofCutpointToken = ownedProofCutpointToken;
    assert(
      typeof proofCutpointToken === "string"
        && /^[0-9a-f]{16}$/u.test(proofCutpointToken),
      "CCC_PRODUCT_PROOF_CUTPOINT_TOKEN_INVALID",
      String(proofCutpointToken),
    );
    const proofCutpointKey = `${idempotencyKey}-proof-cutpoint`;
    await writeFile(proofCutpointActivation, "armed\n");
    const proofCutpointImport = jsonOutput(
      await prd([
        "import",
        ...commonPacketArgs,
        proofCutpointKey,
        "--confirm",
        preview.confirmationDigest,
      ]),
      "prd proof-cutpoint import",
    );
    assert(
      proofCutpointImport.kind === "imported"
      && proofCutpointImport.result?.state === "active"
      && proofCutpointImport.result?.runnable === true,
      "CCC_PRODUCT_PROOF_CUTPOINT_IMPORT_NOT_RUNNABLE",
      JSON.stringify(proofCutpointImport),
    );
    const readProofCutpointStatus = async () =>
      readStatusFor(proofCutpointKey);
    server = await startServe(targetRoot, serveEnv, port);
    const proofAuthorizationHold = await awaitSealedExecutionAuthorization(
      "proof cutpoint execution approval",
      readProofCutpointStatus,
      2,
    );
    const proofExecutionApproved = jsonOutput(
      await prd([
        "approve-execution",
        proofCutpointKey,
        proofAuthorizationHold.authorization.authorizationId,
        "--confirm",
        proofAuthorizationHold.confirmation.confirmation,
      ]),
      "approve proof-cutpoint execution",
    );
    assert(
      proofExecutionApproved.kind === "execution-approved"
      && proofExecutionApproved.executionAuthorizationId
        === proofAuthorizationHold.authorization.authorizationId
      && proofExecutionApproved.approval?.status === "claimed",
      "CCC_PRODUCT_PROOF_CUTPOINT_APPROVAL_FAILED",
      JSON.stringify(proofExecutionApproved),
    );
    const proofMarkersAtDispatch = await poll(
      "verifier process reached post-dispatch cutpoint",
      () => readOwnedProofCutpointMarkers(proofCutpointToken, proofExecutionTmpRoot),
      (markers) => markers.length === 1,
      async () => ({
        serve: tail(server.output()),
        status: await readProofCutpointStatus(),
        markers: await readOwnedProofCutpointMarkers(
          proofCutpointToken,
          proofExecutionTmpRoot,
        ),
      }),
    );
    const proofMarker = proofMarkersAtDispatch[0];
    const canonicalProofRoot = await realpath(proofMarker.cwd);
    assert(
      canonicalProofRoot === await realpath(proofMarker.proofRoot)
      && path.basename(canonicalProofRoot) === "proof"
      && path.basename(proofMarker.executionRoot)
        .startsWith("ccc-semantic-proof-execution-")
      && proofMarker.scratchRoot
        === path.join(proofMarker.executionRoot, "scratch")
      && proofMarker.verifierHome
        === path.join(proofMarker.scratchRoot, "home"),
      "CCC_PRODUCT_PROOF_CUTPOINT_SANDBOX_INVALID",
      JSON.stringify({ proofMarker, canonicalProofRoot }),
    );
    const proofDispatchStatus = await poll(
      "durable proof dispatch receipt",
      readProofCutpointStatus,
      (value) => {
        const valueTaskProof = value.status?.proofs?.find(
          ({ definition }) =>
            definition.id === "PROOF-VERTICAL-VALUE-TASK",
        );
        return value.status?.providerAttempts?.length === 1
          && value.status.providerAttempts[0]?.state === "committed"
          && value.status?.proofs?.length === 3
          && valueTaskProof?.attempts?.length === 1
          && valueTaskProof.attempts[0]?.attemptContractVersion === "v2"
          && valueTaskProof.attempts[0]?.phase === "task"
          && valueTaskProof.attempts[0]?.state === "dispatched_unknown";
      },
      async () => ({
        serve: tail(server.output()),
        status: await readProofCutpointStatus(),
      }),
    );
    const proofAttempt = proofDispatchStatus.status.proofs.find(
      ({ definition }) => definition.id === "PROOF-VERTICAL-VALUE-TASK",
    ).attempts[0];
    const proofCutpointTask = taskFor(
      proofDispatchStatus.status,
      "TASK-VERTICAL",
    );
    const canonicalProofTaskWorktree = await realpath(
      proofCutpointTask.worktree,
    );
    const proofTaskWorktreeRelative = path.relative(
      await realpath(worktreesRoot),
      canonicalProofTaskWorktree,
    );
    assert(
      canonicalProofTaskWorktree !== canonicalProofRoot
      && proofTaskWorktreeRelative.length > 0
      && proofTaskWorktreeRelative !== ".."
      && !proofTaskWorktreeRelative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(proofTaskWorktreeRelative),
      "CCC_PRODUCT_PROOF_CUTPOINT_WORKTREE_INVALID",
      JSON.stringify({
        proofTaskWorktree: canonicalProofTaskWorktree,
        proofRoot: canonicalProofRoot,
        worktreesRoot,
      }),
    );
    const proofSourceCommit = proofAttempt.sourceCommit;
    assert(
      /^[0-9a-f]{40}$/u.test(proofSourceCommit)
      && proofSourceCommit !== targetBase
      && await git(targetRoot, "rev-parse", "refs/heads/main") === targetBase
      && await git(targetRoot, "show", `${proofSourceCommit}:src/value.txt`)
        === proofCutpointCandidateValue
      && await git(targetRoot, "show", `${proofSourceCommit}:src/second.txt`)
        === "pending",
      "CCC_PRODUCT_PROOF_CUTPOINT_SOURCE_COMMIT_INVALID",
      JSON.stringify({ proofAttempt, targetBase }),
    );
    const crashedProofServer = server;
    await crashServe(crashedProofServer);
    server = undefined;
    const proofProcessCommand =
      await terminateOwnedProofCutpointProcess(
        proofMarker,
        proofCutpointToken,
        canonicalProofRoot,
      );
    server = await startServe(targetRoot, serveEnv, port);
    const recoveredProofCutpoint = await poll(
      "proof uncertainty parked after restart",
      readProofCutpointStatus,
      (value) =>
        value.status?.nextAction?.kind === "resolve-manual-required"
        && value.status?.workItems?.length === 1
        && value.status.workItems[0]?.state === "manual-required",
      async () => ({
        serve: tail(server.output()),
        status: await readProofCutpointStatus(),
      }),
      180_000,
    );
    const recoveredProofAttempt = recoveredProofCutpoint.status.proofs.find(
      ({ definition }) => definition.id === "PROOF-VERTICAL-VALUE-TASK",
    )?.attempts[0];
    // A task-phase proof runs immediately after its owning task. Recovery must
    // therefore preserve the first task's exact worktree, before the chained
    // task has dispatched at all.
    const recoveredProofTask = taskFor(
      recoveredProofCutpoint.status,
      "TASK-VERTICAL",
    );
    assert(
      recoveredProofAttempt?.attemptKey === proofAttempt.attemptKey
      && recoveredProofAttempt.state === "dispatched_unknown"
      && recoveredProofAttempt.attemptContractVersion === "v2"
      && recoveredProofAttempt.phase === "task"
      && recoveredProofCutpoint.status.providerAttempts.length === 1
      && recoveredProofCutpoint.status.providerAttempts[0]?.state
        === "committed"
      && typeof recoveredProofTask?.worktree === "string"
      && await pathExists(recoveredProofTask.worktree)
      && await realpath(recoveredProofTask.worktree)
        === canonicalProofTaskWorktree,
      "CCC_PRODUCT_PROOF_UNCERTAINTY_NOT_PRESERVED",
      JSON.stringify(recoveredProofCutpoint.status),
    );
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    exactArray(
      (await readOwnedProofCutpointMarkers(
        proofCutpointToken,
        proofExecutionTmpRoot,
      ))
        .map(({ pid }) => pid),
      [proofMarker.pid],
      "CCC_PRODUCT_PROOF_EFFECT_RETRIED_AFTER_RESTART",
    );
    assert(
      await git(targetRoot, "rev-parse", "refs/heads/main") === targetBase
      && await git(targetRoot, "show", `${proofSourceCommit}:src/value.txt`)
        === proofCutpointCandidateValue
      && await git(targetRoot, "show", `${proofSourceCommit}:src/second.txt`)
        === "pending",
      "CCC_PRODUCT_PROOF_CUTPOINT_CHANGED_TARGET",
      await git(targetRoot, "status", "--porcelain"),
    );
    const proofResolutionPath = path.join(
      tempRoot,
      "proof-cutpoint-resolution.json",
    );
    await writeFile(
      proofResolutionPath,
      JSON.stringify({
        schema: "ccc-campaign.proof-resolution.v1",
        observerId: "ccc-product-acceptance",
        summary:
          "The verifier was intentionally killed after durable dispatch; no terminal verifier result was observed.",
        result: {
          success: false,
          exitCode: null,
          durationMs: 0,
          stdout: "",
          stderr:
            "Acceptance canary terminated the owned verifier after the durable dispatch receipt.",
          timedOut: false,
          killed: true,
          warnings: [
            "proof-dispatch-crash-canary:no-terminal-result-observed",
          ],
        },
      }),
    );
    const refusedProofResolution = jsonOutput(
      await prd([
        "resolve-proof",
        proofCutpointKey,
        proofAttempt.attemptKey,
        proofResolutionPath,
      ], [1]),
      "refuse semantic-v2 proof-cutpoint resolution",
    );
    assert(
      refusedProofResolution.kind === "refusal"
      && refusedProofResolution.diagnostics?.some(
        ({ code }) => code === "CCC_PRD_PROOF_RESOLUTION_V2_REFUSED",
      ),
      "CCC_PRODUCT_SEMANTIC_PROOF_RESOLUTION_NOT_REFUSED",
      JSON.stringify(refusedProofResolution),
    );
    const statusAfterResolutionRefusal = await readProofCutpointStatus();
    const refusedAttempt = statusAfterResolutionRefusal.status.proofs.find(
      ({ definition }) => definition.id === "PROOF-VERTICAL-VALUE-TASK",
    )?.attempts[0];
    assert(
      refusedAttempt?.attemptKey === proofAttempt.attemptKey
      && refusedAttempt.state === "dispatched_unknown"
      && statusAfterResolutionRefusal.status.workItems[0]?.state
        === "manual-required",
      "CCC_PRODUCT_SEMANTIC_PROOF_RESOLUTION_LEFT_RESIDUE",
      JSON.stringify(statusAfterResolutionRefusal.status),
    );
    const proofStopControl = statusAfterResolutionRefusal.operatorControls?.find(
      ({ action }) => action === "stop",
    );
    assert(
      proofStopControl?.allowed === true
      && /^[0-9a-f]{64}$/u.test(proofStopControl.confirmation),
      "CCC_PRODUCT_PROOF_CUTPOINT_STOP_MISSING",
      JSON.stringify(statusAfterResolutionRefusal.operatorControls),
    );
    const proofStopped = jsonOutput(
      await prd([
        "stop",
        proofCutpointKey,
        "--reason",
        "Acceptance canary preserves one uncertain semantic verifier effect; manual result fabrication is forbidden.",
        "--confirm",
        proofStopControl.confirmation,
      ]),
      "stop semantic-v2 proof-cutpoint campaign",
    );
    assert(
      proofStopped.kind === "campaign-stopped"
      && proofStopped.result?.workItemState === "cancelled"
      && proofStopped.status?.nextAction?.kind === "abandoned"
      && proofStopped.status?.proofs?.find(
        ({ definition }) => definition.id === "PROOF-VERTICAL-VALUE-TASK",
      )?.attempts[0]?.state === "dispatched_unknown",
      "CCC_PRODUCT_PROOF_CUTPOINT_STOP_FAILED",
      JSON.stringify(proofStopped),
    );
    exactArray(
      (await readOwnedProofCutpointMarkers(
        proofCutpointToken,
        proofExecutionTmpRoot,
      ))
        .map(({ pid }) => pid),
      [proofMarker.pid],
      "CCC_PRODUCT_PROOF_EFFECT_RERUN_DURING_REFUSAL",
    );
    assert(
      await git(targetRoot, "rev-parse", "refs/heads/main") === targetBase
      && await pathExists(canonicalProofRoot)
      && await pathExists(canonicalProofTaskWorktree),
      "CCC_PRODUCT_PROOF_CUTPOINT_ABANDONMENT_INVALID",
      JSON.stringify({
        nextAction: proofStopped.status.nextAction,
        operatorControls: proofStopped.operatorControls,
        targetHead: await git(
          targetRoot,
          "rev-parse",
          "refs/heads/main",
        ),
        proofRoot: canonicalProofRoot,
        taskWorktree: canonicalProofTaskWorktree,
      }),
    );
    ledger.pass("proof-dispatch-restart-manual-required", {
      importId: proofCutpointImport.result.importId,
      crashedServePid: crashedProofServer.child.pid,
      verifierPid: proofMarker.pid,
      verifierProcessCommand: proofProcessCommand,
      proofAttemptBeforeRefusal: recoveredProofAttempt,
      proofAttemptAfterRefusal: refusedAttempt,
      manualResolutionDiagnostic: "CCC_PRD_PROOF_RESOLUTION_V2_REFUSED",
      recoveredWorkItem: recoveredProofCutpoint.status.workItems[0],
      recoveredNextAction: recoveredProofCutpoint.status.nextAction,
      stoppedWorkItem: proofStopped.status.workItems[0],
      stoppedNextAction: proofStopped.status.nextAction,
      invocationCount: proofMarkersAtDispatch.length,
      sourceCommit: proofSourceCommit,
      proofRoot: canonicalProofRoot,
      taskWorktree: canonicalProofTaskWorktree,
      targetHead: targetBase,
    });
    await stopServe(server);
    server = undefined;
    await rm(proofCutpointActivation, { force: true });
    await cleanupOwnedProofCutpointMarkers(proofCutpointToken, proofExecutionTmpRoot);
    ownedProofCutpointToken = undefined;

    const imported = jsonOutput(
      await prd([
        "import",
        ...commonPacketArgs,
        idempotencyKey,
        "--confirm",
        preview.confirmationDigest,
      ]),
      "prd import",
    );
    assert(
      imported.kind === "imported"
      && imported.result?.state === "active"
      && imported.result?.runnable === true,
      "CCC_PRODUCT_IMPORT_NOT_RUNNABLE",
      JSON.stringify(imported),
    );
    ledger.pass("campaign-import-admitted", {
      importId: imported.result.importId,
      state: imported.result.state,
      idempotencyKey,
    });

    const readStatus = async () => readStatusFor(idempotencyKey);
    server = await startServe(targetRoot, serveEnv, port);
    assert(
      (
        importedServer.child.exitCode !== null
        || importedServer.child.signalCode !== null
      )
      && importedServer.child.pid !== server.child.pid,
      "CCC_PRODUCT_IMPORT_RESTART_PROCESS_INVALID",
      JSON.stringify({
        stoppedPid: importedServer.child.pid,
        stoppedExitCode: importedServer.child.exitCode,
        stoppedSignal: importedServer.child.signalCode,
        restartedPid: server.child.pid,
      }),
    );
    const postRestartInspection = jsonOutput(
      await prd(["inspect", idempotencyKey]),
      "prd import inspection after restart",
    );
    const mainAuthorizationHold = await awaitSealedExecutionAuthorization(
      "live execution approval hold after import restart",
      readStatus,
      2,
    );
    const postImportRestart = mainAuthorizationHold.hold;
    const restartedTask = taskFor(postImportRestart.status, "TASK-VERTICAL");
    const restartedSecondTask = taskFor(
      postImportRestart.status,
      "TASK-VERTICAL-SECOND",
    );
    const restartedWorkItem = postImportRestart.status.workItems[0];
    assert(
      postRestartInspection.kind === "inspection"
      && postRestartInspection.found === true
      && postRestartInspection.inspection?.importId === imported.result.importId
      && postRestartInspection.inspection.identityHash === imported.result.identityHash
      && postRestartInspection.inspection.transactionWitness?.transactionId
        === imported.result.transactionWitness?.transactionId
      && postRestartInspection.inspection.state === "active"
      && postRestartInspection.inspection.runnable === true
      && postRestartInspection.inspection.directCounts?.tasks === 2
      && postRestartInspection.inspection.directCounts?.workItems === 1
      && postImportRestart.status.import.importId === imported.result.importId
      && postImportRestart.status.import.identityHash === imported.result.identityHash
      && postImportRestart.status.tasks.length === 2
      && restartedTask?.semanticTaskId === "TASK-VERTICAL"
      && /^[A-Z][A-Z0-9]*-\d+$/u.test(restartedTask.nativeTaskId)
      && restartedTask.nativeTaskId !== restartedTask.semanticTaskId
      && /^[A-Z][A-Z0-9]*-\d+$/u.test(restartedSecondTask.nativeTaskId)
      && restartedSecondTask.nativeTaskId !== restartedSecondTask.semanticTaskId
      && restartedSecondTask.nativeTaskId !== restartedTask.nativeTaskId
      && postImportRestart.status.workItems.length === 1
      && restartedWorkItem?.taskId === restartedTask.nativeTaskId
      && restartedWorkItem.runId === `ccc-prd:${imported.result.importId}`
      && restartedWorkItem.stableWorkflowRunId === restartedWorkItem.runId,
      "CCC_PRODUCT_IMPORT_RESTART_RESIDUE_OR_MAPPING_DRIFT",
      JSON.stringify({
        inspection: postRestartInspection,
        import: postImportRestart.status.import,
        tasks: postImportRestart.status.tasks,
        workItems: postImportRestart.status.workItems,
      }),
    );
    ledger.pass("import-restart-recovery", {
      stoppedPid: importedServer.child.pid,
      restartedPid: server.child.pid,
      importId: imported.result.importId,
      identityHash: imported.result.identityHash,
      transactionId: postRestartInspection.inspection.transactionWitness.transactionId,
      importIdentityPersisted: true,
      nativeTaskMapping: [
        {
          semanticTaskId: restartedTask.semanticTaskId,
          nativeTaskId: restartedTask.nativeTaskId,
        },
        {
          semanticTaskId: restartedSecondTask.semanticTaskId,
          nativeTaskId: restartedSecondTask.nativeTaskId,
        },
      ],
      counts: {
        tasks: postImportRestart.status.tasks.length,
        workItems: postImportRestart.status.workItems.length,
      },
      nextAction: postImportRestart.status.nextAction,
    });

    const liveHold = mainAuthorizationHold.hold;
    assert(
      liveHold.status.workItems.length === 1
      && liveHold.status.workItems[0].state === "manual-required"
      && workItemHasCccPermanentReason(
        liveHold.status.workItems[0],
        "CCC_CAMPAIGN_LIVE_EXECUTION_APPROVAL_REQUIRED",
      ),
      "CCC_PRODUCT_LIVE_EXECUTION_HOLD_INVALID",
      JSON.stringify(liveHold.status.workItems),
    );
    assert(
      await git(targetRoot, "rev-parse", "HEAD") === targetBase
      && await plantedSourcesIntact(),
      "CCC_PRODUCT_EXECUTED_BEFORE_APPROVAL",
      await git(targetRoot, "status", "--porcelain"),
    );
    const liveAuthorization = mainAuthorizationHold.authorization;
    const liveConfirmation = mainAuthorizationHold.confirmation;
    assert(
      /^[0-9a-f]{64}$/.test(liveConfirmation.confirmation)
      && liveAuthorization.members[0]?.nativeTaskId
        === restartedTask.nativeTaskId
      && liveAuthorization.members[0]?.semanticTaskId === "TASK-VERTICAL"
      && liveAuthorization.members[1]?.nativeTaskId
        === restartedSecondTask.nativeTaskId
      && liveAuthorization.members[1]?.semanticTaskId
        === "TASK-VERTICAL-SECOND",
      "CCC_PRODUCT_LIVE_CONFIRMATION_MISSING",
      JSON.stringify(liveAuthorization),
    );
    ledger.pass("live-execution-human-hold", {
      executionAuthorizationId: liveAuthorization.authorizationId,
      expiresAt: liveConfirmation.expiresAt,
      memberCount: liveAuthorization.members.length,
      childApprovalIds: mainAuthorizationHold.childApprovalIds,
      childConfirmations: liveHold.liveExecutionApprovalConfirmations,
      targetHead: targetBase,
      workItemState: liveHold.status.workItems[0].state,
    });

    // Diagnostic child approval IDs are intentionally not spendable in sealed
    // mode, even when paired with the correct parent confirmation digest.
    const refusedChildApprovals = [];
    for (const childApprovalId of mainAuthorizationHold.childApprovalIds) {
      const refusal = jsonOutput(
        await prd([
          "approve-execution",
          idempotencyKey,
          childApprovalId,
          "--confirm",
          liveConfirmation.confirmation,
        ], [1]),
        `refuse diagnostic child execution approval ${childApprovalId}`,
      );
      assert(
        refusal.kind === "refusal"
        && refusal.diagnostics?.some(
          ({ code }) => code === "CCC_PRD_LIVE_EXECUTION_APPROVAL_MISSING",
        ),
        "CCC_PRODUCT_CHILD_EXECUTION_APPROVAL_ACCEPTED",
        JSON.stringify({ childApprovalId, refusal }),
      );
      refusedChildApprovals.push({
        childApprovalId,
        diagnostic: "CCC_PRD_LIVE_EXECUTION_APPROVAL_MISSING",
      });
    }
    const statusAfterChildRefusal = await readStatus();
    assert(
      statusAfterChildRefusal.status.executionAuthorization?.status
        === "issued"
      && statusAfterChildRefusal.status.providerAttempts.length === 0,
      "CCC_PRODUCT_CHILD_EXECUTION_APPROVAL_LEFT_RESIDUE",
      JSON.stringify(statusAfterChildRefusal.status),
    );
    const executionApproved = jsonOutput(
      await prd([
        "approve-execution",
        idempotencyKey,
        liveAuthorization.authorizationId,
        "--confirm",
        liveConfirmation.confirmation,
      ]),
      "approve execution",
    );
    assert(
      executionApproved.kind === "execution-approved"
      && executionApproved.executionAuthorizationId
        === liveAuthorization.authorizationId
      && executionApproved.approval?.status === "claimed",
      "CCC_PRODUCT_EXECUTION_APPROVAL_FAILED",
      JSON.stringify(executionApproved),
    );

    ledger.pass("single-campaign-execution-authorization", {
      executionAuthorizationId: liveAuthorization.authorizationId,
      authorizationDigest: liveAuthorization.authorizationDigest,
      memberSetHash: liveAuthorization.memberSetHash,
      expectedRequestCount: liveAuthorization.expectedRequestCount,
      members: liveAuthorization.members,
      childApprovalRefusals: refusedChildApprovals,
      approvalCalls: 1,
      statusAfterApproval: executionApproved.approval.status,
    });

    const mergeHold = await poll(
      "merge approval hold",
      readStatus,
      (value) => value.status?.nextAction?.kind === "approve-merge",
      async () => ({ serve: tail(server.output()), status: await readStatus() }),
    );
    const task = taskFor(mergeHold.status, "TASK-VERTICAL");
    const secondTask = taskFor(mergeHold.status, "TASK-VERTICAL-SECOND");
    const verticalProviderAttempts = mergeHold.status.providerAttempts;
    exactArray(
      verticalProviderAttempts.map(({ semanticTaskId }) => semanticTaskId),
      ["TASK-VERTICAL", "TASK-VERTICAL-SECOND"],
      "CCC_PRODUCT_SEALED_AUTHORIZATION_PROVIDER_SET_DRIFT",
    );
    assert(
      mergeHold.status.executionAuthorization?.authorizationId
        === liveAuthorization.authorizationId
      && mergeHold.status.executionAuthorization?.status === "settled"
      && mergeHold.liveExecutionApprovalConfirmations?.length === 0
      && verticalProviderAttempts.every(({ state }) => state === "committed")
      && JSON.stringify(verticalProviderAttempts.map(
        ({ attemptOrdinal }) => attemptOrdinal,
      )) === JSON.stringify([1, 2])
      && JSON.stringify(verticalProviderAttempts.map(
        ({ requestCount }) => requestCount,
      )) === JSON.stringify([1, 2])
      && mergeHold.status.tasks.length === 2,
      "CCC_PRODUCT_SEALED_AUTHORIZATION_NOT_SETTLED",
      JSON.stringify({
        executionAuthorization: mergeHold.status.executionAuthorization,
        liveExecutionApprovalConfirmations:
          mergeHold.liveExecutionApprovalConfirmations,
        providerAttempts: verticalProviderAttempts,
      }),
    );
    assert(
      task.semanticTaskId === "TASK-VERTICAL"
      && task.route?.providerId === "openai"
      && task.route?.modelId === "gpt-5.6-sol"
      && task.route?.transport === "cli"
      && task.route?.executor === "cli-agent"
      && task.route?.cliAdapterId === "codex"
      && task.route?.toolMode === "coding"
      && task.route?.worktreeMode === "isolated",
      "CCC_PRODUCT_CODING_ROUTE_DRIFT",
      JSON.stringify(task),
    );
    exactArray(
      task.route.ownedPaths,
      ["src/value.txt"],
      "CCC_PRODUCT_OWNED_PATH_DRIFT",
    );
    exactArray(
      task.route.allowedWriteRoots,
      ["src/value.txt"],
      "CCC_PRODUCT_WRITE_ROOT_DRIFT",
    );
    const canonicalWorktree = task.worktree
      ? await realpath(task.worktree)
      : null;
    const canonicalWorktreesRoot = await realpath(worktreesRoot);
    const worktreeRelative = canonicalWorktree
      ? path.relative(canonicalWorktreesRoot, canonicalWorktree)
      : "";
    assert(
      canonicalWorktree
      && canonicalWorktree !== targetRoot
      && worktreeRelative.length > 0
      && worktreeRelative !== ".."
      && !worktreeRelative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(worktreeRelative),
      "CCC_PRODUCT_WORKTREE_CUSTODY_INVALID",
      JSON.stringify({
        worktree: canonicalWorktree,
        worktreesRoot: canonicalWorktreesRoot,
        relative: worktreeRelative,
      }),
    );
    ledger.pass("coding-route-and-worktree-custody", {
      semanticTaskId: task.semanticTaskId,
      route: task.route,
      worktree: canonicalWorktree,
      branch: task.branch,
      baseCommit: task.baseCommit,
    });

    // The chained task runs in its own registered worktree whose history
    // already contains the first task's commit, and each task's diff stays
    // inside its own owned path.
    assert(
      secondTask.route?.providerId === "openai"
      && secondTask.route?.modelId === "gpt-5.6-terra"
      && secondTask.route?.transport === "cli"
      && secondTask.route?.executor === "cli-agent"
      && secondTask.route?.cliAdapterId === "codex"
      && secondTask.route?.toolMode === "coding"
      && secondTask.route?.worktreeMode === "isolated"
      && secondTask.route.modelId !== task.route.modelId,
      "CCC_PRODUCT_SECOND_CODING_ROUTE_DRIFT",
      JSON.stringify(secondTask),
    );
    exactArray(
      secondTask.route.ownedPaths,
      ["src/second.txt"],
      "CCC_PRODUCT_SECOND_OWNED_PATH_DRIFT",
    );
    exactArray(
      secondTask.route.allowedWriteRoots,
      ["src/second.txt"],
      "CCC_PRODUCT_SECOND_WRITE_ROOT_DRIFT",
    );
    const canonicalSecondWorktree = secondTask.worktree
      ? await realpath(secondTask.worktree)
      : null;
    const secondWorktreeRelative = canonicalSecondWorktree
      ? path.relative(canonicalWorktreesRoot, canonicalSecondWorktree)
      : "";
    assert(
      canonicalSecondWorktree
      && canonicalSecondWorktree !== targetRoot
      && canonicalSecondWorktree !== canonicalWorktree
      && secondWorktreeRelative.length > 0
      && secondWorktreeRelative !== ".."
      && !secondWorktreeRelative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(secondWorktreeRelative),
      "CCC_PRODUCT_SECOND_WORKTREE_CUSTODY_INVALID",
      JSON.stringify({
        worktree: canonicalSecondWorktree,
        firstWorktree: canonicalWorktree,
        worktreesRoot: canonicalWorktreesRoot,
        relative: secondWorktreeRelative,
      }),
    );
    const registeredWorktrees = (
      await git(targetRoot, "worktree", "list", "--porcelain")
    )
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length));
    const canonicalRegisteredWorktrees = await Promise.all(
      registeredWorktrees.map((candidate) => realpath(candidate)),
    );
    assert(
      canonicalRegisteredWorktrees.includes(canonicalWorktree)
      && canonicalRegisteredWorktrees.includes(canonicalSecondWorktree),
      "CCC_PRODUCT_CHAINED_WORKTREE_NOT_REGISTERED",
      JSON.stringify({
        registered: canonicalRegisteredWorktrees,
        first: canonicalWorktree,
        second: canonicalSecondWorktree,
      }),
    );
    const firstTaskCommit = await git(canonicalWorktree, "rev-parse", "HEAD");
    const secondTaskCommit = await git(
      canonicalSecondWorktree,
      "rev-parse",
      "HEAD",
    );
    const chainAncestry = await run(
      "/usr/bin/git",
      ["merge-base", "--is-ancestor", firstTaskCommit, secondTaskCommit],
      { cwd: canonicalSecondWorktree, allowedExitCodes: [0, 1] },
    );
    assert(
      firstTaskCommit !== secondTaskCommit
      && firstTaskCommit !== targetBase
      && secondTaskCommit !== targetBase
      && chainAncestry.code === 0,
      "CCC_PRODUCT_CHAINED_WORKTREE_ANCESTRY_REFUSED",
      JSON.stringify({
        targetBase,
        firstTaskCommit,
        secondTaskCommit,
        mergeBaseExitCode: chainAncestry.code,
      }),
    );
    exactArray(
      (await git(
        targetRoot,
        "diff",
        "--name-only",
        targetBase,
        firstTaskCommit,
      )).split("\n").filter(Boolean),
      ["src/value.txt"],
      "CCC_PRODUCT_FIRST_TASK_MUTATION_SCOPE_DRIFT",
    );
    exactArray(
      (await git(
        targetRoot,
        "diff",
        "--name-only",
        firstTaskCommit,
        secondTaskCommit,
      )).split("\n").filter(Boolean),
      ["src/second.txt"],
      "CCC_PRODUCT_SECOND_TASK_MUTATION_SCOPE_DRIFT",
    );
    ledger.pass("chained-task-worktree-custody", {
      worktrees: [
        {
          semanticTaskId: task.semanticTaskId,
          worktree: canonicalWorktree,
          branch: task.branch,
          headCommit: firstTaskCommit,
          ownedPaths: task.route.ownedPaths,
          mutationPaths: ["src/value.txt"],
        },
        {
          semanticTaskId: secondTask.semanticTaskId,
          worktree: canonicalSecondWorktree,
          branch: secondTask.branch,
          headCommit: secondTaskCommit,
          ownedPaths: secondTask.route.ownedPaths,
          mutationPaths: ["src/second.txt"],
        },
      ],
      distinctRegisteredWorktrees: true,
      firstCommitIsAncestorOfSecond: true,
      maxConcurrent: 1,
      maxWorktrees: 2,
    });

    const valueTaskProof = exactProofStatus(
      mergeHold.status,
      "PROOF-VERTICAL-VALUE-TASK",
    );
    const secondTaskProof = exactProofStatus(
      mergeHold.status,
      "PROOF-VERTICAL-SECOND-TASK",
    );
    const integratedProof = exactProofStatus(
      mergeHold.status,
      "PROOF-VERTICAL-INTEGRATED",
    );
    assert(
      mergeHold.status.proofs.length === 3
      && valueTaskProof.attempts.length === 1
      && secondTaskProof.attempts.length === 1
      && integratedProof.attempts.length === 1,
      "CCC_PRODUCT_PROOF_SET_INVALID",
      JSON.stringify(mergeHold.status.proofs),
    );
    const valueTaskAttempt = valueTaskProof.attempts[0];
    const secondTaskAttempt = secondTaskProof.attempts[0];
    const integratedAttempt = integratedProof.attempts[0];
    const sourceCommit = integratedAttempt.sourceCommit;
    const firstTaskTree = await git(
      targetRoot,
      "rev-parse",
      `${firstTaskCommit}^{tree}`,
    );
    const secondTaskTree = await git(
      targetRoot,
      "rev-parse",
      `${secondTaskCommit}^{tree}`,
    );
    assert(
      /^[0-9a-f]{40}$/.test(sourceCommit) && sourceCommit !== targetBase,
      "CCC_PRODUCT_CAMPAIGN_COMMIT_INVALID",
      sourceCommit,
    );
    exactArray(
      (await git(targetRoot, "diff", "--name-only", targetBase, sourceCommit))
        .split("\n")
        .filter(Boolean),
      ["src/second.txt", "src/value.txt"],
      "CCC_PRODUCT_CAMPAIGN_MUTATION_SCOPE_DRIFT",
    );
    assert(
      await git(targetRoot, "show", `${sourceCommit}:src/value.txt`) === "good"
      && await git(targetRoot, "show", `${sourceCommit}:src/second.txt`)
        === "second-good",
      "CCC_PRODUCT_CAMPAIGN_COMMIT_CONTENT_INVALID",
      sourceCommit,
    );
    assert(
      await git(targetRoot, "rev-parse", "refs/heads/main") === targetBase,
      "CCC_PRODUCT_LANDED_BEFORE_MERGE_APPROVAL",
      await git(targetRoot, "rev-parse", "refs/heads/main"),
    );
    ledger.pass("campaign-created-commit", {
      sourceCommit,
      sourceTree: await git(targetRoot, "rev-parse", `${sourceCommit}^{tree}`),
      mutationPaths: ["src/second.txt", "src/value.txt"],
      targetHeadStill: targetBase,
    });

    assertPassingSemanticProofAttempt(valueTaskAttempt, {
      proofId: "PROOF-VERTICAL-VALUE-TASK",
      phase: "task",
      sourceCommit: firstTaskCommit,
      sourceTree: firstTaskTree,
      clauseIds: ["AC-REQ-VERTICAL-001"],
      caseIds: ["CASE-VERTICAL-VALUE"],
      controlIds: ["CONTROL-VERTICAL-BAD"],
      mutationPaths: ["src/value.txt"],
    }, "CCC_PRODUCT_VALUE_TASK_PROOF_INVALID");
    assertPassingSemanticProofAttempt(secondTaskAttempt, {
      proofId: "PROOF-VERTICAL-SECOND-TASK",
      phase: "task",
      sourceCommit: secondTaskCommit,
      sourceTree: secondTaskTree,
      clauseIds: ["AC-REQ-VERTICAL-SECOND-001"],
      caseIds: ["CASE-VERTICAL-SECOND"],
      controlIds: ["CONTROL-VERTICAL-PENDING"],
      mutationPaths: ["src/second.txt"],
    }, "CCC_PRODUCT_SECOND_TASK_PROOF_INVALID");
    assertPassingSemanticProofAttempt(integratedAttempt, {
      proofId: "PROOF-VERTICAL-INTEGRATED",
      phase: "final_integrated",
      sourceCommit: secondTaskCommit,
      sourceTree: secondTaskTree,
      clauseIds: [
        "AC-REQ-VERTICAL-001",
        "AC-REQ-VERTICAL-SECOND-001",
      ],
      caseIds: ["CASE-VERTICAL-INTEGRATED"],
      controlIds: ["CONTROL-VERTICAL-INTEGRATED"],
      mutationPaths: ["src/second.txt", "src/value.txt"],
    }, "CCC_PRODUCT_FINAL_INTEGRATED_PROOF_INVALID");
    const verticalCampaignAudit = await readCampaignAuditRows(
      isolatedHome,
      mergeHold.status.projectId,
      imported.result.importId,
    );
    const secondTaskDispatch = exactProviderDispatchAudit(
      verticalCampaignAudit,
      "TASK-VERTICAL-SECOND",
    );
    assertOrderedInstants(
      valueTaskAttempt.settledAt,
      secondTaskDispatch.timestamp,
      "CCC_PRODUCT_SECOND_TASK_RELEASED_BEFORE_TASK_PROOF",
      {
        settledProofAttemptKey: valueTaskAttempt.attemptKey,
        dependentProviderAttemptKey: secondTaskDispatch.metadata.attemptKey,
      },
    );
    assertOrderedInstants(
      secondTaskAttempt.settledAt,
      integratedAttempt.dispatchedAt,
      "CCC_PRODUCT_FINAL_PROOF_RELEASED_BEFORE_TASK_PROOF",
      {
        settledProofAttemptKey: secondTaskAttempt.attemptKey,
        finalProofAttemptKey: integratedAttempt.attemptKey,
      },
    );
    const proofAttempts = [
      valueTaskAttempt,
      secondTaskAttempt,
      integratedAttempt,
    ];
    assert(
      proofAttempts.every((attempt) =>
        attempt.packetHash === mergeHold.status.import.packetHash
        && attempt.sidecarHash === mergeHold.status.import.sidecarHash
        && attempt.bundleHash === mergeHold.status.import.bundleHash
        && attempt.manifestHash === mergeHold.status.import.manifestHash)
      && valueTaskAttempt.semanticTaskId === "TASK-VERTICAL"
      && secondTaskAttempt.semanticTaskId === "TASK-VERTICAL-SECOND"
      && integratedAttempt.semanticTaskId === "TASK-VERTICAL-SECOND",
      "CCC_PRODUCT_PROOF_PROVENANCE_MISMATCH",
      JSON.stringify(proofAttempts),
    );
    ledger.pass("task-phase-proofs-committed", {
      proofs: [valueTaskProof, secondTaskProof].map(({ definition, attempts }) => ({
        proofId: definition.id,
        phase: attempts[0].phase,
        attemptKey: attempts[0].attemptKey,
        sourceCommit: attempts[0].sourceCommit,
        terminalEnvelopeSha256: attempts[0].terminalEnvelopeSha256,
        proofEvidenceSha256: attempts[0].proofEvidenceSha256,
      })),
      distinctSourceCommits:
        valueTaskAttempt.sourceCommit !== secondTaskAttempt.sourceCommit,
      executionOrder: {
        valueTaskProofSettledAt: valueTaskAttempt.settledAt,
        secondTaskProviderDispatchedAt: secondTaskDispatch.timestamp,
        secondTaskProofSettledAt: secondTaskAttempt.settledAt,
        finalIntegratedProofDispatchedAt: integratedAttempt.dispatchedAt,
      },
    });
    ledger.pass("commit-bound-proof-executed", {
      attemptKey: integratedAttempt.attemptKey,
      sourceCommit,
      sourceTree: integratedAttempt.sourceTree,
      definitionSha256: integratedAttempt.definitionSha256,
      commandSha256: integratedAttempt.commandSha256,
      terminalEnvelopeSha256: integratedAttempt.terminalEnvelopeSha256,
      proofEvidenceSha256: integratedAttempt.proofEvidenceSha256,
      dispatchedAt: integratedAttempt.dispatchedAt,
      settledAt: integratedAttempt.settledAt,
    });

    // The final_integrated receipt is deliberately separate from both task
    // receipts and is bound to the terminal task's combined commit.
    assert(
      sourceCommit === secondTaskCommit
      && integratedProof.definition.phases?.length === 1
      && integratedProof.definition.phases[0] === "final_integrated"
      && valueTaskProof.definition.phases?.[0] === "task"
      && secondTaskProof.definition.phases?.[0] === "task",
      "CCC_PRODUCT_INTEGRATED_PROOF_INVALID",
      JSON.stringify({
        proofCount: mergeHold.status.proofs.length,
        sourceCommit,
        secondTaskCommit,
        integratedProof,
      }),
    );
    exactArray(
      (await git(targetRoot, "diff", "--name-only", targetBase, sourceCommit))
        .split("\n")
        .filter(Boolean),
      ["src/second.txt", "src/value.txt"],
      "CCC_PRODUCT_INTEGRATED_PROOF_SCOPE_DRIFT",
    );
    ledger.pass("integrated-proof-over-two-commits", {
      proofId: integratedProof.definition.id,
      proofCount: mergeHold.status.proofs.length,
      attemptCount: integratedProof.attempts.length,
      attemptKey: integratedAttempt.attemptKey,
      sourceCommit,
      firstTaskCommit,
      secondTaskCommit,
      integratedMutationPaths: ["src/second.txt", "src/value.txt"],
      command: integratedProof.definition.command,
      terminalEnvelope: integratedAttempt.terminalEnvelope,
    });
    ledger.pass("final-integrated-proof-committed", {
      proofId: integratedProof.definition.id,
      phase: integratedAttempt.phase,
      attemptKey: integratedAttempt.attemptKey,
      sourceCommit: integratedAttempt.sourceCommit,
      sourceTree: integratedAttempt.sourceTree,
      terminalEnvelopeSha256: integratedAttempt.terminalEnvelopeSha256,
      proofEvidenceSha256: integratedAttempt.proofEvidenceSha256,
      clauseResults: integratedAttempt.proofEvidence.clauseResults,
      positiveCaseResults: integratedAttempt.proofEvidence.positiveCaseResults,
      negativeControlResults:
        integratedAttempt.proofEvidence.negativeControlResults,
    });

    const mergeConfirmation = mergeHold.mergeApprovalConfirmations?.find(
      ({ approvalRequestId, status }) =>
        approvalRequestId === mergeHold.status.nextAction.approvalRequestId
        && status === "issued",
    );
    const mergeApproval = mergeHold.status.approvals.find(
      ({ id }) => id === mergeConfirmation?.approvalRequestId,
    );
    const [mergeProofPrefix, mergeProofCommit, mergeProofTree,
      finalReceiptSetSha256, mergeProofExtra] =
      String(mergeApproval?.runId ?? "").split(":");
    const expectedFinalReceiptSetSha256 = finalProofReceiptSetSha256(
      sourceCommit,
      integratedAttempt.sourceTree,
      [integratedAttempt],
    );
    const expectedFinalProofCustody = {
      schema: "ccc-campaign.final-proof-custody.v2",
      sourceCommit,
      sourceTree: integratedAttempt.sourceTree,
      finalReceiptSetSha256: expectedFinalReceiptSetSha256,
    };
    assert(
      mergeHold.status.workItems[0].state === "manual-required"
      && workItemHasCccPermanentReason(
        mergeHold.status.workItems[0],
        "CCC_CAMPAIGN_MERGE_APPROVAL_REQUIRED",
      )
      && mergeConfirmation
      && /^[0-9a-f]{64}$/.test(mergeConfirmation.confirmation)
      && mergeApproval?.campaign?.binding?.actionTarget === "refs/heads/main"
      && mergeProofPrefix === "ccc-merge-proof-v2"
      && mergeProofCommit === sourceCommit
      && mergeProofTree === integratedAttempt.sourceTree
      && finalReceiptSetSha256 === expectedFinalReceiptSetSha256
      && mergeProofExtra === undefined,
      "CCC_PRODUCT_MERGE_HOLD_INVALID",
      JSON.stringify(mergeHold),
    );
    ledger.pass("merge-human-hold", {
      approvalRequestId: mergeConfirmation.approvalRequestId,
      expiresAt: mergeConfirmation.expiresAt,
      sourceCommit,
      targetHead: targetBase,
      proofAttemptKey: integratedAttempt.attemptKey,
      proofPhase: integratedAttempt.phase,
      proofEvidenceSha256: integratedAttempt.proofEvidenceSha256,
      terminalEnvelopeSha256: integratedAttempt.terminalEnvelopeSha256,
      finalProofCustody: {
        ...expectedFinalProofCustody,
        recomputedFromAttemptKey: integratedAttempt.attemptKey,
      },
    });

    // The same merge hold, read the way an operator reads it: prose only, and
    // carrying the exact command that spends this exact digest.
    const readableStatus = await prdHumanReadable(["status", idempotencyKey]);
    const readableLines = readableStatus.stdout.split("\n");
    const readableJsonLines = readableLines.filter((line) => {
      const trimmed = line.trim();
      return trimmed.startsWith("{") && trimmed.endsWith("}");
    });
    const readableApproveMergeCommand = [
      "fn prd approve-merge",
      idempotencyKey,
      mergeConfirmation.approvalRequestId,
      "--confirm",
      mergeConfirmation.confirmation,
    ].join(" ");
    assert(
      readableJsonLines.length === 0,
      "CCC_PRODUCT_OPERATOR_STATUS_NOT_READABLE",
      JSON.stringify({
        jsonLineCount: readableJsonLines.length,
        sample: readableJsonLines[0] ?? null,
      }),
    );
    assert(
      readableLines.some((line) => line.includes(readableApproveMergeCommand)),
      "CCC_PRODUCT_OPERATOR_STATUS_COMMAND_MISSING",
      JSON.stringify({
        expected: readableApproveMergeCommand,
        stdout: tail(readableStatus.stdout),
      }),
    );
    assert(
      !readableStatus.stdout.includes("claimToken")
      && !readableStatus.stdout.includes("controllerToken"),
      "CCC_PRODUCT_OPERATOR_STATUS_TOKEN_LEAK",
      tail(readableStatus.stdout),
    );
    ledger.pass("operator-readable-status", {
      approvalRequestId: mergeConfirmation.approvalRequestId,
      confirmation: mergeConfirmation.confirmation,
      lineCount: readableLines.length,
      jsonObjectLineCount: readableJsonLines.length,
      approveMergeCommand: readableApproveMergeCommand,
    });

    const mergeApprovalArgs = [
      "approve-merge",
      idempotencyKey,
      mergeConfirmation.approvalRequestId,
      "--confirm",
      mergeConfirmation.confirmation,
    ];
    const reflogBeforeLanding = (
      await git(
        targetRoot,
        "reflog",
        "show",
        "--format=%H",
        "refs/heads/main",
      )
    ).split("\n").filter(Boolean);
    const landingCutpointMarker =
      `cccp-land-${randomUUID().replaceAll("-", "").slice(0, 8)}`;
    landingCutpoint = await armGitLandingTerminalCutpoint(
      isolatedHome,
      landingCutpointMarker,
    );
    landingCommand = startOwnedCommand(
      process.execPath,
      [cliBin, "prd", ...mergeApprovalArgs],
      { cwd: targetRoot, env },
    );
    const landingCommandPid = landingCommand.child.pid;
    const landingCutpointObserved = await poll(
      "Git landing terminal receipt cutpoint",
      async () => ({
        targetHead: await git(
          targetRoot,
          "rev-parse",
          "refs/heads/main",
        ),
        commandRunning:
          landingCommand.child.exitCode === null
          && landingCommand.child.signalCode === null,
      }),
      (value) =>
        value.commandRunning === true
        && value.targetHead !== targetBase,
      async () => ({
        stdout: tail(landingCommand.stdout()),
        stderr: tail(landingCommand.stderr()),
        status: await readStatus(),
      }),
      60_000,
    );
    const landingBackendsAtCrash = await landingCutpoint.sleepingBackends()
      .catch(() => []);
    assert(
      landingBackendsAtCrash.length <= 1,
      "CCC_PRODUCT_GIT_LANDING_BACKEND_AMBIGUOUS",
      JSON.stringify(landingBackendsAtCrash),
    );
    const landedAtCrash = landingCutpointObserved.targetHead;
    const reflogAtCrash = (
      await git(
        targetRoot,
        "reflog",
        "show",
        "--format=%H",
        "refs/heads/main",
      )
    ).split("\n").filter(Boolean);
    exactArray(
      reflogAtCrash,
      [landedAtCrash, ...reflogBeforeLanding],
      "CCC_PRODUCT_GIT_LANDING_CRASH_REFLOG_INVALID",
    );
    assert(
      landedAtCrash !== targetBase
      && landedAtCrash !== sourceCommit
      && await git(targetRoot, "rev-parse", `${landedAtCrash}^{tree}`)
        === await git(targetRoot, "rev-parse", `${sourceCommit}^{tree}`)
      && await git(targetRoot, "status", "--porcelain") === "",
      "CCC_PRODUCT_GIT_LANDING_CRASH_EFFECT_INVALID",
      JSON.stringify({ targetBase, sourceCommit, landedAtCrash }),
    );
    const landingCommandLine = await crashOwnedCommand(
      landingCommand,
      [cliBin, "prd", "approve-merge", idempotencyKey],
    );
    landingCommand = undefined;
    const landingBackendSettlement =
      await settleOwnedLandingDatabaseBackend(landingCutpoint);
    await landingCutpoint.close();
    landingCutpoint = undefined;

    const interruptedLanding = await readStatus();
    const interruptedApproval = interruptedLanding.status.approvals.find(
      ({ id }) => id === mergeConfirmation.approvalRequestId,
    );
    assert(
      interruptedLanding.status.workItems[0]?.state === "manual-required"
      && workItemHasCccPermanentReason(
        interruptedLanding.status.workItems[0],
        "CCC_CAMPAIGN_MERGE_APPROVAL_REQUIRED",
      )
      && interruptedApproval?.status === "claimed"
      && interruptedLanding.status.landing.intents.length === 1
      && interruptedLanding.status.landing.materializations.length === 1
      && interruptedLanding.status.landing.terminals.length === 0
      && interruptedLanding.status.nextAction?.kind === "landing-recovery"
      && await git(targetRoot, "rev-parse", "refs/heads/main")
        === landedAtCrash,
      "CCC_PRODUCT_GIT_LANDING_CRASH_STATE_NOT_DURABLE",
      JSON.stringify(interruptedLanding.status),
    );
    assertLandingFinalProofCustody(
      await readCampaignAuditRows(
        isolatedHome,
        interruptedLanding.status.projectId,
        imported.result.importId,
      ),
      expectedFinalProofCustody,
      ["intent", "checkout-materialized"],
    );

    const landingServerBeforeRestart = server;
    await stopServe(landingServerBeforeRestart);
    server = undefined;
    server = await startServe(targetRoot, serveEnv, port);
    assert(
      landingServerBeforeRestart.child.pid !== server.child.pid,
      "CCC_PRODUCT_GIT_LANDING_RESTART_PROCESS_INVALID",
      JSON.stringify({
        stoppedPid: landingServerBeforeRestart.child.pid,
        restartedPid: server.child.pid,
      }),
    );
    const landingRecoveryHold = await poll(
      "Git landing recovery hold after restart",
      readStatus,
      (value) =>
        value.status?.nextAction?.kind === "landing-recovery"
        && value.status?.landing?.intents?.length === 1
        && value.status?.landing?.materializations?.length === 1
        && value.status?.landing?.terminals?.length === 0,
      async () => ({
        serve: tail(server.output()),
        targetHead: await git(
          targetRoot,
          "rev-parse",
          "refs/heads/main",
        ),
      }),
    );
    exactArray(
      (
        await git(
          targetRoot,
          "reflog",
          "show",
          "--format=%H",
          "refs/heads/main",
        )
      ).split("\n").filter(Boolean),
      reflogAtCrash,
      "CCC_PRODUCT_GIT_LANDING_EFFECT_REPEATED_ON_RESTART",
    );

    const merged = jsonOutput(
      await prd(mergeApprovalArgs),
      "recover approve merge",
    );
    assert(
      merged.kind === "merge-approved"
      && merged.result?.merged === true
      && merged.result?.noOp === false
      && merged.status?.nextAction?.kind === "complete",
      "CCC_PRODUCT_CONTROLLED_LANDING_FAILED",
      JSON.stringify(merged),
    );
    const landedCommit = await git(targetRoot, "rev-parse", "refs/heads/main");
    assert(
      landedCommit !== targetBase
      && landedCommit !== sourceCommit
      && await git(targetRoot, "rev-parse", `${landedCommit}^{tree}`)
        === await git(targetRoot, "rev-parse", `${sourceCommit}^{tree}`),
      "CCC_PRODUCT_LANDING_OBJECT_INVALID",
      JSON.stringify({ targetBase, sourceCommit, landedCommit }),
    );
    exactArray(
      (await git(targetRoot, "diff", "--name-only", targetBase, landedCommit))
        .split("\n")
        .filter(Boolean),
      ["src/second.txt", "src/value.txt"],
      "CCC_PRODUCT_LANDING_SCOPE_DRIFT",
    );
    assert(
      await git(targetRoot, "status", "--porcelain") === ""
      && await readFile(path.join(targetRoot, "src/value.txt"), "utf8") === "good\n"
      && await readFile(path.join(targetRoot, "src/second.txt"), "utf8")
        === "second-good\n",
      "CCC_PRODUCT_LANDING_CHECKOUT_DIRTY",
      await git(targetRoot, "status", "--porcelain"),
    );
    assert(
      merged.status.landing.intents.length === 1
      && merged.status.landing.materializations.length === 1
      && merged.status.landing.terminals.length === 1
      && merged.status.landing.intents[0].metadata.sourceCommit === sourceCommit
      && merged.status.landing.materializations[0].metadata.commitObject
        === landedCommit
      && merged.status.landing.terminals[0].metadata.sourceCommit === sourceCommit,
      "CCC_PRODUCT_LANDING_RECEIPTS_INVALID",
      JSON.stringify(merged.status.landing),
    );
    const landedAuditByPhase = assertLandingFinalProofCustody(
      await readCampaignAuditRows(
        isolatedHome,
        merged.status.projectId,
        imported.result.importId,
      ),
      expectedFinalProofCustody,
      ["intent", "checkout-materialized", "terminal"],
    );
    const reflogAfterRecovery = (
      await git(
        targetRoot,
        "reflog",
        "show",
        "--format=%H",
        "refs/heads/main",
      )
    ).split("\n").filter(Boolean);
    exactArray(
      reflogAfterRecovery,
      reflogAtCrash,
      "CCC_PRODUCT_GIT_LANDING_EFFECT_REPEATED_DURING_RECOVERY",
    );
    const consumedApproval = merged.status.approvals.find(
      ({ id }) => id === mergeConfirmation.approvalRequestId,
    );
    assert(
      landingRecoveryHold.status.workItems[0]?.state === "manual-required"
      && consumedApproval?.status === "consumed"
      && landedCommit === landedAtCrash,
      "CCC_PRODUCT_GIT_LANDING_RECOVERY_SETTLEMENT_INVALID",
      JSON.stringify({
        recoveryWorkItem: landingRecoveryHold.status.workItems[0],
        consumedApproval,
        landedAtCrash,
        landedCommit,
      }),
    );
    ledger.pass("git-landing-restart-no-repeated-effect", {
      approvalRequestId: mergeConfirmation.approvalRequestId,
      approvalStatusAtCrash: interruptedApproval.status,
      approvalStatusAfterRecovery: consumedApproval.status,
      crashedCliPid: landingCommandPid,
      crashedCliCommand: landingCommandLine,
      databaseBackendPid:
        landingBackendsAtCrash[0]?.pid
        ?? landingBackendSettlement.backendPid,
      databaseBackendWait: {
        waitEventType:
          landingBackendsAtCrash[0]?.wait_event_type ?? null,
        waitEvent: landingBackendsAtCrash[0]?.wait_event ?? null,
      },
      databaseBackendSettlement: landingBackendSettlement,
      stoppedServePid: landingServerBeforeRestart.child.pid,
      restartedServePid: server.child.pid,
      targetBase,
      sourceCommit,
      landedCommit,
      refEffectCount: reflogAfterRecovery.length - reflogBeforeLanding.length,
      landingBeforeRecovery: interruptedLanding.status.landing,
      landingAfterRecovery: merged.status.landing,
      landingFinalProofCustody: Object.fromEntries(
        Object.entries(landedAuditByPhase).map(([phase, row]) => [
          phase,
          row.metadata.finalProofCustody,
        ]),
      ),
    });
    ledger.pass("controlled-landing", {
      targetBase,
      sourceCommit,
      landedCommit,
      landing: merged.status.landing,
      mutationPaths: ["src/second.txt", "src/value.txt"],
    });

    await stopServe(server);
    server = undefined;
    restartedServer = await startServe(targetRoot, serveEnv, port);
    const recovered = await poll(
      "terminal status after restart",
      readStatus,
      (value) => value.status?.nextAction?.kind === "complete",
      async () => ({
        serve: tail(restartedServer.output()),
        targetHead: await git(targetRoot, "rev-parse", "refs/heads/main"),
      }),
    );
    assert(
      await git(targetRoot, "rev-parse", "refs/heads/main") === landedCommit
      && recovered.status.proofs.length === 3
      && recovered.status.proofs.every(({ attempts }) => attempts.length === 1)
      && recovered.status.landing.intents.length === 1
      && recovered.status.landing.materializations.length === 1
      && recovered.status.landing.terminals.length === 1
      && recovered.status.orphanProofAttempts.length === 0
      && await git(targetRoot, "status", "--porcelain") === "",
      "CCC_PRODUCT_TERMINAL_RESTART_REPLAYED_EFFECT",
      JSON.stringify(recovered.status),
    );
    ledger.pass("terminal-restart-recovery", {
      targetHead: landedCommit,
      proofAttempts: recovered.status.proofs.map(({ definition, attempts }) => ({
        proofId: definition.id,
        attemptKey: attempts[0].attemptKey,
        phase: attempts[0].phase,
      })),
      landingReceiptCounts: {
        intents: recovered.status.landing.intents.length,
        materializations: recovered.status.landing.materializations.length,
        terminals: recovered.status.landing.terminals.length,
      },
      nextAction: recovered.status.nextAction,
    });

    // ---- Series-parallel fan-out lane -------------------------------------
    // TASK-FAN-A -> {TASK-FAN-B, TASK-FAN-C} -> TASK-FAN-D through the SAME
    // packet -> authoring -> validate -> policy -> preview -> import -> serve
    // harness as the vertical campaign, in the same target repo under its own
    // idempotency key. The lane ends with the operator stop control at the
    // merge hold: landing collisions with the vertical lane's reflog proofs
    // are structurally impossible because this campaign never lands.
    await stopServe(restartedServer);
    restartedServer = undefined;

    // Fresh entry worktrees fork from a new frozen baseline whose Taskfile
    // declares one strict controller-owned target per fan task plus a separate
    // final_integrated target. That closure is committed before packet freeze
    // and remains outside every model-owned write root.
    const fanoutBase = await initializeFanoutProofBaseline(targetRoot);
    assert(
      fanoutBase !== landedCommit
      && await git(targetRoot, "rev-parse", "refs/heads/main") === fanoutBase
      && await git(targetRoot, "diff", "--name-only", landedCommit, fanoutBase)
        === "Taskfile.yml",
      "CCC_PRODUCT_FANOUT_PROOF_BASELINE_INVALID",
      JSON.stringify({ landedCommit, fanoutBase }),
    );
    const fanoutPacketRoot = path.join(tempRoot, "packet-fanout");
    const fanoutProjectsRoot = path.join(tempRoot, "active-projects-fanout");
    const fanoutPacket = await createFanoutPacket(
      fanoutPacketRoot,
      fanoutProjectsRoot,
      targetRoot,
      fanoutBase,
      env,
    );

    const fanoutProposalText = await readFile(fanoutPacket.proposalPath, "utf8");
    const fanoutProposal = JSON.parse(fanoutProposalText);
    const fanoutFrozenSourcePath =
      fanoutProposal.requirements[0]?.acceptanceClauses?.[0]
        ?.sourceRefs?.[0]?.path;
    assert(
      typeof fanoutFrozenSourcePath === "string",
      "CCC_PRODUCT_FANOUT_SOURCE_CLAUSE_REFERENCE_MISSING",
      JSON.stringify(fanoutProposal.requirements),
    );
    assertExactAcceptanceClauseGrammar(
      await readFile(path.join(fanoutPacketRoot, fanoutFrozenSourcePath), "utf8"),
      fanoutProposal,
      "CCC_PRODUCT_FANOUT_SOURCE_CLAUSE_GRAMMAR_INVALID",
    );
    const fanoutAuthoring = await startNativeAuthoringServer(fanoutProposalText);
    authoringServer = fanoutAuthoring.server;
    await configureNativeAuthoring(fanoutAuthoring.baseUrl);
    const fanoutAuthored = jsonOutput(
      await prd([
        "author",
        fanoutPacketRoot,
        fanoutPacket.manifestPath,
        fanoutPacket.sidecarPath,
        "--target",
        targetRoot,
        "--base",
        fanoutBase,
        "--provider",
        "ccc-product-authoring",
        "--model",
        "vertical-authoring-model",
        // The author command's bounds flags are the ADMITTED campaign bounds
        // and must byte-match the proposal's bounds (authoring refuses with
        // CCC_PRD_AUTHORING_BOUNDS_DRIFT otherwise).
        "--max-requests",
        String(fanoutCampaignMaxRequests),
        "--max-duration-ms",
        String(fanoutCampaignMaxDurationMs),
        "--max-concurrency",
        "1",
        "--max-prompt-bytes",
        "262144",
        "--max-response-bytes",
        "262144",
        // 4 live-execution actions + 1 merge action = 5 review items.
        "--max-review-items",
        "8",
      ]),
      "prd fanout author",
    );
    assert(
      fanoutAuthored.kind === "candidate",
      "CCC_PRODUCT_FANOUT_AUTHORING_FAILED",
      JSON.stringify(fanoutAuthored),
    );
    const fanoutAuthoredSidecar = JSON.parse(
      await readFile(fanoutPacket.sidecarPath, "utf8"),
    );
    const fanoutSemanticProofIds = [
      ...fanTasks.map(fanoutTaskProofIdFor),
      "PROOF-FANOUT-INTEGRATED",
    ].sort();
    assert(
      fanoutAuthoredSidecar.schema === "ccc-prd.sidecar.v2"
      && fanoutAuthoredSidecar.requirements?.flatMap(
        ({ acceptanceClauses = [] }) => acceptanceClauses,
      ).length === fanTasks.length
      && fanoutAuthoredSidecar.proofs?.length === fanTasks.length + 1
      && fanoutAuthoredSidecar.proofs.every((proof) =>
        proof.schema === "ccc-prd.proof.v2"
        && proof.admission?.schema === "ccc-prd.proof-admission.v2"
        && proof.executionToolchain?.proofHost?.id
          === "fusion-cli-semantic-proof-host.v1"
        && proof.verifierClosure?.some(({ role, path: closurePath }) =>
          role === "task_runner" && closurePath === "Taskfile.yml")
        && proof.verifierClosure?.some(({ role, path: closurePath }) =>
          role === "harness" && closurePath === "verify-fanout.cjs")),
      "CCC_PRODUCT_FANOUT_SEMANTIC_AUTHORITY_INVALID",
      JSON.stringify(fanoutAuthoredSidecar),
    );
    exactArray(
      fanoutAuthoredSidecar.proofs.map(({ id }) => id).sort(),
      fanoutSemanticProofIds,
      "CCC_PRODUCT_FANOUT_SEMANTIC_PROOF_SET_DRIFT",
    );
    const fanoutAuthoredProofsById = new Map(
      fanoutAuthoredSidecar.proofs.map((proof) => [proof.id, proof]),
    );
    for (const fanTask of fanTasks) {
      await assertControllerHydratedProofCustody({
        proof: fanoutAuthoredProofsById.get(fanoutTaskProofIdFor(fanTask)),
        targetRoot,
        targetBase: fanoutBase,
        command: fanoutTaskProofCommandFor(fanTask),
        phase: "task",
        harnessPath: "verify-fanout.cjs",
        candidateInputs: [fanTask.file],
      });
    }
    await assertControllerHydratedProofCustody({
      proof: fanoutAuthoredProofsById.get("PROOF-FANOUT-INTEGRATED"),
      targetRoot,
      targetBase: fanoutBase,
      command: "task verify:fanout-integrated",
      phase: "final_integrated",
      harnessPath: "verify-fanout.cjs",
      candidateInputs: fanTasks.map(({ file }) => file),
    });
    await stopNativeAuthoringServer(authoringServer);
    authoringServer = undefined;

    // Authoring configuration rewrote the isolated HOME settings file, and the
    // diamond needs capacity for four simultaneous custody worktrees, so the
    // settings are re-imported before the lane's serve. maxConcurrent stays at
    // 1: the fan-out proof is about graph shape and join ancestry, not about
    // parallel scheduling.
    const fanoutSettingsPath = path.join(fanoutPacketRoot, "settings.json");
    await writeFile(fanoutSettingsPath, `${JSON.stringify({
      version: 2,
      exportedAt: new Date().toISOString(),
      global: {
        openrouterModelSync: false,
        opencodeGoModelSync: false,
        experimentalFeatures: { cliAgentExecutor: true },
      },
      project: {
        maxConcurrent: 1,
        maxWorktrees: 8,
        pollIntervalMs: 500,
        worktreesDir: worktreesRoot,
      },
    }, null, 2)}\n`);
    await run(
      process.execPath,
      [
        cliBin,
        "settings",
        "import",
        fanoutSettingsPath,
        "--scope",
        "both",
        "--merge",
        "--yes",
      ],
      { cwd: targetRoot, env, timeoutMs: 240_000 },
    );

    const fanoutPacketArgs = [
      fanoutPacketRoot,
      fanoutPacket.manifestPath,
      fanoutPacket.sidecarPath,
      fanoutPacket.executionPlanPath,
      targetRoot,
      fanoutBase,
    ];
    const fanoutValidated = jsonOutput(
      await prd([
        "validate",
        fanoutPacketRoot,
        fanoutPacket.manifestPath,
        fanoutPacket.sidecarPath,
        targetRoot,
        fanoutBase,
      ]),
      "prd fanout validate",
    );
    const fanoutCompiled = jsonOutput(
      await prd([
        "compile",
        fanoutPacketRoot,
        fanoutPacket.manifestPath,
        fanoutPacket.sidecarPath,
        targetRoot,
        fanoutBase,
      ]),
      "prd fanout compile",
    );
    assert(
      fanoutValidated.kind === "diagnostics" && fanoutValidated.valid === true,
      "CCC_PRODUCT_FANOUT_PACKET_VALIDATION_FAILED",
      JSON.stringify(fanoutValidated),
    );
    exactArray(
      fanoutCompiled.tasks?.map(({ id }) => id),
      fanTasks.map(({ taskId }) => taskId),
      "CCC_PRODUCT_FANOUT_TASK_SET_DRIFT",
    );
    exactArray(
      fanoutCompiled.proofs?.map(({ id }) => id).sort(),
      fanoutSemanticProofIds,
      "CCC_PRODUCT_FANOUT_PROOF_SET_DRIFT",
    );
    assert(
      fanoutCompiled.schema === "ccc-prd.bundle.v2",
      "CCC_PRODUCT_FANOUT_BUNDLE_VERSION_DRIFT",
      fanoutCompiled.schema,
    );

    const fanoutRoutesPath = path.join(fanoutPacketRoot, "routes.json");
    await writeFile(
      fanoutRoutesPath,
      `${JSON.stringify({
        schema: "ccc-prd.routes-by-task.v1",
        routes: Object.fromEntries(fanTasks.map((fanTask, index) => [
          fanTask.taskId,
          {
            providerId: "openai",
            modelId: index % 2 === 0 ? "gpt-5.6-sol" : "gpt-5.6-terra",
            transport: "cli",
            cliAdapterId: "codex",
          },
        ])),
      }, null, 2)}\n`,
    );
    const fanoutPlan = jsonOutput(
      await prd([
        "policy",
        fanoutPacketRoot,
        fanoutPacket.manifestPath,
        fanoutPacket.sidecarPath,
        targetRoot,
        fanoutBase,
        fanoutPacket.executionPlanPath,
        "--routes-file",
        fanoutRoutesPath,
      ]),
      "prd fanout policy",
    );
    const fanoutExecutionPlan = JSON.parse(
      await readFile(fanoutPacket.executionPlanPath, "utf8"),
    );
    assert(
      fanoutPlan.kind === "execution-plan"
      && fanoutPlan.routeCount === fanTasks.length
      && fanoutExecutionPlan.schema === "ccc-prd.execution-plan.v1"
      && fanoutExecutionPlan.policy?.schema
        === "ccc-campaign.execution-policy.v2",
      "CCC_PRODUCT_FANOUT_EXECUTION_PLAN_INVALID",
      JSON.stringify(fanoutPlan),
    );

    const fanoutPreview = jsonOutput(
      await prd(["preview", ...fanoutPacketArgs]),
      "prd fanout preview",
    );
    assert(
      fanoutPreview.kind === "preview"
      && /^[0-9a-f]{64}$/u.test(fanoutPreview.confirmationDigest),
      "CCC_PRODUCT_FANOUT_PREVIEW_INVALID",
      JSON.stringify(fanoutPreview),
    );

    const fanoutKey = `${idempotencyKey}-fanout`;
    const fanoutImported = jsonOutput(
      await prd([
        "import",
        ...fanoutPacketArgs,
        fanoutKey,
        "--confirm",
        fanoutPreview.confirmationDigest,
      ]),
      "prd fanout import",
    );
    assert(
      fanoutImported.kind === "imported"
      && fanoutImported.result?.state === "active"
      && fanoutImported.result?.runnable === true,
      "CCC_PRODUCT_FANOUT_IMPORT_NOT_RUNNABLE",
      JSON.stringify(fanoutImported),
    );
    ledger.pass("fanout-campaign-import-admitted", {
      importId: fanoutImported.result.importId,
      idempotencyKey: fanoutKey,
      baseCommit: fanoutBase,
      graph: {
        entry: "TASK-FAN-A",
        branches: ["TASK-FAN-B", "TASK-FAN-C"],
        join: "TASK-FAN-D",
        edges: 4,
      },
      packetHash: fanoutPacket.freeze.packetHash,
      routeCount: fanoutPlan.routeCount,
    });

    const readFanoutStatus = async () => readStatusFor(fanoutKey);
    server = await startServe(targetRoot, serveEnv, port);

    // One parent decision seals all four exact fan-out members. Every child ID
    // remains diagnostic only and is independently refused by the CLI.
    const fanoutAuthorizationHold = await awaitSealedExecutionAuthorization(
      "fanout sealed execution authorization",
      readFanoutStatus,
      fanTasks.length,
    );
    const fanoutAuthorization = fanoutAuthorizationHold.authorization;
    const fanoutChildRefusals = [];
    for (const childApprovalId of fanoutAuthorizationHold.childApprovalIds) {
      const refusal = jsonOutput(
        await prd([
          "approve-execution",
          fanoutKey,
          childApprovalId,
          "--confirm",
          fanoutAuthorizationHold.confirmation.confirmation,
        ], [1]),
        `refuse fanout diagnostic child ${childApprovalId}`,
      );
      assert(
        refusal.kind === "refusal"
        && refusal.diagnostics?.some(
          ({ code }) => code === "CCC_PRD_LIVE_EXECUTION_APPROVAL_MISSING",
        ),
        "CCC_PRODUCT_FANOUT_CHILD_APPROVAL_ACCEPTED",
        JSON.stringify({ childApprovalId, refusal }),
      );
      fanoutChildRefusals.push({
        childApprovalId,
        diagnostic: "CCC_PRD_LIVE_EXECUTION_APPROVAL_MISSING",
      });
    }
    const fanoutPreApprovalStatus = await readFanoutStatus();
    assert(
      fanoutPreApprovalStatus.status.executionAuthorization?.status === "issued"
      && fanoutPreApprovalStatus.status.providerAttempts.length === 0,
      "CCC_PRODUCT_FANOUT_CHILD_REFUSAL_LEFT_RESIDUE",
      JSON.stringify(fanoutPreApprovalStatus.status),
    );
    const fanoutApproved = jsonOutput(
      await prd([
        "approve-execution",
        fanoutKey,
        fanoutAuthorization.authorizationId,
        "--confirm",
        fanoutAuthorizationHold.confirmation.confirmation,
      ]),
      "approve fanout sealed execution",
    );
    assert(
      fanoutApproved.kind === "execution-approved"
      && fanoutApproved.executionAuthorizationId
        === fanoutAuthorization.authorizationId
      && fanoutApproved.approval?.status === "claimed",
      "CCC_PRODUCT_FANOUT_EXECUTION_APPROVAL_FAILED",
      JSON.stringify(fanoutApproved),
    );

    const fanoutMergeHold = await poll(
      "fanout merge approval hold",
      readFanoutStatus,
      (value) => value.status?.nextAction?.kind === "approve-merge",
      async () => ({
        serve: tail(server.output()),
        status: await readFanoutStatus(),
      }),
    );
    const fanoutStatusTasks = Object.fromEntries(fanTasks.map((fanTask) => [
      fanTask.taskId,
      taskFor(fanoutMergeHold.status, fanTask.taskId),
    ]));
    const fanoutNativeIds = Object.fromEntries(
      Object.entries(fanoutStatusTasks).map(([semanticTaskId, statusTask]) => [
        semanticTaskId,
        statusTask.nativeTaskId,
      ]),
    );
    const fanoutProviderAttempts = fanoutMergeHold.status.providerAttempts;
    exactArray(
      fanoutProviderAttempts
        .map(({ semanticTaskId }) => semanticTaskId)
        .sort(),
      fanTasks.map(({ taskId }) => taskId).sort(),
      "CCC_PRODUCT_FANOUT_PROVIDER_TASK_SET_DRIFT",
    );
    exactArray(
      fanoutProviderAttempts.map(({ attemptOrdinal }) => attemptOrdinal).sort(
        (left, right) => left - right,
      ),
      [1, 2, 3, 4],
      "CCC_PRODUCT_FANOUT_PROVIDER_ATTEMPT_ORDINAL_DRIFT",
    );
    exactArray(
      fanoutProviderAttempts.map(({ requestCount }) => requestCount).sort(
        (left, right) => left - right,
      ),
      [1, 2, 3, 4],
      "CCC_PRODUCT_FANOUT_PROVIDER_REQUEST_COUNT_DRIFT",
    );
    // The parent member order is frozen packet order and names every native
    // task exactly once; there is no second operator hold during execution.
    exactArray(
      fanoutAuthorization.members.map(({ semanticTaskId }) => semanticTaskId),
      fanTasks.map(({ taskId }) => taskId),
      "CCC_PRODUCT_FANOUT_APPROVAL_TASK_SET_DRIFT",
    );
    assert(
      fanoutAuthorization.members.every((member) =>
        fanoutNativeIds[member.semanticTaskId] === member.nativeTaskId)
      && new Set(fanoutAuthorizationHold.childApprovalIds).size
        === fanTasks.length
      && fanoutMergeHold.status.executionAuthorization?.authorizationId
        === fanoutAuthorization.authorizationId
      && fanoutMergeHold.status.executionAuthorization?.status === "settled"
      && fanoutMergeHold.status.executionAuthorization?.memberCustody?.length
        === fanTasks.length
      && fanoutMergeHold.status.executionAuthorization.memberCustody.every(
        (custody) => custody.status === "consumed"
          && fanoutNativeIds[custody.semanticTaskId] === custody.nativeTaskId
          && fanoutAuthorization.members.some((member) =>
            member.approvalRequestId === custody.approvalRequestId
            && member.bindingHash === custody.bindingHash),
      )
      && fanoutMergeHold.liveExecutionApprovalConfirmations?.length === 0
      && fanoutProviderAttempts.every(({ state }) => state === "committed"),
      "CCC_PRODUCT_FANOUT_APPROVAL_ORDER_INVALID",
      JSON.stringify({ fanoutAuthorization, fanoutNativeIds }),
    );

    // Route custody per task: disjoint single-file ownership end to end.
    for (const fanTask of fanTasks) {
      const statusTask = fanoutStatusTasks[fanTask.taskId];
      assert(
        statusTask.route?.executor === "cli-agent"
        && statusTask.route?.toolMode === "coding"
        && statusTask.route?.worktreeMode === "isolated",
        "CCC_PRODUCT_FANOUT_ROUTE_DRIFT",
        JSON.stringify({ taskId: fanTask.taskId, route: statusTask.route }),
      );
      exactArray(
        statusTask.route.ownedPaths,
        [fanTask.file],
        "CCC_PRODUCT_FANOUT_OWNED_PATH_DRIFT",
      );
    }

    // The join ancestry proof: each branch worktree HEAD descends from the
    // entry commit but NOT from its sibling branch, and the join task's HEAD
    // descends from BOTH branches — a real merged fork-join, not a disguised
    // chain.
    const fanoutHeads = {};
    for (const fanTask of fanTasks) {
      const statusTask = fanoutStatusTasks[fanTask.taskId];
      assert(
        typeof statusTask.worktree === "string" && statusTask.worktree.length > 0,
        "CCC_PRODUCT_FANOUT_WORKTREE_MISSING",
        JSON.stringify({ taskId: fanTask.taskId }),
      );
      fanoutHeads[fanTask.taskId] = await git(
        await realpath(statusTask.worktree),
        "rev-parse",
        "HEAD",
      );
    }
    const fanoutTaskDeltas = {};
    for (const fanTask of fanTasks) {
      const statusTask = fanoutStatusTasks[fanTask.taskId];
      assert(
        /^[0-9a-f]{40}$/u.test(statusTask.baseCommit ?? "")
        && statusTask.baseCommit === fanoutBase,
        "CCC_PRODUCT_FANOUT_TASK_BASE_DRIFT",
        JSON.stringify({
          taskId: fanTask.taskId,
          expectedBase: fanoutBase,
          observedBase: statusTask.baseCommit,
        }),
      );
      const commitLine = (
        await git(
          targetRoot,
          "rev-list",
          "--parents",
          "-n",
          "1",
          fanoutHeads[fanTask.taskId],
        )
      ).split(" ");
      assert(
        commitLine.length === 2
        && commitLine[0] === fanoutHeads[fanTask.taskId],
        "CCC_PRODUCT_FANOUT_TASK_COMMIT_SHAPE_DRIFT",
        JSON.stringify({ taskId: fanTask.taskId, commitLine }),
      );
      const executionStartCommit = commitLine[1];
      const expectedExecutionStart = fanTask.taskId === "TASK-FAN-A"
        ? fanoutBase
        : fanTask.taskId === "TASK-FAN-D"
          ? executionStartCommit
          : fanoutHeads["TASK-FAN-A"];
      assert(
        executionStartCommit === expectedExecutionStart,
        "CCC_PRODUCT_FANOUT_EXECUTION_START_DRIFT",
        JSON.stringify({
          taskId: fanTask.taskId,
          executionStartCommit,
          expectedExecutionStart,
        }),
      );
      const mutationPaths = (await git(
        targetRoot,
        "diff",
        "--name-only",
        executionStartCommit,
        fanoutHeads[fanTask.taskId],
      )).split("\n").filter(Boolean);
      exactArray(
        mutationPaths,
        [fanTask.file],
        "CCC_PRODUCT_FANOUT_TASK_MUTATION_SCOPE_DRIFT",
      );
      fanoutTaskDeltas[fanTask.taskId] = {
        frozenBaseCommit: statusTask.baseCommit,
        executionStartCommit,
        headCommit: fanoutHeads[fanTask.taskId],
        mutationPaths,
        changedPathsSha256: changedPathsSha256(mutationPaths),
      };
    }
    const ancestor = async (base, head) => {
      const result = await run(
        "/usr/bin/git",
        ["merge-base", "--is-ancestor", base, head],
        { cwd: targetRoot, allowedExitCodes: [0, 1] },
      );
      return result.code === 0;
    };
    const fanoutAncestry = {
      entryIntoBranchB: await ancestor(
        fanoutHeads["TASK-FAN-A"],
        fanoutHeads["TASK-FAN-B"],
      ),
      entryIntoBranchC: await ancestor(
        fanoutHeads["TASK-FAN-A"],
        fanoutHeads["TASK-FAN-C"],
      ),
      branchBIntoJoin: await ancestor(
        fanoutHeads["TASK-FAN-B"],
        fanoutHeads["TASK-FAN-D"],
      ),
      branchCIntoJoin: await ancestor(
        fanoutHeads["TASK-FAN-C"],
        fanoutHeads["TASK-FAN-D"],
      ),
      branchBIntoBranchC: await ancestor(
        fanoutHeads["TASK-FAN-B"],
        fanoutHeads["TASK-FAN-C"],
      ),
      branchCIntoBranchB: await ancestor(
        fanoutHeads["TASK-FAN-C"],
        fanoutHeads["TASK-FAN-B"],
      ),
      branchBIntoJoinBase: await ancestor(
        fanoutHeads["TASK-FAN-B"],
        fanoutTaskDeltas["TASK-FAN-D"].executionStartCommit,
      ),
      branchCIntoJoinBase: await ancestor(
        fanoutHeads["TASK-FAN-C"],
        fanoutTaskDeltas["TASK-FAN-D"].executionStartCommit,
      ),
    };
    assert(
      fanoutAncestry.entryIntoBranchB
      && fanoutAncestry.entryIntoBranchC
      && fanoutAncestry.branchBIntoJoin
      && fanoutAncestry.branchCIntoJoin
      && !fanoutAncestry.branchBIntoBranchC
      && !fanoutAncestry.branchCIntoBranchB
      && fanoutAncestry.branchBIntoJoinBase
      && fanoutAncestry.branchCIntoJoinBase,
      "CCC_PRODUCT_FANOUT_JOIN_ANCESTRY_REFUSED",
      JSON.stringify({ fanoutHeads, fanoutAncestry }),
    );

    // Every fan task has its own task-phase receipt, followed by a distinct
    // final_integrated receipt bound to the join commit.
    const fanoutTaskProofReceipts = [];
    const fanoutTaskProofAttempts = {};
    assert(
      fanoutMergeHold.status.proofs.length === fanTasks.length + 1
      && fanoutMergeHold.status.proofs.every(
        ({ attempts }) => attempts.length === 1,
      ),
      "CCC_PRODUCT_FANOUT_PROOF_SET_INVALID",
      JSON.stringify(fanoutMergeHold.status.proofs),
    );
    for (const fanTask of fanTasks) {
      const taskProof = exactProofStatus(
        fanoutMergeHold.status,
        fanoutTaskProofIdFor(fanTask),
      );
      const taskAttempt = taskProof.attempts[0];
      const taskTree = await git(
        targetRoot,
        "rev-parse",
        `${fanoutHeads[fanTask.taskId]}^{tree}`,
      );
      assertPassingSemanticProofAttempt(taskAttempt, {
        proofId: fanoutTaskProofIdFor(fanTask),
        phase: "task",
        sourceCommit: fanoutHeads[fanTask.taskId],
        sourceTree: taskTree,
        clauseIds: [fanoutClauseIdFor(fanTask)],
        caseIds: [`CASE-${fanTask.taskId.slice("TASK-".length)}`],
        controlIds: [
          `CONTROL-${fanTask.taskId.slice("TASK-".length)}-PENDING`,
        ],
        mutationPaths: [fanTask.file],
      }, "CCC_PRODUCT_FANOUT_TASK_PROOF_INVALID");
      fanoutTaskProofAttempts[fanTask.taskId] = taskAttempt;
      fanoutTaskProofReceipts.push({
        taskId: fanTask.taskId,
        proofId: taskProof.definition.id,
        attemptKey: taskAttempt.attemptKey,
        sourceCommit: taskAttempt.sourceCommit,
        sourceTree: taskAttempt.sourceTree,
        changedPathsSha256: taskAttempt.terminalEnvelope.changedPathsSha256,
        terminalEnvelopeSha256: taskAttempt.terminalEnvelopeSha256,
        proofEvidenceSha256: taskAttempt.proofEvidenceSha256,
        dispatchedAt: taskAttempt.dispatchedAt,
        settledAt: taskAttempt.settledAt,
      });
    }
    const fanoutProof = exactProofStatus(
      fanoutMergeHold.status,
      "PROOF-FANOUT-INTEGRATED",
    );
    const fanoutAttempt = fanoutProof.attempts[0];
    const fanoutSourceCommit = fanoutAttempt.sourceCommit;
    const fanoutSourceTree = await git(
      targetRoot,
      "rev-parse",
      `${fanoutSourceCommit}^{tree}`,
    );
    assertPassingSemanticProofAttempt(fanoutAttempt, {
      proofId: "PROOF-FANOUT-INTEGRATED",
      phase: "final_integrated",
      sourceCommit: fanoutHeads["TASK-FAN-D"],
      sourceTree: fanoutSourceTree,
      clauseIds: fanTasks.map(fanoutClauseIdFor),
      caseIds: ["CASE-FANOUT-INTEGRATED"],
      controlIds: ["CONTROL-FANOUT-INTEGRATED-PENDING"],
      mutationPaths: fanTasks.map(({ file }) => file),
    }, "CCC_PRODUCT_FANOUT_FINAL_INTEGRATED_PROOF_INVALID");
    const fanoutCampaignAudit = await readCampaignAuditRows(
      isolatedHome,
      fanoutMergeHold.status.projectId,
      fanoutImported.result.importId,
    );
    const fanoutProviderDispatches = Object.fromEntries(
      fanTasks.map((fanTask) => [
        fanTask.taskId,
        exactProviderDispatchAudit(fanoutCampaignAudit, fanTask.taskId),
      ]),
    );
    for (const dependencyTaskId of ["TASK-FAN-B", "TASK-FAN-C"]) {
      assertOrderedInstants(
        fanoutTaskProofAttempts["TASK-FAN-A"].settledAt,
        fanoutProviderDispatches[dependencyTaskId].timestamp,
        "CCC_PRODUCT_FANOUT_DEPENDENT_RELEASED_BEFORE_TASK_PROOF",
        {
          prerequisiteTaskId: "TASK-FAN-A",
          dependentTaskId: dependencyTaskId,
        },
      );
    }
    for (const prerequisiteTaskId of ["TASK-FAN-B", "TASK-FAN-C"]) {
      assertOrderedInstants(
        fanoutTaskProofAttempts[prerequisiteTaskId].settledAt,
        fanoutProviderDispatches["TASK-FAN-D"].timestamp,
        "CCC_PRODUCT_FANOUT_JOIN_RELEASED_BEFORE_BRANCH_PROOF",
        {
          prerequisiteTaskId,
          dependentTaskId: "TASK-FAN-D",
        },
      );
    }
    assertOrderedInstants(
      fanoutTaskProofAttempts["TASK-FAN-D"].settledAt,
      fanoutAttempt.dispatchedAt,
      "CCC_PRODUCT_FANOUT_FINAL_PROOF_RELEASED_BEFORE_JOIN_PROOF",
      {
        prerequisiteTaskId: "TASK-FAN-D",
        finalProofAttemptKey: fanoutAttempt.attemptKey,
      },
    );
    exactArray(
      (await git(
        targetRoot,
        "diff",
        "--name-only",
        fanoutBase,
        fanoutSourceCommit,
      )).split("\n").filter(Boolean),
      fanTasks.map(({ file }) => file),
      "CCC_PRODUCT_FANOUT_MUTATION_SCOPE_DRIFT",
    );
    for (const fanTask of fanTasks) {
      assert(
        await git(targetRoot, "show", `${fanoutSourceCommit}:${fanTask.file}`)
          === fanTask.value,
        "CCC_PRODUCT_FANOUT_COMMIT_CONTENT_INVALID",
        JSON.stringify({ taskId: fanTask.taskId, file: fanTask.file }),
      );
    }
    const fanoutMergeConfirmation =
      fanoutMergeHold.mergeApprovalConfirmations?.find(
        ({ approvalRequestId, status }) =>
          approvalRequestId === fanoutMergeHold.status.nextAction.approvalRequestId
          && status === "issued",
      );
    const fanoutMergeApproval = fanoutMergeHold.status.approvals.find(
      ({ id }) => id === fanoutMergeConfirmation?.approvalRequestId,
    );
    const [fanoutProofPrefix, fanoutProofCommit, fanoutProofTree,
      fanoutReceiptSetSha256, fanoutProofExtra] =
      String(fanoutMergeApproval?.runId ?? "").split(":");
    const expectedFanoutReceiptSetSha256 = finalProofReceiptSetSha256(
      fanoutSourceCommit,
      fanoutSourceTree,
      [fanoutAttempt],
    );
    assert(
      fanoutMergeHold.status.workItems.length === 1
      && fanoutMergeHold.status.workItems[0].state === "manual-required"
      && workItemHasCccPermanentReason(
        fanoutMergeHold.status.workItems[0],
        "CCC_CAMPAIGN_MERGE_APPROVAL_REQUIRED",
      )
      && fanoutMergeConfirmation
      && fanoutMergeApproval?.campaign?.binding?.actionTarget
        === "refs/heads/main"
      && fanoutProofPrefix === "ccc-merge-proof-v2"
      && fanoutProofCommit === fanoutSourceCommit
      && fanoutProofTree === fanoutSourceTree
      && fanoutReceiptSetSha256 === expectedFanoutReceiptSetSha256
      && fanoutProofExtra === undefined
      && await git(targetRoot, "rev-parse", "refs/heads/main") === fanoutBase,
      "CCC_PRODUCT_FANOUT_LANDED_WITHOUT_APPROVAL",
      JSON.stringify({
        workItems: fanoutMergeHold.status.workItems,
        mainHead: await git(targetRoot, "rev-parse", "refs/heads/main"),
      }),
    );

    // End the lane with the operator stop control: the fan-out proof is about
    // graph execution, and never landing keeps the vertical lane's landing and
    // reflog evidence authoritative.
    const fanoutStopControl = fanoutMergeHold.operatorControls?.find(
      ({ action }) => action === "stop",
    );
    assert(
      fanoutStopControl?.allowed === true
      && /^[0-9a-f]{64}$/u.test(fanoutStopControl.confirmation),
      "CCC_PRODUCT_FANOUT_STOP_CONFIRMATION_MISSING",
      JSON.stringify(fanoutMergeHold.operatorControls),
    );
    const fanoutStopped = jsonOutput(
      await prd([
        "stop",
        fanoutKey,
        "--reason",
        "Fan-out acceptance lane stops at the merge hold with its join proof committed.",
        "--confirm",
        fanoutStopControl.confirmation,
      ]),
      "prd fanout stop",
    );
    assert(
      fanoutStopped.kind === "campaign-stopped"
      && fanoutStopped.result?.workItemState === "cancelled"
      && await git(targetRoot, "rev-parse", "refs/heads/main") === fanoutBase,
      "CCC_PRODUCT_FANOUT_STOP_FAILED",
      JSON.stringify(fanoutStopped),
    );
    ledger.pass("fanout-join-execution-proved", {
      importId: fanoutImported.result.importId,
      executionAuthorization: {
        authorizationId: fanoutAuthorization.authorizationId,
        memberSetHash: fanoutAuthorization.memberSetHash,
        members: fanoutAuthorization.members,
        approvalCalls: 1,
        statusAtMerge: fanoutMergeHold.status.executionAuthorization.status,
        providerAttempts: fanoutProviderAttempts.map((attempt) => ({
          attemptKey: attempt.attemptKey,
          semanticTaskId: attempt.semanticTaskId,
          attemptOrdinal: attempt.attemptOrdinal,
          requestCount: attempt.requestCount,
          state: attempt.state,
        })),
      },
      childApprovalRefusals: fanoutChildRefusals,
      nativeTaskIds: fanoutNativeIds,
      heads: fanoutHeads,
      taskDeltas: fanoutTaskDeltas,
      ancestry: fanoutAncestry,
      sourceCommit: fanoutSourceCommit,
      exactSourceAcceptanceClauseGrammar: true,
      mutationPaths: fanTasks.map(({ file }) => file),
      taskProofReceipts: fanoutTaskProofReceipts,
      proofBeforeDependentDispatch: {
        entryProofSettledAt:
          fanoutTaskProofAttempts["TASK-FAN-A"].settledAt,
        branchDispatches: ["TASK-FAN-B", "TASK-FAN-C"].map((taskId) => ({
          taskId,
          dispatchedAt: fanoutProviderDispatches[taskId].timestamp,
        })),
        branchProofs: ["TASK-FAN-B", "TASK-FAN-C"].map((taskId) => ({
          taskId,
          settledAt: fanoutTaskProofAttempts[taskId].settledAt,
        })),
        joinDispatchedAt: fanoutProviderDispatches["TASK-FAN-D"].timestamp,
        joinProofSettledAt: fanoutTaskProofAttempts["TASK-FAN-D"].settledAt,
        finalIntegratedDispatchedAt: fanoutAttempt.dispatchedAt,
      },
      proofAttemptKey: fanoutAttempt.attemptKey,
      finalIntegratedProofReceipt: {
        phase: fanoutAttempt.phase,
        terminalEnvelopeSha256: fanoutAttempt.terminalEnvelopeSha256,
        proofEvidenceSha256: fanoutAttempt.proofEvidenceSha256,
      },
      mergeApprovalFinalProofCustody: {
        sourceCommit: fanoutProofCommit,
        sourceTree: fanoutProofTree,
        finalReceiptSetSha256: fanoutReceiptSetSha256,
        recomputedFromAttemptKey: fanoutAttempt.attemptKey,
      },
      stopped: fanoutStopped.result,
      mainHeadStill: fanoutBase,
    });

    await stopServe(server);
    server = undefined;

    const repositoryEnd = await repositorySnapshot();
    assertRepositoryUnchanged(repositoryStart, repositoryEnd);
    const checks = ledger.finalize();
    const report = {
      schema: "ccc-prd-product-acceptance.v1",
      result: "pass",
      startedAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(),
      productBoundary:
        "Fresh semantic-v2 PRD packet through controller-hydrated native authoring, one sealed execution authorization, task and final_integrated proof receipts, recovery, and proof-bound merge approval.",
      authoringBoundary: nativeAuthoringEvidence,
      fixtureBoundary:
        "Fresh v2 authoring used one OpenAI-compatible loopback SSE request with a sanitized deterministic model response and no proposal-file bypass; proposal-file was used only to prove legacy-v1 readability plus fresh-product refusal. No secret or live external provider was used.",
      repository: {
        start: repositoryStart,
        end: repositoryEnd,
        unchanged: true,
      },
      target: {
        baseCommit: targetBase,
        campaignCommit: sourceCommit,
        landedCommit,
        fanoutBase,
      },
      exactChecks: checks,
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write("ccc-prd-product-acceptance: PASS\n");
  } catch (error) {
    const diagnostic = {
      schema: "ccc-prd-product-acceptance.failure.v1",
      result: "fail",
      error: error instanceof Error
        ? { name: error.name, message: error.message, stack: error.stack }
        : String(error),
      serveTail: server ? tail(server.output()) : undefined,
      restartedServeTail: restartedServer ? tail(restartedServer.output()) : undefined,
      tempRoot,
    };
    process.stderr.write(`${JSON.stringify(diagnostic, null, 2)}\n`);
    process.exitCode = 1;
  } finally {
    await stopNativeAuthoringServer(authoringServer).catch(() => undefined);
    await cleanupOwnedCommand(landingCommand).catch(() => undefined);
    await landingCutpoint?.close().catch(() => undefined);
    await stopServe(restartedServer).catch(() => undefined);
    await stopServe(server).catch(() => undefined);
    await cleanupOwnedCutpointProcess(
      ownedCutpointMarker,
      ownedFakeCodexPath,
    ).catch(() => undefined);
    await cleanupOwnedProofCutpointMarkers(
      ownedProofCutpointToken,
      proofExecutionTmpRoot,
    ).catch(() => undefined);
    await cleanupOwnedProofExecutionTmpRoot(proofExecutionTmpRoot)
      .catch(() => undefined);
    if (tempRoot && process.env.CCC_PRD_PRODUCT_KEEP_TMP !== "1") {
      await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

await main();
