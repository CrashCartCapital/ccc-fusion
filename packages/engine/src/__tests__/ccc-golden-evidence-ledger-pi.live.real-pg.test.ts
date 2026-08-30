import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import {
  CentralCore,
  TaskStore,
  __resetWorkflowExtensionRegistryForTests,
} from "@fusion/core";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
} from "../../../core/src/__test-utils__/pg-test-harness.js";
import type { PrdCommandDependencies } from "../../../cli/src/commands/prd.js";
import { bootstrapCccCampaignProofAdmissionHost } from "../ccc-campaign-proof-host.js";
import { readCustomProviders } from "../custom-providers.js";
import { TaskExecutor } from "../executor.js";
import { InProcessRuntime } from "../runtimes/in-process-runtime.js";
import {
  captureFailure,
  git,
  productStatus,
  runProductCommand,
  terminalDiagnostic,
  waitFor,
  waitForDurableProductBoundary,
  type ProductStatusOutput,
} from "./helpers/ccc-golden-evidence-ledger-campaign-support.js";
import {
  GOLDEN_PI_PROJECT_ENVELOPE,
  resolveGoldenPiDriver,
} from "./helpers/ccc-golden-pi-driver-matrix.js";
import {
  exactCandidateFiles,
  taskOrder,
} from "./helpers/ccc-golden-evidence-ledger-campaign-fixture.js";
import {
  parseGoldenOmniRouteComboSnapshot,
  type GoldenOmniRouteComboSnapshot,
} from "./helpers/ccc-golden-omniroute-combo-snapshot.js";

const cliDistRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../cli/dist");
const livePiRequested = process.env.CCC_GOLDEN_LIVE_PI === "1";
if (livePiRequested && !process.env.CCC_GOLDEN_PI_DRIVER) {
  throw new Error("CCC_GOLDEN_PI_DRIVER is required when CCC_GOLDEN_LIVE_PI=1");
}
if (livePiRequested && !process.env.CCC_GOLDEN_PI_EVIDENCE_PATH) {
  throw new Error("CCC_GOLDEN_PI_EVIDENCE_PATH is required when CCC_GOLDEN_LIVE_PI=1");
}
const evidencePath = process.env.CCC_GOLDEN_PI_EVIDENCE_PATH ?? "";
const driver = resolveGoldenPiDriver(process.env.CCC_GOLDEN_PI_DRIVER ?? "minimax-latest");
const idempotencyKey = `ccc-golden-evidence-ledger-pi-${driver.key}-r${GOLDEN_PI_PROJECT_ENVELOPE.maxRequests}-multitask-v1`;
const livePgDescribe = livePiRequested
  ? pgDescribe.sequential
  : pgDescribe.skip;

type PreparedLifecycle = Readonly<{
  targetRoot: string;
  baseCommit: string;
  frozenRoot: string;
  manifestPath: string;
  sidecarPath: string;
  executionPlanPath: string;
}>;

async function prepareLifecycle(
  root: string,
  comboSnapshot: GoldenOmniRouteComboSnapshot,
): Promise<PreparedLifecycle> {
  const module = await import("../../../../scripts/lib/ccc-golden-packet-lifecycle.mjs") as {
    prepareEvidenceLedgerPacketLifecycle(input: Record<string, unknown>): Promise<PreparedLifecycle>;
  };
  return module.prepareEvidenceLedgerPacketLifecycle({
    root,
    route: {
      providerId: driver.providerId,
      modelId: driver.modelId,
      transport: "pi",
      receiptAdapterId: "terminal-route-sse-comments.v1",
      terminalRouteMembers: comboSnapshot.terminalRouteMembers,
    },
    maxRequests: GOLDEN_PI_PROJECT_ENVELOPE.maxRequests,
    maxDurationMs: GOLDEN_PI_PROJECT_ENVELOPE.maxDurationMs,
    taskCount: GOLDEN_PI_PROJECT_ENVELOPE.taskCount,
  });
}

