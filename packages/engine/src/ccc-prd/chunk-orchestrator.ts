import {
  type CccPrdSource,
  type CustomProvider,
} from "@fusion/core";
import type {
  CccPrdAnchorLimits,
  CccPrdAnchorReceipt,
  CccPrdQuoteMatchPolicy,
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
   * `DEFAULT_CCC_PRD_QUOTE_MATCH_POLICY`: exact and normalized matching only,
   * fuzzy matching OFF. Turning fuzzy on is an operator decision -- see the
   * `CccPrdQuoteMatchPolicy` doc in anchor-resolver.ts.
   */
  quoteMatchPolicy?: CccPrdQuoteMatchPolicy;
  /** Test-only seam; production omits it and uses the real fusion model runtime transport. */
  transport?: CccPrdNativeAuthoringTransport;
  customProviders?: CustomProvider[];
};

export type CccPrdChunkAnchorReceipts = {
  chunkId: string;
  receipts: CccPrdAnchorReceipt[];
  fuzzyReviewNotices: string[];
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
};

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
      quoteMatchPolicy: options.quoteMatchPolicy,
      onAnchorReceipts: (receipts) => anchorReceipts.push(receipts),
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
  };
}
