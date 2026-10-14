import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  WorkflowExtensionRegistry,
  deriveWorkflowExtensionHostProvenance,
  type CccPrdDiagnostic,
  type CccPrdImportIntent,
} from "@fusion/core";
import { CCC_CAMPAIGN_PROOF_ADMISSION_CONTRIBUTION, CCC_CAMPAIGN_PROOF_ADMISSION_PLUGIN_ID } from "../ccc-campaign-proof-admission.js";
import { authorCccPrdPacket } from "../ccc-prd/authoring.js";
import {
  compileCccPrdPacket,
  diagnoseCccPrdProductGraphAdmission,
  type CccPrdProductGraphAdmissionInput,
} from "../ccc-prd/compiler.js";

/*
FNXC:CCCGraphAdmission 2026-10-14-06:55:
Request-to-code planning gate G4 has to refuse an unsupported task graph before
any model review is reserved, and it has to refuse it for exactly the reasons
the compiler will later refuse the compiled packet. These tests own that
contract: `diagnoseCccPrdProductGraphAdmission` is the single definition of the
product graph rules (dependency cycle, import-intent cardinality, series-parallel
shape, disjoint ownership, unshared live-execution authority, edge/dependency
agreement), `compileCccPrdPacket` calls it, and the parity block below proves
that for every compiler fixture the graph subset of the compiler's diagnostics
is byte-for-byte what the exported function returns.

Arrows below read "A -> B": task A must finish before task B starts, so B lists A
in dependencyTaskIds. The dependency edge for that arrow runs from B (the
dependent) to A (the dependency), exactly as the sidecar declares it.
*/

type Arrow = readonly [from: number, to: number];

const DIAMOND: readonly Arrow[] = [[1, 2], [1, 3], [2, 4], [3, 4]];
const CHAIN_OF_THREE: readonly Arrow[] = [[1, 2], [2, 3]];
// T1 -> {T2 -> {T4, T5} -> T6, T3} -> T7: a fork-join nested inside one branch of another.
const NESTED_DIAMOND: readonly Arrow[] = [[1, 2], [1, 3], [2, 4], [2, 5], [4, 6], [5, 6], [3, 7], [6, 7]];
// T1 -> T3, T2 -> T3, T2 -> T4: the N-shaped "bridge" the supported route cannot execute.
const BRIDGE: readonly Arrow[] = [[1, 3], [2, 3], [2, 4]];
// A fork whose branches never reconverge: two terminals.
const TWO_TERMINALS: readonly Arrow[] = [[1, 2], [1, 3]];

const CODE_UNSUPPORTED = "CCC_PRD_PRODUCT_GRAPH_UNSUPPORTED";
const CODE_OVERLAP = "CCC_PRD_PRODUCT_TASK_OWNERSHIP_OVERLAP";
const CODE_CUSTODY = "CCC_PRD_PRODUCT_TASK_CUSTODY_MISSING";
const CODE_SHARED = "CCC_PRD_PRODUCT_PROTECTED_ACTION_SHARED";
const CODE_CYCLE = "CCC_PRD_DEPENDENCY_CYCLE";
const CODE_CARDINALITY = "CCC_PRD_IMPORT_INTENT_CARDINALITY";

/* ---------------------------------------------------------------- pure inputs */

type MutableAdmissionInput = {
  tasks: Array<{
    id: string;
    workflowId: string;
    dependencyTaskIds: string[];
    ownedPaths: string[];
    allowedWriteRoots: string[];
    protectedActionIds: string[];
  }>;
  edges: Array<{ id: string; fromTaskId: string; toTaskId: string; kind: "depends_on" }>;
  workflows: Array<{ id: string; taskIds: string[]; entryTaskIds: string[]; terminalTaskIds: string[] }>;
  protectedActions: Array<{ id: string; kind: string }>;
  importIntents: CccPrdImportIntent[];
};

const INTENT_TARGET = {
  task: "project.tasks",
  dependency_edge: "project.tasks.dependencies",
  workflow: "project.workflow_work_items",
  work_item: "project.workflow_work_items",
  document: "project.task_documents",
  artifact: "project.artifacts",
  campaign: "project.missions",
  source: "project.ccc_prd_import_sources",
  run_audit: "project.run_audit_events",
} as const;

function intent(
  id: string,
  entityType: keyof typeof INTENT_TARGET,
  entityId: string,
): CccPrdImportIntent {
  return { id, entityType, entityId, operation: "create", target: INTENT_TARGET[entityType] };
}

