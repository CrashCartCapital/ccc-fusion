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
  - executive-contract
  - structural-rewrite
---

# CCC DuckLake v7.2.3 Executive Contract And Authority

This module owns the executive contract for the v7.2.3 structural rewrite of the historical CCC DuckLake Quant Stack PRD v6.5.0 (`prd-v6.5.0/260626-DuckLake-Quant-Stack-PRD-v6.5.0.md`). It preserves the v6.5.0 release authority and implementation boundary without turning source-universe planning rows, architecture summaries, or future module summaries into competing build authority.

## Owns

- Executive intent, implementation boundary, Definition of Done, release qualification terms, autonomous implementation authority, Ryan/scope context, core decision, non-goals, success criteria, and `REQ-AUTH-01`.
- Contract precedence: governing `REQ-*` bullets and explicitly referenced artifact seeds govern over navigation tables, decision summaries, phase summaries, and narrative callouts.
- Release-level refusal posture: fixture-complete means source-gated correctness on scratch and `synthfix`, not live data volume.

## Depends On

- [[260708-DuckLake-Quant-Stack-PRD-v7.2.3]] for v7.2.3 navigation and source-set routing.
- [[PRJ-AI-CCC-DuckLake-v7.2.3-Architecture-Context-And-Bootstrap]] for external dependency candidates, bootstrap context, current decisions, phase map, and build-vs-buy detail.
- [[PRJ-AI-CCC-DuckLake-v7.2.3-Provider-Capability-And-Availability]] for provider capability artifacts, source-availability policies, provider enablement gates, and live-adapter authority.
- [[PRJ-AI-CCC-DuckLake-v7.2.3-Verification-Benchmarks-Readiness]] for the phase matrix, benchmark gates, verification backlog, readiness checklist, and cross-module test index.
- [[PRJ-AI-CCC-DuckLake-v7.2.3-Deferred-Decision-Rules]] and [[PRJ-AI-CCC-DuckLake-v7.2.3-Deferred-Decision-Registry]] for the required decision point, evidence, deadline, refusal, proof, and reopening path for every postponed item.

## Read After

- [[260708-DuckLake-Quant-Stack-PRD-v7.2.3]]

## Non-Authoritative Restatements

- This module may summarize architecture, providers, `qdb`, Dagu, PIT, manifests, ops, and verification only to explain executive scope; the owner modules govern their implementation details.
- [[REF-AI-DuckLake-v7.2.3-OwnershipMap]], [[REF-AI-DuckLake-v7.2.3-SourceCoverageLedger]], [[REF-AI-DuckLake-v7.2.3-WikilinkTranslationMap]], [[REF-AI-DuckLake-v7.2.3-ReviewLedger]], [[REF-AI-DuckLake-v7.2.3-ChangeLedger]], and [[REF-AI-DuckLake-v7.2.3-AdjudicationLedger]] are support/provenance ledgers only; they are not required implementation authority.
- The Source Universe planning note is a planning input and must not enable providers; provider enablement authority belongs to [[PRJ-AI-CCC-DuckLake-v7.2.3-Provider-Capability-And-Availability]].
- External package and version choices are not pins here. Ordinary dependency choice resolution is narrowed by `REQ-AUTH-DEP-01` in [[PRJ-AI-CCC-DuckLake-v7.2.3-Architecture-Context-And-Bootstrap]]; safety-bearing facts still resolve under `REQ-AUTH-01`.

## Executive Intent And Implementation Boundary

The goal is a robust personal quant data lakehouse for CCC research that ingests and publishes market, options, SEC, macro, and later news data into a local-first DuckLake/Parquet store; preserves raw source evidence; enforces point-in-time correctness through dataset contracts and `qdb`; lets notebooks and agents query safely without raw lake access; and provides reproducible Dagu jobs, manifests, validation, backups, benchmarks, and restore drills before the data universe scales.

> [!important] First milestone
> Scratch DuckLake/PostgreSQL coordination, a publish/control kernel, typed `qdb` PIT rejection, Dagu deterministic validated publish, restore to a fresh catalog that recovers files and a known PIT query, and one equity plus one SEC/FRED adversarial PIT fixture. No real vendor history, no options backfill, no retrieval, no ClickHouse. Scale only after this loop is green.

The implementation boundary is strict: the repo must run without the vault as a runtime directory, default tests must refuse production NAS paths and live catalog DSNs, and canonical lake writes must flow only through the controlled publication path. Implementation begins in the repo path owned by the PRD, `/Users/ryanpappal/03_CODE/ccc-lab-super/`, unless Ryan explicitly chooses another name; this is the external implementation code repo, not the vault project folder that shares its name, and the vault is design custody only.

