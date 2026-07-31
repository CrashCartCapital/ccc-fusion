import { createHash, randomUUID } from "node:crypto";
import {
  access,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
import * as schema from "../postgres/schema/index.js";
import type { AsyncDataLayer, DbTransaction } from "../postgres/data-layer.js";
import { recordRunAuditEventWithinTransaction } from "../postgres/data-layer.js";
import type { TaskStore } from "../store.js";
import { insertTaskRowInTransaction } from "../task-store/async-persistence.js";
import { allocateCommittedTaskIdsInTransaction } from "../task-store/async-allocator.js";
import type { Task } from "../types.js";
import { createCccCampaignManifest, hashCccCampaignManifest, parseCccCampaignExecutionPolicy } from "../ccc-campaign/canonical.js";
import { reconstructCccCampaignCustody } from "../ccc-campaign/custody.js";
import type { CccCampaignExecutionPolicy, CccCampaignManifest } from "../ccc-campaign/types.js";
import { canonicalCccPrdJson } from "./contract.js";
import {
  assertCccPrdImportBundle,
  CCC_PRD_IMPORT_WRITER_CLASSES,
  physicalCccPrdImportRoot,
} from "./import-admission.js";
import { CccPrdImportError } from "./import-error.js";
import {
  buildCccPrdProjection,
  buildCccPrdTaskExecutionPrompt,
  CCC_PRD_IMPORT_PREPARED_STATUS,
  nativeCccPrdScopedId,
  nativeCccPrdTaskId,
  preparedCccPrdTask,
  type CccPrdNativeTaskIds,
  type PreparedCccPrdProjection,
} from "./projection.js";
import type { CccPrdImportEntityType, CccPrdImportIntent, CccPrdSemanticBundle, CccPrdWorkflow } from "./types.js";
import { parseWorkflowIr } from "../workflow-ir.js";
import type { WorkflowIr, WorkflowIrEdge, WorkflowIrNode } from "../workflow-ir-types.js";

const STAGING_PREFIX = join(".fusion", "ccc-prd-import-staging");
const RETRYABLE_SQLSTATES = new Set(["40001", "40P01"]);

export type CccPrdImportFailureCheckpoint =
  | CccPrdImportEntityType
  | "after_prepared_db_commit"
  | "task_directory"
  | "task_json"
  | "prompt"
  | "artifact_bytes"
  | "after_projection_claim"
  | "canonical_projection_move"
  | "before_activation"
  | "activation_handoff"
  | "after_activation"
  | "lost_response_after_commit";

export type CccPrdImportState = "prepared" | "projecting" | "active";

export type CccPrdImportTransactionWitness = {
  transactionId: string;
  writerClasses: CccPrdImportEntityType[];
};

export type CccPrdImportTransactionProbe = {
  onPrepareTransaction(tx: DbTransaction): void;
  onWriter(writerClass: CccPrdImportEntityType, tx: DbTransaction): void;
  onPrepareComplete(tx: DbTransaction): void;
};

export type CccPrdImportDirectCounts = {
  campaigns: number;
  tasks: number;
  dependencyEdges: number;
  workflows: number;
  documents: number;
  artifacts: number;
  sources: number;
  workItems: number;
  runAudits: number;
};

export type CccPrdImportInspection = {
  importId: string;
  idempotencyKey: string;
  bundleHash: string;
  identityHash: string;
  targetRepository: string;
  targetBase: string;
  state: CccPrdImportState;
  runnable: boolean;
  stagingRelativePath: string;
  transactionWitness: CccPrdImportTransactionWitness;
  directCounts: CccPrdImportDirectCounts;
};

export type CccPrdImportResult = CccPrdImportInspection & {
  replayed: boolean;
};

export type ImportCccPrdBundleInput = {
  bundle: CccPrdSemanticBundle;
  executionPolicy: CccCampaignExecutionPolicy;
  idempotencyKey: string;
  store: TaskStore;
  layer: AsyncDataLayer;
  rootDir: string;
  failureInjection?: {
    checkpoint?: CccPrdImportFailureCheckpoint;
    projectionLeaseMs?: number;
    reconciliationOverheadMs?: number;
    pause?: {
      checkpoint: CccPrdImportFailureCheckpoint;
      entered?: () => void;
      until: Promise<void>;
    };
  };
  transactionProbe?: CccPrdImportTransactionProbe;
};

export type ReconcileCccPrdImportInput = {
  idempotencyKey: string;
  store: TaskStore;
  layer: AsyncDataLayer;
  rootDir: string;
};

export type InspectCccPrdImportInput = {
  idempotencyKey: string;
  layer: AsyncDataLayer;
  rootDir: string;
};

type ImportRow = {
  projectId: string;
  idempotencyKey: string;
  importId: string;
  identityHash: string;
  bundleHash: string;
  packetHash: string;
  sidecarHash: string;
  sourceVersion: string;
  targetRepository: string;
  targetBase: string;
  rootDir: string;
  stagingRelativePath: string;
  state: CccPrdImportState;
  runnable: number;
  canonicalBundle: CccPrdSemanticBundle;
  transactionWitness: CccPrdImportTransactionWitness;
  projectionDigest: string;
  projectionOwner: string | null;
  projectionLeaseUntil: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  activatedAt: string | null;
  executionPolicy: CccCampaignExecutionPolicy;
  campaignManifest: CccCampaignManifest;
  campaignManifestHash: string;
  campaignStartedAt: string;
  campaignDeadlineAt: string;
  requestCount: number;
  activeActionLeases: Record<string, unknown>;
};

type CccCampaignImportIdentity = {
  executionPolicy: CccCampaignExecutionPolicy;
  manifest: CccCampaignManifest;
  manifestHash: string;
};

type ImportTransactionWitnessRecorder = {
  readonly transactionId: string;
  readonly tx: DbTransaction;
  readonly observedWriterClasses: CccPrdImportEntityType[];
  readonly probe?: CccPrdImportTransactionProbe;
};

export { CccPrdImportError } from "./import-error.js";

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function projectIdFor(layer: AsyncDataLayer): string {
  return layer.projectId?.trim() || "__legacy_unscoped__";
}

function isContainedPath(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

async function inject(
  failureInjection: ImportCccPrdBundleInput["failureInjection"] | undefined,
  checkpoint: CccPrdImportFailureCheckpoint,
): Promise<void> {
  if (failureInjection?.pause?.checkpoint === checkpoint) {
    failureInjection.pause.entered?.();
    await failureInjection.pause.until;
  }
  if (failureInjection?.checkpoint !== checkpoint) return;
  if (checkpoint === "lost_response_after_commit") {
    throw new CccPrdImportError(
      "CCC_PRD_IMPORT_LOST_RESPONSE",
      "Injected lost response after CCC PRD import commit",
    );
  }
  throw new CccPrdImportError(
    "CCC_PRD_IMPORT_INJECTED_FAILURE",
    `Injected CCC PRD import failure after ${checkpoint}`,
  );
}

function importIdFor(projectId: string, idempotencyKey: string): string {
  return `ccc-prd-${sha256(`${projectId}\0${idempotencyKey}`).slice(0, 32)}`;
}

function reconciliationAllowance(
  failureInjection?: ImportCccPrdBundleInput["failureInjection"],
): number {
  const value = failureInjection?.reconciliationOverheadMs ?? 5_000;
  if (!Number.isFinite(value) || value < 0) {
    throw new CccPrdImportError(
      "CCC_PRD_IMPORT_INVALID_FAILURE_INJECTION",
      "CCC PRD reconciliation overhead test override must be finite and non-negative",
    );
  }
  return value;
}

function intentRows(bundle: CccPrdSemanticBundle, entityType: CccPrdImportEntityType): CccPrdImportIntent[] {
  return bundle.importIntents.filter((intent) => intent.entityType === entityType);
}

function contentDigest(value: unknown): string {
  return sha256(canonicalCccPrdJson(value));
}

function observeWriter(
  recorder: ImportTransactionWitnessRecorder,
  writerClass: CccPrdImportEntityType,
  tx: DbTransaction,
): void {
  if (tx !== recorder.tx) {
    throw new CccPrdImportError(
      "CCC_PRD_IMPORT_TRANSACTION_VIOLATION",
      `CCC PRD ${writerClass} writer received a different database transaction`,
    );
  }
  if (recorder.observedWriterClasses.includes(writerClass)) {
    throw new CccPrdImportError(
      "CCC_PRD_IMPORT_TRANSACTION_VIOLATION",
      `CCC PRD ${writerClass} writer was invoked more than once`,
    );
  }
  recorder.observedWriterClasses.push(writerClass);
  recorder.probe?.onWriter(writerClass, tx);
}

async function insertEntityLedger(
  tx: DbTransaction,
  projectId: string,
  importId: string,
  entityType: CccPrdImportEntityType,
  entries: Array<{ intent: CccPrdImportIntent; nativeId: string; value: unknown }>,
): Promise<void> {
  for (const [ordinal, entry] of entries.entries()) {
    await tx.insert(schema.project.cccPrdImportEntities).values({
      projectId,
      importId,
      entityType,
      entityId: entry.intent.entityId,
      nativeId: entry.nativeId,
      ordinal,
      contentDigest: contentDigest(entry.value),
    });
  }
}

function oneIntent(bundle: CccPrdSemanticBundle, type: CccPrdImportEntityType): CccPrdImportIntent {
  const intents = intentRows(bundle, type);
  if (intents.length !== 1) {
    throw new CccPrdImportError(
      "CCC_PRD_IMPORT_INVALID_BUNDLE",
      `CCC PRD bundle requires exactly one ${type} intent; received ${intents.length}`,
    );
  }
  return intents[0]!;
}

async function writeCampaign(
  tx: DbTransaction,
  recorder: ImportTransactionWitnessRecorder,
  bundle: CccPrdSemanticBundle,
  projectId: string,
  importId: string,
  now: string,
): Promise<string> {
  observeWriter(recorder, "campaign", tx);
  const intent = oneIntent(bundle, "campaign");
  const nativeCampaignId = nativeCccPrdScopedId(importId, intent.entityId);
  await tx.insert(schema.project.missions).values({
    projectId,
    id: nativeCampaignId,
    title: `CCC PRD ${bundle.sourceVersion}`,
    description: `Generated import of ${bundle.sourceHash}`,
    status: "draft",
    interviewState: "complete",
    baseBranch: bundle.targetRepository.baseCommit,
    branchStrategy: "ccc-prd-import",
    autoAdvance: 0,
    autoMerge: 0,
    autopilotEnabled: 0,
    autopilotState: "inactive",
    createdAt: now,
    updatedAt: now,
  });
  await insertEntityLedger(tx, projectId, importId, "campaign", [{
    intent,
    nativeId: nativeCampaignId,
    value: { intent, sourceVersion: bundle.sourceVersion },
  }]);
  return nativeCampaignId;
}

async function allocateNativeTaskIds(
  tx: DbTransaction,
  bundle: CccPrdSemanticBundle,
  projectId: string,
  importId: string,
  now: string,
): Promise<CccPrdNativeTaskIds> {
  const intents = intentRows(bundle, "task");
  if (intents.length !== bundle.tasks.length) {
    throw new CccPrdImportError(
      "CCC_PRD_IMPORT_INVALID_BUNDLE",
      `CCC PRD task intent count ${intents.length} does not match task count ${bundle.tasks.length}`,
    );
  }
  const semanticTaskIds = new Set(bundle.tasks.map(({ id }) => id));
  if (
    semanticTaskIds.size !== bundle.tasks.length
    || intents.some(({ entityId }) => !semanticTaskIds.has(entityId))
    || new Set(intents.map(({ entityId }) => entityId)).size !== intents.length
  ) {
    throw new CccPrdImportError(
      "CCC_PRD_IMPORT_INVALID_BUNDLE",
      "CCC PRD task intents do not map one-to-one onto semantic tasks",
    );
  }
  const allocated = await allocateCommittedTaskIdsInTransaction(tx, {
    projectId,
    nodeId: `ccc-prd-import:${importId}`,
    count: intents.length,
    now,
  });
  return new Map(
    intents.map((intent, index) => [intent.entityId, allocated[index]!]),
  );
}

async function writeTasks(
  tx: DbTransaction,
  recorder: ImportTransactionWitnessRecorder,
  bundle: CccPrdSemanticBundle,
  projectId: string,
  importId: string,
  missionId: string,
  identityHash: string,
  executionPolicy: CccCampaignExecutionPolicy,
  store: TaskStore,
  now: string,
  nativeTaskIds: CccPrdNativeTaskIds,
): Promise<Array<Task & { state: "prepared"; runnable: false }>> {
  observeWriter(recorder, "task", tx);
  const byId = new Map(bundle.tasks.map((task) => [task.id, task]));
  const intents = intentRows(bundle, "task");
  if (intents.length !== bundle.tasks.length) {
    throw new CccPrdImportError(
      "CCC_PRD_IMPORT_INVALID_BUNDLE",
      `CCC PRD task intent count ${intents.length} does not match task count ${bundle.tasks.length}`,
    );
  }
  const tasks: Array<Task & { state: "prepared"; runnable: false }> = [];
  const ledger: Array<{ intent: CccPrdImportIntent; nativeId: string; value: unknown }> = [];
  const routes = new Map(executionPolicy.routes.map((route) => [route.taskId, route]));
  for (const intent of intents) {
    const source = byId.get(intent.entityId);
    if (!source) {
      throw new CccPrdImportError(
        "CCC_PRD_IMPORT_INVALID_BUNDLE",
        `CCC PRD task intent references unknown task ${intent.entityId}`,
      );
    }
    const route = routes.get(source.id);
    if (!route) {
      throw new CccPrdImportError(
        "CCC_PRD_EXECUTION_ROUTE_REFUSED",
        `CCC campaign execution route disappeared for task ${source.id}`,
      );
    }
    const task = preparedCccPrdTask(
      source,
      missionId,
      identityHash,
      bundle.bundleHash,
      bundle.targetRepository.baseCommit,
      route,
      now,
      nativeTaskIds,
    );
    await insertTaskRowInTransaction(
      tx,
      task as unknown as Record<string, unknown>,
      store.createTaskPersistSerializationContext(task),
      projectId,
    );
    tasks.push(task);
    ledger.push({ intent, nativeId: task.id, value: source });
  }
  await insertEntityLedger(tx, projectId, importId, "task", ledger);
  return tasks;
}

async function writeDependencyEdges(
  tx: DbTransaction,
  recorder: ImportTransactionWitnessRecorder,
  bundle: CccPrdSemanticBundle,
  projectId: string,
  importId: string,
  nativeTaskIds: CccPrdNativeTaskIds,
): Promise<void> {
  observeWriter(recorder, "dependency_edge", tx);
  const byId = new Map(bundle.edges.map((edge) => [edge.id, edge]));
  const intents = intentRows(bundle, "dependency_edge");
  if (intents.length !== bundle.edges.length) {
    throw new CccPrdImportError(
      "CCC_PRD_IMPORT_INVALID_BUNDLE",
      `CCC PRD dependency intent count ${intents.length} does not match edge count ${bundle.edges.length}`,
    );
  }
  for (const edge of bundle.edges) {
    const target = bundle.tasks.find(({ id }) => id === edge.fromTaskId);
    if (!target || !target.dependencyTaskIds.includes(edge.toTaskId)) {
      throw new CccPrdImportError(
        "CCC_PRD_IMPORT_INVALID_BUNDLE",
        `CCC PRD edge ${edge.id} is inconsistent with task dependency declarations`,
      );
    }
    await tx
      .update(schema.project.tasks)
      .set({
        dependencies: target.dependencyTaskIds.map((taskId) =>
          nativeCccPrdTaskId(taskId, nativeTaskIds)),
      })
      .where(and(
        eq(schema.project.tasks.projectId, projectId),
        eq(schema.project.tasks.id, nativeCccPrdTaskId(target.id, nativeTaskIds)),
      ));
  }
  await insertEntityLedger(
    tx,
    projectId,
    importId,
    "dependency_edge",
    intents.map((intent) => {
      const edge = byId.get(intent.entityId);
      if (!edge) {
        throw new CccPrdImportError(
          "CCC_PRD_IMPORT_INVALID_BUNDLE",
          `CCC PRD dependency intent references unknown edge ${intent.entityId}`,
        );
      }
      return {
        intent,
        nativeId: nativeCccPrdTaskId(edge.fromTaskId, nativeTaskIds),
        value: edge,
      };
    }),
  );
}

async function writeWorkflows(
  tx: DbTransaction,
  recorder: ImportTransactionWitnessRecorder,
  bundle: CccPrdSemanticBundle,
  executionPolicy: CccCampaignExecutionPolicy,
  projectId: string,
  importId: string,
  now: string,
  nativeTaskIds: CccPrdNativeTaskIds,
): Promise<void> {
  observeWriter(recorder, "workflow", tx);
  const byId = new Map(bundle.workflows.map((workflow) => [workflow.id, workflow]));
  const intents = intentRows(bundle, "workflow");
  if (intents.length !== bundle.workflows.length) {
    throw new CccPrdImportError(
      "CCC_PRD_IMPORT_INVALID_BUNDLE",
      `CCC PRD workflow intent count ${intents.length} does not match workflow count ${bundle.workflows.length}`,
    );
  }
  for (const workflow of bundle.workflows) {
    const nativeWorkflowId = nativeCccPrdScopedId(importId, workflow.id);
    await tx.insert(schema.project.workflows).values({
      id: nativeWorkflowId,
      name: workflow.title,
      description: `Generated from CCC PRD ${bundle.sourceVersion}`,
      ir: nativeWorkflowIr(bundle, workflow, executionPolicy, nativeTaskIds),
      layout: {},
      kind: "workflow",
      createdAt: now,
      updatedAt: now,
    });
    for (const taskId of workflow.taskIds) {
      await tx.insert(schema.project.taskWorkflowSelection).values({
        projectId,
        taskId: nativeCccPrdTaskId(taskId, nativeTaskIds),
        workflowId: nativeWorkflowId,
        stepIds: [],
        updatedAt: now,
      });
    }
  }
  await insertEntityLedger(
    tx,
    projectId,
    importId,
    "workflow",
    intents.map((intent) => {
      const workflow = byId.get(intent.entityId);
      if (!workflow) {
        throw new CccPrdImportError(
          "CCC_PRD_IMPORT_INVALID_BUNDLE",
          `CCC PRD workflow intent references unknown workflow ${intent.entityId}`,
        );
      }
      return { intent, nativeId: nativeCccPrdScopedId(importId, workflow.id), value: workflow };
    }),
  );
}

function nativeWorkflowTaskNodeId(taskId: string): string {
  return `ccc-task-${sha256(taskId).slice(0, 24)}`;
}

function nativeWorkflowSplitNodeId(taskId: string): string {
  return `ccc-split-${sha256(taskId).slice(0, 24)}`;
}

function nativeWorkflowJoinNodeId(taskId: string): string {
  return `ccc-join-${sha256(taskId).slice(0, 24)}`;
}

function nativeWorkflowMergeNodeId(workflowId: string, taskId: string): string {
  return `ccc-merge-${sha256(`${workflowId}\0${taskId}`).slice(0, 24)}`;
}

function nativeWorkflowProofNodeId(workflowId: string): string {
  return `ccc-proof-${sha256(workflowId).slice(0, 24)}`;
}

function nativeWorkflowProofJoinNodeId(workflowId: string): string {
  return `ccc-proof-join-${sha256(workflowId).slice(0, 24)}`;
}

function nativeWorkflowIr(
  bundle: CccPrdSemanticBundle,
  workflow: CccPrdWorkflow,
  executionPolicy: CccCampaignExecutionPolicy,
  nativeTaskIds: CccPrdNativeTaskIds,
): WorkflowIr {
  const taskById = new Map(bundle.tasks.map((task) => [task.id, task]));
  const routeByTaskId = new Map(executionPolicy.routes.map((route) => [route.taskId, route]));
  const mergeLanding = mergeLandingFor(bundle, workflow, taskById);
  const productExecution = executionPolicy.schema === "ccc-campaign.execution-policy.v2";
  if (productExecution && bundle.proofs.length === 0) {
    throw new CccPrdImportError(
      "CCC_PRD_IMPORT_INVALID_BUNDLE",
      `CCC PRD product workflow ${workflow.id} requires at least one proof`,
    );
  }
  if (productExecution && workflow.terminalTaskIds.length !== 1) {
    throw new CccPrdImportError(
      "CCC_PRD_IMPORT_INVALID_BUNDLE",
      `CCC PRD product workflow ${workflow.id} requires exactly one integration terminal task before final proof`,
    );
  }
  const proofTaskId = workflow.terminalTaskIds[0]!;
  const taskNodes: WorkflowIrNode[] = workflow.taskIds.map((taskId) => {
    const task = taskById.get(taskId);
    if (!task) {
      throw new CccPrdImportError(
        "CCC_PRD_IMPORT_INVALID_BUNDLE",
        `CCC PRD workflow ${workflow.id} references unknown task ${taskId}`,
      );
    }
    const route = routeByTaskId.get(task.id);
    if (!route) {
      throw new CccPrdImportError(
        "CCC_PRD_EXECUTION_ROUTE_REFUSED",
        `CCC campaign execution route disappeared for workflow task ${task.id}`,
      );
    }
    const executionPrompt = productExecution
      ? buildCccPrdTaskExecutionPrompt(bundle, task, route)
      : undefined;
    return {
      id: nativeWorkflowTaskNodeId(taskId),
      kind: "prompt",
      config: {
        name: task.title,
        prompt: executionPrompt?.content ?? task.description,
        cccPrdTaskId: task.id,
        cccNativeTaskId: nativeCccPrdTaskId(task.id, nativeTaskIds),
        gateMode: "gate",
        ...(productExecution
          ? {
            cccExecutionPromptSchema: executionPrompt!.schema,
            cccExecutionPromptSha256: executionPrompt!.sha256,
            cccExecutionTransport: route.transport,
            cccExecutionProviderId: route.providerId,
            cccExecutionModelId: route.modelId,
            cccExecutionRouteSha256: contentDigest(route),
            ...(route.workflowExtensionId
              ? { cccExecutionWorkflowExtensionId: route.workflowExtensionId }
              : {}),
            executor: route.executor,
            toolMode: route.toolMode,
            worktreeMode: route.worktreeMode,
            ownedPaths: [...(route.ownedPaths ?? [])],
            allowedWriteRoots: [...(route.allowedWriteRoots ?? [])],
            commitPolicy: route.commitPolicy,
            ...(route.transport === "cli" && route.cliAdapterId
              ? {
                cliAdapterId: route.cliAdapterId,
                cliSettings: {
                  profile: "ccc-fusion",
                  providerId: route.providerId,
                  model: route.modelId,
                },
              }
              : {}),
          }
          : {}),
      },
      ...(route.transport === "workflow"
        ? { extensions: { [route.workflowExtensionId!]: {} } }
        : {}),
    };
  });
  const dependencyEdges: WorkflowIrEdge[] = bundle.edges
    .filter((edge) =>
      workflow.taskIds.includes(edge.fromTaskId)
      && workflow.taskIds.includes(edge.toTaskId))
    .map((edge) => ({
      from: nativeWorkflowTaskNodeId(edge.toTaskId),
      to: nativeWorkflowTaskNodeId(edge.fromTaskId),
      condition: "success" as const,
    }));
  const outgoing = new Map<string, WorkflowIrEdge[]>();
  const incoming = new Map<string, WorkflowIrEdge[]>();
  for (const edge of dependencyEdges) {
    const from = outgoing.get(edge.from) ?? [];
    from.push(edge);
    outgoing.set(edge.from, from);
    const to = incoming.get(edge.to) ?? [];
    to.push(edge);
    incoming.set(edge.to, to);
  }
  const splitTaskIds = workflow.taskIds.filter((taskId) => (outgoing.get(nativeWorkflowTaskNodeId(taskId))?.length ?? 0) > 1);
  const joinTaskIds = workflow.taskIds.filter((taskId) => (incoming.get(nativeWorkflowTaskNodeId(taskId))?.length ?? 0) > 1);
  const splitByTaskNodeId = new Map(splitTaskIds.map((taskId) => [nativeWorkflowTaskNodeId(taskId), nativeWorkflowSplitNodeId(taskId)]));
  const joinByTaskNodeId = new Map(joinTaskIds.map((taskId) => [nativeWorkflowTaskNodeId(taskId), nativeWorkflowJoinNodeId(taskId)]));
  const topologyEdges: WorkflowIrEdge[] = dependencyEdges.map((edge) => ({
    ...edge,
    from: splitByTaskNodeId.get(edge.from) ?? edge.from,
    to: joinByTaskNodeId.get(edge.to) ?? edge.to,
  }));
  for (const [taskNodeId, splitNodeId] of splitByTaskNodeId) {
    topologyEdges.push({ from: taskNodeId, to: splitNodeId, condition: "success" });
  }
  for (const [taskNodeId, joinNodeId] of joinByTaskNodeId) {
    topologyEdges.push({ from: joinNodeId, to: taskNodeId, condition: "success" });
  }
  const proofNodeId = nativeWorkflowProofNodeId(workflow.id);
  const proofJoinNodeId = nativeWorkflowProofJoinNodeId(workflow.id);
  const requiresProofJoin = productExecution && workflow.terminalTaskIds.length > 1;
  const ir: WorkflowIr = {
    version: "v2",
    name: workflow.title,
    columns: [],
    nodes: [
      { id: "start", kind: "start" },
      ...taskNodes,
      ...splitTaskIds.map((taskId) => ({
        id: nativeWorkflowSplitNodeId(taskId),
        kind: "split" as const,
        config: {
          cccPrdTaskId: taskId,
          cccNativeTaskId: nativeCccPrdTaskId(taskId, nativeTaskIds),
        },
      })),
      ...joinTaskIds.map((taskId) => ({
        id: nativeWorkflowJoinNodeId(taskId),
        kind: "join" as const,
        config: {
          mode: "all",
          cccPrdTaskId: taskId,
          cccNativeTaskId: nativeCccPrdTaskId(taskId, nativeTaskIds),
        },
      })),
      ...(requiresProofJoin ? [{
        id: proofJoinNodeId,
        kind: "join" as const,
        config: { mode: "all", cccProofJoin: true },
      }] : []),
      ...(productExecution ? [{
        id: proofNodeId,
        kind: "gate" as const,
        config: {
          name: "CCC PRD proof suite",
          cccProofSuite: true,
          cccProofIds: bundle.proofs.map(({ id }) => id),
          cccPrdTaskIds: workflow.taskIds,
          cccNativeTaskIds: workflow.taskIds.map((taskId) =>
            nativeCccPrdTaskId(taskId, nativeTaskIds)),
          cccPrdTaskId: proofTaskId,
          cccNativeTaskId: nativeCccPrdTaskId(proofTaskId, nativeTaskIds),
          gateMode: "gate",
          toolMode: "readonly",
        },
      }] : []),
      ...(mergeLanding ? [{
        id: nativeWorkflowMergeNodeId(workflow.id, mergeLanding.taskId),
        kind: "prompt" as const,
        config: {
          seam: "merge",
          cccPrdTaskId: mergeLanding.taskId,
          cccNativeTaskId: nativeCccPrdTaskId(mergeLanding.taskId, nativeTaskIds),
        },
      }] : []),
      { id: "end", kind: "end" },
    ],
    edges: [
      ...workflow.entryTaskIds.map((taskId) => ({
        from: "start",
        to: nativeWorkflowTaskNodeId(taskId),
        condition: "success" as const,
      })),
      ...topologyEdges,
      ...(productExecution
        ? [
          ...workflow.terminalTaskIds.map((taskId) => ({
            from: nativeWorkflowTaskNodeId(taskId),
            to: requiresProofJoin ? proofJoinNodeId : proofNodeId,
            condition: "success" as const,
          })),
          ...(requiresProofJoin
            ? [{ from: proofJoinNodeId, to: proofNodeId, condition: "success" as const }]
            : []),
          {
            from: proofNodeId,
            to: mergeLanding
              ? nativeWorkflowMergeNodeId(workflow.id, mergeLanding.taskId)
              : "end",
            condition: "success" as const,
          },
          ...(mergeLanding ? [{
            from: nativeWorkflowMergeNodeId(workflow.id, mergeLanding.taskId),
            to: "end",
            condition: "success" as const,
          }] : []),
        ]
        : [
          ...workflow.terminalTaskIds.map((taskId) => ({
            from: nativeWorkflowTaskNodeId(taskId),
            to: mergeLanding?.taskId === taskId
              ? nativeWorkflowMergeNodeId(workflow.id, taskId)
              : "end",
            condition: "success" as const,
          })),
          ...(mergeLanding ? [{
            from: nativeWorkflowMergeNodeId(workflow.id, mergeLanding.taskId),
            to: "end",
            condition: "success" as const,
          }] : []),
        ]),
    ],
  };
  return parseWorkflowIr(ir);
}

function mergeLandingFor(
  bundle: CccPrdSemanticBundle,
  workflow: CccPrdWorkflow,
  taskById: ReadonlyMap<string, CccPrdSemanticBundle["tasks"][number]>,
): { taskId: string } | undefined {
  const protectedActionsById = new Map(bundle.protectedActions.map((action) => [action.id, action]));
  const mergeReferences = workflow.terminalTaskIds.flatMap((taskId) => {
    const task = taskById.get(taskId);
    if (!task) return [];
    return task.protectedActionIds.flatMap((actionId) => {
      const action = protectedActionsById.get(actionId);
      if (!action) {
        throw new CccPrdImportError(
          "CCC_PRD_IMPORT_INVALID_BUNDLE",
          `CCC PRD workflow ${workflow.id} terminal task ${taskId} references unknown protected action ${actionId}`,
        );
      }
      return action.kind === "merge" ? [{ taskId, actionId }] : [];
    });
  });
  if (mergeReferences.length === 0) return undefined;
  if (workflow.terminalTaskIds.length !== 1) {
    throw new CccPrdImportError(
      "CCC_PRD_IMPORT_INVALID_BUNDLE",
      `CCC PRD workflow ${workflow.id} has multiple terminal landing tasks for merge ${mergeReferences.map(({ actionId }) => actionId).sort().join(",")}`,
    );
  }
  const [landingTaskId] = workflow.terminalTaskIds;
  if (mergeReferences.length !== 1 || mergeReferences[0]!.taskId !== landingTaskId) {
    throw new CccPrdImportError(
      "CCC_PRD_IMPORT_INVALID_BUNDLE",
      `CCC PRD workflow ${workflow.id} terminal landing ${landingTaskId} must reference exactly one declared merge protected action`,
    );
  }
  return { taskId: landingTaskId! };
}

async function writeDocuments(
  tx: DbTransaction,
  recorder: ImportTransactionWitnessRecorder,
  bundle: CccPrdSemanticBundle,
  projectId: string,
  importId: string,
  now: string,
  nativeTaskIds: CccPrdNativeTaskIds,
): Promise<void> {
  observeWriter(recorder, "document", tx);
  const byId = new Map(bundle.documents.map((document) => [document.id, document]));
  const intents = intentRows(bundle, "document");
  if (intents.length !== bundle.documents.length) {
    throw new CccPrdImportError(
      "CCC_PRD_IMPORT_INVALID_BUNDLE",
      `CCC PRD document intent count ${intents.length} does not match document count ${bundle.documents.length}`,
    );
  }
  for (const document of bundle.documents) {
    const nativeDocumentId = nativeCccPrdScopedId(importId, document.id);
    await tx.insert(schema.project.taskDocuments).values({
      projectId,
      id: nativeDocumentId,
      taskId: nativeCccPrdTaskId(document.taskId, nativeTaskIds),
      key: document.key,
      content: document.content,
      revision: 1,
      author: "ccc-prd-import",
      metadata: {
        title: document.title,
        bundleHash: bundle.bundleHash,
      },
      createdAt: now,
      updatedAt: now,
    });
  }
  await insertEntityLedger(
    tx,
    projectId,
    importId,
    "document",
    intents.map((intent) => {
      const document = byId.get(intent.entityId);
      if (!document) {
        throw new CccPrdImportError(
          "CCC_PRD_IMPORT_INVALID_BUNDLE",
          `CCC PRD document intent references unknown document ${intent.entityId}`,
        );
      }
      return {
        intent,
        nativeId: nativeCccPrdScopedId(importId, document.id),
        value: document,
      };
    }),
  );
}

async function writeArtifacts(
  tx: DbTransaction,
  recorder: ImportTransactionWitnessRecorder,
  bundle: CccPrdSemanticBundle,
  projectId: string,
  importId: string,
  now: string,
  nativeTaskIds: CccPrdNativeTaskIds,
): Promise<void> {
  observeWriter(recorder, "artifact", tx);
  const byId = new Map(bundle.artifacts.map((artifact) => [artifact.id, artifact]));
  const intents = intentRows(bundle, "artifact");
  if (intents.length !== bundle.artifacts.length) {
    throw new CccPrdImportError(
      "CCC_PRD_IMPORT_INVALID_BUNDLE",
      `CCC PRD artifact intent count ${intents.length} does not match artifact count ${bundle.artifacts.length}`,
    );
  }
  for (const artifact of bundle.artifacts) {
    const nativeArtifactId = nativeCccPrdScopedId(importId, artifact.id);
    await tx.insert(schema.project.artifacts).values({
      id: nativeArtifactId,
      type: artifact.type,
      title: artifact.title,
      description: `CCC PRD artifact from ${bundle.sourceVersion}`,
      mimeType: artifact.mimeType,
      sizeBytes: Buffer.byteLength(artifact.content),
      uri: join(".fusion", "artifacts", nativeArtifactId),
      content: artifact.content,
      authorId: "ccc-prd-import",
      authorType: "system",
      taskId: nativeCccPrdTaskId(artifact.taskId, nativeTaskIds),
      metadata: {
        bundleHash: bundle.bundleHash,
        projectId,
        semanticTaskId: artifact.taskId,
      },
      createdAt: now,
      updatedAt: now,
    });
  }
  await insertEntityLedger(
    tx,
    projectId,
    importId,
    "artifact",
    intents.map((intent) => {
      const artifact = byId.get(intent.entityId);
      if (!artifact) {
        throw new CccPrdImportError(
          "CCC_PRD_IMPORT_INVALID_BUNDLE",
          `CCC PRD artifact intent references unknown artifact ${intent.entityId}`,
        );
      }
      return { intent, nativeId: nativeCccPrdScopedId(importId, artifact.id), value: artifact };
    }),
  );
}

async function writeSources(
  tx: DbTransaction,
  recorder: ImportTransactionWitnessRecorder,
  bundle: CccPrdSemanticBundle,
  projectId: string,
  importId: string,
): Promise<void> {
  observeWriter(recorder, "source", tx);
  const intent = oneIntent(bundle, "source");
  for (const [ordinal, source] of bundle.orderedSources.entries()) {
    await tx.insert(schema.project.cccPrdImportSources).values({
      projectId,
      importId,
      ordinal,
      path: source.path,
      role: source.role,
      authoritative: source.authoritative ? 1 : 0,
      rawSha256: source.sha256,
      byteLength: source.byteLength,
    });
  }
  await insertEntityLedger(tx, projectId, importId, "source", [{
    intent,
    nativeId: importId,
    value: bundle.orderedSources,
  }]);
}

async function writeWorkItems(
  tx: DbTransaction,
  recorder: ImportTransactionWitnessRecorder,
  bundle: CccPrdSemanticBundle,
  executionPolicy: CccCampaignExecutionPolicy,
  projectId: string,
  importId: string,
  now: string,
  nativeTaskIds: CccPrdNativeTaskIds,
): Promise<void> {
  observeWriter(recorder, "work_item", tx);
  const intents = intentRows(bundle, "work_item");
  const workflows = new Map(bundle.workflows.map((workflow) => [workflow.id, workflow]));
  const firstWorkflow = bundle.workflows[0];
  if (!firstWorkflow) {
    throw new CccPrdImportError("CCC_PRD_IMPORT_INVALID_BUNDLE", "CCC PRD bundle has no workflow for work item");
  }
  const ledger: Array<{ intent: CccPrdImportIntent; nativeId: string; value: unknown }> = [];
  for (const intent of intents) {
    const workflow = workflows.get(intent.entityId) ?? firstWorkflow;
    const taskId = workflow.entryTaskIds[0] ?? workflow.taskIds[0];
    if (!taskId) {
      throw new CccPrdImportError(
        "CCC_PRD_IMPORT_INVALID_BUNDLE",
        `CCC PRD workflow ${workflow.id} has no task for work item`,
      );
    }
    const nativeWorkItemId = nativeCccPrdScopedId(importId, intent.id);
    const ir = nativeWorkflowIr(bundle, workflow, executionPolicy, nativeTaskIds);
    await tx.insert(schema.project.workflowWorkItems).values({
      projectId,
      id: nativeWorkItemId,
      runId: `ccc-prd:${importId}`,
      taskId: nativeCccPrdTaskId(taskId, nativeTaskIds),
      nodeId: nativeWorkflowTaskNodeId(taskId),
      kind: "task",
      state: "held",
      attempt: 0,
      blockedReason: CCC_PRD_IMPORT_PREPARED_STATUS,
      stableWorkflowRunId: `ccc-prd:${importId}`,
      irHash: contentDigest(ir),
      createdAt: now,
      updatedAt: now,
    });
    ledger.push({ intent, nativeId: nativeWorkItemId, value: workflow });
  }
  await insertEntityLedger(tx, projectId, importId, "work_item", ledger);
}

async function writeRunAudit(
  tx: DbTransaction,
  recorder: ImportTransactionWitnessRecorder,
  bundle: CccPrdSemanticBundle,
  projectId: string,
  importId: string,
  now: string,
): Promise<void> {
  observeWriter(recorder, "run_audit", tx);
  const intent = oneIntent(bundle, "run_audit");
  const event = await recordRunAuditEventWithinTransaction(tx, {
    timestamp: now,
    agentId: "ccc-prd-import",
    runId: `ccc-prd:${importId}`,
    domain: "database",
    mutationType: "ccc-prd-import:prepared",
    target: bundle.targetRepository.path,
    metadata: {
      projectId,
      importId,
      bundleHash: bundle.bundleHash,
      packetHash: bundle.sourceHash,
      targetBase: bundle.targetRepository.baseCommit,
      state: "prepared",
    },
  });
  await insertEntityLedger(tx, projectId, importId, "run_audit", [{
    intent,
    nativeId: event.id,
    value: event,
  }]);
}

function isRetryableTransactionError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    const detail = current as { code?: unknown; constraint_name?: unknown; cause?: unknown };
    const code = String(detail.code ?? "");
    if (RETRYABLE_SQLSTATES.has(code)) return true;
    if (
      code === "23505"
      && (
        detail.constraint_name === "ccc_prd_imports_pkey"
        || detail.constraint_name === "ccc_prd_imports_project_import_unique"
      )
    ) {
      return true;
    }
    current = detail.cause;
  }
  return false;
}

