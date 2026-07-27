---
type: prj
domain: ccc
status: active
date_created: 2026-06-28
date_modified: 2026-07-11
version: 7.2.3
---

# CCC DuckLake v7.2.3 Provider Capability And Availability

Every provider deferral, investigate status, disabled adapter, timing uncertainty, purchase gate, and live-enablement gate in this module follows DD-005 through DD-010, DD-016, and DD-021 in [[PRJ-AI-CCC-DuckLake-v7.2.3-Deferred-Decision-Registry]]. Those entries state exactly when the item is decided, what evidence is current enough, what happens without evidence, where the answer is saved, and what proves the adapter remains disabled or becomes safe to enable.

This module is the canonical v7.2.3 owner for provider capability, source-availability policy, source verification gates, live-adapter refusal, and the enabled synthetic `synthfix` path. It is a semantic-preserving structural port from v6.5.0; no prose table, appendix planning row, or future-source idea enables a live adapter.

## Module Boundary

**Owns:** source hierarchy, provider verification, ingestion/source requirements, provider capability packs, source-availability policy objects, `synthfix`, source adapter gates, live-adapter pre-gates, and provider refusal semantics.

**Depends On:** [[PRJ-AI-CCC-DuckLake-v7.2.3-Dataset-Contracts-And-Validation]] for canonical schemas; [[PRJ-AI-CCC-DuckLake-v7.2.3-PIT-And-Bitemporal-Policy]] for source clocks; [[PRJ-AI-CCC-DuckLake-v7.2.3-Manifests-Lineage-And-Fixtures]] for raw evidence and lineage artifacts; [[PRJ-AI-CCC-DuckLake-v7.2.3-Orchestration-And-QDBCTL]] for adapter execution surfaces.

**Read After:** [[PRJ-AI-CCC-DuckLake-v7.2.3-Executive-Contract-And-Authority]], [[PRJ-AI-CCC-DuckLake-v7.2.3-Architecture-Context-And-Bootstrap]], and [[PRJ-AI-CCC-DuckLake-v7.2.3-Dataset-Contracts-And-Validation]].

**Non-Authoritative Restatements:** [[REF-AI-CCC-DuckLake-v7.2.3-Source-Universe-Planning]] is planning input only and may suggest evidence to collect, but it never enables adapters. Dataset schemas are linked, not re-owned. `synthfix` remains the single fully enabled synthetic exception; all live providers stay disabled/investigate until their capability and source-availability artifacts pass their gates.

**Source Ranges Ported:** PRD 1487-1492, 1574-1591, 2424-2691, 3648-3660, 3678-3679, 3682-3694, and provider-specific verification backlog material from 3787-3935.

## Requirements

### Source Hierarchy, Provider Verification, And Pre-Live Gates (`REQ-PRD`, `REQ-SRC`, `REQ-STORAGE`)

- `REQ-PRD-SOURCE-HIERARCHY`: This PRD MUST supersede conflicting planning-appendix guidance on raw retention, PIT semantics, source availability, provider capability evidence, and adapter enablement; raw/bronze/silver observations MUST NOT be discarded for premium, liquidity, moneyness, vendor convenience, or cost reasons, and any such filter belongs only in derived gold marts with lineage to retained source observations.
- Source verification and source-availability policy are defined once under `REQ-SRC` below (`REQ-SRC-VERIFY`, `REQ-AVAILABILITY-POLICY`): no live adapter is enabled from prose tables alone, every adapter needs a provider-capability artifact plus a machine-readable `source_available_at` policy before exact PIT fixtures are encoded, unverified timings stay disabled/investigate rather than hard-coded source truth, and index-options coverage for any vendor (D06) plus Norgate Windows/export gating (D07) stay unverified until purchased symbol lists, sample hashes, and export proof exist.
- `REQ-STORAGE-PROBE` (governing bullet; [[PRJ-AI-CCC-DuckLake-v7.2.3-Ops-Recovery-Maintenance-Security]] restates it operationally — FBL2-17b): No non-scratch NAS lake, artifact, or backup root may be used until a pre-live storage capability probe records route, mount options, path equivalence, atomic rename, temp-file discipline, checksum-after-rename, read-after-close latency, listing latency, file-count behavior, free space, disconnect-mid-write behavior, and restore-copy speed. Phase 0 requires only a scratch/non-scratch path classifier that refuses accidental production roots; the full two-host NAS drill is a pre-live gate, not a Phase 0 blocker (D14, D15).


### Ingestion Framework (`REQ-INGEST`)

- `REQ-INGEST-01`: Every source adapter MUST produce immutable raw evidence, normalized output, a validation report, and a manifest, and MUST be idempotent for the same source version and target partition.
- `REQ-INGEST-02`: Every adapter MUST support dry-run/plan mode that lists intended downloads/partitions/writes without mutating production state.
- `REQ-INGEST-03`: Every adapter MUST emit `source`, `source_file_id`, `source_version`, `batch_id`, `ingested_at`, `source_available_at`, row count, min/max timestamps, schema version, SHA-256 input/output file hashes, and output paths. (Row-level hashes are optional and dataset-specific.)
- `REQ-INGEST-04`: The SEC adapter MUST use official SEC APIs/bulk files, send a compliant user-agent, respect fair-access/rate limits, preserve `accepted_at`/accession lineage, and MUST be tested with a mocked HTTP layer rather than the live SEC API.
- `REQ-INGEST-05`: The FRED/ALFRED adapter MUST preserve vintage fields and prove historical as-of behavior.
- `REQ-INGEST-06`: The Polygon/Massive flat-file adapter MUST support deterministic partition rebuild from raw files and MUST verify current package/endpoint naming, provider channel, raw format/compression, CSV/header schema fingerprint, timestamp-unit handling, and source-availability policy before pinning (Polygon to Massive rebrand).
- `REQ-INGEST-07`: Norgate and DiscountOptionData MUST be separate adapter requirements preserving vendor adjustment metadata and source-specific identifiers; Norgate MUST be Windows/export-gated until proof exists; DiscountOptionData MUST be treated as drifting vendor file/CSV delivery with schema fingerprints and no assumed index coverage until symbol-list/sample-file evidence exists.
- `REQ-INGEST-08`: Vendor SDKs/official clients MAY be used for HTTP, pagination, throttling, and identifiers where they preserve raw evidence and timestamps, but CCC normalization, manifests, PIT policy, and validation MUST remain custom. `edgartools` (SEC parsing) and `massive` (the current official Massive/Polygon client line, superseding the legacy but still-maintained `polygon-api-client`) are allowed ONLY behind raw-capture and provider-capability gates: they may parse or page only after CCC captures raw bytes, headers, source hashes, and clocks, and only behind a `REQ-SRC-VERIFY` provider capability artifact; their cache/client state MUST NOT become the system of record, and `massive` stays a disabled capability-probe spike until its `REQ-SRC-VERIFY` evidence exists. `dlt` is parked/rejected for the first wave — NOT a first-wave ingestion spike — because its schema-inference, schema-evolution, incremental-load, and destination-abstraction gravity collides with validate-then-publish and kernel authority; revisit it only as a kill-oriented review if isolated nested-JSON normalization becomes a measured bottleneck.
- `REQ-INGEST-09`: Finnhub/news adapters are deferred until retrieval work begins and MUST NOT block Phase 1.

