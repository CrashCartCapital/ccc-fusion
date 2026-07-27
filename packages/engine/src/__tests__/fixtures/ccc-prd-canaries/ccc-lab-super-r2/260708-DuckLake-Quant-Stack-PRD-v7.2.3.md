---
type: prj
domain: ccc
status: active
date_created: 2026-06-28
date_modified: 2026-07-11
version: 7.2.3
tags:
  - ccc
  - ducklake
  - quant-data
  - prd
  - structural-rewrite
---

# CCC DuckLake Quant Stack PRD v7.2.3

CCC DuckLake Quant Stack PRD v7.2.3 defines a fixture-first, SQL-zero, point-in-time data platform for Ryan's quant research stack. The build contract is split across the module notes below; this root sets the reading path, ownership boundaries, and control surfaces an implementation agent must use before building.

Production posture: Phase 0 is scratch-only and fixture-complete; live provider adapters stay disabled until capability packs and source-availability evidence pass their gates; raw SQL, raw table or Parquet access, broker writes, autonomous execution, and Quant Engine research-policy decisions are out of scope. Core typed `qdb` reads are the current access boundary, `register_derived` and `trading_calendar_bt` open in Phase 1, and the panel/fill/coverage/session interface opens only in Phase 1.5.

## Source Set

- Primary source: `00_MAIN/01_ActiveProjects/ccc-lab-super/prd-v6.5.0/260626-DuckLake-Quant-Stack-PRD-v6.5.0.md`, structurally split into the v7.2.3 root and module notes.
- Integrity posture: parent preflight matched the source line count and SHA-256 before the structural split.

## Implementation Control Surfaces

Build authority for v7.2.3 is this root PRD, the sixteen production `PRJ-AI-*` module notes, and the authoritative proof rows in [[REF-AI-DuckLake-v7.2.3-BlockingTestIndex]]. The independently recomputed final v7.2.3 custody manifest is the first bootstrap gate; no Taskfile, README, mutable index, flag, environment variable, or wrapper can replace it. The supporting ledgers below route ownership, source coverage, and traceability only; they are not implementation authority and do not override module requirements.

- [[REF-AI-DuckLake-v7.2.3-OwnershipMap]]: module ownership, requirement-family ownership, artifact ownership, and proof-surface routing.
- [[REF-AI-DuckLake-v7.2.3-SourceCoverageLedger]]: line-range source map from the primary v6.5.0 PRD into intended v7.2.3 owners.
- [[REF-AI-DuckLake-v7.2.3-WikilinkTranslationMap]]: old major-heading to new owner-note translation map for module links and link repair.
- [[REF-AI-DuckLake-v7.2.3-BlockingTestIndex]]: authoritative flat CSV of every named test with phase and owner module; the generated implementation-index seed must diff clean against it.
- [[REF-AI-DuckLake-v7.2.3-CurrentRowRegistryAddendum]]: complete current-row reconciliation across Kernel, Dataset, qdb, schemas, migrations, examples, and the Blocking Test Index; it is binding only through the owning production modules and their BTI rows.
- [[REF-AI-DuckLake-v7.2.3-ReviewLedger]], [[REF-AI-DuckLake-v7.2.3-ChangeLedger]], and [[REF-AI-DuckLake-v7.2.3-AdjudicationLedger]]: audit, history, and decision-trace records only. Use them to understand why text exists, not to create, remove, or weaken implementation requirements.

## Module Index

| Module note | Primary purpose |
|---|---|
| [[PRJ-AI-CCC-DuckLake-v7.2.3-Executive-Contract-And-Authority]] | Executive intent, scope, authority, Definition of Done, non-goals, and binding precedence. |
| [[PRJ-AI-CCC-DuckLake-v7.2.3-Architecture-Context-And-Bootstrap]] | Architecture context, dependency candidates, repo bootstrap, hardware assumptions, toolchain, and implementation reading path. |
| [[PRJ-AI-CCC-DuckLake-v7.2.3-Physical-Host-Bootstrap-And-Cutover]] | Physical-host identity, autonomous estate reconciliation, deployment and recovery evidence, cutover, and multi-host readiness. |
| [[PRJ-AI-CCC-DuckLake-v7.2.3-Publish-Control-Kernel]] | Kernel-owned state, transitions, records, transactions, locks, idempotency, and publish visibility invariants. |
| [[PRJ-AI-CCC-DuckLake-v7.2.3-PIT-And-Bitemporal-Policy]] | Point-in-time clocks, bitemporal invariants, dataset-specific clock rules, and leakage refusal semantics. |
| [[PRJ-AI-CCC-DuckLake-v7.2.3-Dataset-Contracts-And-Validation]] | Canonical schemas, dataset contract seeds, validation tiers, transform traps, and data-model ownership. |
| [[PRJ-AI-CCC-DuckLake-v7.2.3-Provider-Capability-And-Availability]] | Provider capability packs, source-availability policies, provider gates, and the `synthfix` exception. |
| [[PRJ-AI-CCC-DuckLake-v7.2.3-Manifests-Lineage-And-Fixtures]] | Manifest shape, lineage, reproducibility, fixture records, file inventory, and adversarial fixture seeds. |
| [[PRJ-AI-CCC-DuckLake-v7.2.3-QDB-Agent-Access-And-SQL-Zero]] | Typed `qdb`, SQL-zero access, API projections, agent-safe query boundaries, and API-specific errors. |
| [[PRJ-AI-CCC-DuckLake-v7.2.3-Modeling-Engine-Interface]] | Later-phase modeling-engine interface, derived-artifact mapping, future dataset families, and gated interface tests. |
| [[PRJ-AI-CCC-DuckLake-v7.2.3-Orchestration-And-QDBCTL]] | Dagu, DAG families, qdbctl, CLI surfaces, schedules, trigger surfaces, and execution procedures. |
| [[PRJ-AI-CCC-DuckLake-v7.2.3-Ops-Recovery-Maintenance-Security]] | Restore, cleanup, maintenance, storage safety, security, global observability, logging, and error taxonomy. |
| [[PRJ-AI-CCC-DuckLake-v7.2.3-Verification-Benchmarks-Readiness]] | Phase matrix, benchmark gates, acceptance-test index, verification backlog, readiness checklist, and cross-module proof posture. |
| [[REF-AI-CCC-DuckLake-v7.2.3-Source-Universe-Planning]] | Planning-only source universe, coverage-readiness matrices, vendor economics, and future purchase/source planning. Human-readable companion that explains the v7.2.3 module set without becoming build authority. |
| [[PRJ-AI-CCC-DuckLake-v7.2.3-Committee-Gates-And-HITL]] | Committee/ensemble gate specifications, HITL irreducibility map, and the interim checkpoint-and-surface rule. Advisory triage usable now; gate-clearing authority unratified. |
| [[PRJ-AI-CCC-DuckLake-v7.2.3-Deferred-Decision-Rules]] | Plain rules for every deferred, unresolved, evidence-gated, runtime-bound, or future-scope decision. |
| [[PRJ-AI-CCC-DuckLake-v7.2.3-Deferred-Decision-Registry]] | One master list naming when and how each genuine postponed decision is settled, proven, rejected for now, or reopened. |

