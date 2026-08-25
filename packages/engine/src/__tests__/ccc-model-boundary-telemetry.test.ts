import { describe, expect, it } from "vitest";

import {
  CCC_MODEL_BOUNDARY_EVENT_STAGES,
  CCC_MODEL_BOUNDARY_TELEMETRY_SCHEMA_VERSION,
  CccModelBoundaryTelemetryValidationError,
  CccModelBoundaryTransitionError,
  createCccSensitivePayloadHmac,
  parseCccModelBoundaryEvent,
  serializeCccModelBoundaryEvent,
  validateCccModelBoundarySequence,
  type CccModelBoundaryEventStage,
} from "../ccc-model-boundary-telemetry.js";

const PROFILE_DIGEST = "a".repeat(64);
const SCHEMA_FINGERPRINT = `sha256:${"b".repeat(64)}`;
const HMAC_KEY = new Uint8Array(32).fill(7);

function event(
  stage: CccModelBoundaryEventStage,
  sequence: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: "1.0",
    stage,
    identity: {
      runId: "run-1",
      scenarioId: "scenario-1",
      turnId: "turn-1",
      attemptId: "attempt-1",
    },
    sequence,
    capabilityProfileDigest: PROFILE_DIGEST,
    requestedRoute: {
      provider: "provider-under-test",
      model: "model-under-test",
      transport: "openai-compatible-stream",
    },
    effectiveRoute: null,
    adapterVersion: "adapter-v1",
    omniRouteReceipt: {
      present: false,
      state: "not_observed",
    },
    occurredAt: `2026-08-24T17:00:${String(sequence).padStart(2, "0")}.000Z`,
    elapsedMs: sequence * 10,
    tool: null,
    schemaFingerprints: [SCHEMA_FINGERPRINT],
    usage: null,
    terminalClassification: "none",
    sensitivePayloadHmac: null,
    ...overrides,
  };
}

function successfulSequence(): Record<string, unknown>[] {
  return [
    event("request_built", 1),
    event("request_dispatched", 2),
    event("stream_opened", 3),
    event("stream_activity", 4),
    event("reasoning_observed", 5),
    event("tool_call_observed", 6, {
      tool: { name: "read_file", category: "read" },
    }),
    event("tool_result_dispatched", 7, {
      tool: { name: "read_file", category: "read" },
      sensitivePayloadHmac: createCccSensitivePayloadHmac(
        HMAC_KEY,
        "opaque-tool-result",
      ),
    }),
    event("terminal_observed", 8, {
      terminalClassification: "success",
      effectiveRoute: {
        provider: "provider-under-test",
        model: "model-under-test",
      },
      omniRouteReceipt: { present: true, state: "effective_proven" },
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
    }),
    event("stream_closed", 9, { terminalClassification: "success" }),
    event("controller_handoff", 10, { terminalClassification: "success" }),
    event("proof_started", 11, { terminalClassification: "success" }),
  ];
}

