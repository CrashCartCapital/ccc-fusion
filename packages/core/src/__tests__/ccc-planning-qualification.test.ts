import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalCccPrdJson } from "../ccc-prd/contract.js";
import type { CccPlanningLiveAuthorityReceiptV1 } from "../ccc-planning/authority.js";
import {
  decideCccPlanningTargetAdmission,
  UNQUALIFIED_CCC_PLANNING_QUALIFICATION_PORT,
  type CccPlanningQualificationCertificateV1,
  type CccPlanningQualificationDigestsV1,
} from "../ccc-planning/qualification.js";

/*
FNXC:CccPlanningQualification 2026-10-14-13:45:
Card K2 RED for the pre-qualification rule (D24, PRD section 7, critic 11). Until I6 the qualification port finds no certificate, so G0 admits only an owned disposable target named by a receipt. Each refusal has a control on the same fixture that differs in one field and is admitted, so a refuse-everything decision fails too. The receipt fixtures only need the fields the decision reads; an `admitted_repository` receipt cannot be expressed in the I1 receipt type, so it is cast, exactly as a future widened receipt would arrive.
FNXC:CccPlanningQualification 2026-10-14-17:16:
Repair 1 (errata E5-K2 item 5): a certificate of another schema, or whose profile scope omits full-v2, qualifies nothing even when its id is the true digest of its body; round-1 mutants that deleted either check left every test green.
FNXC:CccPlanningQualification 2026-10-14-18:27:
Repair 2 (errata E7-K item 1): a scope field that is a string, not a list, made `.includes` a substring search, so a certificate whose scope named no class, mode or profile as a list entry still admitted a real repository (adversary probe F1). Each scope field must be an array of strings; the certificate id is recomputed for every malformed body, so only the field's type differs from the admitted twin.
*/

const DIGESTS: CccPlanningQualificationDigestsV1 = {
  controller: "1".repeat(64), policy: "2".repeat(64), prompts: "3".repeat(64), toolchain: "4".repeat(64),
  runner: "5".repeat(64), corpus: "6".repeat(64), proof: "7".repeat(64), models: "8".repeat(64),
};

function receiptWith(targetClass: string, mode: "spec" | "build" = "build"): CccPlanningLiveAuthorityReceiptV1 {
  return {
    mode, profile: "full-v2",
    target: { class: targetClass, scratchRoot: "/private/tmp/ccc-r2c-i2", repositoryRealpath: "/private/tmp/ccc-r2c-i2/target" },
  } as unknown as CccPlanningLiveAuthorityReceiptV1;
}

function certificate(scope: { targetClasses: ("owned_disposable" | "admitted_repository")[]; modes: ("spec" | "build")[] },
  override?: { schema?: string; profiles?: string[] }): CccPlanningQualificationCertificateV1 {
  const body = {
    schema: (override?.schema ?? "ccc-planning.qualification-certificate.v1") as "ccc-planning.qualification-certificate.v1",
    issuedAt: "2027-01-01T00:00:00.000Z",
    scope: { targetClasses: scope.targetClasses, modes: scope.modes, profiles: (override?.profiles ?? ["full-v2"]) as ["full-v2"] },
    digests: DIGESTS,
    evidence: { reportSha256: "9".repeat(64), heldOutResultsSha256: "a".repeat(64), reviewDispositionsSha256: "b".repeat(64) },
  };
  const certificateId = createHash("sha256").update(canonicalCccPrdJson(body), "utf8").digest("hex");
  return { ...body, certificateId };
}

/** A certificate with any scope value at all, its id the true digest of its body: the shape a future port could hand over. */
function rawCertificate(scope: Readonly<Record<string, unknown>>): CccPlanningQualificationCertificateV1 {
  const body = {
    schema: "ccc-planning.qualification-certificate.v1",
    issuedAt: "2027-01-01T00:00:00.000Z",
    scope,
    digests: DIGESTS,
    evidence: { reportSha256: "9".repeat(64), heldOutResultsSha256: "a".repeat(64), reviewDispositionsSha256: "b".repeat(64) },
  };
  const certificateId = createHash("sha256").update(canonicalCccPrdJson(body), "utf8").digest("hex");
  return { ...body, certificateId } as unknown as CccPlanningQualificationCertificateV1;
}

describe("qualification port", () => {
  it("the unqualified port finds no certificate for any digest tuple", async () => {
    await expect(UNQUALIFIED_CCC_PLANNING_QUALIFICATION_PORT.findCertificate(DIGESTS)).resolves.toBeNull();
    await expect(UNQUALIFIED_CCC_PLANNING_QUALIFICATION_PORT.findCertificate({ ...DIGESTS, models: "f".repeat(64) }))
      .resolves.toBeNull();
    expect(Object.isFrozen(UNQUALIFIED_CCC_PLANNING_QUALIFICATION_PORT)).toBe(true);
  });
});

