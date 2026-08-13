import {
  canonicalCccPrdJson,
  projectCccPrdProofV2DefinitionForHash,
  type CccPrdAdmittedWriteRoot,
  type CccPrdArtifact,
  type CccPrdAuthorityRole,
  type CccPrdConfidence,
  type CccPrdDependencyEdge,
  type CccPrdDocument,
  type CccPrdExecutionBounds,
  type CccPrdImportIntent,
  type CccPrdMaterialCoverageItem,
  type CccPrdProof,
  type CccPrdProofV2,
  type CccPrdProtectedActionIntent,
  type CccPrdRequirement,
  type CccPrdRequirementV2,
  type CccPrdSemanticProofContractVersion,
  type CccPrdReviewItem,
  type CccPrdSourceSpan,
  type CccPrdTargetRepository,
  type CccPrdTask,
  type CccPrdUnresolvedDecision,
  type CccPrdWorkflow,
} from "@fusion/core";
import { compareSourceSpans } from "./authoring.js";
import { CccPrdCustodyError, sortCccPrdById } from "./custody.js";
import { analyzeCccPrdMaterialCoverage } from "./material-coverage.js";
import type { CccPrdResolvedChunkFragment } from "./chunk-verification.js";
import { assertCccPrdAcceptanceClauseCustody } from "./acceptance-clauses.js";

type IdRow = { id: string; spans?: CccPrdSourceSpan[] };

type Occurrence<T> = { chunkOrdinal: number; row: T };

function comparablePayload(row: Record<string, unknown>): Record<string, unknown> {
  const { spans, materialItemIds, ...rest } = row;
  return rest;
}

function firstDifferingField(left: Record<string, unknown>, right: Record<string, unknown>): string | undefined {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (canonicalCccPrdJson(left[key] ?? null) !== canonicalCccPrdJson(right[key] ?? null)) return key;
  }
  return undefined;
}

function mergeSpans(spans: CccPrdSourceSpan[]): CccPrdSourceSpan[] {
  const seen = new Map<string, CccPrdSourceSpan>();
  for (const span of spans) {
    const key = `${span.path}\0${span.byteStart}\0${span.byteEnd}`;
    if (!seen.has(key)) seen.set(key, span);
  }
  return [...seen.values()].sort(compareSourceSpans);
}

/**
 * Groups occurrences of a row by ID (design §4 "Identity"): equal-payload
 * duplicates from independent chunks merge and union their spans; any
 * contradictory scalar payload for the same ID refuses. IDs are NEVER
 * rewritten -- there is no chunk-ordinal prefix anywhere in the output.
 */
function mergeCollection<T extends IdRow>(
  occurrences: Array<Occurrence<T>>,
  collectionName: string,
): T[] {
  const byId = new Map<string, Array<Occurrence<T>>>();
  for (const occurrence of occurrences) {
    const list = byId.get(occurrence.row.id) ?? [];
    list.push(occurrence);
    byId.set(occurrence.row.id, list);
  }

  const merged: T[] = [];
  for (const group of byId.values()) {
    const first = group[0]!;
    for (const other of group.slice(1)) {
      const differingField = firstDifferingField(
        comparablePayload(first.row as Record<string, unknown>),
        comparablePayload(other.row as Record<string, unknown>),
      );
      if (differingField) {
        throw new CccPrdCustodyError(
          "CCC_PRD_ASSEMBLY_ID_COLLISION",
          `${collectionName} ${first.row.id} has contradictory "${differingField}" between chunk `
            + `${first.chunkOrdinal} and chunk ${other.chunkOrdinal}`,
        );
      }
    }
    const allSpans = group.flatMap((entry) => entry.row.spans ?? []);
    merged.push({ ...first.row, ...(first.row.spans ? { spans: mergeSpans(allSpans) } : {}) });
  }
  return merged;
}

