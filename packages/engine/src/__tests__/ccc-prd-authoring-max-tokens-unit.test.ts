/*
Bug: native-authoring-adapter.ts's fusionModelRuntimeAuthoringTransport passed
request.maxResponseBytes (a BYTE count from --max-response-bytes) directly into
the transport's `maxTokens` option (a TOKEN count), via
`Math.max(1, Math.min(model.maxTokens, request.maxResponseBytes))`. Bytes and
tokens are different units with no fixed conversion; feeding a byte count into
a token budget silently truncates generation whenever the byte cap is smaller
than the model's real token limit. This exercises the real wire request (same
harness as custom-provider-keyless-loopback.test.ts) to prove the `max_tokens`
value the model actually receives is derived from the model's registered
token limit, not from the byte cap meant only for the response-size guards.
*/
import { createServer, type IncomingMessage } from "node:http";
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

function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    request.on("error", reject);
  });
}

describe("fusionModelRuntimeAuthoringTransport maxTokens derivation (real authoring transport)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("sends the model's registered token limit as maxTokens, not the maxResponseBytes byte count", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const server = createServer((request, response) => {
      void readJsonBody(request).then((body) => {
        capturedBody = body;
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write("data: {\"id\":\"chatcmpl-unit-a\",\"object\":\"chat.completion.chunk\",\"model\":\"test-model\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"ok\"},\"finish_reason\":null}]}\n\n");
        response.write("data: {\"id\":\"chatcmpl-unit-a\",\"object\":\"chat.completion.chunk\",\"model\":\"test-model\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":1,\"completion_tokens\":1,\"total_tokens\":2}}\n\n");
        response.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;

    const home = mkdtempSync(join(tmpdir(), "ccc-max-tokens-unit-"));
    vi.stubEnv("HOME", home);

    // model.maxTokens (512000) is a real TOKEN limit (e.g. MiniMax-M3's
    // advertised output ceiling). maxResponseBytes (64000) is a real BYTE cap
    // (the CLI's documented --max-response-bytes default) that happens to be
    // numerically smaller. Today's bug clamps maxTokens down to the byte
    // number; the fix must not let a byte value participate in this at all.
    const provider: CustomProvider = {
      id: "b8d9e6f2-1a3c-4d5e-9f6a-7b8c9d0e1f20",
      name: "Max Tokens Unit Provider",
      apiType: "openai-compatible",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      // contextWindow is set well above maxTokens so pi-ai's own
      // fits-in-context clamping never binds here -- this test isolates the
      // maxResponseBytes-as-maxTokens bug, not context-window clamping.
      models: [{ id: "test-model", name: "Test Model", maxTokens: 512_000, contextWindow: 1_000_000 }],
    };
    writeCustomProviders(home, [provider]);

    const controller = new AbortController();
    try {
      await fusionModelRuntimeAuthoringTransport({
        provider: "max-tokens-unit-provider",
        model: "test-model",
        prompt: "Hi",
        maxDurationMs: 10_000,
        maxResponseBytes: 64_000,
        signal: controller.signal,
      });
      const sentMaxTokens = capturedBody?.max_tokens ?? capturedBody?.max_completion_tokens;
      expect(sentMaxTokens).toBe(512_000);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
