---
type: prj
domain: ccc
status: active
date_created: 2026-06-28
date_modified: 2026-07-11
version: 7.2.3
---

# CCC DuckLake v7.2.3 Verification Benchmarks Readiness

This module is the v7.2.3 structural port for phase gates, benchmark gates, verification backlog, external-claim governance, unresolved risks, readiness checklist, `VERIFY::` sentinel inventory, acceptance-test cross-index, and whole-system proof bundle expectations. It indexes owner-local tests without becoming competing authority for requirement-specific definitions that belong in owner modules.

## Module Boundary

**Owns:** phase/test matrix, active-phase dispatch rules, benchmark classes and record-only/must-pass threshold policy, external-claim governance, seeded verification backlog, external verification-before-coding/purchase list, core implementation verification items, contract-closure verification items, unresolved risks ledger content, implementation readiness checklist, `VERIFY::` sentinel inventory, acceptance-test cross-index, whole-system integrity/proof posture, and final proof-bundle expectations.

**Depends On:** [[PRJ-AI-CCC-DuckLake-v7.2.3-Executive-Contract-And-Authority]] for authority hierarchy and Definition of Done; [[PRJ-AI-CCC-DuckLake-v7.2.3-Architecture-Context-And-Bootstrap]] for architecture phase map and dependency context; [[PRJ-AI-CCC-DuckLake-v7.2.3-Publish-Control-Kernel]] for state and transition invariants; [[PRJ-AI-CCC-DuckLake-v7.2.3-PIT-And-Bitemporal-Policy]] for point-in-time clock and leakage semantics behind the highest-risk-class tests; [[PRJ-AI-CCC-DuckLake-v7.2.3-Ops-Recovery-Maintenance-Security]] for restore/maintenance/security/observability owner tests; [[PRJ-AI-CCC-DuckLake-v7.2.3-Orchestration-And-QDBCTL]] for Dagu/qdbctl owner tests; [[PRJ-AI-CCC-DuckLake-v7.2.3-QDB-Agent-Access-And-SQL-Zero]] for `qdb` owner tests; [[PRJ-AI-CCC-DuckLake-v7.2.3-Dataset-Contracts-And-Validation]] for contract/validation owner tests; [[PRJ-AI-CCC-DuckLake-v7.2.3-Provider-Capability-And-Availability]] for provider/source-adapter gates; [[PRJ-AI-CCC-DuckLake-v7.2.3-Manifests-Lineage-And-Fixtures]] for manifest/fixture/schema owner tests; [[PRJ-AI-CCC-DuckLake-v7.2.3-Modeling-Engine-Interface]] for gated interface tests.

**Read After:** all owner modules listed above, then use [[REF-AI-DuckLake-v7.2.3-BlockingTestIndex]] as the authoritative flat proof-row index.

**Non-Authoritative Restatements:** Requirement-specific `test_*` names stay with the module that owns the behavior; this note is the cross-module index and phase gate owner. Kernel state semantics, dataset schemas, `qdb` APIs, provider enablement, manifest shapes, and ops procedures are linked and indexed here but remain authoritative in their owner modules.

## Source Port

| Source | Ported content |
|---|---|
| Primary PRD 3421-3443 | Phase/test matrix, active-phase dispatch, Phase 0.5 closure, and direct task gates. |
| Primary PRD 3445-3460 | Phase 0 research-sanity example and first-15-minutes walkthrough proof. |
| Primary PRD 3462-3707 | Acceptance tests by phase and risk class, preserved as a cross-module index with owner-routing notes. |
| Primary PRD 3708-3759 | Benchmark classes, failure responses, ClickHouse escape criterion, record-only vs must-pass gate policy, and baseline document shape. |
| Primary PRD 3761-3781 where verification-facing | Safety/redaction proof expectations linked to Ops owner. |
| Primary PRD 3783-3862 | External claim governance and seeded verification backlog with representative `backlog.seed.yaml` records. |
| Primary PRD 3864-3934 | External verification before coding or purchase, core implementation verification items, and contract-closure/modeling-interface verification items. |
| Primary PRD 3936-3983 | Unresolved risks and implementation readiness checklist. |
| Primary PRD 3984-3997 | Implementation operating contract restated as readiness/proof routing, with root/control authority preserved. |

Table: v6.5.0 source ranges structurally ported into this module.

## Phase/Test Matrix

A fresh agent must know what blocks the core build versus what belongs to a separate lane. Each task gate proves only its phase without pulling deferred work into the green gate.

The active phase source is explicit. The scaffold creates `qdb_project.yaml` with `active_phase: phase0`; `task verify` reads that value and dispatches to the matching phase gate. `QDB_ACTIVE_PHASE` may override the file for one command invocation, but only with one of `phase0`, `phase1`, `iface`, `options`, `retrieval`, or `prelive`; any other value fails before running tests. `task verify:phase0`, `task verify:phase1`, `task verify:iface`, `task verify:options`, `task verify:retrieval`, and `task verify:prelive` remain direct aliases and never infer phase from branch name, implemented modules, or available source adapters. `task verify:phase1` covers the core Phase 1 work only; Phase 1.5 panel/fill/coverage/session work is wired only to `task verify:iface`.

Phase 0.5 is a documentation grouping, not a separate active phase. `iface` is the active-phase value for Phase 1.5, not an IFACE stub license: no IFACE implementation exists until that gate opens. `task verify:phase0` MUST execute every Phase 0 AND Phase 0.5 RED/closure test: runtime-verification record, DuckLake API bindings, manifest/lifecycle split, `qdbctl` grammar, dtype map, exact refusals, diagnose renderer, `hash_status` plus serialization retry, enabled `synthfix` full-path, examples, guardrails, and the gated/`xfail` `REQ-IFACE-*` leakage tests. The `active_phase` enum stays `{phase0, phase1, iface, options, retrieval, prelive}`; `phase0_5` is intentionally not a value. CI MUST fail if any row in the Phase 0.5 Contract Closure table maps to no test wired into `task verify:phase0`, or if any Phase 0/0.5 safety-bearing artifact/backlog surface named by the PRD is absent from the generated seed. This is enforced mechanically by the implementation-index `Blocking?` column and artifact/schema/backlog columns. The pytest marker vocabulary is closed (FBL2-23a): `phase0`, `phase1`, `iface_gated`, `options`, `retrieval`, `prelive`, `future_sql`, and `adjustment_gated`; the implementation-index `Pytest marker` column uses exactly these values. The [[REF-AI-DuckLake-v7.2.3-BlockingTestIndex]] `phase` column maps onto markers one-to-one: `phase0`→`phase0`, `phase0_gated_xfail`→`iface_gated` (collected with `xfail(strict=True)`), `phase1`→`phase1`, `phase1b`→`options`, `adjustment_gated`→`adjustment_gated` (gated until the adjustment phase opens), and `prelive`/`retrieval`/`future_sql` map to themselves. Gated `REQ-IFACE`/feature tests are `xfail(strict=True)` while `active_phase != iface` — strict, so a silent XPASS fails loudly instead of hiding an accidental early implementation.

| Gate | Proves | Blocking? |
|---|---|---|
| `task verify` | The active phase named by `qdb_project.yaml` or one-command `QDB_ACTIVE_PHASE` override | Yes, for the active phase. |
| `task test:unit` | Pure unit tests with no Docker, live sources, NAS, or running PostgreSQL | Yes for every phase. |
| `task test:integration` | Testcontainers PostgreSQL 16 suite or explicit `QDB_TEST_POSTGRES_DSN`, with Docker preflight and no silent localhost | Yes when integration tests are selected. |
| `task verify:phase0` | Scaffold, config refusal, two-client coordination, kernel DDL/transition matrix, manifest/validation/snapshot/backup-bound visibility, SQL-zero `qdb` `known_at` rejection, Dagu lint and validated publish, copied-root restore-with-files, validation tiers, failed-publish diagnostic bundle, every Phase 0.5 contract-closure proof, and the gated `REQ-IFACE-*` leakage `xfail`s | Yes; nothing scales until green. |
| `task verify:ducklake-api` | Runs `scripts/probe_ducklake_api.py` to resolve Phase 0 `qdb_lake.maintenance` binding sentinels (`list_snapshot_files`, `flush_inlined_data`, `cleanup_old_files` dry-run, `expire_snapshots` dry-run) against the pinned DuckDB/DuckLake build or explicit metadata-table fallback, records `docs/runtime-verification/ducklake_api.json`, emits committed `src/qdb_lake/generated_ducklake_bindings.py`, and records deferrals for `merge_adjacent_files`, `rewrite_data_files`, and `delete_orphaned_files` unless Phase 0 code calls them | Yes before any manifest is sealed; CI fails if a required sentinel survives or if a Phase 0 code path calls a deferred wrapper. |
| `task verify:phase1` | Equities/SEC/FRED core MVP, four-clock PIT, contracts, manifests, provider capability gate before any live adapter; includes `trading_calendar_bt` and `register_derived`, not panel/fill/session APIs | Yes for core. |
| `task verify:iface` | Phase 1.5 modeling-interface contracts: panel, fill/resample, coverage, session pin, and entity-resolution surfaces after Phase 1 is green | No; separate later gate, no Phase 0/1 stubs. |
| `task verify:source-adapter-gate` | Provider capability artifacts, Massive/Polygon schema and availability proof, SEC/FRED policy proof, DOD/Norgate evidence gates | Yes before live adapters. |
| `task verify:options` | Options EOD sample (identity, policy-gated clocks, chain slice, overlap reporting, caveats, raw retention) | No; may fail independently unless a shared contract test fails. |
| `task verify:retrieval` | Retrieval eval when feature-flagged on | No; absent from core verification. |
| `task verify:prelive` / `task smoke:nas` | NAS/storage capability probe, cleanup deletion proof, manifest file inventory match, redaction scan | Yes before non-scratch writes; not a Phase 0 scratch blocker. |

