/**
 * Standalone quote locator for CCC-PRD source anchoring.
 *
 * Two full corpus runs proved the authoring model never invents quotes: it
 * copies them out of the source with small drift (case folding, stripped
 * markdown emphasis, swallowed table pipes, a changed verb tense, an elided
 * middle). Byte-exact `Buffer.indexOf` refuses all of those, so the approved
 * repair is "match loosely, then substitute the TRUE source bytes at the
 * matched position".
 *
 * This module is the matcher half of that repair and nothing else. It is pure,
 * has no repo dependencies, and is deliberately wired into no call site --
 * `anchor-resolver.ts` (chunked lane) and `authoring.ts` (single-shot lane)
 * are integrated separately. See `.smoke-scratch/wave6/anchor-design.md` for
 * the surface map and `.smoke-scratch/wave6/locator-report.md` for the
 * measurements behind the default threshold and epsilon.
 *
 * CORRECTNESS INVARIANT, enforced by every tier:
 *   haystack.subarray(result.byteStart, result.byteEnd).toString("utf8")
 * is the true source text. Offsets always index the ORIGINAL haystack, never a
 * normalized projection, and never split a UTF-8 sequence.
 */

/** Normalizations tier 1 may apply, in the order they are described. */
export type CccPrdQuoteNormalization =
  | "lowercase"
  | "collapseWhitespace"
  | "stripEmphasis"
  | "stripTablePipes";

export const CCC_PRD_QUOTE_NORMALIZATIONS: readonly CccPrdQuoteNormalization[] = [
  "lowercase",
  "collapseWhitespace",
  "stripEmphasis",
  "stripTablePipes",
];

/**
 * Measured, not guessed. Full derivation in `.smoke-scratch/wave6/locator-report.md`;
 * every number below came from running the real corpus fixtures through this
 * module with scoring forced wide open.
 *
 *   MUST ACCEPT   tense drift            0.9900
 *                 word substitution      0.9449   <- lowest acceptable observed
 *   MUST REJECT   paraphrase             0.7196   <- highest safe-to-reject observed
 *                 cross-document quote   0.3774
 *                 invented quote         0.3366
 *
 * 0.85 sits inside the empty band (0.7216, 0.9449), biased toward the strict
 * end because a false refusal is the current safe behaviour while a false
 * accept fabricates a source span.
 *
 * Two populations do NOT separate and no threshold fixes them:
 *   - a ~135-character elision scores 0.7216, only 0.0020 above the paraphrase
 *     control, so it is refused rather than admitted alongside paraphrases;
 *   - meaning-inverting single-word edits score 0.9245 and 0.9747, i.e. ABOVE
 *     the innocent word-substitution drift this threshold must accept.
 * Both are stated plainly in the report's limitations section.
 */
export const DEFAULT_CCC_PRD_QUOTE_FUZZY_THRESHOLD = 0.85;

/**
 * Two disjoint candidates whose scores differ by no more than this are treated
 * as indistinguishable and reported as "ambiguous" rather than silently picked.
 *
 * The observed adjacent-table-row hazard produces two disjoint candidates that
 * tie exactly (delta 0.0000). The closest real single-winner case clears its
 * runner-up by 0.2920, so any epsilon in (0, 0.2920) separates them. 0.05 is
 * chosen inside that band: large enough to catch rivals that differ by a
 * handful of edits (one edit is worth ~0.009 on a 113-character quote), small
 * enough to leave a 0.24 margin before it would start refusing real winners.
 */
export const DEFAULT_CCC_PRD_QUOTE_AMBIGUITY_EPSILON = 0.05;

const DEFAULT_MAX_AMBIGUOUS_CANDIDATES = 4;
const PREVIEW_CHARS = 120;

const EMPHASIS_CHARS = new Set(["*", "_", "`"]);
const TABLE_PIPE = "|";

export type CccPrdQuoteSearchBounds = {
  byteStart: number;
  byteEnd: number;
};

export type CccPrdQuoteCandidate = {
  byteStart: number;
  byteEnd: number;
  score: number;
  preview: string;
};

