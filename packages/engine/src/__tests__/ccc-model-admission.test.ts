import { describe, expect, it } from "vitest";

import {
  digestCccModelCapabilityProfile,
  parseCccModelCapabilityProfile,
} from "@fusion/core";

import {
  CCC_MODEL_ADMISSION_POLICY_V1,
  CCC_MODEL_ADMISSION_STAGES,
  evaluateCccModelAdmission,
  type CccModelAdmissionInput,
} from "../ccc-model-admission.js";

const SCHEMA_A = `sha256:${"a".repeat(64)}`;
const SCHEMA_B = `sha256:${"b".repeat(64)}`;

function profile(evidence: "unknown" | "declared" | "offline_proven" | "live_proven" = "live_proven") {
  const known = <T>(value: T) =>
    evidence === "unknown"
      ? { evidence: "unknown", value: null }
      : { evidence, value };
  return parseCccModelCapabilityProfile({
    schemaVersion: "1.0",
    profileId: "admission-profile-v1",
    revision: 1,
    route: {
      provider: "provider-under-test",
      model: "model-under-test",
      transport: "openai-compatible-stream",
    },
    capabilities: {
      supportedInstructionRoles: known(["system", "developer"]),
      reasoningRequestDialect: known("reasoning.effort"),
      reasoningResponseDialect: known("reasoning_blocks"),
      reasoningHistoryReplay: known("required"),
      toolCallRequestSchema: known(SCHEMA_A),
      toolCallResponseSchema: known(SCHEMA_B),
      toolCallIdPreservation: known(true),
      terminalFinishSignals: known(["stop", "tool_calls", "length", "error"]),
      finalRouteReceipt: known(true),
      usageReceipt: known(true),
      streamFinalization: known("explicit_terminal_then_close"),
      resumeReplaySafety: known("conditional"),
      declaredLimits: known({ contextTokens: 131_072, outputTokens: 16_384 }),
      transportTransformationOwner: known("gateway"),
    },
  });
}

function fullInput(): CccModelAdmissionInput {
  const modelProfile = profile();
  return {
    profile: modelProfile,
    offlineProbes: CCC_MODEL_ADMISSION_POLICY_V1.requiredOfflineFixtureIds.map(
      (fixtureId) => ({ fixtureId, passed: true }),
    ),
    controls: {
      positive: { observed: true, passed: true },
      negative: { observed: true, passed: true },
    },
    routeEvidence: {
      profileDigest: digestCccModelCapabilityProfile(modelProfile),
      requestedRoute: {
        provider: "provider-under-test",
        model: "model-under-test",
        transport: "openai-compatible-stream",
      },
      effectiveRoute: {
        provider: "provider-under-test",
        model: "model-under-test",
      },
      proofPresent: true,
      finalReceiptPresent: true,
    },
    liveMicroprobes: Array.from({ length: 10 }, (_, index) => ({
      probeId: `micro-${String(index + 1).padStart(2, "0")}`,
      routeMatched: true,
      terminalClassification: "success" as const,
      streamClosed: true,
      unresolvedAttempt: false,
    })),
    replicatedScenarios: CCC_MODEL_ADMISSION_POLICY_V1.replicatedScenarioArmIds.map(
      (armId) => ({
        armId,
        routeMatched: true,
        terminalClassification: "success" as const,
        streamClosed: true,
        unresolvedAttempt: false,
      }),
    ),
    boundedCodingTrials: CCC_MODEL_ADMISSION_POLICY_V1.boundedCodingTaskIds.map(
      (taskId) => ({
        taskId,
        sealed: true,
        routeMatched: true,
        terminalClassification: "success" as const,
        streamClosed: true,
        unresolvedAttempt: false,
        diffProduced: true,
        verifierPassed: true,
        scopeClean: true,
        proofEligible: true,
      }),
    ),
  };
}