Two v7.1.1 posture facts (unchanged in v7.2.3) frame everything below. Committee gates operate in advisory-triage mode only: they prepare recommendations, summarize evidence, triage open questions, and propose gate packets for Ryan's review, while gate-clearing authority remains unratified and checkpoint-and-surface stays in force ([[PRJ-AI-CCC-DuckLake-v7.2.3-Committee-Gates-And-HITL]] governs). And the fixture/live boundary has an explicit middle lane: docs-derived DISABLED adapter drafts are allowed under `REQ-SRC-DRAFT` — skeletons, mocked HTTP, synthetic fixtures, refusal tests — while live downloads, real credentials, `adapter_enabled: true`, and purchases stay blocked until Ryan buys or supplies evidence ([[PRJ-AI-CCC-DuckLake-v7.2.3-Provider-Capability-And-Availability]] governs).

> [!important] Contract precedence
> The binding contract is the in-place `REQ-*` bullet in each subsystem family plus any artifact seed, listing, fixture, schema, or code block that the `REQ-*` bullet or adjacent subsystem section explicitly references. Index tables, decision and phase tables, implementation summaries, and narrative callouts are navigational restatements; where they differ from a governing `REQ-*` bullet or referenced artifact seed, the `REQ-*` bullet and referenced artifact seed govern.

> [!tip] Reading path for implementation agents
> Read the `REQ-*` families and their referenced artifact seeds, listings, fixtures, schemas, and code blocks as the implementation contract. Read narrative sections for orientation only.

## Definition Of Done

> [!success] Fixture-complete Definition of Done
> A complete first release means a fixture-complete, source-gated quant lakehouse core, not live data volume. Live adapters such as Massive/Polygon, Norgate, DiscountOptionData, SEC, and FRED are not part of the required Definition of Done unless a complete provider capability artifact is supplied for that source. In scope for done: source-adapter interfaces, fixture adapters, the fully enabled synthetic `synthfix` provider, capability gates, refusal behavior, and PIT-safe query semantics, all proven end to end through the kernel on scratch. Out of the required Definition of Done: live data enablement, which stays evidence-gated behind `REQ-SRC-VERIFY`. The first shippable release runs entirely on fixtures; turning any live source on is a later, per-source, evidence-gated step.

The fixture-complete Definition of Done is expressed as Success Criterion 19 plus the boundary-only part of Success Criterion 20: the future modeling-interface contract is named and guarded by leakage and absence tests, but no `REQ-IFACE-*` implementation, importable stub, schema body, or callable API is built in the fixture-complete core. The fixture-complete DoD is proven by `task verify:phase0`; it relaxes no Phase 0 gate. Every fact this PRD marks as a verification item is resolved only through the Autonomous Implementation Authority rule below, never by guessing.

`REQ-DEFER-01`: Every genuine deferred, unresolved, evidence-gated, runtime-bound, or future-scope item MUST map to exactly one `DD-*` entry in [[PRJ-AI-CCC-DuckLake-v7.2.3-Deferred-Decision-Registry]]. The entry MUST name when the decision starts, the gate it cannot pass while unresolved, required and expiring evidence, decision authority, allowed outcomes, the safe no-evidence result, durable record, proof, and predeclared reopening events. Missing or conflicting evidence never approves. Reaching the deadline without trustworthy evidence produces `rejected_for_now` and keeps the affected feature or authority blocked. Backed by `test_every_authoritative_deferral_maps_to_registry_or_reviewed_exclusion` and `test_unresolved_item_becomes_rejected_for_now_at_deadline_gate`.

## Release Qualification Terms (`CL1`)

| Level | Binding qualification |
|---|---|
| Fixture-core ready | `task verify:phase0` is green on scratch with `synthfix` only; live adapters are disabled; non-scratch NAS writes refuse. This release is production-shaped for correctness, restoreability, refusal behavior, and operator diagnosis, while live data remains disabled. |
| Pre-live ready | `task verify:prelive` / `task smoke:nas` is green; restic and `pg_dump` pins are verified; storage probe, redaction scan, cleanup-delete proof, and non-scratch path-approval gates pass. |
| Provider-live ready | A named source passes `task verify:source-adapter-gate` with provider-capability evidence and a verified source-availability policy. |

