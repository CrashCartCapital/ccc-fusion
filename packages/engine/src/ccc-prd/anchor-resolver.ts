import { createHash } from "node:crypto";
import { createCccPrdSpanFromBytes, type CccPrdSourceSpan } from "@fusion/core";
import { CccPrdCustodyError } from "./custody.js";

const NEWLINE = 0x0a;

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

/**
 * Understanding-lane anchoring is selection-only (design §5): extension picks
 * which file-wide occurrence a quote means, it never widens what gets
 * emitted. The execution lane keeps the strict, pre-existing refusal on any
 * second file-wide hit (authoring.ts:755-760) via policy "strict".
 */
export type CccPrdAnchorPolicy = "strict" | "select";

export type CccPrdAnchorSliceBounds = {
  byteStart: number;
  byteEnd: number;
};

export type CccPrdAnchorLimits = {
  maxAnchorExtensionLines: number;
  maxAnchorExtensionBytes: number;
};

export const DEFAULT_CCC_PRD_ANCHOR_LIMITS: CccPrdAnchorLimits = {
  maxAnchorExtensionLines: 40,
  maxAnchorExtensionBytes: 8192,
};

export type CccPrdAnchorReceipt = {
  fileWideOccurrenceCount: number;
  inSliceCandidateCount: number;
  extensionAttempted: boolean;
  extensionStepsUsed: number;
  survivingCandidateByteStarts: number[];
};

export type CccPrdAnchorResolution = {
  span: CccPrdSourceSpan;
  receipt: CccPrdAnchorReceipt;
};

export type ResolveCccPrdAnchorInput = {
  sourcePath: string;
  source: Buffer;
  quote: string;
  entityId: string;
  policy: CccPrdAnchorPolicy;
  /** Required for policy "select"; ignored for "strict". */
  sliceBounds?: CccPrdAnchorSliceBounds;
  limits?: CccPrdAnchorLimits;
};

function findAllOccurrences(source: Buffer, needle: Buffer): number[] {
  const offsets: number[] = [];
  let from = 0;
  for (;;) {
    const index = source.indexOf(needle, from);
    if (index < 0) break;
    offsets.push(index);
    from = index + 1;
  }
  return offsets;
}

function occursExactlyOnce(source: Buffer, window: Buffer): boolean {
  const first = source.indexOf(window);
  if (first < 0) return false;
  return source.indexOf(window, first + 1) < 0;
}

function lineNumberAt(source: Buffer, byteOffset: number): number {
  return source.subarray(0, byteOffset).toString("utf8").split("\n").length;
}

type ExtensionOutcome = {
  resolved: boolean;
  stepsUsed: number;
};

/**
 * Extends a candidate window outward (fixed schedule: right, left, right,
 * left, ...) until it is file-wide unique or a limit is hit. Each step moves
 * the edge to the next line boundary in that direction (newline-inclusive) --
 * this single mechanical move serves both "snap to the boundary of a
 * mid-line edge" and "pull in one more whole line" from an edge already at a
 * boundary, per design §5. The candidate's ORIGINAL offset is what a caller
 * emits on success; the extended window here is selection evidence only.
 */
function extendCandidateUntilUnique(
  source: Buffer,
  candidateStart: number,
  quoteLength: number,
  limits: CccPrdAnchorLimits,
): ExtensionOutcome {
  let windowStart = candidateStart;
  let windowEnd = candidateStart + quoteLength;

  let rightExhausted = windowEnd >= source.byteLength;
  let leftExhausted = windowStart <= 0;
  let steps = 0;
  let turn: "right" | "left" = "right";

  while (!(rightExhausted && leftExhausted)) {
    if (steps >= limits.maxAnchorExtensionLines) break;

    if (turn === "right" && !rightExhausted) {
      const nextNewline = source.indexOf(NEWLINE, windowEnd);
      const newEnd = nextNewline < 0 ? source.byteLength : nextNewline + 1;
      if (newEnd === windowEnd) {
        rightExhausted = true;
      } else {
        windowEnd = newEnd;
        steps += 1;
        if (windowEnd >= source.byteLength) rightExhausted = true;
        const bytesUsed = windowEnd - windowStart - quoteLength;
        if (bytesUsed > limits.maxAnchorExtensionBytes) break;
        if (occursExactlyOnce(source, source.subarray(windowStart, windowEnd))) {
          return { resolved: true, stepsUsed: steps };
        }
      }
    } else if (turn === "left" && !leftExhausted) {
      // If windowStart already sits at a line boundary (the byte just before
      // it is a newline), searching from windowStart - 1 would trivially
      // rediscover that same newline and report zero progress. Search one
      // byte further back so an edge already at a boundary pulls in one
      // more whole line, per design §5 step (b).
      const atBoundary = windowStart > 0 && source[windowStart - 1] === NEWLINE;
      const searchFrom = atBoundary ? windowStart - 2 : windowStart - 1;
      const previousNewline = searchFrom >= 0 ? source.lastIndexOf(NEWLINE, searchFrom) : -1;
      const newStart = previousNewline < 0 ? 0 : previousNewline + 1;
      if (newStart === windowStart) {
        leftExhausted = true;
      } else {
        windowStart = newStart;
        steps += 1;
        if (windowStart <= 0) leftExhausted = true;
        const bytesUsed = windowEnd - windowStart - quoteLength;
        if (bytesUsed > limits.maxAnchorExtensionBytes) break;
        if (occursExactlyOnce(source, source.subarray(windowStart, windowEnd))) {
          return { resolved: true, stepsUsed: steps };
        }
      }
    }

    turn = turn === "right" ? "left" : "right";
  }

  return { resolved: false, stepsUsed: steps };
}

