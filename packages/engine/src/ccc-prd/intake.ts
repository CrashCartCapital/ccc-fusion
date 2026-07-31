import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  CCC_PRD_PACKET_SCHEMA_VERSION,
  canonicalCccPrdJson,
  compareCccPrdCodeUnits,
} from "@fusion/core";

const DISCOVERY_SCHEMA = "ccc-prd.discovery.v1" as const;
const FREEZE_RESULT_SCHEMA = "ccc-prd.freeze-result.v1" as const;
const FREEZE_RECEIPT_SCHEMA = "ccc-prd.freeze-receipt.v1" as const;
const MAX_PACKET_FILES = 128;
const MAX_PACKET_BYTES = 10 * 1024 * 1024;
const MAX_UNRESOLVED_REFERENCES = 2_048;

const PROTECTED_SEGMENTS = new Set([".obsidian", "_kelsey", "_secrets"]);
const ARCHIVE_SEGMENTS = new Set([
  "_archive",
  "99_archive",
  "_sunset",
  "sunset",
  "_sources",
  "_lame",
]);
const RETIRED_STATUS = new Set([
  "archived",
  "deprecated",
  "obsolete",
  "rejected",
  "retired",
  "sunset",
  "superseded",
]);

export class CccPrdIntakeError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CccPrdIntakeError";
  }
}

export type CccPrdDiscoveryCandidateScore = {
  semver: [number, number, number] | null;
  status: number;
  signal: number;
};

export type CccPrdDiscoveryCandidate = {
  path: string;
  projectRelativePath: string;
  version: string | null;
  status: string | null;
  score: CccPrdDiscoveryCandidateScore;
};

export type CccPrdProjectDiscovery = {
  project: string;
  projectRoot: string;
  candidates: CccPrdDiscoveryCandidate[];
  selection:
    | { kind: "selected"; selectedPrdPath: string }
    | { kind: "ambiguous"; candidatePaths: string[]; reason: string }
    | { kind: "none" };
};

export type CccPrdDiscoveryResult = {
  schema: typeof DISCOVERY_SCHEMA;
  activeProjectsRoot: string;
  projects: CccPrdProjectDiscovery[];
};

export type CccPrdFreezeReceiptEntry = {
  originPath: string;
  frozenPath: string;
  relativePath: string;
  projectRelativePath: string;
  sha256: string;
  byteLength: number;
  role: "root" | "production_module" | "blocking_test_index" | "support";
  authoritative: boolean;
};

export type CccPrdFreezeUnresolvedReference = {
  sourcePath: string;
  sourceRelativePath: string;
  target: string;
  kind: "wiki" | "markdown";
  reason: "missing" | "ambiguous" | "outside" | "protected" | "archive" | "symlink";
};

export type CccPrdFreezeResult = {
  schema: typeof FREEZE_RESULT_SCHEMA;
  rootDir: string;
  manifestPath: string;
  receiptPath: string;
  selectedPrdPath: string;
  packet: {
    schema: typeof CCC_PRD_PACKET_SCHEMA_VERSION;
    sourceVersion: string;
    manifestSha256: string;
    packetHash: string;
    receiptSha256: string;
    fileCount: number;
    totalBytes: number;
    unresolvedReferenceCount: number;
    project: string;
    selectedPrdPath: string;
  };
  unresolvedReferences: CccPrdFreezeUnresolvedReference[];
};

type IndexedMarkdown = {
  path: string;
  projectRelativePath: string;
};

type MarkdownIndex = {
  files: IndexedMarkdown[];
  byRelativePath: Map<string, IndexedMarkdown[]>;
  byBasename: Map<string, IndexedMarkdown[]>;
};

type MarkdownReference = {
  target: string;
  kind: "wiki" | "markdown" | "bare";
  index: number;
};

type PacketSource = IndexedMarkdown & {
  bytes: Buffer;
  authoritative: boolean;
  role: CccPrdFreezeReceiptEntry["role"];
};

type ResolvedReference =
  | { kind: "matches"; matches: IndexedMarkdown[] }
  | { kind: "outside" }
  | { kind: "protected" }
  | { kind: "archive" }
  | { kind: "symlink" }
  | { kind: "ignored" };

const sha256 = (bytes: Buffer | string): string =>
  createHash("sha256").update(bytes).digest("hex");

function refuse(code: string, message: string): never {
  throw new CccPrdIntakeError(code, message);
}

function asIntakeError(error: unknown, code: string, message: string): never {
  if (error instanceof CccPrdIntakeError) throw error;
  const detail = error instanceof Error ? `: ${error.message}` : "";
  return refuse(code, `${message}${detail}`);
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

function pathEscapes(path: string): boolean {
  return path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path);
}

function isWithin(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || !pathEscapes(child);
}

