import {
  CCC_PRD_AUTHORING_PROPOSAL_FRAGMENT_SCHEMA_VERSION,
  normalizeProtectedAction,
  type CccPrdAuthoringProposalFragment,
  type CccPrdRequirement,
  type CccPrdSourceReferenceProposal,
  type CccPrdSourceSpan,
  type CccPrdTask,
  type CccPrdUnresolvedDecision,
} from "@fusion/core";
import {
  resolveCccPrdAnchor,
  type CccPrdAnchorLimits,
  type CccPrdAnchorSliceBounds,
} from "./anchor-resolver.js";
import {
  IDENTITY_COLLECTIONS,
  SOURCE_BOUND_COLLECTIONS,
  validateTaskCustodyProvenance,
} from "./authoring.js";
import { CccPrdCustodyError } from "./custody.js";
import { analyzeCccPrdMaterialCoverage } from "./material-coverage.js";
import { stripOutermostJsonFence } from "./native-authoring-adapter.js";

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

/** Mirrors authoring.ts's `describeProposalShapeViolations`, scoped to the fragment's 13 collections (design §2: no bounds/targetRepository/admittedWriteRoots/nonGoals/confidence at chunk scope). */
export function describeCccPrdChunkFragmentShapeViolations(value: unknown): string[] {
  if (!isPlainRecord(value)) {
    return ["fragment is not a JSON object"];
  }
  const violations: string[] = [];
  if (value.schema !== CCC_PRD_AUTHORING_PROPOSAL_FRAGMENT_SCHEMA_VERSION) {
    violations.push(`schema must be "${CCC_PRD_AUTHORING_PROPOSAL_FRAGMENT_SCHEMA_VERSION}"`);
  }
  for (const key of IDENTITY_COLLECTIONS) {
    if (!hasArray(value, key)) violations.push(`${key} must be an array`);
  }
  for (const key of IDENTITY_COLLECTIONS) {
    const rows = value[key];
    if (!Array.isArray(rows)) continue;
    const badIndex = rows.findIndex((entry) => !(
      isPlainRecord(entry) && typeof entry.id === "string" && entry.id.length > 0
    ));
    if (badIndex >= 0) violations.push(`${key}[${badIndex}].id must be a non-empty string`);
  }
  for (const key of SOURCE_BOUND_COLLECTIONS) {
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
      violations.push(`${key}[${badIndex}].sourceRefs must be a non-empty array of {path, exactQuote} objects`);
    }
  }
  return violations;
}

type SourceBoundRow = { id: string; sourceRefs: CccPrdSourceReferenceProposal[] };

function sourceBoundRows(fragment: CccPrdAuthoringProposalFragment): Array<[string, SourceBoundRow[]]> {
  return SOURCE_BOUND_COLLECTIONS.map((key) => [key, fragment[key] as SourceBoundRow[]]);
}

/** §3 step 2: every sourceRefs.path must equal the chunk's own sourcePath. */
export function describeCccPrdChunkForeignSourceViolations(
  fragment: CccPrdAuthoringProposalFragment,
  sourcePath: string,
): string[] {
  const violations: string[] = [];
  for (const [key, rows] of sourceBoundRows(fragment)) {
    for (const row of rows) {
      for (const reference of row.sourceRefs) {
        if (reference.path !== sourcePath) {
          violations.push(`${key} ${row.id} cites foreign source path ${reference.path}`);
        }
      }
    }
  }
  return violations;
}

/** §3 step 3: every exactQuote must occur inside the chunk's own slice bytes, not merely somewhere in the file. */
export function describeCccPrdChunkQuoteOutsideSliceViolations(
  fragment: CccPrdAuthoringProposalFragment,
  sliceBytes: Buffer,
): string[] {
  const violations: string[] = [];
  for (const [key, rows] of sourceBoundRows(fragment)) {
    for (const row of rows) {
      for (const reference of row.sourceRefs) {
        if (sliceBytes.indexOf(Buffer.from(reference.exactQuote, "utf8")) < 0) {
          violations.push(`${key} ${row.id} quote is absent from its chunk slice`);
        }
      }
    }
  }
  return violations;
}

function withoutSourceRefsUsingResolver<T extends SourceBoundRow>(
  input: T,
  sourceBytes: Buffer,
  sourcePath: string,
  sliceBounds: CccPrdAnchorSliceBounds,
  limits: CccPrdAnchorLimits | undefined,
): Omit<T, "sourceRefs"> & { spans: CccPrdSourceSpan[] } {
  const { sourceRefs, ...value } = input;
  const spans = sourceRefs.map((reference) => resolveCccPrdAnchor({
    sourcePath,
    source: sourceBytes,
    quote: reference.exactQuote,
    entityId: input.id,
    policy: "select",
    sliceBounds,
    limits,
  }).span);
  return { ...value, spans };
}

