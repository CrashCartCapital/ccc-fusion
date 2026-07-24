---
type: prj
domain: ccc
status: active
date_created: 2026-07-01
date_modified: 2026-07-11
version: 7.2.3
---

# CCC DuckLake v7.2.3 Committee Gates And HITL

This module specifies the LLM-judge **committee gates** (CG-01..CG-11) that pre-validate machine-checkable evidence in place of human eyeballing, and the **irreducible human-in-the-loop families** (IR-1..IR-8) that no committee may ever decide. Every committee here PRE-VALIDATES evidence produced by the coder and records its verdict as an artifact, so a human (Ryan) reviews a bounded escalation queue rather than every gate. Committees decide only whether reproducible evidence supports a safe outcome; they never author the outcome for spend, legal, live-data, or destructive branches.

> [!warning] v7.1.1 ADJUDICATED POSTURE (unchanged in v7.2.3) — ADVISORY TRIAGE USABLE NOW; GATE-CLEARING AUTHORITY UNRATIFIED
> Ryan's v7.1.1 adjudication (2026-07-02): committees MAY operate now in **advisory-triage mode** — preparing recommendations, summarizing evidence, triaging open questions, identifying risks, and proposing gate packets for Ryan's review. Committees may NOT clear gates, approve live enablement, approve spend, approve legal/license posture, approve destructive actions, or replace Ryan's final decision. v7.2.3 adds a stronger boundary: exact facts such as hash equality, schema validity, allowlist membership, required-field coverage, command success, and state-machine behavior are decided by normal code and tests, never by a language-model vote. The k-of-N designs below are shadow-test configurations only until [[PRJ-AI-CCC-DuckLake-v7.2.3-Deferred-Decision-Registry#DD-001 — Committee authority]] is proven for a narrow interpretive class. They are not awaiting blanket ratification.
>
> **INTERIM RULE (binding, load-bearing):** until the human ratifies k-of-N + diversity AND the gate is wired, **every committee stop-condition in this module degrades to checkpoint-and-surface (fail-closed human review). No gate may be skipped.** A gate that cannot run reduces to a human checkpoint; it never reduces to auto-pass.

> [!important] v7.2.3 deterministic-first correction
> CG-01 through CG-09 and CG-11 contain machine-checkable assertions. Their exact assertions MUST be implemented as tests, parsers, schema checks, probe validators, or proof aggregators. Committee reviewers may search for missing cases or challenge interpretation, but their tally cannot turn a failed exact check into PASS and is not required when the exact checks already establish the result. CG-10 remains advisory. Any future committee-cleared interpretive class must first pass DD-001 shadow evaluation and receive Ryan's explicit narrow approval.
>
> **Checkpoint-and-surface, mechanically (FBL2-06):** no CG gate is wired into any `task verify:*` lane in the fixture-complete core, and no committee runner is built into `verify:phase0`. Until ratification, checkpoint-and-surface means exactly: (1) the governing backlog/verification item stays `status: open`, which already blocks its named gate; (2) the runner — or the coder, when no runner exists — writes `analysis/committee/<gate>/checkpoint.json` with `{gate_id, blocking_item, evidence_path, timestamp}`; (3) the pending item is surfaced in diagnosis/readiness output, and that surfacing output IS the "operator digest" named by `REQ-CGATE-04`; (4) a human clears the checkpoint. A gate that cannot run reduces to exactly this checkpoint, never to auto-pass.

## Module Boundary

**Owns:** the committee-gate catalog (CG-01..CG-11) with each gate's instantiable schema, the systemic design rules (`REQ-CGATE-01..05`), the irreducible-family catalog (IR-1..IR-8), the hard-ban boundary for committee authority, the verdict-record convention, and the registry `hitl_gate` → CG/IR coverage table.

**Depends On:** [[PRJ-AI-CCC-DuckLake-v7.2.3-Publish-Control-Kernel]] for kernel state/lock/idempotency semantics that CG-11 conforms to, `restore_proof` authority, and commit-fingerprint reconciliation; [[PRJ-AI-CCC-DuckLake-v7.2.3-Provider-Capability-And-Availability]] for the synthfix pack, SEC availability policy, and DuckLake maintenance sentinels; [[PRJ-AI-CCC-DuckLake-v7.2.3-Manifests-Lineage-And-Fixtures]] for canonical-JSON authority and manifest sealing; [[PRJ-AI-CCC-DuckLake-v7.2.3-Orchestration-And-QDBCTL]] for the Dagu binary provenance/grammar surface; [[PRJ-AI-CCC-DuckLake-v7.2.3-QDB-Agent-Access-And-SQL-Zero]] for the fundamentals resolver; [[PRJ-AI-CCC-DuckLake-v7.2.3-Architecture-Context-And-Bootstrap]] for the runtime-verification backlog machinery, toolchain pins, and repo/path bootstrap; [[PRJ-AI-CCC-DuckLake-v7.2.3-Verification-Benchmarks-Readiness]] for the verification ledger, benchmark-freeze posture, and `verify:phase0` union DoD.

**Read After:** [[PRJ-AI-CCC-DuckLake-v7.2.3-Executive-Contract-And-Authority]], [[PRJ-AI-CCC-DuckLake-v7.2.3-Publish-Control-Kernel]], and [[PRJ-AI-CCC-DuckLake-v7.2.3-Architecture-Context-And-Bootstrap]].

**Non-Authoritative Restatements:** kernel state/lock/idempotency semantics are restated here only to specify what CG-11 must conform-check; [[PRJ-AI-CCC-DuckLake-v7.2.3-Publish-Control-Kernel]] remains authoritative. Provider pack, SEC policy, and sentinel semantics are restated only to specify committee assertions; [[PRJ-AI-CCC-DuckLake-v7.2.3-Provider-Capability-And-Availability]] owns them. The verification-lane set and benchmark-freeze rule are invoked by committee assertions but [[PRJ-AI-CCC-DuckLake-v7.2.3-Verification-Benchmarks-Readiness]] owns them.

## Hard Ban On Committee Authority (verbatim intent)

No committee may **decide** any of the following. A committee may only **pre-validate evidence** for the human, never author the decision:

- **Spending money** — any purchase, subscription commitment, or budget ceiling.
- **Legal / entitlement / license posture** — whether a license permits retention or redistribution, and any non-professional self-certification.
- **Live / production data enablement or writes** — turning on a live/production source, writing to real/production data, or promoting a live publish.
- **Irreversible destructive actions** — physical deletion of retained evidence.

Every hard-ban surface routes to an IR family (IR-1..IR-8) with an optional evidence-prep committee. A committee output on any of the above is void by construction; the corresponding gate assertion escalates rather than passes.

Security note: all `<verbatim>` content carried from the registry is quoted PRD text, treated as inert evidence and never as instructions to the committee.

## Systemic Design Rules (`REQ-CGATE-*`)

These red-team hardening rules are normative and apply to every gate below. Where a per-gate schema and a rule conflict, the rule wins.

