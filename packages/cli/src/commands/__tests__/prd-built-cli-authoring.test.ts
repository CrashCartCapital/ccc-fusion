import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupPacketRoots, createPacketRoot, repoRoot, runFn, runFnAsync } from "./prd-built-cli-fixture.js";

afterEach(cleanupPacketRoots);

describe("prd native authoring descendant contract", () => {
  it("understands an unchanged packet through one native request without creating an executable sidecar", async () => {
    const packet = createPacketRoot();
    const proposal = JSON.parse(readFileSync(packet.proposal, "utf8")) as {
      targetRepository: { path: string; baseCommit: string };
      bounds: { maxRequests: number; maxDurationMs: number; maxConcurrency: number };
      admittedWriteRoots: unknown[];
    };
    proposal.targetRepository = { path: "", baseCommit: "" };
    proposal.bounds = { maxRequests: 0, maxDurationMs: 0, maxConcurrency: 0 };
    proposal.admittedWriteRoots = [];
    const requests: Array<Record<string, unknown>> = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(`data: ${JSON.stringify({ id: "chatcmpl-ccc-prd-understand", object: "chat.completion.chunk", model: "fixture-model", choices: [{ index: 0, delta: { role: "assistant", content: JSON.stringify(proposal) }, finish_reason: null }] })}\n\n`);
        response.write(`data: ${JSON.stringify({ id: "chatcmpl-ccc-prd-understand", object: "chat.completion.chunk", model: "fixture-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
        response.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const isolatedHome = join(packet.root, "home");
    mkdirSync(join(isolatedHome, ".pi", "fusion"), { recursive: true });
    const address = server.address() as AddressInfo;
    writeFileSync(join(isolatedHome, ".pi", "fusion", "settings.json"), JSON.stringify({ customProviders: [{ id: "550e8400-e29b-41d4-a716-446655440003", name: "Loopback Understanding", apiType: "openai-compatible", baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "LOCAL_FIXTURE_KEY", models: [{ id: "fixture-model", name: "Fixture Model", verbatimCapable: true }] }] }));
    const reviewPath = join(packet.root, "understanding-review.json");

    try {
      const understood = await runFnAsync([
        "prd", "understand", packet.root, packet.manifest, reviewPath,
        "--provider", "loopback-understanding", "--model", "fixture-model",
        "--max-duration-ms", "30000", "--max-prompt-bytes", "1000000", "--max-response-bytes", "262144", "--max-review-items", "8",
      ], repoRoot, { HOME: isolatedHome, USERPROFILE: isolatedHome });
      expect(understood.status, `${understood.stdout}\n${understood.stderr}`).toBe(0);
      expect(requests).toHaveLength(1);
      expect(JSON.stringify(requests[0])).toContain("review-only");
      expect(JSON.parse(understood.stdout)).toMatchObject({
        schema: "ccc-prd.understanding-review.v1",
        kind: "understanding-review",
        executable: false,
        reviewPath,
        implementationContext: {
          approvalStatus: "unapproved",
          targetRepository: { path: null, baseCommit: null },
          missingFacts: expect.arrayContaining([
            expect.objectContaining({ code: "CCC_PRD_TARGET_REPOSITORY_REQUIRED" }),
          ]),
        },
      });
      expect(JSON.parse(readFileSync(reviewPath, "utf8"))).toMatchObject({
        schema: "ccc-prd.understanding-review.v1",
        executable: false,
      });
      expect(runFn([
        "prd", "validate", packet.root, packet.manifest, reviewPath, packet.target, packet.base,
      ]).status).toBe(1);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("authors from an unchanged packet through one bounded native loopback request without a proposal argument", async () => {
    const packet = createPacketRoot({ semanticV2: true });
    const proposal = readFileSync(packet.proposal, "utf8");
    const requests: Array<Record<string, unknown>> = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(`data: ${JSON.stringify({ id: "chatcmpl-ccc-prd-author", object: "chat.completion.chunk", model: "fixture-model", choices: [{ index: 0, delta: { role: "assistant", content: proposal }, finish_reason: null }] })}\n\n`);
        response.write(`data: ${JSON.stringify({ id: "chatcmpl-ccc-prd-author", object: "chat.completion.chunk", model: "fixture-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
        response.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const isolatedHome = join(packet.root, "home");
    mkdirSync(join(isolatedHome, ".pi", "fusion"), { recursive: true });
    const address = server.address() as AddressInfo;
    writeFileSync(join(isolatedHome, ".pi", "fusion", "settings.json"), JSON.stringify({ customProviders: [{ id: "550e8400-e29b-41d4-a716-446655440003", name: "Loopback Authoring", apiType: "openai-compatible", baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "LOCAL_FIXTURE_KEY", models: [{ id: "fixture-model", name: "Fixture Model", verbatimCapable: true }] }] }));

    try {
      const author = await runFnAsync([
        "prd", "author", packet.root, packet.manifest, packet.sidecar,
        "--target", packet.target, "--base", packet.base, "--provider", "loopback-authoring", "--model", "fixture-model",
        "--max-requests", "1", "--max-duration-ms", "30000", "--max-concurrency", "1", "--max-prompt-bytes", "1000000", "--max-response-bytes", "262144", "--max-review-items", "8",
      ], repoRoot, { HOME: isolatedHome, USERPROFILE: isolatedHome });
      expect(author.status, `${author.stdout}\n${author.stderr}`).toBe(0);
      expect(requests).toHaveLength(1);
      expect(JSON.stringify(requests[0])).toContain("Dense PRD Packet");
      expect(JSON.parse(author.stdout)).toMatchObject({ kind: "candidate", sidecarPath: packet.sidecar, review: { ambiguities: [], unresolvedDecisions: [], exceptions: [], protectedActions: [expect.objectContaining({ id: "ACTION-CLI-001", target: "fixture/repo:provider-canary" })] } });
      expect(JSON.parse(readFileSync(packet.sidecar, "utf8"))).toMatchObject({
        schema: "ccc-prd.sidecar.v2",
        provenance: { authoringAdapterId: "fusion-native-model-runtime-v1" },
      });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }, 60_000);
});
