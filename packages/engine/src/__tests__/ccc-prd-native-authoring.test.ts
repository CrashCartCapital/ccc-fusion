import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  canonicalCccPrdJson,
  type CccPrdAuthoringProposal,
} from "@fusion/core";
import { authorCccPrdPacket } from "../ccc-prd/authoring.js";
import {
  createNativeCccPrdAuthoringAdapter,
  type CccPrdNativeAuthoringTransport,
} from "../ccc-prd/native-authoring-adapter.js";

const fixture = new URL("./fixtures/ccc-prd-canaries/ccc-lab-super-r2/", import.meta.url);
const manifestPath = new URL("manifest.json", fixture).pathname;
const firstSourcePath = (
  JSON.parse(readFileSync(manifestPath, "utf8")) as {
    entries: Array<{ relative_path: string }>;
  }
).entries[0]!.relative_path;
const proposal = JSON.parse(
  readFileSync(new URL("authoring-response.fixture.json", fixture), "utf8"),
) as CccPrdAuthoringProposal;

const constraints = {
  targetRepository: proposal.targetRepository,
  bounds: proposal.bounds,
  maxReviewItems: 8,
};

function nativeAdapter(
  transport: CccPrdNativeAuthoringTransport,
  overrides: Partial<{
    maxDurationMs: number;
    maxPromptBytes: number;
    maxResponseBytes: number;
  }> = {},
) {
  return createNativeCccPrdAuthoringAdapter({
    provider: "loopback-authoring",
    model: "fixture-model",
    maxDurationMs: overrides.maxDurationMs ?? 5_000,
    maxPromptBytes: overrides.maxPromptBytes ?? 1_000_000,
    maxResponseBytes: overrides.maxResponseBytes ?? 256_000,
    transport,
  });
}