function segmentKind(segment: string): "protected" | "archive" | null {
  const lower = segment.toLowerCase();
  if (PROTECTED_SEGMENTS.has(lower)) return "protected";
  if (
    ARCHIVE_SEGMENTS.has(lower)
    || /(?:^|[_-])archive(?:d)?(?:[_-]|$)/.test(lower)
    || /(?:^|[_-])deprecated(?:[_-]|$)/.test(lower)
  ) {
    return "archive";
  }
  return null;
}

function pathSegmentKind(path: string): "protected" | "archive" | null {
  for (const segment of path.split(/[\\/]+/).filter(Boolean)) {
    const kind = segmentKind(segment);
    if (kind) return kind;
  }
  return null;
}

function lstatOrNull(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function canonicalDirectory(path: string, label: string): string {
  const lexical = resolve(path);
  try {
    const stat = lstatSync(lexical);
    if (stat.isSymbolicLink()) {
      return refuse("CCC_PRD_INTAKE_SYMLINK", `${label} must not be a symlink: ${lexical}`);
    }
    if (!stat.isDirectory()) {
      return refuse("CCC_PRD_INTAKE_ROOT_INVALID", `${label} is not a directory: ${lexical}`);
    }
    // Validate that the directory resolves, but retain the caller-visible
    // absolute spelling. macOS aliases such as /var -> /private/var must not
    // make an otherwise in-root selected path look like an escape.
    realpathSync(lexical);
    return lexical;
  } catch (error) {
    return asIntakeError(error, "CCC_PRD_INTAKE_ROOT_INVALID", `${label} is unavailable`);
  }
}

function assertSafePathBelow(root: string, candidate: string, label: string): void {
  const child = relative(root, candidate);
  if (pathEscapes(child)) {
    return refuse("CCC_PRD_INTAKE_PATH_ESCAPE", `${label} is outside its admitted root: ${candidate}`);
  }
  let cursor = root;
  for (const segment of child.split(sep).filter(Boolean)) {
    const kind = segmentKind(segment);
    if (kind === "protected") {
      return refuse("CCC_PRD_INTAKE_PROTECTED_PATH", `${label} names a protected path: ${candidate}`);
    }
    if (kind === "archive") {
      return refuse("CCC_PRD_INTAKE_ARCHIVE_PATH", `${label} names an archive-like path: ${candidate}`);
    }
    cursor = join(cursor, segment);
    const stat = lstatOrNull(cursor);
    if (!stat) {
      return refuse("CCC_PRD_INTAKE_SOURCE_MISSING", `${label} is absent: ${candidate}`);
    }
    if (stat.isSymbolicLink()) {
      return refuse("CCC_PRD_INTAKE_SYMLINK", `${label} traverses a symlink: ${candidate}`);
    }
  }
}

function readSafeMarkdown(
  root: string,
  path: string,
  label: string,
  maxBytes = Number.POSITIVE_INFINITY,
): Buffer {
  assertSafePathBelow(root, path, label);
  const stat = lstatSync(path);
  if (!stat.isFile() || extname(path).toLowerCase() !== ".md") {
    return refuse("CCC_PRD_INTAKE_SOURCE_INVALID", `${label} must be a Markdown file: ${path}`);
  }
  if (stat.size > maxBytes) {
    return refuse(
      "CCC_PRD_INTAKE_BYTE_LIMIT",
      `${label} exceeds the remaining packet byte budget`,
    );
  }
  const bytes = readFileSync(path);
  if (bytes.byteLength > maxBytes) {
    return refuse(
      "CCC_PRD_INTAKE_BYTE_LIMIT",
      `${label} grew beyond the remaining packet byte budget while being read`,
    );
  }
  return bytes;
}

function walkMarkdown(root: string): IndexedMarkdown[] {
  const files: IndexedMarkdown[] = [];
  const visit = (directory: string): void => {
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => compareCccPrdCodeUnits(left.name, right.name));
    for (const entry of entries) {
      const kind = segmentKind(entry.name);
      if (kind) continue;
      const path = join(directory, entry.name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        visit(path);
      } else if (stat.isFile() && extname(entry.name).toLowerCase() === ".md") {
        files.push({
          path,
          projectRelativePath: toPosix(relative(root, path)),
        });
      }
    }
  };
  visit(root);
  return files.sort((left, right) =>
    compareCccPrdCodeUnits(left.projectRelativePath, right.projectRelativePath));
}

