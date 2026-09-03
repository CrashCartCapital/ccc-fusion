# CCC PRD Open-Source Reuse Admission Design

## Goal

Add a provider-neutral, source-and-test contract that lets CCC-Fusion decide whether a PRD should use a full open-source application as the starting base, select one bounded package, learn from a repository without copying it, or build from scratch. The decision must prefer reuse when reuse is genuinely safer and cheaper to own, while refusing any attempt to replace an established project's application base.

## Success Criteria

- A strict versioned evidence packet carries explicit project facts from which the contract derives `greenfield_standalone`, `existing_project_change`, or `unknown`.
- Broad application-base discovery is eligible only for a greenfield standalone project.
- Existing projects may consider a bounded package or reference-only learning, but never a foreign application base.
- Unknown or failed license, source-provenance, static-safety, reproducibility, or test evidence cannot produce a pilotable code-reuse recommendation.
- A close-match fork is preferred over a partial-match fork only when it passes every hard gate and its bounded total-ownership estimate is lower than the scratch baseline.
- A partial-match fork additionally requires an explicit bounded adaptation plan.
- Candidate ordering and the final recommendation are deterministic and carry exact reasons plus the smallest evidence gap that could change the result.
- Tests prove the three failure probes: established-project application-base refusal, unknown hard-gate refusal, and a good functional match that loses to scratch on ownership cost.

## Ownership Boundary

This work owns only branch `codex/oss-base-admission` and worktree `/Users/ryanpappal/03_CODE/ccc-fusion-worktrees/oss-base-admission/ccc-fusion`. It does not modify the active `agent/r1-qe-runner` worktree, the model-admission worktree, live campaigns, PostgreSQL, provider sessions, approvals, Pueue tasks, OmniRoute, AgentSecrets, runtime processes, or any `wave-3` path.

## Decisions

### 1. Separate project-base reuse from ordinary package selection

The evidence packet declares one `reuseKind`:

- `application_base`: a whole repository may become the starting point of a new standalone project.
- `package_dependency`: one package may perform one named bounded capability without becoming the application lifecycle, controller, or second runtime owner.
- `reference_only`: public source may inform design, but no code-adoption recommendation is granted.

`application_base` with `existing_project_change` is rejected before candidate scoring, while `unknown` project classification produces `insufficient_evidence`. There is no operator-approval escape hatch in this v1 contract; a genuinely new standalone repository must be represented as a separate greenfield PRD.

### 2. Keep discovery transport outside the contract

The new modules consume already-collected evidence. They do not call GitHub, `gh`, a package registry, a network API, an LLM, the filesystem, a database, or a runtime controller. A later adapter may collect evidence from GitHub or another public forge, but it must produce this same provider-neutral packet.

### 3. Validate facts, not popularity

Stars, forks, download counts, and free-form model opinions are not decision inputs. Each candidate instead carries pinned repository identity, license evidence, static-safety evidence, source-provenance evidence, reproducible-build evidence, test evidence, required-capability coverage, architecture-conflict flags, a bounded ownership-cost estimate, and an optional adaptation plan.

### 4. Use hard gates before ranking

Code reuse requires `offline_proven` plus `pass` for license compatibility, source provenance, static safety, reproducible bootstrap, and the candidate test suite. Any `unknown`, merely `declared`, or `fail` value disqualifies that candidate from code reuse. Reference-only learning requires inspectable pinned source but does not claim that the code is safe to execute or legally reusable.

### 5. Compare reuse against an honest scratch baseline

Candidate and scratch costs use bounded integer-hour components with either `bounded_estimate` or `pilot_measured` confidence, non-empty evidence IDs, and a verified receipt digest. The total is recomputed as `initialAdoptionHours + adaptationHours + horizonYears * (annualMaintenanceHours + annualSecurityHours)`; producers cannot supply an uncheckable total. For a partial fork, `adaptationPlan.adaptationHours` must equal the cost receipt's adaptation component, so adaptation is counted exactly once. Scratch has zero adaptation hours. Unknown costs produce `insufficient_evidence`, not an invented numerical advantage. A fork or package must be strictly cheaper than scratch; a tie chooses scratch.

