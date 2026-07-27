---
type: prj
domain: ccc
status: active
date_created: 2026-07-11
date_modified: 2026-07-11
version: 7.2.3
tags:
  - ccc
  - ducklake
  - decisions
  - registry
---

# CCC DuckLake v7.2.3 deferred-decision registry

This is the one master list for every genuine postponed decision in the authoritative v7.2.3 packet. [[PRJ-AI-CCC-DuckLake-v7.2.3-Deferred-Decision-Rules]] governs every entry. Repeated PRD language points here instead of creating another decision process.

## Shared provider process

Provider items become ready when implementation begins for that named adapter or Ryan supplies a sample, entitlement, or purchase. Evidence must include official documentation, a raw sample or reproducible response, provider identity, format and timestamp behavior, and hashes where possible. Evidence expires when the provider changes its API, file format, entitlement, delivery schedule, or named product version. The adapter stays disabled when evidence is missing or conflicting. Results live in `provider_capabilities/<provider>.yaml`, the source-availability policy, and `docs/decisions/DD-XXX.json`. Proof is `task verify:source-adapter-gate` plus provider-specific refusal and fixture tests.

## Shared runtime-probe process

Runtime-binding items become ready during Phase 0 bootstrap before the first caller relies on them. Evidence is a version-pinned command transcript, tool versions, exit status, raw output, and an output hash. Evidence expires on any relevant package, binary, Python, operating-system, or architecture change. The caller stays blocked or uses the named safe fallback when proof fails. Results live in `docs/runtime-verification/`, `docs/version-pins.md`, the lockfile, and `docs/decisions/DD-XXX.json`.

## Shared pre-live process

Storage, host, and service items become ready only after the scratch fixture core is green and before the first non-scratch write. Evidence must come from the actual target route and hardware, not an example file. It expires when hardware, mount settings, network route, service version, permissions, identity, or recovery configuration changes. Failure keeps the affected non-scratch target unwritable. Results live in `docs/runtime-verification/`, the topology record, and `docs/decisions/DD-XXX.json`.

## Shared future-scope process

Future capabilities remain absent until their named trigger is observed. The decision compares the measured problem against the entry rule, records whether to open a separate PRD, and proves the current release still excludes the capability. Missing evidence means `rejected_for_now`, not silent implementation. A new PRD must cite the `DD-*` entry it supersedes.

## DD-001 — Committee authority

- Current status: `waiting`; advisory and shadow use only.
- Decision authority: exact tests measure shadow behavior; Ryan alone may approve one named interpretive gate-clearing class.
- Unknown: whether language-model committees add trustworthy gate-clearing value beyond exact tests.
- Safe while waiting: committees may advise or run in shadow mode but cannot clear gates.
- Start: an implemented runner pins model, prompt, evidence slice, and runner versions and can replay labeled PASS, FAIL, and ESCALATE cases.
- Deadline gate: decide before any committee is connected to a `task verify:*` gate.
- Evidence: shadow-run results against deterministic checks or Ryan decisions, including false PASS, false FAIL, disagreement, escalation, malformed-output, unavailable-model, and prompt-injection cases.
- Expires: any reviewer model, prompt, evidence layout, runner, or threshold changes.
- Method: deterministic checks remain final for exact facts; Ryan may approve only a narrow interpretive class after reviewing measured error rates and operator burden.
- Outcomes: `advisory_only`, `shadow_more`, `approve_named_interpretive_class`, or `remove_committee_gate`.
- No evidence: `advisory_only`.
- Record and proof: `docs/decisions/DD-001.json`; shadow replay report; test that no committee can override a failed exact check.
- Reopen: a pinned component changes or a reviewed false PASS occurs.

## DD-002 — DuckLake API and restore bindings