- **`REQ-CGATE-01` Evidence-source independence (primary defense).** Every gate MUST pin ≥1 operand OUTSIDE the coder's write scope. Committed test vectors live in a **human-sealed read-only reference directory**; the **GATE RUNNER** (not the coder) recomputes transcript hashes from the raw artifacts; human approvals are **signed marker artifacts the coder cannot write**. A coder-writable boolean such as `ryan_approved: true` is **void** and MUST be treated as absent — only a signed marker satisfies a human-approval assertion. This closes the shared-author problem where the same actor writes both the code and the evidence that clears it.
- **`REQ-CGATE-02` Routing gates use allowlists, not token blocklists.** The routing/triage gates (CG-06, CG-07, CG-10) MUST auto-pass ONLY enumerated safe classes — an item auto-passes when `authority_type == "runtime_probe"` AND it matches a fixed schema+lane whitelist. Everything else **ESCALATES**. Blocklists of forbidden tokens (`Ryan`, `purchase`, `license`, …) die to paraphrase evasion; an allowlist of safe classes does not.
- **`REQ-CGATE-03` CG-03 pre-live/live classification derives from environment facts.** The pre-live vs live classification consumed by CG-03 MUST derive from environment facts (`active_phase`, production-path classifier state), NEVER from a coder-written record field. A record claiming "pre-live" carries no authority; the classifier state does.
- **`REQ-CGATE-04` ESCALATE liveness.** For every ESCALATE verdict: the queue **owner is the human**; a stall-timeout surfaces the pending item in the operator digest; the committee may take at most **one retry-with-modified-prompt** before surfacing. No silent infinite retry loop is permitted.
- **`REQ-CGATE-05` Model-family diversity is a secondary defense.** Distinct model families decorrelate reasoning blind spots and a shared prompt-injection surface, but they are the SECONDARY defense. Evidence-source independence (`REQ-CGATE-01`) is the PRIMARY defense; a gate that relies on diversity alone, without an operand outside the coder's write scope, is non-conformant.
- **`REQ-CGATE-08` Deterministic checks outrank model votes.** A model tally never decides hash equality, schema validity, required-field presence, set coverage, allowlist membership, command exit status, guardrail absence, or state-machine conformance when an exact test can decide it. The committee may propose a missing test or explain a failure; the exact check clears or blocks the gate. Backed by `test_deterministic_fact_cannot_be_cleared_by_model_vote`.
- **`REQ-CGATE-09` Committee authority follows DD-001.** No committee output becomes gate-clearing authority until the exact model, prompt, evidence slice, runner, labeled cases, observed error rates, escalation rate, malformed-output behavior, and unavailable-model behavior have been recorded in shadow mode and Ryan approves that named interpretive class. A component change expires the approval and returns it to shadow-only.

## Verdict-Record Convention (all gates)

Every committee writes one verdict record under `analysis/committee/<gate>/`:

```
{gate_id, verdict: PASS | FAIL | ESCALATE, k_agreed, total,
 per_reviewer_rationale_path, evidence_path, timestamp}
```

Each reviewer receives ONLY its assigned evidence slice plus the parsed index — no other reviewer's output, no shared scratchpad. Prompts differ per lens so a shared prompt-injection or shared blind spot cannot correlate all reviewers.

## Typed Checkpoint Records (`REQ-CGATE-06/07`, v7.2.3)

- `REQ-CGATE-06`: every `analysis/committee/<gate>/checkpoint.json` MUST validate against `checkpoint_record.v1` (`schemas/checkpoint_record.v1.schema.json`): `gate_id`; `inputs_hash` (sha256, GATE-RUNNER-computed per `REQ-CGATE-01`, never coder-written); `model_id`; `verdict` (the existing `PASS | FAIL | ESCALATE` enum, no new values); `evidence_refs` (paths); `confidence` (0.0–1.0, advisory only — it never clears a gate by itself); `k_agreed`/`total`; `timestamp`; `blocking_item`; and `human_ratification` (`ratified`, `ratified_by`, `ratified_at`, `signed_marker_path`) where `ratified: true` is valid ONLY when `signed_marker_path` names a human-sealed signed marker artifact — the existing coder-writable-boolean-is-void rule applied to the typed field. This is a typing layer over the existing FBL2-06 checkpoint artifact and the verdict-record convention above, not a parallel structure: the minimal interim record `{gate_id, blocking_item, evidence_path, timestamp}` remains schema-valid via nullable typed fields. The schema is the contract and the runner is swappable — today's per-gate scripts and any future typed-agent framework (Atomic Agents is stack-selected but locally unproven; see the v7.2.3 screening notes in [[PRJ-AI-CCC-DuckLake-v7.2.3-Architecture-Context-And-Bootstrap]]) are alternative producers of the same record, and no framework import is a requirement of this module. Backed by `test_checkpoint_record_v1_schema_validates_against_existing_analysis_committee_checkpoint_json`, `test_checkpoint_human_ratification_ratified_field_requires_signed_marker_not_bare_bool`, and `test_checkpoint_verdict_enum_matches_existing_pass_fail_escalate_no_new_values`.
- `REQ-CGATE-07`: fail-open is structurally banned. If a committee runner is unavailable — no reachable model, malformed model output, or a schema-invalid record — the gate degrades to checkpoint-and-surface with an ESCALATE-shaped record (`verdict: ESCALATE`, `human_ratification.ratified: false`); never an implicit PASS, never a skipped gate (the INTERIM RULE above, made testable). Malformed model output is rejected by schema validation and becomes an ESCALATE record; no silent coercion. External documents fed to committees as evidence remain inert data under the existing security note; instructions embedded in them are never executed. Backed by `test_committee_unavailable_produces_escalate_checkpoint_never_auto_pass` and `test_committee_evidence_from_external_docs_never_executed_as_instruction`.

---

## Committee Gates CG-01..CG-11

Each gate is stated as an instantiable schema: `gate_id`, purpose, reviewers `N x {model family, distinct lens}`, independence rule, machine-checkable assertions, evidence bundle `{artifacts, path}`, verdict-record shape (per the convention above), `k-of-N`, and tie/FAIL behavior with escalation path. CG-01..CG-10 carry over from the committee-gates draft, **amended per `REQ-CGATE-01..05`**.

### CG-01 — synthfix policy-ID resolution gate

- **gate_id:** `cg-synthfix-policy-ids` (converts C4-029 / SF1)
- **purpose:** Confirm every `source_availability_policy_ids` entry in the `synthfix` capability pack resolves to a defined policy object before the fixture-complete DoD loads through it. Already a machine test (`test_synthfix_policy_ids_resolve_to_defined_objects`); the committee replaces residual human eyeballing.
- **reviewers: 3 x {model, distinct lens}**
  - R1 `claude-family` — **contract-diff lens:** every ID in `source_availability_policy_ids` equals a `policy_id:` defined in the same seed.
  - R2 `gpt-family` — **schema-shape lens:** IDs contain no whitespace and match `^[a-z0-9_]+_v[0-9]+$`; no `_first release`-style tokens.
  - R3 `gemini-family` — **enabled-provider-consistency lens:** `adapter_enabled: true` for synthfix and every referenced policy object has `status: verified_synthetic` and `exact_timing_fixtures_enabled: true`.
- **independence rule:** three model families; each reviewer sees only the pack + parsed policy-object index; per-lens prompts. `REQ-CGATE-01`: the parsed policy-object index is recomputed by the gate runner from the sealed pack, not read from a coder-emitted boolean.
- **assertions:**
  1. `set(pack.source_availability_policy_ids) ⊆ {p.policy_id for p in policies}`.
  2. every referenced ID matches `^[a-z0-9_]+_v[0-9]+$` with no space char.
  3. `pack.adapter_enabled == true` and each referenced policy `status == "verified_synthetic"`.
  4. count of referenced IDs `== pack cardinality` (currently 3: equity_close, sec_accepted_at, fred_vintage) — exact-cardinality check; re-audit against the shipped pack at wiring time (the assertion tracks the pack, not this draft).
- **evidence bundle:** `{synthfix capability pack YAML, gate-runner-parsed policy-object index JSON}` at `docs/runtime-verification/synthfix_policy_resolution.json`.
- **verdict record:** standard, `evidence_path: docs/runtime-verification/synthfix_policy_resolution.json`, `per_reviewer_rationale_path: analysis/committee/cg-01/*.json`.
- **k-of-N:** **3-of-3** (only enabled provider; unanimity).
- **tie/FAIL:** any dissent → checkpoint-and-surface the specific failing assertion; one retry-with-modified-prompt on a reviewer parse error (not a content mismatch); persistent 1+ FAIL → rollback-to the synthfix-pack-seal node.

### CG-02 — canonical-JSON authority conformance gate (JCS path only)

- **gate_id:** `cg-canonical-json-jcs` (pre-validates C4-054 / C6-282 — JCS-conformant path only; the non-JCS fallback is IRREDUCIBLE, see IR-7)
- **purpose:** When an RFC 8785 / JCS authority is a candidate, confirm it passes the canonical-JSON test vectors so `manifest_seal` may proceed. Removes the human from the *pass* path; the *deviation* (non-JCS profile) stays human-only.
- **reviewers: 3 x {model, distinct lens}**
  - R1 `claude-family` — **spec-conformance lens:** output hashes match the published JCS/RFC 8785 vectors bit-for-bit.
  - R2 `gpt-family` — **determinism lens:** re-running the serializer on shuffled key order / duplicate float encodings yields identical bytes.
  - R3 `gemini-family` — **fail-closed lens:** on any vector miss the pipeline halts before `manifest_seal` (no ad-hoc `json.dumps` fallback path is reachable).
