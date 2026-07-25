import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../../..");
const cliEntry = join(repoRoot, "packages/cli/bin.mjs");
const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

function runFn(args: string[], cwd = repoRoot) {
  return spawnSync(process.execPath, [cliEntry, ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    env: {
      ...process.env,
      CI: "1",
      FUSION_SKIP_ONBOARDING: "1",
    },
  });
}

function createPacketRoot() {
  const root = mkdtempSync(join(tmpdir(), "ccc-prd-built-cli-"));
  roots.push(root);
  const source = [
    "# Dense PRD Packet",
    "",
    "## Functional Requirements",
    "",
    "| ID | Statement | Acceptance |",
    "|---|---|---|",
    "| FR-1 | Generate a traceable sidecar. | Sidecar has source spans and proof IDs. |",
    "",
    "## CCC Fusion Packet Declarations",
    "",
    "```json",
    JSON.stringify({
      schema: "ccc-prd.declarations.v1",
      authority: { source: "prd", producer: "fixture" },
      bounds: { requests: 0, seconds: 30, concurrency: 1 },
      admittedWriteRoots: ["."],
      targetRepository: "fixture/repo",
      targetBase: "abc123",
      requirements: [
        {
          id: "CF-CLI-001",
          statement: "Generate a traceable sidecar.",
          acceptance: "Sidecar has source spans and proof IDs.",
          producer: "fixture",
          dependencies: [],
          proofIds: ["PF-CLI-001"],
        },
      ],
      proofs: [
        {
          id: "PF-CLI-001",
          verifierCommand: "pnpm test",
          positiveOracle: "exit 0",
          negativeControl: "missing sidecar refuses",
        },
      ],
      protectedActions: [],
      nonGoals: ["live provider call"],
      unresolvedDecisions: [],
    }),
    "```",
    "",
  ].join("\n");
  writeFileSync(join(root, "packet.md"), source);
  writeFileSync(
    join(root, "manifest.json"),
    JSON.stringify(
      {
        schema: "ccc-prd.packet.v1",
        source_version: "test",
        entries: [
          {
            relative_path: "packet.md",
            role: "root",
            authoritative: true,
            sha256: createHash("sha256").update(source).digest("hex"),
          },
        ],
      },
      null,
      2,
    ),
  );
  const sourceRefs = [{ path: "packet.md", exactQuote: "Dense PRD Packet" }];
  const proposal = join(root, "authoring-response.fixture.json");
  writeFileSync(proposal, JSON.stringify({
    schema: "ccc-prd.authoring-proposal.v1",
    authorityRoles: [{
      id: "AUTHORITY-1",
      role: "root",
      sourcePaths: ["packet.md"],
      accountableProducer: "fixture",
    }],
    requirements: [{
      id: "CF-CLI-001",
      statement: "Generate a traceable sidecar.",
      acceptance: "Sidecar has source spans and proof IDs.",
      accountableProducer: "fixture",
      dependencies: [],
      proofIds: ["PF-CLI-001"],
      sourceRefs,
      confidence: "high",
    }],
    proofs: [{
      id: "PF-CLI-001",
      requirementIds: ["CF-CLI-001"],
      command: "pnpm test",
      positiveOracle: "exit 0",
      negativeControls: ["missing sidecar refuses"],
      sourceRefs,
      confidence: "high",
    }],
    tasks: [
      {
        id: "TASK-CLI-001",
        title: "Author sidecar",
        description: "Generate the candidate sidecar.",
        accountableProducer: "fixture",
        requirementIds: ["CF-CLI-001"],
        dependencyTaskIds: [],
        proofIds: ["PF-CLI-001"],
        workflowId: "WORKFLOW-CLI-001",
        documentIds: ["DOCUMENT-CLI-001"],
        artifactIds: [],
        protectedActionIds: [],
        sourceRefs,
      },
      {
        id: "TASK-CLI-002",
        title: "Validate sidecar",
        description: "Validate and compile the candidate sidecar.",
        accountableProducer: "fixture",
        requirementIds: ["CF-CLI-001"],
        dependencyTaskIds: ["TASK-CLI-001"],
        proofIds: ["PF-CLI-001"],
        workflowId: "WORKFLOW-CLI-001",
        documentIds: [],
        artifactIds: ["ARTIFACT-CLI-001"],
        protectedActionIds: ["ACTION-CLI-001"],
        sourceRefs,
      },
    ],
    edges: [{
      id: "EDGE-CLI-001",
      fromTaskId: "TASK-CLI-002",
      toTaskId: "TASK-CLI-001",
      kind: "depends_on",
    }],
    workflows: [{
      id: "WORKFLOW-CLI-001",
      title: "CLI workflow",
      taskIds: ["TASK-CLI-001", "TASK-CLI-002"],
      entryTaskIds: ["TASK-CLI-001"],
      terminalTaskIds: ["TASK-CLI-002"],
      sourceRefs,
    }],
    documents: [{
      id: "DOCUMENT-CLI-001",
      taskId: "TASK-CLI-001",
      key: "plan",
      title: "Plan",
      content: "Generate a traceable sidecar.",
      sourceRefs,
    }],
    artifacts: [{
      id: "ARTIFACT-CLI-001",
      taskId: "TASK-CLI-002",
      type: "proof",
      title: "CLI proof",
      mimeType: "text/plain",
      content: "pnpm test",
      sourceRefs,
    }],
    importIntents: [
      { id: "IMPORT-CLI-001", entityType: "task", entityId: "TASK-CLI-001", operation: "create", target: "project.tasks" },
      { id: "IMPORT-CLI-002", entityType: "task", entityId: "TASK-CLI-002", operation: "create", target: "project.tasks" },
      { id: "IMPORT-CLI-003", entityType: "dependency_edge", entityId: "EDGE-CLI-001", operation: "create", target: "project.tasks.dependencies" },
      { id: "IMPORT-CLI-004", entityType: "workflow", entityId: "WORKFLOW-CLI-001", operation: "create", target: "project.workflow_work_items" },
      { id: "IMPORT-CLI-005", entityType: "document", entityId: "DOCUMENT-CLI-001", operation: "create", target: "project.task_documents" },
      { id: "IMPORT-CLI-006", entityType: "artifact", entityId: "ARTIFACT-CLI-001", operation: "create", target: "project.artifacts" },
    ],
    protectedActions: [{
      id: "ACTION-CLI-001",
      kind: "live_execution",
      target: "fixture/repo:provider-canary",
      sourceRefs: [{ path: "packet.md", exactQuote: "live provider call" }],
    }],
    bounds: { maxRequests: 1, maxDurationMs: 30_000, maxConcurrency: 1 },
    admittedWriteRoots: [{ path: ".", purpose: "fixture projection" }],
    targetRepository: { path: "fixture/repo", baseCommit: "a".repeat(40) },
    nonGoals: ["live provider call"],
    unresolvedDecisions: [],
    ambiguities: [],
    exceptions: [],
    confidence: "high",
  }, null, 2));
  return {
    root,
    manifest: join(root, "manifest.json"),
    proposal,
    sidecar: join(root, "candidate.sidecar.json"),
  };
}

