import { createHash } from "node:crypto";
import {
  createCccPrdSpanFromBytes,
  type CccPrdMaterialCoverageItem,
  type CccPrdRequirement,
  type CccPrdSourceSpan,
  type CccPrdTask,
  type CccPrdUnresolvedDecision,
} from "@fusion/core";

export type CccPrdSourceLine = {
  text: string;
  byteStart: number;
  byteEnd: number;
  contentEnd: number;
  fenced: boolean;
};
type SourceLine = CccPrdSourceLine;

export type CccPrdSourceHeading = {
  index: number;
  level: number;
  title: string;
  headingPath: string[];
  byteStart: number;
  contentEnd: number;
};

type MaterialInventoryItem = Omit<CccPrdMaterialCoverageItem, "disposition"> & {
  coverageStart: number;
  coverageEnd: number;
  sourceText: string;
};

export type CccPrdMaterialCoverageAnalysis = {
  inventory: MaterialInventoryItem[];
  coverage: CccPrdMaterialCoverageItem[];
  missing: MaterialInventoryItem[];
  conflicts: MaterialInventoryItem[];
};

type AnalyzeCccPrdMaterialCoverageInput = {
  sourceBytes: Map<string, Buffer>;
  requirements: CccPrdRequirement[];
  tasks: CccPrdTask[];
  unresolvedDecisions: CccPrdUnresolvedDecision[];
};

const REQUIREMENT_TOKEN = /\b((?:REQ|FR|NFR|AC|KTD|BTI)-[A-Z0-9][A-Z0-9._-]*)\b/gu;
const BULLET_REQUIREMENT = /^\s*[-*+]\s+`?((?:REQ|FR|NFR|AC|KTD|BTI)-[A-Z0-9][A-Z0-9._-]*)`?\s*(?::|—|\|)/u;
const TABLE_REQUIREMENT = /^\s*\|\s*`?((?:REQ|FR|NFR|AC|KTD|BTI)-[A-Z0-9][A-Z0-9._-]*)`?\s*\|/u;
/*
 * Disposition markers are load-bearing: matching one lets a material item leave
 * `missing` with no task, requirement, or unresolved decision standing behind
 * it. A false positive is therefore SILENT under-coverage, while a false
 * negative only forces a loud `missing` refusal that the chunk retry loop can
 * recover from -- so this matcher is deliberately biased toward the loud
 * failure.
 *
 * A heading disposes its section only when it declares disposition and nothing
 * else. "Non-Goals" and "Deferred Items" do; "deferred-decision registry" (a
 * registry ABOUT deferrals), "Non-Goal Guardrail Requirements" (real
 * requirements), and "Core Decision And Non-Goals" (in-scope material sharing a
 * heading) do not. Authors who need to dispose a heading the matcher will not
 * take -- "Phase 2 Retrieval Deferred" -- tag it explicitly, either as
 * "Phase 2 Retrieval (Deferred)" or with a `Status: deferred` line in the body.
 */
const DISPOSITION_QUALIFIER = "explicitly?|known|current|initial|additional|other|remaining";
const DISPOSITION_HEAD_NOUN =
  "items?|work|scopes?|lists?|sections?|notes?|areas?|features?|topics?|decisions?|phases?";
const DEFERRED_CORE =
  "deferred|deferrals?|postponed|postponements?|future[\\s-]+scopes?|later[\\s-]+phases?|not[\\s-]+now";
const OUT_OF_SCOPE_CORE =
  "non[\\s-]?goals?|out[\\s-]+of[\\s-]+scope|not[\\s-]+in[\\s-]+scope"
  + "|excluded[\\s-]+from[\\s-]+scope|exclusions?|will[\\s-]+not[\\s-]+(?:be[\\s-]+)?implement(?:ed)?";

/** Anchored end-to-end, so the marker has to BE the phrase rather than sit inside one. */
function dispositionHeadingMatcher(core: string): RegExp {
  return new RegExp(
    `^(?:(?:${DISPOSITION_QUALIFIER})[\\s-]+)*(?:${core})(?:[\\s-]+(?:${DISPOSITION_HEAD_NOUN}))?$`,
    "iu",
  );
}

const DEFERRED_HEADING = dispositionHeadingMatcher(DEFERRED_CORE);
const OUT_OF_SCOPE_HEADING = dispositionHeadingMatcher(OUT_OF_SCOPE_CORE);

