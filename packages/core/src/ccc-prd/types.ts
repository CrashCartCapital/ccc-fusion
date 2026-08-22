export const CCC_PRD_PACKET_SCHEMA_VERSION = "ccc-prd.packet.v1" as const;
export const CCC_PRD_AUTHORING_PROPOSAL_V1_SCHEMA_VERSION =
  "ccc-prd.authoring-proposal.v1" as const;
export const CCC_PRD_AUTHORING_PROPOSAL_V2_SCHEMA_VERSION =
  "ccc-prd.authoring-proposal.v2" as const;
export const CCC_PRD_AUTHORING_PROPOSAL_FRAGMENT_V1_SCHEMA_VERSION =
  "ccc-prd.authoring-proposal-fragment.v1" as const;
export const CCC_PRD_AUTHORING_PROPOSAL_FRAGMENT_V2_SCHEMA_VERSION =
  "ccc-prd.authoring-proposal-fragment.v2" as const;
export const CCC_PRD_SIDECAR_V1_SCHEMA_VERSION = "ccc-prd.sidecar.v1" as const;
export const CCC_PRD_SIDECAR_V2_SCHEMA_VERSION = "ccc-prd.sidecar.v2" as const;
export const CCC_PRD_BUNDLE_V1_SCHEMA_VERSION = "ccc-prd.bundle.v1" as const;
export const CCC_PRD_BUNDLE_V2_SCHEMA_VERSION = "ccc-prd.bundle.v2" as const;
export const CCC_PRD_PROOF_ADMISSION_V1_SCHEMA_VERSION =
  "ccc-prd.proof-admission.v1" as const;
export const CCC_PRD_PROOF_ADMISSION_V2_SCHEMA_VERSION =
  "ccc-prd.proof-admission.v2" as const;
export const CCC_PRD_PROOF_V2_SCHEMA_VERSION = "ccc-prd.proof.v2" as const;
export const CCC_PRD_VERIFIER_PYTHON_ADAPTER_V1_SCHEMA_VERSION =
  "ccc-prd.verifier.python-adapter.v1" as const;
export const CCC_PRD_PYTHON_RUNTIME_MANIFEST_V1_SCHEMA_VERSION =
  "ccc-prd.python-runtime-manifest.v1" as const;
export const CCC_PRD_EXECUTION_PROMPT_V1_SCHEMA_VERSION =
  "ccc-prd.execution-prompt.v1" as const;
export const CCC_PRD_EXECUTION_PROMPT_V2_SCHEMA_VERSION =
  "ccc-prd.execution-prompt.v2" as const;
export const CCC_PRD_IMPLEMENTATION_FACT_PROVENANCE_SCHEMA_VERSION =
  "ccc-prd.implementation-fact-provenance.v1" as const;

/** @deprecated Frozen v1 alias; use the version-specific proposal constant. */
export const CCC_PRD_AUTHORING_PROPOSAL_SCHEMA_VERSION =
  CCC_PRD_AUTHORING_PROPOSAL_V1_SCHEMA_VERSION;
/** @deprecated Frozen v1 alias; use the version-specific fragment constant. */
export const CCC_PRD_AUTHORING_PROPOSAL_FRAGMENT_SCHEMA_VERSION =
  CCC_PRD_AUTHORING_PROPOSAL_FRAGMENT_V1_SCHEMA_VERSION;
/** @deprecated Frozen v1 alias; use the version-specific sidecar constant. */
export const CCC_PRD_SIDECAR_SCHEMA_VERSION = CCC_PRD_SIDECAR_V1_SCHEMA_VERSION;
/** @deprecated Frozen v1 alias; use the version-specific bundle constant. */
export const CCC_PRD_BUNDLE_SCHEMA_VERSION = CCC_PRD_BUNDLE_V1_SCHEMA_VERSION;
/** @deprecated Frozen v1 alias; use the version-specific admission constant. */
export const CCC_PRD_PROOF_ADMISSION_SCHEMA_VERSION =
  CCC_PRD_PROOF_ADMISSION_V1_SCHEMA_VERSION;
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

type CccPrdProofAdmissionBase = {
  pluginId: string;
  pluginVersion: string;
  extensionId: string;
  proofVersion: string;
  extensionRootRelativeSource: string;
  extensionSourceSha256: string;
  extensionManifestSha256: string;
  definitionSha256: string;
};

export type CccPrdProofAdmissionV1 = CccPrdProofAdmissionBase & {
  schema: typeof CCC_PRD_PROOF_ADMISSION_V1_SCHEMA_VERSION;
};

