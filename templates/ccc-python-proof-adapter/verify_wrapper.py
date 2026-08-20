#!/usr/bin/env python3
"""ccc-python-proof-adapter: `task verify:<slug>` wrapper template for Python targets.

Runs a Python test target's explicit pytest-or-unittest report command (see
run_target.py), reads the resulting verify-report.json, and emits CANONICAL
`ccc-prd.proof-evidence.v2` JSON on stdout — the exact contract enforced by
packages/core/src/ccc-campaign/proof-attempt.ts (prepareProofEvidenceV2) and
typed in packages/core/src/ccc-campaign/types.ts (CccCampaignProofEvidenceV2).

FAIL-CLOSED CONTRACT — every refusal exits 1, prints a local diagnostic only
to stderr, and leaves stdout empty. The engine owns canonical terminal-envelope
wrapping; this target adapter never impersonates that engine contract:
  mock_zero_positive_cases    run reports ZERO positive cases: a refusal,
                              never a pass (vacuous/mock-zero proof)
  missing_clause_results      no clause-scoped results at all
  malformed_evidence_json     upstream report missing/unparseable/invalid
  negative_control_not_closed a planted negative control did not fail closed
  target_failed               a clause or positive case failed
  target_execution_failed     the report command could not run successfully
  runner_timeout              the report command exceeded its fixed deadline

Pure python3 stdlib. See README.md for clause mapping and Taskfile wiring.
"""

import argparse
import json
import os
import re
import signal
import stat
import subprocess
import sys
from pathlib import Path

SCHEMA_EVIDENCE = "ccc-prd.proof-evidence.v2"
IDENTIFIER_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$")
GIT_OBJECT_PATTERN = re.compile(r"^(?:[0-9a-f]{40}|[0-9a-f]{64})$")
MAX_PROOF_EVIDENCE_RESULTS = 4096
MAX_PROOF_EVIDENCE_BYTES = 131072
MAX_MANIFEST_BYTES = 65536
RUNNER_TIMEOUT_SECONDS = 60

REFUSAL_CODES = frozenset((
    "mock_zero_positive_cases",
    "missing_clause_results",
    "malformed_evidence_json",
    "negative_control_not_closed",
    "target_failed",
    "target_execution_failed",
    "runner_timeout",
))


class Refusal(Exception):
    """Fail-closed refusal carrying an adapter-local diagnostic code."""

    def __init__(self, code, message):
        if code not in REFUSAL_CODES:
            raise ValueError("unknown refusal code: {}".format(code))
        super(Refusal, self).__init__(message)
        self.code = code
        self.message = message


def canonical_json(value):
    """Byte-exact for this schema's ASCII-only admissible evidence strings.

    Mirrors @fusion/core canonicalCccPrdJson: sorted object keys, `,`/`:`
    separators, and no whitespace. The harness compares the emitted bytes to
    the repository serializer directly.
    """

    def serialize(item):
        if item is None:
            return "null"
        if item is True:
            return "true"
        if item is False:
            return "false"
        if isinstance(item, str):
            return json.dumps(item, ensure_ascii=True)
        if isinstance(item, int):
            return str(item)
        if isinstance(item, list):
            return "[" + ",".join(serialize(entry) for entry in item) + "]"
        if isinstance(item, dict):
            keys = sorted(item.keys(), key=lambda key: [ord(char) for char in key])
            return "{" + ",".join(
                json.dumps(key, ensure_ascii=True) + ":" + serialize(item[key])
                for key in keys
            ) + "}"
        raise ValueError("non-canonical value: {!r}".format(item))

    return serialize(value)


def require_identifier(value, label):
    if not isinstance(value, str) or not value or value != value.strip():
        raise Refusal("malformed_evidence_json", "{} must be a non-empty string".format(label))
    if not IDENTIFIER_PATTERN.match(value):
        raise Refusal(
            "malformed_evidence_json",
            "{} is not a safe identifier: {!r}".format(label, value),
        )
    return value


def require_git_object(value, label):
    if not isinstance(value, str) or not GIT_OBJECT_PATTERN.fullmatch(value):
        raise Refusal(
            "malformed_evidence_json",
            "{} must be a 40- or 64-character lowercase hex git object id".format(label),
        )
    return value


