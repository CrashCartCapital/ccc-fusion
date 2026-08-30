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

const cliDistRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../cli/dist");
const idempotencyKey = "ccc-golden-evidence-ledger-pi-contract-r6-spec-v2";
const providerId = "golden-omniroute-luna";
const modelId = "cx/gpt-5.6-luna-max";
const livePgDescribe = process.env.CCC_GOLDEN_LIVE_PI === "1"
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

async function prepareLifecycle(root: string): Promise<PreparedLifecycle> {
  const module = await import("../../../../scripts/lib/ccc-golden-packet-lifecycle.mjs") as {
    prepareEvidenceLedgerPacketLifecycle(input: Record<string, unknown>): Promise<PreparedLifecycle>;
  };
  return module.prepareEvidenceLedgerPacketLifecycle({
    root,
    route: {
      providerId,
      modelId,
      transport: "pi",
      receiptAdapterId: "terminal-route-sse-comments.v1",
    },
    maxRequests: 6,
    maxDurationMs: 180_000,
    taskCount: 1,
  });
}

livePgDescribe("CCC Golden Evidence Ledger one-task live Pi campaign", () => {
  const h = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_ccc_golden_pi_contract",
    poolMax: 4,
  });
  let lifecycleRoot = "";
  let isolatedHome = "";
  let lifecycle: PreparedLifecycle;
  let dependencies: PrdCommandDependencies;
  let store: TaskStore;
  let runtime: InProcessRuntime | undefined;
  let central: CentralCore | undefined;
  let firstHold: ProductStatusOutput;
  let capturedCommitFenceFailure: ReturnType<typeof captureFailure> | null = null;
  let commitFenceSpy: { mockRestore(): void } | undefined;

  beforeAll(async () => {
    await h.beforeAll();
    await h.beforeEach();
    lifecycleRoot = await mkdtemp(join(tmpdir(), "ccc-golden-pi-contract-"));
    isolatedHome = process.env.HOME ?? "";
    expect(isolatedHome).not.toBe("");
    lifecycle = await prepareLifecycle(lifecycleRoot);
    store = new TaskStore(lifecycle.targetRoot, join(isolatedHome, ".fusion"), { asyncLayer: h.layer() });
    const liveProviderSettings = {
      openrouterModelSync: false,
      opencodeGoModelSync: false,
      customProviders: [{
        id: "f9ad9c11-b84c-4b06-b7bb-c330f37b21f1",
        name: providerId,
        apiType: "openai-compatible",
        baseUrl: "http://127.0.0.1:8092/v1",
        headers: { "X-OmniRoute-No-Cache": "true" },
        models: [{
          id: modelId,
          name: "CCC Golden Luna Max",
          contextWindow: 200_000,
          maxTokens: 32_768,
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
    expect(readCustomProviders(isolatedHome).map(({ name }) => name)).toEqual([providerId]);
    expect(readCustomProviders().map(({ name }) => name)).toEqual([providerId]);
    await store.updateSettings({ pollIntervalMs: 60_000, maxConcurrent: 1, maxWorktrees: 1 });
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
    commitFenceSpy?.mockRestore();
    if (runtime) await runtime.stop();
    if (central) await central.close();
    __resetWorkflowExtensionRegistryForTests();
    await rm(lifecycleRoot, { recursive: true, force: true });
    await h.afterEach();
    await h.afterAll();
  });

  test("generates and proves the contract project through real Pi", { timeout: 240_000 }, async () => {
    const readAgentTrace = async () => (await store.getAgentLogs("KB-001", { limit: 200 }))
      .filter(({ type }) => type !== "tool_result" && type !== "thinking")
      .map(({ timestamp, type, text, detail, durationMs, timeToFirstTokenMs }) => ({
        timestamp,
        type,
        text: text.slice(0, 320),
        ...(detail ? { detail: detail.slice(0, 320) } : {}),
        durationMs,
        timeToFirstTokenMs,
      }));
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
      "one-task sealed live-execution hold",
      terminalDiagnostic,
    );
    const confirmation = firstHold.liveExecutionAuthorizationConfirmation!;
    expect(await runProductCommand([
      "approve-execution", idempotencyKey, confirmation.authorizationId,
      "--confirm", confirmation.confirmation,
    ], dependencies)).toMatchObject({ exitCode: 0 });
    await control.drainWorkflowContinuations();

    const mergeHold = await waitForDurableProductBoundary(
      async () => productStatus(await runProductCommand(["status", idempotencyKey], dependencies)),
      (value) => value.status.nextAction.kind === "approve-merge",
      async (status) => ({
        capturedCommitFenceFailure,
        providerConfig: {
          home: process.env.HOME,
          providerNames: readCustomProviders().map(({ name }) => name),
        },
        nextAction: status.status.nextAction,
        workItems: status.status.workItems.map(({ id, state, lastError }) => ({ id, state, lastError })),
        providerAttempts: status.status.providerAttempts.map(({ state, binding, terminal }) => ({
          state,
          binding: {
            providerId: binding.providerId,
            modelId: binding.modelId,
            transport: binding.transport,
            receiptAdapterId: binding.receiptAdapterId,
          },
          terminal,
        })),
        proofs: status.status.proofs.map(({ definition, attempts }) => ({
          proofId: definition.id,
          attempts: attempts.map(({ state, phase, result }) => ({
            state,
            phase,
            exitCode: result?.exitCode,
            stderrTail: result?.stderrTail,
          })),
        })),
        agentTrace: await readAgentTrace(),
      }),
    );
    const agentTrace = await readAgentTrace();
    console.error(`CCC_GOLDEN_PI_EVIDENCE=${JSON.stringify({
      requestCount: mergeHold.status.providerAttempts.length,
      proofAttemptCount: mergeHold.status.proofs.flatMap(({ attempts }) => attempts).length,
      routes: mergeHold.status.providerAttempts.map(({ terminal }) => terminal),
      agentTrace,
    })}`);
    expect(mergeHold.mergeApprovalConfirmations).toHaveLength(1);
    expect(await git(lifecycle.targetRoot, "rev-parse", "refs/heads/main")).toBe(lifecycle.baseCommit);
    expect(mergeHold.status.providerAttempts.length).toBeGreaterThan(0);
    expect(mergeHold.status.providerAttempts.length).toBeLessThanOrEqual(6);
    for (const providerAttempt of mergeHold.status.providerAttempts) {
      expect(providerAttempt).toMatchObject({
        semanticTaskId: "TASK-LEDGER-CONTRACT",
        state: "committed",
        binding: {
          providerId,
          modelId,
          transport: "pi",
        },
        terminal: {
          kind: "reconciled",
          effectiveRoute: {
            effectiveProvider: providerId,
            effectiveModel: modelId,
            receiptSource: "stream-usage",
            omniRoute: {
              final: {
                provider: "cx",
                model: "gpt-5.6-luna-max",
              },
            },
          },
        },
      });
    }
    const proofAttempts = mergeHold.status.proofs.flatMap(({ attempts }) => attempts);
    expect(proofAttempts).toHaveLength(2);
    expect(proofAttempts.map(({ phase }) => phase).sort()).toEqual(["final_integrated", "task"]);
    expect(proofAttempts.every(({ state, result }) =>
      state === "committed" && result?.success === true && result.exitCode === 0)).toBe(true);
    const finalAttempt = proofAttempts.find(({ phase }) => phase === "final_integrated")!;
    expect(await git(lifecycle.targetRoot, "diff", "--name-only", lifecycle.baseCommit, finalAttempt.sourceCommit))
      .toBe("src/record.mjs\nsrc/validation.mjs");
  });
});
