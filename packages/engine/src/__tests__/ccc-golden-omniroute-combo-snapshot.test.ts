import { describe, expect, it } from "vitest";
import {
  parseGoldenOmniRouteComboSnapshot,
  sealGoldenOmniRouteComboSnapshot,
} from "./helpers/ccc-golden-omniroute-combo-snapshot.js";

const response = {
  combos: [
    {
      id: "combo-mini",
      name: "minimax-latest",
      version: 2,
      updatedAt: "2026-08-30T00:00:00.000Z",
      strategy: "priority",
      config: { maxRetries: 1 },
      models: [
        { id: "mini-direct", kind: "model", model: "minimax/MiniMax-M3", providerId: "minimax" },
      ],
    },
    {
      id: "combo-glm",
      name: "glm-latest",
      version: 2,
      updatedAt: "2026-08-30T00:00:00.000Z",
      strategy: "priority",
      config: {},
      models: [
        { id: "glm-direct", kind: "model", model: "glm/glm-5.3", providerId: "glm" },
        { id: "glm-fallback", kind: "combo-ref", comboName: "minimax-latest" },
      ],
    },
  ],
};

describe("CCC golden OmniRoute combo snapshot", () => {
  it("seals a recursive alias closure with stable exact terminal members", () => {
    expect(sealGoldenOmniRouteComboSnapshot(response, "glm-latest")).toEqual({
      alias: "glm-latest",
      comboId: "combo-glm",
      version: 2,
      updatedAt: "2026-08-30T00:00:00.000Z",
      terminalRouteMembers: [
        { provider: "glm", model: "glm-5.3" },
        { provider: "minimax", model: "MiniMax-M3" },
      ],
      sourceDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
  });

  it.each([
    ["missing alias", { combos: [] }, "minimax-latest", /not found/u],
    ["missing nested alias", {
      combos: [{ ...response.combos[1], models: [{ id: "missing", kind: "combo-ref", comboName: "absent" }] }],
    }, "glm-latest", /absent.*not found/u],
    ["cycle", {
      combos: [
        { ...response.combos[0], models: [{ id: "to-glm", kind: "combo-ref", comboName: "glm-latest" }] },
        { ...response.combos[1], models: [{ id: "to-mini", kind: "combo-ref", comboName: "minimax-latest" }] },
      ],
    }, "glm-latest", /cycle/u],
    ["Luna member", {
      combos: [{
        ...response.combos[0],
        models: [{ id: "luna", kind: "model", model: "cx/gpt-5.6-luna-max", providerId: "cx" }],
      }],
    }, "minimax-latest", /Luna.*forbidden/u],
  ])("refuses %s instead of producing an ambiguous receipt policy", (_label, payload, alias, error) => {
    expect(() => sealGoldenOmniRouteComboSnapshot(payload, alias))
      .toThrow(error);
  });

  it("deduplicates repeated terminal members while sealing the live closure", () => {
    const repeated = {
      combos: [{
        ...response.combos[0],
        models: [
          { id: "a", kind: "model", model: "minimax/MiniMax-M3", providerId: "minimax" },
          { id: "b", kind: "model", model: "minimax/MiniMax-M3", providerId: "minimax" },
        ],
      }],
    };
    expect(sealGoldenOmniRouteComboSnapshot(repeated, "minimax-latest").terminalRouteMembers)
      .toEqual([{ provider: "minimax", model: "MiniMax-M3" }]);
  });

  it("revalidates a sanitized preflight snapshot without carrying credentials into the worker", () => {
    const sealed = sealGoldenOmniRouteComboSnapshot(response, "glm-latest");
    expect(parseGoldenOmniRouteComboSnapshot(JSON.stringify(sealed), "glm-latest")).toEqual(sealed);
    expect(() => parseGoldenOmniRouteComboSnapshot(JSON.stringify({
      ...sealed,
      terminalRouteMembers: [{ provider: "cx", model: "gpt-5.6-luna-max" }],
    }), "glm-latest")).toThrow(/Luna.*forbidden/u);
    expect(() => parseGoldenOmniRouteComboSnapshot(JSON.stringify({
      ...sealed,
      terminalRouteMembers: [{ provider: "glm", model: "glm-other" }],
    }), "glm-latest")).toThrow(/digest.*does not match/u);
    expect(() => parseGoldenOmniRouteComboSnapshot(JSON.stringify(sealed), "minimax-latest"))
      .toThrow(/alias.*does not match/u);
  });
});