Table: Release qualification levels. Fixture-complete green proves the machinery, not data trustworthiness; a green fixture gate implies no live-research or trading trust until per-source `REQ-SRC-VERIFY` and pre-live gates pass.

## Autonomous Implementation Authority

This PRD marks many facts as verification items, including DuckLake maintenance function names, Dagu binary source, package pins, vendor formats, timestamp semantics, Polars dtype spellings, SEC/FRED/options timing, and benchmark thresholds. This section states exactly how an autonomous implementing agent may resolve them so resolution is auditable and never silent guessing.

- `REQ-AUTH-01`: Where this PRD marks a fact as a verification item, the implementing agent MAY resolve it only from (1) official vendor/project documentation named by the PRD, (2) live runtime probes executed inside the new repo, or (3) sample/provider artifacts supplied under `provider_capabilities/`, `source_availability_policies/`, or `tests/fixtures/`. Every resolved fact MUST be recorded in `docs/version-pins.md`, `docs/runtime-verification/*.json`, or the relevant provider capability artifact. When a verification item is a version or library choice rather than a vendor-observed fact, the agent resolves it deterministically: it tries the PRD's ordered candidate list in order, picks the first candidate that passes the named probe or compatibility check as of the implementation date, records the exact value in the correct evidence surface, and prefers the lowest compatible version to break a tie, never an open-ended latest stable. For ordinary package dependencies, `REQ-AUTH-DEP-01` narrows that evidence to exact version and hash pins plus an advisory transcript; safety-bearing facts still use complete runtime-verification records with `observed_output_hash`. Unverified facts remain disabled, fixture-only, investigate-status, or record-only; the agent MUST NOT invent a vendor fact, pin a version, freeze a benchmark threshold, or enable a live adapter without one of those three authorities. This pairs with `REQ-BENCH-FREEZE`: a benchmark threshold is recorded on first observation and only a human marks it frozen; the agent never auto-freezes.

> [!important] Runtime-verification artifacts
> Resolution is materialized, not described. `docs/runtime-verification/README.md` documents the lane and `schemas/runtime_verification.schema.json` defines one record per resolved fact with fields `item`, `status`, `source`, `authority_type` (`official_doc | runtime_probe | supplied_artifact`), `command`, `observed_output_hash`, `resolved_value`, `verified_at`, `blocks`, `expires_or_reverify_when`, an optional `output_artifact`, and two optional contingency fields `fallback_status` and `kill_or_pivot`. Each `*.json` under `docs/runtime-verification/` is one validated record; CI validates them against the schema and fails if a fact claimed resolved lacks an authority, a command, or an `observed_output_hash`. The open items are seeded once in `docs/runtime-verification/backlog.seed.yaml`; any backlog item whose `blocks` names a gate while still `status: open` blocks that gate until it is resolved with an authority, command, and `observed_output_hash`.

The seven DuckLake wrapper sentinels in `src/qdb_lake/maintenance.py` are resolved or explicitly deferred through code, not guessing and not silent runtime self-mutation. `task verify:ducklake-api` runs `scripts/probe_ducklake_api.py`, queries the pinned DuckDB/DuckLake build, records results in `docs/runtime-verification/ducklake_api.json` with an `observed_output_hash`, emits committed bindings for the Phase 0 subset, and records explicit backlog deferrals for non-Phase-0 wrappers. CI fails if a Phase 0 binding sentinel survives before a manifest is sealed, or if Phase 0 code calls a deferred wrapper. DuckDB ASOF joins are a real primitive for the modeling-interface panel path, but `qdb` MUST still enforce bitemporal validity and `source_available_at <= known_at`; ASOF alignment alone is never PIT safety.

> [!important] Evidence semantics that keep the lane from becoming false-green paperwork (`BT1`)
> The runtime-verification lane prevents guessing only if CI enforces four rules: `observed_output_hash` covers the full normalized command transcript including stdout, stderr, exit code, tool versions, and referenced output artifacts; killed or rejected candidates leave a `status: rejected` or `not_adopted` record carrying the failed command and output hash; `scripts/check_runtime_verification_usage.py` flags package imports or pins lacking a matching dependency note, with CI failing only for missing, malformed, or falsely resolved safety-bearing runtime-verification records; and every generated source file back-points to the verification record and hash that produced it. Backed by `test_runtime_verification_record_requires_authority_command_and_output_hash`.

