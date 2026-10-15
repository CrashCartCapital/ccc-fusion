import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  CccPlanningAcceptanceCasesV1,
  CccPlanningRequirementMapV1,
  CccPlanningTaskPlanV1,
  CccPlanningVerifierBundleV1,
  CccPrdAuthoringProposalV2,
  CccPrdDiagnostic,
} from "@fusion/core";
import { diagnoseCccPrdProductGraphAdmission } from "../ccc-prd/compiler.js";
import { CCC_PLANNING_G4_SOURCE_PATHS, runCccPlanningG4, type CccPlanningG4Input } from "../ccc-planning/gates.js";
import { cccPlanningGraphAdmissionInput, diagnoseCccPlanningTaskPlanGraph } from "../ccc-planning/graph-gate.js";

/*
FNXC:CccPlanningGraphGate 2026-10-14-18:40:
Card GG, G4 (D19, ADR B Q3, T3.2 and T3.3). G4 is pure: it takes the planner's task plan, the proposal IB1 builds from the reviewed artifacts, the four packet sources and the verifier bundle, and returns diagnostics before any review is reserved, so there is nothing to spy on and no ledger. One complete fixture, the section 4.1 diamond with its request, admission facts, final PRD and technical annex, is the positive control (zero diagnostics). Every other case changes one thing in it and asserts the diagnostic of the check that change targets, which proves G4 really runs that check.
*/

const TARGET = "/private/tmp/ccc-planning-i2-gg/target";
const BASE = "1".repeat(40);

const REQUEST = [
  "Build a small text statistics tool for plain text.",
  "Provide a tokenizer that splits text into lowercase words.",
  "Count word frequency from the tokens.",
  "Estimate reading time in whole minutes at 200 words per minute.",
  "Provide a CLI that prints JSON and exits 2 on error.",
  "Use node --test tests, no dependencies, no package.json change and no network.",
  "",
].join("\n");

const ADMISSION_FACTS = [
  `Target repository: ${TARGET}`,
  `Baseline commit: ${BASE}`,
  `Admitted write root: ${TARGET}/.fusion`,
  "",
].join("\n");

const FINAL_PRD = [
  "# Text statistics",
  "",
  "## Requirement REQ-1 tokenizer",
  "The tokenizer splits text into lowercase words.",
  "",
  "## Requirement REQ-2 word frequency",
  "Word frequency counts each token.",
  "",
  "## Requirement REQ-3 reading time",
  "Reading time rounds up to whole minutes.",
  "",
  "## Requirement REQ-4 command line",
  "The CLI prints JSON and exits 2 on error.",
  "",
].join("\n");

type TaskSpec = Readonly<{ id: string; proof: string; requirement: string; path: string; deps: readonly string[]; prdQuote: string; decision: string }>;

const TASKS: readonly TaskSpec[] = [
  { id: "T1", proof: "tokenizer", requirement: "REQ-1", path: "src/tokenizer.mjs", deps: [], prdQuote: "The tokenizer splits text into lowercase words.", decision: "DEC-1 Tokenizer module" },
  { id: "T2", proof: "word-frequency", requirement: "REQ-2", path: "src/word-frequency.mjs", deps: ["T1"], prdQuote: "Word frequency counts each token.", decision: "DEC-2 Word frequency module" },
  { id: "T3", proof: "reading-time", requirement: "REQ-3", path: "src/reading-time.mjs", deps: ["T1"], prdQuote: "Reading time rounds up to whole minutes.", decision: "DEC-3 Reading time module" },
  { id: "T4", proof: "cli", requirement: "REQ-4", path: "bin/text-stats.mjs", deps: ["T2", "T3"], prdQuote: "The CLI prints JSON and exits 2 on error.", decision: "DEC-4 Command line entry point" },
];

function custodyLine(spec: TaskSpec): string {
  return `Task ${spec.id} owns ${spec.path} and nothing else.`;
}