/** A complete, supported-route input for the given precedence arrows. */
function pureGraph(
  arrows: readonly Arrow[],
  taskCount = Math.max(1, ...arrows.flat()),
): MutableAdmissionInput {
  const numbers = Array.from({ length: taskCount }, (_, index) => index + 1);
  const taskId = (n: number) => `T${n}`;
  const hasPredecessor = (n: number) => arrows.some(([, to]) => to === n);
  const hasSuccessor = (n: number) => arrows.some(([from]) => from === n);
  return {
    tasks: numbers.map((n) => ({
      id: taskId(n),
      workflowId: "W1",
      dependencyTaskIds: arrows.filter(([, to]) => to === n).map(([from]) => taskId(from)),
      ownedPaths: [`tasks/t${n}`],
      allowedWriteRoots: [`tasks/t${n}`],
      protectedActionIds: [],
    })),
    edges: arrows.map(([from, to]) => ({
      id: `E${from}-${to}`,
      fromTaskId: taskId(to),
      toTaskId: taskId(from),
      kind: "depends_on" as const,
    })),
    workflows: [{
      id: "W1",
      taskIds: numbers.map(taskId),
      entryTaskIds: numbers.filter((n) => !hasPredecessor(n)).map(taskId),
      terminalTaskIds: numbers.filter((n) => !hasSuccessor(n)).map(taskId),
    }],
    protectedActions: [
      { id: "A-DELETE", kind: "deletion" },
      { id: "A-LIVE", kind: "live_execution" },
    ],
    importIntents: [
      intent("I-CAMPAIGN", "campaign", "C1"),
      intent("I-SOURCE", "source", "S1"),
      intent("I-AUDIT", "run_audit", "C1"),
      intent("I-WORKFLOW", "workflow", "W1"),
      intent("I-WORK-ITEM", "work_item", "W1"),
      ...numbers.map((n) => intent(`I-TASK-${n}`, "task", taskId(n))),
      ...arrows.map(([from, to]) => intent(`I-EDGE-${from}-${to}`, "dependency_edge", `E${from}-${to}`)),
    ],
  };
}

function withShape(
  arrows: readonly Arrow[],
  mutate: (input: MutableAdmissionInput) => void,
  taskCount?: number,
): MutableAdmissionInput {
  const input = pureGraph(arrows, taskCount);
  mutate(input);
  return input;
}

function task(input: MutableAdmissionInput, id: string): MutableAdmissionInput["tasks"][number] {
  const found = input.tasks.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`fixture has no task ${id}`);
  return found;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function diagnose(input: MutableAdmissionInput): CccPrdDiagnostic[] {
  return diagnoseCccPrdProductGraphAdmission(input as CccPrdProductGraphAdmissionInput);
}

function describeDiagnostics(diagnostics: readonly CccPrdDiagnostic[]): string {
  return diagnostics.map(({ code, message }) => `${code}: ${message}`).join(" | ");
}

/** The messages carried by one code, joined, so a case can name what it expects to see. */
function messagesFor(diagnostics: readonly CccPrdDiagnostic[], code: string): string {
  return diagnostics.filter((item) => item.code === code).map(({ message }) => message).join(" | ");
}

type RefusalCase = {
  label: string;
  input: () => MutableAdmissionInput;
  code: string;
  names: readonly string[];
};