/*
 * A trailing bare marker ("Phase 2 Retrieval Deferred") reads predicatively and
 * was tried here, then rejected on corpus evidence: disposition is inherited by
 * the whole subtree, and in QDB-Agent-Access-And-SQL-Zero.md that H2's subtree
 * holds the `qdb` SDK layer and every REQ-QDB-* requirement -- the document's
 * headline deliverable. Honouring it silently deferred ~30 core requirements per
 * file to rescue one heading. Blast radius beats grammar, so it stays out.
 */
/** "A and B", "A & B", "A / B", "A, B" -- coordination, not a single subject. */
const DISPOSITION_CONJUNCTION = /\s+(?:and|&|\+|or)\s+|\s*[/,;]\s*/iu;

type HeadingDisposition = { deferred: boolean; outOfScope: boolean };
const NO_DISPOSITION: HeadingDisposition = { deferred: false, outOfScope: false };

/** "3.1 Non-Goals (v2):" -> "Non-Goals" */
function normalizeDispositionHeading(title: string): string {
  return title
    .replace(/^\s*\d+(?:\.\d+)*[.):]?\s+/u, "")
    .replace(/[([{][^)\]}]*[)\]}]/gu, " ")
    .replace(/[\s.:;—–-]+$/u, "")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * Every coordinated conjunct must be a marker. One unmarked conjunct means the
 * heading also names in-scope material, so the section keeps its coverage duty.
 */
function dispositionOfPhrase(phrase: string): HeadingDisposition {
  const conjuncts = phrase.split(DISPOSITION_CONJUNCTION)
    .map((part) => part.trim())
    .filter(Boolean);
  if (conjuncts.length === 0) return NO_DISPOSITION;
  let deferred = false;
  let outOfScope = false;
  for (const conjunct of conjuncts) {
    if (DEFERRED_HEADING.test(conjunct)) deferred = true;
    else if (OUT_OF_SCOPE_HEADING.test(conjunct)) outOfScope = true;
    else return NO_DISPOSITION;
  }
  return { deferred, outOfScope };
}

/**
 * Code is quoted, not asserted. Every corpus hit on the body `Status:` field was
 * a document DESCRIBING this refusal -- "Refusal on `while true` and
 * `status: DEFERRED` in prose" -- so a backticked or fenced mention must not
 * dispose the section that discusses it.
 */
function withoutCodeText(text: string): string {
  return text
    .replace(/^[ \t]*(?:`{3,}|~{3,})[\s\S]*?^[ \t]*(?:`{3,}|~{3,})[^\n]*$/gmu, " ")
    .replace(/`[^`\n]*`/gu, " ");
}

/** A bracketed status tag is an unambiguous declaration and is honoured on its own. */
function dispositionOfHeading(title: string): HeadingDisposition {
  for (const group of title.matchAll(/[([{]([^)\]}]*)[)\]}]/gu)) {
    const tagged = dispositionOfPhrase(normalizeDispositionHeading(group[1] ?? ""));
    if (tagged.deferred || tagged.outOfScope) return tagged;
  }
  return dispositionOfPhrase(normalizeDispositionHeading(title));
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stableMaterialId(
  path: string,
  kind: "section" | "requirement",
  title: string,
  byteStart: number,
  byteEnd: number,
): string {
  const digest = createHash("sha256")
    .update(`${path}\0${kind}\0${title}\0${byteStart}\0${byteEnd}`, "utf8")
    .digest("hex")
    .slice(0, 16);
  return `MAT-${digest}`;
}

/** The line-and-fence walk that both the coverage scorer and the chunk planner read (design §1). */
export function computeCccPrdSourceLines(bytes: Buffer): CccPrdSourceLine[] {
  const lines: SourceLine[] = [];
  let byteStart = 0;
  let fence: "`" | "~" | undefined;
  while (byteStart < bytes.byteLength) {
    const newline = bytes.indexOf(0x0a, byteStart);
    const byteEnd = newline < 0 ? bytes.byteLength : newline + 1;
    const contentEnd = newline < 0
      ? byteEnd
      : (newline > byteStart && bytes[newline - 1] === 0x0d ? newline - 1 : newline);
    const text = bytes.subarray(byteStart, contentEnd).toString("utf8");
    const marker = text.match(/^\s*(`{3,}|~{3,})/u)?.[1];
    const fenced = fence !== undefined;
    if (marker) {
      const markerKind = marker[0] as "`" | "~";
      if (!fence) fence = markerKind;
      else if (fence === markerKind) fence = undefined;
    }
    lines.push({ text, byteStart, byteEnd, contentEnd, fenced: fenced || Boolean(marker) });
    byteStart = byteEnd;
  }
  return lines;
}

/**
 * ATX heading walk only (fenced lines skipped, `:97` in the design's
 * citation); setext headings and any preamble before the first heading are
 * deliberately invisible here, which is exactly the blind spot the chunk
 * planner's byte-partition invariant has to cover independently (design §1).
 */
export function computeCccPrdSourceHeadings(
  bytes: Buffer,
  lines: CccPrdSourceLine[],
): CccPrdSourceHeading[] {
  const headings: CccPrdSourceHeading[] = [];
  const headingStack: string[] = [];
  for (const [index, line] of lines.entries()) {
    if (line.fenced) continue;
    const match = line.text.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/u);
    if (!match) continue;
    const level = match[1]!.length;
    const title = match[2]!.trim();
    headingStack.length = level - 1;
    headingStack[level - 1] = title;
    headings.push({
      index,
      level,
      title,
      headingPath: headingStack.filter((entry): entry is string => Boolean(entry)),
      byteStart: line.byteStart,
      contentEnd: line.contentEnd,
    });
  }
  return headings;
}