function parseFrontmatter(text: string): Map<string, string> {
  const values = new Map<string, string>();
  const normalized = text.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return values;
  const end = normalized.indexOf("\n---", 4);
  if (end < 0) return values;
  for (const line of normalized.slice(4, end).split("\n")) {
    const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    values.set(
      match[1]!.toLowerCase(),
      match[2]!.replace(/^["']|["']$/g, "").trim(),
    );
  }
  return values;
}

function parseSemver(...values: Array<string | undefined>): [number, number, number] | null {
  for (const value of values) {
    if (!value) continue;
    const match = /(?:^|[^0-9])v?(\d+)\.(\d+)(?:\.(\d+))?(?:[^0-9]|$)/i.exec(value);
    if (!match) continue;
    const semver: [number, number, number] = [
      Number(match[1]),
      Number(match[2]),
      Number(match[3] ?? 0),
    ];
    if (semver.every(Number.isSafeInteger)) return semver;
  }
  return null;
}

function statusScore(status: string | null): number {
  switch (status?.toLowerCase()) {
    case "accepted":
    case "approved":
    case "current":
    case "final":
      return 4;
    case "active":
    case "ready":
      return 3;
    case "draft":
    case "in-progress":
    case "in_progress":
      return 2;
    case "planned":
    case "proposed":
      return 1;
    default:
      return 0;
  }
}

function candidateFromMarkdown(
  file: IndexedMarkdown,
  admittedBytes?: Buffer,
): CccPrdDiscoveryCandidate | null {
  const bytes = admittedBytes ?? readFileSync(file.path);
  const text = bytes.toString("utf8");
  const frontmatter = parseFrontmatter(text);
  const status = frontmatter.get("status") ?? null;
  if (status && RETIRED_STATUS.has(status.toLowerCase())) return null;

  const name = basename(file.path);
  const filenameSignal = /(?:^|[-_.])prd(?:[-_.]|$)/i.test(name);
  const type = frontmatter.get("type")?.toLowerCase();
  const tagSignal = /(?:^|[\s,[\]-])prd(?:$|[\s,\]])/i.test(frontmatter.get("tags") ?? "");
  const headingSignal = /^#{1,2}\s+.*(?:\bPRD\b|product requirements?)/im.test(text.slice(0, 16_384));
  const metadataSignal = type === "prd" || type === "product-requirements";
  if (!filenameSignal && !tagSignal && !headingSignal && !metadataSignal) return null;

  const semver = parseSemver(
    frontmatter.get("version"),
    frontmatter.get("prd_version"),
    name,
    text.slice(0, 4_096),
  );
  return {
    path: file.path,
    projectRelativePath: file.projectRelativePath,
    version: semver ? semver.join(".") : null,
    status,
    score: {
      semver,
      status: statusScore(status),
      signal: filenameSignal ? 2 : 1,
    },
  };
}

function compareCandidateScore(
  left: CccPrdDiscoveryCandidate,
  right: CccPrdDiscoveryCandidate,
): number {
  if (left.score.semver && !right.score.semver) return 1;
  if (!left.score.semver && right.score.semver) return -1;
  if (left.score.semver && right.score.semver) {
    for (let index = 0; index < 3; index += 1) {
      const difference = left.score.semver[index]! - right.score.semver[index]!;
      if (difference !== 0) return difference;
    }
  }
  const statusDifference = left.score.status - right.score.status;
  if (statusDifference !== 0) return statusDifference;
  return left.score.signal - right.score.signal;
}

function projectSelection(
  candidates: CccPrdDiscoveryCandidate[],
): CccPrdProjectDiscovery["selection"] {
  if (candidates.length === 0) return { kind: "none" };
  let highest = candidates[0]!;
  for (const candidate of candidates.slice(1)) {
    if (compareCandidateScore(candidate, highest) > 0) highest = candidate;
  }
  const ties = candidates
    .filter((candidate) => compareCandidateScore(candidate, highest) === 0)
    .map((candidate) => candidate.path);
  if (ties.length > 1) {
    return {
      kind: "ambiguous",
      candidatePaths: ties,
      reason: "multiple current PRD candidates share the highest project-local semver/status score",
    };
  }
  return { kind: "selected", selectedPrdPath: highest.path };
}

export function discoverCccPrdCandidates(input: {
  activeProjectsRoot: string;
}): CccPrdDiscoveryResult {
  try {
    const activeProjectsRoot = canonicalDirectory(
      input.activeProjectsRoot,
      "active-projects root",
    );
    const projects: CccPrdProjectDiscovery[] = [];
    const entries = readdirSync(activeProjectsRoot, { withFileTypes: true })
      .sort((left, right) => compareCccPrdCodeUnits(left.name, right.name));
    for (const entry of entries) {
      if (segmentKind(entry.name)) continue;
      const projectRoot = join(activeProjectsRoot, entry.name);
      const stat = lstatSync(projectRoot);
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      const candidates = walkMarkdown(projectRoot)
        .map((file) => candidateFromMarkdown(file))
        .filter((candidate): candidate is CccPrdDiscoveryCandidate => candidate !== null);
      projects.push({
        project: entry.name,
        projectRoot,
        candidates,
        selection: projectSelection(candidates),
      });
    }
    return { schema: DISCOVERY_SCHEMA, activeProjectsRoot, projects };
  } catch (error) {
    return asIntakeError(
      error,
      "CCC_PRD_DISCOVERY_FAILED",
      "CCC PRD discovery failed",
    );
  }
}

function buildMarkdownIndex(projectRoot: string): MarkdownIndex {
  const files = walkMarkdown(projectRoot);
  const byRelativePath = new Map<string, IndexedMarkdown[]>();
  const byBasename = new Map<string, IndexedMarkdown[]>();
  for (const file of files) {
    const relativeKey = file.projectRelativePath.toLowerCase();
    const basenameKey = basename(file.projectRelativePath).toLowerCase();
    byRelativePath.set(relativeKey, [...(byRelativePath.get(relativeKey) ?? []), file]);
    byBasename.set(basenameKey, [...(byBasename.get(basenameKey) ?? []), file]);
  }
  return { files, byRelativePath, byBasename };
}

function authorityRanges(text: string): Array<[number, number]> {
  const headings: Array<{ start: number; end: number; level: number; title: string }> = [];
  const headingPattern = /^(#{1,6})[ \t]+(.+?)\s*#*\s*$/gm;
  for (const match of text.matchAll(headingPattern)) {
    headings.push({
      start: match.index,
      end: match.index + match[0].length,
      level: match[1]!.length,
      title: match[2]!,
    });
  }
  const ranges: Array<[number, number]> = [];
  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index]!;
    if (/\bnon[\s_-]*authorit(?:y|ative)\b/i.test(heading.title)) continue;
    if (!(
      /\bsource[\s_-]+set\b/i.test(heading.title)
      || /\bsource[\s_-]+authorit(?:y|ies)\b/i.test(heading.title)
      || /\bauthorit(?:y|ative)[\s_-]+(?:set|sources?|documents?|inputs?|packet)\b/i.test(heading.title)
      || /^(?:packet[\s_-]+)?authority$/i.test(heading.title.trim())
    )) continue;
    const next = headings.slice(index + 1)
      .find((candidate) => candidate.level <= heading.level);
    ranges.push([heading.end, next?.start ?? text.length]);
  }
  return ranges;
}

