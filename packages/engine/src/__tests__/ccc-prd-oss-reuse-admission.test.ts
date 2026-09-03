import { createHash } from "node:crypto";
import {
  canonicalCccPrdJson,
  parseCccPrdOssReuseEvidence,
  type CccPrdOssReuseEvidence,
} from "@fusion/core";
import { describe, expect, it } from "vitest";
import * as engine from "@fusion/engine";

type OssReuseEvaluator = {
  evaluateCccPrdOssReuseAdmission: (evidence: unknown) => unknown;
  selectCccPrdOssPackage: (evidence: unknown) => unknown;
  recordCccPrdOssReferenceLearning: (evidence: unknown) => unknown;
};

const ccc = engine as typeof engine & OssReuseEvaluator;

function cost(input: {
  initialAdoptionHours: number;
  adaptationHours?: number;
  annualMaintenanceHours: number;
  annualSecurityHours: number;
  horizonYears?: number;
  evidenceId: string;
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
    confidence: "bounded_estimate",
    evidenceIds: [input.evidenceId],
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

function rawApplicationEvidence(): Record<string, any> {
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
    requiredCapabilities: ["task-api", "web-ui"],
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
      evidenceId: "EVIDENCE-SCRATCH",
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
      coveredCapabilities: ["task-api", "web-ui"],
      architecture: {
        introducesApplicationLifecycleOwner: false,
        introducesSecondaryRuntimeOwner: false,
      },
      deadWeightPercent: 10,
      baseOwnershipCost: cost({
        initialAdoptionHours: 30,
        annualMaintenanceHours: 10,
        annualSecurityHours: 5,
        evidenceId: "EVIDENCE-CANDIDATE-A",
      }),
      adaptationPlan: null,
    }],
  };
}

function applicationEvidence(mutator?: (raw: Record<string, any>) => void): CccPrdOssReuseEvidence {
  const raw = rawApplicationEvidence();
  mutator?.(raw);
  return parseCccPrdOssReuseEvidence(raw);
}

function packageEvidence(mutator?: (raw: Record<string, any>) => void): CccPrdOssReuseEvidence {
  const raw = rawApplicationEvidence();
  raw.project.fusionMarker = "present";
  raw.reuseKind = "package_dependency";
  raw.boundedCapability = "task-api";
  raw.requiredCapabilities = ["task-api"];
  raw.criticalCapabilities = ["task-api"];
  raw.candidates[0].kind = "package_dependency";
  raw.candidates[0].coveredCapabilities = ["task-api"];
  mutator?.(raw);
  return parseCccPrdOssReuseEvidence(raw);
}

function referenceEvidence(mutator?: (raw: Record<string, any>) => void): CccPrdOssReuseEvidence {
  const raw: Record<string, any> = {
    schema: "ccc-prd.oss-reuse-evidence.v1",
    project: {
      repositoryId: "existing-product",
      gitState: "initialized",
      fusionMarker: "present",
      applicationState: "present",
      snapshotSha256: "c".repeat(64),
    },
    reuseKind: "reference_only",
    boundedCapability: null,
    requiredCapabilities: [],
    criticalCapabilities: [],
    discovery: {
      status: "completed",
      candidatesConsidered: 2,
      positiveControl: "unknown",
      negativeControl: "unknown",
    },
    scratchCost: null,
    candidates: ["b", "a"].map((suffix) => ({
      kind: "reference_only",
      id: `reference-${suffix}`,
      repository: {
        repositoryId: `example/reference-${suffix}`,
        revision: "0123456789abcdef0123456789abcdef01234567",
        treeSha256: suffix.repeat(64),
      },
      sourceProvenance: { state: "offline_proven", outcome: "pass" },
      claims: [`CLAIM-${suffix.toUpperCase()}`],
    })),
  };
  mutator?.(raw);
  return parseCccPrdOssReuseEvidence(raw);
}