- Current status: `waiting` for the Phase 0 pinned-runtime probes.
- Decision authority: exact runtime, hash, and copied-root restore tests.
- Unknown: exact maintenance calls, file inventory, commit fingerprint, attach/relocation, cleanup, inlining, and copied-root restore behavior for the pinned DuckLake build.
- Start and deadline: Phase 0 bootstrap; decide before manifest sealing or any caller uses the affected wrapper.
- Evidence and expiration: shared runtime-probe process; expires on DuckDB, DuckLake, PostgreSQL extension, Python, or platform change.
- Method: exact probe and copied-root restore tests, never a model vote.
- Outcomes: verified DuckLake binding, manifest-authoritative restore fallback, or Parquet plus DuckDB fallback defined by the governing module.
- No evidence: block sealing and use only the already named fallback investigation path.
- Record and proof: DuckLake runtime-verification files, `docs/decisions/DD-002.json`, `task verify:ducklake-api`, and copied-root restore proof.
- Reopen: any pinned component or restore-path rule changes.

## DD-003 — Dagu binary and grammar

- Current status: `waiting` for evidence inside the implementation repo's sealed decision lane; prior scaffold evidence is advisory until imported and verified there.
- Decision authority: exact provenance, hash, and pinned-binary validation tests; license acceptance remains Ryan-only under DD-021.
- Unknown: the selected binary's exact provenance, license variant, and accepted workflow grammar.
- Start and deadline: Phase 0 bootstrap; decide before a Dagu workflow becomes part of `task verify:phase0`.
- Evidence and expiration: shared runtime-probe process; expires on Dagu version, asset, checksum, platform, or workflow-template change.
- Method: verify official source and hashes, run the pinned binary's validator, and save the transcript.
- Outcomes: pin and use the verified binary, select another verified candidate, or keep Dagu workflows blocked.
- No evidence: no unpinned binary and no trusted workflow grammar.
- Record and proof: `docs/runtime-verification/dagu_binary.json`, `docs/decisions/DD-003.json`, provenance verification, and Dagu validation.
- Reopen: version, asset, checksum, platform, or template changes.

## DD-004 — Dependency set and dataframe validator

- Current status: `waiting` for the Phase 0 compatibility probes.
- Decision authority: the ordered candidate tests and mandatory DuckDB SQL checks.
- Unknown: the exact compatible version set and whether dataframely, Pandera, or the degraded custom fallback fills the dataframe-validation role.
- Start and deadline: Phase 0 dependency bootstrap; decide before `task verify:phase0` may pass.
- Evidence and expiration: shared runtime-probe process plus the named RED tests; expires on any member of the pinned compatibility set changing.
- Method: try dataframely first, pivot to Pandera only on the named failures, and record degraded custom checks as incomplete rather than equivalent success.
- Outcomes: `dataframely`, `pandera`, or `degraded_investigate` with mandatory DuckDB SQL checks in every outcome.
- No evidence: keep the role open and block equivalent-completion claims.
- Record and proof: lockfile, `docs/version-pins.md`, validator proof, and `docs/decisions/DD-004.json`.
- Reopen: package, Python, operating-system, or architecture change.

## DD-005 — Provider capability and raw-evidence fidelity

- Current status: `waiting` per provider; all live adapters remain disabled.
- Decision authority: exact capability and source-gate checks establish technical fitness; Ryan alone approves purchase and live enablement under DD-021.
- Unknown: whether each planned provider preserves the raw data, timestamps, identifiers, entitlement facts, and availability evidence required by CCC.
- Start and deadline: shared provider process; decide separately for each provider before its adapter is enabled.
- Method: validate the provider capability pack, raw sample, refusal behavior, and source-availability policy.
- Outcomes: enable the named adapter, keep a disabled draft, reject the provider, or request more evidence before the gate.
- No evidence: adapter disabled and `rejected_for_now` at the enablement gate.
- Evidence and expiration: the shared provider process.
- Record and proof: provider pack, policy, provider-specific `docs/decisions/DD-005--provider-slug.json` with `parent_decision_id: DD-005`, and `task verify:source-adapter-gate`.
- Reopen: shared provider expiration events.

## DD-006 — SEC public-availability timing

- Current status: `waiting`; conservative fixture-only timing remains active.
- Decision authority: exact evidence and leakage checks establish the clock; Ryan alone approves live SEC enablement under DD-021.
- Unknown: when an accepted filing becomes safely public for point-in-time research, including after-hours exceptions.
- Start and deadline: when SEC fixture or adapter timing is implemented; decide exact intraday behavior before any live SEC query is enabled.
- Evidence: cited SEC policy plus observed or supplied artifacts that distinguish acceptance from public dissemination.
- Expires: SEC policy, feed, endpoint, form handling, or timestamp behavior changes.
- Method: use the most conservative supported clock unless exact cited evidence proves a narrower rule.
- Outcomes: conservative date/end-of-day policy, verified exact policy, or keep SEC live disabled.
- No evidence: conservative fixture-only policy and no live enablement.
- Record and proof: source-availability policy, cited evidence hash, `docs/decisions/DD-006.json`, and leakage/refusal tests.
- Reopen: named expiration events or a leakage finding.

