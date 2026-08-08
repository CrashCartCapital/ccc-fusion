import {
  type CccPrdSource,
  type CustomProvider,
} from "@fusion/core";
import {
  assertCccPrdQuoteMatchPolicy,
  CCC_PRD_RUN_QUOTE_MATCH_POLICY,
  type CccPrdAnchorLimits,
  type CccPrdAnchorReceipt,
  type CccPrdQuoteMatchPolicy,
} from "./anchor-resolver.js";
import {
  buildCccPrdChunkEnvelope,
  buildCccPrdChunkPrompt,
  createCccPrdChunkTransportCaller,
} from "./chunk-authoring-adapter.js";
import { assembleCccPrdChunkedUnderstanding, type CccPrdAssembledUnderstanding } from "./chunk-assembly.js";
import { readCccPrdPacketCustody } from "./custody.js";
import { planCccPrdChunks, type CccPrdChunkPolicy } from "./chunk-planner.js";
import {
  checkCccPrdChunkReviewBudget,
  runCccPrdChunkAttempt,
  type CccPrdFuzzyQuoteReviewNotice,
  type CccPrdResolvedChunkFragment,
} from "./chunk-verification.js";
import { computeCccPrdMaterialInventory } from "./material-coverage.js";
import type { CccPrdNativeAuthoringMode, CccPrdNativeAuthoringTransport } from "./native-authoring-adapter.js";

export type CccPrdChunkedUnderstandingOptions = {
  rootDir: string;
  manifestPath: string;
  mode: CccPrdNativeAuthoringMode;
  provider: string;
  model: string;
  maxDurationMs: number;
  maxPromptBytes: number;
  maxResponseBytes: number;
  maxReviewItems: number;
  maxChunkAttempts?: number;
  chunkPolicy?: Partial<CccPrdChunkPolicy>;
  anchorLimits?: CccPrdAnchorLimits;
  /**
   * How much quote drift the anchor resolver may forgive. Omitted means
   * `CCC_PRD_RUN_QUOTE_MATCH_POLICY`: fuzzy matching ON, and every fuzzy match
   * flagged for review. This is the flip point -- see
   * `runCccPrdChunkedUnderstanding` and the `CccPrdQuoteMatchPolicy` doc in
   * anchor-resolver.ts for what that trade buys and costs.
   */
  quoteMatchPolicy?: CccPrdQuoteMatchPolicy;
  /**
   * Receives the run's quote review after every chunk that completes, so the
   * flags reach the caller as they happen instead of only on the return value.
   *
   * This exists because the return value is not reachable on a failed
   * document. Every refusal in this pipeline is a throw -- chunk attempts
   * exhausted, review budget blown, assembly coverage incomplete -- and a throw
   * unwinds this function's frame, taking the receipt accumulator with it. A
   * document that guessed at three quotes in chunks 1-5 and then died at chunk
   * 6 reported nothing at all, which is exactly the condition fuzzy matching
   * was made conditional on never happening.
   *
   * The caller owns the variable this writes into, so it outlives the throw by
   * construction -- no module-level state to leak between concurrent runs, and
   * no receipts bolted onto an error object whose type we do not control (this
   * pipeline throws CccPrdCustodyError, route-admission Error subclasses, and
   * bare Errors alike).
   *
   * Each call carries the complete cumulative review, not a delta, so a caller
   * only ever has to keep the most recent one.
   */
  onQuoteReviewProgress?: (review: CccPrdQuoteReview) => void;
  /** Test-only seam; production omits it and uses the real fusion model runtime transport. */
  transport?: CccPrdNativeAuthoringTransport;
  customProviders?: CustomProvider[];
};

export type CccPrdChunkAnchorReceipts = {
  chunkId: string;
  receipts: CccPrdAnchorReceipt[];
  fuzzyReviewNotices: CccPrdFuzzyQuoteReviewNotice[];
};

/**
 * The run-level answer to "which of these quotes did the system GUESS at, and
 * what did my document actually say?"
 *
 * This is the artifact the fuzzy tier is only acceptable with. Nothing here is
 * persisted -- it rides the return value and the CLI's printed JSON wrapper,
 * the same way `lane` does (understanding.ts) -- so the on-disk understanding
 * schema is untouched.
 */