export type CccPrdQuoteLocation =
  | { kind: "exact"; byteStart: number; byteEnd: number }
  | {
      kind: "normalized";
      byteStart: number;
      byteEnd: number;
      appliedStrategies: CccPrdQuoteNormalization[];
    }
  | { kind: "fuzzy"; byteStart: number; byteEnd: number; score: number }
  | { kind: "ambiguous"; candidates: CccPrdQuoteCandidate[] }
  | { kind: "notFound" };

export type LocateCccPrdQuoteOptions = {
  /** Minimum similarity a tier-2 candidate must reach. Default 0.8. */
  fuzzyThreshold?: number;
  /** Score gap below which two disjoint candidates are called ambiguous. Default 0.02. */
  ambiguityEpsilon?: number;
  /** Skip tier 2 entirely. Default false. */
  disableFuzzy?: boolean;
  /** Cap on candidates listed in an "ambiguous" result. Default 4, minimum 2. */
  maxAmbiguousCandidates?: number;
  /**
   * Restrict the search to a byte range of the haystack. Returned offsets stay
   * in whole-haystack coordinates. Mirrors the chunked lane's slice scoping.
   */
  searchBounds?: CccPrdQuoteSearchBounds;
};

type NormalizationToggles = Record<CccPrdQuoteNormalization, boolean>;

const ALL_NORMALIZATIONS_ON: NormalizationToggles = {
  lowercase: true,
  collapseWhitespace: true,
  stripEmphasis: true,
  stripTablePipes: true,
};

/**
 * A normalized view of some byte range, plus the inverse map back to it.
 *
 * `startBytes[i]` / `endBytes[i]` are the original byte bounds of the source
 * character that produced normalized UTF-16 code unit `i`. Because both arrays
 * only ever hold UTF-8 sequence boundaries discovered by walking lead bytes, a
 * span built from them can never bisect a multi-byte character.
 */
type NormalizedProjection = {
  text: string;
  startBytes: Int32Array;
  endBytes: Int32Array;
};

/**
 * Byte length of the UTF-8 sequence starting at `lead`. An invalid lead byte
 * (including a stray continuation byte) advances by one so the walk always
 * terminates and never re-enters the middle of a valid sequence.
 */
function utf8SequenceLength(lead: number): number {
  if (lead < 0x80) return 1;
  if ((lead & 0xe0) === 0xc0) return 2;
  if ((lead & 0xf0) === 0xe0) return 3;
  if ((lead & 0xf8) === 0xf0) return 4;
  return 1;
}

function isWhitespace(char: string): boolean {
  return /\s/u.test(char);
}

/**
 * Build the normalized projection of `bytes[from, to)` together with the map
 * back to original byte offsets. `baseOffset` is added to every recorded
 * offset so a slice-scoped search still reports whole-haystack coordinates.
 */
function projectNormalized(
  bytes: Buffer,
  toggles: NormalizationToggles,
  from = 0,
  to = bytes.byteLength,
  baseOffset = 0,
): NormalizedProjection {
  const units: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  let collapsedSpaceIndex = -1;

  for (let cursor = from; cursor < to; ) {
    const width = Math.min(utf8SequenceLength(bytes[cursor] ?? 0), to - cursor);
    const charStart = cursor;
    const charEnd = cursor + width;
    cursor = charEnd;

    const char = bytes.subarray(charStart, charEnd).toString("utf8");
    if (char.length === 0) continue;

    if (toggles.stripEmphasis && EMPHASIS_CHARS.has(char)) continue;
    if (toggles.stripTablePipes && char === TABLE_PIPE) continue;

    if (toggles.collapseWhitespace && isWhitespace(char)) {
      if (collapsedSpaceIndex >= 0 && collapsedSpaceIndex === units.length - 1) {
        // Extend the run that is already standing in for this whitespace.
        ends[collapsedSpaceIndex] = charEnd + baseOffset;
        continue;
      }
      units.push(" ");
      starts.push(charStart + baseOffset);
      ends.push(charEnd + baseOffset);
      collapsedSpaceIndex = units.length - 1;
      continue;
    }

    const emitted = toggles.lowercase ? char.toLowerCase() : char;
    // A single code point can lowercase to several UTF-16 units; every unit
    // maps back to the same original byte range so index alignment holds.
    for (let unit = 0; unit < emitted.length; unit += 1) {
      units.push(emitted[unit] as string);
      starts.push(charStart + baseOffset);
      ends.push(charEnd + baseOffset);
    }
    collapsedSpaceIndex = -1;
  }

  return {
    text: units.join(""),
    startBytes: Int32Array.from(starts),
    endBytes: Int32Array.from(ends),
  };
}

