#!/usr/bin/env python3
"""Synthetic fixture: a negative control that did NOT fail closed.

Simulates a regression where the refusal path stopped firing: the planted
garbage input was silently accepted, so the control records passed=false.
The wrapper must refuse with negative_control_not_closed.
"""
import json

report = {
    "clauseResults": [{"clauseId": "clause.parse", "passed": True}],
    "positiveCaseResults": [{"caseId": "case.parses_plain_port", "passed": True}],
    "negativeControlResults": [{"controlId": "control.garbage", "passed": False}],
}
with open("verify-report.json", "w", encoding="utf-8") as handle:
    json.dump(report, handle, sort_keys=True)
