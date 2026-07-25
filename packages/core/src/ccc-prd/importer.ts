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
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
import * as schema from "../postgres/schema/index.js";
import type { AsyncDataLayer, DbTransaction } from "../postgres/data-layer.js";
import { recordRunAuditEventWithinTransaction } from "../postgres/data-layer.js";
import type { TaskStore } from "../store.js";
import { insertTaskRowInTransaction } from "../task-store/async-persistence.js";
import type { Task } from "../types.js";
import { canonicalCccPrdJson } from "./contract.js";
import type {
  CccPrdArtifact,
  CccPrdImportEntityType,
  CccPrdImportIntent,
  CccPrdSemanticBundle,
  CccPrdTask,
  CccPrdWorkflow,
} from "./types.js";

const PREPARED_STATUS = "ccc-prd-import-prepared";
const STAGING_PREFIX = join(".fusion", "ccc-prd-import-staging");
const WRITER_CLASSES = [
  "campaign",
  "task",
  "dependency_edge",
  "workflow",
  "document",
  "artifact",
  "source",
  "work_item",
  "run_audit",
] as const satisfies readonly CccPrdImportEntityType[];
const RETRYABLE_SQLSTATES = new Set(["40001", "40P01"]);
const ENTITY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;

export type CccPrdImportFailureCheckpoint =
  | CccPrdImportEntityType
  | "after_prepared_db_commit"
  | "task_directory"
  | "task_json"
  | "prompt"
  | "artifact_bytes"
  | "canonical_projection_move"
  | "before_activation"
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

type EmissionSink = { emit(value: unknown): void };

export type ImportCccPrdBundleInput = {
  bundle: CccPrdSemanticBundle;
  idempotencyKey: string;
  store: TaskStore;
  layer: AsyncDataLayer;
  rootDir: string;
  failureInjection?: { checkpoint: CccPrdImportFailureCheckpoint };
  transactionProbe?: CccPrdImportTransactionProbe;
  effects?: EmissionSink;
  events?: EmissionSink;
};

export type ReconcileCccPrdImportInput = {
  idempotencyKey: string;
  store: TaskStore;
  layer: AsyncDataLayer;
  rootDir: string;
  effects?: EmissionSink;
  events?: EmissionSink;
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
};

type PreparedProjection = {
  schema: "ccc-prd.import-projection.v1";
  importId: string;
  identityHash: string;
  bundleHash: string;
  state: "prepared";
  runnable: false;
  taskFiles: Array<{
    id: string;
    taskJson: string;
    prompt: string;
  }>;
  artifactFiles: Array<{
    id: string;
    content: string;
    taskId: string;
  }>;
};

type ImportTransactionWitnessRecorder = {
  readonly transactionId: string;
  readonly tx: DbTransaction;
  readonly observedWriterClasses: CccPrdImportEntityType[];
  readonly probe?: CccPrdImportTransactionProbe;
};

export class CccPrdImportError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CccPrdImportError";
  }
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function projectIdFor(layer: AsyncDataLayer): string {
  return layer.projectId?.trim() || "__legacy_unscoped__";
}

function bundleIdentity(bundle: CccPrdSemanticBundle): string {
  const { bundleHash: _declared, ...withoutHash } = bundle;
  return sha256(canonicalCccPrdJson(withoutHash));
}

function normalizeRoot(path: string): string {
  return resolve(path);
}

