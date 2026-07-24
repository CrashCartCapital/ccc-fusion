---
type: prj
domain: ccc
status: active
date_created: 2026-06-28
date_modified: 2026-07-11
version: 7.2.3
---

# CCC DuckLake v7.2.3 Manifests Lineage And Fixtures

Every postponed DuckLake binding, provider-evidence, modeling-boundary, or advanced-maintenance item in this module follows DD-002, DD-005, DD-015, and DD-017 in [[PRJ-AI-CCC-DuckLake-v7.2.3-Deferred-Decision-Registry]]. A manifest may record uncertainty but may not turn it into a resolved or enabled fact.

This module is the v7.2.3 structural port of the v6.5.0 manifest, lineage, schema-artifact, canonical JSON, restore-bundle inventory, and adversarial fixture material. It preserves immutable manifest shape v3, schema inventory rules, generated-schema conventions, lineage/reproducibility requirements, canonical JSON hashing rules, fixture determinism, fixture file inventory, and owner-local tests without taking over Kernel lifecycle transitions, Ops restore procedure, Provider enablement, Dataset Contract schemas, or `qdb` API projection ownership.

## Owns

- Schema artifact inventory, schema derivation ledger requirements, generated JSON Schema conventions, and safety-bearing schema surface lists.
- `publish_manifest` manifest shape v3, immutable manifest payload rules, manifest hash/canonical JSON rules, restore-bundle inventory shape, file inventory payload rules, and manifest lifecycle field exclusions.
- Lineage and reproducibility rules for published batches, derived tables/marts, stable manifest identity, and durable manifest location.
- Adversarial PIT fixture seed, synthetic fixture tree, fixture-spec schema shape, deterministic fixture generation, fixture-build hashes, and expected result inventory.
- Requirement authority for `REQ-LIN-*`, `REQ-LIN-REGRESS`, manifest rule `MR1`, restore bundle rule `MR2`, catalog relocation rule `MR3`, fixture determinism rule `SF2`, fixture identity rule `QD11`, and fixture corporate-action rule `QD7`.

## Depends On

- [[260708-DuckLake-Quant-Stack-PRD-v7.2.3]] for root version routing and source-set control.
- [[PRJ-AI-CCC-DuckLake-v7.2.3-Publish-Control-Kernel]] for lifecycle state, manifest row binding, backup marker, restore proof, cleanup eligibility, and visibility transitions.
- [[PRJ-AI-CCC-DuckLake-v7.2.3-PIT-And-Bitemporal-Policy]] for time semantics used by fixture cases and manifest policy fields.
- [[PRJ-AI-CCC-DuckLake-v7.2.3-Dataset-Contracts-And-Validation]] for canonical domain schemas, contract bodies, validation report semantics, and dataset-contract schema authority.
- [[PRJ-AI-CCC-DuckLake-v7.2.3-Provider-Capability-And-Availability]] for provider capability packs and source-availability policy objects.
- [[PRJ-AI-CCC-DuckLake-v7.2.3-Ops-Recovery-Maintenance-Security]] for restore, backup, cleanup, maintenance, and path-safety procedures.
- [[PRJ-AI-CCC-DuckLake-v7.2.3-QDB-Agent-Access-And-SQL-Zero]] for API lineage result objects and query examples.

## Read After

- [[PRJ-AI-CCC-DuckLake-v7.2.3-Executive-Contract-And-Authority]]
- [[PRJ-AI-CCC-DuckLake-v7.2.3-Architecture-Context-And-Bootstrap]]

## Non-Authoritative Restatements

- Kernel owns state transitions and lifecycle state facts; this module owns manifest payload/file inventory rules and immutable bundle shapes.
- Ops owns restore procedure; this module owns restore-bundle inventory shape and copied-root proof payload inventory.
- Dataset Contracts owns canonical domain schemas; this module owns schema artifact inventory and generated schema conventions for safety-bearing artifacts.
- Provider owns live/source enablement evidence; this module owns the manifest and fixture references to provider capability and source-availability artifacts.
- `qdb` owns API projections; this module owns fixture inputs and expected lineage assertions used by those APIs.

## Source Port

| Source | Ported content |
|---|---|
| Primary PRD 1347-1387 | Schema artifact inventory, generate-and-record rules, safety-bearing schema authority, JSON Schema conventions, and concrete schema file list. |
| Primary PRD 1612-1620 | Lineage and reproducibility requirements. |
| Primary PRD 2692-2777 | Manifest shape v3, detached manifest hash rule, canonical JSON authority, YAML seed, canonical JSON test vector, restore bundle inventory, and catalog relocation rule. |
| Primary PRD 3149-3295 | Adversarial PIT fixture tree, fixture determinism, fixture-spec schema, synthetic identity fixtures, corporate-action split fixture, and worked examples. |
| Primary PRD 3529-3534, 3574, 3585, 3595-3600 | Owner-local manifest, lineage, schema, fixture, restore-bundle inventory, and validation-report tests. |

Table: v6.5.0 source ranges structurally ported into this module.

## Schema Artifact Inventory

This inventory disambiguates author-versus-reuse for field-seeded schema artifacts. The PRD does not inline every final JSON Schema body, but each Phase 0 safety-bearing schema must be generated from the exact field/type/required/enum authority below and snapshot-tested after generation; an implementation may not fill schema gaps from taste or library defaults.

