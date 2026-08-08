import {
  CCC_PRD_AUTHORING_PROPOSAL_FRAGMENT_SCHEMA_VERSION,
  CCC_PRD_PROTECTED_ACTION_KINDS,
  normalizeProtectedAction,
  type CccPrdAuthoringProposalFragment,
  type CccPrdRequirement,
  type CccPrdSourceReferenceProposal,
  type CccPrdSourceSpan,
  type CccPrdTask,
  type CccPrdUnresolvedDecision,
} from "@fusion/core";
import {
  cccPrdLocatorOptionsFor,
  DEFAULT_CCC_PRD_QUOTE_MATCH_POLICY,
  resolveCccPrdAnchor,
  type CccPrdAnchorLimits,
  type CccPrdAnchorReceipt,
  type CccPrdAnchorSliceBounds,
  type CccPrdQuoteMatchPolicy,
} from "./anchor-resolver.js";
import {
  IDENTITY_COLLECTIONS,
  SOURCE_BOUND_COLLECTIONS,
  validateTaskCustodyProvenance,
} from "./authoring.js";
import {
  CccPrdCustodyError,
  CccPrdRepairableModelOutputError,
  describeCccPrdQuoteForRejection,
} from "./custody.js";
import { analyzeCccPrdMaterialCoverage } from "./material-coverage.js";
import { stripOutermostJsonFence } from "./native-authoring-adapter.js";
import { locateCccPrdQuote } from "./quote-locator.js";

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
  /*
   * A protected-action kind outside the legal 8 used to reach
   * normalizeProtectedAction in packages/core, which throws a bare Error.
   * packages/core does not import the engine's error class, so the catch
   * around span resolution declined it and it escaped the chunk loop --
   * killing the document over a mislabelled row. Catching it here, in the
   * shape gate, makes it an ordinary retry-eligible fragment violation.
   */
  const protectedActions = value.protectedActions;
  if (Array.isArray(protectedActions)) {
    const legal = CCC_PRD_PROTECTED_ACTION_KINDS as readonly unknown[];
    const badKinds = [...new Set(
      protectedActions
        .filter((entry) => isPlainRecord(entry))
        .map((entry) => (entry as Record<string, unknown>).kind)
        .filter((kind) => !legal.includes(kind))
        .map((kind) => (typeof kind === "string" ? JSON.stringify(kind) : String(kind))),
    )];
    if (badKinds.length > 0) {
      violations.push(
        `protectedActions kind ${badKinds.join(", ")} is not a protected action kind. `
          + `Use exactly one of: ${CCC_PRD_PROTECTED_ACTION_KINDS.join(", ")}. `
          + "A protected action is one an operator must approve because it is irreversible, "
          + "outward-facing, or spends money or authority; ordinary work such as creating a file, "
          + "adding a test, or writing documentation is not protected, so omit the row rather than "
          + "inventing a kind for it.",
      );
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

/**
 * §3 step 3: every exactQuote must occur inside the chunk's own slice bytes,
 * not merely somewhere in the file.
 *
 * This is a pre-flight predicate: it yields a boolean and a violation string,
 * never an offset, and nothing is substituted here. It matters only because
 * `verifyCccPrdChunkFragment` runs it BEFORE span resolution -- a byte-exact
 * gate here refuses a drifted quote before `resolveCccPrdAnchor` ever gets to
 * recover it, which would make the resolver's loose locate dead code. So it
 * asks the same question the resolver will: can the locator find this quote at
 * all, under the same policy?
 *
 * "Ambiguous" deliberately PASSES. The quote is genuinely inside the slice;
 * which of several regions it means is the resolver's call, and the resolver
 * refuses it loudly by naming every candidate. Rejecting here instead would
 * replace that diagnostic with a bare "absent from its chunk slice", which is
 * both wrong and useless to the retry prompt.
 */
export function describeCccPrdChunkQuoteOutsideSliceViolations(
  fragment: CccPrdAuthoringProposalFragment,
  sliceBytes: Buffer,
  quoteMatchPolicy?: CccPrdQuoteMatchPolicy,
): string[] {
  // Built through the shared choke point rather than by hand, so this gate
  // cannot be relaxed by a policy that skipped the inseparability check.
  const options = cccPrdLocatorOptionsFor(quoteMatchPolicy ?? DEFAULT_CCC_PRD_QUOTE_MATCH_POLICY);
  const disableFuzzy = options.disableFuzzy === true;
  const violations: string[] = [];
  for (const [key, rows] of sourceBoundRows(fragment)) {
    for (const row of rows) {
      for (const reference of row.sourceRefs) {
        const located = locateCccPrdQuote(sliceBytes, reference.exactQuote, options);
        if (located.kind === "notFound") {
          violations.push(
            `${key} ${row.id} quote is absent from its chunk slice`
            + `${disableFuzzy ? " (exact and normalized matching only; fuzzy matching is disabled)" : ""}: `
            + describeCccPrdQuoteForRejection(reference.exactQuote),
          );
        }
      }
    }
  }
  return violations;
}

/**
 * Everything the per-row resolve needs, plus the `receipts` sink.
 *
 * The resolver has always returned a `{span, receipt}` pair and this call site
 * has always kept the span and dropped the receipt on the floor. That receipt
 * is now the only surviving record of HOW a quote was matched -- persisted
 * spans carry coordinates and hashes, never text or strategy -- so it is
 * collected here and handed back out of `verifyCccPrdChunkFragment`. Nothing
 * about the persisted artifact changes; this is a diagnostic channel that
 * already existed and was simply not connected to anything.
 */
type ChunkSpanResolutionContext = {
  sourceBytes: Buffer;
  sourcePath: string;
  sliceBounds: CccPrdAnchorSliceBounds;
  limits: CccPrdAnchorLimits | undefined;
  quoteMatchPolicy: CccPrdQuoteMatchPolicy | undefined;
  receipts: CccPrdAnchorReceipt[];
};

function withoutSourceRefsUsingResolver<T extends SourceBoundRow>(
  input: T,
  context: ChunkSpanResolutionContext,
): Omit<T, "sourceRefs"> & { spans: CccPrdSourceSpan[] } {
  const { sourceRefs, ...value } = input;
  const spans = sourceRefs.map((reference) => {
    const resolution = resolveCccPrdAnchor({
      sourcePath: context.sourcePath,
      source: context.sourceBytes,
      quote: reference.exactQuote,
      entityId: input.id,
      policy: "select",
      sliceBounds: context.sliceBounds,
      limits: context.limits,
      quoteMatchPolicy: context.quoteMatchPolicy,
    });
    context.receipts.push(resolution.receipt);
    return resolution.span;
  });
  return { ...value, spans };
}

/**
 * One fuzzy match, in the form an operator has to see it: the model's wording
 * and the source's own wording side by side.
 *
 * The span is correct either way -- it always delimits true source bytes -- so
 * this is not about the citation. It is about the CLAIM the model built on a
 * sentence it retyped wrong. A meaning-inverting edit scores 0.9747, above the
 * innocent drift this tier exists to accept at 0.9449, so nothing downstream
 * can tell those apart. A human reading these two strings can.
 */
export type CccPrdFuzzyQuoteReviewNotice = {
  entityId: string;
  sourcePath: string;
  /** Locator similarity, 0..1. Deliberately NOT a pass/fail signal -- see the type doc. */
  similarity: number;
  quoteAsModelWrote: string;
  matchedSourceText: string;
  /** The same facts as one human-readable line, for log and message surfaces. */
  message: string;
};

function fuzzyQuoteReviewNotice(receipt: CccPrdAnchorReceipt): CccPrdFuzzyQuoteReviewNotice {
  const drift = receipt.fuzzyDrift!;
  return {
    entityId: receipt.entityId,
    sourcePath: receipt.sourcePath,
    similarity: drift.score,
    quoteAsModelWrote: drift.quoteAsModelWrote,
    matchedSourceText: drift.matchedSourceText,
    message: `${receipt.entityId} in ${receipt.sourcePath} was anchored by fuzzy match `
      + `(similarity ${drift.score.toFixed(4)}); model wrote `
      + `${describeCccPrdQuoteForRejection(drift.quoteAsModelWrote)} but the span emits `
      + `${describeCccPrdQuoteForRejection(drift.matchedSourceText)}`,
  };
}

/**
 * Every fuzzy match in the batch, structured.
 *
 * The filter is on `fuzzyDrift` being present, NOT on `requiresReview`. Those
 * are equivalent under the policy union -- fuzzy cannot be enabled without
 * review recording -- and that is exactly why the weaker predicate is the
 * right one here: if a receipt ever did arrive with `requiresReview: false`,
 * filtering on it would silently drop the one match most worth seeing.
 */
export function collectCccPrdFuzzyQuoteReviewNotices(
  receipts: readonly CccPrdAnchorReceipt[],
): CccPrdFuzzyQuoteReviewNotice[] {
  return receipts
    .filter((receipt) => receipt.fuzzyDrift !== undefined)
    .map(fuzzyQuoteReviewNotice);
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
  context: ChunkSpanResolutionContext,
): CccPrdResolvedChunkFragment {
  const resolve = <T extends SourceBoundRow>(row: T) => (
    withoutSourceRefsUsingResolver(row, context)
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
  /** Defaults to `DEFAULT_CCC_PRD_QUOTE_MATCH_POLICY` (deterministic tiers only). */
  quoteMatchPolicy?: CccPrdQuoteMatchPolicy;
  /** Task custody (§3 step 6) only runs when execution-mode constraints are present. */
  hasConstraints?: boolean;
};

export type CccPrdChunkVerificationOutcome =
  | {
      ok: true;
      resolved: CccPrdResolvedChunkFragment;
      /** One per resolved sourceRef, in resolution order. Diagnostic only; nothing here is persisted. */
      anchorReceipts: CccPrdAnchorReceipt[];
      /** One per quote anchored by GUESSING. Empty whenever every quote matched deterministically. */
      fuzzyReviewNotices: CccPrdFuzzyQuoteReviewNotice[];
    }
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
  const outsideSliceViolations = describeCccPrdChunkQuoteOutsideSliceViolations(
    fragment,
    sliceBytes,
    input.quoteMatchPolicy,
  );
  if (outsideSliceViolations.length > 0) {
    return { ok: false, code: "CCC_PRD_CHUNK_QUOTE_OUTSIDE_SLICE", violations: outsideSliceViolations, retryEligible: true };
  }

  const anchorReceipts: CccPrdAnchorReceipt[] = [];
  let resolved: CccPrdResolvedChunkFragment;
  try {
    resolved = resolveChunkFragmentSpans(fragment, {
      sourceBytes: input.fullSourceBytes,
      sourcePath: input.sourcePath,
      sliceBounds: input.sliceBounds,
      limits: input.limits,
      quoteMatchPolicy: input.quoteMatchPolicy,
      receipts: anchorReceipts,
    });
  } catch (error) {
    if (error instanceof CccPrdCustodyError) {
      const retryEligibleCodes = new Set([
        "CCC_PRD_SOURCE_QUOTE_MISSING",
        "CCC_PRD_ANCHOR_AMBIGUOUS_INTENT",
        // A loose match that landed on two indistinguishable regions. The model
        // can fix this by quoting whatever distinguishes them, so it retries.
        "CCC_PRD_ANCHOR_QUOTE_AMBIGUOUS_MATCH",
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

  return {
    ok: true,
    resolved,
    anchorReceipts,
    fuzzyReviewNotices: collectCccPrdFuzzyQuoteReviewNotices(anchorReceipts),
  };
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
  /** Defaults to `DEFAULT_CCC_PRD_QUOTE_MATCH_POLICY` (deterministic tiers only). */
  quoteMatchPolicy?: CccPrdQuoteMatchPolicy;
  /**
   * Receives the anchor receipts of the attempt that succeeded, so how each
   * quote was matched reaches a caller instead of being discarded. Called once,
   * only on success; failed attempts resolve no spans worth reporting.
   */
  onAnchorReceipts?: (input: {
    chunkId: string;
    receipts: CccPrdAnchorReceipt[];
    fuzzyReviewNotices: CccPrdFuzzyQuoteReviewNotice[];
  }) => void;
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
    let response: { provider: string; model: string; text: string };
    try {
      response = await input.transport({ prompt, attempt });
    } catch (error) {
      // Output-size faults -- truncation at the model's token ceiling, a
      // response past maxResponseBytes -- reach this await from inside the
      // transport, which no other try/catch in this loop covers. They used to
      // escape and kill the document; running out of output room is the most
      // likely thing a large chunk does, and "you produced too much" is an
      // instruction a retry can act on. Anything not self-declared repairable
      // (identity drift, egress policy, infra timeouts) still escapes.
      if (error instanceof CccPrdRepairableModelOutputError) {
        priorViolations = [error.message];
        continue;
      }
      throw error;
    }
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
      quoteMatchPolicy: input.quoteMatchPolicy,
      hasConstraints: input.hasConstraints,
    });
    if (outcome.ok) {
      input.onAnchorReceipts?.({
        chunkId: input.chunkId,
        receipts: outcome.anchorReceipts,
        fuzzyReviewNotices: outcome.fuzzyReviewNotices,
      });
      return outcome.resolved;
    }
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
