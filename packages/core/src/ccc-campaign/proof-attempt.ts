import { createHash, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  canonicalCccPrdJson,
  computeCccPrdProofDefinitionSha256,
  computeCccPrdProofV2AdmissionDigests,
} from "../ccc-prd/contract.js";
import type { AsyncDataLayer, DbTransaction } from "../postgres/data-layer.js";
import * as schema from "../postgres/schema/index.js";
import { createCccCampaignAuthorityBinding } from "./canonical.js";
import {
  reconstructCccCampaignCustody,
  type ReconstructedCccCampaignCustody,
} from "./custody.js";
import { loadCccCampaignContextForTask } from "./store.js";
import {
  CCC_CAMPAIGN_PROOF_ATTEMPT_SCHEMA_VERSION,
  CCC_CAMPAIGN_PROOF_ATTEMPT_CONTRACT_V1,
  CCC_CAMPAIGN_PROOF_ATTEMPT_CONTRACT_V2,
  CCC_CAMPAIGN_PROOF_ATTEMPT_V2_SCHEMA_VERSION,
  CCC_PRD_PROOF_EVIDENCE_V2_SCHEMA_VERSION,
  CCC_PRD_PROOF_TERMINAL_ENVELOPE_V2_SCHEMA_VERSION,
  CccCampaignContextError,
  CccCampaignProofAttemptCollisionError,
  CccCampaignProofAttemptIdentityError,
  CccCampaignProofAttemptLimitError,
  CccCampaignProofAttemptStateError,
  type CccCampaignProofAttempt,
  type CccCampaignProofAttemptDispatchDecision,
  type CccCampaignProofAttemptScope,
  type CccCampaignProofAttemptContractVersion,
  type CccCampaignProofExecutionResult,
  type CccCampaignProofExecutionResultInput,
  type CccCampaignProofEvidenceClauseResult,
  type CccCampaignProofEvidenceNegativeControlResult,
  type CccCampaignProofEvidencePositiveCaseResult,
  type CccCampaignProofEvidenceV2,
  type CccCampaignProofExecutionRefusalCode,
  type CccCampaignProofTerminalEnvelopeV2,
  type CccCampaignProofWorkItemFence,
  type CccCampaignTaskContext,
} from "./types.js";
import type { CccPrdProofPhase, CccPrdProofV2 } from "../ccc-prd/types.js";

const ATTEMPT_KEY_PATTERN = /^ccc-proof-attempt-[0-9a-f]{64}$/;
const CONTROLLER_TOKEN_PATTERN = /^ccc-proof-controller-[0-9a-f-]{36}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const GIT_OBJECT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const OUTPUT_TAIL_CHARS = 8_000;
const MAX_WARNINGS = 64;
const MAX_WARNING_CHARS = 2_000;
const MAX_NEGATIVE_CONTROL_LABEL_CHARS = 512;
const MAX_PROOF_EVIDENCE_BYTES = 131_072;
const MAX_TERMINAL_ENVELOPE_BYTES = 262_144;
const MAX_PROOF_EVIDENCE_RESULTS = 4_096;

const EXECUTION_REFUSAL_CODES: ReadonlySet<CccCampaignProofExecutionRefusalCode> =
  new Set([
    "timeout",
    "killed",
    "no_output",
    "malformed_output",
    "output_over_limit",
    "spawn_refused",
    "sandbox_refused",
  ]);

type ProofAttemptRow =
  typeof schema.project.cccCampaignProofAttempts.$inferSelect;

type TransactionalInput = Readonly<{
  layer: AsyncDataLayer;
  tx?: DbTransaction;
}>;

type CccCampaignProofEvidenceExpectedSets = Readonly<{
  clauseIds: readonly string[];
  positiveCaseIds: readonly string[];
  negativeControlIds: readonly string[];
}>;

type ReserveCccCampaignProofAttemptCommonInput = TransactionalInput & Readonly<{
  rootDir: string;
  taskId: string;
  proofId: string;
  sourceCommit: string;
  sourceTree: string;
  workItemFence: CccCampaignProofWorkItemFence;
}>;

export type ReserveCccCampaignProofAttemptInput =
  ReserveCccCampaignProofAttemptCommonInput
  & (
    | Readonly<{
      attemptContractVersion?: typeof CCC_CAMPAIGN_PROOF_ATTEMPT_CONTRACT_V1;
      scope?: CccCampaignProofAttemptScope;
      phase?: never;
      verifierClosureSha256?: never;
      candidateInputsSha256?: never;
      executionToolchainSha256?: never;
    }>
    | Readonly<{
      attemptContractVersion: typeof CCC_CAMPAIGN_PROOF_ATTEMPT_CONTRACT_V2;
      phase: CccPrdProofPhase;
      scope?: never;
      verifierClosureSha256: string;
      candidateInputsSha256: string;
      executionToolchainSha256: string;
    }>
  );

export type TransitionCccCampaignProofAttemptInput = TransactionalInput & Readonly<{
  attemptKey: string;
  controllerToken: string;
}>;

export type SettleCccCampaignProofAttemptInput =
  TransitionCccCampaignProofAttemptInput
  & (
    | Readonly<{
      result: CccCampaignProofExecutionResultInput;
      terminalEnvelope?: never;
    }>
    | Readonly<{
      result?: never;
      terminalEnvelope: CccCampaignProofTerminalEnvelopeV2;
    }>
  );

export type InspectCccCampaignProofAttemptInput = TransactionalInput & Readonly<{
  attemptKey: string;
}>;

export type ListCccCampaignProofAttemptsForCommitInput =
  TransactionalInput
  & Readonly<{
    importId: string;
    campaignId: string;
    taskId: string;
    sourceCommit: string;
  }>;

function projectIdFor(layer: AsyncDataLayer): string {
  return layer.projectId?.trim() || "__legacy_unscoped__";
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype
      || Object.getPrototypeOf(value) === null);
}

function requireExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (canonicalCccPrdJson(actual) !== canonicalCccPrdJson(expected)) {
    throw new CccCampaignProofAttemptIdentityError(
      `CCC campaign proof attempt ${label} has unknown or missing fields`,
    );
  }
}

function requireBoundedCanonicalJson(
  value: unknown,
  label: string,
  maximumBytes: number,
): string {
  let canonical: string;
  try {
    canonical = canonicalCccPrdJson(value);
  } catch {
    throw new CccCampaignProofAttemptIdentityError(
      `CCC campaign proof attempt ${label} must be canonical JSON`,
    );
  }
  if (Buffer.byteLength(canonical, "utf8") > maximumBytes) {
    throw new CccCampaignProofAttemptIdentityError(
      `CCC campaign proof attempt ${label} exceeds its canonical JSON byte limit`,
    );
  }
  return canonical;
}

function requireCanonicalText(
  value: unknown,
  label: string,
  maximumLength = Number.POSITIVE_INFINITY,
): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value !== value.trim()
    || value.length > maximumLength
  ) {
    throw new CccCampaignProofAttemptIdentityError(
      `CCC campaign proof attempt ${label} must be a non-empty canonical string`,
    );
  }
  return value;
}

function requireIdentifier(value: unknown, label: string): string {
  const identifier = requireCanonicalText(value, label, 256);
  if (!IDENTIFIER_PATTERN.test(identifier)) {
    throw new CccCampaignProofAttemptIdentityError(
      `CCC campaign proof attempt ${label} must be a bounded canonical identifier`,
    );
  }
  return identifier;
}

function requireSha256(value: unknown, label: string): string {
  const digest = requireCanonicalText(value, label, 64);
  if (!SHA256_PATTERN.test(digest)) {
    throw new CccCampaignProofAttemptIdentityError(
      `CCC campaign proof attempt ${label} must be a lowercase SHA-256 digest`,
    );
  }
  return digest;
}

