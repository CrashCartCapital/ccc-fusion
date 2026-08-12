import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, win32 } from "node:path";
import {
  CCC_PRD_BUNDLE_SCHEMA_VERSION,
  CCC_PRD_IMPLEMENTATION_FACT_PROVENANCE_SCHEMA_VERSION,
  CCC_PRD_PROOF_ADMISSION_SCHEMA_VERSION,
  CCC_PRD_SIDECAR_SCHEMA_VERSION,
  canonicalCccPrdJson,
  compareCccPrdCodeUnits,
  computeCccPrdProofDefinitionSha256,
  createCccPrdSpanFromBytes,
  createRefusalBundle,
  normalizeProtectedAction,
  parseWorkflowIr,
  type CccPrdDiagnostic,
  type CccPrdProof,
  type CccPrdRefusalBundle,
  type CccPrdSemanticBundle,
  type CccPrdSidecar,
  type CccPrdSourceSpan,
  type CccPrdValidationResult,
  type WorkflowIr,
  type WorkflowIrEdge,
  type WorkflowIrNode,
} from "@fusion/core";
import {
  CccPrdCustodyError,
  containsProtectedCccPrdSegment,
  readCccPrdPacketCustody,
  resolveCccPrdAdmittedFile,
  sortCccPrdById,
} from "./custody.js";
import {
  isCanonicalProtectedActionIdSet,
  isWellFormedProtectedActionId,
} from "./protected-action-ids.js";
import { analyzeCccPrdMaterialCoverage } from "./material-coverage.js";
import { validateCccPrdImplementationFactProvenance } from "./authoring.js";

export type CompileCccPrdInput = {
  rootDir: string;
  manifestPath: string;
  sidecarPath?: string;
  expectedTarget?: string;
  expectedBase?: string;
  requireMaterialCoverage?: boolean;
};

type CheckedSidecar = {
  sidecar?: CccPrdSidecar;
  sidecarHash?: string;
  diagnostics: CccPrdDiagnostic[];
};

const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const diagnostic = (code: string, message: string, span?: CccPrdSourceSpan): CccPrdDiagnostic => ({
  code,
  message,
  ...(span ? { span } : {}),
});

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPositiveBound(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isCanonicalRootRelativeSource(value: unknown): value is string {
  if (!isNonEmptyString(value) || value !== value.trim()) return false;
  if (
    value.includes("\\")
    || value.includes("\0")
    || value.toLowerCase().startsWith("file:")
    || isAbsolute(value)
    || win32.isAbsolute(value)
  ) {
    return false;
  }
  return value.split("/").every((segment) => (
    segment !== "" && segment !== "." && segment !== ".."
  ));
}

const SIDECAR_FIELDS = new Set([
  "schema",
  "sourceVersion",
  "orderedSources",
  "provenance",
  "authorityRoles",
  "requirements",
  "proofs",
  "tasks",
  "edges",
  "workflows",
  "documents",
  "artifacts",
  "importIntents",
  "protectedActions",
  "bounds",
  "admittedWriteRoots",
  "targetRepository",
  "nonGoals",
  "unresolvedDecisions",
  "ambiguities",
  "exceptions",
  "confidence",
  "materialCoverage",
  "implementationFactProvenance",
]);
const CONFIDENCE_VALUES = new Set(["high", "medium", "low"]);
const AUTHORITY_ROLE_VALUES = new Set(["root", "production_module", "blocking_test_index", "support"]);
const IMPORT_ENTITY_VALUES = new Set([
  "campaign",
  "task",
  "dependency_edge",
  "workflow",
  "document",
  "artifact",
  "source",
  "work_item",
  "run_audit",
]);
const IMPORT_TARGETS = new Map([
  ["campaign", "project.missions"],
  ["task", "project.tasks"],
  ["dependency_edge", "project.tasks.dependencies"],
  ["workflow", "project.workflow_work_items"],
  ["document", "project.task_documents"],
  ["artifact", "project.artifacts"],
  ["source", "project.ccc_prd_import_sources"],
  ["work_item", "project.workflow_work_items"],
  ["run_audit", "project.run_audit_events"],
]);
const PROOF_ADMISSION_FIELDS = [
  "schema",
  "pluginId",
  "pluginVersion",
  "extensionId",
  "proofVersion",
  "extensionRootRelativeSource",
  "extensionSourceSha256",
  "extensionManifestSha256",
  "definitionSha256",
] as const;

function validateExactKeys(
  label: string,
  value: Record<string, unknown>,
  fields: readonly string[],
  diagnostics: CccPrdDiagnostic[],
): void {
  const allowed = new Set(fields);
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) {
      diagnostics.push(diagnostic(
        "CCC_PRD_UNKNOWN_DECLARATION",
        `${label} contains unknown field: ${field}`,
      ));
    }
  }
}

function validateStringArray(
  label: string,
  value: unknown,
  diagnostics: CccPrdDiagnostic[],
  options: { nonEmpty?: boolean } = {},
): value is string[] {
  if (
    !Array.isArray(value)
    || (options.nonEmpty === true && value.length === 0)
    || value.some((item) => !isNonEmptyString(item))
  ) {
    diagnostics.push(diagnostic(
      "CCC_PRD_DECLARATION_INVALID",
      `${label} must be ${options.nonEmpty === true ? "a non-empty" : "an"} array of non-empty strings`,
    ));
    return false;
  }
  if (new Set(value).size !== value.length) {
    diagnostics.push(diagnostic("CCC_PRD_DECLARATION_INVALID", `${label} contains duplicate values`));
    return false;
  }
  return true;
}

function validateConfidence(
  label: string,
  value: unknown,
  diagnostics: CccPrdDiagnostic[],
): void {
  if (typeof value !== "string" || !CONFIDENCE_VALUES.has(value)) {
    diagnostics.push(diagnostic("CCC_PRD_DECLARATION_INVALID", `${label} confidence is invalid`));
  }
}

function validateProofAdmission(
  proof: Record<string, unknown>,
  diagnostics: CccPrdDiagnostic[],
): void {
  if (proof.admission === undefined) return;
  const label = `proof ${String(proof.id)} admission`;
  if (!isPlainRecord(proof.admission)) {
    diagnostics.push(diagnostic(
      "CCC_PRD_PROOF_ADMISSION_INVALID",
      `${label} must be an object`,
    ));
    return;
  }
  const admission = proof.admission;
  validateExactKeys(label, admission, PROOF_ADMISSION_FIELDS, diagnostics);
  if (
    admission.schema !== CCC_PRD_PROOF_ADMISSION_SCHEMA_VERSION
    || !isNonEmptyString(admission.pluginId)
    || !isNonEmptyString(admission.pluginVersion)
    || !isNonEmptyString(admission.extensionId)
    || !isNonEmptyString(admission.proofVersion)
    || !isCanonicalRootRelativeSource(admission.extensionRootRelativeSource)
    || !/^[0-9a-f]{64}$/u.test(String(admission.extensionSourceSha256))
    || !/^[0-9a-f]{64}$/u.test(String(admission.extensionManifestSha256))
    || !/^[0-9a-f]{64}$/u.test(String(admission.definitionSha256))
  ) {
    diagnostics.push(diagnostic(
      "CCC_PRD_PROOF_ADMISSION_INVALID",
      `${label} has a malformed schema, identity, or hash`,
    ));
    return;
  }
  let expectedDefinitionSha256: string;
  try {
    expectedDefinitionSha256 = computeCccPrdProofDefinitionSha256(
      proof as unknown as CccPrdProof,
    );
  } catch {
    diagnostics.push(diagnostic(
      "CCC_PRD_PROOF_ADMISSION_INVALID",
      `${label} cannot bind a malformed proof definition`,
    ));
    return;
  }
  if (admission.definitionSha256 !== expectedDefinitionSha256) {
    diagnostics.push(diagnostic(
      "CCC_PRD_PROOF_ADMISSION_STALE",
      `${label} definition hash does not match the current proof`,
    ));
  }
}

function stableDiagnostics(values: CccPrdDiagnostic[]): CccPrdDiagnostic[] {
  return [...values].sort((left, right) => (
    compareCccPrdCodeUnits(left.code, right.code)
    || compareCccPrdCodeUnits(left.span?.path ?? "", right.span?.path ?? "")
    || (left.span?.byteStart ?? 0) - (right.span?.byteStart ?? 0)
    || compareCccPrdCodeUnits(left.message, right.message)
  ));
}