livePgDescribe(`CCC Golden Evidence Ledger three-task live Pi campaign (${driver.displayName})`, () => {
  const h = createSharedPgTaskStoreTestHarness({
    prefix: `fusion_ccc_golden_pi_${driver.key.replaceAll(/[^a-z0-9]+/g, "_")}`,
    poolMax: 4,
  });
  let lifecycleRoot = "";
  let isolatedHome = "";
  let originalHome: string | undefined;
  let lifecycle: PreparedLifecycle;
  let comboSnapshot: GoldenOmniRouteComboSnapshot;
  let dependencies: PrdCommandDependencies;
  let store: TaskStore;
  let runtime: InProcessRuntime | undefined;
  let central: CentralCore | undefined;
  let firstHold: ProductStatusOutput;
  let capturedCommitFenceFailure: ReturnType<typeof captureFailure> | null = null;
  let commitFenceSpy: { mockRestore(): void } | undefined;

  beforeAll(async () => {
    originalHome = process.env.HOME;
    await h.beforeAll();
    await h.beforeEach();
    lifecycleRoot = await mkdtemp(join(tmpdir(), `ccc-golden-pi-${driver.key}-`));
    isolatedHome = join(lifecycleRoot, "home");
    await mkdir(isolatedHome, { recursive: true });
    process.env.HOME = isolatedHome;
    comboSnapshot = parseGoldenOmniRouteComboSnapshot(
      process.env.CCC_GOLDEN_OMNIROUTE_COMBO_SNAPSHOT ?? "",
      driver.comboAlias,
    );
    delete process.env.CCC_GOLDEN_OMNIROUTE_COMBO_SNAPSHOT;
    const sealedTerminalMemberKeys = new Set(comboSnapshot.terminalRouteMembers.map(({ provider, model }) =>
      `${provider}/${model}`));
    for (const { provider, model } of driver.attributionTerminalRouteMembers) {
      expect(sealedTerminalMemberKeys.has(`${provider}/${model}`)).toBe(true);
    }
    lifecycle = await prepareLifecycle(lifecycleRoot, comboSnapshot);
    store = new TaskStore(lifecycle.targetRoot, join(isolatedHome, ".fusion"), { asyncLayer: h.layer() });
    const liveProviderSettings = {
      openrouterModelSync: false,
      opencodeGoModelSync: false,
      taskTokenBudget: GOLDEN_PI_PROJECT_ENVELOPE.taskTokenBudget,
      customProviders: [{
        id: "f9ad9c11-b84c-4b06-b7bb-c330f37b21f1",
        name: driver.providerId,
        apiType: "openai-compatible",
        baseUrl: "http://127.0.0.1:8092/v1",
        headers: { "X-OmniRoute-No-Cache": "true" },
        models: [{
          id: driver.modelId,
          name: `CCC Golden ${driver.displayName}`,
          contextWindow: GOLDEN_PI_PROJECT_ENVELOPE.contextWindow,
          maxTokens: GOLDEN_PI_PROJECT_ENVELOPE.maxOutputTokens,
        }],
      }],
    };
    await store.updateGlobalSettings(liveProviderSettings);
    await mkdir(join(isolatedHome, ".fusion"), { recursive: true });
    await writeFile(
      join(isolatedHome, ".fusion", "settings.json"),
      JSON.stringify(liveProviderSettings),
      "utf-8",
    );
    expect(process.env.HOME).toBe(isolatedHome);
    expect(readCustomProviders(isolatedHome).map(({ name }) => name)).toEqual([driver.providerId]);
    expect(readCustomProviders().map(({ name }) => name)).toEqual([driver.providerId]);
    await store.updateSettings({
      pollIntervalMs: 60_000,
      maxConcurrent: GOLDEN_PI_PROJECT_ENVELOPE.maxConcurrency,
      maxWorktrees: 1,
    });
    dependencies = {
      bootstrapProofAdmission: () => bootstrapCccCampaignProofAdmissionHost({ builtRootPath: cliDistRoot }),
      resolveProject: async () => ({
        projectId: h.layer().projectId ?? "ccc-golden-evidence-ledger-pi",
        projectPath: lifecycle.targetRoot,
        projectName: "CCC Golden Evidence Ledger Pi",
        isRegistered: true,
        store,
      }),
      closeProjectStore: async () => undefined,
      readTargetHead: async () => git(lifecycle.targetRoot, "rev-parse", "refs/heads/main"),
    };
  });

  afterAll(async () => {
    try {
      commitFenceSpy?.mockRestore();
      if (runtime) await runtime.stop();
      if (central) await central.close();
      __resetWorkflowExtensionRegistryForTests();
      await h.afterEach();
      await h.afterAll();
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (lifecycleRoot) await rm(lifecycleRoot, { recursive: true, force: true });
    }
  });

  test("generates and proves the full three-task project through real Pi", { timeout: 11_400_000 }, async () => {
    const common = [
      lifecycle.frozenRoot,
      lifecycle.manifestPath,
      lifecycle.sidecarPath,
      lifecycle.executionPlanPath,
      lifecycle.targetRoot,
      lifecycle.baseCommit,
    ];
    const preview = await runProductCommand(["preview", ...common], dependencies);
    const digest = (preview.values[0] as { confirmationDigest: string }).confirmationDigest;
    const imported = await runProductCommand([
      "import", ...common, idempotencyKey, "--confirm", digest,
    ], dependencies);
    expect(imported.exitCode).toBe(0);
    const importedStatus = productStatus(await runProductCommand(["status", idempotencyKey], dependencies));
    const nativeTasks = importedStatus.status.tasks.map(({ semanticTaskId, nativeTaskId }) => ({
      semanticTaskId,
      nativeTaskId,
    }));
    expect(nativeTasks.map(({ semanticTaskId }) => semanticTaskId).sort()).toEqual([...taskOrder].sort());
    const readAgentTraces = async () => Object.fromEntries(await Promise.all(nativeTasks.map(async ({
      semanticTaskId,
      nativeTaskId,
    }) => [semanticTaskId, (await store.getAgentLogs(nativeTaskId!, { limit: 200 }))
      .filter(({ type }) => type !== "tool_result" && type !== "thinking")
      .map(({ timestamp, type, text, detail, durationMs, timeToFirstTokenMs }) => ({
        timestamp,
        type,
        text: text.slice(0, 320),
        ...(detail ? { detail: detail.slice(0, 320) } : {}),
        durationMs,
        timeToFirstTokenMs,
      })).slice(-40)])));
    const requestCountByTask = (status: ProductStatusOutput) => Object.fromEntries(taskOrder.map((semanticTaskId) => [
      semanticTaskId,
      status.status.providerAttempts.filter((attempt) => attempt.semanticTaskId === semanticTaskId).length,
    ]));
    const persistEvidence = async (
      outcome: "passed" | "failed",
      status: ProductStatusOutput,
      failure: ReturnType<typeof captureFailure> | null = null,
    ) => {
      const evidence = {
        outcome,
        failure,
        driver,
        envelope: GOLDEN_PI_PROJECT_ENVELOPE,
        comboSnapshot,
        nextAction: status.status.nextAction,
        requestCount: status.status.providerAttempts.length,
        requestCountByTask: requestCountByTask(status),
        providerAttempts: status.status.providerAttempts.map(({ semanticTaskId, state, binding, terminal }) => ({
          semanticTaskId,
          state,
          binding: {
            providerId: binding.providerId,
            modelId: binding.modelId,
            transport: binding.transport,
          },
          terminal,
        })),
        proofs: status.status.proofs.map(({ definition, attempts }) => ({
          proofId: definition.id,
          attempts: attempts.map(({ state, phase, result, sourceCommit }) => ({
            state,
            phase,
            sourceCommit,
            success: result?.success,
            exitCode: result?.exitCode,
            stderrTail: result?.stderrTail,
          })),
        })),
        agentTraces: await readAgentTraces(),
      };
      await writeFile(evidencePath, `${JSON.stringify(evidence)}\n`, "utf8");
      return evidence;
    };

    __resetWorkflowExtensionRegistryForTests();
    await bootstrapCccCampaignProofAdmissionHost({ builtRootPath: cliDistRoot });
    central = new CentralCore(h.globalDir(), { asyncLayer: h.layer() });
    await central.init();
    runtime = new InProcessRuntime({
      projectId: h.layer().projectId ?? "ccc-golden-evidence-ledger-pi",
      workingDirectory: lifecycle.targetRoot,
      isolationMode: "in-process",
      maxConcurrent: 1,
      maxWorktrees: 1,
      externalTaskStore: store,
    }, central);
    (runtime as unknown as { cccCampaignProofBootstrapPromise?: Promise<void> })
      .cccCampaignProofBootstrapPromise = Promise.resolve();
    await runtime.start();
    const executorPrototype = TaskExecutor.prototype as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    const originalCommitFence = executorPrototype.runGraphCustomNodeWithRequiredCommitFence!;
    commitFenceSpy = vi.spyOn(executorPrototype, "runGraphCustomNodeWithRequiredCommitFence")
      .mockImplementation(async function (...args: unknown[]) {
        try {
          return await originalCommitFence.apply(this, args);
        } catch (error) {
          capturedCommitFenceFailure = captureFailure(error);
          throw error;
        }
      });
    const control = runtime as unknown as { drainWorkflowContinuations(): Promise<void> };
    await control.drainWorkflowContinuations();
    firstHold = await waitFor(
      async () => productStatus(await runProductCommand(["status", idempotencyKey], dependencies)),
      (value) => value.status.nextAction.kind === "approve-execution",
      "three-task sealed live-execution hold",
      terminalDiagnostic,
    );
    const confirmation = firstHold.liveExecutionAuthorizationConfirmation!;
    expect(await runProductCommand([
      "approve-execution", idempotencyKey, confirmation.authorizationId,
      "--confirm", confirmation.confirmation,
    ], dependencies)).toMatchObject({ exitCode: 0 });
    await control.drainWorkflowContinuations();

    let mergeHold: ProductStatusOutput;
    try {
      mergeHold = await waitForDurableProductBoundary(
        async () => productStatus(await runProductCommand(["status", idempotencyKey], dependencies)),
        (value) => value.status.nextAction.kind === "approve-merge",
        async (status) => ({
          capturedCommitFenceFailure,
          providerConfig: {
            home: process.env.HOME,
            providerNames: readCustomProviders().map(({ name }) => name),
          },
          nextAction: status.status.nextAction,
          requestCountByTask: requestCountByTask(status),
          workItems: status.status.workItems.map(({ id, state, lastError }) => ({ id, state, lastError })),
          proofs: status.status.proofs.map(({ definition, attempts }) => ({
            proofId: definition.id,
            attempts: attempts.map(({ state, phase, result }) => ({
              state,
              phase,
              exitCode: result?.exitCode,
              stderrTail: result?.stderrTail,
            })),
          })),
          agentTraces: await readAgentTraces(),
        }),
      );
    } catch (error) {
      const failure = captureFailure(error);
      try {
        const terminalStatus = productStatus(await runProductCommand(["status", idempotencyKey], dependencies));
        await persistEvidence("failed", terminalStatus, failure);
      } catch (evidencePersistenceError) {
        const fallbackEvidence = {
          outcome: "failed",
          failure,
          evidencePersistenceFailure: captureFailure(evidencePersistenceError),
          driver,
          envelope: GOLDEN_PI_PROJECT_ENVELOPE,
          comboSnapshot,
        };
        try {
          await writeFile(evidencePath, `${JSON.stringify(fallbackEvidence)}\n`, "utf8");
        } catch (fallbackWriteError) {
          console.error(`CCC_GOLDEN_PI_EVIDENCE_WRITE_FAILED=${JSON.stringify({
            ...fallbackEvidence,
            fallbackWriteFailure: captureFailure(fallbackWriteError),
          })}`);
        }
      }
      throw error;
    }
    expect(mergeHold.mergeApprovalConfirmations).toHaveLength(1);
    expect(await git(lifecycle.targetRoot, "rev-parse", "refs/heads/main")).toBe(lifecycle.baseCommit);
    expect(mergeHold.status.providerAttempts.length).toBeGreaterThan(0);
    expect(mergeHold.status.providerAttempts.length).toBeLessThanOrEqual(GOLDEN_PI_PROJECT_ENVELOPE.maxRequests);
    expect([...new Set(mergeHold.status.providerAttempts.map(({ semanticTaskId }) => semanticTaskId))].sort())
      .toEqual([...taskOrder].sort());
    const terminalMemberKeys = new Set(driver.attributionTerminalRouteMembers.map(({ provider, model }) =>
      `${provider}/${model}`));
    for (const providerAttempt of mergeHold.status.providerAttempts) {
      expect(providerAttempt).toMatchObject({
        state: "committed",
        binding: {
          providerId: driver.providerId,
          modelId: driver.modelId,
          transport: "pi",
        },
        terminal: {
          kind: "reconciled",
          effectiveRoute: {
            effectiveProvider: driver.providerId,
            effectiveModel: driver.modelId,
            receiptSource: "stream-usage",
            omniRoute: { final: { provider: expect.any(String), model: expect.any(String) } },
          },
        },
      });
      const final = providerAttempt.terminal.kind === "reconciled"
        ? providerAttempt.terminal.effectiveRoute.omniRoute?.final
        : undefined;
      expect(final).toBeDefined();
      if (!terminalMemberKeys.has(`${final!.provider}/${final!.model}`)) {
        const attributionFailure = new Error(
          `CCC_GOLDEN_ROUTE_ATTRIBUTION_FAILED ${driver.key} resolved to ${final!.provider}/${final!.model}`,
        );
        await persistEvidence("failed", mergeHold, captureFailure(attributionFailure));
        throw attributionFailure;
      }
    }
    const evidence = await persistEvidence("passed", mergeHold);
    console.error(`CCC_GOLDEN_PI_EVIDENCE=${JSON.stringify({
      outcome: evidence.outcome,
      driver: driver.key,
      requestCount: evidence.requestCount,
      requestCountByTask: evidence.requestCountByTask,
      evidencePath,
    })}`);
    const proofAttempts = mergeHold.status.proofs.flatMap(({ definition, attempts }) =>
      attempts.map((attempt) => ({ proofId: definition.id, ...attempt })));
    expect(proofAttempts).toHaveLength(4);
    expect(proofAttempts.map(({ proofId }) => proofId).sort()).toEqual([
      "PROOF-LEDGER-CLI",
      "PROOF-LEDGER-CONTRACT",
      "PROOF-LEDGER-CORE",
      "PROOF-LEDGER-INTEGRATED",
    ]);
    expect(proofAttempts.every(({ state, result }) =>
      state === "committed" && result?.success === true && result.exitCode === 0)).toBe(true);
    const finalAttempt = proofAttempts.find(({ proofId }) => proofId === "PROOF-LEDGER-INTEGRATED")!;
    expect(finalAttempt.phase).toBe("final_integrated");
    expect(await git(lifecycle.targetRoot, "diff", "--name-only", lifecycle.baseCommit, finalAttempt.sourceCommit))
      .toBe(exactCandidateFiles.join("\n"));
  });
});