function extractMarkdownReferences(text: string): MarkdownReference[] {
  const references: MarkdownReference[] = [];
  const occupied: Array<[number, number]> = [];
  const wikiPattern = /\[\[([^\]\n]+)\]\]/g;
  for (const match of text.matchAll(wikiPattern)) {
    const target = match[1]!.split("|", 1)[0]!.split("#", 1)[0]!.trim();
    if (target) {
      references.push({ target, kind: "wiki", index: match.index });
      occupied.push([match.index, match.index + match[0].length]);
    }
  }

  const markdownPattern = /(?<!!)\[(?:[^\]\\]|\\.)*\]\(\s*(?:<([^>\n]+)>|([^)]+))\s*\)/g;
  for (const match of text.matchAll(markdownPattern)) {
    const raw = (match[1] ?? match[2] ?? "")
      .replace(/\s+["'][^"']*["']\s*$/, "")
      .trim();
    if (raw) {
      references.push({ target: raw, kind: "markdown", index: match.index });
      occupied.push([match.index, match.index + match[0].length]);
    }
  }

  const codePattern = /`([^`\n]+\.md)`/gi;
  for (const match of text.matchAll(codePattern)) {
    if (occupied.some(([start, end]) => match.index >= start && match.index < end)) {
      continue;
    }
    references.push({ target: match[1]!.trim(), kind: "bare", index: match.index });
    occupied.push([match.index, match.index + match[0].length]);
  }

  const barePattern = /((?:\/|\.{1,2}\/)?(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.md)\b/gi;
  for (const match of text.matchAll(barePattern)) {
    if (occupied.some(([start, end]) => match.index >= start && match.index < end)) {
      continue;
    }
    references.push({ target: match[1]!, kind: "bare", index: match.index });
  }
  return references.sort((left, right) =>
    left.index - right.index
    || compareCccPrdCodeUnits(left.kind, right.kind)
    || compareCccPrdCodeUnits(left.target, right.target));
}

function normalizeReferenceTarget(reference: MarkdownReference): string | null {
  let target = reference.target.trim().replace(/^["'`]|["'`]$/g, "");
  if (!target || target.startsWith("#")) return null;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target)) return null;
  try {
    target = decodeURIComponent(target);
  } catch {
    // Preserve the literal local path; malformed percent encoding is not a
    // reason to reinterpret or read a different path.
  }
  target = target.split("#", 1)[0]!.split("?", 1)[0]!.trim();
  if (!target) return null;
  if (reference.kind === "wiki" && extname(target) === "") target = `${target}.md`;
  if (extname(target).toLowerCase() !== ".md") return null;
  return target.replaceAll("\\", "/");
}

function pathHasSymlinkBelow(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  if (pathEscapes(child)) return false;
  let cursor = root;
  for (const segment of child.split(sep).filter(Boolean)) {
    cursor = join(cursor, segment);
    const stat = lstatOrNull(cursor);
    if (!stat) return false;
    if (stat.isSymbolicLink()) return true;
  }
  return false;
}