export type CccPrdQuoteReview = {
  /** The policy the run actually ran under, so a reader never has to assume it. */
  policy: { allowFuzzy: boolean; recordFuzzyForReview: boolean };
  /** Zero on a clean run. Any other number is a read-these-yourself signal. */
  fuzzyMatchCount: number;
  /** The model's wording beside the source's own, one entry per guessed quote. */
  fuzzyMatches: Array<CccPrdFuzzyQuoteReviewNotice & { chunkId: string }>;
};

export type CccPrdChunkedUnderstandingResult = {
  chunkCount: number;
  chunkPlanHash: string;
  assembled: CccPrdAssembledUnderstanding;
  /**
   * How every quote in the run was matched, per chunk. Purely diagnostic: no
   * persisted structure, provenance hash, or exact-key allowlist sees it. It
   * exists because the span format records coordinates only, so this is the
   * one place a reviewer can see that a quote was recovered rather than found
   * verbatim -- and, for fuzzy matches, what the model actually wrote.
   */
  anchorReceipts: CccPrdChunkAnchorReceipts[];
  /** The operator-facing rollup of {@link anchorReceipts}; see {@link CccPrdQuoteReview}. */
  quoteReview: CccPrdQuoteReview;
};

/**
 * What a lane with no fuzzy tier at all reports. The single-shot lane matches
 * byte-exactly (authoring.ts) and never reaches `resolveCccPrdAnchor`, so it
 * has nothing to review -- but it still has to SAY so, or a reader cannot tell
 * "no guesses" apart from "nobody looked".
 */
export const CCC_PRD_NO_FUZZY_QUOTE_REVIEW: CccPrdQuoteReview = {
  policy: { allowFuzzy: false, recordFuzzyForReview: false },
  fuzzyMatchCount: 0,
  fuzzyMatches: [],
};

/**
 * Rolls per-chunk receipts up into the operator-facing review.
 *
 * Deliberately the single producer of that shape: the successful return value
 * and the progress snapshot a failed run is reported from both come from here,
 * so a refusal and a success can never show a reader two different renderings
 * of the same fact.
 */
function summarizeCccPrdQuoteReview(
  policy: CccPrdQuoteMatchPolicy,
  chunks: readonly CccPrdChunkAnchorReceipts[],
): CccPrdQuoteReview {
  const fuzzyMatches = chunks.flatMap((chunk) => (
    chunk.fuzzyReviewNotices.map((notice) => ({ ...notice, chunkId: chunk.chunkId }))
  ));
  return {
    policy: {
      allowFuzzy: policy.allowFuzzy,
      recordFuzzyForReview: policy.recordFuzzyForReview,
    },
    fuzzyMatchCount: fuzzyMatches.length,
    fuzzyMatches,
  };
}

/**
 * Runs the full chunked-lane pipeline against real custody: plan -> per-chunk
 * attempt (prompt build, transport call, mechanical verification, retry) ->
 * running review-item budget -> order-independent assembly. Chunks execute
 * serially per design D-2; order-independent assembly is the prerequisite
 * for any future parallelism, not this implementation.
 */
