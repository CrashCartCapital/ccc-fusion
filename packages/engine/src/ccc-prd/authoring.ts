import { createHash } from "node:crypto";
import {
  CCC_PRD_AUTHORING_PROPOSAL_SCHEMA_VERSION,
  CCC_PRD_SIDECAR_SCHEMA_VERSION,
  canonicalCccPrdJson,
  createCccPrdSpanFromBytes,
  createRefusalBundle,
  normalizeProtectedAction,
  type CccPrdAuthoringAdapter,
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

function validateProposalShape(value: unknown): value is CccPrdAuthoringProposal {
  if (!isPlainRecord(value) || value.schema !== CCC_PRD_AUTHORING_PROPOSAL_SCHEMA_VERSION) return false;
  return [
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
  ].every((key) => hasArray(value, key))
    && isPlainRecord(value.bounds)
    && isPlainRecord(value.targetRepository)
    && typeof value.confidence === "string";
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
    });
    if (!validateProposalShape(proposalValue)) {
      return malformed(`authoring adapter ${input.adapter.id} returned the wrong proposal schema or shape`);
    }
    const mapped = mapProposal(proposalValue, custody.sourceBytes);
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