const REFUSALS: readonly RefusalCase[] = [
  {
    label: "adding T4 -> T1 to the diamond is a dependency cycle",
    input: () => withShape([...DIAMOND, [4, 1]], (graph) => {
      graph.workflows[0]!.entryTaskIds = ["T1"];
      graph.workflows[0]!.terminalTaskIds = ["T4"];
    }),
    code: CODE_CYCLE,
    names: ["task dependency cycle includes T1"],
  },
  {
    label: "a fork that never reconverges has two terminal tasks",
    input: () => withShape(TWO_TERMINALS, () => undefined),
    code: CODE_UNSUPPORTED,
    names: ["must declare exactly one terminal task; received T2, T3"],
  },
  {
    label: "a fork that never reconverges is still refused when the workflow declares one terminal",
    input: () => withShape(TWO_TERMINALS, (graph) => {
      graph.workflows[0]!.terminalTaskIds = ["T2"];
    }),
    code: CODE_UNSUPPORTED,
    names: ["must end at exactly one task with no successor; received T2, T3"],
  },
  {
    label: "the T1 -> T3, T2 -> T3, T2 -> T4 bridge has two entries and two terminals",
    input: () => withShape(BRIDGE, () => undefined),
    code: CODE_UNSUPPORTED,
    names: [
      "must declare exactly one entry task; received T1, T2",
      "must declare exactly one terminal task; received T3, T4",
    ],
  },
  {
    label: "the bridge is still refused when the workflow declares one entry and one terminal",
    input: () => withShape(BRIDGE, (graph) => {
      graph.workflows[0]!.entryTaskIds = ["T1"];
      graph.workflows[0]!.terminalTaskIds = ["T3"];
    }),
    code: CODE_UNSUPPORTED,
    names: ["must start at exactly one task with no predecessor; received T1, T2"],
  },
  {
    label: "a cross-link between parallel branches is not series-parallel",
    input: () => withShape([...DIAMOND, [2, 3]], () => undefined),
    code: CODE_UNSUPPORTED,
    names: ["series-parallel", "branches converge on more than one join"],
  },
  {
    label: "two disconnected pairs have two entries and two terminals",
    input: () => withShape([[1, 2], [3, 4]], () => undefined),
    code: CODE_UNSUPPORTED,
    names: ["received T1, T3", "received T2, T4"],
  },
  {
    label: "a detached cycle is unreachable from the entry",
    input: () => withShape([[1, 2], [3, 4], [4, 3]], (graph) => {
      graph.workflows[0]!.entryTaskIds = ["T1"];
      graph.workflows[0]!.terminalTaskIds = ["T2"];
    }),
    code: CODE_UNSUPPORTED,
    names: ["tasks T3, T4 are not reachable from entry task T1"],
  },
  {
    label: "a workflow declaring two entry tasks",
    input: () => withShape(CHAIN_OF_THREE, (graph) => {
      graph.workflows[0]!.entryTaskIds = ["T1", "T2"];
    }),
    code: CODE_UNSUPPORTED,
    names: ["must declare exactly one entry task; received T1, T2"],
  },
  {
    label: "a declared task the workflow does not reference",
    input: () => withShape(CHAIN_OF_THREE, (graph) => {
      graph.workflows[0]!.taskIds = ["T1", "T2"];
    }),
    code: CODE_UNSUPPORTED,
    names: ["declared tasks T3 are not referenced by workflow W1"],
  },
  {
    label: "a workflow task id that is not declared",
    input: () => withShape(CHAIN_OF_THREE, (graph) => {
      graph.workflows[0]!.taskIds.push("T-GHOST");
    }),
    code: CODE_UNSUPPORTED,
    names: ["references undeclared tasks T-GHOST"],
  },
  {
    label: "a declared task that is never imported",
    input: () => withShape(CHAIN_OF_THREE, (graph) => {
      graph.importIntents = graph.importIntents.filter(({ entityId }) => entityId !== "T3");
    }),
    code: CODE_UNSUPPORTED,
    names: ["declared tasks T3 have no task import intent"],
  },
  {
    label: "more than one declared workflow",
    input: () => withShape(CHAIN_OF_THREE, (graph) => {
      graph.workflows.push({ ...structuredClone(graph.workflows[0]!), id: "W2" });
    }),
    code: CODE_UNSUPPORTED,
    names: ["exactly one declared workflow; received 2"],
  },
  {
    label: "a dependency declared twice by the same task",
    input: () => withShape(CHAIN_OF_THREE, (graph) => {
      task(graph, "T2").dependencyTaskIds = ["T1", "T1"];
    }),
    code: CODE_UNSUPPORTED,
    names: ["tasks T2 declare the same dependency more than once"],
  },
  {
    label: "declared edges that disagree with declared dependencies",
    input: () => withShape(CHAIN_OF_THREE, (graph) => {
      graph.edges = graph.edges.filter(({ id }) => id !== "E2-3");
      graph.importIntents = graph.importIntents.filter(({ entityId }) => entityId !== "E2-3");
    }),
    code: CODE_UNSUPPORTED,
    names: ["T3 depends on T2 have no declared dependency edge"],
  },
  {
    label: "a dependency edge that no task declares as a dependency",
    input: () => withShape(CHAIN_OF_THREE, (graph) => {
      graph.edges.find(({ id }) => id === "E2-3")!.toTaskId = "T1";
    }),
    code: CODE_UNSUPPORTED,
    names: ["T3 depends on T1 are not declared as task dependencies"],
  },
  {
    label: "a dependency edge with no import intent",
    input: () => withShape(CHAIN_OF_THREE, (graph) => {
      graph.importIntents = graph.importIntents.filter(({ entityId }) => entityId !== "E2-3");
    }),
    code: CODE_UNSUPPORTED,
    names: ["declared dependency edges E2-3 have no dependency edge import intent"],
  },
  {
    label: "exactly equal owned paths on two tasks, even when one waits for the other",
    input: () => withShape(CHAIN_OF_THREE, (graph) => {
      task(graph, "T2").ownedPaths = ["tasks/t1"];
    }),
    code: CODE_OVERLAP,
    names: ["T1", "T2", "tasks/t1", "including dependency-ordered pairs"],
  },
  {
    label: "an owned path nested inside another task's owned path",
    input: () => withShape(DIAMOND, (graph) => {
      task(graph, "T3").ownedPaths = ["tasks/t2/nested"];
    }),
    code: CODE_OVERLAP,
    names: ["T2", "T3", "tasks/t2/nested"],
  },
  {
    label: "two tasks sharing one live-execution protected action",
    input: () => withShape(DIAMOND, (graph) => {
      task(graph, "T2").protectedActionIds = ["A-LIVE"];
      task(graph, "T3").protectedActionIds = ["A-LIVE"];
    }),
    code: CODE_SHARED,
    names: ["T2, T3", "A-LIVE"],
  },
  {
    label: "a second task that declares no ownedPaths",
    input: () => withShape(CHAIN_OF_THREE, (graph) => {
      graph.tasks[1] = { ...graph.tasks[1]!, ownedPaths: [] };
    }),
    code: CODE_CUSTODY,
    names: ["task T2 declares no ownedPaths"],
  },
  {
    label: "a second task that declares no allowedWriteRoots",
    input: () => withShape(CHAIN_OF_THREE, (graph) => {
      graph.tasks[1] = { ...graph.tasks[1]!, allowedWriteRoots: [] };
    }),
    code: CODE_CUSTODY,
    names: ["task T2 declares no allowedWriteRoots"],
  },
  {
    label: "a missing run_audit import intent",
    input: () => withShape(DIAMOND, (graph) => {
      graph.importIntents = graph.importIntents.filter(({ entityType }) => entityType !== "run_audit");
    }),
    code: CODE_CARDINALITY,
    names: ["exactly one run_audit import intent; received 0"],
  },
  {
    label: "two campaign import intents",
    input: () => withShape(DIAMOND, (graph) => {
      graph.importIntents.push(intent("I-CAMPAIGN-2", "campaign", "C2"));
    }),
    code: CODE_CARDINALITY,
    names: ["exactly one campaign import intent; received 2"],
  },
  {
    label: "a malformed import intent does not count toward cardinality",
    input: () => withShape(DIAMOND, (graph) => {
      const source = graph.importIntents.find(({ entityType }) => entityType === "source")!;
      source.operation = "update" as unknown as "create";
    }),
    code: CODE_CARDINALITY,
    names: ["exactly one source import intent; received 0"],
  },
];

