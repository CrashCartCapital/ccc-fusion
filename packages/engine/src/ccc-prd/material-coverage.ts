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
const DEFERRED_MARKER = /\b(deferred|postponed|future scope|later phase|not now)\b/iu;
const OUT_OF_SCOPE_MARKER = /\b(non[- ]goals?|out of scope|not in scope|excluded from scope|will not implement)\b/iu;

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
    const dispositionLabel = [...item.headingPath, item.title].join(" ");
    const explicitlyDeferred = DEFERRED_MARKER.test(dispositionLabel)
      || /\bstatus\s*:\s*deferred\b/iu.test(item.sourceText);
    const explicitlyOutOfScope = OUT_OF_SCOPE_MARKER.test(dispositionLabel)
      || /\bstatus\s*:\s*out[_ -]of[_ -]scope\b/iu.test(item.sourceText);

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
