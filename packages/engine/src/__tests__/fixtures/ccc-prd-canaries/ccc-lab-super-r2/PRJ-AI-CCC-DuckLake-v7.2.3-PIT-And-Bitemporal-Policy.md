---
type: prj
domain: ccc
status: active
date_created: 2026-06-28
date_modified: 2026-07-11
version: 7.2.3
---

# CCC DuckLake v7.2.3 PIT And Bitemporal Policy

Every postponed SEC, FRED, options-clock, or market-calendar fact in this module follows DD-006, DD-007, DD-008, and DD-023 in [[PRJ-AI-CCC-DuckLake-v7.2.3-Deferred-Decision-Registry]]. Missing timing evidence always selects the conservative clock, masking, refusal, or disabled path named by the entry; it never selects a more permissive timestamp.

This module is the v7.2.3 structural port of the v6.5.0 point-in-time and bitemporal policy. It preserves the four-clock invariant, fail-closed `known_at` behavior, dataset clock rules, source-availability semantics, price/corporate-action timing policy, leakage refusals, and owner-local tests without moving canonical schemas out of Dataset Contracts or API projections out of `qdb`.

## Owns

- PIT invariants, bitemporal invariants, clock semantics, fail-closed source-availability rules, and the financial meaning of `known_at`.
- Dataset clocks for equity/ETF bars, SEC fundamentals, FRED/ALFRED macro, Options EOD, and universe membership.
- Valid-time, knowledge-time, source-availability, ingest-time, and lake-publish-time separation.
- Price and corporate-action timing policy, including raw versus adjusted price refusal semantics and action-availability cutoffs.
- Requirement authority for `REQ-PIT-*`, `REQ-PIT-TEST`, and the PIT/time-policy portions of `REQ-PRICE-*`.

## Depends On

- [[260708-DuckLake-Quant-Stack-PRD-v7.2.3]] for root version routing and source-set control.
- [[PRJ-AI-CCC-DuckLake-v7.2.3-Dataset-Contracts-And-Validation]] for canonical table schemas, contract YAMLs, nullability, physical layout, and contract validation.
- [[PRJ-AI-CCC-DuckLake-v7.2.3-Provider-Capability-And-Availability]] for provider capability artifacts and source-availability policy objects.
- [[PRJ-AI-CCC-DuckLake-v7.2.3-QDB-Agent-Access-And-SQL-Zero]] for typed API enforcement, API-specific errors, and SQL-zero access rules.
- [[PRJ-AI-CCC-DuckLake-v7.2.3-Publish-Control-Kernel]] for commit-time transaction mechanics and state transitions.
- [[PRJ-AI-CCC-DuckLake-v7.2.3-Manifests-Lineage-And-Fixtures]] for adversarial PIT fixture specs and fixture inventory.

## Read After

- [[PRJ-AI-CCC-DuckLake-v7.2.3-Executive-Contract-And-Authority]]
- [[PRJ-AI-CCC-DuckLake-v7.2.3-Architecture-Context-And-Bootstrap]]

## Non-Authoritative Restatements

- Dataset Contracts owns canonical domain schemas and contract YAML bodies; this module owns the time semantics those contracts must encode.
- Provider owns provider-specific evidence and source-availability policy objects; this module owns the invariant that `source_available_at` or derived knowledge intervals gate `known_at`.
- `qdb` owns API signatures, output frames, and refusal classes; this module owns what those refusals mean for PIT correctness.
- Kernel owns lifecycle state and transactional close/insert mechanics; this module owns the bitemporal policy those mechanics must preserve.

## Source Port

| Source | Ported content |
|---|---|
| Primary PRD 980-1016 | Four-clock invariant, core PIT rules, half-open UTC intervals, fail-closed source-availability behavior, current-identifier refusal, adjusted-price leakage refusal, source correction policy, retrieval prefiltering, feature known-time policy, and dataset-specific clocks. |
| Primary PRD 1536-1558 | `REQ-PIT-*`, `REQ-PIT-TEST`, and `REQ-PRICE-*` requirement bullets. |
| Primary PRD 938-940 | Bitemporal supersession policy, linked back to Kernel for commit-time transaction mechanics. |
| Primary PRD 3630-3647 | PIT and leakage highest-risk acceptance tests. |

Table: v6.5.0 source ranges structurally ported into this module.

## Why Bitemporal — The Predecessor's Rejection, Answered

