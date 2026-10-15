import { describe, expect, it } from "vitest";
import {
  CCC_PLANNING_BUDGET_POLICY_V1,
  cccPlanningCriticalPathMs,
  validateCccPlanningTaskPlanV1,
  validateCccPlanningVerifierBundleV1,
  type CccPlanningRequirementMapV1,
  type CccPlanningTaskPlanV1,
  type CccPlanningVerifierBundleV1,
  type CccPrdDiagnostic,
} from "@fusion/core";
import {
  renderCccPlanningAdmissionFacts,
  renderCccPlanningFinalPrd,
  renderCccPlanningTechnicalAnnex,
  type CccPlanningAdmissionFacts,
} from "../ccc-planning/packet.js";
import {
  CCC_PLANNING_PROOF_COMMAND_RULES,
  checkCccPlanningProofCommands,
  cccPlanningProofDefinitionsFromBundle,
  type CccPlanningProofDefinition,
} from "../ccc-planning/proof-command-policy.js";
import { buildCccPlanningAuthoringProposal } from "../ccc-planning/proposal.js";
import { simulateCccPlanningSchedule } from "../ccc-planning/schedule-simulation.js";

/*
FNXC:CccPlanningScheduleAndCommands 2026-10-14-18:40:
Card GG (D19, challenge 29, verify-v2 item 41). The section 4.1 diamond is the positive control for both gates: T1 tokenizer, then T2 word frequency and T3 reading time, then T4 CLI. Writers own only `src/**` and `bin/**`; every proof is `task verify:<name>`, whose Taskfile.yml target runs `node test/<name>.test.mjs <the task's src or bin file>` from the verifier bundle committed at B1. Each refusal below changes one thing in that fixture and asserts the rule the detail names, so a refusal for some other reason does not satisfy it.
FNXC:CccPlanningScheduleAndCommands 2026-10-14-23:14:
Errata E12 item 6 (card GGz). G4 checks the proofs of the proposal IB1 builds, so wherever a case passes proof definitions it takes them from IB1's real `buildCccPlanningAuthoringProposal` (`ib1Proofs`, mapped as gates.ts maps the proposal's proofs), and the positive control pins that, for the diamond, they are exactly what the frozen two-argument signature derives from the bundle. A case keeps the bundle-derived proofs (`cccPlanningProofDefinitionsFromBundle`, the frozen signature's default) or a hand edit only where it needs a shape IB1 cannot build, and says so: IB1 writes every command as `task <the bundle's target>`, takes the closure from the bundle proof's files and the candidates from the owned paths of the tasks that name the proof, so a different command, a closure path outside the bundle, or a candidate outside those tasks' owned paths cannot come from it.
*/

type Spec = Readonly<{ id: string; proof: string; owned: readonly string[]; deps: readonly string[] }>;

const DIAMOND: readonly Spec[] = [
  { id: "T1", proof: "tokenizer", owned: ["src/tokenizer.mjs"], deps: [] },
  { id: "T2", proof: "word-frequency", owned: ["src/word-frequency.mjs"], deps: ["T1"] },
  { id: "T3", proof: "reading-time", owned: ["src/reading-time.mjs"], deps: ["T1"] },
  { id: "T4", proof: "cli", owned: ["bin/text-stats.mjs"], deps: ["T2", "T3"] },
];

function plan(specs: readonly Spec[] = DIAMOND, mutate?: (tasks: Array<Record<string, unknown>>) => void): CccPlanningTaskPlanV1 {
  const tasks: Array<Record<string, unknown>> = specs.map((spec) => ({
    id: spec.id, title: `Task ${spec.id}`, description: `Implements ${spec.proof}.`,
    requirementIds: [`REQ-${spec.id}`], dependencyTaskIds: [...spec.deps], proofIds: [spec.proof],
    ownedPaths: [...spec.owned], allowedWriteRoots: [...spec.owned], protectedActionIds: [],
  }));
  mutate?.(tasks);
  return {
    schema: "ccc-planning.task-plan.v1",
    tasks: tasks as unknown as CccPlanningTaskPlanV1["tasks"],
    edges: specs.flatMap((spec) => spec.deps.map((dep) => ({
      id: `E-${spec.id}-${dep}`, fromTaskId: spec.id, toTaskId: dep, kind: "depends_on" as const,
    }))),
    protectedActions: [],
  };
}