/** Normalized needle text, with collapsed leading/trailing space trimmed off. */
function normalizeNeedle(needle: string, toggles: NormalizationToggles): string {
  const projection = projectNormalized(Buffer.from(needle, "utf8"), toggles);
  return toggles.collapseWhitespace ? projection.text.trim() : projection.text;
}

function togglesWithout(disabled: CccPrdQuoteNormalization): NormalizationToggles {
  return { ...ALL_NORMALIZATIONS_ON, [disabled]: false };
}

/**
 * Report only the strategies whose removal would break the match. Comparing
 * "did this strategy change any bytes" would flag `lowercase` for every quote
 * that merely contains a capital letter; comparing "does the match survive
 * without it" reports what actually mattered.
 */
function strategiesThatMattered(
  haystack: Buffer,
  byteStart: number,
  byteEnd: number,
  needle: string,
): CccPrdQuoteNormalization[] {
  const matched = haystack.subarray(byteStart, byteEnd);
  const mattered: CccPrdQuoteNormalization[] = [];
  for (const strategy of CCC_PRD_QUOTE_NORMALIZATIONS) {
    const toggles = togglesWithout(strategy);
    const projectedMatch = projectNormalized(matched, toggles).text;
    const projectedNeedle = projectNormalized(Buffer.from(needle, "utf8"), toggles).text;
    const left = toggles.collapseWhitespace ? projectedMatch.trim() : projectedMatch;
    const right = toggles.collapseWhitespace ? projectedNeedle.trim() : projectedNeedle;
    if (left !== right) mattered.push(strategy);
  }
  return mattered;
}

function findAllIndexes(haystack: string, needle: string): number[] {
  const found: number[] = [];
  let from = 0;
  for (;;) {
    const index = haystack.indexOf(needle, from);
    if (index < 0) break;
    found.push(index);
    from = index + 1;
  }
  return found;
}

function previewOf(haystack: Buffer, byteStart: number, byteEnd: number): string {
  const text = haystack.subarray(byteStart, byteEnd).toString("utf8");
  return text.length <= PREVIEW_CHARS ? text : `${text.slice(0, PREVIEW_CHARS)}...`;
}

function toCandidate(
  haystack: Buffer,
  byteStart: number,
  byteEnd: number,
  score: number,
): CccPrdQuoteCandidate {
  return { byteStart, byteEnd, score, preview: previewOf(haystack, byteStart, byteEnd) };
}

type FuzzyCluster = {
  normStart: number;
  normEnd: number;
  byteStart: number;
  byteEnd: number;
  score: number;
};

/**
 * Candidates are grouped by where their window STARTS, bucketed at half a
 * needle length, and only the best-scoring member of each bucket survives.
 *
 * The obvious alternative -- merge each candidate into the previous one if the
 * two windows overlap -- is transitively wrong. In a markdown table of
 * near-identical rows the DP emits an unbroken chain of overlapping windows
 * spanning every row, so chained merging collapses genuinely distinct rows into
 * a single region and the uniqueness guard never fires. Two candidates whose
 * starts fall in the same bucket are less than half a needle apart and really
 * are one location; anything further apart stays separable, and the greedy
 * non-overlap pass in the caller settles the rest.
 */
function clusterBucketSize(needleLength: number): number {
  return Math.max(1, Math.floor(needleLength / 2));
}

/**
 * Sellers' approximate search: Levenshtein with a free start position, so one
 * pass over the haystack yields, for every end position, the best-scoring
 * window that ends there. Start positions are carried alongside the distances
 * so a winning cell knows the window it came from.
 *
 * Ukkonen's cutoff bounds the computed rows to those still within `maxDist`,
 * which is what keeps a 300 KB haystack tractable.
 */