describe("prd built CLI user contract", () => {
  it("advertises author, validate, and compile from top-level help", () => {
    const result = runFn(["--help"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("fn prd author <root-dir> <manifest-path> <proposal-path> <sidecar-output>");
    expect(result.stdout).toContain("fn prd validate <root-dir> <manifest-path> <sidecar-path>");
    expect(result.stdout).toContain("fn prd compile <root-dir> <manifest-path> <sidecar-path>");
  });

  it("author writes the requested sidecar and validate/compile are zero-store user commands", () => {
    const packet = createPacketRoot();
    const tempPrefix = join(packet.root, ".fusion-prd-tmp");

    const author = runFn(["prd", "author", packet.root, packet.manifest, packet.proposal, packet.sidecar]);
    expect(author.status, `${author.stdout}\n${author.stderr}`).toBe(0);
    expect(existsSync(packet.sidecar)).toBe(true);

    const validate = runFn(["prd", "validate", packet.root, packet.manifest, packet.sidecar]);
    expect(validate.status).toBe(0);
    const diagnostics = JSON.parse(validate.stdout) as Record<string, unknown>;
    expect(diagnostics.kind).toBe("diagnostics");
    expect(diagnostics).not.toHaveProperty("requirements");

    const compile = runFn(["prd", "compile", packet.root, packet.manifest, packet.sidecar]);
    expect(compile.status).toBe(0);
    const bundle = JSON.parse(compile.stdout) as Record<string, unknown>;
    expect(bundle.kind).toBe("bundle");
    expect(bundle).toHaveProperty("requirements");

    expect(existsSync(tempPrefix)).toBe(false);
    expect(readFileSync(join(packet.root, "packet.md"), "utf8")).toContain("Dense PRD Packet");
  });

  it("returns stable usage and semantic-refusal exit codes", () => {
    const usage = runFn(["prd", "compile"]);
    expect(usage.status, `${usage.stdout}\n${usage.stderr}`).toBe(2);

    const packet = createPacketRoot();
    const semantic = runFn(["prd", "validate", packet.root, packet.manifest, join(packet.root, "missing.sidecar.json")]);
    expect(semantic.status).toBe(1);
    expect(semantic.stdout).toContain("CCC_PRD_UNDECLARED_COMPANION");
  });

  it.each(["packet.md", "manifest.json"])(
    "refuses author output that would overwrite admitted %s bytes",
    (relativeOutput) => {
      const packet = createPacketRoot();
      const output = join(packet.root, relativeOutput);
      const before = readFileSync(output);
      const result = runFn(["prd", "author", packet.root, packet.manifest, packet.proposal, output]);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("CCC_PRD_SIDECAR_WRITE_FAILED");
      expect(readFileSync(output).equals(before)).toBe(true);
    },
  );

  it("refuses author output that would overwrite an unrelated existing file", () => {
    const packet = createPacketRoot();
    const output = join(packet.root, "operator-notes.json");
    writeFileSync(output, "{\"keep\":true}\n");
    const before = readFileSync(output);

    const result = runFn(["prd", "author", packet.root, packet.manifest, packet.proposal, output]);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("CCC_PRD_SIDECAR_WRITE_FAILED");
    expect(readFileSync(output).equals(before)).toBe(true);
  });

  it("maintains an existing valid versioned sidecar", () => {
    const packet = createPacketRoot();
    const first = runFn(["prd", "author", packet.root, packet.manifest, packet.proposal, packet.sidecar]);
    expect(first.status, `${first.stdout}\n${first.stderr}`).toBe(0);
    const firstBytes = readFileSync(packet.sidecar);

    const second = runFn(["prd", "author", packet.root, packet.manifest, packet.proposal, packet.sidecar]);

    expect(second.status, `${second.stdout}\n${second.stderr}`).toBe(0);
    expect(readFileSync(packet.sidecar).equals(firstBytes)).toBe(true);
  });
});