- **independence rule:** distinct families over three orthogonal evidence sources. `REQ-CGATE-01`: **the published JCS/RFC 8785 vectors are the human-sealed read-only reference file** — R1 checks against ground truth outside any reviewer and outside the coder's write scope; R2 fuzzes inputs it generates itself; R3 reads the call graph.
- **assertions:**
  1. for each vector v: `sha256(serialize(v.input)) == v.expected_hash`.
  2. `serialize(shuffle_keys(x)) == serialize(x)` for all sampled x (byte-identical).
  3. static check: no code path reaches `manifest_seal` when `canonical_json.json.status != "resolved"`.
  4. `observed_output_hash` present and covers the full normalized transcript (stdout+stderr+exit+tool versions) per BT1.
- **evidence bundle:** `{vector run transcript, serializer output hashes, call-graph slice for manifest_seal}` at `docs/runtime-verification/canonical_json.json`.
- **verdict record:** standard, `evidence_path: docs/runtime-verification/canonical_json.json`, `per_reviewer_rationale_path: analysis/committee/cg-02/*`.
- **k-of-N:** **3-of-3** (manifest integrity is safety-bearing; any doubt escalates).
- **tie/FAIL:** any FAIL or "no JCS authority passes" → checkpoint-and-surface to **IR-7** (human decides non-JCS profile); do not retry-loop indefinitely; one retry-with-modified-prompt for reviewer parse errors, else escalate.

### CG-03 — DuckLake API sentinel-binding gate

- **gate_id:** `cg-ducklake-api-binding` (converts C4-055 `ducklake_maintenance_fn_names`, C4-056 `ducklake_commit_fingerprint_discovery`, C4-057 `ducklake_attach_relocated_root`)
- **purpose:** Promote recorded runtime-probe artifacts (`task verify:ducklake-api`, `task restore:test`) that resolve DuckLake wrapper bindings and restore/commit-fingerprint behavior to `resolved` in place of a human read, provided each probe transcript carries an `observed_output_hash` the gate runner can reproduce. Resolution is authority-evidenced, not a money/legal/data decision.
- **reviewers: 4 x {model, distinct lens}**
  - R1 `claude-family` — **evidence-completeness lens:** each record has `authority_type: runtime_probe`, a `command`, an `output_artifact`, and an `observed_output_hash`.
  - R2 `gpt-family` — **gate-rule lens:** for commit-fingerprint, `reconciliation_status == "proven"` AND `discovery_route != null` before any pre-live/live claim; `returned_snapshot_id` proven only with post-crash recoverability evidence.
  - R3 `gemini-family` — **fallback-safety lens:** if bindings/restore cannot resolve on scratch, the record shows the declared pivot (manifest-authoritative restore / `quarantine_fallback`) and NO original-root catalog pointer is used. **AMENDED (CR-003 v2):** `quarantine_fallback` is valid ONLY when the probe artifact shows **all THREE named discovery routes attempted and failed** (`commit_extra_info`, `row_carried_fingerprint`, `returned_snapshot_id`; `null` is the fallback sentinel, not an attemptable route), each with its own `observed_output_hash` transcript. A defaulted or hard-coded fallback FAILS.
  - R4 `claude-family (different prompt/seed)` — **transcript-hash lens (veto):** the **gate runner** recomputes `sha256(normalized(transcript))` from the raw artifact and confirms it equals `observed_output_hash`. Structurally independent of the other three's reasoning.
- **independence rule:** 3 families + a hash-recomputation reviewer whose verdict depends only on the raw transcript file. `REQ-CGATE-01`: the hash is recomputed by the gate runner, not read from the coder-written record. `REQ-CGATE-03`: the pre-live/live classification consumed by R2 derives from `active_phase` + production-path classifier state, **never** from a coder-written record field.
- **assertions:**
  1. gate-runner-recomputed `sha256(normalized(transcript)) == record.observed_output_hash`.
  2. `commit_fingerprint.reconciliation_status in {"proven","quarantine_fallback"}`; pre-live claim ⇒ `== "proven" and discovery_route != null` (pre-live classification from environment facts per `REQ-CGATE-03`).
  3. `quarantine_fallback` ⇒ transcripts present for all three named routes attempted-and-failed, each hash-verified.
  4. `attach_relocated_root`: if ATTACH/OVERRIDE_DATA_PATH unproven ⇒ restore config `== manifest_authoritative` and no original-root pointer in the restore plan.
  5. every Phase-0 binding sentinel in the maintenance wrapper is bound or explicitly deferred; no unbound sentinel survives a sealed manifest.
- **evidence bundle:** `{docs/runtime-verification/ducklake_api.json, ducklake_commit_fingerprint_discovery.json, ducklake_attach.json, raw probe transcripts}`.
- **verdict record:** standard, `evidence_path: docs/runtime-verification/ducklake_api.json`, `per_reviewer_rationale_path: analysis/committee/cg-03/*`.
- **k-of-N:** **3-of-4** to PASS fixture-core resolution; any pre-live/live promotion requires **4-of-4** AND remains fenced by IR-3 (no live enablement without human). R4 (hash) has **veto**: hash mismatch → FAIL regardless of tally.
- **tie/FAIL:** hash mismatch → rollback-to the probe-execution node (re-run `task verify:ducklake-api`). Content dissent (2-2) → checkpoint-and-surface. Fallback-safety FAIL → force the declared `kill_or_pivot` (quarantine / manifest-authoritative restore).

### CG-04 — Dagu binary provenance & grammar gate (offline verification, not fetch/purchase)

- **gate_id:** `cg-dagu-binary-provenance` (pre-validates C4-058 `dagu_binary_version_url_sha_license_source`; also serves the C4-060 Dagu row and C4-062 Dagu grammar rows)
- **purpose:** Confirm the pinned Dagu binary's version/URL/SHA-256/license-variant record is internally consistent and its YAML grammar validates against the pinned binary (one `dagu validate`-passing parent+child template). License *acceptability* is human (IR-5); this committee only verifies the evidence fields are present, self-consistent, hash-matched, and that the grammar probe passed.
- **reviewers: 3 x {model, distinct lens}**
  - R1 `claude-family` — **provenance lens:** `serving_org`, `release_url`, `source_relation`, `license_variant`, `dagu_version`, `sha256sum` all present and the URL host is one of the two candidate origins named in the record.
  - R2 `gpt-family` — **hash-integrity lens (veto):** the gate runner recomputes the hash of the offline-fetched binary and confirms it equals the recorded `sha256`; fail-closed if the binary could not be hash-verified offline.
  - R3 `gemini-family` — **grammar-conformance lens:** the committed parent+child template passes `dagu validate` under the pinned binary; child invocation / shell-argv / worker placement / schema-subcommand presence match the probed grammar, not memory.
- **independence rule:** three families over three non-overlapping evidence types (field-presence, hash comparison, validator exit code). `REQ-CGATE-01`: R2's hash is recomputed by the gate runner against the fetched-binary artifact, not read from the record.
- **assertions:**
  1. all provenance fields non-empty and `release_url.host ∈ {github.com/dagucloud/dagu, github.com/dagu-org/dagu}` (origin stays a two-candidate set until this check binds it).
  2. gate-runner `sha256(pinned_binary_bytes) == record.sha256`; `fallback_status == fail_closed` honored if fetch/hash fails.
  3. `dagu validate <parent+child template>` exit code `== 0` under the pinned binary.
  4. `verify:qdbctl-grammar` / `guard:vendored-schema` allowlist is hash-bound (no forbidden token leaks from generated schema into project-authored DAGs).
