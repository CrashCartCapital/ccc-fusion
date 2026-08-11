import { createHash } from "node:crypto";
import { createCccPrdSpanFromBytes, type CccPrdSourceSpan } from "@fusion/core";
import { CccPrdCustodyError } from "./custody.js";
import {
  locateCccPrdQuote,
  type CccPrdQuoteCandidate,
  type CccPrdQuoteNormalization,
  type LocateCccPrdQuoteOptions,
} from "./quote-locator.js";

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

/** Threshold overrides, valid in either switch state. */
type CccPrdQuoteMatchTuning = {
  /** Overrides the locator's measured default (0.85). Ignored when fuzzy is off. */
  fuzzyThreshold?: number;
  /** Overrides the locator's measured default (0.05). */
  ambiguityEpsilon?: number;
};

/**
 * How much drift the quote->span locate is allowed to forgive.
 *
 * Tiers 0 and 1 of `quote-locator.ts` (exact bytes, then a normalized
 * projection covering case, whitespace, markdown emphasis, and table pipes)
 * are always on: every real drift they recover scored an exact 1.0000 in
 * normalized space, so admitting them costs no discrimination at all.
 *
 * Tier 2 (fuzzy) is a guess, and the measurement says so bluntly: a
 * meaning-INVERTING one-word edit ("redact every raw string value" -> "redact
 * no raw string value") scores 0.9747, HIGHER than the innocent
 * word-substitution drift the tier must accept at 0.9449. Byte-wise, reversing
 * a requirement is a SMALLER edit than a harmless rewording, so no threshold
 * separates those populations. See `.smoke-scratch/wave6/locator-report.md`,
 * POPULATIONS_SEPARABLE=NO.
 *
 * The emitted span always holds TRUE source bytes either way, so a recovered
 * quote's citation stays correct. What a guess can get wrong is the CLAIM
 * built on it: a misread sentence would then carry a correct-looking citation
 * with nothing pointing at the misreading. The review flag is the only thing
 * that makes tier 2 acceptable, which is why this type has exactly TWO
 * inhabitants and "fuzzy on, review off" is not one of them:
 *
 *   { allowFuzzy: false, recordFuzzyForReview: false }  deterministic tiers only
 *   { allowFuzzy: true,  recordFuzzyForReview: true }   fuzzy on, EVERY match flagged
 *
 * `allowFuzzy: true` with `recordFuzzyForReview: false` is a compile error by
 * construction, and {@link assertCccPrdQuoteMatchPolicy} rejects it at runtime
 * for callers that reach this type through JSON, `as`, or plain JavaScript.
 * Do not widen this union back into two independent booleans.
 */
export type CccPrdQuoteMatchPolicy =
  | (CccPrdQuoteMatchTuning & { allowFuzzy: false; recordFuzzyForReview: false })
  | (CccPrdQuoteMatchTuning & { allowFuzzy: true; recordFuzzyForReview: true });

/**
 * What {@link resolveCccPrdAnchor} falls back to when a caller supplies NO
 * policy at all: deterministic tiers only.
 *
 * This is a library-level fallback, deliberately NOT the value real runs use.
 * Real chunked CCC-PRD runs get {@link CCC_PRD_RUN_QUOTE_MATCH_POLICY}, which
 * `chunk-orchestrator.ts` applies at the pipeline entry point. Keeping the
 * bare-resolver fallback strict means a future caller wired straight into this
 * module -- the single-shot lane, a new tool, a script -- has to ask for
 * guessing on purpose instead of inheriting it.
 */
export const DEFAULT_CCC_PRD_QUOTE_MATCH_POLICY: CccPrdQuoteMatchPolicy = {
  allowFuzzy: false,
  recordFuzzyForReview: false,
};

