import {
  CCC_MODEL_CAPABILITY_KEYS,
  CccModelCapabilityProfileValidationError,
  digestCccModelCapabilityProfile,
  parseCccModelCapabilityProfile,
  type CccModelCapabilityEvidenceState,
  type CccModelCapabilityProfile,
} from "@fusion/core";

import type { CccModelTerminalClassification } from "./ccc-model-boundary-telemetry.js";

export const CCC_MODEL_ADMISSION_STAGES = [
  "profile_validated",
  "offline_conformance",
  "live_microprobe",
  "replicated_scenarios",
  "bounded_coding",
  "campaign_admitted",
] as const;

export type CccModelAdmissionStage =
  (typeof CCC_MODEL_ADMISSION_STAGES)[number];
export type CccModelAdmissionVerdict =
  | "admitted"
  | "rejected"
  | "insufficient_evidence";

export interface CccModelAdmissionPolicy {
  readonly schemaVersion: "1.0";
  readonly requiredOfflineFixtureIds: readonly string[];
  readonly minimumLiveMicroprobes: number;
  readonly replicatedScenarioArmIds: readonly string[];
  readonly boundedCodingTaskIds: readonly string[];
}

export const CCC_MODEL_ADMISSION_POLICY_V1: Readonly<CccModelAdmissionPolicy> =
  deepFreeze({
    schemaVersion: "1.0",
    requiredOfflineFixtureIds: [
      "instruction_roles",
      "reasoning_request",
      "reasoning_response_and_replay",
      "tool_call_round_trip",
      "terminal_stream",
      "route_and_usage_receipts",
      "resume_replay",
      "limits_and_transport_owner",
    ],
    minimumLiveMicroprobes: 10,
    replicatedScenarioArmIds: Array.from(
      { length: 30 },
      (_, index) => `scenario-arm-${String(index + 1).padStart(2, "0")}`,
    ),
    boundedCodingTaskIds: Array.from(
      { length: 5 },
      (_, index) => `coding-task-${String(index + 1).padStart(2, "0")}`,
    ),
  });

export interface CccOfflineProbeResult {
  fixtureId: string;
  passed: boolean;
}

export interface CccAdmissionControlResult {
  observed: boolean;
  passed: boolean;
}

export interface CccAdmissionTerminalResult {
  routeMatched: boolean;
  terminalClassification: CccModelTerminalClassification;
  streamClosed: boolean;
  unresolvedAttempt: boolean;
}

export interface CccLiveMicroprobeResult extends CccAdmissionTerminalResult {
  probeId: string;
}

export interface CccReplicatedScenarioResult extends CccAdmissionTerminalResult {
  armId: string;
}

export interface CccBoundedCodingTrialResult extends CccAdmissionTerminalResult {
  taskId: string;
  sealed: boolean;
  diffProduced: boolean;
  verifierPassed: boolean;
  scopeClean: boolean;
  proofEligible: boolean;
}

export interface CccModelAdmissionInput {
  profile: Readonly<CccModelCapabilityProfile>;
  offlineProbes: CccOfflineProbeResult[];
  controls: {
    positive: CccAdmissionControlResult;
    negative: CccAdmissionControlResult;
  };
  routeEvidence: {
    profileDigest: string | null;
    requestedRoute: CccModelCapabilityProfile["route"] | null;
    effectiveRoute: Readonly<{ provider: string; model: string }> | null;
    proofPresent: boolean;
    finalReceiptPresent: boolean;
  };
  liveMicroprobes: CccLiveMicroprobeResult[];
  replicatedScenarios: CccReplicatedScenarioResult[];
  boundedCodingTrials: CccBoundedCodingTrialResult[];
}

export interface CccModelAdmissionNextProbe {
  readonly stage: Exclude<CccModelAdmissionStage, "campaign_admitted">;
  readonly kind: string;
  readonly evidenceId: string | null;
}