Table: Task gates; options and retrieval do not block Phase 0/1 unless shared contracts fail.

## Phase 0 Research-Sanity Example

`examples/01_phase0_research_sanity.py`, run via `task example:phase0`, is the end-to-end smoke a researcher reads first. It publishes the `synthfix` equity/SEC/FRED fixtures through the kernel, then walks the typed surface:

- `describe_dataset(...)` for an enabled dataset and for the gated `option_eod_quote` (showing `published = False`, `phase = "phase1b"`).
- `get_bars_asof(...)` before and after source availability (the second returns the bar; the first returns an empty full-schema frame with lineage).
- `get_fundamentals_asof(symbols=...)` before and after the SEC `accepted_at` clock.
- `get_macro_vintage(...)` before and after a vintage revision (old value, then revised value).
- `explain_query(...)` to show the bound half-open predicate without executing it.
- One valid empty result carrying full lineage (`row_count = 0`, resolved manifest/snapshot).
- One missing-`known_at` refusal (`MissingKnownAtError`) and one missing-`adjustment_policy` refusal (`MissingAdjustmentPolicyError`).
- `qdbctl kernel-status` to show batch states and locks.
- `qdbctl diagnose --batch-id <id> --format text` on a deliberately failed publish, plus at least one non-batch target such as `--cleanup-id <id>` in tests, reading what failed, what is visible to `qdb`, whether a snapshot committed or a manifest sealed, whether restore is required, and the exact next command derived from `operator_next_actions` rather than free prose.
- A copied-root scratch restore into a fresh catalog, then re-running one PIT query to prove the restored lake answers identically.

The example imports nothing from the vault and runs entirely on the `synthfix` fixtures, so it doubles as the human-readable proof that the fixture-complete Definition of Done holds. A top-level `README.md` quickstart links to this walkthrough as the first-15-minutes path for a new researcher: install, configure scratch roots, publish `synthfix`, query bars/fundamentals/macro, inspect lineage, read a refusal, diagnose a failed publish, and restore from a scratch copy.

## Acceptance Tests By Phase And Risk Class

These tests cover the first-release kernel, four-clock PIT, bootstrap, source hierarchy, provider gate, kernel transaction protocol, Dagu safety, validation tiers, observability, Testcontainers, copied-root restore, artifact seeds, and interface boundaries. Requirement-specific tests remain owned by their behavior modules; this section indexes the complete cross-module test surface and points implementers to the relevant owner notes. The authoritative flat blocking-test index ships as [[REF-AI-DuckLake-v7.2.3-BlockingTestIndex]] — a fenced CSV of every named test with phase and owner module (FBL2-07); the generated `docs/implementation-index.seed.csv` MUST diff clean against its `verify:phase0`-union rows under `task verify:phase0-index`.

### Phase 0 — Repo, Config, Coordination, Kernel

1. `test_repo_does_not_require_vault_root`: core commands run from the repo root and require no vault path.
2. `test_config_refuses_production_paths_in_default_tests`: default tests fail if lake root or catalog DSN points at production-looking NAS/catalog without an explicit live flag.
3. `test_destructive_commands_require_explicit_flag`: cleanup, restore, orphan deletion, production publish, and live download refuse without approval flags.
4. `test_two_clients_coordinate_through_postgres_catalog`: two independent DuckDB clients coordinate on a scratch DuckLake/PostgreSQL catalog with no shared mutable native DuckDB file.
5. `test_ducklake_two_clients_coordinate_on_scratch_catalog`: concurrent readers during publish and a second writer attempt serialize or fail safely via catalog locks.
6. `test_publish_validation_failure_not_visible_to_qdb`: a forced validation failure yields no published manifest, no `qdb`-visible dataset version, and no post-publish backup marker.
7. `test_dagu_aborts_publish_on_validation_failure`: invalid staging data halts the DAG and leaves the catalog untouched.
8. `test_publish_manifest_schema_is_validated`: manifests must conform to a versioned schema before publication completes.
9. `test_qdb_reads_only_published_manifests`: `qdb` does not read arbitrary latest snapshots, only kernel-published batches.
10. `test_postgres_catalog_restore_recovers_lake_files_and_pit_query`: restore to a fresh catalog proves table list, row counts, file existence, manifest/backup linkage, and a known PIT query.
11. `test_backup_artifact_has_checksum_and_restore_metadata`: backups carry checksum, snapshot ID, manifest ID, catalog identity, and lake root.
12. `test_restore_catalog_path_contract`: restore uses the v1 copied-root policy per `REQ-RESTORE-POLICY`; same-root is convenience smoke only and remapped-root is deferred.
13. `test_monitoring_artifacts_emitted`: Phase 0 emits JSON metrics for Dagu run status, backup freshness, and `qdb` rejections.
14. `test_clickhouse_not_present_in_v1_surface`: no ClickHouse dependency, service, DAG, task, benchmark class, or table namespace exists.

### Phase 0 Contract-Closure RED Tests — Kernel, Restore, Dagu, SQL-Zero, Validation, Diagnosis

- `test_interpreter_is_standard_gil_build`
- `test_interpreter_floor_is_3_13`
- `test_experimental_jit_pinned_off`
- `test_manifest_sha256_is_detached_and_stable`
- `test_kernel_migrations_create_phase0_tables_with_constraints`
- `test_kernel_transition_matrix_rejects_direct_planned_to_published`
- `test_kernel_cannot_publish_without_manifest_validation_snapshot_backup_bindings`
- `test_restore_copied_root_recovers_manifest_files_hashes_and_qdb_pit_query`
- `test_pre_publish_restore_probe_does_not_use_normal_qdb_visibility`
- `test_candidate_recovery_drill_reads_batch_from_restored_catalog_before_promotion`
- `test_candidate_recovery_drill_runs_before_final_publish_marker_is_promoted`
- `test_failed_candidate_recovery_drill_quarantines_and_never_promotes`
- `test_crash_after_backup_marker_before_file_copy_does_not_mark_backed_up_or_publish`
- `test_publish_refuses_without_completed_restore_proof_for_required_mode`
- `test_restore_proof_passes_with_original_root_denied_and_fails_on_live_path_leak`
- `test_dagu_publish_dag_lint_forbids_continue_on_and_mutation_retries`
- `test_dagu_pinned_binary_parent_child_template_validates_and_records_grammar`
- `test_dagu_control_dag_calls_validation_manifest_backup_restore_children`
- `test_dagu_child_dags_declare_their_own_tools_artifacts_and_handlers`
- `test_dagu_large_reports_use_artifacts_not_output_variables`
- `test_sql_surface_absent_in_phase0_phase1`
- `test_validation_schema_pass_can_still_fail_sql_integrity_gate`
- `test_failed_publish_emits_diagnostic_bundle`
- `test_testcontainers_postgres_default_requires_docker_preflight`
- `test_session_scoped_postgres_fixture_uses_per_test_isolation`
- `test_no_silent_localhost_postgres_fallback`
- `test_dsn_localhost_live_port_is_refused_without_marker`

### Phase 0 Artifact And Interface RED Tests

1. `test_lock_lease_renews_and_is_reclaimable_after_ttl` — a held single-writer lease renews on heartbeat and, after TTL expiry without renewal, takeover is allowed only after acquiring the advisory lock.
2. `test_kernel_idempotency_key_unique_per_dataset_partition` — re-running a batch with the same idempotency key for the same dataset/partition creates no second row.
3. `test_lake_maintenance_calls_route_through_single_wrapper` — every DuckLake maintenance call goes through `qdb_lake.maintenance.*`.
4. `test_manifest_file_inventory_matches_snapshot_file_listing_wrapper` — a published manifest's file inventory equals the wrapper's snapshot file listing for the same snapshot.
5. `test_qdbctl_subcommands_map_one_to_one_to_kernel_transitions` — each publish-path state subcommand maps to exactly one kernel transition, and side-effecting control commands are outside the batch-state line.
6. `test_config_realpath_symlink_into_nas_root_is_refused` — a scratch path that resolves via `realpath` into a production NAS root is refused.
7. `test_unknown_local_non_scratch_path_is_refused_without_live_escape` — an arbitrary durable local path outside `scratch_roots`/explicit `allow_roots` refuses unless both live env flag and CLI acknowledgement are present.
8. `test_config_live_flag_allows_production_path` — a production path is allowed only when both environment flag and explicit CLI acknowledgement are present.
9. `test_all_minimum_contracts_carry_asof_predicate_template` — every contract in the minimum set defines `asof_predicate_template`.
10. `test_qdb_empty_result_returns_lineage_not_error` — a zero-match `get_*_asof` returns an empty full-schema frame with populated lineage and raises nothing.
11. `test_benchmark_record_only_gate_never_blocks_build` — a record-only benchmark that regresses still does not fail `task verify`.
12. `test_benchmark_must_pass_gate_fails_on_regression_past_frozen_threshold` — a must-pass benchmark fails `task verify` when its metric crosses a frozen threshold beyond tolerance, and passes on first observation.

