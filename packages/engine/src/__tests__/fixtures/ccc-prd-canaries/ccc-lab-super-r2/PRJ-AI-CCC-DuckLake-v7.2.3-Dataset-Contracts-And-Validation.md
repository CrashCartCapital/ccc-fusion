---
type: prj
domain: ccc
status: active
date_created: 2026-06-28
date_modified: 2026-07-11
version: 7.2.3
---

# CCC DuckLake v7.2.3 Dataset Contracts And Validation

Every postponed validator, field-clock, options-reconciliation, calendar, or concrete-runtime-shape item in this module follows DD-004, DD-008, DD-016, DD-023, and DD-024 in [[PRJ-AI-CCC-DuckLake-v7.2.3-Deferred-Decision-Registry]]. A future field or investigate value is not queryable authority until its named evidence and proof are current.

This module is the canonical v7.2.3 owner for dataset contracts, canonical schema seeds, validation tiers, and transform traps. It is a semantic-preserving structural port from v6.5.0; requirement decisions, provider gates, source policy posture, `synthfix` status, phase order, refusal behavior, and modeling-interface deferral state are intentionally unchanged.

## Module Boundary

**Owns:** data model seed, physical layout seed, dataset contract registry, minimum contract YAMLs, validation tiers, transform traps, and dataset schema/validation requirements/tests.

**Depends On:** [[PRJ-AI-CCC-DuckLake-v7.2.3-PIT-And-Bitemporal-Policy]] for clock and interval semantics; [[PRJ-AI-CCC-DuckLake-v7.2.3-Publish-Control-Kernel]] for publish state; [[PRJ-AI-CCC-DuckLake-v7.2.3-Provider-Capability-And-Availability]] for source-policy enablement; [[PRJ-AI-CCC-DuckLake-v7.2.3-QDB-Agent-Access-And-SQL-Zero]] for API projections.

**Read After:** [[PRJ-AI-CCC-DuckLake-v7.2.3-Executive-Contract-And-Authority]], [[PRJ-AI-CCC-DuckLake-v7.2.3-Architecture-Context-And-Bootstrap]], and [[PRJ-AI-CCC-DuckLake-v7.2.3-PIT-And-Bitemporal-Policy]].

**Non-Authoritative Restatements:** provider capability rows and source-availability policy IDs appear here only where schemas reference them; [[PRJ-AI-CCC-DuckLake-v7.2.3-Provider-Capability-And-Availability]] owns live-adapter enablement/refusal semantics. `qdb` output schemas may map or project these contracts, but this module remains the canonical dataset schema authority.

**Source Ranges Ported:** PRD 1594-1600, 1602-1611, 1775-2408, 2409-2423, 3520, 3585-3590, 3604, and 3674-3681.

## Requirements

### Options EOD Companion (`REQ-OPT`)

- `REQ-OPT-01`: Options EOD MUST be a parallel companion sample that shares core contracts and the kernel but does not block Phase 1 unless it exposes a shared contract defect.
- `REQ-OPT-02`: Raw, bronze, and silver options observations MUST be retained even when derived marts filter by low premium, liquidity, moneyness, index/non-index class, or research convenience (D01).
- `REQ-OPT-03`: Option contract terms MUST carry a per-contract `settlement_style` tag (`AM` | `PM`) on `option_contract_bt`, so an expiration fill is never simulated at a price that never existed (one provider serves both AM-settled SPX and PM-settled SPXW; see the AM-versus-PM transform trap below). The column joins the `option_contract_bt` contract with the Phase 1B options companion via a contract-version bump and stays `fixture_only` until settlement-calendar evidence is verified; provider capability packs keep per-contract settlement facts out of static packs (FBL2-17a).
- `REQ-OPT-04`: Quote availability and open-interest availability MUST be separate clocks; deliverable changes MUST be bitemporal; exact quote/OI timing fixtures MUST NOT be encoded until OCC/OPRA/vendor evidence verifies the policy (D08).
- `REQ-OPT-05`: Source overlap MUST preserve both observations in silver, surface disagreements in lineage, and apply explicit precedence only in gold marts; full automated reconciliation is deferred.
- `REQ-OPT-06`: Options EOD layout MUST avoid contract/strike partition explosion; default is date plus underlier/root bucket with sort by underlier, expiration, right, strike, and trade date.
- `REQ-OPT-07`: Index-option coverage gaps and non-standard deliverables MUST appear explicitly in dataset caveats and `qdb` lineage.
- `REQ-OPT-IV-01` (evidence-gated vendor IV/Greeks): Whether implied volatility and Greeks are formally ingested or later derived is a per-source evidence decision, never a fixed A-or-B default made from memory. Step one is always examining current vendor documentation and sample-file schemas for the selected options source (`REQ-SRC-IVGREEKS` in [[PRJ-AI-CCC-DuckLake-v7.2.3-Provider-Capability-And-Availability]]). If the source provides native IV and/or Greeks fields and their availability/provenance can be verified, those vendor values are ingested as formal database members carrying full provenance: source field name, source version/file/schema hash, capture timestamp, vendor calculation caveats where documented, raw observation lineage, and the availability clock — marked `vendor_provided` and semantically distinct from any locally computed value. If IV/Greeks are not available from the source, or availability/provenance cannot be verified, normalized contracts/quotes remain canonical and IV/Greeks are computed later as derived post-ingestion datasets registered through `register_derived`, marked `locally_computed` with model and version lineage. Vendor-provided and locally computed IV/Greeks MUST never share an ambiguous field: derived values never overwrite or masquerade as vendor fields, and no IV/Greek value is ever invented silently. Raw/bronze/silver option observations are retained either way (`REQ-OPT-02`). Backed by `test_vendor_iv_greeks_carry_provenance_and_never_mix_with_derived`.
- `REQ-SPLICE-01` (historical-to-forward splice calibration): Any query whose date range or `known_at` spans a historical-provider-to-forward-provider seam (for example HistoricalOptionData/Cboe history spliced to Databento/Massive forward feeds) MUST resolve a `historical_forward_splice_calibration.v1` record with `calibration_status: calibrated` for that provider pair and dataset before returning blended results; absent one, the query refuses or requires an explicit override flag per the record's `seam_query_policy`, never silently blending. This is distinct from `REQ-OPT-05` source-overlap preservation, which governs storage/lineage of overlapping raw observations, not query-time blending across the seam. Backed by `test_historical_forward_splice_overlap_calibrated_before_seam_query`.

### Historical-Forward Splice Calibration Artifact (`historical_forward_splice_calibration.v1`)

```yaml
splice_calibration_version: 1
calibration_id: splice_<historical_provider>_<forward_provider>_<dataset>_v1
provider_pair: [<historical_provider>, <forward_provider>]
dataset: <dataset name>
overlap_window: {start: <date>, end: <date>}
divergence_metrics: [<e.g. zero_bid_handling_delta, iv_surface_rmse, relative_spread_delta, yield_curve_input_delta>]
divergence_thresholds: {<metric>: null}   # record-only until Ryan reviews real overlap data; no invented thresholds (REQ-BENCH-FREEZE posture)
caveats: [<seam-specific caveats>]
lineage_tag: <applied to rows proven inside a calibrated seam>
seam_query_policy: refuse | explicit_flag_required | blended_with_caveat
calibration_status: uncalibrated | in_review | calibrated | quarantined
evidence_artifact_path: <path>
```

