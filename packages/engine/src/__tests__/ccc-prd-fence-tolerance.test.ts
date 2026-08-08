import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CccPrdAuthoringRequest, CustomProvider } from "@fusion/core";
import {
  createNativeCccPrdAuthoringAdapter,
  stripOutermostJsonFence,
} from "../ccc-prd/native-authoring-adapter.js";

/*
Real acceptance run against glm-5.2 (2026-08-05) hard-failed
CCC_PRD_AUTHORING_FAILED even after the outermost-fence-strip fix landed
(72b9c22a7). Diagnosis: the anchored regex only matches when the fence wraps
the ENTIRE response with zero surrounding characters -- a single trailing
newline (which real models emit constantly) defeats it, and because the raw
response text was never persisted on parse failure (Defect B), the exact
trigger byte sequence could not be recovered from the failed run. This file
proves both defects RED first, then must stay GREEN once fixed.

Safety property that must never regress: the strip only applies when the
*entire* (whitespace-trimmed) response is one outermost fence. A quote can
legitimately contain fence characters mid-string; this must never become a
global backtick removal.
*/

describe("stripOutermostJsonFence -- whitespace tolerance around a whole-response fence (Defect A)", () => {
  it("a: strips a trailing newline after the closing fence", () => {
    const input = "```json\n{\"a\":1}\n```\n";
    const stripped = stripOutermostJsonFence(input);
    expect(JSON.parse(stripped)).toEqual({ a: 1 });
  });

  it("b: strips trailing whitespace and blank lines after the closing fence", () => {
    const input = "```json\n{\"a\":1}\n```\n\n  ";
    const stripped = stripOutermostJsonFence(input);
    expect(JSON.parse(stripped)).toEqual({ a: 1 });
  });

  it("c: strips leading whitespace before the opening fence", () => {
    const input = "\n```json\n{\"a\":1}\n```";
    const stripped = stripOutermostJsonFence(input);
    expect(JSON.parse(stripped)).toEqual({ a: 1 });
  });

  it("d: strips leading and trailing whitespace together", () => {
    const input = "\n  ```json\n{\"a\":1}\n```\n\n";
    const stripped = stripOutermostJsonFence(input);
    expect(JSON.parse(stripped)).toEqual({ a: 1 });
  });

  it("e: strips a bare fence with no language tag", () => {
    const input = "```\n{\"a\":1}\n```\n";
    const stripped = stripOutermostJsonFence(input);
    expect(JSON.parse(stripped)).toEqual({ a: 1 });
  });
});

describe("stripOutermostJsonFence -- must never strip (safety property)", () => {
  it("f: a genuine JSON string value that itself contains fence characters survives byte-identical", () => {
    const embeddedQuote = "before fence ```json\n{\"nested\":true}\n``` after fence";
    const whole = JSON.stringify({ quote: embeddedQuote });
    const stripped = stripOutermostJsonFence(whole);
    expect(stripped).toBe(whole);
    const parsed = JSON.parse(stripped) as { quote: string };
    expect(parsed.quote).toBe(embeddedQuote);
  });

  it("g: leaves prose before the fence unstripped (loud failure, not silently rescued)", () => {
    const withProse = "Here you go:\n```json\n{\"a\":1}\n```";
    const stripped = stripOutermostJsonFence(withProse);
    expect(stripped).toBe(withProse);
    expect(() => JSON.parse(stripped)).toThrow();
  });

  it("h: leaves prose after the closing fence unstripped (loud failure, not silently rescued)", () => {
    const withProse = "```json\n{\"a\":1}\n```\nThanks!";
    const stripped = stripOutermostJsonFence(withProse);
    expect(stripped).toBe(withProse);
    expect(() => JSON.parse(stripped)).toThrow();
  });

  it("i: leaves a truncated response with no closing fence unstripped (loud failure, not silently rescued)", () => {
    const truncated = "```json\n{\"a\":1}";
    const stripped = stripOutermostJsonFence(truncated);
    expect(stripped).toBe(truncated);
    expect(() => JSON.parse(stripped)).toThrow();
  });
});

/*
Design §8 finding 4 mirror: verbatimCapable: true here is fixture setup for a
loopback provider, not a claim about a real model's architecture.
*/
const loopbackAuthoringProviders: CustomProvider[] = [
  {
    id: "ccc-loopback-authoring",
    name: "Loopback Authoring",
    apiType: "openai-compatible",
    baseUrl: "http://127.0.0.1:7443/v1",
    apiKey: "synthetic-never-read",
    models: [{ id: "fixture-model", name: "Fixture", verbatimCapable: true }],
  },
];

function minimalUnderstandingRequest(): CccPrdAuthoringRequest {
  return {
    sourceVersion: "fence-tolerance-defect-b",
    packetHash: "deadbeef",
    sources: [],
  };
}

describe("raw authoring response is persisted on JSON.parse failure (Defect B)", () => {
  it("keeps the exact raw response text recoverable instead of discarding it into a truncated error message", async () => {
    const marker = createHash("sha256").update("ccc-prd-fence-tolerance-defect-b").digest("hex");
    const rawUnparsableResponse = `not json at all -- glm-5.2 prose preamble ${marker}`;
    const adapter = createNativeCccPrdAuthoringAdapter({
      provider: "loopback-authoring",
      model: "fixture-model",
      maxDurationMs: 5_000,
      maxPromptBytes: 1_000_000,
      maxResponseBytes: 256_000,
      mode: "understanding",
      customProviders: loopbackAuthoringProviders,
      transport: async (request) => ({
        text: rawUnparsableResponse,
        provider: request.provider,
        model: request.model,
      }),
    });

    let caught: unknown;
    try {
      await adapter.generateCandidate(minimalUnderstandingRequest());
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    const diagnosticPathMatch = /(\/\S+)/u.exec(message);
    expect(diagnosticPathMatch, `error message carried no recoverable path: ${message}`).not.toBeNull();
    const diagnosticPath = diagnosticPathMatch![1]!;
    const persisted = readFileSync(diagnosticPath, "utf8");
    expect(persisted).toBe(rawUnparsableResponse);
  });
});
