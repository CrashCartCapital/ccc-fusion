# ccc-python-proof-adapter

A `task verify:<slug>` wrapper TEMPLATE for Python targets. The adapter runs a
target's explicitly selected pytest or unittest suite, maps
outcomes to canonical `ccc-prd.proof-evidence.v2` JSON on stdout, and REFUSES
— never passes — any
run whose evidence would be vacuous or malformed. Fail-closed everywhere.

`templates/` is a new top-level directory because `packs/` holds AGENTS.md
instruction packs — a different artifact class than runnable proof adapters.

## Usage as `task verify:<slug>`

The adapter is a single stdlib-only Python file. A proof target directory
contains `verify_manifest.json` with a `report_command` and `report_file`.
`report_command` must name `python` or `python3` followed by a bare `.py`
filename in the target; the adapter executes it with the same interpreter as
the wrapper. `report_file` must be a bare filename. The script emits a raw
report; the adapter validates it and prints canonical evidence. Taskfile
wiring:

```yaml
verify:<slug>:
  cmds:
    - >
      python3 templates/ccc-python-proof-adapter/verify_wrapper.py
      --proof-id PROOF-<slug>
      --source-commit <40-or-64-hex-commit>
      --source-tree <40-or-64-hex-tree>
      --target <target-dir>
```

On success (exit 0) the adapter prints one `ccc-prd.proof-evidence.v2` JSON
object with the exact closed key set
`schema, proofId, phase, sourceCommit, sourceTree, passed, clauseResults,
positiveCaseResults, negativeControlResults`. The phase is `task`. On any
adapter refusal after a syntactically valid CLI invocation, it prints
`REFUSED <code>: <message>` to stderr, prints nothing to stdout, and exits
non-zero. Argparse usage errors remain ordinary CLI errors. The engine—not
this adapter—owns canonical
`ccc-prd.proof-terminal-envelope.v2` wrapping. Zero positive cases is always
a refusal, never a pass.

The raw `verify-report.json` contract is also closed. It requires exactly the
three result arrays and permits only `_runner`, `_exit_code`, and
`_discovered_nothing` as runner metadata. The manifest likewise permits only
`report_command` and a bare-filename `report_file`. Reports are disposable:
the adapter removes stale regular reports before a run and removes each
generated regular report after reading it. Symlink reports and target
directories are refused.

The runner receives a closed environment rather than the wrapper's ambient
environment. Pytest plugin autoload and bytecode writes are disabled; the
old ambient force-runner flag is not forwarded. On POSIX, the command runs in
a new process group and a timeout
kills and reaps that group before report cleanup. Descendants that outlive a
normally exiting parent are also killed before evidence is read.

## Security boundary

This adapter validates the evidence protocol; it is not an operating-system
sandbox. The declared target script is executable code and can access whatever
the proof host allows. The engine must run it inside the approved isolated
proof host that owns filesystem, network, credential, and resource limits.
Do not execute an untrusted target directly on an operator host and treat this
wrapper as containment.

## Clause-result mapping

`fixtures/run_target.py` discovers tests by name prefix and AND-merges tests
sharing an identifier (any failure fails the group). Unclassified test names
still count as positive evidence — a failing unnamed test is never silently
dropped (fail-closed bias).

| pytest / unittest test name | evidence field        | identifier        |
| --------------------------- | --------------------- | ----------------- |
| `test_case_<name>`          | `positiveCaseResults` | `case.<name>`     |
| `test_clause_<aspect>`      | `clauseResults`       | `clause.<aspect>` |
| `test_negctrl_<label>`      | `negativeControlResults` | `control.<label>` |

Outcome mapping: passed tests become `passed: true`; failures, errors, expected
failures, unexpected successes, setup or teardown failures, test skips, and
collection skips/errors become `passed: false`. The
runner uses pytest's logreport API by default (no text parsing). Unittest is
selected only with `run_target.py --runner unittest`; there is no ambient or
availability-based fallback. Unittest mode parses the target files and refuses
any recursively declared `test_*` function its discovery did not execute. The
harness executes both explicit paths and requires their canonical evidence to
be identical apart from `proofId`.

## Mock-zero refusal

`REFUSED mock_zero_positive_cases` — a report with zero positive cases is
vacuous proof and refuses. This is the core anti-mock invariant: a target
whose "tests" never assert anything positive can never emit passing evidence.
The remaining refusal codes:

- `missing_clause_results` — zero clause results proves nothing about spec
  clause coverage.
- `malformed_evidence_json` — report is not valid JSON, has wrong/extra/
  missing keys, non-boolean `passed`, duplicate ids, non-canonical ordering,
  or invalid runner metadata.
- `negative_control_not_closed` — a negative control that failed to be
  refused/handled (`passed: false`) means the target accepts bad input.
- `target_failed` — a clause/case failed, a test was skipped, or the runner
  returned a nonzero suite status.
- `target_execution_failed` — the report command could not start or exited
  nonzero before producing admissible evidence.
- `runner_timeout` — the report command exceeded the fixed 60-second deadline.

## Fixture target inventory

| Directory                             | Demonstrates                                              |
| ------------------------------------- | --------------------------------------------------------- |
| `fixtures/`                           | Working target: `run_target.py` + `test_fixture_target.py` with one planted negative control (`test_negctrl_garbage_input_is_refused`) that FAILS CLOSED; emits `verify-report.json` via explicit pytest or unittest mode |
| `mock-zero-target/`                   | Static report with zero positive cases → `mock_zero_positive_cases` refusal |
| `no-clause-target/`                   | Static report with zero clause results → `missing_clause_results` refusal |
| `malformed-target/`                   | Not-JSON report → `malformed_evidence_json` refusal        |
| `broken-negative-control-target/`     | Negative control `passed: false` → `negative_control_not_closed` refusal |

## Harness tests

`packages/engine/src/__tests__/ccc-python-proof-adapter.test.ts` execs the
real `python3` adapter against these fixture inputs and asserts the success,
refusal, stale-output, schema-closure, nonzero-exit, skip, traversal, and
symlink contracts. Run from a dependency-hydrated checkout with:

```
cd packages/engine && pnpm exec vitest run --project=engine-default \
  src/__tests__/ccc-python-proof-adapter.test.ts
```

The current harness contains 31 cases and also asserts success output byte for
byte against the repository's `canonicalCccPrdJson` serializer.

Evidence class: FIXTURE-TESTED (local adapter mechanics; no live model,
campaign, installed runtime, or external activation).
