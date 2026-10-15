import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CccPlanningRefusal,
  WorkflowExtensionRegistry,
  canonicalCccPrdJson,
  deriveWorkflowExtensionHostProvenance,
  encodeCccPlanningArtifactKey,
  type CccPlanningArtifactEnvelopeV1,
  type CccPlanningArtifactKind,
  type CccPlanningRefusalCode,
  type CccPlanningRequirementMapV1,
  type CccPlanningRoleId,
  type CccPlanningStageId,
  type CccPlanningTaskPlanV1,
  type CccPlanningVerifierBundleV1,
  type CccPrdAuthoringAdapter,
  type CccPrdAuthoringProposalV2,
  type CccPrdSidecarV2,
} from "@fusion/core";
import { CCC_CAMPAIGN_PROOF_ADMISSION_CONTRIBUTION, CCC_CAMPAIGN_PROOF_ADMISSION_PLUGIN_ID } from "../ccc-campaign-proof-admission.js";
import { parseCccPrdAcceptanceClauseInventory } from "../ccc-prd/acceptance-clauses.js";
import { authorCccPrdPacket } from "../ccc-prd/authoring.js";
import { compileCccPrdPacket } from "../ccc-prd/compiler.js";
import { readCccPrdPacketCustody } from "../ccc-prd/custody.js";
import { analyzeCccPrdMaterialCoverage } from "../ccc-prd/material-coverage.js";
import {
  CCC_PLANNING_PACKET_SOURCES,
  materializeCccPlanningPacket,
  renderCccPlanningAdmissionFacts,
  renderCccPlanningFinalPrd,
  renderCccPlanningTechnicalAnnex,
  type CccPlanningAdmissionFacts,
  type CccPlanningPacketSources,
} from "../ccc-planning/packet.js";
import {
  assertCccPlanningAuthorshipReceiptMatches,
  buildCccPlanningAuthoringProposal,
  buildCccPlanningAuthorshipReceipt,
  computeCccPlanningProposalHash,
  createCccPlanningAuthoringAdapter,
} from "../ccc-planning/proposal.js";

/*
FNXC:CccPlanningProposal 2026-10-14-19:05:
Card IB1 (request-to-code v3, CONTRACT-v3.3 section 2.17, ADR B Q2, test T2.5): the four packet sources, the truthful authorship proposal and its adapter. These tests own three contract claims. (1) The authoring adapter id matches `^ccc-planning\.full-v2:` and its model label is the sorted, plus-joined set of `resolvedModel` values read from the producer envelopes, so flipping one envelope to M3 changes the label while the unflipped envelopes keep `glm/glm-5.3`; a hard-coded label would pass the id assertion but not the flip. (2) A proposal hash that differs from the authorship receipt is refused. (3) The proposal the converter builds is accepted by the real `authorCccPrdPacket` path: every quote resolves exactly once, clause and proof coverage reconcile, and implementation facts bind. The section 4.1 diamond (tokenizer, then word frequency and reading time, then the CLI) is the fixture; the packet is review-only, so no Task, Node or git toolchain is touched.
*/

const RUN_ID = "ccc-plan:0123456789abcdef01234567";
const TARGET = "/tmp/ccc-planning-ib1-target";
const BASE_COMMIT = "1".repeat(40);
const GLM = "glm/glm-5.3";
const M3 = "minimax/MiniMax-M3";
const PATHS = Object.fromEntries(
  Object.entries(CCC_PLANNING_PACKET_SOURCES).map(([key, value]) => [key, `sources/${value.projectRelativePath}`]),
) as Record<keyof typeof CCC_PLANNING_PACKET_SOURCES, string>;

type DeepMutable<T> = T extends readonly (infer U)[] ? DeepMutable<U>[]
  : T extends object ? { -readonly [K in keyof T]: DeepMutable<T[K]> }
  : T;

function edit<T>(value: T, mutate: (draft: DeepMutable<T>) => void): T {
  const copy = structuredClone(value) as DeepMutable<T>;
  mutate(copy);
  return copy as T;
}

const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

/* ------------------------------------------------------------------ fixture: the section 4.1 diamond */

const REQUEST = [
  "Build a small text-stats tool in Node with no dependencies.",
  "It needs a tokenizer that splits text into words.",
  "It needs a word frequency counter.",
  "It needs a reading time estimate.",
  "It needs a command line that prints JSON and exits 2 on error.",
  "Tests run with node --test.",
  "",
].join("\n");

const REQUEST_QUOTE = {
  base: "Build a small text-stats tool in Node with no dependencies.",
  tokenizer: "It needs a tokenizer that splits text into words.",
  frequency: "It needs a word frequency counter.",
  reading: "It needs a reading time estimate.",
  cli: "It needs a command line that prints JSON and exits 2 on error.",
} as const;

const REQUIREMENT_MAP: CccPlanningRequirementMapV1 = {
  schema: "ccc-planning.requirement-map.v1",
  requirements: [
    {
      id: "REQ-TOKENIZER", title: "Tokenizer", statement: "The tokenizer splits text into lowercase words.",
      proofIds: ["tokenizer"],
      clauses: [{
        id: "001", text: "Tokenizing 'Hello, World' yields the words hello and world.",
        derivation: { kind: "request", requestQuotes: [REQUEST_QUOTE.tokenizer], acceptanceCaseIds: ["case-tokenizer"] },
      }],
    },
    {
      id: "REQ-FREQUENCY", title: "Word frequency", statement: "The counter reports how often each word occurs.",
      proofIds: ["frequency"],
      clauses: [{
        id: "AC-REQ-FREQUENCY-001", text: "Counting 'a b a' reports a twice and b once.",
        derivation: { kind: "request", requestQuotes: [REQUEST_QUOTE.frequency], acceptanceCaseIds: ["case-frequency"] },
      }],
    },
    {
      id: "REQ-READING", title: "Reading time", statement: "The estimator rounds minutes up from a words-per-minute rate.",
      proofIds: ["reading-time"],
      clauses: [{
        id: "001", text: "Four hundred words at two hundred words per minute take two minutes.",
        derivation: { kind: "request", requestQuotes: [REQUEST_QUOTE.reading], acceptanceCaseIds: ["case-reading"] },
      }],
    },
    {
      id: "REQ-CLI", title: "Command line", statement: "The command line prints one JSON document for a text file.",
      proofIds: ["cli"],
      clauses: [
        {
          id: "001", text: "Running the tool on a text file prints one JSON object on standard output.",
          derivation: { kind: "request", requestQuotes: [REQUEST_QUOTE.cli], acceptanceCaseIds: ["case-cli"] },
        },
        {
          id: "002", text: "Running the tool on a missing file exits with code 2.",
          derivation: { kind: "annex", decisionIds: ["DEC-T4"] },
        },
      ],
    },
  ],
  nonGoals: [{
    id: "NG-1", text: "No runtime dependencies and no package.json change.",
    requestQuotes: [REQUEST_QUOTE.base], exclusionIds: ["excl-dependencies"],
  }],
};

