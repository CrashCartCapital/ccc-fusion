import { createHash } from "node:crypto";
import {
  CCC_PRD_AUTHORING_PROPOSAL_SCHEMA_VERSION,
  CCC_PRD_IMPLEMENTATION_FACT_PROVENANCE_SCHEMA_VERSION,
  CCC_PRD_PROOF_ADMISSION_SCHEMA_VERSION,
  CCC_PRD_SIDECAR_SCHEMA_VERSION,
  canonicalCccPrdJson,
  computeCccPrdProofDefinitionSha256,
  createCccPrdSpanFromBytes,
  createRefusalBundle,
  getWorkflowExtensionRegistry,
  normalizeProtectedAction,
  type CccPrdAuthoringAdapter,
  type CccPrdAuthoringConstraints,
  type CccPrdAuthoringProposal,
  type CccPrdAuthoringResult,
  type CccPrdDiagnostic,
  type CccPrdExecutionBounds,
  type CccPrdImplementationFactBinding,
  type CccPrdImplementationFactProvenance,
  type CccPrdProposalArtifact,
  type CccPrdProposalDocument,
  type CccPrdProposalProof,
  type CccPrdProposalProtectedAction,
  type CccPrdProposalRequirement,
  type CccPrdProposalReviewItem,
  type CccPrdProposalTask,
  type CccPrdProposalUnresolvedDecision,
  type CccPrdProposalWorkflow,
  type CccPrdSourceReferenceProposal,
  type CccPrdSourceSpan,
  type CccPrdSidecar,
  type CccPrdTargetRepository,
  type WorkflowExtensionRegistry,
} from "@fusion/core";
import {
  CCC_CAMPAIGN_PROOF_ADMISSION_EXTENSION_ID,
  CCC_CAMPAIGN_PROOF_ADMISSION_PLUGIN_ID,
  CCC_CAMPAIGN_PROOF_ADMISSION_PLUGIN_VERSION,
  CCC_CAMPAIGN_PROOF_ADMISSION_PROOF_VERSION,
  CCC_CAMPAIGN_PROOF_ADMISSION_REGISTRY_ID,
} from "../ccc-campaign-proof-admission.js";
import {
  CccPrdCustodyError,
  readCccPrdPacketCustody,
  sortCccPrdById,
} from "./custody.js";
import {
  canonicalizeProtectedActionIds,
  isWellFormedProtectedActionId,
} from "./protected-action-ids.js";
import { analyzeCccPrdMaterialCoverage } from "./material-coverage.js";

export type AuthorCccPrdInput = {
  rootDir: string;
  manifestPath: string;
  adapter: CccPrdAuthoringAdapter;
  constraints?: CccPrdAuthoringConstraints;
  previousSidecar?: CccPrdSidecar;
  workflowExtensionRegistry?: WorkflowExtensionRegistry;
};

const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

