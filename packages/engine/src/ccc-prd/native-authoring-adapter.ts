import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { CccPrdRepairableModelOutputError } from "./custody.js";

/**
 * Shared tail of every "you produced too much output" rejection. The retry
 * loop puts this straight in the next prompt, so it has to say what to do
 * differently, not just that a bound was passed. Callers append the bound.
 */
export const SMALLER_ANSWER_INSTRUCTION =
  "Return a smaller answer: emit fewer rows and shorter description/content fields so the complete "
  + "JSON object fits within";

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

export class CccPrdRouteNotVerbatimCapableError extends Error {
  readonly code = "CCC_PRD_ROUTE_NOT_VERBATIM_CAPABLE";

  constructor(providerKey: string, model: string) {
    super(
      `CCC PRD quote-bearing work refuses ${providerKey}/${model}: verbatimCapable is not declared. `
        + "Absent means unknown means not admitted (design D-4) -- register with "
        + "`fn provider add --verbatim-capable` once the route is confirmed to copy quotes byte-exact.",
    );
    this.name = "CccPrdRouteNotVerbatimCapableError";
  }
}

/*
Real acceptance run against glm-5.2 (2026-08-05): the model wrapped its whole
JSON answer in a ```json code fence and JSON.parse threw on the leading
backtick, hard-failing CCC_PRD_AUTHORING_FAILED. Wrapping JSON in a fence is
common LLM behavior. Strip ONLY when the entire trimmed response is a single
outermost fence -- opener (``` optionally + language tag, then a newline) at
the start and a bare closing ``` at the end -- and only remove those two
delimiters. This must never become a global backtick/fence removal: a quote
inside a JSON string value may legitimately contain a fence, and mangling it
would corrupt the byte-exact quote custody the product exists to guarantee.
*/
const OUTERMOST_FENCE_WRAPPER = /^```[^\n`]*\n([\s\S]*)\n```$/u;

export function stripOutermostJsonFence(text: string): string {
  const trimmed = text.trim();
  const match = OUTERMOST_FENCE_WRAPPER.exec(trimmed);
  return match ? match[1]! : text;
}

/*
Defect B (2026-08-05): a JSON.parse failure on the authoring response used to
surface only V8's SyntaxError message -- which previews roughly a dozen
characters of the input -- through authoring.ts's catch-all refusal bundle,
discarding the raw response text entirely. That made the real acceptance-run
failure against glm-5.2 undiagnosable: we could not see what the model
actually sent. Persist the raw response to a scratch file ONLY on parse
failure (never on success -- this is diagnostic volume, not a product
artifact) and name that path in the thrown error so a future run is
diagnosable. Written to the OS temp directory, never stdout, never the vault.
*/
function persistUnparsableAuthoringResponse(rawResponseText: string): string {
  const diagnosticsDir = join(tmpdir(), "fusion-ccc-prd-authoring-diagnostics");
  mkdirSync(diagnosticsDir, { recursive: true });
  const diagnosticPath = join(diagnosticsDir, `unparsable-response-${randomUUID()}.txt`);
  writeFileSync(diagnosticPath, rawResponseText, "utf8");
  return diagnosticPath;
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
export function assertCccPrdAuthoringLoopbackEgress(
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

/*
Design §8 / D-4: verbatimCapable is a declared operator assertion, not a
measurement -- the product cannot see the architecture behind an
OpenAI-compatible URL, so MoE disqualification (D3) is enforced by
declaration. Absent means unknown means not admitted for quote-bearing work.
Required for BOTH modes (execution and understanding), since both emit
sourceRefs. Checked before a single corpus byte is serialized, alongside the
egress assertion.
*/
export function assertCccPrdRouteVerbatimCapable(
  providerKey: string,
  model: string,
  providers: CustomProvider[],
): void {
  const provider = providers.find(
    (candidate) => customProviderRegistryKey(candidate, providers) === providerKey,
  );
  const modelEntry = provider?.models?.find((entry) => entry.id === model);
  if (!modelEntry?.verbatimCapable) {
    throw new CccPrdRouteNotVerbatimCapableError(providerKey, model);
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
  const semanticV2 = request.semanticProofContract === "v2";
  const proposalSchema = semanticV2
    ? "ccc-prd.authoring-proposal.v2"
    : CCC_PRD_AUTHORING_PROPOSAL_SCHEMA_VERSION;
  const requirementTemplate = semanticV2
    ? "  \"requirements\": [{ \"id\": \"\", \"statement\": \"\", \"acceptance\": \"\", \"accountableProducer\": \"\", \"dependencies\": [\"\"], \"proofIds\": [\"\"], \"acceptanceClauses\": [{ \"id\": \"\", \"requirementId\": \"\", \"text\": \"\", \"proofIds\": [\"\"], \"sourceRefs\": [{ \"path\": \"\", \"exactQuote\": \"\" }] }], \"acceptanceDispositions\": [{ \"clauseId\": \"\", \"requirementId\": \"\", \"kind\": \"deferred\" | \"excluded\" | \"unresolved\", \"reason\": \"\", \"sourceRefs\": [{ \"path\": \"\", \"exactQuote\": \"\" }] }], \"confidence\": \"high\" | \"medium\" | \"low\", \"sourceRefs\": [{ \"path\": \"\", \"exactQuote\": \"\" }] }],"
    : "  \"requirements\": [{ \"id\": \"\", \"statement\": \"\", \"acceptance\": \"\", \"accountableProducer\": \"\", \"dependencies\": [\"\"], \"proofIds\": [\"\"], \"confidence\": \"high\" | \"medium\" | \"low\", \"sourceRefs\": [{ \"path\": \"\", \"exactQuote\": \"\" }] }],";
  const proofTemplate = semanticV2
    ? "  \"proofs\": [{ \"schema\": \"ccc-prd.proof.v2\", \"id\": \"\", \"requirementIds\": [\"\"], \"clauseIds\": [\"\"], \"phases\": [\"task\" | \"final_integrated\"], \"command\": \"\", \"positiveOracle\": \"\", \"positiveCases\": [{ \"id\": \"\", \"description\": \"\" }], \"negativeControls\": [{ \"id\": \"\", \"description\": \"\" }], \"verifierClosure\": [{ \"role\": \"task_runner\" | \"harness\" | \"fixture\" | \"config\", \"path\": \"\", \"baseGitBlobOid\": \"\", \"sha256\": \"\" }], \"candidateInputs\": [\"\"], \"executionToolchain\": { \"task\": { \"executablePath\": \"\", \"executableSha256\": \"\", \"version\": \"\", \"versionOutputSha256\": \"\" }, \"node\": { \"executablePath\": \"\", \"executableSha256\": \"\", \"version\": \"\", \"versionOutputSha256\": \"\" }, \"proofHost\": { \"id\": \"\", \"executablePath\": \"\", \"executableSha256\": \"\", \"version\": \"\", \"versionOutputSha256\": \"\" }, \"linkedRuntime\": [], \"python\": { \"executablePath\": \"\", \"executableSha256\": \"\", \"version\": \"\", \"versionOutputSha256\": \"\", \"runtimeManifest\": { \"schema\": \"ccc-prd.python-runtime-manifest.v1\", \"interpreter\": { \"path\": \"\", \"sha256\": \"\" }, \"stdlibRoot\": \"\", \"pythonHomeRoot\": \"\", \"sitePackagesRoots\": [], \"extensionModuleRoots\": [], \"runtimeSupport\": [], \"stdlib\": [], \"sitePackages\": [], \"extensionModules\": [], \"dylibClosure\": [] } } }, \"verifierProfile\": { \"schema\": \"ccc-prd.verifier.python-adapter.v1\", \"adapterPath\": \"\", \"targetPath\": \"\" }, \"confidence\": \"high\" | \"medium\" | \"low\", \"sourceRefs\": [{ \"path\": \"\", \"exactQuote\": \"\" }] }],"
    : "  \"proofs\": [{ \"id\": \"\", \"requirementIds\": [\"\"], \"command\": \"\", \"positiveOracle\": \"\", \"negativeControls\": [\"\"], \"confidence\": \"high\" | \"medium\" | \"low\", \"sourceRefs\": [{ \"path\": \"\", \"exactQuote\": \"\" }] }],";
  return [
    "Generate exactly one JSON object and no Markdown or commentary.",
    "Return raw JSON only -- do not wrap the object in a ```json or ``` code fence and do not add any text before or after the object.",
    `The object schema must be ${proposalSchema}.`,
    "Preserve the source packet. Do not execute actions or invent source text.",
    ...modeInstructions,
    ...(semanticV2
      ? [
          "Use only the exact normative Markdown grammar under `### Requirement <id>` and `#### Acceptance clauses`; ordinary prose never becomes an acceptance clause.",
          "Acceptance clause IDs, text, and raw-byte spans are owned by the admitted PRD source. Copy every ID and text byte-exactly, cite the exact text once, and only link the parser-owned clause to proofIds; never invent, split, merge, renumber, or paraphrase a clause.",
          "Every source-declared clause must appear exactly once as an accepted acceptanceClauses row or as its exact deferred, excluded, or unresolved acceptanceDispositions row. Unresolved or omitted clauses refuse semantic normalization.",
          "Exact clause sourceRefs must contain only the clause text bytes (or disposition reason bytes); fuzzy quote recovery is forbidden for acceptance clauses.",
          "Every accepted clause needs one or more proofIds, and every v2 proof must name its exact clauseIds, allowed phases, positive cases, negative controls, closed verifierClosure, candidateInputs, and executionToolchain.",
          "Declare verifierClosure roles and paths, candidateInputs, phases, cases, and proof meaning. Fusion—not you—reads closure bytes from the frozen Git base and replaces every baseGitBlobOid, SHA-256, Task identity, Node identity, and proof-host identity before executable admission. Emit empty strings in those controller-owned identity fields; never claim that you observed executable bytes or versions.",
          "Python proofs are opt-in only: add verifierProfile schema ccc-prd.verifier.python-adapter.v1 with closure-owned adapterPath and targetPath, and emit every ccc-prd.python-runtime-manifest.v1 key shown in the template. Leave controller-owned interpreter/root/file identity values empty; Fusion discovers and replaces them before executable admission. Never use shell, uv, -m, absolute paths, or an ambient interpreter.",
        ]
      : []),
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
    `  "schema": "${proposalSchema}",`,
    "  \"authorityRoles\": [{ \"id\": \"\", \"role\": \"root\" | \"production_module\" | \"blocking_test_index\" | \"support\", \"sourcePaths\": [\"\"], \"accountableProducer\": \"\" }],",
    requirementTemplate,
    proofTemplate,
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
      ...(semanticV2 ? { semanticProofContract: "v2" } : {}),
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
        // maxTokens is a TOKEN budget; it must come from the registered
        // model's own token limit, never from request.maxResponseBytes
        // (a BYTE count -- used only by the response-size guards below).
        maxTokens: Math.max(1, model.maxTokens),
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
        throw new CccPrdRepairableModelOutputError(
          "CCC_PRD_AUTHORING_RESPONSE_OVERSIZED",
          `CCC PRD authoring response exceeded ${request.maxResponseBytes} bytes while streaming. `
            + `${SMALLER_ANSWER_INSTRUCTION} ${request.maxResponseBytes} bytes.`,
        );
      }
    }
    const response = await stream.result();
    if (response.stopReason === "length") {
      throw new CccPrdRepairableModelOutputError(
        "CCC_PRD_AUTHORING_RESPONSE_TRUNCATED",
        `CCC PRD authoring response was cut off before it finished: the model stopped with `
          + `"${response.stopReason}" (${response.errorMessage ?? "incomplete response"}). `
          + "Return a smaller answer: emit fewer rows and shorter description/content fields so the "
          + "complete JSON object fits inside the model's own output-token limit.",
      );
    }
    if (response.stopReason !== "stop") {
      throw new Error(
        `CCC PRD authoring response did not complete: the model stopped with `
          + `"${response.stopReason}" (${response.errorMessage ?? "incomplete response"}).`,
      );
    }
    const text = response.content
      .filter((entry): entry is Extract<typeof entry, { type: "text" }> => entry.type === "text")
      .map((entry) => entry.text)
      .join("");
    if (Buffer.byteLength(text, "utf8") > request.maxResponseBytes) {
      throw new CccPrdRepairableModelOutputError(
        "CCC_PRD_AUTHORING_RESPONSE_OVERSIZED",
        `CCC PRD authoring response exceeded ${request.maxResponseBytes} bytes. `
          + `${SMALLER_ANSWER_INSTRUCTION} ${request.maxResponseBytes} bytes.`,
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
      assertCccPrdRouteVerbatimCapable(options.provider, options.model, configuredProviders);
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
        let parsed: unknown;
        try {
          parsed = JSON.parse(stripOutermostJsonFence(response.text));
        } catch (error) {
          const diagnosticPath = persistUnparsableAuthoringResponse(response.text);
          const reason = error instanceof Error ? error.message : String(error);
          throw new Error(
            `CCC PRD authoring response is not valid JSON (${reason}); `
              + `raw response preserved at ${diagnosticPath} for diagnosis`,
          );
        }
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
