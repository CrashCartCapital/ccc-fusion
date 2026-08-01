import { isAbsolute } from "node:path";
import {
  type CccPrdAuthoringAdapter,
  type CccPrdAuthoringReview,
  type CccPrdDiagnostic,
  type CccPrdMaterialCoverageItem,
  type CccPrdSidecar,
  type WorkflowExtensionRegistry,
} from "@fusion/core";
import { authorCccPrdPacket } from "./authoring.js";
import { readCccPrdPacketCustody } from "./custody.js";
import { analyzeCccPrdMaterialCoverage } from "./material-coverage.js";

export const CCC_PRD_UNDERSTANDING_REVIEW_SCHEMA_VERSION =
  "ccc-prd.understanding-review.v1" as const;

type CoverageInventoryItem = Omit<CccPrdMaterialCoverageItem, "disposition">;

const SHALLOW_INVENTORY_THRESHOLD = 8;
const SHALLOW_REQUIREMENT_THRESHOLD = 4;
const MINIMUM_OVERALL_DISPOSITION_NUMERATOR = 1;
const MINIMUM_OVERALL_DISPOSITION_DENOMINATOR = 4;
const MINIMUM_REQUIREMENT_DISPOSITION_NUMERATOR = 1;
const MINIMUM_REQUIREMENT_DISPOSITION_DENOMINATOR = 2;

export type CccPrdUnderstandingMissingFact = {
  code: string;
  question: string;
};

export type CccPrdUnderstandingReview = {
  schema: typeof CCC_PRD_UNDERSTANDING_REVIEW_SCHEMA_VERSION;
  kind: "understanding-review";
  executable: false;
  sourceVersion: string;
  orderedSources: CccPrdSidecar["orderedSources"];
  provenance: CccPrdSidecar["provenance"];
  authorityRoles: CccPrdSidecar["authorityRoles"];
  requirements: CccPrdSidecar["requirements"];
  proofs: CccPrdSidecar["proofs"];
  tasks: CccPrdSidecar["tasks"];
  edges: CccPrdSidecar["edges"];
  workflows: CccPrdSidecar["workflows"];
  documents: CccPrdSidecar["documents"];
  artifacts: CccPrdSidecar["artifacts"];
  proposedImportIntents: CccPrdSidecar["importIntents"];
  protectedActions: CccPrdSidecar["protectedActions"];
  nonGoals: CccPrdSidecar["nonGoals"];
  assumptions: [];
  ambiguities: CccPrdSidecar["ambiguities"];
  exceptions: CccPrdSidecar["exceptions"];
  unresolvedDecisions: CccPrdSidecar["unresolvedDecisions"];
  confidence: CccPrdSidecar["confidence"];
  implementationContext: {
    approvalStatus: "unapproved";
    targetRepository: {
      path: string | null;
      baseCommit: string | null;
    };
    bounds: {
      maxRequests: number | null;
      maxDurationMs: number | null;
      maxConcurrency: number | null;
    };
    admittedWriteRoots: CccPrdSidecar["admittedWriteRoots"];
    missingFacts: CccPrdUnderstandingMissingFact[];
  };
  coverage: {
    inventoryCount: number;
    dispositionCount: number;
    dispositions: CccPrdMaterialCoverageItem[];
    missing: CoverageInventoryItem[];
    conflicts: CoverageInventoryItem[];
  };
  review: CccPrdAuthoringReview;
};

export type UnderstandCccPrdInput = {
  rootDir: string;
  manifestPath: string;
  adapter: CccPrdAuthoringAdapter;
  maxReviewItems: number;
  workflowExtensionRegistry: WorkflowExtensionRegistry;
};

export type CccPrdUnderstandingResult =
  | CccPrdUnderstandingReview
  | { kind: "refusal"; diagnostics: CccPrdDiagnostic[] };

