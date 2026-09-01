import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testRoot = dirname(fileURLToPath(import.meta.url));
const liveHarnessPath = join(testRoot, "ccc-gate2-telemetry-pi.live.real-pg.test.ts");

async function readLiveHarness(): Promise<string> {
  return readFile(liveHarnessPath, "utf8").catch(() => "");
}

describe("CCC Gate 2 telemetry live Pi harness source contract", () => {
  it("binds the six-task run to the exact peer routes and generous project envelope", async () => {
    const source = await readLiveHarness();

    expect(source).toContain("GATE2_TELEMETRY_PI_PEERS");
    expect(source).toContain("GATE2_TELEMETRY_PI_ENVELOPE");
    expect(source).toContain("maxConcurrent: GATE2_TELEMETRY_PI_ENVELOPE.maxConcurrency");
    expect(source).toContain("routes: GATE2_TELEMETRY_TASK_ROUTES");
    expect(source).not.toMatch(/(?:providerId|modelId):\s*["'`][^"'`]*(?:luna|gpt-5\.6)/iu);
  });

  it("asserts exact six-task provider coverage and rejects Luna effective routes", async () => {
    const source = await readLiveHarness();

    expect(source).toContain("attemptedSemanticTaskIds");
    expect(source).toContain("new Set(taskOrder)");
    expect(source).toContain("attemptedRouteAliases");
    expect(source).toContain('new Set(["minimax-latest", "glm-latest", "gemini-flash-latest"])');
    expect(source).toContain("forbidLunaRoute");
    expect(source).toContain("effectiveRoute!.provider");
    expect(source).toContain("effectiveRoute!.model");
  });

  it("isolates runtime custody and runs controls plus the in-process scheduler host from the installed artifact", async () => {
    const source = await readLiveHarness();

    expect(source).toContain("isolatedHome = process.env.HOME");
    expect(source).toContain('isolatedHome.includes("fn-test-home-")');
    expect(source).toContain("await mkdir(dirname(evidencePath), { recursive: true })");
    expect(source).toContain("CCC_GATE2_INSTALLED_RUNTIME_RECEIPT");
    expect(source).toContain("installedRuntimeReceipt");
    expect(source).toContain("runtimeExecutionBoundary: buildGate2RuntimeExecutionBoundary");
    expect(source).toContain("InstalledRuntimeReceipt");
    expect(source).toContain('schema: "ccc-gate2.installed-runtime.v1"');
    expect(source).toContain("artifactReceipt.receipt.executablePath");
    expect(source).toContain("artifactReceipt.receipt.runtimeModulePath");
    expect(source).toContain("artifactReceipt.receipt.runtimeModuleSha256");
    expect(source).toContain("loadGate2InstalledRuntimeModule");
    expect(source).toContain("runGate2InstalledPrdCommand");
    expect(source).not.toContain("runGate2InstalledPrdController");
    expect(source).toContain("ccc-product-campaign-test-support.js");
    expect(source).not.toContain("ccc-golden-evidence-ledger-campaign-support.js");
    expect(source).toContain("new installedRuntime.InProcessRuntime");
    expect(source).toContain("new installedRuntime.TaskStore");
    expect(source).toContain("new installedRuntime.CentralCore");
    expect(source).not.toMatch(/import\s*\{[^}]*\bCentralCore\b[^}]*\}\s*from\s*["']@fusion\/core["']/u);
    expect(source).not.toMatch(/import\s*\{[^}]*\bInProcessRuntime\b[^}]*\}\s*from\s*["'][^"']*runtimes\/in-process-runtime\.js["']/u);
    expect(source).not.toContain("installedRunPrdCommand");
    expect(source).not.toContain("runProductCommandFromSupport(args, commandDependencies, installedRunPrdCommand)");
    expect(source).toContain("installedRuntime.bootstrapCccCampaignProofAdmissionHost({ builtRootPath: cliDistRoot })");
    expect(source).toContain("DATABASE_URL: h.testUrl()");
    expect(source).toContain('FUSION_HOME: join(isolatedHome, ".fusion")');
    expect(source).toContain("idempotencyKey");
  });

  it("selects clean, recovery, or stop mode and records exact effective route receipts", async () => {
    const source = await readLiveHarness();

    expect(source).toContain('type Gate2LiveMode = "clean" | "recovery" | "stop"');
    expect(source).toContain("CCC_GATE2_LIVE_MODE");
    expect(source).toContain("effectiveRoute");
    expect(source).toContain("terminalRouteMembers");
    expect(source).toContain("async function parseComboSnapshots");
    expect(source).toContain("await readFile(serializedOrPath, \"utf8\")");
    expect(source).toContain("dispatched_unknown");
    expect(source).toContain('runMode === "recovery"');
    expect(source).toContain('runMode === "stop"');
    expect(source).toContain("continuityVerified: true");
    expect(source).toContain("providerAttemptsAfterRestart");
    expect(source).toContain("proofAttemptsAfterRestart");
    expect(source).toContain('durableBoundary: "live_execution_approval_hold"');
    expect(source).toContain('providerExecution: "not_required"');
    expect(source).not.toContain("recoveryMergeHold");
    expect(source).not.toContain("recoveryPauseConfirmation");
    expect(source).not.toContain("recoveryResumeConfirmation");
  });

  it("keeps failed live-run evidence compact while retaining per-task agent diagnostics", async () => {
    const source = await readLiveHarness();

    expect(source).toContain("async function collectAgentDiagnostics");
    expect(source).toContain("agentDiagnostics: await collectAgentDiagnostics");
    expect(source).toContain("compactProviderAttempt");
    expect(source).toContain("compactProof");
    expect(source).not.toContain("providerAttempts: status.status.providerAttempts,\n");
    expect(source).not.toContain("proofs: status.status.proofs,\n");
  });

  it("persists raw status command diagnostics when live status exits nonzero", async () => {
    const source = await readLiveHarness();

    expect(source).toContain("rawStatusCommand");
    expect(source).toContain("statusExitCode: rawStatusCommand.exitCode");
    expect(source).toContain("statusValues: rawStatusCommand.values");
    expect(source).not.toContain("?? productStatus(await runProductCommand([\"status\", idempotencyKey], dependencies))");
  });

  it("requires a commit-bound exact-port usefulness probe after clean or recovery landing", async () => {
    const source = await readLiveHarness();

    expect(source).toContain("runGate2TelemetryUsefulnessProbe");
    expect(source).toContain("installedRuntimeReceiptDigest: artifactReceipt.receiptDigest");
    expect(source).toContain("sourceCommit: integrated.sourceCommit");
    expect(source).toContain("sourceTree: integrated.sourceTree");
    expect(source).toContain('expect(usefulnessEvidence.finalTargetStatus).toBe("passed")');
    expect(source).toContain('runMode === "clean" || runMode === "recovery"');
    expect(source).toContain("buildGate2UsefulnessEvidenceState(runMode, usefulnessEvidence)");
    expect(source).toContain("usefulnessEvidence");
  });

  it("RED-G2-recovery-lane: proves installed-runtime restart through a deterministic recovery lane", async () => {
    const source = await readLiveHarness();

    expect(source).toContain("async function runDeterministicRecoveryLane");
    expect(source).toContain('recoveryKind: "installed_runtime_restart"');
    expect(source).toContain('providerExecution: "not_required"');
    expect(source).toContain("recoveryBoundary = await runDeterministicRecoveryLane");
    expect(source).toContain("providerAttemptsBeforeRestart");
    expect(source).toContain("providerAttemptsAfterRestart");
    expect(source).toContain("proofAttemptsBeforeRestart");
    expect(source).toContain("proofAttemptsAfterRestart");
    expect(source).toContain("expect(providerAttemptsAfterRestart).toEqual(providerAttemptsBeforeRestart)");
    expect(source).toContain("expect(proofAttemptsAfterRestart).toEqual(proofAttemptsBeforeRestart)");
  });

  it("RED-G2-stop-lane: proves operator pause-resume-stop before live provider dispatch", async () => {
    const source = await readLiveHarness();

    expect(source).toContain("async function runDeterministicStopLane");
    expect(source).toContain('stopKind: "operator_control_before_provider_dispatch"');
    expect(source).toContain('providerExecution: "not_started"');
    expect(source).toContain("stopBoundary = await runDeterministicStopLane");
    expect(source).toContain("quietWindowVerified: true");
    expect(source).toContain("terminalStopVerified: true");
    expect(source).toContain("expect(finalStatus.status.providerAttempts).toHaveLength(0)");
    expect(source).toContain("expect(proofAttempts).toHaveLength(0)");
    expect(source).toContain("listDueWorkflowWorkItems");
  });

  it("refuses stale merge authority and persists one controlled landing bound to the integrated proof", async () => {
    const source = await readLiveHarness();

    expect(source).toContain("staleMergeConfirmation");
    expect(source).toContain('"CCC_PRD_MERGE_CONFIRMATION_REFUSED"');
    expect(source).toContain('"approve-merge"');
    expect(source).toContain("landingEvidence");
    expect(source).toContain("integrated.sourceCommit");
    expect(source).toContain('lifecycle.targetRoot, "reflog", "show"');
    expect(source).toContain("replayMergeApproved");
    expect(source).toContain("reflogAfterReplay");
    expect(source).toContain("duplicateEffectPrevented: true");
    expect(source).toContain("expectedProofIds");
    expect(source).toContain('"PROOF-TELEMETRY-INTEGRATED"');
    expect(source).toContain("materializations");
    expect(source).toContain("terminals");
  });
});
