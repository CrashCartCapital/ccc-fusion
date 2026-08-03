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

function custodiedBundleFor(suffix: string) {
  const semanticBundle = createCccPrdImportTestBundle(targetRoot, suffix);
  return {
    ...semanticBundle,
    tasks: semanticBundle.tasks.map((task, index) => ({
      ...task,
      ownedPaths: ["src/task-" + index],
      allowedWriteRoots: ["src/task-" + index],
    })),
  };
}

describe("CCC PRD product execution-plan generation with per-task routing", () => {
  it("routes each task to its own provider/model/transport via routesByTaskId", () => {
    const custodiedBundle = custodiedBundleFor("per-task-a");
    const [taskA, taskB] = custodiedBundle.tasks;
    const plan = createCccPrdProductExecutionPlan({
      bundle: custodiedBundle,
      routesByTaskId: {
        [taskA!.id]: { providerId: "provider-x", modelId: "model-x", transport: "pi" },
        [taskB!.id]: {
          providerId: "provider-y",
          modelId: "model-y",
          transport: "cli",
          cliAdapterId: "adapter-y",
        },
      },
    });
    const routeA = plan.policy.routes.find((route) => route.taskId === taskA!.id)!;
    const routeB = plan.policy.routes.find((route) => route.taskId === taskB!.id)!;
    expect(routeA.providerId).toBe("provider-x");
    expect(routeA.modelId).toBe("model-x");
    expect(routeA.transport).toBe("pi");
    expect(routeB.providerId).toBe("provider-y");
    expect(routeB.modelId).toBe("model-y");
    expect(routeB.transport).toBe("cli");
    expect(routeB.cliAdapterId).toBe("adapter-y");
    expect(routeA.providerId).not.toBe(routeB.providerId);
  });

  it("fails closed when routesByTaskId is missing a task", () => {
    const custodiedBundle = custodiedBundleFor("per-task-missing");
    const [taskA] = custodiedBundle.tasks;
    expect(() => createCccPrdProductExecutionPlan({
      bundle: custodiedBundle,
      routesByTaskId: {
        [taskA!.id]: { providerId: "provider-x", modelId: "model-x", transport: "pi" },
      },
    })).toThrow(/routesByTaskId must bind every task exactly once/);
  });

  it("fails closed when routesByTaskId has an extra unknown taskId", () => {
    const custodiedBundle = custodiedBundleFor("per-task-extra");
    const routesByTaskId: Record<string, { providerId: string; modelId: string; transport: "pi" }> = {};
    for (const task of custodiedBundle.tasks) {
      routesByTaskId[task.id] = { providerId: "provider-x", modelId: "model-x", transport: "pi" };
    }
    routesByTaskId["TASK-does-not-exist"] = { providerId: "provider-x", modelId: "model-x", transport: "pi" };
    expect(() => createCccPrdProductExecutionPlan({
      bundle: custodiedBundle,
      routesByTaskId,
    })).toThrow(/routesByTaskId must bind every task exactly once/);
  });

  it("keeps the single-route fan-out unchanged when route is provided (compatibility pin)", () => {
    const custodiedBundle = custodiedBundleFor("per-task-compat");
    const plan = createCccPrdProductExecutionPlan({
      bundle: custodiedBundle,
      route: { providerId: "deterministic-fake", modelId: "fixture-v2", transport: "pi" },
    });
    expect(plan.policy.routes.every((route) =>
      route.providerId === "deterministic-fake" && route.modelId === "fixture-v2")).toBe(true);
  });

  it("fails closed when both route and routesByTaskId are provided", () => {
    const custodiedBundle = custodiedBundleFor("per-task-both");
    const [taskA] = custodiedBundle.tasks;
    expect(() => createCccPrdProductExecutionPlan({
      bundle: custodiedBundle,
      route: { providerId: "deterministic-fake", modelId: "fixture-v2", transport: "pi" },
      routesByTaskId: {
        [taskA!.id]: { providerId: "provider-x", modelId: "model-x", transport: "pi" },
      },
    } as never)).toThrow(/accepts exactly one of route or routesByTaskId/);
  });
});
