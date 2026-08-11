import { createHash } from "node:crypto";
import { canonicalCccPrdJson } from "@fusion/core";
import { CccPrdCustodyError } from "./custody.js";
import {
  computeCccPrdMaterialInventory,
  computeCccPrdSourceHeadings,
  computeCccPrdSourceLines,
  type CccPrdSourceHeading,
  type CccPrdSourceLine,
} from "./material-coverage.js";

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

export type CccPrdChunkPolicy = {
  chunkPolicyVersion: string;
  sliceTargetBytes: number;
  maxSliceBytes: number;
  overlapBytes: number;
};

/**
 * Recommended constants from design §1: 24 KiB target leaves room for the
 * rules block plus a fragment on a 65,536-token window; 48 KiB is the hard
 * ceiling that triggers a deeper cut; 2 KiB overlap only applies to forced
 * mid-section (no-interior-heading) splits.
 */
export const DEFAULT_CCC_PRD_CHUNK_POLICY: CccPrdChunkPolicy = {
  chunkPolicyVersion: "ccc-prd.chunk-policy.v1",
  sliceTargetBytes: 24 * 1024,
  maxSliceBytes: 48 * 1024,
  overlapBytes: 2 * 1024,
};

export type CccPrdChunkSlice = {
  chunkId: string;
  chunkOrdinal: number;
  sourcePath: string;
  sliceByteStart: number;
  sliceByteEnd: number;
  /** True only for chunks produced by the no-interior-heading line-boundary
   * fallback (design §1 step 4); assembly expects duplicate rows from these. */
  partialSection: boolean;
  materialItemIds: string[];
};

export type CccPrdChunkPlan = {
  chunkPlanHash: string;
  chunkPolicyVersion: string;
  packetHash: string;
  chunkCount: number;
  chunks: CccPrdChunkSlice[];
};

type Piece = {
  /** Strict, non-overlapping partition bounds -- used for item assignment and the byte-partition invariant. */
  naturalByteStart: number;
  naturalByteEnd: number;
  /** Emitted bounds -- equal to natural bounds except for line-boundary fallback pieces, which may bleed forward into their neighbor by overlapBytes. */
  sliceByteStart: number;
  sliceByteEnd: number;
  partialSection: boolean;
};

function headingsWithin(
  headings: CccPrdSourceHeading[],
  rangeStart: number,
  rangeEnd: number,
): CccPrdSourceHeading[] {
  return headings.filter((heading) => heading.byteStart >= rangeStart && heading.byteStart < rangeEnd);
}

/**
 * A piece with no interior heading left: cut at line boundaries targeting
 * sliceTargetBytes per segment, never producing a segment whose NATURAL
 * bounds exceed maxSliceBytes. Non-final segments bleed forward into their
 * neighbor by overlapBytes so a quote straddling the natural cut is wholly
 * present in at least one emitted slice (design §1 step 4).
 */
function splitByLineBoundary(
  lines: CccPrdSourceLine[],
  pieceStart: number,
  pieceEnd: number,
  policy: CccPrdChunkPolicy,
  sourcePath: string,
): Piece[] {
  const pieceLines = lines.filter((line) => line.byteStart >= pieceStart && line.byteStart < pieceEnd);

  for (const line of pieceLines) {
    if (line.byteEnd - line.byteStart > policy.maxSliceBytes) {
      throw new CccPrdCustodyError(
        "CCC_PRD_CHUNK_PLAN_INVALID",
        `a single line in ${sourcePath} exceeds maxSliceBytes (${policy.maxSliceBytes}) and cannot be planned`,
      );
    }
  }

  const segments: Array<{ byteStart: number; byteEnd: number }> = [];
  let segmentStart = pieceStart;
  let segmentBytes = 0;
  for (const line of pieceLines) {
    const lineBytes = line.byteEnd - line.byteStart;
    if (segmentBytes > 0 && segmentBytes + lineBytes > policy.sliceTargetBytes) {
      segments.push({ byteStart: segmentStart, byteEnd: line.byteStart });
      segmentStart = line.byteStart;
      segmentBytes = 0;
    }
    segmentBytes += lineBytes;
  }
  segments.push({ byteStart: segmentStart, byteEnd: pieceEnd });

  if (segments.length === 1) {
    const only = segments[0]!;
    return [{
      naturalByteStart: only.byteStart,
      naturalByteEnd: only.byteEnd,
      sliceByteStart: only.byteStart,
      sliceByteEnd: only.byteEnd,
      partialSection: false,
    }];
  }

  return segments.map((segment, index) => {
    const isLast = index === segments.length - 1;
    const sliceByteEnd = isLast
      ? segment.byteEnd
      : Math.min(pieceEnd, segment.byteEnd + policy.overlapBytes);
    return {
      naturalByteStart: segment.byteStart,
      naturalByteEnd: segment.byteEnd,
      sliceByteStart: segment.byteStart,
      sliceByteEnd,
      partialSection: true,
    };
  });
}

/**
 * Cuts [rangeStart, rangeEnd) at the shallowest interior heading level
 * present, descending one level at a time only into pieces still over
 * budget (design §1 steps 2-3). A range with no interior heading left falls
 * back to the line-boundary splitter.
 */
