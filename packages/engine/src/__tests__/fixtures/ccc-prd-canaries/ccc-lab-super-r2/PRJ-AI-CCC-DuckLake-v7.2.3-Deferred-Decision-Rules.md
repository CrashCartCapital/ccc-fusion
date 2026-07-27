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
  - decisions
  - verification
---

# CCC DuckLake v7.2.3 deferred-decision rules

This module owns what happens whenever the PRD says that something will be decided later. Its purpose is simple: nothing may be pushed into the future without leaving clear instructions for how the future decision will be made.

## Plain rule

Every real postponed decision must say:

1. What is still unknown.
2. What safe behavior is required while waiting.
3. What event starts the decision.
4. What evidence must be collected.
5. When that evidence becomes too old to trust.
6. Whether an exact test can decide it or Ryan must decide it.
7. What choices are allowed.
8. How the winning choice is selected.
9. What happens if the evidence is missing, old, incomplete, or conflicting.
10. Where the answer and evidence are saved.
11. What proves the system follows the answer.
12. What named event allows the decision to be reopened.

The master list is [[PRJ-AI-CCC-DuckLake-v7.2.3-Deferred-Decision-Registry]]. A postponed item that does not appear there is not valid PRD authority.

## What counts as a postponed decision

- A real choice that must be made later.
- A feature or source that stays blocked until evidence exists.
- An exact software, hardware, timing, threshold, or environment fact that must be measured.
- A future capability whose entry conditions are already part of this project.

The following do not create a new postponed decision:

- A permanent non-goal, such as keeping ClickHouse out of this release. Its future escape rule still gets one registry entry when the PRD names a possible return path.
- A historical explanation of an earlier choice.
- A repeated sentence that points to an existing `DD-*` entry.
- An example value that is clearly labeled as an example and cannot be used by the system.

## Required states

Each registry item uses one of these states:

- `waiting`: the trigger has not happened; the safe waiting rule applies.
- `ready_to_check`: the trigger happened and evidence collection must begin.
- `evidence_collected`: all required evidence exists and is still current.
- `decided`: the stated rule has selected an allowed outcome.
- `proven`: the named proof confirms the system follows the decision.
- `rejected_for_now`: the deadline arrived without enough trustworthy evidence; the related feature stays blocked.
- `superseded`: a later approved decision replaced this one and points back to it.

There is no endless `keep waiting` outcome. Every item names a gate it cannot pass while unresolved. If trustworthy evidence is unavailable when that gate is reached, the item becomes `rejected_for_now` and the related feature, source, path, or scale-up stays blocked.

## Who may decide

An exact check decides facts such as whether hashes match, a command passes, required fields exist, an allowlist matches, or measured behavior crosses a previously approved threshold. These checks must be written as normal code or tests. A language-model vote must not decide a fact that ordinary code can decide exactly.

Ryan decides spending, legal or license acceptance, live-source enablement, live publication, destructive deletion of protected evidence, major goal changes, and any exception that grants broader authority. Tools and committees may prepare evidence but may not make those decisions. If Ryan is unavailable, the project pauses safely unless Ryan has explicitly named a delegate for that exact decision class.