## DD-007 — FRED and ALFRED release timing

- Current status: `waiting`; conservative end-of-day timing remains active.
- Decision authority: exact official-record, sample, and leakage checks.
- Unknown: whether exact intraday release times are needed and trustworthy beyond the conservative date policy.
- Start and deadline: before encoding exact intraday macro availability or enabling live macro queries.
- Evidence: official release records and reproducible samples for the selected series.
- Expires: API, series metadata, release-calendar, or ingestion policy changes.
- Method and outcomes: choose verified exact time only when evidence supports it; otherwise retain conservative end-of-day or keep the affected live path disabled.
- No evidence: conservative end-of-day.
- Record and proof: policy, `docs/decisions/DD-007.json`, macro leakage fixtures, and source gate.
- Reopen: named expiration events or a leakage finding.

## DD-008 — Options quote, open-interest, and session clocks

- Current status: `waiting`; uncertain live fields remain masked, refused, or fixture-only.
- Decision authority: exact official/vendor evidence and field-availability tests; Ryan alone approves live provider enablement under DD-021.
- Unknown: quote availability, open-interest lag, and market-session differences by instrument and provider.
- Start and deadline: Options EOD Phase 1B; decide each exact clock before it becomes a live fixture or queryable field.
- Evidence: OCC, OPRA, exchange, and vendor documentation plus raw samples.
- Expires: provider, file schedule, field meaning, instrument calendar, or session rule changes.
- Method: encode only clocks supported by evidence; mask or refuse unavailable fields.
- Outcomes: verified field clocks, fixture-only conservative clocks, field masked, or provider rejected.
- No evidence: no live OI/quote claim; field remains investigate, masked, or refused.
- Record and proof: policy, `docs/decisions/DD-008.json`, availability fixtures, and options gate.
- Reopen: named expiration events or leakage finding.

## DD-009 — DiscountOptionData and index-option coverage

- Current status: `waiting`; no index-option coverage claim is trusted.
- Decision authority: exact symbol-list, sample, identifier, and gap checks; Ryan alone approves purchase and live use under DD-021.
- Unknown: actual SPX, VIX, NDX, RUT, and non-standard deliverable coverage.
- Start and deadline: when Ryan supplies or buys a symbol list/sample; decide before the provider is selected for those instruments.
- Evidence and expiration: shared provider process plus symbol list and sample hashes; expires on product/coverage revision.
- Method: compare claimed and observed coverage, identifiers, deliverables, and gaps.
- Outcomes: select for proven symbols, use only as a supplement, reject for named instruments, or keep disabled.
- No evidence: no coverage claim and no adapter enablement.
- Record and proof: provider pack, coverage report, `docs/decisions/DD-009.json`, and gap-lineage tests.
- Reopen: coverage or product revision.

## DD-010 — Norgate Windows export path

- Current status: `waiting`; Norgate is not a Phase 1 dependency.
- Decision authority: exact repeat-export, settings, and hash checks; Ryan alone approves purchase and live use under DD-021.
- Unknown: whether a repeatable Windows or VM export preserves settings, hashes, timing, and raw evidence.
- Start and deadline: when Norgate adapter work begins; decide before Norgate becomes a Phase 1 dependency.
- Evidence: VM/export procedure, adjustment and padding settings, raw exports, hashes, and repeat run.
- Expires: Norgate, Windows, VM image, export format, or settings change.
- Method: repeat the export and compare settings and hashes.
- Outcomes: enable the proven export adapter, keep a disabled draft, or reject Norgate for this release.
- No evidence: Norgate is not a Phase 1 dependency.
- Record and proof: provider pack, export proof, `docs/decisions/DD-010.json`, and adapter gate.
- Reopen: named expiration events.

