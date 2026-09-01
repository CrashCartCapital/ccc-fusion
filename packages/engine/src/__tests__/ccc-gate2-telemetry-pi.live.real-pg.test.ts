import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";
import type {
  CentralCore,
  TaskStore,
} from "@fusion/core";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
} from "../../../core/src/__test-utils__/pg-test-harness.js";
import type { InProcessRuntime } from "../runtimes/in-process-runtime.js";
import {
  captureFailure,
  git,
  productStatus,
  terminalDiagnostic,
  waitFor,
  waitForDurableProductBoundary,
  type CommandResult,
  type ProductStatusOutput,
} from "./helpers/ccc-product-campaign-test-support.js";
import {
  exactCandidateFiles,
  taskOrder,
} from "./helpers/ccc-gate2-telemetry-campaign-fixture.js";
import {
  buildGate2ModelAttemptAppetite,
  buildGate2ReadinessState,
  buildGate2RecoveryEvidenceState,
  buildGate2RuntimeExecutionBoundary,
  buildGate2UsefulnessEvidenceState,
  GATE2_TELEMETRY_PI_ENVELOPE,
  GATE2_TELEMETRY_PI_PEERS,
} from "./helpers/ccc-gate2-telemetry-pi-matrix.js";
import {
  runGate2TelemetryUsefulnessProbe,
  type Gate2UsefulnessEvidence,
} from "./helpers/ccc-gate2-usefulness-probe.js";
import {
  parseGoldenOmniRouteComboSnapshot,
  type GoldenOmniRouteComboSnapshot,
} from "./helpers/ccc-golden-omniroute-combo-snapshot.js";
import type { GoldenPiDriver } from "./helpers/ccc-golden-pi-driver-matrix.js";

type Gate2LiveMode = "clean" | "recovery" | "stop";

type PreparedLifecycle = Readonly<{
  targetRoot: string;
  baseCommit: string;
  frozenRoot: string;
  manifestPath: string;
  sidecarPath: string;
  executionPlanPath: string;
}>;

type Gate2Route = Readonly<{
  providerId: string;
  modelId: string;
  transport: "pi";
  receiptAdapterId: "terminal-route-sse-comments.v1";
  terminalRouteMembers: GoldenOmniRouteComboSnapshot["terminalRouteMembers"];
}>;

type Gate2ProviderAttempt = ProductStatusOutput["status"]["providerAttempts"][number];
type Gate2Proof = ProductStatusOutput["status"]["proofs"][number];

