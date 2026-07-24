---
type: prj
domain: ccc
status: active
date_created: 2026-06-28
date_modified: 2026-07-11
version: 7.2.3
---

# CCC DuckLake v7.2.3 QDB Agent Access And SQL Zero

Every postponed retrieval, modeling-interface, calendar, or runtime-shape item in this module follows DD-014, DD-015, DD-023, and DD-024 in [[PRJ-AI-CCC-DuckLake-v7.2.3-Deferred-Decision-Registry]]. Until the matching decision is proven, `qdb` refuses, masks, or omits the affected surface instead of exposing a placeholder as trusted data.

This module is the canonical v7.2.3 owner for the typed `qdb` agent access layer and SQL-zero posture. It is a semantic-preserving structural port from v6.5.0; arbitrary raw SQL remains absent in Phase 0/1, and every access path stays typed, lineage-bearing, and fail-closed.

## Module Boundary

**Owns:** `qdb` SDK/API, typed APIs, agent access boundary, shared conventions, output frame schemas, return objects, options boundary, retrieval access deferral, worked examples, safe/unsafe calls, SQL-zero posture, API errors, and query-safety tests.

**Depends On:** [[PRJ-AI-CCC-DuckLake-v7.2.3-Dataset-Contracts-And-Validation]] for canonical schemas and `allowed_nulls`; [[PRJ-AI-CCC-DuckLake-v7.2.3-PIT-And-Bitemporal-Policy]] for as-of rules; [[PRJ-AI-CCC-DuckLake-v7.2.3-Manifests-Lineage-And-Fixtures]] for lineage artifacts; [[PRJ-AI-CCC-DuckLake-v7.2.3-Provider-Capability-And-Availability]] for source policy status.

**Read After:** [[PRJ-AI-CCC-DuckLake-v7.2.3-Dataset-Contracts-And-Validation]], [[PRJ-AI-CCC-DuckLake-v7.2.3-PIT-And-Bitemporal-Policy]], and [[PRJ-AI-CCC-DuckLake-v7.2.3-Manifests-Lineage-And-Fixtures]].

**Non-Authoritative Restatements:** this module may define output schemas, projections, API return objects, and mapping behavior, but it does not redefine canonical dataset schemas. Provider/source policy status is consumed here for refusals; live-adapter enablement remains owned by [[PRJ-AI-CCC-DuckLake-v7.2.3-Provider-Capability-And-Availability]].

**Source Ranges Ported:** PRD 1559-1573, 1743-1746, 2778-3148, 3503, 3521, 3548-3549, 3612-3620 where `qdb`-facing, and 3695-3700.

## Requirements

### Retrieval Access Deferral (`REQ-RETR`)

- `REQ-RETR-01`: Retrieval is deferred behind `QDB_ENABLE_RETRIEVAL`, absent from core verification, and gated until Phase 1 structured/PIT proofs pass and a labeled eval slice exists.
- `REQ-RETR-02`: The first retrieval store, if enabled, MUST be LanceDB. The retrieval embedding model is a deferred selection with no Phase 0 or Phase 1 consequence: retrieval declares no required embedding dependency, and nothing in core `task verify` references one. When retrieval is later enabled, the embedding model is chosen at that time and recorded with an explicit full-corpus rebuild policy — changing the model invalidates every stored vector and requires a complete re-embed before eval gates are re-run. No alignment to a vault BGE-M3 invariant is required.
- `REQ-RETR-03`: Retrieval MUST prefilter candidates by `document_available_at <= known_at` before vector/BM25 scoring, preserve identifier/timing metadata, include lexical/full-text plus metadata filters, and pass labeled hit-rate/MRR/citation tests before corpus expansion.
- `REQ-RETR-04`: Qdrant is a later escalation only if LanceDB fails documented eval gates or service-mode features become necessary.


## Phase 2 Retrieval Deferred

Retrieval is not a blocker for the structured lake and is absent from core verification. When enabled behind a feature flag, it starts with a bounded SEC/news corpus, a deferred-selection embedding model (see `REQ-RETR-02`), LanceDB, metadata filters, BM25/full-text, dense search, reranking, and a labeled eval set.

| Retrieval item | Required behavior |
|---|---|
| Corpus slice | A bounded slice (for example current S&P 500), not the full SEC universe first. |
| Metadata | `chunk_id`, `accession`, `cik`, `security_id`, `ticker_at_filing_time`, `form_type`, `accepted_at`, `filed_at`, `document_available_at`, `period_end`, `section`, `source_path`, `text_hash`, `embedding_model`, `embedding_version`, `chunk_version`. |
| Availability prefilter | Documents/chunks are filtered by `document_available_at <= known_at` before vector/BM25 candidate generation, not after top-k. |
| Eval | Labeled queries with hit-rate@k, MRR, latency, citation quality, and failure examples before corpus expansion. |
| Escalation | Qdrant only if LanceDB fails a documented retrieval-quality or operational threshold. |

Table: Retrieval remains a measured auxiliary lane with an availability prefilter invariant.

### Why SQL-Zero — The Predecessor's Retrofit Failure

The archive-frozen predecessor (`CCC_lab`) deferred this boundary and paid for it: 654 raw-SQL entry points accumulated before a safety retrofit was attempted; the automated conversion failed at a 37% rate (127 unresolvable placeholders plus silent semantic errors) and all 70 converted files were fully reverted (`CCC_lab docs/development/sql_conversion_roadmap.md:17-22`, verified 2026-07-05). The lesson is economic, not stylistic: a deferred access boundary becomes practically irreversible at scale. `qdb` therefore starts SQL-zero — the boundary is cheapest on day one and only gets more expensive. This paragraph is rationale only; the binding rules are `REQ-QDB-01` and `REQ-QDB-03` below.

### `qdb` SDK And Agent Tool Layer (`REQ-QDB`)

- `REQ-QDB-01`: `qdb` MUST be the default access layer; agents MUST NOT get arbitrary raw SQL over the DuckLake namespace or Parquet paths in the first release.
- `REQ-QDB-02` (`REQ-QDB-CORE`): Phase 0/1 `qdb` MUST expose typed core functions for at least `describe_dataset`, `get_bars_asof`, `get_fundamentals_asof`, `get_macro_vintage`, `get_universe_asof`, and `explain_query`, and those core calls MUST NOT depend on the options dataset. `get_option_chain_asof` is options-dependent (`REQ-QDB-OPT`): in Phase 0/1 it MUST be present and MUST raise `DatasetNotPublishedError` until the Phase 1B options companion sample is published, and options work MUST NOT create a false red gate on the core (D18).
- `REQ-QDB-03` (`REQ-SQL-ZERO-V1`): No general `run_readonly_sql` exists in Phase 0/1. If a restricted SQL surface is introduced later, it MUST be a named profile restricted to contract-generated PIT-safe views or table-valued functions, with DuckDB runtime hardening (external access disabled; `ATTACH`, `COPY`, `INSTALL`, `LOAD`, `CALL`, unsafe `PRAGMA`, `read_parquet`, `read_csv`, HTTP/S3, and filesystem paths rejected), namespace allowlists, row/time/byte budgets, redaction, query-event logging, and explicit bypass tests. SQLGlot MAY inspect queries but MUST NOT be treated as a complete boundary (D19).

