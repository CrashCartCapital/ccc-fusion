import {
  CCC_PRD_OSS_REUSE_POLICY_V1,
  classifyCccPrdOssReuseProject,
  compareCccPrdCodeUnits,
  computeCccPrdOssReuseEvidenceSha256,
  type CccPrdOssReuseCandidateEvidence,
  type CccPrdOssReuseEvidence,
} from "@fusion/core";

export const CCC_PRD_OSS_REUSE_EVALUATOR_VERSION =
  "ccc-prd.oss-reuse-evaluator.v1" as const;

export type CccPrdOssCandidateDiagnostic = Readonly<{
  candidateId: string;
  eligible: boolean;
  coveragePercent: number;
  effectiveOwnershipHours: number | null;
  reasons: readonly string[];
}>;

export type CccPrdOssReuseDecisionKind =
  | "close_match_fork"
  | "partial_match_fork"
  | "scratch_build"
  | "rejected"
  | "insufficient_evidence";

export type CccPrdOssReuseRecommendation = Readonly<{
  decision: CccPrdOssReuseDecisionKind;
  evaluatorVersion: typeof CCC_PRD_OSS_REUSE_EVALUATOR_VERSION;
  evidenceSha256: string;
  selectedCandidateId: string | null;
  reasons: readonly string[];
  candidateDiagnostics: readonly CccPrdOssCandidateDiagnostic[];
  nextSmallestEvidence: string | null;
}>;

export type CccPrdOssPackageSelection = Readonly<{
  decision: "package_selected" | "scratch_build" | "rejected" | "insufficient_evidence";
  evaluatorVersion: typeof CCC_PRD_OSS_REUSE_EVALUATOR_VERSION;
  evidenceSha256: string;
  selectedCandidateId: string | null;
  reasons: readonly string[];
  candidateDiagnostics: readonly CccPrdOssCandidateDiagnostic[];
  nextSmallestEvidence: string | null;
}>;

export type CccPrdOssReferenceLearning = Readonly<{
  decision: "reference_recorded" | "rejected" | "insufficient_evidence";
  evaluatorVersion: typeof CCC_PRD_OSS_REUSE_EVALUATOR_VERSION;
  evidenceSha256: string;
  referenceCandidateIds: readonly string[];
  reasons: readonly string[];
  nextSmallestEvidence: string | null;
}>;

type EvaluatedCandidate = {
  candidate: CccPrdOssReuseCandidateEvidence;
  class: "close" | "partial" | null;
  diagnostic: CccPrdOssCandidateDiagnostic;
  unknownEvidence: boolean;
};

const GATE_ORDER = [
  "license",
  "sourceProvenance",
  "staticSafety",
  "reproducibleBootstrap",
  "tests",
] as const;

function applicationResult(
  evidenceSha256: string,
  input: Omit<CccPrdOssReuseRecommendation, "evaluatorVersion" | "evidenceSha256">,
): CccPrdOssReuseRecommendation {
  return {
    evaluatorVersion: CCC_PRD_OSS_REUSE_EVALUATOR_VERSION,
    evidenceSha256,
    ...input,
  };
}

function coveragePercent(
  evidence: CccPrdOssReuseEvidence,
  candidate: CccPrdOssReuseCandidateEvidence,
): number {
  if (evidence.requiredCapabilities.length === 0) return 0;
  return Math.floor(
    (candidate.coveredCapabilities.length * 100) / evidence.requiredCapabilities.length,
  );
}

