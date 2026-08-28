import { describe, expect, it } from "vitest";
import {
  createCccCampaignExecutionAuthorizationIdentity,
  type CccCampaignExecutionAuthorizationIdentityInput,
} from "../ccc-campaign/execution-authorization.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);
const HASH_E = "e".repeat(64);
const HASH_F = "f".repeat(64);

function identityInput(): CccCampaignExecutionAuthorizationIdentityInput {
  return {
    projectId: "project-authorization",
    importId: "ccc-prd-import-authorization",
    campaignId: "CAMPAIGN-AUTHORIZATION",
    idempotencyKey: "authorization-idempotency-key",
    workflowId: "ccc-prd-import-authorization--WF-AUTHORIZATION",
    workItemId: "ccc-prd-import-authorization--WORK-AUTHORIZATION",
    workflowIrHash: HASH_A,
    packetHash: HASH_B,
    sidecarHash: HASH_C,
    bundleHash: HASH_D,
    manifestHash: HASH_E,
    executionPolicySha256: HASH_F,
    targetRepository: "/tmp/ccc-authorization-target",
    targetBase: "1".repeat(40),
    campaignStartedAt: "2026-08-12T20:00:00.000Z",
    campaignDeadlineAt: "2026-08-12T21:00:00.000Z",
    maxRequests: 24,
    maxConcurrency: 2,
    members: [
      {
        ordinal: 0,
        nativeTaskId: "native-task-a",
        semanticTaskId: "TSK-A",
        actionId: "ACTION-A",
        actionTarget: "provider://campaign/task-a",
        providerId: "provider-a",
        modelId: "model-a",
        transport: "pi",
        promptSchema: "ccc-prd.execution-prompt.v1",
        promptSha256: HASH_A,
        routeSha256: HASH_B,
        bindingHash: HASH_C,
      },
      {
        ordinal: 1,
        nativeTaskId: "native-task-b",
        semanticTaskId: "TSK-B",
        actionId: "ACTION-B",
        actionTarget: "provider://campaign/task-b",
        providerId: "provider-b",
        modelId: "model-b",
        transport: "cli",
        promptSchema: "ccc-prd.execution-prompt.v1",
        promptSha256: HASH_D,
        routeSha256: HASH_E,
        bindingHash: HASH_F,
      },
    ],
  };
}

describe("CCC sealed execution-authorization identity", () => {
  it("RED-S2-identity: seals the complete canonical member set independently of caller order", () => {
    const input = identityInput();
    const forward = createCccCampaignExecutionAuthorizationIdentity(input);
    const reverse = createCccCampaignExecutionAuthorizationIdentity({
      ...input,
      members: [...input.members].reverse(),
    });

    expect(reverse).toEqual(forward);
    expect(forward.authorizationId)
      .toBe(`ccc-execution-authorization-${forward.authorizationDigest}`);
    expect(forward.authorizationDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(forward.memberSetHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(forward.members.map(({ ordinal }) => ordinal)).toEqual([0, 1]);
    expect(forward.members.map(({ approvalRequestId, bindingHash }) =>
      approvalRequestId === `ccc-approval-${bindingHash}`)).toEqual([true, true]);
  });

  it("RED-S2-identity: invalidates the parent when one prompt or route member drifts", () => {
    const input = identityInput();
    const original = createCccCampaignExecutionAuthorizationIdentity(input);
    const promptDrift = createCccCampaignExecutionAuthorizationIdentity({
      ...input,
      members: input.members.map((member) => member.ordinal === 1
        ? { ...member, promptSha256: HASH_A }
        : member),
    });
    const routeDrift = createCccCampaignExecutionAuthorizationIdentity({
      ...input,
      members: input.members.map((member) => member.ordinal === 0
        ? { ...member, routeSha256: HASH_F }
        : member),
    });

    expect(promptDrift.memberSetHash).not.toBe(original.memberSetHash);
    expect(promptDrift.authorizationDigest).not.toBe(original.authorizationDigest);
    expect(routeDrift.memberSetHash).not.toBe(original.memberSetHash);
    expect(routeDrift.authorizationDigest).not.toBe(original.authorizationDigest);
  });

  it.each([
    ["task member set", (input: CccCampaignExecutionAuthorizationIdentityInput) => ({
      ...input,
      members: input.members.slice(0, 1),
    })],
    ["workflow dependency graph", (input: CccCampaignExecutionAuthorizationIdentityInput) => ({
      ...input,
      workflowIrHash: HASH_B,
    })],
    ["owned-path route", (input: CccCampaignExecutionAuthorizationIdentityInput) => ({
      ...input,
      members: input.members.map((member) => member.ordinal === 0
        ? { ...member, routeSha256: HASH_F }
        : member),
    })],
    ["target repository", (input: CccCampaignExecutionAuthorizationIdentityInput) => ({
      ...input,
      targetRepository: "/tmp/ccc-authorization-target-moved",
    })],
    ["target base", (input: CccCampaignExecutionAuthorizationIdentityInput) => ({
      ...input,
      targetBase: "2".repeat(40),
    })],
  ] as const)("RED-W1-structural-digest: %s drift changes parent identity", (_label, mutate) => {
    const input = identityInput();
    const original = createCccCampaignExecutionAuthorizationIdentity(input);
    const drifted = createCccCampaignExecutionAuthorizationIdentity(mutate(input));

    expect(drifted.authorizationId).not.toBe(original.authorizationId);
    expect(drifted.authorizationDigest).not.toBe(original.authorizationDigest);
  });

  it("RED-W1-structural-digest: identical re-derivation is idempotent", () => {
    const input = identityInput();
    const first = createCccCampaignExecutionAuthorizationIdentity(input);
    const replay = createCccCampaignExecutionAuthorizationIdentity({
      ...input,
      members: input.members.map((member) => ({ ...member })),
    });

    expect(replay).toEqual(first);
  });

  it("RED-S2-identity: refuses duplicate or non-contiguous canonical ordinals", () => {
    const input = identityInput();
    expect(() => createCccCampaignExecutionAuthorizationIdentity({
      ...input,
      members: input.members.map((member) => ({ ...member, ordinal: 0 })),
    })).toThrow(/ordinal/i);
    expect(() => createCccCampaignExecutionAuthorizationIdentity({
      ...input,
      members: input.members.map((member) => ({ ...member, ordinal: member.ordinal + 1 })),
    })).toThrow(/ordinal/i);
  });
});