The predecessor platform (`CCC_lab`, archive-frozen and referenced only as historical evidence) explicitly rejected this design. Its architecture record states verbatim: "❌ REJECTED: Bitemporal pattern (sys_from, sys_to) with LEAD() window functions — 80% increase in schema complexity — Performance overhead from window functions — Unnecessary for solo trader (no 'what system knew at time T' queries)" (`CCC_lab docs/architecture/load_id_versioning.md:15-18`, verified 2026-07-05). That prediction failed in practice. The one-axis model it adopted collapsed catalog rebuilds, vendor corrections, and backfills onto a single system-side revision instant (`COALESCE(data_revision_at, created_at)`), making the three cases structurally indistinguishable — exactly the "what was knowable when" question a backtest asks the moment a vendor restates history. The complexity objection also inverted at retrofit time: correctness boundaries deferred at design time became practically irreversible later (see the SQL-zero rationale in [[PRJ-AI-CCC-DuckLake-v7.2.3-QDB-Agent-Access-And-SQL-Zero]]). This module's four-clock policy is the direct answer, and the adversarial fixture contracts below (mixed-availability supersession, same-instant supersession, backfill amnesia) each encode a discriminating case the one-axis model cannot represent. This section is rationale, not a requirement; the binding invariants follow.

## PIT And Bitemporal Invariants

> [!important] Four-clock invariant
> Every PIT-relevant row distinguishes four clocks and never substitutes one for another: `valid_at` or `valid_from`/`valid_to` is when the fact applied in the economic world; `source_available_at` is when a trader could first have known the fact from the source; `ingested_at` is when the local system acquired it; `lake_published_at` is when it passed validation and became queryable in this lake. Only `source_available_at` or a derived `known_from`/`known_to` interval may satisfy `known_at` in financial PIT queries. `lake_published_at` and DuckLake snapshot time are operational only.

The central defect this policy removes is timestamp overloading, especially using a local `published_at` or DuckLake snapshot time as the financial knowledge clock.

## Core Invariants

- PIT intervals are half-open and timezone-normalized to UTC: `known_from <= query_known_at < known_to`, and where relevant `valid_from <= query_valid_at < valid_to`.
- Interval semantics are explicit per field group. `interval: half_open_utc` applies to knowledge-time and to any valid-time declared as `{start, end}` with distinct endpoints. A valid-time that is a single instant or session-day must be declared `{at: <field>, semantics: point_in_time}` and is satisfied by equality at the as-of date; it is never subject to half-open empty-set logic.
- The contract validator must reject any `{start, end}` interval whose start field equals its end field. This rejection is field-name-level (a contract declaring the same column as both start and end), not value-level: rows whose start and end VALUES coincide belong in `point_in_time`-declared datasets, never as an equality carve-out inside half-open evaluation (FBL2-01).
- Missing `source_available_at` or `known_from` fails closed, unless the dataset contract explicitly marks the table non-PIT and the caller requests explicit non-PIT research mode.
- Plain `published_at` is avoided in PIT contracts. Use `source_available_at` or a dataset-specific source clock for knowledge time and `lake_published_at` for local visibility.
- Every dataset contract carries a machine-readable as-of predicate template, not just prose.
- SEC facts require `source_available_at <= :known_at`; ALFRED/FRED vintages preserve `realtime_start`/`realtime_end` for lineage but gate queries through `source_available_at <= :known_at`; bars require `source_available_at <= :known_at`.
- `qdb` rejects joins that resolve historical data through today's ticker, CIK, index membership, or option root. Delisted securities and old aliases stay queryable as of the historical date.
- `qdb` rejects ex-post adjusted prices in PIT backtest mode unless the caller explicitly requests non-PIT research output.
- PIT-adjusted prices reconstruct only from corporate actions whose declaration/availability time is `<= known_at`.
- Every source correction creates a new version with its own `source_available_at` and supersession interval. No silent overwrite of raw, silver, or gold PIT facts is allowed.
- Retrieval, when enabled, prefilters candidate documents or chunks by `document_available_at <= known_at` before vector or BM25 scoring.
- Feature `known_at`, when feature tables exist, equals the maximum source-availability time of all inputs; centered windows, full-sample normalization/winsorization/imputation, and future labels are rejected.

## Dataset-Specific Clocks

