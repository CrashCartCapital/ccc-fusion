import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalCccPrdJson } from "../ccc-prd/contract.js";
import {
  computeCccPlanningClosureDigest,
  computeCccPlanningEnvelopeIdentityDigest,
  decodeCccPlanningArtifactKey,
  encodeCccPlanningArtifactContent,
  encodeCccPlanningArtifactKey,
  CCC_PLANNING_ARTIFACT_KEY_MAX_LENGTH,
  CCC_PLANNING_ARTIFACT_MAX_BYTES,
  CCC_PLANNING_STAGE_KINDS,
  type CccPlanningArtifactEnvelopeV1,
} from "../ccc-planning/artifacts.js";
import { CccPlanningRefusal } from "../ccc-planning/errors.js";
import { CCC_PLANNING_STAGE_IDS } from "../ccc-planning/types.js";

/*
FNXC:CccPlanningArtifacts 2026-10-14-08:40:
Card K1 proof for the pure artifact envelope (CONTRACT-v2 sections 2.4 and 2.6). Keys decode from the right because stage ids such as `design-review` contain hyphens; a left-to-right split would read stage `design`. The stored text, its digest and the identity digest must be byte-exact, because migration 0043 recomputes the digest from the stored text and a text artifact that becomes a packet source must hash to its manifest sha256.
*/