| Schema artifact | File path | Governing source section | Full JSON Schema present in source? | If generate, assemble from |
|---|---|---|---|---|
| `runtime_verification` | `schemas/runtime_verification.schema.json` | Autonomous Implementation Authority (`REQ-AUTH-01`) -> Runtime-verification artifacts | No | The `runtime_verification` record field list named under `REQ-AUTH-01`, reused by every seeded backlog record. |
| `publish_manifest` (`manifest_version: 3`) | `schemas/publish_manifest.v3.schema.json` validates sealed manifest artifacts under `QDB_ARTIFACT_ROOT` | `Manifest Shape` | No | The `manifest_version: 3` YAML seed in this module, assembled under JSON Schema conventions. |
| Restore bundle inventory | `schemas/restore_bundle_inventory.v1.schema.json` validates copied-root restore inventories | `REQ-RESTORE-INVENTORY` and restore bundle inventory | No | Manifest-inventory references, non-DuckLake evidence entries, copied-root mapping, entry counts, and hash/check status fields. |
| Validation / quality report | `schemas/validation_report.v1.schema.json` validates persisted validation and quality reports | `REQ-VALIDATION-TIERS`, `REQ-CONTRACT`, and `REQ-IFACE-06` coverage fields | No | Validation tiers, check IDs, status enums, row/file counts, source-overlap findings, coverage gaps, correction density, caveat flags, and fields that later back `get_coverage`. |
| Side-effect intent | `schemas/side_effect_intent.schema.json` validates JSON fallback intent records if table storage is not used | `side_effect_intent` DDL and External Side-Effect Commit Protocol (`CX1`) | No | DDL fields, deterministic cleanup idempotency rule, JSON fallback path layout, and uniqueness/scope constraints. |
| Provider capability pack (`synthfix`) | `provider_capabilities/synthfix.yaml` | Provider Capability Packs | No | Provider-capability YAML seed under Provider Capability And Source-Availability Policy Seed. |
| Source-availability policy | `source_availability_policies/<dataset>.yaml` | Source-Availability Policy Objects | No | Source-availability policy YAML seed in the provider policy section. |
| Observability event schemas | `schemas/<event>.schema.json`: `run_event`, `kernel_transition_event`, `qdb_query_event`, `validation_event`, `backup_event`, `restore_event`, `cleanup_event`, `redaction_event` | Minimum Observability Event Schema Seeds (`REQ-OBS-SCHEMA`) | No | Shared v1 envelope plus each event's field row in `REQ-OBS-SCHEMA`. |
| `failed_run_diagnosis` | `schemas/failed_run_diagnosis.schema.json` | Minimum Observability Event Schema Seeds and `REQ-MON` | No | The `failed_run_diagnosis` field list in `REQ-OBS-SCHEMA`. |
| `dataset_contract` | `schemas/dataset_contract.schema.json` validates dataset contracts under `contracts/` | Dataset Contract Seed and Minimum Contract Set | No | Dataset-contract YAML seed plus minimum contract set, assembled under JSON Schema conventions. |
| Fixture scenario spec | `schemas/fixture_spec.schema.json` validates `tests/fixtures/**/*.yaml` | Adversarial PIT Fixture Seed | No | Fixture spec fields named under the adversarial fixture section; Phase 0 blocking. |
| Pre-live topology/probe schemas | `schemas/storage_probe.v1.schema.json`, `schemas/topology.v1.schema.json`, `schemas/ops_permission_probe.v1.schema.json` | `REQ-OPS-*` and Local Operations examples | No | Topology and probe fields named in the pre-live OPS example; pre-live only, not Phase 0 blocking. |

Table: Safety-bearing schema artifact inventory.

## Generate-And-Record Rules

Generate-and-record means assemble the schema file from the fields the named normative section already enumerates. Do not invent fields, types, enums, defaults, PIT/bitemporal timeline columns, nested keys, or policy keys. Nested object structure is allowed only when the governing seed names the parent field and the schema derivation ledger enumerates each nested key, type, required/optional status, enum domain, and source line or section.

The implementation must ship a machine-checkable schema derivation ledger rendered to `docs/schema-derivation/phase0-safety-schemas.md` from the same source used to generate the JSON Schemas, with one row per safety-bearing schema field path: `schema | field_path | json_type | required? | enum/domain | nullable? | governing source`. `test_schema_derivation_ledger_covers_phase0_safety_schemas` fails if any generated schema field lacks that ledger row. This ledger is generated proof, not hand-maintained paperwork.

Phase 0 safety-bearing schema authority starts with these exact required surfaces: `runtime_verification` requires `item`, `status`, `authority_type`, `source`, `command`, `blocks`, `expires_or_reverify_when`, plus status-conditional fields; `publish_manifest.v3` requires the manifest seed fields and explicitly forbids backup/restore/cleanup lifecycle fields; `restore_bundle_inventory.v1` requires manifest references, copied-root mapping, non-DuckLake evidence entries, entry counts, and hash/check status fields; `validation_report.v1` requires validation tier names, check IDs, status enums, row/file counts, source-overlap findings, coverage/gap/correction-density fields, caveat flags, and canonical report bytes tied to `report_sha256`; `failed_run_diagnosis` requires exactly the fields of the Ops `REQ-OBS-SCHEMA` `failed_run_diagnosis` table row plus the shared v1 envelope — the Ops row is the single field authority and no prose-derived extra fields exist (FBL2-10); `fixture_spec` requires scenario identity, raw fixture inputs, expected `qdb` calls, expected rows or expected error class, and expected lineage assertions; event schemas require the shared envelope plus the event-specific fields named in `REQ-OBS-SCHEMA`.

Safety-bearing schema generation has these minimum skeleton rules before implementation-specific expansion: `runtime_verification` uses status-conditional required fields; `publish_manifest.v3` follows the manifest YAML seed and forbids post-seal backup/restore/cleanup lifecycle fields; `restore_bundle_inventory.v1` requires manifest references, copied-root mapping, non-DuckLake evidence entries, entry counts, and hash/check status fields; `side_effect_intent` requires `effect_scope_id`, exactly one of `batch_id`/`cleanup_id` where applicable, `effect_type`, `idempotency_key`, `status`, `effect_fingerprint`, optional `effect_result_json`, timestamp fields, and uniqueness over `(effect_type, effect_scope_id)` and `(effect_type, effect_fingerprint)`; `fixture_spec` requires scenario identity, raw fixture inputs, expected `qdb` calls, expected rows or expected error class, and expected lineage assertions; `provider_capability.schema.json` allows exactly one source-policy shape: single-source packs use `source_availability_policy_id: string`; `synthfix` and any future multi-dataset pack use `source_availability_policy_ids: list[string]`; arbitrary sibling variants are invalid.