function isPostgresLockTimeout(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    const detail = current as { code?: unknown; cause?: unknown };
    if (String(detail.code ?? "") === "55P03") return true;
    current = detail.cause;
  }
  return false;
}

async function serializable<T>(
  layer: AsyncDataLayer,
  operation: () => Promise<T>,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isRetryableTransactionError(error) || attempt === 2) throw error;
      lastError = error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function selectImportRow(
  db: AsyncDataLayer["db"] | DbTransaction,
  projectId: string,
  idempotencyKey: string,
): Promise<ImportRow | null> {
  const rows = await db
    .select()
    .from(schema.project.cccPrdImports)
    .where(and(
      eq(schema.project.cccPrdImports.projectId, projectId),
      eq(schema.project.cccPrdImports.idempotencyKey, idempotencyKey),
    ))
    .limit(1);
  return (rows[0] as ImportRow | undefined) ?? null;
}

async function loadNativeTaskIds(
  db: AsyncDataLayer["db"] | DbTransaction,
  row: Pick<ImportRow, "projectId" | "importId" | "canonicalBundle">,
): Promise<CccPrdNativeTaskIds> {
  const entities = await db
    .select({
      semanticTaskId: schema.project.cccPrdImportEntities.entityId,
      nativeTaskId: schema.project.cccPrdImportEntities.nativeId,
    })
    .from(schema.project.cccPrdImportEntities)
    .where(and(
      eq(schema.project.cccPrdImportEntities.projectId, row.projectId),
      eq(schema.project.cccPrdImportEntities.importId, row.importId),
      eq(schema.project.cccPrdImportEntities.entityType, "task"),
    ))
    .orderBy(schema.project.cccPrdImportEntities.ordinal);
  const expected = new Set(row.canonicalBundle.tasks.map(({ id }) => id));
  if (
    entities.length !== expected.size
    || new Set(entities.map(({ semanticTaskId }) => semanticTaskId)).size !== entities.length
    || new Set(entities.map(({ nativeTaskId }) => nativeTaskId)).size !== entities.length
    || entities.some(({ semanticTaskId }) => !expected.has(semanticTaskId))
  ) {
    throw new CccPrdImportError(
      "CCC_PRD_IMPORT_PROJECTION_DRIFT",
      `CCC PRD import ${row.importId} has an incomplete or ambiguous native task mapping`,
    );
  }
  return new Map(
    entities.map(({ semanticTaskId, nativeTaskId }) => [semanticTaskId, nativeTaskId]),
  );
}