Table: Current v7.2.3 module filenames for the deconstructed primary PRD.

## Binding Ownership Rules

- Root/index owns navigation, version routing, source-set pointers, and handoff control; it does not own implementation details that belong in modules.
- Kernel owns state invariants and state transitions.
- Orchestration and Ops own triggers, CLI and DAG surfaces, scheduling, procedures, and operator flows.
- Dataset Contracts owns canonical schemas and validation contracts; `qdb` owns API projections and mappings only.
- Ops owns global observability, logging, recovery, maintenance, security, and the global error taxonomy; `qdb` owns API-specific errors.
- Verification owns phase matrix, benchmark gates, verification backlog, readiness checklist, and the cross-module test index; requirement-specific `test_*` names stay with the module that owns the requirement.
- Physical Host Bootstrap owns host bootstrap, estate disposition, cutover, recovery, and multi-host readiness; Committee owns autonomous receipt issuance and verification; no other module may create a second authority family.
- Source Universe remains a planning `REF-AI` note, not provider-enable authority.
- Deferred Decision Rules own the common lifecycle, evidence, deadline, refusal, proof, and reopening requirements; the Deferred Decision Registry owns the one canonical `DD-*` entry for each genuine postponed decision family.

## Implementation Entry Protocol

1. Verify the final v7.2.3 independent source-custody manifest against raw operands, then start with this root PRD and use the Module Index to identify the owning production module.
2. Read the owning `PRJ-AI-*` module for the normative requirement text, then wire the matching rows from [[REF-AI-DuckLake-v7.2.3-BlockingTestIndex]] into the implementation index.
3. Preserve the fixture-first, SQL-zero, fail-closed, source-availability-gated posture unless the owning production module explicitly changes that requirement.
4. Before acting on any deferred, later, future, unresolved, pending, investigate, not-yet, or evidence-gated statement, read its `DD-*` entry in [[PRJ-AI-CCC-DuckLake-v7.2.3-Deferred-Decision-Registry]] and follow the trigger, deadline, evidence, no-evidence, proof, and reopening rules.
5. Use [[REF-AI-DuckLake-v7.2.3-OwnershipMap]], [[REF-AI-DuckLake-v7.2.3-SourceCoverageLedger]], [[REF-AI-DuckLake-v7.2.3-WikilinkTranslationMap]], [[REF-AI-DuckLake-v7.2.3-ReviewLedger]], [[REF-AI-DuckLake-v7.2.3-ChangeLedger]], and [[REF-AI-DuckLake-v7.2.3-AdjudicationLedger]] only for support, provenance, and traceability; implementation agents do not need ledger writes to satisfy this PRD.

## Autonomous v7.2.3 custody and bootstrap control

The v7.2.1 input custody manifest and the final v7.2.3 authority manifest are separately generated by the independent gate runner from raw Markdown operands in a clean process. Each manifest enumerates relative path, role, SHA-256, source version, plan hash, gate-runner path, and gate-runner SHA-256. The input seal permits only copy-first synthesis; the final seal is required before any implementation bootstrap or README remediation.

The final authority set contains this root, sixteen production modules including [[PRJ-AI-CCC-DuckLake-v7.2.3-Physical-Host-Bootstrap-And-Cutover]], [[PRJ-AI-CCC-DuckLake-v7.2.3-Deferred-Decision-Rules]], and [[PRJ-AI-CCC-DuckLake-v7.2.3-Deferred-Decision-Registry]], plus [[REF-AI-DuckLake-v7.2.3-BlockingTestIndex]] exactly once. A mixed-version filename, frontmatter, H1, wikilink, module-index, ownership row, or manifest role is a refusal. AMD-001 and AMD-043 are implemented here; AMD-002 is implemented by Architecture.

For this v7.2.3 upgrade, legacy copied text that pauses for a human, Committee marker, or manual review is superseded by the deterministic Phase -1 evidence gate and `AER.v1` receipt gate in the owning modules. A missing or unreachable external fact does not become permission: it produces a quarantined target and a scratch-only or fixture-only fallback. Spend, legal acceptance, provider enablement, and unverified remote mutation remain refused rather than converted into an implicit approval.
