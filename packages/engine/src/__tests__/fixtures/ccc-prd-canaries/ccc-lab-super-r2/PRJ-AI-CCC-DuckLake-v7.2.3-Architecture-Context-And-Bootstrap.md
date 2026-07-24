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
  - architecture
  - bootstrap
  - structural-rewrite
---

# CCC DuckLake v7.2.3 Architecture Context And Bootstrap

Every postponed dependency, runtime binding, retrieval, storage-alternative, hot-mart, calendar, or package-layout item in this module follows DD-003, DD-004, DD-014, DD-018, DD-019, DD-023, and DD-024 in [[PRJ-AI-CCC-DuckLake-v7.2.3-Deferred-Decision-Registry]]. Ordered candidate tests decide exact technical facts; missing evidence keeps the affected path blocked or absent.

This module owns architecture context, dependency candidate discipline, repository bootstrap, toolchain shape, phase framing, config validation, and build-vs-buy posture for the v7.2.3 structural rewrite. It preserves the v6.5.0 architecture decisions while linking away from future owner modules for kernel semantics, provider enablement, dataset contracts, manifests, orchestration procedure, ops recovery, and verification status.

## Owns

- External dependency candidates, authority boundaries, proof gates, and the `REQ-AUTH-DEP-01` ordinary-dependency resolution rule.
- Data-universe constraint framing as architecture context, while source planning authority stays in [[REF-AI-CCC-DuckLake-v7.2.3-Source-Universe-Planning]] and provider enablement authority stays in [[PRJ-AI-CCC-DuckLake-v7.2.3-Provider-Capability-And-Availability]].
- Hardware/deployment assumptions, glossary, rationale, current decisions, architecture overview, phase map, proof harness descriptions, repository contract, bootstrap plan, toolchain, implementation index shape, config validation, production-path classifier, and build-vs-buy decision context.

## Depends On

- [[PRJ-AI-CCC-DuckLake-v7.2.3-Executive-Contract-And-Authority]] for release authority, scope, non-goals, and fixture-complete Definition of Done.
- [[PRJ-AI-CCC-DuckLake-v7.2.3-Publish-Control-Kernel]] for state transitions, kernel records, locks, idempotency, manifest-bound visibility, and publish semantics.
- [[PRJ-AI-CCC-DuckLake-v7.2.3-Dataset-Contracts-And-Validation]] for canonical schemas, validation tiers, transform traps, and dataset contract bodies.
- [[PRJ-AI-CCC-DuckLake-v7.2.3-Manifests-Lineage-And-Fixtures]] for manifest shape, restore bundle inventory, fixture specs, schema artifact inventory, and serialized proof artifacts.
- [[PRJ-AI-CCC-DuckLake-v7.2.3-Orchestration-And-QDBCTL]] for `qdbctl`, Dagu DAGs, child templates, schedules, and operator procedures.
- [[PRJ-AI-CCC-DuckLake-v7.2.3-Ops-Recovery-Maintenance-Security]] for backup, restore, cleanup, maintenance, storage safety, redaction, observability, and global error taxonomy.
- [[PRJ-AI-CCC-DuckLake-v7.2.3-Verification-Benchmarks-Readiness]] for the phase/test matrix, benchmark gates, verification backlog, readiness checklist, and final proof status.

## Read After

- [[260708-DuckLake-Quant-Stack-PRD-v7.2.3]]
- [[PRJ-AI-CCC-DuckLake-v7.2.3-Executive-Contract-And-Authority]]

## Non-Authoritative Restatements

- The phase map here names modeling-interface and orchestration lanes for architecture context only. [[PRJ-AI-CCC-DuckLake-v7.2.3-Modeling-Engine-Interface]] owns `REQ-IFACE-*`, and [[PRJ-AI-CCC-DuckLake-v7.2.3-Orchestration-And-QDBCTL]] owns `qdbctl` and Dagu implementation details.
- Schema and manifest artifact references here route bootstrap work; schema bodies and manifest fields belong to [[PRJ-AI-CCC-DuckLake-v7.2.3-Dataset-Contracts-And-Validation]], [[PRJ-AI-CCC-DuckLake-v7.2.3-Manifests-Lineage-And-Fixtures]], and [[PRJ-AI-CCC-DuckLake-v7.2.3-Ops-Recovery-Maintenance-Security]] by topic.
- Candidate package names and vendor names are verification items, not pins. No package enters `pyproject.toml`, no provider is enabled, and no live adapter is activated from this architecture prose alone.

## Project And Configuration Requirements

