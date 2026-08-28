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
    constraints?: {
      targetRepository: { path: string; baseCommit: string };
      bounds: { maxRequests: number; maxDurationMs: number; maxConcurrency: number };
      maxReviewItems: number;
    };
    semanticProofContract?: "v1" | "v2";
    workflowExtensionRegistry?: WorkflowExtensionRegistry;
  }): Promise<{ kind: string; sidecar?: Record<string, unknown>; review?: Record<string, unknown[]> }>;
  compileCccPrdPacket(input: CompileInput): Record<string, unknown>;
  validateCccPrdPacket(input: CompileInput): Record<string, unknown>;
  validateCccPrdPacketImplementationFactProvenance(input: {
    rootDir: string;
    manifestPath: string;
    facts: Record<string, unknown>;
  }): Array<{ code: string; message: string }>;
};

type CompileInput = {
  rootDir: string;
  manifestPath: string;
  sidecarPath: string;
  expectedTarget?: string;
  expectedBase?: string;
  requireMaterialCoverage?: boolean;
};

type MutableStructuralSidecar = {
  requirements: Array<{ spans: Array<{ byteEnd: number }> }>;
  tasks: Array<{ title: string; requirementIds: string[] }>;
  unresolvedDecisions: Array<Record<string, unknown>>;
  bounds: { maxRequests: number };
  targetRepository: { path: string; baseCommit: string };
  authorityRoles: Array<{ role: string }>;
  proofs: Array<{ confidence: string }>;
  workflows: Array<{ title: string }>;
  protectedActions: Array<{ target: string }>;
  materialCoverage: Array<Record<string, unknown> & { id: string }>;
  implementationFactProvenance?: Record<string, unknown>;
  rogueProse?: string;
};

const roots: string[] = [];
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const target = "/tmp/ccc-prd-candidate-target";
const base = "a".repeat(40);
const taskOneCustodyLine =
  "- Task owned path: tasks/one; Task allowed write root: tasks/one";
const taskTwoCustodyLine =
  "- Task owned path: tasks/two; Task allowed write root: tasks/two";
