import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CCC_PRD_AUTHORING_PROPOSAL_FRAGMENT_SCHEMA_VERSION,
  type CustomProvider,
} from "@fusion/core";
import { CCC_PRD_RUN_QUOTE_MATCH_POLICY } from "../ccc-prd/anchor-resolver.js";
import { understandCccPrdPacket } from "../ccc-prd/understanding.js";
import type { CccPrdNativeAuthoringTransport } from "../ccc-prd/native-authoring-adapter.js";

/**
 * DOES THE FLAG REACH A HUMAN?
 *
 * `ccc-prd-chunked-quote-drift-integration.test.ts` proves a fuzzy match is
 * recorded on its receipt. That is worth nothing on its own: a receipt no
 * output renders is a flag nobody sees. What is proven HERE is the rest of the
 * path, end to end through a real packet on disk --
 *
 *   fuzzy match -> CccPrdAnchorReceipt.fuzzyDrift
 *               -> verifyCccPrdChunkFragment.fuzzyReviewNotices
 *               -> runCccPrdChunkAttempt.onAnchorReceipts
 *               -> runCccPrdChunkedUnderstanding.quoteReview
 *               -> understandCccPrdPacket result.quoteReview
 *               -> the CLI's printed JSON wrapper (prd.ts, beside `lane`)
 *
 * -- and specifically that an operator ends up holding BOTH texts: what the
 * model wrote and what their document actually says. That pairing is the only
 * defence against the measured failure the fuzzy tier cannot rule out, where a
 * meaning-INVERTING edit scores 0.9747, above the innocent drift the tier
 * exists to accept at 0.9449.
 *
 * The drift below is real corpus drift, not an invention: the model wrote
 * "per fixture" where the source says "for every fixture"
 * (skill-hook-authoring-18-other). The operator ruled it an acceptable copying
 * slip, so it must RESOLVE -- and, being a guess, must arrive flagged.
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
  const root = mkdtempSync(join(tmpdir(), "ccc-prd-fuzzy-visibility-"));
  roots.push(root);
  write(root, "source.md", content);
  const manifestPath = write(root, "manifest.json", JSON.stringify({
    schema: "ccc-prd.packet.v1",
    source_version: "fuzzy-visibility-test",
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
  id: "ccc-loopback-fuzzy-visibility",
  name: "Loopback Fuzzy Visibility",
  apiType: "openai-compatible",
  baseUrl: "http://127.0.0.1:7999/v1",
  apiKey: "synthetic-never-read",
  models: [{ id: "fixture-model", name: "Fixture", verbatimCapable: true }],
}];

/** The document's real wording. */
const TRUE_TEXT = "The router chooses one of `skill_only`, `hook_only`, or `neither` for every fixture without free-form fallback.";
/** What the model retyped: "per fixture" instead of "for every fixture". */
const DRIFTED_QUOTE = "The router chooses one of `skill_only`, `hook_only`, or `neither` per fixture without free-form fallback.";

const SOURCE = [
  "# Router",
  "",
  `- REQ-1: ${TRUE_TEXT}`,
  "",
].join("\n");

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