## DD-011 — NAS capability and canonical storage

- Current status: `waiting`; every non-scratch root remains unwritable.
- Decision authority: exact real-route storage and failure probes establish technical readiness; canonical-root promotion still requires the matching Ryan-authorized receipt.
- Unknown: whether the real Mac-to-NAS route safely supports atomic rename, read-after-close, listing, disconnect recovery, free space, permissions, identity, and restore copies.
- Start and deadline: after fixture core is green; decide before the first non-scratch write or `storage_prelive` qualification.
- Evidence and expiration: shared pre-live process using the actual route; expires on NAS, disk pool, mount, network path, credentials, permissions, client OS, or topology change.
- Method: run the required storage and failure probes, then require every correctness check to pass. Performance numbers inform layout but cannot excuse a correctness failure.
- Outcomes: approve the named NAS root, approve a narrower role, choose local storage temporarily, or reject the route.
- No evidence: non-scratch root remains unwritable.
- Record and proof: storage probe, topology record, `docs/decisions/DD-011.json`, `task smoke:nas`, and `task verify:prelive`.
- Reopen: named expiration events or any failed real-world storage check.

## DD-012 — Benchmark thresholds and scale permission

- Current status: `waiting`; all thresholds remain record-only and scale remains blocked.
- Decision authority: exact benchmark runs produce provisional values; Ryan alone freezes a threshold and tolerance.
- Unknown: acceptable measured limits for each query and maintenance class.
- Start and deadline: after the scratch correctness loop produces a real baseline; decide before full-data scale-up for that class.
- Evidence: repeatable measurements with data shape, hardware, storage path, cold/warm state, profiles, failures, and provisional tolerance.
- Expires: meaningful data-layout, hardware, storage-route, engine, or benchmark-harness change.
- Method: exact benchmark records the baseline; Ryan reviews and freezes each threshold and tolerance.
- Outcomes: freeze threshold, request another layout attempt, keep record-only, or open a separate scale/hot-mart PRD after the stated escape rule.
- No evidence: record-only and no scale permission.
- Record and proof: benchmark baseline, signed freeze marker, `docs/decisions/DD-012--benchmark-class.json` with `parent_decision_id: DD-012`, and must-pass benchmark after freeze.
- Reopen: named expiration events or repeated regression beyond tolerance.

## DD-013 — Production metrics, alerts, and worker topology

- Current status: `waiting`; structured events and one safe heavy worker remain the limit.
- Decision authority: exact event/load evidence selects technically justified controls; Ryan approves any production-topology expansion.
- Unknown: which alerts and worker layout are justified by observed failures and load.
- Start and deadline: after scratch kernel, restore, qdb, Dagu, validation, and structured events are green; decide before claiming production operations readiness.
- Evidence: event history, failure frequency, job duration, queue pressure, host capacity, and recovery experience.
- Expires: topology, workload, service, host, or observability format change.
- Method: choose the smallest alert and worker layout that addresses measured failures; do not add a metrics platform only because it is common elsewhere.
- Outcomes: structured events only, add named alerts, add a metrics backend, or add named worker capacity.
- No evidence: structured events remain the authority; one safe heavy worker maximum.
- Record and proof: operations design, `docs/decisions/DD-013.json`, alert simulations, and pre-live topology checks.
- Reopen: named expiration events or missed operational incident.

## DD-014 — Retrieval and vector search

- Current status: `waiting`; retrieval remains absent and disabled.
- Decision authority: exact labeled evaluation and availability-prefilter tests; Ryan approves any separate Qdrant or expanded retrieval PRD.
- Unknown: whether retrieval adds enough value and whether LanceDB meets a labeled evaluation before Qdrant is considered.
- Start and deadline: after the structured lake is green and a bounded SEC/news corpus plus labeled questions exist; decide before enabling the retrieval feature flag.
- Evidence: availability-prefilter proof, hit rate, ranking quality, citations, latency, maintenance cost, and failure cases.
- Expires: corpus, embedding model, chunking, index version, or evaluation-set change.
- Method: test LanceDB first; improve data and ranking before changing infrastructure; consider Qdrant only on the named failed threshold or service-feature need.
- Outcomes: enable LanceDB, improve and retry, open Qdrant evaluation, or reject retrieval for now.
- No evidence: retrieval absent and feature flag off.
- Record and proof: retrieval evaluation, `docs/decisions/DD-014.json`, availability-before-ranking tests, and feature-absence guard.
- Reopen: named expiration events or new measured need.

