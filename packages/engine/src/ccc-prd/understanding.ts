import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import {
  canonicalCccPrdJson,
  type CccPrdAdmittedWriteRoot,
  type CccPrdAuthoringAdapter,
  type CccPrdAuthoringReview,
  type CccPrdDiagnostic,
  type CccPrdExecutionBounds,
  type CccPrdMaterialCoverageItem,
  type CccPrdSidecar,
  type CccPrdTargetRepository,
  type CustomProvider,
  type WorkflowExtensionRegistry,
} from "@fusion/core";
import { authorCccPrdPacket } from "./authoring.js";
import type { CccPrdAnchorLimits } from "./anchor-resolver.js";
import type { CccPrdChunkPolicy } from "./chunk-planner.js";
import {
  CCC_PRD_NO_FUZZY_QUOTE_REVIEW,
  runCccPrdChunkedUnderstanding,
  type CccPrdQuoteReview,
} from "./chunk-orchestrator.js";
import { readCccPrdPacketCustody } from "./custody.js";
import {
  classifyCccPrdLane,
  type CccPrdLaneClassifierPolicy,
  type CccPrdRequestedLane,
} from "./lane-classifier.js";
import { analyzeCccPrdMaterialCoverage, computeCccPrdMaterialInventory } from "./material-coverage.js";
import type { CccPrdNativeAuthoringTransport } from "./native-authoring-adapter.js";

export const CCC_PRD_UNDERSTANDING_REVIEW_SCHEMA_VERSION =
  "ccc-prd.understanding-review.v1" as const;

type CoverageInventoryItem = Omit<CccPrdMaterialCoverageItem, "disposition">;

const sha256 = (value: Buffer | string): string => createHash("sha256").update(value).digest("hex");

function hasStringCode(value: unknown): value is Error & { code: string } {
  return value instanceof Error && typeof (value as { code?: unknown }).code === "string";
}

const SHALLOW_INVENTORY_THRESHOLD = 8;
const SHALLOW_REQUIREMENT_THRESHOLD = 4;
const MINIMUM_OVERALL_DISPOSITION_NUMERATOR = 1;
const MINIMUM_OVERALL_DISPOSITION_DENOMINATOR = 4;
const MINIMUM_REQUIREMENT_DISPOSITION_NUMERATOR = 1;
const MINIMUM_REQUIREMENT_DISPOSITION_DENOMINATOR = 2;

export type CccPrdUnderstandingMissingFact = {
  code: string;
  question: string;
};

export type CccPrdUnderstandingReview = {
  schema: typeof CCC_PRD_UNDERSTANDING_REVIEW_SCHEMA_VERSION;
  kind: "understanding-review";
  executable: false;
  sourceVersion: string;
  orderedSources: CccPrdSidecar["orderedSources"];
  provenance: CccPrdSidecar["provenance"];
  authorityRoles: CccPrdSidecar["authorityRoles"];
  requirements: CccPrdSidecar["requirements"];
  proofs: CccPrdSidecar["proofs"];
  tasks: CccPrdSidecar["tasks"];
  edges: CccPrdSidecar["edges"];
  workflows: CccPrdSidecar["workflows"];
  documents: CccPrdSidecar["documents"];
  artifacts: CccPrdSidecar["artifacts"];
  proposedImportIntents: CccPrdSidecar["importIntents"];
  protectedActions: CccPrdSidecar["protectedActions"];
  nonGoals: CccPrdSidecar["nonGoals"];
  assumptions: [];
  ambiguities: CccPrdSidecar["ambiguities"];
  exceptions: CccPrdSidecar["exceptions"];
  unresolvedDecisions: CccPrdSidecar["unresolvedDecisions"];
  confidence: CccPrdSidecar["confidence"];
  implementationContext: {
    approvalStatus: "unapproved";
    targetRepository: {
      path: string | null;
      baseCommit: string | null;
    };
    bounds: {
      maxRequests: number | null;
      maxDurationMs: number | null;
      maxConcurrency: number | null;
    };
    admittedWriteRoots: CccPrdSidecar["admittedWriteRoots"];
    missingFacts: CccPrdUnderstandingMissingFact[];
  };
  coverage: {
    inventoryCount: number;
    dispositionCount: number;
    dispositions: CccPrdMaterialCoverageItem[];
    missing: CoverageInventoryItem[];
    conflicts: CoverageInventoryItem[];
  };
  review: CccPrdAuthoringReview;
};

