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
  sameCccProviderAttemptEffectiveRoute,
} from "../ccc-campaign/provider-attempt.js";
import { CccProviderAttemptIdentityError } from "../ccc-campaign/types.js";
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
});
