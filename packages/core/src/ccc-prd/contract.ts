import { createHash } from "node:crypto";
import type {
  CccPrdAcceptanceDisposition,
  CccPrdDiagnostic,
  CccPrdImplementationFactBinding,
  CccPrdImplementationFactProvenance,
  CccPrdLinkedRuntimeEntry,
  CccPrdMaterialCoverageDisposition,
  CccPrdMaterialCoverageItem,
  CccPrdOperatorDecision,
  CccPrdProof,
  CccPrdProofCase,
  CccPrdProofExecutionToolchain,
  CccPrdProofV2,
  CccPrdProtectedActionIntent,
  CccPrdProtectedActionKind,
  CccPrdRefusalBundle,
  CccPrdSemanticBundle,
  CccPrdSemanticBundleV1,
  CccPrdSemanticBundleV2,
  CccPrdSourceSpan,
  CccPrdTask,
  CccPrdVerifierClosureEntry,
} from "./types.js";
import {
  CCC_PRD_BUNDLE_V1_SCHEMA_VERSION,
  CCC_PRD_BUNDLE_V2_SCHEMA_VERSION,
  CCC_PRD_PROOF_V2_SCHEMA_VERSION,
} from "./types.js";

const decisions: Record<CccPrdProtectedActionKind, CccPrdOperatorDecision> = {
  promotion: "approve_promotion",
  live_execution: "approve_live_execution",
  deletion: "approve_deletion",
  merge: "approve_merge",
  publication: "approve_publication",
  credential: "approve_credential_use",
  billing: "approve_billing",
  upstream_write: "approve_upstream_write",
};

/**
 * The legal protected-action kinds, derived from `decisions` so the two cannot
 * drift. Every one of them names an action an operator must approve because it
 * is irreversible, outward-facing, or spends money or authority -- which is
 * why ordinary work such as creating a file has no entry here and should not
 * acquire one.
 */
export const CCC_PRD_PROTECTED_ACTION_KINDS: readonly CccPrdProtectedActionKind[] =
  Object.keys(decisions) as CccPrdProtectedActionKind[];

