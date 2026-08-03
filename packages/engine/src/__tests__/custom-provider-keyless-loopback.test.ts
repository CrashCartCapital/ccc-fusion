/*
Task #8: a keyless loopback custom provider (e.g. oMLX at 127.0.0.1:8000, which
never reads an Authorization header) failed pi credential resolution through
ccc-prd's real authoring transport. This exercises
fusionModelRuntimeAuthoringTransport (packages/engine/src/ccc-prd/
native-authoring-adapter.ts) exactly as fn prd author/understand invoke it --
via createFusionAuthStorage/createFusionModelRegistry and
registry.modelRuntime.streamSimple with no `apiKey` option -- rather than a
bare ModelRuntime + in-memory credential stub, since that lighter-weight
harness (as used by the sibling custom-providers-openai-completions.test.ts)
does not reproduce this: it never exercises Fusion's own auth-storage wiring.
*/
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
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

describe("keyless loopback custom provider credential resolution (real authoring transport)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("completes fusionModelRuntimeAuthoringTransport against a loopback provider with no configured apiKey", async () => {
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write("data: {\"id\":\"chatcmpl-keyless\",\"object\":\"chat.completion.chunk\",\"model\":\"test-model\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"hi from keyless loopback\"},\"finish_reason\":null}]}\n\n");
        response.write("data: {\"id\":\"chatcmpl-keyless\",\"object\":\"chat.completion.chunk\",\"model\":\"test-model\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":1,\"completion_tokens\":1,\"total_tokens\":2}}\n\n");
        response.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;

    const home = mkdtempSync(join(tmpdir(), "ccc-keyless-loopback-"));
    vi.stubEnv("HOME", home);

    // NOTE: deliberately no `apiKey` field -- a keyless local endpoint.
    const provider: CustomProvider = {
      id: "6f6a6d1e-2e9c-4e2b-9a0a-8f6f6a5e5b10",
      name: "Keyless Loopback",
      apiType: "openai-compatible",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      models: [{ id: "test-model", name: "Test Model" }],
    };
    writeCustomProviders(home, [provider]);

    const controller = new AbortController();
    try {
      const response = await fusionModelRuntimeAuthoringTransport({
        provider: "keyless-loopback",
        model: "test-model",
        prompt: "Hi",
        maxDurationMs: 10_000,
        maxResponseBytes: 4096,
        signal: controller.signal,
      });
      expect(response.text).toContain("hi from keyless loopback");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