export type CccPrdProofAdmissionV2 = CccPrdProofAdmissionBase & {
  schema: typeof CCC_PRD_PROOF_ADMISSION_V2_SCHEMA_VERSION;
  /** Canonical digest of the complete frozen verifier-closure set. */
  verifierClosureSha256: string;
  /** Canonical digest of the complete candidate-input path set. */
  candidateInputsSha256: string;
  /** Canonical digest of Task, Node, and proof-host execution identity. */
  executionToolchainSha256: string;
};

export type CccPrdProofAdmission = CccPrdProofAdmissionV1 | CccPrdProofAdmissionV2;

export type CccPrdExecutionPromptV1 = {
  schema: typeof CCC_PRD_EXECUTION_PROMPT_V1_SCHEMA_VERSION;
  content: string;
  sha256: string;
};

export type CccPrdExecutionPromptV2 = {
  schema: typeof CCC_PRD_EXECUTION_PROMPT_V2_SCHEMA_VERSION;
  content: string;
  sha256: string;
};

export type CccPrdExecutionPrompt = CccPrdExecutionPromptV1 | CccPrdExecutionPromptV2;

export type CccPrdAuthorityRole = {
  id: string;
  role: "root" | "production_module" | "blocking_test_index" | "support";
  sourcePaths: string[];
  accountableProducer: string;
};

export type CccPrdProofV1 = {
  /** A missing discriminator is part of the frozen v1 proof shape. */
  schema?: never;
  id: string;
  requirementIds: string[];
  command: string;
  positiveOracle: string;
  negativeControls: string[];
  spans: CccPrdSourceSpan[];
  confidence: CccPrdConfidence;
  admission?: CccPrdProofAdmissionV1;
};

export type CccPrdProofPhase = "task" | "final_integrated";

export type CccPrdProofCase = {
  id: string;
  description: string;
};

export type CccPrdVerifierClosureEntry = {
  role: "task_runner" | "harness" | "fixture" | "config";
  /** Canonical target-relative path at the frozen base. */
  path: string;
  /** Git object identity of the regular file at the frozen base. */
  baseGitBlobOid: string;
  /** SHA-256 of the exact frozen-base file bytes. */
  sha256: string;
};

export type CccPrdExecutableIdentity = {
  executablePath: string;
  executableSha256: string;
  version: string;
  versionOutputSha256: string;
};

export type CccPrdVerifierProfilePythonAdapterV1 = {
  schema: typeof CCC_PRD_VERIFIER_PYTHON_ADAPTER_V1_SCHEMA_VERSION;
  /** Target-relative adapter path, owned by verifierClosure. */
  adapterPath: string;
  /** Target-relative directory containing the adapter's closure-owned target. */
  targetPath: string;
};

export type CccPrdVerifierProfile = CccPrdVerifierProfilePythonAdapterV1;

export type CccPrdPythonRuntimeFile = {
  /** Controller-observed absolute path before sealing. */
  path: string;
  sha256: string;
  /** Original Mach-O dependency spellings that resolve to this file. */
  requestedPaths?: string[];
};

export type CccPrdPythonRuntimeManifestV1 = {
  schema: typeof CCC_PRD_PYTHON_RUNTIME_MANIFEST_V1_SCHEMA_VERSION;
  interpreter: CccPrdPythonRuntimeFile;
  /** Canonical controller-observed root containing the stdlib entries. */
  stdlibRoot: string;
  /** Canonical Python prefix used as PYTHONHOME (parent of stdlibRoot). */
  pythonHomeRoot: string;
  /** Canonical controller-observed purelib/platlib roots; kept bounded for PYTHONPATH. */
  sitePackagesRoots: string[];
  /** Canonical roots that contain extension modules; kept bounded for PYTHONPATH. */
  extensionModuleRoots: string[];
  /** Additional regular files required by framework-backed interpreters. */
  runtimeSupport: CccPrdPythonRuntimeFile[];
  stdlib: CccPrdPythonRuntimeFile[];
  sitePackages: CccPrdPythonRuntimeFile[];
  extensionModules: CccPrdPythonRuntimeFile[];
  dylibClosure: CccPrdPythonRuntimeFile[];
};

export type CccPrdPythonExecutionToolchain = CccPrdExecutableIdentity & {
  runtimeManifest: CccPrdPythonRuntimeManifestV1;
};

export type CccPrdProofHostIdentity = CccPrdExecutableIdentity & {
  id: string;
};

export type CccPrdLinkedRuntimeEntry = {
  platform: "darwin";
  loaderRole: "task" | "node" | "proof_host" | "linked_runtime";
  loaderPath: string;
  requestedPath: string;
  canonicalPath: string;
  sha256: string;
};

export type CccPrdProofExecutionToolchain = {
  task: CccPrdExecutableIdentity;
  node: CccPrdExecutableIdentity;
  proofHost: CccPrdProofHostIdentity;
  linkedRuntime: CccPrdLinkedRuntimeEntry[];
  /** Present only for the versioned Python-adapter verifier profile. */
  python?: CccPrdPythonExecutionToolchain;
};