function taskfile(targets: Readonly<Record<string, string>>): string {
  const lines = ["version: \"3\"", "tasks:"];
  for (const [name, command] of Object.entries(targets)) lines.push(`  ${name}:`, "    cmds:", `      - ${command}`);
  return `${lines.join("\n")}\n`;
}

const DIAMOND_TARGETS: Readonly<Record<string, string>> = {
  "verify:tokenizer": "node test/tokenizer.test.mjs src/tokenizer.mjs",
  "verify:word-frequency": "node test/word-frequency.test.mjs src/word-frequency.mjs",
  "verify:reading-time": "node test/reading-time.test.mjs src/reading-time.mjs",
  "verify:cli": "node test/cli.test.mjs bin/text-stats.mjs",
};

function bundle(targets: Readonly<Record<string, string>> = DIAMOND_TARGETS): CccPlanningVerifierBundleV1 {
  const names = ["tokenizer", "word-frequency", "reading-time", "cli"];
  return {
    schema: "ccc-planning.verifier-bundle.v1",
    files: [
      { path: "Taskfile.yml", mode: "100644", content: taskfile(targets) },
      ...names.map((name) => ({ path: `test/${name}.test.mjs`, mode: "100644" as const, content: `// ${name} harness\n` })),
    ],
    proofs: names.map((name, index) => ({
      id: name, requirementIds: [`REQ-T${index + 1}`], files: ["Taskfile.yml", `test/${name}.test.mjs`], taskfileTask: `verify:${name}` as const,
    })),
    controls: [],
  };
}

const IB1_TARGET = "/private/tmp/ccc-planning-i2-gg/commands";

const IB1_FACTS: CccPlanningAdmissionFacts = {
  targetRepository: { path: IB1_TARGET, baseCommit: "1".repeat(40) },
  admittedWriteRoots: [
    { path: `${IB1_TARGET}/.fusion`, purpose: "Fusion task and artifact state" },
    { path: `${IB1_TARGET}/src`, purpose: "writer source modules" },
    { path: `${IB1_TARGET}/bin`, purpose: "writer command line entry point" },
  ],
  bounds: { maxRequests: 3072, maxDurationMs: 86_400_000, maxConcurrency: 1 },
  protectedActions: [],
};

/**
 * The proofs IB1's real builder makes for this plan and bundle, as proof definitions mapped the way G4 maps the proposal's
 * proofs (gates.ts proposalProofs). The requirement map gives each requirement one annex-derived clause citing the decisions
 * of the tasks that claim it, and the bundle proofs that cover it; the sources are IB1's own renderings.
 */
function ib1Proofs(taskPlan: CccPlanningTaskPlanV1 = plan(), verifierBundle: CccPlanningVerifierBundleV1 = bundle()): CccPlanningProofDefinition[] {
  const requirementIds = [...new Set(taskPlan.tasks.flatMap((task) => task.requirementIds))];
  const requirementMap: CccPlanningRequirementMapV1 = {
    schema: "ccc-planning.requirement-map.v1",
    requirements: requirementIds.map((id) => ({
      id, title: `Requirement ${id}`, statement: `The statement of ${id}.`,
      proofIds: verifierBundle.proofs.filter((proof) => proof.requirementIds.includes(id)).map((proof) => proof.id),
      clauses: [{ id: "C1", text: `The clause of ${id}.`, derivation: {
        kind: "annex" as const, decisionIds: taskPlan.tasks.filter((task) => task.requirementIds.includes(id)).map((task) => `DEC-${task.id}`),
      } }],
    })),
    nonGoals: [],
  };
  const sources = {
    originalRequest: Buffer.from("Build the text statistics tool.\n", "utf8"),
    admissionFacts: renderCccPlanningAdmissionFacts(IB1_FACTS),
    finalPrd: renderCccPlanningFinalPrd({ requirementMap, verifierBundle }),
    technicalAnnex: renderCccPlanningTechnicalAnnex({ taskPlan }),
  };
  const proposal = buildCccPlanningAuthoringProposal({ sources, requirementMap, taskPlan, verifierBundle, facts: IB1_FACTS });
  return proposal.proofs.map((proof) => ({
    id: proof.id,
    command: proof.command,
    verifierClosure: proof.verifierClosure.map(({ role, path }) => ({ role, path })),
    candidateInputs: [...proof.candidateInputs],
  }));
}