function positive(value: number): number | null {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function inventoryItem(
  value: CoverageInventoryItem & Record<string, unknown>,
): CoverageInventoryItem {
  return {
    id: value.id,
    sourcePath: value.sourcePath,
    materialKind: value.materialKind,
    headingPath: [...value.headingPath],
    title: value.title,
    spans: value.spans,
  };
}

function implementationContext(
  sidecar: CccPrdSidecar,
): CccPrdUnderstandingReview["implementationContext"] {
  const targetPath = sidecar.targetRepository.path.trim();
  const baseCommit = sidecar.targetRepository.baseCommit.trim();
  const path = targetPath && isAbsolute(targetPath) ? targetPath : null;
  const base = /^[0-9a-f]{40}$/u.test(baseCommit) ? baseCommit : null;
  const bounds = {
    maxRequests: positive(sidecar.bounds.maxRequests),
    maxDurationMs: positive(sidecar.bounds.maxDurationMs),
    maxConcurrency: positive(sidecar.bounds.maxConcurrency),
  };
  const missingFacts: CccPrdUnderstandingMissingFact[] = [];
  if (!path) {
    missingFacts.push({
      code: "CCC_PRD_TARGET_REPOSITORY_REQUIRED",
      question: "Which target repository should this PRD change?",
    });
  }
  if (!base) {
    missingFacts.push({
      code: "CCC_PRD_BASELINE_REQUIRED",
      question: "Which exact 40-hex baseline commit should Fusion freeze?",
    });
  }
  if (Object.values(bounds).some((value) => value === null)) {
    missingFacts.push({
      code: "CCC_PRD_EXECUTION_BOUNDS_REQUIRED",
      question: "What request, duration, and concurrency limits should this campaign obey?",
    });
  }
  if (sidecar.admittedWriteRoots.length === 0) {
    missingFacts.push({
      code: "CCC_PRD_ALLOWED_PATHS_REQUIRED",
      question: "Which target-relative paths or write roots may the campaign change?",
    });
  }
  return {
    approvalStatus: "unapproved",
    targetRepository: { path, baseCommit: base },
    bounds,
    admittedWriteRoots: sidecar.admittedWriteRoots,
    missingFacts,
  };
}

export async function understandCccPrdPacket(
  input: UnderstandCccPrdInput,
): Promise<CccPrdUnderstandingResult> {
  if (!Number.isSafeInteger(input.maxReviewItems) || input.maxReviewItems < 0) {
    return {
      kind: "refusal",
      diagnostics: [{
        code: "CCC_PRD_UNDERSTANDING_REVIEW_BOUND_INVALID",
        message: "understanding review maximum must be a non-negative safe integer",
      }],
    };
  }
  const authored = await authorCccPrdPacket({
    rootDir: input.rootDir,
    manifestPath: input.manifestPath,
    adapter: input.adapter,
    workflowExtensionRegistry: input.workflowExtensionRegistry,
  });
  if (authored.kind === "refusal") return authored;
  if (authored.sidecar.requirements.length === 0) {
    return {
      kind: "refusal",
      diagnostics: [{
        code: "CCC_PRD_UNDERSTANDING_ZERO_REQUIREMENTS",
        message: "understanding extracted zero requirements from the frozen PRD packet",
      }],
    };
  }
  const reviewCount = authored.review.ambiguities.length
    + authored.review.unresolvedDecisions.length
    + authored.review.exceptions.length
    + authored.review.protectedActions.length;
  if (reviewCount > input.maxReviewItems) {
    return {
      kind: "refusal",
      diagnostics: [{
        code: "CCC_PRD_AUTHORING_REVIEW_UNBOUNDED",
        message: `understanding review count ${reviewCount} exceeds admitted maximum ${input.maxReviewItems}`,
      }],
    };
  }

  const custody = readCccPrdPacketCustody(input);
  const analysis = analyzeCccPrdMaterialCoverage({
    sourceBytes: custody.sourceBytes,
    requirements: authored.sidecar.requirements,
    tasks: authored.sidecar.tasks,
    unresolvedDecisions: authored.sidecar.unresolvedDecisions,
  });
  const requirementInventoryCount = analysis.inventory.filter(
    ({ materialKind }) => materialKind === "requirement",
  ).length;
  const requirementDispositionCount = analysis.coverage.filter(
    ({ materialKind }) => materialKind === "requirement",
  ).length;
  const overallExtractionIsShallow =
    analysis.inventory.length >= SHALLOW_INVENTORY_THRESHOLD
    && analysis.coverage.length * MINIMUM_OVERALL_DISPOSITION_DENOMINATOR
      < analysis.inventory.length * MINIMUM_OVERALL_DISPOSITION_NUMERATOR;
  const requirementExtractionIsShallow =
    requirementInventoryCount >= SHALLOW_REQUIREMENT_THRESHOLD
    && requirementDispositionCount
      * MINIMUM_REQUIREMENT_DISPOSITION_DENOMINATOR
      < requirementInventoryCount
        * MINIMUM_REQUIREMENT_DISPOSITION_NUMERATOR;
  if (overallExtractionIsShallow || requirementExtractionIsShallow) {
    return {
      kind: "refusal",
      diagnostics: [{
        code: "CCC_PRD_UNDERSTANDING_IMPLAUSIBLY_SHALLOW",
        message: [
          "understanding coverage is too shallow to trust",
          `material inventory=${analysis.inventory.length}`,
          `material dispositions=${analysis.coverage.length}`,
          `explicit requirement inventory=${requirementInventoryCount}`,
          `explicit requirement dispositions=${requirementDispositionCount}`,
        ].join("; "),
      }],
    };
  }
  return {
    schema: CCC_PRD_UNDERSTANDING_REVIEW_SCHEMA_VERSION,
    kind: "understanding-review",
    executable: false,
    sourceVersion: authored.sidecar.sourceVersion,
    orderedSources: authored.sidecar.orderedSources,
    provenance: authored.sidecar.provenance,
    authorityRoles: authored.sidecar.authorityRoles,
    requirements: authored.sidecar.requirements,
    proofs: authored.sidecar.proofs,
    tasks: authored.sidecar.tasks,
    edges: authored.sidecar.edges,
    workflows: authored.sidecar.workflows,
    documents: authored.sidecar.documents,
    artifacts: authored.sidecar.artifacts,
    proposedImportIntents: authored.sidecar.importIntents,
    protectedActions: authored.sidecar.protectedActions,
    nonGoals: authored.sidecar.nonGoals,
    assumptions: [],
    ambiguities: authored.sidecar.ambiguities,
    exceptions: authored.sidecar.exceptions,
    unresolvedDecisions: authored.sidecar.unresolvedDecisions,
    confidence: authored.sidecar.confidence,
    implementationContext: implementationContext(authored.sidecar),
    coverage: {
      inventoryCount: analysis.inventory.length,
      dispositionCount: analysis.coverage.length,
      dispositions: analysis.coverage,
      missing: analysis.missing.map((item) =>
        inventoryItem(item as CoverageInventoryItem & Record<string, unknown>)),
      conflicts: analysis.conflicts.map((item) =>
        inventoryItem(item as CoverageInventoryItem & Record<string, unknown>)),
    },
    review: authored.review,
  };
}