function evaluateApplicationCandidate(
  evidence: CccPrdOssReuseEvidence,
  candidate: CccPrdOssReuseCandidateEvidence,
): EvaluatedCandidate {
  const reasons: string[] = [];
  let unknownEvidence = false;
  for (const gateName of GATE_ORDER) {
    const gate = candidate.gates[gateName];
    if (gate.state === "unknown" || gate.outcome === "unknown") {
      reasons.push(`${gateName} evidence is unknown`);
      unknownEvidence = true;
    } else if (gate.state !== "offline_proven") {
      reasons.push(`${gateName} evidence is not offline proven`);
      unknownEvidence = true;
    } else if (gate.outcome !== "pass") {
      reasons.push(`${gateName} gate failed`);
    }
  }
  if (candidate.baseOwnershipCost.confidence === "unknown") {
    reasons.push("ownership cost is unknown");
    unknownEvidence = true;
  }
  if (candidate.architecture.introducesApplicationLifecycleOwner) {
    reasons.push("candidate conflicts with the target application lifecycle");
  }
  if (candidate.architecture.introducesSecondaryRuntimeOwner) {
    reasons.push("candidate introduces a second runtime owner");
  }
  const coverage = coveragePercent(evidence, candidate);
  const coversCritical = evidence.criticalCapabilities.every((capability) =>
    candidate.coveredCapabilities.includes(capability));
  if (!coversCritical) reasons.push("candidate misses a critical capability");

  let candidateClass: EvaluatedCandidate["class"] = null;
  if (reasons.length === 0) {
    if (
      coverage >= CCC_PRD_OSS_REUSE_POLICY_V1.closeMatchMinCoveragePercent
      && candidate.adaptationPlan === null
      && candidate.baseOwnershipCost.adaptationHours === 0
    ) {
      candidateClass = "close";
    } else if (
      coverage >= CCC_PRD_OSS_REUSE_POLICY_V1.partialMatchMinCoveragePercent
      && candidate.adaptationPlan !== null
      && candidate.adaptationPlan.adaptationHours > 0
      && candidate.adaptationPlan.adaptationHours === candidate.baseOwnershipCost.adaptationHours
      && candidate.adaptationPlan.maxTouchedFiles > 0
      && candidate.adaptationPlan.maxTouchedFiles <= CCC_PRD_OSS_REUSE_POLICY_V1.maxPartialTouchedFiles
    ) {
      candidateClass = "partial";
    } else if (candidate.adaptationPlan !== null) {
      reasons.push("adaptation plan is missing or outside v1 bounds");
    } else {
      reasons.push("candidate does not meet the close or partial fit threshold");
    }
  }
  const scratchHours = evidence.scratchCost?.totalOwnershipHours;
  if (
    candidateClass
    && scratchHours !== undefined
    && candidate.baseOwnershipCost.totalOwnershipHours >= scratchHours
  ) {
    candidateClass = null;
    reasons.push("candidate ownership cost does not beat scratch");
  }
  return {
    candidate,
    class: candidateClass,
    unknownEvidence,
    diagnostic: {
      candidateId: candidate.id,
      eligible: candidateClass !== null,
      coveragePercent: coverage,
      effectiveOwnershipHours: candidate.baseOwnershipCost.confidence === "unknown"
        ? null
        : candidate.baseOwnershipCost.totalOwnershipHours,
      reasons,
    },
  };
}

function compareApplicationCandidates(left: EvaluatedCandidate, right: EvaluatedCandidate): number {
  const classOrder = { close: 0, partial: 1 } as const;
  const leftClass = left.class ?? "partial";
  const rightClass = right.class ?? "partial";
  const classDifference = classOrder[leftClass] - classOrder[rightClass];
  if (classDifference !== 0) return classDifference;
  const costDifference = left.candidate.baseOwnershipCost.totalOwnershipHours
    - right.candidate.baseOwnershipCost.totalOwnershipHours;
  if (costDifference !== 0) return costDifference;
  const coverageDifference = right.diagnostic.coveragePercent - left.diagnostic.coveragePercent;
  if (coverageDifference !== 0) return coverageDifference;
  const deadWeightDifference = left.candidate.deadWeightPercent - right.candidate.deadWeightPercent;
  if (deadWeightDifference !== 0) return deadWeightDifference;
  return compareCccPrdCodeUnits(left.candidate.id, right.candidate.id);
}

