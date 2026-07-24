---
type: prj
domain: ccc
status: active
date_created: 2026-06-28
date_modified: 2026-07-11
version: 7.2.3
---

# CCC DuckLake v7.2.3 Orchestration And QDBCTL

Every postponed Dagu, production-topology, heavy-scheduling, or runtime-constant item in this module follows DD-003, DD-013, DD-020, and DD-024 in [[PRJ-AI-CCC-DuckLake-v7.2.3-Deferred-Decision-Registry]]. Unproven grammar, placement, or retry behavior remains uncallable or at the stated conservative limit.

This module is the v7.2.3 structural port for Dagu orchestration, `qdbctl` command/control surfaces, publish-path DAG triggers, phase-gate execution flow where operationalized by DAGs, and orchestration-local tests. It preserves the v6.5.0 semantics that Dagu coordinates deterministic CLI work but never owns transaction authority, state truth, provider enablement, or canonical data semantics.

## Module Boundary

**Owns:** `qdbctl` command grammar, publish-path and control command classification, Dagu safety profile, Dagu binary-pinning posture, parent/child DAG topology, DAG family seed, Dagu-to-CLI handoff rules, Dagu server/network refusal posture, orchestration-local acceptance tests, and the operational subset of the research-sanity example.

**Depends On:** [[PRJ-AI-CCC-DuckLake-v7.2.3-Publish-Control-Kernel]] for state invariants, legal transitions, locks, idempotency, `restore_proof` authority, and visibility; [[PRJ-AI-CCC-DuckLake-v7.2.3-Ops-Recovery-Maintenance-Security]] for backup/restore/cleanup operations, global observability, diagnostics, security, redaction, and runbooks; [[PRJ-AI-CCC-DuckLake-v7.2.3-QDB-Agent-Access-And-SQL-Zero]] for typed query surfaces and API-specific errors; [[PRJ-AI-CCC-DuckLake-v7.2.3-Architecture-Context-And-Bootstrap]] for dependency/build-vs-buy authority and repo/toolchain bootstrap; [[PRJ-AI-CCC-DuckLake-v7.2.3-Verification-Benchmarks-Readiness]] for phase matrix, cross-module test index, benchmark gates, and whole-system proof posture.

**Read After:** [[PRJ-AI-CCC-DuckLake-v7.2.3-Architecture-Context-And-Bootstrap]], [[PRJ-AI-CCC-DuckLake-v7.2.3-Publish-Control-Kernel]], and [[PRJ-AI-CCC-DuckLake-v7.2.3-Ops-Recovery-Maintenance-Security]].

**Non-Authoritative Restatements:** Kernel state names and transition semantics are linked here only to explain command routing; [[PRJ-AI-CCC-DuckLake-v7.2.3-Publish-Control-Kernel]] remains authoritative for state invariants. Build-vs-buy rationale is summarized only as operational context; [[PRJ-AI-CCC-DuckLake-v7.2.3-Architecture-Context-And-Bootstrap]] owns substrate and dependency decisions. Diagnostics and event schemas are invoked by `qdbctl`, but [[PRJ-AI-CCC-DuckLake-v7.2.3-Ops-Recovery-Maintenance-Security]] owns the global observability and `failed_run_diagnosis` schema.

## Source Port

| Source | Ported content |
|---|---|
| Primary PRD 1245-1275 | `qdbctl` CLI surface, flag-only grammar, publish-path state subcommands, control/read command split, copied-root restore proof nodes, and live-kernel restore proof writeback. |
| Primary PRD 1276-1289 where orchestration-facing | Dagu CLI entrypoint, task command gate list, and Dagu binary bootstrap. |
| Primary PRD 1621-1631 | `REQ-DAGU-*`, `REQ-DAGU-SERVER`, `REQ-DAGU-SAFETY`, `REQ-DAGU-MODULARITY`, and `REQ-DAGU-SCHEMA`. |
| Primary PRD 3342-3387 | Dagu safety and modularity profile plus Dagu DAG family seed. |
| Primary PRD 3388-3420 where orchestration-facing | Non-authoritative orchestration build-vs-buy context and Dagu row routing to Architecture. |
| Primary PRD 3445-3460 where orchestration-facing | Research-sanity example pieces that exercise `qdbctl`, diagnosis, and restore orchestration. |
| Primary PRD 3462-3707 where orchestration-local | Dagu and `qdbctl` acceptance tests that directly verify this module. |

Table: v6.5.0 source ranges structurally ported into this module.

## CLI Surface (`qdbctl`)

Dagu invokes one deterministic CLI, `qdbctl` through the `src/cli.py` entrypoint. Each publish-path state subcommand maps one-to-one to exactly one kernel transition and is wrapped by exactly one Dagu child DAG. `restore`, `cleanup`, `diagnose`, and `migrate` are side-effecting control commands outside the `planned → published` batch-state line; they must not perform hidden batch-state jumps. Read subcommands touch no kernel state and never appear in a mutation DAG. Plain verbs only, and the grammar is flag-only everywhere: there are no positional arguments, so an autonomous agent never infers meaning from position.

`qdbctl plan --dataset X --partition-scope Y [--idempotency-key K]` mints or accepts a deterministic retry key and prints a stable machine-readable payload: `{"batch_id": "...", "dataset": "...", "partition_scope": "...", "idempotency_key": "..."}`. Every publish-path state mutation (`stage`, `validate`, `commit`, `manifest`, `backup`, `candidate`, `publish`) plus the publish-path proof child (`restore --copied-root`) requires `--batch-id`. If `--idempotency-key` is omitted, `plan` mints one for a manual run; orchestrated publish DAGs MUST pass a stable key derived from the Dagu run identity plus dataset/partition so a parent retry cannot silently create a second batch.

