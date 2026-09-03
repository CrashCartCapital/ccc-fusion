import {
  GOLDEN_PI_DRIVERS,
  type GoldenPiDriver,
} from "./ccc-golden-pi-driver-matrix.js";

export const GATE2_TELEMETRY_PI_ENVELOPE = Object.freeze({
  taskCount: 6,
  maxRequests: 2_304,
  maxDurationMs: 21_600_000,
  maxConcurrency: 3,
  contextWindow: 200_000,
  maxOutputTokens: 32_768,
  // Request count and wall time are the campaign's real runaway guards. Keep
  // the task token budget above the theoretical full shared request envelope
  // so repeated long-context MiniMax turns cannot preempt a useful product.
  taskTokenBudget: Object.freeze({ soft: 500_000_000, hard: 600_000_000 }),
});

function peer(key: string): GoldenPiDriver {
  const driver = GOLDEN_PI_DRIVERS.find((candidate) => candidate.key === key);
  if (!driver) throw new Error(`missing Gate 2 Pi peer: ${key}`);
  return driver;
}

export const GATE2_TELEMETRY_PI_PEERS = Object.freeze({
  minimax: peer("minimax-latest"),
  glm: peer("glm-latest"),
  gemini: peer("gemini-flash-latest"),
});

export type Gate2LiveMode = "clean" | "recovery" | "stop";

export function buildGate2UsefulnessEvidenceState(
  mode: Gate2LiveMode,
  evidence: unknown,
  recoveryBoundary?: unknown,
) {
  if (mode === "stop") {
    return {
      applicability: "not_applicable_stop_mode",
      status: "not_applicable",
      reason: "campaign_stopped_before_landing",
    } as const;
  }
  if (
    mode === "recovery"
    && typeof recoveryBoundary === "object"
    && recoveryBoundary !== null
    && (recoveryBoundary as { recoveryKind?: unknown }).recoveryKind === "installed_runtime_restart"
    && (recoveryBoundary as { providerExecution?: unknown }).providerExecution === "not_required"
  ) {
    return {
      applicability: "not_applicable_operational_recovery_lane",
      status: "not_applicable",
      reason: "operational_recovery_lane_has_no_landed_candidate",
    } as const;
  }
  const passed = typeof evidence === "object"
    && evidence !== null
    && (evidence as { finalTargetStatus?: unknown }).finalTargetStatus === "passed";
  return {
    applicability: "required",
    status: passed ? "passed" : "missing",
    reason: passed ? "usefulness_probe_passed" : "usefulness_probe_not_completed",
  } as const;
}

export function buildGate2RecoveryEvidenceState(
  mode: Gate2LiveMode,
  evidence: unknown,
) {
  if (mode !== "recovery") {
    return {
      applicability: mode === "clean"
        ? "not_applicable_clean_mode"
        : "not_applicable_stop_mode",
      recoveryKind: "none",
      status: "not_applicable",
    } as const;
  }
  const passed = typeof evidence === "object"
    && evidence !== null
    && (evidence as { restartCompleted?: unknown }).restartCompleted === true;
  if (
    typeof evidence === "object"
    && evidence !== null
    && (evidence as { recoveryKind?: unknown }).recoveryKind === "installed_runtime_restart"
    && (evidence as { providerExecution?: unknown }).providerExecution === "not_required"
  ) {
    return {
      applicability: "required",
      recoveryKind: "installed_runtime_restart",
      providerExecution: "not_required",
      status: passed ? "passed" : "missing",
    } as const;
  }
  return {
    applicability: "required",
    recoveryKind: "controlled_restart",
    status: passed ? "passed" : "missing",
  } as const;
}

