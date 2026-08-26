import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as core from "@fusion/core";
import { canonicalCccPrdJson } from "../ccc-prd/contract.js";

type OssReuseContract = {
  parseCccPrdOssReuseEvidence: (value: unknown) => unknown;
  computeCccPrdOssReuseEvidenceSha256: (value: never) => string;
};

const ccc = core as typeof core & OssReuseContract;

function cost(input: {
  initialAdoptionHours: number;
  adaptationHours?: number;
  annualMaintenanceHours: number;
  annualSecurityHours: number;
  horizonYears?: number;
  confidence?: "bounded_estimate" | "pilot_measured";
  evidenceIds: string[];
}) {
  const projection = {
    initialAdoptionHours: input.initialAdoptionHours,
    adaptationHours: input.adaptationHours ?? 0,
    annualMaintenanceHours: input.annualMaintenanceHours,
    annualSecurityHours: input.annualSecurityHours,
    horizonYears: input.horizonYears ?? 2,
    totalOwnershipHours: input.initialAdoptionHours
      + (input.adaptationHours ?? 0)
      + (input.horizonYears ?? 2)
      * (input.annualMaintenanceHours + input.annualSecurityHours),
    confidence: input.confidence ?? "bounded_estimate",
    evidenceIds: [...input.evidenceIds].sort(),
  };
  return {
    ...projection,
    receiptSha256: createHash("sha256")
      .update(canonicalCccPrdJson(projection), "utf8")
      .digest("hex"),
  };
}

function unknownCost(horizonYears = 2) {
  const projection = {
    initialAdoptionHours: 0,
    adaptationHours: 0,
    annualMaintenanceHours: 0,
    annualSecurityHours: 0,
    horizonYears,
    totalOwnershipHours: 0,
    confidence: "unknown",
    evidenceIds: [] as string[],
  };
  return {
    ...projection,
    receiptSha256: createHash("sha256")
      .update(canonicalCccPrdJson(projection), "utf8")
      .digest("hex"),
  };
}

function applicationEvidence(): Record<string, unknown> {
  return {
    schema: "ccc-prd.oss-reuse-evidence.v1",
    project: {
      repositoryId: "new-product",
      gitState: "not_initialized",
      fusionMarker: "absent",
      applicationState: "absent",
      snapshotSha256: "a".repeat(64),
    },
    reuseKind: "application_base",
    boundedCapability: null,
    requiredCapabilities: ["web-ui", "task-api"],
    criticalCapabilities: ["task-api"],
    discovery: {
      status: "completed",
      candidatesConsidered: 2,
      positiveControl: "pass",
      negativeControl: "pass",
    },
    scratchCost: cost({
      initialAdoptionHours: 80,
      annualMaintenanceHours: 20,
      annualSecurityHours: 10,
      evidenceIds: ["EVIDENCE-SCRATCH"],
    }),
    candidates: [{
      kind: "application_base",
      id: "candidate-a",
      repository: {
        repositoryId: "example/project",
        revision: "0123456789abcdef0123456789abcdef01234567",
        treeSha256: "b".repeat(64),
      },
      licenseExpression: "Apache-2.0",
      gates: {
        license: { state: "offline_proven", outcome: "pass" },
        sourceProvenance: { state: "offline_proven", outcome: "pass" },
        staticSafety: { state: "offline_proven", outcome: "pass" },
        reproducibleBootstrap: { state: "offline_proven", outcome: "pass" },
        tests: { state: "offline_proven", outcome: "pass" },
      },
      coveredCapabilities: ["web-ui", "task-api"],
      architecture: {
        introducesApplicationLifecycleOwner: false,
        introducesSecondaryRuntimeOwner: false,
      },
      deadWeightPercent: 10,
      baseOwnershipCost: cost({
        initialAdoptionHours: 30,
        annualMaintenanceHours: 10,
        annualSecurityHours: 5,
        evidenceIds: ["EVIDENCE-CANDIDATE"],
      }),
      adaptationPlan: null,
    }],
  };
}