export function computeCccPrdMaterialInventory(path: string, bytes: Buffer): MaterialInventoryItem[] {
  const lines = computeCccPrdSourceLines(bytes);
  const headings = computeCccPrdSourceHeadings(bytes, lines);

  const inventory: MaterialInventoryItem[] = [];
  for (const [headingIndex, heading] of headings.entries()) {
    const line = lines[heading.index]!;
    const nextHeading = headings[headingIndex + 1];
    const immediateBodyEnd = nextHeading
      ? lines[nextHeading.index]!.byteStart
      : bytes.byteLength;
    const immediateBody = bytes.subarray(line.byteEnd, immediateBodyEnd).toString("utf8").trim();
    if (!immediateBody) continue;
    const nextPeer = headings.slice(headingIndex + 1).find((candidate) => (
      candidate.level <= heading.level
    ));
    const coverageEnd = nextPeer
      ? lines[nextPeer.index]!.byteStart
      : bytes.byteLength;
    inventory.push({
      id: stableMaterialId(path, "section", heading.title, line.byteStart, line.contentEnd),
      sourcePath: path,
      materialKind: "section",
      headingPath: heading.headingPath,
      title: heading.title,
      spans: [createCccPrdSpanFromBytes(path, bytes, line.byteStart, line.contentEnd)],
      coverageStart: line.byteStart,
      coverageEnd,
      sourceText: bytes.subarray(line.byteStart, immediateBodyEnd).toString("utf8"),
    });
  }

  for (const [index, line] of lines.entries()) {
    if (line.fenced) continue;
    const heading = line.text.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/u);
    const stableRowId = line.text.match(BULLET_REQUIREMENT)?.[1]
      ?? line.text.match(TABLE_REQUIREMENT)?.[1];
    const ids = new Set<string>();
    if (stableRowId) ids.add(stableRowId);
    if (heading) {
      for (const match of heading[2]!.matchAll(REQUIREMENT_TOKEN)) {
        if (match[1]) ids.add(match[1]);
      }
    }
    if (ids.size === 0) continue;
    const headingPath = headings
      .filter((candidate) => candidate.index <= index)
      .at(-1)?.headingPath ?? [];
    for (const id of ids) {
      inventory.push({
        id: stableMaterialId(path, "requirement", id, line.byteStart, line.contentEnd),
        sourcePath: path,
        materialKind: "requirement",
        headingPath,
        title: id,
        spans: [createCccPrdSpanFromBytes(path, bytes, line.byteStart, line.contentEnd)],
        coverageStart: line.byteStart,
        coverageEnd: line.byteEnd,
        sourceText: line.text,
      });
    }
  }

  return inventory.sort((left, right) => (
    left.spans[0]!.byteStart - right.spans[0]!.byteStart
    || compareCodeUnits(left.materialKind, right.materialKind)
    || compareCodeUnits(left.title, right.title)
  ));
}

