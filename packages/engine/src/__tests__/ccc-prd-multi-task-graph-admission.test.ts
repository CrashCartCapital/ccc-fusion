import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/*
The product route admits a multi-task graph only when it is a series-parallel
(fork-join) task graph — one entry, one terminal, every fork reconverging on a
single matching join — with disjoint ownership and unshared live-execution
authority. Linear chains are the degenerate case and stay admitted exactly as
M1 admitted them. These tests own that admission boundary: every refusal below
is a shape the runtime cannot execute safely, and every admission below is a
shape it can.

Fixture shapes mirror ccc-prd-structural.test.ts's `proposal()` /
`productProposal()` pair (same ids, custody-line style, import-intent set) so the
two files cannot drift apart on what a supported product packet looks like.
*/

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
    workflowExtensionRegistry?: WorkflowExtensionRegistry;
  }): Promise<{ kind: string; sidecar?: Record<string, unknown>; diagnostics?: unknown[] }>;
  compileCccPrdPacket(input: CompileInput): Record<string, unknown>;
  validateCccPrdPacket(input: CompileInput): Record<string, unknown>;
};

type CompileInput = {
  rootDir: string;
  manifestPath: string;
  sidecarPath: string;
  expectedTarget?: string;
  expectedBase?: string;
  requireMaterialCoverage?: boolean;
};

type MutableSidecar = {
  tasks: Array<{
    id: string;
    dependencyTaskIds: string[];
    ownedPaths?: string[];
    allowedWriteRoots?: string[];
    protectedActionIds: string[];
    requirementIds: string[];
  }>;
  edges: Array<{ id: string; fromTaskId: string; toTaskId: string; kind: string }>;
  workflows: Array<{
    id: string;
    taskIds: string[];
    entryTaskIds: string[];
    terminalTaskIds: string[];
  }>;
  importIntents: Array<{ id: string; entityType: string; entityId: string; operation: string; target: string }>;
};

const roots: string[] = [];
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const target = "/tmp/ccc-prd-multi-task-target";
const base = "a".repeat(40);

const custodyLine = (name: string) =>
  `- Task owned path: tasks/${name}; Task allowed write root: tasks/${name}`;
const requirementLine = (index: number, ordinal: string) =>
  `- \`REQ-${index}\`: ${ordinal} requirement. Acceptance: ${ordinal} proof passes. Proof: task prove:${ordinal}. Oracle: exit 0 and ${ordinal} assertion observed. Negative: mutated ${ordinal} declaration refuses.`;

const ORDINALS = ["first", "second", "third"] as const;
const OWNED = ["one", "two", "three"] as const;

const custodyLines = OWNED.map(custodyLine);
const requirementLines = ORDINALS.map((ordinal, index) => requirementLine(index + 1, ordinal));
const deletionActionLine = `- Protected action: deletion ${target}/retired delete publish`;
const liveActionLine = `- Protected action: live_execution ${target}/live-gate requires approval`;

const sourceFor = (taskCustodyLines: readonly string[], taskRequirementLines: readonly string[]) => [
  "# Small packet",
  `- Target repository: ${target}`,
  `- Baseline commit: ${base}`,
  `- Allowed write root: ${target}/tasks`,
  "- Allowed write root purpose: task projection",
  "- Max requests: 4",
  "- Max duration ms: 30000",
  "- Max concurrency: 2",
  "- Non-goal: live execution",
  ...taskCustodyLines,
  deletionActionLine,
  liveActionLine,
  ...taskRequirementLines,
].join("\n");

const productSource = sourceFor(custodyLines, requirementLines);

