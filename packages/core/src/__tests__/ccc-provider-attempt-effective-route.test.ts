/**
 * Effective-route and usage/cost receipt substrate — RED proofs for the
 * validation logic at the settlement/terminal-evidence layer.
 *
 * `assertCccProviderAttemptEffectiveRoute` is a pure, side-effect-free
 * function (no database, no transaction) that `reconcileCccProviderAttempt`
 * calls internally to validate and normalize a settlement's effective-route
 * claim before it is persisted. Testing it directly here proves the
 * accept/reject contract without requiring a PostgreSQL-backed harness; the
 * full persist-and-read-back round trip additionally lives in
 * `postgres/ccc-provider-attempt-effective-route.pg.test.ts`, which is
 * PostgreSQL-gated.
 */
import { describe, expect, it } from "vitest";
import {
  assertCccProviderAttemptEffectiveRoute,
  assertCccProviderAttemptLaunchHeadroom,
  CCC_PROVIDER_ATTEMPT_MIN_LAUNCH_HEADROOM_MS,
  sameCccProviderAttemptEffectiveRoute,
} from "../ccc-campaign/provider-attempt.js";
import { CccProviderAttemptIdentityError, CccProviderAttemptLimitError } from "../ccc-campaign/types.js";
import type { CccProviderAttemptEffectiveRouteInput, CccProviderAttemptEffectiveRoute } from "../ccc-campaign/types.js";

const requestedIdentity = { providerId: "anthropic", modelId: "claude-sonnet-5" };

function baseInput(
  overrides: Partial<CccProviderAttemptEffectiveRouteInput> = {},
): CccProviderAttemptEffectiveRouteInput {
  return {
    effectiveProvider: requestedIdentity.providerId,
    effectiveModel: requestedIdentity.modelId,
    usage: { inputTokens: 100, outputTokens: 40 },
    cost: { amountUsd: 0.0123, source: "stream-usage" },
    receiptSource: "stream-usage",
    ...overrides,
  };
}