export type UnderstandCccPrdInput = {
  rootDir: string;
  manifestPath: string;
  adapter: CccPrdAuthoringAdapter;
  maxReviewItems: number;
  workflowExtensionRegistry: WorkflowExtensionRegistry;
  /**
   * Design §7 (D-3). Defaults to "single", which reproduces today's
   * single-shot-only behavior byte-for-byte -- an existing caller that
   * never passes this field (including the frozen acceptance-gate fixture)
   * is completely unaffected. Only "auto" or "chunked" reach the classifier
   * and the chunked pipeline, and those require the transport-config
   * fields below.
   */
  requestedLane?: CccPrdRequestedLane;
  laneClassifierPolicy?: Partial<CccPrdLaneClassifierPolicy>;
  contextWindow?: number;
  reservedOutputTokens?: number;
  /** Required only when requestedLane is "auto" or "chunked". */
  provider?: string;
  model?: string;
  maxDurationMs?: number;
  maxPromptBytes?: number;
  maxResponseBytes?: number;
  maxChunkAttempts?: number;
  chunkPolicy?: Partial<CccPrdChunkPolicy>;
  anchorLimits?: CccPrdAnchorLimits;
  /** Test-only seam; production omits it and uses the real transport. */
  chunkTransport?: CccPrdNativeAuthoringTransport;
  customProviders?: CustomProvider[];
};

/**
 * `lane` and `quoteReview` are carried on the return value only, never on
 * {@link CccPrdUnderstandingReview} itself -- design §7 requires the CLI to
 * emit `lane` in its JSON wrapper "not in the stored artifact, so
 * CccPrdUnderstandingReview and the on-disk schema are unchanged." The CLI
 * strips both fields before persisting and re-adds them only to the printed
 * payload.
 *
 * `quoteReview` follows `lane` because it is the same kind of fact: something
 * an operator must SEE about how this run behaved, which has no business in a
 * frozen artifact schema. It is required rather than optional so no lane can
 * quietly omit it -- "no quotes were guessed" and "nobody reported" have to
 * look different.
 *
 * On the refusal it is OPTIONAL, and that asymmetry is deliberate. A failed
 * document still has to report the quotes its completed chunks guessed at --
 * that is the whole point, and a refusal is the only output such a run ever
 * produces -- but most refusals come from lanes and stages where no quote was
 * ever matched (bad review bound, missing transport config, the whole
 * single-shot lane). Printing an empty review on all of them would bury the
 * one that means something. Present therefore means "this run guessed, here is
 * what it guessed at"; absent means there is nothing to review.
 */
export type CccPrdUnderstandingResult =
  | (CccPrdUnderstandingReview & { lane: "single" | "chunked"; quoteReview: CccPrdQuoteReview })
  | { kind: "refusal"; diagnostics: CccPrdDiagnostic[]; quoteReview?: CccPrdQuoteReview };

