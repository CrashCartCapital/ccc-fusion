import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as engine from "@fusion/engine";
import {
  WorkflowExtensionRegistry,
  deriveWorkflowExtensionHostProvenance,
} from "@fusion/core";
import {
  CCC_CAMPAIGN_PROOF_ADMISSION_CONTRIBUTION,
  CCC_CAMPAIGN_PROOF_ADMISSION_PLUGIN_ID,
} from "../ccc-campaign-proof-admission.js";

// Covers the protected-action canonical-ordering gap: packages/core/src/ccc-campaign/store.ts
// requires each task's protectedActionIds to be duplicate-free and canonically code-unit sorted
// at campaign-context resolution (fail-closed, runtime), but authoring/validation never enforced
// that upstream. This file proves authoring normalizes, and validate/compile refuse a hand-edited
// sidecar that violates the rule.

const ccc = engine as typeof engine & {
  authorCccPrdPacket(input: {
    rootDir: string;
    manifestPath: string;
    adapter: { id: string; model?: string; generateCandidate(input: unknown): Promise<unknown> };
    workflowExtensionRegistry?: WorkflowExtensionRegistry;
  }): Promise<{ kind: string; sidecar?: Record<string, unknown>; review?: Record<string, unknown[]> }>;
  compileCccPrdPacket(input: CompileInput): Record<string, unknown>;
  validateCccPrdPacket(input: CompileInput): Record<string, unknown>;
};

type CompileInput = {
  rootDir: string;
  manifestPath: string;
  sidecarPath: string;
  expectedTarget?: string;
  expectedBase?: string;
};

