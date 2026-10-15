import { describe, expect, it } from "vitest";
import {
  CCC_PLANNING_BUDGET_POLICY_V1,
  cccPlanningCriticalPathMs,
  validateCccPlanningTaskPlanV1,
  validateCccPlanningVerifierBundleV1,
  type CccPlanningTaskPlanV1,
  type CccPlanningVerifierBundleV1,
  type CccPrdDiagnostic,
} from "@fusion/core";
import {
  checkCccPlanningProofCommands,
  cccPlanningProofDefinitionsFromBundle,
  type CccPlanningProofDefinition,
} from "../ccc-planning/proof-command-policy.js";
import { simulateCccPlanningSchedule } from "../ccc-planning/schedule-simulation.js";

/*
FNXC:CccPlanningScheduleAndCommands 2026-10-14-18:40:
Card GG (D19, challenge 29, verify-v2 item 41). The section 4.1 diamond is the positive control for both gates: T1 tokenizer, then T2 word frequency and T3 reading time, then T4 CLI. Writers own only `src/**` and `bin/**`; every proof is `task verify:<name>`, whose Taskfile.yml target runs `node test/<name>.test.mjs <the task's src or bin file>` from the verifier bundle committed at B1. Each refusal below changes one thing in that fixture and asserts the rule the detail names, so a refusal for some other reason does not satisfy it.
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

  it("refuses a candidate path outside the task's own write roots", () => {
    const targets = { ...DIAMOND_TARGETS, "verify:word-frequency": "node test/word-frequency.test.mjs src/word-frequency.mjs src/tokenizer.mjs" };
    const refused = byRule(checkCccPlanningProofCommands(plan(), bundle(targets)), "candidate-in-own-write-roots");
    expect(refused).toHaveLength(1);
    expect(refused[0]!.message).toContain("proof word-frequency");
    expect(refused[0]!.message).toContain("path src/tokenizer.mjs");
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
});