export function evaluateCccPrdOssReuseAdmission(
  evidence: CccPrdOssReuseEvidence,
): CccPrdOssReuseRecommendation {
  const evidenceSha256 = computeCccPrdOssReuseEvidenceSha256(evidence);
  if (evidence.reuseKind !== "application_base") {
    return applicationResult(evidenceSha256, {
      decision: "insufficient_evidence",
      selectedCandidateId: null,
      reasons: ["application-base evaluator requires application_base evidence"],
      candidateDiagnostics: [],
      nextSmallestEvidence: "use the package or reference-only evaluation surface",
    });
  }
  const projectMode = classifyCccPrdOssReuseProject(evidence.project);
  if (projectMode === "existing_project_change") {
    return applicationResult(evidenceSha256, {
        decision: "rejected",
        selectedCandidateId: null,
        reasons: ["foreign application bases are forbidden for established projects"],
        candidateDiagnostics: [],
        nextSmallestEvidence: null,
    });
  }
  if (projectMode === "unknown") {
    return applicationResult(evidenceSha256, {
        decision: "insufficient_evidence",
        selectedCandidateId: null,
        reasons: ["project classification is unknown"],
        candidateDiagnostics: [],
        nextSmallestEvidence: "prove project git, Fusion marker, and application state",
    });
  }
  if (evidence.discovery.status !== "completed" || evidence.discovery.candidatesConsidered === 0) {
    return applicationResult(evidenceSha256, {
      decision: "insufficient_evidence",
      selectedCandidateId: null,
      reasons: ["application-base discovery is incomplete"],
      candidateDiagnostics: [],
      nextSmallestEvidence: "complete repository discovery and record considered candidates",
    });
  }
  if (evidence.discovery.positiveControl !== "pass" || evidence.discovery.negativeControl !== "pass") {
    return applicationResult(evidenceSha256, {
      decision: "insufficient_evidence",
      selectedCandidateId: null,
      reasons: ["application-base discovery controls did not both pass"],
      candidateDiagnostics: [],
      nextSmallestEvidence: "pass the positive and negative discovery controls",
    });
  }
  if (!evidence.scratchCost || evidence.scratchCost.confidence === "unknown") {
    return applicationResult(evidenceSha256, {
      decision: "insufficient_evidence",
      selectedCandidateId: null,
      reasons: ["scratch ownership cost is unknown"],
      candidateDiagnostics: [],
      nextSmallestEvidence: "provide a bounded scratch ownership-cost receipt",
    });
  }
  const evaluated = evidence.candidates
    .filter((candidate): candidate is CccPrdOssReuseCandidateEvidence => candidate.kind === "application_base")
    .map((candidate) => evaluateApplicationCandidate(evidence, candidate));
  const diagnostics = evaluated.map(({ diagnostic }) => diagnostic);
  const eligible = evaluated.filter((candidate) => candidate.class !== null).sort(compareApplicationCandidates);
  const selected = eligible[0];
  if (selected) {
    const decision = selected.class === "close" ? "close_match_fork" : "partial_match_fork";
    const label = selected.class === "close" ? "proven close match" : "bounded partial match";
    return applicationResult(evidenceSha256, {
      decision,
      selectedCandidateId: selected.candidate.id,
      reasons: [`candidate ${selected.candidate.id} is a ${label} and cheaper than scratch`],
      candidateDiagnostics: diagnostics,
      nextSmallestEvidence: null,
    });
  }
  const uncertain = evaluated
    .filter(({ unknownEvidence }) => unknownEvidence)
    .sort((left, right) => compareCccPrdCodeUnits(left.candidate.id, right.candidate.id))[0];
  if (uncertain) {
    const firstReason = uncertain.diagnostic.reasons[0] ?? "controlling evidence is unknown";
    return applicationResult(evidenceSha256, {
      decision: "insufficient_evidence",
      selectedCandidateId: null,
      reasons: [`candidate ${uncertain.candidate.id} has unresolved controlling evidence`],
      candidateDiagnostics: diagnostics,
      nextSmallestEvidence: `prove candidate ${uncertain.candidate.id}: ${firstReason}`,
    });
  }
  return applicationResult(evidenceSha256, {
    decision: "scratch_build",
    selectedCandidateId: null,
    reasons: ["no proven application-base candidate safely beats scratch"],
    candidateDiagnostics: diagnostics,
    nextSmallestEvidence: null,
  });
}