function mergeV2Requirements(
  occurrences: Array<Occurrence<CccPrdRequirementV2>>,
): CccPrdRequirementV2[] {
  const byId = new Map<string, Array<Occurrence<CccPrdRequirementV2>>>();
  for (const occurrence of occurrences) {
    const rows = byId.get(occurrence.row.id) ?? [];
    rows.push(occurrence);
    byId.set(occurrence.row.id, rows);
  }
  return [...byId.values()].map((group) => {
    const first = group[0]!;
    const base = (row: CccPrdRequirementV2) => {
      const {
        spans,
        dependencies,
        proofIds,
        acceptanceClauses,
        acceptanceDispositions,
        ...rest
      } = row;
      return rest;
    };
    for (const other of group.slice(1)) {
      const differingField = firstDifferingField(base(first.row), base(other.row));
      if (differingField) {
        throw new CccPrdCustodyError(
          "CCC_PRD_ASSEMBLY_ID_COLLISION",
          `requirement ${first.row.id} has contradictory "${differingField}" between chunk `
            + `${first.chunkOrdinal} and chunk ${other.chunkOrdinal}`,
        );
      }
    }
    const mergeNested = <T extends Record<string, unknown>>(
      rows: T[],
      key: keyof T,
      label: string,
    ): T[] => {
      const indexed = new Map<string, T>();
      for (const row of rows) {
        const id = String(row[key]);
        const prior = indexed.get(id);
        if (prior && canonicalCccPrdJson(prior) !== canonicalCccPrdJson(row)) {
          throw new CccPrdCustodyError(
            "CCC_PRD_ASSEMBLY_ID_COLLISION",
            `${label} ${id} has contradictory source custody or linkage across chunks`,
          );
        }
        indexed.set(id, prior ?? row);
      }
      return [...indexed.values()].sort((left, right) => (
        String(left[key]) < String(right[key]) ? -1 : String(left[key]) > String(right[key]) ? 1 : 0
      ));
    };
    return {
      ...first.row,
      dependencies: [...new Set(group.flatMap(({ row }) => row.dependencies))].sort(),
      proofIds: [...new Set(group.flatMap(({ row }) => row.proofIds))].sort(),
      spans: mergeSpans(group.flatMap(({ row }) => row.spans)),
      acceptanceClauses: mergeNested(
        group.flatMap(({ row }) => row.acceptanceClauses),
        "id",
        "acceptance clause",
      ),
      acceptanceDispositions: mergeNested(
        group.flatMap(({ row }) => row.acceptanceDispositions),
        "clauseId",
        "acceptance disposition",
      ),
    };
  });
}

function mergeV2Proofs(occurrences: Array<Occurrence<CccPrdProofV2>>): CccPrdProofV2[] {
  const byId = new Map<string, Array<Occurrence<CccPrdProofV2>>>();
  for (const occurrence of occurrences) {
    const rows = byId.get(occurrence.row.id) ?? [];
    rows.push(occurrence);
    byId.set(occurrence.row.id, rows);
  }
  return [...byId.values()].map((group) => {
    const first = group[0]!;
    const base = (row: CccPrdProofV2) => {
      const projected = projectCccPrdProofV2DefinitionForHash(row);
      const { spans, requirementIds, clauseIds, ...rest } = projected;
      return rest;
    };
    for (const other of group.slice(1)) {
      const differingField = firstDifferingField(base(first.row), base(other.row));
      if (differingField) {
        throw new CccPrdCustodyError(
          "CCC_PRD_ASSEMBLY_ID_COLLISION",
          `proof ${first.row.id} has contradictory "${differingField}" between chunk `
            + `${first.chunkOrdinal} and chunk ${other.chunkOrdinal}`,
        );
      }
    }
    const unique = (values: string[]) => [...new Set(values)].sort();
    const canonical = projectCccPrdProofV2DefinitionForHash(first.row);
    return {
      ...first.row,
      requirementIds: unique(group.flatMap(({ row }) => row.requirementIds)),
      clauseIds: unique(group.flatMap(({ row }) => row.clauseIds)),
      phases: canonical.phases as CccPrdProofV2["phases"],
      positiveCases: canonical.positiveCases,
      negativeControls: canonical.negativeControls,
      verifierClosure: canonical.verifierClosure,
      candidateInputs: canonical.candidateInputs,
      spans: mergeSpans(group.flatMap(({ row }) => row.spans)),
    };
  });
}

function referencedIds(fields: unknown[]): string[] {
  return fields.flatMap((field) => {
    if (typeof field === "string") return field.length > 0 ? [field] : [];
    if (Array.isArray(field)) return field.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
    return [];
  });
}

export type CccPrdChunkAssemblyInput = {
  packetSourceBytes: Map<string, Buffer>;
  semanticProofContract?: CccPrdSemanticProofContractVersion;
  fragments: Array<{ chunkOrdinal: number; resolved: CccPrdResolvedChunkFragment }>;
};

export type CccPrdAssembledUnderstanding = {
  authorityRoles: CccPrdAuthorityRole[];
  requirements: CccPrdRequirement[];
  proofs: CccPrdProof[];
  tasks: CccPrdTask[];
  edges: CccPrdDependencyEdge[];
  workflows: CccPrdWorkflow[];
  documents: CccPrdDocument[];
  artifacts: CccPrdArtifact[];
  importIntents: CccPrdImportIntent[];
  protectedActions: CccPrdProtectedActionIntent[];
  targetRepository: CccPrdTargetRepository;
  bounds: CccPrdExecutionBounds;
  admittedWriteRoots: CccPrdAdmittedWriteRoot[];
  nonGoals: string[];
  unresolvedDecisions: CccPrdUnresolvedDecision[];
  ambiguities: CccPrdReviewItem[];
  exceptions: CccPrdReviewItem[];
  confidence: CccPrdConfidence;
  materialCoverage: CccPrdMaterialCoverageItem[];
};