const byId = (proofs: readonly CccPlanningProofDefinition[]) => [...proofs].sort((a, b) => a.id.localeCompare(b.id));

/** The bundle-derived proofs with one command changed: IB1 writes every command as `task <the bundle's target>`, so this is a hand edit. */
function withCommand(proofId: string, command: string): CccPlanningProofDefinition[] {
  return cccPlanningProofDefinitionsFromBundle(bundle()).map((proof) => (proof.id === proofId ? { ...proof, command } : proof));
}

/** The diagnostics whose detail names this rule; every one must also carry the G4 code. */
function byRule(diagnostics: readonly CccPrdDiagnostic[], rule: string): CccPrdDiagnostic[] {
  for (const entry of diagnostics) expect(entry.code).toBe("CCC_PLANNING_GRAPH_INADMISSIBLE");
  return diagnostics.filter(({ message }) => message.includes(`rule ${rule}:`));
}

describe("simulateCccPlanningSchedule", () => {
  it("schedules the diamond at concurrency 1 with campaignCriticalPathMs 4 x 5,400,000 + 1,200,000 + 600,000 = 23,400,000", () => {
    const simulation = simulateCccPlanningSchedule(plan(), CCC_PLANNING_BUDGET_POLICY_V1);
    expect(simulation.diagnostics).toEqual([]);
    expect(simulation.campaignCriticalPathMs).toBe(4 * 5_400_000 + 1_200_000 + 600_000);
    expect(simulation.campaignCriticalPathMs).toBe(23_400_000);
    expect(simulation.campaignCriticalPathMs)
      .toBe(cccPlanningCriticalPathMs({ mode: "build", providerTasks: 4, maxConcurrency: 1 }).campaignMs);
    expect(simulation.order).toEqual(["T1", "T2", "T3", "T4"]);
  });

  it("follows the planned graph: a chain of two is 2 x 5,400,000 + 1,800,000", () => {
    const chain = plan([DIAMOND[0]!, { ...DIAMOND[1]! }]);
    const simulation = simulateCccPlanningSchedule(chain, CCC_PLANNING_BUDGET_POLICY_V1);
    expect(simulation.diagnostics).toEqual([]);
    expect(simulation.campaignCriticalPathMs).toBe(12_600_000);
    expect(simulation.order).toEqual(["T1", "T2"]);
  });

  it("orders by dependency, not by declaration", () => {
    const reversed = plan([...DIAMOND].reverse());
    expect(simulateCccPlanningSchedule(reversed, CCC_PLANNING_BUDGET_POLICY_V1).order).toEqual(["T1", "T3", "T2", "T4"]);
  });

  it("reports tasks a cycle leaves unschedulable", () => {
    const cyclic = plan(DIAMOND, (tasks) => {
      (tasks[0]!.dependencyTaskIds as string[]).push("T4");
    });
    const simulation = simulateCccPlanningSchedule(cyclic, CCC_PLANNING_BUDGET_POLICY_V1);
    expect(simulation.order).toEqual([]);
    expect(simulation.diagnostics.map(({ code }) => code)).toEqual(["CCC_PLANNING_GRAPH_INADMISSIBLE"]);
    expect(simulation.diagnostics[0]!.message).toContain("T1, T2, T3, T4");
  });
});