- `REQ-CFG-01`: The implementation MUST live in the external repo under `/Users/ryanpappal/03_CODE/ccc-lab-super/` unless Ryan explicitly chooses another path, and MUST run without the vault root as cwd. This path is the external implementation code repo on the filesystem, not the vault project folder `00_MAIN/01_ActiveProjects/ccc-lab-super/`; the two share a name but never a runtime dependency. As of 2026-07-05, the external repo exists as a README-only scaffold with private origin [CrashCartCapital/ccc-lab-super](https://github.com/CrashCartCapital/ccc-lab-super), not as an implemented data layer.
- `REQ-CFG-02`: The repo MUST include repo-local `AGENTS.md` and `CLAUDE.md` before implementation proceeds beyond scaffolding.
- `REQ-CFG-04`: The repo MUST expose canonical commands through `task` and document them in `README.md`. `task` means **go-task** (`github.com/go-task/task` / taskfile.dev), resolved and pinned under `REQ-AUTH-01`; no other task runner satisfies `REQ-CFG-04`.
- `REQ-CFG-07`: The repo MUST mandate `uv` for environment/lockfile management and pin a minimum Python version recorded in `docs/version-pins.md`.
- `REQ-CFG-09`: Dependency metadata MUST separate runtime dependencies from development/test dependencies (for example a `dev`/`test` dependency group in `pyproject.toml`), and every adopted external dependency — runtime or dev/test — MUST have its resolved version recorded in `docs/version-pins.md` per `REQ-AUTH-DEP-01`. `vcrpy`, `hypothesis`, `pytest-regressions`/`syrupy`, and `datacontract-cli` MUST be dev/test-only and MUST NOT appear in the runtime dependency set or be imported by any runtime adapter.
- `REQ-CFG-10`: The runtime MUST refuse to start on a free-threaded (GIL-disabled) Python build, MUST enforce the Python 3.13 floor, and MUST pin the experimental JIT off (`PYTHON_JIT=0`). The fail-closed guard lives at the top of `src/qdb_config/__init__.py`, the lowest always-imported module, so library imports fire it too — not only CLI start (FBL2-24).

## Non-Goal Guardrail Requirements

- `REQ-GUARD-01`: The existing non-goals MUST be enforced as guardrail tests that run in two explicit modes. (1) Dependency mode scans ONLY dependency metadata (`pyproject.toml`, `uv.lock`) and fails if any forbidden package is declared or locked: `clickhouse-*`, `pyspark`, `kafka-*`/`confluent-kafka`, `kubernetes`, `apache-airflow`, `prefect`, `dagster`. The dependency-mode forbidden set ALSO includes the parked/rejected platform packages — `great-expectations`, `openlineage-*`, `dlt`, and broad trading/backtesting platforms (for example `openbb`, `nautilus_trader`, `freqtrade`, `zipline-reloaded`, `backtesting`, `quantstats`) — which MUST NOT be declared or locked in the first release unless a future PRD section explicitly promotes a specific package out of the External Dependency Candidates park/reject tier; candidate-tier libraries that are merely "use custom instead" (for example `transitions`, `dirhash`, `fredapi`/`pyfredapi`, `pytest-recording`) are not platform-forbidden but MUST NOT be declared while their role stays custom-owned. (2) Surface mode scans ONLY executable/config roots — `src/`, `dags/`, `schemas/`, `contracts/`, `Taskfile.yml`, `qdb_project.yaml` — for forbidden service names, namespaces, DAG/benchmark classes, a generic `run_readonly_sql`/SQL escape hatch, and `continue_on` on a critical mutation step. Both modes EXCLUDE documentation and reference material (`docs/`, `**/*.md`, this PRD, `examples/`, `tests/fixtures/`) and an explicit `tests/guardrails/allowlist.yaml` (for example the non-goals prose and the ClickHouse-absence test itself); a forbidden token appearing only in an excluded or allowlisted path is NOT a failure. The guardrail MUST emit the exact glob set it scanned and the allowlisted paths it skipped, and a narrowed scan that cannot enumerate its skip set fails closed. These extend the existing ClickHouse-absence guard (`REQ-BENCH-04`) to the full non-goal set.
- `REQ-GUARD-02`: `task guard:vendored-schema` maintains the Dagu-generated-schema allowlist (`tests/guardrails/allowlist-vendored-schema.yaml`) so vendor action examples such as `k8s.run`, `s3.*`, or other non-goal tokens appearing only in pinned/generated Dagu schema files do not fail the project-surface guard. The allowlist is path- and hash-bound; a forbidden token in project-authored DAGs, Taskfile commands, source code, contracts, or config remains a failure. Backed by `verify:qdbctl-grammar` and `guard:vendored-schema`.

### Structural Hygiene Guardrails (`REQ-GUARD-03..09`, v7.2.3)

Seven repo-hygiene gates extend the guardrail family. Shared rule `REQ-GUARD-META-01`: every hygiene gate emits the exact path/glob set it scanned and the allowlist entries it skipped, and fails closed if it cannot enumerate either — the same posture as `REQ-GUARD-01`. Exemptions live in explicit allowlist files under `tests/guardrails/`, never in code.

| Gate | Fails when | Exemption | Test |
|---|---|---|---|
| `REQ-GUARD-03` nested git | any `.git` directory exists below the repo root | `allowlist-nested-git.yaml` | `test_guard_rejects_nested_git_directories_outside_allowlist` |
| `REQ-GUARD-04` junk path segments | any scanned path segment matches the junk family `MagicMock\|Mock id=\|<Mock\|\$\{[A-Z_]+:?-?` (mock reprs, unexpanded shell variables) | `allowlist.yaml` `path_segment_patterns` section | `test_guard_rejects_mock_repr_and_unexpanded_shell_variable_path_segments` |
| `REQ-GUARD-05` undeclared root entries | a top-level repo entry is absent from `docs/repo-root-manifest.yaml` | edit the manifest itself (review-visible, never silent) | `test_guard_repo_root_entries_all_declared_in_manifest` |
| `REQ-GUARD-06` duplicate concept | two or more live modules claim one named concept without exactly one `# CANONICAL: <concept>` marker | `allowlist-canonical.yaml` for deliberate ordered-candidate pairs | `test_guard_rejects_dual_concept_implementations_without_canonical_marker` |
| `REQ-GUARD-07` dead doc paths | a repo-doc-referenced path does not resolve on disk | `<!-- future-path -->` marker on the referencing line | `test_guard_doc_referenced_paths_resolve_on_disk` |
| `REQ-GUARD-08` unreachable primitives | a `# PIT-PRIMITIVE` or `# LINEAGE-PRIMITIVE` tagged function has no call-graph path from a production entrypoint (CLI command or Dagu-invoked script) | `allowlist-primitives.yaml`, each entry citing the REQ that reserves the primitive for a later phase | `test_guard_pit_lineage_primitives_reachable_from_production_write_path` |
| `REQ-GUARD-09` orphan schema files | a file under `schemas/` or a migration directory has zero inbound code references and no `archived: true` marker | the marker itself is the exemption | `test_guard_unreferenced_schema_or_migration_files_carry_archive_marker` |

Table: v7.2.3 hygiene gates. Rationale: each encodes a verified failure from the archive-frozen predecessor or a sibling repo — unremoved mock-repr directories, a literal unexpanded `${VAR:-` directory created by a shell-default path string, orphaned star-schema DDL with zero references, a lineage primitive unreachable from the primary write path, and five parallel SDK surfaces for one API. `REQ-GUARD-08` is the enforcement tool `REQ-LIN-07` (in [[PRJ-AI-CCC-DuckLake-v7.2.3-Manifests-Lineage-And-Fixtures]]) reuses for the lineage id-chain.

## External Dependency Candidates

This PRD includes a screened external-dependency candidate layer whose point is to delete commodity plumbing with mature open source without ever outsourcing project-specific authority. Every library named here is a candidate role, not a final pin.

> [!important] Candidate roles, not pins
> Every dependency named in this section is a candidate role with a proof gate, not a final package pin. Exact packages and versions are resolved later under `REQ-AUTH-01` and `REQ-AUTH-DEP-01` using official docs, package metadata, and live compatibility probes, then pinned with distribution hashes in `pyproject.toml`/`uv.lock` and summarized in `docs/version-pins.md` with a short why-this-pin note. Complete command transcripts are advisory for ordinary package pins and required only when the dependency record is safety-bearing. Any version strings in this section are screening evidence, not implementation pins.

### v7.2.3 Screening Notes (extend, never duplicate, the candidate roster)

- Atomic Agents (`atomic-agents`, PyPI 2.8.1 released 2026-06-09, MIT, v2 typed-agent API current): stack-selected 2026-06-30 with NO local install proof anywhere as of 2026-07-05. Candidate role: swappable committee-checkpoint runner behind `checkpoint_record.v1` ([[PRJ-AI-CCC-DuckLake-v7.2.3-Committee-Gates-And-HITL]]), never a hard dependency of any module. Proof gate before any import: resolve the canonical upstream org (PyPI links diverged between BrainBlend-AI and eigenwise at screening time), `uv add "atomic-agents>=2.8,<3.0"`, then an import/version probe transcript recorded under `docs/runtime-verification/`. Until that gate passes, zero `import atomic_agents` anywhere in the repo.
- Dagu: installed 2.7.16; upstream 2.10.0 at screening time under a repo-org move (`dagucloud/dagu`) with conflicting MIT-versus-GPLv3 license signals across official surfaces. Any upgrade is gated on verifying the current license and changelog first, and this PRD MUST NOT require any DAG feature newer than the installed version. Dagu remains a static outer graph; it never authors N runtime-unique nodes.
- Canonical JSON (RFC 8785): the `rfc8785` package (trailofbits; pure-Python, zero-dependency) is the screening-preferred implementation for the MR1 hashing profile; its last release predates screening by ~21 months, so the pin-time check MUST include an open-issue scan. Floor `>=0.1,<1.0`.
- `ty` (Astral type checker): beta `0.0.x` by its own README, which states breaking changes may occur between any two versions. It MAY run as a warn-not-fail advisory step only, never a named blocking gate — a named gate that cannot fail the build is exactly the decorative-gate failure `REQ-GUARD-01` exists to prevent.

### Dependency Authority Boundary

- `REQ-AUTH-DEP-01`: External dependency choices in the External Dependency Candidates layer are verification items resolved with the same ordered-candidate discipline as `REQ-AUTH-01`, but ordinary package evidence is deliberately lighter: the implementing agent tries the named ordered candidate list, picks the first candidate that passes its Dependency Proof Gate as of the implementation date, pins the exact package version and distribution hash in `pyproject.toml`/`uv.lock`, records it in `docs/version-pins.md` with a short why-this-pin note, and treats the full command-transcript/runtime-verification record as advisory unless the dependency resolution is itself safety-bearing. Complete runtime-verification records remain required for safety-bearing facts such as vendor/source timing, source-availability policies, DuckLake API signatures, and the Dagu binary. No dependency may be pinned, adopted, or live-enabled from this PRD's prose, from a screening-report version string, or from an open-ended latest stable; every survivor MUST be wrapped behind a CCC-owned interface and pass its named keep/kill proof before it deletes any custom code. A candidate that fails its gate stays unused and the PRD's named fallback or custom path is used instead.

External libraries may delete plumbing but may NOT become the authority for raw evidence, source availability, PIT semantics, contract semantics, publish state, locks, idempotency, manifests, backups, restore proof, or `qdb` visibility. Any candidate dependency used in Phase 0/1 MUST be wrapped behind a CCC-owned interface, pinned by live evidence in `pyproject.toml`/`uv.lock` plus `docs/version-pins.md`, and covered by complete runtime-verification artifacts only when its resolved fact is safety-bearing; otherwise the full transcript is advisory. If a dependency cannot be reduced to a local, deterministic, library-level role with no daemon, server, cloud account, hidden state store, telemetry dependency, or platform semantics, it is rejected for the fixture-complete core.

This dependency layer is non-blocking for the fixture-complete-core green gate. The first release still ships entirely on fixtures, and adopting any specific candidate only deletes custom plumbing; it is never required to reach the Definition of Done. A candidate that fails its proof gate is simply not adopted, and the named fallback or custom path is used instead.

### Dependency License Posture

Ryan operates this stack as personal-use only: non-commercial, hobbyist, local, non-sharing, non-mutating of upstream, and non-redistributing. Under that posture, licensing is not a primary design blocker for tool or package adoption in this project: if Ryan can access and use a package, tool, or source locally, it is generally fair game for this personal workflow, and labels such as GPL, LGPL, AGPL, Commons Clause, or Other never create a blanket implementation blocker by themselves. License, source, and entitlement facts are still recorded as operational context wherever they change practical behavior: whether data can be retained after a subscription ends, whether raw data must be deleted on termination, whether redistribution or display to others is prohibited, whether a package is better used as an external tool than as vendored code, and whether an access method depends on a paid account, current terms, or Ryan-supplied credentials. Plain rule: license facts are context, not a default stop sign. This is an operating posture for a personal local system, not legal advice; the human-decision boundary stays with `IR-5` in [[PRJ-AI-CCC-DuckLake-v7.2.3-Committee-Gates-And-HITL]].

> [!important] Phase 0 dependency whitelist and no-IFACE-stub rule (`CL3`)
> `task verify:phase0` may install and exercise only the adopted fixture-core dependencies explicitly required by this PRD: Python/uv/Task/Ruff/Pyright/pytest/Typer/Pydantic (including `pydantic-settings`)/Psycopg/Testcontainers/DuckDB/Polars/PyArrow/jsonschema, the adopted dev-test helpers wired to Phase 0 tests, the selected canonical JSON authority used for manifest and commit-fingerprint hashing, and `dataframely` only after its Dependency Proof Gate passes and a version/hash pin exists under `REQ-AUTH-DEP-01`. Until that proof passes, `dataframely` may run only under `task verify:deps:candidates`; if it fails, Pandera is the named fallback path under `REQ-CONTRACT-05`. Candidate spikes such as `massive`, `datacontract-cli`, `edgartools`, market-calendar libraries, retrieval packages, IFACE helpers, any provider SDK beyond fixture replay, and any dataframe validator before its proof gate passes run only under `task verify:deps:candidates` or their later source/phase gate, never under `task verify:phase0`. Phase 0 and Phase 0.5 MUST NOT create importable `qdb` stubs for future `REQ-IFACE-*` modeling calls; those calls remain gated/`xfail` tests with no implementation module until their phase. Backed by `test_phase0_has_no_iface_stubs`, `test_phase0_dependency_whitelist_allows_dataframely_only_after_proof`, and the rule that `verify:deps:candidates` is explicitly excluded from `verify:phase0`.

### Candidate Roster

| Candidate | Disposition | PRD role |
|---|---|---|
| `vcrpy` | Adopt as dev/test dependency | HTTP cassette replay for provider fixtures. |
| `hypothesis` | Adopt as dev/test dependency | PIT/source-clock property tests. |
| `pytest-regressions` | First-ordered snapshot candidate (FBL2-23c) | Golden runtime-verification and artifact regression checks; tried before `syrupy`. |
| `dataframely` | Primary schema-validator candidate | Polars-native staged dataframe validation. |
| `jsonschema` | Adopt core library | JSON/YAML artifact and schema validation. |
| RFC 8785 canonicalizer (`rfc8785` first; `jcs` only if current metadata and Python 3.13 import/vector proof pass; or CCC-owned implementation) | Proof-gated authority | Canonical JSON bytes for manifest and commit-fingerprint hashing. |
| `python-statemachine>=3.2.0` | Spike-to-adopt | In-process legal batch transition oracle only; no untrusted SCXML or external statecharts. |
| `edgartools` | Strong SEC helper, not authority | SEC/XBRL parsing after raw capture. |
| `massive` | Spike only | Massive/Polygon SDK capability probe and helper. |
| `exchange_calendars` first; `pandas_market_calendars` fallback | Spike-to-adopt | Ordered market-calendar candidates for `trading_calendar_bt`; selected output must be snapshotted/versioned and wrapped by CCC bitemporal policy before it becomes historical authority. |
| `datacontract-cli` | Bounded spike only | Optional local DuckDB/Parquet contract runner. |
| `syrupy` | Second-ordered snapshot fallback | Used only if `pytest-regressions` fails its binary rubric (FBL2-23c). |
| Hamilton | Defer | Future `register_derived` helper. |
| `dlt` | Park/reject first wave | Too much pipeline/schema-state gravity. |
| `frictionless` | Park | Broad framework, no Phase 0 need. |
| `pytest-recording` | Reject for now | Redundant wrapper over `vcrpy`. |
| FRED/ALFRED clients | Custom thin client | Existing libs do not clear gates. |
| OCC/OPRA packages | Custom | Authority-grade options identity/timing remains CCC-owned. |
| Advisory-lock wrappers | Custom | Direct DB lock code preferred. |
| Directory hash packages | Custom stdlib hashing | Use `hashlib` plus manifest hash semantics. |
| `transitions` | Reject | `python-statemachine` is the fresher candidate. |

Table: External dependency candidates, dispositions, and intended roles. Dispositions are screening calls; exact pins resolve under `REQ-AUTH-01` and `REQ-AUTH-DEP-01`. Every adopted, spike, and bounded-spike candidate MUST prove a working Python 3.13 / Apple-Silicon install and import before adoption.

### What Remains Custom And Authoritative

- FRED/ALFRED vintage handling: `realtime_start`/`realtime_end`, conservative date-only release policy, and vintage tests stay a custom thin official-API client; existing libraries do not clear the maturity/freshness gate.
- OCC/OPRA option symbology, `Decimal` strike identity, deliverables, and separate quote/open-interest timing clocks stay custom.
- PostgreSQL advisory locks and transaction coordination use direct `psycopg`/`asyncpg` lock code, never a lock-wrapper package.
- File inventory and hash semantics use `hashlib` plus manifest-specific `hash_status`, never a directory-hash package.
- The four-clock PIT rules and half-open interval logic stay CCC-owned.
- The typed `qdb` semantic boundary, refusal behavior, and SQL-zero posture stay CCC-owned.
- The publish/control kernel remains the system of record for batch state, locks, idempotency, manifests, and visibility.
- Provider capability artifacts and source-availability policies remain the live-enable evidence gate.

### Dependency Proof Gates

| Survivor | Minimal keep/kill proof |
|---|---|
| `vcrpy` | Replay one SEC and one FRED/Massive fixture with outbound sockets denied except explicitly declared Testcontainers/Docker needs; assert live-source flags are false; prove fake-secret redaction fails if a cassette contains the fake token; tie cassette output hashes to runtime-verification records. |
| `hypothesis` | Generate a PIT/source-clock failure such as violating `source_available_at <= known_at` and shrink it to a readable counterexample under a named CI profile with bounded max examples, deadline, deterministic seed/repro policy, and no unbounded slow property tests. |
| `pytest-regressions` / `syrupy` | Pick exactly one snapshot stack by a binary rubric: deterministic serializer passes; scrubbed runtime fields are excluded only by a named allowlist; mutating one stable field produces a focused readable diff; update command is documented; broad scrubbing that hides a real field change fails; chosen output ties to a runtime-verification record. |
| `dataframely` | Deterministic waterfall: validate one staged Polars schema such as `equity_bar_1d` while a separate DuckDB SQL check still catches a deliberately overlapping bitemporal PIT interval the row-wise schema cannot express; pivot to Pandera only on RED-test or arm64/ABI failure. |
| `jsonschema` | Validate `runtime_verification.schema.json`, one event schema such as `run_event.schema.json`, and one Dagu action-wrapper schema from Python code. |
| RFC 8785 canonicalizer | Select exactly one authority before manifest seal: `rfc8785` first, `jcs` only if current package metadata plus Python 3.13 import/vector proof pass, or a CCC-owned implementation. It MUST produce RFC 8785/JCS bytes for manifest and `commit_fingerprint` vectors, reject duplicate keys and `NaN`/`Infinity`, preserve Unicode/key-order behavior, enforce the project's decimal/string policy, and record the selected authority in `docs/runtime-verification/canonical_json.json`; ad hoc `json.dumps(sort_keys=True)` fails if it misses any vector. |
| `python-statemachine` | Reject an illegal direct `planned -> published` transition before any DB mutation and prove the oracle performs no DB writes, owns no persistence, and cannot become a mutable state authority; durable state persists only through the Postgres kernel transaction path. |
| `edgartools` | Parse from a persisted raw SEC artifact, not a live fetch, and preserve raw hash, accession, accepted/public-availability policy, and parser version in lineage. |
| `massive` | The package name `massive` is `UNVERIFIED` (`BT5`): a PyPI metadata probe MUST confirm the exact importable package name and record it in `docs/runtime-verification/dependencies/massive.json` BEFORE it enters `pyproject.toml`; it stays a disabled capability-probe spike. The probe also screens active non-withdrawn advisories, pins exact version and hash, confirms the source repository, then proves raw JSON/header capture, endpoint identity, timestamp-unit handling, and source-availability policy in a no-write capability probe before live enablement. |
| `datacontract-cli` | Run one ODCS YAML against one local DuckDB/Parquet fixture with no service/cloud/platform behavior, parseable failure output, and no permanent state mutation. |

Table: Minimal keep/kill proof each candidate must pass before it deletes custom code or enables a live adapter.

## Data Universe And Source Constraints

Appendix A contains the source-universe planning assumptions so the PRD can stand alone; that appendix remains planning input, while the `REQ-*` sections own implementation behavior. The planning assumption is roughly 7.4 TB expected data against a 56 TB NAS storage target, with substantial options and futures history and no tick-level/HFT requirement. Those numbers are pre-scale planning assumptions, not Phase 0 complexity drivers; they must be revalidated before large ingestion and must include raw-archive duplication, manifests, compaction leftovers, validation artifacts, benchmarks, backups, copied-root restore file sets, and snapshot retention, not only final Parquet table size.

> [!important] Source-hierarchy supersession
> Appendix A is planning input, not executable adapter authority. Where planning assumptions conflict with this PRD on raw retention, point-in-time semantics, source-availability policy, provider-capability evidence, or adapter enablement, the `REQ-*` sections govern. Raw/bronze/silver observations are never filtered for premium, liquidity, moneyness, vendor convenience, or cost, and any such filtering happens only in derived gold marts with lineage to retained source observations. A coding agent must not encode stale planning assumptions as fixtures.

| Data lane | Primary sources | Coverage shape | PRD implication |
|---|---|---|---|
| US equities and ETFs | Sharadar foundation; Norgate optional and export-gated; Massive flat files as forward feed | Daily and minute aggregates, survivorship-aware history; Massive raw flat files are compressed CSV and channel/format must be proven before live adapter enablement | Core MVP proves bar layout, symbol identity, raw/adjusted separation, provider-channel availability policy, raw CSV evidence archive, and timestamp cross-section benchmarks. |
| US equity and ETF options | HistoricalOptionData plus Cboe Option EOD Summary foundation; Massive OPRA as forward feed; DiscountOptionData unverified equity-breadth supplement | EOD coverage is planning assumption until symbol-list/sample-file evidence exists; index coverage must not be assumed present or absent before proof | Companion sample only in the first release; full reconciliation deferred; raw/bronze/silver retain every observation, with filters only in derived marts. |
| Index options | HistoricalOptionData SPX-family EOD plus Cboe cross-check; Massive OPRA forward | EOD index history reaches 1990 for the SPX family; intraday index history still starts around 2019 | Queries must expose coverage caveats and never treat missing history as negative evidence. |
| Futures and commodities | Kibot plus CME settlement cross-check; Norgate optional; yfinance prototype-only | Deep daily futures history with reproducible rolls | Keep schema extensible; do not let futures block the first DuckLake/PIT proof. |
| Macro | FRED/ALFRED, Kenneth French, BIS/OECD | Daily/weekly/monthly series with vintages or release timing | FRED/ALFRED proves vintage/as-of semantics early; macro revisions are a clean PIT test surface. |
| SEC fundamentals and filings | SEC EDGAR submissions, companyfacts, XBRL, 13F, Form 4 | Free official source with availability timestamps and fair-access rules | SEC is the canonical early knowledge-time source; fiscal period alone is not tradable knowledge. |
| News and analyst signals | Finnhub or later paid/alternate feeds | Deferred until structured foundation is stable | Retrieval and news ingestion must not block Phase 1. |

Table: Data-universe summary for implementation review. Known limitations must stay visible: no tick/quote-level HFT mandate, no cost-to-borrow feed in the current free/budget source set, limited pre-2019 intraday index-options history, DiscountOptionData index coverage unverified until symbol-list/sample-file proof exists, analyst estimates not guaranteed without paid data, vendor corrections likely over time, options quote/OI timing an investigation item, and options source overlap requiring explicit reconciliation.

## Hardware And Deployment Assumptions

This is a local multi-machine environment with durable data on NAS and compute on Macs: one operator running local hardware over the home LAN. No cloud, no Kubernetes, no distributed cluster, no always-on streaming, and no enterprise operations layer enters this design. Exact hostnames, mounts, network mode, SSD sizes, and live throughput must still be reverified during implementation — role posture below (allowed/forbidden services, worker classes) is binding, while live values require probes.

### Host Role Matrix

| Physical host | Role | Allowed services | Forbidden services | Worker class | Storage roots | Scratch roots | Verification | Failure mode |
|---|---|---|---|---|---|---|---|---|
| M5 Max MacBook Pro, 64 GB | Primary development machine + lake-heavy worker | Interactive dev and notebooks, heavy local backfills and transforms, benchmarks, full `qdbctl` surface | Always-on control services (PostgreSQL catalog authority, Dagu scheduler ownership) | `lake_heavy_worker` | Writes durable outputs only to NAS lake roots over the LAN | Local NVMe scratch, staging, spill, hot caches | `task verify:toolchain`; storage probe run from this host | If asleep or absent, heavy jobs wait; the control plane is unaffected |
| M4 Mac mini, 16 GB | Always-on headless control node | PostgreSQL DuckLake catalog, Dagu scheduler/control plane, catalog backup jobs, monitoring/runbooks, light maintenance | Heavy backfills, bulk transforms, benchmarks, and execution of `stage`/`validate`/`commit` payloads | `control_worker` | PostgreSQL data directory plus catalog backup staging | Control-node scratch limited to catalog/Dagu state | `task ops:postgres:doctor`, `task smoke:dagu` | 16 GB ceiling — overload degrades the control plane; `heavy_lake_job_allowed: false` protects it mechanically |
| M2 Max MacBook Pro, 64 GB | Headless compute/inference node | Bounded, explicitly assigned offloaded compute after topology/storage proof; local embedding/reranking when retrieval is enabled | Catalog mutation, publish promotion, default heavy-lake-job routing, any early-lake-correctness dependency | `headless_compute_worker` (bounded offload); `retrieval_inference_worker` (retrieval lane) | None durable; touches NAS only for explicitly assigned jobs | Local NVMe scratch for assigned jobs | Topology and load check before any assignment | Its absence never blocks early lake correctness |
| UGREEN DXP4800 Plus NAS, ~56 TB workable | Durable storage only | SMB/NFS shares for raw archives, DuckLake Parquet, manifests, artifacts, backups, restore copies, logs | Any compute, adapters, schedulers, or containers doing lake work | none | Lake, artifact, backup, and restore-copy roots | Never a scratch root | Storage probe: mount semantics, atomic rename, listing latency, free space, route class | If unreachable, publish/backup refuse loudly; no silent local fallback |

Table: Host Role Matrix — binding role posture for the four physical hosts.

> [!important] Placement rules that fall out of the matrix
>
> - Heavy lake jobs (`stage`/`validate`/`commit` payloads, backfills, compaction, benchmarks) default to the M5 `lake_heavy_worker` and MUST refuse to schedule on any host where `heavy_lake_job_allowed: false` — see `REQ-DAGU-05`/`REQ-DAGU-05b` in [[PRJ-AI-CCC-DuckLake-v7.2.3-Orchestration-And-QDBCTL]].
> - The Mac mini dispatches work; it never executes heavy payloads. Running `stage`/`validate` in-process on the control node is a guardrail failure, not an acceptable single-host simplification.
> - The M2 node is optional bounded offload only. It must never become a hidden dependency for early lake correctness — neither through retrieval coupling nor through Dagu "compute node" routing.
> - "Compute nodes" for local NVMe scratch means the M5 and M2 only; the mini's local disk holds control-plane state and is excluded from staging/spill duty for heavy jobs.
> - Heavy data movement (bulk Parquet writes, backfills, restores, backups) defaults to the direct local LAN path. Tailscale is reachability, not assumed TB-scale transport: until a probe proves a direct peer-to-peer path at the required throughput, a relayed Tailscale path may carry control traffic (Dagu triggers, catalog DSN) but never bulk transport.

> [!important] Pre-live topology and local-ops contract (`OP1`, `OP4`)
> The repo seeds `ops/topology.example.yaml` as a template, not live proof. It declares host roles, route class, service ownership, worker eligibility, scratch roots, and a `lake_roots` map with `canonical`, `artifact`, `backup`, `restore_copy`, and `local_scratch`, plus `verify_before_prelive` placeholders for mount options, permissions, route, free space, atomic rename, read-after-close, listing latency, and restore-copy behavior. Phase 0 ignores this file except to prove it parses; `task verify:prelive` and `task smoke:nas` are the gates that turn it into local truth.

## Glossary

| Term | Meaning |
|---|---|
| CCC | Ryan's personal quantitative trading/research domain and stack. |
| DuckDB | Embedded analytical SQL engine used by local clients for querying and transforms. |
| DuckLake | Lakehouse/catalog format used with DuckDB clients to manage Parquet files, snapshots, schema evolution, and transactions. |
| PostgreSQL catalog | Small metadata database used by DuckLake for multi-client coordination; not the market-data warehouse. |
| Parquet | Columnar file format for durable market/fundamental data files. |
| DuckLake snapshot | A committed version of DuckLake metadata and data files; storage time travel only, not financial PIT. |
| Financial point-in-time | Guarantee that a research query only sees facts available at the query's `known_at` time. |
| `known_at` | The time at which the simulated trader/system may know a fact. Missing `known_at` fails closed for PIT data. |
| `valid_at` / valid time | Market/business time when a fact was true or applied. |
| `source_available_at` | When a trader could first have known the fact from the source. The only clock `known_at` may bind to. |
| `ingested_at` | When the local system acquired the fact. |
| `lake_published_at` | When the fact passed validation and became queryable in this lake. Operational only, never financial `known_at`. |
| Bitemporal | Modeling both business/valid time and source/knowledge time, with half-open UTC intervals. |
| Raw/Bronze/Silver/Gold | Raw immutable source archive, normalized source layer, canonical typed facts, query-ready derived marts. |
| Publish/control kernel | Small executable ledger that defines what is staged, validated, committed, manifested, backed up, restored/proven, and visible to `qdb`. |
| Provider capability artifact | Versioned proof pack required before any live adapter: provider/channel, raw format, compression, sample hash, schema fingerprint, entitlement/coverage evidence, source-availability policy, parser version, timestamp-unit detection, and verification date. |
| Source-availability policy | Machine-readable rule for when source observations become knowable; unverified timing stays disabled or fixture-only rather than a hard fixture. |
| `qdb` | Custom SDK/tool layer exposing safe typed quant-data functions to notebooks and agents. |
| `QdbLineage v1` | Versioned lineage schema returned by every `qdb` result, binding manifest, snapshot, source policies, filters, `known_at`, caveats, row counts, and redaction-safe metadata. |
| Dagu | Lightweight workflow orchestrator that runs deterministic local jobs and calls the kernel; it is not the system of record. |
| Options EOD | End-of-day options chain data; a small companion sample in the first release, not a full vendor-reconciliation platform. |
| `REQ-IFACE-*` modeling interface | The later-phase panel/fill/coverage/session family for Ryan's separate planned modeling/backtesting engine. Core typed `qdb` reads are the current Phase 0/1 access boundary; `register_derived` and `trading_calendar_bt` open in Phase 1; the `REQ-IFACE-*` family opens in Phase 1.5, with no new service, daemon, or platform. |
| Panel (`get_panel_asof`) | A vectorized `security_id x decision_time x known_at` grid where every cell satisfies `source_available_at <= row.known_at`; the platform builds it, the engine defines features over it. |
| `trading_calendar_bt` | Bitemporal exchange sessions/holidays/half-days served as a dataset; binds resample/fill so history never uses a current calendar. |
| `register_derived` | Kernel path that mints a contract, lineage, `known_at`, manifest, and snapshot for an engine-produced derived artifact, so derived data has the same custody as source data. |
| Research session pin | An immutable `open_session(as_of_manifests=...)` snapshot set, recorded in lineage as `session_pin_id`, so a research run is reproducible. |
| `feature_set` / `label_set` / `signal_score` | Physically separated derived families: features at `entity x known_at`, training labels, and model scores; training joins are explicit. |

Table: Glossary for shared architecture terms. Module-local terms may be added in their owner notes, but this shared glossary carries the cross-module baseline.

## Why These Choices

The architecture is deliberately conservative in the durable layer and strict in the semantic layer. The first slice should be smaller and harder, not broader or more platform-heavy.

| Alternative | Stance | Reason |
|---|---|---|
| Shared NAS `quant.duckdb` | Rejected | DuckDB native file concurrency and shared/NAS file-lock caveats make it the wrong canonical store for multi-process writes. |
| Manifest-only Parquet lake | Rejected | Underbuilds cataloging, snapshots, schema evolution, file cleanup, and multi-client coordination. |
| ClickHouse canonical/hot store | Out of this PRD | May become a future benchmark-triggered hot mart; explicitly no ClickHouse work here. |
| Delta Lake or Iceberg | Deferred | Credible lake formats, but DuckLake is DuckDB-native and fits the selected query engine. DuckLake maturity remains a verification item. |
| MinIO/S3 first | Deferred | S3-compatible access is benchmarked only if NAS direct is inadequate or ambiguous after at least one layout attempt. |
| Qdrant first | Deferred | LanceDB is lighter for first local hybrid retrieval; Qdrant needs a failed eval or service-feature trigger. |
| Spark/Kafka/Kubernetes | Rejected for first release | The workload is local/batch-oriented, not distributed/streaming. |
| Broad REST API | Rejected for first release | A typed `qdb` SDK/tool layer gives safer notebook/agent access with less serialization and service burden. |
| Arbitrary agent SQL gateway | Deferred | Typed `qdb` functions and contract-generated PIT-safe views are safer and cheaper than a custom SQL firewall for a solo project. |

Table: Decision rationale for implementation review.

## External Capability Evidence And Verification Items

The capability docs below are evidence handles for tool behavior and constraints. They do not prove Ryan's NAS throughput, local SSD capacity, source subscription availability, data quality, query latency, current package versions, vendor timing rules, Dagu binary behavior, or exact local service topology. Every version, vendor, market-timing, package-fit, Dagu-syntax, and provider-coverage claim becomes a repo fact only after official-source or live-runtime verification in Phase 0 or the relevant adapter gate.

| Evidence | Use in this PRD | Link |
|---|---|---|
| DuckDB concurrency | Rejects shared mutable NAS `quant.duckdb`; supports DuckLake/PostgreSQL as the stable multi-client path | [DuckDB concurrency](https://duckdb.org/docs/current/connect/concurrency.html) |
| DuckLake catalog guidance | Confirms PostgreSQL catalog is the correct multi-client/remote catalog choice | [DuckLake catalog choice](https://ducklake.select/docs/stable/duckdb/usage/choosing_a_catalog_database.html) |
| DuckLake transactions/snapshots | ACID/snapshot substrate, separate from financial `known_at` | [DuckLake transactions](https://ducklake.select/docs/stable/duckdb/advanced_features/transactions) |
| DuckLake storage guidance | Keeps NAS direct default; permits S3-compatible benchmark only if needed | [DuckLake storage](https://ducklake.select/docs/stable/duckdb/usage/choosing_storage.html) |
| DuckLake maintenance/cleanup | Defines checkpoint/flush, expire snapshots, merge/rewrite, cleanup, and orphan deletion as gated jobs; cleanup is separate from snapshot expiry | [DuckLake cleanup](https://ducklake.select/docs/stable/duckdb/maintenance/cleanup_of_files.html) |
| DuckLake constraints/unsupported | Only `NOT NULL` is enforced; integrity must move into validation and `qdb` | [DuckLake unsupported features](https://ducklake.select/docs/stable/duckdb/unsupported_features) |
| DuckDB Parquet | Partitioning, sort order, row groups, filter/projection pushdown, statistics are first-class design concerns | [DuckDB Parquet](https://duckdb.org/docs/current/data/parquet/overview) |
| DuckDB profiling | Benchmarks must capture plans/profiles, not only wall-clock | [DuckDB profiling](https://duckdb.org/docs/stable/sql/statements/profiling.html) |
| Polars scan | Lazy scans, projection/predicate pushdown, Hive partition pruning with explicit schema-drift policy | [Polars `scan_parquet`](https://docs.pola.rs/api/python/stable/reference/api/polars.scan_parquet.html) |
| PyArrow Parquet | Low-level schema, row-group, compression, statistics controls to pin reproducible layout | [PyArrow `write_table`](https://arrow.apache.org/docs/python/generated/pyarrow.parquet.write_table.html) |
| Pandera | Fallback dataframe/schema validation surface if `dataframely` fails its proof gate | [Pandera Polars docs](https://pandera.readthedocs.io/en/latest/polars.html) |
| SQLGlot | AST/table-extraction gate for any SQL surface; not a complete safety boundary | [SQLGlot](https://sqlglot.com/sqlglot.html) |
| PostgreSQL dump tools | `pg_dump`/`pg_dumpall --globals-only` for catalog data plus roles/globals | [PostgreSQL `pg_dumpall`](https://www.postgresql.org/docs/current/app-pg-dumpall.html) |
| PostgreSQL continuous archiving | Full PITR mechanics; deliberately out of first release | [PostgreSQL continuous archiving](https://www.postgresql.org/docs/current/continuous-archiving.html) |
| Dagu YAML/actions/artifacts/secrets/distributed | Orchestration/control plane; Dagu is not the transaction manager; generated YAML grammar must be pinned, probed, and validated against the selected binary before any field shape is trusted | [Dagu YAML spec](https://docs.dagu.sh/writing-workflows/yaml-specification), [Dagu Actions](https://docs.dagu.sh/dagu-actions/), [Dagu artifacts](https://docs.dagu.sh/writing-workflows/artifacts), [Dagu secrets](https://docs.dagu.sh/writing-workflows/secrets), [Dagu distributed](https://docs.dagu.sh/server-admin/distributed/) |
| LanceDB search/eval | First-pass local hybrid retrieval with a labeled eval gate before corpus expansion | [LanceDB search](https://docs.lancedb.com/search) |
| SEC EDGAR APIs | Official structured source, bulk/API access, availability fields for knowledge time | [SEC EDGAR APIs](https://www.sec.gov/search-filings/edgar-application-programming-interfaces) |
| SEC developer resources | Compliant user-agent and fair-access throttling | [SEC developer resources](https://www.sec.gov/about/developer-resources) |
| FRED/ALFRED | Macro vintage semantics through real-time/vintage fields | [FRED API](https://fred.stlouisfed.org/docs/api/fred/fred/) and [ALFRED](https://fred.stlouisfed.org/docs/api/fred/alfred.html) |
| pytest-benchmark and hyperfine | Candidate benchmark runners for Python and CLI-level checks | [pytest-benchmark](https://pytest-benchmark.readthedocs.io/en/latest/) and [hyperfine](https://github.com/sharkdp/hyperfine) |

Table: Capability evidence used to convert the stack brief into implementation requirements.

> [!warning] Unverified external facts
> No external link or external claim in this section may become a version pin, fixture rule, source-timing rule, or production default until the implementation agent verifies it against official docs or live runtime evidence. Treat these as implementation-time verification items, not settled facts.

| External claim to verify | Why it matters | Verification posture |
|---|---|---|
| DuckDB/DuckLake extension current GA/LTS/wheel claims | Pins the canonical store's ACID/maintenance behavior and Python wheel | Verify current DuckDB, DuckLake extension, and DuckDB PostgreSQL extension compatibility together only after the two-client smoke passes. |
| DuckLake catalog reportedly requires PostgreSQL 12+ | Catalog provisioning | Confirm against current DuckLake catalog docs. |
| Polars + PyArrow + DuckDB + selected dataframe validator compatibility | Mismatched versions risk segfaults, import failures, or silent corruption | Verify selected engine/validator set as one runtime-tested compatibility group before pinning; `dataframely` is tried first and Pandera is fallback only under `REQ-CONTRACT-05`. |
| Polygon.io rebranded to Massive; flat-file raw format/channel/timing may drift | Adapter package/import names, endpoints, raw archive format, schema fingerprint, source-availability policy | Verify package names, channel, compression, CSV/header schema, timestamp units, and next-day availability before pinning; keep provider lineage aliases. |
| Norgate updater/export workflow and macOS ARM support | Whether Norgate runs directly or must be Windows VM/export-gated | Verify Windows VM/export path, adjustment/padding config, export hashes, and automation mode before enabling the adapter. |
| SEC fair-access rate | Avoid IP bans during ingestion | Confirm current SEC limit; keep ingestion single-threaded and throttled regardless of Dagu queues. |
| SEC after-hours dissemination | Trading-on-acceptance leakage vs public availability | Verify exact rule before encoding `publicly_disseminated_at`; treat as unverified until then. |
| FRED/ALFRED date-only vintages and intraday releases | Same-day macro backtests can leak unreleased data | Default to conservative date-only end-of-day availability unless exact release schedules are modeled and verified. |
| Options quote, open-interest, and session clocks | Joining later option observations to earlier equity bars leaks | Add a source-availability policy placeholder now; verify OCC/OPRA/vendor timing and session calendars before exact fixtures. |
| Dagu license terms for embedding/redistribution | Solo local-tool use vs redistribution | Confirm Dagu is used only as a local external tool with no license concern for intended use. |
| DiscountOptionData index-option coverage and symbol universe | Prevent stale planning assumptions from becoming code | Do not assume index coverage present or absent until current symbol list and sample-file hashes exist. |
| Dagu binary grammar vs local binary | YAML syntax and validation behavior can drift | Pin selected Dagu binary, record `dagu version`, probe schema support, and commit one validation-passing parent+child template before treating YAML shape as accepted. |
| `dlt` has a DuckLake destination | Could reduce ingestion boilerplate | Parked/rejected for first wave; revisit only as a kill-oriented review if isolated nested-JSON normalization becomes a measured bottleneck. |
| Python 3.13 toolchain + dependency install/import proof on Apple Silicon | Determines frozen toolchain and native-extension viability | Verify exact package names, versions, wheel tags, and import names before freezing. |

Table: External facts that must be verified, not assumed.

## Current Decisions

The locked choices below are a summary for navigation; the governing contract for each is its in-place `REQ-*` bullet plus any explicitly referenced artifact seed or listing. Where this table differs from governing content, the `REQ-*` bullet and referenced artifact seed govern.

| Decision | Locked choice | Notes |
|---|---|---|
| Implementation location | `/Users/ryanpappal/03_CODE/ccc-lab-super/` | External implementation code repo, not the vault project folder; README-only git scaffold exists with private GitHub origin; the vault is not a runtime dependency. |
| Handoff posture | Self-contained PRD first | The future repo must not require vault access or hidden context at runtime. |
| Environment and command surface | `uv` plus committed lockfile; `task` for canonical commands | Exact Python/package pins are verified in Phase 0 before lock. |
| Scratch defaults | Scratch-only roots, catalog, artifacts, backups, and Dagu state | Production-looking NAS paths, live catalog DSNs, live downloads, and destructive cleanup are refused without explicit live flags. |
| Canonical lake format | DuckLake over Parquet | Catalog, snapshots, transactions, schema evolution, multi-client coordination. |
| Catalog | PostgreSQL on always-on control node | Metadata and coordination only, not the 7+ TB warehouse. |
| Data files | NAS-backed Parquet | Local NVMe is scratch/staging/spill/cache/disposable marts. |
| Canonical write boundary | Only DuckLake/DuckDB publication writes canonical tables | Polars/PyArrow stage and validate only. |
| Publish visibility | Manifest-bound through the publish/control kernel | `qdb` reads only published manifests, never arbitrary latest snapshots. |
| Recovery target | Copied-root scratch restore to last completed published batch | Full PostgreSQL PITR and remapped-root restore are out of first release unless promoted. |
| Query/transform | DuckDB + Polars | DuckDB for SQL/lake access; Polars for lazy transforms/validation. |
| Orchestration | Dagu with v2.x safety/modularity profile | Runs deterministic CLI jobs; not the system of record; generated YAML must pass selected-binary validation and project lint. |
| Agent/notebook interface | Typed core `qdb` functions | SQL-zero in Phase 0/1; options APIs raise `DatasetNotPublishedError` from a present stub until Phase 1B. |
| Financial knowledge time | `source_available_at` or derived `known_from`/`known_to` | Never `lake_published_at`; no ambiguous `published_at` in PIT contracts. |
| First build slice | Phase 0 scratch correctness loop | Equities/SEC/FRED core MVP next; Options EOD is a small companion sample. |
| Options data | Raw/bronze/silver retained; filtering only in derived marts | Never irreversibly discard low-premium, illiquid, or out-of-moneyness observations from source layers. |
| Price adjustment | Raw and adjusted stored separately; explicit adjustment policy at query time | No silent overwrite of raw bars; PIT-adjusted vs ex-post-adjusted are labeled. |
| Retrieval | LanceDB-first, deferred behind a feature flag | Starts only after structured foundation is proven, with availability prefilter. |
| Storage transport | NAS direct first | S3-compatible benchmarked only if NAS direct fails or is ambiguous. |
| Data quality | Tiered validation plus manifests | Schema/dtype, materialized values, SQL integrity, PIT/source-clock, manifest/file, and `qdb` smoke tiers. |
| ClickHouse | Out of scope for this PRD | No tasks, tables, benchmarks, or namespaces; future escape criterion defined, no implementation. |
| Planning-appendix authority | Planning input only when it conflicts with implementation safety | PRD requirements govern raw retention, PIT, source availability, provider capability, and adapter enablement. |
| Restore mode | Copied-root scratch restore first | Remapped-root deferred until copied-root is green. |
| `qdb` SQL surface | SQL-zero in Phase 0/1 | No generic `run_readonly_sql`; restricted SQL only as a future named profile. |
| Options `qdb` | Present stub raising `DatasetNotPublishedError` until Phase 1B | Core typed calls do not depend on options. |
| Live source adapters | Disabled until provider-capability packs and sample evidence exist | Prose source tables are insufficient for live adapter enablement. |
| Test PostgreSQL | Testcontainers PostgreSQL 16 by default | Unit tests need no Docker; integration tests require Docker preflight or explicit `QDB_TEST_POSTGRES_DSN`; no silent localhost fallback. |
| Modeling-engine interface | Core typed `qdb` plus later typed interface calls on existing machinery | Core typed reads are the current access boundary; `register_derived` and `trading_calendar_bt` open in Phase 1; panel/fill/coverage/session calls open in Phase 1.5; no new service/DB/platform. |
| Trading calendar | Hybrid buy + build: `exchange_calendars` first, `pandas_market_calendars` fallback, snapshotted/versioned into CCC-owned `trading_calendar_bt` | Manual overrides only as explicit, versioned, bitemporal corrections with provenance; a package's current-calendar view is never historical truth by itself. |
| Package roots | Five intentional roots: `qdb`, `qdb_lake`, `qdb_contracts`, `qdb_kernel`, `qdb_config` | Functional packages layer on those roots; exact layout is a verification item. |
| Type checker | Pyright | Frozen lint/type choice for first release. |
| Modeling consumption format | Polars-first; Arrow RecordBatch / Polars LazyFrame for lazy/streaming reads | pandas is an explicit export/adapter surface only; DuckDB relations are an implementation detail, not the first external contract. |
| Source adapter drafts | Docs-derived disabled drafts allowed before purchase (`REQ-SRC-DRAFT`) | Mocked/disconnected only; `REQ-SRC-VERIFY` remains the live gate; no spend until Ryan buys or supplies evidence. |
| Cleanup posture | Archive-before-delete for proven-safe generated artifacts; physical deletion stays dry-run plus approval hash plus Ryan approval | Governing policy in [[PRJ-AI-CCC-DuckLake-v7.2.3-Ops-Recovery-Maintenance-Security]]. |
| Host placement | Host Role Matrix binds roles: M5 lake-heavy, M4 mini control-only, M2 bounded offload, NAS storage-only | Heavy lake jobs MUST refuse hosts with `heavy_lake_job_allowed: false`. |

Table: Locked first-release decisions.

## Architecture Overview

The architecture has four always-relevant layers plus a control kernel: durable data on NAS, PostgreSQL catalog coordination, local compute through DuckDB/Polars, and a semantic safety layer through the publish/control kernel, Dagu, and `qdb`. Retrieval is a later auxiliary index, not a canonical store.

| Layer | Owns | Boundary |
|---|---|---|
| Future repo surface | CLI, `qdb`, kernel, DAGs, tests, docs | Repo must run without the vault as runtime cwd. |
| Control plane | Dagu jobs, publish/control kernel, `qdb` typed boundary | Dagu orchestrates but does not own state; kernel owns visibility; `qdb` gates reads. |
| Compute plane | Polars transforms, DuckDB/DuckLake publication | Polars stages and validates; DuckDB publishes controlled data. |
| Durable plane | Raw archives, DuckLake Parquet tables, manifests, schemas, restore proof, catalog backups | NAS-backed data and artifacts remain durable; PostgreSQL catalog is metadata/coordination only. |
| Deferred auxiliaries | LanceDB retrieval, S3-compatible storage path, ClickHouse | Retrieval is feature-flagged later; S3 path is benchmark-gated only; ClickHouse is explicitly out of this PRD. |

Table: Target system topology in prose form. The source PRD diagram is intentionally represented as a table here so this module avoids comment-like diagram directives while preserving the same ownership boundaries.

## Phase Map

Phase 0 stays narrow and fixture-complete. Phase 0.5 closes remaining contract seams; core typed `qdb` reads remain the current access boundary; the trading calendar and `register_derived` land in Phase 1; the panel/fill/coverage/session interface lands in Phase 1.5.

| Phase | Scope | Authority note |
|---|---|---|
| Phase 0 | Scratch correctness loop and fixture-complete core | Proves coordination, kernel, `qdb`, Dagu, restore, validation tiers, diagnosis, ClickHouse absence, and adversarial PIT fixtures on scratch. |
| Phase 0.5 | Contract closure and decidability fixes | Adds autonomous-implementation scaffolding so two independent implementers cannot diverge at enums, API, lifecycle, grammar, or fact-resolution boundaries. |
| Phase 1 | Equities, SEC, FRED core | Proves high-volume layout and source-availability semantics without letting OPRA-scale options block the core contracts. |
| Phase 1 support | `register_derived` and `trading_calendar_bt` | Core-value support for future modeling coupling; detailed authority belongs to [[PRJ-AI-CCC-DuckLake-v7.2.3-Modeling-Engine-Interface]]. |
| Phase 1B | Options EOD companion sample | Parallel companion sample, not a second platform and not a Phase 1 blocker unless it exposes a shared contract defect. |
| Phase 1.5 | Panel, fill, coverage, session interface | Modeling interface lands after Phase 1; Phase 0 implements none of it. |
| Phase 2 | Retrieval deferred | Bounded SEC/news corpus, feature flag, availability prefilter, LanceDB, eval gate, and Qdrant only on failed threshold. |

Table: Phase map. Modeling-interface detail belongs to [[PRJ-AI-CCC-DuckLake-v7.2.3-Modeling-Engine-Interface]], and orchestration procedure detail belongs to [[PRJ-AI-CCC-DuckLake-v7.2.3-Orchestration-And-QDBCTL]].

## Phase 0 Proof Harness

Phase 0 creates the repo, configuration surface, test scaffolding, sample fixtures, scratch DuckLake/PostgreSQL smoke environment, kernel skeleton, and fake-source data to prove the architecture without touching real vendor history.

| Phase 0 deliverable | Required proof |
|---|---|
| Repo scaffold | `task verify` runs lint/type/test/smoke on scratch fixtures, with no vault-root dependency. |
| Config model + validation | `.env.example` and a config validator document and enforce scratch-only defaults and production-path refusal. |
| Scratch DuckLake/PostgreSQL | Temporary data path and Testcontainers PostgreSQL 16 scratch catalog prove attach/create/insert/select/snapshot with two coordinating clients; explicit DSN override allowed, silent localhost fallback is not. |
| Publish/control kernel skeleton | Phase 0 DDL, legal transition matrix, lock/idempotency uniqueness, crash-boundary tests, backup/publish ordering, and visibility tables exist with a failed-validation-not-visible test. |
| `qdb` skeleton | Core typed calls plus the present inert `get_option_chain_asof` boundary that raises `DatasetNotPublishedError` until Phase 1B; no generic SQL; missing/naive `known_at` rejection, versioned lineage, and `lake_published_at` not financial `known_at` tests exist before query breadth expands. |
| Dagu skeleton | Pinned Dagu binary records version, probes schema support, validates canonical parent+child templates plus publish-path child DAGs, uses `dotenv: []`, artifacts for large reports, no success-masking on critical steps, and kernel CLI commands. |
| Restore skeleton | Copied-root scratch backup/restore proof recovers catalog, manifest-derived file inventory, file sizes/hashes where feasible, cleanup protection, and a known PIT query against a fresh scratch catalog/root. |
| Adversarial PIT fixtures | One equity fixture and one SEC/FRED fixture encode backfill-amnesia and source-availability traps. |
| ClickHouse absence guard | Automated check proves no ClickHouse dependency, service, task, DAG, benchmark class, or namespace exists in the first-release surface. |
| Validation tiers | Schema/dtype, materialized value, DuckDB SQL integrity, PIT interval/source-clock, and manifest/file checks exist as RED tests before adapters. |
| Observability + diagnosis | Versioned JSON event schemas and a failed-run diagnosis artifact schema exist, with fake-secret redaction tests. |
| Gated modeling-interface leakage tests | `REQ-IFACE-*` leakage RED tests exist as gated/`xfail`; Phase 0 implements none of the interface. |

Table: Phase 0 establishes the correctness loop before any real data ingestion.

> [!warning] Stop gate before scale
> No real-scale ingestion, no options backfill, no retrieval, no live source adapter, and no non-scratch NAS write until the Phase 0 loop is green: two-client coordination, kernel transition/visibility tests, typed SQL-zero `qdb` PIT rejection, Dagu schema/lint-validated publish through a parent control DAG plus child DAGs, copied-root restore-with-files, validation tiers, and failed-run diagnosis artifacts all pass on scratch. Phase 0 developer tests run single-host on local NVMe/temp scratch only; `task verify:phase0` touches no NAS path. NAS smoke is opt-in via `task smoke:nas` and is never required to pass Phase 0.

## Phase 0.5 Contract Closure

Phase 0.5 is the decidability layer that makes this PRD buildable from the text alone. It adds no new business/data scope and no new services, but it is blocking verification scope for `task verify:phase0`: it sharpens existing Phase 0 artifacts and adds autonomous-implementation scaffolding so two independent implementers cannot diverge at an enum, API, lifecycle, grammar, or fact-resolution boundary.

| Phase 0.5 deliverable | Required proof |
|---|---|
| Autonomous Implementation Authority | `docs/runtime-verification/README.md`, `schemas/runtime_verification.schema.json`, and at least one resolved-fact record exist; CI rejects a resolved fact lacking authority, command, or `observed_output_hash`. |
| DuckLake API probe | `task verify:ducklake-api` runs the probe, resolves Phase 0 binding sentinels, records table-scoped/fallback inventory source, emits generated bindings, and records explicit deferrals for non-Phase-0 wrappers. |
| Manifest / lifecycle split | Immutable manifest excludes backup/restore/cleanup lifecycle; `restore_mode` and `file_inventory_mode` are distinct. |
| One CLI grammar | `qdbctl` is flag-only; `plan` mints and prints `batch_id`; publish-path mutations require `--batch-id`; `cleanup`/`migrate` do not; `diagnose` takes exactly one target flag. |
| Frozen toolchain + dtype map | `docs/version-pins.md` records the toolchain and `src/qdb_contracts/dtypes.py` maps neutral tokens to Polars dtypes. |
| Exact refusals + operator diagnose | `qdb` error substrings are asserted by tests; `qdbctl diagnose <one target flag> --format text\|json` renders `failed_run_diagnosis`. |
| `hash_status` + serialization retry | Every file records `hash_status`/`hash_reason`; kernel transitions retry serialization failures three times pre-side-effect only. |
| Enabled `synthfix` provider | `provider_capabilities/synthfix.yaml` plus source-availability policies are enabled and exercise the full kernel path. |
| Examples + index + guardrails | `examples/01_phase0_research_sanity.py`, `docs/implementation-index.md`, and non-goals-as-guardrail tests exist. |
| Quickstart + walkthrough | `README.md` quickstart and `task example:phase0` cover setup, publish, typed queries, lineage, refusal, diagnosis, and copied-root restore. |
| Gated interface leakage tests | `REQ-IFACE-*` leakage/absence RED tests exist as gated/`xfail`; Phase 0.5 implements none of the interface. |

Table: Phase 0.5 closes contract seams; none of it relaxes a Phase 0 gate.

> [!important] Canonical probe execution order before `manifest_seal`
> The three `verify:phase0`/`manifest_seal`-blocking probes run in this fixed order: (1) canonical-JSON authority selection and vector proof, (2) DuckLake maintenance bindings (`task verify:ducklake-api`), (3) commit-fingerprint discovery. All three block `manifest_seal`, and this PRD previously gave no order between them. The manifest and file-inventory MUST be built to stand alone — restore can enumerate and verify every file from the manifest plus `file_inventory` with no wrapper call — before the DuckLake wrapper probe is trusted, because the wrapper's failure pivot falls back to the manifest.

## Phase 1 Core MVP

Phase 1 builds the primary foundation: equities daily/minute plus minimal SEC/FRED PIT data. The purpose is to prove both high-volume market-data layout and source-availability knowledge-time semantics without letting OPRA-scale options block the core contracts.

| Phase 1 lane | Scope | Required proof |
|---|---|---|
| Equities market data | Representative daily/minute fixture, then one real source slice only after provider-capability approval | Raw archive, provider-channel/raw-format proof, Massive/Polygon CSV schema fingerprint and timestamp-unit check, normalized DuckLake table, raw/adjusted separation, symbol-history query, timestamp cross-section benchmark, and bar availability gated by `source_available_at`. |
| SEC minimal PIT | SEC submissions/companyfacts sample | Accession-level lineage with form, filed date, accepted/public-availability policy, source hash, and XBRL context; companyfacts without accession is non-PIT; availability gates `known_at`; future-availability filing excluded. |
| FRED/ALFRED minimal PIT | One or more revised macro series | Native dates preserved; closed/closed source vintages converted to half-open UTC policy; `realtime_start`/`realtime_end` preserved; historical as-of returns old vintage; conservative date-only release policy enforced unless exact release timestamps are verified. |
| `qdb` core | Bars, fundamentals, macro, universe, describe, explain | Read-only, SQL-zero, `known_at`-gated, adjustment-policy aware, bounded, lineage-returning typed functions over predeclared fixtures; options APIs raise `DatasetNotPublishedError` until Phase 1B. |
| Dagu publish | Source download/mock, normalize, validate, commit, manifest, backup, publish | Snapshot invisible until validation and manifest pass through the kernel. |

Table: Phase 1 primary path.

## Phase 1B Options EOD Companion Sample

Options EOD is a parallel companion sample, not a second platform. It codevelops with the core contracts and kernel but must not block Phase 1 unless it exposes a shared contract defect. Options matter to Ryan's strategy focus, but contract identity, source overlap, and normalization are hard enough that full backfill and reconciliation are deferred.

| Phase 1B lane | Scope | Required proof |
|---|---|---|
| Raw options retention | DiscountOptionData and Polygon/Massive sample paths when available | Raw, bronze, and silver observations immutable and retained even if derived marts filter by premium, liquidity, moneyness, or research convenience. |
| Contract identity | Underlying internal ID, root, expiration, right, strike, multiplier, exercise style, settlement, source IDs | Equivalent records from two sources map to the same canonical OCC-style key, including strike precision and multiplier. |
| Availability clocks | Separate `quote_available_at` and `open_interest_available_at`; contract-state `known_from`/`known_to`; exact timing unverified until OCC/OPRA/vendor evidence | Open interest is not knowable before its own availability; quote availability is its own clock; exact fixtures wait for verified policy. |
| EOD chain table | Trade date plus underlier/root bucket layout | Chain-slice query prunes by date and underlier bucket and sorts by underlier, expiry, right, strike, with profile/file-count evidence. |
| Source overlap reporting | DiscountOptionData vs Polygon/Massive overlap | Silver preserves both observations; differences are reported, not silently normalized; gold applies explicit precedence with caveat; DiscountOptionData index coverage is not assumed without symbol-list/sample-file evidence. |
| Caveat lineage | Index-option gaps and non-standard deliverables | Coverage gaps and deliverable changes surface in `qdb` lineage rather than as silent empty truth. |

Table: Options EOD companion sample path. Full DiscountOptionData vs Polygon/Massive reconciliation is deferred until the core kernel is green.

## Modeling And Retrieval Summaries

Phase 1.5 builds the typed modeling-engine interface once Phase 1 is green. It self-phases: `trading_calendar_bt` and `register_derived` land in Phase 1 because they have core value and gate later work; panel/fill/coverage/session surfaces land in Phase 1.5. Nothing here is a Phase 0 deliverable, and the interface adds no new service, daemon, or platform; it is contracts and typed functions on the existing kernel, manifests, lineage, and `qdb`. The separate modeling/backtesting engine is a future repo that couples only through [[PRJ-AI-CCC-DuckLake-v7.2.3-Modeling-Engine-Interface]].

Retrieval is not a blocker for the structured lake and is absent from core verification. When enabled behind a feature flag, it starts with a bounded SEC/news corpus, deferred-selection embedding model, LanceDB, metadata filters, BM25/full-text, dense search, reranking, and a labeled eval set. The invariant is that documents/chunks are filtered by `document_available_at <= known_at` before vector/BM25 candidate generation, not after top-k.

## Repository Contract And Bootstrap Plan

The future agent creates a new self-contained repo under `/Users/ryanpappal/03_CODE/ccc-lab-super/` — the external implementation code repo, distinct from the vault project folder that shares its name. It must not depend on the vault as a runtime directory; vault notes are design inputs only.

### Required Repo Shape

```text
ccc-lab-super/
  AGENTS.md
  CLAUDE.md
  README.md
  pyproject.toml
  Taskfile.yml
  docker-compose.override.example.yml  # optional local dev convenience only; Testcontainers is authoritative for tests (`CL7`)
  .env.example
  src/qdb/
  src/qdb_kernel/
  src/qdb_contracts/
  src/qdb_config/
  src/qdb_ingest/
  src/qdb_lake/
  src/qdb_orchestrate/
  src/qdb_validation/
  src/qdb_bench/
  src/cli.py
  dags/
  schemas/
  contracts/
  benchmarks/
  tests/
  docs/
  scripts/
```

Listing: Initial repo shape; package names may be refined only if the same responsibilities stay explicit.

### Frozen Toolchain, Package Roots, And Neutral Dtype Map

The low-strategic-value choices are frozen so independent implementers cannot drift; each pin is still recorded in `docs/version-pins.md` under `REQ-AUTH-01` and may be overridden only if `task verify:toolchain` proves an incompatibility. The frozen set is Python 3.13 on the standard GIL build only, `uv` with a committed lockfile, Ruff for lint/format, Pyright as type checker, pytest, Typer for CLI, Pydantic v2, Psycopg 3, Testcontainers PostgreSQL 16, Polars as the `qdb` return type, and a repo-local pinned Dagu binary only. Exact Python patch pin, package version, wheel tag, and import name resolve against live metadata under `REQ-AUTH-01`; `task verify:toolchain` and `task verify:deps` must prove compatibility before the lockfile is trusted.

The five core package roots are intentional: `qdb` for typed access, `qdb_lake` for DuckDB/DuckLake publication and maintenance, `qdb_contracts` for dataset contracts and neutral dtype map, `qdb_kernel` for registry/state machine/locks/visibility, and `qdb_config` for config models and the production-path classifier. Functional packages `qdb_ingest`, `qdb_orchestrate`, `qdb_validation`, and `qdb_bench` layer on those roots. The exact package layout is a verification item, but this five-root core is the intended shape.

```python
#file: src/qdb_contracts/dtypes.py
import polars as pl

NEUTRAL_TO_POLARS = {
    "timestamp_utc": pl.Datetime("us", "UTC"),
    "timestamp_utc_nullable": pl.Datetime("us", "UTC"),
    "date": pl.Date,
    "int64": pl.Int64,
    "float64": pl.Float64,
    "string": pl.String,
    "string_nullable": pl.String,
    "bool": pl.Boolean,
    "json": pl.String,
    "json_nullable": pl.String,
    "list_string": pl.List(pl.String),
}
```

Listing: The single neutral-to-Polars dtype map (`VERIFY-QDB-DTYPES`). Exact Polars spellings stay a verification item but resolve here once. `_nullable` tokens map to the same physical Polars dtype as non-null base; nullability is declared by each contract's authoritative `allowed_nulls` list and enforced by contract validation. A RED coverage test asserts every dtype token appearing in any contract or schema seed under `contracts/` or `schemas/` is a key in `NEUTRAL_TO_POLARS` (`D-001`).

### Bootstrap Plan

- Python: target Python 3.13 on the standard GIL build, pinned to an exact patch release in `docs/version-pins.md`; refuse the free-threaded `python3.13t` interpreter at startup and pin experimental JIT off with `PYTHON_JIT=0`. The agent pins the NEWEST 3.13.x patch release that passes `task verify:toolchain` (FBL2-09); `REQ-AUTH-01`'s lowest-compatible tie-break does NOT apply to interpreter patch releases (it would perversely select 3.13.0). IR ratification is required only to deviate from the frozen set itself — the 3.13 floor, the standard-GIL build, or the JIT-off posture — never for the patch number.
- Interpreter guardrail: `task setup` and the default test suite MUST run the `REQ-CFG-10` startup check before any native extension is imported, proven by `test_python_313_gil_enforcement` and its exact source checks `test_interpreter_is_standard_gil_build`, `test_interpreter_floor_is_3_13`, and `test_experimental_jit_pinned_off`. Canonical placement is the top of the `qdb_config` package `__init__.py` (the lowest always-imported module), before any native import; a CLI-only placement is insufficient because library imports must also trigger the guard. CI runs a dedicated check that imports `qdb_config` alone, without the CLI, and proves the guard fires.
- Environment and lockfile: `uv` for env management and a committed lockfile; `task setup` installs from the lockfile.
- Lint/type/test: Ruff for lint/format, Pyright as pinned type checker, and pytest; `task lint`, `task typecheck`, and `task test` must pass on scratch fixtures.
- Task commands (`BT6`): `task setup`, `task setup:dagu`, `task setup:duckdb-extensions`, `task test`, `task test:unit`, `task test:integration`, `task lint`, `task lint:dagu`, `task typecheck`, `task verify`, `task verify:bootstrap`, `task verify:offline`, `task verify:deps`, `task verify:deps:candidates`, `task verify:lockfile`, `task verify:phase0`, `task verify:phase0-index`, `task verify:qdbctl-grammar`, `task verify:toolchain`, `task verify:ducklake-api`, `task verify:phase1`, `task verify:iface`, `task verify:source-adapter-gate`, `task verify:options`, `task verify:retrieval`, `task verify:prelive`, `task guard:vendored-schema`, `task smoke:ducklake`, `task smoke:dagu`, `task smoke:nas`, `task backup:test`, `task restore:test`, `task bench:sample`, `task fixtures:build`, and `task example:phase0`. `task verify:bootstrap` is the scaffold gate (FBL2-22): repo shape, `.env.example` config validation, lockfile presence via `task verify:lockfile`, and the `REQ-CFG-10` guard import check; it is a convenience aggregate with no gate authority beyond `verify:phase0`.
- Dagu CLI entrypoint: Dagu invokes unified `src/cli.py`, not ad-hoc inline scripts; business logic lives in Python/CLI, not YAML.
- Scratch PostgreSQL (`OP2`): default integration harness is a session-scoped Testcontainers PostgreSQL 16 fixture; unit tests MUST NOT require Docker; integration tests require Docker preflight or explicit `QDB_TEST_POSTGRES_DSN`; tests MUST NOT silently use `localhost:5432`.
- DuckDB connection manager: centralized manager loads extensions, attaches the catalog, applies restricted `qdb` connection profile, and isolates test connections. `task verify:offline` denies outbound sockets after `task setup:duckdb-extensions` populates the pinned extension cache. `task verify:offline` also enforces the runtime-verification backlog's `fallback_status`/`kill_or_pivot` semantics (`D-012`): fail-closed, never guess.
- Scratch roots: `QDB_LAKE_ROOT`, `QDB_ARTIFACT_ROOT`, and `QDB_POSTGRES_BACKUP_ROOT` default to temporary scratch paths in tests; production paths are refused without explicit live flag.
- Schema migrations: kernel schema changes ship as numbered, append-only SQL files under `src/qdb_kernel/migrations/`, applied strictly in order by `qdbctl migrate` against `schema_migrations`.
- Dagu binary bootstrap: `task setup:dagu` fetches pinned Dagu binary into repo-local `.bin/` and verifies SHA before first use; `dagu version`, schema probe, `dagu validate`, CI, and `task smoke:dagu` all run that pinned binary, never a system-wide install.

### Canonical First-Steps Order (FBL2-23d)

The first implementation steps run in this fixed order, each with its named gate: (1) scaffold the repo shape plus `qdb_project.yaml` — `task verify:bootstrap`; (2) toolchain and lockfile — `task verify:toolchain`, `task verify:lockfile`; (3) generate the seed ledgers and implementation index, diffed against the shipped [[REF-AI-DuckLake-v7.2.3-BlockingTestIndex]] — `task verify:phase0-index`; (4) canonical-JSON authority selection and vector proof — `task test -k canonical_json_authority_vectors`; (5) Dagu binary pin — `task setup:dagu` (the Dagu pin sits BEFORE the DuckLake probe chain and is independent of it: an offline Dagu fetch failure fail-closes `verify:phase0` but blocks none of steps 4, 6, 7, or 8 individually); (6) DuckDB extension cache — `task setup:duckdb-extensions`, then `task verify:offline`; (7) DuckLake maintenance bindings — `task verify:ducklake-api`; (8) commit-fingerprint discovery — `task test -k commit_fingerprint_discovery`; (9) kernel DDL, transitions, locks, idempotency — `task test:integration`; (10) publish path end-to-end on `synthfix` — `task verify:phase0`. Steps 4, 7, and 8 are the `manifest_seal`-blocking probes in the canonical order already pinned above.

```python
#file: src/qdb_config/__init__.py (top of file, before any native import) - REQ-CFG-10 fail-closed guard
import os
import sys
import sysconfig

if sys.version_info < (3, 13):
    raise SystemExit("Refusing to run: Python 3.13 is the interpreter floor (REQ-CFG-10).")
if sysconfig.get_config_var("Py_GIL_DISABLED"):
    raise SystemExit(
        "Refusing to run on a free-threaded Python build (python3.13t). "
        "DuckDB/Polars do not declare free-threading support; use the "
        "standard GIL build (REQ-CFG-10)."
    )
if getattr(sys, "_is_gil_enabled", lambda: True)() is False:
    raise SystemExit("Refusing to run: the GIL is disabled at runtime (REQ-CFG-10).")
if os.environ.get("PYTHON_JIT", "0") != "0":
    raise SystemExit("Refusing to run: the experimental JIT must stay pinned off (PYTHON_JIT=0, REQ-CFG-10).")
```

Listing: The `REQ-CFG-10` free-threading refusal guard. Canonical placement is the top of `qdb_config/__init__.py`, the lowest always-imported module, before any native import, so both CLI and library imports trigger it. The corresponding Phase 0 acceptance seed is `test_python_313_gil_enforcement`, with exact source checks `test_interpreter_is_standard_gil_build`, `test_interpreter_floor_is_3_13`, and `test_experimental_jit_pinned_off` for standard GIL build, GIL enabled at runtime, Python 3.13 floor, and `PYTHON_JIT=0`. A dedicated CI check, `test_guard_fires_on_qdb_config_import_without_cli`, imports `qdb_config` alone, without the CLI, and proves the guard fires.

### Implementation Index And Reading Path

The agent generates, then the repo ships, `docs/implementation-index.seed.csv` and renders it to `docs/implementation-index.md`, a table mapping every requirement to where it is built and proven. Columns are `REQ ID | Phase | Blocking? | Pytest marker | Implementation file(s) | Test(s) | Command gate | Artifact/schema | Deferred until | Initial status | Notes`. Phase 0 and Phase 0.5 rows are listed first. This index is the single authoritative blocking-test ledger: every Phase 0 or Phase 0.5 row must carry blocking status, marker, named tests, command gate, and implementation/artifact/backlog surface; `task verify:phase0` runs exactly the union of blocking rows; duplicate rows dedupe by tests plus phase; `REQ-IFACE-*` rows carry gated xfail status; SQL-heavy tests not runnable in scratch are parked under `future_sql`; options/retrieval/prelive rows are non-blocking for the Phase 0/1 core gate; CI fails if a Phase 0/0.5 closure deliverable has no blocking row or if a blocking row lacks test, command, and proof surface.

Before writing product code, the implementation agent generates `docs/implementation-index.seed.csv` and `docs/runtime-verification/backlog.seed.yaml` from named blocking-test and verification-backlog tables. The extraction rule is deterministic: every named Phase 0 or Phase 0.5 RED test, every Phase 0 blocking acceptance test, every safety-bearing schema or runtime-verification artifact named by a Phase 0/0.5 section, and every backlog item whose `blocks` contains `verify:phase0`, `verify:ducklake-api`, or `manifest_seal` MUST appear in the seed. CI fails if a named blocker or safety-bearing artifact surface is missing. The extraction is checked against a shipped authority (FBL2-07): the PRD folder ships [[REF-AI-DuckLake-v7.2.3-BlockingTestIndex]], an authoritative flat CSV of every named test with phase and owner module; `task verify:phase0-index` MUST diff the generated seed's blocking rows clean against that CSV's `verify:phase0`-union rows (`phase0` plus `phase0_gated_xfail`). The agent-generated seed is never its own authority.

The repo also ships a short contract reading path mirrored into repo-local `AGENTS.md` and `CLAUDE.md` (`CL2`): read the `REQ-*` families and artifact seeds they reference as the binding contract; treat index tables, decision/phase tables, implementation summaries, and narrative callouts as navigation only. When they disagree, the `REQ-*` bullet and referenced seed govern.

### Schema Artifact Routing

Schema artifact inventory is preserved here as bootstrap routing, not as schema-body authority. Runtime-verification, publish manifest, restore bundle inventory, validation report, side-effect intent, provider capability pack, source-availability policy, observability event schemas, failed-run diagnosis, dataset contract, fixture scenario spec, and pre-live topology/probe schemas must exist in the future repo, but their governing field bodies belong to their owner modules: [[PRJ-AI-CCC-DuckLake-v7.2.3-Manifests-Lineage-And-Fixtures]], [[PRJ-AI-CCC-DuckLake-v7.2.3-Dataset-Contracts-And-Validation]], [[PRJ-AI-CCC-DuckLake-v7.2.3-Provider-Capability-And-Availability]], and [[PRJ-AI-CCC-DuckLake-v7.2.3-Ops-Recovery-Maintenance-Security]].

Generate-and-record means assemble the schema file from fields the governing normative section already enumerates; never invent fields, types, enums, defaults, or PIT/bitemporal timeline columns. Nested object structure is allowed only when the governing seed names the parent field and the schema derivation ledger enumerates each nested key, type, required/optional status, enum domain, and source section. The implementation MUST ship a machine-checkable schema derivation ledger rendered to `docs/schema-derivation/phase0-safety-schemas.md` with one row per safety-bearing schema field path; `test_schema_derivation_ledger_covers_phase0_safety_schemas` fails if any generated schema field lacks that ledger row.

JSON Schema conventions (`BT8`, `REQ-OBS-SCHEMA`) remain fixed: draft 2020-12; `additionalProperties: false` by default; UTC timestamps as date-time strings; dates as date strings; typed unions for nullable fields; SHA-256 pattern `^sha256:[a-f0-9]{64}$`; relative paths cannot begin with `/`, `..`, `s3://`, `http://`, or `https://`; every schema file has explicit `required`; `runtime_verification` uses conditional required fields by status; `jsonschema` validates schemas with `validator_for(...).check_schema(...)` and explicit `FormatChecker`; generated schema files are snapshot-tested after generation; missing fields or enum values become investigate backlog items rather than guessed schema defaults.

## Config Validation

| Variable | Type | Required | Allowed path class | Test default | May point to production? |
|---|---|---|---|---|---|
| `QDB_LAKE_ROOT` | path/URI | yes | durable lake root | temp scratch dir | only with `QDB_ENABLE_NON_SCRATCH_STORAGE` plus live flag |
| `QDB_LOCAL_SCRATCH` | path | yes | local NVMe scratch | temp dir | n/a |
| `QDB_ARTIFACT_ROOT` | path | yes | manifests/validation/restore evidence | temp scratch dir | only with `QDB_ENABLE_NON_SCRATCH_STORAGE` plus live flag |
| `QDB_DUCKLAKE_CATALOG_DSN` | DSN | yes | scratch catalog in tests | scratch catalog | only with `QDB_ENABLE_NON_SCRATCH_STORAGE` plus live flag |
| `QDB_POSTGRES_BACKUP_ROOT` | path | yes | backup destination | temp scratch dir | only with `QDB_ENABLE_NON_SCRATCH_STORAGE` plus live flag |
| `QDB_DEFAULT_QUERY_TIMEOUT_SECONDS` | int | yes | n/a | small test value | n/a |
| `QDB_DEFAULT_ROW_LIMIT` | int | yes | n/a | small test value | n/a |
| `QDB_DEFAULT_BYTE_LIMIT` | int | yes | n/a | small test value | n/a |
| `QDB_ENABLE_LIVE_SOURCES` | bool | yes | n/a | false | gate for live provider/vendor downloads and live adapters only; never a storage gate |
| `QDB_ENABLE_NON_SCRATCH_STORAGE` | bool | yes | n/a | false | gate for non-scratch NAS lake/artifact/backup roots and the real catalog DSN, independent of live-source enablement |
| `QDB_ENABLE_RETRIEVAL` | bool | yes | n/a | false | feature flag, off in core verify |
| `QDB_ENABLE_SQL_EXPERT_MODE` | bool | yes | n/a | false | still restricted to contract-generated PIT-safe views/functions if enabled |
| `QDB_DAGU_HOME` | path | optional | Dagu state | temp dir | n/a |
| `QDB_TEST_POSTGRES_DSN` | DSN | optional | integration-test catalog override | unset with Testcontainers used | test-only; never a production catalog |
| `QDB_ACTIVE_PHASE` | enum | optional | n/a | unset (`qdb_project.yaml` `active_phase` governs) | n/a; one-command phase override for `task verify`, values `phase0`, `phase1`, `iface`, `options`, `retrieval`, `prelive` (FBL2-22) |

Table: Config contract with scratch-only defaults and production-path refusal.

> [!important] Default refusal of production paths
> Default tests fail if `QDB_LAKE_ROOT`, `QDB_ARTIFACT_ROOT`, `QDB_POSTGRES_BACKUP_ROOT`, or `QDB_DUCKLAKE_CATALOG_DSN` resolve to production-looking NAS paths or the live catalog unless `QDB_ENABLE_NON_SCRATCH_STORAGE` plus the explicit live flag are present. Cleanup, restore, orphan deletion, and production publish promotion refuse to run without the storage gate and approval flags; live source download refuses without `QDB_ENABLE_LIVE_SOURCES` and its provider gates. Storage enablement and live-source enablement are independent axes: a NAS storage/smoke drill on `synthfix` fixtures may open the storage gate while live sources stay off, and opening the storage gate never implies vendor data may flow (`test_storage_flag_and_live_source_flag_are_independently_gateable`).

The classifier roots and hosts come from committed `qdb_project.example.yaml`, copied to machine-local `qdb_project.yaml`. Phase 0 needs only `scratch_roots`; `prod_path_roots` and `prod_catalog_hosts` stay empty until pre-live, so default posture is closed and the agent never has to guess real NAS roots or catalog hosts from this PRD.

```yaml
#file: qdb_project.example.yaml
scratch_roots:
  - /tmp/qdb-scratch
prod_path_roots: []
prod_catalog_hosts: []
scratch_dsn_endpoints:
  - 127.0.0.1:<testcontainers-port>
```

Listing: Example project config. Phase 0 uses scratch only; production roots and catalog hosts are empty until pre-live.

## Production-Path Classifier

The refusal above is enforced by one function that resolves real paths before classifying them, so a symlink or mount into a production root cannot evade a string check. Deny-list and allow-list are evaluated against resolved paths; there is exactly one storage escape, gated on the storage toggle (`QDB_ENABLE_NON_SCRATCH_STORAGE`) plus an explicit CLI flag. Live-source enablement (`QDB_ENABLE_LIVE_SOURCES`) is a separate axis that never unlocks a path or DSN by itself.

```python
#file: src/qdb_config/path_guard.py
import os

class ProductionPathRefusedError(RuntimeError):
    """Raised when a path or DSN resolves into a production surface without the live escape."""

_PROD_PATH_ROOTS: tuple[str, ...] = ()
_PROD_CATALOG_ENDPOINTS: frozenset[str] = frozenset()
_SCRATCH_DSN_ENDPOINTS: frozenset[str] = frozenset()
_SOURCES_ENV = "QDB_ENABLE_LIVE_SOURCES"          # gates live provider/vendor downloads only
_STORAGE_ENV = "QDB_ENABLE_NON_SCRATCH_STORAGE"   # gates non-scratch paths and the real catalog DSN
_LIVE_FLAG = "--i-understand-this-touches-real-data"

def _under(real_path: str, root: str) -> bool:
    rroot = os.path.realpath(root)
    return real_path == rroot or real_path.startswith(rroot + os.sep)

def assert_path_is_safe(path: str, *, storage_enabled: bool, live_flag_present: bool, allow_roots: tuple[str, ...] = (), scratch_roots: tuple[str, ...] = ()) -> None:
    real = os.path.realpath(path)
    allowed_roots = allow_roots + scratch_roots
    if any(_under(real, a) for a in allowed_roots):
        return
    escape = storage_enabled and live_flag_present
    if any(_under(real, r) for r in _PROD_PATH_ROOTS):
        if escape:
            return
        raise ProductionPathRefusedError(f"refused production path: {real}")
    if real.startswith("/Volumes/") and not escape:
        raise ProductionPathRefusedError(f"refused external mount: {real}")
    if escape:
        return
    raise ProductionPathRefusedError(f"refused non-scratch local path: {real}")

def assert_dsn_is_safe(dsn_endpoint: str, *, storage_enabled: bool, live_flag_present: bool, test_dsn_marker_present: bool = False) -> None:
    if dsn_endpoint in _SCRATCH_DSN_ENDPOINTS and test_dsn_marker_present:
        return
    escape = storage_enabled and live_flag_present
    if dsn_endpoint in _PROD_CATALOG_ENDPOINTS and not escape:
        raise ProductionPathRefusedError(f"refused live catalog endpoint: {dsn_endpoint}")
    if dsn_endpoint.startswith("127.0.0.1:") and not test_dsn_marker_present and not escape:
        raise ProductionPathRefusedError(f"refused localhost catalog endpoint without QDB_TEST_POSTGRES_DSN marker: {dsn_endpoint}")
    if dsn_endpoint not in _SCRATCH_DSN_ENDPOINTS and not escape:
        raise ProductionPathRefusedError(f"refused non-scratch catalog endpoint: {dsn_endpoint}")
    return
```

Listing: Production-path classifier. Real-path resolution precedes classification; mutating paths are default-closed unless they resolve under configured scratch roots or explicit allow roots, or the live escape is present. `test_unknown_local_non_scratch_path_is_refused_without_live_escape` proves the path refusal, and `test_dsn_localhost_live_port_is_refused_without_marker` proves the DSN classifier refuses localhost live ports unless they are explicit Testcontainers or `QDB_TEST_POSTGRES_DSN` endpoints. The storage escape requires both `QDB_ENABLE_NON_SCRATCH_STORAGE` and the explicit flag; `QDB_ENABLE_LIVE_SOURCES` gates live provider downloads and adapters only and never unlocks a path or DSN by itself. `ProductionPathRefusedError.__str__` prepends the pinned `REQ-QDB-ERRORS` sentence; the per-site f-strings are diagnostic suffix detail (FBL2-02, mirrored from the governing Ops listing).

## Build-Vs-Buy Decisions

The build-vs-buy split is deliberately narrow: buy commodity infrastructure, custom-build only the trading semantics, the `known_at`/lineage model, and the safe agent/query boundary. This table is a non-binding candidate map; no package named here may enter `pyproject.toml` unless it appears in External Dependency Candidates, the Phase 0 whitelist, or a `REQ-AUTH-DEP-01` verification/backlog record with a passed proof gate.

| Capability | Decision | Candidate tools | Rationale |
|---|---|---|---|
| Lake catalog and snapshots | Buy | DuckLake + PostgreSQL | Do not rebuild lake metadata, transactions, snapshots, schema evolution. |
| Financial PIT semantics | Build | `qdb`, DuckDB SQL/macros, validation | No package encodes Ryan's trading semantics and source-specific knowledge time. |
| Publish/control kernel | Build | Python + PostgreSQL tables + durable manifests | Semantic control surface is Ryan-specific; orchestrators do not own it. |
| Query/transform | Buy | DuckDB, Polars, PyArrow | Mature engines; custom code is contracts and layout, not engine mechanics. |
| Data validation | Mostly buy | `dataframely` first / Pandera fallback only if the named gate fails + mandatory DuckDB SQL checks; `jsonschema` for artifact/contract schemas | Commodity validation packaged; PIT/source-overlap invariants and DuckDB SQL integrity are custom. |
| SQL safety if any SQL | Buy + build | SQLGlot for AST/table extraction; DuckDB read-only/hardening | Parser bought; policy and PIT-safe views are custom. SQLGlot is one gate, not the boundary. |
| Orchestration | Buy | Dagu resolved by deterministic stable-2.x selection | Fits solo local-first without Airflow-scale infrastructure; YAML must pass schema/validation and project lint against repo-local `.bin/dagu`. |
| Catalog backup | Buy | `pg_dump`/`pg_restore`/`pg_dumpall --globals-only` | Do not custom-build database backup. |
| File/manifest/NAS backup | Buy | NAS snapshots or restic | Catalog backup alone is insufficient; do not custom-build filesystem backup. |
| Lint/type checking | Buy | Ruff + Pyright | Pyright is frozen type-checker choice; Ruff replaces black/isort/flake8. |
| CLI/config | Buy | Typer + pydantic-settings + Pydantic | Typer is frozen, not a candidate; do not hand-roll CLI/config parsing. |
| HTTP/retry/rate-limit | Buy | HTTPX + Tenacity + limiter package | Custom code is thin source-specific policy glue only. |
| PostgreSQL client/test | Buy | Psycopg 3; Testcontainers PostgreSQL 16 | Unit/integration split; no silent localhost fallback. |
| Ingestion adapters | Build thin | Official vendor clients/SDKs behind raw-capture + capability gates | Sources bought/free; normalization is Ryan-specific; `dlt` parked/rejected first wave. |
| SEC/XBRL | Buy + build | Arelle/EdgarTools/`sec-edgar-api`; mocked HTTP in tests | Do not hand-roll XBRL parsing; wrap output in CCC PIT/lineage. |
| FRED/ALFRED | Build thin | Custom thin official-API client | Preserve exact vintage fields; common libraries do not clear maturity/freshness gates. |
| Trading calendar | Buy + build | `exchange_calendars` first; `pandas_market_calendars` fallback, wrapped in `trading_calendar_bt` | Buy holiday/session data; build the bitemporal PIT contract that binds resample/fill. |
| Retrieval | Buy first | LanceDB | Light local hybrid; custom work is metadata, chunking, PIT filters, eval. |
| Retrieval escalation | Defer | Qdrant | Only on failed eval or service-feature need. |
| Benchmarking | Buy | pytest-benchmark, hyperfine, DuckDB profiling | Generic runners; Ryan-specific query packs. |
| Hot OLAP | Exclude first release | ClickHouse | No ClickHouse work; benchmark-triggered future PRD only. |
| Lineage / data-quality platform | Defer | OpenLineage/Marquez, Great Expectations | Manifests plus dataframe validation/Pandera fallback and DuckDB SQL suffice first release. |

Table: Build-vs-buy non-binding candidate map. Tool names are candidates to verify, not pinned facts or install authority. External Dependency Candidates and its proof gates refine these names; where a tool name differs, External Dependency Candidates and governing `REQ-*` bullets control.

## Phase 0 Research-Sanity Example

`examples/01_phase0_research_sanity.py`, run via `task example:phase0`, is the end-to-end smoke a researcher reads first. It publishes `synthfix` equity/SEC/FRED fixtures through the kernel, then walks the typed surface:

- `describe_dataset(...)` for an enabled dataset and for gated `option_eod_quote`, showing `published = False` and `phase = "phase1b"`.
- `get_bars_asof(...)` before and after source availability, with the first returning an empty full-schema frame with lineage and the second returning the bar.
- `get_fundamentals_asof(symbols=...)` before and after the SEC `accepted_at` clock.
- `get_macro_vintage(...)` before and after a vintage revision.
- `explain_query(...)` to show the bound half-open predicate without executing it.
- One valid empty result carrying full lineage with `row_count = 0`, resolved manifest, and snapshot.
- One missing-`known_at` refusal (`MissingKnownAtError`) and one missing-`adjustment_policy` refusal (`MissingAdjustmentPolicyError`).
- `qdbctl kernel-status` to show batch states and locks.
- `qdbctl diagnose --batch-id <id> --format text` on a deliberately failed publish, plus at least one non-batch target such as `--cleanup-id <id>` in tests.
- A copied-root scratch restore into a fresh catalog, then re-running one PIT query to prove the restored lake answers identically.

The example imports nothing from the vault and runs entirely on `synthfix` fixtures, so it doubles as the human-readable proof that the fixture-complete Definition of Done holds. A top-level `README.md` quickstart links to this walkthrough as the first-15-minutes path for a new researcher: install, configure scratch roots, publish `synthfix`, query bars/fundamentals/macro, inspect lineage, read a refusal, diagnose a failed publish, and restore from a scratch copy.

## v7.2.3 bootstrap, path, and host-order amendments

AMD-002 makes the final independently recomputed v7.2.3 source-custody manifest the first repository-bootstrap gate. An input-only v7.2.1 seal permits copy-first source work and nothing else. A stale README, mutable implementation index, Task wrapper, or hash mismatch must refuse before any migration, schema, product, or README command.

AMD-020 defines the canonical production-path classifier: resolve real paths, reject overlap among scratch, allow, and production roots, classify production and external roots before allow-root success, and refuse symlink paths that resolve into production. AMD-021 requires the Ops mirror to be byte-equivalent behavior, never a second owner.

AMD-045 links desired host roles to [[PRJ-AI-CCC-DuckLake-v7.2.3-Physical-Host-Bootstrap-And-Cutover]]. The immutable operational order is autonomous Phase -1 evidence, final source custody, project-local scratch bootstrap, and only then receipt-bound physical actions. No architecture prose or role label can bypass that order.

## v7.2.3 r2 restored indexed acceptance criteria

- `test_spec_source_manifest_enumerates_root_all_production_modules_and_bti`: the independently emitted manifest contains the root, every production module, and the Blocking Test Index exactly once with the expected authority roles.
- `test_coder_mutated_derivative_manifest_cannot_pass_source_gate`: a manifest or spec bundle rewritten inside the implementation repo cannot satisfy the external runner's recomputed raw-file hashes.
- `test_taskfile_or_worker_wrapper_mutation_cannot_convert_external_gate_failure_to_pass`: Taskfile, worker, wrapper, or environment changes cannot turn a failed external custody verification into a passing bootstrap result.
- `test_spec_source_manifest_hash_mismatch_blocks_bootstrap`: any authority-file, plan, runner, manifest, or spec-bundle hash mismatch blocks bootstrap before code generation or implementation use.
- `test_path_classifier_rejects_overlap_and_symlink_into_production`: scratch and allow roots refuse overlap with protected roots and refuse any symlink or resolved path that enters a production root.
