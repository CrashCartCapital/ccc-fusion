export const CCC_PRD_PACKET_SCHEMA_VERSION = "ccc-prd.packet.v1" as const;
export const CCC_PRD_AUTHORING_PROPOSAL_SCHEMA_VERSION = "ccc-prd.authoring-proposal.v1" as const;
export const CCC_PRD_AUTHORING_PROPOSAL_FRAGMENT_SCHEMA_VERSION =
  "ccc-prd.authoring-proposal-fragment.v1" as const;
export const CCC_PRD_SIDECAR_SCHEMA_VERSION = "ccc-prd.sidecar.v1" as const;
export const CCC_PRD_BUNDLE_SCHEMA_VERSION = "ccc-prd.bundle.v1" as const;
export const CCC_PRD_PROOF_ADMISSION_SCHEMA_VERSION = "ccc-prd.proof-admission.v1" as const;
export const CCC_PRD_IMPLEMENTATION_FACT_PROVENANCE_SCHEMA_VERSION =
  "ccc-prd.implementation-fact-provenance.v1" as const;

/** @deprecated Use the specific packet, sidecar, or bundle schema constant. */
export const CCC_PRD_SCHEMA_VERSION = CCC_PRD_BUNDLE_SCHEMA_VERSION;

export type CccPrdSourceSpan = {
  path: string;
  /** Inclusive UTF-8 byte offset. */
  byteStart: number;
  /** Exclusive UTF-8 byte offset. */
  byteEnd: number;
  /** One-based display coordinates, counted by Unicode code point. */
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  /** Raw-byte SHA-256 of the complete admitted source. */
  sha256: string;
  /** Raw-byte SHA-256 of only this span; required on authored sidecars. */
  excerptSha256?: string;
};

export type CccPrdDiagnostic = {
  code: string;
  message: string;
  span?: CccPrdSourceSpan;
};

export type CccPrdConfidence = "high" | "medium" | "low";

export type CccPrdProofAdmission = {
  schema: typeof CCC_PRD_PROOF_ADMISSION_SCHEMA_VERSION;
  pluginId: string;
  pluginVersion: string;
  extensionId: string;
  proofVersion: string;
  extensionRootRelativeSource: string;
  extensionSourceSha256: string;
  extensionManifestSha256: string;
  definitionSha256: string;
};

export type CccPrdAuthorityRole = {
  id: string;
  role: "root" | "production_module" | "blocking_test_index" | "support";
  sourcePaths: string[];
  accountableProducer: string;
};

export type CccPrdProof = {
  id: string;
  requirementIds: string[];
  command: string;
  positiveOracle: string;
  negativeControls: string[];
  spans: CccPrdSourceSpan[];
  confidence: CccPrdConfidence;
  admission?: CccPrdProofAdmission;
};

export type CccPrdRequirement = {
  id: string;
  statement: string;
  acceptance: string;
  accountableProducer: string;
  dependencies: string[];
  proofIds: string[];
  spans: CccPrdSourceSpan[];
  confidence: CccPrdConfidence;
};

export type CccPrdTask = {
  id: string;
  title: string;
  description: string;
  accountableProducer: string;
  requirementIds: string[];
  dependencyTaskIds: string[];
  proofIds: string[];
  workflowId: string;
  documentIds: string[];
  artifactIds: string[];
  protectedActionIds: string[];
  /**
   * Target-relative semantic ownership used to prevent concurrently runnable
   * coding tasks from claiming the same source surface. Legacy sidecars may
   * omit this; the supported product policy generator requires it.
   */
  ownedPaths?: string[];
  /**
   * Target-relative filesystem scopes the coding executor may write. Every
   * root must stay inside both task ownership and PRD-wide admitted roots.
   * Legacy sidecars may omit this; the supported product policy generator
   * requires it.
   */
  allowedWriteRoots?: string[];
  spans: CccPrdSourceSpan[];
};

export type CccPrdDependencyEdge = {
  id: string;
  fromTaskId: string;
  toTaskId: string;
  kind: "depends_on";
};