function persistedCampaignIdentity(row: ImportRow): CccCampaignImportIdentity {
  try {
    const { executionPolicy, manifest, manifestHash } =
      reconstructCccCampaignCustody(row);
    return { executionPolicy, manifest, manifestHash };
  } catch {
    throw new CccPrdImportError(
      "CCC_PRD_IMPORT_CAMPAIGN_CUSTODY_REFUSED",
      `CCC PRD import ${row.importId} has missing, unadmitted, or drifted campaign custody`,
    );
  }
}

async function prepareDatabaseImport(
  input: ImportCccPrdBundleInput,
  executionPolicy: CccCampaignExecutionPolicy,
  canonicalRootDir: string,
  waitBudgetMs: number,
): Promise<{ row: ImportRow; created: boolean }> {
  const { bundle, layer, idempotencyKey, store, failureInjection } = input;
  const projectId = projectIdFor(layer);
  const importId = importIdFor(projectId, idempotencyKey);
  const campaignId = oneIntent(bundle, "campaign").entityId;
  return withImportIdentityLock(layer, projectId, idempotencyKey, waitBudgetMs, async (tx) => {
      const existing = await selectImportRow(tx, projectId, idempotencyKey);
      if (existing) {
        const persisted = persistedCampaignIdentity(existing);
        const manifest = createCccCampaignManifest({
          projectId,
          importId,
          idempotencyKey,
          campaignId,
          bundle,
          executionPolicy,
          targetRepositoryPath: canonicalRootDir,
          campaignStartedAt: persisted.manifest.campaignStartedAt,
        });
        const identityHash = hashCccCampaignManifest(manifest);
        if (
          existing.bundleHash !== bundle.bundleHash
          || existing.identityHash !== identityHash
          || existing.campaignManifestHash !== identityHash
          || canonicalCccPrdJson(existing.executionPolicy) !== canonicalCccPrdJson(executionPolicy)
          || canonicalCccPrdJson(existing.campaignManifest) !== canonicalCccPrdJson(manifest)
          || existing.targetRepository !== canonicalRootDir
          || existing.rootDir !== canonicalRootDir
          || existing.targetBase !== bundle.targetRepository.baseCommit
        ) {
          throw new CccPrdImportError(
            "CCC_PRD_IMPORT_IDEMPOTENCY_COLLISION",
            `CCC PRD idempotency key ${JSON.stringify(idempotencyKey)} is already bound to a different bundle, target, base, or execution policy`,
          );
        }
        return { row: existing, created: false };
      }

      const recorder: ImportTransactionWitnessRecorder = {
        transactionId: randomUUID(),
        tx,
        observedWriterClasses: [],
        probe: input.transactionProbe,
      };
      input.transactionProbe?.onPrepareTransaction(tx);
      try {
        const now = new Date().toISOString();
        const manifest = createCccCampaignManifest({
          projectId,
          importId,
          idempotencyKey,
          campaignId,
          bundle,
          executionPolicy,
          targetRepositoryPath: canonicalRootDir,
          campaignStartedAt: now,
        });
        const identityHash = hashCccCampaignManifest(manifest);
        const nativeTaskIds = await allocateNativeTaskIds(
          tx,
          bundle,
          projectId,
          importId,
          now,
        );
        const stagingRelativePath = join(STAGING_PREFIX, importId);
        const transactionWitness: CccPrdImportTransactionWitness = {
          transactionId: recorder.transactionId,
          writerClasses: [],
        };
        const projection = buildCccPrdProjection({
          bundle,
          executionPolicy,
          importId,
          identityHash,
          campaignId,
          now,
          nativeTaskIds,
        });
        const projectionDigest = contentDigest(projection);
        await tx.insert(schema.project.cccPrdImports).values({
          projectId,
          idempotencyKey,
          importId,
          identityHash,
          bundleHash: bundle.bundleHash,
          packetHash: bundle.sourceHash,
          sidecarHash: bundle.sidecarHash,
          sourceVersion: bundle.sourceVersion,
          targetRepository: canonicalRootDir,
          targetBase: bundle.targetRepository.baseCommit,
          rootDir: canonicalRootDir,
          stagingRelativePath,
          state: "prepared",
          runnable: 0,
          canonicalBundle: bundle,
          transactionWitness,
          projectionDigest,
          executionPolicy,
          campaignManifest: manifest,
          campaignManifestHash: identityHash,
          campaignStartedAt: manifest.campaignStartedAt,
          campaignDeadlineAt: manifest.campaignDeadlineAt,
          requestCount: 0,
          activeActionLeases: {},
          createdAt: now,
          updatedAt: now,
        });

        const missionId = await writeCampaign(tx, recorder, bundle, projectId, importId, now);
        await inject(failureInjection, "campaign");
        await writeTasks(
          tx,
          recorder,
          bundle,
          projectId,
          importId,
          missionId,
          identityHash,
          executionPolicy,
          store,
          now,
          nativeTaskIds,
        );
        await inject(failureInjection, "task");
        await writeDependencyEdges(
          tx,
          recorder,
          bundle,
          projectId,
          importId,
          nativeTaskIds,
        );
        await inject(failureInjection, "dependency_edge");
        await writeWorkflows(
          tx,
          recorder,
          bundle,
          executionPolicy,
          projectId,
          importId,
          now,
          nativeTaskIds,
        );
        await inject(failureInjection, "workflow");
        await writeDocuments(
          tx,
          recorder,
          bundle,
          projectId,
          importId,
          now,
          nativeTaskIds,
        );
        await inject(failureInjection, "document");
        await writeArtifacts(
          tx,
          recorder,
          bundle,
          projectId,
          importId,
          now,
          nativeTaskIds,
        );
        await inject(failureInjection, "artifact");
        await writeSources(tx, recorder, bundle, projectId, importId);
        await inject(failureInjection, "source");
        await writeWorkItems(
          tx,
          recorder,
          bundle,
          executionPolicy,
          projectId,
          importId,
          now,
          nativeTaskIds,
        );
        await inject(failureInjection, "work_item");
        await writeRunAudit(tx, recorder, bundle, projectId, importId, now);
        await inject(failureInjection, "run_audit");

        if (canonicalCccPrdJson(recorder.observedWriterClasses) !== canonicalCccPrdJson(CCC_PRD_IMPORT_WRITER_CLASSES)) {
          throw new CccPrdImportError(
            "CCC_PRD_IMPORT_TRANSACTION_VIOLATION",
            `CCC PRD import writer transaction coverage is incomplete: ${recorder.observedWriterClasses.join(", ")}`,
          );
        }
        await tx
          .update(schema.project.cccPrdImports)
          .set({
            transactionWitness: {
              transactionId: recorder.transactionId,
              writerClasses: [...recorder.observedWriterClasses],
            },
          })
          .where(and(
            eq(schema.project.cccPrdImports.projectId, projectId),
            eq(schema.project.cccPrdImports.idempotencyKey, idempotencyKey),
          ));

        const row = await selectImportRow(tx, projectId, idempotencyKey);
        if (!row) throw new Error(`CCC PRD import ${importId} disappeared inside its transaction`);
        return { row, created: true };
      } finally {
        input.transactionProbe?.onPrepareComplete(tx);
      }
    });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function existingPathKind(path: string): Promise<"missing" | "directory" | "file" | "symlink" | "other"> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) return "symlink";
    if (stats.isDirectory()) return "directory";
    if (stats.isFile()) return "file";
    return "other";
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";
    if (code === "ENOENT") return "missing";
    throw error;
  }
}