### 6. Deterministic recommendation order

The evaluator applies this order:

1. Classify the project from project evidence; reject a foreign application base for an established project and return insufficient evidence for an unknown project.
2. Refuse malformed, incomplete, or unknown controlling evidence.
3. For greenfield application bases, require completed discovery plus a passing positive and negative control.
4. Filter candidates through hard gates and architecture boundaries.
5. Classify survivors as close match, partial match, bounded package, or reference only.
6. Require every code-reuse candidate to beat scratch ownership cost.
7. Rank application bases by close before partial, then lower effective cost, higher coverage, lower dead-weight percentage, and lexical candidate ID. Rank packages by lower cost, higher coverage, lower dead-weight percentage, and lexical candidate ID. Reference-only evidence is returned in lexical candidate-ID order; cost and functional scoring are not inputs because no code adoption is authorized.
8. Choose scratch when evidence is complete but no code-reuse candidate qualifies.

When several evidence gaps exist, `nextSmallestEvidence` uses this fixed precedence: forbidden project/reuse combination, discovery status, controls, candidate hard gates in the order license -> source provenance -> static safety -> reproducible bootstrap -> tests, architecture conflicts, ownership cost, then adaptation-plan bounds. Candidate-scoped gaps are ordered by lexical candidate ID.

## Evidence Schema

The parser accepts exactly this logical shape; every named object rejects unknown or missing keys unless the field is explicitly nullable.

```ts
type CccPrdOssEvidenceState = "unknown" | "declared" | "offline_proven";
type CccPrdOssEvidenceOutcome = "unknown" | "pass" | "fail";
type CccPrdOssProjectMode = "greenfield_standalone" | "existing_project_change" | "unknown";
type CccPrdOssReuseKind = "application_base" | "package_dependency" | "reference_only";
type CccPrdOssCostConfidence = "unknown" | "bounded_estimate" | "pilot_measured";

type CccPrdOssGateEvidence = Readonly<{
  state: CccPrdOssEvidenceState;
  outcome: CccPrdOssEvidenceOutcome;
}>;

type CccPrdOssReuseCostEstimate = Readonly<{
  initialAdoptionHours: number;
  adaptationHours: number;
  annualMaintenanceHours: number;
  annualSecurityHours: number;
  horizonYears: number;
  totalOwnershipHours: number;
  confidence: CccPrdOssCostConfidence;
  evidenceIds: readonly string[];
  receiptSha256: string;
}>;

type CccPrdOssAdaptationPlan = Readonly<{
  changedAreas: readonly string[];
  adaptationHours: number;
  maxTouchedFiles: number;
}>;

type CccPrdOssReuseCandidateEvidence = Readonly<{
  kind: "application_base" | "package_dependency";
  id: string;
  repository: Readonly<{
    repositoryId: string;
    revision: string;
    treeSha256: string;
  }>;
  licenseExpression: string;
  gates: Readonly<{
    license: CccPrdOssGateEvidence;
    sourceProvenance: CccPrdOssGateEvidence;
    staticSafety: CccPrdOssGateEvidence;
    reproducibleBootstrap: CccPrdOssGateEvidence;
    tests: CccPrdOssGateEvidence;
  }>;
  coveredCapabilities: readonly string[];
  architecture: Readonly<{
    introducesApplicationLifecycleOwner: boolean;
    introducesSecondaryRuntimeOwner: boolean;
  }>;
  deadWeightPercent: number;
  baseOwnershipCost: CccPrdOssReuseCostEstimate;
  adaptationPlan: CccPrdOssAdaptationPlan | null;
}>;

type CccPrdOssReferenceEvidence = Readonly<{
  kind: "reference_only";
  id: string;
  repository: Readonly<{
    repositoryId: string;
    revision: string;
    treeSha256: string;
  }>;
  sourceProvenance: CccPrdOssGateEvidence;
  claims: readonly string[];
}>;

type CccPrdOssReuseEvidence = Readonly<{
  schema: "ccc-prd.oss-reuse-evidence.v1";
  project: Readonly<{
    repositoryId: string;
    gitState: "initialized" | "not_initialized" | "unknown";
    fusionMarker: "absent" | "present" | "malformed" | "unknown";
    applicationState: "absent" | "present" | "unknown";
    snapshotSha256: string;
  }>;
  reuseKind: CccPrdOssReuseKind;
  boundedCapability: string | null;
  requiredCapabilities: readonly string[];
  criticalCapabilities: readonly string[];
  discovery: Readonly<{
    status: "not_applicable" | "completed" | "failed";
    candidatesConsidered: number;
    positiveControl: "pass" | "fail" | "unknown";
    negativeControl: "pass" | "fail" | "unknown";
  }>;
  scratchCost: CccPrdOssReuseCostEstimate | null;
  candidates: readonly (CccPrdOssReuseCandidateEvidence | CccPrdOssReferenceEvidence)[];
}>;

type CccPrdOssReuseDecisionKind =
  | "close_match_fork"
  | "partial_match_fork"
  | "scratch_build"
  | "rejected"
  | "insufficient_evidence";

type CccPrdOssCandidateDiagnostic = Readonly<{
  candidateId: string;
  eligible: boolean;
  coveragePercent: number;
  effectiveOwnershipHours: number | null;
  reasons: readonly string[];
}>;

type CccPrdOssReuseRecommendation = Readonly<{
  decision: CccPrdOssReuseDecisionKind;
  evidenceSha256: string;
  selectedCandidateId: string | null;
  reasons: readonly string[];
  candidateDiagnostics: readonly CccPrdOssCandidateDiagnostic[];
  nextSmallestEvidence: string | null;
}>;

type CccPrdOssPackageSelection = Readonly<{
  decision: "package_selected" | "scratch_build" | "rejected" | "insufficient_evidence";
  evidenceSha256: string;
  selectedCandidateId: string | null;
  reasons: readonly string[];
  candidateDiagnostics: readonly CccPrdOssCandidateDiagnostic[];
  nextSmallestEvidence: string | null;
}>;

type CccPrdOssReferenceLearning = Readonly<{
  decision: "reference_recorded" | "rejected" | "insufficient_evidence";
  evidenceSha256: string;
  referenceCandidateIds: readonly string[];
  reasons: readonly string[];
  nextSmallestEvidence: string | null;
}>;
```