describe("diagnoseCccPrdProductGraphAdmission (pure)", () => {
  describe("admits", () => {
    it.each([
      ["the diamond T1 -> {T2, T3} -> T4", DIAMOND, undefined],
      ["a single task", [], 1],
      ["a chain of three", CHAIN_OF_THREE, undefined],
      ["a nested diamond", NESTED_DIAMOND, undefined],
      ["a transitive shortcut as a fork-join with an empty branch", [...CHAIN_OF_THREE, [1, 3]], undefined],
    ] as ReadonlyArray<readonly [string, readonly Arrow[], number | undefined]>)(
      "%s",
      (_label, arrows, taskCount) => {
        const diagnostics = diagnose(pureGraph(arrows, taskCount));
        expect(diagnostics, describeDiagnostics(diagnostics)).toEqual([]);
      },
    );

    it("a single task that declares no custody paths, as the compiler always has", () => {
      const graph = pureGraph([], 1) as unknown as { tasks: Array<Record<string, unknown>> };
      delete graph.tasks[0]!.ownedPaths;
      delete graph.tasks[0]!.allowedWriteRoots;
      const diagnostics = diagnose(graph as unknown as MutableAdmissionInput);
      expect(diagnostics, describeDiagnostics(diagnostics)).toEqual([]);
    });

    it("two tasks that share a non-live-execution protected action", () => {
      const graph = pureGraph(DIAMOND);
      task(graph, "T2").protectedActionIds = ["A-DELETE"];
      task(graph, "T3").protectedActionIds = ["A-DELETE"];
      expect(diagnose(graph)).toEqual([]);
    });
  });

  describe("refuses", () => {
    it.each(REFUSALS.map((entry) => [entry.label, entry] as const))("%s", (_label, entry) => {
      const diagnostics = diagnose(entry.input());
      expect(diagnostics.length, `no diagnostics for: ${entry.label}`).toBeGreaterThan(0);
      expect(diagnostics.map(({ code }) => code), describeDiagnostics(diagnostics)).toContain(entry.code);
      const named = messagesFor(diagnostics, entry.code);
      for (const name of entry.names) expect(named).toContain(name);
    });
  });

  describe("shape of the result", () => {
    it("refuses the three RED shapes while admitting the diamond in the same run", () => {
      // The diamond is the control: the same function, the same builder, no diagnostics.
      expect(diagnose(pureGraph(DIAMOND))).toEqual([]);
      for (const arrows of [[...DIAMOND, [4, 1]], TWO_TERMINALS, BRIDGE] as Arrow[][]) {
        expect(diagnose(pureGraph(arrows)).length).toBeGreaterThan(0);
      }
    });

    it("is deterministic, ordered by code then message, and never mutates its input", () => {
      const frozen = deepFreeze(withShape([...DIAMOND, [2, 3]], (graph) => {
        task(graph, "T2").ownedPaths = ["tasks/t1"];
        graph.importIntents = graph.importIntents.filter(({ entityType }) => entityType !== "run_audit");
      }));
      const first = diagnose(frozen);
      const second = diagnose(frozen);
      expect(first).toEqual(second);
      expect(new Set(first.map(({ code }) => code))).toEqual(
        new Set([CODE_CARDINALITY, CODE_OVERLAP, CODE_UNSUPPORTED]),
      );
      const keys = first.map(({ code, message }) => `${code}\u0000${message}`);
      expect(keys).toEqual([...keys].sort());
    });
  });
});

/* ------------------------------------------------------- compiler fixtures */

type CompileInput = {
  rootDir: string;
  manifestPath: string;
  sidecarPath: string;
  expectedTarget: string;
  expectedBase: string;
  requireMaterialCoverage: boolean;
};

type MutableSidecar = MutableAdmissionInput;

const roots: string[] = [];
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const target = "/tmp/ccc-planning-graph-admission-target";
const base = "a".repeat(40);
const WORDS = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh"] as const;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function write(root: string, relativePath: string, content: string): string {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

const ref = (exactQuote: string) => [{ path: "source.md", exactQuote }];
const custodyLine = (word: string) =>
  `- Task owned path: tasks/${word}; Task allowed write root: tasks/${word}`;
