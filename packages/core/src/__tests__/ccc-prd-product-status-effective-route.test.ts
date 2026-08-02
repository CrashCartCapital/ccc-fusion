/**
 * RED-6: product-status surfaces the new effective-route/usage/cost receipt
 * facts for an attempt that has them, and honestly omits them for one that
 * does not. `providerAttemptStatus` is a pure transform (no database) over
 * an already-loaded provider-attempt scope, so this is proved directly here
 * without a PostgreSQL harness.
 */
import { describe, expect, it } from "vitest";
import { providerAttemptStatus } from "../ccc-prd/product-status.js";
import type { CccProviderAttemptScope } from "../ccc-campaign/types.js";

const binding = Object.freeze({
  projectId: "project-1",
  importId: "import-1",
  campaignId: "campaign-1",
  taskId: "task-1",
  actionId: "task-1",
  actionTarget: "/repo",
  idempotencyKey: "idem-1",
  packetHash: "0".repeat(64),
  sidecarHash: "1".repeat(64),
  bundleHash: "2".repeat(64),
  targetRepository: "org/repo",
  targetBase: "main",
  providerId: "anthropic",
  modelId: "claude-sonnet-5",
  transport: "pi" as const,
  manifestHash: "3".repeat(64),
  bindingHash: "4".repeat(64),
});

function baseScope(overrides: Partial<CccProviderAttemptScope> = {}): CccProviderAttemptScope {
  return {
    attemptKey: `ccc-provider-attempt-${"a".repeat(64)}`,
    controllerToken: "ccc-provider-controller-00000000-0000-0000-0000-000000000000",
    taskId: "task-1",
    semanticTaskId: "TASK-1",
    campaignDeadlineAt: "2999-01-01T00:00:00.000Z",
    turnKey: "turn-1",
    dispatchKey: "dispatch-1",
    attemptOrdinal: 1,
    requestCount: 1,
    workItemFence: null,
    state: "committed",
    binding,
    ...overrides,
  };
}

describe("providerAttemptStatus effective-route facts", () => {
  it("RED-6: exposes effective identity, usage, cost, and receiptSource for an attempt that has a reconciled effective-route receipt", () => {
    const scope = baseScope({
      terminal: {
        kind: "reconciled",
        state: "committed",
        evidenceDigest: "5".repeat(64),
        observerId: "observer-1",
        effectiveRoute: {
          effectiveProvider: "anthropic",
          effectiveModel: "claude-sonnet-5",
          effectiveReasoningEffort: "high",
          usage: { inputTokens: 200, outputTokens: 55 },
          cost: { amountUsd: 0.0456, source: "stream-usage" },
          receiptSource: "stream-usage",
        },
      },
    });

    const status = providerAttemptStatus(scope);

    expect(status.effectiveProvider).toBe("anthropic");
    expect(status.effectiveModel).toBe("claude-sonnet-5");
    expect(status.effectiveReasoningEffort).toBe("high");
    expect(status.effectiveServiceTier).toBeUndefined();
    expect(status.usage).toEqual({ inputTokens: 200, outputTokens: 55 });
    expect(status.cost).toEqual({ amountUsd: 0.0456, source: "stream-usage" });
    expect(status.receiptSource).toBe("stream-usage");
  });

  it("RED-6: honestly omits the new facts (undefined) for an attempt with no terminal evidence at all", () => {
    const status = providerAttemptStatus(baseScope({ state: "reserved" }));

    expect(status.effectiveProvider).toBeUndefined();
    expect(status.effectiveModel).toBeUndefined();
    expect(status.effectiveReasoningEffort).toBeUndefined();
    expect(status.effectiveServiceTier).toBeUndefined();
    expect(status.usage).toBeUndefined();
    expect(status.cost).toBeUndefined();
    expect(status.receiptSource).toBeUndefined();
  });

  it("honestly omits the new facts for an attempt with a not-dispatched terminal (no reconciled receipt possible)", () => {
    const status = providerAttemptStatus(baseScope({
      state: "proved_failed",
      terminal: { kind: "not-dispatched", state: "proved_failed" },
    }));

    expect(status.effectiveProvider).toBeUndefined();
    expect(status.usage).toBeUndefined();
    expect(status.cost).toBeUndefined();
    expect(status.receiptSource).toBeUndefined();
  });

  it("honestly omits the new facts for an attempt reconciled without any effective-route receipt (legacy/backward-compatible settlement)", () => {
    const status = providerAttemptStatus(baseScope({
      terminal: {
        kind: "reconciled",
        state: "committed",
        evidenceDigest: "6".repeat(64),
        observerId: "observer-1",
      },
    }));

    expect(status.effectiveProvider).toBeUndefined();
    expect(status.usage).toBeUndefined();
    expect(status.cost).toBeUndefined();
    expect(status.receiptSource).toBeUndefined();
    // The terminal evidence itself is still fully present.
    expect(status.terminal).toEqual({
      kind: "reconciled",
      state: "committed",
      evidenceDigest: "6".repeat(64),
      observerId: "observer-1",
    });
  });

  it("reports an honest cost-unknown claim rather than inventing a display value", () => {
    const status = providerAttemptStatus(baseScope({
      terminal: {
        kind: "reconciled",
        state: "committed",
        evidenceDigest: "7".repeat(64),
        observerId: "observer-1",
        effectiveRoute: {
          effectiveProvider: "anthropic",
          effectiveModel: "claude-sonnet-5",
          usage: null,
          cost: { kind: "unknown", reason: "provider did not emit usage on this transport" },
          receiptSource: "none",
        },
      },
    }));

    expect(status.usage).toBeNull();
    expect(status.cost).toEqual({ kind: "unknown", reason: "provider did not emit usage on this transport" });
    expect(status.receiptSource).toBe("none");
  });
});
