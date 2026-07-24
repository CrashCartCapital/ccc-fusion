---
type: prj
domain: ccc
status: active
date_created: 2026-06-28
date_modified: 2026-07-11
version: 7.2.3
---

# CCC DuckLake v7.2.3 Modeling Engine Interface

Every later-phase modeling, retrieval, calendar, or runtime-shape item in this module follows DD-014, DD-015, DD-023, and DD-024 in [[PRJ-AI-CCC-DuckLake-v7.2.3-Deferred-Decision-Registry]]. Until a concrete modeling consumer supplies the required evidence, interface calls remain absent rather than existing as speculative stubs.

This module is the canonical v7.2.3 owner for the deferred `REQ-IFACE-*` coupling contract between the PIT-custody data project and Ryan's future modeling/backtesting engine. It is a semantic-preserving structural port from v6.5.0; Phase 0 and Phase 0.5 build, scaffold, stub, or call none of this interface.

## Module Boundary

**Owns:** deferred `REQ-IFACE-*` contract, no-stub Phase 0 rule, future interface calls, new dataset families, derived artifact mapping, and gated modeling-interface tests.

**Depends On:** [[PRJ-AI-CCC-DuckLake-v7.2.3-QDB-Agent-Access-And-SQL-Zero]] for core typed access; [[PRJ-AI-CCC-DuckLake-v7.2.3-Dataset-Contracts-And-Validation]] for canonical dataset families; [[PRJ-AI-CCC-DuckLake-v7.2.3-Publish-Control-Kernel]] and [[PRJ-AI-CCC-DuckLake-v7.2.3-Manifests-Lineage-And-Fixtures]] for derived artifact custody; [[PRJ-AI-CCC-DuckLake-v7.2.3-PIT-And-Bitemporal-Policy]] for leakage gates.

**Read After:** [[PRJ-AI-CCC-DuckLake-v7.2.3-Architecture-Context-And-Bootstrap]], [[PRJ-AI-CCC-DuckLake-v7.2.3-QDB-Agent-Access-And-SQL-Zero]], and [[PRJ-AI-CCC-DuckLake-v7.2.3-Dataset-Contracts-And-Validation]].

**Non-Authoritative Restatements:** this module names future dataset families and interface calls only as gated contracts. It does not authorize Phase 0 stubs, service surfaces, raw table access, or model-engine implementation, and it does not move live provider enablement into the modeling layer.

**Source Ranges Ported:** PRD 547-560, 1753-1774, 3296-3341, and 3608-3629.

## Phase 1.5 Modeling Interface

Phase 1.5 builds the typed modeling-engine interface (`REQ-IFACE-*`) once the Phase 1 core is green. It self-phases: core typed `qdb` reads are the current Phase 0/1 access boundary; the trading calendar and `register_derived` land in Phase 1 because they have core value and gate later work; the panel/fill/coverage/session surface lands in Phase 1.5. Nothing here is a Phase 0 deliverable, and the interface adds no new service, daemon, or platform; it is contracts and typed functions on the existing kernel, manifests, lineage, and `qdb`.

| Phase 1.5 lane | Scope | Required proof |
|---|---|---|
| Panel as-of | `get_panel_asof(...)` over the explicit `security_id × decision_time × known_at` grid | Every cell satisfies `source_available_at <= row.known_at`; vectorized (no scalar API per cell); lineage returns `panel_spec_hash`, manifest/snapshot/policy IDs, `session_pin_id`, `max_input_availability_by_column`, `dropped_cell_counts`, and `coverage_summary`. |
| PIT-safe fill/resample | `as_of_fill` / `resample_to_calendar` | Fills never cross `source_available_at`; resample binds to the bitemporal `trading_calendar_bt`; outputs are derived/non-canonical. |
| Coverage/quality | `get_coverage` | Exposes completeness, gaps, correction density, survivorship, and quality flags; never silently filters. |
| Research session pin | `open_session(as_of_manifests=...)` | Returns an immutable `session_pin_id` recorded in lineage; pins are reproducible and cannot mutate. |
| Lazy/streaming | Arrow RecordBatch / Polars LazyFrame with an explicit memory budget | Lineage and session pin are preserved across lazy/streaming reads. |