function requireGitObject(value: unknown, label: string): string {
  const objectId = requireCanonicalText(value, label, 64);
  if (!GIT_OBJECT_PATTERN.test(objectId)) {
    throw new CccCampaignProofAttemptIdentityError(
      `CCC campaign proof attempt ${label} must be a lowercase full Git object ID`,
    );
  }
  return objectId;
}

function requireAttemptKey(value: unknown): string {
  const attemptKey = requireCanonicalText(value, "attempt key");
  if (!ATTEMPT_KEY_PATTERN.test(attemptKey)) {
    throw new CccCampaignProofAttemptIdentityError(
      "CCC campaign proof attempt key is malformed",
    );
  }
  return attemptKey;
}

function requireControllerToken(value: unknown): string {
  const controllerToken = requireCanonicalText(value, "controller token");
  if (!CONTROLLER_TOKEN_PATTERN.test(controllerToken)) {
    throw new CccCampaignProofAttemptIdentityError(
      "CCC campaign proof attempt controller token is malformed",
    );
  }
  return controllerToken;
}

function requirePositiveSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new CccCampaignProofAttemptIdentityError(
      `CCC campaign proof attempt ${label} must be a positive safe integer`,
    );
  }
  return value as number;
}

function requireNonNegativeSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new CccCampaignProofAttemptIdentityError(
      `CCC campaign proof attempt ${label} must be a non-negative safe integer`,
    );
  }
  return value as number;
}

function requireExitCode(value: unknown): number | null {
  if (value === null) return null;
  if (
    !Number.isSafeInteger(value)
    || (value as number) < -2_147_483_648
    || (value as number) > 2_147_483_647
  ) {
    throw new CccCampaignProofAttemptIdentityError(
      "CCC campaign proof attempt exit code must be a PostgreSQL integer or null",
    );
  }
  return value as number;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new CccCampaignProofAttemptIdentityError(
      `CCC campaign proof attempt ${label} must be a boolean`,
    );
  }
  return value;
}

function requireAttemptContractVersion(
  value: unknown,
): CccCampaignProofAttemptContractVersion {
  if (value === undefined || value === CCC_CAMPAIGN_PROOF_ATTEMPT_CONTRACT_V1) {
    return CCC_CAMPAIGN_PROOF_ATTEMPT_CONTRACT_V1;
  }
  if (value === CCC_CAMPAIGN_PROOF_ATTEMPT_CONTRACT_V2) {
    return CCC_CAMPAIGN_PROOF_ATTEMPT_CONTRACT_V2;
  }
  throw new CccCampaignProofAttemptIdentityError(
    "CCC campaign proof attempt contract version must be v1 or v2",
  );
}

function requireProofPhase(value: unknown): CccPrdProofPhase {
  if (value === "task" || value === "final_integrated") return value;
  throw new CccCampaignProofAttemptIdentityError(
    "CCC campaign proof attempt phase must be task or final_integrated",
  );
}

function requireEvidenceResults<T extends Record<string, unknown>>(
  value: unknown,
  kind: "clause" | "positive case" | "negative control",
  idKey: "clauseId" | "caseId" | "controlId",
): readonly T[] {
  if (!Array.isArray(value) || value.length > MAX_PROOF_EVIDENCE_RESULTS) {
    throw new CccCampaignProofAttemptIdentityError(
      `CCC campaign proof attempt evidence ${kind} results must be a bounded array`,
    );
  }
  const identifiers = new Set<string>();
  const results = value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new CccCampaignProofAttemptIdentityError(
        `CCC campaign proof attempt evidence ${kind} result ${index} must be an object`,
      );
    }
    requireExactKeys(entry, [idKey, "passed"], `evidence ${kind} result ${index}`);
    const identifier = requireIdentifier(
      entry[idKey],
      `evidence ${kind} result ${index} ${idKey}`,
    );
    if (identifiers.has(identifier)) {
      throw new CccCampaignProofAttemptIdentityError(
        `CCC campaign proof attempt evidence ${kind} result IDs must be unique`,
      );
    }
    identifiers.add(identifier);
    return Object.freeze({
      [idKey]: identifier,
      passed: requireBoolean(entry.passed, `evidence ${kind} result ${index} passed`),
    }) as unknown as T;
  });
  const canonical = [...results].sort((left, right) => {
    const leftId = left[idKey] as string;
    const rightId = right[idKey] as string;
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
  });
  if (canonicalCccPrdJson(results) !== canonicalCccPrdJson(canonical)) {
    throw new CccCampaignProofAttemptIdentityError(
      `CCC campaign proof attempt evidence ${kind} results must be canonically ordered`,
    );
  }
  return Object.freeze(results);
}

function prepareProofEvidenceV2(input: unknown): CccCampaignProofEvidenceV2 {
  if (!isRecord(input)) {
    throw new CccCampaignProofAttemptIdentityError(
      "CCC campaign proof attempt v2 evidence must be an object",
    );
  }
  requireExactKeys(input, [
    "schema",
    "proofId",
    "phase",
    "sourceCommit",
    "sourceTree",
    "passed",
    "clauseResults",
    "positiveCaseResults",
    "negativeControlResults",
  ], "v2 proof evidence");
  if (input.schema !== CCC_PRD_PROOF_EVIDENCE_V2_SCHEMA_VERSION) {
    throw new CccCampaignProofAttemptIdentityError(
      "CCC campaign proof attempt evidence schema must be ccc-prd.proof-evidence.v2",
    );
  }
  const clauseResults = requireEvidenceResults<CccCampaignProofEvidenceClauseResult>(
    input.clauseResults,
    "clause",
    "clauseId",
  );
  const positiveCaseResults =
    requireEvidenceResults<CccCampaignProofEvidencePositiveCaseResult>(
      input.positiveCaseResults,
      "positive case",
      "caseId",
    );
  const negativeControlResults =
    requireEvidenceResults<CccCampaignProofEvidenceNegativeControlResult>(
      input.negativeControlResults,
      "negative control",
      "controlId",
    );
  if (
    clauseResults.length
      + positiveCaseResults.length
      + negativeControlResults.length
    === 0
  ) {
    throw new CccCampaignProofAttemptIdentityError(
      "CCC campaign proof attempt evidence must contain at least one result",
    );
  }
  const passed = requireBoolean(input.passed, "evidence passed");
  const computedPassed = [
    ...clauseResults,
    ...positiveCaseResults,
    ...negativeControlResults,
  ].every((result) => result.passed);
  if (passed !== computedPassed) {
    throw new CccCampaignProofAttemptIdentityError(
      "CCC campaign proof attempt evidence aggregate result is inconsistent",
    );
  }
  const evidence = Object.freeze({
    schema: CCC_PRD_PROOF_EVIDENCE_V2_SCHEMA_VERSION,
    proofId: requireIdentifier(input.proofId, "evidence proof ID"),
    phase: requireProofPhase(input.phase),
    sourceCommit: requireGitObject(input.sourceCommit, "evidence source commit"),
    sourceTree: requireGitObject(input.sourceTree, "evidence source tree"),
    passed,
    clauseResults,
    positiveCaseResults,
    negativeControlResults,
  });
  requireBoundedCanonicalJson(
    evidence,
    "v2 proof evidence",
    MAX_PROOF_EVIDENCE_BYTES,
  );
  return evidence;
}

