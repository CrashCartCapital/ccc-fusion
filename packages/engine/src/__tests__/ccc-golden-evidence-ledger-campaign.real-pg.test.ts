import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  beforeAll,
  expect,
  it,
  vi,
} from "vitest";
import {
  CentralCore,
  TaskStore,
  __resetWorkflowExtensionRegistryForTests,
  queryRunAuditEvents,
} from "@fusion/core";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
} from "../../../core/src/__test-utils__/pg-test-harness.js";
import type { PrdCommandDependencies } from "../../../cli/src/commands/prd.js";
import { bootstrapCccCampaignProofAdmissionHost } from "../ccc-campaign-proof-host.js";
import { InProcessRuntime } from "../runtimes/in-process-runtime.js";
import { TaskExecutor } from "../executor.js";
import {
  adapterId,
  cliDistRoot,
  createFixturePayload,
  exactCandidateFiles,
  fixtureAdapter,
  idempotencyKey,
  ownedFilesByTask,
  prepareLifecycle,
  readProviderEvents,
  taskOrder,
  type PreparedLifecycle,
} from "./helpers/ccc-golden-evidence-ledger-campaign-fixture.js";
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
import { replayContractProof } from "./helpers/ccc-golden-evidence-ledger-campaign-diagnostics.js";

pgDescribe.sequential("CCC Golden Evidence Ledger three-task fake campaign", () => {
  const h = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_ccc_golden_three_task",
    poolMax: 4,
  });
  let lifecycleRoot = "";
  let fixtureRoot = "";
  let lifecycle: PreparedLifecycle;
  let fixture: Awaited<ReturnType<typeof createFixturePayload>>;
  let dependencies: PrdCommandDependencies;
  let store: TaskStore;
  let runtime: InProcessRuntime | undefined;
  let central: CentralCore | undefined;
  let firstHold: ProductStatusOutput;
  let capturedPreProviderFailure: ReturnType<typeof captureFailure> | null = null;
  let capturedCommitFenceFailure: ReturnType<typeof captureFailure> | null = null;
  let cliRunnerSpy: { mockRestore(): void } | undefined;
  let commitFenceSpy: { mockRestore(): void } | undefined;

  beforeAll(async () => {
    await h.beforeAll();
    await h.beforeEach();
    lifecycleRoot = await mkdtemp(join(tmpdir(), "ccc-golden-runtime-"));
    fixtureRoot = await mkdtemp(join(tmpdir(), "ccc-golden-provider-"));
    lifecycle = await prepareLifecycle(lifecycleRoot);
    fixture = await createFixturePayload(fixtureRoot);
    store = new TaskStore(lifecycle.targetRoot, undefined, { asyncLayer: h.layer() });
    const currentSettings = await store.getSettings();
    await store.updateGlobalSettings({
      experimentalFeatures: {
        ...(currentSettings.experimentalFeatures ?? {}),
        cliAgentExecutor: true,
      },
    });
    await store.updateSettings({ pollIntervalMs: 60_000, maxConcurrent: 1, maxWorktrees: 1 });
    dependencies = {
      bootstrapProofAdmission: () => bootstrapCccCampaignProofAdmissionHost({ builtRootPath: cliDistRoot }),
      resolveProject: async () => ({
        projectId: h.layer().projectId ?? "ccc-golden-evidence-ledger",
        projectPath: lifecycle.targetRoot,
        projectName: "CCC Golden Evidence Ledger",
        isRegistered: true,
        store,
      }),
      closeProjectStore: async () => undefined,
      readTargetHead: async () => git(lifecycle.targetRoot, "rev-parse", "refs/heads/main"),
    };
  });

  afterAll(async () => {
    cliRunnerSpy?.mockRestore();
    commitFenceSpy?.mockRestore();
    if (runtime) await runtime.stop();
    if (central) await central.close();
    __resetWorkflowExtensionRegistryForTests();
    await rm(lifecycleRoot, { recursive: true, force: true });
    await rm(fixtureRoot, { recursive: true, force: true });
    await h.afterEach();
    await h.afterAll();
  });

  it("imports the exact three-task packet with native dependency custody", async () => {
    const common = [
      lifecycle.frozenRoot,
      lifecycle.manifestPath,
      lifecycle.sidecarPath,
      lifecycle.executionPlanPath,
      lifecycle.targetRoot,
      lifecycle.baseCommit,
    ];
    const preview = await runProductCommand(["preview", ...common], dependencies);
    expect(preview.exitCode).toBe(0);
    const digest = (preview.values[0] as { confirmationDigest: string }).confirmationDigest;
    const imported = await runProductCommand([
      "import", ...common, idempotencyKey, "--confirm", digest,
    ], dependencies);
    expect(imported).toMatchObject({
      exitCode: 0,
      values: [expect.objectContaining({
        kind: "imported",
        result: expect.objectContaining({
          state: "active",
          runnable: true,
          directCounts: expect.objectContaining({ tasks: 3, dependencyEdges: 2 }),
        }),
      })],
    });
    const status = productStatus(await runProductCommand(["status", idempotencyKey], dependencies));
    expect(status.status.tasks.map(({ semanticTaskId }) => semanticTaskId).sort()).toEqual([...taskOrder].sort());
    const nativeBySemantic = new Map(status.status.tasks.map((task) => [task.semanticTaskId, task.nativeTaskId]));
    for (const [index, semanticTaskId] of taskOrder.entries()) {
      const task = await store.getTask(nativeBySemantic.get(semanticTaskId)!);
      expect(task.dependencies).toEqual(index === 0 ? [] : [nativeBySemantic.get(taskOrder[index - 1]!)!]);
    }
  });

  it("starts the real runtime and reaches the sealed live-execution hold", async () => {
    __resetWorkflowExtensionRegistryForTests();
    await bootstrapCccCampaignProofAdmissionHost({ builtRootPath: cliDistRoot });
    central = new CentralCore(h.globalDir(), { asyncLayer: h.layer() });
    await central.init();
    runtime = new InProcessRuntime({
      projectId: h.layer().projectId ?? "ccc-golden-evidence-ledger",
      workingDirectory: lifecycle.targetRoot,
      isolationMode: "in-process",
      maxConcurrent: 1,
      maxWorktrees: 1,
      externalTaskStore: store,
    }, central);
    (runtime as unknown as { cccCampaignProofBootstrapPromise?: Promise<void> })
      .cccCampaignProofBootstrapPromise = Promise.resolve();
    await runtime.start();
    const cliRuntime = runtime.getCliAgentRuntime();
    if (!cliRuntime) throw new Error("real runtime did not initialize the CLI executor");
    cliRuntime.bundle.registry.register(fixtureAdapter(fixture, cliRuntime.bundle.hub));
    const executorPrototype = TaskExecutor.prototype as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    const originalRunCliAgentNode = executorPrototype.runCliAgentNode!;
    cliRunnerSpy = vi.spyOn(executorPrototype, "runCliAgentNode").mockImplementation(async function (...args: unknown[]) {
      try {
        return await originalRunCliAgentNode.apply(this, args);
      } catch (error) {
        capturedPreProviderFailure = captureFailure(error);
        throw error;
      }
    });
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
      "sealed live-execution hold",
      terminalDiagnostic,
    );
    expect(firstHold.liveExecutionAuthorizationConfirmation).toMatchObject({
      authorizationId: expect.any(String),
      confirmation: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(await git(lifecycle.targetRoot, "rev-parse", "refs/heads/main")).toBe(lifecycle.baseCommit);
    expect(readProviderEvents(fixture.markerPath)).toEqual([]);
  });

  it("runs the exact three-task campaign to its durable unlanded merge hold", { timeout: 120_000 }, async () => {
    const confirmation = firstHold.liveExecutionAuthorizationConfirmation!;
    const approved = await runProductCommand([
      "approve-execution",
      idempotencyKey,
      confirmation.authorizationId,
      "--confirm",
      confirmation.confirmation,
    ], dependencies);
    expect(approved.exitCode).toBe(0);
    const control = runtime as unknown as { drainWorkflowContinuations(): Promise<void> };
    await control.drainWorkflowContinuations();
    const diagnose = async (status: ProductStatusOutput) => {
      const proofAudits = (await queryRunAuditEvents(h.layer().db, {})).filter(({ mutationType }) =>
        mutationType === "ccc-campaign:proof-admission");
      return {
        capturedPreProviderFailure,
        capturedCommitFenceFailure,
        nextAction: status.status.nextAction,
        workItems: status.status.workItems.map(({ id, state, lastError }) => ({ id, state, lastError })),
        providerAttempts: status.status.providerAttempts,
        proofs: status.status.proofs.map(({ definition, attempts }) => ({ proofId: definition.id, attempts: attempts.map(({ state, result, proofEvidenceParseIssue }) => ({ state, exitCode: result?.exitCode, stdoutTail: result?.stdoutTail, stderrTail: result?.stderrTail, proofEvidenceParseIssue })) })),
        proofAuditIds: proofAudits.map(({ metadata }) => metadata?.proofId),
        contractReplay: await replayContractProof(status, fixture.markerPath),
      };
    };
    const mergeHold = await waitForDurableProductBoundary(
      async () => productStatus(await runProductCommand(["status", idempotencyKey], dependencies)),
      (value) => value.status.nextAction.kind === "approve-merge",
      diagnose,
    );
    const events = readProviderEvents(fixture.markerPath);
    expect(events.map(({ taskId }) => taskId)).toEqual(taskOrder);
    for (const [index, event] of events.entries()) {
      expect(event).toMatchObject({
        taskId: taskOrder[index],
        files: [...ownedFilesByTask[taskOrder[index]!]],
        cwd: expect.not.stringMatching(new RegExp(`^${lifecycle.targetRoot}/?$`)),
      });
    }
    expect(capturedPreProviderFailure).toBeNull();
    expect(mergeHold.mergeApprovalConfirmations).toHaveLength(1);
    expect(await git(lifecycle.targetRoot, "rev-parse", "refs/heads/main")).toBe(lifecycle.baseCommit);
    const attempts = mergeHold.status.proofs.flatMap(({ definition, attempts }) =>
      attempts.map((attempt) => ({ proofId: definition.id, ...attempt })));
    expect(attempts).toHaveLength(4);
    expect(attempts.map(({ proofId }) => proofId).sort()).toEqual([
      "PROOF-LEDGER-CLI",
      "PROOF-LEDGER-CONTRACT",
      "PROOF-LEDGER-CORE",
      "PROOF-LEDGER-INTEGRATED",
    ]);
    expect(attempts.every(({ state, result }) =>
      state === "committed" && result?.success === true && result.exitCode === 0)).toBe(true);
    const integrated = attempts.find(({ proofId }) => proofId === "PROOF-LEDGER-INTEGRATED")!;
    expect(integrated.phase).toBe("final_integrated");
    expect(await git(lifecycle.targetRoot, "diff", "--name-only", lifecycle.baseCommit, integrated.sourceCommit))
      .toBe(exactCandidateFiles.join("\n"));
    for (const relativePath of exactCandidateFiles) {
      expect(await git(lifecycle.targetRoot, "show", `${integrated.sourceCommit}:${relativePath}`))
        .toBe(fixture.expected[relativePath]!.trimEnd());
    }
    expect(mergeHold.status.providerAttempts).toHaveLength(3);
    expect(mergeHold.status.providerAttempts.map(({ semanticTaskId }) => semanticTaskId).sort()).toEqual([...taskOrder].sort());
    expect(mergeHold.status.providerAttempts.every((attempt) =>
      attempt.requestCount >= 1
      && attempt.requestCount <= 3
      && attempt.state === "committed"
      && attempt.terminal?.kind === "reconciled"
      && attempt.binding.providerId === "golden-fixture-provider"
      && attempt.binding.modelId === "golden-fixture-model"
      && attempt.binding.transport === "cli")).toBe(true);
  });
});