function truncateDiagnostic(value: unknown, maxLength = 1_500): string | null {
  if (value === null || value === undefined) return null;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}...[truncated]`;
}

function compactProviderAttempt(attempt: Gate2ProviderAttempt) {
  return {
    attemptKey: attempt.attemptKey,
    taskId: attempt.taskId,
    semanticTaskId: attempt.semanticTaskId,
    attemptOrdinal: attempt.attemptOrdinal,
    requestCount: attempt.requestCount,
    dispatchKey: attempt.dispatchKey,
    state: attempt.state,
    binding: {
      providerId: attempt.binding.providerId,
      modelId: attempt.binding.modelId,
      transport: attempt.binding.transport,
      bindingHash: attempt.binding.bindingHash,
    },
    terminal: attempt.state === "committed" || attempt.state === "proved_failed"
      ? attempt.terminal
      : null,
  };
}

function compactProof(proof: Gate2Proof) {
  return {
    definition: {
      id: proof.definition.id,
      command: proof.definition.command,
      definitionSha256: proof.definitionSha256,
    },
    attempts: proof.attempts.map((attempt) => ({
      attemptKey: attempt.attemptKey,
      taskId: attempt.taskId,
      semanticTaskId: attempt.semanticTaskId,
      proofId: attempt.proofId,
      state: attempt.state,
      phase: attempt.phase,
      sourceCommit: attempt.sourceCommit,
      sourceTree: attempt.sourceTree,
      result: attempt.result
        ? {
            success: attempt.result.success,
            exitCode: attempt.result.exitCode,
            durationMs: attempt.result.durationMs,
            timedOut: attempt.result.timedOut,
            killed: attempt.result.killed,
            warnings: attempt.result.warnings,
            stdoutSha256: attempt.result.stdoutSha256,
            stderrSha256: attempt.result.stderrSha256,
            stdoutTail: truncateDiagnostic(attempt.result.stdoutTail),
            stderrTail: truncateDiagnostic(attempt.result.stderrTail),
          }
        : null,
      proofEvidenceSha256: attempt.proofEvidenceSha256,
      terminalEnvelopeSha256: attempt.terminalEnvelopeSha256,
    })),
  };
}

async function collectAgentDiagnostics(targetRoot: string) {
  const tasksRoot = join(targetRoot, ".fusion", "tasks");
  const directories = await readdir(tasksRoot, { withFileTypes: true }).catch(() => []);
  const diagnostics = [];
  for (const directory of directories.filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const taskRoot = join(tasksRoot, directory.name);
    const task = JSON.parse(await readFile(join(taskRoot, "task.json"), "utf8").catch(() => "{}")) as Record<string, unknown>;
    const logBytes = await readFile(join(taskRoot, "agent-log.jsonl"), "utf8").catch(() => "");
    const entries = logBytes.split("\n").filter(Boolean).flatMap((line) => {
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        return [{
          timestamp: entry.timestamp ?? entry.ts ?? null,
          type: entry.type ?? null,
          text: truncateDiagnostic(entry.text, 600),
          detail: truncateDiagnostic(entry.detail, 1_200),
        }];
      } catch {
        return [{ timestamp: null, type: "parse-error", text: truncateDiagnostic(line, 600), detail: null }];
      }
    });
    const typeCounts = Object.fromEntries([...new Set(entries.map(({ type }) => String(type)))].sort().map((type) => [
      type,
      entries.filter((entry) => String(entry.type) === type).length,
    ]));
    diagnostics.push({
      taskId: directory.name,
      task: {
        id: task.id ?? directory.name,
        title: task.title ?? null,
        status: task.status ?? null,
        column: task.column ?? null,
        summary: truncateDiagnostic(task.summary),
        error: truncateDiagnostic(task.error ?? task.lastError),
        worktree: task.worktree ?? null,
      },
      entryCount: entries.length,
      typeCounts,
      tail: entries.slice(-80),
      activityTail: Array.isArray(task.log)
        ? task.log.slice(-80).map((entry) => ({
            timestamp: (entry as Record<string, unknown>).timestamp ?? null,
            action: truncateDiagnostic((entry as Record<string, unknown>).action, 800),
            outcome: truncateDiagnostic((entry as Record<string, unknown>).outcome, 1_200),
          }))
        : [],
    });
  }
  return diagnostics;
}

const livePiRequested = process.env.CCC_GATE2_LIVE_PI === "1";
let cliDistRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../cli/dist");

function resolveRunMode(value: string | undefined): Gate2LiveMode {
  if (value === "clean" || value === "recovery" || value === "stop") return value;
  if (!livePiRequested && value === undefined) return "clean";
  throw new Error("CCC_GATE2_LIVE_MODE must be clean, recovery, or stop");
}

const runMode = resolveRunMode(process.env.CCC_GATE2_LIVE_MODE);
const evidencePath = process.env.CCC_GATE2_LIVE_EVIDENCE_PATH ?? "";
const runId = process.env.CCC_GATE2_RUN_ID ?? "";
if (livePiRequested && !evidencePath) {
  throw new Error("CCC_GATE2_LIVE_EVIDENCE_PATH is required when CCC_GATE2_LIVE_PI=1");
}
if (livePiRequested && !/^[a-z0-9][a-z0-9._-]{7,127}$/u.test(runId)) {
  throw new Error("CCC_GATE2_RUN_ID must be an explicit 8-128 character isolated run identity");
}
if (livePiRequested && !process.env.CCC_GATE2_OMNIROUTE_COMBO_SNAPSHOTS) {
  throw new Error("CCC_GATE2_OMNIROUTE_COMBO_SNAPSHOTS is required when CCC_GATE2_LIVE_PI=1");
}
if (livePiRequested && !process.env.CCC_GATE2_INSTALLED_RUNTIME_RECEIPT) {
  throw new Error("CCC_GATE2_INSTALLED_RUNTIME_RECEIPT is required when CCC_GATE2_LIVE_PI=1");
}

const livePgDescribe = livePiRequested ? pgDescribe.sequential : pgDescribe.skip;
const idempotencyKey = `ccc-gate2-telemetry-${runId || "skipped"}-${runMode}`;

async function parseComboSnapshots(serializedOrPath: string): Promise<Record<
  keyof typeof GATE2_TELEMETRY_PI_PEERS,
  GoldenOmniRouteComboSnapshot
>> {
  const serialized = serializedOrPath.trimStart().startsWith("{")
    ? serializedOrPath
    : await readFile(serializedOrPath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch {
    throw new Error("CCC_GATE2_OMNIROUTE_COMBO_SNAPSHOTS must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("CCC_GATE2_OMNIROUTE_COMBO_SNAPSHOTS must be an object");
  }
  const values = parsed as Record<string, unknown>;
  const expectedKeys = Object.keys(GATE2_TELEMETRY_PI_PEERS).sort();
  if (JSON.stringify(Object.keys(values).sort()) !== JSON.stringify(expectedKeys)) {
    throw new Error("CCC_GATE2_OMNIROUTE_COMBO_SNAPSHOTS must contain exactly minimax, glm, and gemini");
  }
  return Object.fromEntries(Object.entries(GATE2_TELEMETRY_PI_PEERS).map(([key, driver]) => [
    key,
    parseGoldenOmniRouteComboSnapshot(JSON.stringify(values[key]), driver.comboAlias),
  ])) as Record<keyof typeof GATE2_TELEMETRY_PI_PEERS, GoldenOmniRouteComboSnapshot>;
}

function routeFor(
  driver: GoldenPiDriver,
  snapshot: GoldenOmniRouteComboSnapshot,
): Gate2Route {
  for (const member of snapshot.terminalRouteMembers) {
    forbidLunaRoute(member.provider, member.model);
  }
  const sealedMembers = new Set(snapshot.terminalRouteMembers.map(({ provider, model }) => `${provider}/${model}`));
  for (const member of driver.attributionTerminalRouteMembers) {
    if (!sealedMembers.has(`${member.provider}/${member.model}`)) {
      throw new Error(`${driver.comboAlias} snapshot omits an admitted terminal route member`);
    }
  }
  return {
    providerId: driver.providerId,
    modelId: driver.modelId,
    transport: "pi",
    receiptAdapterId: "terminal-route-sse-comments.v1",
    terminalRouteMembers: snapshot.terminalRouteMembers,
  };
}

function forbidLunaRoute(providerId: string, modelId: string): void {
  expect(`${providerId}/${modelId}`).not.toMatch(/luna|gpt-5\.6/iu);
}

type InstalledRuntimeReceipt = Readonly<{
  schema: "ccc-gate2.installed-runtime.v1";
  artifactScope: Readonly<{
    installedRuntime: readonly [
      "fn-cli",
      "prd-controller",
      "semantic-proof-toolchain",
      "central-core",
      "task-store",
      "in-process-runtime",
      "proof-admission-host",
      "provider-config",
    ];
    sourceInProcessScheduler: "not_used";
    fullInstalledRuntime: "not_claimed_daemon_process";
    installedInProcessRuntime: "receipt_bound";
  }>;
  tarballPath: string;
  tarballSha256: string;
  installedRoot: string;
  packageName: "@runfusion/fusion";
  packageVersion: string;
  executablePath: string;
  executableSha256: string;
  controllerModulePath: string;
  controllerModuleSha256: string;
  runtimeModulePath: string;
  runtimeModuleSha256: string;
  versionOutput: string;
  versionOutputSha256: string;
}>;

type InstalledRuntimeModule = Readonly<{
  CentralCore: typeof CentralCore;
  TaskStore: typeof TaskStore;
  InProcessRuntime: typeof InProcessRuntime;
  __resetWorkflowExtensionRegistryForTests(): void;
  bootstrapCccCampaignProofAdmissionHost(input: { builtRootPath: string }): Promise<unknown>;
  readCustomProviders(): Array<{ name: string }>;
  computeCccCampaignOperatorControlConfirmation(
    status: ProductStatusOutput["status"],
    action: "pause" | "resume" | "stop",
  ): string;
}>;

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function installedRuntimeReceipt(serializedOrPath: string): Promise<Readonly<{
  receipt: InstalledRuntimeReceipt;
  receiptDigest: string;
  packageJsonDigest: string;
}>> {
  const serialized = serializedOrPath.trimStart().startsWith("{")
    ? serializedOrPath
    : await readFile(serializedOrPath, "utf8");
  const receipt = JSON.parse(serialized) as InstalledRuntimeReceipt;
  const keys = [
    "artifactScope",
    "controllerModulePath",
    "controllerModuleSha256",
    "executablePath",
    "executableSha256",
    "installedRoot",
    "packageName",
    "packageVersion",
    "runtimeModulePath",
    "runtimeModuleSha256",
    "schema",
    "tarballPath",
    "tarballSha256",
    "versionOutput",
    "versionOutputSha256",
  ];
  expect(Object.keys(receipt).sort()).toEqual(keys);
  expect(receipt).toMatchObject({
    schema: "ccc-gate2.installed-runtime.v1",
    artifactScope: {
      installedRuntime: [
        "fn-cli",
        "prd-controller",
        "semantic-proof-toolchain",
        "central-core",
        "task-store",
        "in-process-runtime",
        "proof-admission-host",
        "provider-config",
      ],
      sourceInProcessScheduler: "not_used",
      fullInstalledRuntime: "not_claimed_daemon_process",
      installedInProcessRuntime: "receipt_bound",
    },
    packageName: "@runfusion/fusion",
    packageVersion: expect.stringMatching(/^\d+\.\d+\.\d+/u),
    tarballSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    executableSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    controllerModuleSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    runtimeModuleSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    versionOutputSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
  });
  expect(isAbsolute(receipt.tarballPath)).toBe(true);
  expect(isAbsolute(receipt.installedRoot)).toBe(true);
  expect(isAbsolute(receipt.executablePath)).toBe(true);
  expect(isAbsolute(receipt.controllerModulePath)).toBe(true);
  expect(isAbsolute(receipt.runtimeModulePath)).toBe(true);
  expect(sha256(await readFile(receipt.tarballPath))).toBe(receipt.tarballSha256);
  expect(sha256(await readFile(receipt.executablePath))).toBe(receipt.executableSha256);
  expect(sha256(await readFile(receipt.controllerModulePath))).toBe(receipt.controllerModuleSha256);
  expect(sha256(await readFile(receipt.runtimeModulePath))).toBe(receipt.runtimeModuleSha256);
  expect(sha256(receipt.versionOutput)).toBe(receipt.versionOutputSha256);
  const packageJsonBytes = await readFile(join(receipt.installedRoot, "package.json"));
  const packageJson = JSON.parse(packageJsonBytes.toString("utf8")) as { name?: unknown; version?: unknown };
  expect(packageJson).toMatchObject({ name: receipt.packageName, version: receipt.packageVersion });
  await readFile(join(receipt.installedRoot, "dist", "ccc-campaign-proof-admission.js"));
  return {
    receipt,
    receiptDigest: sha256(canonicalJson(receipt)),
    packageJsonDigest: sha256(packageJsonBytes),
  };
}

async function prepareLifecycle(
  root: string,
  routes: Record<keyof typeof GATE2_TELEMETRY_PI_PEERS, Gate2Route>,
  cliExecutablePath: string,
): Promise<PreparedLifecycle> {
  const module = await import("../../../../scripts/lib/ccc-gate2-telemetry-lifecycle.mjs") as {
    prepareGate2TelemetryPacketLifecycle(input: Record<string, unknown>): Promise<PreparedLifecycle>;
  };
  const GATE2_TELEMETRY_TASK_ROUTES = routes;
  return module.prepareGate2TelemetryPacketLifecycle({
    root,
    routes: GATE2_TELEMETRY_TASK_ROUTES,
    maxRequests: GATE2_TELEMETRY_PI_ENVELOPE.maxRequests,
    maxDurationMs: GATE2_TELEMETRY_PI_ENVELOPE.maxDurationMs,
    maxConcurrency: GATE2_TELEMETRY_PI_ENVELOPE.maxConcurrency,
    cliExecutablePath,
  });
}

livePgDescribe(`CCC Gate 2 telemetry live Pi campaign (${runMode})`, () => {
  const h = createSharedPgTaskStoreTestHarness({
    prefix: `fusion_ccc_gate2_${runMode}_${runId || "skipped"}`.replaceAll(/[^a-z0-9_]+/g, "_"),
    poolMax: 8,
  });
  let runRoot = "";
  let lifecycleRoot = "";
  let isolatedHome = "";
  let originalHome: string | undefined;
  let lifecycle: PreparedLifecycle;
  let comboSnapshots: Record<keyof typeof GATE2_TELEMETRY_PI_PEERS, GoldenOmniRouteComboSnapshot>;
  let GATE2_TELEMETRY_TASK_ROUTES: Record<keyof typeof GATE2_TELEMETRY_PI_PEERS, Gate2Route>;
  let artifactReceipt: Awaited<ReturnType<typeof installedRuntimeReceipt>>;
  let installedRuntime: InstalledRuntimeModule;
  let store: TaskStore;
  let runtime: InProcessRuntime | undefined;
  let central: CentralCore | undefined;

  const runProductCommand = (
    args: string[],
    _commandDependencies?: unknown,
  ): Promise<CommandResult> => import("../../../../scripts/lib/ccc-gate2-installed-runtime.mjs")
    .then(({ runGate2InstalledPrdCommand }) => runGate2InstalledPrdCommand({
      executablePath: artifactReceipt.receipt.executablePath,
      cwd: lifecycle.targetRoot,
      home: isolatedHome,
      args,
      env: {
        DATABASE_URL: h.testUrl(),
        FUSION_HOME: join(isolatedHome, ".fusion"),
      },
    }));

  async function startRuntime(): Promise<{ drainWorkflowContinuations(): Promise<void> }> {
    installedRuntime.__resetWorkflowExtensionRegistryForTests();
    await installedRuntime.bootstrapCccCampaignProofAdmissionHost({ builtRootPath: cliDistRoot });
    central = new installedRuntime.CentralCore(h.globalDir(), { asyncLayer: h.layer() });
    await central.init();
    runtime = new installedRuntime.InProcessRuntime({
      projectId: h.layer().projectId ?? `ccc-gate2-${runId}`,
      workingDirectory: lifecycle.targetRoot,
      isolationMode: "in-process",
      maxConcurrent: GATE2_TELEMETRY_PI_ENVELOPE.maxConcurrency,
      maxWorktrees: GATE2_TELEMETRY_PI_ENVELOPE.maxConcurrency,
      externalTaskStore: store,
    }, central);
    (runtime as unknown as { cccCampaignProofBootstrapPromise?: Promise<void> })
      .cccCampaignProofBootstrapPromise = Promise.resolve();
    await runtime.start();
    return runtime as unknown as { drainWorkflowContinuations(): Promise<void> };
  }

  async function stopRuntime(): Promise<void> {
    if (runtime) await runtime.stop();
    if (central) await central.close();
    runtime = undefined;
    central = undefined;
    installedRuntime?.__resetWorkflowExtensionRegistryForTests();
  }

  async function runDeterministicRecoveryLane(
    recoveryHold: ProductStatusOutput,
  ): Promise<Record<string, unknown>> {
    const providerAttemptsBeforeRestart = recoveryHold.status.providerAttempts.map(compactProviderAttempt);
    const proofAttemptsBeforeRestart = recoveryHold.status.proofs.flatMap(({ attempts }) => attempts.map((attempt) => ({
      attemptKey: attempt.attemptKey,
      state: attempt.state,
      sourceCommit: attempt.sourceCommit,
      sourceTree: attempt.sourceTree,
      proofEvidenceSha256: attempt.proofEvidenceSha256,
      terminalEnvelopeSha256: attempt.terminalEnvelopeSha256,
    })));
    expect(providerAttemptsBeforeRestart).toHaveLength(0);
    expect(proofAttemptsBeforeRestart).toHaveLength(0);
    expect(recoveryHold.status.nextAction.kind).toBe("approve-execution");
    const targetHeadBeforeRestart = await git(lifecycle.targetRoot, "rev-parse", "HEAD");

    await stopRuntime();
    const restarted = await startRuntime();
    await restarted.drainWorkflowContinuations();
    const statusAfterRestart = productStatus(await runProductCommand(["status", idempotencyKey]));
    expect(statusAfterRestart.status.nextAction.kind).toBe("approve-execution");
    expect(statusAfterRestart.liveExecutionAuthorizationConfirmation)
      .toEqual(recoveryHold.liveExecutionAuthorizationConfirmation);
    const providerAttemptsAfterRestart = statusAfterRestart.status.providerAttempts.map(compactProviderAttempt);
    const proofAttemptsAfterRestart = statusAfterRestart.status.proofs.flatMap(({ attempts }) => attempts.map((attempt) => ({
      attemptKey: attempt.attemptKey,
      state: attempt.state,
      sourceCommit: attempt.sourceCommit,
      sourceTree: attempt.sourceTree,
      proofEvidenceSha256: attempt.proofEvidenceSha256,
      terminalEnvelopeSha256: attempt.terminalEnvelopeSha256,
    })));
    expect(providerAttemptsAfterRestart).toEqual(providerAttemptsBeforeRestart);
    expect(proofAttemptsAfterRestart).toEqual(proofAttemptsBeforeRestart);
    expect(await git(lifecycle.targetRoot, "rev-parse", "HEAD")).toBe(targetHeadBeforeRestart);

    return {
      recoveryKind: "installed_runtime_restart",
      durableBoundary: "live_execution_approval_hold",
      providerExecution: "not_required",
      quiesced: true,
      restartCompleted: true,
      continuityVerified: true,
      providerAttemptsBeforeRestart,
      providerAttemptsAfterRestart,
      proofAttemptsBeforeRestart,
      proofAttemptsAfterRestart,
      targetHead: targetHeadBeforeRestart,
    };
  }

  async function runDeterministicStopLane(
    importedStatus: ProductStatusOutput,
    controls: unknown[],
  ): Promise<Record<string, unknown>> {
    expect(importedStatus.status.providerAttempts).toHaveLength(0);
    expect(importedStatus.status.proofs.flatMap(({ attempts }) => attempts)).toHaveLength(0);
    const pauseConfirmation = installedRuntime.computeCccCampaignOperatorControlConfirmation(
      importedStatus.status,
      "pause",
    );
    controls.push((await runProductCommand([
      "pause", idempotencyKey, "--confirm", pauseConfirmation,
    ])).values[0]);
    const paused = productStatus(await runProductCommand(["status", idempotencyKey]));
    const quietCounts = {
      providers: paused.status.providerAttempts.length,
      proofs: paused.status.proofs.flatMap(({ attempts }) => attempts).length,
    };
    await new Promise((resolve) => setTimeout(resolve, 500));
    const stillPaused = productStatus(await runProductCommand(["status", idempotencyKey]));
    expect(stillPaused.status.workItems).toEqual(expect.arrayContaining([
      expect.objectContaining({ state: "held", blockedReason: "ccc-operator:campaign-paused" }),
    ]));
    expect({
      providers: stillPaused.status.providerAttempts.length,
      proofs: stillPaused.status.proofs.flatMap(({ attempts }) => attempts).length,
    }).toEqual(quietCounts);

    const resumeConfirmation = installedRuntime.computeCccCampaignOperatorControlConfirmation(
      stillPaused.status,
      "resume",
    );
    controls.push((await runProductCommand([
      "resume", idempotencyKey, "--confirm", resumeConfirmation,
    ])).values[0]);
    const resumed = productStatus(await runProductCommand(["status", idempotencyKey]));
    const stopConfirmation = installedRuntime.computeCccCampaignOperatorControlConfirmation(
      resumed.status,
      "stop",
    );
    controls.push((await runProductCommand([
      "stop", idempotencyKey,
      "--reason", "Gate 2 stop-mode terminal cleanup before provider dispatch.",
      "--confirm", stopConfirmation,
    ])).values[0]);
    const final = productStatus(await runProductCommand(["status", idempotencyKey]));
    expect(final.status.workItems).toEqual(expect.arrayContaining([
      expect.objectContaining({ state: "cancelled" }),
    ]));
    expect(final.status.providerAttempts).toHaveLength(0);
    const proofAttempts = final.status.proofs.flatMap(({ attempts }) => attempts);
    expect(proofAttempts).toHaveLength(0);
    await expect(store.listDueWorkflowWorkItems({
      kinds: ["task"],
      states: ["runnable", "retrying"],
      limit: 100,
    })).resolves.toEqual([]);

    return {
      stopKind: "operator_control_before_provider_dispatch",
      providerExecution: "not_started",
      quietWindowVerified: true,
      terminalStopVerified: true,
      finalNextAction: final.status.nextAction.kind,
      cancelledWorkItems: final.status.workItems.filter(({ state }) => state === "cancelled").length,
    };
  }

  beforeAll(async () => {
    originalHome = process.env.HOME;
    await h.beforeAll();
    await h.beforeEach();
    runRoot = await realpath(await mkdtemp(join(tmpdir(), `ccc-gate2-${runMode}-${runId}-`)));
    lifecycleRoot = join(runRoot, "lifecycle");
    await mkdir(lifecycleRoot);
    await mkdir(dirname(evidencePath), { recursive: true });

    comboSnapshots = await parseComboSnapshots(process.env.CCC_GATE2_OMNIROUTE_COMBO_SNAPSHOTS!);
    GATE2_TELEMETRY_TASK_ROUTES = {
      minimax: routeFor(GATE2_TELEMETRY_PI_PEERS.minimax, comboSnapshots.minimax),
      glm: routeFor(GATE2_TELEMETRY_PI_PEERS.glm, comboSnapshots.glm),
      gemini: routeFor(GATE2_TELEMETRY_PI_PEERS.gemini, comboSnapshots.gemini),
    };
    artifactReceipt = await installedRuntimeReceipt(process.env.CCC_GATE2_INSTALLED_RUNTIME_RECEIPT!);
    installedRuntime = await import("../../../../scripts/lib/ccc-gate2-installed-runtime.mjs")
      .then(({ loadGate2InstalledRuntimeModule }) => loadGate2InstalledRuntimeModule({
        runtimeModulePath: artifactReceipt.receipt.runtimeModulePath,
        runtimeModuleSha256: artifactReceipt.receipt.runtimeModuleSha256,
      })) as InstalledRuntimeModule;
    cliDistRoot = join(artifactReceipt.receipt.installedRoot, "dist");
    lifecycle = await prepareLifecycle(
      lifecycleRoot,
      GATE2_TELEMETRY_TASK_ROUTES,
      artifactReceipt.receipt.executablePath,
    );
    isolatedHome = process.env.HOME ?? "";
    if (!isAbsolute(isolatedHome) || !isolatedHome.includes("fn-test-home-")) {
      throw new Error("Vitest must provide an isolated fn-test-home HOME");
    }
    const projectId = `local-${sha256(lifecycle.targetRoot).slice(0, 24)}`;
    (h.layer() as { projectId?: string }).projectId = projectId;

    const customProviders = Object.values(GATE2_TELEMETRY_PI_PEERS).map((driver, index) => ({
      id: `f9ad9c11-b84c-4b06-b7bb-${String(index + 1).padStart(12, "0")}`,
      name: driver.providerId,
      apiType: "openai-compatible" as const,
      baseUrl: "http://127.0.0.1:8092/v1",
      headers: { "X-OmniRoute-No-Cache": "true" },
      models: [{
        id: driver.modelId,
        name: `CCC Gate 2 ${driver.displayName}`,
        contextWindow: GATE2_TELEMETRY_PI_ENVELOPE.contextWindow,
        maxTokens: GATE2_TELEMETRY_PI_ENVELOPE.maxOutputTokens,
      }],
    }));
    const liveProviderSettings = {
      openrouterModelSync: false,
      opencodeGoModelSync: false,
      taskTokenBudget: GATE2_TELEMETRY_PI_ENVELOPE.taskTokenBudget,
      customProviders,
    };
    store = new installedRuntime.TaskStore(
      lifecycle.targetRoot,
      join(isolatedHome, ".fusion"),
      { asyncLayer: h.layer() },
    );
    await store.updateGlobalSettings(liveProviderSettings);
    await mkdir(join(isolatedHome, ".fusion"), { recursive: true });
    await writeFile(join(isolatedHome, ".fusion", "settings.json"), JSON.stringify(liveProviderSettings), "utf8");
    expect(process.env.HOME).toBe(isolatedHome);
    expect(installedRuntime.readCustomProviders().map(({ name }) => name).sort()).toEqual(
      Object.values(GATE2_TELEMETRY_PI_PEERS).map(({ providerId }) => providerId).sort(),
    );
    await store.updateSettings({
      pollIntervalMs: 60_000,
      maxConcurrent: GATE2_TELEMETRY_PI_ENVELOPE.maxConcurrency,
      maxWorktrees: GATE2_TELEMETRY_PI_ENVELOPE.maxConcurrency,
    });
  });

  afterAll(async () => {
    try {
      await stopRuntime();
      await h.afterEach();
      await h.afterAll();
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (runRoot) await rm(runRoot, { recursive: true, force: true });
    }
  });

  test("runs the selected installed-runtime Gate 2 lane", {
    timeout: GATE2_TELEMETRY_PI_ENVELOPE.maxDurationMs + 600_000,
  }, async () => {
    const dependencies = undefined;
    const controls: unknown[] = [];
    let recoveryBoundary: unknown = null;
    let stopBoundary: unknown = null;
    let landingEvidence: unknown = null;
    let finalStatus: ProductStatusOutput | undefined;
    let usefulnessEvidence: Gate2UsefulnessEvidence | null = null;
    const common = [
      lifecycle.frozenRoot,
      lifecycle.manifestPath,
      lifecycle.sidecarPath,
      lifecycle.executionPlanPath,
      lifecycle.targetRoot,
      lifecycle.baseCommit,
    ];

    const persistEvidence = async (
      outcome: "passed" | "failed",
      status: ProductStatusOutput | null,
      failure: ReturnType<typeof captureFailure> | null = null,
      rawStatusCommand: CommandResult | null = null,
    ) => {
      const evidence = {
        schema: "ccc-gate2.telemetry-live-evidence.v1",
        outcome,
        ...(rawStatusCommand
          ? {
              statusExitCode: rawStatusCommand.exitCode,
              statusValues: rawStatusCommand.values,
            }
          : {
              statusExitCode: 0,
              statusValues: null,
            }),
        failure: failure
          ? { ...failure, message: truncateDiagnostic(failure.message, 4_000) }
          : null,
        runId,
        runMode,
        idempotencyKey,
        installedRuntimeReceipt: artifactReceipt,
        runtimeExecutionBoundary: buildGate2RuntimeExecutionBoundary({
          receiptSchema: artifactReceipt.receipt.schema,
          receiptDigest: artifactReceipt.receiptDigest,
        }),
        envelope: GATE2_TELEMETRY_PI_ENVELOPE,
        comboSnapshots,
        controls,
        gate2Readiness: buildGate2ReadinessState({
          mode: runMode,
          outcome,
          landingEvidence,
          usefulnessEvidence,
          recoveryBoundary,
        }),
        recoveryEvidenceState: buildGate2RecoveryEvidenceState(runMode, recoveryBoundary),
        recoveryBoundary,
        stopBoundary,
        usefulnessEvidenceState: buildGate2UsefulnessEvidenceState(
          runMode,
          usefulnessEvidence,
          recoveryBoundary,
        ),
        usefulnessEvidence,
        landingEvidence,
        nextAction: status?.status.nextAction ?? null,
        workItems: status?.status.workItems.map((item) => ({
          id: item.id,
          taskId: item.taskId,
          nodeId: item.nodeId,
          state: item.state,
          attempt: item.attempt,
          lastError: item.lastError,
          blockedReason: item.blockedReason,
          waitReason: item.waitReason,
        })) ?? [],
        modelAttemptAppetite: buildGate2ModelAttemptAppetite(status?.status.providerAttempts ?? []),
        providerAttempts: status?.status.providerAttempts.map(compactProviderAttempt) ?? [],
        proofs: status?.status.proofs.map(compactProof) ?? [],
        agentDiagnostics: await collectAgentDiagnostics(lifecycle.targetRoot),
        target: {
          baseCommit: lifecycle.baseCommit,
          mainCommit: await git(lifecycle.targetRoot, "rev-parse", "refs/heads/main"),
          status: await git(lifecycle.targetRoot, "status", "--porcelain=v1"),
        },
      };
      await writeFile(evidencePath, `${JSON.stringify(evidence)}\n`, "utf8");
      return evidence;
    };

    try {
      const preview = await runProductCommand(["preview", ...common], dependencies);
      expect(preview.exitCode, JSON.stringify(preview.values)).toBe(0);
      expect(preview.values).toHaveLength(1);
      const digest = (preview.values[0] as { confirmationDigest: string }).confirmationDigest;
      expect(digest).toMatch(/^[a-f0-9]{64}$/u);
      expect(await runProductCommand([
        "import", ...common, idempotencyKey, "--confirm", digest,
      ], dependencies)).toMatchObject({ exitCode: 0 });

      let status = productStatus(await runProductCommand(["status", idempotencyKey], dependencies));
      expect(status.status.tasks.map(({ semanticTaskId }) => semanticTaskId).sort()).toEqual([...taskOrder].sort());

      if (runMode === "stop") {
        stopBoundary = await runDeterministicStopLane(status, controls);
        finalStatus = productStatus(await runProductCommand(["status", idempotencyKey], dependencies));
        landingEvidence = { applicability: "not_applicable_stop_mode", status: "not_run" };
        expect(finalStatus.status.providerAttempts).toHaveLength(0);
        const proofAttempts = finalStatus.status.proofs.flatMap(({ attempts }) => attempts);
        expect(proofAttempts).toHaveLength(0);
        await persistEvidence("passed", finalStatus);
        return;
      }

      const control = await startRuntime();
      await control.drainWorkflowContinuations();
      const executionHold = await waitFor(
        async () => productStatus(await runProductCommand(["status", idempotencyKey], dependencies)),
        (value) => value.status.nextAction.kind === "approve-execution",
        "Gate 2 sealed live-execution hold",
        terminalDiagnostic,
      );
      const authorization = executionHold.liveExecutionAuthorizationConfirmation!;

      if (runMode === "recovery") {
        recoveryBoundary = await runDeterministicRecoveryLane(executionHold);
        finalStatus = productStatus(await runProductCommand(["status", idempotencyKey], dependencies));
        landingEvidence = { applicability: "not_applicable_recovery_operational_lane", status: "not_run" };
        expect(finalStatus.status.providerAttempts).toHaveLength(0);
        const proofAttempts = finalStatus.status.proofs.flatMap(({ attempts }) => attempts);
        expect(proofAttempts).toHaveLength(0);
        await persistEvidence("passed", finalStatus);
        return;
      }

      expect(await runProductCommand([
        "approve-execution", idempotencyKey, authorization.authorizationId,
        "--confirm", authorization.confirmation,
      ], dependencies)).toMatchObject({ exitCode: 0 });

      await control.drainWorkflowContinuations();
      const mergeHold = await waitForDurableProductBoundary(
        async () => productStatus(await runProductCommand(["status", idempotencyKey], dependencies)),
        (value) => value.status.nextAction.kind === "approve-merge",
        (value) => ({
          nextAction: value.status.nextAction,
          workItems: value.status.workItems.map((item) => ({
            id: item.id,
            state: item.state,
            lastError: item.lastError,
          })),
          providerAttempts: value.status.providerAttempts.map(compactProviderAttempt),
          proofs: value.status.proofs.map(compactProof),
        }),
      );
      expect(mergeHold.status.workItems).toEqual([
        expect.objectContaining({
          state: "manual-required",
          lastError: expect.stringMatching(
            /^ccc-permanent:CCC_CAMPAIGN_MERGE_APPROVAL_REQUIRED(?::|$)/,
          ),
          blockedReason: "ccc-permanent:CCC_CAMPAIGN_MERGE_APPROVAL_REQUIRED",
        }),
      ]);
      expect(mergeHold.mergeApprovalConfirmations).toEqual([
        expect.objectContaining({ status: "issued" }),
      ]);

      finalStatus = mergeHold;

      expect(await git(lifecycle.targetRoot, "rev-parse", "refs/heads/main")).toBe(lifecycle.baseCommit);
      expect(finalStatus.status.providerAttempts.length).toBeGreaterThan(0);
      expect(finalStatus.status.providerAttempts.length).toBeLessThanOrEqual(GATE2_TELEMETRY_PI_ENVELOPE.maxRequests);
      const expectedRouteByTask = new Map<string, { driver: GoldenPiDriver; snapshot: GoldenOmniRouteComboSnapshot }>([
        ["TASK-TELEMETRY-CONTRACT", { driver: GATE2_TELEMETRY_PI_PEERS.glm, snapshot: comboSnapshots.glm }],
        ["TASK-TELEMETRY-INGEST", { driver: GATE2_TELEMETRY_PI_PEERS.minimax, snapshot: comboSnapshots.minimax }],
        ["TASK-TELEMETRY-AUDIT", { driver: GATE2_TELEMETRY_PI_PEERS.glm, snapshot: comboSnapshots.glm }],
        ["TASK-TELEMETRY-BROADCAST", { driver: GATE2_TELEMETRY_PI_PEERS.gemini, snapshot: comboSnapshots.gemini }],
        ["TASK-TELEMETRY-CLI", { driver: GATE2_TELEMETRY_PI_PEERS.gemini, snapshot: comboSnapshots.gemini }],
        ["TASK-TELEMETRY-INTEGRATE", { driver: GATE2_TELEMETRY_PI_PEERS.minimax, snapshot: comboSnapshots.minimax }],
      ]);
      const attemptedSemanticTaskIds = new Set(
        finalStatus.status.providerAttempts.map(({ semanticTaskId }) => semanticTaskId),
      );
      expect(attemptedSemanticTaskIds).toEqual(new Set(taskOrder));
      const attemptedRouteAliases = new Set(
        finalStatus.status.providerAttempts.map(({ semanticTaskId }) =>
          expectedRouteByTask.get(semanticTaskId)?.driver.comboAlias),
      );
      expect(attemptedRouteAliases).toEqual(
        new Set(["minimax-latest", "glm-latest", "gemini-flash-latest"]),
      );
      for (const attempt of finalStatus.status.providerAttempts) {
        const expectedRoute = expectedRouteByTask.get(attempt.semanticTaskId);
        expect(expectedRoute).toBeDefined();
        forbidLunaRoute(attempt.binding.providerId, attempt.binding.modelId);
        expect(attempt.binding).toMatchObject({
          providerId: expectedRoute!.driver.providerId,
          modelId: expectedRoute!.driver.modelId,
          transport: "pi",
        });
        expect(attempt.state).not.toBe("dispatched_unknown");
        expect(attempt).toMatchObject({
          state: "committed",
          terminal: {
            kind: "reconciled",
            effectiveRoute: {
              effectiveProvider: expectedRoute!.driver.providerId,
              effectiveModel: expectedRoute!.driver.modelId,
              receiptSource: "stream-usage",
              omniRoute: { final: { provider: expect.any(String), model: expect.any(String) } },
            },
          },
        });
        if (attempt.terminal.kind === "reconciled") {
          forbidLunaRoute(
            attempt.terminal.effectiveRoute.effectiveProvider,
            attempt.terminal.effectiveRoute.effectiveModel,
          );
        }
        const effectiveRoute = attempt.terminal.kind === "reconciled"
          ? attempt.terminal.effectiveRoute.omniRoute?.final
          : undefined;
        expect(effectiveRoute).toBeDefined();
        forbidLunaRoute(effectiveRoute!.provider, effectiveRoute!.model);
        const terminalRouteMembers = new Set(expectedRoute!.driver.attributionTerminalRouteMembers.map(({ provider, model }) =>
          `${provider}/${model}`));
        expect(terminalRouteMembers.has(`${effectiveRoute!.provider}/${effectiveRoute!.model}`)).toBe(true);
      }

      const providerAttemptKeys = finalStatus.status.providerAttempts.map(({ attemptKey }) => attemptKey);
      expect(new Set(providerAttemptKeys).size).toBe(providerAttemptKeys.length);
      const proofAttempts = finalStatus.status.proofs.flatMap(({ definition, attempts }) =>
        attempts.map((attempt) => ({ proofId: definition.id, ...attempt })));
      const expectedProofIds = [
        "PROOF-TELEMETRY-CONTRACT",
        "PROOF-TELEMETRY-INGEST",
        "PROOF-TELEMETRY-AUDIT",
        "PROOF-TELEMETRY-BROADCAST",
        "PROOF-TELEMETRY-CLI",
        "PROOF-TELEMETRY-CANDIDATE",
        "PROOF-TELEMETRY-INTEGRATED",
      ];
      expect(proofAttempts).toHaveLength(7);
      expect(new Set(proofAttempts.map(({ proofId }) => proofId))).toEqual(new Set(expectedProofIds));
      expect(new Set(proofAttempts.map(({ attemptKey }) => attemptKey)).size).toBe(7);
      expect(proofAttempts.every(({ state, result }) =>
        state === "committed" && result?.success === true && result.exitCode === 0)).toBe(true);
      const integrated = proofAttempts.find(({ proofId }) => proofId === "PROOF-TELEMETRY-INTEGRATED")!;
      expect(integrated.phase).toBe("final_integrated");
      expect(await git(lifecycle.targetRoot, "diff", "--name-only", lifecycle.baseCommit, integrated.sourceCommit))
        .toBe(exactCandidateFiles.join("\n"));
      if (runMode !== "stop") {
        const mergeConfirmation = mergeHold.mergeApprovalConfirmations?.[0];
        expect(mergeConfirmation).toBeDefined();
        const staleMergeConfirmation = `${mergeConfirmation!.confirmation[0] === "0" ? "1" : "0"}${mergeConfirmation!.confirmation.slice(1)}`;
        const reflogBeforeLanding = (await git(
          lifecycle.targetRoot, "reflog", "show", "--format=%H", "refs/heads/main",
        )).split("\n").filter(Boolean);
        const staleRefusal = await runProductCommand([
          "approve-merge", idempotencyKey, mergeConfirmation!.approvalRequestId,
          "--confirm", staleMergeConfirmation,
        ], dependencies);
        expect(staleRefusal.exitCode).toBe(1);
        expect(JSON.stringify(staleRefusal.values)).toContain("CCC_PRD_MERGE_CONFIRMATION_REFUSED");
        expect(await git(lifecycle.targetRoot, "rev-parse", "refs/heads/main")).toBe(lifecycle.baseCommit);
        expect((await git(
          lifecycle.targetRoot, "reflog", "show", "--format=%H", "refs/heads/main",
        )).split("\n").filter(Boolean)).toEqual(reflogBeforeLanding);

        const mergeApproved = await runProductCommand([
          "approve-merge", idempotencyKey, mergeConfirmation!.approvalRequestId,
          "--confirm", mergeConfirmation!.confirmation,
        ], dependencies);
        expect(mergeApproved).toMatchObject({
          exitCode: 0,
          values: [expect.objectContaining({
            kind: "merge-approved",
            result: expect.objectContaining({ merged: true, noOp: false }),
          })],
        });
        finalStatus = productStatus(await runProductCommand(["status", idempotencyKey], dependencies));
        const landedCommit = await git(lifecycle.targetRoot, "rev-parse", "refs/heads/main");
        const reflogAfterLanding = (await git(
          lifecycle.targetRoot, "reflog", "show", "--format=%H", "refs/heads/main",
        )).split("\n").filter(Boolean);
        expect(landedCommit).not.toBe(lifecycle.baseCommit);
        expect(await git(lifecycle.targetRoot, "rev-parse", `${landedCommit}^{tree}`)).toBe(integrated.sourceTree);
        expect(reflogAfterLanding).toHaveLength(reflogBeforeLanding.length + 1);
        expect(finalStatus.status.nextAction.kind).toBe("complete");
        expect(finalStatus.status.landing.intents).toHaveLength(1);
        expect(finalStatus.status.landing.materializations).toHaveLength(1);
        expect(finalStatus.status.landing.terminals).toHaveLength(1);
        expect(finalStatus.status.landing.intents[0]?.metadata.sourceCommit).toBe(integrated.sourceCommit);
        expect(finalStatus.status.landing.materializations[0]?.metadata.commitObject).toBe(landedCommit);
        expect(finalStatus.status.landing.terminals[0]?.metadata.sourceCommit).toBe(integrated.sourceCommit);
        const replayMergeApproved = await runProductCommand([
          "approve-merge", idempotencyKey, mergeConfirmation!.approvalRequestId,
          "--confirm", mergeConfirmation!.confirmation,
        ], dependencies);
        const firstMergeResult = mergeApproved.values[0] as {
          approvalRequestId: string;
          kind: "merge-approved";
          result: {
            branch: string;
            merged: boolean;
            noOp?: boolean;
            reason?: string;
            worktreeRemoved: boolean;
            branchDeleted: boolean;
            campaignControlled?: unknown;
          };
        };
        expect(replayMergeApproved).toMatchObject({
          exitCode: 0,
          values: [expect.objectContaining({
            approvalRequestId: firstMergeResult.approvalRequestId,
            kind: firstMergeResult.kind,
            result: expect.objectContaining({
              branch: firstMergeResult.result.branch,
              merged: firstMergeResult.result.merged,
              noOp: firstMergeResult.result.noOp,
              reason: firstMergeResult.result.reason,
              worktreeRemoved: firstMergeResult.result.worktreeRemoved,
              branchDeleted: firstMergeResult.result.branchDeleted,
              campaignControlled: firstMergeResult.result.campaignControlled,
            }),
          })],
        });
        const replayStatus = productStatus(await runProductCommand(["status", idempotencyKey], dependencies));
        const reflogAfterReplay = (await git(
          lifecycle.targetRoot, "reflog", "show", "--format=%H", "refs/heads/main",
        )).split("\n").filter(Boolean);
        expect(await git(lifecycle.targetRoot, "rev-parse", "refs/heads/main")).toBe(landedCommit);
        expect(reflogAfterReplay).toEqual(reflogAfterLanding);
        expect(replayStatus.status.landing.intents).toHaveLength(1);
        expect(replayStatus.status.landing.materializations).toHaveLength(1);
        expect(replayStatus.status.landing.terminals).toHaveLength(1);
        finalStatus = replayStatus;
        landingEvidence = {
          applicability: "required",
          status: "passed",
          staleRefusal: staleRefusal.values,
          sourceCommit: integrated.sourceCommit,
          sourceTree: integrated.sourceTree,
          landedCommit,
          duplicateEffectPrevented: true,
          replayResult: replayMergeApproved.values,
          refs: { before: reflogBeforeLanding, after: reflogAfterLanding, afterReplay: reflogAfterReplay },
          landing: finalStatus.status.landing,
        };
        if (runMode === "clean" || runMode === "recovery") {
          usefulnessEvidence = await runGate2TelemetryUsefulnessProbe({
            targetRepositoryRoot: lifecycle.targetRoot,
            sourceCommit: integrated.sourceCommit,
            sourceTree: integrated.sourceTree,
            installedRuntimeReceiptDigest: artifactReceipt.receiptDigest,
          });
          expect(usefulnessEvidence.finalTargetStatus).toBe("passed");
        }
      } else {
        landingEvidence = { applicability: "not_applicable_stop_mode", status: "not_run" };
      }
      await persistEvidence("passed", finalStatus);
    } catch (error) {
      try {
        const rawStatusCommand = await runProductCommand(["status", idempotencyKey], dependencies);
        const status = rawStatusCommand.exitCode === 0
          ? productStatus(rawStatusCommand)
          : finalStatus ?? null;
        await persistEvidence("failed", status, captureFailure(error), rawStatusCommand);
      } catch (evidenceError) {
        console.error(`CCC_GATE2_EVIDENCE_WRITE_FAILED=${JSON.stringify({
          failure: captureFailure(error),
          evidenceFailure: captureFailure(evidenceError),
          evidencePath,
        })}`);
      }
      throw error;
    }
  });
});