def require_result_list(value, id_key, label):
    """Validate one results array per proof-attempt.ts requireEvidenceResults:
    bounded, exact closed key set {<idKey>, passed}, unique ids, canonical order."""
    if not isinstance(value, list) or len(value) > MAX_PROOF_EVIDENCE_RESULTS:
        raise Refusal("malformed_evidence_json", "{} must be a bounded array".format(label))
    seen = set()
    results = []
    for index, entry in enumerate(value):
        if not isinstance(entry, dict) or set(entry.keys()) != {id_key, "passed"}:
            raise Refusal(
                "malformed_evidence_json",
                "{} entry {} must have exactly the keys {{{}, passed}}".format(label, index, id_key),
            )
        identifier = require_identifier(entry[id_key], "{} entry {} id".format(label, index))
        if identifier in seen:
            raise Refusal("malformed_evidence_json", "{} has duplicate id {}".format(label, identifier))
        seen.add(identifier)
        if not isinstance(entry["passed"], bool):
            raise Refusal(
                "malformed_evidence_json",
                "{} entry {} passed must be boolean".format(label, index),
            )
        results.append({id_key: identifier, "passed": entry["passed"]})
    ordered = sorted(results, key=lambda entry: entry[id_key])
    if canonical_json(results) != canonical_json(ordered):
        raise Refusal("malformed_evidence_json", "{} must be canonically ordered by id".format(label))
    return results


def require_regular_file(path, label):
    try:
        metadata = path.lstat()
    except OSError:
        raise Refusal("malformed_evidence_json", "{} is missing".format(label))
    if path.is_symlink() or not stat.S_ISREG(metadata.st_mode):
        raise Refusal("malformed_evidence_json", "{} must be a regular non-symlink file".format(label))
    return metadata


def discard_regular_file(path):
    """Best-effort cleanup without following or removing non-regular paths."""
    try:
        metadata = path.lstat()
    except (OSError, ValueError):
        return
    if path.is_symlink() or not stat.S_ISREG(metadata.st_mode):
        return
    try:
        path.unlink()
    except (OSError, ValueError):
        return


def reject_duplicate_object_pairs(pairs):
    value = {}
    for key, entry in pairs:
        if key in value:
            raise ValueError("duplicate JSON object key: {}".format(key))
        value[key] = entry
    return value


def read_bounded_json(path, label, max_bytes):
    """Read one regular file by descriptor without following a swapped symlink."""
    before = require_regular_file(path, label)
    if before.st_size > max_bytes:
        raise Refusal(
            "malformed_evidence_json",
            "{} exceeds {} bytes".format(label, max_bytes),
        )
    descriptor = None
    try:
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(str(path), flags)
        opened = os.fstat(descriptor)
        if not stat.S_ISREG(opened.st_mode) or not os.path.samestat(before, opened):
            raise Refusal(
                "malformed_evidence_json",
                "{} changed during validation".format(label),
            )
        chunks = []
        remaining = max_bytes + 1
        while remaining:
            chunk = os.read(descriptor, remaining)
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        raw = b"".join(chunks)
        if len(raw) > max_bytes:
            raise Refusal(
                "malformed_evidence_json",
                "{} exceeds {} bytes".format(label, max_bytes),
            )
        return json.loads(
            raw.decode("utf-8"),
            object_pairs_hook=reject_duplicate_object_pairs,
        )
    except Refusal:
        raise
    except (OSError, RecursionError, UnicodeError, ValueError):
        raise Refusal(
            "malformed_evidence_json",
            "{} is missing or not valid duplicate-free JSON".format(label),
        )
    finally:
        if descriptor is not None:
            os.close(descriptor)