export type CccPrdProofV2 = {
  schema: typeof CCC_PRD_PROOF_V2_SCHEMA_VERSION;
  id: string;
  requirementIds: string[];
  /** Exact accepted clauses this proof is authoritative for. */
  clauseIds: string[];
  /** Disjoint attempt phases admitted for this exact proof definition. */
  phases: CccPrdProofPhase[];
  command: string;
  /** Source-owned human summary retained for v1 implementation-fact provenance. */
  positiveOracle: string;
  positiveCases: CccPrdProofCase[];
  negativeControls: CccPrdProofCase[];
  verifierClosure: CccPrdVerifierClosureEntry[];
  candidateInputs: string[];
  executionToolchain: CccPrdProofExecutionToolchain;
  /** Absent preserves the frozen Node verifier contract byte-for-byte. */
  verifierProfile?: CccPrdVerifierProfile;
  spans: CccPrdSourceSpan[];
  confidence: CccPrdConfidence;
  admission?: CccPrdProofAdmissionV2;
};

export type CccPrdProof = CccPrdProofV1 | CccPrdProofV2;

export type CccPrdAcceptanceSourceSpan = CccPrdSourceSpan & {
  excerptSha256: string;
};

export type CccPrdAcceptanceClause = {
  id: string;
  requirementId: string;
  /** Exact, single-line source-owned acceptance text. */
  text: string;
  /** Executable proofs admitted to establish this exact clause. */
  proofIds: string[];
  /** Exact text-only source span, excluding the bullet prefix and line terminator. */
  span: CccPrdAcceptanceSourceSpan;
};

export type CccPrdAcceptanceDispositionKind = "deferred" | "excluded" | "unresolved";

export type CccPrdAcceptanceDisposition = {
  clauseId: string;
  requirementId: string;
  kind: CccPrdAcceptanceDispositionKind;
  reason: string;
  /** Exact reason-only source span, excluding the disposition prefix and line terminator. */
  span: CccPrdAcceptanceSourceSpan;
};

export type CccPrdRequirementV1 = {
  id: string;
  statement: string;
  acceptance: string;
  accountableProducer: string;
  dependencies: string[];
  proofIds: string[];
  spans: CccPrdSourceSpan[];
  confidence: CccPrdConfidence;
};

export type CccPrdRequirementV2 = CccPrdRequirementV1 & {
  acceptanceClauses: CccPrdAcceptanceClause[];
  acceptanceDispositions: CccPrdAcceptanceDisposition[];
};

export type CccPrdRequirement = CccPrdRequirementV1 | CccPrdRequirementV2;

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

