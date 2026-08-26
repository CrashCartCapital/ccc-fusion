export {
  authorCccPrdPacket,
  validateCccPrdImplementationFactProvenance,
  validateCccPrdPacketImplementationFactProvenance,
} from "./authoring.js";
export type { AuthorCccPrdInput } from "./authoring.js";
export {
  createNativeCccPrdAuthoringAdapter,
  fusionModelRuntimeAuthoringTransport,
} from "./native-authoring-adapter.js";
export type {
  CccPrdNativeAuthoringMode,
  CccPrdNativeAuthoringTransport,
  CccPrdNativeAuthoringTransportRequest,
  CccPrdNativeAuthoringTransportResponse,
  CreateNativeCccPrdAuthoringAdapterOptions,
} from "./native-authoring-adapter.js";
export {
  CCC_PRD_UNDERSTANDING_REVIEW_SCHEMA_VERSION,
  understandCccPrdPacket,
} from "./understanding.js";
export type {
  CccPrdUnderstandingMissingFact,
  CccPrdUnderstandingResult,
  CccPrdUnderstandingReview,
  UnderstandCccPrdInput,
} from "./understanding.js";
// Quote matching. `CccPrdQuoteReview` is the operator-facing half: it rides
// the understanding result and the CLI's printed JSON wrapper, never the
// persisted sidecar, and it is what makes fuzzy matching accountable.
export {
  CCC_PRD_RUN_QUOTE_MATCH_POLICY,
  DEFAULT_CCC_PRD_QUOTE_MATCH_POLICY,
} from "./anchor-resolver.js";
export type { CccPrdQuoteMatchPolicy } from "./anchor-resolver.js";
export type { CccPrdFuzzyQuoteReviewNotice } from "./chunk-verification.js";
export type { CccPrdQuoteReview } from "./chunk-orchestrator.js";
export { compileCccPrdPacket, validateCccPrdPacket, validateNeoCandidate } from "./compiler.js";
export type { CompileCccPrdInput } from "./compiler.js";
export {
  CCC_PRD_OPERATOR_CONTEXT_ORIGIN,
  CCC_PRD_OPERATOR_CONTEXT_INTERNAL_WRITE_PURPOSE,
  CCC_PRD_OPERATOR_CONTEXT_INTERNAL_WRITE_ROOT,
  CCC_PRD_OPERATOR_CONTEXT_SCHEMA_VERSION,
  CCC_PRD_OPERATOR_CONTEXT_SOURCE_PATH,
  CccPrdOperatorContextError,
  assertCccPrdOperatorContextCompatible,
  parseCccPrdOperatorContext,
  renderCccPrdOperatorContextMarkdown,
} from "./operator-context.js";
export type { CccPrdOperatorContext } from "./operator-context.js";
export {
  CCC_PRD_OSS_REUSE_EVALUATOR_VERSION,
  evaluateCccPrdOssReuseAdmission,
  recordCccPrdOssReferenceLearning,
  selectCccPrdOssPackage,
} from "./oss-reuse-admission.js";
export type {
  CccPrdOssCandidateDiagnostic,
  CccPrdOssPackageSelection,
  CccPrdOssReferenceLearning,
  CccPrdOssReuseDecisionKind,
  CccPrdOssReuseRecommendation,
} from "./oss-reuse-admission.js";