describe("checkCccPlanningProofCommands", () => {
  it("positive control: the section 4.1 diamond yields zero diagnostics", () => {
    expect(validateCccPlanningTaskPlanV1(plan())).toEqual([]);
    expect(validateCccPlanningVerifierBundleV1(bundle())).toEqual([]);
    expect(checkCccPlanningProofCommands(plan(), bundle())).toEqual([]);
    const proofs = cccPlanningProofDefinitionsFromBundle(bundle());
    expect(proofs.find(({ id }) => id === "tokenizer")).toEqual({
      id: "tokenizer",
      command: "task verify:tokenizer",
      verifierClosure: [{ role: "task_runner", path: "Taskfile.yml" }, { role: "harness", path: "test/tokenizer.test.mjs" }],
      candidateInputs: ["src/tokenizer.mjs"],
    });
    expect(checkCccPlanningProofCommands(plan(), bundle(), proofs)).toEqual([]);
    // IB1's proofs for the diamond are exactly the bundle-derived ones, so a case that keeps the bundle-derived shape tests
    // what G4 sees from IB1 wherever IB1 can build that shape (errata E12 item 6).
    const built = ib1Proofs();
    expect(byId(built)).toEqual(byId(proofs));
    expect(checkCccPlanningProofCommands(plan(), bundle(), built)).toEqual([]);
  });

  it("refuses the proof command npm install && node --test", () => {
    const refused = byRule(checkCccPlanningProofCommands(plan(), bundle(), withCommand("tokenizer", "npm install && node --test")),
      "proof-command-is-task-verify");
    expect(refused).toHaveLength(1);
    expect(refused[0]!.message).toContain("proof tokenizer");
  });

  it("refuses node --test test/tokenizer.test.mjs because it is not task verify:<name>", () => {
    const refused = byRule(checkCccPlanningProofCommands(plan(), bundle(), withCommand("tokenizer", "node --test test/tokenizer.test.mjs")),
      "proof-command-is-task-verify");
    expect(refused).toHaveLength(1);
    expect(refused[0]!.message).toContain("proof tokenizer");
  });

  it("refuses task verify:tokenizer when the bundle's Taskfile.yml does not declare that target", () => {
    const { "verify:tokenizer": _dropped, ...rest } = DIAMOND_TARGETS;
    const refused = byRule(checkCccPlanningProofCommands(plan(), bundle(rest)), "taskfile-declares-target");
    expect(refused).toHaveLength(1);
    expect(refused[0]!.message).toContain("proof tokenizer");
    expect(refused[0]!.message).toContain("Taskfile.yml");
  });

  it("refuses a harness that is not in the verifier bundle", () => {
    const targets = { ...DIAMOND_TARGETS, "verify:tokenizer": "node test/tokenizer-extra.test.mjs src/tokenizer.mjs" };
    const refused = byRule(checkCccPlanningProofCommands(plan(), bundle(targets)), "closure-in-verifier-bundle");
    expect(refused).toHaveLength(1);
    expect(refused[0]!.message).toContain("path test/tokenizer-extra.test.mjs");
  });

  it("refuses v2's demo shape: the writer owns its harness, so the verifier closure overlaps a model write root", () => {
    const demo = plan(DIAMOND, (tasks) => {
      tasks[0]!.ownedPaths = ["src/tokenizer.mjs", "test/tokenizer.test.mjs"];
      tasks[0]!.allowedWriteRoots = ["src/tokenizer.mjs", "test/tokenizer.test.mjs"];
    });
    const diagnostics = checkCccPlanningProofCommands(demo, bundle());
    const overlap = byRule(diagnostics, "closure-disjoint-from-write-roots");
    expect(overlap).toHaveLength(1);
    expect(overlap[0]!.message).toContain("proof tokenizer");
    expect(overlap[0]!.message).toContain("path test/tokenizer.test.mjs");
    expect(byRule(diagnostics, "writer-owns-only-src-bin")).toHaveLength(1);
  });

  it("refuses a writer task that owns Taskfile.yml", () => {
    const owning = plan(DIAMOND, (tasks) => {
      tasks[3]!.ownedPaths = ["bin/text-stats.mjs", "Taskfile.yml"];
    });
    const refused = byRule(checkCccPlanningProofCommands(owning, bundle()), "writer-owns-only-src-bin");
    expect(refused).toHaveLength(1);
    expect(refused[0]!.message).toContain("task T4");
    expect(refused[0]!.message).toContain("path Taskfile.yml");
  });

  it("refuses a writer task that owns a test/** path", () => {
    const owning = plan(DIAMOND, (tasks) => {
      tasks[1]!.ownedPaths = ["src/word-frequency.mjs", "test/fixtures/sample.txt"];
    });
    const refused = byRule(checkCccPlanningProofCommands(owning, bundle()), "writer-owns-only-src-bin");
    expect(refused).toHaveLength(1);
    expect(refused[0]!.message).toContain("path test/fixtures/sample.txt");
  });

  /*
  FNXC:CccPlanningScheduleAndCommands 2026-10-14-23:14:
  Errata E12 item 3. The candidate rule is the custody rule (each candidate inside some route's owned path or write root, importer.ts:1509-1517) restricted to the tasks that run the proof. src/tokenizer.mjs is T1's, and T1 does not run word-frequency, so the candidate is refused although the custody check would admit it. IB1 never builds this candidate (it takes the owned paths of the proof's own tasks), so the case uses the bundle-derived proof, whose candidates are the Taskfile target's arguments.
  */
  it("refuses a candidate path outside the owned paths and write roots of every task that runs the proof", () => {
    const targets = { ...DIAMOND_TARGETS, "verify:word-frequency": "node test/word-frequency.test.mjs src/word-frequency.mjs src/tokenizer.mjs" };
    const diagnostics = checkCccPlanningProofCommands(plan(), bundle(targets));
    expect(diagnostics).toHaveLength(1);
    const refused = byRule(diagnostics, "candidate-in-running-task-paths");
    expect(refused).toHaveLength(1);
    expect(refused[0]!.message).toContain("proof word-frequency");
    expect(refused[0]!.message).toContain("path src/tokenizer.mjs");
    expect(refused[0]!.message).toContain("T2: src/word-frequency.mjs");
    expect(CCC_PLANNING_PROOF_COMMAND_RULES).not.toContain("candidate-in-own-write-roots");
  });

  it("admits a proof shared by two tasks whose candidates are the union of their owned paths, as IB1 builds it", () => {
    const shared = plan(DIAMOND, (tasks) => {
      (tasks[1]!.proofIds as string[]).push("stats");
      (tasks[2]!.proofIds as string[]).push("stats");
    });
    const withStats = (targets: Readonly<Record<string, string>>): CccPlanningVerifierBundleV1 => {
      const base = bundle(targets);
      return {
        ...base,
        files: [...base.files, { path: "test/stats.test.mjs", mode: "100644", content: "// stats harness\n" }],
        proofs: [...base.proofs, { id: "stats", requirementIds: ["REQ-T2", "REQ-T3"], files: ["Taskfile.yml", "test/stats.test.mjs"], taskfileTask: "verify:stats" }],
      };
    };
    const verifier = withStats({ ...DIAMOND_TARGETS, "verify:stats": "node test/stats.test.mjs src/reading-time.mjs src/word-frequency.mjs" });
    const proofs = ib1Proofs(shared, verifier);
    expect(proofs.find(({ id }) => id === "stats")!.candidateInputs).toEqual(["src/reading-time.mjs", "src/word-frequency.mjs"]);
    // Neither T2 nor T3 holds both candidates; each holds one, which is all the custody check needs.
    expect(checkCccPlanningProofCommands(shared, verifier, proofs)).toEqual([]);
  });

  it("admits an owned directory as a candidate although no write root contains it, as IB1 builds it", () => {
    const nested = plan(DIAMOND, (tasks) => {
      tasks[0]!.ownedPaths = ["src/tokenizer.mjs", "src/lib"];
      tasks[0]!.allowedWriteRoots = ["src/tokenizer.mjs", "src/lib/x.mjs"];
    });
    const verifier = bundle({ ...DIAMOND_TARGETS, "verify:tokenizer": "node test/tokenizer.test.mjs src/lib src/tokenizer.mjs" });
    const proofs = ib1Proofs(nested, verifier);
    expect(proofs.find(({ id }) => id === "tokenizer")!.candidateInputs).toEqual(["src/lib", "src/tokenizer.mjs"]);
    expect(checkCccPlanningProofCommands(nested, verifier, proofs)).toEqual([]);
  });

  /*
  FNXC:CccPlanningScheduleAndCommands 2026-10-14-23:14:
  Errata E12 item 1. The custody check reads each closure file with `git ls-tree -- <path>` (semantic-proof-custody.ts:150) and needs the entry git lists to be spelled exactly as asked (:164-167); a leading colon is git pathspec magic, so a closure path that starts with one is refused, and a colon later in the path is not. IB1 builds both closures from the bundle proof's files.
  */
  it("refuses a verifier closure path that starts with a colon, which git reads as pathspec magic", () => {
    const withFixture = (path: string): CccPlanningVerifierBundleV1 => {
      const base = bundle();
      return {
        ...base,
        files: [...base.files, { path, mode: "100644", content: "{}\n" }],
        proofs: base.proofs.map((proof) => (proof.id === "tokenizer" ? { ...proof, files: [...proof.files, path] } : proof)),
      };
    };
    const red = withFixture(":data.json");
    const diagnostics = checkCccPlanningProofCommands(plan(), red, ib1Proofs(plan(), red));
    expect(diagnostics).toHaveLength(1);
    const refused = byRule(diagnostics, "closure-path-git-literal");
    expect(refused).toHaveLength(1);
    expect(refused[0]!.message).toContain("proof tokenizer");
    expect(refused[0]!.message).toContain("path :data.json:");
    expect(refused[0]!.message).toContain("semantic-proof-custody.ts:150");
    // Control: a colon after the first character is literal to git.
    const control = withFixture("fixtures:x/words.txt");
    expect(checkCccPlanningProofCommands(plan(), control, ib1Proofs(plan(), control))).toEqual([]);
  });

  it("compares paths on the comparison key: ./TASKFILE.yml is refused as a writer-owned Taskfile.yml", () => {
    const owning = plan(DIAMOND, (tasks) => {
      tasks[3]!.ownedPaths = ["bin/text-stats.mjs", "./TASKFILE.yml"];
    });
    const diagnostics = checkCccPlanningProofCommands(owning, bundle());
    const writer = byRule(diagnostics, "writer-owns-only-src-bin");
    expect(writer).toHaveLength(1);
    expect(writer[0]!.message).toContain("path ./TASKFILE.yml");
    expect(writer[0]!.message).toContain("Taskfile.yml");
    // An exact-string comparison would miss that every proof's task runner is this writer-owned file.
    const overlap = byRule(diagnostics, "closure-disjoint-from-write-roots");
    expect(overlap.map(({ message }) => /proof ([a-z-]+)/u.exec(message)![1]).sort())
      .toEqual(["cli", "reading-time", "tokenizer", "word-frequency"]);
  });

  it("compares paths on the comparison key: another letter case of a harness overlaps it", () => {
    const owning = plan(DIAMOND, (tasks) => {
      tasks[0]!.ownedPaths = ["src/tokenizer.mjs", "TEST/Tokenizer.test.mjs"];
    });
    const overlap = byRule(checkCccPlanningProofCommands(owning, bundle()), "closure-disjoint-from-write-roots");
    expect(overlap).toHaveLength(1);
    expect(overlap[0]!.message).toContain("proof tokenizer");
    expect(overlap[0]!.message).toContain("path test/tokenizer.test.mjs");
  });

  /*
  FNXC:CccPlanningScheduleAndCommands 2026-10-14-21:05:
  Errata E9 GG item 1 (rule write-root-canonical). K1's task-plan validator normalizes a path before its own checks, so it admits `./src/helper.mjs` or `src/helper/`, but the custody check runs `canonicalRelativePath` on every task's owned paths and write roots (semantic-proof-custody.ts:1271) and the importer's execution policy refuses the same spellings, plus surrounding whitespace and a duplicate (canonical.ts exactTargetRelativePaths). Each case below is admitted by the validator, so only this rule keeps G4 from passing a plan the importer refuses after review spend.
  */
  it("refuses a task path that is not a canonical target-relative path, which the custody check refuses as a model write root", () => {
    for (const spelling of ["./src/helper.mjs", "src/helper/", "src//helper.mjs", "src/./helper.mjs"]) {
      const odd = plan(DIAMOND, (tasks) => {
        tasks[0]!.ownedPaths = ["src/tokenizer.mjs", spelling];
        tasks[0]!.allowedWriteRoots = ["src/tokenizer.mjs", spelling];
      });
      expect(validateCccPlanningTaskPlanV1(odd)).toEqual([]);
      const diagnostics = checkCccPlanningProofCommands(odd, bundle());
      expect(diagnostics).toHaveLength(1);
      const refused = byRule(diagnostics, "write-root-canonical");
      expect(refused).toHaveLength(1);
      expect(refused[0]!.message).toContain("task T1");
      expect(refused[0]!.message).toContain(`path ${spelling}:`);
      expect(refused[0]!.message).toContain("semantic-proof-custody.ts:1271");
    }
    // Control: the canonical spelling of the same extra path is admitted.
    const canonical = plan(DIAMOND, (tasks) => {
      tasks[0]!.ownedPaths = ["src/tokenizer.mjs", "src/helper.mjs"];
      tasks[0]!.allowedWriteRoots = ["src/tokenizer.mjs", "src/helper.mjs"];
    });
    expect(validateCccPlanningTaskPlanV1(canonical)).toEqual([]);
    expect(checkCccPlanningProofCommands(canonical, bundle())).toEqual([]);
  });

  it("refuses a task path with leading or trailing whitespace, as the importer's execution policy does", () => {
    for (const spelling of ["src/helper.mjs ", " src/helper.mjs"]) {
      const padded = plan(DIAMOND, (tasks) => {
        tasks[0]!.ownedPaths = ["src/tokenizer.mjs", spelling];
        tasks[0]!.allowedWriteRoots = ["src/tokenizer.mjs", spelling];
      });
      expect(validateCccPlanningTaskPlanV1(padded)).toEqual([]);
      const refused = byRule(checkCccPlanningProofCommands(padded, bundle()), "write-root-canonical");
      expect(refused).toHaveLength(1);
      expect(refused[0]!.message).toContain("task T1");
      expect(refused[0]!.message).toContain(`path ${spelling}:`);
      expect(refused[0]!.message).toContain("whitespace");
    }
  });

  it("refuses a write root listed twice in one task, as the importer's execution policy does", () => {
    const twice = plan(DIAMOND, (tasks) => {
      tasks[1]!.allowedWriteRoots = ["src/word-frequency.mjs", "src/word-frequency.mjs"];
    });
    expect(validateCccPlanningTaskPlanV1(twice)).toEqual([]);
    const diagnostics = checkCccPlanningProofCommands(twice, bundle());
    expect(diagnostics).toHaveLength(1);
    const refused = byRule(diagnostics, "write-root-canonical");
    expect(refused).toHaveLength(1);
    expect(refused[0]!.message).toContain("task T2");
    expect(refused[0]!.message).toContain("path src/word-frequency.mjs:");
    expect(refused[0]!.message).toContain("more than once in allowedWriteRoots");
  });

  /*
  FNXC:CccPlanningScheduleAndCommands 2026-10-14-22:25:
  Errata E11 GG item 1. The custody check and the importer check each field on its own, so write-root-canonical must too: each case below puts the odd spelling (non-canonical or padded) in exactly one of ownedPaths and allowedWriteRoots, and the diagnostic must name that field. A rule that checked one field only (mutants R7 to R10 and W1) passes every case that puts the spelling in both.
  */
  it("refuses a non-canonical or padded path in one field only, naming that field", () => {
    const cases: Array<[string[], string[], string, string]> = [
      [["src/tokenizer.mjs", "src/lib/"], ["src/tokenizer.mjs", "src/lib/x.mjs"], "ownedPaths", "src/lib/"],
      [["src/tokenizer.mjs", "src/lib"], ["src/tokenizer.mjs", "src/lib/"], "allowedWriteRoots", "src/lib/"],
      [["src/tokenizer.mjs", "src/extra.mjs "], ["src/tokenizer.mjs"], "ownedPaths", "src/extra.mjs "],
      [["src/tokenizer.mjs", "src/lib"], ["src/tokenizer.mjs", "src/lib/x.mjs "], "allowedWriteRoots", "src/lib/x.mjs "],
      [["src/tokenizer.mjs"], ["src/tokenizer.mjs", "./src/tokenizer.mjs"], "allowedWriteRoots", "./src/tokenizer.mjs"],
      [["src/tokenizer.mjs"], ["src/tokenizer.mjs", "src/tokenizer.mjs/"], "allowedWriteRoots", "src/tokenizer.mjs/"],
    ];
    for (const [owned, roots, field, path] of cases) {
      const odd = plan(DIAMOND, (tasks) => { tasks[0]!.ownedPaths = owned; tasks[0]!.allowedWriteRoots = roots; });
      expect(validateCccPlanningTaskPlanV1(odd)).toEqual([]);
      const diagnostics = checkCccPlanningProofCommands(odd, bundle());
      expect(diagnostics).toHaveLength(1);
      expect(byRule(diagnostics, "write-root-canonical")).toHaveLength(1);
      expect(diagnostics[0]!.message).toContain(`task T1 ${field}: path ${path}:`);
    }
  });

  /*
  FNXC:CccPlanningScheduleAndCommands 2026-10-14-22:25:
  Errata E11 GG item 3. Where the custody check admits only an exact spelling, the policy compares exact strings, not K1's comparison key: the custody check's verifyTaskfile needs the target to invoke the one declared harness as spelled, it reads each closure path at B1 by its exact path, and it needs each candidate inside a write root as spelled. E2-13's comparison key governs overlap and identity, not custody spelling, so moving any of these three comparisons onto the key (mutants K4, K2 and K1) would fail open. Each case has its exact-case twin as the control.
  */
  it("refuses a Taskfile target that names the declared harness in another letter case", () => {
    const declared = ib1Proofs();
    const targets = { ...DIAMOND_TARGETS, "verify:tokenizer": "node TEST/tokenizer.test.mjs src/tokenizer.mjs" };
    const diagnostics = checkCccPlanningProofCommands(plan(), bundle(targets), declared);
    expect(diagnostics).toHaveLength(1);
    const refused = byRule(diagnostics, "target-invokes-declared-harness");
    expect(refused).toHaveLength(1);
    expect(refused[0]!.message).toContain("proof tokenizer");
    expect(refused[0]!.message).toContain("path TEST/tokenizer.test.mjs:");
    // Control: the exact-case twin.
    const twin = { ...DIAMOND_TARGETS, "verify:tokenizer": "node test/tokenizer.test.mjs src/tokenizer.mjs" };
    expect(checkCccPlanningProofCommands(plan(), bundle(twin), declared)).toEqual([]);
  });

  it("refuses a closure harness that names the bundle file in another letter case", () => {
    // The target follows the closure's spelling, so only the closure's own lookup in the bundle can refuse it. IB1 takes the
    // closure from the bundle proof's files, which K1 requires to be bundle files, so this closure is a hand edit of IB1's proofs.
    const targets = { ...DIAMOND_TARGETS, "verify:tokenizer": "node TEST/tokenizer.test.mjs src/tokenizer.mjs" };
    const proofs = ib1Proofs().map((proof) => (proof.id === "tokenizer"
      ? { ...proof, verifierClosure: [{ role: "task_runner" as const, path: "Taskfile.yml" }, { role: "harness" as const, path: "TEST/tokenizer.test.mjs" }] }
      : proof));
    const diagnostics = checkCccPlanningProofCommands(plan(), bundle(targets), proofs);
    expect(diagnostics).toHaveLength(1);
    const refused = byRule(diagnostics, "closure-in-verifier-bundle");
    expect(refused).toHaveLength(1);
    expect(refused[0]!.message).toContain("proof tokenizer");
    expect(refused[0]!.message).toContain("path TEST/tokenizer.test.mjs:");
    // Control: the exact-case twin, whose closure harness is the bundle file test/tokenizer.test.mjs.
    expect(checkCccPlanningProofCommands(plan(), bundle(), ib1Proofs())).toEqual([]);
  });

  it("refuses a candidate that lies inside the task's write root only on the comparison key", () => {
    // IB1 takes candidates from the owned paths as spelled, so the respelled candidate comes from the bundle-derived proof.
    const targets = { ...DIAMOND_TARGETS, "verify:tokenizer": "node test/tokenizer.test.mjs SRC/tokenizer.mjs" };
    const diagnostics = checkCccPlanningProofCommands(plan(), bundle(targets));
    expect(diagnostics).toHaveLength(1);
    const refused = byRule(diagnostics, "candidate-in-running-task-paths");
    expect(refused).toHaveLength(1);
    expect(refused[0]!.message).toContain("proof tokenizer");
    expect(refused[0]!.message).toContain("path SRC/tokenizer.mjs:");
    expect(refused[0]!.message).toContain("only on the comparison key");
    // Control: the exact-case twin.
    expect(checkCccPlanningProofCommands(plan(), bundle())).toEqual([]);
  });
});