async function ensureOwnedDirectory(
  canonicalRoot: string,
  target: string,
  label: string,
): Promise<string> {
  const resolvedTarget = resolve(target);
  if (!isContainedPath(canonicalRoot, resolvedTarget)) {
    throw new CccPrdImportError(
      "CCC_PRD_IMPORT_WRITE_ROOT_REFUSED",
      `CCC PRD ${label} path escapes target repository: ${resolvedTarget}`,
    );
  }
  const descendant = relative(canonicalRoot, resolvedTarget);
  let cursor = canonicalRoot;
  for (const segment of descendant.split(sep).filter(Boolean)) {
    cursor = join(cursor, segment);
    let kind = await existingPathKind(cursor);
    if (kind === "missing") {
      await mkdir(cursor);
      kind = await existingPathKind(cursor);
    }
    if (kind !== "directory") {
      throw new CccPrdImportError(
        "CCC_PRD_IMPORT_WRITE_ROOT_REFUSED",
        `CCC PRD ${label} path contains a ${kind}: ${cursor}`,
      );
    }
    const canonicalCursor = await realpath(cursor);
    if (!isContainedPath(canonicalRoot, canonicalCursor)) {
      throw new CccPrdImportError(
        "CCC_PRD_IMPORT_WRITE_ROOT_REFUSED",
        `CCC PRD ${label} path escapes target repository: ${canonicalCursor}`,
      );
    }
  }
  return realpath(resolvedTarget);
}

