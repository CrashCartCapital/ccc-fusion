import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CCC_CAMPAIGN_EXECUTION_POLICY_V2_SCHEMA_VERSION,
  CCC_PLANNING_PREFLIGHT_LINEAGES,
  CCC_PLANNING_ROLE_POLICY_FULL_V2,
  parseCccCampaignProductExecutionPolicy,
  type CccPlanningAcceptanceCasesV1,
  type CccPlanningRequirementMapV1,
  type CccPlanningTaskPlanV1,
  type CccPlanningVerifierBundleV1,
  type CccPrdAuthoringProposalV2,
  type CccPrdDiagnostic,
} from "@fusion/core";
import { diagnoseCccPrdProductGraphAdmission } from "../ccc-prd/compiler.js";
import { CCC_PLANNING_G4_SOURCE_PATHS, runCccPlanningG4, type CccPlanningG4Input } from "../ccc-planning/gates.js";
import {
  CCC_PLANNING_FIXED_LINEAGE_IDS,
  cccPlanningGraphAdmissionInput,
  diagnoseCccPlanningImportShape,
  diagnoseCccPlanningTaskPlanGraph,
} from "../ccc-planning/graph-gate.js";
import {
  renderCccPlanningAdmissionFacts,
  renderCccPlanningFinalPrd,
  renderCccPlanningTechnicalAnnex,
  type CccPlanningAdmissionFacts,
} from "../ccc-planning/packet.js";
import { buildCccPlanningAuthoringProposal } from "../ccc-planning/proposal.js";

/*
FNXC:CccPlanningGraphGate 2026-10-14-18:40:
Card GG, G4 (D19, ADR B Q3, T3.2 and T3.3). G4 is pure: it takes the planner's task plan, the proposal IB1 builds from the reviewed artifacts, the four packet sources and the verifier bundle, and returns diagnostics before any review is reserved, so there is nothing to spy on and no ledger. One complete fixture, the section 4.1 diamond with its request, admission facts, final PRD and technical annex, is the positive control (zero diagnostics). Every other case changes one thing in it and asserts the diagnostic of the check that change targets, which proves G4 really runs that check.
FNXC:CccPlanningGraphGate 2026-10-14-23:14:
Errata E12 item 6 (card GGz). The fixture is built the way the I2 path builds it: IB1's renderers write the admission facts, the final PRD and the technical annex from the reviewed artifacts, and IB1's real `buildCccPlanningAuthoringProposal` makes the proposal, so its proofs carry IB1's phases, candidate inputs and clause ids. A case changes the reviewed artifacts and rebuilds through IB1 wherever IB1 can build the shape; where it cannot (IB1 refuses a cycle, an N shape, a schema-invalid plan, or sources other than its own rendering, and it always copies the plan's custody, cites the custody lines and writes `task verify:<id>` commands), the case edits the IB1-built input by hand and says so, and where IB1's refusal is the reason, asserts it.
*/

const TARGET = "/private/tmp/ccc-planning-i2-gg/target";
const BASE = "1".repeat(40);

type DeepMutable<T> = T extends readonly (infer U)[] ? DeepMutable<U>[]
  : T extends object ? { -readonly [K in keyof T]: DeepMutable<T[K]> }
  : T;

function edit<T>(value: T, mutate: (draft: DeepMutable<T>) => void): T {
  const copy = structuredClone(value) as DeepMutable<T>;
  mutate(copy);
  return copy as T;
}

const REQUEST = [
  "Build a small text statistics tool for plain text.",
  "Provide a tokenizer that splits text into lowercase words.",
  "Count word frequency from the tokens.",
  "Estimate reading time in whole minutes at 200 words per minute.",
  "Provide a CLI that prints JSON and exits 2 on error.",
  "Use node --test tests, no dependencies, no package.json change and no network.",
  "",
].join("\n");