- **evidence bundle:** `{docs/runtime-verification/dagu_binary.json, offline fetch+sha transcript, dagu validate output, template files}`.
- **verdict record:** standard, `evidence_path: docs/runtime-verification/dagu_binary.json`, `per_reviewer_rationale_path: analysis/committee/cg-04/*`.
- **k-of-N:** **3-of-3** (bootstrap trust anchor). R2 (hash) has **veto**.
- **tie/FAIL:** hash/fetch fail → fail-closed on `verify:phase0`; do NOT substitute an unpinned binary (rollback-to the pin-resolution node). Grammar FAIL → checkpoint-and-surface with the validator diff. License *variant acceptability* is never decided here → route to **IR-5**.

### CG-05 — SEC availability-clock evidence gate (PASS = stay-conservative; live-enable stays human)

- **gate_id:** `cg-sec-availability-clock` (pre-validates C4-059 `sec_accepted_public_availability_timing`)
- **purpose:** The safe outcome — keep conservative date-only `known_at`, stay fixture-only for SEC — is deterministic, non-money, non-live and can be a committee decision. The unsafe outcome — encoding an exact intraday dissemination clock and flipping SEC live — requires human-supplied cited policy evidence and touches live PIT trust, so it is fenced to IR-3. The committee verifies that, absent cited evidence, the code holds the conservative clock and does NOT encode an intraday timestamp.
- **reviewers: 3 x {model, distinct lens}**
  - R1 `claude-family` — **leakage-hunter lens:** no SEC PIT query uses `accepted_at`/`filed_at` as the availability clock; `known_at` binds to `source_available_at` (conservative date-only), not `accepted_at`.
  - R2 `gpt-family` — **evidence-provenance lens:** if `source_availability_policies/sec.yaml` is absent or lacks cited policy evidence, `adapter_enabled` stays false and status stays `fixture_only`.
  - R3 `gemini-family` — **test-binding lens:** `test_sec_adapter_does_not_use_filed_at_as_availability_clock` and `test_sec_live_accepted_at_only_policy_is_disabled_until_public_availability_verified` both pass.
- **independence rule:** distinct families over query semantics / policy-artifact provenance / test-suite result. `REQ-CGATE-01`: the cited policy artifact is a human-supplied signed evidence file; its absence cannot be simulated by a coder-written flag.
- **assertions:**
  1. `sec.pack.adapter_enabled == false` UNLESS a human-cited `source_availability_policies/sec.yaml` with evidence exists (that flip is IR-3, not a committee output).
  2. static + test check: no intraday SEC dissemination timestamp is hard-coded when evidence is absent.
  3. `known_at` for SEC facts `==` conservative date-only proxy per `source_availability_sec_accepted_at_v1`.
- **evidence bundle:** `{sec capability pack, source_availability_policies/sec.yaml (if any), SEC PIT test transcript}` at `docs/runtime-verification/sec_availability.json`.
- **verdict record:** standard, `evidence_path: docs/runtime-verification/sec_availability.json`, `per_reviewer_rationale_path: analysis/committee/cg-05/*`.
- **k-of-N:** **3-of-3** to PASS the conservative-hold outcome. The committee can ONLY confirm the conservative/fixture-only posture; it can NEVER emit "enable SEC live."
- **tie/FAIL:** any dissent that an intraday clock leaked in → rollback-to the SEC-adapter node. Request to go live → checkpoint-and-surface to **IR-3**.

### CG-06 — Phase-0 backlog-item auto-resolution gate (non-safety-bearing runtime-probe items)

- **gate_id:** `cg-backlog-autoresolve` (converts the *machine-resolvable* subset of C4-053 / C6-283 / C1-064; the safety-bearing + supplied-artifact subset stays under IR-2/IR-3/IR-6/IR-8)
- **purpose:** For **runtime-probe** items that are NOT money/legal/live-data (market-calendar library selection, canonical-JSON-adjacent tooling, NAS-latency measurements recorded as facts), a committee stands in for the human read of the reproducible probe evidence. The `kill_or_pivot` field (C1-064) is a record structure, not an approval — the committee validates it is populated, never decides its content when it names a human.
- **reviewers: 3 x {model, distinct lens}**
  - R1 `claude-family` — **authority-completeness lens:** item has `authority_type`, `command`, `output_artifact`, `observed_output_hash`, `fallback_status`, and a `kill_or_pivot` sentence.
  - R2 `gpt-family` — **hash-recompute lens:** gate-runner `sha256(normalized(transcript)) == observed_output_hash`.
  - R3 `gemini-family` — **allowlist router lens:** the item auto-passes ONLY if it matches the fixed safe-class allowlist (`authority_type == "runtime_probe"` matching the schema+lane whitelist); everything else `ESCALATE` to the matching IR.
- **independence rule:** three families; R3 is a structural router whose FAIL is a hard escalate, independent of R1/R2's evidence reasoning. `REQ-CGATE-02`: R3 uses an **allowlist of enumerated safe classes**, NOT a blocklist of human-authority tokens — paraphrase evasion dies with the blocklist. `REQ-CGATE-01`: R2's hash is gate-runner-recomputed.
- **assertions:**
  1. required schema fields present (per `schemas/runtime_verification.schema.json`).
  2. gate-runner hash matches transcript.
  3. `authority_type == "runtime_probe"` AND the item matches the safe-class schema+lane allowlist (else ESCALATE).
  4. if `blocks` names a gate, resolving must satisfy that gate's own predicate.
- **evidence bundle:** `{the backlog record, its transcript, the resolved output artifact}` under `docs/runtime-verification/<item>.json`.
- **verdict record:** standard, `evidence_path: docs/runtime-verification/<item>.json`, `per_reviewer_rationale_path: analysis/committee/cg-06/<item>/*`.
- **k-of-N:** **3-of-3** to auto-resolve; R3 ESCALATE (any non-allowlisted item) is an absolute override to ESCALATE.
- **tie/FAIL:** hash mismatch → rollback-to probe-execution. Missing field → one retry-with-modified-prompt to the coder to complete the record, then re-judge. Non-allowlisted item detected → checkpoint-and-surface to the matching IR.

### CG-07 — Verification-ledger completeness gate (open-assumptions / core / contract-closure tables)

- **gate_id:** `cg-verification-ledger-complete` (converts the *bookkeeping* function of C4-061, C4-062, C4-063 — "did every open item land in the machine ledger with a lane"; the *content decisions* inside them route to their specific IR/CG)
- **purpose:** Whether every table row is represented in `implementation-index.seed.csv` / `backlog.seed.yaml` with a verification lane and a blocking status is pure completeness bookkeeping. The committee does NOT decide any row's outcome (purchases, licenses, live enablement stay IR); it decides only that nothing fell out of the ledger.
- **reviewers: 3 x {model, distinct lens}**
  - R1 `claude-family` — **coverage lens:** every table row maps to a seed record (by item name / REQ id) in `implementation-index.seed.csv` or `backlog.seed.yaml`.
  - R2 `gpt-family` — **lane-validity lens:** each mapped record names a real verification lane (`verify:phase0`, `verify:source-adapter-gate`, `verify:ducklake-api`, `smoke:nas`, `verify:deps:candidates`) and a blocking/non-blocking status.
  - R3 `gemini-family` — **hard-ban allowlist router lens:** a row is `committee_lane`-eligible ONLY if it matches the safe-class allowlist; any row implying purchase/license/live (money/legal/live class) is NOT allowlisted → it must carry an IR pointer, not a committee-PASS lane.
- **independence rule:** three families; R3 enforces the hard-ban boundary independently of coverage/lane reviewers. `REQ-CGATE-02`: R3 routes by **allowlist membership**, not token blocklist — a mis-tagged money/legal row fails to match the safe-class allowlist and escalates even if its tokens were paraphrased away.
- **assertions:**
  1. `∀ row ∈ (C4-061 ∪ C4-062 ∪ C4-063): ∃ seed_record with matching key`.
  2. each `seed_record.command` / `Command gate` ∈ the known-lane set; `Blocking?` ∈ {yes,no}.
  3. rows not matching the safe-class allowlist are flagged `human_required=true` (routed, not PASSed).
  4. CI rule honored: a Phase-0/0.5 closure deliverable with no blocking row = FAIL.