describe("CCC deterministic model admission", () => {
  it("PRD-C1 exports the fixed version-one stage and sample policy", () => {
    expect(CCC_MODEL_ADMISSION_STAGES).toEqual([
      "profile_validated",
      "offline_conformance",
      "live_microprobe",
      "replicated_scenarios",
      "bounded_coding",
      "campaign_admitted",
    ]);
    expect(CCC_MODEL_ADMISSION_POLICY_V1.minimumLiveMicroprobes).toBe(10);
    expect(CCC_MODEL_ADMISSION_POLICY_V1.replicatedScenarioArmIds).toHaveLength(30);
    expect(CCC_MODEL_ADMISSION_POLICY_V1.boundedCodingTaskIds).toHaveLength(5);
  });

  it("PRD-C2 admits only the complete policy-conformant evidence set", () => {
    expect(evaluateCccModelAdmission(fullInput())).toEqual({
      verdict: "admitted",
      highestStage: "campaign_admitted",
      reasons: [],
      nextProbe: null,
    });
  });

  it("PRD-C3 refuses a campaign-critical unknown capability", () => {
    const input = fullInput();
    input.profile = profile("unknown");
    input.routeEvidence.profileDigest = digestCccModelCapabilityProfile(input.profile);

    const result = evaluateCccModelAdmission(input);
    expect(result.verdict).toBe("insufficient_evidence");
    expect(result.highestStage).toBeNull();
    expect(result.reasons[0]).toMatchObject({
      stage: "profile_validated",
      code: "capability_evidence_too_low",
      evidenceId: "declaredLimits",
    });
    expect(result.nextProbe).toEqual(
      result.reasons[0]?.nextProbe,
    );
  });

  it("PRD-C4 rejects an offline fixture or control failure", () => {
    const fixtureFailure = fullInput();
    fixtureFailure.offlineProbes[0] = {
      ...fixtureFailure.offlineProbes[0],
      passed: false,
    };
    const controlFailure = fullInput();
    controlFailure.controls.negative.passed = false;

    expect(evaluateCccModelAdmission(fixtureFailure)).toMatchObject({
      verdict: "rejected",
      highestStage: "profile_validated",
      reasons: [{ code: "offline_fixture_failed" }],
    });
    expect(evaluateCccModelAdmission(controlFailure)).toMatchObject({
      verdict: "rejected",
      reasons: [{ code: "negative_control_failed" }],
    });
  });

  it("PRD-C5 requires 10 of 10 valid terminal microprobes", () => {
    const input = fullInput();
    input.liveMicroprobes.pop();

    expect(evaluateCccModelAdmission(input)).toMatchObject({
      verdict: "insufficient_evidence",
      highestStage: "offline_conformance",
      reasons: [{ code: "microprobe_replication_insufficient" }],
      nextProbe: {
        stage: "live_microprobe",
        kind: "run_live_microprobe",
      },
    });
  });

  it("PRD-C6 requires all 30 predefined replicated arms", () => {
    const input = fullInput();
    const missingArm = input.replicatedScenarios.pop()?.armId;

    expect(evaluateCccModelAdmission(input)).toMatchObject({
      verdict: "insufficient_evidence",
      highestStage: "live_microprobe",
      reasons: [
        {
          code: "scenario_arm_missing",
          evidenceId: missingArm,
        },
      ],
    });
  });

  it("PRD-C7 requires all five sealed bounded coding tasks", () => {
    const input = fullInput();
    const missingTask = input.boundedCodingTrials.pop()?.taskId;

    expect(evaluateCccModelAdmission(input)).toMatchObject({
      verdict: "insufficient_evidence",
      highestStage: "replicated_scenarios",
      reasons: [
        {
          code: "coding_task_missing",
          evidenceId: missingTask,
        },
      ],
    });
  });

  it("PRD-C8 rejects missing route proof and route substitution", () => {
    const missing = fullInput();
    missing.routeEvidence.proofPresent = false;
    missing.routeEvidence.effectiveRoute = null;
    const mismatch = fullInput();
    mismatch.routeEvidence.effectiveRoute = {
      provider: "substituted-provider",
      model: "substituted-model",
    };

    expect(evaluateCccModelAdmission(missing)).toMatchObject({
      verdict: "insufficient_evidence",
      reasons: [{ code: "route_proof_missing" }],
    });
    expect(evaluateCccModelAdmission(mismatch)).toMatchObject({
      verdict: "rejected",
      reasons: [{ code: "route_identity_mismatch" }],
    });
  });

  it("PRD-C9 rejects every unresolved dispatched_unknown attempt", () => {
    const input = fullInput();
    input.replicatedScenarios[4] = {
      ...input.replicatedScenarios[4],
      terminalClassification: "dispatched_unknown",
      streamClosed: false,
      unresolvedAttempt: true,
    };

    const result = evaluateCccModelAdmission(input);
    expect(result.verdict).toBe("rejected");
    expect(result.reasons.map((reason) => reason.code)).toContain(
      "unresolved_dispatched_unknown",
    );
  });

  it("PRD-C10 rejects a passing diff without a terminal model return", () => {
    const input = fullInput();
    input.boundedCodingTrials[0] = {
      ...input.boundedCodingTrials[0],
      diffProduced: true,
      verifierPassed: true,
      scopeClean: true,
      proofEligible: true,
      terminalClassification: "none",
      streamClosed: true,
    };

    expect(evaluateCccModelAdmission(input)).toMatchObject({
      verdict: "rejected",
      highestStage: "replicated_scenarios",
      reasons: [{ code: "coding_terminal_return_missing" }],
    });
  });

  it.each([
    ["verifierPassed", "coding_verifier_failed"],
    ["scopeClean", "coding_scope_dirty"],
    ["proofEligible", "coding_proof_ineligible"],
    ["sealed", "coding_task_unsealed"],
    ["diffProduced", "coding_diff_missing"],
  ] as const)("PRD-C11 rejects %s failure", (field, code) => {
    const input = fullInput();
    input.boundedCodingTrials[0] = {
      ...input.boundedCodingTrials[0],
      [field]: false,
    };

    expect(evaluateCccModelAdmission(input).reasons).toEqual(
      expect.arrayContaining([expect.objectContaining({ code })]),
    );
  });

  it("PRD-C12 distinguishes malformed evidence from negative evidence", () => {
    const input = fullInput();
    input.liveMicroprobes = [null as never];

    const result = evaluateCccModelAdmission(input);
    expect(result.verdict).toBe("insufficient_evidence");
    expect(result.reasons.map((reason) => reason.code)).toEqual([
      "malformed_microprobe_evidence",
      "microprobe_replication_insufficient",
    ]);
  });

  it("PRD-C13 orders reasons deterministically and uses the first next probe", () => {
    const input = fullInput();
    input.liveMicroprobes.pop();
    input.boundedCodingTrials[0] = {
      ...input.boundedCodingTrials[0],
      verifierPassed: false,
    };

    const first = evaluateCccModelAdmission(input);
    const second = evaluateCccModelAdmission(input);
    expect(first).toEqual(second);
    expect(first.verdict).toBe("rejected");
    expect(first.reasons.map((reason) => reason.code)).toEqual([
      "microprobe_replication_insufficient",
      "coding_verifier_failed",
    ]);
    expect(first.nextProbe).toEqual(first.reasons[0]?.nextProbe);
  });

  it("PRD-C14 rejects unresolved attempts even under unexpected evidence IDs", () => {
    const input = fullInput();
    input.replicatedScenarios.push({
      armId: "unexpected-arm",
      routeMatched: true,
      terminalClassification: "dispatched_unknown",
      streamClosed: false,
      unresolvedAttempt: true,
    });
    input.boundedCodingTrials.push({
      taskId: "unexpected-task",
      sealed: true,
      routeMatched: true,
      terminalClassification: "dispatched_unknown",
      streamClosed: false,
      unresolvedAttempt: true,
      diffProduced: true,
      verifierPassed: true,
      scopeClean: true,
      proofEligible: true,
    });

    const result = evaluateCccModelAdmission(input);
    expect(result.verdict).toBe("rejected");
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "unresolved_dispatched_unknown",
          evidenceId: "unexpected-arm",
        }),
        expect.objectContaining({
          code: "unresolved_dispatched_unknown",
          evidenceId: "unexpected-task",
        }),
      ]),
    );
  });

  it("PRD-C15 treats malformed route identity as insufficient evidence", () => {
    const input = fullInput();
    input.routeEvidence.requestedRoute = {} as never;

    expect(evaluateCccModelAdmission(input)).toMatchObject({
      verdict: "insufficient_evidence",
      reasons: [{ code: "route_proof_missing" }],
    });
  });

  it("PRD-C16 rejects negative evidence hidden behind duplicate IDs", () => {
    const input = fullInput();
    input.offlineProbes.push({
      fixtureId: input.offlineProbes[0].fixtureId,
      passed: false,
    });
    input.liveMicroprobes.push({
      ...input.liveMicroprobes[0],
      terminalClassification: "dispatched_unknown",
      unresolvedAttempt: true,
      streamClosed: false,
    });
    input.replicatedScenarios.push({
      ...input.replicatedScenarios[0],
      terminalClassification: "dispatched_unknown",
      unresolvedAttempt: true,
      streamClosed: false,
    });
    input.boundedCodingTrials.push({
      ...input.boundedCodingTrials[0],
      terminalClassification: "dispatched_unknown",
      unresolvedAttempt: true,
      streamClosed: false,
    });

    const result = evaluateCccModelAdmission(input);
    expect(result.verdict).toBe("rejected");
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "offline_fixture_failed" }),
        expect.objectContaining({
          code: "unresolved_dispatched_unknown",
          evidenceId: input.liveMicroprobes[0].probeId,
        }),
        expect.objectContaining({
          code: "unresolved_dispatched_unknown",
          evidenceId: input.replicatedScenarios[0].armId,
        }),
        expect.objectContaining({
          code: "unresolved_dispatched_unknown",
          evidenceId: input.boundedCodingTrials[0].taskId,
        }),
      ]),
    );
  });

  it("PRD-C17 orders mixed capability failures by stage before next probe", () => {
    const input = fullInput();
    const mixed = structuredClone(input.profile) as unknown as {
      capabilities: Record<
        string,
        { evidence: string; value: unknown }
      >;
    };
    mixed.capabilities.supportedInstructionRoles.evidence = "offline_proven";
    mixed.capabilities.usageReceipt = { evidence: "unknown", value: null };
    input.profile = parseCccModelCapabilityProfile(mixed);
    input.routeEvidence.profileDigest = digestCccModelCapabilityProfile(input.profile);

    const result = evaluateCccModelAdmission(input);
    expect(result.reasons[0]).toMatchObject({
      stage: "profile_validated",
      evidenceId: "usageReceipt",
    });
    expect(result.nextProbe?.stage).toBe("profile_validated");
    expect(
      result.reasons.findIndex((reason) => reason.stage === "live_microprobe"),
    ).toBeGreaterThan(0);
  });

  it("PRD-C18 reports malformed microprobes and the remaining count deficit", () => {
    const input = fullInput();
    input.liveMicroprobes = [null as never, ...input.liveMicroprobes.slice(0, 9)];

    expect(
      evaluateCccModelAdmission(input).reasons.map((reason) => reason.code),
    ).toEqual(
      expect.arrayContaining([
        "malformed_microprobe_evidence",
        "microprobe_replication_insufficient",
      ]),
    );
  });
});
