import { createHash } from "node:crypto";
import { canonicalCccPrdJson } from "../ccc-prd/contract.js";
import type { CccPlanningLiveAuthorityReceiptV1 } from "./authority.js";

/*
FNXC:CccPlanningQualification 2026-10-14-13:55:
Pre-qualification (D24, PRD section 7, critic 11). A qualification certificate would let G0 admit a real repository, but none can exist before I6, so the port that finds one always answers null and G0 admits only an owned disposable target named by a valid receipt. Storage for certificates is decided in I6; no table is added before there is a certificate to store (ADR D Q3). A certificate, when one exists, is only a qualification: the receipt is still the authority, so no receipt (or a receipt for the other mode) is refused whatever the certificate says.
*/

export type CccPlanningQualificationDigestsV1 = Readonly<{
  controller: string;        // installed distManifestSha256
  policy: string;            // canonical SHA-256 of the versioned planning policy (roles, counters, budgets, ladder)
  prompts: string;           // SHA-256 over sorted (role, promptVersion, promptSha256)
  toolchain: string;         // semantic-proof toolchain identity (node, task, git, python paths and versions)
  runner: string;            // confinement profile set (SBPL digests) plus OS identity class
  corpus: string;            // sealed held-out case set
  proof: string;             // the zero-skip qualification proof report
  models: string;            // exact pinned route identities
}>;
export type CccPlanningQualificationCertificateV1 = Readonly<{
  schema: "ccc-planning.qualification-certificate.v1";
  certificateId: string;     // SHA-256 of the canonical body
  issuedAt: string;
  scope: Readonly<{ targetClasses: readonly ("owned_disposable" | "admitted_repository")[]; modes: readonly ("spec" | "build")[]; profiles: readonly ["full-v2"] }>;
  digests: CccPlanningQualificationDigestsV1;
  evidence: Readonly<{ reportSha256: string; heldOutResultsSha256: string; reviewDispositionsSha256: string }>;
}>;
export interface CccPlanningQualificationPort {
  findCertificate(current: CccPlanningQualificationDigestsV1): Promise<CccPlanningQualificationCertificateV1 | null>; // exact tuple match; any drift returns null
}

/** Always null until I6: no certificate exists, so nothing outside an owned disposable target is admitted. */
export const UNQUALIFIED_CCC_PLANNING_QUALIFICATION_PORT: CccPlanningQualificationPort = Object.freeze({
  findCertificate: async (): Promise<CccPlanningQualificationCertificateV1 | null> => null,
});

/** The certificate id hashes exactly the named body fields (errata E1-11), so extra fields cannot change it. */
function certificateBodyDigest(certificate: CccPlanningQualificationCertificateV1): string {
  const { scope, digests, evidence } = certificate;
  const body = {
    schema: certificate.schema,
    issuedAt: certificate.issuedAt,
    scope: { targetClasses: scope.targetClasses, modes: scope.modes, profiles: scope.profiles },
    digests: {
      controller: digests.controller, policy: digests.policy, prompts: digests.prompts, toolchain: digests.toolchain,
      runner: digests.runner, corpus: digests.corpus, proof: digests.proof, models: digests.models,
    },
    evidence: {
      reportSha256: evidence.reportSha256, heldOutResultsSha256: evidence.heldOutResultsSha256,
      reviewDispositionsSha256: evidence.reviewDispositionsSha256,
    },
  };
  return createHash("sha256").update(canonicalCccPrdJson(body), "utf8").digest("hex");
}

/** A scope list: an array whose entries are all strings. Anything else names nothing. */
function isStringList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/*
FNXC:CccPlanningQualification 2026-10-14-18:27:
Errata E7-K item 1. A string scope field made `.includes` a substring search, so a certificate whose scope named no class, mode or profile as a list entry still admitted a real repository (adversary probe F1). Each scope field must be an array of strings before any membership test; a certificate that fails that, or whose digest cannot be computed, qualifies nothing.
*/
function certificateApplies(
  certificate: CccPlanningQualificationCertificateV1, targetClass: string, mode: "spec" | "build", profile: string,
): boolean {
  try {
    if (certificate.schema !== "ccc-planning.qualification-certificate.v1") return false;
    if (certificate.certificateId !== certificateBodyDigest(certificate)) return false;
    const { targetClasses, modes, profiles } = certificate.scope as Readonly<Record<string, unknown>>;
    if (!isStringList(targetClasses) || !isStringList(modes) || !isStringList(profiles)) return false;
    return targetClasses.includes(targetClass) && modes.includes(mode) && profiles.includes(profile);
  } catch {
    return false; // a certificate whose fields cannot be read or digested qualifies nothing
  }
}

export function decideCccPlanningTargetAdmission(input: {
  certificate: CccPlanningQualificationCertificateV1 | null;
  receipt: CccPlanningLiveAuthorityReceiptV1 | null;
  mode: "spec" | "build";
}): { admitted: true; basis: "qualification_certificate" | "owned_disposable_receipt" }
  | { admitted: false; code: "CCC_PLANNING_QUALIFICATION_REQUIRED" | "CCC_PLANNING_AUTHORITY_RECEIPT_REQUIRED" } {
  const { certificate, receipt, mode } = input;
  if (receipt === null || receipt.mode !== mode) {
    return { admitted: false, code: "CCC_PLANNING_AUTHORITY_RECEIPT_REQUIRED" };
  }
  // Read as a plain string: a future receipt may name a class the I1 receipt type cannot express.
  const targetClass: string = receipt.target.class;
  if (certificate !== null && certificateApplies(certificate, targetClass, mode, receipt.profile)) {
    return { admitted: true, basis: "qualification_certificate" };
  }
  if (targetClass === "owned_disposable") return { admitted: true, basis: "owned_disposable_receipt" };
  return { admitted: false, code: "CCC_PLANNING_QUALIFICATION_REQUIRED" };
}
