import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { CccCampaignExecutionAuthorization } from "../ccc-campaign/execution-authorization.js";
import { canonicalCccPrdJson } from "../ccc-prd/contract.js";
import {
  assertCccPlanningExecutionAuthorizationWithinReceipt,
  CCC_PLANNING_LIVE_AUTHORITY_RECEIPT_SCHEMA,
  computeCccPlanningAuthorityReceiptDigest,
  parseCccPlanningLiveAuthorityReceipt,
  type CccPlanningLiveAuthorityReceiptV1,
} from "../ccc-planning/authority.js";
import { CCC_PLANNING_BUDGET_POLICY_V1 } from "../ccc-planning/budget-fit.js";
import { cccPlanningImportKey, cccPlanningSourcePolicySha256 } from "../ccc-planning/policy.js";

/*
FNXC:CccPlanningAuthority 2026-10-14-13:45:
Card K2 RED for the live-authority receipt (D23, ADR D Q3, CONTRACT-v3 section 2.18). Every refusal case is the control receipt with exactly one field changed and the confirmation re-derived for the changed body, so the refusal can only come from that field: the positive control on the same fixture is admitted. The confirmation digest is computed here independently (sha256 of the canonical receipt without `operatorConfirmation`), never through the function under test, so a wrong digest implementation cannot certify its own fixtures.
*/

type MutableBody = Record<string, unknown> & {
  target: Record<string, unknown>; models: Record<string, unknown>; phaseCallCaps: Record<string, unknown>;
  omniRoute: Record<string, unknown> & { providerIds: Record<string, unknown> };
  permittedProtectedActions: Record<string, unknown>[];
};

const ISSUED = "2026-10-14T12:00:00.000Z";
const NOW = "2026-10-14T13:00:00.000Z";
const DEADLINE = "2026-10-16T12:00:00.000Z"; // 48 h, the Build Standard deadline
const EXPIRES = "2026-10-20T12:00:00.000Z"; // 6 days after issue, after the deadline
const B0 = "a".repeat(40);
const B1 = "1".repeat(40);
const RUN_ID = "ccc-plan:0123456789abcdef01234567";
const FLASH_PROVIDER = "ccc-glm53-flash";

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function controlBody(): MutableBody {
  return {
    schema: "ccc-planning.live-authority-receipt.v1",
    receiptId: "r2c-i2-text-stats-01",
    issuedAt: ISSUED, notBefore: ISSUED, expiresAt: EXPIRES,
    operator: { actorId: "ryan", actorName: "Ryan" },
    project: { projectId: "proj-r2c-i2" },
    target: {
      class: "owned_disposable",
      scratchRoot: "/private/tmp/ccc-r2c-i2",
      repositoryRealpath: "/private/tmp/ccc-r2c-i2/target",
      baseCommit: B0, baseTree: "b".repeat(40),
      ownershipMarker: { path: "/private/tmp/ccc-r2c-i2/owner.json", sha256: "c".repeat(64) },
      remotes: [],
      admittedFusionPaths: ["proof/**", "Taskfile.yml"],
    },
    request: { sha256: "d".repeat(64), byteLength: 2048 },
    mode: "build", profile: "full-v2", budgetProfile: "standard",
    budgetPolicyVersion: "ccc-planning.budget-policy.v1", largeAuthorized: false,
    phaseCallCaps: { planning: 1536, implementation: 3072, reviewProof: 1536 },
    deadlineAt: DEADLINE,
    models: { glm53: "glm/glm-5.3", glm53Flash: "glm/glm-5.3-flash", minimaxM3: "minimax/MiniMax-M3" },
    omniRoute: {
      baseUrl: "http://127.0.0.1:20128/v1",
      receiptAdapterId: "terminal-route-sse-comments.v1",
      providerIds: { glm53: "ccc-glm53", glm53Flash: FLASH_PROVIDER, minimaxM3: "ccc-minimax-m3" },
    },
    quota: { accounting: "subscription_unknown", meteredFallback: "forbidden" },
    escalation: "forbidden",
    permittedProtectedActions: [{ kind: "live_execution", release: "controller_within_receipt" }],
    sourceToolPolicy: { policyId: "ccc-planning.source-policy.i2.v1", sha256: cccPlanningSourcePolicySha256() },
    runtime: { installedRuntimeReceiptSha256: "e".repeat(64), packageVersion: "0.43.0", distManifestSha256: "f".repeat(64) },
  };
}