const source = [
  "# Small packet",
  taskOneCustodyLine,
  taskTwoCustodyLine,
  "- `REQ-2`: second requirement",
  "- `REQ-1`: first requirement",
  "while true DEFERRED delete publish",
].join("\n");
const firstRequirementLine = "- `REQ-1`: first requirement. Acceptance: first proof passes. Proof: task prove:first. Oracle: exit 0 and first assertion observed. Negative: mutated first declaration refuses.";
const secondRequirementLine = "- `REQ-2`: second requirement. Acceptance: second proof passes. Proof: task prove:second. Oracle: exit 0 and second assertion observed. Negative: mutated second declaration refuses.";
const productSource = [
  "# Small packet",
  `- Target repository: ${target}`,
  `- Baseline commit: ${base}`,
  `- Allowed write root: ${target}/tasks`,
  "- Allowed write root purpose: task projection",
  "- Max requests: 4",
  "- Max duration ms: 30000",
  "- Max concurrency: 2",
  "- Non-goal: live execution",
  taskOneCustodyLine,
  taskTwoCustodyLine,
  `- Protected action: deletion ${target}/retired delete publish`,
  secondRequirementLine,
  firstRequirementLine,
].join("\n");
const v2RequirementOneBlock = [
  "### Requirement REQ-1",
  "Normative behavior one. Acceptance: first proof passes. Proof: task prove:first. Oracle: exit 0 and first assertion observed. Negative: mutated first declaration refuses.",
  "#### Acceptance clauses",
  "- [AC-REQ-1-001] Behavior one passes its integrated verifier.",
].join("\n");
const v2RequirementTwoBlock = [
  "### Requirement REQ-2",
  "Normative behavior two. Acceptance: second proof passes. Proof: task prove:second. Oracle: exit 0 and second assertion observed. Negative: mutated second declaration refuses.",
  "#### Acceptance clauses",
  "- [AC-REQ-2-001] Behavior two passes its integrated verifier.",
].join("\n");
const v2ProductSource = [productSource, v2RequirementOneBlock, v2RequirementTwoBlock].join("\n");

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
        ownedPaths: ["tasks/two"],
        allowedWriteRoots: ["tasks/two"],
        accountableProducer: "worker-2",
        requirementIds: ["REQ-2"],
        dependencyTaskIds: ["TASK-1"],
        proofIds: ["PROOF-2"],
        workflowId: "WORKFLOW-1",
        documentIds: [],
        artifactIds: ["ARTIFACT-1"],
        protectedActionIds: ["ACTION-1"],
        sourceRefs: [
          ...ref("second requirement"),
          ...ref(taskTwoCustodyLine),
        ],
      },
      {
        id: "TASK-1",
        title: "First task",
        description: "Implement first requirement",
        ownedPaths: ["tasks/one"],
        allowedWriteRoots: ["tasks/one"],
        accountableProducer: "worker-1",
        requirementIds: ["REQ-1"],
        dependencyTaskIds: [],
        proofIds: ["PROOF-1"],
        workflowId: "WORKFLOW-1",
        documentIds: ["DOCUMENT-1"],
        artifactIds: [],
        protectedActionIds: [],
        sourceRefs: [
          ...ref("first requirement"),
          ...ref(taskOneCustodyLine),
        ],
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

function singleTaskProductProposal(): ReturnType<typeof proposal> {
  const candidate = structuredClone(proposal());
  const task = candidate.tasks.find(({ id }) => id === "TASK-1")!;
  task.requirementIds = ["REQ-1", "REQ-2"];
  task.proofIds = ["PROOF-1", "PROOF-2"];
  task.artifactIds = ["ARTIFACT-1"];
  task.protectedActionIds = ["ACTION-1"];
  candidate.tasks = [task];
  candidate.edges = [];
  candidate.workflows[0]!.taskIds = ["TASK-1"];
  candidate.workflows[0]!.entryTaskIds = ["TASK-1"];
  candidate.workflows[0]!.terminalTaskIds = ["TASK-1"];
  candidate.artifacts[0]!.taskId = "TASK-1";
  candidate.importIntents = candidate.importIntents.filter(
    ({ entityId }) => entityId !== "TASK-2" && entityId !== "EDGE-1",
  );
  return candidate;
}

function productProposal(): ReturnType<typeof proposal> {
  const candidate = singleTaskProductProposal();
  candidate.requirements.find(({ id }) => id === "REQ-1")!.sourceRefs = ref(firstRequirementLine);
  candidate.requirements.find(({ id }) => id === "REQ-2")!.sourceRefs = ref(secondRequirementLine);
  candidate.proofs.find(({ id }) => id === "PROOF-1")!.sourceRefs = ref(firstRequirementLine);
  candidate.proofs.find(({ id }) => id === "PROOF-2")!.sourceRefs = ref(secondRequirementLine);
  candidate.tasks[0]!.sourceRefs = [
    ...ref(firstRequirementLine),
    ...ref(taskOneCustodyLine),
  ];
  candidate.workflows[0]!.sourceRefs = ref("Small packet");
  candidate.artifacts[0]!.sourceRefs = ref(firstRequirementLine);
  candidate.protectedActions[0]!.sourceRefs = ref(`Protected action: deletion ${target}/retired delete publish`);
  return candidate;
}

function v2ProductProposal() {
  const candidate = productProposal() as unknown as Record<string, unknown> & {
    schema: string;
    requirements: Array<Record<string, unknown> & { id: string }>;
    proofs: Array<Record<string, unknown> & { id: string }>;
  };
  candidate.schema = "ccc-prd.authoring-proposal.v2";
  for (const requirement of candidate.requirements) {
    const ordinal = requirement.id === "REQ-1" ? "1" : "2";
    const clauseId = `AC-REQ-${ordinal}-001`;
    const text = ordinal === "1"
      ? "Behavior one passes its integrated verifier."
      : "Behavior two passes its integrated verifier.";
    const block = ordinal === "1" ? v2RequirementOneBlock : v2RequirementTwoBlock;
    requirement.sourceRefs = ref(block);
    requirement.acceptanceClauses = [{
      id: clauseId,
      requirementId: requirement.id,
      text,
      proofIds: [`PROOF-${ordinal}`],
      sourceRefs: ref(text),
    }];
    requirement.acceptanceDispositions = [];
  }
  for (const proof of candidate.proofs) {
    const ordinal = proof.id === "PROOF-1" ? "1" : "2";
    const block = ordinal === "1" ? v2RequirementOneBlock : v2RequirementTwoBlock;
    const negativeDescription = `mutated ${ordinal === "1" ? "first" : "second"} declaration refuses`;
    proof.schema = "ccc-prd.proof.v2";
    proof.clauseIds = [`AC-REQ-${ordinal}-001`];
    proof.phases = ["task", "final_integrated"];
    proof.positiveCases = [{ id: `POS-${ordinal}`, description: `positive case ${ordinal}` }];
    proof.negativeControls = [{ id: `NEG-${ordinal}`, description: negativeDescription }];
    proof.verifierClosure = [{
      role: "task_runner",
      path: "Taskfile.yml",
      baseGitBlobOid: "b".repeat(40),
      sha256: "c".repeat(64),
    }];
    proof.candidateInputs = [`tasks/${ordinal}`];
    proof.executionToolchain = {
      task: {
        executablePath: "/usr/local/bin/task",
        executableSha256: "d".repeat(64),
        version: "3.44.0",
        versionOutputSha256: "e".repeat(64),
      },
      node: {
        executablePath: "/usr/local/bin/node",
        executableSha256: "f".repeat(64),
        version: "24.0.0",
        versionOutputSha256: "1".repeat(64),
      },
      proofHost: {
        id: "proof-host",
        executablePath: "/usr/local/bin/proof-host",
        executableSha256: "2".repeat(64),
        version: "1.0.0",
        versionOutputSha256: "3".repeat(64),
      },
      linkedRuntime: [],
    };
    proof.sourceRefs = ref(block);
  }
  return candidate;
}

function addPythonVerifierProfile(candidate: ReturnType<typeof v2ProductProposal>, proofIndex = 0) {
  const proof = candidate.proofs[proofIndex]!;
  proof.verifierProfile = {
    schema: "ccc-prd.verifier.python-adapter.v1",
    adapterPath: "verify/python_adapter.py",
    targetPath: "fixtures/python-target",
  };
  (proof.executionToolchain as Record<string, unknown>).python = {
    executablePath: "/usr/local/bin/python3",
    executableSha256: "4".repeat(64),
    version: "Python 3.12.10",
    versionOutputSha256: "5".repeat(64),
    runtimeManifest: {
      schema: "ccc-prd.python-runtime-manifest.v1",
      interpreter: { path: "/usr/local/bin/python3", sha256: "4".repeat(64) },
      stdlibRoot: "/usr/local/lib/python3.12",
      pythonHomeRoot: "/usr/local",
      sitePackagesRoots: ["/usr/local/lib/python3.12/site-packages"],
      extensionModuleRoots: ["/usr/local/lib/python3.12/lib-dynload"],
      runtimeSupport: [],
      stdlib: [{ path: "/usr/local/lib/python3.12/os.py", sha256: "6".repeat(64) }],
      sitePackages: [],
      extensionModules: [],
      dylibClosure: [],
    },
  };
  return candidate;
}

function productConstraints() {
  return {
    targetRepository: { path: target, baseCommit: base },
    bounds: { maxRequests: 4, maxDurationMs: 30_000, maxConcurrency: 2 },
    maxReviewItems: 4,
  };
}

async function proofAdmissionRegistry(input: ReturnType<typeof packet>): Promise<WorkflowExtensionRegistry> {
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
  return workflowExtensionRegistry;
}

async function author(
  input: ReturnType<typeof packet>,
  candidate = proposal(),
  constraints?: ReturnType<typeof productConstraints>,
) {
  const workflowExtensionRegistry = await proofAdmissionRegistry(input);
  let request: unknown;
  const result = await ccc.authorCccPrdPacket({
    rootDir: input.root,
    manifestPath: input.manifestPath,
    adapter: {
      id: "local-deterministic-fixture",
      model: "fixture-v1",
      generateCandidate: async (value) => {
        request = value;
        return candidate;
      },
    },
    ...(constraints ? { constraints } : {}),
    workflowExtensionRegistry,
  });
  expect(result.kind, JSON.stringify(result)).toBe("candidate");
  expect(request).toMatchObject({
    sourceVersion: "structural-test",
    sources: [{ path: "source.md", content: readFileSync(join(input.root, "source.md"), "utf8") }],
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
  it("RED-R1-python-v2-authoring-shape: admits the additive Python verifier profile for review-only v2 authoring", async () => {
    const input = packet(v2ProductSource);
    const candidate = addPythonVerifierProfile(v2ProductProposal());
    const authored = await ccc.authorCccPrdPacket({
      rootDir: input.root,
      manifestPath: input.manifestPath,
      semanticProofContract: "v2",
      adapter: {
        id: "local-v2-python-fixture",
        model: "fixture-v2",
        generateCandidate: async () => candidate,
      },
      workflowExtensionRegistry: await proofAdmissionRegistry(input),
    });

    expect(authored.kind, JSON.stringify(authored)).toBe("candidate");
    expect(authored.sidecar?.proofs).toEqual(expect.arrayContaining([expect.objectContaining({
      verifierProfile: expect.objectContaining({ schema: "ccc-prd.verifier.python-adapter.v1" }),
      executionToolchain: expect.objectContaining({
        python: expect.objectContaining({
          runtimeManifest: expect.objectContaining({ schema: "ccc-prd.python-runtime-manifest.v1" }),
        }),
      }),
    })]));
  });

  it.each([
    { label: "orphan Python toolchain", mutate: (proof: Record<string, unknown>) => { delete proof.verifierProfile; } },
    { label: "orphan verifier profile", mutate: (proof: Record<string, unknown>) => {
      delete (proof.executionToolchain as Record<string, unknown>).python;
    } },
    { label: "unknown toolchain field", mutate: (proof: Record<string, unknown>) => {
      (proof.executionToolchain as Record<string, unknown>).ambientPython = {};
    } },
    { label: "incomplete Python runtime manifest", mutate: (proof: Record<string, unknown>) => {
      const python = (proof.executionToolchain as Record<string, unknown>).python as Record<string, unknown>;
      delete (python.runtimeManifest as Record<string, unknown>).runtimeSupport;
    } },
  ])("RED-R1-python-v2-authoring-shape: refuses $label", async ({ mutate }) => {
    const input = packet(v2ProductSource);
    const candidate = addPythonVerifierProfile(v2ProductProposal());
    mutate(candidate.proofs[0]!);
    const authored = await ccc.authorCccPrdPacket({
      rootDir: input.root,
      manifestPath: input.manifestPath,
      semanticProofContract: "v2",
      adapter: {
        id: "local-v2-python-fixture",
        model: "fixture-v2",
        generateCandidate: async () => candidate,
      },
      workflowExtensionRegistry: await proofAdmissionRegistry(input),
    });

    expect(authored).toMatchObject({
      kind: "refusal",
      diagnostics: [{ code: "CCC_PRD_AUTHORING_PROPOSAL_INVALID" }],
    });
  });

  it("RED-S5-v2-proposal-toolchain-shape: refuses proof executionToolchain without linkedRuntime", async () => {
    const input = packet(v2ProductSource);
    const candidate = v2ProductProposal();
    delete (candidate.proofs[0]!.executionToolchain as Record<string, unknown>).linkedRuntime;

    const authored = await ccc.authorCccPrdPacket({
      rootDir: input.root,
      manifestPath: input.manifestPath,
      semanticProofContract: "v2",
      adapter: {
        id: "local-v2-fixture",
        model: "fixture-v2",
        generateCandidate: async () => candidate,
      },
      workflowExtensionRegistry: await proofAdmissionRegistry(input),
    });

    expect(authored).toMatchObject({
      kind: "refusal",
      diagnostics: [{ code: "CCC_PRD_AUTHORING_PROPOSAL_INVALID" }],
    });
    expect(JSON.stringify(authored)).toContain("executionToolchain");
    expect(JSON.stringify(authored)).toContain("linkedRuntime");
  });

  it("RED-S5-review-only-v2: does not stamp model-fabricated Git and toolchain identities as executable admission", async () => {
    const input = packet(v2ProductSource);
    const workflowExtensionRegistry = await proofAdmissionRegistry(input);
    const authored = await ccc.authorCccPrdPacket({
      rootDir: input.root,
      manifestPath: input.manifestPath,
      semanticProofContract: "v2",
      adapter: {
        id: "local-v2-fixture",
        model: "fixture-v2",
        generateCandidate: async () => v2ProductProposal(),
      },
      workflowExtensionRegistry,
    });
    expect(authored.kind, JSON.stringify(authored)).toBe("candidate");
    expect(authored.sidecar).toMatchObject({
      schema: "ccc-prd.sidecar.v2",
      requirements: [
        expect.objectContaining({
          id: "REQ-1",
          acceptanceClauses: [expect.objectContaining({
            id: "AC-REQ-1-001",
            text: "Behavior one passes its integrated verifier.",
            span: expect.objectContaining({ excerptSha256: expect.stringMatching(/^[0-9a-f]{64}$/) }),
          })],
        }),
        expect.objectContaining({ id: "REQ-2" }),
      ],
      proofs: expect.arrayContaining([expect.objectContaining({
        schema: "ccc-prd.proof.v2",
      })]),
    });
    expect((authored.sidecar!.proofs as Array<{ admission?: unknown }>).every(
      (proof) => !("admission" in proof),
    )).toBe(true);
    const sidecarPath = write(input.root, "candidate-v2.sidecar.json", JSON.stringify(authored.sidecar));
    expect(ccc.compileCccPrdPacket({ ...input, sidecarPath })).toMatchObject({
      kind: "refusal",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "CCC_PRD_PROOF_ADMISSION_MISSING" }),
      ]),
    });

    const drifted = structuredClone(authored.sidecar) as {
      requirements: Array<{ acceptanceClauses: Array<{ text: string }> }>;
    };
    drifted.requirements[0]!.acceptanceClauses[0]!.text = "model-owned drift";
    writeFileSync(sidecarPath, JSON.stringify(drifted));
    expect(ccc.compileCccPrdPacket({ ...input, sidecarPath })).toMatchObject({
      kind: "refusal",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "CCC_PRD_ACCEPTANCE_CLAUSE_MANIFEST_INVALID" }),
      ]),
    });
  });

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

  it("refuses constrained authoring when implementation-changing facts are not source-bound", async () => {
    const input = packet();
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
      constraints: {
        targetRepository: { path: target, baseCommit: base },
        bounds: { maxRequests: 4, maxDurationMs: 30_000, maxConcurrency: 2 },
        maxReviewItems: 4,
      },
      workflowExtensionRegistry,
    });

    expect(result).toMatchObject({
      kind: "refusal",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "CCC_PRD_TARGET_REPOSITORY_PROVENANCE_REQUIRED" }),
        expect.objectContaining({ code: "CCC_PRD_BASELINE_PROVENANCE_REQUIRED" }),
        expect.objectContaining({ code: "CCC_PRD_ALLOWED_WRITE_ROOT_PROVENANCE_REQUIRED" }),
      ]),
    });
  });

  it("persists exact-span custody for implementation facts on the supported product route", async () => {
    const input = packet(productSource);
    const authored = await author(input, productProposal(), productConstraints());
    expect(authored.sidecar.implementationFactProvenance).toMatchObject({
      schema: "ccc-prd.implementation-fact-provenance.v1",
      targetRepository: {
        path: { value: target, spans: [expect.objectContaining({ excerptSha256: digest(target) })] },
        baseCommit: { value: base, spans: [expect.objectContaining({ excerptSha256: digest(base) })] },
      },
      admittedWriteRoots: [
        expect.objectContaining({
          path: {
            value: `${target}/tasks`,
            spans: [expect.objectContaining({ excerptSha256: digest(`${target}/tasks`) })],
          },
        }),
      ],
    });

    const result = ccc.compileCccPrdPacket({
      ...input,
      sidecarPath: authored.sidecarPath,
      expectedTarget: target,
      expectedBase: base,
      requireMaterialCoverage: true,
    }) as Record<string, unknown> & { kind: string; implementationFactProvenance?: unknown };

    expect(result.kind, JSON.stringify(result)).toBe("bundle");
    expect(result.implementationFactProvenance).toEqual(authored.sidecar.implementationFactProvenance);
    expect(result.bundleHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("RED-S4-v2-provenance-order: compares implementation-fact set custody independent of canonical projection order", async () => {
    const input = packet(productSource);
    const authored = await author(input, productProposal(), productConstraints());
    const facts = structuredClone(authored.sidecar) as Record<string, unknown> & {
      implementationFactProvenance: {
        admittedWriteRoots: unknown[];
        requirements: unknown[];
        proofs: unknown[];
        protectedActions: unknown[];
      };
    };
    for (const collection of [
      "admittedWriteRoots",
      "requirements",
      "proofs",
      "protectedActions",
    ] as const) {
      facts.implementationFactProvenance[collection].reverse();
    }

    expect(ccc.validateCccPrdPacketImplementationFactProvenance({
      rootDir: input.root,
      manifestPath: input.manifestPath,
      facts,
    })).toEqual([]);
  });

  it("binds an ambiguous scalar implementation fact to its labeled declaration", async () => {
    const labeledSource = productSource
      .replace("# Small packet", "# Small packet\nversion: 1")
      .replace("- Max requests: 4", "- Max requests: 1");
    const input = packet(labeledSource);
    const candidate = productProposal();
    candidate.bounds.maxRequests = 1;
    const constraints = productConstraints();
    constraints.bounds.maxRequests = 1;

    const authored = await author(input, candidate, constraints);
    const provenance = authored.sidecar.implementationFactProvenance as {
      bounds: {
        maxRequests: {
          value: number;
          spans: Array<{ path: string; byteStart: number; byteEnd: number }>;
        };
      };
    };
    const declaration = "- Max requests: 1";
    const expectedStart = Buffer.byteLength(
      labeledSource.slice(
        0,
        labeledSource.indexOf(declaration) + "- Max requests: ".length,
      ),
      "utf8",
    );

    expect(provenance.bounds.maxRequests).toEqual({
      value: 1,
      spans: [expect.objectContaining({
        path: "source.md",
        byteStart: expectedStart,
        byteEnd: expectedStart + 1,
      })],
    });
  });

  it("refuses a fact value that appears in source but outside the entity cited span", async () => {
    const input = packet([
      productSource,
      "",
      "Elsewhere only: first proof passes",
    ].join("\n"));
    const candidate = productProposal();
    candidate.requirements.find(({ id }) => id === "REQ-1")!.acceptance = "Elsewhere only: first proof passes";

    const result = await ccc.authorCccPrdPacket({
      rootDir: input.root,
      manifestPath: input.manifestPath,
      adapter: {
        id: "local-deterministic-fixture",
        model: "fixture-v1",
        generateCandidate: async () => candidate,
      },
      constraints: productConstraints(),
      workflowExtensionRegistry: await proofAdmissionRegistry(input),
    });

    expect(result).toMatchObject({
      kind: "refusal",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "CCC_PRD_ACCEPTANCE_PROVENANCE_REQUIRED" }),
      ]),
    });
  });

  it("refuses a proof command that appears outside the proof's cited source span", async () => {
    const elsewhereCommand = "task verify:elsewhere";
    const input = packet([
      productSource,
      "",
      `Elsewhere only proof command: ${elsewhereCommand}`,
    ].join("\n"));
    const candidate = productProposal();
    candidate.proofs.find(({ id }) => id === "PROOF-1")!.command = elsewhereCommand;

    const result = await ccc.authorCccPrdPacket({
      rootDir: input.root,
      manifestPath: input.manifestPath,
      adapter: {
        id: "local-deterministic-fixture",
        model: "fixture-v1",
        generateCandidate: async () => candidate,
      },
      constraints: productConstraints(),
      workflowExtensionRegistry: await proofAdmissionRegistry(input),
    });

    expect(result).toMatchObject({
      kind: "refusal",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "CCC_PRD_PROOF_COMMAND_PROVENANCE_REQUIRED" }),
      ]),
    });
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
    ["stale material coverage"],
  ])("refuses %s deterministically", async (label) => {
    const input = packet();
    const authored = await author(input);
    const sidecar = structuredClone(authored.sidecar) as unknown as MutableStructuralSidecar;
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
    if (label === "stale material coverage") {
      sidecar.materialCoverage.push({ ...sidecar.materialCoverage[0], id: "MAT-foreign" });
    }
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
    const input = packet(productSource);
    const authored = await author(input, productProposal(), productConstraints());
    const result = ccc.compileCccPrdPacket({
      ...input,
      sidecarPath: authored.sidecarPath,
      expectedTarget: target,
      expectedBase: base,
      requireMaterialCoverage: true,
    });
    expect(result.kind).toBe("bundle");
    expect(result.protectedActions).toEqual([
      expect.objectContaining({ id: "ACTION-1", kind: "deletion", target: `${target}/retired` }),
    ]);
  });

  it("refuses protected-action drift against durable implementation fact provenance", async () => {
    const input = packet(productSource);
    const authored = await author(input, productProposal(), productConstraints());
    const sidecar = structuredClone(authored.sidecar) as unknown as MutableStructuralSidecar;
    sidecar.protectedActions[0]!.target = `${target}/elsewhere`;
    writeFileSync(authored.sidecarPath, JSON.stringify(sidecar));

    const result = ccc.compileCccPrdPacket({
      ...input,
      sidecarPath: authored.sidecarPath,
      expectedTarget: target,
      expectedBase: base,
      requireMaterialCoverage: true,
    });

    expect(result).toMatchObject({
      kind: "refusal",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "CCC_PRD_PROTECTED_ACTION_PROVENANCE_STALE" }),
      ]),
    });
  });

  it("refuses an extracted requirement that has no task disposition", async () => {
    const input = packet();
    const authored = await author(input);
    const sidecar = structuredClone(authored.sidecar) as unknown as MutableStructuralSidecar;
    sidecar.tasks[0].requirementIds = ["REQ-2"];
    writeFileSync(authored.sidecarPath, JSON.stringify(sidecar));

    const result = ccc.compileCccPrdPacket({
      ...input,
      sidecarPath: authored.sidecarPath,
      expectedTarget: target,
      expectedBase: base,
      requireMaterialCoverage: true,
    });

    expect(result).toMatchObject({
      kind: "refusal",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: "CCC_PRD_REQUIREMENT_UNDISPOSITIONED",
          message: expect.stringContaining("REQ-1"),
        }),
      ]),
    });
  });

  it("refuses a material source section and explicit source requirement omitted by extraction", async () => {
    const expandedSource = [
      source,
      "",
      "## Safety constraints",
      "- `REQ-3`: never write outside the admitted root.",
    ].join("\n");
    const input = packet(expandedSource);
    const authored = await author(input);

    const result = ccc.compileCccPrdPacket({
      ...input,
      sidecarPath: authored.sidecarPath,
      expectedTarget: target,
      expectedBase: base,
      requireMaterialCoverage: true,
    });

    expect(result).toMatchObject({
      kind: "refusal",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: "CCC_PRD_MATERIAL_SECTION_UNDISPOSITIONED",
          message: expect.stringContaining("Safety constraints"),
        }),
        expect.objectContaining({
          code: "CCC_PRD_SOURCE_REQUIREMENT_UNDISPOSITIONED",
          message: expect.stringContaining("REQ-3"),
        }),
      ]),
    });
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
