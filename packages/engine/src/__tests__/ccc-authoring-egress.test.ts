import { describe, it, expect, vi } from "vitest";
import type { CustomProvider } from "@fusion/core";
import {
  createNativeCccPrdAuthoringAdapter,
  type CccPrdNativeAuthoringTransport,
} from "../ccc-prd/native-authoring-adapter.js";

/*
FNXC:CCCAuthoringEgress 2026-08-01-17:40:
`fn prd author` and `fn prd understand` serialize the whole admitted PRD corpus
into one prompt. That corpus is the material the ccc-fusion loopback boundary
exists to contain, so the authoring transport must resolve its selected provider
to a configured loopback custom provider BEFORE the prompt is built. These tests
prove ordering, not just outcome: an execution-mode request with no constraints
would make `buildPrompt` throw its own error, so seeing the egress refusal
instead proves nothing was serialized. Every provider record here is synthetic;
no request leaves the process.
*/

const SECRET_QUOTE = "Frozen baseline commit: 0123456789abcdef0123456789abcdef01234567";

function sources() {
  return [{
    path: "reviewed-operator-decisions.md",
    role: "authoritative",
    authoritative: true,
    sha256: "a".repeat(64),
    byteLength: SECRET_QUOTE.length,
    content: SECRET_QUOTE,
  }];
}

function request() {
  return {
    sourceVersion: "1",
    packetHash: "b".repeat(64),
    sources: sources(),
  };
}

function provider(overrides: Partial<CustomProvider> = {}): CustomProvider {
  return {
    id: "ccc-authoring-provider",
    name: "Loopback Authoring",
    apiType: "openai-compatible",
    baseUrl: "http://127.0.0.1:7443/v1",
    apiKey: "synthetic-never-read",
    // verbatimCapable: true is fixture setup (design §8 finding 4) -- this
    // suite proves egress ordering, not the capability gate itself.
    models: [{ id: "fixture-model", name: "Fixture", verbatimCapable: true }],
    ...overrides,
  } as CustomProvider;
}

function adapter(
  transport: CccPrdNativeAuthoringTransport,
  customProviders: CustomProvider[],
  overrides: Record<string, unknown> = {},
) {
  return createNativeCccPrdAuthoringAdapter({
    provider: "loopback-authoring",
    model: "fixture-model",
    maxDurationMs: 5_000,
    maxPromptBytes: 1_000_000,
    maxResponseBytes: 256_000,
    transport,
    customProviders,
    ...overrides,
  } as never);
}