If supplied, `plan` records the idempotency key in the plan payload and relies on the kernel uniqueness constraint to prove duplicate-run protection. A retry against an existing `(dataset, partition_scope, idempotency_key)` MUST read and return the existing batch identity, or use `ON CONFLICT DO NOTHING RETURNING` plus a read-back equivalent; it MUST NOT update or rewind an already-progressed batch row, timestamps, state, or failure fields.

`cleanup` and `migrate` are cross-batch control commands that operate on the filesystem and schema respectively and therefore do NOT take `--batch-id` (`CL5`). `diagnose` writes only `failed_run_diagnosis` and scopes its report with exactly one target flag: `--batch-id`, `--cleanup-id`, `--backup-id`, `--restore-id`, `--dag-run-id`, or `--qdb-query-id`. `--dataset` is an optional guard that MUST match the batch row when supplied, never the routing key; keying mutations on `--dataset` is unsafe under concurrent partitions, and `--idempotency-key` is retry-safety, not batch selection. Every subcommand with machine-readable output emits exactly one parseable stdout payload unless the pinned Dagu template uses that binary's proven structured-output mechanism; logs, progress, warnings, and diagnostics go to stderr or artifacts. `test_qdbctl_grammar_publish_path_requires_batch_id` asserts exactly this split.

`qdbctl` exit codes are a four-value contract that Dagu edges key off (FBL2-20d): `0` success, including a passing dry-run; `1` refusal or invariant failure (production-path refusal, validation failure, gate refusal, quarantine); `2` usage error (unknown flag, missing required flag, positional argument); `3` infrastructure error (catalog unreachable, Docker preflight failure, missing pinned binary). Retry policy keys off the idempotency-class table in `REQ-DAGU-02`, never off exit code `1`.

| `qdbctl` subcommand | Kernel transition / read | Dagu child DAG | Key flags (all flags; no positionals) |
|---|---|---|---|
| `plan` | `→ planned` | parent DAG step (no child; `plan` runs in the parent per `REQ-DAGU-MODULARITY` — FBL2-20a) | `--dataset`, `--partition-scope`, optional `--idempotency-key` (mints one when omitted; records supplied retry key when present; prints `batch_id` + `idempotency_key`) |
| `stage` | `planned → staged` | `stage.yaml` | `--batch-id` (required), `--scratch` (default), `--dataset` (optional guard) |
| `validate` | `staged → validated` | `validate.yaml` | `--batch-id` (required), `--tier`, `--dataset` (optional guard) |
| `commit` | `validated → committed` | `commit.yaml` | `--batch-id` (required), `--dataset` (optional guard) |
| `manifest` | `committed → manifested` | `manifest.yaml` | `--batch-id` (required), `--scratch` (default), `--dataset` (optional guard) |
| `backup` | `manifested → backed_up` | `backup.yaml` | `--batch-id` (required), `--dataset` (optional guard) |
| `restore` | copied-root restore-proof mechanism: runs a copied-root restore plus an unmodified `qdb` query under the copied-root jail and writes a durable `restore_proof`; invoked by the publish path for the pre-publish restorability proof and, against the candidate root, for the candidate recovery drill; no batch-state change by itself | `restore.yaml` | `--batch-id` (required), `--scratch` (default), `--copied-root`, `--proof-mode pre-publish` or `--proof-mode candidate-drill` (required with `--copied-root`; FBL2-13) |
| `candidate` | `backed_up → candidate` (promotes the batch to an isolated candidate marker/root that normal `qdb` cannot see, after the pre-publish restorability proof passes) | `candidate.yaml` | `--batch-id` (required), `--dataset` (optional guard) |
| `publish` | `candidate → published` (promotes the final visibility marker once, only after the candidate recovery drill against the candidate root passes) | `publish.yaml` | `--batch-id` (required), `--dataset` (optional guard); live promotion requires `--i-understand-this-touches-real-data` |
| `backup-catalog` / `backup-files` / `backup-check` | pre-live/live backup control commands; no batch-state transition | ops/runbook only | `--manifest-id` or `--backup-id` as applicable; no positional mode argument |
| `restore-copied-root` | pre-live/live restore drill/control command; no batch-state transition | ops/runbook only | `--backup-id`, `--target-root`, `--target-dsn`; no positional mode argument |
| `config-doctor` | read (validates config/env against the classifier; no kernel state) | ops/runbook only (pre-live; FBL2-20e) | `--format json` |
| `storage-probe` | pre-live storage capability probe; writes probe artifact, no batch-state transition | ops/runbook only (pre-live; FBL2-20e) | `--lake-root-id <id>`, `--host-role <role>`, `--format json` |
| `storage-compare-hosts` | pre-live two-host storage comparison; writes probe artifact, no batch-state transition | ops/runbook only (pre-live; FBL2-20e) | `--lake-root-id <id>`, `--format json` |
| `cleanup` | none (writes `cleanup_eligibility`; deletion gated by `REQ-MAINT-02`) | `cleanup_dry_run.yaml` (FBL2-20a) | `--dry-run` (default), `--approve <hash>` |
| `diagnose` | none (writes `failed_run_diagnosis`) | `diagnose_failure.yaml` (invoked on child failure) | exactly one of `--batch-id`, `--cleanup-id`, `--backup-id`, `--restore-id`, `--dag-run-id`, `--qdb-query-id`; `--format text\|json` |
| `migrate` | DDL only (writes `schema_migrations`) | `migrate.yaml` | none |
| `describe-dataset` | read | n/a | `--dataset` |
| `kernel-status` | read (locks, leases, batch states) | n/a | `--dataset` |
| `status` (v7.2.3) | read — THE single operator status surface (`REQ-MON-03` in [[PRJ-AI-CCC-DuckLake-v7.2.3-Ops-Recovery-Maintenance-Security]]): composes `REQ-OBS-SCHEMA` events, backlog item states, and committee checkpoint records; adds no second aggregation pipeline, and every other status-like view is a documented projection of the same sources | n/a | `--dataset` (optional), `--format text\|json` |