### Phase 0 Determinism And Contract-Closure RED Tests

- `test_manifest_physical_file_excludes_backup_restore_cleanup_lifecycle_fields`
- `test_backup_restore_cleanup_lifecycle_lives_in_kernel_tables`
- `test_restore_mode_and_file_inventory_mode_are_distinct`
- `test_manifest_version_is_3`
- `test_publish_manifest_contract_matches_kernel_ddl_and_manifest_seed`
- `test_source_batch_contract_matches_kernel_ddl_structured_paths_and_hashes`
- `test_qdbctl_plan_outputs_batch_id_and_publish_path_mutations_require_it`
- `test_qdbctl_plan_accepts_optional_idempotency_key_and_reuses_retry_identity`
- `test_qdbctl_plan_retry_does_not_mutate_progressed_batch_row`
- `test_dagu_parent_retries_reuse_stable_orchestrator_idempotency_key`
- `test_qdbctl_diagnose_accepts_target_union_and_rejects_ambiguous_targets`
- `test_failed_run_diagnosis_accepts_batch_cleanup_backup_restore_dag_and_qdb_targets`
- `test_qdbctl_dataset_flag_must_match_batch_dataset_when_supplied`
- `test_qdbctl_grammar_is_flag_only_no_positionals`
- `test_runtime_verification_record_requires_authority_command_and_output_hash`
- `test_verify_offline_uses_cached_duckdb_extensions_without_outbound_sockets`
- `test_ducklake_api_probe_resolves_verify_sentinels_into_generated_bindings`
- `test_no_verify_sentinel_survives_before_manifest_seal`
- `test_ducklake_api_phase0_subset_fails_if_deferred_wrapper_is_called`
- `test_neutral_to_polars_dtype_map_is_single_source`
- `test_get_fundamentals_asof_accepts_symbols_and_requires_one_selector_family`
- `test_qdb_error_substrings_match_contract`
- `test_qdbctl_diagnose_renders_text_and_json`
- `test_snapshot_file_hash_status_recorded_and_skips_have_reason`
- `test_kernel_serialization_retry_only_before_side_effect_and_emits_event`
- `test_synthfix_provider_runs_full_kernel_path_enabled`
- `test_non_goal_guardrails_fail_build_on_clickhouse_spark_k8s_airflow_generic_sql_or_continue_on`
- `test_describe_dataset_options_boundary_published_false_phase_phase1b`
- `test_option_contract_dual_key_from_decimal_strike`
- `test_ducklake_commit_discovery_proven_reconciles_not_double_commits`
- `test_ducklake_commit_quarantine_fallback_blocks_prelive_promotion`
- `test_returned_snapshot_id_route_crash_before_intent_persist_quarantines_not_reconciles`
- `test_commit_fingerprint_payload_is_canonical_json_and_stable`
- `test_manifest_hash_uses_rfc8785_canonical_json_bytes`
- `test_canonical_json_authority_vectors_reject_ad_hoc_json_dumps_sort_keys`
- `test_canonical_json_authority_backlog_blocks_manifest_seal`
- `test_side_effect_intent_route3_persists_returned_snapshot_id`
- `test_side_effect_intent_non_cleanup_requires_batch_id`
- `test_side_effect_intent_cleanup_requires_cleanup_id`
- `test_side_effect_intent_rejects_second_row_for_same_scope_effect_type`
- `test_side_effect_intent_null_scope_cannot_pass_unknown_check`
- `test_cleanup_delete_retry_reuses_deterministic_idempotency_key`
- `test_backup_marker_written_after_dump_hash`
- `test_bitemporal_supersession_rollback_prevents_fact_blackout`
- `test_wide_lock_blocks_partition_writer`
- `test_lock_lease_gate_blocks_concurrent_same_partition_publish`
- `test_qdb_hash64_is_big_endian_signed`
- `test_restore_bundle_inventory_required_artifacts_present`
- `test_restore_resolves_relocated_data_root`
- `test_phase0_parent_dag_sequence`
- `test_phase0_parent_dag_includes_stage_commit_publish_children`
- `test_qdbctl_grammar_publish_path_requires_batch_id`
- `test_phase0_has_no_iface_stubs`
- `test_phase0_index_matches_verify_phase0_union`
- `test_phase0_index_includes_safety_bearing_artifact_and_backlog_surfaces`
- `test_phase0_index_deduplicates_test_name_plus_phase_and_rejects_conflicting_metadata`
- `test_guard_vendored_schema_allowlist_is_path_and_hash_bound`
- `test_synthfix_policy_ids_resolve_to_defined_objects`
- `test_fixture_build_is_idempotent_and_does_not_mutate_committed_raw`
- `test_empty_bars_frame_has_typed_nonnull_ohlcv_columns`
- `test_get_bars_symbols_range_spanning_rename_refuses`
- `test_fundamentals_output_nullability_inherits_contract_allowed_nulls`
- `test_fundamentals_cik_only_fixture_without_security_mapping_cannot_emit_invented_security_id`
- `test_acme_security_identity_fixture_required_for_bars_symbol_selector`
- `test_acme_symbol_alias_fixture_required_for_fundamentals_selector`
- `test_backfill_amnesia_prevention_uses_pit_identity_resolver`
- `test_fred_date_only_vintage_not_available_until_next_utc_day`
- `test_sec_live_accepted_at_only_policy_is_disabled_until_public_availability_verified`
- `test_generated_schemas_are_snapshot_tested_after_generation`
- `test_schema_regeneration_refuses_fields_not_named_by_prd_seed`
- `test_provider_capability_policy_id_scalar_and_synthfix_list_shapes_validate`
- `test_provider_capability_rejects_both_scalar_and_list_policy_keys`
- `test_schema_migrations_table_exists_before_first_lock`
- `test_validation_report_schema_backs_quality_and_coverage_fields`
- `test_failed_run_diagnosis_operator_next_actions_drive_text_renderer`
- `test_hypothesis_db_properties_rollback_or_truncate_each_example`
- `test_phase0_dependency_whitelist_allows_dataframely_only_after_proof`
- `test_dataframe_validator_fallback_records_degraded_state_not_equivalent_completion`
- `test_verify_offline_denies_outbound_sockets_and_live_source_flags`
- `test_snapshot_stack_binary_rubric_blocks_broad_scrubbing`

### `VERIFY::` Sentinel Inventory

The complete `VERIFY::` sentinel inventory and related verification tags owned by this cross-module proof surface is: the table below carries the `VERIFY::`-prefixed maintenance-wrapper sentinels alongside `VERIFY-QDB-DTYPES`, a single-hyphen, differently-mechanized dtype-map verification tag that is not a `VERIFY::` sentinel and resolves through its own `task verify:phase0` closure route rather than `task verify:ducklake-api`.

| Sentinel | Owner context | Resolution gate |
|---|---|---|
| `VERIFY::snapshot_file_listing` | [[PRJ-AI-CCC-DuckLake-v7.2.3-Ops-Recovery-Maintenance-Security]] maintenance wrapper | `task verify:ducklake-api` |
| `VERIFY::cleanup_old_files` | [[PRJ-AI-CCC-DuckLake-v7.2.3-Ops-Recovery-Maintenance-Security]] maintenance wrapper | `task verify:ducklake-api` |
| `VERIFY::expire_snapshots` | [[PRJ-AI-CCC-DuckLake-v7.2.3-Ops-Recovery-Maintenance-Security]] maintenance wrapper | `task verify:ducklake-api` |
| `VERIFY::flush_inlined_data` | [[PRJ-AI-CCC-DuckLake-v7.2.3-Ops-Recovery-Maintenance-Security]] maintenance wrapper | `task verify:ducklake-api` |
| `VERIFY::merge_adjacent_files` | [[PRJ-AI-CCC-DuckLake-v7.2.3-Ops-Recovery-Maintenance-Security]] maintenance wrapper; may be explicit Phase 0 deferral unless called | `task verify:ducklake-api` plus deferral record |
| `VERIFY::rewrite_data_files` | [[PRJ-AI-CCC-DuckLake-v7.2.3-Ops-Recovery-Maintenance-Security]] maintenance wrapper; may be explicit Phase 0 deferral unless called | `task verify:ducklake-api` plus deferral record |
| `VERIFY::delete_orphaned_files` | [[PRJ-AI-CCC-DuckLake-v7.2.3-Ops-Recovery-Maintenance-Security]] maintenance wrapper; may be explicit Phase 0 deferral unless called | `task verify:ducklake-api` plus deferral record |
| `VERIFY-QDB-DTYPES` | [[PRJ-AI-CCC-DuckLake-v7.2.3-Dataset-Contracts-And-Validation]] and [[PRJ-AI-CCC-DuckLake-v7.2.3-QDB-Agent-Access-And-SQL-Zero]] dtype map/output frame check | `task verify:phase0` closure via dtype-map tests |