function validateTopLevelShape(value: unknown, diagnostics: CccPrdDiagnostic[]): value is CccPrdSidecar {
  if (!isPlainRecord(value)) {
    diagnostics.push(diagnostic("CCC_PRD_SIDECAR_INVALID", "sidecar must be a JSON object"));
    return false;
  }
  if (value.schema !== CCC_PRD_SIDECAR_SCHEMA_VERSION) {
    diagnostics.push(diagnostic(
      "CCC_PRD_UNKNOWN_SIDECAR_SCHEMA",
      `sidecar schema must be ${CCC_PRD_SIDECAR_SCHEMA_VERSION}`,
    ));
  }
  for (const field of Object.keys(value)) {
    if (!SIDECAR_FIELDS.has(field)) {
      diagnostics.push(diagnostic(
        "CCC_PRD_UNKNOWN_DECLARATION",
        `sidecar contains unknown top-level field: ${field}`,
      ));
    }
  }
  const arrayFields = [
    "orderedSources",
    "authorityRoles",
    "requirements",
    "proofs",
    "tasks",
    "edges",
    "workflows",
    "documents",
    "artifacts",
    "importIntents",
    "protectedActions",
    "admittedWriteRoots",
    "nonGoals",
    "unresolvedDecisions",
    "ambiguities",
    "exceptions",
  ] as const;
  for (const field of arrayFields) {
    if (!Array.isArray(value[field])) {
      diagnostics.push(diagnostic("CCC_PRD_SIDECAR_INVALID", `sidecar ${field} must be an array`));
    }
  }
  for (const field of ["provenance", "bounds", "targetRepository"] as const) {
    if (!isPlainRecord(value[field])) {
      diagnostics.push(diagnostic("CCC_PRD_SIDECAR_INVALID", `sidecar ${field} must be an object`));
    }
  }
  if (!isNonEmptyString(value.sourceVersion)) {
    diagnostics.push(diagnostic("CCC_PRD_SIDECAR_INVALID", "sidecar sourceVersion must be non-empty"));
  }
  if (typeof value.confidence !== "string" || !CONFIDENCE_VALUES.has(value.confidence)) {
    diagnostics.push(diagnostic("CCC_PRD_SIDECAR_INVALID", "sidecar confidence is invalid"));
  }
  return diagnostics.length === 0;
}

function validateUniqueIds(
  label: string,
  values: unknown[],
  diagnostics: CccPrdDiagnostic[],
): Map<string, Record<string, unknown>> {
  const seen = new Map<string, Record<string, unknown>>();
  for (const [index, value] of values.entries()) {
    if (!isPlainRecord(value) || !isNonEmptyString(value.id)) {
      diagnostics.push(diagnostic("CCC_PRD_DECLARATION_INVALID", `${label}[${index}] needs a stable non-empty id`));
      continue;
    }
    if (seen.has(value.id)) {
      diagnostics.push(diagnostic("CCC_PRD_DUPLICATE_ID", `${label} contains duplicate id: ${value.id}`));
      continue;
    }
    seen.set(value.id, value);
  }
  return seen;
}

function validateSpans(
  label: string,
  value: Record<string, unknown>,
  sourceBytes: Map<string, Buffer>,
  diagnostics: CccPrdDiagnostic[],
): void {
  if (!Array.isArray(value.spans) || value.spans.length === 0) {
    diagnostics.push(diagnostic("CCC_PRD_SOURCE_SPAN_MISSING", `${label} ${String(value.id)} has no source spans`));
    return;
  }
  for (const rawSpan of value.spans) {
    if (!isPlainRecord(rawSpan)) {
      diagnostics.push(diagnostic("CCC_PRD_SOURCE_SPAN_INVALID", `${label} ${String(value.id)} has a malformed span`));
      continue;
    }
    validateExactKeys(
      `${label} ${String(value.id)} source span`,
      rawSpan,
      ["path", "byteStart", "byteEnd", "line", "column", "endLine", "endColumn", "sha256", "excerptSha256"],
      diagnostics,
    );
    if (
      !isNonEmptyString(rawSpan.path)
      || !Number.isSafeInteger(rawSpan.byteStart)
      || !Number.isSafeInteger(rawSpan.byteEnd)
      || !Number.isSafeInteger(rawSpan.line)
      || !Number.isSafeInteger(rawSpan.column)
      || !Number.isSafeInteger(rawSpan.endLine)
      || !Number.isSafeInteger(rawSpan.endColumn)
      || !/^[0-9a-f]{64}$/.test(String(rawSpan.sha256))
    ) {
      diagnostics.push(diagnostic(
        "CCC_PRD_SOURCE_SPAN_INVALID",
        `${label} ${String(value.id)} has a malformed span`,
      ));
      continue;
    }
    const span = rawSpan as unknown as CccPrdSourceSpan;
    const source = sourceBytes.get(span.path);
    if (!source) {
      diagnostics.push(diagnostic(
        "CCC_PRD_SOURCE_SPAN_FOREIGN",
        `${label} ${String(value.id)} references unadmitted source ${String(span.path)}`,
      ));
      continue;
    }
    let expected: CccPrdSourceSpan;
    try {
      expected = createCccPrdSpanFromBytes(span.path, source, span.byteStart, span.byteEnd);
    } catch {
      diagnostics.push(diagnostic(
        "CCC_PRD_SOURCE_SPAN_INVALID",
        `${label} ${String(value.id)} has out-of-range byte offsets`,
      ));
      continue;
    }
    if (
      span.sha256 !== expected.sha256
      || span.line !== expected.line
      || span.column !== expected.column
      || span.endLine !== expected.endLine
      || span.endColumn !== expected.endColumn
    ) {
      diagnostics.push(diagnostic(
        "CCC_PRD_SOURCE_SPAN_STALE",
        `${label} ${String(value.id)} source coordinates or hash are stale`,
        expected,
      ));
      continue;
    }
    const excerptHash = sha256(source.subarray(span.byteStart, span.byteEnd));
    if (!isNonEmptyString(span.excerptSha256) || span.excerptSha256 !== excerptHash) {
      diagnostics.push(diagnostic(
        "CCC_PRD_SOURCE_SPAN_STALE",
        `${label} ${String(value.id)} excerpt hash is absent or stale`,
        expected,
      ));
    }
  }
}

function requireReferences(
  owner: string,
  field: unknown,
  target: Map<string, unknown>,
  diagnostics: CccPrdDiagnostic[],
): void {
  if (!Array.isArray(field) || field.length === 0) {
    diagnostics.push(diagnostic("CCC_PRD_REFERENCE_MISSING", `${owner} must declare at least one reference`));
    return;
  }
  for (const id of field) {
    if (!isNonEmptyString(id) || !target.has(id)) {
      diagnostics.push(diagnostic("CCC_PRD_REFERENCE_FOREIGN", `${owner} references unknown id: ${String(id)}`));
    }
  }
}

function optionalReferences(
  owner: string,
  field: unknown,
  target: Map<string, unknown>,
  diagnostics: CccPrdDiagnostic[],
): void {
  if (!Array.isArray(field)) {
    diagnostics.push(diagnostic("CCC_PRD_DECLARATION_INVALID", `${owner} reference field must be an array`));
    return;
  }
  for (const id of field) {
    if (!isNonEmptyString(id) || !target.has(id)) {
      diagnostics.push(diagnostic("CCC_PRD_REFERENCE_FOREIGN", `${owner} references unknown id: ${String(id)}`));
    }
  }
}

function detectDependencyCycle(
  values: Map<string, Record<string, unknown>>,
  dependencyField: string,
): string | undefined {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(id: string): string | undefined {
    if (visiting.has(id)) return id;
    if (visited.has(id)) return undefined;
    visiting.add(id);
    const value = values.get(id);
    if (value && Array.isArray(value[dependencyField])) {
      for (const dependency of value[dependencyField]) {
        if (typeof dependency === "string" && values.has(dependency)) {
          const cycle = visit(dependency);
          if (cycle) return cycle;
        }
      }
    }
    visiting.delete(id);
    visited.add(id);
    return undefined;
  }
  for (const id of values.keys()) {
    const cycle = visit(id);
    if (cycle) return cycle;
  }
  return undefined;
}

type CccPrdDeclarationMap = Map<string, Record<string, unknown>>;

const PRODUCT_GRAPH_UNSUPPORTED = "CCC_PRD_PRODUCT_GRAPH_UNSUPPORTED";
const PRODUCT_TASK_OWNERSHIP_OVERLAP = "CCC_PRD_PRODUCT_TASK_OWNERSHIP_OVERLAP";
const PRODUCT_TASK_CUSTODY_MISSING = "CCC_PRD_PRODUCT_TASK_CUSTODY_MISSING";
const PRODUCT_PROTECTED_ACTION_SHARED = "CCC_PRD_PRODUCT_PROTECTED_ACTION_SHARED";

function declaredStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => isNonEmptyString(item));
}

// Same containment rule as packages/core/src/ccc-campaign/canonical.ts
// pathContains: a path owns itself and everything beneath it.
function ownedPathsOverlap(left: string, right: string): boolean {
  return left === right
    || left.startsWith(`${right}/`)
    || right.startsWith(`${left}/`);
}

/**
 * Series-parallel topology admission, delegated to core.
 *
 * Mirrors the importer's split/join synthesis (nativeWorkflowIr in
 * packages/core/src/ccc-prd/importer.ts): one node per task, a split node
 * after every task with more than one successor, a join node before every
 * task with more than one predecessor, dependency edges rewired through them.
 * The synthesized shape is then run through core's `parseWorkflowIr`, whose
 * `validateParallelism` is exactly the validator the importer's real IR must
 * pass inside the import transaction. Delegating keeps a single definition of
 * "series-parallel" and guarantees admission is at least as strict as import:
 * a topology admitted here cannot later explode at import time as a
 * WorkflowIrError.
 *
 * Node ids are the task ids themselves (splits/joins as `split:<taskId>` /
 * `join:<taskId>`) so a core refusal message names tasks legibly. Returns the
 * core violation message, or undefined when the topology is series-parallel.
 */
function seriesParallelTopologyViolation(
  taskIds: readonly string[],
  successors: ReadonlyMap<string, readonly string[]>,
  entryTaskId: string,
  terminalTaskId: string,
): string | undefined {
  const predecessorCounts = new Map<string, number>(taskIds.map((id) => [id, 0]));
  for (const targets of successors.values()) {
    for (const to of targets) predecessorCounts.set(to, (predecessorCounts.get(to) ?? 0) + 1);
  }
  const splitTaskIds = new Set(taskIds.filter((id) => (successors.get(id)?.length ?? 0) > 1));
  const joinTaskIds = new Set(taskIds.filter((id) => (predecessorCounts.get(id) ?? 0) > 1));
  const splitNodeId = (taskId: string) => `split:${taskId}`;
  const joinNodeId = (taskId: string) => `join:${taskId}`;

  const nodes: WorkflowIrNode[] = [
    { id: "start", kind: "start" },
    ...taskIds.map((id): WorkflowIrNode => ({ id, kind: "prompt", config: { name: id } })),
    ...[...splitTaskIds].map((id): WorkflowIrNode => ({ id: splitNodeId(id), kind: "split" })),
    ...[...joinTaskIds].map((id): WorkflowIrNode => ({
      id: joinNodeId(id),
      kind: "join",
      config: { mode: "all" },
    })),
    { id: "end", kind: "end" },
  ];
  const edges: WorkflowIrEdge[] = [{ from: "start", to: entryTaskId, condition: "success" }];
  for (const [from, targets] of successors) {
    for (const to of targets) {
      edges.push({
        from: splitTaskIds.has(from) ? splitNodeId(from) : from,
        to: joinTaskIds.has(to) ? joinNodeId(to) : to,
        condition: "success",
      });
    }
  }
  for (const id of splitTaskIds) edges.push({ from: id, to: splitNodeId(id), condition: "success" });
  for (const id of joinTaskIds) edges.push({ from: joinNodeId(id), to: id, condition: "success" });
  edges.push({ from: terminalTaskId, to: "end", condition: "success" });

  const ir: WorkflowIr = {
    version: "v2",
    name: "ccc-prd-product-graph-admission",
    columns: [],
    nodes,
    edges,
  };
  try {
    parseWorkflowIr(ir);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Product-graph admission.
 *
 * The supported product route runs a campaign as a series-parallel (fork-join)
 * task graph, so it admits: a single declared workflow whose tasks are all
 * declared, referenced, and imported; with exactly one entry and one terminal;
 * ordered by an acyclic dependency relation whose forks and joins are properly
 * matched (validated against the same core semantics the importer's
 * synthesized split/join IR must pass at import time) and that is mirrored
 * exactly by the declared dependency edges; over tasks whose owned paths never
 * overlap and whose live-execution authority is never shared.
 *
 * A one-task workflow with no edges is the degenerate graph and stays admitted
 * exactly as it was before multi-task support existed, and every linear chain
 * M1 admitted remains admitted unchanged.
 *
 * Two invariants here are not restatements of the generic reference checks
 * above, and both close real runtime holes:
 *
 *   - `edges` and `dependencyTaskIds` must describe the same relation. The
 *     importer persists dependency rows from `edges`, while the cycle check
 *     here and the core execution policy read `dependencyTaskIds`. If the two
 *     disagree, the order that gets persisted is not the order that was
 *     admitted.
 *   - No two tasks may share a live-execution protected action. The provider
 *     controller resolves a task's live-execution permit by action id
 *     (selectCccCampaignDeclaredLiveExecutionAction), so a shared id lets one
 *     task's operator approval release live execution for another task.
 */
function productGraphAdmissionDiagnostics(
  collections: {
    tasks: CccPrdDeclarationMap;
    edges: CccPrdDeclarationMap;
    workflows: CccPrdDeclarationMap;
    protectedActions: CccPrdDeclarationMap;
  },
  taskIntents: Record<string, unknown>[],
  edgeIntents: Record<string, unknown>[],
  workflowIntent: Record<string, unknown>,
  workItemIntent: Record<string, unknown>,
): CccPrdDiagnostic[] {
  const diagnostics: CccPrdDiagnostic[] = [];
  const refuse = (code: string, message: string) => {
    diagnostics.push(diagnostic(code, message));
  };
  const list = (values: readonly string[]) => (values.length === 0 ? "none" : values.join(", "));

  const workflows = [...collections.workflows.values()];
  const workflow = workflows[0];
  if (workflows.length !== 1 || !workflow) {
    refuse(
      PRODUCT_GRAPH_UNSUPPORTED,
      `supported product path requires exactly one declared workflow; received ${workflows.length}`,
    );
    return diagnostics;
  }
  const workflowId = String(workflow.id);
  if (workflowIntent.entityId !== workflowId || workItemIntent.entityId !== workflowId) {
    refuse(
      PRODUCT_GRAPH_UNSUPPORTED,
      `supported product path requires the imported workflow and work item to reference declared workflow ${workflowId}`,
    );
    return diagnostics;
  }

  // Declared tasks, workflow membership, and task import intents must describe
  // the same set: a stray on any side is a task the runtime would either never
  // schedule or never persist.
  const declaredTaskIds = [...collections.tasks.keys()].sort(compareCccPrdCodeUnits);
  const workflowTaskIds = declaredStrings(workflow.taskIds);
  const workflowTaskIdSet = new Set(workflowTaskIds);
  const importedTaskIds = taskIntents.map((intent) => String(intent.entityId));
  const importedTaskIdSet = new Set(importedTaskIds);

  const unreferenced = declaredTaskIds.filter((id) => !workflowTaskIdSet.has(id));
  if (unreferenced.length > 0) {
    refuse(
      PRODUCT_GRAPH_UNSUPPORTED,
      `declared tasks ${list(unreferenced)} are not referenced by workflow ${workflowId}`,
    );
  }
  const undeclared = workflowTaskIds.filter((id) => !collections.tasks.has(id));
  if (undeclared.length > 0) {
    refuse(
      PRODUCT_GRAPH_UNSUPPORTED,
      `workflow ${workflowId} references undeclared tasks ${list(undeclared)}`,
    );
  }
  if (workflowTaskIdSet.size !== workflowTaskIds.length) {
    refuse(
      PRODUCT_GRAPH_UNSUPPORTED,
      `workflow ${workflowId} lists a task more than once`,
    );
  }
  const unimported = declaredTaskIds.filter((id) => !importedTaskIdSet.has(id));
  if (unimported.length > 0) {
    refuse(
      PRODUCT_GRAPH_UNSUPPORTED,
      `declared tasks ${list(unimported)} have no task import intent`,
    );
  }
  const importedStrays = [...importedTaskIdSet]
    .filter((id) => !collections.tasks.has(id))
    .sort(compareCccPrdCodeUnits);
  if (importedStrays.length > 0) {
    refuse(
      PRODUCT_GRAPH_UNSUPPORTED,
      `task import intents reference undeclared tasks ${list(importedStrays)}`,
    );
  }
  if (importedTaskIdSet.size !== importedTaskIds.length) {
    refuse(PRODUCT_GRAPH_UNSUPPORTED, "a task is imported more than once");
  }
  const foreignWorkflow = declaredTaskIds
    .filter((id) => collections.tasks.get(id)!.workflowId !== workflowId);
  if (foreignWorkflow.length > 0) {
    refuse(
      PRODUCT_GRAPH_UNSUPPORTED,
      `tasks ${list(foreignWorkflow)} do not belong to workflow ${workflowId}`,
    );
  }

  const entryTaskIds = declaredStrings(workflow.entryTaskIds);
  const terminalTaskIds = declaredStrings(workflow.terminalTaskIds);
  if (entryTaskIds.length !== 1) {
    refuse(
      PRODUCT_GRAPH_UNSUPPORTED,
      `workflow ${workflowId} must declare exactly one entry task; received ${list(entryTaskIds)}`,
    );
  }
  if (terminalTaskIds.length !== 1) {
    refuse(
      PRODUCT_GRAPH_UNSUPPORTED,
      `workflow ${workflowId} must declare exactly one terminal task; received ${list(terminalTaskIds)}`,
    );
  }

  // Every task in a multi-task chain runs in its own isolated worktree, so each
  // needs its own declared custody. Constrained authoring already refuses this
  // (validateTaskCustodyProvenance in authoring.ts), but an unconstrained or
  // hand-edited sidecar reaches here without it, and core then throws at
  // product-policy generation. Refuse it at admission instead of deferring a
  // certain failure to a later, less legible stage.
  //
  // Deliberately scoped to N > 1: the single-task route has always admitted
  // packets that declare no custody, so requiring it for N === 1 would change
  // an already-admitted shape.
  if (declaredTaskIds.length > 1) {
    for (const id of declaredTaskIds) {
      const task = collections.tasks.get(id)!;
      for (const field of ["ownedPaths", "allowedWriteRoots"] as const) {
        if (declaredStrings(task[field]).length > 0) continue;
        refuse(
          PRODUCT_TASK_CUSTODY_MISSING,
          `task ${id} declares no ${field}; every task in a multi-task chain must declare its own ${field}`,
        );
      }
    }
  }

  // Ownership and live-execution authority are per-pair facts about the
  // declared task set, so they are checked even when the ordering above is
  // already broken.
  const ownership = declaredTaskIds.map((id) => ({
    id,
    paths: declaredStrings(collections.tasks.get(id)!.ownedPaths),
  }));
  for (let left = 0; left < ownership.length; left += 1) {
    for (let right = left + 1; right < ownership.length; right += 1) {
      for (const leftPath of ownership[left]!.paths) {
        for (const rightPath of ownership[right]!.paths) {
          if (!ownedPathsOverlap(leftPath, rightPath)) continue;
          refuse(
            PRODUCT_TASK_OWNERSHIP_OVERLAP,
            `tasks ${ownership[left]!.id} and ${ownership[right]!.id} own overlapping paths ${leftPath} and ${rightPath}; the supported product path requires disjoint ownership for every task pair, including dependency-ordered pairs`,
          );
        }
      }
    }
  }

  const liveExecutionActionIds = new Set(
    [...collections.protectedActions.values()]
      .filter((action) => action.kind === "live_execution")
      .map((action) => String(action.id)),
  );
  const liveExecutionClaimants = new Map<string, string[]>();
  for (const id of declaredTaskIds) {
    for (const actionId of declaredStrings(collections.tasks.get(id)!.protectedActionIds)) {
      if (!liveExecutionActionIds.has(actionId)) continue;
      liveExecutionClaimants.set(actionId, [...(liveExecutionClaimants.get(actionId) ?? []), id]);
    }
  }
  for (const actionId of [...liveExecutionClaimants.keys()].sort(compareCccPrdCodeUnits)) {
    const claimants = liveExecutionClaimants.get(actionId)!;
    if (claimants.length < 2) continue;
    refuse(
      PRODUCT_PROTECTED_ACTION_SHARED,
      `tasks ${list(claimants)} each reference live-execution protected action ${actionId}; one operator approval would release live execution for every task that shares it`,
    );
  }

  // The ordering analysis below reads predecessor and successor counts over the
  // workflow's task set. Computing it over a set already proven inconsistent
  // reports positions that do not exist, so stop here instead.
  if (diagnostics.some(({ code }) => code === PRODUCT_GRAPH_UNSUPPORTED)) return diagnostics;

  // A duplicated dependency declaration was previously refused implicitly by
  // the exact N-1 relation count; series-parallel admission must keep refusing
  // it explicitly, or the importer would persist a duplicated dependency row
  // the runtime never admitted. Topology below runs on the distinct relation.
  const duplicateDependencyDeclarers: string[] = [];
  const dependencies = new Map(declaredTaskIds.map((id) => {
    const declared = declaredStrings(collections.tasks.get(id)!.dependencyTaskIds)
      .filter((dependencyId) => collections.tasks.has(dependencyId));
    const distinct = [...new Set(declared)];
    if (distinct.length !== declared.length) duplicateDependencyDeclarers.push(id);
    return [id, distinct] as const;
  }));
  const successors = new Map(declaredTaskIds.map((id) => [id, [] as string[]]));
  for (const [id, dependencyIds] of dependencies) {
    for (const dependencyId of dependencyIds) successors.get(dependencyId)!.push(id);
  }
  if (duplicateDependencyDeclarers.length > 0) {
    refuse(
      PRODUCT_GRAPH_UNSUPPORTED,
      `tasks ${list(duplicateDependencyDeclarers)} declare the same dependency more than once`,
    );
  }

  const graphHeads = declaredTaskIds.filter((id) => dependencies.get(id)!.length === 0);
  const graphTails = declaredTaskIds.filter((id) => successors.get(id)!.length === 0);
  if (graphHeads.length !== 1) {
    refuse(
      PRODUCT_GRAPH_UNSUPPORTED,
      `the task dependency graph must start at exactly one task with no predecessor; received ${list(graphHeads)}`,
    );
  } else if (entryTaskIds.length === 1 && entryTaskIds[0] !== graphHeads[0]) {
    refuse(
      PRODUCT_GRAPH_UNSUPPORTED,
      `workflow ${workflowId} declares entry task ${entryTaskIds[0]} but the dependency graph starts at ${graphHeads[0]}`,
    );
  }
  if (graphTails.length !== 1) {
    refuse(
      PRODUCT_GRAPH_UNSUPPORTED,
      `the task dependency graph must end at exactly one task with no successor; received ${list(graphTails)}`,
    );
  } else if (terminalTaskIds.length === 1 && terminalTaskIds[0] !== graphTails[0]) {
    refuse(
      PRODUCT_GRAPH_UNSUPPORTED,
      `workflow ${workflowId} declares terminal task ${terminalTaskIds[0]} but the dependency graph ends at ${graphTails[0]}`,
    );
  }

  // Reachability from the single entry proves connectivity: disjoint
  // components satisfy every local count above. The visited guard keeps a
  // cycle from looping forever here; the cycle itself is reported by the
  // shared dependency-cycle check.
  if (graphHeads.length === 1) {
    const visited = new Set<string>();
    const frontier: string[] = [graphHeads[0]!];
    while (frontier.length > 0) {
      const cursor = frontier.pop()!;
      if (visited.has(cursor)) continue;
      visited.add(cursor);
      frontier.push(...successors.get(cursor)!);
    }
    const unreachable = declaredTaskIds.filter((id) => !visited.has(id));
    if (unreachable.length > 0) {
      refuse(
        PRODUCT_GRAPH_UNSUPPORTED,
        `tasks ${list(unreachable)} are not reachable from entry task ${graphHeads[0]}`,
      );
    }
  }

  // With the local counts sound, validate the fork-join structure itself by
  // delegating to core (see seriesParallelTopologyViolation): every fork must
  // reconverge on a single matching join, nested forks included. Skipped when
  // an ordering diagnostic already fired above, because the synthesized shape
  // of an unsound graph would only report positions that do not exist.
  if (!diagnostics.some(({ code }) => code === PRODUCT_GRAPH_UNSUPPORTED)) {
    const violation = seriesParallelTopologyViolation(
      declaredTaskIds,
      successors,
      graphHeads[0]!,
      graphTails[0]!,
    );
    if (violation !== undefined) {
      refuse(
        PRODUCT_GRAPH_UNSUPPORTED,
        `the task dependency graph is not a supported series-parallel (fork-join) shape: ${violation}`,
      );
    }
  }

  // Compare the two orderings structurally rather than through an encoded
  // pair key: dependent -> set of its dependencies, on both sides.
  const relationsByDependent = new Map<string, Set<string>>();
  for (const [id, dependencyIds] of dependencies) {
    if (dependencyIds.length > 0) relationsByDependent.set(id, new Set(dependencyIds));
  }
  const declaredEdges = [...collections.edges.values()];
  const edgesByDependent = new Map<string, Set<string>>();
  for (const edge of declaredEdges) {
    const dependent = String(edge.fromTaskId);
    edgesByDependent.set(
      dependent,
      (edgesByDependent.get(dependent) ?? new Set<string>()).add(String(edge.toTaskId)),
    );
  }
  const relationsAbsentFrom = (
    left: Map<string, Set<string>>,
    right: Map<string, Set<string>>,
  ): string[] => {
    const absent: string[] = [];
    for (const [dependent, dependencyIds] of left) {
      for (const dependencyId of dependencyIds) {
        if (right.get(dependent)?.has(dependencyId) === true) continue;
        absent.push(`${dependent} depends on ${dependencyId}`);
      }
    }
    return absent.sort(compareCccPrdCodeUnits);
  };

  const edgelessRelations = relationsAbsentFrom(relationsByDependent, edgesByDependent);
  if (edgelessRelations.length > 0) {
    refuse(
      PRODUCT_GRAPH_UNSUPPORTED,
      `task dependencies ${edgelessRelations.join("; ")} have no declared dependency edge`,
    );
  }
  const undeclaredRelations = relationsAbsentFrom(edgesByDependent, relationsByDependent);
  if (undeclaredRelations.length > 0) {
    refuse(
      PRODUCT_GRAPH_UNSUPPORTED,
      `dependency edges ${undeclaredRelations.join("; ")} are not declared as task dependencies`,
    );
  }
  const distinctEdgeCount = [...edgesByDependent.values()]
    .reduce((total, dependencyIds) => total + dependencyIds.size, 0);
  if (declaredEdges.length !== distinctEdgeCount) {
    refuse(PRODUCT_GRAPH_UNSUPPORTED, "a task dependency is declared by more than one dependency edge");
  }

  const importedEdgeIds = new Set(edgeIntents.map((intent) => String(intent.entityId)));
  const unimportedEdges = declaredEdges
    .map((edge) => String(edge.id))
    .filter((id) => !importedEdgeIds.has(id))
    .sort(compareCccPrdCodeUnits);
  if (unimportedEdges.length > 0) {
    refuse(
      PRODUCT_GRAPH_UNSUPPORTED,
      `declared dependency edges ${list(unimportedEdges)} have no dependency edge import intent`,
    );
  }
  const strayEdgeIntents = [...importedEdgeIds]
    .filter((id) => !collections.edges.has(id))
    .sort(compareCccPrdCodeUnits);
  if (strayEdgeIntents.length > 0) {
    refuse(
      PRODUCT_GRAPH_UNSUPPORTED,
      `dependency edge import intents reference undeclared edges ${list(strayEdgeIntents)}`,
    );
  }

  return diagnostics;
}

function validateSidecar(
  sidecar: CccPrdSidecar,
  custody: ReturnType<typeof readCccPrdPacketCustody>,
  input: CompileCccPrdInput,
  diagnostics: CccPrdDiagnostic[],
): void {
  validateExactKeys(
    "sidecar provenance",
    sidecar.provenance as unknown as Record<string, unknown>,
    ["authoringAdapterId", "authoringModel", "proposalHash", "packetHash"],
    diagnostics,
  );
  validateExactKeys(
    "sidecar bounds",
    sidecar.bounds as unknown as Record<string, unknown>,
    ["maxRequests", "maxDurationMs", "maxConcurrency"],
    diagnostics,
  );
  validateExactKeys(
    "sidecar targetRepository",
    sidecar.targetRepository as unknown as Record<string, unknown>,
    ["path", "baseCommit"],
    diagnostics,
  );
  for (const [index, source] of sidecar.orderedSources.entries()) {
    if (!isPlainRecord(source)) {
      diagnostics.push(diagnostic("CCC_PRD_DECLARATION_INVALID", `orderedSources[${index}] must be an object`));
      continue;
    }
    validateExactKeys(
      `orderedSources[${index}]`,
      source,
      ["path", "role", "authoritative", "sha256", "byteLength"],
      diagnostics,
    );
  }
  validateStringArray("sidecar nonGoals", sidecar.nonGoals, diagnostics);

  if (sidecar.sourceVersion !== custody.sourceVersion) {
    diagnostics.push(diagnostic("CCC_PRD_SOURCE_VERSION_STALE", "sidecar sourceVersion does not match the manifest"));
  }
  if (canonicalCccPrdJson(sidecar.orderedSources) !== canonicalCccPrdJson(custody.sources)) {
    diagnostics.push(diagnostic("CCC_PRD_SOURCE_CUSTODY_STALE", "sidecar ordered source custody does not match the packet"));
  }
  if (sidecar.provenance?.packetHash !== custody.packetHash) {
    diagnostics.push(diagnostic("CCC_PRD_PACKET_HASH_STALE", "sidecar packet hash does not match admitted raw bytes"));
  }
  if (!isNonEmptyString(sidecar.provenance?.authoringAdapterId)) {
    diagnostics.push(diagnostic("CCC_PRD_PROVENANCE_MISSING", "sidecar authoring adapter provenance is missing"));
  }
  if (
    sidecar.provenance?.authoringModel !== undefined
    && !isNonEmptyString(sidecar.provenance.authoringModel)
  ) {
    diagnostics.push(diagnostic("CCC_PRD_PROVENANCE_MISSING", "sidecar authoring model provenance is malformed"));
  }
  if (!/^[0-9a-f]{64}$/.test(String(sidecar.provenance?.proposalHash))) {
    diagnostics.push(diagnostic("CCC_PRD_PROVENANCE_MISSING", "sidecar proposal hash is missing or malformed"));
  }
  if (
    !isPositiveBound(sidecar.bounds?.maxRequests)
    || !isPositiveBound(sidecar.bounds?.maxDurationMs)
    || !isPositiveBound(sidecar.bounds?.maxConcurrency)
  ) {
    diagnostics.push(diagnostic("CCC_PRD_UNBOUNDED_EXECUTION", "request, duration, and concurrency bounds must be finite positive integers"));
  }
  if (!isNonEmptyString(sidecar.targetRepository?.path)) {
    diagnostics.push(diagnostic("CCC_PRD_TARGET_MISSING", "target repository path is missing"));
  }
  if (!/^[0-9a-f]{40}$/.test(String(sidecar.targetRepository?.baseCommit))) {
    diagnostics.push(diagnostic("CCC_PRD_BASE_INVALID", "target repository base must be a full 40-character commit"));
  }
  if (input.expectedTarget && sidecar.targetRepository?.path !== input.expectedTarget) {
    diagnostics.push(diagnostic("CCC_PRD_FOREIGN_TARGET", "sidecar target repository does not match the admitted target"));
  }
  if (input.expectedBase && sidecar.targetRepository?.baseCommit !== input.expectedBase) {
    diagnostics.push(diagnostic("CCC_PRD_FOREIGN_BASE", "sidecar base commit does not match the admitted base"));
  }
  if (!Array.isArray(sidecar.admittedWriteRoots) || sidecar.admittedWriteRoots.length === 0) {
    diagnostics.push(diagnostic("CCC_PRD_WRITE_ROOT_MISSING", "at least one admitted write root is required"));
  } else {
    for (const root of sidecar.admittedWriteRoots) {
      if (!isPlainRecord(root) || !isNonEmptyString(root.path) || !isNonEmptyString(root.purpose)) {
        diagnostics.push(diagnostic("CCC_PRD_WRITE_ROOT_INVALID", "admitted write roots need path and purpose"));
      } else {
        validateExactKeys("admitted write root", root, ["path", "purpose"], diagnostics);
        if (containsProtectedCccPrdSegment(root.path)) {
          diagnostics.push(diagnostic("CCC_PRD_PROTECTED_PATH", `admitted write root is protected: ${root.path}`));
        }
      }
    }
  }
  for (const [label, values] of [
    ["unresolved decision", sidecar.unresolvedDecisions],
    ["ambiguity", sidecar.ambiguities],
    ["exception", sidecar.exceptions],
  ] as const) {
    for (const [index, value] of values.entries()) {
      if (!isPlainRecord(value)) {
        diagnostics.push(diagnostic("CCC_PRD_DECLARATION_INVALID", `${label}[${index}] must be an object`));
        continue;
      }
      const record = value as unknown as Record<string, unknown>;
      validateExactKeys(
        `${label}[${index}]`,
        record,
        label === "unresolved decision"
          ? ["id", "question", "state", "spans"]
          : ["id", "message", "spans"],
        diagnostics,
      );
      const message = label === "unresolved decision" ? record.question : record.message;
      if (!isNonEmptyString(record.id) || !isNonEmptyString(message)) {
        diagnostics.push(diagnostic("CCC_PRD_DECLARATION_INVALID", `${label}[${index}] is incomplete`));
      }
      if (label === "unresolved decision" && record.state !== "unresolved") {
        diagnostics.push(diagnostic("CCC_PRD_DECLARATION_INVALID", `${label}[${index}] state is invalid`));
      }
      validateSpans(label, record, custody.sourceBytes, diagnostics);
    }
  }
  if (sidecar.unresolvedDecisions.length > 0) {
    diagnostics.push(diagnostic("CCC_PRD_UNRESOLVED_DECISION", "sidecar contains unresolved decisions"));
  }
  if (sidecar.ambiguities.length > 0) {
    diagnostics.push(diagnostic("CCC_PRD_UNRESOLVED_AMBIGUITY", "sidecar contains unresolved ambiguities"));
  }
  if (sidecar.exceptions.length > 0) {
    diagnostics.push(diagnostic("CCC_PRD_UNRESOLVED_EXCEPTION", "sidecar contains unresolved exceptions"));
  }

  const collections = {
    authorityRoles: validateUniqueIds("authorityRoles", sidecar.authorityRoles, diagnostics),
    requirements: validateUniqueIds("requirements", sidecar.requirements, diagnostics),
    proofs: validateUniqueIds("proofs", sidecar.proofs, diagnostics),
    tasks: validateUniqueIds("tasks", sidecar.tasks, diagnostics),
    edges: validateUniqueIds("edges", sidecar.edges, diagnostics),
    workflows: validateUniqueIds("workflows", sidecar.workflows, diagnostics),
    documents: validateUniqueIds("documents", sidecar.documents, diagnostics),
    artifacts: validateUniqueIds("artifacts", sidecar.artifacts, diagnostics),
    importIntents: validateUniqueIds("importIntents", sidecar.importIntents, diagnostics),
    protectedActions: validateUniqueIds("protectedActions", sidecar.protectedActions, diagnostics),
  };
  // Dependency edges, documents, artifacts, and protected actions are optional
  // semantic declarations. Requiring a fabricated row in each collection makes
  // a valid single-task PRD impossible to represent without inventing product
  // meaning. The executable spine itself must still be non-empty.
  for (const name of [
    "authorityRoles",
    "requirements",
    "proofs",
    "tasks",
    "workflows",
    "importIntents",
  ] as const) {
    const values = collections[name];
    if (values.size === 0) {
      diagnostics.push(diagnostic("CCC_PRD_DECLARATION_MISSING", `sidecar ${name} must be non-empty`));
    }
  }

  const admittedPaths = new Set(custody.sources.map((source) => source.path));
  for (const value of collections.authorityRoles.values()) {
    validateExactKeys(
      `authority role ${String(value.id)}`,
      value,
      ["id", "role", "sourcePaths", "accountableProducer"],
      diagnostics,
    );
    if (!AUTHORITY_ROLE_VALUES.has(String(value.role))) {
      diagnostics.push(diagnostic("CCC_PRD_AUTHORITY_INVALID", `authority role ${String(value.id)} has invalid role`));
    }
    if (validateStringArray(
      `authority role ${String(value.id)} sourcePaths`,
      value.sourcePaths,
      diagnostics,
      { nonEmpty: true },
    )) {
      for (const path of value.sourcePaths) {
        if (!admittedPaths.has(path)) {
          diagnostics.push(diagnostic("CCC_PRD_AUTHORITY_FOREIGN", `authority role ${String(value.id)} references ${String(path)}`));
        }
      }
    }
    if (!isNonEmptyString(value.accountableProducer)) {
      diagnostics.push(diagnostic("CCC_PRD_AUTHORITY_MISSING", `authority role ${String(value.id)} has no accountable producer`));
    }
  }

  for (const [name, values] of Object.entries(collections)) {
    if (["edges", "importIntents", "authorityRoles"].includes(name)) continue;
    for (const value of values.values()) {
      validateSpans(name, value, custody.sourceBytes, diagnostics);
    }
  }

  for (const requirement of collections.requirements.values()) {
    validateExactKeys(
      `requirement ${String(requirement.id)}`,
      requirement,
      ["id", "statement", "acceptance", "accountableProducer", "dependencies", "proofIds", "spans", "confidence"],
      diagnostics,
    );
    if (
      !isNonEmptyString(requirement.statement)
      || !isNonEmptyString(requirement.acceptance)
      || !isNonEmptyString(requirement.accountableProducer)
    ) {
      diagnostics.push(diagnostic("CCC_PRD_REQUIREMENT_INVALID", `requirement ${String(requirement.id)} is incomplete`));
    }
    validateConfidence(`requirement ${String(requirement.id)}`, requirement.confidence, diagnostics);
    optionalReferences(
      `requirement ${String(requirement.id)} dependencies`,
      requirement.dependencies,
      collections.requirements,
      diagnostics,
    );
    requireReferences(
      `requirement ${String(requirement.id)} proofs`,
      requirement.proofIds,
      collections.proofs,
      diagnostics,
    );
  }
  const requirementCycle = detectDependencyCycle(collections.requirements, "dependencies");
  if (requirementCycle) {
    diagnostics.push(diagnostic("CCC_PRD_DEPENDENCY_CYCLE", `requirement dependency cycle includes ${requirementCycle}`));
  }

  for (const proof of collections.proofs.values()) {
    validateExactKeys(
      `proof ${String(proof.id)}`,
      proof,
      [
        "id",
        "requirementIds",
        "command",
        "positiveOracle",
        "negativeControls",
        "spans",
        "confidence",
        "admission",
      ],
      diagnostics,
    );
    requireReferences(`proof ${String(proof.id)}`, proof.requirementIds, collections.requirements, diagnostics);
    if (
      !isNonEmptyString(proof.command)
      || !isNonEmptyString(proof.positiveOracle)
      || !Array.isArray(proof.negativeControls)
      || proof.negativeControls.length === 0
      || proof.negativeControls.some((control) => !isNonEmptyString(control))
    ) {
      diagnostics.push(diagnostic("CCC_PRD_PROOF_INVALID", `proof ${String(proof.id)} is incomplete`));
    }
    validateConfidence(`proof ${String(proof.id)}`, proof.confidence, diagnostics);
    validateProofAdmission(proof, diagnostics);
  }

  for (const task of collections.tasks.values()) {
    validateExactKeys(
      `task ${String(task.id)}`,
      task,
      [
        "id",
        "title",
        "description",
        "accountableProducer",
        "requirementIds",
        "dependencyTaskIds",
        "proofIds",
        "workflowId",
        "documentIds",
        "artifactIds",
        "protectedActionIds",
        "ownedPaths",
        "allowedWriteRoots",
        "spans",
      ],
      diagnostics,
    );
    if (
      !isNonEmptyString(task.title)
      || !isNonEmptyString(task.description)
      || !isNonEmptyString(task.accountableProducer)
    ) {
      diagnostics.push(diagnostic("CCC_PRD_TASK_INVALID", `task ${String(task.id)} is incomplete`));
    }
    requireReferences(`task ${String(task.id)} requirements`, task.requirementIds, collections.requirements, diagnostics);
    optionalReferences(`task ${String(task.id)} dependencies`, task.dependencyTaskIds, collections.tasks, diagnostics);
    requireReferences(`task ${String(task.id)} proofs`, task.proofIds, collections.proofs, diagnostics);
    optionalReferences(`task ${String(task.id)} documents`, task.documentIds, collections.documents, diagnostics);
    optionalReferences(`task ${String(task.id)} artifacts`, task.artifactIds, collections.artifacts, diagnostics);
    optionalReferences(
      `task ${String(task.id)} protected actions`,
      task.protectedActionIds,
      collections.protectedActions,
      diagnostics,
    );
    // Mirrors packages/core/src/ccc-campaign/store.ts requireCanonicalProtectedActionIds: campaign
    // context resolution fails closed at runtime unless the set is well-formed (non-empty, already
    // trimmed strings), duplicate-free, and sorted canonically. Refuse it here too, before a
    // hand-edited sidecar can validate/compile clean and only fail mid workflow-run.
    if (Array.isArray(task.protectedActionIds)) {
      const protectedActionIds = task.protectedActionIds as unknown[];
      const wellFormed = protectedActionIds.every((id) => isWellFormedProtectedActionId(id));
      if (!wellFormed || !isCanonicalProtectedActionIdSet(protectedActionIds as string[])) {
        diagnostics.push(diagnostic(
          "CCC_PRD_PROTECTED_ACTION_IDS_NOT_CANONICAL",
          `task ${String(task.id)} protected-action IDs must be non-empty, trimmed, unique, and sorted canonically`,
        ));
      }
    }
    if (!isNonEmptyString(task.workflowId) || !collections.workflows.has(task.workflowId)) {
      diagnostics.push(diagnostic("CCC_PRD_REFERENCE_FOREIGN", `task ${String(task.id)} workflow is unknown`));
    }
  }
  const taskCycle = detectDependencyCycle(collections.tasks, "dependencyTaskIds");
  if (taskCycle) {
    diagnostics.push(diagnostic("CCC_PRD_DEPENDENCY_CYCLE", `task dependency cycle includes ${taskCycle}`));
  }
  const requirementTaskIds = new Set<string>();
  for (const task of collections.tasks.values()) {
    if (!Array.isArray(task.requirementIds)) continue;
    for (const requirementId of task.requirementIds) {
      if (typeof requirementId === "string") requirementTaskIds.add(requirementId);
    }
  }
  for (const requirementId of collections.requirements.keys()) {
    if (!requirementTaskIds.has(requirementId)) {
      diagnostics.push(diagnostic(
        "CCC_PRD_REQUIREMENT_UNDISPOSITIONED",
        `requirement ${requirementId} has no task disposition`,
      ));
    }
  }

  for (const edge of collections.edges.values()) {
    validateExactKeys(
      `dependency edge ${String(edge.id)}`,
      edge,
      ["id", "fromTaskId", "toTaskId", "kind"],
      diagnostics,
    );
    if (
      !isNonEmptyString(edge.fromTaskId)
      || !collections.tasks.has(edge.fromTaskId)
      || !isNonEmptyString(edge.toTaskId)
      || !collections.tasks.has(edge.toTaskId)
      || edge.fromTaskId === edge.toTaskId
      || edge.kind !== "depends_on"
    ) {
      diagnostics.push(diagnostic("CCC_PRD_EDGE_INVALID", `dependency edge ${String(edge.id)} is inconsistent`));
    }
  }
  for (const workflow of collections.workflows.values()) {
    validateExactKeys(
      `workflow ${String(workflow.id)}`,
      workflow,
      ["id", "title", "taskIds", "entryTaskIds", "terminalTaskIds", "spans"],
      diagnostics,
    );
    if (!isNonEmptyString(workflow.title)) {
      diagnostics.push(diagnostic("CCC_PRD_WORKFLOW_INVALID", `workflow ${String(workflow.id)} has no title`));
    }
    requireReferences(`workflow ${String(workflow.id)} tasks`, workflow.taskIds, collections.tasks, diagnostics);
    requireReferences(`workflow ${String(workflow.id)} entries`, workflow.entryTaskIds, collections.tasks, diagnostics);
    requireReferences(`workflow ${String(workflow.id)} terminals`, workflow.terminalTaskIds, collections.tasks, diagnostics);
  }
  for (const document of collections.documents.values()) {
    validateExactKeys(
      `document ${String(document.id)}`,
      document,
      ["id", "taskId", "key", "title", "content", "spans"],
      diagnostics,
    );
    if (
      !isNonEmptyString(document.taskId)
      || !collections.tasks.has(document.taskId)
      || !isNonEmptyString(document.key)
      || !isNonEmptyString(document.title)
      || !isNonEmptyString(document.content)
    ) {
      diagnostics.push(diagnostic("CCC_PRD_DOCUMENT_INVALID", `document ${String(document.id)} is incomplete`));
    }
  }
  for (const artifact of collections.artifacts.values()) {
    validateExactKeys(
      `artifact ${String(artifact.id)}`,
      artifact,
      ["id", "taskId", "type", "title", "mimeType", "content", "spans"],
      diagnostics,
    );
    if (
      !isNonEmptyString(artifact.taskId)
      || !collections.tasks.has(artifact.taskId)
      || !isNonEmptyString(artifact.type)
      || !isNonEmptyString(artifact.title)
      || !isNonEmptyString(artifact.mimeType)
      || !isNonEmptyString(artifact.content)
    ) {
      diagnostics.push(diagnostic("CCC_PRD_ARTIFACT_INVALID", `artifact ${String(artifact.id)} must be inline text metadata`));
    }
  }
  for (const action of collections.protectedActions.values()) {
    validateExactKeys(
      `protected action ${String(action.id)}`,
      action,
      ["id", "kind", "target", "operatorDecision", "requiresOperatorDecision", "spans"],
      diagnostics,
    );
    try {
      const expected = normalizeProtectedAction({
        id: String(action.id),
        kind: String(action.kind),
        target: String(action.target),
        spans: action.spans as CccPrdSourceSpan[],
      });
      if (canonicalCccPrdJson(action) !== canonicalCccPrdJson(expected)) {
        diagnostics.push(diagnostic("CCC_PRD_PROTECTED_ACTION_INVALID", `protected action ${String(action.id)} is inconsistent`));
      }
    } catch {
      diagnostics.push(diagnostic("CCC_PRD_PROTECTED_ACTION_INVALID", `protected action ${String(action.id)} is invalid`));
    }
  }

  const entityMaps = new Map<string, Map<string, unknown>>([
    ["task", collections.tasks],
    ["dependency_edge", collections.edges],
    ["workflow", collections.workflows],
    ["document", collections.documents],
    ["artifact", collections.artifacts],
  ]);
  const intentsByType = new Map<string, Record<string, unknown>[]>();
  for (const intent of collections.importIntents.values()) {
    validateExactKeys(
      `import intent ${String(intent.id)}`,
      intent,
      ["id", "entityType", "entityId", "operation", "target"],
      diagnostics,
    );
    if (
      !isNonEmptyString(intent.entityType)
      || !IMPORT_ENTITY_VALUES.has(intent.entityType)
      || !isNonEmptyString(intent.entityId)
      || intent.operation !== "create"
      || !isNonEmptyString(intent.target)
    ) {
      diagnostics.push(diagnostic("CCC_PRD_IMPORT_INTENT_INVALID", `import intent ${String(intent.id)} is incomplete`));
      continue;
    }
    const typedIntents = intentsByType.get(intent.entityType) ?? [];
    typedIntents.push(intent);
    intentsByType.set(intent.entityType, typedIntents);
    if (intent.target !== IMPORT_TARGETS.get(intent.entityType)) {
      diagnostics.push(diagnostic("CCC_PRD_IMPORT_INTENT_INVALID", `import intent ${String(intent.id)} has invalid native target`));
    }
    const target = entityMaps.get(intent.entityType);
    if (target && !target.has(intent.entityId)) {
      diagnostics.push(diagnostic("CCC_PRD_IMPORT_INTENT_INVALID", `import intent ${String(intent.id)} references unknown entity`));
    }
    if (intent.entityType === "work_item" && !collections.workflows.has(intent.entityId)) {
      diagnostics.push(diagnostic("CCC_PRD_IMPORT_INTENT_INVALID", `import intent ${String(intent.id)} references unknown workflow`));
    }
  }
  for (const entityType of [
    "campaign",
    "source",
    "run_audit",
    "workflow",
    "work_item",
  ]) {
    const intents = intentsByType.get(entityType) ?? [];
    if (intents.length !== 1) {
      diagnostics.push(diagnostic("CCC_PRD_IMPORT_INTENT_CARDINALITY", `sidecar requires exactly one ${entityType} import intent; received ${intents.length}`));
    }
  }
  const campaign = intentsByType.get("campaign")?.[0];
  for (const intent of intentsByType.get("run_audit") ?? []) {
    if (intent.entityId !== campaign?.entityId) {
      diagnostics.push(diagnostic("CCC_PRD_IMPORT_INTENT_INVALID", `run audit import intent ${String(intent.id)} must reference the campaign entity`));
    }
  }
  const workflowIntents = intentsByType.get("workflow") ?? [];
  const workItemIntents = intentsByType.get("work_item") ?? [];
  if (
    workflowIntents.length === 1
    && workItemIntents.length === 1
    && workItemIntents[0]!.entityId !== workflowIntents[0]!.entityId
  ) {
    diagnostics.push(diagnostic(
      "CCC_PRD_IMPORT_INTENT_INVALID",
      `work item import intent ${String(workItemIntents[0]!.id)} must reference the sole imported workflow ${String(workflowIntents[0]!.entityId)}`,
    ));
  }

  if (
    input.requireMaterialCoverage
    && workflowIntents.length === 1
    && workItemIntents.length === 1
  ) {
    diagnostics.push(...productGraphAdmissionDiagnostics(
      collections,
      intentsByType.get("task") ?? [],
      intentsByType.get("dependency_edge") ?? [],
      workflowIntents[0]!,
      workItemIntents[0]!,
    ));
  }

  if (input.requireMaterialCoverage || sidecar.materialCoverage !== undefined) {
    const analysis = analyzeCccPrdMaterialCoverage({
      sourceBytes: custody.sourceBytes,
      requirements: sidecar.requirements,
      tasks: sidecar.tasks,
      unresolvedDecisions: sidecar.unresolvedDecisions,
    });
    if (!Array.isArray(sidecar.materialCoverage)) {
      diagnostics.push(diagnostic(
        "CCC_PRD_MATERIAL_COVERAGE_REQUIRED",
        "supported product intake requires a generated material coverage inventory",
      ));
    } else if (
      canonicalCccPrdJson(sidecar.materialCoverage)
      !== canonicalCccPrdJson(analysis.coverage)
    ) {
      diagnostics.push(diagnostic(
        "CCC_PRD_MATERIAL_COVERAGE_INVALID",
        "material coverage does not match the deterministic inventory and dispositions derived from admitted bytes",
      ));
    }

    if (!input.requireMaterialCoverage) return;
    if (
      sidecar.implementationFactProvenance !== undefined
      && sidecar.implementationFactProvenance.schema !== CCC_PRD_IMPLEMENTATION_FACT_PROVENANCE_SCHEMA_VERSION
    ) {
      diagnostics.push(diagnostic(
        "CCC_PRD_IMPLEMENTATION_FACT_PROVENANCE_INVALID",
        `implementation fact provenance schema must be ${CCC_PRD_IMPLEMENTATION_FACT_PROVENANCE_SCHEMA_VERSION}`,
      ));
    }
    diagnostics.push(...validateCccPrdImplementationFactProvenance({
      sourceBytes: custody.sourceBytes,
      facts: sidecar,
      provenance: sidecar.implementationFactProvenance,
    }));
    if (analysis.conflicts.length > 0) {
      const sample = analysis.conflicts.slice(0, 5).map((item) => (
        `${item.sourcePath}:${item.spans[0]!.line} ${item.title}`
      ));
      diagnostics.push(diagnostic(
        "CCC_PRD_MATERIAL_COVERAGE_INVALID",
        `material items have conflicting task, deferral, out-of-scope, or unresolved dispositions (${analysis.conflicts.length}): ${sample.join("; ")}`,
      ));
    }
    const missingSections = analysis.missing.filter(({ materialKind }) => materialKind === "section");
    if (missingSections.length > 0) {
      const sample = missingSections.slice(0, 5).map((item) => (
        `${item.sourcePath}:${item.spans[0]!.line} ${item.title}`
      ));
      diagnostics.push(diagnostic(
        "CCC_PRD_MATERIAL_SECTION_UNDISPOSITIONED",
        `material source sections need a task, explicit deferral, out-of-scope decision, or unresolved question (${missingSections.length}): ${sample.join("; ")}`,
      ));
    }
    const missingRequirements = analysis.missing.filter(({ materialKind }) => materialKind === "requirement");
    if (missingRequirements.length > 0) {
      const sample = missingRequirements.slice(0, 8).map((item) => (
        `${item.sourcePath}:${item.spans[0]!.line} ${item.title}`
      ));
      diagnostics.push(diagnostic(
        "CCC_PRD_SOURCE_REQUIREMENT_UNDISPOSITIONED",
        `explicit source requirements need a task, explicit deferral, out-of-scope decision, or unresolved question (${missingRequirements.length}): ${sample.join("; ")}`,
      ));
    }
    const resolvedCount = analysis.coverage.length;
    const materialCount = analysis.inventory.length;
    if (
      materialCount >= 4
      && (
        analysis.missing.length > 0
        || analysis.conflicts.length > 0
      )
      && resolvedCount / materialCount < 0.8
    ) {
      diagnostics.push(diagnostic(
        "CCC_PRD_EXTRACTION_IMPLAUSIBLY_SHALLOW",
        `material extraction disposed ${resolvedCount} of ${materialCount} deterministic source items`,
      ));
    }
  }
}

function checkCccPrdPacket(input: CompileCccPrdInput): CheckedSidecar {
  const diagnostics: CccPrdDiagnostic[] = [];
  if (!input.sidecarPath) {
    return { diagnostics: [diagnostic("CCC_PRD_SIDECAR_REQUIRED", "compile and validate require a generated sidecar")] };
  }
  try {
    const custody = readCccPrdPacketCustody(input);
    const sidecarPath = resolveCccPrdAdmittedFile(custody.rootDir, input.sidecarPath, "sidecar");
    const sidecarBytes = readFileSync(sidecarPath);
    let value: unknown;
    try {
      value = JSON.parse(sidecarBytes.toString("utf8"));
    } catch {
      return { diagnostics: [diagnostic("CCC_PRD_SIDECAR_READ_FAILED", "sidecar is not valid JSON")] };
    }
    if (!validateTopLevelShape(value, diagnostics)) {
      return { diagnostics: stableDiagnostics(diagnostics) };
    }
    validateSidecar(value, custody, input, diagnostics);
    return {
      sidecar: value,
      sidecarHash: sha256(sidecarBytes),
      diagnostics: stableDiagnostics(diagnostics),
    };
  } catch (error) {
    if (error instanceof CccPrdCustodyError) {
      return { diagnostics: [diagnostic(error.code, error.message)] };
    }
    return {
      diagnostics: [diagnostic(
        "CCC_PRD_READ_FAILED",
        error instanceof Error ? error.message : "packet could not be read",
      )],
    };
  }
}

export function validateCccPrdPacket(input: CompileCccPrdInput): CccPrdValidationResult {
  const checked = checkCccPrdPacket(input);
  return {
    kind: "validation",
    valid: checked.diagnostics.length === 0,
    diagnostics: checked.diagnostics,
  };
}

export function compileCccPrdPacket(input: CompileCccPrdInput): CccPrdSemanticBundle | CccPrdRefusalBundle {
  const checked = checkCccPrdPacket(input);
  if (!checked.sidecar || !checked.sidecarHash || checked.diagnostics.length > 0) {
    return { kind: "refusal", diagnostics: checked.diagnostics };
  }
  const sidecar = checked.sidecar;
  const bundleWithoutHash = {
    kind: "bundle" as const,
    schema: CCC_PRD_BUNDLE_SCHEMA_VERSION,
    sourceHash: sidecar.provenance.packetHash,
    sidecarHash: checked.sidecarHash,
    sourceVersion: sidecar.sourceVersion,
    orderedSources: sidecar.orderedSources,
    provenance: sidecar.provenance,
    authorityRoles: sortCccPrdById(sidecar.authorityRoles),
    requirements: sortCccPrdById(sidecar.requirements),
    proofs: sortCccPrdById(sidecar.proofs),
    tasks: sortCccPrdById(sidecar.tasks),
    edges: sortCccPrdById(sidecar.edges),
    workflows: sortCccPrdById(sidecar.workflows),
    documents: sortCccPrdById(sidecar.documents),
    artifacts: sortCccPrdById(sidecar.artifacts),
    importIntents: sortCccPrdById(sidecar.importIntents),
    protectedActions: sortCccPrdById(sidecar.protectedActions),
    bounds: sidecar.bounds,
    admittedWriteRoots: sidecar.admittedWriteRoots,
    targetRepository: sidecar.targetRepository,
    nonGoals: sidecar.nonGoals,
    ...(sidecar.materialCoverage ? { materialCoverage: sidecar.materialCoverage } : {}),
    ...(sidecar.implementationFactProvenance ? { implementationFactProvenance: sidecar.implementationFactProvenance } : {}),
    confidence: sidecar.confidence,
  };
  return {
    ...bundleWithoutHash,
    bundleHash: sha256(canonicalCccPrdJson(bundleWithoutHash)),
  };
}

export function validateNeoCandidate(candidate: unknown): {
  valid: boolean;
  dispatch: CccPrdRefusalBundle;
} {
  const value = candidate as { schema_id?: string; status?: string };
  const valid = value.schema_id === "autonomous_builder_handoff_candidate.v1"
    && value.status === "READY_FOR_COLD_REVIEW";
  return {
    valid,
    dispatch: createRefusalBundle({
      code: "CCC_PRD_DISPATCH_REFUSED",
      message: valid
        ? "READY_FOR_COLD_REVIEW is validation-only"
        : "candidate is not valid for dispatch",
    }),
  };
}