async function assertOwnedRegularFile(path: string): Promise<void> {
  const kind = await existingPathKind(path);
  if (kind === "missing" || kind === "file") return;
  throw new CccPrdImportError(
    "CCC_PRD_IMPORT_WRITE_ROOT_REFUSED",
    `CCC PRD import refuses a ${kind} at owned file path ${path}`,
  );
}

async function ensureExactFile(path: string, bytes: string): Promise<void> {
  await assertOwnedRegularFile(path);
  try {
    const existing = await readFile(path, "utf8");
    if (existing !== bytes) {
      throw new CccPrdImportError(
        "CCC_PRD_IMPORT_PROJECTION_CONFLICT",
        `CCC PRD import refuses to overwrite different bytes at ${path}`,
      );
    }
    return;
  } catch (error) {
    if (error instanceof CccPrdImportError) throw error;
    const code = typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";
    if (code !== "ENOENT") throw error;
  }
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, bytes, { encoding: "utf8", flag: "wx" });
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    if (await pathExists(path)) {
      const existing = await readFile(path, "utf8");
      if (existing === bytes) return;
    }
    throw error;
  }
}

async function assertOwnedFusionRoot(rootDir: string): Promise<string> {
  const root = await realpath(rootDir);
  await ensureOwnedDirectory(root, join(root, ".fusion"), ".fusion");
  return root;
}

async function ensureStagingManifest(
  rootDir: string,
  row: ImportRow,
  projection: PreparedCccPrdProjection,
): Promise<string> {
  const root = await assertOwnedFusionRoot(rootDir);
  if (isAbsolute(row.stagingRelativePath)) {
    throw new CccPrdImportError("CCC_PRD_IMPORT_STAGING_REFUSED", "CCC PRD staging path must be relative");
  }
  const lexicalStagingRoot = resolve(root, STAGING_PREFIX);
  const lexicalStagingPath = resolve(root, row.stagingRelativePath);
  if (!isContainedPath(lexicalStagingRoot, lexicalStagingPath) || lexicalStagingPath === lexicalStagingRoot) {
    throw new CccPrdImportError(
      "CCC_PRD_IMPORT_STAGING_REFUSED",
      `CCC PRD staging path escapes its owned prefix: ${row.stagingRelativePath}`,
    );
  }
  const stagingRoot = await ensureOwnedDirectory(root, lexicalStagingRoot, "staging root");
  const stagingPath = await ensureOwnedDirectory(root, lexicalStagingPath, "staging import");
  if (!isContainedPath(stagingRoot, stagingPath) || stagingPath === stagingRoot) {
    throw new CccPrdImportError(
      "CCC_PRD_IMPORT_STAGING_REFUSED",
      `CCC PRD staging path escapes its canonical owned prefix: ${row.stagingRelativePath}`,
    );
  }
  const manifest = `${canonicalCccPrdJson(projection)}\n`;
  if (sha256(canonicalCccPrdJson(projection)) !== row.projectionDigest) {
    throw new CccPrdImportError(
      "CCC_PRD_IMPORT_PROJECTION_DRIFT",
      `CCC PRD projection digest changed for ${row.importId}`,
    );
  }
  await ensureExactFile(join(stagingPath, "manifest.json"), manifest);
  return stagingPath;
}

