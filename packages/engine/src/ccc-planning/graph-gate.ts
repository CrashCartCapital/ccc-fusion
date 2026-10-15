import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  CCC_PLANNING_PREFLIGHT_LINEAGES,
  CCC_PLANNING_ROLE_POLICY_FULL_V2,
  type CccPlanningTaskPlanV1,
  type CccPrdAuthoringProposalV2,
  type CccPrdDiagnostic,
  type CccPrdImportIntent,
} from "@fusion/core";
import { diagnoseCccPrdProductGraphAdmission, type CccPrdProductGraphAdmissionInput } from "../ccc-prd/compiler.js";

/*
FNXC:CccPlanningGraphGate 2026-10-14-18:53:
Card GG, G4 graph admission (D19, ADR B Q3, T3.2). The planner's task plan carries no workflow, terminal or import intent of its own, so G4 builds the one input the compiler's exported `diagnoseCccPrdProductGraphAdmission` (B2) reads, the way IB1's proposal will declare it: one workflow holding every task, entries are the tasks with no dependency, terminals the tasks nothing depends on, the plan's edges unchanged, and exactly one import intent each for the campaign, source, run audit, workflow and work item plus one per task and per edge. The diagnostics are therefore the compiler's own words about the same graph (a cycle, an N shape, two terminals, shared ownership), not a second implementation that could drift from it.
FNXC:CccPlanningGraphGate 2026-10-14-18:53:
The compiler leaves two importer rules unchecked, so G4 adds them, both as CCC_PLANNING_GRAPH_INADMISSIBLE. The importer lands a merge only through the single terminal task (`mergeLandingFor`, importer.ts:1056): a merge action named by any other task would never run, and two merges on the terminal are refused at import. And the importer refuses a bundle whose admitted write roots do not contain the target's `.fusion/tasks` and `.fusion/artifacts`, or whose bounds exceed 10,000 requests, 86,400,000 ms or concurrency 256 (`assertCccPrdImportBundle`, import-admission.ts:89-111); G4 applies the same containment and ceilings to the proposal so a plan it admits is not refused after review.
FNXC:CccPlanningGraphGate 2026-10-14-21:10:
Errata E9 GG item 3 (E8 N-3). A campaign task's G7 review runs on lineage `review:${semanticTaskId}` (section 2.1), and dispatch counters are keyed by lineage id alone (E7-L 8(b)), so a task whose id makes that lineage equal to a planning fixed lineage would share that lineage's attempt counters. G4 refuses such a plan with CCC_PLANNING_GRAPH_INADMISSIBLE naming the task and the colliding lineage. The fixed set is derived from K1's exports, never listed by hand: `${stageId}:${roleId}` for every `fixed` or `once-if-leaves` role of K1's role policy (K1 exports one, full-v2), every `CCC_PLANNING_PREFLIGHT_LINEAGES` id, and the G8 lineage `judge:final`, which section 2.1 fixes and no K1 role spells. Today the colliding ids are `review:product-adversary` and `review:technical-critic`.
FNXC:CccPlanningGraphGate 2026-10-14-22:26:
Errata E11 GG item 2. The importer's execution-policy parse (`parseCccCampaignProductExecutionPolicy`, core canonical.ts `parseProductRoute`) refuses a task write root on two more rules, so G4 applies both to every task of the proposal, as CCC_PLANNING_GRAPH_INADMISSIBLE diagnostics naming the task, the path and the rule: `write-root-within-owned`, each write root must equal one of the same task's owned paths or lie inside one, compared as exact strings (`r === o || r.startsWith(o + "/")`, canonical.ts `pathContains`), so `SRC/tokenizer.mjs` next to the owned `src/tokenizer.mjs` is refused even though K1's comparison key calls them one file; and `write-root-admitted`, each write root resolved against the target must lie inside some PRD-admitted write root. Core does not export the importer's `filesystemPathContains`, so `isContainedPath` below mirrors it (path.relative is "", or neither "..", nor starts with "../", nor absolute), pinned case by case against the real parse in the graph-gate test. The admitted roots are resolved against the target here as in the .fusion check above; the importer calls `resolve(path)`, which agrees for the absolute roots the planning admission facts carry.
FNXC:CccPlanningGraphGate 2026-10-14-23:14:
Errata E12 item 5 (card GGz). A relative PRD-admitted write root is resolved by the importer against its own working directory (`resolve(path)` in import-admission.ts and canonical.ts parseProductRoute), which a pure gate cannot see, so G4 refuses any admitted root that is not absolute, fail-closed, with rule `admitted-root-absolute`. The containment checks above still resolve it against the target, so the refusal stands alone and names the root.
FNXC:CccPlanningGraphGate 2026-10-14-23:14:
Errata E12 item 2 (card GGz). The importer refuses a bundle any of whose task, dependency edge, workflow, document or artifact ids, import intent ids or intent entity ids falls outside `^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$` (`ENTITY_ID_PATTERN`, import-admission.ts:22, checked over that list at :113-125). Core does not export the pattern, so it is mirrored here and pinned against the real `assertCccPrdImportBundle` in the parity test. G4 applies it, as rule `import-entity-id`, to every task and edge id of the plan and to the intent ids IB1 builds from them (`IMPORT-TASK-<task id>` and `IMPORT-EDGE-<edge id>`, proposal.ts:309-310), so the 192-character limit counts the prefix, and, in depth, to every id and entity id the proposal declares. One diagnostic per offending id string.
FNXC:CccPlanningGraphGate 2026-10-14-23:14:
Errata E12 items 3 and 4 (card GGz). The importer's semantic proof plan (`semanticV2WorkflowProofPlan`, importer.ts:660-762) runs on every v2 product import, so G4 mirrors each of its rules over the proposal, whose tasks, proofs, requirements and workflows carry the same fields under the same names, as CCC_PLANNING_GRAPH_INADMISSIBLE diagnostics: `workflow-gates-every-task` (a workflow gates every task exactly once, :664-675); `task-proof-one-owner` (a task-phase proof has exactly one task naming it, :700-705); `task-proof-requirement-owned` and `task-proof-requirement-exclusive` (its requirements are its owner's and no other task's, :706-722); `task-proof-clause-owned` (its clauses are known and its owner's, :723-736); `task-has-task-proof` (every task names at least one task-phase proof, :742-748; IB1 gives the task phase only to a proof that no other task names, so this is the rule that a task needs a proof of its own); and `clause-final-coverage` (every accepted clause has a final_integrated proof covering it, :752-764). A proof a task names but the proposal does not declare is left to the proof-command policy's `task-proof-defined`. Each rule is pinned against the real `nativeWorkflowIr` in the parity test.
*/

