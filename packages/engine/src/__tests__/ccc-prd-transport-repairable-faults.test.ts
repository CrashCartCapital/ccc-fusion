/*
Audit findings F2/F3/F4: the transport's output-size faults were fatal.

`fusionModelRuntimeAuthoringTransport` threw a bare `Error` when the model
stopped for any reason other than "stop" (native-authoring-adapter.ts:301) and
when the response passed maxResponseBytes (:294, :310), as did the chunk lane's
own response guard (chunk-authoring-adapter.ts:220). All four are awaited at
chunk-verification.ts:535, which sits outside every try/catch in the retry
loop, so running out of output room -- the single most likely thing a large
chunk does -- killed the whole document.

Nothing about "you produced too much" is unrecoverable: it is an instruction a
retry can act on. These prove the faults now carry a code, an explicit
retryEligible attribute, and a message naming both the offending value and the
bound -- and that the chunk retry loop actually repairs rather than aborts.
*/
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CCC_PRD_AUTHORING_PROPOSAL_FRAGMENT_SCHEMA_VERSION,
  resolveGlobalDirForHome,
  type CustomProvider,
} from "@fusion/core";
import { createCccPrdChunkTransportCaller } from "../ccc-prd/chunk-authoring-adapter.js";
import { runCccPrdChunkAttempt } from "../ccc-prd/chunk-verification.js";
import { fusionModelRuntimeAuthoringTransport } from "../ccc-prd/native-authoring-adapter.js";

type ThrownFault = Error & { code?: unknown; retryEligible?: unknown };

async function rejectionOf(promise: Promise<unknown>): Promise<ThrownFault> {
  try {
    await promise;
  } catch (error) {
    return error as ThrownFault;
  }
  throw new Error("expected the call to reject, but it resolved");
}

const VERBATIM_CAPABLE_PROVIDERS: CustomProvider[] = [{
  id: "b7c8d9e0-1f2a-4b3c-8d4e-5f6a7b8c9d0e",
  name: "Repairable Faults",
  apiType: "openai-compatible",
  baseUrl: "http://127.0.0.1:7998/v1",
  apiKey: "synthetic-never-read",
  models: [{ id: "fixture-model", name: "Fixture", verbatimCapable: true }],
}];

/**
 * The same real-wire harness ccc-prd-authoring-byte-guard-regression.test.ts
 * uses: a local SSE server plus a stubbed HOME holding a loopback custom
 * provider, so the transport runs its true path rather than a mock of it.
 */