async function ensureStagedFiles(
  rootDir: string,
  row: ImportRow,
  projection: PreparedCccPrdProjection,
  failureInjection?: ImportCccPrdBundleInput["failureInjection"],
): Promise<string> {
  const stagingPath = await ensureStagingManifest(rootDir, row, projection);
  const canonicalRoot = await realpath(rootDir);
  const stagedTasksRoot = await ensureOwnedDirectory(canonicalRoot, join(stagingPath, "tasks"), "staged tasks");
  await ensureOwnedDirectory(canonicalRoot, join(stagingPath, "artifacts"), "staged artifacts");
  for (const task of projection.taskFiles) {
    await ensureOwnedDirectory(canonicalRoot, join(stagedTasksRoot, task.id), `staged task ${task.id}`);
  }
  await inject(failureInjection, "task_directory");
  for (const task of projection.taskFiles) {
    await ensureExactFile(join(stagingPath, "tasks", task.id, "task.json"), task.taskJson);
  }
  await inject(failureInjection, "task_json");
  for (const task of projection.taskFiles) {
    await ensureExactFile(join(stagingPath, "tasks", task.id, "PROMPT.md"), task.prompt);
  }
  await inject(failureInjection, "prompt");
  for (const artifact of projection.artifactFiles) {
    await ensureExactFile(join(stagingPath, "artifacts", artifact.id), artifact.content);
  }
  await inject(failureInjection, "artifact_bytes");
  return stagingPath;
}

async function verifyProjectedTask(
  path: string,
  task: PreparedCccPrdProjection["taskFiles"][number],
): Promise<void> {
  const expected = [
    [join(path, "task.json"), task.taskJson],
    [join(path, "PROMPT.md"), task.prompt],
  ] as const;
  for (const [file, bytes] of expected) {
    await assertOwnedRegularFile(file);
    const existing = await readFile(file, "utf8").catch(() => null);
    if (existing !== bytes) {
      throw new CccPrdImportError(
        "CCC_PRD_IMPORT_PROJECTION_CONFLICT",
        `CCC PRD canonical task projection differs at ${file}`,
      );
    }
  }
}

async function moveCanonicalProjection(
  rootDir: string,
  stagingPath: string,
  projection: PreparedCccPrdProjection,
  assertClaim?: () => Promise<void>,
): Promise<void> {
  await assertClaim?.();
  const root = await assertOwnedFusionRoot(rootDir);
  const tasksRoot = await ensureOwnedDirectory(root, join(root, ".fusion", "tasks"), "canonical tasks");
  const artifactsRoot = await ensureOwnedDirectory(root, join(root, ".fusion", "artifacts"), "canonical artifacts");
  for (const task of projection.taskFiles) {
    const staged = join(stagingPath, "tasks", task.id);
    const canonical = join(tasksRoot, task.id);
    await assertClaim?.();
    if (await existingPathKind(canonical) === "missing") {
      try {
        await rename(staged, canonical);
      } catch (error) {
        if (await existingPathKind(canonical) === "missing") throw error;
      }
    }
    const canonicalTaskRoot = await ensureOwnedDirectory(
      root,
      canonical,
      `canonical task ${task.id}`,
    );
    await verifyProjectedTask(canonicalTaskRoot, task);
    if (await pathExists(staged)) {
      await assertClaim?.();
      await rm(staged, { recursive: true });
    }
  }
  for (const artifact of projection.artifactFiles) {
    const staged = join(stagingPath, "artifacts", artifact.id);
    const canonical = join(artifactsRoot, artifact.id);
    await assertClaim?.();
    if (await existingPathKind(canonical) === "missing") {
      try {
        await rename(staged, canonical);
      } catch (error) {
        if (await existingPathKind(canonical) === "missing") throw error;
      }
    }
    await assertOwnedRegularFile(canonical);
    const existing = await readFile(canonical, "utf8");
    if (existing !== artifact.content) {
      throw new CccPrdImportError(
        "CCC_PRD_IMPORT_PROJECTION_CONFLICT",
        `CCC PRD canonical artifact projection differs at ${canonical}`,
      );
    }
    if (await pathExists(staged)) {
      await assertClaim?.();
      await rm(staged);
    }
  }
}

async function releaseProjection(
  layer: AsyncDataLayer,
  row: ImportRow,
  token: string,
  error: unknown,
): Promise<void> {
  const now = new Date().toISOString();
  const message = error instanceof Error ? error.message : String(error);
  await serializable(layer, () => layer.transactionImmediate(async (tx) => {
    await tx
      .update(schema.project.cccPrdImports)
      .set({
        state: "prepared",
        runnable: 0,
        projectionOwner: null,
        projectionLeaseUntil: null,
        lastError: message.slice(0, 2_000),
        updatedAt: now,
      })
      .where(and(
        eq(schema.project.cccPrdImports.projectId, row.projectId),
        eq(schema.project.cccPrdImports.idempotencyKey, row.idempotencyKey),
        eq(schema.project.cccPrdImports.projectionOwner, token),
      ));
  }));
}

async function claimProjection(
  layer: AsyncDataLayer,
  projectId: string,
  idempotencyKey: string,
  token: string,
  leaseDurationMs: number,
  lockWaitMs: number,
): Promise<{ row: ImportRow; claimed: boolean }> {
  const boundedLockWaitMs = Math.max(1, Math.ceil(lockWaitMs));
  try {
    return await serializable(layer, () => layer.transactionImmediate(async (tx) => {
      await tx.execute(sql`
        SELECT set_config('lock_timeout', ${`${boundedLockWaitMs}ms`}, true)
      `);
      const rows = await tx
        .select()
        .from(schema.project.cccPrdImports)
        .where(and(
          eq(schema.project.cccPrdImports.projectId, projectId),
          eq(schema.project.cccPrdImports.idempotencyKey, idempotencyKey),
        ))
        .limit(1)
        .for("update");
      const row = rows[0] as ImportRow | undefined;
      if (!row) {
        throw new CccPrdImportError(
          "CCC_PRD_IMPORT_NOT_FOUND",
          `CCC PRD import not found for ${JSON.stringify(idempotencyKey)}`,
        );
      }
      if (row.state === "active") return { row, claimed: false };
      const nowMs = Date.now();
      const leaseMs = Date.parse(row.projectionLeaseUntil ?? "");
      if (
        row.state === "projecting"
        && row.projectionOwner
        && row.projectionOwner !== token
        && Number.isFinite(leaseMs)
        && leaseMs > nowMs
      ) {
        return { row, claimed: false };
      }
      const now = new Date(nowMs).toISOString();
      const leaseUntil = new Date(nowMs + leaseDurationMs).toISOString();
      await tx
        .update(schema.project.cccPrdImports)
        .set({
          state: "projecting",
          runnable: 0,
          projectionOwner: token,
          projectionLeaseUntil: leaseUntil,
          lastError: null,
          updatedAt: now,
        })
        .where(and(
          eq(schema.project.cccPrdImports.projectId, projectId),
          eq(schema.project.cccPrdImports.idempotencyKey, idempotencyKey),
        ));
      return {
        row: {
          ...row,
          state: "projecting",
          runnable: 0,
          projectionOwner: token,
          projectionLeaseUntil: leaseUntil,
          updatedAt: now,
        },
        claimed: true,
      };
    }));
  } catch (error) {
    if (isPostgresLockTimeout(error)) {
      throw new CccPrdImportError(
        "CCC_PRD_IMPORT_RECONCILE_TIMEOUT",
        `Timed out after ${boundedLockWaitMs}ms waiting for CCC PRD import ${importIdFor(projectId, idempotencyKey)} projection row lock`,
      );
    }
    throw error;
  }
}

async function renewProjectionLease(
  layer: AsyncDataLayer,
  row: ImportRow,
  token: string,
  leaseDurationMs: number,
  allowActive: () => boolean,
): Promise<void> {
  await serializable(layer, () => layer.transactionImmediate(async (tx) => {
    const lockedRows = await tx
      .select()
      .from(schema.project.cccPrdImports)
      .where(and(
        eq(schema.project.cccPrdImports.projectId, row.projectId),
        eq(schema.project.cccPrdImports.idempotencyKey, row.idempotencyKey),
      ))
      .limit(1)
      .for("update");
    const current = lockedRows[0] as ImportRow | undefined;
    if (current?.state === "active" && allowActive()) return;
    if (
      !current
      || current.state !== "projecting"
      || current.projectionOwner !== token
    ) {
      throw new CccPrdImportError(
        "CCC_PRD_IMPORT_RECONCILE_CONFLICT",
        `CCC PRD import ${row.importId} lost its projection claim during renewal`,
      );
    }
    const nowMs = Date.now();
    await tx
      .update(schema.project.cccPrdImports)
      .set({
        projectionLeaseUntil: new Date(nowMs + leaseDurationMs).toISOString(),
        updatedAt: new Date(nowMs).toISOString(),
      })
      .where(and(
        eq(schema.project.cccPrdImports.projectId, row.projectId),
        eq(schema.project.cccPrdImports.idempotencyKey, row.idempotencyKey),
        eq(schema.project.cccPrdImports.projectionOwner, token),
      ));
  }));
}

function startProjectionLeaseHeartbeat(
  layer: AsyncDataLayer,
  row: ImportRow,
  token: string,
  leaseDurationMs: number,
): {
  assertHealthy(): Promise<void>;
  beginActivation(): void;
  stop(): Promise<void>;
} {
  let stopped = false;
  let activationStarted = false;
  let failure: unknown;
  let renewal = Promise.resolve();
  const intervalMs = Math.max(10, Math.floor(leaseDurationMs / 3));
  const queueRenewal = (): Promise<void> => {
    renewal = renewal.then(async () => {
      if (stopped || failure) return;
      try {
        await renewProjectionLease(layer, row, token, leaseDurationMs, () => activationStarted);
      } catch (error) {
        failure = error;
      }
    });
    return renewal;
  };
  const timer = setInterval(() => {
    void queueRenewal();
  }, intervalMs);
  return {
    async assertHealthy() {
      await queueRenewal();
      if (failure) throw failure;
    },
    beginActivation() {
      activationStarted = true;
    },
    async stop() {
      if (!stopped) {
        stopped = true;
        clearInterval(timer);
      }
      await renewal;
      if (failure) throw failure;
    },
  };
}

