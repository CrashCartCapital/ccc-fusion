import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import {
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  CCC_PRD_PACKET_SCHEMA_VERSION,
  canonicalCccPrdJson,
  compareCccPrdCodeUnits,
  type CccPrdManifestEntry,
  type CccPrdSource,
} from "@fusion/core";

type RawManifest = {
  schema?: unknown;
  source_version?: unknown;
  entries?: unknown;
};

type RawManifestEntry = {
  relative_path?: unknown;
  role?: unknown;
  sha256?: unknown;
  authoritative?: unknown;
};

export class CccPrdCustodyError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CccPrdCustodyError";
  }
}

export type CccPrdPacketCustody = {
  rootDir: string;
  manifestPath: string;
  manifestSha256: string;
  sourceVersion: string;
  entries: CccPrdManifestEntry[];
  sources: CccPrdSource[];
  sourceBytes: Map<string, Buffer>;
  packetHash: string;
};

const PROTECTED_SEGMENTS = new Set([".obsidian", "_KELSEY", "_secrets"]);
const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

function throws(code: string, message: string): never {
  throw new CccPrdCustodyError(code, message);
}

function isEscaping(path: string): boolean {
  return path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path);
}

export function containsProtectedCccPrdSegment(path: string): boolean {
  return path.split(/[\\/]+/).some((segment) => PROTECTED_SEGMENTS.has(segment));
}

/**
 * Resolve an existing file without following a symlink below the admitted root.
 * The root itself is canonicalized first so macOS /tmp -> /private/tmp aliases
 * do not create false refusals.
 */
export function resolveCccPrdAdmittedFile(
  rootDir: string,
  candidatePath: string,
  label: string,
): string {
  let root: string;
  try {
    root = realpathSync(rootDir);
  } catch {
    return throws("CCC_PRD_ROOT_READ_FAILED", `admitted root could not be resolved: ${rootDir}`);
  }
  if (!statSync(root).isDirectory()) {
    return throws("CCC_PRD_ROOT_READ_FAILED", `admitted root is not a directory: ${rootDir}`);
  }

  const lexicalRoot = resolve(rootDir);
  const lexicalCandidate = resolve(candidatePath);
  const lexicalRelative = relative(lexicalRoot, lexicalCandidate);
  if (containsProtectedCccPrdSegment(lexicalRelative) || containsProtectedCccPrdSegment(lexicalCandidate)) {
    return throws("CCC_PRD_PROTECTED_PATH", `${label} is protected and was not read: ${lexicalRelative}`);
  }

  // When the caller uses the same lexical root spelling, reject every symlink
  // below that root before resolving the file. If the absolute candidate uses
  // an OS alias for the root (Vitest redirection or macOS /tmp), canonical
  // containment below performs the authoritative check.
  if (!isEscaping(lexicalRelative)) {
    let cursor = lexicalRoot;
    for (const segment of lexicalRelative.split(sep).filter(Boolean)) {
      cursor = resolve(cursor, segment);
      let stat;
      try {
        stat = lstatSync(cursor);
      } catch {
        return throws("CCC_PRD_UNDECLARED_COMPANION", `${label} is absent: ${lexicalRelative}`);
      }
      if (stat.isSymbolicLink()) {
        return throws("CCC_PRD_PATH_ESCAPE", `${label} traverses a symlink: ${lexicalRelative}`);
      }
    }
  }

  let canonicalCandidate: string;
  try {
    canonicalCandidate = realpathSync(lexicalCandidate);
  } catch {
    return throws("CCC_PRD_UNDECLARED_COMPANION", `${label} is absent: ${lexicalRelative}`);
  }
  const canonicalRelative = relative(root, canonicalCandidate);
  if (isEscaping(canonicalRelative)) {
    return throws("CCC_PRD_PATH_ESCAPE", `${label} resolves outside the admitted root: ${lexicalRelative}`);
  }
  if (!statSync(canonicalCandidate).isFile()) {
    return throws("CCC_PRD_UNDECLARED_COMPANION", `${label} is not a file: ${lexicalRelative}`);
  }
  return canonicalCandidate;
}

function parseManifest(bytes: Buffer, manifestPath: string): {
  schema: string;
  sourceVersion: string;
  entries: CccPrdManifestEntry[];
} {
  let raw: RawManifest;
  try {
    raw = JSON.parse(bytes.toString("utf8")) as RawManifest;
  } catch {
    return throws("CCC_PRD_MANIFEST_READ_FAILED", `manifest is not valid JSON: ${manifestPath}`);
  }
  if (
    raw.schema !== CCC_PRD_PACKET_SCHEMA_VERSION
    && raw.schema !== "ccc-lab-super.source-custody.v1"
  ) {
    return throws("CCC_PRD_UNKNOWN_SCHEMA", `unknown packet manifest schema: ${String(raw.schema)}`);
  }
  if (typeof raw.source_version !== "string" || raw.source_version.length === 0) {
    return throws("CCC_PRD_MANIFEST_INVALID", "manifest source_version must be a non-empty string");
  }
  if (!Array.isArray(raw.entries) || raw.entries.length === 0) {
    return throws("CCC_PRD_MANIFEST_INVALID", "manifest entries must be a non-empty array");
  }

  const entries = raw.entries.map((value, index): CccPrdManifestEntry => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return throws("CCC_PRD_MANIFEST_INVALID", `manifest entry ${index} must be an object`);
    }
    const entry = value as RawManifestEntry;
    if (
      typeof entry.relative_path !== "string"
      || entry.relative_path.length === 0
      || typeof entry.role !== "string"
      || entry.role.length === 0
      || typeof entry.sha256 !== "string"
      || !/^[0-9a-f]{64}$/.test(entry.sha256)
      || typeof entry.authoritative !== "boolean"
    ) {
      return throws("CCC_PRD_MANIFEST_INVALID", `manifest entry ${index} is incomplete or malformed`);
    }
    return {
      relativePath: entry.relative_path,
      role: entry.role,
      sha256: entry.sha256,
      authoritative: entry.authoritative,
    };
  });

  const duplicate = entries.find(
    (entry, index) => entries.findIndex((candidate) => candidate.relativePath === entry.relativePath) !== index,
  );
  if (duplicate) {
    return throws("CCC_PRD_MANIFEST_INVALID", `manifest contains duplicate path: ${duplicate.relativePath}`);
  }
  return { schema: raw.schema, sourceVersion: raw.source_version, entries };
}