export interface CccModelAdmissionReason {
  readonly stage: Exclude<CccModelAdmissionStage, "campaign_admitted">;
  readonly code: string;
  readonly outcome: Exclude<CccModelAdmissionVerdict, "admitted">;
  readonly evidenceId: string | null;
  readonly message: string;
  readonly nextProbe: Readonly<CccModelAdmissionNextProbe>;
}

export interface CccModelAdmissionResult {
  readonly verdict: CccModelAdmissionVerdict;
  readonly highestStage: CccModelAdmissionStage | null;
  readonly reasons: readonly Readonly<CccModelAdmissionReason>[];
  readonly nextProbe: Readonly<CccModelAdmissionNextProbe> | null;
}

type EvidenceStage = Exclude<CccModelAdmissionStage, "campaign_admitted">;
type NonAdmittedVerdict = Exclude<CccModelAdmissionVerdict, "admitted">;
type UnknownRecord = Record<string, unknown>;

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const entry of Object.values(value)) deepFreeze(entry);
  return Object.freeze(value);
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function addReason(
  reasons: CccModelAdmissionReason[],
  stage: EvidenceStage,
  code: string,
  outcome: NonAdmittedVerdict,
  evidenceId: string | null,
  message: string,
  probeKind: string,
): void {
  reasons.push({
    stage,
    code,
    outcome,
    evidenceId,
    message,
    nextProbe: { stage, kind: probeKind, evidenceId },
  });
}

const EVIDENCE_RANK: Readonly<Record<CccModelCapabilityEvidenceState, number>> = {
  unknown: 0,
  declared: 1,
  offline_proven: 2,
  live_proven: 3,
};

function evaluateCapabilityEvidence(
  profile: Readonly<CccModelCapabilityProfile>,
  reasons: CccModelAdmissionReason[],
): void {
  for (const key of CCC_MODEL_CAPABILITY_KEYS) {
    const evidence = profile.capabilities[key].evidence;
    const rank = EVIDENCE_RANK[evidence];
    if (rank < EVIDENCE_RANK.declared) {
      addReason(
        reasons,
        "profile_validated",
        "capability_evidence_too_low",
        "insufficient_evidence",
        key,
        `${key} requires declared evidence for profile validation`,
        "declare_capability",
      );
    } else if (rank < EVIDENCE_RANK.offline_proven) {
      addReason(
        reasons,
        "offline_conformance",
        "capability_evidence_too_low",
        "insufficient_evidence",
        key,
        `${key} requires offline_proven evidence for offline conformance`,
        "run_offline_capability_probe",
      );
    } else if (rank < EVIDENCE_RANK.live_proven) {
      addReason(
        reasons,
        "live_microprobe",
        "capability_evidence_too_low",
        "insufficient_evidence",
        key,
        `${key} requires live_proven evidence for live admission stages`,
        "run_live_capability_probe",
      );
    }
  }
}

function evaluateOfflineEvidence(
  input: CccModelAdmissionInput,
  policy: Readonly<CccModelAdmissionPolicy>,
  reasons: CccModelAdmissionReason[],
): void {
  const probes = Array.isArray(input.offlineProbes) ? input.offlineProbes : [];
  const byId = new Map<string, CccOfflineProbeResult>();
  let malformed = false;
  for (const probe of probes) {
    if (!isRecord(probe) || !isNonEmptyString(probe.fixtureId) || !isBoolean(probe.passed)) {
      malformed = true;
      continue;
    }
    if (byId.has(probe.fixtureId)) {
      addReason(
        reasons,
        "offline_conformance",
        "duplicate_offline_fixture",
        "insufficient_evidence",
        probe.fixtureId,
        `offline fixture ${probe.fixtureId} appears more than once`,
        "replace_offline_fixture_evidence",
      );
    } else {
      byId.set(probe.fixtureId, probe);
    }
  }
  if (malformed) {
    addReason(
      reasons,
      "offline_conformance",
      "malformed_offline_evidence",
      "insufficient_evidence",
      null,
      "offline probe evidence is malformed",
      "replace_offline_fixture_evidence",
    );
  }
  for (const fixtureId of policy.requiredOfflineFixtureIds) {
    const probe = byId.get(fixtureId);
    if (!probe) {
      addReason(
        reasons,
        "offline_conformance",
        "offline_fixture_missing",
        "insufficient_evidence",
        fixtureId,
        `required offline fixture ${fixtureId} is missing`,
        "run_offline_fixture",
      );
    } else if (!probe.passed) {
      addReason(
        reasons,
        "offline_conformance",
        "offline_fixture_failed",
        "rejected",
        fixtureId,
        `required offline fixture ${fixtureId} failed`,
        "rerun_offline_fixture_after_repair",
      );
    }
  }
  evaluateControl("positive", input.controls?.positive, reasons);
  evaluateControl("negative", input.controls?.negative, reasons);
}

