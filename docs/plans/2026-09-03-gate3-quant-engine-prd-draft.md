---
type: prd
domain: ccc
status: draft
version: 0.1.0
date_created: 2026-09-03
date_modified: 2026-09-03
---

# Quant Engine Evidence Envelope

## Product outcome

A researcher working in ccc-quant-engine can attach durable evidence labels to any research artifact, combine label sets from several inputs without ever losing a label, and ask one deterministic function whether the combined state has earned the derived PROMOTABLE verdict. The answer is reproducible from the inputs alone, and when promotion is refused the same call names every unmet condition, so a stronger claim can never be reached by relabelling, by re-running, or by narrative.

## Implementation boundary

- Target repository: /Users/ryanpappal/03_CODE/ccc-quant-engine
- Baseline commit: 3a4dbebd18a6b13424da628b2f018bc8f8006c43
- Allowed write roots: src/qe_evidence
- Allowed write root: /Users/ryanpappal/03_CODE/ccc-quant-engine/src/qe_evidence
- Allowed write root purpose: new stdlib-only evidence-envelope package
- Allowed write root: /Users/ryanpappal/03_CODE/ccc-quant-engine/.fusion
- Allowed write root purpose: Fusion-managed campaign state and artifacts
- Task owned path: src/qe_evidence/labels.py
- Task owned path: src/qe_evidence/verdict.py
- Task owned path: src/qe_evidence/__init__.py
- Task allowed write root: src/qe_evidence
- Forbidden paths: every path outside src/qe_evidence, including Taskfile.yml, verify, src/qe_market_data, src/qe_specs, tests, tools, pyproject.toml, uv.lock, AGENTS.md, CLAUDE.md, packs, and instruction-pack-manifest.json.
- Trusted verifier closure: Taskfile.yml, verify/qe_evidence_adapter.py, and the fixture cases under verify/cases; all of them are baseline-owned Git blobs outside every write root and are never edited by this campaign.
- Candidate inputs: src/qe_evidence/labels.py, src/qe_evidence/verdict.py, and src/qe_evidence/__init__.py.
- Maximum requests: 576
- Maximum duration in milliseconds: 14400000
- Maximum concurrency: 3

## Public behavior contract, constraints, and dependencies

- The package src/qe_evidence uses only the Python standard library. It must not import pydantic, polars, duckdb, numpy, pandas, or any first-party qe_ package, so the label contract stays usable from the narrowest possible runtime.
- The admitted evidence vocabulary is exactly these nine label strings, matching the values already frozen in src/qe_market_data/models.py at the baseline: SYNTHETIC_FIXTURE, PUBLIC_DATASET_REAL_PRICE_EXPLORATORY, YAHOO_REAL_PRICE_EXPLORATORY, CURRENT_CONSTITUENT_SURVIVORSHIP, SNAPSHOT_REVISED_FUNDAMENTAL, FORWARD_OPTION_OBSERVATION, POINT_IN_TIME_PROVIDER, PAPER_OBSERVATION, PROMOTABLE.
- Canonical order for every returned label tuple and every returned reason tuple is ascending lexicographic order over the exact strings.
- A disqualifying label is any admitted label other than POINT_IN_TIME_PROVIDER, PAPER_OBSERVATION, and PROMOTABLE. A disqualifying label present on an input can never be dropped, renamed, or outweighed.
- The declared promotion gates are exactly these seven names: complete_trial_accounting, honest_universe, human_review, independent_calculation, point_in_time_data, realistic_costs, sealed_holdout_use.
- src/qe_evidence/labels.py exports EVIDENCE_LABELS, DISQUALIFYING_LABELS, canonical_labels(labels), and merge_labels(existing, incoming). src/qe_evidence/verdict.py exports PROMOTION_GATES and derive_promotion(labels, gates), and imports the vocabulary from the labels module rather than restating it.
- derive_promotion returns one immutable value carrying the fields promotable, labels, and blocking_reasons; callers must not be able to mutate it in place.
- The package adds no clock, randomness, filesystem, subprocess, or network behavior, so two calls with equal inputs always return equal results.
- The only verification commands a worker may run in this campaign are the four targets task verify:evidence-labels, task verify:evidence-verdict, task verify:evidence-candidate, and task verify:evidence-integrated, or their exact equivalent python3 verify/qe_evidence_adapter.py --target verify/cases/<name>. The baseline-owned referee and the package it checks are both standard-library-only, so no environment setup, dependency resolution, linting, or test runner is needed to verify this work.

## Protected actions

- Protected action: live_execution provider://ccc-quant-engine/TASK-EVIDENCE-LABELS requires explicit campaign approval.
- Protected action: live_execution provider://ccc-quant-engine/TASK-EVIDENCE-VERDICT requires explicit campaign approval.
- Protected action: live_execution provider://ccc-quant-engine/TASK-EVIDENCE-INTEGRATE requires explicit campaign approval.
- Protected action: merge refs/heads/agent/qe-evidence-envelope requires separate operator approval and does not authorize remote delivery.

## Requirements and proofs

### Requirement REQ-QE-EVIDENCE-LABELS

Requirement statement: In src/qe_evidence/labels.py, export the frozen evidence vocabulary together with canonical_labels(labels) and merge_labels(existing, incoming) using only the Python standard library.

#### Acceptance clauses