describe("assertCccProviderAttemptEffectiveRoute", () => {
  it("returns undefined when no effective route is provided (backward-compatible settlement)", () => {
    expect(assertCccProviderAttemptEffectiveRoute(undefined, requestedIdentity)).toBeUndefined();
  });

  it("RED-1: accepts a settlement whose effective identity matches the requested route and returns a frozen receipt with usage and cost", () => {
    const receipt = assertCccProviderAttemptEffectiveRoute(baseInput(), requestedIdentity);
    expect(receipt).toEqual({
      effectiveProvider: "anthropic",
      effectiveModel: "claude-sonnet-5",
      usage: { inputTokens: 100, outputTokens: 40 },
      cost: { amountUsd: 0.0123, source: "stream-usage" },
      receiptSource: "stream-usage",
    });
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(receipt!.usage)).toBe(true);
    expect(Object.isFrozen(receipt!.cost)).toBe(true);
  });

  it("RED-1: carries optional effectiveReasoningEffort and effectiveServiceTier through when present", () => {
    const receipt = assertCccProviderAttemptEffectiveRoute(
      baseInput({ effectiveReasoningEffort: "high", effectiveServiceTier: "priority" }),
      requestedIdentity,
    );
    expect(receipt).toMatchObject({
      effectiveReasoningEffort: "high",
      effectiveServiceTier: "priority",
    });
  });

  it("RED-2: rejects an effectiveModel that differs from the requested route as a route-drift identity refusal, never a record", () => {
    let caught: unknown;
    try {
      assertCccProviderAttemptEffectiveRoute(
        baseInput({ effectiveModel: "claude-opus-5" }),
        requestedIdentity,
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CccProviderAttemptIdentityError);
    expect((caught as CccProviderAttemptIdentityError).reason).toBe("route-drift");
    expect((caught as Error).message).toMatch(/does not match its requested provider and model identity/);
  });

  it("RED-2: rejects an effectiveProvider that differs from the requested route as a route-drift identity refusal", () => {
    expect(() =>
      assertCccProviderAttemptEffectiveRoute(
        baseInput({ effectiveProvider: "openai" }),
        requestedIdentity,
      )
    ).toThrow(CccProviderAttemptIdentityError);
  });

  it("RED-3: rejects a non-null fallbackReason; campaign fallback is not an admitted behavior", () => {
    let caught: unknown;
    try {
      assertCccProviderAttemptEffectiveRoute(
        baseInput({ fallbackReason: "primary provider timed out" }),
        requestedIdentity,
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CccProviderAttemptIdentityError);
    expect((caught as CccProviderAttemptIdentityError).reason).toBe("invalid-input");
    expect((caught as Error).message).toMatch(/fallback is not an admitted behavior/);
  });

  it("accepts an explicit null fallbackReason (the honest, admitted value)", () => {
    expect(() =>
      assertCccProviderAttemptEffectiveRoute(baseInput({ fallbackReason: null }), requestedIdentity)
    ).not.toThrow();
  });

  it("RED-4: rejects a cost claim (amountUsd) when usage is null, naming the missing receipt", () => {
    let caught: unknown;
    try {
      assertCccProviderAttemptEffectiveRoute(
        baseInput({ usage: null, cost: { amountUsd: 1.5, source: "provider-api" }, receiptSource: "provider-api" }),
        requestedIdentity,
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CccProviderAttemptIdentityError);
    expect((caught as CccProviderAttemptIdentityError).reason).toBe("invalid-input");
    expect((caught as Error).message).toMatch(/cannot claim a cost without/);
  });

  it("RED-4: rejects a cost claim (amountUsd) when receiptSource is none, naming the missing receipt", () => {
    let caught: unknown;
    try {
      assertCccProviderAttemptEffectiveRoute(
        baseInput({ receiptSource: "none" }),
        requestedIdentity,
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CccProviderAttemptIdentityError);
    expect((caught as CccProviderAttemptIdentityError).reason).toBe("invalid-input");
    expect((caught as Error).message).toMatch(/cannot claim a cost without/);
  });

  it("RED-5: accepts usage null with cost {kind: unknown, reason} — honest unknown is legal", () => {
    const receipt = assertCccProviderAttemptEffectiveRoute(
      baseInput({
        usage: null,
        cost: { kind: "unknown", reason: "provider did not emit usage on this transport" },
        receiptSource: "none",
      }),
      requestedIdentity,
    );
    expect(receipt).toEqual({
      effectiveProvider: "anthropic",
      effectiveModel: "claude-sonnet-5",
      usage: null,
      cost: { kind: "unknown", reason: "provider did not emit usage on this transport" },
      receiptSource: "none",
    });
  });

  it("accepts usage present with cost {kind: unknown, reason} even though usage exists (honesty is about the claim, not the data)", () => {
    expect(() =>
      assertCccProviderAttemptEffectiveRoute(
        baseInput({ cost: { kind: "unknown", reason: "pricing table lookup failed" } }),
        requestedIdentity,
      )
    ).not.toThrow();
  });

  it("rejects usage with non-integer token counts", () => {
    expect(() =>
      assertCccProviderAttemptEffectiveRoute(
        baseInput({ usage: { inputTokens: 1.5, outputTokens: 0 } }),
        requestedIdentity,
      )
    ).toThrow(CccProviderAttemptIdentityError);
  });

  it("rejects usage with negative token counts", () => {
    expect(() =>
      assertCccProviderAttemptEffectiveRoute(
        baseInput({ usage: { inputTokens: -1, outputTokens: 0 } }),
        requestedIdentity,
      )
    ).toThrow(CccProviderAttemptIdentityError);
  });

  it("rejects a cost claim with a negative amountUsd", () => {
    expect(() =>
      assertCccProviderAttemptEffectiveRoute(
        baseInput({ cost: { amountUsd: -0.01, source: "stream-usage" } }),
        requestedIdentity,
      )
    ).toThrow(CccProviderAttemptIdentityError);
  });

  it("rejects a cost object with an invalid shape", () => {
    expect(() =>
      assertCccProviderAttemptEffectiveRoute(
        baseInput({ cost: { kind: "unknown" } as unknown as CccProviderAttemptEffectiveRouteInput["cost"] }),
        requestedIdentity,
      )
    ).toThrow(CccProviderAttemptIdentityError);
  });

  it("rejects an invalid receiptSource", () => {
    expect(() =>
      assertCccProviderAttemptEffectiveRoute(
        baseInput({ receiptSource: "guess" as unknown as CccProviderAttemptEffectiveRouteInput["receiptSource"] }),
        requestedIdentity,
      )
    ).toThrow(CccProviderAttemptIdentityError);
  });

  it("rejects an effective route object carrying an unexpected extra field", () => {
    expect(() =>
      assertCccProviderAttemptEffectiveRoute(
        { ...baseInput(), unexpectedField: "nope" } as unknown as CccProviderAttemptEffectiveRouteInput,
        requestedIdentity,
      )
    ).toThrow(CccProviderAttemptIdentityError);
  });

  it("rejects an effective route object missing a required field", () => {
    const { receiptSource: _drop, ...missingReceiptSource } = baseInput();
    expect(() =>
      assertCccProviderAttemptEffectiveRoute(
        missingReceiptSource as unknown as CccProviderAttemptEffectiveRouteInput,
        requestedIdentity,
      )
    ).toThrow(CccProviderAttemptIdentityError);
  });

  describe("OmniRoute terminal receipt", () => {
    const receiptAdapterOptions = {
      receiptAdapterId: "terminal-route-sse-comments.v1",
    } as const;
    const omniRouteIdentity = {
      providerId: "omniroute-minimax-m3-pinned",
      modelId: "minimax/MiniMax-M3",
    };

    const omniRouteReceipt = {
      initial: { provider: "minimax", model: "MiniMax-M3" },
      final: { provider: "minimax", model: "MiniMax-M3" },
    };

    const omniRouteInput = (
      overrides: Partial<CccProviderAttemptEffectiveRouteInput> = {},
    ): CccProviderAttemptEffectiveRouteInput => ({
      effectiveProvider: omniRouteIdentity.providerId,
      effectiveModel: omniRouteIdentity.modelId,
      usage: { inputTokens: 100, outputTokens: 40 },
      cost: { amountUsd: 0.0123, source: "stream-usage" },
      receiptSource: "stream-usage",
      ...overrides,
    });

    it("allows a proved-failed settlement to omit the terminal route receipt that never arrived", () => {
      expect(assertCccProviderAttemptEffectiveRoute(
        undefined,
        omniRouteIdentity,
        { ...receiptAdapterOptions, terminalReceiptRequired: false },
      )).toBeUndefined();
    });

    it("still requires a terminal route receipt for a committed OmniRoute settlement", () => {
      expect(() => assertCccProviderAttemptEffectiveRoute(
        undefined,
        omniRouteIdentity,
        { ...receiptAdapterOptions, terminalReceiptRequired: true },
      )).toThrow(CccProviderAttemptIdentityError);
    });

    it("RED-OMNI-1: persists the exact initial/final allowlisted receipt for a provider-qualified route", () => {
      const receipt = assertCccProviderAttemptEffectiveRoute(
        omniRouteInput({ omniRoute: omniRouteReceipt }),
        omniRouteIdentity,
        receiptAdapterOptions,
      );
      expect(receipt?.omniRoute).toEqual(omniRouteReceipt);
    });

    it.each([
      { label: "missing nested receipt", overrides: {} },
      { label: "missing final provider", overrides: { omniRoute: { initial: omniRouteReceipt.initial, final: { model: "MiniMax-M3" } } } },
      { label: "missing final model", overrides: { omniRoute: { initial: omniRouteReceipt.initial, final: { provider: "minimax" } } } },
    ])("RED-OMNI-2: refuses $label for a newly declared OmniRoute route", ({ overrides }) => {
      expect(() => assertCccProviderAttemptEffectiveRoute(
        omniRouteInput(overrides),
        omniRouteIdentity,
        receiptAdapterOptions,
      ))
        .toThrow(CccProviderAttemptIdentityError);
    });

    it.each([
      { label: "initial/final provider conflict", omniRoute: { initial: { provider: "minimax", model: "MiniMax-M3" }, final: { provider: "opencode-go", model: "MiniMax-M3" } } },
      { label: "initial/final model conflict", omniRoute: { initial: { provider: "minimax", model: "MiniMax-M3" }, final: { provider: "minimax", model: "minimax-m3" } } },
      { label: "provider drift", omniRoute: { initial: { provider: "opencode-go", model: "minimax-m3" }, final: { provider: "opencode-go", model: "minimax-m3" } } },
      { label: "model alias drift", omniRoute: { initial: { provider: "minimax", model: "minimax-m3" }, final: { provider: "minimax", model: "minimax-m3" } } },
      { label: "fallback model", omniRoute: { initial: { provider: "minimax", model: "MiniMax-M3" }, final: { provider: "minimax", model: "glm-5.3" } } },
    ])("RED-OMNI-3: refuses $label instead of normalizing upstream identity", ({ omniRoute }) => {
      expect(() => assertCccProviderAttemptEffectiveRoute(
        omniRouteInput({ omniRoute }),
        omniRouteIdentity,
        receiptAdapterOptions,
      ))
        .toThrow(CccProviderAttemptIdentityError);
    });

    /*
     * When OmniRoute has to wait on a real upstream call it flushes an
     * `: omniroute-keepalive` SSE comment immediately to hold the stream open,
     * which commits the HTTP response headers before it knows which provider it
     * will use. x-omniroute-provider/model are therefore absent from the headers
     * on exactly the uncached calls that matter, and arrive only as trailing SSE
     * comments. Demanding the initial observation is unsatisfiable there. The
     * final receipt stays mandatory and carries the anti-substitution guarantee
     * on its own; the initial one corroborates it whenever OmniRoute supplied it.
     */
    it("RED-OMNI-7: accepts a final-only receipt when OmniRoute stamped no initial headers", () => {
      const receipt = assertCccProviderAttemptEffectiveRoute(
        omniRouteInput({ omniRoute: { final: omniRouteReceipt.final } }),
        omniRouteIdentity,
        receiptAdapterOptions,
      );
      expect(receipt?.omniRoute).toEqual({ final: omniRouteReceipt.final });
    });

    it("RED-OMNI-COMBO-1: accepts a combo alias when the final route is an admitted terminal member", () => {
      const receipt = assertCccProviderAttemptEffectiveRoute(
        {
          effectiveProvider: "golden-omniroute-glm-latest",
          effectiveModel: "combo/glm-latest",
          usage: { inputTokens: 100, outputTokens: 40 },
          cost: { amountUsd: 0, source: "pi-ai" },
          receiptSource: "stream-usage",
          omniRoute: { final: { provider: "glm", model: "glm-5.3" } },
        },
        { providerId: "golden-omniroute-glm-latest", modelId: "combo/glm-latest" },
        {
          receiptAdapterId: "terminal-route-sse-comments.v1",
          terminalRouteMembers: [{ provider: "glm", model: "glm-5.3" }],
        },
      );
      expect(receipt?.omniRoute).toEqual({ final: { provider: "glm", model: "glm-5.3" } });
    });

    it("RED-OMNI-COMBO-3: accepts the newly admitted glm-flash-latest route on its live-sealed primary member", () => {
      const receipt = assertCccProviderAttemptEffectiveRoute(
        {
          effectiveProvider: "golden-omniroute-glm-flash-latest",
          effectiveModel: "combo/glm-flash-latest",
          usage: { inputTokens: 100, outputTokens: 40 },
          cost: { amountUsd: 0, source: "pi-ai" },
          receiptSource: "stream-usage",
          omniRoute: { final: { provider: "glm", model: "glm-5.3-flash" } },
        },
        { providerId: "golden-omniroute-glm-flash-latest", modelId: "combo/glm-flash-latest" },
        {
          receiptAdapterId: "terminal-route-sse-comments.v1",
          // Live OmniRoute combo sealed 2026-09-03 (combo updatedAt
          // 2026-08-26T19:16:42.851Z): glm-flash-latest's terminal closure is
          // glm/glm-5.3-flash with an opencode-go/glm-5.3-flash fallback.
          terminalRouteMembers: [
            { provider: "glm", model: "glm-5.3-flash" },
            { provider: "opencode-go", model: "glm-5.3-flash" },
          ],
        },
      );
      expect(receipt?.omniRoute).toEqual({ final: { provider: "glm", model: "glm-5.3-flash" } });
    });

    it("RED-OMNI-COMBO-4: refuses glm-flash-latest drift to a non-admitted terminal member", () => {
      expect(() => assertCccProviderAttemptEffectiveRoute(
        {
          effectiveProvider: "golden-omniroute-glm-flash-latest",
          effectiveModel: "combo/glm-flash-latest",
          usage: { inputTokens: 100, outputTokens: 40 },
          cost: { amountUsd: 0, source: "pi-ai" },
          receiptSource: "stream-usage",
          omniRoute: { final: { provider: "minimax", model: "MiniMax-M3" } },
        },
        { providerId: "golden-omniroute-glm-flash-latest", modelId: "combo/glm-flash-latest" },
        {
          receiptAdapterId: "terminal-route-sse-comments.v1",
          terminalRouteMembers: [
            { provider: "glm", model: "glm-5.3-flash" },
            { provider: "opencode-go", model: "glm-5.3-flash" },
          ],
        },
      )).toThrow(
        "CCC final terminal provider/model receipt is not an admitted terminal route member: "
        + "observed=minimax/MiniMax-M3; "
        + "admitted=glm/glm-5.3-flash,opencode-go/glm-5.3-flash",
      );
    });

    it("RED-OMNI-COMBO-2: reports the observed and admitted terminal members on combo drift", () => {
      expect(() => assertCccProviderAttemptEffectiveRoute(
        {
          effectiveProvider: "golden-omniroute-gemini-flash-latest",
          effectiveModel: "combo/gemini-flash-latest",
          usage: { inputTokens: 100, outputTokens: 40 },
          cost: { amountUsd: 0, source: "pi-ai" },
          receiptSource: "stream-usage",
          omniRoute: { final: { provider: "antigravity", model: "gemini-3.7-flash-medium" } },
        },
        { providerId: "golden-omniroute-gemini-flash-latest", modelId: "combo/gemini-flash-latest" },
        {
          receiptAdapterId: "terminal-route-sse-comments.v1",
          terminalRouteMembers: [
            { provider: "antigravity", model: "gemini-3.7-flash-high" },
            { provider: "gemini", model: "gemini-flash-latest" },
          ],
        },
      )).toThrow(
        "CCC final terminal provider/model receipt is not an admitted terminal route member: "
        + "observed=antigravity/gemini-3.7-flash-medium; "
        + "admitted=antigravity/gemini-3.7-flash-high,gemini/gemini-flash-latest",
      );
    });

    it.each([
      { label: "final provider drift", omniRoute: { final: { provider: "opencode-go", model: "MiniMax-M3" } } },
      { label: "final model alias drift", omniRoute: { final: { provider: "minimax", model: "minimax-m3" } } },
      { label: "fallback model", omniRoute: { final: { provider: "minimax", model: "glm-5.3" } } },
    ])("RED-OMNI-8: still refuses $label on a final-only receipt", ({ omniRoute }) => {
      expect(() => assertCccProviderAttemptEffectiveRoute(
        omniRouteInput({ omniRoute }),
        omniRouteIdentity,
        receiptAdapterOptions,
      ))
        .toThrow(CccProviderAttemptIdentityError);
    });

    it("RED-OMNI-4: refuses a provider-qualified OmniRoute declaration without a slash", () => {
      expect(() => assertCccProviderAttemptEffectiveRoute(
        omniRouteInput({ effectiveModel: "MiniMax-M3" }),
        { ...omniRouteIdentity, modelId: "MiniMax-M3" },
        receiptAdapterOptions,
      )).toThrow(CccProviderAttemptIdentityError);
    });
  });
});

describe("sameCccProviderAttemptEffectiveRoute (idempotent-replay comparison)", () => {
  const receiptA: CccProviderAttemptEffectiveRoute = {
    effectiveProvider: "anthropic",
    effectiveModel: "claude-sonnet-5",
    usage: { inputTokens: 100, outputTokens: 40 },
    cost: { amountUsd: 0.0123, source: "stream-usage" },
    receiptSource: "stream-usage",
  };
  const receiptB: CccProviderAttemptEffectiveRoute = {
    effectiveProvider: "anthropic",
    effectiveModel: "claude-sonnet-5",
    usage: { inputTokens: 999, outputTokens: 999 },
    cost: { amountUsd: 9.99, source: "provider-api" },
    receiptSource: "provider-api",
  };

  it("absent-vs-absent resolves idempotently (the legacy no-receipt replay must not throw or collide)", () => {
    expect(sameCccProviderAttemptEffectiveRoute(undefined, undefined)).toBe(true);
  });

  it("absent-vs-present never resolves idempotently (must collide, not silently accept a receipt appearing on replay)", () => {
    expect(sameCccProviderAttemptEffectiveRoute(undefined, receiptA)).toBe(false);
    expect(sameCccProviderAttemptEffectiveRoute(receiptA, undefined)).toBe(false);
  });

  it("present-vs-different never resolves idempotently (must collide)", () => {
    expect(sameCccProviderAttemptEffectiveRoute(receiptA, receiptB)).toBe(false);
  });

  it("present-vs-same resolves idempotently", () => {
    expect(sameCccProviderAttemptEffectiveRoute(receiptA, { ...receiptA })).toBe(true);
  });

  it("RED-OMNI-5: replay compares the nested OmniRoute receipt byte-for-byte", () => {
    const withOmniRoute = {
      ...receiptA,
      omniRoute: {
        initial: { provider: "minimax", model: "MiniMax-M3" },
        final: { provider: "minimax", model: "MiniMax-M3" },
      },
    } as CccProviderAttemptEffectiveRoute;
    expect(sameCccProviderAttemptEffectiveRoute(withOmniRoute, { ...withOmniRoute })).toBe(true);
    expect(sameCccProviderAttemptEffectiveRoute(withOmniRoute, {
      ...withOmniRoute,
      omniRoute: {
        initial: { provider: "minimax", model: "MiniMax-M3" },
        final: { provider: "opencode-go", model: "minimax-m3" },
      },
    })).toBe(false);
  });
});

describe("C4b: assertCccProviderAttemptLaunchHeadroom", () => {
  const deadlineAtMs = Date.parse("2026-08-14T15:00:00.000Z");

  it("allows a reservation with a full minute of headroom before the deadline", () => {
    const nowMs = deadlineAtMs - 60_000;
    expect(() => assertCccProviderAttemptLaunchHeadroom(deadlineAtMs, nowMs, "task-1"))
      .not.toThrow();
  });

  it("refuses a reservation with only 10s of headroom before the deadline (reason: deadline)", () => {
    const nowMs = deadlineAtMs - 10_000;
    let thrown: unknown;
    try {
      assertCccProviderAttemptLaunchHeadroom(deadlineAtMs, nowMs, "task-1");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CccProviderAttemptLimitError);
    expect((thrown as CccProviderAttemptLimitError).reason).toBe("deadline");
    expect((thrown as Error).message).toContain("minimum launch headroom");
    expect((thrown as Error).message).toContain("task-1");
    expect((thrown as Error).message).toContain(String(CCC_PROVIDER_ATTEMPT_MIN_LAUNCH_HEADROOM_MS));
  });

  it("refuses (with the original message) a reservation at or past the deadline", () => {
    let thrown: unknown;
    try {
      assertCccProviderAttemptLaunchHeadroom(deadlineAtMs, deadlineAtMs, "task-1");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CccProviderAttemptLimitError);
    expect((thrown as CccProviderAttemptLimitError).reason).toBe("deadline");
    expect((thrown as Error).message).toBe(
      "CCC provider attempt for task-1 is outside its database-clock campaign deadline",
    );
  });

  it("CCC_PROVIDER_ATTEMPT_MIN_LAUNCH_HEADROOM_MS floor is 30 seconds", () => {
    expect(CCC_PROVIDER_ATTEMPT_MIN_LAUNCH_HEADROOM_MS).toBe(30_000);
  });
});