## JSON Schema Conventions

Every generated JSON Schema follows one normative convention so schema-validation tests have concrete deterministic files rather than invented strictness:

- JSON Schema draft 2020-12, with `additionalProperties: false` by default.
- UTC timestamps are `type: string, format: date-time`; dates are `type: string, format: date`; nullable fields use a typed union such as `type: ["string", "null"]`.
- SHA-256 values match `^sha256:[a-f0-9]{64}$`.
- Relative paths are strings that must not begin with `/`, `..`, `s3://`, `http://`, or `https://`.
- Every schema file has an explicit `required` array; optional fields may be omitted only where the governing seed names them optional.
- Event-envelope fields are always present and may be null only when the event-specific table says they are unused.
- `schemas/runtime_verification.schema.json` uses conditional `required`: if `status = "resolved"`, require `authority_type`, `source`, `command`, `observed_output_hash`, `resolved_value`, `verified_at`, and `expires_or_reverify_when`; if `status = "open"`, require `authority_type`, `command`, `blocks`, `fallback_status`, `kill_or_pivot`, and `expires_or_reverify_when`, and do not require `observed_output_hash`.
- `jsonschema` usage runs `validator_for(...).check_schema(...)` on each schema itself and enables an explicit `FormatChecker` where formats are load-bearing.
- Generated schema files are snapshot-tested after generation.
- Schema regeneration must fail if an implementation needs a field, enum, default, or conditional rule that the governing PRD seed does not name; the correct response is an `investigate` backlog item, not invention.
- The dataset-contract schema compiler maps neutral tokens to exact JSON Schema fragments: `timestamp_utc` and `timestamp_utc_nullable` -> `{type: "string", format: "date-time"}`; `date` -> `{type: "string", format: "date"}`; `int64` -> `{type: "integer"}`; `float64` -> `{type: "number"}`; `string` and `string_nullable` -> `{type: "string"}`; `bool` -> `{type: "boolean"}`; `json` and `json_nullable` -> `{type: "string", contentMediaType: "application/json"}` unless the governing seed explicitly chooses a structured JSON object; `list_string` -> `{type: "array", items: {type: "string"}}`.
- Token names may carry `_nullable` for readability, but schema nullability is added only when the column appears in `allowed_nulls`, using the project's typed union convention.

The concrete schema files that must exist are `schemas/publish_manifest.v3.schema.json`, `schemas/restore_bundle_inventory.v1.schema.json`, `schemas/side_effect_intent.schema.json`, `schemas/validation_report.v1.schema.json`, `schemas/provider_capability.schema.json`, `schemas/source_availability_policy.schema.json`, `schemas/dataset_contract.schema.json`, `schemas/fixture_spec.schema.json`, `schemas/runtime_verification.schema.json`, `schemas/failed_run_diagnosis.schema.json`, `schemas/run_event.schema.json`, one `schemas/<event>.schema.json` per observability event, and the pre-live-only `schemas/storage_probe.v1.schema.json`, `schemas/topology.v1.schema.json`, and `schemas/ops_permission_probe.v1.schema.json`. Backed by `test_publish_manifest_schema_is_validated`, `test_fixture_specs_validate_against_schema`, `test_storage_permission_probe_artifacts_validate_against_schemas`, and `test_run_event_and_failed_run_diagnosis_schema_validate`.

## Lineage And Reproducibility

- `REQ-LIN-01`: Every published batch must have a manifest with source inputs, hashes, code version, environment/version pins, validation results, output tables/files, row counts, time ranges, and DuckLake snapshot ID, conforming to a versioned schema validated before publish.
- `REQ-LIN-02`: Every derived table/mart must name input dataset versions, transformation code version, and adjustment/PIT policies, and carry `max_input_known_at` where relevant.
- `REQ-LIN-03`: Rebuilding the same sample batch from the same raw source and code version should produce a stable manifest identity except explicitly excluded runtime fields.
- `REQ-LIN-04`: Durable manifests live in the lake artifact/manifest path; Dagu artifacts are run evidence, not the system of record.
- `REQ-LIN-05`: Each publish manifest must include a snapshot-derived file inventory with lake root ID, relative paths, table identity, size, feasible hash with `hash_status`, `file_inventory_mode`, and inventory source. `backup_id`, `restore_mode`, and the cleanup-protection window are recorded in kernel tables and joined by `manifest_id`, not embedded in the immutable manifest.
- `REQ-LIN-06` (`not_publishable` diagnostic quarantine): Parsed output that exists without its raw capture evidence (`REQ-SRC-RAW-FAILCLOSED` in [[PRJ-AI-CCC-DuckLake-v7.2.3-Provider-Capability-And-Availability]]) is stored, if at all, only as diagnostic evidence explicitly marked `not_publishable`, in a quarantine path outside the publishable lineage. No manifest may include a `not_publishable` artifact in its source inputs or file inventory; a batch whose only source evidence is `not_publishable` can never reach `manifested`. Fixtures produced by docs-derived adapter drafts (`REQ-SRC-DRAFT`) are synthetic/sample evidence and MUST be labeled as such — they never masquerade as vendor source evidence in any manifest or lineage record. Backed by `test_not_publishable_artifacts_never_enter_manifest_inputs`.
- `REQ-LIN-REGRESS`: Golden-file/artifact regression checks for manifests, validation reports, runtime-verification JSON, `failed_run_diagnosis`, and small Polars/DuckDB result fixtures may use `pytest-regressions` or `syrupy`, with exactly one snapshot stack chosen under `REQ-AUTH-DEP-01` — ordered candidates: `pytest-regressions` first, `syrupy` only if the first fails its binary rubric (FBL2-23c). Canonical serialization stays custom: stable ordering, excluded/scrubbed runtime fields, path redaction, and timestamp normalization are repo-defined.
- `REQ-LIN-07` (v7.2.3): the lineage id-chain (`manifest_id` → `batch_id` → `source_batch_id`) is REQUIRED and non-null at every write-path hop — every function or CLI command that writes a source batch, publish manifest, or kernel batch row receives and persists the full chain as mandatory parameters, never defaulted and never reconstructed post-hoc. Enforcement reuses the `REQ-GUARD-08` static-reachability scan in [[PRJ-AI-CCC-DuckLake-v7.2.3-Architecture-Context-And-Bootstrap]] (one tool, two tagged sets: PIT/lineage primitives generally, the id-chain fields specifically). Rationale: the archive-frozen predecessor exported a lineage id (`load_id`) that never reached its primary write path — present in the data model, absent from every written row. Backed by `test_lineage_id_chain_is_required_non_null_at_every_write_path_hop`.
- Manifest version migration (v7.2.3): any bump of `manifest_version` MUST preserve readability of prior-version manifests (a versioned reader or read-side migration), proven before the bump ships; sealed manifests are immutable, so readability of old shapes is the only legal migration surface. Backed by `test_manifest_version_bump_migration_preserves_prior_version_readability`.