Table: `qdbctl` subcommands classified as publish-path transitions, side-effecting control commands, or reads. The manifest seed records `qdbctl manifest --dataset equity_bar_1d --batch-id batch_sample_equity_1d_20260607 --scratch` as its sealing command; the later `publish` row (`qdbctl publish --batch-id batch_sample_equity_1d_20260607`) is exercised end-to-end on scratch data as the final post-backup visibility step.

> [!important] `restore.yaml --copied-root` IS the copied-root restore proof (`DG5`)
> The `restore.yaml` child invoked with `--copied-root` and the `copied_root_restore` control child named in `REQ-DAGU-MODULARITY` are the SAME copied-root restore child TEMPLATE (`restore.yaml`), defined once but instantiated as two distinct blocking step nodes in the parent DAG: the pre-publish restorability proof node (after `backup`, before `candidate`) and the candidate recovery drill node (after `candidate`, before `publish`). The Phase 0 parent ordering invariant is `backup → pre-publish restore proof → candidate promote → candidate recovery drill → publish` — the pre-publish restorability proof runs in scoped proof-mode under the copied-root jail, then the batch is promoted to an isolated candidate marker/root, the candidate recovery drill restores that candidate catalog and runs an unmodified `qdb` query against the candidate, and only a passed drill promotes the final `published` marker. So `backed_up → candidate` is gated on a passed pre-publish `restore_proof`, and `candidate → published` is gated on a passed candidate drill. The two step nodes are distinguished on the command line by `--proof-mode` (FBL2-13): the pre-publish node runs `qdbctl restore --batch-id <id> --copied-root --proof-mode pre-publish` (mapping to `restore_proof.proof_mode = 'pre_publish_restorability'`), and the candidate-drill node runs `--proof-mode candidate-drill` (mapping to `'candidate_recovery_drill'`), which restores the batch's own `backup_id` into `backup_marker.candidate_root_path`. Proof mode is never inferred from current batch state — a crash or retry mid-promotion would silently mis-mode the proof. Backed by `test_phase0_parent_dag_sequence`.

> [!important] Restore proof writes back to the live kernel (`RP1`)
> The copied-root jail is the proof target, not the authority that advances the live batch. The restore child MUST write an external restore-evidence artifact from inside the jail, then the parent/control process records the durable `restore_proof` row in the live catalog+kernel database using the original live kernel DSN after verifying the artifact hash, `target_dsn_fingerprint`, `inventory_hash`, proof mode, and no live-root leak. A `restore_proof` row that exists only inside the jailed/restored database is not sufficient to advance `backed_up → candidate` or `candidate → published`; if the live-kernel write fails, the live batch remains non-visible and `qdbctl diagnose` is the operator path. Backed by `test_restore_proof_from_copied_root_jail_is_recorded_in_live_kernel` and `test_jailed_restore_proof_row_alone_cannot_advance_live_batch`.

## Orchestration Bootstrap Touchpoints

Dagu invokes the unified `src/cli.py` with deterministic subcommands, not ad-hoc inline scripts. Business logic lives in Python/CLI, not YAML.

Task commands include `task setup`, `task setup:dagu`, `task setup:duckdb-extensions`, `task test`, `task test:unit`, `task test:integration`, `task lint`, `task lint:dagu`, `task typecheck`, `task verify`, `task verify:bootstrap`, `task verify:offline`, `task verify:deps`, `task verify:deps:candidates`, `task verify:lockfile`, `task verify:phase0`, `task verify:phase0-index`, `task verify:qdbctl-grammar`, `task verify:toolchain`, `task verify:ducklake-api`, `task verify:phase1`, `task verify:iface`, `task verify:source-adapter-gate`, `task verify:options`, `task verify:retrieval`, `task verify:prelive`, `task guard:vendored-schema`, `task smoke:ducklake`, `task smoke:dagu`, `task smoke:nas`, `task backup:test`, `task restore:test`, `task bench:sample`, `task fixtures:build`, and `task example:phase0`.

Dagu binary bootstrap (`DG1`, `DG6`): `task setup:dagu` fetches the pinned Dagu binary `${DAGU_VERSION}` into a repo-local `.bin/` and verifies it against `${DAGU_SHA256}` before first use. `dagu version`, the `dagu schema dag` existence probe, `dagu validate`, CI, and `task smoke:dagu` all run that pinned binary, never a system-wide install. If `dagu schema dag` is absent, the repo records that fact and relies on `dagu validate`, the validate API, and its own JSON Schema for typed `actions:` wrappers. The exact `${DAGU_VERSION}`, download URL, SHA-256, license variant, field grammar, and schema subcommand presence are confirmed at repo creation and bind `REQ-DAGU-SAFETY`.