export const CCC_PLANNING_WORKFLOW_ID = "ccc-planning-workflow";
export const CCC_PLANNING_CAMPAIGN_ENTITY_ID = "ccc-planning-campaign";
export const CCC_PLANNING_SOURCE_ENTITY_ID = "ccc-planning-source";

const INTENT_TARGET = {
  task: "project.tasks",
  dependency_edge: "project.tasks.dependencies",
  workflow: "project.workflow_work_items",
  work_item: "project.workflow_work_items",
  campaign: "project.missions",
  source: "project.ccc_prd_import_sources",
  run_audit: "project.run_audit_events",
} as const;

const IMPORT_BOUND_CEILINGS = Object.freeze({ maxRequests: 10_000, maxDurationMs: 86_400_000, maxConcurrency: 256 });

/** Section 2.1 node lineage ids that no K1 role spells: G7 is `review:${semanticTaskId}` and G8 is `judge:final`. */
const G7_LINEAGE_PREFIX = "review:";
const G8_LINEAGE_ID = "judge:final";

/** Every planning fixed lineage id, sorted: derived from K1's role policy and preflight lineages, plus the G8 lineage. */
export const CCC_PLANNING_FIXED_LINEAGE_IDS: readonly string[] = Object.freeze([...new Set([
  ...[CCC_PLANNING_ROLE_POLICY_FULL_V2].flatMap(({ roles }) => roles
    .filter(({ counting }) => counting === "fixed" || counting === "once-if-leaves")
    .map(({ stageId, roleId }) => `${stageId}:${roleId}`)),
  ...CCC_PLANNING_PREFLIGHT_LINEAGES.map(({ lineageId }) => lineageId),
  G8_LINEAGE_ID,
])].sort());

