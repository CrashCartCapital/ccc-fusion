#!/usr/bin/env python3
"""Synthetic fixture: emits a report with NO clause results."""
import json

report = {
    "clauseResults": [],
    "positiveCaseResults": [{"caseId": "case.parses_plain_port", "passed": True}],
    "negativeControlResults": [{"controlId": "control.garbage", "passed": True}],
}
with open("verify-report.json", "w", encoding="utf-8") as handle:
    json.dump(report, handle, sort_keys=True)