function annex(extra: readonly string[] = []): string {
  return [
    "# Technical annex",
    "",
    ...TASKS.flatMap((spec) => [`## ${spec.decision}`, custodyLine(spec), ""]),
    ...extra,
  ].join("\n");
}

function taskfile(): string {
  return [
    "version: \"3\"",
    "tasks:",
    ...TASKS.flatMap((spec) => [`  verify:${spec.proof}:`, "    cmds:", `      - node test/${spec.proof}.test.mjs ${spec.path}`]),
    "",
  ].join("\n");
}

function verifierBundle(): CccPlanningVerifierBundleV1 {
  return {
    schema: "ccc-planning.verifier-bundle.v1",
    files: [
      { path: "Taskfile.yml", mode: "100644", content: taskfile() },
      ...TASKS.map((spec) => ({ path: `test/${spec.proof}.test.mjs`, mode: "100644" as const, content: `// ${spec.proof}\n` })),
    ],
    proofs: TASKS.map((spec) => ({
      id: spec.proof, requirementIds: [spec.requirement], files: ["Taskfile.yml", `test/${spec.proof}.test.mjs`],
      taskfileTask: `verify:${spec.proof}` as const,
    })),
    controls: [],
  };
}

function acceptanceCases(): CccPlanningAcceptanceCasesV1 {
  return {
    schema: "ccc-planning.acceptance-cases.v1",
    cases: [
      { id: "AC-1", statement: "Tokenize.", requestQuotes: ["Build a small text statistics tool for plain text.", "splits text into lowercase words"] },
      { id: "AC-2", statement: "Count.", requestQuotes: ["Count word frequency from the tokens."] },
      { id: "AC-3", statement: "Time.", requestQuotes: ["Estimate reading time in whole minutes"] },
      { id: "AC-4", statement: "CLI.", requestQuotes: ["prints JSON and exits 2 on error"] },
      { id: "AC-5", statement: "Tests.", requestQuotes: ["Use node --test tests"] },
    ],
    exclusions: [{ id: "EX-1", statement: "No network.", requestQuotes: ["no dependencies, no package.json change and no network"] }],
  };
}

function requirementMap(): CccPlanningRequirementMapV1 {
  const clause = (id: string, quote: string, caseId: string) => ({
    id, text: `clause ${id}`, derivation: { kind: "request" as const, requestQuotes: [quote], acceptanceCaseIds: [caseId] },
  });
  return {
    schema: "ccc-planning.requirement-map.v1",
    requirements: [
      { id: "REQ-1", title: "Tokenizer", statement: "Tokenize.", proofIds: ["tokenizer"], clauses: [
        clause("REQ-1-C1", "splits text into lowercase words", "AC-1"), clause("REQ-1-C2", "Use node --test tests", "AC-5")] },
      { id: "REQ-2", title: "Frequency", statement: "Count.", proofIds: ["word-frequency"], clauses: [
        clause("REQ-2-C1", "Count word frequency from the tokens.", "AC-2")] },
      { id: "REQ-3", title: "Reading time", statement: "Time.", proofIds: ["reading-time"], clauses: [
        clause("REQ-3-C1", "Estimate reading time in whole minutes", "AC-3")] },
      { id: "REQ-4", title: "CLI", statement: "CLI.", proofIds: ["cli"], clauses: [
        clause("REQ-4-C1", "prints JSON and exits 2 on error", "AC-4"),
        { id: "REQ-4-C2", text: "The CLI is its own module.", derivation: { kind: "annex", decisionIds: ["DEC-4"] } }] },
    ],
    nonGoals: [{ id: "NG-1", text: "No network.", requestQuotes: ["no network"], exclusionIds: ["EX-1"] }],
  };
}

type Deps = Readonly<Record<string, readonly string[]>>;

