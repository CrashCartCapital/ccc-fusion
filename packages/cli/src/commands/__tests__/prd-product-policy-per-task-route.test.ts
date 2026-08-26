import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canonicalCccPrdJson,
  CCC_PRD_REQUEST_BUDGET_BELOW_PROVIDER_TASK_FLOOR,
} from "@fusion/core";
import { bootstrapCccCampaignProofAdmissionHost } from "../ccc-native-proof-host.js";
import { runPrdCommand } from "../prd.js";
import { repoRoot } from "./prd-built-cli-fixture.js";

// The packet compiler (packages/engine) now admits a two-task product bundle
// under requireMaterialCoverage as a single linear dependency chain: one
// workflow, one entry task, one terminal task, dependency edges that mirror
// each task's dependencyTaskIds exactly (with a matching dependency_edge
// import intent), pairwise-disjoint ownedPaths, and non-empty
// ownedPaths/allowedWriteRoots on every task. These tests drive that real,
// un-mocked admission path end to end: a hand-authored two-task PRD packet is
// compiled through `fn prd author` (mechanical, adapter-free authoring from a
// fixed proposal file) into a real sidecar, then `fn prd policy` is exercised
// against that real sidecar to prove per-task route selection.

const ROUTE_SUFFIX = "policy-routes";
const TASK_A_ID = `TASK-${ROUTE_SUFFIX}`;
const TASK_B_ID = `TASK-terminal-${ROUTE_SUFFIX}`;
const REQUIREMENT_ID = `REQ-${ROUTE_SUFFIX}`;
const PROOF_ID = `PROOF-${ROUTE_SUFFIX}`;
const WORKFLOW_ID = `WF-${ROUTE_SUFFIX}`;
const EDGE_ID = `EDGE-${ROUTE_SUFFIX}`;
const DOCUMENT_ID = `DOC-${ROUTE_SUFFIX}`;
const ARTIFACT_ID = `ART-${ROUTE_SUFFIX}`;
const CAMPAIGN_ID = `CAMPAIGN-${ROUTE_SUFFIX}`;
const SOURCE_ID = `SOURCE-${ROUTE_SUFFIX}`;
const OWNED_PATH_A = "src/task-0";
const OWNED_PATH_B = "src/task-1";

const packetRoots: string[] = [];

