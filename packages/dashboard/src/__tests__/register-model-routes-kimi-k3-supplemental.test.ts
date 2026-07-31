import type { Router } from "express";
import { describe, expect, it, vi } from "vitest";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { registerModelRoutes } from "../routes/register-model-routes.js";

/*
FNXC:ModelCatalog 2026-07-16-19:05:
FN-8180 requires Kimi K3 to reach both model-catalog consumers. This route-level
coverage reads pi 0.81.1's generated built-in catalog directly, so an SDK catalog
regression cannot leave the Dashboard dropdown missing K3 while the engine registry
test remains green. The engine suite separately proves ModelRuntime integration.
*/

function createNativeKimiRegistry(): ModelRegistry {
  const models = getBuiltinModels("kimi-coding");
  return {
    refresh: async () => undefined,
    getAvailable: () => models,
  } as unknown as ModelRegistry;
}

function createModelsHandler(modelRegistry: ModelRegistry) {
  const handlers = new Map<string, (req: unknown, res: { json: (body: unknown) => void }) => Promise<void>>();
  const router = {
    get: vi.fn((path: string, handler: (req: unknown, res: { json: (body: unknown) => void }) => Promise<void>) => {
      handlers.set(path, handler);
    }),
  } as unknown as Router;
  const authStorage = {
    reload: vi.fn(),
    getOAuthProviders: vi.fn(() => []),
    getApiKeyProviders: vi.fn(() => [{ id: "kimi-coding", name: "Kimi" }]),
    get: vi.fn(() => ({ type: "api_key", key: "test-kimi-key" })),
    hasApiKey: vi.fn((providerId: string) => providerId === "kimi-coding"),
    hasAuth: vi.fn((providerId: string) => providerId === "kimi-coding"),
  };

  registerModelRoutes({
    router,
    store: {
      getGlobalSettingsStore: () => ({ getSettings: vi.fn().mockResolvedValue({}) }),
      getSettingsFast: vi.fn().mockResolvedValue({}),
    } as never,
    runtimeLogger: { child: vi.fn(() => ({ warn: vi.fn() })) } as never,
    options: { modelRegistry, authStorage } as never,
  } as never);

  return handlers.get("/models")!;
}

describe("FN-8180: Kimi K3 /api/models catalog", () => {
  it("surfaces the native K3 model once for a configured Kimi provider", async () => {
    const handler = createModelsHandler(createNativeKimiRegistry());
    const json = vi.fn();

    await handler({}, { json });

    const response = json.mock.calls[0][0] as { models: Array<{ provider: string; id: string; name: string; reasoning: boolean; contextWindow: number }> };
    const k3Rows = response.models.filter((model) => model.provider === "kimi-coding" && model.id === "k3");
    expect(k3Rows).toEqual([{ provider: "kimi-coding", id: "k3", name: "Kimi K3", reasoning: true, contextWindow: 1_048_576 }]);
  });
});