function taskPlan(deps: Deps): CccPlanningTaskPlanV1 {
  return {
    schema: "ccc-planning.task-plan.v1",
    tasks: TASKS.map((spec) => ({
      id: spec.id, title: `Task ${spec.id}`, description: `Implements ${spec.proof}.`, requirementIds: [spec.requirement],
      dependencyTaskIds: [...deps[spec.id]!], proofIds: [spec.proof], ownedPaths: [spec.path], allowedWriteRoots: [spec.path],
      protectedActionIds: [],
    })),
    edges: TASKS.flatMap((spec) => deps[spec.id]!.map((dep) => ({
      id: `E-${spec.id}-${dep}`, fromTaskId: spec.id, toTaskId: dep, kind: "depends_on" as const,
    }))),
    protectedActions: [],
  };
}

const P = CCC_PLANNING_G4_SOURCE_PATHS;

/** The proposal IB1 would build; G4 reads tasks, requirements, proofs, unresolved decisions, roots and bounds from it. */
function proposal(deps: Deps): CccPrdAuthoringProposalV2 {
  const value = {
    schema: "ccc-prd.authoring-proposal.v2",
    authorityRoles: [],
    requirements: TASKS.map((spec) => ({
      id: spec.requirement, statement: spec.prdQuote, acceptance: spec.prdQuote, accountableProducer: "spec-author",
      dependencies: [], proofIds: [spec.proof], confidence: "high", acceptanceClauses: [], acceptanceDispositions: [],
      sourceRefs: [{ path: P.finalPrd, exactQuote: spec.prdQuote }],
    })),
    proofs: TASKS.map((spec) => ({
      schema: "ccc-prd.proof.v2", id: spec.proof, requirementIds: [spec.requirement], clauseIds: [], phases: ["task"],
      command: `task verify:${spec.proof}`, positiveOracle: "passes", positiveCases: [], negativeControls: [],
      verifierClosure: [
        { role: "task_runner", path: "Taskfile.yml", baseGitBlobOid: "", sha256: "" },
        { role: "harness", path: `test/${spec.proof}.test.mjs`, baseGitBlobOid: "", sha256: "" },
      ],
      candidateInputs: [spec.path], confidence: "high",
      sourceRefs: [{ path: P.finalPrd, exactQuote: spec.prdQuote }],
    })),
    tasks: TASKS.map((spec) => ({
      id: spec.id, title: `Task ${spec.id}`, description: `Implements ${spec.proof}.`, accountableProducer: "implementation-writer",
      requirementIds: [spec.requirement], dependencyTaskIds: [...deps[spec.id]!], proofIds: [spec.proof], workflowId: "W1",
      documentIds: [], artifactIds: [], protectedActionIds: [], ownedPaths: [spec.path], allowedWriteRoots: [spec.path],
      sourceRefs: [{ path: P.technicalAnnex, exactQuote: custodyLine(spec) }],
    })),
    edges: [], workflows: [], documents: [], artifacts: [], importIntents: [], protectedActions: [],
    bounds: { maxRequests: 3072, maxDurationMs: 86_400_000, maxConcurrency: 1 },
    admittedWriteRoots: [{ path: `${TARGET}/.fusion`, purpose: "Fusion task and artifact state" }],
    targetRepository: { path: TARGET, baseCommit: BASE },
    nonGoals: [], unresolvedDecisions: [], ambiguities: [], exceptions: [], confidence: "high",
  };
  return value as unknown as CccPrdAuthoringProposalV2;
}

const DIAMOND: Deps = { T1: [], T2: ["T1"], T3: ["T1"], T4: ["T2", "T3"] };

type MutableInput = {
  taskPlan: CccPlanningTaskPlanV1; proposal: CccPrdAuthoringProposalV2; verifierBundle: CccPlanningVerifierBundleV1;
  requirementMap: CccPlanningRequirementMapV1; acceptanceCases: CccPlanningAcceptanceCasesV1;
  sources: { originalRequest: Buffer; admissionFacts: Buffer; finalPrd: Buffer; technicalAnnex: Buffer };
  requestArtifactDigest: string;
};