// Four-task material for the fan-out/join shape: same line grammar as the
// three-task packet, one more custody line and requirement each.
const FAN_ORDINALS = ["first", "second", "third", "fourth"] as const;
const FAN_OWNED = ["one", "two", "three", "four"] as const;
const fanCustodyLines = FAN_OWNED.map(custodyLine);
const fanRequirementLines = FAN_ORDINALS.map((ordinal, index) => requirementLine(index + 1, ordinal));
const fanOutSource = sourceFor(fanCustodyLines, fanRequirementLines);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function write(root: string, relativePath: string, content: string): string {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

function packet(content = productSource) {
  const root = mkdtempSync(join(tmpdir(), "ccc-prd-multi-task-"));
  roots.push(root);
  write(root, "source.md", content);
  const manifestPath = write(root, "manifest.json", JSON.stringify({
    schema: "ccc-prd.packet.v1",
    source_version: "multi-task-admission-test",
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

function productConstraints() {
  return {
    targetRepository: { path: target, baseCommit: base },
    bounds: { maxRequests: 4, maxDurationMs: 30_000, maxConcurrency: 2 },
    maxReviewItems: 8,
  };
}

/**
 * TASK-1 -> TASK-2 -> TASK-3: the maximal shape M1 admits. Ownership is
 * pairwise disjoint, the sole live-execution action belongs to exactly one
 * task, and the declared edges mirror dependencyTaskIds exactly.
 */
function threeTaskChainProposal() {
  const taskFor = (index: number) => ({
    id: `TASK-${index}`,
    title: `${ORDINALS[index - 1]} task`,
    description: `Implement ${ORDINALS[index - 1]} requirement`,
    ownedPaths: [`tasks/${OWNED[index - 1]}`],
    allowedWriteRoots: [`tasks/${OWNED[index - 1]}`],
    accountableProducer: `worker-${index}`,
    requirementIds: [`REQ-${index}`],
    dependencyTaskIds: index === 1 ? [] : [`TASK-${index - 1}`],
    proofIds: [`PROOF-${index}`],
    workflowId: "WORKFLOW-1",
    documentIds: index === 1 ? ["DOCUMENT-1"] : [],
    artifactIds: index === 3 ? ["ARTIFACT-1"] : [],
    // The single live-execution action sits on the entry task; the deletion
    // action sits on the terminal task. Nothing is shared.
    protectedActionIds: index === 1 ? ["ACTION-2"] : index === 3 ? ["ACTION-1"] : [],
    sourceRefs: [
      ...ref(requirementLines[index - 1]!),
      ...ref(custodyLines[index - 1]!),
    ],
  });

  return {
    schema: "ccc-prd.authoring-proposal.v1",
    authorityRoles: [{
      id: "authority-root",
      role: "root",
      sourcePaths: ["source.md"],
      accountableProducer: "packet-owner",
    }],
    requirements: [3, 2, 1].map((index) => ({
      id: `REQ-${index}`,
      statement: `${ORDINALS[index - 1]} requirement`,
      acceptance: `${ORDINALS[index - 1]} proof passes`,
      accountableProducer: `worker-${index}`,
      dependencies: index === 1 ? [] : [`REQ-${index - 1}`],
      proofIds: [`PROOF-${index}`],
      sourceRefs: ref(requirementLines[index - 1]!),
      confidence: "high",
    })),
    proofs: [3, 2, 1].map((index) => ({
      id: `PROOF-${index}`,
      requirementIds: [`REQ-${index}`],
      command: `task prove:${ORDINALS[index - 1]}`,
      positiveOracle: `exit 0 and ${ORDINALS[index - 1]} assertion observed`,
      negativeControls: [`mutated ${ORDINALS[index - 1]} declaration refuses`],
      sourceRefs: ref(requirementLines[index - 1]!),
      confidence: "high",
    })),
    tasks: [3, 2, 1].map(taskFor),
    edges: [
      { id: "EDGE-1", fromTaskId: "TASK-2", toTaskId: "TASK-1", kind: "depends_on" },
      { id: "EDGE-2", fromTaskId: "TASK-3", toTaskId: "TASK-2", kind: "depends_on" },
    ],
    workflows: [{
      id: "WORKFLOW-1",
      title: "Packet workflow",
      taskIds: ["TASK-1", "TASK-2", "TASK-3"],
      entryTaskIds: ["TASK-1"],
      terminalTaskIds: ["TASK-3"],
      sourceRefs: ref("Small packet"),
    }],
    documents: [{
      id: "DOCUMENT-1",
      taskId: "TASK-1",
      key: "plan",
      title: "Plan",
      content: "Implement the first requirement.",
      sourceRefs: ref(requirementLines[0]!),
    }],
    artifacts: [{
      id: "ARTIFACT-1",
      taskId: "TASK-3",
      type: "proof",
      title: "Third proof",
      mimeType: "text/plain",
      content: "task prove:third",
      sourceRefs: ref(requirementLines[2]!),
    }],
    importIntents: [
      { id: "IMPORT-TASK-1", entityType: "task", entityId: "TASK-1", operation: "create", target: "project.tasks" },
      { id: "IMPORT-TASK-2", entityType: "task", entityId: "TASK-2", operation: "create", target: "project.tasks" },
      { id: "IMPORT-TASK-3", entityType: "task", entityId: "TASK-3", operation: "create", target: "project.tasks" },
      { id: "IMPORT-EDGE-1", entityType: "dependency_edge", entityId: "EDGE-1", operation: "create", target: "project.tasks.dependencies" },
      { id: "IMPORT-EDGE-2", entityType: "dependency_edge", entityId: "EDGE-2", operation: "create", target: "project.tasks.dependencies" },
      { id: "IMPORT-WORKFLOW", entityType: "workflow", entityId: "WORKFLOW-1", operation: "create", target: "project.workflow_work_items" },
      { id: "IMPORT-WORK-ITEM", entityType: "work_item", entityId: "WORKFLOW-1", operation: "create", target: "project.workflow_work_items" },
      { id: "IMPORT-DOCUMENT", entityType: "document", entityId: "DOCUMENT-1", operation: "create", target: "project.task_documents" },
      { id: "IMPORT-ARTIFACT", entityType: "artifact", entityId: "ARTIFACT-1", operation: "create", target: "project.artifacts" },
      { id: "IMPORT-CAMPAIGN", entityType: "campaign", entityId: "CAMPAIGN-1", operation: "create", target: "project.missions" },
      { id: "IMPORT-SOURCE", entityType: "source", entityId: "SOURCE-1", operation: "create", target: "project.ccc_prd_import_sources" },
      { id: "IMPORT-AUDIT", entityType: "run_audit", entityId: "CAMPAIGN-1", operation: "create", target: "project.run_audit_events" },
    ],
    protectedActions: [
      { id: "ACTION-1", kind: "deletion", target: `${target}/retired`, sourceRefs: ref(deletionActionLine) },
      { id: "ACTION-2", kind: "live_execution", target: `${target}/live-gate`, sourceRefs: ref(liveActionLine) },
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

/**
 * TASK-1 -> {TASK-2, TASK-3} -> TASK-4: the smallest fork-join. One entry, one
 * terminal, two parallel branches that reconverge, pairwise-disjoint ownership,
 * and edges that mirror dependencyTaskIds exactly. This is the shape v0.3
 * series-parallel campaigns are made of.
 */
function fanOutJoinProposal() {
  const dependencyIdsFor = (index: number): string[] => {
    if (index === 1) return [];
    if (index === 4) return ["TASK-2", "TASK-3"];
    return ["TASK-1"];
  };
  const taskFor = (index: number) => ({
    id: `TASK-${index}`,
    title: `${FAN_ORDINALS[index - 1]} task`,
    description: `Implement ${FAN_ORDINALS[index - 1]} requirement`,
    ownedPaths: [`tasks/${FAN_OWNED[index - 1]}`],
    allowedWriteRoots: [`tasks/${FAN_OWNED[index - 1]}`],
    accountableProducer: `worker-${index}`,
    requirementIds: [`REQ-${index}`],
    dependencyTaskIds: dependencyIdsFor(index),
    proofIds: [`PROOF-${index}`],
    workflowId: "WORKFLOW-1",
    documentIds: index === 1 ? ["DOCUMENT-1"] : [],
    artifactIds: index === 4 ? ["ARTIFACT-1"] : [],
    // Live execution on the entry task, deletion on the join task; nothing
    // is shared across branches.
    protectedActionIds: index === 1 ? ["ACTION-2"] : index === 4 ? ["ACTION-1"] : [],
    sourceRefs: [
      ...ref(fanRequirementLines[index - 1]!),
      ...ref(fanCustodyLines[index - 1]!),
    ],
  });

  return {
    schema: "ccc-prd.authoring-proposal.v1",
    authorityRoles: [{
      id: "authority-root",
      role: "root",
      sourcePaths: ["source.md"],
      accountableProducer: "packet-owner",
    }],
    requirements: [4, 3, 2, 1].map((index) => ({
      id: `REQ-${index}`,
      statement: `${FAN_ORDINALS[index - 1]} requirement`,
      acceptance: `${FAN_ORDINALS[index - 1]} proof passes`,
      accountableProducer: `worker-${index}`,
      dependencies: dependencyIdsFor(index).map((id) => id.replace("TASK-", "REQ-")),
      proofIds: [`PROOF-${index}`],
      sourceRefs: ref(fanRequirementLines[index - 1]!),
      confidence: "high",
    })),
    proofs: [4, 3, 2, 1].map((index) => ({
      id: `PROOF-${index}`,
      requirementIds: [`REQ-${index}`],
      command: `task prove:${FAN_ORDINALS[index - 1]}`,
      positiveOracle: `exit 0 and ${FAN_ORDINALS[index - 1]} assertion observed`,
      negativeControls: [`mutated ${FAN_ORDINALS[index - 1]} declaration refuses`],
      sourceRefs: ref(fanRequirementLines[index - 1]!),
      confidence: "high",
    })),
    tasks: [4, 3, 2, 1].map(taskFor),
    edges: [
      { id: "EDGE-1", fromTaskId: "TASK-2", toTaskId: "TASK-1", kind: "depends_on" },
      { id: "EDGE-2", fromTaskId: "TASK-3", toTaskId: "TASK-1", kind: "depends_on" },
      { id: "EDGE-3", fromTaskId: "TASK-4", toTaskId: "TASK-2", kind: "depends_on" },
      { id: "EDGE-4", fromTaskId: "TASK-4", toTaskId: "TASK-3", kind: "depends_on" },
    ],
    workflows: [{
      id: "WORKFLOW-1",
      title: "Packet workflow",
      taskIds: ["TASK-1", "TASK-2", "TASK-3", "TASK-4"],
      entryTaskIds: ["TASK-1"],
      terminalTaskIds: ["TASK-4"],
      sourceRefs: ref("Small packet"),
    }],
    documents: [{
      id: "DOCUMENT-1",
      taskId: "TASK-1",
      key: "plan",
      title: "Plan",
      content: "Implement the first requirement.",
      sourceRefs: ref(fanRequirementLines[0]!),
    }],
    artifacts: [{
      id: "ARTIFACT-1",
      taskId: "TASK-4",
      type: "proof",
      title: "Fourth proof",
      mimeType: "text/plain",
      content: "task prove:fourth",
      sourceRefs: ref(fanRequirementLines[3]!),
    }],
    importIntents: [
      { id: "IMPORT-TASK-1", entityType: "task", entityId: "TASK-1", operation: "create", target: "project.tasks" },
      { id: "IMPORT-TASK-2", entityType: "task", entityId: "TASK-2", operation: "create", target: "project.tasks" },
      { id: "IMPORT-TASK-3", entityType: "task", entityId: "TASK-3", operation: "create", target: "project.tasks" },
      { id: "IMPORT-TASK-4", entityType: "task", entityId: "TASK-4", operation: "create", target: "project.tasks" },
      { id: "IMPORT-EDGE-1", entityType: "dependency_edge", entityId: "EDGE-1", operation: "create", target: "project.tasks.dependencies" },
      { id: "IMPORT-EDGE-2", entityType: "dependency_edge", entityId: "EDGE-2", operation: "create", target: "project.tasks.dependencies" },
      { id: "IMPORT-EDGE-3", entityType: "dependency_edge", entityId: "EDGE-3", operation: "create", target: "project.tasks.dependencies" },
      { id: "IMPORT-EDGE-4", entityType: "dependency_edge", entityId: "EDGE-4", operation: "create", target: "project.tasks.dependencies" },
      { id: "IMPORT-WORKFLOW", entityType: "workflow", entityId: "WORKFLOW-1", operation: "create", target: "project.workflow_work_items" },
      { id: "IMPORT-WORK-ITEM", entityType: "work_item", entityId: "WORKFLOW-1", operation: "create", target: "project.workflow_work_items" },
      { id: "IMPORT-DOCUMENT", entityType: "document", entityId: "DOCUMENT-1", operation: "create", target: "project.task_documents" },
      { id: "IMPORT-ARTIFACT", entityType: "artifact", entityId: "ARTIFACT-1", operation: "create", target: "project.artifacts" },
      { id: "IMPORT-CAMPAIGN", entityType: "campaign", entityId: "CAMPAIGN-1", operation: "create", target: "project.missions" },
      { id: "IMPORT-SOURCE", entityType: "source", entityId: "SOURCE-1", operation: "create", target: "project.ccc_prd_import_sources" },
      { id: "IMPORT-AUDIT", entityType: "run_audit", entityId: "CAMPAIGN-1", operation: "create", target: "project.run_audit_events" },
    ],
    protectedActions: [
      { id: "ACTION-1", kind: "deletion", target: `${target}/retired`, sourceRefs: ref(deletionActionLine) },
      { id: "ACTION-2", kind: "live_execution", target: `${target}/live-gate`, sourceRefs: ref(liveActionLine) },
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

/** TASK-1 -> TASK-2, with the third requirement dispositioned onto TASK-2. */
function twoTaskChainProposal(): ReturnType<typeof threeTaskChainProposal> {
  const candidate = structuredClone(threeTaskChainProposal());
  const terminal = candidate.tasks.find(({ id }) => id === "TASK-2")!;
  terminal.requirementIds = ["REQ-2", "REQ-3"];
  terminal.proofIds = ["PROOF-2", "PROOF-3"];
  terminal.artifactIds = ["ARTIFACT-1"];
  terminal.protectedActionIds = ["ACTION-1"];
  candidate.tasks = candidate.tasks.filter(({ id }) => id !== "TASK-3");
  candidate.edges = candidate.edges.filter(({ id }) => id === "EDGE-1");
  candidate.workflows[0]!.taskIds = ["TASK-1", "TASK-2"];
  candidate.workflows[0]!.terminalTaskIds = ["TASK-2"];
  candidate.artifacts[0]!.taskId = "TASK-2";
  candidate.importIntents = candidate.importIntents.filter(
    ({ entityId }) => entityId !== "TASK-3" && entityId !== "EDGE-2",
  );
  return candidate;
}

/** The shape the supported product path has always admitted. */
function singleTaskProposal(): ReturnType<typeof threeTaskChainProposal> {
  const candidate = structuredClone(threeTaskChainProposal());
  const only = candidate.tasks.find(({ id }) => id === "TASK-1")!;
  only.requirementIds = ["REQ-1", "REQ-2", "REQ-3"];
  only.proofIds = ["PROOF-1", "PROOF-2", "PROOF-3"];
  only.artifactIds = ["ARTIFACT-1"];
  only.protectedActionIds = ["ACTION-1", "ACTION-2"];
  candidate.tasks = [only];
  candidate.edges = [];
  candidate.workflows[0]!.taskIds = ["TASK-1"];
  candidate.workflows[0]!.terminalTaskIds = ["TASK-1"];
  candidate.artifacts[0]!.taskId = "TASK-1";
  candidate.importIntents = candidate.importIntents.filter(({ entityId, entityType }) =>
    entityType !== "dependency_edge" && entityId !== "TASK-2" && entityId !== "TASK-3");
  return candidate;
}

/**
 * Strips custody fields from an already-authored sidecar.
 *
 * Constrained authoring refuses a custody-less task outright
 * (CCC_PRD_TASK_CUSTODY_REQUIRED, authoring.ts), so the only way such a sidecar
 * reaches the compiler is by being authored unconstrained or hand-edited
 * afterwards. That is exactly the path this admission rule has to cover.
 */
function stripCustody(
  input: CompileInput,
  taskId: string,
  fields: ReadonlyArray<"ownedPaths" | "allowedWriteRoots">,
): CompileInput {
  return mutate(input, (sidecar) => {
    const task = sidecar.tasks.find(({ id }) => id === taskId)!;
    for (const field of fields) delete task[field];
  });
}

async function proofAdmissionRegistry(
  input: ReturnType<typeof packet>,
): Promise<WorkflowExtensionRegistry> {
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
  candidate: ReturnType<typeof threeTaskChainProposal>,
  content = productSource,
): Promise<CompileInput> {
  const input = packet(content);
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
  expect(result.kind, JSON.stringify(result)).toBe("candidate");
  return {
    rootDir: input.root,
    manifestPath: input.manifestPath,
    sidecarPath: write(input.root, "candidate.sidecar.json", JSON.stringify(result.sidecar)),
    expectedTarget: target,
    expectedBase: base,
    requireMaterialCoverage: true,
  };
}

function mutate(input: CompileInput, mutator: (sidecar: MutableSidecar) => void): CompileInput {
  const sidecar = JSON.parse(readFileSync(input.sidecarPath, "utf8")) as MutableSidecar;
  mutator(sidecar);
  writeFileSync(input.sidecarPath, JSON.stringify(sidecar));
  return input;
}

function diagnosticsFor(input: CompileInput): Array<{ code: string; message: string }> {
  const compiled = ccc.compileCccPrdPacket(input);
  const validated = ccc.validateCccPrdPacket(input);
  const compiledDiagnostics =
    (compiled.diagnostics as Array<{ code: string; message: string }> | undefined) ?? [];
  // Compile and validate must agree: a shape the compiler refuses can never be
  // reported valid by the same admission pass.
  expect(validated.diagnostics).toEqual(compiledDiagnostics);
  expect(compiled.kind).toBe("refusal");
  expect(validated.valid).toBe(false);
  return compiledDiagnostics;
}

describe("ccc-prd multi-task product graph admission", () => {
  describe("admits", () => {
    it("compiles the single-task shape unchanged", async () => {
      const input = await author(singleTaskProposal());
      const result = ccc.compileCccPrdPacket(input);
      expect(result.kind, JSON.stringify(result.diagnostics)).toBe("bundle");
      expect((result.tasks as Array<{ id: string }>).map(({ id }) => id)).toEqual(["TASK-1"]);
    });

    it("compiles a linear two-task chain", async () => {
      const input = await author(twoTaskChainProposal());
      const result = ccc.compileCccPrdPacket(input);
      expect(result.kind, JSON.stringify(result.diagnostics)).toBe("bundle");
      expect((result.tasks as Array<{ id: string }>).map(({ id }) => id))
        .toEqual(["TASK-1", "TASK-2"]);
    });

    it("compiles a linear three-task chain", async () => {
      const input = await author(threeTaskChainProposal());
      const result = ccc.compileCccPrdPacket(input);
      expect(result.kind, JSON.stringify(result.diagnostics)).toBe("bundle");
      expect((result.tasks as Array<{ id: string }>).map(({ id }) => id))
        .toEqual(["TASK-1", "TASK-2", "TASK-3"]);
    });

    it("is deterministic across repeated compiles of the same chain", async () => {
      const input = await author(threeTaskChainProposal());
      expect(ccc.compileCccPrdPacket(input)).toEqual(ccc.compileCccPrdPacket(input));
    });

    it("compiles a two-branch fan-out/join graph", async () => {
      const input = await author(fanOutJoinProposal(), fanOutSource);
      const result = ccc.compileCccPrdPacket(input);
      expect(result.kind, JSON.stringify(result.diagnostics)).toBe("bundle");
      expect((result.tasks as Array<{ id: string }>).map(({ id }) => id))
        .toEqual(["TASK-1", "TASK-2", "TASK-3", "TASK-4"]);
      expect((result.edges as Array<{ id: string }>).map(({ id }) => id))
        .toEqual(["EDGE-1", "EDGE-2", "EDGE-3", "EDGE-4"]);
    });

    it("is deterministic across repeated compiles of the same fan-out/join graph", async () => {
      const input = await author(fanOutJoinProposal(), fanOutSource);
      expect(ccc.compileCccPrdPacket(input)).toEqual(ccc.compileCccPrdPacket(input));
    });

    // Supersedes the former "refuses a diamond fan-out rather than a chain"
    // posture: a transitive shortcut edge (TASK-1 -> TASK-3 alongside
    // TASK-1 -> TASK-2 -> TASK-3) is a fork-join with one empty branch. The
    // importer synthesizes exactly that split/join IR and core's
    // validateParallelism admits it, so refusing it here would make admission
    // stricter than the runtime for no safety reason. Deliberate decision:
    // transitive shortcuts are admitted.
    it("admits a transitive dependency shortcut as a fork-join with an empty branch", async () => {
      const input = mutate(await author(threeTaskChainProposal()), (sidecar) => {
        sidecar.tasks.find(({ id }) => id === "TASK-3")!.dependencyTaskIds = ["TASK-2", "TASK-1"];
        sidecar.edges.push({ id: "EDGE-3", fromTaskId: "TASK-3", toTaskId: "TASK-1", kind: "depends_on" });
        sidecar.importIntents.push({
          id: "IMPORT-EDGE-3",
          entityType: "dependency_edge",
          entityId: "EDGE-3",
          operation: "create",
          target: "project.tasks.dependencies",
        });
      });
      const result = ccc.compileCccPrdPacket(input);
      expect(result.kind, JSON.stringify(result.diagnostics)).toBe("bundle");
    });

    // Per-task custody is required only once a chain has more than one task.
    // The single-task route has always admitted packets that declare none (the
    // product vertical-slice acceptance fixture is exactly that shape), and
    // core's policy generation is what fails closed there. Requiring it here
    // would change an already-admitted shape, so this pins that it does not.
    it("compiles a single task that declares no custody paths", async () => {
      const input = stripCustody(
        await author(singleTaskProposal()),
        "TASK-1",
        ["ownedPaths", "allowedWriteRoots"],
      );
      const result = ccc.compileCccPrdPacket(input);
      expect(result.kind, JSON.stringify(result.diagnostics)).toBe("bundle");
      const [task] = result.tasks as Array<Record<string, unknown>>;
      expect(task).not.toHaveProperty("ownedPaths");
      expect(task).not.toHaveProperty("allowedWriteRoots");
    });

    it("still admits two tasks that share a non-live-execution protected action", async () => {
      const input = mutate(await author(threeTaskChainProposal()), (sidecar) => {
        sidecar.tasks.find(({ id }) => id === "TASK-2")!.protectedActionIds = ["ACTION-1"];
      });
      const result = ccc.compileCccPrdPacket(input);
      expect(result.kind, JSON.stringify(result.diagnostics)).toBe("bundle");
    });
  });

  describe("refuses", () => {
    it.each([
      {
        label: "two terminal tasks",
        expected: "CCC_PRD_PRODUCT_GRAPH_UNSUPPORTED",
        names: ["TASK-2", "TASK-3"],
        mutator: (sidecar: MutableSidecar) => {
          sidecar.workflows[0]!.terminalTaskIds = ["TASK-2", "TASK-3"];
        },
      },
      {
        label: "two entry tasks",
        expected: "CCC_PRD_PRODUCT_GRAPH_UNSUPPORTED",
        names: ["TASK-1", "TASK-2"],
        mutator: (sidecar: MutableSidecar) => {
          sidecar.workflows[0]!.entryTaskIds = ["TASK-1", "TASK-2"];
        },
      },
      {
        label: "a declared task the workflow does not reference",
        expected: "CCC_PRD_PRODUCT_GRAPH_UNSUPPORTED",
        names: ["TASK-3"],
        mutator: (sidecar: MutableSidecar) => {
          sidecar.workflows[0]!.taskIds = ["TASK-1", "TASK-2"];
          sidecar.workflows[0]!.terminalTaskIds = ["TASK-2"];
        },
      },
      {
        label: "a workflow task id that is not declared",
        expected: "CCC_PRD_REFERENCE_FOREIGN",
        names: ["TASK-GHOST"],
        mutator: (sidecar: MutableSidecar) => {
          sidecar.workflows[0]!.taskIds.push("TASK-GHOST");
        },
      },
      {
        label: "a declared task that is never imported",
        expected: "CCC_PRD_PRODUCT_GRAPH_UNSUPPORTED",
        names: ["TASK-3"],
        mutator: (sidecar: MutableSidecar) => {
          sidecar.importIntents = sidecar.importIntents.filter(
            ({ entityId }) => entityId !== "TASK-3",
          );
        },
      },
      {
        label: "a dependency cycle",
        expected: "CCC_PRD_DEPENDENCY_CYCLE",
        names: [],
        mutator: (sidecar: MutableSidecar) => {
          sidecar.tasks.find(({ id }) => id === "TASK-1")!.dependencyTaskIds = ["TASK-3"];
        },
      },
      {
        // Supersedes "a diamond fan-out rather than a chain": this mutation
        // makes TASK-2 and TASK-3 both depend on TASK-1 and nothing depend on
        // them, so the fan-out never reconverges and the graph has two ends.
        // Series-parallel admission still requires exactly one terminal.
        label: "a fan-out whose branches never reconverge",
        expected: "CCC_PRD_PRODUCT_GRAPH_UNSUPPORTED",
        names: ["TASK-2", "TASK-3"],
        mutator: (sidecar: MutableSidecar) => {
          sidecar.tasks.find(({ id }) => id === "TASK-3")!.dependencyTaskIds = ["TASK-1"];
          sidecar.edges.find(({ id }) => id === "EDGE-2")!.toTaskId = "TASK-1";
        },
      },
      {
        label: "two tasks with no ordering edge at all",
        expected: "CCC_PRD_PRODUCT_GRAPH_UNSUPPORTED",
        names: [],
        mutator: (sidecar: MutableSidecar) => {
          for (const task of sidecar.tasks) task.dependencyTaskIds = [];
          sidecar.edges = [];
          sidecar.importIntents = sidecar.importIntents.filter(
            ({ entityType }) => entityType !== "dependency_edge",
          );
        },
      },
      {
        // Previously refused implicitly by the exact N-1 relation count; the
        // series-parallel rules must keep refusing it explicitly, or the
        // persisted task row would carry a duplicated dependency the runtime
        // never admitted.
        label: "a dependency declared twice by the same task",
        expected: "CCC_PRD_PRODUCT_GRAPH_UNSUPPORTED",
        names: ["TASK-2"],
        mutator: (sidecar: MutableSidecar) => {
          sidecar.tasks.find(({ id }) => id === "TASK-2")!.dependencyTaskIds = ["TASK-1", "TASK-1"];
        },
      },
      {
        // Names the relation in full: the message is built from the dependency
        // pair, so a broken pair encoding would surface here as "undefined".
        label: "declared edges that disagree with declared dependencies",
        expected: "CCC_PRD_PRODUCT_GRAPH_UNSUPPORTED",
        names: ["TASK-3 depends on TASK-2 have no declared dependency edge"],
        mutator: (sidecar: MutableSidecar) => {
          sidecar.edges = sidecar.edges.filter(({ id }) => id !== "EDGE-2");
          sidecar.importIntents = sidecar.importIntents.filter(
            ({ entityId }) => entityId !== "EDGE-2",
          );
        },
      },
      {
        label: "a dependency edge that no task declares as a dependency",
        expected: "CCC_PRD_PRODUCT_GRAPH_UNSUPPORTED",
        names: ["TASK-3 depends on TASK-1 are not declared as task dependencies"],
        mutator: (sidecar: MutableSidecar) => {
          sidecar.edges.find(({ id }) => id === "EDGE-2")!.toTaskId = "TASK-1";
        },
      },
      {
        label: "exactly equal owned paths on two tasks",
        expected: "CCC_PRD_PRODUCT_TASK_OWNERSHIP_OVERLAP",
        names: ["TASK-1", "TASK-2", "tasks/one"],
        mutator: (sidecar: MutableSidecar) => {
          sidecar.tasks.find(({ id }) => id === "TASK-2")!.ownedPaths = ["tasks/one"];
        },
      },
      {
        label: "an owned path nested inside another task's owned path",
        expected: "CCC_PRD_PRODUCT_TASK_OWNERSHIP_OVERLAP",
        names: ["TASK-1", "TASK-2", "tasks/one/nested"],
        mutator: (sidecar: MutableSidecar) => {
          sidecar.tasks.find(({ id }) => id === "TASK-2")!.ownedPaths = ["tasks/one/nested"];
        },
      },
      {
        label: "two tasks sharing one live-execution protected action",
        expected: "CCC_PRD_PRODUCT_PROTECTED_ACTION_SHARED",
        names: ["TASK-1", "TASK-2", "ACTION-2"],
        mutator: (sidecar: MutableSidecar) => {
          sidecar.tasks.find(({ id }) => id === "TASK-2")!.protectedActionIds = ["ACTION-2"];
        },
      },
      {
        label: "more than one declared workflow",
        expected: "CCC_PRD_PRODUCT_GRAPH_UNSUPPORTED",
        names: [],
        mutator: (sidecar: MutableSidecar) => {
          sidecar.workflows.push({
            ...structuredClone(sidecar.workflows[0]!),
            id: "WORKFLOW-2",
          });
        },
      },
    ])("refuses $label", async ({ expected, names, mutator }) => {
      const input = mutate(await author(threeTaskChainProposal()), mutator);
      const diagnostics = diagnosticsFor(input);
      const codes = diagnostics.map(({ code }) => code);
      expect(codes, codes.join(",")).toContain(expected);
      const named = diagnostics
        .filter(({ code }) => code === expected)
        .map(({ message }) => message)
        .join(" | ");
      for (const name of names) expect(named).toContain(name);
    });

    // A cross-link between two parallel branches (TASK-3 depending on TASK-2
    // while both sit between the same fork and join) is not series-parallel:
    // the synthesized split/join IR would fail core's validateParallelism at
    // import time. Admission must refuse it first, legibly.
    it("refuses a cross-link between parallel branches", async () => {
      const input = mutate(await author(fanOutJoinProposal(), fanOutSource), (sidecar) => {
        sidecar.tasks.find(({ id }) => id === "TASK-3")!.dependencyTaskIds = ["TASK-1", "TASK-2"];
        sidecar.edges.push({ id: "EDGE-5", fromTaskId: "TASK-3", toTaskId: "TASK-2", kind: "depends_on" });
        sidecar.importIntents.push({
          id: "IMPORT-EDGE-5",
          entityType: "dependency_edge",
          entityId: "EDGE-5",
          operation: "create",
          target: "project.tasks.dependencies",
        });
      });
      const diagnostics = diagnosticsFor(input);
      const messages = diagnostics
        .filter(({ code }) => code === "CCC_PRD_PRODUCT_GRAPH_UNSUPPORTED")
        .map(({ message }) => message)
        .join(" | ");
      expect(diagnostics.map(({ code }) => code)).toContain("CCC_PRD_PRODUCT_GRAPH_UNSUPPORTED");
      expect(messages).toContain("series-parallel");
      // Core names the fork whose branches fail to reconverge on one join.
      expect(messages).toContain("split 'split:TASK-1' branches converge on more than one join");
    });

    // Once a chain has more than one task, each runs in its own isolated
    // worktree, so every task must declare its own custody. Core refuses these
    // at product-policy generation (canonical.ts: "has no source-owned paths" /
    // "has no allowed write roots"); admitting them here would defer a certain
    // failure to a later, less legible stage.
    it.each([
      ["ownedPaths"],
      ["allowedWriteRoots"],
    ] as const)("refuses a two-task chain whose second task declares no %s", async (field) => {
      const input = stripCustody(await author(twoTaskChainProposal()), "TASK-2", [field]);
      const diagnostics = diagnosticsFor(input);
      expect(diagnostics.map(({ code }) => code)).toContain("CCC_PRD_PRODUCT_TASK_CUSTODY_MISSING");
      const message = diagnostics
        .filter(({ code }) => code === "CCC_PRD_PRODUCT_TASK_CUSTODY_MISSING")
        .map((item) => item.message)
        .join(" | ");
      expect(message).toContain("TASK-2");
      expect(message).toContain(field);
      // The task that does declare custody is not implicated.
      expect(message).not.toContain("TASK-1");
    });

    // ccc-prd-product-vertical-slice.real-pg.test.ts asserts this exact code
    // for its "multi-task workflow" mutation, and that acceptance file only
    // runs with a live PostgreSQL. Reproduce its mutation on the single-task
    // shape here so the expectation it depends on is proven without a database.
    it("refuses the acceptance fixture's clone-a-task mutation", async () => {
      // That fixture's task declares no custody, so strip it here too: the
      // shape refusal must not depend on custody being present.
      const authored = stripCustody(
        await author(singleTaskProposal()),
        "TASK-1",
        ["ownedPaths", "allowedWriteRoots"],
      );
      const input = mutate(authored, (sidecar) => {
        const secondTaskId = "TASK-1-SECOND";
        sidecar.tasks.push({ ...structuredClone(sidecar.tasks[0]!), id: secondTaskId });
        sidecar.workflows[0]!.taskIds.push(secondTaskId);
        sidecar.workflows[0]!.terminalTaskIds = [secondTaskId];
        sidecar.importIntents.push({
          id: "IMPORT-TASK-1-SECOND",
          entityType: "task",
          entityId: secondTaskId,
          operation: "create",
          target: "project.tasks",
        });
      });
      expect(diagnosticsFor(input).map(({ code }) => code))
        .toContain("CCC_PRD_PRODUCT_GRAPH_UNSUPPORTED");
    });
  });
});