function resolveManifestEntryPath(rootDir: string, entry: CccPrdManifestEntry): string {
  if (isAbsolute(entry.relativePath)) {
    return throws("CCC_PRD_PATH_ESCAPE", `manifest entry must be relative: ${entry.relativePath}`);
  }
  const normalized = relative(resolve(rootDir), resolve(rootDir, entry.relativePath));
  if (isEscaping(normalized)) {
    return throws("CCC_PRD_PATH_ESCAPE", `manifest entry escapes the admitted root: ${entry.relativePath}`);
  }
  if (containsProtectedCccPrdSegment(normalized)) {
    return throws("CCC_PRD_PROTECTED_PATH", `manifest entry is protected and was not read: ${entry.relativePath}`);
  }
  return resolve(rootDir, entry.relativePath);
}

export function readCccPrdPacketCustody(input: {
  rootDir: string;
  manifestPath: string;
}): CccPrdPacketCustody {
  const rootDir = realpathSync(input.rootDir);
  const manifestPath = resolveCccPrdAdmittedFile(rootDir, input.manifestPath, "manifest");
  const manifestBytes = readFileSync(manifestPath);
  const parsed = parseManifest(manifestBytes, manifestPath);
  const sourceBytes = new Map<string, Buffer>();
  const sources: CccPrdSource[] = [];

  for (const entry of parsed.entries) {
    const entryPath = resolveManifestEntryPath(rootDir, entry);
    if (!entry.authoritative) {
      // Support rows are custody declarations, not semantic authority. They may
      // intentionally be absent from a reduced packet. If present, they still
      // must pass the exact same path and raw-hash custody checks.
      try {
        const admitted = resolveCccPrdAdmittedFile(rootDir, entryPath, "support source");
        const bytes = readFileSync(admitted);
        if (sha256(bytes) !== entry.sha256) {
          return throws("CCC_PRD_SOURCE_HASH_MISMATCH", `support source hash changed: ${entry.relativePath}`);
        }
      } catch (error) {
        if (error instanceof CccPrdCustodyError && error.code === "CCC_PRD_UNDECLARED_COMPANION") {
          continue;
        }
        throw error;
      }
      continue;
    }

    const admitted = resolveCccPrdAdmittedFile(rootDir, entryPath, "authoritative source");
    const bytes = readFileSync(admitted);
    const actual = sha256(bytes);
    if (actual !== entry.sha256) {
      return throws("CCC_PRD_SOURCE_HASH_MISMATCH", `authoritative source hash changed: ${entry.relativePath}`);
    }
    sourceBytes.set(entry.relativePath, bytes);
    sources.push({
      path: entry.relativePath,
      role: entry.role,
      authoritative: true,
      sha256: actual,
      byteLength: bytes.byteLength,
    });
  }

  if (sources.length === 0) {
    return throws("CCC_PRD_MANIFEST_INVALID", "packet has no authoritative sources");
  }
  const packetHash = sha256(canonicalCccPrdJson({
    manifestSha256: sha256(manifestBytes),
    sources,
  }));
  return {
    rootDir,
    manifestPath,
    manifestSha256: sha256(manifestBytes),
    sourceVersion: parsed.sourceVersion,
    entries: parsed.entries,
    sources,
    sourceBytes,
    packetHash,
  };
}

export function sortCccPrdById<T extends { id: string }>(values: T[]): T[] {
  return [...values].sort((left, right) => compareCccPrdCodeUnits(left.id, right.id));
}

/**
 * Character budget for the quote excerpt carried in a quote-rejection
 * message. Quote-rejection messages are fed back into the next authoring
 * attempt's prompt, which enforces a hard maxPromptBytes ceiling, so the
 * excerpt is bounded rather than unbounded. 200 characters covers a full
 * sentence -- the quote length the prompt asks for -- and renders to roughly
 * 210 bytes for the ASCII quotes these documents actually produce.
 */
export const CCC_PRD_QUOTE_EXCERPT_CHARS = 200;

/**
 * Renders a model-supplied quote for a rejection message.
 *
 * The quote is JSON-escaped so whitespace, newlines, and invisible or
 * non-ASCII characters stay visible to whoever (or whatever) reads the
 * message -- a near-miss quote differing by one non-breaking space is
 * indistinguishable from an exact match otherwise. The untruncated byte
 * length is always reported, so a truncated excerpt still says how much was
 * withheld and byte-level differences remain diagnosable.
 *
 * Truncation is applied to the raw quote rather than to the escaped output,
 * which keeps the rendered form a well-formed JSON string instead of one cut
 * through the middle of an escape sequence.
 */
export function describeCccPrdQuoteForRejection(quote: string): string {
  const byteLength = Buffer.byteLength(quote, "utf8");
  const truncated = quote.length > CCC_PRD_QUOTE_EXCERPT_CHARS;
  const excerpt = truncated ? quote.slice(0, CCC_PRD_QUOTE_EXCERPT_CHARS) : quote;
  return `${JSON.stringify(excerpt)}${truncated ? " [truncated]" : ""} (${byteLength} bytes)`;
}
