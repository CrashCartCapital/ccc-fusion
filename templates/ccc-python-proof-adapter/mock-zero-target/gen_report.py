#!/usr/bin/env python3
"""Synthetic fixture: emits a report with ZERO positive cases (mock-zero)."""
import json

report = {
    "clauseResults": [{"clauseId": "clause.parse", "passed": True}],
    "positiveCaseResults": [],
    "negativeControlResults": [{"controlId": "control.garbage", "passed": True}],
}
with open("verify-report.json", "w", encoding="utf-8") as handle:
    json.dump(report, handle, sort_keys=True)
