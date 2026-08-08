/*
Regression guard for the maxTokens-derivation fix in
native-authoring-adapter.ts (fusionModelRuntimeAuthoringTransport):
maxResponseBytes must still gate response size via the two byte guards
(mid-stream and final) after maxTokens stopped being derived from it. This
exercises the real wire path (same harness as
custom-provider-keyless-loopback.test.ts and
ccc-prd-authoring-max-tokens-unit.test.ts) with an oversized streamed
response and asserts the transport still throws the exceeded-bytes error.
*/
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveGlobalDirForHome, type CustomProvider } from "@fusion/core";
import { fusionModelRuntimeAuthoringTransport } from "../ccc-prd/native-authoring-adapter.js";

function writeCustomProviders(home: string, providers: CustomProvider[]): void {
  const globalDir = resolveGlobalDirForHome(home);
  mkdirSync(globalDir, { recursive: true });
  writeFileSync(join(globalDir, "settings.json"), JSON.stringify({ customProviders: providers }));
}

describe("fusionModelRuntimeAuthoringTransport byte guard (real authoring transport)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("still throws the exceeded-bytes error for an oversized streamed response after the maxTokens fix", async () => {
    // A model.maxTokens far larger than maxResponseBytes proves the byte
    // guard fires on its own terms, independent of the (now-fixed) token
    // budget -- this is the exact scenario the maxTokens fix touched.
    const oversizedContent = "x".repeat(200);
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(
          `data: ${JSON.stringify({
            id: "chatcmpl-byte-guard",
            object: "chat.completion.chunk",
            model: "test-model",
            choices: [{ index: 0, delta: { role: "assistant", content: oversizedContent }, finish_reason: null }],
          })}\n\n`,
        );
        response.write(
          `data: ${JSON.stringify({
            id: "chatcmpl-byte-guard",
            object: "chat.completion.chunk",
            model: "test-model",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          })}\n\n`,
        );
        response.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;

    const home = mkdtempSync(join(tmpdir(), "ccc-byte-guard-regression-"));
    vi.stubEnv("HOME", home);

    const provider: CustomProvider = {
      id: "c1d2e3f4-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
      name: "Byte Guard Regression Provider",
      apiType: "openai-compatible",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      models: [{ id: "test-model", name: "Test Model", maxTokens: 512_000, contextWindow: 1_000_000 }],
    };
    writeCustomProviders(home, [provider]);

    const controller = new AbortController();
    try {
      await expect(
        fusionModelRuntimeAuthoringTransport({
          provider: "byte-guard-regression-provider",
          model: "test-model",
          prompt: "Hi",
          maxDurationMs: 10_000,
          maxResponseBytes: 32,
          signal: controller.signal,
        }),
      ).rejects.toThrow("CCC PRD authoring response exceeded 32 bytes");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