Table: Sentinel inventory and owner routing.

### Gated Modeling-Interface RED Tests (`REQ-IFACE-*`, `xfail` in Phase 0)

These tests are gated/`xfail`; Phase 0 implements none of the interface. The reserved "when feature tables exist" guardrails bind to the deferred interface path rather than a Phase 0 implementation.

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

### PIT And Leakage — Highest Risk Class

*Clock, half-open interval, and leakage semantics behind these tests are owned by [[PRJ-AI-CCC-DuckLake-v7.2.3-PIT-And-Bitemporal-Policy]].*

15. `test_qdb_rejects_missing_known_at`: every PIT-relevant function fails closed when `known_at` is omitted.
16. `test_qdb_rejects_naive_known_at`: every PIT-relevant function fails closed when `known_at` is naive / not timezone-aware.
16b. `test_qdb_normalizes_aware_non_utc_known_at`: an aware non-UTC datetime is accepted and normalized to the same UTC instant.
17. `test_lake_published_at_is_not_financial_known_at`: a 2018 file ingested in 2026 with `source_available_at=2018` is included at `known_at=2019` and excluded before source availability.
18. `test_backfill_amnesia_prevention`: a 2015 fixture ingested on a 2026 clock is queryable at `known_at="2015-12-31"` based on source availability.
19. `test_market_bar_known_at_uses_declared_source_availability_field`: bars gate on the contract's source-availability field, not local `published_at`.
20. `test_daily_bar_not_available_before_close` and `test_intraday_bar_not_available_before_bar_end`: bars are unavailable before close/bar-end plus declared latency.
21. `test_vendor_correction_not_visible_before_correction_available_at`: corrected bars appear only at/after correction availability, with supersession lineage.
22. `test_sec_source_available_at_controls_availability` and `test_sec_fiscal_period_end_does_not_authorize_fact`: accepted/public availability policy gates `source_available_at`; fiscal period alone does not.
23. `test_sec_companyfacts_requires_accession_lineage`: aggregate facts without accession/acceptance are non-PIT and refused by `get_fundamentals_asof`.
24. `test_sec_amended_fact_not_visible_before_amendment_accepted_at`: a restatement appears only after its acceptance, with accession lineage.
25. `test_fred_vintage_asof` and `test_fred_same_day_release_policy`: historical vintage returns old value; date-only vintage applies conservative release policy.
26. `test_macro_forward_fill_does_not_cross_release_time`: forward-filled macro panels never fill before release availability.
27. `test_current_symbol_join_rejected`, `test_current_universe_join_rejected`, and `test_delisted_security_survives_historical_universe`: current-identifier/current-universe joins are rejected; delisted securities survive historical universes.
28. `test_future_split_not_used_in_pit_adjusted_price`, `test_ex_post_adjusted_price_rejected_in_pit_mode`, `test_ex_post_adjusted_requires_non_pit_research_mode`, and `test_adjusted_price_lineage_includes_action_cutoff`: PIT-adjusted prices exclude future actions, ex-post adjusted output is rejected unless explicit non-PIT research mode is acknowledged, and adjusted results carry the action cutoff.

### Phase 1 Source-Adapter Gate

- `test_provider_capabilities_required_before_adapter_enabled`
- `test_massive_raw_csv_schema_fingerprint_blocks_unexpected_header`
- `test_massive_flat_file_bars_not_available_until_next_day_per_policy`
- `test_companyfacts_without_accession_is_non_pit`
- `test_sec_adapter_does_not_use_filed_at_as_availability_clock`
- `test_fred_closed_closed_native_dates_convert_to_half_open_utc`
- `test_discountoptiondata_index_coverage_not_assumed_without_symbol_list_hash`
- `test_norgate_windows_export_path_required_before_adapter_enabled`

### Phase 1B — Options EOD

29. `test_options_raw_retained_when_gold_filters`: filtered marts still link to retained raw/silver source.
30. `test_options_occ_contract_key_is_stable`: equivalent records from two sources map to one canonical key including strike precision and multiplier.
31. `test_option_open_interest_gated_by_its_own_availability_clock`: quotes may appear after EOD availability while open interest waits for its own availability clock; if OI is required before `open_interest_available_at`, qdb refuses with `FieldAvailabilityError`.
32. `test_option_contract_deliverable_change_is_bitemporal`: a corporate-action-adjusted contract shows old deliverable before the change is known/effective and new one afterward.
33. `test_options_source_overlap_no_silent_overwrite`: silver preserves both observations; gold applies explicit precedence and returns a caveat.
34. `test_index_options_gap_is_exposed` and `test_option_chain_slice_prunes_layout`: coverage gaps surface as caveats; chain-slice pruning is proven via profile/file-count evidence.

### Phase 1B Raw Options Retention

- `test_options_low_premium_raw_records_retained`

### Contracts, Adapters, Maintenance

35. `test_validation_rejects_missing_required_column`, `test_validation_rejects_unexpected_column_when_strict`, `test_validation_rejects_duplicate_logical_key`, `test_validation_rejects_broken_pit_interval`.
36. `test_manifest_contains_source_hashes_and_snapshot` and `test_rebuild_sample_manifest_is_deterministic`.
37. `test_source_adapter_plan_mode_no_mutation`, `test_source_adapter_idempotent_same_batch`, `test_source_adapter_raw_archive_is_immutable`.
38. `test_sec_rate_limiter_enforces_policy`: adapter throttles and sends a compliant user-agent, tested with mocked HTTP.
39. `test_ducklake_flush_inlined_data_reports_rows`, `test_ducklake_snapshot_expiry_dry_run`, `test_ducklake_cleanup_old_files_dry_run_first`, `test_retained_snapshot_still_queries_after_maintenance`, `test_cleanup_respects_backup_retention_gap`.

### Pre-Live Gate

- `test_storage_capability_probe_required_before_non_scratch_nas_write`
- `test_cleanup_delete_requires_dry_run_retention_receipt_and_rollback`
- `test_secret_redaction_across_logs_artifacts_manifests_profiles`
- `test_run_event_and_failed_run_diagnosis_schema_validate`
- `test_dsn_classifier_detects_unix_socket_dns_alias_tailscale_and_server_identity`
- `test_storage_permission_probe_artifacts_validate_against_schemas`
- `test_prelive_launch_posture_recorded_for_postgres_and_dagu`
- `test_retention_yaml_covers_required_artifact_categories`

### Query Safety And Lineage

40. `test_qdb_returns_lineage`: every successful call returns a structured lineage object with required keys, not free text.
41. `test_lineage_schema_is_stable`: lineage conforms to a versioned schema.
42. If any SQL surface exists: `test_sql_gateway_rejects_write_statement`, `test_sql_gateway_rejects_raw_schema_by_default`, `test_sql_gateway_rejects_external_file_access`, `test_sql_gateway_requires_partition_filter_for_declared_large_dataset`, `test_sql_gateway_enforces_row_limit`, `test_sql_gateway_enforces_timeout`, and `test_sql_gateway_blocks_direct_pit_table_access`.

### Future Guardrails — Feature Tables And Retrieval

43. `test_retrieval_deferred_until_enabled`: retrieval dependencies/jobs are absent from core `task verify` unless the feature flag is on.
44. `test_retrieval_prefilters_future_documents`: identical top-k from eligible documents whether or not future documents exist in the index.
45. `test_retrieval_uses_ticker_at_filing_time`: filings are retrievable through PIT identity mapping, not only current ticker.
46. When feature tables exist: `test_feature_known_at_is_max_input_availability`, `test_centered_rolling_feature_rejected`, `test_cross_sectional_normalization_uses_pit_universe`, `test_labels_not_exposed_through_feature_api`, and `test_non_pit_feature_construction_requires_explicit_non_pit_mode`. `test_feature_known_at_is_max_input_availability` is the SAME test as PIT's canonical `test_feature_known_at_equals_max_source_available_at_not_valid_at` — one implementation, canonical name wins (FBL2-08); all five are gated `xfail(strict=True)` until feature tables exist.

### Review-Derived Acceptance-Test Index (review-fbl01)

These 27 tests were added by the review-fbl01 patch cycle and are indexed here by owner module per this note's cross-index role; requirement-specific behavior stays authoritative in each owner module.

*Owned by [[PRJ-AI-CCC-DuckLake-v7.2.3-Publish-Control-Kernel]]:*

- `test_discovery_route_probe_transcript_shows_all_routes_attempted`
- `test_prelive_requires_at_least_one_proven_publish_end_to_end`
- `test_candidate_drill_answers_from_restored_root_proven_by_sentinel_divergence`
- `test_row_level_source_available_at_gates_visibility_not_batch_min`
- `test_catalog_dump_excludes_started_backup_marker_row`
- `test_transition_authority_reads_current_state_from_db_not_cached_object`
- `test_serialization_failure_after_ducklake_commit_does_not_retry_commit`
- `test_intent_retry_with_different_fingerprint_same_scope_reconciles_gracefully_not_crash`
- `test_lease_recheck_shares_finalizer_serializable_transaction`
- `test_two_partition_writers_same_dataset_run_concurrently`
- `test_lock_argument_equals_stored_advisory_key_across_call_sites`
- `test_delete_eligible_cannot_be_set_by_direct_update`
- `test_inlined_rows_flushed_before_backup_survive_restore`