The parser enforces these relationships: for code-reuse packets, required capabilities are non-empty, critical capabilities are a subset of them, and candidate coverage is also a subset; candidate and evidence IDs are unique; set-like arrays are duplicate-free and canonicalized; percentages are integers from 0 through 100; hours, years, and file counts are non-negative safe integers; cost totals and receipt digests are recomputed and verified; every candidate and the scratch receipt use the same `horizonYears`; `unknown` cost confidence requires zero components and no evidence IDs while usable confidence requires evidence IDs; `unknown` gate state pairs only with `unknown` outcome; and code reuse requires controlling gates to reach `offline_proven/pass` during evaluation. A package packet has exactly one required capability, that same critical capability, a matching top-level `boundedCapability`, and only package candidates. Application-base and reference packets require `boundedCapability: null`. Reference packets have empty required/critical capability arrays, `scratchCost: null`, and only reference candidates; their claims are non-empty and their source provenance must be `offline_proven/pass` before a learning record is returned. They cannot carry executable-admission fields. Canonical packet size is capped at 1 MiB.

`classifyCccPrdOssReuseProject` returns `existing_project_change` when the Fusion marker is `present` or `malformed`, or application state is `present`; it returns `unknown` when any remaining classification fact is unknown; otherwise it returns `greenfield_standalone`. The function consumes evidence only and performs no filesystem access.

For greenfield application-base discovery, both controls must be `pass`. `unknown`, `fail`, a non-completed discovery status, or zero considered candidates returns `insufficient_evidence`; it does not throw because the packet is structurally valid but the discovery method has not earned a selection. Established-project application-base requests still return terminal `rejected` before this check.

Candidate handling distinguishes uncertainty from a known negative. If no candidate qualifies and at least one otherwise relevant candidate has an unknown controlling gate or cost, the result is `insufficient_evidence`. If evidence is complete and every candidate is known to fail a gate, fit threshold, architecture boundary, or scratch-cost comparison, the application/package result is `scratch_build` with per-candidate rejection diagnostics. A known failed candidate does not prevent a different fully proven candidate from being selected.