## DD-015 — Modeling and backtesting interface

- Current status: `waiting`; every reserved interface call remains absent.
- Decision authority: Ryan approves the modeling-engine PRD; exact consumer and leakage tests govern the implementation opened by it.
- Unknown: when the future engine exists and which reserved calls should become implemented APIs.
- Start and deadline: a modeling-engine PRD supplies concrete consumers and data-shape needs; decide before any `REQ-IFACE-*` stub or callable enters the core.
- Evidence: consumer examples, PIT leakage tests, panel and derived-artifact shapes, session-pin needs, and performance measurements.
- Expires: modeling-engine contract or core dataset contract changes.
- Method: implement only calls required by the supplied consumer contract while preserving the locked PIT rules.
- Outcomes: open a named interface phase, revise the reserved boundary through a new PRD, or keep every interface call absent.
- No evidence: absence and gated xfail tests remain.
- Record and proof: modeling handoff, `docs/decisions/DD-015.json`, leakage tests, and absence/presence checks.
- Reopen: named expiration events or a new engine PRD.

## DD-016 — Full options backfill and provider reconciliation

- Current status: `waiting`; the bounded Options EOD sample is the maximum allowed scope.
- Decision authority: exact backfill, overlap, clock, and calibration gates establish readiness; Ryan approves any scope or purchase expansion under DD-021.
- Unknown: whether the sample contracts, identities, clocks, and overlap rules are strong enough for full history and automated reconciliation.
- Start and deadline: Options EOD sample and shared kernel are green; decide before a multi-partition options pull or reconciliation job.
- Evidence: sample coverage, identifier mapping, deliverable changes, overlap mismatches, source timing, file counts, and backfill plan.
- Expires: provider format, coverage, identifier, clock, or contract change.
- Method: require the source backfill plan and measured overlap calibration; retain all raw observations regardless of outcome.
- Outcomes: approve bounded backfill, approve named reconciliation rules, keep manual/lineage-only comparison, or reject scale-up.
- No evidence: companion sample only.
- Record and proof: backfill plan, calibration, `docs/decisions/DD-016.json`, and options/backfill gates.
- Reopen: named expiration events or reconciliation failure.

## DD-017 — Advanced maintenance and remapped-root restore

- Current status: `waiting` per operation; advanced wrappers and remapped-root restore remain unavailable.
- Decision authority: exact API, dry-run, retention, snapshot, and rollback tests; physical deletion remains Ryan-only.
- Unknown: whether merge, rewrite, orphan deletion, and remapped-root restore are needed and safe after copied-root restore is green.
- Start and deadline: copied-root restore and Phase 0 maintenance are green and a real need for one named operation appears; decide before that operation is callable.
- Evidence: pinned API probe, dry run, retained-snapshot proof, active-pin protection, backup retention, and rollback test.
- Expires: DuckLake version, retention policy, manifest format, or root-layout change.
- Method: decide separately per operation using exact tests; physical deletion remains Ryan-only.
- Outcomes: enable named operation behind its guards, keep deferred, or reject and use the existing safer path.
- No evidence: wrapper remains uncallable and remapped-root remains unavailable.
- Record and proof: maintenance proof, `docs/decisions/DD-017--operation-slug.json` with `parent_decision_id: DD-017`, and refusal/retention tests.
- Reopen: named expiration events or safety incident.

## DD-018 — S3-compatible storage path

- Current status: `waiting`; no S3 or MinIO surface is allowed.
- Decision authority: exact matched-workload comparison establishes technical merit; Ryan approves adding the service and operational scope.
- Unknown: whether an S3-compatible layer materially improves correctness or measured performance over NAS direct.
- Start and deadline: after at least one serious NAS-direct layout attempt is measured and found inadequate or unclear; decide before adding MinIO/S3 services or dependencies.
- Evidence: matched workload comparison including correctness, latency, scanned bytes, operations burden, recovery, and failure modes.
- Expires: storage layout, NAS route, S3 implementation, hardware, or workload change.
- Method: prefer NAS direct unless the comparison shows a named material win or correctness fix.
- Outcomes: stay NAS direct, open a bounded S3 path, or reject S3 for this release.
- No evidence: no S3/MinIO surface.
- Record and proof: comparison, `docs/decisions/DD-018.json`, and dependency/surface absence guard.
- Reopen: named expiration events or NAS failure.