Listing: `historical_forward_splice_calibration.v1` — the artifact `REQ-SPLICE-01` resolves. It explicitly covers the HistoricalOptionData/Cboe → Databento/Massive forward seams where applicable; thresholds stay `null`/record-only until Ryan reviews real overlap evidence.

### Data Contracts And Validation (`REQ-CONTRACT`)

- `REQ-CONTRACT-01`: The project MUST maintain a versioned dataset-contract registry under `contracts/`, executed through Pydantic, `jsonschema`, a Polars-native dataframe validator (`dataframely` first, Pandera fallback), and DuckDB SQL checks rather than a bespoke YAML parser; the validator order is set in `REQ-CONTRACT-05`.
- `REQ-CONTRACT-02`: Each contract MUST define dataset name, grain, logical keys, required columns, allowed nulls, dtypes, time columns, the four PIT clocks, partition columns, sort keys, allowed joins, source-overlap tolerances, caveats, owner, schema version, the as-of predicate template, and example safe queries. Nullability is declared by an explicit `allowed_nulls` list of column names: a column is nullable if and only if it appears in `allowed_nulls`, which is the single machine-readable source of truth. `_nullable` dtype suffixes and `# nullable` comments are non-authoritative readability hints, and contract validation MUST fail when a hint and `allowed_nulls` disagree.
- `REQ-CONTRACT-03`: First-pass contracts MUST exist for a minimum set of FIFTEEN contracts before broad adapters: `dataset_registry` (which has a committed contract seed in this module — see the Dataset Contract Seed), `security_identity`, `symbol_alias_bt`, `universe_membership_bt`, `corporate_action_bt`, `equity_bar_1d`, `equity_bar_1m`, `fundamental_fact_bt`, `macro_observation_vintage`, `trading_calendar_bt`, `option_contract_bt`, `option_eod_quote`, `source_batch`, `publish_manifest`, and `dataset_contract`.
- `REQ-CONTRACT-04`: Validation MUST fail closed for missing/unexpected columns, bad dtypes, impossible timestamps, duplicate logical keys, nulls in required fields, broken/overlapping PIT intervals, and source-overlap mismatches above declared tolerance. For bitemporal tables with corrections, validation either uses a stable `source_observation_id` in the logical key or defines uniqueness across logical key plus non-overlapping knowledge intervals, so original and corrected observations can coexist without duplicate-key false positives. An empty knowledge interval `[T, T)` produced by same-instant supersession is legal and NOT a broken interval (see [[PRJ-AI-CCC-DuckLake-v7.2.3-PIT-And-Bitemporal-Policy]], Bitemporal Supersession Policy; FBL2-12); "broken/overlapping" means malformed intervals (start after end) or overlapping open intervals for one logical key. Amendment (v7.2.3): overlap enforcement is a named mechanism, not prose. Tier 1 (every PIT-bearing dataset, `sql_integrity` tier): validation MUST run the overlap-detection query family `overlap_check(dataset, logical_key_cols, known_from, known_to)` — a per-logical-key self-join returning any pair of rows whose half-open knowledge intervals intersect (`a.known_from < COALESCE(b.known_to, 'infinity') AND b.known_from < COALESCE(a.known_to, 'infinity')`), plus a second pass over any declared `{start, end}` valid-time pair — pre-commit, zero rows to pass. DuckLake enforces only `NOT NULL` (`REQ-LAKE-06`), so this SQL tier is the only overlap enforcement for lake-resident data. Backed by `test_overlap_check_detects_interposed_known_time_interval_per_logical_key` and `test_overlap_check_covers_valid_time_where_contract_declares_it`.
- `REQ-CONTRACT-04b` (v7.2.3): any interval-bearing table resident in the kernel's PostgreSQL catalog MUST additionally declare a GiST exclusion constraint using the half-open idiom — `EXCLUDE USING gist (<logical_key> WITH =, tstzrange(known_from, COALESCE(known_to, 'infinity'), '[)') WITH &&)` (requires `btree_gist`) — making overlap physically impossible where Postgres can enforce it. No current kernel table carries a logical-key interval; this rule is a conformance scan that binds any such table introduced later. DDL residence and the conformance rule live with [[PRJ-AI-CCC-DuckLake-v7.2.3-Publish-Control-Kernel]]. Provenance: the idiom is proven in the archive-frozen predecessor (`CCC_lab migrations/002_create_index_constituents.sql:98-104`). Backed by `test_kernel_interval_table_declares_gist_exclude_half_open_constraint` and `test_gist_exclude_constraint_rejects_concurrent_overlapping_insert` (real Postgres, prelive).
- `REQ-CONTRACT-05`: The first-release validation foundation is an ORDERED candidate posture resolved under `REQ-AUTH-DEP-01`, not one fixed library. (1) Polars-native staged-dataframe validation follows a DETERMINISTIC WATERFALL, not a qualitative bakeoff an autonomous agent cannot judge (`BT4`): implement `dataframely` first only after its Dependency Proof Gate passes and a version+hash pin is recorded; before that proof exists, it runs only under `task verify:deps:candidates` and is not exercised by `task verify:phase0`. Pivot to Pandera only if the named RED tests fail or the `dataframely` arm64/ABI wheel fails to compile/import. If both row-validator candidates fail, CCC-owned minimal row-schema checks plus the mandatory DuckDB SQL integrity checks may be recorded as a degraded fallback/investigate state, but that fallback is not equivalent completion of the Polars-native dataframe-validator role and must name the blocker in `docs/runtime-verification/backlog.seed.yaml`. The keep/kill proof is targeted at BITEMPORAL-INTERVAL OVERLAP specifically — `dataframely` passes a row-wise schema on `equity_bar_1d` while a separate DuckDB SQL check still catches a deliberately overlapping PIT interval the row-wise validator cannot express — not at generic duplicate keys (which `dataframely` can express via `primary_key`). The loser is dropped, not run in parallel as authority. (2) JSON/YAML artifact and schema validation (runtime-verification records, manifest schemas, event schemas, Dagu action-wrapper schemas, contract-registry shape): the core `jsonschema` library, with `check-jsonschema` allowed only as optional hook/pre-commit glue, never runtime authority. (3) DuckDB SQL integrity checks before the snapshot commit are MANDATORY and NOT replaceable by any dataframe/schema validator — duplicate logical keys, overlapping PIT intervals, FK-like integrity, source-clock checks, source-overlap mismatches, and manifest/file checks stay DuckDB SQL plus CCC code (`REQ-VALIDATION-TIERS`). Great Expectations and OpenLineage remain deferred non-goals; `datacontract-cli` is a strictly bounded local-only spike (no service/cloud/platform behavior) that MUST NOT own registry semantics, schema evolution, or publish state.
- `REQ-CONTRACT-06`: Validation results MUST be persisted as artifacts tied to the batch ID and DuckLake snapshot; no production publish may bypass validation without an explicit emergency flag and a written artifact.
- `REQ-VALIDATION-TIERS`: Validation MUST be tiered and MUST include schema/dtype checks, materialized row/value checks, DuckDB SQL integrity checks, PIT-interval checks, source-clock checks, manifest/file checks, and `qdb`-visible smoke checks. Schema validation alone is explicitly insufficient for duplicate logical keys, overlapping bitemporal/PIT intervals, FK-like integrity, or source-availability violations; the canonical test shape is a dataset that passes schema validation but still fails the pre-commit SQL integrity gate (D21). The tier vocabulary is machine-tokenized (FBL2-21c): `schema_dtype`, `materialized_rows`, `sql_integrity`, `pit_interval`, `source_clock`, `manifest_file`, and `qdb_smoke` — exactly the values `validation_event.check_tiers` carries — with `strictness_mode` restricted to `strict` or `default` on the validation artifact. The `qdb_smoke` tier executes as the candidate recovery drill's unmodified `qdb` query.

