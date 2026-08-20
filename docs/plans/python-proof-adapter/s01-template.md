---
title: "S01: Python proof adapter template"
type: feature
status: fixture-tested
date: 2026-08-16
slice: S01
milestone: "Python proof adapter"
origin: W3-T2 sealed window (lane A, re-dispatch 1)
---
# S01: Python proof adapter template
## Stack Role
Template only: a `task verify:<slug>` wrapper for Python targets that emits
canonical `ccc-prd.proof-evidence.v2` JSON. No live model, no campaign
wiring, no host integration — this slice delivers the adapter template, its
fixture targets, and the engine harness tests that pin its refusal contract.
## Evidence contract
Exact closed key set (no extras): `schema` (literal
`ccc-prd.proof-evidence.v2`), `proofId`, `phase` (`task`), `sourceCommit` and
`sourceTree` (40- or 64-hex git
objects), `passed` (`true` on emitted evidence), `clauseResults[]` (`clauseId`, `passed`),
`positiveCaseResults[]` (`caseId`, `passed`), `negativeControlResults[]`
(`controlId`, `passed`). Result ids match `^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$`,
are unique, and are canonically ordered (lexicographic by id). Entries are
bounded (4096 per array). Any false member refuses rather than emitting an
evidence object. Zero positive cases is a
`mock_zero_positive_cases` refusal — vacuous proof never passes.

The raw runner report requires the three result arrays and permits only
`_runner`, `_exit_code`, and `_discovered_nothing` metadata. The manifest is
closed to a Python interpreter token plus a bare `.py` script in
`report_command`, and a bare-filename `report_file`. Duplicate JSON object keys
are refused. Generated reports are disposable and cleaned after consumption;
stale reports, symlinks, NULs, and path traversal are refused. Git objects use
full-string matching.
## Clause mapping
Test-name prefixes in the target suite map to evidence fields:
`test_case_*` → positive cases, `test_clause_*` → clause results,
`test_negctrl_*` → negative controls; shared identifiers AND-merge.
Runner mode is explicit: pytest's logreport API is the default, while
`--runner unittest` selects the stdlib harness. There is no ambient or
availability-based fallback. Unittest mode refuses any declared `test_*`
function in the recursive target tree that its discovery did not execute. The
harness verifies both explicit paths produce equivalent canonical evidence.
Expected failures, unexpected successes, setup/teardown failures, test skips,
and collection skips/errors all map to failed evidence. The target receives a
closed environment with ambient pytest plugin loading disabled. POSIX timeouts
kill and reap the whole runner process group; descendants that outlive a
successful parent are killed before evidence is read.
## Refusals
`mock_zero_positive_cases`, `missing_clause_results`,
`malformed_evidence_json` (invalid JSON, wrong/extra keys, non-boolean
passed, duplicate or unordered ids),
`negative_control_not_closed`, `target_failed`, `target_execution_failed`, and
`runner_timeout`. Every refusal exits non-zero with `REFUSED <code>: <message>`
on stderr; nothing prints on stdout. The engine owns canonical terminal-envelope
wrapping; the adapter does not emit `ccc-prd.proof-terminal-envelope.v2`.

CLI syntax errors are ordinary argparse errors, not adapter refusals. This
adapter validates evidence and runner lifecycle; it is not an OS sandbox. The
engine's isolated proof host remains mandatory for filesystem, network,
credential, and resource containment of the executable target script.
## File scope
- `templates/ccc-python-proof-adapter/` — `verify_wrapper.py` (stdlib only),
  `fixtures/` working target, four refusal-target dirs, README.
- `packages/engine/src/__tests__/ccc-python-proof-adapter.test.ts` — execs
  the adapter on fixture inputs.
## Tests
Named refusal cases were demonstrated RED-first against the candidate and then
made green against the real adapter. The fresh harness covers healthy pytest
and explicit-unittest parity plus mock-zero, missing-clause, malformed JSON,
broken negative-control, stale report, schema closure, nonzero suite status,
skipped tests, traversal, and symlink refusal.
The current harness contains 31 passing cases, including duplicate-key,
expected-failure, collection-skip, mixed-runner, closed-environment, Git-ID,
and real descendant timeout/success regressions.

Evidence class: FIXTURE-TESTED (local mechanics only; no live model, campaign,
installed runtime, or external activation).
