import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CCC_PRD_AUTHORING_PROPOSAL_FRAGMENT_SCHEMA_VERSION,
  type CustomProvider,
} from "@fusion/core";
import { understandCccPrdPacket } from "../ccc-prd/understanding.js";
import type { CccPrdNativeAuthoringTransport } from "../ccc-prd/native-authoring-adapter.js";

/**
 * DOES THE FLAG SURVIVE A FAILED DOCUMENT?
 *
 * `ccc-prd-fuzzy-quote-visibility.test.ts` proves the whole flag path works on
 * the SUCCESS path. That is only half the promise. Fuzzy matching was switched
 * on for one reason -- every guess gets flagged so a human can review it -- and
 * a corpus run measured zero flags reaching an operator across six documents,
 * because every one of those documents FAILED, and a failure returns
 * `{kind: "refusal"}`, a shape that carried no review payload at all.
 *
 * The guesses were real. Chunks 1..N-1 completed, anchored quotes by guessing,
 * and pushed their receipts into an accumulator living in
 * `runCccPrdChunkedUnderstanding`'s stack frame. Chunk N then threw, that frame
 * unwound, and every receipt in it was collected by the garbage collector
 * before anything rendered it.
 *
 * What is proven here is that a document which dies mid-run STILL hands the
 * operator both texts for every quote the completed chunks guessed at: what the
 * model wrote and what the source actually says. Without it, a meaning-
 * inverting recovery (`redact every` -> `redact no`, measured at 0.9747 --
 * HIGHER than the innocent drift the tier exists to accept at 0.9449) is
 * substituted with correct-looking source bytes and no human ever learns it
 * happened.
 */

const digest = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function write(root: string, relativePath: string, content: string): string {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

function packet(content: string): { rootDir: string; manifestPath: string } {
  const root = mkdtempSync(join(tmpdir(), "ccc-prd-fuzzy-failure-"));
  roots.push(root);
  write(root, "source.md", content);
  const manifestPath = write(root, "manifest.json", JSON.stringify({
    schema: "ccc-prd.packet.v1",
    source_version: "fuzzy-failure-test",
    entries: [{
      relative_path: "source.md",
      role: "root",
      authoritative: true,
      sha256: digest(Buffer.from(content, "utf8")),
    }],
  }));
  return { rootDir: root, manifestPath };
}

const VERBATIM_CAPABLE_PROVIDERS: CustomProvider[] = [{
  id: "ccc-loopback-fuzzy-failure",
  name: "Loopback Fuzzy Failure",
  apiType: "openai-compatible",
  baseUrl: "http://127.0.0.1:7999/v1",
  apiKey: "synthetic-never-read",
  models: [{ id: "fixture-model", name: "Fixture", verbatimCapable: true }],
}];

/** The first section's real wording. */
const TRUE_TEXT = "The router chooses one of `skill_only`, `hook_only`, or `neither` for every fixture without free-form fallback.";
/** What the model retyped in chunk 1: "per fixture" instead of "for every fixture". */
const DRIFTED_QUOTE = "The router chooses one of `skill_only`, `hook_only`, or `neither` per fixture without free-form fallback.";

/*
 * Two H1 sections, so the planner cuts at the shallowest interior heading level
 * and emits exactly two chunks. Chunk 1 succeeds (guessing at its quote);
 * chunk 2 is fed garbage until it exhausts its attempts and kills the document.
 */
const SOURCE = [
  "# Router",
  "",
  `- REQ-1: ${TRUE_TEXT}`,
  "",
  "# Redaction",
  "",
  "- REQ-2: The pipeline redacts every credential before a transcript leaves the host.",
  "",
].join("\n");

/** Present only in chunk 2's slice, so the fake transport can tell the chunks apart. */
const CHUNK_TWO_MARKER = "# Redaction";

function fragment(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    schema: CCC_PRD_AUTHORING_PROPOSAL_FRAGMENT_SCHEMA_VERSION,
    authorityRoles: [],
    requirements: [],
    proofs: [],
    tasks: [],
    edges: [],
    workflows: [],
    documents: [],
    artifacts: [],
    importIntents: [],
    protectedActions: [],
    unresolvedDecisions: [],
    ambiguities: [],
    exceptions: [],
    ...overrides,
  };
}

/** A well-formed chunk-1 fragment that dispositions REQ-1 by citing `quote`. */
function routerFragment(quote: string): Record<string, unknown> {
  return fragment({
    requirements: [{
      id: "REQ-1",
      statement: "router requirement",
      acceptance: "router acceptance",
      accountableProducer: "team-a",
      dependencies: [],
      proofIds: [],
      confidence: "high",
      sourceRefs: [{ path: "source.md", exactQuote: quote }],
    }],
    tasks: [{
      id: "TASK-ROUTER",
      title: "Ship the router",
      description: "Implement the router",
      accountableProducer: "team-a",
      requirementIds: ["REQ-1"],
      dependencyTaskIds: [],
      proofIds: [],
      workflowId: "",
      documentIds: [],
      artifactIds: [],
      protectedActionIds: [],
      ownedPaths: ["src/router.ts"],
      allowedWriteRoots: ["src/router.ts"],
      sourceRefs: [{ path: "source.md", exactQuote: "# Router" }],
    }],
  });
}

/**
 * Runs a two-chunk document where chunk 1 cites `chunkOneQuote` and chunk 2
 * always answers with prose instead of JSON -- the plainest way a real model
 * burns its attempts. The run dies at CCC_PRD_CHUNK_ATTEMPTS_EXHAUSTED with
 * chunk 1 already complete.
 */