## Ingestion Watermarks And Sync Idempotency (v7.2.3)

Two separate record types, two separate tables — never one overloaded table. Both reside in the kernel PostgreSQL catalog (DDL owned by [[PRJ-AI-CCC-DuckLake-v7.2.3-Publish-Control-Kernel]]); this module owns the contract semantics.

```yaml
### ingestion_watermark.v1 — time-series high-water mark per stream
watermark_schema_version: 1
dataset: <canonical dataset name>
logical_stream_key: <provider/channel/partition tuple>
watermark_ns: <int64 epoch nanoseconds, monotonic>
updated_at: <UTC timestamp>
source_batch_id: <lineage FK>
```

```yaml
### dataset_sync_state.v1 — checksum idempotency for bulk artifacts
sync_schema_version: 1
dataset_id: <string>
checksum: <sha256 of source content>
synced_at: <UTC timestamp>
source_batch_id: <lineage FK>
```

- `REQ-INGEST-WATERMARK-01`: watermark advancement MUST be monotonic; a regressing write raises `WatermarkRegressionError` unless `force=True` is explicitly passed, and every forced regression is logged as a structured event. Backed by `test_watermark_regression_raises_unless_force_and_force_is_logged`.
- `REQ-INGEST-WATERMARK-02`: the application-level check is the primary gate and MUST run before the upsert; the DB-level guard (`INSERT ... ON CONFLICT (dataset, logical_stream_key) DO UPDATE SET watermark_ns = EXCLUDED.watermark_ns WHERE ingestion_watermark.watermark_ns <= EXCLUDED.watermark_ns`) is defense-in-depth against races, never the primary refusal path — a silent no-op row is not a refusal. Backed by `test_watermark_db_level_upsert_guard_is_defense_in_depth_not_primary_gate`.
- `REQ-INGEST-WATERMARK-03`: `is_dataset_synced(dataset_id, checksum)` is a pure read against `dataset_sync_state` only — no write, no timestamp touch, no watermark mutation, no validation side effect. Backed by `test_is_dataset_synced_read_has_no_write_side_effect` and `test_dataset_sync_state_is_separate_table_from_ingestion_watermark`.
- `REQ-INGEST-WATERMARK-04`: rows at or below the current watermark are dropped by the late-data filter and counted in the `ingestion_event` (`late_rows_dropped_count`); silent drops are forbidden. Backed by `test_late_data_filter_counts_dropped_rows_in_ingestion_event` (phase1).
- `REQ-INGEST-WATERMARK-05`: any in-memory watermark cache MUST be reloaded from the catalog before each ingestion run; the table is sole authority, matching the kernel's read-current-state-from-DB rule. Backed by `test_watermark_cache_reloaded_from_db_not_trusted_across_runs`.

Provenance: the monotonic guard, DB-level `WHERE EXCLUDED >=` upsert, and checksum sync idempotency are proven patterns from the archive-frozen predecessor's ingestion watermark manager; the two-table split and side-effect-free reads deliberately reverse its two verified defects (one overloaded table serving both concerns, and freshness validation fired from a read path).

## Data Model Seed

The implementation must not overfit the initial schema, but these conceptual families must exist. Dataset-specific contracts refine names.

| Family | Purpose | PIT sensitivity |
|---|---|---|
| `security_identity` | Stable internal identity for securities and instruments | High; symbol mappings change. |
| `symbol_alias_bt` | PIT-safe symbol/exchange aliases with half-open intervals | Critical lookahead trap. |
| `corporate_action_bt` | Splits, dividends, mergers, symbol changes, deliverables; declaration vs ex-date | Critical for raw/adjusted policy. |
| `equity_bar_1d` and `equity_bar_1m` | Raw and adjusted market bars with the four clocks | Medium to high depending on corrections/adjustments. |
| `fundamental_fact_bt` | SEC/XBRL/vendor facts with accession and acceptance availability | Critical. |
| `macro_observation_vintage` | FRED/ALFRED observations with vintage intervals | Critical. |
| `option_contract_bt` | Options contract identity and lifecycle, bitemporal deliverables | High. |
| `option_eod_quote` | EOD options chain facts with separate quote/OI clocks | High for source overlap and mapping. |
| `source_batch` | Source ingestion batch metadata | Operationally critical. |
| `publish_manifest` | Publish/snapshot lineage bound to the kernel | Operationally critical. |
| `dataset_contract` | Schema/PIT/query contract registry | Critical for agents and validation. |
| `provider_capability` | Live-adapter evidence pack and enablement status | Critical before source adapters. |
| `source_availability_policy` | Machine-readable source-known-time policy, including investigate/disabled status | Critical for PIT correctness. |
| `qdb_lineage` | Versioned `QdbLineage v1` schema returned by typed calls | Critical for agents and reproducibility. |
| `run_event` and `failed_run_diagnosis` | Versioned observability and failure artifacts | Critical for safe retries, quarantine, and restore. |
| `trading_calendar_bt` | Bitemporal exchange sessions/holidays/half-days/open-close with source version, availability, and a known interval | Critical; binds resample/fill so history never uses a current calendar (`REQ-IFACE-05`). |
| `feature_set` | Derived features at `entity × known_at` with parent lineage refs and transform version | Critical; `known_at = max(input availability)` (`REQ-IFACE-08/09`). |
| `label_set` | Training labels only (`horizon_start/end`, `realized_at`, `label_available_at`, `target_formula_hash`, parent lineage), physically separate from features | Critical; look-ahead only in a label context. |
| `signal_score` | Model scores with `score_available_at`, producer run ID, model version, training-data pin, parent lineage | Critical; reserved future interface contract, serve later. |
| `liquid_universe_membership_bt` | ADDV-gated dynamic universe membership (`addv_30d`, rank, membership interval, availability, lineage) | Critical; PIT and bitemporal, delisted retained (`REQ-IFACE-12`). |
| `entity_resolution_observation` | External identifier/name → candidate `security_id` with confidence, method, `known_at`, validity, ambiguity status | High; fails closed on ambiguity (`REQ-IFACE-11`). |

Table: Required conceptual data families.

## Physical Layout Seed With Benchmark Gates

The exact NAS mount path is config-driven, but the logical layout stays stable. Layout parameters are decisions to benchmark, not assumptions to accept.

```text
${QDB_LAKE_ROOT}/
  raw/
    polygon_or_massive/
    norgate/
    discountoptiondata/
    sec/
    fred/
    finnhub/
  bronze/
  silver/
    equity/
    option/
    sec/
    macro/
    reference/
  gold/
    bars_by_symbol/
    bars_by_time/
    option_eod_chain_by_underlying/
    fundamental_pit_panel/
    macro_vintage_panel/
    universe_membership_pit/
  schemas/
  contracts/
  manifests/
  provider_capabilities/
  source_availability_policies/
  logs/
  quarantine/
  artifacts/
    dagu/
    validation/
    restore/
    diagnostics/
    observability/
  benchmarks/
```

Listing: Logical storage contract under the configured lake root.

Layout parameters are gated by Phase 0/1 benchmarks rather than fixed up front: target file size (a starting candidate of 128–256 MB to be benchmarked, not assumed), row-group size, sort keys, compression, statistics writing, partition columns per dataset, and compaction cadence. Options layout must use coarser temporal buckets (for example year/month plus underlier) if daily-plus-underlier partitioning produces small-file explosion on the NAS. NAS metadata-listing speed, atomic-rename behavior, cold/warm scans, concurrent readers during publish, and direct-LAN vs relayed paths are explicit Phase 0 measurements before scale.