## Dagu Orchestration Requirements (`REQ-DAGU`)

- `REQ-DAGU-01`: Dagu MUST orchestrate deterministic CLI commands through `src/cli.py` rather than embedding business logic in YAML.
- `REQ-DAGU-02`: Production DAGs MUST specify queue, worker selector, timeout, retry policy, idempotency class, artifacts, and failure-notification behavior. The project-owned idempotency class enum is `read_probe`, `idempotent_mutation_pre_side_effect`, `external_side_effect`, and `destructive`; it is encoded in typed `actions:` wrapper metadata or project lint metadata so lint can distinguish retryable probes from non-retryable mutation/external-side-effect steps. Step assignment (FBL2-20c): `plan`, `stage`, `validate`, and `candidate` are `idempotent_mutation_pre_side_effect`; `commit`, `manifest`, `backup`, `restore`, and `publish` are `external_side_effect`; approved cleanup deletion is `destructive`; reads, dry-runs, and probes (`kernel-status`, `describe-dataset`, `cleanup --dry-run`, `config-doctor`, `storage-probe`) are `read_probe`.
- `REQ-DAGU-03`: Publish, maintenance, restore, and catalog-mutation DAGs MUST be non-overlapping for affected datasets; non-idempotent/destructive steps MUST NOT auto-retry.
- `REQ-DAGU-04`: Catalog restore, cleanup/orphan deletion, and production publish promotion MUST be approval-gated or require explicit CLI flags.
- `REQ-DAGU-05`: Dagu worker placement MUST follow the Worker Classes table below: catalog-adjacent/control jobs default to the `control_worker` (M4 Mac mini) and heavy transforms to the `lake_heavy_worker` (M5 Max). The NAS MUST NOT be assumed to run heavy compute, and the M2 node MUST NOT silently become the default heavy-transform worker. Distributed/multi-worker topology is deferred until after the storage probe; until then routing may collapse to a single host, and catalog mutation, approval, cleanup, and the final publish marker MUST be pinned to that single local worker. Single-host collapse is legitimate only when the collapsed host is heavy-eligible (the M5 dev loop is the normal Phase 0 case): when the Dagu scheduler lives on the control node, `stage`, `validate`, and any heavy Polars/DuckDB transform payload MUST still execute on a host whose `heavy_lake_job_allowed` is true — the control node dispatches those steps and never executes their payloads in-process, and doing so is a guardrail failure, not an acceptable simplification. The exact worker-placement field name (`worker_selector` vs `tags` vs another binary-specific spelling) is a verification item (`DG3`) resolved against the pinned binary's docs and demonstrated by the canonical template, not asserted here.
- `REQ-DAGU-05b`: Heavy lake-transform DAG classes — `stage`/`validate`/`commit` payloads at scale, non-dry-run `maintenance_ducklake__{scope}` operations (`merge_adjacent_files`, `rewrite_data_files`, approved cleanup), full-volume backfills, and benchmarks — MUST declare `worker_class: lake_heavy_worker` in their step metadata and MUST refuse to schedule on any host where `ops/topology.yaml` sets `heavy_lake_job_allowed: false`. `task verify:prelive` MUST include a deliberately misrouted smoke DAG that asserts this refusal fires before pre-live topology is treated as proven. Backed by `test_heavy_lake_job_refuses_control_and_inference_only_hosts`.
- `REQ-DAGU-06`: Phase 0/pre-live Dagu queue configuration MUST cap concurrent heavy-transform jobs at `max_global_heavy_jobs: 1`, recorded in the canonical parent DAG's queue config and verified by `task smoke:dagu`. The single heavy slot is bound to the `lake_heavy_worker` class — never `control_worker`, `headless_compute_worker`, or `retrieval_inference_worker` — so the concurrency cap also binds placement, not just count.
- `REQ-DAGU-SCHEDULE`: No source DAG (`source_plan__{source}`, `source_download__{source}`) may be bound to a live Dagu trigger, cron expression, polling loop, or streaming listener until a `source_schedule__{source}` contract exists for that source. No such contract exists in v7.2.3, so ALL live-source downloads are operator-triggered batch runs. A future `source_schedule__{source}` contract MUST define: the trigger basis and which clock it keys off (exchange session close, vendor file availability, source-visible timestamp, or local ingestion time — see the "What EOD Means" clock definitions in [[PRJ-AI-CCC-DuckLake-v7.2.3-PIT-And-Bitemporal-Policy]]), the trading calendar it consults, the allowed run window, retry/backoff policy, late/corrected-file handling, the idempotency key shape, and the failure/quarantine path. Planning-note cadence prose (for example the "11:30 ET after next-day drops" spine in [[REF-AI-CCC-DuckLake-v7.2.3-Source-Universe-Planning]]) is retained as gated design only, never executable truth. Backed by `test_source_dags_have_no_live_trigger_without_schedule_contract`.
- `REQ-DAGU-SERVER`: Dagu MUST be fail-closed on the network. Phase 0 MUST NOT start a long-running Dagu web/API server; orchestration runs the pinned binary's scheduler/CLI only. If a Dagu server is ever started, it MUST bind to loopback (`127.0.0.1`) only and require authentication, and MUST NOT listen on a routable interface. The known unauthenticated remote-code-execution advisory GHSA-6qr9-g2xw-cw92 applies to an exposed Dagu server, so any non-loopback or unauthenticated Dagu server is a guardrail failure; `docs/runtime-verification/dagu_binary.json` records the advisory status against the pinned version. Backed by `test_dagu_server_not_started_or_loopback_auth_required`.
- `REQ-DAGU-SAFETY`: Mutation DAGs MUST pass `dagu validate` and `dagu schema dag` only if that subcommand exists in the pinned binary, with the version and SHA pinned in `docs/runtime-verification/dagu_binary.json`. The concrete field grammar is NOT asserted here (`DG1`): every workflow is authored against the pinned binary's own documentation and proven by a committed `dagu validate`-passing parent+child template before any field is trusted. Project lint forbids only genuine anti-patterns once the binary's real grammar is known. Critical publish/validate/manifest/backup/final-marker/restore/cleanup/orphan-delete steps MUST NOT use `continue_on` or other success-masking behavior and MUST NOT be covered by broad root/default retries; retries are allowed only for `read_probe` or `idempotent_mutation_pre_side_effect` classes with bounded retry policy. Every mutation DAG MUST set explicit labels, queue, whole-DAG and step timeouts, bounded max-active-steps, artifact policy, failure/exit handlers, and `dotenv: []` unless a named scratch env file is part of the test.
- `REQ-DAGU-MODULARITY`: Dagu workflows MUST be modular by contract. A Phase 0 parent control DAG with underscore-only step IDs MUST orchestrate exactly one child DAG per publish-path step: `stage`, `validate`, `commit`, `manifest`, `backup`, `candidate`, and `publish` as one-to-one batch-state mutations; `restore --copied-root` as the publish-path proof child whose `restore.yaml` template is instantiated as two distinct blocking step nodes; plus separate control/failure children for `cleanup_dry_run` and `diagnose_failure`. There is no second `copied_root_restore` child template. Required proof children MUST be invoked as blocking children; non-blocking background children MAY be enqueued only after the parent reaches a safe visible state. The `batch_id` minted by `qdbctl plan` reaches each publish-path child through a Dagu output variable substituted into `--batch-id` (`DG2`), and each child receives `QDB_DUCKLAKE_CATALOG_DSN` by secret name through an explicit `env:` mapping under `dotenv: []` (`DG4`). Each child DAG MUST declare its own tools, artifacts, secrets/`dotenv` posture, handlers, timeouts, and worker policy, because managed tools are scoped to a DAG run and not inherited by sub-DAGs. Reusable leaf call shapes MUST live in typed `actions:` wrappers with JSON Schema input/output. Official or third-party Dagu Actions are allowed only when pinned by tag or commit SHA. Manifests, diagnosis bundles, validation reports, and logs MUST be Dagu artifacts; small control values use the output channel; publish-critical semantics MUST NOT depend on hidden `base.yaml` behavior.
- `REQ-DAGU-SCHEMA`: The `jsonschema` library MAY validate the typed `actions:` wrapper input/output schemas and other generated Dagu-adjacent JSON from Python, resolved under `REQ-AUTH-DEP-01`. It does NOT replace authority: pinned-binary `dagu validate`, `dagu schema dag` when that subcommand is proven present, project anti-pattern lint, and modular child-DAG policy remain the orchestration-safety authority. `jsonschema` checks artifact shape only, never Dagu execution semantics, queueing, locks, or publish-critical step behavior.

