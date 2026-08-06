import { describe, expect, it, vi } from "vitest";
import { CCC_PRD_AUTHORING_PROPOSAL_FRAGMENT_SCHEMA_VERSION } from "@fusion/core";
import { CccPrdCustodyError } from "../ccc-prd/custody.js";
import {
  runCccPrdChunkAttempt,
  type CccPrdChunkAttemptTransport,
} from "../ccc-prd/chunk-verification.js";
import { analyzeCccPrdMaterialCoverage } from "../ccc-prd/material-coverage.js";

/*
Defect (2026-08-05): chunk-verification.ts:382 does a bare JSON.parse on the
chunked-lane authoring response with no fence tolerance. The single-shot lane
got `stripOutermostJsonFence` (native-authoring-adapter.ts) after a real
acceptance-run failure against glm-5.2; the chunked lane never did. It has
not fired yet only because the one model tested so far happened not to fence
in this lane -- any model that does will hard-fail every chunk on
CCC_PRD_ATTEMPTS_EXHAUSTED / "fragment response is not valid JSON".

These tests exercise the wiring in chunk-verification.ts (via
runCccPrdChunkAttempt), not the shared stripOutermostJsonFence function
itself -- that function is already correct and already covered by
ccc-prd-fence-tolerance.test.ts. The bug is that chunk-verification.ts never
calls it.
*/

const SOURCE_PATH = "doc.md";
const PROVIDER = "local-omlx";
const MODEL = "dense-27b";

function fixture() {
  const text = ["# Alpha", "- REQ-1: alpha must ship a health endpoint."].join("\n") + "\n";
  const fullSourceBytes = Buffer.from(text, "utf8");
  return { fullSourceBytes, sliceBounds: { byteStart: 0, byteEnd: fullSourceBytes.byteLength } };
}

/**
 * Runs a single-attempt chunk against a raw transport response and returns
 * the CCC_PRD_CHUNK_ATTEMPTS_EXHAUSTED message. `{"a":1}` is deliberately
 * shaped JSON: it parses fine but fails fragment-shape verification with a
 * distinctive "schema must be" violation. That gives a differential signal
 * that does not depend on the fix succeeding end to end -- if JSON.parse
 * threw on the raw (unstripped) text, the surviving violation is the fixed
 * string "fragment response is not valid JSON" instead.
 */