> [!important] Toolchain pin/probe records (`BT7`)
> `docs/runtime-verification/toolchain.json` records the pinned-and-probed toolchain: Python patch plus GIL/JIT checks, `uv`, Task binary source/version, Ruff, Pyright install channel, pytest, Typer, Pydantic, Psycopg, Testcontainers, DuckDB, Polars, PyArrow, the Dagu binary SHA and exact license variant, and PostgreSQL client tools. Safety-bearing probes carry `observed_output_hash` records; ordinary package pins live in `docs/version-pins.md` and the lockfile with exact versions, distribution hashes, and a short why-this-pin note, while full per-package transcripts are advisory. `task verify:lockfile` fails if `pyproject.toml` and `uv.lock` diverge; `task verify:deps` proves every adopted runtime/dev dependency installs from the lock under the pinned Python. Exact versions, SHAs, and channels stay verification items until probed.

## Ryan Context And Scope

Ryan is an independent U.S.-based retail trader and developer building CCC as a personal quantitative research and execution stack. The target is local-first research for equities, ETFs, LEAPS, multi-month options, macro/fundamental context, SEC filings, and strategy/backtest workflows where point-in-time correctness matters more than shaving microseconds. This is a solo, self-maintained project. Practical maintainability, restoreability, and PIT safety outrank enterprise completeness, cloud purity, HFT latency, and tool maximalism.

The project must support mid-to-long-term trading: LEAPS, multi-month options, stock/ETF strategies, and macro/fundamental context. It must not optimize for tick-level market making, distributed cloud analytics, enterprise multi-user governance, or broad public APIs unless later measured evidence changes the goal.

## Core Decision And Non-Goals

The durable layer is conservative and the semantic layer is strict. DuckLake/PostgreSQL is day-one core because the project expects multiple clients and jobs, and hand-rolled lake metadata would recreate snapshots, schema evolution, file tracking, transactions, and conflict handling. Everything that adds operational surface before the correctness loop is proven is deferred.

> [!success] Core decision
> Build a local-first quant lakehouse: DuckLake tables over NAS-backed Parquet, PostgreSQL on the always-on control node as the DuckLake catalog, DuckDB and Polars as client-side query/transform engines, Dagu as the orchestration plane, a PIT-safe `qdb` SDK/tool layer for notebooks and agents, and LanceDB as the first SEC/news retrieval index only after the structured lake is proven.

### Non-Goals

- Do not implement the project from the vault root; implementation begins in the repo path declared by the PRD.
- Do not create a shared mutable NAS-hosted `quant.duckdb` as the canonical store.
- Do not make ClickHouse part of this PRD: no ClickHouse dependency, service, task, DAG, benchmark, table namespace, or hot mart.
- Do not make Qdrant, Spark, Kafka, Delta Lake, Iceberg, MinIO/S3-first storage, Airflow, Prefect, Dagster, Kubernetes, Great Expectations, OpenLineage, PostgreSQL PITR, or a broad REST API part of the first-release path.
- Do not give agents or notebooks arbitrary SQL over raw Parquet paths or unrestricted DuckLake tables in the first release.
- Do not treat DuckLake snapshots as proof of financial point-in-time correctness.
- Do not rely on DuckLake to enforce primary keys, foreign keys, unique constraints, or check constraints.
- Do not discard raw, bronze, or silver source observations for space savings, premium, liquidity, moneyness, vendor convenience, or cost reasons; any such filter belongs only in derived gold marts and must keep lineage back to the retained source observations.
- Do not treat the planning data-universe appendix or outside commentary as direct adapter-implementation authority where this PRD requires stronger raw-retention, PIT, source-availability, provider-capability, or adapter-enablement controls.
- Do not attempt full options backfill or automated vendor reconciliation before the Options EOD sample proves the contracts.
- Do not run live broker, trading, or order-routing logic in this project.
- Do not solve tick/quote-level HFT data or full OPRA tick history.
- Do not store secrets in vault notes, committed `.env`, Dagu YAML, logs, notebooks, manifests, or generated artifacts.

## Success Criteria