- **evidence bundle:** `{docs/implementation-index.seed.csv, docs/runtime-verification/backlog.seed.yaml, the three source tables as parsed JSON}` at `analysis/committee/cg-07/ledger_coverage.json`.
- **verdict record:** standard, `evidence_path: analysis/committee/cg-07/ledger_coverage.json`, `per_reviewer_rationale_path: analysis/committee/cg-07/*`.
- **k-of-N:** **2-of-3** to PASS (completeness is lower-stakes; a single false-negative is caught by CI's own blocking-row rule). R3's non-allowlisted routing forces those rows to route, regardless of tally.
- **tie/FAIL:** missing coverage → checkpoint-and-surface the unmapped rows to the coder (retry after seed regeneration). Non-allowlisted (money/legal/live) row → route to the relevant IR.

### CG-08 — Fundamentals symbol-resolution design-conformance gate

- **gate_id:** `cg-fundamentals-symbol-resolution` (converts C4-083 — a locked design-decision callout, not a human approval)
- **purpose:** C4-083 restates REQ-QDB-07's PIT-safe resolver rule (valid-time as of each fact's `fiscal_period_end`, knowledge-time bounded by `known_at`, ambiguity refuses, no `as_of_valid_date` param). It is a design lock, so verifying the implementation matches it is a code-conformance check an ensemble can own.
- **reviewers: 3 x {model, distinct lens}**
  - R1 `claude-family` — **clock-binding lens:** resolver uses `fiscal_period_end` for valid-time (fallback query `period_end`), `known_at` for knowledge-time.
  - R2 `gpt-family` — **refusal lens:** ambiguous alias → raises (no cross-map to a different entity); property-tested with `hypothesis` per REQ-PIT-TEST.
  - R3 `gemini-family` — **surface lens:** no `as_of_valid_date` parameter exists on `get_fundamentals_asof`; the resolver is a single shared primitive (one impl, two callers per REQ-IFACE-11).
- **independence rule:** three families over three code surfaces (clock logic, error path, public signature). No shared rationale.
- **assertions:**
  1. valid-time source `== fiscal_period_end` with fallback `period_end`; knowledge-time bound `== known_at`.
  2. `hypothesis` property test: for generated ambiguous alias sets, the call raises rather than resolving.
  3. AST check: `get_fundamentals_asof` signature has no `as_of_valid_date`; exactly one resolver primitive referenced by both `qdb` and `resolve_entities_asof`.
- **evidence bundle:** `{resolver source, get_fundamentals_asof signature AST, hypothesis test transcript}` at `analysis/committee/cg-08/resolver_conformance.json`.
- **verdict record:** standard, `evidence_path: analysis/committee/cg-08/resolver_conformance.json`, `per_reviewer_rationale_path: analysis/committee/cg-08/*`.
- **k-of-N:** **3-of-3** (PIT-leakage risk; unanimity).
- **tie/FAIL:** any dissent → checkpoint-and-surface the leaking path; retry-with-modified-prompt only for parse errors; else rollback-to the resolver node.

### CG-09 — Toolchain-substitution incompatibility-evidence pre-validation (PASS = pin held; substitution stays human)

- **gate_id:** `cg-toolchain-substitution-evidence` (pre-validates C6-281; the *approval* to substitute is IRREDUCIBLE-adjacent)
- **purpose:** C6-281 forbids any generic "type checker" substitution unless `task verify:toolchain` records a human-approved incompatibility/pivot. The committee cannot grant the approval; it CAN pre-validate that a claimed incompatibility is real and reproducible, handing the human a verified report. The default PASS outcome — pinned toolchain (uv/task/Ruff/Pyright/pytest) stands up cleanly — needs no human and is fully a committee decision.
- **reviewers: 3 x {model, distinct lens}**
  - R1 `claude-family` — **pin-integrity lens:** `uv`, `task`, Ruff, Pyright, pytest all install from the lock under the pinned Python; `docs/version-pins.md` present.
  - R2 `gpt-family` — **incompatibility-reproducibility lens:** IF a substitution is claimed, the recorded `verify:toolchain` transcript reproduces the failure deterministically (with gate-runner-recomputed `observed_output_hash`).
  - R3 `gemini-family` — **human-gate lens (signed-marker override):** confirm the substitution is NOT applied unless a **signed human-approval marker artifact** (not a coder-writable boolean) authorizes it; absent it, the pinned tool must remain.
- **independence rule:** three families; R3 enforces the human interlock structurally so R1/R2 cannot together auto-substitute. `REQ-CGATE-01` (amended): a coder-writable `ryan_approved: true` boolean is **void** — only a signed marker the coder cannot write satisfies R3.
- **assertions:**
  1. `verify:toolchain` green with the pinned tools (default PASS path).
  2. substitution claim ⇒ reproducible failing transcript + gate-runner-recomputed hash.
  3. no substitution active unless a signed human-approval marker is present (else ESCALATE).
- **evidence bundle:** `{docs/version-pins.md, verify:toolchain transcript, uv.lock, signed-marker path (if any)}` at `docs/runtime-verification/toolchain.json`.
- **verdict record:** standard, `evidence_path: docs/runtime-verification/toolchain.json`, `per_reviewer_rationale_path: analysis/committee/cg-09/*`.
- **k-of-N:** **3-of-3** for the pinned-toolchain PASS; any substitution request → ESCALATE (R3 override).
- **tie/FAIL:** pin fails → rollback-to the toolchain-bootstrap node. Substitution requested → checkpoint-and-surface a verified incompatibility report to the human (a signed-marker approval is the human step).

### CG-10 — Non-code planning open-question triage committee (recommendation pre-processor; explicitly advisory under the v7.2.3 posture)

- **gate_id:** `cg-openq-triage` (pre-validates C7-085…C7-094 — the ten audit open questions)
- **purpose:** Most of the ten contain a decidable technical sub-question whose recommendation a committee can prepare (OQ3 calendar-authority model, OQ6 contract-tooling scope, OQ7 restic-first-drill scope, OQ9 modeling-consumption format), even though the final call is the human's. Two are hard-banned in content (OQ1 license posture → IR-5; OQ2 first-wave source plan incl. paid-alternative evaluation → IR-6). The committee produces a ranked, evidence-backed recommendation per question and a machine tag of committee-decidable vs human-only, shrinking the human queue.
- **reviewers: 3 x {model, distinct lens}**
  - R1 `claude-family` — **technical-tradeoff lens:** produce a recommended answer with cited PRD constraints for the decidable sub-question.
  - R2 `gpt-family` — **hard-ban allowlist classifier lens:** tag each OQ `committee_recommendable` ONLY if it matches the safe-class allowlist; questions in the money/legal/live/host-pin classes (OQ1, OQ2, OQ5 fail-closed-policy ratification, OQ8 pin-on-host) are `human_required`.
  - R3 `gemini-family` — **consistency lens:** the recommendation does not contradict any binding `REQ-*` (non-goals, raw-retention invariant, no-live-without-evidence).
- **independence rule:** three families; R2 is a classifier that fences money/legal/live questions from any recommendation being treated as a decision. `REQ-CGATE-02`: R2 uses the **safe-class allowlist**, not a token blocklist.
- **assertions:**
  1. each OQ tagged `human_required=true` where content is NOT in the safe-class allowlist (license, purchase, paid-source eval, live enablement, host-specific pin).
  2. each `committee_recommendable` OQ has a recommendation citing ≥1 binding REQ.
  3. no recommendation contradicts a `REQ-*` bullet (checked against the parsed requirement set).
- **evidence bundle:** `{ten OQ records, recommendation-per-OQ, human_required tag map}` at `analysis/committee/cg-10/openq_triage.json`.
- **verdict record:** standard, `verdict: PASS(=triaged) | ESCALATE`, `evidence_path: analysis/committee/cg-10/openq_triage.json`, `per_reviewer_rationale_path: analysis/committee/cg-10/*`.
- **k-of-N:** **2-of-3** to publish the triage (advisory artifact); R2's `human_required` tag is authoritative and non-overridable — those questions ALWAYS surface.
- **tie/FAIL:** contradiction with a REQ → checkpoint-and-surface. This committee never *decides* an OQ; it only pre-sorts and recommends. Human-required OQs → IR-4 / IR-5 / IR-6 and surfaced as-is.