## Worker Classes

Worker classes are placement roles enforced by this module; the binding hardware posture (allowed/forbidden services per physical host) is the Host Role Matrix in [[PRJ-AI-CCC-DuckLake-v7.2.3-Architecture-Context-And-Bootstrap]].

| Worker class | Host | May run | Must not run |
|---|---|---|---|
| `control_worker` | M4 Mac mini (`control`) | Dagu scheduling/dispatch, catalog-mutation commands, approval steps, cleanup control, final publish marker, catalog backups, monitoring, light maintenance | `stage`/`validate`/`commit` payloads, heavy transforms, backfills, benchmarks |
| `lake_heavy_worker` | M5 Max (`dev_workstation`) | Heavy backfills and transforms, `stage`/`validate`/`commit` payloads, compaction/maintenance execution, benchmarks; holds the single `max_global_heavy_jobs` slot | Always-on control services (PostgreSQL catalog authority, Dagu scheduler ownership) |
| `headless_compute_worker` | M2 Max (`compute_inference`) | Bounded, explicitly assigned offloaded compute, only after topology and storage proof name it for the specific job | Catalog mutation, publish promotion, default heavy-lake routing, any early-lake-correctness dependency |
| `retrieval_inference_worker` | M2 Max (`compute_inference`) | Embedding/reranking/retrieval jobs when `QDB_ENABLE_RETRIEVAL` is enabled | Any lake-heavy job; any publish-path step |

Table: Worker classes. Lake-heavy jobs can never legally target the Mac mini or a retrieval-only class; `REQ-DAGU-05b`'s refusal plus the misrouted smoke DAG make that mechanical rather than conventional.

## Intake-Mode Matrix

This matrix is the normative intake-semantics contract for v1. A mode not marked allowed here MUST NOT be invented by an implementer, no matter how complete the provider capability pack looks.