## Manifest Shape

Every immutable publish manifest binds only the data-generation and publication inputs known at seal time: source evidence, validation, code/environment, DuckLake snapshot, physical files, contracts, policies, and caveats. Backup, restore, and cleanup are post-seal lifecycle facts and live only in kernel tables and restore/observability schemas joined back by `manifest_id`. An operator-facing publish bundle may render a combined manifest plus backup plus restore plus cleanup view, but it never rewrites or appends to the sealed file. The manifest schema version does not need to match the PRD version; this seed is `manifest_version: 3`, the first shape that excludes post-seal backup/restore/cleanup lifecycle so the file can be hashed and sealed before any backup exists.

> [!important] Manifest hash rule (`MR1`)
> `manifest_sha256` is a detached kernel lifecycle fact, not a field inside the sealed manifest body. The sealed authoring form may be YAML or JSON, but the bytes hashed for `manifest_sha256` are always the UTF-8 bytes of the RFC 8785 JSON Canonicalization Scheme representation of the manifest data: no `manifest_sha256`, no backup, no restore, no cleanup, and no publication-lifecycle fields are present in that canonical object. The project JCS profile forbids duplicate keys, `NaN`, `Infinity`, and binary floats for money/decimal identifiers; decimals, strikes, hashes, timestamps, and IDs serialize as strings. This canonical-JSON hashing applies only to metadata, manifests, fingerprints, approval records, and small verification records, never to raw market data or Parquet payloads.
> Backed by `test_manifest_sha256_is_detached_and_stable`, `test_manifest_hash_uses_rfc8785_canonical_json_bytes`, and `test_canonical_json_authority_vectors_reject_ad_hoc_json_dumps_sort_keys`.

```yaml
manifest_version: 3
manifest_id: manifest_sample_equity_1d_20260607
batch_id: batch_sample_equity_1d_20260607
dataset:
  name: equity_bar_1d
  contract_version: 1
  registry_version: 1
source_batches:
  - source_batch_id: source_synthfix_equity_1d_sample_001
    provider: synthfix
    source_dataset: equity_bar_1d_fixture
    source_version: synthfix_fixture_v1
    raw_paths:
      - raw/synthfix/equity_bar_1d/fixture/sample.csv.gz
    input_hashes:
      raw/synthfix/equity_bar_1d/fixture/sample.csv.gz: sha256:example
    source_available_min: 2015-01-02T21:05:00Z
    source_available_max: 2015-01-03T21:05:00Z
transform:
  code_version: git:example_sha
  environment_lock: uv.lock:sha256:example
  cli_command: qdbctl manifest --dataset equity_bar_1d --batch-id batch_sample_equity_1d_20260607 --scratch
validation:
  status: passed
  artifact_id: validation_sample_equity_1d_20260607
  report_path: validation/manifest_sample_equity_1d_20260607.json
  report_hash: sha256:example
output:
  ducklake_snapshot_id: snapshot_example
  lake_root_id: scratch_lake_root_example
  file_inventory_source: qdb_lake.maintenance.list_snapshot_files
  file_inventory_mode: files
  inlined_row_count: 0
  tables:
    - silver.equity_bar_1d
  # file_inventory is the single structured source of truth for canonical data files (`CL6`):
  file_inventory:
    - table: silver.equity_bar_1d
      relative_path: silver/equity/bar_1d/year=2015/month=01/session_date=2015-01-02/part-000.parquet
      size_bytes: 123456
      content_hash: sha256:example
      hash_status: sha256
      hash_reason: null
      delete_file_metadata: null
  row_count: 12345
  valid_time_min: 2015-01-02T14:30:00Z
  valid_time_max: 2015-01-02T21:00:00Z
  source_available_min: 2015-01-02T21:05:00Z
  source_available_max: 2015-01-03T21:05:00Z
policies:
  pit_policy: source_available_at
  adjustment_policy: raw
  source_availability_policy_id: synthfix_equity_close_v1
caveats:
  - sample fixture only
```

Listing: Manifest seed; placeholder values show structure, not real data. This is the Phase 0 `synthfix` manifest. A live-provider manifest follows the identical shape with that provider's identifiers, raw paths, and source-availability policy ID. (`CR-006`) The `source_available_min`/`source_available_max` aggregates shown above (both at `source_batches` and `output` level) are informational only; per-row visibility gating is a Kernel rule, not derived from these manifest aggregates.