afterEach(() => {
  while (packetRoots.length > 0) {
    const root = packetRoots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

// Matches packages/cli/src/commands/__tests__/prd.test.ts's own
// bootstrapProofAdmission fixture exactly: the default bootstrap resolves
// builtRootPath next to the *running* module, which under vitest is TS
// source, not the built plugin bundle. Point it at the real dist output so
// authoring's fixed proof-admission host resolves.
const bootstrapProofAdmission = () => bootstrapCccCampaignProofAdmissionHost({
  builtRootPath: join(repoRoot, "packages/cli/dist"),
});

/**
 * Builds a real, on-disk two-task PRD packet (packet.md + manifest.json +
 * authoring proposal) whose declared shape satisfies the compiler's product
 * admission rules for a two-task linear chain: TASK_A is the sole entry with
 * no dependencies; TASK_B is the sole terminal, depending on TASK_A; the one
 * declared dependency edge mirrors that relation exactly and carries a
 * dependency_edge import intent; both tasks declare disjoint, non-empty
 * ownedPaths/allowedWriteRoots. Every requirement/task/proof/workflow quote
 * below is an exact, unique substring of packet.md, because the real
 * authoring pipeline (packages/engine/src/ccc-prd/authoring.ts) resolves
 * each sourceRef by locating its exactQuote in the admitted source bytes.
 */
function createTwoTaskPacketRoot() {
  const root = mkdtempSync(join(tmpdir(), "ccc-prd-per-task-route-"));
  packetRoots.push(root);
  const target = join(root, "target");
  const verifierHarness = "verify/routes.mjs";
  mkdirSync(join(target, "verify"), { recursive: true });
  writeFileSync(join(target, "Taskfile.yml"), [
    "version: '3'",
    "tasks:",
    "  verify:routes:",
    "    cmds:",
    `      - node ${verifierHarness} ${OWNED_PATH_A} ${OWNED_PATH_B}`,
    "",
  ].join("\n"));
  writeFileSync(join(target, verifierHarness), "console.log(process.argv.slice(2).join(','));\n");
  execFileSync("/usr/bin/git", ["init", "-b", "main"], { cwd: target });
  execFileSync("/usr/bin/git", ["add", "Taskfile.yml", verifierHarness], { cwd: target });
  execFileSync("/usr/bin/git", [
    "-c", "user.name=Fusion CLI Test",
    "-c", "user.email=fusion-cli-test@example.invalid",
    "commit", "-m", "proof baseline",
  ], { cwd: target });
  const base = execFileSync("/usr/bin/git", ["rev-parse", "HEAD"], { cwd: target, encoding: "utf8" }).trim();
  const controllerRoot = join(root, "controller");
  mkdirSync(controllerRoot);
  const taskExecutablePath = join(controllerRoot, "task-fixture");
  const proofHostPath = join(controllerRoot, "proof-host.mjs");
  writeFileSync(taskExecutablePath, "#!/bin/sh\nprintf 'Task fixture 1.0.0\\n'\n");
  writeFileSync(proofHostPath, "console.log('Fusion CLI proof host fixture 1.0.0');\n");
  chmodSync(taskExecutablePath, 0o755);
  chmodSync(proofHostPath, 0o755);
  const semanticProofToolchainPaths = {
    taskExecutablePath,
    nodeExecutablePath: process.execPath,
    proofHost: {
      id: "fusion-cli-semantic-proof-host.v1" as const,
      executablePath: proofHostPath,
    },
  };

  // Material-coverage admission (analyzeCccPrdMaterialCoverage in
  // packages/engine/src/ccc-prd/material-coverage.ts) requires every
  // markdown heading with a non-empty body to be "dispositioned": its byte
  // range must overlap a requirement's or task's own cited span, or be
  // explicitly marked deferred/out-of-scope. A separate heading per concern
  // (decisions/requirement/proof) leaves those sections uncovered by any
  // task or requirement span, so everything but the two per-task contracts
  // lives under one heading whose full body is exactly the shared
  // requirement's (and proof's) sourceRef quote -- that makes the section's
  // own coverage range overlap the requirement's span, which dispositions it
  // via the requirement's task references.
  const decisionsBlock = [
    "## Reviewed Operator Decisions",
    `Target repository path: ${target}`,
    `Frozen baseline commit: ${base}`,
    "Maximum requests: 1",
    "Maximum duration in milliseconds: 30000",
    "Maximum concurrency: 1",
    `Admitted write root: ${target}/${OWNED_PATH_A}`,
    `Admitted write root: ${target}/${OWNED_PATH_B}`,
    "Admitted write purpose: fixture projection",
    "Non-goal: live provider call",
    `Requirement ${REQUIREMENT_ID} statement: Run two custody-isolated tasks in one dependency chain.`,
    `Requirement ${REQUIREMENT_ID} acceptance behavior: Both tasks execute with disjoint ownership and distinct routes.`,
    `Proof ${PROOF_ID} verifier command: task verify:routes`,
    `Proof ${PROOF_ID} positive oracle: exit 0`,
    `Proof ${PROOF_ID} negative control: missing sidecar refuses`,
  ].join("\n");
  const acceptanceClauseText = "Both tasks execute with disjoint ownership and distinct routes.";
  const requirementBlock = [
    `### Requirement ${REQUIREMENT_ID}`,
    `Requirement statement: Run two custody-isolated tasks in one dependency chain.`,
    `Acceptance behavior: ${acceptanceClauseText}`,
  ].join("\n");
  const acceptanceClauseBlock = [
    "#### Acceptance clauses",
    `- [AC-${REQUIREMENT_ID}-001] ${acceptanceClauseText}`,
  ].join("\n");
  const semanticProofBlock = [
    "## Semantic proof custody",
    "Positive case POS-ROUTES-001: the admitted two-task route candidate passes",
    "Negative control NEG-ROUTES-001: a missing route candidate fails",
    "Verifier closure task runner: Taskfile.yml",
    `Verifier closure harness: ${verifierHarness}`,
    `Candidate input: ${OWNED_PATH_A}`,
    `Candidate input: ${OWNED_PATH_B}`,
  ].join("\n");
  const taskABlock = [
    `## ${TASK_A_ID} execution contract`,
    `Task owned path: ${OWNED_PATH_A}`,
    `Task allowed write root: ${OWNED_PATH_A}`,
  ].join("\n");
  const taskBBlock = [
    `## ${TASK_B_ID} execution contract`,
    `Task owned path: ${OWNED_PATH_B}`,
    `Task allowed write root: ${OWNED_PATH_B}`,
  ].join("\n");

  const source = [
    "# Per-Task Route PRD Packet",
    "",
    decisionsBlock,
    "",
    requirementBlock,
    "",
    acceptanceClauseBlock,
    "",
    semanticProofBlock,
    "",
    taskABlock,
    "",
    taskBBlock,
    "",
  ].join("\n");

  writeFileSync(join(root, "packet.md"), source);
  const manifest = join(root, "manifest.json");
  writeFileSync(manifest, JSON.stringify({
    schema: "ccc-prd.packet.v1",
    source_version: "test",
    entries: [{
      relative_path: "packet.md",
      role: "root",
      authoritative: true,
      sha256: createHash("sha256").update(source).digest("hex"),
    }],
  }, null, 2));

  const requirementRef = { path: "packet.md", exactQuote: requirementBlock };
  const proofRef = { path: "packet.md", exactQuote: decisionsBlock };
  const acceptanceClauseRef = { path: "packet.md", exactQuote: acceptanceClauseText };
  const semanticProofRef = { path: "packet.md", exactQuote: semanticProofBlock };
  const taskARef = { path: "packet.md", exactQuote: taskABlock };
  const taskBRef = { path: "packet.md", exactQuote: taskBBlock };

  const proposal = join(root, "authoring-response.fixture.json");
  writeFileSync(proposal, JSON.stringify({
    schema: "ccc-prd.authoring-proposal.v2",
    authorityRoles: [{
      id: "AUTHORITY-1",
      role: "root",
      sourcePaths: ["packet.md"],
      accountableProducer: "fixture",
    }],
    requirements: [{
      id: REQUIREMENT_ID,
      statement: "Run two custody-isolated tasks in one dependency chain.",
      acceptance: "Both tasks execute with disjoint ownership and distinct routes.",
      accountableProducer: "fixture",
      dependencies: [],
      proofIds: [PROOF_ID],
      acceptanceClauses: [{
        id: `AC-${REQUIREMENT_ID}-001`,
        requirementId: REQUIREMENT_ID,
        text: acceptanceClauseText,
        proofIds: [PROOF_ID],
        sourceRefs: [acceptanceClauseRef],
      }],
      acceptanceDispositions: [],
      sourceRefs: [requirementRef, { path: "packet.md", exactQuote: acceptanceClauseBlock }],
      confidence: "high",
    }],
    proofs: [{
      schema: "ccc-prd.proof.v2",
      id: PROOF_ID,
      requirementIds: [REQUIREMENT_ID],
      clauseIds: [`AC-${REQUIREMENT_ID}-001`],
      command: "task verify:routes",
      phases: ["task", "final_integrated"],
      positiveOracle: "exit 0",
      positiveCases: [{ id: "POS-ROUTES-001", description: "the admitted two-task route candidate passes" }],
      negativeControls: [{ id: "NEG-ROUTES-001", description: "a missing route candidate fails" }],
      verifierClosure: [
        { role: "task_runner", path: "Taskfile.yml", baseGitBlobOid: "0".repeat(40), sha256: "0".repeat(64) },
        { role: "harness", path: verifierHarness, baseGitBlobOid: "0".repeat(40), sha256: "0".repeat(64) },
      ],
      candidateInputs: [OWNED_PATH_A, OWNED_PATH_B],
      executionToolchain: {
        task: { executablePath: "", executableSha256: "0".repeat(64), version: "", versionOutputSha256: "0".repeat(64) },
        node: { executablePath: "", executableSha256: "0".repeat(64), version: "", versionOutputSha256: "0".repeat(64) },
        proofHost: { id: "", executablePath: "", executableSha256: "0".repeat(64), version: "", versionOutputSha256: "0".repeat(64) },
        linkedRuntime: [],
      },
      sourceRefs: [proofRef, semanticProofRef],
      confidence: "high",
    }],
    tasks: [
      {
        id: TASK_A_ID,
        title: "Task A",
        description: "First task in the per-task route chain.",
        accountableProducer: "fixture",
        requirementIds: [REQUIREMENT_ID],
        dependencyTaskIds: [],
        proofIds: [PROOF_ID],
        workflowId: WORKFLOW_ID,
        documentIds: [DOCUMENT_ID],
        artifactIds: [ARTIFACT_ID],
        protectedActionIds: [],
        ownedPaths: [OWNED_PATH_A],
        allowedWriteRoots: [OWNED_PATH_A],
        sourceRefs: [requirementRef, proofRef, semanticProofRef, taskARef],
      },
      {
        id: TASK_B_ID,
        title: "Task B (terminal)",
        description: "Terminal task depending on Task A.",
        accountableProducer: "fixture",
        requirementIds: [REQUIREMENT_ID],
        dependencyTaskIds: [TASK_A_ID],
        proofIds: [PROOF_ID],
        workflowId: WORKFLOW_ID,
        documentIds: [],
        artifactIds: [],
        protectedActionIds: [],
        ownedPaths: [OWNED_PATH_B],
        allowedWriteRoots: [OWNED_PATH_B],
        sourceRefs: [requirementRef, proofRef, semanticProofRef, taskBRef],
      },
    ],
    edges: [{
      id: EDGE_ID,
      fromTaskId: TASK_B_ID,
      toTaskId: TASK_A_ID,
      kind: "depends_on",
    }],
    workflows: [{
      id: WORKFLOW_ID,
      title: "Per-task route workflow",
      taskIds: [TASK_A_ID, TASK_B_ID],
      entryTaskIds: [TASK_A_ID],
      terminalTaskIds: [TASK_B_ID],
      sourceRefs: [requirementRef],
    }],
    documents: [{
      id: DOCUMENT_ID,
      taskId: TASK_A_ID,
      key: "plan",
      title: "Plan",
      content: "Run two custody-isolated tasks in one dependency chain.",
      sourceRefs: [taskARef],
    }],
    artifacts: [{
      id: ARTIFACT_ID,
      taskId: TASK_A_ID,
      type: "proof",
      title: "Proof",
      mimeType: "text/plain",
      content: "pnpm test",
      sourceRefs: [taskARef],
    }],
    importIntents: [
      { id: "IMPORT-task-a", entityType: "task", entityId: TASK_A_ID, operation: "create", target: "project.tasks" },
      { id: "IMPORT-task-b", entityType: "task", entityId: TASK_B_ID, operation: "create", target: "project.tasks" },
      { id: "IMPORT-edge", entityType: "dependency_edge", entityId: EDGE_ID, operation: "create", target: "project.tasks.dependencies" },
      { id: "IMPORT-workflow", entityType: "workflow", entityId: WORKFLOW_ID, operation: "create", target: "project.workflow_work_items" },
      { id: "IMPORT-work-item", entityType: "work_item", entityId: WORKFLOW_ID, operation: "create", target: "project.workflow_work_items" },
      { id: "IMPORT-document", entityType: "document", entityId: DOCUMENT_ID, operation: "create", target: "project.task_documents" },
      { id: "IMPORT-artifact", entityType: "artifact", entityId: ARTIFACT_ID, operation: "create", target: "project.artifacts" },
      { id: "IMPORT-campaign", entityType: "campaign", entityId: CAMPAIGN_ID, operation: "create", target: "project.missions" },
      { id: "IMPORT-source", entityType: "source", entityId: SOURCE_ID, operation: "create", target: "project.ccc_prd_import_sources" },
      { id: "IMPORT-run-audit", entityType: "run_audit", entityId: CAMPAIGN_ID, operation: "create", target: "project.run_audit_events" },
    ],
    protectedActions: [],
    bounds: { maxRequests: 1, maxDurationMs: 30_000, maxConcurrency: 1 },
    admittedWriteRoots: [
      { path: `${target}/${OWNED_PATH_A}`, purpose: "fixture projection" },
      { path: `${target}/${OWNED_PATH_B}`, purpose: "fixture projection" },
    ],
    targetRepository: { path: target, baseCommit: base },
    nonGoals: ["live provider call"],
    unresolvedDecisions: [],
    ambiguities: [],
    exceptions: [],
    confidence: "high",
  }, null, 2));

  return {
    root,
    manifest,
    proposal,
    sidecar: join(root, "candidate.sidecar.json"),
    target,
    base,
    semanticProofToolchainPaths,
  };
}

/** Runs the real `fn prd author` command to mechanically turn the hand-built proposal into a custody-verified sidecar on disk. */
async function authorTwoTaskSidecar(
  packet: ReturnType<typeof createTwoTaskPacketRoot>,
): Promise<void> {
  const output: string[] = [];
  const exit = await runPrdCommand(
    ["author", packet.root, packet.manifest, packet.proposal, packet.sidecar],
    { write: (line) => output.push(line) },
    {
      bootstrapProofAdmission,
      resolveSemanticProofToolchainPaths: () => packet.semanticProofToolchainPaths,
    },
  );
  if (exit !== 0) {
    throw new Error(`two-task fixture authoring failed (exit ${exit}): ${output.join("\n")}`);
  }
}

async function createBelowFloorExecutionPlan() {
  const packet = createTwoTaskPacketRoot();
  await authorTwoTaskSidecar(packet);
  const routesPath = join(packet.root, "routes.json");
  writeFileSync(routesPath, JSON.stringify({
    schema: "ccc-prd.routes-by-task.v1",
    routes: {
      [TASK_A_ID]: { providerId: "provider-x", modelId: "model-x", transport: "pi" },
      [TASK_B_ID]: { providerId: "provider-y", modelId: "model-y", transport: "pi" },
    },
  }));
  const executionPlanPath = join(packet.root, "execution-plan.json");
  const policyOutput: string[] = [];
  const exit = await runPrdCommand([
    "policy",
    packet.root,
    packet.manifest,
    packet.sidecar,
    packet.target,
    packet.base,
    executionPlanPath,
    "--routes-file",
    routesPath,
  ], { write: (line) => policyOutput.push(line) }, {
    resolveSemanticProofToolchainPaths: () => packet.semanticProofToolchainPaths,
  });
  if (exit !== 0) {
    throw new Error(`below-floor execution plan failed (exit ${exit}): ${policyOutput.join("\n")}`);
  }
  return { packet, executionPlanPath };
}

function confirmationDigestForExecutionPlan(
  packet: ReturnType<typeof createTwoTaskPacketRoot>,
  executionPlanPath: string,
  projectId: string,
  projectPath: string,
): string {
  const plan = JSON.parse(readFileSync(executionPlanPath, "utf8")) as {
    bundleHash: string;
    packetHash: string;
    sidecarHash: string;
    policy: unknown;
  };
  return createHash("sha256").update(canonicalCccPrdJson({
    schema: "ccc-prd.product-preview.v1",
    projectId,
    projectPath: resolve(projectPath),
    bundleHash: plan.bundleHash,
    packetHash: plan.packetHash,
    sidecarHash: plan.sidecarHash,
    targetRepository: resolve(packet.target),
    targetBase: packet.base,
    targetHead: packet.base,
    executionPolicy: plan.policy,
  }), "utf8").digest("hex");
}

describe("fn prd policy --routes-file (per-task route selection)", () => {
  it("wires distinct per-task provider/model/transport routes from a routes file into the execution plan", async () => {
    const packet = createTwoTaskPacketRoot();
    await authorTwoTaskSidecar(packet);
    const routesPath = join(packet.root, "routes.json");
    writeFileSync(routesPath, JSON.stringify({
      schema: "ccc-prd.routes-by-task.v1",
      routes: {
        [TASK_A_ID]: {
          providerId: "provider-x",
          modelId: "upstream/model-x",
          transport: "pi",
          receiptAdapterId: "terminal-route-sse-comments.v1",
        },
        [TASK_B_ID]: {
          providerId: "provider-y",
          modelId: "model-y",
          transport: "cli",
          cliAdapterId: "adapter-y",
        },
      },
    }));
    const outputPath = join(packet.root, "execution-plan.json");
    const output: string[] = [];

    const exit = await runPrdCommand([
      "policy",
      packet.root,
      packet.manifest,
      packet.sidecar,
      packet.target,
      packet.base,
      outputPath,
      "--routes-file",
      routesPath,
    ], { write: (line) => output.push(line) }, {
      resolveSemanticProofToolchainPaths: () => packet.semanticProofToolchainPaths,
    });

    expect(exit, output.join("\n")).toBe(0);
    expect(existsSync(outputPath)).toBe(true);
    const plan = JSON.parse(readFileSync(outputPath, "utf8")) as {
      policy: { routes: Array<{
        taskId: string;
        providerId: string;
        modelId: string;
        transport: string;
        cliAdapterId?: string;
        receiptAdapterId?: string;
      }> };
    };
    const routeA = plan.policy.routes.find((route) => route.taskId === TASK_A_ID);
    const routeB = plan.policy.routes.find((route) => route.taskId === TASK_B_ID);
    expect(routeA).toMatchObject({
      providerId: "provider-x",
      modelId: "upstream/model-x",
      transport: "pi",
      receiptAdapterId: "terminal-route-sse-comments.v1",
    });
    expect(routeB).toMatchObject({
      providerId: "provider-y",
      modelId: "model-y",
      transport: "cli",
      cliAdapterId: "adapter-y",
    });
    expect(routeA!.providerId).not.toBe(routeB!.providerId);
    expect(routeA!.modelId).not.toBe(routeB!.modelId);
    expect(JSON.parse(output[0]!)).toMatchObject({ kind: "execution-plan", routeCount: 2 });
  });

  it("refuses preview before host or project work when the campaign request cap is below its provider-task floor", async () => {
    const { packet, executionPlanPath } = await createBelowFloorExecutionPlan();
    const inspectVerifierConfinementReadiness = vi.fn();
    const resolveProject = vi.fn();
    const output: string[] = [];

    expect(await runPrdCommand([
      "preview",
      packet.root,
      packet.manifest,
      packet.sidecar,
      executionPlanPath,
      packet.target,
      packet.base,
      "--json",
    ], { write: (line) => output.push(line) }, {
      inspectVerifierConfinementReadiness,
      resolveProject,
      resolveSemanticProofToolchainPaths: () => packet.semanticProofToolchainPaths,
    })).toBe(1);
    expect(JSON.parse(output[0]!)).toMatchObject({
      kind: "refusal",
      diagnostics: [{
        code: CCC_PRD_REQUEST_BUDGET_BELOW_PROVIDER_TASK_FLOOR,
        message:
          "campaign maxRequests 1 is below the deterministic provider-task floor 2",
      }],
    });
    expect(inspectVerifierConfinementReadiness).not.toHaveBeenCalled();
    expect(resolveProject).not.toHaveBeenCalled();
  });

  it("delegates a below-floor import to core so an exact persisted replay can succeed", async () => {
    const { packet, executionPlanPath } = await createBelowFloorExecutionPlan();
    const projectId = "project-below-floor-replay";
    const projectPath = resolve(packet.target);
    const layer = {};
    const store = { getAsyncLayer: vi.fn(() => layer) };
    const confirmationDigest = confirmationDigestForExecutionPlan(
      packet,
      executionPlanPath,
      projectId,
      projectPath,
    );
    const importCccPrdBundle = vi.fn(async () => ({
      importId: "import-existing-below-floor",
      idempotencyKey: "operator-replay-key",
      bundleHash: "b".repeat(64),
      identityHash: "i".repeat(64),
      targetRepository: packet.target,
      targetBase: packet.base,
      state: "active" as const,
      runnable: true,
      stagingRelativePath: ".fusion/ccc-prd-import-staging/import-existing-below-floor",
      transactionWitness: { transactionId: "tx-replay", writerClasses: [] },
      directCounts: {
        campaigns: 1,
        tasks: 2,
        dependencyEdges: 1,
        workflows: 1,
        documents: 1,
        artifacts: 1,
        sources: 1,
        workItems: 1,
        runAudits: 1,
      },
      replayed: true,
    }));
    const closeProjectStore = vi.fn(async () => undefined);
    const output: string[] = [];

    expect(await runPrdCommand([
      "import",
      packet.root,
      packet.manifest,
      packet.sidecar,
      executionPlanPath,
      packet.target,
      packet.base,
      "operator-replay-key",
      "--confirm",
      confirmationDigest,
      "--json",
    ], { write: (line) => output.push(line) }, {
      inspectVerifierConfinementReadiness: vi.fn(async () => ({
        ready: true,
        backend: "sandbox-exec" as const,
        code: "VERIFIER_CONFINEMENT_READY",
        message: "verifier confinement readiness probe executed successfully",
        trustedPaths: ["/usr/bin/sandbox-exec"] as const,
      })),
      resolveProject: vi.fn(async () => ({
        projectId,
        projectPath,
        projectName: "Below-floor replay",
        isRegistered: true,
        store,
      })),
      closeProjectStore,
      readTargetHead: vi.fn(async () => packet.base),
      importCccPrdBundle,
      resolveSemanticProofToolchainPaths: () => packet.semanticProofToolchainPaths,
      // The proposal-authoring and semantic-custody suites own executable
      // revalidation. These cases pin only the core import delegation result.
      assertSemanticProofV2Custody: vi.fn(async () => undefined),
    })).toBe(0);
    expect(JSON.parse(output[0]!)).toMatchObject({
      kind: "imported",
      confirmationDigest,
      result: {
        importId: "import-existing-below-floor",
        replayed: true,
      },
    });
    expect(importCccPrdBundle).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: "operator-replay-key",
      layer,
      store,
    }));
    expect(closeProjectStore).toHaveBeenCalledTimes(1);
  });

  it("propagates core's stable refusal for a fresh below-floor import", async () => {
    const { packet, executionPlanPath } = await createBelowFloorExecutionPlan();
    const projectId = "project-below-floor-fresh";
    const projectPath = resolve(packet.target);
    const layer = {};
    const store = { getAsyncLayer: vi.fn(() => layer) };
    const confirmationDigest = confirmationDigestForExecutionPlan(
      packet,
      executionPlanPath,
      projectId,
      projectPath,
    );
    const coreRefusal = Object.assign(
      new Error("CCC PRD product import maxRequests 1 is below the provider-task floor 2"),
      { code: CCC_PRD_REQUEST_BUDGET_BELOW_PROVIDER_TASK_FLOOR },
    );
    const importCccPrdBundle = vi.fn(async () => {
      throw coreRefusal;
    });
    const output: string[] = [];

    expect(await runPrdCommand([
      "import",
      packet.root,
      packet.manifest,
      packet.sidecar,
      executionPlanPath,
      packet.target,
      packet.base,
      "operator-fresh-key",
      "--confirm",
      confirmationDigest,
      "--json",
    ], { write: (line) => output.push(line) }, {
      inspectVerifierConfinementReadiness: vi.fn(async () => ({
        ready: true,
        backend: "sandbox-exec" as const,
        code: "VERIFIER_CONFINEMENT_READY",
        message: "verifier confinement readiness probe executed successfully",
        trustedPaths: ["/usr/bin/sandbox-exec"] as const,
      })),
      resolveProject: vi.fn(async () => ({
        projectId,
        projectPath,
        projectName: "Below-floor fresh import",
        isRegistered: true,
        store,
      })),
      closeProjectStore: vi.fn(async () => undefined),
      readTargetHead: vi.fn(async () => packet.base),
      importCccPrdBundle,
      resolveSemanticProofToolchainPaths: () => packet.semanticProofToolchainPaths,
      assertSemanticProofV2Custody: vi.fn(async () => undefined),
    })).toBe(1);
    expect(JSON.parse(output[0]!)).toMatchObject({
      kind: "refusal",
      diagnostics: [{
        code: CCC_PRD_REQUEST_BUDGET_BELOW_PROVIDER_TASK_FLOOR,
        message: "CCC PRD product import maxRequests 1 is below the provider-task floor 2",
      }],
    });
    expect(importCccPrdBundle).toHaveBeenCalledTimes(1);
  });

  it("refuses when the routes file omits a declared task, surfacing the core missing/extra message", async () => {
    const packet = createTwoTaskPacketRoot();
    await authorTwoTaskSidecar(packet);
    const routesPath = join(packet.root, "routes.json");
    writeFileSync(routesPath, JSON.stringify({
      schema: "ccc-prd.routes-by-task.v1",
      routes: {
        [TASK_A_ID]: { providerId: "provider-x", modelId: "model-x", transport: "pi" },
      },
    }));
    const outputPath = join(packet.root, "execution-plan.json");
    const output: string[] = [];

    const exit = await runPrdCommand([
      "policy",
      packet.root,
      packet.manifest,
      packet.sidecar,
      packet.target,
      packet.base,
      outputPath,
      "--routes-file",
      routesPath,
    ], { write: (line) => output.push(line) }, {
      resolveSemanticProofToolchainPaths: () => packet.semanticProofToolchainPaths,
    });

    expect(exit).toBe(1);
    expect(existsSync(outputPath)).toBe(false);
    const refusal = JSON.parse(output[0]!) as { kind: string; diagnostics: Array<{ code: string; message: string }> };
    expect(refusal.kind).toBe("refusal");
    expect(refusal.diagnostics[0]!.message).toMatch(/routesByTaskId must bind every task exactly once/);
    expect(refusal.diagnostics[0]!.message).toContain(TASK_B_ID);
  });

  // These two argument-validation refusals happen in parseProductPolicyArgs,
  // strictly before compileProductBundle ever runs, so they need no real
  // sidecar on disk. Previously this was proven by asserting the mocked
  // compileCccPrdPacket was never invoked; now that the compiler is real and
  // unmocked, the equivalent proof is structural: packet.sidecar is left
  // unwritten, so if compilation were reached it would refuse with a sidecar
  // read/parse diagnostic instead of the route-selection message asserted
  // below. (Noted per instructions: this is a mechanical swap of the "not
  // called" assertion for a stronger behavioral one, not a meaning change.)
  it("refuses when both --routes-file and --provider are given", async () => {
    const packet = createTwoTaskPacketRoot();
    const routesPath = join(packet.root, "routes.json");
    writeFileSync(routesPath, JSON.stringify({
      schema: "ccc-prd.routes-by-task.v1",
      routes: { [TASK_A_ID]: { providerId: "provider-x", modelId: "model-x", transport: "pi" } },
    }));
    const outputPath = join(packet.root, "execution-plan.json");
    const output: string[] = [];

    const exit = await runPrdCommand([
      "policy",
      packet.root,
      packet.manifest,
      packet.sidecar,
      packet.target,
      packet.base,
      outputPath,
      "--routes-file",
      routesPath,
      "--provider",
      "deterministic-fake",
    ], { write: (line) => output.push(line) });

    expect(exit).toBe(1);
    expect(existsSync(outputPath)).toBe(false);
    expect(existsSync(packet.sidecar)).toBe(false);
    const refusal = JSON.parse(output[0]!) as { kind: string; diagnostics: Array<{ code: string; message: string }> };
    expect(refusal.kind).toBe("refusal");
    expect(refusal.diagnostics[0]!.message).toContain("--routes-file");
    expect(refusal.diagnostics[0]!.message).toContain("--provider");
  });

  it("refuses when neither --routes-file nor --provider/--model/--transport is given", async () => {
    const packet = createTwoTaskPacketRoot();
    const outputPath = join(packet.root, "execution-plan.json");
    const output: string[] = [];

    const exit = await runPrdCommand([
      "policy",
      packet.root,
      packet.manifest,
      packet.sidecar,
      packet.target,
      packet.base,
      outputPath,
    ], { write: (line) => output.push(line) });

    expect(exit).toBe(1);
    expect(existsSync(outputPath)).toBe(false);
    expect(existsSync(packet.sidecar)).toBe(false);
    const refusal = JSON.parse(output[0]!) as { kind: string; diagnostics: Array<{ code: string; message: string }> };
    expect(refusal.kind).toBe("refusal");
    expect(refusal.diagnostics[0]!.message).toContain("--routes-file");
    expect(refusal.diagnostics[0]!.message).toContain("--provider");
  });

  it("refuses malformed JSON in the routes file, naming the path, and writes no plan file", async () => {
    const packet = createTwoTaskPacketRoot();
    await authorTwoTaskSidecar(packet);
    const routesPath = join(packet.root, "routes.json");
    writeFileSync(routesPath, "{");
    const outputPath = join(packet.root, "execution-plan.json");
    const output: string[] = [];

    const exit = await runPrdCommand([
      "policy",
      packet.root,
      packet.manifest,
      packet.sidecar,
      packet.target,
      packet.base,
      outputPath,
      "--routes-file",
      routesPath,
    ], { write: (line) => output.push(line) }, {
      resolveSemanticProofToolchainPaths: () => packet.semanticProofToolchainPaths,
    });

    expect(exit).toBe(1);
    expect(existsSync(outputPath)).toBe(false);
    const refusal = JSON.parse(output[0]!) as { kind: string; diagnostics: Array<{ code: string; message: string }> };
    expect(refusal.kind).toBe("refusal");
    expect(refusal.diagnostics[0]!.message).toContain(routesPath);
    expect(refusal.diagnostics[0]!.message).toMatch(/not valid JSON/);
  });

  it("refuses a routes file with the wrong schema", async () => {
    const packet = createTwoTaskPacketRoot();
    await authorTwoTaskSidecar(packet);
    const routesPath = join(packet.root, "routes.json");
    writeFileSync(routesPath, JSON.stringify({
      schema: "ccc-prd.routes-by-task.v0",
      routes: { [TASK_A_ID]: { providerId: "x", modelId: "y", transport: "pi" } },
    }));
    const outputPath = join(packet.root, "execution-plan.json");
    const output: string[] = [];

    const exit = await runPrdCommand([
      "policy", packet.root, packet.manifest, packet.sidecar, packet.target, packet.base,
      outputPath, "--routes-file", routesPath,
    ], { write: (line) => output.push(line) }, {
      resolveSemanticProofToolchainPaths: () => packet.semanticProofToolchainPaths,
    });

    expect(exit).toBe(1);
    expect(existsSync(outputPath)).toBe(false);
    const refusal = JSON.parse(output[0]!) as { diagnostics: Array<{ message: string }> };
    expect(refusal.diagnostics[0]!.message).toContain(routesPath);
    expect(refusal.diagnostics[0]!.message).toContain("ccc-prd.routes-by-task.v1");
  });

  it("refuses a routes file whose routes field is not an object", async () => {
    const packet = createTwoTaskPacketRoot();
    await authorTwoTaskSidecar(packet);
    const routesPath = join(packet.root, "routes.json");
    writeFileSync(routesPath, JSON.stringify({ schema: "ccc-prd.routes-by-task.v1", routes: [] }));
    const outputPath = join(packet.root, "execution-plan.json");
    const output: string[] = [];

    const exit = await runPrdCommand([
      "policy", packet.root, packet.manifest, packet.sidecar, packet.target, packet.base,
      outputPath, "--routes-file", routesPath,
    ], { write: (line) => output.push(line) }, {
      resolveSemanticProofToolchainPaths: () => packet.semanticProofToolchainPaths,
    });

    expect(exit).toBe(1);
    expect(existsSync(outputPath)).toBe(false);
    const refusal = JSON.parse(output[0]!) as { diagnostics: Array<{ message: string }> };
    expect(refusal.diagnostics[0]!.message).toContain(routesPath);
    expect(refusal.diagnostics[0]!.message).toMatch(/routes field must be an object/);
  });

  it("refuses a routes file with an empty routes object", async () => {
    const packet = createTwoTaskPacketRoot();
    await authorTwoTaskSidecar(packet);
    const routesPath = join(packet.root, "routes.json");
    writeFileSync(routesPath, JSON.stringify({ schema: "ccc-prd.routes-by-task.v1", routes: {} }));
    const outputPath = join(packet.root, "execution-plan.json");
    const output: string[] = [];

    const exit = await runPrdCommand([
      "policy", packet.root, packet.manifest, packet.sidecar, packet.target, packet.base,
      outputPath, "--routes-file", routesPath,
    ], { write: (line) => output.push(line) }, {
      resolveSemanticProofToolchainPaths: () => packet.semanticProofToolchainPaths,
    });

    expect(exit).toBe(1);
    expect(existsSync(outputPath)).toBe(false);
    const refusal = JSON.parse(output[0]!) as { diagnostics: Array<{ message: string }> };
    expect(refusal.diagnostics[0]!.message).toContain(routesPath);
    expect(refusal.diagnostics[0]!.message).toMatch(/at least one task route/);
  });

  it("refuses a route entry with an unknown field", async () => {
    const packet = createTwoTaskPacketRoot();
    await authorTwoTaskSidecar(packet);
    const routesPath = join(packet.root, "routes.json");
    writeFileSync(routesPath, JSON.stringify({
      schema: "ccc-prd.routes-by-task.v1",
      routes: {
        [TASK_A_ID]: { providerId: "x", modelId: "y", transport: "pi" },
        [TASK_B_ID]: { providerId: "x", modelId: "y", transport: "pi", surprise: true },
      },
    }));
    const outputPath = join(packet.root, "execution-plan.json");
    const output: string[] = [];

    const exit = await runPrdCommand([
      "policy", packet.root, packet.manifest, packet.sidecar, packet.target, packet.base,
      outputPath, "--routes-file", routesPath,
    ], { write: (line) => output.push(line) }, {
      resolveSemanticProofToolchainPaths: () => packet.semanticProofToolchainPaths,
    });

    expect(exit).toBe(1);
    expect(existsSync(outputPath)).toBe(false);
    const refusal = JSON.parse(output[0]!) as { diagnostics: Array<{ message: string }> };
    expect(refusal.diagnostics[0]!.message).toContain(routesPath);
    expect(refusal.diagnostics[0]!.message).toContain(TASK_B_ID);
    expect(refusal.diagnostics[0]!.message).toMatch(/unknown fields/);
  });

  it("refuses a cli-transport route entry that omits cliAdapterId", async () => {
    const packet = createTwoTaskPacketRoot();
    await authorTwoTaskSidecar(packet);
    const routesPath = join(packet.root, "routes.json");
    writeFileSync(routesPath, JSON.stringify({
      schema: "ccc-prd.routes-by-task.v1",
      routes: {
        [TASK_A_ID]: { providerId: "x", modelId: "y", transport: "pi" },
        [TASK_B_ID]: { providerId: "x", modelId: "y", transport: "cli" },
      },
    }));
    const outputPath = join(packet.root, "execution-plan.json");
    const output: string[] = [];

    const exit = await runPrdCommand([
      "policy", packet.root, packet.manifest, packet.sidecar, packet.target, packet.base,
      outputPath, "--routes-file", routesPath,
    ], { write: (line) => output.push(line) }, {
      resolveSemanticProofToolchainPaths: () => packet.semanticProofToolchainPaths,
    });

    expect(exit).toBe(1);
    expect(existsSync(outputPath)).toBe(false);
    const refusal = JSON.parse(output[0]!) as { diagnostics: Array<{ message: string }> };
    expect(refusal.diagnostics[0]!.message).toContain(routesPath);
    expect(refusal.diagnostics[0]!.message).toContain(TASK_B_ID);
  });
});