### Source Verification And Availability (`REQ-SRC`)

- `REQ-SRC-VERIFY`: No live/provider adapter may be enabled from prose tables alone. Each adapter MUST have a provider capability artifact (`provider_capabilities/<provider>.yaml`) containing provider, provider channel, raw format, compression, sample hash, schema fingerprint, entitlement/purchase evidence, coverage claim source plus coverage evidence ID, source-availability policy ID, parser version, timestamp-unit detection, `adapter_enabled`, and `last_verified_at`; missing evidence keeps the adapter fixture-only or disabled (D02, D06, D07).
- `REQ-AVAILABILITY-POLICY`: Every source MUST carry a provider-channel `source_available_at` policy object. Massive/Polygon flat files are compressed CSV archived as raw evidence before canonical Parquet staging and MUST NOT be backtest-available before observed or conservatively modeled next-day availability; timestamp-unit detection and adjustment-state lineage are required. Exact options quote/open-interest timing remains an investigate placeholder (D08): the policy object exists now, exact OCC/OPRA/vendor clocks become fixtures only after evidence (D03, D05, D08).
- `REQ-SRC-SDK`: Using a provider SDK or official client (for example `massive` or `edgartools`) does NOT by itself satisfy provider capability evidence. The SDK is plumbing behind the capability gate, never the evidence: CCC MUST still produce raw capture, source hashes, schema fingerprint, timestamp-unit detection, entitlement evidence, and a source-availability policy before `adapter_enabled` can flip true. A provider capability artifact citing only "uses the official SDK" is incomplete and keeps the adapter fixture-only or disabled.
- `REQ-SRC-DRAFT` (docs-derived adapter draft lane): Before purchase or entitlement evidence exists, an agent MAY draft high-quality but DISABLED adapter work for any planned source from official/public documentation, public SDK examples, existing open-source adapters, and mocked fixtures: disabled adapter skeletons, mocked HTTP layers, synthetic/sample fixtures, parser shape drafts, capability-pack templates, source-availability-policy templates, and tests that prove the adapter refuses to run without evidence. Forbidden before purchase/evidence: live downloads, real credentials, `adapter_enabled: true`, publishable provider data, live-source claims, and treating public docs as source-availability proof. Adapter drafts are disconnected/mocked by default, never hardcode real credentials, and never run live network tests against vendor or exchange endpoints. Drafting is distinct from and never satisfies `REQ-SRC-VERIFY`; the provider capability artifact remains the live gate, and purchases/subscriptions stay blocked until Ryan buys or supplies evidence/sample files. Backed by `test_draft_adapter_refuses_without_capability_evidence` and `test_draft_adapter_uses_mocked_http_only`.
- `REQ-SRC-RAW-FAILCLOSED` (parsed-without-raw fails closed): If a provider SDK or client returns parsed data but CCC fails to save the original raw bytes, headers, source timestamp, and hash evidence, the adapter MUST NOT publish. Parsed output MAY be quarantined or saved as diagnostic evidence only, clearly marked `not_publishable` and excluded from publishable lineage and manifests. Plain reason: without raw capture, CCC cannot prove what the vendor actually sent, cannot reparse it later, and cannot defend the point-in-time lineage. Backed by `test_sdk_parsed_output_without_raw_capture_is_not_publishable`.
- `REQ-SRC-IVGREEKS` (vendor IV/Greeks source-evidence gate): For every selected options source, adapter work MUST first examine current vendor documentation and sample-file schemas for native implied-volatility and Greeks fields. If the source provides them and their availability/provenance can be verified, those vendor values are ingested as formal database members with full provenance under the owning contract rule `REQ-OPT-IV-01` in [[PRJ-AI-CCC-DuckLake-v7.2.3-Dataset-Contracts-And-Validation]]; if they are absent or unverifiable, normalized contracts/quotes stay canonical and IV/Greeks are computed later as derived post-ingestion datasets. Never invent IV/Greeks silently; never let derived values overwrite or masquerade as vendor-provided values. Raw/bronze/silver option observations are retained either way.
- `REQ-SRC-BACKFILL-PLAN`: Every historical backfill spanning more than one partition MUST be described by a `source_backfill_plan.v1` artifact (schema seeded below) before execution. A backfill with no plan artifact, or a plan with unresolved capability/availability/coverage IDs, MUST NOT execute past dry-run/plan mode (`REQ-INGEST-02`), and no planned historical source becomes backtest-queryable without one. Backed by `test_source_backfill_plan_required_before_multi_partition_execution`.

## Provider Capability And Source-Availability Policy Seed

Provider capability artifacts are required before live adapters. They are enablement records that can fail closed, not vendor marketing summaries.

```yaml
provider_capability_version: 2
provider: polygon_or_massive
provider_channel: flat_files
adapter_enabled: false
raw_format: verify_before_enablement
compression: verify_before_enablement
schema_fingerprint: sha256:required_before_live
sample_hash: sha256:required_before_live
entitlement_or_purchase_evidence: required_before_live
coverage_evidence_id: required_before_live
source_availability_policy_id: source_availability_polygon_or_massive_flat_files_v1
parser_version: git:required_before_live
timestamp_unit_detection: required_before_live
rate_limits:
  requests_per_window: required_before_live
  window_seconds: required_before_live
  burst_allowance: null
quality_tier: investigate
data_delay:
  typical_lag_seconds: null
  worst_case_lag_seconds: null   # null blocks adapter_enabled: true
  delay_evidence: required_before_live
retry_policy:
  max_attempts: 3
  backoff_seconds: [60, 300, 1800]
  backoff_kind: escalating_fixed
circuit_breaker:
  failure_threshold: 5
  open_duration_seconds: 300
  half_open_probe_count: 1
last_verified_at: null
status: fixture_only_until_verified
```

Listing: Provider capability seed. Placeholder values intentionally block live enablement.

### Capability Pack v2 — Operational Capacity Fields (v7.2.3)

`provider_capability_version: 2` makes provider throughput, quality, and delay machine-checkable instead of prose. The pack validator MUST reject `provider_capability_version: 1` packs until they are explicitly migrated.