describe("CCC PRD open-source reuse admission", () => {
  it("exports the pure application-base evaluator from the public engine package", () => {
    expect(typeof ccc.evaluateCccPrdOssReuseAdmission).toBe("function");
  });

  it("exports separate package-selection and reference-learning surfaces", () => {
    expect(typeof ccc.selectCccPrdOssPackage).toBe("function");
    expect(typeof ccc.recordCccPrdOssReferenceLearning).toBe("function");
  });

  it("selects one bounded package without replacing an established application base", () => {
    const selection = engine.selectCccPrdOssPackage(packageEvidence());

    expect(selection).toMatchObject({
      decision: "package_selected",
      selectedCandidateId: "candidate-a",
      reasons: ["candidate candidate-a provides the bounded capability and is cheaper than scratch"],
      nextSmallestEvidence: null,
    });
    expect(engine.evaluateCccPrdOssReuseAdmission(packageEvidence()).decision).toBe(
      "insufficient_evidence",
    );
  });

  it("rejects a package that tries to own the application lifecycle or a second runtime", () => {
    const selection = engine.selectCccPrdOssPackage(packageEvidence((raw) => {
      raw.candidates[0].architecture.introducesApplicationLifecycleOwner = true;
    }));

    expect(selection).toMatchObject({
      decision: "rejected",
      selectedCandidateId: null,
      reasons: ["package candidates cannot replace the application lifecycle or runtime owner"],
    });
  });

  it("keeps package selection insufficient while a controlling gate is unknown", () => {
    const selection = engine.selectCccPrdOssPackage(packageEvidence((raw) => {
      raw.candidates[0].gates.license = { state: "unknown", outcome: "unknown" };
    }));

    expect(selection).toMatchObject({
      decision: "insufficient_evidence",
      nextSmallestEvidence: "prove candidate candidate-a: license evidence is unknown",
    });
  });

  it("reports an unknown package gate before an unknown scratch cost", () => {
    const selection = engine.selectCccPrdOssPackage(packageEvidence((raw) => {
      raw.scratchCost = unknownCost();
      raw.candidates[0].gates.sourceProvenance = {
        state: "unknown",
        outcome: "unknown",
      };
    }));

    expect(selection).toMatchObject({
      decision: "insufficient_evidence",
      nextSmallestEvidence:
        "prove candidate candidate-a: sourceProvenance evidence is unknown",
    });
  });

  it("records pinned reference learning without granting code-reuse admission", () => {
    const evidence = referenceEvidence();
    const learning = engine.recordCccPrdOssReferenceLearning(evidence);

    expect(learning).toMatchObject({
      decision: "reference_recorded",
      referenceCandidateIds: ["reference-a", "reference-b"],
      reasons: ["recorded 2 pinned reference-only candidates without code-adoption authority"],
      nextSmallestEvidence: null,
    });
    expect(engine.evaluateCccPrdOssReuseAdmission(evidence).decision).toBe(
      "insufficient_evidence",
    );
    expect(engine.selectCccPrdOssPackage(evidence).decision).toBe(
      "insufficient_evidence",
    );
  });

  it("does not report reference learning success when no reference was provided", () => {
    const learning = engine.recordCccPrdOssReferenceLearning(referenceEvidence((raw) => {
      raw.candidates = [];
    }));

    expect(learning).toMatchObject({
      decision: "insufficient_evidence",
      referenceCandidateIds: [],
      reasons: ["no reference candidates were provided"],
      nextSmallestEvidence: "provide one pinned reference candidate",
    });
  });

  it("does not record reference learning from merely declared source provenance", () => {
    const learning = engine.recordCccPrdOssReferenceLearning(referenceEvidence((raw) => {
      raw.candidates[1].sourceProvenance = { state: "declared", outcome: "pass" };
    }));

    expect(learning).toMatchObject({
      decision: "insufficient_evidence",
      referenceCandidateIds: [],
      nextSmallestEvidence: "prove pinned source provenance for reference reference-a",
    });
  });

  it("rejects a foreign application base before scoring an established project", () => {
    const recommendation = engine.evaluateCccPrdOssReuseAdmission(
      applicationEvidence((raw) => {
        raw.project.fusionMarker = "present";
      }),
    );

    expect(recommendation).toMatchObject({
      decision: "rejected",
      selectedCandidateId: null,
      reasons: ["foreign application bases are forbidden for established projects"],
      nextSmallestEvidence: null,
    });
  });

  it("returns insufficient evidence when project classification is unknown", () => {
    const recommendation = engine.evaluateCccPrdOssReuseAdmission(
      applicationEvidence((raw) => {
        raw.project.gitState = "unknown";
      }),
    );

    expect(recommendation).toMatchObject({
      decision: "insufficient_evidence",
      reasons: ["project classification is unknown"],
      nextSmallestEvidence: "prove project git, Fusion marker, and application state",
    });
  });

  it("selects a fully proven close-match fork that is cheaper than scratch", () => {
    const recommendation = engine.evaluateCccPrdOssReuseAdmission(applicationEvidence());

    expect(recommendation).toMatchObject({
      decision: "close_match_fork",
      selectedCandidateId: "candidate-a",
      reasons: ["candidate candidate-a is a proven close match and cheaper than scratch"],
      nextSmallestEvidence: null,
      candidateDiagnostics: [{
        candidateId: "candidate-a",
        eligible: true,
        coveragePercent: 100,
        effectiveOwnershipHours: 60,
        reasons: [],
      }],
    });
  });

  it("fails closed when one campaign-controlling candidate gate is unknown", () => {
    const recommendation = engine.evaluateCccPrdOssReuseAdmission(
      applicationEvidence((raw) => {
        raw.candidates[0].gates.staticSafety = { state: "unknown", outcome: "unknown" };
      }),
    );

    expect(recommendation).toMatchObject({
      decision: "insufficient_evidence",
      selectedCandidateId: null,
      nextSmallestEvidence: "prove candidate candidate-a: staticSafety evidence is unknown",
    });
  });

  it("reports an unknown candidate gate before an unknown scratch cost", () => {
    const recommendation = engine.evaluateCccPrdOssReuseAdmission(
      applicationEvidence((raw) => {
        raw.scratchCost = unknownCost();
        raw.candidates[0].gates.license = { state: "unknown", outcome: "unknown" };
      }),
    );

    expect(recommendation).toMatchObject({
      decision: "insufficient_evidence",
      nextSmallestEvidence: "prove candidate candidate-a: license evidence is unknown",
    });
  });

  it("chooses scratch for a perfect candidate whose ownership cost ties scratch", () => {
    const recommendation = engine.evaluateCccPrdOssReuseAdmission(
      applicationEvidence((raw) => {
        raw.candidates[0].baseOwnershipCost = cost({
          initialAdoptionHours: 80,
          annualMaintenanceHours: 20,
          annualSecurityHours: 10,
          evidenceId: "EVIDENCE-CANDIDATE-TIE",
        });
      }),
    );

    expect(recommendation).toMatchObject({
      decision: "scratch_build",
      selectedCandidateId: null,
      reasons: ["no proven application-base candidate safely beats scratch"],
      candidateDiagnostics: [{
        candidateId: "candidate-a",
        eligible: false,
        reasons: ["candidate ownership cost does not beat scratch"],
      }],
    });
  });

  it("selects a bounded partial fork and counts adaptation cost exactly once", () => {
    const recommendation = engine.evaluateCccPrdOssReuseAdmission(
      applicationEvidence((raw) => {
        raw.candidates[0].coveredCapabilities = ["task-api"];
        raw.candidates[0].adaptationPlan = {
          changedAreas: ["task-api"],
          adaptationHours: 20,
          maxTouchedFiles: 10,
        };
        raw.candidates[0].baseOwnershipCost = cost({
          initialAdoptionHours: 20,
          adaptationHours: 20,
          annualMaintenanceHours: 5,
          annualSecurityHours: 2,
          evidenceId: "EVIDENCE-CANDIDATE-PARTIAL",
        });
      }),
    );

    expect(recommendation).toMatchObject({
      decision: "partial_match_fork",
      selectedCandidateId: "candidate-a",
      candidateDiagnostics: [{
        coveragePercent: 50,
        effectiveOwnershipHours: 54,
        eligible: true,
      }],
    });
  });

  it("requires passing positive and negative controls before candidate scoring", () => {
    const recommendation = engine.evaluateCccPrdOssReuseAdmission(
      applicationEvidence((raw) => {
        raw.discovery.negativeControl = "unknown";
      }),
    );

    expect(recommendation).toMatchObject({
      decision: "insufficient_evidence",
      candidateDiagnostics: [],
      nextSmallestEvidence: "pass the positive and negative discovery controls",
    });
  });

  it("prefers a proven close match over a cheaper partial match", () => {
    const recommendation = engine.evaluateCccPrdOssReuseAdmission(
      applicationEvidence((raw) => {
        const partial = structuredClone(raw.candidates[0]);
        partial.id = "candidate-b";
        partial.coveredCapabilities = ["task-api"];
        partial.adaptationPlan = {
          changedAreas: ["task-api"],
          adaptationHours: 5,
          maxTouchedFiles: 5,
        };
        partial.baseOwnershipCost = cost({
          initialAdoptionHours: 5,
          adaptationHours: 5,
          annualMaintenanceHours: 2,
          annualSecurityHours: 1,
          evidenceId: "EVIDENCE-CANDIDATE-B",
        });
        raw.candidates.push(partial);
      }),
    );

    expect(recommendation.decision).toBe("close_match_fork");
    expect(recommendation.selectedCandidateId).toBe("candidate-a");
  });
});