export function selectCccPrdOssPackage(
  evidence: CccPrdOssReuseEvidence,
): CccPrdOssPackageSelection {
  const evidenceSha256 = computeCccPrdOssReuseEvidenceSha256(evidence);
  const result = (
    input: Omit<CccPrdOssPackageSelection, "evaluatorVersion" | "evidenceSha256">,
  ): CccPrdOssPackageSelection => ({
    evaluatorVersion: CCC_PRD_OSS_REUSE_EVALUATOR_VERSION,
    evidenceSha256,
    ...input,
  });
  if (evidence.reuseKind !== "package_dependency") {
    return result({
      decision: "insufficient_evidence",
      selectedCandidateId: null,
      reasons: ["package selector requires package_dependency evidence"],
      candidateDiagnostics: [],
      nextSmallestEvidence: "use the evaluator matching the evidence reuse kind",
    });
  }
  if (evidence.discovery.status !== "completed" || evidence.discovery.candidatesConsidered === 0) {
    return result({
      decision: "insufficient_evidence",
      selectedCandidateId: null,
      reasons: ["package discovery is incomplete"],
      candidateDiagnostics: [],
      nextSmallestEvidence: "complete bounded package discovery",
    });
  }
  if (!evidence.scratchCost || evidence.scratchCost.confidence === "unknown") {
    return result({
      decision: "insufficient_evidence",
      selectedCandidateId: null,
      reasons: ["scratch ownership cost is unknown"],
      candidateDiagnostics: [],
      nextSmallestEvidence: "provide a bounded scratch ownership-cost receipt",
    });
  }
  const evaluated = evidence.candidates
    .filter((candidate): candidate is CccPrdOssReuseCandidateEvidence => candidate.kind === "package_dependency")
    .map((candidate) => {
      const reasons: string[] = [];
      let unknownEvidence = false;
      for (const gateName of GATE_ORDER) {
        const gate = candidate.gates[gateName];
        if (gate.state === "unknown" || gate.outcome === "unknown") {
          reasons.push(`${gateName} evidence is unknown`);
          unknownEvidence = true;
        } else if (gate.state !== "offline_proven") {
          reasons.push(`${gateName} evidence is not offline proven`);
          unknownEvidence = true;
        } else if (gate.outcome !== "pass") {
          reasons.push(`${gateName} gate failed`);
        }
      }
      if (candidate.baseOwnershipCost.confidence === "unknown") {
        reasons.push("ownership cost is unknown");
        unknownEvidence = true;
      }
      if (candidate.architecture.introducesApplicationLifecycleOwner) {
        reasons.push("package attempts to own the application lifecycle");
      }
      if (candidate.architecture.introducesSecondaryRuntimeOwner) {
        reasons.push("package attempts to introduce a second runtime owner");
      }
      if (!evidence.boundedCapability || !candidate.coveredCapabilities.includes(evidence.boundedCapability)) {
        reasons.push("package does not cover the bounded capability");
      }
      if (candidate.adaptationPlan !== null || candidate.baseOwnershipCost.adaptationHours !== 0) {
        reasons.push("package selection cannot carry an application-base adaptation plan");
      }
      if (candidate.baseOwnershipCost.totalOwnershipHours >= evidence.scratchCost!.totalOwnershipHours) {
        reasons.push("package ownership cost does not beat scratch");
      }
      return {
        candidate,
        unknownEvidence,
        architectureConflict: candidate.architecture.introducesApplicationLifecycleOwner
          || candidate.architecture.introducesSecondaryRuntimeOwner,
        diagnostic: {
          candidateId: candidate.id,
          eligible: reasons.length === 0,
          coveragePercent: coveragePercent(evidence, candidate),
          effectiveOwnershipHours: candidate.baseOwnershipCost.confidence === "unknown"
            ? null
            : candidate.baseOwnershipCost.totalOwnershipHours,
          reasons,
        } satisfies CccPrdOssCandidateDiagnostic,
      };
    });
  const diagnostics = evaluated.map(({ diagnostic }) => diagnostic);
  const eligible = evaluated.filter(({ diagnostic }) => diagnostic.eligible).sort((left, right) => {
    const costDifference = left.candidate.baseOwnershipCost.totalOwnershipHours
      - right.candidate.baseOwnershipCost.totalOwnershipHours;
    if (costDifference !== 0) return costDifference;
    const coverageDifference = right.diagnostic.coveragePercent - left.diagnostic.coveragePercent;
    if (coverageDifference !== 0) return coverageDifference;
    const deadWeightDifference = left.candidate.deadWeightPercent - right.candidate.deadWeightPercent;
    if (deadWeightDifference !== 0) return deadWeightDifference;
    return compareCccPrdCodeUnits(left.candidate.id, right.candidate.id);
  });
  const selected = eligible[0];
  if (selected) {
    return result({
      decision: "package_selected",
      selectedCandidateId: selected.candidate.id,
      reasons: [`candidate ${selected.candidate.id} provides the bounded capability and is cheaper than scratch`],
      candidateDiagnostics: diagnostics,
      nextSmallestEvidence: null,
    });
  }
  const uncertain = evaluated
    .filter(({ unknownEvidence }) => unknownEvidence)
    .sort((left, right) => compareCccPrdCodeUnits(left.candidate.id, right.candidate.id))[0];
  if (uncertain) {
    return result({
      decision: "insufficient_evidence",
      selectedCandidateId: null,
      reasons: [`candidate ${uncertain.candidate.id} has unresolved controlling evidence`],
      candidateDiagnostics: diagnostics,
      nextSmallestEvidence: `prove candidate ${uncertain.candidate.id}: ${uncertain.diagnostic.reasons[0]}`,
    });
  }
  if (evaluated.some(({ architectureConflict }) => architectureConflict)) {
    return result({
      decision: "rejected",
      selectedCandidateId: null,
      reasons: ["package candidates cannot replace the application lifecycle or runtime owner"],
      candidateDiagnostics: diagnostics,
      nextSmallestEvidence: null,
    });
  }
  return result({
    decision: "scratch_build",
    selectedCandidateId: null,
    reasons: ["no proven bounded package safely beats scratch"],
    candidateDiagnostics: diagnostics,
    nextSmallestEvidence: null,
  });
}