*Owned by [[PRJ-AI-CCC-DuckLake-v7.2.3-PIT-And-Bitemporal-Policy]]:*

- `test_feature_known_at_equals_max_source_available_at_not_valid_at` (canonical name; `test_feature_known_at_is_max_input_availability` is the same test — gated `xfail(strict=True)` until feature tables exist, FBL2-08)
- `test_full_sample_zscore_rejected_in_pit_feature_build` (gated `xfail(strict=True)` until feature tables exist, FBL2-08)
- `test_session_day_valid_time_returned_at_equality_not_dropped_by_half_open`
- `test_mixed_availability_batch_closes_each_key_at_its_own_replacement_source_available_at`
- `test_availability_comparison_is_utc_instant_across_dst_and_midnight`
- `test_backfill_preserves_original_source_available_at_and_adds_new_version`
- `test_action_gated_on_availability_not_declaration_when_they_straddle_known_at`

*Owned by [[PRJ-AI-CCC-DuckLake-v7.2.3-Dataset-Contracts-And-Validation]]:*

- `test_option_oi_masked_to_null_or_refuses_when_unavailable`
- `test_decimal_strike_key_rejects_float_derivation_and_computed_once`

*Owned by [[PRJ-AI-CCC-DuckLake-v7.2.3-QDB-Agent-Access-And-SQL-Zero]]:*

- `test_current_cik_join_rejected`
- `test_current_option_root_join_rejected`
- `test_total_return_dividend_gated_on_announcement_availability_not_ex_date`
- `test_cross_instrument_session_boundary_join_refused_or_alignment_proven`

*Owned by this Verification module:*

- `test_bench_threshold_never_auto_frozen` (see `REQ-BENCH-FREEZE` above)

Table: Review-fbl01-derived tests; none duplicate an existing indexed name in this module.

### Review-Derived Additions (review-fbl02)

The review-fbl02 patch cycle adds three tests, indexed by owner module: `test_quarantined_batch_retry_requires_new_idempotency_key_and_reconciles_completed_intents` (FBL2-04, owned by [[PRJ-AI-CCC-DuckLake-v7.2.3-Publish-Control-Kernel]]); `test_same_instant_supersession_produces_empty_interval_not_validation_failure` (FBL2-12, owned by [[PRJ-AI-CCC-DuckLake-v7.2.3-PIT-And-Bitemporal-Policy]]); and `test_live_root_denied_requires_in_jail_refusal_probe_transcript` (FBL2-14, owned by [[PRJ-AI-CCC-DuckLake-v7.2.3-Ops-Recovery-Maintenance-Security]]). None duplicates an existing indexed name.

### Test-Suite Economics (`REQ-TEST-ECON`, v7.2.3)

Test volume is not proof. The archive-frozen predecessor's 1,181 test files inflated confidence with mocked "concurrency" suites and regeneratable golden baselines; these rules price proof honestly.

- `REQ-TEST-ECON-01`: no test named in [[REF-AI-DuckLake-v7.2.3-BlockingTestIndex]] may be re-satisfiable by a flag or code path that regenerates its own expected output (no `--generate-golden-files` equivalent for any indexed test). A guard scans the test infrastructure for self-regenerating baseline mechanisms and cross-references the index names. Backed by `test_no_test_in_blocking_index_has_a_self_regenerating_golden_flag`.
- `REQ-TEST-ECON-02`: numeric golden comparisons use quantize-then-hash — quantize floats (`round(x * 1e10) / 1e10`), serialize with the canonical JSON authority (MR1, RFC 8785, in [[PRJ-AI-CCC-DuckLake-v7.2.3-Manifests-Lineage-And-Fixtures]]), then SHA-256 — never raw float equality and never serialization-order-dependent hashing. Backed by `test_numeric_golden_comparisons_use_quantize_then_sha256_not_raw_float_eq`.
- `REQ-TEST-ECON-03`: the suite MUST prove it can fail. A negation meta-test temporarily patches a named known-good function to reintroduce a specific lookahead bug class and asserts that the named PIT test FAILS under the patch; planted-bug fixtures live in `tests/negation_fixtures/`, outside the normal fixture tree, and the meta-test names both the patched function and the test expected to catch it — no generic fuzzing. Backed by `test_planted_lookahead_bug_fixture_is_caught_by_existing_pit_test_suite`.
- `REQ-TEST-ECON-04`: golden hash constants are inline literals in the test file, visible in code-review diffs, never loaded from a fixture file the test could regenerate. Backed by `test_golden_hash_constants_are_inline_literals_not_externally_regenerable`.

These rules complement `REQ-CFG-08`'s real-Postgres mandate: kernel, concurrency, and restore claims run against a real embedded database and real filesystem, and golden claims carry review-visible, non-regenerable expectations.

## Benchmark Classes And Scale Gates

Benchmarks gate scale. No full-data ingestion runs until sample benchmarks record file counts, partitions, row groups, compression, cold/warm cache behavior, scanned bytes, query plans, NAS path, client host, and failure modes.

### Benchmark Harness Requirements (`REQ-BENCH`)

- `REQ-BENCH-01`: Benchmarks MUST be query-class specific; one universal latency target is forbidden, and required classes are symbol history, timestamp cross-section, option-chain slice, PIT join, Dagu publish overhead, DuckLake maintenance overhead, and storage transport when applicable.
- `REQ-BENCH-02`: Benchmarks MUST record data shape, rows, files, row groups, partitions, compression, bytes read when available, host, storage path, cache mode, DuckDB profile/`EXPLAIN ANALYZE`, wall time, memory, and failure mode, and MUST be repeatable on scratch/sample datasets.
- `REQ-BENCH-03`: Benchmarks MUST compare layout fixes before introducing new infrastructure; NAS direct is the baseline and the S3-compatible benchmark is required only if NAS direct is inadequate or unclear.
- `REQ-BENCH-04`: No ClickHouse benchmarks may be created in the first release; a benchmark guardrail test MUST assert ClickHouse is absent from every first-release surface.
- `REQ-BENCH-FREEZE`: Only a human marks a benchmark threshold frozen; the agent never auto-freezes. No agent-reachable code path may flip provisional→frozen; the flip requires a human-set marker artifact. Proven by `test_bench_threshold_never_auto_frozen`.

| Benchmark class | First proof target | Failure response |
|---|---|---|
| Symbol history | One symbol and selected universe range over compacted layout | Fix partition/sort/row groups before adding infrastructure. |
| Timestamp cross-section | One timestamp across selected universe from DuckDB/DuckLake sample | Rewrite gold layout or local NVMe cache; no ClickHouse in this PRD. |
| Option-chain slice | One underlier/date/expiry slice prunes files and row groups | Rewrite options layout or derived mart policy; coarsen partitions. |
| PIT join | Fundamentals/macro join with explicit `known_at` and lineage | Redesign semantic schema before ingesting more data. |
| Dagu publish | Stage/validate/commit/manifest/backup/publish completes predictably | Simplify DAG and isolate the bottleneck. |
| DuckLake maintenance | Flush/merge/expire/cleanup dry-run with retained-snapshot proof | Adjust retention/compaction policy. |
| Storage transport | Scratch/local first, then NAS direct after the pre-live probe; S3-compatible optional comparison | No non-scratch NAS writes until the capability probe passes; introduce S3-compatible only if it materially wins or fixes correctness. |
| Retrieval | LanceDB hybrid eval hit-rate/MRR/citation quality | Improve chunking/metadata/eval first; Qdrant only on failure. |

Table: Benchmark classes; ClickHouse is deliberately absent.

> [!note] ClickHouse escape criterion (no implementation now)
> ClickHouse stays out of the first release, enforced by a guardrail test. The exclusion is phase-scoped, not ideological: after at least two serious DuckLake layout attempts and a gold-mart attempt, if timestamp cross-section or option-chain slice still miss agreed latency thresholds, open a separate hot-mart PRD. No ClickHouse dependency, service, DAG, benchmark, or namespace may exist before that PRD.

### Benchmark Gate Types: Record-Only vs Must-Pass (`REQ-BENCH`, resolves `REQ-OBS-DEFER`)

Benchmarks never block the build until a threshold has been observed, written, and frozen by review. Two gate types exist, and only one can fail `task verify`.

- Record-only is the default for every class in Phase 0 and Phase 1. The benchmark runs, captures metrics, and appends them to `docs/benchmarks-baseline.md`. It may warn but never fails `task verify`. This is the only gate type that exists before a baseline is frozen.
- Must-pass is post-baseline and opt-in per class. Enabled for a class only after a human reviews that class's provisional threshold in `docs/benchmarks-baseline.md` and marks it `frozen`. A must-pass class fails `task verify` only when a metric regresses past its frozen threshold beyond the stated tolerance band. It never fails on first observation, and a regression past a still-`provisional` threshold only warns.