- `REQ-SRC-CAPACITY-01`: every pack MUST declare structured `rate_limits` (`requests_per_window`, `window_seconds`, `burst_allowance`). Narrative rate-limit prose (for example the SEC fair-access rule in `REQ-INGEST-04`) remains, but the structured field is the machine-checked authority. For `provider_channel: synthetic_fixtures` (local, no network), `requests_per_window: 0` and `window_seconds: 0` declare not-applicable-local; live channels MUST declare positive values.
- `REQ-SRC-CAPACITY-02`: `quality_tier` is one of `gold_vendor_verified`, `silver_vendor_unverified`, `bronze_community`, `investigate`, defaulting to `investigate`; `qdb` coverage caveats emit a quality warning for any dataset served from a pack below `gold_vendor_verified`.
- `REQ-SRC-CAPACITY-03`: `data_delay` declares `typical_lag_seconds`, `worst_case_lag_seconds`, and `delay_evidence`; a null `worst_case_lag_seconds` blocks `adapter_enabled: true` under `REQ-SRC-VERIFY`, and every non-null delay claim names its evidence. `data_delay` is operational capacity metadata; the PIT knowledge clock stays exclusively with the source-availability policy objects.
- `REQ-SRC-CAPACITY-04`: `retry_policy` (`max_attempts`, strictly increasing `backoff_seconds`, `backoff_kind`) and `circuit_breaker` (`failure_threshold`, `open_duration_seconds`, `half_open_probe_count`) govern provider transport calls only; kernel side-effect retry is owned by [[PRJ-AI-CCC-DuckLake-v7.2.3-Publish-Control-Kernel]] (`REQ-KERNEL-OUTBOX-01`) and the two never share configuration.

Backed by `test_provider_capability_v2_requires_rate_limits_quality_tier_and_data_delay`, `test_provider_capability_retry_policy_backoff_seconds_strictly_increasing`, and `test_provider_capability_v1_packs_reject_under_v2_schema_without_migration`. Provenance: the field families absorb the archive-frozen predecessor's proven connector metadata (`SourceMetadata` rate/quality/delay fields, `ResilienceConfig` retry/circuit shapes) on top of this module's fail-closed enablement, which the predecessor lacked.

Source-availability policy objects must exist before exact PIT tests. Unverified options timing stays an investigation policy, not a fixture.

```yaml
policy_version: 1
policy_id: option_eod_availability_unverified_v1
dataset: option_eod_quote
status: investigate
quote_available_at_policy: requires_occ_opra_or_vendor_evidence
open_interest_available_at_policy: requires_occ_opra_or_vendor_evidence
session_calendar_policy: requires_instrument_calendar_evidence
exact_timing_fixtures_enabled: false
default_behavior_without_evidence: fail_closed_or_fixture_only
verification_required_before_live:
  - OCC or OPRA timing evidence
  - vendor file/sample timestamp evidence
  - index-option and equity-option session calendar evidence
```

Listing: Source-availability policy seed for options quote/OI timing.

```yaml
policy_version: 1
policy_id: source_availability_norgate_continuous_v1
dataset: equity_bar_1d
status: investigate
availability_policy: requires_norgate_export_and_adjustment_padding_evidence
default_behavior_without_evidence: fail_closed_or_fixture_only
exact_timing_fixtures_enabled: false
verification_required_before_live:
  - Norgate export workflow evidence
  - adjustment and survivorship configuration evidence
  - source file/sample hash evidence
```

```yaml
policy_version: 1
policy_id: source_availability_discountoptiondata_eod_v1
dataset: option_eod_quote
status: investigate
availability_policy: requires_discountoptiondata_file_timestamp_and_coverage_evidence
default_behavior_without_evidence: fail_closed_or_fixture_only
exact_timing_fixtures_enabled: false
verification_required_before_live:
  - purchased symbol-list coverage evidence
  - sample-file timestamp evidence
  - quote and open-interest availability policy evidence
```

Listing: Placeholder source-availability policies for disabled Norgate and DiscountOptionData provider packs; these IDs exist so provider-pack references validate, but they remain `status: investigate` and cannot enable a live adapter.

### Provider Capability Packs (one per source, fail-closed)

Every live source needs a capability pack that blocks enablement until evidence is pasted in. The `polygon_or_massive` pack above is the template; the remaining sources replicate it. All ship with `adapter_enabled: false` and `status: fixture_only_until_verified`, so the first shippable release runs entirely on fixtures.