/** Seals a body: operatorConfirmation = sha256(canonical body without it). */
function seal(body: Record<string, unknown>): Record<string, unknown> & { operatorConfirmation: string } {
  return { ...body, operatorConfirmation: sha256(canonicalCccPrdJson(body)) };
}

function bytesOf(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalCccPrdJson(value));
}

function parse(mutate?: (body: MutableBody) => void, options?: { confirmDigest?: string; now?: string }) {
  const body = controlBody();
  mutate?.(body);
  const sealed = seal(body);
  return parseCccPlanningLiveAuthorityReceipt(bytesOf(sealed), {
    confirmDigest: options?.confirmDigest ?? sealed.operatorConfirmation,
    now: options?.now ?? NOW,
    budgetPolicy: CCC_PLANNING_BUDGET_POLICY_V1,
  });
}

function refusal(result: ReturnType<typeof parse>): { code: string; field: string } {
  if (result.ok) return { code: "admitted", field: "" };
  return { code: result.code, field: result.field };
}

function controlReceipt(): CccPlanningLiveAuthorityReceiptV1 {
  const result = parse();
  if (!result.ok) throw new Error(`control receipt refused: ${result.code} ${result.field}`);
  return result.receipt;
}

describe("live-authority receipt parse", () => {
  it("admits the control receipt and returns the SHA-256 of its canonical bytes", () => {
    const sealed = seal(controlBody());
    const result = parse();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.receipt).toEqual(sealed);
    expect(result.receiptSha256).toBe(sha256(canonicalCccPrdJson(sealed)));
    expect(CCC_PLANNING_LIVE_AUTHORITY_RECEIPT_SCHEMA).toBe("ccc-planning.live-authority-receipt.v1");
  });

  it("computes the confirmation digest over exactly the named fields without operatorConfirmation", () => {
    const body = controlBody();
    const expected = sha256(canonicalCccPrdJson(body));
    const sealed = seal(body) as unknown as CccPlanningLiveAuthorityReceiptV1;
    expect(computeCccPlanningAuthorityReceiptDigest(body as unknown as CccPlanningLiveAuthorityReceiptV1)).toBe(expected);
    // A caller passing the full receipt, or extra fields, gets the same digest (errata E1-11).
    expect(computeCccPlanningAuthorityReceiptDigest(sealed)).toBe(expected);
    const wider = { ...sealed, note: "not a receipt field", target: { ...sealed.target, extra: true } };
    expect(computeCccPlanningAuthorityReceiptDigest(wider as unknown as CccPlanningLiveAuthorityReceiptV1)).toBe(expected);
    // One named field changes the digest.
    const changed = { ...body, mode: "spec" };
    expect(computeCccPlanningAuthorityReceiptDigest(changed as unknown as CccPlanningLiveAuthorityReceiptV1)).not.toBe(expected);
  });

  it("refuses a receipt naming glm/glm-5.2 as REJECTED_MODEL_IDENTITY, and admits the control glm/glm-5.3", () => {
    expect(refusal(parse((b) => { b.models.glm53 = "glm/glm-5.2"; })))
      .toEqual({ code: "CCC_PLANNING_REJECTED_MODEL_IDENTITY", field: "models.glm53" });
    expect(parse((b) => { b.models.glm53 = "glm/glm-5.3"; }).ok).toBe(true);
  });

  it("refuses aliases, combos, lookalikes and a pin in the wrong slot as REJECTED_MODEL_IDENTITY", () => {
    const cases: readonly [string, string][] = [
      ["glm53", "glm-5.2"], ["glm53", "combo/glm-latest"], ["glm53Flash", "glm/glm-5.3-flashx"],
      ["glm53Flash", "glm/glm-5.3"], ["minimaxM3", "minimax/MiniMax-M3-latest"], ["minimaxM3", "minimax/minimax-m3"],
    ];
    for (const [slot, modelId] of cases) {
      expect(refusal(parse((b) => { b.models[slot] = modelId; })))
        .toEqual({ code: "CCC_PLANNING_REJECTED_MODEL_IDENTITY", field: `models.${slot}` });
    }
  });

  it("refuses phaseCallCaps.planning = 1535 as BUDGET_POLICY_MISMATCH, and admits the control 1536", () => {
    expect(refusal(parse((b) => { b.phaseCallCaps.planning = 1535; })))
      .toEqual({ code: "CCC_PLANNING_BUDGET_POLICY_MISMATCH", field: "phaseCallCaps.planning" });
    expect(parse((b) => { b.phaseCallCaps.planning = 1536; }).ok).toBe(true);
  });

  it("recomputes the caps from the profile and the policy version the receipt names", () => {
    expect(refusal(parse((b) => { b.budgetPolicyVersion = "ccc-planning.budget-policy.v0"; })))
      .toEqual({ code: "CCC_PLANNING_BUDGET_POLICY_MISMATCH", field: "budgetPolicyVersion" });
    // Large with the Standard caps is a different size, not a receipt.
    expect(refusal(parse((b) => { b.budgetProfile = "large"; b.largeAuthorized = true; })))
      .toEqual({ code: "CCC_PLANNING_BUDGET_POLICY_MISMATCH", field: "phaseCallCaps.planning" });
    // Control: Spec Standard with the Spec Standard caps.
    expect(parse((b) => { b.mode = "spec"; b.phaseCallCaps.implementation = 0; b.phaseCallCaps.reviewProof = 0; }).ok).toBe(true);
  });

  it("refuses a wrong confirm digest as UNCONFIRMED, and a receipt edited after confirmation too", () => {
    expect(refusal(parse(undefined, { confirmDigest: "0".repeat(64) })))
      .toEqual({ code: "CCC_PLANNING_AUTHORITY_RECEIPT_UNCONFIRMED", field: "confirmDigest" });
    // The stored confirmation no longer matches the body (mode edited after Ryan typed the digest).
    const sealed = seal(controlBody());
    const edited = { ...sealed, mode: "spec", phaseCallCaps: { planning: 1536, implementation: 0, reviewProof: 0 } };
    const result = parseCccPlanningLiveAuthorityReceipt(bytesOf(edited), {
      confirmDigest: sealed.operatorConfirmation, now: NOW, budgetPolicy: CCC_PLANNING_BUDGET_POLICY_V1 });
    expect(refusal(result)).toEqual({ code: "CCC_PLANNING_AUTHORITY_RECEIPT_UNCONFIRMED", field: "operatorConfirmation" });
  });

  it("refuses a missing confirm digest as AUTHORITY_CONFIRMATION_REQUIRED", () => {
    expect(refusal(parse(undefined, { confirmDigest: "" })))
      .toEqual({ code: "CCC_PLANNING_AUTHORITY_CONFIRMATION_REQUIRED", field: "confirmDigest" });
  });

  it("refuses an extra key, a missing key and an extra nested key as INVALID", () => {
    expect(refusal(parse((b) => { b.note = "extra"; })))
      .toEqual({ code: "CCC_PLANNING_AUTHORITY_RECEIPT_INVALID", field: "note" });
    expect(refusal(parse((b) => { b.target.extra = "x"; })))
      .toEqual({ code: "CCC_PLANNING_AUTHORITY_RECEIPT_INVALID", field: "target.extra" });
    expect(refusal(parse((b) => { b.permittedProtectedActions[0]!.note = "x"; })))
      .toEqual({ code: "CCC_PLANNING_AUTHORITY_RECEIPT_INVALID", field: "permittedProtectedActions[0].note" });
    expect(refusal(parse((b) => { delete b.escalation; })))
      .toEqual({ code: "CCC_PLANNING_AUTHORITY_RECEIPT_INVALID", field: "escalation" });
  });

  it("refuses bytes that are not the canonical JSON of the receipt, and accepts one trailing newline", () => {
    const sealed = seal(controlBody());
    const options = { confirmDigest: sealed.operatorConfirmation, now: NOW, budgetPolicy: CCC_PLANNING_BUDGET_POLICY_V1 };
    const pretty = new TextEncoder().encode(JSON.stringify(sealed, null, 2));
    expect(refusal(parseCccPlanningLiveAuthorityReceipt(pretty, options)))
      .toEqual({ code: "CCC_PLANNING_AUTHORITY_RECEIPT_INVALID", field: "$" });
    // A duplicate key parses to the last value; canonical bytes cannot hold one.
    const canonical = canonicalCccPrdJson(sealed);
    const duplicate = new TextEncoder().encode(canonical.replace('"escalation":"forbidden"', '"escalation":"allowed","escalation":"forbidden"'));
    expect(refusal(parseCccPlanningLiveAuthorityReceipt(duplicate, options)))
      .toEqual({ code: "CCC_PLANNING_AUTHORITY_RECEIPT_INVALID", field: "$" });
    expect(refusal(parseCccPlanningLiveAuthorityReceipt(new Uint8Array([0xff, 0xfe]), options)))
      .toEqual({ code: "CCC_PLANNING_AUTHORITY_RECEIPT_INVALID", field: "$" });
    expect(parseCccPlanningLiveAuthorityReceipt(new TextEncoder().encode(`${canonical}\n`), options).ok).toBe(true);
  });

  it("refuses an admitted_repository target as QUALIFICATION_REQUIRED and a target with remotes as TARGET_NOT_DISPOSABLE", () => {
    expect(refusal(parse((b) => { b.target.class = "admitted_repository"; })))
      .toEqual({ code: "CCC_PLANNING_QUALIFICATION_REQUIRED", field: "target.class" });
    expect(refusal(parse((b) => { b.target.class = "anything"; })))
      .toEqual({ code: "CCC_PLANNING_AUTHORITY_RECEIPT_INVALID", field: "target.class" });
    expect(refusal(parse((b) => { b.target.remotes = ["origin"]; })))
      .toEqual({ code: "CCC_PLANNING_TARGET_NOT_DISPOSABLE", field: "target.remotes" });
  });

  it("refuses a repository that is not a direct child of the scratch root, or a marker outside it", () => {
    expect(refusal(parse((b) => { b.target.repositoryRealpath = "/private/tmp/ccc-r2c-i2/nested/target"; })))
      .toEqual({ code: "CCC_PLANNING_AUTHORITY_RECEIPT_INVALID", field: "target.repositoryRealpath" });
    expect(refusal(parse((b) => { b.target.ownershipMarker = { path: "/private/tmp/ccc-r2c-i2/target/owner.json", sha256: "c".repeat(64) }; })))
      .toEqual({ code: "CCC_PLANNING_AUTHORITY_RECEIPT_INVALID", field: "target.ownershipMarker.path" });
    expect(refusal(parse((b) => { b.target.admittedFusionPaths = ["../escape/**"]; })))
      .toEqual({ code: "CCC_PLANNING_AUTHORITY_RECEIPT_INVALID", field: "target.admittedFusionPaths[0]" });
  });

  it("refuses outside the validity window as EXPIRED and a window over 7 days or before the deadline as INVALID", () => {
    expect(refusal(parse(undefined, { now: EXPIRES })))
      .toEqual({ code: "CCC_PLANNING_AUTHORITY_RECEIPT_EXPIRED", field: "expiresAt" });
    expect(refusal(parse(undefined, { now: "2026-10-14T11:59:59.999Z" })))
      .toEqual({ code: "CCC_PLANNING_AUTHORITY_RECEIPT_EXPIRED", field: "notBefore" });
    expect(refusal(parse((b) => { b.expiresAt = "2026-10-21T12:00:00.001Z"; })))
      .toEqual({ code: "CCC_PLANNING_AUTHORITY_RECEIPT_INVALID", field: "expiresAt" });
    expect(refusal(parse((b) => { b.expiresAt = "2026-10-16T11:59:59.999Z"; })))
      .toEqual({ code: "CCC_PLANNING_AUTHORITY_RECEIPT_INVALID", field: "expiresAt" });
    // Controls: exactly 7 days, and one millisecond before expiry.
    expect(parse((b) => { b.expiresAt = "2026-10-21T12:00:00.000Z"; }).ok).toBe(true);
    expect(parse(undefined, { now: "2026-10-16T11:59:59.999Z" }).ok).toBe(true);
    expect(refusal(parse(undefined, { now: DEADLINE })))
      .toEqual({ code: "CCC_PLANNING_AUTHORITY_RECEIPT_EXPIRED", field: "deadlineAt" });
    expect(refusal(parse((b) => { b.deadlineAt = "2026-02-30T00:00:00.000Z"; })))
      .toEqual({ code: "CCC_PLANNING_AUTHORITY_RECEIPT_INVALID", field: "deadlineAt" });
  });

  it("refuses more than one permitted protected action and any action other than live_execution", () => {
    expect(refusal(parse((b) => { b.permittedProtectedActions.push({ kind: "live_execution", release: "operator_confirm_after_import" }); })))
      .toEqual({ code: "CCC_PLANNING_AUTHORITY_RECEIPT_INVALID", field: "permittedProtectedActions" });
    expect(refusal(parse((b) => { b.permittedProtectedActions[0]!.kind = "merge"; })))
      .toEqual({ code: "CCC_PLANNING_AUTHORITY_RECEIPT_INVALID", field: "permittedProtectedActions[0].kind" });
    expect(parse((b) => { b.permittedProtectedActions = []; }).ok).toBe(true);
  });
});