const TASK_ROWS = [
  { id: "T1", title: "Tokenizer", requirementId: "REQ-TOKENIZER", proofId: "tokenizer", path: "src/tokenizer.mjs", deps: [] },
  { id: "T2", title: "Word frequency", requirementId: "REQ-FREQUENCY", proofId: "frequency", path: "src/frequency.mjs", deps: ["T1"] },
  { id: "T3", title: "Reading time", requirementId: "REQ-READING", proofId: "reading-time", path: "src/reading-time.mjs", deps: ["T1"] },
  { id: "T4", title: "Command line", requirementId: "REQ-CLI", proofId: "cli", path: "bin/text-stats.mjs", deps: ["T2", "T3"] },
] as const;

const TASK_PLAN: CccPlanningTaskPlanV1 = {
  schema: "ccc-planning.task-plan.v1",
  tasks: TASK_ROWS.map((row) => ({
    id: row.id, title: row.title, description: `Implement ${row.title.toLowerCase()} in ${row.path} only.`,
    requirementIds: [row.requirementId], dependencyTaskIds: [...row.deps], proofIds: [row.proofId],
    ownedPaths: [row.path], allowedWriteRoots: [row.path], protectedActionIds: [`ACT-${row.id}-LIVE`],
  })),
  edges: TASK_ROWS.flatMap((row) => row.deps.map((dep) => ({
    id: `E-${row.id}-${dep}`, fromTaskId: row.id, toTaskId: dep, kind: "depends_on" as const,
  }))),
  protectedActions: TASK_ROWS.map((row) => ({
    id: `ACT-${row.id}-LIVE`, kind: "live_execution" as const, target: `provider://glm/glm-5.3-flash/${row.id}`,
  })),
};

const TASKFILE = [
  "version: '3'", "tasks:",
  ...TASK_ROWS.flatMap((row) => [`  verify:${row.proofId}:`, "    cmds:", `      - node test/${row.proofId}.test.mjs ${row.path}`]),
  "",
].join("\n");

const VERIFIER_BUNDLE: CccPlanningVerifierBundleV1 = {
  schema: "ccc-planning.verifier-bundle.v1",
  files: [
    { path: "Taskfile.yml", mode: "100644", content: TASKFILE },
    ...TASK_ROWS.map((row) => ({
      path: `test/${row.proofId}.test.mjs`, mode: "100644" as const, content: `// verifies ${row.path}\n`,
    })),
  ],
  proofs: TASK_ROWS.map((row) => ({
    id: row.proofId, requirementIds: [row.requirementId],
    files: ["Taskfile.yml", `test/${row.proofId}.test.mjs`], taskfileTask: `verify:${row.proofId}` as const,
  })),
  controls: [
    { id: "ctl-tokenizer", requirementId: "REQ-TOKENIZER", files: [{ path: "src/tokenizer.mjs", content: "export const tokenize = () => [];\n" }] },
    { id: "ctl-cli", requirementId: "REQ-CLI", files: [{ path: "bin/text-stats.mjs", content: "process.exit(0);\n" }] },
  ],
};

const FACTS: CccPlanningAdmissionFacts = {
  targetRepository: { path: TARGET, baseCommit: BASE_COMMIT },
  admittedWriteRoots: [
    { path: `${TARGET}/.fusion`, purpose: "Fusion-managed campaign state and artifacts" },
    { path: `${TARGET}/src`, purpose: "text-stats implementation" },
    { path: `${TARGET}/bin`, purpose: "text-stats implementation" },
  ],
  bounds: { maxRequests: 64, maxDurationMs: 3_600_000, maxConcurrency: 2 },
  protectedActions: [{ id: "FACT-MERGE", kind: "merge", target: "refs/heads/main" }],
};

type Fixture = Readonly<{
  requirementMap: CccPlanningRequirementMapV1;
  taskPlan: CccPlanningTaskPlanV1;
  verifierBundle: CccPlanningVerifierBundleV1;
  facts: CccPlanningAdmissionFacts;
  request: string;
}>;

const BASE_FIXTURE: Fixture = {
  requirementMap: REQUIREMENT_MAP, taskPlan: TASK_PLAN, verifierBundle: VERIFIER_BUNDLE, facts: FACTS, request: REQUEST,
};

function sourcesFor(fixture: Fixture): CccPlanningPacketSources {
  return {
    originalRequest: Buffer.from(fixture.request, "utf8"),
    admissionFacts: renderCccPlanningAdmissionFacts(fixture.facts),
    finalPrd: renderCccPlanningFinalPrd({ requirementMap: fixture.requirementMap, verifierBundle: fixture.verifierBundle }),
    technicalAnnex: renderCccPlanningTechnicalAnnex({ taskPlan: fixture.taskPlan }),
  };
}

function buildProposal(fixture: Fixture = BASE_FIXTURE, sources: CccPlanningPacketSources = sourcesFor(fixture)): CccPrdAuthoringProposalV2 {
  return buildCccPlanningAuthoringProposal({
    sources, requirementMap: fixture.requirementMap, taskPlan: fixture.taskPlan,
    verifierBundle: fixture.verifierBundle, facts: fixture.facts,
  });
}

/* ------------------------------------------------------------------ fixture: producer envelopes */

type ProducerRow = Readonly<{ kind: CccPlanningArtifactKind; stageId: CccPlanningStageId; roleId: CccPlanningRoleId; slot: string }>;

const PRODUCER_ROWS: readonly ProducerRow[] = [
  { kind: "requirement_map", stageId: "spec", roleId: "spec-author", slot: "reqmap" },
  { kind: "final_prd", stageId: "spec", roleId: "spec-author", slot: "prd" },
  { kind: "technical_annex", stageId: "spec", roleId: "spec-author", slot: "annex" },
  { kind: "task_plan", stageId: "plan", roleId: "execution-planner", slot: "plan" },
  { kind: "verifier_bundle", stageId: "verifier", roleId: "verifier-author", slot: "bundle" },
];

function envelope(row: ProducerRow, overrides: Partial<{ resolvedModel: string | undefined; runId: string; runRevision: number }> = {}): CccPlanningArtifactEnvelopeV1 {
  const runRevision = overrides.runRevision ?? 1;
  const resolvedModel = "resolvedModel" in overrides ? overrides.resolvedModel : GLM;
  return {
    schema: "ccc-planning.artifact-envelope.v1",
    artifactKey: encodeCccPlanningArtifactKey({ runRevision, stageId: row.stageId, slot: row.slot, version: 1 }),
    runId: overrides.runId ?? RUN_ID, runRevision, stageId: row.stageId, slot: row.slot, version: 1, kind: row.kind,
    contentType: "application/json", contentSchema: `test.${row.kind}.v1`, inputs: [],
    producer: {
      kind: "model", roleId: row.roleId, instanceId: `instance-${row.slot}`, requestedModel: GLM,
      ...(resolvedModel === undefined ? {} : { resolvedModel }), routeReceiptDigest: sha256(`route-${row.slot}`),
    },
    policy: { promptVersion: "v1", promptDigest: sha256("prompt"), toolPolicyVersion: "v1", toolPolicyDigest: sha256("tools") },
    outputDigest: sha256(`output-${row.slot}`), status: "complete", fence: { kind: "admission" },
    identityDigest: sha256(`identity-${row.slot}`), publishedAt: "2026-10-14T12:00:00.000Z",
  } as CccPlanningArtifactEnvelopeV1;
}