function prepareTerminalEnvelopeV2(input: unknown): CccCampaignProofTerminalEnvelopeV2 {
  if (!isRecord(input)) {
    throw new CccCampaignProofAttemptIdentityError(
      "CCC campaign proof attempt v2 terminal envelope must be an object",
    );
  }
  const commonKeys = [
    "schema",
    "kind",
    "proofId",
    "phase",
    "sourceCommit",
    "sourceTree",
    "exitCode",
    "durationMs",
    "stdoutSha256",
    "stderrSha256",
    "changedPathsSha256",
    "stdoutTail",
    "stderrTail",
    "timedOut",
    "killed",
    "warnings",
  ] as const;
  const kind = input.kind;
  requireExactKeys(
    input,
    kind === "verified"
      ? [...commonKeys, "passed", "evidence", "evidenceSha256"]
      : kind === "execution_refused"
        ? [...commonKeys, "code"]
        : commonKeys,
    "v2 terminal envelope",
  );
  if (input.schema !== CCC_PRD_PROOF_TERMINAL_ENVELOPE_V2_SCHEMA_VERSION) {
    throw new CccCampaignProofAttemptIdentityError(
      "CCC campaign proof attempt terminal envelope schema must be ccc-prd.proof-terminal-envelope.v2",
    );
  }
  const stdoutTail = typeof input.stdoutTail === "string"
    ? input.stdoutTail
    : (() => {
      throw new CccCampaignProofAttemptIdentityError(
        "CCC campaign proof attempt terminal stdout tail must be a string",
      );
    })();
  const stderrTail = typeof input.stderrTail === "string"
    ? input.stderrTail
    : (() => {
      throw new CccCampaignProofAttemptIdentityError(
        "CCC campaign proof attempt terminal stderr tail must be a string",
      );
    })();
  if (stdoutTail.length > OUTPUT_TAIL_CHARS || stderrTail.length > OUTPUT_TAIL_CHARS) {
    throw new CccCampaignProofAttemptIdentityError(
      "CCC campaign proof attempt terminal output tail exceeds its limit",
    );
  }
  if (!Array.isArray(input.warnings) || input.warnings.length > MAX_WARNINGS) {
    throw new CccCampaignProofAttemptIdentityError(
      `CCC campaign proof attempt warnings must contain at most ${MAX_WARNINGS} strings`,
    );
  }
  const warnings = Object.freeze(input.warnings.map((warning, index) =>
    requireCanonicalText(warning, `terminal warning ${index}`, MAX_WARNING_CHARS)));
  const common = {
    schema: CCC_PRD_PROOF_TERMINAL_ENVELOPE_V2_SCHEMA_VERSION,
    proofId: requireIdentifier(input.proofId, "terminal proof ID"),
    phase: requireProofPhase(input.phase),
    sourceCommit: requireGitObject(input.sourceCommit, "terminal source commit"),
    sourceTree: requireGitObject(input.sourceTree, "terminal source tree"),
    exitCode: requireExitCode(input.exitCode),
    durationMs: requireNonNegativeSafeInteger(input.durationMs, "terminal durationMs"),
    stdoutSha256: requireSha256(input.stdoutSha256, "terminal stdout digest"),
    stderrSha256: requireSha256(input.stderrSha256, "terminal stderr digest"),
    changedPathsSha256: requireSha256(
      input.changedPathsSha256,
      "terminal changed-path digest",
    ),
    stdoutTail,
    stderrTail,
    timedOut: requireBoolean(input.timedOut, "terminal timedOut"),
    killed: requireBoolean(input.killed, "terminal killed"),
    warnings,
  } as const;
  let envelope: CccCampaignProofTerminalEnvelopeV2;
  if (kind === "verified") {
    const evidence = prepareProofEvidenceV2(input.evidence);
    const evidenceSha256 = requireSha256(
      input.evidenceSha256,
      "terminal evidence digest",
    );
    if (sha256(canonicalCccPrdJson(evidence)) !== evidenceSha256) {
      throw new CccCampaignProofAttemptIdentityError(
        "CCC campaign proof attempt terminal evidence digest does not match canonical evidence",
      );
    }
    const passed = requireBoolean(input.passed, "terminal verified passed");
    if (
      passed !== evidence.passed
      || common.proofId !== evidence.proofId
      || common.phase !== evidence.phase
      || common.sourceCommit !== evidence.sourceCommit
      || common.sourceTree !== evidence.sourceTree
    ) {
      throw new CccCampaignProofAttemptIdentityError(
        "CCC campaign proof attempt terminal evidence identity is inconsistent",
      );
    }
    if (common.timedOut || common.killed || (passed && common.exitCode !== 0)) {
      throw new CccCampaignProofAttemptIdentityError(
        "CCC campaign proof attempt verified terminal has inconsistent process facts",
      );
    }
    envelope = Object.freeze({
      ...common,
      kind: "verified",
      passed,
      evidence,
      evidenceSha256,
    });
  } else if (kind === "execution_refused") {
    if (
      typeof input.code !== "string"
      || !EXECUTION_REFUSAL_CODES.has(input.code as CccCampaignProofExecutionRefusalCode)
    ) {
      throw new CccCampaignProofAttemptIdentityError(
        "CCC campaign proof attempt execution refusal code is unsupported",
      );
    }
    const code = input.code as CccCampaignProofExecutionRefusalCode;
    if (
      (code === "timeout" && !common.timedOut)
      || (code === "killed" && !common.killed)
      || (
        code === "no_output"
        && (
          common.stdoutSha256 !== sha256("")
          || common.stdoutTail !== ""
        )
      )
    ) {
      throw new CccCampaignProofAttemptIdentityError(
        "CCC campaign proof attempt execution refusal contradicts its process facts",
      );
    }
    envelope = Object.freeze({
      ...common,
      kind: "execution_refused",
      code,
    });
  } else {
    throw new CccCampaignProofAttemptIdentityError(
      "CCC campaign proof attempt terminal envelope kind is unsupported",
    );
  }
  requireBoundedCanonicalJson(
    envelope,
    "v2 terminal envelope",
    MAX_TERMINAL_ENVELOPE_BYTES,
  );
  return envelope;
}

function canonicalExpectedIdentifiers(
  value: unknown,
  label: string,
): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_PROOF_EVIDENCE_RESULTS) {
    throw new CccCampaignProofAttemptIdentityError(
      `CCC campaign proof attempt ${label} must be a bounded identifier array`,
    );
  }
  const identifiers = value.map((entry, index) =>
    requireIdentifier(entry, `${label}[${index}]`));
  const sorted = [...identifiers].sort();
  if (new Set(identifiers).size !== identifiers.length) {
    throw new CccCampaignProofAttemptIdentityError(
      `CCC campaign proof attempt ${label} must be unique`,
    );
  }
  return Object.freeze(sorted);
}

function assertExactEvidenceSets(
  evidence: CccCampaignProofEvidenceV2,
  expected: CccCampaignProofEvidenceExpectedSets,
): void {
  const observed = {
    clauseIds: evidence.clauseResults.map(({ clauseId }) => clauseId),
    positiveCaseIds: evidence.positiveCaseResults.map(({ caseId }) => caseId),
    negativeControlIds: evidence.negativeControlResults.map(({ controlId }) => controlId),
  };
  if (!sameCanonicalValue(observed, expected)) {
    throw new CccCampaignProofAttemptIdentityError(
      "CCC campaign proof attempt evidence does not exactly match expected result sets",
    );
  }
}

