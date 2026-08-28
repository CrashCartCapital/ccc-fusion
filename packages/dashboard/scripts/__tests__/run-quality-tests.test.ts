// @vitest-environment node

import { describe, expect, it } from "vitest";

interface QualityLane {
  name: string;
  group: "app" | "api";
  args: string[];
}

interface LaneResult {
  lane: QualityLane;
  ok: boolean;
  code?: number;
  signal?: NodeJS.Signals;
}

interface RunQualityTestsModule {
  qualityLanes: QualityLane[];
  resolveConcurrency(env?: Record<string, string | undefined>): number;
  createLaneEnv(env?: Record<string, string | undefined>): Record<string, string | undefined>;
  runQualityTests(options?: {
    group?: "all" | "app" | "api";
    concurrency?: number;
    lanes?: QualityLane[];
    runner?: (lane: QualityLane) => Promise<LaneResult>;
  }): Promise<{ ok: boolean; failed: LaneResult[]; completed: number; skipped: number }>;
}

async function loadModule(): Promise<RunQualityTestsModule> {
  return (await import("../run-quality-tests.mjs")) as RunQualityTestsModule;
}

function lane(name: string): QualityLane {
  return { name, group: "app", args: ["--heap=6144", "run", "--project", name] };
}

describe("dashboard quality orchestrator", () => {
  it("clamps dashboard quality concurrency to the safe bound", async () => {
    const { resolveConcurrency } = await loadModule();

    expect(resolveConcurrency({})).toBe(2);
    expect(resolveConcurrency({ FUSION_DASHBOARD_TEST_CONCURRENCY: "1" })).toBe(1);
    expect(resolveConcurrency({ FUSION_DASHBOARD_TEST_CONCURRENCY: "5" })).toBe(2);
    expect(resolveConcurrency({ FUSION_DASHBOARD_TEST_CONCURRENCY: "not-a-number" })).toBe(2);
  });

  it("caps Vitest workers only for serial dashboard runs and preserves overrides", async () => {
    const { createLaneEnv } = await loadModule();

    expect(createLaneEnv({ FUSION_DASHBOARD_TEST_CONCURRENCY: "1" }).VITEST_MAX_WORKERS).toBe("1");
    expect(
      createLaneEnv({ FUSION_DASHBOARD_TEST_CONCURRENCY: "1", VITEST_MAX_WORKERS: "4" }).VITEST_MAX_WORKERS,
    ).toBe("4");
    expect(createLaneEnv({ FUSION_DASHBOARD_TEST_CONCURRENCY: "2" }).VITEST_MAX_WORKERS).toBeUndefined();
    expect(createLaneEnv({}).VITEST_MAX_WORKERS).toBeUndefined();
  });

  it("runs only up to the configured concurrency and does not invoke artifact bootstrap per lane", async () => {
    const { runQualityTests } = await loadModule();
    const lanes = [lane("one"), lane("two"), lane("three")];
    const running = new Set<string>();
    let maxRunning = 0;
    const launched: string[] = [];

    const result = await runQualityTests({
      lanes,
      concurrency: 2,
      runner: async (qualityLane) => {
        launched.push(qualityLane.name);
        expect(qualityLane.args.join(" ")).not.toContain("ensure-test-artifacts");
        running.add(qualityLane.name);
        maxRunning = Math.max(maxRunning, running.size);
        await Promise.resolve();
        running.delete(qualityLane.name);
        return { lane: qualityLane, ok: true };
      },
    });

    expect(result).toMatchObject({ ok: true, completed: 3, skipped: 0 });
    expect(result.failed).toEqual([]);
    expect(launched).toEqual(["one", "two", "three"]);
    expect(maxRunning).toBeLessThanOrEqual(2);
  });

  it("stops scheduling new lanes after a failed lane", async () => {
    const { runQualityTests } = await loadModule();
    const lanes = [lane("one"), lane("two"), lane("three")];
    const launched: string[] = [];

    const result = await runQualityTests({
      lanes,
      concurrency: 1,
      runner: async (qualityLane) => {
        launched.push(qualityLane.name);
        return { lane: qualityLane, ok: qualityLane.name !== "two", code: qualityLane.name === "two" ? 1 : 0 };
      },
    });

    expect(result.ok).toBe(false);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].lane.name).toBe("two");
    expect(result.skipped).toBe(1);
    expect(launched).toEqual(["one", "two"]);
  });

  it("treats signal-terminated lanes as failed", async () => {
    const { runQualityTests } = await loadModule();
    const killedLane = lane("killed");

    const result = await runQualityTests({
      lanes: [killedLane],
      concurrency: 2,
      runner: async (qualityLane) => ({ lane: qualityLane, ok: false, signal: "SIGKILL" }),
    });

    expect(result.ok).toBe(false);
    expect(result.failed).toEqual([{ lane: killedLane, ok: false, signal: "SIGKILL" }]);
    expect(result.completed).toBe(1);
    expect(result.skipped).toBe(0);
  });
});