Baseline-then-freeze: the first run of a class writes a provisional threshold to the baseline doc, marked `provisional`; a human flips it to `frozen` after review. No threshold number is invented in advance; the doc ships empty and is populated by the first real run. The implementing agent MUST never auto-freeze a threshold; freezing is a human review action under `REQ-AUTH-01` and `REQ-BENCH-FREEZE` (see the standalone `REQ-BENCH-FREEZE` bullet above). Tolerance authorship is human too (FBL2-23b): provisional rows carry `tolerance: null`, and the human sets the tolerance band at freeze time, together with the freeze flip itself; until freeze, the observed value itself serves as the provisional threshold and any regression past it only warns.

| Benchmark class | Phase 0/1 gate | Post-baseline gate |
|---|---|---|
| Symbol history | record-only | must-pass on scan latency once frozen |
| Timestamp cross-section | record-only | must-pass once frozen (ClickHouse-escape trigger) |
| Option-chain slice | record-only | must-pass once frozen (ClickHouse-escape trigger) |
| PIT join | record-only | must-pass on join latency once frozen |
| Dagu publish | record-only on timing | must-pass on completion/correctness; timing record-only |
| DuckLake maintenance | record-only on timing | must-pass on dry-run correctness; timing record-only |
| Storage transport | record-only | gated by capability probe (separate hard gate); timing record-only |
| Retrieval | not applicable until feature flag is on | record-only until a labeled eval slice exists |

The baseline document is generated, with thresholds reviewed by hand. Its shape:

```text
 # docs/benchmarks-baseline.md  (generated; thresholds reviewed and frozen by hand)
 # numbers below are ILLUSTRATIVE PLACEHOLDERS, not measured values
 # class                  metric            observed   threshold   tolerance  state
timestamp_cross_section  p50_scan_ms       <obs>      n/a         null       provisional
option_chain_slice       files_pruned_pct  <obs>      <obs-tol>   -5%        frozen
pit_join                 p50_join_ms       <obs>      n/a         null       provisional
```

## External Claim Governance

External advisory input is allowed as a bounded quality lane (`AW1`), not as a requirements source. Use it for one bounded question at a time: unclear implementation interpretation, a narrow risk check, or a dependency/source-timing challenge that still requires project evidence. Each advisory record lives in `docs/external-claim-ledger.md` with `question`, `context_hash`, `source`, `finding`, `disposition` (`adopt` / `modify` / `reject` / `defer` / `investigate`), `authority_required`, `action_taken`, and `owner`. No external advisory input may flip `adapter_enabled`, pin a dependency/version, freeze a benchmark threshold, adopt a Dagu grammar, or settle a source-timing rule unless independently backed by one of the three `REQ-AUTH-01` authorities: official docs, a runtime probe in the new repo, or a supplied artifact. External findings are proposals; the PRD contract and verification artifacts remain the authority.

## Verification Backlog

These items are deliberately not guessed. The future agent must verify them in the new repo before production-like work begins, before adapter purchase, and before non-scratch writes.

Every item below is also governed by its `DD-*` entry in [[PRJ-AI-CCC-DuckLake-v7.2.3-Deferred-Decision-Registry]]. `task verify:spec-authority` first verifies the self-contained sealed snapshot under `docs/spec-authority/v7.2.3/`; `task verify:deferred-decisions` then runs only against that verified snapshot and its hash-bound `deferred-decision-coverage.v1.json`. The coverage gate fails for an untracked deferral-like phrase, a missing registry field, a deadline reached with unresolved state, an unreviewed exclusion, a mutable coverage file, or evidence that has expired under the entry's named change events. Verification owns this coverage check and gate routing; it does not make the owner module's decision, access the vault at runtime, or accept a developer-edited allowlist.

### Seeded Verification Backlog (`backlog.seed.yaml`)

The open items below are not only prose; they are seeded once as machine-readable records in `docs/runtime-verification/backlog.seed.yaml`, one record per open fact, reusing `schemas/runtime_verification.schema.json` plus optional `output_artifact` pointer and required `fallback_status` and `kill_or_pivot` fields. Each open item MUST declare a `fallback_status` and a `kill_or_pivot` sentence stating exactly where an agent without external access stops or what it does instead, so a no-network / no-runtime build always has an explicit safe stopping point. A backlog item whose `blocks` names a gate blocks that gate while `status: open`; flipping a safety-bearing item to `resolved` still requires `REQ-AUTH-01` authority, command, and `observed_output_hash`.

The seed enumerates the safety-bearing verification set: Dagu binary version/URL/SHA/license, canonical JSON authority, DuckLake maintenance wrapper bindings and deferrals, DuckLake commit-fingerprint discovery, DuckLake attach/relocation behavior, SEC accepted/public-availability timing, FRED/ALFRED release timing, options OI/quote/session clocks, market-calendar library, NAS atomic-rename/read-after-close/listing behavior, and benchmark thresholds.

The seed also carries `decision_id`, `decision_state`, `decision_deadline_gate`, `evidence_expires_or_reverify_when`, and `decision_record_path`. A generated item cannot change to `resolved` unless its `DD-*` entry allows that outcome and the named proof passes. At the deadline gate, an unresolved item changes to `rejected_for_now`; it never remains silently open while the affected gate passes.

The authoritative seed listing — the representative records, the `sentinel_wrapper_targets` enumeration, the amended commit-fingerprint `gate_rule`, and the required `fallback_status`/`kill_or_pivot` discipline — lives in [[PRJ-AI-CCC-DuckLake-v7.2.3-Provider-Capability-And-Availability]] under Seeded Verification Backlog (FBL2-03). This module indexes the backlog and owns its gate routing; it does not restate the records, because a second normative copy is exactly the divergence FBL2-03 closed. CI treats an `open` item whose `blocks` names a live gate as a gate failure until it is resolved.

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
| NAS mount semantics | Atomic rename, metadata listing, cold/warm scans, concurrent readers, read-after-close and listing latency, free space, disconnect-mid-write, restore-copy speed | Phase 0 uses a scratch-vs-live path classifier only; the full probe is the pre-live `task smoke:nas` gate. |
| Scratch PostgreSQL strategy | Reproducible, non-hanging default tests | Testcontainers PostgreSQL 16 is the default integration strategy; verify Docker preflight and explicit `QDB_TEST_POSTGRES_DSN` override. |
| SEC after-hours dissemination rule | Trading-on-acceptance leakage | Verify exact rule before encoding `publicly_disseminated_at`. |
| FRED/ALFRED intraday release policy | Same-day macro leakage | Default conservative end-of-day unless exact release times verified. |
| Index-option vs equity close mismatch | 15-minute leakage on joins | Verify session calendars per instrument. |
| Vendor SDK raw-evidence fidelity | Polygon/Massive, Norgate, DiscountOptionData, SEC, FRED | Confirm each preserves raw evidence, timestamps, identifiers before adoption. |
| Norgate Windows/export path | Norgate is not a normal Mac-native adapter; real only after a Windows/export proof | Verify Windows VM/export path, adjustment/padding config, and export hashes before enabling the adapter for Phase 1. |
| Dagu license for intended use | Local tool vs redistribution | Confirm no license concern for local external orchestration. |
| `dlt` DuckLake destination | Ingestion boilerplate reduction | Parked/rejected for the first wave; revisit only as a kill-oriented review if isolated nested-JSON normalization becomes a measured bottleneck. |
| DiscountOptionData index coverage | SPX/VIX/NDX/RUT history may exceed the old note but is unverified | Confirm with a purchased symbol list and sample files; do not assume coverage without a symbol-list/sample hash. |
| Options OI and session clocks | Open-interest availability lags quotes; OI timing unverified | Confirm OCC/OPRA/vendor timing evidence before encoding OI availability clock; policy object ships now, fixtures only after evidence. |
| Dagu binary pin and grammar validation | YAML shape must match the pinned binary, not memory | Pin the target binary, record `dagu version`, probe whether `dagu schema dag` exists, and commit one `dagu validate`-passing parent+child template before treating any shape as accepted. |
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
| Package version pins | DuckDB, DuckLake, PostgreSQL extension, Polars, PyArrow, selected dataframe validator, Typer, Pydantic, Psycopg3, and Testcontainers compatibility | Global bootstrap |
| Exact Polars dtype spellings | Map neutral dtype tokens to concrete Polars dtypes for output frames | Dataset contracts and qdb APIs |
| SEC availability clock | `publicly_disseminated_at` versus `accepted_at` rule for the availability gate | SEC PIT fixtures and qdb fundamentals |
| FRED release timing | Whether intraday/exact release timestamps exist or end-of-day is the conservative clock | Macro vintage policy |
| Options OI/session clocks | Quote-availability versus open-interest-availability lag and session-close timing | Options EOD companion |
| Benchmark thresholds | Provisional numbers come only from the first baseline run; none are invented in advance | Benchmark gates |

Table: Verification items that must become repo facts before production-like work.

### Contract-Closure And Modeling-Interface Verification Items