## Dataset Contract Seed

Contracts are plain, reviewable files executed through ordinary validators, not a bespoke parser. The corrected seed below fixes the earlier ambiguity by separating `source_available_at`, optional `known_to`, `ingested_at`, and `lake_published_at`, and by making the as-of predicate reference columns that actually exist in the contract.

```yaml
contract_version: 1
dataset_name: equity_bar_1d
grain: one row per security_id per session_date per source_version per adjustment_state
pit_mode: required
logical_keys:
  - security_id
  - session_date
  - source
  - source_version
  - adjustment_state
required_columns:
  security_id: int64
  symbol_at_source: string
  session_date: date
  exchange_timezone: string
  bar_start_at: timestamp_utc
  bar_end_at: timestamp_utc
  open: float64
  high: float64
  low: float64
  close: float64
  volume: int64
  adjustment_state: string
  source: string
  source_version: string
  source_available_at: timestamp_utc
  known_to: timestamp_utc_nullable
  vendor_correction_available_at: timestamp_utc_nullable
  ingested_at: timestamp_utc
  lake_published_at: timestamp_utc
  source_batch_id: string
  manifest_id: string
allowed_nulls: [known_to, vendor_correction_available_at]
pit:
  valid_time:
    start: bar_start_at
    end: bar_end_at
    interval: half_open_utc
  knowledge_time:
    start: source_available_at
    end: known_to
    interval: half_open_utc
  requires_known_at: true
  asof_predicate_template: "source_available_at <= :known_at AND (:known_at < known_to OR known_to IS NULL)"
layout:
  partition_columns:
    - year
    - month
    - session_date
    - symbol_bucket
  sort_keys:
    - security_id
    - session_date
  target_file_size_mb: benchmark_gated
  row_group_policy: verify_in_phase0
  compression: zstd
  write_statistics: true
allowed_joins:
  - security_identity.security_id
  - symbol_alias_bt.security_id
validation:
  fail_on_missing_pit_fields: true
  fail_on_duplicate_logical_key: true
  fail_on_naive_timestamp: true
  source_overlap_tolerance_ref: contracts/tolerances/equity_bar_1d.yaml
caveats:
  - raw and adjusted values must not be mixed without explicit adjustment_policy
  - source_available_at controls financial known_at
  - lake_published_at controls local visibility only, not financial known_at
```

Listing: Contract seed showing four clocks, half-open knowledge interval policy, and source-availability gating.

As-of predicate templates are machine-readable with exactly two placeholder names (FBL2-21b): `:known_at` (knowledge clock) and `:as_of_valid_date` (valid clock, where applicable). Templates execute through parameter binding, never string interpolation. `point_in_time` valid-time equality is enforced by `qdb` code at query-build time and is not encoded in the stored template. DuckDB's exact named-parameter syntax is UNVERIFIED and resolves by runtime probe under `REQ-AUTH-01`; the `:name` form in contracts is contract-level notation translated once by the single query builder.

Minimum contract set before adapters: `dataset_registry`, `source_batch`, `publish_manifest`, `dataset_contract`, `security_identity`, `symbol_alias_bt`, `universe_membership_bt`, `corporate_action_bt`, `equity_bar_1d`, `equity_bar_1m`, `fundamental_fact_bt`, `macro_observation_vintage`, `trading_calendar_bt`, `option_contract_bt`, and `option_eod_quote`.

### Minimum Contract Set (replicating the equity_bar_1d pattern)

`equity_bar_1d` (above) is the template, with one schema rule made explicit per the interval-semantics invariant: on a PIT-queryable dataset every PIT field group declares its own interval inline — `{start, end, interval: half_open_utc}` for a duration and `{at, semantics: point_in_time}` for an instant — so a PIT-queryable dataset never carries a top-level `pit.interval` (the pure-metadata contracts below are the only exception: they set `pit_mode: not_applicable` with a top-level `interval: not_applicable` and no field groups). Each remaining dataset gets the same shape with its own `asof_predicate_template`: duration datasets (bars, and the `valid_from`/`valid_to` validity intervals of `security_identity`, `symbol_alias_bt`, `universe_membership_bt`, `option_contract_bt`) keep half-open `{start, end}` valid-time, while date-grain/event datasets (`corporate_action_bt`, `fundamental_fact_bt`, `macro_observation_vintage`, `trading_calendar_bt`, `option_eod_quote`) declare point-in-time valid-time. Datasets that are pure metadata (`dataset_registry`, `source_batch`, `publish_manifest`, `dataset_contract`) declare `pit_mode: not_applicable` and set `asof_predicate_template: not_applicable` — the key is always present, but a real predicate is required only when `pit_mode: required`. Fields that are real columns but not yet populated are marked `future`; fields whose exact timing is unverified are marked `fixture_only`. `pit_mode: reference` datasets (for example `security_identity`) validate and refuse exactly as `pit_mode: required` does; `reference` marks identity/reference semantics for routing, never a weaker PIT posture (FBL2-21e).

Date-grain validity fields must declare the calendar and timezone used to interpret `valid_from`, `valid_to`, `session_date`, and option terms. Add a DST/cross-market holiday fixture before relying on date intervals for live-source decisions.

```yaml
contract_version: 1
dataset_name: dataset_registry
grain: one row per dataset per registry_version
pit_mode: not_applicable
logical_keys: [dataset, registry_version]
allowed_nulls: [active_manifest_id, caveats]
required_columns:
  dataset: string
  registry_version: int64
  contract_version: int64
  owner: string
  pit_mode: string
  allowed_apis: list_string
  storage_namespace: string
  visibility_status: string
  active_manifest_id: string_nullable
  caveats: json_nullable
  created_at: timestamp_utc
  updated_at: timestamp_utc
pit:
  asof_predicate_template: not_applicable
validation: {fail_on_missing_required_columns: true, fail_on_unknown_visibility_status: true}
caveats:
  - Registry rows control dataset visibility and allowed qdb APIs; active_manifest_id points only to a published manifest.
```

```yaml
contract_version: 1
dataset_name: security_identity
grain: one row per security_id per identity validity interval per knowledge interval
pit_mode: reference
logical_keys: [security_id, valid_from, source, source_version]   # valid_from added (FBL2-21d): two validity intervals per security/source_version must not collide
allowed_nulls: [figi, cik, valid_to, known_to]
required_columns:
  security_id: int64
  primary_symbol: string
  asset_class: string
  figi: string                              # future: populated when a figi map is verified
  cik: string                               # future: equity-to-filer link, fixture_only until SEC map verified
  valid_from: date
  valid_to: date                            # nullable; NULL = open
  source: string
  source_version: string
  source_available_at: timestamp_utc
  known_to: timestamp_utc_nullable
  ingested_at: timestamp_utc
  lake_published_at: timestamp_utc
pit:
  valid_time: {start: valid_from, end: valid_to, interval: half_open_utc}
  knowledge_time: {start: source_available_at, end: known_to, interval: half_open_utc}
  requires_known_at: true
  asof_predicate_template: "valid_from <= :as_of_valid_date AND (:as_of_valid_date < valid_to OR valid_to IS NULL) AND source_available_at <= :known_at AND (:known_at < known_to OR known_to IS NULL)"
validation: {fail_on_missing_pit_fields: true, fail_on_duplicate_logical_key: true, fail_on_naive_timestamp: true}
caveats:
  - security_id is the only stable join key; never join on a symbol string in PIT mode
```