Every price/options capability pack MUST additionally carry the provider-level data-correctness fields that govern joins and backtests: `snapshot_convention` (this provider's official-close versus near-close convention) and the provider's symbology-encoding bridge — how it encodes the OCC/OSI raw symbol, its vendor root, underlying security id, index-root handling, and adjustment policy. Per-contract facts stay out of the static pack: `settlement_style` (AM versus PM) is a per-contract field on `option_contract_bt` (`REQ-OPT-03`, since one provider serves both AM-settled SPX and PM-settled SPXW), and delisted-underlying mapping is bitemporal in the identity cross-reference master (`REQ-PIT-12`). These conventions stay required because they change result correctness. The license/retention fields (`local_mirror_allowed`, `restore_allowed_until`, `purge_required_by`) are optional under the subscribe-forever policy and are recorded only when a vendor's terms require them. Under Ryan's personal-use posture, license/source/entitlement facts are operational context, never blanket adoption blockers (see Dependency License Posture in [[PRJ-AI-CCC-DuckLake-v7.2.3-Architecture-Context-And-Bootstrap]]); these fields exist to keep retention-after-termination, delete-on-terminate, and redistribution constraints visible, not to gate implementation by license label.

```yaml
provider_capability_version: 1
provider: norgate
provider_channel: norgate_data_export
adapter_enabled: false
raw_format: verify_before_enablement
compression: verify_before_enablement
schema_fingerprint: sha256:required_before_live
sample_hash: sha256:required_before_live
entitlement_or_purchase_evidence: required_before_live
coverage_evidence_id: required_before_live
source_availability_policy_id: source_availability_norgate_continuous_v1
parser_version: git:required_before_live
timestamp_unit_detection: required_before_live
platform_export_evidence: required_before_live   # Mac-native vs export path is an unresolved verification item
last_verified_at: null
status: fixture_only_until_verified
```

```yaml
provider_capability_version: 1
provider: discountoptiondata
provider_channel: bulk_csv
adapter_enabled: false
raw_format: verify_before_enablement
compression: verify_before_enablement
schema_fingerprint: sha256:required_before_live
sample_hash: sha256:required_before_live
entitlement_or_purchase_evidence: required_before_live
coverage_evidence_id: required_before_live   # index-option coverage is a verification item, not assumed
source_availability_policy_id: source_availability_discountoptiondata_eod_v1
parser_version: git:required_before_live
timestamp_unit_detection: required_before_live
last_verified_at: null
status: fixture_only_until_verified
```

```yaml
provider_capability_version: 1
provider: sec_edgar
provider_channel: edgar_rest
adapter_enabled: false
raw_format: verify_before_enablement
schema_fingerprint: sha256:required_before_live
sample_hash: sha256:required_before_live
entitlement_or_purchase_evidence: not_applicable_public
rate_limit_policy: single_threaded_throttled_compliant_user_agent   # ~10 req/s, verify exact policy
coverage_evidence_id: required_before_live
source_availability_policy_id: source_availability_sec_accepted_at_v1
parser_version: git:required_before_live
acceptance_timestamp_field: accepted_at                # captured for lineage; live PIT waits for accepted/public availability policy
public_dissemination_rule: verify_before_encoding      # publicly_disseminated_at after-hours rule unverified
last_verified_at: null
status: fixture_only_until_verified
```

```yaml
provider_capability_version: 1
provider: fred_alfred
provider_channel: fred_api
adapter_enabled: false
raw_format: verify_before_enablement
schema_fingerprint: sha256:required_before_live
sample_hash: sha256:required_before_live
entitlement_or_purchase_evidence: api_key_required
coverage_evidence_id: required_before_live
source_availability_policy_id: source_availability_fred_vintage_eod_v1
parser_version: git:required_before_live
vintage_fields: [realtime_start, realtime_end]
release_timing_policy: conservative_date_only_eod_unless_verified   # intraday release schedule unverified
last_verified_at: null
status: fixture_only_until_verified
```

Listing: Fail-closed provider capability packs for Norgate, DiscountOptionData, SEC EDGAR, and FRED/ALFRED.

### Source-Availability Policy Objects (per dataset)

```yaml
policy_version: 1
policy_id: source_availability_polygon_or_massive_flat_files_v1
dataset: equity_bar_1d
status: investigate
bar_available_at_policy: exchange_close_plus_dissemination_lag_requires_evidence
default_behavior_without_evidence: fail_closed_or_conservative_next_day_file_availability
exact_timing_fixtures_enabled: false
verification_required_before_live:
  - vendor file/sample timestamp evidence
  - exchange dissemination lag evidence
```

PIT queryability for Polygon/Massive flat-file bars is disabled until file-publication timing is verified or conservatively modeled as next-day/file-publication availability. Same-day exchange-close availability is not the default for flat files.

```yaml
policy_version: 1
policy_id: source_availability_sec_accepted_at_v1
dataset: fundamental_fact_bt
status: investigate_disabled_until_public_availability_verified
fact_available_at_policy: publicly_disseminated_at_or_conservative_public_availability_required
public_dissemination_policy: live_disabled_until_verified
accepted_at_policy: fixture_only_or_explicitly_conservative_live_policy
 # QD11: live SEC PIT fundamentals are not queryable from accepted_at alone.
default_behavior_without_evidence: fail_closed_for_live_pit_queries
exact_timing_fixtures_enabled: false
verification_required_before_live:
  - SEC after-hours dissemination rule evidence
  - conservative public-availability policy artifact
test: test_sec_live_accepted_at_only_policy_is_disabled_until_public_availability_verified
```

```yaml
policy_version: 1
policy_id: source_availability_fred_vintage_eod_v1
dataset: macro_observation_vintage
status: investigate
observation_available_at_policy: source_available_at_00_00_utc_day_after_realtime_start
intraday_release_policy: requires_release_schedule_evidence_before_same_day_use
 # QD12: date-only FRED/ALFRED vintages use a deliberately conservative, timezone-fixed proxy.
default_behavior_without_evidence: conservative_00_00_utc_next_day
date_only_rule: source_available_at = 00:00:00Z on the day after realtime_start
exact_timing_fixtures_enabled: false
verification_required_before_live:
  - exact release timestamp schedule (e.g., CPI 08:30 ET) evidence
test: test_fred_date_only_vintage_not_available_until_next_utc_day
```

Listing: Source-availability policy objects for equity bars, SEC facts, and FRED vintages (`REQ-AVAILABILITY-POLICY`).

### The `synthfix` Provider (fully enabled synthetic, first adapter)

`synthfix` is a fully-enabled synthetic provider so the capability/refusal machinery is proven end to end with zero live ambiguity. Unlike the live packs above, it ships `adapter_enabled: true` because its data is synthetic — there is no vendor entitlement, coverage, or timing to verify — and it carries real schema fingerprints and sample hashes computed over the synthetic fixtures. `synthfix` is the first adapter built, and it exercises the full real kernel path (plan, stage raw evidence, hash input, normalize, validate, commit, manifest, backup, restore, publish, query); it is never special-cased to bypass the kernel.

```yaml
provider_capability_version: 2
provider: synthfix
provider_channel: synthetic_fixtures
adapter_enabled: true
raw_format: csv_gz
compression: gzip
schema_fingerprint: sha256:<computed_over_synthfix_fixture_headers>
sample_hash: sha256:<computed_over_synthfix_fixture_bytes>
entitlement_or_purchase_evidence: not_applicable_synthetic
coverage_evidence_id: synthfix_fixture_coverage_v1
source_availability_policy_ids: [synthfix_equity_close_v1, synthfix_sec_accepted_at_v1, synthfix_fred_vintage_eod_v1]   # synthfix spans 3 datasets; one defined policy each, each ID resolving to a defined policy object below (single-dataset providers use source_availability_policy_id)
parser_version: git:<repo_sha>
timestamp_unit_detection: utc_declared_in_fixture
rate_limits:
  requests_per_window: 0     # not-applicable-local per REQ-SRC-CAPACITY-01
  window_seconds: 0
  burst_allowance: null
quality_tier: gold_vendor_verified   # deterministic local fixtures; provenance is the repo itself
data_delay:
  typical_lag_seconds: 0
  worst_case_lag_seconds: 0
  delay_evidence: local_synthetic_generated_in_process
retry_policy:
  max_attempts: 1
  backoff_seconds: [1]
  backoff_kind: escalating_fixed
circuit_breaker:
  failure_threshold: 1
  open_duration_seconds: 1
  half_open_probe_count: 1
last_verified_at: 2026-06-21T00:00:00Z
status: enabled_synthetic
```

```yaml
policy_version: 1
policy_id: synthfix_equity_close_v1
dataset: equity_bar_1d
status: verified_synthetic
bar_available_at_policy: session_close_declared_in_fixture
default_behavior_without_evidence: not_applicable_synthetic
exact_timing_fixtures_enabled: true
```

```yaml
policy_version: 1
policy_id: synthfix_sec_accepted_at_v1
dataset: fundamental_fact_bt
status: verified_synthetic
fact_available_at_policy: accepted_at_declared_in_fixture
public_dissemination_policy: not_applicable_synthetic
exact_timing_fixtures_enabled: true
```

```yaml
policy_version: 1
policy_id: synthfix_fred_vintage_eod_v1
dataset: macro_observation_vintage
status: verified_synthetic
observation_available_at_policy: realtime_start_eod_declared_in_fixture
intraday_release_policy: not_applicable_synthetic
exact_timing_fixtures_enabled: true
```

Listing: The fully-enabled `synthfix` provider capability pack and its source-availability policies; synthetic data means the timing fields are declared by the fixtures, not verified against a live vendor, and the fingerprints/hashes are computed over the committed synthetic fixtures (see the fixture-determinism rule under Adversarial PIT Fixture Seed: the `.yaml` scenario specs are the source of truth and a deterministic generator materializes the committed `raw/synthfix/**.csv.gz` evidence whose bytes these hashes cover). Because `synthfix` spans three dataset lanes, its scalar `schema_fingerprint`/`sample_hash` combine per-lane hashes by the newline-joined, sorted-by-dataset-name rule in [[PRJ-AI-CCC-DuckLake-v7.2.3-Manifests-Lineage-And-Fixtures]] (FBL2-23f).

> [!important] `synthfix` policy IDs resolve to defined objects (`SF1`)
> Each ID in `source_availability_policy_ids` MUST name a policy object actually defined in this seed (`synthfix_equity_close_v1`, `synthfix_sec_accepted_at_v1`, `synthfix_fred_vintage_eod_v1`); no whitespace-bearing or `_first release`-style ID is valid. `test_synthfix_policy_ids_resolve_to_defined_objects` (Phase 0 blocking) loads the `synthfix` pack and asserts every referenced policy ID resolves to a defined source-availability policy object, because `synthfix` is the only enabled provider and the entire fixture-complete Definition of Done loads through it.

> [!important] The first shippable release is fixture-only
> Every live-source pack ships `adapter_enabled: false` and `status: fixture_only_until_verified`; the fully-enabled `synthfix` pack above is the deliberate synthetic exception, because its data has no live ambiguity to verify. The repo reaches a legitimate finish line on fixtures alone — proven end to end through `synthfix` — and turning any live source on requires pasting real schema fingerprints, sample hashes, entitlement/coverage evidence, and a verified source-availability policy into that source's pack, after which `task verify:source-adapter-gate` may pass for it (`REQ-SRC-VERIFY`).

### Planned-Source Capability And Availability Seeds (fail-closed)

The planning stack in [[REF-AI-CCC-DuckLake-v7.2.3-Source-Universe-Planning]] names HistoricalOptionData, Cboe DataShop, Sharadar, FirstRate Data, Kibot, and Databento as first-wave historical/forward candidates. Planning rows are never adapter authority (`REQ-PRD-SOURCE-HIERARCHY`), so those six sources carry fail-closed seeds here to make every Coverage-Readiness Matrix reference resolve to a real artifact instead of dangling. Each seed replicates the `polygon_or_massive` pack shape with `adapter_enabled: false`, `status: fixture_only_until_verified`, `entitlement_or_purchase_evidence: required_before_live`, and an availability-policy stub with `status: investigate` and `exact_timing_fixtures_enabled: false`. Docs-derived drafts under `REQ-SRC-DRAFT` may flesh out parsers and fixtures for these packs at any time; nothing in this table implies enablement, entitlement, live data trust, publish authority, or source-availability proof.

| Provider | Capability pack | Availability policy stub | Adapter-draft notes (docs-derived, unverified) |
|---|---|---|---|
| `historicaloptiondata` | `provider_capabilities/historicaloptiondata.yaml` | `source_availability_historicaloptiondata_spx_eod_v1` (investigate) | Bulk CSV downloads sold as per-root products; SPX-family EOD history reaching back toward 1990; historical splice partner for forward options feeds. |
| `cboe_datashop` | `provider_capabilities/cboe_datashop.yaml` | `source_availability_cboe_eod_summary_v1` (investigate) | EOD summary snapshots vs legacy product lines are distinct products with distinct schemas; settlement-arbiter role for index options. |
| `sharadar` | `provider_capabilities/sharadar.yaml` | `source_availability_sharadar_sep_sfp_v1` (investigate) | SEP/SFP dual delivery (API plus bulk export); needs `snapshot_convention` and the symbology bridge like every price pack. |
| `firstrate` | `provider_capabilities/firstrate.yaml` | `source_availability_firstrate_stocks_v1` (investigate) | Plain CSV bundles without a login-bound API; owned cross-check role. |
| `kibot` | `provider_capabilities/kibot.yaml` | `source_availability_kibot_futures_continuous_v1` (investigate) | CSV/API continuous futures whose rollover conventions must be verified before trust. |
| `databento` | `provider_capabilities/databento.yaml` | `source_availability_databento_opra_glbx_equs_v1` (investigate; split per dataset family if OPRA/GLBX/EQUS clocks differ) | Three dataset families under one vendor; forward splice partner; symbology bridge required. |

Table: Fail-closed seeds for planned historical sources. A Coverage-Readiness Matrix row may be read as adapter authority only when these IDs resolve with real evidence (`REQ-SRC-VERIFY`); until then the packs exist to make refusal mechanical. Any source Ryan drops from the plan is explicitly marked out of Phase 1 rather than silently deleted. Backed by `test_planned_source_seed_packs_resolve_from_coverage_matrix`.

### Historical Backfill Plan Artifact (`source_backfill_plan.v1`)

Required by `REQ-SRC-BACKFILL-PLAN` before any multi-partition historical pull executes and before any planned historical source becomes backtest-queryable.

```yaml
backfill_plan_version: 1
plan_id: backfill_<provider>_<dataset>_<range>_v1
provider: <matches provider_capabilities/<provider>.yaml>
dataset: <matches the dataset contract name>
source_channel: <matches provider_channel in the capability pack>
entitlement_or_capability_id: <FK to the provider capability artifact>
source_availability_policy_id: <FK to the availability policy object>
coverage_evidence_id: <FK to the coverage-evidence artifact>
symbol_or_root_universe: [<explicit list or named universe id>]
date_range: {start: <date>, end: <date or open>}
partition_granularity: <monthly | yearly | date+root_bucket | ...>
expected_raw_files: {count_estimate: <int or [min, max]>, size_estimate_mb: [<min>, <max>]}
resume_checkpoint_key: "(provider, dataset, partition_key) -> last_completed_partition"
idempotency_key_shape: <partition-scoped; distinct from qdbctl plan's batch-level key>
rate_limit_profile: {requests_per_window: <int>, window_seconds: <int>}
raw_archive_destination: <under the raw evidence root for this provider>
normalized_output_destination: <staging/bronze/silver destination>
validation_tiers_required: [<subset of the validation-tier vocabulary>]
publish_target: <dataset/table this backfill publishes into>
rollback_or_quarantine_behavior: <quarantine partition, never fail open; diagnose via failed_run_diagnosis>
plan_status: draft | dry_run_only | approved_for_execution | executing | complete | quarantined
created_at: <timestamp_utc>
```

Listing: `source_backfill_plan.v1`. The resume checkpoint survives interruption so a crashed multi-year pull resumes at the last completed partition instead of re-downloading everything or silently skipping a gap. Supporting tests: `test_source_backfill_plan_requires_all_fk_ids_resolved_before_execution`, `test_source_backfill_plan_dry_run_lists_partitions_without_mutation`, `test_source_backfill_resume_checkpoint_survives_interrupted_partition`, and `test_source_backfill_idempotency_key_distinct_from_qdbctl_plan_batch_key`. Historical-to-forward seam handling (for example HistoricalOptionData/Cboe history spliced to Databento/Massive forward feeds) is governed by `historical_forward_splice_calibration.v1` under `REQ-SPLICE-01` in [[PRJ-AI-CCC-DuckLake-v7.2.3-Dataset-Contracts-And-Validation]].

## v7.2.3 complete verification backlog and provider-v1 boundary

AMD-009 replaces representative backlog language with one complete, closed authority set for canonical JSON, DuckLake maintenance and relocation, Dagu, SEC, FRED, options clocks, market calendar, NAS, and benchmarks. Every row has exactly the AMD-007 field shape and appears once.

AMD-010 makes v1 provider examples migration inputs only. Phase 0 materializes only `synthfix` and explicitly authored v2 disabled drafts; a v1 pack under `provider_capabilities` is refused. Each provider migration remains behind its own source gate.

## Owner-Local Tests And Verification Backlog

### Phase 1 Source-Adapter Gate

These tests gate live adapters behind verified provider capability packs; they are Phase 1 work using mocked/fixture evidence, never live provider APIs (`REQ-SRC-VERIFY`, `REQ-AVAILABILITY-POLICY`).

- `test_provider_capabilities_required_before_adapter_enabled`
- `test_massive_raw_csv_schema_fingerprint_blocks_unexpected_header`
- `test_massive_flat_file_bars_not_available_until_next_day_per_policy`
- `test_companyfacts_without_accession_is_non_pit`
- `test_sec_adapter_does_not_use_filed_at_as_availability_clock`
- `test_fred_closed_closed_native_dates_convert_to_half_open_utc`
- `test_discountoptiondata_index_coverage_not_assumed_without_symbol_list_hash`
- `test_norgate_windows_export_path_required_before_adapter_enabled`
- `test_draft_adapter_refuses_without_capability_evidence`
- `test_draft_adapter_uses_mocked_http_only`
- `test_sdk_parsed_output_without_raw_capture_is_not_publishable`
- `test_source_backfill_plan_required_before_multi_partition_execution`
- `test_planned_source_seed_packs_resolve_from_coverage_matrix`


37. `test_source_adapter_plan_mode_no_mutation`, `test_source_adapter_idempotent_same_batch`, `test_source_adapter_raw_archive_is_immutable`.
38. `test_sec_rate_limiter_enforces_policy`: the adapter throttles and sends a compliant user-agent, tested with a mocked HTTP layer (never the live SEC API).

### Pre-Live Gate

These tests gate any non-scratch/live write behind a storage probe and destructive-action guards; they are pre-live gates, not Phase 0 scratch blockers (`REQ-STORAGE-PROBE`, `REQ-MAINT-02`, `REQ-RESTORE-INVENTORY`, `REQ-OBS-SCHEMA`).

- `test_storage_capability_probe_required_before_non_scratch_nas_write`
- `test_cleanup_delete_requires_dry_run_retention_receipt_and_rollback`
- `test_secret_redaction_across_logs_artifacts_manifests_profiles`
- `test_run_event_and_failed_run_diagnosis_schema_validate`
- `test_dsn_classifier_detects_unix_socket_dns_alias_tailscale_and_server_identity`
- `test_storage_permission_probe_artifacts_validate_against_schemas`
- `test_prelive_launch_posture_recorded_for_postgres_and_dagu`
- `test_retention_yaml_covers_required_artifact_categories`


## Verification Backlog

These items are deliberately not guessed. The future agent must verify them in the new repo before production-like work begins, before adapter purchase, and before non-scratch writes.

### Seeded Verification Backlog (`backlog.seed.yaml`)

The open items below are not only prose; they are seeded once as machine-readable records in `docs/runtime-verification/backlog.seed.yaml`, one record per open fact, reusing `schemas/runtime_verification.schema.json` plus the optional `output_artifact` pointer and the two contingency fields `fallback_status` and `kill_or_pivot`, which are REQUIRED on every open record (not only the representative ones): each open item MUST declare a `fallback_status` (one of `record_only`, `stub`, `skip`, `fail_closed`, or a named pivot) and a `kill_or_pivot` sentence stating exactly where an agent without external access stops or what it does instead, so a no-network / no-runtime build always has an explicit safe stopping point. A backlog item whose `blocks` names a gate blocks that gate while `status: open`; flipping a safety-bearing item to `resolved` still requires the `REQ-AUTH-01` authority, command, and `observed_output_hash`. `task verify:offline` is the enforcement substrate for every backlog item's `fallback_status`/`kill_or_pivot` semantics: it is the command that runs with no network/runtime access and asserts each open item's recorded fallback actually fires — offline, the agent fail-closes per the recorded fallback and never guesses at a live value. Ordinary package pins are tracked in `docs/version-pins.md`/lockfile with exact version+hash pins and a short why-this-pin note; complete per-package backlog transcripts are advisory. The seed enumerates the safety-bearing verification set: the Dagu binary (version/URL/SHA/license), canonical JSON authority, DuckLake maintenance wrapper bindings and deferrals, DuckLake commit-fingerprint discovery, DuckLake attach/relocation behavior, SEC accepted/public-availability timing, FRED/ALFRED release timing, options OI/quote/session clocks, the market-calendar library, NAS atomic-rename/read-after-close/listing behavior, and benchmark thresholds. Three representative records are shown below; the generated file carries the complete set required by the seed-artifact bootstrap rule. This listing is the SINGLE authoritative in-PRD copy of the seed (FBL2-03): [[PRJ-AI-CCC-DuckLake-v7.2.3-Verification-Benchmarks-Readiness]] indexes the backlog but does not restate the records.

```yaml
 # docs/runtime-verification/backlog.seed.yaml  (status: open until resolved per REQ-AUTH-01)
- item: canonical_json_authority
  status: open
  authority_type: runtime_probe
  command: "task test -k canonical_json_authority_vectors"
  blocks: ["verify:phase0", "manifest_seal"]
  output_artifact: docs/runtime-verification/canonical_json.json
  expires_or_reverify_when: "canonical JSON authority, YAML loader, or manifest schema changes"
  fallback_status: fail_closed
  kill_or_pivot: "if no RFC 8785/JCS authority passes the vectors, stop before manifest seal; do not fall back to ad hoc json.dumps unless Ryan explicitly approves a project-specific non-JCS profile"

- item: ducklake_maintenance_fn_names
  status: open
  authority_type: runtime_probe
  command: "task verify:ducklake-api"
  blocks: ["verify:phase0", "manifest_seal"]
  output_artifact: docs/runtime-verification/ducklake_api.json
  expires_or_reverify_when: "pinned DuckDB/DuckLake build changes"
  fallback_status: manifest_authoritative_restore   # see Unresolved Risks: DuckLake dependency fallback
  kill_or_pivot: "if the Phase 0 wrapper bindings or copied-root restore cannot resolve on scratch in Phase 0, pivot restore to the kernel manifest file-inventory (do not depend on DuckLake snapshot introspection); non-Phase-0 wrappers remain explicit deferrals unless called"
  sentinel_wrapper_targets: "CCC spec authority for this item is the seven CCC wrapper sentinel names below; underlying DuckLake signatures remain runtime-verified by `task verify:ducklake-api`, not asserted from this list: `list_snapshot_files`, `flush_inlined_data`, `cleanup_old_files`, `expire_snapshots`, `merge_adjacent_files`, `rewrite_data_files`, `delete_orphaned_files`. Phase-0 binding subset (the first four, with cleanup/expire in dry-run): `list_snapshot_files`, `flush_inlined_data`, `cleanup_old_files` (dry-run), `expire_snapshots` (dry-run). Recorded deferrals (last three, non-Phase-0): `merge_adjacent_files`, `rewrite_data_files`, `delete_orphaned_files`."

- item: ducklake_commit_fingerprint_discovery
  status: open
  authority_type: runtime_probe
  command: "task verify:ducklake-api && task test -k commit_fingerprint_discovery"
  blocks: ["verify:phase0", "manifest_seal"]   # FBL2-03: fail-closed — blocks manifest_seal too, matching the Architecture probe-order callout (all three probes block manifest_seal)
  output_artifact: docs/runtime-verification/ducklake_commit_fingerprint_discovery.json
  resolved_value_shape:
    reconciliation_status: "proven | quarantine_fallback"
    discovery_route: "commit_extra_info | row_carried_fingerprint | returned_snapshot_id | null"
  gate_rule: "pre-live/live gates require reconciliation_status=proven and discovery_route != null; returned_snapshot_id is proven only with post-crash recoverability or commit idempotency evidence; quarantine_fallback satisfies only the fixture-core fallback test; quarantine_fallback is valid only with a probe transcript showing all THREE named routes (`commit_extra_info`, `row_carried_fingerprint`, `returned_snapshot_id`) attempted and failed, each with `observed_output_hash` — a defaulted fallback (no transcript, or fewer than three attempted-and-failed routes) fails the gate"
  expires_or_reverify_when: "pinned DuckDB/DuckLake build changes"
  fallback_status: quarantine_on_crash_fixture_core
  kill_or_pivot: "if no commit-fingerprint discovery route is verified, record reconciliation_status=quarantine_fallback and discovery_route=null, quarantine the crashed batch with diagnosis, prove no second commit or visibility, and do not claim pre-live/live readiness"

- item: ducklake_attach_relocated_root
  status: open
  authority_type: runtime_probe
  command: "task restore:test"
  blocks: ["verify:phase0"]
  output_artifact: docs/runtime-verification/ducklake_attach.json
  expires_or_reverify_when: "pinned DuckDB/DuckLake build changes or restore path policy changes"
  fallback_status: manifest_authoritative_restore
  kill_or_pivot: "if ATTACH/OVERRIDE_DATA_PATH relocation cannot be proven, keep copied-root restore manifest-authoritative and do not use original-root catalog pointers"

- item: dagu_binary_version_url_sha_license_source
  status: open
  authority_type: official_doc
  command: "resolve stable Dagu 2.x from candidate origins github.com/dagucloud/dagu and github.com/dagu-org/dagu; record serving org, release URL, source relation, license variant, dagu version, and sha256sum <pinned-binary>"
  blocks: ["verify:phase0"]
  output_artifact: docs/runtime-verification/dagu_binary.json
  expires_or_reverify_when: "Dagu pin bump"
  fallback_status: fail_closed
  kill_or_pivot: "if the pinned Dagu binary cannot be fetched or hash-verified offline, fail closed on verify:phase0 and stop — do not substitute an unpinned binary"

- item: sec_accepted_public_availability_timing
  status: open
  authority_type: official_doc
  command: "inspect official SEC dissemination/public-availability docs or a Ryan-supplied source_availability_policies/sec.yaml carrying cited policy evidence; fixture timestamps alone are Phase 0 fixture proof and cannot satisfy verify:source-adapter-gate"
  blocks: ["verify:source-adapter-gate"]
  output_artifact: source_availability_policies/sec.yaml
  expires_or_reverify_when: "SEC dissemination policy change"
  fallback_status: fixture_only
  kill_or_pivot: "if exact dissemination timing is unverifiable, keep conservative date-only known_at and stay fixture-only for SEC; do not encode an exact intraday clock"
```

Listing: Representative seed records; the file carries one record per Open Verification item, and CI treats an `open` item whose `blocks` names a live gate as a gate failure until it is resolved.

### External Verification Before Coding Or Purchase

- DOD: current symbol list and sample files for SPX/VIX/NDX/RUT coverage (D06).
- Norgate: Windows VM/export path, adjustment/padding config, export hashes (D07).
- Options OI/session clocks: OCC/OPRA/vendor timing evidence (D08).
- SEC: exact public-availability policy by form and after-hours exception (D04).
- FRED: whether intraday release timestamps are needed beyond conservative date policy (D05).
- NAS: route, mount options, atomic rename, read-after-close, listing latency, free space, and restore-copy probe (D14).
- Docker/Testcontainers: fast local preflight on the target Mac host (D17).
- Dagu: pin the target binary, record local `dagu version`, probe whether `dagu schema dag` exists, author against that binary's docs, and commit one `dagu validate`-passing parent+child template before trusting any workflow grammar (D16/DG1/DG3/DG6).

| Item | Why it matters | Verification lane |
|---|---|---|
| Repo name/path | Adjudicated: `/Users/ryanpappal/03_CODE/ccc-lab-super/` (external code repo, not the vault project folder) | Record in README at scaffolding. |
| DuckDB/DuckLake/Postgres-extension version quartet with Polars/PyArrow/Pandera | ACID, maintenance, zero-copy ABI compatibility | Pin together only after the two-client smoke; record in `docs/version-pins.md`. |
| NAS mount semantics | Atomic rename, metadata listing, cold/warm scans, concurrent readers, read-after-close and listing latency, free space, disconnect-mid-write, restore-copy speed | Phase 0 uses a scratch-vs-live path classifier only; the full probe is the pre-live `task smoke:nas` gate (`REQ-STORAGE-PROBE`, D14/D15). |
| Scratch PostgreSQL strategy | Reproducible, non-hanging default tests | Testcontainers PostgreSQL 16 is the default integration strategy (`REQ-TEST-PG`); verify Docker preflight and explicit `QDB_TEST_POSTGRES_DSN` override. |
| SEC after-hours dissemination rule | Trading-on-acceptance leakage | Verify exact rule before encoding `publicly_disseminated_at` (unverified 17:30 ET claim). |
| FRED/ALFRED intraday release policy | Same-day macro leakage | Default conservative end-of-day unless exact release times verified. |
| Index-option vs equity close mismatch | 15-minute leakage on joins | Verify session calendars per instrument. |
| Vendor SDK raw-evidence fidelity | Polygon/Massive, Norgate, DiscountOptionData, SEC, FRED | Confirm each preserves raw evidence, timestamps, identifiers before adoption. |
| Norgate Windows/export path | Norgate is not a normal Mac-native adapter; real only after a Windows/export proof (D07) | Verify Windows VM/export path, adjustment/padding config, and export hashes before enabling the adapter for Phase 1. |
| Dagu license for intended use | Local tool vs redistribution | Confirm no license concern for local external orchestration. |
| `dlt` DuckLake destination | Ingestion boilerplate reduction | Parked/rejected for the first wave (`REQ-INGEST-08`); revisit only as a kill-oriented review if isolated nested-JSON normalization becomes a measured bottleneck. |
| DiscountOptionData index coverage | SPX/VIX/NDX/RUT history may exceed the old note but is unverified (D06) | Confirm with a purchased symbol list and sample files; do not assume coverage without a symbol-list/sample hash. |
| Options OI and session clocks | Open-interest availability lags quotes; OI timing unverified (D08) | Confirm OCC/OPRA/vendor timing evidence before encoding the OI availability clock; policy object ships now, fixtures only after evidence. |
| Dagu binary pin and grammar validation | YAML shape must match the pinned binary, not memory (D16/DG1/DG3/DG6) | Pin the target binary, record `dagu version`, probe whether `dagu schema dag` exists, and commit one `dagu validate`-passing parent+child template before treating any shape as accepted. |
| Initial benchmark thresholds | PRD defines classes, not numbers | Set thresholds after the first sample baseline, then freeze in `docs/`. |

Table: Open assumptions that must become verified repo facts before production scale-up.

### Core Implementation Verification Items

These external-dependent facts must be confirmed against official documentation or live runtime evidence before placeholders are replaced with hard-coded values; self-contained logic such as DDL, state-machine rules, path classifiers, fixtures, error classes, CLI shape, dataframe schemas, and contracts is asserted directly.

| Verification item | Confirm before hard-coding | Binds |
|---|---|---|
| DuckLake snapshot file-listing function | Exact name and signature; reconcile candidate names by routing all calls through `qdb_lake.maintenance.list_snapshot_files` until confirmed | Maintenance wrapper, manifest file inventory, restore proof |
| DuckLake cleanup-old-files function | Exact name, signature, and dry-run behavior | Maintenance cleanup gates |
| DuckLake snapshot-expiry pragma/function | Exact spelling and retained-snapshot semantics | Snapshot retention and cleanup |
| DuckLake flush/inline/checkpoint pragma | Exact spelling and when inlined data is materialized | Manifest sealing and backup ordering |
| Dagu binary YAML grammar | Child invocation, shell/argv, worker placement, and schema-subcommand presence validated against the pinned binary; no unverified grammar is adopted as fact | Dagu safety and modularity |
| Dagu binary source and hash | Exact version, download URL, and SHA-256 for `task setup:dagu` | Bootstrap and smoke gates |
| SQL migrator harness | Numbered `.sql` plus `schema_migrations`, driven by psycopg3 + Testcontainers, no Alembic | Kernel migration plan |
| Advisory-lock key and lease constants | `pg_advisory_xact_lock` key hashing and TTL/renew constants under real contention | Lock lease and heartbeat |
| PostgreSQL `SERIALIZABLE` behavior | Serialization-failure rate and retry policy under concurrent writers | Kernel transaction protocol |
| Per-provider vendor formats/timestamps | Raw format and availability-timestamp semantics per source | Provider capability packs |
| Package version pins | DuckDB, DuckLake, PostgreSQL extension, Polars, PyArrow, selected dataframe validator (`dataframely` or fallback), Typer, Pydantic, Psycopg3, and Testcontainers compatibility | Global bootstrap |
| Exact Polars dtype spellings | Map neutral dtype tokens to concrete Polars dtypes for output frames | Dataset contracts and qdb APIs |
| SEC availability clock | `publicly_disseminated_at` versus `accepted_at` rule for the availability gate | SEC PIT fixtures and qdb fundamentals |
| FRED release timing | Whether intraday/exact release timestamps exist or end-of-day is the conservative clock | Macro vintage policy |
| Options OI/session clocks | Quote-availability versus open-interest-availability lag and session-close timing | Options EOD companion |
| Benchmark thresholds | Provisional numbers come only from the first baseline run; none are invented in advance | Benchmark gates |

Table: Verification items that must become repo facts before production-like work.

### Contract-Closure And Modeling-Interface Verification Items

These external-dependent facts and deliberate open decisions join the verification ledger; none may become a silent assumption, and each is resolved only through the Autonomous Implementation Authority rule (`REQ-AUTH-01`).

| Verification item | Confirm before hard-coding | Binds |
|---|---|---|
| Market-calendar library | Which package backs `trading_calendar_bt` — resolve ordered candidates `exchange_calendars` then `pandas_market_calendars`, first passing the probe wins; wrap it in the bitemporal contract, never trust its current-calendar view for history | `REQ-IFACE-05`, resample/fill |
| Panel-spec ergonomics | Deliberate decision: flat column-list with explicit per-column dataset binding (notebook-readable), not a dataset-graph spec | `REQ-IFACE-02`/`REQ-IFACE-10` |
| Package-layout roots | The five-root core (`qdb`, `qdb_lake`, `qdb_contracts`, `qdb_kernel`, `qdb_config`) plus the functional packages; confirm at repo creation | Bootstrap, package shape |
| `register_derived` `known_at` rule | `known_at = max(parent availability)` across all three derived kinds; fails closed if a parent lacks source availability | `REQ-IFACE-08`/`REQ-IFACE-09` |
| `get_coverage` flag source | Which validation/quality fields back the coverage completeness/gap/quality flags | `REQ-IFACE-06` |
| `signal_score` serving trigger | When the engine exists and produces scores; reserved future interface contract, serve later | `REQ-IFACE-09` |
| Serialization-retry constants | The `REQ-KERNEL-RETRY` defaults (3x, jittered backoff) confirmed under real concurrent write load | `REQ-KERNEL-RETRY` |

Table: Verification items joining the ledger; deliberate decisions are flagged as such.

## v7.2.3 r2 restored indexed acceptance criteria

- `test_backlog_complete_set_contains_each_required_item_once`: the generated backlog contains every required open fact exactly once, with no missing or duplicate decision ID, gate, fallback, or stop-or-pivot record.
- `test_no_invented_macro_series_without_policy_row`: a macro series absent from the provider pack and source-availability policy cannot appear as live, enabled, or backtest-queryable data.
- `test_options_provider_sample_maps_to_stable_option_contract_key_without_current_symbol_lookup`: a provider sample resolves to the stable option-contract identity using evidence available at the sample's time, without substituting today's symbol mapping.
- `test_source_coverage_matrix_requires_evidence_ids_for_live_or_backtest_queryable_rows`: any source-coverage row marked live or backtest-queryable names valid capability and availability evidence IDs; missing IDs keep the row planning-only.
