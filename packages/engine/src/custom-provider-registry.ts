/*
FNXC:ProviderAuth 2026-07-07-00:00:
FN-7622: relocated from packages/cli/src/commands/custom-provider-registry.ts into @fusion/engine
so the desktop in-process dashboard server and the CLI serve/dashboard/daemon paths share ONE
custom-provider registration implementation. packages/cli/src/commands/custom-provider-registry.ts
is now a thin re-export shim of this module; its observable behavior is unchanged.
*/
import { customProviderRegistryKey, type CustomProvider } from "@fusion/core";
import { refreshFusionModelRegistry, type RefreshableModelRegistry } from "./model-registry-refresh.js";
import { validateCccLoopbackHttpUrl } from "./ccc-loopback-policy.js";
import { readCustomProviders } from "./custom-providers.js";
import { getHomeDir } from "./auth-storage.js";

interface ModelRegistryLike extends RefreshableModelRegistry {
  registerProvider: (name: string, config: {
    baseUrl: string;
    api: string;
    apiKey?: string;
    /** FNXC:ProviderHeaders 2026-08-06-00:00: extra request headers; see toProviderConfig. */
    headers?: Record<string, string>;
    models: Array<{
      id: string;
      name: string;
      reasoning: boolean;
      input: ("text" | "image")[];
      cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
      contextWindow: number;
      maxTokens: number;
      compat?: {
        supportsDeveloperRole?: boolean;
        cacheControlFormat?: "anthropic";
      };
    }>;
  }) => void;
  refresh: () => unknown;
}

export type CustomProviderModelLimits = { contextWindow: number; maxTokens: number };

/*
FNXC:CustomProviders 2026-07-08-00:00:
FN-7690: resolveApiType() and pi.ts's resolveCustomProviderApiType() both translate a
custom provider's declared apiType into the api key handed to pi-ai's
ModelRegistry.registerProvider({ api }). Both call sites register into a REAL pi-ai
ModelRegistry (registerCustomProviders/reregisterCustomProviders below feed
seedDashboardProviders, used by desktop + CLI serve/dashboard/daemon), so every arm here
must return a key pi-ai's api-registry actually registers. `anthropic-compatible` resolves
to "anthropic-messages" — matching pi.ts's resolveCustomProviderApiType and the built-in
Anthropic provider config (packages/core/src/anthropic-models.ts, api: "anthropic-messages").
The bare "anthropic" key is never registered and throws "No API provider registered for
api: anthropic" the moment a task streams against it.
*/
export function resolveApiType(apiType: string): string {
  if (apiType === "anthropic-compatible") {
    return "anthropic-messages";
  }
  if (apiType === "openai-responses") {
    return "openai-responses";
  }
  return "openai-completions";
}

/**
 * FNXC:ProviderAuth 2026-07-08-00:00:
 * FN-7689: shared model-list builder used by BOTH custom-provider registration paths
 * (this module's `toProviderConfig` and pi.ts's `createFnAgent` inline registration) so the
 * `compat.cacheControlFormat` opt-in cannot drift between them again. `api` is the pi-ai
 * api-registry key resolved by each call site's own resolver — both `resolveApiType` here and
 * pi.ts's `resolveCustomProviderApiType` return `"anthropic-messages"` for the same
 * `anthropic-compatible` input (FN-7690 reconciled the earlier naming drift; the bare
 * `"anthropic"` key is never registered by pi-ai). Only `"openai-completions"` gets
 * `compat.cacheControlFormat` — pi-ai's
 * anthropic path already auto-caches without any flag, and `openai-responses` uses OpenAI's
 * native `prompt_cache_key`/`prompt_cache_retention` mechanism (no `cache_control` marker concept
 * per pi-ai's `OpenAIResponsesCompat`), so the opt-in is inert there by construction.
 */