```yaml
contract_version: 1
dataset_name: symbol_alias_bt
grain: one row per security_id per symbol per validity interval per knowledge interval
pit_mode: required
logical_keys: [security_id, symbol, symbol_kind, valid_from, source_version]
allowed_nulls: [valid_to, known_to]
required_columns:
  security_id: int64
  symbol: string
  symbol_kind: string                       # ticker | cusip | isin | occ_root
  valid_from: date
  valid_to: date                            # nullable; NULL = open
  source: string
  source_version: string
  source_available_at: timestamp_utc
  known_to: timestamp_utc_nullable
  ingested_at: timestamp_utc
  lake_published_at: timestamp_utc
pit:
  valid_time: {start: valid_from, end: valid_to, interval: half_open_utc}
  knowledge_time: {start: source_available_at, end: known_to, interval: half_open_utc}
  requires_known_at: true
  asof_predicate_template: "valid_from <= :as_of_valid_date AND (:as_of_valid_date < valid_to OR valid_to IS NULL) AND source_available_at <= :known_at AND (:known_at < known_to OR known_to IS NULL)"
validation: {fail_on_missing_pit_fields: true, fail_on_duplicate_logical_key: true, fail_on_naive_timestamp: true}
caveats:
  - Critical lookahead trap; resolve a symbol to security_id at `as_of_valid_date`, never via today's ticker
```

```yaml
contract_version: 1
dataset_name: universe_membership_bt
grain: one row per universe per security_id per validity interval per knowledge interval
pit_mode: required
logical_keys: [universe_id, security_id, valid_from, source_version]
allowed_nulls: [valid_to, known_to]
required_columns:
  universe_id: string
  security_id: int64
  valid_from: date
  valid_to: date                            # nullable; NULL = open
  source: string
  source_version: string
  source_available_at: timestamp_utc
  known_to: timestamp_utc_nullable
  ingested_at: timestamp_utc
  lake_published_at: timestamp_utc
pit:
  valid_time: {start: valid_from, end: valid_to, interval: half_open_utc}
  knowledge_time: {start: source_available_at, end: known_to, interval: half_open_utc}
  requires_known_at: true
  asof_predicate_template: "valid_from <= :as_of_valid_date AND (:as_of_valid_date < valid_to OR valid_to IS NULL) AND source_available_at <= :known_at AND (:known_at < known_to OR known_to IS NULL)"
validation: {fail_on_missing_pit_fields: true, fail_on_duplicate_logical_key: true, fail_on_naive_timestamp: true}
caveats:
  - Membership must be reconstructed historically; current-constituent joins reintroduce survivorship bias
```

```yaml
contract_version: 1
dataset_name: corporate_action_bt
grain: one row per security_id per action per ex_date per source_version
pit_mode: required
logical_keys: [security_id, action_type, ex_date, source_version]
allowed_nulls: [record_date, pay_date, known_to]
required_columns:
  security_id: int64
  action_type: string                       # split | cash_dividend | special_dividend | spinoff | merger
  declared_date: date
  ex_date: date
  record_date: date                         # nullable
  pay_date: date                            # nullable
  ratio_or_amount: float64
  source: string
  source_version: string
  source_available_at: timestamp_utc        # announcement availability, NOT ex_date
  known_to: timestamp_utc_nullable
  ingested_at: timestamp_utc
  lake_published_at: timestamp_utc
pit:
  valid_time: {at: ex_date, semantics: point_in_time}   # instantaneous validity; NOT an interval
  knowledge_time: {start: source_available_at, end: known_to, interval: half_open_utc}
  requires_known_at: true
  asof_predicate_template: "source_available_at <= :known_at AND (:known_at < known_to OR known_to IS NULL)"
validation: {fail_on_missing_pit_fields: true, fail_on_duplicate_logical_key: true, fail_on_naive_timestamp: true}
caveats:
  - An action is knowable only at/after its announcement availability, never at ex_date
```

```yaml
contract_version: 1
dataset_name: equity_bar_1m
grain: one row per security_id per minute_start per source_version per adjustment_state
pit_mode: required
logical_keys: [security_id, minute_start, source, source_version, adjustment_state]
allowed_nulls: [known_to, vendor_correction_available_at]
required_columns:
  security_id: int64
  symbol_at_source: string
  minute_start: timestamp_utc
  bar_start_at: timestamp_utc
  bar_end_at: timestamp_utc
  open: float64
  high: float64
  low: float64
  close: float64
  volume: int64
  adjustment_state: string
  source: string
  source_version: string
  source_available_at: timestamp_utc        # fixture_only: exact intraday dissemination lag unverified
  known_to: timestamp_utc_nullable
  vendor_correction_available_at: timestamp_utc_nullable
  ingested_at: timestamp_utc
  lake_published_at: timestamp_utc
pit:
  valid_time: {start: bar_start_at, end: bar_end_at, interval: half_open_utc}
  knowledge_time: {start: source_available_at, end: known_to, interval: half_open_utc}
  requires_known_at: true
  asof_predicate_template: "source_available_at <= :known_at AND (:known_at < known_to OR known_to IS NULL)"
validation: {fail_on_missing_pit_fields: true, fail_on_duplicate_logical_key: true, fail_on_naive_timestamp: true}
caveats:
  - Intraday source_available_at is fixture_only until vendor minute-bar dissemination timing is verified
```

```yaml
contract_version: 1
dataset_name: fundamental_fact_bt
grain: one row per cik per fact_name per fiscal_period_end per period_start per accession
pit_mode: required
logical_keys: [cik, fact_name, fiscal_period_end, period_start, accession]   # period_start (QD4) so a 10-Q's 3-month and YTD same-period-end/accession facts do not collide
allowed_nulls: [period_start, statement, fiscal_period, publicly_disseminated_at, known_to]
required_columns:
  cik: string
  fact_name: string                         # qdb output `concept` = storage `fact_name`
  fiscal_period_end: date                    # qdb output `period_end` = storage `fiscal_period_end`
  period_start: date                         # QD4/QD5: period length disambiguator; null for instantaneous/balance-sheet facts; nullability is declared only by allowed_nulls
  statement: string_nullable                 # QD5: statement classification (e.g. income_statement); nullable until SEC map verified
  fiscal_period: string_nullable             # QD5: e.g. Q1 | FY; nullable until SEC map verified
  value: float64
  unit: string
  accession: string
  accepted_at: timestamp_utc                # SEC acceptance timestamp; not sufficient for live PIT by itself
  publicly_disseminated_at: timestamp_utc_nullable   # fixture_only: exact after-hours rule unverified
  source: string
  source_version: string
  source_available_at: timestamp_utc        # derived from accepted/public availability policy; fixture may use accepted_at only under fixture policy
  known_to: timestamp_utc_nullable
  ingested_at: timestamp_utc
  lake_published_at: timestamp_utc
pit:
  valid_time: {at: fiscal_period_end, semantics: point_in_time}   # instantaneous validity; NOT an interval
  knowledge_time: {start: source_available_at, end: known_to, interval: half_open_utc}
  requires_known_at: true
  asof_predicate_template: "source_available_at <= :known_at AND (:known_at < known_to OR known_to IS NULL)"
validation: {fail_on_missing_pit_fields: true, fail_on_duplicate_logical_key: true, fail_on_naive_timestamp: true}
caveats:
  - fiscal_period_end alone never authorizes a fact; source_available_at from the accepted/public availability policy gates visibility
  - Amended facts supersede prior ones through the knowledge interval, with accession lineage
  - qdb output mapping (QD5): output `concept` = storage `fact_name`, output `period_end` = storage `fiscal_period_end`; `period_start`, `statement`, and `fiscal_period` are the same storage columns, surfaced directly. These columns are part of the contract; the qdb output schema MUST match it (no output field lacks a storage column)
  - XBRL dimensional facts are disabled or quarantined until context/dimension semantics are modeled. If enabled later, `fundamental_fact_bt` must distinguish consolidated facts from segment/dimensional facts with `xbrl_context_id`, `dimensions_json`, and `is_consolidated_or_dimensioned` or equivalent fields.
```