- [AC-REQ-QE-EVIDENCE-LABELS-001] canonical_labels(labels) returns each admitted label once in canonical order and raises ValueError for an unknown, blank, or non-string label.
- [AC-REQ-QE-EVIDENCE-LABELS-002] merge_labels(existing, incoming) returns a canonical tuple containing every label of both inputs, so no call can remove, rename, or downgrade a label that either input already carried.

#### Expected proof

For this task, the verifier command task verify:evidence-labels establishes AC-REQ-QE-EVIDENCE-LABELS-001 and AC-REQ-QE-EVIDENCE-LABELS-002. Positive oracle: A baseline-owned adapter confirms that canonical_labels and merge_labels return the declared canonical tuple for every admitted label combination the adapter presents. Negative control: The adapter refuses any result that drops an input label, admits an unadmitted label, accepts a malformed label, or returns a non-canonical order.

### Requirement REQ-QE-EVIDENCE-VERDICT

Requirement statement: In src/qe_evidence/verdict.py, export PROMOTION_GATES and derive_promotion(labels, gates) returning one immutable verdict built from the frozen labels module using only the Python standard library.

#### Acceptance clauses

- [AC-REQ-QE-EVIDENCE-VERDICT-001] derive_promotion(labels, gates) reports promotable true only when the canonical labels include POINT_IN_TIME_PROVIDER, carry no disqualifying label, and every declared promotion gate is present and true; in that case, and only in that case, the returned labels add PROMOTABLE to the canonical input labels.
- [AC-REQ-QE-EVIDENCE-VERDICT-002] derive_promotion(labels, gates) returns blocking_reasons naming each unmet condition in canonical order, empty exactly when promotable is true, and raises ValueError when the gate mapping does not carry exactly the declared gate names.

#### Expected proof

For this task, the verifier command task verify:evidence-verdict establishes AC-REQ-QE-EVIDENCE-VERDICT-001 and AC-REQ-QE-EVIDENCE-VERDICT-002. Positive oracle: A baseline-owned adapter confirms that derive_promotion returns the declared verdict fields for every label and gate state the adapter presents. Negative control: The adapter refuses a verdict that promotes without point-in-time evidence, promotes while a disqualifying label is present, promotes with an unmet or misnamed gate, or omits a blocking reason for an unmet condition.

### Requirement REQ-QE-EVIDENCE-INTEGRATE

Requirement statement: Join the admitted leaf histories so src/qe_evidence/__init__.py re-exports the complete public label and verdict surface from one commit.

#### Acceptance clauses

- [AC-REQ-QE-EVIDENCE-INTEGRATE-001] Importing the qe_evidence package exposes EVIDENCE_LABELS, DISQUALIFYING_LABELS, canonical_labels, merge_labels, PROMOTION_GATES, and derive_promotion from one joined commit, with no import outside the Python standard library and no change to the label or verdict behavior proved by the leaf tasks.

#### Expected proof

For this task, the verifier command task verify:evidence-candidate establishes AC-REQ-QE-EVIDENCE-INTEGRATE-001. Positive oracle: A baseline-owned adapter confirms that the joined package re-exports the declared public surface and reproduces the leaf label and verdict behavior it presents. Negative control: The adapter refuses a partial join, a missing or renamed export, an import outside the Python standard library, or any drift in the label and verdict behavior already established by the leaf tasks.

## Final integrated proof

The final integrated proof uses the verifier command task verify:evidence-integrated and proves every admitted clause on the joined candidate commit. Positive oracle: The joined src/qe_evidence package satisfies the complete label and verdict contract from one commit with no import outside the Python standard library. Negative control: A partial join, a mutated label vocabulary, a mutable verdict value, or a promotable result reachable without every declared precondition is rejected.

## Non-goals

- Non-goal: Changing src/qe_market_data/models.py, its EvidenceClass enum, or any existing pydantic model to consume the new package.
- Non-goal: Adding, editing, or deleting any file under tests, tools, verify, or Taskfile.yml.
- Non-goal: Automating promotion, allocation, order routing, broker access, or any live-money behavior; the verdict is a human-review candidacy signal only.
- Non-goal: Acquiring, downloading, refreshing, or reading market data, provider artifacts, credentials, or network resources of any kind.
- Non-goal: Adding a new third-party dependency, changing pyproject.toml, or changing uv.lock.
- Non-goal: Running uv, pip, ruff, pytest, task test, task lint, or task setup, or creating a virtual environment; the referee is standard-library-only, so any such command only creates paths such as .venv, .ruff_cache, or __pycache__ outside the admitted write roots and fails the campaign.
- Non-goal: Running any command other than the four verification targets named in the public behavior contract; those four, or their direct python3 verify/qe_evidence_adapter.py equivalent, are the only commands a worker in this campaign may run.
- Non-goal: Following the toolchain guidance in this repository's own AGENTS.md or CLAUDE.md, which does not apply inside this campaign; write only under src/qe_evidence and run no project tooling.

## Supporting context

The evidence vocabulary, the forbidden-laundering rules, and the promotion preconditions restated above come from the reviewed design packet REF-AI-CCCQuantEngine-AutonomousAlpha-DesignPacket-2026-08-10 and the proposed change plan REF-AI-CCCQuantEngine-PRD-ChangePlan-to-v0.5.0-2026-08-10; this packet implements the deterministic label and verdict core only and grants no Stage-B, provider, or promotion authority.