async function runFailingDocument(chunkOneQuote: string) {
  const { rootDir, manifestPath } = packet(SOURCE);
  const transport: CccPrdNativeAuthoringTransport = async ({ provider, model, prompt }) => ({
    text: prompt.includes(CHUNK_TWO_MARKER)
      ? "I could not produce a fragment for this section."
      : JSON.stringify(routerFragment(chunkOneQuote)),
    provider,
    model,
  });

  return understandCccPrdPacket({
    rootDir,
    manifestPath,
    adapter: {
      id: "unused-single-shot-adapter",
      generateCandidate: async () => { throw new Error("single-shot path must not run"); },
    },
    maxReviewItems: 8,
    workflowExtensionRegistry: undefined as never,
    requestedLane: "chunked",
    provider: "loopback-fuzzy-failure",
    model: "fixture-model",
    maxDurationMs: 5_000,
    maxPromptBytes: 1_000_000,
    maxResponseBytes: 256_000,
    chunkTransport: transport,
    customProviders: VERBATIM_CAPABLE_PROVIDERS,
  });
}

describe("a guessed quote survives the throw that kills the document", () => {
  it("still refuses, and says which chunk killed the run", async () => {
    const result = await runFailingDocument(DRIFTED_QUOTE);

    expect(result.kind).toBe("refusal");
    if (result.kind !== "refusal") return;
    expect(result.diagnostics[0]!.code).toBe("CCC_PRD_CHUNK_ATTEMPTS_EXHAUSTED");
  });

  it("reports the quote chunk 1 guessed at, even though chunk 2 killed the run", async () => {
    // THE BUG. Chunk 1 completed and anchored REQ-1 by guessing. Chunk 2 then
    // threw, and the accumulator holding that receipt died with the frame. An
    // operator reading this refusal saw a bare diagnostic and had no way to
    // learn a quote had been recovered rather than found.
    const result = await runFailingDocument(DRIFTED_QUOTE);

    expect(result.kind).toBe("refusal");
    if (result.kind !== "refusal") return;
    expect(
      result.quoteReview,
      "a failed document that guessed at a quote must still hand the operator the review",
    ).toBeDefined();
    expect(result.quoteReview!.fuzzyMatchCount).toBe(1);
    expect(result.quoteReview!.fuzzyMatches).toHaveLength(1);
  });

  it("puts the model's wording NEXT TO the document's real text, exactly as the success path does", async () => {
    const result = await runFailingDocument(DRIFTED_QUOTE);

    expect(result.kind).toBe("refusal");
    if (result.kind !== "refusal") return;
    const [notice] = result.quoteReview!.fuzzyMatches;

    // A similarity score cannot separate a harmless rewording from a reversed
    // requirement. A human comparing these two strings can -- and on a failed
    // document this refusal is the only place either string exists.
    expect(notice!.quoteAsModelWrote).toBe(DRIFTED_QUOTE);
    expect(notice!.matchedSourceText).toBe(TRUE_TEXT);
    expect(notice!.entityId).toBe("REQ-1");
    expect(notice!.sourcePath).toBe("source.md");
    expect(notice!.chunkId).toContain("source.md");
    expect(notice!.message).toContain("fuzzy match");
    expect(notice!.message).toContain("per fixture");
    expect(notice!.message).toContain("for every fixture");
  });

  it("reports the policy the failed run actually matched under", async () => {
    const result = await runFailingDocument(DRIFTED_QUOTE);

    expect(result.kind).toBe("refusal");
    if (result.kind !== "refusal") return;
    expect(result.quoteReview!.policy).toEqual({ allowFuzzy: true, recordFuzzyForReview: true });
  });

  it("survives the CLI's refusal rendering, which is what an operator actually reads", async () => {
    const result = await runFailingDocument(DRIFTED_QUOTE);

    expect(result.kind).toBe("refusal");
    if (result.kind !== "refusal") return;
    // Mirrors the refusal branch of runUnderstandCommand (prd.ts): the whole
    // refusal is serialized to stdout and the process exits 1.
    const printed = JSON.parse(JSON.stringify(result));

    expect(printed.diagnostics[0].code).toBe("CCC_PRD_CHUNK_ATTEMPTS_EXHAUSTED");
    expect(printed.quoteReview.fuzzyMatchCount).toBe(1);
    expect(printed.quoteReview.fuzzyMatches[0].quoteAsModelWrote).toContain("per fixture");
    expect(printed.quoteReview.fuzzyMatches[0].matchedSourceText).toContain("for every fixture");
  });
});

describe("a failed document that guessed at nothing stays quiet", () => {
  it("emits no review section at all when every completed quote matched verbatim", async () => {
    // "Zero guesses" on a failure is not worth a section. An empty review
    // printed on every refusal in the corpus is noise, and noise is what
    // taught operators to stop reading these payloads in the first place.
    const result = await runFailingDocument(TRUE_TEXT);

    expect(result.kind).toBe("refusal");
    if (result.kind !== "refusal") return;
    expect(result.diagnostics[0]!.code).toBe("CCC_PRD_CHUNK_ATTEMPTS_EXHAUSTED");
    expect(result.quoteReview).toBeUndefined();
    expect(Object.keys(JSON.parse(JSON.stringify(result)))).not.toContain("quoteReview");
  });
});