```yaml
contract_version: 1
dataset_name: macro_observation_vintage
grain: one row per series_id per observation_date per vintage interval
pit_mode: required
logical_keys: [series_id, observation_date, realtime_start, source_version]
allowed_nulls: [value, realtime_end, release_available_at, known_to]
required_columns:
  series_id: string
  observation_date: date
  value: float64                            # nullable when a vintage reports a gap
  realtime_start: date                      # vendor vintage interval start, not the query knowledge clock
  realtime_end: date                        # vendor vintage interval end; NULL = open vintage
  release_available_at: timestamp_utc_nullable   # future: exact release timestamp when verified
  source: string
  source_version: string
  source_available_at: timestamp_utc        # conservative end-of-day of realtime_start unless exact release_available_at is verified
  known_to: timestamp_utc_nullable          # derived from the next vintage's source_available_at; NULL = open knowledge interval
  ingested_at: timestamp_utc
  lake_published_at: timestamp_utc
pit:
  valid_time: {at: observation_date, semantics: point_in_time}   # instantaneous validity; NOT an interval
  knowledge_time: {start: source_available_at, end: known_to, interval: half_open_utc}
  requires_known_at: true
  asof_predicate_template: "source_available_at <= :known_at AND (:known_at < known_to OR known_to IS NULL)"
validation: {fail_on_missing_pit_fields: true, fail_on_duplicate_logical_key: true, fail_on_naive_timestamp: true}
caveats:
  - realtime_start/realtime_end preserve the vendor vintage interval; source_available_at/known_to are the trader-knowledge interval used by qdb
  - Date-only vintages use conservative end-of-day availability unless an exact release schedule is verified
```

```yaml
contract_version: 1
dataset_name: trading_calendar_bt
grain: one row per exchange per session_date per knowledge interval
pit_mode: required
logical_keys: [exchange, session_date, source_version]
allowed_nulls: [session_open_at, session_close_at, event_source_available_at, known_to]
required_columns:
  exchange: string                          # e.g. XNYS | XNAS | OPRA
  session_date: date
  is_trading_day: bool
  is_half_day: bool
  session_open_at: timestamp_utc_nullable   # NULL on a holiday/non-trading day
  session_close_at: timestamp_utc_nullable  # NULL on a holiday/non-trading day
  event_type: string                        # scheduled_open | scheduled_holiday | scheduled_half_day | unscheduled_closure | late_half_day_change
  event_source_available_at: timestamp_utc_nullable  # required for unscheduled closures and late half-day changes before live fill/resample
  source: string                            # hybrid ordered candidates: exchange_calendars first, pandas_market_calendars fallback (REQ-IFACE-05)
  source_version: string
  source_available_at: timestamp_utc
  known_to: timestamp_utc_nullable
  ingested_at: timestamp_utc
  lake_published_at: timestamp_utc
pit:
  valid_time: {at: session_date, semantics: point_in_time}   # instantaneous validity; NOT an interval
  knowledge_time: {start: source_available_at, end: known_to, interval: half_open_utc}
  requires_known_at: true
  asof_predicate_template: "source_available_at <= :known_at AND (:known_at < known_to OR known_to IS NULL)"
validation: {fail_on_missing_pit_fields: true, fail_on_duplicate_logical_key: true, fail_on_naive_timestamp: true}
caveats:
  - Bitemporal calendar; history never uses a current calendar, and resample_to_calendar binds to this dataset (REQ-IFACE-05)
  - The market-calendar source is a hybrid resolved under `REQ-AUTH-DEP-01`: `exchange_calendars` first, `pandas_market_calendars` fallback; package output is snapshotted/versioned into this CCC-owned dataset, and a package's current-calendar view is never historical truth by itself
  - Manual calendar overrides enter only as explicit, versioned, bitemporal correction rows with provenance (who/when/why/source), never as in-place edits (REQ-IFACE-05)
  - Calendar-derived fill/resample is disabled for unscheduled closures and late half-day changes until event source availability is modeled through `event_type` and `event_source_available_at`; add `test_calendar_unscheduled_closure_not_visible_before_event_source_available_at` and `test_calendar_late_half_day_change_not_visible_before_event_source_available_at` before any live calendar library can govern PIT fill.
```

```yaml
contract_version: 1
dataset_name: option_contract_bt
grain: one row per option_contract_key per terms validity interval per knowledge interval
pit_mode: required
logical_keys: [option_contract_key, valid_from, source_version]
allowed_nulls: [valid_to, known_to]
required_columns:
  option_contract_key: string               # canonical internal key: f"SID{underlying_security_id}-{expiry:%Y%m%d}-{option_type}-{strike_decimal:.3f}-{multiplier}"
  option_display_key: string                # display/vendor key: f"{root}-{expiry:%Y%m%d}-{option_type}-{strike_decimal:.3f}-{multiplier}"
  underlying_security_id: int64
  root: string                              # vendor/display root symbol used by the display key
  expiry: date
  option_type: string                       # C | P
  strike: float64                           # stored display/sort value ONLY. BOTH keys derive from a Decimal parsed from the raw vendor strike string at ingest (Decimal(raw_strike_text)), rendered via f"{d:.3f}", and stored once as option_contract_key/option_display_key — never Decimal(this float64), and never re-derived downstream (joins use the stored string key). Source strikes are assumed <= 3 decimal places (OCC mills); a strike with more precision is a contract violation, not silently rounded.
  multiplier: int64
  deliverable_description: string           # fixture_only: adjusted-deliverable text unverified
  valid_from: date                          # listing/terms-effective date
  valid_to: date                            # nullable; NULL = open
  source: string
  source_version: string
  source_available_at: timestamp_utc
  known_to: timestamp_utc_nullable
  ingested_at: timestamp_utc
  lake_published_at: timestamp_utc
pit:
  valid_time: {start: valid_from, end: valid_to, interval: half_open_utc}
  knowledge_time: {start: source_available_at, end: known_to, interval: half_open_utc}
  requires_known_at: true
  asof_predicate_template: "valid_from <= :as_of_valid_date AND (:as_of_valid_date < valid_to OR valid_to IS NULL) AND source_available_at <= :known_at AND (:known_at < known_to OR known_to IS NULL)"
validation: {fail_on_missing_pit_fields: true, fail_on_duplicate_logical_key: true, fail_on_naive_timestamp: true}
caveats:
  - Options dataset is gated; qdb access raises DatasetNotPublishedError until the Phase 1B sample is published
  - Two keys derive from a Decimal strike (never a binary float): the Decimal is parsed from the raw vendor strike string at ingest (never reconstructed from the stored float64), the key is computed once and persisted as option_contract_key (canonical SID-based) for all canonical joins and option_display_key (vendor/root) for lineage/diagnostics, and downstream consumers join the stored string key rather than re-deriving it
  - Acceptance test `test_decimal_strike_key_rejects_float_derivation_and_computed_once`: any float64-derived Decimal, including a `Decimal(str(float_val))` round-trip, is rejected as a valid derivation source; the `option_contract_key` strike component is computed ONCE at ingest from `Decimal(raw_strike_text)` and stored, never recomputed downstream
  - Contract terms are bitemporal; post-split adjusted deliverables change terms with their own knowledge interval, never via silent key mutation
```

