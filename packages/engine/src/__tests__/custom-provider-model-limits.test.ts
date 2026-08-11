import { describe, expect, it } from "vitest";
import {
  buildCustomProviderModels,
  resolveCustomProviderModelLimits,
  type CustomProviderModelLimits,
} from "../custom-provider-registry.js";
import type { CustomProvider } from "@fusion/core";

/*
Stage 4 finding (2026-08-02): every custom-provider model was hardcoded to
maxTokens 16384 / contextWindow 128000, so a real PRD understanding run against
a local model with a 65k window either truncated ("length: incomplete
response") or advertised a window the backend does not have. These tests pin
the per-model override path and the fallback defaults.
*/

function provider(models: CustomProvider["models"]): CustomProvider {
  return {
    id: "p-1",
    name: "Local",
    apiType: "openai-compatible",
    baseUrl: "http://127.0.0.1:8000/v1",
    models,
  };
}

describe("buildCustomProviderModels per-model limits", () => {
  it("keeps the historical defaults when a model declares no limits", () => {
    const [model] = buildCustomProviderModels(provider([{ id: "m", name: "m" }]), "openai-completions");
    expect(model).toMatchObject({ maxTokens: 16384, contextWindow: 128000 });
  });

  it("honors declared per-model maxTokens and contextWindow", () => {
    const [model] = buildCustomProviderModels(
      provider([{ id: "m", name: "m", maxTokens: 32768, contextWindow: 65536 }]),
      "openai-completions",
    );
    expect(model).toMatchObject({ maxTokens: 32768, contextWindow: 65536 });
  });

  it("applies limits independently per model entry", () => {
    const models = buildCustomProviderModels(
      provider([
        { id: "big", name: "big", maxTokens: 32768, contextWindow: 262144 },
        { id: "plain", name: "plain" },
      ]),
      "openai-completions",
    );
    expect(models[0]).toMatchObject({ maxTokens: 32768, contextWindow: 262144 });
    expect(models[1]).toMatchObject({ maxTokens: 16384, contextWindow: 128000 });
  });

  it("falls back to defaults for non-positive or non-integer declared limits", () => {
    const cases: Array<[unknown, unknown]> = [
      [0, 0],
      [-5, -1],
      [1.5, 2.5],
      ["32768", "65536"],
      [Number.NaN, Number.POSITIVE_INFINITY],
    ];
    for (const [maxTokens, contextWindow] of cases) {
      const [model] = buildCustomProviderModels(
        provider([{ id: "m", name: "m", maxTokens, contextWindow } as never]),
        "openai-completions",
      );
      expect(model, `maxTokens=${String(maxTokens)}`).toMatchObject({
        maxTokens: 16384,
        contextWindow: 128000,
      });
    }
  });
});

describe("resolveCustomProviderModelLimits", () => {
  const providers: CustomProvider[] = [
    {
      id: "first",
      name: "Local",
      apiType: "openai-compatible",
      baseUrl: "http://127.0.0.1:8000/v1",
      models: [{ id: "plain", name: "Plain" }],
    },
    {
      id: "second",
      name: "Local",
      apiType: "openai-compatible",
      baseUrl: "http://127.0.0.1:8001/v1",
      models: [{ id: "big", name: "Big", maxTokens: 32768, contextWindow: 65536 }],
    },
  ];

  it("returns declared positive-safe-integer model limits", () => {
    const limits: CustomProviderModelLimits = resolveCustomProviderModelLimits("local-2", "big", providers);

    expect(limits).toEqual({ contextWindow: 65536, maxTokens: 32768 });
  });

  it("returns the existing fallback limits for models without declared limits", () => {
    expect(resolveCustomProviderModelLimits("local", "plain", providers)).toEqual({
      contextWindow: 128000,
      maxTokens: 16384,
    });
  });

  it("resolves providers by the exact custom-provider registry key, including duplicate-name suffixes", () => {
    expect(() => resolveCustomProviderModelLimits("local", "big", providers)).toThrow(
      'CCC custom provider model is not configured: local/big',
    );
    expect(resolveCustomProviderModelLimits("local-2", "big", providers)).toEqual({
      contextWindow: 65536,
      maxTokens: 32768,
    });
  });

  it("throws a clear non-secret error when the provider or model is missing", () => {
    expect(() => resolveCustomProviderModelLimits("missing", "big", providers)).toThrow(
      'CCC custom provider is not configured: missing',
    );
    expect(() => resolveCustomProviderModelLimits("local", "missing", providers)).toThrow(
      'CCC custom provider model is not configured: local/missing',
    );
  });
});