### CG-11 — Kernel lock/state conformance gate (NEW)

- **gate_id:** `cg-kernel-lock-conformance` (converts CR-017 + the R10 lock/idempotency test cluster; fills the R09/R10 coverage hole)
- **purpose:** Conform-check that the kernel state machine, locks, and idempotency implementation match the prose-only rules that natural code idioms silently bypass (a uniform retry decorator, a stateful in-memory `.current_state`, `ON CONFLICT` on the wrong constraint, a mutable `delete_eligible` flag). Each idiom passes existing tests while violating an invariant; this gate asserts the discriminating tests exist, are green, and their fixtures contain the discriminating cases.
- **reviewers: 4 x {model, distinct lens}**
  - R1 `claude-family` — **lock-semantics lens:** `pg_advisory_xact_lock_shared` used on the wide `(dataset,'*')` key (not exclusive-on-wide, not nothing-on-wide); the lock argument equals the stored advisory key across every call site (cross-call-site key identity).
  - R2 `gpt-family` — **statelessness lens:** transition authority re-reads current state from the DB on every transition decision; there is no authoritative cached in-memory `.current_state` acting as a second source of truth.
  - R3 `gemini-family` — **idempotency lens:** no `@retry`/retry decorator on any side-effecting transition function; `ON CONFLICT` targets the correct constraint (PK + UNIQUE both on `side_effect_intent`); `cleanup_eligibility.delete_eligible` is not directly mutable (trigger/CHECK/revoked-UPDATE, never a manual flag).
  - R4 `claude-family (different prompt/seed)` — **hash-recompute lens (veto):** the gate runner recomputes the hash of the `verify:phase0` transcript from the raw artifact and confirms the referenced test results are the ones judged.
- **independence rule:** 3 reasoning families over three orthogonal kernel surfaces (lock, state authority, idempotency) + a hash-recompute reviewer structurally independent of the other three. `REQ-CGATE-01`: R4's hash is gate-runner-recomputed from the raw transcript, not read from a coder-written field.
- **assertions:**
  1. the **13 kernel review-fbl01 tests** are present AND green in the `verify:phase0` transcript — the explicit enumerated list (the R10-ruling lock/lease/idempotency cluster plus CR-017's transition-authority test; these are the 13 kernel entries of the Verification module's review-fbl01 Review-Derived index): `test_discovery_route_probe_transcript_shows_all_routes_attempted`, `test_prelive_requires_at_least_one_proven_publish_end_to_end`, `test_candidate_drill_answers_from_restored_root_proven_by_sentinel_divergence`, `test_row_level_source_available_at_gates_visibility_not_batch_min`, `test_catalog_dump_excludes_started_backup_marker_row`, `test_transition_authority_reads_current_state_from_db_not_cached_object`, `test_serialization_failure_after_ducklake_commit_does_not_retry_commit`, `test_intent_retry_with_different_fingerprint_same_scope_reconciles_gracefully_not_crash`, `test_lease_recheck_shares_finalizer_serializable_transaction`, `test_two_partition_writers_same_dataset_run_concurrently`, `test_lock_argument_equals_stored_advisory_key_across_call_sites`, `test_delete_eligible_cannot_be_set_by_direct_update`, `test_inlined_rows_flushed_before_backup_survive_restore`.
  2. each named test's **fixture contains the discriminating case** (the natural wrong implementation must fail it), not merely a homogeneous fixture that any implementation passes.
  3. static: a `pg_advisory_xact_lock_shared` call is present on the wide key; no `@retry` on any side-effecting transition function; `delete_eligible` has no direct-UPDATE path.
- **evidence bundle:** `{verify:phase0 transcript, kernel test fixtures, static-analysis slice for locks + retry + delete_eligible}` at `analysis/committee/cg-11/lock_conformance.json`.
- **verdict record:** standard, `evidence_path: analysis/committee/cg-11/lock_conformance.json`, `per_reviewer_rationale_path: analysis/committee/cg-11/*`.
- **k-of-N:** **3-of-4** with R4 hash **veto** (hash mismatch → FAIL regardless of tally).
- **tie/FAIL:** dissent → checkpoint-and-surface the failing lens; parse errors → one retry-with-modified-prompt; else **rollback to the lock/kernel build node (R10)**.

---

## Irreducible Human-In-The-Loop Families IR-1..IR-8

A committee may PRE-VALIDATE evidence for each family, never decide. The optional pre-validation ensemble is noted per family; its output is evidence handed to the human, not a verdict.

### IR-1 — Repo path/name confirmation — IRREDUCIBLE
- **Records:** C1-062 (`REQ-CFG-01`), C6-280 (`repo_name_confirmation`).
- **Why:** where the implementation repo lives is a human ownership/environment choice ("unless Ryan explicitly chooses another path") with no machine ground truth — a committee has nothing to verify against except the human's intent.
- **Pre-validation committee (optional):** a 2-reviewer ensemble confirms the chosen path is outside the vault root and writable and that README records it, surfacing a ready-to-confirm default. It cannot pick the path.

### IR-2 — Benchmark-threshold freeze — IRREDUCIBLE
- **Records:** C1-063 (`bench-freeze-human-only`), C6-279 (`req_bench_freeze_human_only`).
- **Why:** the PRD is explicit and repeated — "only a human marks it frozen; the agent never auto-freezes." Freezing a threshold is the human accepting a benchmark contract; auto-freezing is expressly forbidden (`REQ-BENCH-FREEZE` + `REQ-AUTH-01`).
- **Pre-validation committee:** validates that the provisional baseline was computed correctly (first-run, real data, `observed_output_hash`, class match) and presents a "ready-to-freeze" report — the freeze flip stays human.

### IR-3 — Live-data escape / live-source enablement / live publish — IRREDUCIBLE
- **Records:** C5-100 (production-path classifier + `--i-understand-this-touches-real-data` + `QDB_ENABLE_LIVE_SOURCES`), C5-102 (publish live-flag escape). Also fences the "enable" side of CG-05 (SEC) and the live side of CG-03.
- **Why:** touching real/production data and promoting a live publish are the canonical hard-ban. The dual-gated escape (env toggle AND explicit CLI flag) is intentionally a human act. No committee may assert the flag or enable a live adapter.
- **Pre-validation committee:** pre-flights the classifier (leakage-hunter + realpath-diff lenses) to confirm that WITHOUT the escape every production/`/Volumes/` path and live-catalog DSN refuses, and that the escape is the ONLY code path to real data — a verified refusal-coverage report before the human considers the flag.

### IR-4 — Deletion approval (`qdbctl cleanup --approve <hash>`) — IRREDUCIBLE
- **Records:** C5-101 (`cleanup-approve-hash-flag`).
- **Why:** physical deletion of files is an irreversible destructive action; the `<hash>` approval binds a human to a specific reviewed cleanup set. `--dry-run` is the safe default. A committee approving deletions violates the irreversible-destructive-action ban.
- **Pre-validation committee:** validates the dry-run artifact (backup exists, no retained raw/bronze/silver evidence in the delete set per the raw-retention invariant, hash matches the dry-run plan) so the human approves a machine-verified-safe set — the `--approve <hash>` act stays human.

