import { createHash } from "node:crypto";
import {
  CCC_PRD_AUTHORING_PROPOSAL_SCHEMA_VERSION,
  CCC_PRD_SIDECAR_SCHEMA_VERSION,
  canonicalCccPrdJson,
  createCccPrdSpanFromBytes,
  createRefusalBundle,
  normalizeProtectedAction,
  type CccPrdAuthoringAdapter,
  type CccPrdAuthoringConstraints,
  type CccPrdAuthoringProposal,
  type CccPrdAuthoringResult,
  type CccPrdProposalArtifact,
  type CccPrdProposalDocument,
  type CccPrdProposalProof,
  type CccPrdProposalProtectedAction,
  type CccPrdProposalRequirement,
  type CccPrdProposalReviewItem,
  type CccPrdProposalTask,
  type CccPrdProposalUnresolvedDecision,
  type CccPrdProposalWorkflow,
  type CccPrdSourceReferenceProposal,
  type CccPrdSourceSpan,
  type CccPrdSidecar,
} from "@fusion/core";
import {
  CccPrdCustodyError,
  readCccPrdPacketCustody,
  sortCccPrdById,
} from "./custody.js";

export type AuthorCccPrdInput = {
  rootDir: string;
  manifestPath: string;
  adapter: CccPrdAuthoringAdapter;
  constraints?: CccPrdAuthoringConstraints;
  previousSidecar?: CccPrdSidecar;
};

const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