async function startModelServer(
  deltas: Array<{ content?: string; finishReason?: string | null }>,
): Promise<{ server: Server; port: number }> {
  const server = createServer((request, response) => {
    request.on("data", () => undefined);
    request.on("end", () => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const delta of deltas) {
        response.write(`data: ${JSON.stringify({
          id: "chatcmpl-repairable",
          object: "chat.completion.chunk",
          model: "test-model",
          choices: [{
            index: 0,
            delta: delta.content === undefined ? {} : { role: "assistant", content: delta.content },
            finish_reason: delta.finishReason ?? null,
          }],
          ...(delta.finishReason ? { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } : {}),
        })}\n\n`);
      }
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const home = mkdtempSync(join(tmpdir(), "ccc-repairable-faults-"));
  vi.stubEnv("HOME", home);
  const globalDir = resolveGlobalDirForHome(home);
  mkdirSync(globalDir, { recursive: true });
  writeFileSync(join(globalDir, "settings.json"), JSON.stringify({
    customProviders: [{
      id: "a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
      name: "Repairable Faults Wire",
      apiType: "openai-compatible",
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
      models: [{ id: "test-model", name: "Test Model", maxTokens: 512_000, contextWindow: 1_000_000 }],
    }],
  }));
  return { server, port: (server.address() as AddressInfo).port };
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function emptyFragment(): Record<string, unknown> {
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
  };
}

describe("transport output-size faults are repairable, not fatal", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("classifies a response truncated at the model's token ceiling as repairable and names the stop reason", async () => {
    const { server } = await startModelServer([
      { content: "{\"schema\":" },
      { finishReason: "length" },
    ]);
    const controller = new AbortController();
    try {
      const fault = await rejectionOf(fusionModelRuntimeAuthoringTransport({
        provider: "repairable-faults-wire",
        model: "test-model",
        prompt: "Hi",
        maxDurationMs: 10_000,
        maxResponseBytes: 65_536,
        signal: controller.signal,
      }));

      expect(fault.code).toBe("CCC_PRD_AUTHORING_RESPONSE_TRUNCATED");
      expect(fault.retryEligible).toBe(true);
      // Gradient: the retry has to learn WHY it was cut off and what to do.
      expect(fault.message).toContain("length");
      expect(fault.message).toContain("fewer rows");
    } finally {
      await closeServer(server);
    }
  });

  it.each([
    {
      label: "tool request",
      providerFinishReason: "tool_calls",
      expectedStopReason: "toolUse",
      expectedDetail: "incomplete response",
    },
    {
      label: "provider error",
      providerFinishReason: "content_filter",
      expectedStopReason: "error",
      expectedDetail: "Provider finish_reason: content_filter",
    },
  ])("keeps a $label strict and non-repairable", async ({
    providerFinishReason,
    expectedStopReason,
    expectedDetail,
  }) => {
    const { server } = await startModelServer([
      { content: "partial output" },
      { finishReason: providerFinishReason },
    ]);
    const controller = new AbortController();
    try {
      const fault = await rejectionOf(fusionModelRuntimeAuthoringTransport({
        provider: "repairable-faults-wire",
        model: "test-model",
        prompt: "Hi",
        maxDurationMs: 10_000,
        maxResponseBytes: 65_536,
        signal: controller.signal,
      }));

      expect(fault.code).not.toBe("CCC_PRD_AUTHORING_RESPONSE_TRUNCATED");
      expect(fault.retryEligible).toBeUndefined();
      expect(fault.message).toContain(expectedStopReason);
      expect(fault.message).toContain(expectedDetail);
      expect(fault.message).not.toContain("fewer rows");
      expect(fault.message).not.toContain("output-token limit");
    } finally {
      await closeServer(server);
    }
  });

  it("keeps caller cancellation strict and non-repairable", async () => {
    const { server } = await startModelServer([
      { content: "unused" },
      { finishReason: "stop" },
    ]);
    const controller = new AbortController();
    controller.abort(new Error("operator cancelled authoring"));
    try {
      const fault = await rejectionOf(fusionModelRuntimeAuthoringTransport({
        provider: "repairable-faults-wire",
        model: "test-model",
        prompt: "Hi",
        maxDurationMs: 10_000,
        maxResponseBytes: 65_536,
        signal: controller.signal,
      }));

      expect(fault.code).not.toBe("CCC_PRD_AUTHORING_RESPONSE_TRUNCATED");
      expect(fault.retryEligible).toBeUndefined();
      expect(fault.message).toContain("aborted");
      expect(fault.message).not.toContain("fewer rows");
      expect(fault.message).not.toContain("output-token limit");
    } finally {
      await closeServer(server);
    }
  });

  it("classifies an oversized streamed response as repairable and names the byte count and the bound", async () => {
    const { server } = await startModelServer([
      { content: "x".repeat(200) },
      { finishReason: "stop" },
    ]);
    const controller = new AbortController();
    try {
      const fault = await rejectionOf(fusionModelRuntimeAuthoringTransport({
        provider: "repairable-faults-wire",
        model: "test-model",
        prompt: "Hi",
        maxDurationMs: 10_000,
        maxResponseBytes: 32,
        signal: controller.signal,
      }));

      expect(fault.code).toBe("CCC_PRD_AUTHORING_RESPONSE_OVERSIZED");
      expect(fault.retryEligible).toBe(true);
      expect(fault.message).toContain("32");
    } finally {
      await closeServer(server);
    }
  });

  it("repairs an oversized chunk response instead of killing the document", async () => {
    const fragmentText = JSON.stringify(emptyFragment());
    const prompts: string[] = [];
    let call = 0;

    const transport = createCccPrdChunkTransportCaller({
      provider: "repairable-faults",
      model: "fixture-model",
      maxDurationMs: 10_000,
      maxPromptBytes: 1_000_000,
      maxResponseBytes: 400,
      customProviders: VERBATIM_CAPABLE_PROVIDERS,
      transport: async () => {
        call += 1;
        return {
          provider: "repairable-faults",
          model: "fixture-model",
          // Attempt 1 blows the 400-byte response ceiling; attempt 2 fits.
          text: call === 1 ? `${fragmentText}${"x".repeat(500)}` : fragmentText,
        };
      },
    });

    const resolved = await runCccPrdChunkAttempt({
      chunkId: "doc.md#0",
      sourcePath: "doc.md",
      fullSourceBytes: Buffer.from("hello\n", "utf8"),
      sliceBounds: { byteStart: 0, byteEnd: 6 },
      assignedMaterialItemIds: [],
      expectedProvider: "repairable-faults",
      expectedModel: "fixture-model",
      transport: async (request) => {
        prompts.push(request.prompt);
        return transport(request);
      },
      buildPrompt: (priorViolations) => `PROMPT>>${priorViolations.join(" | ")}`,
    });

    expect(resolved.requirements).toEqual([]);
    expect(call).toBe(2);
    // The repair prompt must carry the fault, or the second attempt is a blind guess.
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("maximum is 400");
    expect(prompts[1]).toContain("fewer rows");
  });
});
