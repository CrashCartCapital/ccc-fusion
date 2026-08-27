import { cccCampaignRequestFloor } from "../ccc-campaign/request-budget.js";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  CccCampaignExecutionPolicy,
  CccCampaignProductExecutionPolicy,
} from "../ccc-campaign/types.js";
import {
  canonicalCccPrdJson,
  computeCccPrdSemanticBundleSha256,
  computeCccPrdProofDefinitionSha256,
  computeCccPrdProofV2AdmissionDigests,
} from "../ccc-prd/contract.js";
import {
  CCC_PRD_SEMANTIC_PROOF_HOST_ID,
  hydrateCccPrdSemanticProofV2Custody,
  type CccPrdSemanticProofToolchainPaths,
} from "../ccc-prd/semantic-proof-custody.js";
import type {
  CccPrdProofV2,
  CccPrdSemanticBundle,
  CccPrdSemanticBundleV2,
} from "../ccc-prd/types.js";

const execFile = promisify(execFileCallback);

export const CCC_PRD_TEST_SOURCE_HASH = "a".repeat(64);
export const CCC_PRD_TEST_BASE = "b".repeat(40);

function span(path = "packet.md") {
  return {
    path,
    byteStart: 0,
    byteEnd: 1,
    line: 1,
    column: 1,
    endLine: 1,
    endColumn: 2,
    sha256: CCC_PRD_TEST_SOURCE_HASH,
    excerptSha256: CCC_PRD_TEST_SOURCE_HASH,
  };
}

export function hashCccPrdImportTestBundle(
  bundleWithoutHash: Omit<CccPrdSemanticBundle, "bundleHash">,
): CccPrdSemanticBundle {
  return {
    ...bundleWithoutHash,
    bundleHash: createHash("sha256")
      .update(canonicalCccPrdJson(bundleWithoutHash), "utf8")
      .digest("hex"),
  };
}

export function rehashCccPrdImportTestBundle(
  bundleWithOldHash: CccPrdSemanticBundle,
): CccPrdSemanticBundle {
  const { bundleHash: _oldBundleHash, ...bundleWithoutHash } = bundleWithOldHash;
  return hashCccPrdImportTestBundle(bundleWithoutHash);
}

export function rehashCccPrdImportTestProductBundleV2(
  bundleWithOldHash: CccPrdSemanticBundleV2,
): CccPrdSemanticBundleV2 {
  const { bundleHash: _oldBundleHash, ...bundleWithoutHash } = bundleWithOldHash;
  return {
    ...bundleWithoutHash,
    bundleHash: computeCccPrdSemanticBundleSha256(bundleWithoutHash),
  };
}

export function createCccPrdImportTestExecutionPolicy(
  bundle: Pick<CccPrdSemanticBundle, "tasks">,
): CccCampaignExecutionPolicy {
  return {
    schema: "ccc-campaign.execution-policy.v1",
    routes: bundle.tasks.map(({ id }) => ({
      taskId: id,
      providerId: "deterministic-fake",
      modelId: "fixture-v1",
      transport: "pi",
    })),
  };
}

export function createCccPrdImportTestProductExecutionPolicy(
  bundle: Pick<CccPrdSemanticBundle, "tasks">,
): CccCampaignProductExecutionPolicy {
  return {
    schema: "ccc-campaign.execution-policy.v2",
    routes: bundle.tasks.map(({ id }, index) => ({
      taskId: id,
      providerId: "deterministic-fake",
      modelId: "fixture-v2",
      transport: "pi",
      executor: "model",
      toolMode: "coding",
      worktreeMode: "isolated",
      ownedPaths: [`src/task-${index}`],
      allowedWriteRoots: [`src/task-${index}`],
      commitPolicy: "required",
    })),
  };
}