export function recordCccPrdOssReferenceLearning(
  evidence: CccPrdOssReuseEvidence,
): CccPrdOssReferenceLearning {
  const evidenceSha256 = computeCccPrdOssReuseEvidenceSha256(evidence);
  const result = (
    input: Omit<CccPrdOssReferenceLearning, "evaluatorVersion" | "evidenceSha256">,
  ): CccPrdOssReferenceLearning => ({
    evaluatorVersion: CCC_PRD_OSS_REUSE_EVALUATOR_VERSION,
    evidenceSha256,
    ...input,
  });
  if (evidence.reuseKind !== "reference_only") {
    return result({
      decision: "insufficient_evidence",
      referenceCandidateIds: [],
      reasons: ["reference-learning recorder requires reference_only evidence"],
      nextSmallestEvidence: "use the evaluator matching the evidence reuse kind",
    });
  }
  if (evidence.discovery.status !== "completed" || evidence.discovery.candidatesConsidered === 0) {
    return result({
      decision: "insufficient_evidence",
      referenceCandidateIds: [],
      reasons: ["reference discovery is incomplete"],
      nextSmallestEvidence: "complete reference discovery",
    });
  }
  const references = evidence.candidates
    .filter((candidate) => candidate.kind === "reference_only")
    .sort((left, right) => compareCccPrdCodeUnits(left.id, right.id));
  const uncertain = references.find(({ sourceProvenance }) =>
    sourceProvenance.state === "unknown"
    || sourceProvenance.state === "declared"
    || sourceProvenance.outcome === "unknown");
  if (uncertain) {
    return result({
      decision: "insufficient_evidence",
      referenceCandidateIds: [],
      reasons: [`reference ${uncertain.id} source provenance is not offline proven`],
      nextSmallestEvidence: `prove pinned source provenance for reference ${uncertain.id}`,
    });
  }
  const failed = references.find(({ sourceProvenance }) => sourceProvenance.outcome === "fail");
  if (failed) {
    return result({
      decision: "rejected",
      referenceCandidateIds: [],
      reasons: [`reference ${failed.id} failed source provenance validation`],
      nextSmallestEvidence: null,
    });
  }
  return result({
    decision: "reference_recorded",
    referenceCandidateIds: references.map(({ id }) => id),
    reasons: [`recorded ${references.length} pinned reference-only candidates without code-adoption authority`],
    nextSmallestEvidence: null,
  });
}