describe("CCC PRD native authoring adapter", () => {
  it("generates a traceable candidate from unchanged packet bytes through one bounded native request", async () => {
    const generate = vi.fn<CccPrdNativeAuthoringTransport>(async (request) => ({
      text: canonicalCccPrdJson(proposal),
      provider: request.provider,
      model: request.model,
    }));
    const adapter = nativeAdapter(generate);

    const result = await authorCccPrdPacket({
      rootDir: fixture.pathname,
      manifestPath,
      adapter,
      constraints,
    });

    expect(result.kind, JSON.stringify(result)).toBe("candidate");
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({
      provider: "loopback-authoring",
      model: "fixture-model",
      maxDurationMs: 5_000,
      maxResponseBytes: 256_000,
      prompt: expect.stringContaining("\"packetHash\""),
    }));
    expect(generate.mock.calls[0]![0].prompt).toContain(
      `"path":${JSON.stringify(firstSourcePath)}`,
    );
    expect(generate.mock.calls[0]![0].prompt).toContain(
      "\"targetRepository\"",
    );
    expect(result).toMatchObject({
      kind: "candidate",
      sidecar: {
        targetRepository: proposal.targetRepository,
        bounds: proposal.bounds,
        provenance: {
          authoringAdapterId: "fusion-native-model-runtime-v1",
          authoringModel: "loopback-authoring/fixture-model",
        },
      },
      review: {
        ambiguities: [],
        unresolvedDecisions: [],
        exceptions: [],
      },
    });
  });

  it("refuses malformed native response text instead of accepting prose", async () => {
    const result = await authorCccPrdPacket({
      rootDir: fixture.pathname,
      manifestPath,
      adapter: nativeAdapter(async (request) => ({
        text: "Here is the sidecar:\n{}",
        provider: request.provider,
        model: request.model,
      })),
      constraints,
    });

    expect(result).toMatchObject({
      kind: "refusal",
      diagnostics: [{ code: "CCC_PRD_AUTHORING_FAILED" }],
    });
  });

  it("refuses malformed proposal rows with the proposal-invalid diagnostic", async () => {
    const malformedProposal = structuredClone(proposal) as { requirements: unknown[] };
    malformedProposal.requirements = [null];

    const result = await authorCccPrdPacket({
      rootDir: fixture.pathname,
      manifestPath,
      adapter: nativeAdapter(async (request) => ({
        text: canonicalCccPrdJson(malformedProposal),
        provider: request.provider,
        model: request.model,
      })),
      constraints,
    });

    expect(result).toMatchObject({
      kind: "refusal",
      diagnostics: [{ code: "CCC_PRD_AUTHORING_PROPOSAL_INVALID" }],
    });
  });

  it("refuses provider or model identity drift from the native transport", async () => {
    const result = await authorCccPrdPacket({
      rootDir: fixture.pathname,
      manifestPath,
      adapter: nativeAdapter(async (request) => ({
        text: canonicalCccPrdJson(proposal),
        provider: request.provider,
        model: "different-model",
      })),
      constraints,
    });

    expect(result).toMatchObject({
      kind: "refusal",
      diagnostics: [{ code: "CCC_PRD_AUTHORING_FAILED" }],
    });
  });

  it("refuses over-large prompts before calling the native transport", async () => {
    const generate = vi.fn<CccPrdNativeAuthoringTransport>();

    const result = await authorCccPrdPacket({
      rootDir: fixture.pathname,
      manifestPath,
      adapter: nativeAdapter(generate, { maxPromptBytes: 1 }),
      constraints,
    });

    expect(generate).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      kind: "refusal",
      diagnostics: [{ code: "CCC_PRD_AUTHORING_FAILED" }],
    });
  });

  it("refuses over-large native responses after the bounded request", async () => {
    const generate = vi.fn<CccPrdNativeAuthoringTransport>(async (request) => ({
      text: canonicalCccPrdJson(proposal),
      provider: request.provider,
      model: request.model,
    }));

    const result = await authorCccPrdPacket({
      rootDir: fixture.pathname,
      manifestPath,
      adapter: nativeAdapter(generate, { maxResponseBytes: 1 }),
      constraints,
    });

    expect(generate).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      kind: "refusal",
      diagnostics: [{ code: "CCC_PRD_AUTHORING_FAILED" }],
    });
  });

  it("refuses generated review lists that exceed the admitted human-review bound", async () => {
    const excessiveReview = structuredClone(proposal);
    excessiveReview.ambiguities = [{
      id: "AMBIGUITY-EXTRA-001",
      statement: "The packet contains an extra unresolved phrasing question.",
      sourceRefs: proposal.requirements[0]!.sourceRefs,
    }];

    const result = await authorCccPrdPacket({
      rootDir: fixture.pathname,
      manifestPath,
      adapter: nativeAdapter(async (request) => ({
        text: canonicalCccPrdJson(excessiveReview),
        provider: request.provider,
        model: request.model,
      })),
      constraints: {
        ...constraints,
        maxReviewItems: 1,
      },
    });

    expect(result).toMatchObject({
      kind: "refusal",
      diagnostics: [{ code: "CCC_PRD_AUTHORING_REVIEW_UNBOUNDED" }],
    });
  });

  it("accepts a zero-item review ceiling when the proposal has no review entries", async () => {
    const noReview = structuredClone(proposal);
    noReview.protectedActions = [];
    noReview.tasks = noReview.tasks.map((task) => ({
      ...task,
      protectedActionIds: [],
    }));

    const result = await authorCccPrdPacket({
      rootDir: fixture.pathname,
      manifestPath,
      adapter: nativeAdapter(async (request) => ({
        text: canonicalCccPrdJson(noReview),
        provider: request.provider,
        model: request.model,
      })),
      constraints: {
        ...constraints,
        maxReviewItems: 0,
      },
    });

    expect(result.kind, JSON.stringify(result)).toBe("candidate");
  });

  it("refuses stable-ID drift when regenerating the same admitted packet", async () => {
    const firstAdapter = nativeAdapter(async (request) => ({
        text: canonicalCccPrdJson(proposal),
        provider: request.provider,
        model: request.model,
      }));
    const first = await authorCccPrdPacket({
      rootDir: fixture.pathname,
      manifestPath,
      adapter: firstAdapter,
      constraints,
    });
    expect(first.kind).toBe("candidate");
    if (first.kind !== "candidate") throw new Error("expected initial candidate");

    const changed = structuredClone(proposal);
    changed.requirements[0]!.id = "REQ-CHURNED";
    const second = await authorCccPrdPacket({
      rootDir: fixture.pathname,
      manifestPath,
      adapter: nativeAdapter(async (request) => ({
          text: canonicalCccPrdJson(changed),
          provider: request.provider,
          model: request.model,
        })),
      constraints,
      previousSidecar: first.sidecar,
    });

    expect(second).toMatchObject({
      kind: "refusal",
      diagnostics: [{ code: "CCC_PRD_AUTHORING_IDENTITY_DRIFT" }],
    });
  });

  it("accepts an unchanged packet when prior source-bound declarations are reordered", async () => {
    const first = await authorCccPrdPacket({
      rootDir: fixture.pathname,
      manifestPath,
      adapter: nativeAdapter(async (request) => ({
        text: canonicalCccPrdJson(proposal),
        provider: request.provider,
        model: request.model,
      })),
      constraints,
    });
    expect(first.kind).toBe("candidate");
    if (first.kind !== "candidate") throw new Error("expected initial candidate");

    const previousSidecar = structuredClone(first.sidecar);
    previousSidecar.requirements.reverse();
    const second = await authorCccPrdPacket({
      rootDir: fixture.pathname,
      manifestPath,
      adapter: nativeAdapter(async (request) => ({
        text: canonicalCccPrdJson(proposal),
        provider: request.provider,
        model: request.model,
      })),
      constraints,
      previousSidecar,
    });

    expect(second.kind, JSON.stringify(second)).toBe("candidate");
  });

  it("refuses a stable ID that is silently rebound to different source evidence", async () => {
    const first = await authorCccPrdPacket({
      rootDir: fixture.pathname,
      manifestPath,
      adapter: nativeAdapter(async (request) => ({
          text: canonicalCccPrdJson(proposal),
          provider: request.provider,
          model: request.model,
        })),
      constraints,
    });
    expect(first.kind).toBe("candidate");
    if (first.kind !== "candidate") throw new Error("expected initial candidate");

    const rebound = structuredClone(proposal);
    rebound.requirements[0]!.sourceRefs = structuredClone(proposal.requirements[1]!.sourceRefs);
    const second = await authorCccPrdPacket({
      rootDir: fixture.pathname,
      manifestPath,
      adapter: nativeAdapter(async (request) => ({
          text: canonicalCccPrdJson(rebound),
          provider: request.provider,
          model: request.model,
        })),
      constraints,
      previousSidecar: first.sidecar,
    });

    expect(second).toMatchObject({
      kind: "refusal",
      diagnostics: [{ code: "CCC_PRD_AUTHORING_IDENTITY_DRIFT" }],
    });
  });
});