function evaluateControl(
  name: "positive" | "negative",
  control: unknown,
  reasons: CccModelAdmissionReason[],
): void {
  if (!isRecord(control) || !isBoolean(control.observed) || !isBoolean(control.passed)) {
    addReason(
      reasons,
      "offline_conformance",
      `${name}_control_missing`,
      "insufficient_evidence",
      `${name}-control`,
      `${name} control evidence is missing or malformed`,
      `run_${name}_control`,
    );
  } else if (!control.observed) {
    addReason(
      reasons,
      "offline_conformance",
      `${name}_control_missing`,
      "insufficient_evidence",
      `${name}-control`,
      `${name} control was not observed`,
      `run_${name}_control`,
    );
  } else if (!control.passed) {
    addReason(
      reasons,
      "offline_conformance",
      `${name}_control_failed`,
      "rejected",
      `${name}-control`,
      `${name} control did not produce its expected result`,
      `rerun_${name}_control_after_repair`,
    );
  }
}

function evaluateRouteEvidence(
  input: CccModelAdmissionInput,
  profile: Readonly<CccModelCapabilityProfile>,
  reasons: CccModelAdmissionReason[],
): void {
  const route = input.routeEvidence;
  if (
    !isRecord(route) ||
    route.proofPresent !== true ||
    route.finalReceiptPresent !== true ||
    !hasRouteIdentity(route.requestedRoute, true) ||
    !hasRouteIdentity(route.effectiveRoute, false) ||
    typeof route.profileDigest !== "string" ||
    !/^[0-9a-f]{64}$/.test(route.profileDigest)
  ) {
    addReason(
      reasons,
      "live_microprobe",
      "route_proof_missing",
      "insufficient_evidence",
      "route-evidence",
      "requested and effective route proof with final receipt is required",
      "run_route_receipt_probe",
    );
    return;
  }
  const expectedDigest = digestCccModelCapabilityProfile(profile);
  const requestedMatches =
    route.requestedRoute.provider === profile.route.provider &&
    route.requestedRoute.model === profile.route.model &&
    route.requestedRoute.transport === profile.route.transport;
  const effectiveMatches =
    route.effectiveRoute.provider === profile.route.provider &&
    route.effectiveRoute.model === profile.route.model;
  if (route.profileDigest !== expectedDigest || !requestedMatches || !effectiveMatches) {
    addReason(
      reasons,
      "live_microprobe",
      "route_identity_mismatch",
      "rejected",
      "route-evidence",
      "requested/effective route evidence does not match the capability profile",
      "rerun_route_identity_probe",
    );
  }
}

function hasRouteIdentity(value: unknown, includeTransport: boolean): value is UnknownRecord {
  return (
    isRecord(value) &&
    isNonEmptyString(value.provider) &&
    isNonEmptyString(value.model) &&
    (!includeTransport || isNonEmptyString(value.transport))
  );
}