export function compareCccPrdCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/*
Every rejection here names the JSON path that caused it, and the value where
one is printable. These fire on model-authored content that reached assembly
with fields nobody enumerated -- an oversized numeric literal in a field the
model invented is Infinity after JSON.parse -- so "numbers must be finite" with
no location leaves a whole run undiagnosable.
*/
function canonicalJson(value: unknown, seen: Set<object>, path: string): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`CCC PRD canonical JSON numbers must be finite (at ${path}: ${String(value)})`);
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error(`CCC PRD canonical JSON must not contain cycles (at ${path})`);
    seen.add(value);
    const result = `[${value.map((entry, index) => canonicalJson(entry, seen, `${path}[${index}]`)).join(",")}]`;
    seen.delete(value);
    return result;
  }
  if (typeof value === "object") {
    const object = value as object;
    if (seen.has(object)) throw new Error(`CCC PRD canonical JSON must not contain cycles (at ${path})`);
    const prototype = Object.getPrototypeOf(object);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`CCC PRD canonical JSON values must be plain objects (at ${path})`);
    }
    seen.add(object);
    const result = `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareCccPrdCodeUnits(left, right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry, seen, `${path}.${key}`)}`)
      .join(",")}}`;
    seen.delete(object);
    return result;
  }
  throw new Error(`CCC PRD canonical JSON values must be JSON-compatible (at ${path}: ${typeof value})`);
}

export function canonicalCccPrdJson(value: unknown): string {
  return canonicalJson(value, new Set<object>(), "$");
}

function sha256CanonicalCccPrdJson(value: unknown): string {
  return createHash("sha256")
    .update(canonicalCccPrdJson(value), "utf8")
    .digest("hex");
}

export function computeCccPrdProofDefinitionSha256(proof: CccPrdProof): string {
  const schema = (proof as { schema?: unknown }).schema;
  if (schema === CCC_PRD_PROOF_V2_SCHEMA_VERSION) {
    return sha256CanonicalCccPrdJson(
      projectCccPrdProofV2DefinitionForHash(proof as CccPrdProofV2),
    );
  }
  if (schema !== undefined) {
    throw new Error(`unsupported CCC PRD proof schema: ${String(schema)}`);
  }
  return sha256CanonicalCccPrdJson({
    id: proof.id,
    requirementIds: proof.requirementIds,
    command: proof.command,
    positiveOracle: proof.positiveOracle,
    negativeControls: proof.negativeControls,
    spans: proof.spans,
    confidence: proof.confidence,
  });
}

function sortedStrings(values: readonly string[]): string[] {
  return [...values].sort(compareCccPrdCodeUnits);
}

function sortByCanonicalValue<T>(values: readonly T[]): T[] {
  return [...values].sort((left, right) =>
    compareCccPrdCodeUnits(canonicalCccPrdJson(left), canonicalCccPrdJson(right)));
}

function sortedSpans<T extends CccPrdSourceSpan>(spans: readonly T[]): T[] {
  return sortByCanonicalValue(spans);
}

function sortedProofCases(cases: readonly CccPrdProofCase[]): CccPrdProofCase[] {
  return sortByCanonicalValue(cases);
}

function sortedVerifierClosure(
  closure: readonly CccPrdVerifierClosureEntry[],
): CccPrdVerifierClosureEntry[] {
  return sortByCanonicalValue(closure);
}

function sortedLinkedRuntime(
  linkedRuntime: readonly CccPrdLinkedRuntimeEntry[],
): CccPrdLinkedRuntimeEntry[] {
  return sortByCanonicalValue(linkedRuntime);
}

function canonicalExecutionToolchain(toolchain: CccPrdProofExecutionToolchain) {
  return {
    task: toolchain.task,
    node: toolchain.node,
    proofHost: toolchain.proofHost,
    linkedRuntime: sortedLinkedRuntime(toolchain.linkedRuntime),
  };
}

export function computeCccPrdVerifierClosureSha256(
  closure: readonly CccPrdVerifierClosureEntry[],
): string {
  return sha256CanonicalCccPrdJson(sortedVerifierClosure(closure));
}

export function computeCccPrdCandidateInputsSha256(
  candidateInputs: readonly string[],
): string {
  return sha256CanonicalCccPrdJson(sortedStrings(candidateInputs));
}

export function computeCccPrdProofExecutionToolchainSha256(
  toolchain: CccPrdProofExecutionToolchain,
): string {
  return sha256CanonicalCccPrdJson(canonicalExecutionToolchain(toolchain));
}

export function computeCccPrdProofV2AdmissionDigests(proof: CccPrdProofV2) {
  return {
    verifierClosureSha256: computeCccPrdVerifierClosureSha256(proof.verifierClosure),
    candidateInputsSha256: computeCccPrdCandidateInputsSha256(proof.candidateInputs),
    executionToolchainSha256: computeCccPrdProofExecutionToolchainSha256(
      proof.executionToolchain,
    ),
  };
}

/**
 * Canonical proof-v2 definition shared by compiler, admission, persistence,
 * and execution. Admission is deliberately excluded because it contains this
 * definition's digest. Every array here is a semantic set and is sorted by
 * UTF-16 code-unit order before hashing; caller order cannot create a second
 * identity for the same authority.
 */
export function projectCccPrdProofV2DefinitionForHash(proof: CccPrdProofV2) {
  return {
    schema: proof.schema,
    id: proof.id,
    requirementIds: sortedStrings(proof.requirementIds),
    clauseIds: sortedStrings(proof.clauseIds),
    phases: sortedStrings(proof.phases),
    command: proof.command,
    positiveOracle: proof.positiveOracle,
    positiveCases: sortedProofCases(proof.positiveCases),
    negativeControls: sortedProofCases(proof.negativeControls),
    verifierClosure: sortedVerifierClosure(proof.verifierClosure),
    candidateInputs: sortedStrings(proof.candidateInputs),
    executionToolchain: canonicalExecutionToolchain(proof.executionToolchain),
    spans: sortedSpans(proof.spans),
    confidence: proof.confidence,
  };
}

export type CccPrdSemanticBundleHashInput =
  | Omit<CccPrdSemanticBundleV1, "bundleHash">
  | Omit<CccPrdSemanticBundleV2, "bundleHash">;

function canonicalAcceptanceDisposition(disposition: CccPrdAcceptanceDisposition) {
  return {
    ...disposition,
    span: disposition.span,
  };
}

function canonicalTask(task: CccPrdTask): CccPrdTask {
  return {
    ...task,
    requirementIds: sortedStrings(task.requirementIds),
    dependencyTaskIds: sortedStrings(task.dependencyTaskIds),
    proofIds: sortedStrings(task.proofIds),
    documentIds: sortedStrings(task.documentIds),
    artifactIds: sortedStrings(task.artifactIds),
    protectedActionIds: sortedStrings(task.protectedActionIds),
    ...(task.ownedPaths ? { ownedPaths: sortedStrings(task.ownedPaths) } : {}),
    ...(task.allowedWriteRoots
      ? { allowedWriteRoots: sortedStrings(task.allowedWriteRoots) }
      : {}),
    spans: sortedSpans(task.spans),
  };
}

function canonicalCoverageDisposition(
  disposition: CccPrdMaterialCoverageDisposition,
): CccPrdMaterialCoverageDisposition {
  if (disposition.kind === "task") {
    return {
      ...disposition,
      taskIds: sortedStrings(disposition.taskIds),
      requirementIds: sortedStrings(disposition.requirementIds),
    };
  }
  if (disposition.kind === "unresolved_question") {
    return {
      ...disposition,
      unresolvedDecisionIds: sortedStrings(disposition.unresolvedDecisionIds),
    };
  }
  return disposition;
}

function canonicalMaterialCoverageItem(
  item: CccPrdMaterialCoverageItem,
): CccPrdMaterialCoverageItem {
  return {
    ...item,
    spans: sortedSpans(item.spans),
    disposition: canonicalCoverageDisposition(item.disposition),
  };
}

function canonicalFactBinding(binding: CccPrdImplementationFactBinding) {
  return {
    ...binding,
    spans: sortedSpans(binding.spans),
  };
}

export function canonicalizeCccPrdImplementationFactProvenance(
  provenance: CccPrdImplementationFactProvenance,
): CccPrdImplementationFactProvenance {
  return {
    ...provenance,
    targetRepository: {
      path: canonicalFactBinding(provenance.targetRepository.path),
      baseCommit: canonicalFactBinding(provenance.targetRepository.baseCommit),
    },
    bounds: {
      maxRequests: canonicalFactBinding(provenance.bounds.maxRequests),
      maxDurationMs: canonicalFactBinding(provenance.bounds.maxDurationMs),
      maxConcurrency: canonicalFactBinding(provenance.bounds.maxConcurrency),
    },
    admittedWriteRoots: sortByCanonicalValue(provenance.admittedWriteRoots.map((root) => ({
      path: canonicalFactBinding(root.path),
      purpose: canonicalFactBinding(root.purpose),
    }))),
    nonGoals: sortByCanonicalValue(provenance.nonGoals.map(canonicalFactBinding)),
    requirements: sortByCanonicalValue(provenance.requirements.map((requirement) => ({
      id: requirement.id,
      acceptance: canonicalFactBinding(requirement.acceptance),
    }))),
    proofs: sortByCanonicalValue(provenance.proofs.map((proof) => ({
      id: proof.id,
      command: canonicalFactBinding(proof.command),
      positiveOracle: canonicalFactBinding(proof.positiveOracle),
      negativeControls: sortByCanonicalValue(
        proof.negativeControls.map(canonicalFactBinding),
      ),
    }))),
    protectedActions: sortByCanonicalValue(provenance.protectedActions.map((action) => ({
      id: action.id,
      kind: canonicalFactBinding(action.kind),
      target: canonicalFactBinding(action.target),
    }))),
  };
}

function projectCccPrdSemanticBundleV2ForHash(
  bundle: CccPrdSemanticBundleV2 | Omit<CccPrdSemanticBundleV2, "bundleHash">,
) {
  return {
    kind: bundle.kind,
    schema: bundle.schema,
    sourceHash: bundle.sourceHash,
    sidecarHash: bundle.sidecarHash,
    sourceVersion: bundle.sourceVersion,
    orderedSources: bundle.orderedSources,
    provenance: bundle.provenance,
    authorityRoles: sortByCanonicalValue(bundle.authorityRoles.map((role) => ({
      ...role,
      sourcePaths: sortedStrings(role.sourcePaths),
    }))),
    requirements: sortByCanonicalValue(bundle.requirements.map((requirement) => ({
      ...requirement,
      dependencies: sortedStrings(requirement.dependencies),
      proofIds: sortedStrings(requirement.proofIds),
      spans: sortedSpans(requirement.spans),
      acceptanceClauses: sortByCanonicalValue(requirement.acceptanceClauses.map((clause) => ({
        ...clause,
        proofIds: sortedStrings(clause.proofIds),
      }))),
      acceptanceDispositions: sortByCanonicalValue(
        requirement.acceptanceDispositions.map(canonicalAcceptanceDisposition),
      ),
    }))),
    proofs: sortByCanonicalValue(bundle.proofs.map((proof) => ({
      ...projectCccPrdProofV2DefinitionForHash(proof),
      ...(proof.admission ? { admission: proof.admission } : {}),
    }))),
    tasks: sortByCanonicalValue(bundle.tasks.map(canonicalTask)),
    edges: sortByCanonicalValue(bundle.edges),
    workflows: sortByCanonicalValue(bundle.workflows.map((workflow) => ({
      ...workflow,
      taskIds: sortedStrings(workflow.taskIds),
      entryTaskIds: sortedStrings(workflow.entryTaskIds),
      terminalTaskIds: sortedStrings(workflow.terminalTaskIds),
      spans: sortedSpans(workflow.spans),
    }))),
    documents: sortByCanonicalValue(bundle.documents.map((document) => ({
      ...document,
      spans: sortedSpans(document.spans),
    }))),
    artifacts: sortByCanonicalValue(bundle.artifacts.map((artifact) => ({
      ...artifact,
      spans: sortedSpans(artifact.spans),
    }))),
    importIntents: sortByCanonicalValue(bundle.importIntents),
    protectedActions: sortByCanonicalValue(bundle.protectedActions.map((action) => ({
      ...action,
      spans: sortedSpans(action.spans),
    }))),
    bounds: bundle.bounds,
    admittedWriteRoots: sortByCanonicalValue(bundle.admittedWriteRoots),
    targetRepository: bundle.targetRepository,
    nonGoals: sortedStrings(bundle.nonGoals),
    ...(bundle.materialCoverage
      ? {
          materialCoverage: sortByCanonicalValue(
            bundle.materialCoverage.map(canonicalMaterialCoverageItem),
          ),
        }
      : {}),
    ...(bundle.implementationFactProvenance
      ? {
          implementationFactProvenance: canonicalizeCccPrdImplementationFactProvenance(
            bundle.implementationFactProvenance,
          ),
        }
      : {}),
    confidence: bundle.confidence,
  };
}

export function projectCccPrdSemanticBundleForHash(
  bundle: CccPrdSemanticBundle | CccPrdSemanticBundleHashInput,
): CccPrdSemanticBundleHashInput {
  if (bundle.schema === CCC_PRD_BUNDLE_V2_SCHEMA_VERSION) {
    return projectCccPrdSemanticBundleV2ForHash(
      bundle as CccPrdSemanticBundleV2 | Omit<CccPrdSemanticBundleV2, "bundleHash">,
    ) as CccPrdSemanticBundleHashInput;
  }
  if (bundle.schema !== CCC_PRD_BUNDLE_V1_SCHEMA_VERSION) {
    throw new Error(
      `unsupported CCC PRD semantic bundle schema: ${String(
        (bundle as { schema?: unknown }).schema,
      )}`,
    );
  }
  return {
    kind: bundle.kind,
    schema: bundle.schema,
    sourceHash: bundle.sourceHash,
    sidecarHash: bundle.sidecarHash,
    sourceVersion: bundle.sourceVersion,
    orderedSources: bundle.orderedSources,
    provenance: bundle.provenance,
    authorityRoles: bundle.authorityRoles,
    requirements: bundle.requirements,
    proofs: bundle.proofs,
    tasks: bundle.tasks,
    edges: bundle.edges,
    workflows: bundle.workflows,
    documents: bundle.documents,
    artifacts: bundle.artifacts,
    importIntents: bundle.importIntents,
    protectedActions: bundle.protectedActions,
    bounds: bundle.bounds,
    admittedWriteRoots: bundle.admittedWriteRoots,
    targetRepository: bundle.targetRepository,
    nonGoals: bundle.nonGoals,
    ...(bundle.materialCoverage ? { materialCoverage: bundle.materialCoverage } : {}),
    ...(bundle.implementationFactProvenance ? { implementationFactProvenance: bundle.implementationFactProvenance } : {}),
    confidence: bundle.confidence,
  };
}

export function computeCccPrdSemanticBundleSha256(
  bundle: CccPrdSemanticBundle | CccPrdSemanticBundleHashInput,
): string {
  return sha256CanonicalCccPrdJson(projectCccPrdSemanticBundleForHash(bundle));
}

function displayPosition(prefix: Buffer): { line: number; column: number } {
  const decoded = prefix.toString("utf8");
  const lines = decoded.split("\n");
  return {
    line: lines.length,
    column: Array.from(lines.at(-1) ?? "").length + 1,
  };
}

export function createCccPrdSpanFromBytes(
  sourcePath: string,
  source: Buffer,
  byteStart: number,
  byteEnd: number,
): CccPrdSourceSpan {
  if (
    !Number.isSafeInteger(byteStart)
    || !Number.isSafeInteger(byteEnd)
    || byteStart < 0
    || byteEnd < byteStart
    || byteEnd > source.byteLength
  ) {
    throw new Error(`invalid CCC PRD byte span for ${sourcePath}`);
  }
  const start = displayPosition(source.subarray(0, byteStart));
  const end = displayPosition(source.subarray(0, byteEnd));
  return {
    path: sourcePath,
    byteStart,
    byteEnd,
    line: start.line,
    column: start.column,
    endLine: end.line,
    endColumn: end.column,
    sha256: createHash("sha256").update(source).digest("hex"),
  };
}

export function normalizeProtectedAction(input: {
  id?: string;
  kind: string;
  target: string;
  spans?: CccPrdSourceSpan[];
}): CccPrdProtectedActionIntent {
  const operatorDecision = decisions[input.kind as CccPrdProtectedActionKind];
  if (!operatorDecision) {
    // Naming only the bad kind leaves a caller (or a model being asked to
    // retry) with nothing to correct against, so carry the legal set too.
    throw new Error(
      `unknown protected action kind: ${input.kind}; allowed kinds are `
        + CCC_PRD_PROTECTED_ACTION_KINDS.join(", "),
    );
  }
  return {
    id: input.id ?? `protected-action:${input.kind}:${input.target}`,
    kind: input.kind as CccPrdProtectedActionKind,
    target: input.target,
    operatorDecision,
    requiresOperatorDecision: true,
    spans: input.spans ?? [],
  };
}

export function createRefusalBundle(
  input: Omit<CccPrdDiagnostic, "span"> & { source?: CccPrdSourceSpan },
): CccPrdRefusalBundle {
  const { source, ...diagnostic } = input;
  return {
    kind: "refusal",
    diagnostics: [{ ...diagnostic, ...(source ? { span: source } : {}) }],
  };
}
