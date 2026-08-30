import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  GOLDEN_PI_DRIVERS,
  GOLDEN_PI_PROJECT_ENVELOPE,
  resolveGoldenPiDriver,
} from "./helpers/ccc-golden-pi-driver-matrix.js";

const liveFixtureUrl = new URL("./ccc-golden-evidence-ledger-pi.live.real-pg.test.ts", import.meta.url);

describe("CCC golden Pi driver matrix", () => {
  it("gives each direct model route the same bounded project envelope", () => {
    expect(GOLDEN_PI_PROJECT_ENVELOPE).toEqual({
      maxRequests: 14,
      maxDurationMs: 600_000,
      maxConcurrency: 1,
      contextWindow: 200_000,
      maxOutputTokens: 32_768,
      taskTokenBudget: { soft: 300_000, hard: 500_000 },
    });
    expect(GOLDEN_PI_DRIVERS.map(({ key, modelId }) => ({ key, modelId }))).toEqual([
      { key: "glm-5.3", modelId: "glm/glm-5.3" },
      { key: "gemini-flash-3.7", modelId: "antigravity/gemini-3.7-flash-high" },
      { key: "luna-max", modelId: "cx/gpt-5.6-luna-max" },
    ]);
    expect(new Set(GOLDEN_PI_DRIVERS.map(({ providerId }) => providerId)).size).toBe(3);
  });

  it("requires an explicit known driver key", () => {
    expect(resolveGoldenPiDriver("glm-5.3").modelId).toBe("glm/glm-5.3");
    expect(() => resolveGoldenPiDriver(undefined)).toThrow(/CCC_GOLDEN_PI_DRIVER must be one of/);
    expect(() => resolveGoldenPiDriver("auto")).toThrow(/CCC_GOLDEN_PI_DRIVER must be one of/);
  });

  it("uses the project-generation envelope and selects each peer through one sealed driver key", async () => {
    const source = await readFile(liveFixtureUrl, "utf8");

    expect(source).toContain("GOLDEN_PI_PROJECT_ENVELOPE");
    expect(source).toContain("resolveGoldenPiDriver");
    expect(source).toContain("CCC_GOLDEN_PI_DRIVER");
    expect(source).toContain("maxRequests: GOLDEN_PI_PROJECT_ENVELOPE.maxRequests");
    expect(source).toContain("maxDurationMs: GOLDEN_PI_PROJECT_ENVELOPE.maxDurationMs");
    expect(source).toContain("providerId: driver.providerId");
    expect(source).toContain("modelId: driver.modelId");
    expect(source).not.toContain('const providerId = "golden-omniroute-luna"');
    expect(source).not.toContain("maxRequests: 6");
    expect(source).not.toContain("maxDurationMs: 180_000");
  });
});