describe("CCC PRD open-source reuse evidence contract", () => {
  it("exports the strict evidence parser from the public core package", () => {
    expect(typeof ccc.parseCccPrdOssReuseEvidence).toBe("function");
  });

  it("normalizes semantic sets and deeply freezes validated evidence", () => {
    const parsed = ccc.parseCccPrdOssReuseEvidence(applicationEvidence()) as {
      requiredCapabilities: readonly string[];
      candidates: readonly [{ coveredCapabilities: readonly string[] }];
    };

    expect(parsed.requiredCapabilities).toEqual(["task-api", "web-ui"]);
    expect(parsed.candidates[0].coveredCapabilities).toEqual(["task-api", "web-ui"]);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.candidates)).toBe(true);
    expect(Object.isFrozen(parsed.candidates[0])).toBe(true);
  });

  it("allows an unknown candidate cost to share the packet planning horizon", () => {
    const evidence = applicationEvidence();
    const candidate = (evidence.candidates as Array<Record<string, unknown>>)[0];
    candidate.baseOwnershipCost = unknownCost(2);

    const parsed = ccc.parseCccPrdOssReuseEvidence(evidence) as {
      candidates: readonly [{ baseOwnershipCost: { confidence: string; horizonYears: number } }];
    };

    expect(parsed.candidates[0].baseOwnershipCost).toMatchObject({
      confidence: "unknown",
      horizonYears: 2,
    });
  });

  it("allows an application-base packet with no critical capabilities", () => {
    const evidence = applicationEvidence();
    evidence.criticalCapabilities = [];

    const parsed = ccc.parseCccPrdOssReuseEvidence(evidence) as {
      criticalCapabilities: readonly string[];
    };

    expect(parsed.criticalCapabilities).toEqual([]);
  });

  it("rejects control characters before identifiers can enter diagnostics", () => {
    const evidence = applicationEvidence();
    const candidate = (evidence.candidates as Array<Record<string, unknown>>)[0];
    candidate.id = "candidate-\u001b[31m";

    expect(() => ccc.parseCccPrdOssReuseEvidence(evidence)).toThrowError(
      expect.objectContaining({
        message: expect.stringContaining("$.candidates[0].id"),
      }),
    );
  });

  it("rejects unknown fields with the exact object path", () => {
    const evidence = applicationEvidence();
    (evidence.project as Record<string, unknown>).surprise = true;

    expect(() => ccc.parseCccPrdOssReuseEvidence(evidence)).toThrowError(
      expect.objectContaining({
        code: "CCC_PRD_OSS_REUSE_EVIDENCE_INVALID",
        message: expect.stringContaining("$.project"),
      }),
    );
  });

  it("rejects a cost receipt whose controlling hours drift", () => {
    const evidence = applicationEvidence();
    const candidate = (evidence.candidates as Array<Record<string, unknown>>)[0];
    const ownership = candidate.baseOwnershipCost as Record<string, unknown>;
    ownership.initialAdoptionHours = 31;

    expect(() => ccc.parseCccPrdOssReuseEvidence(evidence)).toThrowError(
      expect.objectContaining({
        message: expect.stringContaining("$.candidates[0].baseOwnershipCost.totalOwnershipHours"),
      }),
    );
  });

  it("reports the caller's original candidate index before canonical sorting", () => {
    const evidence = applicationEvidence();
    const first = (evidence.candidates as Array<Record<string, any>>)[0];
    first.id = "candidate-z";
    const invalid = structuredClone(first);
    invalid.id = "candidate-a";
    invalid.coveredCapabilities = ["not-required"];
    invalid.baseOwnershipCost = cost({
      initialAdoptionHours: 20,
      annualMaintenanceHours: 5,
      annualSecurityHours: 2,
      evidenceIds: ["EVIDENCE-INVALID"],
    });
    (evidence.candidates as Array<Record<string, unknown>>).push(invalid);

    expect(() => ccc.parseCccPrdOssReuseEvidence(evidence)).toThrowError(
      expect.objectContaining({
        message: expect.stringContaining("$.candidates[1].coveredCapabilities"),
      }),
    );
  });

  it("requires package reuse to name exactly one matching bounded capability", () => {
    const evidence = applicationEvidence();
    evidence.reuseKind = "package_dependency";
    evidence.boundedCapability = "task-api";
    const candidate = (evidence.candidates as Array<Record<string, unknown>>)[0];
    candidate.kind = "package_dependency";

    expect(() => ccc.parseCccPrdOssReuseEvidence(evidence)).toThrowError(
      expect.objectContaining({
        message: expect.stringContaining("$.boundedCapability"),
      }),
    );
  });

  it("produces the same digest for equivalent semantic-set ordering and drifts on evidence", () => {
    const first = ccc.parseCccPrdOssReuseEvidence(applicationEvidence()) as never;
    const reordered = applicationEvidence();
    reordered.requiredCapabilities = ["task-api", "web-ui"];
    const second = ccc.parseCccPrdOssReuseEvidence(reordered) as never;
    expect(ccc.computeCccPrdOssReuseEvidenceSha256(first)).toBe(
      ccc.computeCccPrdOssReuseEvidenceSha256(second),
    );

    const changed = applicationEvidence();
    const candidate = (changed.candidates as Array<Record<string, unknown>>)[0];
    candidate.deadWeightPercent = 11;
    const third = ccc.parseCccPrdOssReuseEvidence(changed) as never;
    expect(ccc.computeCccPrdOssReuseEvidenceSha256(third)).not.toBe(
      ccc.computeCccPrdOssReuseEvidenceSha256(first),
    );
  });

  it("classifies present or malformed project markers as established and unknown facts as unknown", () => {
    const base = {
      repositoryId: "target",
      gitState: "initialized" as const,
      fusionMarker: "absent" as const,
      applicationState: "absent" as const,
      snapshotSha256: "a".repeat(64),
    };
    expect(core.classifyCccPrdOssReuseProject(base)).toBe("greenfield_standalone");
    expect(core.classifyCccPrdOssReuseProject({ ...base, fusionMarker: "malformed" })).toBe("existing_project_change");
    expect(core.classifyCccPrdOssReuseProject({ ...base, applicationState: "present" })).toBe("existing_project_change");
    expect(core.classifyCccPrdOssReuseProject({ ...base, gitState: "unknown" })).toBe("unknown");
  });
});