export type CccPrdResolvedChunkFragment = {
  authorityRoles: CccPrdAuthoringProposalFragment["authorityRoles"];
  requirements: CccPrdRequirement[];
  proofs: ReturnType<typeof withoutSourceRefsUsingResolver<CccPrdAuthoringProposalFragment["proofs"][number]>>[];
  tasks: CccPrdTask[];
  edges: CccPrdAuthoringProposalFragment["edges"];
  workflows: ReturnType<typeof withoutSourceRefsUsingResolver<CccPrdAuthoringProposalFragment["workflows"][number]>>[];
  documents: ReturnType<typeof withoutSourceRefsUsingResolver<CccPrdAuthoringProposalFragment["documents"][number]>>[];
  artifacts: ReturnType<typeof withoutSourceRefsUsingResolver<CccPrdAuthoringProposalFragment["artifacts"][number]>>[];
  importIntents: CccPrdAuthoringProposalFragment["importIntents"];
  protectedActions: ReturnType<typeof normalizeProtectedAction>[];
  unresolvedDecisions: CccPrdUnresolvedDecision[];
  ambiguities: ReturnType<typeof withoutSourceRefsUsingResolver<CccPrdAuthoringProposalFragment["ambiguities"][number]>>[];
  exceptions: ReturnType<typeof withoutSourceRefsUsingResolver<CccPrdAuthoringProposalFragment["exceptions"][number]>>[];
};

/**
 * §3 step 4: converts every source-bound row from `{sourceRefs}` to
 * `{spans}` using the selection-only resolver. Per design §5 this is the
 * chunked lane's OWN span-resolution route -- it never calls
 * resolveSourceRefs/mapProposal, and the spans it produces here are final.
 */
function resolveChunkFragmentSpans(
  fragment: CccPrdAuthoringProposalFragment,
  sourceBytes: Buffer,
  sourcePath: string,
  sliceBounds: CccPrdAnchorSliceBounds,
  limits: CccPrdAnchorLimits | undefined,
): CccPrdResolvedChunkFragment {
  const resolve = <T extends SourceBoundRow>(row: T) => (
    withoutSourceRefsUsingResolver(row, sourceBytes, sourcePath, sliceBounds, limits)
  );
  return {
    authorityRoles: fragment.authorityRoles,
    requirements: fragment.requirements.map(resolve),
    proofs: fragment.proofs.map(resolve),
    tasks: fragment.tasks.map(resolve),
    edges: fragment.edges,
    workflows: fragment.workflows.map(resolve),
    documents: fragment.documents.map(resolve),
    artifacts: fragment.artifacts.map(resolve),
    importIntents: fragment.importIntents,
    protectedActions: fragment.protectedActions.map((action) => normalizeProtectedAction({
      id: action.id,
      kind: action.kind,
      target: action.target,
      spans: resolve(action).spans,
    })),
    unresolvedDecisions: fragment.unresolvedDecisions.map(resolve),
    ambiguities: fragment.ambiguities.map(resolve),
    exceptions: fragment.exceptions.map(resolve),
  };
}

export type CccPrdChunkCoverageViolation = {
  materialItemId: string;
  /**
   * The heading (or requirement id) the item came from. `materialItemId` is a
   * truncated sha256 and means nothing to the model this violation is handed
   * back to as a retry instruction, so carry something findable in the source.
   */
  title: string;
  headingPath: string[];
  reason: "undispositioned" | "conflicted";
};

/** Section items already end their headingPath with their own title; requirement items do not. */
function describeCccPrdMaterialItem(violation: CccPrdChunkCoverageViolation): string {
  const path = violation.headingPath.at(-1) === violation.title
    ? violation.headingPath
    : [...violation.headingPath, violation.title];
  return path.length > 0 ? path.join(" > ") : violation.title;
}

/**
 * §3 step 5: runs the REAL scorer at chunk scope. A requirement alone never
 * dispositions anything (material-coverage.ts:216-223) -- only a matching
 * task, unresolved decision, explicit deferral, or explicit out-of-scope
 * marker does. Every item ASSIGNED to this chunk must land in `coverage`
 * and never in `conflicts`; items assigned to other chunks are ignored.
 */