function intent(id: string, entityType: keyof typeof INTENT_TARGET, entityId: string): CccPrdImportIntent {
  return { id, entityType, entityId, operation: "create", target: INTENT_TARGET[entityType] };
}

/** The compiler's graph-admission input for a task plan: one workflow, derived entries and terminals, complete import intents. */
export function cccPlanningGraphAdmissionInput(taskPlan: CccPlanningTaskPlanV1): CccPrdProductGraphAdmissionInput {
  const ids = taskPlan.tasks.map(({ id }) => id);
  const dependedOn = new Set(taskPlan.tasks.flatMap(({ dependencyTaskIds }) => dependencyTaskIds));
  return {
    tasks: taskPlan.tasks.map((task) => ({
      id: task.id,
      workflowId: CCC_PLANNING_WORKFLOW_ID,
      dependencyTaskIds: [...task.dependencyTaskIds],
      ownedPaths: [...task.ownedPaths],
      allowedWriteRoots: [...task.allowedWriteRoots],
      protectedActionIds: [...task.protectedActionIds],
    })),
    edges: taskPlan.edges.map((edge) => ({ id: edge.id, fromTaskId: edge.fromTaskId, toTaskId: edge.toTaskId, kind: edge.kind })),
    workflows: [{
      id: CCC_PLANNING_WORKFLOW_ID,
      taskIds: ids,
      entryTaskIds: taskPlan.tasks.filter(({ dependencyTaskIds }) => dependencyTaskIds.length === 0).map(({ id }) => id),
      terminalTaskIds: ids.filter((id) => !dependedOn.has(id)),
    }],
    protectedActions: taskPlan.protectedActions.map(({ id, kind }) => ({ id, kind })),
    importIntents: [
      intent("import-campaign", "campaign", CCC_PLANNING_CAMPAIGN_ENTITY_ID),
      intent("import-source", "source", CCC_PLANNING_SOURCE_ENTITY_ID),
      intent("import-run-audit", "run_audit", CCC_PLANNING_CAMPAIGN_ENTITY_ID),
      intent("import-workflow", "workflow", CCC_PLANNING_WORKFLOW_ID),
      intent("import-work-item", "work_item", CCC_PLANNING_WORKFLOW_ID),
      ...ids.map((id) => intent(`import-task-${id}`, "task", id)),
      ...taskPlan.edges.map(({ id }) => intent(`import-edge-${id}`, "dependency_edge", id)),
    ],
  };
}