### IR-5 — License/entitlement posture — IRREDUCIBLE
- **Records:** C7-085 (OQ1 license posture), and the license terms in C7-123 (Cboe CGI license + no-redistribution), C7-124 (Sharadar non-professional retention), C7-127 (Massive §8/§10 delete-on-terminate), C7-128 (Databento §9.3), C7-130 (OPRA redistribution), and the non-professional self-certification in C7-152.
- **Why:** legal/entitlement decisions are hard-banned. Whether a license permits retention/redistribution, and self-certifying non-professional status, are legal determinations with personal liability — not committee-decidable.
- **Pre-validation committee:** extracts and structures the license constraints per source (retention-allowed? redistribution-allowed? delete-on-terminate?) into a comparison table for legal review — never a go/no-go.
- **v7.1.1 posture (Ryan, 2026-07-02):** Ryan operates personal-use only — non-commercial, hobbyist, local, non-sharing, non-mutating, non-redistributing. License labels (GPL, LGPL, AGPL, Commons Clause, Other) are NOT blanket implementation blockers for tool/package adoption in this project; license/entitlement facts are recorded as operational context where they change practical behavior (retention after subscription termination, delete-on-terminate obligations, redistribution/display limits, external-tool vs vendored use, paid-account/credential dependencies). IR-5 remains the human boundary for the genuinely legal calls that survive — non-professional self-certification, vendor-terms acceptance at purchase time — but it is no longer a default stop sign on package adoption. Plain rule: license facts are context, not a blocker. Not legal advice.

### IR-6 — Purchase / subscription / paid-source decisions — IRREDUCIBLE
- **Records:** C7-086 (OQ2 paid-alternative eval), C7-122 (HistoricalOptionData $849/$295/$1,495), C7-124 (Sharadar ~$69/mo), C7-125 (FirstRate $499.95/$599.95), C7-126 (Kibot $520), C7-127 (Massive $29/mo), C7-128 (Databento PAYG), C7-129 (rejected/reserve set), C7-145 (futures primary + Kibot buy), C7-152 (feed costs / IBKR economics).
- **Why:** spending money is the first hard-ban. Committing to a purchase, subscription, or budget ceiling is a human financial decision.
- **Pre-validation committee:** verifies vendor sample-file evidence (coverage, schema fingerprint, timestamp semantics) and assembles a cost/coverage decision matrix so the human buys with verified evidence — but no committee may authorize a purchase.
- **v7.1.1 posture (Ryan, 2026-07-02):** no spend for now. Docs-derived DISABLED adapter drafts (`REQ-SRC-DRAFT` in [[PRJ-AI-CCC-DuckLake-v7.2.3-Provider-Capability-And-Availability]]) may proceed without any IR-6 decision because they commit no money and claim no entitlement; purchases and subscriptions remain blocked until Ryan buys or supplies evidence/sample files.

### IR-7 — Non-JCS canonical-JSON profile approval — IRREDUCIBLE
- **Records:** C6-282 (`canonical_json_non_jcs_profile_approval`) — the *deviation* branch of C4-054.
- **Why:** "do not fall back to ad hoc `json.dumps` unless Ryan explicitly approves a project-specific non-JCS profile." Departing from RFC 8785/JCS for manifest hashing is a project-integrity decision the human reserved; the safe branch (JCS conformance) is CG-02, but the deviation is human-only.
- **Pre-validation committee:** CG-02's reviewers already surface "no JCS authority passes the vectors"; that report is the input to the non-JCS decision.

### IR-8 — REQ-AUTH-01 resolution of safety-bearing / supplied-artifact backlog items — IRREDUCIBLE (partial)
- **Records:** C4-053 and C6-283 (the safety-bearing + supplied-artifact subset), C1-064 (`kill_or_pivot` when it names a human), C4-060 (External Verification Before Coding Or Purchase: DOD symbol lists, Norgate export, OCC/OPRA timing, SEC public-availability, FRED release timing — items requiring purchased symbol lists / entitlement / live timing evidence).
- **Why:** where `authority_type: supplied_artifact` means human-supplied cited evidence, or the item is a symbol-list purchase / export-workflow / OCC-OPRA live-timing fact feeding a live gate, resolution touches purchase, entitlement, or live-data trust. The runtime-probe subset is convertible (CG-06); this supplied-artifact/live subset is not.
- **Pre-validation committee:** CG-06's allowlist router already routes these here; an ensemble additionally validates that any human-supplied artifact is schema-valid and hash-recorded (gate-runner-recomputed) before the human's authority flips the item — evidence prep only.

---

## Coverage

v7.1.1 note: the ten open-question records C7-085..C7-094 are now adjudicated by Ryan's v7.1.1 decisions (see the Ryan Decisions section of [[REF-AI-DuckLake-v7.2.3-AdjudicationLedger]] and the annotated Section 10 of [[REF-AI-CCC-DuckLake-v7.2.3-OpenSource-Reinvention-Audit-2026-06-29]]). Their routing dispositions below are retained as history of how each question reached Ryan, and CG-10's role for them was advisory triage, not decision.

