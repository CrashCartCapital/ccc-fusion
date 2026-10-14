// @vitest-environment node

/*
FNXC:CustomProviders 2026-10-14-06:55:
Request-to-code v3 card C6b (PRD §8, D27). A custom provider can opt out of catalog sync with `modelSync: "disabled"` so an exact, operator-pinned model list survives the serve-start refresh. The trap this closes: `fn serve` runs refreshAllCustomProviderModels after listen, which appends the whole `/models` catalog to every provider and rewrites discovered rows to bare `{id, name}`, so a one-model pin silently turns into a catalog.

Every opt-out assertion has a control provider (no `modelSync`) in the same test that is merged with the same fake catalog. Without the control, "the pinned row did not change" could pass simply because the fake catalog was never served.
*/

import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CustomProvider, GlobalSettings, TaskStore } from "@fusion/core";
import { createApiRoutes } from "../../routes.js";
import { request as performRequest } from "../../test-request.js";
import { refreshAllCustomProviderModels } from "../register-custom-provider-routes.js";

const { mockInvalidateAllGlobalSettingsCaches } = vi.hoisted(() => ({
  mockInvalidateAllGlobalSettingsCaches: vi.fn(),
}));
vi.mock("../../project-store-resolver.js", async () => {
  const actual = await vi.importActual<typeof import("../../project-store-resolver.js")>("../../project-store-resolver.js");
  return {
    ...actual,
    invalidateAllGlobalSettingsCaches: mockInvalidateAllGlobalSettingsCaches,
  };
});

const PINNED_BASE_URL = "http://127.0.0.1:20128/v1";
const CONTROL_BASE_URL = "http://127.0.0.1:20129/v1";

/** The fake catalog: three chat models, one of which collides with the pinned model id. */
const FAKE_CATALOG = [
  { id: "glm/glm-5.3", name: "GLM 5.3" },
  { id: "glm/glm-5.3-flash", name: "GLM 5.3 Flash" },
  { id: "minimax/MiniMax-M3", name: "MiniMax M3 (catalog alias)" },
];

function pinnedProvider(): CustomProvider {
  return {
    id: "pin-m3",
    name: "OmniRoute MiniMax M3 pinned",
    apiType: "openai-compatible",
    baseUrl: PINNED_BASE_URL,
    modelSync: "disabled",
    headers: { "X-OmniRoute-No-Cache": "true" },
    models: [
      {
        id: "minimax/MiniMax-M3",
        name: "MiniMax M3 pinned",
        reasoning: true,
        maxTokens: 32768,
        contextWindow: 262144,
        verbatimCapable: true,
      },
    ],
  };
}

function controlProvider(): CustomProvider {
  return {
    id: "ctl-open",
    name: "OmniRoute control (sync enabled)",
    apiType: "openai-compatible",
    baseUrl: CONTROL_BASE_URL,
    models: [{ id: "control/authored", name: "Control authored" }],
  };
}

/** Installs a fake `fetch` that serves FAKE_CATALOG at `<baseUrl>/models` and records every URL requested. */
function stubFakeModelsEndpoint(): { requestedUrls: string[] } {
  const requestedUrls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      requestedUrls.push(String(url));
      return { ok: true, json: async () => ({ data: FAKE_CATALOG }) };
    }),
  );
  return { requestedUrls };
}

function createMockStore(settings: GlobalSettings, onUpdate: (patch: Partial<GlobalSettings>) => void): TaskStore {
  const globalSettingsStore = {
    getSettings: vi.fn(async () => settings),
    updateSettings: vi.fn(),
    getSettingsPath: vi.fn(),
    init: vi.fn(),
    invalidateCache: vi.fn(),
  };
  return {
    getSettings: vi.fn().mockResolvedValue({}),
    getSettingsFast: vi.fn().mockResolvedValue({}),
    updateSettings: vi.fn(),
    updateGlobalSettings: vi.fn(async (patch: Partial<GlobalSettings>) => {
      onUpdate(patch);
      Object.assign(settings, patch);
      return settings;
    }),
    getSettingsByScope: vi.fn().mockResolvedValue({ global: settings, project: {} }),
    getSettingsByScopeFast: vi.fn().mockResolvedValue({ global: settings, project: {} }),
    getGlobalSettingsStore: vi.fn(() => globalSettingsStore),
    listTasks: vi.fn().mockResolvedValue([]),
    getRootDir: vi.fn().mockReturnValue("/fake/root"),
    getFusionDir: vi.fn().mockReturnValue("/fake/root/.fusion"),
  } as unknown as TaskStore;
}