> [!important] Standing rule: any SQL surface addition upgrades the hardening battery to non-conditional (C-004)
> The `test_sql_gateway_*` hardening battery listed under Query Safety And Lineage is written today as "if any SQL surface exists." That conditional status ends the instant it stops being hypothetical: if ANY SQL surface is ever added — named profile, restricted view/TVF gateway, or otherwise — the full `test_sql_gateway_*` battery (`test_sql_gateway_rejects_write_statement`, `test_sql_gateway_rejects_raw_schema_by_default`, `test_sql_gateway_rejects_external_file_access`, `test_sql_gateway_requires_partition_filter_for_declared_large_dataset`, `test_sql_gateway_enforces_row_limit`, `test_sql_gateway_enforces_timeout`, `test_sql_gateway_blocks_direct_pit_table_access`) becomes NON-conditional and MUST be wired into `task verify` in the same change that adds the surface — not deferred to a follow-up PR. A SQL surface that ships without its hardening battery wired into `task verify` is itself a `REQ-SQL-ZERO-V1` violation, regardless of D19's SQLGlot caveat.
- `REQ-QDB-04`: Every `qdb` response MUST return a versioned `QdbResult` wrapping the dataframe and a versioned `QdbLineage v1` object (schema version, source tables, source batches, snapshot, manifest, source-availability policy, filters, `known_at`, adjustment policy, max input availability, row count, caveats); lineage MUST NOT be free text (D20).
- `REQ-QDB-05`: `qdb` MUST raise defined, testable errors (for example missing/naive `known_at`, missing adjustment policy, unsafe SQL, query-budget exceeded) and MUST log query metadata without leaking secrets or raw payloads. The defined refusals here are property-tested with `hypothesis` per `REQ-PIT-TEST`, but the errors are raised and enforced by custom `qdb` code, not by the test generator.
- `REQ-QDB-06`: `qdb` MUST provide a contract-discovery surface so agents can inspect allowed datasets without seeing every raw table, and MUST keep a default fail-closed posture with an explicit non-PIT research mode if any non-PIT query is permitted. The discovery surface is pinned (FBL2-24): `list_datasets() -> list[str]` returns the registered, `qdb`-visible dataset names, and `describe_dataset(name)` returns the per-dataset contract metadata.
- `REQ-QDB-07`: `get_fundamentals_asof` MUST accept `symbols=` alongside `security_ids`/`ciks`, MUST require exactly one selector family per call, and MUST resolve `symbol → security_id → cik` through the bitemporal `symbol_alias_bt` identity tables on BOTH clocks deterministically: knowledge-time is bounded by `known_at` (never an alias mapping not yet known at `known_at`), and valid-time is resolved as of each returned fact's own valid date — its `fiscal_period_end`, falling back to the query `period_end` when a fact has no bounded period. If no alias row is both valid and known under those clocks, the call MUST refuse (it MUST NOT resolve to a different entity). History that spans a symbol change MUST be queried via `security_ids=`/`ciks=`. The resolution MUST be recorded in lineage. This PIT-safe resolver MUST be built once and shared; `get_fundamentals_asof(symbols=...)` and the modeling-interface `resolve_entities_asof(...)` are two callers of the same primitive (`REQ-IFACE-11`).

> [!important] Fundamentals symbol resolution rule
> `get_fundamentals_asof` resolves symbols with valid-time as of each returned fact's own `fiscal_period_end`, falling back to the query `period_end` when the fact lacks a bounded period; knowledge-time remains bounded by `known_at`; ambiguity refuses instead of cross-mapping. No `as_of_valid_date` parameter is added.

- `REQ-QDB-ERRORS`: Key `qdb` refusal and warning messages are part of the contract; tests assert substrings, not whole messages, across the defined refusal/error/warning payload classes. `MissingKnownAtError` MUST contain "This query is PIT-relevant and requires `known_at`. No implicit now() is allowed."; `NaiveDatetimeError` MUST contain "Datetime arguments must be timezone-aware. Naive datetimes are refused."; `MissingAdjustmentPolicyError` MUST contain "Price data requires `adjustment_policy`. Choose one of: raw, point_in_time_split_adjusted, point_in_time_total_return, ex_post_adjusted_research_only."; `DatasetNotPublishedError` MUST contain "Dataset exists but has no published manifest visible to `qdb`."; `QueryBudgetExceededError` MUST contain "Result exceeds the configured row/time/byte budget. Narrow the identifiers, date range, or row limit."; `UnsafeSqlError` MUST contain "This query is outside the SQL-zero allowlist and was refused before execution."; `NonPitResearchModeRequiredError` MUST contain "ex_post_adjusted_research_only requires non_pit_research_mode=True. PIT workflows never receive ex-post adjusted output implicitly."; `FieldAvailabilityError` MUST contain "This field is not yet available at known_at under its declared source-availability policy."; `CoverageCaveatWarning` MUST contain "Result is inside declared coverage but carries an unresolved-identifier or partial-coverage caveat; see QdbResult.warnings."; `ProductionPathRefusedError` MUST contain "This call targets a path or DSN classified as production; refused — the dual-gated live escape is not engaged.". `qdbctl diagnose <one target flag> --format text\|json` MUST render the existing `failed_run_diagnosis` schema — what failed, what is visible to `qdb`, which batch/cleanup/backup/restore/Dagu/query target is affected, whether a snapshot committed, a manifest sealed, or a backup was created, whether restore is required, whether retry is safe, and the exact next command; JSON is the artifact, text is the operator view. `test_qdb_error_substrings_match_contract` MUST assert the pinned substring for all ten named payload classes (`MissingKnownAtError`, `NaiveDatetimeError`, `MissingAdjustmentPolicyError`, `DatasetNotPublishedError`, `QueryBudgetExceededError`, `UnsafeSqlError`, `NonPitResearchModeRequiredError`, `FieldAvailabilityError`, `CoverageCaveatWarning`, `ProductionPathRefusedError`), not only the original five. The `ProductionPathRefusedError` pinned sentence is emitted by the class's `__str__`, which PREPENDS it to per-site diagnostic detail — the classifier raise-sites keep their short f-string suffixes (FBL2-02; see the governing listing in [[PRJ-AI-CCC-DuckLake-v7.2.3-Ops-Recovery-Maintenance-Security]]). `CoverageCaveatWarning` is a warning payload, not an exception; it is delivered by appending its pinned sentence to `QdbResult.warnings` and is never raised (FBL2-24).