function fuzzyClusters(
  hay: string,
  hayStarts: Int32Array,
  hayEnds: Int32Array,
  needle: string,
  threshold: number,
): FuzzyCluster[] {
  const m = needle.length;
  const n = hay.length;
  if (m === 0 || n === 0) return [];

  // score >= threshold implies dist <= m * (1 - threshold) / threshold, and a
  // window can never beat distance m, so clamp there.
  const maxDist =
    threshold > 0 ? Math.min(m, Math.floor((m * (1 - threshold)) / threshold)) : m;
  const infinite = maxDist + 1;

  let prev = new Int32Array(m + 1);
  let prevStart = new Int32Array(m + 1);
  let cur = new Int32Array(m + 1);
  let curStart = new Int32Array(m + 1);

  for (let i = 0; i <= m; i += 1) {
    prev[i] = i <= maxDist ? i : infinite;
    prevStart[i] = 0;
  }
  let lastRow = Math.min(m, maxDist);

  const bucketSize = clusterBucketSize(m);
  const buckets = new Map<number, FuzzyCluster>();

  for (let j = 1; j <= n; j += 1) {
    const hayChar = hay[j - 1];
    cur[0] = 0;
    curStart[0] = j;
    const upTo = Math.min(m, lastRow + 1);
    let newLastRow = 0;

    for (let i = 1; i <= upTo; i += 1) {
      const cost = needle[i - 1] === hayChar ? 0 : 1;
      let best = prev[i - 1] + cost;
      let bestStart = prevStart[i - 1];

      // On equal cost, prefer the alignment that STARTS EARLIEST. Distance ties
      // are routine -- matching "| C |" against "| C3 |" costs one edit whether
      // the window opens at the "C" and drops the "3", or opens at the "3" and
      // substitutes it -- and preferring the diagonal silently chose the later
      // start, clipping the row ordinal off the emitted span.
      const insertion = prev[i] + 1; // an extra haystack character
      if (insertion < best || (insertion === best && prevStart[i] < bestStart)) {
        best = insertion;
        bestStart = prevStart[i];
      }
      const deletion = cur[i - 1] + 1; // a needle character absent from the window
      if (deletion < best || (deletion === best && curStart[i - 1] < bestStart)) {
        best = deletion;
        bestStart = curStart[i - 1];
      }

      if (best > maxDist) best = infinite;
      cur[i] = best;
      curStart[i] = bestStart;
      if (best <= maxDist) newLastRow = i;
    }
    for (let i = upTo + 1; i <= m; i += 1) {
      cur[i] = infinite;
      curStart[i] = 0;
    }
    lastRow = newLastRow;

    if (upTo === m && cur[m] <= maxDist) {
      const normStart = curStart[m];
      if (normStart < j) {
        const windowLength = j - normStart;
        const score = 1 - cur[m] / Math.max(m, windowLength);
        if (score > 0 && score >= threshold) {
          const key = Math.floor(normStart / bucketSize);
          const held = buckets.get(key);
          if (held === undefined || score > held.score) {
            buckets.set(key, {
              normStart,
              normEnd: j,
              byteStart: hayStarts[normStart] as number,
              byteEnd: hayEnds[j - 1] as number,
              score,
            });
          }
        }
      }
    }

    const swapDistance = prev;
    prev = cur;
    cur = swapDistance;
    const swapStart = prevStart;
    prevStart = curStart;
    curStart = swapStart;
  }
  return [...buckets.values()];
}

function overlaps(a: FuzzyCluster, b: FuzzyCluster): boolean {
  return a.byteStart < b.byteEnd && b.byteStart < a.byteEnd;
}

/**
 * Locate `needle` inside `haystack`, tolerating the drift classes the corpus
 * runs actually produced, and return the bounds of the TRUE source bytes.
 *
 * Tier 0 exact bytes -> tier 1 normalized projection -> tier 2 fuzzy window.
 * Tiers 1 and 2 both refuse rather than guess when two disjoint regions are
 * indistinguishable; that refusal is what makes loose matching safe.
 */