Table: Phase 1.5 modeling-interface lanes. `register_derived` and `trading_calendar_bt` land in Phase 1 (see the Modeling-Engine Interface section); the rest land here.


### Modeling-Engine Interface (`REQ-IFACE`)

The engine coupling boundary is tiered. Core typed `qdb` reads are the current Phase 0/1 access boundary; `register_derived` and `trading_calendar_bt` open in Phase 1; the `REQ-IFACE-*` panel/fill/coverage/session family opens in Phase 1.5. All tiers reuse the existing kernel, contracts, manifests, lineage, and `qdb` with no new service, daemon, or platform. The boundary rule: the platform owns objective, leakage-prone mechanics (as-of joins, availability gates, calendars, coverage reports, fill/resample semantics, derived-artifact custody, lineage, reproducible snapshot pins); the engine owns research meaning (feature/label definitions, outlier policy, model training, split methodology, portfolio simulation, costs, metrics). Phase 0 implements none of the `REQ-IFACE-*` family; its leakage tests are reserved as gated/`xfail` boundary tests. Detailed call signatures and dataset families are in the Modeling-Engine Interface section below.

> [!warning] Deferred surface — not built in the fixture-complete core
> Every `REQ-IFACE-*` requirement is a future-engine COUPLING CONTRACT. Phase 0 and Phase 0.5 implement NONE of it; only its leakage tests exist, gated/`xfail`, to lock the boundary early. No `REQ-IFACE-*` item blocks the fixture-complete-core green gate. Read every MUST in this family as "MUST, once the named interface phase is reached" — never "MUST now." Do not build, serve, or scaffold any interface call during the fixture-complete core.
>
> `QD15`: `get_calendar` and all other IFACE output schemas are deliberately absent from the fixture-complete core. Their absence is an intentional no-stub boundary, not an implementation gap; schema bodies land only when the relevant `REQ-IFACE-*` phase opens.

- `REQ-IFACE-01`: The engine MUST couple to this project only through versioned `qdb` calls, `register_derived`, and lineage — never raw tables or Parquet paths (extends `REQ-QDB-01` across the repo boundary). Deferred: Phase 1 or 1.5; `phase0_blocking: false`; `phase0_status: gated xfail only`.
- `REQ-IFACE-02`: `get_panel_asof(...)` MUST build a vectorized `security_id × decision_time × known_at` grid in which every cell satisfies `source_available_at <= row.known_at`, and where relevant `valid_from <= row.decision_time < valid_to` and `row.known_at < known_to OR known_to IS NULL` (Phase 1.5).
- `REQ-IFACE-03`: The modeling-engine consumption format is Polars-first: eager reads return Polars DataFrames, and panel reads MUST support Arrow RecordBatch / Polars LazyFrame for lazy/streaming access with an explicit memory budget while preserving lineage and the session pin. pandas is an explicit export/adapter surface only (a boundary conversion the caller asks for), never the primary internal contract; DuckDB relations may serve internally as an implementation detail but are not the first external modeling-engine contract (Phase 1.5; `phase0_blocking: false`).
- `REQ-IFACE-04`: `as_of_fill` and `resample_to_calendar` MUST never cross `source_available_at`; their outputs are derived/non-canonical (generalizes the existing macro forward-fill guardrail). Deferred: Phase 1 or 1.5; `phase0_blocking: false`; `phase0_status: gated xfail only`.
- `REQ-IFACE-05`: A bitemporal `trading_calendar_bt` served dataset MUST bind resample/fill and MUST subsume the D08 session-calendar verification flags rather than adding a parallel concern (Phase 1; hybrid calendar posture — the market-calendar source is resolved under `REQ-AUTH-01` from the ordered candidates `exchange_calendars` first, then `pandas_market_calendars` as fallback, probed against official docs; the winner's output is snapshotted and versioned into the CCC-owned `trading_calendar_bt` rather than consulted live, because a package's current-calendar view is never historical truth by itself; manual overrides enter only as explicit, versioned, bitemporal correction rows with provenance — who/when/why/source — never as in-place edits).
- `REQ-IFACE-06`: `get_coverage` MUST expose completeness, gaps, correction density, survivorship, and quality flags, and MUST never silently filter (Phase 1.5).
- `REQ-IFACE-07`: `open_session(as_of_manifests=...)` MUST return an immutable research session pin recorded in lineage as `session_pin_id` (Phase 1.5).
- `REQ-IFACE-08`: `register_derived` MUST mint a contract, lineage, `known_at`, manifest, and snapshot through the full kernel path (stage, validate, commit, manifest, backup, publish); `known_at` defaults to the max source availability of all parents and the call fails closed if any parent lineage lacks source availability (Phase 1).
- `REQ-IFACE-09`: Derived families MUST be separated: `feature_set` (features at `entity × known_at`), `label_set` (training labels, physically separate), and `signal_score` (model scores); training joins MUST be explicit. `signal_score` is a reserved future interface contract with a gated RED test; serving is deferred until the engine produces scores. Deferred: Phase 1 or 1.5; `phase0_blocking: false`; `phase0_status: gated xfail only`.
- `REQ-IFACE-10`: Panel specs, registration specs, the parent-ref schema, and derived contracts MUST be versioned; this requirement governs the later panel/fill/coverage/session family, while core typed `qdb`, `register_derived`, and `trading_calendar_bt` keep their named phase gates. The panel spec is a flat column-list with explicit per-column dataset binding (notebook-readable), not a dataset-graph spec. Deferred: Phase 1 or 1.5; `phase0_blocking: false`; `phase0_status: gated xfail only`.
- `REQ-IFACE-11`: `resolve_entities_asof` MUST map external IDs to a canonical `security_id` via the bitemporal aliases (the shared PIT-safe resolver of `REQ-QDB-07`), preferring exact/alias matches, using fuzzy matching only with an explicit method/version and confidence threshold, and failing closed on ambiguity; ambiguous/low-confidence rows are never silently mapped and are publishable only to a quarantine/diagnostic artifact (Phase 1.5).
- `REQ-IFACE-12`: Dynamic liquidity-gated universes (for example `us_top_500/1000/2000_addv_30d`) MUST be registered derived reference datasets read through `get_universe_asof(...)`, bitemporal, computed from bars available as of `known_at`, retaining delisted names — never ad hoc notebook filters and never strategy-specific sample selection hidden inside `qdb` (Phase 1.5).