async function expectedEvidenceSetsForAttempt(
  tx: DbTransaction,
  attempt: CccCampaignProofAttempt,
): Promise<CccCampaignProofEvidenceExpectedSets> {
  const { bundle } = await campaignCustodyForAttempt(tx, attempt);
  const matches = bundle.proofs.filter(({ id }) => id === attempt.proofId);
  if (matches.length !== 1 || matches[0]!.schema !== "ccc-prd.proof.v2") {
    throw new CccCampaignProofAttemptIdentityError(
      "CCC campaign proof attempt cannot resolve one admitted semantic proof definition",
    );
  }
  const proof = matches[0] as CccPrdProofV2;
  const digests = computeCccPrdProofV2AdmissionDigests(proof);
  if (
    attempt.phase === undefined
    || !proof.phases.includes(attempt.phase)
    || computeCccPrdProofDefinitionSha256(proof) !== attempt.definitionSha256
    || proof.command !== attempt.command
    || sha256(proof.command) !== attempt.commandSha256
    || digests.verifierClosureSha256 !== attempt.verifierClosureSha256
    || digests.candidateInputsSha256 !== attempt.candidateInputsSha256
    || digests.executionToolchainSha256 !== attempt.executionToolchainSha256
    || proof.admission?.schema !== "ccc-prd.proof-admission.v2"
    || proof.admission.definitionSha256 !== attempt.definitionSha256
    || proof.admission.verifierClosureSha256 !== attempt.verifierClosureSha256
    || proof.admission.candidateInputsSha256 !== attempt.candidateInputsSha256
    || proof.admission.executionToolchainSha256 !== attempt.executionToolchainSha256
  ) {
    throw new CccCampaignProofAttemptIdentityError(
      "CCC campaign proof attempt semantic proof custody does not match its reservation",
    );
  }
  return Object.freeze({
    clauseIds: canonicalExpectedIdentifiers(proof.clauseIds, "expected clause IDs"),
    positiveCaseIds: canonicalExpectedIdentifiers(
      proof.positiveCases.map(({ id }) => id),
      "expected positive-case IDs",
    ),
    negativeControlIds: canonicalExpectedIdentifiers(
      proof.negativeControls.map(({ id }) => id),
      "expected negative-control IDs",
    ),
  });
}

async function campaignCustodyForAttempt(
  tx: DbTransaction,
  attempt: CccCampaignProofAttempt,
): Promise<ReconstructedCccCampaignCustody> {
  const rows = await tx
    .select({
      projectId: schema.project.cccPrdImports.projectId,
      importId: schema.project.cccPrdImports.importId,
      idempotencyKey: schema.project.cccPrdImports.idempotencyKey,
      identityHash: schema.project.cccPrdImports.identityHash,
      bundleHash: schema.project.cccPrdImports.bundleHash,
      packetHash: schema.project.cccPrdImports.packetHash,
      sidecarHash: schema.project.cccPrdImports.sidecarHash,
      sourceVersion: schema.project.cccPrdImports.sourceVersion,
      targetRepository: schema.project.cccPrdImports.targetRepository,
      targetBase: schema.project.cccPrdImports.targetBase,
      canonicalBundle: schema.project.cccPrdImports.canonicalBundle,
      executionPolicy: schema.project.cccPrdImports.executionPolicy,
      campaignManifest: schema.project.cccPrdImports.campaignManifest,
      campaignManifestHash: schema.project.cccPrdImports.campaignManifestHash,
      campaignStartedAt: schema.project.cccPrdImports.campaignStartedAt,
      campaignDeadlineAt: schema.project.cccPrdImports.campaignDeadlineAt,
    })
    .from(schema.project.cccPrdImports)
    .where(and(
      eq(schema.project.cccPrdImports.projectId, attempt.projectId),
      eq(schema.project.cccPrdImports.importId, attempt.importId),
    ))
    .limit(2);
  if (rows.length !== 1) {
    throw new CccCampaignProofAttemptIdentityError(
      "CCC campaign proof attempt cannot resolve one persisted campaign custody record",
    );
  }
  let custody: ReconstructedCccCampaignCustody;
  try {
    custody = reconstructCccCampaignCustody(rows[0]!);
  } catch {
    throw new CccCampaignProofAttemptIdentityError(
      "CCC campaign proof attempt persisted campaign custody is missing or drifted",
    );
  }
  const { bundle, manifest, manifestHash } = custody;
  if (
    manifest.projectId !== attempt.projectId
    || manifest.importId !== attempt.importId
    || bundle.schema !== "ccc-prd.bundle.v2"
    || bundle.bundleHash !== attempt.bundleHash
    || bundle.sourceHash !== attempt.packetHash
    || bundle.sidecarHash !== attempt.sidecarHash
    || manifestHash !== attempt.manifestHash
    || manifest.campaignId !== attempt.campaignId
    || manifest.targetRepository.path !== attempt.targetRepository
    || manifest.targetRepository.baseCommit !== attempt.targetBase
  ) {
    throw new CccCampaignProofAttemptIdentityError(
      "CCC campaign proof attempt v2 custody does not match its reserved identity",
    );
  }
  return custody;
}

function assertCanonicalTimestamp(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) {
    throw new CccCampaignContextError(
      `CCC campaign proof attempt ${label} must be a canonical ISO timestamp`,
    );
  }
  return value;
}

function terminalResult(row: ProofAttemptRow): CccCampaignProofExecutionResult {
  if (
    row.resultSuccess === null
    || row.durationMs === null
    || row.stdoutSha256 === null
    || row.stderrSha256 === null
    || row.stdoutTail === null
    || row.stderrTail === null
    || row.timedOut === null
    || row.killed === null
    || !Array.isArray(row.warnings)
    || !row.warnings.every((warning) => typeof warning === "string")
  ) {
    throw new CccCampaignContextError(
      `CCC campaign proof attempt ${row.attemptKey} has incomplete terminal evidence`,
    );
  }
  const warnings = Object.freeze([...row.warnings]);
  return Object.freeze({
    success: row.resultSuccess === 1,
    exitCode: row.exitCode,
    durationMs: row.durationMs,
    stdoutSha256: requireSha256(row.stdoutSha256, "stored stdout digest"),
    stderrSha256: requireSha256(row.stderrSha256, "stored stderr digest"),
    stdoutTail: row.stdoutTail,
    stderrTail: row.stderrTail,
    timedOut: row.timedOut === 1,
    killed: row.killed === 1,
    warnings,
    ...(row.changedPathsSha256
      ? { changedPathsSha256: requireSha256(row.changedPathsSha256, "stored changed-path digest") }
      : {}),
    ...(row.negativeControlLabel
      ? { negativeControlLabel: row.negativeControlLabel }
      : {}),
  });
}