// ---------------------------------------------------------------- envelope check

const MEMBER_BASE = {
  actionId: "live-execution", actionTarget: "campaign", transport: "pi", promptSchema: "ccc-prd.execution-prompt.v2",
  promptSha256: "2".repeat(64), routeSha256: "3".repeat(64), bindingHash: "4".repeat(64), approvalRequestId: "approval-1",
  memberHash: "5".repeat(64), modelId: "glm/glm-5.3-flash", providerId: FLASH_PROVIDER,
} as const;

function controlAuthorization(): CccCampaignExecutionAuthorization {
  return {
    projectId: "proj-r2c-i2", importId: "import-1", campaignId: "campaign-1",
    idempotencyKey: cccPlanningImportKey(RUN_ID, 1),
    workflowId: "workflow-1", workItemId: "work-item-1", workflowIrHash: "6".repeat(64), packetHash: "7".repeat(64),
    sidecarHash: "8".repeat(64), bundleHash: "9".repeat(64), manifestHash: "a".repeat(64), executionPolicySha256: "b".repeat(64),
    targetRepository: "/private/tmp/ccc-r2c-i2/target", targetBase: B1,
    campaignStartedAt: "2026-10-14T20:00:00.000Z", campaignDeadlineAt: "2026-10-15T20:00:00.000Z",
    maxRequests: 3072, maxConcurrency: 1,
    authorizationId: "authorization-1", authorizationDigest: "c".repeat(64), memberSetHash: "d".repeat(64),
    members: [
      { ...MEMBER_BASE, ordinal: 1, nativeTaskId: "FN-1", semanticTaskId: "T1" },
      { ...MEMBER_BASE, ordinal: 2, nativeTaskId: "FN-2", semanticTaskId: "T2" },
    ],
    schemaVersion: "ccc-campaign.execution-authorization.v1",
    expectedRequestCount: 0, status: "issued",
    requester: { actorId: "ccc-planning-controller", actorType: "system", actorName: "CCC planning receipt" },
    notBeforeAt: "2026-10-14T20:00:00.000Z", expiresAt: "2026-10-15T20:00:00.000Z",
    createdAt: "2026-10-14T20:00:00.000Z", updatedAt: "2026-10-14T20:00:00.000Z",
  };
}