function sha256(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const ENVELOPE: Omit<CccPlanningArtifactEnvelopeV1, "fence" | "publishedAt" | "identityDigest"> = {
  schema: "ccc-planning.artifact-envelope.v1",
  artifactKey: "cccplan-r001-design-review-a-v01",
  runId: `ccc-plan:${"0123456789abcdef01234567"}`,
  runRevision: 1,
  stageId: "design-review",
  slot: "a",
  version: 1,
  kind: "design_review",
  contentType: "application/json",
  contentSchema: "ccc-planning.design-review.v1",
  inputs: [{ artifactKey: "cccplan-r001-design-a-v01", digest: "a".repeat(64) }],
  producer: {
    kind: "model", roleId: "design-a-reviewer", instanceId: "session-1", attemptRef: "ccc-plan-attempt-x",
    requestedModel: "glm/glm-5.3", resolvedModel: "glm/glm-5.3", routeReceiptDigest: "b".repeat(64),
  },
  policy: { promptVersion: "p1", promptDigest: "c".repeat(64), toolPolicyVersion: "t1", toolPolicyDigest: "d".repeat(64) },
  outputDigest: "e".repeat(64),
  status: "complete",
};

describe("artifact keys", () => {
  it("decodes a hyphenated stage from the right", () => {
    expect(decodeCccPlanningArtifactKey("cccplan-r001-design-review-a-v01"))
      .toEqual({ runRevision: 1, stageId: "design-review", slot: "a", version: 1 });
    expect(decodeCccPlanningArtifactKey("cccplan-r012-design-a-v10"))
      .toEqual({ runRevision: 12, stageId: "design", slot: "a", version: 10 });
  });

  it("encodes with zero padding and round-trips every stage", () => {
    expect(encodeCccPlanningArtifactKey({ runRevision: 1, stageId: "design-review", slot: "a", version: 1 }))
      .toBe("cccplan-r001-design-review-a-v01");
    for (const stageId of CCC_PLANNING_STAGE_IDS) {
      const slot = { runRevision: 999, stageId, slot: "z9", version: 99 };
      const key = encodeCccPlanningArtifactKey(slot);
      expect(decodeCccPlanningArtifactKey(key), key).toEqual(slot);
    }
  });

  it("fits the longest legal key in 51 characters", () => {
    const longest = encodeCccPlanningArtifactKey({ runRevision: 999, stageId: "design-review", slot: "a".repeat(20), version: 99 });
    expect(longest).toHaveLength(CCC_PLANNING_ARTIFACT_KEY_MAX_LENGTH);
    expect(CCC_PLANNING_ARTIFACT_KEY_MAX_LENGTH).toBe(51);
  });

  it("refuses malformed keys on decode", () => {
    for (const key of [
      "cccplan-r001-unknown-a-v01", // stage not in the vocabulary
      "cccplan-r000-design-a-v01", // revision 0
      "cccplan-r001-design-a-v00", // version 0
      "cccplan-r001-design-A-v01", // upper-case slot
      "cccplan-r001-design-a_b-v01", // slot outside [a-z0-9]
      `cccplan-r001-design-${"a".repeat(21)}-v01`, // slot longer than 20
      "cccplan-r1-design-a-v01", // unpadded revision
      "plan-r001-design-a-v01", // wrong prefix
      "cccplan-r001-design-a-v01 ", // trailing byte
    ]) {
      expect(decodeCccPlanningArtifactKey(key), key).toBeNull();
    }
    // Control: the same shape with every field legal decodes.
    expect(decodeCccPlanningArtifactKey("cccplan-r001-design-a0-v01")).not.toBeNull();
  });

  it("refuses illegal slots on encode", () => {
    expect(() => encodeCccPlanningArtifactKey({ runRevision: 0, stageId: "spec", slot: "main", version: 1 })).toThrow(CccPlanningRefusal);
    expect(() => encodeCccPlanningArtifactKey({ runRevision: 1, stageId: "spec", slot: "Main", version: 1 })).toThrow(CccPlanningRefusal);
    expect(() => encodeCccPlanningArtifactKey({ runRevision: 1, stageId: "spec", slot: "main", version: 100 })).toThrow(CccPlanningRefusal);
    expect(() => encodeCccPlanningArtifactKey({ runRevision: 1, stageId: "nope" as never, slot: "main", version: 1 }))
      .toThrow(CccPlanningRefusal);
    expect(encodeCccPlanningArtifactKey({ runRevision: 1, stageId: "spec", slot: "main", version: 1 })).toBe("cccplan-r001-spec-main-v01");
  });
});

describe("stage kinds", () => {
  it("matches the frozen table in CONTRACT-v2 section 2.4", () => {
    expect(CCC_PLANNING_STAGE_KINDS).toEqual({
      admission: ["original_request", "admission_grant", "authority_receipt"],
      preflight: ["tool_fidelity_receipt", "confinement_qualification", "model_receipt"],
      intent: ["acceptance_cases", "acceptance_review", "objection", "decision_request", "model_receipt"],
      research: ["repository_snapshot", "research_evidence", "citation", "extraction", "extraction_review", "source_verification", "objection", "model_receipt"],
      design: ["design_alternative", "model_receipt"],
      "design-review": ["design_review", "objection", "model_receipt"],
      spec: ["requirement_map", "final_prd", "technical_annex", "decision_record", "model_receipt"],
      plan: ["task_plan", "routing_plan", "model_receipt"],
      verifier: ["verifier_bundle", "verifier_audit", "oracle_observation", "oracle_review", "objection", "model_receipt"],
      review: ["product_review", "technical_review", "adjudication", "objection", "budget_receipt", "model_receipt"],
      repair: ["decision_record", "requirement_map", "final_prd", "technical_annex", "task_plan", "routing_plan", "verifier_bundle", "model_receipt"],
      specready: ["spec_ready"],
      import: ["build_transition", "admission_facts", "packet_manifest", "sidecar", "bundle", "execution_plan", "authorship_receipt", "import_intent", "import_receipt", "live_execution_release"],
      operator: ["operator_answer", "build_grant", "budget_amendment"],
      invalidate: ["invalidation"],
      g7: ["task_review", "proof_results", "model_receipt"],
      g8: ["final_judgment", "proof_results", "model_receipt"],
    });
  });
});

describe("artifact content", () => {
  it("stores JSON as canonical text and digests those UTF-8 bytes", () => {
    const encoded = encodeCccPlanningArtifactContent({ type: "json", value: { b: 1, a: ["é", 2] } });
    expect(encoded).toEqual({
      text: '{"a":["é",2],"b":1}',
      outputDigest: sha256(Buffer.from('{"a":["é",2],"b":1}', "utf8")),
      contentType: "application/json",
    });
  });

  it("keeps text bytes exact, including a byte-order mark, so the digest equals the raw-bytes digest", () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("# Request\r\nnaïve\n", "utf8")]);
    const encoded = encodeCccPlanningArtifactContent({ type: "text", bytes });
    expect(encoded.contentType).toBe("text/markdown; charset=utf-8");
    expect(encoded.outputDigest).toBe(sha256(bytes));
    expect(Buffer.from(encoded.text, "utf8").equals(bytes)).toBe(true);
  });

  it("refuses invalid UTF-8 and NUL as NOT_UTF8, and oversize content as TOO_LARGE", () => {
    const invalid = (): unknown => encodeCccPlanningArtifactContent({ type: "text", bytes: Uint8Array.from([0x61, 0xc3, 0x28]) });
    expect(invalid).toThrow(CccPlanningRefusal);
    expect(invalid).toThrow(/CCC_PLANNING_ARTIFACT_NOT_UTF8/);
    expect(() => encodeCccPlanningArtifactContent({ type: "text", bytes: Uint8Array.from([0x61, 0x00, 0x62]) }))
      .toThrow(/CCC_PLANNING_ARTIFACT_NOT_UTF8/);
    expect(() => encodeCccPlanningArtifactContent({ type: "text", bytes: new Uint8Array(CCC_PLANNING_ARTIFACT_MAX_BYTES + 1).fill(0x61) }))
      .toThrow(/CCC_PLANNING_ARTIFACT_TOO_LARGE/);
    expect(() => encodeCccPlanningArtifactContent({ type: "json", value: { text: "a".repeat(CCC_PLANNING_ARTIFACT_MAX_BYTES) } }))
      .toThrow(/CCC_PLANNING_ARTIFACT_TOO_LARGE/);
    // Control: exactly the limit is admitted.
    expect(encodeCccPlanningArtifactContent({ type: "text", bytes: new Uint8Array(CCC_PLANNING_ARTIFACT_MAX_BYTES).fill(0x61) }).text)
      .toHaveLength(CCC_PLANNING_ARTIFACT_MAX_BYTES);
  });
});