export function createCccPrdImportTestBundle(
  targetRoot: string,
  suffix = "base",
): CccPrdSemanticBundle {
  const requirementId = `REQ-${suffix}`;
  const taskId = `TASK-${suffix}`;
  const terminalTaskId = `TASK-terminal-${suffix}`;
  const proofId = `PROOF-${suffix}`;
  const workflowId = `WF-${suffix}`;
  const documentId = `DOC-${suffix}`;
  const artifactId = `ART-${suffix}`;
  const sourceId = `SOURCE-${suffix}`;
  const edgeId = `EDGE-${suffix}`;
  const campaignId = `CAMPAIGN-${suffix}`;
  const auditId = `AUDIT-${suffix}`;
  const workItemId = `WORK-${suffix}`;
  return hashCccPrdImportTestBundle({
    kind: "bundle",
    schema: "ccc-prd.bundle.v1",
    sourceVersion: "phase-c-test",
    sourceHash: CCC_PRD_TEST_SOURCE_HASH,
    sidecarHash: "c".repeat(64),
    orderedSources: [{
      path: "packet.md",
      role: "root",
      authoritative: true,
      sha256: CCC_PRD_TEST_SOURCE_HASH,
      byteLength: 1,
    }],
    provenance: {
      authoringAdapterId: "phase-c-test",
      proposalHash: "e".repeat(64),
      packetHash: CCC_PRD_TEST_SOURCE_HASH,
    },
    authorityRoles: [{
      id: "AUTH-root",
      role: "root",
      sourcePaths: ["packet.md"],
      accountableProducer: "phase-c-test",
    }],
    requirements: [{
      id: requirementId,
      statement: "Import atomically.",
      acceptance: "No runnable partial state.",
      accountableProducer: "phase-c-test",
      dependencies: [],
      proofIds: [proofId],
      spans: [span()],
      confidence: "high",
    }],
    proofs: [{
      id: proofId,
      requirementIds: [requirementId],
      command: "pnpm test",
      positiveOracle: "import active",
      negativeControls: ["rollback"],
      spans: [span()],
      confidence: "high",
    }],
    tasks: [
      {
        id: taskId,
        title: "Import-owned task",
        description: "A task projected only after commit.",
        accountableProducer: "phase-c-test",
        requirementIds: [requirementId],
        dependencyTaskIds: [],
        proofIds: [proofId],
        workflowId,
        documentIds: [documentId],
        artifactIds: [artifactId],
        protectedActionIds: [],
        spans: [span()],
      },
      {
        id: terminalTaskId,
        title: "Terminal import-owned task",
        description: "Dependent terminal task.",
        accountableProducer: "phase-c-test",
        requirementIds: [requirementId],
        dependencyTaskIds: [taskId],
        proofIds: [proofId],
        workflowId,
        documentIds: [],
        artifactIds: [],
        protectedActionIds: [],
        spans: [span()],
      },
    ],
    edges: [{
      id: edgeId,
      fromTaskId: terminalTaskId,
      toTaskId: taskId,
      kind: "depends_on",
    }],
    workflows: [{
      id: workflowId,
      title: "Import workflow",
      taskIds: [taskId, terminalTaskId],
      entryTaskIds: [taskId],
      terminalTaskIds: [terminalTaskId],
      spans: [span()],
    }],
    documents: [{
      id: documentId,
      taskId,
      key: "PROMPT.md",
      title: "Prompt",
      content: "import-owned prompt",
      spans: [span()],
    }],
    artifacts: [{
      id: artifactId,
      taskId,
      type: "text",
      title: "Import evidence",
      mimeType: "text/plain",
      content: "artifact bytes",
      spans: [span()],
    }],
    importIntents: [
      { id: campaignId, entityType: "campaign", entityId: campaignId, operation: "create", target: targetRoot },
      { id: taskId, entityType: "task", entityId: taskId, operation: "create", target: targetRoot },
      { id: terminalTaskId, entityType: "task", entityId: terminalTaskId, operation: "create", target: targetRoot },
      { id: edgeId, entityType: "dependency_edge", entityId: edgeId, operation: "create", target: targetRoot },
      { id: workflowId, entityType: "workflow", entityId: workflowId, operation: "create", target: targetRoot },
      { id: documentId, entityType: "document", entityId: documentId, operation: "create", target: targetRoot },
      { id: artifactId, entityType: "artifact", entityId: artifactId, operation: "create", target: targetRoot },
      { id: sourceId, entityType: "source", entityId: sourceId, operation: "create", target: targetRoot },
      { id: workItemId, entityType: "work_item", entityId: workItemId, operation: "create", target: targetRoot },
      { id: auditId, entityType: "run_audit", entityId: auditId, operation: "create", target: targetRoot },
    ],
    protectedActions: [],
    bounds: { maxRequests: 1, maxDurationMs: 1_000, maxConcurrency: 1 },
    admittedWriteRoots: [{ path: targetRoot, purpose: "disposable test target" }],
    targetRepository: { path: targetRoot, baseCommit: CCC_PRD_TEST_BASE },
    nonGoals: ["No live providers."],
    confidence: "high",
  });
}