const requirementLine = (index: number, word: string) =>
  `- \`REQ-${index}\`: ${word} requirement. Acceptance: ${word} proof passes. Proof: task prove:${word}. Oracle: exit 0 and ${word} assertion observed. Negative: mutated ${word} declaration refuses.`;
const deletionActionLine = `- Protected action: deletion ${target}/retired delete publish`;
const liveActionLine = `- Protected action: live_execution ${target}/live-gate requires approval`;

function sourceFor(taskCount: number): string {
  const words = WORDS.slice(0, taskCount);
  return [
    "# Small packet",
    `- Target repository: ${target}`,
    `- Baseline commit: ${base}`,
    `- Allowed write root: ${target}/tasks`,
    "- Allowed write root purpose: task projection",
    "- Max requests: 4",
    "- Max duration ms: 30000",
    "- Max concurrency: 2",
    "- Non-goal: live execution",
    ...words.map(custodyLine),
    deletionActionLine,
    liveActionLine,
    ...words.map((word, index) => requirementLine(index + 1, word)),
  ].join("\n");
}

/**
 * Same authored shape as ccc-prd-multi-task-graph-admission.test.ts, generalised
 * to any precedence arrows: one requirement, proof, custody line and task per
 * node, live execution on the entry task, deletion on the terminal task, and
 * edges that mirror dependencyTaskIds exactly.
 */