| Lane | Source clocks that gate `known_at` | Verification flag |
|---|---|---|
| Equity/ETF bars | `bar_end_at` plus `source_available_at` (close plus feed latency), `vendor_correction_available_at` | Daily bars not knowable before session close plus latency; minute bars not before bar end plus latency. |
| SEC fundamentals | `accepted_at` and a synthesized `publicly_disseminated_at`; `filed_at` is lineage only and never gates `known_at` (`test_sec_adapter_does_not_use_filed_at_as_availability_clock`) | Exact after-hours dissemination rule is verified before encoding. |
| FRED/ALFRED macro | `source_available_at` / derived `known_to`, with `realtime_start`/`realtime_end` preserved as vendor vintage lineage | Date-only vintages default to conservative end-of-day availability unless exact release times are modeled and verified. |
| Options EOD | `quote_available_at`, `open_interest_available_at`, contract-state `known_from`/`known_to` | Policy object exists now; exact quote/OI/session timing fixtures wait for OCC/OPRA/vendor evidence and verified calendars. |
| Universe membership | Bitemporal membership intervals | Built from historical constituents, never today's survivors. |

Table: Source-availability clocks per lane, with timing claims that must be verified before they become fixtures.

### What "EOD" Means

"EOD" is not one clock, and conflating its meanings is the same class of error as conflating `source_available_at` with `lake_published_at`. This PRD distinguishes at minimum: (a) exchange session close — the economic valid-time boundary (`bar_end_at` for bars); (b) vendor/provider file-dissemination availability — the per-provider `source_available_at` policy (for example `exchange_close_plus_dissemination_lag_requires_evidence`), which is the ONLY clock that may gate financial `known_at`; (c) the source-visible timestamp a vendor stamps inside its files or object store, which is provenance evidence feeding (b) but never automatically equal to it; and (d) local ingestion/system-observed time (`ingested_at`, `lake_published_at`), which never gates knowledge time. Any future `source_schedule__{source}` contract (`REQ-DAGU-SCHEDULE` in [[PRJ-AI-CCC-DuckLake-v7.2.3-Orchestration-And-QDBCTL]]) MUST name which of these clocks its trigger keys off and MUST NOT assume (a) and (b) coincide without provider evidence. An operational EOD job-trigger clock is a scheduling concern, distinct from the PIT knowledge clock even when both are colloquially called "EOD"; `task ops:clock-check` verifies host clock skew and says nothing about either.

## Bitemporal Supersession Policy

Every source correction creates a new row/version with its own `source_available_at` and supersession interval. Original and corrected facts must coexist under bitemporal rules; the original remains visible for `known_at` before correction availability, and the correction becomes visible only at or after its own availability. For vendor corrections or amendments, each superseded logical key closes at the replacement row's own `source_available_at` or derived `known_from`, not at a batch-wide timestamp. [[PRJ-AI-CCC-DuckLake-v7.2.3-Publish-Control-Kernel]] owns the same-transaction close/insert implementation that prevents fact blackout.

Backed by `test_vendor_correction_not_visible_before_correction_available_at`, `test_bitemporal_supersession_rollback_prevents_fact_blackout`, and `test_bitemporal_supersession_uses_replacement_row_source_available_at`.

Physical close mechanic (FBL2-21a): supersession is an in-place UPDATE of the superseded row's `known_to` only, plus an INSERT of the replacement row, in the same transaction. No other column of the superseded row changes, and no `is_current` flag exists anywhere in the schema; the no-silent-overwrite rule forbids value rewrites, not the `known_to` close itself.

Same-instant supersession and the empty interval (FBL2-12): if a replacement's `source_available_at` equals the superseded row's `known_from`, the superseded row closes to the empty interval `[T, T)` — legal, not a broken interval, and visible at no `known_at`. This case is reachable in fixture-core because FRED date-only vintages pin availability to next-UTC-day 00:00, so two same-day corrections collapse onto one instant. Two versions of one logical key with identical `known_from` and overlapping OPEN knowledge intervals remain a validation failure under `REQ-CONTRACT-04`. Backed by `test_same_instant_supersession_produces_empty_interval_not_validation_failure`.

Backfill amnesia acceptance criterion: after a backfill, every original row's `source_available_at` must remain unchanged, and a new version row must exist for the backfilled fact. Neither condition alone is sufficient; both must hold. The canonical test name is `test_backfill_preserves_original_source_available_at_and_adds_new_version`; the existing `test_backfill_amnesia_prevention` (see Owner-Local Leakage Tests Preserved) refers to the same requirement — one implementation, canonical name wins.

## Adversarial Fixture Contracts (normative)

The following tests are valid only if their fixtures contain the named discriminating case. Fixture data lives in [[PRJ-AI-CCC-DuckLake-v7.2.3-Manifests-Lineage-And-Fixtures]]; this module owns the acceptance criteria the fixtures must satisfy.

