# CCC PRD Open-Source Reuse Admission

CCC-Fusion now has a pure source-and-test contract for deciding how open-source software may inform a PRD before implementation planning. The contract does not search GitHub, clone repositories, install packages, execute third-party code, create forks, or change a live campaign. It validates evidence that another bounded discovery process has already collected and returns a deterministic planning recommendation.

## The Policy In Plain Language

A whole open-source application may be considered as the starting base only for a genuinely new standalone project. If Fusion markers, an existing application, or unknown project facts are present, a foreign application base is rejected or held for more evidence before any candidate is scored.

An established project may still select one package for one named capability. That package cannot become the application's lifecycle owner or introduce a second runtime owner. Public repositories may also be recorded as reference-only learning, but reference evidence never becomes permission to copy, execute, or adopt the code.

Reuse does not win merely because a repository exists or is popular. A code-reuse candidate must have offline-proven license compatibility, pinned source provenance, static-safety review, reproducible bootstrap evidence, passing tests, required functional coverage, no architecture conflict, and a bounded ownership-cost receipt that is strictly cheaper than building the same capability from scratch. A cost tie chooses scratch.

## Public Contract

`@fusion/core` exports:

- `CCC_PRD_OSS_REUSE_EVIDENCE_SCHEMA_VERSION`
- `CCC_PRD_OSS_REUSE_POLICY_V1`
- `parseCccPrdOssReuseEvidence`
- `canonicalizeCccPrdOssReuseEvidence`
- `computeCccPrdOssReuseEvidenceSha256`
- `classifyCccPrdOssReuseProject`
- the associated immutable evidence, candidate, gate, cost, and error types

The parser accepts exact keys, canonicalizes set-like arrays, rejects duplicate identities and invalid relationships, verifies SHA-256 cost receipts, recomputes ownership totals, enforces a shared comparison horizon, limits the canonical packet to 1 MiB, and deeply freezes the normalized result. Structural failures throw `CccPrdOssReuseContractError` with `CCC_PRD_OSS_REUSE_EVIDENCE_INVALID` and the failing JSON path.

Call the core parser before evaluation. `@fusion/engine` accepts the parser's validated, normalized evidence type rather than arbitrary runtime JSON and exports three separate pure decisions:

- `evaluateCccPrdOssReuseAdmission` for full application bases, returning `close_match_fork`, `partial_match_fork`, `scratch_build`, `rejected`, or `insufficient_evidence`.
- `selectCccPrdOssPackage` for one bounded package, returning `package_selected`, `scratch_build`, `rejected`, or `insufficient_evidence`.
- `recordCccPrdOssReferenceLearning` for pinned reference-only material, returning `reference_recorded`, `rejected`, or `insufficient_evidence`.

Every result includes the canonical evidence digest, ordered reasons, the selected candidate when applicable, and the next smallest evidence item that could change an incomplete result.

## Project Classification

The caller supplies a digest-bound project snapshot with Git state, Fusion marker state, and application state. The classifier returns:

- `existing_project_change` when a Fusion marker is present or malformed, or an application is present;
- `unknown` when a remaining classification fact is unknown;
- `greenfield_standalone` only when no existing-project signal is present and the facts are known.

The classifier consumes data only. It does not inspect the filesystem, repository, database, or runtime itself.

## Candidate Gates

Application-base and package candidates carry five controlling gates: license, source provenance, static safety, reproducible bootstrap, and tests. Code reuse requires every gate to be exactly `offline_proven` and `pass`. A known failure disqualifies that candidate; an unresolved controlling fact keeps the overall result at `insufficient_evidence` when no fully proven candidate is available.

Greenfield application-base evaluation also requires completed discovery, at least one considered candidate, and passing positive and negative discovery controls. These controls prove that the discovery process can recognize an intentionally acceptable example and reject an intentionally unacceptable example; HTTP success, search narration, or repository popularity does not substitute for them.

## Fit And Ownership Cost

V1 calls a candidate a close match when it covers at least 80 percent of required capabilities, covers every critical capability, has no adaptation plan or adaptation hours, and has no application-lifecycle or second-runtime conflict. A partial match covers at least 40 percent and every critical capability, stays within a plan capped at 50 touched files, and binds its adaptation hours to the verified ownership-cost receipt.

Cost receipts contain initial adoption, adaptation, yearly maintenance, yearly security work, comparison horizon, recomputed total, confidence, evidence IDs, and a SHA-256 receipt. Candidate and scratch receipts must use the same horizon. A usable candidate must be strictly cheaper than scratch after all components; equal or higher cost returns `scratch_build`.

## What This Does Not Prove

This is not installed or runtime-loaded behavior. It has not searched GitHub, selected a real repository, performed a legal review, scanned or executed third-party source, run a sandbox pilot, created a fork, modified a PRD import, or affected a live campaign. Later work may add provider-neutral discovery adapters and disposable sandbox pilots, but those adapters must preserve this contract and receive their own safety, permission, and verification review.