export function buildCustomProviderModels(
  provider: CustomProvider,
  api: string,
): Array<{
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  compat?: { supportsDeveloperRole?: boolean; cacheControlFormat?: "anthropic" };
}> {
  const supportsDeveloperRole = provider.supportsDeveloperRole === true;
  const anthropicPromptCaching = provider.anthropicPromptCaching === true;

  // Settings JSON is hand-editable, so a declared limit is honored only when it
  // is a positive safe integer; anything else falls back to the historical
  // default rather than poisoning the registry with NaN or zero caps.
  const declaredLimit = (value: unknown, fallback: number): number =>
    typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;

  return (provider.models ?? []).map((model) => ({
    id: model.id,
    name: model.name,
    /*
     * FNXC:ProviderReasoning 2026-08-24-02:30:
     * pi-ai gates every reasoning branch on this flag, so hardcoding `false`
     * made reasoning unreachable for ALL custom gateways: a pinned reasoning
     * model ran as a plain chat model and no `reasoning_effort`/`thinking`
     * parameter was ever emitted. Honor only an explicit `true` so providers
     * configured before this field existed keep their exact registration.
     */
    reasoning: model.reasoning === true,
    input: ["text" as const],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: declaredLimit(model.contextWindow, 128000),
    maxTokens: declaredLimit(model.maxTokens, 16384),
    ...(api === "openai-completions"
      ? {
          compat: {
            supportsDeveloperRole,
            ...(anthropicPromptCaching ? { cacheControlFormat: "anthropic" as const } : {}),
          },
        }
      : {}),
  }));
}

export function resolveCustomProviderModelLimits(
  providerKey: string,
  modelId: string,
  customProviders?: CustomProvider[],
): CustomProviderModelLimits {
  const providers = customProviders ?? readCustomProviders(getHomeDir());
  const provider = providers.find((candidate) =>
    customProviderRegistryKey(candidate, providers) === providerKey);
  if (!provider) {
    throw new Error(`CCC custom provider is not configured: ${providerKey}`);
  }

  const api = resolveApiType(provider.apiType);
  const model = buildCustomProviderModels(provider, api).find((candidate) => candidate.id === modelId);
  if (!model) {
    throw new Error(`CCC custom provider model is not configured: ${providerKey}/${modelId}`);
  }

  return {
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  };
}

/*
FNXC:ProviderAuth 2026-08-03-11:15:
Task #8: pi-coding-agent's provider composer (composeApiKeyAuth) always builds
an API-key auth resolver for a non-OAuth provider, but that resolver returns no
credential when neither a stored credential nor a configured `apiKey` string
exists -- every dispatch then throws "Provider is not configured", even for a
loopback backend (oMLX, ollama, llama.cpp, ...) that never reads the
Authorization header at all. There is no "explicitly keyless" resolution path
in that library; the only way to avoid the throw is to hand it *some*
resolvable string. Fabricate a non-secret sentinel for a keyless LOOPBACK
provider only -- a keyless remote provider keeps pi's real "not configured"
refusal, since that is very likely a genuine missing credential.
*/
export const CCC_LOOPBACK_NO_AUTH_REQUIRED_API_KEY = "ccc-fusion-loopback-no-auth-required";

export function resolveCustomProviderApiKey(provider: CustomProvider): string | undefined {
  if (provider.apiKey) return provider.apiKey;
  return validateCccLoopbackHttpUrl(provider.baseUrl).ok ? CCC_LOOPBACK_NO_AUTH_REQUIRED_API_KEY : undefined;
}

