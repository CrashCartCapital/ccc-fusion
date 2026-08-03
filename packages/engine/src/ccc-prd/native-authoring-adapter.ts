import {
  CCC_PRD_AUTHORING_PROPOSAL_SCHEMA_VERSION,
  canonicalCccPrdJson,
  customProviderRegistryKey,
  type CccPrdAuthoringAdapter,
  type CccPrdAuthoringProposal,
  type CccPrdAuthoringRequest,
  type CustomProvider,
} from "@fusion/core";
import {
  createFusionAuthStorage,
  createFusionModelRegistry,
  getHomeDir,
} from "../auth-storage.js";
import { validateCccLoopbackHttpUrl } from "../ccc-loopback-policy.js";
import { registerCustomProviders } from "../custom-provider-registry.js";
import { readCustomProviders } from "../custom-providers.js";

export type CccPrdNativeAuthoringTransportRequest = {
  provider: string;
  model: string;
  prompt: string;
  maxDurationMs: number;
  maxResponseBytes: number;
  signal: AbortSignal;
};

export type CccPrdNativeAuthoringTransportResponse = {
  text: string;
  provider: string;
  model: string;
};

export type CccPrdNativeAuthoringTransport = (
  request: CccPrdNativeAuthoringTransportRequest,
) => Promise<CccPrdNativeAuthoringTransportResponse>;

export type CccPrdNativeAuthoringMode = "execution" | "understanding";

export type CreateNativeCccPrdAuthoringAdapterOptions = {
  provider: string;
  model: string;
  maxDurationMs: number;
  maxPromptBytes: number;
  maxResponseBytes: number;
  mode?: CccPrdNativeAuthoringMode;
  transport?: CccPrdNativeAuthoringTransport;
  /** Configured custom providers; defaults to the operator's stored settings. */
  customProviders?: CustomProvider[];
};

function positiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a finite positive integer`);
  }
}

export class CccPrdAuthoringEgressPolicyViolationError extends Error {
  readonly code = "CCC_PRD_AUTHORING_EGRESS_POLICY_VIOLATION";

  constructor(providerKey: string, reason: string) {
    super(`CCC PRD authoring provider ${providerKey} is outside the ccc-fusion loopback boundary: ${reason}`);
    this.name = "CccPrdAuthoringEgressPolicyViolationError";
  }
}

/*
FNXC:CCCAuthoringEgress 2026-08-01-17:40:
Authoring and understanding serialize every admitted source verbatim into one
prompt, so the transport target is decided before any corpus bytes exist. Resolve
the selected provider through the same registry-key rule the pi seam uses and
validate it with the shared loopback policy; a provider id that resolves to no
configured custom provider (including every built-in id) fails closed rather than
inheriting that provider's own remote route. The refusal deliberately names only
the provider key and the policy reason — never the base URL, credential, or any
source text — so a refusal log cannot become the leak it just prevented.
*/
function assertCccPrdAuthoringLoopbackEgress(
  providerKey: string,
  providers: CustomProvider[],
): void {
  const provider = providers.find(
    (candidate) => customProviderRegistryKey(candidate, providers) === providerKey,
  );
  if (!provider) {
    throw new CccPrdAuthoringEgressPolicyViolationError(
      providerKey,
      "provider does not resolve to a configured custom provider",
    );
  }
  const validation = validateCccLoopbackHttpUrl(provider.baseUrl);
  if (!validation.ok) {
    throw new CccPrdAuthoringEgressPolicyViolationError(providerKey, validation.reason);
  }
}

function buildPrompt(
  request: CccPrdAuthoringRequest,
  mode: CccPrdNativeAuthoringMode,
): string {
  if (mode === "execution" && !request.constraints) {
    throw new Error("CCC PRD native authoring requires explicit target, bounds, and review constraints");
  }
  const modeInstructions = mode === "understanding"
    ? [
        "This is review-only PRD understanding. The result is never executable and must not claim operator approval.",
        "Extract source-grounded product meaning before implementation facts are approved.",
        "When targetRepository.path or targetRepository.baseCommit is absent, use an empty string in that structural field and add a source-bound unresolved decision asking for it.",
        "When an execution bound is absent, use 0 in that structural field and add a source-bound unresolved decision asking for it.",
        "When allowed paths are absent, return an empty admittedWriteRoots array; create no task whose ownedPaths or allowedWriteRoots would be invented, and add a source-bound unresolved decision.",
        "Do not make assumptions. Convert every missing implementation-changing fact into a source-bound unresolved decision.",
      ]
    : [
        "This is execution-sidecar authoring. Return the exact admitted target, bounds, and review constraints.",
      ];
  return [
    "Generate exactly one JSON object and no Markdown or commentary.",
    `The object schema must be ${CCC_PRD_AUTHORING_PROPOSAL_SCHEMA_VERSION}.`,
    "Preserve the source packet. Do not execute actions or invent source text.",
    ...modeInstructions,
    "Every requirement, proof, task, workflow, document, artifact, unresolved decision, ambiguity, exception, and protected action must cite one or more admitted sources using {path, exactQuote}; every exactQuote must occur exactly once in that source.",
    "Copy each exactQuote verbatim from the source bytes -- never paraphrase, summarize, or normalize whitespace. Choose quotes long enough to occur exactly once: quote the complete sentence or line, and extend with adjacent text whenever a shorter phrase could repeat elsewhere in the document.",
    "When a short identifier, test name, or phrase repeats across the document, never quote it alone: quote the entire sentence or line around its defining occurrence, extended until the quote is unique. When quoting lines from code blocks, tables, or directory trees, reproduce interior spacing, alignment runs of spaces, and trailing comments byte-for-byte.",
    "Every implementation-changing fact must be source-bound too: targetRepository.path, targetRepository.baseCommit, every admittedWriteRoots.path, every task ownedPaths and allowedWriteRoots path, execution bounds, requirement acceptance behavior, proof command/oracle/negative controls, protected actions, and non-goals must appear in the admitted source text. If a fact is missing, return a source-bound unresolved question instead of inventing it from constraints.",
    "Every task must return non-empty ownedPaths and allowedWriteRoots arrays using canonical target-relative paths. Each path must occur literally in that task's exact source quote. Keep concurrency ownership distinct from filesystem write permission; never broaden either from a global root.",
    "Source references must collectively disposition every Markdown heading block and requirement-like row. Map it to a task when implemented; otherwise cite an explicit source deferral/out-of-scope statement or return a source-bound unresolved question. Never guess a missing decision.",
    "Return all required arrays and objects: schema, authorityRoles, requirements, proofs, tasks, edges, workflows, documents, artifacts, importIntents, protectedActions, bounds, admittedWriteRoots, targetRepository, nonGoals, unresolvedDecisions, ambiguities, exceptions, confidence.",
    /*
    Stage 4 (2026-08-03): without this explicit field contract a real model
    invented reasonable-but-wrong shapes (citations under `sources`, bounds as
    an array, confidence as a number) and every run failed the shape gate.
    The template below is documentation for the model, not parseable JSON --
    enum alternatives are written with `|`.
    */
    "The exact field contract, with every key name mandatory (enumerated values are written with |; all other values are strings unless shown as numbers; every source-bound row carries its citations under \"sourceRefs\"):",
    "{",
    "  \"schema\": \"ccc-prd.authoring-proposal.v1\",",
    "  \"authorityRoles\": [{ \"id\": \"\", \"role\": \"root\" | \"production_module\" | \"blocking_test_index\" | \"support\", \"sourcePaths\": [\"\"], \"accountableProducer\": \"\" }],",
    "  \"requirements\": [{ \"id\": \"\", \"statement\": \"\", \"acceptance\": \"\", \"accountableProducer\": \"\", \"dependencies\": [\"\"], \"proofIds\": [\"\"], \"confidence\": \"high\" | \"medium\" | \"low\", \"sourceRefs\": [{ \"path\": \"\", \"exactQuote\": \"\" }] }],",
    "  \"proofs\": [{ \"id\": \"\", \"requirementIds\": [\"\"], \"command\": \"\", \"positiveOracle\": \"\", \"negativeControls\": [\"\"], \"confidence\": \"high\" | \"medium\" | \"low\", \"sourceRefs\": [{ \"path\": \"\", \"exactQuote\": \"\" }] }],",
    "  \"tasks\": [{ \"id\": \"\", \"title\": \"\", \"description\": \"\", \"accountableProducer\": \"\", \"requirementIds\": [\"\"], \"dependencyTaskIds\": [\"\"], \"proofIds\": [\"\"], \"workflowId\": \"\", \"documentIds\": [\"\"], \"artifactIds\": [\"\"], \"protectedActionIds\": [\"\"], \"ownedPaths\": [\"\"], \"allowedWriteRoots\": [\"\"], \"sourceRefs\": [{ \"path\": \"\", \"exactQuote\": \"\" }] }],",
    "  \"edges\": [{ \"id\": \"\", \"fromTaskId\": \"\", \"toTaskId\": \"\", \"kind\": \"depends_on\" }],",
    "  \"workflows\": [{ \"id\": \"\", \"title\": \"\", \"taskIds\": [\"\"], \"entryTaskIds\": [\"\"], \"terminalTaskIds\": [\"\"], \"sourceRefs\": [{ \"path\": \"\", \"exactQuote\": \"\" }] }],",
    "  \"documents\": [{ \"id\": \"\", \"taskId\": \"\", \"key\": \"\", \"title\": \"\", \"content\": \"\", \"sourceRefs\": [{ \"path\": \"\", \"exactQuote\": \"\" }] }],",
    "  \"artifacts\": [{ \"id\": \"\", \"taskId\": \"\", \"type\": \"\", \"title\": \"\", \"mimeType\": \"\", \"content\": \"\", \"sourceRefs\": [{ \"path\": \"\", \"exactQuote\": \"\" }] }],",
    "  \"importIntents\": [{ \"id\": \"\", \"entityType\": \"campaign\" | \"task\" | \"dependency_edge\" | \"workflow\" | \"document\" | \"artifact\" | \"source\" | \"work_item\" | \"run_audit\", \"entityId\": \"\", \"operation\": \"create\", \"target\": \"\" }],",
    "  \"protectedActions\": [{ \"id\": \"\", \"kind\": \"promotion\" | \"live_execution\" | \"deletion\" | \"merge\" | \"publication\" | \"credential\" | \"billing\" | \"upstream_write\", \"target\": \"\", \"sourceRefs\": [{ \"path\": \"\", \"exactQuote\": \"\" }] }],",
    "  \"bounds\": { \"maxRequests\": 0, \"maxDurationMs\": 0, \"maxConcurrency\": 0 },",
    "  \"admittedWriteRoots\": [{ \"path\": \"\", \"purpose\": \"\" }],",
    "  \"targetRepository\": { \"path\": \"\", \"baseCommit\": \"\" },",
    "  \"nonGoals\": [\"\"],",
    "  \"unresolvedDecisions\": [{ \"id\": \"\", \"question\": \"\", \"state\": \"unresolved\", \"sourceRefs\": [{ \"path\": \"\", \"exactQuote\": \"\" }] }],",
    "  \"ambiguities\": [{ \"id\": \"\", \"message\": \"\", \"sourceRefs\": [{ \"path\": \"\", \"exactQuote\": \"\" }] }],",
    "  \"exceptions\": [{ \"id\": \"\", \"message\": \"\", \"sourceRefs\": [{ \"path\": \"\", \"exactQuote\": \"\" }] }],",
    "  \"confidence\": \"high\" | \"medium\" | \"low\"",
    "}",
    "Use stable IDs. Protected actions must name exact targets. Human review is limited to ambiguities, unresolved decisions, exceptions, and protected actions.",
    canonicalCccPrdJson({
      mode,
      packetHash: request.packetHash,
      sourceVersion: request.sourceVersion,
      ...(request.constraints ? { constraints: request.constraints } : {}),
      orderedSources: request.sources,
      ...(request.previousSidecar ? { previousSidecar: request.previousSidecar } : {}),
    }),
  ].join("\n");
}

export const fusionModelRuntimeAuthoringTransport: CccPrdNativeAuthoringTransport = async (
  request,
) => {
  const home = getHomeDir();
  const customProviders = readCustomProviders(home);
  const authStorage = createFusionAuthStorage(home);
  const registry = await createFusionModelRegistry(authStorage, home);
  await registerCustomProviders(registry, customProviders, () => undefined);
  const model = registry.find(request.provider, request.model);
  if (!model) {
    throw new Error(
      `CCC PRD authoring model is not configured: ${request.provider}/${request.model}`,
    );
  }

  const controller = new AbortController();
  const abort = () => controller.abort(request.signal.reason);
  if (request.signal.aborted) abort();
  else request.signal.addEventListener("abort", abort, { once: true });
  try {
    const stream = registry.modelRuntime.streamSimple(
      model,
      {
        messages: [{
          role: "user",
          content: request.prompt,
          timestamp: Date.now(),
        }],
      },
      {
        signal: controller.signal,
        temperature: 0,
        maxTokens: Math.max(1, Math.min(model.maxTokens, request.maxResponseBytes)),
        timeoutMs: request.maxDurationMs,
        maxRetries: 0,
      },
    );
    let streamedTextBytes = 0;
    for await (const event of stream) {
      if (event.type !== "text_delta") continue;
      streamedTextBytes += Buffer.byteLength(event.delta, "utf8");
      if (streamedTextBytes > request.maxResponseBytes) {
        controller.abort();
        throw new Error(
          `CCC PRD authoring response exceeded ${request.maxResponseBytes} bytes`,
        );
      }
    }
    const response = await stream.result();
    if (response.stopReason !== "stop") {
      throw new Error(
        `CCC PRD authoring transport ended with ${response.stopReason}: ${response.errorMessage ?? "incomplete response"}`,
      );
    }
    const text = response.content
      .filter((entry): entry is Extract<typeof entry, { type: "text" }> => entry.type === "text")
      .map((entry) => entry.text)
      .join("");
    if (Buffer.byteLength(text, "utf8") > request.maxResponseBytes) {
      throw new Error(
        `CCC PRD authoring response exceeded ${request.maxResponseBytes} bytes`,
      );
    }
    return {
      text,
      provider: response.provider,
      model: response.responseModel ?? response.model,
    };
  } finally {
    request.signal.removeEventListener("abort", abort);
  }
};

export function createNativeCccPrdAuthoringAdapter(
  options: CreateNativeCccPrdAuthoringAdapterOptions,
): CccPrdAuthoringAdapter {
  positiveInteger(options.maxDurationMs, "maxDurationMs");
  positiveInteger(options.maxPromptBytes, "maxPromptBytes");
  positiveInteger(options.maxResponseBytes, "maxResponseBytes");
  if (!options.provider.trim() || !options.model.trim()) {
    throw new Error("CCC PRD native authoring provider and model are required");
  }
  const transport = options.transport ?? fusionModelRuntimeAuthoringTransport;
  const mode = options.mode ?? "execution";
  const configuredProviders = options.customProviders ?? readCustomProviders(getHomeDir());

  return {
    id: "fusion-native-model-runtime-v1",
    model: `${options.provider}/${options.model}`,
    async generateCandidate(request): Promise<CccPrdAuthoringProposal> {
      assertCccPrdAuthoringLoopbackEgress(options.provider, configuredProviders);
      const prompt = buildPrompt(request, mode);
      const promptBytes = Buffer.byteLength(prompt, "utf8");
      if (promptBytes > options.maxPromptBytes) {
        throw new Error(
          `CCC PRD authoring prompt is ${promptBytes} bytes; maximum is ${options.maxPromptBytes}`,
        );
      }

      const controller = new AbortController();
      let timer: NodeJS.Timeout | undefined;
      try {
        const response = await Promise.race([
          transport({
            provider: options.provider,
            model: options.model,
            prompt,
            maxDurationMs: options.maxDurationMs,
            maxResponseBytes: options.maxResponseBytes,
            signal: controller.signal,
          }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(new Error(
                `CCC PRD native authoring timed out after ${options.maxDurationMs}ms`,
              ));
            }, options.maxDurationMs);
          }),
        ]);
        if (response.provider !== options.provider || response.model !== options.model) {
          throw new Error(
            `CCC PRD authoring transport identity drifted: expected ${options.provider}/${options.model}, received ${response.provider}/${response.model}`,
          );
        }
        const responseBytes = Buffer.byteLength(response.text, "utf8");
        if (responseBytes > options.maxResponseBytes) {
          throw new Error(
            `CCC PRD authoring response is ${responseBytes} bytes; maximum is ${options.maxResponseBytes}`,
          );
        }
        const parsed = JSON.parse(response.text) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("CCC PRD authoring response is not one JSON object");
        }
        return parsed as CccPrdAuthoringProposal;
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
}