| Verification item | Confirm before hard-coding | Binds |
|---|---|---|
| Market-calendar library | Which package backs `trading_calendar_bt`: resolve ordered candidates `exchange_calendars` then `pandas_market_calendars`, first passing the probe wins; wrap it in bitemporal contract, never trust current-calendar view for history | `REQ-IFACE-05`, resample/fill |
| Panel-spec ergonomics | Deliberate decision: flat column-list with explicit per-column dataset binding, not a dataset-graph spec | `REQ-IFACE-02`/`REQ-IFACE-10` |
| Package-layout roots | Five-root core plus functional packages; confirm at repo creation | Bootstrap, package shape |
| `register_derived` `known_at` rule | `known_at = max(parent availability)` across all three derived kinds; fails closed if a parent lacks source availability | `REQ-IFACE-08`/`REQ-IFACE-09` |
| `get_coverage` flag source | Which validation/quality fields back coverage completeness/gap/quality flags | `REQ-IFACE-06` |
| `signal_score` serving trigger | When the engine exists and produces scores; reserved future interface contract, serve later | `REQ-IFACE-09` |
| Serialization-retry constants | `REQ-KERNEL-RETRY` defaults confirmed under real concurrent write load | `REQ-KERNEL-RETRY` |

Table: Verification items joining the ledger; deliberate decisions are flagged as such.

## Unresolved Risks

The PRD carries these residual risks forward. None blocks the scratch Phase 0 build, but each must be resolved before the dependent live work is trusted.

- Provider facts may drift; verify against official docs and sample artifacts at adapter time rather than trusting planning tables.
- DuckLake version behavior around cleanup, inlining, file inventory, and restore paths must be pinned and tested, not assumed stable across releases.
- DuckLake dependency fallback is pre-decided, so the most load-bearing external dependency can fail without trapping the build. Trigger: `task verify:ducklake-api` cannot resolve Phase 0 wrapper bindings, a Phase 0 code path calls a deferred wrapper, or copied-root restore-with-files cannot be proven on scratch in Phase 0. Pivot 1 is manifest-authoritative restore: the kernel's own manifest file-inventory becomes restore source of truth while DuckLake stays the commit/query engine. Pivot 2 is heavier: drop DuckLake catalog and fall back to partitioned Parquet + DuckDB with the PostgreSQL kernel manifest as catalog of record. Both pivots preserve four-clock PIT semantics and copied-root proof; trigger and pivots are seeded in `docs/runtime-verification/backlog.seed.yaml` under `ducklake_maintenance_fn_names`.
- NAS behavior is unknown until measured on Ryan's actual Mac/NAS route; the pre-live storage probe is the gate.
- Norgate is operationally real only after a Windows/export proof; until then it is not a Phase 1 dependency.
- Options open-interest timing remains unverified; the OI clock ships as a policy object, not a fixture, until OCC/OPRA/vendor evidence exists.
- Planning-appendix divergence will keep confusing agents unless this PRD's precedence rule is honored (`REQ-PRD-SOURCE-HIERARCHY`).
- Production metrics, alert thresholds, and multi-worker topology remain deferred until the scratch kernel, restore, `qdb`, Dagu, validation, and observability are green (`REQ-OBS-DEFER`).
- Heavy hardening is deferred to a future version, not this fixture-core build: zombie-writer I/O fencing and profiling, DuckLake update write-amplification benchmarking, version-bump runbook, host-backpressure scheduling beyond safe initial `max_global_heavy_jobs: 1`, distributed Dagu workers beyond a single local worker, and any license-expiry purge-on-restore. Live broker/execution integration stays out of scope unless a separate trading/execution PRD is opened, and Databento remains a parked owned-data backstop, not a selected spine.

## Implementation Readiness Checklist

This checklist is an execution aid, not a contract; each item's binding requirement is its in-place `REQ-*` bullet plus referenced artifact seed or listing. Check items off against the governing requirement, generated implementation-index row, and acceptance tests, not against this list's wording.

> [!note] Committee interim rule
> Committee-gate specs live in [[PRJ-AI-CCC-DuckLake-v7.2.3-Committee-Gates-And-HITL]]. Under the v7.2.3 posture committees may run in advisory-triage mode now (recommendations, evidence summaries, gate packets for Ryan), but gate-clearing authority stays unratified: until the human ratifies k-of-N thresholds, every committee stop-condition degrades to checkpoint-and-surface (fail-closed human review).
> Checkpoint-and-surface is mechanically defined in the Committee module's interim rule (FBL2-06): no CG gate is wired into any `task verify:*` lane in the fixture-complete core; the checkpoint is the governing backlog item staying `status: open` (which already blocks its named gate), plus `analysis/committee/<gate>/checkpoint.json`, plus surfacing in diagnosis/readiness output — cleared only by a human.

Each item below carries a level tag, its proving command gate, and its primary artifact (FBL2-23e).

### Before code

- [ ] [Phase 0] Create `/Users/ryanpappal/03_CODE/ccc-lab-super/` — the external implementation code repo, not the vault project folder — per Ryan's v7.1.1 D1 adjudication (IR-1 decision recorded); artifact: README repo-path record.
- [ ] [Phase 0] Add repo-local `AGENTS.md` and `CLAUDE.md` before real implementation — gate: `task verify:bootstrap`; artifacts: the two root instruction files.
- [ ] [Phase 0] Stand up `uv`, `task`, Ruff, Pyright, pytest, and `docs/version-pins.md`; no generic "type checker" substitution is allowed unless `task verify:toolchain` records a Ryan-approved incompatibility/pivot — gates: `task verify:toolchain`, `task verify:lockfile`; artifacts: `docs/version-pins.md`, `docs/runtime-verification/toolchain.json`.
- [ ] [Phase 0] Generate `docs/implementation-index.seed.csv`, `docs/implementation-index.md`, `docs/runtime-verification/backlog.seed.yaml`, and `docs/schema-derivation/phase0-safety-schemas.md`, then pass `task verify:phase0-index` — including the diff against the shipped [[REF-AI-DuckLake-v7.2.3-BlockingTestIndex]] (FBL2-07) — before treating the RED-test inventory as a work queue — gate: `task verify:phase0-index`; artifacts: the four generated files.
- [ ] [Phase 0] Build `task verify` and phase gates around local tests and scratch smoke proofs with production-path refusal — gate: `task verify`; artifact: Taskfile gate wiring.
- [ ] [Phase 0] Confirm the four normative adversarial fixtures owned by [[PRJ-AI-CCC-DuckLake-v7.2.3-Manifests-Lineage-And-Fixtures]] plus their PIT acceptance criteria are present; the PIT test lane is not treated as falsifiable until they exist — gate: `task fixtures:build`; artifacts: the four fixture specs plus their `expected/` files.

### Phase 0 / 0.5 blocking core

- [ ] [Phase 0] Implement dataset-contract and publish-manifest models before source adapters, with the `publish_manifest` contract either matching the kernel DDL plus explicit projection fields or being renamed as a projection with a mapping — proof: `test_publish_manifest_contract_matches_kernel_ddl_and_manifest_seed`; artifacts: `contracts/*.yaml`, `schemas/publish_manifest.v3.schema.json`.
- [ ] [Phase 0] Implement scratch DuckLake/PostgreSQL two-client smoke and DuckDB connection manager before adapters — proof: `test_two_clients_coordinate_through_postgres_catalog`; gate: `task smoke:ducklake`.
- [ ] [Phase 0] Implement kernel DDL, batch-state transition matrix, single-writer locks, idempotency, row-level bitemporal supersession, side-effect intent, and crash-boundary tests — proof: the kernel Owner-Local suite; artifact: `src/qdb_kernel/migrations/0001_kernel.sql`.
- [ ] [Phase 0] Implement the publish path in the required order: `stage → validate → commit → manifest plus file inventory → backup → pre-publish restore proof → candidate promote → candidate recovery drill → publish`; prove failed validation, failed restore proof, failed candidate drill, and unreconciled side effects are never visible to `qdb` and emit diagnosis artifacts — proofs: `test_phase0_parent_dag_sequence`, `test_publish_validation_failure_not_visible_to_qdb`; artifacts: parent+child DAGs, diagnosis artifacts.
- [ ] [Phase 0] Implement typed core `qdb` functions and `QdbLineage v1` over predeclared fixtures; keep Phase 0/1 SQL-zero and keep `get_option_chain_asof` present but inert, raising `DatasetNotPublishedError` until Phase 1B — proofs: `test_qdb_error_substrings_match_contract` plus the PIT refusal suite; artifact: `src/qdb/api.py`.
- [ ] [Phase 0] Implement copied-root restore-with-files proof to a fresh root/catalog and write proof back into the live kernel only after verifying jail evidence artifact; a proof row that exists only in the jailed database does not advance the live batch — proofs: `test_restore_copied_root_recovers_manifest_files_hashes_and_qdb_pit_query`, `test_live_root_denied_requires_in_jail_refusal_probe_transcript`; artifacts: `restore_bundle_inventory.v1.json`, restore evidence.
- [ ] [Phase 0] Author Dagu workflows only after pinning the binary, recording `dagu version`, probing whether `dagu schema dag` exists, and committing one `dagu validate`-passing parent+child template; lint only proven anti-patterns such as `continue_on` and mutation retries on critical steps — proof: `test_dagu_pinned_binary_parent_child_template_validates_and_records_grammar`; artifact: `docs/runtime-verification/dagu_binary.json`.
- [ ] [Phase 0] Emit versioned observability schemas (`run_event`, `failed_run_diagnosis`) and `QdbLineage v1` from the start; add validation tiers and cleanup approval artifact before any deletion — proof: `test_run_event_and_failed_run_diagnosis_schema_validate`; artifacts: `schemas/*.schema.json`, cleanup approval record.
- [ ] [Phase 0] Keep ClickHouse out of the repo plan; keep the guardrail test in place — proof: `test_clickhouse_not_present_in_v1_surface`.
- [ ] [Phase 0] Default the integration harness to Testcontainers PostgreSQL 16; keep unit tests Docker-free and gate integration tests on a Docker preflight — proofs: `test_testcontainers_postgres_default_requires_docker_preflight`, `test_no_silent_localhost_postgres_fallback`.

