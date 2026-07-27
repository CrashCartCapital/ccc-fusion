import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
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

const ccc = engine as typeof engine & {
  authorCccPrdPacket(input: {
    rootDir: string;
    manifestPath: string;
    adapter: { id: string; model?: string; generateCandidate(input: unknown): Promise<unknown> };
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
const target = "/tmp/ccc-prd-candidate-target";
const base = "a".repeat(40);
const source = [
  "# Small packet",
  "- `REQ-2`: second requirement",
  "- `REQ-1`: first requirement",
  "while true DEFERRED delete publish",
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

function packet(content = source, manifestRelativePath = "manifest.json") {
  const root = mkdtempSync(join(tmpdir(), "ccc-prd-structural-"));
  roots.push(root);
  write(root, "source.md", content);
  const manifestPath = write(root, manifestRelativePath, JSON.stringify({
    schema: "ccc-prd.packet.v1",
    source_version: "structural-test",
    entries: [{
      relative_path: "source.md",
      role: "root",
      authoritative: true,
      sha256: digest(Buffer.from(content, "utf8")),
    }],
  }));
  return { root, rootDir: root, manifestPath };
}

function ref(exactQuote: string) {
  return [{ path: "source.md", exactQuote }];
}

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
        protectedActionIds: ["ACTION-1"],
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
      { id: "IMPORT-5", entityType: "document", entityId: "DOCUMENT-1", operation: "create", target: "project.task_documents" },
      { id: "IMPORT-6", entityType: "artifact", entityId: "ARTIFACT-1", operation: "create", target: "project.artifacts" },
      { id: "IMPORT-7", entityType: "campaign", entityId: "CAMPAIGN-1", operation: "create", target: "project.missions" },
      { id: "IMPORT-8", entityType: "source", entityId: "SOURCE-1", operation: "create", target: "project.ccc_prd_import_sources" },
      { id: "IMPORT-9", entityType: "run_audit", entityId: "CAMPAIGN-1", operation: "create", target: "project.run_audit_events" },
    ],
    protectedActions: [{
      id: "ACTION-1",
      kind: "deletion",
      target: `${target}/retired`,
      sourceRefs: ref("delete publish"),
    }],
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
  let request: unknown;
  const result = await ccc.authorCccPrdPacket({
    rootDir: input.root,
    manifestPath: input.manifestPath,
    adapter: {
      id: "local-deterministic-fixture",
      model: "fixture-v1",
      generateCandidate: async (value) => {
        request = value;
        return proposal();
      },
    },
    workflowExtensionRegistry,
  });
  expect(result.kind, JSON.stringify(result)).toBe("candidate");
  expect(request).toMatchObject({
    sourceVersion: "structural-test",
    sources: [{ path: "source.md", content: source }],
  });
  expect(result.review).toMatchObject({
    ambiguities: [],
    unresolvedDecisions: [],
    exceptions: [],
    protectedActions: [{ id: "ACTION-1", target: `${target}/retired` }],
  });
  const sidecarPath = write(input.root, "candidate.sidecar.json", JSON.stringify(result.sidecar));
  return { sidecar: result.sidecar!, sidecarPath };
}

function refusalCode(result: Record<string, unknown>): string | undefined {
  return (result.diagnostics as Array<{ code?: string }> | undefined)?.[0]?.code;
}

describe("ccc-prd structural sidecar", () => {
  it("authors raw-byte custody and compiles the complete structural graph in code-unit order", async () => {
    const input = packet();
    const authored = await author(input);
    expect(readFileSync(join(input.root, "source.md"), "utf8")).toBe(source);
    const compiled = ccc.compileCccPrdPacket({
      ...input,
      sidecarPath: authored.sidecarPath,
      expectedTarget: target,
      expectedBase: base,
    }) as Record<string, unknown> & {
      kind: string;
      requirements: Array<{ id: string; spans: Array<{ byteStart: number; byteEnd: number }> }>;
    };
    expect(compiled.kind, JSON.stringify(compiled)).toBe("bundle");
    expect(compiled.requirements.map((item) => item.id)).toEqual(["REQ-1", "REQ-2"]);
    expect((compiled.proofs as Array<{ admission?: unknown }>)[0]?.admission).toEqual(
      (authored.sidecar.proofs as Array<{ admission?: unknown }>)[0]?.admission,
    );
    expect(compiled.requirements[0].spans[0]).toMatchObject({
      byteStart: Buffer.byteLength(source.slice(0, source.indexOf("first requirement")), "utf8"),
      byteEnd: Buffer.byteLength(source.slice(0, source.indexOf("first requirement") + "first requirement".length), "utf8"),
    });
    for (const collection of [
      "requirements",
      "proofs",
      "tasks",
      "edges",
      "workflows",
      "documents",
      "artifacts",
      "importIntents",
      "protectedActions",
    ]) {
      expect(compiled[collection], collection).toBeInstanceOf(Array);
      expect((compiled[collection] as unknown[]).length, collection).toBeGreaterThan(0);
    }
  });

  it.each([
    ["raw byte mutation"],
    ["stale span"],
    ["duplicate id"],
    ["unresolved decision"],
    ["unbounded limit"],
    ["foreign target"],
    ["foreign base"],
    ["unknown top-level declaration"],
    ["blank task title"],
    ["invalid authority role"],
    ["invalid proof confidence"],
    ["blank workflow title"],
  ])("refuses %s deterministically", async (label) => {
    const input = packet();
    const authored = await author(input);
    const sidecar = structuredClone(authored.sidecar) as Record<string, any>;
    if (label === "raw byte mutation") write(input.root, "source.md", `${source}\nchanged byte`);
    if (label === "stale span") sidecar.requirements[0].spans[0].byteEnd += 1;
    if (label === "duplicate id") sidecar.tasks.push({ ...sidecar.tasks[0] });
    if (label === "unresolved decision") {
      sidecar.unresolvedDecisions.push({
        id: "DECISION-1",
        question: "Choose one",
        state: "unresolved",
        spans: sidecar.requirements[0].spans,
      });
    }
    if (label === "unbounded limit") sidecar.bounds.maxRequests = 0;
    if (label === "foreign target") sidecar.targetRepository.path = "/tmp/foreign";
    if (label === "foreign base") sidecar.targetRepository.baseCommit = "b".repeat(40);
    if (label === "unknown top-level declaration") sidecar.rogueProse = "manual field";
    if (label === "blank task title") sidecar.tasks[0].title = "";
    if (label === "invalid authority role") sidecar.authorityRoles[0].role = "self_asserted";
    if (label === "invalid proof confidence") sidecar.proofs[0].confidence = "certain";
    if (label === "blank workflow title") sidecar.workflows[0].title = "";
    writeFileSync(authored.sidecarPath, JSON.stringify(sidecar));
    const compileInput = {
      ...input,
      sidecarPath: authored.sidecarPath,
      expectedTarget: target,
      expectedBase: base,
    };
    const first = ccc.compileCccPrdPacket(compileInput);
    const second = ccc.compileCccPrdPacket(compileInput);
    expect(refusalCode(first)).toMatch(/^CCC_PRD_/);
    expect(second).toEqual(first);
  });

  it("refuses manifest, sidecar, and symlinked-ancestor escapes before reads", async () => {
    const input = packet();
    const authored = await author(input);
    const outside = mkdtempSync(join(tmpdir(), "ccc-prd-structural-outside-"));
    roots.push(outside);
    const outsideManifest = write(outside, "manifest.json", readFileSync(input.manifestPath, "utf8"));
    const protectedManifest = write(input.root, "_secrets/manifest.json", readFileSync(input.manifestPath, "utf8"));
    const outsideSidecar = write(outside, "sidecar.json", JSON.stringify(authored.sidecar));
    const linked = join(input.root, "linked");
    symlinkSync(outside, linked, "dir");

    for (const candidate of [
      { manifestPath: outsideManifest, sidecarPath: authored.sidecarPath },
      { manifestPath: protectedManifest, sidecarPath: authored.sidecarPath },
      { manifestPath: input.manifestPath, sidecarPath: outsideSidecar },
      { manifestPath: input.manifestPath, sidecarPath: join(linked, "sidecar.json") },
    ]) {
      const result = ccc.compileCccPrdPacket({
        rootDir: input.root,
        ...candidate,
        expectedTarget: target,
        expectedBase: base,
      });
      expect(refusalCode(result)).toMatch(/^CCC_PRD_(PATH_ESCAPE|PROTECTED_PATH)$/);
    }
  });

  it("does not infer actions, deferred state, or loops from prose", async () => {
    const input = packet();
    const authored = await author(input);
    const result = ccc.compileCccPrdPacket({
      ...input,
      sidecarPath: authored.sidecarPath,
      expectedTarget: target,
      expectedBase: base,
    });
    expect(result.kind).toBe("bundle");
    expect(result.protectedActions).toEqual([
      expect.objectContaining({ id: "ACTION-1", kind: "deletion", target: `${target}/retired` }),
    ]);
  });

  it("validates with diagnostics only and never returns a bundle", async () => {
    const input = packet();
    const authored = await author(input);
    const result = ccc.validateCccPrdPacket({
      ...input,
      sidecarPath: authored.sidecarPath,
      expectedTarget: target,
      expectedBase: base,
    });
    expect(result).toEqual({ kind: "validation", valid: true, diagnostics: [] });
    expect(result.requirements).toBeUndefined();
    expect(result.tasks).toBeUndefined();
  });
});
