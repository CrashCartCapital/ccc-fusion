import { createHash } from "node:crypto";
import { canonicalCccPrdJson, compareCccPrdCodeUnits } from "./contract.js";

export const CCC_PRD_OSS_REUSE_EVIDENCE_SCHEMA_VERSION =
  "ccc-prd.oss-reuse-evidence.v1" as const;

export const CCC_PRD_OSS_REUSE_POLICY_V1 = Object.freeze({
  closeMatchMinCoveragePercent: 80,
  partialMatchMinCoveragePercent: 40,
  maxPartialTouchedFiles: 50,
  maxCanonicalPacketBytes: 1024 * 1024,
} as const);

export type CccPrdOssEvidenceState = "unknown" | "declared" | "offline_proven";
export type CccPrdOssEvidenceOutcome = "unknown" | "pass" | "fail";
export type CccPrdOssReuseProjectMode =
  | "greenfield_standalone"
  | "existing_project_change"
  | "unknown";
export type CccPrdOssReuseKind =
  | "application_base"
  | "package_dependency"
  | "reference_only";
export type CccPrdOssCostConfidence =
  | "unknown"
  | "bounded_estimate"
  | "pilot_measured";

export type CccPrdOssGateEvidence = Readonly<{
  state: CccPrdOssEvidenceState;
  outcome: CccPrdOssEvidenceOutcome;
}>;

export type CccPrdOssReuseCostEstimate = Readonly<{
  initialAdoptionHours: number;
  adaptationHours: number;
  annualMaintenanceHours: number;
  annualSecurityHours: number;
  horizonYears: number;
  totalOwnershipHours: number;
  confidence: CccPrdOssCostConfidence;
  evidenceIds: readonly string[];
  receiptSha256: string;
}>;

export type CccPrdOssAdaptationPlan = Readonly<{
  changedAreas: readonly string[];
  adaptationHours: number;
  maxTouchedFiles: number;
}>;

export type CccPrdOssProjectEvidence = Readonly<{
  repositoryId: string;
  gitState: "initialized" | "not_initialized" | "unknown";
  fusionMarker: "absent" | "present" | "malformed" | "unknown";
  applicationState: "absent" | "present" | "unknown";
  snapshotSha256: string;
}>;

export type CccPrdOssReuseCandidateEvidence = Readonly<{
  kind: "application_base" | "package_dependency";
  id: string;
  repository: Readonly<{
    repositoryId: string;
    revision: string;
    treeSha256: string;
  }>;
  licenseExpression: string;
  gates: Readonly<{
    license: CccPrdOssGateEvidence;
    sourceProvenance: CccPrdOssGateEvidence;
    staticSafety: CccPrdOssGateEvidence;
    reproducibleBootstrap: CccPrdOssGateEvidence;
    tests: CccPrdOssGateEvidence;
  }>;
  coveredCapabilities: readonly string[];
  architecture: Readonly<{
    introducesApplicationLifecycleOwner: boolean;
    introducesSecondaryRuntimeOwner: boolean;
  }>;
  deadWeightPercent: number;
  baseOwnershipCost: CccPrdOssReuseCostEstimate;
  adaptationPlan: CccPrdOssAdaptationPlan | null;
}>;

export type CccPrdOssReferenceEvidence = Readonly<{
  kind: "reference_only";
  id: string;
  repository: Readonly<{
    repositoryId: string;
    revision: string;
    treeSha256: string;
  }>;
  sourceProvenance: CccPrdOssGateEvidence;
  claims: readonly string[];
}>;

export type CccPrdOssReuseEvidence = Readonly<{
  schema: typeof CCC_PRD_OSS_REUSE_EVIDENCE_SCHEMA_VERSION;
  project: CccPrdOssProjectEvidence;
  reuseKind: CccPrdOssReuseKind;
  boundedCapability: string | null;
  requiredCapabilities: readonly string[];
  criticalCapabilities: readonly string[];
  discovery: Readonly<{
    status: "not_applicable" | "completed" | "failed";
    candidatesConsidered: number;
    positiveControl: CccPrdOssEvidenceOutcome;
    negativeControl: CccPrdOssEvidenceOutcome;
  }>;
  scratchCost: CccPrdOssReuseCostEstimate | null;
  candidates: readonly (
    CccPrdOssReuseCandidateEvidence | CccPrdOssReferenceEvidence
  )[];
}>;

