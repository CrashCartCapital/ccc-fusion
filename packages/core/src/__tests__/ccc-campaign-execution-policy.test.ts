import { describe, expect, it } from "vitest";
import {
  createCccPrdProductExecutionPlan,
  parseCccPrdProductExecutionPlan,
} from "../ccc-campaign/index.js";
import {
  createCccPrdImportTestBundle,
  createCccPrdImportTestExecutionPolicy,
} from "../__test-utils__/ccc-prd-import-fixture.js";
import {
  parseCccCampaignExecutionPolicy,
  parseCccCampaignProductExecutionPolicy,
} from "../ccc-campaign/index.js";

const targetRoot = "/tmp/ccc-fusion-product-policy";

function bundle() {
  return createCccPrdImportTestBundle(targetRoot, "product-policy");
}

function productPolicy() {
  const semanticBundle = bundle();
  return {
    schema: "ccc-campaign.execution-policy.v2",
    routes: semanticBundle.tasks.map((task, index) => ({
      taskId: task.id,
      providerId: "deterministic-fake",
      modelId: "fixture-v2",
      transport: "pi",
      executor: "model",
      toolMode: "coding",
      worktreeMode: "isolated",
      ownedPaths: [`src/task-${index}`],
      allowedWriteRoots: [`src/task-${index}`],
      commitPolicy: "required",
    })),
  };
}

describe("CCC PRD product execution-plan generation", () => {
  it("generates a hash-bound product execution plan from source-owned task custody", () => {
    const semanticBundle = bundle();
    const custodiedBundle = {
      ...semanticBundle,
      tasks: semanticBundle.tasks.map((task, index) => ({
        ...task,
        ownedPaths: ["src/task-" + index],
        allowedWriteRoots: ["src/task-" + index],
      })),
    };
    expect(createCccPrdProductExecutionPlan({
      bundle: custodiedBundle,
      route: {
        providerId: "deterministic-fake",
        modelId: "fixture-v2",
        transport: "pi",
      },
    })).toEqual({
      schema: "ccc-prd.execution-plan.v1",
      packetHash: custodiedBundle.sourceHash,
      sidecarHash: custodiedBundle.sidecarHash,
      bundleHash: custodiedBundle.bundleHash,
      policy: {
        schema: "ccc-campaign.execution-policy.v2",
        routes: custodiedBundle.tasks.map((task) => ({
          taskId: task.id,
          providerId: "deterministic-fake",
          modelId: "fixture-v2",
          transport: "pi",
          executor: "model",
          toolMode: "coding",
          worktreeMode: "isolated",
          ownedPaths: task.ownedPaths,
          allowedWriteRoots: task.allowedWriteRoots,
          commitPolicy: "required",
        })),
      },
    });
  });

  it("refuses an execution plan whose semantic bindings are stale", () => {
    const semanticBundle = bundle();
    const custodiedBundle = {
      ...semanticBundle,
      tasks: semanticBundle.tasks.map((task, index) => ({
        ...task,
        ownedPaths: ["src/task-" + index],
        allowedWriteRoots: ["src/task-" + index],
      })),
    };
    const plan = createCccPrdProductExecutionPlan({
      bundle: custodiedBundle,
      route: {
        providerId: "deterministic-fake",
        modelId: "fixture-v2",
        transport: "pi",
      },
    });
    expect(parseCccPrdProductExecutionPlan(plan, custodiedBundle)).toEqual(plan);
    expect(() => parseCccPrdProductExecutionPlan({
      ...plan,
      sidecarHash: "d".repeat(64),
    }, custodiedBundle)).toThrow(/sidecar hash does not match/);
  });
});

describe("CCC campaign execution-policy v2", () => {
  it("accepts and canonicalizes a complete coding route for every semantic task", () => {
    expect(parseCccCampaignProductExecutionPolicy(productPolicy(), bundle())).toEqual(productPolicy());
  });

  it("keeps v1 parseable as legacy but refuses it for the supported product route", () => {
    const semanticBundle = bundle();
    const legacy = createCccPrdImportTestExecutionPolicy(semanticBundle);

    expect(parseCccCampaignExecutionPolicy(legacy, semanticBundle)).toEqual(legacy);
    expect(() => parseCccCampaignProductExecutionPolicy(legacy, semanticBundle))
      .toThrow(/product import requires ccc-campaign\.execution-policy\.v2/);
  });

  it.each([
    {
      label: "read-only tools",
      mutate: (policy: ReturnType<typeof productPolicy>) => ({
        ...policy,
        routes: policy.routes.map((route, index) => index === 0
          ? { ...route, toolMode: "readonly" }
          : route),
      }),
      error: /toolMode must be coding/,
    },
    {
      label: "shared checkout",
      mutate: (policy: ReturnType<typeof productPolicy>) => ({
        ...policy,
        routes: policy.routes.map((route, index) => index === 0
          ? { ...route, worktreeMode: "shared" }
          : route),
      }),
      error: /worktreeMode must be isolated/,
    },
    {
      label: "target escape",
      mutate: (policy: ReturnType<typeof productPolicy>) => ({
        ...policy,
        routes: policy.routes.map((route, index) => index === 0
          ? { ...route, ownedPaths: ["../outside"] }
          : route),
      }),
      error: /ownedPaths.*canonical target-relative/,
    },
    {
      label: "transport/executor mismatch",
      mutate: (policy: ReturnType<typeof productPolicy>) => ({
        ...policy,
        routes: policy.routes.map((route, index) => index === 0
          ? { ...route, executor: "cli-agent" }
          : route),
      }),
      error: /pi transport requires executor model/,
    },
    {
      label: "unknown field",
      mutate: (policy: ReturnType<typeof productPolicy>) => ({
        ...policy,
        routes: policy.routes.map((route, index) => index === 0
          ? { ...route, surprise: true }
          : route),
      }),
      error: /fields must be exactly/,
    },
  ])("refuses $label", ({ mutate, error }) => {
    expect(() => parseCccCampaignProductExecutionPolicy(mutate(productPolicy()), bundle()))
      .toThrow(error);
  });

  it("refuses overlapping ownership between concurrently runnable tasks", () => {
    const semanticBundle = bundle();
    const concurrentBundle = {
      ...semanticBundle,
      tasks: semanticBundle.tasks.map((task) => ({
        ...task,
        dependencyTaskIds: [],
      })),
    };
    const policy = productPolicy();
    const overlapping = {
      ...policy,
      routes: policy.routes.map((route) => ({
        ...route,
        ownedPaths: ["src/shared"],
        allowedWriteRoots: ["src/shared"],
      })),
    };

    expect(() => parseCccCampaignProductExecutionPolicy(overlapping, concurrentBundle))
      .toThrow(/concurrently runnable tasks.*overlapping ownership/);
  });
});