function fragmentCiting(quote: string): Record<string, unknown> {
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

async function runUnderstanding(quote: string) {
  const { rootDir, manifestPath } = packet(SOURCE);
  const transport: CccPrdNativeAuthoringTransport = async ({ provider, model }) => ({
    text: JSON.stringify(fragmentCiting(quote)),
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
    provider: "loopback-fuzzy-visibility",
    model: "fixture-model",
    maxDurationMs: 5_000,
    maxPromptBytes: 1_000_000,
    maxResponseBytes: 256_000,
    chunkTransport: transport,
    customProviders: VERBATIM_CAPABLE_PROVIDERS,
  });
}

describe("fuzzy quote matching is ON for real chunked runs", () => {
  it("recovers a drifted quote that byte-exact matching would have killed the run over", async () => {
    // Nothing here passes quoteMatchPolicy -- exactly what production does. If
    // the entry-point default were still deterministic-only, this run would
    // die at CCC_PRD_CHUNK_ATTEMPTS_EXHAUSTED instead.
    const result = await runUnderstanding(DRIFTED_QUOTE);

    expect(result.kind, JSON.stringify(result)).toBe("understanding-review");
    if (result.kind !== "understanding-review") return;
    expect(result.lane).toBe("chunked");
    expect(result.requirements.map((requirement) => requirement.id)).toEqual(["REQ-1"]);
  });

  it("reports the policy it ran under, so a reader never has to assume it", async () => {
    const result = await runUnderstanding(DRIFTED_QUOTE);

    expect(result.kind).toBe("understanding-review");
    if (result.kind !== "understanding-review") return;
    expect(result.quoteReview.policy).toEqual({
      allowFuzzy: CCC_PRD_RUN_QUOTE_MATCH_POLICY.allowFuzzy,
      recordFuzzyForReview: CCC_PRD_RUN_QUOTE_MATCH_POLICY.recordFuzzyForReview,
    });
  });
});

describe("a guessed quote is VISIBLE on the run's operator-facing result", () => {
  it("counts the guess instead of letting it pass unremarked", async () => {
    const result = await runUnderstanding(DRIFTED_QUOTE);

    expect(result.kind).toBe("understanding-review");
    if (result.kind !== "understanding-review") return;
    expect(result.quoteReview.fuzzyMatchCount, "the run guessed at one quote and must say so").toBe(1);
    expect(result.quoteReview.fuzzyMatches).toHaveLength(1);
  });

  it("puts the model's wording NEXT TO the document's real text", async () => {
    const result = await runUnderstanding(DRIFTED_QUOTE);

    expect(result.kind).toBe("understanding-review");
    if (result.kind !== "understanding-review") return;
    const [notice] = result.quoteReview.fuzzyMatches;

    // THE POINT OF THE WHOLE FEATURE. A similarity score cannot tell a harmless
    // rewording from a reversed requirement. A human comparing these two
    // strings can, and this is the only place both survive.
    expect(notice!.quoteAsModelWrote).toBe(DRIFTED_QUOTE);
    expect(notice!.matchedSourceText).toBe(TRUE_TEXT);
    expect(notice!.quoteAsModelWrote).toContain("per fixture");
    expect(notice!.matchedSourceText).toContain("for every fixture");

    // Enough context to find it: which entity, which file, which chunk.
    expect(notice!.entityId).toBe("REQ-1");
    expect(notice!.sourcePath).toBe("source.md");
    expect(notice!.chunkId).toContain("source.md");
    expect(notice!.similarity).toBeGreaterThan(0.85);
    expect(notice!.similarity).toBeLessThan(1);

    // And the same facts as one readable line, for string-only surfaces.
    expect(notice!.message).toContain("REQ-1");
    expect(notice!.message).toContain("fuzzy match");
    expect(notice!.message).toContain("per fixture");
    expect(notice!.message).toContain("for every fixture");
  });

  it("survives JSON serialization, which is how the CLI actually emits it", async () => {
    const result = await runUnderstanding(DRIFTED_QUOTE);

    expect(result.kind).toBe("understanding-review");
    if (result.kind !== "understanding-review") return;
    // Mirrors prd.ts: `quoteReview` is stripped from the persisted sidecar and
    // re-added to the printed wrapper, exactly as `lane` is.
    const { lane, quoteReview, ...persistedReview } = result;
    const printed = JSON.parse(JSON.stringify({ ...persistedReview, reviewPath: "/tmp/review.json", lane, quoteReview }));

    expect(printed.quoteReview.fuzzyMatchCount).toBe(1);
    expect(printed.quoteReview.fuzzyMatches[0].quoteAsModelWrote).toContain("per fixture");
    expect(printed.quoteReview.fuzzyMatches[0].matchedSourceText).toContain("for every fixture");

    // The on-disk artifact stays exactly as it was: no new key, no schema bump.
    expect(Object.keys(persistedReview)).not.toContain("quoteReview");
    expect(Object.keys(persistedReview)).not.toContain("lane");
  });

  it("stays empty and honest when every quote matched verbatim", async () => {
    // "Zero guesses" must be reported, not merely absent -- otherwise a clean
    // run is indistinguishable from a run where nobody looked.
    const result = await runUnderstanding(TRUE_TEXT);

    expect(result.kind, JSON.stringify(result)).toBe("understanding-review");
    if (result.kind !== "understanding-review") return;
    expect(result.quoteReview.fuzzyMatchCount).toBe(0);
    expect(result.quoteReview.fuzzyMatches).toEqual([]);
    expect(result.quoteReview.policy.allowFuzzy, "fuzzy was available, it simply was not needed").toBe(true);
  });
});