1. A new repo under `/Users/ryanpappal/03_CODE/ccc-lab-super/` (the external implementation code repo, not the vault project folder) can be created and bootstrapped with clear commands, tests, docs, and local config templates, runnable without the vault as cwd.
2. Two independent DuckDB clients attach to the same DuckLake/PostgreSQL scratch catalog and coordinate around a committed snapshot without any shared mutable native DuckDB file.
3. A publish/control kernel records dataset registry, batch state, locks, idempotency keys, legal transitions, crash boundaries, contract versions, snapshot binding, manifest/file inventory, validation/backup/restore linkage, cleanup eligibility, and visibility, and is the system of record rather than Dagu.
4. Dagu publishes a validated sample snapshot through a parent control DAG and publish-path child DAGs (`stage -> validate -> commit -> manifest -> backup -> pre-publish restore proof -> candidate promote -> candidate recovery drill -> publish`), plus separate `cleanup_dry_run` and `diagnose_failure` control/failure children, calling deterministic kernel commands and passing the selected-binary `dagu validate` gate plus the repo's anti-pattern lint; schema-subcommand validation runs only if the pinned binary supports it.
5. Failed validation produces no published manifest, no `qdb`-visible dataset version, and no post-publish backup marker.
6. The catalog plus kernel metadata can be backed up after a completed published batch and restored via copied-root scratch restore into a fresh root/catalog that verifies manifest-derived files, hashes where feasible, cleanup protection, and a known PIT query.
7. `qdb` rejects any PIT-relevant query that omits explicit `known_at`, and binds `known_at` to `source_available_at`, never `lake_published_at`.
8. A backfill ingested today is queryable at its historical `known_at` when source availability allows it.
9. Raw and adjusted price paths are separate, and `qdb` requires an explicit adjustment policy where adjustment matters; PIT-adjusted and ex-post-adjusted are distinguishable.
10. The core MVP demonstrates equities daily/minute plus minimal SEC/FRED PIT semantics over predeclared adversarial fixtures.
11. Options EOD is a small companion sample reusing the same contracts and kernel, non-blocking for the core unless a shared contract fails; quote/OI exact timing remains policy-gated until official/vendor evidence exists.
12. DuckLake maintenance jobs flush inlined data, list snapshot files, expire snapshots, and run cleanup dry-runs in Phase 0; merge/rewrite/orphan-delete remain explicit deferrals unless a later phase or a Phase 0 caller requires them, and any safe deletion happens only after retention gates protect backup-referenced files.
13. A benchmark harness compares query classes separately and gates scale; ClickHouse remains absent from every first-release surface.
14. Retrieval stays scaffolded/deferred behind a feature flag and, if enabled, prefilters documents by availability before candidate ranking.
15. All source adapters are disabled until a provider capability artifact exists, then emit raw archive evidence, normalized output, validation results, row counts, hashes, time ranges, source versions, source-availability policy IDs, and publish manifests. Disabled docs-derived adapter drafts may exist earlier under `REQ-SRC-DRAFT` with no enablement implication.
16. Benchmark artifacts record hardware/storage facts before scale: file counts, row groups, partitions, cold/warm scans, query profiles, host, storage path, route, cache mode, and failure modes.
17. Every kernel/Dagu/`qdb`/backup/restore/cleanup failure emits versioned JSON events and one diagnosis artifact with retry/quarantine/stop guidance and redaction status.
18. No non-scratch NAS lake/artifact/backup root is used until `ops/topology.yaml`, the storage capability probe, service/permission runbooks, route, mount options, atomic rename, read-after-close, listing latency, free space, and restore-copy behavior are verified under `task verify:prelive` / `task smoke:nas`.
19. The first release reaches a fixture-complete finish line on the synthetic `synthfix` provider alone: capability gates, refusal behavior, and PIT-safe query semantics are proven end to end through the kernel with zero live data, and every live adapter stays disabled until its provider capability artifact and source-availability policy exist.
20. The modeling-engine interface boundary (`REQ-IFACE-*`) is locked but not implemented in the fixture-complete core: panels, forward labels, derived registration, PIT-safe fill/resample, coverage, session pins, entity resolution, and tradable universes are reserved as typed `qdb`/kernel calls on existing machinery, with only leakage/absence tests present and gated so Phase 0 implements no interface call, no importable stub, and no schema body for that future surface.

## v7.2.3 release qualification amendment

AMD-044 defines four independently hash-bound qualifications: `fixture_core`, `storage_prelive`, `multi_host_prelive`, and `live_provider`. Safe local preparation is not a release tier. A lower tier never implies a higher tier, and provider enablement remains independent of host readiness.

`multi_host_prelive` requires the complete record from [[PRJ-AI-CCC-DuckLake-v7.2.3-Physical-Host-Bootstrap-And-Cutover]]: source custody, identity, estate quiescence, exact release, persistence, storage identity, dispatch, recovery, and receipt evidence. Without it, a non-scratch multi-host root is refused.