export function withCccPrdImportTestProductRequestFloor(
  source: CccPrdSemanticBundle,
): CccPrdSemanticBundle {
  return rehashCccPrdImportTestBundle({
    ...source,
    bounds: {
      ...source.bounds,
      maxRequests: Math.max(source.bounds.maxRequests, cccCampaignRequestFloor(source.tasks.length)),
    },
  });
}

export function createCccPrdImportTestProductBundle(
  targetRoot: string,
  suffix = "base",
): CccPrdSemanticBundle {
  return withCccPrdImportTestProductRequestFloor(
    createCccPrdImportTestBundle(targetRoot, suffix),
  );
}

export type AdmittedCccPrdImportTestProductFixture = Readonly<{
  bundle: CccPrdSemanticBundleV2;
  semanticProofToolchainPaths: CccPrdSemanticProofToolchainPaths;
}>;

const TEST_PROOF_ROOT = ".ccc-prd-test-proof";
const TEST_TASKFILE = "Taskfile.yml";
const TEST_HARNESS = `${TEST_PROOF_ROOT}/verify.mjs`;
const TEST_TASK_EXECUTABLE = `${TEST_PROOF_ROOT}/task-fixture.mjs`;
const TEST_PROOF_HOST = `${TEST_PROOF_ROOT}/proof-host.mjs`;