export class CccPrdOssReuseContractError extends Error {
  public readonly code = "CCC_PRD_OSS_REUSE_EVIDENCE_INVALID" as const;

  constructor(message: string) {
    super(message);
    this.name = "CccPrdOssReuseContractError";
  }
}

const EVIDENCE_STATES = ["unknown", "declared", "offline_proven"] as const;
const EVIDENCE_OUTCOMES = ["unknown", "pass", "fail"] as const;
const COST_CONFIDENCE = ["unknown", "bounded_estimate", "pilot_measured"] as const;

function refuse(path: string, message: string): never {
  throw new CccPrdOssReuseContractError(`${path}: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) refuse(path, "must be a plain object");
  return value;
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  path: string,
): void {
  const actual = Object.keys(value).sort(compareCccPrdCodeUnits);
  const expected = [...keys].sort(compareCccPrdCodeUnits);
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    refuse(path, `fields must be exactly ${expected.join(", ")}`);
  }
}

function text(value: unknown, path: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value !== value.trim()
    || value.includes("\n")
    || value.includes("\r")
    || value.includes("\0")
  ) {
    refuse(path, "must be one non-empty trimmed line");
  }
  return value;
}

function oneOf<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  path: string,
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    refuse(path, `must be one of ${allowed.join(", ")}`);
  }
  return value as T[number];
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") refuse(path, "must be boolean");
  return value;
}

function integer(
  value: unknown,
  path: string,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    refuse(path, `must be a safe integer from 0 through ${maximum}`);
  }
  return value as number;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hash(value: unknown, path: string): string {
  const candidate = text(value, path);
  if (!/^[0-9a-f]{64}$/u.test(candidate)) {
    refuse(path, "must be lowercase 64-hex SHA-256");
  }
  return candidate;
}

function stringSet(value: unknown, path: string, allowEmpty = false): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    refuse(path, allowEmpty ? "must be an array" : "must be a non-empty array");
  }
  const values = value.map((entry, index) => text(entry, `${path}[${index}]`));
  if (new Set(values).size !== values.length) refuse(path, "must not contain duplicates");
  return values.sort(compareCccPrdCodeUnits);
}

function gate(value: unknown, path: string): CccPrdOssGateEvidence {
  const input = record(value, path);
  exactKeys(input, ["outcome", "state"], path);
  const state = oneOf(input.state, EVIDENCE_STATES, `${path}.state`);
  const outcome = oneOf(input.outcome, EVIDENCE_OUTCOMES, `${path}.outcome`);
  if ((state === "unknown") !== (outcome === "unknown")) {
    refuse(path, "unknown state and outcome must appear together");
  }
  return { state, outcome };
}

function costProjection(cost: Omit<CccPrdOssReuseCostEstimate, "receiptSha256">) {
  return {
    initialAdoptionHours: cost.initialAdoptionHours,
    adaptationHours: cost.adaptationHours,
    annualMaintenanceHours: cost.annualMaintenanceHours,
    annualSecurityHours: cost.annualSecurityHours,
    horizonYears: cost.horizonYears,
    totalOwnershipHours: cost.totalOwnershipHours,
    confidence: cost.confidence,
    evidenceIds: [...cost.evidenceIds].sort(compareCccPrdCodeUnits),
  };
}

function cost(value: unknown, path: string): CccPrdOssReuseCostEstimate {
  const input = record(value, path);
  exactKeys(input, [
    "adaptationHours",
    "annualMaintenanceHours",
    "annualSecurityHours",
    "confidence",
    "evidenceIds",
    "horizonYears",
    "initialAdoptionHours",
    "receiptSha256",
    "totalOwnershipHours",
  ], path);
  const parsed = {
    initialAdoptionHours: integer(input.initialAdoptionHours, `${path}.initialAdoptionHours`),
    adaptationHours: integer(input.adaptationHours, `${path}.adaptationHours`),
    annualMaintenanceHours: integer(input.annualMaintenanceHours, `${path}.annualMaintenanceHours`),
    annualSecurityHours: integer(input.annualSecurityHours, `${path}.annualSecurityHours`),
    horizonYears: integer(input.horizonYears, `${path}.horizonYears`, 100),
    totalOwnershipHours: integer(input.totalOwnershipHours, `${path}.totalOwnershipHours`),
    confidence: oneOf(input.confidence, COST_CONFIDENCE, `${path}.confidence`),
    evidenceIds: stringSet(input.evidenceIds, `${path}.evidenceIds`, true),
  } satisfies Omit<CccPrdOssReuseCostEstimate, "receiptSha256">;
  const expectedTotal = parsed.initialAdoptionHours + parsed.adaptationHours
    + parsed.horizonYears * (parsed.annualMaintenanceHours + parsed.annualSecurityHours);
  if (!Number.isSafeInteger(expectedTotal) || parsed.totalOwnershipHours !== expectedTotal) {
    refuse(`${path}.totalOwnershipHours`, `must equal recomputed total ${expectedTotal}`);
  }
  if (parsed.confidence === "unknown") {
    const numericTotal = parsed.initialAdoptionHours + parsed.adaptationHours
      + parsed.annualMaintenanceHours + parsed.annualSecurityHours + parsed.horizonYears;
    if (numericTotal !== 0 || parsed.evidenceIds.length !== 0) {
      refuse(path, "unknown cost confidence requires zero components and no evidence IDs");
    }
  } else if (parsed.evidenceIds.length === 0) {
    refuse(`${path}.evidenceIds`, "must be non-empty for a usable cost estimate");
  }
  const receiptSha256 = hash(input.receiptSha256, `${path}.receiptSha256`);
  const expectedReceipt = sha256(canonicalCccPrdJson(costProjection(parsed)));
  if (receiptSha256 !== expectedReceipt) {
    refuse(`${path}.receiptSha256`, `does not match recomputed receipt ${expectedReceipt}`);
  }
  return { ...parsed, receiptSha256 };
}

function project(value: unknown): CccPrdOssProjectEvidence {
  const path = "$.project";
  const input = record(value, path);
  exactKeys(input, [
    "applicationState",
    "fusionMarker",
    "gitState",
    "repositoryId",
    "snapshotSha256",
  ], path);
  return {
    repositoryId: text(input.repositoryId, `${path}.repositoryId`),
    gitState: oneOf(input.gitState, ["initialized", "not_initialized", "unknown"] as const, `${path}.gitState`),
    fusionMarker: oneOf(input.fusionMarker, ["absent", "present", "malformed", "unknown"] as const, `${path}.fusionMarker`),
    applicationState: oneOf(input.applicationState, ["absent", "present", "unknown"] as const, `${path}.applicationState`),
    snapshotSha256: hash(input.snapshotSha256, `${path}.snapshotSha256`),
  };
}

function repository(value: unknown, path: string) {
  const input = record(value, path);
  exactKeys(input, ["repositoryId", "revision", "treeSha256"], path);
  return {
    repositoryId: text(input.repositoryId, `${path}.repositoryId`),
    revision: text(input.revision, `${path}.revision`),
    treeSha256: hash(input.treeSha256, `${path}.treeSha256`),
  };
}

function codeCandidate(value: Record<string, unknown>, path: string): CccPrdOssReuseCandidateEvidence {
  exactKeys(value, [
    "adaptationPlan",
    "architecture",
    "baseOwnershipCost",
    "coveredCapabilities",
    "deadWeightPercent",
    "gates",
    "id",
    "kind",
    "licenseExpression",
    "repository",
  ], path);
  const kind = oneOf(value.kind, ["application_base", "package_dependency"] as const, `${path}.kind`);
  const gates = record(value.gates, `${path}.gates`);
  exactKeys(gates, ["license", "reproducibleBootstrap", "sourceProvenance", "staticSafety", "tests"], `${path}.gates`);
  const architecture = record(value.architecture, `${path}.architecture`);
  exactKeys(architecture, ["introducesApplicationLifecycleOwner", "introducesSecondaryRuntimeOwner"], `${path}.architecture`);
  let adaptationPlan: CccPrdOssAdaptationPlan | null = null;
  if (value.adaptationPlan !== null) {
    const plan = record(value.adaptationPlan, `${path}.adaptationPlan`);
    exactKeys(plan, ["adaptationHours", "changedAreas", "maxTouchedFiles"], `${path}.adaptationPlan`);
    adaptationPlan = {
      changedAreas: stringSet(plan.changedAreas, `${path}.adaptationPlan.changedAreas`),
      adaptationHours: integer(plan.adaptationHours, `${path}.adaptationPlan.adaptationHours`),
      maxTouchedFiles: integer(plan.maxTouchedFiles, `${path}.adaptationPlan.maxTouchedFiles`),
    };
  }
  return {
    kind,
    id: text(value.id, `${path}.id`),
    repository: repository(value.repository, `${path}.repository`),
    licenseExpression: text(value.licenseExpression, `${path}.licenseExpression`),
    gates: {
      license: gate(gates.license, `${path}.gates.license`),
      sourceProvenance: gate(gates.sourceProvenance, `${path}.gates.sourceProvenance`),
      staticSafety: gate(gates.staticSafety, `${path}.gates.staticSafety`),
      reproducibleBootstrap: gate(gates.reproducibleBootstrap, `${path}.gates.reproducibleBootstrap`),
      tests: gate(gates.tests, `${path}.gates.tests`),
    },
    coveredCapabilities: stringSet(value.coveredCapabilities, `${path}.coveredCapabilities`, true),
    architecture: {
      introducesApplicationLifecycleOwner: booleanValue(architecture.introducesApplicationLifecycleOwner, `${path}.architecture.introducesApplicationLifecycleOwner`),
      introducesSecondaryRuntimeOwner: booleanValue(architecture.introducesSecondaryRuntimeOwner, `${path}.architecture.introducesSecondaryRuntimeOwner`),
    },
    deadWeightPercent: integer(value.deadWeightPercent, `${path}.deadWeightPercent`, 100),
    baseOwnershipCost: cost(value.baseOwnershipCost, `${path}.baseOwnershipCost`),
    adaptationPlan,
  };
}

function referenceCandidate(value: Record<string, unknown>, path: string): CccPrdOssReferenceEvidence {
  exactKeys(value, ["claims", "id", "kind", "repository", "sourceProvenance"], path);
  return {
    kind: "reference_only",
    id: text(value.id, `${path}.id`),
    repository: repository(value.repository, `${path}.repository`),
    sourceProvenance: gate(value.sourceProvenance, `${path}.sourceProvenance`),
    claims: stringSet(value.claims, `${path}.claims`),
  };
}

function candidate(value: unknown, path: string) {
  const input = record(value, path);
  if (input.kind === "reference_only") return referenceCandidate(input, path);
  return codeCandidate(input, path);
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

export function classifyCccPrdOssReuseProject(
  evidence: CccPrdOssProjectEvidence,
): CccPrdOssReuseProjectMode {
  if (
    evidence.fusionMarker === "present"
    || evidence.fusionMarker === "malformed"
    || evidence.applicationState === "present"
  ) return "existing_project_change";
  if (
    evidence.gitState === "unknown"
    || evidence.fusionMarker === "unknown"
    || evidence.applicationState === "unknown"
  ) return "unknown";
  return "greenfield_standalone";
}

export function parseCccPrdOssReuseEvidence(
  value: unknown,
): CccPrdOssReuseEvidence {
  const input = record(value, "$");
  exactKeys(input, [
    "boundedCapability",
    "candidates",
    "criticalCapabilities",
    "discovery",
    "project",
    "requiredCapabilities",
    "reuseKind",
    "schema",
    "scratchCost",
  ], "$");
  if (input.schema !== CCC_PRD_OSS_REUSE_EVIDENCE_SCHEMA_VERSION) {
    refuse("$.schema", `must be ${CCC_PRD_OSS_REUSE_EVIDENCE_SCHEMA_VERSION}`);
  }
  const reuseKind = oneOf(input.reuseKind, ["application_base", "package_dependency", "reference_only"] as const, "$.reuseKind");
  const requiredCapabilities = stringSet(input.requiredCapabilities, "$.requiredCapabilities", reuseKind === "reference_only");
  const criticalCapabilities = stringSet(input.criticalCapabilities, "$.criticalCapabilities", reuseKind === "reference_only");
  if (criticalCapabilities.some((capability) => !requiredCapabilities.includes(capability))) {
    refuse("$.criticalCapabilities", "must be a subset of requiredCapabilities");
  }
  const boundedCapability = input.boundedCapability === null
    ? null
    : text(input.boundedCapability, "$.boundedCapability");
  if (reuseKind === "package_dependency") {
    if (
      requiredCapabilities.length !== 1
      || criticalCapabilities.length !== 1
      || boundedCapability !== requiredCapabilities[0]
    ) {
      refuse("$.boundedCapability", "package reuse requires one matching required and critical capability");
    }
  } else if (boundedCapability !== null) {
    refuse("$.boundedCapability", "must be null outside package reuse");
  }
  if (reuseKind === "reference_only" && (requiredCapabilities.length > 0 || criticalCapabilities.length > 0)) {
    refuse("$.requiredCapabilities", "reference-only evidence must not carry capability scoring");
  }
  const discoveryInput = record(input.discovery, "$.discovery");
  exactKeys(discoveryInput, ["candidatesConsidered", "negativeControl", "positiveControl", "status"], "$.discovery");
  const discovery = {
    status: oneOf(discoveryInput.status, ["not_applicable", "completed", "failed"] as const, "$.discovery.status"),
    candidatesConsidered: integer(discoveryInput.candidatesConsidered, "$.discovery.candidatesConsidered"),
    positiveControl: oneOf(discoveryInput.positiveControl, EVIDENCE_OUTCOMES, "$.discovery.positiveControl"),
    negativeControl: oneOf(discoveryInput.negativeControl, EVIDENCE_OUTCOMES, "$.discovery.negativeControl"),
  };
  if (!Array.isArray(input.candidates)) refuse("$.candidates", "must be an array");
  const candidateEntries = input.candidates.map((entry, index) => ({
    candidate: candidate(entry, `$.candidates[${index}]`),
    originalIndex: index,
  }));
  const candidateIds = candidateEntries.map(({ candidate: entry }) => entry.id);
  if (new Set(candidateIds).size !== candidateIds.length) refuse("$.candidates", "candidate IDs must be unique");
  for (const { candidate: entry, originalIndex } of candidateEntries) {
    if (entry.kind !== reuseKind) refuse(`$.candidates[${originalIndex}].kind`, `must match reuseKind ${reuseKind}`);
    if (entry.kind !== "reference_only" && entry.coveredCapabilities.some((item) => !requiredCapabilities.includes(item))) {
      refuse(`$.candidates[${originalIndex}].coveredCapabilities`, "must be a subset of requiredCapabilities");
    }
  }
  const candidates = candidateEntries
    .map(({ candidate: entry }) => entry)
    .sort((left, right) => compareCccPrdCodeUnits(left.id, right.id));
  const scratchCost = input.scratchCost === null ? null : cost(input.scratchCost, "$.scratchCost");
  if (reuseKind === "reference_only") {
    if (scratchCost !== null) refuse("$.scratchCost", "must be null for reference-only evidence");
  } else {
    if (!scratchCost) refuse("$.scratchCost", "must be present for code reuse");
    for (const { candidate: entry, originalIndex } of candidateEntries) {
      if (entry.kind !== "reference_only" && entry.baseOwnershipCost.horizonYears !== scratchCost.horizonYears) {
        refuse(`$.candidates[${originalIndex}].baseOwnershipCost.horizonYears`, "must match scratchCost.horizonYears");
      }
    }
  }
  const evidenceIds = [
    ...(scratchCost?.evidenceIds ?? []),
    ...candidates.flatMap((entry) => entry.kind === "reference_only" ? [] : entry.baseOwnershipCost.evidenceIds),
  ];
  if (new Set(evidenceIds).size !== evidenceIds.length) refuse("$", "cost evidence IDs must be unique across the packet");
  const normalized: CccPrdOssReuseEvidence = {
    schema: CCC_PRD_OSS_REUSE_EVIDENCE_SCHEMA_VERSION,
    project: project(input.project),
    reuseKind,
    boundedCapability,
    requiredCapabilities,
    criticalCapabilities,
    discovery,
    scratchCost,
    candidates,
  };
  const canonical = canonicalCccPrdJson(normalized);
  if (Buffer.byteLength(canonical, "utf8") > CCC_PRD_OSS_REUSE_POLICY_V1.maxCanonicalPacketBytes) {
    refuse("$", `canonical packet exceeds ${CCC_PRD_OSS_REUSE_POLICY_V1.maxCanonicalPacketBytes} bytes`);
  }
  return deepFreeze(normalized);
}

export function canonicalizeCccPrdOssReuseEvidence(
  evidence: CccPrdOssReuseEvidence,
): string {
  return canonicalCccPrdJson(evidence);
}

export function computeCccPrdOssReuseEvidenceSha256(
  evidence: CccPrdOssReuseEvidence,
): string {
  return sha256(canonicalizeCccPrdOssReuseEvidence(evidence));
}