function isTerminalResult(value: unknown): value is CccAdmissionTerminalResult {
  return (
    isRecord(value) &&
    isBoolean(value.routeMatched) &&
    typeof value.terminalClassification === "string" &&
    ["none", "success", "failure", "cancelled", "dispatched_unknown"].includes(
      value.terminalClassification,
    ) &&
    isBoolean(value.streamClosed) &&
    isBoolean(value.unresolvedAttempt)
  );
}

function evaluateTerminalResult(
  result: CccAdmissionTerminalResult,
  stage: "live_microprobe" | "replicated_scenarios",
  evidenceId: string,
  reasons: CccModelAdmissionReason[],
): void {
  if (
    result.unresolvedAttempt ||
    result.terminalClassification === "dispatched_unknown"
  ) {
    addReason(
      reasons,
      stage,
      "unresolved_dispatched_unknown",
      "rejected",
      evidenceId,
      `${evidenceId} contains an unresolved dispatched_unknown attempt`,
      "run_new_attempt_after_reconciliation",
    );
    return;
  }
  if (!result.routeMatched) {
    addReason(
      reasons,
      stage,
      "route_substitution_observed",
      "rejected",
      evidenceId,
      `${evidenceId} observed route substitution`,
      "rerun_with_bound_route_proof",
    );
  }
  if (!result.streamClosed) {
    addReason(
      reasons,
      stage,
      "terminal_stream_closure_missing",
      "rejected",
      evidenceId,
      `${evidenceId} lacks terminal stream closure`,
      "rerun_terminal_closure_probe",
    );
  }
  if (result.terminalClassification !== "success") {
    addReason(
      reasons,
      stage,
      "valid_terminal_success_missing",
      "rejected",
      evidenceId,
      `${evidenceId} did not return a successful terminal classification`,
      "rerun_terminal_probe",
    );
  }
}

function evaluateMicroprobes(
  input: CccModelAdmissionInput,
  policy: Readonly<CccModelAdmissionPolicy>,
  reasons: CccModelAdmissionReason[],
): void {
  const probes = Array.isArray(input.liveMicroprobes) ? input.liveMicroprobes : [];
  const valid: CccLiveMicroprobeResult[] = [];
  const ids = new Set<string>();
  let malformed = false;
  for (const probe of probes) {
    const candidate: unknown = probe;
    if (
      !isRecord(candidate) ||
      !isTerminalResult(candidate) ||
      !isNonEmptyString(candidate.probeId) ||
      ids.has(candidate.probeId)
    ) {
      malformed = true;
      continue;
    }
    ids.add(candidate.probeId);
    valid.push(candidate as unknown as CccLiveMicroprobeResult);
  }
  if (malformed) {
    addReason(
      reasons,
      "live_microprobe",
      "malformed_microprobe_evidence",
      "insufficient_evidence",
      null,
      "live microprobe evidence is malformed or duplicated",
      "replace_live_microprobe_evidence",
    );
  } else if (valid.length < policy.minimumLiveMicroprobes) {
    addReason(
      reasons,
      "live_microprobe",
      "microprobe_replication_insufficient",
      "insufficient_evidence",
      null,
      `${policy.minimumLiveMicroprobes} valid live microprobes are required`,
      "run_live_microprobe",
    );
  }
  for (const probe of valid) {
    evaluateTerminalResult(probe, "live_microprobe", probe.probeId, reasons);
  }
}