describe("CCC model boundary telemetry", () => {
  it("PRD-B1 exports the complete versioned stage vocabulary", () => {
    expect(CCC_MODEL_BOUNDARY_TELEMETRY_SCHEMA_VERSION).toBe("1.0");
    expect(CCC_MODEL_BOUNDARY_EVENT_STAGES).toEqual([
      "request_built",
      "request_dispatched",
      "stream_opened",
      "stream_activity",
      "reasoning_observed",
      "tool_call_observed",
      "tool_result_dispatched",
      "terminal_observed",
      "stream_closed",
      "stream_failed",
      "controller_handoff",
      "proof_started",
    ]);
  });

  it("PRD-B2 validates a complete successful attempt and freezes state", () => {
    const [state] = validateCccModelBoundarySequence(successfulSequence());

    expect(state).toMatchObject({
      attemptId: "attempt-1",
      terminalClassification: "success",
      terminalObserved: true,
      streamClosed: true,
      controllerHandoff: true,
      proofStarted: true,
      toolCallCount: 1,
      toolResultCount: 1,
    });
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.identity)).toBe(true);
  });

  it("PRD-B3 serializes HMAC equality only and contains no payload bytes", () => {
    const digest = createCccSensitivePayloadHmac(HMAC_KEY, "private prompt");
    const same = createCccSensitivePayloadHmac(HMAC_KEY, "private prompt");
    const different = createCccSensitivePayloadHmac(HMAC_KEY, "other prompt");
    const parsed = parseCccModelBoundaryEvent(
      event("request_built", 1, { sensitivePayloadHmac: digest }),
    );
    const serialized = serializeCccModelBoundaryEvent(parsed);

    expect(digest).toBe(same);
    expect(digest).not.toBe(different);
    expect(digest).toMatch(/^hmac-sha256:[0-9a-f]{64}$/);
    expect(serialized).toContain(digest);
    expect(serialized).not.toContain("private prompt");
    expect(serialized).not.toContain("other prompt");
  });

  it("PRD-B4 rejects weak HMAC keys and structured payload objects", () => {
    expect(() =>
      createCccSensitivePayloadHmac(new Uint8Array(31), "payload"),
    ).toThrow("HMAC key must contain at least 32 bytes");
    expect(() =>
      createCccSensitivePayloadHmac(HMAC_KEY, { raw: "payload" } as never),
    ).toThrow("Sensitive payload must be a string or Uint8Array");
  });

  it.each(["prompt", "reasoningText", "toolArguments", "authorization", "apiKey"])(
    "PRD-B5 rejects secret-bearing or raw-payload key %s before serialization",
    (key) => {
      const input = event("request_built", 1);
      input[key] = "must-not-persist";

      expect(() => parseCccModelBoundaryEvent(input)).toThrowError(
        new CccModelBoundaryTelemetryValidationError([
          `${key}: forbidden sensitive or payload-bearing property`,
        ]),
      );
    },
  );

  it("PRD-B6 does not treat dispatch or stream/header success as terminal success", () => {
    const partial = [
      event("request_built", 1),
      event("request_dispatched", 2),
      event("stream_opened", 3),
    ];

    const [state] = validateCccModelBoundarySequence(partial);
    expect(state.terminalObserved).toBe(false);
    expect(state.terminalClassification).toBe("none");
    expect(() =>
      validateCccModelBoundarySequence([
        ...partial,
        event("controller_handoff", 4),
      ]),
    ).toThrow("controller_handoff requires terminal_observed and stream_closed");
  });

  it("PRD-B7 refuses controller handoff before stream closure", () => {
    expect(() =>
      validateCccModelBoundarySequence([
        event("request_built", 1),
        event("request_dispatched", 2),
        event("stream_opened", 3),
        event("terminal_observed", 4, {
          terminalClassification: "success",
        }),
        event("controller_handoff", 5, {
          terminalClassification: "success",
        }),
      ]),
    ).toThrowError(
      new CccModelBoundaryTransitionError(
        "attempt-1",
        "controller_handoff requires terminal_observed and stream_closed",
      ),
    );
  });

  it("PRD-B8 refuses repeated terminal and closure transitions", () => {
    const terminalPrefix = [
      event("request_built", 1),
      event("request_dispatched", 2),
      event("stream_opened", 3),
      event("terminal_observed", 4, { terminalClassification: "success" }),
    ];
    expect(() =>
      validateCccModelBoundarySequence([
        ...terminalPrefix,
        event("terminal_observed", 5, { terminalClassification: "success" }),
      ]),
    ).toThrow("terminal_observed cannot repeat");
    expect(() =>
      validateCccModelBoundarySequence([
        ...terminalPrefix,
        event("stream_closed", 5, { terminalClassification: "success" }),
        event("stream_closed", 6, { terminalClassification: "success" }),
      ]),
    ).toThrow("stream_closed cannot repeat");
  });

  it("PRD-B9 refuses a successful terminal after a mid-stream failure", () => {
    expect(() =>
      validateCccModelBoundarySequence([
        event("request_built", 1),
        event("request_dispatched", 2),
        event("stream_opened", 3),
        event("stream_failed", 4, { terminalClassification: "failure" }),
        event("terminal_observed", 5, {
          terminalClassification: "success",
        }),
      ]),
    ).toThrow("terminal_observed cannot follow stream_failed in the same attempt");
  });

  it("PRD-B10 keeps dispatched_unknown nonterminal and replay-ineligible", () => {
    const unresolved = [
      event("request_built", 1),
      event("request_dispatched", 2),
      event("stream_failed", 3, {
        terminalClassification: "dispatched_unknown",
      }),
    ];
    const [state] = validateCccModelBoundarySequence(unresolved);

    expect(state.terminalObserved).toBe(false);
    expect(state.replayAuthorized).toBe(false);
    expect(() =>
      validateCccModelBoundarySequence([
        ...unresolved,
        event("controller_handoff", 4, {
          terminalClassification: "dispatched_unknown",
        }),
      ]),
    ).toThrow("controller_handoff requires terminal_observed and stream_closed");
  });

  it("PRD-B11 permits success only on a distinct new attempt after failure", () => {
    const failed = [
      event("request_built", 1),
      event("request_dispatched", 2),
      event("stream_opened", 3),
      event("stream_failed", 4, { terminalClassification: "failure" }),
      event("stream_closed", 5, { terminalClassification: "failure" }),
    ];
    const retry = successfulSequence().map((entry) => ({
      ...entry,
      identity: {
        ...(entry.identity as Record<string, unknown>),
        attemptId: "attempt-2",
      },
    }));

    const states = validateCccModelBoundarySequence([...failed, ...retry]);
    expect(states.map((state) => state.terminalClassification)).toEqual([
      "failure",
      "success",
    ]);
  });

  it("PRD-B12 rejects non-monotonic attempt sequence and elapsed time", () => {
    expect(() =>
      validateCccModelBoundarySequence([
        event("request_built", 2),
        event("request_dispatched", 1),
      ]),
    ).toThrow("sequence must strictly increase within an attempt");
    expect(() =>
      validateCccModelBoundarySequence([
        event("request_built", 1, { elapsedMs: 20 }),
        event("request_dispatched", 2, { elapsedMs: 10 }),
      ]),
    ).toThrow("elapsedMs must not decrease within an attempt");
  });

  it("PRD-B13 rejects terminal classification masquerading on another stage", () => {
    expect(() =>
      validateCccModelBoundarySequence([
        event("request_built", 1, { terminalClassification: "success" }),
      ]),
    ).toThrow("request_built requires terminalClassification none");

    expect(() =>
      validateCccModelBoundarySequence([
        event("request_built", 1),
        event("request_dispatched", 2),
        event("stream_opened", 3),
        event("stream_failed", 4, { terminalClassification: "failure" }),
        event("stream_closed", 5, { terminalClassification: "success" }),
      ]),
    ).toThrow("stream_closed classification must match the attempt terminal state");
  });
});