export async function runCccPrdChunkedUnderstanding(
  options: CccPrdChunkedUnderstandingOptions,
): Promise<CccPrdChunkedUnderstandingResult> {
  // THE FLIP POINT. Real chunked runs match fuzzily and flag every guess;
  // omitting the option is what production does, so this default is what
  // production gets. Scoped here rather than at
  // DEFAULT_CCC_PRD_QUOTE_MATCH_POLICY on purpose: a bare `resolveCccPrdAnchor`
  // caller still gets deterministic-only matching and has to opt in
  // deliberately. An explicitly supplied policy is honoured, but never one
  // that separates guessing from flagging.
  const quoteMatchPolicy = assertCccPrdQuoteMatchPolicy(
    options.quoteMatchPolicy ?? CCC_PRD_RUN_QUOTE_MATCH_POLICY,
  );

  const custody = readCccPrdPacketCustody({ rootDir: options.rootDir, manifestPath: options.manifestPath });
  const authoritativeSources: CccPrdSource[] = custody.sources.filter((source) => source.authoritative);
  const sources = authoritativeSources.map((source) => ({
    path: source.path,
    bytes: custody.sourceBytes.get(source.path)!,
  }));

  const plan = planCccPrdChunks({
    packetHash: custody.packetHash,
    sources,
    policy: options.chunkPolicy,
  });

  const transportCaller = createCccPrdChunkTransportCaller({
    provider: options.provider,
    model: options.model,
    maxDurationMs: options.maxDurationMs,
    maxPromptBytes: options.maxPromptBytes,
    maxResponseBytes: options.maxResponseBytes,
    transport: options.transport,
    customProviders: options.customProviders,
  });

  const packetHeader = custody.sources.map((source) => ({
    path: source.path,
    role: source.role,
    sha256: source.sha256,
    byteLength: source.byteLength,
  }));

  const sourceBytesByPath = new Map(sources.map((source) => [source.path, source.bytes]));
  const inventoryByPath = new Map(
    sources.map((source) => [source.path, computeCccPrdMaterialInventory(source.path, source.bytes)]),
  );

  const fragments: Array<{ chunkOrdinal: number; resolved: CccPrdResolvedChunkFragment }> = [];
  const anchorReceipts: CccPrdChunkAnchorReceipts[] = [];
  let runningReviewItemCount = 0;

  for (const chunk of plan.chunks) {
    const fullSourceBytes = sourceBytesByPath.get(chunk.sourcePath)!;
    const inventory = inventoryByPath.get(chunk.sourcePath)!;
    const assignedIds = new Set(chunk.materialItemIds);
    const materialItems = inventory
      .filter((item) => assignedIds.has(item.id))
      .map((item) => ({
        id: item.id,
        headingPath: item.headingPath,
        title: item.title,
        byteStart: item.spans[0]!.byteStart,
        byteEnd: item.spans[0]!.byteEnd,
      }));

    const envelope = buildCccPrdChunkEnvelope({
      mode: options.mode,
      packetHash: custody.packetHash,
      sourceVersion: custody.sourceVersion,
      chunkPlanHash: plan.chunkPlanHash,
      chunkId: chunk.chunkId,
      chunkOrdinal: chunk.chunkOrdinal,
      chunkCount: plan.chunkCount,
      packetHeader,
      sourcePath: chunk.sourcePath,
      fullSourceBytes,
      sliceByteStart: chunk.sliceByteStart,
      sliceByteEnd: chunk.sliceByteEnd,
      materialItems,
    });

    const resolved = await runCccPrdChunkAttempt({
      chunkId: chunk.chunkId,
      sourcePath: chunk.sourcePath,
      fullSourceBytes,
      sliceBounds: { byteStart: chunk.sliceByteStart, byteEnd: chunk.sliceByteEnd },
      assignedMaterialItemIds: chunk.materialItemIds,
      expectedProvider: options.provider,
      expectedModel: options.model,
      transport: transportCaller,
      buildPrompt: (priorViolations) => buildCccPrdChunkPrompt(envelope, priorViolations),
      maxChunkAttempts: options.maxChunkAttempts,
      limits: options.anchorLimits,
      quoteMatchPolicy,
      // Reported to the caller the moment the chunk's receipts land, not at
      // the end of the loop: everything after this point in the iteration
      // (review budget) and every later chunk can throw, and a throw is
      // precisely the case this channel exists to survive.
      onAnchorReceipts: (receipts) => {
        anchorReceipts.push(receipts);
        options.onQuoteReviewProgress?.(summarizeCccPrdQuoteReview(quoteMatchPolicy, anchorReceipts));
      },
    });

    fragments.push({ chunkOrdinal: chunk.chunkOrdinal, resolved });

    runningReviewItemCount += resolved.ambiguities.length
      + resolved.unresolvedDecisions.length
      + resolved.exceptions.length
      + resolved.protectedActions.length;
    checkCccPrdChunkReviewBudget({
      chunkOrdinal: chunk.chunkOrdinal,
      runningReviewItemCount,
      maxReviewItems: options.maxReviewItems,
    });
  }

  const assembled = assembleCccPrdChunkedUnderstanding({
    packetSourceBytes: custody.sourceBytes,
    fragments,
  });

  return {
    chunkCount: plan.chunkCount,
    chunkPlanHash: plan.chunkPlanHash,
    assembled,
    anchorReceipts,
    quoteReview: summarizeCccPrdQuoteReview(quoteMatchPolicy, anchorReceipts),
  };
}