function attemptFromRow(row: ProofAttemptRow): CccCampaignProofAttempt {
  if (
    row.state !== "reserved"
    && row.state !== "dispatched_unknown"
    && row.state !== "committed"
    && row.state !== "proved_failed"
  ) {
    throw new CccCampaignContextError(
      `CCC campaign proof attempt ${row.attemptKey} has an invalid state`,
    );
  }
  const terminal = row.state === "committed" || row.state === "proved_failed";
  const attemptContractVersion = requireAttemptContractVersion(row.attemptContractVersion);
  const v2 = attemptContractVersion === CCC_CAMPAIGN_PROOF_ATTEMPT_CONTRACT_V2;
  let terminalEnvelope: CccCampaignProofTerminalEnvelopeV2 | undefined;
  let terminalEnvelopeSha256: string | undefined;
  let proofEvidence: CccCampaignProofEvidenceV2 | undefined;
  let proofEvidenceSha256: string | undefined;
  if (v2 && terminal) {
    terminalEnvelope = prepareTerminalEnvelopeV2(row.terminalEnvelope);
    terminalEnvelopeSha256 = requireSha256(
      row.terminalEnvelopeSha256,
      "stored terminal-envelope digest",
    );
    if (sha256(canonicalCccPrdJson(terminalEnvelope)) !== terminalEnvelopeSha256) {
      throw new CccCampaignContextError(
        `CCC campaign proof attempt ${row.attemptKey} terminal-envelope digest drifted`,
      );
    }
    if (terminalEnvelope.kind === "verified") {
      proofEvidence = terminalEnvelope.evidence;
      proofEvidenceSha256 = terminalEnvelope.evidenceSha256;
      if (
        !sameCanonicalValue(row.proofEvidence, proofEvidence)
        || row.proofEvidenceSha256 !== proofEvidenceSha256
      ) {
        throw new CccCampaignContextError(
          `CCC campaign proof attempt ${row.attemptKey} parsed evidence drifted`,
        );
      }
    } else if (row.proofEvidence !== null || row.proofEvidenceSha256 !== null) {
      throw new CccCampaignContextError(
        `CCC campaign proof attempt ${row.attemptKey} refusal fabricated parsed evidence`,
      );
    }
  } else if (
    v2
    && (
      row.terminalEnvelope !== null
      || row.terminalEnvelopeSha256 !== null
      || row.proofEvidence !== null
      || row.proofEvidenceSha256 !== null
    )
  ) {
    throw new CccCampaignContextError(
      `CCC campaign proof attempt ${row.attemptKey} has premature terminal evidence`,
    );
  }
  const attempt: CccCampaignProofAttempt = {
    schema: v2
      ? CCC_CAMPAIGN_PROOF_ATTEMPT_V2_SCHEMA_VERSION
      : CCC_CAMPAIGN_PROOF_ATTEMPT_SCHEMA_VERSION,
    attemptContractVersion,
    attemptKey: requireAttemptKey(row.attemptKey),
    controllerToken: requireControllerToken(row.controllerToken),
    projectId: row.projectId,
    importId: row.importId,
    campaignId: row.campaignId,
    taskId: row.taskId,
    semanticTaskId: row.semanticTaskId,
    proofId: row.proofId,
    packetHash: requireSha256(row.packetHash, "stored packet hash"),
    sidecarHash: requireSha256(row.sidecarHash, "stored sidecar hash"),
    bundleHash: requireSha256(row.bundleHash, "stored bundle hash"),
    manifestHash: requireSha256(row.manifestHash, "stored manifest hash"),
    campaignBindingHash: requireSha256(
      row.campaignBindingHash,
      "stored campaign binding hash",
    ),
    targetRepository: row.targetRepository,
    targetBase: row.targetBase,
    sourceCommit: requireGitObject(row.sourceCommit, "stored source commit"),
    sourceTree: requireGitObject(row.sourceTree, "stored source tree"),
    definitionSha256: requireSha256(
      row.definitionSha256,
      "stored proof-definition digest",
    ),
    command: row.command,
    commandSha256: requireSha256(row.commandSha256, "stored command digest"),
    workItemId: row.workItemId,
    runId: row.runId,
    workItemAttempt: row.workItemAttempt,
    ...(v2
      ? {
        phase: requireProofPhase(row.phase),
        verifierClosureSha256: requireSha256(
          row.verifierClosureSha256,
          "stored verifier-closure digest",
        ),
        candidateInputsSha256: requireSha256(
          row.candidateInputsSha256,
          "stored candidate-input digest",
        ),
        executionToolchainSha256: requireSha256(
          row.executionToolchainSha256,
          "stored execution-toolchain digest",
        ),
      }
      : {}),
    state: row.state,
    ...(terminal ? { result: terminalResult(row) } : {}),
    ...(terminalEnvelope
      ? {
        terminalEnvelope,
        terminalEnvelopeSha256,
        ...(proofEvidence
          ? { proofEvidence, proofEvidenceSha256 }
          : {}),
      }
      : {}),
    createdAt: assertCanonicalTimestamp(row.createdAt, "createdAt"),
    updatedAt: assertCanonicalTimestamp(row.updatedAt, "updatedAt"),
    ...(row.dispatchedAt
      ? { dispatchedAt: assertCanonicalTimestamp(row.dispatchedAt, "dispatchedAt") }
      : {}),
    ...(row.settledAt
      ? { settledAt: assertCanonicalTimestamp(row.settledAt, "settledAt") }
      : {}),
  };
  return Object.freeze(attempt);
}

function immutableAttemptIdentity(attempt: CccCampaignProofAttempt): Record<string, unknown> {
  return {
    schema: attempt.schema,
    attemptContractVersion: attempt.attemptContractVersion,
    attemptKey: attempt.attemptKey,
    projectId: attempt.projectId,
    importId: attempt.importId,
    campaignId: attempt.campaignId,
    taskId: attempt.taskId,
    semanticTaskId: attempt.semanticTaskId,
    proofId: attempt.proofId,
    packetHash: attempt.packetHash,
    sidecarHash: attempt.sidecarHash,
    bundleHash: attempt.bundleHash,
    manifestHash: attempt.manifestHash,
    campaignBindingHash: attempt.campaignBindingHash,
    targetRepository: attempt.targetRepository,
    targetBase: attempt.targetBase,
    sourceCommit: attempt.sourceCommit,
    sourceTree: attempt.sourceTree,
    definitionSha256: attempt.definitionSha256,
    command: attempt.command,
    commandSha256: attempt.commandSha256,
    workItemId: attempt.workItemId,
    runId: attempt.runId,
    workItemAttempt: attempt.workItemAttempt,
    ...(attempt.attemptContractVersion === CCC_CAMPAIGN_PROOF_ATTEMPT_CONTRACT_V2
      ? {
        phase: attempt.phase,
        verifierClosureSha256: attempt.verifierClosureSha256,
        candidateInputsSha256: attempt.candidateInputsSha256,
        executionToolchainSha256: attempt.executionToolchainSha256,
      }
      : {}),
  };
}

function sameCanonicalValue(left: unknown, right: unknown): boolean {
  return canonicalCccPrdJson(left) === canonicalCccPrdJson(right);
}

function proofForContext(
  context: CccCampaignTaskContext,
  proofId: string,
  scope: CccCampaignProofAttemptScope,
) {
  if (scope === "task" && !context.proofIds.includes(proofId)) {
    throw new CccCampaignProofAttemptIdentityError(
      `CCC campaign proof ${proofId} is not admitted for task ${context.taskId}`,
    );
  }
  const matches = context.proofs.filter((proof) => proof.id === proofId);
  if (matches.length !== 1) {
    throw new CccCampaignProofAttemptIdentityError(
      `CCC campaign proof ${proofId} does not resolve to one immutable admitted definition`,
    );
  }
  return matches[0]!;
}

function attemptKeyFor(input: {
  context: CccCampaignTaskContext;
  proofId: string;
  sourceCommit: string;
  definitionSha256: string;
  attemptContractVersion: CccCampaignProofAttemptContractVersion;
  phase?: CccPrdProofPhase;
  workItemFence: CccCampaignProofWorkItemFence;
}): string {
  if (input.attemptContractVersion === CCC_CAMPAIGN_PROOF_ATTEMPT_CONTRACT_V2) {
    return `ccc-proof-attempt-${sha256(canonicalCccPrdJson({
      schema: CCC_CAMPAIGN_PROOF_ATTEMPT_V2_SCHEMA_VERSION,
      attemptContractVersion: input.attemptContractVersion,
      projectId: input.context.projectId,
      importId: input.context.importId,
      campaignId: input.context.campaignId,
      semanticTaskId: input.context.semanticTaskId,
      proofId: input.proofId,
      phase: input.phase,
      sourceCommit: input.sourceCommit,
      definitionSha256: input.definitionSha256,
      workItemFence: input.workItemFence,
    }))}`;
  }
  return `ccc-proof-attempt-${sha256(canonicalCccPrdJson({
    schema: CCC_CAMPAIGN_PROOF_ATTEMPT_SCHEMA_VERSION,
    projectId: input.context.projectId,
    importId: input.context.importId,
    campaignId: input.context.campaignId,
    semanticTaskId: input.context.semanticTaskId,
    proofId: input.proofId,
    sourceCommit: input.sourceCommit,
    definitionSha256: input.definitionSha256,
  }))}`;
}

async function databaseNow(tx: DbTransaction): Promise<string> {
  const rows = await tx.execute(sql`
    SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now
  `) as unknown as Array<{ now: string }>;
  return assertCanonicalTimestamp(rows[0]?.now, "database clock");
}