| Intake mode | v1 status | Precondition contract |
|---|---|---|
| Constant real-time streaming (WebSocket or equivalent) | Unsupported in v1 | Would require a future source-specific streaming contract; none exists or is planned in this PRD. |
| Continuous polling | Unsupported in v1 | Would require a `source_poll__{source}` contract; none exists. Do not invent a polling loop. |
| Operator-triggered batch | Allowed after provider gates | `REQ-SRC-VERIFY` capability pack plus source-availability policy; multi-partition historical pulls additionally require a `source_backfill_plan.v1` per `REQ-SRC-BACKFILL-PLAN` in [[PRJ-AI-CCC-DuckLake-v7.2.3-Provider-Capability-And-Availability]]. |
| Scheduled EOD/T+1 batch | Deferred — unavailable in v1 | Requires a `source_schedule__{source}` contract per `REQ-DAGU-SCHEDULE`; until one exists, every live-source download is an operator-triggered batch run. |
| First shippable release | Fixture-only except `synthfix` | Every live provider pack ships `adapter_enabled: false`; `synthfix` is the only enabled provider. |

Table: Normative intake modes. "EOD" is not one clock: the trigger-clock definitions (exchange session close vs vendor file availability vs source-visible timestamp vs local ingestion time) live in [[PRJ-AI-CCC-DuckLake-v7.2.3-PIT-And-Bitemporal-Policy]], and every future schedule contract names its trigger clock explicitly.

## Dagu Safety And Modularity Profile

Dagu is the local orchestration/control plane, not the transaction authority. The Dagu YAML grammar is a verification item, not a PRD-asserted fact (`DG1`): known external grammar candidates conflict (`action: dag.run`, child invocation via `call:`, and worker placement via `tags`), and Ryan's own stack runs a Dagu v2.x line, so no unverified grammar is adopted here.

The Dagu pin resolves deterministically under `REQ-AUTH-01` using the same ordered-candidate mechanism as the market-calendar pin: the agent resolves a stable Dagu 2.x release from candidate origins `github.com/dagucloud/dagu` and `github.com/dagu-org/dagu` as of build date; records the actual serving org, release URL, source relation, `DAGU_VERSION`, `DAGU_SHA256`, and license variant in `docs/runtime-verification/dagu_binary.json`; and treats the selected origin as evidence, not as a hardcoded PRD fact. Ryan MAY override with an explicit reviewed pin via the pre-handoff config slot. A missing override does not block the build as long as exactly one candidate passes official-doc or runtime-fetch/hash proof, but any origin conflict, missing checksum, or license/source ambiguity that the probe cannot resolve fails closed before `verify:phase0`. The agent MUST NOT cross to a new major version (3.x), a pre-release, or an observed system binary; a system-installed Dagu is context only, never the pin.

The repo MUST fetch the resolved binary into repo-local `.bin/dagu`, record `dagu version`, official release URL, source URL, binary SHA, and license evidence in `docs/runtime-verification/dagu_binary.json`, author every workflow against that binary's own documentation, and commit one `dagu validate`-passing parent control DAG plus one child DAG as the canonical template that every other DAG copies before any specific field grammar is trusted. Whether `dagu schema dag` exists in the pinned binary is itself a verification item (`DG6`): if it is absent, drop it and rely on `dagu validate`, the validate API, and the repo's own JSON Schema for typed `actions:` wrappers.

> [!warning] Residual Dagu pin risk
> Absent a human-reviewed pin, the recorded hash attests the integrity of the fetched artifact, not its provenance; a reviewed pin dropped into the pre-handoff config slot restores the stronger out-of-band anchor at any time.

The project lint forbids only genuine anti-patterns (success-masking on critical steps, hidden retries, inherited `base.yaml` behavior on publish-critical semantics) once the binary's real grammar is known; it MUST NOT hardcode a forbidden-field list against fields that turn out to be that binary's current idiom.

Mutation DAGs default to `dotenv: []`, explicit secrets/profile selection, explicit labels, queue, timeout, max active steps, artifact policy, and handler-on-failure/exit behavior. Critical publish, validate, manifest, backup, final marker, restore, cleanup, and orphan-delete steps must not use `continue_on`, success-masking behavior, or unsafe root/default retries; retries are allowed only for bounded idempotent probes or reads. Large validation reports, manifest bundles, restore evidence, stdout/stderr captures, and diagnosis bundles are Dagu artifacts; `output` is reserved for small control values.

The Phase 0 topology is a parent control DAG with `plan` in the parent and blocking child DAGs for `stage`, `validate`, `commit`, `manifest`, `backup`, the pre-publish `restore --copied-root` restorability proof, `candidate`, the candidate-recovery-drill `restore --copied-root` node, and `publish`, plus separate control/failure children for `cleanup_dry_run` and failed-run diagnosis. Each child declares its own tools, artifacts, secrets/dotenv posture, handlers, timeouts, and worker policy; inherited hidden behavior in `base.yaml` is not allowed for publish-critical semantics. Reusable local leaf calls live in typed `actions:` wrappers with JSON Schema inputs and outputs. Official or third-party Dagu Actions are allowed only when pinned by tag or commit SHA.

Every `qdbctl` subcommand that emits machine-readable control data reserves stdout for exactly one parseable payload by default. Logs, Typer messages, progress output, warnings, and diagnostics go to stderr or named artifacts. When the pinned Dagu binary supports a validated structured-output mechanism, the canonical template uses that mechanism for child handoff and records the exact syntax in `docs/runtime-verification/dagu_binary.json`; stdout payloads remain a compatibility fallback only after the one-payload purity test passes. Large outputs always become artifacts.

