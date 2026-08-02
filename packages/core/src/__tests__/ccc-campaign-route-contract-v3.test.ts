import { describe, expect, it } from "vitest";
import {
  parseCccCampaignProductExecutionPolicy,
  parseCccCampaignProductExecutionPolicyV3,
} from "../ccc-campaign/canonical.js";
import {
  CCC_CAMPAIGN_EXECUTION_POLICY_V2_SCHEMA_VERSION,
  CCC_CAMPAIGN_EXECUTION_POLICY_V3_SCHEMA_VERSION,
} from "../ccc-campaign/types.js";
import { createCccPrdImportTestBundle } from "../__test-utils__/ccc-prd-import-fixture.js";

const targetRoot = "/tmp/ccc-fusion-route-contract-v3";

function bundle(suffix = "route-v3") {
  return createCccPrdImportTestBundle(targetRoot, suffix);
}

function baseRouteFields(taskId: string, index: number) {
  return {
    taskId,
    providerId: "deterministic-fake",
    modelId: "fixture-v3",
    transport: "pi" as const,
    executor: "model" as const,
    toolMode: "coding" as const,
    worktreeMode: "isolated" as const,
    ownedPaths: [`src/task-${index}`],
    allowedWriteRoots: [`src/task-${index}`],
    commitPolicy: "required" as const,
    routeProfileId: "profile-standard",
    taskArchetype: "implementation",
    reasoningEffort: "medium" as const,
    serviceTier: "standard" as const,
    accessTier: "subscription" as const,
    sensitivityClass: "sanitized" as const,
    egressPolicy: { kind: "loopback-only" as const },
    limits: { maxRequests: 10, maxDurationMs: 60_000, maxConcurrency: 1 },
    fallbackPolicy: { kind: "forbidden" as const },
    catalogDigest: null as string | null,
    decidedAt: "2026-01-01T00:00:00.000Z",
  };
}

function policyV3(suffix = "route-v3") {
  const semanticBundle = bundle(suffix);
  return {
    schema: CCC_CAMPAIGN_EXECUTION_POLICY_V3_SCHEMA_VERSION,
    routes: semanticBundle.tasks.map((task, index) => baseRouteFields(task.id, index)),
  };
}

describe("CCC campaign execution-policy v3", () => {
  it("accepts a complete v3 coding route with routing-contract metadata for every task", () => {
    const policy = policyV3();
    expect(parseCccCampaignProductExecutionPolicyV3(policy, bundle())).toEqual(policy);
  });

  it.each([
    {
      label: "missing routeProfileId",
      mutate: (route: Record<string, unknown>) => {
        const { routeProfileId: _drop, ...rest } = route;
        return rest;
      },
      error: /routeProfileId/,
    },
    {
      label: "invalid reasoningEffort",
      mutate: (route: Record<string, unknown>) => ({ ...route, reasoningEffort: "ultra" }),
      error: /reasoningEffort/,
    },
    {
      label: "invalid serviceTier",
      mutate: (route: Record<string, unknown>) => ({ ...route, serviceTier: "vip" }),
      error: /serviceTier/,
    },
    {
      label: "invalid accessTier",
      mutate: (route: Record<string, unknown>) => ({ ...route, accessTier: "gold" }),
      error: /accessTier/,
    },
    {
      label: "invalid sensitivityClass",
      mutate: (route: Record<string, unknown>) => ({ ...route, sensitivityClass: "top-secret" }),
      error: /sensitivityClass/,
    },
    {
      label: "invalid egressPolicy kind",
      mutate: (route: Record<string, unknown>) => ({ ...route, egressPolicy: { kind: "open" } }),
      error: /egressPolicy/,
    },
    {
      label: "missing limits.maxRequests",
      mutate: (route: Record<string, unknown>) => ({
        ...route,
        limits: { maxDurationMs: 1000, maxConcurrency: 1 },
      }),
      error: /limits/,
    },
    {
      label: "non-integer limits.maxConcurrency",
      mutate: (route: Record<string, unknown>) => ({
        ...route,
        limits: { ...(route.limits as Record<string, unknown>), maxConcurrency: 1.5 },
      }),
      error: /limits\.maxConcurrency.*positive integer/,
    },
    {
      label: "fallbackPolicy ordered rejected",
      mutate: (route: Record<string, unknown>) => ({ ...route, fallbackPolicy: { kind: "ordered" } }),
      error: /not yet supported/,
    },
    {
      label: "invalid catalogDigest",
      mutate: (route: Record<string, unknown>) => ({ ...route, catalogDigest: "not-a-hash" }),
      error: /catalogDigest/,
    },
    {
      label: "invalid decidedAt",
      mutate: (route: Record<string, unknown>) => ({ ...route, decidedAt: "not-a-date" }),
      error: /decidedAt/,
    },
  ])("rejects $label naming the taskId and field", ({ mutate, error }) => {
    const policy = policyV3();
    const targetTaskId = policy.routes[0]!.taskId;
    const mutated = {
      ...policy,
      routes: policy.routes.map((route) => (route.taskId === targetTaskId ? mutate(route) : route)),
    };
    let thrown: unknown;
    try {
      parseCccCampaignProductExecutionPolicyV3(mutated, bundle());
    } catch (caught) {
      thrown = caught;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(error);
    expect((thrown as Error).message).toContain(targetTaskId);
  });

  it("rejects maxSpendUsd on a cli-transport route naming the enforceable caps", () => {
    const semanticBundle = bundle();
    const policy = policyV3();
    const cliTaskId = policy.routes[0]!.taskId;
    const mutated = {
      ...policy,
      routes: policy.routes.map((route) => (route.taskId === cliTaskId
        ? {
          ...route,
          transport: "cli" as const,
          executor: "cli-agent" as const,
          cliAdapterId: "adapter-1",
          limits: { ...route.limits, maxSpendUsd: 5 },
        }
        : route)),
    };
    let thrown: unknown;
    try {
      parseCccCampaignProductExecutionPolicyV3(mutated, semanticBundle);
    } catch (caught) {
      thrown = caught;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/maxSpendUsd/);
    expect((thrown as Error).message).toMatch(/forbidden/);
    expect((thrown as Error).message).toMatch(/maxRequests, maxDurationMs, maxConcurrency/);
  });

  it("fails closed when a v2 policy object is fed to the v3 parser (no silent backfill)", () => {
    const semanticBundle = bundle();
    const v2Policy = {
      schema: CCC_CAMPAIGN_EXECUTION_POLICY_V2_SCHEMA_VERSION,
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
    expect(() => parseCccCampaignProductExecutionPolicyV3(v2Policy, semanticBundle))
      .toThrow(/requires ccc-campaign\.execution-policy\.v3/);
    expect(() => parseCccCampaignProductExecutionPolicyV3(v2Policy, semanticBundle))
      .toThrow(/upgrade/i);
  });

  it("fails closed when a v3 policy object is fed to the v2 parser (unknown schema)", () => {
    const semanticBundle = bundle();
    const policy = policyV3();
    expect(() => parseCccCampaignProductExecutionPolicy(policy, semanticBundle))
      .toThrow(/product import requires ccc-campaign\.execution-policy\.v2/);
  });
});
