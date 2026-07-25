import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, win32 } from "node:path";
import {
  CCC_PRD_BUNDLE_SCHEMA_VERSION,
  CCC_PRD_PROOF_ADMISSION_SCHEMA_VERSION,
  CCC_PRD_SIDECAR_SCHEMA_VERSION,
  canonicalCccPrdJson,
  compareCccPrdCodeUnits,
  computeCccPrdProofDefinitionSha256,
  createCccPrdSpanFromBytes,
  createRefusalBundle,
  normalizeProtectedAction,
  type CccPrdDiagnostic,
  type CccPrdProof,
  type CccPrdRefusalBundle,
  type CccPrdSemanticBundle,
  type CccPrdSidecar,
  type CccPrdSourceSpan,
  type CccPrdValidationResult,
} from "@fusion/core";
import {
  CccPrdCustodyError,
  containsProtectedCccPrdSegment,
  readCccPrdPacketCustody,
  resolveCccPrdAdmittedFile,
  sortCccPrdById,
} from "./custody.js";

export type CompileCccPrdInput = {
  rootDir: string;
  manifestPath: string;
  sidecarPath?: string;
  expectedTarget?: string;
  expectedBase?: string;
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
  for (const [name, values] of Object.entries(collections)) {
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
    if (!isNonEmptyString(task.workflowId) || !collections.workflows.has(task.workflowId)) {
      diagnostics.push(diagnostic("CCC_PRD_REFERENCE_FOREIGN", `task ${String(task.id)} workflow is unknown`));
    }
  }
  const taskCycle = detectDependencyCycle(collections.tasks, "dependencyTaskIds");
  if (taskCycle) {
    diagnostics.push(diagnostic("CCC_PRD_DEPENDENCY_CYCLE", `task dependency cycle includes ${taskCycle}`));
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
  for (const entityType of ["campaign", "source", "run_audit"]) {
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