## Modeling-Engine Interface (`REQ-IFACE-*`)

> [!warning] Implementation gate — Phase 0 / 0.5 build NONE of this
> The MUST-language in this section specifies the FUTURE coupling contract. In the current build its only artifacts are the gated `xfail` leakage tests; Phase 0 and Phase 0.5 implement, scaffold, stub, or call NONE of `REQ-IFACE-*`. Build each surface only in its named phase (1 / 1.5). See the Implementation Index (Blocking? = no, gated xfail).

The `REQ-IFACE-*` family defines the later panel/fill/coverage/session contract between this PIT-custody data project and Ryan's separate, planned modeling/backtesting engine. It is contracts and typed functions on the existing kernel, contracts, manifests, lineage, and `qdb`; it adds no new database, REST service, feature-store service, daemon, or platform. It self-phases (nothing in Phase 0; `trading_calendar_bt` and `register_derived` in Phase 1; `get_panel_asof` / `as_of_fill` / `resample_to_calendar` / `get_coverage` / `open_session` in Phase 1.5), and its leakage tests are gated. The full requirement bullets live in the Requirements section (`REQ-IFACE-01` ... `REQ-IFACE-12`); this section is the artifact seed they reference.

> [!warning] Deferred surface — not built in the fixture-complete core
> Every `REQ-IFACE-*` requirement is a future-engine COUPLING CONTRACT. Phase 0 and Phase 0.5 implement NONE of it; only its leakage tests exist, gated/`xfail`, to lock the boundary early. No `REQ-IFACE-*` item blocks the fixture-complete-core green gate. Read every MUST in this section and its call signatures as "MUST, once the named interface phase is reached" — never "MUST now." Do not build, serve, or scaffold any interface call during the fixture-complete core.

> [!info] The boundary rule
> The platform owns objective, leakage-prone mechanics: as-of joins, availability gates, calendars, coverage reports, fill/resample semantics, derived-artifact custody, lineage, and reproducible snapshot pins. The engine owns research meaning: feature definitions, label definitions, outlier policy, model training, split methodology, portfolio simulation, costs, and metrics. The platform validates storage, PIT clocks, lineage, contracts, uniqueness, and separation; it never interprets feature/label/alpha/model meaning.