export function buildGate2ReadinessState(input: Readonly<{
  mode: Gate2LiveMode;
  outcome: "passed" | "failed";
  landingEvidence: unknown;
  usefulnessEvidence: unknown;
  recoveryBoundary?: unknown;
}>) {
  if (input.outcome !== "passed") {
    return { status: "not_proven", reason: "live_run_failed" } as const;
  }
  if (input.mode === "stop") {
    return { status: "not_proven", reason: "campaign_stopped_before_landing" } as const;
  }
  if (
    input.mode === "recovery"
    && (
      typeof input.recoveryBoundary !== "object"
      || input.recoveryBoundary === null
      || (input.recoveryBoundary as { continuityVerified?: unknown }).continuityVerified !== true
    )
  ) {
    return { status: "not_proven", reason: "controlled_restart_continuity_missing" } as const;
  }
  if (
    input.mode === "recovery"
    && typeof input.recoveryBoundary === "object"
    && input.recoveryBoundary !== null
    && (input.recoveryBoundary as { recoveryKind?: unknown }).recoveryKind === "installed_runtime_restart"
    && (input.recoveryBoundary as { providerExecution?: unknown }).providerExecution === "not_required"
  ) {
    return {
      status: "not_proven",
      reason: "operational_recovery_lane_not_whole_product",
    } as const;
  }
  const landingPassed = typeof input.landingEvidence === "object"
    && input.landingEvidence !== null
    && (input.landingEvidence as { status?: unknown }).status === "passed"
    && (input.landingEvidence as { duplicateEffectPrevented?: unknown }).duplicateEffectPrevented === true;
  const usefulnessPassed = typeof input.usefulnessEvidence === "object"
    && input.usefulnessEvidence !== null
    && (input.usefulnessEvidence as { finalTargetStatus?: unknown }).finalTargetStatus === "passed";
  return landingPassed && usefulnessPassed
    ? { status: "proved", reason: "landing_and_usefulness_passed" } as const
    : { status: "not_proven", reason: "landing_or_usefulness_missing" } as const;
}

export function buildGate2RuntimeExecutionBoundary(input: {
  receiptSchema: string;
  receiptDigest: string;
}) {
  return {
    schema: "ccc-gate2.runtime-execution-boundary.v1",
    installedRuntime: {
      status: "receipt_bound",
      receiptSchema: input.receiptSchema,
      receiptDigest: input.receiptDigest,
      surfaces: [
        "fn-cli",
        "prd-controller",
        "semantic-proof-toolchain",
        "central-core",
        "task-store",
        "in-process-runtime",
        "proof-admission-host",
        "provider-config",
      ],
    },
    sourceInProcessScheduler: {
      status: "not_used",
    },
    fullInstalledRuntime: {
      status: "not_claimed_daemon_process",
      reason: "Gate 2 launches the receipt-bound installed runtime host in the Vitest process; it does not launch a production daemon scheduler process.",
    },
    installedInProcessRuntime: { status: "receipt_bound" },
  } as const;
}

export function buildGate2ModelAttemptAppetite(attempts: readonly unknown[]) {
  const byTaskAndModel = new Map<string, {
    semanticTaskId: string;
    providerId: string;
    modelId: string;
    attemptCount: number;
    committedAttemptCount: number;
    dispatchedUnknownAttemptCount: number;
    totalRequestCount: number;
    maxRequestCount: number;
  }>();
  for (const value of attempts) {
    if (typeof value !== "object" || value === null) continue;
    const attempt = value as Record<string, unknown>;
    const binding = typeof attempt.binding === "object" && attempt.binding !== null
      ? attempt.binding as Record<string, unknown>
      : {};
    const semanticTaskId = typeof attempt.semanticTaskId === "string" ? attempt.semanticTaskId : "unknown";
    const providerId = typeof binding.providerId === "string" ? binding.providerId : "unknown";
    const modelId = typeof binding.modelId === "string" ? binding.modelId : "unknown";
    const requestCount = typeof attempt.requestCount === "number" && Number.isFinite(attempt.requestCount)
      ? attempt.requestCount
      : 0;
    const key = `${semanticTaskId}\0${providerId}\0${modelId}`;
    const aggregate = byTaskAndModel.get(key) ?? {
      semanticTaskId,
      providerId,
      modelId,
      attemptCount: 0,
      committedAttemptCount: 0,
      dispatchedUnknownAttemptCount: 0,
      totalRequestCount: 0,
      maxRequestCount: 0,
    };
    aggregate.attemptCount += 1;
    if (attempt.state === "committed") aggregate.committedAttemptCount += 1;
    if (attempt.state === "dispatched_unknown") aggregate.dispatchedUnknownAttemptCount += 1;
    aggregate.totalRequestCount += requestCount;
    aggregate.maxRequestCount = Math.max(aggregate.maxRequestCount, requestCount);
    byTaskAndModel.set(key, aggregate);
  }
  return {
    schema: "ccc-gate2.model-attempt-appetite.v1",
    tasks: [...byTaskAndModel.values()].sort((left, right) =>
      left.semanticTaskId.localeCompare(right.semanticTaskId)
      || left.providerId.localeCompare(right.providerId)
      || left.modelId.localeCompare(right.modelId)),
  } as const;
}
