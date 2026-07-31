import { describe, expect, it } from "vitest";
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