function producers(overridesByKind: Partial<Record<CccPlanningArtifactKind, Partial<{ resolvedModel: string | undefined; runId: string; runRevision: number }>>> = {}): CccPlanningArtifactEnvelopeV1[] {
  return PRODUCER_ROWS.map((row) => envelope(row, overridesByKind[row.kind] ?? {}));
}

function adapterFor(proposal: CccPrdAuthoringProposalV2, envelopes: readonly CccPlanningArtifactEnvelopeV1[] = producers()): CccPrdAuthoringAdapter {
  return createCccPlanningAuthoringAdapter({ proposal, producers: envelopes, runId: RUN_ID, runRevision: 1 });
}

function refusalCode(action: () => unknown): CccPlanningRefusalCode | "no refusal" {
  try {
    action();
  } catch (error) {
    if (error instanceof CccPlanningRefusal) return error.code;
    throw error;
  }
  return "no refusal";
}

/* ------------------------------------------------------------------ scratch and the real authoring path */

const scratchRoots: string[] = [];

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "ccc-planning-ib1-"));
  scratchRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of scratchRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function lines(buffer: Buffer): string[] {
  return buffer.toString("utf8").split("\n");
}

async function registryFor(root: string): Promise<WorkflowExtensionRegistry> {
  const registry = new WorkflowExtensionRegistry();
  registry.register(
    CCC_CAMPAIGN_PROOF_ADMISSION_PLUGIN_ID,
    CCC_CAMPAIGN_PROOF_ADMISSION_CONTRIBUTION,
    await deriveWorkflowExtensionHostProvenance({
      pluginId: CCC_CAMPAIGN_PROOF_ADMISSION_PLUGIN_ID, pluginVersion: "1.0.0", trustedRootPath: root,
      entryRelativePath: PATHS.originalRequest, manifestRelativePath: "manifest.json",
    }),
  );
  return registry;
}

async function authorThrough(adapter: CccPrdAuthoringAdapter, sources: CccPlanningPacketSources) {
  const scratchRoot = scratch();
  const packet = await materializeCccPlanningPacket({ scratchRoot, runId: RUN_ID, runRevision: 1, sources });
  const result = await authorCccPrdPacket({
    rootDir: packet.rootDir, manifestPath: packet.manifestPath, adapter, semanticProofContract: "v2",
    constraints: { targetRepository: FACTS.targetRepository, bounds: FACTS.bounds, maxReviewItems: 16 },
    workflowExtensionRegistry: await registryFor(packet.rootDir),
  });
  return { packet, result };
}

/** The diagnostic codes the real compiler raises for a sidecar written next to the packet (none when it compiles). */
function compileCodes(packet: Readonly<{ rootDir: string; manifestPath: string }>, sidecar: unknown, name: string): string[] {
  const sidecarPath = join(packet.rootDir, `${name}.json`);
  writeFileSync(sidecarPath, `${canonicalCccPrdJson(sidecar)}\n`);
  const compiled = compileCccPrdPacket({
    rootDir: packet.rootDir, manifestPath: packet.manifestPath, sidecarPath,
    expectedTarget: FACTS.targetRepository.path, expectedBase: FACTS.targetRepository.baseCommit, requireMaterialCoverage: true,
  });
  return compiled.kind === "refusal" ? compiled.diagnostics.map(({ code }) => code) : [];
}

/* ================================================================== packet sources */

