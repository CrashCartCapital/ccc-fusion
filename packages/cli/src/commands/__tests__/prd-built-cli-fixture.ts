import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../../..");
const cliEntry = join(repoRoot, "packages/cli/bin.mjs");
const roots: string[] = [];

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

export function createPacketRoot() {
  const root = mkdtempSync(join(tmpdir(), "ccc-prd-built-cli-"));
  roots.push(root);
  const target = "fixture/repo";
  const base = "a".repeat(40);
  const source = [
    "# Dense PRD Packet", "", "## Functional Requirements", "", "| ID | Statement | Acceptance |", "|---|---|---|", "| FR-1 | Generate a traceable sidecar. | Sidecar has source spans and proof IDs. |", "", "## CCC Fusion Packet Declarations", "", "```json",
    JSON.stringify({ schema: "ccc-prd.declarations.v1", authority: { source: "prd", producer: "fixture" }, bounds: { requests: 0, seconds: 30, concurrency: 1 }, admittedWriteRoots: ["."], targetRepository: target, targetBase: "abc123", requirements: [{ id: "CF-CLI-001", statement: "Generate a traceable sidecar.", acceptance: "Sidecar has source spans and proof IDs.", producer: "fixture", dependencies: [], proofIds: ["PF-CLI-001"] }], proofs: [{ id: "PF-CLI-001", verifierCommand: "pnpm test", positiveOracle: "exit 0", negativeControl: "missing sidecar refuses" }], protectedActions: [], nonGoals: ["live provider call"], unresolvedDecisions: [] }),
    "```", "",
  ].join("\n");
  writeFileSync(join(root, "packet.md"), source);
  writeFileSync(join(root, "manifest.json"), JSON.stringify({ schema: "ccc-prd.packet.v1", source_version: "test", entries: [{ relative_path: "packet.md", role: "root", authoritative: true, sha256: createHash("sha256").update(source).digest("hex") }] }, null, 2));
  const sourceRefs = [{ path: "packet.md", exactQuote: "Dense PRD Packet" }];
  const proposal = join(root, "authoring-response.fixture.json");
  writeFileSync(proposal, JSON.stringify({
    schema: "ccc-prd.authoring-proposal.v1",
    authorityRoles: [{ id: "AUTHORITY-1", role: "root", sourcePaths: ["packet.md"], accountableProducer: "fixture" }],
    requirements: [{ id: "CF-CLI-001", statement: "Generate a traceable sidecar.", acceptance: "Sidecar has source spans and proof IDs.", accountableProducer: "fixture", dependencies: [], proofIds: ["PF-CLI-001"], sourceRefs, confidence: "high" }],
    proofs: [{ id: "PF-CLI-001", requirementIds: ["CF-CLI-001"], command: "pnpm test", positiveOracle: "exit 0", negativeControls: ["missing sidecar refuses"], sourceRefs, confidence: "high" }],
    tasks: [
      { id: "TASK-CLI-001", title: "Author sidecar", description: "Generate the candidate sidecar.", accountableProducer: "fixture", requirementIds: ["CF-CLI-001"], dependencyTaskIds: [], proofIds: ["PF-CLI-001"], workflowId: "WORKFLOW-CLI-001", documentIds: ["DOCUMENT-CLI-001"], artifactIds: [], protectedActionIds: [], sourceRefs },
      { id: "TASK-CLI-002", title: "Validate sidecar", description: "Validate and compile the candidate sidecar.", accountableProducer: "fixture", requirementIds: ["CF-CLI-001"], dependencyTaskIds: ["TASK-CLI-001"], proofIds: ["PF-CLI-001"], workflowId: "WORKFLOW-CLI-001", documentIds: [], artifactIds: ["ARTIFACT-CLI-001"], protectedActionIds: ["ACTION-CLI-001"], sourceRefs },
    ],
    edges: [{ id: "EDGE-CLI-001", fromTaskId: "TASK-CLI-002", toTaskId: "TASK-CLI-001", kind: "depends_on" }],
    workflows: [{ id: "WORKFLOW-CLI-001", title: "CLI workflow", taskIds: ["TASK-CLI-001", "TASK-CLI-002"], entryTaskIds: ["TASK-CLI-001"], terminalTaskIds: ["TASK-CLI-002"], sourceRefs }],
    documents: [{ id: "DOCUMENT-CLI-001", taskId: "TASK-CLI-001", key: "plan", title: "Plan", content: "Generate a traceable sidecar.", sourceRefs }],
    artifacts: [{ id: "ARTIFACT-CLI-001", taskId: "TASK-CLI-002", type: "proof", title: "CLI proof", mimeType: "text/plain", content: "pnpm test", sourceRefs }],
    importIntents: [
      { id: "IMPORT-CLI-001", entityType: "task", entityId: "TASK-CLI-001", operation: "create", target: "project.tasks" }, { id: "IMPORT-CLI-002", entityType: "task", entityId: "TASK-CLI-002", operation: "create", target: "project.tasks" }, { id: "IMPORT-CLI-003", entityType: "dependency_edge", entityId: "EDGE-CLI-001", operation: "create", target: "project.tasks.dependencies" }, { id: "IMPORT-CLI-004", entityType: "workflow", entityId: "WORKFLOW-CLI-001", operation: "create", target: "project.workflow_work_items" }, { id: "IMPORT-CLI-005", entityType: "document", entityId: "DOCUMENT-CLI-001", operation: "create", target: "project.task_documents" }, { id: "IMPORT-CLI-006", entityType: "artifact", entityId: "ARTIFACT-CLI-001", operation: "create", target: "project.artifacts" }, { id: "IMPORT-CLI-007", entityType: "campaign", entityId: "CAMPAIGN-CLI-001", operation: "create", target: "project.missions" }, { id: "IMPORT-CLI-008", entityType: "source", entityId: "SOURCE-CLI-001", operation: "create", target: "project.ccc_prd_import_sources" }, { id: "IMPORT-CLI-009", entityType: "run_audit", entityId: "CAMPAIGN-CLI-001", operation: "create", target: "project.run_audit_events" },
    ],
    protectedActions: [{ id: "ACTION-CLI-001", kind: "live_execution", target: "fixture/repo:provider-canary", sourceRefs: [{ path: "packet.md", exactQuote: "live provider call" }] }],
    bounds: { maxRequests: 1, maxDurationMs: 30_000, maxConcurrency: 1 }, admittedWriteRoots: [{ path: ".", purpose: "fixture projection" }], targetRepository: { path: target, baseCommit: base }, nonGoals: ["live provider call"], unresolvedDecisions: [], ambiguities: [], exceptions: [], confidence: "high",
  }, null, 2));
  return { root, manifest: join(root, "manifest.json"), proposal, sidecar: join(root, "candidate.sidecar.json"), target, base };
}