function assertBeforeCampaignDeadline(
  campaignDeadlineAt: string,
  databaseTimestamp: string,
): void {
  const deadline = assertCanonicalTimestamp(campaignDeadlineAt, "campaign deadline");
  if (Date.parse(databaseTimestamp) >= Date.parse(deadline)) {
    throw new CccCampaignProofAttemptLimitError(
      "deadline",
      "CCC campaign proof deadline has expired",
    );
  }
}

async function selectAttempt(
  tx: DbTransaction,
  projectId: string,
  attemptKey: string,
  lockForUpdate: boolean,
): Promise<CccCampaignProofAttempt | null> {
  const selection = tx
    .select()
    .from(schema.project.cccCampaignProofAttempts)
    .where(and(
      eq(schema.project.cccCampaignProofAttempts.projectId, projectId),
      eq(schema.project.cccCampaignProofAttempts.attemptKey, attemptKey),
    ))
    .limit(2);
  const rows = lockForUpdate ? await selection.for("update") : await selection;
  if (rows.length === 0) return null;
  if (rows.length !== 1) {
    throw new CccCampaignContextError(
      `CCC campaign proof attempt ${attemptKey} has ambiguous persistence`,
    );
  }
  return attemptFromRow(rows[0]!);
}

function assertController(
  attempt: CccCampaignProofAttempt,
  controllerToken: string,
): void {
  if (attempt.controllerToken !== controllerToken) {
    throw new CccCampaignProofAttemptStateError(
      `CCC campaign proof attempt ${attempt.attemptKey} controller token does not own the reservation`,
    );
  }
}

function prepareTerminalResult(
  input: CccCampaignProofExecutionResultInput,
): CccCampaignProofExecutionResult {
  if (!input || typeof input !== "object") {
    throw new CccCampaignProofAttemptIdentityError(
      "CCC campaign proof attempt result is missing",
    );
  }
  const success = requireBoolean(input.success, "result success");
  const exitCode = requireExitCode(input.exitCode);
  const durationMs = requireNonNegativeSafeInteger(input.durationMs, "result durationMs");
  const stdout = typeof input.stdout === "string"
    ? input.stdout
    : (() => {
      throw new CccCampaignProofAttemptIdentityError(
        "CCC campaign proof attempt stdout must be a string",
      );
    })();
  const stderr = typeof input.stderr === "string"
    ? input.stderr
    : (() => {
      throw new CccCampaignProofAttemptIdentityError(
        "CCC campaign proof attempt stderr must be a string",
      );
    })();
  const timedOut = requireBoolean(input.timedOut, "result timedOut");
  const killed = requireBoolean(input.killed, "result killed");
  if (!Array.isArray(input.warnings) || input.warnings.length > MAX_WARNINGS) {
    throw new CccCampaignProofAttemptIdentityError(
      `CCC campaign proof attempt warnings must contain at most ${MAX_WARNINGS} strings`,
    );
  }
  const warnings = input.warnings.map((warning, index) => {
    if (typeof warning !== "string" || warning.length > MAX_WARNING_CHARS) {
      throw new CccCampaignProofAttemptIdentityError(
        `CCC campaign proof attempt warning ${index} must be a bounded string`,
      );
    }
    return warning;
  });
  if (success && (exitCode !== 0 || timedOut || killed)) {
    throw new CccCampaignProofAttemptIdentityError(
      "CCC campaign proof attempt success requires exit code 0 without timeout or kill",
    );
  }
  const changedPathsSha256 = input.changedPathsSha256 === undefined
    ? undefined
    : requireSha256(input.changedPathsSha256, "changed-path digest");
  const negativeControlLabel = input.negativeControlLabel === undefined
    ? undefined
    : requireCanonicalText(
      input.negativeControlLabel,
      "negative-control label",
      MAX_NEGATIVE_CONTROL_LABEL_CHARS,
    );
  return Object.freeze({
    success,
    exitCode,
    durationMs,
    stdoutSha256: sha256(stdout),
    stderrSha256: sha256(stderr),
    stdoutTail: stdout.slice(-OUTPUT_TAIL_CHARS),
    stderrTail: stderr.slice(-OUTPUT_TAIL_CHARS),
    timedOut,
    killed,
    warnings: Object.freeze([...warnings]),
    ...(changedPathsSha256 ? { changedPathsSha256 } : {}),
    ...(negativeControlLabel ? { negativeControlLabel } : {}),
  });
}

async function withinWriteTransaction<T>(
  input: TransactionalInput,
  operation: (tx: DbTransaction) => Promise<T>,
): Promise<T> {
  if (input.tx) return operation(input.tx);
  return input.layer.transactionImmediate(operation);
}