async function activateImport(
  input: {
    layer: AsyncDataLayer;
    row: ImportRow;
    token: string;
  },
): Promise<void> {
  const { layer, row, token } = input;
  const now = new Date().toISOString();
  await serializable(layer, () => layer.transactionImmediate(async (tx) => {
    const lockedRows = await tx
      .select()
      .from(schema.project.cccPrdImports)
      .where(and(
        eq(schema.project.cccPrdImports.projectId, row.projectId),
        eq(schema.project.cccPrdImports.idempotencyKey, row.idempotencyKey),
      ))
      .limit(1)
      .for("update");
    const current = lockedRows[0] as ImportRow | undefined;
    if (!current) throw new CccPrdImportError("CCC_PRD_IMPORT_NOT_FOUND", `CCC PRD import ${row.importId} disappeared`);
    if (current.state === "active") return;
    if (current.projectionOwner !== token || current.state !== "projecting") {
      throw new CccPrdImportError(
        "CCC_PRD_IMPORT_RECONCILE_CONFLICT",
        `CCC PRD import ${row.importId} lost its projection claim`,
      );
    }
    const entities = await tx
      .select()
      .from(schema.project.cccPrdImportEntities)
      .where(and(
        eq(schema.project.cccPrdImportEntities.projectId, row.projectId),
        eq(schema.project.cccPrdImportEntities.importId, row.importId),
      ));
    const ids = (type: CccPrdImportEntityType) =>
      entities.filter((entity) => entity.entityType === type).map((entity) => entity.nativeId);
    const campaignIds = ids("campaign");
    const taskIds = ids("task");
    const workItemIds = ids("work_item");
    if (campaignIds.length > 0) {
      await tx
        .update(schema.project.missions)
        .set({ status: "active", updatedAt: now })
        .where(and(
          eq(schema.project.missions.projectId, row.projectId),
          inArray(schema.project.missions.id, campaignIds),
        ));
    }
    if (taskIds.length > 0) {
      await tx
        .update(schema.project.tasks)
        .set({
          column: "todo",
          status: "queued",
          paused: 0,
          userPaused: 0,
          pausedReason: null,
          updatedAt: now,
          columnMovedAt: now,
        })
        .where(and(
          eq(schema.project.tasks.projectId, row.projectId),
          inArray(schema.project.tasks.id, taskIds),
        ));
    }
    if (workItemIds.length > 0) {
      await tx
        .update(schema.project.workflowWorkItems)
        .set({
          state: "runnable",
          blockedReason: null,
          waitReason: row.executionPolicy.schema === "ccc-campaign.execution-policy.v2"
            ? "planning"
            : null,
          updatedAt: now,
        })
        .where(and(
          eq(schema.project.workflowWorkItems.projectId, row.projectId),
          inArray(schema.project.workflowWorkItems.id, workItemIds),
        ));
    }
    await recordRunAuditEventWithinTransaction(tx, {
      timestamp: now,
      agentId: "ccc-prd-import",
      runId: `ccc-prd:${row.importId}`,
      domain: "database",
      mutationType: "ccc-prd-import:active",
      target: row.targetRepository,
      metadata: {
        projectId: row.projectId,
        importId: row.importId,
        bundleHash: row.bundleHash,
        packetHash: row.packetHash,
        targetBase: row.targetBase,
        state: "active",
      },
    });
    await tx
      .update(schema.project.cccPrdImports)
      .set({
        state: "active",
        runnable: 1,
        projectionOwner: null,
        projectionLeaseUntil: null,
        lastError: null,
        activatedAt: now,
        updatedAt: now,
      })
      .where(and(
        eq(schema.project.cccPrdImports.projectId, row.projectId),
        eq(schema.project.cccPrdImports.idempotencyKey, row.idempotencyKey),
      ));
  }));
}

async function cleanupStagingProjection(
  rootDir: string,
  row: ImportRow,
): Promise<void> {
  const root = await assertOwnedFusionRoot(rootDir);
  const stagingRoot = resolve(root, STAGING_PREFIX);
  const stagingPath = resolve(root, row.stagingRelativePath);
  if (
    !isContainedPath(root, stagingRoot)
    || !isContainedPath(stagingRoot, stagingPath)
    || stagingPath === stagingRoot
  ) {
    throw new CccPrdImportError(
      "CCC_PRD_IMPORT_STAGING_REFUSED",
      `CCC PRD cleanup path escapes owned staging prefix: ${row.stagingRelativePath}`,
    );
  }
  const kind = await existingPathKind(stagingPath);
  if (kind === "symlink" || (kind !== "missing" && kind !== "directory")) {
    throw new CccPrdImportError(
      "CCC_PRD_IMPORT_WRITE_ROOT_REFUSED",
      `CCC PRD cleanup refuses a ${kind} staging path: ${stagingPath}`,
    );
  }
  if (kind === "directory") {
    const canonicalStagingRoot = await ensureOwnedDirectory(root, stagingRoot, "staging root");
    const canonicalStagingPath = await realpath(stagingPath);
    if (!isContainedPath(canonicalStagingRoot, canonicalStagingPath) || canonicalStagingPath === canonicalStagingRoot) {
      throw new CccPrdImportError(
        "CCC_PRD_IMPORT_STAGING_REFUSED",
        `CCC PRD cleanup path escapes canonical owned staging prefix: ${row.stagingRelativePath}`,
      );
    }
    await rm(stagingPath, { recursive: true });
  }
}