export type CccPrdWorkflow = {
  id: string;
  title: string;
  taskIds: string[];
  entryTaskIds: string[];
  terminalTaskIds: string[];
  spans: CccPrdSourceSpan[];
};

export type CccPrdDocument = {
  id: string;
  taskId: string;
  key: string;
  title: string;
  content: string;
  spans: CccPrdSourceSpan[];
};

export type CccPrdArtifact = {
  id: string;
  taskId: string;
  type: string;
  title: string;
  mimeType: string;
  content: string;
  spans: CccPrdSourceSpan[];
};

export type CccPrdImportEntityType =
  | "campaign"
  | "task"
  | "dependency_edge"
  | "workflow"
  | "document"
  | "artifact"
  | "source"
  | "work_item"
  | "run_audit";

export type CccPrdImportIntent = {
  id: string;
  entityType: CccPrdImportEntityType;
  entityId: string;
  operation: "create";
  target: string;
};

export type CccPrdManifestEntry = {
  relativePath: string;
  role: string;
  sha256: string;
  authoritative: boolean;
};

export type CccPrdManifestPacket = {
  schema: string;
  sourceVersion: string;
  entries: CccPrdManifestEntry[];
};

export type CccPrdProtectedActionKind =
  | "promotion"
  | "live_execution"
  | "deletion"
  | "merge"
  | "publication"
  | "credential"
  | "billing"
  | "upstream_write";

export type CccPrdOperatorDecision =
  | "approve_promotion"
  | "approve_live_execution"
  | "approve_deletion"
  | "approve_merge"
  | "approve_publication"
  | "approve_credential_use"
  | "approve_billing"
  | "approve_upstream_write";

export type CccPrdProtectedActionIntent = {
  id: string;
  kind: CccPrdProtectedActionKind;
  target: string;
  operatorDecision: CccPrdOperatorDecision;
  requiresOperatorDecision: true;
  spans: CccPrdSourceSpan[];
};

export type CccPrdSource = {
  path: string;
  role: string;
  authoritative: boolean;
  sha256: string;
  byteLength: number;
};

export type CccPrdExecutionBounds = {
  maxRequests: number;
  maxDurationMs: number;
  maxConcurrency: number;
};

export type CccPrdAdmittedWriteRoot = {
  path: string;
  purpose: string;
};

export type CccPrdTargetRepository = {
  path: string;
  baseCommit: string;
};

export type CccPrdUnresolvedDecision = {
  id: string;
  question: string;
  state: "unresolved";
  spans: CccPrdSourceSpan[];
};

export type CccPrdReviewItem = {
  id: string;
  message: string;
  spans: CccPrdSourceSpan[];
};

export type CccPrdProvenance = {
  authoringAdapterId: string;
  authoringModel?: string;
  proposalHash: string;
  packetHash: string;
};

export type CccPrdMaterialCoverageDisposition =
  | {
      kind: "task";
      taskIds: string[];
      requirementIds: string[];
    }
  | {
      kind: "explicit_deferral";
      reason: string;
    }
  | {
      kind: "out_of_scope";
      reason: string;
    }
  | {
      kind: "unresolved_question";
      unresolvedDecisionIds: string[];
    };

export type CccPrdMaterialCoverageItem = {
  id: string;
  sourcePath: string;
  materialKind: "section" | "requirement";
  headingPath: string[];
  title: string;
  spans: CccPrdSourceSpan[];
  disposition: CccPrdMaterialCoverageDisposition;
};

export type CccPrdImplementationFactBinding = {
  value: string | number;
  spans: CccPrdSourceSpan[];
};