function mergeLandingDiagnostics(taskPlan: CccPlanningTaskPlanV1): CccPrdDiagnostic[] {
  const actions = new Map(taskPlan.protectedActions.map((action) => [action.id, action]));
  const dependedOn = new Set(taskPlan.tasks.flatMap(({ dependencyTaskIds }) => dependencyTaskIds));
  const terminals = taskPlan.tasks.filter(({ id }) => !dependedOn.has(id)).map(({ id }) => id);
  const diagnostics: CccPrdDiagnostic[] = [];
  const merges: Array<{ taskId: string; actionId: string }> = [];
  for (const task of taskPlan.tasks) {
    for (const actionId of task.protectedActionIds) {
      const action = actions.get(actionId);
      if (!action) {
        diagnostics.push({
          code: "CCC_PLANNING_GRAPH_INADMISSIBLE",
          message: `task ${task.id} references protected action ${actionId}, which the task plan does not declare`,
        });
      } else if (action.kind === "merge") {
        merges.push({ taskId: task.id, actionId });
      }
    }
  }
  for (const merge of merges) {
    if (terminals.length !== 1 || merge.taskId !== terminals[0]) {
      diagnostics.push({
        code: "CCC_PLANNING_GRAPH_INADMISSIBLE",
        message: `merge action ${merge.actionId} is on task ${merge.taskId}, but the importer lands a merge only through the single terminal task`
          + ` (terminals: ${terminals.join(", ") || "none"})`,
      });
    }
  }
  if (merges.length > 1) {
    diagnostics.push({
      code: "CCC_PLANNING_GRAPH_INADMISSIBLE",
      message: `the task plan names ${merges.length} merge actions (${merges.map(({ actionId }) => actionId).join(", ")}); the terminal task must reference exactly one`,
    });
  }
  return diagnostics;
}

function lineageCollisionDiagnostics(taskPlan: CccPlanningTaskPlanV1): CccPrdDiagnostic[] {
  const fixed = new Set(CCC_PLANNING_FIXED_LINEAGE_IDS);
  return taskPlan.tasks
    .filter(({ id }) => fixed.has(`${G7_LINEAGE_PREFIX}${id}`))
    .map(({ id }) => ({
      code: "CCC_PLANNING_GRAPH_INADMISSIBLE",
      message: `task ${id}: its G7 review lineage ${G7_LINEAGE_PREFIX}${id} is the planning fixed lineage ${G7_LINEAGE_PREFIX}${id};`
        + " dispatch counters are keyed by lineage id alone, so the task's review would share that lineage's attempts",
    }));
}

/** G4's graph part: the compiler's product-graph admission, the importer's merge-landing rule and the G7 lineage namespace. Pure. */
export function diagnoseCccPlanningTaskPlanGraph(taskPlan: CccPlanningTaskPlanV1): CccPrdDiagnostic[] {
  return [
    ...diagnoseCccPrdProductGraphAdmission(cccPlanningGraphAdmissionInput(taskPlan)),
    ...mergeLandingDiagnostics(taskPlan),
    ...lineageCollisionDiagnostics(taskPlan),
  ];
}