/*
FNXC:ProviderHeaders 2026-08-06-00:00:
This function is the ONLY boundary between a `CustomProvider` read out of
~/.fusion/settings.json and the provider config handed to pi-coding-agent's
model registry, and it rebuilt that config from a fixed field whitelist. A
configured `headers` map was therefore dropped SILENTLY here -- no error, no
warning -- even though every layer downstream already preserves it and pi
itself accepts it (`headers?: ProviderHeaders` on its provider composer). The
break was ours alone.

The concrete failure this caused: measurement runs dispatch through a local
OmniRoute gateway whose semantic cache treats `temperature: 0` as the
cacheability predicate, and our authoring adapter hardcodes exactly that. Every
first attempt is byte-identical across runs, so a re-run replayed a STALE
cached answer instead of exercising the new code -- silently serving pre-fix
results and invalidating the whole acceptance run. The only way to opt out is a
per-request header (`X-OmniRoute-No-Cache: true`), which could not reach the
wire while this whitelist existed.

Forward headers verbatim: pass-through, not interpretation. Emit the key only
when a non-empty map is configured so an unconfigured provider's config stays
byte-identical to before -- `providersDiffer` compares these configs by
JSON.stringify, and a header edit must count as a change requiring
re-registration (which is why it is inside the spread).

How this actually reaches the wire -- traced empirically, because the obvious
reading of the pi source is wrong twice over:
  1. pi's provider composer BLANKS model headers at composition time
     (`applyExtension` sets `headers: undefined` on every model unconditionally),
     so the composed `model.headers` is always undefined and stamping headers
     onto our `models` entries changes nothing by itself.
  2. They are re-resolved per request by `ModelRuntime.getAuth()`, which merges
     the provider's configured headers into `auth.headers`; pi-ai then applies
     that as `options.headers` on the outgoing request.
So the provider-level key below is both necessary AND sufficient -- verified by
disabling it and watching the header vanish from a captured request. Note this
means a dispatch path that hand-builds options and skips `getAuth()` will NOT
carry these headers.
*/
function toProviderConfig(provider: CustomProvider) {
  const api = resolveApiType(provider.apiType);
  const headers = provider.headers;

  return {
    baseUrl: provider.baseUrl,
    api,
    apiKey: resolveCustomProviderApiKey(provider),
    models: buildCustomProviderModels(provider, api),
    ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
  };
}

function providersDiffer(previous: CustomProvider, current: CustomProvider): boolean {
  return JSON.stringify(toProviderConfig(previous)) !== JSON.stringify(toProviderConfig(current));
}

export async function registerCustomProviders(
  modelRegistry: ModelRegistryLike,
  customProviders: CustomProvider[] | undefined,
  logFn: (message: string) => void,
): Promise<void> {
  const providers = customProviders ?? [];
  for (const provider of providers) {
    const registryKey = customProviderRegistryKey(provider, providers);
    try {
      modelRegistry.registerProvider(registryKey, toProviderConfig(provider));
      logFn(`Registered custom provider "${provider.name}" (key=${registryKey}, id=${provider.id})`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logFn(`Failed to register custom provider "${provider.name}" (key=${registryKey}, id=${provider.id}): ${message}`);
    }
  }

  /*
  FNXC:ModelRegistry 2026-07-21-17:15:
  Unbounded modelRegistry.refresh() hung dashboard startup on "Loading extensions…" when a
  provider catalog fetch never completed. Use the shared bounded refresh so custom-provider
  registration cannot block boot.
  */
  await refreshFusionModelRegistry(modelRegistry, { log: logFn });
}

export async function reregisterCustomProviders(
  modelRegistry: ModelRegistryLike,
  previousProviders: CustomProvider[] | undefined,
  currentProviders: CustomProvider[] | undefined,
  logFn: (message: string) => void,
): Promise<void> {
  const previousById = new Map((previousProviders ?? []).map((provider) => [provider.id, provider]));
  const providers = currentProviders ?? [];

  for (const provider of providers) {
    const previous = previousById.get(provider.id);
    if (previous && !providersDiffer(previous, provider)) {
      continue;
    }

    const registryKey = customProviderRegistryKey(provider, providers);
    try {
      modelRegistry.registerProvider(registryKey, toProviderConfig(provider));
      logFn(`${previous ? "Updated" : "Registered"} custom provider "${provider.name}" (key=${registryKey}, id=${provider.id})`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logFn(`Failed to register custom provider "${provider.name}" (key=${registryKey}, id=${provider.id}): ${message}`);
    }
  }

  await refreshFusionModelRegistry(modelRegistry, { log: logFn });
}