```yaml
contract_version: 1
dataset_name: option_eod_quote
grain: one row per option_contract_key per session_date per knowledge interval
pit_mode: required
logical_keys: [option_contract_key, session_date, source_version]
allowed_nulls: [bid, ask, last, premium, volume, open_interest, implied_vol, quote_available_at, open_interest_available_at, known_to]
required_columns:
  option_contract_key: string               # FK-by-value to option_contract_bt.option_contract_key
  underlying_security_id: int64
  session_date: date
  bid: float64                              # nullable; NULL = no quote captured
  ask: float64                              # nullable
  last: float64                             # nullable
  premium: float64                          # settlement/mark premium; nullable; RETAINED at every value
  volume: int64                             # nullable
  open_interest: int64                      # nullable; OI is published with a lag vs quotes
  implied_vol: float64                      # vendor-provided only, under REQ-OPT-IV-01 with full provenance; locally computed IV lives in derived datasets, never this column
  quote_available_at: timestamp_utc_nullable          # fixture_only: exact quote-availability timing unverified
  open_interest_available_at: timestamp_utc_nullable  # fixture_only: OI availability lags the session; timing unverified
  source: string
  source_version: string
  source_available_at: timestamp_utc        # conservative session-close availability until vendor timing verified
  known_to: timestamp_utc_nullable
  ingested_at: timestamp_utc
  lake_published_at: timestamp_utc
pit:
  valid_time: {at: session_date, semantics: point_in_time}   # instantaneous validity; NOT an interval
  knowledge_time: {start: source_available_at, end: known_to, interval: half_open_utc}
  requires_known_at: true
  asof_predicate_template: "source_available_at <= :known_at AND (:known_at < known_to OR known_to IS NULL)"
field_availability:
  open_interest: "open_interest_available_at <= :known_at"
qdb_behavior:
  - If row-level `source_available_at <= known_at` but `open_interest_available_at > known_at` or is null, `open_interest` is masked to null and lineage records `field_masked: open_interest_pending_availability`, unless the caller explicitly requires OI, in which case the query refuses with `FieldAvailabilityError`.
  - If field-level masking is not implemented, split OI into `option_eod_open_interest` before enabling options qdb output.
  - Acceptance test `test_option_oi_masked_to_null_or_refuses_when_unavailable`: when `open_interest_available_at > known_at`, `open_interest` is masked to null with the `field_masked: open_interest_pending_availability` lineage tag, or the call raises `FieldAvailabilityError`; a stale or T+1 value is never returned. This is a `qdb`-layer field-availability concern distinct from `test_open_interest_treated_as_t_plus_one` (`REQ-CONTRACT-TRAPS`), which covers the transform-layer rule that post-close OI files carry stale/zero values at ingest; passing one does not satisfy the other.
validation: {fail_on_missing_pit_fields: true, fail_on_duplicate_logical_key: true, fail_on_naive_timestamp: true}
caveats:
  - Dataset is gated; qdb access raises DatasetNotPublishedError until the Phase 1B sample is published
  - Every raw quote is retained at all premium, moneyness, and liquidity levels; premium/liquidity/moneyness filtering happens only in derived gold marts with lineage back to this table
  - open_interest_available_at is later than quote availability; both timings are fixture_only until vendor evidence is verified
```

```yaml
contract_version: 1
dataset_name: source_batch
grain: one row per ingested source batch (kernel mirror; metadata, no PIT semantics)
pit_mode: not_applicable
logical_keys: [source_batch_id]
allowed_nulls: [source_time_min, source_time_max, source_available_min, source_available_max]
required_columns:
  source_batch_id: string
  batch_id: string
  provider: string
  source_dataset: string
  source_version: string
  source_availability_policy_ids: list_string
  adapter_version: string
  raw_paths: list_string                   # structured list of staged raw object paths, not a stringified JSON blob
  input_sha256: json                        # structured object mapping full raw path -> sha256, not basename-only and not stringified JSON
  source_time_min: timestamp_utc_nullable
  source_time_max: timestamp_utc_nullable
  source_available_min: timestamp_utc_nullable
  source_available_max: timestamp_utc_nullable
  row_count: int64
  file_count: int64
  ingested_at: timestamp_utc
pit:
  requires_known_at: false
  interval: not_applicable
  asof_predicate_template: not_applicable
validation: {fail_on_missing_pit_fields: false, fail_on_duplicate_logical_key: true, fail_on_naive_timestamp: true}
caveats:
  - Mirrors the kernel source_batch ledger row; this contract describes the published projection, not a PIT-queryable dataset
  - source_availability_policy_ids bind the batch to the policy evidence used by later manifests; source_available_* bounds are ledger metadata only, and per-row availability lives in the dataset tables, not here
```

```yaml
contract_version: 1
dataset_name: publish_manifest
grain: one row per publish manifest metadata projection; mirrors the kernel publish_manifest DDL plus the explicit dataset projection from batch_state, no PIT semantics
pit_mode: not_applicable
logical_keys: [manifest_id]
allowed_nulls: [valid_time_min, valid_time_max, source_available_min, source_available_max, adjustment_policy, caveats]
required_columns:
  manifest_id: string
  batch_id: string
  dataset: string                            # projection from batch_state.dataset for contract/query readability; not a physical publish_manifest DDL column
  source_batch_ids: list_string
  validation_artifact_id: string
  ducklake_snapshot_id: string
  lake_root_id: string
  output_tables: list_string
  file_inventory: json                       # structured manifest-v3 inventory array/object, not a stringified JSON blob; may be empty only when file_inventory_mode = inlined
  file_inventory_mode: string                # files | inlined | mixed (representation, NOT a restore strategy)
  file_inventory_source: string              # always qdb_lake.maintenance.list_snapshot_files (see maintenance API)
  inlined_row_count: int64                   # NOT NULL, default 0 (kernel DDL); > 0 only when inlined data exists (after verified flush/checkpoint)
  code_version: string
  environment_lock: string
  contract_version: int64
  row_count: int64
  valid_time_min: timestamp_utc_nullable
  valid_time_max: timestamp_utc_nullable
  source_available_min: timestamp_utc_nullable
  source_available_max: timestamp_utc_nullable
  pit_policy: string
  adjustment_policy: string_nullable
  caveats: json_nullable
  manifest_sha256: string
  created_at: timestamp_utc
pit:
  requires_known_at: false
  interval: not_applicable
  asof_predicate_template: not_applicable
validation: {fail_on_missing_pit_fields: false, fail_on_duplicate_logical_key: true, fail_on_naive_timestamp: true, fail_if_projection_mapping_missing: true}
caveats:
  - Mirrors the kernel publish_manifest DDL fields and adds only the explicit dataset projection from batch_state; any implementation that omits a kernel DDL field from this contract must rename the dataset to publish_manifest_projection and provide a field mapping instead of claiming a mirror
  - This dataset-contract projection is not the sealed `manifest_version: 3` artifact schema; `manifest_sha256` is a detached kernel/projection fact and MUST NOT be embedded in the sealed manifest bytes that it hashes
  - file_inventory_source records which wrapper produced the file list, not a raw DuckLake function name
  - file_inventory_mode is a representation (files|inlined|mixed), distinct from backup_marker.restore_mode (the copied_root_scratch|same_root_smoke strategy); backup/restore/cleanup lifecycle joins from backup_marker/cleanup_eligibility by manifest_id and is never embedded in the sealed manifest
  - file_inventory is captured for restore-with-files as structured manifest-v3 inventory; it is operational metadata, never financial knowledge time
```