export async function reserveCccCampaignProofAttempt(
  input: ReserveCccCampaignProofAttemptInput,
): Promise<CccCampaignProofAttempt> {
  const attemptContractVersion = requireAttemptContractVersion(
    input.attemptContractVersion,
  );
  const v2 = attemptContractVersion === CCC_CAMPAIGN_PROOF_ATTEMPT_CONTRACT_V2;
  const phase = v2 ? requireProofPhase(input.phase) : undefined;
  const taskId = requireIdentifier(input.taskId, "task ID");
  const proofId = requireIdentifier(input.proofId, "proof ID");
  const sourceCommit = requireGitObject(input.sourceCommit, "source commit");
  const sourceTree = requireGitObject(input.sourceTree, "source tree");
  const scope = v2
    ? (phase === "task" ? "task" : "campaign")
    : input.scope ?? "task";
  if (scope !== "task" && scope !== "campaign") {
    throw new CccCampaignProofAttemptIdentityError(
      "CCC campaign proof attempt scope must be task or campaign",
    );
  }
  const workItemId = requireIdentifier(
    input.workItemFence?.workItemId,
    "work-item ID",
  );
  const runId = requireIdentifier(input.workItemFence?.runId, "run ID");
  const workItemAttempt = requirePositiveSafeInteger(
    input.workItemFence?.attempt,
    "work-item attempt",
  );
  const verifierClosureSha256 = v2
    ? requireSha256(input.verifierClosureSha256, "verifier-closure digest")
    : undefined;
  const candidateInputsSha256 = v2
    ? requireSha256(input.candidateInputsSha256, "candidate-input digest")
    : undefined;
  const executionToolchainSha256 = v2
    ? requireSha256(input.executionToolchainSha256, "execution-toolchain digest")
    : undefined;
  return withinWriteTransaction(input, async (tx) => {
    const context = await loadCccCampaignContextForTask(
      input.layer,
      input.rootDir,
      taskId,
      tx,
      true,
    );
    if (!context) {
      throw new CccCampaignContextError(
        `Task ${taskId} has no persisted CCC campaign context`,
      );
    }
    const proof = proofForContext(context, proofId, scope);
    if (!v2 && proof.schema === "ccc-prd.proof.v2") {
      throw new CccCampaignProofAttemptIdentityError(
        `CCC campaign semantic proof v2 ${proofId} requires proof-attempt contract v2`,
      );
    }
    if (v2) {
      if (proof.schema !== "ccc-prd.proof.v2") {
        throw new CccCampaignProofAttemptIdentityError(
          `CCC campaign proof ${proofId} is not admitted under the semantic proof v2 contract`,
        );
      }
      if (!proof.phases.includes(phase!)) {
        throw new CccCampaignProofAttemptIdentityError(
          `CCC campaign proof ${proofId} does not admit phase ${phase}`,
        );
      }
      const expectedDigests = computeCccPrdProofV2AdmissionDigests(proof);
      if (
        verifierClosureSha256 !== expectedDigests.verifierClosureSha256
        || candidateInputsSha256 !== expectedDigests.candidateInputsSha256
        || executionToolchainSha256 !== expectedDigests.executionToolchainSha256
        || !proof.admission
        || proof.admission.schema !== "ccc-prd.proof-admission.v2"
        || proof.admission.verifierClosureSha256 !== verifierClosureSha256
        || proof.admission.candidateInputsSha256 !== candidateInputsSha256
        || proof.admission.executionToolchainSha256 !== executionToolchainSha256
      ) {
        throw new CccCampaignProofAttemptIdentityError(
          `CCC campaign proof ${proofId} v2 custody digests do not match immutable admission`,
        );
      }
    }
    const definitionSha256 = computeCccPrdProofDefinitionSha256(proof);
    const command = requireCanonicalText(proof.command, `proof ${proofId} command`);
    const commandSha256 = sha256(command);
    const binding = createCccCampaignAuthorityBinding(context, {
      actionId: `proof:${proofId}`,
      actionTarget: sourceCommit,
    });
    const attemptKey = attemptKeyFor({
      context,
      proofId,
      sourceCommit,
      definitionSha256,
      attemptContractVersion,
      phase,
      workItemFence: { workItemId, runId, attempt: workItemAttempt },
    });
    const now = await databaseNow(tx);
    const controllerToken = `ccc-proof-controller-${randomUUID()}`;
    const candidate: CccCampaignProofAttempt = Object.freeze({
      schema: v2
        ? CCC_CAMPAIGN_PROOF_ATTEMPT_V2_SCHEMA_VERSION
        : CCC_CAMPAIGN_PROOF_ATTEMPT_SCHEMA_VERSION,
      attemptContractVersion,
      attemptKey,
      controllerToken,
      projectId: context.projectId,
      importId: context.importId,
      campaignId: context.campaignId,
      taskId: context.taskId,
      semanticTaskId: context.semanticTaskId,
      proofId,
      packetHash: context.packetHash,
      sidecarHash: context.sidecarHash,
      bundleHash: context.bundleHash,
      manifestHash: context.manifestHash,
      campaignBindingHash: binding.bindingHash,
      targetRepository: context.targetRepository.path,
      targetBase: context.targetRepository.baseCommit,
      sourceCommit,
      sourceTree,
      definitionSha256,
      command,
      commandSha256,
      workItemId,
      runId,
      workItemAttempt,
      ...(v2
        ? {
          phase,
          verifierClosureSha256,
          candidateInputsSha256,
          executionToolchainSha256,
        }
        : {}),
      state: "reserved",
      createdAt: now,
      updatedAt: now,
    });
    const replay = await selectAttempt(
      tx,
      context.projectId,
      attemptKey,
      true,
    );
    if (replay) {
      if (
        !sameCanonicalValue(
          immutableAttemptIdentity(replay),
          immutableAttemptIdentity(candidate),
        )
      ) {
        throw new CccCampaignProofAttemptCollisionError(
          `CCC campaign proof attempt ${attemptKey} collides with changed immutable identity`,
        );
      }
      return replay;
    }
    if (v2) assertBeforeCampaignDeadline(context.campaignDeadlineAt, now);
    await tx
      .insert(schema.project.cccCampaignProofAttempts)
      .values({
        projectId: candidate.projectId,
        attemptKey: candidate.attemptKey,
        controllerToken: candidate.controllerToken,
        importId: candidate.importId,
        campaignId: candidate.campaignId,
        taskId: candidate.taskId,
        semanticTaskId: candidate.semanticTaskId,
        proofId: candidate.proofId,
        packetHash: candidate.packetHash,
        sidecarHash: candidate.sidecarHash,
        bundleHash: candidate.bundleHash,
        manifestHash: candidate.manifestHash,
        campaignBindingHash: candidate.campaignBindingHash,
        targetRepository: candidate.targetRepository,
        targetBase: candidate.targetBase,
        sourceCommit: candidate.sourceCommit,
        sourceTree: candidate.sourceTree,
        definitionSha256: candidate.definitionSha256,
        command: candidate.command,
        commandSha256: candidate.commandSha256,
        workItemId: candidate.workItemId,
        runId: candidate.runId,
        workItemAttempt: candidate.workItemAttempt,
        attemptContractVersion: candidate.attemptContractVersion,
        phase: candidate.phase ?? null,
        verifierClosureSha256: candidate.verifierClosureSha256 ?? null,
        candidateInputsSha256: candidate.candidateInputsSha256 ?? null,
        executionToolchainSha256: candidate.executionToolchainSha256 ?? null,
        state: candidate.state,
        createdAt: candidate.createdAt,
        updatedAt: candidate.updatedAt,
      })
      .onConflictDoNothing();
    const persisted = await selectAttempt(
      tx,
      context.projectId,
      attemptKey,
      true,
    );
    if (!persisted) {
      throw new CccCampaignContextError(
        `CCC campaign proof attempt ${attemptKey} reservation was not persisted`,
      );
    }
    if (
      !sameCanonicalValue(
        immutableAttemptIdentity(persisted),
        immutableAttemptIdentity(candidate),
      )
    ) {
      throw new CccCampaignProofAttemptCollisionError(
        `CCC campaign proof attempt ${attemptKey} collides with changed immutable identity`,
      );
    }
    return persisted;
  });
}

export async function beginCccCampaignProofAttemptDispatch(
  input: TransitionCccCampaignProofAttemptInput,
): Promise<CccCampaignProofAttemptDispatchDecision> {
  const attemptKey = requireAttemptKey(input.attemptKey);
  const controllerToken = requireControllerToken(input.controllerToken);
  return withinWriteTransaction(input, async (tx) => {
    const projectId = projectIdFor(input.layer);
    const attempt = await selectAttempt(tx, projectId, attemptKey, true);
    if (!attempt) {
      throw new CccCampaignProofAttemptStateError(
        `CCC campaign proof attempt ${attemptKey} does not exist`,
      );
    }
    assertController(attempt, controllerToken);
    if (attempt.state === "dispatched_unknown") {
      return Object.freeze({ kind: "dispatched-unknown", attempt });
    }
    if (attempt.state !== "reserved") {
      return Object.freeze({ kind: "terminal", attempt });
    }
    const v2Custody = attempt.attemptContractVersion
      === CCC_CAMPAIGN_PROOF_ATTEMPT_CONTRACT_V2
      ? await campaignCustodyForAttempt(tx, attempt)
      : undefined;
    const now = await databaseNow(tx);
    if (v2Custody) {
      assertBeforeCampaignDeadline(v2Custody.manifest.campaignDeadlineAt, now);
    }
    const updated = await tx
      .update(schema.project.cccCampaignProofAttempts)
      .set({
        state: "dispatched_unknown",
        dispatchedAt: now,
        updatedAt: now,
      })
      .where(and(
        eq(schema.project.cccCampaignProofAttempts.projectId, projectId),
        eq(schema.project.cccCampaignProofAttempts.attemptKey, attemptKey),
        eq(schema.project.cccCampaignProofAttempts.controllerToken, controllerToken),
        eq(schema.project.cccCampaignProofAttempts.state, "reserved"),
      ))
      .returning();
    if (updated.length !== 1) {
      throw new CccCampaignProofAttemptStateError(
        `CCC campaign proof attempt ${attemptKey} dispatch compare-and-swap lost`,
      );
    }
    return Object.freeze({
      kind: "dispatch-permit",
      attempt: attemptFromRow(updated[0]!),
    });
  });
}

