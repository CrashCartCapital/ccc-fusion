import { createHash } from "node:crypto";
import { CCC_PRD_AUTHORING_PROPOSAL_FRAGMENT_SCHEMA_VERSION, canonicalCccPrdJson, type CustomProvider } from "@fusion/core";
import { getHomeDir } from "../auth-storage.js";
import { readCustomProviders } from "../custom-providers.js";
import type { CccPrdChunkAttemptTransport } from "./chunk-verification.js";
import { CccPrdRepairableModelOutputError } from "./custody.js";
import {
  assertCccPrdAuthoringLoopbackEgress,
  assertCccPrdRouteVerbatimCapable,
  fusionModelRuntimeAuthoringTransport,
  SMALLER_ANSWER_INSTRUCTION,
  type CccPrdNativeAuthoringMode,
  type CccPrdNativeAuthoringTransport,
} from "./native-authoring-adapter.js";

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

export type CccPrdChunkEnvelope = {
  mode: CccPrdNativeAuthoringMode;
  semanticProofContract?: "v1" | "v2";
  packetHash: string;
  sourceVersion: string;
  chunkPlanHash: string;
  chunkId: string;
  chunkOrdinal: number;
  chunkCount: number;
  packetHeader: Array<{ path: string; role: string; sha256: string; byteLength: number }>;
  sourcePath: string;
  sliceByteStart: number;
  sliceByteEnd: number;
  sliceSha256: string;
  materialItems: Array<{ id: string; headingPath: string[]; title: string; byteStart: number; byteEnd: number }>;
  slice: string;
};

/**
 * The 13 fragment-row template lines, shared verbatim with the singleton
 * template in native-authoring-adapter.ts's buildPrompt (design §2's edit
 * table names only 5 keys removed -- bounds/admittedWriteRoots/
 * targetRepository/nonGoals/confidence -- everything else is unchanged).
 * One field is added per row versus the single-shot template:
 * materialItemIds, a ledger checked against the real analyzer, never
 * trusted on the model's word (design §2 "Fragment shape").
 */