## DD-019 — ClickHouse or another hot mart

- Current status: `waiting`; ClickHouse and every hot-mart surface remain absent.
- Decision authority: exact failed frozen benchmarks establish the trigger; Ryan alone approves opening a separate hot-mart PRD.
- Unknown: whether DuckLake layouts and a gold mart can meet frozen timestamp-cross-section and option-chain thresholds.
- Start and deadline: only after two serious DuckLake layout attempts and one gold-mart attempt miss Ryan-frozen thresholds; decide before any ClickHouse dependency, service, benchmark, DAG, or namespace appears.
- Evidence: frozen thresholds, repeatable failed benchmarks, query plans, layout attempts, and operations-cost estimate.
- Expires: workload, threshold, engine, layout, or hardware change.
- Method: open a separate hot-mart PRD; never add ClickHouse inside this PRD by stealth.
- Outcomes: open hot-mart PRD, make another bounded DuckLake correction, or reject hot mart.
- No evidence: ClickHouse remains absent.
- Record and proof: `docs/decisions/DD-019.json`, separate PRD if selected, and absence guard.
- Reopen: the exact trigger recurs with current evidence.

## DD-020 — Heavy hardening

- Current status: `waiting` per control; current conservative limits remain active.
- Decision authority: exact incident, reproduction, and control tests establish technical need; Ryan approves any new service, authority, or major scope.
- Unknown: which advanced protections are justified: zombie-writer I/O fencing, update write-amplification work, broader host backpressure, distributed Dagu, detailed version-bump runbook, or license-expiry purge-on-restore.
- Start and deadline: separately when a measured incident, failed test, capacity limit, version change, or license rule creates the named need; decide before claiming the affected higher readiness level.
- Evidence: incident or benchmark record, affected path, recovery limits, and smallest proposed control.
- Expires: affected architecture, workload, license, or component changes.
- Method: decide each control separately; prefer the smallest control that fixes the measured problem.
- Outcomes: implement named hardening, retain current safe limit, open a separate operations PRD, or reject the control.
- No evidence: current conservative limits remain and no higher readiness claim is allowed.
- Record and proof: `docs/decisions/DD-020--control-slug.json` with `parent_decision_id: DD-020` plus the named failure reproduction and control test.
- Reopen: named expiration event or repeat incident.

## DD-021 — Spending, license acceptance, and live-provider enablement

- Current status: `waiting` per provider or tool; no purchase or live enablement is approved.
- Decision authority: Ryan only, using the technical evidence packet and a matching signed marker.
- Unknown: whether Ryan accepts the cost, entitlement, retention, deletion, redistribution, and operational terms for a named source or tool.
- Start and deadline: after technical evidence is complete and before purchase, credential use, live download, or adapter enablement.
- Evidence: current price and product, license/entitlement text, retention and termination rules, capability evidence, and technical recommendation.
- Expires: price, product, terms, account, entitlement, provider, or intended use changes.
- Method: evidence packet plus Ryan's explicit decision; no committee or automated rule can approve it.
- Outcomes: approve named purchase/use/enablement, approve with limits, reject, or request new evidence before the deadline.
- No evidence or Ryan unavailable: no purchase and no live enablement.
- Record and proof: signed marker, provider pack, `docs/decisions/DD-021--provider-or-tool-slug.json` with `parent_decision_id: DD-021`, credential-free refusal test, and source gate.
- Reopen: named expiration events.

## DD-022 — Multi-host trust and commissioning