function evaluateScenarios(
  input: CccModelAdmissionInput,
  policy: Readonly<CccModelAdmissionPolicy>,
  reasons: CccModelAdmissionReason[],
): void {
  const results = Array.isArray(input.replicatedScenarios)
    ? input.replicatedScenarios
    : [];
  const byId = new Map<string, CccReplicatedScenarioResult>();
  let malformed = false;
  for (const result of results) {
    const candidate: unknown = result;
    if (
      !isRecord(candidate) ||
      !isTerminalResult(candidate) ||
      !isNonEmptyString(candidate.armId) ||
      byId.has(candidate.armId)
    ) {
      malformed = true;
      continue;
    }
    byId.set(candidate.armId, candidate as unknown as CccReplicatedScenarioResult);
  }
  if (malformed) {
    addReason(
      reasons,
      "replicated_scenarios",
      "malformed_scenario_evidence",
      "insufficient_evidence",
      null,
      "replicated scenario evidence is malformed or duplicated",
      "replace_scenario_evidence",
    );
  }
  const expectedArmIds = new Set(policy.replicatedScenarioArmIds);
  for (const [armId, result] of [...byId.entries()]
    .filter(([armId]) => !expectedArmIds.has(armId))
    .sort(([left], [right]) => left.localeCompare(right))) {
    addReason(
      reasons,
      "replicated_scenarios",
      "unexpected_scenario_arm",
      "insufficient_evidence",
      armId,
      `scenario arm ${armId} is not part of the predefined policy`,
      "replace_scenario_evidence",
    );
    evaluateTerminalResult(result, "replicated_scenarios", armId, reasons);
  }
  for (const armId of policy.replicatedScenarioArmIds) {
    const result = byId.get(armId);
    if (!result) {
      addReason(
        reasons,
        "replicated_scenarios",
        "scenario_arm_missing",
        "insufficient_evidence",
        armId,
        `predefined scenario arm ${armId} is missing`,
        "run_replicated_scenario_arm",
      );
    } else {
      evaluateTerminalResult(result, "replicated_scenarios", armId, reasons);
    }
  }
}

function isCodingTrial(value: unknown): value is CccBoundedCodingTrialResult {
  return (
    isRecord(value) &&
    isTerminalResult(value) &&
    isNonEmptyString(value.taskId) &&
    isBoolean(value.sealed) &&
    isBoolean(value.diffProduced) &&
    isBoolean(value.verifierPassed) &&
    isBoolean(value.scopeClean) &&
    isBoolean(value.proofEligible)
  );
}

function evaluateCoding(
  input: CccModelAdmissionInput,
  policy: Readonly<CccModelAdmissionPolicy>,
  reasons: CccModelAdmissionReason[],
): void {
  const trials = Array.isArray(input.boundedCodingTrials)
    ? input.boundedCodingTrials
    : [];
  const byId = new Map<string, CccBoundedCodingTrialResult>();
  let malformed = false;
  for (const trial of trials) {
    if (!isCodingTrial(trial) || byId.has(trial.taskId)) {
      malformed = true;
      continue;
    }
    byId.set(trial.taskId, trial);
  }
  if (malformed) {
    addReason(
      reasons,
      "bounded_coding",
      "malformed_coding_evidence",
      "insufficient_evidence",
      null,
      "bounded coding evidence is malformed or duplicated",
      "replace_bounded_coding_evidence",
    );
  }
  const expectedTaskIds = new Set(policy.boundedCodingTaskIds);
  for (const [taskId, trial] of [...byId.entries()]
    .filter(([taskId]) => !expectedTaskIds.has(taskId))
    .sort(([left], [right]) => left.localeCompare(right))) {
    addReason(
      reasons,
      "bounded_coding",
      "unexpected_coding_task",
      "insufficient_evidence",
      taskId,
      `coding task ${taskId} is not part of the sealed policy`,
      "replace_bounded_coding_evidence",
    );
    evaluateCodingTrial(trial, taskId, reasons);
  }
  for (const taskId of policy.boundedCodingTaskIds) {
    const trial = byId.get(taskId);
    if (!trial) {
      addReason(
        reasons,
        "bounded_coding",
        "coding_task_missing",
        "insufficient_evidence",
        taskId,
        `sealed bounded coding task ${taskId} is missing`,
        "run_bounded_coding_task",
      );
      continue;
    }
    evaluateCodingTrial(trial, taskId, reasons);
  }
}