function overlaps(
  spans: CccPrdSourceSpan[] | undefined,
  item: MaterialInventoryItem,
): boolean {
  return Array.isArray(spans) && spans.some((span) => (
    span.path === item.sourcePath
    && span.byteStart < item.coverageEnd
    && span.byteEnd > item.coverageStart
  ));
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort(compareCodeUnits);
}

function withoutAnalysisFields(
  item: MaterialInventoryItem,
): Omit<CccPrdMaterialCoverageItem, "disposition"> {
  return {
    id: item.id,
    sourcePath: item.sourcePath,
    materialKind: item.materialKind,
    headingPath: [...item.headingPath],
    title: item.title,
    spans: item.spans,
  };
}

export function analyzeCccPrdMaterialCoverage(
  input: AnalyzeCccPrdMaterialCoverageInput,
): CccPrdMaterialCoverageAnalysis {
  const inventory = [...input.sourceBytes.entries()]
    .flatMap(([path, bytes]) => computeCccPrdMaterialInventory(path, bytes));
  const coverage: CccPrdMaterialCoverageItem[] = [];
  const missing: MaterialInventoryItem[] = [];
  const conflicts: MaterialInventoryItem[] = [];

  for (const item of inventory) {
    const matchingRequirements = input.requirements.filter((requirement) => (
      requirement.id === item.title || overlaps(requirement.spans, item)
    ));
    const matchingRequirementIds = new Set(matchingRequirements.map(({ id }) => id));
    const matchingTasks = input.tasks.filter((task) => (
      overlaps(task.spans, item)
      || task.requirementIds.some((id) => matchingRequirementIds.has(id))
    ));
    const matchingUnresolved = input.unresolvedDecisions.filter((decision) => (
      overlaps(decision.spans, item)
      || decision.question.includes(item.title)
    ));
    // Each heading on the path is matched on its own. Joining them into one
    // string let any ancestor's passing mention of a marker dispose the whole
    // subtree, and let phrases form across the join seam -- "# Roadmap Later"
    // above "## Phase 2 delivery" read as "later phase".
    let headingDeferred = false;
    let headingOutOfScope = false;
    for (const segment of [...item.headingPath, item.title]) {
      const disposition = dispositionOfHeading(segment);
      headingDeferred ||= disposition.deferred;
      headingOutOfScope ||= disposition.outOfScope;
    }
    const declaredText = withoutCodeText(item.sourceText);
    const explicitlyDeferred = headingDeferred
      || /\bstatus\s*:\s*deferred\b/iu.test(declaredText);
    const explicitlyOutOfScope = headingOutOfScope
      || /\bstatus\s*:\s*out[_ -]of[_ -]scope\b/iu.test(declaredText);

    if (
      (matchingTasks.length > 0 && (explicitlyDeferred || explicitlyOutOfScope || matchingUnresolved.length > 0))
      || (explicitlyDeferred && explicitlyOutOfScope)
    ) {
      conflicts.push(item);
      continue;
    }

    const common = withoutAnalysisFields(item);
    if (matchingTasks.length > 0) {
      coverage.push({
        ...common,
        disposition: {
          kind: "task",
          taskIds: sortedUnique(matchingTasks.map(({ id }) => id)),
          requirementIds: sortedUnique(matchingTasks.flatMap(({ requirementIds }) => requirementIds)),
        },
      });
    } else if (matchingUnresolved.length > 0) {
      coverage.push({
        ...common,
        disposition: {
          kind: "unresolved_question",
          unresolvedDecisionIds: sortedUnique(matchingUnresolved.map(({ id }) => id)),
        },
      });
    } else if (explicitlyDeferred) {
      coverage.push({
        ...common,
        disposition: {
          kind: "explicit_deferral",
          reason: "the admitted source explicitly labels this material item as deferred",
        },
      });
    } else if (explicitlyOutOfScope) {
      coverage.push({
        ...common,
        disposition: {
          kind: "out_of_scope",
          reason: "the admitted source explicitly labels this material item as out of scope",
        },
      });
    } else {
      missing.push(item);
    }
  }

  return {
    inventory,
    coverage: coverage.sort((left, right) => compareCodeUnits(left.id, right.id)),
    missing,
    conflicts,
  };
}
