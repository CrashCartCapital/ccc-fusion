import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createCccPrdProductExecutionPlan,
  parseCccCampaignProductExecutionPolicy,
} from "../ccc-campaign/index.js";
import { assertCccProviderAttemptEffectiveRoute } from "../ccc-campaign/provider-attempt.js";
import {
  createCccPrdImportTestBundle,
} from "../__test-utils__/ccc-prd-import-fixture.js";
import { nativeWorkflowIr } from "../ccc-prd/importer.js";
import { canonicalCccPrdJson } from "../ccc-prd/contract.js";
import type {
  CccProviderAttemptEffectiveRouteInput,
  CccPrdProductExecutionRouteSelection,
} from "../ccc-campaign/types.js";

const targetRoot = "/tmp/ccc-fusion-route-receipt-adapter";
const adapterId = "terminal-route-sse-comments.v1" as const;

function custodiedBundle() {
  const semanticBundle = createCccPrdImportTestBundle(targetRoot, "explicit-adapter");
  return {
    ...semanticBundle,
    tasks: semanticBundle.tasks.map((task, index) => ({
      ...task,
      ownedPaths: [`src/task-${index}`],
      allowedWriteRoots: [`src/task-${index}`],
    })),
  };
}

function policyWithAdapter(receiptAdapterId: string = adapterId) {
  const bundle = custodiedBundle();
  return {
    schema: "ccc-campaign.execution-policy.v2",
    routes: bundle.tasks.map((task) => ({
      taskId: task.id,
      providerId: "arbitrary-gateway",
      modelId: "upstream/model-a",
      transport: "pi",
      executor: "model",
      toolMode: "coding",
      worktreeMode: "isolated",
      ownedPaths: task.ownedPaths,
      allowedWriteRoots: task.allowedWriteRoots,
      commitPolicy: "required",
      receiptAdapterId,
    })),
  };
}

describe("CCC sealed route receipt adapter", () => {
  it("RED-RECEIPT-ROUTE-1: accepts an explicit adapter for an arbitrary provider and preserves it in canonical policy bytes", () => {
    const policy = policyWithAdapter();

    expect(parseCccCampaignProductExecutionPolicy(policy, custodiedBundle())).toEqual(policy);
  });

  it("RED-RECEIPT-ROUTE-2: rejects an unknown explicit adapter by adapter identity", () => {
    expect(() => parseCccCampaignProductExecutionPolicy(
      policyWithAdapter("unknown-adapter.v1"),
      custodiedBundle(),
    )).toThrow(/unsupported receipt adapter/u);
  });

  it("RED-RECEIPT-ROUTE-2B: rejects an adapter route whose upstream model identity cannot be reconciled", () => {
    const policy = policyWithAdapter();
    policy.routes[0]!.modelId = "unqualified-model";

    expect(() => parseCccCampaignProductExecutionPolicy(policy, custodiedBundle()))
      .toThrow(/provider-qualified model/u);
  });

  it("RED-RECEIPT-ROUTE-3: product plan generation carries the explicit adapter into every sealed route", () => {
    const bundle = custodiedBundle();
    const route = {
      providerId: "arbitrary-gateway",
      modelId: "upstream/model-a",
      transport: "pi",
      receiptAdapterId: adapterId,
    } as CccPrdProductExecutionRouteSelection & { receiptAdapterId: typeof adapterId };

    const plan = createCccPrdProductExecutionPlan({ bundle, route });

    expect(plan.policy.routes.every((candidate) =>
      (candidate as typeof candidate & { receiptAdapterId?: string }).receiptAdapterId === adapterId
    )).toBe(true);
  });

  it("RED-RECEIPT-ROUTE-3B: adapter selection changes the exact sealed route digest", () => {
    const withAdapter = parseCccCampaignProductExecutionPolicy(
      policyWithAdapter(),
      custodiedBundle(),
    ).routes[0]!;
    const withoutAdapter = { ...withAdapter } as typeof withAdapter & { receiptAdapterId?: string };
    delete withoutAdapter.receiptAdapterId;
    const digest = (route: unknown) => createHash("sha256")
      .update(canonicalCccPrdJson(route), "utf8")
      .digest("hex");

    expect(digest(withAdapter)).not.toBe(digest(withoutAdapter));
  });

  it("RED-RECEIPT-ROUTE-4: plan generation refuses rather than stripping an adapter from a CLI route", () => {
    const bundle = custodiedBundle();
    const route = {
      providerId: "local-cli",
      modelId: "cli-agent",
      transport: "cli",
      cliAdapterId: "test-cli",
      receiptAdapterId: adapterId,
    } as CccPrdProductExecutionRouteSelection;

    expect(() => createCccPrdProductExecutionPlan({ bundle, route }))
      .toThrow(/receiptAdapterId is forbidden for cli transport/u);
  });

  it("RED-RECEIPT-ROUTE-5: native workflow IR carries the sealed adapter beside the exact route digest", () => {
    const bundle = custodiedBundle();
    const plan = createCccPrdProductExecutionPlan({
      bundle,
      route: {
        providerId: "arbitrary-gateway",
        modelId: "upstream/model-a",
        transport: "pi",
        receiptAdapterId: adapterId,
      },
    });
    const workflow = bundle.workflows[0]!;
    const nativeTaskIds = new Map(
      workflow.taskIds.map((taskId, index) => [taskId, `FN-RECEIPT-${index}`]),
    );

    const ir = nativeWorkflowIr(bundle, workflow, plan.policy, nativeTaskIds);
    const promptNodes = ir.nodes.filter((node) => node.kind === "prompt");

    expect(promptNodes).toHaveLength(workflow.taskIds.length);
    expect(promptNodes.every((node) =>
      node.config?.cccExecutionReceiptAdapterId === adapterId
    )).toBe(true);
  });
});