const CHUNK_FRAGMENT_ROW_TEMPLATE_LINES: readonly string[] = [
  `  "schema": "${CCC_PRD_AUTHORING_PROPOSAL_FRAGMENT_SCHEMA_VERSION}",`,
  "  \"authorityRoles\": [{ \"id\": \"\", \"role\": \"root\" | \"production_module\" | \"blocking_test_index\" | \"support\", \"sourcePaths\": [\"\"], \"accountableProducer\": \"\" }],",
  "  \"requirements\": [{ \"id\": \"\", \"statement\": \"\", \"acceptance\": \"\", \"accountableProducer\": \"\", \"dependencies\": [\"\"], \"proofIds\": [\"\"], \"confidence\": \"high\" | \"medium\" | \"low\", \"sourceRefs\": [{ \"path\": \"\", \"exactQuote\": \"\" }], \"materialItemIds\": [\"\"] }],",
  "  \"proofs\": [{ \"id\": \"\", \"requirementIds\": [\"\"], \"command\": \"\", \"positiveOracle\": \"\", \"negativeControls\": [\"\"], \"confidence\": \"high\" | \"medium\" | \"low\", \"sourceRefs\": [{ \"path\": \"\", \"exactQuote\": \"\" }], \"materialItemIds\": [\"\"] }],",
  "  \"tasks\": [{ \"id\": \"\", \"title\": \"\", \"description\": \"\", \"accountableProducer\": \"\", \"requirementIds\": [\"\"], \"dependencyTaskIds\": [\"\"], \"proofIds\": [\"\"], \"workflowId\": \"\", \"documentIds\": [\"\"], \"artifactIds\": [\"\"], \"protectedActionIds\": [\"\"], \"ownedPaths\": [\"\"], \"allowedWriteRoots\": [\"\"], \"sourceRefs\": [{ \"path\": \"\", \"exactQuote\": \"\" }], \"materialItemIds\": [\"\"] }],",
  "  \"edges\": [{ \"id\": \"\", \"fromTaskId\": \"\", \"toTaskId\": \"\", \"kind\": \"depends_on\" }],",
  "  \"workflows\": [{ \"id\": \"\", \"title\": \"\", \"taskIds\": [\"\"], \"entryTaskIds\": [\"\"], \"terminalTaskIds\": [\"\"], \"sourceRefs\": [{ \"path\": \"\", \"exactQuote\": \"\" }], \"materialItemIds\": [\"\"] }],",
  "  \"documents\": [{ \"id\": \"\", \"taskId\": \"\", \"key\": \"\", \"title\": \"\", \"content\": \"\", \"sourceRefs\": [{ \"path\": \"\", \"exactQuote\": \"\" }], \"materialItemIds\": [\"\"] }],",
  "  \"artifacts\": [{ \"id\": \"\", \"taskId\": \"\", \"type\": \"\", \"title\": \"\", \"mimeType\": \"\", \"content\": \"\", \"sourceRefs\": [{ \"path\": \"\", \"exactQuote\": \"\" }], \"materialItemIds\": [\"\"] }],",
  "  \"importIntents\": [{ \"id\": \"\", \"entityType\": \"campaign\" | \"task\" | \"dependency_edge\" | \"workflow\" | \"document\" | \"artifact\" | \"source\" | \"work_item\" | \"run_audit\", \"entityId\": \"\", \"operation\": \"create\", \"target\": \"\" }],",
  "  \"protectedActions\": [{ \"id\": \"\", \"kind\": \"promotion\" | \"live_execution\" | \"deletion\" | \"merge\" | \"publication\" | \"credential\" | \"billing\" | \"upstream_write\", \"target\": \"\", \"sourceRefs\": [{ \"path\": \"\", \"exactQuote\": \"\" }], \"materialItemIds\": [\"\"] }],",
  "  \"unresolvedDecisions\": [{ \"id\": \"\", \"question\": \"\", \"state\": \"unresolved\", \"sourceRefs\": [{ \"path\": \"\", \"exactQuote\": \"\" }], \"materialItemIds\": [\"\"] }],",
  "  \"ambiguities\": [{ \"id\": \"\", \"message\": \"\", \"sourceRefs\": [{ \"path\": \"\", \"exactQuote\": \"\" }], \"materialItemIds\": [\"\"] }],",
  "  \"exceptions\": [{ \"id\": \"\", \"message\": \"\", \"sourceRefs\": [{ \"path\": \"\", \"exactQuote\": \"\" }], \"materialItemIds\": [\"\"] }],",
];

const CHUNK_FRAGMENT_V2_ROW_TEMPLATE_LINES: readonly string[] = [
  "  \"schema\": \"ccc-prd.authoring-proposal-fragment.v2\",",
  CHUNK_FRAGMENT_ROW_TEMPLATE_LINES[1]!,
  "  \"requirements\": [{ \"id\": \"\", \"statement\": \"\", \"acceptance\": \"\", \"accountableProducer\": \"\", \"dependencies\": [\"\"], \"proofIds\": [\"\"], \"acceptanceClauses\": [{ \"id\": \"\", \"requirementId\": \"\", \"text\": \"\", \"proofIds\": [\"\"], \"sourceRefs\": [{ \"path\": \"\", \"exactQuote\": \"\" }] }], \"acceptanceDispositions\": [{ \"clauseId\": \"\", \"requirementId\": \"\", \"kind\": \"deferred\" | \"excluded\" | \"unresolved\", \"reason\": \"\", \"sourceRefs\": [{ \"path\": \"\", \"exactQuote\": \"\" }] }], \"confidence\": \"high\" | \"medium\" | \"low\", \"sourceRefs\": [{ \"path\": \"\", \"exactQuote\": \"\" }], \"materialItemIds\": [\"\"] }],",
  "  \"proofs\": [{ \"schema\": \"ccc-prd.proof.v2\", \"id\": \"\", \"requirementIds\": [\"\"], \"clauseIds\": [\"\"], \"phases\": [\"task\" | \"final_integrated\"], \"command\": \"\", \"positiveOracle\": \"\", \"positiveCases\": [{ \"id\": \"\", \"description\": \"\" }], \"negativeControls\": [{ \"id\": \"\", \"description\": \"\" }], \"verifierClosure\": [{ \"role\": \"task_runner\" | \"harness\" | \"fixture\" | \"config\", \"path\": \"\", \"baseGitBlobOid\": \"\", \"sha256\": \"\" }], \"candidateInputs\": [\"\"], \"executionToolchain\": { \"task\": { \"executablePath\": \"\", \"executableSha256\": \"\", \"version\": \"\", \"versionOutputSha256\": \"\" }, \"node\": { \"executablePath\": \"\", \"executableSha256\": \"\", \"version\": \"\", \"versionOutputSha256\": \"\" }, \"proofHost\": { \"id\": \"\", \"executablePath\": \"\", \"executableSha256\": \"\", \"version\": \"\", \"versionOutputSha256\": \"\" }, \"linkedRuntime\": [], \"python\": { \"executablePath\": \"\", \"executableSha256\": \"\", \"version\": \"\", \"versionOutputSha256\": \"\", \"runtimeManifest\": { \"schema\": \"ccc-prd.python-runtime-manifest.v1\", \"interpreter\": { \"path\": \"\", \"sha256\": \"\" }, \"stdlibRoot\": \"\", \"pythonHomeRoot\": \"\", \"sitePackagesRoots\": [], \"extensionModuleRoots\": [], \"runtimeSupport\": [], \"stdlib\": [], \"sitePackages\": [], \"extensionModules\": [], \"dylibClosure\": [] } } }, \"verifierProfile\": { \"schema\": \"ccc-prd.verifier.python-adapter.v1\", \"adapterPath\": \"\", \"targetPath\": \"\" }, \"confidence\": \"high\" | \"medium\" | \"low\", \"sourceRefs\": [{ \"path\": \"\", \"exactQuote\": \"\" }], \"materialItemIds\": [\"\"] }],",
  ...CHUNK_FRAGMENT_ROW_TEMPLATE_LINES.slice(4),
];