### After Phase 0 is green

- [ ] [Phase 1] After `task verify:phase0` is green, implement equities/SEC/FRED core sample with four-clock PIT before scaling volume; do not start live-source behavior during fixture-core implementation — gate: `task verify:phase1`.
- [ ] [Phase 1B] Only under `task verify:options` / Phase 1B, implement Options EOD companion sample using the same contracts and kernel, non-blocking for the core; do not start it during fixture-core implementation — gate: `task verify:options`.
- [ ] [Phase 1+] Run storage/layout benchmarks only after the scratch correctness loop is green — gate: `task bench:sample`; artifact: `docs/benchmarks-baseline.md`.
- [ ] [Phase 1+] Require a provider capability pack per source before enabling its live adapter (`REQ-SRC-VERIFY`); keep DOD/Norgate evidence-gated — gate: `task verify:source-adapter-gate`; artifacts: `provider_capabilities/<provider>.yaml`.
- [ ] [Phase 1+] Docs-derived DISABLED adapter drafts (`REQ-SRC-DRAFT`) may be built at any time without spend or enablement; they never satisfy `REQ-SRC-VERIFY`, never enable a source from docs alone, and must prove refusal without evidence — proofs: `test_draft_adapter_refuses_without_capability_evidence`, `test_draft_adapter_uses_mocked_http_only`.
- [ ] [Phase 1+] Require a `source_backfill_plan.v1` before any multi-partition historical pull becomes executable or backtest-queryable, and a calibrated `historical_forward_splice_calibration.v1` before any seam-spanning query — proofs: `test_source_backfill_plan_required_before_multi_partition_execution`, `test_historical_forward_splice_overlap_calibrated_before_seam_query`.
- [ ] [pre-live] Keep every non-scratch NAS write behind the pre-live storage probe (`REQ-STORAGE-PROBE`) — gates: `task verify:prelive`, `task smoke:nas`; artifacts: storage/permission probe records.
- [ ] [pre-live] Keep storage enablement split from live-source enablement: `QDB_ENABLE_NON_SCRATCH_STORAGE` gates non-scratch roots and the real catalog DSN, `QDB_ENABLE_LIVE_SOURCES` gates vendor downloads only — proof: `test_storage_flag_and_live_source_flag_are_independently_gateable`.
- [ ] [pre-live] Record the PostgreSQL server install contract (`REQ-OPS-POSTGRES-INSTALL`) and prove heavy-lake-job placement refusal on the control/inference hosts (`REQ-DAGU-05b`) — artifacts: `docs/runtime-verification/postgres_server.json`; proof: `test_heavy_lake_job_refuses_control_and_inference_only_hosts`.
- [ ] [pre-live] Follow archive-before-delete (`REQ-MAINT-05`): archive proven-safe generated artifacts reversibly with full metadata; physical deletion stays dry-run plus approval hash plus Ryan approval — proof: `test_archive_action_records_required_metadata_and_refuses_protected_classes`.

## v7.2.3 verification and multi-host amendments

AMD-018 verifies selected-validator identity, version, import, minimal schema behavior, loser absence, and mandatory DuckDB SQL checks. AMD-026 routes one ordinary pre-live proven-publish test through a hash-bound proof aggregate; xfail, skipped, stale, unavailable, or quarantine-only evidence fails.

AMD-050 adds `task verify:multi-host-prelive`. It aggregates existing pre-live checks with independent source custody, host identity, estate quiescence, exact release, persistence, remote seam, recovery, applicable receipt, and writable-root refusal proofs. Removing any constituent proof must fail the aggregate. Provider gates remain separate.

## Implementation Operating Contract

The implementation contract is contained in the v7.2.3 module set plus root/control ledgers. The future repo lives at `/Users/ryanpappal/03_CODE/ccc-lab-super/` (the external implementation code repo, not the vault project folder); the Obsidian vault is design custody, not a runtime dependency. Work test-first, implement from the `REQ-*` families and referenced artifact seeds, and keep every external fact behind `REQ-AUTH-01` evidence until verified.

The required Definition of Done is the fixture-complete core on the `synthfix` provider only. Live adapters stay disabled until their provider capability artifact and source-availability policy exist and pass `task verify:source-adapter-gate`; `synthfix` is the only enabled synthetic exception.

Phase 0 proves the fixture-complete core: scratch DuckLake plus a session-scoped Testcontainers PostgreSQL 16 two-client coordination harness; a publish/control kernel that owns dataset registry, batch state, side-effect intent/reconcile, backup marker ordering, bitemporal supersession, legal transitions, shared/exclusive advisory locks, idempotency, manifest-bound visibility, snapshot/lake-root/file-inventory/backup/restore binding, and cleanup eligibility; typed SQL-zero core `qdb` that rejects missing or naive `known_at` and binds `known_at` to `source_available_at` or `known_from`/`known_to`; binary-pinned Dagu publish orchestration; copied-root scratch restore to a fresh catalog/root with `restore_bundle_inventory.v1.json`; validation tiers; observability/diagnosis schemas; and one equity plus one SEC/FRED adversarial PIT fixture.

Phase 0.5 makes the contract mechanically buildable: manifest v3 carries only seal-time inputs; lifecycle facts stay in kernel tables; `file_inventory` is the single structured data-file inventory; `qdbctl` is flag-only; publish-path mutations require `--batch-id`; cleanup and migrate are cross-batch control commands; side-effect intent constraints are NULL-safe; cleanup-delete idempotency is deterministic; canonical JSON authority is proof-gated before manifest seal; frozen toolchain and neutral dtype map are explicit; `scripts/probe_ducklake_api.py` resolves every Phase 0 binding sentinel and records explicit deferrals for non-Phase-0 wrappers; `ducklake_commit_fingerprint_discovery.json` distinguishes proven reconciliation from quarantine fallback; `qdb` call signatures are keyword-only; deterministic fixture-build hashes and synthetic identity fixtures are enforced; `docs/implementation-index.seed.csv` and `docs/implementation-index.md` define the blocking-test ledger; and non-goal guardrails include `guard:vendored-schema`.

The modeling-engine interface (`REQ-IFACE-*`) is the only supported coupling surface to a separate future engine. `trading_calendar_bt` and `register_derived` land in Phase 1; `get_panel_asof`, `as_of_fill`, `resample_to_calendar`, `get_coverage`, and `open_session` land in Phase 1.5. Phase 0 implements none of this interface; only gated/`xfail` leakage tests exist to lock the boundary early. The interface adds no new service, database, or platform.

Hard rules: this document takes precedence over Appendix A when raw retention, PIT, source availability, provider capability, or adapter enablement conflicts with planning assumptions; canonical lake writes go only through controlled DuckLake/DuckDB publication as a single serial writer; raw/bronze/silver observations are never discarded for premium, liquidity, moneyness, vendor convenience, or cost; all PIT intervals are half-open UTC and missing PIT fields fail closed; no arbitrary SQL exists in Phase 0/1; options APIs are present but raise `DatasetNotPublishedError` until Phase 1B; live adapters stay disabled until capability and availability evidence exists; DOD coverage, Norgate operation, Massive/Polygon raw format/timing, SEC public availability, FRED release timing, options OI/session clocks, market-calendar library, and all package/version pins are verification items, not facts; retrieval is feature-flagged and deferred; distributed Dagu workers and non-scratch NAS writes wait for the storage probe; ClickHouse, MinIO/S3-first storage, remapped-root restore, production multi-worker topology, alert thresholds, and PostgreSQL PITR are out of the first release.

## v7.2.3 r2 restored indexed acceptance criteria

- `test_selected_dataframe_validator_verification_rejects_dual_or_zero_candidate`: dependency verification fails when both validator candidates are selected, neither is selected, the recorded winner cannot import and validate the minimum schema, or the loser remains installed as parallel authority.
- `test_prelive_refuses_xfail_skipped_stale_or_quarantine_only_publish`: pre-live accepts only a current fully passing ordinary publish proof and rejects xfail, skipped, stale, unavailable, failed, or quarantine-only evidence.
- `test_registry_bti_rows_cover_every_current_row_owner`: the Blocking Test Index contains the required current-row reconciliation tests for Kernel, Dataset Contracts, qdb, migration/schema, copied candidate, and registry projection ownership with no missing owner.