async function exhaustedMessageFor(responseText: string): Promise<string> {
  const { fullSourceBytes, sliceBounds } = fixture();
  const transport: CccPrdChunkAttemptTransport = vi.fn(async () => (
    { provider: PROVIDER, model: MODEL, text: responseText }
  ));

  let thrown: unknown;
  try {
    await runCccPrdChunkAttempt({
      chunkId: "doc.md#0",
      sourcePath: SOURCE_PATH,
      fullSourceBytes,
      sliceBounds,
      assignedMaterialItemIds: [],
      expectedProvider: PROVIDER,
      expectedModel: MODEL,
      transport,
      buildPrompt: () => "prompt",
      maxChunkAttempts: 1,
    });
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(CccPrdCustodyError);
  expect((thrown as CccPrdCustodyError).code).toBe("CCC_PRD_CHUNK_ATTEMPTS_EXHAUSTED");
  return (thrown as CccPrdCustodyError).message;
}

describe("chunked-lane fence tolerance -- must strip a whole-response fence wrapper", () => {
  it("a: strips a ```json fenced response with a language tag", async () => {
    const message = await exhaustedMessageFor("```json\n{\"a\":1}\n```");
    expect(message).not.toContain("fragment response is not valid JSON");
    expect(message).toContain("schema must be");
  });

  it("b: strips a fenced response with a trailing newline after the closing fence", async () => {
    const message = await exhaustedMessageFor("```json\n{\"a\":1}\n```\n");
    expect(message).not.toContain("fragment response is not valid JSON");
    expect(message).toContain("schema must be");
  });

  it("c: strips a fenced response with leading whitespace before the opening fence", async () => {
    const message = await exhaustedMessageFor("\n```json\n{\"a\":1}\n```");
    expect(message).not.toContain("fragment response is not valid JSON");
    expect(message).toContain("schema must be");
  });

  it("d: strips a bare fence with no language tag", async () => {
    const message = await exhaustedMessageFor("```\n{\"a\":1}\n```\n");
    expect(message).not.toContain("fragment response is not valid JSON");
    expect(message).toContain("schema must be");
  });
});

describe("chunked-lane fence tolerance -- must never strip (safety net)", () => {
  it("f: prose before the fence still fails loudly as invalid JSON", async () => {
    const message = await exhaustedMessageFor("Here you go:\n```json\n{\"a\":1}\n```");
    expect(message).toContain("fragment response is not valid JSON");
  });

  it("g: prose after the closing fence still fails loudly as invalid JSON", async () => {
    const message = await exhaustedMessageFor("```json\n{\"a\":1}\n```\nThanks!");
    expect(message).toContain("fragment response is not valid JSON");
  });

  it("h: a truncated response with no closing fence still fails loudly as invalid JSON", async () => {
    const message = await exhaustedMessageFor("```json\n{\"a\":1}");
    expect(message).toContain("fragment response is not valid JSON");
  });

  it("e: a quote genuinely containing fence characters survives byte-identical through the whole outer fence", async () => {
    const embeddedFenceQuote = "- REQ-1: use ```json fence markers exactly.";
    const text = ["# Alpha", embeddedFenceQuote].join("\n") + "\n";
    const fullSourceBytes = Buffer.from(text, "utf8");
    const sliceBounds = { byteStart: 0, byteEnd: fullSourceBytes.byteLength };

    const inventory = analyzeCccPrdMaterialCoverage({
      sourceBytes: new Map([[SOURCE_PATH, fullSourceBytes]]),
      requirements: [],
      tasks: [],
      unresolvedDecisions: [],
    }).inventory;
    const sectionItemId = inventory.find((item) => item.materialKind === "section")!.id;
    const requirementItemId = inventory.find((item) => item.materialKind === "requirement")!.id;

    const fragment = {
      schema: CCC_PRD_AUTHORING_PROPOSAL_FRAGMENT_SCHEMA_VERSION,
      authorityRoles: [],
      requirements: [{
        id: "REQ-1",
        statement: "alpha must ship a health endpoint",
        acceptance: "GET /health returns 200",
        accountableProducer: "team-a",
        dependencies: [],
        proofIds: [],
        confidence: "high",
        sourceRefs: [{ path: SOURCE_PATH, exactQuote: embeddedFenceQuote }],
      }],
      proofs: [],
      tasks: [{
        id: "TASK-1",
        title: "Ship health endpoint",
        description: "Implement GET /health",
        accountableProducer: "team-a",
        requirementIds: ["REQ-1"],
        dependencyTaskIds: [],
        proofIds: [],
        workflowId: "",
        documentIds: [],
        artifactIds: [],
        protectedActionIds: [],
        ownedPaths: ["src/health.ts"],
        allowedWriteRoots: ["src/health.ts"],
        sourceRefs: [{ path: SOURCE_PATH, exactQuote: `# Alpha\n${embeddedFenceQuote}` }],
      }],
      edges: [],
      workflows: [],
      documents: [],
      artifacts: [],
      importIntents: [],
      protectedActions: [],
      unresolvedDecisions: [],
      ambiguities: [],
      exceptions: [],
    };

    // The whole response is wrapped in a real outer fence (the modelled
    // defect), and the requirement's own quote genuinely contains fence
    // characters mid-string. Only the outer wrapper may be stripped.
    const responseText = "```json\n" + JSON.stringify(fragment) + "\n```\n";
    const transport: CccPrdChunkAttemptTransport = vi.fn(async () => (
      { provider: PROVIDER, model: MODEL, text: responseText }
    ));

    const resolved = await runCccPrdChunkAttempt({
      chunkId: "doc.md#0",
      sourcePath: SOURCE_PATH,
      fullSourceBytes,
      sliceBounds,
      assignedMaterialItemIds: [sectionItemId, requirementItemId],
      expectedProvider: PROVIDER,
      expectedModel: MODEL,
      transport,
      buildPrompt: () => "prompt",
      maxChunkAttempts: 1,
    });

    const span = resolved.requirements[0]!.spans[0]!;
    const extracted = fullSourceBytes.subarray(span.byteStart, span.byteEnd).toString("utf8");
    expect(extracted).toBe(embeddedFenceQuote);
  });
});