Committees remain advisory or shadow-only until [[PRJ-AI-CCC-DuckLake-v7.2.3-Deferred-Decision-Registry#DD-001 — Committee authority]] is proven. A committee never overrides a failed deterministic check.

## Evidence rules

Evidence must name its source, collection command or method, timestamp, content hash when possible, and expiration rule. The expiration may be a date or a change event such as a new package version, provider format, hardware path, operating-system release, mount configuration, or model/prompt version.

Missing, old, incomplete, conflicting, or unauthenticated evidence never counts as approval. It produces `rejected_for_now`, a named fallback, or a human checkpoint according to the registry entry. A successful earlier measurement does not survive a named reopening event without a fresh check.

## Proof rules

A positive decision is proven by the smallest exact check that can show the selected behavior works. A negative decision is proven by one or more of: an absence scan over the exact executable surfaces, a refusal test, a disabled configuration, an unreachable code-path test, or a saved approval record showing implementation was not allowed. Narrative prose alone is not proof.

Each result is saved as `docs/decisions/DD-XXX.json` in the implementation repo. A decision family that needs separate records uses the flat ID `DD-XXX--slug`, where `slug` is lowercase ASCII letters, digits, and single hyphens only; examples are `DD-005--massive` and `DD-012--pit-join`. The child record carries `parent_decision_id: DD-XXX`. Child records inherit only the shared family process explicitly named by the parent entry; trigger, deadline, evidence, outcome, and current state are always written in the child record rather than silently inherited. Two records may not share an ID or slug. The record contains the decision ID, optional parent decision ID, old and new state, evidence paths and hashes, chosen outcome, deciding rule or Ryan-signed marker, proof command, proof result, and reopening conditions.

## Self-contained specification bundle

The implementation repo never reads the Obsidian vault at runtime. Before implementation begins, the independent custody runner exports the sealed authority set into `docs/spec-authority/v7.2.3/` in the implementation repo. The bundle contains the root, all production modules, the Blocking Test Index, `v7.2.3-final-authority-r2.manifest.json`, `deferred-decision-coverage.v1.json`, and `spec-authority-bundle.v1.json`. The bundle record hashes every included file plus the coverage file and binds them to source version `v7.2.3`, the amendment-plan hash, the external gate-runner hash, and the final authority-manifest hash.

`task verify:spec-authority` recomputes the entire bundle without contacting the vault. A missing file, extra authoritative file, changed byte, hash mismatch, wrong version, mutable replacement manifest, or coverage file not named by the bundle is a Phase 0 refusal. Updating the PRD requires a new revisioned manifest and a newly exported bundle; editing the copied bundle by hand never updates authority.

## Automatic coverage check

The implementation repo must provide `task verify:deferred-decisions`. After `task verify:spec-authority` passes, it scans only the sealed modules under `docs/spec-authority/v7.2.3/` for deferral-like language including `defer`, `later`, `future`, `unresolved`, `pending`, `investigate`, `not yet`, and `evidence-gated`. It never reads the vault.

Every match must do one of three things:

1. Carry or sit in a section that names a valid `DD-*` entry.
2. Appear in the sealed coverage file `docs/spec-authority/v7.2.3/deferred-decision-coverage.v1.json` as a permanent non-goal, historical reference, repeated restatement, or example.
3. Fail the check as an untracked postponed decision.

The check also fails when a registry entry lacks its current state, decision authority, trigger, deadline gate, evidence rule, expiration rule, allowed outcomes, no-evidence result, saved record, proof, or reopening rule. The sealed coverage file contains one record per matched phrase with `source_relative_path`, `heading_path`, `matched_text_sha256`, `classification` (`decision_ref`, `permanent_non_goal`, `historical_reference`, `repeated_restatement`, or `example`), nullable `decision_id`, `reason`, `reviewed_by`, and `reviewed_at`. Only the independent handoff process may create or replace this file, and its hash is bound by `spec-authority-bundle.v1.json`; a developer change fails `task verify:spec-authority`. A new or changed phrase absent from the sealed coverage file fails closed and requires a new specification bundle rather than a local allowlist edit.

The coverage file is the reviewed baseline. Normal CI recomputes hashes for the unchanged sealed snapshot and checks only implementation decision records plus any proposed replacement spec bundle. It does not ask a human to reclassify unchanged historical prose on every run.

## Shared family rules

Closely related decisions may share a family process to avoid repetitive paperwork. A family rule supplies common evidence, expiration, failure, record, and proof rules. Each child decision still names its unique source, trigger, deadline, and outcome. Provider decisions use the provider family; runtime bindings use the runtime-probe family; storage and host decisions use the pre-live family; future capabilities use the scope-change family.

## Release rule

`task verify:phase0-index` must fail if a Phase 0 or Phase 0.5 postponed item is not mapped to a `DD-*` entry. `task verify:prelive` must fail if a storage, host, service, recovery, or production-topology item reaches its deadline without state `proven`. `task verify:source-adapter-gate` must fail if a provider item reaches its deadline without state `proven`. A future-scope item cannot enter implementation until its registry trigger is met and its result is `proven` or a new PRD explicitly supersedes it.

## Acceptance proofs

- `test_every_authoritative_deferral_maps_to_registry_or_reviewed_exclusion`
- `test_registry_entry_requires_trigger_deadline_evidence_expiration_outcomes_fallback_record_proof_and_reopen_rule`
- `test_missing_stale_incomplete_or_conflicting_evidence_never_approves`
- `test_unresolved_item_becomes_rejected_for_now_at_deadline_gate`
- `test_deterministic_fact_cannot_be_cleared_by_model_vote`
- `test_ryan_only_decision_pauses_without_matching_signed_marker`
- `test_negative_decision_has_absence_refusal_disabled_or_unreachable_proof`
- `test_reopen_requires_predeclared_change_event_and_fresh_evidence`
