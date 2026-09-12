import { describe, expect, it } from "vitest";

import {
  CCC_CAMPAIGN_CRITICAL_CAPABILITY_KEYS,
  CCC_MODEL_CAPABILITY_KEYS,
  CCC_MODEL_CAPABILITY_PROFILE_SCHEMA_VERSION,
  CccModelCapabilityProfileValidationError,
  canonicalizeCccModelCapabilityProfile,
  digestCccModelCapabilityProfile,
  evaluateCccCampaignCapabilityAdmission,
  parseCccModelCapabilityProfile,
} from "../ccc-model-capability-profile.js";

const SHA256_A = `sha256:${"a".repeat(64)}`;
const SHA256_B = `sha256:${"b".repeat(64)}`;

function validProfileInput(): Record<string, unknown> {
  return {
    schemaVersion: "1.0",
    profileId: "route-profile-v1",
    revision: 1,
    route: {
      provider: "provider-under-test",
      model: "model-under-test",
      transport: "openai-compatible-stream",
    },
    capabilities: {
      supportedInstructionRoles: {
        evidence: "live_proven",
        value: ["system", "developer"],
      },
      reasoningRequestDialect: {
        evidence: "live_proven",
        value: "reasoning.effort",
      },
      reasoningResponseDialect: {
        evidence: "live_proven",
        value: "reasoning_blocks",
      },
      reasoningHistoryReplay: {
        evidence: "live_proven",
        value: "required",
      },
      toolCallRequestSchema: {
        evidence: "live_proven",
        value: SHA256_A,
      },
      toolCallResponseSchema: {
        evidence: "live_proven",
        value: SHA256_B,
      },
      toolCallIdPreservation: {
        evidence: "live_proven",
        value: true,
      },
      terminalFinishSignals: {
        evidence: "live_proven",
        value: ["stop", "tool_calls", "length", "error"],
      },
      finalRouteReceipt: {
        evidence: "live_proven",
        value: true,
      },
      usageReceipt: {
        evidence: "live_proven",
        value: true,
      },
      streamFinalization: {
        evidence: "live_proven",
        value: "explicit_terminal_then_close",
      },
      resumeReplaySafety: {
        evidence: "live_proven",
        value: "conditional",
      },
      declaredLimits: {
        evidence: "live_proven",
        value: {
          contextTokens: 131_072,
          outputTokens: 16_384,
        },
      },
      transportTransformationOwner: {
        evidence: "live_proven",
        value: "gateway",
      },
    },
  };
}

function capabilityRecord(
  input: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  return (input.capabilities as Record<string, Record<string, unknown>>)[key];
}

describe("CCC model capability profile", () => {
  it("PRD-A1 exports one stable version and the complete campaign-critical key set", () => {
    expect(CCC_MODEL_CAPABILITY_PROFILE_SCHEMA_VERSION).toBe("1.0");
    expect(CCC_MODEL_CAPABILITY_KEYS).toEqual([
      "supportedInstructionRoles",
      "reasoningRequestDialect",
      "reasoningResponseDialect",
      "reasoningHistoryReplay",
      "toolCallRequestSchema",
      "toolCallResponseSchema",
      "toolCallIdPreservation",
      "terminalFinishSignals",
      "finalRouteReceipt",
      "usageReceipt",
      "streamFinalization",
      "resumeReplaySafety",
      "declaredLimits",
      "transportTransformationOwner",
    ]);
    expect(CCC_CAMPAIGN_CRITICAL_CAPABILITY_KEYS).toEqual(
      CCC_MODEL_CAPABILITY_KEYS,
    );
  });

  it("PRD-A2 strictly parses and deeply freezes one route profile", () => {
    const profile = parseCccModelCapabilityProfile(validProfileInput());

    expect(profile.route).toEqual({
      provider: "provider-under-test",
      model: "model-under-test",
      transport: "openai-compatible-stream",
    });
    expect(Object.isFrozen(profile)).toBe(true);
    expect(Object.isFrozen(profile.route)).toBe(true);
    expect(Object.isFrozen(profile.capabilities)).toBe(true);
    expect(
      Object.isFrozen(profile.capabilities.supportedInstructionRoles.value),
    ).toBe(true);
    expect(() => {
      (profile.route as { model: string }).model = "mutated";
    }).toThrow(TypeError);
  });

  it("PRD-A3 canonically serializes and digests equivalent key orders", () => {
    const input = validProfileInput();
    const reordered = {
      revision: input.revision,
      capabilities: input.capabilities,
      profileId: input.profileId,
      route: input.route,
      schemaVersion: input.schemaVersion,
    };
    const first = parseCccModelCapabilityProfile(input);
    const second = parseCccModelCapabilityProfile(reordered);

    expect(canonicalizeCccModelCapabilityProfile(first)).toBe(
      canonicalizeCccModelCapabilityProfile(second),
    );
    expect(digestCccModelCapabilityProfile(first)).toBe(
      digestCccModelCapabilityProfile(second),
    );
    expect(digestCccModelCapabilityProfile(first)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("PRD-A4 refuses a campaign-critical unknown without alias inference", () => {
    const input = validProfileInput();
    input.route = {
      provider: "minimax",
      model: "minimax-m3",
      transport: "known-looking-alias",
    };
    capabilityRecord(input, "terminalFinishSignals").evidence = "unknown";
    capabilityRecord(input, "terminalFinishSignals").value = null;

    const result = evaluateCccCampaignCapabilityAdmission(
      parseCccModelCapabilityProfile(input),
    );

    expect(result).toEqual({
      admitted: false,
      reasons: [
        "capabilities.terminalFinishSignals: campaign-critical evidence is unknown",
      ],
    });
  });

  it("PRD-A5 names the exact missing capability", () => {
    const input = validProfileInput();
    delete (input.capabilities as Record<string, unknown>).usageReceipt;

    expect(() => parseCccModelCapabilityProfile(input)).toThrowError(
      new CccModelCapabilityProfileValidationError([
        "capabilities.usageReceipt: missing required capability",
      ]),
    );
  });

  it("PRD-A6 rejects unknown keys at every contract boundary", () => {
    const input = validProfileInput();
    (input.route as Record<string, unknown>).providerAlias = "guess-me";

    expect(() => parseCccModelCapabilityProfile(input)).toThrowError(
      new CccModelCapabilityProfileValidationError([
        "route.providerAlias: unknown property",
      ]),
    );
  });

  it.each([
    "unknown",
    "declared",
    "offline_proven",
    "live_proven",
  ] as const)("PRD-A7 accepts the evidence state %s", (evidence) => {
    const input = validProfileInput();
    capabilityRecord(input, "usageReceipt").evidence = evidence;
    capabilityRecord(input, "usageReceipt").value =
      evidence === "unknown" ? null : true;

    expect(
      parseCccModelCapabilityProfile(input).capabilities.usageReceipt.evidence,
    ).toBe(evidence);
  });

  it("PRD-A8 rejects unknown evidence when it carries an inferred value", () => {
    const input = validProfileInput();
    capabilityRecord(input, "usageReceipt").evidence = "unknown";
    capabilityRecord(input, "usageReceipt").value = true;

    expect(() => parseCccModelCapabilityProfile(input)).toThrowError(
      new CccModelCapabilityProfileValidationError([
        "capabilities.usageReceipt.value: must be null when evidence is unknown",
      ]),
    );
  });
});