export function checkCccPrdChunkCoverage(input: {
  sourcePath: string;
  fullSourceBytes: Buffer;
  assignedMaterialItemIds: string[];
  requirements: CccPrdRequirement[];
  tasks: CccPrdTask[];
  unresolvedDecisions: CccPrdUnresolvedDecision[];
}): CccPrdChunkCoverageViolation[] {
  const analysis = analyzeCccPrdMaterialCoverage({
    sourceBytes: new Map([[input.sourcePath, input.fullSourceBytes]]),
    requirements: input.requirements,
    tasks: input.tasks,
    unresolvedDecisions: input.unresolvedDecisions,
  });
  const covered = new Set(analysis.coverage.map((item) => item.id));
  const conflicted = new Set(analysis.conflicts.map((item) => item.id));
  const byId = new Map(analysis.inventory.map((item) => [item.id, item]));
  const violations: CccPrdChunkCoverageViolation[] = [];
  for (const id of input.assignedMaterialItemIds) {
    const item = byId.get(id);
    const named = {
      materialItemId: id,
      title: item?.title ?? "(unknown material item)",
      headingPath: item ? [...item.headingPath] : [],
    };
    if (conflicted.has(id)) {
      violations.push({ ...named, reason: "conflicted" });
    } else if (!covered.has(id)) {
      violations.push({ ...named, reason: "undispositioned" });
    }
  }
  return violations;
}

export type CccPrdChunkVerificationInput = {
  fragment: unknown;
  sourcePath: string;
  fullSourceBytes: Buffer;
  sliceBounds: CccPrdAnchorSliceBounds;
  assignedMaterialItemIds: string[];
  limits?: CccPrdAnchorLimits;
  /** Task custody (§3 step 6) only runs when execution-mode constraints are present. */
  hasConstraints?: boolean;
};

export type CccPrdChunkVerificationOutcome =
  | { ok: true; resolved: CccPrdResolvedChunkFragment }
  | { ok: false; code: string; violations: string[]; retryEligible: boolean };

/**
 * Runs every §3 check against real source bytes, cheapest and most
 * diagnostic first, stopping at the first violated step -- exactly the
 * order the design specifies.
 */
export function verifyCccPrdChunkFragment(
  input: CccPrdChunkVerificationInput,
): CccPrdChunkVerificationOutcome {
  const shapeViolations = describeCccPrdChunkFragmentShapeViolations(input.fragment);
  if (shapeViolations.length > 0) {
    return { ok: false, code: "CCC_PRD_CHUNK_FRAGMENT_INVALID", violations: shapeViolations, retryEligible: true };
  }
  const fragment = input.fragment as CccPrdAuthoringProposalFragment;

  const foreignSourceViolations = describeCccPrdChunkForeignSourceViolations(fragment, input.sourcePath);
  if (foreignSourceViolations.length > 0) {
    return { ok: false, code: "CCC_PRD_CHUNK_FOREIGN_SOURCE", violations: foreignSourceViolations, retryEligible: true };
  }

  const sliceBytes = input.fullSourceBytes.subarray(input.sliceBounds.byteStart, input.sliceBounds.byteEnd);
  const outsideSliceViolations = describeCccPrdChunkQuoteOutsideSliceViolations(fragment, sliceBytes);
  if (outsideSliceViolations.length > 0) {
    return { ok: false, code: "CCC_PRD_CHUNK_QUOTE_OUTSIDE_SLICE", violations: outsideSliceViolations, retryEligible: true };
  }

  let resolved: CccPrdResolvedChunkFragment;
  try {
    resolved = resolveChunkFragmentSpans(
      fragment,
      input.fullSourceBytes,
      input.sourcePath,
      input.sliceBounds,
      input.limits,
    );
  } catch (error) {
    if (error instanceof CccPrdCustodyError) {
      const retryEligibleCodes = new Set([
        "CCC_PRD_SOURCE_QUOTE_MISSING",
        "CCC_PRD_ANCHOR_AMBIGUOUS_INTENT",
      ]);
      return {
        ok: false,
        code: error.code,
        violations: [error.message],
        retryEligible: retryEligibleCodes.has(error.code),
      };
    }
    throw error;
  }

  const coverageViolations = checkCccPrdChunkCoverage({
    sourcePath: input.sourcePath,
    fullSourceBytes: input.fullSourceBytes,
    assignedMaterialItemIds: input.assignedMaterialItemIds,
    requirements: resolved.requirements,
    tasks: resolved.tasks,
    unresolvedDecisions: resolved.unresolvedDecisions,
  });
  if (coverageViolations.length > 0) {
    const hasConflict = coverageViolations.some((violation) => violation.reason === "conflicted");
    return {
      ok: false,
      code: hasConflict ? "CCC_PRD_CHUNK_MATERIAL_CONFLICTED" : "CCC_PRD_CHUNK_MATERIAL_UNDISPOSITIONED",
      violations: coverageViolations.map((violation) => (
        `material item "${describeCccPrdMaterialItem(violation)}" (${violation.materialItemId})`
        + ` is ${violation.reason} at chunk scope`
      )),
      retryEligible: true,
    };
  }

  if (input.hasConstraints) {
    const custodyDiagnostics = validateTaskCustodyProvenance({ tasks: resolved.tasks } as never);
    if (custodyDiagnostics.length > 0) {
      return {
        ok: false,
        code: custodyDiagnostics[0]!.code,
        violations: custodyDiagnostics.map((diagnostic) => diagnostic.message),
        retryEligible: false,
      };
    }
  }

  return { ok: true, resolved };
}

