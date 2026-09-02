import { describe, expect, it } from "vitest";
import {
  GATE2_TELEMETRY_PI_ENVELOPE,
  GATE2_TELEMETRY_PI_PEERS,
} from "./helpers/ccc-gate2-telemetry-pi-matrix.js";
import {
  exactCandidateFiles,
  taskOrder,
} from "./helpers/ccc-gate2-telemetry-campaign-fixture.js";

describe("CCC Gate 2 telemetry Pi matrix", () => {
  it("gives the six-task product campaign a generous shared envelope", () => {
    expect(GATE2_TELEMETRY_PI_ENVELOPE).toEqual({
      taskCount: 6,
      maxRequests: 2_304,
      maxDurationMs: 21_600_000,
      maxConcurrency: 3,
      contextWindow: 200_000,
      maxOutputTokens: 32_768,
      taskTokenBudget: { soft: 500_000_000, hard: 600_000_000 },
    });
    expect(GATE2_TELEMETRY_PI_ENVELOPE.taskTokenBudget.hard).toBeGreaterThan(
      GATE2_TELEMETRY_PI_ENVELOPE.maxRequests
        * (GATE2_TELEMETRY_PI_ENVELOPE.contextWindow + GATE2_TELEMETRY_PI_ENVELOPE.maxOutputTokens),
    );
  });

  it("uses MiniMax, GLM, and Gemini Flash as exact peers with no Luna fallback", () => {
    expect(Object.keys(GATE2_TELEMETRY_PI_PEERS)).toEqual(["minimax", "glm", "gemini"]);
    expect(Object.values(GATE2_TELEMETRY_PI_PEERS).map(({ comboAlias }) => comboAlias)).toEqual([
      "minimax-latest",
      "glm-latest",
      "gemini-flash-latest",
    ]);
    expect(JSON.stringify(GATE2_TELEMETRY_PI_PEERS)).not.toMatch(/luna|gpt-5\.6/u);
  });

  it("seals the six task identities and eight worker-owned candidate files", () => {
    expect(taskOrder).toEqual([
      "TASK-TELEMETRY-CONTRACT",
      "TASK-TELEMETRY-INGEST",
      "TASK-TELEMETRY-AUDIT",
      "TASK-TELEMETRY-BROADCAST",
      "TASK-TELEMETRY-CLI",
      "TASK-TELEMETRY-INTEGRATE",
    ]);
    expect(exactCandidateFiles).toEqual([
      "README.md",
      "src/app.ts",
      "src/audit.ts",
      "src/broadcast.ts",
      "src/contract.ts",
      "src/health-cli.ts",
      "src/ingest.ts",
      "tests/telemetry.test.ts",
    ]);
  });

  it("RED-G2-evidence: emits explicit usefulness applicability and status for every live mode", async () => {
    const helpers = await import("./helpers/ccc-gate2-telemetry-pi-matrix.js") as Record<string, unknown>;
    const buildState = helpers.buildGate2UsefulnessEvidenceState as
      | ((mode: "clean" | "recovery" | "stop", evidence: unknown, recoveryBoundary?: unknown) => unknown)
      | undefined;
    expect(typeof buildState).toBe("function");

    expect(JSON.parse(JSON.stringify(buildState!("clean", null)))).toEqual({
      applicability: "required",
      status: "missing",
      reason: "usefulness_probe_not_completed",
    });
    expect(JSON.parse(JSON.stringify(buildState!("recovery", { finalTargetStatus: "passed" })))).toEqual({
      applicability: "required",
      status: "passed",
      reason: "usefulness_probe_passed",
    });
    expect(JSON.parse(JSON.stringify(buildState!("recovery", null, {
      recoveryKind: "installed_runtime_restart",
      providerExecution: "not_required",
    })))).toEqual({
      applicability: "not_applicable_operational_recovery_lane",
      status: "not_applicable",
      reason: "operational_recovery_lane_has_no_landed_candidate",
    });
    expect(JSON.parse(JSON.stringify(buildState!("stop", null)))).toEqual({
      applicability: "not_applicable_stop_mode",
      status: "not_applicable",
      reason: "campaign_stopped_before_landing",
    });
  });

  it("RED-G2-recovery: labels recovery as controlled restart and never as crash recovery", async () => {
    const helpers = await import("./helpers/ccc-gate2-telemetry-pi-matrix.js") as Record<string, unknown>;
    const buildState = helpers.buildGate2RecoveryEvidenceState as
      | ((mode: "clean" | "recovery" | "stop", evidence: unknown) => unknown)
      | undefined;
    expect(typeof buildState).toBe("function");

    expect(JSON.parse(JSON.stringify(buildState!("clean", null)))).toEqual({
      applicability: "not_applicable_clean_mode",
      recoveryKind: "none",
      status: "not_applicable",
    });
    expect(JSON.parse(JSON.stringify(buildState!("recovery", null)))).toEqual({
      applicability: "required",
      recoveryKind: "controlled_restart",
      status: "missing",
    });
    expect(JSON.parse(JSON.stringify(buildState!("recovery", { restartCompleted: true })))).toEqual({
      applicability: "required",
      recoveryKind: "controlled_restart",
      status: "passed",
    });
    expect(JSON.parse(JSON.stringify(buildState!("recovery", {
      recoveryKind: "installed_runtime_restart",
      providerExecution: "not_required",
      restartCompleted: true,
      continuityVerified: true,
    })))).toEqual({
      applicability: "required",
      recoveryKind: "installed_runtime_restart",
      providerExecution: "not_required",
      status: "passed",
    });
    expect(JSON.parse(JSON.stringify(buildState!("stop", null)))).toEqual({
      applicability: "not_applicable_stop_mode",
      recoveryKind: "none",
      status: "not_applicable",
    });
  });

  it("RED-G2-readiness: stop and failed runs cannot claim whole-product readiness", async () => {
    const helpers = await import("./helpers/ccc-gate2-telemetry-pi-matrix.js") as Record<string, unknown>;
    const buildState = helpers.buildGate2ReadinessState as
      | ((input: Record<string, unknown>) => unknown)
      | undefined;
    expect(typeof buildState).toBe("function");

    expect(JSON.parse(JSON.stringify(buildState!({
      mode: "clean",
      outcome: "passed",
      landingEvidence: { status: "passed", duplicateEffectPrevented: true },
      usefulnessEvidence: { finalTargetStatus: "passed" },
    })))).toEqual({ status: "proved", reason: "landing_and_usefulness_passed" });
    expect(JSON.parse(JSON.stringify(buildState!({
      mode: "stop",
      outcome: "passed",
      landingEvidence: null,
      usefulnessEvidence: null,
    })))).toEqual({ status: "not_proven", reason: "campaign_stopped_before_landing" });
    expect(JSON.parse(JSON.stringify(buildState!({
      mode: "recovery",
      outcome: "failed",
      landingEvidence: null,
      usefulnessEvidence: null,
    })))).toEqual({ status: "not_proven", reason: "live_run_failed" });
    expect(JSON.parse(JSON.stringify(buildState!({
      mode: "recovery",
      outcome: "passed",
      landingEvidence: null,
      usefulnessEvidence: null,
      recoveryBoundary: {
        recoveryKind: "installed_runtime_restart",
        providerExecution: "not_required",
        restartCompleted: true,
        continuityVerified: true,
      },
    })))).toEqual({
      status: "not_proven",
      reason: "operational_recovery_lane_not_whole_product",
    });
  });

  it("RED-G2-evidence: binds controls and the in-process scheduler host to one installed runtime receipt without claiming a daemon", async () => {
    const helpers = await import("./helpers/ccc-gate2-telemetry-pi-matrix.js") as Record<string, unknown>;
    const buildBoundary = helpers.buildGate2RuntimeExecutionBoundary as
      | ((input: { receiptSchema: string; receiptDigest: string }) => unknown)
      | undefined;
    expect(typeof buildBoundary).toBe("function");

    expect(JSON.parse(JSON.stringify(buildBoundary!({
      receiptSchema: "ccc-gate2.installed-runtime.v1",
      receiptDigest: "a".repeat(64),
    })))).toEqual({
      schema: "ccc-gate2.runtime-execution-boundary.v1",
      installedRuntime: {
        status: "receipt_bound",
        receiptSchema: "ccc-gate2.installed-runtime.v1",
        receiptDigest: "a".repeat(64),
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
    });
  });

  it("RED-G2-evidence: aggregates model-specific attempt appetite by semantic task", async () => {
    const helpers = await import("./helpers/ccc-gate2-telemetry-pi-matrix.js") as Record<string, unknown>;
    const buildAppetite = helpers.buildGate2ModelAttemptAppetite as
      | ((attempts: unknown[]) => unknown)
      | undefined;
    expect(typeof buildAppetite).toBe("function");

    expect(JSON.parse(JSON.stringify(buildAppetite!([
      {
        semanticTaskId: "TASK-TELEMETRY-INGEST",
        requestCount: 4,
        state: "committed",
        binding: { providerId: "gate2-minimax", modelId: "combo/minimax-latest" },
      },
      {
        semanticTaskId: "TASK-TELEMETRY-INGEST",
        requestCount: 3,
        state: "dispatched_unknown",
        binding: { providerId: "gate2-minimax", modelId: "combo/minimax-latest" },
      },
      {
        semanticTaskId: "TASK-TELEMETRY-AUDIT",
        requestCount: 2,
        state: "committed",
        binding: { providerId: "gate2-glm", modelId: "combo/glm-latest" },
      },
    ])))).toEqual({
      schema: "ccc-gate2.model-attempt-appetite.v1",
      tasks: [
        {
          semanticTaskId: "TASK-TELEMETRY-AUDIT",
          providerId: "gate2-glm",
          modelId: "combo/glm-latest",
          attemptCount: 1,
          committedAttemptCount: 1,
          dispatchedUnknownAttemptCount: 0,
          totalRequestCount: 2,
          maxRequestCount: 2,
        },
        {
          semanticTaskId: "TASK-TELEMETRY-INGEST",
          providerId: "gate2-minimax",
          modelId: "combo/minimax-latest",
          attemptCount: 2,
          committedAttemptCount: 1,
          dispatchedUnknownAttemptCount: 1,
          totalRequestCount: 7,
          maxRequestCount: 4,
        },
      ],
    });
  });
});