- Current status: `waiting`; remote targets and canonical promotion remain quarantined.
- Decision authority: exact prerequisite aggregation establishes readiness; the matching Ryan-authorized receipt permits only the named promotion or physical action.
- Unknown: whether each M4, M5, M2, PostgreSQL, and NAS path has proven identity, quiescence, exact release, persistence, dispatch, rollback, recovery, and receipt authority.
- Start and deadline: after local fixture core is green and a verified read-only discovery identity exists; decide before `multi_host_prelive` or canonical-root promotion.
- Evidence and expiration: shared pre-live process plus the complete multi-host record; expires on identity, certificate, controller, release, service, host, route, trust, or recovery change.
- Method: exact prerequisite aggregation in the required stop order; a later proof cannot replace an earlier missing one.
- Outcomes: approve the exact host/role/path set, approve a smaller set, quarantine one target, or reject commissioning.
- No evidence: scratch-only local work continues and remote targets stay quarantined.
- Record and proof: multi-host record, `docs/decisions/DD-022.json`, and `task verify:multi-host-prelive`.
- Reopen: named expiration events or any identity/recovery failure.

## DD-023 — Market-calendar authority

- Current status: `waiting`; no package's current calendar view is historical truth.
- Decision authority: exact ordered candidate and historical-session tests.
- Unknown: which package can generate a correct starting calendar while CCC preserves historical truth and manual corrections.
- Start and deadline: before `trading_calendar_bt` becomes an implemented dependency for Phase 1 or modeling work.
- Evidence and expiration: shared runtime-probe process plus historical-session fixtures; expires on package, calendar-rule, exchange, or correction-policy change.
- Method: test `exchange_calendars` first and `pandas_market_calendars` second; first passing candidate wins, then snapshot into CCC-owned bitemporal records.
- Outcomes: select first candidate, select fallback, or keep calendar-dependent features blocked.
- No evidence: no current-package view is treated as historical truth.
- Record and proof: version pin, fixture report, `docs/decisions/DD-023.json`, and calendar history tests.
- Reopen: named expiration events or discovered historical error.

## DD-024 — Runtime constants and package layout

- Current status: `waiting` per item; no unproven value may be hard-coded.
- Decision authority: exact contention, serialization, dtype, mapping, and layout tests.
- Unknown: exact advisory-lock key hashing, lease and retry constants, concrete Polars dtype spellings, coverage-flag sources, and final package roots.
- Start and deadline: each item becomes ready when its owning Phase 0 implementation begins; decide before the affected code path is accepted by `task verify:phase0`.
- Evidence and expiration: contention tests, serialization tests, dtype probes, contract mapping, and repo layout inspection; expires when the affected package, schema, workload, or layout changes.
- Method: exact tests and contract comparison, never memory or model vote.
- Outcomes: record proven value/layout, choose the named safe fallback, or keep the affected path blocked.
- No evidence: no hard-coded guess and no completion claim.
- Record and proof: runtime-verification artifact, `docs/decisions/DD-024--item-slug.json` with `parent_decision_id: DD-024`, and owner-local tests.
- Reopen: named expiration events.

## Module coverage map

This map gives every production module a default set of registry owners. The automatic coverage check still reviews every deferral-like phrase and records exclusions; this map does not excuse an unmatched sentence.

- Architecture and bootstrap: DD-003, DD-004, DD-014, DD-018, DD-019, DD-023, DD-024.
- Committee gates and HITL: DD-001 and DD-021.
- Dataset contracts and validation: DD-004, DD-008, DD-016, DD-023, DD-024.
- Executive contract and authority: DD-001, DD-014, DD-015, DD-016, DD-019, DD-021, DD-022.
- Manifests, lineage, and fixtures: DD-002, DD-005, DD-015, DD-017.
- Modeling-engine interface: DD-014, DD-015, DD-023, DD-024.
- Operations, recovery, maintenance, and security: DD-002, DD-011, DD-013, DD-017, DD-020, DD-022.
- Orchestration and qdbctl: DD-003, DD-013, DD-020, DD-024.
- PIT and bitemporal policy: DD-006, DD-007, DD-008, DD-023.
- Physical-host bootstrap and cutover: DD-011, DD-013, DD-022.
- Provider capability and availability: DD-005 through DD-010, DD-016, DD-021.
- Publish-control kernel: DD-002, DD-017, DD-020, DD-024.
- qdb agent access and SQL-zero: DD-014, DD-015, DD-023, DD-024.
- Verification, benchmarks, and readiness: all DD entries; this module owns deadline-gate enforcement and the coverage report, not the decisions themselves.