describe("ccc planning packet sources", () => {
  it("renders the admission facts with the labels the implementation-fact binder reads", () => {
    const text = lines(renderCccPlanningAdmissionFacts(FACTS));
    for (const expected of [
      `- Target repository: ${TARGET}`,
      `- Baseline commit: ${BASE_COMMIT}`,
      "- Max requests: 64",
      "- Max duration ms: 3600000",
      "- Max concurrency: 2",
      `- Allowed write root: ${TARGET}/.fusion`,
      `- Allowed write root: ${TARGET}/src`,
      "- Allowed write root purpose: Fusion-managed campaign state and artifacts",
      "- Allowed write root purpose: text-stats implementation",
    ]) expect(text, expected).toContain(expected);
    const changed = lines(renderCccPlanningAdmissionFacts(edit(FACTS, (draft) => { draft.bounds.maxRequests = 65; })));
    expect(changed).toContain("- Max requests: 65");
    expect(changed).not.toContain("- Max requests: 64");
  });

  it("renders the final PRD in the acceptance grammar and keeps the target path, baseline and bounds out of it", () => {
    const prd = renderCccPlanningFinalPrd({ requirementMap: REQUIREMENT_MAP, verifierBundle: VERIFIER_BUNDLE });
    const inventory = parseCccPrdAcceptanceClauseInventory({ sourcePath: PATHS.finalPrd, sourceBytes: prd });
    expect(inventory.clauses.map(({ id, requirementId }) => `${requirementId}:${id}`)).toEqual([
      "REQ-TOKENIZER:AC-REQ-TOKENIZER-001",
      "REQ-FREQUENCY:AC-REQ-FREQUENCY-001",
      "REQ-READING:AC-REQ-READING-001",
      "REQ-CLI:AC-REQ-CLI-001",
      "REQ-CLI:AC-REQ-CLI-002",
    ]);
    expect(inventory.clauses.map(({ text }) => text)).toEqual(
      REQUIREMENT_MAP.requirements.flatMap((requirement) => requirement.clauses.map((clause) => clause.text)),
    );
    expect(inventory.dispositions).toEqual([]);
    const facts = renderCccPlanningAdmissionFacts(FACTS).toString("utf8");
    const text = prd.toString("utf8");
    for (const fact of [TARGET, BASE_COMMIT, "3600000"]) {
      expect(facts, `the facts carry ${fact}`).toContain(fact);
      expect(text, `the PRD must not carry ${fact}`).not.toContain(fact);
    }
  });

  it("renders one proof block per verifier proof and one non-goal line per map non-goal", () => {
    const text = lines(renderCccPlanningFinalPrd({ requirementMap: REQUIREMENT_MAP, verifierBundle: VERIFIER_BUNDLE }));
    for (const row of TASK_ROWS) {
      expect(text.filter((line) => line.startsWith(`- Proof ${row.proofId} command: `))).toEqual([
        `- Proof ${row.proofId} command: task verify:${row.proofId}`,
      ]);
      expect(text.filter((line) => line.startsWith(`- Proof ${row.proofId} positive oracle: `))).toHaveLength(1);
    }
    const controlLines = text.filter((line) => line.startsWith("- Proof tokenizer negative control "));
    expect(controlLines.some((line) => line.startsWith("- Proof tokenizer negative control ctl-tokenizer: "))).toBe(true);
    // a proof whose requirement has no defective control still gets one negative control: the verifier must fail on the baseline
    const reading = text.filter((line) => line.startsWith("- Proof reading-time negative control "));
    expect(reading).toHaveLength(1);
    expect(text).toContain("- Non-goal: No runtime dependencies and no package.json change.");
  });

  it("renders the technical annex with a decision id and the custody lines of every task", () => {
    const text = lines(renderCccPlanningTechnicalAnnex({ taskPlan: TASK_PLAN }));
    for (const row of TASK_ROWS) {
      expect(text.filter((line) => line.startsWith(`- [DEC-${row.id}] `))).toHaveLength(1);
      expect(text).toContain(`- Task ${row.id} owned path: \`${row.path}\``);
      expect(text).toContain(`- Task ${row.id} write root: \`${row.path}\``);
      expect(text).toContain(`## Task ${row.id}`);
    }
    expect(text).toContain("- Protected action ACT-T1-LIVE: live_execution provider://glm/glm-5.3-flash/T1");
  });

  it("renders identical bytes twice and different bytes when one input changes", () => {
    const first = sourcesFor(BASE_FIXTURE);
    const second = sourcesFor(BASE_FIXTURE);
    for (const key of ["admissionFacts", "finalPrd", "technicalAnnex"] as const) {
      expect(first[key].byteLength, `${key} must not be empty`).toBeGreaterThan(0);
      expect(first[key].equals(second[key])).toBe(true);
    }
    const clauseChanged = renderCccPlanningFinalPrd({
      requirementMap: edit(REQUIREMENT_MAP, (draft) => { draft.requirements[0]!.clauses[0]!.text = "Tokenizing 'A B' yields a and b."; }),
      verifierBundle: VERIFIER_BUNDLE,
    });
    expect(clauseChanged.equals(first.finalPrd)).toBe(false);
    const pathChanged = renderCccPlanningTechnicalAnnex({
      taskPlan: edit(TASK_PLAN, (draft) => { draft.tasks[0]!.ownedPaths = ["src/tokens.mjs"]; draft.tasks[0]!.allowedWriteRoots = ["src/tokens.mjs"]; }),
    });
    expect(pathChanged.equals(first.technicalAnnex)).toBe(false);
  });

  it("refuses admission facts the binder could not read back, each next to the passing twin", () => {
    const render = (change: (draft: DeepMutable<CccPlanningAdmissionFacts>) => void) => () => renderCccPlanningAdmissionFacts(edit(FACTS, change));
    expect(refusalCode(render(() => undefined))).toBe("no refusal");
    expect(refusalCode(render((draft) => { draft.targetRepository.baseCommit = "main"; }))).toBe("CCC_PLANNING_GRAPH_INADMISSIBLE");
    expect(refusalCode(render((draft) => { draft.bounds.maxRequests = 0; }))).toBe("CCC_PLANNING_GRAPH_INADMISSIBLE");
    expect(refusalCode(render((draft) => { draft.admittedWriteRoots[0]!.purpose = "two\nlines"; }))).toBe("CCC_PLANNING_GRAPH_INADMISSIBLE");
    expect(refusalCode(render((draft) => { draft.admittedWriteRoots[1]!.path = draft.admittedWriteRoots[0]!.path; }))).toBe("CCC_PLANNING_GRAPH_INADMISSIBLE");
    expect(refusalCode(render((draft) => { draft.protectedActions[0]!.kind = "format_disk" as never; }))).toBe("CCC_PLANNING_GRAPH_INADMISSIBLE");
  });

  it("refuses a requirement id the acceptance grammar cannot carry; the twin with a canonical id renders", () => {
    const render = (id: string) => () => renderCccPlanningFinalPrd({
      requirementMap: edit(REQUIREMENT_MAP, (draft) => { draft.requirements[0]!.id = id; }),
      verifierBundle: edit(VERIFIER_BUNDLE, (draft) => { draft.proofs[0]!.requirementIds = [id]; }),
    });
    expect(refusalCode(render("REQ-TOKENIZER"))).toBe("no refusal");
    expect(refusalCode(render("REQ TOKENIZER"))).toBe("CCC_PLANNING_GRAPH_INADMISSIBLE");
    expect(refusalCode(render("AC-TOKENIZER"))).toBe("CCC_PLANNING_GRAPH_INADMISSIBLE");
  });

  it("writes the four sources as a packet that custody reads back with their paths, roles and hashes", async () => {
    const sources = sourcesFor(BASE_FIXTURE);
    const packet = await materializeCccPlanningPacket({ scratchRoot: scratch(), runId: RUN_ID, runRevision: 1, sources });
    const custody = readCccPrdPacketCustody({ rootDir: packet.rootDir, manifestPath: packet.manifestPath });
    expect(custody.packetHash).toBe(packet.packetHash);
    expect(packet.packetHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(custody.entries.map(({ relativePath, role, authoritative }) => ({ relativePath, role, authoritative }))).toEqual([
      { relativePath: PATHS.admissionFacts, role: "support", authoritative: true },
      { relativePath: PATHS.finalPrd, role: "prd", authoritative: true },
      { relativePath: PATHS.originalRequest, role: "original_request", authoritative: true },
      { relativePath: PATHS.technicalAnnex, role: "technical_annex", authoritative: true },
    ]);
    for (const key of ["originalRequest", "admissionFacts", "finalPrd", "technicalAnnex"] as const) {
      expect(custody.sourceBytes.get(PATHS[key])!.equals(sources[key]), `${key} bytes survive the packet unchanged`).toBe(true);
    }
  });

  it("refuses to write the same run revision twice and accepts the next revision", async () => {
    const scratchRoot = scratch();
    const sources = sourcesFor(BASE_FIXTURE);
    const first = await materializeCccPlanningPacket({ scratchRoot, runId: RUN_ID, runRevision: 1, sources });
    await expect(materializeCccPlanningPacket({ scratchRoot, runId: RUN_ID, runRevision: 1, sources })).rejects.toMatchObject({
      code: "CCC_PRD_INTAKE_OUTPUT_EXISTS",
    });
    expect(readFileSync(join(first.rootDir, "sources", CCC_PLANNING_PACKET_SOURCES.originalRequest.projectRelativePath)).equals(sources.originalRequest)).toBe(true);
    const next = await materializeCccPlanningPacket({ scratchRoot, runId: RUN_ID, runRevision: 2, sources });
    expect(next.rootDir).not.toBe(first.rootDir);
    expect(next.packetHash).not.toBe(first.packetHash);
  });
});

/* ================================================================== truthful authorship (T2.5) */

describe("ccc planning truthful authorship", () => {
  it("names the adapter after the full-v2 profile, the run and the revision", () => {
    const adapter = adapterFor(buildProposal());
    expect(adapter.id).toMatch(/^ccc-planning\.full-v2:/u);
    expect(adapter.id).toBe(`ccc-planning.full-v2:${RUN_ID}:r1`);
    const second = createCccPlanningAuthoringAdapter({
      proposal: buildProposal(), producers: producers({ requirement_map: { runRevision: 2 }, final_prd: { runRevision: 2 }, technical_annex: { runRevision: 2 }, task_plan: { runRevision: 2 }, verifier_bundle: { runRevision: 2 } }),
      runId: RUN_ID, runRevision: 2,
    });
    expect(second.id).toBe(`ccc-planning.full-v2:${RUN_ID}:r2`);
  });

  it("labels the model from the producer envelopes: unflipped envelopes give glm/glm-5.3", () => {
    expect(adapterFor(buildProposal()).model).toBe(GLM);
  });

  it("changes the model label to glm/glm-5.3+minimax/MiniMax-M3 when one envelope resolved model is flipped to M3, and leaves the id alone", () => {
    const proposal = buildProposal();
    const unflipped = adapterFor(proposal);
    const flipped = adapterFor(proposal, producers({ verifier_bundle: { resolvedModel: M3 } }));
    expect(flipped.model).toBe("glm/glm-5.3+minimax/MiniMax-M3");
    expect(flipped.model).not.toBe(unflipped.model);
    expect(flipped.id).toBe(unflipped.id);
    expect(flipped.id).toMatch(/^ccc-planning\.full-v2:/u);
  });

  it("labels the sorted unique set of resolved models whatever the order or the repeats", () => {
    const proposal = buildProposal();
    const mixed = producers({ technical_annex: { resolvedModel: M3 }, task_plan: { resolvedModel: M3 } });
    expect(adapterFor(proposal, mixed).model).toBe("glm/glm-5.3+minimax/MiniMax-M3");
    expect(adapterFor(proposal, [...mixed].reverse()).model).toBe("glm/glm-5.3+minimax/MiniMax-M3");
    const allM3 = producers(Object.fromEntries(PRODUCER_ROWS.map((row) => [row.kind, { resolvedModel: M3 }])));
    expect(adapterFor(proposal, allM3).model).toBe(M3);
  });

  it("refuses producers that cannot support a truthful label, each next to a passing twin", () => {
    const proposal = buildProposal();
    const create = (envelopes: readonly CccPlanningArtifactEnvelopeV1[], runId = RUN_ID, runRevision = 1) => () =>
      createCccPlanningAuthoringAdapter({ proposal, producers: envelopes, runId, runRevision });
    expect(refusalCode(create(producers()))).toBe("no refusal");
    expect(refusalCode(create(producers({ task_plan: { resolvedModel: undefined } })))).toBe("CCC_PLANNING_ARTIFACT_ENVELOPE_INVALID");
    expect(refusalCode(create(producers({ task_plan: { resolvedModel: "" } })))).toBe("CCC_PLANNING_ARTIFACT_ENVELOPE_INVALID");
    expect(refusalCode(create(producers().filter(({ kind }) => kind !== "verifier_bundle")))).toBe("CCC_PLANNING_ARTIFACT_ENVELOPE_INVALID");
    expect(refusalCode(create([]))).toBe("CCC_PLANNING_ARTIFACT_ENVELOPE_INVALID");
    expect(refusalCode(create(producers({ final_prd: { runId: "ccc-plan:ffffffffffffffffffffffff" } })))).toBe("CCC_PLANNING_ARTIFACT_RUN_MISMATCH");
    expect(refusalCode(create(producers({ final_prd: { runRevision: 2 } })))).toBe("CCC_PLANNING_ARTIFACT_RUN_MISMATCH");
    expect(refusalCode(create(producers(), "not-a-run-id"))).toBe("CCC_PLANNING_ARTIFACT_ENVELOPE_INVALID");
    expect(refusalCode(create(producers(), RUN_ID, 0))).toBe("CCC_PLANNING_ARTIFACT_ENVELOPE_INVALID");
    const controllerPrd: CccPlanningArtifactEnvelopeV1 = edit(envelope(PRODUCER_ROWS[1]!), (draft) => { draft.producer.kind = "controller"; draft.producer.roleId = "controller"; delete draft.producer.resolvedModel; delete draft.producer.requestedModel; });
    expect(refusalCode(create([...producers().filter(({ kind }) => kind !== "final_prd"), controllerPrd]))).toBe("CCC_PLANNING_ARTIFACT_ENVELOPE_INVALID");
  });

  it("builds a receipt with the proposal hash and one role row per producer in role order", () => {
    const proposal = buildProposal();
    const envelopes = producers({ verifier_bundle: { resolvedModel: M3 } });
    const receipt = buildCccPlanningAuthorshipReceipt({ proposal, producers: [...envelopes].reverse(), runId: RUN_ID, runRevision: 1 });
    expect(receipt.proposalHash).toBe(sha256(canonicalCccPrdJson(proposal)));
    expect(receipt.proposalHash).toBe(computeCccPlanningProposalHash(proposal));
    expect(receipt.roles.map(({ roleId, artifactKey }) => `${roleId}:${artifactKey}`)).toEqual(
      envelopes.map((item) => `${item.producer.roleId}:${item.artifactKey}`).sort(),
    );
    const verifier = receipt.roles.find(({ roleId }) => roleId === "verifier-author");
    expect(verifier).toEqual({
      roleId: "verifier-author",
      artifactKey: envelopes.find(({ kind }) => kind === "verifier_bundle")!.artifactKey,
      outputDigest: sha256("output-bundle"), requestedModel: GLM, resolvedModel: M3, instanceId: "instance-bundle",
    });
  });

  it("refuses a proposal hash that differs from the authorship receipt, and accepts the matching one", async () => {
    const sources = sourcesFor(BASE_FIXTURE);
    const proposal = buildProposal(BASE_FIXTURE, sources);
    const adapter = adapterFor(proposal);
    const receipt = buildCccPlanningAuthorshipReceipt({ proposal, producers: producers(), runId: RUN_ID, runRevision: 1 });
    const { result } = await authorThrough(adapter, sources);
    expect(result.kind, JSON.stringify(result)).toBe("candidate");
    const provenance = (result as { sidecar: CccPrdSidecarV2 }).sidecar.provenance;
    // positive control: the sidecar authored from this very proposal matches its receipt
    expect(provenance.proposalHash).toBe(receipt.proposalHash);
    expect(refusalCode(() => assertCccPlanningAuthorshipReceiptMatches({ receipt, provenance, runId: RUN_ID, runRevision: 1 }))).toBe("no refusal");
    // a one-byte change to the proposal after the receipt was published is refused
    const tampered = edit(proposal, (draft) => { draft.nonGoals[0] = `${draft.nonGoals[0]!}!`; });
    const tamperedReceipt = buildCccPlanningAuthorshipReceipt({ proposal: tampered, producers: producers(), runId: RUN_ID, runRevision: 1 });
    expect(tamperedReceipt.proposalHash).not.toBe(receipt.proposalHash);
    expect(refusalCode(() => assertCccPlanningAuthorshipReceiptMatches({ receipt: tamperedReceipt, provenance, runId: RUN_ID, runRevision: 1 }))).toBe("CCC_PLANNING_REVIEWED_BYTES_DRIFT");
    expect(refusalCode(() => assertCccPlanningAuthorshipReceiptMatches({
      receipt, provenance: { ...provenance, proposalHash: "0".repeat(64) }, runId: RUN_ID, runRevision: 1,
    }))).toBe("CCC_PLANNING_REVIEWED_BYTES_DRIFT");
  });

  it("refuses sidecar labels the receipt roles do not derive, next to a passing twin", async () => {
    const sources = sourcesFor(BASE_FIXTURE);
    const proposal = buildProposal(BASE_FIXTURE, sources);
    const receipt = buildCccPlanningAuthorshipReceipt({ proposal, producers: producers({ verifier_bundle: { resolvedModel: M3 } }), runId: RUN_ID, runRevision: 1 });
    const adapter = adapterFor(proposal, producers({ verifier_bundle: { resolvedModel: M3 } }));
    const { result } = await authorThrough(adapter, sources);
    const provenance = (result as { sidecar: CccPrdSidecarV2 }).sidecar.provenance;
    expect(provenance.authoringModel).toBe("glm/glm-5.3+minimax/MiniMax-M3");
    const check = (next: typeof provenance, revision = 1) => () =>
      assertCccPlanningAuthorshipReceiptMatches({ receipt, provenance: next, runId: RUN_ID, runRevision: revision });
    expect(refusalCode(check(provenance))).toBe("no refusal");
    expect(refusalCode(check({ ...provenance, authoringModel: GLM }))).toBe("CCC_PLANNING_RECEIPT_ENVELOPE_MISMATCH");
    expect(refusalCode(check({ ...provenance, authoringAdapterId: "local-deterministic-fixture" }))).toBe("CCC_PLANNING_RECEIPT_ENVELOPE_MISMATCH");
    expect(refusalCode(check(provenance, 2))).toBe("CCC_PLANNING_RECEIPT_ENVELOPE_MISMATCH");
  });
});

/* ================================================================== the proposal against the real authoring path */

describe("ccc planning authoring proposal", () => {
  it("is accepted by authorCccPrdPacket and the sidecar carries the derived provenance", async () => {
    const sources = sourcesFor(BASE_FIXTURE);
    const proposal = buildProposal(BASE_FIXTURE, sources);
    const adapter = adapterFor(proposal);
    const { packet, result } = await authorThrough(adapter, sources);
    expect(result.kind, JSON.stringify(result)).toBe("candidate");
    const sidecar = (result as { sidecar: CccPrdSidecarV2 }).sidecar;
    expect(sidecar.schema).toBe("ccc-prd.sidecar.v2");
    expect(sidecar.provenance).toEqual({
      authoringAdapterId: `ccc-planning.full-v2:${RUN_ID}:r1`, authoringModel: GLM,
      proposalHash: computeCccPlanningProposalHash(proposal), packetHash: packet.packetHash,
    });
    expect(sidecar.requirements.map(({ id }) => id)).toEqual(["REQ-CLI", "REQ-FREQUENCY", "REQ-READING", "REQ-TOKENIZER"]);
    expect(sidecar.requirements.flatMap((requirement) => requirement.acceptanceClauses.map(({ id }) => id))).toEqual([
      "AC-REQ-CLI-001", "AC-REQ-CLI-002", "AC-REQ-FREQUENCY-001", "AC-REQ-READING-001", "AC-REQ-TOKENIZER-001",
    ]);
    expect(sidecar.tasks.map(({ id }) => id)).toEqual(["T1", "T2", "T3", "T4"]);
    expect(sidecar.edges.map(({ id }) => id).sort()).toEqual(["E-T2-T1", "E-T3-T1", "E-T4-T2", "E-T4-T3"]);
    expect(sidecar.workflows).toHaveLength(1);
    expect(sidecar.workflows[0]).toMatchObject({ entryTaskIds: ["T1"], terminalTaskIds: ["T4"] });
    expect(sidecar.targetRepository).toEqual(FACTS.targetRepository);
    expect(sidecar.bounds).toEqual(FACTS.bounds);
    expect(sidecar.admittedWriteRoots).toEqual(FACTS.admittedWriteRoots);
    expect(sidecar.nonGoals).toEqual(["No runtime dependencies and no package.json change."]);
    expect(sidecar.implementationFactProvenance).toBeDefined();
    expect(sidecar.documents).toEqual([]);
    expect(sidecar.artifacts).toEqual([]);
    expect([sidecar.unresolvedDecisions, sidecar.ambiguities, sidecar.exceptions]).toEqual([[], [], []]);
    expect(sidecar.importIntents.map(({ entityType }) => entityType).sort()).toEqual([
      "campaign", "dependency_edge", "dependency_edge", "dependency_edge", "dependency_edge", "run_audit", "source",
      "task", "task", "task", "task", "work_item", "workflow",
    ]);
    // the review-only authoring path leaves the model placeholders unadmitted; controller custody is a later step
    expect(sidecar.proofs.every((proof) => proof.admission === undefined)).toBe(true);
  });

  it("attributes each requirement by source path: request-derived clauses cite the request, annex-derived clauses cite the annex", async () => {
    const sources = sourcesFor(BASE_FIXTURE);
    const proposal = buildProposal(BASE_FIXTURE, sources);
    const { result } = await authorThrough(adapterFor(proposal), sources);
    const sidecar = (result as { sidecar: CccPrdSidecarV2 }).sidecar;
    const pathsOf = (id: string) => [...new Set(sidecar.requirements.find((requirement) => requirement.id === id)!.spans.map(({ path }) => path))].sort();
    expect(pathsOf("REQ-TOKENIZER")).toEqual([PATHS.finalPrd, PATHS.originalRequest]);
    expect(pathsOf("REQ-CLI")).toEqual([PATHS.technicalAnnex, PATHS.finalPrd, PATHS.originalRequest].sort());
    const request = sources.originalRequest;
    const requestSpan = sidecar.requirements.find(({ id }) => id === "REQ-TOKENIZER")!.spans.find(({ path }) => path === PATHS.originalRequest)!;
    expect(request.subarray(requestSpan.byteStart, requestSpan.byteEnd).toString("utf8")).toBe(REQUEST_QUOTE.tokenizer);
  });

  it("gives every task its own custody paths in its annex evidence and nothing outside the packet", async () => {
    const sources = sourcesFor(BASE_FIXTURE);
    const proposal = buildProposal(BASE_FIXTURE, sources);
    const { result } = await authorThrough(adapterFor(proposal), sources);
    const sidecar = (result as { sidecar: CccPrdSidecarV2 }).sidecar;
    const annex = sources.technicalAnnex;
    for (const row of TASK_ROWS) {
      const task = sidecar.tasks.find(({ id }) => id === row.id)!;
      expect(task.ownedPaths).toEqual([row.path]);
      expect(task.allowedWriteRoots).toEqual([row.path]);
      expect(task.dependencyTaskIds).toEqual([...row.deps]);
      expect(task.proofIds).toEqual([row.proofId]);
      const evidence = task.spans.filter(({ path }) => path === PATHS.technicalAnnex).map(({ byteStart, byteEnd }) => annex.subarray(byteStart, byteEnd).toString("utf8"));
      expect(evidence, `task ${row.id} cites its owned path line`).toContain(`- Task ${row.id} owned path: \`${row.path}\``);
      expect(evidence, `task ${row.id} cites its write root line`).toContain(`- Task ${row.id} write root: \`${row.path}\``);
      expect(task.spans.every(({ path }) => Object.values(PATHS).includes(path))).toBe(true);
    }
  });

  it("gives each proof the verifier closure from the bundle, the task and final phases, and controller placeholders", () => {
    const proposal = buildProposal();
    const tokenizer = proposal.proofs.find(({ id }) => id === "tokenizer")!;
    expect(tokenizer).toMatchObject({
      schema: "ccc-prd.proof.v2", requirementIds: ["REQ-TOKENIZER"], clauseIds: ["AC-REQ-TOKENIZER-001"],
      phases: ["task", "final_integrated"], command: "task verify:tokenizer", candidateInputs: ["src/tokenizer.mjs"],
    });
    expect(tokenizer.verifierClosure.map(({ role, path }) => `${role}:${path}`)).toEqual(["task_runner:Taskfile.yml", "harness:test/tokenizer.test.mjs"]);
    for (const entry of tokenizer.verifierClosure) {
      expect(entry.baseGitBlobOid).toBe("0".repeat(40));
      expect(entry.sha256).toBe("0".repeat(64));
    }
    expect(tokenizer.executionToolchain.task.executablePath).toBe("/model-untrusted/task");
    expect(tokenizer.executionToolchain.linkedRuntime).toEqual([]);
    expect(tokenizer.positiveCases.length).toBeGreaterThan(0);
    expect(tokenizer.negativeControls.length).toBeGreaterThan(0);
    const cli = proposal.proofs.find(({ id }) => id === "cli")!;
    expect(cli.clauseIds).toEqual(["AC-REQ-CLI-001", "AC-REQ-CLI-002"]);
  });

  it("admits a proof that two tasks share for the final phase only", () => {
    const shared = edit(BASE_FIXTURE, (draft) => {
      draft.taskPlan.tasks[2]!.proofIds = ["reading-time", "frequency"];
    });
    const proposal = buildProposal(shared);
    expect(proposal.proofs.find(({ id }) => id === "frequency")!.phases).toEqual(["final_integrated"]);
    expect(proposal.proofs.find(({ id }) => id === "tokenizer")!.phases).toEqual(["task", "final_integrated"]);
  });

  it("is deterministic and its hash follows the plan", () => {
    const first = buildProposal();
    const second = buildProposal();
    expect(canonicalCccPrdJson(first)).toBe(canonicalCccPrdJson(second));
    expect(computeCccPlanningProposalHash(first)).toBe(computeCccPlanningProposalHash(second));
    expect(computeCccPlanningProposalHash(first)).toMatch(/^[0-9a-f]{64}$/u);
    const changed = buildProposal(edit(BASE_FIXTURE, (draft) => { draft.taskPlan.tasks[3]!.title = "Command line interface"; }));
    expect(computeCccPlanningProposalHash(changed)).not.toBe(computeCccPlanningProposalHash(first));
  });

  it("refuses plans and sources the converter cannot quote exactly, each next to a passing twin", () => {
    const build = (fixture: Fixture, sources?: CccPlanningPacketSources) => () => buildProposal(fixture, sources);
    expect(refusalCode(build(BASE_FIXTURE))).toBe("no refusal");
    const unclaimedRequirement = edit(BASE_FIXTURE, (draft) => { draft.taskPlan.tasks[3]!.requirementIds = ["REQ-FREQUENCY"]; });
    expect(refusalCode(build(unclaimedRequirement))).toBe("CCC_PLANNING_GRAPH_INADMISSIBLE");
    const unclaimedProof = edit(BASE_FIXTURE, (draft) => { draft.taskPlan.tasks[3]!.proofIds = ["frequency"]; });
    expect(refusalCode(build(unclaimedProof))).toBe("CCC_PLANNING_GRAPH_INADMISSIBLE");
    const oneWayProof = edit(BASE_FIXTURE, (draft) => { draft.requirementMap.requirements[0]!.proofIds = ["tokenizer", "cli"]; });
    expect(refusalCode(build(oneWayProof))).toBe("CCC_PLANNING_GRAPH_INADMISSIBLE");
    const noTaskfile = edit(BASE_FIXTURE, (draft) => {
      draft.verifierBundle.files = draft.verifierBundle.files.filter(({ path }) => path !== "Taskfile.yml");
      for (const proof of draft.verifierBundle.proofs) proof.files = proof.files.filter((file) => file !== "Taskfile.yml");
    });
    expect(refusalCode(build(noTaskfile))).toBe("CCC_PLANNING_GRAPH_INADMISSIBLE");
    const ambiguousHarness = edit(BASE_FIXTURE, (draft) => {
      draft.verifierBundle.files.push({ path: "test/helper.mjs", mode: "100644", content: "export {};\n" });
      draft.verifierBundle.files.push({ path: "test/other.mjs", mode: "100644", content: "export {};\n" });
      draft.verifierBundle.proofs[0]!.files = ["Taskfile.yml", "test/helper.mjs", "test/other.mjs"];
    });
    expect(refusalCode(build(ambiguousHarness))).toBe("CCC_PLANNING_GRAPH_INADMISSIBLE");
    const fixtureHarness = edit(BASE_FIXTURE, (draft) => {
      draft.verifierBundle.files.push({ path: "test/fixture.json", mode: "100644", content: "{}\n" });
      draft.verifierBundle.proofs[0]!.files = ["Taskfile.yml", "test/tokenizer.test.mjs", "test/fixture.json"];
    });
    expect(buildProposal(fixtureHarness).proofs.find(({ id }) => id === "tokenizer")!.verifierClosure.map(({ role, path }) => `${role}:${path}`))
      .toEqual(["task_runner:Taskfile.yml", "harness:test/tokenizer.test.mjs", "fixture:test/fixture.json"]);
    const editedPrd = { ...sourcesFor(BASE_FIXTURE), finalPrd: Buffer.from(sourcesFor(BASE_FIXTURE).finalPrd.toString("utf8").replace("Requirement statement:", "Requirement summary:"), "utf8") };
    expect(refusalCode(build(BASE_FIXTURE, editedPrd))).toBe("CCC_PLANNING_GRAPH_INADMISSIBLE");
    const missingQuote = edit(BASE_FIXTURE, (draft) => { draft.request = draft.request.replace(REQUEST_QUOTE.tokenizer, "It needs a splitter."); });
    expect(refusalCode(build(missingQuote))).toBe("CCC_PLANNING_REQUEST_QUOTE_UNRESOLVED");
    const repeatedQuote = edit(BASE_FIXTURE, (draft) => { draft.request = `${draft.request}${REQUEST_QUOTE.tokenizer}\n`; });
    expect(refusalCode(build(repeatedQuote))).toBe("CCC_PLANNING_REQUEST_QUOTE_AMBIGUOUS");
    const duplicateClauseText = edit(BASE_FIXTURE, (draft) => {
      draft.requirementMap.requirements[1]!.clauses[0]!.text = draft.requirementMap.requirements[0]!.clauses[0]!.text;
    });
    expect(refusalCode(build(duplicateClauseText))).toBe("CCC_PLANNING_GRAPH_INADMISSIBLE");
    const undeclaredDependency = edit(BASE_FIXTURE, (draft) => { draft.taskPlan.tasks[1]!.dependencyTaskIds = ["T9"]; });
    expect(refusalCode(build(undeclaredDependency))).toBe("CCC_PLANNING_GRAPH_INADMISSIBLE");
    const twoEntries = edit(BASE_FIXTURE, (draft) => {
      draft.taskPlan.tasks[2]!.dependencyTaskIds = [];
      draft.taskPlan.edges = draft.taskPlan.edges.filter(({ id }) => id !== "E-T3-T1");
    });
    expect(refusalCode(build(twoEntries))).toBe("CCC_PLANNING_GRAPH_INADMISSIBLE");
    const cycle = edit(BASE_FIXTURE, (draft) => {
      draft.taskPlan.tasks[0]!.dependencyTaskIds = ["T4"];
      draft.taskPlan.edges.push({ id: "E-T1-T4", fromTaskId: "T1", toTaskId: "T4", kind: "depends_on" });
    });
    expect(refusalCode(build(cycle))).toBe("CCC_PLANNING_GRAPH_INADMISSIBLE");
    const unknownDecision = edit(BASE_FIXTURE, (draft) => {
      draft.requirementMap.requirements[3]!.clauses[1]!.derivation = { kind: "annex", decisionIds: ["DEC-T9"] };
    });
    expect(refusalCode(build(unknownDecision))).toBe("CCC_PLANNING_ANNEX_DECISION_UNKNOWN");
    const controlCharacter = edit(BASE_FIXTURE, (draft) => { draft.requirementMap.requirements[0]!.statement = "The tokenizer splits\u0001 text."; });
    expect(refusalCode(build(controlCharacter))).toBe("CCC_PLANNING_GRAPH_INADMISSIBLE");
    const newlinePath = edit(BASE_FIXTURE, (draft) => {
      draft.taskPlan.tasks[0]!.ownedPaths = ["src/to\nkenizer.mjs"];
      draft.taskPlan.tasks[0]!.allowedWriteRoots = ["src/to\nkenizer.mjs"];
    });
    expect(refusalCode(build(newlinePath))).toBe("CCC_PLANNING_GRAPH_INADMISSIBLE");
  });

  it("compiles with no finding except the proof admission that only the controller's toolchain can supply", async () => {
    const sources = sourcesFor(BASE_FIXTURE);
    const { packet, result } = await authorThrough(adapterFor(buildProposal(BASE_FIXTURE, sources)), sources);
    const sidecar = (result as { sidecar: CccPrdSidecarV2 }).sidecar;
    expect(compileCodes(packet, sidecar, "sidecar")).toEqual(Array.from({ length: 4 }, () => "CCC_PRD_PROOF_ADMISSION_MISSING"));
    // controls: the compiler does read what this test says it cleared
    expect(compileCodes(packet, edit(sidecar, (draft) => { delete draft.materialCoverage; }), "no-coverage")).toContain("CCC_PRD_MATERIAL_COVERAGE_REQUIRED");
    expect(compileCodes(packet, edit(sidecar, (draft) => { delete draft.implementationFactProvenance; }), "no-facts")).toContain("CCC_PRD_IMPLEMENTATION_FACT_PROVENANCE_REQUIRED");
    expect(compileCodes(packet, edit(sidecar, (draft) => { draft.requirements[0]!.acceptance = "something else"; }), "edited-acceptance")).toContain("CCC_PRD_ACCEPTANCE_PROVENANCE_REQUIRED");
    expect(compileCodes(packet, edit(sidecar, (draft) => { draft.tasks.shift(); }), "fewer-tasks").length).toBeGreaterThan(4);
  });

  it("collapses model whitespace to one line, in the PRD and in the proposal alike", () => {
    const messy = edit(BASE_FIXTURE, (draft) => { draft.requirementMap.requirements[0]!.statement = "  The tokenizer\n splits\ttext   into words.  "; });
    const prd = sourcesFor(messy).finalPrd.toString("utf8");
    expect(prd).toContain("\nRequirement statement: The tokenizer splits text into words.\n");
    expect(buildProposal(messy).requirements.find(({ id }) => id === "REQ-TOKENIZER")!.statement).toBe("The tokenizer splits text into words.");
  });

  it("leaves no heading of the authored packet without an owner, which is why the admission facts carry no heading", async () => {
    const sources = sourcesFor(BASE_FIXTURE);
    const proposal = buildProposal(BASE_FIXTURE, sources);
    const { packet, result } = await authorThrough(adapterFor(proposal), sources);
    const sidecar = (result as { sidecar: CccPrdSidecarV2 }).sidecar;
    const custody = readCccPrdPacketCustody({ rootDir: packet.rootDir, manifestPath: packet.manifestPath });
    const analyze = (sourceBytes: Map<string, Buffer>) => analyzeCccPrdMaterialCoverage({
      sourceBytes, requirements: sidecar.requirements, tasks: sidecar.tasks, unresolvedDecisions: sidecar.unresolvedDecisions,
    });
    const covered = analyze(custody.sourceBytes);
    expect(covered.missing.map(({ title }) => title)).toEqual([]);
    expect(covered.conflicts.map(({ title }) => title)).toEqual([]);
    expect(covered.coverage.length).toBeGreaterThan(0);
    // control: the same packet with a heading above the facts has material nothing owns
    const withHeading = new Map(custody.sourceBytes);
    withHeading.set(PATHS.admissionFacts, Buffer.concat([Buffer.from("# Admission facts\n\n", "utf8"), sources.admissionFacts]));
    expect(analyze(withHeading).missing.map(({ title }) => title)).toEqual(["Admission facts"]);
  });

  it("writes the request into the packet untouched, so a changed request byte changes the packet hash", async () => {
    const sources = sourcesFor(BASE_FIXTURE);
    const first = await materializeCccPlanningPacket({ scratchRoot: scratch(), runId: RUN_ID, runRevision: 1, sources });
    const changed = await materializeCccPlanningPacket({
      scratchRoot: scratch(), runId: RUN_ID, runRevision: 1,
      sources: { ...sources, originalRequest: Buffer.from(REQUEST.replace("Node", "node"), "utf8") },
    });
    expect(changed.packetHash).not.toBe(first.packetHash);
  });
});