const roots: string[] = [];
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const target = "/tmp/ccc-prd-protected-action-canonical-target";
const base = "a".repeat(40);
const source = [
  "# Small packet",
  "- `REQ-2`: second requirement",
  "- `REQ-1`: first requirement",
  "while true DEFERRED delete publish and rotate credentials",
].join("\n");

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function write(root: string, relativePath: string, content: string): string {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

function packet() {
  const root = mkdtempSync(join(tmpdir(), "ccc-prd-protected-action-canonical-"));
  roots.push(root);
  write(root, "source.md", source);
  const manifestPath = write(root, "manifest.json", JSON.stringify({
    schema: "ccc-prd.packet.v1",
    source_version: "protected-action-canonical-test",
    entries: [{
      relative_path: "source.md",
      role: "root",
      authoritative: true,
      sha256: digest(Buffer.from(source, "utf8")),
    }],
  }));
  return { root, rootDir: root, manifestPath };
}

function ref(exactQuote: string) {
  return [{ path: "source.md", exactQuote }];
}

// TASK-2's protectedActionIds is declared UNSORTED on purpose ("ACTION-ZULU" before
// "ACTION-ALPHA"): the code-unit canonical order sorts "ACTION-ALPHA" < "ACTION-ZULU".
function proposal() {
  return {
    schema: "ccc-prd.authoring-proposal.v1",
    authorityRoles: [{
      id: "authority-root",
      role: "root",
      sourcePaths: ["source.md"],
      accountableProducer: "packet-owner",
    }],
    requirements: [
      {
        id: "REQ-2",
        statement: "second requirement",
        acceptance: "second proof passes",
        accountableProducer: "worker-2",
        dependencies: ["REQ-1"],
        proofIds: ["PROOF-2"],
        sourceRefs: ref("second requirement"),
        confidence: "high",
      },
      {
        id: "REQ-1",
        statement: "first requirement",
        acceptance: "first proof passes",
        accountableProducer: "worker-1",
        dependencies: [],
        proofIds: ["PROOF-1"],
        sourceRefs: ref("first requirement"),
        confidence: "high",
      },
    ],
    proofs: [
      {
        id: "PROOF-2",
        requirementIds: ["REQ-2"],
        command: "task prove:second",
        positiveOracle: "exit 0 and second assertion observed",
        negativeControls: ["mutated second declaration refuses"],
        sourceRefs: ref("second requirement"),
        confidence: "high",
      },
      {
        id: "PROOF-1",
        requirementIds: ["REQ-1"],
        command: "task prove:first",
        positiveOracle: "exit 0 and first assertion observed",
        negativeControls: ["mutated first declaration refuses"],
        sourceRefs: ref("first requirement"),
        confidence: "high",
      },
    ],
    tasks: [
      {
        id: "TASK-2",
        title: "Second task",
        description: "Implement second requirement",
        accountableProducer: "worker-2",
        requirementIds: ["REQ-2"],
        dependencyTaskIds: ["TASK-1"],
        proofIds: ["PROOF-2"],
        workflowId: "WORKFLOW-1",
        documentIds: [],
        artifactIds: ["ARTIFACT-1"],
        protectedActionIds: ["ACTION-ZULU", "ACTION-ALPHA"],
        sourceRefs: ref("second requirement"),
      },
      {
        id: "TASK-1",
        title: "First task",
        description: "Implement first requirement",
        accountableProducer: "worker-1",
        requirementIds: ["REQ-1"],
        dependencyTaskIds: [],
        proofIds: ["PROOF-1"],
        workflowId: "WORKFLOW-1",
        documentIds: ["DOCUMENT-1"],
        artifactIds: [],
        protectedActionIds: [],
        sourceRefs: ref("first requirement"),
      },
    ],
    edges: [{
      id: "EDGE-1",
      fromTaskId: "TASK-2",
      toTaskId: "TASK-1",
      kind: "depends_on",
    }],
    workflows: [{
      id: "WORKFLOW-1",
      title: "Packet workflow",
      taskIds: ["TASK-1", "TASK-2"],
      entryTaskIds: ["TASK-1"],
      terminalTaskIds: ["TASK-2"],
      sourceRefs: ref("Small packet"),
    }],
    documents: [{
      id: "DOCUMENT-1",
      taskId: "TASK-1",
      key: "plan",
      title: "Plan",
      content: "Implement the first requirement.",
      sourceRefs: ref("first requirement"),
    }],
    artifacts: [{
      id: "ARTIFACT-1",
      taskId: "TASK-2",
      type: "proof",
      title: "Second proof",
      mimeType: "text/plain",
      content: "task prove:second",
      sourceRefs: ref("second requirement"),
    }],
    importIntents: [
      { id: "IMPORT-1", entityType: "task", entityId: "TASK-1", operation: "create", target: "project.tasks" },
      { id: "IMPORT-2", entityType: "task", entityId: "TASK-2", operation: "create", target: "project.tasks" },
      { id: "IMPORT-3", entityType: "dependency_edge", entityId: "EDGE-1", operation: "create", target: "project.tasks.dependencies" },
      { id: "IMPORT-4", entityType: "workflow", entityId: "WORKFLOW-1", operation: "create", target: "project.workflow_work_items" },
      { id: "IMPORT-10", entityType: "work_item", entityId: "WORKFLOW-1", operation: "create", target: "project.workflow_work_items" },
      { id: "IMPORT-5", entityType: "document", entityId: "DOCUMENT-1", operation: "create", target: "project.task_documents" },
      { id: "IMPORT-6", entityType: "artifact", entityId: "ARTIFACT-1", operation: "create", target: "project.artifacts" },
      { id: "IMPORT-7", entityType: "campaign", entityId: "CAMPAIGN-1", operation: "create", target: "project.missions" },
      { id: "IMPORT-8", entityType: "source", entityId: "SOURCE-1", operation: "create", target: "project.ccc_prd_import_sources" },
      { id: "IMPORT-9", entityType: "run_audit", entityId: "CAMPAIGN-1", operation: "create", target: "project.run_audit_events" },
    ],
    protectedActions: [
      { id: "ACTION-ALPHA", kind: "deletion", target: `${target}/retired`, sourceRefs: ref("delete publish") },
      { id: "ACTION-ZULU", kind: "credential", target: `${target}/creds`, sourceRefs: ref("rotate credentials") },
    ],
    bounds: { maxRequests: 4, maxDurationMs: 30_000, maxConcurrency: 2 },
    admittedWriteRoots: [{ path: `${target}/tasks`, purpose: "task projection" }],
    targetRepository: { path: target, baseCommit: base },
    nonGoals: ["live execution"],
    unresolvedDecisions: [],
    ambiguities: [],
    exceptions: [],
    confidence: "high",
  };
}

async function author(input: ReturnType<typeof packet>) {
  const workflowExtensionRegistry = new WorkflowExtensionRegistry();
  workflowExtensionRegistry.register(
    CCC_CAMPAIGN_PROOF_ADMISSION_PLUGIN_ID,
    CCC_CAMPAIGN_PROOF_ADMISSION_CONTRIBUTION,
    await deriveWorkflowExtensionHostProvenance({
      pluginId: CCC_CAMPAIGN_PROOF_ADMISSION_PLUGIN_ID,
      pluginVersion: "1.0.0",
      trustedRootPath: input.root,
      entryRelativePath: "source.md",
      manifestRelativePath: input.manifestPath.slice(input.root.length + 1),
    }),
  );
  const result = await ccc.authorCccPrdPacket({
    rootDir: input.root,
    manifestPath: input.manifestPath,
    adapter: {
      id: "local-deterministic-fixture",
      model: "fixture-v1",
      generateCandidate: async () => proposal(),
    },
    workflowExtensionRegistry,
  });
  expect(result.kind, JSON.stringify(result)).toBe("candidate");
  const sidecarPath = write(input.root, "candidate.sidecar.json", JSON.stringify(result.sidecar));
  return { sidecar: result.sidecar!, sidecarPath };
}

function refusalCode(result: Record<string, unknown>): string | undefined {
  return (result.diagnostics as Array<{ code?: string }> | undefined)?.[0]?.code;
}

// stableDiagnostics resorts by code, not push order, so a test that hand-edits a sidecar to
// trigger two independent diagnostics (e.g. an unresolvable reference alongside a canonical-order
// violation) cannot rely on diagnostics[0]. Check membership instead.
function diagnosticCodes(result: Record<string, unknown>): string[] {
  return (result.diagnostics as Array<{ code?: string }> | undefined)?.map((entry) => entry.code ?? "") ?? [];
}

function taskById(sidecar: Record<string, unknown>, id: string): { id: string; protectedActionIds: string[] } {
  const task = (sidecar.tasks as Array<{ id: string; protectedActionIds: string[] }>).find((entry) => entry.id === id);
  if (!task) throw new Error(`fixture task not found: ${id}`);
  return task;
}

describe("ccc-prd protected-action canonical ordering", () => {
  it("authors duplicate-free, canonically sorted task protected-action IDs from an unsorted proposal", async () => {
    const input = packet();
    const authored = await author(input);
    expect(taskById(authored.sidecar, "TASK-2").protectedActionIds).toEqual([
      "ACTION-ALPHA",
      "ACTION-ZULU",
    ]);
    expect(taskById(authored.sidecar, "TASK-1").protectedActionIds).toEqual([]);
  });

  it("refuses a hand-edited sidecar whose task protected-action IDs are not canonically sorted", async () => {
    const input = packet();
    const authored = await author(input);
    const sidecar = structuredClone(authored.sidecar) as Record<string, unknown>;
    taskById(sidecar, "TASK-2").protectedActionIds = ["ACTION-ZULU", "ACTION-ALPHA"];
    writeFileSync(authored.sidecarPath, JSON.stringify(sidecar));
    const compileInput = {
      ...input,
      sidecarPath: authored.sidecarPath,
      expectedTarget: target,
      expectedBase: base,
    };
    const validation = ccc.validateCccPrdPacket(compileInput);
    expect(refusalCode(validation)).toBe("CCC_PRD_PROTECTED_ACTION_IDS_NOT_CANONICAL");
    const compiled = ccc.compileCccPrdPacket(compileInput);
    expect(refusalCode(compiled)).toBe("CCC_PRD_PROTECTED_ACTION_IDS_NOT_CANONICAL");
  });

  it("refuses a hand-edited sidecar whose task protected-action IDs contain a duplicate", async () => {
    const input = packet();
    const authored = await author(input);
    const sidecar = structuredClone(authored.sidecar) as Record<string, unknown>;
    taskById(sidecar, "TASK-2").protectedActionIds = ["ACTION-ALPHA", "ACTION-ALPHA"];
    writeFileSync(authored.sidecarPath, JSON.stringify(sidecar));
    const validation = ccc.validateCccPrdPacket({
      ...input,
      sidecarPath: authored.sidecarPath,
      expectedTarget: target,
      expectedBase: base,
    });
    expect(refusalCode(validation)).toBe("CCC_PRD_PROTECTED_ACTION_IDS_NOT_CANONICAL");
  });

  it("accepts a sidecar whose task protected-action IDs are already canonical", async () => {
    const input = packet();
    const authored = await author(input);
    const sidecar = structuredClone(authored.sidecar) as Record<string, unknown>;
    taskById(sidecar, "TASK-2").protectedActionIds = ["ACTION-ALPHA", "ACTION-ZULU"];
    writeFileSync(authored.sidecarPath, JSON.stringify(sidecar));
    const validation = ccc.validateCccPrdPacket({
      ...input,
      sidecarPath: authored.sidecarPath,
      expectedTarget: target,
      expectedBase: base,
    });
    expect(validation).toEqual({ kind: "validation", valid: true, diagnostics: [] });
  });

  // packages/core/src/ccc-campaign/store.ts:107 rejects any protected-action ID where
  // `entry !== entry.trim()`. isNonEmptyString(" a") is true, so a whitespace-padded but
  // otherwise duplicate-free, already-sorted single-entry list dodges a check that only
  // inspects set membership and order. This is that exact dodge shape.
  it("refuses a hand-edited sidecar whose task protected-action ID is not trimmed, even as an already-canonical single-entry list", async () => {
    const input = packet();
    const authored = await author(input);
    const sidecar = structuredClone(authored.sidecar) as Record<string, unknown>;
    taskById(sidecar, "TASK-2").protectedActionIds = [" ACTION-ALPHA"];
    writeFileSync(authored.sidecarPath, JSON.stringify(sidecar));
    const compileInput = {
      ...input,
      sidecarPath: authored.sidecarPath,
      expectedTarget: target,
      expectedBase: base,
    };
    const validation = ccc.validateCccPrdPacket(compileInput);
    expect(diagnosticCodes(validation)).toContain("CCC_PRD_PROTECTED_ACTION_IDS_NOT_CANONICAL");
    const compiled = ccc.compileCccPrdPacket(compileInput);
    expect(diagnosticCodes(compiled)).toContain("CCC_PRD_PROTECTED_ACTION_IDS_NOT_CANONICAL");
  });

  it("refuses authoring a proposal whose task protected-action ID is not trimmed, even as an already-canonical single-entry list", async () => {
    const input = packet();
    const paddedProposal = proposal();
    const task2 = paddedProposal.tasks.find((task) => task.id === "TASK-2")!;
    task2.protectedActionIds = [" ACTION-ALPHA"];
    const result = await ccc.authorCccPrdPacket({
      rootDir: input.root,
      manifestPath: input.manifestPath,
      adapter: {
        id: "local-deterministic-fixture",
        model: "fixture-v1",
        generateCandidate: async () => paddedProposal,
      },
    });
    expect(result.kind).toBe("refusal");
    expect(refusalCode(result as unknown as Record<string, unknown>)).toBe("CCC_PRD_AUTHORING_PROPOSAL_INVALID");
  });
});
