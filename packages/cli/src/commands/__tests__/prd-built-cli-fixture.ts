import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../../..");
const cliEntry = join(repoRoot, "packages/cli/bin.mjs");
const roots: string[] = [];

function expectGit(root: string, args: string[]): string {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  }
  return result.stdout;
}

export function cleanupPacketRoots() {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
}

export function runFn(args: string[], cwd = repoRoot) {
  return spawnSync(process.execPath, [cliEntry, ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    env: { ...process.env, CI: "1", FUSION_SKIP_ONBOARDING: "1" },
  });
}

export function runFnAsync(
  args: string[],
  cwd = repoRoot,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliEntry, ...args], {
      cwd,
      env: { ...process.env, CI: "1", FUSION_SKIP_ONBOARDING: "1", ...extraEnv },
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (value: Buffer) => stdout.push(value));
    child.stderr.on("data", (value: Buffer) => stderr.push(value));
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }));
  });
}

export function createPacketRoot(options: { semanticV2?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ccc-prd-built-cli-"));
  roots.push(root);
  const target = options.semanticV2 ? join(root, "target") : "fixture/repo";
  let base = "a".repeat(40);
  let semanticProofToolchainPaths: {
    taskExecutablePath: string;
    nodeExecutablePath: string;
    proofHost: {
      id: "fusion-cli-semantic-proof-host.v1";
      executablePath: string;
    };
  } | undefined;
  if (options.semanticV2) {
    const harness = "verify/fixture.mjs";
    const candidate = "src/task-1/change.js";
    mkdirSync(join(target, "verify"), { recursive: true });
    writeFileSync(join(target, "Taskfile.yml"), [
      "version: '3'",
      "tasks:",
      "  verify:fixture:",
      "    cmds:",
      `      - node ${harness} ${candidate}`,
      "",
    ].join("\n"));
    writeFileSync(join(target, harness), "console.log(process.argv.slice(2).join(','));\n");
    expectGit(target, ["init", "-b", "main"]);
    expectGit(target, ["add", "Taskfile.yml", harness]);
    expectGit(target, [
      "-c", "user.name=Fusion CLI Test",
      "-c", "user.email=fusion-cli-test@example.invalid",
      "commit", "-m", "proof baseline",
    ]);
    base = expectGit(target, ["rev-parse", "HEAD"]).trim();
    const controllerRoot = join(root, "controller");
    mkdirSync(controllerRoot);
    const taskExecutablePath = join(controllerRoot, "task-fixture");
    const proofHostPath = join(controllerRoot, "proof-host.mjs");
    writeFileSync(taskExecutablePath, "#!/bin/sh\nprintf 'Task fixture 1.0.0\\n'\n");
    writeFileSync(proofHostPath, "console.log('Fusion CLI proof host fixture 1.0.0');\n");
    chmodSync(taskExecutablePath, 0o755);
    chmodSync(proofHostPath, 0o755);
    semanticProofToolchainPaths = {
      taskExecutablePath,
      nodeExecutablePath: process.execPath,
      proofHost: {
        id: "fusion-cli-semantic-proof-host.v1",
        executablePath: proofHostPath,
      },
    };
  }
  const declarations = {
    schema: "ccc-prd.declarations.v1",
    authority: { source: "prd", producer: "fixture" },
    bounds: { maxRequests: 1, maxDurationMs: 30000, maxConcurrency: 1 },
    admittedWriteRoots: [`${target}/src/task-1`],
    targetRepository: target,
    targetBase: base,
    requirements: [{
      id: "CF-CLI-001",
      statement: "Generate a traceable sidecar.",
      acceptance: "Sidecar has source spans and proof IDs.",
      producer: "fixture",
      dependencies: [],
      proofIds: ["PF-CLI-001"],
    }],
    proofs: [{
      id: "PF-CLI-001",
      verifierCommand: "pnpm test",
      positiveOracle: "exit 0",
      negativeControl: "missing sidecar refuses",
    }],
    protectedActions: [{ kind: "live_execution", target: "fixture/repo:provider-canary" }],
    nonGoals: ["live provider call"],
    unresolvedDecisions: [],
  };
  const functionalRequirements = [
    "## Functional Requirements",
    "",
    "| ID | Statement | Acceptance |",
    "|---|---|---|",
    "| CF-CLI-001 | Generate a traceable sidecar. | Sidecar has source spans and proof IDs. |",
  ].join("\n");
  const executionContract = [
    "## Reviewed Operator Decisions",
    `Target repository path: ${target}`,
    `Frozen baseline commit: ${base}`,
    "Maximum requests: 1",
    "Maximum duration in milliseconds: 30000",
    "Maximum concurrency: 1",
    "Task owned path: src/task-1",
    "Task allowed write root: src/task-1",
    `Admitted write root: ${target}/src/task-1`,
    "Admitted write purpose: fixture projection",
    "Non-goal: live provider call",
  ].join("\n");
  const acceptanceClauseText = "The generated sidecar is traceable to the exact frozen packet.";
  const acceptanceClauseEvidence = [
    "#### Acceptance clauses",
    `- [AC-CF-CLI-001-001] ${acceptanceClauseText}`,
  ].join("\n");
  const requirementEvidence = [
    options.semanticV2
      ? "### Requirement CF-CLI-001"
      : "## Reviewed requirement: CF-CLI-001",
    "Requirement statement: Generate a traceable sidecar.",
    "Acceptance behavior: Sidecar has source spans and proof IDs.",
    ...(options.semanticV2 ? ["", acceptanceClauseEvidence] : []),
  ].join("\n");
  const proofEvidence = [
    "## Reviewed proof: PF-CLI-001",
    options.semanticV2
      ? "Proof authority: the verifier command task verify:fixture"
      : "Verifier command: pnpm test",
    "Positive oracle: exit 0",
    "Negative control: missing sidecar refuses",
  ].join("\n");
  const semanticProofEvidence = [
    "## Semantic proof custody",
    "Positive case POS-CLI-001: the admitted candidate passes",
    "Negative control NEG-CLI-001: a missing candidate fails",
    "Verifier closure task runner: Taskfile.yml",
    "Verifier closure harness: verify/fixture.mjs",
    "Candidate input: src/task-1/change.js",
  ].join("\n");
  const protectedActionEvidence = [
    "## Reviewed protected action: ACTION-CLI-001",
    "Protected action kind: live_execution",
    "Protected action target: fixture/repo:provider-canary",
  ].join("\n");
  const declarationEvidence = [
    "## CCC Fusion Packet Declarations",
    "",
    "```json",
    JSON.stringify(declarations),
    "```",
  ].join("\n");
  const source = [
    "# Dense PRD Packet", "", functionalRequirements, "", executionContract, "", requirementEvidence,
    "", proofEvidence,
    ...(options.semanticV2 ? ["", semanticProofEvidence] : []),
    "", protectedActionEvidence, "", declarationEvidence, "",
  ].join("\n");
  writeFileSync(join(root, "packet.md"), source);
  writeFileSync(join(root, "manifest.json"), JSON.stringify({ schema: "ccc-prd.packet.v1", source_version: "test", entries: [{ relative_path: "packet.md", role: "root", authoritative: true, sha256: createHash("sha256").update(source).digest("hex") }] }, null, 2));
  const functionalRequirementsSourceRef = { path: "packet.md", exactQuote: functionalRequirements };
  const executionSourceRef = { path: "packet.md", exactQuote: executionContract };
  const requirementSourceRef = { path: "packet.md", exactQuote: requirementEvidence };
  const proofSourceRef = { path: "packet.md", exactQuote: proofEvidence };
  const acceptanceClauseSourceRef = { path: "packet.md", exactQuote: acceptanceClauseText };
  const semanticProofSourceRef = { path: "packet.md", exactQuote: semanticProofEvidence };
  const protectedActionSourceRef = { path: "packet.md", exactQuote: protectedActionEvidence };
  const declarationSourceRef = { path: "packet.md", exactQuote: declarationEvidence };
  const sourceRefs = [functionalRequirementsSourceRef, executionSourceRef, requirementSourceRef];
  const proofSourceRefs = [
    executionSourceRef,
    proofSourceRef,
    ...(options.semanticV2 ? [semanticProofSourceRef] : []),
  ];
  const protectedActionSourceRefs = [executionSourceRef, protectedActionSourceRef];
  const taskSourceRefs = [
    functionalRequirementsSourceRef,
    executionSourceRef,
    requirementSourceRef,
    ...(options.semanticV2 ? [{ path: "packet.md", exactQuote: acceptanceClauseEvidence }] : []),
    proofSourceRef,
    ...(options.semanticV2 ? [semanticProofSourceRef] : []),
    protectedActionSourceRef,
    declarationSourceRef,
  ];
  const proposal = join(root, "authoring-response.fixture.json");
  writeFileSync(proposal, JSON.stringify({
    schema: options.semanticV2
      ? "ccc-prd.authoring-proposal.v2"
      : "ccc-prd.authoring-proposal.v1",
    authorityRoles: [{ id: "AUTHORITY-1", role: "root", sourcePaths: ["packet.md"], accountableProducer: "fixture" }],
    requirements: [{
      id: "CF-CLI-001",
      statement: "Generate a traceable sidecar.",
      acceptance: "Sidecar has source spans and proof IDs.",
      accountableProducer: "fixture",
      dependencies: [],
      proofIds: ["PF-CLI-001"],
      ...(options.semanticV2 ? {
        acceptanceClauses: [{
          id: "AC-CF-CLI-001-001",
          requirementId: "CF-CLI-001",
          text: acceptanceClauseText,
          proofIds: ["PF-CLI-001"],
          sourceRefs: [acceptanceClauseSourceRef],
        }],
        acceptanceDispositions: [],
      } : {}),
      sourceRefs: options.semanticV2
        ? [...sourceRefs, { path: "packet.md", exactQuote: acceptanceClauseEvidence }]
        : sourceRefs,
      confidence: "high",
    }],
    proofs: [{
      id: "PF-CLI-001",
      requirementIds: ["CF-CLI-001"],
      command: options.semanticV2 ? "task verify:fixture" : "pnpm test",
      positiveOracle: "exit 0",
      ...(options.semanticV2 ? {
        schema: "ccc-prd.proof.v2",
        clauseIds: ["AC-CF-CLI-001-001"],
        phases: ["task", "final_integrated"],
        positiveCases: [{ id: "POS-CLI-001", description: "the admitted candidate passes" }],
        negativeControls: [{ id: "NEG-CLI-001", description: "a missing candidate fails" }],
        verifierClosure: [
          { role: "task_runner", path: "Taskfile.yml", baseGitBlobOid: "0".repeat(40), sha256: "0".repeat(64) },
          { role: "harness", path: "verify/fixture.mjs", baseGitBlobOid: "0".repeat(40), sha256: "0".repeat(64) },
        ],
        candidateInputs: ["src/task-1/change.js"],
        executionToolchain: {
          task: { executablePath: "", executableSha256: "0".repeat(64), version: "", versionOutputSha256: "0".repeat(64) },
          node: { executablePath: "", executableSha256: "0".repeat(64), version: "", versionOutputSha256: "0".repeat(64) },
          proofHost: { id: "", executablePath: "", executableSha256: "0".repeat(64), version: "", versionOutputSha256: "0".repeat(64) },
          linkedRuntime: [],
        },
      } : { negativeControls: ["missing sidecar refuses"] }),
      sourceRefs: proofSourceRefs,
      confidence: "high",
    }],
    tasks: [
      { id: "TASK-CLI-001", title: "Author sidecar", description: "Generate the candidate sidecar.", accountableProducer: "fixture", requirementIds: ["CF-CLI-001"], dependencyTaskIds: [], proofIds: ["PF-CLI-001"], workflowId: "WORKFLOW-CLI-001", documentIds: ["DOCUMENT-CLI-001"], artifactIds: [], protectedActionIds: [], ownedPaths: ["src/task-1"], allowedWriteRoots: ["src/task-1"], sourceRefs: taskSourceRefs },
    ],
    edges: [],
    workflows: [{ id: "WORKFLOW-CLI-001", title: "CLI workflow", taskIds: ["TASK-CLI-001"], entryTaskIds: ["TASK-CLI-001"], terminalTaskIds: ["TASK-CLI-001"], sourceRefs }],
    documents: [{ id: "DOCUMENT-CLI-001", taskId: "TASK-CLI-001", key: "plan", title: "Plan", content: "Generate a traceable sidecar.", sourceRefs }],
    artifacts: [{ id: "ARTIFACT-CLI-001", taskId: "TASK-CLI-001", type: "proof", title: "CLI proof", mimeType: "text/plain", content: "pnpm test", sourceRefs }],
    importIntents: [
      { id: "IMPORT-CLI-001", entityType: "task", entityId: "TASK-CLI-001", operation: "create", target: "project.tasks" }, { id: "IMPORT-CLI-004", entityType: "workflow", entityId: "WORKFLOW-CLI-001", operation: "create", target: "project.workflow_work_items" }, { id: "IMPORT-CLI-010", entityType: "work_item", entityId: "WORKFLOW-CLI-001", operation: "create", target: "project.workflow_work_items" }, { id: "IMPORT-CLI-005", entityType: "document", entityId: "DOCUMENT-CLI-001", operation: "create", target: "project.task_documents" }, { id: "IMPORT-CLI-006", entityType: "artifact", entityId: "ARTIFACT-CLI-001", operation: "create", target: "project.artifacts" }, { id: "IMPORT-CLI-007", entityType: "campaign", entityId: "CAMPAIGN-CLI-001", operation: "create", target: "project.missions" }, { id: "IMPORT-CLI-008", entityType: "source", entityId: "SOURCE-CLI-001", operation: "create", target: "project.ccc_prd_import_sources" }, { id: "IMPORT-CLI-009", entityType: "run_audit", entityId: "CAMPAIGN-CLI-001", operation: "create", target: "project.run_audit_events" },
    ],
    protectedActions: [{ id: "ACTION-CLI-001", kind: "live_execution", target: "fixture/repo:provider-canary", sourceRefs: protectedActionSourceRefs }],
    bounds: { maxRequests: 1, maxDurationMs: 30_000, maxConcurrency: 1 }, admittedWriteRoots: [{ path: `${target}/src/task-1`, purpose: "fixture projection" }], targetRepository: { path: target, baseCommit: base }, nonGoals: ["live provider call"], unresolvedDecisions: [], ambiguities: [], exceptions: [], confidence: "high",
  }, null, 2));
  return {
    root,
    manifest: join(root, "manifest.json"),
    proposal,
    sidecar: join(root, "candidate.sidecar.json"),
    target,
    base,
    semanticProofToolchainPaths,
  };
}
