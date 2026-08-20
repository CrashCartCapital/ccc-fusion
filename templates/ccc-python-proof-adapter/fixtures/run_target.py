#!/usr/bin/env python3
"""Fixture target runner for the ccc-python-proof-adapter template.

Runs the target suite under an explicit pytest (default) or unittest mode.
There is no ambient fallback from pytest to unittest: selecting the weaker
discovery surface must be deliberate, and unittest mode refuses test-like
functions it did not discover. Writes verify-report.json consumed by
verify_wrapper.py.

Test-name conventions define the evidence mapping (discovery requires the
 customary test_ prefix):
  test_case_<name>     -> positive case    case.<name>
  test_clause_<aspect> -> clause result    clause.<aspect>
  test_negctrl_<label> -> negative control control.<label>
Tests sharing a tag AND-merge into one result (any failure fails the group).
"""

import argparse
import ast
from collections import Counter
import json
from pathlib import Path
import sys
import unittest

REPORT_PATH = "verify-report.json"


def new_report():
    return {"clauseResults": [], "positiveCaseResults": [], "negativeControlResults": []}


def classify(name, passed, report):
    stripped = name[len("test_"):] if name.startswith("test_") else name
    if stripped.startswith("case_"):
        label = stripped[len("case_"):]
        _upsert(report["positiveCaseResults"], "caseId", "case." + label, passed)
    elif stripped.startswith("clause_"):
        aspect = stripped[len("clause_"):]
        _upsert(report["clauseResults"], "clauseId", "clause." + aspect, passed)
    elif stripped.startswith("negctrl_"):
        label = stripped[len("negctrl_"):]
        _upsert(report["negativeControlResults"], "controlId", "control." + label, passed)
    else:
        # Unclassified tests still count as positive evidence: an unnamed
        # test that fails must never be silently dropped (fail-closed bias).
        _upsert(report["positiveCaseResults"], "caseId", "case." + stripped, passed)


def _upsert(entries, id_key, identifier, passed):
    for existing in entries:
        if existing[id_key] == identifier:
            existing["passed"] = existing["passed"] and passed
            return
    entries.append({id_key: identifier, "passed": passed})


def run_pytest():
    try:
        import pytest
    except ImportError:
        return None

    outcomes = {}

    class Collector:
        def pytest_collectreport(self, report):
            if report.outcome != "passed":
                outcomes["test_collection_failure"] = False

        def pytest_runtest_logreport(self, report):
            name = report.nodeid.rsplit("::", 1)[-1]
            if report.when == "setup" and report.outcome != "passed":
                outcomes[name] = False
            elif report.when == "call":
                outcomes[name] = (
                    outcomes.get(name, True)
                    and report.outcome == "passed"
                    and not hasattr(report, "wasxfail")
                )
            elif report.when == "teardown" and report.outcome != "passed":
                outcomes[name] = False

    exit_code = pytest.main(
        ["-q", "--tb=no", "-p", "no:cacheprovider"],
        plugins=[Collector()],
    )
    report = new_report()
    for name, passed in outcomes.items():
        classify(name, passed, report)
    report["_exit_code"] = int(getattr(exit_code, "value", exit_code) != 0)
    return report


def run_unittest():
    loader = unittest.TestLoader()
    suite = loader.discover(".", pattern="test_*.py")
    # Capture method names BEFORE running: TestSuite.run() releases tests as
    # they execute (_cleanup), so a post-run walk would see an empty suite.
    method_names = [case._testMethodName for case in _iter_cases(suite)]
    result = unittest.TextTestRunner(verbosity=0).run(suite)
    not_passed = set()
    for test, _traceback in (
            result.failures + result.errors + result.skipped + result.expectedFailures):
        not_passed.add(test._testMethodName)
    for test in result.unexpectedSuccesses:
        not_passed.add(test._testMethodName)
    report = new_report()
    for name in method_names:
        classify(name, name not in not_passed, report)
    undiscovered = _declared_test_names() - Counter(method_names)
    for name, count in undiscovered.items():
        for _index in range(count):
            classify(name, False, report)
    if not method_names:
        report["_discovered_nothing"] = True
    report["_exit_code"] = 0 if result.wasSuccessful() and not undiscovered else 1
    return report


def _declared_test_names():
    names = []
    for path in sorted(Path(".").rglob("test_*.py")):
        try:
            module = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        except (OSError, SyntaxError, UnicodeError):
            names.append("test_collection_failure")
            continue
        for node in module.body:
            if isinstance(node, (ast.AsyncFunctionDef, ast.FunctionDef)) \
                    and node.name.startswith("test_"):
                names.append(node.name)
            elif isinstance(node, ast.ClassDef):
                for child in node.body:
                    if isinstance(child, (ast.AsyncFunctionDef, ast.FunctionDef)) \
                            and child.name.startswith("test_"):
                        names.append(child.name)
    return Counter(names)


def _iter_cases(suite):
    for item in suite:
        if item is None:
            continue
        if isinstance(item, unittest.TestSuite):
            for case in _iter_cases(item):
                yield case
        else:
            yield item


def main(argv=None):
    parser = argparse.ArgumentParser(description="Python proof fixture runner")
    parser.add_argument("--runner", choices=("pytest", "unittest"), default="pytest")
    args = parser.parse_args(argv)
    if args.runner == "unittest":
        report = run_unittest()
        used = "unittest"
    else:
        report = run_pytest()
        used = "pytest"
        if report is None:
            sys.stderr.write("pytest runner requested but pytest is unavailable\n")
            sys.exit(2)
    report["_runner"] = used
    for key in ("clauseResults", "positiveCaseResults", "negativeControlResults"):
        report[key].sort(key=lambda entry: next(value for name, value in entry.items() if name != "passed"))
    with open(REPORT_PATH, "w", encoding="utf-8") as handle:
        json.dump(report, handle, sort_keys=True)
    sys.stderr.write("runner={} exit={}\n".format(used, report.get("_exit_code")))
    # Runner exit status is NOT the proof verdict; the wrapper decides.
    sys.exit(0)


if __name__ == "__main__":
    main()