### Introspection Catalog And Result Metadata (v7.2.3)

- `REQ-QDB-08`: `qdb` MUST expose `list_query_functions(resource: Optional[Literal["bars", "fundamentals", "macro", "universe", "options"]] = None) -> list[QueryFunctionDescription]`, derived by reflection over the typed API signatures (`inspect.signature`), never hand-maintained and never constructing SQL. `QueryFunctionDescription` carries `name`, `parameters` (each `{name, type, required, default}`), `returns`, and applicable gates. Because it is pure reflection over the existing callables, the catalog cannot drift from the surface it describes. Backed by `test_list_query_functions_is_derived_by_introspection_not_hand_maintained`.
- `REQ-QDB-09`: every `QdbResult` MUST carry `query_metadata: QueryMetadataV1` with `execution_time_ms: float`, `cache_hit: bool`, `row_count: int`, and optional `pagination`. `pagination` is reserved for a future explicit pagination API and remains `None` in Phase 0/1 because over-budget reads fail closed with `QueryBudgetExceededError` rather than returning silent truncation with `has_more`. `query_metadata.row_count` is an envelope convenience; on any conflict, `QdbLineageV1.row_count` is authoritative (same precedence pattern as `allowed_nulls` in QD13). Backed by `test_query_metadata_row_count_matches_lineage_row_count_or_lineage_wins`.
- `REQ-QDB-10`: `list_query_functions` MAY filter by resource family (`bars`, `fundamentals`, `macro`, `universe`, `options`); this is an optional filter over the one calling convention (QD1), never a second object hierarchy or client class.
- `REQ-QDB-11`: guard tests MUST enforce two structural bans under `src/qdb/`: no f-string or string-concatenation SQL construction anywhere, and no dead parameters (every declared parameter is read in the function body). Both bans encode verified predecessor defects — an f-string `LIMIT` splice and a dead `timeout_seconds` parameter in its template query engine. Backed by `test_qdb_module_bans_fstring_sql_construction` and `test_qdb_function_signature_has_no_dead_unread_parameters`.

## `qdb` API Seed, Typed APIs First

The first implementation prefers explicit typed functions over a SQL gateway. Arbitrary SQL is deferred; if any SQL exists it is restricted to contract-generated PIT-safe views/TVFs. Every function returns a result object wrapping a dataframe plus structured lineage.

| Function | Required gates | Required lineage |
|---|---|---|
| `describe_dataset(name)` | Dataset in contract registry | Contract version, caveats, safe query examples. |
| `get_bars_asof(*, start, end, known_at, symbols/security_ids, adjustment_policy, frequency, columns, row_limit)` | `known_at` and `adjustment_policy` required; ex-post adjusted rejected in PIT mode | Snapshot, source, adjustment policy + action cutoff, row count, symbol resolution. |
| `get_option_chain_asof(*, underlying, known_at, expiry, as_of_valid_date, option_type, row_limit)` | Present stub that raises `DatasetNotPublishedError` until Phase 1B; when enabled, `known_at` required, separate quote/OI availability, filter policy explicit | Contract mapping, source, filter policy, coverage caveats, and source-availability policy ID. |
| `get_fundamentals_asof(*, concepts, known_at, security_ids/ciks/symbols, period_start, period_end, statement, columns, row_limit)` | `known_at` required; exactly one selector family (`security_ids` \| `ciks` \| `symbols`); accession/acceptance lineage required; `symbols` resolved via the shared PIT-safe resolver | SEC/vendor source, accepted times, accession, amendment status, symbol resolution. |
| `get_macro_vintage(*, series_ids, known_at, observation_start, observation_end, row_limit)` | `known_at` required; conservative release policy | Vintage fields, source series, release caveats. |
| `get_universe_asof(*, universe, known_at, as_of_valid_date, row_limit)` | `known_at` required; bitemporal membership; delisted survive | Universe version, alias resolution. |
| `explain_query(...)` | Same allowlist/safety gates | Plan/profile metadata with no secret/config leakage. |

Table: Seed `qdb` typed function contract. `run_readonly_sql` is intentionally absent from the first-release default surface.

The result object and errors are explicit: a `QdbResult` wrapping the dataframe and a versioned `QdbLineage v1` object (schema version, source tables, source batches, snapshot, manifest, source-availability policy, filters, `known_at`, adjustment policy, max input availability, row count, caveats), with defined errors such as missing/naive `known_at`, missing adjustment policy, unsafe SQL, dataset not published, and query-budget exceeded.

Required refusal, error, and warning payload classes or equivalents: `MissingKnownAtError`, `NaiveDatetimeError`, `DatasetNotPublishedError`, `MissingAdjustmentPolicyError`, `UnsafeSqlError`, `QueryBudgetExceededError`, `CoverageCaveatWarning`, `FieldAvailabilityError`, `NonPitResearchModeRequiredError`, and `ProductionPathRefusedError`. `CoverageCaveatWarning` is the warning payload class used for `QdbResult.warnings`, not an exception. The exact refusal and warning substrings these classes MUST contain are part of the contract and are specified in `REQ-QDB-ERRORS`; tests assert substrings, not whole messages, and `qdbctl diagnose <one target flag> --format text\|json` renders the operator-readable diagnosis over the `failed_run_diagnosis` schema (JSON is the artifact, text is for Ryan).

### qdb Function Contracts (`REQ-QDB-CORE`)

The Phase 0/1 access surface is exactly these six query/explain functions plus the discovery helpers `describe_dataset` and `list_datasets() -> list[str]` (FBL2-24): `get_bars_asof`, `get_fundamentals_asof`, `get_macro_vintage`, `get_universe_asof`, `explain_query`, and gated `get_option_chain_asof`. There is no generic SQL entry point. Every function is keyword-only past its first argument, returns a `QdbResult` (or a small description object), and obeys the shared conventions below. Exact Polars dtype spellings for output frames are a verification item (`VERIFY-QDB-DTYPES`); the schema tables use the neutral dtype tokens already used by the dataset contracts.