const ACCEPTANCE_CASES: CccPlanningAcceptanceCasesV1 = {
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

const requestClause = (id: string, text: string, quote: string, caseId: string) => ({
  id, text, derivation: { kind: "request" as const, requestQuotes: [quote], acceptanceCaseIds: [caseId] },
});

const REQUIREMENT_MAP: CccPlanningRequirementMapV1 = {
  schema: "ccc-planning.requirement-map.v1",
  requirements: [
    { id: "REQ-1", title: "Tokenizer", statement: "The tokenizer splits text into lowercase words.", proofIds: ["tokenizer"], clauses: [
      requestClause("C1", "Tokenizing Hello World yields hello and world.", "splits text into lowercase words", "AC-1"),
      requestClause("C2", "The tokenizer tests run under node --test.", "Use node --test tests", "AC-5")] },
    { id: "REQ-2", title: "Frequency", statement: "Word frequency counts each token.", proofIds: ["word-frequency"], clauses: [
      requestClause("C1", "Counting a b a reports a twice and b once.", "Count word frequency from the tokens.", "AC-2")] },
    { id: "REQ-3", title: "Reading time", statement: "Reading time rounds up to whole minutes.", proofIds: ["reading-time"], clauses: [
      requestClause("C1", "Four hundred words take two minutes.", "Estimate reading time in whole minutes", "AC-3")] },
    { id: "REQ-4", title: "CLI", statement: "The CLI prints JSON and exits 2 on error.", proofIds: ["cli"], clauses: [
      requestClause("C1", "The CLI prints one JSON object for a text file.", "prints JSON and exits 2 on error", "AC-4"),
      { id: "C2", text: "The CLI is its own module.", derivation: { kind: "annex", decisionIds: ["DEC-T4"] } }] },
  ],
  nonGoals: [{ id: "NG-1", text: "No network.", requestQuotes: ["no network"], exclusionIds: ["EX-1"] }],
};

const TASKS = [
  { id: "T1", requirement: "REQ-1", proof: "tokenizer", path: "src/tokenizer.mjs" },
  { id: "T2", requirement: "REQ-2", proof: "word-frequency", path: "src/word-frequency.mjs" },
  { id: "T3", requirement: "REQ-3", proof: "reading-time", path: "src/reading-time.mjs" },
  { id: "T4", requirement: "REQ-4", proof: "cli", path: "bin/text-stats.mjs" },
] as const;

type Deps = Readonly<Record<string, readonly string[]>>;

const DIAMOND: Deps = { T1: [], T2: ["T1"], T3: ["T1"], T4: ["T2", "T3"] };

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

const VERIFIER_BUNDLE: CccPlanningVerifierBundleV1 = {
  schema: "ccc-planning.verifier-bundle.v1",
  files: [
    { path: "Taskfile.yml", mode: "100644", content: "" },
    ...TASKS.map((spec) => ({ path: `test/${spec.proof}.test.mjs`, mode: "100644" as const, content: `// ${spec.proof}\n` })),
  ],
  proofs: TASKS.map((spec) => ({
    id: spec.proof, requirementIds: [spec.requirement], files: ["Taskfile.yml", `test/${spec.proof}.test.mjs`],
    taskfileTask: `verify:${spec.proof}` as const,
  })),
  controls: [],
};

const FACTS: CccPlanningAdmissionFacts = {
  targetRepository: { path: TARGET, baseCommit: BASE },
  admittedWriteRoots: [
    { path: `${TARGET}/.fusion`, purpose: "Fusion task and artifact state" },
    { path: `${TARGET}/src`, purpose: "writer source modules" },
    { path: `${TARGET}/bin`, purpose: "writer command line entry point" },
  ],
  bounds: { maxRequests: 3072, maxDurationMs: 86_400_000, maxConcurrency: 1 },
  protectedActions: [],
};

type Fixture = Readonly<{
  requirementMap: CccPlanningRequirementMapV1;
  taskPlan: CccPlanningTaskPlanV1;
  verifierBundle: CccPlanningVerifierBundleV1;
  facts: CccPlanningAdmissionFacts;
}>;

const BASE_FIXTURE: Fixture = { requirementMap: REQUIREMENT_MAP, taskPlan: taskPlan(DIAMOND), verifierBundle: VERIFIER_BUNDLE, facts: FACTS };

/** The bundle's Taskfile.yml for the proofs IB1 builds: one target per proof over IB1's candidates (its tasks' sorted owned paths). */
function sealTaskfile(fixture: Fixture): Fixture {
  const lines = ["version: \"3\"", "tasks:"];
  for (const proof of fixture.verifierBundle.proofs) {
    const owners = fixture.taskPlan.tasks.filter(({ proofIds }) => proofIds.includes(proof.id));
    const candidates = [...new Set(owners.flatMap(({ ownedPaths }) => ownedPaths))].sort();
    lines.push(`  ${proof.taskfileTask}:`, "    cmds:", `      - node test/${proof.id}.test.mjs ${candidates.join(" ")}`);
  }
  const content = `${lines.join("\n")}\n`;
  return edit(fixture, (draft) => {
    draft.verifierBundle.files = draft.verifierBundle.files.map((file) => (file.path === "Taskfile.yml" ? { ...file, content } : file));
  });
}

const P = CCC_PLANNING_G4_SOURCE_PATHS;

type MutableInput = {
  taskPlan: CccPlanningTaskPlanV1; proposal: CccPrdAuthoringProposalV2; verifierBundle: CccPlanningVerifierBundleV1;
  requirementMap: CccPlanningRequirementMapV1; acceptanceCases: CccPlanningAcceptanceCasesV1;
  sources: { originalRequest: Buffer; admissionFacts: Buffer; finalPrd: Buffer; technicalAnnex: Buffer };
  requestArtifactDigest: string;
};

/** G4's input over the proposal IB1's real builder makes from the fixture and the sources IB1's renderers write. */
function g4Input(raw: Fixture = BASE_FIXTURE): MutableInput {
  const fixture = sealTaskfile(raw);
  const originalRequest = Buffer.from(REQUEST, "utf8");
  const sources = {
    originalRequest,
    admissionFacts: renderCccPlanningAdmissionFacts(fixture.facts),
    finalPrd: renderCccPlanningFinalPrd({ requirementMap: fixture.requirementMap, verifierBundle: fixture.verifierBundle }),
    technicalAnnex: renderCccPlanningTechnicalAnnex({ taskPlan: fixture.taskPlan }),
  };
  const proposal = buildCccPlanningAuthoringProposal({
    sources, requirementMap: fixture.requirementMap, taskPlan: fixture.taskPlan, verifierBundle: fixture.verifierBundle, facts: fixture.facts,
  });
  return {
    taskPlan: fixture.taskPlan, proposal, sources, acceptanceCases: structuredClone(ACCEPTANCE_CASES), requirementMap: fixture.requirementMap,
    requestArtifactDigest: createHash("sha256").update(originalRequest).digest("hex"), verifierBundle: fixture.verifierBundle,
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

/** The fixture with the plan's dependencies replaced (one `E-<from>-<to>` edge per dependency). */
function withDeps(deps: Deps): Fixture {
  return edit(BASE_FIXTURE, (draft) => { draft.taskPlan = taskPlan(deps) as DeepMutable<CccPlanningTaskPlanV1>; });
}

/**
 * IB1 refuses a cyclic or N-shaped plan (proposal.ts singleEntryAndExit), so the diamond is built through IB1 and the plan's
 * dependencies, and the proposal's, are then replaced by hand, to stand for a producer that skips that refusal.
 */
function handDeps(deps: Deps): MutableInput {
  expect(() => g4Input(withDeps(deps))).toThrow(/cycle|exactly one entry task and one terminal task/u);
  const input = g4Input();
  input.taskPlan = taskPlan(deps);
  for (const task of mutableTasks(input)) task.dependencyTaskIds = [...deps[task.id as string]!];
  return input;
}

/** The fixture with T1's custody replaced in the reviewed task plan; IB1 then cites it in the annex and copies it to the proposal. */
function withT1Custody(ownedPaths: readonly string[], allowedWriteRoots: readonly string[], fixture: Fixture = BASE_FIXTURE): Fixture {
  return edit(fixture, (draft) => {
    draft.taskPlan.tasks[0]!.ownedPaths = [...ownedPaths];
    draft.taskPlan.tasks[0]!.allowedWriteRoots = [...allowedWriteRoots];
  });
}

/** The fixture with the PRD-admitted write roots replaced in the admission facts IB1 renders and copies. */
function withAdmittedRoots(paths: readonly string[], fixture: Fixture = BASE_FIXTURE): Fixture {
  return edit(fixture, (draft) => { draft.facts.admittedWriteRoots = paths.map((path) => ({ path, purpose: "admitted" })); });
}

/** The fixture with merge actions declared in the plan and named by one task; IB1 cites each in the annex. */
function withMerges(taskIndex: number, actions: ReadonlyArray<Readonly<{ id: string; target: string }>>): Fixture {
  return edit(BASE_FIXTURE, (draft) => {
    for (const { id, target } of actions) draft.taskPlan.protectedActions.push({ id, kind: "merge", target });
    draft.taskPlan.tasks[taskIndex]!.protectedActionIds.push(...actions.map(({ id }) => id));
  });
}

/*
FNXC:CccPlanningGraphGate 2026-10-14-22:24:
Errata E11 GG item 2. G4 promises that a plan it admits is not refused after review (section 2.17), so its verdict on each task's write roots is checked against the importer's own execution-policy parse, `parseCccCampaignProductExecutionPolicy` from @fusion/core, over routes built the way `createCccPrdProductExecutionPlan` copies each task's custody. The provider and model are placeholders the parse admits; only the custody fields matter here.
*/
type ParsedPolicyBundle = Parameters<typeof parseCccCampaignProductExecutionPolicy>[1];

/** "admitted", or the importer's refusal message, for the proposal's routes. */
function importerVerdict(value: CccPrdAuthoringProposalV2): string {
  const routes = value.tasks.map((task) => ({
    taskId: task.id, providerId: "glm", modelId: "glm-5.3-flash", transport: "pi", executor: "model",
    toolMode: "coding", worktreeMode: "isolated", commitPolicy: "required",
    ownedPaths: [...(task.ownedPaths ?? [])], allowedWriteRoots: [...(task.allowedWriteRoots ?? [])],
  }));
  try {
    parseCccCampaignProductExecutionPolicy({ schema: CCC_CAMPAIGN_EXECUTION_POLICY_V2_SCHEMA_VERSION, routes }, {
      tasks: value.tasks.map(({ id, dependencyTaskIds }) => ({ id, dependencyTaskIds })) as unknown as ParsedPolicyBundle["tasks"],
      admittedWriteRoots: value.admittedWriteRoots,
      targetRepository: value.targetRepository,
    });
    return "admitted";
  } catch (error) {
    return `refused: ${(error as Error).message}`;
  }
}

function byRouteRule(diagnostics: readonly CccPrdDiagnostic[], rule: string): CccPrdDiagnostic[] {
  return diagnostics.filter(({ message }) => message.includes(`rule ${rule}:`));
}

/**
 * The IB1-built diamond with one more path owned and writable by T1, set by hand in the plan, the proposal and an annex custody
 * quote alike: IB1 normalizes a plan's paths, so it cannot carry a non-canonical spelling into the proposal itself.
 */
function handExtraT1Path(extraPath: string): MutableInput {
  const line = `Task T1 also owns ${extraPath} here.`;
  const input = g4Input();
  input.sources.technicalAnnex = Buffer.concat([input.sources.technicalAnnex, Buffer.from(`\n${line}\n`, "utf8")]);
  input.taskPlan = withT1Custody(["src/tokenizer.mjs", extraPath], ["src/tokenizer.mjs", extraPath]).taskPlan;
  const proposed = mutableTasks(input)[0]!;
  proposed.ownedPaths = ["src/tokenizer.mjs", extraPath];
  proposed.allowedWriteRoots = ["src/tokenizer.mjs", extraPath];
  (proposed.sourceRefs as unknown[]).push({ path: P.technicalAnnex, exactQuote: line });
  return input;
}

/** The fixture with task `from` renamed everywhere the reviewed plan names it; IB1 builds the proposal from it. */
function renamedTask(from: string, to: string): Fixture {
  const swap = (id: string) => (id === from ? to : id);
  return edit(BASE_FIXTURE, (draft) => {
    for (const task of draft.taskPlan.tasks) {
      task.id = swap(task.id);
      task.dependencyTaskIds = task.dependencyTaskIds.map(swap);
    }
    for (const edge of draft.taskPlan.edges) {
      edge.fromTaskId = swap(edge.fromTaskId);
      edge.toTaskId = swap(edge.toTaskId);
    }
  });
}

describe("runCccPlanningG4", () => {
  it("positive control: the section 4.1 diamond with its sources yields zero diagnostics", () => {
    const input = g4Input();
    expect(run(input)).toEqual([]);
    // Admissible means the importer's execution-policy parse accepts the same routes (errata E11 GG item 2).
    expect(importerVerdict(input.proposal)).toBe("admitted");
  });

  it("a cyclic plan fails G4 with the compiler's graph diagnostic, and G4 stays pure", () => {
    const cyclic: Deps = { ...DIAMOND, T1: ["T4"] };
    const input = handDeps(cyclic);
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
    const diagnostics = run(handDeps(bridge));
    expect(codes(diagnostics)).toContain("CCC_PRD_PRODUCT_GRAPH_UNSUPPORTED");
    expect(diagnoseCccPlanningTaskPlanGraph(taskPlan(DIAMOND))).toEqual([]);
  });

  it("an annex decision realized by no task fails G4 with the material-coverage code", () => {
    // IB1 writes one decision per task and refuses an annex other than its own rendering (proposal.ts:89), so the unowned
    // decision is appended by hand to the annex IB1 wrote.
    const input = g4Input();
    input.sources.technicalAnnex = Buffer.concat([input.sources.technicalAnnex, Buffer.from("\n## DEC-5 Error reporting\n\nErrors are written to standard error.\n", "utf8")]);
    expect(codes(run(input))).toEqual(["CCC_PRD_MATERIAL_SECTION_UNDISPOSITIONED"]);
    // Control: linking that decision to a task passes.
    (mutableTasks(input)[3]!.sourceRefs as unknown[]).push({ path: P.technicalAnnex, exactQuote: "Errors are written to standard error." });
    expect(run(input)).toEqual([]);
  });

  it("a task path missing from its exact source evidence fails G4 with the custody provenance code", () => {
    // IB1 always cites a task's custody lines in the annex, so the task's evidence is replaced by hand with a PRD quote alone.
    const input = g4Input();
    mutableTasks(input)[0]!.sourceRefs = [{ path: P.finalPrd, exactQuote: "Requirement statement: The tokenizer splits text into lowercase words." }];
    expect(codes(run(input))).toEqual(["CCC_PRD_TASK_CUSTODY_PROVENANCE_REQUIRED"]);
  });

  it("a proposal whose task custody differs from the task plan fails G4", () => {
    // IB1 copies the plan's custody into the proposal, so the difference is made by hand.
    const input = g4Input();
    mutableTasks(input)[1]!.ownedPaths = ["src/word-frequency.mjs", "src/extra.mjs"];
    const diagnostics = run(input);
    expect(codes(diagnostics)).toEqual(["CCC_PLANNING_GRAPH_INADMISSIBLE"]);
    expect(diagnostics.some(({ message }) => message.includes("task T2") && message.includes("task plan"))).toBe(true);
  });

  it("a merge action on a non-terminal task fails G4 with the importer's landing rule", () => {
    // IB1 copies the action into the proposal and cites it in the annex, so the agreement check is silent and only the landing rule can refuse.
    const input = g4Input(withMerges(1, [{ id: "A-MERGE", target: "main" }]));
    expect(mutableTasks(input)[1]!.protectedActionIds).toEqual(["A-MERGE"]);
    const diagnostics = run(input);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.code).toBe("CCC_PLANNING_GRAPH_INADMISSIBLE");
    expect(diagnostics[0]!.message).toContain("single terminal task");
    expect(diagnostics[0]!.message).toContain("A-MERGE");
    // Control: the same action on the terminal task is admitted.
    const control = g4Input(withMerges(3, [{ id: "A-MERGE", target: "main" }]));
    expect(run(control)).toEqual([]);
  });

  it("two merge actions on the terminal task fail G4 with the importer's one-merge rule", () => {
    const input = g4Input(withMerges(3, [{ id: "A-MERGE", target: "main" }, { id: "A-MERGE-2", target: "release" }]));
    const diagnostics = run(input);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.code).toBe("CCC_PLANNING_GRAPH_INADMISSIBLE");
    expect(diagnostics[0]!.message).toContain("2 merge actions (A-MERGE, A-MERGE-2)");
  });

  /*
  FNXC:CccPlanningGraphGate 2026-10-14-21:05:
  Errata E9 GG item 1 at the G4 level. The plan, its proposal and the annex custody quote all carry the same non-canonical spelling, which K1's validator, the agreement check and the custody provenance check all admit; the custody check would still refuse it at import (semantic-proof-custody.ts:1271), so G4 must refuse it before any review spend.
  */
  it("a non-canonical task path fails G4 before review: the custody check would refuse it as a model write root", () => {
    for (const spelling of ["./src/helper.mjs", "src/helper/", "src//helper.mjs", "src/./helper.mjs"]) {
      // IB1 normalizes the plan's paths before it builds, so its proposal carries the canonical spelling and G4's agreement
      // check refuses the reviewed plan that still carries the raw one.
      const built = run(g4Input(withT1Custody(["src/tokenizer.mjs", spelling], ["src/tokenizer.mjs", spelling])));
      expect(built.length).toBeGreaterThan(0);
      expect(built.every(({ message }) => message.includes("differ from task T1 in the task plan"))).toBe(true);
      // A producer that carries the spelling into the proposal as well is a shape IB1 cannot build, so the IB1-built diamond is
      // edited by hand: the plan, the proposal and an annex custody quote all carry it.
      const diagnostics = run(handExtraT1Path(spelling));
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]!.code).toBe("CCC_PLANNING_GRAPH_INADMISSIBLE");
      expect(diagnostics[0]!.message).toContain("rule write-root-canonical:");
      expect(diagnostics[0]!.message).toContain("task T1");
      expect(diagnostics[0]!.message).toContain(`path ${spelling}:`);
    }
    // Controls: the canonical spelling of the same extra path is admitted, by hand and through IB1.
    expect(run(handExtraT1Path("src/helper.mjs"))).toEqual([]);
    expect(run(g4Input(withT1Custody(["src/tokenizer.mjs", "src/helper.mjs"], ["src/tokenizer.mjs", "src/helper.mjs"])))).toEqual([]);
  });

  /*
  FNXC:CccPlanningGraphGate 2026-10-14-21:05:
  Errata E9 GG item 3 (E8 N-3). A campaign task's G7 review runs on lineage `review:<semantic task id>`, and dispatch counters are keyed by lineage id alone (E7-L 8(b)), so a task named like a planning critic would share that critic's attempt counters. G4 refuses the plan; a near name is admitted.
  */
  it("a semantic task id whose G7 lineage review:<id> is a planning fixed lineage fails G4", () => {
    for (const id of ["product-adversary", "technical-critic"]) {
      const diagnostics = run(g4Input(renamedTask("T1", id)));
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]!.code).toBe("CCC_PLANNING_GRAPH_INADMISSIBLE");
      expect(diagnostics[0]!.message).toContain(`task ${id}`);
      expect(diagnostics[0]!.message).toContain(`review:${id}`);
    }
    // Control: a task id that forms no fixed lineage is admitted.
    expect(run(g4Input(renamedTask("T1", "product-adversary-2")))).toEqual([]);
  });

  it("admitted write roots without the target's .fusion fail G4", () => {
    // The fixture's admitted roots without .fusion (errata E11 GG item 2 added src and bin to the fixture).
    const input = g4Input(withAdmittedRoots([`${TARGET}/src`, `${TARGET}/bin`]));
    const diagnostics = run(input);
    expect(codes(diagnostics)).toEqual(["CCC_PLANNING_GRAPH_INADMISSIBLE"]);
    expect(diagnostics[0]!.message).toContain(".fusion");
  });

  /*
  FNXC:CccPlanningGraphGate 2026-10-14-22:24:
  Errata E11 GG item 2 (adversary P2 and P3b). The importer's execution policy refuses a task write root that is not, as an exact string, one of the task's owned paths or inside one (rule write-root-within-owned), and one that, resolved against the target, lies inside no PRD-admitted write root (rule write-root-admitted; canonical.ts parseProductRoute). Before E11, G4 checked neither, so each plan below passed G4 and was refused after review.
  */
  it("a task write root outside every PRD-admitted write root fails G4, as the importer's execution policy refuses it", () => {
    const input = g4Input(withAdmittedRoots([`${TARGET}/.fusion`, `${TARGET}/src`]));
    expect(importerVerdict(input.proposal)).toMatch(/route 3 allowedWriteRoots path "bin\/text-stats\.mjs" is outside PRD-admitted write roots/u);
    const diagnostics = run(input);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.code).toBe("CCC_PLANNING_GRAPH_INADMISSIBLE");
    expect(diagnostics[0]!.message).toContain("rule write-root-admitted:");
    expect(diagnostics[0]!.message).toContain("task T4");
    expect(diagnostics[0]!.message).toContain("path bin/text-stats.mjs:");
    // Control: with bin/ admitted too, G4 and the importer both admit the plan.
    const control = g4Input(withAdmittedRoots([`${TARGET}/.fusion`, `${TARGET}/src`, `${TARGET}/bin`]));
    expect(run(control)).toEqual([]);
    expect(importerVerdict(control.proposal)).toBe("admitted");
  });

  it("a write root that matches an owned path only in another letter case fails G4, as the importer refuses it as outside task ownership", () => {
    const custody = withT1Custody(["src/tokenizer.mjs"], ["src/tokenizer.mjs", "SRC/tokenizer.mjs"]);
    const input = g4Input(custody);
    expect(importerVerdict(input.proposal)).toMatch(/route 0 allowedWriteRoots path "SRC\/tokenizer\.mjs" is outside task ownership/u);
    const diagnostics = run(input);
    for (const entry of diagnostics) expect(entry.code).toBe("CCC_PLANNING_GRAPH_INADMISSIBLE");
    const within = byRouteRule(diagnostics, "write-root-within-owned");
    expect(within).toHaveLength(1);
    expect(within[0]!.message).toContain("task T1");
    expect(within[0]!.message).toContain("path SRC/tokenizer.mjs:");
    // With the whole target admitted, so the path lies inside an admitted root, the ownership rule alone refuses it.
    const wide = g4Input(withAdmittedRoots([`${TARGET}/.fusion`, TARGET], custody));
    expect(importerVerdict(wide.proposal)).toMatch(/"SRC\/tokenizer\.mjs" is outside task ownership/u);
    const alone = run(wide);
    expect(alone).toHaveLength(1);
    expect(byRouteRule(alone, "write-root-within-owned")).toHaveLength(1);
    // Control (errata E12 item 3, case C): an exactly spelled write root inside an owned directory is admitted by G4 and by the
    // importer, with the candidates IB1 builds, which include the owned directory src/lib itself.
    const control = g4Input(withT1Custody(["src/tokenizer.mjs", "src/lib"], ["src/tokenizer.mjs", "src/lib/x.mjs"]));
    expect(control.proposal.proofs[0]!.candidateInputs).toEqual(["src/lib", "src/tokenizer.mjs"]);
    expect(run(control)).toEqual([]);
    expect(importerVerdict(control.proposal)).toBe("admitted");
  });

  /*
  FNXC:CccPlanningGraphGate 2026-10-14-22:24:
  Errata E11 GG item 2(b). Core does not export the importer's `filesystemPathContains`, so G4 mirrors it; this table pins the mirror, and the exact-string ownership rule, to the real parse case by case, including a prefix without a separator, normalized admitted spellings and a root above its owned path.
  */
  it("G4's write-root rules agree with the importer's execution-policy parse case by case", () => {
    const fusion = `${TARGET}/.fusion`;
    const cases: ReadonlyArray<Readonly<{ name: string; owned?: string[]; roots?: string[]; admitted: string[]; admits: boolean; ib1Refuses?: RegExp }>> = [
      { name: "fixture", admitted: [fusion, `${TARGET}/src`, `${TARGET}/bin`], admits: true },
      { name: "bin not admitted", admitted: [fusion, `${TARGET}/src`], admits: false },
      { name: "whole target admitted", admitted: [fusion, TARGET], admits: true },
      { name: "admitted roots with a trailing slash", admitted: [fusion, `${TARGET}/src/`, `${TARGET}/bin/`], admits: true },
      { name: "admitted root with a dot-dot segment", admitted: [fusion, `${TARGET}/bin/../src`, `${TARGET}/bin`], admits: true },
      { name: "admitted root that is a name prefix only", admitted: [fusion, `${TARGET}/sr`, `${TARGET}/bin`], admits: false },
      { name: "write root inside an owned directory", owned: ["src"], roots: ["src/tokenizer.mjs"], admitted: [fusion, TARGET], admits: true,
        ib1Refuses: /tasks T1 and T2 own overlapping paths src and src\/word-frequency\.mjs/u },
      { name: "write root that extends an owned name without a separator", owned: ["src/tokenizer.mjs"], roots: ["src/tokenizer.mjs.bak"], admitted: [fusion, TARGET], admits: false,
        ib1Refuses: /task T1 write root src\/tokenizer\.mjs\.bak is outside its owned paths/u },
      { name: "write root above its owned path", owned: ["src/lib/x.mjs"], roots: ["src/lib"], admitted: [fusion, TARGET], admits: false,
        ib1Refuses: /task T1 write root src\/lib is outside its owned paths/u },
      { name: "write root in another letter case", owned: ["src/tokenizer.mjs"], roots: ["SRC/tokenizer.mjs"], admitted: [fusion, TARGET], admits: false },
    ];
    for (const entry of cases) {
      const fixture = withAdmittedRoots(entry.admitted, entry.owned ? withT1Custody(entry.owned, entry.roots ?? entry.owned) : BASE_FIXTURE);
      let input: MutableInput;
      if (entry.ib1Refuses) {
        // K1's task-plan validator, which IB1 runs before it builds, refuses this custody, so IB1 cannot build the case and the
        // IB1-built proposal is edited by hand to pin the mirror on it.
        expect(() => g4Input(fixture), entry.name).toThrow(entry.ib1Refuses);
        input = g4Input(withAdmittedRoots(entry.admitted));
        const task = mutableTasks(input)[0]!;
        task.ownedPaths = [...entry.owned!];
        task.allowedWriteRoots = [...entry.roots!];
      } else {
        input = g4Input(fixture);
      }
      const verdict = importerVerdict(input.proposal);
      expect(`${entry.name}: ${verdict === "admitted"}`).toBe(`${entry.name}: ${entry.admits}`);
      const shape = diagnoseCccPlanningImportShape(input.proposal);
      const refused = [...byRouteRule(shape, "write-root-within-owned"), ...byRouteRule(shape, "write-root-admitted")];
      expect(`${entry.name}: ${refused.length === 0}`).toBe(`${entry.name}: ${entry.admits}`);
      expect(shape).toEqual(refused);
    }
  });

  it("G4 runs source fidelity: a changed request byte gives the anchor mismatch", () => {
    // The request bytes changed after G1 anchored them; IB1 copies the request untouched, so the change is made to its input by hand.
    const input = g4Input();
    input.sources.originalRequest = Buffer.from(REQUEST.replace("at 200 words", "at 250 words"), "utf8");
    expect(codes(run(input))).toEqual(["CCC_PLANNING_REQUEST_ANCHOR_MISMATCH"]);
  });

  it("G4 runs the proof-command policy on the proposal's proofs", () => {
    // IB1 writes every proof command as `task <the bundle's target>`, so a different command is a hand edit of its proposal.
    const input = g4Input();
    (input.proposal.proofs[0] as unknown as { command: string }).command = "npm install && node --test";
    const diagnostics = run(input);
    expect(codes(diagnostics)).toEqual(["CCC_PLANNING_GRAPH_INADMISSIBLE"]);
    expect(diagnostics.some(({ message }) => message.includes("rule proof-command-is-task-verify:"))).toBe(true);
  });

  it("a task plan that fails its schema stops G4 at the schema diagnostics", () => {
    // IB1 runs K1's validators before it builds, so it refuses this plan; G4 is given it by hand alongside the diamond's proposal.
    const invalid = edit(BASE_FIXTURE, (draft) => { draft.taskPlan.tasks[0]!.proofIds = ["Not A Proof Id"]; });
    expect(() => g4Input(invalid)).toThrow(/task plan is not admissible/u);
    const input = g4Input();
    input.taskPlan = invalid.taskPlan;
    const diagnostics = run(input);
    expect(codes(diagnostics)).toEqual(["CCC_PLANNING_GRAPH_INADMISSIBLE"]);
    expect(diagnostics.every(({ message }) => message.startsWith("task plan:"))).toBe(true);
  });
});

