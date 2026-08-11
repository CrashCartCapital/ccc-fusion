/*
Audit finding F1 (tracked as #19), observed live: corpus run 3 on hermes-setup
finished in 54s against a 256s baseline because it died early on a protected
action the model labelled "creation".

normalizeProtectedAction (packages/core) threw a bare Error for any kind
outside the 8 in its decisions map. The chunk lane's only catch tests
`instanceof CccPrdCustodyError`, and packages/core does not import the engine's
error class, so the throw escaped the chunk loop and killed the document --
then degraded further at understanding.ts into a generic
CCC_PRD_CHUNKED_UNDERSTANDING_FAILED, losing even the ability to say what went
wrong. The message named the offending kind but never the 8 legal values, so a
retry could not have acted on it either.

These prove the fault is now a repairable per-chunk violation that names the
bad value AND the allowed set.
*/
import { describe, expect, it } from "vitest";
import {
  CCC_PRD_AUTHORING_PROPOSAL_FRAGMENT_SCHEMA_VERSION,
  normalizeProtectedAction,
} from "@fusion/core";
import {
  describeCccPrdChunkFragmentShapeViolations,
  verifyCccPrdChunkFragment,
} from "../ccc-prd/chunk-verification.js";

/**
 * Pinned literally rather than imported, so this is an independent statement
 * of the contract instead of a restatement of whatever the implementation
 * happens to use.
 */
const ALLOWED_KINDS = [
  "promotion",
  "live_execution",
  "deletion",
  "merge",
  "publication",
  "credential",
  "billing",
  "upstream_write",
] as const;

const SOURCE_LINE = "Promote the release to production once the operator approves.";
const SOURCE = `${SOURCE_LINE}\n`;

function fragmentWithProtectedActionKind(kind: unknown): Record<string, unknown> {
  return {
    schema: CCC_PRD_AUTHORING_PROPOSAL_FRAGMENT_SCHEMA_VERSION,
    authorityRoles: [],
    requirements: [],
    proofs: [],
    tasks: [],
    edges: [],
    workflows: [],
    documents: [],
    artifacts: [],
    importIntents: [],
    protectedActions: [{
      id: "protected-action-1",
      kind,
      target: "production",
      sourceRefs: [{ path: "doc.md", exactQuote: SOURCE_LINE }],
      materialItemIds: [],
    }],
    unresolvedDecisions: [],
    ambiguities: [],
    exceptions: [],
  };
}

describe("an unknown protected-action kind is repairable, not fatal", () => {
  it("rejects the kind in the fragment shape gate, naming the bad value and every allowed value", () => {
    const violations = describeCccPrdChunkFragmentShapeViolations(
      fragmentWithProtectedActionKind("creation"),
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("\"creation\"");
    // A rejection the model cannot act on is nearly as bad as a crash: the
    // legal set has to travel with the complaint.
    for (const kind of ALLOWED_KINDS) {
      expect(violations[0]).toContain(kind);
    }
  });

  it("returns a retry-eligible chunk outcome instead of throwing out of the chunk loop", () => {
    const fullSourceBytes = Buffer.from(SOURCE, "utf8");

    const outcome = verifyCccPrdChunkFragment({
      fragment: fragmentWithProtectedActionKind("creation"),
      sourcePath: "doc.md",
      fullSourceBytes,
      sliceBounds: { byteStart: 0, byteEnd: fullSourceBytes.byteLength },
      assignedMaterialItemIds: [],
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("CCC_PRD_CHUNK_FRAGMENT_INVALID");
    expect(outcome.retryEligible).toBe(true);
    expect(outcome.violations.join(" ")).toContain("creation");
  });

  it("still accepts every legitimate kind", () => {
    for (const kind of ALLOWED_KINDS) {
      expect(describeCccPrdChunkFragmentShapeViolations(
        fragmentWithProtectedActionKind(kind),
      )).toEqual([]);
    }
  });

  it("names the allowed set in the core rejection too, for the single-shot lane", () => {
    expect(() => normalizeProtectedAction({ kind: "creation", target: "production" }))
      .toThrow(/upstream_write/);
  });
});