function directIndexMatches(
  projectRoot: string,
  index: MarkdownIndex,
  lexicalPath: string,
): ResolvedReference {
  const relativePath = relative(projectRoot, lexicalPath);
  if (pathEscapes(relativePath)) return { kind: "outside" };
  const pathKind = pathSegmentKind(relativePath);
  if (pathKind === "protected") return { kind: "protected" };
  if (pathKind === "archive") return { kind: "archive" };
  if (pathHasSymlinkBelow(projectRoot, lexicalPath)) return { kind: "symlink" };
  return {
    kind: "matches",
    matches: index.byRelativePath.get(toPosix(relativePath).toLowerCase()) ?? [],
  };
}

function uniqueMatches(matches: IndexedMarkdown[]): IndexedMarkdown[] {
  const byPath = new Map(matches.map((match) => [match.path, match]));
  return [...byPath.values()].sort((left, right) =>
    compareCccPrdCodeUnits(left.projectRelativePath, right.projectRelativePath));
}

function resolveMarkdownReference(
  projectRoot: string,
  current: IndexedMarkdown,
  reference: MarkdownReference,
  index: MarkdownIndex,
): ResolvedReference {
  let target = normalizeReferenceTarget(reference);
  if (!target) return { kind: "ignored" };
  if (target.startsWith("/")) {
    return directIndexMatches(projectRoot, index, resolve(target));
  }
  const segments = target.split("/").filter(Boolean);
  const projectName = basename(projectRoot);
  const activeProjectsMarker = segments.lastIndexOf("01_ActiveProjects");
  if (activeProjectsMarker >= 0) {
    if (segments[activeProjectsMarker + 1] !== projectName) {
      return { kind: "outside" };
    }
    target = segments.slice(activeProjectsMarker + 2).join("/");
  } else if (
    segments[0] === projectName
    || (
      segments[0] === basename(dirname(projectRoot))
      && segments[1] === projectName
    )
  ) {
    target = segments.slice(segments[0] === projectName ? 1 : 2).join("/");
  }
  if (!target) return { kind: "ignored" };
  const targetKind = pathSegmentKind(target);
  if (targetKind === "protected") return { kind: "protected" };
  if (targetKind === "archive") return { kind: "archive" };

  const currentCandidate = resolve(dirname(current.path), target);
  const projectCandidate = resolve(projectRoot, target);
  const currentResult = directIndexMatches(projectRoot, index, currentCandidate);
  if (currentResult.kind !== "matches") return currentResult;
  if (
    reference.kind === "markdown"
    || target.startsWith("./")
    || target.startsWith("../")
  ) {
    return { kind: "matches", matches: uniqueMatches(currentResult.matches) };
  }

  if (target.includes("/")) {
    const projectResult = directIndexMatches(projectRoot, index, projectCandidate);
    if (projectResult.kind !== "matches") return projectResult;
    return {
      kind: "matches",
      matches: uniqueMatches([...currentResult.matches, ...projectResult.matches]),
    };
  }

  if (reference.kind === "bare" && currentResult.matches.length > 0) {
    return { kind: "matches", matches: uniqueMatches(currentResult.matches) };
  }
  return {
    kind: "matches",
    matches: uniqueMatches(index.byBasename.get(target.toLowerCase()) ?? []),
  };
}

function inferRole(
  source: IndexedMarkdown,
  selectedPrdPath: string,
  authoritative: boolean,
  text: string,
): PacketSource["role"] {
  if (source.path === selectedPrdPath) return "root";
  const identity = `${basename(source.path, extname(source.path))}\n${text.slice(0, 1_024)}`;
  if (/blocking[\s_-]*test[\s_-]*index|blockingtestindex/i.test(identity)) {
    return "blocking_test_index";
  }
  if (
    /production[\s_-]*module/i.test(identity)
    || (authoritative && /^PRJ-AI-/i.test(basename(source.path)))
  ) {
    return "production_module";
  }
  return "support";
}

function unresolvedReferenceError(
  reference: MarkdownReference,
  source: IndexedMarkdown,
  resolution: ResolvedReference,
  authoritative: boolean,
): never {
  const label = authoritative ? "declared authority" : "Markdown reference";
  const suffix = `${label} ${JSON.stringify(reference.target)} in ${source.projectRelativePath}`;
  switch (resolution.kind) {
    case "outside":
      return refuse(
        authoritative
          ? "CCC_PRD_DECLARED_AUTHORITY_OUTSIDE_PROJECT"
          : "CCC_PRD_REFERENCE_OUTSIDE_PROJECT",
        `${suffix} leaves the selected top-level project`,
      );
    case "protected":
      return refuse(
        "CCC_PRD_INTAKE_PROTECTED_PATH",
        `${suffix} names a protected path`,
      );
    case "archive":
      return refuse(
        "CCC_PRD_INTAKE_ARCHIVE_PATH",
        `${suffix} names an archive-like path`,
      );
    case "symlink":
      return refuse("CCC_PRD_INTAKE_SYMLINK", `${suffix} traverses a symlink`);
    case "matches":
      if (resolution.matches.length > 1) {
        return refuse(
          authoritative
            ? "CCC_PRD_DECLARED_AUTHORITY_AMBIGUOUS"
            : "CCC_PRD_REFERENCE_AMBIGUOUS",
          `${suffix} resolves to ${resolution.matches.length} Markdown files`,
        );
      }
      return refuse(
        authoritative
          ? "CCC_PRD_DECLARED_AUTHORITY_MISSING"
          : "CCC_PRD_REFERENCE_MISSING",
        `${suffix} does not resolve to a Markdown file`,
      );
    case "ignored":
      return refuse(
        authoritative
          ? "CCC_PRD_DECLARED_AUTHORITY_MISSING"
          : "CCC_PRD_REFERENCE_MISSING",
        `${suffix} is not a local Markdown reference`,
      );
  }
}