function proposalFor(arrows: readonly Arrow[], taskCount: number) {
  const numbers = Array.from({ length: taskCount }, (_, index) => index + 1);
  const words = WORDS.slice(0, taskCount);
  const entry = numbers.find((n) => !arrows.some(([, to]) => to === n))!;
  const terminal = numbers.find((n) => !arrows.some(([from]) => from === n))!;
  const dependenciesOf = (n: number) => arrows.filter(([, to]) => to === n).map(([from]) => from);
  const actionsFor = (n: number) => [
    ...(n === terminal ? ["ACTION-1"] : []),
    ...(n === entry ? ["ACTION-2"] : []),
  ];
  const requirementLines = words.map((word, index) => requirementLine(index + 1, word));
  const custodyLines = words.map(custodyLine);
  const edges = arrows.map(([from, to], index) => ({
    id: `EDGE-${index + 1}`,
    fromTaskId: `TASK-${to}`,
    toTaskId: `TASK-${from}`,
    kind: "depends_on" as const,
  }));
  return {
    schema: "ccc-prd.authoring-proposal.v1",
    authorityRoles: [{
      id: "authority-root",
      role: "root",
      sourcePaths: ["source.md"],
      accountableProducer: "packet-owner",
    }],
    requirements: numbers.map((n) => ({
      id: `REQ-${n}`,
      statement: `${words[n - 1]} requirement`,
      acceptance: `${words[n - 1]} proof passes`,
      accountableProducer: `worker-${n}`,
      dependencies: dependenciesOf(n).map((from) => `REQ-${from}`),
      proofIds: [`PROOF-${n}`],
      sourceRefs: ref(requirementLines[n - 1]!),
      confidence: "high",
    })),
    proofs: numbers.map((n) => ({
      id: `PROOF-${n}`,
      requirementIds: [`REQ-${n}`],
      command: `task prove:${words[n - 1]}`,
      positiveOracle: `exit 0 and ${words[n - 1]} assertion observed`,
      negativeControls: [`mutated ${words[n - 1]} declaration refuses`],
      sourceRefs: ref(requirementLines[n - 1]!),
      confidence: "high",
    })),
    tasks: numbers.map((n) => ({
      id: `TASK-${n}`,
      title: `${words[n - 1]} task`,
      description: `Implement ${words[n - 1]} requirement`,
      ownedPaths: [`tasks/${words[n - 1]}`],
      allowedWriteRoots: [`tasks/${words[n - 1]}`],
      accountableProducer: `worker-${n}`,
      requirementIds: [`REQ-${n}`],
      dependencyTaskIds: dependenciesOf(n).map((from) => `TASK-${from}`),
      proofIds: [`PROOF-${n}`],
      workflowId: "WORKFLOW-1",
      documentIds: n === entry ? ["DOCUMENT-1"] : [],
      artifactIds: n === terminal ? ["ARTIFACT-1"] : [],
      protectedActionIds: actionsFor(n),
      sourceRefs: [...ref(requirementLines[n - 1]!), ...ref(custodyLines[n - 1]!)],
    })),
    edges,
    workflows: [{
      id: "WORKFLOW-1",
      title: "Packet workflow",
      taskIds: numbers.map((n) => `TASK-${n}`),
      entryTaskIds: [`TASK-${entry}`],
      terminalTaskIds: [`TASK-${terminal}`],
      sourceRefs: ref("Small packet"),
    }],
    documents: [{
      id: "DOCUMENT-1",
      taskId: `TASK-${entry}`,
      key: "plan",
      title: "Plan",
      content: "Implement the first requirement.",
      sourceRefs: ref(requirementLines[0]!),
    }],
    artifacts: [{
      id: "ARTIFACT-1",
      taskId: `TASK-${terminal}`,
      type: "proof",
      title: "Terminal proof",
      mimeType: "text/plain",
      content: `task prove:${words[terminal - 1]}`,
      sourceRefs: ref(requirementLines[terminal - 1]!),
    }],
    importIntents: [
      ...numbers.map((n) => intent(`IMPORT-TASK-${n}`, "task", `TASK-${n}`)),
      ...edges.map(({ id }) => intent(`IMPORT-${id}`, "dependency_edge", id)),
      intent("IMPORT-WORKFLOW", "workflow", "WORKFLOW-1"),
      intent("IMPORT-WORK-ITEM", "work_item", "WORKFLOW-1"),
      intent("IMPORT-DOCUMENT", "document", "DOCUMENT-1"),
      intent("IMPORT-ARTIFACT", "artifact", "ARTIFACT-1"),
      intent("IMPORT-CAMPAIGN", "campaign", "CAMPAIGN-1"),
      intent("IMPORT-SOURCE", "source", "SOURCE-1"),
      intent("IMPORT-AUDIT", "run_audit", "CAMPAIGN-1"),
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

async function author(arrows: readonly Arrow[], taskCount = Math.max(1, ...arrows.flat())): Promise<CompileInput> {
  const content = sourceFor(taskCount);
  const root = mkdtempSync(join(tmpdir(), "ccc-planning-graph-admission-"));
  roots.push(root);
  write(root, "source.md", content);
  const manifestPath = write(root, "manifest.json", JSON.stringify({
    schema: "ccc-prd.packet.v1",
    source_version: "graph-admission-parity-test",
    entries: [{
      relative_path: "source.md",
      role: "root",
      authoritative: true,
      sha256: digest(Buffer.from(content, "utf8")),
    }],
  }));
  const workflowExtensionRegistry = new WorkflowExtensionRegistry();
  workflowExtensionRegistry.register(
    CCC_CAMPAIGN_PROOF_ADMISSION_PLUGIN_ID,
    CCC_CAMPAIGN_PROOF_ADMISSION_CONTRIBUTION,
    await deriveWorkflowExtensionHostProvenance({
      pluginId: CCC_CAMPAIGN_PROOF_ADMISSION_PLUGIN_ID,
      pluginVersion: "1.0.0",
      trustedRootPath: root,
      entryRelativePath: "source.md",
      manifestRelativePath: manifestPath.slice(root.length + 1),
    }),
  );
  const result = await authorCccPrdPacket({
    rootDir: root,
    manifestPath,
    adapter: {
      id: "local-deterministic-fixture",
      model: "fixture-v1",
      generateCandidate: async () => proposalFor(arrows, taskCount),
    } as never,
    constraints: {
      targetRepository: { path: target, baseCommit: base },
      bounds: { maxRequests: 4, maxDurationMs: 30_000, maxConcurrency: 2 },
      maxReviewItems: 8,
    },
    workflowExtensionRegistry,
  });
  expect(result.kind, JSON.stringify(result)).toBe("candidate");
  return {
    rootDir: root,
    manifestPath,
    sidecarPath: write(root, "candidate.sidecar.json", JSON.stringify((result as { sidecar: unknown }).sidecar)),
    expectedTarget: target,
    expectedBase: base,
    requireMaterialCoverage: true,
  };
}

function mutateSidecar(input: CompileInput, mutator: (sidecar: MutableSidecar) => void): CompileInput {
  const sidecar = JSON.parse(readFileSync(input.sidecarPath, "utf8")) as MutableSidecar;
  mutator(sidecar);
  writeFileSync(input.sidecarPath, JSON.stringify(sidecar));
  return input;
}

function stripCustody(
  input: CompileInput,
  taskId: string,
  fields: ReadonlyArray<"ownedPaths" | "allowedWriteRoots">,
): CompileInput {
  return mutateSidecar(input, (sidecar) => {
    const found = task(sidecar, taskId) as Record<string, unknown>;
    for (const field of fields) delete found[field];
  });
}

/**
 * The graph subset of the compiler's diagnostics: everything
 * diagnoseCccPrdProductGraphAdmission owns. The requirement-level cycle check
 * shares CCC_PRD_DEPENDENCY_CYCLE but not the "task dependency cycle" message.
 */
function isGraphDiagnostic({ code, message }: CccPrdDiagnostic): boolean {
  return code === CODE_CARDINALITY
    || code === CODE_UNSUPPORTED
    || code === CODE_OVERLAP
    || code === CODE_CUSTODY
    || code === CODE_SHARED
    || (code === CODE_CYCLE && message.startsWith("task dependency cycle"));
}

function expectParity(input: CompileInput, expected: "admitted" | "refused"): void {
  const compiled = compileCccPrdPacket(input);
  const graphSubset = compiled.kind === "refusal" ? compiled.diagnostics.filter(isGraphDiagnostic) : [];
  const sidecar = JSON.parse(readFileSync(input.sidecarPath, "utf8")) as MutableSidecar;
  const direct = diagnoseCccPrdProductGraphAdmission({
    tasks: sidecar.tasks,
    edges: sidecar.edges,
    workflows: sidecar.workflows,
    protectedActions: sidecar.protectedActions,
    importIntents: sidecar.importIntents,
  });
  expect(direct, `compiler graph subset: ${describeDiagnostics(graphSubset)}`).toEqual(graphSubset);
  if (expected === "admitted") {
    expect(compiled.kind, describeDiagnostics(compiled.kind === "refusal" ? compiled.diagnostics : [])).toBe("bundle");
    expect(direct).toEqual([]);
  } else {
    expect(compiled.kind).toBe("refusal");
    expect(graphSubset.length, "a refused fixture must carry at least one graph diagnostic").toBeGreaterThan(0);
  }
}

type ParityFixture = {
  label: string;
  expected: "admitted" | "refused";
  build: () => Promise<CompileInput>;
};

const PARITY_FIXTURES: readonly ParityFixture[] = [
  { label: "single task", expected: "admitted", build: () => author([], 1) },
  { label: "chain of two", expected: "admitted", build: () => author([[1, 2]]) },
  { label: "chain of three", expected: "admitted", build: () => author(CHAIN_OF_THREE) },
  { label: "diamond", expected: "admitted", build: () => author(DIAMOND) },
  { label: "nested diamond", expected: "admitted", build: () => author(NESTED_DIAMOND) },
  { label: "transitive shortcut", expected: "admitted", build: () => author([...CHAIN_OF_THREE, [1, 3]]) },
  {
    label: "single task that declares no custody",
    expected: "admitted",
    build: async () => stripCustody(await author([], 1), "TASK-1", ["ownedPaths", "allowedWriteRoots"]),
  },
  {
    label: "two tasks sharing a non-live protected action",
    expected: "admitted",
    build: async () => mutateSidecar(await author(CHAIN_OF_THREE), (sidecar) => {
      task(sidecar, "TASK-2").protectedActionIds = ["ACTION-1"];
    }),
  },
  { label: "two terminal tasks (fork never reconverges)", expected: "refused", build: () => author(TWO_TERMINALS) },
  { label: "bridge T1 -> T3, T2 -> T3, T2 -> T4", expected: "refused", build: () => author(BRIDGE) },
  { label: "two disconnected pairs", expected: "refused", build: () => author([[1, 2], [3, 4]]) },
  { label: "cross-link between parallel branches", expected: "refused", build: () => author([...DIAMOND, [2, 3]]) },
  {
    label: "dependency cycle through the diamond",
    expected: "refused",
    build: async () => mutateSidecar(await author(DIAMOND), (sidecar) => {
      // T4 -> T1 closes a loop: TASK-1 now waits on TASK-4, which waits on both branches.
      task(sidecar, "TASK-1").dependencyTaskIds = ["TASK-4"];
      sidecar.edges.push({ id: "EDGE-5", fromTaskId: "TASK-1", toTaskId: "TASK-4", kind: "depends_on" });
      sidecar.importIntents.push(intent("IMPORT-EDGE-5", "dependency_edge", "EDGE-5"));
    }),
  },
  {
    label: "workflow declaring two terminal tasks",
    expected: "refused",
    build: async () => mutateSidecar(await author(CHAIN_OF_THREE), (sidecar) => {
      sidecar.workflows[0]!.terminalTaskIds = ["TASK-2", "TASK-3"];
    }),
  },
  {
    label: "workflow declaring two entry tasks",
    expected: "refused",
    build: async () => mutateSidecar(await author(CHAIN_OF_THREE), (sidecar) => {
      sidecar.workflows[0]!.entryTaskIds = ["TASK-1", "TASK-2"];
    }),
  },
  {
    label: "declared task the workflow does not reference",
    expected: "refused",
    build: async () => mutateSidecar(await author(CHAIN_OF_THREE), (sidecar) => {
      sidecar.workflows[0]!.taskIds = ["TASK-1", "TASK-2"];
      sidecar.workflows[0]!.terminalTaskIds = ["TASK-2"];
    }),
  },
  {
    label: "workflow task id that is not declared",
    expected: "refused",
    build: async () => mutateSidecar(await author(CHAIN_OF_THREE), (sidecar) => {
      sidecar.workflows[0]!.taskIds.push("TASK-GHOST");
    }),
  },
  {
    label: "declared task that is never imported",
    expected: "refused",
    build: async () => mutateSidecar(await author(CHAIN_OF_THREE), (sidecar) => {
      sidecar.importIntents = sidecar.importIntents.filter(({ entityId }) => entityId !== "TASK-3");
    }),
  },
  {
    label: "cycle injected into the chain",
    expected: "refused",
    build: async () => mutateSidecar(await author(CHAIN_OF_THREE), (sidecar) => {
      task(sidecar, "TASK-1").dependencyTaskIds = ["TASK-3"];
    }),
  },
  {
    label: "two tasks with no ordering edge at all",
    expected: "refused",
    build: async () => mutateSidecar(await author(CHAIN_OF_THREE), (sidecar) => {
      for (const entry of sidecar.tasks) entry.dependencyTaskIds = [];
      sidecar.edges = [];
      sidecar.importIntents = sidecar.importIntents.filter(({ entityType }) => entityType !== "dependency_edge");
    }),
  },
  {
    label: "dependency declared twice by one task",
    expected: "refused",
    build: async () => mutateSidecar(await author(CHAIN_OF_THREE), (sidecar) => {
      task(sidecar, "TASK-2").dependencyTaskIds = ["TASK-1", "TASK-1"];
    }),
  },
  {
    label: "edges that disagree with declared dependencies",
    expected: "refused",
    build: async () => mutateSidecar(await author(CHAIN_OF_THREE), (sidecar) => {
      sidecar.edges = sidecar.edges.filter(({ id }) => id !== "EDGE-2");
      sidecar.importIntents = sidecar.importIntents.filter(({ entityId }) => entityId !== "EDGE-2");
    }),
  },
  {
    label: "edge that no task declares as a dependency",
    expected: "refused",
    build: async () => mutateSidecar(await author(CHAIN_OF_THREE), (sidecar) => {
      sidecar.edges.find(({ id }) => id === "EDGE-2")!.toTaskId = "TASK-1";
    }),
  },
  {
    label: "equal owned paths on two dependency-ordered tasks",
    expected: "refused",
    build: async () => mutateSidecar(await author(CHAIN_OF_THREE), (sidecar) => {
      task(sidecar, "TASK-2").ownedPaths = ["tasks/first"];
    }),
  },
  {
    label: "owned path nested inside another task's owned path",
    expected: "refused",
    build: async () => mutateSidecar(await author(CHAIN_OF_THREE), (sidecar) => {
      task(sidecar, "TASK-2").ownedPaths = ["tasks/first/nested"];
    }),
  },
  {
    label: "two tasks sharing one live-execution action",
    expected: "refused",
    build: async () => mutateSidecar(await author(CHAIN_OF_THREE), (sidecar) => {
      task(sidecar, "TASK-2").protectedActionIds = ["ACTION-2"];
    }),
  },
  {
    label: "more than one declared workflow",
    expected: "refused",
    build: async () => mutateSidecar(await author(CHAIN_OF_THREE), (sidecar) => {
      sidecar.workflows.push({ ...structuredClone(sidecar.workflows[0]!), id: "WORKFLOW-2" });
    }),
  },
  {
    label: "second task of a chain declares no ownedPaths",
    expected: "refused",
    build: async () => stripCustody(await author([[1, 2]]), "TASK-2", ["ownedPaths"]),
  },
  {
    label: "second task of a chain declares no allowedWriteRoots",
    expected: "refused",
    build: async () => stripCustody(await author([[1, 2]]), "TASK-2", ["allowedWriteRoots"]),
  },
  {
    label: "missing run_audit import intent",
    expected: "refused",
    build: async () => mutateSidecar(await author(DIAMOND), (sidecar) => {
      sidecar.importIntents = sidecar.importIntents.filter(({ entityType }) => entityType !== "run_audit");
    }),
  },
  {
    label: "second campaign import intent",
    expected: "refused",
    build: async () => mutateSidecar(await author(DIAMOND), (sidecar) => {
      sidecar.importIntents.push(intent("IMPORT-CAMPAIGN-2", "campaign", "CAMPAIGN-2"));
    }),
  },
  {
    label: "clone-a-task mutation on the single-task shape",
    expected: "refused",
    build: async () => mutateSidecar(
      stripCustody(await author([], 1), "TASK-1", ["ownedPaths", "allowedWriteRoots"]),
      (sidecar) => {
        sidecar.tasks.push({ ...structuredClone(sidecar.tasks[0]!), id: "TASK-1-SECOND" });
        sidecar.workflows[0]!.taskIds.push("TASK-1-SECOND");
        sidecar.workflows[0]!.terminalTaskIds = ["TASK-1-SECOND"];
        sidecar.importIntents.push(intent("IMPORT-TASK-1-SECOND", "task", "TASK-1-SECOND"));
      },
    ),
  },
];

describe("diagnoseCccPrdProductGraphAdmission parity with compileCccPrdPacket", () => {
  it("covers every refusal family the pure table covers", () => {
    // Guards the parity table itself: a fixture list that quietly lost its
    // refused half would let a do-nothing function pass parity on admitted shapes.
    expect(PARITY_FIXTURES.filter(({ expected }) => expected === "admitted").length).toBeGreaterThanOrEqual(6);
    expect(PARITY_FIXTURES.filter(({ expected }) => expected === "refused").length).toBeGreaterThanOrEqual(20);
  });

  for (const fixture of PARITY_FIXTURES) {
    it(`${fixture.expected}: ${fixture.label}`, async () => {
      expectParity(await fixture.build(), fixture.expected);
    });
  }

  it("is stable across repeated compiles of the same sidecar", async () => {
    const input = await author(DIAMOND);
    const sidecar = JSON.parse(readFileSync(input.sidecarPath, "utf8")) as MutableSidecar;
    const first = diagnoseCccPrdProductGraphAdmission(sidecar);
    expect(diagnoseCccPrdProductGraphAdmission(sidecar)).toEqual(first);
    expect(compileCccPrdPacket(input)).toEqual(compileCccPrdPacket(input));
  });
});