describe("CCC PRD authoring transports are loopback-only", () => {
  it.each([
    { label: "remote https", baseUrl: "https://api.example.com/v1" },
    { label: "hostname alias", baseUrl: "http://localhost:7443/v1" },
    { label: "IPv6 loopback", baseUrl: "http://[::1]:7443/v1" },
    { label: "userinfo", baseUrl: "http://synthetic-user:synthetic-password@127.0.0.1:7443/v1" },
    { label: "missing port", baseUrl: "http://127.0.0.1/v1" },
  ])("refuses a $label authoring base URL before the prompt is built", async ({ baseUrl }) => {
    const transport = vi.fn<CccPrdNativeAuthoringTransport>();
    const configured = [provider({ baseUrl })];

    let failure: unknown;
    try {
      await adapter(transport, configured).generateCandidate(request() as never);
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({ code: "CCC_PRD_AUTHORING_EGRESS_POLICY_VIOLATION" });
    const message = failure instanceof Error ? failure.message : String(failure);
    expect(message).toContain("loopback-authoring");
    expect(message).not.toContain(baseUrl);
    expect(message).not.toContain("synthetic-password");
    expect(message).not.toContain("synthetic-never-read");
    expect(message).not.toContain(SECRET_QUOTE);
    expect(transport).not.toHaveBeenCalled();
  });

  it("refuses a built-in provider id that no configured custom provider resolves", async () => {
    const transport = vi.fn<CccPrdNativeAuthoringTransport>();

    let failure: unknown;
    try {
      await adapter(transport, [provider()], { provider: "anthropic" }).generateCandidate(request() as never);
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({ code: "CCC_PRD_AUTHORING_EGRESS_POLICY_VIOLATION" });
    expect(failure instanceof Error ? failure.message : "").toContain("anthropic");
    expect(transport).not.toHaveBeenCalled();
  });

  it("refuses when no custom providers are configured at all", async () => {
    const transport = vi.fn<CccPrdNativeAuthoringTransport>();

    let failure: unknown;
    try {
      await adapter(transport, []).generateCandidate(request() as never);
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({ code: "CCC_PRD_AUTHORING_EGRESS_POLICY_VIOLATION" });
    expect(transport).not.toHaveBeenCalled();
  });

  it("refuses an understanding-mode request on the same non-loopback provider", async () => {
    const transport = vi.fn<CccPrdNativeAuthoringTransport>();
    const configured = [provider({ baseUrl: "https://api.example.com/v1" })];

    let failure: unknown;
    try {
      await adapter(transport, configured, { mode: "understanding" }).generateCandidate(request() as never);
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({ code: "CCC_PRD_AUTHORING_EGRESS_POLICY_VIOLATION" });
    expect(transport).not.toHaveBeenCalled();
  });

  it("admits a configured loopback provider and only then reaches prompt construction", async () => {
    const transport = vi.fn<CccPrdNativeAuthoringTransport>();

    // Execution mode with no constraints: `buildPrompt` is the next thing that
    // throws, so this exact error proves the egress guard passed and ran first.
    await expect(adapter(transport, [provider()]).generateCandidate(request() as never)).rejects.toThrow(
      "CCC PRD native authoring requires explicit target, bounds, and review constraints",
    );
    expect(transport).not.toHaveBeenCalled();
  });

  it("serializes the corpus to a loopback provider once the route is admitted", async () => {
    const transport = vi.fn<CccPrdNativeAuthoringTransport>(async (input) => ({
      text: "{}",
      provider: input.provider,
      model: input.model,
    }));

    await expect(
      adapter(transport, [provider()], { mode: "understanding" }).generateCandidate(request() as never),
    ).resolves.toEqual({});
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0]![0].prompt).toContain(SECRET_QUOTE);
  });
});

describe("CCC PRD quote-bearing work requires a declared verbatim-capable route (design D-4)", () => {
  it("test 49: an undeclared route refuses with zero transport calls", async () => {
    const transport = vi.fn<CccPrdNativeAuthoringTransport>();
    // No `verbatimCapable` on the model entry at all -- absent means unknown.
    const undeclared: CustomProvider = {
      ...provider(),
      models: [{ id: "fixture-model", name: "Fixture" }],
    };

    let failure: unknown;
    try {
      await adapter(transport, [undeclared], { mode: "understanding" }).generateCandidate(request() as never);
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({ code: "CCC_PRD_ROUTE_NOT_VERBATIM_CAPABLE" });
    expect(transport).not.toHaveBeenCalled();
  });

  it("an explicit verbatimCapable: false refuses identically to absent", async () => {
    const transport = vi.fn<CccPrdNativeAuthoringTransport>();
    const declaredFalse: CustomProvider = {
      ...provider(),
      models: [{ id: "fixture-model", name: "Fixture", verbatimCapable: false }],
    };

    let failure: unknown;
    try {
      await adapter(transport, [declaredFalse], { mode: "understanding" }).generateCandidate(request() as never);
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({ code: "CCC_PRD_ROUTE_NOT_VERBATIM_CAPABLE" });
    expect(transport).not.toHaveBeenCalled();
  });

  it("test 50: a declared verbatim-capable route is admitted", async () => {
    const transport = vi.fn<CccPrdNativeAuthoringTransport>(async (input) => ({
      text: "{}",
      provider: input.provider,
      model: input.model,
    }));

    await expect(
      adapter(transport, [provider()], { mode: "understanding" }).generateCandidate(request() as never),
    ).resolves.toEqual({});
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("the refusal names only the provider key and model, never the base URL or source text", async () => {
    const transport = vi.fn<CccPrdNativeAuthoringTransport>();
    const undeclared: CustomProvider = {
      ...provider(),
      models: [{ id: "fixture-model", name: "Fixture" }],
    };

    let failure: unknown;
    try {
      await adapter(transport, [undeclared], { mode: "understanding" }).generateCandidate(request() as never);
    } catch (error) {
      failure = error;
    }

    const message = failure instanceof Error ? failure.message : String(failure);
    expect(message).toContain("loopback-authoring");
    expect(message).toContain("fixture-model");
    expect(message).not.toContain("127.0.0.1");
    expect(message).not.toContain(SECRET_QUOTE);
  });
});