async function runGit(root: string, args: readonly string[]): Promise<string> {
  const result = await execFile("git", ["-C", root, ...args], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  return result.stdout.trim();
}

async function ensureFrozenSemanticProofFixture(
  targetRoot: string,
  candidateInputs: readonly string[],
): Promise<{ baseCommit: string; toolchainPaths: CccPrdSemanticProofToolchainPaths }> {
  await mkdir(targetRoot, { recursive: true });
  try {
    await runGit(targetRoot, ["rev-parse", "--git-dir"]);
  } catch {
    await runGit(targetRoot, ["init", "-b", "main"]);
  }
  await runGit(targetRoot, ["config", "user.name", "CCC PRD Test"]);
  await runGit(targetRoot, ["config", "user.email", "ccc-prd-test@example.invalid"]);

  const proofRoot = join(targetRoot, TEST_PROOF_ROOT);
  await mkdir(proofRoot, { recursive: true });
  const taskfileBytes = [
    "version: '3'",
    "tasks:",
    ...candidateInputs.flatMap((candidate, index) => [
      `  verify:task-${index}:`,
      "    cmds:",
      `      - node ${TEST_HARNESS} ${candidate}`,
    ]),
    "  verify:integrated:",
    "    cmds:",
    `      - node ${TEST_HARNESS} ${candidateInputs.join(" ")}`,
    "",
  ].join("\n");
  const harnessBytes = [
    "import { access } from 'node:fs/promises';",
    "for (const path of process.argv.slice(2)) await access(path);",
    "",
  ].join("\n");
  const taskExecutableBytes = [
    `#!${process.execPath}`,
    "console.log('Task fixture 1.0.0');",
    "",
  ].join("\n");
  const proofHostBytes = "console.log('Fusion semantic proof host fixture 1.0.0');\n";
  const files = [
    [TEST_TASKFILE, taskfileBytes],
    [TEST_HARNESS, harnessBytes],
    [TEST_TASK_EXECUTABLE, taskExecutableBytes],
    [TEST_PROOF_HOST, proofHostBytes],
  ] as const;
  for (const [relativePath, bytes] of files) {
    const path = join(targetRoot, relativePath);
    let existing: string | undefined;
    try {
      existing = await readFile(path, "utf8");
    } catch {
      existing = undefined;
    }
    if (existing !== bytes) await writeFile(path, bytes, "utf8");
  }
  await chmod(join(targetRoot, TEST_TASK_EXECUTABLE), 0o755);
  await chmod(join(targetRoot, TEST_PROOF_HOST), 0o755);
  await runGit(targetRoot, ["add", "--", ...files.map(([path]) => path)]);
  const staged = await runGit(targetRoot, ["diff", "--cached", "--name-only"]);
  let hasHead = true;
  try {
    await runGit(targetRoot, ["rev-parse", "HEAD"]);
  } catch {
    hasHead = false;
  }
  if (!hasHead || staged.length > 0) {
    await runGit(targetRoot, ["commit", "-m", "test: freeze semantic proof fixture"]);
  }
  return {
    baseCommit: await runGit(targetRoot, ["rev-parse", "HEAD"]),
    toolchainPaths: {
      taskExecutablePath: join(targetRoot, TEST_TASK_EXECUTABLE),
      nodeExecutablePath: process.execPath,
      proofHost: {
        id: CCC_PRD_SEMANTIC_PROOF_HOST_ID,
        executablePath: join(targetRoot, TEST_PROOF_HOST),
      },
    },
  };
}

/**
 * Builds an honestly admitted semantic-v2 product fixture. Git blob identity,
 * file hashes, and executable identity all come from the production custody
 * hydrator; tests may declare semantics but cannot fabricate controller facts.
 */
export async function createAdmittedCccPrdImportTestProductFixture(
  targetRoot: string,
  suffix = "base",
): Promise<AdmittedCccPrdImportTestProductFixture> {
  return admitCccPrdImportTestProductBundle(
    createCccPrdImportTestProductBundle(targetRoot, suffix),
    suffix,
  );
}

/** Upgrade an arbitrary legacy-shaped test graph through real controller custody. */
export async function admitCccPrdImportTestProductBundle(
  legacy: CccPrdSemanticBundle,
  suffix = legacy.bundleHash.slice(0, 12),
): Promise<AdmittedCccPrdImportTestProductFixture> {
  const targetRoot = legacy.targetRepository.path;
  const legacyActionsById = new Map(legacy.protectedActions.map((action) => [action.id, action]));
  const generatedLiveExecutionActionEntries = legacy.tasks.flatMap((task, index) => {
    const assignedLiveActions = (task.protectedActionIds ?? []).filter((actionId) => {
      const action = legacyActionsById.get(actionId);
      return action?.kind === "live_execution"
        && action.operatorDecision === "approve_live_execution"
        && action.requiresOperatorDecision === true;
    });
    if (assignedLiveActions.length > 0) return [];
    return [{
      taskId: task.id,
      action: {
        id: `ACTION-LIVE-${suffix}-${index}`,
        kind: "live_execution" as const,
        target: `ccc-prd-test:${suffix}:live-execution:${index}`,
        requiresOperatorDecision: true as const,
        operatorDecision: "approve_live_execution" as const,
        spans: [task.spans[0] ?? span()],
      },
    }];
  });
  const generatedLiveExecutionActions = generatedLiveExecutionActionEntries.map(({ action }) => action);
  const generatedLiveExecutionActionIdByTaskId = new Map(
    generatedLiveExecutionActionEntries.map(({ taskId, action }) => [taskId, action.id]),
  );
  const candidateInputs = legacy.tasks.map((_, index) => `src/task-${index}/change.txt`);
  const { baseCommit, toolchainPaths } = await ensureFrozenSemanticProofFixture(
    targetRoot,
    candidateInputs,
  );
  const requirementIds = legacy.tasks.map((_, index) => `REQ-v2-${suffix}-${index}`);
  const taskProofIds = legacy.tasks.map((_, index) => `PROOF-v2-${suffix}-${index}`);
  const finalProofId = `PROOF-final-${suffix}`;
  const clauseIds = requirementIds.map((id) => `AC-${id}-001`);
  const semanticProof = (input: {
    id: string;
    requirementIds: string[];
    clauseIds: string[];
    phases: CccPrdProofV2["phases"];
    command: string;
    candidateInputs: string[];
    ordinal: number;
  }): CccPrdProofV2 => ({
    schema: "ccc-prd.proof.v2",
    id: input.id,
    requirementIds: input.requirementIds,
    clauseIds: input.clauseIds,
    phases: input.phases,
    command: input.command,
    positiveOracle: "the declared candidate passes the frozen verifier",
    positiveCases: [{
      id: `POS-${suffix}-${input.ordinal}`,
      description: "the admitted candidate set passes",
    }],
    negativeControls: [{
      id: `NEG-${suffix}-${input.ordinal}`,
      description: "a missing candidate fails",
    }],
    verifierClosure: [
      { role: "task_runner", path: TEST_TASKFILE, baseGitBlobOid: "0".repeat(40), sha256: "0".repeat(64) },
      { role: "harness", path: TEST_HARNESS, baseGitBlobOid: "0".repeat(40), sha256: "0".repeat(64) },
      { role: "config", path: TEST_TASK_EXECUTABLE, baseGitBlobOid: "0".repeat(40), sha256: "0".repeat(64) },
      { role: "config", path: TEST_PROOF_HOST, baseGitBlobOid: "0".repeat(40), sha256: "0".repeat(64) },
    ],
    candidateInputs: input.candidateInputs,
    executionToolchain: {
      task: { executablePath: "", executableSha256: "0".repeat(64), version: "", versionOutputSha256: "0".repeat(64) },
      node: { executablePath: "", executableSha256: "0".repeat(64), version: "", versionOutputSha256: "0".repeat(64) },
      proofHost: { id: "", executablePath: "", executableSha256: "0".repeat(64), version: "", versionOutputSha256: "0".repeat(64) },
      linkedRuntime: [],
    },
    spans: legacy.proofs[0]!.spans,
    confidence: "high",
  });
  const placeholderProofs: CccPrdProofV2[] = [
    ...taskProofIds.map((proofId, index) => semanticProof({
      id: proofId,
      requirementIds: [requirementIds[index]!],
      clauseIds: [clauseIds[index]!],
      phases: ["task"],
      command: `task verify:task-${index}`,
      candidateInputs: [candidateInputs[index]!],
      ordinal: index + 1,
    })),
    semanticProof({
      id: finalProofId,
      requirementIds: [...requirementIds],
      clauseIds: [...clauseIds],
      phases: ["final_integrated"],
      command: "task verify:integrated",
      candidateInputs: [...candidateInputs],
      ordinal: legacy.tasks.length + 1,
    }),
  ];
  const hydrated = await hydrateCccPrdSemanticProofV2Custody({
    repositoryRoot: targetRoot,
    baseCommit,
    proofs: placeholderProofs,
    modelWriteRoots: legacy.tasks.map((_, index) => `src/task-${index}`),
    toolchainPaths,
  });
  const proofs = hydrated.map((proof): CccPrdProofV2 => ({
    ...proof,
    admission: {
      schema: "ccc-prd.proof-admission.v2",
      pluginId: "ccc-prd-test-proof-host",
      pluginVersion: "1.0.0",
      extensionId: "ccc-prd-test-proof-host",
      proofVersion: "2",
      extensionRootRelativeSource: TEST_PROOF_HOST,
      extensionSourceSha256: proof.verifierClosure.find(({ path }) => path === TEST_PROOF_HOST)!.sha256,
      extensionManifestSha256: "1".repeat(64),
      definitionSha256: computeCccPrdProofDefinitionSha256(proof),
      ...computeCccPrdProofV2AdmissionDigests(proof),
    },
  })).sort((left, right) => left.id.localeCompare(right.id));
  const requirements = requirementIds.map((requirementId, index) => ({
    ...legacy.requirements[index % legacy.requirements.length]!,
    id: requirementId,
    statement: `Execute semantic task ${index + 1} under frozen proof custody.`,
    proofIds: [taskProofIds[index]!, finalProofId].sort(),
    acceptanceClauses: [{
      id: clauseIds[index]!,
      requirementId,
      text: `Candidate set ${index + 1} passes the frozen verifier.`,
      proofIds: [taskProofIds[index]!, finalProofId].sort(),
      span: {
        ...legacy.requirements[index % legacy.requirements.length]!.spans[0]!,
        excerptSha256: CCC_PRD_TEST_SOURCE_HASH,
      },
    }],
    acceptanceDispositions: [],
  }));
  const withoutHash: Omit<CccPrdSemanticBundleV2, "bundleHash"> = {
    ...legacy,
    schema: "ccc-prd.bundle.v2",
    targetRepository: { path: targetRoot, baseCommit },
    bounds: {
      ...legacy.bounds,
      maxRequests: Math.max(legacy.bounds.maxRequests, cccCampaignRequestFloor(legacy.tasks.length)),
    },
    requirements,
    proofs,
    protectedActions: [...legacy.protectedActions, ...generatedLiveExecutionActions],
    tasks: legacy.tasks.map((task, index) => ({
      ...task,
      requirementIds: [requirementIds[index]!],
      proofIds: [taskProofIds[index]!, finalProofId].sort(),
      protectedActionIds: [...new Set([
        ...(task.protectedActionIds ?? []),
        ...(generatedLiveExecutionActionIdByTaskId.has(task.id)
          ? [generatedLiveExecutionActionIdByTaskId.get(task.id)!]
          : []),
      ])].sort(),
      ownedPaths: [`src/task-${index}`],
      allowedWriteRoots: [`src/task-${index}`],
    })),
  };
  return {
    bundle: {
      ...withoutHash,
      bundleHash: computeCccPrdSemanticBundleSha256(withoutHash),
    },
    semanticProofToolchainPaths: toolchainPaths,
  };
}