function buildSpan(
  sourcePath: string,
  source: Buffer,
  byteStart: number,
  quoteBytes: Buffer,
): CccPrdSourceSpan {
  return {
    ...createCccPrdSpanFromBytes(sourcePath, source, byteStart, byteStart + quoteBytes.byteLength),
    excerptSha256: sha256(quoteBytes),
  };
}

/**
 * Pure, deterministic anchor resolution (design §5). No model involvement,
 * no invented bytes: the emitted span is always exactly the caller's quote
 * bytes. Extension is used only to decide WHICH file-wide occurrence a
 * non-unique quote refers to when policy is "select" -- it never widens the
 * emitted span.
 */
export function resolveCccPrdAnchor(input: ResolveCccPrdAnchorInput): CccPrdAnchorResolution {
  const quoteBytes = Buffer.from(input.quote, "utf8");
  if (quoteBytes.byteLength === 0) {
    throw new CccPrdCustodyError(
      "CCC_PRD_SOURCE_SPAN_INVALID",
      `anchor quote must not be empty for ${input.entityId} in ${input.sourcePath}`,
    );
  }

  const occurrences = findAllOccurrences(input.source, quoteBytes);
  if (occurrences.length === 0) {
    throw new CccPrdCustodyError(
      "CCC_PRD_SOURCE_QUOTE_MISSING",
      `anchor quote is absent for ${input.entityId} in ${input.sourcePath}`,
    );
  }

  if (occurrences.length === 1) {
    return {
      span: buildSpan(input.sourcePath, input.source, occurrences[0]!, quoteBytes),
      receipt: {
        fileWideOccurrenceCount: 1,
        inSliceCandidateCount: 1,
        extensionAttempted: false,
        extensionStepsUsed: 0,
        survivingCandidateByteStarts: [occurrences[0]!],
      },
    };
  }

  if (input.policy === "strict") {
    throw new CccPrdCustodyError(
      "CCC_PRD_SOURCE_QUOTE_AMBIGUOUS",
      `anchor quote is not unique for ${input.entityId} in ${input.sourcePath}`,
    );
  }

  const bounds = input.sliceBounds ?? { byteStart: 0, byteEnd: input.source.byteLength };
  const inSlice = occurrences.filter((offset) => offset >= bounds.byteStart && offset < bounds.byteEnd);

  if (inSlice.length === 0) {
    throw new CccPrdCustodyError(
      "CCC_PRD_CHUNK_QUOTE_OUTSIDE_SLICE",
      `anchor quote resolves in ${input.sourcePath} but not inside the given slice for ${input.entityId}`,
    );
  }

  if (inSlice.length === 1) {
    return {
      span: buildSpan(input.sourcePath, input.source, inSlice[0]!, quoteBytes),
      receipt: {
        fileWideOccurrenceCount: occurrences.length,
        inSliceCandidateCount: 1,
        extensionAttempted: false,
        extensionStepsUsed: 0,
        survivingCandidateByteStarts: [inSlice[0]!],
      },
    };
  }

  const limits = input.limits ?? DEFAULT_CCC_PRD_ANCHOR_LIMITS;
  const outcomes = inSlice.map((candidateStart) => ({
    candidateStart,
    ...extendCandidateUntilUnique(input.source, candidateStart, quoteBytes.byteLength, limits),
  }));
  const survivors = outcomes.filter((outcome) => outcome.resolved);

  if (survivors.length === 0) {
    throw new CccPrdCustodyError(
      "CCC_PRD_ANCHOR_UNRESOLVABLE",
      `anchor quote for ${input.entityId} in ${input.sourcePath} could not reach a unique location within `
        + `${limits.maxAnchorExtensionLines} extension lines / ${limits.maxAnchorExtensionBytes} extension bytes`,
    );
  }

  if (survivors.length > 1) {
    const lines = inSlice.map((offset) => lineNumberAt(input.source, offset));
    throw new CccPrdCustodyError(
      "CCC_PRD_ANCHOR_AMBIGUOUS_INTENT",
      `anchor quote for ${input.entityId} in ${input.sourcePath} does not identify a single location; `
        + `${survivors.length} candidates independently resolved to lines ${lines.join(", ")}`,
    );
  }

  const winner = survivors[0]!;
  return {
    span: buildSpan(input.sourcePath, input.source, winner.candidateStart, quoteBytes),
    receipt: {
      fileWideOccurrenceCount: occurrences.length,
      inSliceCandidateCount: inSlice.length,
      extensionAttempted: true,
      extensionStepsUsed: winner.stepsUsed,
      survivingCandidateByteStarts: [winner.candidateStart],
    },
  };
}