> [!check] Committed canonical-JSON test vector (`MR1`)
> The repo ships at least one real known-input to known-hash pair. For the payload `{"dataset": "equity_bar_1d", "batch_id": "batch_sample_equity_1d_20260607", "partition_scope": "full", "contract_version": 1}`, the RFC 8785 byte string is exactly `{"batch_id":"batch_sample_equity_1d_20260607","contract_version":1,"dataset":"equity_bar_1d","partition_scope":"full"}` and its SHA-256 is `48d74a217561789e033c884ec1878236621e243a22ff5792b6e9153fb9f83fee`. The selected canonical JSON authority must reproduce these bytes and digest before manifest seal; default `json.dumps(sort_keys=True)` yields different bytes and fails the vector. Backed by `test_rfc8785_known_vector_matches`.

> [!important] Restore bundle inventory (`MR2`)
> `restore_bundle_inventory.v1.json` is a comprehensive copied-root restore inventory without duplicating large manifest inventories. It references the sealed manifest data-file inventory by `manifest_id`, `manifest_path`, `file_inventory_sha256`, `file_inventory_entry_count`, and the copied data-root mapping; it may include `ducklake_data_file` entries directly only for fixture/small inventories or sharded inventory artifacts. It also enumerates non-DuckLake evidence artifacts required to make the restored lake auditable: raw evidence, sealed manifests, validation reports, dataset contracts, provider capability packs, source-availability policies, runtime-verification records, catalog/globals dumps, diagnosis artifacts, and restore evidence. The sealed manifest remains the canonical source of truth for DuckLake data-file tracking; the restore bundle is the bounded copy set and proof surface for the restore operation.

> [!important] Catalog `DATA_PATH` relocation on restore (`MR3`)
> DuckLake stores `DATA_PATH` and absolute file paths in the PostgreSQL catalog, so restoring the catalog into a fresh PostgreSQL database and copying files to a different root is a relocated root, not a same-path restore. To make a copied-root restore resolve relocated data files rather than silently pointing back at the original root, `ATTACH` must use a relative `DATA_PATH` anchored to configured `QDB_LAKE_ROOT`, or the restore step must perform an explicit `OVERRIDE_DATA_PATH`/path-rewrite step and honor its documented caveat. Exact syntax and caveats are verification items resolved from official DuckLake docs or runtime probe, never assumed. Copied-root `DATA_PATH` relocation is part of the v1 copied-root restore and is DISTINCT from the deferred "remapped-root restore" (re-pointing an existing catalog at a different root without a fresh copy); deferring the latter does not defer this relocation step (FBL2-24). Backed by `test_restore_resolves_relocated_data_root`.

## Adversarial PIT Fixture Seed

These fixtures are the concrete inputs and expected answers behind named PIT RED tests. Every identifier is a synthetic fixture value, including ticker `ACME`, `security_id 1001`, `CIK 0000000001`, and FRED series `TESTRATE`; they must never be confused with real instruments.

```text
tests/fixtures/
  security_identity/
    acme_identity.yaml
  symbol_alias_bt/
    acme_alias.yaml
  equity_bar_1d/
    backfill_amnesia.yaml
    vendor_correction.yaml
  corporate_action_bt/
    split_pit_adjustment.yaml
  fundamental_fact_bt/
    sec_accepted_vs_disseminated.yaml
  macro_observation_vintage/
    fred_vintage_revision.yaml
  option_eod_quote/
    low_premium_retention.yaml
  feature_set/
    feature_availability.yaml
  session_day/
    session_day_point_in_time.yaml
  mixed_availability_supersession/
    mixed_availability_correction.yaml
  dst_midnight/
    dst_midnight_instants.yaml
  expected/
    <one expected-result file per case, including the four normative cases>
```

Listing: Fixed adversarial fixture tree.

Fixture determinism is the DoD linchpin. The `.yaml` files are human-authored scenario specs and are the source of truth. A deterministic generator, `task fixtures:build`, materializes from them the committed `raw/synthfix/**/*.csv.gz` raw evidence that `synthfix` stages and the `expected/` result files, using UTF-8, `\n` line endings, a header row in contract column order, rows sorted by dataset logical key, and gzip written with `gzip -n` and zeroed mtime so compressed bytes are reproducible. `schema_fingerprint` in `provider_capabilities/synthfix.yaml` is computed per dataset lane as SHA-256 over that lane's header row, then combined as SHA-256 over the newline-joined per-lane hex digests sorted by dataset name (`synthfix` spans three dataset lanes; a single-dataset provider reduces to its one lane hash) (FBL2-23f); `sample_hash` combines identically over per-lane full-`csv.gz`-bytes hashes. Every manifest `input_hashes` value and every manifest `file_inventory.content_hash` value remains SHA-256 over the full generated `csv.gz` bytes where the entry references generated fixture evidence.

> [!important] Fixture-build determinism and fixture-spec schema (`SF2`)
> `task fixtures:build` writes generated raw files to a temporary build directory and compares them to committed `tests/fixtures/raw/synthfix/**/*.csv.gz`; it must not silently mutate committed fixtures during verification. If hashes differ, the task fails and prints the explicit update command. Every `tests/fixtures/**/*.yaml` scenario spec validates against `schemas/fixture_spec.schema.json` and carries `case_id`, `dataset`, `contract_version`, `input_rows`, `expected_queries`, `expected_lineage`, and `negative_cases`. Backed by `task fixtures:build` idempotency and the CI pack-hash recompute.

> [!important] Synthetic identity fixtures for `ACME` (`QD11`)
> `tests/fixtures/security_identity/acme_identity.yaml` and `tests/fixtures/symbol_alias_bt/acme_alias.yaml` are Phase 0 blocking fixtures. They map synthetic ticker `ACME` to `security_id: 1001`, `primary_symbol: ACME`, `asset_class: equity`, `cik: "0000000001"`, and knowledge/valid intervals covering the bars, fundamentals, corporate-action, and options fixture windows. Bars and fundamentals symbol-selector tests must traverse these identity fixtures; a test that joins directly on `symbol_at_source` or CIK without the PIT resolver is a failing bypass. `ACME2` (the second key of the mixed-availability correction fixture) maps to `security_id: 1002` in `acme_identity.yaml`, with its own alias row and identity intervals covering the correction window; it is a distinct synthetic security, never an alias of `ACME` (FBL2-15). `TESTRATE` is a macro `series_id`, not a security symbol, and must not appear in `security_identity` or `symbol_alias_bt`.