def load_manifest(target_dir):
    manifest_path = target_dir / "verify_manifest.json"
    manifest = read_bounded_json(
        manifest_path,
        "verify_manifest.json",
        MAX_MANIFEST_BYTES,
    )
    if not isinstance(manifest, dict):
        raise Refusal("malformed_evidence_json", "verify_manifest.json must be an object")
    if set(manifest.keys()) != {"report_command", "report_file"}:
        raise Refusal(
            "malformed_evidence_json",
            "verify_manifest.json must have exactly report_command and report_file",
        )
    report_command = manifest.get("report_command")
    if not isinstance(report_command, list) or len(report_command) < 2 \
            or not all(isinstance(part, str) and part and "\0" not in part for part in report_command):
        raise Refusal(
            "malformed_evidence_json",
            "verify_manifest.json report_command must be a Python script command",
        )
    if report_command[0] not in ("python", "python3"):
        raise Refusal(
            "malformed_evidence_json",
            "verify_manifest.json report_command executable must be python or python3",
        )
    script_name = report_command[1]
    if script_name in (".", "..") or "/" in script_name or "\\" in script_name \
            or not script_name.endswith(".py"):
        raise Refusal(
            "malformed_evidence_json",
            "verify_manifest.json report command script must be a bare .py filename",
        )
    report_file = manifest.get("report_file")
    if not isinstance(report_file, str) or not report_file \
            or "\0" in report_file or report_file in (".", "..") \
            or "/" in report_file or "\\" in report_file:
        raise Refusal("malformed_evidence_json", "verify_manifest.json report_file must be a bare filename")
    return [sys.executable, script_name] + report_command[2:], report_file


def closed_runner_environment():
    environment = {
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONHASHSEED": "0",
        "PYTHONIOENCODING": "utf8",
        "PYTEST_DISABLE_PLUGIN_AUTOLOAD": "1",
    }
    if os.name == "nt":
        for key in ("SYSTEMROOT", "TEMP", "TMP", "WINDIR"):
            if key in os.environ:
                environment[key] = os.environ[key]
    return environment


def terminate_runner(process):
    try:
        if os.name == "posix":
            os.killpg(process.pid, signal.SIGKILL)
        else:
            process.kill()
    except (OSError, ProcessLookupError):
        pass
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()


def terminate_surviving_runner_descendants(process):
    if os.name != "posix":
        return
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except (OSError, ProcessLookupError):
        pass