async function REQUEST(
  app: express.Express,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const res = await performRequest(
    app,
    method,
    path,
    payload,
    body === undefined ? undefined : { "Content-Type": "application/json" },
  );
  return { status: res.status, body: res.body };
}

function createApp(store: TaskStore): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/api", createApiRoutes(store));
  return app;
}

describe("custom provider modelSync opt-out", () => {
  let settings: GlobalSettings;
  let updates: Array<Partial<GlobalSettings>>;
  let store: TaskStore;

  beforeEach(() => {
    settings = {};
    updates = [];
    store = createMockStore(settings, (patch) => updates.push(patch));
    mockInvalidateAllGlobalSettingsCaches.mockReset();
    vi.unstubAllGlobals();
  });

  describe("refresh-all (serve-start and Settings refresh)", () => {
    it("leaves an opt-out provider byte-identical, counts it as skipped, and never probes its endpoint", async () => {
      settings.customProviders = [pinnedProvider(), controlProvider()];
      const pinnedBefore = JSON.stringify(settings.customProviders[0]);
      const fake = stubFakeModelsEndpoint();
      const logs: string[] = [];

      const result = await refreshAllCustomProviderModels(store, (message) => logs.push(message));

      expect(result).toEqual({ refreshed: 1, failed: 0, skipped: 1 });
      expect(JSON.stringify(settings.customProviders?.[0])).toBe(pinnedBefore);
      expect(fake.requestedUrls).toEqual([`${CONTROL_BASE_URL}/models`]);
      expect(logs.some((line) => line.includes("pin-m3"))).toBe(true);

      // Non-vacuous control: the same fake catalog really is served and merged for the provider without the field.
      const controlModelIds = (settings.customProviders?.[1]?.models ?? []).map((model) => model.id);
      expect(controlModelIds).toEqual(["control/authored", "glm/glm-5.3", "glm/glm-5.3-flash", "minimax/MiniMax-M3"]);
    });

    it("writes nothing and invalidates no cache when every provider opts out", async () => {
      settings.customProviders = [pinnedProvider()];
      const pinnedBefore = JSON.stringify(settings.customProviders[0]);
      const fake = stubFakeModelsEndpoint();

      const result = await refreshAllCustomProviderModels(store, () => undefined);

      expect(result).toEqual({ refreshed: 0, failed: 0, skipped: 1 });
      expect(fake.requestedUrls).toEqual([]);
      expect(updates).toEqual([]);
      expect(mockInvalidateAllGlobalSettingsCaches).not.toHaveBeenCalled();
      expect(JSON.stringify(settings.customProviders?.[0])).toBe(pinnedBefore);
    });

    it("does not treat any value other than the literal \"disabled\" as an opt-out", async () => {
      // A hand-edited settings.json can hold anything. Only the exact opt-out token may suppress a refresh.
      settings.customProviders = [
        { ...controlProvider(), modelSync: "enabled" } as unknown as CustomProvider,
      ];
      stubFakeModelsEndpoint();

      const result = await refreshAllCustomProviderModels(store, () => undefined);

      expect(result).toEqual({ refreshed: 1, failed: 0, skipped: 0 });
    });
  });

  describe("single-provider refresh route", () => {
    it("returns 409 for an opt-out provider without probing or writing, while the control refreshes", async () => {
      settings.customProviders = [pinnedProvider(), controlProvider()];
      const pinnedBefore = JSON.stringify(settings.customProviders[0]);
      const fake = stubFakeModelsEndpoint();
      const app = createApp(store);

      const refused = await REQUEST(app, "POST", "/api/custom-providers/pin-m3/refresh-models");

      expect(refused.status).toBe(409);
      expect(refused.body.error).toContain("model sync is disabled");
      expect(fake.requestedUrls).toEqual([]);
      expect(updates).toEqual([]);
      expect(JSON.stringify(settings.customProviders?.[0])).toBe(pinnedBefore);

      // Non-vacuous control: the same route refreshes a provider without the field from the same fake catalog.
      const refreshed = await REQUEST(app, "POST", "/api/custom-providers/ctl-open/refresh-models");

      expect(refreshed.status).toBe(200);
      expect(refreshed.body.modelsRefreshed).toBe(3);
      expect(fake.requestedUrls).toEqual([`${CONTROL_BASE_URL}/models`]);
    });

    it("refuses to persist a catalog when the provider opts out while the probe is in flight", async () => {
      settings.customProviders = [controlProvider()];
      const app = createApp(store);
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          // The operator pins the provider after the probe started but before the merge is written.
          settings.customProviders = [{ ...controlProvider(), modelSync: "disabled" }];
          return { ok: true, json: async () => ({ data: FAKE_CATALOG }) };
        }),
      );
      const pinnedAfterToggle = JSON.stringify({ ...controlProvider(), modelSync: "disabled" });

      const res = await REQUEST(app, "POST", "/api/custom-providers/ctl-open/refresh-models");

      expect(res.status).toBe(409);
      expect(updates).toEqual([]);
      expect(JSON.stringify(settings.customProviders?.[0])).toBe(pinnedAfterToggle);
    });
  });

  describe("create and update parsers carry the field", () => {
    it("POST persists and echoes modelSync: \"disabled\"; a body without it stays without it", async () => {
      const app = createApp(store);

      const created = await REQUEST(app, "POST", "/api/custom-providers", {
        name: "Pinned via API",
        apiType: "openai-compatible",
        baseUrl: PINNED_BASE_URL,
        modelSync: "disabled",
        models: [{ id: "minimax/MiniMax-M3", name: "MiniMax M3 pinned" }],
      });

      expect(created.status).toBe(201);
      expect(created.body.modelSync).toBe("disabled");
      const persisted = updates[0]?.customProviders as CustomProvider[];
      expect(persisted[0]?.modelSync).toBe("disabled");

      // Control: omitting the field must not invent one.
      const plain = await REQUEST(app, "POST", "/api/custom-providers", {
        name: "Plain via API",
        apiType: "openai-compatible",
        baseUrl: CONTROL_BASE_URL,
      });

      expect(plain.status).toBe(201);
      expect(plain.body).not.toHaveProperty("modelSync");
    });

    it("PUT keeps modelSync from the body and an unrelated edit does not erase a stored one", async () => {
      settings.customProviders = [controlProvider(), pinnedProvider()];
      const app = createApp(store);

      const optedOut = await REQUEST(app, "PUT", "/api/custom-providers/ctl-open", { modelSync: "disabled" });

      expect(optedOut.status).toBe(200);
      expect(optedOut.body.modelSync).toBe("disabled");
      expect(settings.customProviders?.[0]?.modelSync).toBe("disabled");

      // A rename on an already-pinned provider (a partial body without the field) must leave the pin in place.
      const renamed = await REQUEST(app, "PUT", "/api/custom-providers/pin-m3", { name: "Renamed pin" });

      expect(renamed.status).toBe(200);
      expect(renamed.body.modelSync).toBe("disabled");
      expect(settings.customProviders?.[1]?.modelSync).toBe("disabled");
      expect(settings.customProviders?.[1]?.name).toBe("Renamed pin");
    });

    it.each([
      ["POST", "/api/custom-providers", { name: "Bad", apiType: "openai-compatible", baseUrl: PINNED_BASE_URL }],
      ["PUT", "/api/custom-providers/ctl-open", {}],
    ] as const)("%s rejects a modelSync value other than \"disabled\"", async (method, path, base) => {
      settings.customProviders = [controlProvider()];
      const app = createApp(store);

      for (const bad of ["enabled", true, 1, null, ""]) {
        const res = await REQUEST(app, method, path, { ...base, modelSync: bad });

        expect(res.status, `modelSync=${JSON.stringify(bad)}`).toBe(400);
        expect(res.body.error).toContain("modelSync");
      }
      expect(updates).toEqual([]);
    });
  });
});