function evaluateCodingTrial(
  trial: CccBoundedCodingTrialResult,
  taskId: string,
  reasons: CccModelAdmissionReason[],
): void {
  if (trial.unresolvedAttempt || trial.terminalClassification === "dispatched_unknown") {
    addReason(
      reasons,
      "bounded_coding",
      "unresolved_dispatched_unknown",
      "rejected",
      taskId,
      `${taskId} contains an unresolved dispatched_unknown attempt`,
      "run_new_attempt_after_reconciliation",
    );
    return;
  }
  if (!trial.sealed) addCodingFailure(reasons, taskId, "coding_task_unsealed", "seal_and_rerun_coding_task");
  if (!trial.diffProduced) addCodingFailure(reasons, taskId, "coding_diff_missing", "rerun_bounded_coding_task");
  if (!trial.routeMatched) addCodingFailure(reasons, taskId, "route_substitution_observed", "rerun_with_bound_route_proof");
  if (trial.terminalClassification !== "success") {
    addCodingFailure(reasons, taskId, "coding_terminal_return_missing", "rerun_coding_terminal_probe");
  }
  if (!trial.streamClosed) addCodingFailure(reasons, taskId, "terminal_stream_closure_missing", "rerun_terminal_closure_probe");
  if (!trial.verifierPassed) addCodingFailure(reasons, taskId, "coding_verifier_failed", "rerun_sealed_verifier_after_repair");
  if (!trial.scopeClean) addCodingFailure(reasons, taskId, "coding_scope_dirty", "rerun_clean_scope_task");
  if (!trial.proofEligible) addCodingFailure(reasons, taskId, "coding_proof_ineligible", "rerun_proof_eligible_task");
}

function addCodingFailure(
  reasons: CccModelAdmissionReason[],
  taskId: string,
  code: string,
  probeKind: string,
): void {
  addReason(
    reasons,
    "bounded_coding",
    code,
    "rejected",
    taskId,
    `${taskId} failed ${code}`,
    probeKind,
  );
}

function highestPassedStage(
  reasons: readonly CccModelAdmissionReason[],
): CccModelAdmissionStage | null {
  let highest: CccModelAdmissionStage | null = null;
  for (const stage of CCC_MODEL_ADMISSION_STAGES.slice(0, -1) as EvidenceStage[]) {
    if (reasons.some((reason) => reason.stage === stage)) return highest;
    highest = stage;
  }
  return "campaign_admitted";
}

export function evaluateCccModelAdmission(
  input: CccModelAdmissionInput,
  policy: Readonly<CccModelAdmissionPolicy> = CCC_MODEL_ADMISSION_POLICY_V1,
): Readonly<CccModelAdmissionResult> {
  const reasons: CccModelAdmissionReason[] = [];
  let profile: Readonly<CccModelCapabilityProfile>;
  try {
    profile = parseCccModelCapabilityProfile(input?.profile);
  } catch (error) {
    const message =
      error instanceof CccModelCapabilityProfileValidationError
        ? error.message
        : "profile validation failed";
    addReason(
      reasons,
      "profile_validated",
      "profile_invalid",
      "insufficient_evidence",
      null,
      message,
      "replace_capability_profile",
    );
    return deepFreeze({
      verdict: "insufficient_evidence",
      highestStage: null,
      reasons,
      nextProbe: reasons[0].nextProbe,
    });
  }

  evaluateCapabilityEvidence(profile, reasons);
  evaluateOfflineEvidence(input, policy, reasons);
  evaluateRouteEvidence(input, profile, reasons);
  evaluateMicroprobes(input, policy, reasons);
  evaluateScenarios(input, policy, reasons);
  evaluateCoding(input, policy, reasons);

  const verdict: CccModelAdmissionVerdict = reasons.some(
    (reason) => reason.outcome === "rejected",
  )
    ? "rejected"
    : reasons.length > 0
      ? "insufficient_evidence"
      : "admitted";
  return deepFreeze({
    verdict,
    highestStage: highestPassedStage(reasons),
    reasons,
    nextProbe: verdict === "admitted" ? null : reasons[0].nextProbe,
  });
}
