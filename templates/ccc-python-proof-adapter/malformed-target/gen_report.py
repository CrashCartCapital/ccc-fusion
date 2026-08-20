#!/usr/bin/env python3
"""Synthetic fixture: emits NOT-JSON garbage as its report."""
with open("verify-report.json", "w", encoding="utf-8") as handle:
    handle.write("{{{{not json at all ////\n")
