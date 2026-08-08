import { createHash } from "node:crypto";
import type {
  CccPrdDiagnostic,
  CccPrdOperatorDecision,
  CccPrdProof,
  CccPrdProtectedActionIntent,
  CccPrdProtectedActionKind,
  CccPrdRefusalBundle,
  CccPrdSemanticBundle,
  CccPrdSourceSpan,
} from "./types.js";

const decisions: Record<CccPrdProtectedActionKind, CccPrdOperatorDecision> = {
  promotion: "approve_promotion",
  live_execution: "approve_live_execution",
  deletion: "approve_deletion",
  merge: "approve_merge",
  publication: "approve_publication",
  credential: "approve_credential_use",
  billing: "approve_billing",
  upstream_write: "approve_upstream_write",
};

/**
 * The legal protected-action kinds, derived from `decisions` so the two cannot
 * drift. Every one of them names an action an operator must approve because it
 * is irreversible, outward-facing, or spends money or authority -- which is
 * why ordinary work such as creating a file has no entry here and should not
 * acquire one.
 */
export const CCC_PRD_PROTECTED_ACTION_KINDS: readonly CccPrdProtectedActionKind[] =
  Object.keys(decisions) as CccPrdProtectedActionKind[];

export function compareCccPrdCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value: unknown, seen: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("CCC PRD canonical JSON numbers must be finite");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error("CCC PRD canonical JSON must not contain cycles");
    seen.add(value);
    const result = `[${value.map((entry) => canonicalJson(entry, seen)).join(",")}]`;
    seen.delete(value);
    return result;
  }
  if (typeof value === "object") {
    const object = value as object;
    if (seen.has(object)) throw new Error("CCC PRD canonical JSON must not contain cycles");
    const prototype = Object.getPrototypeOf(object);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("CCC PRD canonical JSON values must be plain objects");
    }
    seen.add(object);
    const result = `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareCccPrdCodeUnits(left, right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry, seen)}`)
      .join(",")}}`;
    seen.delete(object);
    return result;
  }
  throw new Error("CCC PRD canonical JSON values must be JSON-compatible");
}

export function canonicalCccPrdJson(value: unknown): string {
  return canonicalJson(value, new Set<object>());
}

function sha256CanonicalCccPrdJson(value: unknown): string {
  return createHash("sha256")
    .update(canonicalCccPrdJson(value), "utf8")
    .digest("hex");
}

export function computeCccPrdProofDefinitionSha256(proof: CccPrdProof): string {
  return sha256CanonicalCccPrdJson({
    id: proof.id,
    requirementIds: proof.requirementIds,
    command: proof.command,
    positiveOracle: proof.positiveOracle,
    negativeControls: proof.negativeControls,
    spans: proof.spans,
    confidence: proof.confidence,
  });
}

export type CccPrdSemanticBundleHashInput = Omit<CccPrdSemanticBundle, "bundleHash">;

export function projectCccPrdSemanticBundleForHash(
  bundle: CccPrdSemanticBundle | CccPrdSemanticBundleHashInput,
): CccPrdSemanticBundleHashInput {
  return {
    kind: bundle.kind,
    schema: bundle.schema,
    sourceHash: bundle.sourceHash,
    sidecarHash: bundle.sidecarHash,
    sourceVersion: bundle.sourceVersion,
    orderedSources: bundle.orderedSources,
    provenance: bundle.provenance,
    authorityRoles: bundle.authorityRoles,
    requirements: bundle.requirements,
    proofs: bundle.proofs,
    tasks: bundle.tasks,
    edges: bundle.edges,
    workflows: bundle.workflows,
    documents: bundle.documents,
    artifacts: bundle.artifacts,
    importIntents: bundle.importIntents,
    protectedActions: bundle.protectedActions,
    bounds: bundle.bounds,
    admittedWriteRoots: bundle.admittedWriteRoots,
    targetRepository: bundle.targetRepository,
    nonGoals: bundle.nonGoals,
    ...(bundle.materialCoverage ? { materialCoverage: bundle.materialCoverage } : {}),
    ...(bundle.implementationFactProvenance ? { implementationFactProvenance: bundle.implementationFactProvenance } : {}),
    confidence: bundle.confidence,
  };
}

export function computeCccPrdSemanticBundleSha256(
  bundle: CccPrdSemanticBundle | CccPrdSemanticBundleHashInput,
): string {
  return sha256CanonicalCccPrdJson(projectCccPrdSemanticBundleForHash(bundle));
}

function displayPosition(prefix: Buffer): { line: number; column: number } {
  const decoded = prefix.toString("utf8");
  const lines = decoded.split("\n");
  return {
    line: lines.length,
    column: Array.from(lines.at(-1) ?? "").length + 1,
  };
}

export function createCccPrdSpanFromBytes(
  sourcePath: string,
  source: Buffer,
  byteStart: number,
  byteEnd: number,
): CccPrdSourceSpan {
  if (
    !Number.isSafeInteger(byteStart)
    || !Number.isSafeInteger(byteEnd)
    || byteStart < 0
    || byteEnd < byteStart
    || byteEnd > source.byteLength
  ) {
    throw new Error(`invalid CCC PRD byte span for ${sourcePath}`);
  }
  const start = displayPosition(source.subarray(0, byteStart));
  const end = displayPosition(source.subarray(0, byteEnd));
  return {
    path: sourcePath,
    byteStart,
    byteEnd,
    line: start.line,
    column: start.column,
    endLine: end.line,
    endColumn: end.column,
    sha256: createHash("sha256").update(source).digest("hex"),
  };
}

export function normalizeProtectedAction(input: {
  id?: string;
  kind: string;
  target: string;
  spans?: CccPrdSourceSpan[];
}): CccPrdProtectedActionIntent {
  const operatorDecision = decisions[input.kind as CccPrdProtectedActionKind];
  if (!operatorDecision) {
    // Naming only the bad kind leaves a caller (or a model being asked to
    // retry) with nothing to correct against, so carry the legal set too.
    throw new Error(
      `unknown protected action kind: ${input.kind}; allowed kinds are `
        + CCC_PRD_PROTECTED_ACTION_KINDS.join(", "),
    );
  }
  return {
    id: input.id ?? `protected-action:${input.kind}:${input.target}`,
    kind: input.kind as CccPrdProtectedActionKind,
    target: input.target,
    operatorDecision,
    requiresOperatorDecision: true,
    spans: input.spans ?? [],
  };
}

export function createRefusalBundle(
  input: Omit<CccPrdDiagnostic, "span"> & { source?: CccPrdSourceSpan },
): CccPrdRefusalBundle {
  const { source, ...diagnostic } = input;
  return {
    kind: "refusal",
    diagnostics: [{ ...diagnostic, ...(source ? { span: source } : {}) }],
  };
}