type EnvelopeInput = Parameters<typeof assertCccPlanningExecutionAuthorizationWithinReceipt>[0];

function controlEnvelope(): EnvelopeInput {
  const receipt = controlReceipt();
  return {
    receipt, receiptSha256: sha256(canonicalCccPrdJson(receipt)),
    run: { runId: RUN_ID, runRevision: 1, deadlineAt: DEADLINE, implementationCallsRemaining: 3072,
      compiledProviderTaskCount: 2, writerProviderId: FLASH_PROVIDER },
    authorization: controlAuthorization(),
    baseline: { commit: B1, firstParent: B0, changedPaths: ["Taskfile.yml", "proof/verify-text-stats.mjs", "proof/fixtures/a.txt"] },
    now: "2026-10-14T20:00:05.000Z",
  };
}

function envelope(mutate: (input: EnvelopeInput & { authorization: Record<string, unknown> }) => EnvelopeInput | void): { code: string; field: string } {
  const input = controlEnvelope() as EnvelopeInput & { authorization: Record<string, unknown> };
  const next = mutate(input) ?? input;
  const result = assertCccPlanningExecutionAuthorizationWithinReceipt(next);
  return result.ok ? { code: "within", field: "" } : { code: result.code, field: result.field };
}

const MISMATCH = "CCC_PLANNING_RECEIPT_ENVELOPE_MISMATCH";

