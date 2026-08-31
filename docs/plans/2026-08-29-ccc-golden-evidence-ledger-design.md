# CCC Golden Evidence Ledger Design

**Status:** approved for implementation on 2026-08-29
**Scope:** deep design
**Branch:** `agent/golden-campaign-readiness-20260829`

## Goal

Prove that CCC-Fusion can turn a sealed three-task PRD packet into a meaningful, deterministic, multi-file project, then use paired Pi and OpenCode trials to distinguish model weakness from harness, task-size, request-budget, route-proof, or recovery defects.

The product under construction is a disposable Node.js Evidence Ledger CLI. It ingests newline-delimited JSON evidence records, validates a strict public contract, canonicalizes the accepted records, aggregates them by subject, and emits deterministic JSON or plain-text reports. The project is intentionally useful enough to require module boundaries, CLI behavior, error handling, documentation, and integrated proof while avoiding browser, database, network, native-module, wall-clock, and UUID noise.

## Success Criteria

- A frozen CCC PRD packet defines a three-task dependency chain with disjoint owned paths and exact proof declarations.
- CCC-Fusion creates the project in isolated task worktrees, preserves custody, produces required commits, integrates the chain, and passes the baseline-owned verifier.
- The generated project contains at least six worker-authored files covering validation, canonicalization, aggregation, reporting, CLI behavior, and operator documentation.
- Every task has a baseline-owned phase verifier that can run before downstream files exist; the final project verifier remains a separate integrated gate.
- Valid input produces byte-stable JSON and text output. Input order does not change output.
- Unknown fields, malformed JSON, invalid RFC3339 UTC timestamps, invalid confidence values, and duplicate record IDs produce deterministic diagnostics, exit status `2`, empty standard output, and no residue.
- The trusted verifier includes positive cases, negative controls, shuffled-input invariance, semantic mutation controls, path-custody checks, and expected-commit checks.
- Every live trial records requested, configured, selected, and effective route identity; harness identity; request and tool counts; first-mutation ordinal; elapsed time; proof result; changed paths; commit; and terminal settlement. Missing effective-route proof is `ROUTE_UNKNOWN`, never inferred.
- At least two fresh runs of the winning campaign cell pass with identical acceptance behavior and no leaked process, worktree, PostgreSQL, or task residue.
- Pi and OpenCode results are compared on the same frozen project, verifier, prompt contract, route where possible, budget, and timeout. OpenCode remains benchmark-only until CCC custody and effect receipts are proven.

## Constraints

- Do not touch live port `4040`, the existing live Fusion instance, shared PostgreSQL, credentials, global provider routes, unrelated worktrees, or vault/private data.
- Use a fresh disposable Git repository and task-specific disposable PostgreSQL instance for every lifecycle campaign.
- Keep PostgreSQL as CCC-Fusion's sole workflow-state store. Experiment receipts are derived evidence, not a second scheduler or task database.
- Do not use OpenCode `--auto`, `--pure`, or the generic CCC CLI adapter.
- No push, pull request, merge, release, publication, or external deployment.
- Provider calls are bounded, serial during diagnosis, and limited to already-configured routes authorized by the operator for this campaign.
- Production behavior changes use RED -> GREEN -> REFACTOR. A setup/import failure is not a behavioral RED.

## Decisions

### Project contract

Each NDJSON record has exactly `id`, `subject`, `claim`, `observedAt`, `source`, `confidence`, and optional `tags`. All required fields are non-empty strings. `observedAt` is canonical RFC3339 UTC ending in `Z`. `confidence` is one of `low`, `medium`, or `high`. `tags` is an optional array of unique non-empty strings. Record IDs are unique across the input.

The public module contract is exact:

- `parseEvidenceLine(line, lineNumber)` returns one normalized record or throws a validation error carrying the line number.
- `validateEvidenceRecords(records)` returns the accepted array or throws on duplicate IDs.
- `buildLedger(records)` returns `{ schema, recordCount, subjects, records }`, where `schema` is `evidence-ledger.report.v1`, `subjects` is a lexically sorted array of `{ subject, count, recordIds }`, and `records` is the canonical record array.
- `renderJsonReport(ledger)` returns two-space JSON plus one trailing newline.
- `renderTextReport(ledger)` returns the exact template below plus one trailing newline.

Canonical output sorts records by `observedAt` and then `id`, sorts tags lexically, sorts subject aggregates lexically, and sorts each subject's `recordIds` in canonical record order. The text template is:

```text
Evidence Ledger Report
Records: <recordCount>
Subject: <subject> (<count>)
- <observedAt> [<confidence>] <id> | <claim> | source=<source> | tags=<comma-separated-tags-or-none>
```