function isContainedPath(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function assertSafeEntityId(id: string, label: string): void {
  if (!ENTITY_ID_PATTERN.test(id)) {
    throw new CccPrdImportError(
      "CCC_PRD_IMPORT_INVALID_BUNDLE",
      `${label} has an unsafe identifier: ${JSON.stringify(id)}`,
    );
  }
}

function assertBundleContract(
  bundle: CccPrdSemanticBundle,
  rootDir: string,
  idempotencyKey: string,
): string {
  if (!idempotencyKey.trim() || idempotencyKey.length > 256) {
    throw new CccPrdImportError(
      "CCC_PRD_IMPORT_USAGE",
      "CCC PRD import idempotencyKey must contain 1-256 characters",
    );
  }
  if (bundle.kind !== "bundle" || bundle.schema !== "ccc-prd.bundle.v1") {
    throw new CccPrdImportError("CCC_PRD_IMPORT_INVALID_BUNDLE", "CCC PRD import requires a v1 semantic bundle");
  }
  const identityHash = bundleIdentity(bundle);
  if (identityHash !== bundle.bundleHash) {
    throw new CccPrdImportError(
      "CCC_PRD_IMPORT_INVALID_BUNDLE",
      `CCC PRD bundle hash mismatch: declared ${bundle.bundleHash}, calculated ${identityHash}`,
    );
  }
  if (bundle.provenance.packetHash !== bundle.sourceHash) {
    throw new CccPrdImportError(
      "CCC_PRD_IMPORT_INVALID_BUNDLE",
      "CCC PRD packet provenance does not match sourceHash",
    );
  }
  if (normalizeRoot(rootDir) !== normalizeRoot(bundle.targetRepository.path)) {
    throw new CccPrdImportError(
      "CCC_PRD_IMPORT_ROOT_MISMATCH",
      "CCC PRD import rootDir must exactly match bundle.targetRepository.path",
    );
  }
  if (
    !Number.isSafeInteger(bundle.bounds.maxRequests)
    || !Number.isSafeInteger(bundle.bounds.maxDurationMs)
    || !Number.isSafeInteger(bundle.bounds.maxConcurrency)
    || bundle.bounds.maxRequests < 1
    || bundle.bounds.maxDurationMs < 1
    || bundle.bounds.maxConcurrency < 1
    || bundle.bounds.maxRequests > 10_000
    || bundle.bounds.maxDurationMs > 86_400_000
    || bundle.bounds.maxConcurrency > 256
  ) {
    throw new CccPrdImportError(
      "CCC_PRD_IMPORT_INVALID_BUNDLE",
      "CCC PRD import bounds must be finite positive integers within local admission ceilings",
    );
  }
  const root = normalizeRoot(rootDir);
  const admitted = bundle.admittedWriteRoots.map(({ path }) => normalizeRoot(path));
  for (const output of [join(root, ".fusion", "tasks"), join(root, ".fusion", "artifacts")]) {
    if (!admitted.some((candidate) => isContainedPath(candidate, output))) {
      throw new CccPrdImportError(
        "CCC_PRD_IMPORT_WRITE_ROOT_REFUSED",
        `CCC PRD output is outside admitted write roots: ${output}`,
      );
    }
  }
  const allIds = [
    ...bundle.tasks.map(({ id }) => ["task", id] as const),
    ...bundle.edges.map(({ id }) => ["dependency edge", id] as const),
    ...bundle.workflows.map(({ id }) => ["workflow", id] as const),
    ...bundle.documents.map(({ id }) => ["document", id] as const),
    ...bundle.artifacts.map(({ id }) => ["artifact", id] as const),
    ...bundle.importIntents.map(({ id }) => ["import intent", id] as const),
  ];
  for (const [label, id] of allIds) assertSafeEntityId(id, label);
  for (const type of WRITER_CLASSES) {
    if (!bundle.importIntents.some((intent) => intent.entityType === type)) {
      throw new CccPrdImportError(
        "CCC_PRD_IMPORT_INVALID_BUNDLE",
        `CCC PRD bundle has no ${type} import intent`,
      );
    }
  }
  return identityHash;
}

function inject(
  failureInjection: ImportCccPrdBundleInput["failureInjection"] | undefined,
  checkpoint: CccPrdImportFailureCheckpoint,
): void {
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

function nativeScopedId(importId: string, semanticId: string): string {
  return `${importId}--${semanticId}`;
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

function preparedTask(
  source: CccPrdTask,
  missionId: string,
  identityHash: string,
  now: string,
): Task & { state: "prepared"; runnable: false } {
  return {
    id: source.id,
    lineageId: `ccc-prd:${identityHash.slice(0, 24)}:${source.id}`,
    title: source.title,
    description: source.description,
    priority: "normal",
    column: "triage",
    status: PREPARED_STATUS,
    dependencies: [...source.dependencyTaskIds],
    steps: [],
    currentStep: 0,
    log: [{ timestamp: now, action: "CCC PRD import prepared" }],
    paused: true,
    userPaused: true,
    pausedReason: PREPARED_STATUS,
    missionId,
    sourceType: "api",
    sourceMetadata: {
      bundleHash: identityHash,
      requirementIds: source.requirementIds,
      proofIds: source.proofIds,
      accountableProducer: source.accountableProducer,
    },
    createdAt: now,
    updatedAt: now,
    columnMovedAt: now,
    state: "prepared",
    runnable: false,
  };
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
  assertSafeEntityId(intent.entityId, "campaign");
  await tx.insert(schema.project.missions).values({
    projectId,
    id: intent.entityId,
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
    nativeId: intent.entityId,
    value: { intent, sourceVersion: bundle.sourceVersion },
  }]);
  return intent.entityId;
}

async function writeTasks(
  tx: DbTransaction,
  recorder: ImportTransactionWitnessRecorder,
  bundle: CccPrdSemanticBundle,
  projectId: string,
  importId: string,
  missionId: string,
  identityHash: string,
  store: TaskStore,
  now: string,
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
  for (const intent of intents) {
    const source = byId.get(intent.entityId);
    if (!source) {
      throw new CccPrdImportError(
        "CCC_PRD_IMPORT_INVALID_BUNDLE",
        `CCC PRD task intent references unknown task ${intent.entityId}`,
      );
    }
    const task = preparedTask(source, missionId, identityHash, now);
    await insertTaskRowInTransaction(
      tx,
      task as unknown as Record<string, unknown>,
      store.createTaskPersistSerializationContext(task),
      projectId,
    );
    tasks.push(task);
    ledger.push({ intent, nativeId: source.id, value: source });
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
      .set({ dependencies: [...target.dependencyTaskIds] })
      .where(and(
        eq(schema.project.tasks.projectId, projectId),
        eq(schema.project.tasks.id, target.id),
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
      return { intent, nativeId: edge.fromTaskId, value: edge };
    }),
  );
}

async function writeWorkflows(
  tx: DbTransaction,
  recorder: ImportTransactionWitnessRecorder,
  bundle: CccPrdSemanticBundle,
  projectId: string,
  importId: string,
  now: string,
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
    const nativeWorkflowId = nativeScopedId(importId, workflow.id);
    await tx.insert(schema.project.workflows).values({
      id: nativeWorkflowId,
      name: workflow.title,
      description: `Generated from CCC PRD ${bundle.sourceVersion}`,
      ir: nativeWorkflowIr(bundle, workflow),
      layout: {},
      kind: "workflow",
      createdAt: now,
      updatedAt: now,
    });
    for (const taskId of workflow.taskIds) {
      await tx.insert(schema.project.taskWorkflowSelection).values({
        projectId,
        taskId,
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
      return { intent, nativeId: nativeScopedId(importId, workflow.id), value: workflow };
    }),
  );
}

function nativeWorkflowTaskNodeId(taskId: string): string {
  return `ccc-task-${sha256(taskId).slice(0, 24)}`;
}

function nativeWorkflowIr(
  bundle: CccPrdSemanticBundle,
  workflow: CccPrdWorkflow,
): {
  version: "v1";
  name: string;
  nodes: Array<Record<string, unknown>>;
  edges: Array<{ from: string; to: string; condition?: "success" }>;
} {
  const taskById = new Map(bundle.tasks.map((task) => [task.id, task]));
  const taskNodes = workflow.taskIds.map((taskId) => {
    const task = taskById.get(taskId);
    if (!task) {
      throw new CccPrdImportError(
        "CCC_PRD_IMPORT_INVALID_BUNDLE",
        `CCC PRD workflow ${workflow.id} references unknown task ${taskId}`,
      );
    }
    return {
      id: nativeWorkflowTaskNodeId(taskId),
      kind: "prompt",
      config: {
        name: task.title,
        prompt: task.description,
        cccPrdTaskId: task.id,
      },
    };
  });
  const dependencyEdges = bundle.edges
    .filter((edge) =>
      workflow.taskIds.includes(edge.fromTaskId)
      && workflow.taskIds.includes(edge.toTaskId))
    .map((edge) => ({
      from: nativeWorkflowTaskNodeId(edge.toTaskId),
      to: nativeWorkflowTaskNodeId(edge.fromTaskId),
      condition: "success" as const,
    }));
  return {
    version: "v1",
    name: workflow.title,
    nodes: [
      { id: "start", kind: "start" },
      ...taskNodes,
      { id: "end", kind: "end" },
    ],
    edges: [
      ...workflow.entryTaskIds.map((taskId) => ({
        from: "start",
        to: nativeWorkflowTaskNodeId(taskId),
        condition: "success" as const,
      })),
      ...dependencyEdges,
      ...workflow.terminalTaskIds.map((taskId) => ({
        from: nativeWorkflowTaskNodeId(taskId),
        to: "end",
        condition: "success" as const,
      })),
    ],
  };
}

async function writeDocuments(
  tx: DbTransaction,
  recorder: ImportTransactionWitnessRecorder,
  bundle: CccPrdSemanticBundle,
  projectId: string,
  importId: string,
  now: string,
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
    await tx.insert(schema.project.taskDocuments).values({
      projectId,
      id: document.id,
      taskId: document.taskId,
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
      return { intent, nativeId: document.id, value: document };
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
    const nativeArtifactId = nativeScopedId(importId, artifact.id);
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
      taskId: artifact.taskId,
      metadata: { bundleHash: bundle.bundleHash, projectId },
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
      return { intent, nativeId: nativeScopedId(importId, artifact.id), value: artifact };
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
  projectId: string,
  importId: string,
  now: string,
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
    await tx.insert(schema.project.workflowWorkItems).values({
      projectId,
      id: intent.id,
      runId: `ccc-prd:${importId}`,
      taskId,
      nodeId: nativeWorkflowTaskNodeId(taskId),
      kind: "task",
      state: "held",
      attempt: 0,
      blockedReason: PREPARED_STATUS,
      stableWorkflowRunId: `ccc-prd:${importId}`,
      irHash: contentDigest(workflow),
      createdAt: now,
      updatedAt: now,
    });
    ledger.push({ intent, nativeId: intent.id, value: workflow });
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

async function prepareDatabaseImport(
  input: ImportCccPrdBundleInput,
  identityHash: string,
): Promise<{ row: ImportRow; created: boolean }> {
  const { bundle, layer, idempotencyKey, store, failureInjection } = input;
  const projectId = projectIdFor(layer);
  return serializable(layer, () =>
    layer.transactionImmediate(async (tx) => {
      const lockIdentity = canonicalCccPrdJson([projectId, idempotencyKey]);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockIdentity}, 0))`);
      const existing = await selectImportRow(tx, projectId, idempotencyKey);
      if (existing) {
        if (
          existing.bundleHash !== bundle.bundleHash
          || existing.identityHash !== identityHash
          || normalizeRoot(existing.targetRepository) !== normalizeRoot(bundle.targetRepository.path)
          || existing.targetBase !== bundle.targetRepository.baseCommit
        ) {
          throw new CccPrdImportError(
            "CCC_PRD_IMPORT_IDEMPOTENCY_COLLISION",
            `CCC PRD idempotency key ${JSON.stringify(idempotencyKey)} is already bound to a different bundle, target, or base`,
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
        const importId = importIdFor(projectId, idempotencyKey);
        const stagingRelativePath = join(STAGING_PREFIX, importId);
        const transactionWitness: CccPrdImportTransactionWitness = {
          transactionId: recorder.transactionId,
          writerClasses: [],
        };
        const projection = buildProjection(bundle, importId, identityHash, now);
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
          targetRepository: normalizeRoot(bundle.targetRepository.path),
          targetBase: bundle.targetRepository.baseCommit,
          rootDir: normalizeRoot(input.rootDir),
          stagingRelativePath,
          state: "prepared",
          runnable: 0,
          canonicalBundle: bundle,
          transactionWitness,
          projectionDigest,
          createdAt: now,
          updatedAt: now,
        });

        const missionId = await writeCampaign(tx, recorder, bundle, projectId, importId, now);
        inject(failureInjection, "campaign");
        await writeTasks(tx, recorder, bundle, projectId, importId, missionId, identityHash, store, now);
        inject(failureInjection, "task");
        await writeDependencyEdges(tx, recorder, bundle, projectId, importId);
        inject(failureInjection, "dependency_edge");
        await writeWorkflows(tx, recorder, bundle, projectId, importId, now);
        inject(failureInjection, "workflow");
        await writeDocuments(tx, recorder, bundle, projectId, importId, now);
        inject(failureInjection, "document");
        await writeArtifacts(tx, recorder, bundle, projectId, importId, now);
        inject(failureInjection, "artifact");
        await writeSources(tx, recorder, bundle, projectId, importId);
        inject(failureInjection, "source");
        await writeWorkItems(tx, recorder, bundle, projectId, importId, now);
        inject(failureInjection, "work_item");
        await writeRunAudit(tx, recorder, bundle, projectId, importId, now);
        inject(failureInjection, "run_audit");

        if (canonicalCccPrdJson(recorder.observedWriterClasses) !== canonicalCccPrdJson(WRITER_CLASSES)) {
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
    }, { isolationLevel: "serializable", accessMode: "read write" }));
}

function artifactForTask(bundle: CccPrdSemanticBundle, taskId: string): CccPrdArtifact[] {
  return bundle.artifacts.filter((artifact) => artifact.taskId === taskId);
}

function promptForTask(bundle: CccPrdSemanticBundle, task: CccPrdTask): string {
  const prompt = bundle.documents.find((document) =>
    document.taskId === task.id && document.key.toLowerCase() === "prompt.md");
  if (prompt) return prompt.content;
  return `# ${task.title}\n\n${task.description}\n`;
}

function buildProjection(
  bundle: CccPrdSemanticBundle,
  importId: string,
  identityHash: string,
  now: string,
): PreparedProjection {
  const missionId = oneIntent(bundle, "campaign").entityId;
  const taskFiles = bundle.tasks.map((source) => {
    const prepared = preparedTask(source, missionId, identityHash, now);
    return {
      id: source.id,
      taskJson: `${canonicalCccPrdJson(prepared)}\n`,
      prompt: promptForTask(bundle, source),
    };
  });
  const artifactFiles = bundle.tasks.flatMap((task) =>
    artifactForTask(bundle, task.id).map((artifact) => ({
      id: nativeScopedId(importId, artifact.id),
      content: artifact.content,
      taskId: task.id,
    })));
  return {
    schema: "ccc-prd.import-projection.v1",
    importId,
    identityHash,
    bundleHash: bundle.bundleHash,
    state: "prepared",
    runnable: false,
    taskFiles,
    artifactFiles,
  };
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
  projection: PreparedProjection,
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
  projection: PreparedProjection,
  failureInjection?: ImportCccPrdBundleInput["failureInjection"],
): Promise<string> {
  const stagingPath = await ensureStagingManifest(rootDir, row, projection);
  const canonicalRoot = await realpath(rootDir);
  const stagedTasksRoot = await ensureOwnedDirectory(canonicalRoot, join(stagingPath, "tasks"), "staged tasks");
  await ensureOwnedDirectory(canonicalRoot, join(stagingPath, "artifacts"), "staged artifacts");
  for (const task of projection.taskFiles) {
    await ensureOwnedDirectory(canonicalRoot, join(stagedTasksRoot, task.id), `staged task ${task.id}`);
  }
  inject(failureInjection, "task_directory");
  for (const task of projection.taskFiles) {
    await ensureExactFile(join(stagingPath, "tasks", task.id, "task.json"), task.taskJson);
  }
  inject(failureInjection, "task_json");
  for (const task of projection.taskFiles) {
    await ensureExactFile(join(stagingPath, "tasks", task.id, "PROMPT.md"), task.prompt);
  }
  inject(failureInjection, "prompt");
  for (const artifact of projection.artifactFiles) {
    await ensureExactFile(join(stagingPath, "artifacts", artifact.id), artifact.content);
  }
  inject(failureInjection, "artifact_bytes");
  return stagingPath;
}

async function verifyProjectedTask(
  path: string,
  task: PreparedProjection["taskFiles"][number],
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
  projection: PreparedProjection,
): Promise<void> {
  const root = await assertOwnedFusionRoot(rootDir);
  const tasksRoot = await ensureOwnedDirectory(root, join(root, ".fusion", "tasks"), "canonical tasks");
  const artifactsRoot = await ensureOwnedDirectory(root, join(root, ".fusion", "artifacts"), "canonical artifacts");
  for (const task of projection.taskFiles) {
    const staged = join(stagingPath, "tasks", task.id);
    const canonical = join(tasksRoot, task.id);
    if (await pathExists(canonical)) {
      await verifyProjectedTask(canonical, task);
      if (await pathExists(staged)) {
        await rm(staged, { recursive: true });
      }
      continue;
    }
    await rename(staged, canonical);
  }
  for (const artifact of projection.artifactFiles) {
    const staged = join(stagingPath, "artifacts", artifact.id);
    const canonical = join(artifactsRoot, artifact.id);
    if (await pathExists(canonical)) {
      await assertOwnedRegularFile(canonical);
      const existing = await readFile(canonical, "utf8");
      if (existing !== artifact.content) {
        throw new CccPrdImportError(
          "CCC_PRD_IMPORT_PROJECTION_CONFLICT",
          `CCC PRD canonical artifact projection differs at ${canonical}`,
        );
      }
      if (await pathExists(staged)) await rm(staged);
      continue;
    }
    await rename(staged, canonical);
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
  await layer.transactionImmediate(async (tx) => {
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
  });
}

async function claimProjection(
  layer: AsyncDataLayer,
  projectId: string,
  idempotencyKey: string,
  token: string,
): Promise<{ row: ImportRow; claimed: boolean }> {
  return layer.transactionImmediate(async (tx) => {
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
    const leaseUntil = new Date(nowMs + 5_000).toISOString();
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
  });
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
  await layer.transactionImmediate(async (tx) => {
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
    const auditIds = ids("run_audit");
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
          updatedAt: now,
        })
        .where(and(
          eq(schema.project.workflowWorkItems.projectId, row.projectId),
          inArray(schema.project.workflowWorkItems.id, workItemIds),
        ));
    }
    if (auditIds.length > 0) {
      await tx
        .update(schema.project.runAuditEvents)
        .set({
          timestamp: now,
          mutationType: "ccc-prd-import:active",
          metadata: {
            projectId: row.projectId,
            importId: row.importId,
            bundleHash: row.bundleHash,
            packetHash: row.packetHash,
            targetBase: row.targetBase,
            state: "active",
          },
        })
        .where(inArray(schema.project.runAuditEvents.id, auditIds));
    }
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
  });
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
  const rootDir = normalizeRoot(input.rootDir);
  const row = await selectImportRow(input.layer.db, projectIdFor(input.layer), input.idempotencyKey);
  if (!row) return null;
  if (normalizeRoot(row.rootDir) !== rootDir) {
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
  const token = randomUUID();
  const deadline = Date.now() + 10_000;
  while (true) {
    const claim = await claimProjection(input.layer, projectId, input.idempotencyKey, token);
    const row = claim.row;
    if (normalizeRoot(row.rootDir) !== normalizeRoot(input.rootDir)) {
      throw new CccPrdImportError(
        "CCC_PRD_IMPORT_ROOT_MISMATCH",
        `CCC PRD import ${row.importId} belongs to ${row.rootDir}, not ${normalizeRoot(input.rootDir)}`,
      );
    }
    const projection = buildProjection(
      row.canonicalBundle,
      row.importId,
      row.identityHash,
      row.createdAt,
    );
    if (row.state === "active") {
      await moveCanonicalProjection(
        input.rootDir,
        resolve(input.rootDir, row.stagingRelativePath),
        projection,
      );
      await cleanupStagingProjection(input.rootDir, row);
      const active = await inspectCccPrdImport(input);
      if (!active) throw new CccPrdImportError("CCC_PRD_IMPORT_NOT_FOUND", `CCC PRD import ${row.importId} disappeared`);
      return active;
    }
    if (!claim.claimed) {
      if (Date.now() >= deadline) {
        throw new CccPrdImportError(
          "CCC_PRD_IMPORT_RECONCILE_TIMEOUT",
          `Timed out waiting for CCC PRD import ${row.importId} projection owner`,
        );
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
      continue;
    }
    try {
      const stagingPath = await ensureStagedFiles(input.rootDir, row, projection, failureInjection);
      await moveCanonicalProjection(input.rootDir, stagingPath, projection);
      inject(failureInjection, "canonical_projection_move");
      inject(failureInjection, "before_activation");
      await activateImport({ layer: input.layer, row, token });
      inject(failureInjection, "after_activation");
      await cleanupStagingProjection(input.rootDir, row);
      const active = await inspectCccPrdImport(input);
      if (!active) throw new CccPrdImportError("CCC_PRD_IMPORT_NOT_FOUND", `CCC PRD import ${row.importId} disappeared`);
      return active;
    } catch (error) {
      await releaseProjection(input.layer, row, token, error).catch(() => {});
      throw error;
    }
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
  const identityHash = assertBundleContract(input.bundle, input.rootDir, input.idempotencyKey);
  const prepared = await prepareDatabaseImport(input, identityHash);
  invalidateImportReadCaches(input.store);
  const projection = buildProjection(
    prepared.row.canonicalBundle,
    prepared.row.importId,
    prepared.row.identityHash,
    prepared.row.createdAt,
  );
  await ensureStagingManifest(input.rootDir, prepared.row, projection);
  inject(input.failureInjection, "after_prepared_db_commit");
  const reconciled = await reconcileOwned({
    idempotencyKey: input.idempotencyKey,
    layer: input.layer,
    store: input.store,
    rootDir: input.rootDir,
    effects: input.effects,
    events: input.events,
  }, input.failureInjection);
  inject(input.failureInjection, "lost_response_after_commit");
  return { ...reconciled, replayed: !prepared.created };
}
