import { createHash } from "node:crypto";
import { CCC_PRD_AUTHORING_PROPOSAL_FRAGMENT_SCHEMA_VERSION, canonicalCccPrdJson, type CustomProvider } from "@fusion/core";
import { getHomeDir } from "../auth-storage.js";
import { readCustomProviders } from "../custom-providers.js";
import type { CccPrdChunkAttemptTransport } from "./chunk-verification.js";
import {
  assertCccPrdAuthoringLoopbackEgress,
  assertCccPrdRouteVerbatimCapable,
  fusionModelRuntimeAuthoringTransport,
  type CccPrdNativeAuthoringMode,
  type CccPrdNativeAuthoringTransport,
} from "./native-authoring-adapter.js";

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

export type CccPrdChunkEnvelope = {
  mode: CccPrdNativeAuthoringMode;
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
    `The object schema must be ${CCC_PRD_AUTHORING_PROPOSAL_FRAGMENT_SCHEMA_VERSION}.`,
    "Preserve the source packet. Do not execute actions or invent source text.",
    ...modeInstructions,
    "Quote only from the bytes between BEGIN CHUNK SLICE and END CHUNK SLICE below. A quote drawn from anywhere else is refused.",
    "Every requirement, proof, task, workflow, document, artifact, unresolved decision, ambiguity, exception, and protected action must cite one or more admitted sources using {path, exactQuote}; every exactQuote must occur exactly once in that source.",
    "Copy each exactQuote verbatim from the source bytes -- never paraphrase, summarize, or normalize whitespace. Choose quotes long enough to occur exactly once: quote the complete sentence or line, and extend with adjacent text whenever a shorter phrase could repeat elsewhere in the document.",
    "When a short identifier, test name, or phrase repeats across the document, never quote it alone: quote the entire sentence or line around its defining occurrence, extended until the quote is unique. When quoting lines from code blocks, tables, or directory trees, reproduce interior spacing, alignment runs of spaces, and trailing comments byte-for-byte.",
    "Every implementation-changing fact must be source-bound too: every task ownedPaths and allowedWriteRoots path, requirement acceptance behavior, proof command/oracle/negative controls, and protected actions must appear in the admitted source text. If a fact is missing, return a source-bound unresolved question instead of inventing it.",
    "Every task must return non-empty ownedPaths and allowedWriteRoots arrays using canonical target-relative paths. Each path must occur literally in that task's exact source quote.",
    "Disposition every material item listed in this chunk. Map it to a task when implemented; otherwise cite an explicit source deferral/out-of-scope statement or return a source-bound unresolved question. Never guess a missing decision.",
    "List the chunk-plan item IDs each row claims to disposition in that row's materialItemIds field.",
    "Per material item, task disposition and unresolved-decision disposition are mutually exclusive: never include the same materialItemId in a task row and an unresolvedDecisions row; if an item is unresolved, omit it from task rows.",
    "Return exactly these arrays: authorityRoles, requirements, proofs, tasks, edges, workflows, documents, artifacts, importIntents, protectedActions, unresolvedDecisions, ambiguities, exceptions.",
    "The exact field contract, with every key name mandatory (enumerated values are written with |; all other values are strings unless shown as numbers; every source-bound row carries its citations under \"sourceRefs\"):",
    "{",
    ...CHUNK_FRAGMENT_ROW_TEMPLATE_LINES,
    "}",
    "Use stable IDs. Human review is limited to ambiguities, unresolved decisions, exceptions, and protected actions.",
    ...(priorViolations.length > 0
      ? [
          "The previous attempt on this chunk failed these checks; fix every one before returning your next answer:",
          ...priorViolations.map((violation) => `- ${violation}`),
        ]
      : []),
    canonicalCccPrdJson({
      mode: envelope.mode,
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
        throw new Error(
          `CCC PRD chunk authoring response is ${responseBytes} bytes; maximum is ${options.maxResponseBytes}`,
        );
      }
      return response;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}