/** The importer's `filesystemPathContains` (canonical.ts), also its import-admission `isContainedPath`. */
function isContainedPath(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function stringEntries(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/** The importer's `ENTITY_ID_PATTERN` (import-admission.ts:22), byte for byte. */
const IMPORT_ENTITY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
/** The intent ids IB1 builds for each task and each dependency edge (proposal.ts:309-310). */
const IB1_TASK_INTENT_PREFIX = "IMPORT-TASK-";
const IB1_EDGE_INTENT_PREFIX = "IMPORT-EDGE-";

function idRows(label: string, value: unknown): Array<readonly [string, unknown]> {
  return Array.isArray(value) ? value.map((row) => [label, (row as { id?: unknown } | null)?.id] as const) : [];
}

/**
 * The importer's entity-id admission (assertCccPrdImportBundle, import-admission.ts:113-125) over the ids the plan implies
 * (each task and edge id and the intent id IB1 builds from it) and the ids the proposal declares. Pure.
 */
export function diagnoseCccPlanningImportEntityIds(taskPlan: CccPlanningTaskPlanV1, proposal: CccPrdAuthoringProposalV2): CccPrdDiagnostic[] {
  const rows: Array<readonly [string, unknown]> = [
    ...taskPlan.tasks.flatMap(({ id }) => [["task", id] as const, ["import intent", `${IB1_TASK_INTENT_PREFIX}${id}`] as const]),
    ...taskPlan.edges.flatMap(({ id }) => [["dependency edge", id] as const, ["import intent", `${IB1_EDGE_INTENT_PREFIX}${id}`] as const]),
    ...idRows("task", proposal.tasks),
    ...idRows("dependency edge", proposal.edges),
    ...idRows("workflow", proposal.workflows),
    ...idRows("document", proposal.documents),
    ...idRows("artifact", proposal.artifacts),
    ...(Array.isArray(proposal.importIntents) ? proposal.importIntents : []).flatMap((intent) => [
      ["import intent", intent?.id] as const,
      [`${String(intent?.entityType)} entity`, intent?.entityId] as const,
    ]),
  ];
  const seen = new Set<string>();
  const diagnostics: CccPrdDiagnostic[] = [];
  for (const [label, id] of rows) {
    const text = typeof id === "string" ? id : JSON.stringify(id) ?? String(id);
    if (seen.has(text)) continue;
    seen.add(text);
    if (typeof id === "string" && IMPORT_ENTITY_ID_PATTERN.test(id)) continue;
    diagnostics.push({
      code: "CCC_PLANNING_GRAPH_INADMISSIBLE",
      message: `import shape: rule import-entity-id: ${label} ${text}: ${typeof id === "string" ? `${id.length} characters, ` : ""}`
        + "not a letter or digit followed by at most 191 letters, digits, dots, underscores, colons or hyphens;"
        + " the importer refuses the bundle for it (assertCccPrdImportBundle, import-admission.ts:22, :113-125)",
    });
  }
  return diagnostics;
}

type ProofGraphTask = Readonly<{ id: string; requirementIds: readonly string[]; proofIds: readonly string[]; workflowId: unknown }>;
type ProofGraphProof = Readonly<{ id: string; phases: readonly string[]; requirementIds: readonly string[]; clauseIds: readonly string[] }>;

function records(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter((row): row is Record<string, unknown> => row !== null && typeof row === "object") : [];
}

/**
 * The importer's semantic proof plan (`semanticV2WorkflowProofPlan`, importer.ts:660-762) over the proposal: workflow gating,
 * task-phase proof ownership, requirement and clause custody, a task-phase proof per task and final clause coverage. Pure.
 */
export function diagnoseCccPlanningProofGraph(proposal: CccPrdAuthoringProposalV2): CccPrdDiagnostic[] {
  const diagnostics: CccPrdDiagnostic[] = [];
  const refuse = (rule: string, subject: string, text: string) => diagnostics.push({
    code: "CCC_PLANNING_GRAPH_INADMISSIBLE",
    message: `proof graph: rule ${rule}: ${subject}: ${text}`,
  });
  const tasks: ProofGraphTask[] = records(proposal.tasks).map((task) => ({
    id: String(task.id), requirementIds: stringEntries(task.requirementIds), proofIds: stringEntries(task.proofIds), workflowId: task.workflowId,
  }));
  const proofs: ProofGraphProof[] = records(proposal.proofs).map((proof) => ({
    id: String(proof.id), phases: stringEntries(proof.phases), requirementIds: stringEntries(proof.requirementIds), clauseIds: stringEntries(proof.clauseIds),
  }));
  const requirements = records(proposal.requirements).map((requirement) => ({
    id: String(requirement.id),
    clauses: records(requirement.acceptanceClauses).map((clause) => ({ id: String(clause.id), proofIds: stringEntries(clause.proofIds) })),
  }));

  for (const workflow of records(proposal.workflows)) {
    const listed = stringEntries(workflow.taskIds);
    const gated = new Set(listed);
    if (gated.size !== listed.length || gated.size !== tasks.length || tasks.some((task) => !gated.has(task.id) || task.workflowId !== workflow.id)) {
      refuse("workflow-gates-every-task", `workflow ${String(workflow.id)}`,
        `gates tasks ${listed.join(", ") || "none"} but the proposal's tasks are ${tasks.map(({ id }) => id).join(", ") || "none"};`
        + " the importer's proof plan needs one workflow gating every task exactly once (importer.ts:664-675)");
    }
  }

  const proofById = new Map(proofs.map((proof) => [proof.id, proof]));
  const isTaskPhase = (proofId: string) => proofById.get(proofId)?.phases.includes("task") === true;
  const requirementOfClause = new Map(requirements.flatMap((requirement) => requirement.clauses.map((clause) => [clause.id, requirement.id] as const)));
  for (const proof of proofs) {
    if (!proof.phases.includes("task")) continue;
    const owners = tasks.filter((task) => task.proofIds.includes(proof.id));
    if (owners.length !== 1) {
      refuse("task-proof-one-owner", `proof ${proof.id}`,
        `is a task-phase proof named by ${owners.length} tasks (${owners.map(({ id }) => id).join(", ") || "none"});`
        + " the importer's proof plan needs exactly one owning task (importer.ts:699-706)");
      continue;
    }
    const owner = owners[0]!;
    for (const requirementId of proof.requirementIds) {
      if (!owner.requirementIds.includes(requirementId)) {
        refuse("task-proof-requirement-owned", `proof ${proof.id}`,
          `covers requirement ${requirementId}, which its one owning task ${owner.id} does not claim (${owner.requirementIds.join(", ") || "none"});`
          + " the importer's proof plan refuses a task-phase proof outside its task (importer.ts:707-714)");
      }
      const foreign = tasks.find((task) => task.id !== owner.id && task.requirementIds.includes(requirementId));
      if (foreign !== undefined) {
        refuse("task-proof-requirement-exclusive", `proof ${proof.id}`,
          `covers requirement ${requirementId}, which task ${foreign.id} claims as well as its owning task ${owner.id};`
          + " the importer's proof plan refuses a task-phase proof over a cross-task requirement (importer.ts:715-722)");
      }
    }
    for (const clauseId of proof.clauseIds) {
      const requirementId = requirementOfClause.get(clauseId);
      if (requirementId === undefined) {
        refuse("task-proof-clause-owned", `proof ${proof.id}`,
          `references clause ${clauseId}, which no requirement declares; the importer's proof plan refuses it (importer.ts:724-730)`);
      } else if (!owner.requirementIds.includes(requirementId)) {
        refuse("task-proof-clause-owned", `proof ${proof.id}`,
          `covers clause ${clauseId} of requirement ${requirementId}, outside its owning task ${owner.id};`
          + " the importer's proof plan refuses it (importer.ts:731-735)");
      }
    }
  }

  for (const task of tasks) {
    if (task.proofIds.some(isTaskPhase)) continue;
    refuse("task-has-task-proof", `task ${task.id}`,
      `names no task-phase proof (proofs ${task.proofIds.join(", ") || "none"}); IB1 gives the task phase only to a proof no other task names,`
      + ` and the importer refuses the plan: "CCC PRD semantic task ${task.id} requires at least one task-phase proof" (importer.ts:742-748)`);
  }

  for (const requirement of requirements) {
    for (const clause of requirement.clauses) {
      const covered = clause.proofIds.some((proofId) => {
        const proof = proofById.get(proofId);
        return proof !== undefined && proof.phases.includes("final_integrated") && proof.clauseIds.includes(clause.id);
      });
      if (!covered) {
        refuse("clause-final-coverage", `clause ${clause.id}`,
          `of requirement ${requirement.id} has no final_integrated proof among ${clause.proofIds.join(", ") || "none"} whose clauses include it;`
          + " the importer's proof plan refuses it (importer.ts:752-764)");
      }
    }
  }
  return diagnostics;
}

/** The importer's two execution-policy route rules for each task's write roots (canonical.ts parseProductRoute). */
function writeRootRouteDiagnostics(
  proposal: CccPrdAuthoringProposalV2,
  target: Readonly<{ root: string; admitted: readonly string[] }> | null,
): CccPrdDiagnostic[] {
  const diagnostics: CccPrdDiagnostic[] = [];
  const refuse = (rule: "write-root-within-owned" | "write-root-admitted", taskId: string, path: string, text: string) => diagnostics.push({
    code: "CCC_PLANNING_GRAPH_INADMISSIBLE",
    message: `import shape: rule ${rule}: task ${taskId}: path ${path}: ${text}`,
  });
  for (const task of Array.isArray(proposal.tasks) ? proposal.tasks : []) {
    const owned = stringEntries(task.ownedPaths);
    for (const writeRoot of new Set(stringEntries(task.allowedWriteRoots))) {
      if (!owned.some((ownedPath) => writeRoot === ownedPath || writeRoot.startsWith(`${ownedPath}/`))) {
        refuse("write-root-within-owned", task.id, writeRoot,
          `is not, as an exact string, one of the task's owned paths (${owned.join(", ") || "none"}) or inside one;`
          + " the importer's execution policy refuses it as outside task ownership (canonical.ts parseProductRoute)");
      }
      if (target === null) continue;
      const absolute = resolve(target.root, writeRoot);
      if (!target.admitted.some((admittedRoot) => isContainedPath(admittedRoot, absolute))) {
        refuse("write-root-admitted", task.id, writeRoot,
          `resolves to ${absolute}, outside the PRD-admitted write roots (${target.admitted.join(", ") || "none"});`
          + " the importer's execution policy refuses it (canonical.ts parseProductRoute, filesystemPathContains)");
      }
    }
  }
  return diagnostics;
}

/** The importer's write-root, route-custody and bounds admission, applied to the proposal before review. Pure. */
export function diagnoseCccPlanningImportShape(proposal: CccPrdAuthoringProposalV2): CccPrdDiagnostic[] {
  const diagnostics: CccPrdDiagnostic[] = [];
  const root = typeof proposal.targetRepository?.path === "string" ? proposal.targetRepository.path : "";
  let target: Readonly<{ root: string; admitted: readonly string[] }> | null = null;
  if (!isAbsolute(root)) {
    diagnostics.push({
      code: "CCC_PLANNING_GRAPH_INADMISSIBLE",
      message: `import shape: the target repository path ${JSON.stringify(root)} is not absolute`,
    });
  } else {
    const resolvedRoot = resolve(root);
    for (const { path } of proposal.admittedWriteRoots ?? []) {
      if (typeof path === "string" && isAbsolute(path)) continue;
      diagnostics.push({
        code: "CCC_PLANNING_GRAPH_INADMISSIBLE",
        message: `import shape: rule admitted-root-absolute: path ${String(path)}: a PRD-admitted write root must be absolute;`
          + " the importer resolves a relative one against its own working directory, not the target (import-admission.ts, canonical.ts parseProductRoute)",
      });
    }
    const admitted = (proposal.admittedWriteRoots ?? []).map(({ path }) => resolve(resolvedRoot, path));
    target = { root: resolvedRoot, admitted };
    for (const output of [join(resolvedRoot, ".fusion", "tasks"), join(resolvedRoot, ".fusion", "artifacts")]) {
      if (!admitted.some((candidate) => isContainedPath(candidate, output))) {
        diagnostics.push({
          code: "CCC_PLANNING_GRAPH_INADMISSIBLE",
          message: `import shape: ${output} is outside the admitted write roots (${admitted.join(", ") || "none"}); the importer writes .fusion/tasks and .fusion/artifacts there`,
        });
      }
    }
  }
  diagnostics.push(...writeRootRouteDiagnostics(proposal, target));
  for (const [name, ceiling] of Object.entries(IMPORT_BOUND_CEILINGS) as Array<[keyof typeof IMPORT_BOUND_CEILINGS, number]>) {
    const value = proposal.bounds?.[name];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > ceiling) {
      diagnostics.push({
        code: "CCC_PLANNING_GRAPH_INADMISSIBLE",
        message: `import shape: bounds.${name} ${JSON.stringify(value)} must be an integer from 1 to ${ceiling}`,
      });
    }
  }
  return diagnostics;
}