### Known Downstream Consumer Boundary

`ccc-quant-engine` is a known downstream consumer in a separate repo. It couples through core typed `qdb` reads now, through `register_derived` and `trading_calendar_bt` when Phase 1 opens, and through the `REQ-IFACE-*` panel/fill/coverage/session family only after the Phase 1.5 gate opens; this note gives the consumer a compatibility hook, not authority over DuckLake.

External Quant Engine mocks such as `MockQdbClient` are non-authoritative test doubles outside DuckLake. They do not create DuckLake stubs, do not make live interfaces ready, and must pass conformance before live integration.

Coverage semantics are binding handoff meanings. `coverage_status`, `coverage_window`, unresolved-identifier warnings, outside-coverage warnings or refusals, and later `get_coverage` output must be treated as data-knowability signals by downstream consumers, not as research-validity decisions owned by DuckLake.

Downstream engines must not treat NAS paths, DuckDB files, or worker topology as safe multi-writer state. DuckLake's kernel authority protects DuckLake-owned state only; external engine state needs its own central lock/write backend before concurrent writers are safe.

### Deferred Interface Calls

Six calls extend the existing seven. They reuse `QdbResult`; Phase 0/1 `QdbLineageV1` stays core-only because research-session identity and derived-parent expansion belong to the later IFACE lineage extension or `QdbLineageV2`, not the current query-result lineage. The future call set also includes `get_calendar`:

| Call | Intent | Phase |
|---|---|---|
| `get_panel_asof(panel_spec, decision_times, known_at_per_row, ...)` | Vectorized `security_id × decision_time × known_at` grid; every cell `source_available_at <= row.known_at` | 1.5 |
| `register_derived(spec, parents, ...)` | Registers engine-produced derived artifacts by minting contract/lineage/`known_at`/manifest/snapshot through the full kernel path | 1 |
| `as_of_fill(...)` | PIT-safe forward/as-of fill that never crosses `source_available_at`; output derived/non-canonical | 1.5 |
| `resample_to_calendar(...)` | Resample bound to the bitemporal `trading_calendar_bt` | 1.5 |
| `get_coverage(...)` | Completeness, gaps, correction density, survivorship, quality flags; never silently filters | 1.5 |
| `open_session(as_of_manifests=...)` | Immutable research session pin recorded in lineage as `session_pin_id` | 1.5 |
| `get_calendar(exchange, known_at, ...)` | Reads `trading_calendar_bt` as-of `known_at` | 1 |

Table: The six deferred interface calls plus `get_calendar` extending the core seven.

The panel grid is explicit `security_id × decision_time × known_at` with per-row `known_at` (no implicit global "now"). Each cell MUST satisfy `source_available_at <= row.known_at`, and where relevant `valid_from <= row.decision_time < valid_to` and `row.known_at < known_to OR known_to IS NULL`. Panel lineage returns `panel_spec_hash`, `manifest_ids`, `ducklake_snapshot_ids`, `source_availability_policy_ids`, `session_pin_id`, `max_input_availability_by_column`, `dropped_cell_counts`, and `coverage_summary`. The panel spec is a flat column-list with explicit per-column dataset binding (notebook-readable for a solo researcher), not a dataset-graph spec. `register_derived` defaults `known_at` to the max source availability of all parents and fails closed if any parent lineage lacks source availability; every registration goes through the full kernel path (stage, validate, commit, manifest, backup, publish). DuckDB ASOF joins may implement the alignment, but `qdb` still enforces bitemporal validity and `source_available_at <= known_at` — ASOF alignment alone is never PIT safety.

### New Dataset Families