function unresolvedReference(
  reference: MarkdownReference,
  source: IndexedMarkdown,
  resolution: Exclude<ResolvedReference, { kind: "ignored" }>,
): CccPrdFreezeUnresolvedReference {
  const reason = resolution.kind === "matches"
    ? (resolution.matches.length > 1 ? "ambiguous" : "missing")
    : resolution.kind;
  return {
    sourcePath: source.path,
    sourceRelativePath: source.projectRelativePath,
    target: reference.target,
    kind: reference.kind as "wiki" | "markdown",
    reason,
  };
}

function collectPacketSources(
  projectRoot: string,
  selectedPrdPath: string,
): {
  sources: PacketSource[];
  totalBytes: number;
  sourceVersion: string;
  unresolvedReferences: CccPrdFreezeUnresolvedReference[];
} {
  const index = buildMarkdownIndex(projectRoot);
  const selectedRelativePath = toPosix(relative(projectRoot, selectedPrdPath));
  const selected = index.files.find((file) => file.path === selectedPrdPath);
  if (!selected) {
    return refuse(
      "CCC_PRD_INTAKE_SOURCE_INVALID",
      `selected PRD is not an admitted current Markdown file: ${selectedRelativePath}`,
    );
  }
  const selectedAdmissionBytes = readSafeMarkdown(
    projectRoot,
    selected.path,
    "selected PRD",
    MAX_PACKET_BYTES,
  );
  if (!candidateFromMarkdown(selected, selectedAdmissionBytes)) {
    return refuse(
      "CCC_PRD_INTAKE_SOURCE_INVALID",
      `selected Markdown file is not a current PRD candidate: ${selectedRelativePath}`,
    );
  }

  const queued = new Map<string, { source: IndexedMarkdown; authoritative: boolean }>();
  const queue: IndexedMarkdown[] = [];
  const enqueue = (source: IndexedMarkdown, authoritative: boolean): void => {
    const existing = queued.get(source.path);
    if (existing) {
      existing.authoritative ||= authoritative;
      return;
    }
    if (queued.size >= MAX_PACKET_FILES) {
      return refuse(
        "CCC_PRD_INTAKE_FILE_LIMIT",
        `packet exceeds ${MAX_PACKET_FILES} unique Markdown files`,
      );
    }
    queued.set(source.path, { source, authoritative });
    queue.push(source);
  };
  enqueue(selected, true);

  const bytesByPath = new Map<string, Buffer>();
  const unresolvedByIdentity = new Map<string, CccPrdFreezeUnresolvedReference>();
  let totalBytes = 0;
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const source = queue[cursor]!;
    const bytes = source.path === selected.path
      ? selectedAdmissionBytes
      : readSafeMarkdown(
        projectRoot,
        source.path,
        "packet source",
        MAX_PACKET_BYTES - totalBytes,
      );
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_PACKET_BYTES) {
      return refuse(
        "CCC_PRD_INTAKE_BYTE_LIMIT",
        `packet exceeds ${MAX_PACKET_BYTES} source bytes`,
      );
    }
    bytesByPath.set(source.path, bytes);
    const text = bytes.toString("utf8");
    const ranges = authorityRanges(text);
    const grouped = new Map<string, {
      reference: MarkdownReference;
      authoritative: boolean;
    }>();
    for (const reference of extractMarkdownReferences(text)) {
      const declared = ranges.some(([start, end]) =>
        reference.index >= start && reference.index < end);
      const key = `${reference.kind}\0${reference.target}`;
      const existing = grouped.get(key);
      if (existing) existing.authoritative ||= declared;
      else grouped.set(key, { reference, authoritative: declared });
    }
    for (const { reference, authoritative } of grouped.values()) {
      if (!authoritative && reference.kind === "bare") continue;
      const resolution = resolveMarkdownReference(projectRoot, source, reference, index);
      if (resolution.kind === "ignored") continue;
      if (resolution.kind !== "matches" || resolution.matches.length !== 1) {
        if (authoritative) {
          unresolvedReferenceError(reference, source, resolution, true);
        }
        const unresolved = unresolvedReference(reference, source, resolution);
        const identity = canonicalCccPrdJson(unresolved);
        if (!unresolvedByIdentity.has(identity)) {
          if (unresolvedByIdentity.size >= MAX_UNRESOLVED_REFERENCES) {
            return refuse(
              "CCC_PRD_INTAKE_REFERENCE_LIMIT",
              `packet exceeds ${MAX_UNRESOLVED_REFERENCES} unresolved Markdown references`,
            );
          }
          unresolvedByIdentity.set(identity, unresolved);
        }
        continue;
      }
      enqueue(resolution.matches[0]!, authoritative);
    }
  }

  const selectedBytes = bytesByPath.get(selectedPrdPath)!;
  const selectedText = selectedBytes.toString("utf8");
  const selectedFrontmatter = parseFrontmatter(selectedText);
  const semver = parseSemver(
    selectedFrontmatter.get("version"),
    selectedFrontmatter.get("prd_version"),
    basename(selectedPrdPath),
    selectedText.slice(0, 4_096),
  );
  const sources = [...queued.values()]
    .map(({ source, authoritative }): PacketSource => {
      const bytes = bytesByPath.get(source.path)!;
      return {
        ...source,
        bytes,
        authoritative,
        role: inferRole(source, selectedPrdPath, authoritative, bytes.toString("utf8")),
      };
    })
    .sort((left, right) =>
      compareCccPrdCodeUnits(left.projectRelativePath, right.projectRelativePath));
  return {
    sources,
    totalBytes,
    sourceVersion: semver ? `v${semver.join(".")}` : "unversioned",
    unresolvedReferences: [...unresolvedByIdentity.values()],
  };
}