> [!important] Corporate-action split PIT-adjustment fixture (`QD7`)
> `tests/fixtures/corporate_action_bt/split_pit_adjustment.yaml` seeds the split-leakage vector with concrete synthetic values: a split on `ACME` with declaration/availability time and ex-date, two `known_at` values straddling action availability, and expected `raw` versus `point_in_time_split_adjusted` versus `point_in_time_total_return` closes at each `known_at`. PIT adjustment requires both `source_available_at <= known_at` and `ex_date <= :as_of_valid_date`, so a split not yet available at `known_at` must not adjust historical price. Adjustment math is not implemented in Phase 0; adjustment functions raise `NotImplementedError` pass-through stubs, and `test_future_split_not_used_in_pit_adjusted_price` runs only in the adjustment phase.

The four fixtures immediately below are NORMATIVE: the named tests are valid only when run against fixtures containing these discriminating cases.

### Feature-Availability Fixture

Synthetic input facts where `max(source_available_at) > max(valid_at)`: a fact valid `2024-03-01` but only available `2024-03-05`.

| Column | Value |
|---|---|
| `security_id` | `1001` |
| `symbol_at_source` | `ACME` |
| `valid_at` | `2024-03-01T00:00:00Z` |
| `source_available_at` | `2024-03-05T00:00:00Z` |

Table: Synthetic feature-availability fixture row.

Expected: the derived feature's `known_at == max(source_available_at)` (`2024-03-05T00:00:00Z`), never `max(valid_at)`; a full-sample z-score build that uses future-relative-to-`known_at` rows is rejected. Committed at `tests/fixtures/feature_set/feature_availability.yaml` with expected results in `tests/fixtures/expected/feature_availability.yaml` (FBL2-08, FBL2-15); input rows are generic `(entity, valid_at, source_available_at)` facts, not rows of a published dataset. Expected entries: derived feature `known_at == 2024-03-05T00:00:00Z` (1 row), and the full-sample z-score build over this fixture raises its named rejection. Backs `test_feature_known_at_equals_max_source_available_at_not_valid_at` and `test_full_sample_zscore_rejected_in_pit_feature_build` (both gated `xfail(strict=True)` until feature tables exist).

### Session-Day Fixture

One synthetic `equity_bar_1d`-family row where `valid_time_start == valid_time_end == 2024-03-15` (a session-day bar).

| Column | Value |
|---|---|
| `security_id` | `1001` |
| `symbol_at_source` | `ACME` |
| `valid_time_start` | `2024-03-15T00:00:00Z` |
| `valid_time_end` | `2024-03-15T00:00:00Z` |

Table: Synthetic session-day equality fixture row.

Expected: a point-in-time query at exactly `2024-03-15T00:00:00Z` returns this row; half-open interval logic (`valid_time_start <= t < valid_time_end`) must not drop it merely because the interval endpoints are equal. Committed at `tests/fixtures/session_day/session_day_point_in_time.yaml` — a dedicated mini-contract declaring `valid_time: {at: session_date, semantics: point_in_time}` — with expected results in `tests/fixtures/expected/session_day_point_in_time.yaml`: the probe at `2024-03-15T00:00:00Z` expects exactly 1 row (FBL2-01, FBL2-15). The test proves the point_in_time declaration path; it MUST NOT be implemented as an equality exception inside the shared half-open evaluator. Backs `test_session_day_valid_time_returned_at_equality_not_dropped_by_half_open`.

### Mixed-Availability Correction Fixture

One synthetic correction batch touching two keys, whose replacement rows carry different `source_available_at` values.

| Key | Superseded value | Replacement value | Replacement `source_available_at` |
|---|---|---|---|
| `ACME` | `100.00` | `100.75` | `2024-04-02T10:00:00Z` |
| `ACME2` | `50.00` | `50.25` | `2024-04-02T16:30:00Z` |

Table: Synthetic mixed-availability correction batch rows.

Expected: each superseded key's `known_to` closes at ITS OWN replacement's `source_available_at`, not the batch max (`2024-04-02T16:30:00Z`) applied uniformly. `ACME` closes at `2024-04-02T10:00:00Z`; `ACME2` closes at `2024-04-02T16:30:00Z`. Committed at `tests/fixtures/mixed_availability_supersession/mixed_availability_correction.yaml` with expected results in `tests/fixtures/expected/mixed_availability_correction.yaml` (FBL2-15): probes expect, at `known_at = 2024-04-02T09:00:00Z`, the two original values (`100.00`, `50.00`); at `2024-04-02T12:00:00Z`, `ACME` corrected (`100.75`) while `ACME2` still shows `50.00`; at `2024-04-02T17:00:00Z`, both corrected (`100.75`, `50.25`) — one row per key at every probe. Backs `test_mixed_availability_batch_closes_each_key_at_its_own_replacement_source_available_at`.

### DST/Midnight Instant Fixture

Availability timestamps at `2024-11-03T05:30:00Z` (US DST fall-back day) and `2024-03-10T00:15:00Z` (straddling UTC midnight).

| Case | `source_available_at` (UTC instant) |
|---|---|
| DST fall-back | `2024-11-03T05:30:00Z` |
| UTC-midnight straddle | `2024-03-10T00:15:00Z` |

Table: Synthetic DST/midnight instant fixture rows.