describe("identity and closure digests", () => {
  it("digests the envelope without fence, publishedAt or identityDigest", () => {
    const digest = computeCccPlanningEnvelopeIdentityDigest(ENVELOPE);
    expect(digest).toBe(sha256(canonicalCccPrdJson(ENVELOPE)));
    const published = {
      ...ENVELOPE,
      fence: { kind: "admission" as const },
      publishedAt: "2026-10-14T00:00:00.000Z",
      identityDigest: digest,
    };
    expect(computeCccPlanningEnvelopeIdentityDigest(published)).toBe(digest);
    expect(computeCccPlanningEnvelopeIdentityDigest({ ...ENVELOPE, outputDigest: "f".repeat(64) })).not.toBe(digest);
  });

  it("treats an absent optional producer field like an undefined one", () => {
    const { attemptRef: _attemptRef, ...producer } = ENVELOPE.producer;
    void _attemptRef;
    expect(computeCccPlanningEnvelopeIdentityDigest({ ...ENVELOPE, producer: { ...producer, attemptRef: undefined } }))
      .toBe(computeCccPlanningEnvelopeIdentityDigest({ ...ENVELOPE, producer }));
  });

  it("digests a closure as its sorted unique refs", () => {
    const a = { artifactKey: "cccplan-r001-spec-main-v01", digest: "1".repeat(64) };
    const b = { artifactKey: "cccplan-r001-plan-main-v01", digest: "2".repeat(64) };
    const digest = computeCccPlanningClosureDigest([a, b]);
    expect(digest).toBe(sha256(canonicalCccPrdJson([b, a])));
    expect(computeCccPlanningClosureDigest([b, a, a])).toBe(digest);
    expect(computeCccPlanningClosureDigest([a])).not.toBe(digest);
    expect(() => computeCccPlanningClosureDigest([a, { ...a, digest: "3".repeat(64) }])).toThrow(CccPlanningRefusal);
  });
});
