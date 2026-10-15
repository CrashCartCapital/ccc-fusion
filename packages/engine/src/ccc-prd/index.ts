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
export {
  compileCccPrdPacket,
  diagnoseCccPrdProductGraphAdmission,
  validateCccPrdPacket,
  validateNeoCandidate,
} from "./compiler.js";
export type { CccPrdProductGraphAdmissionInput, CompileCccPrdInput } from "./compiler.js";
// Planning (G4 and the import bridge) reuses the freeze path's packet writer.
export { writeCccPrdPacketFiles } from "./intake.js";
export type { CccPrdPacketSourceInput } from "./intake.js";
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
// FNXC:CccPlanning 2026-10-14-22:25 (INT-3a, D34 parent barrel): card B3 moved the `fn prd import` packet and
// target preflight into one engine module that the planning import bridge shares; the CLI reads it through this barrel.
export {
  CCC_PRD_PRODUCT_PREVIEW_SCHEMA,
  CccPrdProductPreflightError,
  assertCccPrdProductBundleComplete,
  assertCccPrdProductRequestBudgetFloor,
  cccPrdProductRequestBudget,
  compileCccPrdProductBundle,
  computeCccPrdProductConfirmationDigest,
  createCccPrdProductPreviewIdentity,
  preflightCccPrdProductPacket,
  preflightCccPrdProductTarget,
} from "./product-import-preflight.js";
export type {
  CccPrdProductCompileRefusal,
  CccPrdProductExecutionPlanReader,
  CccPrdProductImportPreflightDependencies,
  CccPrdProductPacketPreflight,
  CccPrdProductPacketPreflightInput,
  CccPrdProductPreviewIdentity,
  CccPrdProductRequestBudget,
  CccPrdProductTargetPreflight,
} from "./product-import-preflight.js";