The subject block and record line repeat in canonical order. The CLI exposes `report <input> --format json|text`, prints diagnostics to standard error, writes no state, and returns `0` on success, `1` for usage, option, or input/output errors, and `2` for NDJSON contract validation failures.

### Task chain

1. `LEDGER-CONTRACT` owns `src/record.mjs` and `src/validation.mjs`.
2. `LEDGER-CORE` depends on `LEDGER-CONTRACT` and owns `src/ledger.mjs` and `src/report.mjs`.
3. `LEDGER-CLI` depends on `LEDGER-CORE` and owns `bin/evidence-ledger.mjs` and `README.md`.

The baseline owns `package.json`, `Taskfile.yml`, fixtures, and `verify/project-verifier.mjs`. Workers cannot alter those files.

The verifier accepts an exact phase argument. `contract` imports only the two Task 1 modules and proves parsing, field, timestamp, confidence, tag, and duplicate-ID behavior. `core` imports Task 1 and Task 2 modules and proves canonicalization, aggregation, and both renderers. `cli` and `project` run the complete command contract and mutation controls. The baseline invokes the entry point as `node bin/evidence-ledger.mjs`; executable file mode is not part of the worker contract.

### Experiment order

Begin with concurrency `1`. Establish a deterministic fake-backed lifecycle control, then run the in-process Pi path. Compare small, recommended, and deliberately broad task bites; request ceilings `6`, `9`, and `12`; and current versus file-first prompts. Stop an unchanged arm after two provider requests or six discovery calls without mutation, after a terminal custody/refusal error, or after two repeated runs with the same failure signature.

Only after the Pi baseline is understood, run task-local headless OpenCode with structured JSON events and the same project contract. The exact non-interactive shape is:

```text
OPENCODE_DB=<run-root>/opencode.db /Users/ryanpappal/.opencode/bin/opencode-interactive run --format json --dir <disposable-repo> --model <live-admitted-model> --agent build --title <experiment-id> <prompt>
```

The run uses neither `--auto` nor `--pure`; standard input is closed after launch. The experiment envelope binds hashes for the prompt, argv, OpenCode config, agent definition, tool schema, and baseline project. Non-JSON startup lines become warnings. A missing final `step_finish` is partial and requires bounded export/database reconciliation rather than inferred success.

This is deliberately a whole-harness comparison: CCC-wrapped Pi versus task-local OpenCode. Prompt-prefix, tool-schema, custody, and middleware hashes are logged as treatment differences, so direct tool-count or latency comparisons are not misrepresented as raw model-loop equivalence. A raw unwrapped Pi trial is optional diagnostic evidence, never a substitute for the CCC campaign result. A first-class OpenCode adapter is designed in a separate evidence-triggered plan only if the benchmark exposes a material advantage or a specific Pi defect and after fake-stream event normalization, path custody, route proof, and effect-receipt tests pass.

## Product Pressure Test

- **Verifier leakage:** a worker could hardcode visible expected bytes. The verifier therefore uses shuffled input, semantic mutation controls, multiple invalid fixtures, and baseline-owned code outside worker custody.
- **Lifecycle confounding:** the existing product-acceptance script tests many importer, approval, PostgreSQL, and integration behaviors around toy text changes. The golden harness is separate and emits phase checkpoints so worker failure is not blurred with lifecycle failure.
- **Asymmetric harness proof:** OpenCode exposes richer sessions and events but does not currently share CCC custody or durable effect receipts. Its initial result is a benchmark, not lifecycle equivalence.
- **Phase false red/green:** downstream CLI files do not exist during the first two tasks. Phase-specific baseline verifiers and frozen module signatures prevent both premature integrated failure and unverified intermediate landing.
- **Disposable-process leakage:** every PostgreSQL and worker process is started through the owned process-supervision seam, registered before use, and awaited during normal, signal, timeout, and exception cleanup. Only the exact owned process tree may be stopped.
- **Closest rejected alternative:** a PRD graph inspector is more CCC-native, but Markdown parsing ambiguity would make failures harder to attribute. A local web app adds browser and process noise before the first-mutation problem is understood.

## Open Questions

No operator decision remains open. Exact live model IDs and effective route identity are runtime facts and will be probed immediately before each bounded provider trial rather than frozen into this design.

## Handoff

Continue with `docs/plans/2026-08-29-ccc-golden-evidence-ledger-plan.md`. The next lane is test-driven implementation of the disposable fixture, verifier, receipt schema, and fake-backed campaign control, followed by serial Pi and OpenCode trials and evidence-driven harness repair.