/**
 * What real chunked CCC-PRD runs use, per operator decision: fuzzy matching
 * ON, and every fuzzy match flagged for review.
 *
 * Applied at `runCccPrdChunkedUnderstanding` (chunk-orchestrator.ts), the
 * entry point of the chunked pipeline, so it covers every production run
 * without touching what a direct `resolveCccPrdAnchor` caller gets.
 *
 * The two fields are not independently choosable -- see
 * {@link CccPrdQuoteMatchPolicy}. Turning fuzzy on without review recording is
 * the one configuration that would let the pipeline guess in silence.
 */
export const CCC_PRD_RUN_QUOTE_MATCH_POLICY: CccPrdQuoteMatchPolicy = {
  allowFuzzy: true,
  recordFuzzyForReview: true,
};

/**
 * Refuses "fuzzy on, review off" at runtime.
 *
 * The union type above already makes that state uncompilable, but a policy can
 * still arrive from JSON config, a plain-JavaScript caller, or a `as
 * CccPrdQuoteMatchPolicy` cast in a future refactor. Every path that turns a
 * policy into locator options goes through
 * {@link cccPrdLocatorOptionsFor}, which calls this, so guessing cannot be
 * switched on anywhere without the flag that makes it reviewable.
 */
export function assertCccPrdQuoteMatchPolicy(policy: CccPrdQuoteMatchPolicy): CccPrdQuoteMatchPolicy {
  if (policy.allowFuzzy === true && (policy as { recordFuzzyForReview: unknown }).recordFuzzyForReview !== true) {
    throw new CccPrdCustodyError(
      "CCC_PRD_QUOTE_MATCH_POLICY_INSEPARABLE",
      "quote match policy enabled fuzzy matching without recordFuzzyForReview; fuzzy matching may not be "
        + "switched on unless every fuzzy match is flagged for review, because a meaning-inverting edit scores "
        + "higher (0.9747) than the innocent drift the tier exists to accept (0.9449) and no threshold separates them",
    );
  }
  return policy;
}

/** Which locator tier produced the emitted span. */
export type CccPrdAnchorMatchStrategy = "exact" | "normalized" | "fuzzy";

/**
 * Recorded for every tier-2 match. `quoteAsModelWrote` and `matchedSourceText`
 * sit side by side deliberately: the span carries only coordinates, so this
 * receipt is the ONLY place the drift between what the model claimed and what
 * the source actually says stays measurable.
 */
export type CccPrdAnchorFuzzyDrift = {
  quoteAsModelWrote: string;
  matchedSourceText: string;
  score: number;
  requiresReview: boolean;
};