## Public Interfaces

### Core contract

File: `packages/core/src/ccc-prd/oss-reuse-contract.ts`

- `CCC_PRD_OSS_REUSE_EVIDENCE_SCHEMA_VERSION`
- `CCC_PRD_OSS_REUSE_POLICY_V1`
- `CccPrdOssReuseEvidence`
- `CccPrdOssReuseCandidateEvidence`
- `CccPrdOssReuseCostEstimate`
- `CccPrdOssReuseContractError`
- `parseCccPrdOssReuseEvidence(value)`
- `canonicalizeCccPrdOssReuseEvidence(evidence)`
- `computeCccPrdOssReuseEvidenceSha256(evidence)`
- `classifyCccPrdOssReuseProject(project)`

The parser accepts exact keys only, validates set relationships and numeric bounds, sorts semantic sets deterministically, and returns a deeply frozen value.

### Engine evaluator

File: `packages/engine/src/ccc-prd/oss-reuse-admission.ts`

- `CCC_PRD_OSS_REUSE_EVALUATOR_VERSION`
- `CccPrdOssReuseRecommendation`
- `CccPrdOssPackageSelection`
- `CccPrdOssReferenceLearning`
- `evaluateCccPrdOssReuseAdmission(evidence)`
- `selectCccPrdOssPackage(evidence)`
- `recordCccPrdOssReferenceLearning(evidence)`

All three functions are synchronous and pure. The application-base evaluator returns only `close_match_fork`, `partial_match_fork`, `scratch_build`, `rejected`, or `insufficient_evidence`. Package selection returns `package_selected`, `scratch_build`, `rejected`, or `insufficient_evidence`. Reference learning returns `reference_recorded`, `rejected`, or `insufficient_evidence`; passing reference evidence to either code-reuse function produces `insufficient_evidence`. Every result carries the evidence digest, selected candidate ID when applicable, ordered reasons, diagnostics, and `nextSmallestEvidence`.

## Default V1 Policy

- Close match: at least 80% of required capabilities covered, every critical capability covered, no application-lifecycle or second-runtime conflict, zero adaptation hours, and no adaptation plan.
- Partial match: at least 40% of required capabilities covered, every critical capability covered, no architecture conflict, and an adaptation plan capped at 50 touched files and included in total ownership cost.
- Package dependency: matches the one declared bounded capability and introduces neither a new application lifecycle owner nor a second runtime owner.
- Code reuse: candidate total ownership cost must be strictly below scratch.
- Unknown controlling evidence always fails closed.

These values are explicit policy constants rather than hidden heuristics. A later schema version may replace them without changing v1 evidence interpretation.

## Error Handling

Malformed input throws `CccPrdOssReuseContractError` with code `CCC_PRD_OSS_REUSE_EVIDENCE_INVALID` and the exact failing JSON path. Valid but incomplete evidence, including failed discovery controls, returns `insufficient_evidence`. A complete evaluation that finds no safe economic reuse candidate returns `scratch_build`; this is a safe recommendation, not an error.

## Non-Goals

- No live GitHub or package-registry search.
- No third-party clone, fork, install, build, test, container, or network execution.
- No license allowlist or legal exception workflow; the packet records the already-adjudicated compatibility result.
- No PRD importer, database, dashboard, controller, provider, workflow-node, or campaign-runtime wiring.
- No controller-forced action, automatic fork creation, push, pull request, merge, or publication.
- No changes to the existing custom-provider or model-admission paths.

## Pressure Test

The nearest alternative was a single core module containing both the contract and evaluator. It was rejected because evidence integrity is a shared domain concern while recommendation policy belongs with the engine's planning logic. The largest risks are fabricated cost estimates, a package smuggling in a second application framework, and a partial fork becoming an unbounded rewrite; recomputable cost receipts, explicit architecture flags, and the bounded adaptation plan address those risks. The design deliberately leaves evidence collection unwired so an untrusted repository cannot become executable merely because it appeared in search results.
