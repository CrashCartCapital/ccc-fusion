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
  - physical-host
  - autonomy
---

# CCC DuckLake v7.2.3 physical-host bootstrap and cutover

Every postponed host, route, trust, persistence, NAS, recovery, or commissioning fact in this module follows DD-011, DD-013, and DD-022 in [[PRJ-AI-CCC-DuckLake-v7.2.3-Deferred-Decision-Registry]]. Unreachable discovery produces a quarantined target and scratch-only work; it never counts as approval and cannot remain silently open past the matching pre-live gate.

This module is the sole semantic owner for physical-host bootstrap, estate disposition, commissioned-host readiness, and cutover. It is mechanism-neutral: it defines evidence and refusal contracts, never a hostname, secret value, live mount, transport selection, or unverified installation recipe.

## Owns

- Host identity, access-policy, estate-inventory, deployment-record, remote-command, cutover, rollback, controller-recovery, and multi-host readiness semantics.
- The ordered physical-action classes that consume [[PRJ-AI-CCC-DuckLake-v7.2.3-Committee-Gates-And-HITL#Autonomous Execution Authority and Receipt Contract]] receipts.
- The distinction between scratch-only local work and a writable multi-host canonical root.

## Does not own

- Kernel state, database grants, cleanup eligibility, qdb behavior, provider enablement, storage semantics, or common schema-generation mechanics.
- Any new approval schema or signing mechanism. [[PRJ-AI-CCC-DuckLake-v7.2.3-Committee-Gates-And-HITL]] owns receipt issuance and verification; [[PRJ-AI-CCC-DuckLake-v7.2.3-Manifests-Lineage-And-Fixtures]] owns generated-schema conventions.

## Phase -1 automatic estate reconciliation

### Phase -1A local evidence

Phase -1A is credentialless, local, and metadata-only. It may read the sealed plan, PRD inputs, implementation worktree, and non-sensitive path metadata. It must emit plan hash, command identity, input hashes, output hashes, no-mutation attestation, and two collector-window quiescence evidence. It must not connect remotely; inspect identity, network, credential, or configuration sources; read a secret store; or mutate state.

### Phase -1B secure discovery

Phase -1B is attempted only through a project-scoped, value-blind discovery identity and a target-bound read-only command allowlist. The discovery identity must have expiry, revocation evidence, an audit record, and no privilege to enroll, pair, rotate, install, modify, or delete. If no verified route accepts that identity, the result is `unreachable`, not a permissive inference. Fixture and source work continue locally while remote estate items remain quarantined.

### Required estate records

Every estate item has exactly one disposition: `keep`, `quarantine`, `replace`, `repair`, or `retire`. Each record binds target identity, observed evidence hashes, owner or unknown-owner state, rollback or recovery artifact, and a reason. `unknown` ownership, an active conflict, an unresolved path/identity collision, a missing recovery route, or a recent write in either collector window deterministically yields `quarantine` and blocks the affected target only.

Two collector windows are required. Each records the writer identity when known, last-write time band, metadata digest, and collision result. Quiescence passes only when both windows match the declared inactive policy. A failing or unreachable window is a refusal, not a retryable approval.

## Host identity and transport-neutral dispatch

`host_identity.v1` binds immutable device identity, intended role, peer trust fingerprint, authorized controller identity, command allowlist hash, release identity, issue/expiry window, and revocation proof. Operational enrollment requires a valid `remote_enrollment` receipt and a verified preflight record. Discovery access is never operational enrollment.

`remote_command_event.v1` binds a typed command, exact release digest, controller and worker identity, timeout, idempotency key, evidence return hash, and sole-publisher assertion. A remote worker may perform bounded heavy work but cannot publish, alter trust, install itself, or create a second authority path. Transport selection remains proof-derived among the allowed mechanisms; an absent selected transport refuses dispatch.

## Secret, PostgreSQL, NAS, and deployment contracts

`secret_binding.v1` contains name, purpose, consumers, issuer class, injection surface, rotation trigger, revocation action, recovery owner, and proof hash. It never contains a secret value. A missing rotation, revocation, or recovery field refuses use.

`postgres_access_policy.v1` defines migration, runtime-writer, runtime-reader, backup, and health roles; route scope; authenticated server identity; selected transport evidence; rotation; and lost-client revocation. It does not grant ownership, direct cleanup DML, or marker minting. [[PRJ-AI-CCC-DuckLake-v7.2.3-Ops-Recovery-Maintenance-Security]] and [[PRJ-AI-CCC-DuckLake-v7.2.3-Publish-Control-Kernel]] remain the owners of database grants and cleanup eligibility.

`nas_mount_identity.v1` binds share identity, mount identity, account class, credential pointer, persistence proof, same-root/device evidence across required hosts, and no-local-fallback proof. NAS mutation requires a verified supported admin surface and a `nas_mutation` receipt; generic remote mutation is refused.

`deployment_record.v1` binds device, host role, authenticated principal, controller, source/spec/lock/config/service digests, local environment build proof, health/start order, reboot proof, approval receipt, and rollback identity. Shared working directories, copied virtual environments, release mismatch, and missing rollback identity refuse deployment.

## Autonomous physical-action consumption

Physical actions use the single Autonomous Execution Receipt family from the Committee module. The action classes are `remote_enrollment`, `privilege_change`, `service_replace`, `nas_mutation`, `canonical_root_promotion`, and `rollback_exception`. A caller must supply a non-expired, unreplayed receipt whose plan hash, action class, target identity, requested privilege, preconditions, evidence hashes, executor identity, and rollback artifact hash exactly match the requested action. CLI flags, environment variables, mutable documents, database settings, and runtime roles are not receipts and cannot be substituted.

## Controller recovery

`controller_recovery.v1` contains source and release hashes, non-secret inventory, public trust fingerprints, mount contract, secret-binding names, lost-controller revoke-and-rotate procedure, and a recovery-material retrieval procedure. Recovery is first proven with fake or scratch material. Any incomplete trust or revocation packet refuses recovery.

## Operator grammar and hard stop order

The only command families are `read`, `probe`, `plan`, `apply`, and `rollback`. `read` and `probe` are non-mutating. `plan` emits an immutable plan hash and recovery artifact. `apply` and `rollback` require a matching autonomous receipt, exact target identity, and verified rollback route. No command accepts a flag that disables receipt validation.

The stop order is immutable: Phase -1A; Phase -1B when a verified route exists; deterministic estate disposition; source custody; final v7.2.3 authority seal; project-local implementation bootstrap; host identity; release identity; service persistence; storage identity; remote dispatch; recovery proof; canonical-root promotion; optional M2 work; provider gates. A later step cannot satisfy an earlier missing proof.

## Multi-host readiness

`multi_host_prelive_record.v1` hashes every prerequisite: source custody, host identity, estate classification and quiescence, exact release, service persistence, storage identity, remote seam, controller recovery, and the applicable autonomous receipt. A multi-host canonical root is unwritable until every prerequisite independently verifies. Storage readiness and provider readiness remain independent lanes.

## Acceptance proofs

- `test_phase_minus_one_a_precedes_read_only_discovery_access`
- `test_unknown_or_recent_writer_blocks_canonical_root`
- `test_unresolved_service_port_or_path_collision_blocks_provision`
- `test_remote_mutation_refuses_unverified_host_identity`
- `test_runtime_orchestrator_cannot_create_its_own_host_trust_or_installation`
- `test_m4_dispatches_scratch_heavy_job_to_m5_exact_release`
- `test_secret_binding_requires_rotation_revocation_and_recovery`
- `test_nas_mutation_refuses_without_supported_admin_surface_and_receipt`
- `test_mutating_ops_target_requires_matching_plan_hash_and_receipt`
- `test_fresh_controller_recovers_with_supplied_material_without_secret_leak`
- `test_multi_host_stop_gate_order_cannot_skip_identity_estate_or_rollback_proof`
- `test_multi_host_readiness_refuses_when_any_prerequisite_is_missing`

## AMD traceability

AMD-031 creates this sole production owner. AMD-032 defines the remote seam, AMD-033 first enrollment and revocation, AMD-034 Phase -1 estate gates, AMD-035 secret binding, AMD-036 PostgreSQL identity, AMD-037 NAS boundary, AMD-038 deployment identity, AMD-039 physical receipt consumption, AMD-040 controller recovery, AMD-041 command grammar and stop order, and AMD-042 aggregate readiness. This module also consumes AMD-046b and supplies physical semantics to AMD-047 through AMD-051. The canonical dependency order is recorded in [[REF-AI-CCC-Lab-Super-v7.2.3-Autonomous-DecisionLedger]].
