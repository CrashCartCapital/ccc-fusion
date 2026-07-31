import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { canonicalCccPrdJson } from "./contract.js";
import { CccPrdImportError } from "./import-error.js";
import type {
  CccPrdImportEntityType,
  CccPrdSemanticBundle,
} from "./types.js";

export const CCC_PRD_IMPORT_WRITER_CLASSES = [
  "campaign",
  "task",
  "dependency_edge",
  "workflow",
  "document",
  "artifact",
  "source",
  "work_item",
  "run_audit",
] as const satisfies readonly CccPrdImportEntityType[];

const ENTITY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;

function normalizeRoot(path: string): string {
  return resolve(path);
}

function isContainedPath(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === ""
    || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function bundleIdentity(bundle: CccPrdSemanticBundle): string {
  const { bundleHash: _declared, ...withoutHash } = bundle;
  return createHash("sha256")
    .update(canonicalCccPrdJson(withoutHash))
    .digest("hex");
}

function assertSafeEntityId(id: string, label: string): void {
  if (!ENTITY_ID_PATTERN.test(id)) {
    throw new CccPrdImportError(
      "CCC_PRD_IMPORT_INVALID_BUNDLE",
      `${label} has an unsafe identifier: ${JSON.stringify(id)}`,
    );
  }
}

export function assertCccPrdImportBundle(
  bundle: CccPrdSemanticBundle,
  rootDir: string,
  idempotencyKey: string,
): void {
  if (!idempotencyKey.trim() || idempotencyKey.length > 256) {
    throw new CccPrdImportError(
      "CCC_PRD_IMPORT_USAGE",
      "CCC PRD import idempotencyKey must contain 1-256 characters",
    );
  }
  if (bundle.kind !== "bundle" || bundle.schema !== "ccc-prd.bundle.v1") {
    throw new CccPrdImportError(
      "CCC_PRD_IMPORT_INVALID_BUNDLE",
      "CCC PRD import requires a v1 semantic bundle",
    );
  }
  const identityHash = bundleIdentity(bundle);
  if (identityHash !== bundle.bundleHash) {
    throw new CccPrdImportError(
      "CCC_PRD_IMPORT_INVALID_BUNDLE",
      `CCC PRD bundle hash mismatch: declared ${bundle.bundleHash}, calculated ${identityHash}`,
    );
  }
  if (bundle.provenance.packetHash !== bundle.sourceHash) {
    throw new CccPrdImportError(
      "CCC_PRD_IMPORT_INVALID_BUNDLE",
      "CCC PRD packet provenance does not match sourceHash",
    );
  }
  if (normalizeRoot(rootDir) !== normalizeRoot(bundle.targetRepository.path)) {
    throw new CccPrdImportError(
      "CCC_PRD_IMPORT_ROOT_MISMATCH",
      "CCC PRD import rootDir must exactly match bundle.targetRepository.path",
    );
  }
  if (
    !Number.isSafeInteger(bundle.bounds.maxRequests)
    || !Number.isSafeInteger(bundle.bounds.maxDurationMs)
    || !Number.isSafeInteger(bundle.bounds.maxConcurrency)
    || bundle.bounds.maxRequests < 1
    || bundle.bounds.maxDurationMs < 1
    || bundle.bounds.maxConcurrency < 1
    || bundle.bounds.maxRequests > 10_000
    || bundle.bounds.maxDurationMs > 86_400_000
    || bundle.bounds.maxConcurrency > 256
  ) {
    throw new CccPrdImportError(
      "CCC_PRD_IMPORT_INVALID_BUNDLE",
      "CCC PRD import bounds must be finite positive integers within local admission ceilings",
    );
  }
  const root = normalizeRoot(rootDir);
  const admitted = bundle.admittedWriteRoots.map(({ path }) => normalizeRoot(path));
  for (const output of [join(root, ".fusion", "tasks"), join(root, ".fusion", "artifacts")]) {
    if (!admitted.some((candidate) => isContainedPath(candidate, output))) {
      throw new CccPrdImportError(
        "CCC_PRD_IMPORT_WRITE_ROOT_REFUSED",
        `CCC PRD output is outside admitted write roots: ${output}`,
      );
    }
  }
  const allIds = [
    ...bundle.tasks.map(({ id }) => ["task", id] as const),
    ...bundle.edges.map(({ id }) => ["dependency edge", id] as const),
    ...bundle.workflows.map(({ id }) => ["workflow", id] as const),
    ...bundle.documents.map(({ id }) => ["document", id] as const),
    ...bundle.artifacts.map(({ id }) => ["artifact", id] as const),
    ...bundle.importIntents.flatMap(({ id, entityType, entityId }) => [
      ["import intent", id] as const,
      [`${entityType} entity`, entityId] as const,
    ]),
  ];
  for (const [label, id] of allIds) assertSafeEntityId(id, label);
  const optionalEmptyWriterClasses = new Set<CccPrdImportEntityType>([
    ...(bundle.edges.length === 0 ? ["dependency_edge" as const] : []),
    ...(bundle.documents.length === 0 ? ["document" as const] : []),
    ...(bundle.artifacts.length === 0 ? ["artifact" as const] : []),
  ]);
  for (const type of CCC_PRD_IMPORT_WRITER_CLASSES) {
    if (optionalEmptyWriterClasses.has(type)) continue;
    if (!bundle.importIntents.some((intent) => intent.entityType === type)) {
      throw new CccPrdImportError(
        "CCC_PRD_IMPORT_INVALID_BUNDLE",
        `CCC PRD bundle has no ${type} import intent`,
      );
    }
  }
}

export async function physicalCccPrdImportRoot(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    throw new CccPrdImportError(
      "CCC_PRD_IMPORT_ROOT_MISMATCH",
      `CCC PRD import root is unavailable: ${normalizeRoot(path)}`,
    );
  }
}