describe("CCC_PLANNING_FIXED_LINEAGE_IDS", () => {
  it("is derived from K1: each fixed or once-if-leaves role's stage:role, each preflight lineage and judge:final", () => {
    const expected = [
      ...CCC_PLANNING_ROLE_POLICY_FULL_V2.roles
        .filter(({ counting }) => counting === "fixed" || counting === "once-if-leaves")
        .map(({ stageId, roleId }) => `${stageId}:${roleId}`),
      ...CCC_PLANNING_PREFLIGHT_LINEAGES.map(({ lineageId }) => lineageId),
      "judge:final",
    ];
    expect(CCC_PLANNING_FIXED_LINEAGE_IDS).toEqual([...new Set(expected)].sort());
    expect(CCC_PLANNING_FIXED_LINEAGE_IDS).toEqual(expect.arrayContaining(
      ["design:designer-b", "research:leaf-reviewer", "preflight:critic", "judge:final"]));
    for (const perTaskOrProbe of ["research:extraction-leaf", "campaign:implementation-writer", "g7:task-reviewer", "preflight:preflight-writer"]) {
      expect(CCC_PLANNING_FIXED_LINEAGE_IDS).not.toContain(perTaskOrProbe);
    }
    // The ids a G7 lineage review:<semantic task id> can collide with today (errata E9 GG item 3).
    expect(CCC_PLANNING_FIXED_LINEAGE_IDS.filter((id) => id.startsWith("review:"))).toEqual(["review:product-adversary", "review:technical-critic"]);
  });
});