async function withImportIdentityLock<T>(
  layer: AsyncDataLayer,
  projectId: string,
  idempotencyKey: string,
  waitBudgetMs: number,
  operation: (tx: DbTransaction) => Promise<T>,
): Promise<T> {
  const lockIdentity = canonicalCccPrdJson([projectId, idempotencyKey]);
  const deadline = Date.now() + waitBudgetMs;
  while (true) {
    const attempt = await serializable(layer, () => layer.transactionImmediate(async (tx) => {
      const rows = await tx.execute(sql`
        SELECT pg_try_advisory_xact_lock(hashtextextended(${lockIdentity}, 0)) AS acquired
      `) as unknown as Array<{ acquired: boolean }>;
      if (!rows[0]?.acquired) return { acquired: false as const };
      return { acquired: true as const, value: await operation(tx) };
    }, { isolationLevel: "serializable", accessMode: "read write" }));
    if (attempt.acquired) return attempt.value;
    if (Date.now() >= deadline) {
      throw new CccPrdImportError(
        "CCC_PRD_IMPORT_RECONCILE_TIMEOUT",
        `Timed out after ${waitBudgetMs}ms waiting for CCC PRD import ${importIdFor(projectId, idempotencyKey)} identity lock`,
      );
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
}

async function withProjectionOwnerLock<T>(
  layer: AsyncDataLayer,
  projectId: string,
  idempotencyKey: string,
  waitBudgetMs: number,
  operation: () => Promise<T>,
): Promise<T> {
  const lockIdentity = canonicalCccPrdJson(["projection-owner", projectId, idempotencyKey]);
  const deadline = Date.now() + waitBudgetMs;
  while (true) {
    const attempt = await serializable(layer, () => layer.transactionImmediate(async (tx) => {
      const rows = await tx.execute(sql`
        SELECT pg_try_advisory_xact_lock(hashtextextended(${lockIdentity}, 0)) AS acquired
      `) as unknown as Array<{ acquired: boolean }>;
      if (!rows[0]?.acquired) return { acquired: false as const };
      return { acquired: true as const, value: await operation() };
    }, { isolationLevel: "serializable", accessMode: "read write" }));
    if (attempt.acquired) return attempt.value;
    if (Date.now() >= deadline) {
      throw new CccPrdImportError(
        "CCC_PRD_IMPORT_RECONCILE_TIMEOUT",
        `Timed out after ${waitBudgetMs}ms waiting for CCC PRD import ${importIdFor(projectId, idempotencyKey)} live projection owner`,
      );
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
}

async function inspectDirectCounts(
  layer: AsyncDataLayer,
  row: ImportRow,
): Promise<CccPrdImportDirectCounts> {
  const entities = await layer.db
    .select()
    .from(schema.project.cccPrdImportEntities)
    .where(and(
      eq(schema.project.cccPrdImportEntities.projectId, row.projectId),
      eq(schema.project.cccPrdImportEntities.importId, row.importId),
    ));
  const ids = (type: CccPrdImportEntityType) =>
    entities.filter((entry) => entry.entityType === type).map((entry) => entry.nativeId);
  const campaignIds = ids("campaign");
  const taskIds = ids("task");
  const workflowIds = ids("workflow");
  const documentIds = ids("document");
  const artifactIds = ids("artifact");
  const workItemIds = ids("work_item");
  const auditIds = ids("run_audit");
  const [campaigns, tasks, workflows, documents, artifacts, sources, workItems, runAudits] =
    await Promise.all([
      campaignIds.length === 0 ? [] : layer.db.select({ id: schema.project.missions.id }).from(schema.project.missions).where(and(
        eq(schema.project.missions.projectId, row.projectId),
        inArray(schema.project.missions.id, campaignIds),
      )),
      taskIds.length === 0 ? [] : layer.db.select({ id: schema.project.tasks.id }).from(schema.project.tasks).where(and(
        eq(schema.project.tasks.projectId, row.projectId),
        inArray(schema.project.tasks.id, taskIds),
      )),
      workflowIds.length === 0 ? [] : layer.db.select({ id: schema.project.workflows.id }).from(schema.project.workflows).where(
        inArray(schema.project.workflows.id, workflowIds),
      ),
      documentIds.length === 0 ? [] : layer.db.select({ id: schema.project.taskDocuments.id }).from(schema.project.taskDocuments).where(and(
        eq(schema.project.taskDocuments.projectId, row.projectId),
        inArray(schema.project.taskDocuments.id, documentIds),
      )),
      artifactIds.length === 0 ? [] : layer.db.select({ id: schema.project.artifacts.id }).from(schema.project.artifacts).where(
        inArray(schema.project.artifacts.id, artifactIds),
      ),
      layer.db.select({ path: schema.project.cccPrdImportSources.path }).from(schema.project.cccPrdImportSources).where(and(
        eq(schema.project.cccPrdImportSources.projectId, row.projectId),
        eq(schema.project.cccPrdImportSources.importId, row.importId),
      )),
      workItemIds.length === 0 ? [] : layer.db.select({ id: schema.project.workflowWorkItems.id }).from(schema.project.workflowWorkItems).where(and(
        eq(schema.project.workflowWorkItems.projectId, row.projectId),
        inArray(schema.project.workflowWorkItems.id, workItemIds),
      )),
      auditIds.length === 0 ? [] : layer.db.select({ id: schema.project.runAuditEvents.id }).from(schema.project.runAuditEvents).where(
        inArray(schema.project.runAuditEvents.id, auditIds),
      ),
    ]);
  return {
    campaigns: campaigns.length,
    tasks: tasks.length,
    dependencyEdges: ids("dependency_edge").length,
    workflows: workflows.length,
    documents: documents.length,
    artifacts: artifacts.length,
    sources: sources.length,
    workItems: workItems.length,
    runAudits: runAudits.length,
  };
}

function inspectionFromRow(
  row: ImportRow,
  directCounts: CccPrdImportDirectCounts,
): CccPrdImportInspection {
  return {
    importId: row.importId,
    idempotencyKey: row.idempotencyKey,
    bundleHash: row.bundleHash,
    identityHash: row.identityHash,
    targetRepository: row.targetRepository,
    targetBase: row.targetBase,
    state: row.state,
    runnable: row.runnable === 1,
    stagingRelativePath: row.stagingRelativePath,
    transactionWitness: row.transactionWitness,
    directCounts,
  };
}

function invalidateImportReadCaches(store: TaskStore): void {
  store.taskCache.clear();
  store.workflowDefinitionsCache = null;
}

export async function inspectCccPrdImport(
  input: InspectCccPrdImportInput,
): Promise<CccPrdImportInspection | null> {
  const rootDir = await physicalCccPrdImportRoot(input.rootDir);
  const row = await selectImportRow(input.layer.db, projectIdFor(input.layer), input.idempotencyKey);
  if (!row) return null;
  if (row.rootDir !== rootDir) {
    throw new CccPrdImportError(
      "CCC_PRD_IMPORT_ROOT_MISMATCH",
      `CCC PRD import ${row.importId} belongs to ${row.rootDir}, not ${rootDir}`,
    );
  }
  return inspectionFromRow(row, await inspectDirectCounts(input.layer, row));
}

async function reconcileOwned(
  input: ReconcileCccPrdImportInput,
  failureInjection?: ImportCccPrdBundleInput["failureInjection"],
): Promise<CccPrdImportInspection> {
  const projectId = projectIdFor(input.layer);
  const preflightRow = await selectImportRow(
    input.layer.db,
    projectId,
    input.idempotencyKey,
  );
  if (!preflightRow) {
    throw new CccPrdImportError(
      "CCC_PRD_IMPORT_NOT_FOUND",
      `CCC PRD import not found for ${JSON.stringify(input.idempotencyKey)}`,
    );
  }
  const preflightRoot = await physicalCccPrdImportRoot(input.rootDir);
  if (preflightRow.rootDir !== preflightRoot) {
    throw new CccPrdImportError(
      "CCC_PRD_IMPORT_ROOT_MISMATCH",
      `CCC PRD import ${preflightRow.importId} belongs to ${preflightRow.rootDir}, not ${preflightRoot}`,
    );
  }
  persistedCampaignIdentity(preflightRow);
  const token = randomUUID();
  const waitStartedAt = Date.now();
  const leaseDurationMs = failureInjection?.projectionLeaseMs ?? 5_000;
  const reconciliationOverheadMs = reconciliationAllowance(failureInjection);
  const waitBudgetMs = preflightRow.canonicalBundle.bounds.maxDurationMs + reconciliationOverheadMs;
  if (!Number.isFinite(leaseDurationMs) || leaseDurationMs <= 0) {
    throw new CccPrdImportError(
      "CCC_PRD_IMPORT_INVALID_FAILURE_INJECTION",
      "CCC PRD projection lease test override must be positive and finite",
    );
  }
  while (true) {
    const remainingWaitMs = waitBudgetMs - (Date.now() - waitStartedAt);
    if (remainingWaitMs <= 0) {
      throw new CccPrdImportError(
        "CCC_PRD_IMPORT_RECONCILE_TIMEOUT",
        `Timed out after ${waitBudgetMs}ms waiting for CCC PRD import ${preflightRow.importId} projection owner`,
      );
    }
    const outcome = await withProjectionOwnerLock(
      input.layer,
      projectId,
      input.idempotencyKey,
      remainingWaitMs,
      async () => {
        const claimWaitMs = waitBudgetMs - (Date.now() - waitStartedAt);
        if (claimWaitMs <= 0) {
          throw new CccPrdImportError(
            "CCC_PRD_IMPORT_RECONCILE_TIMEOUT",
            `Timed out after ${waitBudgetMs}ms waiting for CCC PRD import ${preflightRow.importId} projection owner`,
          );
        }
        const claim = await claimProjection(
          input.layer,
          projectId,
          input.idempotencyKey,
          token,
          leaseDurationMs,
          claimWaitMs,
        );
        const row = claim.row;
        try {
          if (claim.claimed) await inject(failureInjection, "after_projection_claim");
          const currentRoot = await physicalCccPrdImportRoot(input.rootDir);
          if (row.rootDir !== currentRoot) {
            throw new CccPrdImportError(
              "CCC_PRD_IMPORT_ROOT_MISMATCH",
              `CCC PRD import ${row.importId} belongs to ${row.rootDir}, not ${currentRoot}`,
            );
          }
        } catch (error) {
          if (claim.claimed) {
            try {
              await releaseProjection(input.layer, row, token, error);
            } catch (releaseError) {
              throw new AggregateError(
                [error, releaseError],
                `CCC PRD import ${row.importId} could not release its projection claim`,
              );
            }
          }
          throw error;
        }
        const campaignIdentity = persistedCampaignIdentity(row);
        const nativeTaskIds = await loadNativeTaskIds(input.layer.db, row);
        const projection = buildCccPrdProjection({
          bundle: row.canonicalBundle,
          executionPolicy: campaignIdentity.executionPolicy,
          importId: row.importId,
          identityHash: row.identityHash,
          campaignId: campaignIdentity.manifest.campaignId,
          now: row.createdAt,
          nativeTaskIds,
        });
        if (row.state === "active") {
          await withImportIdentityLock(input.layer, row.projectId, row.idempotencyKey, waitBudgetMs, async (tx) => {
            const locked = await selectImportRow(tx, row.projectId, row.idempotencyKey);
            if (locked?.state !== "active") {
              throw new CccPrdImportError(
                "CCC_PRD_IMPORT_RECONCILE_CONFLICT",
                `CCC PRD import ${row.importId} left active state during projection repair`,
              );
            }
            const stagingPath = await ensureStagedFiles(row.rootDir, row, projection, failureInjection);
            await moveCanonicalProjection(row.rootDir, stagingPath, projection);
            await cleanupStagingProjection(row.rootDir, row);
          });
          const active = await inspectCccPrdImport(input);
          if (!active) {
            throw new CccPrdImportError(
              "CCC_PRD_IMPORT_NOT_FOUND",
              `CCC PRD import ${row.importId} disappeared`,
            );
          }
          return { status: "complete" as const, value: active };
        }
        if (!claim.claimed) return { status: "retry" as const };
        const heartbeat = startProjectionLeaseHeartbeat(
          input.layer,
          row,
          token,
          leaseDurationMs,
        );
        try {
          const stagingPath = await ensureStagedFiles(row.rootDir, row, projection, failureInjection);
          await heartbeat.assertHealthy();
          await moveCanonicalProjection(
            row.rootDir,
            stagingPath,
            projection,
            () => heartbeat.assertHealthy(),
          );
          await inject(failureInjection, "canonical_projection_move");
          await inject(failureInjection, "before_activation");
          await heartbeat.assertHealthy();
          await inject(failureInjection, "activation_handoff");
          await heartbeat.assertHealthy();
          heartbeat.beginActivation();
          await activateImport({ layer: input.layer, row, token });
          await heartbeat.stop();
          await inject(failureInjection, "after_activation");
          await withImportIdentityLock(
            input.layer,
            row.projectId,
            row.idempotencyKey,
            waitBudgetMs,
            async () => cleanupStagingProjection(row.rootDir, row),
          );
          const active = await inspectCccPrdImport(input);
          if (!active) {
            throw new CccPrdImportError(
              "CCC_PRD_IMPORT_NOT_FOUND",
              `CCC PRD import ${row.importId} disappeared`,
            );
          }
          return { status: "complete" as const, value: active };
        } catch (error) {
          const heartbeatError = await heartbeat.stop().then(
            () => null,
            (stopError: unknown) => stopError,
          );
          await releaseProjection(input.layer, row, token, error).catch(() => {});
          if (heartbeatError) {
            throw heartbeatError;
          }
          throw error;
        }
      },
    );
    if (outcome.status === "complete") return outcome.value;
    if (Date.now() - waitStartedAt >= waitBudgetMs) {
        throw new CccPrdImportError(
          "CCC_PRD_IMPORT_RECONCILE_TIMEOUT",
          `Timed out after ${waitBudgetMs}ms waiting for CCC PRD import ${preflightRow.importId} projection owner`,
        );
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
}

export async function reconcileCccPrdImport(
  input: ReconcileCccPrdImportInput,
): Promise<CccPrdImportResult> {
  const inspected = await inspectCccPrdImport(input);
  if (!inspected) {
    throw new CccPrdImportError(
      "CCC_PRD_IMPORT_NOT_FOUND",
      `CCC PRD import not found for ${JSON.stringify(input.idempotencyKey)}`,
    );
  }
  invalidateImportReadCaches(input.store);
  const reconciled = await reconcileOwned(input);
  return { ...reconciled, replayed: inspected.state === "active" };
}

export async function importCccPrdBundle(
  input: ImportCccPrdBundleInput,
): Promise<CccPrdImportResult> {
  assertCccPrdImportBundle(input.bundle, input.rootDir, input.idempotencyKey);
  const existing = await selectImportRow(
    input.layer.db,
    projectIdFor(input.layer),
    input.idempotencyKey,
  );
  if (existing && existing.bundleHash !== input.bundle.bundleHash) {
    throw new CccPrdImportError(
      "CCC_PRD_IMPORT_IDEMPOTENCY_COLLISION",
      `CCC PRD idempotency key ${JSON.stringify(input.idempotencyKey)} is already bound to a different bundle, target, or base`,
    );
  }
  const canonicalRootDir = await physicalCccPrdImportRoot(input.rootDir);
  const canonicalTargetRepository = await physicalCccPrdImportRoot(
    input.bundle.targetRepository.path,
  );
  if (canonicalRootDir !== canonicalTargetRepository) {
    throw new CccPrdImportError(
      "CCC_PRD_IMPORT_ROOT_MISMATCH",
      "CCC PRD import rootDir and target repository resolve to different physical roots",
    );
  }
  const executionPolicy = parseCccCampaignExecutionPolicy(
    input.executionPolicy,
    input.bundle,
  );
  const waitBudgetMs = input.bundle.bounds.maxDurationMs + reconciliationAllowance(input.failureInjection);
  const prepared = await prepareDatabaseImport(
    input,
    executionPolicy,
    canonicalRootDir,
    waitBudgetMs,
  );
  invalidateImportReadCaches(input.store);
  if (prepared.created) {
    await inject(input.failureInjection, "after_prepared_db_commit");
  }
  const reconciled = await reconcileOwned({
    idempotencyKey: input.idempotencyKey,
    layer: input.layer,
    store: input.store,
    rootDir: input.rootDir,
  }, input.failureInjection);
  await inject(input.failureInjection, "lost_response_after_commit");
  return { ...reconciled, replayed: !prepared.created };
}