Expected: availability comparisons are UTC-instant comparisons; a date-truncated comparison (dropping time-of-day before comparing) gives a different, wrong answer on this fixture. Committed at `tests/fixtures/dst_midnight/dst_midnight_instants.yaml` with expected results in `tests/fixtures/expected/dst_midnight_instants.yaml` (FBL2-15): each case is one `equity_bar_1d`-family row for `security_id: 1001` whose `source_available_at` is the named instant, and each probe queries ONLY its own case's row (the expected counts are per case, not whole-fixture). Probes at `2024-11-03T01:00:00Z` and `2024-03-09T23:50:00Z` expect 0 rows; probes at `2024-11-03T05:30:00Z` and `2024-03-10T00:15:00Z` expect 1 row each. The discriminating wrongness is split across the cases: truncating the AVAILABILITY timestamp to a date wrongly returns 1 row at the `2024-11-03T01:00:00Z` probe, and truncating the PROBE instant to a date-start wrongly returns 0 rows at the `2024-03-10T00:15:00Z` probe. Backs `test_availability_comparison_is_utc_instant_across_dst_and_midnight`.

> [!note] SEC after-hours dissemination discriminator is not a Phase-0 fixture (`CR-008`)
> The SEC after-hours dissemination discriminator is intentionally NOT a Phase-0 fixture: `publicly_disseminated_at` remains `fixture_only`. The live-enablement gate and the conservative availability policy own that risk, not a committed Phase-0 fixture case.

## Worked Example: Backfill Amnesia

One synthetic `equity_bar_1d` row for `ACME`, session `2015-12-30`, disseminated at the close but not ingested locally until 2026. The trap is that if late ingestion (`ingested_at = 2026`) were allowed to set `source_available_at`, an as-of-2015 query would wrongly return nothing.

| Column | Value |
|---|---|
| `security_id` | `1001` |
| `symbol_at_source` | `ACME` |
| `session_date` | `2015-12-30` |
| `bar_start_at` | `2015-12-30T14:30:00Z` |
| `bar_end_at` | `2015-12-30T21:00:00Z` |
| `open / high / low / close` | `99.50 / 100.25 / 99.10 / 100.00` |
| `volume` | `1000000` |
| `adjustment_state` | `raw` |
| `source / source_version` | `synthfix / 2015-12-30.v1` |
| `source_available_at` | `2015-12-30T21:00:00Z` |
| `known_to` | `NULL` |
| `vendor_correction_available_at` | `NULL` |
| `ingested_at` | `2026-06-01T12:00:00Z` |
| `lake_published_at` | `2026-06-01T13:00:00Z` |

Table: Synthetic backfill-amnesia input row.

```text
get_bars_asof(symbols=["ACME"], start=date(2015, 12, 30), end=date(2015, 12, 30),
              known_at=datetime(2015, 12, 31, tzinfo=timezone.utc), adjustment_policy="raw")
 # predicate: source_available_at(2015-12-30T21:00:00Z) <= known_at(2015-12-31T00:00:00Z)
 #            AND (known_at < known_to OR known_to IS NULL) -> TRUE
 # => 1 row, close == 100.00
```

Listing: Positive backfill-amnesia query and expected result.

```python
QdbLineageV1(
    lineage_schema_version=1,
    dataset="equity_bar_1d",
    manifest_id="mf_synthfix_equity_1d_0001",
    ducklake_snapshot_id="<snapshot-under-test>",
    source_tables=["silver.equity_bar_1d"],
    source_batches=["sb_synthfix_equity_1d_2015"],
    source_availability_policy_ids=["synthfix_equity_close_v1"],
    known_at=datetime(2015, 12, 31, 0, 0, tzinfo=timezone.utc),
    filters={"symbols": ["ACME"], "start": "2015-12-30", "end": "2015-12-30"},
    adjustment_policy="raw",
    max_input_availability=datetime(2015, 12, 30, 21, 0, tzinfo=timezone.utc),
    row_count=1,
    caveats=[],
)
```

Listing: Expected `QdbLineageV1` for the positive query.

```text
get_bars_asof(symbols=["ACME"], start=date(2015, 12, 30), end=date(2015, 12, 30),
              known_at=datetime(2015, 12, 30, 12, tzinfo=timezone.utc), adjustment_policy="raw")
 # predicate: source_available_at(2015-12-30T21:00:00Z) <= known_at(2015-12-30T12:00:00Z) -> FALSE
 # => 0 rows
```

Listing: Negative no-intraday-lookahead query and expected result. Backs `test_backfill_amnesia_prevention`.

## Worked Example: Vendor Correction

Two synthetic `equity_bar_1d` rows for the same `ACME` session `2015-12-30`: an original print and a later vendor correction. The original is knowledge-time-bounded by `known_to`; the correction opens at its `vendor_correction_available_at`.

| Row | `close` | `source_available_at` (`known_from`) | `known_to` | `vendor_correction_available_at` |
|---|---|---|---|---|
| original | `100.00` | `2015-12-30T21:00:00Z` | `2016-01-05T15:00:00Z` | `NULL` |
| corrected | `100.50` | `2016-01-05T15:00:00Z` | `NULL` | `2016-01-05T15:00:00Z` |

Table: Synthetic vendor-correction rows.

Expected: `known_at="2016-01-04T00:00:00Z"` returns one row with `close == 100.00`; `known_at="2016-01-06T00:00:00Z"` returns one row with `close == 100.50`, with lineage whose `caveats` records supersession of the original. Backs `test_vendor_correction_not_visible_before_correction_available_at`.

## Worked Example: SEC Accepted Versus Disseminated

One synthetic fact for `CIK 0000000001` (`ACME`), fiscal period ending `2023-12-31`, accession `0000000001-24-000001`.

| Column | Value |
|---|---|
| `fact_name` | `Revenues` |
| `fiscal_period_end` | `2023-12-31` |
| `value` | `1000000.00` |
| `accession` | `0000000001-24-000001` |
| `accepted_at` | `2024-02-15T22:00:00Z` |
| `publicly_disseminated_at` | `fixture_only` |
| `source_available_at` | `2024-02-15T22:00:00Z` |