/**
 * How many accumulated violations a repair prompt carries. `priorViolations`
 * is otherwise unbounded -- runCccPrdChunkAttempt feeds the whole violation
 * array of attempt N into the prompt of attempt N+1 -- so a chunk that fails
 * with dozens of undispositioned material items can build a repair prompt that
 * trips the `maxPromptBytes` ceiling below, making the recovery mechanism
 * itself the fatal step. authoring.ts caps its equivalent list at the same 8.
 */
const MAX_PROMPT_PRIOR_VIOLATIONS = 8;

/**
 * Builds the per-chunk prompt (design §2's edit table applied to
 * buildPrompt): fragment schema, chunk envelope payload instead of full
 * `orderedSources`, the quote-scope line restricting quotes to the slice,
 * and the coverage instruction rephrased to "this chunk" -- everything
 * else (verbatim-copy discipline, the anti-invention instruction, the
 * shared row template) is unchanged. This function and buildPrompt in
 * native-authoring-adapter.ts intentionally share several literal
 * instruction lines; keep them in sync by hand (deliberately not
 * refactored into one shared function, to avoid risking the single-shot
 * prompt "measured to work" per Stage 4).
 */
export function buildCccPrdChunkPrompt(
  envelope: CccPrdChunkEnvelope,
  priorViolations: string[] = [],
): string {
  const semanticV2 = envelope.semanticProofContract === "v2";
  const fragmentSchema = semanticV2
    ? "ccc-prd.authoring-proposal-fragment.v2"
    : CCC_PRD_AUTHORING_PROPOSAL_FRAGMENT_SCHEMA_VERSION;
  const templateLines = semanticV2
    ? CHUNK_FRAGMENT_V2_ROW_TEMPLATE_LINES
    : CHUNK_FRAGMENT_ROW_TEMPLATE_LINES;
  const modeInstructions = envelope.mode === "understanding"
    ? [
        "This is review-only PRD understanding. The result is never executable and must not claim operator approval.",
        "Extract source-grounded product meaning before implementation facts are approved.",
        "Do not make assumptions. Convert every missing implementation-changing fact into a source-bound unresolved decision.",
      ]
    : [
        "This is execution-sidecar authoring for one chunk. Return only the rows this chunk's slice supports.",
      ];

  const lines = [
    "Generate exactly one JSON object and no Markdown or commentary.",
    `The object schema must be ${fragmentSchema}.`,
    "Preserve the source packet. Do not execute actions or invent source text.",
    ...modeInstructions,
    ...(semanticV2
      ? [
          "Use only source-declared clauses under the exact normative Acceptance clauses grammar; clause IDs and text must be copied exactly from the source grammar.",
          "The model may only attach proofIds or echo exact source dispositions. It must never invent clause IDs, text, ownership, or spans.",
          "Acceptance-clause sourceRefs must quote the exact clause text only; fuzzy quote recovery never applies to acceptance clauses.",
          "Every source clause visible in this slice must be returned once as accepted or dispositioned, and every accepted clause must link to at least one v2 proof.",
          "Declare verifier closure roles/paths, candidate inputs, phases, and cases only. Fusion replaces every Git blob OID, SHA-256, Task identity, Node identity, and proof-host identity before any executable admission; use empty strings for those controller-owned placeholder fields.",
        ]
      : []),
    "Quote only from the bytes between BEGIN CHUNK SLICE and END CHUNK SLICE below. A quote drawn from anywhere else is refused.",
    "Every requirement, proof, task, workflow, document, artifact, unresolved decision, ambiguity, exception, and protected action must cite one or more admitted sources using {path, exactQuote}; every exactQuote must occur exactly once in that source.",
    "Copy each exactQuote verbatim from the source bytes -- never paraphrase, summarize, or normalize whitespace. Choose quotes long enough to occur exactly once: quote the complete sentence or line, and extend with adjacent text whenever a shorter phrase could repeat elsewhere in the document.",
    "When a short identifier, test name, or phrase repeats across the document, never quote it alone: quote the entire sentence or line around its defining occurrence, extended until the quote is unique. When quoting lines from code blocks, tables, or directory trees, reproduce interior spacing, alignment runs of spaces, and trailing comments byte-for-byte.",
    "Every implementation-changing fact must be source-bound too: every task ownedPaths and allowedWriteRoots path, requirement acceptance behavior, proof command/oracle/negative controls, and protected actions must appear in the admitted source text. If a fact is missing, return a source-bound unresolved question instead of inventing it.",
    "Every task must return non-empty ownedPaths and allowedWriteRoots arrays using canonical target-relative paths. Each path must occur literally in that task's exact source quote.",
    "Disposition every material item listed in this chunk. Map it to a task when implemented; otherwise cite an explicit source deferral/out-of-scope statement or return a source-bound unresolved question. Never guess a missing decision.",
    "List the chunk-plan item IDs each row claims to disposition in that row's materialItemIds field.",
    "Use one coverage disposition per material item: supporting requirement, proof, and workflow rows may share a materialItemId, but never put the same materialItemId in any task row (including an explicit deferral/out-of-scope row) and any unresolvedDecisions row; if unresolved, omit it from tasks.",
    "Return exactly these arrays: authorityRoles, requirements, proofs, tasks, edges, workflows, documents, artifacts, importIntents, protectedActions, unresolvedDecisions, ambiguities, exceptions.",
    "The exact field contract, with every key name mandatory (enumerated values are written with |; all other values are strings unless shown as numbers; every source-bound row carries its citations under \"sourceRefs\"):",
    "{",
    ...templateLines,
    "}",
    "Use stable IDs. Human review is limited to ambiguities, unresolved decisions, exceptions, and protected actions.",
    ...(priorViolations.length > 0
      ? [
          "The previous attempt on this chunk failed these checks; fix every one before returning your next answer:",
          ...priorViolations.slice(0, MAX_PROMPT_PRIOR_VIOLATIONS).map((violation) => `- ${violation}`),
          ...(priorViolations.length > MAX_PROMPT_PRIOR_VIOLATIONS
            ? [
                `- (+${priorViolations.length - MAX_PROMPT_PRIOR_VIOLATIONS} more violations omitted to keep this prompt`
                  + " within budget; the same class of fault applies to them, so fix the ones above and apply the same"
                  + " correction throughout)",
              ]
            : []),
        ]
      : []),
    canonicalCccPrdJson({
      mode: envelope.mode,
      ...(semanticV2 ? { semanticProofContract: "v2" } : {}),
      packetHash: envelope.packetHash,
      sourceVersion: envelope.sourceVersion,
      chunkPlanHash: envelope.chunkPlanHash,
      chunkId: envelope.chunkId,
      chunkOrdinal: envelope.chunkOrdinal,
      chunkCount: envelope.chunkCount,
      packetHeader: envelope.packetHeader,
      sourcePath: envelope.sourcePath,
      sliceByteStart: envelope.sliceByteStart,
      sliceByteEnd: envelope.sliceByteEnd,
      sliceSha256: envelope.sliceSha256,
      materialItems: envelope.materialItems,
    }),
    "BEGIN CHUNK SLICE",
    envelope.slice,
    "END CHUNK SLICE",
  ];
  return lines.join("\n");
}