function g4Input(deps: Deps = DIAMOND, annexExtra: readonly string[] = []): MutableInput {
  const originalRequest = Buffer.from(REQUEST, "utf8");
  return {
    taskPlan: taskPlan(deps),
    proposal: proposal(deps),
    sources: {
      originalRequest,
      admissionFacts: Buffer.from(ADMISSION_FACTS, "utf8"),
      finalPrd: Buffer.from(FINAL_PRD, "utf8"),
      technicalAnnex: Buffer.from(annex(annexExtra), "utf8"),
    },
    acceptanceCases: acceptanceCases(),
    requirementMap: requirementMap(),
    requestArtifactDigest: createHash("sha256").update(originalRequest).digest("hex"),
    verifierBundle: verifierBundle(),
  };
}

function run(input: MutableInput): readonly CccPrdDiagnostic[] {
  return runCccPlanningG4(input as CccPlanningG4Input);
}

function codes(diagnostics: readonly CccPrdDiagnostic[]): string[] {
  return [...new Set(diagnostics.map(({ code }) => code))].sort();
}

function mutableTasks(input: MutableInput): Array<Record<string, unknown>> {
  return input.proposal.tasks as unknown as Array<Record<string, unknown>>;
}

describe("runCccPlanningG4", () => {
  it("positive control: the section 4.1 diamond with its sources yields zero diagnostics", () => {
    expect(run(g4Input())).toEqual([]);
  });

  it("a cyclic plan fails G4 with the compiler's graph diagnostic, and G4 stays pure", () => {
    const cyclic: Deps = { ...DIAMOND, T1: ["T4"] };
    const input = g4Input(cyclic);
    // structuredClone turns a Buffer into a plain Uint8Array, so the sources are copied as Buffers to compare like with like.
    const before = { ...structuredClone({ ...input, sources: null }), sources: Object.fromEntries(
      Object.entries(input.sources).map(([name, bytes]) => [name, Buffer.from(bytes)])) };
    const diagnostics = run(input);
    expect(codes(diagnostics)).toContain("CCC_PRD_DEPENDENCY_CYCLE");
    // The graph part is exactly what the compiler's exported admission function says about the same plan.
    const graph = diagnoseCccPrdProductGraphAdmission(cccPlanningGraphAdmissionInput(input.taskPlan));
    expect(graph.map(({ code }) => code)).toContain("CCC_PRD_DEPENDENCY_CYCLE");
    for (const entry of graph) expect(diagnostics).toContainEqual(entry);
    expect(input).toEqual(before);
    expect(run(input)).toEqual(diagnostics);
  });

  it("an N-shaped plan fails G4 before any review: the compiler refuses its shape", () => {
    const bridge: Deps = { T1: [], T2: [], T3: ["T1", "T2"], T4: ["T2"] };
    const diagnostics = run(g4Input(bridge));
    expect(codes(diagnostics)).toContain("CCC_PRD_PRODUCT_GRAPH_UNSUPPORTED");
    expect(diagnoseCccPlanningTaskPlanGraph(taskPlan(DIAMOND))).toEqual([]);
  });

  it("an annex decision realized by no task fails G4 with the material-coverage code", () => {
    const extra = ["## DEC-5 Error reporting", "Errors are written to standard error.", ""];
    expect(codes(run(g4Input(DIAMOND, extra)))).toEqual(["CCC_PRD_MATERIAL_SECTION_UNDISPOSITIONED"]);
    // Control: linking that decision to a task passes.
    const linked = g4Input(DIAMOND, extra);
    (mutableTasks(linked)[3]!.sourceRefs as unknown[]).push({ path: P.technicalAnnex, exactQuote: "Errors are written to standard error." });
    expect(run(linked)).toEqual([]);
  });

  it("a task path missing from its exact source evidence fails G4 with the custody provenance code", () => {
    const input = g4Input();
    mutableTasks(input)[0]!.sourceRefs = [{ path: P.finalPrd, exactQuote: "The tokenizer splits text into lowercase words." }];
    expect(codes(run(input))).toEqual(["CCC_PRD_TASK_CUSTODY_PROVENANCE_REQUIRED"]);
  });

  it("a proposal whose task custody differs from the task plan fails G4", () => {
    const input = g4Input();
    mutableTasks(input)[1]!.ownedPaths = ["src/word-frequency.mjs", "src/extra.mjs"];
    const diagnostics = run(input);
    expect(codes(diagnostics)).toEqual(["CCC_PLANNING_GRAPH_INADMISSIBLE"]);
    expect(diagnostics.some(({ message }) => message.includes("task T2") && message.includes("task plan"))).toBe(true);
  });

  it("a merge action on a non-terminal task fails G4 with the importer's landing rule", () => {
    const input = g4Input();
    const plan = input.taskPlan as unknown as { protectedActions: unknown[]; tasks: Array<{ protectedActionIds: string[] }> };
    plan.protectedActions.push({ id: "A-MERGE", kind: "merge", target: "main" });
    plan.tasks[1]!.protectedActionIds.push("A-MERGE");
    const diagnostics = run(input);
    expect(codes(diagnostics)).toEqual(["CCC_PLANNING_GRAPH_INADMISSIBLE"]);
    expect(diagnostics[0]!.message).toContain("A-MERGE");
    // Control: the same action on the terminal task is admitted.
    const control = g4Input();
    const terminal = control.taskPlan as unknown as { protectedActions: unknown[]; tasks: Array<{ protectedActionIds: string[] }> };
    terminal.protectedActions.push({ id: "A-MERGE", kind: "merge", target: "main" });
    terminal.tasks[3]!.protectedActionIds.push("A-MERGE");
    (mutableTasks(control)[3]!.protectedActionIds as string[]).push("A-MERGE");
    expect(run(control)).toEqual([]);
  });

  it("admitted write roots without the target's .fusion fail G4", () => {
    const input = g4Input();
    (input.proposal as unknown as { admittedWriteRoots: unknown[] }).admittedWriteRoots = [{ path: `${TARGET}/src`, purpose: "source" }];
    const diagnostics = run(input);
    expect(codes(diagnostics)).toEqual(["CCC_PLANNING_GRAPH_INADMISSIBLE"]);
    expect(diagnostics[0]!.message).toContain(".fusion");
  });

  it("G4 runs source fidelity: a changed request byte gives the anchor mismatch", () => {
    const input = g4Input();
    input.sources.originalRequest = Buffer.from(REQUEST.replace("at 200 words", "at 250 words"), "utf8");
    expect(codes(run(input))).toEqual(["CCC_PLANNING_REQUEST_ANCHOR_MISMATCH"]);
  });

  it("G4 runs the proof-command policy on the proposal's proofs", () => {
    const input = g4Input();
    (input.proposal.proofs[0] as unknown as { command: string }).command = "npm install && node --test";
    const diagnostics = run(input);
    expect(codes(diagnostics)).toEqual(["CCC_PLANNING_GRAPH_INADMISSIBLE"]);
    expect(diagnostics.some(({ message }) => message.includes("rule proof-command-is-task-verify:"))).toBe(true);
  });

  it("a task plan that fails its schema stops G4 at the schema diagnostics", () => {
    const input = g4Input();
    (input.taskPlan.tasks[0] as unknown as { proofIds: string[] }).proofIds = ["Not A Proof Id"];
    const diagnostics = run(input);
    expect(codes(diagnostics)).toEqual(["CCC_PLANNING_GRAPH_INADMISSIBLE"]);
    expect(diagnostics.every(({ message }) => message.startsWith("task plan:"))).toBe(true);
  });
});