- Feature `known_at`: the fixture must contain `max(source_available_at) > max(valid_at)` (availability lagging validity — the leak-shaped case). Feature `known_at` must equal `max(source_available_at)` of all inputs, never `max(valid_at)`; full-sample normalization must be rejected. Both feature-`known_at` tests are gated `xfail(strict=True)` alongside the `REQ-IFACE` leakage tests until feature tables exist (FBL2-08); `test_feature_known_at_is_max_input_availability` (Verification, Future Guardrails) is the SAME requirement — canonical name `test_feature_known_at_equals_max_source_available_at_not_valid_at`, one implementation. The fixture spec is committed now at `tests/fixtures/feature_set/feature_availability.yaml`; its input rows are generic `(entity, valid_at, source_available_at)` facts, not rows of a published dataset. Backed by `test_feature_known_at_equals_max_source_available_at_not_valid_at` and `test_full_sample_zscore_rejected_in_pit_feature_build`.
- Session-day `point_in_time`: the fixture must contain a row with `{start=D, end=D}`. This row must be returned at equality under `point_in_time` semantics and never dropped by half-open interval logic. The fixture lives in a dedicated mini-contract `tests/fixtures/session_day/session_day_point_in_time.yaml` declaring `valid_time: {at: session_date, semantics: point_in_time}`; the test proves the point_in_time DECLARATION path and MUST NOT be implemented as an equality exception inside the shared half-open interval evaluator (FBL2-01). Backed by `test_session_day_valid_time_returned_at_equality_not_dropped_by_half_open`.
- Mixed-availability supersession: the fixture must contain one correction batch with at least two keys whose replacement `source_available_at` values differ. Each key must close at its own replacement `source_available_at`, never at the batch maximum. Backed by `test_mixed_availability_batch_closes_each_key_at_its_own_replacement_source_available_at`.
- UTC-instant comparison: the fixture must contain availability timestamps that straddle a DST shift and a UTC-midnight boundary. `known_at` comparison must operate at the instant level and must never be date-truncated. Backed by `test_availability_comparison_is_utc_instant_across_dst_and_midnight`.

Table: Discriminating fixture cases that gate the validity of the named tests; a test passing against a fixture lacking its named case does not satisfy this policy.

## Price And Corporate-Action Policy

- Raw price data must be stored separately from adjusted price data, and ingestion must not overwrite raw bars with adjusted bars.
- `qdb` price APIs must require an explicit adjustment policy where raw versus adjusted matters and must distinguish `raw`, `point_in_time_split_adjusted`, `point_in_time_total_return`, and `ex_post_adjusted_research_only`.
- If `adjustment_policy == "ex_post_adjusted_research_only"` and `non_pit_research_mode` is not explicitly `True`, `get_bars_asof` raises `NonPitResearchModeRequiredError`; ex-post adjusted output is never returned from an ordinary PIT workflow.
- PIT-adjusted prices must reconstruct only from corporate actions whose declaration/availability time is `<= known_at`; future actions must not affect PIT-adjusted output.
- Adjusted price results must include the corporate-action set version and maximum action-availability timestamp in lineage; ex-post adjusted output must be labeled non-PIT.
- PIT-adjusted live-source output is disabled until corporate-action factor-set lineage is implemented and verified. The factor-set artifact must record action IDs used, `max_action_source_available_at`, adjustment method, and source policy ID.
- When a corporate action's declaration time and availability time straddle `known_at`, PIT-adjusted reconstruction gates on the action's availability time, never its declaration time. Backed by `test_action_gated_on_availability_not_declaration_when_they_straddle_known_at`.

## Requirements