export async function settleCccCampaignProofAttempt(
  input: SettleCccCampaignProofAttemptInput,
): Promise<CccCampaignProofAttempt> {
  const attemptKey = requireAttemptKey(input.attemptKey);
  const controllerToken = requireControllerToken(input.controllerToken);
  return withinWriteTransaction(input, async (tx) => {
    const projectId = projectIdFor(input.layer);
    const attempt = await selectAttempt(tx, projectId, attemptKey, true);
    if (!attempt) {
      throw new CccCampaignProofAttemptStateError(
        `CCC campaign proof attempt ${attemptKey} does not exist`,
      );
    }
    assertController(attempt, controllerToken);
    const v2 = attempt.attemptContractVersion === CCC_CAMPAIGN_PROOF_ATTEMPT_CONTRACT_V2;
    const rawResult = "result" in input ? input.result : undefined;
    const rawEnvelope = "terminalEnvelope" in input ? input.terminalEnvelope : undefined;
    if (v2 && rawResult !== undefined) {
      throw new CccCampaignProofAttemptIdentityError(
        "CCC campaign proof attempt v2 cannot settle through the legacy result contract; a v2 terminal envelope is required",
      );
    }
    if (!v2 && rawEnvelope !== undefined) {
      throw new CccCampaignProofAttemptIdentityError(
        "CCC campaign proof attempt v1 cannot acquire a v2 terminal envelope",
      );
    }
    const terminalEnvelope = v2
      ? prepareTerminalEnvelopeV2(rawEnvelope)
      : undefined;
    const result: CccCampaignProofExecutionResult = v2
      ? Object.freeze({
        success: terminalEnvelope!.kind === "verified" && terminalEnvelope!.passed,
        exitCode: terminalEnvelope!.exitCode,
        durationMs: terminalEnvelope!.durationMs,
        stdoutSha256: terminalEnvelope!.stdoutSha256,
        stderrSha256: terminalEnvelope!.stderrSha256,
        changedPathsSha256: terminalEnvelope!.changedPathsSha256,
        stdoutTail: terminalEnvelope!.stdoutTail,
        stderrTail: terminalEnvelope!.stderrTail,
        timedOut: terminalEnvelope!.timedOut,
        killed: terminalEnvelope!.killed,
        warnings: terminalEnvelope!.warnings,
      } satisfies CccCampaignProofExecutionResult)
      : prepareTerminalResult(rawResult as CccCampaignProofExecutionResultInput);
    if (v2) {
      if (
        terminalEnvelope!.proofId !== attempt.proofId
        || terminalEnvelope!.phase !== attempt.phase
        || terminalEnvelope!.sourceCommit !== attempt.sourceCommit
        || terminalEnvelope!.sourceTree !== attempt.sourceTree
      ) {
        throw new CccCampaignProofAttemptIdentityError(
          "CCC campaign proof attempt v2 terminal envelope does not match reserved identity",
        );
      }
      const expectedEvidence = await expectedEvidenceSetsForAttempt(tx, attempt);
      if (terminalEnvelope!.kind === "verified") {
        assertExactEvidenceSets(terminalEnvelope!.evidence, expectedEvidence);
      }
      if (attempt.terminalEnvelope) {
        if (sameCanonicalValue(attempt.terminalEnvelope, terminalEnvelope)) return attempt;
        throw new CccCampaignProofAttemptCollisionError(
          `CCC campaign proof attempt ${attemptKey} terminal envelope collides with persisted evidence`,
        );
      }
    } else if (attempt.result) {
      if (sameCanonicalValue(attempt.result, result)) return attempt;
      throw new CccCampaignProofAttemptCollisionError(
        `CCC campaign proof attempt ${attemptKey} terminal result collides with persisted evidence`,
      );
    }
    if (attempt.state !== "dispatched_unknown") {
      throw new CccCampaignProofAttemptStateError(
        `CCC campaign proof attempt ${attemptKey} cannot settle from ${attempt.state}`,
      );
    }
    const now = await databaseNow(tx);
    const state = result.success ? "committed" : "proved_failed";
    const terminalEnvelopeSha256 = terminalEnvelope
      ? sha256(canonicalCccPrdJson(terminalEnvelope))
      : null;
    const proofEvidence = terminalEnvelope?.kind === "verified"
      ? terminalEnvelope.evidence
      : null;
    const proofEvidenceSha256 = terminalEnvelope?.kind === "verified"
      ? terminalEnvelope.evidenceSha256
      : null;
    const updated = await tx
      .update(schema.project.cccCampaignProofAttempts)
      .set({
        state,
        resultSuccess: result.success ? 1 : 0,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        stdoutSha256: result.stdoutSha256,
        stderrSha256: result.stderrSha256,
        stdoutTail: result.stdoutTail,
        stderrTail: result.stderrTail,
        timedOut: result.timedOut ? 1 : 0,
        killed: result.killed ? 1 : 0,
        warnings: [...result.warnings],
        changedPathsSha256: result.changedPathsSha256 ?? null,
        negativeControlLabel: result.negativeControlLabel ?? null,
        terminalEnvelope: terminalEnvelope ?? null,
        terminalEnvelopeSha256,
        proofEvidence,
        proofEvidenceSha256,
        settledAt: now,
        updatedAt: now,
      })
      .where(and(
        eq(schema.project.cccCampaignProofAttempts.projectId, projectId),
        eq(schema.project.cccCampaignProofAttempts.attemptKey, attemptKey),
        eq(schema.project.cccCampaignProofAttempts.controllerToken, controllerToken),
        eq(schema.project.cccCampaignProofAttempts.state, "dispatched_unknown"),
      ))
      .returning();
    if (updated.length !== 1) {
      throw new CccCampaignProofAttemptStateError(
        `CCC campaign proof attempt ${attemptKey} settlement compare-and-swap lost`,
      );
    }
    return attemptFromRow(updated[0]!);
  });
}

export async function inspectCccCampaignProofAttempt(
  input: InspectCccCampaignProofAttemptInput,
): Promise<CccCampaignProofAttempt | null> {
  const attemptKey = requireAttemptKey(input.attemptKey);
  const inspect = (tx: DbTransaction) =>
    selectAttempt(tx, projectIdFor(input.layer), attemptKey, false);
  if (input.tx) return inspect(input.tx);
  return input.layer.transaction(inspect);
}

export async function listCccCampaignProofAttemptsForCommit(
  input: ListCccCampaignProofAttemptsForCommitInput,
): Promise<readonly CccCampaignProofAttempt[]> {
  const importId = requireIdentifier(input.importId, "import ID");
  const campaignId = requireIdentifier(input.campaignId, "campaign ID");
  const taskId = requireIdentifier(input.taskId, "task ID");
  const sourceCommit = requireGitObject(input.sourceCommit, "source commit");
  const select = async (tx: DbTransaction) => {
    const rows = await tx
      .select()
      .from(schema.project.cccCampaignProofAttempts)
      .where(and(
        eq(schema.project.cccCampaignProofAttempts.projectId, projectIdFor(input.layer)),
        eq(schema.project.cccCampaignProofAttempts.importId, importId),
        eq(schema.project.cccCampaignProofAttempts.campaignId, campaignId),
        eq(schema.project.cccCampaignProofAttempts.taskId, taskId),
        eq(schema.project.cccCampaignProofAttempts.sourceCommit, sourceCommit),
      ));
    return Object.freeze(rows
      .map(attemptFromRow)
      .sort((left, right) => {
        const textPairs = [
          [left.proofId, right.proofId],
          [left.attemptContractVersion, right.attemptContractVersion],
          [left.phase ?? "", right.phase ?? ""],
          [left.workItemId, right.workItemId],
          [left.runId, right.runId],
        ] as const;
        for (const [leftValue, rightValue] of textPairs) {
          if (leftValue !== rightValue) return leftValue < rightValue ? -1 : 1;
        }
        if (left.workItemAttempt !== right.workItemAttempt) {
          return left.workItemAttempt - right.workItemAttempt;
        }
        return left.attemptKey < right.attemptKey
          ? -1
          : left.attemptKey > right.attemptKey
            ? 1
            : 0;
      }));
  };
  if (input.tx) return select(input.tx);
  return input.layer.transaction(select);
}
