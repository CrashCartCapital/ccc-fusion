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

function isContainedPath(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/** The importer's write-root and bounds admission, applied to the proposal before review. Pure. */
export function diagnoseCccPlanningImportShape(proposal: CccPrdAuthoringProposalV2): CccPrdDiagnostic[] {
  const diagnostics: CccPrdDiagnostic[] = [];
  const root = typeof proposal.targetRepository?.path === "string" ? proposal.targetRepository.path : "";
  if (!isAbsolute(root)) {
    diagnostics.push({
      code: "CCC_PLANNING_GRAPH_INADMISSIBLE",
      message: `import shape: the target repository path ${JSON.stringify(root)} is not absolute`,
    });
  } else {
    const resolvedRoot = resolve(root);
    const admitted = (proposal.admittedWriteRoots ?? []).map(({ path }) => resolve(resolvedRoot, path));
    for (const output of [join(resolvedRoot, ".fusion", "tasks"), join(resolvedRoot, ".fusion", "artifacts")]) {
      if (!admitted.some((candidate) => isContainedPath(candidate, output))) {
        diagnostics.push({
          code: "CCC_PLANNING_GRAPH_INADMISSIBLE",
          message: `import shape: ${output} is outside the admitted write roots (${admitted.join(", ") || "none"}); the importer writes .fusion/tasks and .fusion/artifacts there`,
        });
      }
    }
  }
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