- `REQ-PIT-01`: Every PIT-relevant table must define the four clocks and must not substitute `lake_published_at` or DuckLake snapshot time for financial `known_at`.
- `REQ-PIT-02`: Every PIT-relevant `qdb` query must require an explicit, timezone-aware `known_at` and fail closed if it is missing or naive. A non-UTC aware `known_at` is normalized to UTC instant-preserving; only a naive datetime is refused.
- `REQ-PIT-03`: `known_at` must bind only to `source_available_at` or a derived `known_from`/`known_to` interval; PIT intervals must be half-open and UTC-normalized.
- `REQ-PIT-04`: Missing source-availability or `known_from` fields must fail closed unless the contract marks the table non-PIT and the caller requests explicit non-PIT mode.
- `REQ-PIT-05`: Market bars must gate availability on bar end plus declared source/feed latency and must model `vendor_correction_available_at` separately.
- `REQ-PIT-06`: SEC fundamentals must carry accession-level lineage and gate `known_at` on acceptance/public availability; fiscal period alone must not authorize a fact; amendments/restatements must be bitemporal.
- `REQ-PIT-07`: FRED/ALFRED must preserve `realtime_start`/`realtime_end` and enforce a conservative date-only release policy unless exact release times are modeled and verified.
- `REQ-PIT-08`: Symbol, CIK, option-root, and universe mappings must be bitemporal; current mappings must not be used implicitly for historical queries; delisted securities must survive historical universes.
- `REQ-PIT-09`: Every dataset contract must carry a machine-readable as-of predicate template.
- `REQ-PIT-10`: Feature tables, when introduced, must set feature `known_at` to the maximum input source-availability time and reject centered windows, full-sample normalization, and future labels.
- `REQ-PIT-11`: The repo must maintain a source/calendar registry that records, per source and dataset, the producer clock separately from the consume clock and binds each dataset to its governing trading/holiday calendar. `known_at` derives from consume-side `source_available_at`, never the producer clock alone. Fixture-core satisfaction (FBL2-21g): this registry requirement is met by the `source_availability_policies/*.yaml` objects (producer versus consume clocks per policy) joined to `trading_calendar_bt` through each policy's `dataset:` field; a dedicated registry artifact is a live-lane deliverable, not fixture-core scope.
- `REQ-PIT-12`: The silver layer must carry a date-aware PIT identity/cross-reference master linking vendor identifiers such as Sharadar permaticker, OCC/OSI option symbols, FIGI/CIK, option-root evolution, and delisting state. All links must be bitemporal.
- `REQ-PIT-TEST`: `hypothesis` is the default property-based test candidate for PIT and source-clock invariants and `qdb` refusal behavior. It only generates tests; the four-clock logic, `known_at`/`source_available_at` predicates, half-open interval rules, refusal strings, and lineage assertions remain custom and are the enforced authority.
- `REQ-PRICE-01`: Raw price data must be stored separately from adjusted price data, and no ingestion may overwrite raw bars with adjusted bars.
- `REQ-PRICE-02`: `qdb` price APIs must require an explicit adjustment policy and reject ex-post adjusted output unless explicit non-PIT research mode is requested.
- `REQ-PRICE-03`: PIT-adjusted prices must reconstruct only from corporate actions whose declaration/availability time is `<= known_at`.
- `REQ-PRICE-04`: Adjusted price results must include corporate-action set version and maximum action-availability timestamp in lineage; ex-post adjusted output must be labeled non-PIT.

## Owner-Local Leakage Tests Preserved

- `test_qdb_rejects_missing_known_at`
- `test_qdb_rejects_naive_known_at`
- `test_qdb_normalizes_aware_non_utc_known_at`
- `test_lake_published_at_is_not_financial_known_at`
- `test_backfill_amnesia_prevention`
- `test_market_bar_known_at_uses_declared_source_availability_field`
- `test_daily_bar_not_available_before_close`
- `test_intraday_bar_not_available_before_bar_end`
- `test_vendor_correction_not_visible_before_correction_available_at`
- `test_sec_source_available_at_controls_availability` (canonical name; the Manifests module's `test_sec_accepted_at_controls_availability` denotes the same test — single implementation under this canonical name)
- `test_sec_fiscal_period_end_does_not_authorize_fact`
- `test_sec_companyfacts_requires_accession_lineage`
- `test_sec_amended_fact_not_visible_before_amendment_accepted_at`
- `test_fred_vintage_asof`
- `test_fred_same_day_release_policy`
- `test_macro_forward_fill_does_not_cross_release_time`
- `test_current_symbol_join_rejected`
- `test_current_universe_join_rejected`
- `test_delisted_security_survives_historical_universe`
- `test_future_split_not_used_in_pit_adjusted_price`
- `test_ex_post_adjusted_price_rejected_in_pit_mode`
- `test_ex_post_adjusted_requires_non_pit_research_mode`
- `test_adjusted_price_lineage_includes_action_cutoff`
- `test_bitemporal_supersession_rollback_prevents_fact_blackout`
- `test_hypothesis_db_properties_rollback_or_truncate_each_example`
- `test_fred_date_only_vintage_not_available_until_next_utc_day`
- `test_sec_live_accepted_at_only_policy_is_disabled_until_public_availability_verified`
- `test_same_instant_supersession_produces_empty_interval_not_validation_failure`

Table: PIT and leakage tests preserved from the highest-risk test class and directly related determinism list entries.