export function locateCccPrdQuote(
  haystack: Buffer,
  needle: string,
  options: LocateCccPrdQuoteOptions = {},
): CccPrdQuoteLocation {
  const threshold = options.fuzzyThreshold ?? DEFAULT_CCC_PRD_QUOTE_FUZZY_THRESHOLD;
  const epsilon = options.ambiguityEpsilon ?? DEFAULT_CCC_PRD_QUOTE_AMBIGUITY_EPSILON;
  const maxCandidates = Math.max(2, options.maxAmbiguousCandidates ?? DEFAULT_MAX_AMBIGUOUS_CANDIDATES);

  const from = Math.max(0, options.searchBounds?.byteStart ?? 0);
  const to = Math.min(haystack.byteLength, options.searchBounds?.byteEnd ?? haystack.byteLength);
  if (needle.length === 0 || from >= to) return { kind: "notFound" };

  // -- Tier 0: exact bytes -------------------------------------------------
  const needleBytes = Buffer.from(needle, "utf8");
  if (needleBytes.byteLength === 0) return { kind: "notFound" };
  const scoped = haystack.subarray(from, to);
  const exactIndex = scoped.indexOf(needleBytes);
  if (exactIndex >= 0) {
    const byteStart = from + exactIndex;
    return { kind: "exact", byteStart, byteEnd: byteStart + needleBytes.byteLength };
  }

  // -- Tier 1: normalized projection with an inverse offset map ------------
  const projection = projectNormalized(haystack, ALL_NORMALIZATIONS_ON, from, to, 0);
  const normalizedNeedle = normalizeNeedle(needle, ALL_NORMALIZATIONS_ON);
  if (normalizedNeedle.length > 0) {
    const hits = findAllIndexes(projection.text, normalizedNeedle);
    const spans = hits.map((hit) => ({
      byteStart: projection.startBytes[hit] as number,
      byteEnd: projection.endBytes[hit + normalizedNeedle.length - 1] as number,
    }));
    if (spans.length === 1) {
      const [only] = spans as [{ byteStart: number; byteEnd: number }];
      return {
        kind: "normalized",
        byteStart: only.byteStart,
        byteEnd: only.byteEnd,
        appliedStrategies: strategiesThatMattered(haystack, only.byteStart, only.byteEnd, needle),
      };
    }
    if (spans.length > 1) {
      // Exactly-tied normalized hits. There is no score to separate them, so
      // the uniqueness guard applies here too: name them, never pick one.
      return {
        kind: "ambiguous",
        candidates: spans
          .slice(0, maxCandidates)
          .map((span) => toCandidate(haystack, span.byteStart, span.byteEnd, 1)),
      };
    }
  }

  if (options.disableFuzzy === true) return { kind: "notFound" };

  // -- Tier 2: fuzzy window over the same normalized projection ------------
  if (normalizedNeedle.length === 0) return { kind: "notFound" };
  const clusters = fuzzyClusters(
    projection.text,
    projection.startBytes,
    projection.endBytes,
    normalizedNeedle,
    threshold,
  );
  if (clusters.length === 0) return { kind: "notFound" };

  const ranked = [...clusters].sort(
    (left, right) =>
      right.score - left.score ||
      left.byteEnd - left.byteStart - (right.byteEnd - right.byteStart) ||
      left.byteStart - right.byteStart,
  );

  // Greedy non-overlap selection: walk best-first and keep a candidate only if
  // it describes a region no better candidate already claimed. What survives is
  // a disjoint shortlist, so "second best" means a genuinely different place in
  // the document rather than the same match shifted by one character.
  const disjoint: FuzzyCluster[] = [];
  for (const cluster of ranked) {
    if (disjoint.some((chosen) => overlaps(chosen, cluster))) continue;
    disjoint.push(cluster);
    if (disjoint.length >= maxCandidates) break;
  }

  const [best] = disjoint as [FuzzyCluster];
  const runnerUp = disjoint[1];

  // -- Uniqueness guard ----------------------------------------------------
  if (runnerUp !== undefined && best.score - runnerUp.score <= epsilon) {
    return {
      kind: "ambiguous",
      candidates: disjoint
        .filter((cluster) => best.score - cluster.score <= epsilon)
        .map((cluster) => toCandidate(haystack, cluster.byteStart, cluster.byteEnd, cluster.score)),
    };
  }

  return { kind: "fuzzy", byteStart: best.byteStart, byteEnd: best.byteEnd, score: best.score };
}