export type CccPrdImplementationFactProvenance = {
  schema: typeof CCC_PRD_IMPLEMENTATION_FACT_PROVENANCE_SCHEMA_VERSION;
  targetRepository: {
    path: CccPrdImplementationFactBinding;
    baseCommit: CccPrdImplementationFactBinding;
  };
  bounds: {
    maxRequests: CccPrdImplementationFactBinding;
    maxDurationMs: CccPrdImplementationFactBinding;
    maxConcurrency: CccPrdImplementationFactBinding;
  };
  admittedWriteRoots: Array<{
    path: CccPrdImplementationFactBinding;
    purpose: CccPrdImplementationFactBinding;
  }>;
  nonGoals: CccPrdImplementationFactBinding[];
  requirements: Array<{
    id: string;
    acceptance: CccPrdImplementationFactBinding;
  }>;
  proofs: Array<{
    id: string;
    command: CccPrdImplementationFactBinding;
    positiveOracle: CccPrdImplementationFactBinding;
    negativeControls: CccPrdImplementationFactBinding[];
  }>;
  protectedActions: Array<{
    id: string;
    kind: CccPrdImplementationFactBinding;
    target: CccPrdImplementationFactBinding;
  }>;
};

export type CccPrdSemanticDeclarations = {
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
  bounds: CccPrdExecutionBounds;
  admittedWriteRoots: CccPrdAdmittedWriteRoot[];
  targetRepository: CccPrdTargetRepository;
  nonGoals: string[];
  unresolvedDecisions: CccPrdUnresolvedDecision[];
  ambiguities: CccPrdReviewItem[];
  exceptions: CccPrdReviewItem[];
  confidence: CccPrdConfidence;
};

export type CccPrdSidecar = CccPrdSemanticDeclarations & {
  schema: typeof CCC_PRD_SIDECAR_SCHEMA_VERSION;
  sourceVersion: string;
  orderedSources: CccPrdSource[];
  provenance: CccPrdProvenance;
  /**
   * Deterministic coverage inventory generated from admitted Markdown bytes.
   * Legacy v1 sidecars may omit it, but the supported product route requires it.
   */
  materialCoverage?: CccPrdMaterialCoverageItem[];
  /**
   * Exact source custody for implementation-changing facts. Legacy v1 sidecars
   * may omit it, but the supported product route requires it.
   */
  implementationFactProvenance?: CccPrdImplementationFactProvenance;
};

export type CccPrdSemanticBundle = Omit<
  CccPrdSidecar,
  "schema" | "ambiguities" | "exceptions" | "unresolvedDecisions"
> & {
  kind: "bundle";
  schema: typeof CCC_PRD_BUNDLE_SCHEMA_VERSION;
  sourceHash: string;
  sidecarHash: string;
  bundleHash: string;
};

export type CccPrdRefusalBundle = {
  kind: "refusal";
  diagnostics: CccPrdDiagnostic[];
};

export type CccPrdValidationResult = {
  kind: "validation";
  valid: boolean;
  diagnostics: CccPrdDiagnostic[];
};

export type CccPrdSourceReferenceProposal = {
  path: string;
  exactQuote: string;
};

export type CccPrdProposalRequirement = Omit<CccPrdRequirement, "spans"> & {
  sourceRefs: CccPrdSourceReferenceProposal[];
};

export type CccPrdProposalProof = Omit<CccPrdProof, "spans" | "admission"> & {
  sourceRefs: CccPrdSourceReferenceProposal[];
};

export type CccPrdProposalTask = Omit<CccPrdTask, "spans"> & {
  sourceRefs: CccPrdSourceReferenceProposal[];
};

export type CccPrdProposalWorkflow = Omit<CccPrdWorkflow, "spans"> & {
  sourceRefs: CccPrdSourceReferenceProposal[];
};

export type CccPrdProposalDocument = Omit<CccPrdDocument, "spans"> & {
  sourceRefs: CccPrdSourceReferenceProposal[];
};

export type CccPrdProposalArtifact = Omit<CccPrdArtifact, "spans"> & {
  sourceRefs: CccPrdSourceReferenceProposal[];
};

export type CccPrdProposalProtectedAction = {
  id: string;
  kind: CccPrdProtectedActionKind;
  target: string;
  sourceRefs: CccPrdSourceReferenceProposal[];
};

export type CccPrdProposalUnresolvedDecision = Omit<CccPrdUnresolvedDecision, "spans"> & {
  sourceRefs: CccPrdSourceReferenceProposal[];
};

export type CccPrdProposalReviewItem = Omit<CccPrdReviewItem, "spans"> & {
  sourceRefs: CccPrdSourceReferenceProposal[];
};

