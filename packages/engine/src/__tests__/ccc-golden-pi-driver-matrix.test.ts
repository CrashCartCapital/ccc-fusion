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
      taskCount: 3,
      maxRequests: 1_152,
      maxDurationMs: 10_800_000,
      maxConcurrency: 1,
      contextWindow: 200_000,
      maxOutputTokens: 32_768,
      taskTokenBudget: { soft: 5_000_000, hard: 10_000_000 },
    });
    expect(GOLDEN_PI_DRIVERS.map(({ key, comboAlias, modelId, attributionTerminalRouteMembers }) => ({
      key,
      comboAlias,
      modelId,
      attributionTerminalRouteMembers,
    }))).toEqual([
      {
        key: "minimax-latest",
        comboAlias: "minimax-latest",
        modelId: "combo/minimax-latest",
        attributionTerminalRouteMembers: [{ provider: "minimax", model: "MiniMax-M3" }],
      },
      {
        key: "glm-latest",
        comboAlias: "glm-latest",
        modelId: "combo/glm-latest",
        attributionTerminalRouteMembers: [{ provider: "glm", model: "glm-5.3" }],
      },
      {
        key: "gemini-flash-latest",
        comboAlias: "gemini-flash-latest",
        modelId: "combo/gemini-flash-latest",
        attributionTerminalRouteMembers: [
          { provider: "antigravity", model: "gemini-3.8-flash-high" },
          { provider: "gemini", model: "gemini-flash-latest" },
        ],
      },
    ]);
    expect(new Set(GOLDEN_PI_DRIVERS.map(({ providerId }) => providerId)).size).toBe(3);
    expect(JSON.stringify(GOLDEN_PI_DRIVERS)).not.toMatch(/luna|cx\/|gpt-5\.6/u);
  });

  it("requires an explicit known driver key", () => {
    expect(resolveGoldenPiDriver("glm-latest").modelId).toBe("combo/glm-latest");
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
    expect(source).toContain("taskCount: GOLDEN_PI_PROJECT_ENVELOPE.taskCount");
    expect(source).toContain("providerId: driver.providerId");
    expect(source).toContain("modelId: driver.modelId");
    expect(source).toContain("terminalRouteMembers: comboSnapshot.terminalRouteMembers");
    expect(source).toContain("CCC_GOLDEN_PI_EVIDENCE_PATH");
    expect(source).toContain("persistEvidence");
    expect(source).toContain("attributionTerminalRouteMembers");
    expect(source).toContain("originalHome");
    expect(source).toContain("evidencePersistenceFailure");
    expect(source).toContain("taskOrder");
    expect(source).toContain("exactCandidateFiles");
    expect(source).toContain(".slice(-200)");
    expect(source.indexOf("comboSnapshot = parseGoldenOmniRouteComboSnapshot")).toBeLessThan(
      source.indexOf("lifecycle = await prepareLifecycle"),
    );
    expect(source.indexOf("lifecycle = await prepareLifecycle")).toBeLessThan(
      source.indexOf("isolatedHome = originalHome"),
    );
    expect(source).not.toContain("process.env.HOME = isolatedHome");
    expect(source).not.toMatch(/luna|maxRequests: 14|taskCount: 1/u);
    expect(source).not.toContain("maxRequests: 6");
    expect(source).not.toContain("maxDurationMs: 180_000");
  });
});