export type CccPrdAnchorReceipt = {
  entityId: string;
  sourcePath: string;
  matchStrategy: CccPrdAnchorMatchStrategy;
  /** Normalizations whose removal would have broken the match. Empty for "exact". */
  appliedNormalizations: CccPrdQuoteNormalization[];
  /** Byte-EXACT occurrences of the model's quote. Zero whenever a looser tier won. */
  fileWideOccurrenceCount: number;
  inSliceCandidateCount: number;
  extensionAttempted: boolean;
  extensionStepsUsed: number;
  survivingCandidateByteStarts: number[];
  fuzzyDrift?: CccPrdAnchorFuzzyDrift;
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
  /** Defaults to `DEFAULT_CCC_PRD_QUOTE_MATCH_POLICY` (deterministic tiers only). */
  quoteMatchPolicy?: CccPrdQuoteMatchPolicy;
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

/**
 * The substitution point. `byteEnd` is the end of the MATCHED SOURCE REGION,
 * never `byteStart + modelQuote.byteLength`, and `excerptSha256` hashes the
 * bytes actually sitting between those bounds rather than the model's bytes.
 *
 * For a byte-exact match the two are identical, so this is a no-op there. For
 * a looser match it is the whole repair: `compiler.ts:409` recomputes
 * `sha256(source.subarray(span.byteStart, span.byteEnd))` and rejects any
 * disagreement as CCC_PRD_SOURCE_SPAN_STALE, so hashing the model's drifted
 * bytes here would make every recovered quote fail at compile time. Loosening
 * the match and substituting true source bytes are one change, not two.
 */
function buildSpan(
  sourcePath: string,
  source: Buffer,
  byteStart: number,
  byteEnd: number,
): CccPrdSourceSpan {
  return {
    ...createCccPrdSpanFromBytes(sourcePath, source, byteStart, byteEnd),
    excerptSha256: sha256(source.subarray(byteStart, byteEnd)),
  };
}

/**
 * The single choke point between a policy and the matcher. Every caller that
 * needs locator options -- this module's loose-match path and
 * `chunk-verification.ts`'s containment gate -- goes through here, so the
 * inseparability check cannot be routed around by building the options object
 * by hand.
 */
export function cccPrdLocatorOptionsFor(policy: CccPrdQuoteMatchPolicy): LocateCccPrdQuoteOptions {
  assertCccPrdQuoteMatchPolicy(policy);
  const options: LocateCccPrdQuoteOptions = { disableFuzzy: !policy.allowFuzzy };
  if (policy.fuzzyThreshold !== undefined) options.fuzzyThreshold = policy.fuzzyThreshold;
  if (policy.ambiguityEpsilon !== undefined) options.ambiguityEpsilon = policy.ambiguityEpsilon;
  return options;
}

function describeCandidate(source: Buffer, candidate: CccPrdQuoteCandidate): string {
  return `line ${lineNumberAt(source, candidate.byteStart)} `
    + `(bytes ${candidate.byteStart}-${candidate.byteEnd}, similarity ${candidate.score.toFixed(4)}): `
    + candidate.preview;
}

/**
 * Runs when the model's bytes occur NOWHERE in the source verbatim -- the case
 * that used to be a flat CCC_PRD_SOURCE_QUOTE_MISSING. Two full corpus runs
 * showed this is almost never a fabricated quote; it is a real sentence the
 * model retyped with small drift. The locator finds where that sentence really
 * lives and `buildSpan` emits the source's own bytes from there.
 *
 * Slice scoping mirrors the byte-exact path above rather than pre-empting it:
 * a single file-wide hit is accepted wherever it lands, and the slice is only
 * brought in to break a tie the whole file could not.
 */
function resolveByLooseMatch(input: ResolveCccPrdAnchorInput): CccPrdAnchorResolution {
  const matchPolicy = input.quoteMatchPolicy ?? DEFAULT_CCC_PRD_QUOTE_MATCH_POLICY;
  const options = cccPrdLocatorOptionsFor(matchPolicy);

  let located = locateCccPrdQuote(input.source, input.quote, options);
  if (located.kind === "ambiguous" && input.policy === "select" && input.sliceBounds !== undefined) {
    const scoped = locateCccPrdQuote(input.source, input.quote, {
      ...options,
      searchBounds: input.sliceBounds,
    });
    if (scoped.kind !== "notFound") located = scoped;
  }

  if (located.kind === "notFound") {
    throw new CccPrdCustodyError(
      "CCC_PRD_SOURCE_QUOTE_MISSING",
      `anchor quote is absent for ${input.entityId} in ${input.sourcePath}`,
    );
  }

  if (located.kind === "ambiguous") {
    // Naming both is the point. Picking one would fabricate the model's intent,
    // which is precisely the failure loose matching must not introduce, and the
    // previews are what let the next authoring attempt disambiguate.
    const named = located.candidates
      .map((candidate, index) => `candidate ${index + 1} at ${describeCandidate(input.source, candidate)}`)
      .join("; ");
    throw new CccPrdCustodyError(
      "CCC_PRD_ANCHOR_QUOTE_AMBIGUOUS_MATCH",
      `anchor quote for ${input.entityId} in ${input.sourcePath} matches `
        + `${located.candidates.length} indistinguishable source regions; `
        + `quote it verbatim including whatever distinguishes them -- ${named}`,
    );
  }

  const receipt: CccPrdAnchorReceipt = {
    entityId: input.entityId,
    sourcePath: input.sourcePath,
    matchStrategy: located.kind,
    appliedNormalizations: located.kind === "normalized" ? located.appliedStrategies : [],
    fileWideOccurrenceCount: 0,
    inSliceCandidateCount: 1,
    extensionAttempted: false,
    extensionStepsUsed: 0,
    survivingCandidateByteStarts: [located.byteStart],
  };
  if (located.kind === "fuzzy") {
    receipt.fuzzyDrift = {
      quoteAsModelWrote: input.quote,
      matchedSourceText: input.source.subarray(located.byteStart, located.byteEnd).toString("utf8"),
      score: located.score,
      requiresReview: matchPolicy.recordFuzzyForReview,
    };
  }

  return {
    span: buildSpan(input.sourcePath, input.source, located.byteStart, located.byteEnd),
    receipt,
  };
}

/**
 * Pure, deterministic anchor resolution (design §5). No model involvement and
 * no invented bytes: the emitted span always delimits REAL SOURCE BYTES, and
 * `source.subarray(span.byteStart, span.byteEnd)` is what the quote resolves
 * to for every downstream consumer.
 *
 * The byte-exact path is unchanged and still runs first, so a quote the model
 * copied faithfully resolves exactly as it always did -- including extension,
 * which decides WHICH file-wide occurrence a non-unique quote means when
 * policy is "select" and never widens the emitted span.
 *
 * Only when the model's bytes occur nowhere at all does the looser locate run
 * (see `resolveByLooseMatch`). There the emitted span is the source's own text
 * at the matched position, which will differ from the caller's quote -- that
 * substitution is the point, not a side effect.
 */
export function resolveCccPrdAnchor(input: ResolveCccPrdAnchorInput): CccPrdAnchorResolution {
  // Validated up front rather than inside the loose-match path, so a
  // separated policy is refused even on a run where every quote happens to
  // match byte-exactly and tier 2 is never reached. A misconfiguration that
  // only surfaces on the first drifted quote is a misconfiguration that ships.
  if (input.quoteMatchPolicy !== undefined) {
    assertCccPrdQuoteMatchPolicy(input.quoteMatchPolicy);
  }

  const quoteBytes = Buffer.from(input.quote, "utf8");
  if (quoteBytes.byteLength === 0) {
    throw new CccPrdCustodyError(
      "CCC_PRD_SOURCE_SPAN_INVALID",
      `anchor quote must not be empty for ${input.entityId} in ${input.sourcePath}`,
    );
  }

  const occurrences = findAllOccurrences(input.source, quoteBytes);
  if (occurrences.length === 0) {
    return resolveByLooseMatch(input);
  }

  if (occurrences.length === 1) {
    return {
      span: buildSpan(
        input.sourcePath,
        input.source,
        occurrences[0]!,
        occurrences[0]! + quoteBytes.byteLength,
      ),
      receipt: {
        entityId: input.entityId,
        sourcePath: input.sourcePath,
        matchStrategy: "exact",
        appliedNormalizations: [],
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
      span: buildSpan(
        input.sourcePath,
        input.source,
        inSlice[0]!,
        inSlice[0]! + quoteBytes.byteLength,
      ),
      receipt: {
        entityId: input.entityId,
        sourcePath: input.sourcePath,
        matchStrategy: "exact",
        appliedNormalizations: [],
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
    span: buildSpan(
      input.sourcePath,
      input.source,
      winner.candidateStart,
      winner.candidateStart + quoteBytes.byteLength,
    ),
    receipt: {
      entityId: input.entityId,
      sourcePath: input.sourcePath,
      matchStrategy: "exact",
      appliedNormalizations: [],
      fileWideOccurrenceCount: occurrences.length,
      inSliceCandidateCount: inSlice.length,
      extensionAttempted: true,
      extensionStepsUsed: winner.stepsUsed,
      survivingCandidateByteStarts: [winner.candidateStart],
    },
  };
}