export type CccPrdAuthoringProposal = Omit<
  CccPrdSemanticDeclarations,
  | "requirements"
  | "proofs"
  | "tasks"
  | "workflows"
  | "documents"
  | "artifacts"
  | "protectedActions"
  | "unresolvedDecisions"
  | "ambiguities"
  | "exceptions"
> & {
  schema: typeof CCC_PRD_AUTHORING_PROPOSAL_SCHEMA_VERSION;
  requirements: CccPrdProposalRequirement[];
  proofs: CccPrdProposalProof[];
  tasks: CccPrdProposalTask[];
  workflows: CccPrdProposalWorkflow[];
  documents: CccPrdProposalDocument[];
  artifacts: CccPrdProposalArtifact[];
  protectedActions: CccPrdProposalProtectedAction[];
  unresolvedDecisions: CccPrdProposalUnresolvedDecision[];
  ambiguities: CccPrdProposalReviewItem[];
  exceptions: CccPrdProposalReviewItem[];
};

/** A chunk-scoped row carries a ledger of the material items it claims to
 * disposition; per design §2 this is checked against the real analyzer and
 * never trusted on the model's word. */
export type CccPrdFragmentRow<T> = T & { materialItemIds?: string[] };

/**
 * The per-chunk understanding fragment (design §2). Unlike
 * {@link CccPrdAuthoringProposal}, a fragment never carries `bounds`,
 * `admittedWriteRoots`, `targetRepository`, `nonGoals`, or packet-level
 * `confidence` -- those are packet-global singletons synthesized once at
 * assembly (design §4), not re-emitted per chunk.
 */
export type CccPrdAuthoringProposalFragment = {
  schema: typeof CCC_PRD_AUTHORING_PROPOSAL_FRAGMENT_SCHEMA_VERSION;
  authorityRoles: CccPrdFragmentRow<CccPrdAuthorityRole>[];
  requirements: CccPrdFragmentRow<CccPrdProposalRequirement>[];
  proofs: CccPrdFragmentRow<CccPrdProposalProof>[];
  tasks: CccPrdFragmentRow<CccPrdProposalTask>[];
  edges: CccPrdFragmentRow<CccPrdDependencyEdge>[];
  workflows: CccPrdFragmentRow<CccPrdProposalWorkflow>[];
  documents: CccPrdFragmentRow<CccPrdProposalDocument>[];
  artifacts: CccPrdFragmentRow<CccPrdProposalArtifact>[];
  importIntents: CccPrdFragmentRow<CccPrdImportIntent>[];
  protectedActions: CccPrdFragmentRow<CccPrdProposalProtectedAction>[];
  unresolvedDecisions: CccPrdFragmentRow<CccPrdProposalUnresolvedDecision>[];
  ambiguities: CccPrdFragmentRow<CccPrdProposalReviewItem>[];
  exceptions: CccPrdFragmentRow<CccPrdProposalReviewItem>[];
};

export type CccPrdAuthoringConstraints = {
  targetRepository: CccPrdTargetRepository;
  bounds: CccPrdExecutionBounds;
  /** Maximum combined ambiguity, unresolved-decision, exception, and protected-action rows. */
  maxReviewItems: number;
};

export type CccPrdAuthoringRequest = {
  sourceVersion: string;
  packetHash: string;
  sources: Array<CccPrdSource & { content: string }>;
  constraints?: CccPrdAuthoringConstraints;
  previousSidecar?: CccPrdSidecar;
};

export type CccPrdAuthoringAdapter = {
  id: string;
  model?: string;
  generateCandidate(request: CccPrdAuthoringRequest): Promise<CccPrdAuthoringProposal>;
};

export type CccPrdAuthoringReview = {
  ambiguities: CccPrdReviewItem[];
  unresolvedDecisions: CccPrdUnresolvedDecision[];
  exceptions: CccPrdReviewItem[];
  protectedActions: CccPrdProtectedActionIntent[];
};

export type CccPrdAuthoringResult =
  | {
      kind: "candidate";
      sidecar: CccPrdSidecar;
      review: CccPrdAuthoringReview;
    }
  | CccPrdRefusalBundle;