Table: Synthetic SEC accepted-versus-disseminated fact.

Expected: `get_fundamentals_asof(symbols=["ACME"], concepts=["Revenues"], known_at="2024-01-15T00:00:00Z")` returns zero rows because fiscal-period end alone does not authorize the fact; `known_at="2024-02-16T00:00:00Z"` returns one row. Backs `test_sec_accepted_at_controls_availability` and `test_sec_fiscal_period_end_does_not_authorize_fact`. (`PA-12`) The canonical name for `test_sec_accepted_at_controls_availability` is `test_sec_source_available_at_controls_availability` (PIT module); this is the same test, single implementation, referenced under both names.

## Worked Example: FRED Vintage Revision

Two synthetic vintages of series `TESTRATE` for observation period `2023-12-01`. Date-only vintages use the conservative end-of-day availability policy, so vendor `realtime_start` is preserved for lineage but is not itself the query knowledge clock.

| Vintage | `value` | `realtime_start` | `realtime_end` | `source_available_at` | `known_to` |
|---|---|---|---|---|---|
| first | `3.50` | `2024-01-10` | `2024-02-10` | `2024-01-11T00:00:00Z` | `2024-02-11T00:00:00Z` |
| revised | `3.70` | `2024-02-10` | `NULL` | `2024-02-11T00:00:00Z` | `NULL` |

Table: Synthetic FRED vintage rows.

Expected under predicate `source_available_at <= :known_at AND (:known_at < known_to OR known_to IS NULL)`: `known_at="2024-01-10T12:00:00Z"` returns empty result; `known_at="2024-01-15T00:00:00Z"` returns `value == 3.50`; `known_at="2024-03-01T00:00:00Z"` returns `value == 3.70`. Backs `test_fred_vintage_asof` and `test_fred_same_day_release_policy`.

## Worked Example: Options Low-Premium Retention

Two synthetic `option_eod_quote` rows on underlying `ACME` are retained identically in raw/bronze/silver; a gold mart filters one out but keeps lineage to both.

| `option_contract_key` | `premium` | Moneyness | Retained in raw/silver? | In `liquid_options_gold` (`premium >= 0.05`)? |
|---|---|---|---|---|
| `SID1001-20160115-C-250.000-100` | `0.02` | far OTM | yes | no |
| `SID1001-20160115-C-100.000-100` | `5.00` | ATM | yes | yes |

Table: Synthetic options low-premium retention rows.

Expected: both rows are present in silver; only the second appears in `liquid_options_gold`; the gold row's lineage references the retained silver observations for both contracts. No premium/liquidity/moneyness filter ever deletes a raw/bronze/silver record. Backs `test_options_low_premium_raw_records_retained` and `test_options_raw_retained_when_gold_filters`.

## Owner-Local Tests Preserved

- `test_manifest_physical_file_excludes_backup_restore_cleanup_lifecycle_fields`
- `test_backup_restore_cleanup_lifecycle_lives_in_kernel_tables`
- `test_restore_mode_and_file_inventory_mode_are_distinct`
- `test_manifest_version_is_3`
- `test_manifest_sha256_is_detached_and_stable`
- `test_publish_manifest_contract_matches_kernel_ddl_and_manifest_seed`
- `test_source_batch_contract_matches_kernel_ddl_structured_paths_and_hashes`
- `test_snapshot_file_hash_status_recorded_and_skips_have_reason`
- `test_manifest_hash_uses_rfc8785_canonical_json_bytes`
- `test_canonical_json_authority_vectors_reject_ad_hoc_json_dumps_sort_keys`
- `test_canonical_json_authority_backlog_blocks_manifest_seal`
- `test_restore_bundle_inventory_required_artifacts_present`
- `test_restore_resolves_relocated_data_root`
- `test_fixture_build_is_idempotent_and_does_not_mutate_committed_raw`
- `test_acme_security_identity_fixture_required_for_bars_symbol_selector`
- `test_acme_symbol_alias_fixture_required_for_fundamentals_selector`
- `test_backfill_amnesia_prevention_uses_pit_identity_resolver`
- `test_generated_schemas_are_snapshot_tested_after_generation`
- `test_schema_regeneration_refuses_fields_not_named_by_prd_seed`
- `test_provider_capability_policy_id_scalar_and_synthfix_list_shapes_validate`
- `test_provider_capability_rejects_both_scalar_and_list_policy_keys`
- `test_validation_report_schema_backs_quality_and_coverage_fields`
- `test_fixture_specs_validate_against_schema`
- `test_publish_manifest_schema_is_validated`

Table: Manifest, lineage, schema, restore-bundle, and fixture-local tests preserved from the v6.5.0 phase and determinism lists.

## v7.2.3 field, path, and host-schema amendments

AMD-007 makes runtime-verification field authority closed: base fields are explicit; resolved records require `source`, `observed_output_hash`, `resolved_value`, and `verified_at`; open records require `fallback_status` and `kill_or_pivot` while `source` is nullable; `sentinel_wrapper_targets`, `resolved_value_shape`, and `gate_rule` have declared shapes. Regenerated schemas must exactly match the owner fields.

AMD-023 states that DuckLake paths may be relative or absolute. `OVERRIDE_DATA_PATH` is connection-local and never rewrites stored metadata; copied-root attach and relocation proof remain mandatory.

AMD-049 routes host schemas from exact field dictionaries in [[PRJ-AI-CCC-DuckLake-v7.2.3-Physical-Host-Bootstrap-And-Cutover]]. This module applies closed-schema, canonicalization, provenance, example, and no-invention rules only. Committed examples exclude live topology and secret values.

## v7.2.3 r2 restored indexed acceptance criterion

- `test_runtime_verification_schema_open_and_resolved_requiredness`: an open record requires its blocking gate, fallback, and stop-or-pivot fields, while a resolved record additionally requires approved authority, command, timestamp, resolved value, and a recomputable observed-output hash; neither state may omit its required fields.