function positive(value: number): number | null {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function inventoryItem(
  value: CoverageInventoryItem & Record<string, unknown>,
): CoverageInventoryItem {
  return {
    id: value.id,
    sourcePath: value.sourcePath,
    materialKind: value.materialKind,
    headingPath: [...value.headingPath],
    title: value.title,
    spans: value.spans,
  };
}

function implementationContext(
  sidecar: {
    targetRepository: CccPrdTargetRepository;
    bounds: CccPrdExecutionBounds;
    admittedWriteRoots: CccPrdAdmittedWriteRoot[];
  },
): CccPrdUnderstandingReview["implementationContext"] {
  const targetPath = sidecar.targetRepository.path.trim();
  const baseCommit = sidecar.targetRepository.baseCommit.trim();
  const path = targetPath && isAbsolute(targetPath) ? targetPath : null;
  const base = /^[0-9a-f]{40}$/u.test(baseCommit) ? baseCommit : null;
  const bounds = {
    maxRequests: positive(sidecar.bounds.maxRequests),
    maxDurationMs: positive(sidecar.bounds.maxDurationMs),
    maxConcurrency: positive(sidecar.bounds.maxConcurrency),
  };
  const missingFacts: CccPrdUnderstandingMissingFact[] = [];
  if (!path) {
    missingFacts.push({
      code: "CCC_PRD_TARGET_REPOSITORY_REQUIRED",
      question: "Which target repository should this PRD change?",
    });
  }
  if (!base) {
    missingFacts.push({
      code: "CCC_PRD_BASELINE_REQUIRED",
      question: "Which exact 40-hex baseline commit should Fusion freeze?",
    });
  }
  if (Object.values(bounds).some((value) => value === null)) {
    missingFacts.push({
      code: "CCC_PRD_EXECUTION_BOUNDS_REQUIRED",
      question: "What request, duration, and concurrency limits should this campaign obey?",
    });
  }
  if (sidecar.admittedWriteRoots.length === 0) {
    missingFacts.push({
      code: "CCC_PRD_ALLOWED_PATHS_REQUIRED",
      question: "Which target-relative paths or write roots may the campaign change?",
    });
  }
  return {
    approvalStatus: "unapproved",
    targetRepository: { path, baseCommit: base },
    bounds,
    admittedWriteRoots: sidecar.admittedWriteRoots,
    missingFacts,
  };
}

/** Byte-to-token heuristic used for the lane classifier's context-fit check, matching the corpus-diversity-matrix's own bytes/4 approximation. */
const BYTES_PER_TOKEN_ESTIMATE = 4;

export type ShallowExtractionAnalysis = {
  inventory: unknown[];
  coverage: unknown[];
  requirementInventoryCount: number;
  requirementDispositionCount: number;
};

/**
 * The understanding depth gate is a floor, not a completeness check
 * (understanding.ts, design §0/§4): it refuses only when material or
 * explicit-requirement disposition falls under threshold. On the chunked
 * lane this is structurally unreachable in normal operation --
 * assembleCccPrdChunkedUnderstanding already refuses on any non-empty
 * missing/conflicts, so a successfully assembled chunked result always has
 * inventory === coverage (100% dispositioned), and the ratio check can
 * never trip. It is still wired into the chunked path as a tripwire: "if
 * it ever fires there, that is the alarm that planner and scorer
 * diverged" (design §4).
 */
export function describeCccPrdShallowExtractionRefusal(
  analysis: ShallowExtractionAnalysis,
): CccPrdDiagnostic | null {
  const overallExtractionIsShallow =
    analysis.inventory.length >= SHALLOW_INVENTORY_THRESHOLD
    && analysis.coverage.length * MINIMUM_OVERALL_DISPOSITION_DENOMINATOR
      < analysis.inventory.length * MINIMUM_OVERALL_DISPOSITION_NUMERATOR;
  const requirementExtractionIsShallow =
    analysis.requirementInventoryCount >= SHALLOW_REQUIREMENT_THRESHOLD
    && analysis.requirementDispositionCount
      * MINIMUM_REQUIREMENT_DISPOSITION_DENOMINATOR
      < analysis.requirementInventoryCount
        * MINIMUM_REQUIREMENT_DISPOSITION_NUMERATOR;
  if (!overallExtractionIsShallow && !requirementExtractionIsShallow) return null;
  return {
    code: "CCC_PRD_UNDERSTANDING_IMPLAUSIBLY_SHALLOW",
    message: [
      "understanding coverage is too shallow to trust",
      `material inventory=${analysis.inventory.length}`,
      `material dispositions=${analysis.coverage.length}`,
      `explicit requirement inventory=${analysis.requirementInventoryCount}`,
      `explicit requirement dispositions=${analysis.requirementDispositionCount}`,
    ].join("; "),
  };
}

async function runSingleShotUnderstanding(
  input: UnderstandCccPrdInput,
): Promise<CccPrdUnderstandingResult> {
  const authored = await authorCccPrdPacket({
    rootDir: input.rootDir,
    manifestPath: input.manifestPath,
    adapter: input.adapter,
    workflowExtensionRegistry: input.workflowExtensionRegistry,
  });
  if (authored.kind === "refusal") return authored;
  if (authored.sidecar.requirements.length === 0) {
    return {
      kind: "refusal",
      diagnostics: [{
        code: "CCC_PRD_UNDERSTANDING_ZERO_REQUIREMENTS",
        message: "understanding extracted zero requirements from the frozen PRD packet",
      }],
    };
  }
  const reviewCount = authored.review.ambiguities.length
    + authored.review.unresolvedDecisions.length
    + authored.review.exceptions.length
    + authored.review.protectedActions.length;
  if (reviewCount > input.maxReviewItems) {
    return {
      kind: "refusal",
      diagnostics: [{
        code: "CCC_PRD_AUTHORING_REVIEW_UNBOUNDED",
        message: `understanding review count ${reviewCount} exceeds admitted maximum ${input.maxReviewItems}`,
      }],
    };
  }

  const custody = readCccPrdPacketCustody(input);
  const analysis = analyzeCccPrdMaterialCoverage({
    sourceBytes: custody.sourceBytes,
    requirements: authored.sidecar.requirements,
    tasks: authored.sidecar.tasks,
    unresolvedDecisions: authored.sidecar.unresolvedDecisions,
  });
  const requirementInventoryCount = analysis.inventory.filter(
    ({ materialKind }) => materialKind === "requirement",
  ).length;
  const requirementDispositionCount = analysis.coverage.filter(
    ({ materialKind }) => materialKind === "requirement",
  ).length;
  const shallowRefusal = describeCccPrdShallowExtractionRefusal({
    inventory: analysis.inventory,
    coverage: analysis.coverage,
    requirementInventoryCount,
    requirementDispositionCount,
  });
  if (shallowRefusal) {
    return { kind: "refusal", diagnostics: [shallowRefusal] };
  }
  return {
    lane: "single",
    // The single-shot lane resolves quotes byte-exactly (authoring.ts) and
    // never reaches the fuzzy tier, so it reports "no guessing was possible
    // here" rather than leaving the field absent.
    quoteReview: CCC_PRD_NO_FUZZY_QUOTE_REVIEW,
    schema: CCC_PRD_UNDERSTANDING_REVIEW_SCHEMA_VERSION,
    kind: "understanding-review",
    executable: false,
    sourceVersion: authored.sidecar.sourceVersion,
    orderedSources: authored.sidecar.orderedSources,
    provenance: authored.sidecar.provenance,
    authorityRoles: authored.sidecar.authorityRoles,
    requirements: authored.sidecar.requirements,
    proofs: authored.sidecar.proofs,
    tasks: authored.sidecar.tasks,
    edges: authored.sidecar.edges,
    workflows: authored.sidecar.workflows,
    documents: authored.sidecar.documents,
    artifacts: authored.sidecar.artifacts,
    proposedImportIntents: authored.sidecar.importIntents,
    protectedActions: authored.sidecar.protectedActions,
    nonGoals: authored.sidecar.nonGoals,
    assumptions: [],
    ambiguities: authored.sidecar.ambiguities,
    exceptions: authored.sidecar.exceptions,
    unresolvedDecisions: authored.sidecar.unresolvedDecisions,
    confidence: authored.sidecar.confidence,
    implementationContext: implementationContext(authored.sidecar),
    coverage: {
      inventoryCount: analysis.inventory.length,
      dispositionCount: analysis.coverage.length,
      dispositions: analysis.coverage,
      missing: analysis.missing.map((item) =>
        inventoryItem(item as CoverageInventoryItem & Record<string, unknown>)),
      conflicts: analysis.conflicts.map((item) =>
        inventoryItem(item as CoverageInventoryItem & Record<string, unknown>)),
    },
    review: authored.review,
  };
}

/**
 * Attaches the run's quote review to a refusal, but only when the run actually
 * guessed at something.
 *
 * A refusal is everything an operator gets for a failed document, so any quote
 * the completed chunks recovered by guessing has to ride out on it. A review
 * reporting zero guesses is left off entirely: on the success path the empty
 * review is meaningful (it distinguishes "clean run" from "nobody looked"), but
 * on a failure it would print on nearly every refusal the pipeline emits and
 * train readers to skip the field that matters.
 */
function refusal(
  diagnostics: CccPrdDiagnostic[],
  quoteReview: CccPrdQuoteReview | undefined,
): CccPrdUnderstandingResult {
  return quoteReview && quoteReview.fuzzyMatchCount > 0
    ? { kind: "refusal", diagnostics, quoteReview }
    : { kind: "refusal", diagnostics };
}

async function runChunkedUnderstanding(
  input: UnderstandCccPrdInput,
): Promise<CccPrdUnderstandingResult> {
  if (!input.provider || !input.model || !input.maxDurationMs || !input.maxPromptBytes || !input.maxResponseBytes) {
    return {
      kind: "refusal",
      diagnostics: [{
        code: "CCC_PRD_CHUNK_TRANSPORT_CONFIG_REQUIRED",
        message: "chunked understanding requires provider, model, maxDurationMs, maxPromptBytes, and maxResponseBytes",
      }],
    };
  }

  /*
   * Lives HERE, in the caller's frame, on purpose. The receipts it mirrors are
   * accumulated inside runCccPrdChunkedUnderstanding, and every refusal that
   * pipeline produces is a throw -- so its own accumulator is unreachable by
   * the time the catch below runs. Holding the latest snapshot out here is what
   * makes a guess made in chunk 1 survive a document that dies at chunk 6.
   */
  let observedQuoteReview: CccPrdQuoteReview | undefined;

  let chunkResult: Awaited<ReturnType<typeof runCccPrdChunkedUnderstanding>>;
  try {
    chunkResult = await runCccPrdChunkedUnderstanding({
      rootDir: input.rootDir,
      manifestPath: input.manifestPath,
      mode: "understanding",
      provider: input.provider,
      model: input.model,
      maxDurationMs: input.maxDurationMs,
      maxPromptBytes: input.maxPromptBytes,
      maxResponseBytes: input.maxResponseBytes,
      maxReviewItems: input.maxReviewItems,
      maxChunkAttempts: input.maxChunkAttempts,
      chunkPolicy: input.chunkPolicy,
      anchorLimits: input.anchorLimits,
      transport: input.chunkTransport,
      customProviders: input.customProviders,
      onQuoteReviewProgress: (review) => { observedQuoteReview = review; },
    });
  } catch (error) {
    // Never an uncaught rejection: chunk-plan/verification/assembly refusals
    // raise CccPrdCustodyError, and route-admission failures (transport
    // identity drift, egress/verbatimCapable violations) raise their own
    // named-code Error subclasses -- both keep their specific code so an
    // operator sees e.g. CCC_PRD_ROUTE_NOT_VERBATIM_CAPABLE, not an opaque
    // wrapper. Anything else falls back to a generic failure code with the
    // original message preserved, mirroring authorCccPrdPacket's catch-all
    // (authoring.ts:1056-1063).
    //
    // Both refusals carry the quote review observed before the throw. Which
    // error killed the run says nothing about whether earlier chunks guessed,
    // so the flags ride out either way.
    if (hasStringCode(error)) {
      return refusal([{ code: error.code, message: error.message }], observedQuoteReview);
    }
    return refusal(
      [{
        code: "CCC_PRD_CHUNKED_UNDERSTANDING_FAILED",
        message: error instanceof Error ? error.message : "chunked understanding failed",
      }],
      observedQuoteReview,
    );
  }

  const { assembled } = chunkResult;
  // Past the throw, the pipeline's own rollup is authoritative and complete;
  // the progress snapshot was only ever a stand-in for a value that never
  // arrived. Every refusal below is still a failed document, so each one
  // reports the guesses the run made on its way here.
  const quoteReview = chunkResult.quoteReview;
  if (assembled.requirements.length === 0) {
    return refusal(
      [{
        code: "CCC_PRD_UNDERSTANDING_ZERO_REQUIREMENTS",
        message: "understanding extracted zero requirements from the frozen PRD packet",
      }],
      quoteReview,
    );
  }
  const reviewCount = assembled.ambiguities.length
    + assembled.unresolvedDecisions.length
    + assembled.exceptions.length
    + assembled.protectedActions.length;
  if (reviewCount > input.maxReviewItems) {
    return refusal(
      [{
        code: "CCC_PRD_AUTHORING_REVIEW_UNBOUNDED",
        message: `understanding review count ${reviewCount} exceeds admitted maximum ${input.maxReviewItems}`,
      }],
      quoteReview,
    );
  }

  const custody = readCccPrdPacketCustody(input);
  // assembleCccPrdChunkedUnderstanding already refuses internally on any
  // non-empty missing/conflicts (CCC_PRD_UNDERSTANDING_COVERAGE_INCOMPLETE /
  // _CONFLICTED), so by construction every material item is dispositioned
  // and neither conflicted here -- inventory === coverage numerically, and
  // this check can never trip in normal operation. It still runs, as a
  // tripwire: "if it ever fires there, that is the alarm that planner and
  // scorer diverged" (design §4 "Interaction with IMPLAUSIBLY_SHALLOW").
  const requirementDispositionsForShallowCheck = assembled.materialCoverage.filter(
    ({ materialKind }) => materialKind === "requirement",
  ).length;
  const chunkedShallowRefusal = describeCccPrdShallowExtractionRefusal({
    inventory: assembled.materialCoverage,
    coverage: assembled.materialCoverage,
    requirementInventoryCount: requirementDispositionsForShallowCheck,
    requirementDispositionCount: requirementDispositionsForShallowCheck,
  });
  if (chunkedShallowRefusal) {
    return refusal([chunkedShallowRefusal], quoteReview);
  }

  /*
   * This hash used to be computed inline in the returned provenance block --
   * after the catch above, so outside every guard in this function, and
   * understandCccPrdPacket has no try/catch of its own either. The fragment
   * shape gate validates each row's id and sourceRefs but never enumerates or
   * strips unknown fields, and withoutSourceRefsUsingResolver spreads
   * `...value`, so every field the model invented survives into `assembled`.
   * `JSON.parse("1e999")` is Infinity, and canonicalCccPrdJson rejects any
   * non-finite number, cycle, or non-plain object with a bare Error. One
   * oversized numeric literal therefore killed the entire run and left no
   * refusal bundle and no diagnostic code at all -- strictly worse than a
   * fatal-with-a-code. Guarded, with a code, and the underlying message names
   * the offending path and value.
   */
  let proposalHash: string;
  try {
    proposalHash = sha256(canonicalCccPrdJson(assembled));
  } catch (error) {
    return refusal(
      [{
        code: "CCC_PRD_UNDERSTANDING_NOT_CANONICALIZABLE",
        message: "assembled understanding cannot be canonicalized for hashing: "
          + (error instanceof Error ? error.message : String(error)),
      }],
      quoteReview,
    );
  }

  return {
    lane: "chunked",
    // Carried out of the pipeline unchanged. This is the only place a reader
    // learns that N quotes were anchored by guessing and what the source
    // actually said at each one; the spans themselves record coordinates only.
    quoteReview,
    schema: CCC_PRD_UNDERSTANDING_REVIEW_SCHEMA_VERSION,
    kind: "understanding-review",
    executable: false,
    sourceVersion: custody.sourceVersion,
    orderedSources: custody.sources,
    provenance: {
      authoringAdapterId: "fusion-native-chunked-understanding-v1",
      authoringModel: `${input.provider}/${input.model}`,
      proposalHash,
      packetHash: custody.packetHash,
    },
    authorityRoles: assembled.authorityRoles,
    requirements: assembled.requirements,
    proofs: assembled.proofs,
    tasks: assembled.tasks,
    edges: assembled.edges,
    workflows: assembled.workflows,
    documents: assembled.documents,
    artifacts: assembled.artifacts,
    proposedImportIntents: assembled.importIntents,
    protectedActions: assembled.protectedActions,
    nonGoals: assembled.nonGoals,
    assumptions: [],
    ambiguities: assembled.ambiguities,
    exceptions: assembled.exceptions,
    unresolvedDecisions: assembled.unresolvedDecisions,
    confidence: assembled.confidence,
    implementationContext: implementationContext(assembled),
    coverage: {
      inventoryCount: assembled.materialCoverage.length,
      dispositionCount: assembled.materialCoverage.length,
      dispositions: assembled.materialCoverage,
      missing: [],
      conflicts: [],
    },
    review: {
      ambiguities: assembled.ambiguities,
      unresolvedDecisions: assembled.unresolvedDecisions,
      exceptions: assembled.exceptions,
      protectedActions: assembled.protectedActions,
    },
  };
}

export async function understandCccPrdPacket(
  input: UnderstandCccPrdInput,
): Promise<CccPrdUnderstandingResult> {
  if (!Number.isSafeInteger(input.maxReviewItems) || input.maxReviewItems < 0) {
    return {
      kind: "refusal",
      diagnostics: [{
        code: "CCC_PRD_UNDERSTANDING_REVIEW_BOUND_INVALID",
        message: "understanding review maximum must be a non-negative safe integer",
      }],
    };
  }

  const requestedLane = input.requestedLane ?? "single";
  if (requestedLane === "single") {
    return runSingleShotUnderstanding(input);
  }

  const custody = readCccPrdPacketCustody(input);
  const totals = custody.sources
    .filter((source) => source.authoritative)
    .reduce((accumulator, source) => {
      const bytes = custody.sourceBytes.get(source.path)!;
      const items = computeCccPrdMaterialInventory(source.path, bytes);
      return { items: accumulator.items + items.length, bytes: accumulator.bytes + bytes.byteLength };
    }, { items: 0, bytes: 0 });

  const classification = classifyCccPrdLane({
    totalInventoryItems: totals.items,
    totalAuthoritativeBytes: totals.bytes,
    estimatedPromptTokens: Math.ceil(totals.bytes / BYTES_PER_TOKEN_ESTIMATE),
    reservedOutputTokens: input.reservedOutputTokens ?? 0,
    contextWindow: input.contextWindow ?? Number.MAX_SAFE_INTEGER,
    requestedLane,
    policy: input.laneClassifierPolicy,
  });

  return classification.lane === "single"
    ? runSingleShotUnderstanding(input)
    : runChunkedUnderstanding(input);
}