export function buildCccPrdChunkEnvelope(input: {
  mode: CccPrdNativeAuthoringMode;
  semanticProofContract?: "v1" | "v2";
  packetHash: string;
  sourceVersion: string;
  chunkPlanHash: string;
  chunkId: string;
  chunkOrdinal: number;
  chunkCount: number;
  packetHeader: Array<{ path: string; role: string; sha256: string; byteLength: number }>;
  sourcePath: string;
  fullSourceBytes: Buffer;
  sliceByteStart: number;
  sliceByteEnd: number;
  materialItems: Array<{ id: string; headingPath: string[]; title: string; byteStart: number; byteEnd: number }>;
}): CccPrdChunkEnvelope {
  return {
    mode: input.mode,
    ...(input.semanticProofContract ? { semanticProofContract: input.semanticProofContract } : {}),
    packetHash: input.packetHash,
    sourceVersion: input.sourceVersion,
    chunkPlanHash: input.chunkPlanHash,
    chunkId: input.chunkId,
    chunkOrdinal: input.chunkOrdinal,
    chunkCount: input.chunkCount,
    packetHeader: input.packetHeader,
    sourcePath: input.sourcePath,
    sliceByteStart: input.sliceByteStart,
    sliceByteEnd: input.sliceByteEnd,
    sliceSha256: sha256(input.fullSourceBytes.subarray(input.sliceByteStart, input.sliceByteEnd)),
    materialItems: input.materialItems,
    slice: input.fullSourceBytes.subarray(input.sliceByteStart, input.sliceByteEnd).toString("utf8"),
  };
}