function collect<T extends IdRow>(
  fragments: CccPrdChunkAssemblyInput["fragments"],
  pick: (resolved: CccPrdResolvedChunkFragment) => T[],
): Array<Occurrence<T>> {
  return fragments.flatMap(({ chunkOrdinal, resolved }) => (
    pick(resolved).map((row) => ({ chunkOrdinal, row }))
  ));
}

/**
 * Assembles the chunked understanding review (design §4). Order-independent
 * by construction: rows are grouped by ID (a plain Map keyed on the model's
 * own IDs, never on arrival order) and every collection is sorted by ID
 * before being returned, so the same fragment set in any arrival order
 * canonicalizes to byte-identical JSON (test 38).
 *
 * This function never calls resolveSourceRefs/mapProposal -- fragments
 * arrive with spans already resolved by the chunked lane's own resolver
 * (design §5 "the chunked lane replaces resolveSourceRefs"), so a
 * slice-disambiguated quote that occurs more than once file-wide survives
 * assembly instead of being refused a second time (test 38a).
 */
export function assembleCccPrdChunkedUnderstanding(
  input: CccPrdChunkAssemblyInput,
): CccPrdAssembledUnderstanding {
  const semanticV2 = input.semanticProofContract === "v2";
  const requirementOccurrences = collect(input.fragments, (r) => r.requirements);
  const proofOccurrences = collect(input.fragments, (r) => r.proofs);
  const requirements: CccPrdRequirement[] = semanticV2
    ? sortCccPrdById(mergeV2Requirements(
        requirementOccurrences as Array<Occurrence<CccPrdRequirementV2>>,
      ))
    : sortCccPrdById(mergeCollection(requirementOccurrences, "requirement"));
  const proofs: CccPrdProof[] = semanticV2
    ? sortCccPrdById(mergeV2Proofs(proofOccurrences as Array<Occurrence<CccPrdProofV2>>))
    : sortCccPrdById(mergeCollection(proofOccurrences, "proof"));
  const tasks = sortCccPrdById(mergeCollection(collect(input.fragments, (r) => r.tasks), "task"));
  const workflows = sortCccPrdById(mergeCollection(collect(input.fragments, (r) => r.workflows), "workflow"));
  const documents = sortCccPrdById(mergeCollection(collect(input.fragments, (r) => r.documents), "document"));
  const artifacts = sortCccPrdById(mergeCollection(collect(input.fragments, (r) => r.artifacts), "artifact"));
  const protectedActions = sortCccPrdById(
    mergeCollection(collect(input.fragments, (r) => r.protectedActions), "protectedAction"),
  );
  const unresolvedDecisions = sortCccPrdById(
    mergeCollection(collect(input.fragments, (r) => r.unresolvedDecisions), "unresolvedDecision"),
  );
  const ambiguities = sortCccPrdById(mergeCollection(collect(input.fragments, (r) => r.ambiguities), "ambiguity"));
  const exceptions = sortCccPrdById(mergeCollection(collect(input.fragments, (r) => r.exceptions), "exception"));
  const authorityRoles = sortCccPrdById(
    mergeCollection(collect(input.fragments, (r) => r.authorityRoles), "authorityRole"),
  );
  const edges = sortCccPrdById(mergeCollection(collect(input.fragments, (r) => r.edges), "edge"));
  const importIntents = sortCccPrdById(
    mergeCollection(collect(input.fragments, (r) => r.importIntents), "importIntent"),
  );

  // Dangling-reference check runs against the FINAL merged ID registries,
  // built above -- never against any single fragment's partial view. A
  // reference to a row that existed as a duplicate across two chunks (now
  // merged into one canonical row) must resolve; only a reference that
  // resolves to no surviving row anywhere is dangling (design §4).
  const knownIds = {
    requirements: new Set(requirements.map((row) => row.id)),
    proofs: new Set(proofs.map((row) => row.id)),
    tasks: new Set(tasks.map((row) => row.id)),
    workflows: new Set(workflows.map((row) => row.id)),
    documents: new Set(documents.map((row) => row.id)),
    artifacts: new Set(artifacts.map((row) => row.id)),
    protectedActions: new Set(protectedActions.map((row) => row.id)),
  };

  const danglingChecks: Array<{ from: string; ids: string[]; registry: Set<string>; against: string }> = [];
  for (const task of tasks) {
    danglingChecks.push(
      { from: `task ${task.id}`, ids: referencedIds([task.requirementIds]), registry: knownIds.requirements, against: "requirement" },
      { from: `task ${task.id}`, ids: referencedIds([task.dependencyTaskIds]), registry: knownIds.tasks, against: "task" },
      { from: `task ${task.id}`, ids: referencedIds([task.proofIds]), registry: knownIds.proofs, against: "proof" },
      { from: `task ${task.id}`, ids: referencedIds([task.workflowId]), registry: knownIds.workflows, against: "workflow" },
      { from: `task ${task.id}`, ids: referencedIds([task.documentIds]), registry: knownIds.documents, against: "document" },
      { from: `task ${task.id}`, ids: referencedIds([task.artifactIds]), registry: knownIds.artifacts, against: "artifact" },
      { from: `task ${task.id}`, ids: referencedIds([task.protectedActionIds]), registry: knownIds.protectedActions, against: "protectedAction" },
    );
  }
  for (const edge of edges) {
    danglingChecks.push(
      { from: `edge ${edge.id}`, ids: referencedIds([edge.fromTaskId, edge.toTaskId]), registry: knownIds.tasks, against: "task" },
    );
  }
  for (const workflow of workflows) {
    danglingChecks.push(
      { from: `workflow ${workflow.id}`, ids: referencedIds([workflow.taskIds, workflow.entryTaskIds, workflow.terminalTaskIds]), registry: knownIds.tasks, against: "task" },
    );
  }
  for (const proof of proofs) {
    danglingChecks.push(
      { from: `proof ${proof.id}`, ids: referencedIds([proof.requirementIds]), registry: knownIds.requirements, against: "requirement" },
    );
  }

  for (const check of danglingChecks) {
    for (const id of check.ids) {
      if (!check.registry.has(id)) {
        throw new CccPrdCustodyError(
          "CCC_PRD_ASSEMBLY_DANGLING_REFERENCE",
          `${check.from} references ${check.against} ${id}, which resolves to no assembled row`,
        );
      }
    }
  }

  if (semanticV2) {
    if (
      requirements.some((requirement) => !("acceptanceClauses" in requirement))
      || proofs.some((proof) => proof.schema !== "ccc-prd.proof.v2")
    ) {
      throw new CccPrdCustodyError(
        "CCC_PRD_ACCEPTANCE_CLAUSE_MANIFEST_INVALID",
        "v2 chunk assembly cannot mix legacy requirements or proofs into its semantic inventory",
      );
    }
    assertCccPrdAcceptanceClauseCustody({
      sourceBytes: input.packetSourceBytes,
      requirements: (requirements as CccPrdRequirementV2[]).map((requirement) => ({
        requirementId: requirement.id,
        acceptanceClauses: requirement.acceptanceClauses,
        acceptanceDispositions: requirement.acceptanceDispositions,
      })),
      proofs: proofs as CccPrdProofV2[],
    });
  } else if (proofs.some((proof) => proof.schema === "ccc-prd.proof.v2")) {
    throw new CccPrdCustodyError(
      "CCC_PRD_ACCEPTANCE_CLAUSE_MANIFEST_INVALID",
      "legacy chunk assembly cannot admit a v2 proof into its frozen v1 inventory",
    );
  }

  const analysis = analyzeCccPrdMaterialCoverage({
    sourceBytes: input.packetSourceBytes,
    requirements,
    tasks,
    unresolvedDecisions,
  });
  if (analysis.missing.length > 0) {
    throw new CccPrdCustodyError(
      "CCC_PRD_UNDERSTANDING_COVERAGE_INCOMPLETE",
      `${analysis.missing.length} material item(s) remain undispositioned after assembly: `
        + analysis.missing.map((item) => item.id).join(", "),
    );
  }
  if (analysis.conflicts.length > 0) {
    throw new CccPrdCustodyError(
      "CCC_PRD_UNDERSTANDING_COVERAGE_CONFLICTED",
      `${analysis.conflicts.length} material item(s) are conflicted after assembly: `
        + analysis.conflicts.map((item) => item.id).join(", "),
    );
  }

  return {
    authorityRoles,
    requirements,
    proofs,
    tasks,
    edges,
    workflows,
    documents,
    artifacts,
    importIntents,
    protectedActions,
    unresolvedDecisions,
    ambiguities,
    exceptions,
    // Packet-level singletons are synthesized mechanically, never read from
    // any fragment: the fragment schema (design §2) carries neither bounds,
    // admittedWriteRoots, targetRepository, nonGoals, nor packet-level
    // confidence -- "N chunks emitting N copies would produce N conflicting
    // facts with no adjudication rule." confidence defaults to the most
    // conservative value since nothing in a fragment can assert otherwise.
    targetRepository: { path: "", baseCommit: "" },
    bounds: { maxRequests: 0, maxDurationMs: 0, maxConcurrency: 0 },
    admittedWriteRoots: [],
    nonGoals: [],
    confidence: "low",
    materialCoverage: analysis.coverage,
  };
}