export type CccPrdChunkAttemptTransport = (input: {
  prompt: string;
  attempt: number;
}) => Promise<{ provider: string; model: string; text: string }>;

export type RunCccPrdChunkAttemptInput = {
  chunkId: string;
  sourcePath: string;
  fullSourceBytes: Buffer;
  sliceBounds: CccPrdAnchorSliceBounds;
  assignedMaterialItemIds: string[];
  expectedProvider: string;
  expectedModel: string;
  transport: CccPrdChunkAttemptTransport;
  buildPrompt: (priorViolations: string[]) => string;
  maxChunkAttempts?: number;
  limits?: CccPrdAnchorLimits;
  hasConstraints?: boolean;
};

/**
 * The per-chunk retry loop (design §3 "Retry versus refusal"). Retries a
 * mechanically-diagnosable, model-fixable failure once (default
 * maxChunkAttempts=2: one attempt plus one repair), carrying the exact
 * enumerated violations forward. Route/infrastructure failures -- here,
 * transport identity drift -- are never retried.
 */
export async function runCccPrdChunkAttempt(
  input: RunCccPrdChunkAttemptInput,
): Promise<CccPrdResolvedChunkFragment> {
  const maxAttempts = input.maxChunkAttempts ?? 2;
  let priorViolations: string[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const prompt = input.buildPrompt(priorViolations);
    const response = await input.transport({ prompt, attempt });
    if (response.provider !== input.expectedProvider || response.model !== input.expectedModel) {
      throw new Error(
        `CCC PRD chunk authoring transport identity drifted: expected ${input.expectedProvider}/${input.expectedModel}, `
          + `received ${response.provider}/${response.model}`,
      );
    }

    let parsedFragment: unknown;
    try {
      parsedFragment = JSON.parse(stripOutermostJsonFence(response.text));
    } catch {
      priorViolations = ["fragment response is not valid JSON"];
      continue;
    }

    const outcome = verifyCccPrdChunkFragment({
      fragment: parsedFragment,
      sourcePath: input.sourcePath,
      fullSourceBytes: input.fullSourceBytes,
      sliceBounds: input.sliceBounds,
      assignedMaterialItemIds: input.assignedMaterialItemIds,
      limits: input.limits,
      hasConstraints: input.hasConstraints,
    });
    if (outcome.ok) return outcome.resolved;
    if (!outcome.retryEligible) {
      throw new CccPrdCustodyError(outcome.code, outcome.violations.join("; "));
    }
    priorViolations = outcome.violations;
  }

  throw new CccPrdCustodyError(
    "CCC_PRD_CHUNK_ATTEMPTS_EXHAUSTED",
    `chunk ${input.chunkId} exhausted ${maxAttempts} attempts; surviving violations: ${priorViolations.join("; ")}`,
  );
}

/**
 * §4 "Review-item budget": checked as a running total after every chunk, so
 * a run whose budget is already blown refuses at the offending chunk
 * instead of after the whole plan finishes.
 */
export function checkCccPrdChunkReviewBudget(input: {
  chunkOrdinal: number;
  runningReviewItemCount: number;
  maxReviewItems: number;
}): void {
  if (input.runningReviewItemCount > input.maxReviewItems) {
    throw new CccPrdCustodyError(
      "CCC_PRD_CHUNK_REVIEW_BUDGET_EXCEEDED",
      `running review-item total ${input.runningReviewItemCount} exceeded maxReviewItems `
        + `${input.maxReviewItems} at chunk ${input.chunkOrdinal}`,
    );
  }
}