export type CreateCccPrdChunkTransportCallerOptions = {
  provider: string;
  model: string;
  maxDurationMs: number;
  maxPromptBytes: number;
  maxResponseBytes: number;
  transport?: CccPrdNativeAuthoringTransport;
  customProviders?: CustomProvider[];
};

/**
 * The chunk-lane counterpart of createNativeCccPrdAuthoringAdapter's
 * transport-calling body: same egress + verbatimCapable assertions (design
 * §8, checked on every call since a chunked run makes many), same prompt-
 * byte and response-byte ceilings, same timeout race. Identity-drift
 * checking stays in runCccPrdChunkAttempt (chunk-verification.ts), which
 * already compares the returned provider/model against what was requested.
 */
export function createCccPrdChunkTransportCaller(
  options: CreateCccPrdChunkTransportCallerOptions,
): CccPrdChunkAttemptTransport {
  const transport = options.transport ?? fusionModelRuntimeAuthoringTransport;
  const configuredProviders = options.customProviders ?? readCustomProviders(getHomeDir());

  return async ({ prompt }) => {
    assertCccPrdAuthoringLoopbackEgress(options.provider, configuredProviders);
    assertCccPrdRouteVerbatimCapable(options.provider, options.model, configuredProviders);

    const promptBytes = Buffer.byteLength(prompt, "utf8");
    if (promptBytes > options.maxPromptBytes) {
      throw new Error(`CCC PRD chunk authoring prompt is ${promptBytes} bytes; maximum is ${options.maxPromptBytes}`);
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
            reject(new Error(`CCC PRD chunk authoring timed out after ${options.maxDurationMs}ms`));
          }, options.maxDurationMs);
        }),
      ]);
      const responseBytes = Buffer.byteLength(response.text, "utf8");
      if (responseBytes > options.maxResponseBytes) {
        throw new CccPrdRepairableModelOutputError(
          "CCC_PRD_CHUNK_RESPONSE_OVERSIZED",
          `CCC PRD chunk authoring response is ${responseBytes} bytes; maximum is ${options.maxResponseBytes}. `
            + `${SMALLER_ANSWER_INSTRUCTION} ${options.maxResponseBytes} bytes.`,
        );
      }
      return response;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}