function validateOutputPath(activeProjectsRoot: string, outputDir: string): string {
  const output = resolve(outputDir);
  if (isWithin(activeProjectsRoot, output)) {
    return refuse(
      "CCC_PRD_INTAKE_OUTPUT_INSIDE_SOURCE",
      `freeze output must be outside the active-projects root: ${output}`,
    );
  }
  if (lstatOrNull(output)) {
    return refuse("CCC_PRD_INTAKE_OUTPUT_EXISTS", `freeze output already exists: ${output}`);
  }

  let existing = dirname(output);
  while (!lstatOrNull(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  const stat = lstatSync(existing);
  if (stat.isSymbolicLink()) {
    return refuse(
      "CCC_PRD_INTAKE_SYMLINK",
      `freeze output parent must not be a symlink: ${existing}`,
    );
  }
  const canonicalExisting = realpathSync(existing);
  const projectedOutput = resolve(canonicalExisting, relative(existing, output));
  if (isWithin(realpathSync(activeProjectsRoot), projectedOutput)) {
    return refuse(
      "CCC_PRD_INTAKE_OUTPUT_INSIDE_SOURCE",
      `freeze output resolves inside the active-projects root: ${output}`,
    );
  }
  return output;
}

function createOutputParent(outputDir: string): string[] {
  const missing: string[] = [];
  let cursor = dirname(outputDir);
  while (!lstatOrNull(cursor)) {
    missing.push(cursor);
    cursor = dirname(cursor);
  }
  const created: string[] = [];
  for (const path of missing.reverse()) {
    mkdirSync(path);
    created.push(path);
  }
  return created;
}

function cleanupCreatedParents(paths: string[]): void {
  for (const path of [...paths].reverse()) {
    try {
      rmdirSync(path);
    } catch {
      return;
    }
  }
}

export function freezeCccPrdPacket(input: {
  activeProjectsRoot: string;
  selectedPrdPath: string;
  outputDir: string;
}): CccPrdFreezeResult {
  const activeProjectsRoot = canonicalDirectory(
    input.activeProjectsRoot,
    "active-projects root",
  );
  const selectedLexical = resolve(
    isAbsolute(input.selectedPrdPath)
      ? input.selectedPrdPath
      : join(activeProjectsRoot, input.selectedPrdPath),
  );
  assertSafePathBelow(activeProjectsRoot, selectedLexical, "selected PRD");
  if (extname(selectedLexical).toLowerCase() !== ".md") {
    return refuse(
      "CCC_PRD_INTAKE_SOURCE_INVALID",
      `selected PRD must be Markdown: ${selectedLexical}`,
    );
  }
  const selectedCanonical = realpathSync(selectedLexical);
  if (!isWithin(realpathSync(activeProjectsRoot), selectedCanonical)) {
    return refuse(
      "CCC_PRD_INTAKE_PATH_ESCAPE",
      `selected PRD resolves outside the active-projects root: ${selectedLexical}`,
    );
  }
  const selectedPrdPath = selectedLexical;
  const selectedRelative = relative(activeProjectsRoot, selectedPrdPath);
  const segments = selectedRelative.split(sep).filter(Boolean);
  if (segments.length < 2) {
    return refuse(
      "CCC_PRD_INTAKE_PROJECT_INVALID",
      "root-level portfolio and process notes are context, not project PRDs; select a Markdown PRD inside one top-level active-project directory",
    );
  }
  const project = segments[0]!;
  if (segmentKind(project)) {
    return refuse(
      "CCC_PRD_INTAKE_PROJECT_INVALID",
      `selected PRD is inside a protected or archive-like project: ${project}`,
    );
  }
  const projectRoot = join(activeProjectsRoot, project);
  const outputDir = validateOutputPath(activeProjectsRoot, input.outputDir);

  let collected: ReturnType<typeof collectPacketSources>;
  try {
    collected = collectPacketSources(projectRoot, selectedPrdPath);
  } catch (error) {
    return asIntakeError(
      error,
      "CCC_PRD_FREEZE_FAILED",
      "CCC PRD packet traversal failed",
    );
  }

  const manifestEntries = collected.sources.map((source) => ({
    relative_path: `sources/${source.projectRelativePath}`,
    role: source.role,
    sha256: sha256(source.bytes),
    authoritative: source.authoritative,
  }));
  const manifest = {
    schema: CCC_PRD_PACKET_SCHEMA_VERSION,
    source_version: collected.sourceVersion,
    entries: manifestEntries,
  };
  const manifestBytes = Buffer.from(`${canonicalCccPrdJson(manifest)}\n`, "utf8");
  const manifestSha256 = sha256(manifestBytes);
  const authoritativeSources = collected.sources
    .filter((source) => source.authoritative)
    .map((source) => ({
      path: `sources/${source.projectRelativePath}`,
      role: source.role,
      authoritative: true as const,
      sha256: sha256(source.bytes),
      byteLength: source.bytes.byteLength,
    }));
  const packetHash = sha256(canonicalCccPrdJson({
    manifestSha256,
    sources: authoritativeSources,
  }));

  const manifestPath = join(outputDir, "manifest.json");
  const receiptPath = join(outputDir, "freeze-receipt.json");
  const receiptEntries: CccPrdFreezeReceiptEntry[] = collected.sources.map((source) => ({
    originPath: source.path,
    frozenPath: join(outputDir, "sources", ...source.projectRelativePath.split("/")),
    relativePath: `sources/${source.projectRelativePath}`,
    projectRelativePath: source.projectRelativePath,
    sha256: sha256(source.bytes),
    byteLength: source.bytes.byteLength,
    role: source.role,
    authoritative: source.authoritative,
  }));
  const receipt = {
    schema: FREEZE_RECEIPT_SCHEMA,
    activeProjectsRoot,
    project,
    projectRoot,
    selectedPrdPath,
    rootDir: outputDir,
    manifestPath,
    manifestSha256,
    packetHash,
    entries: receiptEntries,
    unresolvedReferences: collected.unresolvedReferences,
  };
  const receiptBytes = Buffer.from(`${canonicalCccPrdJson(receipt)}\n`, "utf8");
  const receiptSha256 = sha256(receiptBytes);
  const result: CccPrdFreezeResult = {
    schema: FREEZE_RESULT_SCHEMA,
    rootDir: outputDir,
    manifestPath,
    receiptPath,
    selectedPrdPath,
    packet: {
      schema: CCC_PRD_PACKET_SCHEMA_VERSION,
      sourceVersion: collected.sourceVersion,
      manifestSha256,
      packetHash,
      receiptSha256,
      fileCount: collected.sources.length,
      totalBytes: collected.totalBytes,
      unresolvedReferenceCount: collected.unresolvedReferences.length,
      project,
      selectedPrdPath,
    },
    unresolvedReferences: collected.unresolvedReferences,
  };

  let stageDir: string | null = null;
  let createdParents: string[] = [];
  try {
    createdParents = createOutputParent(outputDir);
    const outputParent = dirname(outputDir);
    stageDir = mkdtempSync(join(outputParent, `.${basename(outputDir)}.stage-`));
    for (const source of collected.sources) {
      const destination = join(
        stageDir,
        "sources",
        ...source.projectRelativePath.split("/"),
      );
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, source.bytes, { flag: "wx" });
    }
    writeFileSync(join(stageDir, "manifest.json"), manifestBytes, { flag: "wx" });
    writeFileSync(join(stageDir, "freeze-receipt.json"), receiptBytes, { flag: "wx" });
    if (lstatOrNull(outputDir)) {
      return refuse(
        "CCC_PRD_INTAKE_OUTPUT_EXISTS",
        `freeze output appeared before publication: ${outputDir}`,
      );
    }
    renameSync(stageDir, outputDir);
    stageDir = null;
    return result;
  } catch (error) {
    if (stageDir) rmSync(stageDir, { recursive: true, force: true });
    cleanupCreatedParents(createdParents);
    return asIntakeError(
      error,
      "CCC_PRD_INTAKE_WRITE_FAILED",
      "CCC PRD packet staging failed",
    );
  }
}