Distributed workers are deferred until after the storage probe. Catalog mutation, approval, cleanup, restore, and final publish control steps pin all critical work to the single local worker; heavy transform payloads stay on the `lake_heavy_worker` per `REQ-DAGU-05`/`REQ-DAGU-05b` even in the single-worker collapse. The exact worker-placement field name is a verification item (`DG3`) resolved against the pinned binary's docs and demonstrated by the canonical template. Worker labels may be introduced for isolated compute-heavy child DAGs (the M2 `headless_compute_worker`) only after the NAS/storage route is proven.

Dagu runs fail-closed on the network: Phase 0 starts no long-running Dagu web/API server, only the pinned scheduler/CLI. If a server is ever introduced, it binds to loopback only and requires authentication; an exposed or unauthenticated Dagu server is subject to GHSA-6qr9-g2xw-cw92 and is a guardrail failure (`REQ-DAGU-SERVER`).

> [!important] Parent to child `batch_id` passing and child DSN injection (`DG2`, `DG4`)
> `qdbctl plan` mints or accepts the idempotency key and prints the `batch_id` payload, and every publish-path child requires `--batch-id`; the canonical template MUST pass a stable orchestrator-derived `--idempotency-key` into `plan` and demonstrate capturing the plan payload without log contamination. Prefer the pinned binary's proven structured-output mechanism when available; otherwise capture stdout only because `qdbctl` guarantees exactly one JSON payload on stdout and routes all chatter to stderr/artifacts. The exact substitution expression is resolved against the pinned binary, not asserted here, so children never read a hand-rolled shared `.txt` file. Because mutation DAGs run with `dotenv: []`, each child that connects to PostgreSQL MUST receive `QDB_DUCKLAKE_CATALOG_DSN` through an explicit `env:` mapping from Dagu's secrets manager, by secret name only, so the child process can connect while no secret is written into YAML. Non-secret required variables (paths, limits, booleans) pass to children as literal `env:` entries; only DSN-class/secret values are injected by secret NAME from the secrets manager (FBL2-20b). Both are demonstrated by the committed parent+child template and a Testcontainers smoke run.

## Dagu DAG Families

Dagu should orchestrate deterministic repo CLI commands and persist artifacts; it should not be the publish ledger. The family names below are seeds for the future repo, not a requirement to create all DAGs before their phase.

| DAG family | Phase | Purpose | Required boundary |
|---|---|---|---|
| `smoke_ducklake_postgres_scratch` | Phase 0 | Attach two clients to scratch catalog and prove coordination | Scratch only; no production DSN. |
| `publish_control__{dataset}` | Phase 0/1 | Parent control DAG runs `plan` and orchestrates `stage`, `validate`, `commit`, `manifest`, `backup`, `restore --copied-root`, diagnosis, and publish marker | Calls kernel CLI; failed validation invisible; binary-proven grammar only; no critical `continue_on`. |
| `source_plan__{source}` | Phase 1 | Plan live-capable downloads without mutation | Plan mode mandatory before live; operator-triggered only — no schedule trigger without a `source_schedule__{source}` contract (`REQ-DAGU-SCHEDULE`). |
| `source_download__{source}` | Phase 1+ | Download/stage raw evidence | Feature flag, rate limits, immutable raw output; operator-triggered batch only until a `source_schedule__{source}` contract exists; multi-partition history requires `source_backfill_plan.v1`. |
| `normalize__{source}_{dataset}` | Phase 1+ | Normalize raw to staging/bronze/silver candidate | Staging only before validation. |
| `validate__{dataset}` | Phase 0+ | Run schema/dtype, materialized, DuckDB SQL, PIT-interval/source-clock, manifest/file, and `qdb` smoke validation | Fail closed before publish; child DAG uses artifacts for reports. |
| `commit__{dataset}` | Phase 0+ | Commit validated fixture/core data to DuckLake through the kernel publish path | Serializes per dataset/partition; kernel owns visibility; used by the Phase 0 parent DAG. |
| `publish_partition__{dataset}` | Phase 1+ | Scale the same commit/publish path across source partitions after provider gates pass | Reuses Phase 0 kernel path; live/source-scale work stays behind provider and pre-live gates. |
| `backup_catalog__{scope}` | Phase 0+ | Backup PostgreSQL catalog plus kernel metadata with globals evidence | Bind to manifest/snapshot/lake root and copied-root restore mode. |
| `restore_catalog_copied_root_scratch` | Phase 0+ | Prove copied-root fresh-catalog restore | Never touches production catalog; runs one PIT `qdb` query. |
| `maintenance_ducklake__{scope}` | Phase 1+ | Flush/expire/merge/rewrite/cleanup dry-run/delete with inlining evidence | Dry-run default; delete requires approval hash, backup guard, and no overlap with publish. |
| `build_gold_mart__{mart}` | Phase 1+ | Build derived query-ready marts | Includes lineage and adjustment/PIT policy. |
| `bench__{query_class}` | Phase 0+ | Persist benchmark and profile artifacts | Records host/storage/cache/data shape. |
| `options_sample_publish` | Phase 1B | Prove options EOD companion sample | Separate gate; core only blocks on shared-contract failure. |
| `retrieval_eval__sec_news` | Phase 2 | Future retrieval eval | Feature-flagged, absent from core gates. |

Table: Dagu family seed.

## Operational Build-Vs-Buy Restatement