```yaml
contract_version: 1
dataset_name: dataset_contract
grain: one row per (dataset_name, contract_version) (registry of the contracts themselves; metadata, no PIT semantics)
pit_mode: not_applicable
logical_keys: [dataset_name, contract_version]
allowed_nulls: []
required_columns:
  dataset_name: string
  contract_version: int64
  pit_mode: string                          # required | reference | not_applicable
  requires_known_at: bool
  asof_predicate_template: string           # the literal template string, or the literal "not_applicable"
  logical_keys: string                      # JSON array of the dataset's logical key columns
  contract_path: string                     # repo-relative path to the contract YAML
  created_at: timestamp_utc
pit:
  requires_known_at: false
  interval: not_applicable
  asof_predicate_template: not_applicable
validation: {fail_on_missing_pit_fields: false, fail_on_duplicate_logical_key: true, fail_on_naive_timestamp: true}
caveats:
  - This is the contract-of-contracts; the asof_predicate_template column here stores each dataset's predicate string and is distinct from this row's own (not_applicable) PIT semantics
  - requires_known_at and pit_mode are mirrored from each dataset's contract so the access layer can refuse known_at-less queries without parsing every YAML at call time
```

## Backtest-Integrity Transform Rules (`REQ-CONTRACT-TRAPS`)

The deep history is powerful but will silently corrupt a backtest unless these are encoded as rules where data is transformed, not left as prose. Each is a MUST at the transform layer.

- **Near-close is not official-close.** HistoricalOptionData snapshots a few minutes before the bell; Cboe is the official close. Pairing a 15:45 option quote with a 16:00 underlying corrupts IV and greeks and manufactures fake put-call-parity arbitrage. Tag every row's snapshot convention and pair each option quote with the same-snapshot underlying.
- **AM versus PM settlement.** Standard SPX settles on the morning print; SPXW settles on the afternoon close. Carry a settlement-style tag so an expiration fill is never simulated at a price that never existed.
- **Open interest is next-day (T+1).** The clearinghouse finalizes open interest the next morning, so post-close files carry stale or zero values; never treat it as same-session.
- **Symbology breaks.** The SPXW root appeared around 2010, and Cboe changed its field and timezone format on 2019-10-01 (CST→EST); normalize both at the transform layer.
- **Massive timestamp-unit ambiguity.** The raw flat-file timestamp unit is ambiguous and the vendor docs are not self-consistent; detect the unit from a sample at ingest, assert it, keep the raw CSV archived, and never hard-code the epoch scale.
- **Historical-to-forward overlap.** Training on HistoricalOptionData and trading forward on Massive requires an overlap window that normalizes zero-bid handling, volatility/greek models, and yield curves across the seam, or live results drift from the backtest. Governed by `REQ-SPLICE-01` and the `historical_forward_splice_calibration.v1` artifact: a seam without a calibrated record refuses or requires an explicit flag, never silently blends.
- **1990s cleaning pass.** The deep SPX tail can carry missing strikes, stale prints, and zero bids; budget a cleaning pass rather than assuming it is pristine.
- **Mac storage at OPRA scale.** Minute-level options data runs to several terabytes; keep durable Parquet on the NAS partitioned by capture date and manage DuckDB spill so large joins do not burn the laptop SSD.

Acceptance tests: `test_option_quote_pairs_same_snapshot_underlying`, `test_am_pm_settlement_tag_drives_expiration_fill`, `test_open_interest_treated_as_t_plus_one`, and `test_massive_timestamp_unit_detected_from_sample_not_hardcoded`.

## Owner-Local Tests Ported

9. `test_all_minimum_contracts_carry_asof_predicate_template` — every contract in the minimum set defines `asof_predicate_template`; it is a real half-open predicate wherever `pit_mode: required` and `not_applicable` only where `pit_mode: not_applicable`.

- `test_fixture_build_is_idempotent_and_does_not_mutate_committed_raw`
- `test_empty_bars_frame_has_typed_nonnull_ohlcv_columns`
- `test_get_bars_symbols_range_spanning_rename_refuses`
- `test_fundamentals_output_nullability_inherits_contract_allowed_nulls`
- `test_fundamentals_cik_only_fixture_without_security_mapping_cannot_emit_invented_security_id`
- `test_acme_security_identity_fixture_required_for_bars_symbol_selector`

- `test_dataframe_validator_fallback_records_degraded_state_not_equivalent_completion`

### Contracts, Adapters, Maintenance

35. `test_validation_rejects_missing_required_column`, `test_validation_rejects_unexpected_column_when_strict`, `test_validation_rejects_duplicate_logical_key`, `test_validation_rejects_broken_pit_interval`.
36. `test_manifest_contains_source_hashes_and_snapshot` and `test_rebuild_sample_manifest_is_deterministic`.
37. `test_source_adapter_plan_mode_no_mutation`, `test_source_adapter_idempotent_same_batch`, `test_source_adapter_raw_archive_is_immutable`.
38. `test_sec_rate_limiter_enforces_policy`: the adapter throttles and sends a compliant user-agent, tested with a mocked HTTP layer (never the live SEC API).
39. `test_ducklake_flush_inlined_data_reports_rows`, `test_ducklake_snapshot_expiry_dry_run`, `test_ducklake_cleanup_old_files_dry_run_first`, `test_retained_snapshot_still_queries_after_maintenance`, `test_cleanup_respects_backup_retention_gap`.

## v7.2.3 current-row, watermark, and projection amendments

AMD-014 makes Kernel DDL authoritative for `ingestion_watermark` and `dataset_sync_state`: exact keys, foreign keys, lineage fields, monotonic defense, and replay semantics must match [[PRJ-AI-CCC-DuckLake-v7.2.3-Publish-Control-Kernel]]. YAML cannot create a competing table or historical checksum meaning.

The selected registry model is current-row everywhere: `dataset_registry` has primary key `dataset`; `registry_version` is monotonically increasing on that row; normal visibility reads the current row only; schemas, examples, migration `MIG-REGISTRY-CURRENT-ROW-v1`, and BTI tests use the same grain. [[REF-AI-DuckLake-v7.2.3-CurrentRowRegistryAddendum]] maps each owner and is mandatory reconciliation, not a pause. A partial or mixed-grain change refuses.

AMD-019 clarifies `publish_manifest` projections: `dataset` projects from `batch_state.dataset`; `file_inventory_source` projects from sealed manifest output. No duplicate Kernel column is created.

## v7.2.3 r2 restored indexed acceptance criteria

- `test_watermark_sync_monotonic_replay_is_idempotent`: replaying the same or older successful watermark cannot move sync state backward, create a second effective transition, or change the published result.
- `test_publish_manifest_projection_sources_are_exact`: every projected publish-manifest field comes from its named kernel or sealed-manifest source, and no projection silently creates a competing source of truth.
- `test_registry_schema_example_and_migration_share_current_row_grain`: the dataset-registry contract, example, and migration all use one current row per `dataset` with version stored as a monotonic attribute rather than part of the primary key.