def run_target(target_dir):
    """Run the target's report command and parse the resulting report JSON.

    The report command (normally `python3 run_target.py`) executes the suite
    under pytest by default; `--runner unittest` is an explicit alternative,
    never an ambient fallback. It writes verify-report.json with clauseResults /
    positiveCaseResults / negativeControlResults. Synthetic refusal fixtures
    write it directly.
    """
    report_command, report_file = load_manifest(target_dir)
    require_regular_file(target_dir / report_command[1], "report command script")
    report_path = target_dir / report_file
    if report_path.exists() or report_path.is_symlink():
        require_regular_file(report_path, "pre-existing runner report {}".format(report_file))
        try:
            report_path.unlink()
        except OSError:
            raise Refusal(
                "malformed_evidence_json",
                "pre-existing runner report {} could not be cleared".format(report_file),
            )
    popen_kwargs = {
        "cwd": str(target_dir),
        "env": closed_runner_environment(),
        "stdout": subprocess.DEVNULL,
        "stderr": subprocess.DEVNULL,
    }
    if os.name == "posix":
        popen_kwargs["start_new_session"] = True
    elif os.name == "nt":
        popen_kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
    try:
        process = subprocess.Popen(report_command, **popen_kwargs)
    except OSError as error:
        discard_regular_file(report_path)
        raise Refusal("target_execution_failed", "report command could not start: {}".format(error))
    try:
        return_code = process.wait(timeout=RUNNER_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired:
        terminate_runner(process)
        discard_regular_file(report_path)
        raise Refusal("runner_timeout", "report command exceeded {} seconds".format(RUNNER_TIMEOUT_SECONDS))
    terminate_surviving_runner_descendants(process)
    if return_code != 0:
        discard_regular_file(report_path)
        raise Refusal(
            "target_execution_failed",
            "report command exited nonzero ({})".format(return_code),
        )
    try:
        return read_bounded_json(
            report_path,
            "runner report {}".format(report_file),
            MAX_PROOF_EVIDENCE_BYTES,
        )
    finally:
        discard_regular_file(report_path)


def build_evidence(report, args):
    if not isinstance(report, dict):
        raise Refusal("malformed_evidence_json", "verify-report.json must be an object")
    required_keys = {"clauseResults", "positiveCaseResults", "negativeControlResults"}
    optional_keys = {"_runner", "_exit_code", "_discovered_nothing"}
    if not required_keys.issubset(report.keys()) or not set(report.keys()).issubset(required_keys | optional_keys):
        raise Refusal(
            "malformed_evidence_json",
            "verify-report.json has unknown or missing fields",
        )
    if "_runner" in report and report["_runner"] not in ("pytest", "unittest"):
        raise Refusal("malformed_evidence_json", "runner metadata is invalid")
    if "_exit_code" in report and (
            not isinstance(report["_exit_code"], int)
            or isinstance(report["_exit_code"], bool)
            or report["_exit_code"] < 0):
        raise Refusal("malformed_evidence_json", "runner exit metadata is invalid")
    if "_discovered_nothing" in report and not isinstance(report["_discovered_nothing"], bool):
        raise Refusal("malformed_evidence_json", "runner discovery metadata is invalid")
    clause_results = require_result_list(report.get("clauseResults"), "clauseId", "clause results")
    positive_results = require_result_list(
        report.get("positiveCaseResults"), "caseId", "positive case results",
    )
    negative_results = require_result_list(
        report.get("negativeControlResults"), "controlId", "negative control results",
    )

    if len(clause_results) == 0:
        raise Refusal(
            "missing_clause_results",
            "evidence must carry at least one clause result; a clause-less run proves nothing",
        )
    if len(positive_results) == 0:
        raise Refusal(
            "mock_zero_positive_cases",
            "zero positive cases reported - this is a refusal (mock-zero), never a pass",
        )
    if report.get("_discovered_nothing"):
        raise Refusal(
            "malformed_evidence_json",
            "runner discovered zero tests; an empty suite is not evidence",
        )
    failing_negative = [entry["controlId"] for entry in negative_results if not entry["passed"]]
    if failing_negative:
        raise Refusal(
            "negative_control_not_closed",
            "negative control(s) did not fail closed: {}".format(",".join(failing_negative)),
        )
    failing_clauses = [entry["clauseId"] for entry in clause_results if not entry["passed"]]
    failing_cases = [entry["caseId"] for entry in positive_results if not entry["passed"]]
    if failing_clauses or failing_cases:
        raise Refusal(
            "target_failed",
            "failing clauses [{}] / cases [{}]".format(
                ",".join(failing_clauses), ",".join(failing_cases),
            ),
        )
    if report.get("_exit_code", 0) != 0:
        raise Refusal(
            "target_failed",
            "target test runner exited nonzero without a classified failing result",
        )

    return {
        "schema": SCHEMA_EVIDENCE,
        "proofId": require_identifier(args.proof_id, "proof id"),
        "phase": "task",
        "sourceCommit": require_git_object(args.source_commit, "source commit"),
        "sourceTree": require_git_object(args.source_tree, "source tree"),
        "passed": True,
        "clauseResults": clause_results,
        "positiveCaseResults": positive_results,
        "negativeControlResults": negative_results,
    }


def emit_evidence(evidence):
    canonical = canonical_json(evidence)
    if len(canonical.encode("utf-8")) > MAX_PROOF_EVIDENCE_BYTES:
        raise Refusal("malformed_evidence_json", "evidence exceeds 131072 canonical bytes")
    sys.stdout.write(canonical + "\n")
    sys.exit(0)


def emit_refusal(refusal):
    sys.stderr.write("REFUSED {}: {}\n".format(refusal.code, refusal.message))
    sys.exit(1)


def main(argv=None):
    parser = argparse.ArgumentParser(description="ccc-python-proof-adapter verify wrapper")
    parser.add_argument("--proof-id", required=True)
    parser.add_argument("--source-commit", required=True)
    parser.add_argument("--source-tree", required=True)
    parser.add_argument("--target", required=True, help="directory containing verify_manifest.json")
    args = parser.parse_args(argv)

    try:
        require_identifier(args.proof_id, "proof id")
        require_git_object(args.source_commit, "source commit")
        require_git_object(args.source_tree, "source tree")
        raw_target = Path(args.target)
        if raw_target.is_symlink():
            raise Refusal("malformed_evidence_json", "target must not be a symlink")
        try:
            target = raw_target.resolve(strict=True)
        except OSError:
            raise Refusal("malformed_evidence_json", "target directory is missing")
        if not target.is_dir():
            raise Refusal("malformed_evidence_json", "target must be a directory")
        report = run_target(target)
        evidence = build_evidence(report, args)
        emit_evidence(evidence)
    except Refusal as refusal:
        emit_refusal(refusal)


if __name__ == "__main__":
    main()