#### Shared conventions (apply to every function)

- Knowledge-time is mandatory. `known_at` is required on every `get_*` call; omitting it raises `MissingKnownAtError`. There is no implicit "now" default — a missing clock fails closed.
- Timezone rule. Every datetime argument MUST be tz-aware. A naive datetime raises `NaiveDatetimeError` and is never silently assumed to be UTC. A tz-aware datetime in any other zone is normalized to UTC instant-preserving (lossless); only the ambiguous naive case is refused.
- Empty result is a valid answer, not an error. A query matching zero rows returns a `QdbResult` whose `.data` is an empty frame carrying the full declared schema and whose `.lineage` is fully populated (`row_count = 0`, resolved `manifest_id` / `ducklake_snapshot_id`, bound filters). Only structural failures raise (see error classes).
- Deterministic order. Each function documents a total sort order so notebook output is reproducible across runs.
- No silent truncation. If a result would exceed the effective row limit, the wall-clock budget (`QDB_DEFAULT_QUERY_TIMEOUT_SECONDS`), or the byte budget (`QDB_DEFAULT_BYTE_LIMIT`), the call raises `QueryBudgetExceededError`; it never returns a quietly clipped frame. `QDB_DEFAULT_ROW_LIMIT` is a hard ceiling, not a default (FBL2-16): the effective row limit is `min(row_limit, QDB_DEFAULT_ROW_LIMIT)`, so a caller-supplied `row_limit` never exceeds the environment ceiling, and the `row_limit: int = 1_000_000` signature default is caller-side convenience only. The row budget is enforced with an explicit `LIMIT effective_limit + 1` over-fetch probe, the time budget by the DuckDB statement timeout, and the byte budget by the in-memory Arrow size of the over-fetched result, never a Parquet-compressed size (FBL2-24).
- Adjustment intent is explicit for prices. `get_bars_asof` has no default `adjustment_policy`; omitting it raises `MissingAdjustmentPolicyError` so corporate-action handling is never implicit.
- Non-PIT adjusted research requires an explicit acknowledgement. If `adjustment_policy == "ex_post_adjusted_research_only"` and `non_pit_research_mode` is not explicitly `True`, `get_bars_asof` raises `NonPitResearchModeRequiredError`; ex-post adjusted output is never returned from an ordinary PIT workflow.
- Total-return dividend gating uses announcement availability, never ex_date/pay_date alone (`PA-13`). `adjustment_policy == "point_in_time_total_return"` folds each dividend into the as-of series only once that dividend's own `source_available_at` (its announcement/declaration availability) is `<= known_at`; `ex_date` and `pay_date` are valid-time facts about the dividend, not knowledge-time gates, and neither one alone authorizes including the dividend in a PIT total-return computation. Backed by `test_total_return_dividend_gated_on_announcement_availability_not_ex_date`: constructs a dividend whose `ex_date`/`pay_date` precede `known_at` but whose `source_available_at` (announcement) postdates it, and asserts `point_in_time_total_return` excludes that dividend until its own announcement availability clears `known_at`.
- Entity selectors are mutually exclusive. Every entity-selecting `qdb` call accepts exactly one selector family per call (`symbols`, `security_ids`, `ciks`, `underlying`, or future equivalents as applicable); supplying none or multiple selector families refuses rather than guessing precedence.
- Gated datasets refuse. If `describe_dataset(...).published` is `False`, the matching `get_*_asof` raises `DatasetNotPublishedError`. `get_option_chain_asof` raises `DatasetNotPublishedError` throughout Phase 0 and Phase 1A.
- Empty is not the same as unknown or uncovered (`QD8`). A zero-row result distinguishes three cases: a true PIT-empty window (rows exist for the identifier but none satisfy `known_at`), an unresolved identifier (a requested symbol/`security_id` resolves to nothing), and outside-coverage (the identifier resolves but the query window lies outside the dataset's published coverage). The `QdbResult.warnings` list carries an `unresolved_identifiers` entry naming each requested identifier that resolved to nothing, and the lineage carries `coverage_status` (`covered` \| `outside_coverage` \| `unknown`) and `coverage_window`. A mistyped symbol therefore surfaces a warning rather than a silent "no data." Backed by `test_unknown_identifier_warns_not_silent` and `test_empty_result_outside_coverage_returns_coverage_caveat_or_refusal`.
- Lineage and caveats are themselves as-of filtered (`QD9`). `QdbLineageV1.caveats` and any coverage caveat MUST NOT reveal a future correction, a future `known_to` close, or a future-availability coverage note before its own `source_available_at <= known_at`; operational metadata (snapshot id, manifest id, row count) is labeled operational and is exempt, while financial as-of facts obey the same half-open gate as the data. `QdbResult.caveats` is the response-level projection of as-of-filtered `QdbLineageV1.caveats` plus any response-scope caveats that obey the same time filter; it MUST NOT contradict lineage or expose a second caveat authority. Backed by `test_future_correction_not_revealed_in_lineage_before_correction_available_at` and `test_lineage_caveats_are_asof_filtered_or_labeled_operational`.
- Investigate-status datasets are not PIT-queryable (`QD10`). A live dataset whose source-availability policy is `status: investigate` fails closed: the matching `get_*_asof` refuses (`DatasetNotPublishedError` or a coverage refusal) even if its rows carry placeholder `source_available_at` clocks, unless the dataset is explicitly `fixture_only`/non-PIT and says so. A synthetic/conservative clock on an investigate-status policy never makes it queryable. Backed by `test_qdb_refuses_live_dataset_with_investigate_availability_policy`.
- `allowed_nulls` is the sole nullability authority (`QD13`). Output-frame nullability follows each dataset contract's `allowed_nulls` array; the `_nullable` dtype suffixes in `dtypes.py` are non-authoritative readability hints mapped to the base Polars dtype during schema construction (Polars columns are natively nullable), never a second nullability source. Where a `_nullable` hint and `allowed_nulls` disagree, `allowed_nulls` governs.

```python
 # src/qdb/api.py — typed, SQL-zero access layer (Phase 0/1 surface)
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, date
from typing import Any, Literal, Optional, Sequence

import polars as pl  # exact output dtype spellings are a verification item; see VERIFY-QDB-DTYPES

AdjustmentPolicy = Literal["raw", "point_in_time_split_adjusted", "point_in_time_total_return", "ex_post_adjusted_research_only"]
PitMode = Literal["required", "reference", "not_applicable"]

_UNSET: Any = object()  # sentinel so a missing adjustment_policy raises a domain error, not TypeError


@dataclass(frozen=True)
class QdbLineageV1:
    lineage_schema_version: int
    dataset: str
    manifest_id: str
    ducklake_snapshot_id: str
    source_tables: list[str]        # canonical dataset tables that produced the result, e.g. ['silver.equity_bar_1d']
    source_batches: list[str]       # contributing published batch ids, e.g. ['sb_synthfix_equity_1d_2015']
    source_availability_policy_ids: list[str]
    known_at: datetime
    filters: dict[str, Any]
    adjustment_policy: Optional[str]
    max_input_availability: Optional[datetime]
    row_count: int
    caveats: list[str]
    # Coverage signals (QD8): distinguish PIT-empty from unresolved-identifier from outside-coverage.
    # caveats here are as-of filtered (QD9); operational metadata above is exempt.
    coverage_status: str = "covered"          # covered | outside_coverage | unknown
    coverage_window: Optional[dict[str, Any]] = None


@dataclass(frozen=True)
class QueryMetadataV1:
    execution_time_ms: float
    cache_hit: bool
    row_count: int
    pagination: Optional[dict[str, Any]] = None  # Phase 0/1: reserved for future explicit pagination; over-budget reads fail closed.


@dataclass(frozen=True)
class QueryFunctionDescription:
    name: str
    parameters: list[dict[str, Any]]
    returns: str
    applicable_gates: list[str]


@dataclass(frozen=True)
class QdbResult:
    data: pl.DataFrame
    lineage: QdbLineageV1
    query_metadata: QueryMetadataV1
    caveats: list[str]
    budgets: dict[str, Any]
    warnings: list[str]


@dataclass(frozen=True)
class DatasetDescription:
    dataset: str
    contract_version: int
    pit_mode: PitMode
    requires_known_at: bool
    asof_predicate_template: str
    logical_keys: list[str]
    columns: dict[str, str]            # column -> neutral dtype token
    allowed_nulls: list[str]           # copied from the registered contract; sole nullability authority
    published: bool                    # False -> get_*_asof raises DatasetNotPublishedError
    phase: Optional[str]               # e.g. "phase1b" for a not-yet-published gated dataset
    unpublished_reason: Optional[str]  # exact reason surfaced when published is False, mirrored into the matching get_*_asof refusal
    coverage_start: Optional[date]
    coverage_end: Optional[date]
    caveats: list[str]


@dataclass(frozen=True)
class QdbExplanation:
    dataset: str
    known_at: datetime
    asof_predicate: str                # the bound half-open predicate that WOULD execute
    bound_parameters: dict[str, Any]
    estimated_partitions: Optional[int]
    would_refuse: Optional[str]        # error-class name if the call would fail closed, else None


def list_query_functions(
    resource: Optional[Literal["bars", "fundamentals", "macro", "universe", "options"]] = None,
) -> list[QueryFunctionDescription]:
    """Return descriptions derived by reflecting over typed API signatures; never hand-maintained."""


def describe_dataset(dataset: str) -> DatasetDescription:
    """Return registered contract metadata, including `allowed_nulls` copied from the registered contract. Never raises for an unpublished dataset;
    `published=False` is how the caller learns get_*_asof would refuse."""


def get_bars_asof(
    *,
    start: date,
    end: date,
    known_at: datetime,
    symbols: Optional[Sequence[str]] = None,
    security_ids: Optional[Sequence[int]] = None,
    adjustment_policy: AdjustmentPolicy = _UNSET,   # required in practice; _UNSET -> MissingAdjustmentPolicyError
    non_pit_research_mode: bool = False,
    frequency: Literal["1d", "1m"] = "1d",
    columns: Optional[Sequence[str]] = None,
    row_limit: int = 1_000_000,
) -> QdbResult:
    """Equity bars as-of `known_at`. Resolve symbols to security_id internally; never
    join on a symbol string. Sort: (security_id, bar_start_at)."""


def get_fundamentals_asof(
    *,
    concepts: Sequence[str],
    known_at: datetime,
    security_ids: Optional[Sequence[int]] = None,
    ciks: Optional[Sequence[str]] = None,
    symbols: Optional[Sequence[str]] = None,
    period_start: Optional[date] = None,
    period_end: Optional[date] = None,
    statement: Optional[str] = None,
    columns: Optional[Sequence[str]] = None,
    row_limit: int = 1_000_000,
) -> QdbResult:
    """SEC fundamentals as-of `known_at`, gated on `source_available_at` derived from
    the accepted/public availability policy, not the filing/period date. Pass exactly one selector family:
    `security_ids`, `ciks`, or `symbols`; `symbols` resolve through the shared PIT-safe
    resolver (symbol -> security_id -> cik via symbol_alias_bt as of the valid date and
    `known_at`). Output `security_id` is a required projection from the PIT-safe
    CIK/security mapping; unresolved or ambiguous mapping refuses or reports unresolved
    coverage rather than inventing an ID. The resolution is recorded in lineage.
    Sort: (security_id, concept, period_end, period_start)."""


def get_macro_vintage(
    *,
    series_ids: list[str],
    known_at: datetime,
    observation_start: Optional[date] = None,
    observation_end: Optional[date] = None,
    row_limit: int = 1_000_000,
) -> QdbResult:
    """FRED/ALFRED vintage as-of `known_at`, preserving realtime intervals for lineage
    while gating visibility through source_available_at/known_to. Returns the values that
    were knowable at `known_at`, not latest revisions. Sort: (observation_date)."""


def get_universe_asof(
    *,
    universe: str,
    known_at: datetime,
    as_of_valid_date: Optional[date] = None,
    row_limit: int = 1_000_000,
) -> QdbResult:
    """Universe membership as-of `known_at` (knowledge clock) and `as_of_valid_date`
    (valid clock; defaults to the known_at date). Sort: (security_id)."""


def explain_query(
    *,
    dataset: str,
    known_at: datetime,
    predicate_only: bool = True,
    **selectors: Any,
) -> QdbExplanation:
    """Bind and return the half-open predicate that WOULD run, without executing it.
    `would_refuse` names the error class if the call would fail closed."""


def get_option_chain_asof(
    *,
    underlying: str,
    known_at: datetime,
    expiry: Optional[date] = None,
    as_of_valid_date: Optional[date] = None,
    option_type: Optional[Literal["C", "P"]] = None,
    row_limit: int = 1_000_000,
) -> QdbResult:
    """Option chain as-of. Raises DatasetNotPublishedError in Phase 0 and Phase 1A.
    When published: the `underlying` string MUST resolve to `underlying_security_id`
    via the shared PIT-safe resolver (`symbol_alias_bt`) as of `as_of_valid_date` and
    `known_at`, never a today's-ticker join; the resolution is recorded in lineage.
    Retains all premium/moneyness levels. Sort: (expiry, strike, option_type)."""
```

> [!important] One calling convention (`QD1`)
> The typed contract block above (`src/qdb/api.py`) is the single, authoritative call form for every `qdb` function. Every function is keyword-only past `self`/`*`, with `get_bars_asof` taking `start`/`end`/`known_at` (no positional symbol, no `asof_date`) and `get_universe_asof` taking `universe`/`known_at`/`as_of_valid_date` (no `asof_date`). No positional-symbol or `asof_date` form exists anywhere; any worked example, safe/unsafe row, or lineage `filters` dict mirrors the keyword-only signature. The named RED tests (`test_backfill_amnesia_prevention`, `test_get_bars_symbols_range_spanning_rename_refuses`, and the rest) compile against this one signature.

> [!important] Copyable API drift guard
> The `src/qdb/api.py` block above MUST stay aligned with `REQ-QDB-08..11`: `QueryMetadataV1`, `QueryFunctionDescription`, `QdbResult.query_metadata`, and `list_query_functions(resource=None)` are part of the copyable seed, not prose-only requirements. Backed by `test_qdb_code_block_matches_req_qdb_08_11`.

> [!important] Symbol→`security_id` valid-date resolution on bars (`QD3`)
> `get_bars_asof(symbols=…)` resolves each symbol to `security_id` per the bar's own `session_date` (the valid date), not once at `known_at`, and the resolution is bounded by `known_at` through `symbol_alias_bt` exactly as fundamentals resolve per `fiscal_period_end`. A `symbols=` range that spans an alias change (for example a FB→META rename inside `[start, end]`) MUST refuse with a resolution-ambiguity error rather than silently mis-map early sessions to the later identity or return a silent empty frame; callers query a spanning rename via `security_ids=`. `test_get_bars_symbols_range_spanning_rename_refuses` (Phase 0 blocking) seeds both a synthetic ticker reused across two `security_id`s and a same-`security_id` alias-change range, asserts that `symbols=` refuses when the requested valid-date interval crosses the ambiguity, and asserts that `security_ids=` remains the explicit escape hatch for spanning history. The option-underlying resolver (`QD2`) cannot leak in Phase 0 because `get_option_chain_asof` raises `DatasetNotPublishedError` until Phase 1B; `test_option_underlying_symbol_change_refuses_or_resolves_pit` is Phase 1B-gated.

> [!important] Cross-instrument session-boundary joins must refuse or prove alignment (`PA-14`)
> A PIT join across instruments with mismatched session closes — for example pairing an index option chain (`get_option_chain_asof`) settled/snapshotted near the bell against an equity or index `get_bars_asof` official close — MUST either refuse the join or prove same-snapshot alignment before returning combined rows; it MUST NOT silently pair a pre-close option snapshot with a post-close official underlying print. This generalizes the Dataset-Contracts module's own near-close-is-not-official-close caveat (HistoricalOptionData snapshots a few minutes before the bell while Cboe is the official close; pairing a 15:45 option quote with a 16:00 underlying corrupts IV/greeks and manufactures fake put-call-parity arbitrage — see [[PRJ-AI-CCC-DuckLake-v7.2.3-Dataset-Contracts-And-Validation]]) from a single-dataset snapshot-tag rule into a cross-instrument `qdb` join-safety rule: any caller joining `get_option_chain_asof` output to `get_bars_asof` (or other instrument) output MUST carry and compare each side's snapshot-convention tag, and the join refuses when the tags do not prove the same snapshot. Backed by `test_cross_instrument_session_boundary_join_refused_or_alignment_proven`: constructs an option-chain row and an underlying-bar row with mismatched session-close/snapshot tags for the same nominal date, and asserts the cross-instrument join either raises rather than returning silently paired rows, or returns rows only when the snapshot tags are proven identical.

#### Output frame schemas

Each `get_*_asof` returns its rows in `QdbResult.data` with the columns below, in the documented sort order, using neutral dtype tokens (exact Polars spelling: `VERIFY-QDB-DTYPES`). Operational clocks (`known_to`, `ingested_at`, `lake_published_at`) are not surfaced in the row — the frame is already the as-of slice; they live in the contract and lineage. The one availability clock surfaced per row is `source_available_at`. Output posture is Polars-first end to end: `QdbResult.data` is a Polars frame, lazy/streaming consumption arrives through Arrow RecordBatch / Polars LazyFrame at the modeling interface (`REQ-IFACE-03`), pandas exists only as an explicit caller-side export/adapter conversion, and DuckDB relations stay an internal implementation detail rather than a returned surface.

Table: `get_bars_asof` output columns (sort: security_id, bar_start_at).

| column | dtype | nullable | notes |
|---|---|---|---|
| security_id | int64 | no | canonical join key; symbols resolved internally |
| symbol | string | no | primary symbol resolved as-of `known_at` |
| bar_start_at | timestamp_utc | no | valid-time start (half-open) |
| bar_end_at | timestamp_utc | no | valid-time end |
| open | float64 | no | OHLCV non-null per contract `allowed_nulls` (`QD6`); an empty frame still carries the typed column |
| high | float64 | no | |
| low | float64 | no | |
| close | float64 | no | |
| volume | int64 | no | |
| adjustment_policy | string | no | echoes the requested policy |
| source_available_at | timestamp_utc | no | availability clock that gated the row |

Table: `get_fundamentals_asof` output columns (sort: security_id, concept, period_end, period_start).

| column | dtype | nullable | notes |
|---|---|---|---|
| security_id | int64 | no | required qdb projection from PIT-safe CIK/security mapping; no single verified mapping means refusal or unresolved coverage, never a null or invented ID |
| cik | string | no | non-null under `fundamental_fact_bt.allowed_nulls`; fixture_only until SEC map verified |
| concept | string | no | |
| statement | string | yes | nullable because `fundamental_fact_bt.allowed_nulls` includes `statement` |
| period_start | date | yes | nullable because `fundamental_fact_bt.allowed_nulls` includes `period_start` |
| period_end | date | no | |
| fiscal_period | string | yes | nullable because `fundamental_fact_bt.allowed_nulls` includes `fiscal_period` |
| value | float64 | no | non-null under `fundamental_fact_bt.allowed_nulls` |
| unit | string | no | non-null under `fundamental_fact_bt.allowed_nulls` |
| accepted_at | timestamp_utc | no | SEC acceptance timestamp; live availability is governed by source_available_at policy |
| source_available_at | timestamp_utc | no | |

For Phase 0, `get_fundamentals_asof` output nullability inherits `fundamental_fact_bt.allowed_nulls`; `cik`, `value`, and `unit` are non-null unless the storage contract itself changes. The storage table is CIK/fact/accession keyed and does not store `security_id`, so output `security_id` is a required qdb projection through the PIT-safe `security_identity`/`symbol_alias_bt` mapping at the relevant valid date and `known_at`. If a `ciks=` or `symbols=` query cannot prove one CIK-to-security mapping for the returned fact, the call refuses or emits unresolved coverage according to `QD8`; it never emits a null `security_id` and never fabricates one.

Table: `get_macro_vintage` output columns (sort: observation_date).

| column | dtype | nullable | notes |
|---|---|---|---|
| series_id | string | no | |
| observation_date | date | no | |
| value | float64 | yes | NULL = vintage reports a gap |
| realtime_start | date | no | |
| realtime_end | date | yes | NULL = open vintage |
| source_available_at | timestamp_utc | no | conservative end-of-day until exact release verified |

Table: `get_universe_asof` output columns (sort: security_id).

| column | dtype | nullable | notes |
|---|---|---|---|
| security_id | int64 | no | |
| symbol | string | no | resolved as-of `known_at` |
| universe | string | no | |
| valid_from | date | no | |
| valid_to | date | yes | NULL = open |
| weight | float64 | yes | future: populated only when a weighted universe is verified |
| source_available_at | timestamp_utc | no | |

Table: `get_option_chain_asof` output columns when published (sort: expiry, strike, option_type); raises `DatasetNotPublishedError` in Phase 0/1A.

| column | dtype | nullable | notes |
|---|---|---|---|
| option_contract_key | string | no | |
| underlying_security_id | int64 | no | |
| expiry | date | no | |
| option_type | string | no | C \| P |
| strike | float64 | no | |
| bid | float64 | yes | |
| ask | float64 | yes | |
| last | float64 | yes | |
| premium | float64 | yes | every premium/moneyness level retained |
| volume | int64 | yes | |
| open_interest | int64 | yes | OI is published with a lag vs quotes |
| source_available_at | timestamp_utc | no | |

#### Return objects (non-frame)

`describe_dataset(dataset)` returns a `DatasetDescription` (never raises for an unpublished dataset; read `.published` to learn whether `get_*_asof` would refuse). `explain_query(dataset, known_at, **selectors)` returns a `QdbExplanation` carrying the bound half-open `asof_predicate` that would execute, the bound parameters, and `would_refuse` (the error-class name if the call would fail closed, else `None`) — it binds and inspects, it does not run the query.

#### Options dataset boundary

The options boundary is visible before any options table exists. In Phase 0 and Phase 1, `describe_dataset("option_eod_quote")` returns a `DatasetDescription` with `published = False`, `phase = "phase1b"`, and `unpublished_reason = "Dataset not published; options companion sample not enabled"`, plus caveats (quote/OI timing unverified, index-option coverage unverified, raw/silver retention required). `get_option_chain_asof(...)` raises `DatasetNotPublishedError` carrying that same reason, so an agent learns the boundary from `describe_dataset` without triggering a refusal. The options companion sample stays discoverable but inert until the Phase 1B dataset is published.

Options qdb access remains disabled until field-level quote/OI gating is implemented and tested or quote and OI are split into separate queryable paths. Backed by `test_option_chain_requires_field_availability_or_split_oi_path_before_publish`.

#### Worked examples

```python
from datetime import datetime, date, timezone

 # 1. Positive as-of read (synthetic fixture ACME, security_id 1001; bar available 2015-12-30T21:00:00Z).
res = get_bars_asof(
    security_ids=[1001],
    start=date(2015, 12, 30), end=date(2015, 12, 30),
    known_at=datetime(2015, 12, 31, 0, 0, tzinfo=timezone.utc),
    adjustment_policy="point_in_time_total_return",
)
 # res.data -> 1 row, close == 100.00
 # res.lineage.row_count == 1; res.lineage.known_at preserved; adjustment_policy == "point_in_time_total_return"

 # 2. Empty is a valid answer, not an error (known_at precedes source_available_at).
res = get_bars_asof(
    security_ids=[1001],
    start=date(2015, 12, 30), end=date(2015, 12, 30),
    known_at=datetime(2015, 12, 30, 12, 0, tzinfo=timezone.utc),  # before 21:00Z availability
    adjustment_policy="point_in_time_total_return",
)
 # res.data is EMPTY but carries the full bar schema
 # res.lineage.row_count == 0; manifest_id / ducklake_snapshot_id still resolved; no exception

 # 3. Adjustment intent must be explicit for prices.
get_bars_asof(
    security_ids=[1001],
    start=date(2015, 12, 30), end=date(2015, 12, 30),
    known_at=datetime(2015, 12, 31, tzinfo=timezone.utc),
)  # raises MissingAdjustmentPolicyError

 # 4. Naive datetimes are refused, never assumed UTC.
get_macro_vintage(
    series_ids=["TESTRATE"],
    known_at=datetime(2026, 1, 1, 0, 0),  # naive
)  # raises NaiveDatetimeError

 # 5. Gated dataset refuses in Phase 0/1A.
get_option_chain_asof(
    underlying="SPY",
    known_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
)  # raises DatasetNotPublishedError

 # 6. Inspect the bound predicate without executing it.
plan = explain_query(
    dataset="equity_bar_1d",
    known_at=datetime(2015, 12, 31, tzinfo=timezone.utc),
    security_ids=[1001],
)
 # plan.asof_predicate == "source_available_at <= :known_at AND (:known_at < known_to OR known_to IS NULL)"
 # plan.would_refuse is None
```

### Example Safe And Unsafe Calls

| Example | Expected result | Reason |
|---|---|---|
| `get_bars_asof(symbols=["SPY"], start="2020-01-01", end="2020-12-31", known_at="2020-12-31T23:59:59Z", adjustment_policy="raw")` | Allowed | Explicit UTC `known_at`, range, symbols, adjustment policy. |
| `get_bars_asof(symbols=["SPY"], start="2020-01-01", end="2020-12-31", adjustment_policy="raw")` | Rejected | Missing `known_at`. |
| `get_bars_asof(..., known_at="2026-06-07T00:00:00Z")` on a 2015 backfill ingested in 2026 | Returns historical data | Gated on `source_available_at`, not local publish time (no backfill amnesia). |
| `get_fundamentals_asof(symbols=["AAPL"], concepts=["Revenue"], known_at="2018-05-01T00:00:00Z")` | Allowed | Knowledge-time gate with accession lineage. |
| Arbitrary `run_readonly_sql("select * from raw.sec_companyfacts")` | Not available in Phase 0/1 | SQL-zero posture; no generic SQL surface exists (`REQ-SQL-ZERO-V1`). |
| `get_universe_asof(universe="sp500", as_of_valid_date="2014-06-30", known_at="2014-06-30T20:00:00Z")` joined via today's tickers | Rejected | Current-identifier join in PIT mode. |
| `get_fundamentals_asof(ciks=["0000320193"], concepts=["Revenue"], known_at="2014-06-30T20:00:00Z")` joined via today's CIK-to-security mapping instead of the PIT-safe resolver as of the valid date | Rejected | Current-identifier join in PIT mode; covered by `test_current_cik_join_rejected`. |
| `get_option_chain_asof(underlying="SPY", known_at="2026-01-01T00:00:00Z")` joined via today's option-root-to-underlying mapping instead of the PIT-safe resolver as of `as_of_valid_date` | Rejected | Current-identifier join in PIT mode; covered by `test_current_option_root_join_rejected`. |

Table: Example access behavior for the semantic safety layer.

The current-identifier join-refusal rule applies uniformly across every identifier family this module resolves through the shared PIT-safe resolver: ticker/symbol and universe membership (`test_current_symbol_join_rejected`, `test_current_universe_join_rejected` — both owned and enforced in [[PRJ-AI-CCC-DuckLake-v7.2.3-PIT-And-Bitemporal-Policy]]), and CIK and option-root (`test_current_cik_join_rejected`, `test_current_option_root_join_rejected` — owned here, exercising `get_fundamentals_asof(ciks=...)` and `get_option_chain_asof(underlying=...)` respectively). All four tests assert the same invariant: resolving an identifier via today's mapping instead of the mapping valid as of the query's own valid date and bounded by `known_at` MUST refuse rather than silently cross-map.

## v7.2.3 typed discovery and budget amendments

AMD-015a adds typed `list_datasets()` with deterministic ordering and copyable API drift coverage. AMD-015b implements the automatic current-row reconciliation: normal visibility returns only currently visible current-row datasets under the shared `dataset` primary-key and monotonic-version rule. Copied-catalog candidate visibility remains a distinct, jailed exception.

AMD-016 enforces row and Arrow-byte limits on returned typed results, runs each bounded call on a dedicated connection under an application deadline, permits interrupt only after pinned-build proof, returns no partial result, and closes or discards the connection unless safe reuse is proven. Row, byte, deadline, no-partial-return, and post-timeout-state tests are mandatory.

## Owner-Local Tests Ported

- `test_sql_surface_absent_in_phase0_phase1`

- `test_qdb_empty_result_returns_lineage_not_error` — a zero-match `get_*_asof` returns an empty full-schema frame with populated lineage and raises nothing.

- `test_get_fundamentals_asof_accepts_symbols_and_requires_one_selector_family`
- `test_qdb_error_substrings_match_contract` and `test_qdbctl_diagnose_renders_text_and_json`
- `test_current_cik_join_rejected` and `test_current_option_root_join_rejected` (current-identifier join-refusal rule, CIK and option-root; sibling tests `test_current_symbol_join_rejected`/`test_current_universe_join_rejected` are owned by [[PRJ-AI-CCC-DuckLake-v7.2.3-PIT-And-Bitemporal-Policy]])
- `test_total_return_dividend_gated_on_announcement_availability_not_ex_date` (`PA-13`)
- `test_cross_instrument_session_boundary_join_refused_or_alignment_proven` (`PA-14`)

Cross-referenced — owner: Modeling-Engine-Interface (REQ-IFACE); listed for context only, not double-counted:

- `test_panel_asof_enforces_source_available_at_le_known_at_per_cell`
- `test_panel_asof_respects_valid_time_and_known_time_intervals`
- `test_panel_asof_vectorized_grid_does_not_call_scalar_api_n_times`
- `test_lazy_panel_preserves_lineage_and_session_pin`
- `test_as_of_fill_does_not_cross_source_available_at`
- `test_resample_binds_to_bitemporal_trading_calendar`
- `test_trading_calendar_no_current_calendar_for_history`
- `test_get_coverage_exposes_gaps_quality_flags_without_filtering`
- `test_research_session_pin_is_immutable`

### Query Safety And Lineage

- `test_qdb_returns_lineage`: every successful call returns a structured lineage object with required keys, not free text.
- `test_lineage_schema_is_stable`: lineage conforms to a versioned schema.
- If any SQL surface exists: `test_sql_gateway_rejects_write_statement`, `test_sql_gateway_rejects_raw_schema_by_default`, `test_sql_gateway_rejects_external_file_access` (rejects `read_parquet`, `read_csv`, HTTP/S3, `COPY`, `EXPORT`, `INSTALL`, `LOAD`, `CALL`, unsafe `PRAGMA`), `test_sql_gateway_requires_partition_filter_for_declared_large_dataset`, `test_sql_gateway_enforces_row_limit`, `test_sql_gateway_enforces_timeout`, and `test_sql_gateway_blocks_direct_pit_table_access` (a `known_at` argument is necessary but not sufficient; access only through PIT-safe views/TVFs). Per the standing rule at `REQ-QDB-03` (C-004), "if any SQL surface exists" stops being conditional the moment a surface is added: this entire battery becomes NON-conditional and MUST be wired into `task verify` in the same change that introduces the surface.

## v7.2.3 r2 restored indexed acceptance criteria

- `test_list_datasets_signature_and_drift_guard`: `list_datasets` preserves the closed keyword-only signature and generated contract projection; signature or schema drift fails before a client receives ambiguous results.
- `test_normal_qdb_visibility_uses_current_row_only`: normal visibility returns only the one reconciled current row per dataset and never exposes copied-candidate, superseded, quarantined, or unpublished registry state.
- `test_qdb_row_budget_refuses_overfetch`: a query whose declared or observed row count exceeds the configured budget refuses without returning partial data.
- `test_qdb_arrow_byte_budget_refuses_overfetch`: Arrow output whose measured byte size exceeds the configured budget refuses and discards the result before exposure.
- `test_qdb_deadline_returns_no_partial_data`: crossing the query deadline produces the contracted timeout error and returns no partial rows, batches, or lineage presented as complete.
- `test_qdb_discards_or_proves_safe_connection_after_timeout`: after timeout, the connection is discarded unless an exact health and transaction-state probe proves it safe before reuse.
