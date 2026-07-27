import type { CccPrdSemanticBundle } from "@fusion/core";
import {
  createCccPrdImportTestBundle,
  rehashCccPrdImportTestBundle,
} from "../../../../../core/src/__test-utils__/ccc-prd-import-fixture.js";

export type JoinedLocalCampaignScenario = Readonly<{
  bundle: CccPrdSemanticBundle;
  taskIds: Readonly<{ a: string; b: string; c: string; d: string }>;
  actions: Readonly<{
    liveExecution: Readonly<{
      a: Readonly<{ actionId: string; actionTarget: string; requireProtected: true }>;
      b: Readonly<{ actionId: string; actionTarget: string; requireProtected: true }>;
      c: Readonly<{ actionId: string; actionTarget: string; requireProtected: true }>;
      d: Readonly<{ actionId: string; actionTarget: string; requireProtected: true }>;
    }>;
    merge: Readonly<{ actionId: string; actionTarget: "refs/heads/main"; requireProtected: true }>;
  }>;
  scopedExtension: Readonly<{
    pluginId: string;
    extensionId: "scoped-provider";
    registryId: string;
  }>;
  routes: ReadonlyArray<{
    taskId: string;
    providerId: string;
    modelId: string;
    transport: "pi" | "workflow";
    workflowExtensionId?: string;
  }>;
}>;

/** Builds the smallest importer-owned A -> B,C -> D campaign topology. */
export function createJoinedLocalCampaignScenario(
  rootDir: string,
  suffix: string,
  baseCommit: string,
): JoinedLocalCampaignScenario {
  const source = createCccPrdImportTestBundle(rootDir, suffix);
  const [taskA, taskD] = source.tasks;
  if (!taskA || !taskD) throw new Error("joined local campaign source fixture is incomplete");
  const workflow = source.workflows[0];
  if (!workflow) throw new Error("joined local campaign workflow fixture is missing");

  const taskB = {
    ...taskD,
    id: `TASK-${suffix}-B`,
    title: "Joined local campaign branch B",
    description: "Deterministic Pi branch.",
    dependencyTaskIds: [taskA.id],
    documentIds: [],
    artifactIds: [],
  };
  const taskC = {
    ...taskD,
    id: `TASK-${suffix}-C`,
    title: "Joined local campaign branch C",
    description: "Deterministic scoped-provider branch.",
    dependencyTaskIds: [taskA.id],
    documentIds: [],
    artifactIds: [],
  };
  const taskIds = Object.freeze({ a: taskA.id, b: taskB.id, c: taskC.id, d: taskD.id });
  const actions = Object.freeze({
    liveExecution: Object.freeze({
      a: Object.freeze({ actionId: `ACTION-${suffix}-A-LIVE`, actionTarget: `ccc-local:${suffix}:a`, requireProtected: true as const }),
      b: Object.freeze({ actionId: `ACTION-${suffix}-B-LIVE`, actionTarget: `ccc-local:${suffix}:b`, requireProtected: true as const }),
      c: Object.freeze({ actionId: `ACTION-${suffix}-C-LIVE`, actionTarget: `ccc-local:${suffix}:c`, requireProtected: true as const }),
      d: Object.freeze({ actionId: `ACTION-${suffix}-D-LIVE`, actionTarget: `ccc-local:${suffix}:d`, requireProtected: true as const }),
    }),
    merge: Object.freeze({
      actionId: `ACTION-${suffix}-MERGE`,
      actionTarget: "refs/heads/main" as const,
      requireProtected: true as const,
    }),
  });
  const scopedExtension = Object.freeze({
    pluginId: `ccc-local-${suffix}`,
    extensionId: "scoped-provider" as const,
    registryId: `plugin:ccc-local-${suffix}:scoped-provider`,
  });
  const routes = Object.freeze([
    { taskId: taskIds.a, providerId: "local-pi-a", modelId: "pi-fixture-a", transport: "pi" as const },
    { taskId: taskIds.b, providerId: "local-pi-b", modelId: "pi-fixture-b", transport: "pi" as const },
    { taskId: taskIds.c, providerId: "local-scoped-c", modelId: "workflow-fixture-c", transport: "workflow" as const, workflowExtensionId: scopedExtension.registryId },
    { taskId: taskIds.d, providerId: "local-pi-d", modelId: "pi-fixture-d", transport: "pi" as const },
  ]);
  const edgeIds = Object.freeze({
    bFromA: `EDGE-${suffix}-B-A`,
    cFromA: `EDGE-${suffix}-C-A`,
    dFromB: `EDGE-${suffix}-D-B`,
    dFromC: `EDGE-${suffix}-D-C`,
  });

  return Object.freeze({
    taskIds,
    actions,
    scopedExtension,
    routes,
    bundle: rehashCccPrdImportTestBundle({
      ...source,
      targetRepository: { path: rootDir, baseCommit },
      bounds: { maxRequests: 4, maxDurationMs: 60_000, maxConcurrency: 2 },
      tasks: [
        { ...taskA, dependencyTaskIds: [], protectedActionIds: [actions.liveExecution.a.actionId] },
        { ...taskB, workflowId: workflow.id, protectedActionIds: [actions.liveExecution.b.actionId] },
        { ...taskC, workflowId: workflow.id, protectedActionIds: [actions.liveExecution.c.actionId] },
        { ...taskD, dependencyTaskIds: [taskB.id, taskC.id], protectedActionIds: [actions.liveExecution.d.actionId, actions.merge.actionId] },
      ],
      edges: [
        { id: edgeIds.bFromA, fromTaskId: taskB.id, toTaskId: taskA.id, kind: "depends_on" as const },
        { id: edgeIds.cFromA, fromTaskId: taskC.id, toTaskId: taskA.id, kind: "depends_on" as const },
        { id: edgeIds.dFromB, fromTaskId: taskD.id, toTaskId: taskB.id, kind: "depends_on" as const },
        { id: edgeIds.dFromC, fromTaskId: taskD.id, toTaskId: taskC.id, kind: "depends_on" as const },
      ],
      workflows: [{
        ...workflow,
        taskIds: [taskA.id, taskB.id, taskC.id, taskD.id],
        entryTaskIds: [taskA.id],
        terminalTaskIds: [taskD.id],
      }],
      protectedActions: [
        ...Object.entries(actions.liveExecution).map(([taskKey, action]) => ({
          id: action.actionId,
          kind: "live_execution" as const,
          target: action.actionTarget,
          requiresOperatorDecision: true,
          operatorDecision: "approve_live_execution" as const,
          spans: [{ a: taskA, b: taskB, c: taskC, d: taskD }[taskKey as "a" | "b" | "c" | "d"].spans[0]!],
        })),
      {
        id: actions.merge.actionId,
        kind: "merge" as const,
        target: actions.merge.actionTarget,
        requiresOperatorDecision: true,
        operatorDecision: "approve_merge" as const,
        spans: [taskD.spans[0]!],
      }],
      importIntents: [
        ...source.importIntents.filter((intent) => intent.entityType !== "task" && intent.entityType !== "dependency_edge"),
        ...Object.values(taskIds).map((entityId) => ({ id: entityId, entityType: "task" as const, entityId, operation: "create" as const, target: rootDir })),
        ...Object.values(edgeIds).map((entityId) => ({ id: entityId, entityType: "dependency_edge" as const, entityId, operation: "create" as const, target: rootDir })),
      ],
    }),
  });
}