describe("receipt envelope check", () => {
  it("accepts the control authorization inside the receipt envelope", () => {
    expect(assertCccPlanningExecutionAuthorizationWithinReceipt(controlEnvelope())).toEqual({ ok: true });
  });

  it("accepts the import key ccc-plan:<24hex>:r1 and refuses ccc-plan:<24hex>:<digest>", () => {
    expect(envelope((i) => { i.authorization = { ...i.authorization, idempotencyKey: `${RUN_ID}:r1` } as never; }))
      .toEqual({ code: "within", field: "" });
    expect(envelope((i) => { i.authorization = { ...i.authorization, idempotencyKey: `${RUN_ID}:${"9".repeat(64)}` } as never; }))
      .toEqual({ code: MISMATCH, field: "authorization.idempotencyKey" });
    // Another revision's key is refused too.
    expect(envelope((i) => { i.authorization = { ...i.authorization, idempotencyKey: `${RUN_ID}:r2` } as never; }))
      .toEqual({ code: MISMATCH, field: "authorization.idempotencyKey" });
  });

  it("refuses a member on glm/glm-5.3, a member on another provider and a non-pi member", () => {
    const withMember = (patch: Record<string, unknown>) => (i: EnvelopeInput) => ({
      ...i, authorization: { ...i.authorization, members: [{ ...i.authorization.members[0]!, ...patch }, i.authorization.members[1]!] },
    }) as EnvelopeInput;
    expect(envelope(withMember({ modelId: "glm/glm-5.3" }))).toEqual({ code: MISMATCH, field: "authorization.members[0].modelId" });
    expect(envelope(withMember({ providerId: "ccc-glm53" }))).toEqual({ code: MISMATCH, field: "authorization.members[0].providerId" });
    expect(envelope(withMember({ transport: "cli" }))).toEqual({ code: MISMATCH, field: "authorization.members[0].transport" });
    expect(envelope((i) => ({ ...i, run: { ...i.run, compiledProviderTaskCount: 3 } })))
      .toEqual({ code: MISMATCH, field: "authorization.members" });
    expect(envelope((i) => ({ ...i, run: { ...i.run, writerProviderId: "ccc-glm53" } })))
      .toEqual({ code: MISMATCH, field: "run.writerProviderId" });
  });

  it("refuses maxRequests above the remaining allocation and a deadline or expiry after the receipt's", () => {
    expect(envelope((i) => ({ ...i, run: { ...i.run, implementationCallsRemaining: 3071 } })))
      .toEqual({ code: MISMATCH, field: "authorization.maxRequests" });
    expect(envelope((i) => { i.authorization = { ...i.authorization, campaignDeadlineAt: "2026-10-16T12:00:00.001Z" } as never; }))
      .toEqual({ code: MISMATCH, field: "authorization.campaignDeadlineAt" });
    expect(envelope((i) => ({ ...i, run: { ...i.run, deadlineAt: "2026-10-15T19:59:59.999Z" } })))
      .toEqual({ code: MISMATCH, field: "authorization.campaignDeadlineAt" });
    expect(envelope((i) => { i.authorization = { ...i.authorization, expiresAt: "2026-10-20T12:00:00.001Z" } as never; }))
      .toEqual({ code: MISMATCH, field: "authorization.expiresAt" });
    expect(envelope((i) => ({ ...i, now: EXPIRES }))).toEqual({ code: MISMATCH, field: "now" });
  });

  it("refuses a baseline whose first parent is not the receipt base or that changes a path outside the admitted Fusion paths", () => {
    expect(envelope((i) => ({ ...i, baseline: { ...i.baseline, firstParent: "e".repeat(40) } })))
      .toEqual({ code: MISMATCH, field: "baseline.firstParent" });
    expect(envelope((i) => ({ ...i, baseline: { ...i.baseline, changedPaths: [...i.baseline.changedPaths, "src/index.mjs"] } })))
      .toEqual({ code: MISMATCH, field: "baseline.changedPaths" });
    // "proof/**" matches below proof/ only, never a sibling with the same prefix or a different case.
    expect(envelope((i) => ({ ...i, baseline: { ...i.baseline, changedPaths: ["proofs/x.mjs"] } })))
      .toEqual({ code: MISMATCH, field: "baseline.changedPaths" });
    expect(envelope((i) => ({ ...i, baseline: { ...i.baseline, changedPaths: ["taskfile.yml"] } })))
      .toEqual({ code: MISMATCH, field: "baseline.changedPaths" });
    expect(envelope((i) => ({ ...i, baseline: { ...i.baseline, commit: "f".repeat(40) } })))
      .toEqual({ code: MISMATCH, field: "authorization.targetBase" });
    expect(envelope((i) => { i.authorization = { ...i.authorization, targetRepository: "/private/tmp/other/target" } as never; }))
      .toEqual({ code: MISMATCH, field: "authorization.targetRepository" });
  });

  it("refuses when the receipt asks for the operator, or is not the receipt the run consumed", () => {
    const operatorReceipt = parse((b) => { b.permittedProtectedActions = [{ kind: "live_execution", release: "operator_confirm_after_import" }]; });
    if (!operatorReceipt.ok) throw new Error("operator receipt fixture refused");
    expect(envelope((i) => ({ ...i, receipt: operatorReceipt.receipt, receiptSha256: operatorReceipt.receiptSha256 })))
      .toEqual({ code: MISMATCH, field: "receipt.permittedProtectedActions" });
    expect(envelope((i) => ({ ...i, receiptSha256: "0".repeat(64) }))).toEqual({ code: MISMATCH, field: "receiptSha256" });
    // Control: the receipt's identity is its named fields, so a wider object is still the consumed receipt (errata E1-11).
    expect(envelope((i) => ({ ...i, receipt: { ...i.receipt, note: "not a receipt field" } as CccPlanningLiveAuthorityReceiptV1 })))
      .toEqual({ code: "within", field: "" });
    expect(envelope((i) => { i.authorization = { ...i.authorization, projectId: "another-project" } as never; }))
      .toEqual({ code: MISMATCH, field: "authorization.projectId" });
  });
});