Every `kind: hitl_gate` registry record → CG number or IRREDUCIBLE. **Count note (re-corrected, PC-06 mechanical recount):** mechanical `grep 'kind: hitl_gate'` against the source registry yields **45 raw records** (C1: 4, C4: 13, C5: 3, C6: 5, C7: 20 — C6's own file-level self-audit at C6-verification-ledgers.md independently confirms `hitl_gate=5`), **not 46** — the earlier "46" was itself the arithmetic error. All 45 raw records appear as their own row below (**45 table rows**, an exact match; no record is missing from the table). Of those 45, **42 are distinct** gates once duplicated/anchor rows are folded out: 1 context anchor (C1-065 — not an approval gate) + 2 duplicate rows (C6-279 duplicates C1-063; C6-280 duplicates C1-062) are folded into the record they duplicate, leaving **42 distinct `hitl_gate` gates**, mapped to **11 committee gates (CG-01..CG-11) + 8 irreducible families (IR-1..IR-8)**. (C6-283 is flagged in its Disposition cell as "duplicate framing of C4-053" but is retained as its own distinct row — unlike C6-279/C6-280 it carries a split disposition of its own (CG-06 probe subset / IR-8) rather than being a pure restatement, so it is not folded into the 42.) The earlier "34" figure was an arithmetic error.

| Registry ID | Record id | CG / IR | Disposition |
|---|---|---|---|
| C1-062 | REQ-CFG-01-repo-path-confirmation | IR-1 | IRREDUCIBLE (human path choice; pre-validate writability) |
| C1-063 | bench-freeze-human-only | IR-2 | IRREDUCIBLE (auto-freeze forbidden; pre-validate baseline) |
| C1-064 | kill_or_pivot-contingency-field | CG-06 + IR-8 | CG-06 validates field is populated; content that names a human → IR-8 |
| C1-065 | ryan-context-authority | IR (context) | IRREDUCIBLE context anchor — not an approval gate; no committee (informs IR-1..8) |
| C4-029 | synthfix policy IDs resolve (SF1) | CG-01 | CONVERTED (machine test → committee) |
| C4-053 | backlog contingency + REQ-AUTH-01 authority | CG-06 (probe subset) / IR-8 (safety+supplied) | SPLIT |
| C4-054 | backlog canonical_json_authority | CG-02 (JCS path) / IR-7 (non-JCS) | SPLIT |
| C4-055 | backlog ducklake_maintenance_fn_names | CG-03 | CONVERTED (runtime-probe) |
| C4-056 | backlog ducklake_commit_fingerprint_discovery | CG-03 | CONVERTED (runtime-probe; live promotion still IR-3) |
| C4-057 | backlog ducklake_attach_relocated_root | CG-03 | CONVERTED (runtime-probe) |
| C4-058 | backlog dagu_binary_version_url_sha_license | CG-04 / IR-5 (license acceptability) | SPLIT |
| C4-059 | backlog sec_accepted_public_availability_timing | CG-05 (conservative hold) / IR-3 (live enable) | SPLIT |
| C4-060 | External Verification (DOD/Norgate/OCC-OPRA list) | IR-8 (+ IR-3/IR-5/IR-6 per item) | IRREDUCIBLE (symbol lists / export / live timing / purchase) |
| C4-061 | Open assumptions table | CG-07 (bookkeeping) + IR per row | SPLIT (completeness converted; money/legal/live rows → IR) |
| C4-062 | Core Implementation Verification Items table | CG-07 (bookkeeping) + IR-6 (version pins after buy) | SPLIT |
| C4-063 | Contract-Closure & Modeling-Interface Verification Items | CG-07 (bookkeeping) | CONVERTED (all rows are REQ-AUTH-01 runtime/design items) |
| C4-083 | Fundamentals symbol resolution rule callout | CG-08 | CONVERTED (design-conformance) |
| C5-100 | production-path-classifier-and-live-escape-flag | IR-3 | IRREDUCIBLE (touch real data; pre-validate refusal coverage) |
| C5-101 | cleanup-approve-hash-flag | IR-4 | IRREDUCIBLE (irreversible deletion; pre-validate dry-run) |
| C5-102 | publish-live-flag-escape | IR-3 | IRREDUCIBLE (live production publish) |
| C6-279 | req_bench_freeze_human_only | IR-2 | IRREDUCIBLE (duplicate of C1-063) |
| C6-280 | repo_name_confirmation | IR-1 | IRREDUCIBLE (duplicate of C1-062) |
| C6-281 | typechecker_substitution_approval | CG-09 (pin PASS) / IR-adjacent (substitution=human) | SPLIT |
| C6-282 | canonical_json_non_jcs_profile_approval | IR-7 | IRREDUCIBLE (non-JCS deviation) |
| C6-283 | req_auth_01_resolved_status_requires_authority | CG-06 (probe subset) / IR-8 (safety+supplied) | SPLIT (duplicate framing of C4-053) |
| C7-085 | open-question-1-license-posture | IR-5 (via CG-10 triage) | IRREDUCIBLE (license) |
| C7-086 | open-question-2-first-wave-source-plan | IR-6 (via CG-10 triage) | IRREDUCIBLE (paid-source eval) |
| C7-087 | open-question-3-calendar-authority-model | CG-10 | CONVERTED to recommendation (final call human) |
| C7-088 | open-question-4-options-analytics-scope | CG-10 | CONVERTED to recommendation (final call human) |
| C7-089 | open-question-5-raw-capture-failure-policy | CG-10 | CONVERTED to recommendation (fail-closed; ratify human) |
| C7-090 | open-question-6-contract-tooling-scope | CG-10 | CONVERTED to recommendation |
| C7-091 | open-question-7-restic-first-drill-scope | CG-10 | CONVERTED to recommendation |
| C7-092 | open-question-8-python-version | CG-09-adjacent (toolchain; via CG-10 triage) | AGENT-RESOLVABLE (FBL2-09): the agent pins the newest 3.13.x patch passing `task verify:toolchain`; IR ratification is required only to deviate from the 3.13 floor / standard-GIL / JIT-off frozen set |
| C7-093 | open-question-9-modeling-consumption-format | CG-10 | CONVERTED to recommendation |
| C7-094 | open-question-10-prd-patch-scope | CG-10 | CONVERTED to recommendation |
| C7-122 | su-vendor-evidence-historicaloptiondata | IR-6 | IRREDUCIBLE (purchase) |
| C7-123 | su-vendor-evidence-cboe | IR-5 + IR-6 | IRREDUCIBLE (license + subscription) |
| C7-124 | su-vendor-evidence-sharadar | IR-5 + IR-6 | IRREDUCIBLE (license retention + subscription) |
| C7-125 | su-vendor-evidence-firstrate | IR-6 | IRREDUCIBLE (purchase) |
| C7-126 | su-vendor-evidence-kibot | IR-6 | IRREDUCIBLE (purchase; pre-validate sample file) |
| C7-127 | su-vendor-evidence-massive | IR-5 + IR-6 | IRREDUCIBLE (legal §8/§10 + subscription) |
| C7-128 | su-vendor-evidence-databento | IR-5 + IR-6 | IRREDUCIBLE (legal §9.3 + PAYG spend) |
| C7-129 | su-vendor-evidence-rejected-reserve | IR-5/IR-6 (record) | IRREDUCIBLE (reject/reserve decisions; no committee) |
| C7-145 | su-futures-primary-rationale | IR-6 (+ CG-10 for yfinance-ban conformance) | IRREDUCIBLE purchase; the "yfinance MUST NOT back canonical" ban is a guardrail-test, not a HITL |
| C7-152 | su-feed-costs-ibkr-notes | IR-5 + IR-6 | IRREDUCIBLE (purchase economics + non-professional self-cert) |

**Reducibility summary:** 42 distinct `hitl_gate` records (45 raw records, 3 folded: 1 context anchor + 2 duplicates) → 11 committee gates (CG-01..CG-11) + 8 irreducible families (IR-1..IR-8). Fully converted: C4-029, C4-055, C4-056, C4-057, C4-063, C4-083, the CR-017/R10 kernel cluster (CG-11), plus 7 of the 10 C7 open questions as recommendation pre-processors. Split (committee handles the safe/bookkeeping branch, human keeps the money/legal/live/destructive branch): C1-064, C4-053, C4-054, C4-058, C4-059, C4-061, C4-062, C6-281, C6-283. Fully IRREDUCIBLE: the remaining records (repo path, bench freeze, live escape, deletion approval, non-JCS profile, license, purchase, external-verify list), each with an optional pre-validation committee under IR-1..IR-8; the former host-pin item (C7-092) is agent-resolvable per FBL2-09, with only its frozen-set deviation branch remaining human.

## Autonomous Execution Authority and Receipt Contract

For v7.2.3, execution pauses formerly expressed as Committee or operator approval are replaced by the Autonomous Execution Authority (`AER.v1`). Advisory review still produces evidence, but no mutable review note, CLI flag, environment variable, database GUC, runtime role, Taskfile target, or caller-provided hash can authorize a protected action.

`AER.v1` is a signed, replay-safe record containing `receipt_id`, issuer key ID, issuer identity, executor identity, plan SHA-256, action class, target identity and target hash, requested privilege, precondition hashes, evidence hashes, issue time, expiry, nonce, rollback artifact path and hash, signature, and verifier version. The issuer holds non-repository trust material; validators have only the trusted public key and a durable replay ledger. Receipt issuance and validation both fail closed on a missing field, invalid signature, plan mismatch, action mismatch, target mismatch, executor mismatch, expired timestamp, reused nonce, missing rollback artifact, or unavailable replay ledger.

The validator is independently testable. It accepts a canonical serialized receipt and trusted public-key configuration only. It has no `--approve`, `--skip`, `--force`, environment, manifest, GUC, or database-role bypass input. A direct database call must invoke the same validator through the database-resident interface; a CLI-only or application-only check is void.

### Cleanup receipt substep — AMD-046a

`cleanup_authorization` is a separate action class. Its receipt additionally binds cleanup ID, exact candidate-set hash, immutable plan hash, dry-run artifact hash, retention evidence hash, and rollback artifact. The Committee module owns the receipt schema, issuance contract, verifier contract, failure semantics, and replay record. [[PRJ-AI-CCC-DuckLake-v7.2.3-Publish-Control-Kernel]] consumes only an immutable verified result inside a SECURITY DEFINER path; [[PRJ-AI-CCC-DuckLake-v7.2.3-Orchestration-And-QDBCTL]] accepts only a receipt reference. Direct DML, a custom GUC, or a caller-made approval artifact cannot set eligibility.

### Physical-action receipt substep — AMD-046b

The same receipt family covers `remote_enrollment`, `privilege_change`, `service_replace`, `nas_mutation`, `canonical_root_promotion`, and `rollback_exception`. [[PRJ-AI-CCC-DuckLake-v7.2.3-Physical-Host-Bootstrap-And-Cutover]] owns target semantics and consumes verified receipts by reference; it cannot define a second issuer or signature format.

### Receipt acceptance proofs

- `test_autonomous_receipt_rejects_cli_flag_and_environment_bypass`
- `test_autonomous_receipt_rejects_mutable_manifest_and_database_guc_bypass`
- `test_autonomous_receipt_binds_plan_target_executor_privilege_and_expiry`
- `test_autonomous_receipt_replay_ledger_fails_closed`
- `test_cleanup_receipt_requires_candidate_set_and_rollback_artifact`
- `test_physical_action_consumes_same_receipt_family_as_cleanup`

## v7.2.3 r2 restored indexed acceptance criterion

- `test_cleanup_receipt_target_plan_expiry_and_replay_binding`: cleanup refuses unless the receipt matches the exact target set, plan hash, action class, executor, privilege, evidence, rollback artifact, and unexpired time window, and the replay ledger proves it has not been consumed.