function splitRange(
  lines: CccPrdSourceLine[],
  headings: CccPrdSourceHeading[],
  rangeStart: number,
  rangeEnd: number,
  policy: CccPrdChunkPolicy,
  sourcePath: string,
  // A recursive call always descends into a piece whose byteStart is either
  // an owning heading (already chosen as a cut point one level up) or an
  // inherited leading-preamble start with no heading at it either way -- in
  // both cases the heading AT rangeStart itself (if any) must not be
  // rediscovered as its own interior cut point, or recursion never
  // terminates. Only the very first, whole-file call may legitimately have
  // a heading sitting exactly at rangeStart (byte 0).
  excludeHeadingAtRangeStart = false,
): Piece[] {
  if (rangeEnd <= rangeStart) return [];

  const interior = headingsWithin(headings, rangeStart, rangeEnd)
    .filter((heading) => !excludeHeadingAtRangeStart || heading.byteStart > rangeStart);
  if (interior.length === 0) {
    if (rangeEnd - rangeStart <= policy.maxSliceBytes) {
      return [{
        naturalByteStart: rangeStart,
        naturalByteEnd: rangeEnd,
        sliceByteStart: rangeStart,
        sliceByteEnd: rangeEnd,
        partialSection: false,
      }];
    }
    return splitByLineBoundary(lines, rangeStart, rangeEnd, policy, sourcePath);
  }

  const shallowestLevel = Math.min(...interior.map((heading) => heading.level));
  const cutHeadings = interior.filter((heading) => heading.level === shallowestLevel);

  const immediatePieces: Array<{ byteStart: number; byteEnd: number }> = [];
  if (cutHeadings[0]!.byteStart > rangeStart) {
    immediatePieces.push({ byteStart: rangeStart, byteEnd: cutHeadings[0]!.byteStart });
  }
  for (const [index, heading] of cutHeadings.entries()) {
    const end = index + 1 < cutHeadings.length ? cutHeadings[index + 1]!.byteStart : rangeEnd;
    immediatePieces.push({ byteStart: heading.byteStart, byteEnd: end });
  }

  const pieces: Piece[] = [];
  for (const piece of immediatePieces) {
    if (piece.byteEnd - piece.byteStart <= policy.maxSliceBytes) {
      pieces.push({
        naturalByteStart: piece.byteStart,
        naturalByteEnd: piece.byteEnd,
        sliceByteStart: piece.byteStart,
        sliceByteEnd: piece.byteEnd,
        partialSection: false,
      });
    } else {
      pieces.push(...splitRange(lines, headings, piece.byteStart, piece.byteEnd, policy, sourcePath, true));
    }
  }
  return pieces;
}

function planFileChunks(
  sourcePath: string,
  bytes: Buffer,
  policy: CccPrdChunkPolicy,
): { pieces: Piece[]; inventoryCount: number; assignItems: (chunks: CccPrdChunkSlice[]) => void } {
  const lines = computeCccPrdSourceLines(bytes);
  const headings = computeCccPrdSourceHeadings(bytes, lines);
  const inventory = computeCccPrdMaterialInventory(sourcePath, bytes);
  const pieces = bytes.byteLength === 0 ? [] : splitRange(lines, headings, 0, bytes.byteLength, policy, sourcePath);

  const assignItems = (chunks: CccPrdChunkSlice[]): void => {
    for (const item of inventory) {
      const itemStart = item.spans[0]!.byteStart;
      const owner = chunks.find((chunk, index) => {
        const piece = pieces[index]!;
        return itemStart >= piece.naturalByteStart && itemStart < piece.naturalByteEnd;
      }) ?? chunks.at(-1);
      owner?.materialItemIds.push(item.id);
    }
  };

  return { pieces, inventoryCount: inventory.length, assignItems };
}

export function planCccPrdChunks(input: {
  packetHash: string;
  sources: Array<{ path: string; bytes: Buffer }>;
  policy?: Partial<CccPrdChunkPolicy>;
}): CccPrdChunkPlan {
  const policy: CccPrdChunkPolicy = { ...DEFAULT_CCC_PRD_CHUNK_POLICY, ...input.policy };

  let totalInventoryCount = 0;
  const chunks: CccPrdChunkSlice[] = [];
  let ordinal = 0;

  for (const source of input.sources) {
    const { pieces, inventoryCount, assignItems } = planFileChunks(source.path, source.bytes, policy);
    totalInventoryCount += inventoryCount;

    const fileChunks: CccPrdChunkSlice[] = pieces.map((piece, localIndex) => ({
      chunkId: `${source.path}#${localIndex}`,
      chunkOrdinal: ordinal++,
      sourcePath: source.path,
      sliceByteStart: piece.sliceByteStart,
      sliceByteEnd: piece.sliceByteEnd,
      partialSection: piece.partialSection,
      materialItemIds: [],
    }));
    assignItems(fileChunks);
    chunks.push(...fileChunks);
  }

  if (totalInventoryCount === 0) {
    throw new CccPrdCustodyError(
      "CCC_PRD_CHUNK_PLAN_NO_INVENTORY",
      "packet-wide material inventory is empty; refusing to plan a chunked run",
    );
  }

  const chunkPlanHash = sha256(canonicalCccPrdJson({
    packetHash: input.packetHash,
    chunkPolicyVersion: policy.chunkPolicyVersion,
    sliceTargetBytes: policy.sliceTargetBytes,
    maxSliceBytes: policy.maxSliceBytes,
    overlapBytes: policy.overlapBytes,
    chunks: chunks.map((chunk) => ({
      chunkId: chunk.chunkId,
      chunkOrdinal: chunk.chunkOrdinal,
      sourcePath: chunk.sourcePath,
      sliceByteStart: chunk.sliceByteStart,
      sliceByteEnd: chunk.sliceByteEnd,
      partialSection: chunk.partialSection,
      materialItemIds: chunk.materialItemIds,
    })),
  }));

  return {
    chunkPlanHash,
    chunkPolicyVersion: policy.chunkPolicyVersion,
    packetHash: input.packetHash,
    chunkCount: chunks.length,
    chunks,
  };
}