The build-vs-buy split is deliberately narrow: buy commodity infrastructure, custom-build only the trading semantics, the `known_at`/lineage model, and the safe agent/query boundary. This module consumes the architecture decision that orchestration is bought through Dagu, resolved by deterministic stable-2.x selection under `REQ-AUTH-01` from candidate origins `github.com/dagucloud/dagu` and `github.com/dagu-org/dagu`, with Ryan reviewed override optional and offline fetch/hash/source/license ambiguity failing closed. The detailed build-vs-buy candidate map and dependency authority live in [[PRJ-AI-CCC-DuckLake-v7.2.3-Architecture-Context-And-Bootstrap]].

## Orchestration Portion Of The Research-Sanity Example

`examples/01_phase0_research_sanity.py`, run via `task example:phase0`, is the end-to-end smoke a researcher reads first. The orchestration-owned pieces are: `qdbctl kernel-status` to show batch states and locks; `qdbctl diagnose --batch-id <id> --format text` on a deliberately failed publish, plus at least one non-batch target such as `--cleanup-id <id>` in tests; and a copied-root scratch restore into a fresh catalog followed by re-running one PIT query to prove the restored lake answers identically. The example imports nothing from the vault and runs entirely on `synthfix` fixtures, so it doubles as the human-readable proof that the fixture-complete Definition of Done holds. The full phase/example gate is indexed by [[PRJ-AI-CCC-DuckLake-v7.2.3-Verification-Benchmarks-Readiness]].

## v7.2.3 copied activation, retry, provenance, and dispatch amendments

AMD-004 invokes Kernel's jailed copied-catalog activation between restore validation and ordinary qdb. It records copied catalog/root and candidate identities and mechanically refuses live endpoints. It does not add a second qdb path or alter normal registry visibility.

AMD-012 adds `qdbctl retry-side-effects` with UTC due-before, positive limit, and dry-run. It claims only due non-terminal rows under existing lock/state authority, preserves the original idempotency key, and proves schedule progression.

AMD-024 names `DAGU_ARCHIVE_SHA256` for downloaded release bytes and `DAGU_BINARY_SHA256` only for the extracted executable with its subject path. The selected release and `dagu validate` evidence are recorded after bootstrap in `docs/runtime/dagu-provenance.v1.json`; no post-bootstrap fact retro-edits this PRD.

AMD-048 adds transport-neutral dispatch that consumes verified host, release, and access artifacts; binds timeout, idempotency, and evidence return; and preserves M4 sole publish authority. No unselected SSH, Tailnet, or Dagu wrapper is inferred as a transport.

## Orchestration-Local Acceptance Tests

These test names stay adjacent to the orchestration owner because they directly verify Dagu, DAG topology, `qdbctl` grammar, child handoff, and orchestration refusal behavior. [[PRJ-AI-CCC-DuckLake-v7.2.3-Verification-Benchmarks-Readiness]] indexes them cross-module without becoming the primary owner.

- `test_dagu_aborts_publish_on_validation_failure`
- `test_dagu_publish_dag_lint_forbids_continue_on_and_mutation_retries`
- `test_dagu_pinned_binary_parent_child_template_validates_and_records_grammar`
- `test_dagu_control_dag_calls_validation_manifest_backup_restore_children`
- `test_dagu_child_dags_declare_their_own_tools_artifacts_and_handlers`
- `test_dagu_large_reports_use_artifacts_not_output_variables`
- `test_dagu_server_not_started_or_loopback_auth_required`
- `test_qdbctl_subcommands_map_one_to_one_to_kernel_transitions`
- `test_qdbctl_plan_outputs_batch_id_and_publish_path_mutations_require_it`
- `test_qdbctl_plan_accepts_optional_idempotency_key_and_reuses_retry_identity`
- `test_qdbctl_plan_retry_does_not_mutate_progressed_batch_row`
- `test_dagu_parent_retries_reuse_stable_orchestrator_idempotency_key`
- `test_qdbctl_diagnose_accepts_target_union_and_rejects_ambiguous_targets`
- `test_qdbctl_dataset_flag_must_match_batch_dataset_when_supplied`
- `test_qdbctl_grammar_is_flag_only_no_positionals`
- `test_phase0_parent_dag_sequence`
- `test_phase0_parent_dag_includes_stage_commit_publish_children`
- `test_qdbctl_grammar_publish_path_requires_batch_id`
- `test_heavy_lake_job_refuses_control_and_inference_only_hosts` (shared with Ops; Orchestration owns the placement contract, Ops owns the topology file)
- `test_source_dags_have_no_live_trigger_without_schedule_contract`
- `test_failed_run_diagnosis_operator_next_actions_drive_text_renderer` (shared with Ops; Orchestration exercises the CLI path, Ops owns the schema/text-rendering contract)

## v7.2.3 r2 restored indexed acceptance criteria

- `test_candidate_qdb_returns_copied_sentinel_and_lineage`: the candidate recovery drill queries only the copied candidate root/catalog and returns the expected sentinel plus lineage proving no live-root read occurred.
- `test_retry_side_effects_claims_due_rows_bounded_and_never_revives_terminal`: the retry command claims only due rows up to its bound, respects leases, and never returns a succeeded, permanently failed, or quarantined row to a retryable state.
- `test_dagu_provenance_distinguishes_archive_and_binary_subjects`: provenance records and verification separately hash the downloaded archive, extracted binary, and validated DAG fixture; one subject's hash cannot satisfy another.