function malformed(message: string): CccPrdAuthoringResult {
  return createRefusalBundle({ code: "CCC_PRD_AUTHORING_PROPOSAL_INVALID", message });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasArray(record: Record<string, unknown>, key: string): boolean {
  return Array.isArray(record[key]);
}

function hasIdentifiedRows(value: unknown): boolean {
  return Array.isArray(value) && value.every((entry) => (
    isPlainRecord(entry) && typeof entry.id === "string" && entry.id.length > 0
  ));
}

function hasSourceBoundRows(value: unknown): boolean {
  return hasIdentifiedRows(value) && (value as unknown[]).every((entry) => {
    const sourceRefs = (entry as Record<string, unknown>).sourceRefs;
    return Array.isArray(sourceRefs)
      && sourceRefs.length > 0
      && sourceRefs.every((reference) => (
        isPlainRecord(reference)
        && typeof reference.path === "string"
        && reference.path.length > 0
        && typeof reference.exactQuote === "string"
        && reference.exactQuote.length > 0
      ));
  });
}

function validateProposalShape(value: unknown): value is CccPrdAuthoringProposal {
  if (!isPlainRecord(value) || value.schema !== CCC_PRD_AUTHORING_PROPOSAL_SCHEMA_VERSION) return false;
  const collections = [
    "authorityRoles",
    "requirements",
    "proofs",
    "tasks",
    "edges",
    "workflows",
    "documents",
    "artifacts",
    "importIntents",
    "protectedActions",
    "admittedWriteRoots",
    "nonGoals",
    "unresolvedDecisions",
    "ambiguities",
    "exceptions",
  ];
  const sourceBoundCollections = [
    "requirements",
    "proofs",
    "tasks",
    "workflows",
    "documents",
    "artifacts",
    "protectedActions",
    "unresolvedDecisions",
    "ambiguities",
    "exceptions",
  ];
  const identifiedCollections = [
    "authorityRoles",
    "requirements",
    "proofs",
    "tasks",
    "edges",
    "workflows",
    "documents",
    "artifacts",
    "importIntents",
    "protectedActions",
    "unresolvedDecisions",
    "ambiguities",
    "exceptions",
  ];
  return collections.every((key) => hasArray(value, key))
    && identifiedCollections.every((key) => hasIdentifiedRows(value[key]))
    && sourceBoundCollections.every((key) => hasSourceBoundRows(value[key]))
    && isPlainRecord(value.bounds)
    && isPlainRecord(value.targetRepository)
    && typeof value.confidence === "string";
}

const IDENTITY_COLLECTIONS = [
  "authorityRoles",
  "requirements",
  "proofs",
  "tasks",
  "edges",
  "workflows",
  "documents",
  "artifacts",
  "importIntents",
  "protectedActions",
  "unresolvedDecisions",
  "ambiguities",
  "exceptions",
] as const;

const SOURCE_BOUND_COLLECTIONS = [
  "requirements",
  "proofs",
  "tasks",
  "workflows",
  "documents",
  "artifacts",
  "protectedActions",
  "unresolvedDecisions",
  "ambiguities",
  "exceptions",
] as const;

function identityInventory(
  value: Pick<CccPrdSidecar | CccPrdAuthoringProposal, (typeof IDENTITY_COLLECTIONS)[number]>,
): Record<string, string[]> {
  return Object.fromEntries(IDENTITY_COLLECTIONS.map((collection) => [
    collection,
    value[collection].map((entry) => entry.id).sort((left, right) => (
      left < right ? -1 : left > right ? 1 : 0
    )),
  ]));
}

type SourceBoundEntity = {
  id: string;
  spans: CccPrdSourceSpan[];
};

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareSourceSpans(left: CccPrdSourceSpan, right: CccPrdSourceSpan): number {
  return compareCodeUnits(left.path, right.path)
    || left.byteStart - right.byteStart
    || left.byteEnd - right.byteEnd
    || compareCodeUnits(left.sha256, right.sha256)
    || compareCodeUnits(left.excerptSha256 ?? "", right.excerptSha256 ?? "");
}

function sourceBindingInventory(
  value: Record<(typeof SOURCE_BOUND_COLLECTIONS)[number], SourceBoundEntity[]>,
): Record<string, Array<{ id: string; spans: Array<Pick<
  CccPrdSourceSpan,
  "path" | "byteStart" | "byteEnd" | "sha256" | "excerptSha256"
>> }>> {
  return Object.fromEntries(SOURCE_BOUND_COLLECTIONS.map((collection) => [
    collection,
    value[collection].map((entry) => ({
      id: entry.id,
      spans: [...entry.spans].sort(compareSourceSpans).map((span) => ({
        path: span.path,
        byteStart: span.byteStart,
        byteEnd: span.byteEnd,
        sha256: span.sha256,
        ...(span.excerptSha256 ? { excerptSha256: span.excerptSha256 } : {}),
      })),
    })).sort((left, right) => compareCodeUnits(left.id, right.id)),
  ]));
}

function resolveSourceRefs(
  refs: CccPrdSourceReferenceProposal[],
  sourceBytes: Map<string, Buffer>,
  entityId: string,
): CccPrdSourceSpan[] {
  if (!Array.isArray(refs) || refs.length === 0) {
    throw new CccPrdCustodyError(
      "CCC_PRD_SOURCE_SPAN_MISSING",
      `authoring proposal entity has no source reference: ${entityId}`,
    );
  }
  return refs.map((reference) => {
    if (
      !reference
      || typeof reference.path !== "string"
      || typeof reference.exactQuote !== "string"
      || reference.exactQuote.length === 0
    ) {
      throw new CccPrdCustodyError(
        "CCC_PRD_SOURCE_SPAN_INVALID",
        `authoring proposal entity has a malformed source reference: ${entityId}`,
      );
    }
    const source = sourceBytes.get(reference.path);
    if (!source) {
      throw new CccPrdCustodyError(
        "CCC_PRD_SOURCE_SPAN_FOREIGN",
        `authoring proposal references an unadmitted source: ${reference.path}`,
      );
    }
    const quote = Buffer.from(reference.exactQuote, "utf8");
    const byteStart = source.indexOf(quote);
    if (byteStart < 0) {
      throw new CccPrdCustodyError(
        "CCC_PRD_SOURCE_QUOTE_MISSING",
        `authoring proposal quote is absent for ${entityId} in ${reference.path}`,
      );
    }
    if (source.indexOf(quote, byteStart + 1) >= 0) {
      throw new CccPrdCustodyError(
        "CCC_PRD_SOURCE_QUOTE_AMBIGUOUS",
        `authoring proposal quote is not unique for ${entityId} in ${reference.path}`,
      );
    }
    return {
      ...createCccPrdSpanFromBytes(
        reference.path,
        source,
        byteStart,
        byteStart + quote.byteLength,
      ),
      excerptSha256: sha256(quote),
    };
  });
}

function withoutSourceRefs<T extends { id: string; sourceRefs: CccPrdSourceReferenceProposal[] }>(
  input: T,
  sourceBytes: Map<string, Buffer>,
): Omit<T, "sourceRefs"> & { spans: CccPrdSourceSpan[] } {
  const { sourceRefs, ...value } = input;
  return {
    ...value,
    spans: resolveSourceRefs(sourceRefs, sourceBytes, input.id),
  };
}

function mapProposal(
  proposal: CccPrdAuthoringProposal,
  sourceBytes: Map<string, Buffer>,
): {
  requirements: ReturnType<typeof withoutSourceRefs<CccPrdProposalRequirement>>[];
  proofs: ReturnType<typeof withoutSourceRefs<CccPrdProposalProof>>[];
  tasks: ReturnType<typeof withoutSourceRefs<CccPrdProposalTask>>[];
  workflows: ReturnType<typeof withoutSourceRefs<CccPrdProposalWorkflow>>[];
  documents: ReturnType<typeof withoutSourceRefs<CccPrdProposalDocument>>[];
  artifacts: ReturnType<typeof withoutSourceRefs<CccPrdProposalArtifact>>[];
  unresolvedDecisions: ReturnType<typeof withoutSourceRefs<CccPrdProposalUnresolvedDecision>>[];
  ambiguities: ReturnType<typeof withoutSourceRefs<CccPrdProposalReviewItem>>[];
  exceptions: ReturnType<typeof withoutSourceRefs<CccPrdProposalReviewItem>>[];
  protectedActions: ReturnType<typeof normalizeProtectedAction>[];
} {
  return {
    requirements: sortCccPrdById(proposal.requirements.map((value) => withoutSourceRefs(value, sourceBytes))),
    proofs: sortCccPrdById(proposal.proofs.map((value) => withoutSourceRefs(value, sourceBytes))),
    tasks: sortCccPrdById(proposal.tasks.map((value) => withoutSourceRefs(value, sourceBytes))),
    workflows: sortCccPrdById(proposal.workflows.map((value) => withoutSourceRefs(value, sourceBytes))),
    documents: sortCccPrdById(proposal.documents.map((value) => withoutSourceRefs(value, sourceBytes))),
    artifacts: sortCccPrdById(proposal.artifacts.map((value) => withoutSourceRefs(value, sourceBytes))),
    unresolvedDecisions: sortCccPrdById(
      proposal.unresolvedDecisions.map((value) => withoutSourceRefs(value, sourceBytes)),
    ),
    ambiguities: sortCccPrdById(proposal.ambiguities.map((value) => withoutSourceRefs(value, sourceBytes))),
    exceptions: sortCccPrdById(proposal.exceptions.map((value) => withoutSourceRefs(value, sourceBytes))),
    protectedActions: sortCccPrdById(proposal.protectedActions.map((value: CccPrdProposalProtectedAction) => {
      const spans = resolveSourceRefs(value.sourceRefs, sourceBytes, value.id);
      return normalizeProtectedAction({
        id: value.id,
        kind: value.kind,
        target: value.target,
        spans,
      });
    })),
  };
}

export async function authorCccPrdPacket(input: AuthorCccPrdInput): Promise<CccPrdAuthoringResult> {
  try {
    const custody = readCccPrdPacketCustody(input);
    for (const [path, bytes] of custody.sourceBytes) {
      if (!Buffer.from(bytes.toString("utf8"), "utf8").equals(bytes)) {
        return createRefusalBundle({
          code: "CCC_PRD_SOURCE_NOT_UTF8",
          message: `authoritative Markdown source is not valid UTF-8: ${path}`,
        });
      }
    }
    const proposalValue = await input.adapter.generateCandidate({
      sourceVersion: custody.sourceVersion,
      packetHash: custody.packetHash,
      sources: custody.sources.map((source) => ({
        ...source,
        content: custody.sourceBytes.get(source.path)!.toString("utf8"),
      })),
      ...(input.constraints ? { constraints: input.constraints } : {}),
      ...(input.previousSidecar ? { previousSidecar: input.previousSidecar } : {}),
    });
    if (!validateProposalShape(proposalValue)) {
      return malformed(`authoring adapter ${input.adapter.id} returned the wrong proposal schema or shape`);
    }
    if (input.constraints) {
      if (
        canonicalCccPrdJson(proposalValue.targetRepository)
        !== canonicalCccPrdJson(input.constraints.targetRepository)
      ) {
        return createRefusalBundle({
          code: "CCC_PRD_AUTHORING_TARGET_DRIFT",
          message: "authoring proposal target repository or base differs from the admitted request",
        });
      }
      if (
        canonicalCccPrdJson(proposalValue.bounds)
        !== canonicalCccPrdJson(input.constraints.bounds)
      ) {
        return createRefusalBundle({
          code: "CCC_PRD_AUTHORING_BOUNDS_DRIFT",
          message: "authoring proposal execution bounds differ from the admitted request",
        });
      }
      const reviewCount = proposalValue.ambiguities.length
        + proposalValue.unresolvedDecisions.length
        + proposalValue.exceptions.length
        + proposalValue.protectedActions.length;
      if (
        !Number.isSafeInteger(input.constraints.maxReviewItems)
        || input.constraints.maxReviewItems < 0
        || reviewCount > input.constraints.maxReviewItems
      ) {
        return createRefusalBundle({
          code: "CCC_PRD_AUTHORING_REVIEW_UNBOUNDED",
          message: `authoring proposal review count ${reviewCount} exceeds admitted maximum ${input.constraints.maxReviewItems}`,
        });
      }
    }
    const samePacketAsPrevious = input.previousSidecar?.provenance.packetHash === custody.packetHash;
    if (
      samePacketAsPrevious
      && canonicalCccPrdJson(identityInventory(input.previousSidecar!))
        !== canonicalCccPrdJson(identityInventory(proposalValue))
    ) {
      return createRefusalBundle({
        code: "CCC_PRD_AUTHORING_IDENTITY_DRIFT",
        message: "authoring proposal changed stable declaration IDs for an unchanged admitted packet",
      });
    }
    const mapped = mapProposal(proposalValue, custody.sourceBytes);
    if (
      samePacketAsPrevious
      && canonicalCccPrdJson(sourceBindingInventory(input.previousSidecar!))
        !== canonicalCccPrdJson(sourceBindingInventory(mapped))
    ) {
      return createRefusalBundle({
        code: "CCC_PRD_AUTHORING_IDENTITY_DRIFT",
        message: "authoring proposal rebound stable declaration IDs to different source evidence for an unchanged admitted packet",
      });
    }
    const proposalHash = sha256(canonicalCccPrdJson(proposalValue));
    const sidecar: CccPrdSidecar = {
      schema: CCC_PRD_SIDECAR_SCHEMA_VERSION,
      sourceVersion: custody.sourceVersion,
      orderedSources: custody.sources,
      provenance: {
        authoringAdapterId: input.adapter.id,
        ...(input.adapter.model ? { authoringModel: input.adapter.model } : {}),
        proposalHash,
        packetHash: custody.packetHash,
      },
      authorityRoles: sortCccPrdById(proposalValue.authorityRoles),
      requirements: mapped.requirements,
      proofs: mapped.proofs,
      tasks: mapped.tasks,
      edges: sortCccPrdById(proposalValue.edges),
      workflows: mapped.workflows,
      documents: mapped.documents,
      artifacts: mapped.artifacts,
      importIntents: sortCccPrdById(proposalValue.importIntents),
      protectedActions: mapped.protectedActions,
      bounds: proposalValue.bounds,
      admittedWriteRoots: [...proposalValue.admittedWriteRoots],
      targetRepository: proposalValue.targetRepository,
      nonGoals: [...proposalValue.nonGoals],
      unresolvedDecisions: mapped.unresolvedDecisions,
      ambiguities: mapped.ambiguities,
      exceptions: mapped.exceptions,
      confidence: proposalValue.confidence,
    };
    return {
      kind: "candidate",
      sidecar,
      review: {
        ambiguities: sidecar.ambiguities,
        unresolvedDecisions: sidecar.unresolvedDecisions,
        exceptions: sidecar.exceptions,
        protectedActions: sidecar.protectedActions,
      },
    };
  } catch (error) {
    if (error instanceof CccPrdCustodyError) {
      return createRefusalBundle({ code: error.code, message: error.message });
    }
    return createRefusalBundle({
      code: "CCC_PRD_AUTHORING_FAILED",
      message: error instanceof Error ? error.message : "authoring failed",
    });
  }
}