The interface seed reserves names for future interface-phase contracts: `trading_calendar_bt` (bitemporal exchange sessions/holidays/half-days/open-close, source version, availability, known interval), `feature_set` (derived features at `entity × known_at`, parent lineage refs, transform version, `known_at = max(input availability)`), `label_set` (training labels only — `horizon_start/end`, `realized_at`, `label_available_at`, `target_formula_hash`, parent lineage; physically separate from features), `signal_score` (`score_available_at`, producer run ID, model version, training-data pin, parent lineage), `liquid_universe_membership_bt` (`addv_30d`, rank, membership interval, availability, lineage), and `entity_resolution_observation` (original identifier/name, candidate `security_id`, confidence, method, `known_at`, valid interval, ambiguity status). `trading_calendar_bt` is a first-pass contract (see the Dataset Contract Seed); Phase 0/1 MUST NOT create schemas, tables, migrations, SDK calls, or seed contracts for `feature_set`, `label_set`, or `signal_score`. Those derived families are introduced only through the gated `REQ-IFACE-*` phase and minted through `register_derived` after the engine exists.

### Derived Artifact Mapping

Derived artifacts use existing custody machinery and never create parallel producer APIs inside the data platform:

- Labels → engine-computed label artifacts are physically separated in `label_set` and registered through `register_derived`; the data platform does not expose a `get_forward_labels` producer or a training-matrix builder.
- Write-back → `register_derived`.
- ADDV universes (`us_top_500/1000/2000_addv_30d`, computed from bars available as of `known_at`, bitemporal, delisted names retained) → a derived daily pipeline read through the existing `get_universe_asof(...)`.
- Entity resolution → `resolve_entities_asof` (exact/alias preferred, fuzzy only with an explicit method/version and a confidence threshold; ambiguous/low-confidence rows never silently mapped, publishable only to a quarantine/diagnostic artifact).

`signal_score` is a reserved future interface contract with a gated RED test only; no serving schema or implementation appears before the engine exists and produces scores. Phase 0/1 `QdbLineageV1` must not carry dormant IFACE fields such as `session_pin_id` or `parent_lineage_refs`; those arrive only through a later lineage extension or `QdbLineageV2` when the `REQ-IFACE-*` gate opens.


### Gated Modeling-Interface RED Tests (`REQ-IFACE-*`, `xfail` in Phase 0)

These tests are gated/`xfail`; Phase 0 implements none of the interface. The reserved "when feature tables exist" guardrails bind to the deferred interface path rather than a Phase 0 implementation: `test_feature_known_at_is_max_input_availability` belongs to the panel path and `test_labels_not_exposed_through_feature_api` is the physical-separation test, while `test_centered_rolling_feature_rejected`, `test_cross_sectional_normalization_uses_pit_universe`, and `test_non_pit_feature_construction_requires_explicit_non_pit_mode` remain deferred guardrails.

- `test_panel_asof_enforces_source_available_at_le_known_at_per_cell`
- `test_panel_asof_respects_valid_time_and_known_time_intervals`
- `test_panel_asof_vectorized_grid_does_not_call_scalar_api_n_times`
- `test_lazy_panel_preserves_lineage_and_session_pin`
- `test_as_of_fill_does_not_cross_source_available_at`
- `test_resample_binds_to_bitemporal_trading_calendar`
- `test_trading_calendar_no_current_calendar_for_history`
- `test_get_coverage_exposes_gaps_quality_flags_without_filtering`
- `test_research_session_pin_is_immutable`
- `test_register_derived_assigns_contract_manifest_snapshot_parent_lineage`
- `test_feature_set_known_at_equals_max_parent_availability`
- `test_label_set_not_accessible_through_feature_panel`
- `test_engine_label_artifact_registers_only_through_label_set`
- `test_signal_score_requires_score_available_at_and_producer_run`
- `test_liquid_universe_addv_membership_is_pit_and_bitemporal`
- `test_resolve_entities_asof_rejects_ambiguous_low_confidence_mapping`
- `test_engine_cannot_read_raw_tables_or_parquet_paths`

## v7.2.3 session-pin ownership amendment

AMD-006 confirms that no session-pin schema, API, stub, or generic Phase 0 substitute exists. This module alone opens `open_session` and pin storage in Phase 1.5. Ops may consume active pins only after that lifecycle exists; Phase 0 protects manifests, snapshots, backups, and retention windows without pin joins.

## v7.2.3 r2 restored indexed acceptance criterion

- `test_session_pin_blocks_deletion_only_after_iface_activation`: the test stays strict-gated while the modeling interface is absent; after Phase 1.5 activates session pins, an open pin blocks deletion of every referenced manifest and file, while Phase 0 cleanup uses only manifest, snapshot, backup, and retention protections.