describe("pre-qualification target admission", () => {
  it("refuses an admitted_repository class with the null certificate as QUALIFICATION_REQUIRED; the owned_disposable control is admitted", async () => {
    const found = await UNQUALIFIED_CCC_PLANNING_QUALIFICATION_PORT.findCertificate(DIGESTS);
    expect(decideCccPlanningTargetAdmission({ certificate: found, receipt: receiptWith("admitted_repository"), mode: "build" }))
      .toEqual({ admitted: false, code: "CCC_PLANNING_QUALIFICATION_REQUIRED" });
    expect(decideCccPlanningTargetAdmission({ certificate: found, receipt: receiptWith("owned_disposable"), mode: "build" }))
      .toEqual({ admitted: true, basis: "owned_disposable_receipt" });
  });

  it("refuses a missing receipt as AUTHORITY_RECEIPT_REQUIRED, with or without a certificate", () => {
    expect(decideCccPlanningTargetAdmission({ certificate: null, receipt: null, mode: "spec" }))
      .toEqual({ admitted: false, code: "CCC_PLANNING_AUTHORITY_RECEIPT_REQUIRED" });
    const cert = certificate({ targetClasses: ["owned_disposable", "admitted_repository"], modes: ["spec", "build"] });
    expect(decideCccPlanningTargetAdmission({ certificate: cert, receipt: null, mode: "spec" }))
      .toEqual({ admitted: false, code: "CCC_PLANNING_AUTHORITY_RECEIPT_REQUIRED" });
  });

  it("refuses a receipt issued for the other mode as AUTHORITY_RECEIPT_REQUIRED", () => {
    expect(decideCccPlanningTargetAdmission({ certificate: null, receipt: receiptWith("owned_disposable", "spec"), mode: "build" }))
      .toEqual({ admitted: false, code: "CCC_PLANNING_AUTHORITY_RECEIPT_REQUIRED" });
    expect(decideCccPlanningTargetAdmission({ certificate: null, receipt: receiptWith("owned_disposable", "spec"), mode: "spec" }))
      .toEqual({ admitted: true, basis: "owned_disposable_receipt" });
  });

  it("admits an admitted_repository through a certificate whose scope covers its class and mode", () => {
    const cert = certificate({ targetClasses: ["admitted_repository"], modes: ["build"] });
    expect(decideCccPlanningTargetAdmission({ certificate: cert, receipt: receiptWith("admitted_repository"), mode: "build" }))
      .toEqual({ admitted: true, basis: "qualification_certificate" });
  });

  it("ignores a certificate whose scope omits the class or mode, or whose id is not the digest of its body", () => {
    const repository = receiptWith("admitted_repository");
    const otherMode = certificate({ targetClasses: ["admitted_repository"], modes: ["spec"] });
    expect(decideCccPlanningTargetAdmission({ certificate: otherMode, receipt: repository, mode: "build" }))
      .toEqual({ admitted: false, code: "CCC_PLANNING_QUALIFICATION_REQUIRED" });
    const otherClass = certificate({ targetClasses: ["owned_disposable"], modes: ["build"] });
    expect(decideCccPlanningTargetAdmission({ certificate: otherClass, receipt: repository, mode: "build" }))
      .toEqual({ admitted: false, code: "CCC_PLANNING_QUALIFICATION_REQUIRED" });
    const good = certificate({ targetClasses: ["admitted_repository"], modes: ["build"] });
    const tampered = { ...good, digests: { ...good.digests, models: "f".repeat(64) } };
    expect(decideCccPlanningTargetAdmission({ certificate: tampered, receipt: repository, mode: "build" }))
      .toEqual({ admitted: false, code: "CCC_PLANNING_QUALIFICATION_REQUIRED" });
    // The owned disposable rule still holds when a certificate does not apply.
    expect(decideCccPlanningTargetAdmission({ certificate: tampered, receipt: receiptWith("owned_disposable"), mode: "build" }))
      .toEqual({ admitted: true, basis: "owned_disposable_receipt" });
  });

  it("ignores a certificate of another schema or whose profile scope omits full-v2, each with its id recomputed", () => {
    // E5-K2 item 5: the schema and profile-scope guards the round-1 mutants (Q01, Q02) showed unprotected.
    const repository = receiptWith("admitted_repository");
    const scope = { targetClasses: ["admitted_repository" as const], modes: ["build" as const] };
    for (const override of [{ schema: "ccc-planning.qualification-certificate.v0" }, { profiles: ["full-v1"] }, { profiles: [] }]) {
      expect(decideCccPlanningTargetAdmission({ certificate: certificate(scope, override), receipt: repository, mode: "build" }),
        JSON.stringify(override)).toEqual({ admitted: false, code: "CCC_PLANNING_QUALIFICATION_REQUIRED" });
    }
    expect(decideCccPlanningTargetAdmission({ certificate: certificate(scope, { profiles: ["full-v2"] }), receipt: repository, mode: "build" }))
      .toEqual({ admitted: true, basis: "qualification_certificate" });
  });

  it("ignores a certificate whose scope field is a string or holds a non-string entry, each with its id recomputed, and admits the array twin", () => {
    // E7-K item 1: a string scope field made `.includes` a substring search (adversary probe F1).
    const repository = receiptWith("admitted_repository");
    const arrays = { targetClasses: ["admitted_repository"], modes: ["build"], profiles: ["full-v2"] };
    const rows: readonly [string, Readonly<Record<string, unknown>>][] = [
      ["targetClasses as a string", { ...arrays, targetClasses: "admitted_repository" }],
      ["modes as a string", { ...arrays, modes: "build" }],
      ["profiles as a string", { ...arrays, profiles: "full-v2" }],
      ["targetClasses with a non-string entry", { ...arrays, targetClasses: ["admitted_repository", 7] }],
    ];
    for (const [label, scope] of rows) {
      expect(decideCccPlanningTargetAdmission({ certificate: rawCertificate(scope), receipt: repository, mode: "build" }), label)
        .toEqual({ admitted: false, code: "CCC_PLANNING_QUALIFICATION_REQUIRED" });
    }
    expect(decideCccPlanningTargetAdmission({ certificate: rawCertificate(arrays), receipt: repository, mode: "build" }))
      .toEqual({ admitted: true, basis: "qualification_certificate" });
  });
});
