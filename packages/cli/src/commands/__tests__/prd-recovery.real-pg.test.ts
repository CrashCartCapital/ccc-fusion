import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
} from "vitest";
import {
  beginCccCampaignProofAttemptDispatch,
  importCccPrdBundle,
  inspectCccCampaignProofAttempt,
  inspectCccPrdProductStatus,
  reserveCccCampaignProofAttempt,
  type CccCampaignProductExecutionPolicy,
} from "@fusion/core";
import {
  createCccPrdImportTestBundle,
  createCccPrdImportTestProductExecutionPolicy,
} from "../../../../core/src/__test-utils__/ccc-prd-import-fixture.js";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
} from "../../../../core/src/__test-utils__/pg-test-harness.js";
import type { ProjectContext } from "../../project-context.js";
import { runPrdCommand } from "../prd.js";

const SOURCE_COMMIT = "d".repeat(40);
const SOURCE_TREE = "e".repeat(40);
const PROVIDER_EVIDENCE = createHash("sha256")
  .update("operator-observed-provider-failure", "utf8")
  .digest("hex");

pgDescribe("CCC PRD normal CLI recovery path (PostgreSQL)", () => {
  const h = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_ccc_prd_cli_recovery",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  function commandDependencies() {
    const project = {
      projectId: h.layer().projectId || "__legacy_unscoped__",
      projectPath: h.rootDir(),
      projectName: "CLI recovery integration",
      isRegistered: true,
      store: h.store(),
    } satisfies ProjectContext;
    return {
      resolveProject: async () => project,
      closeProjectStore: async () => undefined,
    };
  }

  async function runCommand(args: string[]) {
    const output: string[] = [];
    const exitCode = await runPrdCommand(
      args,
      { write: (line) => output.push(line) },
      commandDependencies(),
      { projectName: "cli-recovery-integration" },
    );
    return {
      exitCode,
      output,
      json: output[0] ? JSON.parse(output[0]) as Record<string, unknown> : null,
    };
  }

  async function importRecoveryCampaign(
    suffix: string,
    transport: "pi" | "cli" = "pi",
  ) {
    const source = createCccPrdImportTestBundle(h.rootDir(), suffix);
    const basePolicy =
      createCccPrdImportTestProductExecutionPolicy(source);
    const entrySemanticTaskId = source.workflows[0]!.entryTaskIds[0]!;
    const siblingSemanticTaskId = source.workflows[0]!.taskIds.find(
      (taskId) => taskId !== entrySemanticTaskId,
    )!;
    const executionPolicy: CccCampaignProductExecutionPolicy =
      transport === "cli"
        ? {
          ...basePolicy,
          routes: basePolicy.routes.map((route) =>
            route.taskId === entrySemanticTaskId
              ? {
                ...route,
                transport: "cli",
                executor: "cli-agent",
                cliAdapterId: "ccc-recovery-test-cli",
              }
              : route),
        }
        : basePolicy;
    const idempotencyKey = `cli-recovery-${suffix}`;
    const imported = await importCccPrdBundle({
      bundle: source,
      executionPolicy,
      idempotencyKey,
      store: h.store(),
      layer: h.layer(),
      rootDir: h.rootDir(),
    });
    const ledgerBackedStatus = await inspectCccPrdProductStatus({
      idempotencyKey,
      layer: h.layer(),
      rootDir: h.rootDir(),
    });
    if (!ledgerBackedStatus) throw new Error("missing imported product status");
    const nativeTaskId = (semanticTaskId: string): string => {
      const matches = ledgerBackedStatus.tasks.filter(
        (task) => task.semanticTaskId === semanticTaskId,
      );
      expect(matches).toHaveLength(1);
      expect(matches[0]!.nativeTaskId).not.toBe(semanticTaskId);
      return matches[0]!.nativeTaskId;
    };
    expect(ledgerBackedStatus.workItems).toHaveLength(1);
    const exactWorkItem = await h.store().getWorkflowWorkItem(
      ledgerBackedStatus.workItems[0]!.id,
    );
    if (!exactWorkItem) throw new Error("missing imported recovery work item");
    const parkedWorkItem = await h.store().transitionWorkflowWorkItem(
      exactWorkItem.id,
      "manual-required",
      {
        expectedState: exactWorkItem.state,
        expectedAttempt: exactWorkItem.attempt,
        expectedLeaseOwner: exactWorkItem.leaseOwner,
        attempt: 1,
        leaseOwner: null,
        leaseExpiresAt: null,
        retryAfter: null,
        lastError: `crash-cut:${suffix}:uncertain-effect`,
        blockedReason: "operator reconciliation required",
      },
    );
    const entryTaskId = nativeTaskId(entrySemanticTaskId);
    const siblingTaskId = nativeTaskId(siblingSemanticTaskId);
    expect(siblingTaskId).not.toBe(entryTaskId);
    const siblingWorkItem = await h.store().upsertWorkflowWorkItem({
      id: `${imported.importId}--RECOVERY-SIBLING-${suffix}`,
      runId: `recovery-negative-control:${imported.importId}`,
      taskId: siblingTaskId,
      nodeId: `recovery-sibling-${suffix}`,
      kind: "recovery",
      state: "held",
      attempt: 0,
      leaseOwner: null,
      leaseExpiresAt: null,
      blockedReason: "negative-control sibling remains held",
      stableWorkflowRunId: `recovery-negative-control:${imported.importId}`,
    });
    return {
      source,
      executionPolicy,
      idempotencyKey,
      imported,
      taskId: entryTaskId,
      semanticTaskId: entrySemanticTaskId,
      parkedWorkItem,
      siblingWorkItem,
    };
  }

  function assertNoControllerToken(
    output: readonly string[],
    controllerToken: string,
  ): void {
    const rendered = output.join("\n");
    expect(rendered).not.toContain("controllerToken");
    expect(rendered).not.toContain(controllerToken);
  }

  it("previews and settles one uncertain proof from strict external evidence, then requeues only its exact work item", async () => {
    const campaign = await importRecoveryCampaign("proof");
    const proof = campaign.source.proofs[0]!;
    const reserved = await reserveCccCampaignProofAttempt({
      layer: h.layer(),
      rootDir: h.rootDir(),
      taskId: campaign.taskId,
      proofId: proof.id,
      sourceCommit: SOURCE_COMMIT,
      sourceTree: SOURCE_TREE,
      workItemFence: {
        workItemId: campaign.parkedWorkItem.id,
        runId: campaign.parkedWorkItem.runId,
        attempt: campaign.parkedWorkItem.attempt,
      },
    });
    await beginCccCampaignProofAttemptDispatch({
      layer: h.layer(),
      attemptKey: reserved.attemptKey,
      controllerToken: reserved.controllerToken,
    });
    const evidencePath = join(h.rootDir(), "proof-recovery-evidence.json");
    await writeFile(evidencePath, `${JSON.stringify({
      schema: "ccc-campaign.proof-resolution.v1",
      observerId: "operator-pg-proof",
      summary:
        "Observed the exact verifier exit zero and captured its bounded output.",
      result: {
        success: true,
        exitCode: 0,
        durationMs: 17,
        stdout: "EXACT_VERIFIER_PASS\n",
        stderr: "",
        timedOut: false,
        killed: false,
        warnings: ["crash-cut recovery evidence"],
        changedPathsSha256: createHash("sha256")
          .update(JSON.stringify(["src/task-0"]), "utf8")
          .digest("hex"),
        negativeControlLabel: "planted-defect-failed",
      },
    }, null, 2)}\n`, "utf8");

    const preview = await runCommand([
      "resolve-proof",
      campaign.idempotencyKey,
      reserved.attemptKey,
      evidencePath,
    ]);
    expect(preview.exitCode, preview.output.join("\n")).toBe(0);
    expect(preview.json).toMatchObject({
      kind: "proof-resolution-preview",
      attemptKey: reserved.attemptKey,
      decision: "settle",
      outcome: "committed",
      confirmation: expect.stringMatching(/^[0-9a-f]{64}$/),
      consequence: expect.stringContaining("requeue"),
    });
    await expect(inspectCccCampaignProofAttempt({
      layer: h.layer(),
      attemptKey: reserved.attemptKey,
    })).resolves.toMatchObject({ state: "dispatched_unknown" });
    await expect(h.store().getWorkflowWorkItem(
      campaign.parkedWorkItem.id,
    )).resolves.toMatchObject({ state: "manual-required" });
    assertNoControllerToken(preview.output, reserved.controllerToken);

    const confirmation = String(preview.json!.confirmation);
    const settled = await runCommand([
      "resolve-proof",
      campaign.idempotencyKey,
      reserved.attemptKey,
      evidencePath,
      "--confirm",
      confirmation,
    ]);
    expect(settled.exitCode, settled.output.join("\n")).toBe(0);
    expect(settled.json).toMatchObject({
      kind: "proof-resolved",
      attempt: {
        attemptKey: reserved.attemptKey,
        state: "committed",
        result: {
          success: true,
          exitCode: 0,
          stdoutTail: "EXACT_VERIFIER_PASS\n",
        },
      },
    });
    assertNoControllerToken(settled.output, reserved.controllerToken);

    const persisted = await inspectCccCampaignProofAttempt({
      layer: h.layer(),
      attemptKey: reserved.attemptKey,
    });
    expect(persisted).toMatchObject({
      state: "committed",
      result: {
        success: true,
        warnings: [
          "crash-cut recovery evidence",
          expect.stringContaining("operator-reconciliation:operator-pg-proof"),
        ],
      },
    });
    const freshStatus = await inspectCccPrdProductStatus({
      idempotencyKey: campaign.idempotencyKey,
      layer: h.layer(),
      rootDir: h.rootDir(),
    });
    expect(freshStatus?.proofs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        attempts: expect.arrayContaining([
          expect.objectContaining({
            attemptKey: reserved.attemptKey,
            state: "committed",
          }),
        ]),
      }),
    ]));
    expect(freshStatus?.workItems
      .filter(({ state }) => state === "runnable")
      .map(({ id }) => id)).toEqual([campaign.parkedWorkItem.id]);
    await expect(h.store().getWorkflowWorkItem(
      campaign.siblingWorkItem.id,
    )).resolves.toMatchObject({ state: "held" });
  });

  it("previews and settles one uncertain PI provider attempt as proved-failed durably, then requeues only its exact work item", async () => {
    const campaign = await importRecoveryCampaign("provider-pi");
    const route = campaign.executionPolicy.routes.find(
      ({ taskId }) => taskId === campaign.semanticTaskId,
    )!;
    const reserved = await h.store().reserveCccProviderAttempt({
      taskId: campaign.taskId,
      actionId: campaign.taskId,
      actionTarget: h.rootDir(),
      turnKey: "provider-pi-recovery-turn",
      dispatchKey: "provider-pi-recovery-dispatch",
      providerId: route.providerId,
      modelId: route.modelId,
      transport: "pi",
      workItemFence: {
        workItemId: campaign.parkedWorkItem.id,
        runId: campaign.parkedWorkItem.runId,
        attempt: campaign.parkedWorkItem.attempt,
      },
    });
    await h.store().beginCccProviderAttemptDispatch({
      taskId: campaign.taskId,
      attemptKey: reserved.attemptKey,
      controllerToken: reserved.controllerToken,
    });
    const preResolutionStatus = await inspectCccPrdProductStatus({
      idempotencyKey: campaign.idempotencyKey,
      layer: h.layer(),
      rootDir: h.rootDir(),
    });
    expect(preResolutionStatus?.workItems.map((workItem) => ({
      id: workItem.id,
      taskId: workItem.taskId,
      state: workItem.state,
    }))).toEqual([
      {
        id: campaign.parkedWorkItem.id,
        taskId: campaign.taskId,
        state: "manual-required",
      },
    ]);
    expect(preResolutionStatus?.providerAttempts).toEqual([
      expect.objectContaining({
        attemptKey: reserved.attemptKey,
        taskId: campaign.taskId,
        semanticTaskId: campaign.semanticTaskId,
        workItemFence: {
          workItemId: campaign.parkedWorkItem.id,
          runId: campaign.parkedWorkItem.runId,
          attempt: campaign.parkedWorkItem.attempt,
        },
        state: "dispatched_unknown",
      }),
    ]);

    await h.store().upsertWorkflowWorkItem({
      ...campaign.parkedWorkItem,
      attempt: campaign.parkedWorkItem.attempt + 1,
    });
    const wrongAttempt = await runCommand([
      "resolve-provider",
      campaign.idempotencyKey,
      reserved.attemptKey,
      "proved-failed",
      "operator-pg-provider",
      PROVIDER_EVIDENCE,
    ]);
    expect(wrongAttempt.exitCode).toBe(1);
    expect(wrongAttempt.json).toMatchObject({
      kind: "refusal",
      diagnostics: [{
        code: "CCC_PRD_PROVIDER_RESOLUTION_WORK_ITEM_MISSING",
        message: expect.stringContaining("exact imported workflow work item"),
      }],
    });
    await h.store().upsertWorkflowWorkItem(campaign.parkedWorkItem);

    const preview = await runCommand([
      "resolve-provider",
      campaign.idempotencyKey,
      reserved.attemptKey,
      "proved-failed",
      "operator-pg-provider",
      PROVIDER_EVIDENCE,
    ]);
    expect(preview.exitCode, preview.output.join("\n")).toBe(0);
    expect(preview.json).toMatchObject({
      kind: "provider-resolution-preview",
      attemptKey: reserved.attemptKey,
      outcome: "proved_failed",
      confirmation: expect.stringMatching(/^[0-9a-f]{64}$/),
      consequence: expect.stringContaining("requeue"),
    });
    await expect(h.store().inspectCccProviderAttempt({
      taskId: campaign.taskId,
      attemptKey: reserved.attemptKey,
    })).resolves.toMatchObject({ state: "dispatched_unknown" });
    assertNoControllerToken(preview.output, reserved.controllerToken);

    const settled = await runCommand([
      "resolve-provider",
      campaign.idempotencyKey,
      reserved.attemptKey,
      "proved-failed",
      "operator-pg-provider",
      PROVIDER_EVIDENCE,
      "--confirm",
      String(preview.json!.confirmation),
    ]);
    expect(settled.exitCode, settled.output.join("\n")).toBe(0);
    expect(settled.json).toMatchObject({
      kind: "provider-resolved",
      attempt: {
        attemptKey: reserved.attemptKey,
        state: "proved_failed",
        terminal: {
          kind: "reconciled",
          state: "proved_failed",
          evidenceDigest: PROVIDER_EVIDENCE,
          observerId: "operator-pg-provider",
        },
      },
    });
    assertNoControllerToken(settled.output, reserved.controllerToken);

    const persisted = await h.store().inspectCccProviderAttempt({
      taskId: campaign.taskId,
      attemptKey: reserved.attemptKey,
    });
    expect(persisted).toMatchObject({
      state: "proved_failed",
      terminal: {
        kind: "reconciled",
        state: "proved_failed",
        evidenceDigest: PROVIDER_EVIDENCE,
        observerId: "operator-pg-provider",
      },
    });
    const freshStatus = await inspectCccPrdProductStatus({
      idempotencyKey: campaign.idempotencyKey,
      layer: h.layer(),
      rootDir: h.rootDir(),
    });
    expect(freshStatus?.providerAttempts).toEqual([
      expect.objectContaining({
        attemptKey: reserved.attemptKey,
        state: "proved_failed",
        terminal: expect.objectContaining({
          evidenceDigest: PROVIDER_EVIDENCE,
        }),
      }),
    ]);
    expect(freshStatus?.workItems
      .filter(({ state }) => state === "runnable")
      .map(({ id }) => id)).toEqual([campaign.parkedWorkItem.id]);
    await expect(h.store().getWorkflowWorkItem(
      campaign.siblingWorkItem.id,
    )).resolves.toMatchObject({ state: "held" });
  });

  it("refuses generic settlement for an uncertain CLI provider attempt and preserves its fence-owned state", async () => {
    const campaign = await importRecoveryCampaign("provider-cli", "cli");
    const route = campaign.executionPolicy.routes.find(
      ({ taskId }) => taskId === campaign.semanticTaskId,
    )!;
    const reserved = await h.store().reserveCccProviderAttempt({
      taskId: campaign.taskId,
      actionId: campaign.taskId,
      actionTarget: h.rootDir(),
      turnKey: "provider-cli-recovery-turn",
      dispatchKey: "provider-cli-recovery-dispatch",
      providerId: route.providerId,
      modelId: route.modelId,
      transport: "cli",
      workItemFence: {
        workItemId: campaign.parkedWorkItem.id,
        runId: campaign.parkedWorkItem.runId,
        attempt: campaign.parkedWorkItem.attempt,
      },
    });
    await h.store().beginCccProviderAttemptDispatch({
      taskId: campaign.taskId,
      attemptKey: reserved.attemptKey,
      controllerToken: reserved.controllerToken,
    });

    const refused = await runCommand([
      "resolve-provider",
      campaign.idempotencyKey,
      reserved.attemptKey,
      "proved-failed",
      "operator-pg-provider",
      PROVIDER_EVIDENCE,
    ]);
    expect(refused.exitCode).toBe(1);
    expect(refused.json).toMatchObject({
      kind: "refusal",
      diagnostics: [{
        code: "CCC_PRD_PROVIDER_RESOLUTION_CLI_FENCE_REQUIRED",
        message: expect.stringMatching(/native CLI.*recovery/i),
      }],
    });
    assertNoControllerToken(refused.output, reserved.controllerToken);
    await expect(h.store().inspectCccProviderAttempt({
      taskId: campaign.taskId,
      attemptKey: reserved.attemptKey,
    })).resolves.toMatchObject({ state: "dispatched_unknown" });
    await expect(h.store().getWorkflowWorkItem(
      campaign.parkedWorkItem.id,
    )).resolves.toMatchObject({
      state: "manual-required",
      lastError: "crash-cut:provider-cli:uncertain-effect",
    });
  });
});