type CccPrdSemanticDeclarationBase = {
  authorityRoles: CccPrdAuthorityRole[];
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

export type CccPrdSemanticDeclarationsV1 = CccPrdSemanticDeclarationBase & {
  requirements: CccPrdRequirementV1[];
  proofs: CccPrdProofV1[];
};

export type CccPrdSemanticDeclarationsV2 = CccPrdSemanticDeclarationBase & {
  requirements: CccPrdRequirementV2[];
  proofs: CccPrdProofV2[];
};

export type CccPrdSemanticDeclarations =
  | CccPrdSemanticDeclarationsV1
  | CccPrdSemanticDeclarationsV2;

type CccPrdSidecarBase = {
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

export type CccPrdSidecarV1 = CccPrdSemanticDeclarationsV1 & CccPrdSidecarBase & {
  schema: typeof CCC_PRD_SIDECAR_V1_SCHEMA_VERSION;
};

export type CccPrdSidecarV2 = CccPrdSemanticDeclarationsV2 & CccPrdSidecarBase & {
  schema: typeof CCC_PRD_SIDECAR_V2_SCHEMA_VERSION;
};

export type CccPrdSidecar = CccPrdSidecarV1 | CccPrdSidecarV2;

type CccPrdSemanticBundleBase = CccPrdSidecarBase & Omit<
  CccPrdSemanticDeclarationBase,
  "unresolvedDecisions" | "ambiguities" | "exceptions"
> & {
  kind: "bundle";
  sourceHash: string;
  sidecarHash: string;
  bundleHash: string;
};

export type CccPrdSemanticBundleV1 = CccPrdSemanticBundleBase & {
  schema: typeof CCC_PRD_BUNDLE_V1_SCHEMA_VERSION;
  requirements: CccPrdRequirementV1[];
  proofs: CccPrdProofV1[];
};

export type CccPrdSemanticBundleV2 = CccPrdSemanticBundleBase & {
  schema: typeof CCC_PRD_BUNDLE_V2_SCHEMA_VERSION;
  requirements: CccPrdRequirementV2[];
  proofs: CccPrdProofV2[];
};

export type CccPrdSemanticBundle = CccPrdSemanticBundleV1 | CccPrdSemanticBundleV2;

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

export type CccPrdProposalAcceptanceClause = Omit<CccPrdAcceptanceClause, "span"> & {
  sourceRefs: CccPrdSourceReferenceProposal[];
};

export type CccPrdProposalAcceptanceDisposition = Omit<
  CccPrdAcceptanceDisposition,
  "span"
> & {
  sourceRefs: CccPrdSourceReferenceProposal[];
};

export type CccPrdProposalRequirementV1 = Omit<CccPrdRequirementV1, "spans"> & {
  sourceRefs: CccPrdSourceReferenceProposal[];
};

export type CccPrdProposalRequirementV2 = Omit<
  CccPrdRequirementV2,
  "spans" | "acceptanceClauses" | "acceptanceDispositions"
> & {
  acceptanceClauses: CccPrdProposalAcceptanceClause[];
  acceptanceDispositions: CccPrdProposalAcceptanceDisposition[];
  sourceRefs: CccPrdSourceReferenceProposal[];
};

export type CccPrdProposalRequirement =
  | CccPrdProposalRequirementV1
  | CccPrdProposalRequirementV2;

export type CccPrdProposalProofV1 = Omit<CccPrdProofV1, "spans" | "admission"> & {
  sourceRefs: CccPrdSourceReferenceProposal[];
};

export type CccPrdProposalProofV2 = Omit<CccPrdProofV2, "spans" | "admission"> & {
  sourceRefs: CccPrdSourceReferenceProposal[];
};

export type CccPrdProposalProof = CccPrdProposalProofV1 | CccPrdProposalProofV2;

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

type CccPrdAuthoringProposalBase = Omit<
  CccPrdSemanticDeclarationBase,
  | "tasks" | "workflows" | "documents" | "artifacts" | "protectedActions"
  | "unresolvedDecisions" | "ambiguities" | "exceptions"
> & {
  tasks: CccPrdProposalTask[];
  workflows: CccPrdProposalWorkflow[];
  documents: CccPrdProposalDocument[];
  artifacts: CccPrdProposalArtifact[];
  protectedActions: CccPrdProposalProtectedAction[];
  unresolvedDecisions: CccPrdProposalUnresolvedDecision[];
  ambiguities: CccPrdProposalReviewItem[];
  exceptions: CccPrdProposalReviewItem[];
};

export type CccPrdAuthoringProposalV1 = CccPrdAuthoringProposalBase & {
  schema: typeof CCC_PRD_AUTHORING_PROPOSAL_V1_SCHEMA_VERSION;
  requirements: CccPrdProposalRequirementV1[];
  proofs: CccPrdProposalProofV1[];
};

export type CccPrdAuthoringProposalV2 = CccPrdAuthoringProposalBase & {
  schema: typeof CCC_PRD_AUTHORING_PROPOSAL_V2_SCHEMA_VERSION;
  requirements: CccPrdProposalRequirementV2[];
  proofs: CccPrdProposalProofV2[];
};

export type CccPrdAuthoringProposal = CccPrdAuthoringProposalV1 | CccPrdAuthoringProposalV2;

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
type CccPrdAuthoringProposalFragmentBase = {
  authorityRoles: CccPrdFragmentRow<CccPrdAuthorityRole>[];
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

export type CccPrdAuthoringProposalFragmentV1 = CccPrdAuthoringProposalFragmentBase & {
  schema: typeof CCC_PRD_AUTHORING_PROPOSAL_FRAGMENT_V1_SCHEMA_VERSION;
  requirements: CccPrdFragmentRow<CccPrdProposalRequirementV1>[];
  proofs: CccPrdFragmentRow<CccPrdProposalProofV1>[];
};

export type CccPrdAuthoringProposalFragmentV2 = CccPrdAuthoringProposalFragmentBase & {
  schema: typeof CCC_PRD_AUTHORING_PROPOSAL_FRAGMENT_V2_SCHEMA_VERSION;
  requirements: CccPrdFragmentRow<CccPrdProposalRequirementV2>[];
  proofs: CccPrdFragmentRow<CccPrdProposalProofV2>[];
};

export type CccPrdAuthoringProposalFragment =
  | CccPrdAuthoringProposalFragmentV1
  | CccPrdAuthoringProposalFragmentV2;

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
  /** Omission preserves the frozen v1 authoring route. */
  semanticProofContract?: CccPrdSemanticProofContractVersion;
  constraints?: CccPrdAuthoringConstraints;
  previousSidecar?: CccPrdSidecar;
};

export type CccPrdSemanticProofContractVersion = "v1" | "v2";

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