describe("CCC provider-attempt receipt adapter selection", () => {
  const requestedIdentity = {
    providerId: "arbitrary-gateway",
    modelId: "upstream/model-a",
  };
  const input: CccProviderAttemptEffectiveRouteInput = {
    effectiveProvider: requestedIdentity.providerId,
    effectiveModel: requestedIdentity.modelId,
    usage: { inputTokens: 3, outputTokens: 5 },
    cost: { kind: "unknown", reason: "fixture" },
    receiptSource: "stream-usage",
  };

  it("RED-RECEIPT-ATTEMPT-1: explicit adapter requires a terminal receipt for an arbitrary provider", () => {
    expect(() => assertCccProviderAttemptEffectiveRoute(
      input,
      requestedIdentity,
      {
        receiptAdapterId: adapterId,
        terminalReceiptRequired: true,
      },
    )).toThrow(/requires a final terminal route receipt/u);
  });

  it("RED-RECEIPT-ATTEMPT-1B: explicit adapter accepts an exact terminal receipt for an arbitrary provider", () => {
    expect(assertCccProviderAttemptEffectiveRoute(
      {
        ...input,
        omniRoute: { final: { provider: "upstream", model: "model-a" } },
      },
      requestedIdentity,
      { receiptAdapterId: adapterId },
    )?.omniRoute).toEqual({ final: { provider: "upstream", model: "model-a" } });
  });

  it("RED-RECEIPT-ATTEMPT-1C: explicit adapter rejects a mismatched terminal receipt for an arbitrary provider", () => {
    expect(() => assertCccProviderAttemptEffectiveRoute(
      {
        ...input,
        omniRoute: { final: { provider: "other-upstream", model: "model-a" } },
      },
      requestedIdentity,
      { receiptAdapterId: adapterId },
    )).toThrow(/does not match the requested provider-qualified route/u);
  });

  it("RED-RECEIPT-ATTEMPT-1D: proved-failed settlement may retain partial usage without manufacturing a terminal receipt", () => {
    expect(assertCccProviderAttemptEffectiveRoute(
      input,
      requestedIdentity,
      {
        receiptAdapterId: adapterId,
        terminalReceiptRequired: false,
      },
    )).toMatchObject({ usage: { inputTokens: 3, outputTokens: 5 } });
  });

  it("RED-RECEIPT-ATTEMPT-2: provider branding alone never selects an adapter", () => {
    expect(assertCccProviderAttemptEffectiveRoute(
      {
        ...input,
        effectiveProvider: "omniroute-looking-but-unselected",
        omniRoute: {
          initial: { provider: "one", model: "model-a" },
          final: { provider: "two", model: "model-a" },
        },
      },
      {
        providerId: "omniroute-looking-but-unselected",
        modelId: "upstream/model-a",
      },
    )).toMatchObject({ effectiveProvider: "omniroute-looking-but-unselected" });
  });
});