function malformed(message: string): CccPrdAuthoringResult {
  return createRefusalBundle({ code: "CCC_PRD_AUTHORING_PROPOSAL_INVALID", message });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasArray(record: Record<string, unknown>, key: string): boolean {
  return Array.isArray(record[key]);
}

function hasIdentifiedRows(value: unknown): boolean {
  return Array.isArray(value) && value.every((entry) => (
    isPlainRecord(entry) && typeof entry.id === "string" && entry.id.length > 0
  ));
}

function hasSourceBoundRows(value: unknown): boolean {
  return hasIdentifiedRows(value) && (value as unknown[]).every((entry) => {
    const sourceRefs = (entry as Record<string, unknown>).sourceRefs;
    return Array.isArray(sourceRefs)
      && sourceRefs.length > 0
      && sourceRefs.every((reference) => (
        isPlainRecord(reference)
        && typeof reference.path === "string"
        && reference.path.length > 0
        && typeof reference.exactQuote === "string"
        && reference.exactQuote.length > 0
      ));
  });
}

function sourceQuoteContainsCanonicalPath(
  reference: CccPrdSourceReferenceProposal,
  path: string,
): boolean {
  const isPathCharacter = (value: string | undefined): boolean => (
    typeof value === "string" && /[A-Za-z0-9._/-]/u.test(value)
  );
  let index = reference.exactQuote.indexOf(path);
  while (index !== -1) {
    const before = index > 0 ? reference.exactQuote[index - 1] : undefined;
    const afterIndex = index + path.length;
    const after = afterIndex < reference.exactQuote.length
      ? reference.exactQuote[afterIndex]
      : undefined;
    if (!isPathCharacter(before) && !isPathCharacter(after)) return true;
    index = reference.exactQuote.indexOf(path, index + 1);
  }
  return false;
}

function validateTaskCustodyProvenance(
  proposal: CccPrdAuthoringProposal,
): CccPrdDiagnostic[] {
  const diagnostics: CccPrdDiagnostic[] = [];
  for (const task of proposal.tasks) {
    for (const [field, paths] of [
      ["ownedPaths", task.ownedPaths],
      ["allowedWriteRoots", task.allowedWriteRoots],
    ] as const) {
      if (
        !Array.isArray(paths)
        || paths.length === 0
        || paths.some((path) => typeof path !== "string" || path.length === 0 || path !== path.trim())
      ) {
        diagnostics.push({
          code: "CCC_PRD_TASK_CUSTODY_REQUIRED",
          message: "task " + task.id + " requires non-empty source-owned " + field,
        });
        continue;
      }
      for (const path of paths) {
        if (!task.sourceRefs.some((reference) =>
          sourceQuoteContainsCanonicalPath(reference, path)
        )) {
          diagnostics.push({
            code: "CCC_PRD_TASK_CUSTODY_PROVENANCE_REQUIRED",
            message: "task " + task.id + " " + field + " path " + path
              + " is absent from its exact source evidence",
          });
        }
      }
    }
  }
  return diagnostics;
}

/*
Stage 4 (2026-08-03): a real model produced a complete, parseable proposal that
failed this gate three ways at once, and the bare "wrong proposal schema or
shape" message left the operator blind. Enumerate the violations (first
offending row per collection) so the refusal can name them.
*/
function describeProposalShapeViolations(value: unknown): string[] {
  if (!isPlainRecord(value)) {
    return ["proposal is not a JSON object"];
  }
  const violations: string[] = [];
  if (value.schema !== CCC_PRD_AUTHORING_PROPOSAL_SCHEMA_VERSION) {
    violations.push(`schema must be "${CCC_PRD_AUTHORING_PROPOSAL_SCHEMA_VERSION}"`);
  }
  const collections = [
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
  ];
  const sourceBoundCollections = [
    "requirements",
    "proofs",
    "tasks",
    "workflows",
    "documents",
    "artifacts",
    "protectedActions",
    "unresolvedDecisions",
    "ambiguities",
    "exceptions",
  ];
  const identifiedCollections = [
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
    "unresolvedDecisions",
    "ambiguities",
    "exceptions",
  ];
  for (const key of collections) {
    if (!hasArray(value, key)) {
      violations.push(`${key} must be an array`);
    }
  }
  for (const key of identifiedCollections) {
    const rows = value[key];
    if (!Array.isArray(rows)) continue;
    const badIndex = rows.findIndex((entry) => !(
      isPlainRecord(entry) && typeof entry.id === "string" && entry.id.length > 0
    ));
    if (badIndex >= 0) {
      violations.push(`${key}[${badIndex}].id must be a non-empty string`);
    }
  }
  for (const key of sourceBoundCollections) {
    const rows = value[key];
    if (!Array.isArray(rows) || !hasIdentifiedRows(rows)) continue;
    const badIndex = rows.findIndex((entry) => {
      const sourceRefs = (entry as Record<string, unknown>).sourceRefs;
      return !(Array.isArray(sourceRefs)
        && sourceRefs.length > 0
        && sourceRefs.every((reference) => (
          isPlainRecord(reference)
          && typeof reference.path === "string"
          && reference.path.length > 0
          && typeof reference.exactQuote === "string"
          && reference.exactQuote.length > 0
        )));
    });
    if (badIndex >= 0) {
      violations.push(
        `${key}[${badIndex}].sourceRefs must be a non-empty array of {path, exactQuote} objects`,
      );
    }
  }
  if (!isPlainRecord(value.bounds)) {
    violations.push("bounds must be an object with maxRequests, maxDurationMs, maxConcurrency");
  }
  if (!isPlainRecord(value.targetRepository)) {
    violations.push("targetRepository must be an object with path and baseCommit");
  }
  if (typeof value.confidence !== "string") {
    violations.push('confidence must be the string "high", "medium", or "low"');
  }
  return violations;
}

function validateProposalShape(value: unknown): value is CccPrdAuthoringProposal {
  return describeProposalShapeViolations(value).length === 0;
}

const IDENTITY_COLLECTIONS = [
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
  "unresolvedDecisions",
  "ambiguities",
  "exceptions",
] as const;

const SOURCE_BOUND_COLLECTIONS = [
  "requirements",
  "proofs",
  "tasks",
  "workflows",
  "documents",
  "artifacts",
  "protectedActions",
  "unresolvedDecisions",
  "ambiguities",
  "exceptions",
] as const;

function identityInventory(
  value: Pick<CccPrdSidecar | CccPrdAuthoringProposal, (typeof IDENTITY_COLLECTIONS)[number]>,
): Record<string, string[]> {
  return Object.fromEntries(IDENTITY_COLLECTIONS.map((collection) => [
    collection,
    value[collection].map((entry) => entry.id).sort((left, right) => (
      left < right ? -1 : left > right ? 1 : 0
    )),
  ]));
}

type SourceBoundEntity = {
  id: string;
  spans: CccPrdSourceSpan[];
};

type ImplementationFacts = {
  targetRepository: CccPrdTargetRepository;
  bounds: CccPrdExecutionBounds;
  admittedWriteRoots: Array<{ path: string; purpose: string }>;
  nonGoals: string[];
  requirements: Array<{ id: string; acceptance: string; spans?: CccPrdSourceSpan[] }>;
  proofs: Array<{
    id: string;
    command: string;
    positiveOracle: string;
    negativeControls: string[];
    spans?: CccPrdSourceSpan[];
  }>;
  protectedActions: Array<{
    id: string;
    kind: string;
    target: string;
    spans: CccPrdSourceSpan[];
  }>;
  implementationFactProvenance?: CccPrdImplementationFactProvenance;
};

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

// Padded protected-action IDs are malformed proposal input, not reorderable input: normalizing
// them here would silently rewrite the identity reference between a task's protectedActionIds and
// the matching protectedActions[].id, so they are refused at the proposal-validation layer instead
// (see hasWellFormedProtectedActionIds below). This only dedupes and sorts already well-formed IDs.
function hasWellFormedProtectedActionIds(proposal: CccPrdAuthoringProposal): boolean {
  return proposal.tasks.every((task) => (
    Array.isArray(task.protectedActionIds)
    && task.protectedActionIds.every((id) => isWellFormedProtectedActionId(id))
  ));
}

function compareSourceSpans(left: CccPrdSourceSpan, right: CccPrdSourceSpan): number {
  return compareCodeUnits(left.path, right.path)
    || left.byteStart - right.byteStart
    || left.byteEnd - right.byteEnd
    || compareCodeUnits(left.sha256, right.sha256)
    || compareCodeUnits(left.excerptSha256 ?? "", right.excerptSha256 ?? "");
}

function sourceBindingInventory(
  value: Record<(typeof SOURCE_BOUND_COLLECTIONS)[number], SourceBoundEntity[]>,
): Record<string, Array<{ id: string; spans: Array<Pick<
  CccPrdSourceSpan,
  "path" | "byteStart" | "byteEnd" | "sha256" | "excerptSha256"
>> }>> {
  return Object.fromEntries(SOURCE_BOUND_COLLECTIONS.map((collection) => [
    collection,
    value[collection].map((entry) => ({
      id: entry.id,
      spans: [...entry.spans].sort(compareSourceSpans).map((span) => ({
        path: span.path,
        byteStart: span.byteStart,
        byteEnd: span.byteEnd,
        sha256: span.sha256,
        ...(span.excerptSha256 ? { excerptSha256: span.excerptSha256 } : {}),
      })),
    })).sort((left, right) => compareCodeUnits(left.id, right.id)),
  ]));
}

function bindingFromAbsoluteSpan(
  value: string | number,
  sourceBytes: Map<string, Buffer>,
  sourcePath: string,
  byteStart: number,
  byteEnd: number,
): CccPrdImplementationFactBinding {
  const source = sourceBytes.get(sourcePath)!;
  const bytes = source.subarray(byteStart, byteEnd);
  return {
    value,
    spans: [{
      ...createCccPrdSpanFromBytes(sourcePath, source, byteStart, byteEnd),
      excerptSha256: sha256(bytes),
    }],
  };
}

function findFactBindingInSource(
  value: string | number,
  sourceBytes: Map<string, Buffer>,
  labels: readonly string[],
): CccPrdImplementationFactBinding | undefined {
  const needle = Buffer.from(String(value), "utf8");
  if (needle.byteLength === 0) return undefined;

  for (const [sourcePath, source] of sourceBytes) {
    const sourceText = source.toString("utf8");
    const lines = sourceText.split("\n");
    let byteCursor = 0;
    let fence: "```" | "~~~" | null = null;
    for (const rawLine of lines) {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      const trimmed = line.trimStart();
      if (fence) {
        if (trimmed.startsWith(fence)) fence = null;
        byteCursor += Buffer.byteLength(rawLine, "utf8") + 1;
        continue;
      }
      if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
        fence = trimmed.startsWith("```") ? "```" : "~~~";
        byteCursor += Buffer.byteLength(rawLine, "utf8") + 1;
        continue;
      }
      const leading = line.match(/^\s*(?:[-*+]\s+)?(?:#{1,6}\s+)?/u)?.[0] ?? "";
      const normalized = line.slice(leading.length).trimEnd();
      const lower = normalized.toLowerCase();
      for (const label of labels) {
        const prefix = label.toLowerCase() + ":";
        if (!lower.startsWith(prefix)) continue;
        let valueOffset = prefix.length;
        while (/\s/u.test(normalized[valueOffset] ?? "")) valueOffset += 1;
        if (normalized.slice(valueOffset) !== String(value)) continue;
        const byteStart = byteCursor + Buffer.byteLength(
          line.slice(0, leading.length + valueOffset),
          "utf8",
        );
        return bindingFromAbsoluteSpan(
          value,
          sourceBytes,
          sourcePath,
          byteStart,
          byteStart + needle.byteLength,
        );
      }
      byteCursor += Buffer.byteLength(rawLine, "utf8") + 1;
    }
  }

  let uniqueMatch: { sourcePath: string; byteStart: number } | undefined;
  for (const [sourcePath, source] of sourceBytes) {
    let byteStart = source.indexOf(needle);
    while (byteStart >= 0) {
      if (uniqueMatch) return undefined;
      uniqueMatch = { sourcePath, byteStart };
      byteStart = source.indexOf(needle, byteStart + 1);
    }
  }
  return uniqueMatch
    ? bindingFromAbsoluteSpan(
      value,
      sourceBytes,
      uniqueMatch.sourcePath,
      uniqueMatch.byteStart,
      uniqueMatch.byteStart + needle.byteLength,
    )
    : undefined;
}

function findFactBindingInEntitySpans(
  value: string | number,
  sourceBytes: Map<string, Buffer>,
  spans: readonly CccPrdSourceSpan[],
): CccPrdImplementationFactBinding | undefined {
  const needle = Buffer.from(String(value), "utf8");
  if (needle.byteLength === 0) return undefined;
  const sorted = [...spans].sort(compareSourceSpans);
  for (const span of sorted) {
    const source = sourceBytes.get(span.path);
    if (!source) continue;
    const haystack = source.subarray(span.byteStart, span.byteEnd);
    const offset = haystack.indexOf(needle);
    if (offset >= 0) {
      const byteStart = span.byteStart + offset;
      return bindingFromAbsoluteSpan(
        value,
        sourceBytes,
        span.path,
        byteStart,
        byteStart + needle.byteLength,
      );
    }
  }
  return undefined;
}

function requireTopLevelBinding(
  diagnostics: CccPrdDiagnostic[],
  sourceBytes: Map<string, Buffer>,
  code: string,
  message: string,
  value: string | number,
  labels: readonly string[],
): CccPrdImplementationFactBinding {
  const binding = findFactBindingInSource(value, sourceBytes, labels);
  if (binding) return binding;
  diagnostics.push({ code, message });
  return { value, spans: [] };
}

function requireEntityBinding(
  diagnostics: CccPrdDiagnostic[],
  sourceBytes: Map<string, Buffer>,
  code: string,
  message: string,
  value: string | number,
  spans: readonly CccPrdSourceSpan[],
): CccPrdImplementationFactBinding {
  const binding = findFactBindingInEntitySpans(value, sourceBytes, spans);
  if (binding) return binding;
  diagnostics.push({ code, message, ...(spans[0] ? { span: spans[0] } : {}) });
  return { value, spans: [] };
}

export function computeCccPrdImplementationFactProvenance(input: {
  sourceBytes: Map<string, Buffer>;
  facts: ImplementationFacts;
}): { provenance?: CccPrdImplementationFactProvenance; diagnostics: CccPrdDiagnostic[] } {
  const diagnostics: CccPrdDiagnostic[] = [];
  const provenance: CccPrdImplementationFactProvenance = {
    schema: CCC_PRD_IMPLEMENTATION_FACT_PROVENANCE_SCHEMA_VERSION,
    targetRepository: {
      path: requireTopLevelBinding(
        diagnostics,
        input.sourceBytes,
        "CCC_PRD_TARGET_REPOSITORY_PROVENANCE_REQUIRED",
        "Target repository must be stated in an admitted PRD source or reviewed operator-decision source; CLI flags alone are not source facts.",
        input.facts.targetRepository.path,
        ["Target repository", "Target repository path", "Repository target"],
      ),
      baseCommit: requireTopLevelBinding(
        diagnostics,
        input.sourceBytes,
        "CCC_PRD_BASELINE_PROVENANCE_REQUIRED",
        "Baseline commit must be stated in an admitted PRD source or reviewed operator-decision source; CLI flags alone are not source facts.",
        input.facts.targetRepository.baseCommit,
        ["Baseline", "Base commit", "Baseline commit", "Frozen baseline commit"],
      ),
    },
    bounds: {
      maxRequests: requireTopLevelBinding(
        diagnostics,
        input.sourceBytes,
        "CCC_PRD_EXECUTION_BOUND_PROVENANCE_REQUIRED",
        `Execution bound maxRequests=${input.facts.bounds.maxRequests} must be stated in an admitted PRD source or reviewed operator-decision source.`,
        input.facts.bounds.maxRequests,
        ["Max requests", "Maximum requests"],
      ),
      maxDurationMs: requireTopLevelBinding(
        diagnostics,
        input.sourceBytes,
        "CCC_PRD_EXECUTION_BOUND_PROVENANCE_REQUIRED",
        `Execution bound maxDurationMs=${input.facts.bounds.maxDurationMs} must be stated in an admitted PRD source or reviewed operator-decision source.`,
        input.facts.bounds.maxDurationMs,
        ["Max duration ms", "Maximum duration in milliseconds"],
      ),
      maxConcurrency: requireTopLevelBinding(
        diagnostics,
        input.sourceBytes,
        "CCC_PRD_EXECUTION_BOUND_PROVENANCE_REQUIRED",
        `Execution bound maxConcurrency=${input.facts.bounds.maxConcurrency} must be stated in an admitted PRD source or reviewed operator-decision source.`,
        input.facts.bounds.maxConcurrency,
        ["Max concurrency", "Maximum concurrency"],
      ),
    },
    admittedWriteRoots: input.facts.admittedWriteRoots.map((root) => ({
      path: requireTopLevelBinding(
        diagnostics,
        input.sourceBytes,
        "CCC_PRD_ALLOWED_WRITE_ROOT_PROVENANCE_REQUIRED",
        `Allowed write root ${root.path} must be stated in an admitted PRD source or reviewed operator-decision source.`,
        root.path,
        ["Allowed write root", "Admitted write root"],
      ),
      purpose: requireTopLevelBinding(
        diagnostics,
        input.sourceBytes,
        "CCC_PRD_ALLOWED_WRITE_ROOT_PURPOSE_PROVENANCE_REQUIRED",
        `Allowed write root purpose ${root.purpose} must be stated in an admitted PRD source or reviewed operator-decision source.`,
        root.purpose,
        ["Allowed write root purpose", "Admitted write purpose"],
      ),
    })),
    nonGoals: input.facts.nonGoals.map((nonGoal) => requireTopLevelBinding(
      diagnostics,
      input.sourceBytes,
      "CCC_PRD_NON_GOAL_PROVENANCE_REQUIRED",
      `Non-goal must be stated in an admitted PRD source or reviewed operator-decision source: ${nonGoal}`,
      nonGoal,
      ["Non-goal", "Non goal", "Out of scope"],
    )),
    requirements: input.facts.requirements.map((requirement) => ({
      id: requirement.id,
      acceptance: requireEntityBinding(
        diagnostics,
        input.sourceBytes,
        "CCC_PRD_ACCEPTANCE_PROVENANCE_REQUIRED",
        `Acceptance behavior for requirement ${requirement.id} must be stated inside that requirement's cited source span.`,
        requirement.acceptance,
        "spans" in requirement && Array.isArray(requirement.spans) ? requirement.spans : [],
      ),
    })),
    proofs: input.facts.proofs.map((proof) => ({
      id: proof.id,
      command: requireEntityBinding(
        diagnostics,
        input.sourceBytes,
        "CCC_PRD_PROOF_COMMAND_PROVENANCE_REQUIRED",
        `Verifier command for proof ${proof.id} must be stated inside that proof's cited source span.`,
        proof.command,
        proof.spans ?? [],
      ),
      positiveOracle: requireEntityBinding(
        diagnostics,
        input.sourceBytes,
        "CCC_PRD_PROOF_ORACLE_PROVENANCE_REQUIRED",
        `Positive proof oracle for proof ${proof.id} must be stated inside that proof's cited source span.`,
        proof.positiveOracle,
        proof.spans ?? [],
      ),
      negativeControls: proof.negativeControls.map((negativeControl) => requireEntityBinding(
        diagnostics,
        input.sourceBytes,
        "CCC_PRD_NEGATIVE_CONTROL_PROVENANCE_REQUIRED",
        `Negative control for proof ${proof.id} must be stated inside that proof's cited source span: ${negativeControl}`,
        negativeControl,
        proof.spans ?? [],
      )),
    })),
    protectedActions: input.facts.protectedActions.map((action) => ({
      id: action.id,
      kind: requireEntityBinding(
        diagnostics,
        input.sourceBytes,
        "CCC_PRD_PROTECTED_ACTION_KIND_PROVENANCE_REQUIRED",
        `Protected action kind for ${action.id} must be stated inside that action's cited source span.`,
        action.kind,
        action.spans,
      ),
      target: requireEntityBinding(
        diagnostics,
        input.sourceBytes,
        "CCC_PRD_PROTECTED_ACTION_TARGET_PROVENANCE_REQUIRED",
        `Protected action target for ${action.id} must be stated inside that action's cited source span.`,
        action.target,
        action.spans,
      ),
    })),
  };
  return diagnostics.length > 0 ? { diagnostics } : { provenance, diagnostics };
}

export function validateCccPrdImplementationFactProvenance(input: {
  sourceBytes: Map<string, Buffer>;
  facts: ImplementationFacts;
  provenance?: CccPrdImplementationFactProvenance;
}): CccPrdDiagnostic[] {
  const diagnostics: CccPrdDiagnostic[] = [];
  if (!input.provenance) {
    return [{
      code: "CCC_PRD_IMPLEMENTATION_FACT_PROVENANCE_REQUIRED",
      message: "supported product intake requires exact source custody for implementation-changing facts",
    }];
  }
  const provenanceActions = new Map(input.provenance.protectedActions.map((action) => [action.id, action]));
  for (const action of input.facts.protectedActions) {
    const provenanceAction = provenanceActions.get(action.id);
    if (
      provenanceAction
      && (
        provenanceAction.kind.value !== action.kind
        || provenanceAction.target.value !== action.target
      )
    ) {
      diagnostics.push({
        code: "CCC_PRD_PROTECTED_ACTION_PROVENANCE_STALE",
        message: "protected-action kind or target no longer matches exact implementation fact provenance",
      });
    }
  }
  const computed = computeCccPrdImplementationFactProvenance({
    sourceBytes: input.sourceBytes,
    facts: input.facts,
  });
  diagnostics.push(...computed.diagnostics);
  if (!computed.provenance) return diagnostics;
  if (
    canonicalCccPrdJson(input.provenance.protectedActions)
    !== canonicalCccPrdJson(computed.provenance.protectedActions)
  ) {
    diagnostics.push({
      code: "CCC_PRD_PROTECTED_ACTION_PROVENANCE_STALE",
      message: "protected-action kind or target no longer matches exact implementation fact provenance",
    });
  }
  if (
    canonicalCccPrdJson(input.provenance)
    !== canonicalCccPrdJson(computed.provenance)
    && diagnostics.length === 0
  ) {
    diagnostics.push({
      code: "CCC_PRD_IMPLEMENTATION_FACT_PROVENANCE_STALE",
      message: "implementation-changing fact provenance no longer matches admitted source bytes and declarations",
    });
  }
  return diagnostics;
}

export function validateCccPrdPacketImplementationFactProvenance(input: {
  rootDir: string;
  manifestPath: string;
  facts: ImplementationFacts;
  provenance?: CccPrdImplementationFactProvenance;
}): CccPrdDiagnostic[] {
  const custody = readCccPrdPacketCustody({
    rootDir: input.rootDir,
    manifestPath: input.manifestPath,
  });
  return validateCccPrdImplementationFactProvenance({
    sourceBytes: custody.sourceBytes,
    facts: input.facts,
    provenance: input.provenance ?? input.facts.implementationFactProvenance,
  });
}

function resolveSourceRefs(
  refs: CccPrdSourceReferenceProposal[],
  sourceBytes: Map<string, Buffer>,
  entityId: string,
): CccPrdSourceSpan[] {
  if (!Array.isArray(refs) || refs.length === 0) {
    throw new CccPrdCustodyError(
      "CCC_PRD_SOURCE_SPAN_MISSING",
      `authoring proposal entity has no source reference: ${entityId}`,
    );
  }
  return refs.map((reference) => {
    if (
      !reference
      || typeof reference.path !== "string"
      || typeof reference.exactQuote !== "string"
      || reference.exactQuote.length === 0
    ) {
      throw new CccPrdCustodyError(
        "CCC_PRD_SOURCE_SPAN_INVALID",
        `authoring proposal entity has a malformed source reference: ${entityId}`,
      );
    }
    const source = sourceBytes.get(reference.path);
    if (!source) {
      throw new CccPrdCustodyError(
        "CCC_PRD_SOURCE_SPAN_FOREIGN",
        `authoring proposal references an unadmitted source: ${reference.path}`,
      );
    }
    const quote = Buffer.from(reference.exactQuote, "utf8");
    const byteStart = source.indexOf(quote);
    if (byteStart < 0) {
      throw new CccPrdCustodyError(
        "CCC_PRD_SOURCE_QUOTE_MISSING",
        `authoring proposal quote is absent for ${entityId} in ${reference.path}`,
      );
    }
    if (source.indexOf(quote, byteStart + 1) >= 0) {
      throw new CccPrdCustodyError(
        "CCC_PRD_SOURCE_QUOTE_AMBIGUOUS",
        `authoring proposal quote is not unique for ${entityId} in ${reference.path}`,
      );
    }
    return {
      ...createCccPrdSpanFromBytes(
        reference.path,
        source,
        byteStart,
        byteStart + quote.byteLength,
      ),
      excerptSha256: sha256(quote),
    };
  });
}

function withoutSourceRefs<T extends { id: string; sourceRefs: CccPrdSourceReferenceProposal[] }>(
  input: T,
  sourceBytes: Map<string, Buffer>,
): Omit<T, "sourceRefs"> & { spans: CccPrdSourceSpan[] } {
  const { sourceRefs, ...value } = input;
  return {
    ...value,
    spans: resolveSourceRefs(sourceRefs, sourceBytes, input.id),
  };
}

function mapProposal(
  proposal: CccPrdAuthoringProposal,
  sourceBytes: Map<string, Buffer>,
): {
  requirements: ReturnType<typeof withoutSourceRefs<CccPrdProposalRequirement>>[];
  proofs: ReturnType<typeof withoutSourceRefs<CccPrdProposalProof>>[];
  tasks: ReturnType<typeof withoutSourceRefs<CccPrdProposalTask>>[];
  workflows: ReturnType<typeof withoutSourceRefs<CccPrdProposalWorkflow>>[];
  documents: ReturnType<typeof withoutSourceRefs<CccPrdProposalDocument>>[];
  artifacts: ReturnType<typeof withoutSourceRefs<CccPrdProposalArtifact>>[];
  unresolvedDecisions: ReturnType<typeof withoutSourceRefs<CccPrdProposalUnresolvedDecision>>[];
  ambiguities: ReturnType<typeof withoutSourceRefs<CccPrdProposalReviewItem>>[];
  exceptions: ReturnType<typeof withoutSourceRefs<CccPrdProposalReviewItem>>[];
  protectedActions: ReturnType<typeof normalizeProtectedAction>[];
} {
  return {
    requirements: sortCccPrdById(proposal.requirements.map((value) => withoutSourceRefs(value, sourceBytes))),
    proofs: sortCccPrdById(proposal.proofs.map((value) => withoutSourceRefs(value, sourceBytes))),
    tasks: sortCccPrdById(proposal.tasks.map((value) => {
      const mappedTask = withoutSourceRefs(value, sourceBytes);
      return {
        ...mappedTask,
        protectedActionIds: canonicalizeProtectedActionIds(mappedTask.protectedActionIds),
      };
    })),
    workflows: sortCccPrdById(proposal.workflows.map((value) => withoutSourceRefs(value, sourceBytes))),
    documents: sortCccPrdById(proposal.documents.map((value) => withoutSourceRefs(value, sourceBytes))),
    artifacts: sortCccPrdById(proposal.artifacts.map((value) => withoutSourceRefs(value, sourceBytes))),
    unresolvedDecisions: sortCccPrdById(
      proposal.unresolvedDecisions.map((value) => withoutSourceRefs(value, sourceBytes)),
    ),
    ambiguities: sortCccPrdById(proposal.ambiguities.map((value) => withoutSourceRefs(value, sourceBytes))),
    exceptions: sortCccPrdById(proposal.exceptions.map((value) => withoutSourceRefs(value, sourceBytes))),
    protectedActions: sortCccPrdById(proposal.protectedActions.map((value: CccPrdProposalProtectedAction) => {
      const spans = resolveSourceRefs(value.sourceRefs, sourceBytes, value.id);
      return normalizeProtectedAction({
        id: value.id,
        kind: value.kind,
        target: value.target,
        spans,
      });
    })),
  };
}

export async function authorCccPrdPacket(input: AuthorCccPrdInput): Promise<CccPrdAuthoringResult> {
  try {
    const custody = readCccPrdPacketCustody(input);
    for (const [path, bytes] of custody.sourceBytes) {
      if (!Buffer.from(bytes.toString("utf8"), "utf8").equals(bytes)) {
        return createRefusalBundle({
          code: "CCC_PRD_SOURCE_NOT_UTF8",
          message: `authoritative Markdown source is not valid UTF-8: ${path}`,
        });
      }
    }
    const proposalValue = await input.adapter.generateCandidate({
      sourceVersion: custody.sourceVersion,
      packetHash: custody.packetHash,
      sources: custody.sources.map((source) => ({
        ...source,
        content: custody.sourceBytes.get(source.path)!.toString("utf8"),
      })),
      ...(input.constraints ? { constraints: input.constraints } : {}),
      ...(input.previousSidecar ? { previousSidecar: input.previousSidecar } : {}),
    });
    if (!validateProposalShape(proposalValue)) {
      const violations = describeProposalShapeViolations(proposalValue);
      const shown = violations.slice(0, 8).join("; ");
      const suffix = violations.length > 8 ? ` (+${violations.length - 8} more)` : "";
      return malformed(
        `authoring adapter ${input.adapter.id} returned the wrong proposal schema or shape: ${shown}${suffix}`,
      );
    }
    if (!hasWellFormedProtectedActionIds(proposalValue)) {
      return malformed(`authoring adapter ${input.adapter.id} returned a task protected-action ID that is empty or not trimmed`);
    }
    if (input.constraints) {
      const taskCustodyDiagnostics = validateTaskCustodyProvenance(proposalValue);
      if (taskCustodyDiagnostics.length > 0) {
        return { kind: "refusal", diagnostics: taskCustodyDiagnostics };
      }
      if (
        canonicalCccPrdJson(proposalValue.targetRepository)
        !== canonicalCccPrdJson(input.constraints.targetRepository)
      ) {
        return createRefusalBundle({
          code: "CCC_PRD_AUTHORING_TARGET_DRIFT",
          message: "authoring proposal target repository or base differs from the admitted request",
        });
      }
      if (
        canonicalCccPrdJson(proposalValue.bounds)
        !== canonicalCccPrdJson(input.constraints.bounds)
      ) {
        return createRefusalBundle({
          code: "CCC_PRD_AUTHORING_BOUNDS_DRIFT",
          message: "authoring proposal execution bounds differ from the admitted request",
        });
      }
      const reviewCount = proposalValue.ambiguities.length
        + proposalValue.unresolvedDecisions.length
        + proposalValue.exceptions.length
        + proposalValue.protectedActions.length;
      if (
        !Number.isSafeInteger(input.constraints.maxReviewItems)
        || input.constraints.maxReviewItems < 0
        || reviewCount > input.constraints.maxReviewItems
      ) {
        return createRefusalBundle({
          code: "CCC_PRD_AUTHORING_REVIEW_UNBOUNDED",
          message: `authoring proposal review count ${reviewCount} exceeds admitted maximum ${input.constraints.maxReviewItems}`,
        });
      }
    }
    const samePacketAsPrevious = input.previousSidecar?.provenance.packetHash === custody.packetHash;
    if (
      samePacketAsPrevious
      && canonicalCccPrdJson(identityInventory(input.previousSidecar!))
        !== canonicalCccPrdJson(identityInventory(proposalValue))
    ) {
      return createRefusalBundle({
        code: "CCC_PRD_AUTHORING_IDENTITY_DRIFT",
        message: "authoring proposal changed stable declaration IDs for an unchanged admitted packet",
      });
    }
    const mapped = mapProposal(proposalValue, custody.sourceBytes);
    let implementationFactProvenance: CccPrdImplementationFactProvenance | undefined;
    if (input.constraints) {
      const computedProvenance = computeCccPrdImplementationFactProvenance({
        sourceBytes: custody.sourceBytes,
        facts: {
          ...proposalValue,
          requirements: mapped.requirements,
          proofs: mapped.proofs,
          protectedActions: mapped.protectedActions,
        },
      });
      if (computedProvenance.diagnostics.length > 0 || !computedProvenance.provenance) {
        return { kind: "refusal", diagnostics: computedProvenance.diagnostics };
      }
      implementationFactProvenance = computedProvenance.provenance;
    }
    if (
      samePacketAsPrevious
      && canonicalCccPrdJson(sourceBindingInventory(input.previousSidecar!))
        !== canonicalCccPrdJson(sourceBindingInventory(mapped))
    ) {
      return createRefusalBundle({
        code: "CCC_PRD_AUTHORING_IDENTITY_DRIFT",
        message: "authoring proposal rebound stable declaration IDs to different source evidence for an unchanged admitted packet",
      });
    }
    const registry = input.workflowExtensionRegistry ?? getWorkflowExtensionRegistry();
    const proofAdmissionDefinition = registry.get(CCC_CAMPAIGN_PROOF_ADMISSION_REGISTRY_ID);
    if (!proofAdmissionDefinition) {
      return createRefusalBundle({
        code: "CCC_PRD_PROOF_ADMISSION_MISSING",
        message: `fixed proof-admission extension is not registered: ${CCC_CAMPAIGN_PROOF_ADMISSION_REGISTRY_ID}`,
      });
    }
    if (proofAdmissionDefinition.degraded) {
      return createRefusalBundle({
        code: "CCC_PRD_PROOF_ADMISSION_DEGRADED",
        message: `fixed proof-admission extension is degraded: ${proofAdmissionDefinition.degraded.message}`,
      });
    }
    if (
      proofAdmissionDefinition.id !== CCC_CAMPAIGN_PROOF_ADMISSION_REGISTRY_ID
      || proofAdmissionDefinition.pluginId !== CCC_CAMPAIGN_PROOF_ADMISSION_PLUGIN_ID
      || proofAdmissionDefinition.extension.kind !== "proof-admission"
      || proofAdmissionDefinition.extension.extensionId
        !== CCC_CAMPAIGN_PROOF_ADMISSION_EXTENSION_ID
      || proofAdmissionDefinition.extension.proofVersion
        !== CCC_CAMPAIGN_PROOF_ADMISSION_PROOF_VERSION
      || proofAdmissionDefinition.hostProvenance?.pluginId
        !== CCC_CAMPAIGN_PROOF_ADMISSION_PLUGIN_ID
      || proofAdmissionDefinition.hostProvenance.pluginVersion
        !== CCC_CAMPAIGN_PROOF_ADMISSION_PLUGIN_VERSION
    ) {
      return createRefusalBundle({
        code: "CCC_PRD_PROOF_ADMISSION_IDENTITY",
        message: `fixed proof-admission registry identity is inconsistent: ${CCC_CAMPAIGN_PROOF_ADMISSION_REGISTRY_ID}`,
      });
    }
    let proofAdmissionBinding;
    try {
      proofAdmissionBinding = await registry.reverifyHostProvenance(
        CCC_CAMPAIGN_PROOF_ADMISSION_REGISTRY_ID,
      );
    } catch (error) {
      return createRefusalBundle({
        code: "CCC_PRD_PROOF_ADMISSION_PROVENANCE",
        message: error instanceof Error
          ? error.message
          : "fixed proof-admission provenance could not be reverified",
      });
    }
    if (
      canonicalCccPrdJson(proofAdmissionBinding)
      !== canonicalCccPrdJson(proofAdmissionDefinition.hostProvenance)
    ) {
      return createRefusalBundle({
        code: "CCC_PRD_PROOF_ADMISSION_IDENTITY",
        message: `fixed proof-admission provenance changed during re-verification: ${CCC_CAMPAIGN_PROOF_ADMISSION_REGISTRY_ID}`,
      });
    }
    const stampedProofs = mapped.proofs.map((proof) => ({
      ...proof,
      admission: {
        schema: CCC_PRD_PROOF_ADMISSION_SCHEMA_VERSION,
        pluginId: proofAdmissionBinding.pluginId,
        pluginVersion: proofAdmissionBinding.pluginVersion,
        extensionId: CCC_CAMPAIGN_PROOF_ADMISSION_EXTENSION_ID,
        proofVersion: CCC_CAMPAIGN_PROOF_ADMISSION_PROOF_VERSION,
        extensionRootRelativeSource: proofAdmissionBinding.extensionRootRelativeSource,
        extensionSourceSha256: proofAdmissionBinding.extensionSourceSha256,
        extensionManifestSha256: proofAdmissionBinding.extensionManifestSha256,
        definitionSha256: computeCccPrdProofDefinitionSha256(proof),
      },
    }));
    const proposalHash = sha256(canonicalCccPrdJson(proposalValue));
    const sidecarWithoutCoverage: CccPrdSidecar = {
      schema: CCC_PRD_SIDECAR_SCHEMA_VERSION,
      sourceVersion: custody.sourceVersion,
      orderedSources: custody.sources,
      provenance: {
        authoringAdapterId: input.adapter.id,
        ...(input.adapter.model ? { authoringModel: input.adapter.model } : {}),
        proposalHash,
        packetHash: custody.packetHash,
      },
      authorityRoles: sortCccPrdById(proposalValue.authorityRoles),
      requirements: mapped.requirements,
      proofs: stampedProofs,
      tasks: mapped.tasks,
      edges: sortCccPrdById(proposalValue.edges),
      workflows: mapped.workflows,
      documents: mapped.documents,
      artifacts: mapped.artifacts,
      importIntents: sortCccPrdById(proposalValue.importIntents),
      protectedActions: mapped.protectedActions,
      bounds: proposalValue.bounds,
      admittedWriteRoots: [...proposalValue.admittedWriteRoots],
      targetRepository: proposalValue.targetRepository,
      nonGoals: [...proposalValue.nonGoals],
      unresolvedDecisions: mapped.unresolvedDecisions,
      ambiguities: mapped.ambiguities,
      exceptions: mapped.exceptions,
      confidence: proposalValue.confidence,
      ...(implementationFactProvenance ? { implementationFactProvenance } : {}),
    };
    const materialCoverage = analyzeCccPrdMaterialCoverage({
      sourceBytes: custody.sourceBytes,
      requirements: sidecarWithoutCoverage.requirements,
      tasks: sidecarWithoutCoverage.tasks,
      unresolvedDecisions: sidecarWithoutCoverage.unresolvedDecisions,
    }).coverage;
    const sidecar: CccPrdSidecar = {
      ...sidecarWithoutCoverage,
      materialCoverage,
    };
    return {
      kind: "candidate",
      sidecar,
      review: {
        ambiguities: sidecar.ambiguities,
        unresolvedDecisions: sidecar.unresolvedDecisions,
        exceptions: sidecar.exceptions,
        protectedActions: sidecar.protectedActions,
      },
    };
  } catch (error) {
    if (error instanceof CccPrdCustodyError) {
      return createRefusalBundle({ code: error.code, message: error.message });
    }
    return createRefusalBundle({
      code: "CCC_PRD_AUTHORING_FAILED",
      message: error instanceof Error ? error.message : "authoring failed",
    });
  }
}
